// Links between doc pages — `[[slug]]` and `[[slug|label]]` — parsed ONCE (zod-free and pure: the SPA
// imports it as a value). The Worker extracts a LIVE body's links on promote to rebuild `doc_links`
// (backlinks read that table); the reader substitutes them into real links (`#doc/<slug>`) before the
// markdown renders, and draws a link to a page that does not exist as flagged text.
//
// Inline code spans and fenced code blocks are never scanned: a page that explains the link syntax is not
// linking. A `[[…]]` whose slug is not a valid doc slug (`DOC_SLUG_RE`, the same rule as
// `DocProposal.slug` in contract.ts — a test holds them together) is plain text, not a link.

/** A doc slug: lowercase letters, digits, `_`, `/`, `-`; starts with a letter or digit. */
export const DOC_SLUG_RE = /^[a-z0-9][a-z0-9_/-]*$/;

export const isDocSlug = (s: string): boolean => DOC_SLUG_RE.test(s);

export interface DocLink {
  slug: string;
  /** The text after `|`, trimmed; null when there is none (or it is empty). */
  label: string | null;
  /** The source text, `[[…]]` included. */
  raw: string;
}

const LINK_RE = /\[\[([^\[\]|\n]*)(?:\|([^\[\]\n]*))?\]\]/g;

export interface CodeSegment { code: boolean; text: string }

/** Split a body into code (fenced blocks, inline code spans) and prose, losslessly — joining every
 *  segment's text gives the body back. The import's link rewrite (docs-import-core) uses it too. */
export function codeSegments(body: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  const push = (code: boolean, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += text;
    else out.push({ code, text });
  };
  const lines = body.split(/(?<=\n)/);   // keep each line's own newline
  let fence: string | null = null;
  let prose = "";
  const flushProse = () => { inlineSegments(prose, push); prose = ""; };
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      push(true, line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && line.slice(f[0].length).includes("`"))) {
      flushProse();
      fence = f[1];
      push(true, line);
      continue;
    }
    prose += line;
  }
  flushProse();
  return out;
}

/** Split prose into inline code spans (a run of N backticks closed by a run of exactly N) and text. */
function inlineSegments(text: string, push: (code: boolean, t: string) => void): void {
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] !== "`") { i++; continue; }
    let j = i;
    while (text[j] === "`") j++;
    const run = j - i;
    // find a closing run of exactly `run` backticks, not across a blank line
    let k = j;
    let close = -1;
    while (k < text.length) {
      if (text[k] === "\n" && /^\n[ \t]*\n/.test(text.slice(k))) break;
      if (text[k] === "`") {
        let m = k;
        while (text[m] === "`") m++;
        if (m - k === run) { close = m; break; }
        k = m;
        continue;
      }
      k++;
    }
    if (close === -1) { i = j; continue; }
    push(false, text.slice(start, i));
    push(true, text.slice(i, close));
    start = i = close;
  }
  push(false, text.slice(start));
}

function parse(m: RegExpMatchArray): DocLink | null {
  const slug = (m[1] ?? "").trim();
  if (!isDocSlug(slug)) return null;
  const label = m[2] === undefined ? null : m[2].trim() || null;
  return { slug, label, raw: m[0] };
}

/** Every `[[…]]` link outside code, in order (repeats included). */
export function findDocLinks(body: string): DocLink[] {
  const out: DocLink[] = [];
  for (const seg of codeSegments(body ?? "")) {
    if (seg.code) continue;
    for (const m of seg.text.matchAll(LINK_RE)) {
      const l = parse(m);
      if (l) out.push(l);
    }
  }
  return out;
}

/** The distinct slugs a body links to, in first-seen order (what `doc_links` holds for the page). */
export function extractDocLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const l of findDocLinks(body)) seen.add(l.slug);
  return [...seen];
}

/** Replace every link outside code with `fn(link)`; code and everything else is left byte for byte. */
export function replaceDocLinks(body: string, fn: (link: DocLink) => string): string {
  return codeSegments(body ?? "")
    .map((seg) => seg.code ? seg.text : seg.text.replace(LINK_RE, (...args) => {
      const l = parse(args as unknown as RegExpMatchArray);
      return l ? fn(l) : (args[0] as string);
    }))
    .join("");
}

/** The source text of a link to `slug` (with `label` when it is given). */
export const docLinkText = (slug: string, label?: string | null): string => (label ? `[[${slug}|${label}]]` : `[[${slug}]]`);
