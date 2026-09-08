/**
 * SQLite in the browser, and the grading convention that goes with it.
 *
 * A SQL exercise cannot be graded with assertions on a function: the unit of work is a statement
 * and the unit of truth is a result set. So the model supplies `seed` (the schema and rows, created
 * before anything runs) and `tests` (a *reference answer*, written as SQL). Grading runs the
 * learner's SQL and the reference against separate, freshly seeded databases and compares:
 *
 *   - if the reference returns rows, the two result sets must match;
 *   - if it does not (an UPDATE, DELETE or INSERT exercise), the resulting table contents must.
 *
 * Asking the model for a reference query rather than literal expected rows matters: writing SQL is
 * something it is reliably good at, while hand-computing the rows a query should produce is exactly
 * where model-authored tests go wrong and mark a correct learner wrong.
 *
 * Row order is only enforced when it was asked for — see `wantsOrder`.
 */
import type { ExecResult, Failure, ResultTable, SchemaTable, WorkerRequest } from "./protocol.js";

const MAX_ROWS = 200;
const MAX_CELL = 300;

interface Database {
  exec: (options: string | { sql: string; rowMode?: string; resultRows?: unknown[]; columnNames?: string[]; callback?: (row: never) => void }) => void;
  close: () => void;
}

interface Sqlite3 {
  version: { libVersion: string };
  oo1: { DB: new (filename: string) => Database };
}

type LoadModule = (url: string) => Promise<{ default: (config: Record<string, unknown>) => Promise<Sqlite3> }>;

/** One execution's outcome: the first result set produced, plus the database it left behind. */
interface Outcome {
  table: ResultTable;
  /** Table contents after the script ran, keyed by table name — how DML exercises are compared. */
  state: Map<string, ResultTable>;
  error: string | null;
}

