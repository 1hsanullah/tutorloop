# TutorLoop

An MCP server that lets a chat assistant drop a **graded** coding exercise into the conversation.
Lesson on the left, editor on the right, Run and Submit. Hidden tests decide pass/fail, and a failed
attempt goes back into the chat with one click — so the explanation you get is about *your* code.

Python runs on Pyodide, JavaScript and TypeScript in a sandboxed worker, SQL on SQLite. Everything
executes in the browser: no accounts, no backend, no per-student compute.

MIT licensed.

---

## What makes it different

The editor is a commodity. The **grading loop** is the point:

1. The model authors a hidden test suite per exercise, and the widget runs it against the submission.
2. You get a pass/fail verdict, not just stdout.
3. On failure, one button posts your exact code and the exact error back into the chat, where the
   tutor that set the exercise is still sitting.

There is no curriculum. Every exercise is generated on demand, for whatever you asked to learn.

## Install

Requires Node 20+.

> The npm release is pending. Until it lands, use **From source** below.

**Claude Code**

```bash
claude mcp add tutorloop -- npx -y tutorloop
```

**Claude Desktop** — Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "tutorloop": {
      "command": "npx",
      "args": ["-y", "tutorloop"]
    }
  }
}
```

Restart Claude Desktop afterwards — quit it from the tray, since closing the window isn't enough.

<details>
<summary><b>From source</b> — works today, before the npm release</summary>

```bash
git clone https://github.com/1hsanullah/tutorloop.git
cd tutorloop
npm install          # builds dist/ via the prepare script
```

Then point the config at the built file instead of npx:

```bash
claude mcp add tutorloop -- node /absolute/path/to/tutorloop/dist/server.js
```

```json
{
  "mcpServers": {
    "tutorloop": {
      "command": "node",
      "args": ["/absolute/path/to/tutorloop/dist/server.js"]
    }
  }
}
```

</details>

Then ask for something: *"teach me Python list comprehensions"*, *"quiz me on Array.reduce"*,
*"drill me on SQL GROUP BY"*, *"test me on narrowing TypeScript unions"*.

## The tool

One tool, `render_exercise`. The model writes the lesson **and** the tests:

```jsonc
{
  "language": "python",                  // "python" | "javascript" | "typescript" | "sql"
  "title": "f-strings: formatting numbers",
  "lesson_md": "The concept plus one worked example. Short.",
  "task_md": "What to implement, including the exact function name.",
  "starter_code": "def format_price(x):\n    # your code here\n    pass\n",
  "tests": "assert format_price(3.14159) == \"$3.14\"\nassert format_price(10) == \"$10.00\"\n",
  "hints": ["Look at the :.2f format spec.", "..."],
  "solution": "def format_price(x):\n    return f\"${x:.2f}\"\n"
}
```

The form of `tests` follows the language:

| Language | How it is graded |
|---|---|
| `python` | Plain `assert` statements, run in the same scope as the learner's code |
| `javascript`, `typescript` | `assert(cond, msg)`, `assertEquals(a, b)`, `assertDeepEquals(a, b)`, same scope |
| `sql` | A **reference query**; the learner's result set is compared to its result set |

SQL exercises also take a `seed` — the `CREATE TABLE`s and `INSERT`s that run first. The widget
shows the learner the resulting tables, columns and row counts, so the schema is not a secret; the
reference query is.

Two decisions worth knowing about SQL. Grading compares **results, not query text**, so any
correct formulation passes. And the reference is *SQL you would accept*, not literal expected rows,
because writing a query is something a model does reliably while hand-computing the rows it should
return is exactly where model-authored tests go wrong and mark a correct learner wrong. Row order
counts only if the reference has an `ORDER BY`; a first line of `-- ordered` or `-- unordered`
overrides that. An `INSERT`/`UPDATE`/`DELETE` exercise is graded on the resulting table contents
instead of a result set.

TypeScript is erased to JavaScript before running, with `ts-blank-space`, which replaces types
with spaces rather than deleting them — so a runtime error's line number still points at the
learner's own TypeScript, with no source map involved. Erasable TypeScript only, the same constraint
Node's `--experimental-strip-types` has: no `enum`, `namespace` or constructor parameter
properties. The widget explains that rather than throwing if a model uses one.

Hosts that cannot render widgets (terminal clients, older hosts) get the same exercise as text
instead of an error — without the hidden tests.

## The cheating problem

The answer key is one message away in the same chat. Mitigations, in order of value:

- `solution` stays hidden until three failed submissions, then a "show solution" button appears.
- Hints escalate: the first is free, each later one unlocks after another failed attempt.
- The tool description tells the model to explain the learner's mistake rather than hand over the
  answer.

A determined learner defeats all of this. That is their time to spend.

## How it fits together

```
host (Claude, ChatGPT, Goose, VS Code)
   │  tools/call: render_exercise({lesson, starter_code, tests, ...})
   ▼
MCP server (Node, stdio)                       src/server.ts
   │  text result + structuredContent + _meta.ui.resourceUri → ui://lesson/exercise.html
   ▼
