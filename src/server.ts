#!/usr/bin/env node
/**
 * TutorLoop — MCP server.
 *
 * A thin content pipe: it holds no curriculum and no state. The model authors the lesson,
 * the starter code and the hidden tests, and passes them as tool arguments. Everything
 * interesting (editing, execution, grading) happens in the widget, client-side.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  RESOURCE_MIME_TYPE,
  getUiCapability,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";

import { exerciseSchema, exerciseShape, textFallback } from "./exercise.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = "ui://lesson/exercise.html";

/**
 * Every language runtime is fetched at use time — Pyodide for Python, SQLite for SQL, the
 * TypeScript parser for type erasure — all from this one origin. Both directives are needed:
 * `resourceDomains` for the module scripts and wasm, `connectDomains` for the fetches they make.
 * If a host refuses these, the widget says so in the pane rather than failing silently.
 */
const RUNTIME_CDN = "https://cdn.jsdelivr.net";

const TOOL_DESCRIPTION = `Render a graded coding exercise as an interactive widget in the conversation.

The learner gets a lesson pane and an editor pane with Run and Submit. Submit executes your hidden
tests against their code in the browser and shows a pass/fail verdict. On failure they can push
their exact code and the exact error back into this conversation with one click — that is the point
of this tool, so write tests whose failures are informative.

Call this when someone asks to learn, practise or be quizzed on Python, JavaScript, TypeScript or
SQL. Author everything yourself: there is no curriculum behind this tool.

Rules for good exercises:
- One concept, one answer, solvable in a few minutes.
- 'task_md' must state exactly what is wanted: the function and signature the tests call, or for
  SQL which columns come back and whether row order matters.
- 'starter_code' contains the skeleton and a placeholder, never the answer.
- 'tests' are hidden until submission, and their form differs by language — see the field
  description. Test only what 'task_md' actually asked for; a test the learner could not have
  anticipated is a bug, not a difficulty.
- SQL exercises also need 'seed'. The learner sees the schema, not your reference query.
- Hints escalate: first a nudge, last one close to the answer.

When the learner is stuck or posts a failed attempt back into the chat, explain what THEIR code did
wrong and point at the next hint. Do not hand over the solution on request; that is what the gated
"show solution" button in the widget is for. If they insist after several genuine attempts, walk
them through it rather than pasting it.`;

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "tutorloop", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  const widgetHtml = readFileSync(join(HERE, "widget.html"), "utf-8");

  registerAppResource(
    server,
    "Lesson Exercise",
    WIDGET_URI,
    {
      description: "Two-pane graded coding exercise: lesson on the left, editor and grader on the right.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: { resourceDomains: [RUNTIME_CDN], connectDomains: [RUNTIME_CDN] },
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              csp: { resourceDomains: [RUNTIME_CDN], connectDomains: [RUNTIME_CDN] },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "render_exercise",
    {
      title: "Render a graded coding exercise",
      description: TOOL_DESCRIPTION,
      inputSchema: exerciseShape,
      // No outputSchema on purpose. The result is a verbatim echo of the input, so declaring one
      // tells the model nothing it does not already know, and nothing consumes it — the widget
      // validates the payload itself. It also made hosts compile a second schema, which is how
      // this tool got rejected outright: Claude desktop answered
      //   "invalid outputSchema: JSON Schema declares unsupported dialect (draft-07)".
      // structuredContent is still returned; the spec does not require a schema for it.
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async (args) => {
      const exercise = exerciseSchema.parse(args);
      const uiCapable = getUiCapability(server.server.getClientCapabilities()) !== undefined;

      // Degrade to a text-only exercise rather than erroring on hosts that cannot render widgets.
      const text = uiCapable
        ? `Rendered "${exercise.title}" (${exercise.language}) as an interactive exercise. ` +
          `The learner is working on it now. Wait for them — if they submit a failing attempt it will ` +
          `arrive as a new message containing their code and the error.`
        : textFallback(exercise);

      return {
        content: [{ type: "text", text }],
        structuredContent: exercise,
      };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error("[tutorloop] fatal:", error);
  process.exit(1);
});
