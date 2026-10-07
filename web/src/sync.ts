// Sync GitHub, as the app shows it (docs/architecture/sync.md): the header control, and the PANEL
// it opens — what a sync will do, the run in progress, and how the last one ended.
//
// Pure renderers over `SyncProps`: no state, no fetch, no clock of their own (`now` is a prop). The
// words come from shared/sync.ts, which builds them from the run record; this file only adds the
// relative times. The behaviour — the batch loop, the polling, focus, where the panel hangs — is
// sync-actions.ts.
//
// THE SURFACE. A panel anchored under the header button (a bottom sheet at phone width), not a
// page-blocking modal: a sync takes minutes, so the panel can be closed and the button carries
// the progress ("Syncing 3 of 8") on every screen until the result has been read and dismissed.
// It is a root-level `data-overlay` (morph.ts patches it in place), so a progress tick never
// replaces the element that holds focus.

import {
  SYNC_ADMINS_ONLY, SYNC_DID_NOT_FINISH, SYNC_KEEPS_RUNNING, SYNC_PASS_NOTE, SYNC_PHASE_LABEL, SYNC_SCHEDULED,
  syncBlockText, syncChanges, syncCompactLabel, syncDuration, syncFailureTab, syncFailureText, syncLeftoverText, syncNothingNew,
  syncNeedsText, syncPassLabel, syncResultTitle, syncSeenText, syncSummariesText, syncWatchText, syncWhatItDoes,
  type SyncRunView, type SyncStatusView, type SyncSummariesView,
} from "@shared/sync";
import { esc, attr } from "./ui";
import { accentBtn, quietBtn, goLink } from "./org-ui";

// ── state ────────────────────────────────────────────────────────────────────

/** Why the page's own request did not get an answer about a run — a fixed vocabulary, never text
 *  a server or a browser wrote. */
export type SyncProblem = "offline" | "refused";

export interface SyncUi {
  /** The panel is open. */
  open: boolean;
  /** `GET /sync`: where the read stands, and its last answer (kept across a refresh). */
  load: "idle" | "loading" | "ok" | "error";
  status: SyncStatusView | null;
  /** This tab pressed Sync now and its first batch has not answered yet. */
  starting: boolean;
  /** The run THIS tab is driving, as last reported; null = it is driving none. */
  mine: SyncRunView | null;
  /** A finished run nobody has dismissed yet. */
  result: SyncRunView | null;
  /** The allowance as that run left it (the last batch's answer); null = read it from `status`. */
  resultSummaries: SyncSummariesView | null;
  problem: SyncProblem | null;
}
export const initialSyncUi = (): SyncUi => ({ open: false, load: "idle", status: null, starting: false, mine: null, result: null, resultSummaries: null, problem: null });

export interface SyncProps {
  ui: SyncUi;
  /** The viewer is an admin or owner of the org on screen (what the app knows before `GET /sync` answers). */
  admin: boolean;
  /** The viewer's handle. */
  me: string | null;
  /** The screen is My Work — the control's home. Elsewhere it shows only while there is something to follow. */
  home: boolean;
  now: number;
}

// ── small pure helpers ───────────────────────────────────────────────────────

/** "12 minutes ago" / "12m ago" — whole units, never a date maths surprise: a time in the future is "just now". */
export function syncAgo(iso: string | null, now: number, form: "long" | "short" = "long"): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const mins = Math.floor(Math.max(0, now - t) / 60_000);
  if (mins < 1) return "just now";
  const unit = (n: number, short: string, long: string): string => (form === "short" ? `${n}${short} ago` : `${n} ${long}${n === 1 ? "" : "s"} ago`);
  if (mins < 60) return unit(mins, "m", "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return unit(hours, "h", "hour");
  return unit(Math.floor(hours / 24), "d", "day");
}

