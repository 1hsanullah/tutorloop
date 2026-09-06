/**
 * A deliberately small Markdown renderer for lesson text.
 *
 * Everything is HTML-escaped before any markup is added, so model-authored content cannot inject
 * elements into the pane — no sanitiser to keep in step, and nothing to strip after the fact.
 * Supports what a lesson actually needs: headings, paragraphs, fenced and inline code, lists,
 * blockquotes, rules, bold, italic and http(s) links.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      const language = fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : "";
      out.push(`<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6); // never emit an <h1> inside a pane
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const numbered = ordered.test(line);
      const marker = numbered ? ordered : bullet;
      const items: string[] = [];
      while (index < lines.length && marker.test(lines[index])) {
        const continuation: string[] = [lines[index].replace(marker, "")];
        index += 1;
        // Fold indented continuation lines into the same item.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !marker.test(lines[index])) {
          continuation.push(lines[index].trim());
          index += 1;
        }
        items.push(`<li>${inline(continuation.join(" "))}</li>`);
      }
      out.push(numbered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^#{1,6}\s/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !bullet.test(lines[index]) &&
      !ordered.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    out.push(`<p>${inline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }

  return out.join("\n");
}

/**
 * Placeholder delimiter for extracted code spans. A control character, so it survives escapeHtml
 * untouched and cannot be confused with anything the model wrote (the input is stripped of it
 * first regardless). Built rather than typed, to keep raw control bytes out of this file.
 */
const MARK = String.fromCharCode(0);
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

/** Inline spans. Code spans are extracted first so their contents are never re-parsed. */
function inline(source: string): string {
  const codeSpans: string[] = [];
  const withPlaceholders = source
    .split(MARK)
    .join("")
    .replace(/`([^`]+)`/g, (_match, code: string) => {
      codeSpans.push(`<code>${escapeHtml(code)}</code>`);
      return `${MARK}${codeSpans.length - 1}${MARK}`;
    });

  const html = escapeHtml(withPlaceholders)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_match, label: string, href: string) =>
        `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1<em>$2</em>");

  return html.replace(MARKED, (_match, id: string) => codeSpans[Number(id)] ?? "");
}
