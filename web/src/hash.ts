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
//   #repo[/<tab>]?repo=<owner%2Fname>&app=<key>
//                     → the same, for another of the org's repositories and / or narrowed by the App menu
//                       (`app` = an app key, or `__repo` for "Repo-wide only"); both optional, any order
//   #artifacts        → the Artifacts library
//   #artifacts/new    → the new-artifact form
//   #artifacts/<slug>[/v<n>]           → one artifact (a version other than the latest;
//                                        `<slug>@v<n>` is accepted, `/v<n>` written back)
//   #artifacts/<slug>/diff/<a>..<b>    → two of its versions compared
//   #handoffs         → the handoffs inbox; #handoffs/new the form; #handoffs/<id> one handoff
//   #prompts          → the Prompt Library; #prompts/new the editor; #prompts/<slug> one
//                       prompt; #prompts/<slug>/edit and #prompts/<slug>/version its editor
//   #docs/new         → the new-doc form
//   #unplaced         → Triage › Unplaced (the screen `maintenance`). Its old addresses still
//                       resolve: #maintenance here, and #maintenance/identity and
//                       #maintenance/people — two tabs it had until 2026-10-06 — to
//                       Org settings › Members, where both now live
//   #releases         → Help › What's new: the grid of releases
//   #releases/<v>     → one release's notes (<v> = "0.14" or "unreleased"); #releases/<v>/patches
//                       its patch notes. The legacy #releases/patches opens the newest release's.
//   #platform         → Platform (superadmin) › Organizations; #platform/usage, /support, /admins, /audit
//                       its other tabs; #platform/orgs/<slug> one organization;
//                       #platform/support/<id> one support report (in the Support tab)
//   #org              → Org settings › Integrations; #org/repos, #org/environments, #org/hosting,
//                       #org/members, #org/tags, #org/notifications and #org/general its other tabs;
//                       #org/repos/<owner>/<name> one repository's Apps (repo setups, Phase D2),
//                       #org/repos/<owner>/<name>/apps/<key> one app, #org/repos/<owner>/<name>/new
//                       Add an app — all three on the Repositories tab
//   #tags/<name>      → one tag's page: everything that carries it. The list itself is
//                       Org settings › Tags (`#org/tags`), where a bare `#tags` lands
//   #ask              → Ask Trov, a new thread; #ask/<id> one stored thread (its id, a positive integer)
//   #welcome          → the guided first-run setup, at its first step; #welcome/agent,
//                       #welcome/team and #welcome/done its others (welcome.ts)
//   #<screen>         → every other screen, named exactly as the Screen union
//                       (`#site` is the landing page, reopened from inside the app)
// Anything unrecognised falls back to My Work — the same rule the app has always
// had for a junk hash.

import type { Screen } from "./render";
import { isRepoTab, type RepoTab } from "@shared/repo";
import type { ArtRoute } from "./artifacts";
import { parseSlugVersion } from "@shared/artifacts-core";
import { RELEASES, releaseSlug, type ReleasePage } from "./releases";
import { PLAT_TABS, type PlatTab } from "./platform";
import { ORG_SLUG_RE } from "@shared/orgs";
import { isOrgTab, type OrgTab } from "./org-settings";
import { isWelcomeStep, type WelcomeStep } from "./welcome";
import { normalizeTagName } from "@shared/tags-core";

/** Every screen addressable by its bare name (`#feed`). The compound ticket /
 *  sprint routes are parsed separately below. */
const PLAIN_SCREENS: Screen[] = [
  "mywork", "feed", "docs", "review",
  "search", "settings", "guide", "tickets", "site", "handoffs", "prompts",
];

export interface Route {
  screen: Screen;
  /** Set only on `ticketdetail`. */
  ticketId: number | null;
  /** Set only on `sprint`. */
  sprintId: number | null;
  /** Set only on `repo` (absent everywhere else, so older routes compare equal). */
  repoTab?: RepoTab;
  /** Set only on `repo`, when it reads a repository other than the primary (`?repo=owner/name`). */
  repoSlug?: string;
  /** Set only on `repo`, when the App menu narrows it (`?app=<key>`). */
  repoApp?: string;
  /** Set only on `artifact` (absent everywhere else, like `repoTab`). */
  art?: ArtRoute;
  /** Set only on `handoff` (a positive integer, rendered `#12`). */
  handoffId?: number;
  /** Set only on `prompt` and on `promptedit` for an existing prompt. */
  promptSlug?: string;
  /** Set only on `promptedit`. */
  promptMode?: "new" | "edit" | "version";
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
  /** Set only on `platform` › Support: the report on screen (`#platform/support/<id>`). */
  platReport?: number;
  /** Set only on `org` (Org settings' tab). */
  orgTab?: OrgTab;
  /** Set only on `org` › Repositories: one repository's Apps page (absent = the list of repositories). */
  orgRepo?: OrgRepoRoute;
  /** Set only on `welcome` (the guided setup's step). */
  welcomeStep?: WelcomeStep;
  /** Set only on `tag` (the tag's name). */
  tagName?: string;
  /** Set only on `ask` with a stored thread open (`#ask/<id>`). */
  askThread?: number;
}

