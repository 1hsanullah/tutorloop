/**
 * The widget: lesson on the left, editor and grader on the right.
 *
 * All state is local to this instance — the current attempt, the run output, the attempts counter.
 * Nothing is persisted, and nothing is sent anywhere except the one message the learner chooses to
 * push back into the conversation.
 */
import { Editor } from "./editor.js";
import { Host } from "./host.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { RunnerClient } from "./runner-client.js";
import type { ExecResult, Failure, ResultTable, SchemaTable } from "./protocol.js";
import { isTabular } from "./protocol.js";
import type { Exercise } from "./exercise-data.js";

const LANGUAGE_NAMES: Record<Exercise["language"], string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  sql: "SQL",
};

/** Failed submissions before the reference solution can be revealed. */
const SOLUTION_UNLOCKS_AFTER = 3;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dom = {
  shell: el("shell"),
  title: el("title"),
  language: el("language"),
  lesson: el("lesson"),
  task: el("task"),
  schema: el("schema"),
  schemaBody: el("schema-body"),
  hints: el("hints"),
  hintList: el<HTMLOListElement>("hint-list"),
  hintButton: el<HTMLButtonElement>("hint-button"),
  hintLocked: el("hint-locked"),
  solutionSection: el("solution-section"),
  solutionButton: el<HTMLButtonElement>("solution-button"),
  solutionBody: el("solution-body"),
  run: el<HTMLButtonElement>("run"),
  submit: el<HTMLButtonElement>("submit"),
  reset: el<HTMLButtonElement>("reset"),
  attempts: el("attempts"),
  degraded: el("degraded"),
  editor: el("editor"),
  results: el("results"),
  status: el("status"),
  verdict: el("verdict"),
  verdictLabel: el("verdict-label"),
  verdictBody: el("verdict-body"),
  verdictActions: el("verdict-actions"),
  copy: el<HTMLButtonElement>("copy"),
  output: el("output"),
  outputBody: el("output-body"),
  grid: el("grid"),
  gridHead: el("grid-head"),
  gridBody: el("grid-body"),
};

const host = new Host();
const runner = new RunnerClient(setStatus);

let exercise: Exercise | null = null;
let editor: Editor | null = null;
let attempts = 0;
let failures = 0;
let hintsShown = 0;
let solved = false;
let busy = false;
let lastFailure: { failure: Failure; code: string } | null = null;
let lastTable: ResultTable | null = null;

