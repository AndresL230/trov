// The "search everything" dropdown behind the sidebar's search box (⌘K / Ctrl K).
//
// Two halves in one file:
//   · PURE — the static Screens list, the row model, the highlighter and the panel
//     markup (`quickRows` / `quickBodyHtml`), unit-tested without a DOM
//     (test/render.quicksearch.test.ts).
//   · THE CONTROLLER — `createQuickSearch`, which owns ONE node mounted on <body>,
//     OUTSIDE the app's mount. rerender() never sees it, so the sidebar's pinned element
//     tree and morph patching are untouched, and typing never rerenders the app: each
//     keystroke patches only the panel's list. The sidebar's own <input> survives
//     rerenders already (morph leaves a focused control's value and caret alone).
//
// Two presentations: with the rail EXPANDED the panel hangs under the sidebar box and
// that box is the input; with the rail COLLAPSED (or below 900px, where it always is)
// ⌘K opens a centered command palette with its own input.
//
// Calm, then fast: the panel never opens or reshapes under a keystroke — it paints only
// once the person PAUSES (1s), keeping whatever it shows steady until then, and every
// change of height glides (as do opening and closing; all off under reduced motion).
// Behind that pause the answer is usually ready: the request starts 120ms after a
// keystroke, the in-flight one is aborted on every keystroke, and a small LRU of recent
// answers means a repeat never touches the network. If the pause passes with the answer
// still out, the longest cached PREFIX's still-matching hits and a "Searching…" note
// show. Enter / ⌘Enter / Tab act at once on whatever is typed. Under 2 characters
// nothing is fetched: the Screens list is static and matched here.

import {
  QUICK_MIN_CHARS, type QuickHit, type QuickType, type QuickSearchResult,
} from "@shared/quick-search";
import { TICKET_STATUS_LABEL, type TicketStatus } from "@shared/tickets-core";
import { PERSON_COLORS, type PersonColor } from "@shared/rows";
import { esc, attr, relTime } from "./ui";
import { personChip } from "./people";

// ── what a pick does ─────────────────────────────────────────────────────────

/** A pick is either a run of existing app acts (dispatched in order) or the full
 *  Search screen for a query. */
export type QuickPick = { kind: "go"; steps: [string, string | null][] } | { kind: "search"; q: string };

// ── the static Screens list (client-side; never fetched) ─────────────────────

export interface QuickScreen { label: string; hint: string; keys: string; steps: [string, string | null][] }