/** One repository's page under Org settings › Repositories: its Apps (`apps`), one app (`app`), or Add an app (`new`). */
export interface OrgRepoRoute { repo: string; view: "apps" | "app" | "new"; app?: string }
const REPO_SEG = /^[A-Za-z0-9_.-]{1,100}$/;
const APP_KEY_SEG = /^[a-z0-9_-]{1,32}$/;

/** Whether two routes name the same place (the hashchange no-op check). */
export function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && a.ticketId === b.ticketId && a.sprintId === b.sprintId && a.repoTab === b.repoTab
    && a.repoSlug === b.repoSlug && a.repoApp === b.repoApp
    && a.handoffId === b.handoffId && a.promptSlug === b.promptSlug && a.promptMode === b.promptMode && a.roadmapTab === b.roadmapTab
    && a.releaseVersion === b.releaseVersion && a.releasePage === b.releasePage
    && a.platTab === b.platTab && a.platOrg === b.platOrg && a.platReport === b.platReport
    && a.orgTab === b.orgTab && a.welcomeStep === b.welcomeStep && a.tagName === b.tagName && a.askThread === b.askThread
    && JSON.stringify(a.art ?? null) === JSON.stringify(b.art ?? null)
    && JSON.stringify(a.orgRepo ?? null) === JSON.stringify(b.orgRepo ?? null);
}

/**
 * The PAGE a route is on: its hash without the in-page view — a tab (Roadmap, Repo, Platform,
 * Org settings) or a header switch (a release's Release / Patch notes). Two routes with
 * the same key are the same page: moving between them swaps the tab's body in place, with no
 * screen entrance and nothing to load again (main.ts `markEnter`, the hashchange handler).
 */
