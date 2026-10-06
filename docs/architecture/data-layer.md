# Data layer — tenant and platform contexts

Spec: `canopy-multitenancy.md` §4. Code: `src/data/`. Phase 3 is complete: every statement in `src/` runs
through a context, every tenant statement names its org, and `test/data-layer.static.test.ts` enforces both.

## The two contexts

| | Type | Built by | Query surface |
|---|---|---|---|
| Tenant data | `TenantContext { orgId, userId, role, via }` | `resolveTenant` (slug + membership), `resolveTenantById` (a credential that names its org), `resolveSoleTenant` (cut-over alias: the caller's one org), `resolveBearerTenant` (`src/data/bearer.ts`), `systemTenant(p, orgId, actor)` | `src/data/sql.ts` |
| Platform data | `PlatformContext { actor }` | `platform(env, actor)` | `src/data/platform-sql.ts` |

Both surfaces export the same helpers — `first`, `all`, `run`, `stmt`, `batch`, `fanOut`, plus `nowIso`, `ph`,
`chunked`. D1 is reachable ONLY inside `src/data/` (the handle sits behind a module-private symbol in
`context.ts`); nothing else names `D1Database`, `env.DB`, `.prepare(` or `.batch(`.

- Every resolver is ONE statement and also reads `orgs.suspended_at`: a suspended org resolves for no one
  (`resolveTenant` / `resolveTenantById` → null; `resolveSoleTenant` → `reason: "suspended"`; bearer → `unauthorized`).
- `c.var.ctx` / `c.var.p` are set by `src/data/gate.ts`. `tenantGate` is mounted ONCE, on `/api/o/:slug/*` in
  `src/routes.ts`, and meters the request — a sub-app never applies it again.
- A repository never builds a context. A module that touches both kinds takes the tenant ctx and receives
  `p` as a parameter. (One exception: `createOrg` writes the new org's seed rows as `systemTenant(p, newId)`.)
- `src/data/secrets.ts` reads its key through `kekOf(ctx)`; no other module can reach a context's `Env`.

## Which tables are which

The lists are derived from the live schema — every table with an `org_id` column is **org-keyed**.

- **Tenant tables**: every org-keyed table except the five below. That includes all content tables and their
  FTS tables, the per-user-per-org tables (`mcp_tokens`, `oauth_grants`, `oauth_codes`, `notification_*`), and an
  org's own configuration: `org_repos`, `org_environments`, `org_integration_config`, `org_login_map`,
  `org_secrets`, `org_keys`, `org_audit` (read through a tenant ctx by `src/integrations/*`, `src/data/secrets.ts`).
- **Platform-owned org-keyed tables**: `memberships`, `org_invites`, `org_counters`, `org_usage_daily`,
  `org_admin_audit` — an org's place on the platform, written by `src/orgs`, `src/platform`, `src/data/meter.ts`.
  A tenant statement may read or write them too (membership checks, the settings audit) — with its `org_id`.
- **Global tables** (no `org_id`): `persons`, `identities`, `sessions`, `invites`, `oauth_clients`,
  `oauth_tokens`, `orgs`, `platform_admins`, `cron_cursor`, `sections`, `tags`.

## Writing a statement

- A predicate is written exactly `org_id = ?` / `<alias>.org_id = ?`, bound from `ctx.orgId` — never a literal,
  never a request value. One per org-keyed table the statement references, JOINs and subqueries included.
- The predicate is in the STATEMENT TEXT, not in a `clauses` array:
  `` `… WHERE t.org_id = ?${clauses.map((c) => ` AND ${c}`).join("")}` ``.
- Every `INSERT INTO <org-keyed table>` lists `org_id`; an upsert target names it (`ON CONFLICT(org_id, …)`).
- A lookup by a global id is `WHERE id = ? AND org_id = ?` — another org's id reads as not found.
- FTS: `org_id` is the LAST column; every `MATCH` adds `AND <fts>.org_id = ?` in the `WHERE` that carries the `LIMIT`.
- ``fanOut(ctx, ids, (ph) => `… WHERE org_id = ? AND id IN (${ph})`, [ctx.orgId])`` — the org goes in `leading`.
- A handle from input that must be a person in the org goes through `requireMember(ctx, handle)` /
  `memberHandle` / `memberPerson` (`src/auth/persons.ts`): unknown, reserved and non-member read the same
  (`PersonError`, a `bad_request` on HTTP and MCP).
- SQL keywords are upper-case, and a file that imports BOTH surfaces aliases one of them (`platformFirst`).

## The static test (`test/data-layer.static.test.ts`)

It reads the source text of `src/` (extractor: `test/helpers/sql-extract.ts` — comments, strings, template
holes and regex literals are tokenised; each literal knows its enclosing calls and its top-level declaration).
A statement's surface is the helper call around it, else the file's only surface, else (a two-surface file)
the surface of whatever uses the constant it is bound to. A failure names `file:line`, the rule and the statement.

1. No D1 access outside `src/data/`. No allowlist.
2. A tenant statement has `org_id` once per org-keyed table reference, in every INSERT column list and upsert
   target, and never against a literal. A statement that cannot be attributed to a surface fails.
3. A platform statement names no tenant table, except `PLATFORM_ALLOW` (below). A stale entry fails.
4. The table lists come from `sqlite_master` / `pragma_table_info`, so a new table is covered automatically.

Also checked: the cut-over entry points (below) are the only callers of `src/data/legacy.ts`, each marked `// MT:`.
It is a text heuristic, not a proof — it counts `org_id` mentions, it does not check which parameter is bound —
so the isolation tests (and the §10.3 mutation check) remain the behavioural half.

### Allowlist (each entry: file + function + why — in the test)

| Where | Why |
|---|---|
| `src/platform/sweeps.ts` `expireDueHandoffs`, `pruneRepoCapture`; `src/auth/oauth.ts` `pruneOAuth` | cross-org retention sweeps: write-only, bounded by age |
| `src/platform/jobs.ts` (`org_repos`, `org_environments`) | the cron's unit lists and the webhook's hook lookup, before any org is known — ids, an environment key and a repo name |
| `src/auth/tokens.ts`, `src/auth/oauth.ts` (`mcp_tokens`, `oauth_grants`, `oauth_codes`) | credential lookup by hash before any org is known; person-level token management until Phase 5a |
| `src/artifacts/upload.ts` `uploadTokenOrg` | upload-token lookup by hash, returning only its `org_id` |
| `src/platform/usage.ts` (whole file); `src/platform/repo.ts` `listAudit` (`org_audit`) | the superadmin's cross-org counts and merged audit trail — no content, no secret |
| `src/orgs/repo.ts` `removeMember` | revokes the removed person's tokens / grants for that org, in the same batch |
| `src/auth/persons.ts` `renamePerson` (interpolated) | the `HANDLE_COLUMNS` update — a rename must span every org |
| `src/tools/artifacts.ts` `normalizeLinkRef` (interpolated, tenant) | `tickets` or `sprints` from a two-value literal, with `org_id = ?` |
| `src/tools/progress.ts` upsert on `sprint_progress` | its PK is `sprint_id` alone; guarded by `WHERE sprint_progress.org_id = excluded.org_id` (asserted) |

## Background jobs (Phase 5b — spec §8.3–§8.5)

No background entry point names an org any more: each one ENUMERATES the orgs (or finds the one a delivery
belongs to) through `src/platform/jobs.ts`, then does its work as that org's `systemTenant`.

| Entry point | Org comes from | Runs as |
|---|---|---|
| repo cron `handleRepoCron` (`src/repo/cron.ts`) | `listEnvUnits` / `listRepoUnits` — every non-suspended org | `systemTenant(p, org, "system")` per unit |
| digest crons `handleNotificationCron` (`src/notifications/cron.ts`) | `listActiveOrgIds` | the same, per org |
| `POST /webhook/github/:hookId`, legacy `/webhook/github` (`src/github-hook.ts`) | `hookRepo(p, id)` / `legacyHookRepo(p)` | `systemTenant(p, row.org_id, "github-webhook")` |
| Poll now / Poll usage / Sync GitHub (`runLockedRepoRefresh`, `runUsagePolls`, `runBackfill`, `runReconcileJob`) | the caller's `ctx` | `jobTenant(env, ctx)` — that org's system tenant; a bearer context is refused |

**The rotation dispatcher** (`src/repo/dispatch.ts`). The repo trigger keeps its cadence — `health` every
tick, `usage` at `:00`, and every 6th hour `progress` at `:10`, `reconcile` at `:20`, the cross-org prune
sweeps at `:30` — and each cadence is a JOB over UNITS: one per (org, environment) for `health` / `usage`
(key `<org>/<env key>`, in org then `position` order), one per org with a primary repo for `progress` /
`reconcile` (key `<org>`). One invocation serves units in order, starting after `cron_cursor.last_key` for
that job, while the unit's worst-case cost still fits `CRON_SUBREQUEST_BUDGET` (900 fetches; what a unit
really spent is counted through the budget's own `fetch`) and `CRON_WALL_BUDGET_MS` (8 min) is not spent;
then it stores the last key served (`''` once every unit was served — so with few orgs the cursor is never
written). `health` goes first and may use at most half the budget on a tick that also has a heavy job.
Queues stay a deferred seam: a unit runner (`runEnvJob(env, orgId, envKey, job, now)`,
`runOrgJob(env, orgId, job, now)`) is what a consumer would call, unchanged.

**Isolation.** A unit is TOTAL: it catches its own failure, logs it with `org=<id>`, records it on THAT
org's integration row (`recordSecretOutcome` → `last_error`; a success → `last_used_at`), and the loop moves
on. An org with no environment and no primary repo has no unit — no statement, no request, no log line. A
suspended org is absent from every list, and its hook reads as unknown.

**Configuration and credentials.** The repo is the org's primary `org_repos` row (`orgPrimaryRepo`), the
environments are `org_environments` in `position` order (`orgEnvironments`) — `GITHUB_REPO` and
`REPO_ENVIRONMENTS` are read by no background job (the two dashboard READS in `src/routes.ts` /
`src/mcp.ts` still parse the var; they move with their phases). Every credential comes from
`resolveCredential(ctx, env, kind, scope)`: `github_token` (`""`), `github_webhook` (the hook id),
`cloudflare_analytics` (`""`, + `resolveCloudflareAccountId`), `railway` and `metrics_endpoint` (the
environment key). It is resolved ONLY in modules that `src/mcp.ts` cannot reach — `src/repo/cron.ts`,
`src/github-hook.ts`, `src/tools/backfill.ts` — and the revealed value is passed down as a parameter
(`src/webhook.ts` and `src/repo/github.ts` ARE reachable from MCP; `test/secrets.mcp.test.ts`). Every log
line and stored `last_error` is scrubbed of every credential the unit revealed.

**Webhooks.** `POST /webhook/github/:hookId`: look the row up (unknown or suspended → 404), verify the HMAC
against that repo's secret (none / wrong → bare 401, NOTHING written), require the payload to name that
repo (else 202 ignored), then `captureDelivery` as the org. Only the org's PRIMARY repo is captured today —
the capture's keys (`gh:pr:<n>:…`) carry no repo — so a non-primary repo's verified delivery is ignored.
The legacy `POST /webhook/github` delivers to the one `legacy_hook = 1` row with no repository check,
exactly as before.

**Email.** One digest per (person, org): each org is due on its own `notification_settings`, the outbox key
is `org:user:cadence:window`, the unsubscribe is global. The From ADDRESS is the platform's — an org's
`from_address` contributes its display name only (`platformFrom`). `notification_policy` is seeded by
`createOrg` and topped up per org by the cron; the per-isolate seed in `src/index.ts` is gone.

**SaplingLearn's fallback (owner steps).** These Worker secrets are now read ONLY by `resolveCredential`'s
`org_saplinglearn` fallback (and by the cron's log scrubber): `GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
`CF_ANALYTICS_TOKEN` + `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_<ENV>`, `SAPLING_METRICS_TOKEN`. Each stops
being read the moment SaplingLearn's admin stores that integration on the Integrations screen (a stored
secret wins). The cleanup phase deletes the fallback, those secrets, the legacy hook route and the
`legacy_hook` flag.

## Cut-over entry points (not shims — replaced in later phases)

`src/data/legacy.ts` keeps `legacySystemTenant(env, actor)` and `joinLegacyOrg(p, handle)`: the entry points
that cannot name their org yet act on SaplingLearn. After Phase 5b the only caller left is `src/auth/routes.ts`
(onboarding → Phase 4). `resolveSoleTenant` / `soleTenantGate` are the route alias Phase 4 replaces.

## Tests

`test/helpers/tenant.ts`: `systemCtx(org?)`, `tenantCtx(handle, role?, { orgId, via, env })`, `bearerCtx`,
`platformCtx`, `ensureMember`, `ORG_A`, `ORG_B`. `test/helpers/org-config.ts`: an org's repo / environment rows
(`addOrgRepo`, `setOrgEnvironments`), and the one-org call shapes of the background entry points for the
SaplingLearn-only suites (`syncOrgConfig` copies the Env's `GITHUB_REPO` / `REPO_ENVIRONMENTS` into its rows,
as 0037 did). Fixture SQL may use `env.DB` directly; the raw `first` / `all` /
`run` helpers for it live in `test/helpers/db.ts` (production has none). Each module has an isolation
assertion in `test/isolation.*.test.ts`: write through `systemCtx(ORG_B)`, read through `systemCtx()`, expect nothing.
