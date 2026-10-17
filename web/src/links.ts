// Relay › Links — agent links in the web app (docs/architecture/handoffs-prompts.md › Agent links › Web).
// The Relay screen's second tab (`#links`): the links waiting for me, my open ones, my drafts and sent
// requests, and the recently ended ones; and one link's page (`#links/<n>`): its topic and reason, both sides,
// the notes thread, a composer for the viewer's OWN side while the link is open, and the person steps the
// viewer may take. Purely presentational: props in, markup out; clicks are `data-act` dispatched in main.ts,
// which calls the /links routes. Ids are the per-org NUMBER, rendered `#12`.
//
// Who may do what is decided HERE for the screen (`linkActionsFor`, `linkCanWrite`, `linkNeedsJoin`) and again by
// the server (src/tools/links.ts), which is the rule; the screen only never offers a step the server would refuse.

import type { LinkView, LinkDetail, LinkNoteView, LinkSideView, LinkSideName, LinkState } from "@shared/links";
import { linkTopicLabel, LINK_NOTE_MAX, ASK_THREAD_SESSION_PREFIX } from "@shared/links";
import type { PersonSummary } from "./api";
import { esc, attr, relTime, surface, WORK_SHELL, DETAIL_SHELL, hitArea, HITBOX } from "./ui";
import { personLink, handleLink } from "./people";
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
}

const ROW_COLS = "grid-template-columns:minmax(0,2.6fr) minmax(0,1.2fr) auto 64px";

/** One row: `#n`, the topic and the reason, the other person, the state's mark, when it last moved. A `hitArea`
 *  row, so the person's photo and name open their card while the rest opens the link. */