const isAdmin = (p: SyncProps): boolean => p.ui.status?.admin ?? p.admin;
const sameHandle = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The run in progress, whoever drives it: this tab's, else the one `GET /sync` reported. */
export function syncLive(ui: SyncUi): SyncRunView | null {
  return ui.mine ?? ui.status?.running ?? null;
}
/** This tab is driving a run (so a second start is refused here, before the server refuses it). */
export const syncDriving = (ui: SyncUi): boolean => ui.starting || ui.mine !== null;

export type SyncMode = "loading" | "error" | "running" | "result" | "blocked" | "readonly" | "ready";
/** Which of its states the panel is in. Running wins over a result, a result over everything at rest. */
export function syncMode(p: SyncProps): SyncMode {
  const { ui } = p;
  if (ui.starting || syncLive(ui)) return "running";
  if (ui.result) return "result";
  if (!ui.status) return ui.load === "error" ? "error" : "loading";
  if (!isAdmin(p)) return "readonly";
  return ui.status.blocked === "no_repo" || ui.status.blocked === "no_token" ? "blocked" : "ready";
}

/** Whether the header shows the control at all. On My Work: an admin always, anyone else once a
 *  sync has ever run. On every other screen: only while a run is in progress or its result has
 *  not been dismissed. */
export function syncShown(p: SyncProps): boolean {
  const { ui } = p;
  if (ui.starting || syncLive(ui) || ui.result) return true;
  if (!p.home) return false;
  return isAdmin(p) || !!ui.status?.last;
}

/** "Last synced 12 minutes ago by @andres" — or how the last one ended, if it did not finish. "" = never. */
export function syncLastLabel(last: SyncRunView | null | undefined, now: number, form: "long" | "short" = "long"): string {
  if (!last) return "";
  const when = syncAgo(last.ended_at ?? last.updated_at, now, form);
  if (last.status === "abandoned") return form === "short" ? "Sync did not finish" : `Last sync did not finish (started by @${last.by})`;
  if (last.status === "failed") return form === "short" ? `Sync stopped ${when}` : `Last sync stopped ${when} (started by @${last.by})`;
  return form === "short" ? `Synced ${when}` : `Last synced ${when} by @${last.by}`;
}

/** The Repo header's line beside "updated 4m ago": how the last sync ended. "" = nothing to say —
 *  no sync on record, or one in progress (the Sync button beside it is already saying so). */
export function syncRepoLabel(ui: SyncUi, now: number): string {
  if (ui.starting || syncLive(ui)) return "";
  const last = ui.status?.last;
  if (!last) return "";
  const when = syncAgo(last.ended_at ?? last.updated_at, now, "short");
  if (last.status === "abandoned") return "last sync did not finish";
  if (last.status === "failed") return `last sync stopped ${when}`;
  return `synced ${when} by @${last.by}`;
}

// ── icons (each beside a word: status is never the colour alone) ─────────────
const svg = (size: number, body: string, extra = ""): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
const I_SYNC = (size = 15): string => svg(size, `<path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path>`, ` style="flex:none"`);
const I_SPIN = (size = 15): string => svg(size, `<path d="M21 12a9 9 0 1 1-9-9"></path>`, ` class="sync-spin" style="flex:none"`);
const I_OK = (size = 15): string => svg(size, `<path d="M20 6 9 17l-5-5"></path>`, ` style="flex:none;color:var(--green)"`);
const I_WARN = (size = 15): string => svg(size, `<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>`, ` style="flex:none;color:var(--amber)"`);
const I_STOP = (size = 15): string => svg(size, `<circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6M9 9l6 6"></path>`, ` style="flex:none;color:var(--red)"`);
const I_CLOSE = svg(14, `<path d="M18 6 6 18M6 6l12 12"></path>`);
const runIcon = (run: Pick<SyncRunView, "status">, size = 15): string =>
  run.status === "ok" ? I_OK(size) : run.status === "partial" ? I_WARN(size) : I_STOP(size);

// ── the header control ───────────────────────────────────────────────────────

export const SYNC_PANEL_ID = "sync-panel";
const BTN = "display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:8px;font-size:12.5px;font-weight:500;white-space:nowrap";

