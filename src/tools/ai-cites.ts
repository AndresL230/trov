// WHAT TROV'S WRITING LINKS TO, built by the server (docs/architecture/ai.md › Cites). A model only ever NAMES a
// ref that was in its input (`pr:173`, `sha:65b9f1f`); the label and the link are made here, from the ref and the
// repository the row is about — never from model text. Pure, and reachable from MCP's reads (the feed's `ai`
// field, the repo state), so it imports nothing from src/ai/.
import type { AiCite } from "@shared/ai-core";

/** A short sha as the feed stores it: the first 7 hex characters, lower case. Null for anything that is not one. */
export function shortSha(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[0-9a-f]{7,40}$/.test(s) ? s.slice(0, 7) : null;
}

/** A PR number as the feed stores it ("173"), or null. */
export function prNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/^#/, "")) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const gh = (repo: string | null, path: string): string | null =>
  repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/${path}` : null;

/** A pull request's cite. */
export const prCite = (n: number, repo: string | null): AiCite => ({ ref: `pr:${n}`, label: `#${n}`, href: gh(repo, `pull/${n}`) });
/** A commit's cite (short sha). */
export const shaCite = (sha: string, repo: string | null): AiCite => ({ ref: `sha:${sha}`, label: sha, href: gh(repo, `commit/${sha}`) });
/** A CI run's cite; `url` is the run's own link when the capture has it. */
export const runCite = (id: number, repo: string | null, url?: string | null): AiCite =>
  ({ ref: `run:${id}`, label: `CI run ${id}`, href: safeHttps(url) ?? gh(repo, `actions/runs/${id}`) });

/** An http(s) link a provider gave us (a deploy's), or null. Nothing else is ever an href. */
export function safeHttps(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The cites of a feed entry's `artifacts` JSON (`{ prs, commits }`), PRs first — what an AI entry shows as its
 *  sources. Unreadable JSON is no cites (never a guess). */
export function citesOfArtifacts(artifacts: string | null, repo: string | null): AiCite[] {
  let a: { prs?: unknown; commits?: unknown } = {};
  try { a = artifacts ? (JSON.parse(artifacts) as typeof a) : {}; } catch { return []; }
  const prs = (Array.isArray(a.prs) ? a.prs : []).map(prNumber).filter((n): n is number => n !== null);
  const shas = (Array.isArray(a.commits) ? a.commits : []).map(shortSha).filter((s): s is string => s !== null);
  return [...new Set(prs)].map((n) => prCite(n, repo)).concat([...new Set(shas)].map((s) => shaCite(s, repo)));
}
