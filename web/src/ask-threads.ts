// Ask Trov — the thread list (SHELL; inventory §1a, scenarios `live` and `search`; ask-trov.dc.html L216–282).
//
// New thread, Search threads (`GET /ask/threads?q=` → hits with a highlighted snippet), the groups Pinned /
// Today / This week / Earlier, the active row, and each row's ⋯ menu: Rename (inline), Pin / Unpin, Share… (the Share
// dialog: everyone in the org can read it, and people by name, each "Can read" or "Can continue") / Stop sharing,
// Export as markdown, Delete. Then other people's conversations (`GET /ask/shared`; 0076 / 0077_ask_sharing): "Shared
// with you" (shared with the person by name) and "Organization" (shared with everyone) — each row its owner's picture
// and name, no menu.
// A column on a desktop (ask-screen.ts), a drawer on a phone (ask-phone.ts `threadsDrawer`).
// Acts `askTh…`; reads and writes through `ctx.api` (the controller loads the lists on entering Ask).

import { esc, attr } from "./ui";
import type { AskCtx, AskPart, AskUi, AskView } from "./ask-state";
import { askIcon, type AskIconName } from "./ask-icons";
import { closingAttr, reducedMotion } from "./ask-motion";
import { skeleton, skList, skLine, skW } from "./skeleton";
import { askExportName, type AskSearchHit, type AskShareAccess, type AskSharePerson, type AskThreadGroup, type AskThreadSummary } from "@shared/ai-ask-core";
import { confirmModal } from "./confirm";
import { markShape, sharedMark } from "./marks";
import { personName, refAvatar, type RefLook } from "./ask-refs";
import { askView, sameHandle } from "./ask-state";
import { segmented } from "./segmented";
import { dropdown, type DropdownOption, type DropdownProps } from "./dropdown";
import { AskApiError, isUnauthorized } from "./ask-api";
import type { AppState } from "./render";

const GROUP_LABEL: Record<AskThreadGroup, string> = { pinned: "Pinned", today: "Today", week: "This week", earlier: "Earlier" };
const GROUPS: AskThreadGroup[] = ["pinned", "today", "week", "earlier"];

