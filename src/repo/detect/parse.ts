// Tiny, SAFE subset parsers for the config files the repo scan reads (src/repo/scan.ts) — there is no TOML or YAML
// dependency in this Worker and the detectors need only a few keys, so these read the common shapes and give up
// quietly on the rest (never throw, never evaluate anything, bounded input). Pure.
//
//   parseToml   tables `[a.b]`, arrays of tables `[[a]]`, `key = value` with dotted / quoted keys; values: basic and
//               literal strings (single- and multi-line), numbers, booleans, dates (as strings), arrays (multi-line
//               too) and inline tables. Anything it cannot read is skipped, line by line.
//   parseYaml   block mappings and sequences by indentation (`- key: v` items included), plain / quoted scalars,
//               flow sequences `[a, b]`, block scalars `|` / `>` (as text). No anchors, tags or multi-documents:
//               an alias reads as its literal text, a second document is ignored.
//   parseJsonc  JSON with `//` and `/* */` comments and trailing commas (wrangler.jsonc).
//
// A value is `unknown`; the `str` / `arr` / `rec` readers below are how a detector takes what it needs.

/** Inputs larger than this are not parsed at all (a config file is a few KB). */
export const PARSE_MAX_CHARS = 200_000;

export type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const strs = (v: unknown): string[] => arr(v).map(str).filter((s): s is string => s !== null);

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const safeKey = (k: string): boolean => !FORBIDDEN_KEYS.has(k);

// ── JSONC ────────────────────────────────────────────────────────────────────

/** JSON with comments and trailing commas → a value, or null. */
export function parseJsonc(text: string): unknown {
  if (text.length > PARSE_MAX_CHARS) return null;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: `,` followed by only whitespace and a closing bracket (outside strings — strings were copied whole,
  // so re-walk once more on the comment-free text).
  let clean = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    clean += c;
  }
  try { return JSON.parse(clean); } catch { return null; }
}

// ── TOML ─────────────────────────────────────────────────────────────────────

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  get done(): boolean { return this.i >= this.s.length; }
  peek(n = 0): string { return this.s[this.i + n] ?? ""; }
  ws(): void { while (!this.done && (this.peek() === " " || this.peek() === "\t")) this.i++; }
  /** Whitespace, newlines and comments (inside arrays / inline tables). */
  wsnl(): void {
    for (;;) {
      this.ws();
      if (this.peek() === "#") { while (!this.done && this.peek() !== "\n") this.i++; continue; }
      if (this.peek() === "\n" || this.peek() === "\r") { this.i++; continue; }
      return;
    }
  }
  startsWith(t: string): boolean { return this.s.startsWith(t, this.i); }
}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function tomlBasic(c: Cursor, multi: boolean): string | undefined {
  c.i += multi ? 3 : 1;
  if (multi && c.peek() === "\n") c.i++;
  let out = "";
  while (!c.done) {
    if (multi ? c.startsWith('"""') : c.peek() === '"') { c.i += multi ? 3 : 1; return out; }
    const ch = c.peek();
    if (!multi && ch === "\n") return undefined;
    if (ch === "\\") {
      const e = c.peek(1);
      if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = c.s.slice(c.i + 2, c.i + 2 + len);
        const code = /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN;
        if (Number.isFinite(code) && code <= 0x10ffff) out += String.fromCodePoint(code);
        c.i += 2 + len;
        continue;
      }
      if (multi && (e === "\n" || e === " " || e === "\r")) { c.i++; while (!c.done && /\s/.test(c.peek())) c.i++; continue; }
      out += ESCAPES[e] ?? e;
      c.i += 2;
      continue;
    }
    out += ch;
    c.i++;
  }
  return undefined;
}

function tomlLiteral(c: Cursor, multi: boolean): string | undefined {
  c.i += multi ? 3 : 1;
  if (multi && c.peek() === "\n") c.i++;
  const close = multi ? "'''" : "'";
  const end = c.s.indexOf(close, c.i);
  if (end < 0) return undefined;
  const v = c.s.slice(c.i, end);
  if (!multi && v.includes("\n")) return undefined;
  c.i = end + close.length;
  return v;
}

