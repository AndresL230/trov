# Sync GitHub

What the **Sync GitHub** button does, how it reports itself, and the record it leaves. Every sentence the
Sync panel shows is derived from this page (`shared/sync.ts` builds them).

Code: `src/tools/backfill.ts` (`runBackfill` — one batch), `src/repo/cron.ts` (`runReconcileJob` — the closing
refresh), `src/sync/runs.ts` (the run record, the lock, the two routes' answers), `src/plans/summaries.ts`
(which summarizer, and its metering), `shared/sync.ts` (the wire shapes and the words), `web/src/sync.ts`
(the panel and the header control) and `web/src/sync-actions.ts` (the batch loop and the polling). Migration: `0046_sync_runs.sql`. Tests: `test/sync.runs.test.ts`, `test/summaries.cap.test.ts`,
`test/render.sync.test.ts`.

## What a sync does

A sync is for ONE repository: the org's **primary** repository (`org_repos.is_primary`), read with the
org's GitHub credential. An **admin or owner** starts it. It is a **run** of one or more **batches**; the
browser drives it, POSTing `/admin/backfill` once per batch.

Every batch does all of this, in this order:

1. **Reads every closed pull request** of the repository from GitHub (`GET /repos/…/pulls?state=closed`,
   100 a page, every page — the whole history, not a recent window).
2. **Reads every open issue** (`GET /repos/…/issues?state=open`, 100 a page; pull requests in that list
   are skipped). If either read is refused, the batch stops here and **nothing is written**.
3. **For each open issue**: mirrors it to its ticket (created, updated, or unchanged — the same
   `mirrorIssue` the webhook uses), records it as an event for My Work if it is new or has changed, updates
   sprint progress from it, and — if it is assigned to someone — writes its AI summary.
4. **For each closed pull request**: records it as an event if it is new, and writes its AI summary.

Steps 3–4 are idempotent: an item already captured is `unchanged`, and an item that already has a real
summary is skipped. **Summaries are the only reason a run has more than one batch**: a batch attempts at
most 5 (`SYNC_SUMMARIES_PER_BATCH`, paced 0.5 s apart, each call bounded to 10 s), issues before pull
requests. While items are still waiting, the browser asks for another batch — and each batch repeats steps
1–4 from the top — up to 10 batches (`SYNC_MAX_BATCHES`). So **one click attempts at most 50 summaries**
(`SYNC_SUMMARIES_PER_RUN`); a larger backlog is finished by later syncs.

The batch that **ends** the run (nothing left to summarize, or the tenth) then runs the **closing
refresh** — `reconcileRepo`, the same job as the scheduled one: open and recently closed pull requests,
recent commits, deployments, workflow runs and failed job names, each environment's latest commit and its
check runs, commit statuses, reviews, branches and branch drift (19 + 2N GitHub requests for N
environments). Each part is independent: one that fails is named, and the others still land.

What a sync does **not** do: it never closes or resolves anything, never deletes, and does not poll usage,
hosting or health (that is **Poll now**, on the Repo screen).

When no summary can be attempted — the deployment has no `GEMINI_API_KEY`, the org's plan has ended, or
its month's allowance is used up (`plans.md` › AI summaries) — an item with no summary gets its **excerpt**
once and the run is a single batch. A later sync fills the excerpts in once summaries are allowed again.

How long it takes: a batch is two or more GitHub list requests plus up to 5 summary calls — a few seconds
for a small repository, up to about a minute if every summary call times out. A full ten-batch run on a
large backlog is a few minutes.

## The run record

Each run is one row of `sync_runs` (a tenant table): who started it, when, the repository, where it
stands (`batch`, `batches` expected, `phase`, `done` of `total`), its running `counts`, its `failures`, and
how it ended. It holds counts and failure **codes** only — no title, body or summary text, no token, and no
text an upstream wrote.

| `status` | Means |
|---|---|
| `running` | In progress. `updated_at` is its heartbeat: written at every phase change, and at most once a second inside a phase. |
| `ok` | Finished; nothing failed. |
| `partial` | Finished, but one or more parts of the closing refresh failed (`failures`: `reconcile:<part>`). |
| `failed` | Stopped: GitHub could not be read (`list_prs` / `list_issues`, with GitHub's status), or the batch threw (`unexpected`). Nothing from that batch was written. |
| `abandoned` | It never reported an end. Shown as "did not finish". |

**Phases** (`SyncPhase`), in order within a batch: `reading_prs` (total unknown until the last page — the
panel shows how many have been read, never a percentage), `reading_issues` (the same), `saving_issues`
(done of total), `saving_prs` (done of total), then on the last batch `reconcile` (no total) and `done`.

`batches` is null until the first batch has counted the backlog; after that it is the batch just made plus
one per 5 items still waiting, never more than 10.

**The lock.** The run row is the lock: starting a run is one guarded `INSERT` that writes only when the
org has no live run, so of two starts one wins and the other is answered **409 `sync_running`** with the
run in progress. A run is live while it is `running` and has reported within 3 minutes (`SYNC_STALE_MS` —
the Repo refresh lock's length, for the same reason: every fetch is bounded, so a healthy batch always
reports sooner). Past that it stops holding the lock and reads as `abandoned`; the next start marks it so.
Nothing is lost by an abandoned run: every write a sync makes is idempotent, and the next one picks up.

**Reloading mid-run.** The browser tab that started a run is what asks for its next batch, so closing or
reloading that tab ends the run after the batch in flight. The panel does not pretend otherwise: on reload
it reads `GET /sync`, shows the run as in progress while it is still reporting, and — three minutes after
its last report — as "did not finish", with Sync now available again. It does not resume a run.

**Retention.** Runs older than 90 days (`SYNC_RUN_RETENTION_DAYS`) are deleted by the daily cron
(`pruneSyncRuns`). The owner's to tune.

## Routes

| Route | Gate | Answers |
|---|---|---|
| `POST /api/o/:slug/admin/backfill` (alias `/admin/backfill`) | admin or owner | One batch. Body `{ batch, of, start?, run? }`: `start: true` begins a new run (409 `{ error: "sync_running", run }` if one is live); `run: <id>` continues it (it must be live and the caller's). A body with neither continues the caller's own live run or starts one. 200: the batch's counts as before (`captured`, `unchanged`, `summarized`, `summaryBudgetExhausted`, …, and `repo` on the batch that reconciled) plus `run: SyncRunView` and `summaries: SyncSummariesView`. 503 `{ error }` when there is no repository or credential (no run is recorded) or GitHub refused a list (`run` is the failed run). 502 if the batch threw. 403 for a member. |
| `GET /api/o/:slug/sync` (alias `/api/sync`) | any member | `SyncStatusView`: `repo`, `admin`, `blocked` (`no_repo` / `no_token` / `running` / null), `running`, `last`, `summaries` (status, used, cap, remaining, pending, per_run), `refreshed_at`. A non-member gets the tenant 404. |

While its own batch request is in flight, the panel polls `GET /sync` (every 1.5 s) to show the phase and
the items done; the same read is what anyone else in the org sees.

## Sync, Poll now, and the scheduled refresh

Three different things touch the same data:

- **Sync GitHub** (My Work, admins) — everything above. The only one that reads issues and writes summaries.
- **Poll now** (Repo, admins; `POST /admin/poll`) — health pings, the usage pollers, then the same closing
  refresh. It already answers with one line per source (`web/src/repo.ts` `pollStrip`), so it was left as it is.
- **The scheduled refresh** — the repo cron runs the closing refresh by itself every 6 hours (`:20`), for
  every org with a primary repository and a credential.

All three write the `prs_reconciled` snapshot when the refresh runs; its time is `refreshed_at` — "Deployments
and CI last refreshed …" in the panel. It does not say which of the three it was.

## Trying it locally

`LOCAL_UPSTREAM` (a `.dev.vars` value) points a local Worker's Sync at a stand-in for GitHub and Gemini on
the same machine (`src/sync/local-upstream.ts`): requests to `api.github.com` go to `<base>/github/…` and
to `generativelanguage.googleapis.com` to `<base>/gemini/…`. It is honoured only for `http://127.0.0.1` or
`http://localhost`, so a deployed Worker ignores it.