/** A row's time: the clock today, the weekday this week, else the date (the design's `9:41`, `Mon`, `Oct 3`). */
export function threadTime(t: Pick<AskThreadSummary, "updatedAt" | "group">, now: Date = new Date()): string {
  const d = new Date(t.updatedAt);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: false });
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The snippet with its matches as <mark>s (offsets from the server's FTS `snippet()`). */
export function snippetHtml(s: AskSearchHit["snippet"]): string {
  if (!s) return "";
  let out = "";
  let at = 0;
  for (const [a, b] of [...s.matches].sort((x, y) => x[0] - y[0])) {
    if (a < at || b <= a) continue;
    out += esc(s.text.slice(at, a)) + `<mark class="ask-hl">${esc(s.text.slice(a, b))}</mark>`;
    at = b;
  }
  return out + esc(s.text.slice(at));
}

/** The org on screen's name ("your organization" before it is known): what "Share with …" names. */
export const askOrgName = (app: Pick<AppState, "me" | "orgSlug">): string =>
  app.me?.orgs?.find((o) => o.slug === app.orgSlug)?.name ?? "your organization";

/** Who one of the person's own threads is shared with, as a phrase — "SaplingLearn", "Mei Lin", "Mei Lin and Sana
 *  Okafor", "Mei Lin and 2 others", "SaplingLearn and 2 people" — or null when nobody. */
export function sharedWith(org: string, t: Pick<AskThreadSummary, "shared" | "people">, look: Pick<RefLook, "persons">): string | null {
  const people = t.people ?? [];
  const n = people.length;
  if (t.shared) return n ? `${org} and ${n} ${n === 1 ? "person" : "people"}` : org;
  if (!n) return null;
  const name = (i: number) => personName(look, people[i].handle);
  return n === 1 ? name(0) : n === 2 ? `${name(0)} and ${name(1)}` : `${name(0)} and ${n - 1} others`;
}

/** The shared mark's tooltip on the person's own thread: who can open it. */
export const ownerSharedTip = (who: string): string => `Shared with ${who}.`;

/** The shared mark's tooltip on someone else's thread: who shared it with whom, and what the person may do. */
export function viewerSharedTip(org: string, owner: string, t: Pick<AskThreadSummary, "direct" | "access">): string {
  if (!t.direct) return `${owner} shared this with ${org}. Everyone there can read it.`;
  return t.access === "continue" ? `${owner} shared this with you. You can read it and continue it.` : `${owner} shared this with you. You can read it.`;
}

const isShared = (t: Pick<AskThreadSummary, "shared" | "people">): boolean => !!t.shared || !!t.people?.length;

function menu(v: AskView, t: AskThreadSummary): string {
  return `<div class="ask-menu ask-th-menu" role="menu" aria-label="Thread actions"${closingAttr(v.ui.closing, "menu")}>
    <button type="button" role="menuitem" data-act="askThRename" data-arg="${t.id}">${askIcon("rename", 14)}Rename</button>
    <button type="button" role="menuitem" data-act="askThPin" data-arg="${t.id}">${askIcon("pin", 14)}${t.pinned ? "Unpin" : "Pin"}</button>
    <button type="button" role="menuitem" data-act="askThShare" data-arg="${t.id}" aria-haspopup="dialog">${askIcon("share", 14)}Share…</button>
    ${isShared(t) ? `<button type="button" role="menuitem" data-act="askThUnshare" data-arg="${t.id}">${askIcon("lock", 14)}Stop sharing</button>` : ""}
    <button type="button" role="menuitem" data-act="askThExport" data-arg="${t.id}">${askIcon("download", 14)}Export as markdown</button>
    <div class="ask-menu-sep" role="separator"></div>
    <button type="button" role="menuitem" class="is-danger" data-act="askThDelete" data-arg="${t.id}">${askIcon("trash", 14)}Delete</button>
  </div>`;
}

/** How many notes wait on the thread's Trov links (`AskThreadSummary.links`): they reach it with the next question. */
export const threadLinkNotes = (t: Pick<AskThreadSummary, "links">): number => (t.links ?? []).reduce((n, l) => n + l.notes, 0);

/** The row's mark for notes waiting on its links — a small blue dot (marks.ts), its tooltip saying what it means;
 *  nothing when none. Never a pill. */
export function threadLinkMark(t: Pick<AskThreadSummary, "links">): string {
  const n = threadLinkNotes(t);
  if (!n) return "";
  const tip = `${n} new ${n === 1 ? "note" : "notes"} on a Trov link. ${n === 1 ? "It reaches" : "They reach"} this thread with your next question.`;
  return `<span class="ask-th-link" data-ask-th-link="${n}" role="img" aria-label="${attr(tip)}" data-mtip="${attr(tip)}">${markShape("dot", "var(--blue)", 7)}</span>`;
}

function row(v: AskView, t: AskThreadSummary, hit: AskSearchHit | null): string {
  const on = v.app.screen === "ask" && v.ui.page.threadId === t.id;
  const open = v.ui.threadMenu === t.id;
  // A row is a one-track grid around its content (`.ask-th-in`), so `data-closing` collapses it with no measuring
  // and the rows under it move up as the same elements (web-ui.md › A row leaving a list).
  const leaving = closingAttr(v.ui.closing, `th:${t.id}`);
  if (v.ui.renaming?.id === t.id) {
    return `<div class="ask-th" data-morph-key="th:${t.id}"${leaving}><div class="ask-th-in"><input class="ask-th-rename" data-act="askThRenameText" data-arg="${t.id}" data-field="askThRename" data-ask-rename="${t.id}" value="${attr(v.ui.renaming.text)}" aria-label="Thread name" maxlength="80" /></div></div>`;
  }
  const time = `${threadLinkMark(t)}<span class="ask-th-at">${esc(threadTime(t))}</span>`;
  // Shared (with the org, or people by name): a quiet mark after the title (private, the normal state, has none).
  const who = sharedWith(askOrgName(v.app), t, v.look);
  const mark = who ? `<span class="ask-th-mark">${sharedMark(ownerSharedTip(who), 13, false)}</span>` : "";
  const main = hit
    ? `<button type="button" class="ask-th-b ask-th-b--hit${on ? " is-on" : ""}" data-act="askThOpen" data-arg="${t.id}"${on ? ' aria-current="page"' : ""}>
        <span class="ask-th-line"><span class="ask-th-title">${esc(t.title || "New thread")}</span>${mark}${time}</span>
        ${hit.snippet ? `<span class="ask-th-snip">${snippetHtml(hit.snippet)}</span>` : ""}
        <span class="ask-th-count">${hit.matchCount} ${hit.matchCount === 1 ? "match" : "matches"}</span>
      </button>`
    : `<button type="button" class="ask-th-b${on ? " is-on" : ""}" data-act="askThOpen" data-arg="${t.id}"${on ? ' aria-current="page"' : ""}><span class="ask-th-title">${esc(t.title || "New thread")}</span>${mark}${time}</button>`;
  return `<div class="ask-th${open ? " is-menu" : ""}" data-morph-key="th:${t.id}"${leaving}${leaving ? " inert" : ""}><div class="ask-th-in">${main}<button type="button" class="ask-th-more" data-act="askThMore" data-arg="${t.id}" aria-label="Thread actions" aria-haspopup="menu" aria-expanded="${open}">${askIcon("more", 14)}</button>${open ? menu(v, t) : ""}</div></div>`;
}

/** Someone else's conversation: the title and time, then its owner's picture and name — one button that opens it
 *  (the picture is people.ts's chip, not a control of its own); no ⋯ menu, it is not the person's to rename, pin,
 *  share or delete. One the person may continue says so after the name, in plain words (a fact, not a mark). */
function sharedRow(v: AskView, t: AskThreadSummary): string {
  const on = v.app.screen === "ask" && v.ui.page.threadId === t.id;
  const owner = t.owner ?? "";
  const name = personName(v.look, owner);
  const cont = t.direct && t.access === "continue";
  return `<div class="ask-th ask-th--shared" data-morph-key="sh:${t.id}"><div class="ask-th-in"><button type="button" class="ask-th-b ask-th-b--hit ask-th-b--shared${on ? " is-on" : ""}" data-act="askThOpen" data-arg="${t.id}"${on ? ' aria-current="page"' : ""} aria-label="${attr(`${t.title || "Untitled thread"}, shared by ${name}${cont ? ", you can continue it" : ""}`)}">
      <span class="ask-th-line"><span class="ask-th-title">${esc(t.title || "Untitled thread")}</span>${threadLinkMark(t)}<span class="ask-th-at">${esc(threadTime(t))}</span></span>
      <span class="ask-th-owner">${refAvatar(v.look, owner, 16)}<span class="ask-th-owner-n">${esc(name)}</span>${cont ? `<span class="ask-th-can">· Can continue</span>` : ""}</span>
    </button></div></div>`;
}

/** Other people's conversations, under the person's own: "Shared with you" (shared with them by name — a thread
 *  shared both ways is here only), then "Organization" (shared with everyone). An empty one has no section. */
export function sharedSection(v: AskView): string {
  const rows = v.ui.shared.data;
  const section = (head: string, list: AskThreadSummary[]) => list.length
    ? `<div class="ask-th-head ask-th-head--shared">${esc(head)}</div><div class="ask-th-list" data-morph-list data-ask-enter="rise">${list.map((t) => sharedRow(v, t)).join("")}</div>`
    : "";
  return section("Shared with you", rows.filter((t) => t.direct)) + section("Organization", rows.filter((t) => !t.direct));
}

/** The whole list: New thread, the search box, then the groups (or the search's hits). */
export function threadsView(v: AskView): string {
  const ui = v.ui;
  const q = ui.threadQ.trim();
  let body: string;
  if (q) {
    const hits = ui.hits;
    body = !hits || hits.status === "loading" ? `<div class="ask-th-head">Searching…</div>`
      : hits.status === "error" ? `<div class="ask-th-none">Couldn't search threads.</div>`
      : `<div class="ask-th-head">${hits.data.length} ${hits.data.length === 1 ? "thread" : "threads"}</div>${hits.data.length
        ? `<div class="ask-th-list" data-morph-list data-ask-enter="fade">${hits.data.map((h) => row(v, h.thread, h)).join("")}</div>`
        : `<div class="ask-th-none">No thread mentions “${esc(q)}”.</div>`}`;
  } else if (ui.threads.status === "loading" && !ui.threads.data.length) {
    body = skeleton("ask-threads", "Loading your threads…", `<div class="ask-th-head">${skLine("32%", 11.5, 1.4)}</div>${skList(6, (i) => `<div class="ask-th-skrow">${skLine(skW(i), 13, 1.5)}</div>`)}`);
  } else if (ui.threads.status === "error" && !ui.threads.data.length) {
    body = `<div class="ask-th-none">Couldn't load your threads.</div>`;
  } else {
    body = GROUPS.map((g) => {
      const rows = ui.threads.data.filter((t) => (t.pinned ? "pinned" : t.group) === g);
      // Each group is a keyed list (`data-morph-list`): a new thread's row rises in, a pinned one moves groups, a
      // deleted one collapses — and a repaint never replays a row (ask-motion.ts rule 2).
      return rows.length ? `<div class="ask-th-head">${GROUP_LABEL[g]}</div><div class="ask-th-list" data-morph-list data-ask-enter="rise">${rows.map((t) => row(v, t, null)).join("")}</div>` : "";
    }).join("") || `<div class="ask-th-none">No threads yet. Ask something to start one.</div>`;
    body += sharedSection(v);
  }
  return `<div class="ask-threads-in">
    <div class="ask-th-top">
      <div class="ask-th-newrow">
        <button type="button" class="ask-th-new" data-act="askShNew">${askIcon("plus", 14, null, 2.2)}New thread</button>
        ${v.app.phone ? "" : `<button type="button" class="ask-th-hide" data-act="askShThreads" aria-label="Hide threads" data-tip="Hide threads">${askIcon("chevsLeft", 14, null, 2)}</button>`}
      </div>
      <div class="ask-th-search">${askIcon("search", 14)}<input class="ask-th-q" data-act="askThQ" data-field="askThQ" value="${attr(ui.threadQ)}" placeholder="Search threads" aria-label="Search threads" spellcheck="false" autocomplete="off" />${q ? `<button type="button" class="ask-th-clear" data-act="askThClear" aria-label="Clear search">${askIcon("close", 11, null, 2.4)}</button>` : ""}</div>
    </div>
    <div class="ask-th-scroll">${body}</div>
  </div>`;
}

// ── acts ─────────────────────────────────────────────────────────────────────

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchCtl: AbortController | null = null;
function search(ctx: AskCtx): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchCtl?.abort();
  const q = ctx.ui.threadQ.trim();
  if (!q) { ctx.ui.hits = null; ctx.paint(); return; }
  ctx.ui.hits = { status: "loading", data: ctx.ui.hits?.data ?? [] };
  searchTimer = setTimeout(() => {
    const ctl = new AbortController();
    searchCtl = ctl;
    ctx.api.searchThreads(q, ctl.signal)
      .then((data) => { if (ctx.ui.threadQ.trim() === q) ctx.ui.hits = { status: "ok", data }; })
      .catch((e) => { if (!ctl.signal.aborted && ctx.ui.threadQ.trim() === q) { ctx.ui.hits = { status: "error", data: [] }; ctx.fail(e, "Couldn't search threads."); } })
      .finally(() => ctx.paint());
  }, 180);
}

