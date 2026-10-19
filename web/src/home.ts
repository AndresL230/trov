// Home — ported from the Claude Design `Trov Overview v2.dc.html`: a greeting, what needs you, one bar to search or
// ask, the org's three lists (Repositories, Roadmap, For you), Activity, and the Feed beside the team.
//
// Purely presentational: render.ts `homeView` composes the props from reads the app already has plus `GET /home`
// (shared/home-core.ts); interactions dispatch via data-act / data-arg in main.ts. Nothing here invents a number:
// a figure that has not landed is "—", a list still loading draws its rows' shapes.

import type { HomeRange } from "@shared/home-core";
import { markShape, aiMark, type MarkShape } from "./marks";
import { segmented } from "./segmented";
import { esc, attr } from "./ui";

/** A mark: a shape in a tone (marks.ts), as the design's status marks. */
export interface HomeMark { shape: MarkShape; tone: string }

const P = (d: string): string => `<path d="${d}"></path>`;
/** The design's row icons (24-box strokes). */
export const HOME_ICON = {
  repo: P("M6 3v12M15 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0M18 9a9 9 0 0 1-9 9"),
  app: P("M12 3 20 7.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5"),
  sprint: P("M5 21V4M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"),
  ticket: P("M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2zM13 5v2M13 11v2M13 17v2"),
  review: P("M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9 12.5l2 2 4-5"),
  doc: P("M6 3h7l5 5v13H6zM13 3v5h5M9 13h6M9 17h6"),
  decision: P("M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8.5 12.5l2.5 2.5 4.5-5"),
  person: P("M12 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M4 21a8 8 0 0 1 16 0"),
  feed: P("M4 5h16M4 12h16M4 19h10"),
  handoff: P("M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"),
  plus: P("M12 5v14M5 12h14"),
  recent: P("M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4.5h4.5M12 7.5V12l3 2"),
  ask: P("M9.4 12a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0M3.1 5.5a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0M17.1 6.5a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0M15.6 19a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0M3.6 17.5a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0M10 10.2 6.4 6.9M14.2 10.7l3.3-2.7M13.6 14.1l2.7 3.3M10 13.8l-3.1 2.4"),
  artifact: P("M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"),
  prompt: P("M16 18l6-6-6-6M8 6l-6 6 6 6"),
} as const;
export type HomeIcon = keyof typeof HOME_ICON;

const ic = (name: HomeIcon, size = 14, cls = "hm-ic"): string =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOME_ICON[name]}</svg>`;
const CHEV = `<svg class="hm-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>`;
const CHEV_S = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>`;
const DOWN = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
const SEARCH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>`;
const X = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>`;
const GO = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`;

/** A data-act / data-arg pair. */
export interface HomeAct { act: string; arg?: string }
const actAttrs = (a: HomeAct): string => ` data-act="${attr(a.act)}"${a.arg !== undefined ? ` data-arg="${attr(a.arg)}"` : ""}`;

// ── the head: greeting, status, needs attention ──────────────────────────────

export interface HomeAttnRow {
  mark: HomeMark;
  title: string;
  meta: string;
  /** One action, or none (a member's calm row). */
  action: (HomeAct & { label: string }) | null;
}
export interface HomeHead {
  headline: string;
  /** The status line: the first row's mark and a count of what needs the viewer; null while that is not known. */
  status: { mark: HomeMark; text: string } | null;
  attn: { open: boolean; rows: HomeAttnRow[]; more: number; countText: string };
}

function headView(h: HomeHead): string {
  const has = h.attn.rows.length > 0;
  const status = h.status
    ? `<button type="button" class="hm-status"${has ? ` data-act="homeAttn" aria-expanded="${h.attn.open}" aria-haspopup="dialog"` : " disabled"}>
        ${markShape(h.status.mark.shape, h.status.mark.tone, 9)}<span>${esc(h.status.text)}</span>${has ? `<span class="hm-status-chev${h.attn.open ? " is-open" : ""}">${DOWN}</span>` : ""}
      </button>`
    : `<span class="hm-status hm-status-pending" aria-hidden="true"><span class="cnpy-sk" style="width:120px;height:10px"></span></span>`;
  const pop = h.attn.open && has
    ? `<div class="hm-scrim" data-act="homeAttnClose" aria-hidden="true"></div>
      <div class="hm-attn" role="dialog" aria-label="Needs attention">
        <div class="hm-attn-h"><span>Needs attention</span><span class="hm-attn-n">${esc(h.attn.countText)}</span></div>
        ${h.attn.rows.map((r) => `<div class="hm-attn-row">
          ${markShape(r.mark.shape, r.mark.tone, 9)}
          <div class="hm-attn-t"><div class="hm-attn-title">${esc(r.title)}</div><div class="hm-attn-meta">${esc(r.meta)}</div></div>
          ${r.action ? `<button type="button" class="hm-btn hm-btn-sm"${actAttrs(r.action)}>${esc(r.action.label)}</button>` : "<span></span>"}
        </div>`).join("")}
        ${h.attn.more > 0 ? `<div class="hm-attn-more">${h.attn.more} more</div>` : ""}
      </div>`
    : "";
  return `<div class="hm-head">
    <h2 class="hm-h cnpy-rise" style="--i:0">${esc(h.headline)}</h2>
    <div class="hm-statusrow cnpy-rise" style="--i:1">${status}${pop}</div>
  </div>`;
}

