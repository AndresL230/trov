/**
 * Sync GitHub — the header control and the panel (web/src/sync.ts), in every state it has.
 * Pure render tests: props in, markup out. The copy is shared/sync.ts's (docs/architecture/sync.md).
 */
import { describe, it, expect } from "vitest";
import {
  initialSyncUi, syncAgo, syncControl, syncLastLabel, syncMode, syncOverlay, syncRepoLabel, syncShown, syncSlot,
  type SyncProps, type SyncUi,
} from "../web/src/sync";
import {
  SYNC_SUMMARIES_PER_RUN, zeroSyncCounts,
  syncBlockText, syncFailureTab, syncPassLabel, syncResultTitle, syncSummariesText,
  type SyncCounts, type SyncRunView, type SyncStatusView, type SyncSummariesView,
} from "@shared/sync";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const at = (minsAgo: number): string => new Date(NOW - minsAgo * 60_000).toISOString();

const counts = (over: Partial<SyncCounts> = {}): SyncCounts => ({ ...zeroSyncCounts(), ...over });
const run = (over: Partial<SyncRunView> = {}): SyncRunView => ({
  id: 7, repo: "acme/widgets", by: "andres", started_at: at(13), updated_at: at(12), ended_at: at(12), status: "ok",
  batch: 3, batches: 3, phase: "done", done: null, total: null, counts: counts(), failures: [], previous_at: null, ...over,
});
const live = (over: Partial<SyncRunView> = {}): SyncRunView =>
  run({ status: "running", started_at: at(1.2), updated_at: at(0), ended_at: null, batch: 3, batches: 8, phase: "saving_prs", done: 38, total: 120, ...over });
const summaries = (over: Partial<SyncSummariesView> = {}): SyncSummariesView =>
  ({ status: "on", used: 62, cap: 100, remaining: 38, pending: 12, per_run: SYNC_SUMMARIES_PER_RUN, ...over });
const status = (over: Partial<SyncStatusView> = {}): SyncStatusView => ({
  repo: "acme/widgets", admin: true, blocked: null, connect: "token", via: "token", wrong_account: null, running: null, last: run(), summaries: summaries(), refreshed_at: at(125), ...over,
});
const ui = (over: Partial<SyncUi> = {}): SyncUi => ({ ...initialSyncUi(), load: "ok", status: status(), ...over });
const props = (u: Partial<SyncUi> = {}, over: Partial<SyncProps> = {}): SyncProps => ({ ui: ui(u), admin: true, me: "andres", home: true, now: NOW, ...over });
const panel = (u: Partial<SyncUi> = {}, over: Partial<SyncProps> = {}): string => syncOverlay(props({ open: true, ...u }, over));
/** The markup's words, as a person reads them. */
const text = (html: string): string => html.replace(/<title>[^<]*<\/title>/g, "").replace(/<[^>]+>/g, " ").replace(/&rarr;/g, "→").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const member = (st: Partial<SyncStatusView> = {}, u: Partial<SyncUi> = {}): SyncProps => props({ status: status({ admin: false, ...st }), ...u }, { admin: false, me: "ines" });

describe("relative time", () => {
  it("long and short forms, whole units, never negative", () => {
    expect(syncAgo(at(0.3), NOW)).toBe("just now");
    expect(syncAgo(at(1), NOW)).toBe("1 minute ago");
    expect(syncAgo(at(12), NOW)).toBe("12 minutes ago");
    expect(syncAgo(at(12), NOW, "short")).toBe("12m ago");
    expect(syncAgo(at(125), NOW)).toBe("2 hours ago");
    expect(syncAgo(at(60 * 49), NOW, "short")).toBe("2d ago");
    expect(syncAgo(at(-5), NOW)).toBe("just now");
    expect(syncAgo(null, NOW)).toBe("");
    expect(syncAgo("not a date", NOW)).toBe("");
  });
});

