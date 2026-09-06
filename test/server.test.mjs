/**
 * Drives the built server over a real stdio transport with the MCP client SDK: the tool and
 * resource have to be usable by an actual client, not just registered.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Ajv2020 from "ajv/dist/2020.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const UI_MIME = "text/html;profile=mcp-app";

const EXERCISE = {
  language: "python",
  title: "f-strings: formatting numbers",
  lesson_md: "An f-string interpolates values.",
  task_md: "Write `format_price(x)`.",
  starter_code: "def format_price(x):\n    pass\n",
  tests: 'assert format_price(10) == "$10.00"\nassert format_price(0) == "$0.00"\n',
  hints: ["Try a format spec."],
  solution: 'def format_price(x):\n    return f"${x:.2f}"\n',
};

/** Connect as a client that advertises MCP Apps support, or one that does not. */
async function connect({ ui }) {
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: ui ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } } } : {} },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist/server.js")],
      stderr: "ignore",
    }),
  );
  return client;
}

let uiClient;

before(async () => {
  uiClient = await connect({ ui: true });
});

after(async () => {
  await uiClient?.close();
});

test("exposes exactly one tool, pointing at the widget resource", async () => {
  const { tools } = await uiClient.listTools();
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "render_exercise");
  assert.equal(tool._meta?.ui?.resourceUri, "ui://lesson/exercise.html");
  // Legacy key too, for hosts that predate _meta.ui.
  assert.equal(tool._meta?.["ui/resourceUri"], "ui://lesson/exercise.html");
  assert.ok(tool.description.includes("are hidden until submission"));
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
    "hints",
    "language",
    "lesson_md",
    "seed",
    "solution",
    "starter_code",
    "task_md",
    "tests",
    "title",
  ]);
  assert.deepEqual(tool.inputSchema.properties.language.enum, ["python", "javascript", "typescript", "sql"]);
});

test("publishes no schema a host cannot compile", async () => {
  const { tools } = await uiClient.listTools();
  // Hosts compile a tool's outputSchema with a 2020-12-only Ajv and reject the whole tool if it
  // will not compile. The SDK stamps zod-generated schemas as draft-07, which such a validator
  // refuses outright — Claude desktop answered "invalid outputSchema: JSON Schema declares
  // unsupported dialect". Nothing here needs an output schema, so nothing declares one.
  for (const tool of tools) {
    if (tool.outputSchema === undefined) continue;
    assert.doesNotThrow(
      () => new Ajv2020({ strict: false }).compile(tool.outputSchema),
      `${tool.name}'s outputSchema must compile under the validator hosts use`,
    );
  }
});

test("serves the widget as a self-contained MCP app resource", async () => {
  const result = await uiClient.readResource({ uri: "ui://lesson/exercise.html" });
  const [content] = result.contents;
  assert.equal(content.mimeType, UI_MIME);
  assert.ok(content.text.startsWith("<!doctype html>"));
  assert.ok(content.text.length > 100_000, "the bundle should be inlined, not linked");
  assert.ok(!/<script[^>]+src=/.test(content.text), "no external scripts may be referenced");

  // Pyodide is the one runtime download, so its origin must be declared in both directives.
  const csp = content._meta?.ui?.csp;
  assert.deepEqual(csp?.resourceDomains, ["https://cdn.jsdelivr.net"]);
  assert.deepEqual(csp?.connectDomains, ["https://cdn.jsdelivr.net"]);
});

test("render_exercise returns the exercise as structured content", async () => {
  const result = await uiClient.callTool({ name: "render_exercise", arguments: EXERCISE });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { ...EXERCISE, seed: "" });
  assert.match(result.content[0].text, /Rendered "f-strings: formatting numbers"/);
  // The model is told to wait rather than to grade the attempt itself.
  assert.match(result.content[0].text, /Wait for them/);
});

test("render_exercise refuses an exercise with no tests", async () => {
  const result = await uiClient.callTool({ name: "render_exercise", arguments: { ...EXERCISE, tests: "" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tests/i);
});

test("degrades to a text exercise for hosts that cannot render widgets", async () => {
  const plain = await connect({ ui: false });
  try {
    const result = await plain.callTool({ name: "render_exercise", arguments: EXERCISE });
    const text = result.content[0].text;
    assert.match(text, /# f-strings: formatting numbers/);
    assert.match(text, /## Your task/);
    assert.match(text, /def format_price/);
    assert.match(text, /cannot render the interactive widget/);
    assert.ok(!text.includes('== "\\$10.00"'), "hidden tests must not leak into the fallback");
  } finally {
    await plain.close();
  }
});
