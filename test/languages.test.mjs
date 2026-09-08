/**
 * The SQL and TypeScript graders, exercised through the same `createRunner` the widget uses.
 *
 * Both engines are ES modules loaded from a URL, so pointing that URL at the local install keeps
 * these tests offline: SQLite resolves its own wasm next to the module, and the type stripper
 * resolves `typescript` from node_modules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { load, local } from "./load.mjs";

const ENGINES = {
  pyodide: "",
  sqlite: local("node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs"),
  tsStripper: local("node_modules/ts-blank-space/out/index.js"),
};

const { createRunner } = await load("widget/runner.ts");
const run = createRunner(() => {});

const exec = (language, mode, code, tests, seed = "") =>
  run({ type: "exec", id: 1, mode, language, code, tests, seed, timeoutMs: 10_000, engines: ENGINES });

// --- SQL ---------------------------------------------------------------------------------------

const SEED = `
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, total REAL);
INSERT INTO orders (customer, total) VALUES
  ('ada', 120.5), ('ada', 80.0), ('grace', 42.25), ('alan', 15.0), ('alan', 300.75);
`;
const REFERENCE =
  "SELECT customer, ROUND(SUM(total), 2) AS spend FROM orders GROUP BY customer HAVING spend > 100 ORDER BY spend DESC";

const sql = (mode, code, tests = REFERENCE) => exec("sql", mode, code, tests, SEED);

test("sql: the schema request describes the seeded tables", async () => {
  const result = await sql("schema", "", REFERENCE);
  assert.deepEqual(result.schema, [
    { name: "orders", columns: ["id INTEGER", "customer TEXT", "total REAL"], rowCount: 5 },
  ]);
});

test("sql: a query matching the reference passes", async () => {
  const result = await sql("submit", REFERENCE);
  assert.equal(result.passed, true);
  assert.equal(result.failure, null);
  assert.deepEqual(result.table.columns, ["customer", "spend"]);
  assert.deepEqual(result.table.rows, [
    ["alan", 315.75],
    ["ada", 200.5],
  ]);
});

test("sql: a differently-written but equivalent query still passes", async () => {
  const result = await sql(
    "submit",
    `SELECT customer, ROUND(SUM(total), 2) AS spend
     FROM orders
     GROUP BY customer
     HAVING SUM(total) > 100
     ORDER BY SUM(total) DESC`,
  );
  assert.equal(result.passed, true, "grading compares results, not query text");
});

test("sql: a missing filter is reported as a row-count difference", async () => {
  const result = await sql(
    "submit",
    "SELECT customer, ROUND(SUM(total), 2) AS spend FROM orders GROUP BY customer ORDER BY spend DESC",
  );
  assert.equal(result.passed, false);
  assert.equal(result.failure.kind, "mismatch");
  assert.equal(result.failure.message, "expected 2 row(s), got 3");
  // The learner sees their own rows and the expected ones side by side.
  assert.equal(result.table.rows.length, 3);
  assert.deepEqual(result.failure.expected.rows, [
    ["alan", 315.75],
    ["ada", 200.5],
  ]);
});

test("sql: swapped columns are caught even though the values are right", async () => {
  const result = await sql(
    "submit",
    "SELECT ROUND(SUM(total), 2) AS spend, customer FROM orders GROUP BY customer HAVING spend > 100 ORDER BY spend DESC",
  );
  assert.equal(result.passed, false);
  assert.match(result.failure.message, /row 1 differs/);
});

test("sql: row order is enforced only when the reference asks for it", async () => {
  const shuffled = "SELECT customer, ROUND(SUM(total), 2) AS spend FROM orders GROUP BY customer HAVING spend > 100 ORDER BY spend ASC";
  assert.equal((await sql("submit", shuffled)).passed, false, "reference has ORDER BY, so order counts");

  const unordered = `-- unordered\n${REFERENCE}`;
  assert.equal((await sql("submit", shuffled, unordered)).passed, true, "`-- unordered` overrides it");
});

test("sql: a syntax error names the token and its line", async () => {
  const result = await sql("submit", "SELECT customer,\nSUM(total FROM orders");
  assert.equal(result.passed, false);
  assert.equal(result.failure.kind, "syntax");
  assert.match(result.failure.message, /near "FROM"/);
  assert.equal(result.failure.line, 2);
  assert.equal(result.failure.source, "SUM(total FROM orders");
  assert.ok(!result.failure.message.includes("result code"), "SQLite's result-code noise is stripped");
});

test("sql: an unknown column is an error, not a mismatch", async () => {
  const result = await sql("submit", "SELECT nope FROM orders");
  assert.equal(result.failure.kind, "error");
  assert.equal(result.failure.message, "no such column: nope");
});

test("sql: run shows the result set without grading it", async () => {
  const result = await sql("run", "SELECT customer FROM orders LIMIT 2");
  assert.equal(result.passed, null);
  assert.equal(result.failure, null);
  assert.deepEqual(result.table.rows, [["ada"], ["ada"]]);
});

test("sql: a data-changing exercise is graded on the resulting table", async () => {
  const reference = "UPDATE orders SET total = total * 2 WHERE customer = 'alan'";
  const right = await exec("sql", "submit", "UPDATE orders SET total = total * 2 WHERE customer = 'alan'", reference, SEED);
  assert.equal(right.passed, true);

  const wrong = await exec("sql", "submit", "UPDATE orders SET total = total * 2", reference, SEED);
  assert.equal(wrong.passed, false);
  assert.match(wrong.failure.message, /table "orders" is wrong/);
});

test("sql: each execution gets a fresh database", async () => {
  const destructive = "DELETE FROM orders";
  await exec("sql", "run", destructive, REFERENCE, SEED);
  const after = await sql("submit", REFERENCE);
  assert.equal(after.passed, true, "the previous run's DELETE must not leak into this one");
});

test("sql: a broken reference answer blames the exercise, not the learner", async () => {
  const result = await sql("submit", REFERENCE, "SELECT * FROM nonexistent");
  assert.equal(result.passed, false);
  assert.equal(result.failure.where, "tests");
  assert.match(result.failure.message, /exercise's own reference answer failed/);
});

// --- TypeScript --------------------------------------------------------------------------------

const TS_TESTS = "assertEquals(double(2), 4);\nassertEquals(double(-1), -2);\n";

test("typescript: types are erased and the code graded as JavaScript", async () => {
  const result = await exec(
    "typescript",
    "submit",
    "function double(n: number): number {\n  return n * 2;\n}\n",
    TS_TESTS,
  );
  assert.equal(result.passed, true);
});

test("typescript: typed tests work too", async () => {
  const result = await exec(
    "typescript",
    "submit",
    "export function double(n: number): number {\n  return n * 2;\n}\n",
    "const expected: number = 4;\nassertEquals(double(2), expected);\n",
  );
  assert.equal(result.passed, true);
});

test("typescript: an error points at the learner's real line", async () => {
  // Line 3 of the TypeScript source, which only lines up because types are blanked, not deleted.
  const result = await exec(
    "typescript",
    "submit",
    "interface Box { value: number }\n\nfunction double(n: number): number {\n  return (null as unknown as Box).value * n;\n}\n",
    TS_TESTS,
  );
  assert.equal(result.passed, false);
  assert.equal(result.failure.where, "code");
  assert.equal(result.failure.line, 4);
  assert.match(result.failure.message, /TypeError/);
});

test("typescript: non-erasable syntax is explained rather than thrown", async () => {
  const result = await exec(
    "typescript",
    "submit",
    "enum Colour {\n  Red,\n}\nfunction double(n: number): number {\n  return n * 2;\n}\n",
    TS_TESTS,
  );
  assert.equal(result.passed, false);
  assert.equal(result.failure.kind, "syntax");
  assert.equal(result.failure.line, 1);
  assert.match(result.failure.message, /no JavaScript equivalent to erase/);
});

test("typescript: a failing assertion still maps to the test line", async () => {
  const result = await exec(
    "typescript",
    "submit",
    "function double(n: number): number {\n  return n + 2;\n}\n",
    TS_TESTS,
  );
  assert.equal(result.failure.kind, "assertion");
  assert.equal(result.failure.testLine, 2);
  assert.equal(result.failure.message, "expected -2 but got 1");
});

test("typescript: an `export` a model wrote out of habit does not break the exercise", async () => {
  const result = await exec(
    "typescript",
    "submit",
    "export interface Box { value: number }\n\nexport function double(n: number): number {\n  return (n as never as Box).value.toFixed;\n}\n",
    TS_TESTS,
  );
  // The export is blanked, not deleted, so the error still lands on the learner's line 4 — and the
  // line quoted back is their own TypeScript, not the blanked version they never wrote.
  assert.equal(result.failure.line, 4);
  assert.equal(result.failure.source, "return (n as never as Box).value.toFixed;");
});

test("javascript: module syntax is blanked without shifting lines", async () => {
  const { blankModuleSyntax } = await load("widget/runner.ts");
  const source = "export const a = 1;\nexport default function f() {}\nexport { a };\nconst b = 2;";
  const blanked = blankModuleSyntax(source);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
  assert.deepEqual(
    blanked.split("\n").map((line) => line.trimEnd()),
    ["       const a = 1;", "               function f() {}", "", "const b = 2;"],
  );
});
