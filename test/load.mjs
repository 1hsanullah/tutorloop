/**
 * Imports a TypeScript module from the widget by bundling it in memory, so tests exercise the real
 * source with no build artifacts to keep in step.
 *
 * Runtime engines (Pyodide, SQLite, the TypeScript type stripper) are imported through computed
 * specifiers, which esbuild cannot resolve and therefore leaves alone — that is what lets a test
 * point them at a local install and stay offline.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function load(entry) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

/** A file:// URL for something inside the repo, for injecting local engine builds. */
export const local = (path) => pathToFileURL(join(root, path)).href;
