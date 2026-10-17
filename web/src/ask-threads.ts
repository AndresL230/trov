// Ask Trov — the thread list (SHELL; inventory §1a, scenarios `live` and `search`; ask-trov.dc.html L216–282).
//
// New thread, Search threads (`GET /ask/threads?q=` → hits with a highlighted snippet), the groups Pinned /
// Today / This week / Earlier, the active row, and each row's ⋯ menu: Rename (inline), Pin / Unpin, Share with
// <org> / Stop sharing, Export as markdown, Delete. Then "Shared in <org>": the conversations OTHER members shared
// (`GET /ask/shared`; 0076_ask_sharing) — each row its owner's picture and name, opened read-only, no menu.
// A column on a desktop (ask-screen.ts), a drawer on a phone (ask-phone.ts `threadsDrawer`).
// Acts `askTh…`; reads and writes through `ctx.api` (the controller loads the lists on entering Ask).

import { esc, attr } from "./ui";
import type { AskCtx, AskPart, AskUi, AskView } from "./ask-state";
import { askIcon } from "./ask-icons";
import { closingAttr } from "./ask-motion";
import { skeleton, skList, skLine, skW } from "./skeleton";
import { askExportName, type AskSearchHit, type AskThreadGroup, type AskThreadSummary } from "@shared/ai-ask-core";
import { confirmModal } from "./confirm";
import { sharedMark } from "./marks";
import { personName, refAvatar } from "./ask-refs";
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
  app.me?.orgs.find((o) => o.slug === app.orgSlug)?.name ?? "your organization";

/** The shared mark's tooltip, for the owner and for a reader (`owner`: the owner's name). */
export const sharedTip = (org: string, owner: string | null = null): string =>
  owner ? `${owner} shared this with ${org}. Everyone there can read it; only ${owner} can continue it.`
    : `Shared with ${org}: everyone there can read it. Only you can continue it.`;

function menu(v: AskView, t: AskThreadSummary): string {
  const org = askOrgName(v.app);
  return `<div class="ask-menu ask-th-menu" role="menu" aria-label="Thread actions"${closingAttr(v.ui.closing, "menu")}>
    <button type="button" role="menuitem" data-act="askThRename" data-arg="${t.id}">${askIcon("rename", 14)}Rename</button>
    <button type="button" role="menuitem" data-act="askThPin" data-arg="${t.id}">${askIcon("pin", 14)}${t.pinned ? "Unpin" : "Pin"}</button>
    ${t.shared
      ? `<button type="button" role="menuitem" data-act="askThUnshare" data-arg="${t.id}">${askIcon("lock", 14)}Stop sharing</button>`
      : `<button type="button" role="menuitem" data-act="askThShare" data-arg="${t.id}">${askIcon("share", 14)}${esc(`Share with ${org}`)}</button>`}
    <button type="button" role="menuitem" data-act="askThExport" data-arg="${t.id}">${askIcon("download", 14)}Export as markdown</button>
    <div class="ask-menu-sep" role="separator"></div>
    <button type="button" role="menuitem" class="is-danger" data-act="askThDelete" data-arg="${t.id}">${askIcon("trash", 14)}Delete</button>
  </div>`;
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
  const time = `<span class="ask-th-at">${esc(threadTime(t))}</span>`;
  // Shared with the org: a quiet mark after the title (private, the normal state, has none).
  const mark = t.shared ? `<span class="ask-th-mark">${sharedMark(sharedTip(askOrgName(v.app)), 13, false)}</span>` : "";
  const main = hit
    ? `<button type="button" class="ask-th-b ask-th-b--hit${on ? " is-on" : ""}" data-act="askThOpen" data-arg="${t.id}"${on ? ' aria-current="page"' : ""}>
        <span class="ask-th-line"><span class="ask-th-title">${esc(t.title || "New thread")}</span>${mark}${time}</span>
        ${hit.snippet ? `<span class="ask-th-snip">${snippetHtml(hit.snippet)}</span>` : ""}
        <span class="ask-th-count">${hit.matchCount} ${hit.matchCount === 1 ? "match" : "matches"}</span>
      </button>`
    : `<button type="button" class="ask-th-b${on ? " is-on" : ""}" data-act="askThOpen" data-arg="${t.id}"${on ? ' aria-current="page"' : ""}><span class="ask-th-title">${esc(t.title || "New thread")}</span>${mark}${time}</button>`;
  return `<div class="ask-th${open ? " is-menu" : ""}" data-morph-key="th:${t.id}"${leaving}${leaving ? " inert" : ""}><div class="ask-th-in">${main}<button type="button" class="ask-th-more" data-act="askThMore" data-arg="${t.id}" aria-label="Thread actions" aria-haspopup="menu" aria-expanded="${open}">${askIcon("more", 14)}</button>${open ? menu(v, t) : ""}</div></div>`;
}