describe("the header control", () => {
  it("an admin on My Work: Sync GitHub, a real popup trigger, with when it last ran as its title and sub-label", () => {
    const html = syncControl(props());
    expect(html).toContain('data-act="syncToggle"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="sync-panel"');
    expect(html).toContain("<span>Sync GitHub</span>");
    expect(html).toContain('title="Last synced 12 minutes ago by @andres"');
    expect(html).toContain('class="sync-sub"');
    expect(text(html)).toContain("Synced 12m ago");
    expect(syncControl(props({ open: true }))).toContain('aria-expanded="true"');
  });
  it("an admin before any sync (or before GET /sync has answered): the button, no sub-label", () => {
    const never = syncControl(props({ status: status({ last: null }) }));
    expect(never).toContain("Sync GitHub");
    expect(never).not.toContain("sync-sub");
    expect(never).toContain('title="See what a sync does, and start one"');
    expect(syncControl(props({ status: null, load: "idle" }))).toContain("Sync GitHub");
  });
  it("is on My Work only at rest — and on every screen while a run is in progress or its result is unread", () => {
    expect(syncShown(props({}, { home: false }))).toBe(false);
    expect(syncControl(props({}, { home: false }))).toBe("");
    expect(syncShown(props({ mine: live() }, { home: false }))).toBe(true);
    expect(syncShown(props({ starting: true }, { home: false }))).toBe(true);
    expect(syncShown(props({ status: status({ running: live({ by: "maya" }), blocked: "running" }) }, { home: false }))).toBe(true);
    expect(syncShown(props({ result: run() }, { home: false }))).toBe(true);
  });
  it("the slot is always emitted, and empty when there is nothing to show", () => {
    expect(syncSlot(props({}, { home: false }))).toBe('<div data-sync-slot="ctl" class="sync-slot"></div>');
    expect(syncSlot(props())).toContain("Sync GitHub");
  });
  it("closed but running: a spinner and the pass, and it still opens the panel", () => {
    const html = syncControl(props({ mine: live() }, { home: false }));
    expect(html).toContain("<span>Syncing 3 of 8</span>");
    expect(html).toContain('class="sync-spin"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-act="syncToggle"');
    expect(html).toContain('title="Sync in progress: saving pull requests and summaries"');
    expect(html).not.toContain("disabled");
    // Before the first batch has counted the backlog there is no "of".
    expect(syncControl(props({ mine: live({ batch: 1, batches: null }) }))).toContain("<span>Syncing</span>");
    expect(syncControl(props({ starting: true }))).toContain("<span>Syncing</span>");
  });
  it("an unread result: the word and an icon, per how it ended", () => {
    expect(syncControl(props({ result: run() }))).toContain("<span>Synced</span>");
    expect(syncControl(props({ result: run({ status: "partial", failures: [{ code: "reconcile:deployments" }] }) }))).toContain("<span>Synced with problems</span>");
    const stopped = syncControl(props({ result: run({ status: "failed", failures: [{ code: "list_prs", status: 403 }] }) }));
    expect(stopped).toContain("<span>Sync stopped</span>");
    expect(stopped).toContain("var(--red)");
    expect(stopped).toContain("<svg");
  });
  it("a member: a quiet 'Synced 12m ago' that opens the panel — and nothing at all if no sync ever ran", () => {
    const html = syncControl(member());
    expect(html).toContain("<span>Synced 12m ago</span>");
    expect(html).toContain('data-act="syncToggle"');
    expect(html).toContain('title="Last synced 12 minutes ago by @andres"');
    expect(html).not.toContain("Sync GitHub");
    expect(syncControl(member({ last: null }))).toBe("");
    expect(syncShown(member({ last: null }))).toBe(false);
    // A member who is an admin of ANOTHER org is still a member here: the status says so.
    expect(syncControl(props({ status: status({ admin: false, last: null }) }, { admin: true }))).toBe("");
    expect(syncControl(member({ last: run({ status: "abandoned" }) }))).toContain("<span>Sync did not finish</span>");
    expect(syncControl(member({ last: run({ status: "failed" }) }))).toContain("<span>Sync stopped 12m ago</span>");
  });
  it("a member sees a run in progress too", () => {
    expect(syncControl(member({ running: live(), blocked: "running" }))).toContain("<span>Syncing 3 of 8</span>");
  });
});

