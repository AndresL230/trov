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
