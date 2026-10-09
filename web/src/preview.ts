// The state preview — see what a NEW organization sees, without changing anything.
//
// `?preview=empty` or `?preview=loading` on any app address (`/<org>/?preview=empty#tickets`)
// makes every screen render its EMPTY LAYOUT or its LOADING SKELETON, whatever the
// organization really holds. It is a way to look at the two states an owner of a busy
// organization otherwise never meets (docs/architecture/web-ui.md › Empty layouts).
//
// How it works — and why it cannot change or leak anything:
//   • It is a PROJECTION at render time. `previewState` maps the real app state onto
//     one whose reads are all "still out" (loading) or "answered with nothing" (empty);
//     `render()` paints that. The real state is never touched, the reads keep running
//     underneath, and dismissing the banner paints the real screen at once.
//   • It never sends a write: while the flag is on, api.ts refuses every request that
//     is not a GET before it leaves the browser (`setWriteBlock`), and says so.
//   • It cannot be mistaken for data: an empty layout draws boxes, never a name or a
//     number, and a banner stays on screen saying which state is being previewed.
//
// Who is looking is kept REAL in both modes — the signed-in person, their organizations
// and role, the org's own name and plan — because a new organization has those too, and
// they decide which actions a screen offers.
//
// Pure (no DOM): the tests call these directly.
import type { AppState } from "./render";
import { attr, esc } from "./ui";

export type PreviewMode = "empty" | "loading";
export const PREVIEW_PARAM = "preview";

/** The mode a query string asks for (`?preview=empty`), or null. Anything else is ignored. */
export function parsePreview(search: string): PreviewMode | null {
  const v = new URLSearchParams(search).get(PREVIEW_PARAM);
  return v === "empty" || v === "loading" ? v : null;
}

/** `search` with the flag set to `mode`, or removed (null). Other parameters are kept. */
export function previewSearch(search: string, mode: PreviewMode | null): string {
  const q = new URLSearchParams(search);
  if (mode) q.set(PREVIEW_PARAM, mode); else q.delete(PREVIEW_PARAM);
  const out = q.toString();
  return out ? `?${out}` : "";
}

/** An address (`/acme/#tickets`) carrying the flag: the query goes before the hash. */
export function withPreview(href: string, mode: PreviewMode | null): string {
  if (!mode) return href;
  const at = href.indexOf("#");
  const path = at < 0 ? href : href.slice(0, at);
  const hash = at < 0 ? "" : href.slice(at);
  const q = path.indexOf("?");
  return `${q < 0 ? path : path.slice(0, q)}${previewSearch(q < 0 ? "" : path.slice(q), mode)}${hash}`;
}

interface Slice { status: string; data: unknown }
const isSlice = (v: unknown): v is Slice => !!v && typeof v === "object" && "status" in v && "data" in v;

/**
 * Every read in `cur` (a `{ status, data }` slice, found by its shape in `blank`) as
 * "still out" or "answered with nothing". `blank` is the object's initial value, so the
 * nothing is each slice's own empty (`[]`, `null`, an empty plan). `keep` names the
 * slices left as they are.
 */
function blankSlices<T extends object>(cur: T, blank: T, mode: PreviewMode, keep: readonly (keyof T)[] = []): T {
  const out = { ...cur };
  for (const k of Object.keys(blank) as (keyof T)[]) {
    if (keep.includes(k)) continue;
    const b = blank[k];
    if (isSlice(b)) out[k] = { status: mode === "loading" ? "loading" : "ok", data: b.data } as T[keyof T];
  }
  return out;
}

/**
 * The state the preview paints. `blank` is `initialState()` (passed in: render.ts owns
 * it, and this module must not import a value from there).
 *
 * loading — every read is out: each screen shows its skeleton.
 * empty   — every read answered, with nothing: each screen shows its empty layout. A page
 *           that opens ONE existing thing (a ticket, a sprint, a handoff, a prompt, an
 *           artifact) has no empty layout — nothing can be opened in an empty
 *           organization — so those keep the real item.
 */