describe("the panel — a labelled dialog", () => {
  it("is nothing when closed, and nothing where its control is not shown", () => {
    expect(syncOverlay(props())).toBe("");
    expect(syncOverlay(props({ open: true }, { home: false }))).toBe("");
  });
  it("role, label, a close button, a click-away layer, the repository named", () => {
    const html = panel();
    expect(html).toContain('data-overlay="sync"');
    expect(html).toContain('id="sync-panel" role="dialog" aria-modal="true" aria-labelledby="sync-panel-t" tabindex="-1"');
    expect(html).toMatch(/<h2 id="sync-panel-t"[^>]*>Sync GitHub<\/h2>/);
    expect(html).toContain('data-act="syncClose" aria-label="Close"');
    expect(html).toContain('<div data-act="syncClose" class="sync-back" aria-hidden="true"></div>');
    expect(html).toContain(">acme/widgets</span>");
  });
  it("uses a token for every colour", () => {
    for (const html of [panel(), panel({ mine: live() }), panel({ result: run({ status: "failed", failures: [{ code: "list_prs", status: 403 }] }) }), syncControl(props())]) {
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html).not.toMatch(/rgba?\(/);
    }
  });
});

describe("ready", () => {
  it("says what a sync reads and writes for THIS repository, when the last one ran, the summaries, the schedule — and one primary action", () => {
    const html = panel();
    const t = text(html);
    expect(syncMode(props())).toBe("ready");
    expect(t).toContain("Reads every closed pull request and every open issue in acme/widgets from GitHub.");
    expect(t).toContain("Updates My Work, the tickets mirrored from issues, and AI summaries.");
    expect(t).toContain("Then refreshes deployments, CI, branches and drift. It never closes or deletes anything.");
    expect(t).toContain("Last synced 12 minutes ago by @andres. Took 1m 0s.");
    expect(t).toContain("About 12 items are waiting for an AI summary. This sync tries them, and anything new. 38 of 100 left this month.");
    expect(t).toContain("Trov also refreshes deployments and CI on its own every 6 hours. Last refreshed 2 hours ago.");
    expect(html.match(/cnpy-accentbtn/g)).toHaveLength(1);
    expect(html).toContain('data-act="syncStart"');
    expect(html).toContain(">Sync now</button>");
    expect(html).not.toContain("progress");
  });
  it("summaries: unlimited is just the expectation; a larger backlog and a small allowance are said plainly", () => {
    expect(text(panel({ status: status({ summaries: summaries({ cap: null, remaining: null }) }) }))).toContain("About 12 items are waiting for an AI summary. This sync tries them, and anything new. On its own");
    expect(syncSummariesText(summaries({ cap: null, remaining: null, pending: 1 }))).toBe("About 1 item is waiting for an AI summary. This sync tries it, and anything new.");
    expect(syncSummariesText(summaries({ cap: null, remaining: null, pending: 73 }))).toBe("About 73 items are waiting for an AI summary. A sync tries at most 50; later syncs do the rest.");
    expect(syncSummariesText(summaries({ used: 97, remaining: 3, pending: 12 }))).toBe("About 12 items are waiting for an AI summary, but only 3 of this month's 100 are left.");
    // Nothing stored is waiting — which says nothing about what GitHub has that Trov has not read yet.
    expect(syncSummariesText(summaries({ pending: 0 }))).toBe("New pull requests and assigned issues get an AI summary, at most 50 a sync. 38 of 100 left this month.");
    expect(syncSummariesText(summaries({ pending: 0, cap: null, remaining: null }))).toBe("New pull requests and assigned issues get an AI summary, at most 50 a sync.");
  });
  it("summaries off / used up / ended are one quiet line, not an error — and Sync now stays", () => {
    const off = panel({ status: status({ summaries: summaries({ status: "off", cap: null, remaining: null, used: 0 }) }) });
    expect(text(off)).toContain("AI summaries are off on this deployment, so new items show an excerpt.");
    expect(off).not.toContain('role="alert"');
    expect(off).not.toContain("var(--red)");
    expect(off).toContain(">Sync now</button>");
    const capped = panel({ status: status({ summaries: summaries({ status: "capped", used: 100, remaining: 0 }) }) });
    expect(text(capped)).toContain("This month's 100 AI summaries are used up, so new items show an excerpt until next month.");
    expect(capped).not.toContain('role="alert"');
    expect(text(panel({ status: status({ summaries: summaries({ status: "ended" }) }) }))).toContain("This organization's plan has ended, so new items show an excerpt.");
  });
  it("no sync on record, and never refreshed", () => {
    const t = text(panel({ status: status({ last: null, refreshed_at: null }) }));
    expect(t).toContain("No sync on record yet.");
    expect(t).toContain("every 6 hours.");
    expect(t).not.toContain("Last refreshed");
  });
  it("the last run by someone else, and one that finished with problems", () => {
    expect(text(panel({ status: status({ last: run({ by: "maya", ended_at: at(180), started_at: at(182) }) }) }))).toContain("Last synced 3 hours ago by @maya. Took 2m 0s.");
    const partial = text(panel({ status: status({ last: run({ status: "partial", failures: [{ code: "reconcile:deployments" }] }) }) }));
    expect(partial).toContain("Last synced 12 minutes ago by @andres, with 1 problem.");
    expect(partial).toContain("Could not read deployments from GitHub.");
    const failed = text(panel({ status: status({ last: run({ status: "failed", failures: [{ code: "list_prs", status: 403 }] }) }) }));
    expect(failed).toContain("Stopped 12 minutes ago. Started by @andres.");
    expect(failed).toContain("Could not read pull requests: GitHub refused the token (403). Nothing was written.");
  });
  it("abandoned: 'did not finish', what it saved is kept, and Sync now is available again", () => {
    const html = panel({ status: status({ last: run({ status: "abandoned", ended_at: at(4), updated_at: at(4) }) }) });
    expect(text(html)).toContain("The last sync did not finish. Whatever it had saved is kept. Started by @andres, last heard from 4 minutes ago.");
    expect(html).toContain(">Sync now</button>");
    expect(syncLastLabel(run({ status: "abandoned" }), NOW)).toBe("Last sync did not finish (started by @andres)");
  });
  it("loading and a failed read", () => {
    expect(text(panel({ status: null, load: "loading" }))).toContain("Checking the last sync…");
    const failed = panel({ status: null, load: "error" });
    expect(text(failed)).toContain("Couldn't load the sync status. Check your connection, then try again.");
    expect(failed).toContain('data-act="syncReload"');
    expect(failed).not.toContain("syncStart");
  });
});

