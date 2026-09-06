/**
 * Static file server for the dev harness: `npm run dev:serve`, then open
 * http://localhost:5173/dev/harness.html. Nothing here ships.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
const port = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
  const file = join(dist, path === "/" ? "dev/harness.html" : path);

  if (!file.startsWith(dist)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log(`dev harness: http://localhost:${port}/dev/harness.html`);
});
