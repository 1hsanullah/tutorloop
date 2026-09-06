/**
 * A minimal MCP Apps host, for developing the widget without a chat client in the loop.
 *
 * It speaks the real protocol (AppBridge over postMessage), so what works here is what works in
 * Claude desktop — including the message the widget pushes back into the conversation, which shows
 * up in the transcript column on the right.
 *
 * Not shipped: `npm run dev:serve` builds and serves it at /dev/harness.html.
 */
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { PostMessageTransport } from "@modelcontextprotocol/ext-apps";

import { SAMPLES } from "./samples.js";

const iframe = document.getElementById("view") as HTMLIFrameElement;
const transcript = document.getElementById("transcript") as HTMLElement;
const picker = document.getElementById("sample") as HTMLSelectElement;
const themeButton = document.getElementById("theme") as HTMLButtonElement;

let theme: "light" | "dark" = "light";
let bridge: AppBridge | null = null;

picker.replaceChildren(
  ...SAMPLES.map((sample, index) => new Option(`${sample.title} (${sample.language})`, String(index))),
);

function log(kind: string, text: string): void {
  const entry = document.createElement("div");
  entry.className = `entry ${kind}`;
  entry.innerHTML = `<div class="kind">${kind}</div><pre></pre>`;
  entry.querySelector("pre")!.textContent = text;
  transcript.prepend(entry);
}

async function mount(): Promise<void> {
  bridge?.close();
  transcript.replaceChildren();

  const host = new AppBridge(
    null,
    { name: "dev-harness", version: "0.1.0" },
    { message: { text: {} }, logging: {} },
  );

  host.onmessage = async ({ content }) => {
    for (const block of content) {
      if (block.type === "text") log("message → chat", block.text);
    }
    return {};
  };

  // Listen before the frame loads: the view initiates the handshake, so a host that attaches
  // late misses it. Real hosts have the same constraint.
  const target = iframe.contentWindow!;
  await host.connect(new PostMessageTransport(target, target));
  bridge = host;

  await new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
    iframe.src = `../widget.html?cachebust=${Date.now()}`;
  });

  // After connect: setHostContext pushes a change notification, which needs a live transport.
  host.setHostContext({ theme, displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] });

  const sample = SAMPLES[Number(picker.value) || 0];
  await host.sendToolInput({ arguments: sample as unknown as Record<string, unknown> });
  await host.sendToolResult({
    content: [{ type: "text", text: `Rendered "${sample.title}".` }],
    structuredContent: sample as unknown as Record<string, unknown>,
  });
  log("tool call", `render_exercise(${sample.title})`);
}

picker.addEventListener("change", () => void mount());

themeButton.addEventListener("click", () => {
  theme = theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === "light" ? "Dark theme" : "Light theme";
  void bridge?.sendHostContextChange({ theme });
});

void mount();