export function createSqlRunner(loadModule: LoadModule, onStatus: (text: string) => void) {
  let ready: Promise<Sqlite3> | null = null;

  async function sqlite(url: string): Promise<Sqlite3> {
    if (!ready) {
      ready = (async () => {
        onStatus("Loading SQLite (about 1.5 MB, once per session)…");
        const module = await loadModule(url);
        const instance = await module.default({ print: () => {}, printErr: () => {} });
        onStatus("");
        return instance;
      })().catch((error: unknown) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  return async function run(request: WorkerRequest): Promise<ExecResult> {
    const instance = await sqlite(request.engines.sqlite);
    const blank = { stdout: "", stderr: "", durationMs: 0 };

    if (request.mode === "schema") {
      return { ...blank, passed: null, failure: null, schema: describe(instance, request.seed) };
    }

    const attempt = execute(instance, request.seed, request.code);
    if (attempt.error) {
      return {
        ...blank,
        passed: request.mode === "submit" ? false : null,
        failure: sqlFailure(attempt.error, request.code),
        table: null,
      };
    }

    if (request.mode === "run") {
      return { ...blank, passed: null, failure: null, table: attempt.table };
    }

    const reference = execute(instance, request.seed, request.tests);
    if (reference.error) {
      // The exercise itself is broken. Say so plainly rather than blaming the learner.
      return {
        ...blank,
        passed: false,
        table: attempt.table,
        failure: {
          kind: "error",
          where: "tests",
          message: `The exercise's own reference answer failed to run: ${clean(reference.error)}`,
          line: null,
          source: null,
          testLine: null,
          testSource: null,
          traceback: reference.error,
        },
      };
    }

    const ordered = wantsOrder(request.tests);
    const mismatch = reference.table.columns.length
      ? compareTables(attempt.table, reference.table, ordered)
      : compareState(attempt.state, reference.state);

    if (!mismatch) return { ...blank, passed: true, failure: null, table: attempt.table };

    return {
      ...blank,
      passed: false,
      table: attempt.table,
      failure: {
        kind: "mismatch",
        where: "code",
        message: mismatch,
        line: null,
        source: null,
        testLine: null,
        testSource: null,
        traceback: "",
        expected: reference.table.columns.length ? reference.table : null,
      },
    };
  };
}

// --- execution ------------------------------------------------------------------------------

/** Every execution gets its own database, so nothing a learner does can leak into the next run. */
function execute(sqlite3: Sqlite3, seed: string, sql: string): Outcome {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    if (seed.trim()) db.exec(seed);
    const rows: unknown[][] = [];
    const columns: string[] = [];
    // For a multi-statement script this captures the first statement that returns rows, which is
    // the one an exercise cares about (a `SELECT` verifying an `UPDATE` right above it included).
    db.exec({ sql, rowMode: "array", resultRows: rows, columnNames: columns });
    return { table: toTable(columns, rows), state: snapshot(db), error: null };
  } catch (error) {
    return {
      table: emptyTable(),
      state: new Map(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

function tableNames(db: Database): string[] {
  const names: string[] = [];
  db.exec({
    sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    rowMode: "array",
    callback: ((row: unknown[]) => void names.push(String(row[0]))) as never,
  });
  return names;
}

/** Contents of every user table, for comparing exercises that change data instead of reading it. */
function snapshot(db: Database): Map<string, ResultTable> {
  const state = new Map<string, ResultTable>();
  for (const name of tableNames(db)) {
    const rows: unknown[][] = [];
    const columns: string[] = [];
    db.exec({
      sql: `SELECT * FROM "${name.replace(/"/g, '""')}"`,
      rowMode: "array",
      resultRows: rows,
      columnNames: columns,
    });
    state.set(name, toTable(columns, rows));
  }
  return state;
}

function describe(sqlite3: Sqlite3, seed: string): SchemaTable[] {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    if (!seed.trim()) return [];
    db.exec(seed);
    return tableNames(db).map((name) => {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const columns: string[] = [];
      db.exec({
        sql: `PRAGMA table_info(${quoted})`,
        rowMode: "array",
        // cid, name, type, …
        callback: ((row: unknown[]) => void columns.push(`${String(row[1])} ${String(row[2])}`.trim())) as never,
      });
      const counted: unknown[][] = [];
      db.exec({ sql: `SELECT COUNT(*) FROM ${quoted}`, rowMode: "array", resultRows: counted });
      return { name, columns, rowCount: Number(counted[0]?.[0] ?? 0) };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// --- comparison -----------------------------------------------------------------------------

/**
 * Row order is part of the answer only when the reference asked for it. A model can force either
 * with a `-- ordered` or `-- unordered` line at the top of the tests.
 */
export function wantsOrder(reference: string): boolean {
  if (/^\s*--\s*unordered\b/im.test(reference)) return false;
  if (/^\s*--\s*ordered\b/im.test(reference)) return true;
  return /\border\s+by\b/i.test(reference);
}

function compareTables(actual: ResultTable, expected: ResultTable, ordered: boolean): string | null {
  if (actual.columns.length !== expected.columns.length) {
    return `expected ${expected.columns.length} column(s) (${expected.columns.join(", ")}), got ${
      actual.columns.length
    } (${actual.columns.join(", ") || "none"})`;
  }
  if (actual.rows.length !== expected.rows.length) {
    return `expected ${expected.rows.length} row(s), got ${actual.rows.length}`;
  }

  const key = (rows: unknown[][]) => {
    const text = rows.map((row) => JSON.stringify(row));
    return ordered ? text : [...text].sort();
  };
  const want = key(expected.rows);
  const got = key(actual.rows);
  const index = got.findIndex((row, i) => row !== want[i]);
  if (index === -1) return null;

  return ordered
    ? `row ${index + 1} differs: expected ${want[index]}, got ${got[index]}`
    : `rows differ: expected ${want[index]} somewhere in the result, got ${got[index]}`;
}

function compareState(actual: Map<string, ResultTable>, expected: Map<string, ResultTable>): string | null {
  for (const [name, want] of expected) {
    const got = actual.get(name);
    if (!got) return `table "${name}" is missing`;
    const difference = compareTables(got, want, false);
    if (difference) return `table "${name}" is wrong: ${difference}`;
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) return `table "${name}" should not exist`;
  }
  return null;
}

// --- shaping --------------------------------------------------------------------------------

function emptyTable(): ResultTable {
  return { columns: [], rows: [], truncated: false };
}

function toTable(columns: string[], rows: unknown[][]): ResultTable {
  return {
    columns: [...columns],
    rows: rows.slice(0, MAX_ROWS).map((row) => row.map(cell)),
    truncated: rows.length > MAX_ROWS,
  };
}

function cell(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "string" && value.length > MAX_CELL) return `${value.slice(0, MAX_CELL)}…`;
  return value;
}

/** SQLite prefixes its messages with result-code noise no learner needs to read. */
function clean(message: string): string {
  return message.replace(/^SQLITE_[A-Z]+:\s*sqlite3 result code \d+:\s*/i, "").trim();
}

function sqlFailure(rawMessage: string, sql: string): Failure {
  const message = clean(rawMessage);
  const syntax = /syntax error|incomplete input|unrecognized token/i.test(message);
  // SQLite reports no line numbers, but it usually names the token it choked on.
  const near = message.match(/near "([^"]+)"/) ?? message.match(/unrecognized token: "([^"]+)"/);
  const lines = sql.split("\n");
  const index = near ? lines.findIndex((line) => line.includes(near[1])) : -1;

  return {
    kind: syntax ? "syntax" : "error",
    where: "code",
    message,
    line: index === -1 ? null : index + 1,
    source: index === -1 ? null : lines[index].trim(),
    testLine: null,
    testSource: null,
    traceback: message,
  };
}