export const QUICK_SCREENS: readonly QuickScreen[] = [
  { label: "My Work", hint: "Your PRs, issues and tickets", keys: "home dashboard mine todo", steps: [["goMyWork", null]] },
  { label: "Tickets › Board", hint: "The ticket board", keys: "queue kanban columns", steps: [["navSub", "tickets:board"]] },
  { label: "Tickets › Table", hint: "The ticket queue as a table", keys: "queue list", steps: [["navSub", "tickets:queue"]] },
  { label: "New ticket", hint: "File a ticket", keys: "create bug report request file", steps: [["newTicket", null]] },
  { label: "Roadmap", hint: "The plan narrative and sprints", keys: "plan narrative sprints", steps: [["goRoadmap", null]] },
  { label: "Roadmap › Timeline", hint: "Sprints on a timeline", keys: "plan sprints gantt schedule", steps: [["goRoadmap", null], ["roadmapTimeline", null]] },
  { label: "Handoffs", hint: "Work left for the next session", keys: "inbox claim", steps: [["goHandoffs", null]] },
  { label: "New handoff", hint: "Leave work for someone", keys: "send create", steps: [["newHandoff", null]] },
  { label: "Repo › Overview", hint: "Environments, drift and health", keys: "dashboard github environments health deploys", steps: [["navSub", "repo:overview"]] },
  { label: "Repo › Code", hint: "Pull requests, commits and branches", keys: "prs pull requests branches commits", steps: [["navSub", "repo:code"]] },
  { label: "Repo › CI", hint: "Deploys, failures, coverage and bundle", keys: "builds checks runs coverage failures deploys", steps: [["navSub", "repo:ci"]] },
  { label: "Repo › Usage", hint: "Requests, users and product metrics", keys: "cloudflare railway metrics active users", steps: [["navSub", "repo:usage"]] },
  { label: "Repo › Planning", hint: "Sprint, labels and contributors", keys: "contributors labels todos", steps: [["navSub", "repo:planning"]] },
  { label: "Feed", hint: "What shipped, session by session", keys: "activity sessions log", steps: [["goFeed", null]] },
  { label: "Docs", hint: "The team's documentation", keys: "documentation knowledge wiki", steps: [["goDocs", null]] },
  { label: "New doc", hint: "Propose a new doc", keys: "write propose create", steps: [["newDoc", null]] },
  { label: "Artifacts", hint: "Designs, specs, reports and files", keys: "designs pages files pdf", steps: [["goArtifacts", null]] },
  { label: "New artifact", hint: "Upload or paste a page", keys: "upload publish create", steps: [["artNew", null]] },
  { label: "Prompt Library", hint: "Reusable team prompts", keys: "prompts templates", steps: [["goPrompts", null]] },
  { label: "New prompt", hint: "Save a reusable prompt", keys: "create template", steps: [["newPrompt", null]] },
  { label: "Review", hint: "Proposals and decisions to confirm", keys: "proposals decisions promote ratify approve", steps: [["goReview", null]] },
  { label: "Maintenance › Unplaced", hint: "Items the gate could not place", keys: "triage", steps: [["goMaintenance", "unplaced"]] },
  { label: "Maintenance › Identity", hint: "Map GitHub logins to people", keys: "github logins map", steps: [["goMaintenance", "identity"]] },
  { label: "Maintenance › People", hint: "Invites, members and digests", keys: "invite members admin notifications", steps: [["goMaintenance", "people"]] },
  { label: "Settings", hint: "Profile, account and appearance", keys: "profile account preferences", steps: [["goSettings", null]] },
  { label: "Settings › MCP access", hint: "Connect Claude Code: sign-in steps and connected apps", keys: "mcp tokens connect agent claude code plugin oauth authenticate", steps: [["goSettings", null]] },
  { label: "Settings › Appearance", hint: "Light, dark or system theme", keys: "theme dark light mode", steps: [["goSettings", null]] },
  { label: "Settings › Email notifications", hint: "Daily and weekly digests", keys: "digest email unsubscribe", steps: [["goSettings", null]] },
  { label: "Get Started", hint: "The guide to Canopy", keys: "guide help onboarding tour", steps: [["goGuide", null]] },
  { label: "Release notes", hint: "What's new in Canopy", keys: "whats new changelog releases updates patches", steps: [["goReleases", null]] },
  { label: "Search", hint: "Full results across the store", keys: "find all results", steps: [["goSearch", null]] },
];

/** What the palette offers before anything is typed. */
const JUMP_DEFAULTS = ["My Work", "Tickets › Board", "New ticket", "Roadmap", "Handoffs", "Docs", "Settings › MCP access", "Release notes"];

/** Word tokens of a query, lowercased (the server's own tokenizer rule). */
export const tokensOf = (q: string): string[] =>
  q.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);

/** Each token and — for the last, the one being typed — itself one and two characters
 *  shorter (never below 4): the same alternatives the Worker matches past a stem. */
function alternatives(toks: string[]): string[][] {
  return toks.map((t, i) => {
    const alts = [t];
    if (i === toks.length - 1) for (const k of [1, 2]) if (t.length - k >= 4) alts.push(t.slice(0, -k));
    return alts;
  });
}

/** Screens whose label or keywords hold every token as a word prefix, best first:
 *  3 = the label starts with the query, 2 = every token prefixes a label word, 1 = keywords. */
export function matchScreens(q: string, max = 4): { screen: QuickScreen; score: number }[] {
  const toks = tokensOf(q);
  if (!toks.length) return [];
  const words = (s: string) => tokensOf(s);
  const lead = q.trim().toLowerCase();
  const out: { screen: QuickScreen; score: number; i: number }[] = [];
  QUICK_SCREENS.forEach((screen, i) => {
    const label = words(screen.label);
    const all = [...label, ...words(screen.keys)];
    if (!toks.every((t) => all.some((w) => w.startsWith(t)))) return;
    const score = screen.label.toLowerCase().startsWith(lead) ? 3 : toks.every((t) => label.some((w) => w.startsWith(t))) ? 2 : 1;
    out.push({ screen, score, i });
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).map(({ screen, score }) => ({ screen, score }));
}

// ── highlighting ─────────────────────────────────────────────────────────────

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text`, HTML-escaped, with every word-start occurrence of a query token wrapped in
 *  `<mark class="cnpy-qs-hl">`. Escaping is done PER PIECE, so a token can never
 *  split an entity and nothing in `text` is ever markup. */
export function highlight(text: string, q: string): string {
  const alts = alternatives(tokensOf(q)).flat().sort((a, b) => b.length - a.length);
  if (!alts.length || !text) return esc(text ?? "");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.map(reEsc).join("|")})`, "giu");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += esc(text.slice(last, at)) + `<mark class="cnpy-qs-hl">${esc(m[0])}</mark>`;
    last = at + m[0].length;
  }
  return out + esc(text.slice(last));
}

