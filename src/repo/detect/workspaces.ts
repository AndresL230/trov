// Workspaces — the members of a monorepo: pnpm-workspace.yaml `packages`, package.json `workspaces` (a list, or
// `{ packages }`), lerna.json `packages`, go.work `use`, Cargo.toml `[workspace] members`. A member is a folder the
// tree shows with its own manifest (package.json / go.mod / Cargo.toml) that a member glob matches.
//   - a member WITH a deploy configuration of its own (a file another detector reads, or a Dockerfile) is an app —
//     that detector proposes it; this one only adds "workspace package <name>" to its evidence (`source: workspace`,
//     merged in ./index.ts);
//   - a member WITHOUT one is a Package, `usedBy` = the members whose package.json depends on its name (only what
//     the scan read; a member whose manifest was not read adds nothing — never guessed).
import { parseJsonc, parseToml, parseYaml, rec, str, strs, type Rec } from "./parse";
import { baseOf, folderOf, inFolder, type Candidate, type Detector, type DetectInput } from "./types";

/** Files whose presence in a member's folder makes it deployable on its own. */
export const DEPLOY_FILES = [
  "wrangler.toml", "wrangler.json", "wrangler.jsonc", "vercel.json", "netlify.toml", "fly.toml", "railway.json", "railway.toml",
  "amplify.yml", "amplify.yaml", "Procfile", "Dockerfile",
];
const MANIFESTS = ["package.json", "go.mod", "Cargo.toml"];

/** A workspace glob (`apps/*`, `packages/**`, `./svc/api`) as a folder matcher. */
export function folderGlob(glob: string): RegExp | null {
  const g = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!g || g.startsWith("!") || g.includes("..")) return null;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; continue; }
    if (ch === "*") { re += "[^/]*"; continue; }
    re += /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}

const depsOf = (pkg: Rec): string[] =>
  ["dependencies", "devDependencies", "peerDependencies"].flatMap((k) => Object.keys(rec(pkg[k]) ?? {}));

function globsOf(input: DetectInput): { js: string[]; go: string[]; cargo: string[]; from: string } | null {
  const js: string[] = [];
  let from = "";
  const pnpm = input.files.get("pnpm-workspace.yaml") ?? input.files.get("pnpm-workspace.yml");
  if (pnpm !== undefined) { js.push(...strs(rec(parseYaml(pnpm))?.packages)); from ||= "pnpm-workspace.yaml"; }
  const rootPkg = input.files.get("package.json");
  if (rootPkg !== undefined) {
    const ws = rec(parseJsonc(rootPkg))?.workspaces;
    const list = Array.isArray(ws) ? strs(ws) : strs(rec(ws)?.packages);
    if (list.length) { js.push(...list); from ||= "package.json workspaces"; }
  }
  const lerna = input.files.get("lerna.json");
  if (lerna !== undefined) { const l = strs(rec(parseJsonc(lerna))?.packages); if (l.length) { js.push(...l); from ||= "lerna.json"; } }
  const go: string[] = [];
  const gowork = input.files.get("go.work");
  if (gowork !== undefined) {
    const block = /use\s*\(([^)]*)\)/m.exec(gowork)?.[1];
    for (const line of (block ?? "").split("\n")) { const d = line.replace(/\/\/.*$/, "").trim(); if (d) go.push(d); }
    for (const m of gowork.matchAll(/^use\s+([^\s(]+)\s*$/gm)) go.push(m[1]);
    if (go.length) from ||= "go.work";
  }
  const cargoText = input.files.get("Cargo.toml");
  const cargo = cargoText !== undefined ? strs(rec(parseToml(cargoText).workspace)?.members) : [];
  if (cargo.length) from ||= "Cargo.toml workspace";
  return js.length || go.length || cargo.length ? { js, go, cargo, from } : null;
}

export const workspaces: Detector = {
  id: "workspaces",
  // The root manifests first; members' package.json too (names and dependencies, for usedBy).
  patterns: ["package.json", "pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json", "go.work", "Cargo.toml", "**/package.json"],
  detect(input) {
    const globs = globsOf(input);
    if (!globs) return [];
    const byManifest = (names: string[], pats: string[]): string[] => {
      const res = pats.map(folderGlob).filter((r): r is RegExp => r !== null);
      return [...new Set(input.tree.filter((p) => names.includes(baseOf(p)) && p.includes("/")).map(folderOf))]
        .filter((f) => res.some((r) => r.test(f)));
    };
    const members = [...new Set([
      ...byManifest(["package.json"], globs.js), ...byManifest(["go.mod"], globs.go), ...byManifest(["Cargo.toml"], globs.cargo),
    ])].sort();
    const treeSet = new Set(input.tree);
    // Each member's package.json, when the scan read it: its name and what it depends on.
    const pkgs = new Map<string, { name: string | null; deps: string[] }>();
    for (const f of members) {
      const text = input.files.get(inFolder(f, "package.json"));
      const pkg = text !== undefined ? rec(parseJsonc(text)) : null;
      if (pkg) pkgs.set(f, { name: str(pkg.name), deps: depsOf(pkg) });
    }
    const out: Candidate[] = [];
    for (const folder of members) {
      const name = pkgs.get(folder)?.name ?? null;
      const manifest = MANIFESTS.find((m) => treeSet.has(inFolder(folder, m))) ?? "package.json";
      const deployable = DEPLOY_FILES.some((f) => treeSet.has(inFolder(folder, f)));
      const label = name ?? folder;
      const usedBy = name ? members.filter((m) => m !== folder && pkgs.get(m)?.deps.includes(name)) : [];
      if (deployable) {
        // Its deploy detector proposes the app; this evidence joins it (./index.ts). Left alone (a Dockerfile no
        // workflow deploys), it stays a Package.
        out.push({ folder, kind: "Package", provider: null, source: "workspace", names: name ? [name] : [], usedBy, evidence: [{ kind: "workspace", text: `workspace package ${label} (${globs.from})` }] });
        continue;
      }
      const used = usedBy.length ? ` · used by ${usedBy.length === 1 ? usedBy[0] : `${usedBy.slice(0, -1).join(", ")} and ${usedBy[usedBy.length - 1]}`}` : "";
      out.push({
        folder, kind: "Package", provider: null, source: "workspace", names: name ? [name] : [], usedBy,
        evidence: [{ kind: "workspace", text: `from ${inFolder(folder, manifest)}${used}` }],
      });
    }
    return out;
  },
};
