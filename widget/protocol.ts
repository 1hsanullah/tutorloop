/** Message types shared between the widget's main thread and the execution worker. */

export type Language = "python" | "javascript" | "typescript" | "sql";
export type Mode = "run" | "submit" | "schema";

/** Where a failure came from, and how to describe it to the learner. */
export type FailureKind = "assertion" | "error" | "syntax" | "timeout" | "mismatch";

/** A result set, for the languages whose answer is a table rather than a return value. */
export interface ResultTable {
  columns: string[];
  rows: unknown[][];
  /** True when rows were dropped to keep the payload sane. */
  truncated: boolean;
}

/** One seeded table, for the schema panel — a learner cannot query what they cannot see. */
export interface SchemaTable {
  name: string;
  columns: string[];
  rowCount: number;
}

export interface Failure {
  kind: FailureKind;
  /** Which source the deepest useful frame is in. */
  where: "code" | "tests";
  /** e.g. "TypeError: unsupported operand type(s) for +: 'int' and 'str'" */
  message: string;
  /** 1-based line in `where`'s source, when known. */
  line: number | null;
  /** The text of that line, trimmed. */
  source: string | null;
  /** The failing assertion's line in the test suite, when the failure surfaced through a test. */
  testLine: number | null;
  testSource: string | null;
  /** Full traceback, already stripped of harness frames. */
  traceback: string;
  /** What the reference answer produced, when a graded comparison came out unequal. */
  expected?: ResultTable | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** null for a plain Run (no grading happened). */
  passed: boolean | null;
  failure: Failure | null;
  durationMs: number;
  /** What the learner's query returned, for SQL. */
  table?: ResultTable | null;
  /** Filled by a "schema" request. */
  schema?: SchemaTable[] | null;
}

/** Where each runtime is fetched from. Overridden in tests to keep them offline. */
export interface EngineUrls {
  /** Directory URL; the loader appends `pyodide.mjs`. */
  pyodide: string;
  /** Module URL of the SQLite build; its wasm is fetched alongside it. */
  sqlite: string;
  /** Module URL of the TypeScript type stripper. */
  tsStripper: string;
}

export type WorkerRequest = {
  type: "exec";
  id: number;
  mode: Mode;
  language: Language;
  code: string;
  tests: string;
  /** SQL only: schema and rows to create before anything else runs. */
  seed: string;
  timeoutMs: number;
  engines: EngineUrls;
};

export type WorkerResponse =
  | { type: "status"; text: string }
  | { type: "result"; id: number; result: ExecResult }
  | { type: "fatal"; id: number; message: string };

export const TIMEOUT_MS = 10_000;

const PYODIDE_VERSION = "v314.0.6";
const SQLITE_VERSION = "3.53.4-build1";
const TS_BLANK_SPACE_VERSION = "0.9.0";

/**
 * Every runtime is fetched at use time from the one CDN the server declares in its CSP metadata.
 * Nothing here is bundled: Pyodide is ~10 MB, SQLite ~1.5 MB, and the TypeScript parser the type
 * stripper needs is ~1 MB compressed — and a learner doing a Python exercise should not pay for SQL.
 */
export const ENGINE_URLS: EngineUrls = {
  pyodide: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`,
  sqlite: `https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@${SQLITE_VERSION}/dist/index.mjs`,
  tsStripper: `https://cdn.jsdelivr.net/npm/ts-blank-space@${TS_BLANK_SPACE_VERSION}/+esm`,
};

/** Languages whose answer is a result set rather than a value returned from a function. */
export function isTabular(language: Language): boolean {
  return language === "sql";
}
