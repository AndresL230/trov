// Seen signals → candidates, by TOKEN RULES on normalised names (repo setups, Phase D). Pure; no model, no fuzzy score.
//
// A signal's name is read as the host spells it (step 0, real formats):
//   Vercel     `Production – <project>` / `Preview – <project>` (U+2013 EN DASH)       → env word + service
//   Railway    `<service> / <environment>`                                              → service + env word
//   Render     `<branch> - <service>` (ASCII hyphen-minus)                              → env hint (a branch) + service
//   Netlify    `netlify/<site>/deploy-preview` (a commit status)                        → service
//   a check    `Render – api`, `Workers Builds: web`, `Vercel – web`                    → service
//   "<service> (Production)"                                                           → service + env word
//   a workflow `.github/workflows/deploy-jobs.yml`                                      → service `deploy-jobs`
// then lower-cased and split on non-alphanumerics into tokens.
//
// A candidate MATCHES a signal when the signal's service tokens contain the candidate's folder's last segment (its
// tokens, in order — `storefront-web` ↔ `apps/web`; the repository's name for an app at the root), or equal the
// tokens of a name the host knows it by (a Worker name, a Fly.io app). EXACTLY ONE candidate per signal: a signal
// two candidates match matches neither (ambiguous → no match). Packages never match (they are not deployed).
import type { SeenSignal } from "@shared/repo-scan-core";
import type { RepoEnvConfig } from "../config";
import type { Candidate } from "./types";

export interface ParsedSignal {
  /** The service / project / site part of the name, as tokens. */
  tokens: string[];
  /** The environment the name names — a word (`production`, `staging`) or a branch (Render) — when it names one. */
  envHint: string | null;
}

export const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const HOST_PREFIX = /^(render|vercel|netlify|railway|fly(?:\.io)?|workers builds|cloudflare pages|cloudflare workers)\s*(?:[–—:]|\s-\s)\s*/i;

/** A signal's name → its service tokens and the environment it names. */
export function parseSignalName(sig: Pick<SeenSignal, "kind" | "name" | "source">): ParsedSignal {
  let name = sig.name.trim();
  if (sig.kind === "workflow") {
    const file = (sig.source ?? name).replace(/^.*\//, "").replace(/\.ya?ml$/i, "");
    return { tokens: tokens(file), envHint: null };
  }
  if (/^(render|vercel|netlify|railway|fly(?:\.io)?|workers builds|cloudflare pages|cloudflare workers)$/i.test(name)) return { tokens: [], envHint: null }; // a host alone names no service
  const netlify = /^netlify\/([^/]+)\/(deploy-preview|production|branch-deploy)?/i.exec(name);
  if (netlify) return { tokens: tokens(netlify[1]), envHint: netlify[2]?.toLowerCase() === "deploy-preview" ? "preview" : null };
  let m = /^(production|preview)\s*[–—]\s*(.+)$/i.exec(name) ?? /^(production|preview)\s+-\s+(.+)$/i.exec(name);
  if (m) return { tokens: tokens(m[2]), envHint: m[1].toLowerCase() };
  m = /^(.+?)\s+\/\s+([^/]+)$/.exec(name);
  if (m) return { tokens: tokens(m[1]), envHint: m[2].trim().toLowerCase() };
  m = /^(.+?)\s*\(([A-Za-z0-9 _-]+)\)$/.exec(name);
  if (m) return { tokens: tokens(m[1]), envHint: m[2].trim().toLowerCase() };
  const hosted = HOST_PREFIX.exec(name);
  if (hosted) return { tokens: tokens(name.slice(hosted[0].length)), envHint: null };
  m = /^(\S+)\s+-\s+(.+)$/.exec(name);
  if (m) return { tokens: tokens(m[2]), envHint: m[1].toLowerCase() };
  name = name.replace(HOST_PREFIX, "");
  return { tokens: tokens(name), envHint: null };
}

/** Does `hay` contain `needle` as a contiguous run? */
const containsRun = (hay: readonly string[], needle: readonly string[]): boolean => {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((t, j) => hay[i + j] === t)) return true;
  return false;
};

const sameTokens = (a: readonly string[], b: readonly string[]) => a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);

/** The folder's last segment as tokens; the repository's name for the root. */
export const folderTokens = (folder: string, repo: string): string[] =>
  tokens(folder === "/" ? repo.split("/").pop() ?? "" : folder.split("/").pop() ?? "");

/** Does this candidate's folder / names match the parsed signal? */
export function candidateMatches(c: Pick<Candidate, "folder" | "names" | "kind">, sig: ParsedSignal, repo: string): boolean {
  if (c.kind === "Package" || !sig.tokens.length) return false;
  if (containsRun(sig.tokens, folderTokens(c.folder, repo))) return true;
  return (c.names ?? []).some((n) => sameTokens(sig.tokens, tokens(n)));
}

/**
 * Each candidate's matched signals (index-aligned with `candidates`): a signal goes to the ONE candidate it matches;
 * a signal two or more candidates match goes to none. Pure.
 */
export function matchSignals<C extends Pick<Candidate, "folder" | "names" | "kind">>(candidates: readonly C[], signals: readonly SeenSignal[], repo: string): SeenSignal[][] {
  const out: SeenSignal[][] = candidates.map(() => []);
  for (const s of signals) {
    const parsed = parseSignalName(s);
    const hits = candidates.flatMap((c, i) => (candidateMatches(c, parsed, repo) ? [i] : []));
    if (hits.length === 1) out[hits[0]].push(s);
  }
  return out;
}

/** The org environment an env hint names: by key or label (case-insensitive), `prod` ↔ `production`, else the
 *  environment whose branch IS the hint (Render names a branch). null when none or several. */
export function envForHint(hint: string | null, envs: readonly Pick<RepoEnvConfig, "key" | "label" | "branch">[]): string | null {
  if (!hint) return null;
  const h = hint.toLowerCase();
  const alias = (w: string) => (w === "prod" ? "production" : w === "stage" ? "staging" : w);
  const byName = envs.filter((e) => alias(e.key.toLowerCase()) === alias(h) || alias(e.label.toLowerCase()) === alias(h));
  if (byName.length === 1) return byName[0].key;
  if (byName.length > 1) return null;
  const byBranch = envs.filter((e) => e.branch.toLowerCase() === h);
  return byBranch.length === 1 ? byBranch[0].key : null;
}