// ── the bar: search or ask ───────────────────────────────────────────────────

export interface HomeSearchItem extends HomeAct { icon: HomeIcon; title: string; meta: string; active: boolean; q: string }
export interface HomeSearch {
  q: string;
  mode: "search" | "ask";
  /** Ask Trov is on for this org and person (AskState): the switch shows. */
  askAvail: boolean;
  focused: boolean;
  /** The dropdown under the bar: its groups (Recent / Jump to / results / Try asking), or null when closed. */
  groups: { label: string; items: HomeSearchItem[] }[] | null;
  /** The query matched nothing. */
  none: boolean;
  mac: boolean;
}

function hiTitle(title: string, q: string): string {
  const i = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(title);
  return `${esc(title.slice(0, i))}<b>${esc(title.slice(i, i + q.length))}</b>${esc(title.slice(i + q.length))}`;
}

function searchView(s: HomeSearch, answer: string): string {
  const ask = s.mode === "ask";
  const ph = ask ? "Ask Trov about your organization" : "Search tickets, docs, decisions and people";
  const modeSwitch = s.askAvail
    ? segmented({ id: "home-mode", ariaLabel: "Search or ask", value: s.mode, act: "homeMode", size: "xs", inertOn: true, options: [{ value: "search", label: "Search" }, { value: "ask", label: "Ask Trov" }] })
    : "";
  // The shortcut stays while the bar is focused; only a typed query (with its clear button) takes its place.
  const kbd = !s.q ? `<span class="hm-kbd" aria-hidden="true"><kbd>${s.mac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd></span>` : "";
  const go = ask && s.q.trim() ? `<button type="button" class="hm-go" data-act="homeSubmit" aria-label="Ask Trov">${GO}</button>` : "";
  const clear = s.q ? `<button type="button" class="hm-clear" data-act="homeClear" aria-label="Clear">${X}</button>` : "";
  const icon = ask ? aiMark(14) : SEARCH;
  const drop = s.groups && !answer
    ? `<div class="hm-drop" role="listbox" aria-label="${ask ? "Ask Trov" : "Results"}">
        <div class="hm-drop-list">
          ${s.none ? `<div class="hm-drop-none">No matches for “${esc(s.q)}”.</div>` : ""}
          ${s.groups.map((g) => `<div class="hm-drop-g">${esc(g.label)}</div>${g.items.map((it) => `<button type="button" role="option" aria-selected="${it.active}" class="hm-drop-i${it.active ? " is-active" : ""}"${actAttrs(it)}>
            ${ic(it.icon, 14)}<span class="hm-drop-t"><span class="hm-drop-title">${hiTitle(it.title, it.q)}</span><span class="hm-drop-meta">${esc(it.meta)}</span></span><span class="hm-drop-ret" aria-hidden="true">↵</span>
          </button>`).join("")}`).join("")}
        </div>
        <div class="hm-drop-foot"><span>↑ ↓ to move</span><span>↵ to open</span>${s.askAvail ? `<span>Tab to ${ask ? "search" : "ask Trov"}</span>` : ""}<span class="hm-drop-esc">esc to close</span></div>
      </div>`
    : "";
  return `<div class="hm-bar-wrap cnpy-rise" style="--i:2">
    ${s.focused ? `<div class="hm-scrim" data-act="homeBlur" aria-hidden="true"></div>` : ""}
    <div class="hm-bar-ring${s.focused ? " is-focused" : ""}">
      <div class="hm-bar" data-act="homeFocus">
        <span class="hm-bar-ic${ask ? " is-ask" : ""}">${icon}</span>
        <input class="hm-bar-in" data-act="homeQ" data-field="homeQ" value="${attr(s.q)}" placeholder="${attr(ph)}" aria-label="${attr(ph)}" autocomplete="off" spellcheck="false" />
        ${clear}${modeSwitch}${kbd}${go}
      </div>
    </div>
    ${drop}${answer}
  </div>`;
}

// ── the three lists ──────────────────────────────────────────────────────────

