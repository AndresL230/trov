// My Work — ported from the Claude Design `Canopy Restyled.dc.html` (the My Work
// bento). Trov's own fonts and vocabulary; the design's layout.
//
// Purely presentational: every tile takes pre-read data and renders to an HTML
// string. Interactions dispatch via data-act / data-arg in main.ts. Every tile is
// built on a read the app already has (My Work's DTO, the review queue, the feed,
// handoffs, the Repo dashboard, docs, artifacts) — nothing
// here invents a number: a slice that has not landed reads "Loading…", one that
// failed says so, and an unconnected Repo section says it is not connected.

import type { MyWorkTicket } from "@shared/dashboard";
import type { RepoDashboard, RepoTone } from "@shared/repo";
import { TICKET_STATUS_LABEL } from "@shared/tickets-core";
import type { HandoffView } from "@shared/handoffs";
import type { ReviewHead } from "./triage-map";
import { segmented } from "./segmented";
import { emptyLayout, skeleton, skBar, skBox, skLine, skList, skW, type EmptyAction } from "./skeleton";
import { esc, attr, relTime, surface } from "./ui";

export type MwRepoTab = "prs" | "ci" | "deploys";
export const MW_REPO_TABS: readonly MwRepoTab[] = ["prs", "ci", "deploys"];

/** A slice's readiness, collapsed to what a tile needs to say. */
export type MwLoad = "pending" | "ok" | "error";

/**
 * THE definition of "handoffs waiting on me" — the sidebar's Handoffs badge and My
 * Work's Your sessions tile both count this, so they can never disagree: PENDING
 * handoffs whose recipient is me (case-insensitive, like persons.handle). A
 * handoff I sent to MYSELF counts — handing off to your own fresh session is the
 * common case. One addressed to `anyone` does not: any session in the org can
 * claim it, so it is not waiting on me in particular (the Handoffs screen has it).
 */
export function handoffsForMe(handoffs: readonly HandoffView[], me: string): HandoffView[] {
  const m = me.toLowerCase();
  return m ? handoffs.filter((h) => h.status === "pending" && h.recipient.toLowerCase() === m) : [];
}

