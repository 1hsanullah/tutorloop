/// <reference lib="webworker" />
/**
 * Worker entry point. Bundled as an ES module (Pyodide 314 refuses classic workers) and embedded
 * in the widget as a string, because a sandboxed MCP app has no origin of its own to serve a
 * second file from.
 */
import { createRunner } from "./runner.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

const post = (message: WorkerResponse): void => self.postMessage(message);

const runner = createRunner((text) => post({ type: "status", text }));

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    post({ type: "result", id: request.id, result: await runner(request) });
  } catch (error) {
    post({
      type: "fatal",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
