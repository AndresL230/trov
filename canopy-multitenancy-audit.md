# Canopy multitenancy — Phase 0 audit

Status: **audit only, no code changed.** Baseline: `main` @ `c836b8b` (branch `claude/sharp-hawking-m0jgdp`).
Companion spec: `canopy-multitenancy.md` (Phase 1).

## 0. Method and scope

- **Schema** — every migration `0001`…`0036` applied in order to a scratch SQLite DB and the final `sqlite_master`
  dumped. That is the schema this audit classifies (49 base tables, 7 FTS5 virtual tables, 23 triggers in their final form).
- **Queries** — every SQL string in `src/**/*.ts` extracted mechanically (a string literal containing a
  `SELECT … FROM` / `INSERT INTO` / `UPDATE … SET` / `DELETE FROM`, comment lines excluded), tagged with
  file:line, operation and the tables it names: **370 statements in 41 files**. The full list is Appendix A.
  Four statements interpolate a table name and were classified by hand (noted there).
- **D1 access sites** — every tool takes `db: DB` (= `D1Database`, `src/db.ts:1`) and goes through
  `first` / `all` / `run` (`src/db.ts:7-20`) or calls `db.prepare(…)` / `db.batch(…)` directly. Direct
  `.prepare(` appears in 12 files (`src/tools/artifacts.ts` 16, `tickets.ts` 10, `quick-search.ts` 9,
  `ticket-mirror.ts` 6, `auth/oauth.ts` 6, `prompts.ts` 5, `auth/persons.ts` 5, `sprints.ts` 4, `db.ts` 3,
  `people.ts` 2, `doc-images.ts` 1, `repo/store.ts` 1). `c.env.DB` / `env.DB` is handed to a tool from
  ~240 call sites in `src/routes.ts`, `src/mcp.ts`, `src/webhook.ts`, `src/index.ts`, the cron modules and
  the sub-apps. **No query anywhere carries a tenant predicate** — there is no tenant concept in the code.
- **Scripts** (`scripts/*.mjs`, `scripts/seed/*`) run SQL through `wrangler d1 execute` / Miniflare, outside
  the Worker; they are listed in §9 where they hardcode the org.

---

## 1. Table inventory

Class key — **T** tenant-owned (gets `org_id`), **U** per-user global (identity of a human, not of an org),
**UO** per-user-per-org, **G** global platform/vocabulary. "Unique to fix" = a uniqueness rule that today is
global and must include `org_id` (detail in §2).

| Table | Defined at (latest shape) | Class | Notes |
|---|---|---|---|
| `sections` | `0001_init.sql:1`, seeded `0002`, `0005`, `0020` | G | Controlled vocab; must match `shared/vocabulary.ts`. Stays global (per-org vocab out of scope). |
| `tags` | `0001_init.sql:2`, seeded `0002` | G | As above. |
| `docs` | `0001:4` (+`space` `0005`, `owner` `0035`) | T | PK `slug` — unique to fix. `space` defaults to `'canopy'`. |
| `doc_versions` | `0001:14` (+reconcile cols `0009`) | T | FK `slug → docs(slug)`; index `(slug, content_hash)` drives dedupe. |
| `feed` | `0001:26` (+`brief` `0034`) | T | Global AUTOINCREMENT id. |
| `adrs` | `0001:35` (+`content_hash` `0009`) | T | Index `(content_hash)` drives dedupe. |
| `entry_tags` | `0001:45` | T | PK `(tag, entry_type, entry_id)`; entry ids are global feed ids. |
| `needs_triage` | `0001:52` (+audit cols `0010`) | T | |
| `processed_items` | `0009_reconcile.sql:14` | T | Replay ledger, PK `(session_id, item_index)` — unique to fix (locked decision 8). |
| `events` | `0012_events_plan.sql:8` | T | `semantic_key UNIQUE` (`gh:pr:42:merged`) — unique to fix; key has **no repo** in it. |
| `pr_summaries` | `0012:25` (+structured `0018`, −prose `0019`) | T | PK `semantic_key REFERENCES events(semantic_key)`. |
| `sprint_progress` | `0012:35` → renamed `0025_sprints.sql:53` | T | PK `sprint_id` (global id). |
| `plan` | `0012:57` | T | **Singleton** `CHECK (id = 1)` — must become one row per org. |
| `plan_versions` | `0012:66` (col renamed `0025:60`) | T | PK `version` — unique to fix. |
| `sprints` | `0004_roadmap.sql:3` → renamed `0025:47` (+`start_date` `0035`) | T | `domain` CHECK hardcodes Canopy's own domains (§9). |
| `identity_tasks` | `0016_identity_tasks.sql:7` | T | PK `login` — unique to fix. |
| `issue_summaries` | `0017_issue_summaries.sql:7` (+`0018`) | T | PK `issue_number` — unique to fix; no repo. |
| `notification_policy` | `0021_notifications.sql:8` | T | PK `kind` — unique to fix (per-org admin policy, decision 11). |
| `notification_settings` | `0021:17` | T | **Singleton** `CHECK (id = 1)`; `from_address`, `send_hour`, `timezone`. |
| `notification_prefs` | `0021:30` | UO | PK `(user_id, kind)` — unique to fix. |
| `notification_outbox` | `0021:40` | UO | PK `idempotency_key` = `user:cadence:window_id` — key must carry org. |
| `notification_outbox_bodies` | `0023_persons.sql:91` | UO | Dev-only rendered bodies, same key. |
| `persons` | `0023:7` (+`0036` avatar/role/responsibilities) | U | PK `handle COLLATE NOCASE` — the user id. `role` / `responsibilities` are org-specific facts living on a global row (§10, C-8). |
| `identities` | `0023:18` | U | PK `(provider, subject)` — the sign-in identity. Also (ab)used as the PR-author attribution map (§10, C-1). |
| `invites` | `0023:29` | G today → replaced | PK `email`; admin invites for Google sign-in. Superseded by `org_invites` (§10, C-3). |
| `sessions` | `0023:66` | U | Cookie session → person. Stays user-level. |
| `mcp_tokens` | `0023:77` (+`token_hint` `0026`) | U today → **UO** | Must carry `org_id` (decision 5). `token_hash UNIQUE` is fine globally. |
| `tickets` | `0033_ticket_testing_rank.sql:31` | T | Partial `UNIQUE(source_ref)` — unique to fix. Global AUTOINCREMENT id is the user-visible `#12`. |
| `ticket_assignees` | `0024_tickets.sql:74` | T | PK `(ticket_id, login)`. `login` is a handle. |
| `ticket_links` | `0024:84` (+`locked` `0032`) | T | |
| `ticket_comments` | `0024:97` | T | |
| `ticket_events` | `0033:68` | T | |
| `sprint_resources` | `0025:112` | T | |
| `repo_events` | `0027_repo_capture.sql:12` | T | `semantic_key UNIQUE` — unique to fix; no repo column. |
| `repo_snapshots` | `0027:39` | T | PK `kind` (one row per kind for THE repo) — unique to fix. Holds `refresh_lock`. |
| `repo_metrics` | `0027:47` | T | `UNIQUE(metric, env, part, at)` — unique to fix. |
| `handoffs` | `0028_handoffs_prompts.sql:23` | T | `recipient` may be the literal `'anyone'` (= anyone in the org). |
| `prompts` | `0028:43` (+usage/soft-delete `0035`) | T | PK `slug` — unique to fix. |
| `prompt_versions` | `0028:54` | T | PK `(slug, version)` — unique to fix. |
| `oauth_clients` | `0029_oauth.sql:6` | G | RFC 7591 dynamic registrations; not org-specific. |
| `oauth_grants` | `0029:13` | U today → **UO** | A grant is what a bearer resolves through — must pin the org (decision 5). |
| `oauth_codes` | `0029:25` | U today → **UO** | Carries `grant_id`; org follows the grant. |
| `oauth_tokens` | `0029:38` | U today → **UO** | Resolved via `grant_id`. |
| `artifact_pages` | `0030_artifacts.sql:34` (+`0035`) | T | `slug UNIQUE` — unique to fix. `visibility='org'` means "everyone" today. `repo` free text. |
| `artifact_versions` | `0034_feed_brief_artifact_cap.sql:24` | T | `UNIQUE(page_id, version_no)` (global page id — fine). |
| `artifact_links` | `0030:78` | T | `target_ref` is a ticket/sprint id or PR/issue number — must be same-org. |
| `artifact_upload_tokens` | `0030:91` | T | Bound to principal + page. |
| `doc_images` | `0031_doc_images.sql:8` | T | PK `sha256` (content-addressed) — unique to fix (§10, C-10). |
| `doc_image_upload_tokens` | `0031:21` | T | Bound to principal + sha. |