function linkRow(l: LinkView, p: LinksListProps): string {
  const sides = viewerSides(l, p.me);
  const sent = sides.includes("requester");
  const other = sent ? l.recipient.handle : l.requester.handle;
  const word = l.self ? "SELF" : l.state === "open" || l.state === "closed" || l.state === "expired" ? "WITH" : sent ? "TO" : "FROM";
  const person = l.self
    ? personLink(personOf(p.persons, p.me), p.me, 20, "You, two sessions", "min-width:0;font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap")
    : personLink(personOf(p.persons, other), other, 20, nameOf(p.persons, other), "min-width:0;font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
  const live = l.state === "draft" || l.state === "requested" || l.state === "open";
  return `<div class="cnpy-trow cnpy-hrow${l.state === "requested" && !sent ? " cnpy-attn" : ""} ${HITBOX}" data-link-row="${l.id}" style="display:grid;${ROW_COLS};gap:12px;align-items:center;width:100%;text-align:left;padding:12px 16px;border-bottom:1px solid var(--border);transition:background .12s ease">
    <div style="min-width:0">
      <div style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:11px;font-weight:600;color:var(--fg-40);flex:none">#${l.id}</span><span style="min-width:0;font-size:13.5px;font-weight:${live ? 600 : 500};letter-spacing:-0.005em;color:${live ? "var(--fg)" : "var(--fg-55)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${linkTopicHtml(l)}</span></div>
      <div style="font-size:12px;color:var(--fg-55);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.reason)}</div>
    </div>
    <div class="cnpy-hrow-who" style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40);flex:none;width:32px">${word}</span>${person}</div>
    <div>${linkMark(l.state)}</div>
    <div style="font-size:11.5px;color:var(--fg-40);text-align:right;font-family:var(--label);white-space:nowrap">${esc(relTime(lastAt(l)))}</div>
    ${hitArea("openLink", String(l.id), `Link #${l.id} about ${linkTopicLabel(l.topic.kind, l.topic.ref)}`)}
  </div>`;
}

const sectionHead = (label: string, count: number, top = false): string =>
  `<div style="${top ? "" : "margin-top:36px"}"><div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 2px"><div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55);white-space:nowrap">${esc(label)}</div><div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap">${count}</div></div></div>`;
const table = (rows: string): string =>
  `<div${surface("overflow:hidden;margin-top:10px")}><div class="cnpy-stagger" style="margin-bottom:-1px">${rows}</div></div>`;
const emptyLine = (text: string): string =>
  `<div data-links-empty style="text-align:center;padding:24px 28px;color:var(--fg-40);font-size:12.5px;line-height:1.55;max-width:560px;margin:0 auto">${esc(text)}</div>`;

/** Each section's empty sentence, in plain words. */
export const LINKS_EMPTY = {
  waiting: "No link requests are waiting for you. When a teammate asks to link their session with yours, the request shows here to accept or decline.",
  open: "No open links. While a link is open, the two sessions leave each other short notes about what they are changing.",
  mine: "Nothing drafted or sent. When your agent drafts a link, it gives you this link's page to send it from.",
  closed: "No ended links yet.",
} as const;

function linkRowsShape(n: number, off = 0): string {
  const row = (i: number) => `<div class="cnpy-hrow" style="display:grid;${ROW_COLS};gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
      <span>${skLine(skW(i), 13.5, 1.5)}${skLine("50%", 12, 1.5)}</span><span style="display:flex;align-items:center;gap:7px">${skBox(20, 20)}${skBar("60%", 9)}</span>${skBox(60, 20)}${skLine(34, 11.5, 1.5, "justify-content:flex-end")}
    </div>`;
  return `<div${surface("overflow:hidden;margin-top:10px")}><div style="margin-bottom:-1px">${skList(n, (i) => row(i + off))}</div></div>`;
}

export function linksView(p: LinksListProps): string {
  const intro = `<div style="font-size:12.5px;color:var(--fg-55);margin:0 0 22px;max-width:720px;line-height:1.55">A link is a short-lived line between two sessions whose work overlaps. While it is open, each side leaves short notes for the other. An agent drafts a link; people send and accept it here.</div>`;
  const b = p.boxes;
  const total = b.waiting.length + b.open.length + b.mine.length + b.closed.length;
  let body: string;
  if ((p.status === "idle" || p.status === "loading") && total === 0) {
    const block = (n: number, top: boolean, off: number) => `<div style="${top ? "" : "margin-top:36px;"}padding:0 2px">${skLine(top ? 120 : 60, 11, 1.5)}</div>${linkRowsShape(n, off)}`;
    body = skeleton("links", "Loading links…", `${block(1, true, 0)}${block(2, false, 1)}${block(2, false, 3)}`);
  } else if (p.status === "error" && total === 0) body = notice("Couldn't load links.");
  else {
    const sec = (label: string, rows: LinkView[], empty: string, top = false) =>
      `${sectionHead(label, rows.length, top)}${rows.length ? table(rows.map((l) => linkRow(l, p)).join("")) : emptyLine(empty)}`;
    body = sec("WAITING FOR YOU", b.waiting, LINKS_EMPTY.waiting, true)
      + sec("OPEN", b.open, LINKS_EMPTY.open)
      + sec("YOURS", b.mine, LINKS_EMPTY.mine)
      + sec("CLOSED", b.closed, LINKS_EMPTY.closed);
  }
  return `<div data-screen-label="Links" style="${WORK_SHELL}">${p.bar}<div${handoffsTabPanel("links")} style="padding-top:22px">${intro}${body}</div></div>`;
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

/** One side's card: the person, which side it is, and its session. */
function sideCard(l: LinkDetail, side: LinkSideName, p: LinkDetailProps): string {
  const s = l[side];
  const mine = same(s.handle, p.me);
  // A self-link's two sides are one person's two sessions: the cards say which session, not who.
  const label = l.self ? (side === "requester" ? "Your first session" : "Your second session") : side === "requester" ? "From" : "To";
  const who = personLink(personOf(p.persons, s.handle), s.handle, 28, mine ? `${nameOf(p.persons, s.handle)} (you)` : nameOf(p.persons, s.handle), "min-width:0;font-size:13.5px;font-weight:500;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap", 9);
  const seen = s.seen_at ? `<div style="font-size:11.5px;color:var(--fg-40);margin-top:4px">Checked for notes ${esc(relTime(s.seen_at))}</div>` : "";
  const chat = s.kind === "chat" ? `<div style="font-size:11.5px;line-height:1.5;color:var(--fg-40);margin-top:4px">A web chat checks for notes when you ask it to.</div>` : "";
  return `<div${surface("flex:1 1 260px;min-width:0;padding:16px 18px")} data-link-side="${side}">
      <div style="${EYEBROW}">${label}</div>
      <div style="display:flex;align-items:center;min-width:0;margin-top:10px">${who}</div>
      <div data-link-session="${side}" style="font-size:12.5px;color:${s.kind ? "var(--fg-70)" : "var(--fg-40)"};margin-top:10px">${linkSessionHtml(s, mine)}</div>
      ${chat}${seen}
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
      <button type="button" data-act="linkJoinCopy" data-arg="${l.id}" class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:7px;${OUTLINE}">${COPY_ICON}Copy</button>
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
        <h2 style="margin:0;max-width:680px;font-size:24px;font-weight:600;letter-spacing:-0.02em;line-height:1.28;text-wrap:pretty">Link about ${linkTopicHtml(l)}</h2>
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

    <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:22px">${sideCard(l, "requester", p)}${sideCard(l, "recipient", p)}</div>
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