widget (sandboxed iframe, one self-contained HTML file)
   ├── CodeMirror 6            editor, bundled — no CDN
   ├── module worker           Pyodide (Python), SQLite (SQL), plain JS (JS/TS)
   └── MCP Apps bridge         delivers the exercise, posts failures back into the chat
```

The server is a thin content pipe: no curriculum, no state, no execution. Everything interesting is
client-side. Only the language runtimes are fetched at run time — Pyodide (~10 MB), SQLite (~1.5 MB)
and the TypeScript parser (~1 MB compressed) — all from `cdn.jsdelivr.net`, which the server
declares in the resource's CSP metadata, and each only when a learner opens an exercise that needs
it. Everything else, CodeMirror included, is inlined in the widget.

The bridge is `@modelcontextprotocol/ext-apps` (MCP Apps, SEP-1865) with a `window.openai`
fallback so the same bundle works in ChatGPT.

## Development

```bash
npm run build       # dist/widget.html + dist/server.js
npm run dev         # rebuild on change
npm run dev:serve   # http://localhost:5173/dev/harness.html
npm test            # unit tests + a real stdio client against the built server
npm run typecheck
```

`dev/harness.html` is a working MCP Apps **host**: it speaks the real protocol over postMessage,
delivers a sample exercise, and shows the messages the widget posts back into the "chat" in a column
on the right. What works there is what works in a chat client, minus the host's CSP.

Source layout:

| Path | What lives there |
|---|---|
| `src/server.ts` | MCP server: one tool, one resource |
| `src/exercise.ts` | The tool schema and the text-only fallback |
| `widget/main.ts` | UI, verdicts, hint and solution gating, the post-back message |
| `widget/runner.ts` | Dispatch, the JS/TS grader, first-failure extraction |
| `widget/sql-engine.ts` | SQLite, result-set comparison, the schema panel's data |
| `widget/typescript.ts` | Type erasure, and what to say when it is not possible |
| `widget/python-driver.ts` | The Python half of the grader (tracebacks, tracing deadline) |
| `widget/runner-client.ts` | Worker lifecycle, watchdog, main-thread fallback |
| `widget/host.ts` | MCP Apps / `window.openai` bridge |

## Known limits

- **Pyodide is a ~10 MB cold start.** It loads lazily on the first Run and stays warm for the life
  of the widget instance. The widget starts warming it as soon as an exercise arrives.
- **Pyodide 314 refuses classic workers**, so the runner uses a module worker and imports
  `pyodide.mjs`. A host that blocks `blob:` workers falls back to the main thread, where grading
  still works but a runaway loop can only be stopped by Python's own tracing deadline.
- **Runaway code** is stopped two ways: a tracing deadline inside Python (10 s, raised in the
  learner's own frame, so the worker survives), and a watchdog that terminates and replaces the
  worker if that fails.
- **Model-authored tests are sometimes wrong.** A learner will occasionally be marked wrong while
  being right. The escape hatch is arguing with the tutor in the chat, which is why the failure
  message is one click from the conversation and one click from the clipboard.
- **The widget is ~920 kB** as a single HTML file, nearly all of it CodeMirror. That is well inside
  what hosts accept over stdio, and it buys an editor that needs no CDN.
- **SQL grading uses the first result set** a script produces, and compares table contents when
  there is none. A script with two `SELECT`s is graded on the first.
- **A host CSP without `wasm-unsafe-eval` would block Pyodide entirely.** The widget says so in the
  pane rather than failing silently.
- **The tool declares no `outputSchema`, deliberately.** The MCP TypeScript SDK stamps schemas it
  generates from zod as draft-07, and hosts compile a tool's output schema with a 2020-12-only
  validator — which rejects the whole tool ("declares unsupported dialect"). Input schemas are not
  compiled by hosts, so only the output schema was affected. `structuredContent` is still returned.

## Answers to the spec's open questions

- *Does the widget persist across turns?* One widget instance per `render_exercise` call. Within an
  instance the Pyodide worker stays warm across runs and submissions; a new exercise means a new
  instance and a new cold start.
- *Can the widget read conversation context?* No. Everything arrives as tool arguments (mirrored
  into `structuredContent`), which is why the model must author the whole exercise up front.
- *Is there a size ceiling that rules out shipping Pyodide from the server?* Not proven, but at
  ~10 MB of wasm it would be reckless over stdio. Pyodide stays on the CDN; only CodeMirror and the
  app are inlined.

## Testing note

`npm test` covers the markdown renderer, the tool schema, the server protocol over real stdio, and
the JavaScript, TypeScript and SQL graders. The last two only run offline because their engines are
imported through a URL the tests point at the local install, so nothing reaches the network.

The Python grader and all UI behaviour need a browser, and were verified through the dev harness:
pass, failed assertion with the exact failing line, runtime error attributed to the learner's line,
infinite loop stopped at the deadline, hint and solution gating, and the post-back message arriving
in the host. **The SQL and TypeScript engines have not yet been driven in a browser** — they are
loaded exactly the way Pyodide is, which is proven, but that is an argument rather than a
measurement. Run the harness against the SQL and TypeScript samples before trusting them.
