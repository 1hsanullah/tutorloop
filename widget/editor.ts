/** CodeMirror wrapper. Bundled, not loaded from a CDN, so the editor works whatever the host's CSP. */
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { sql, SQLite } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

import type { Language } from "./protocol.js";

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  language: Language;
  dark: boolean;
  onSubmit: () => void;
  onRun: () => void;
}

function languageSupport(language: Language) {
  switch (language) {
    case "python":
      return python();
    case "typescript":
      return javascript({ typescript: true });
    case "sql":
      return sql({ dialect: SQLite, upperCaseKeywords: true });
    default:
      return javascript();
  }
}

export class Editor {
  private readonly view: EditorView;
  private readonly theme = new Compartment();

  constructor(options: EditorOptions) {
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.doc,
        extensions: [
          basicSetup,
          languageSupport(options.language),
          keymap.of([
            { key: "Mod-Enter", preventDefault: true, run: () => (options.onRun(), true) },
            { key: "Mod-Shift-Enter", preventDefault: true, run: () => (options.onSubmit(), true) },
          ]),
          EditorView.lineWrapping,
          this.theme.of(options.dark ? oneDark : []),
        ],
      }),
    });
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  set value(next: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: next },
      selection: { anchor: Math.min(next.length, this.view.state.selection.main.anchor) },
    });
  }

  setDark(dark: boolean): void {
    this.view.dispatch({ effects: this.theme.reconfigure(dark ? oneDark : []) });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