export function previewState(s: AppState, mode: PreviewMode, blank: AppState): AppState {
  // Who is looking stays real in both modes.
  const identity: (keyof AppState)[] = ["myOrgs", "orgMe", "personDetail"];
  const one: (keyof AppState)[] = mode === "empty" ? ["ticketDetail", "sprintDetail", "handoffDetail", "promptDetail"] : [];
  // Personal Settings' own reads describe the person, not the organization: a new org's
  // member still has their digest preferences. The org's digest policy has defaults too.
  const personal: (keyof AppState)[] = mode === "empty" ? ["notifPrefs", "notifPolicy", "notifSettings"] : [];
  const out = blankSlices(s, blank, mode, [...identity, ...one, ...personal]);
  out.preview = null; // already applied: painting this state again must not project it twice
  out.ticketBadge = 0;
  out.feedAuthors = [];
  out.identityDiscarded = [];
  out.repoFetchedAt = null;

  // Artifacts: the library's list (its details stay — one artifact's page is "one thing").
  out.art = { ...s.art, ...blankSlices({ list: s.art.list, attachTickets: s.art.attachTickets }, { list: blank.art.list, attachTickets: blank.art.attachTickets }, mode) };
  if (mode === "loading") out.art = { ...out.art, details: {}, diffs: {}, ticketArts: {} };

  // Org settings and Platform keep their own state objects.
  out.org = blankSlices(s.org, blank.org, mode, mode === "empty" ? ["settings", "plan", "members", "integrations", "github", "githubRepos"] : []);
  out.plat = blankSlices(s.plat, blank.plat, mode, mode === "empty" ? ["detail", "usage", "admins"] : []);

  // Loading: whether the organization has a repository is "not known yet" too (the Repo dashboard and
  // My Work's Repo tile then hold their skeleton). Role and name are kept: only the status changes.
  if (mode === "loading") out.orgMe = { ...s.orgMe, status: "loading" };

  if (mode === "empty") {
    const me = (s.me?.handle ?? "").toLowerCase();
    // A new organization has exactly one person in it: the one looking.
    out.persons = { status: "ok", data: s.persons.data.filter((p) => p.handle.toLowerCase() === me) };
    out.org = { ...out.org, members: { ...s.org.members, data: s.org.members.data.filter((m) => m.handle.toLowerCase() === me) } };
    // …no repository, so the Repo dashboard and My Work's Repo tile say so (never a sample).
    if (s.orgMe.data) out.orgMe = { ...s.orgMe, data: { ...s.orgMe.data, repos: { primary: null, all: [] } } };
    // The Repo dashboard's own "Preview with sample data" keeps working under the preview: it is
    // labelled sample data on every surface that shows it.
    if (s.repoSample) out.repo = s.repo;
    out.mywork = { status: "ok", data: { person: s.mywork.data?.person ?? null, previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false } };
    out.feedStats = { status: "ok", data: { days: [], total: 0, people: 0, topTags: [], topAuthors: [] } };
    out.art = { ...out.art, list: { status: "ok", data: [] }, attachTickets: { status: "ok", data: [] } };
    out.docSlug = null;
    out.reviewSel = null;
    out.assignOpen = null;
  }
  return out;
}

const WORDS: Record<PreviewMode, { title: string; other: PreviewMode; otherLabel: string }> = {
  empty: { title: "Previewing the empty state", other: "loading", otherLabel: "Show loading" },
  loading: { title: "Previewing the loading state", other: "empty", otherLabel: "Show empty" },
};

/** What a refused write says (api.ts throws it, main.ts shows it). */
export const PREVIEW_BLOCKED = "This is a preview: nothing is changed. Close the preview to make changes.";

/**
 * The banner that stays on screen while a preview is on: which state, that nothing is
 * changed, a switch to the other state, and Close. At the app root, over every screen —
 * never inside the header.
 */
export function previewBanner(mode: PreviewMode): string {
  const w = WORDS[mode];
  return `<div class="cnpy-preview" role="status" data-preview="${attr(mode)}">
    <span class="cnpy-preview-dot" aria-hidden="true"></span>
    <span class="cnpy-preview-t"><strong>${esc(w.title)}</strong> — nothing is changed, and what you see is not your data.</span>
    <button type="button" data-act="previewSet" data-arg="${attr(w.other)}" class="cnpy-preview-b">${esc(w.otherLabel)}</button>
    <button type="button" data-act="previewSet" data-arg="" class="cnpy-preview-b" aria-label="Close the preview">Close</button>
  </div>`;
}