const safeUrl = (u: string | null): string => (u && /^https?:\/\//i.test(u) ? u : "#");

// ── shared tile anatomy ──────────────────────────────────────────────────────
// A tile: a surface card (ui.ts `surface()`), 14px title row with a quiet "→" link on the right, an
// optional one-line summary, then hairline-separated rows.
const TILE = "min-width:0;display:flex;flex-direction:column;overflow:hidden";
const ROW = "display:flex;align-items:flex-start;gap:12px;width:100%;text-align:left;padding:10px 16px;border-top:1px solid var(--border)";
const META = "display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:3px;font-size:12.5px;color:var(--fg-40)";
const ROW_TITLE = "display:block;font-size:14px;font-weight:500;color:var(--fg);line-height:1.4;text-wrap:pretty";
const ARROW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`;
const CHEV = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" style="flex:none;margin-top:4px"><path d="M9 6l6 6-6 6"></path></svg>`;

const dot = (color: string, extra = ""): string =>
  `<span style="width:7px;height:7px;border-radius:50%;background:${color};flex:none${extra}"></span>`;
const sep = `<span>·</span>`;

/** Tile header: title (+ an optional trailing bit, e.g. the repo name) and a quiet link. */
function tileHead(title: string, link: { act: string; label: string; arg?: string } | null, trail = ""): string {
  const go = link
    ? `<button data-act="${attr(link.act)}"${link.arg ? ` data-arg="${attr(link.arg)}"` : ""} class="mw-more" style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:var(--fg-40);white-space:nowrap;padding:0">${esc(link.label)}${ARROW}</button>`
    : "";
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 0">
    <span style="display:inline-flex;align-items:baseline;gap:8px;min-width:0;white-space:nowrap"><span style="font-size:14px;font-weight:500">${title}</span>${trail}</span>${go}
  </div>`;
}
const tileSub = (html: string): string => `<div style="font-size:13px;color:var(--fg-55);padding:2px 16px 10px">${html}</div>`;
/** A tile's body when it has no rows to show (loading, failed, empty). */
const tileNote = (text: string): string => `<div style="padding:12px 16px 14px;border-top:1px solid var(--border);font-size:13px;color:var(--fg-40);line-height:1.5">${text}</div>`;
/** A tile's rows while its read is out: `n` rows in the tile's own row box (a lead
 *  label, a title line over a meta line, a trailing stamp) — so the rows that land sit
 *  where the bars were. `key` names the tile. */
interface TileRowShape { lead?: number; trail?: number; pad?: string; top?: number }
/** The tile's rows as shapes — ONE builder for the loading skeleton and the empty layout. */
function tileRows(n: number, o: TileRowShape = {}): string {
  const row = (i: number) => `<div style="display:flex;align-items:flex-start;gap:12px;padding:${o.pad ?? "10px 16px"};border-top:1px solid var(--border)">
      ${o.lead ? skBar(o.lead, 9, "margin-top:6px") : ""}
      <span class="cnpy-skcol">${skLine(skW(i), 14, 1.4)}<span style="display:block;margin-top:3px">${skLine(skW(i + 1, ["42%", "34%", "50%"]), 12.5, 1.5)}</span></span>
      ${o.trail ? skBar(o.trail, 9, "margin-top:6px") : ""}
    </div>`;
  return skList(n, row);
}
function tileSkeleton(key: string, n: number, o: TileRowShape = {}): string {
  return skeleton(`mw-${key}`, "Loading&hellip;", tileRows(n, o), o.top ? `padding-top:${o.top}px` : "");
}
/** A tile that has loaded and holds nothing: its one sentence (and action) where the first
 *  row goes, then the rows it will have, drawn empty (skeleton.ts `emptyLayout`). */
function tileEmpty(key: string, text: string, action: EmptyAction | null, n: number, o: TileRowShape = {}): string {
  return emptyLayout(`mw-${key}`, { text, action, plain: true, shapes: tileRows(n, o), sayStyle: "padding:12px 16px 14px;border-top:1px solid var(--border)", style: o.top ? `padding-top:${o.top}px` : "" });
}
const tile = (area: string, span: number, label: string, inner: string, extra = ""): string =>
  `<section${surface(`${TILE};--span:${span}${extra}`, { cls: "mw-tile cnpy-rise" })} data-mw="${area}" data-screen-label="My Work · ${attr(label)}">${inner}</section>`;

const TONE: Record<RepoTone, string> = { good: "var(--green)", warn: "var(--amber)", bad: "var(--red)", neutral: "var(--fg-40)" };
const TICKET_DOT: Record<MyWorkTicket["status"], string> = { submitted: "var(--blue)", in_progress: "var(--accent)", testing: "var(--amber)" };
/** Priority keeps Trov's monochrome rule (weight, not hue, carries it). */
const PRIO_COLOR: Record<MyWorkTicket["priority"], string> = { high: "var(--fg)", normal: "var(--fg-55)", low: "var(--fg-40)" };
const prioLabel = (text: string, color: string): string =>
  `<span style="font-family:var(--label);font-size:12px;font-weight:600;color:${color};flex:none;margin-top:2px;width:44px">${esc(text)}</span>`;

// ── rows ─────────────────────────────────────────────────────────────────────

/** A ticket's due date — its sprint's — and whether it falls within the next week, or has passed. */
export interface MwDue { label: string; soon: boolean; overdue?: boolean }

/** One ticket assigned to me. The row NAVIGATES (a ticket is a D1 row on this
 *  origin, never the GitHub issue itself — ADR-007), and shows no numeric id. */
export function mwTicketRow(t: MyWorkTicket, due: MwDue | null = null): string {
  return `<button data-act="openTicket" data-arg="${t.id}" class="mw-row" style="${ROW}">
    ${prioLabel(t.priority === "normal" ? "Normal" : t.priority === "high" ? "High" : "Low", PRIO_COLOR[t.priority])}
    <span style="flex:1;min-width:0;display:block">
      <span style="${ROW_TITLE}">${esc(t.title)}</span>
      <span style="${META}">
        <span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap">${dot(TICKET_DOT[t.status])}${esc(TICKET_STATUS_LABEL[t.status])}</span>
        ${sep}<span style="white-space:nowrap">${esc(t.sprint?.label ?? "Backlog")}</span>
        ${due ? `${sep}<span style="white-space:nowrap;color:${due.overdue ? "var(--red)" : due.soon ? "var(--amber)" : "var(--fg-40)"}">${due.overdue ? "overdue" : "due"} ${esc(due.label)}</span>` : ""}
      </span>
    </span>${CHEV}
  </button>`;
}

// ── tiles ────────────────────────────────────────────────────────────────────

/** `total` = the uncapped count when `rows` is a capped read (else rows.length). */
export interface MwListSlice<T> { load: MwLoad; rows: T[]; total?: number; expanded?: boolean }

/** The design's tile height: at most this many rows until the person asks for more. */
export const MW_ROWS = 3;
const FOOT_BTN = "padding:9px 16px;font-size:12.5px;color:var(--fg-40);text-align:left";
/** "Show N more" reveals only rows already loaded (N is what a click can actually
 *  show); what lies past the capped read is a link to where it lives. */
function capped<T>(sl: MwListSlice<T>, area: string, row: (x: T) => string, beyond: { act: string; label: (n: number) => string } | null = null): string {
  const shown = sl.expanded ? sl.rows : sl.rows.slice(0, MW_ROWS);
  const extra = sl.rows.length - MW_ROWS;
  const past = Math.max(0, (sl.total ?? sl.rows.length) - sl.rows.length);
  const toggle = extra > 0
    ? `<button data-act="mwMore" data-arg="${area}" class="mw-more" style="${FOOT_BTN}">${sl.expanded ? "Show less" : `Show ${extra} more`}</button>`
    : "";
  const link = beyond && past > 0 && (sl.expanded || extra <= 0)
    ? `<button data-act="${attr(beyond.act)}" class="mw-more" style="${FOOT_BTN};display:inline-flex;align-items:center;gap:4px;margin-left:auto">${esc(beyond.label(past))}${ARROW}</button>`
    : "";
  const foot = toggle || link
    ? `<div style="display:flex;align-items:center;gap:8px;border-top:1px solid var(--border);margin-top:auto">${toggle}${link}</div>`
    : "";
  return `<div style="display:flex;flex-direction:column;flex:1">${shown.map(row).join("")}${foot}</div>`;
}

/** My Work's empty sentences — each says what the tile shows (the Guide's own words for it,
 *  render.ts `guideView` › My Work) and how the first thing gets there. */
export const MW_EMPTY = {
  tickets: "No tickets are assigned to you. Your open tickets show here, with their sprint and when it is due.",
  review: "Nothing waiting on your review. Doc changes and decisions agents stage show up here to promote or ratify.",
  sessions: "Nothing recorded yet. Run record-session at the end of a session and it lands here.",
  repo: "No repository is connected. Pull requests, CI and deploys show here at a glance once one is.",
} as const;

export function ticketsTile(sl: MwListSlice<MyWorkTicket>, degraded: boolean, span: number, dueOf: (t: MyWorkTicket) => MwDue | null = () => null): string {
  const total = Math.max(sl.total ?? 0, sl.rows.length);
  const soon = sl.rows.filter((t) => dueOf(t)?.soon).length;
  const late = sl.rows.filter((t) => dueOf(t)?.overdue).length;
  const sub = total
    ? tileSub(`${total} open${soon ? ` · <span style="color:var(--amber)">${soon} due this week</span>` : ""}${late ? ` · <span style="color:var(--red)">${late} overdue</span>` : ""}`)
    : "";
  const body = degraded ? tileNote("Couldn't load your assigned tickets right now.")
    : sl.load === "pending" ? tileSkeleton("tickets", MW_ROWS, { lead: 32 })
    : sl.rows.length === 0 ? tileEmpty("tickets", MW_EMPTY.tickets, { label: "Submit a ticket", act: "newTicket" }, 2, { lead: 32 })
    : capped(sl, "tickets", (t) => mwTicketRow(t, dueOf(t)), { act: "mwAllTickets", label: (n) => `${n} more in the queue` });
  return tile("tickets", span, "Tickets for you", `${tileHead("Tickets for you", { act: "goTickets", label: "Queue" })}${sub}${body}`);
}

/** Needs your review: the Review queue's top three, each with its verdict buttons (the
 *  same reviewAccept / reviewReject acts the Review screen dispatches). */
export function reviewTile(items: ReviewHead[], load: MwLoad, span: number): string {
  const head = tileHead(`<span style="display:inline-flex;align-items:center;gap:7px">${dot("var(--accent)")}Needs your review</span>`, { act: "goReview", label: "View all" });
  if (load === "pending") return tile("review", span, "Needs your review", `${head}${tileSkeleton("review", 2, { trail: 96, top: 12 })}`);
  if (load !== "ok") return tile("review", span, "Needs your review", `${head}${tileNote("Couldn't load the review queue.")}`);
  if (items.length === 0) {
    // Clear: the tile keeps its place (and its header) and draws its rows empty.
    return tile("review", span, "Needs your review", `${head}${tileEmpty("review", MW_EMPTY.review, null, 2, { trail: 96, top: 12 })}`);
  }
  const staged = items.filter((i) => i.kind === "proposal").length;
  const decide = items.length - staged;
  const sentence = [staged ? `${staged} to promote` : "", decide ? `${decide} to ratify` : ""].filter(Boolean).join(", ");
  const rows = items.slice(0, 3).map((it) => `<div class="mw-row" style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--border)">
      <button data-act="mwOpenReview" data-arg="${attr(it.id)}" style="flex:1;min-width:0;display:block;text-align:left;padding:0">
        <span style="${ROW_TITLE}">${esc(it.title)}</span>
        <span style="${META};margin-top:4px">
          <span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap">${dot(it.badgeColor)}<span style="font-family:var(--label);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">${esc(it.badge)}</span></span>
          ${sep}<span style="white-space:nowrap;color:var(--fg-55)">${it.kind === "decision" ? "Decision" : "Proposal"}</span>
          ${sep}<span style="white-space:nowrap">${esc(it.time)}</span>
        </span>
      </button>
      <div style="display:flex;align-items:center;gap:6px;flex:none">
        <button data-act="reviewReject" data-arg="${attr(it.id)}" class="mw-reject" style="height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--border);font-size:12px;font-weight:500;color:var(--fg-70)">Reject</button>
        <button data-act="reviewAccept" data-arg="${attr(it.id)}" class="cnpy-accentbtn" style="height:26px;padding:0 10px;border-radius:6px;background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:500">${it.kind === "decision" ? "Ratify" : "Promote"}</button>
      </div>
    </div>`).join("");
  const more = items.length > 3
    ? `<button data-act="goReview" class="mw-more" style="padding:9px 16px;border-top:1px solid var(--border);font-size:12.5px;color:var(--fg-40);margin-top:auto;text-align:left">${items.length - 3} more in Review</button>`
    : "";
  return tile("review", span, "Needs your review", `${head}
    <div style="display:flex;align-items:baseline;gap:10px;padding:8px 16px 12px;flex-wrap:wrap">
      <span style="font-size:32px;font-weight:500;letter-spacing:-0.03em;line-height:1;font-variant-numeric:tabular-nums">${items.length}</span>
      <span style="font-size:13.5px;color:var(--fg-55);white-space:nowrap">${sentence}</span>
    </div>
    <div style="display:flex;flex-direction:column;flex:1">${rows}${more}</div>`);
}

/** Your sessions: what I recorded to the Feed lately (My Work's OWN read — never the
 *  Feed screen's filtered list), then the handoffs waiting on me (`handoffsForMe`). */
export interface MwSession { id: number; summaryHtml: string; brief: string | null; at: string }
export interface MwHandoff { id: number; title: string; at: string }
export function sessionsTile(sessions: MwSession[], feedLoad: MwLoad, handoffs: MwHandoff[], span: number): string {
  // The line speaks only when a handoff IS waiting — "none" is the library strip's
  // Queued handoffs cell's to say, not a second time up here.
  const sub = handoffs.length
    ? tileSub(handoffs.length === 1 ? "1 handoff waiting for a fresh session" : `${handoffs.length} handoffs waiting for a fresh session`)
    : `<div style="height:12px"></div>`;
  const rows = sessions.map((x) => `<button data-act="goFeed" class="mw-row" style="${ROW};display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px">
      <span style="min-width:0;font-size:14px;font-weight:500;color:var(--fg);line-height:1.4;text-wrap:pretty" class="cnpy-md-inline">${x.summaryHtml}</span>
      <span style="font-size:12.5px;color:var(--fg-40);white-space:nowrap;padding-top:2px">${relTime(x.at)}</span>
      ${x.brief ? `<span style="font-size:12.5px;line-height:1.5;color:var(--fg-40);grid-column:span 2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.brief)}</span>` : ""}
    </button>`).join("");
  const body = feedLoad === "pending" && sessions.length === 0 ? tileSkeleton("sessions", 2, { trail: 40 })
    : feedLoad === "error" && sessions.length === 0 ? tileNote("Couldn't load your recent sessions.")
    : sessions.length === 0 ? tileEmpty("sessions", MW_EMPTY.sessions, null, 2, { trail: 40 })
    : rows;
  const pills = handoffs.slice(0, 1).map((h) => `<button data-act="openHandoff" data-arg="${h.id}" class="mw-handoff" style="display:flex;align-items:flex-start;gap:8px;min-width:0;width:100%;text-align:left;padding:7px 10px;border-radius:7px;background:color-mix(in srgb,var(--blue) 6%,transparent);border:1px solid color-mix(in srgb,var(--blue) 25%,transparent)">
      ${dot("var(--blue)", ";margin-top:6px")}
      <span style="min-width:0;flex:1;font-size:13px;line-height:1.45;color:var(--fg);text-wrap:pretty"><span style="font-family:var(--label);font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--blue);margin-right:8px">For you</span>${esc(h.title)}</span>
      ${CHEV}
    </button>`).join("");
  const handoffBlock = pills ? `<div style="display:flex;flex-direction:column;gap:6px;padding:10px 16px 12px;border-top:1px solid var(--border);margin-top:auto">${pills}</div>` : "";
  return tile("sessions", span, "Your sessions", `${tileHead("Your sessions", { act: "goFeed", label: "Feed" })}${sub}<div style="display:flex;flex-direction:column">${body}</div>${handoffBlock}`);
}

// ── repo monitor ─────────────────────────────────────────────────────────────
interface RepoPanel { head: string; headColor: string; sub: string; rows: { tone: string; title: string; ref: string; time: string; href?: string }[]; note?: string }

const NOT_CONNECTED = "Not connected yet — the Repo dashboard says what it waits on.";
const NOTHING = "Nothing captured in this window.";

function repoPanel(d: RepoDashboard, tab: MwRepoTab): RepoPanel {
  const none = (note: string): RepoPanel => ({ head: "", headColor: "", sub: "", rows: [], note });
  const gate = (st: "ok" | "empty" | "not_connected"): RepoPanel | null =>
    st === "not_connected" ? none(NOT_CONNECTED) : st === "empty" ? none(NOTHING) : null;
  if (tab === "ci") {
    const s = d.ciFailures;
    if (s.status !== "ok") return gate(s.status)!;
    // `total`, not `rows.length`: the list is capped at 5. `rate` is already a
    // percentage (3.5 = 3.5%).
    const { rows, total } = s.data;
    return {
      head: total ? String(total) : "No", headColor: total ? "var(--red)" : "var(--green)",
      sub: `CI failure${total === 1 ? "" : "s"} this week${s.data.rate !== null ? ` · ${s.data.rate.toFixed(1)}% of runs` : ""}`,
      rows: rows.slice(0, 3).map((r) => ({ tone: "var(--red)", title: r.job ? `${r.workflow} · ${r.job}` : r.workflow, ref: r.branch, time: relTime(r.at), href: r.url })),
    };
  }
  if (tab === "deploys") {
    const s = d.environments;
    if (s.status !== "ok") return gate(s.status)!;
    const envs = s.data;
    const latest = (e: (typeof envs)[number]) => e.parts.filter((p) => p.deployedAt).sort((a, b) => (b.deployedAt ?? "").localeCompare(a.deployedAt ?? ""))[0] ?? null;
    // The pill's own words: DOWN (unreachable) is not FAILING (a deploy failed).
    const down = envs.filter((e) => e.pill === "DOWN").length;
    const failing = envs.filter((e) => e.pill === "FAILING").length;
    return {
      head: String(envs.length), headColor: down || failing ? "var(--red)" : "var(--fg)",
      sub: `environment${envs.length === 1 ? "" : "s"}${down ? ` · ${down} down` : ""}${failing ? ` · ${failing} failing` : ""}`,
      rows: envs.map((e) => { const p = latest(e); return { tone: TONE[e.tone], title: `${e.name} · ${e.pill.toLowerCase()}`, ref: p?.sha ? p.sha.slice(0, 7) : "", time: p?.deployedAt ? relTime(p.deployedAt) : "" }; }),
    };
  }
  const s = d.prs;
  if (s.status !== "ok") return gate(s.status)!;
  // The count is the projection's `openCount` (the Overview's "Open PRs"),
  // never counted off the capped list — and `null` means open PRs are not
  // captured yet, so say that rather than read "0 open".
  const { rows, openCount } = s.data;
  const open = rows.filter((p) => p.state === "review" || p.state === "approved" || p.state === "draft");
  const list = open.length ? open : rows;
  const tone = { review: "var(--blue)", approved: "var(--green)", draft: "var(--fg-40)", merged: "var(--accent)", closed: "var(--fg-40)" } as const;
  const shown = list.slice(0, 3).map((p) => ({ tone: tone[p.state], title: p.title, ref: `#${p.number}`, time: relTime(p.at), href: p.url }));
  if (openCount === null) {
    return { head: "", headColor: "", sub: "Open PRs not captured yet — showing recent merged/closed", rows: shown };
  }
  return {
    head: String(openCount), headColor: "var(--fg)",
    sub: `open pull request${openCount === 1 ? "" : "s"}${open.length || !rows.length ? "" : " · latest below"}`,
    rows: shown,
  };
}