export interface HomeRow extends HomeAct {
  icon: HomeIcon;
  title: string;
  pre?: string;
  post?: string;
  mark?: HomeMark | null;
  trail?: string;
  trailTone?: string;
}
export interface HomeCol extends HomeAct {
  title: string;
  count: number | null;
  /** null while its reads are out (the rows' shapes are drawn). */
  rows: HomeRow[] | null;
  /** Nothing yet: one sentence and, where the viewer can cause it, one action. */
  ghost: { text: string; action: (HomeAct & { label: string }) | null } | null;
}

const countPill = (n: number | null): string => (n ? `<span class="hm-count">${n}</span>` : "");

export function homeRow(r: HomeRow): string {
  return `<button type="button" class="hm-row"${actAttrs(r)}>
    ${ic(r.icon)}
    <span class="hm-row-t">${r.pre ? `<span class="hm-row-pre">${esc(r.pre)}</span>` : ""}<span class="hm-row-title">${esc(r.title)}</span>${r.post ? `<span class="hm-row-post">${esc(r.post)}</span>` : ""}</span>
    ${r.mark ? markShape(r.mark.shape, r.mark.tone, 8) : ""}
    ${r.trail ? `<span class="hm-row-trail"${r.trailTone ? ` style="color:${r.trailTone}"` : ""}>${esc(r.trail)}</span>` : ""}
    ${CHEV}
  </button>`;
}

const skRowsN = (n: number): string =>
  Array.from({ length: n }, (_, i) => `<div class="hm-row hm-row-sk" aria-hidden="true"><span class="cnpy-sk" style="width:14px;height:14px"></span><span class="cnpy-sk" style="width:${[64, 52, 70, 46][i % 4]}%;height:10px"></span></div>`).join("");

function colView(c: HomeCol, i: number): string {
  const body = c.rows === null
    ? skRowsN(3)
    : c.rows.map(homeRow).join("") + (c.ghost
      ? `<div class="hm-ghost"><p>${esc(c.ghost.text)}</p>${c.ghost.action ? `<button type="button" class="hm-btn"${actAttrs(c.ghost.action)}>${esc(c.ghost.action.label)}</button>` : ""}</div>`
      : "");
  return `<section class="hm-col cnpy-rise" style="--i:${3 + i}" aria-label="${attr(c.title)}">
    <div class="hm-sec-h"><button type="button" class="hm-sec-t"${actAttrs(c)}>${esc(c.title)}${countPill(c.count)}${CHEV_S}</button></div>
    ${body}
  </section>`;
}

// ── Activity ─────────────────────────────────────────────────────────────────

export interface HomeCard extends HomeAct {
  label: string;
  /** null = not known ("—"). */
  n: number | null;
  delta: { text: string; tone: string } | null;
  /** One bar per day (or week, on 90 days): its height 0–1, its tooltip. Null: the card is a ghost. */
  bars: { h: number; tip: string }[] | null;
}
export interface HomeActivity {
  range: HomeRange;
  /** null while the read is out; "failed" when it failed. */
  cards: HomeCard[] | null | "failed";
  from: string;
  /** The number of bars a card draws (7, 30 or 13 weeks). */
  nBars: number;
}

function cardView(c: HomeCard, nBars: number, from: string): string {
  const ghost = c.bars === null;
  const bars = ghost
    ? Array.from({ length: nBars }, () => `<span class="hm-bar-b is-ghost"></span>`).join("")
    : c.bars!.map((b, i) => `<span class="hm-bar-b${i === c.bars!.length - 1 ? " is-today" : ""}" style="height:${b.h > 0 ? Math.max(8, Math.round(b.h * 100)) + "%" : "2px"}" data-mtip="${attr(b.tip)}"></span>`).join("");
  return `<button type="button" class="hm-card${ghost ? " is-ghost" : ""}"${actAttrs(c)}>
    <span class="hm-card-l">${esc(c.label)}</span>
    <span class="hm-card-n"${c.n === null ? "" : ` data-count="${c.n}"`}>${c.n === null ? "—" : c.n.toLocaleString("en-US")}</span>
    <span class="hm-card-d"${c.delta ? ` style="color:${c.delta.tone}"` : ""}>${c.delta ? esc(c.delta.text) : ghost ? "Nothing counted yet" : ""}</span>
    <span class="hm-card-bars" aria-hidden="true" style="--gap:${nBars > 14 ? "1.5px" : "4px"}">${bars}</span>
    <span class="hm-card-x" aria-hidden="true"><span>${esc(from)}</span><span>Today</span></span>
  </button>`;
}

