/**
 * TypeScript support, which is really just "erase the types and reuse the JavaScript grader".
 *
 * The tool is `ts-blank-space`, which replaces type syntax with *spaces* rather than deleting it.
 * That detail is the whole reason it was chosen: every remaining character keeps its original line
 * and column, so the line numbers the JavaScript grader reports out of a stack trace point at the
 * learner's TypeScript exactly, with no source map to carry around.
 *
 * It is loaded from the CDN on first use because it parses with the real TypeScript compiler
 * (~1 MB compressed) — far too much to inline into every widget for a feature most exercises
 * do not use.
 */
type Stripper = (source: string, onError?: (node: { pos: number; kind: number }) => void) => string;
type LoadModule = (url: string) => Promise<{ default: Stripper }>;

export interface StripResult {
  code: string;
  /** Set when the source uses TypeScript that cannot simply be erased. */
  error: { message: string; line: number } | null;
}

export function createTypeStripper(loadModule: LoadModule, onStatus: (text: string) => void) {
  let ready: Promise<Stripper> | null = null;

  async function stripper(url: string): Promise<Stripper> {
    if (!ready) {
      ready = (async () => {
        onStatus("Loading the TypeScript compiler (about 1 MB, once per session)…");
        const module = await loadModule(url);
        onStatus("");
        return module.default;
      })().catch((error: unknown) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  return async function strip(source: string, url: string): Promise<StripResult> {
    const blank = await stripper(url);
    let error: StripResult["error"] = null;

    const code = blank(source, (node) => {
      if (error) return; // report only the first
      error = {
        message:
          "This uses TypeScript that has no JavaScript equivalent to erase — `enum`, `namespace`, " +
          "constructor parameter properties or a non-`type` `import =`. Rewrite it in erasable " +
          "TypeScript: a plain object or union instead of `enum`, an explicit field assignment " +
          "instead of a parameter property.",
        line: lineOf(source, node.pos),
      };
    });

    return { code, error };
  };
}

function lineOf(source: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}
