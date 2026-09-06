/** Unit tests for the widget's pure modules. See load.mjs for how TypeScript gets imported. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { load } from "./load.mjs";

const { renderMarkdown, escapeHtml } = await load("widget/markdown.ts");
const { exerciseFrom } = await load("widget/exercise-data.ts");

test("markdown escapes HTML in lesson content", () => {
  const html = renderMarkdown("A <script>alert(1)</script> tag");
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("markdown renders fenced code without re-parsing its contents", () => {
  const html = renderMarkdown("```python\nx = **not bold**\n```");
  assert.ok(html.includes('<pre><code class="lang-python">'));
  assert.ok(html.includes("**not bold**"));
  assert.ok(!html.includes("<strong>"));
});

test("markdown handles headings, lists and inline spans", () => {
  const html = renderMarkdown("## Heading\n\n- one `code`\n- two **bold**\n\n1. first\n2. second");
  assert.ok(html.includes("<h3>Heading</h3>"));
  assert.ok(html.includes("<li>one <code>code</code></li>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<ol><li>first</li><li>second</li></ol>"));
});

test("markdown does not confuse plain numbers with code-span placeholders", () => {
  const html = renderMarkdown("You have 3 apples and `4` pears");
  assert.ok(html.includes("You have 3 apples"));
  assert.ok(html.includes("<code>4</code>"));
});

test("markdown only links http(s) targets", () => {
  const html = renderMarkdown("[safe](https://example.com) and [bad](javascript:alert(1))");
  assert.ok(html.includes('<a href="https://example.com"'));
  // The bad one stays inert text rather than becoming a link.
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes("[bad](javascript:alert(1))"));
});

test("escapeHtml covers quotes as well as angle brackets", () => {
  assert.equal(escapeHtml(`<a href="x">'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;");
});

test("exerciseFrom accepts the tool's snake_case payload", () => {
  const exercise = exerciseFrom({
    language: "javascript",
    title: "reduce",
    lesson_md: "lesson",
    task_md: "task",
    starter_code: "function f() {}",
    tests: "assert(true);",
    hints: ["a", "b"],
    solution: "answer",
  });
  assert.equal(exercise?.language, "javascript");
  assert.equal(exercise?.lessonMd, "lesson");
  assert.equal(exercise?.starterCode, "function f() {}");
  assert.deepEqual(exercise?.hints, ["a", "b"]);
});

test("exerciseFrom rejects payloads that are not exercises", () => {
  assert.equal(exerciseFrom(null), null);
  assert.equal(exerciseFrom({ title: "no tests" }), null);
  assert.equal(exerciseFrom("a string"), null);
});

test("exerciseFrom defaults an unknown language to python", () => {
  const exercise = exerciseFrom({ title: "t", tests: "assert True", lesson_md: "l", language: "ruby" });
  assert.equal(exercise?.language, "python");
});

// --- the JavaScript grader (the Python one needs a browser; see README) ------------------------

const { createRunner } = await load("widget/runner.ts");
const run = createRunner(() => {});
const exec = (mode, code, tests) =>
  run({
    type: "exec",
    id: 1,
    mode,
    language: "javascript",
    code,
    tests,
    seed: "",
    timeoutMs: 5000,
    engines: { pyodide: "", sqlite: "", tsStripper: "" },
  });

const DOUBLE = "function double(n) {\n  return n * 2;\n}\n";
const DOUBLE_TESTS = "assertEquals(double(2), 4);\nassertEquals(double(-1), -2);\nassert(double(0) === 0);\n";

test("submit passes when every assertion holds", async () => {
  const result = await exec("submit", DOUBLE, DOUBLE_TESTS);
  assert.equal(result.passed, true);
  assert.equal(result.failure, null);
});

test("submit reports the first failing assertion and its line in the test suite", async () => {
  const result = await exec("submit", "function double(n) {\n  return n + 2;\n}\n", DOUBLE_TESTS);
  assert.equal(result.passed, false);
  assert.equal(result.failure.kind, "assertion");
  assert.equal(result.failure.where, "tests");
  assert.equal(result.failure.message, "expected -2 but got 1");
  assert.equal(result.failure.testLine, 2, "the second assertion is the first one that fails");
  assert.equal(result.failure.testSource, "assertEquals(double(-1), -2);");
});

test("an error inside the learner's code is attributed to their line, not the tests", async () => {
  const result = await exec("submit", "function double(n) {\n  return n.missing.x;\n}\n", DOUBLE_TESTS);
  assert.equal(result.passed, false);
  assert.equal(result.failure.kind, "error");
  assert.equal(result.failure.where, "code");
  assert.equal(result.failure.line, 2);
  assert.match(result.failure.message, /TypeError/);
});

test("run executes the learner's code alone and grades nothing", async () => {
  const result = await exec("run", "console.log('hi', 41 + 1);\n", "assert(false);");
  assert.equal(result.passed, null, "a plain run has no verdict");
  assert.equal(result.stdout, "hi 42");
  assert.equal(result.failure, null);
});

test("console.error goes to stderr, not stdout", async () => {
  const result = await exec("run", "console.log('out');\nconsole.error('bad');\n", "assert(true);");
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "bad");
});

test("a syntax error is reported as one rather than crashing the runner", async () => {
  const result = await exec("submit", "function double(n) {\n  return n *;\n}\n", DOUBLE_TESTS);
  assert.equal(result.passed, false);
  assert.equal(result.failure.kind, "syntax");
  assert.match(result.failure.message, /SyntaxError/);
});

test("assertDeepEquals compares structures, and reports both sides", async () => {
  const pass = await exec("submit", "function pair() {\n  return { a: [1, 2] };\n}\n", "assertDeepEquals(pair(), { a: [1, 2] });");
  assert.equal(pass.passed, true);
  const fail = await exec("submit", "function pair() {\n  return { a: [1, 3] };\n}\n", "assertDeepEquals(pair(), { a: [1, 2] });");
  assert.equal(fail.passed, false);
  assert.equal(fail.failure.message, 'expected {"a":[1,2]} but got {"a":[1,3]}');
});