function isDark(): boolean {
  const attribute = document.documentElement.dataset.theme;
  if (attribute === "dark" || attribute === "light") return attribute === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function setStatus(text: string): void {
  dom.status.textContent = text;
  dom.status.hidden = !text;
  syncResultsVisibility();
}

/** Keep the results strip out of the layout entirely until it has something to say. */
function syncResultsVisibility(): void {
  dom.results.hidden =
    dom.status.hidden && dom.verdict.hidden && dom.output.hidden && dom.grid.hidden;
}

function setBusy(next: boolean): void {
  busy = next;
  dom.run.disabled = next || !exercise;
  dom.submit.disabled = next || !exercise;
  dom.shell.classList.toggle("busy", next);
}

// --- rendering ------------------------------------------------------------------------------

function renderExercise(next: Exercise): void {
  exercise = next;
  attempts = 0;
  failures = 0;
  hintsShown = 0;
  solved = false;
  lastFailure = null;

  document.title = next.title;
  dom.title.textContent = next.title;
  dom.language.textContent = LANGUAGE_NAMES[next.language];
  dom.lesson.innerHTML = renderMarkdown(next.lessonMd);
  dom.task.innerHTML = renderMarkdown(next.taskMd);

  editor?.destroy();
  dom.editor.replaceChildren();
  editor = new Editor({
    parent: dom.editor,
    doc: next.starterCode,
    language: next.language,
    dark: isDark(),
    onRun: () => void execute("run"),
    onSubmit: () => void execute("submit"),
  });

  dom.verdict.hidden = true;
  dom.output.hidden = true;
  dom.grid.hidden = true;
  dom.schema.hidden = true;
  syncResultsVisibility();
  renderAttempts();
  renderHints();
  renderSolution();
  setBusy(false);

  const warming = runner.prewarm(next.language, next.seed);
  if (warming) {
    void warming
      .then((result) => renderSchema(result.schema ?? []))
      .catch((error: unknown) => showEngineError(error));
  }
}

function renderSchema(tables: SchemaTable[]): void {
  dom.schema.hidden = tables.length === 0;
  dom.schemaBody.replaceChildren(
    ...tables.map((table) => {
      const row = document.createElement("p");
      row.className = "schema-table";
      row.innerHTML =
        `<b>${escapeHtml(table.name)}</b> <span>(${table.columns.map(escapeHtml).join(", ")})</span> ` +
        `<span class="schema-rows">— ${table.rowCount} row${table.rowCount === 1 ? "" : "s"}</span>`;
      return row;
    }),
  );
}

function renderAttempts(): void {
  dom.attempts.textContent =
    attempts === 0 ? "No attempts yet" : `${attempts} attempt${attempts === 1 ? "" : "s"}`;
}

/** Hint 1 is free; each later hint unlocks after another failed submission. */
function hintsAvailable(): number {
  if (!exercise) return 0;
  return Math.min(exercise.hints.length, failures + 1);
}

function renderHints(): void {
  if (!exercise || exercise.hints.length === 0) {
    dom.hints.hidden = true;
    return;
  }
  dom.hints.hidden = false;
  dom.hintList.replaceChildren(
    ...exercise.hints.slice(0, hintsShown).map((hint) => {
      const item = document.createElement("li");
      item.innerHTML = renderMarkdown(hint);
      return item;
    }),
  );

  const available = hintsAvailable();
  const more = hintsShown < exercise.hints.length;
  const unlocked = hintsShown < available;
  dom.hintButton.hidden = !more || !unlocked;
  dom.hintButton.textContent = hintsShown === 0 ? "Show a hint" : "Show the next hint";
  dom.hintLocked.hidden = !more || unlocked;
  dom.hintLocked.textContent = more && !unlocked ? "The next hint unlocks after another attempt." : "";
}

function renderSolution(): void {
  if (!exercise || !exercise.solution.trim()) {
    dom.solutionSection.hidden = true;
    return;
  }
  const unlocked = failures >= SOLUTION_UNLOCKS_AFTER || solved;
  dom.solutionSection.hidden = !unlocked;
  if (!unlocked) {
    dom.solutionBody.hidden = true;
    dom.solutionButton.hidden = false;
  }
}

// --- running and grading --------------------------------------------------------------------

async function execute(mode: "run" | "submit"): Promise<void> {
  if (!exercise || !editor || busy) return;
  const code = editor.value;
  setBusy(true);
  setStatus(mode === "run" ? "Running…" : "Grading…");

  try {
    const result = await runner.exec({
      mode,
      language: exercise.language,
      code,
      tests: exercise.tests,
      seed: exercise.seed,
    });
    if (mode === "submit") {
      attempts += 1;
      if (result.passed === false) failures += 1;
      if (result.passed === true) solved = true;
      renderAttempts();
      renderHints();
      renderSolution();
    }
    showResult(mode, result, code);
  } catch (error) {
    showEngineError(error);
  } finally {
    // Only knowable after an attempt: the worker is created lazily.
    dom.degraded.hidden = !runner.degraded;
    setStatus("");
    setBusy(false);
  }
}

function showResult(mode: "run" | "submit", result: ExecResult, code: string): void {
  renderStreams(result);
  renderGrid(result.table);
  lastTable = result.table ?? null;

  if (mode === "run") {
    lastFailure = result.failure ? { failure: result.failure, code } : null;
    if (!result.failure) {
      showVerdict(
        "neutral",
        tabular() ? "Query ran" : "Ran without errors",
        `<p class="muted">Run does not grade anything — press Submit when you want it ${
          tabular() ? "checked against the expected result" : "checked against the tests"
        }.</p>`,
        [],
      );
      return;
    }
    showVerdict("error", failureHeadline(result.failure), failureHtml(result.failure), [
      explainButton(result.failure, code),
    ]);
    return;
  }

  if (result.passed) {
    lastFailure = null;
    showVerdict("pass", tabular() ? "Correct" : "Passed — every test", passHtml(result), [nextExerciseButton()]);
    return;
  }

  const failure = result.failure;
  if (!failure) {
    showVerdict("error", "Failed", "<p>The tests did not pass, but no failure was reported.</p>", []);
    return;
  }
  lastFailure = { failure, code };
  showVerdict("fail", failureHeadline(failure), failureHtml(failure), [explainButton(failure, code)]);
}

function failureHeadline(failure: Failure): string {
  switch (failure.kind) {
    case "mismatch":
      return "Wrong result";
    case "assertion":
      return "Failed a test";
    case "timeout":
      return "Timed out";
    case "syntax":
      return failure.where === "tests" ? "The test suite has a syntax error" : "Your code has a syntax error";
    default:
      return failure.where === "tests" ? "The tests hit an error" : "Your code raised an error";
  }
}

function failureHtml(failure: Failure): string {
  const parts = [`<p class="message">${escapeHtml(failure.message)}</p>`];

  if (failure.expected) {
    parts.push('<p class="muted">Expected:</p>');
    parts.push(renderTable(failure.expected, "grid expected").outerHTML);
  }

  if (failure.kind === "assertion" && failure.testSource) {
    parts.push(
      `<p class="muted">This assertion is the one that failed${
        failure.testLine ? ` (test line ${failure.testLine})` : ""
      }:</p>`,
      `<pre class="code-block">${escapeHtml(failure.testSource)}</pre>`,
    );
  } else if (failure.source) {
    const label = failure.where === "tests" ? "In the test suite" : "In your code";
    parts.push(
      `<p class="muted">${label}${failure.line ? `, line ${failure.line}` : ""}:</p>`,
      `<pre class="code-block">${escapeHtml(failure.source)}</pre>`,
    );
  }

  if (failure.traceback && failure.traceback !== failure.message) {
    parts.push(
      `<details class="traceback"><summary>Full traceback</summary><pre>${escapeHtml(
        failure.traceback,
      )}</pre></details>`,
    );
  }

  return parts.join("\n");
}

function passHtml(result: ExecResult): string {
  const what = tabular() ? "Your result matches the expected one" : "All hidden tests passed";
  return `<p class="muted">${what}, in ${result.durationMs} ms. Attempts: ${attempts}.</p>`;
}

function tabular(): boolean {
  return exercise ? isTabular(exercise.language) : false;
}

function showVerdict(
  tone: "pass" | "fail" | "error" | "neutral",
  label: string,
  bodyHtml: string,
  actions: HTMLElement[],
): void {
  dom.verdict.hidden = false;
  dom.verdict.dataset.tone = tone;
  dom.verdictLabel.textContent = label;
  dom.verdictBody.innerHTML = bodyHtml;
  dom.verdictActions.replaceChildren(...actions);
  dom.copy.hidden = tone === "pass" || tone === "neutral";
  syncResultsVisibility();
}

/** SQL answers are tables, so show them as tables rather than as text. */
function renderTable(table: ResultTable, className = "grid"): HTMLElement {
  if (!table.columns.length) {
    const empty = document.createElement("p");
    empty.className = "grid-empty";
    empty.textContent = "No rows returned.";
    return empty;
  }

  const element = document.createElement("table");
  element.className = className;
  const head = element.createTHead().insertRow();
  for (const column of table.columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    head.append(cell);
  }
  const body = element.createTBody();
  for (const row of table.rows) {
    const line = body.insertRow();
    for (const value of row) {
      const cell = line.insertCell();
      if (value === null || value === undefined) {
        cell.textContent = "NULL";
        cell.className = "null";
      } else {
        cell.textContent = String(value);
      }
    }
  }
  return element;
}

function renderGrid(table: ResultTable | null | undefined): void {
  dom.grid.hidden = !table;
  if (!table) {
    dom.gridBody.replaceChildren();
    syncResultsVisibility();
    return;
  }
  dom.gridHead.textContent = `Your result — ${table.rows.length} row${table.rows.length === 1 ? "" : "s"}`;
  dom.gridBody.replaceChildren(renderTable(table));
  if (table.truncated) {
    const note = document.createElement("p");
    note.className = "grid-note";
    note.textContent = "Only the first rows are shown.";
    dom.gridBody.append(note);
  }
  syncResultsVisibility();
}

function renderStreams(result: ExecResult): void {
  const streams = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""]
    .filter(Boolean)
    .join("\n");
  dom.output.hidden = !streams;
  dom.outputBody.textContent = streams;
  syncResultsVisibility();
}

