// The detector registry (repo setups, Phase D): every detector, which files the scan reads for them, and how their
// candidates merge into one per app. Pure — src/repo/scan.ts does the reading.
//
//   pickFiles(tree)   ≤ SCAN_FILE_MAX paths to read: the tree's paths a detector's pattern matches, outside the
//                     excluded folders (dependencies, fixtures, tests, examples), at most SCAN_DEPTH_MAX folders deep,
//                     NEAREST THE ROOT FIRST, then by detector order (deploy configs before workflows before
//                     workspace members' package.json), then by path.
//   detectAll(input)  every detector's candidates, merged per folder: a folder's deploy candidates of one kind
//                     become one (the first detector with a host leads; the others' evidence and names join it); a
//                     workspace member's evidence joins its folder's app; a member with no app is a Package.
import type { SuggestionEvidence } from "@shared/repo-scan-core";
import { amplify } from "./amplify";
import { digitalocean } from "./digitalocean";
import { docker } from "./docker";
import { fly } from "./fly";
import { netlify } from "./netlify";
import { procfile } from "./procfile";
import { railway } from "./railway";
import { render } from "./render";
import { vercel } from "./vercel";
import { workspaces } from "./workspaces";
import { wrangler } from "./wrangler";
import { baseOf, type Candidate, type DetectInput, type Detector } from "./types";

export type { Candidate, DetectInput, Detector } from "./types";

/** In priority order: the first that proposes a folder's app leads it. */
export const DETECTORS: readonly Detector[] = [wrangler, vercel, netlify, fly, render, railway, amplify, digitalocean, procfile, docker, workspaces];

/** ONE GraphQL batch reads at most this many files (step 0 confirmed 24 aliases cost 1 point). */
export const SCAN_FILE_MAX = 24;
/** A candidate file at most this many folders deep (`a/b/c/d/file`). */
export const SCAN_DEPTH_MAX = 4;
/** Folders whose files are never read: dependencies, fixtures, tests, examples. */
const EXCLUDED = /(^|\/)(node_modules|vendor|fixtures|__fixtures__|testdata|test|tests|__tests__|examples|example|\.git)(\/|$)/;

/** A path glob → a regex: a leading `**` segment = any folder (or none), `*` = characters of one segment. */
export function globRe(pattern: string): RegExp {
  let p = pattern;
  let prefix = "^";
  if (p.startsWith("**/")) { prefix = "^(?:.*/)?"; p = p.slice(3); }
  const body = p.split("").map((ch) => (ch === "*" ? "[^/]*" : /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch)).join("");
  return new RegExp(`${prefix}${body}$`);
}

const COMPILED = DETECTORS.map((d) => d.patterns.map(globRe));
const depth = (p: string) => p.split("/").length - 1;

/** Is a tree path one the scan may consider at all? */
export const scannable = (path: string): boolean => !EXCLUDED.test(path) && depth(path) <= SCAN_DEPTH_MAX;

/** The detector rank of a path (its first matching detector), or -1. */
const rankOf = (path: string): number => COMPILED.findIndex((res) => res.some((re) => re.test(path)));

/** The ≤ SCAN_FILE_MAX files to read, nearest the root first. */
export function pickFiles(tree: readonly string[]): string[] {
  return tree
    .filter(scannable)
    .map((path) => ({ path, rank: rankOf(path) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => depth(a.path) - depth(b.path) || a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, SCAN_FILE_MAX)
    .map((x) => x.path);
}

/** The file names the registry looks for — the unseen card's "Trov looked for …". */
export function lookedFor(): string[] {
  const names = DETECTORS.flatMap((d) => [...d.patterns.map((p) => (p.startsWith(".github/workflows/") ? ".github/workflows" : p.startsWith(".do/") ? p : baseOf(p))), ...(d.seen ?? [])]);
  return [...new Set(names)];
}

const dedupe = (ev: SuggestionEvidence[]): SuggestionEvidence[] => {
  const seen = new Set<string>();
  return ev.filter((e) => (seen.has(e.text) ? false : (seen.add(e.text), true)));
};

/** Every detector's candidates, merged per folder (see the header). */
export function detectAll(input: DetectInput): Candidate[] {
  const all = DETECTORS.flatMap((d) => {
    try { return d.detect(input); } catch { return []; } // a detector never takes the scan down
  });
  const byFolder = new Map<string, Candidate[]>();
  for (const c of all) byFolder.set(c.folder, [...(byFolder.get(c.folder) ?? []), c]);
  const out: Candidate[] = [];
  for (const [, list] of [...byFolder].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const deploys = list.filter((c) => c.source === "deploy");
    const ws = list.filter((c) => c.source === "workspace");
    if (!deploys.length) {
      if (ws.length) out.push({ ...ws[0], evidence: dedupe(ws.flatMap((c) => c.evidence)) });
      continue;
    }
    for (const kind of [...new Set(deploys.map((c) => c.kind))]) {
      const group = deploys.filter((c) => c.kind === kind);
      const lead = group.find((c) => c.provider !== null) ?? group[0];
      const sameHost = group.filter((c) => c.provider === lead.provider);
      out.push({
        ...lead,
        settings: Object.assign({}, ...sameHost.map((c) => c.settings ?? {}).reverse()),
        names: [...new Set([...group, ...ws].flatMap((c) => c.names ?? []))],
        workflow: group.find((c) => c.workflow)?.workflow,
        usedBy: [],
        evidence: dedupe([...lead.evidence, ...group.filter((c) => c !== lead).flatMap((c) => c.evidence), ...ws.flatMap((c) => c.evidence)]),
      });
    }
  }
  return out;
}
