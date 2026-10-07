// Sync GitHub's behaviour (docs/architecture/sync.md): every `sync…` act, the batch loop, the
// polling, and where the panel hangs. The markup is sync.ts; main.ts only creates this and
// forwards to it.
//
// THE RUN IS DRIVEN FROM HERE, in module scope — not from a screen — so closing the panel or
// moving to another screen never loses it. Batch 1 POSTs `{ batch: 1, of, start: true }`; each
// later one `{ batch, of, run }`, while the batch says summaries are still waiting and the bound
// has not been reached. While a batch is in flight `GET /sync` is read every 1.5 s, and what it
// reports is what the panel paints: nothing on it is counted or guessed here.
//
// A run this tab is NOT driving (someone else's, or its own from before a reload) is only
// watched: `GET /sync` every few seconds while it is live. It is never resumed.
//
// A progress tick repaints the Sync slots and the panel IN PLACE (`paint`), not the screen: a
// full rerender every second and a half would swap <main> under whatever the person is doing.

import { SYNC_MAX_BATCHES, type SyncRunView, type SyncStatusView } from "@shared/sync";
import { ApiError, Unauthorized, adminBackfill, getSync, type SyncBatchBody } from "./api";
import { morph } from "./morph";
import { syncControl, syncDriving, syncLive, syncOverlay, syncRepoLabel, type SyncProps, type SyncUi } from "./sync";

export interface SyncHost {
  mount: HTMLElement;
  /** The app's sync state (render.ts `AppState.sync`) — mutated in place. */
  ui: () => SyncUi;
  props: () => SyncProps;
  /** The app is showing an org (not sign-in, the picker or Platform). */
  inApp: () => boolean;
  rerender: () => void;
  unauth: (e: unknown) => void;
  /** A run finished: My Work's data is stale. */
  reloadMyWork: () => void;
}

/** How often `GET /sync` is read while this tab's batch is in flight / while watching a run it does not drive. */
const DRIVE_POLL_MS = 1500;
const WATCH_POLL_MS = 4000;
/** Entering My Work or Repo re-reads the status, but not more often than this. */
const FRESH_MS = 10_000;

