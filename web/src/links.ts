// Relay › Links — agent links in the web app (docs/architecture/handoffs-prompts.md › Agent links › Web).
// The Relay screen's second tab (`#links`): the links waiting for me, my open ones, my drafts and sent
// requests, and the recently ended ones; and one link's page (`#links/<n>`): its topic and reason, both sides,
// the notes thread, a composer for the viewer's OWN side while the link is open, and the person steps the
// viewer may take. Purely presentational: props in, markup out; clicks are `data-act` dispatched in main.ts,
// which calls the /links routes. Ids are the per-org NUMBER, rendered `#12`.
//
// Who may do what is decided HERE for the screen (`linkActionsFor`, `linkCanWrite`, `linkNeedsJoin`) and again by
// the server (src/tools/links.ts), which is the rule; the screen only never offers a step the server would refuse.

import type { LinkView, LinkDetail, LinkNoteView, LinkSideView, LinkSideName, LinkState, LinkTargetBody, LinkPreview, LinkSideKind } from "@shared/links";
import { linkTopicLabel, LINK_NOTE_MAX, LINK_REASON_MAX, LINK_LIVE_MAX, LINK_OPEN_TTL_MS, LINK_IDLE_MS, ASK_THREAD_SESSION_PREFIX } from "@shared/links";
import type { PersonSummary } from "./api";
import { esc, attr, relTime, surface, WORK_SHELL, DETAIL_SHELL, hitArea, HITBOX } from "./ui";
import { personLink, handleLink, personChip } from "./people";
import { linkLine, linkLineState, linkHeroCanvas, HERO_W, HERO_H, type LineSpec, type LineOrb, type LineFlow, type HeroOrb, type HeroSeg, type HeroShape } from "./link-line";
import { linkMark } from "./marks";
import { tabBar, tabPanelAttrs } from "./tabs";
import { confirmModal } from "./confirm";
import { COPY_ICON } from "./prompt-box";
import { segmented } from "./segmented";
import { skeleton, skBar, skBox, skLine, skList, skW, skDetail } from "./skeleton";

// ── the Relay screen's tab bar ────────────────────────────────────────────
export type HandoffsTab = "handoffs" | "links";
export const HANDOFFS_TAB_BAR = "handoffs-tab";

const tabBadge = (n: number, what: string): string =>
  `<span class="cnpy-badge" data-n="${n}" title="${attr(`${n} ${what} waiting for you`)}">${n}</span>`;

/** Handoffs | Links. Each tab carries its own count of what waits for me — the two numbers the sidebar's
 *  Relay badge adds up. */
export function handoffsTabBar(value: HandoffsTab, counts: { handoffs: number; links: number }): string {
  return tabBar({
    id: HANDOFFS_TAB_BAR, ariaLabel: "Handoffs sections", act: "handoffsTab", value,
    tabs: [
      { value: "handoffs", label: "Handoffs", trail: tabBadge(counts.handoffs, counts.handoffs === 1 ? "handoff" : "handoffs") },
      { value: "links", label: "Links", trail: tabBadge(counts.links, counts.links === 1 ? "link request" : "link requests") },
    ],
  });
}
/** The panel under the bar: the attributes that label it by its tab. */
export const handoffsTabPanel = (value: HandoffsTab): string => tabPanelAttrs(HANDOFFS_TAB_BAR, value);

// ── who may do what ──────────────────────────────────────────────────────────
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** The viewer's side(s) of a link: none, one, or both (a self-link). */
export function viewerSides(l: LinkView, me: string): LinkSideName[] {
  const out: LinkSideName[] = [];
  if (same(l.requester.handle, me)) out.push("requester");
  if (same(l.recipient.handle, me)) out.push("recipient");
  return out;
}

export type LinkAction = "send" | "cancel" | "accept" | "decline" | "close";
/** The person steps this viewer may take on this link now. Requester on a draft: Send, Cancel. Requester on a
 *  request: Cancel. Recipient on a request: Accept, Decline. Either side on an open link: Close. Nothing else —
 *  an ended link has no steps, and someone who is neither side has none. */
export function linkActionsFor(l: LinkView, me: string): LinkAction[] {
  const sides = viewerSides(l, me);
  const req = sides.includes("requester"), rec = sides.includes("recipient");
  if (l.state === "draft") return req ? ["send", "cancel"] : [];
  if (l.state === "requested") return [...(rec ? (["accept", "decline"] as const) : []), ...(req ? (["cancel"] as const) : [])];
  if (l.state === "open") return req || rec ? ["close"] : [];
  return [];
}
/** Whether the viewer may write a note: only on an open link, and only from their own side. */
export const linkCanWrite = (l: LinkView, me: string): boolean => l.state === "open" && viewerSides(l, me).length > 0;
/** Whether the viewer's side of an open link has no session yet (the "Tell your agent" hint). */
export function linkNeedsJoin(l: LinkView, me: string): boolean {
  if (l.state !== "open") return false;
  return viewerSides(l, me).some((s) => l[s].kind === null);
}
/** What the viewer says to their agent to join. */
export const linkJoinPhrase = (id: number): string => `join Trov link #${id}`;

// ── atoms ────────────────────────────────────────────────────────────────────
const personOf = (persons: PersonSummary[], h: string): PersonSummary | null =>
  persons.find((p) => same(p.handle, h)) ?? null;
const nameOf = (persons: PersonSummary[], h: string): string => personOf(persons, h)?.name || h;

/** Inline `code` → a monospace span; everything else escaped (a branch topic reads "branch `feat/x`"). */
const inlineCode = (t: string): string => esc(t).replace(/`([^`]+)`/g, '<span style="font-family:var(--code);font-size:.92em">$1</span>');
/** "with Luke" → "With Luke" (a row's title). */
const capFirst = (t: string): string => (t ? t[0].toUpperCase() + t.slice(1) : t);
/** The topic as markup: `PR #180`, branch `feat/x`, ticket #12, @jose. */
export const linkTopicHtml = (l: Pick<LinkView, "topic">): string => inlineCode(linkTopicLabel(l.topic.kind, l.topic.ref));

/** The Ask thread a side's session names (`ask-thread-<id>`), or null. */
export function askThreadOf(session: string | null): number | null {
  if (!session || !session.startsWith(ASK_THREAD_SESSION_PREFIX)) return null;
  const rest = session.slice(ASK_THREAD_SESSION_PREFIX.length);
  return /^[1-9]\d{0,14}$/.test(rest) ? Number(rest) : null;
}

/** How a side's session reads: "coding session on `branch`", "web chat", "Ask thread" (a link to the thread when it
 *  is the viewer's own — the other side's thread is theirs, and its id never reaches this viewer), or "waiting for a
 *  session". Markup. */
export function linkSessionHtml(side: LinkSideView, mine: boolean): string {
  if (side.kind === "code") return side.branch ? `coding session on <span style="font-family:var(--code);font-size:.92em">${esc(side.branch)}</span>` : "coding session";
  if (side.kind === "chat") return "web chat";
  if (side.kind === "ask") {
    const t = mine ? askThreadOf(side.session) : null;
    return t !== null ? `<a href="#ask/${t}" class="cnpy-mutelink" style="color:inherit;text-decoration:underline;text-underline-offset:2px">Ask thread</a>` : "Ask thread";
  }
  return "waiting for a session";
}

/** Who wrote a note: "@jose's agent", "@jose's Ask thread", or "@jose" when the person wrote it on this page. */
export function noteAuthorHtml(n: Pick<LinkNoteView, "author" | "author_kind">, persons: PersonSummary[]): string {
  const who = handleLink(personOf(persons, n.author), n.author, 12.5);
  if (n.author_kind === "agent") return `${who}<span>'s agent</span>`;
  if (n.author_kind === "ask") return `${who}<span>'s Ask thread</span>`;
  return who;
}

/** When a link last moved: ended, decided, sent, or drafted. */
const lastAt = (l: LinkView): string => l.closed_at ?? l.decided_at ?? l.sent_at ?? l.created_at;

const notice = (text: string): string => `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${esc(text)}</div>`;

// ── the Links tab ────────────────────────────────────────────────────────────
/** The four boxes the tab reads (`GET /links?box=…`). */
export interface LinkBoxes { waiting: LinkView[]; open: LinkView[]; mine: LinkView[]; closed: LinkView[] }
export const NO_LINK_BOXES: LinkBoxes = { waiting: [], open: [], mine: [], closed: [] };

export interface LinksListProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  boxes: LinkBoxes;
  me: string;
  persons: PersonSummary[];
  /** The Handoffs | Links bar (`handoffsTabBar`). */
  bar: string;
  /** The "Start a link" card, while it is open (the header's Start a link button opens it). */
  start?: LinkStart | null;
  /** Whether the past links show all, not just the latest LINKS_PAST_SHOWN. */
  pastAll?: boolean;
  /** A step (Accept / Decline from the constellation or a row) in flight: those buttons wait. */
  busy?: boolean;
}

const ROW_COLS = "grid-template-columns:34px minmax(0,2.6fr) minmax(0,1.2fr) auto 64px";

/** A row's glyph: the link line drawn small and STILL (an inline SVG, no loop) — the requester's orb on the left, the
 *  recipient's on the right, the dots between saying what flows. Decorative: the row's words and mark say it. */
