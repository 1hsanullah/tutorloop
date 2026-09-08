# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TutorLoop is an MCP server exposing one tool, `render_exercise`, which renders a graded coding
exercise as an MCP Apps widget in a chat client. The model authors the lesson, starter code, hidden tests, hints
and solution as tool arguments. The widget runs the learner's code and the hidden tests in the
browser and posts failures back into the conversation. Four languages: Python (Pyodide),
JavaScript, TypeScript (erased to JavaScript) and SQL (SQLite). `SPEC.md` is the original build spec and
still describes the intended product; `README.md` covers install and known limits.

## Commands

```bash
npm run build       # dist/widget.html + dist/server.js + dist/dev/ (esbuild, ~0.5s)
npm run dev         # same, rebuilding on change
npm run typecheck   # tsc --noEmit over src, widget, scripts
npm test            # all tests
npm run dev:serve   # build, then serve the dev harness on :5173
```

Run one test file or one test:

```bash
node --test test/server.test.mjs
node --test --test-name-pattern "reports the first failing assertion" test/widget.test.mjs
```

`test/server.test.mjs` drives `dist/server.js` over real stdio, so **build before testing**.

`npm test` passes no path deliberately. Node 20 accepts a directory argument, Node 24 rejects it
(`Cannot find module .../test`), and a glob relies on shell expansion that cmd.exe does not do.
Bare `node --test` scans the project and works on both; naming a single file still works, as above.

## Architecture

Three layers, and the interesting behaviour is all in the third:

1. **`src/server.ts`** — a thin content pipe. One tool, one UI resource (`ui://lesson/exercise.html`),
   no state, no execution, no curriculum. Reads `dist/widget.html` into memory at startup and serves
   it as the resource body.
2. **`widget/host.ts`** — the bridge. MCP Apps (`@modelcontextprotocol/ext-apps`) is primary,
   `window.openai` is the ChatGPT fallback, and "standalone" is a working degraded mode.
3. **`widget/runner.ts`** — dispatch, plus execution and, more importantly, turning a failure into
   a first-failure report (which line, which assertion, what the traceback says). Per language:
   `python-driver.ts` (a Python source string), `sql-engine.ts`, `typescript.ts`.

`src/exercise.ts` holds the tool's zod schema and the text-only fallback used when a host cannot
render widgets.

### Build model

`dist/widget.html` is one self-contained file. `scripts/build.mjs` bundles `widget/runner.worker.ts`
first, then injects that bundle as a **string** into the main bundle via the `__WORKER_SOURCE__`
define; the widget turns it into a `blob:` URL at runtime. A sandboxed MCP app has no origin of its
own, so it cannot serve a second file — everything is inlined, CodeMirror included, except the
language runtimes (Pyodide, SQLite, the TypeScript parser), which are fetched from the CDN on use.

The server reads the widget at startup, so **after any build, restart the host** (Claude Desktop)
to pick up widget changes.

### Adding a language

Five places: the enum in `src/exercise.ts`, the union in `widget/protocol.ts`, dispatch in
`widget/runner.ts`, the CodeMirror mode in `widget/editor.ts`, and verdict rendering in
`widget/main.ts`. Runtimes are never bundled — add a URL to `ENGINE_URLS` in `protocol.ts` and
import it through the computed-specifier helper, so tests can point it at a local install.

Grading conventions differ by language and that is deliberate: `tests` is one string whose *form*
depends on the language (asserts for Python/JS/TS, a reference query for SQL). Adding a language
means deciding what its `tests` field means and documenting it in the field description, which is
what the model reads.

## Things that will bite you

- **Pyodide 314 refuses to run in a classic worker** ("Classic web workers are not supported"). The
  runner uses a module worker and `await import(`${indexUrl}pyodide.mjs`)`. The URL is assembled at
  runtime specifically so esbuild leaves the import alone. Do not "tidy" it into a static import or
  switch back to `importScripts`.