Removed historically and not to be resurrected: `users`, `people` (`0023:103-104`), `focus` (`0014`),
`milestone_proposals` (`0025:126`).

**Totals (49):** 35 tenant-owned (T) + 7 per-user-per-org (UO: the three `notification_*` user tables, `mcp_tokens`,
`oauth_grants`, `oauth_codes`, `oauth_tokens` — the last four are user-level today and become org-pinned) + 3 per-user
(U: `persons`, `identities`, `sessions`) + 3 global (G: `sections`, `tags`, `oauth_clients`) + `invites` (retired). Plus the 7 FTS tables (§3), all T.

## 2. Unique indexes / constraints that must include `org_id`

| Constraint | Where | Today | Required |
|---|---|---|---|
| `docs.slug` PK | `0001:4` | global | `(org_id, slug)`; `doc_versions` FK becomes `(org_id, slug)` |
| `idx_doc_versions_hash (slug, content_hash)` | `0009:34` | non-unique, but the content-hash dedupe lookup key | `(org_id, slug, content_hash)` |
| `idx_doc_versions_slug` | `0001:61` | | `(org_id, slug)` |
| `idx_adrs_hash (content_hash)` | `0009:35` | ADR dedupe lookup | `(org_id, content_hash)` |
| `entry_tags` PK | `0001:45` | | `(org_id, tag, entry_type, entry_id)` |
| `processed_items` PK | `0009:14` | `(session_id, item_index)` | `(org_id, session_id, item_index)` (decision 8) |
| `events.semantic_key` UNIQUE | `0012:8` | `gh:pr:42:merged` | `(org_id, repo, semantic_key)` — a key has no repo, so two repos (or two orgs) with PR #42 collide |
| `pr_summaries` PK + FK | `0012:25` | `semantic_key` | `(org_id, repo, semantic_key)` |
| `issue_summaries` PK | `0017:7` | `issue_number` | `(org_id, repo, issue_number)` |
| `plan` singleton | `0012:57` | `CHECK (id = 1)` | PK `org_id` |
| `plan_versions` PK | `0012:66` | `version` | `(org_id, version)` |
| `identity_tasks` PK | `0016:7` | `login` | `(org_id, login)` |
| `notification_policy` PK | `0021:8` | `kind` | `(org_id, kind)` |
| `notification_settings` singleton | `0021:17` | `CHECK (id = 1)` | PK `org_id` |
| `notification_prefs` PK | `0021:30` | `(user_id, kind)` | `(org_id, user_id, kind)` |
| `notification_outbox` PK | `0021:40` | `user:cadence:window` | key `org:user:cadence:window` + `org_id` column |
| `idx_tickets_source_ref` partial UNIQUE | `0033:64` | `source_ref` | `(org_id, source_ref)` |
| `repo_events.semantic_key` UNIQUE | `0027:12` | | `(org_id, repo, semantic_key)` |
| `repo_snapshots` PK | `0027:39` | `kind` | `(org_id, kind)` (incl. the `refresh_lock` row) |
| `repo_metrics` UNIQUE | `0027:47` | `(metric, env, part, at)` | `(org_id, metric, env, part, at)`; `idx_repo_metrics_series` likewise |
| `prompts` PK | `0028:43` | `slug` | `(org_id, slug)` |
| `prompt_versions` PK | `0028:54` | `(slug, version)` | `(org_id, slug, version)` |
| `artifact_pages.slug` UNIQUE | `0030:34` | | `(org_id, slug)` — also removes the documented cross-page slug-existence leak (`src/tools/artifacts.ts:110` `uniqueSlug` counts every row) |
| `doc_images` PK | `0031:8` | `sha256` | `(org_id, sha256)` |
| `invites` PK | `0023:29` | `email` | replaced by `org_invites (org_id, github_login)` |

Constraints that are fine as-is because they key on a globally unique surrogate id: `artifact_versions
UNIQUE(page_id, version_no)`, `artifact_links UNIQUE(page_id, …)`, `ticket_assignees PK(ticket_id, login)`,
`sprint_progress PK(sprint_id)`, `mcp_tokens.token_hash`, `oauth_*` hashes, `identities PK(provider, subject)`,
`persons PK(handle)`. They still get an `org_id` column (decision 1) so every read can filter without a join.

Every other (non-unique) index whose leading column is a tenant filter target should lead with `org_id`:
`idx_feed_created_at`, `idx_docs_space`, `idx_events_subject`, `idx_events_ref`, `idx_tickets_status_updated`,
`idx_tickets_status_rank`, `idx_tickets_sprint`, `idx_sprints_target_date`, `idx_repo_events_*` (5),
`idx_handoffs_recipient`, `idx_handoffs_sender`, `idx_artifact_pages_updated`, `idx_artifact_pages_author`,
`idx_notification_outbox_created`.

## 3. FTS5 tables and their triggers

| FTS table | Created | Key column | Kept in sync by | Readers (MATCH sites) |
|---|---|---|---|---|
| `docs_fts` | `0011_fts_recreate.sql:36` | `slug` UNINDEXED | triggers `docs_fts_ai/au/ad` `0011:46/56/52` | `src/tools/reads.ts:541`, `src/tools/quick-search.ts:128` |
| `feed_fts` | `0011:39` | `feed_id` UNINDEXED | `feed_fts_ai/ad` `0011:63/68` | `reads.ts:568`, `quick-search.ts:211` |
| `adrs_fts` | `0011:42` | `adr_id` UNINDEXED | `adrs_fts_ai/ad` `0011:73/78` | `reads.ts:587`, `quick-search.ts:137` |
| `roadmap_fts` | `0013_roadmap_fts.sql:25` | `ref` UNINDEXED (`'plan'` / `'sprint:<id>'`) | `roadmap_fts_plan_au` `0013:50`, `roadmap_fts_sprint_ai/au/ad` `0025:76/84/92` | `reads.ts:608`, `quick-search.ts:146` |
| `tickets_fts` | `0024_tickets.sql:124` | `ticket_id` UNINDEXED | `tickets_fts_ai/au/ad` `0033:85/91/97` | `quick-search.ts:121` (not a `query()` type — `reads.ts:375`) |
| `prompts_fts` | `0028_handoffs_prompts.sql:69` | `slug` (**indexed**, not UNINDEXED) | `prompts_fts_ai/au/vai/vau` `0035:202/211/221/230`, `prompts_fts_ad` `0028:89` | `src/tools/prompts.ts` (`listPrompts` search), `quick-search.ts:162` |
| `artifacts_fts` | `0030_artifacts.sql:110` | `page_id` UNINDEXED | the repository (`src/tools/artifacts.ts:578/622/802/862/888`) + `artifacts_fts_ad` `0030:113` | `artifacts.ts:390` (list filter), `artifacts.ts:549` (`searchArtifactsStmt`) |

Findings:

- **F-1 Triggers that key on a non-unique-per-org value will clobber other orgs.** `docs_fts_ai/au`
  (`DELETE FROM docs_fts WHERE slug = new.slug`), `prompts_fts_*` (`WHERE slug = …`), and
  `roadmap_fts_plan_au` (`DELETE FROM roadmap_fts WHERE ref = 'plan'`) delete by a key that becomes
  per-org. Once two orgs share a slug — or simply both have a plan — one org's write deletes the other's
  search row. All 23 triggers must be re-created with `AND org_id = new.org_id` and insert `new.org_id`.
- **F-2 `LIMIT` is applied inside the per-type FTS statement** (`reads.ts:544`, `:570`, `:589`, `:610`;
  `quick-search.ts` every arm). The org filter must be in that same `WHERE`, never a post-hydration filter,
  or another org's better-ranked rows crowd a tenant's own results out (a correctness bug even where
  hydration would hide the foreign row).
- **F-3 Ranking side channel (residual, low).** FTS5 bm25 statistics (document count, term frequencies) are
  table-wide, and `query()` returns a normalised `score` (`shared/contract.ts:102`). With an UNINDEXED
  `org_id` (locked decision 9) another org's corpus still moves a tenant's scores slightly. No content leaks;
  accepted and documented in the spec rather than relitigating decision 9.
