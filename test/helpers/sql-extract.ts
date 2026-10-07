// The mechanical SQL extractor behind test/data-layer.static.test.ts (canopy-multitenancy.md §4.4).
// It reads SOURCE TEXT — no TypeScript compiler runs in the Workers pool — with a small tokenizer that
// knows comments, strings, template literals (and their `${…}` holes) and regex literals, so a quote
// inside a regex or a keyword inside a comment cannot derail it. For every string literal it records
// where it is, which calls enclose it and which top-level declaration it sits in; the static test
// decides what is SQL and which rules apply.

export interface Literal {
  file: string;
  line: number;
  /** The literal's text; a template hole reads `${<expression source>}`. */
  text: string;
  /** Callee of every open call around the literal, outermost first (`""` for a non-call paren). */
  calls: string[];
  /** The `const NAME = <literal>` (or `const NAME = (…) => <literal>`) this literal is bound to. */
  name: string | null;
  /** The top-level declaration the literal sits in: a function / const name, or `GET /path` for a route. */
  fn: string | null;
}

export interface Scan {
  literals: Literal[];
  /** The source with comments blanked (newlines kept), for the rule-1 text checks. */
  code: string;
  /** Offsets just past each regex literal, so `/x/.exec(…)` is told from a database `.exec(`. */
  regexEnds: Set<number>;
}

const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "yield", "await", "else", "do"]);
const REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";

/** The identifier (dotted) that a `(` at `open` is called on — generics skipped — or "". */
function calleeBefore(src: string, open: number): string {
  let i = open - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (src[i] === ">" && src[i - 1] !== "=") {
    // `first<{ n: number }>(` — walk back over the balanced type arguments.
    let depth = 0;
    const floor = Math.max(0, i - 600);
    for (; i >= floor; i--) {
      if (src[i] === ">" && src[i - 1] !== "=") depth++;
      else if (src[i] === "<") { depth--; if (depth === 0) { i--; break; } }
    }
    if (depth !== 0) return "";
  }
  let end = i + 1;
  while (i >= 0 && /[\w$.]/.test(src[i])) i--;
  const name = src.slice(i + 1, end);
  return /^[A-Za-z_$]/.test(name) ? name : "";
}

/** Top-level declarations by offset: `function f`, `const f`, `class C`, and `app.get("/path"` routes. */
function declarations(src: string): { at: number; name: string }[] {
  const out: { at: number; name: string }[] = [];
  const re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)|^(?:export\s+)?(?:const|let|class)\s+(\w+)|^\w+\.(get|post|put|patch|delete|all|use|on)\(\s*(?:\[[^\]]*\],\s*)?["'`]([^"'`]+)["'`]/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push({ at: m.index, name: m[1] ?? m[2] ?? `${m[3].toUpperCase()} ${m[4]}` });
  }
  return out;
}

export function scanSource(file: string, src: string): Scan {
  const literals: Literal[] = [];
  const regexEnds = new Set<number>();
  const code = src.split("");
  const decls = declarations(src);
  const calls: string[] = [];
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (at: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const fnOf = (at: number): string | null => {
    let name: string | null = null;
    for (const d of decls) { if (d.at <= at) name = d.name; else break; }
    return name;
  };
  const emit = (at: number, text: string) => literals.push({
    file, line: lineOf(at), text, calls: [...calls], fn: fnOf(at),
    name: /(?:const|let|var)\s+(\w+)(?:\s*:[^=;]+)?\s*=\s*(?:\([^()]*\)(?:\s*:\s*[\w<>[\] |]+)?\s*=>\s*)?$/.exec(src.slice(Math.max(0, at - 200), at))?.[1] ?? null,
  });
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " "; };

  /** A quoted string starting at `i`; returns the offset past its closing quote. */
  function quoted(i: number): number {
    const q = src[i];
    let j = i + 1, text = "";
    while (j < src.length && src[j] !== q && src[j] !== "\n") {
      if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; } else text += src[j++];
    }
    emit(i, text);
    return j + 1;
  }

  /** A template literal starting at `i`; nested expressions are scanned as code. */
  function template(i: number): number {
    let j = i + 1, text = "";
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; continue; }
      if (src[j] === "$" && src[j + 1] === "{") {
        const end = scan(j + 2, true);
        text += "${" + src.slice(j + 2, end - 1).trim() + "}";
        j = end;
        continue;
      }
      text += src[j++];
    }
    emit(i, text);
    return j + 1;
  }

  /** Code from `i`; with `inHole`, stops past the `}` that closes a template hole. */
  function scan(i: number, inHole: boolean): number {
    let braces = 0;
    let lastChar = "";
    let lastWord = "";
    while (i < src.length) {
      const ch = src[i];
      if (ch === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        const stop = end === -1 ? src.length : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? src.length : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'") { i = quoted(i); lastChar = '"'; lastWord = ""; continue; }
      if (ch === "`") { i = template(i); lastChar = '"'; lastWord = ""; continue; }
      if (ch === "/" && (lastChar === "" || REGEX_AFTER_CHAR.includes(lastChar) || REGEX_AFTER_WORD.has(lastWord))) {
        let j = i + 1, inClass = false;
        while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
          if (src[j] === "\\") j++;
          else if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          j++;
        }
        j++;
        while (j < src.length && /[a-z]/.test(src[j])) j++;
        regexEnds.add(j);
        i = j;
        lastChar = "/";
        lastWord = "";
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        lastWord = src.slice(i, j);
        lastChar = "a";
        i = j;
        continue;
      }
      if (ch === "(") calls.push(calleeBefore(src, i));
      else if (ch === ")") calls.pop();
      else if (ch === "{") braces++;
      else if (ch === "}") {
        if (inHole && braces === 0) return i + 1;
        braces--;
      }
      if (!/\s/.test(ch)) { lastChar = ch; lastWord = ""; }
      i++;
    }
    return i;
  }

  scan(0, false);
  return { literals, code: code.join(""), regexEnds };
}