function showEngineError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dom.output.hidden = true;
  showVerdict(
    "error",
    "The runtime could not start",
    `<p class="message">${escapeHtml(message)}</p>
     <p class="muted">Python is downloaded from cdn.jsdelivr.net on first use. If this host blocks
     that origin, the exercise cannot be graded here — tell the tutor in the chat and it can walk
     you through the exercise instead.</p>`,
    [],
  );
}

// --- talking back to the conversation ---------------------------------------------------------

function explainButton(failure: Failure, code: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "primary";
  button.type = "button";
  button.textContent = "Explain my mistake";
  if (!host.canPostToChat) {
    button.disabled = true;
    button.title = "This host does not let widgets post into the conversation.";
    return button;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Sent to the chat";
    try {
      await host.postToChat(failureReport(failure, code));
    } catch (error) {
      button.disabled = false;
      button.textContent = "Explain my mistake";
      setStatus(error instanceof Error ? error.message : "Could not reach the conversation.");
    }
  });
  return button;
}

function nextExerciseButton(): HTMLElement {
  const button = document.createElement("button");
  button.className = "primary";
  button.type = "button";
  button.textContent = "Next exercise";
  if (!host.canPostToChat) {
    button.disabled = true;
    return button;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    const title = exercise?.title ?? "that";
    await host.postToChat(
      `I passed "${title}" in ${attempts} attempt${attempts === 1 ? "" : "s"}. ` +
        `Give me the next exercise — same topic, a bit harder.`,
    );
  });
  return button;
}