// ── the row model ────────────────────────────────────────────────────────────

const svg = (d: string): string =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/** Group heads: label + a small icon drawn from the sidebar's own glyph family. */
export const QUICK_GROUPS: Record<QuickType | "screen", { label: string; icon: string }> = {
  screen: { label: "Screens", icon: svg(`<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path>`) },
  ticket: { label: "Tickets", icon: svg(`<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path><path d="M13 5v2M13 11v2M13 17v2"></path>`) },
  doc: { label: "Docs", icon: svg(`<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path>`) },
  decision: { label: "Decisions", icon: svg(`<rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="m9 12.5 2 2 4-5"></path>`) },
  sprint: { label: "Roadmap", icon: svg(`<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`) },
  artifact: { label: "Artifacts", icon: svg(`<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M7 13.5h6"></path><path d="M7 16.5h9"></path>`) },
  prompt: { label: "Prompts", icon: svg(`<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"></path><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"></path>`) },
  handoff: { label: "Handoffs", icon: svg(`<path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4z"></path>`) },
  person: { label: "People", icon: svg(`<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>`) },
  feed: { label: "Feed", icon: svg(`<path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path>`) },
};

export interface QuickRow {
  group: QuickType | "screen" | "all";
  title: string;
  /** The one context line (plain text; highlighted at render). */
  context: string;
  /** A short right-hand label (`#12`, an age). */
  meta: string;
  pick: QuickPick;
  person?: { handle: string; name: string | null; color: PersonColor; avatar_url: string | null };
}
export interface QuickGroupView { id: QuickType | "screen"; rows: QuickRow[] }

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : s);
const join = (...xs: (string | null | undefined)[]): string => xs.filter((x): x is string => !!x && !!x.trim()).join(" · ");
const go = (...steps: [string, string | null][]): QuickPick => ({ kind: "go", steps });

/** One server hit → one row: its title, ONE context line, a right-hand label, and the
 *  existing app act(s) that open it. */
export function rowOf(h: QuickHit): QuickRow {
  const age = h.at ? relTime(h.at) : "";
  switch (h.type) {
    case "ticket":
      return { group: "ticket", title: h.title, meta: `#${h.id}`, pick: go(["openTicket", h.id]),
        context: join(TICKET_STATUS_LABEL[h.status as TicketStatus] ?? cap(h.status ?? ""), h.snippet, age) };
    case "doc":
      return { group: "doc", title: h.title, meta: age, pick: go(["openDocFrom", h.id]), context: h.snippet || join(cap(h.status ?? ""), h.by ? `@${h.by}` : null) };
    case "decision":
      // Decisions have no screen of their own: the Search screen shows the whole record.
      return { group: "decision", title: h.title, meta: age, pick: { kind: "search", q: h.title }, context: h.snippet || "Ratified decision" };
    case "sprint": {
      const plan = h.id === "plan";
      const sid = h.id.startsWith("sprint:") ? h.id.slice("sprint:".length) : null;
      const status = h.status === "in_progress" ? "Active" : h.status ? cap(h.status) : null;
      return { group: "sprint", title: plan ? "Roadmap plan" : h.title, meta: plan ? "" : age,
        pick: sid ? go(["openSprint", sid]) : go(["goRoadmap", null]), context: join(plan ? "The plan narrative" : status, h.snippet) };
    }
    case "artifact":
      return { group: "artifact", title: h.title, meta: age, pick: go(["artOpen", h.id]), context: join(cap(h.status ?? ""), h.snippet, h.by ? `@${h.by}` : null) };
    case "prompt":
      return { group: "prompt", title: h.title, meta: age, pick: go(["openPrompt", h.id]),
        context: join(h.status && h.status !== "published" ? `${cap(h.status)} edit` : null, h.snippet) || h.id };
    case "handoff":
      return { group: "handoff", title: h.title, meta: `#${h.id}`, pick: go(["openHandoff", h.id]), context: join(cap(h.status ?? ""), h.snippet, age) };
    case "person": {
      const color = (PERSON_COLORS as readonly string[]).includes(h.color ?? "") ? (h.color as PersonColor) : "stone";
      return { group: "person", title: h.title, meta: "Profile", pick: go(["openPerson", h.id]),
        context: join(`@${h.id}`, h.snippet), person: { handle: h.id, name: h.title, color, avatar_url: h.avatar_url ?? null } };
    }
    case "feed":
      return { group: "feed", title: h.title, meta: age, pick: go(["goFeed", null]), context: join(h.snippet, h.by ? `@${h.by}` : null) };
  }
}