- **F-4** `prompts_fts.slug` is an indexed column today (searchable). It stays as-is; `org_id` is added
  UNINDEXED.

## 4. HTTP routes

All session-cookie routes sit behind `sessionGate` (`src/routes.ts:63`; `src/auth/principal.ts:76`), whose
principal is only `{ handle }` (`principal.ts:7`). **None resolves an org or checks a membership.** Admin
gating is `isAdmin(env, handle)` against the `ADMIN_LOGINS` var (`principal.ts:18-21`).

Scope legend — **T** must move under `/api/o/:slug/` with a membership check; **TA** same, plus org role
`admin`/`owner`; **U** user-level, stays global; **P** public / pre-auth.

### 4.1 Main app (`src/routes.ts`)

| Line | Method + path | Scope | Notes |
|---|---|---|---|
| 59 | `use /raw/*` (headers) | — | |
| 63 | `use *` sessionGate | — | |
| 67 | `route /api/artifacts` | T | sub-app §4.3 |
| 68 | `route /raw/a` | T | moves to the artifact origin (decision 12, C-12) |
| 73 | GET `/img/:sha` | T | today any session reads any org's image by sha |
| 92 | GET `/avatar/:sha` | U | avatars are per-person |
| 107 | `route /auth` | U/P | §4.2 |
| 111 | `route /` oauthApp | P | §4.4 |
| 116 | `route /api/notifications` | T/TA | §4.5 |
| 118 | POST `/ingest` | T | the gate |
| 130 | GET `/docs` | T | |
| 137 | GET `/doc/:slug` | T | |
| 143 | GET `/feed` | T | |
| 159 | GET `/feed/stats` | T | "the WHOLE team" |
| 176 | GET `/search` | T | FTS |
| 199 | GET `/search/quick` | T | FTS + `persons` LIKE (`quick-search.ts:201`) — person hits must be org members |
| 221 | GET `/needs-triage` | T | |
| 223 | GET `/adrs` | T | |
| 232 | GET `/proposals` | T | |
| 246 | GET `/api/handoffs` | T | |
| 251 | GET `/api/handoffs/:id` | T | |
| 256 | POST `/api/handoffs` | T | |
| 270 | POST `/api/handoffs/:id/claim` | T | |
| 278 | POST `/api/handoffs/:id/expire` | T | |
| 285 | GET `/api/prompts` | T | |
| 291 | GET `/api/prompts/:slug` | T | |
| 295 | GET `/api/prompts/:slug/versions` | T | |
| 300 | POST `/api/prompts` | T | |
| 306 | POST `/api/prompts/:slug/tags` | T | |
| 315 | POST `/api/prompts/:slug/used` | T | |
| 326 | POST `/api/prompts/:slug/publish` | T | confirm-class (human publish) |
| 337 | POST `/api/prompts/:slug/delete` | T | author or `isAdmin` |
| 342 | POST `/api/prompts/:slug/restore` | T | author or `isAdmin` |
| 359 | POST `/api/docs/propose` | T | |
| 379 | POST `/doc/:slug/promote` | T | **confirm verb — cookie only** |
| 393 | POST `/doc/:slug/reject` | T | **confirm verb** |
| 406 | POST `/adr/:id/ratify` | T | **confirm verb** |
| 419 | POST `/adr/:id/reject` | T | **confirm verb** |
| 432 | POST `/needs-triage/:id/discard` | T | |
| 446 | POST `/needs-triage/:id/assign` | T | re-runs the gate |
| 471 | GET `/identity-tasks` | T | |
| 478 | POST `/identity-tasks/:login/map` | TA (today: any member) | **grants global sign-in** (C-1) |
| 498 | POST `/identity-tasks/:login/discard` | T | |
| 506 | POST `/identity-tasks/:login/restore` | T | |
| 516 | GET `/persons` | T | today lists every person on the platform |
| 530 | GET `/api/people/:handle` | T | must 404 a non-member |
| 534 | PUT `/api/people/:handle` | TA | role/responsibilities (C-8) |
| 541 | POST `/api/people/me/avatar` | U | |
| 555 | POST `/api/people/me/avatar/remove` | U | |
| 564–565 | `use /invites`, `/invites/*` adminGate | TA | |
| 566 | GET `/invites` | TA | → org invites |
| 567 | POST `/invites` | TA | email invite (C-3) |
| 582 | POST `/invites/:email/revoke` | TA | |
| 586 | POST `/invites/:email/resend` | TA | |
| 598 | GET `/roadmap` | T | |
| 604 | GET `/me/dashboard` | T | My Work |
| 620 | GET `/repo/dashboard` | T | reads `GITHUB_REPO` + `REPO_ENVIRONMENTS` env (C-5) |
| 633 | POST `/admin/backfill` | TA | env service token |
| 672 | POST `/admin/poll` | TA | env tokens |
| 698 | POST `/admin/poll-usage` | TA | env tokens |
| 733 | POST `/tickets` | T | |
| 748 | GET `/tickets` | T | |
| 775 | GET `/tickets/badge` | T | |
| 777 | GET `/tickets/:id` | T | global id |
| 787 | POST `/tickets/:id/edit` | T | |
| 802 | POST `/tickets/:id/status` | T | |
| 818 | POST `/tickets/:id/move` | T | |
| 832 | POST `/tickets/:id/assignees` | T | assignee must be a member |
| 845 | POST `/tickets/:id/links` | T | |
| 860 | POST `/tickets/:id/links/:linkId/remove` | T | |
| 874 | POST `/tickets/:id/delete` | T | |
| 885 | POST `/tickets/:id/sprint` | T | sprint must be same-org |
| 900 | POST `/tickets/:id/parent` | T | parent must be same-org |
| 913 | POST `/tickets/:id/comment` | T | |
| 948 | POST `/sprints` | T | |
| 965 | GET `/sprints` | T | |
| 967 | GET `/sprints/:id` | T | |
| 977 | POST `/sprints/:id/active` | T | |
| 993 | POST `/sprints/:id/resources` | T | |
| 1008 | POST `/sprints/:id/delete` | T | |
| 1020 | POST `/sprints/:id/complete` | T | |

### 4.2 Auth sub-app (`src/auth/routes.ts`, mounted `/auth`)

| Line | Route | Scope | Notes |
|---|---|---|---|
| 90 | GET `/auth/login` | P | GitHub PKCE |
| 95 | GET `/auth/callback` | P | **`isActiveOrgMember` gate at `:102`** (C-2) |
| 108 | GET `/auth/google/login` | P | |
| 117 | GET `/auth/google/callback` | P | gated on `invites` (C-3) |
| 135 | GET `/auth/onboard` | P (onboard cookie) | |
| 140 | GET `/auth/handle-check` | P (onboard cookie) | |
| 148 | POST `/auth/onboard` | P (onboard cookie) | creates the person; sends welcome mail |
| 202 | GET `/auth/me` | U | returns `org: SAPLING_ORG` (`:207`) and `admin` from the env allowlist |
| 210 | PUT `/auth/me` | U | name/color |
| 218 | POST `/auth/me/handle` | U | rename — admin rule ties to `ADMIN_LOGINS` (`:226`) |
| 237 | POST `/auth/identities/:provider/unlink` | U | |
| 245 | POST `/auth/logout` | U | |
| 251 | POST `/auth/mcp-token` | U → UO | mint — must be org-bound |
| 255 | GET `/auth/mcp-tokens` | U → UO | |
| 256 | POST `/auth/mcp-tokens/:id/revoke` | U → UO | |
| 263 | GET `/auth/oauth-grants` | U → UO | |
| 264 | POST `/auth/oauth-grants/:id/revoke` | U → UO | |

### 4.3 Artifacts sub-app (`src/artifacts/routes.ts`, mounted `/api/artifacts`) — all T

`:155` GET `/`, `:162` POST `/`, `:190` POST `/fetch`, `:202` POST `/upload-url`, `:224` GET `/:slug`,
`:225` GET `/:slug/:ver`, `:227` PATCH `/:slug`, `:234` POST `/:slug/versions`, `:260` GET `/:slug/diff`,
`:268` POST `/:slug/links`, `:273` POST `/:slug/links/remove`, `:280` POST `/:slug/ratify` (**confirm
verb**, refuses an `Authorization` header), `:295` POST `/:slug/delete`, `:301` POST `/:slug/restore`
(both use `isAdmin` env allowlist). Raw sub-app `src/artifacts/raw.ts:123-124` GET `/raw/a/:ref`,
`/raw/a/:slug/:ver`.