export function repoTile(repo: RepoDashboard | null, load: MwLoad, tab: MwRepoTab, span: number, o: { noRepo?: boolean; admin?: boolean } = {}): string {
  // Sample data (the Repo screen's "Preview with sample data", session-only)
  // replaces `state.repo` wholesale — there is no live payload left to show
  // instead — so it stays on the tile, but never unlabelled.
  const sampleTag = repo?.sample ? `<span class="mw-repo-sample" style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:1px 6px;white-space:nowrap">Sample data</span>` : "";
  const name = repo?.repo || sampleTag ? `<span style="display:inline-flex;align-items:center;gap:8px;min-width:0">${sampleTag}${repo?.repo ? `<span style="font-family:var(--label);font-size:12px;color:var(--fg-40)">${esc(repo.repo)}</span>` : ""}</span>` : "";
  const head = tileHead("Repo", { act: "goRepo", label: "Dashboard" }, name);
  const tabs = `<div style="padding:10px 16px 12px">${segmented({
    id: "mw-repo", ariaLabel: "Repo view", value: tab, act: "mwRepoTab", size: "xs", inertOn: true,
    options: [{ value: "prs", label: "PRs" }, { value: "ci", label: "CI" }, { value: "deploys", label: "Deploys" }],
  })}</div>`;
  // Three rows (a dot, a title, a stamp) — the panel's own boxes, for the skeleton and the empty layout.
  const row = (i: number) => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 16px;border-top:1px solid var(--border)">${skBox(7, 7)}${skLine(skW(i), 14, 1.45)}${skBar(34, 9)}</div>`;
  // The organization has no repository (`GET /me` said so — read, not guessed): nothing to monitor yet.
  // Only an admin can connect one, so only an admin is offered the way there.
  if (o.noRepo && !repo?.sample) {
    return tile("repo", span, "Repo monitor", `${head}${tabs}${emptyLayout("mw-repo", { text: MW_EMPTY.repo, action: o.admin ? { label: "Connect a repository", act: "orgGo", arg: "repos" } : null, plain: true, shapes: skList(3, row), sayStyle: "padding:10px 16px 14px;border-top:1px solid var(--border)" })}`);
  }
  if (!repo && load !== "error") {
    // The summary line, then the three rows.
    return tile("repo", span, "Repo monitor", `${head}${tabs}${skeleton("mw-repo", "Loading&hellip;", `<div style="padding:10px 16px;border-top:1px solid var(--border)">${skLine("46%", 13.5, 1.5)}</div>${skList(3, row)}`)}`);
  }
  if (!repo) return tile("repo", span, "Repo monitor", `${head}${tabs}${tileNote("Couldn't load the Repo dashboard.")}`);
  const p = repoPanel(repo, tab);
  const inner = p.note
    ? tileNote(p.note)
    : `<div class="mw-repo-sum" style="display:flex;align-items:baseline;gap:6px;padding:10px 16px;border-top:1px solid var(--border);font-size:13.5px">${p.head ? `<span style="font-weight:500;color:${p.headColor};font-variant-numeric:tabular-nums;flex:none">${esc(p.head)}</span>` : ""}<span style="color:var(--fg-55);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.sub)}</span></div>
      ${p.rows.map((r) => {
        const open = r.href ? `<a href="${attr(safeUrl(r.href))}" target="_blank" rel="noopener" class="mw-row mw-repo-row" style="text-decoration:none;color:inherit;` : `<div class="mw-repo-row" style="`;
        const close = r.href ? "</a>" : "</div>";
        return `${open}display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 16px;border-top:1px solid var(--border)">
          ${dot(r.tone)}
          <span style="min-width:0;display:flex;align-items:baseline;gap:8px"><span style="font-size:14px;color:var(--fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"${r.title ? ` title="${attr(r.title)}"` : ""}>${esc(r.title)}</span>${r.ref ? `<span style="font-family:var(--label);font-size:12px;color:var(--fg-40);white-space:nowrap;flex:none">${esc(r.ref)}</span>` : ""}</span>
          <span style="font-size:12.5px;color:var(--fg-40);white-space:nowrap">${esc(r.time)}</span>
        ${close}`;
      }).join("")}`;
  return tile("repo", span, "Repo monitor", `${head}${tabs}<div class="mw-repo-swap" style="flex:1;display:flex;flex-direction:column">${inner}</div>`);
}