/** The groups to show for `q`: the matching Screens (first when one's label starts with
 *  the query, else after the server's groups) and the server's groups in their order.
 *  An empty query in the palette offers a fixed "jump to" set. */
export function quickGroups(q: string, result: QuickSearchResult | null, opts: { palette?: boolean } = {}): QuickGroupView[] {
  const trimmed = q.trim();
  const screenRow = (s: QuickScreen): QuickRow => ({ group: "screen", title: s.label, context: s.hint, meta: "", pick: { kind: "go", steps: s.steps } });
  if (!trimmed) {
    if (!opts.palette) return [];
    const rows = JUMP_DEFAULTS.map((l) => QUICK_SCREENS.find((s) => s.label === l)).filter((s): s is QuickScreen => !!s).map(screenRow);
    return [{ id: "screen", rows }];
  }
  const screens = matchScreens(trimmed);
  const screenGroup: QuickGroupView | null = screens.length ? { id: "screen", rows: screens.map((m) => screenRow(m.screen)) } : null;
  const server: QuickGroupView[] = (result?.groups ?? []).map((g) => ({ id: g.type, rows: g.hits.map((h) => rowOf(h)) }));
  if (!screenGroup) return server;
  return screens[0].score >= 3 || !server.length ? [screenGroup, ...server] : [...server, screenGroup];
}

/** Every selectable row in keyboard order, the trailing "all results" row included. */
export function flatRows(groups: QuickGroupView[], q: string): QuickRow[] {
  const rows = groups.flatMap((g) => g.rows);
  if (q.trim()) rows.push({ group: "all", title: `Search everything for “${q.trim()}”`, context: "", meta: "Tab", pick: { kind: "search", q: q.trim() } });
  return rows;
}

// ── markup ───────────────────────────────────────────────────────────────────

export type QuickStatus = "idle" | "searching" | "ok" | "error";

export interface QuickBodyProps {
  q: string;
  groups: QuickGroupView[];
  /** The selected row's index in `flatRows` order. */
  sel: number;
  status: QuickStatus;
  /** Show "Searching…" (only once the pause has passed with the answer still out). */
  slow: boolean;
  error: string | null;
}