### 4.4 OAuth (`src/auth/oauth-routes.ts`, mounted `/`) — P

`:90-91` `/.well-known/oauth-protected-resource[/mcp]`, `:92` `/.well-known/oauth-authorization-server`,
`:99` POST `/oauth/register`, `:142` POST `/oauth/token`, `:164` POST `/oauth/revoke`, `:200` GET
`/oauth/authorize` (consent page), `:222` POST `/oauth/authorize`. `issueAuthorization`
(`src/auth/oauth.ts:195-206`) inserts the grant and code with `person` only — **no org**.

### 4.5 Notifications (`src/notifications/routes.ts`, mounted `/api/notifications`)

`:55` GET `/prefs`, `:57` PUT `/prefs` (UO); admin-only via `isAdmin` (`:97-102`): `:123` GET `/policy`,
`:125` PUT `/policy`, `:162` GET `/settings`, `:164` PUT `/settings`, `:180` GET `/outbox`, `:188` PUT
`/persons/:handle`, `:215` GET `/preview`, `:243` POST `/test-send` (all TA).

### 4.6 Entry points outside the Hono app (`src/index.ts`)

| Line | Path | Auth | Scope |
|---|---|---|---|
| 22-31 | `/mcp` | bearer (`resolveBearerPrincipal`, `principal.ts:52`) | resolves `{ handle }` only — no org (C-4) |
| 34-36 | POST `/webhook/github` | HMAC vs one global `GITHUB_WEBHOOK_SECRET` (`src/webhook.ts:335`) | no org routing (C-6) |
| 42-48 | `/u/<login.sig>` | HMAC token | user-level (global unsubscribe) |
| 52 | PUT `/api/artifacts/upload/:token` | single-use token | T (token row must carry org) |
| 57 | GET `/api/artifacts/download/:token` | stateless HMAC | T (payload must carry org) |
| 61-69 | `scheduled()` | cron | §6 |

## 5. MCP tools (`src/mcp.ts`) — 42 tools, one server per request

`buildCanopyMcpServer(env, principal)` (`src/mcp.ts:84`) closes over `env.DB` and `principal.handle`; every
tool body passes `env.DB` straight to a tool. **No tool is org-aware.** All are T once the bearer pins the org.

| Line | Tool | Kind | Line | Tool | Kind |
|---|---|---|---|---|---|
| 91 | `query` | read (FTS) | 337 | `list_people` | read — every person on the platform |
| 108 | `get_doc` | read | 344 | `get_events` | read |
| 112 | `list_docs` | read | 359 | `get_repo_dashboard` | read — env `GITHUB_REPO` (`:368`) |
| 117 | `get_feed` | read | 375 | `record_session` | stage (gate) |
| 124 | `append_feed` | stage (gate) | 413 | `upload_asset` | write |
| 149 | `propose_doc_update` | stage (gate) | 434 | `artifact_update` | write |
| 166 | `get_roadmap` | read | 448 | `artifact_get` | read (+download URL) |
| 178 | `list_tickets` | read | 455 | `artifact_list` | read |
| 191 | `get_ticket` | read | 482 | `create_sprint` | write |
| 203 | `list_sprints` | read | 489 | `set_sprint_active` | write |
| 210 | `get_sprint` | read | 496 | `complete_sprint` | write |
| 248 | `create_ticket` | write | 503 | `delete_sprint` | write |
| 255 | `edit_ticket` | write (lane) | 510 | `add_sprint_resource` | write |
| 265 | `transition_ticket` | write (lane) | 533 | `send_handoff` | write (ledger) |
| 275 | `add_ticket_comment` | write (lane) | 554 | `list_handoffs` | read |
| 285 | `add_ticket_link` | write (lane) | 569 | `get_handoff` | read |
| 295 | `set_ticket_sprint` | write (lane; admin exception) | 580 | `claim_handoff` | write |
| 305 | `set_ticket_parent` | write (lane ×2) | 599 | `expire_handoff` | write |
| 315 | `assign_ticket` | write (own rule) | 607 | `search_prompts` | read (FTS) |
| 325 | `get_my_work` | read | 614 | `get_prompt` | read (+use bump) |
|  |  |  | 629 | `save_prompt` | stage |
|  |  |  | 643 | `update_plan` | admin write, registered only when `isAdmin(env, handle)` (`:641`) |

Confirm verbs are **not** MCP tools today and must stay that way (decision 6): there is no promote, ratify,
reject, publish-prompt, artifact-ratify, delete-prompt or delete-artifact tool. Verified by the list above.
Admin checks inside tools use the env allowlist: `src/tools/tickets-agent.ts:91` (`set_ticket_sprint`),
`:122` (`assign_ticket`).

## 6. Cron jobs (`src/index.ts:61-69`, `wrangler.toml` `[triggers]`)

| Trigger | Handler | Job | Org assumption |
|---|---|---|---|
| `*/10 * * * *` | `handleRepoCron` `src/repo/cron.ts:306` | `pingHealth` every tick (`:321`) | env `REPO_ENVIRONMENTS` (`:307`) |
| | | `expireDueHandoffs` every tick (`:325`) | global UPDATE over all handoffs (D1 only — iterating orgs is free) |
| | | `:00` `runUsagePolls` (`:327-333`) → `pollCloudflare` / `pollRailway` / `pollSaplingMetrics` | env tokens `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`, `SAPLING_METRICS_TOKEN` (`:89`, `:102`, `:28`) |
| | | h%6 `:10` `recomputeAllProgress` (`:343`) | env `GITHUB_SERVICE_TOKEN` + `GITHUB_REPO` (`:338-339`) |
| | | h%6 `:20` `reconcileRepo` (`:348-350`) | same |
| | | h%6 `:30` `pruneRepoCapture` + `pruneOAuth` (`:355-359`) | global deletes (fine to stay global — retention, not tenancy) |
| `0 * * * *` | `handleNotificationCron` `src/notifications/cron.ts:38` | daily digest + `retryFailed` | **one** `notification_settings` row (`:30-31`) |
| `0 * * * SUN,MON` | same | weekly digest | same |
| every isolate | `ensureNotificationPolicySeeded` `src/index.ts:19,62` | seeds `notification_policy` | one global policy set |

The repo cron's budget is computed for ONE org: 50 subrequests per invocation on the free plan, 10 used at
`:00` and 27 at `:20` for two environments (`CLAUDE.md` "The repo cron"). See C-7.

## 7. Webhook handler (`src/webhook.ts`)

- `handleGithubWebhook` `:317`: verifies against the single env secret (`:335`), then — for
  `WORK_EVENT_NAMES` (`:302`) — `ingestEvent(env.DB, ev, "github-webhook")` (`:359`), `progressSeam`
  (`:370`), `mirrorIssue(env.DB, env.GITHUB_REPO, payload)` (`:386`); for `REPO_EVENT_NAMES` (`:307`) —
  `repoEnvironments(env)` (`:399`), `ingestRepoEvent` (`:419`), `fillFailedJob` / `refreshDrift` with env
  `GITHUB_SERVICE_TOKEN` + `GITHUB_REPO` (`:422-428`).
- **`ingestEvent` / `ingestRepoEvent` accept a delivery from ANY repository** that can sign with the secret;
  only the ticket mirror checks `repository.full_name` against `GITHUB_REPO` (`src/tools/ticket-mirror.ts:96`,
  `:140-151`). Routing to an org therefore has no existing seam to extend; `repository.full_name` is the key.
- `ingestEvent` raises `identity_tasks` for unmapped logins (`src/consumer.ts:252`), resolved through the
  global `identities` table (`src/tools/mywork.ts:34` `resolvePersonForLogin`).

## 8. Email (`src/notifications/`)

- `runDigest` (`run.ts:126`) selects **every person** with an email on the platform; renderers are pure reads
  over the whole store. With orgs, a person in two orgs would get one digest that mixes both.