/** The message that goes back into the chat. The tutor needs the code and the exact error, verbatim. */
function failureReport(failure: Failure, code: string): string {
  const language = exercise?.language ?? "python";
  const lines = [
    `I'm stuck on "${exercise?.title ?? "this exercise"}". Here is my attempt (${
      attempts === 0 ? "not submitted yet" : `attempt ${attempts}`
    }):`,
    "",
    "```" + language,
    code.trimEnd(),
    "```",
    "",
    failure.kind === "mismatch" ? "It runs, but the result is wrong:" : "It fails with:",
    "",
    "```",
    failure.traceback || failure.message,
    "```",
  ];

  if (failure.kind === "assertion" && failure.testSource) {
    lines.push("", `The failing assertion was: \`${failure.testSource}\``);
  }

  // For SQL the tutor needs the two result sets, not a traceback.
  if (failure.kind === "mismatch") {
    if (lastTable) lines.push("", "What my query returned:", "", "```", asText(lastTable), "```");
    if (failure.expected) lines.push("", "What was expected:", "", "```", asText(failure.expected), "```");
  }

  lines.push(
    "",
    "Explain what my code actually does wrong — don't give me the whole answer yet.",
  );
  return lines.join("\n");
}

/** Result sets reach the chat as text, so the tutor can read them without the widget. */
function asText(table: ResultTable): string {
  if (!table.columns.length) return "(no rows)";
  const show = (value: unknown): string => (value === null || value === undefined ? "NULL" : String(value));
  const body = table.rows.map((row) => row.map(show));
  const widths = table.columns.map((column, i) =>
    Math.max(column.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(table.columns), widths.map((width) => "-".repeat(width)).join("  "), ...body.map(line)].join("\n");
}

// --- wiring ------------------------------------------------------------------------------------

dom.run.addEventListener("click", () => void execute("run"));
dom.submit.addEventListener("click", () => void execute("submit"));

dom.reset.addEventListener("click", () => {
  if (editor && exercise) {
    editor.value = exercise.starterCode;
    editor.focus();
  }
});

dom.hintButton.addEventListener("click", () => {
  if (hintsShown < hintsAvailable()) hintsShown += 1;
  renderHints();
});

dom.solutionButton.addEventListener("click", () => {
  if (!exercise) return;
  dom.solutionBody.textContent = exercise.solution;
  dom.solutionBody.hidden = false;
  dom.solutionButton.hidden = true;
});

dom.copy.addEventListener("click", async () => {
  if (!lastFailure) return;
  const report = failureReport(lastFailure.failure, lastFailure.code);
  try {
    await navigator.clipboard.writeText(report);
    dom.copy.textContent = "Copied";
    setTimeout(() => (dom.copy.textContent = "Copy error"), 1500);
  } catch {
    setStatus("This host blocks clipboard access — select the text instead.");
  }
});

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  editor?.setDark(isDark());
});

new MutationObserver(() => editor?.setDark(isDark())).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

host.onExercise(renderExercise);
void host.connect().then(() => {
  if (!exercise) {
    setStatus(
      host.kind === "standalone"
        ? "No exercise was delivered. Ask the assistant to create one."
        : "Waiting for the exercise…",
    );
  }
});

window.addEventListener("beforeunload", () => runner.dispose());