function tomlKey(c: Cursor): string[] | undefined {
  const parts: string[] = [];
  for (;;) {
    c.ws();
    let k: string | undefined;
    if (c.peek() === '"') k = tomlBasic(c, false);
    else if (c.peek() === "'") k = tomlLiteral(c, false);
    else {
      const m = /^[A-Za-z0-9_-]+/.exec(c.s.slice(c.i, c.i + 200));
      if (!m) return undefined;
      k = m[0];
      c.i += k.length;
    }
    if (k === undefined || !safeKey(k)) return undefined;
    parts.push(k);
    c.ws();
    if (c.peek() !== ".") return parts;
    c.i++;
  }
}

function tomlValue(c: Cursor, depth: number): unknown {
  if (depth > 20) return undefined;
  c.ws();
  if (c.startsWith('"""')) return tomlBasic(c, true);
  if (c.startsWith("'''")) return tomlLiteral(c, true);
  if (c.peek() === '"') return tomlBasic(c, false);
  if (c.peek() === "'") return tomlLiteral(c, false);
  if (c.peek() === "[") {
    c.i++;
    const out: unknown[] = [];
    for (;;) {
      c.wsnl();
      if (c.peek() === "]") { c.i++; return out; }
      if (c.done) return undefined;
      const v = tomlValue(c, depth + 1);
      if (v === undefined) return undefined;
      out.push(v);
      c.wsnl();
      if (c.peek() === ",") { c.i++; continue; }
      if (c.peek() === "]") { c.i++; return out; }
      return undefined;
    }
  }
  if (c.peek() === "{") {
    c.i++;
    const out: Rec = {};
    for (;;) {
      c.wsnl();
      if (c.peek() === "}") { c.i++; return out; }
      const key = tomlKey(c);
      if (!key) return undefined;
      c.ws();
      if (c.peek() !== "=") return undefined;
      c.i++;
      const v = tomlValue(c, depth + 1);
      if (v === undefined) return undefined;
      setPath(out, key, v);
      c.wsnl();
      if (c.peek() === ",") { c.i++; continue; }
      if (c.peek() === "}") { c.i++; return out; }
      return undefined;
    }
  }
  const m = /^[^\s,\]}#]+/.exec(c.s.slice(c.i, c.i + 200));
  if (!m) return undefined;
  c.i += m[0].length;
  const raw = m[0];
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
  return raw; // a date, a time, inf / nan, a hex number — kept as its text
}

function setPath(root: Rec, path: string[], value: unknown): void {
  let at: Rec = root;
  for (const k of path.slice(0, -1)) {
    const next = rec(at[k]) ?? (Array.isArray(at[k]) ? rec((at[k] as unknown[])[(at[k] as unknown[]).length - 1]) : null);
    if (next) { at = next; continue; }
    const made: Rec = {};
    at[k] = made;
    at = made;
  }
  at[path[path.length - 1]] = value;
}

/** A TOML document → a nested object. Lines it cannot read are skipped. */
export function parseToml(text: string): Rec {
  const root: Rec = {};
  if (text.length > PARSE_MAX_CHARS) return root;
  const c = new Cursor(text.replace(/\r\n/g, "\n"));
  let table: Rec = root;
  const skipLine = () => { while (!c.done && c.peek() !== "\n") c.i++; };
  while (!c.done) {
    c.wsnl();
    if (c.done) break;
    if (c.peek() === "[") {
      const isArray = c.peek(1) === "[";
      c.i += isArray ? 2 : 1;
      const key = tomlKey(c);
      c.ws();
      if (!key || !c.startsWith(isArray ? "]]" : "]")) { skipLine(); table = {}; continue; }
      c.i += isArray ? 2 : 1;
      // Walk to the parent, creating tables (the last element of an array of tables stands for it).
      let at: Rec = root;
      for (const k of key.slice(0, -1)) {
        const cur = at[k];
        if (Array.isArray(cur)) { at = rec(cur[cur.length - 1]) ?? {}; continue; }
        const next = rec(cur) ?? {};
        at[k] = next;
        at = next;
      }
      const last = key[key.length - 1];
      if (isArray) {
        const list = Array.isArray(at[last]) ? (at[last] as unknown[]) : [];
        const t: Rec = {};
        list.push(t);
        at[last] = list;
        table = t;
      } else {
        const t = rec(at[last]) ?? {};
        at[last] = t;
        table = t;
      }
      skipLine();
      continue;
    }
    const start = c.i;
    const key = tomlKey(c);
    c.ws();
    if (!key || c.peek() !== "=") { c.i = start; skipLine(); continue; }
    c.i++;
    const v = tomlValue(c, 0);
    if (v === undefined) { skipLine(); continue; }
    setPath(table, key, v);
    skipLine();
  }
  return root;
}