- **The tool declares no `outputSchema`, deliberately.** The MCP SDK stamps zod-derived schemas as
  draft-07; hosts compile a tool's output schema with a 2020-12-only Ajv and reject the entire tool
  ("declares unsupported dialect"). Input schemas are never compiled by hosts, so only output was
  affected. `structuredContent` is still returned. A regression test in `test/server.test.mjs`
  compiles any published output schema with that validator.
- **The MCP Apps handshake is initiated by the view**, so a host that attaches its listener late
  never sees the first attempt. `host.ts` retries three times; `dev/harness.ts` connects its
  `AppBridge` *before* the iframe navigates for the same reason.
- **`onhostcontextchanged` params are the changed context itself**, not a wrapper containing it.
  Destructuring a `hostContext` property silently drops theme changes.
- **`canPostToChat` asks the host** whether it accepts `message.text`. A host that renders widgets
  does not necessarily accept messages from them, and posting failures into the chat is the point of
  the product — never assume the capability.
- **Adding a runtime origin means editing the CSP in `src/server.ts`**, in both `resourceDomains`
  (scripts, wasm, styles) and `connectDomains` (fetch), on the resource `_meta.ui`. Undeclared
  origins fail with no visible error in a real host.
- **Runaway code** is stopped inside Python by a tracing deadline that raises `_Deadline`
  (a `BaseException`, so a bare `except Exception` in learner code cannot swallow it), and by a
  worker-terminating watchdog in `runner-client.ts` if that fails. The worker is disposable and
  respawned lazily; do not hold a reference to it across runs.
- **Model-authored content is escaped, never sanitised.** `widget/markdown.ts` escapes all HTML
  before adding any markup. Keep that ordering if you extend it.
- **Two transforms blank code rather than deleting it**, and both depend on that: type erasure
  (`ts-blank-space`) and `blankModuleSyntax` (which neutralises an `export` a model wrote out of
  habit, since the body runs inside `new Function`). Every line and column stays put, so stack-trace
  line numbers still point at the learner's source. Anything that shifts lines breaks error
  reporting — and for TypeScript, `quoteOriginal` re-reads the quoted line from the untransformed
  source so learners never see the blanked version.
- **SQL is graded on results, not text**, against a reference query the model supplies in `tests`.
  Never switch that to literal expected rows: models write correct SQL far more reliably than they
  hand-compute the rows a query returns, and a wrong expectation marks a correct learner wrong.
  Every execution gets a fresh in-memory database, so nothing leaks between runs.

## Testing what a browser owns

`npm test` covers the markdown renderer, exercise-payload parsing, the server protocol via a real
`Client` over stdio, and the **JavaScript, TypeScript and SQL** graders. Those three run in Node
because none of their paths in `runner.ts` touch the DOM, and because engines are imported through a
URL: `test/languages.test.mjs` points `engines.sqlite` and `engines.tsStripper` at the local
install, so the suite never reaches the network. Tests import TypeScript by bundling it in memory —
see `test/load.mjs`.

The **Python** grader and all UI behaviour need a browser. The SQL and TypeScript engines have not
been driven in a browser yet either — they load exactly as Pyodide does, but that is untested. `dev/harness.html` is a real MCP Apps
host, not a mock: it speaks the protocol over postMessage and shows the messages the widget posts
back into the "chat". Verify there, the way the Pyodide worker problem was found. Setting editor
content from a driver script means dispatching a `paste` event with a `DataTransfer` at
`.cm-content`; CodeMirror ignores synthetic typing.

## Conventions

- TypeScript throughout, ES modules, strict mode, no `any`. Comments explain *why*, especially where
  a workaround exists — most of the surprises above are documented at their site in the code.
- The widget keeps state in module-level variables in `main.ts` and persists nothing. Widget-local
  state only: current attempt, run output, attempts counter.
- Exercise payloads use `snake_case` (they are tool arguments); `widget/exercise-data.ts` converts to
  `camelCase` and tolerates either.
