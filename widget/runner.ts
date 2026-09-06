/**
 * The execution engine. Runs the learner's code, and on Submit their code plus the hidden tests,
 * and turns whatever went wrong into a first-failure report.
 *
 * Lives in a worker in the normal case; the same module runs on the main thread when the host's
 * CSP refuses blob: workers (see runner-client.ts).
 */
import { PYTHON_DRIVER } from "./python-driver.js";
import { createSqlRunner } from "./sql-engine.js";
import { createTypeStripper } from "./typescript.js";
import type { ExecResult, Failure, Mode, WorkerRequest } from "./protocol.js";

const MAX_STREAM = 20_000;
const SOURCE_URL = "mcp-lesson-exercise.js";

type PyRunner = (code: string, tests: string, mode: Mode, timeout: number) => string;

interface PyodideModule {
  loadPyodide: (options: { indexURL: string }) => Promise<{ runPython: (source: string) => unknown }>;
}

/**
 * Every runtime is imported as an ES module from a URL assembled here, at run time. That is
 * deliberate on two counts: Pyodide 314 refuses to run in a classic worker, and a computed
 * specifier is left alone by the bundler, so these stay CDN fetches from the origin the server
 * declares in its CSP metadata instead of being inlined into the widget.
 */
async function importModule<T>(url: string): Promise<T> {
  return (await import(/* @vite-ignore */ url)) as T;
}

export function createRunner(onStatus: (text: string) => void) {
  let pyodideReady: Promise<PyRunner> | null = null;
  const runSql = createSqlRunner((url) => importModule(url), onStatus);
  const stripTypes = createTypeStripper((url) => importModule(url), onStatus);

  async function pythonRunner(indexUrl: string): Promise<PyRunner> {
    if (!pyodideReady) {
      pyodideReady = (async () => {
        onStatus("Downloading Python (about 10 MB, once per session)…");
        const { loadPyodide } = await importModule<PyodideModule>(`${indexUrl}pyodide.mjs`);
        onStatus("Starting Python…");
        const pyodide = await loadPyodide({ indexURL: indexUrl });
        const runner = pyodide.runPython(PYTHON_DRIVER) as PyRunner;
        onStatus("");
        return runner;
      })().catch((error: unknown) => {
        pyodideReady = null;
        throw error;
      });
    }
    return pyodideReady;
  }

  /**
   * Types are erased from the learner's code and the tests separately. `ts-blank-space` blanks
   * rather than deletes, so both keep their original line count and the JavaScript grader's line
   * arithmetic still lands on the right line of the learner's TypeScript.
   */
  async function toJavaScript(request: WorkerRequest): Promise<WorkerRequest | ExecResult> {
    const url = request.engines.tsStripper;
    const [code, tests] = await Promise.all([
      stripTypes(request.code, url),
      stripTypes(request.tests, url),
    ]);
    const broken = code.error ? { ...code.error, where: "code" as const } : null;
    const brokenTests = tests.error ? { ...tests.error, where: "tests" as const } : null;
    const problem = broken ?? brokenTests;

    if (problem) {
      const source = problem.where === "code" ? request.code : request.tests;
      return {
        stdout: "",
        stderr: "",
        passed: request.mode === "submit" ? false : null,
        durationMs: 0,
        failure: {
          kind: "syntax",
          where: problem.where,
          message: problem.message,
          line: problem.line,
          source: source.split("\n")[problem.line - 1]?.trim() ?? null,
          testLine: problem.where === "tests" ? problem.line : null,
          testSource: problem.where === "tests" ? source.split("\n")[problem.line - 1]?.trim() ?? null : null,
          traceback: "",
        },
      };
    }

    return { ...request, code: code.code, tests: tests.code };
  }

  return async function execute(request: WorkerRequest): Promise<ExecResult> {
    const started = Date.now();
    const stamp = (result: ExecResult): ExecResult => ({ ...result, durationMs: Date.now() - started });

    if (request.language === "sql") return stamp(await runSql(request));
    if (request.language === "python") return stamp(runPython(await pythonRunner(request.engines.pyodide), request));

    if (request.language === "typescript") {
      const stripped = await toJavaScript(request);
      if (!("type" in stripped)) return stamp(stripped); // erasure failed; that is the verdict
      // Line numbers survive erasure, but the text on those lines is full of blanks, so quote the
      // learner's own TypeScript back at them rather than the stripped version they never wrote.
      return stamp(quoteOriginal(runJavaScript(stripped), request));
    }

    return stamp(runJavaScript(request));
  };
}

/** Re-reads the quoted lines out of the untransformed sources, by the line numbers already found. */
function quoteOriginal(result: ExecResult, original: WorkerRequest): ExecResult {
  const failure = result.failure;
  if (!failure) return result;
  return {
    ...result,
    failure: {
      ...failure,
      source:
        failure.line === null
          ? failure.source
          : lineOf(failure.where === "tests" ? original.tests : original.code, failure.line),
      testSource: failure.testLine === null ? failure.testSource : lineOf(original.tests, failure.testLine),
    },
  };
}

function runPython(run: PyRunner, request: WorkerRequest): ExecResult {
  const raw = run(request.code, request.tests, request.mode, request.timeoutMs / 1000);
  const parsed = JSON.parse(raw) as ExecResult;
  return {
    ...parsed,
    stdout: clamp(parsed.stdout),
    stderr: clamp(parsed.stderr),
    durationMs: 0,
  };
}

// --- JavaScript -----------------------------------------------------------------------------

class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionFailure";
  }
}

function display(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEquals(left[key], right[key]));
}

