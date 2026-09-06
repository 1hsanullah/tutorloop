/**
 * Owns the execution worker: spawns it, watchdogs it, replaces it when it has to be killed.
 *
 * Two things can hang a pane. A runaway loop is normally stopped inside the language (Python's
 * tracing deadline), but if that fails the watchdog terminates the worker outright — which is why
 * the worker is disposable and respawned lazily rather than held for the life of the widget.
 *
 * If the host's CSP refuses blob: workers, everything falls back to the main thread. Grading still
 * works; only the hard kill is lost, which `degraded` reports so the UI can say so.
 */
import { createRunner } from "./runner.js";
import type { ExecResult, Language, Mode, WorkerRequest, WorkerResponse } from "./protocol.js";
import { ENGINE_URLS, TIMEOUT_MS } from "./protocol.js";

declare const __WORKER_SOURCE__: string;

const WATCHDOG_GRACE_MS = 4_000;

export interface ExecOptions {
  mode: Mode;
  language: Language;
  code: string;
  tests: string;
  /** SQL only: the schema and rows created before anything runs. */
  seed?: string;
}

export class RunnerClient {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private mainThread: ReturnType<typeof createRunner> | null = null;
  private nextId = 1;
  /** True once we have given up on workers and are executing on the main thread. */
  degraded = false;

  constructor(private readonly onStatus: (text: string) => void) {}

  async exec(options: ExecOptions): Promise<ExecResult> {
    const request: WorkerRequest = {
      type: "exec",
      id: this.nextId++,
      engines: ENGINE_URLS,
      timeoutMs: TIMEOUT_MS,
      seed: "",
      ...options,
    };

    const worker = this.ensureWorker();
    if (!worker) return this.execOnMainThread(request);

    return new Promise<ExecResult>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        cleanup();
        this.killWorker();
        resolve(timedOut(request.mode));
      }, request.timeoutMs + WATCHDOG_GRACE_MS);

      const cleanup = (): void => {
        clearTimeout(watchdog);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };

      const onMessage = (event: MessageEvent<WorkerResponse>): void => {
        const message = event.data;
        if (message.type === "status") {
          this.onStatus(message.text);
          return;
        }
        if (message.id !== request.id) return;
        cleanup();
        this.onStatus("");
        if (message.type === "result") resolve(message.result);
        else reject(new Error(message.message));
      };

      const onError = (event: ErrorEvent): void => {
        cleanup();
        this.killWorker();
        reject(new Error(event.message || "the execution worker crashed"));
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(request);
    });
  }

/**
   * Start the runtime before the learner presses anything, so the first Run is not a cold start.
   * For SQL this doubles as the schema request the lesson pane needs, so it returns the result.
   */
  prewarm(language: Language, seed = ""): Promise<ExecResult> | null {
    if (language === "sql") {
      return this.exec({ mode: "schema", language, code: "", tests: "", seed });
    }
    if (language === "python") {
      void this.exec({ mode: "run", language, code: "", tests: "" }).catch(() => {
        /* surfaced on the first real run instead */
      });
    }
    return null;
  }

  dispose(): void {
    this.killWorker();
  }

  private ensureWorker(): Worker | null {
    if (this.degraded) return null;
    if (this.worker) return this.worker;
    try {
      const blob = new Blob([__WORKER_SOURCE__], { type: "text/javascript" });
      this.workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.workerUrl, { type: "module" });
      return this.worker;
    } catch {
      // Host CSP blocks blob: workers. Keep going on the main thread.
      this.degraded = true;
      this.worker = null;
      return null;
    }
  }

  private killWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
  }

  private async execOnMainThread(request: WorkerRequest): Promise<ExecResult> {
    this.mainThread ??= createRunner(this.onStatus);
    try {
      return await this.mainThread(request);
    } finally {
      this.onStatus("");
    }
  }
}

function timedOut(mode: Mode): ExecResult {
  return {
    stdout: "",
    stderr: "",
    passed: mode === "submit" ? false : null,
    failure: {
      kind: "timeout",
      where: "code",
      message: "Timed out: your code ran longer than the time limit. Look for a loop that never ends.",
      line: null,
      source: null,
      testLine: null,
      testSource: null,
      traceback: "",
    },
    durationMs: TIMEOUT_MS,
  };
}