export function createSyncController(h: SyncHost) {
  const ui = (): SyncUi => h.ui();
  let loadedAt = 0;
  let loading: Promise<SyncStatusView | null> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let tickMs = 0;
  /** The run this tab is following without driving it (so its end can be told from "there was none"). */
  let watching: number | null = null;
  /** The run this tab last saw end — a `GET /sync` asked before that may still call it running. */
  let ended: SyncRunView | null = null;

  // ── painting ───────────────────────────────────────────────────────────────
  const parse = (html: string): Element | null => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  };

  /** Hang the panel under its button, and keep focus somewhere real. Called after every paint. */
  function afterPaint(): void {
    const panel = h.mount.querySelector<HTMLElement>("[data-sync-panel]");
    if (!panel) return;
    const btn = h.mount.querySelector<HTMLElement>("[data-sync-btn]");
    if (btn) {
      const r = btn.getBoundingClientRect();
      h.mount.style.setProperty("--sync-top", `${Math.round(r.bottom + 6)}px`);
      h.mount.style.setProperty("--sync-right", `${Math.max(8, Math.round(document.documentElement.clientWidth - r.right))}px`);
    }
    // The control that held focus is gone (Sync now, once the run starts): the dialog takes it.
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected) panel.focus({ preventScroll: true });
  }

  /** Repaint the Sync slots and the panel where they stand. A panel that must appear or go, or a
   *  slot the screen does not have yet, is the app's own rerender. */
  function paint(): void {
    if (!h.inApp()) return;
    const p = h.props();
    const slot = h.mount.querySelector<HTMLElement>('[data-sync-slot="ctl"]');
    const live = h.mount.querySelector<HTMLElement>('[data-overlay="sync"]');
    const overlay = syncOverlay(p);
    const repo = h.mount.querySelector<HTMLElement>('[data-sync-slot="repo"]');
    const label = syncRepoLabel(p.ui, p.now);
    const onRepo = h.mount.querySelector("[data-repo-updated]") !== null;
    if (!slot) return; // a page with no header (the landing page inside the app): the next rerender draws it
    if (!!live !== !!overlay || (onRepo && !!repo !== !!label)) { h.rerender(); return; }
    const next = parse(`<div data-sync-slot="ctl" class="sync-slot">${syncControl(p)}</div>`);
    if (next) morph(slot, next);
    if (live) { const o = parse(overlay); if (o) morph(live, o); }
    if (repo) repo.textContent = `${label} ·`;
    afterPaint();
  }

  /** The clock on screen: elapsed time once a second while a run shows in the open panel,
   *  relative times ("12m ago") twice a minute otherwise. */
  function tick(): void {
    const u = ui();
    const want = u.open && (u.starting || syncLive(u) !== null) ? 1000 : 30_000;
    if (tickTimer && tickMs === want) return;
    if (tickTimer) clearInterval(tickTimer);
    tickMs = want;
    tickTimer = setInterval(() => { if (h.inApp() && h.mount.querySelector('[data-sync-slot="ctl"]')) paint(); }, want);
  }

  // ── GET /sync ──────────────────────────────────────────────────────────────
  function take(answer: SyncStatusView): void {
    const u = ui();
    // An answer asked before a run this tab saw end may still say it is running: it is not.
    const stale = ended !== null && answer.running?.id === ended.id;
    const v: SyncStatusView = stale ? { ...answer, running: null, blocked: answer.blocked === "running" ? null : answer.blocked, last: ended } : answer;
    u.status = v;
    u.load = "ok";
    loadedAt = Date.now();
    // This tab's own run, inside a batch: paint what the server last reported.
    if (u.mine && v.running && v.running.id === u.mine.id && v.running.updated_at >= u.mine.updated_at) u.mine = v.running;
    if (syncDriving(u)) return;
    if (v.running) { watching = v.running.id; return; }
    if (watching === null) return;
    // The run being watched has ended. Whoever has the panel open on it (or started it) gets its
    // result to read; My Work is stale either way.
    const run = v.last && v.last.id === watching ? v.last : null;
    watching = null;
    if (!run) return;
    const me = h.props().me;
    const own = !!me && run.by.toLowerCase() === me.toLowerCase();
    if (run.status !== "abandoned" && (u.open || own) && !u.result) { u.result = run; u.resultSummaries = v.summaries; }
    if (run.status === "ok" || run.status === "partial") h.reloadMyWork();
  }

  function read(): Promise<SyncStatusView | null> {
    if (loading) return loading;
    const u = ui();
    if (u.load !== "ok") u.load = "loading";
    loading = getSync()
      .then((v) => { take(v); return v; })
      .catch((e) => {
        if (e instanceof Unauthorized) { h.unauth(e); return null; }
        // No org open (signed out, the picker): nothing to say. Anything else is a failed read.
        if (e instanceof ApiError && e.message === "org_required") ui().load = "idle";
        else ui().load = ui().status ? "ok" : "error";
        return null;
      })
      .finally(() => { loading = null; });
    return loading;
  }

  function schedule(): void {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    tick();
    if (!h.inApp()) return;
    const u = ui();
    const ms = syncDriving(u) ? DRIVE_POLL_MS : u.status?.running ? WATCH_POLL_MS : 0;
    if (ms) pollTimer = setTimeout(() => { pollTimer = null; refresh(); }, ms);
  }
  /** Read the status and repaint; keep reading while there is a run to follow. */
  function refresh(): void {
    void read().then(() => { paint(); schedule(); });
  }
  /** `GET /sync` when a screen that shows it loads (My Work, Repo) and at boot — at most once per `FRESH_MS`. */
  function load(force = false): void {
    if (!force && (loading || Date.now() - loadedAt < FRESH_MS)) return;
    refresh();
  }

  // ── the run this tab drives ────────────────────────────────────────────────
  function finish(run: SyncRunView): void {
    const u = ui();
    u.mine = null; u.starting = false;
    u.result = run;
    ended = run;
    watching = null;
    if (u.status) u.status = { ...u.status, running: null, blocked: u.status.blocked === "running" ? null : u.status.blocked, last: run };
    if (run.status === "ok" || run.status === "partial") h.reloadMyWork();
  }

  async function drive(): Promise<void> {
    const u = ui();
    // One run at a time from this tab, and never a second beside one somebody else is running.
    if (syncDriving(u) || syncLive(u)) return;
    u.starting = true; u.result = null; u.resultSummaries = null; u.problem = null;
    h.rerender();
    schedule();
    let batch = 0;
    let runId: number | null = null;
    try {
      for (;;) {
        batch++;
        const body: SyncBatchBody = runId === null ? { batch, of: SYNC_MAX_BATCHES, start: true } : { batch, of: SYNC_MAX_BATCHES, run: runId };
        const ans = await adminBackfill(body);
        u.starting = false;
        if (!("body" in ans)) {
          u.mine = null;
          // A failed batch closed the run as `failed` (503: GitHub refused a list; 502: it threw): that is the result.
          if (ans.run && ans.run.status !== "running") finish(ans.run);
          // 409 `sync_running`: somebody's run holds the lock — show it, start nothing.
          else if (ans.status === 409 && ans.run) { watching = ans.run.id; if (u.status) u.status = { ...u.status, running: ans.run, blocked: "running" }; }
          // 503 `not configured` and 409 `sync_not_running` (this run went quiet for 3 minutes): `GET /sync`, below, says which.
          else if (ans.status !== 409 && ans.status !== 503) u.problem = "refused";
          break;
        }
        const res = ans.body;
        runId = res.run.id;
        u.resultSummaries = res.summaries;
        if (res.run.status !== "running") { finish(res.run); break; }
        // Still running, yet nothing is left to ask for: the server's record is the truth (`GET /sync`, below).
        if (!res.summaryBudgetExhausted || batch >= SYNC_MAX_BATCHES) { u.mine = null; break; }
        u.mine = res.run;
        paint();
      }
    } catch (e) {
      u.starting = false; u.mine = null;
      if (e instanceof Unauthorized) { h.unauth(e); return; }
      u.problem = "offline";
    }
    // Whatever happened, the status is stale now: the run ended, or it stands as the server knows it.
    h.rerender();
    refresh();
  }

  // ── open / close ───────────────────────────────────────────────────────────
  function open(): void {
    ui().open = true;
    h.rerender();
    h.mount.querySelector<HTMLElement>("[data-sync-panel]")?.focus({ preventScroll: true });
    load(true);
  }
  function close(): void {
    const u = ui();
    if (!u.open) return;
    u.open = false;
    h.rerender();
    h.mount.querySelector<HTMLElement>("[data-sync-btn]")?.focus({ preventScroll: true });
    tick();
  }

  /** Every `sync…` act. */
  function act(name: string): void {
    const u = ui();
    switch (name) {
      case "syncToggle": if (u.open) close(); else open(); return;
      case "syncClose": close(); return;
      case "syncReload": u.load = "loading"; paint(); load(true); return;
      case "syncStart": void drive(); return;
      case "syncDismiss": u.result = null; u.resultSummaries = null; u.problem = null; close(); return;
      default: return;
    }
  }

  // Escape closes the panel; Tab stays inside it (while it is open, nothing else can be clicked).
  document.addEventListener("keydown", (e) => {
    if (!ui().open) return;
    const panel = h.mount.querySelector<HTMLElement>("[data-sync-panel]");
    if (!panel) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
    e.preventDefault();
    if (!items.length) { panel.focus(); return; }
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === -1 || at === items.length - 1 ? 0 : at + 1)].focus();
  });
  window.addEventListener("resize", () => { if (ui().open) afterPaint(); });

  return {
    act,
    load,
    afterPaint,
    /** Before the app paints: the panel does not outlive the control it hangs from (another screen, signing out). */
    beforePaint(): void {
      const u = ui();
      if (u.open && (!h.inApp() || !syncOverlay(h.props()))) u.open = false;
    },
  };
}