const threadById = (ctx: AskCtx, id: number): AskThreadSummary | null =>
  ctx.ui.threads.data.find((t) => t.id === id) ?? ctx.ui.hits?.data.find((h) => h.thread.id === id)?.thread ?? null;

function commitRename(ctx: AskCtx): void {
  const r = ctx.ui.renaming;
  if (!r) return;
  ctx.ui.renaming = null;
  const t = threadById(ctx, r.id);
  const title = r.text.trim();
  if (!t || !title || title === t.title) { ctx.paint(); return; }
  ctx.ui.threads.data = ctx.ui.threads.data.map((x) => (x.id === r.id ? { ...x, title } : x));
  if (ctx.ui.page.threadId === r.id) ctx.ui.page = { ...ctx.ui.page, title };
  ctx.paint();
  ctx.api.patchThread(r.id, { title }).then(() => ctx.reloadThreads()).catch((e) => { ctx.fail(e, "Couldn't rename the thread."); ctx.reloadThreads(); });
}

function download(url: string, name: string): void {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}

// The menu's keyboard (the composer's mode menu does the same): opening it focuses its first item, ↑↓ move, and
// Escape hands focus back to the row's ⋯. Set by an act, applied by the next paint.
let focusMenu = false;
let focusConfirm = false;
let focusShare = false;
/** Set when a person is added: the next paint scrolls the people list to them. */
let scrollShareEnd = false;
/** What Tab moves between in the Share dialog: its controls (a segmented switch's one Tab stop). */
const SHARE_FOCUSABLE = "button:not([disabled]):not([tabindex='-1'])";
let focusMore: number | null = null;
const MENU_ITEM = ".ask-th-menu [role='menuitem']";