export function pageKey(r: Route): string {
  // Ask's thread is not a page of its own: opening one (or a new thread being named mid-answer) swaps the
  // conversation in place, never replays the screen's entrance.
  return hashForRoute({ ...r, askThread: undefined, roadmapTab: undefined, releasePage: undefined, repoTab: undefined, repoApp: undefined, platTab: undefined, platReport: undefined, orgTab: undefined, orgRepo: undefined });
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

/** A repository's full name (`owner/name`, GitHub's alphabet) and an app key (a part key) or `__repo`. */
const REPO_SLUG_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const APP_KEY_RE = /^(?:[a-z0-9_-]{1,32}|__repo)$/;
/** The Repo screen's scope from its query: only well-formed values, the rest dropped (a junk value is no scope). */
function repoScope(query: string): Pick<Route, "repoSlug" | "repoApp"> {
  const out: Pick<Route, "repoSlug" | "repoApp"> = {};
  for (const pair of query.split("&")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const v = seg(pair.slice(i + 1));
    if (!v) continue;
    const k = pair.slice(0, i);
    if (k === "repo" && REPO_SLUG_RE.test(v)) out.repoSlug = v;
    if (k === "app" && APP_KEY_RE.test(v)) out.repoApp = v;
  }
  return out;
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
  if (parts[0] === "repo" || parts[0].startsWith("repo?")) {
    // The query (`?repo=…&app=…`) is the screen's scope; the path before it is the tab, as always.
    const q = raw.indexOf("?");
    const path = (q < 0 ? raw : raw.slice(0, q)).split("/");
    const scope = repoScope(q < 0 ? "" : raw.slice(q + 1));
    if (path[0] !== "repo") return none;
    if (path.length === 1) return { screen: "repo", ticketId: null, sprintId: null, repoTab: "overview", ...scope };
    // `#repo/overview` is not canonical (the bare `#repo` is), but it still resolves.
    if (path.length === 2 && isRepoTab(path[1])) return { screen: "repo", ticketId: null, sprintId: null, repoTab: path[1], ...scope };
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
  if (parts[0] === "unplaced") return parts.length === 1 ? { screen: "maintenance", ...base } : none;
  // Legacy: `#unsubscribe` was a screen that turned the signed-in person's email off on arrival. An
  // email's Unsubscribe link is the Worker's `/u/<token>` page now, so the old address just opens
  // Settings, where the switch is — arriving changes nothing.
  if (parts[0] === "unsubscribe") return parts.length === 1 ? { screen: "settings", ...base } : none;
  // Legacy: the page was Maintenance, with three tabs. Unplaced is the page now; Identity and
  // People moved into Org settings › Members, so an old link (or bookmark) lands there.
  if (parts[0] === "maintenance") {
    if (parts.length === 1 || (parts.length === 2 && parts[1] === "unplaced")) return { screen: "maintenance", ...base };
    if (parts.length === 2 && (parts[1] === "identity" || parts[1] === "people")) return { screen: "org", ...base, orgTab: "members" };
    return none;
  }
  if (parts[0] === "platform") {
    if (parts.length === 1) return { screen: "platform", ...base, platTab: "orgs" };
    // `#platform/orgs` is not canonical (the bare `#platform` is), but it still resolves.
    if (parts.length === 2 && (PLAT_TABS as readonly string[]).includes(parts[1])) return { screen: "platform", ...base, platTab: parts[1] as PlatTab };
    if (parts.length === 3 && parts[1] === "orgs" && ORG_SLUG_RE.test(parts[2])) return { screen: "platformorg", ...base, platOrg: parts[2] };
    // One support report: still the Support TAB (the same page), with that report in its panel.
    if (parts.length === 3 && parts[1] === "support" && /^[1-9]\d{0,14}$/.test(parts[2])) return { screen: "platform", ...base, platTab: "support", platReport: Number(parts[2]) };
    return none;
  }
  // Org settings: `#org` is Integrations (the canonical spelling); `#org/integrations` still resolves.
  if (parts[0] === "org") {
    if (parts.length === 1) return { screen: "org", ...base, orgTab: "integrations" };
    if (parts.length === 2 && isOrgTab(parts[1])) return { screen: "org", ...base, orgTab: parts[1] };
    // One repository's Apps, one of its apps, or Add an app (Org settings › Repositories › <repo> › Apps).
    if (parts.length >= 4 && parts[1] === "repos") {
      const owner = seg(parts[2]), name = seg(parts[3]);
      if (!owner || !name || !REPO_SEG.test(owner) || !REPO_SEG.test(name)) return none;
      const repo = `${owner}/${name}`;
      if (parts.length === 4) return { screen: "org", ...base, orgTab: "repos", orgRepo: { repo, view: "apps" } };
      if (parts.length === 5 && parts[4] === "new") return { screen: "org", ...base, orgTab: "repos", orgRepo: { repo, view: "new" } };
      if (parts.length === 6 && parts[4] === "apps" && APP_KEY_SEG.test(parts[5])) return { screen: "org", ...base, orgTab: "repos", orgRepo: { repo, view: "app", app: parts[5] } };
    }
    return none;
  }
  // One tag's page. The list is a tab of Org settings, so `#tags` alone goes there.
  if (parts[0] === "tags") {
    if (parts.length === 1) return { screen: "org", ...base, orgTab: "tags" };
    const name = parts.length === 2 ? normalizeTagName(seg(parts[1])) : null;
    return name ? { screen: "tag", ...base, tagName: name } : none;
  }
  // Ask Trov: a new thread, or one stored thread.
  if (parts[0] === "ask") {
    if (parts.length === 1) return { screen: "ask", ...base };
    const id = parts.length === 2 ? intSeg(parts[1]) : null;
    return id !== null ? { screen: "ask", ...base, askThread: id } : none;
  }
  // The guided setup: `#welcome` is its first step (the canonical spelling; `#welcome/github` still
  // resolves). A step this person's flow does not have (a member's `#welcome/team`) shows their first.
  if (parts[0] === "welcome") {
    if (parts.length === 1) return { screen: "welcome", ...base, welcomeStep: "github" };
    if (parts.length === 2 && isWelcomeStep(parts[1])) return { screen: "welcome", ...base, welcomeStep: parts[1] };
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
  if (r.screen === "repo") {
    const q = [r.repoSlug ? `repo=${encodeURIComponent(r.repoSlug)}` : "", r.repoApp ? `app=${encodeURIComponent(r.repoApp)}` : ""].filter(Boolean).join("&");
    return `${!r.repoTab || r.repoTab === "overview" ? "#repo" : `#repo/${r.repoTab}`}${q ? `?${q}` : ""}`;
  }
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
  if (r.screen === "maintenance") return "#unplaced";
  if (r.screen === "platform") return !r.platTab || r.platTab === "orgs" ? "#platform" : r.platTab === "support" && r.platReport ? `#platform/support/${r.platReport}` : `#platform/${r.platTab}`;
  if (r.screen === "platformorg") return r.platOrg ? `#platform/orgs/${r.platOrg}` : "#platform";
  if (r.screen === "org") {
    const p = r.orgRepo;
    if (p && r.orgTab === "repos") {
      const base = `#org/repos/${p.repo.split("/").map(encodeURIComponent).join("/")}`;
      return p.view === "new" ? `${base}/new` : p.view === "app" && p.app ? `${base}/apps/${p.app}` : base;
    }
    return !r.orgTab || r.orgTab === "integrations" ? "#org" : `#org/${r.orgTab}`;
  }
  if (r.screen === "tag") return r.tagName ? `#tags/${encodeURIComponent(r.tagName)}` : "#org/tags";
  if (r.screen === "ask") return r.askThread ? `#ask/${r.askThread}` : "#ask";
  if (r.screen === "welcome") return !r.welcomeStep || r.welcomeStep === "github" ? "#welcome" : `#welcome/${r.welcomeStep}`;
  return `#${r.screen}`;
}
