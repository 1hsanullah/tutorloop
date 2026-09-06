/**
 * The bridge to whatever is hosting this widget.
 *
 * MCP Apps (SEP-1865) is the primary path — Claude web and desktop, VS Code, Goose, Postman.
 * `window.openai` is the secondary path so the same bundle works inside ChatGPT. When neither is
 * present (a plain browser, or the dev harness), `connect` still resolves and the widget runs
 * standalone; only posting back into a conversation is unavailable, and `canPostToChat` says so.
 */
import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

import { exerciseFrom, type Exercise } from "./exercise-data.js";

interface OpenAiHost {
  toolInput?: unknown;
  toolOutput?: unknown;
  sendFollowUpMessage?: (args: { prompt: string }) => Promise<unknown>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    openai?: OpenAiHost;
  }
}

export type HostKind = "mcp-apps" | "openai" | "standalone";

const HANDSHAKE_TIMEOUT_MS = 3_000;
const HANDSHAKE_ATTEMPTS = 3;

export class Host {
  kind: HostKind = "standalone";
  private app: App | null = null;
  private onExerciseCb: ((exercise: Exercise) => void) | null = null;

  /**
   * True when a failed attempt can actually be pushed back into the conversation. MCP hosts
   * declare this per modality, so ask rather than assume — a host that renders widgets does not
   * necessarily accept messages from them.
   */
  get canPostToChat(): boolean {
    if (this.app) return Boolean(this.app.getHostCapabilities()?.message?.text);
    return Boolean(window.openai?.sendFollowUpMessage);
  }

  onExercise(callback: (exercise: Exercise) => void): void {
    this.onExerciseCb = callback;
  }

  /**
   * Never throws: a host that does not answer the MCP Apps handshake is a degraded mode, not an
   * error. The widget is still usable as an editor and grader without a conversation behind it.
   */
  async connect(): Promise<void> {
    if (window.parent !== window) {
      // The handshake is initiated by the view, so a host that attaches its listener a moment
      // after the frame loads would never see the first attempt. Retry before giving up.
      for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS; attempt += 1) {
        if (await this.connectMcpApps()) return;
      }
    }
    if (this.connectOpenAi()) return;
    this.kind = "standalone";
  }

  private async connectMcpApps(): Promise<boolean> {
    const app = new App(
      { name: "tutorloop", version: "0.1.0" },
      { availableDisplayModes: ["inline", "fullscreen"] },
    );

    app.ontoolinput = ({ arguments: args }) => this.deliver(args);
    app.ontoolresult = (result) => this.deliver(result.structuredContent);
    // The notification's params *are* the changed slice of host context, not a wrapper around it.
    app.onhostcontextchanged = (context) => applyHostContext(context);

    try {
      await app.connect(new PostMessageTransport(window.parent, window.parent), {
        timeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch {
      return false; // not an MCP Apps host, or it never answered
    }

    this.app = app;
    this.kind = "mcp-apps";
    applyHostContext(app.getHostContext());
    return true;
  }

  private connectOpenAi(): boolean {
    const openai = window.openai;
    if (!openai) return false;
    this.kind = "openai";
    this.deliver(openai.toolOutput ?? openai.toolInput);
    window.addEventListener("openai:set_globals", () => {
      this.deliver(window.openai?.toolOutput ?? window.openai?.toolInput);
    });
    return true;
  }

  /**
   * Push a message into the conversation as the learner. This is the feature the whole widget
   * exists for: the failed attempt lands in the chat where the tutor can react to it.
   */
  async postToChat(text: string): Promise<void> {
    if (this.app) {
      await this.app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      return;
    }
    const openai = window.openai;
    if (openai?.sendFollowUpMessage) {
      await openai.sendFollowUpMessage({ prompt: text });
      return;
    }
    throw new Error("this host does not accept messages from widgets");
  }

  private deliver(payload: unknown): void {
    const exercise = exerciseFrom(payload);
    if (exercise && this.onExerciseCb) this.onExerciseCb(exercise);
  }
}

/** Adopt the host's theme, design tokens and web fonts so the pane looks native to it. */
function applyHostContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}
