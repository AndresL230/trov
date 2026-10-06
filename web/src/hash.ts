// The URL-hash ↔ route seam, as two pure functions so it is unit-testable
// without a DOM (main.ts is the only module that reads `location`).
//
// Routes (§C.11 of the tickets brief):
//   #tickets          → the queue
//   #tickets/new      → the new-ticket form
//   #tickets/<id>     → one ticket's detail
//   #sprints/<id>     → one sprint's screen
//   #roadmap          → the Roadmap's Narrative tab; #roadmap/timeline its Timeline
//   #repo             → the Repo dashboard's Overview
//   #repo/<tab>       → one of its other tabs (code / ci / usage / planning)
//   #artifacts        → the Artifacts library
//   #artifacts/new    → the new-artifact form
//   #artifacts/<slug>[/v<n>]           → one artifact (a version other than the latest;
//                                        `<slug>@v<n>` is accepted, `/v<n>` written back)
//   #artifacts/<slug>/diff/<a>..<b>    → two of its versions compared
//   #handoffs         → the handoffs inbox; #handoffs/new the form; #handoffs/<id> one handoff
//   #prompts          → the Prompt Library; #prompts/new the editor; #prompts/<slug> one
//                       prompt; #prompts/<slug>/edit and #prompts/<slug>/version its editor
//   #docs/new         → the new-doc form
//   #maintenance      → Maintenance › Unplaced; #maintenance/identity and #maintenance/people
//   #releases         → Help › What's new: the grid of releases
//   #releases/<v>     → one release's notes (<v> = "0.14" or "unreleased"); #releases/<v>/patches
//                       its patch notes. The legacy #releases/patches opens the newest release's.
//   #platform         → Platform (superadmin) › Organizations; #platform/usage, /admins, /audit
//                       its other tabs; #platform/orgs/<slug> one organization
//   #<screen>         → every other screen, named exactly as the Screen union
//                       (`#site` is the landing page, reopened from inside the app)
// Anything unrecognised falls back to My Work — the same rule the app has always
// had for a junk hash.

import type { Screen } from "./render";
import { isRepoTab, type RepoTab } from "@shared/repo";
import type { ArtRoute } from "./artifacts";
import { parseSlugVersion } from "@shared/artifacts-core";
import { MAINT_TABS, type MaintTab } from "./maintenance";
import { RELEASES, releaseSlug, type ReleasePage } from "./releases";
import { PLAT_TABS, type PlatTab } from "./platform";
import { ORG_SLUG_RE } from "@shared/orgs";

/** Every screen addressable by its bare name (`#feed`). The compound ticket /
 *  sprint routes are parsed separately below. */
const PLAIN_SCREENS: Screen[] = [
  "mywork", "feed", "docs", "review",
  "search", "settings", "guide", "unsubscribe", "tickets", "site", "handoffs", "prompts",
];

export interface Route {
  screen: Screen;
  /** Set only on `ticketdetail`. */
  ticketId: number | null;
  /** Set only on `sprint`. */
  sprintId: number | null;
  /** Set only on `repo` (absent everywhere else, so older routes compare equal). */
  repoTab?: RepoTab;
  /** Set only on `artifact` (absent everywhere else, like `repoTab`). */
  art?: ArtRoute;
  /** Set only on `handoff` (a positive integer, rendered `#12`). */
  handoffId?: number;
  /** Set only on `prompt` and on `promptedit` for an existing prompt. */
  promptSlug?: string;
  /** Set only on `promptedit`. */
  promptMode?: "new" | "edit" | "version";
  /** Set only on `maintenance`. */
  maintTab?: MaintTab;
  /** Set only on `roadmap`. */
  roadmapTab?: "narrative" | "timeline";
  /** Set only on a release's page (`releases` without it is the index). */
  releaseVersion?: string;
  /** Set only with `releaseVersion`. */
  releasePage?: ReleasePage;
  /** Set only on `platform` (the superadmin area's tab). */
  platTab?: PlatTab;
  /** Set only on `platformorg` (one organization's slug). */
  platOrg?: string;
}

/** Whether two routes name the same place (the hashchange no-op check). */
export function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && a.ticketId === b.ticketId && a.sprintId === b.sprintId && a.repoTab === b.repoTab
    && a.handoffId === b.handoffId && a.promptSlug === b.promptSlug && a.promptMode === b.promptMode && a.maintTab === b.maintTab && a.roadmapTab === b.roadmapTab
    && a.releaseVersion === b.releaseVersion && a.releasePage === b.releasePage
    && a.platTab === b.platTab && a.platOrg === b.platOrg
    && JSON.stringify(a.art ?? null) === JSON.stringify(b.art ?? null);
}