/** Delete's confirmation (QA-2): a root `data-overlay` (ask-screen.ts `askOverlays`), the app's ONE confirm. */
export function threadDeleteModal(ui: Pick<AskUi, "threadDelete" | "closing">, org: string): string {
  const d = ui.threadDelete;
  if (!d) return "";
  // A shared thread goes for everyone it was shared with too (deleteAskThread: the same rows), so it says so.
  const who = d.who ?? (d.shared ? org : null);
  const shared = who ? ` It is shared with ${who}, so it goes for ${who === org ? "everyone there" : "them"} too.` : "";
  // Its exit is the confirm's own (`data-closing` on the layer, trov.css), played through `ctx.exit("thdel")`.
  return confirmModal({
    id: "ask-th-delete", title: `Delete “${d.title || "this thread"}”?`,
    body: `The conversation and the files attached to it are deleted for good.${shared} A file a ticket or a doc refers to, or one published to the org, stays in Artifacts.`,
    confirmAct: "askThDeleteGo", cancelAct: "askThDeleteCancel", arg: String(d.id),
  }).replace(`class="cnpy-cmodal"`, `class="cnpy-cmodal"${closingAttr(ui.closing, "thdel")}`);
}

// ── the Share dialog (0076 / 0077_ask_sharing) ───────────────────────────────

const ACCESS_LABEL: Record<AskShareAccess, string> = { read: "Can read", continue: "Can continue" };
const domKey = (h: string): string => h.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

/** A person's access in the dialog: Can read or Can continue (the × beside it takes them off the list). */
const personDropdown = (look: Pick<RefLook, "persons">, p: AskSharePerson, busy: boolean): DropdownProps => ({
  id: `ask-share-p-${domKey(p.handle)}`, act: "askThSharePerson", arg: p.handle, value: p.access, size: "sm", disabled: busy,
  ariaLabel: `What ${personName(look, p.handle)} can do`,
  options: [
    { value: "read", label: ACCESS_LABEL.read, hint: "Opens it and reads it" },
    { value: "continue", label: ACCESS_LABEL.continue, hint: "Also asks follow-ups in it, as themselves" },
  ],
});