// ── library strip ────────────────────────────────────────────────────────────
export interface MwLibrary {
  /** "Yours" = docs whose live version you last put there (promoted or edited). */
  docs: { load: MwLoad; total: number; stale: string[] };
  artifacts: { load: MwLoad; publishedThisWeek: number; latest: { slug: string; title: string; at: string } | null };
  /** Queued handoffs: `handoffsForMe` (the badge's definition), newest first. */
  handoffs: { load: MwLoad; count: number; newest: { id: number; title: string; at: string } | null };
}
export function libraryStrip(lib: MwLibrary, span: number): string {
  const cell = (title: string, link: { act: string; label: string }, body: string): string =>
    `<div style="min-width:0;display:flex;flex-direction:column;gap:6px;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:2px 10px"><span style="font-size:14px;font-weight:500;white-space:nowrap">${title}</span><button data-act="${link.act}" class="mw-more" style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:var(--fg-40);white-space:nowrap;padding:0">${esc(link.label)}${ARROW}</button></div>${body}</div>`;
  const line = (html: string) => `<div style="font-size:13px;color:var(--fg-55)">${html}</div>`;
  const quiet = (html: string) => `<div style="font-size:12.5px;color:var(--fg-40);text-wrap:pretty">${html}</div>`;
  // A cell's two lines (the count, then the quiet detail) while its read is out.
  const pending = (l: MwLoad, key: string) => (l === "pending"
    ? skeleton(`mw-lib-${key}`, "Loading&hellip;", `${skLine("38%", 13, 1.5)}<span style="display:block;margin-top:6px">${skLine("64%", 12.5, 1.5)}</span>`)
    : line("Couldn't load."));

  const d = lib.docs;
  const docs = d.load !== "ok" ? pending(d.load, "docs")
    : d.total === 0 ? `${line("No docs yet")}${quiet("Docs you promote or edit show here.")}`
    : `${line(`${d.total} doc${d.total === 1 ? "" : "s"}${d.stale.length ? ` · <span style="color:var(--amber)">${d.stale.length} not updated in 30 days</span>` : ""}`)}${d.stale.length ? quiet(esc(d.stale.slice(0, 3).join(", "))) : quiet("Everything touched in the last month.")}`;
  const a = lib.artifacts;
  const arts = a.load !== "ok" ? pending(a.load, "arts")
    : `${line(`${a.publishedThisWeek} published this week`)}${a.latest ? `<button data-act="artOpen" data-arg="${attr(a.latest.slug)}" class="mw-more" style="text-align:left;padding:0;font-size:12.5px;color:var(--fg-40)">Latest: ${esc(a.latest.title)} · ${relTime(a.latest.at)}</button>` : quiet("No artifacts yet.")}`;
  const h = lib.handoffs;
  const handoffs = h.load !== "ok" ? pending(h.load, "handoffs")
    : h.newest
      ? `${line(`${h.count} for you`)}<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><button data-act="openHandoff" data-arg="${h.newest.id}" class="mw-more" style="min-width:0;flex:1;display:flex;flex-direction:column;text-align:left;padding:0"><span style="font-size:13px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.newest.title)}</span><span style="font-size:12.5px;color:var(--fg-40)">Newest · ${relTime(h.newest.at)}</span></button><button data-act="mwHandoffCopy" data-arg="${h.newest.id}" title="Copy as prompt — paste it into a fresh session" class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:7px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:500;white-space:nowrap;flex:none"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>Copy</button></div>`
      : quiet("No handoffs queued.")

  const div = `<div class="mw-libdiv" style="background:var(--border)"></div>`;
  return tile("library", span, "Your library", `<div class="mw-lib">
    ${cell("Docs you own", { act: "goDocs", label: "Docs" }, docs)}${div}
    ${cell("Artifacts", { act: "goArtifacts", label: "Library" }, arts)}${div}
    ${cell("Queued handoffs", { act: "goHandoffs", label: "Handoffs" }, handoffs)}
  </div>`);
}

