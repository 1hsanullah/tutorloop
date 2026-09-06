import { z } from "zod";

/** Hard caps. Model-authored content arrives over stdio; keep a single tool call bounded. */
const LIMITS = {
  title: 120,
  lesson: 8_000,
  task: 4_000,
  code: 20_000,
  tests: 20_000,
  seed: 20_000,
  hint: 400,
  hints: 5,
} as const;

export const LANGUAGES = ["python", "javascript", "typescript", "sql"] as const;

export type Language = (typeof LANGUAGES)[number];

export const exerciseShape = {
  language: z
    .enum(LANGUAGES)
    .describe(
      "Runtime for the exercise. 'python' runs on Pyodide; 'javascript' and 'typescript' in a " +
        "sandboxed worker; 'sql' on SQLite. All four execute in the learner's browser.",
    ),
  title: z.string().min(1).max(LIMITS.title).describe("Short exercise title, e.g. 'f-strings: formatting numbers'."),
  lesson_md: z
    .string()
    .min(1)
    .max(LIMITS.lesson)
    .describe("Markdown. The concept plus one worked example. Keep it short — a screenful, not a chapter."),
  task_md: z
    .string()
    .min(1)
    .max(LIMITS.task)
    .describe(
      "Markdown. Exactly what the learner must produce. For python/javascript/typescript, name the " +
        "required function and its signature. For sql, say which columns to return, in what order, " +
        "and whether row order matters.",
    ),
  starter_code: z
    .string()
    .max(LIMITS.code)
    .describe(
      "What the editor opens with. Include the signature and a '# your code here' placeholder, never " +
        "the answer. For sql, a comment and the skeleton of a statement (e.g. 'SELECT ... FROM orders').",
    ),
  seed: z
    .string()
    .max(LIMITS.seed)
    .default("")
    .describe(
      "SQL only, and required for sql: CREATE TABLE statements plus INSERTs, run before anything else " +
        "on a fresh in-memory database. Keep it small — a handful of rows chosen so a wrong query gives " +
        "a visibly wrong answer, including at least one edge case (a NULL, a tie, an empty group). " +
        "The widget shows the learner the resulting table names, columns and row counts, so this is not " +
        "hidden; the reference answer in 'tests' is.",
    ),
  tests: z
    .string()
    .min(1)
    .max(LIMITS.tests)
    .describe(
      "The hidden grader, never shown before submission. Its form depends on the language.\n" +
        "python: plain `assert` statements, at least three, one an edge case.\n" +
        "javascript/typescript: `assert(cond, msg)`, `assertEquals(actual, expected)` and " +
        "`assertDeepEquals(actual, expected)` are in scope; at least three assertions. Tests run in " +
        "the same scope as the learner's code, so they can call whatever it defines. TypeScript tests " +
        "may be typed; the types are erased before running.\n" +
        "sql: a *reference answer written as SQL* — not expected rows. It runs against its own copy of " +
        "the seeded database and the learner's result set is compared to it, so write the query you " +
        "would accept as correct. Row order is enforced only if the reference has an ORDER BY; force " +
        "it either way with a first line of `-- ordered` or `-- unordered`. For an INSERT/UPDATE/DELETE " +
        "exercise, write the equivalent statements and the resulting table contents are compared " +
        "instead.",
    ),
  hints: z
    .array(z.string().min(1).max(LIMITS.hint))
    .max(LIMITS.hints)
    .default([])
    .describe(
      "Escalating hints, nudge first and near-answer last. Revealed one at a time: the first is free, " +
        "each later one unlocks after another failed submission.",
    ),
  solution: z
    .string()
    .max(LIMITS.code)
    .default("")
    .describe("Reference solution. Kept hidden by the widget until three failed submissions."),
};

export const exerciseSchema = z.object(exerciseShape);

/** The payload handed to the widget. */
export type Exercise = z.infer<typeof exerciseSchema>;

/** Rendered when the host cannot display widgets (terminal clients, older hosts). */
export function textFallback(ex: Exercise): string {
  const parts = [`# ${ex.title}`, "", ex.lesson_md, "", "## Your task", "", ex.task_md, ""];

  if (ex.language === "sql" && ex.seed.trim()) {
    parts.push("The tables you are querying are created by:", "", "```sql", ex.seed.trim(), "```", "");
  }

  parts.push(
    "```" + ex.language,
    ex.starter_code.trimEnd(),
    "```",
    "",
    "_This host cannot render the interactive widget, so there is no editor or grader here._",
    `_Write your attempt in the chat and it will be checked ${
      ex.language === "sql" ? "against the exercise's reference query" : `against its ${countAssertions(ex.tests)} hidden test(s)`
    } by hand._`,
  );

  return parts.join("\n");
}

function countAssertions(tests: string): number {
  const matches = tests.match(/^\s*(assert|assertEquals|assertDeepEquals)\b/gm);
  return matches ? matches.length : 1;
}
