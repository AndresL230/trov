# Repository layout (detailed)

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Layout

- `shared/` — the ONLY shared layer (imported via the `@shared` alias by `src/` and `web/`):
  `contract.ts` (Zod ingest contract), `vocabulary.ts` (controlled vocab), `rows.ts` (one type per D1 table),
  `dashboard.ts` (the My Work DTO shared by the Worker and web), `people.ts` (the person-profile contract —
  zod-free: the caps, `avatarSrc`, the profile / directory / agent DTOs), `repo.ts` (the Repo dashboard DTO — zod-free,
  since the SPA imports `REPO_TABS` as a value), `notifications.ts` (the digest DTOs), and the
  tickets pair-per-domain: `tickets.ts` / `sprints.ts` (zod rows, DTOs, payloads, `parseTicketLink`,
  `toSprintView`) over `tickets-core.ts` / `sprints-core.ts`. **The `*-core.ts` split is a rule**: anything
  the SPA imports as a VALUE (`canTransition` / `legalMoves` / `TICKET_STATUS_LABEL` / `isOpenStatus`,
  the status/urgency/domain tuples) lives in the zod-free core so the browser bundle never drags zod in;
  the zod module re-exports it, so the server still has one definition.
- `src/` — the Worker. `index.ts` (fetch entry: `/mcp` by bearer, `/webhook/github[/:hookId]` by HMAC
  (`github-hook.ts`), everything else to the Hono app; plus `scheduled()`, which dispatches the repo cron and
  the two digest crons by exact cron expression — each runs for EVERY active org, `docs/architecture/data-layer.md`
  › Background jobs), `routes.ts` (Hono HTTP), `mcp.ts` (MCP
  tools), `consumer.ts` (THE GATE), `webhook.ts` (GitHub event capture), `tools/` (`writes.ts`, `reads.ts`,
  `plan.ts`, `tickets.ts`, `sprints.ts`, `mywork.ts`, `repo.ts`, `repo-agent.ts`, `progress.ts`, `summarize.ts`), `notifications/` (email digests — see the
  Email notifications section), `db.ts` (D1 helpers), `auth/` (`persons.ts` — the identity root;
  `google.ts` — second provider; `onboard.ts` — the sign-in fork + onboarding cookie; `invites.ts`),
  `env.ts`. `repo/` is the repo-capture package behind `tools/repo.ts`: `types.ts` (the `RepoEvent` /
  `RepoEventRow` / `RepoMetric` shapes), `config.ts` (parses the `REPO_ENVIRONMENTS` var into
  `RepoEnvConfig[]`, `[]` on absent/malformed), `capture.ts` (PURE delivery→`RepoEvent[]` derivation,
  `repoEventsFromDelivery` — no DB, no clock, no network, and stores only a SLICE of each payload in `raw`),
  `store.ts` (the snapshot and metric seam: `putSnapshot` / `getSnapshot` over the five snapshot kinds —
  `prs_reconciled`, `env_heads`, `drift`, `branches`, `cf_polled`; `putMetric`, the ONE write seam that
  normalises `repo_metrics.at`, and `putMetrics`, the same write for MANY rows in `db.batch` chunks of 50;
  the metric reads `metricSeries` / `latestMetric` / `latestHealth` and the Usage tab's whole-tab reads
  `metricsSince` / `productReadings` / `metricsEver`; and `pruneRepoCapture`, the retention rules),
  `product.ts` (Sapling's product metrics: the `sap_c_*` / `sap_t_*` metric naming and the key → group /
  label / format registry — one place, server-side), `reads.ts` (every SELECT over `repo_events` — D1 only, nothing here may fetch — including
  `recordingSince`, the earliest `recorded_at` per kind that the week-over-week deltas gate on, and the ONE
  non-decisive-conclusion policy at `foldResult`/`checkState`), `github.ts` (service-token GitHub reads —
  `ghJson` / `ghGraphql`, `reconcileRepo` with its drift and branches arms, `refreshDrift`, `fillFailedJob` —
  never on the render path), `poll.ts` (the four scheduled pulls, none of which may throw: `pingHealth` every tick,
  and the three hourly usage pollers `pollCloudflare`, `pollRailway`, `pollSaplingMetrics`, each returning a
  `PollOutcome` per environment), and `cron.ts`
  (`handleRepoCron` — the repo trigger's one dispatcher, ONE heavy job per invocation, each job run for every
  org by ROTATION (`dispatch.ts`: units, budget, `cron_cursor`), the subrequest budget stated at the
  dispatcher — the job functions `runEnvJob` / `runOrgJob` / `runReconcileJob`; `runUsagePolls`, the org's
  usage job on demand; `runRepoRefresh` / `runLockedRepoRefresh`, the on-demand refresh of EVERY source
  behind `POST /admin/poll`, which the cron never calls). A job reads its repo and environments from the
  org's rows (`config.ts`: `orgPrimaryRepo`, `orgEnvironments`) and its credentials through
  `resolveCredential` — never from `GITHUB_REPO` / `REPO_ENVIRONMENTS` / a Worker secret directly. Retention, the cron schedule and every capture path are
  described once, in the Repo dashboard section below.
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`, then `0011_fts_recreate`,
  `0012_events_plan` [events / pr_summaries / milestone_progress / people / plan / plan_versions +
  `milestones.phase`], `0013_roadmap_fts`, `0014_drop_focus` [retires `0007_focus`],
  `0015_drop_user_token` [drops `users.github_token`], `0016_identity_tasks`, then
  `0017_issue_summaries` [assigned-issue summaries], `0018_structured_summaries` [structured summary
  columns], `0019_drop_pr_summary` [retires the legacy prose `pr_summaries.summary` — PR cards are
  structured-only], `0020_docs_space_vocab`, then `0021_notifications` [notification_policy /
  notification_settings / notification_prefs / notification_outbox + `users.email`,
  `users.email_unsubscribed`], `0022_notification_bodies` [dev-only rendered-message store], then
  `0023_persons` [persons / identities / invites replace users + people; sessions + mcp_tokens repoint
  to persons.handle; bodies table loses its outbox FK], then the tickets build: `0024_tickets`
  [tickets / ticket_assignees / ticket_links / ticket_comments / ticket_events + `tickets_fts`],
  `0025_sprints` [`milestones`→`sprints` in place (+ `dates`, `summary`, `urgency`, `lead`, `domain`),
  `milestone_progress`→`sprint_progress` (`milestone_id`→`sprint_id`), `plan_versions.milestones_json`
  →`sprints_json`, roadmap_fts re-keyed `milestone:<id>`→`sprint:<id>`, new `sprint_resources`, and
  `DROP TABLE milestone_proposals` — the whole agent-proposed-roadmap surface goes with it], then
  `0026_token_hint` [`mcp_tokens.token_hint` — the clear-text label `GET /auth/mcp-tokens` lists a token by], then
  `0027_repo_capture` [`repo_events` (append-only, UNIQUE `semantic_key`, kinds push/pr/review/deploy/check/run)
  / `repo_snapshots` / `repo_metrics` — the Repo dashboard's second capture path, deliberately separate from
  `events`], then `0028_handoffs_prompts` [`handoffs` / `prompts` / `prompt_versions` / `prompts_fts` — see
  "Handoffs & Prompt Library" below], then `0029_oauth` [`oauth_clients` / `oauth_grants` / `oauth_codes` /
  `oauth_tokens` — MCP OAuth, see Auth], then `0030_artifacts` [`artifact_pages` / `artifact_versions` /
  `artifact_links` / `artifact_upload_tokens` / `artifacts_fts` — see "Artifacts" below], then `0031_doc_images`
  [`doc_images` / `doc_image_upload_tokens` — see "Doc images" below], then `0032_ticket_source`
  [`tickets.source` / `source_ref` (partial UNIQUE) / `source_author` / `source_updated_at`,
  `ticket_links.locked`, and the `github-webhook` system person — see "Tickets mirrored from GitHub issues"], then
  `0033_ticket_testing_rank` [REBUILDS `tickets` + `ticket_events` (SQLite cannot alter a CHECK) to admit the
  `testing` status and add `tickets.board_rank`; under `defer_foreign_keys`, carrying each AUTOINCREMENT counter
  over so a deleted ticket's number is never reissued — see "The ticket board" below], then
  `0034_feed_brief_artifact_cap` [`feed.brief` — see "The feed brief" below — and REBUILDS `artifact_versions`
  to raise its text CHECK to 768000 bytes, the 750 KB `ARTIFACT_TEXT_CAP`], then `0035_library_and_sprint_dates`
  (ONE migration for the 2026-09-26 redesign batch — developed as 0035 + 0036, consolidated before production;
  four marked parts, each test cutting its own part out between the `-- ═══ PART` marker lines) — PART A [`docs.owner`, `artifact_pages.published_at`, `prompts.use_count` / `last_used_at` —
  each backfilled — and `prompts_fts_au` narrowed to the indexed columns so a use bump never rewrites the FTS
  row; the data behind My Work's library strip], PART B [`sprints.start_date` (nullable `YYYY-MM-DD`, the DTO's
  `start`), backfilled CONSERVATIVELY from `dates` — only a label that BEGINS with an ISO date or "<month> <day>"
  with no year, against an ISO `target_date` (the year before only for a range crossing New Year); anything else
  stays NULL and the Timeline still parses `dates`. Nothing else is rewritten — legacy non-ISO `target_date`s stay],
  PART C [prompt soft delete: `prompts.deleted_at` / `deleted_by` (a handle, in `HANDLE_COLUMNS`), and the four
  `prompts_fts` rebuild triggers re-created to index only `deleted_at IS NULL` rows — the update trigger now also
  fires on `deleted_at`, so a delete drops the FTS row and a restore puts it back — see the Prompt Library below],
  PART D [artifact soft delete: `artifact_pages.deleted_at` / `deleted_by` (a handle, in `HANDLE_COLUMNS`) — no
  trigger, `artifacts_fts` is kept by the repository — see Artifacts below]), then `0036_person_profiles`
  (two marked parts) — PART A [`persons.avatar_sha` (64 lowercase hex, CHECKed) / `role` / `responsibilities`, all
  nullable, never backfilled], PART B [`persons.avatar_source` (`github` / `google`, CHECKed), backfilled
  conservatively from the picture URL's host] — see "People profiles" below. Then `0041_trov_name` [the untouched default digest
  sender → `Trov <hello@trov.dev>`; it shipped on its own, first] and the MULTITENANCY schema, ONE migration
  (`canopy-multitenancy.md`; audit `canopy-multitenancy-audit.md`): `0042_organizations` — ten titled sections, written
  as ten files and consolidated before release (old → new map: spec §3): 1 orgs [the platform tables —
  `orgs`, `memberships` (role owner/admin/member + the per-org `title` / `responsibilities`), `org_invites` (a GitHub
  login OR an email), `org_repos`, `org_environments` (was `REPO_ENVIRONMENTS`), `org_keys` / `org_secrets` /
  `org_integration_config` / `org_audit` (integration secrets), `org_login_map` (per-org ATTRIBUTION,
  never sign-in), `org_counters`, `cron_cursor`; `persons.org_limit`, `identities.verified_email`; SaplingLearn seeded
  as `org_saplinglearn` from the data already in D1], 2 tenant columns [`org_id` ADDED to every tenant table whose
  keys do not change; per-org `tickets.number` / `handoffs.number`, allocated by AFTER INSERT triggers from
  `org_counters`], 3 tenant rebuilds [the 20 tables whose key must include `org_id` REBUILT — docs, doc_versions,
  entry_tags, processed_items, events / pr_summaries / issue_summaries (+ `repo`), plan, plan_versions, identity_tasks,
  the notification policy / settings / prefs, repo_events / repo_snapshots / repo_metrics, prompts, prompt_versions,
  artifact_pages, doc_images — ending in a GUARD that fails the WHOLE migration on any dangling reference], 4 tenant FTS
  [every FTS table re-created with `org_id UNINDEXED` as its LAST column (positional bm25 weights / snippet columns are
  unchanged) and every FTS trigger org-scoped], 5 platform admins [the SUPERADMIN role — one table, seeded with andres;
  no implicit access to any org's content; read by `/api/platform/*` — spec §5.4], 6 platform orgs [suspension, the
  owner invite, `org_usage_daily`, `org_admin_audit`], 7 identity uid [`identities.provider_uid`], 8 abuse limits
  [`abuse_counters`], 9 org invite mail, 10 org logo. **Every tenant `org_id` has a transitional `DEFAULT 'org_saplinglearn'`**
  (spec §3.2); since Phase 3 no statement relies on it — every statement binds `ctx.orgId`
  (`docs/architecture/data-layer.md`) — and the Phase 7 cleanup migration drops it. The file is all-or-nothing (one D1
  batch) and must stay under 100 KB. Rollback: `scripts/mt/rollback/0042_organizations.down.sql`, GENERATED by
  `scripts/mt/build-rollback.py` (CI fails if it is stale); production check: `scripts/mt/verify-migration.mjs`.
  Admin is the ORG role (`hasRole(ctx, "admin")`) everywhere — there is no handle allowlist. Per-person rate limits, the
  fixed mail sender and what is still open to abuse: `docs/architecture/abuse-limits.md`; the deploy runbook: `HANDOFF.md`.
  How an org is added, set up and run, role by role — and that a ticket's / handoff's `id` on every surface is its
  per-org NUMBER, never the row id: `docs/architecture/organizations.md`, `docs/architecture/data-layer.md`.
  Plans, per-org limits (402 `plan_limit`), grants, Free orgs (`src/plans/free.ts`) and the billing seam
  (`shared/plans.ts`, `src/plans/`, `0044_plans`): `docs/architecture/plans.md` — a new limit goes in `PLANS`
  and is enforced with `requirePlan`; a feature goes in `FEATURE_KEYS` and is gated with `requireFeature`.
  Pro per seat through Stripe (`src/billing/`, `0045_billing`, `0047_billing_seats` — the subscription's
  quantity): `docs/architecture/billing.md`.
  A plan given for free until a date (`src/plans/gifts.ts`, `0048_plan_gifts` — `orgs.plan_gift_until`,
  `org_grants.gift_days`; expired by the repo cron's every tick): `docs/architecture/plans.md` › Gifts.
  Bug reports and support messages (`0049_support_reports` — a GLOBAL table; `shared/support-core.ts`,
  `src/platform/support.ts` + `support-routes.ts`, the operator's mail in `src/notifications/support.ts`, the
  dialog in `web/src/support.ts` + `support-actions.ts`, Platform › Support in `web/src/platform-support*.ts`;
  `POST /api/support` for any signed-in person, the public `POST /api/support/public` for the site's Contact form, `/api/platform/support…` for a superadmin): `docs/architecture/support.md`.
  Sync GitHub as a recorded run (`0046_sync_runs`, `src/sync/runs.ts`, `GET /sync`, the panel's every sentence in
  `shared/sync.ts`): `docs/architecture/sync.md` — whether a sync can start is asked of the ONE GitHub credential
  source (`githubCredentialSource`, `src/github-app/credential.ts`), never of the token alone. The summarizer for an org is chosen ONLY by `orgSummarizers`
  (`src/plans/summaries.ts` — one platform key, each call metered per org, the monthly `ai_summaries` allowance).
- `web/` — full TypeScript/Vite single-page app (My Work, Feed, Docs, Roadmap, Triage, Search,
  Settings, Get Started, the four tickets screens — Tickets queue / ticket detail / new ticket / sprint —
  the five-tab Repo dashboard, plus the `#unsubscribe` confirmation screen) served via the ASSETS binding;
  `web/src/markdown.ts` renders PR summaries, the roadmap narrative and a sprint description as styled HTML;
  `web/src/notifications.ts` holds the Settings › Email notifications and Org settings › Notifications views;
  `web/src/tickets.ts` + `web/src/sprints.ts` are the (purely presentational) tickets/sprint components, and
  `web/src/hash.ts` is the hash-route seam (`parseHash` / `hashForRoute` — `#tickets/7`, `#sprints/3`,
  `#repo/<tab>`). `web/src/repo.ts` is the Repo dashboard (ported from the Claude Design `Trov Repo
  Dashboard.dc.html`), `web/src/repo-sample.ts` its design-placeholder set (a dynamic import, never in the main
  bundle), and `web/src/sidebar.ts` + `web/src/morph.ts` the sidebar — see "Sidebar & motion" below.
  Signed out, the app renders the **landing page** (`web/src/landing.ts`, ported from the Claude Design
  `Canopy Site.dc.html`); its nav's Sign in opens the GitHub/Google dialog, and its in-page links scroll
  rather than set the hash (the hash is the route and the sign-in return-to). Signed IN, the sidebar logo
  reopens the same page as the `site` screen (`#site`): its nav swaps Sign in for "Back to the app", which
  returns to the route the logo was clicked from; `#site` is never stashed as a sign-in return-to. `web/src/landing-motion.ts`
  plays its scroll reveals; played keys live in `state.landingSeen` so a rerender never replays them.
  Its last section is **Pricing** (`web/src/pricing.ts`, also the static `/pricing` page; prices in
  `shared/pricing.ts`, `null` = not announced) — `docs/architecture/plans.md` › The pricing page.
  `web/src/releases.ts` is Help › **What's new**: `#releases` a grid of release cards; each release has TWO pages,
  `#releases/<v>` (release notes — for USERS: no PRs, no migrations) and `#releases/<v>/patches` (patch notes — for
  builders: `ops` upgrade notes, Added / Changed / Fixed / Removed, PR links), flipped by a `segmented()` switch;
  `<v>` is `0.N` or `unreleased`; the old `#releases/patches` opens the newest release's patches. Static `RELEASES`
  data (`0.N` per milestone, newest first) plus a pure renderer. **Every shipped PR adds its lines to the top
  entry** (highlights / heads-up in product words, deploy steps in `ops`, patch lines ending `(#N)` to link the
  PR) — and since a merge to `main` deploys, the PR that merges also CUTS "Unreleased" into the next `0.N`, so
  main never shows a shipped batch as unreleased; the header comment says how.
- `.claude/skills/` — Claude Code skills: `trov`, `load-context`, `record-session`, `tickets`, and the
  roadmap/my-work skills `read-plan`, `update-plan`, `my-work`. Described in the Working memory section
  above. (Symlinks into `plugins/trov/skills/` — one source of truth.)