function assert(condition: unknown, message?: string): void {
  if (!condition) throw new AssertionFailure(message ?? "assert(...) got a falsy value");
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionFailure(message ?? `expected ${display(expected)} but got ${display(actual)}`);
  }
}

function assertDeepEquals(actual: unknown, expected: unknown, message?: string): void {
  if (!deepEquals(actual, expected)) {
    throw new AssertionFailure(message ?? `expected ${display(expected)} but got ${display(actual)}`);
  }
}

/**
 * `new Function` prepends a synthetic wrapper, so a stack line number is not a body line number.
 * Measure the offset once rather than hardcoding one browser's idea of it.
 */
let lineOffset: number | null = null;
function bodyLineOffset(): number {
  if (lineOffset !== null) return lineOffset;
  lineOffset = 0;
  try {
    new Function(`\nthrow new Error("probe");\n//# sourceURL=${SOURCE_URL}`)();
  } catch (error) {
    const reported = stackLine(error);
    if (reported !== null) lineOffset = reported - 2; // the throw sits on body line 2
  }
  return lineOffset;
}

/** First stack frame pointing into the generated source, as a raw (uncorrected) line number. */
function stackLine(error: unknown): number | null {
  const stack = error instanceof Error ? error.stack : null;
  if (!stack) return null;
  for (const frame of stack.split("\n")) {
    const match = frame.match(new RegExp(`${SOURCE_URL}:(\\d+):\\d+`));
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * An exercise is a single script, not a module: it runs inside `new Function`, where `export` is a
 * syntax error. Models write `export function …` out of habit and a learner should not have to
 * decode "Unexpected token 'export'" because of it, so the keyword is blanked — replaced by spaces
 * of the same width, never deleted, so every line and column number still points where it did.
 */
export function blankModuleSyntax(source: string): string {
  const blanks = (text: string): string => " ".repeat(text.length);
  return (
    source
      // `export { … }` / `export type { … }` on its own line: nothing to keep.
      .replace(/^[ \t]*export\s+(?:type\s+)?\{[^}]*\}[ \t]*;?[ \t]*$/gm, blanks)
      // `export default` and a plain `export` prefix on a declaration.
      .replace(/(^[ \t]*)export\s+default\s+/gm, (match, indent: string) => indent + blanks(match.slice(indent.length)))
      .replace(
        /(^[ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var|type|interface)\b)/gm,
        (match, indent: string) => indent + blanks(match.slice(indent.length)),
      )
  );
}

function runJavaScript(request: WorkerRequest): ExecResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = {
    log: (...args: unknown[]) => void stdout.push(args.map(text).join(" ")),
    info: (...args: unknown[]) => void stdout.push(args.map(text).join(" ")),
    debug: (...args: unknown[]) => void stdout.push(args.map(text).join(" ")),
    warn: (...args: unknown[]) => void stderr.push(args.map(text).join(" ")),
    error: (...args: unknown[]) => void stderr.push(args.map(text).join(" ")),
  };

  const code = blankModuleSyntax(request.code);
  const tests = blankModuleSyntax(request.tests);
  const codeLines = code.split("\n").length;
  const body =
    `${code}\n` + `;__hooks.tests = function () {\n${tests}\n};\n` + `//# sourceURL=${SOURCE_URL}`;
  const offset = bodyLineOffset();

  const finish = (passed: boolean | null, failure: Failure | null): ExecResult => ({
    stdout: clamp(stdout.join("\n")),
    stderr: clamp(stderr.join("\n")),
    passed,
    failure,
    durationMs: 0,
  });

  const hooks: { tests?: () => void } = {};
  let entry: (...args: unknown[]) => void;
  try {
    entry = new Function("console", "__hooks", "assert", "assertEquals", "assertDeepEquals", body) as typeof entry;
  } catch (error) {
    // A SyntaxError here means the whole body failed to parse. Browsers rarely give a usable line
    // number for that, so report it without one.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return finish(request.mode === "submit" ? false : null, {
      kind: "syntax",
      where: "code",
      message,
      line: null,
      source: null,
      testLine: null,
      testSource: null,
      traceback: message,
    });
  }

  try {
    entry(sink, hooks, assert, assertEquals, assertDeepEquals);
    if (request.mode === "submit") {
      hooks.tests?.();
      return finish(true, null);
    }
    return finish(null, null);
  } catch (error) {
    const raw = stackLine(error);
    const bodyLine = raw === null ? null : raw - offset;
    // Body layout: the learner's code is lines 1..codeLines, the wrapper header is codeLines + 1,
    // so test line N lands on body line codeLines + 1 + N.
    const inTests = bodyLine !== null && bodyLine > codeLines + 1;
    const line = bodyLine === null ? null : inTests ? bodyLine - (codeLines + 1) : bodyLine;
    const source = line === null ? null : lineOf(inTests ? request.tests : request.code, line);
    const isAssertion = error instanceof AssertionFailure;

    return finish(request.mode === "submit" ? false : null, {
      kind: isAssertion ? "assertion" : "error",
      where: inTests ? "tests" : "code",
      message: isAssertion
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      line,
      source,
      testLine: inTests ? line : null,
      testSource: inTests ? source : null,
      traceback: cleanStack(error),
    });
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : display(value);
}

function lineOf(source: string, line: number): string | null {
  const lines = source.split("\n");
  return line >= 1 && line <= lines.length ? lines[line - 1].trim() : null;
}

function cleanStack(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const head = `${error.name}: ${error.message}`;
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((frame) => frame.includes(SOURCE_URL))
    .map((frame) => frame.trim());
  return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

function clamp(value: string): string {
  return value.length > MAX_STREAM ? `${value.slice(0, MAX_STREAM)}\n…output truncated…` : value;
}