describe("cannot run", () => {
  it("no repository: says so, links to Org settings › Repositories, offers no Sync", () => {
    const p = props({ open: true, status: status({ repo: null, blocked: "no_repo", last: null }) });
    const html = syncOverlay(p);
    expect(syncMode(p)).toBe("blocked");
    expect(text(html)).toContain("No repository is connected to this organization yet.");
    expect(html).toContain('data-act="orgGo" data-arg="repos"');
    expect(text(html)).toContain("Connect one in Org settings › Repositories →");
    expect(html).not.toContain("syncStart");
    expect(syncBlockText("no_repo", null).tab).toBe("repos"); // an Org settings tab id (web/src/org-settings.ts ORG_TABS)
  });
  it("no GitHub token, on a Trov without the GitHub App: says so, links to Org settings › Integrations, offers no Sync — and still says when it last ran", () => {
    const html = panel({ status: status({ blocked: "no_token", connect: "token", via: null }) });
    expect(text(html)).toContain("There is no GitHub token to read the repository with.");
    expect(text(html)).toContain("A sync needs both a repository and a GitHub token.");
    expect(html).toContain('data-act="orgGo" data-arg="integrations"');
    expect(html).not.toContain('data-arg="repos"');
    expect(text(html)).toContain("Add one in Org settings › Integrations →");
    expect(text(html)).toContain("Last synced 12 minutes ago by @andres.");
    expect(html).not.toContain("syncStart");
  });
  it("no GitHub credential, where the GitHub App is configured: sends the admin to Repositories to Connect with GitHub — the setup checklist's own choice", () => {
    const p = props({ open: true, status: status({ blocked: "no_token", connect: "app", via: null }) });
    const html = syncOverlay(p);
    expect(syncMode(p)).toBe("blocked");
    expect(text(html)).toContain("GitHub is not connected, so the repository cannot be read.");
    expect(text(html)).toContain("A sync needs a repository and a GitHub connection to read it with.");
    expect(html).toContain('data-act="orgGo" data-arg="repos"');
    expect(html).not.toContain('data-arg="integrations"');
    expect(text(html)).toContain("Connect with GitHub in Org settings › Repositories →");
    expect(text(html)).not.toContain("GitHub token");
    expect(html).not.toContain("syncStart");
    expect(syncBlockText("no_token", null, "app")).toMatchObject({ tab: "repos" });
    expect(syncBlockText("no_token", null, "app", { account: "olive", repo: "acme/widgets" }).what).toBe("The GitHub App is installed on olive, which does not own acme/widgets.");
    expect(syncBlockText("no_token", null, "token")).toMatchObject({ tab: "integrations" });
    expect(syncBlockText("no_token", null)).toMatchObject({ tab: "integrations" }); // an older answer with no `connect`
    // A member is never offered either link.
    expect(syncOverlay(member({ blocked: "no_token", connect: "app", via: null }, { open: true }))).not.toContain("orgGo");
  });
  it("another sync in progress: that run's progress and who started it — no second start", () => {
    const p = props({ open: true, status: status({ blocked: "running", running: live({ by: "maya" }) }) });
    const html = syncOverlay(p);
    expect(syncMode(p)).toBe("running");
    expect(text(html)).toContain("@maya started this sync. It runs from their browser; this page shows its progress.");
    expect(text(html)).toContain("started by @maya");
    expect(text(html)).toContain("Saving pull requests and summaries");
    expect(html).not.toContain("syncStart");
    expect(text(html)).not.toContain("You can close this panel");
  });
  it("not an admin: no Sync action at all, but when it last ran — and why there is no button", () => {
    const p = { ...member(), ui: { ...member().ui, open: true } };
    const html = syncOverlay(p);
    expect(syncMode(p)).toBe("readonly");
    expect(text(html)).toContain("Last synced 12 minutes ago by @andres.");
    expect(text(html)).toContain("Only an admin or owner can start a sync.");
    expect(text(html)).toContain("Reads every closed pull request");
    expect(html).not.toContain("syncStart");
    expect(html).not.toContain("cnpy-accentbtn");
    expect(html).not.toContain("orgGo");
  });
});

