# Data layer — tenant and platform contexts

Spec: `canopy-multitenancy.md` §4–§6. Code: `src/data/`, `src/routes.ts`. Phases 3 and 4 are complete: every statement in `src/` runs
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
  `src/routes.ts`, and meters the request — a sub-app never applies it again. See "Routes and gates" below.
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
| `src/auth/tokens.ts`, `src/auth/oauth.ts` (`mcp_tokens`, `oauth_grants`, `oauth_codes`) | credential lookup by hash before any org is known; person-level token management until Phase 5a |
| `src/artifacts/upload.ts` `uploadTokenOrg` | upload-token lookup by hash, returning only its `org_id` |
| `src/platform/usage.ts` (whole file); `src/platform/repo.ts` `listAudit` (`org_audit`) | the superadmin's cross-org counts and merged audit trail — no content, no secret |
| `src/orgs/repo.ts` `removeMember` | revokes the removed person's tokens / grants for that org, in the same batch |
| `src/auth/persons.ts` `renamePerson` (interpolated) | the `HANDLE_COLUMNS` update — a rename must span every org |
| `src/tools/artifacts.ts` `normalizeLinkRef` (interpolated, tenant) | `tickets` or `sprints` from a two-value literal, with `org_id = ?` |
| `src/tools/progress.ts` upsert on `sprint_progress` | its PK is `sprint_id` alone; guarded by `WHERE sprint_progress.org_id = excluded.org_id` (asserted) |

## Routes and gates (Phase 4 — spec §5, §6)

Every session request passes `sessionGate`, then exactly one of three things (`src/routes.ts`, `src/data/gate.ts`):

| Path | Gate | Tenant |
|---|---|---|
| `/api/o/:slug/*` | `tenantGate` | the org the path names, if the caller is a member — else 404 `{ error: "not_found" }` (unknown slug, non-member, suspended: all alike) |
| `/auth/*`, `/avatar/*`, `/api/orgs`, `/api/invites`, `/api/platform/*` | none (person-level) | none: these read and write the caller's own person, or are `requireSuperadmin` |
| every OTHER path | `soleTenantGate` (the cut-over alias) | the caller's ONE org — 409 `{ error: "org_required" }` with none or several, 404 if it is suspended |

`soleTenantGate` is the DEFAULT, so a route added without thought is tenant-gated, never open.

- **Defined once, mounted twice.** A tenant route is registered on `tenantRoot` (its suffix is its old path:
  `/docs`) or `tenantApi` (its old path had an `/api/`: `/handoffs` ↔ `/api/handoffs`), and both sub-apps are
  mounted under `/api/o/:org` and at the old prefix. A handler reads `c.var.ctx`, never the path. The org
  segment is `:org` on those mounts because many routes have a `:slug` of their own; `tenantGate` reads its
  own `:slug`. A sub-app mounted at `/` takes no `use("*")`.
- **Alias-only** (`legacyOnly`): `/invites…` (→ `/api/o/:slug/invites…`), `PUT /api/people/:handle`
  (→ `PUT /api/o/:slug/members/:handle`), and `/raw/a/*` (→ the artifact origin, §8.6). Phase 7 deletes the
  aliases and `soleTenantGate`.
- **Roles** (§5.2): admin means `hasRole(ctx, "admin")` (admin or owner of the request's org) — in the repository
  (`requireRole` → `RoleError` → 403 `forbidden`) or, on a route whose 403 body predates roles, `adminGate`
  (403 `{ error: "admin only" }`). `ADMIN_LOGINS` / `isAdmin` grant nothing on a session route; ONE reader is
  left — the MCP `update_plan` registration in `src/mcp.ts` (Phase 5a).
- **Confirm verbs** (D6) — promote / reject a doc, ratify / reject an ADR, publish a prompt, ratify an artifact —
  and the whole org surface refuse a request that carries an `Authorization` header (`cookieOnly`).
- **Org #1 only, for now** (`isLegacyOrg`, each marked `MT:`): `POST …/admin/{backfill,poll,poll-usage}` answer
  503 for any other org (what they call acts on SaplingLearn until Phase 5b), and the Repo dashboard gives another
  org its own primary repo with no environment config.

### People, invites, attribution

- **Sign-in** (§5.1, `src/auth/onboard.ts`): no GitHub org is checked. A known identity signs in; a new identity
  whose provider-VERIFIED email is another identity's `verified_email` is linked to that person (never
  `persons.email`, which is an editable notification address); otherwise GitHub always reaches onboarding and
  Google only with a pending invite for its verified email. `identities.verified_email` is written at every
  sign-in; `identities.provider_uid` (0045) pins a GitHub identity to the account's numeric id, and a sign-in
  with the same login but another id is refused.