- `retryFailed` (`retry.ts:25`) re-sends every failed row.
- `loadSettings` (`cron.ts:30`) reads `notification_settings WHERE id = 1`; default `from_address` is
  `Canopy <canopy@canopy.saplinglearn.com>` (`cron.ts:19`).
- `resolve.ts:14-37` reads the one global policy table + per-user prefs.
- Unsubscribe (`unsubscribe.ts`, `index.ts:42-48`) flips `persons.email_unsubscribed` — global, per user.
- Invite mail (`invite.ts:19-20`) links `${origin}/` only — **no token in the URL** (consistent with decision 4).
  Copy: "You're invited to the Sapling team's shared workspace." (`invite.ts:28`).
- Welcome mail (`welcome.ts`) links `/#guide`.

## 9. Hardcoded org / repo references and single-org assumptions

### 9.1 Code (runtime)

| Where | What |
|---|---|
| `src/auth/github.ts:3` | `export const SAPLING_ORG = "SaplingLearn"` |
| `src/auth/github.ts:60-68` | `isActiveOrgMember` → `GET /user/memberships/orgs/SaplingLearn` |
| `src/auth/routes.ts:102` | sign-in denied unless an active SaplingLearn member |
| `src/auth/routes.ts:207` | `/auth/me` returns `org: SAPLING_ORG` |
| `src/auth/onboard.ts:83` | "GitHub provider ⇒ may onboard" — relies on the org gate having run |
| `src/auth/principal.ts:18-21` | `isAdmin` = env `ADMIN_LOGINS` allowlist (one admin set for the platform) |
| `src/auth/routes.ts:226` | rename blocked unless the new handle is in `ADMIN_LOGINS` |
| `shared/tickets.ts:184,215` | `DEFAULT_TICKET_REPO = "SaplingLearn/sapling"`, default arg of `parseTicketLink` (used by `tools/tickets.ts:79`, `tools/sprints.ts:435`, `tools/ticket-mirror.ts:224`) |
| `src/notifications/cron.ts:19` | default `from_address` on `canopy.saplinglearn.com` |
| `src/notifications/invite.ts:28` | "Sapling team" copy |
| `src/notifications/sample.ts:9,16,53` | preview sample links to `SaplingLearn/sapling` |
| `src/repo/poll.ts:454-690` | `pollSaplingMetrics` — Sapling's metrics contract (`/api/internal/metrics`, `sap_c_*`/`sap_t_*`) |
| `src/repo/product.ts` | Sapling's product-metric registry (labels/groups) |
| `src/repo/cron.ts:28,46-47,89,102,188,338` | env secrets per deployment, `RAILWAY_TOKEN_<ENV>` naming |
| `src/env.ts:11-36` | `GITHUB_REPO`, `GITHUB_SERVICE_TOKEN`, `ADMIN_LOGINS`, `REPO_ENVIRONMENTS`, `CF_ANALYTICS_*`, `RAILWAY_TOKEN_STAGING/PRODUCTION`, `SAPLING_METRICS_TOKEN` — one value per deployment |
| `src/routes.ts:621-623,655-656` | dashboard/backfill read env repo + environments |
| `src/mcp.ts:368` | `get_repo_dashboard` reads env repo |
| `src/webhook.ts:386,399,422-428` | mirror/drift/failed-job use env repo + token |
| `src/tools/backfill.ts:214-215` | Sync GitHub uses env repo + token |
| `wrangler.toml` `[vars]` | `GITHUB_REPO = "SaplingLearn/sapling"`, `ADMIN_LOGINS = "AndresL230,andres"`, `PUBLIC_ORIGIN = "https://canopy.saplinglearn.com"`, `REPO_ENVIRONMENTS` (Sapling's staging/production, Railway ids) |
| `migrations/0025_sprints.sql` (sprints `domain` CHECK) | `'notifications','tickets','gate','feed','search','infra'` — Canopy-the-project's own domains |
| `migrations/0030_artifacts.sql:38` (`area` CHECK) | `'auth','architecture','infra','api','ui','data'` |
| `migrations/0005`/`0020` | `docs.space` default `'canopy'` |
| `migrations/0032_ticket_source.sql` | seeds the `github-webhook` system person (global — fine) |

### 9.2 SPA (`web/src`)

| Where | What |
|---|---|
| `web/src/api.ts:42-60` | `getJson` / `postJson` — every call uses an absolute root path (`/docs`, `/tickets`…); one seam to re-base |
| `web/src/quicksearch.ts:138`, `web/src/main.ts` (avatar POST), artifact iframes `/raw/a/…`, `/img/…` | direct fetch/URLs outside the seam |
| `web/src/api.ts:179` | `Me.org: string` (single org), `admin: boolean` (global) |
| `web/src/hash.ts`, `web/src/main.ts:329-337` | hash router — no org in the URL |
| `web/src/render.ts:631-670,1595,1705,1841,1855,1859` | "limited to the Sapling team", "Verifying Sapling membership", "Member of <org>", default origin, plugin install from `SaplingLearn/canopy` |
| `web/src/landing.ts:23,154,563,624,644,656` | landing copy "Currently limited to SaplingLearn members" |
| `web/src/handoffs.ts:253,288` | default repo `SaplingLearn/sapling` |
| `web/src/artifacts.ts:40,997` | `ARTIFACT_REPOS = ["SaplingLearn/canopy","SaplingLearn/sapling"]`; "Everyone in SaplingLearn can open it" |
| `web/src/github.ts:3`, `web/src/issue-ref.ts` | `REPO_URL = "https://github.com/SaplingLearn/sapling"` for `#123` links |
| `web/src/repo-sample.ts`, `web/src/releases.ts` | sample/release copy (cosmetic) |
| `wrangler.toml [assets]` | no `not_found_handling`, so a deep link like `/o/acme/` would fall through to the Worker and 401/404, not serve `index.html` |

### 9.3 Scripts

`scripts/backfill-events.mjs`, `scripts/build-prod-seed.mjs`, `scripts/capture-guide.mjs`,
`scripts/seed/reset.mjs` (canonical test seed: six persons, the `github-webhook` person) — all assume one org.

## 10. Conflicts with the locked decisions

Severity: **B** = would block a decision as written unless resolved; **R** = needs a design call recorded in
the spec; **N** = note. None is a hard blocker; each has a proposed resolution in `canopy-multitenancy.md`.

- **C-1 (B, security) Identity mapping grants sign-in.** `map_identity` (`src/tools/writes.ts:195-217`)
  calls `linkIdentity(provider:"github", subject:login, person)` (`:214`) — the SAME row `completeSignIn`
  trusts to start a session (`src/auth/onboard.ts:69-72`). Today any signed-in member can call it (the
  route at `src/routes.ts:478` has no admin gate). Once anyone can create an org, the admin of a brand-new
  org B could map a victim's not-yet-linked GitHub login onto B-admin's own person (the victim's next GitHub
  sign-in lands in B-admin's account), or map B-admin's own login onto a victim's person row (B-admin then
  signs in AS the victim, in every org the victim belongs to). Cross-tenant account takeover.
  **Resolution:** split attribution from authentication: a per-org
  `org_login_map (org_id, github_login, person)` for attribution; `identities` is written only by sign-in
  and Settings › link. Remove the `linkIdentity` call from the map path.
- **C-2 (B) The SaplingLearn org gate is the only thing stopping arbitrary GitHub users onboarding.**
  Removing it (decision 3) means any GitHub account can create a person row. That is intended (anyone can
  create an org), but `completeSignIn`'s branch 3 (`onboard.ts:83`) and the landing/denied copy assume a
  member. **Resolution:** sign-in always onboards a GitHub user; a user with no membership lands on
  "create an org / your pending invites".
- **C-3 (R) Google sign-in is invite-by-email; decision 4 says invites are by GitHub username.** Today
  Google is the only path for non-engineers (`meilin`, `sanaok` in `scripts/seed/reset.mjs`;
  `invites` keyed by email, `onboard.ts:82`). Decision 3 keeps "GitHub OAuth with PKCE as login" but does
  not say Google is removed. **Proposed:** keep Google as a linked/secondary provider for existing persons
  and for `org_invites` that carry an email instead of a login (`CHECK` exactly one of `github_login` /
  `email`). If the owner prefers the decision literally, Google sign-in becomes link-only (existing persons
  keep it) and new Google-only users cannot join. This needs the owner's call (spec §11 Q1).
- **C-4 (R) Bearer tokens and OAuth grants are person-only.** `mcp_tokens(person)` (`0023:77`),
  `oauth_grants(person)` (`0029:13`), `resolveBearerPrincipal` → `{ handle }` (`principal.ts:52-59`).
  **Resolution:** `org_id NOT NULL` on both; the OAuth consent page gains an org picker (skipped when the
  user has one membership); `Principal` becomes `{ handle, orgId, role }`; existing tokens/grants are
  backfilled to SaplingLearn so the plugin keeps working (decision 5: "plugin config does not change").
  Membership is re-checked on every `/mcp` request so removing a member kills their tokens.
- **C-5 (R) Per-deployment config and secrets must become per-org.** `GITHUB_REPO`, `GITHUB_SERVICE_TOKEN`,
  `REPO_ENVIRONMENTS`, `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`, `SAPLING_METRICS_TOKEN`, `GITHUB_WEBHOOK_SECRET`
  are Worker vars/secrets (`src/env.ts`). Decision 10 ("into per-org config") requires storing tenant
  secrets in D1. **Resolution:** `org_repos` + `org_secrets` with AES-GCM envelope encryption under one
  Worker secret (`ORG_SECRETS_KEY`); SaplingLearn's existing env values seed its rows; env fallback only
  for SaplingLearn during the cut-over and then removed.
- **C-6 (B, security) One global webhook secret cannot route to orgs safely.** If every org configured its
  repo webhook with the platform secret, any org admin would hold a key that forges deliveries for every
  other org's repos. **Resolution:** per-`org_repos` webhook secret and a per-hook URL
  `/webhook/github/:hook_id` (look up the row, verify HMAC with its secret, then require
  `repository.full_name` to equal the row's repo). Keep `/webhook/github` (global secret) mapped to
  SaplingLearn's repo row until its hook is re-pointed, then retire it.
- **C-7 (R) Cron subrequest budget is per invocation, not per org.** The free plan's 50 subrequests are
  already ~half used by one org at `:00`/`:20` (§6). "Cron iterates over orgs" (decision 11) cannot fan
  out N orgs in one invocation. Cloudflare Queues are a deferred seam (`CLAUDE.md` "do NOT activate").
  **Resolution:** a D1 cursor (`cron_cursor`) that gives each invocation ONE org for the heavy jobs (round
  robin) and runs the D1-only jobs (handoff expiry, prunes, digests) for all orgs; the per-org cadence
  stretches as orgs grow. Flag: past ~6 orgs with GitHub/usage config, the 6-hourly reconcile cadence per
  org degrades unless the Workers Paid plan (1,000+ subrequests) or Queues are adopted — owner call (spec §11 Q4).
- **C-8 (R) `persons.role` / `responsibilities` are per-org facts on a global row** (`0036_person_profiles.sql`,
  written by `src/tools/people.ts:97-108`, read by `list_people`). **Resolution:** move them onto
  `memberships` (`title`, `responsibilities`; `role` is taken by owner/admin/member); `persons` keeps
  name/color/avatar/email.
- **C-9 (R) Global AUTOINCREMENT ids are user-visible.** Tickets render as `#12` (`tickets.id`), handoffs as
  `#12`, and MCP tools take these ids. A new org's first ticket would be `#4381`, and ids leak platform
  volume across tenants. **Proposed:** keep `id` as the global surrogate key and add a per-org `number`
  (`UNIQUE(org_id, number)`) for tickets and handoffs; routes and MCP address `number`. Alternative: accept
  global ids for now (smaller change). Owner call (spec §11 Q2).
- **C-10 (R) Content-addressed `doc_images` / `/img/:sha` are cross-tenant by design.** `doc_images.sha256` is
  the PK and `/img/:sha` (`src/routes.ts:73`) serves any session. Org B can embed or fetch org A's image if it
  learns the hash, and the gate check (`docImageProblems`) would accept a foreign sha. **Resolution:**
  `doc_images` PK `(org_id, sha256)`; R2 bytes stay deduplicated at `doc-images/<sha>` (immutable), but the
  row is the capability — serving and the gate both require the row in the caller's org. Avatars stay global.
- **C-11 (R) Multiple repos per org vs. repo-less semantic keys.** Decision 2 allows `org_repos` (many). Every
  capture key (`events.semantic_key`, `repo_events.semantic_key`, `issue_summaries.issue_number`,
  `sprints.github_ref` bare numbers resolved against `GITHUB_REPO`, `repo_snapshots.kind`) assumes ONE repo.
  **Resolution:** add a `repo` column to `events`, `repo_events`, `pr_summaries`, `issue_summaries` and include
  it in their uniqueness; the Repo dashboard, sprint progress and ticket mirror read the org's single
  `is_primary` repo; webhooks from non-primary repos are captured into `events`/`repo_events` (attributed) but
  feed no dashboard. Multi-repo dashboards are out of scope.
- **C-12 (R) Artifact raw content is same-origin today.** `/raw/a/:slug` is served from Canopy's origin with
  `sandbox allow-scripts` CSP (`src/artifacts/raw.ts:3-40`) — opaque origin, so cookies are not readable, but
  decision 12 requires a separate origin. **Resolution:** a second hostname (e.g. `canopyusercontent.com`)
  bound to the same Worker, which serves ONLY `/raw/*` from a short-lived signed read URL minted by the app
  origin (no cookie on that origin). This is a read capability, not an action token in a link, so it is
  consistent with decision 4's principle. Needs an owner-provisioned domain (spec §11 Q5).
- **C-13 (R) Decision 7 vs. pre-tenant tables.** "All D1 access through functions that take a required
  `TenantContext`" cannot hold for `persons`, `identities`, `sessions`, `oauth_clients`, `orgs`,
  `memberships` lookups made BEFORE an org is resolved (sign-in, `/mcp` bearer resolution, webhook routing,
  the cron's org loop, `/u/` unsubscribe, handle rename across all orgs). **Resolution:** the data layer has
  two entry types — `TenantContext` (every T/UO table) and a deliberately narrow `PlatformContext` for the
  global tables and org resolution — both inside `src/data/`; the enforcement test asserts no `prepare`/`DB`
  outside `src/data/`, and that `src/data/platform/*` SQL never names a tenant table.
- **C-14 (N) `renamePerson` rewrites every `HANDLE_COLUMNS` table across all orgs** (`src/auth/persons.ts:124-170`).
  Correct (a handle is one person everywhere) but must be a `PlatformContext` operation, and
  `memberships.user_id` / `org_invites.invited_by` / `org_login_map.person` join the list. The
  `ADMIN_LOGINS` rename rule (`auth/routes.ts:226`) disappears with the allowlist.
- **C-15 (N) Handles are a global namespace.** `persons.handle` stays globally unique (it is the user id,
  decision 2's `user_id`). Every handle input (`requirePerson` `src/tools/tickets.ts:65`, handoff recipients,
  `assign_ticket`, `/api/people/:handle`, quick-search person hits, `list_people`) must additionally check
  membership in the caller's org, or a tenant can enumerate the platform's users.
- **C-16 (N) Hardcoded vocabularies** — sprint `domain`, artifact `area`, doc `space='canopy'` (§9.1) are
  Canopy-team specific. Out of scope to make per-org; they stay global and are listed as follow-up.
- **C-17 (N) `ADMIN_LOGINS` also gates platform operations** (none besides those listed). After the move to
  org roles, there is no platform admin role; the spec keeps an env `PLATFORM_ADMINS` only for org deletion
  / support, unused by tenant routes.
- **C-18 (N) SPA path routing.** Decision 5 puts the org in the path (`/o/:slug/…`) while the SPA routes by
  hash. Compatible: `/o/:slug/#tickets/7`. Needs a Worker fallback (or assets SPA mode) so `/o/<slug>/` serves `index.html`, and the API seam (`web/src/api.ts`) prefixes
  `/api/o/<slug>`.

## 11. Things that are already tenant-friendly

- Every tool already takes `db` as a parameter (no module-level DB handle) — the port to a context argument
  is mechanical. `fanOut` (`src/db.ts:57`) takes `leading` params, so `org_id` binds before the id chunk.
- The SPA has ONE fetch seam (`web/src/api.ts`).
- A fresh `McpServer` per request (`src/mcp.ts:84`) — binding it to `(user, org)` is natural.
- Confirm verbs are already cookie-only, and ratify refuses an `Authorization` header.
- Tests run against a real Miniflare D1 with a shared reset (`test/apply-migrations.ts`), so the isolation
  matrix can assert on rows.
- Baseline suite, run in this session before any change: **158 test files, 2,683 tests, all green** (`npm test`, 279 s).

---

## Appendix A — every SQL statement in `src/` (370)

Mechanically extracted (see §0). "Tables" lists every table the statement names in a FROM / JOIN / INTO /
UPDATE position. Four hand-classified statements: `src/auth/persons.ts:168` (UPDATE over every
`HANDLE_COLUMNS` table), `src/tools/artifacts.ts:245` (`tickets` or `sprints`), `src/tools/mywork.ts:218` and
`:242` (`tickets` + `ticket_assignees` via `assignedFrom`).

| File | Statements (line · op · tables) |
|---|---|
| `src/auth/invites.ts` (8) | `8` SELECT invites<br>`16` INSERT invites<br>`20` SELECT invites<br>`24` UPDATE invites<br>`28` SELECT invites<br>`30` UPDATE invites<br>`35` SELECT invites<br>`39` UPDATE invites |
| `src/auth/oauth.ts` (22) | `132` INSERT oauth_clients<br>`139` SELECT oauth_clients<br>`198` INSERT oauth_grants<br>`203` INSERT oauth_codes<br>`220` INSERT oauth_tokens<br>`229` SELECT oauth_grants<br>`240` UPDATE oauth_codes<br>`258` SELECT oauth_grants, oauth_tokens<br>`266` UPDATE oauth_grants<br>`285` SELECT oauth_grants, oauth_tokens<br>`291` UPDATE oauth_tokens<br>`293` SELECT oauth_tokens<br>`296` UPDATE oauth_grants<br>`304` SELECT oauth_tokens<br>`307` UPDATE oauth_grants<br>`309` UPDATE oauth_tokens<br>`316` SELECT oauth_grants<br>`324` UPDATE oauth_grants<br>`335` DELETE oauth_codes<br>`336` DELETE oauth_tokens<br>`337` DELETE oauth_tokens<br>`338` DELETE oauth_clients, oauth_codes, oauth_grants |
| `src/auth/persons.ts` (13) | `25` SELECT persons<br>`29` SELECT identities<br>`37` SELECT persons<br>`57` UPDATE persons<br>`70` INSERT persons<br>`80` INSERT identities<br>`93` DELETE identities<br>`94` UPDATE persons<br>`100` SELECT identities<br>`106` UPDATE persons<br>`116` SELECT persons<br>`167` UPDATE persons<br>`168` UPDATE *every HANDLE_COLUMNS table* |
| `src/auth/routes.ts` (1) | `176` DELETE persons |
| `src/auth/session.ts` (3) | `14` INSERT sessions<br>`21` SELECT sessions<br>`28` DELETE sessions |
| `src/auth/tokens.ts` (5) | `15` INSERT mcp_tokens<br>`25` SELECT mcp_tokens<br>`27` UPDATE mcp_tokens<br>`34` SELECT mcp_tokens<br>`42` UPDATE mcp_tokens |
| `src/consumer.ts` (7) | `65` SELECT processed_items<br>`81` INSERT processed_items<br>`141` SELECT docs<br>`162` SELECT doc_versions<br>`222` SELECT adrs<br>`241` INSERT events<br>`268` INSERT repo_events |
| `src/index.ts` (1) | `47` UPDATE persons |
| `src/mcp.ts` (1) | `504` DELETE tickets |
| `src/notifications/cron.ts` (1) | `31` SELECT notification_settings |
| `src/notifications/delivery.ts` (1) | `27` INSERT notification_outbox_bodies |
| `src/notifications/policy.ts` (1) | `13` INSERT notification_policy |
| `src/notifications/renderers/my-work.ts` (1) | `66` SELECT events, pr_summaries |
| `src/notifications/renderers/roadmap-plan.ts` (2) | `57` SELECT plan_versions<br>`66` SELECT plan_versions |
| `src/notifications/renderers/ticket-queue.ts` (1) | `53` SELECT persons, ticket_assignees, tickets |
| `src/notifications/resolve.ts` (4) | `14` SELECT notification_policy<br>`19` SELECT notification_prefs<br>`35` SELECT notification_policy<br>`37` SELECT notification_prefs |
| `src/notifications/retry.ts` (2) | `25` SELECT notification_outbox<br>`33` SELECT persons |
| `src/notifications/routes.ts` (13) | `26` SELECT persons<br>`86` UPDATE persons<br>`87` UPDATE persons<br>`89` DELETE notification_prefs<br>`90` INSERT notification_prefs<br>`134` SELECT notification_policy<br>`137` INSERT notification_policy<br>`171` INSERT notification_settings<br>`182` SELECT notification_outbox<br>`200` UPDATE persons<br>`247` SELECT persons<br>`269` INSERT notification_outbox<br>`278` SELECT notification_outbox |
| `src/notifications/run.ts` (3) | `39` UPDATE notification_outbox<br>`126` SELECT persons<br>`137` INSERT notification_outbox |
| `src/repo/cron.ts` (2) | `244` INSERT repo_snapshots<br>`255` DELETE repo_snapshots |
| `src/repo/github.ts` (3) | `240` SELECT repo_events<br>`419` UPDATE repo_events<br>`463` SELECT repo_events |
| `src/repo/reads.ts` (16) | `19` SELECT repo_events<br>`20` SELECT repo_events<br>`30` SELECT repo_events<br>`39` SELECT repo_events<br>`55` SELECT repo_events<br>`65` SELECT repo_events<br>`72` SELECT repo_events<br>`141` SELECT repo_events<br>`159` SELECT repo_events<br>`197` SELECT repo_events<br>`227` SELECT repo_events<br>`258` SELECT repo_events<br>`270` SELECT repo_events<br>`280` SELECT repo_events<br>`296` SELECT repo_events<br>`313` SELECT repo_events |
| `src/repo/store.ts` (16) | `52` INSERT repo_snapshots<br>`58` SELECT repo_snapshots<br>`92` INSERT repo_metrics<br>`134` SELECT repo_metrics<br>`161` SELECT repo_metrics<br>`182` SELECT repo_metrics<br>`186` SELECT repo_metrics<br>`238` SELECT repo_metrics<br>`244` SELECT repo_metrics<br>`246` SELECT repo_metrics<br>`259` SELECT repo_metrics<br>`270` SELECT repo_metrics<br>`280` DELETE repo_metrics<br>`284` DELETE repo_metrics<br>`289` DELETE repo_metrics<br>`295` DELETE repo_events |
| `src/routes.ts` (3) | `366` SELECT docs<br>`580` SELECT invites<br>`588` SELECT invites |
| `src/tools/artifacts.ts` (47) | `114` SELECT artifact_pages<br>`245` SELECT tickets | sprints<br>`279` SELECT tickets<br>`283` SELECT sprints<br>`311` SELECT artifact_pages<br>`344` SELECT artifact_links<br>`381` SELECT artifact_links<br>`390` SELECT artifacts_fts<br>`399` SELECT artifact_pages, artifact_versions<br>`421` SELECT artifact_versions<br>`423` SELECT artifact_versions<br>`427` SELECT artifact_versions<br>`428` SELECT artifact_links<br>`453` SELECT artifact_versions<br>`480` SELECT artifact_versions<br>`499` SELECT artifact_pages<br>`507` SELECT artifact_versions<br>`545` SELECT artifact_pages, artifacts_fts<br>`578` INSERT artifacts_fts<br>`591` SELECT artifact_versions<br>`611` INSERT artifact_versions<br>`615` UPDATE artifact_pages<br>`622` DELETE artifacts_fts<br>`629` SELECT artifact_pages<br>`645` SELECT artifact_pages<br>`648` INSERT artifact_pages<br>`654` INSERT artifact_versions<br>`661` INSERT artifact_links<br>`741` SELECT artifact_versions<br>`794` UPDATE artifact_pages<br>`802` UPDATE artifacts_fts<br>`823` UPDATE artifact_pages<br>`835` INSERT artifact_links<br>`844` DELETE artifact_links<br>`861` UPDATE artifact_pages<br>`862` DELETE artifacts_fts<br>`879` SELECT artifact_pages<br>`885` SELECT artifact_versions<br>`887` UPDATE artifact_pages<br>`888` DELETE artifacts_fts<br>`926` INSERT artifact_pages, artifact_upload_tokens<br>`942` SELECT artifact_pages<br>`959` UPDATE artifact_upload_tokens<br>`961` SELECT artifact_upload_tokens<br>`965` UPDATE artifact_upload_tokens<br>`966` SELECT artifact_upload_tokens<br>`967` SELECT artifact_pages |
| `src/tools/backfill.ts` (2) | `314` SELECT issue_summaries<br>`362` SELECT pr_summaries |
| `src/tools/doc-images.ts` (8) | `50` SELECT doc_images<br>`56` INSERT doc_image_upload_tokens<br>`77` SELECT doc_image_upload_tokens<br>`81` UPDATE doc_image_upload_tokens<br>`83` UPDATE doc_image_upload_tokens<br>`101` INSERT doc_images<br>`125` SELECT doc_images<br>`138` SELECT doc_images |
| `src/tools/feed-stats.ts` (2) | `50` SELECT feed<br>`55` SELECT entry_tags, feed |
| `src/tools/handoffs.ts` (5) | `86` SELECT handoffs<br>`91` SELECT handoffs<br>`105` SELECT processed_items<br>`129` INSERT handoffs<br>`136` INSERT processed_items |
| `src/tools/mywork.ts` (7) | `36` SELECT identities, persons<br>`75` SELECT sprints<br>`123` SELECT events, issue_summaries<br>`218` SELECT tickets, ticket_assignees (via `assignedFrom`)<br>`242` SELECT tickets, ticket_assignees (via `assignedFrom`)<br>`275` SELECT events, pr_summaries<br>`314` SELECT events |
| `src/tools/people.ts` (8) | `53` SELECT persons<br>`55` SELECT identities<br>`97` SELECT persons<br>`108` UPDATE persons<br>`150` UPDATE persons<br>`156` UPDATE persons<br>`157` SELECT persons<br>`173` SELECT persons |
| `src/tools/plan.ts` (9) | `76` SELECT sprints<br>`86` INSERT plan<br>`88` SELECT plan<br>`122` UPDATE sprints<br>`127` INSERT sprints<br>`149` SELECT sprints<br>`153` UPDATE plan<br>`161` INSERT plan_versions<br>`185` SELECT plan |
| `src/tools/progress.ts` (6) | `78` INSERT sprint_progress<br>`95` SELECT sprint_progress<br>`103` SELECT events<br>`130` SELECT sprints<br>`144` SELECT sprints<br>`180` SELECT sprints |
| `src/tools/prompts.ts` (18) | `57` SELECT prompt_versions, prompts<br>`111` UPDATE prompts<br>`117` SELECT prompt_versions<br>`131` SELECT prompts<br>`136` SELECT prompts<br>`150` INSERT prompts<br>`155` UPDATE prompts<br>`156` UPDATE prompt_versions<br>`158` UPDATE prompts<br>`161` INSERT prompt_versions<br>`173` UPDATE prompts<br>`180` SELECT prompts<br>`181` UPDATE prompt_versions<br>`183` UPDATE prompts<br>`196` SELECT prompts<br>`199` UPDATE prompts<br>`211` SELECT prompts<br>`215` UPDATE prompts |
| `src/tools/quick-search.ts` (9) | `118` SELECT tickets<br>`121` SELECT tickets, tickets_fts<br>`128` SELECT docs, docs_fts<br>`137` SELECT adrs, adrs_fts<br>`146` SELECT roadmap_fts, sprints<br>`161` SELECT prompt_versions, prompts, prompts_fts<br>`179` SELECT handoffs<br>`201` SELECT persons<br>`211` SELECT feed, feed_fts |
| `src/tools/reads.ts` (13) | `16` SELECT docs<br>`20` SELECT doc_versions<br>`28` SELECT docs<br>`30` SELECT docs<br>`37` SELECT docs<br>`73` SELECT feed<br>`82` SELECT needs_triage<br>`90` SELECT adrs<br>`91` SELECT adrs<br>`120` SELECT doc_versions, docs<br>`166` SELECT identity_tasks<br>`172` SELECT events<br>`204` SELECT identities, identity_tasks |
| `src/tools/repo.ts` (9) | `120` SELECT identities, persons<br>`139` SELECT events<br>`166` SELECT tickets<br>`167` SELECT tickets<br>`170` SELECT ticket_events, tickets<br>`604` SELECT events<br>`609` SELECT events<br>`747` SELECT repo_events<br>`752` SELECT events |
| `src/tools/sprints.ts` (23) | `103` SELECT tickets<br>`122` SELECT ticket_assignees, tickets<br>`140` SELECT ticket_assignees, tickets<br>`162` SELECT sprints<br>`191` SELECT sprints<br>`201` SELECT tickets<br>`206` SELECT sprint_progress<br>`228` SELECT sprints<br>`233` SELECT tickets<br>`243` SELECT ticket_assignees<br>`264` SELECT sprint_resources<br>`272` SELECT ticket_links<br>`291` SELECT sprint_progress<br>`323` INSERT sprints<br>`360` UPDATE sprints<br>`372` SELECT sprints<br>`387` UPDATE sprints<br>`416` UPDATE tickets<br>`417` DELETE sprint_resources<br>`418` DELETE sprint_progress<br>`419` DELETE sprints<br>`440` SELECT sprint_resources<br>`447` INSERT sprint_resources |
| `src/tools/summarize.ts` (2) | `238` INSERT pr_summaries<br>`285` INSERT issue_summaries |
| `src/tools/ticket-mirror.ts` (11) | `156` SELECT tickets<br>`182` UPDATE tickets<br>`207` INSERT ticket_events<br>`209` UPDATE tickets<br>`240` SELECT tickets<br>`244` INSERT tickets<br>`251` INSERT ticket_assignees, ticket_events<br>`255` INSERT ticket_events<br>`261` INSERT ticket_links<br>`274` INSERT ticket_links<br>`280` INSERT ticket_events |
| `src/tools/tickets-agent.ts` (4) | `88` SELECT tickets<br>`95` SELECT ticket_assignees<br>`114` SELECT ticket_assignees, tickets<br>`219` SELECT ticket_assignees |
| `src/tools/tickets.ts` (30) | `52` SELECT tickets<br>`58` UPDATE tickets<br>`73` SELECT sprints<br>`110` INSERT tickets<br>`124` INSERT ticket_assignees<br>`130` INSERT ticket_events<br>`139` INSERT ticket_links<br>`161` INSERT ticket_events<br>`166` UPDATE tickets<br>`187` SELECT tickets<br>`193` UPDATE tickets<br>`195` INSERT ticket_events<br>`198` UPDATE tickets<br>`212` INSERT ticket_assignees<br>`214` DELETE ticket_assignees<br>`227` INSERT ticket_links<br>`248` SELECT ticket_links<br>`251` DELETE ticket_links<br>`270` UPDATE tickets<br>`279` UPDATE tickets<br>`299` SELECT tickets<br>`303` UPDATE tickets<br>`317` INSERT ticket_comments<br>`341` UPDATE tickets<br>`342` DELETE ticket_assignees<br>`343` DELETE ticket_links<br>`344` DELETE ticket_comments<br>`345` DELETE ticket_events<br>`346` DELETE artifact_links<br>`347` DELETE tickets |
| `src/tools/writes.ts` (27) | `24` INSERT feed<br>`36` INSERT entry_tags<br>`63` SELECT docs<br>`72` INSERT docs<br>`88` SELECT doc_versions<br>`95` INSERT doc_versions<br>`125` INSERT adrs<br>`147` INSERT needs_triage<br>`177` INSERT identity_tasks<br>`201` SELECT identity_tasks<br>`217` UPDATE identity_tasks<br>`245` SELECT identity_tasks<br>`251` UPDATE identity_tasks<br>`266` SELECT identity_tasks<br>`274` UPDATE identity_tasks<br>`292` SELECT doc_versions<br>`300` UPDATE doc_versions<br>`303` UPDATE docs<br>`315` SELECT adrs<br>`318` UPDATE adrs<br>`347` SELECT doc_versions<br>`354` UPDATE doc_versions<br>`363` SELECT adrs<br>`367` UPDATE adrs<br>`383` SELECT needs_triage<br>`391` UPDATE needs_triage<br>`427` SELECT needs_triage |