// ── YAML (subset) ────────────────────────────────────────────────────────────

interface Line { indent: number; text: string; raw: string }

/** Strip a `#` comment that is not inside quotes (a `#` must follow whitespace or start the text). */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q && s[i - 1] !== "\\") q = null; continue; }
    if (ch === '"' || ch === "'") { if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function yamlScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, e: string) => (e === "n" ? "\n" : e === "t" ? "\t" : e));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => yamlScalar(x)) : [];
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const out: Rec = {};
    for (const pair of s.slice(1, -1).split(",")) {
      const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(pair);
      if (m && safeKey(m[1])) out[String(yamlScalar(m[1]))] = yamlScalar(m[2]);
    }
    return out;
  }
  if (s === "true" || s === "True") return true;
  if (s === "false" || s === "False") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** `key: value` → [key, rest] — the key plain or quoted; null when the text is not a mapping entry. */
function splitKey(text: string): [string, string] | null {
  let key: string;
  let rest: string;
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = text.indexOf(text[0], 1);
    if (end < 0) return null;
    key = text.slice(1, end);
    rest = text.slice(end + 1);
    if (!rest.startsWith(":")) return null;
    rest = rest.slice(1);
  } else {
    const m = /^([^:#[\]{}]+?):(?:\s|$)/.exec(text);
    if (!m) return null;
    key = m[1].trim();
    rest = text.slice(m[1].length + 1);
  }
  if (!safeKey(key)) return null;
  return [key, rest.trim()];
}

class YamlReader {
  pos = 0;
  constructor(readonly lines: Line[]) {}

  /** The block of lines starting at `pos` with indent ≥ `indent`. */
  block(indent: number, depth: number): unknown {
    if (depth > 30 || this.pos >= this.lines.length) return null;
    const first = this.lines[this.pos];
    if (first.indent < indent) return null;
    return first.text === "-" || first.text.startsWith("- ") ? this.seq(first.indent, depth) : this.map(first.indent, depth);
  }

  seq(indent: number, depth: number): unknown[] {
    const out: unknown[] = [];
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos];
      if (l.indent !== indent || !(l.text === "-" || l.text.startsWith("- "))) break;
      const content = l.text === "-" ? "" : l.text.slice(2).trim();
      if (!content) { this.pos++; out.push(this.block(indent + 1, depth + 1)); continue; }
      // `- key: value` — a mapping whose first key sits at the item's content column.
      const col = indent + (l.text.length - l.text.slice(1).trimStart().length);
      if (splitKey(content)) {
        this.lines[this.pos] = { indent: col, text: content, raw: l.raw };
        out.push(this.map(col, depth + 1));
        continue;
      }
      this.pos++;
      out.push(yamlScalar(content));
    }
    return out;
  }

  map(indent: number, depth: number): Rec {
    const out: Rec = {};
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos];
      if (l.indent !== indent) break;
      const kv = splitKey(l.text);
      if (!kv) break;
      this.pos++;
      const [key, rest] = kv;
      if (/^[|>][+-]?\d*$/.test(rest)) {
        const parts: string[] = [];
        while (this.pos < this.lines.length && this.lines[this.pos].indent > indent) parts.push(this.lines[this.pos++].raw.trim());
        out[key] = parts.join(rest.startsWith(">") ? " " : "\n");
        continue;
      }
      if (rest === "") {
        const next = this.lines[this.pos];
        if (next && (next.indent > indent || (next.indent === indent && (next.text === "-" || next.text.startsWith("- "))))) {
          out[key] = this.block(next.indent, depth + 1);
        } else out[key] = null;
        continue;
      }
      out[key] = yamlScalar(rest);
    }
    return out;
  }
}

/** A YAML document (the subset above) → a value, or null. */
export function parseYaml(text: string): unknown {
  if (text.length > PARSE_MAX_CHARS) return null;
  const lines: Line[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("---") && lines.length) break; // a second document
    if (raw.startsWith("---") || raw.startsWith("%")) continue;
    if (raw.includes("\t") && /^\t/.test(raw)) return null; // tab indentation is not YAML
    const text2 = stripComment(raw);
    if (!text2.trim()) continue;
    lines.push({ indent: text2.length - text2.trimStart().length, text: text2.trim(), raw });
  }
  if (!lines.length) return null;
  try { return new YamlReader(lines).block(0, 0); } catch { return null; }
}