/** The button in the header (the panel's trigger), in the state the sync is in. "" when there is
 *  nothing to show (`syncShown`). */
export function syncControl(p: SyncProps): string {
  if (!syncShown(p)) return "";
  const { ui } = p;
  const live = syncLive(ui);
  const wire = `type="button" data-act="syncToggle" data-sync-btn aria-haspopup="dialog" aria-expanded="${ui.open}" aria-controls="${SYNC_PANEL_ID}"`;
  const outline = `${BTN};border:1px solid var(--border-strong);color:var(--fg-70)`;
  if (ui.starting || live) {
    const label = live ? syncCompactLabel(live) : "Syncing";
    const title = live ? `Sync in progress: ${SYNC_PHASE_LABEL[live.phase].toLowerCase()}` : "Sync in progress: starting";
    return `<button ${wire} title="${attr(title)}" aria-busy="true" class="cnpy-outlinebtn sync-btn" style="${outline}">${I_SPIN()}<span>${esc(label)}</span></button>`;
  }
  if (ui.result) {
    const r = ui.result;
    const word = r.status === "ok" ? "Synced" : r.status === "partial" ? "Synced with problems" : "Sync stopped";
    return `<button ${wire} title="${attr(`${syncResultTitle(r)}. Open to see what changed.`)}" class="cnpy-outlinebtn sync-btn" style="${outline}">${runIcon(r)}<span>${esc(word)}</span></button>`;
  }
  const last = ui.status?.last ?? null;
  const lastLong = syncLastLabel(last, p.now);
  if (!isAdmin(p)) {
    // A member: when it last ran, opening the same panel read-only. (`syncShown` already said there was a run.)
    return `<button ${wire} title="${attr(lastLong)}" class="cnpy-mutelink sync-btn sync-btn--quiet" style="${BTN};color:var(--fg-55)">${last && (last.status === "ok" || last.status === "partial") ? I_SYNC(14) : I_WARN(14)}<span>${esc(syncLastLabel(last, p.now, "short"))}</span></button>`;
  }
  const sub = last ? `<span class="sync-sub" style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(syncLastLabel(last, p.now, "short"))}</span>` : "";
  return `${sub}<button ${wire} title="${attr(lastLong || "See what a sync does, and start one")}" class="cnpy-outlinebtn sync-btn" style="${outline}">${I_SYNC()}<span>Sync GitHub</span></button>`;
}

/** The control in its slot. The slot is ALWAYS in the header (empty when there is nothing to show),
 *  so sync-actions.ts can repaint it alone as a run moves. */
export function syncSlot(p: SyncProps): string {
  return `<div data-sync-slot="ctl" class="sync-slot">${syncControl(p)}</div>`;
}

// ── the panel ────────────────────────────────────────────────────────────────

const T = "font-size:12.5px;line-height:1.55";
const P_MAIN = `${T};color:var(--fg);margin:0`;
const P_QUIET = `${T};color:var(--fg-70);margin:0`;
const P_FAINT = "font-size:12px;line-height:1.5;color:var(--fg-40);margin:0";
const EYEBROW = "font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";

const fact = (label: string, body: string): string =>
  `<div class="sync-fact"><dt style="${EYEBROW}">${esc(label)}</dt><dd style="${P_QUIET};min-width:0;overflow-wrap:anywhere">${body}</dd></div>`;
const note = (icon: string, body: string, role = ""): string =>
  `<div class="sync-note"${role ? ` role="${role}"` : ""}>${icon}<div style="min-width:0;overflow-wrap:anywhere">${body}</div></div>`;