describe("running — only what the server reported", () => {
  it("a known total: the phase, done of total, a determinate progress bar, the pass, the counts so far, the time", () => {
    const html = panel({ mine: live({ counts: counts({ prs_seen: 146, issues_seen: 23, prs_new: 12, issues_changed: 3, tickets_created: 2, tickets_updated: 1, summaries_written: 9, summaries_failed: 1 }) }) });
    const t = text(html);
    expect(t).toContain("Saving pull requests and summaries 38 of 120");
    expect(html).toContain('<progress class="sync-prog" max="120" value="38" aria-label="Saving pull requests and summaries">');
    expect(t).toContain("Pass 3 of about 8");
    expect(t).toContain("1m 12s elapsed");
    expect(t).toContain("12 new pull requests, 3 issues updated, 2 tickets created, 1 ticket updated, 9 summaries written, 1 shown as an excerpt.");
    expect(t).toContain("GitHub listed 146 closed pull requests and 23 open issues.");
    expect(t).toContain("Each pass writes up to 5 AI summaries. You can close this panel. The sync keeps running while this tab stays open.");
    // The PHASE is announced when it changes; the count beside it (it moves every second) is not in the live region.
    expect(html).toMatch(/<span class="sync-phase-l" role="status" aria-live="polite">.*?<span>Saving pull requests and summaries<\/span><\/span><span class="sync-count">38 of 120<\/span>/s);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).not.toContain("syncStart");
    expect(html).not.toContain("syncDismiss");
  });
  it("an unknown total: how many were read so far, an honest indeterminate bar, NO progressbar and no percentage", () => {
    const html = panel({ mine: live({ batch: 1, batches: null, phase: "reading_prs", done: 412, total: null }) });
    const t = text(html);
    expect(t).toContain("Reading pull requests 412 read so far");
    expect(html).not.toContain("<progress");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('<div class="sync-bar is-open" aria-hidden="true">');
    expect(t).toContain("Pass 1 ·");
    expect(t).not.toContain(" of about");
    expect(t).not.toContain("%");
    expect(t).toContain("Nothing saved yet.");
  });
  it("the closing refresh and the first moments have no number at all", () => {
    const reconcile = panel({ mine: live({ phase: "reconcile", done: null, total: null }) });
    expect(text(reconcile)).toContain("Checking deployments and CI");
    expect(reconcile).not.toContain("<progress");
    expect(reconcile).not.toContain("sync-count");
    const zero = panel({ mine: live({ phase: "saving_issues", done: 0, total: 0 }) });
    expect(zero).not.toContain("<progress");
    const starting = panel({ starting: true, status: status({ last: null }) });
    expect(text(starting)).toContain("Starting");
    expect(starting).not.toContain("<progress");
    expect(starting).not.toContain("syncStart");
  });
  it("the pass wording", () => {
    expect(syncPassLabel({ batch: 1, batches: null })).toBe("Pass 1");
    expect(syncPassLabel({ batch: 3, batches: 8 })).toBe("Pass 3 of about 8");
    expect(syncPassLabel({ batch: 8, batches: 8 })).toBe("Pass 8 of 8");
  });
  it("my own run that this page is not driving (another tab, or a reload): says so, and does not offer a second start", () => {
    const html = panel({ status: status({ blocked: "running", running: live() }) });
    expect(text(html)).toContain("You started this sync from another tab, or before this page was reloaded. If that tab is closed, it stops after its current pass; whatever it has saved is kept.");
    expect(html).not.toContain("syncStart");
    expect(text(html)).not.toContain("started by @andres"); // the note above already says whose it is
  });
  it("a watched run that has gone quiet says for how long — its heartbeat, not a guess", () => {
    const quiet = text(panel({ status: status({ blocked: "running", running: live({ by: "maya", updated_at: at(1.5) }) }) }));
    expect(quiet).toContain("started by @maya · no report for 1m 30s");
    expect(text(panel({ status: status({ blocked: "running", running: live({ by: "maya", updated_at: at(0.1) }) }) }))).not.toContain("no report");
    // The run this tab drives is reporting through this tab: never "no report".
    expect(text(panel({ mine: live({ updated_at: at(1.5) }) }))).not.toContain("no report");
  });
  it("running wins over an old result; this tab's run over the one GET /sync last reported", () => {
    const p = props({ open: true, mine: live({ batch: 4 }), result: run(), status: status({ running: live({ batch: 3 }) }) });
    expect(syncMode(p)).toBe("running");
    expect(text(syncOverlay(p))).toContain("Pass 4 of about 8");
  });
});

