// Apps (`repo_apps`): what a repository ships. An app IS a part key — every part of the app, in every
// environment, carries its key. Zod-free (the SPA imports the vocabularies as values).
import type { PartRole } from "./hosting";

export const APP_KINDS = ["Site", "Service", "Worker", "Job", "Package"] as const;
export type AppKind = (typeof APP_KINDS)[number];
export const isAppKind = (v: unknown): v is AppKind => typeof v === "string" && (APP_KINDS as readonly string[]).includes(v);

/** Role follows kind: a Site or a Worker serves requests (`web`); a Service or a Job runs (`service`); a
 *  Package is never deployed on its own and has no parts. */
export const APP_KIND_ROLE: Record<AppKind, PartRole | null> = { Site: "web", Worker: "web", Service: "service", Job: "service", Package: null };

/** An app with no `repo_apps` row (a part key from before apps existed) reads as an app at the root, its kind
 *  from its part's role. */
export const kindForRole = (role: PartRole): AppKind => (role === "web" ? "Site" : "Service");

// ── Phase A: one app as the server reads it (src/repo/apps.ts `listRepoApps`) ──
/** Where a `repo_apps` row came from (0070_repo_apps). */
export const APP_SOURCES = ["migrated", "manual", "suggested"] as const;
export type AppSource = (typeof APP_SOURCES)[number];
export interface RepoApp {
  key: string;
  /** `owner/name`. A row stored with '' (an org with no repository yet) reads as the primary repository, or ''. */
  repo: string;
  label: string;
  /** '/' = the repository root; else a path without leading or trailing '/'. */
  folder: string;
  kind: AppKind;
  /** Path globs whose changes count as this app's; the folder by default. */
  watch: string[];
  releaseSignal: string | null;
  /** `synthesised` = no `repo_apps` row: a part key read as an app at the primary repository's root. */
  source: AppSource | "synthesised";
  position: number;
}

// ── How a release of an app shows up (`repo_apps.release_signal`) ──
/** A parsed release signal: `tag:<glob>` (an SQLite GLOB on the tag) or `workflow:<file>@<branch>` (the latest
 *  successful run of that workflow file on that branch). */
export type ReleaseSignal = { kind: "tag"; glob: string } | { kind: "workflow"; file: string; branch: string };

/** A tag glob: 1–100 of letters, digits and `. _ - @ / + * ? [ ] ! ^`, at most 10 wildcards (`*` / `?`). */
const TAG_GLOB = /^[A-Za-z0-9._@/+*?[\]!^-]{1,100}$/;
const TAG_WILDCARDS_MAX = 10;
/** A workflow file, with or without its folder — the `github` provider's own pattern (src/hosting/providers/github.ts). */
const WORKFLOW_FILE = /^(?:\.github\/workflows\/)?[A-Za-z0-9._-]{1,100}\.ya?ml$/;
/** A branch as an environment may name one: no whitespace, no control character, ≤ 200. */
const BRANCH = /^[^\s\u0000-\u001f\u007f]{1,200}$/;

/** The one reading of a release signal — what `putRepoApp` accepts and what `readRelease` follows. Null for
 *  anything that is not exactly one of the two forms (and for a workflow file with `..` in it). */
export function parseReleaseSignal(v: string | null | undefined): ReleaseSignal | null {
  if (typeof v !== "string") return null;
  if (v.startsWith("tag:")) {
    const glob = v.slice(4);
    return TAG_GLOB.test(glob) && (glob.match(/[*?]/g)?.length ?? 0) <= TAG_WILDCARDS_MAX ? { kind: "tag", glob } : null;
  }
  if (v.startsWith("workflow:")) {
    const rest = v.slice(9);
    const at = rest.indexOf("@"); // a workflow file has no `@`; a branch may
    if (at < 0) return null;
    const file = rest.slice(0, at), branch = rest.slice(at + 1);
    return WORKFLOW_FILE.test(file) && !file.includes("..") && BRANCH.test(branch) ? { kind: "workflow", file, branch } : null;
  }
  return null;
}
