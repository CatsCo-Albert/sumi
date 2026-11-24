/**
 * Pure markdown outline logic — extract ATX (`#`-style) headings, skipping
 * fenced code blocks. Line numbers are 1-based (CodeMirror convention).
 */

export interface Heading {
  /** 1–6 */
  level: number;
  /** Heading text with closing hashes and inline marks stripped. */
  text: string;
  /** 1-based line number in the document. */
  line: number;
}

/** Strip common inline markdown for display: bold/italic/code/strike/links. */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url), ![alt](url)
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/**
 * Extract `#`-style headings. A heading is a line whose first non-blank
 * characters (up to 3 leading spaces) are 1–6 `#` followed by whitespace or
 * EOL. Lines inside fenced code blocks (``` or ~~~) are ignored.
 */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceChar = "`";
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const run = fence[1];
      const ch = run[0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = run.length;
      } else if (ch === fenceChar && run.length >= fenceLen) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m =
      line.match(/^\s{0,3}(#{1,6})(\s+.*)$/) ||
      line.match(/^\s{0,3}(#{1,6})\s*$/);
    if (!m) continue;
    const level = m[1].length;
    let text = (m[2] || "").trim();
    text = text.replace(/\s+#+\s*$/, ""); // closing hash run
    headings.push({ level, text: stripInline(text), line: i + 1 });
  }
  return headings;
}

/**
 * Heading that contains a given 1-based cursor line — the last heading at or
 * above `line`. Returns null when the cursor sits above the first heading.
 */
export function headingForLine(
  headings: Heading[],
  line: number
): Heading | null {
  let current: Heading | null = null;
  for (const h of headings) {
    if (h.line <= line) current = h;
    else break;
  }
  return current;
}