/** The design's grid rule: the first two tiles 7/5 (or one full row), the rest in
 *  rows of up to three split evenly, then the strips (review-when-clear + library)
 *  sharing a last row. Returns each key's column span. */
export function mwSpans(order: string[], strips: string[]): Record<string, number> {
  const spans: Record<string, number> = {};
  const split = (keys: string[]) => {
    const w = Math.floor(12 / keys.length);
    keys.forEach((k, i) => { spans[k] = i === keys.length - 1 ? 12 - w * (keys.length - 1) : w; });
  };
  if (order.length === 1) spans[order[0]] = 12;
  else if (order.length > 1) { spans[order[0]] = 7; spans[order[1]] = 5; }
  for (let i = 2; i < order.length; i += 3) split(order.slice(i, i + 3));
  if (strips.length) split(strips);
  return spans;
}

// ── the page ─────────────────────────────────────────────────────────────────
export interface MyWorkLayout {
  greeting: string;
  dateLine: string;
  tiles: string[];
}
export function myWorkLayout(p: MyWorkLayout): string {
  return `<div class="cnpy-scroll" style="max-width:1180px;margin:0 auto;padding:28px 32px 80px">
    <div style="margin-bottom:22px;min-width:0">
      <h2 style="font-size:22px;font-weight:500;letter-spacing:-0.02em;margin:0;line-height:1.2">${p.greeting}</h2>
      <div style="font-size:13.5px;color:var(--fg-55);margin-top:6px;text-wrap:balance">${p.dateLine}</div>
    </div>
    <div class="mw-main"><div class="mw-bento cnpy-stagger">${p.tiles.join("")}</div></div>
  </div>`;
}