export function linkGlyph(spec: LineSpec): string {
  const orb = (cx: number, o: LineOrb) => {
    if (o === "awake") return `<circle cx="${cx}" cy="7" r="4.6" fill="currentColor" opacity=".9"/><circle cx="${cx}" cy="7" r="2" fill="var(--surface)" opacity=".55"/>`;
    if (o === "calling") return `<circle cx="${cx}" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="${cx}" cy="7" r="1.8" fill="currentColor"/>`;
    if (o === "dim") return `<circle cx="${cx}" cy="7" r="4.6" fill="currentColor" opacity=".28"/>`;
    const op = o === "hollow" || o === "named" ? ".75" : ".32";
    return `<circle cx="${cx}" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1 1.5" opacity="${op}"/>`;
  };
  const dot = (x: number, op: number, r = 0.9) => `<circle cx="${x}" cy="7" r="${r}" fill="currentColor" opacity="${op}"/>`;
  const dots = spec.flow === "flow" ? [dot(13, 0.9), dot(16, 0.6), dot(19, 0.6), dot(22, 0.9)]
    : spec.flow === "trickle" ? [dot(13, 0.35), dot(16.5, 0.6), dot(20, 0.9)]
    : spec.flow === "pulse" ? [dot(16, 0.95, 1.5)]
    : spec.flow === "flicker" ? [dot(13, 0.6)]
    : spec.flow === "stopped" ? [dot(14, 0.25), dot(17.5, 0.25), dot(21, 0.25)] : [];
  return `<svg class="cnpy-lglyph" data-glyph="${spec.flow}" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true" focusable="false">${orb(5.5, spec.left)}${dots.join("")}${orb(28.5, spec.right)}</svg>`;
}

const sectionHead = (label: string, count: number, top = false): string =>
  `<div style="${top ? "" : "margin-top:36px"}"><div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 2px"><div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55);white-space:nowrap">${esc(label)}</div><div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap">${count}</div></div></div>`;
const table = (rows: string): string =>
  `<div${surface("overflow:hidden;margin-top:10px")}><div class="cnpy-stagger" style="margin-bottom:-1px">${rows}</div></div>`;
const emptyLine = (text: string): string =>
  `<div data-links-empty style="text-align:center;padding:24px 28px;color:var(--fg-40);font-size:12.5px;line-height:1.55;max-width:560px;margin:0 auto">${esc(text)}</div>`;

/** Each section's empty sentence, in plain words. */
export const LINKS_EMPTY = {
  past: "No past links yet. A link that ends — closed, declined, cancelled or expired — stays here with its thread.",
} as const;

function linkRowsShape(n: number, off = 0): string {
  const row = (i: number) => `<div class="cnpy-lrow" style="display:grid;${ROW_COLS};gap:12px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--border)">
      ${skBox(34, 14)}<span>${skLine(skW(i), 13.5, 1.5)}${skLine("50%", 12, 1.5)}</span><span style="display:flex;align-items:center;gap:7px">${skBox(20, 20)}${skBar("60%", 9)}</span>${skBox(60, 20)}${skLine(34, 11.5, 1.5, "justify-content:flex-end")}
    </div>`;
  return `<div${surface("overflow:hidden;margin-top:10px")}><div style="margin-bottom:-1px">${skList(n, (i) => row(i + off))}</div></div>`;
}

// ── Start a link (the card at the top of the Links tab) ─────────────────────────
// A person starts a link from here (`POST /links`). First, and the default: BETWEEN MY SESSIONS — a link with
// yourself, open at once, that two of your clients then join ("join Trov link #n"; an Ask thread from a button that
// opens Ask with it typed). Second: WITH A TEAMMATE — pick what it is about (a person, a pull request, a branch, a
// ticket) and say why. Their orb on the right wakes as the card fills in (a faint ring → their photo in a bright
// ring, or Trov's searching globe while it is a PR, branch or ticket whose person the server will find); Send streams
// the particles across and lights it. A refusal says why in place and both orbs dim. The card is part of the Links
// page, which is patched in place (`data-morph="links"`), so typing never rebuilds the page or restarts the line.

export type LinkStartKind = "person" | "pr" | "branch" | "ticket";
export interface LinkStart {
  /** self: between two of my own sessions (target = me, opens at once) · team: with a teammate. */
  mode: "self" | "team";
  kind: LinkStartKind;
  /** The picked teammate's handle (kind person). */
  person: string;
  /** The PR or ticket number, or the branch, as typed (kind pr / branch / ticket). */
  ref: string;
  reason: string;
  /** edit → sending → sent, or → refused (any edit returns to edit). */
  phase: "edit" | "sending" | "sent" | "refused";
  /** The refusal, in words (`linkStartRefusal`). */
  error: string | null;
  /** The link Send created. */
  sent: LinkView | null;
}
export const blankLinkStart = (): LinkStart => ({ mode: "self", kind: "person", person: "", ref: "", reason: "", phase: "edit", error: null, sent: null });

/** The `target` the card names, or null while it names nothing valid yet. */
export function linkStartTarget(d: Pick<LinkStart, "kind" | "person" | "ref"> & { mode?: LinkStart["mode"] }, me = ""): LinkTargetBody | null {
  if (d.mode === "self") return me ? { person: me } : null;
  if (d.kind === "person") return d.person ? { person: d.person } : null;
  const ref = d.ref.trim();
  if (d.kind === "branch") return ref && ref.length <= 200 ? { branch: ref } : null;
  const n = /^#?\d{1,9}$/.test(ref) ? Number(ref.replace("#", "")) : 0;
  if (!(n > 0)) return null;
  return d.kind === "pr" ? { pr: n } : { ticket: n };
}
/** Whether Send may go: a target, and a reason of 1..280 characters. */
export const linkStartReady = (d: LinkStart, me = ""): boolean =>
  !!linkStartTarget(d, me) && !!d.reason.trim() && d.reason.trim().length <= LINK_REASON_MAX && d.phase !== "sending";
/** Whether the card names the viewer themself (a self-link: it opens at once). */
const startsSelf = (d: LinkStart, me: string): boolean => d.mode === "self" || (d.kind === "person" && !!d.person && same(d.person, me));

/** A refusal from `POST /links` in plain words: the cap, who is not a member, what Trov has not captured. */
export function linkStartRefusal(code: string | null, detail: string | null): string {
  const sentence = (t: string) => { const x = t.trim(); return x ? `${x[0].toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? "" : "."}` : ""; };
  if (code === "limit") return `You already have ${LINK_LIVE_MAX} open or requested links. Close or cancel one below, then send this one.`;
  // Trov has no PR #180 → say so, and what to do instead.
  if (code === "not_found" && detail) return `${sentence(detail)} Check the number or the branch's name, or pick the person instead.`;
  if ((code === "not_member" || code === "bad_request") && detail) return sentence(detail);
  if (code === "not_member") return "That person is not a member of this organization.";
  if (code === "not_found") return "Trov has not seen that yet. Check the number or the branch's name.";
  return "Couldn't start this link. Try again in a moment.";
}

/** The line as the card stands: you on the left, them on the right. */
export function linkStartSpec(d: LinkStart, me: string): LineSpec {
  const target = linkStartTarget(d, me);
  // Between my sessions: the other orb is another session of yours, a hollow ring until one joins.
  const them: LineOrb = d.mode === "self" ? "hollow" : !target ? "asleep" : d.kind === "person" ? "named" : "seeking";
  if (d.phase === "sent" && d.sent) {
    const open = d.sent.state === "open";
    return { left: "awake", right: open ? "awake" : "calling", flow: open ? "flow" : "trickle" };
  }
  if (d.phase === "sending") return { left: "awake", right: them, flow: "burst" };
  if (d.phase === "refused") return { left: "dim", right: them === "named" ? "dimhollow" : "dim", flow: "none" };
  const rate = (target ? 0.55 : 0) + (d.reason.trim() ? 0.45 * Math.min(1, d.reason.trim().length / 40) : 0);
  return { left: "awake", right: them, flow: "preview", rate };
}

export interface LinkStartProps { draft: LinkStart; me: string; persons: PersonSummary[] }

const KIND_WORD: Record<LinkStartKind, string> = { person: "Person", pr: "Pull request", branch: "Branch", ticket: "Ticket" };
const START_FIELD = "border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);outline:none";

