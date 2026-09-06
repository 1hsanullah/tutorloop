/**
 * Shape of the payload the widget expects, plus a tolerant reader for it.
 *
 * The exercise reaches the widget by whichever route the host offers — tool arguments, the tool
 * result's structuredContent, or `window.openai.toolInput` — so this validates rather than trusts,
 * and returns null for anything that is not a usable exercise.
 */
export type { Language } from "./protocol.js";
import type { Language } from "./protocol.js";

export interface Exercise {
  language: Language;
  title: string;
  lessonMd: string;
  taskMd: string;
  starterCode: string;
  /** SQL only: schema and rows created before anything runs. */
  seed: string;
  tests: string;
  hints: string[];
  solution: string;
}

const LANGUAGES: Language[] = ["python", "javascript", "typescript", "sql"];

export function exerciseFrom(payload: unknown): Exercise | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;

  const title = str(raw.title);
  const tests = str(raw.tests);
  const lessonMd = str(raw.lesson_md ?? raw.lessonMd);
  const taskMd = str(raw.task_md ?? raw.taskMd);
  if (!title || !tests || (!lessonMd && !taskMd)) return null;

  const language = LANGUAGES.includes(raw.language as Language) ? (raw.language as Language) : "python";

  return {
    language,
    title,
    lessonMd,
    taskMd,
    starterCode: str(raw.starter_code ?? raw.starterCode),
    seed: str(raw.seed),
    tests,
    hints: Array.isArray(raw.hints) ? raw.hints.map(str).filter(Boolean) : [],
    solution: str(raw.solution),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