function activityView(a: HomeActivity): string {
  const range = segmented({ id: "home-range", ariaLabel: "Range", value: a.range, act: "homeRange", size: "xs", inertOn: true, options: [{ value: "7", label: "7D" }, { value: "30", label: "30D" }, { value: "90", label: "90D" }] });
  const body = a.cards === "failed"
    ? `<div class="hm-failed" role="alert">${markShape("diamond", "var(--red)", 8)}<span>Couldn't load activity.</span><button type="button" class="hm-btn hm-btn-sm" data-act="homeRetry">Try again</button></div>`
    : `<div class="hm-cards">${(a.cards ?? ["Tickets done", "Handoffs claimed", "Docs promoted", "Sessions recorded"].map((label): HomeCard => ({ label, n: null, delta: null, bars: null, act: "" }))).map((c) => cardView(c, a.nBars, a.from)).join("")}</div>`;
  return `<section class="hm-act cnpy-rise" style="--i:6" aria-label="Activity">
    <div class="hm-act-h"><h3>Activity</h3>${range}</div>
    ${body}
  </section>`;
}

// ── Latest and Team ──────────────────────────────────────────────────────────

export interface HomeFeedRow extends HomeAct {
  /** Written by Trov (its mark), else the author's avatar (pre-rendered). */
  trov: boolean;
  avatar: string;
  kind: string;
  text: string;
  mark: HomeMark | null;
  at: string;
}
export interface HomeTeamItem extends HomeAct {
  avatar: string;
  handle: string;
  color: string;
  you: boolean;
  on: string;
  at: string;
  live: boolean;
}

function latestView(rows: HomeFeedRow[] | null, sub: string): string {
  const body = rows === null
    ? skRowsN(5)
    : rows.length === 0
      ? `<div class="hm-ghost"><p>Nothing recorded yet. Decisions, findings and incidents from agent sessions show here.</p></div>`
      : rows.map((e) => `<button type="button" class="hm-row"${actAttrs(e)}>
          ${e.trov ? `<span class="hm-trov" aria-hidden="true">${aiMark(8)}</span>` : e.avatar}
          <span class="hm-row-t">${e.kind ? `<span class="hm-row-pre">${esc(e.kind)}</span>` : ""}<span class="hm-row-title">${esc(e.text)}</span></span>
          ${e.mark ? markShape(e.mark.shape, e.mark.tone, 8) : ""}
          <span class="hm-row-trail">${esc(e.at)}</span>${CHEV}
        </button>`).join("");
  return `<section class="hm-latest cnpy-rise" style="--i:7" aria-label="Latest">
    <div class="hm-sec-h"><button type="button" class="hm-sec-t" data-act="goFeed">Latest${CHEV_S}</button><span class="hm-sec-sub">${esc(sub)}</span></div>
    ${body}
  </section>`;
}

function teamView(rows: HomeTeamItem[] | null, count: number | null, invite: boolean): string {
  const body = rows === null
    ? skRowsN(5)
    : rows.map((r) => `<button type="button" class="hm-row"${actAttrs(r)}>
        <span class="hm-team-av">${r.avatar}<span class="hm-live${r.live ? " is-live" : ""}" aria-hidden="true"></span></span>
        <span class="hm-row-t"><span class="hm-row-title" style="color:${r.color}">@${esc(r.handle)}${r.you ? " (you)" : ""}</span>${r.on ? `<span class="hm-row-post">${esc(r.on)}</span>` : ""}</span>
        ${r.at ? `<span class="hm-row-trail">${esc(r.at)}</span>` : ""}${CHEV}
      </button>`).join("") + (invite
      ? `<div class="hm-ghost hm-ghost-row"><span>Just you so far.</span><button type="button" class="hm-btn" data-act="orgGo" data-arg="members">Invite your team</button></div>`
      : "");
  return `<section class="hm-team cnpy-rise" style="--i:8" aria-label="Team">
    <div class="hm-sec-h"><button type="button" class="hm-sec-t" data-act="orgGo" data-arg="members">Team${countPill(count)}${CHEV_S}</button></div>
    ${body}
  </section>`;
}

// ── the page ─────────────────────────────────────────────────────────────────

export interface HomeProps {
  head: HomeHead;
  search: HomeSearch;
  /** The inline answer under the bar (pre-rendered by the Ask piece), or "". */
  answer: string;
  cols: HomeCol[];
  activity: HomeActivity;
  latest: { rows: HomeFeedRow[] | null; sub: string };
  team: { rows: HomeTeamItem[] | null; count: number | null; invite: boolean };
}

export function homePage(p: HomeProps): string {
  return `<div class="cnpy-scroll hm-scroll"><div class="hm-page" data-screen-label="Home">
    ${headView(p.head)}
    ${searchView(p.search, p.answer)}
    <div class="hm-cols">${p.cols.map(colView).join("")}</div>
    ${activityView(p.activity)}
    <div class="hm-lower">${latestView(p.latest.rows, p.latest.sub)}${teamView(p.team.rows, p.team.count, p.team.invite)}</div>
  </div></div>`;
}