/** Who the right orb is, in words: a name once one is known, else what Trov will look up. */
function startThem(d: LinkStart, p: LinkStartProps): { name: string; sub: string; known: boolean } {
  if (d.phase === "sent" && d.sent) {
    const h = d.sent.recipient.handle;
    if (d.sent.self) return { name: "Your second session", sub: "not joined yet", known: true };
    return { name: nameOf(p.persons, h), sub: `@${h}`, known: true };
  }
  if (d.mode === "self") return { name: "Another session of yours", sub: "joins once it is open", known: true };
  const ref = d.ref.trim().replace(/^#/, "");
  const t = linkStartTarget(d, p.me);
  switch (d.kind) {
    case "person":
      if (!d.person) return { name: "Who is it with?", sub: "Pick a teammate below", known: false };
      if (same(d.person, p.me)) return { name: "You", sub: "a second session of yours", known: true };
      return { name: nameOf(p.persons, d.person), sub: `@${d.person}`, known: true };
    case "pr": return { name: t ? `PR #${ref}'s author` : "A pull request's author", sub: "Trov finds who opened it", known: false };
    case "branch": return { name: t ? `Whoever pushed ${ref}` : "Whoever pushed a branch", sub: "Trov finds who pushed it last", known: false };
    case "ticket": return { name: t ? `Ticket #${ref}'s assignee` : "A ticket's assignee", sub: "Trov finds who it is assigned to", known: false };
  }
}

/** After a link between your sessions opens: how each kind of client joins it. */
function joinRows(id: number): string {
  const phrase = linkJoinPhrase(id);
  const row = (icon: string, words: string, btn: string) =>
    `<div style="display:flex;align-items:center;gap:10px 12px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border)"><span class="cnpy-lh-ico" style="border-radius:50%;width:26px;color:var(--accent)">${icon}</span><div style="flex:1 1 240px;min-width:0;font-size:13px;line-height:1.5;color:var(--fg-70)">${words}</div>${btn}</div>`;
  return `<div data-link-start-join style="margin-top:6px">
      ${row(clientIcon("code"), `<b style="font-weight:600;color:var(--fg)">Claude Code, or a chat</b> (claude.ai, Desktop, Cursor): say <span style="font-family:var(--code);font-size:12.5px;color:var(--fg)">${esc(phrase)}</span>`,
        `<button type="button" data-act="linkJoinCopy" data-arg="${id}" class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:7px;${OUTLINE}">${COPY_ICON}Copy</button>`)}
      ${row(clientIcon("ask"), `<b style="font-weight:600;color:var(--fg)">An Ask thread</b>: a new thread with it typed for you`,
        `<button type="button" data-act="linkJoinAsk" data-arg="${id}" class="cnpy-outlinebtn" style="${OUTLINE}">Open in Ask</button>`)}
    </div>`;
}

/** The card. Rendered in a stable slot at the top of the Links tab while it is open. */
export function linkStartCard(p: LinkStartProps): string {
  const d = p.draft;
  const self = startsSelf(d, p.me);
  const mine = d.mode === "self" || !!d.sent?.self;
  const mePerson = personOf(p.persons, p.me);
  const themHandle = d.phase === "sent" && d.sent ? d.sent.recipient.handle : d.mode === "team" && d.kind === "person" ? d.person : "";
  const themPerson = themHandle ? personOf(p.persons, themHandle) : null;
  // Between my sessions: two client orbs (a session of yours, and the one that joins); with a teammate: two faces.
  const ico = (k: "code" | "chat" | "ask" | null) => `<span class="cnpy-lh-ico" style="border-radius:50%">${clientIcon(k)}</span>`;
  const faces = mine
    ? { left: ico("code"), right: ico(d.phase === "sent" ? "chat" : null) }
    : { left: personChip(mePerson, 36, p.me), right: themHandle ? personChip(themPerson, 36, themHandle) : undefined };
  const them = startThem(d, p);
  const spec = linkStartSpec(d, p.me);
  const sideWords = (name: string, sub: string, right: boolean, muted: boolean) =>
    `<div style="min-width:0;text-align:${right ? "right" : "left"}"><div style="font-size:13.5px;font-weight:600;color:${muted ? "var(--fg-55)" : "var(--fg)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div><div style="font-size:12px;color:var(--fg-40);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sub)}</div></div>`;
  const leftWords = mine
    ? sideWords(d.phase === "sent" ? "Your first session" : "One session of yours", d.phase === "sent" ? "not joined yet" : "a coding agent, a chat, an Ask thread", false, false)
    : sideWords("You", d.phase === "sent" ? "your agent joins once it is open" : "starting it from here", false, false);

  const line = `<div data-link-start-line style="max-width:520px;margin:4px auto 0">
      ${linkLine(spec, faces)}
      <div data-link-start-sides style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:4px">
        ${leftWords}
        <div data-link-start-them data-known="${them.known}" style="min-width:0">${sideWords(them.name, them.sub, true, !them.known && !linkStartTarget(d, p.me))}</div>
      </div>
    </div>`;

  if (d.phase === "sent" && d.sent) {
    const l = d.sent;
    const body = l.self
      ? `<p data-link-start-sent role="status" style="margin:0 0 4px;font-size:13px;line-height:1.6;color:var(--fg-70)">Link #${l.id} is open: both sides are yours. Join it from two sessions:</p>${joinRows(l.id)}`
      : `<p data-link-start-sent role="status" style="margin:0;font-size:13px;line-height:1.6;color:var(--fg-70)">${l.state === "open"
        ? `Link #${l.id} is open. Tell your agent: <span style="font-family:var(--code);font-size:12.5px">${esc(linkJoinPhrase(l.id))}</span>`
        : `Sent to ${esc(nameOf(p.persons, l.recipient.handle))}. They accept it in Relay; the request lasts 24 hours. Once it is open, tell your agent: <span style="font-family:var(--code);font-size:12.5px">${esc(linkJoinPhrase(l.id))}</span>`}</p>`;
    return `<section data-link-start data-phase="sent"${surface("padding:20px 22px 18px;margin-bottom:26px")} aria-labelledby="link-start-h">
      <h3 id="link-start-h" style="margin:0;font-size:15px;font-weight:600;letter-spacing:-0.01em">${l.state === "open" ? `Link #${l.id} opened` : "Link request sent"}</h3>
      ${line}
      <div data-morph-key="ls-sent" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
        ${body}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button type="button" data-act="linkStartClose" class="cnpy-outlinebtn" style="${OUTLINE}">Done</button>
          <button type="button" data-act="openLink" data-arg="${l.id}" class="cnpy-accentbtn" style="${ACCENT}">Open link #${l.id}</button>
        </div>
      </div>
    </section>`;
  }

  const others = p.persons.filter((x) => !same(x.handle, p.me));
  const chip = (h: string, label: string, av: string) => {
    const on = same(d.person, h);
    return `<button type="button" data-act="linkStartPerson" data-arg="${attr(h)}" data-field="ls-person:${attr(h)}" class="cnpy-pickchip${on ? " is-on" : ""}" aria-pressed="${on}" style="white-space:nowrap;display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:7px;font-size:12.5px;font-weight:500;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : "var(--fg-55)"};background:${on ? "var(--accent-soft)" : "transparent"}">${av}${esc(label)}</button>`;
  };
  const value = d.kind === "person"
    ? `<div role="group" aria-label="Who the link is with" style="display:flex;gap:6px;flex-wrap:wrap;max-height:132px;overflow-y:auto">${others.map((x) => chip(x.handle, x.name || x.handle, personChip(x, 20, x.handle))).join("")}</div>`
    : d.kind === "branch"
      ? `<input id="link-start-ref" data-act="linkStartField" data-arg="ref" data-field="ls-ref-branch" value="${attr(d.ref)}" class="cnpy-input" autocomplete="off" spellcheck="false" placeholder="feat/session-store" aria-label="Branch" style="width:100%;max-width:360px;height:38px;padding:0 12px;${START_FIELD};font-size:13px;font-family:var(--code)">`
      : `<div style="display:flex;align-items:center;gap:8px"><span aria-hidden="true" style="font-family:var(--label);font-size:13px;color:var(--fg-40)">#</span><input id="link-start-ref" data-act="linkStartField" data-arg="ref" data-field="ls-ref-${d.kind}" value="${attr(d.ref)}" class="cnpy-input" inputmode="numeric" autocomplete="off" placeholder="${d.kind === "pr" ? "180" : "12"}" aria-label="${d.kind === "pr" ? "Pull request number" : "Ticket number"}" style="width:120px;height:38px;padding:0 12px;${START_FIELD};font-size:13px;font-family:var(--label)"></div>`;
  const n = d.reason.length;
  const over = n > LINK_REASON_MAX;
  const ready = linkStartReady(d, p.me);
  const sending = d.phase === "sending";
  const refused = d.phase === "refused" && !!d.error;
  const hint = self
    ? "Both sides are yours, so it opens at once. Then each session joins it."
    : "They get the request in Relay to accept or decline. It lasts 24 hours.";
  const label = (t: string, forId: string | null, extra = "") =>
    `<${forId ? `label for="${forId}"` : "div"} style="font-size:13px;font-weight:500;color:var(--fg)${extra}">${t}</${forId ? "label" : "div"}>`;
  const team = d.mode === "team" ? `<div data-morph-key="ls-team" style="display:grid;grid-template-columns:minmax(0,1fr);gap:16px">
        <div style="display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap">
          ${label("About", null, ";width:52px;flex:none")}
          ${segmented({
            id: "link-start-kind", ariaLabel: "What the link is about", act: "linkStartKind", value: d.kind, size: "sm", inertOn: true,
            options: (["person", "pr", "branch", "ticket"] as const).map((k) => ({ value: k, label: KIND_WORD[k] })),
          })}
        </div>
        <div data-morph-key="ls-val-${d.kind}" style="display:flex;gap:10px 14px;flex-wrap:wrap;align-items:flex-start">
          <div aria-hidden="true" style="width:52px;flex:none"></div>
          <div style="flex:1 1 280px;min-width:0">${value}</div>
        </div>
      </div>` : `<div data-morph-key="ls-self"></div>`;
  return `<section data-link-start data-phase="${d.phase}" data-mode="${d.mode}"${surface("padding:20px 22px 18px;margin-bottom:26px")} aria-labelledby="link-start-h">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap">
        <h3 id="link-start-h" style="margin:0;font-size:15px;font-weight:600;letter-spacing:-0.01em">Start a link</h3>
        ${segmented({
          id: "link-start-mode", ariaLabel: "Who the link is between", act: "linkStartMode", value: d.mode, size: "sm", inertOn: true,
          options: [{ value: "self", label: "Between my sessions" }, { value: "team", label: "With a teammate" }],
        })}
      </div>
      ${line}
      <div data-morph-key="ls-form" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);display:grid;grid-template-columns:minmax(0,1fr);gap:16px">
        ${team}
        <div style="display:flex;gap:10px 14px;flex-wrap:wrap;align-items:flex-start">
          ${label("Why", "link-start-reason", ";width:52px;flex:none;padding-top:9px")}
          <div style="flex:1 1 280px;min-width:0">
            <textarea id="link-start-reason" data-act="linkStartField" data-arg="reason" data-field="ls-reason" maxlength="${LINK_REASON_MAX}" aria-describedby="link-start-count" placeholder="${d.mode === "self" ? "What the two sessions share: one fixes the OCR queue while the other plans its copy…" : "What your work and theirs both touch: the session store, the auth routes…"}" class="cnpy-input" style="display:block;width:100%;box-sizing:border-box;min-height:64px;padding:9px 12px;${START_FIELD};font-size:13.5px;line-height:1.55;resize:vertical;font-family:inherit">${esc(d.reason)}</textarea>
            <div id="link-start-count" data-link-start-count style="font-family:var(--label);font-size:11px;margin-top:6px;color:${over ? "var(--red)" : "var(--fg-40)"}">${n.toLocaleString("en-US")} / ${LINK_REASON_MAX}</div>
          </div>
        </div>
        <div data-link-start-error role="alert"${refused ? "" : " hidden"} style="font-size:12.5px;line-height:1.55;color:var(--red)">${refused ? esc(d.error ?? "") : ""}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px 18px;flex-wrap:wrap;padding-top:2px">
          <span data-link-start-hint style="font-size:12px;color:var(--fg-40);flex:1 1 260px">${esc(hint)}</span>
          <div style="display:flex;gap:8px;flex:none">
            <button type="button" data-act="linkStartClose" class="cnpy-outlinebtn" style="${OUTLINE}">Cancel</button>
            <button type="button" data-act="linkStartSend" class="${ready ? "cnpy-accentbtn" : ""}" style="${ready ? ACCENT : `${OUTLINE};color:var(--fg-40);cursor:default`}"${ready ? "" : " disabled"}>${sending ? "Sending…" : self ? "Open link" : "Send request"}</button>
          </div>
        </div>
      </div>
    </section>`;
}

// ── the arc diagram (the top of the Links tab) ─────────────────────────────────
// The story is YOUR clients: a coding agent, a web chat, an Ask thread. Each KIND of client you have on a live link is
// one station on a gentle horizontal line (all your Claude Code sessions fold into one "Claude Code" station; its card
// lists them), your photo where the line starts on the left. A link between two of your own joined sessions is an
// arc ABOVE the line between their stations (one arc per pair of kinds, denser for more links; a small loop over a
// station when both sides are the same kind). A side of yours no session has joined draws nothing: that link waits
// in the rows below, with its "join Trov link #n" hint. Teammates sit BELOW the line, one orb per person, each with a
// quieter arc dropping to them from the station that holds the link — or from your photo when your side has no
// session; a request waiting for you is such an arc whose pulse travels up toward you, with Accept / Decline in a
// callout under the picture. Only clients that are on links exist here. link-line.ts draws it on one canvas; over it
// each station and person is a real link with a card on hover / focus.

/** The links the diagram reads: every live one (waiting for me, open, my drafts and sent requests), once each,
 *  lowest number first. */
export function liveLinks(b: LinkBoxes): LinkView[] {
  const seen = new Map<number, LinkView>();
  for (const l of [...b.waiting, ...b.open, ...b.mine]) if (LIVE.has(l.state) && !seen.has(l.id)) seen.set(l.id, l);
  return [...seen.values()].sort((a, c) => a.id - c.id);
}
const LIVE = new Set<LinkState>(["draft", "requested", "open"]);

/** Whether this live link is a request waiting for the viewer's answer. */
const waitsForMe = (l: LinkView, me: string): boolean => l.state === "requested" && !l.self && same(l.recipient.handle, me);

export type ClientKind = "code" | "chat" | "ask";
/** Stations go left to right in this order (only the kinds you have). */
export const KIND_ORDER: readonly ClientKind[] = ["code", "chat", "ask"];
/** The client a session kind is, in words. */
export const CLIENT_WORD: Record<ClientKind, string> = { code: "Claude Code", chat: "Web chat", ask: "Ask thread" };
/** The same inside a sentence ("your web chat", "your Ask thread"). */
const CLIENT_IN_TEXT: Record<ClientKind, string> = { code: "Claude Code session", chat: "web chat", ask: "Ask thread" };
/** A small line icon per client: a terminal, a speech bubble, Ask's spark. */
export function clientIcon(kind: ClientKind | null): string {
  const p = kind === "code" ? '<path d="M3 4.5l3 3-3 3M7.5 11h5"/>'
    : kind === "chat" ? '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'
    : kind === "ask" ? '<path d="M8 2.5l1.3 3.7 3.7 1.3-3.7 1.3L8 12.5l-1.3-3.7L3 7.5l3.7-1.3z"/>'
    : '<circle cx="8" cy="8" r="4.5" stroke-dasharray="1.6 1.8"/>';
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
}

// The geometry, in canvas px (HERO_W × HERO_H).
export const HERO_BASE_Y = 158;
export const HERO_HUB_X = 56;
export const HERO_PERSON_Y = 282;
const KIND_ORB = 78, PERSON_ORB = 50;
/** Station x by how many kinds there are. */
export const STATION_X: Record<1 | 2 | 3, readonly number[]> = { 1: [330], 2: [300, 540], 3: [270, 450, 630] };
export const PERSON_MAX = 6;
const PERSON_GAP = 92;

export interface HeroSessionInfo { session: string; branch: string | null; seen: string | null; links: LinkView[] }
export interface HeroKind { kind: ClientKind; sessions: HeroSessionInfo[]; x: number; y: number }
export interface HeroPerson { handle: string; links: LinkView[]; x: number; y: number }
type End = { t: "hub" } | { t: "k"; kind: ClientKind } | { t: "p"; handle: string };
export interface HeroLine { links: LinkView[]; a: End; b: End; flow: LineFlow; quiet: boolean; shape: HeroShape }
export interface HeroModel { kinds: HeroKind[]; people: HeroPerson[]; lines: HeroLine[]; asks: LinkView[]; hidden: number; base: [number, number, number] }

const FLOW_RANK: Record<LineFlow, number> = { pulse: 6, burst: 5, flow: 4, trickle: 3, preview: 2, flicker: 1, stopped: 0, none: 0 };

/** Where everything goes, from the viewer's live links (pure; the tests read it). */
export function heroModel(b: LinkBoxes, me: string): HeroModel {
  const live = liveLinks(b);
  const kinds = new Map<ClientKind, HeroKind>();
  /** Fold a joined side of mine into its kind's station; null when no session has joined it. */
  const join = (l: LinkView, side: LinkSideName): ClientKind | null => {
    const s = l[side];
    if (!s.kind || !s.session) return null;
    const k = kinds.get(s.kind) ?? { kind: s.kind, sessions: [], x: 0, y: HERO_BASE_Y };
    kinds.set(s.kind, k);
    let info = k.sessions.find((x) => x.session === s.session);
    if (!info) { info = { session: s.session, branch: s.branch, seen: s.seen_at, links: [] }; k.sessions.push(info); }
    if (!info.links.includes(l)) info.links.push(l);
    return s.kind;
  };
  const lines = new Map<string, HeroLine>();
  const add = (key: string, l: LinkView, a: End, b: End, flow: LineFlow, quiet: boolean, shape: HeroShape) => {
    const have = lines.get(key);
    if (!have) { lines.set(key, { links: [l], a, b, flow, quiet, shape }); return; }
    have.links.push(l);
    if (FLOW_RANK[flow] > FLOW_RANK[have.flow]) have.flow = flow;
  };
  const people = new Map<string, HeroPerson>();
  for (const l of live) {
    if (l.self) {
      const ka = join(l, "requester"), kb = join(l, "recipient");
      // Both sides joined: an arc between their kinds (a loop when the same); otherwise nothing is drawn.
      if (ka && kb) {
        const pair = [ka, kb].sort((x, y) => KIND_ORDER.indexOf(x) - KIND_ORDER.indexOf(y)).join("+");
        add(`self:${pair}`, l, { t: "k", kind: ka }, { t: "k", kind: kb }, linkLineState(l).flow, false, ka === kb ? "o" : "u");
      }
      continue;
    }
    const mine: LinkSideName = same(l.requester.handle, me) ? "requester" : "recipient";
    const theirs: LinkSideName = mine === "requester" ? "recipient" : "requester";
    const h = l[theirs].handle;
    const person = people.get(h.toLowerCase()) ?? { handle: h, links: [], x: 0, y: HERO_PERSON_Y };
    person.links.push(l);
    people.set(h.toLowerCase(), person);
    const k = join(l, mine);
    const my: End = k ? { t: "k", kind: k } : { t: "hub" };
    const them: End = { t: "p", handle: h };
    add(`team:${k ?? "hub"}>${h.toLowerCase()}`, l, mine === "requester" ? my : them, mine === "requester" ? them : my, waitsForMe(l, me) ? "pulse" : linkLineState(l).flow, true, "d");
  }
  // Stations, left to right in KIND_ORDER.
  const ks = KIND_ORDER.filter((k) => kinds.has(k)).map((k) => kinds.get(k)!);
  const xs = ks.length ? STATION_X[ks.length as 1 | 2 | 3] : [];
  ks.forEach((k, i) => { k.x = xs[i]; k.y = HERO_BASE_Y; });
  const xOf = (e: End) => (e.t === "k" ? kinds.get(e.kind)!.x : HERO_HUB_X);
  // People below: near the station (or your photo) their first line leaves from, alternating sides, then spaced.
  const pp = [...people.values()].slice(0, PERSON_MAX);
  const perOrigin = new Map<string, number>();
  const want = pp.map((p) => {
    const line = [...lines.values()].find((x) => x.quiet && [x.a, x.b].some((e) => e.t === "p" && same(e.handle, p.handle)))!;
    const from = line.a.t === "p" ? line.b : line.a;
    const key = from.t === "k" ? from.kind : "hub";
    const n = perOrigin.get(key) ?? 0;
    perOrigin.set(key, n + 1);
    // From your photo they go just right of it, under the line's start; from a station, beside it (never under it,
    // where its words are).
    const steps = from.t === "hub" ? [70, 160, 250, 340] : [95, -95, 185, -185];
    return { p, x: xOf(from) + steps[n % steps.length] };
  }).sort((a, c) => a.x - c.x);
  for (let i = 0; i < want.length; i++) want[i].x = Math.max(want[i].x, i ? want[i - 1].x + PERSON_GAP : 40);
  for (let i = want.length - 1; i >= 0; i--) want[i].x = Math.min(want[i].x, i < want.length - 1 ? want[i + 1].x - PERSON_GAP : HERO_W - 40);
  for (const w of want) { w.p.x = Math.round(w.x); w.p.y = HERO_PERSON_Y; }
  const shownP = new Set(pp.map((p) => p.handle.toLowerCase()));
  const all = [...lines.values()];
  const drawn = all.filter((x) => [x.a, x.b].every((e) => e.t !== "p" || shownP.has(e.handle.toLowerCase())));
  const hidden = new Set(all.filter((x) => !drawn.includes(x)).flatMap((x) => x.links.map((l) => l.id))).size;
  const lastX = ks.length ? ks[ks.length - 1].x + 80 : HERO_HUB_X + 220;
  return { kinds: ks, people: pp, lines: drawn, asks: live.filter((l) => waitsForMe(l, me)), hidden, base: [HERO_HUB_X + 18, lastX, HERO_BASE_Y] };
}

/** A person's orb: listening while a request is between you, awake when their side of an open link has a session. */
function personLook(p: HeroPerson, me: string): LineOrb {
  if (p.links.some((l) => l.state === "requested")) return "calling";
  const theirs = (l: LinkView) => (same(l.requester.handle, me) ? l.recipient : l.requester);
  if (p.links.some((l) => l.state === "open" && theirs(l).kind)) return "awake";
  if (p.links.some((l) => l.state === "open")) return "hollow";
  return "asleep";
}

/** The canvas's orbs and segments for a model: your photo (the hub) first, then stations, then people. */
export function heroCanvasData(m: HeroModel, me: string): { orbs: HeroOrb[]; segs: HeroSeg[] } {
  const orbs: HeroOrb[] = [{ x: HERO_HUB_X, y: HERO_BASE_Y, size: 30, look: "hub" }];
  const idx = new Map<string, number>();
  for (const k of m.kinds) { idx.set(`k:${k.kind}`, orbs.length); orbs.push({ x: k.x, y: k.y, size: KIND_ORB, look: "awake" }); }
  for (const p of m.people) { idx.set(`p:${p.handle.toLowerCase()}`, orbs.length); orbs.push({ x: p.x, y: p.y, size: PERSON_ORB, look: personLook(p, me) }); }
  const at = (e: End) => (e.t === "hub" ? 0 : idx.get(e.t === "k" ? `k:${e.kind}` : `p:${e.handle.toLowerCase()}`) ?? 0);
  const segs = m.lines.map((x) => {
    const notes = x.links.flatMap((l) => (l as Partial<LinkDetail>).notes ?? []);
    const lastLink = x.links[x.links.length - 1] as Partial<LinkDetail>;
    const ln = lastLink.notes ?? [];
    return { id: x.links[0].id, a: at(x.a), b: at(x.b), flow: x.flow, quiet: x.quiet, notes: notes.length, last: ln.length ? ln[ln.length - 1].side : null, n: x.links.length, shape: x.shape };
  });
  return { orbs, segs };
}

/** How a link reads from the viewer's side: "with Luke" for a link about a person, "between your sessions" for a
 *  self-link about you, else its topic ("PR #180", branch `feat/x`, ticket #12). Markup. */
export function linkAboutHtml(l: Pick<LinkView, "topic" | "self" | "requester" | "recipient">, me: string, persons: PersonSummary[]): string {
  if (l.topic.kind !== "person") return linkTopicHtml(l);
  if (l.self) return "between your sessions";
  const other = same(l.requester.handle, me) ? l.recipient.handle : same(l.recipient.handle, me) ? l.requester.handle : l.topic.ref;
  return `with ${esc(nameOf(persons, other))}`;
}
/** The same in plain text (an aria-label). */
const aboutText = (l: LinkView, me: string, persons: PersonSummary[]): string =>
  l.topic.kind === "person" ? linkAboutHtml(l, me, persons).replace(/&#39;/g, "'").replace(/&amp;/g, "&") : `about ${linkTopicLabel(l.topic.kind, l.topic.ref).replace(/`/g, "")}`;

/** Where a live link stands, as the viewer would say it (a card and a label). */
export function heroStateWords(l: LinkView, me: string): string {
  const otherH = same(l.requester.handle, me) ? l.recipient.handle : l.requester.handle;
  if (l.state === "draft") return l.self ? "A draft: not sent yet. Sending opens it at once." : "A draft: not sent yet.";
  if (waitsForMe(l, me)) return `Asks to link with you. Accept or decline it below.`;
  if (l.state === "requested") return l.self ? "Requested." : `Waiting for @${otherH} to accept.`;
  const mineSide = viewerSides(l, me).some((s) => l[s].kind === null);
  return mineSide ? "Open. A side of yours has no session yet." : "Open.";
}

export interface LinksHeroProps { boxes: LinkBoxes; me: string; persons: PersonSummary[]; busy: boolean; status: LinksListProps["status"] }

export function linksHero(p: LinksHeroProps): string {
  const m = heroModel(p.boxes, p.me);
  const { orbs, segs } = heroCanvasData(m, p.me);
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`;
  const at = (x: number, y: number, size: number) => `left:${pct(x, HERO_W)};top:${pct(y, HERO_H)};--s:${size}`;
  const side = (x: number) => (x > HERO_W / 2 ? " is-r" : " is-l");
  const card = (x: number, up: boolean, inner: string) => `<div class="cnpy-lh-card${up ? " is-up" : ""}${side(x)}" aria-hidden="true" style="border-radius:8px">${inner}</div>`;
  /** What is at the other end of one of my links, seen from my session `session` of kind `kind`. */
  const otherEnd = (kind: ClientKind, session: string, l: LinkView): string => {
    if (!l.self) return nameOf(p.persons, same(l.requester.handle, p.me) ? l.recipient.handle : l.requester.handle);
    const mySide: LinkSideName = l.requester.kind === kind && l.requester.session === session ? "requester" : "recipient";
    const o = l[mySide === "requester" ? "recipient" : "requester"];
    return o.kind ? (o.kind === kind ? `another ${CLIENT_WORD[o.kind]} session` : `your ${CLIENT_IN_TEXT[o.kind]}`) : "a session not joined yet";
  };
  const linkBits = (k: ClientKind, s: HeroSessionInfo) => s.links.map((l) => `link #${l.id} with ${otherEnd(k, s.session, l)}`).join("; ");

  const stations = m.kinds.map((k) => {
    const word = CLIENT_WORD[k.kind];
    const n = k.sessions.length;
    const threads = k.kind === "ask" ? k.sessions.map((s) => askThreadOf(s.session)).filter((x): x is number => x !== null) : [];
    const href = k.kind === "ask" ? (threads.length === 1 ? `#ask/${threads[0]}` : "#ask") : `#links/${k.sessions[0].links[0].id}`;
    const what = (s: HeroSessionInfo) => (k.kind === "code" && s.branch ? `on ${s.branch}` : k.kind === "ask" ? "a thread" : "a chat");
    const label = n === 1
      ? `${word}${k.sessions[0].branch ? ` on ${k.sessions[0].branch}` : ""}: ${linkBits(k.kind, k.sessions[0])}.`
      : `${word}, ${n} sessions: ${k.sessions.map((s) => `${what(s)} (${linkBits(k.kind, s)})`).join("; ")}.`;
    const sub = k.kind === "code" && n === 1 && k.sessions[0].branch ? `<span class="cnpy-lh-sub" aria-hidden="true">${esc(k.sessions[0].branch)}</span>` : "";
    const rows = k.sessions.map((s) => `<div style="margin-top:6px"><div style="font-size:12px;color:var(--fg)">${k.kind === "code" && s.branch ? `<span style="font-family:var(--code);font-size:11.5px">${esc(s.branch)}</span>` : esc(k.kind === "ask" ? "An Ask thread" : "A web chat")}</div>${s.links.map((l) => `<div style="font-size:12px;color:var(--fg-55);margin-top:2px"><span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">#${l.id}</span> with ${esc(otherEnd(k.kind, s.session, l))}</div>`).join("")}</div>`).join("");
    return `<div class="cnpy-lh-node is-kind" data-lh-kind="${k.kind}" data-sessions="${n}" style="${at(k.x, k.y, KIND_ORB)}">
        <a class="cnpy-lh-hit" href="${href}" aria-label="${attr(label)}"><span class="cnpy-lh-ico" style="border-radius:50%">${clientIcon(k.kind)}</span></a>
        <span class="cnpy-lh-name" aria-hidden="true">${esc(word)}${n > 1 ? `<span class="cnpy-lh-count"> · ${n}</span>` : ""}</span>${sub}
        ${card(k.x, false, `<div style="font-size:12.5px;font-weight:600;color:var(--fg)">${esc(word)}${n > 1 ? ` <span style="font-weight:400;color:var(--fg-40)">${n} sessions</span>` : ""}</div>${rows}`)}
      </div>`;
  }).join("");

  const people = m.people.map((q) => {
    const name = nameOf(p.persons, q.handle);
    const asking = q.links.some((l) => waitsForMe(l, p.me));
    const label = `${name}: ${q.links.map((l) => `link #${l.id} ${aboutText(l, p.me, p.persons)}, ${heroStateWords(l, p.me).replace(/\.$/, "").toLowerCase()}`).join("; ")}.`;
    return `<div class="cnpy-lh-node is-person${asking ? " is-asking" : ""}" data-lh-person="${attr(q.handle)}" style="${at(q.x, q.y, PERSON_ORB)}">
        <a class="cnpy-lh-hit" href="#links/${q.links[0].id}" aria-label="${attr(label)}">${personChip(personOf(p.persons, q.handle), 22, q.handle)}</a>
        <span class="cnpy-lh-name" aria-hidden="true">${esc(name.split(" ")[0])}</span>
        ${card(q.x, true, `<div style="font-size:12.5px;font-weight:600;color:var(--fg)">${esc(name)}</div>${q.links.map((l) => `<div style="margin-top:4px;font-size:12px;color:var(--fg-70)"><span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">#${l.id}</span> ${linkAboutHtml(l, p.me, p.persons)}. ${esc(heroStateWords(l, p.me))}</div>`).join("")}`)}
      </div>`;
  }).join("");

  const total = liveLinks(p.boxes).length;
  const settled = p.status === "ok" || p.status === "error";
  const empty = settled && !total
    ? `<div data-lh-empty style="text-align:center;margin-top:6px"><div style="font-size:13px;color:var(--fg-55);line-height:1.55;max-width:560px;margin:0 auto">${esc(LINKS_LEAD)}</div><button type="button" data-act="linkStartOpen" class="cnpy-accentbtn" style="${ACCENT};margin-top:14px">Link two of your sessions</button></div>`
    : "";
  return `<section class="cnpy-lh" data-lh-count="${total}" data-lh-kinds="${m.kinds.map((k) => k.kind).join(" ")}" data-lh-people="${m.people.length}" aria-label="Your clients and their links">
      <div class="cnpy-lh-stage">
        ${linkHeroCanvas(orbs, segs, m.base)}
        <div class="cnpy-lh-me" aria-hidden="true" style="left:${pct(HERO_HUB_X, HERO_W)};top:${pct(HERO_BASE_Y, HERO_H)}">${personChip(personOf(p.persons, p.me), 26, p.me)}<span class="cnpy-lh-you">You</span></div>
        ${stations}${people}
      </div>
      <div class="cnpy-lh-under">
        ${m.hidden > 0 ? `<div data-lh-more style="font-size:12px;color:var(--fg-40);text-align:center;margin-top:2px">+${m.hidden} more in the list below</div>` : ""}
        ${empty}
      </div>
    </section>`;
}

// ── the live links as cards, and the past ones as a history ────────────────────────
// Under the arc diagram: every LIVE link of yours as a card — usually two or three open and a request — in a stable
// order (waiting for you first, then open by most recent activity, then your sent requests and drafts). A card
// shows the link's two sides as clients on a small line (moving only while the link is open), what it is about and
// why, its newest note and how many notes wait for your session, its mark, and the steps you may take — Accept /
// Decline, Close, Cancel, Send, and "join Trov link #n" when a side of yours has no session yet. The whole card opens
// the link (a `hitArea`; its buttons sit above it). Below the cards, always shown, the PAST links: one line each, how
// it ended in words, latest ten first, "Show all N".

/** The live links in card order: waiting for you, then open (newest activity first), then your requests and drafts. */
export function liveCardOrder(b: LinkBoxes, me: string): LinkView[] {
  const seen = new Set<number>();
  const take = (xs: LinkView[]) => xs.filter((l) => LIVE.has(l.state) && !seen.has(l.id) && (seen.add(l.id), true));
  const activity = (l: LinkView) => Date.parse(l.preview?.last?.created_at ?? l.decided_at ?? l.sent_at ?? l.created_at) || 0;
  const waiting = take([...b.waiting].filter((l) => waitsForMe(l, me)).sort((a, c) => a.id - c.id));
  const open = take([...b.open].filter((l) => l.state === "open").sort((a, c) => activity(c) - activity(a) || c.id - a.id));
  const rest = take([...b.mine, ...b.waiting].sort((a, c) => (a.state === c.state ? c.id - a.id : a.state === "requested" ? -1 : 1)));
  return [...waiting, ...open, ...rest];
}

/** One side of a link as a client: its face in the card's orb, and its words under it. */
function sideAsClient(l: LinkView, side: LinkSideName, me: string, persons: PersonSummary[]): { face: string; words: string } {
  const s = l[side];
  if (same(s.handle, me)) {
    if (!s.kind) return { face: `<span class="cnpy-lh-ico" style="border-radius:50%">${clientIcon(null)}</span>`, words: `<span style="color:var(--fg-40)">not joined</span>` };
    const k = s.kind as ClientKind;
    return {
      face: `<span class="cnpy-lh-ico" style="border-radius:50%">${clientIcon(k)}</span>`,
      words: `${esc(CLIENT_WORD[k])}${k === "code" && s.branch ? ` <span style="font-family:var(--code);font-size:11px;color:var(--fg-55)">${esc(s.branch)}</span>` : ""}`,
    };
  }
  const name = nameOf(persons, s.handle);
  return {
    face: personChip(personOf(persons, s.handle), 36, s.handle),
    words: `${esc(name.split(" ")[0])}<span style="color:var(--fg-40)">, ${s.kind ? esc(s.kind === "chat" ? "web chat" : CLIENT_WORD[s.kind as ClientKind]) : "not joined"}</span>`,
  };
}

/** Who wrote a note, in a few words: "Jose's agent", "your Ask thread", "you". */
function noteWho(last: NonNullable<LinkPreview["last"]>, me: string, persons: PersonSummary[]): string {
  const mine = same(last.author, me);
  const who = mine ? "your" : `${nameOf(persons, last.author).split(" ")[0]}'s`;
  if (last.author_kind === "agent") return `${who} agent`;
  if (last.author_kind === "ask") return `${who} Ask thread`;
  return mine ? "you" : nameOf(persons, last.author).split(" ")[0];
}

export interface LinkCardProps { me: string; persons: PersonSummary[]; busy: boolean }

/** One live link as a card. */
export function linkCard(l: LinkView, p: LinkCardProps): string {
  const asking = waitsForMe(l, p.me);
  const spec = { ...linkLineState(l), mini: true, still: l.state !== "open" };
  const left = sideAsClient(l, "requester", p.me, p.persons), right = sideAsClient(l, "recipient", p.me, p.persons);
  const from = nameOf(p.persons, l.requester.handle).split(" ")[0];
  const title = asking ? `${esc(from)} asks to link ${l.topic.kind === "person" ? "with you" : `about ${linkTopicHtml(l)}`}`
    : l.topic.kind === "person" ? capFirst(linkAboutHtml(l, p.me, p.persons)) : linkTopicHtml(l);
  const pv = l.preview;
  const note = pv?.last
    ? `<div data-link-card-note style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--fg-40)"><span style="color:var(--fg-55);font-weight:500">${esc(noteWho(pv.last, p.me, p.persons))}</span><span>${esc(relTime(pv.last.created_at))}</span>${pv.waiting > 0 ? `<span data-link-card-waiting style="margin-left:auto;color:var(--accent);font-weight:600;white-space:nowrap">${pv.waiting} new for your session${l.self ? "s" : ""}</span>` : ""}</div>
        <div style="font-size:12.5px;color:var(--fg-70);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pv.last.excerpt)}</div>
      </div>`
    : pv ? `<div data-link-card-note style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--fg-40)">${l.state === "open" ? "No notes yet." : "Notes start once it is open."}</div>` : "";
  const dis = p.busy ? " disabled" : "";
  const small = ";padding:6px 12px";
  const b = {
    accept: `<button type="button" data-act="linkAccept" data-arg="${l.id}" class="cnpy-accentbtn" style="${ACCENT}${small}"${dis}>Accept</button>`,
    decline: `<button type="button" data-act="linkDecline" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}${small}"${dis}>Decline</button>`,
    close: `<button type="button" data-act="linkClose" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}${small}"${dis}>Close</button>`,
    send: `<button type="button" data-act="linkSend" data-arg="${l.id}" class="cnpy-accentbtn" style="${ACCENT}${small}"${dis}>Send</button>`,
    cancel: l.state === "requested"
      ? `<button type="button" data-act="linkCancelArm" data-arg="${l.id}" data-confirm-trigger aria-haspopup="dialog" aria-controls="link-cancel-confirm" class="cnpy-outlinebtn" style="${OUTLINE}${small}"${dis}>Cancel request</button>`
      : `<button type="button" data-act="linkCancel" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}${small}"${dis}>Cancel</button>`,
  };
  const order: LinkAction[] = ["close", "cancel", "decline", "send", "accept"];
  const steps = order.filter((a) => linkActionsFor(l, p.me).includes(a)).map((a) => b[a]).join("");
  const join = linkNeedsJoin(l, p.me)
    ? `<div data-link-card-join style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--fg-55)"><span style="flex:1 1 160px;min-width:0">Tell a session: <span style="font-family:var(--code);font-size:11.5px;color:var(--fg)">${esc(linkJoinPhrase(l.id))}</span></span><span style="display:flex;gap:6px;flex:none"><button type="button" data-act="linkJoinCopy" data-arg="${l.id}" class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:6px;${OUTLINE}${small}">${COPY_ICON}Copy</button><button type="button" data-act="linkJoinAsk" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}${small}">Open in Ask</button></span></div>`
    : "";
  const label = `Link #${l.id}: ${asking ? `${from} asks to link with you` : aboutText(l, p.me, p.persons)}`;
  return `<article data-link-card="${l.id}" data-state="${l.state}"${surface("padding:14px 16px 14px;display:flex;flex-direction:column;min-width:0", { cls: `cnpy-lcard ${HITBOX}${asking ? " is-asking" : ""}` })}>
      <div class="cnpy-lcard-line" aria-hidden="true">${linkLine(spec, { left: left.face, right: right.face })}
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-top:2px;font-size:11.5px;font-weight:500;color:var(--fg-70)"><div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${left.words}</div><div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${right.words}</div></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:12px"><span style="font-family:var(--label);font-size:11px;font-weight:600;color:var(--fg-40)">#${l.id}</span>${linkMark(l.state)}<span style="margin-left:auto;font-size:11.5px;color:var(--fg-40);font-family:var(--label);white-space:nowrap">${esc(relTime(lastAt(l)))}</span></div>
      <h3 data-link-card-title style="margin:6px 0 0;font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;color:var(--fg);overflow-wrap:anywhere">${title}</h3>
      <p class="cnpy-lcard-why" style="margin:4px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg-55)">${esc(l.reason)}</p>
      ${note}
      <div class="cnpy-lcard-acts" style="margin-top:auto">${join}${steps ? `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px">${steps}</div>` : ""}</div>
      ${hitArea("openLink", String(l.id), label)}
    </article>`;
}

/** How an ended link ended, in words. */
export function linkEndWords(l: LinkView, me: string, persons: PersonSummary[]): string {
  const who = (h: string) => (same(h, me) ? "you" : nameOf(persons, h).split(" ")[0]);
  switch (l.state) {
    case "closed": return `Closed${l.closed_by ? ` by ${who(l.closed_by)}` : ""}${l.close_reason ? `: ${l.close_reason.replace(/\.$/, "")}` : ""}`;
    case "declined": return `Declined by ${who(l.recipient.handle)}`;
    case "cancelled": return `Cancelled by ${who(l.requester.handle)}`;
    case "expired": {
      if (!l.sent_at) return "Expired: never sent";
      if (!l.decided_at) return "Expired: not answered in 24 h";
      const ms = Date.parse(l.closed_at ?? l.expires_at) - Date.parse(l.decided_at);
      return ms >= LINK_OPEN_TTL_MS - 60 * 60 * 1000 ? "Expired after 7 days" : `Expired after ${Math.round(LINK_IDLE_MS / 3_600_000)} h idle`;
    }
    default: return "";
  }
}

/** Who or which clients a past link was between: "with Jose", "Claude Code and web chat", "your sessions". */
function pastBetween(l: LinkView, me: string, persons: PersonSummary[]): string {
  if (!l.self) return `with ${nameOf(persons, same(l.requester.handle, me) ? l.recipient.handle : l.requester.handle)}`;
  const k = [l.requester.kind, l.recipient.kind].filter((x): x is LinkSideKind => !!x).map((x) => CLIENT_IN_TEXT[x as ClientKind]);
  return k.length === 2 ? `your ${k[0]} and ${k[1]}` : "your sessions";
}

export const LINKS_PAST_SHOWN = 10;

function pastRow(l: LinkView, p: LinkCardProps): string {
  const n = l.preview?.notes;
  return `<div class="cnpy-trow cnpy-lrow ${HITBOX}" data-link-row="${l.id}" data-past style="display:grid;grid-template-columns:34px minmax(0,2fr) minmax(0,1.6fr) auto;gap:12px;align-items:center;width:100%;text-align:left;padding:11px 16px;border-bottom:1px solid var(--border)">
      <span class="cnpy-lrow-glyph" style="display:flex;color:var(--accent);opacity:.55">${linkGlyph({ ...linkLineState(l), flow: "stopped" })}</span>
      <div style="min-width:0"><div style="display:flex;align-items:baseline;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:11px;font-weight:600;color:var(--fg-40);flex:none">#${l.id}</span><span style="min-width:0;font-size:13.5px;font-weight:500;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.topic.kind === "person" ? capFirst(linkAboutHtml(l, p.me, p.persons)) : linkTopicHtml(l)}</span></div><div style="font-size:12px;color:var(--fg-40);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.topic.kind === "person" && !l.self ? "" : `<span style="color:var(--fg-55)">${esc(capFirst(pastBetween(l, p.me, p.persons)))}</span>: `}${esc(l.reason)}</div></div>
      <div data-link-end class="cnpy-lrow-who" style="min-width:0;font-size:12.5px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(linkEndWords(l, p.me, p.persons))}</div>
      <div class="cnpy-lrow-when" style="font-size:11.5px;color:var(--fg-40);text-align:right;font-family:var(--label);white-space:nowrap">${esc(relTime(lastAt(l)))}${n !== undefined ? `<div style="margin-top:2px">${n} ${n === 1 ? "note" : "notes"}</div>` : ""}</div>
      ${hitArea("openLink", String(l.id), `Link #${l.id}, ${linkEndWords(l, p.me, p.persons)}`)}
    </div>`;
}

/** The lead sentence: the explainer under the picture, the empty state, the public docs. */
export const LINKS_LEAD = "Connect your own sessions — a coding agent, a web chat, an Ask thread — so they leave each other notes while the work overlaps; you can link with a teammate's session too.";

export function linksView(p: LinksListProps): string {
  const intro = `<div data-links-intro style="font-size:12.5px;color:var(--fg-55);margin:18px auto 30px;max-width:620px;line-height:1.55;text-align:center">${esc(LINKS_LEAD)}</div>`;
  const b = p.boxes;
  const total = b.waiting.length + b.open.length + b.mine.length + b.closed.length;
  let body: string;
  if ((p.status === "idle" || p.status === "loading") && total === 0) {
    const block = (n: number, top: boolean, off: number) => `<div style="${top ? "" : "margin-top:36px;"}padding:0 2px">${skLine(top ? 120 : 60, 11, 1.5)}</div>${linkRowsShape(n, off)}`;
    body = skeleton("links", "Loading links…", `${block(1, true, 0)}${block(2, false, 1)}${block(2, false, 3)}`);
  } else if (p.status === "error" && total === 0) body = notice("Couldn't load links.");
  else {
    const cards = liveCardOrder(b, p.me);
    const cp: LinkCardProps = { me: p.me, persons: p.persons, busy: !!p.busy };
    const live = cards.length ? `<div class="cnpy-lcards" data-link-cards>${cards.map((l) => linkCard(l, cp)).join("")}</div>` : "";
    const past = [...b.closed].sort((x, y) => (Date.parse(lastAt(y)) || 0) - (Date.parse(lastAt(x)) || 0) || y.id - x.id);
    const shown = p.pastAll ? past : past.slice(0, LINKS_PAST_SHOWN);
    const more = past.length > LINKS_PAST_SHOWN
      ? `<div style="text-align:center;margin-top:10px"><button type="button" data-act="linksPastAll" aria-expanded="${!!p.pastAll}" class="cnpy-mutelink" style="font-size:12.5px;font-weight:500;color:var(--fg-55);text-decoration:underline;text-underline-offset:2px">${p.pastAll ? "Show the latest" : `Show all ${past.length}`}</button></div>`
      : "";
    body = live
      + `${sectionHead("PAST", past.length, !live)}${past.length ? table(shown.map((l) => pastRow(l, cp)).join("")) : emptyLine(LINKS_EMPTY.past)}${more}`;
  }
  // The card's slot is always there (empty while it is closed), so opening it never shifts what morph pairs below.
  const start = `<div data-link-start-slot>${p.start ? linkStartCard({ draft: p.start, me: p.me, persons: p.persons }) : ""}</div>`;
  const hero = linksHero({ boxes: b, me: p.me, persons: p.persons, busy: !!p.busy, status: p.status });
  return `<div data-screen-label="Links" style="${WORK_SHELL}">${p.bar}<div${handoffsTabPanel("links")} style="padding-top:22px">${start}${hero}${intro}${body}</div></div>`;
}

// ── one link ─────────────────────────────────────────────────────────────────
export interface LinkDetailProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  link: LinkDetail | null;
  me: string;
  persons: PersonSummary[];
  /** The composer's text (the viewer's note, unsent). */
  draft: string;
  /** On a self-link, which of the viewer's two sides the note is written FROM (it reaches the other one). Default
   *  the requester's — the server's default too. Ignored on any other link: the server takes the viewer's one side. */
  noteSide?: LinkSideName;
  /** A step or a note in flight: every button waits. */
  busy: boolean;
}

const OUTLINE = "padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap";
const ACCENT = "background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:8px 18px;font-size:12.5px;font-weight:600;white-space:nowrap";
const EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

/** The step buttons. Accept, Decline, Send, a draft's Cancel and Close act at once; Cancel on a SENT request asks
 *  first (`linkCancelModal`), since the other person has it in front of them. */
function actionButtons(l: LinkView, me: string, busy: boolean): string {
  const dis = busy ? " disabled" : "";
  const btn: Record<LinkAction, string> = {
    send: `<button type="button" data-act="linkSend" data-arg="${l.id}" class="cnpy-accentbtn" style="${ACCENT}"${dis}>Send request</button>`,
    accept: `<button type="button" data-act="linkAccept" data-arg="${l.id}" class="cnpy-accentbtn" style="${ACCENT}"${dis}>Accept</button>`,
    decline: `<button type="button" data-act="linkDecline" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}"${dis}>Decline</button>`,
    cancel: l.state === "requested"
      ? `<button type="button" data-act="linkCancelArm" data-arg="${l.id}" data-confirm-trigger aria-haspopup="dialog" aria-controls="link-cancel-confirm" class="cnpy-outlinebtn" style="${OUTLINE}"${dis}>Cancel request</button>`
      : `<button type="button" data-act="linkCancel" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}"${dis}>Cancel</button>`,
    close: `<button type="button" data-act="linkClose" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}"${dis}>Close link</button>`,
  };
  // Outline buttons first, the accent one last (the page's primary step sits at the end of the row).
  const order: LinkAction[] = ["close", "cancel", "decline", "send", "accept"];
  const mine = linkActionsFor(l, me);
  return order.filter((a) => mine.includes(a)).map((a) => btn[a]).join("");
}

/** One side under its orb: which side it is, the person, and its session in words. The requester's reads from the
 *  left edge, the recipient's from the right, each under its own orb. */
function sideWords(l: LinkDetail, side: LinkSideName, p: LinkDetailProps): string {
  const s = l[side];
  const mine = same(s.handle, p.me);
  const right = side === "recipient";
  // A self-link's two sides are one person's two sessions: the words say which session, not who.
  const label = l.self ? (side === "requester" ? "Your first session" : "Your second session") : side === "requester" ? "From" : "To";
  const who = personLink(personOf(p.persons, s.handle), s.handle, 24, mine ? `${nameOf(p.persons, s.handle)} (you)` : nameOf(p.persons, s.handle), "min-width:0;font-size:13.5px;font-weight:500;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap", 8);
  const seen = s.seen_at ? `<div style="font-size:11.5px;color:var(--fg-40);margin-top:3px">Checked for notes ${esc(relTime(s.seen_at))}</div>` : "";
  const chat = s.kind === "chat" ? `<div style="font-size:11.5px;line-height:1.5;color:var(--fg-40);margin-top:3px">A web chat checks for notes when you ask it to.</div>` : "";
  return `<div data-link-side="${side}" data-session-kind="${s.kind ?? "none"}" style="min-width:0;text-align:${right ? "right" : "left"}">
      <div style="${EYEBROW}">${label}</div>
      <div style="display:flex;align-items:center;justify-content:${right ? "flex-end" : "flex-start"};min-width:0;margin-top:8px">${who}</div>
      <div data-link-session="${side}" style="font-size:12.5px;color:${s.kind ? "var(--fg-70)" : "var(--fg-40)"};margin-top:6px">${linkSessionHtml(s, mine)}</div>
      ${chat}${seen}
    </div>`;
}

/** The two sessions and the line between them: the requester's orb on the left, the recipient's on the right, the
 *  particles doing what the state does (link-line.ts), and each side in words under its orb. */
function linkHeadLine(l: LinkDetail, p: LinkDetailProps): string {
  const spec = linkLineState(l);
  return `<div data-link-line data-flow="${spec.flow}"${surface("margin-top:22px;padding:18px 22px 18px")}>
      <div style="max-width:560px;margin:0 auto">
        ${linkLine(spec)}
        <div class="cnpy-ll-sides" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;margin-top:6px">${sideWords(l, "requester", p)}${sideWords(l, "recipient", p)}</div>
      </div>
    </div>`;
}

/** "Tell your agent: join Trov link #12", with a copy button — for an open link whose viewer side has no session. */
function joinHint(l: LinkView): string {
  const phrase = linkJoinPhrase(l.id);
  return `<div data-link-join${surface("margin-top:18px;padding:14px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
      <div style="flex:1 1 320px;min-width:0">
        <div style="font-size:13px;font-weight:500;color:var(--fg)">Your side has no session yet. Tell your agent: <span style="font-family:var(--code);font-size:12.5px">${esc(phrase)}</span></div>
        <div style="font-size:12px;line-height:1.55;color:var(--fg-55);margin-top:4px">A coding session with the Trov plugin then gets new notes at each prompt and commit. A web chat, such as claude.ai, checks for notes when you ask it to.</div>
      </div>
      <div style="display:flex;gap:8px;flex:none"><button type="button" data-act="linkJoinCopy" data-arg="${l.id}" class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:7px;${OUTLINE}">${COPY_ICON}Copy</button><button type="button" data-act="linkJoinAsk" data-arg="${l.id}" class="cnpy-outlinebtn" style="${OUTLINE}">Open in Ask</button></div>
    </div>`;
}

function noteRow(n: LinkNoteView, persons: PersonSummary[]): string {
  return `<div data-link-note="${n.id}" data-author-kind="${n.author_kind}" style="padding:12px 0;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--fg-55)"><span data-note-author style="display:inline-flex;align-items:baseline">${noteAuthorHtml(n, persons)}</span><span style="color:var(--fg-40);font-size:11.5px">${esc(relTime(n.created_at))}</span></div>
      <div style="font-size:13.5px;line-height:1.6;color:var(--fg-70);margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(n.body)}</div>
    </div>`;
}

function composer(l: LinkView, draft: string, busy: boolean, noteSide: LinkSideName): string {
  const n = draft.length;
  // A self-link: both sides are the viewer's, so they say which session the note is FROM (it reaches the other).
  const from = l.self ? `<div data-link-note-side style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><span style="font-size:12.5px;color:var(--fg-55)">Write as</span>${segmented({
    id: "link-note-side", ariaLabel: "Which of your sessions the note is from", act: "linkNoteSide", value: noteSide, size: "sm", inertOn: true,
    options: [{ value: "requester", label: "Your first session" }, { value: "recipient", label: "Your second session" }],
  })}<span style="font-size:12px;color:var(--fg-40)">It reaches the other one.</span></div>` : "";
  const over = n > LINK_NOTE_MAX;
  const can = !!draft.trim() && !over && !busy;
  return `<div data-link-composer style="margin-top:16px">
      <label for="link-note" style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Leave a note <span style="font-weight:400;color:var(--fg-40)">— it goes to the other side</span></label>
      ${from}
      <textarea id="link-note" data-act="linkNoteField" data-arg="${l.id}" data-field="link-note" maxlength="${LINK_NOTE_MAX}" aria-describedby="link-note-count" placeholder="What you are changing, and when. Not instructions for their work." class="cnpy-input" style="display:block;width:100%;box-sizing:border-box;min-height:88px;padding:10px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);outline:none;font-size:13.5px;line-height:1.6;resize:vertical;font-family:inherit">${esc(draft)}</textarea>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px">
        <span id="link-note-count" data-link-note-count style="font-family:var(--label);font-size:11px;color:${over ? "var(--red)" : "var(--fg-40)"}">${n.toLocaleString("en-US")} / ${LINK_NOTE_MAX.toLocaleString("en-US")}</span>
        <button type="button" data-act="linkNoteSend" data-arg="${l.id}" class="${can ? "cnpy-accentbtn" : ""}" style="${can ? ACCENT : `${OUTLINE};color:var(--fg-40);cursor:default`}"${can ? "" : " disabled"}>Send note</button>
      </div>
    </div>`;
}

/** The line at the foot: where the link stands, in words. */
function statusLine(l: LinkView, me: string): string {
  const who = (h: string) => (same(h, me) ? "you" : esc(`@${h}`));
  const by = l.closed_by ? who(l.closed_by) : null;
  switch (l.state as LinkState) {
    case "draft": return l.self ? "Not sent yet. Sending opens it at once: both sides are yours." : `Not sent yet. Nothing reaches ${who(l.recipient.handle)} until it is sent. A draft lasts an hour.`;
    case "requested": return `Sent ${esc(relTime(l.sent_at))}. Waiting for ${who(l.recipient.handle)} to accept or decline; a request lasts 24 hours.`;
    case "open": return `Open since ${esc(relTime(l.decided_at ?? l.sent_at))}. Each side may write up to 20 notes.`;
    case "declined": return `Declined by ${who(l.recipient.handle)} ${esc(relTime(l.decided_at))}.`;
    case "cancelled": return `Cancelled by ${who(l.requester.handle)} ${esc(relTime(l.closed_at ?? l.decided_at))}.`;
    case "closed": return `Closed${by ? ` by ${by}` : ""} ${esc(relTime(l.closed_at))}${l.close_reason ? `: ${esc(l.close_reason)}` : "."}`;
    case "expired": return `Expired ${esc(relTime(l.closed_at ?? l.expires_at))}.`;
  }
  return "";
}

export function linkDetailView(p: LinkDetailProps): string {
  const l = p.link;
  const shell = (inner: string) => `<div data-screen-label="Link" style="${DETAIL_SHELL}">${inner}</div>`;
  if (!l) {
    if (p.status === "idle" || p.status === "loading") return shell(skeleton("link", "Loading…", skDetail({ paras: 2 })));
    return shell(notice(p.status === "error" ? "Couldn't load this link." : "Link not found. It may be another person's, or in another organization."));
  }
  const notes = l.notes.length
    ? l.notes.map((n) => noteRow(n, p.persons)).join("")
    : `<div data-link-notes-empty style="padding:14px 0;border-top:1px solid var(--border);font-size:12.5px;color:var(--fg-40)">${l.state === "open" ? "No notes yet." : l.state === "draft" || l.state === "requested" ? "Notes start once the link is open." : "No notes were left."}</div>`;
  return shell(`
    <div class="cnpy-dhead" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:22px;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <div style="flex:1 1 360px;min-width:0">
        <h2 style="margin:0;max-width:680px;font-size:24px;font-weight:600;letter-spacing:-0.02em;line-height:1.28;text-wrap:pretty">Link ${l.topic.kind === "person" ? linkAboutHtml(l, p.me, p.persons) : `about ${linkTopicHtml(l)}`}</h2>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12.5px;color:var(--fg-55)">
          ${linkMark(l.state)}
          <span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--fg-40)">#${l.id}</span>
          ${l.repo ? `<span style="font-family:var(--label);font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(l.repo)}</span>` : ""}
          <span style="color:var(--fg-40);white-space:nowrap">· ${esc(relTime(l.created_at))}</span>
        </div>
        <p data-link-reason style="margin:14px 0 0;max-width:680px;font-size:14px;line-height:1.65;color:var(--fg-70);overflow-wrap:anywhere">${esc(l.reason)}</p>
      </div>
      <div data-link-actions style="display:flex;align-items:center;gap:8px;flex:none;padding-top:2px;flex-wrap:wrap">${actionButtons(l, p.me, p.busy)}</div>
    </div>

    ${linkHeadLine(l, p)}
    ${l.self ? `<div style="font-size:12px;color:var(--fg-40);margin-top:8px">A link to yourself: two of your own sessions. The second one joins as the other side.</div>` : ""}
    ${linkNeedsJoin(l, p.me) ? joinHint(l) : ""}

    <div style="margin-top:30px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-bottom:8px"><div style="${EYEBROW}">Notes</div><div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">${l.notes.length}</div></div>
      <div data-link-notes>${notes}</div>
      ${linkCanWrite(l, p.me) ? composer(l, p.draft, p.busy, p.noteSide ?? "requester") : ""}
    </div>

    <div data-link-status style="margin-top:32px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--fg-40)">${statusLine(l, p.me)}</div>`);
}

/** Cancel on a request the other person already has: asked first (rendered at the app root while armed). */
export function linkCancelModal(l: Pick<LinkView, "id" | "recipient">, busy: boolean): string {
  return confirmModal({
    id: "link-cancel-confirm", title: `Cancel link request #${l.id}?`,
    body: `@${l.recipient.handle} is no longer asked to link. This can't be undone: your agent would draft a new link.`,
    confirmLabel: "Cancel request", busyLabel: "Cancelling…", cancelLabel: "Keep it",
    confirmAct: "linkCancelConfirm", cancelAct: "linkCancelDismiss", arg: String(l.id), busy,
  });
}
