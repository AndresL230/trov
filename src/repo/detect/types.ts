// The detector interface (repo setups, Phase D). A detector is a PURE function over the files the repo scan read
// and the repository's file list: it says which apps the files describe. It never fetches, never reads D1, never
// guesses a value a file does not carry. Registered once in ./index.ts.
import type { AppKind } from "@shared/repo-apps-core";
import type { HostingProviderId } from "@shared/hosting";
import type { SuggestionEvidence } from "@shared/repo-scan-core";

export interface DetectInput {
  /** `owner/name`. */
  repo: string;
  /** Every blob path of the default branch's tree (after the scan's exclusions), repository-relative. */
  tree: readonly string[];
  /** The files the scan read (≤ 24): path → text. A path in the tree but not here was not read. */
  files: ReadonlyMap<string, string>;
}

/** What a detector found: one app (or package) at one folder. */
export interface Candidate {
  /** '/' = the repository root; else a path without leading / trailing '/'. */
  folder: string;
  kind: AppKind;
  provider: HostingProviderId | null;
  evidence: SuggestionEvidence[];
  /** Proposed part settings for `provider` (its own part-setting keys, plus extras a later phase reads — a Worker's
   *  `d1_database_ids`, `crons`; extras are kept on the suggestion and left out of the part an Accept writes). */
  settings?: Record<string, string>;
  /** Per environment NAME (wrangler's `[env.<name>]`): the settings that environment's part takes instead. */
  envSettings?: Record<string, Record<string, string>>;
  /** Names the host knows it by (a Worker name, a Fly.io app, a Render service, a package name) — the signal matcher
   *  reads them (./match.ts). */
  names?: string[];
  /** The workflow file that deploys it (`.github/workflows/<file>`), when one does — a `github` part's setting. */
  workflow?: string;
  /** Packages: the folders of the workspace members that depend on it. */
  usedBy?: string[];
  /** `deploy` — a deploy configuration of its own; `workspace` — only a workspace member. */
  source: "deploy" | "workspace";
}

export interface Detector {
  id: string;
  /** Path globs of the files it wants READ (a leading `**` segment = any folder; `*` = characters of one segment). */
  patterns: readonly string[];
  /** File names it looks for in the tree without reading them (a Dockerfile) — for the "looked for" sentence. */
  seen?: readonly string[];
  detect(input: DetectInput): Candidate[];
}

// ── helpers every detector shares ────────────────────────────────────────────

/** The folder a file sits in: '/' for a root file. */
export const folderOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "/" : path.slice(0, i);
};
export const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
/** `a` joined to a relative `b` (`./x`, `x/`, `/`), normalised; null when it climbs out of the repository. */
export function joinFolder(a: string, b: string): string | null {
  const parts = a === "/" ? [] : a.split("/");
  for (const seg of b.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : "/";
}
/** The path of a file `name` in `folder`. */
export const inFolder = (folder: string, name: string): string => (folder === "/" ? name : `${folder}/${name}`);
/** Evidence that a file says so: "from apps/web/vercel.json". */
export const fromFile = (path: string, extra?: string): SuggestionEvidence => ({ kind: "file", text: `from ${path}${extra ? ` · ${extra}` : ""}` });
/** The files the scan read whose name is `name` (any folder). */
export const filesNamed = (input: DetectInput, name: string): [string, string][] =>
  [...input.files].filter(([p]) => baseOf(p) === name);