const ARROW = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>`;

function rowHtml(r: QuickRow, i: number, sel: number, q: string): string {
  const on = i === sel;
  const lead = r.person
    ? `<span class="cnpy-qs-ic cnpy-qs-av">${personChip(r.person, 16, r.person.handle)}</span>`
    : r.group === "all" ? `<span class="cnpy-qs-ic">${ARROW}</span>` : "";
  return `<div class="cnpy-qs-row${on ? " is-sel" : ""}${r.group === "all" ? " cnpy-qs-all" : ""}" role="option" id="cnpy-qs-o-${i}" data-qi="${i}" aria-selected="${on}">
    ${lead}<span class="cnpy-qs-main"><span class="cnpy-qs-t">${highlight(r.title, q)}</span>${r.context ? `<span class="cnpy-qs-c">${highlight(r.context, q)}</span>` : ""}</span>${r.meta ? `<span class="cnpy-qs-m">${esc(r.meta)}</span>` : ""}
  </div>`;
}

/** The panel's list: grouped rows (group head = icon + label), the "all results" row, and
 *  the states — "Searching…" only once slow, "No results for “x”", an error line that
 *  sits ABOVE whatever rows are still shown (it never blocks typing). */
export function quickBodyHtml(p: QuickBodyProps): string {
  const q = p.q.trim();
  let i = 0;
  const groups = p.groups.filter((g) => g.rows.length).map((g) => {
    const head = QUICK_GROUPS[g.id];
    const rows = g.rows.map((r) => rowHtml(r, i++, p.sel, q)).join("");
    return `<div class="cnpy-qs-g" role="group" aria-label="${attr(head.label)}"><div class="cnpy-qs-gh">${head.icon}<span>${esc(head.label)}</span></div>${rows}</div>`;
  }).join("");
  const any = i > 0;
  const status = p.error
    ? `<div class="cnpy-qs-note is-err" role="status">${esc(p.error)}</div>`
    // Over rows already on screen it floats in the corner, so nothing under the pointer moves.
    : p.status === "searching" && p.slow ? `<div class="cnpy-qs-note${any ? " is-float" : ""}" role="status">Searching…</div>`
    : p.status === "ok" && !any && q.length >= QUICK_MIN_CHARS ? `<div class="cnpy-qs-note" role="status">No results for “${esc(q)}”</div>`
    : "";
  const all = q ? `<div class="cnpy-qs-g cnpy-qs-gall">${rowHtml(flatRows([], q)[0], i, p.sel, "")}</div>` : "";
  return `${status}${groups}${all}`;
}

// ── the LRU ──────────────────────────────────────────────────────────────────

/** A tiny LRU keyed by the normalised query; entries go stale after `ttlMs`. */
export class QuickCache {
  private m = new Map<string, { at: number; r: QuickSearchResult }>();
  constructor(private max = 40, private ttlMs = 60_000) {}
  get(k: string, now = Date.now()): QuickSearchResult | null {
    const e = this.m.get(k);
    if (!e) return null;
    if (now - e.at > this.ttlMs) { this.m.delete(k); return null; }
    this.m.delete(k); this.m.set(k, e);               // most recent last
    return e.r;
  }
  set(k: string, r: QuickSearchResult, now = Date.now()): void {
    this.m.delete(k); this.m.set(k, { at: now, r });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  /** The freshest answer for the longest cached PREFIX of `k` (not `k` itself). */
  prefixOf(k: string, now = Date.now()): QuickSearchResult | null {
    for (let n = k.length - 1; n >= QUICK_MIN_CHARS; n--) {
      const hit = this.get(k.slice(0, n), now);
      if (hit) return hit;
    }
    return null;
  }
  clear(): void { this.m.clear(); }
}

export const normQuery = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, " ");

/** A prefix's answer narrowed to hits that still hold every token of the longer query
 *  (in the title, the excerpt or the id) — shown while the real answer is on its way. */
export function narrowResult(r: QuickSearchResult, q: string): QuickSearchResult {
  const alts = alternatives(tokensOf(q));
  const groups = r.groups.map((g) => ({
    type: g.type,
    hits: g.hits.filter((h) => {
      const hay = `${h.title} ${h.snippet ?? ""} ${h.id}`.toLowerCase();
      return alts.every((a) => a.some((t) => hay.includes(t)));
    }),
  })).filter((g) => g.hits.length);
  return { q, groups };
}

// ── the controller (DOM) ─────────────────────────────────────────────────────

export interface QuickSearchDeps {
  fetch(q: string, signal: AbortSignal): Promise<QuickSearchResult>;
  pick(p: QuickPick): void;
  /** The app's resolved theme, for the node that lives outside the app root. */
  theme(): string;
  /** Whether the rail is collapsed (or narrow) right now → palette, never the anchor. */
  railCollapsed(): boolean;
}

export interface QuickSearch {
  /** The sidebar box got a keystroke. */
  input(el: HTMLInputElement, value: string): void;
  /** The sidebar box got focus (reopens on its remaining text). */
  focus(el: HTMLInputElement): void;
  /** A key in the sidebar box; true when the panel consumed it. */
  key(e: KeyboardEvent, el: HTMLInputElement): boolean;
  openPalette(initial?: string): void;
  close(): void;
  isOpen(): boolean;
  /** After every app paint: theme, position, and the sidebar input's aria. */
  sync(): void;
}

/** How soon a keystroke's request starts (the answer is cached, not painted). */
const PREFETCH_MS = 120;
/** How long the person must pause before the panel opens or changes: it never reshapes
 *  under a keystroke. Enter / ⌘Enter / Tab act at once on whatever is typed. */
const PAUSE_MS = 1000;
/** The close animation's length — MUST match `.cnpy-qs-layer[data-closing]` in canopy.css. */
const CLOSE_MS = 160;
const ERROR_LINE = "Search didn’t answer — keep typing to try again.";

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createQuickSearch(deps: QuickSearchDeps): QuickSearch {
  const cache = new QuickCache();
  let layer: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let own: HTMLInputElement | null = null;             // the palette's input
  let anchor: HTMLInputElement | null = null;          // the sidebar's input
  let mode: "anchor" | "palette" | null = null;
  let q = "";
  /** The normalised query the panel's rows were painted for ("" before any paint). */
  let paintedKey: string | null = null;
  let shown: QuickSearchResult | null = null;
  let status: QuickStatus = "idle";
  let slow = false;
  let error: string | null = null;
  let sel = 0;
  let rows: QuickRow[] = [];
  let groups: QuickGroupView[] = [];
  let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;
  /** Bumped on every keystroke: an answer or a pause for an older one is dropped. */
  let seq = 0;
  /** The current keystroke's pause has elapsed (so its answer may paint on arrival). */
  let settled = false;
  /** The current query's request failed. */
  let failed = false;

  const input = (): HTMLInputElement | null => (mode === "palette" ? own : anchor);
  const visible = (): boolean => !!layer?.hasAttribute("data-open") && !layer.hasAttribute("data-closing");

  function build(): void {
    if (layer?.isConnected) return;
    layer = document.createElement("div");
    layer.className = "cnpy-qs-layer";
    layer.innerHTML = `<div class="cnpy-qs" role="dialog" aria-label="Search Canopy">
        <div class="cnpy-qs-inbar">${svg(`<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path>`)}<input class="cnpy-qs-in" placeholder="Search tickets, docs, people, screens…" aria-label="Search Canopy" autocomplete="off" spellcheck="false" role="combobox" aria-controls="cnpy-qs-list" aria-expanded="true" /><kbd class="cnpy-qs-kbd">Esc</kbd></div>
        <div class="cnpy-qs-list cnpy-scroll" id="cnpy-qs-list" role="listbox" aria-label="Results"></div>
        <div class="cnpy-qs-foot"><span><kbd class="cnpy-qs-kbd">↑</kbd><kbd class="cnpy-qs-kbd">↓</kbd> move</span><span><kbd class="cnpy-qs-kbd">↵</kbd> open</span><span><kbd class="cnpy-qs-kbd">Tab</kbd> all</span><span><kbd class="cnpy-qs-kbd">Esc</kbd> close</span></div>
      </div>`;
    panel = layer.querySelector<HTMLDivElement>(".cnpy-qs");
    list = layer.querySelector<HTMLDivElement>(".cnpy-qs-list");
    own = layer.querySelector<HTMLInputElement>(".cnpy-qs-in");
    // A press inside the panel never takes focus from the input it belongs to.
    layer.addEventListener("mousedown", (e) => {
      if (e.target === own) return;
      if (panel?.contains(e.target as Node)) e.preventDefault();
    });
    layer.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-qi]");
      if (row) { choose(Number(row.dataset.qi)); return; }
      if (mode === "palette" && !panel?.contains(e.target as Node)) close();   // the backdrop
    });
    layer.addEventListener("mousemove", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-qi]");
      if (row) select(Number(row.dataset.qi), false);
    });
    own?.addEventListener("input", () => { if (own) onValue(own.value); });
    own?.addEventListener("keydown", (e) => { if (own && handleKey(e)) e.preventDefault(); });
    document.body.appendChild(layer);
  }

  function place(): void {
    if (!layer || !panel) return;
    layer.setAttribute("data-cnpy-theme", deps.theme());
    layer.dataset.mode = mode ?? "";
    if (mode === "anchor" && anchor) {
      const box = (anchor.closest(".cnpy-search") as HTMLElement | null) ?? anchor;
      const r = box.getBoundingClientRect();
      const left = Math.round(r.left);
      const top = Math.round(r.bottom + 6);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      // Thin: the box's width plus a small overhang (≈ 340–380px), never past the 16px gutter.
      panel.style.width = `${Math.min(Math.max(r.width + 140, 340), 380, window.innerWidth - left - 16)}px`;
      panel.style.maxHeight = `${Math.max(200, window.innerHeight - top - 16)}px`;
    } else {
      panel.style.left = panel.style.top = panel.style.width = panel.style.maxHeight = "";
    }
  }

  function aria(): void {
    const el = anchor;
    if (!el) return;
    if (mode === "anchor") {
      el.setAttribute("role", "combobox");
      el.setAttribute("aria-controls", "cnpy-qs-list");
      el.setAttribute("aria-expanded", "true");
      if (rows.length) el.setAttribute("aria-activedescendant", `cnpy-qs-o-${sel}`);
      else el.removeAttribute("aria-activedescendant");
    } else {
      for (const a of ["role", "aria-controls", "aria-expanded", "aria-activedescendant"]) el.removeAttribute(a);
    }
  }

  /** Swap the list, then glide the panel's HEIGHT from what it was to what it is now
   *  (the panel stays open; only its content changed). Opening plays its own entrance. */
  function paint(): void {
    if (!list || !panel || !layer || !mode) return;
    const wasVisible = visible();
    const from = wasVisible ? panel.getBoundingClientRect().height : 0;
    groups = quickGroups(q, shown, { palette: mode === "palette" });
    rows = flatRows(groups, q);
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    const hasBody = rows.length > 0 || !!error || (status === "searching" && slow) || (status === "ok" && q.trim().length >= QUICK_MIN_CHARS);
    layer.toggleAttribute("data-empty", !hasBody);
    list.innerHTML = quickBodyHtml({ q, groups, sel, status, slow, error });
    paintedKey = normQuery(q);
    if (mode === "palette") own?.setAttribute("aria-activedescendant", rows.length ? `cnpy-qs-o-${sel}` : "");
    aria();
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    layer.removeAttribute("data-closing");
    if (!layer.hasAttribute("data-open")) { layer.setAttribute("data-open", "1"); return; }
    // Height: natural now → pin the old height → next frame, the new one (canopy.css transitions it).
    panel.style.height = "";
    const to = panel.getBoundingClientRect().height;
    if (!wasVisible || Math.abs(to - from) < 1 || reducedMotion()) return;
    panel.style.height = `${from}px`;
    void panel.offsetHeight;               // commit the start height before the change
    panel.style.height = `${to}px`;
    const done = (e: TransitionEvent) => {
      if (e.target !== panel || e.propertyName !== "height") return;
      panel?.removeEventListener("transitionend", done);
      if (panel && panel.style.height === `${to}px`) panel.style.height = "";
    };
    panel.addEventListener("transitionend", done);
  }

  function select(i: number, scroll = true): void {
    if (!list || !rows.length) return;
    const n = ((i % rows.length) + rows.length) % rows.length;
    if (n === sel && !scroll) return;
    list.querySelector(".cnpy-qs-row.is-sel")?.classList.remove("is-sel");
    list.querySelector(`#cnpy-qs-o-${sel}`)?.setAttribute("aria-selected", "false");
    sel = n;
    const el = list.querySelector<HTMLElement>(`#cnpy-qs-o-${sel}`);
    el?.classList.add("is-sel");
    el?.setAttribute("aria-selected", "true");
    if (scroll) el?.scrollIntoView({ block: "nearest" });
    input()?.setAttribute("aria-activedescendant", `cnpy-qs-o-${sel}`);
  }

  function stopTimers(): void {
    if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  }

  /** Start the request for the current query unless it is cached or already running. */
  function fetchNow(mine: number): void {
    const key = normQuery(q);
    if (key.length < QUICK_MIN_CHARS || cache.get(key) || ctrl) return;
    const value = q;
    const c = new AbortController();
    ctrl = c;
    deps.fetch(value, c.signal).then((r) => {
      cache.set(key, r);
      if (ctrl === c) ctrl = null;
      if (mine !== seq) return;
      failed = false;
      if (settled) settle(mine);            // the pause already passed: paint on arrival
    }).catch((e: unknown) => {
      if (ctrl === c) ctrl = null;
      if (mine !== seq || c.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      failed = true;
      if (settled) settle(mine);
    });
  }

  /** The person paused (or asked to see results): paint what is known for the query.
   *  Rows already on screen stay put while an answer is still on its way. */
  function settle(mine: number): void {
    if (mine !== seq || !mode) return;
    settled = true;
    const key = normQuery(q);
    error = null; slow = false;
    if (key.length < QUICK_MIN_CHARS) { shown = null; status = "idle"; sel = 0; paint(); return; }
    const hit = cache.get(key);
    if (hit) { shown = hit; status = "ok"; if (paintedKey !== key) sel = 0; paint(); return; }
    if (failed) { status = "error"; error = ERROR_LINE; paint(); return; }
    // Still on its way: keep what is shown (a cached prefix's still-matching hits, when
    // there are some), and say so — it has already been a whole pause.
    const prefix = cache.prefixOf(key);
    if (prefix) { const n = narrowResult(prefix, key); if (n.groups.length) { shown = n; sel = 0; } }
    status = "searching"; slow = true;
    paint();
    fetchNow(mine);
  }

  /** A keystroke: prefetch soon, paint only after the pause. Nothing on screen moves. */
  function onValue(value: string): void {
    q = value;
    ctrl?.abort(); ctrl = null;            // the in-flight request is for older text
    stopTimers();
    const mine = ++seq;
    settled = false; failed = false;
    prefetchTimer = setTimeout(() => { prefetchTimer = null; fetchNow(mine); }, PREFETCH_MS);
    pauseTimer = setTimeout(() => { pauseTimer = null; settle(mine); }, PAUSE_MS);
  }

  /** Paint for the current text now (↑/↓ before the pause, a refocus, ⌘K). */
  function flush(): void {
    stopTimers();
    settle(seq);
  }

  function show(m: "anchor" | "palette"): void {
    build();
    mode = m;
    place();
  }

  function close(): void {
    if (!mode) return;
    ctrl?.abort(); ctrl = null; stopTimers(); seq++;
    const wasPalette = mode === "palette";
    mode = null;
    aria();
    if (anchor) for (const a of ["role", "aria-controls", "aria-expanded", "aria-activedescendant"]) anchor.removeAttribute(a);
    if (wasPalette && own) { own.value = ""; own.blur(); }
    status = "idle"; error = null; slow = false; shown = null; sel = 0; paintedKey = null; settled = false;
    const l = layer;
    if (!l?.hasAttribute("data-open")) return;
    const end = () => { closeTimer = null; l.removeAttribute("data-open"); l.removeAttribute("data-closing"); if (panel) panel.style.height = ""; };
    if (reducedMotion()) { end(); return; }
    l.setAttribute("data-closing", "1");
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(end, CLOSE_MS);
  }

  function seeAll(): void {
    const text = q.trim();
    if (!text) return;
    finish({ kind: "search", q: text });
  }

  function finish(p: QuickPick): void {
    const el = input();
    close();
    if (el) { el.value = ""; el.blur(); }
    q = "";
    deps.pick(p);
  }

  function choose(i: number): void {
    const r = rows[i];
    if (r) finish(r.pick);
  }

  /** The rows on screen belong to what is typed now. */
  const current = (): boolean => visible() && paintedKey === normQuery(q);

  function handleKey(e: KeyboardEvent): boolean {
    if (e.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (!mode) return false;
        if (!current()) { flush(); return true; }      // show them first; the next press moves
        select(sel + (e.key === "ArrowDown" ? 1 : -1));
        return true;
      case "Enter":
        if ((e.metaKey || e.ctrlKey) && q.trim()) { seeAll(); return true; }
        if (mode && current() && rows.length) { choose(sel); return true; }
        // Typed faster than the panel shows: act on the text itself — the Search screen.
        if (q.trim()) { seeAll(); return true; }
        return false;
      case "Tab":
        if (e.shiftKey || !q.trim()) return false;
        seeAll(); return true;
      case "Escape": {
        const el = input();
        close();
        if (el) { el.value = ""; el.blur(); }
        q = "";
        return true;
      }
      default: return false;
    }
  }

  // Outside presses close the anchored panel (the palette closes on its own backdrop).
  document.addEventListener("pointerdown", (e) => {
    if (mode !== "anchor" || !layer) return;
    const t = e.target as Node;
    if (panel?.contains(t) || anchor?.closest(".cnpy-search")?.contains(t)) return;
    close();
  }, true);
  window.addEventListener("resize", () => {
    if (mode === "anchor" && deps.railCollapsed()) { close(); return; }
    place();
  });

  return {
    input(el, value) {
      anchor = el;
      if (deps.railCollapsed()) return;
      if (!value.trim()) { close(); q = value; return; }
      if (mode !== "anchor") show("anchor");
      onValue(value);
    },
    focus(el) {
      anchor = el;
      if (mode === "anchor" || deps.railCollapsed() || !el.value.trim()) return;
      // Back into a box that still holds text: its results come straight back.
      show("anchor");
      q = el.value; seq++;
      flush();
    },
    key(e, el) {
      anchor = el;
      return handleKey(e);
    },
    openPalette(initial = "") {
      if (mode === "anchor") close();
      show("palette");
      if (own) {
        own.value = initial;
        own.focus();
        own.select();
      }
      // ⌘K is a command: the palette (and its jump list) opens at once.
      q = initial; seq++; failed = false;
      flush();
    },
    close,
    isOpen: () => mode !== null,
    sync() {
      if (!mode) return;
      if (mode === "anchor") {
        // The rail collapsed under the open panel, or the box is gone: let go.
        const live = document.querySelector<HTMLInputElement>('[data-field="sideSearch"]');
        if (!live || deps.railCollapsed()) { close(); return; }
        anchor = live;
      }
      place();
      aria();
    },
  };
}
