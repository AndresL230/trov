// An app's watch paths (`repo_apps.watch`, a JSON list of path globs — the app's folder by default): which changed
// files count as the app's. Pure. Used by the not-shipped arm (./facts-compute.ts) to keep a multi-app repository's
// commits to the ones that touch the app; Phase E's per-commit paths read it too.
//
//   "/", "", ".", "**"   the whole repository
//   "apps/web"           that path and everything under it (a folder, or one file)
//   "apps/*/src/**"      `*` one path segment (no `/`), `**` any number of segments, `?` one character —
//                        and, like a folder, anything under what it matches
// Leading and trailing slashes are ignored on both sides.

const trim = (s: string): string => s.trim().replace(/^\/+|\/+$/g, "");

const toRegex = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
    else if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
};

/** Does `path` (a file in the repository) fall under any of `globs`? */
export function matchesWatch(path: string, globs: readonly string[]): boolean {
  const p = trim(path);
  for (const raw of globs) {
    const g = trim(raw);
    if (g === "" || g === "." || g === "**") return true;
    if (!/[*?]/.test(g)) {
      if (p === g || p.startsWith(`${g}/`)) return true;
    } else if (toRegex(g).test(p)) return true;
  }
  return false;
}
