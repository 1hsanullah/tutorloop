/**
 * Build:
 *   dist/widget.html  — the whole widget as one file: styles, app bundle, and the execution
 *                       worker embedded as a string (a sandboxed MCP app has no origin of its own
 *                       to serve a second file from).
 *   dist/server.js    — the MCP server, which reads widget.html at startup.
 *
 * Only Pyodide is fetched at runtime, from the CDN the server declares in its CSP metadata.
 */
import { context, build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: !process.env.LESSON_WIDGET_DEBUG,
  legalComments: "none",
  logLevel: "warning",
};

async function buildWorker() {
  const result = await build({
    ...shared,
    entryPoints: [join(root, "widget/runner.worker.ts")],
    format: "esm", // module worker: Pyodide 314 refuses to run in a classic one
    write: false,
  });
  return result.outputFiles[0].text;
}

async function buildWidget() {
  const workerSource = await buildWorker();
  const app = await build({
    ...shared,
    entryPoints: [join(root, "widget/main.ts")],
    write: false,
    define: { __WORKER_SOURCE__: JSON.stringify(workerSource) },
  });

  const [template, styles] = await Promise.all([
    readFile(join(root, "widget/index.html"), "utf-8"),
    readFile(join(root, "widget/styles.css"), "utf-8"),
  ]);

  const html = template
    .replace("/* build:styles */", () => styles)
    .replace("/* build:script */", () => app.outputFiles[0].text);

  if (html.includes("build:styles") || html.includes("build:script")) {
    throw new Error("widget/index.html is missing a build placeholder");
  }

  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "widget.html"), html);
  return html.length;
}

async function buildServer() {
  await build({
    ...shared,
    entryPoints: [join(root, "src/server.ts")],
    platform: "node",
    format: "esm",
    minify: false,
    packages: "external",
    outfile: join(dist, "server.js"), // src/server.ts carries its own shebang
  });
}

/** Dev-only MCP Apps host, so the widget can be driven in a plain browser. */
async function buildHarness() {
  await mkdir(join(dist, "dev"), { recursive: true });
  await build({
    ...shared,
    entryPoints: [join(root, "dev/harness.ts")],
    minify: false,
    outfile: join(dist, "dev/harness.js"),
  });
  await copyFile(join(root, "dev/harness.html"), join(dist, "dev/harness.html"));
}

async function once() {
  const started = Date.now();
  const bytes = await buildWidget();
  await buildServer();
  await buildHarness();
  console.log(
    `built dist/widget.html (${(bytes / 1024).toFixed(0)} kB) and dist/server.js in ${
      Date.now() - started
    } ms`,
  );
}

if (watch) {
  await once();
  const watcher = await context({
    ...shared,
    entryPoints: [join(root, "widget/main.ts")],
    write: false,
    plugins: [
      {
        name: "rebuild-everything",
        setup(builder) {
          builder.onEnd(() => once().catch((error) => console.error(error)));
        },
      },
    ],
  });
  await watcher.watch();
  console.log("watching…");
} else {
  await once();
}