- **Onboarding creates a person, never a membership** — a new person accepts an invite (`/api/invites`) or creates
  an org (`/api/orgs`). The ONE exception: a live legacy invite for their verified email is consumed as a
  SaplingLearn membership (`consumeLegacyInvite`), and only then is the welcome mail sent.
- **The legacy `/invites…` routes** (`src/orgs/legacy-invites.ts`) are a view of the caller's org's EMAIL
  `org_invites` rows in the old `InviteRow` shape. The invitee's name and the mail's delivery outcome stay in the
  global `invites` table, read and written for org #1 only; for any other org they are null.
- **Attribution** (C-1): Maintenance › Identity's map writes `org_login_map` (admin+), never `identities`.
  `resolvePersonForLogin(ctx, login)` / `memberGithubLogins` read the map first, then a MEMBER's own GitHub identity.
- **`persons.email`**: the person sets their own (`PUT …/notifications/prefs`); an org admin may set it only for a
  member who is in NO other org (`PUT …/notifications/persons/:handle` — 404 for a non-member, 409 otherwise).

## Cut-over entry points (not shims — replaced in later phases)

`src/data/legacy.ts` is the only file that names org #1. It keeps `legacySystemTenant(env, actor)` (the entry
points that cannot name their org yet), `isLegacyOrg(ctx)` (what is still org #1's alone) and the legacy-invite
rule (`liveLegacyInvite`, `consumeLegacyInvite`). Callers, each marked `// MT:` and listed in the static test:
`src/index.ts` (policy seed), `src/webhook.ts`, `src/tools/backfill.ts`, `src/repo/cron.ts`,
`src/notifications/cron.ts` (→ Phase 5b); `src/routes.ts` (Sync / Poll / dashboard config → 5b);
`src/auth/routes.ts`, `src/auth/onboard.ts`, `src/orgs/legacy-invites.ts`, `src/notifications/invite.ts` (the
legacy invite table and the welcome mail → Phase 7 / 5b). `resolveSoleTenant` / `soleTenantGate` stay until
Phase 7 deletes the aliases.

## Tests

`test/helpers/tenant.ts`: `systemCtx(org?)`, `tenantCtx(handle, role?, { orgId, via, env })`, `bearerCtx`,
`platformCtx`, `ensureMember`, `ORG_A`, `ORG_B`. Fixture SQL may use `env.DB` directly; the raw `first` / `all` /
`run` helpers for it live in `test/helpers/db.ts` (production has none). Each module has an isolation
assertion in `test/isolation.*.test.ts`: write through `systemCtx(ORG_B)`, read through `systemCtx()`, expect nothing.

`test/isolation.http.test.ts` is the route-level matrix (§10.2), generated from the Hono route registry: a route
registered on the app with no entry in `TENANT` / `LEGACY_ONLY` / `PLATFORM` fails the suite. Add the entry — a
body that would succeed against org A — with the route. `seedPerson("admin-user")` is the suite's org ADMIN
(`FIXTURE_ADMIN`); `AndresL230` is SaplingLearn's owner; `seedPerson(h, { email, verified: true })` records the
address as provider-verified. Role gates: `test/role-gates.http.test.ts`; sign-in: `test/signin.multitenant.test.ts`.
