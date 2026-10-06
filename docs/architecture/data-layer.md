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
  The bearer resolver is two reads: the credential by hash, then `resolveTenantById` for the org on its row.
- `c.var.ctx` / `c.var.p` are set by `src/data/gate.ts`. `tenantGate` is mounted ONCE, on `/api/o/:slug/*` in
  `src/routes.ts`, and meters the request — a sub-app never applies it again.
- A repository never builds a context. A module that touches both kinds takes the tenant ctx and receives
  `p` as a parameter. (One exception: `createOrg` writes the new org's seed rows as `systemTenant(p, newId)`.)
- `src/data/secrets.ts` reads its key through `kekOf(ctx)`; no other module can reach a context's `Env`.

## Bearer: MCP is bound to (user, org) — Phase 5a (spec §7)

- A personal token (`mcp_tokens`) and an OAuth grant (`oauth_grants`, with its `oauth_codes`) each carry the
  `org_id` they were made for. `resolveBearerTenant` reads the credential by hash → `{ handle, orgId }` from the
  ROW, then builds the context with `resolveTenantById(env, handle, orgId, "bearer")`: the role is the person's
  role in that org today. No header, query or body value can name another org; no tool takes an org argument.
- Every miss is the same `unauthorized` (`/mcp` → 401 `invalid_token`): unknown / revoked / expired credential,
  the person no longer a member of the row's org, that org suspended or gone. There is no 409 on `/mcp` any more.
- Rows from before org-scoping carry `org_saplinglearn` (0038's column default backfilled them), so they resolve
  as they always did. The Phase 7 cleanup drops the default; every writer already names the org.
- Tokens: `mintToken(ctx)` / `listTokens(ctx)` / `revokeToken(ctx, id)` are TENANT statements (the caller's own
  tokens for `ctx.orgId`), served at `GET|POST /api/o/:slug/mcp-tokens`, `POST …/:id/revoke`
  (`src/auth/token-routes.ts`). `/auth/mcp-token…` is the cut-over alias for a person with exactly one org.
- OAuth: the consent page lists the person's orgs (`listMyOrgs`; a radio group when there are several, a hidden
  field when there is one, a "join an organization first" page when there are none). The POSTed `org` slug is
  bound through `resolveTenant` — a live membership check — and `issueAuthorization(ctx, …)` writes the grant and
  code as tenant statements. Code exchange and refresh re-read the grant's standing (`GRANT_STANDING`): a
  membership that is gone refuses AND revokes the grant (`member_removed`); a suspended org refuses without
  revoking. `GET /auth/oauth-grants` stays user-level and each row carries `org: { slug, name }`.
- "Admin" over MCP is `hasRole(ctx, "admin")` — `update_plan`'s registration and the lane's two admin
  exceptions (`src/tools/tickets-agent.ts`). `ADMIN_LOGINS` grants nothing over MCP.
- `get_repo_dashboard` reads the org's own `org_repos` / `org_environments` (`orgRepoConfig`,
  `src/tools/repo-agent.ts` — it may not import `src/integrations`, see `test/secrets.mcp.test.ts`); a bare
  `#214` resolves against the org's primary repo (`ticketLinkRepo`, `src/tools/tickets.ts`).

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
| `src/auth/tokens.ts` `resolveToken`; `src/auth/oauth.ts` `resolveOAuthAccessToken`, `exchangeAuthorizationCode`, `refreshAccessToken`, `revokeOAuthToken`, `grantRefusal` | credential lookup by HASH before any org is known (the row names the org), and the revoke of the one grant just found |
| `src/auth/oauth.ts` `listGrants`, `revokeGrant` | Connected apps is user-level: a person's own grants across their orgs, keyed by person |
| `src/artifacts/upload.ts` `uploadTokenOrg` | upload-token lookup by hash, returning only its `org_id` |
| `src/platform/usage.ts` (whole file); `src/platform/repo.ts` `listAudit` (`org_audit`) | the superadmin's cross-org counts and merged audit trail — no content, no secret |
| `src/orgs/repo.ts` `removeMember` | revokes the removed person's tokens / grants for that org, in the same batch |
| `src/auth/persons.ts` `renamePerson` (interpolated) | the `HANDLE_COLUMNS` update — a rename must span every org |
| `src/tools/artifacts.ts` `normalizeLinkRef` (interpolated, tenant) | `tickets` or `sprints` from a two-value literal, with `org_id = ?` |
| `src/tools/progress.ts` upsert on `sprint_progress` | its PK is `sprint_id` alone; guarded by `WHERE sprint_progress.org_id = excluded.org_id` (asserted) |

## Cut-over entry points (not shims — replaced in later phases)

`src/data/legacy.ts` keeps `legacySystemTenant(env, actor)` and `joinLegacyOrg(p, handle)`: the entry points
that cannot name their org yet act on SaplingLearn. Callers: `src/index.ts` (policy seed), `src/webhook.ts`,
`src/tools/backfill.ts`, `src/repo/cron.ts`, `src/notifications/cron.ts` (→ Phase 5b), `src/auth/routes.ts`
(onboarding → Phase 4). `resolveSoleTenant` / `soleTenantGate` are the route alias Phase 4 replaces.

## Tests

`test/helpers/tenant.ts`: `systemCtx(org?)`, `tenantCtx(handle, role?, { orgId, via, env })`,
`bearerCtx(handle, role?, env?, orgId?)`, `mintTokenFor(handle, orgId?)`, `credentialOf(request)`,
`platformCtx`, `ensureMember`, `ORG_A`, `ORG_B`. `test/isolation.mcp.test.ts` is the MCP matrix: its entries are
checked against the server's own registry, so a new tool needs an entry (what to call it with from the other org). Fixture SQL may use `env.DB` directly; the raw `first` / `all` /
`run` helpers for it live in `test/helpers/db.ts` (production has none). Each module has an isolation
assertion in `test/isolation.*.test.ts`: write through `systemCtx(ORG_B)`, read through `systemCtx()`, expect nothing.