/** "Add a person": the org's members not on the list yet, never the owner — a pick adds them as Can read. */
function addDropdown(app: AppState, d: ShareDraftView): DropdownProps {
  const look = { persons: app.persons.data };
  const me = app.me?.handle ?? null;
  const options: DropdownOption[] = look.persons
    .filter((x) => !sameHandle(x.handle, me) && !d.people.some((p) => sameHandle(p.handle, x.handle)))
    .map((x) => ({ value: x.handle, label: personName(look, x.handle), icon: refAvatar(look, x.handle, 18) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { id: "ask-share-add", act: "askThShareAdd", value: "", placeholder: options.length ? "Add a person" : "Everyone is added", options, ariaLabel: "Add a person", size: "sm", disabled: d.busy || !options.length };
}
type ShareDraftView = NonNullable<AskUi["threadShare"]>;

/** The Share dialog's dropdowns, for the root overlays (ask-actions.ts `actionDropdowns` lists them). */
export function shareDropdowns(app: AppState): DropdownProps[] {
  const d = app.ask.threadShare;
  if (!d) return [];
  const look = { persons: app.persons.data };
  return [...d.people.map((p) => personDropdown(look, p, d.busy)), addDropdown(app, d)];
}

/** Share: who can open the conversation — everyone in the org (read only), and people by name, each "Can read" or
 *  "Can continue" — and what stays private and what doesn't: answers drawn from GitHub are shared as written (always
 *  said: the org's GitHub lookups switch isn't on the Ask screen and a row's thread isn't loaded). A root `data-overlay` dialog (role="dialog", not a confirmation: nothing
 *  is written until Save); its keyboard is the threads part's (Escape, a trapped Tab). */
/** What sharing with the org does, one line each — every line true of `shared_at` (ask.md › Sharing a conversation). */
function orgFacts(org: string): string {
  const facts: [AskIconName, string][] = [
    ["ask", `It shows under Organization in everyone's Ask list in ${org}.`],
    ["read", "They read every question and answer, and see who asked each one."],
    ["lock", "They can't ask in it. To let someone ask, share with them as a teammate."],
    ["more", "Stop sharing at any time from the ⋯ menu."],
  ];
  return facts.map(([icon, line]) => `<li>${askIcon(icon, 13)}<span>${esc(line)}</span></li>`).join("");
}

export function threadShareModal(app: AppState): string {
  const ui = app.ask;
  const d = ui.threadShare;
  if (!d) return "";
  const v = askView(app);
  const org = askOrgName(app);
  const off = d.busy ? " disabled" : "";
  const arg = String(d.id);
  const orgPane = `<div class="ask-share-sec" data-morph-key="sp-org">
      <div class="ask-share-row">
        <span class="ask-share-who"><span class="ask-share-org" aria-hidden="true">${askIcon("share", 14)}</span><span class="ask-share-n" id="ask-share-org-l">${esc(`Everyone in ${org}`)}</span></span>
        ${segmented({ id: "ask-share-org", ariaLabel: `Everyone in ${org}`, value: d.org ? "read" : "off", act: "askThShareOrg", size: "sm", inertOn: true,
          options: [{ value: "off", label: "No access", arg: `${arg}|off`, locked: d.busy }, { value: "read", label: "Can read", arg: `${arg}|read`, locked: d.busy }] })}
      </div>
      <ul class="ask-share-facts">${orgFacts(org)}</ul>
    </div>`;
  const people = d.people.map((p) => `<div class="ask-share-row" data-morph-key="sp:${attr(domKey(p.handle))}">
      <span class="ask-share-who">${refAvatar(v.look, p.handle, 20)}<span class="ask-share-n">${esc(personName(v.look, p.handle))}</span></span>
      ${dropdown(personDropdown(v.look, p, d.busy), app.dd)}
      <button type="button" class="ask-iconbtn ask-share-x" data-act="askThShareRemove" data-arg="${attr(p.handle)}"${off} aria-label="${attr(`Remove ${personName(v.look, p.handle)}`)}" data-tip="Remove">${askIcon("close", 12, null, 2.4)}</button>
    </div>`).join("");
  // The list is three rows tall and scrolls past that, so the dialog keeps one size however many are added.
  const peoplePane = `<div class="ask-share-sec" data-morph-key="sp-people">
      <div class="ask-share-list" data-morph-key="sp-list" data-morph-list>${people || `<p class="ask-share-empty" data-morph-key="sp-none">${esc("Not shared with anyone by name yet.")}</p>`}</div>
      <div class="ask-share-row ask-share-add" data-morph-key="sp-add">${dropdown(addDropdown(app, d), app.dd)}</div>
      <p class="ask-share-note" data-morph-key="sp-how">${esc("Can read opens it and reads it. Can continue also asks follow-ups in it, as themselves, and can't change what anyone else asked.")}</p>
    </div>`;
  const err = d.error ? `<div role="alert" class="ask-share-err">${esc(d.error)}</div>` : "";
  return `<div data-overlay="ask-th-share" class="cnpy-cmodal"${closingAttr(ui.closing, "thshare")}>
    <div data-act="askThShareCancel" data-arg="${arg}" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="ask-th-share" role="dialog" aria-modal="true" aria-labelledby="ask-th-share-t" aria-describedby="ask-th-share-d" tabindex="-1" data-ask-share data-tab="${d.tab}"${d.busy ? " data-busy" : ""} class="cnpy-surface cnpy-cmodal-box ask-share">
        <div id="ask-th-share-t" class="ask-share-h">${esc(`Share “${d.title || "this thread"}”`)}</div>
        <div class="ask-share-tabs">${segmented({ id: "ask-share-tab", ariaLabel: "Share with", value: d.tab, act: "askThShareTab", size: "sm", fill: true, inertOn: true,
          options: [{ value: "org", label: "Share with org", arg: `${arg}|org` },
            { value: "people", label: "Share with a teammate", arg: `${arg}|people` }] })}</div>
        <div class="ask-share-body">${d.tab === "org" ? orgPane : peoplePane}</div>
        <p id="ask-th-share-d" class="ask-share-note ask-share-files">${esc("Files stay private to whoever attached them. Answers drawn from GitHub are shared as written, even with people who can't open those repositories. Only you can rename, share or delete it.")}</p>
        ${err}
        <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
          <button type="button" data-act="askThShareCancel" data-arg="${arg}" class="cnpy-outlinebtn"${off} style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:500;color:var(--fg-70)">Cancel</button>
          <button type="button" data-act="askThShareGo" data-arg="${arg}" class="cnpy-confirm-go cnpy-confirm-go--neutral"${off}${d.busy ? ' aria-busy="true"' : ""} style="padding:8px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:600;white-space:nowrap">${d.busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  </div>`;
}
const closeShare = (ctx: AskCtx) => ctx.exit("thshare", () => { ctx.ui.threadShare = null; }, DELETE_OUT_MS);

/** The thread's sharing as the person's list and the open conversation show it (the row's mark follows). */
function applySharing(ctx: AskCtx, id: number, shared: boolean, people: AskSharePerson[]): void {
  const set = (t: AskThreadSummary): AskThreadSummary => {
    const { people: _was, ...rest } = t;
    return { ...rest, shared, ...(people.length ? { people } : {}) };
  };
  ctx.ui.threads.data = ctx.ui.threads.data.map((x) => (x.id === id ? set(x) : x));
  const c = ctx.ui.page;
  if (c.threadId === id && c.thread) ctx.ui.page = { ...c, thread: set(c.thread) };
}

/** Save the dialog: ONE write of who can open it (`PATCH { shared, people }` — the whole list), then the list. */
function saveShare(ctx: AskCtx): void {
  const d = ctx.ui.threadShare;
  if (!d || d.busy) return;
  if (ctx.replay) { closeShare(ctx); ctx.flash("Replay: nothing was shared."); return; }
  const people = d.people.map((p) => ({ handle: p.handle, access: p.access }));
  ctx.ui.threadShare = { ...d, busy: true, error: null };
  ctx.paint();
  ctx.api.patchThread(d.id, { shared: d.org, people })
    .then((t) => {
      // The server's answer is the truth (it omits `people` when nobody is named); the draft only if it sent none.
      applySharing(ctx, d.id, t ? !!t.shared : d.org, t ? t.people ?? [] : people);
      closeShare(ctx);
      focusMore = d.id;
      const who = sharedWith(askOrgName(ctx.app), { shared: d.org, people }, { persons: ctx.app.persons.data });
      ctx.flash(who ? `Shared with ${who}` : "Only you can read it now.");
      ctx.reloadThreads();
    })
    .catch((e) => {
      if (isUnauthorized(e)) { ctx.fail(e, "Couldn't save who can see it."); return; }
      const cur = ctx.ui.threadShare;
      if (cur?.id === d.id) ctx.ui.threadShare = { ...cur, busy: false, error: e instanceof AskApiError && e.message ? e.message : "Couldn't save who can see it. Try again." };
      ctx.paint();
    });
}

/** Stop sharing: with the org and with everyone by name, written at once (it takes nothing from the owner). */
function stopSharing(ctx: AskCtx, id: number): void {
  const t = threadById(ctx, id);
  if (!t) return;
  const was = { shared: !!t.shared, people: t.people ?? [] };
  applySharing(ctx, id, false, []);
  ctx.paint();
  if (ctx.replay) { ctx.flash("Replay: nothing was shared."); return; }
  ctx.api.patchThread(id, { shared: false, people: [] })
    .then(() => { ctx.flash("Stopped sharing. Only you can read it now."); ctx.reloadThreads(); })
    .catch((e) => { applySharing(ctx, id, was.shared, was.people); ctx.fail(e, "Couldn't stop sharing the thread."); ctx.reloadThreads(); });
}

/** Delete's confirm out: its exit, then gone. */
const closeDelete = (ctx: AskCtx) => ctx.exit("thdel", () => { ctx.ui.threadDelete = null; }, DELETE_OUT_MS);
const DELETE_OUT_MS = 140;

export const threadsPart: AskPart = {
  code: "Th",
  afterPaint(_ctx, mount) {
    // Delete's confirm takes the focus on its destructive button (Enter confirms, Escape cancels — main.ts's one
    // keyboard contract for every `[data-confirm-dialog]`); the Share dialog on its first control.
    if (focusConfirm) { focusConfirm = false; mount.querySelector<HTMLElement>("#ask-th-delete [data-confirm-focus]")?.focus(); }
    if (scrollShareEnd) {
      scrollShareEnd = false;
      const list = mount.querySelector<HTMLElement>("#ask-th-share .ask-share-list");
      list?.scrollTo({ top: list.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    }
    if (focusShare) { focusShare = false; (mount.querySelector<HTMLElement>(`#ask-th-share ${SHARE_FOCUSABLE}`) ?? mount.querySelector<HTMLElement>("#ask-th-share"))?.focus(); }
    if (focusMenu) { focusMenu = false; mount.querySelector<HTMLElement>(MENU_ITEM)?.focus(); }
    if (focusMore !== null) { const id = focusMore; focusMore = null; mount.querySelector<HTMLElement>(`[data-act="askThMore"][data-arg="${id}"]`)?.focus(); }
  },
  act(ctx, name, arg, value) {
    const id = Number(arg);
    switch (name) {
      case "askThOpen": ctx.ui.threadMenu = null; if (id > 0) ctx.openThread(id); return;   // openThread slides the phone drawer out
      case "askThQ": ctx.ui.threadQ = value ?? ""; ctx.ui.threadMenu = null; search(ctx); ctx.paint(); return;
      case "askThClear": ctx.ui.threadQ = ""; search(ctx); return;
      case "askThMore":
        if (ctx.ui.threadMenu === id) { ctx.exit("menu", () => { ctx.ui.threadMenu = null; }, 120); return; }
        ctx.cancelExit("menu");
        ctx.ui.threadMenu = id; focusMenu = true; ctx.paint(); return;
      case "askThRename": {
        const t = threadById(ctx, id);
        ctx.ui.threadMenu = null;
        if (t) ctx.ui.renaming = { id, text: t.title };
        ctx.paint();
        return;
      }
      case "askThRenameText": if (ctx.ui.renaming?.id === id) ctx.ui.renaming.text = value ?? ""; return;
      case "askThPin": {
        const t = threadById(ctx, id);
        ctx.ui.threadMenu = null;
        if (!t) return;
        ctx.ui.threads.data = ctx.ui.threads.data.map((x) => (x.id === id ? { ...x, pinned: !t.pinned } : x));
        ctx.paint();
        ctx.api.patchThread(id, { pinned: !t.pinned }).then(() => ctx.reloadThreads()).catch((e) => { ctx.fail(e, "Couldn't pin the thread."); ctx.reloadThreads(); });
        return;
      }
      // Share… opens the dialog on the thread's sharing as it stands; nothing is written until Save.
      case "askThShare": {
        const t = threadById(ctx, id);
        ctx.ui.threadMenu = null;
        if (t) {
          ctx.cancelExit("thshare");
          // On a phone the menu sits in the threads drawer, which layers above root dialogs: it slides out first, as
          // it does when a thread opens (ask-phone.ts `closeDrawer`, not imported — ask-phone imports this module).
          if (ctx.ui.phone.drawer) ctx.exit("drawer", () => { ctx.ui.phone.drawer = false; });
          ctx.ui.threadShare = { id, title: t.title, org: !!t.shared, people: (t.people ?? []).map((p) => ({ handle: p.handle, access: p.access })), tab: "org", busy: false, error: null };
          focusShare = true;
        }
        ctx.paint();
        return;
      }
      // Share with org / Share with a teammate: which half the dialog shows (both are kept, and Save writes both).
      case "askThShareTab": {
        const d = ctx.ui.threadShare;
        const to = (arg ?? "").split("|")[1];
        if (!d || (to !== "org" && to !== "people")) return;
        ctx.ui.threadShare = { ...d, tab: to, error: null };
        ctx.paint();
        return;
      }
      case "askThShareOrg": {
        const d = ctx.ui.threadShare;
        if (!d || d.busy) return;
        ctx.ui.threadShare = { ...d, org: (arg ?? "").split("|")[1] === "read", error: null };
        ctx.paint();
        return;
      }
      // A person's dropdown: Can read / Can continue, or Remove.
      // The × beside a person: off the list (nothing is written until Save).
      case "askThShareRemove": {
        const d = ctx.ui.threadShare;
        if (!d || d.busy || !arg) return;
        ctx.ui.threadShare = { ...d, people: d.people.filter((p) => !sameHandle(p.handle, arg)), error: null };
        focusShare = true;
        ctx.paint();
        return;
      }
      case "askThSharePerson": {
        const d = ctx.ui.threadShare;
        if (!d || d.busy || !arg) return;
        const to: AskShareAccess | null = value === "read" || value === "continue" ? value : null;
        const people = value === "remove" ? d.people.filter((p) => !sameHandle(p.handle, arg))
          : to ? d.people.map((p) => (sameHandle(p.handle, arg) ? { ...p, access: to } : p)) : d.people;
        ctx.ui.threadShare = { ...d, people, error: null };
        if (value === "remove") focusShare = true;
        ctx.paint();
        return;
      }
      // Add a person: on the list as Can read (the dropdown beside them changes it).
      case "askThShareAdd": {
        const d = ctx.ui.threadShare;
        if (!d || d.busy || !value || d.people.some((p) => sameHandle(p.handle, value))) return;
        if (sameHandle(value, ctx.app.me?.handle)) return;
        ctx.ui.threadShare = { ...d, people: [...d.people, { handle: value, access: "read" }], error: null };
        scrollShareEnd = true;
        ctx.paint();
        return;
      }
      case "askThShareCancel": {
        const d = ctx.ui.threadShare;
        if (!d || d.busy) return;
        closeShare(ctx);
        focusMore = d.id; // focus back on the row's ⋯, where the menu was
        ctx.paint();
        return;
      }
      case "askThShareGo": saveShare(ctx); return;
      // Stop sharing asks nothing: it takes nothing from the owner, and sharing again brings it back.
      case "askThUnshare":
        ctx.ui.threadMenu = null;
        stopSharing(ctx, id);
        return;
      case "askThExport": {
        const t = threadById(ctx, id);
        ctx.ui.threadMenu = null;
        ctx.paint();
        if (!t) return;
        if (ctx.replay) { ctx.flash("Replay: nothing was exported."); return; }
        download(ctx.api.exportUrl(id), `${askExportName(t.title)}.md`); // the server's name too (Q56)
        ctx.flash(`Exported ${t.title || "the thread"}.md`);
        return;
      }
      // Delete asks first (QA-2): it is a hard delete of the thread and its files, with no undo.
      case "askThDelete": {
        const t = threadById(ctx, id);
        ctx.ui.threadMenu = null;
        // On a phone the drawer slides out first, as for Share… — else the confirmation sits under it (PRE-2).
        if (t && ctx.ui.phone.drawer) ctx.exit("drawer", () => { ctx.ui.phone.drawer = false; });
        if (t) { ctx.cancelExit("thdel"); ctx.ui.threadDelete = { id, title: t.title, shared: !!t.shared, who: sharedWith(askOrgName(ctx.app), t, { persons: ctx.app.persons.data }) }; focusConfirm = true; }
        ctx.paint();
        return;
      }
      case "askThDeleteCancel":
        if (!ctx.ui.threadDelete) return;
        closeDelete(ctx);
        if (id > 0) focusMore = id; // focus back on the row's ⋯, where the menu was
        ctx.paint();
        return;
      case "askThDeleteGo": {
        const t = threadById(ctx, id);
        if (!ctx.ui.threadDelete) return;
        closeDelete(ctx);
        ctx.ui.threadMenu = null;
        if (!t) { ctx.paint(); return; }
        if (ctx.ui.page.threadId === id) ctx.newThread("page");
        // The row collapses first (its exit), then leaves the list; the write goes out at once.
        ctx.exit(`th:${id}`, () => {
          ctx.ui.threads.data = ctx.ui.threads.data.filter((x) => x.id !== id);
          if (ctx.ui.hits) ctx.ui.hits = { ...ctx.ui.hits, data: ctx.ui.hits.data.filter((h) => h.thread.id !== id) };
        });
        ctx.api.deleteThread(id).then(() => ctx.flash(`Deleted ${t.title || "the thread"}`)).catch((e) => { ctx.fail(e, "Couldn't delete the thread."); ctx.reloadThreads(); });
        return;
      }
    }
  },
  onKeyDown(ctx, e) {
    // The Share dialog keeps Tab inside it (aria-modal).
    const dlg = e.key === "Tab" && ctx.ui.threadShare ? (e.target as Element | null)?.closest?.<HTMLElement>("#ask-th-share") ?? null : null;
    if (dlg) {
      const items = Array.from(dlg.querySelectorAll<HTMLElement>(SHARE_FOCUSABLE));
      if (items.length) {
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
        e.preventDefault();
        return true;
      }
    }
    const mi = (e.target as Element | null)?.closest?.<HTMLElement>(MENU_ITEM);
    if (mi && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const items = Array.from(mi.parentElement?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
      const i = items.indexOf(mi);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
      return true;
    }
    const el = (e.target as Element | null)?.closest?.<HTMLInputElement>("[data-ask-rename]");
    if (!el) return false;
    if (e.key === "Enter") { e.preventDefault(); ctx.ui.renaming && (ctx.ui.renaming.text = el.value); commitRename(ctx); return true; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ctx.ui.renaming = null; ctx.paint(); return true; }
    return false;
  },
  onChange(ctx, e) {
    // Leaving the rename box saves it (the design's onBlur), like Enter.
    if (e.type === "focusout" && (e.target as Element | null)?.closest?.("[data-ask-rename]")) { commitRename(ctx); return true; }
    return false;
  },
  escape: [
    { layer: "menu", isOpen: (ctx) => ctx.ui.threadMenu !== null, close: (ctx) => { focusMore = ctx.ui.threadMenu; ctx.exit("menu", () => { ctx.ui.threadMenu = null; }, 120); } },
    // The Share dialog: Escape closes a dropdown open in it first (this layer runs before the dropdowns' own key
    // handler), then the dialog (Cancel: nothing written).
    { layer: "menu", isOpen: (ctx) => ctx.ui.threadShare !== null, close: (ctx) => {
      if (ctx.app.dd.open) { ctx.app.dd = { open: null, opening: false, closing: false }; focusShare = true; ctx.paint(); return; }
      if (ctx.ui.threadShare?.busy) return;
      focusMore = ctx.ui.threadShare?.id ?? null;
      closeShare(ctx);
      ctx.paint();
    } },
  ],
};
