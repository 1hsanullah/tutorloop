# Interactive Lesson Widget — Build Spec

An MCP server that lets any chat assistant spin up a graded coding exercise inline in the
conversation. Left pane: lesson + question. Right pane: editor + Run + Submit. Hidden tests
decide pass/fail. Failures go back into the chat so the model can explain *your* mistake.

MIT licensed. Free. No accounts, no backend, no per-student compute cost.

---

## 1. The one-line pitch

> "Claude, teach me f-strings" → a real graded exercise appears in the chat, and the tutor
> that wrote it is sitting right there when you get it wrong.

## 2. Why this and not the alternatives

| Thing that exists | What it's missing |
|---|---|
| ChatGPT's split-screen editable code blocks (Feb 2026) | No exercise, no tests, no grading. Host-built, can't be shipped by a third party. |
| Pyodide MCP servers | Execution only. No UI, no lesson, no verdict. |
| Codecademy / boot.dev | Fixed curriculum, paid, the AI can't see your specific broken attempt. |
| Exercism / rustlings | Great tests, but lives in a terminal, no tutor in the loop. |

**The gap being filled is the grading loop, not the editor.** The editor is a commodity now.
Three things make this different:

1. A hidden test suite the model authors per-exercise and the widget runs against the submission.
2. A pass/fail verdict, not just stdout.
3. The failed attempt posted back into chat, so the explanation is about the learner's actual code.

## 3. Scope

**In scope for v1**
- One MCP server, one tool, one widget.
- Python via Pyodide, JavaScript via a sandboxed iframe.
- Model-authored content: lesson text, starter code, tests, hints all arrive as tool arguments.
- Widget-local state only (current attempt, run output, attempts counter).

**Explicitly not in scope for v1**
- Curriculum. There is no course. Every exercise is generated on demand.
- Accounts, databases, cross-session progress.
- Server-side code execution.
- Languages that can't run in a browser (Go, Rust, shell, git). Ship Python first, JS second, stop.

## 4. Architecture

```
Claude / ChatGPT / Goose  (host)
        │  tools/call: render_exercise({lesson, starter_code, tests, ...})
        ▼
   MCP server (Node + TypeScript)
        │  returns text result + _meta.ui.resourceUri → ui://lesson/exercise
        ▼
   Widget (sandboxed iframe, static HTML+JS bundle)
        ├── CodeMirror 6            → editor
        ├── Pyodide (web worker)    → runs code + tests, fully client-side
        └── host bridge             → posts results back into the conversation
```

The server is a thin content pipe. It holds no curriculum and no state. All the interesting
behaviour is in the widget.

Build against `@modelcontextprotocol/ext-apps` (SEP-1865, final in the 2026-07-28 spec release,
supported by Claude web/desktop, VS Code, Goose, Postman). Use the MCP Apps bridge as primary
and `window.openai` compatibility as secondary so it also works in ChatGPT.

## 5. Tool contract

Single tool: **`render_exercise`**

```jsonc
{
  "language": "python",              // "python" | "javascript"
  "title": "f-strings: formatting numbers",
  "lesson_md": "markdown, short. concept + one worked example.",
  "task_md": "markdown. what the learner must do.",
  "starter_code": "def format_price(x):\n    # your code here\n    pass\n",
  "tests": "assert format_price(3.14159) == '$3.14'\nassert format_price(10) == '$10.00'\n",
  "hints": ["Look at the :.2f format spec.", "..."],   // revealed one at a time
  "solution": "..."                                   // gated, see §7
}
```

The model calls this. It writes the lesson AND the tests. That is the whole authoring story.

## 6. Widget behaviour

- **Layout:** two panes, side by side on desktop, stacked on mobile. Lesson left, editor right.
- **Run** executes the learner's code alone and shows stdout/stderr. No grading.
- **Submit** executes learner code + hidden tests, catches the first failing assertion,
  shows a clear pass/fail banner.
- **On failure**, offer a button that posts a message into the chat containing the learner's
  code and the exact error. This is the feature. Do not cut it.
- **On pass**, celebrate briefly and offer "next exercise", which just prompts the chat.
- Tests are never shown before submission. After submission, show which assertion failed.
- Attempts counter is visible.

## 7. The cheating problem

The answer key is one message away in the same chat window. Mitigations, in order of value:

1. `solution` is not rendered until 3 failed submissions, then a "show solution" button appears.
2. Hints escalate: hint 1 free, hint 2 after one failure, hint 3 after two.
3. The server's tool description tells the model to hint rather than answer when asked directly.

Accept that a determined learner defeats all of this. That's fine. It's their time.

## 8. Build order

**Phase 0 — the spike that decides everything (do this first, alone, in one sitting).**
Render a minimal widget in Claude desktop that loads Pyodide from a CDN and prints
`sum([1,2,3])`. If the widget CSP blocks the CDN, stop and re-plan: either self-host the
Pyodide wasm from the MCP server's own origin, or declare a wider CSP mode in the widget
metadata. Nothing else is worth writing until this returns `6`.

**Phase 1** — Server scaffold, `render_exercise` tool, static two-pane widget, hardcoded content.

**Phase 2** — CodeMirror editor, Run button, Pyodide in a web worker with a timeout so an
infinite loop can't hang the pane.

**Phase 3** — Submit, hidden test execution, pass/fail banner, first-failure extraction.

**Phase 4** — Post-back-to-chat on failure. Verify the host bridge actually delivers it.

**Phase 5** — Hints, gated solution, attempts counter, mobile stacking.

**Phase 6** — JavaScript support. Polish. README with a one-line install for Claude desktop.

## 9. Known risks

- **CSP / CDN loading.** Phase 0 exists because of this. Highest-variance unknown.
- **Pyodide cold start** is seconds and megabytes. Load it lazily on first Run, show a spinner,
  keep the worker warm between exercises in the same widget instance.
- **Model-authored tests are sometimes wrong.** The learner will occasionally be marked wrong
  while being right. The escape hatch is that they can argue with the tutor in the chat. Make
  the failure message copyable so that argument is easy.
- **Host fragmentation.** Widgets don't render in terminal clients. Degrade to a text-only
  exercise rather than erroring.
- **Untrusted code in the iframe.** It's the learner's own code in their own sandbox, so the
  blast radius is their tab. Still, run it in a worker, not the main thread.

## 10. Definition of done for v1

A user with no account, having run one install command, can type
"teach me Python list comprehensions" into Claude desktop, get a graded exercise inline,
fail it, and receive an explanation of their specific mistake without leaving the chat.

## 11. Open questions to resolve while building

- Does the widget persist across turns, or is a new one rendered per exercise? (Affects whether
  the Pyodide worker can stay warm.)
- Can the widget read conversation context, or must everything arrive as tool arguments?
- Is there a size ceiling on the widget bundle that rules out shipping Pyodide from the server?