/** A run's failures, each as what did not happen and what to do — built from the code alone. */
function failureList(run: SyncRunView): string {
  if (!run.failures.length) return "";
  const repo = run.repo;
  const tabs = new Set<string>();
  const rows = run.failures.map((f) => {
    const t = syncFailureText(f, repo);
    const tab = syncFailureTab(f);
    if (tab) tabs.add(tab);
    return `<li style="${T};margin:0"><span style="color:var(--fg)">${esc(t.what)}</span> <span style="color:var(--fg-70)">${esc(t.fix)}</span></li>`;
  }).join("");
  const links = [
    tabs.has("repos") ? goLink("Open Org settings › Repositories", "orgGo", "repos") : "",
    tabs.has("integrations") ? goLink("Open Org settings › Integrations", "orgGo", "integrations") : "",
  ].filter(Boolean).join("");
  return `<ul class="sync-fails">${rows}</ul>${links ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 14px">${links}</div>` : ""}`;
}

/** "Last sync" in the panel at rest: when, by whom, how it ended — and what failed, if anything did. */
function lastFact(last: SyncRunView | null, now: number): string {
  if (!last) return fact("Last sync", "No sync on record yet.");
  const when = syncAgo(last.ended_at ?? last.updated_at, now);
  if (last.status === "abandoned") {
    return fact("Last sync", `${note(I_WARN(14), `${esc(SYNC_DID_NOT_FINISH)} <span style="color:var(--fg-40)">Started by @${esc(last.by)}, last heard from ${esc(when)}.</span>`)}`);
  }
  const head = last.status === "failed" ? `Stopped ${when}. Started by @${last.by}.`
    : `${syncLastLabel(last, now)}${last.status === "partial" ? `, with ${last.failures.length === 1 ? "1 problem" : `${Math.max(1, last.failures.length)} problems`}` : ""}. Took ${syncDuration(last)}.`;
  return fact("Last sync", `${note(runIcon(last, 14), esc(head))}${failureList(last)}`);
}

function summariesFact(s: SyncSummariesView): string {
  return fact("AI summaries", esc(syncSummariesText(s)));
}
function scheduledFact(refreshedAt: string | null, now: number): string {
  return fact("On its own", `${esc(SYNC_SCHEDULED)}${refreshedAt ? ` Last refreshed ${esc(syncAgo(refreshedAt, now))}.` : ""}`);
}

/** What a sync is — the two or three lines above everything else at rest. */
function about(repo: string): string {
  const [reads, ...rest] = syncWhatItDoes(repo);
  return `<p style="${P_MAIN}">${esc(reads)}</p><p style="${P_QUIET};margin-top:6px">${esc(rest.join(" "))}</p>`;
}

const problemNote = (problem: SyncUi["problem"]): string => !problem ? ""
  : note(I_STOP(14), problem === "offline"
    ? "This page lost contact with Trov, so it stopped asking for the next pass. Whatever the sync had saved is kept."
    : "Trov did not accept the request. Try again in a few minutes.", "alert");

// The running view: everything on it is what the server last reported — never a guess.
function runningBody(p: SyncProps): string {
  const { ui } = p;
  const run = syncLive(ui);
  const driving = syncDriving(ui);
  if (!run) {
    // Sync now was pressed and the first batch has not answered: there is no run to describe yet.
    return `<div class="sync-phase"><span class="sync-phase-l" role="status" aria-live="polite">${I_SPIN(16)}<span>Starting</span></span></div>
      <div class="sync-bar is-open" aria-hidden="true"><span></span></div>
      <p style="${P_FAINT};margin-top:12px">${esc(SYNC_KEEPS_RUNNING)}</p>`;
  }
  const label = SYNC_PHASE_LABEL[run.phase];
  const known = typeof run.total === "number" && run.total > 0 && typeof run.done === "number";
  const reading = run.phase === "reading_prs" || run.phase === "reading_issues";
  const count = known ? `${run.done!.toLocaleString("en-US")} of ${run.total!.toLocaleString("en-US")}`
    : reading && typeof run.done === "number" && run.done > 0 ? `${run.done.toLocaleString("en-US")} read so far`
    : "";
  const bar = known
    ? `<progress class="sync-prog" max="${run.total}" value="${Math.min(run.done!, run.total!)}" aria-label="${attr(label)}">${esc(count)}</progress>`
    : `<div class="sync-bar is-open" aria-hidden="true"><span></span></div>`;
  const so = syncChanges(run.counts);
  const seen = syncSeenText(run.counts);
  const multi = run.batch > 1 || (run.batches ?? 1) > 1;
  const own = sameHandle(run.by, p.me);
  const watch = driving ? "" : note(I_SYNC(14), esc(syncWatchText(run, own)));
  // A run this page only watches: how long since it last reported (its heartbeat), once that is
  // long enough to matter — a run nobody is driving goes quiet before it reads as "did not finish".
  const quiet = driving ? 0 : Math.floor((p.now - Date.parse(run.updated_at)) / 1000);
  const dot = `<span aria-hidden="true">·</span>`;
  return `${watch}
    <div class="sync-phase"><span class="sync-phase-l" role="status" aria-live="polite">${I_SPIN(16)}<span>${esc(label)}</span></span>${count ? `<span class="sync-count">${esc(count)}</span>` : ""}</div>
    ${bar}
    <div class="sync-meta"><span title="${attr(SYNC_PASS_NOTE)}">${esc(syncPassLabel(run))}</span>${dot}<span><span data-sync-elapsed>${esc(syncDuration(run, p.now))}</span> elapsed</span>${driving || own ? "" : `${dot}<span>started by @${esc(run.by)}</span>`}${quiet >= 20 ? `${dot}<span>no report for ${esc(syncDuration({ started_at: run.updated_at, ended_at: null }, p.now))}</span>` : ""}</div>
    <dl class="sync-facts">
      ${fact("So far", so.length ? esc(`${so.join(", ")}.`) : "Nothing saved yet.")}
      ${seen ? fact("Read", esc(seen)) : ""}
    </dl>
    <p style="${P_FAINT};margin-top:12px">${multi ? `${esc(SYNC_PASS_NOTE)} ` : ""}${driving ? esc(SYNC_KEEPS_RUNNING) : ""}</p>`;
}

// A finished run, until it is dismissed.
function resultBody(p: SyncProps, run: SyncRunView): string {
  const s = p.ui.resultSummaries ?? p.ui.status?.summaries ?? null;
  const tone = run.status === "ok" ? "var(--green)" : run.status === "partial" ? "var(--amber)" : "var(--red)";
  const head = `<div class="sync-result" role="status" style="--tone:${tone}">${runIcon(run, 17)}<div style="min-width:0"><div style="font-size:14px;font-weight:600;color:var(--fg)">${esc(syncResultTitle(run))}</div><div style="${P_FAINT}">Took ${esc(syncDuration(run))}${sameHandle(run.by, p.me) ? "" : ` · started by @${esc(run.by)}`}</div></div></div>`;
  if (run.status === "failed") return `${head}${failureList(run)}`;
  const changes = syncChanges(run.counts);
  const since = run.previous_at ? `Nothing new since the last sync, ${syncAgo(run.previous_at, p.now)}.` : "Nothing new. Everything GitHub listed was already saved.";
  const what = syncNothingNew(run) ? `<p style="${P_MAIN}">${esc(since)}</p>`
    : `<p style="${P_MAIN}">${esc(`${changes.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()))}</p>`;
  const seen = syncSeenText(run.counts);
  // What is still waiting, and why. Summaries not written for a reason that is not a failure (the
  // month's allowance, an ended plan, no key on this deployment) is said once, as that reason — and
  // without recounting the items the sentence above already called excerpts.
  const c = run.counts;
  const excerpts = c.summaries_skipped + c.summaries_failed;
  const waiting = !s || s.status === "on" || c.summaries_pending > excerpts ? syncLeftoverText(c, s)
    : excerpts > 0 || c.summaries_pending > 0 ? syncSummariesText(s) : "";
  return `${head}${what}
    ${seen ? `<p style="${P_QUIET};margin-top:6px">${esc(seen)}</p>` : ""}
    ${waiting ? `<p style="${P_QUIET};margin-top:6px">${esc(waiting)}</p>` : ""}
    ${failureList(run)}`;
}

/** The panel's body and its footer for the state it is in. */
function panelParts(p: SyncProps): { body: string; foot: string } {
  const { ui } = p;
  const st = ui.status;
  const mode = syncMode(p);
  const problem = problemNote(ui.problem);
  if (mode === "loading") return { body: `<p style="${P_FAINT}" role="status">Checking the last sync…</p>`, foot: "" };
  if (mode === "error") return { body: `${problem}<p style="${P_QUIET}" role="alert">Couldn't load the sync status. Check your connection, then try again.</p>`, foot: quietBtn("Try again", "syncReload") };
  if (mode === "running") return { body: `${problem}${runningBody(p)}`, foot: "" };
  if (mode === "result") {
    const run = ui.result!;
    const again = isAdmin(p) && run.status !== "ok";
    return { body: `${problem}${resultBody(p, run)}`, foot: `${again ? accentBtn("Sync again", "syncStart") : ""}${again ? quietBtn("Dismiss", "syncDismiss") : accentBtn("Done", "syncDismiss")}` };
  }
  const facts = (extra = ""): string => `<dl class="sync-facts">${lastFact(st!.last, p.now)}${extra}</dl>`;
  if (mode === "readonly") {
    return {
      body: `${st!.repo ? about(st!.repo) : `<p style="${P_MAIN}">${esc(syncBlockText("no_repo", null).what)}</p>`}
        ${facts(scheduledFact(st!.refreshed_at, p.now))}
        <p style="${P_FAINT};margin-top:12px">${esc(SYNC_ADMINS_ONLY)}</p>`,
      foot: "",
    };
  }
  if (mode === "blocked") {
    const b = syncBlockText(st!.blocked!, null, st!.connect, st!.wrong_account && st!.repo ? { account: st!.wrong_account, repo: st!.repo } : null);
    return {
      body: `${problem}${note(I_WARN(15), `<div style="${P_MAIN};font-weight:500">${esc(b.what)}</div><div style="${P_QUIET};margin-top:2px">${esc(syncNeedsText(st!.connect))}</div>${b.link && b.tab ? `<div style="margin-top:8px">${goLink(b.link, "orgGo", b.tab)}</div>` : ""}`)}
        ${st!.last ? facts() : ""}`,
      foot: "",
    };
  }
  return {
    body: `${problem}${about(st!.repo ?? "the repository")}
      ${facts(`${summariesFact(st!.summaries)}${scheduledFact(st!.refreshed_at, p.now)}`)}`,
    foot: accentBtn("Sync now", "syncStart", { extra: "min-width:96px" }),
  };
}

/** The panel, as a root-level overlay: a click-away layer and the dialog. "" when it is closed
 *  (or the control it hangs from is not on this screen). */
export function syncOverlay(p: SyncProps): string {
  if (!p.ui.open || !syncShown(p)) return "";
  const repo = syncLive(p.ui)?.repo ?? p.ui.result?.repo ?? p.ui.status?.repo ?? "";
  const { body, foot } = panelParts(p);
  return `<div data-overlay="sync" class="sync-layer">
    <div data-act="syncClose" class="sync-back" aria-hidden="true"></div>
    <div id="${SYNC_PANEL_ID}" role="dialog" aria-modal="true" aria-labelledby="${SYNC_PANEL_ID}-t" tabindex="-1" data-sync-panel data-sync-mode="${syncMode(p)}" class="cnpy-surface sync-panel">
      <div class="sync-head">
        <h2 id="${SYNC_PANEL_ID}-t" style="font-size:14px;font-weight:600;letter-spacing:-0.01em;margin:0;white-space:nowrap">Sync GitHub</h2>
        ${repo ? `<span class="sync-repo" title="${attr(`The primary repository: ${repo}`)}">${esc(repo)}</span>` : `<span style="flex:1"></span>`}
        <button type="button" data-act="syncClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="flex:none;width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:var(--fg-55)">${I_CLOSE}</button>
      </div>
      <div class="sync-body">${body}</div>
      ${foot ? `<div class="sync-foot">${foot}</div>` : ""}
    </div>
  </div>`;
}