// ── what the query surfaces look like in an import list ──────────────────────

export type Surface = "tenant" | "platform";
const SQL_HELPERS = new Set(["first", "all", "run", "stmt", "fanOut"]);

/** Local name → surface, for the SQL-taking helpers a file imports from src/data/sql or src/data/platform-sql. */
export function surfaceImports(file: string, src: string): { helpers: Map<string, Surface>; namespace: string[] } {
  const helpers = new Map<string, Surface>();
  const namespace: string[] = [];
  const inData = file.startsWith("src/data/");
  const surfaceOf = (path: string): Surface | null =>
    /(^|\/)data\/sql$/.test(path) || (inData && path === "./sql") ? "tenant"
      : /(^|\/)data\/platform-sql$/.test(path) || (inData && path === "./platform-sql") ? "platform" : null;
  for (const m of src.matchAll(/import\s+(type\s+)?(\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+"([^"]+)"/g)) {
    const surface = surfaceOf(m[5]);
    if (!surface || m[1]) continue;
    if (m[3]) { namespace.push(m[3]); continue; }
    for (const part of m[4].split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const [name, alias] = spec.split(/\s+as\s+/);
      if (SQL_HELPERS.has(name.trim())) helpers.set((alias ?? name).trim(), surface);
    }
  }
  return { helpers, namespace };
}

/**
 * Which surface runs this literal. In order: the innermost enclosing helper call; the file's only
 * surface; and, in a file that imports BOTH, the surface of wherever a `const NAME = <literal>` is used
 * — as a `${NAME}` hole of another statement, or as the statement argument of a helper call.
 * `null` = the file imports no surface; `"ambiguous"` = a two-surface file and none of that settles it.
 */
export function surfaceOfLiteral(lit: Literal, helpers: Map<string, Surface>, scan: Scan, depth = 0): Surface | "ambiguous" | null {
  for (let i = lit.calls.length - 1; i >= 0; i--) {
    const s = helpers.get(lit.calls[i]);
    if (s) return s;
  }
  const kinds = new Set(helpers.values());
  if (kinds.size === 0) return null;
  if (kinds.size === 1) return [...kinds][0];
  if (!lit.name || depth > 4) return "ambiguous";
  const found = new Set<Surface | "ambiguous" | null>();
  const hole = new RegExp(`\\$\\{[^}]*\\b${lit.name}\\b`);
  for (const user of scan.literals) {
    if (user !== lit && hole.test(user.text)) found.add(surfaceOfLiteral(user, helpers, scan, depth + 1));
  }
  for (const [helper, surface] of helpers) {
    if (new RegExp(`\\b${helper}\\s*(?:<[^;]*?>)?\\(\\s*[\\w.]+\\s*,\\s*${lit.name}\\b`).test(scan.code)) found.add(surface);
  }
  return found.size === 1 ? [...found][0] : "ambiguous";
}