/** A conversation another member shared: the title and time, then its owner's picture and name — one button that
 *  opens it read-only (the picture is people.ts's chip, not a control of its own); no ⋯ menu, it is not the
 *  person's to rename, pin, share or delete. */
function sharedRow(v: AskView, t: AskThreadSummary): string {
  const on = v.app.screen === "ask" && v.ui.page.threadId === t.id;
  const owner = t.owner ?? "";
  const name = personName(v.look, owner);
  return `<div class="ask-th ask-th--shared" data-morph-key="sh:${t.id}"><div class="ask-th-in"><button type="button" class="ask-th-b ask-th-b--hit ask-th-b--shared${on ? " is-on" : ""}" data-act="askThOpen" data-arg="${t.id}"${on ? ' aria-current="page"' : ""} aria-label="${attr(`${t.title || "Untitled thread"}, shared by ${name}`)}">
      <span class="ask-th-line"><span class="ask-th-title">${esc(t.title || "Untitled thread")}</span><span class="ask-th-at">${esc(threadTime(t))}</span></span>
      <span class="ask-th-owner">${refAvatar(v.look, owner, 16)}<span class="ask-th-owner-n">${esc(name)}</span></span>
    </button></div></div>`;
}

/** "Shared in <org>": the conversations other members shared, under the person's own (none: no section). */
export function sharedSection(v: AskView): string {
  const rows = v.ui.shared.data;
  if (!rows.length) return "";
  return `<div class="ask-th-head ask-th-head--shared">${esc(`Shared in ${askOrgName(v.app)}`)}</div><div class="ask-th-list" data-morph-list data-ask-enter="rise">${rows.map((t) => sharedRow(v, t)).join("")}</div>`;
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
let focusMore: number | null = null;
const MENU_ITEM = ".ask-th-menu [role='menuitem']";

/** Delete's confirmation (QA-2): a root `data-overlay` (ask-screen.ts `askOverlays`), the app's ONE confirm. */
export function threadDeleteModal(ui: Pick<AskUi, "threadDelete" | "closing">): string {
  const d = ui.threadDelete;
  if (!d) return "";
  // Its exit is the confirm's own (`data-closing` on the layer, trov.css), played through `ctx.exit("thdel")`.
  return confirmModal({
    id: "ask-th-delete", title: `Delete “${d.title || "this thread"}”?`,
    body: "The conversation and the files attached to it are deleted for good. A file a ticket or a doc refers to, or one published to the org, stays in Artifacts.",
    confirmAct: "askThDeleteGo", cancelAct: "askThDeleteCancel", arg: String(d.id),
  }).replace(`class="cnpy-cmodal"`, `class="cnpy-cmodal"${closingAttr(ui.closing, "thdel")}`);
}
/** Share's confirmation: what every member of the org will read, and what stays the owner's — the files they attached
 *  (private artifacts: members see each file's name, never what is in it). A root `data-overlay` like Delete's. */
export function threadShareModal(ui: Pick<AskUi, "threadShare" | "closing">, org: string): string {
  const d = ui.threadShare;
  if (!d) return "";
  return confirmModal({
    id: "ask-th-share", title: `Share “${d.title || "this thread"}” with ${org}?`,
    body: `Everyone in ${org} can open it and read the whole conversation: your questions and Trov's answers, including anything Trov quoted from the files you attached. Only you can continue, rename or delete it, and you can stop sharing at any time.`,
    detail: `<p class="ask-share-note">${esc("Files you attached stay private: members see each file's name, not what is in it. A source only you can see stays hidden from them.")}</p>`,
    confirmLabel: "Share", busyLabel: "Sharing…", tone: "neutral",
    confirmAct: "askThShareGo", cancelAct: "askThShareCancel", arg: String(d.id),
  }).replace(`class="cnpy-cmodal"`, `class="cnpy-cmodal"${closingAttr(ui.closing, "thshare")}`);
}
const closeShare = (ctx: AskCtx) => ctx.exit("thshare", () => { ctx.ui.threadShare = null; }, DELETE_OUT_MS);

/** Share / stop sharing, written at once (the row's mark follows), the list read again after. */
function setShared(ctx: AskCtx, id: number, shared: boolean): void {
  const t = threadById(ctx, id);
  if (!t) return;
  const apply = (on: boolean) => {
    ctx.ui.threads.data = ctx.ui.threads.data.map((x) => (x.id === id ? { ...x, shared: on } : x));
    const c = ctx.ui.page;
    if (c.threadId === id && c.thread) ctx.ui.page = { ...c, thread: { ...c.thread, shared: on } };
  };
  apply(shared);
  ctx.paint();
  if (ctx.replay) { ctx.flash("Replay: nothing was shared."); return; }
  const org = askOrgName(ctx.app);
  ctx.api.patchThread(id, { shared })
    .then(() => { ctx.flash(shared ? `Shared with ${org}` : "Stopped sharing. Only you can read it now."); ctx.reloadThreads(); })
    .catch((e) => { apply(!shared); ctx.fail(e, shared ? "Couldn't share the thread." : "Couldn't stop sharing the thread."); ctx.reloadThreads(); });
}

/** Delete's confirm out: its exit, then gone. */
const closeDelete = (ctx: AskCtx) => ctx.exit("thdel", () => { ctx.ui.threadDelete = null; }, DELETE_OUT_MS);
const DELETE_OUT_MS = 140;

export const threadsPart: AskPart = {
  code: "Th",
  afterPaint(_ctx, mount) {
    // Delete's confirm takes the focus on its destructive button (Enter confirms, Escape cancels — main.ts's one
    // keyboard contract for every `[data-confirm-dialog]`).
    if (focusConfirm) { focusConfirm = false; mount.querySelector<HTMLElement>("#ask-th-delete [data-confirm-focus], #ask-th-share [data-confirm-focus]")?.focus(); }
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
      // Share asks first: everyone in the org will read the whole conversation (attachments by name only).
      case "askThShare": {
        const t = threadById(ctx, id);
        ctx.ui.threadMenu = null;
        if (t) { ctx.cancelExit("thshare"); ctx.ui.threadShare = { id, title: t.title }; focusConfirm = true; }
        ctx.paint();
        return;
      }
      case "askThShareCancel":
        if (!ctx.ui.threadShare) return;
        closeShare(ctx);
        if (id > 0) focusMore = id; // focus back on the row's ⋯, where the menu was
        ctx.paint();
        return;
      case "askThShareGo":
        if (!ctx.ui.threadShare) return;
        closeShare(ctx);
        setShared(ctx, id, true);
        return;
      // Stop sharing asks nothing: it takes nothing from the owner, and sharing again brings it back.
      case "askThUnshare":
        ctx.ui.threadMenu = null;
        setShared(ctx, id, false);
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
        if (t) { ctx.cancelExit("thdel"); ctx.ui.threadDelete = { id, title: t.title }; focusConfirm = true; }
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
  escape: [{ layer: "menu", isOpen: (ctx) => ctx.ui.threadMenu !== null, close: (ctx) => { focusMore = ctx.ui.threadMenu; ctx.exit("menu", () => { ctx.ui.threadMenu = null; }, 120); } }],
};