/** A URL path segment decoded, or null when it is malformed. */
function seg(v: string): string | null {
  try { const d = decodeURIComponent(v); return d ? d : null; } catch { return null; }
}

/** An artifact slug: lowercase words joined by dashes (`new` is the form, never a slug). */
const isArtSlug = (v: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v !== "new";

/** A positive integer path segment, or null (so `#tickets/abc` is not a detail route). */
function intSeg(v: string): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a location hash (with or without the leading `#`) into a route. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const none: Route = { screen: "mywork", ticketId: null, sprintId: null };
  if (!raw) return none;

  const parts = raw.split("/");
  if (parts[0] === "tickets") {
    if (parts.length === 1) return { screen: "tickets", ticketId: null, sprintId: null };
    if (parts.length === 2) {
      if (parts[1] === "new") return { screen: "newticket", ticketId: null, sprintId: null };
      const id = intSeg(parts[1]);
      if (id !== null) return { screen: "ticketdetail", ticketId: id, sprintId: null };
    }
    return none;
  }
  if (parts[0] === "sprints" && parts.length === 2) {
    const id = intSeg(parts[1]);
    if (id !== null) return { screen: "sprint", ticketId: null, sprintId: id };
    return none;
  }
  if (parts[0] === "roadmap") {
    if (parts.length === 1) return { screen: "roadmap", ticketId: null, sprintId: null, roadmapTab: "narrative" };
    // `#roadmap/narrative` is not canonical (the bare `#roadmap` is), but it still resolves.
    if (parts.length === 2 && (parts[1] === "narrative" || parts[1] === "timeline")) return { screen: "roadmap", ticketId: null, sprintId: null, roadmapTab: parts[1] };
    return none;
  }
  if (parts[0] === "repo") {
    if (parts.length === 1) return { screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" };
    // `#repo/overview` is not canonical (the bare `#repo` is), but it still resolves.
    if (parts.length === 2 && isRepoTab(parts[1])) return { screen: "repo", ticketId: null, sprintId: null, repoTab: parts[1] };
    return none;
  }
  if (parts[0] === "artifacts") {
    if (parts.length === 1) return { screen: "artifacts", ticketId: null, sprintId: null };
    if (parts.length === 2 && parts[1] === "new") return { screen: "artifactnew", ticketId: null, sprintId: null };
    // `<slug>@v<n>` (the raw route's spelling) is accepted too; `/v<n>` is canonical.
    const at = parts.length === 2 && parts[1].includes("@") ? parseSlugVersion(parts[1]) : null;
    if (at && at.version !== null && isArtSlug(at.slug)) return { screen: "artifact", ticketId: null, sprintId: null, art: { slug: at.slug, v: at.version, diff: null } };
    if (!isArtSlug(parts[1] ?? "")) return none;
    const one =(v: number | null, diff: ArtRoute["diff"]): Route => ({ screen: "artifact", ticketId: null, sprintId: null, art: { slug: parts[1], v, diff } });
    if (parts.length === 2) return one(null, null);
    const v = parts.length === 3 && /^v\d+$/.test(parts[2]) ? intSeg(parts[2].slice(1)) : null;
    if (v !== null) return one(v, null);
    const d = parts.length === 4 && parts[2] === "diff" ? /^(\d+)\.\.(\d+)$/.exec(parts[3]) : null;
    const a = d ? intSeg(d[1]) : null;
    const b = d ? intSeg(d[2]) : null;
    if (a !== null && b !== null) return one(null, { a, b });
    return none;
  }
  const base = { ticketId: null, sprintId: null };
  if (parts[0] === "handoffs" && parts.length === 2) {
    if (parts[1] === "new") return { screen: "newhandoff", ...base };
    const id = intSeg(parts[1]);
    return id !== null ? { screen: "handoff", ...base, handoffId: id } : none;
  }
  if (parts[0] === "prompts" && (parts.length === 2 || parts.length === 3)) {
    if (parts.length === 2 && parts[1] === "new") return { screen: "promptedit", ...base, promptMode: "new" };
    const slug = seg(parts[1]);
    if (!slug) return none;
    if (parts.length === 2) return { screen: "prompt", ...base, promptSlug: slug };
    if (parts[2] === "edit" || parts[2] === "version") return { screen: "promptedit", ...base, promptSlug: slug, promptMode: parts[2] };
    return none;
  }
  if (parts[0] === "docs" && parts.length === 2 && parts[1] === "new") return { screen: "newdoc", ...base };
  if (parts[0] === "releases") {
    if (parts.length === 1) return { screen: "releases", ...base };
    // Legacy (the first cut had one global switch): `#releases/notes` is the index,
    // `#releases/patches` the NEWEST release's patch notes.
    if (parts.length === 2 && parts[1] === "notes") return { screen: "releases", ...base };
    if (parts.length === 2 && parts[1] === "patches") {
      return RELEASES[0] ? { screen: "releases", ...base, releaseVersion: releaseSlug(RELEASES[0]), releasePage: "patches" } : { screen: "releases", ...base };
    }
    // A version segment; an unknown one still routes here and renders a friendly not-found.
    const v = parts.length === 2 || parts.length === 3 ? seg(parts[1])?.toLowerCase() ?? null : null;
    if (!v || !/^[a-z0-9][a-z0-9.\-]{0,39}$/.test(v)) return none;
    if (parts.length === 2) return { screen: "releases", ...base, releaseVersion: v, releasePage: "notes" };
    // `#releases/<v>/notes` is not canonical (the bare `#releases/<v>` is), but it still resolves.
    if (parts[2] === "patches" || parts[2] === "notes") return { screen: "releases", ...base, releaseVersion: v, releasePage: parts[2] };
    return none;
  }
  if (parts[0] === "maintenance") {
    if (parts.length === 1) return { screen: "maintenance", ...base, maintTab: "unplaced" };
    if (parts.length === 2 && (MAINT_TABS as readonly string[]).includes(parts[1])) return { screen: "maintenance", ...base, maintTab: parts[1] as MaintTab };
    return none;
  }
  if (parts[0] === "platform") {
    if (parts.length === 1) return { screen: "platform", ...base, platTab: "orgs" };
    // `#platform/orgs` is not canonical (the bare `#platform` is), but it still resolves.
    if (parts.length === 2 && (PLAT_TABS as readonly string[]).includes(parts[1])) return { screen: "platform", ...base, platTab: parts[1] as PlatTab };
    if (parts.length === 3 && parts[1] === "orgs" && ORG_SLUG_RE.test(parts[2])) return { screen: "platformorg", ...base, platOrg: parts[2] };
    return none;
  }
  if (parts.length === 1 && (PLAIN_SCREENS as string[]).includes(parts[0])) {
    return { screen: parts[0] as Screen, ticketId: null, sprintId: null };
  }
  return none;
}

/** The inverse: the hash the rerender writes back for the current route. Always
 *  round-trips through parseHash (asserted in test/hash.test.ts). */
export function hashForRoute(r: Route): string {
  if (r.screen === "ticketdetail") return r.ticketId !== null ? `#tickets/${r.ticketId}` : "#tickets";
  if (r.screen === "newticket") return "#tickets/new";
  if (r.screen === "roadmap") return r.roadmapTab === "timeline" ? "#roadmap/timeline" : "#roadmap";
  if (r.screen === "repo") return !r.repoTab || r.repoTab === "overview" ? "#repo" : `#repo/${r.repoTab}`;
  if (r.screen === "artifactnew") return "#artifacts/new";
  if (r.screen === "artifact") {
    const a = r.art;
    if (!a?.slug) return "#artifacts";
    if (a.diff) return `#artifacts/${a.slug}/diff/${a.diff.a}..${a.diff.b}`;
    return a.v !== null ? `#artifacts/${a.slug}/v${a.v}` : `#artifacts/${a.slug}`;
  }
  if (r.screen === "sprint") return r.sprintId !== null ? `#sprints/${r.sprintId}` : "#roadmap";
  if (r.screen === "handoff") return r.handoffId ? `#handoffs/${r.handoffId}` : "#handoffs";
  if (r.screen === "newhandoff") return "#handoffs/new";
  if (r.screen === "prompt") return r.promptSlug ? `#prompts/${encodeURIComponent(r.promptSlug)}` : "#prompts";
  if (r.screen === "promptedit") {
    if (r.promptMode === "edit" || r.promptMode === "version") return r.promptSlug ? `#prompts/${encodeURIComponent(r.promptSlug)}/${r.promptMode}` : "#prompts";
    return "#prompts/new";
  }
  if (r.screen === "newdoc") return "#docs/new";
  if (r.screen === "releases") {
    if (!r.releaseVersion) return "#releases";
    return `#releases/${encodeURIComponent(r.releaseVersion)}${r.releasePage === "patches" ? "/patches" : ""}`;
  }
  if (r.screen === "maintenance") return !r.maintTab || r.maintTab === "unplaced" ? "#maintenance" : `#maintenance/${r.maintTab}`;
  if (r.screen === "platform") return !r.platTab || r.platTab === "orgs" ? "#platform" : `#platform/${r.platTab}`;
  if (r.screen === "platformorg") return r.platOrg ? `#platform/orgs/${r.platOrg}` : "#platform";
  return `#${r.screen}`;
}