describe("finished — a result that stays until dismissed", () => {
  it("with changes: what changed as a sentence, how long it took, Done", () => {
    const done = run({ started_at: at(13.2), ended_at: at(12), counts: counts({ prs_seen: 146, issues_seen: 23, prs_new: 12, issues_changed: 3, summaries_written: 14, repo_written: 40 }), previous_at: at(600) });
    const p = props({ open: true, result: done });
    const html = syncOverlay(p);
    const t = text(html);
    expect(syncMode(p)).toBe("result");
    expect(t).toContain("Sync finished");
    expect(t).toContain("Took 1m 12s");
    expect(t).toContain("12 new pull requests, 3 issues updated, 14 summaries written, deployments and CI refreshed.");
    expect(t).toContain("GitHub listed 146 closed pull requests and 23 open issues.");
    expect(html).toContain('data-act="syncDismiss"');
    expect(html).toContain(">Done</button>");
    expect(html).not.toContain("syncStart");
    expect(html).toContain("var(--green)");
    expect(html).toContain('role="status"');
  });
  it("nothing new: since the last sync, or since ever", () => {
    expect(text(panel({ result: run({ previous_at: at(180) }) }))).toContain("Nothing new since the last sync, 3 hours ago.");
    expect(text(panel({ result: run({ previous_at: null }) }))).toContain("Nothing new. Everything GitHub listed was already saved.");
  });
  it("a bound was reached: what is still waiting is said", () => {
    expect(text(panel({ result: run({ batch: 10, batches: 10, counts: counts({ summaries_written: 50, summaries_pending: 23 }) }) }))).toContain("23 items are still waiting for an AI summary. A later sync continues with them.");
  });
  it("items stored as excerpts because the allowance ran out: the reason, once", () => {
    const html = panel({ result: run({ counts: counts({ prs_new: 4, summaries_skipped: 4 }) }), resultSummaries: summaries({ status: "capped", used: 3, cap: 3, remaining: 0 }) });
    expect(text(html)).toContain("4 new pull requests, 4 shown as excerpts.");
    expect(text(html)).toContain("This month's 3 AI summaries are used up, so new items show an excerpt until next month.");
    // The allowance ran out part-way: what is still waiting is waiting for THAT, not for "a later sync".
    const mid = text(panel({ result: run({ counts: counts({ prs_new: 2, summaries_written: 3, summaries_pending: 2 }) }), resultSummaries: summaries({ status: "capped", used: 25, cap: 25, remaining: 0 }) }));
    expect(mid).toContain("2 items are still waiting for an AI summary. This month's 25 AI summaries are used up, so new items show an excerpt until next month.");
    expect(mid).not.toContain("A later sync continues");
    // No summaries key: the items it just called excerpts are not counted a second time as "waiting".
    const off = text(panel({ result: run({ counts: counts({ prs_new: 4, summaries_skipped: 4, summaries_pending: 4 }) }), resultSummaries: summaries({ status: "off", cap: null, remaining: null, used: 0 }) }));
    expect(off).toContain("4 new pull requests, 4 shown as excerpts.");
    expect(off).toContain("AI summaries are off on this deployment, so new items show an excerpt.");
    expect(off).not.toContain("still waiting");
  });
  it("partial: finished with problems — each failure as what and how to fix it; Sync again beside Dismiss", () => {
    const html = panel({ result: run({ status: "partial", counts: counts({ prs_new: 2, repo_written: 12 }), failures: [{ code: "reconcile:deployments" }, { code: "reconcile:unexpected" }] }) });
    const t = text(html);
    expect(t).toContain("Sync finished with 2 problems");
    expect(t).toContain("2 new pull requests, deployments and CI refreshed.");
    expect(t).toContain("Could not read deployments from GitHub. Everything else finished. Check that the GitHub token in Org settings › Integrations can read this repository, then sync again.");
    expect(t).toContain("Could not refresh deployments and CI. Pull requests and issues were synced. Try again in a few minutes.");
    expect(html).toContain('data-act="orgGo" data-arg="integrations"');
    expect(html).toContain(">Sync again</button>");
    expect(html).toContain(">Dismiss</button>");
    expect(html).toContain("var(--amber)");
    expect(syncResultTitle({ status: "partial", failures: [{ code: "reconcile:runs" }] })).toBe("Sync finished with 1 problem");
  });
  it("failed: stopped, nothing written, the fix — and no claim that anything changed", () => {
    const html = panel({ result: run({ status: "failed", batch: 1, batches: null, failures: [{ code: "list_prs", status: 403 }] }) });
    const t = text(html);
    expect(t).toContain("Sync stopped");
    expect(t).toContain("Could not read pull requests: GitHub refused the token (403). Nothing was written. Check that the GitHub token in Org settings › Integrations can read this repository, then sync again.");
    expect(t).not.toContain("Nothing new");
    expect(html).toContain('data-act="orgGo" data-arg="integrations"');
    expect(html).toContain(">Sync again</button>");
    expect(html).toContain("var(--red)");
    const upstream = text(panel({ result: run({ status: "failed", failures: [{ code: "list_issues", status: 502 }] }) }));
    expect(upstream).toContain("Could not read issues: GitHub answered 502. Nothing was written. Try again in a few minutes.");
    expect(syncFailureTab({ code: "list_issues", status: 502 })).toBeNull();
  });
  it("a failure of a read made through the GitHub App points at Repositories and never mentions a token", () => {
    const html = panel({ result: run({ status: "failed", batch: 1, batches: null, failures: [{ code: "list_prs", status: 404, via: "app" }] }) });
    const t = text(html);
    expect(t).toContain("Could not read pull requests: GitHub found no acme/widgets the Trov App can see (404). Nothing was written. Check in Org settings › Repositories that the Trov App on GitHub still has access to this repository, then sync again.");
    expect(t).not.toContain("token");
    expect(html).toContain('data-act="orgGo" data-arg="repos"');
    expect(html).not.toContain('data-arg="integrations"');
    expect(text(panel({ result: run({ status: "failed", failures: [{ code: "list_issues", status: 403, via: "app" }] }) }))).toContain("GitHub refused the Trov App's access (403).");
    const partial = panel({ result: run({ status: "partial", failures: [{ code: "reconcile:runs", via: "app" }, { code: "reconcile:unexpected" }] }) });
    expect(text(partial)).toContain("Could not read workflow runs from GitHub. Everything else finished. Check in Org settings › Repositories that the Trov App on GitHub still has access to this repository, then sync again.");
    expect(partial).toContain('data-act="orgGo" data-arg="repos"');
    expect(syncFailureTab({ code: "reconcile:runs", via: "app" })).toBe("repos");
    expect(syncFailureTab({ code: "reconcile:runs", via: "token" })).toBe("integrations");
    expect(syncFailureTab({ code: "reconcile:runs" })).toBe("integrations");
    expect(syncFailureTab({ code: "reconcile:unexpected", via: "app" })).toBeNull();
    expect(text(panel({ result: run({ status: "failed", failures: [{ code: "not_configured" }] }) })))
      .toContain("This organization has no repository, or no GitHub connection to read it with. Connect GitHub in Org settings › Repositories, or set a GitHub token in Integrations.");
  });
  it("a result someone else's run left for a member: readable, dismissable, never restartable", () => {
    const p = member({}, { open: true, result: run({ status: "failed", by: "maya", failures: [{ code: "unexpected" }] }) });
    const html = syncOverlay(p);
    expect(text(html)).toContain("started by @maya");
    expect(text(html)).toContain("The sync stopped before it finished. Whatever it had saved is kept. Try again in a few minutes.");
    expect(html).not.toContain("syncStart");
    expect(html).toContain(">Done</button>");
  });
  it("no raw error text can reach the screen: a failure is rendered from its CODE", () => {
    const evil = `<img src=x onerror=alert(1)> Bad credentials ghp_secret`;
    const html = panel({ result: run({ status: "partial", by: `m<b>`, repo: `acme/<i>w</i>`, failures: [{ code: evil }, { code: `reconcile:${evil}` }, { code: "list_prs", status: 500 }] }) });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("ghp_secret");
    expect(html).not.toContain("Bad credentials");
    expect(html).not.toContain("<i>w</i>");
    expect(html).not.toContain("m<b>");
    expect(text(html)).toContain("The sync stopped before it finished.");
    expect(text(html)).toContain("Could not read part of the repository from GitHub.");
  });
  it("the page's own request failing is a fixed sentence too", () => {
    expect(panel({ problem: "offline" })).toContain('role="alert"');
    expect(text(panel({ problem: "offline" }))).toContain("This page lost contact with Trov, so it stopped asking for the next pass. Whatever the sync had saved is kept.");
    expect(text(panel({ problem: "refused" }))).toContain("Trov did not accept the request. Try again in a few minutes.");
  });
});

describe("the Repo header's line", () => {
  it("names how the last sync ended — and nothing while one runs (the button beside it says so)", () => {
    expect(syncRepoLabel(ui(), NOW)).toBe("synced 12m ago by @andres");
    expect(syncRepoLabel(ui({ status: status({ last: null }) }), NOW)).toBe("");
    expect(syncRepoLabel(ui({ status: null }), NOW)).toBe("");
    expect(syncRepoLabel(ui({ status: status({ last: run({ status: "abandoned" }) }) }), NOW)).toBe("last sync did not finish");
    expect(syncRepoLabel(ui({ status: status({ last: run({ status: "failed" }) }) }), NOW)).toBe("last sync stopped 12m ago");
    expect(syncRepoLabel(ui({ mine: live() }), NOW)).toBe("");
    expect(syncRepoLabel(ui({ starting: true }), NOW)).toBe("");
  });
});
