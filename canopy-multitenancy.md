# Canopy multitenancy — Phase 1 spec

Status: **DRAFT FOR APPROVAL. No implementation code is written until this is approved.**
Inputs: the locked decisions (D1–D13, restated in §1) and the Phase 0 audit `canopy-multitenancy-audit.md`
(cited as "audit §n" and conflicts as "C-n"). Baseline: `c836b8b`, 158 test files / 2,683 tests green.

Decisions that need the owner before Phase 2 starts are collected in **§12** — everything else here is
proposed as final.

---

## 1. Goals, locked decisions, non-goals

Goal: any team can create an org, invite members by GitHub username, and run Canopy with zero cross-tenant
visibility. SaplingLearn becomes org #1 with no loss of data, links, tokens or plugin config.

| # | Locked decision | Where it lands |
|---|---|---|
| D1 | Shared D1, `org_id` on every tenant-owned table | §2, §3 |
| D2 | `orgs`, `memberships` (owner/admin/member), `org_invites`, `org_repos` | §2.1 |
| D3 | GitHub OAuth + PKCE stays; membership is Canopy-native; SaplingLearn gate removed | §5.1 |
| D4 | Invite by GitHub username, accept in-app, no tokens in links | §5.3 |
| D5 | `/o/:slug/…` (SPA), `/api/o/:slug/…` (API), membership checked per request; bearer pinned to (user, org) | §5, §6, §7 |
| D6 | `/mcp` bearer-only, everything else cookie; confirm verbs never MCP | §6, §7 |
| D7 | All D1 access through a data layer taking `TenantContext { orgId, userId, role }`; test fails on stray `prepare` | §4 |
| D8 | Ledger key `(org_id, session_id, item_index)`; every hash/slug uniqueness includes `org_id` | §2.2, §8.1 |
| D9 | `org_id` UNINDEXED on every FTS table; every MATCH filters on it | §2.3, §8.2 |
| D10 | Webhooks routed via `org_repos`; no hardcoded SaplingLearn/sapling; identity mapping per org | §8.5, §9 |
| D11 | Cron + email iterate orgs; admin policy per org; user prefs win | §8.3, §8.4 |
| D12 | Artifacts served from a separate origin in a sandboxed iframe | §8.6 |
| D13 | Out of scope: billing, rename/domain, marketing site, GitHub App migration | — |

Also out of scope (proposed): per-org controlled vocabularies (sections/tags/sprint `domain`/artifact `area`
stay global — C-16), multi-repo dashboards (one primary repo per org — C-11), org deletion UI, SSO.

## 2. Final schema

### 2.1 New tables (platform)

```sql
CREATE TABLE orgs (
  id          TEXT PRIMARY KEY,                       -- 'org_' + 26-char base32 (random); legacy: 'org_saplinglearn'
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE
              CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 2 AND 39 AND slug NOT GLOB '*[^a-z0-9-]*'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES persons(handle)
);
-- Reserved slugs (api, o, auth, oauth, mcp, new, settings, admin, raw, img, avatar, u, webhook, static, assets)
-- are refused in code (shared/orgs.ts RESERVED_ORG_SLUGS), not by CHECK, so the list can grow without a rebuild.

CREATE TABLE memberships (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  user_id     TEXT NOT NULL REFERENCES persons(handle) COLLATE NOCASE,   -- the person handle IS the user id
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  title       TEXT,               -- was persons.role (0036) — per-org (C-8)
  responsibilities TEXT,          -- was persons.responsibilities (0036) — per-org (C-8)
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE org_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  github_login  TEXT COLLATE NOCASE,          -- D4
  email         TEXT,                         -- only if Q1 keeps Google invites; else column omitted
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  invited_by    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at    TEXT NOT NULL,
  responded_at  TEXT,
  responded_by  TEXT,
  CHECK ((github_login IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX idx_org_invites_pending_login ON org_invites(org_id, github_login) WHERE status = 'pending' AND github_login IS NOT NULL;
CREATE UNIQUE INDEX idx_org_invites_pending_email ON org_invites(org_id, email)        WHERE status = 'pending' AND email IS NOT NULL;
CREATE INDEX idx_org_invites_login ON org_invites(github_login, status);

CREATE TABLE org_repos (
  id               TEXT PRIMARY KEY,                -- 'hook_' + random; is also the webhook path id
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  repo_full_name   TEXT NOT NULL COLLATE NOCASE,    -- 'owner/repo'
  is_primary       INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  environments     TEXT NOT NULL DEFAULT '[]',      -- the old REPO_ENVIRONMENTS JSON, per repo
  legacy_hook      INTEGER NOT NULL DEFAULT 0,      -- 1 = also reachable via the old /webhook/github + env secret (cut-over only)
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  UNIQUE (org_id, repo_full_name)
);
CREATE UNIQUE INDEX idx_org_repos_primary ON org_repos(org_id) WHERE is_primary = 1;

CREATE TABLE org_secrets (                          -- per-org credentials (C-5); AES-GCM under env ORG_SECRETS_KEY
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  name       TEXT NOT NULL CHECK (name IN ('webhook_secret','github_service_token','cf_analytics_token',
                                           'cf_analytics_account_id','railway_token','app_metrics_token')),
  scope      TEXT NOT NULL DEFAULT '',              -- org_repos.id for webhook_secret; env key for railway_token; '' otherwise
  ciphertext TEXT NOT NULL,                         -- base64(iv || ct || tag); never returned by any route
  hint       TEXT NOT NULL,                         -- last 4 chars, for the settings UI
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (org_id, name, scope)
);

CREATE TABLE org_login_map (                        -- per-org ATTRIBUTION (C-1), never used for sign-in
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  github_login TEXT NOT NULL COLLATE NOCASE,
  person       TEXT NOT NULL REFERENCES persons(handle),
  mapped_at    TEXT NOT NULL,
  mapped_by    TEXT NOT NULL,
  PRIMARY KEY (org_id, github_login)
);

CREATE TABLE cron_cursor (                          -- round-robin over orgs for subrequest-bound jobs (C-7)
  job        TEXT PRIMARY KEY,                      -- 'usage' | 'reconcile' | 'progress'
  last_org   TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
```

`persons` loses nothing structurally; `role` / `responsibilities` are copied into `memberships.title /
responsibilities` and the person columns are left in place (unread) until the Phase 7 cleanup drops them.

### 2.2 Tenant tables — the org_id rule

Every T and UO table in audit §1 gets `org_id TEXT NOT NULL REFERENCES orgs(id)` as its first column after
the PK. Uniqueness changes exactly as audit §2. In addition, **in-org references become composite foreign
keys** so the database itself refuses a cross-org edge (D1 enforces foreign keys):

| Child | Composite FK | Parent needs |
|---|---|---|
| `doc_versions(org_id, slug)` | → `docs(org_id, slug)` | PK `(org_id, slug)` |
| `pr_summaries(org_id, repo, semantic_key)` | → `events(org_id, repo, semantic_key)` | UNIQUE of the same |
| `ticket_assignees / ticket_links / ticket_comments / ticket_events (org_id, ticket_id)` | → `tickets(org_id, id)` | `UNIQUE(org_id, id)` |
| `tickets(org_id, parent_id)` | → `tickets(org_id, id)` | same |
| `tickets(org_id, sprint_id)` | → `sprints(org_id, id)` (new; today a soft ref) | `UNIQUE(org_id, id)` |
| `sprint_resources / sprint_progress (org_id, sprint_id)` | → `sprints(org_id, id)` | same |
| `prompt_versions(org_id, slug)` | → `prompts(org_id, slug)` | PK `(org_id, slug)` |
| `artifact_versions / artifact_links / artifact_upload_tokens (org_id, page_id)` | → `artifact_pages(org_id, id)` | `UNIQUE(org_id, id)` |
| `memberships`-checked handle columns | (code check, §4.4) | — |

Columns added beyond `org_id` (C-11): `repo TEXT NOT NULL` on `events`, `repo_events`, `pr_summaries`,
`issue_summaries`, backfilled `'SaplingLearn/sapling'`; uniqueness becomes `(org_id, repo, …)`. Per-org
display numbers (only if Q2 = yes): `tickets.number`, `handoffs.number` with `UNIQUE(org_id, number)`,
backfilled `number = id` so SaplingLearn's `#12` stays `#12`.

UO tables: `mcp_tokens.org_id`, `oauth_grants.org_id`, `oauth_codes.org_id`, `notification_prefs.org_id`,
`notification_outbox.org_id` (+ key format `org:user:cadence:window`), `notification_outbox_bodies.org_id`.
`oauth_tokens` resolves through `grant_id` (no column; the grant pins the org). Global tables unchanged:
`persons`, `identities`, `sessions`, `oauth_clients`, `sections`, `tags`. `invites` is migrated into
`org_invites` (email rows, if Q1 keeps them) and dropped in Phase 7.

Singletons become per-org: `plan` PK `org_id` (drops `id`), `notification_settings` PK `org_id` (drops `id`;
`from_address` becomes `from_name` — the sending address is platform-level env `EMAIL_FROM`, because a
tenant cannot send from an unverified domain).

### 2.3 FTS tables

All seven are re-created with `org_id UNINDEXED` as the first column and re-populated from their base
tables in the same migration (`INSERT INTO x_fts SELECT …`). All 23 triggers are re-created to carry
`new.org_id` and to delete with `… AND org_id = old.org_id` (fixes audit F-1: `docs_fts`, `prompts_fts` by
slug and `roadmap_fts` `ref = 'plan'` would otherwise delete other orgs' rows). `roadmap_fts.ref` stays
`'plan'` / `'sprint:<id>'`, now unique per `(org_id, ref)`.

## 3. Migration plan

### 3.1 Files

| File | Content |
|---|---|
| `0037_orgs.sql` | §2.1 tables; `INSERT OR IGNORE` the SaplingLearn org (`org_saplinglearn`, slug `saplinglearn`); one `memberships` row per non-reserved person (role `member`, `title`/`responsibilities` copied), then `owner` for the handles in today's `ADMIN_LOGINS` (`andres`, `AndresL230` — a one-time data seed, commented as such); the SaplingLearn `org_repos` row (`SaplingLearn/sapling`, `is_primary = 1`, `legacy_hook = 1`, `environments` = today's `REPO_ENVIRONMENTS` value); `org_login_map` backfilled from every `identities` row with `provider = 'github'` (so existing attribution is unchanged); `cron_cursor` rows. |
| `0038_tenant_core.sql` | Rebuild (create `x_new` → copy with `org_id = 'org_saplinglearn'` → drop → rename, carrying `sqlite_sequence` like `0033:56`) of the knowledge/gate tables: `docs`, `doc_versions`, `feed`, `adrs`, `entry_tags`, `needs_triage`, `processed_items`, `identity_tasks`, `plan`, `plan_versions`, `sprints`, `sprint_progress`, `sprint_resources`, `tickets`, `ticket_*`, `handoffs`, `prompts`, `prompt_versions`. |
| `0039_tenant_capture.sql` | Same for `events`, `pr_summaries`, `issue_summaries`, `repo_events`, `repo_snapshots`, `repo_metrics`, `artifact_*`, `doc_images`, `doc_image_upload_tokens`, notifications, and the UO auth tables (`mcp_tokens`, `oauth_grants`, `oauth_codes`). |
| `0040_tenant_fts.sql` | Drop + re-create the seven FTS tables and 23 triggers; repopulate. |
| `0041_drop_org_defaults.sql` (Phase 7) | Rebuild to remove the transitional `DEFAULT 'org_saplinglearn'` (§3.2) and drop `persons.role/responsibilities`, `invites`. |

Every rebuild runs under `PRAGMA defer_foreign_keys = true` (the `0033` pattern) and ends with
`PRAGMA foreign_key_check` asserted empty by the migration test.

### 3.2 Why a transitional DEFAULT

Main deploys on merge. Between Phase 2 (schema) and Phase 3 (queries ported) the unported INSERTs do not
name `org_id`. So Phase 2 creates `org_id TEXT NOT NULL DEFAULT 'org_saplinglearn' REFERENCES orgs(id)`:
production keeps working as a single org, the suite stays green, and no unported write can produce a NULL.
Phase 3 adds the static test "every INSERT into a tenant table names `org_id`", after which the default is
dead; `0041` removes it so a missed column fails loudly rather than landing in SaplingLearn.

### 3.3 Idempotency

1. **Ledger** — wrangler's `d1_migrations` table never re-applies a recorded file.
2. **Atomic files** — each file is one D1 batch; a failure rolls the file back. *To verify in Phase 2*
   against a local D1 with an injected failing statement at the end of each file (test asserts the
   pre-migration schema dump is unchanged).
3. **Re-runnable statements** — `CREATE … IF NOT EXISTS`, `DROP TABLE IF EXISTS x_new` at the top of every
   rebuild (clears a half-done local attempt), `INSERT OR IGNORE` for every seed, deterministic ids for
   the seeded rows (`org_saplinglearn`, hook id derived from the repo name).
4. **Convergence test** — `test/migrations.multitenancy.test.ts` applies 0001–0036, loads the fixture
   corpus (and, locally, the production export), applies 0037–0040, dumps every table ordered by PK; a second
   fresh run must produce byte-identical dumps.

### 3.4 Verification against a local copy of production

`scripts/mt/verify-migration.mjs` (owner runs it; production data never leaves their machine or enters git):

```
wrangler d1 export canopy --remote --output .mt/prod.sql      # gitignored
node scripts/mt/verify-migration.mjs .mt/prod.sql
```

It loads the export into a local Miniflare D1, records per-table row counts and a content hash of every
non-org column, applies 0037–0040, then asserts: identical row counts; identical content hashes; every row
has `org_id = 'org_saplinglearn'`; FTS row counts equal their base tables'; every pre-migration MATCH in a
fixed query list returns the same ids; `PRAGMA integrity_check` = ok; `PRAGMA foreign_key_check` empty;
`sqlite_sequence` per table ≥ its pre-migration value; every existing `mcp_tokens` / `oauth_grants` row
resolves to `(same handle, org_saplinglearn)`.

### 3.5 Rollback plan

- **Before applying remotely:** `wrangler d1 export canopy --remote` (file kept by the owner) and note the
  D1 Time Travel bookmark (`wrangler d1 time-travel info canopy`).
- **Rollback = DB + code together**, because the schema change is not backward compatible with the old
  Worker: `wrangler d1 time-travel restore canopy --bookmark=<pre-migration>` then `wrangler rollback` to the
  pre-migration Worker version. Writes made after the migration are lost; the runbook says to apply during a
  quiet window and announce it.
- **Forward-fix fallback** (if Time Travel's window has passed): `migrations/rollback/0037-0040.down.sql`
  (outside `migrations/` so wrangler never applies it) rebuilds each table without `org_id`, keeping only
  `org_saplinglearn` rows; tested by the migration test (up → down → schema equals the 0036 dump).
- Phases 3–6 are code-only and roll back with `wrangler rollback`.

## 4. Data layer

### 4.1 Shape (the thin layer — recommended)

```ts
// src/data/context.ts — the ONLY module that sees D1Database.
const DB = Symbol("db");                                // not exported outside src/data
export type OrgRole = "owner" | "admin" | "member";
export interface TenantContext {
  readonly orgId: string; readonly userId: string; readonly role: OrgRole | "system";
  readonly [DB]: D1Database;
}
export interface PlatformContext { readonly [DB]: D1Database; readonly actor: string }

// Constructors — the only ways to get a TenantContext:
export async function resolveTenant(env: Env, userId: string, slug: string): Promise<TenantContext | null>;   // HTTP: slug + membership
export async function resolveBearerTenant(env: Env, token: string): Promise<TenantContext | null>;           // /mcp: token → (user, org) + live membership
export function systemTenant(p: PlatformContext, orgId: string, actor: "github-webhook" | "system"): TenantContext; // webhook/cron, role "system"
export function platform(env: Env, actor: string): PlatformContext;
```

```ts
// src/data/sql.ts — the query surface. Same ergonomics as today's src/db.ts.
export function first<T>(ctx: TenantContext, sql: string, ...params: unknown[]): Promise<T | null>;
export function all<T>(ctx: TenantContext, sql: string, ...params: unknown[]): Promise<T[]>;
export function run(ctx: TenantContext, sql: string, ...params: unknown[]): Promise<D1Result>;
export function stmt(ctx: TenantContext, sql: string, ...params: unknown[]): Stmt;      // for batch
export function batch(ctx: TenantContext, stmts: Stmt[]): Promise<D1Result[]>;
export function fanOut<R>(ctx: TenantContext, ids, sql, leading?): Promise<R[]>;       // org_id goes in `leading`
// …and the same five for PlatformContext under src/data/platform-sql.ts.
```

Repositories stay where they are (`src/tools/*`, `src/repo/*`, `src/notifications/*`, `src/auth/*`); each
function's first parameter changes from `db: DB` to `ctx: TenantContext` (or `p: PlatformContext` for the
global modules), and every statement gains its `org_id = ?` predicate / column. This satisfies D7 literally
(the only functions that can reach D1 take a required context; a TenantContext cannot be built without a
membership check or an explicit system scope) at roughly a third of the churn of moving 370 statements
into new repository modules. *Alternative:* a thick layer (all SQL moved into `src/data/tenant/*.ts`) —
cleaner boundary, much larger diff; not recommended for this project.

`TenantContext.role` adds `"system"` to D7's three roles: the webhook and the cron act ON an org with no
human member. `system` passes no human role gate (`requireRole(ctx, "admin")` refuses it); system-only
writers (`mirrorIssue`, capture, pollers) assert `ctx.role === "system"`.

### 4.2 Platform modules (no TenantContext — C-13)

`src/auth/persons.ts`, `identities`, `sessions.ts`, `tokens.ts` (lookup only), `oauth.ts`, new
`src/orgs/*.ts` (orgs, memberships, invites, org_repos, org_secrets), `cron` org enumeration, `/u/`
unsubscribe, `renamePerson` (it MUST span orgs — C-14; `HANDLE_COLUMNS` gains `memberships.user_id`,
`memberships.created_by`, `org_invites.invited_by/responded_by`, `org_login_map.person/mapped_by`,
`orgs.created_by`, `org_repos.created_by`, `org_secrets.updated_by`).

### 4.3 Conventions that the tests rely on

- A tenant predicate is written exactly `<alias.>org_id = ?` and bound from `ctx.orgId` (never a literal,
  never a value from the request). This is what the mutation check (§10.3) rewrites.
- Every lookup by a global surrogate id is `WHERE id = ? AND org_id = ?` — an id from another org reads as
  not-found, never as forbidden (no existence oracle; same rule as artifacts today).
- Every handle taken from input that must be a person in the org goes through
  `requireMember(ctx, handle)` (replaces `requirePerson`, `src/tools/tickets.ts:65`): unknown, reserved or
  non-member → the same `bad_request "no such person"`.

### 4.4 Enforcement tests (`test/data-layer.static.test.ts`)

Run over the source text with the same extractor the audit used (Appendix A method):
1. No `.prepare(`, `.batch(`, `.exec(`, `D1Database`, `env.DB` or `c.env.DB` outside `src/data/` (allowlist:
   none in `src/`; `test/` and `scripts/` excluded). Fails naming file:line.
2. Every SQL string outside `src/data/platform*` that names a tenant table contains `org_id` at least once
   per tenant-table reference (FROM/JOIN/INTO/UPDATE), and every `INSERT INTO <tenant table>` lists
   `org_id` in its column list.
3. Every SQL string in a platform module names no tenant table, except the declared allowlist
   (`renamePerson`'s `HANDLE_COLUMNS` update, the cron's `SELECT id FROM orgs`, `pruneRepoCapture` /
   `pruneOAuth` / `expireDueHandoffs` retention sweeps — these are deliberately cross-org and write-only).
4. The tenant-table list is derived from the live schema (`sqlite_master` after migrations: every table with
   an `org_id` column), so a new table is covered automatically.

## 5. Identity, membership, tenant resolution

### 5.1 Sign-in (C-2)

- `/auth/callback` drops `isActiveOrgMember` (`src/auth/routes.ts:102`); `SAPLING_ORG` and
  `isActiveOrgMember` are deleted (`src/auth/github.ts:3,60-68`).
- `completeSignIn` (`src/auth/onboard.ts:68`): known identity → session; verified-email match → link +
  session (unchanged); otherwise a GitHub user always reaches onboarding (handle + color). Google: per Q1.
- After sign-in the SPA lands on `/` which redirects to the last-used org (`canopy_org` cookie, a plain
  slug, not a credential) if the person is still a member, else to the org picker (`/orgs`): their orgs,
  their pending invites, "Create an org".
- `GET /auth/me` returns `{ handle, name, avatar_url, color, identities, orgs: [{ slug, name, role }] }`
  — `org` and `admin` are removed (`admin` becomes per-org, from `GET /api/o/:slug/me`).

### 5.2 Membership check on every request

`tenantGate` middleware on `/api/o/:slug/*`: session principal → `resolveTenant(env, handle, slug)` = one
statement `SELECT o.id, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE o.slug = ? AND
m.user_id = ? COLLATE NOCASE`. No row (unknown slug OR not a member) → **404 `{ error: "not_found" }`**
(never 403: an org's existence is not disclosed). Sets `c.var.ctx`. Role gates: `requireRole(ctx,
"admin")` (admin or owner), `requireRole(ctx, "owner")`. `isAdmin(env, …)` and `ADMIN_LOGINS` are deleted
(audit §9.1); every call site becomes a role check on `ctx`.

### 5.3 Orgs, invites, members (D2, D4)

- **Create**: `POST /api/orgs { slug, name }` — any signed-in person; creator becomes `owner`; seeds the
  org's `notification_policy` / `notification_settings` / `plan` rows. Cap: 10 orgs created per person
  (abuse bound; code constant).
- **Invite**: `POST /api/o/:slug/invites { github_login, role }` (admin+). Validates the login shape
  (`^[A-Za-z0-9-]{1,39}$`); does not call GitHub. No email is sent and no link carries a token.
- **Accept**: on every `/auth/me`, the person's GitHub identity labels are matched (NOCASE) against
  `org_invites.github_login WHERE status = 'pending'`; the org picker and a sidebar badge show them.
  `POST /api/invites/:id/accept` / `…/decline` (session cookie, platform route): re-checks that one of the
  caller's GitHub identities equals the invite's login, then inserts the membership and stamps the invite
  in one batch. Known limit, documented: a GitHub login can be renamed and re-registered, so an invite binds
  to whoever holds that login when they accept (GitHub numeric ids would fix this; the `identities` table
  stores logins today, so this is pre-existing and listed as a follow-up).
- **Members**: `GET /api/o/:slug/members` (any member: handle, name, avatar, role, title);
  `PUT /api/o/:slug/members/:handle { role?, title?, responsibilities? }` (admin+; only an owner may grant
  or revoke `owner`); `DELETE /api/o/:slug/members/:handle` (admin+, or self = leave). The last owner can
  neither leave nor be demoted (409). Removing a member: deletes the membership, revokes their `mcp_tokens`
  and `oauth_grants` for that org in the same batch, and leaves their authored content (handles stay as
  history, rendered plain once they are not a member).
- **Attribution map** (C-1): Maintenance › Identity writes `org_login_map`, never `identities`
  (`src/tools/writes.ts:214` loses its `linkIdentity` call). `resolvePersonForLogin(ctx, login)` reads
  `org_login_map` first, then falls back to the global GitHub identity **only if that person is a member of
  the org** (so a member's own sign-in identity attributes their PRs without a manual map).

## 6. Route map

`P` = public, `U` = session (user-level), `T` = session + membership (`tenantGate`), `TA` = + admin,
`TO` = + owner, `B` = bearer, `H` = HMAC/token.

### 6.1 Unchanged paths (global)

`/auth/*` (U/P — minus the org gate; mcp-token and oauth-grant routes become org-aware, below),
`/.well-known/*`, `/oauth/*` (P; consent gains an org picker, §7.1), `/mcp` (B), `/u/:token` (H),
`PUT /api/artifacts/upload/:token`, `GET /api/artifacts/download/:token` (H — tokens now carry `org_id`),
`GET /avatar/:sha` (U).

### 6.2 New platform routes (U)

| Route | Purpose |
|---|---|
| `GET /api/orgs` | my memberships |
| `POST /api/orgs` | create org |
| `GET /api/invites` | my pending invites (matched by my GitHub logins) |
| `POST /api/invites/:id/accept` · `/decline` | respond |

### 6.3 Tenant routes — every existing session route moves under `/api/o/:slug`

The path suffix is kept verbatim so the SPA change is one prefix in `web/src/api.ts`:

| Old (audit §4) | New | Gate |
|---|---|---|
| `/ingest`, `/docs`, `/doc/:slug`, `/feed`, `/feed/stats`, `/search`, `/search/quick`, `/needs-triage`, `/adrs`, `/proposals`, `/roadmap`, `/me/dashboard`, `/repo/dashboard`, `/tickets…` (14), `/sprints…` (7), `/api/handoffs…` (5), `/api/prompts…` (10), `/api/docs/propose`, `/persons`, `/api/people/:handle` (GET) | `/api/o/:slug/<same suffix>` (the `/api/` prefix of handoffs/prompts/people/docs is dropped: `/api/o/:slug/handoffs`, …) | T |
| `/doc/:slug/promote`, `/doc/:slug/reject`, `/adr/:id/ratify`, `/adr/:id/reject`, `…/artifacts/:slug/ratify`, `…/prompts/:slug/publish` | same prefix rule | T — **confirm verbs: cookie only, refuse `Authorization`** (D6; ratify already does, the others gain it) |
| `/needs-triage/:id/discard|assign`, `/identity-tasks…` (4) | prefix | T (`/identity-tasks/:login/map` becomes TA) |
| `PUT /api/people/:handle` | `PUT /api/o/:slug/members/:handle` | TA |
| `/invites…` (4) | `/api/o/:slug/invites…` (by GitHub login) | TA |
| `/admin/backfill`, `/admin/poll`, `/admin/poll-usage` | `/api/o/:slug/admin/…` | TA |
| `/api/notifications/prefs` | `/api/o/:slug/notifications/prefs` | T (own row) |
| `/api/notifications/{policy,settings,outbox,persons/:h,preview,test-send}` | `/api/o/:slug/notifications/…` | TA |
| `/api/artifacts/*` (14) | `/api/o/:slug/artifacts/*` | T (delete/restore: author or admin+) |
| `/img/:sha` | `/api/o/:slug/img/:sha` | T (row must be in the org — C-10) |
| `/raw/a/*` | removed from the app origin → artifact origin (§8.6) | H |
| `POST /auth/mcp-token`, `GET /auth/mcp-tokens`, `POST …/:id/revoke` | `/api/o/:slug/mcp-tokens…` | T (own tokens, this org) |
| `GET /auth/oauth-grants`, `POST …/:id/revoke` | stay at `/auth/…`, each row now shows its org | U |
| — new — | `GET /api/o/:slug/me` (role, title), `GET/PUT /api/o/:slug/settings` (name), `GET/POST/DELETE /api/o/:slug/repos` (+ `environments`), `PUT/DELETE /api/o/:slug/secrets/:name[/:scope]` (write-only; GET returns names + hints) | T / TA / TO for secrets |

**Compatibility during the cut-over (Phases 3–5):** each old path stays mounted as an alias that resolves
the tenant as "the caller's only org" (`resolveTenant` with the person's single membership; a person with
≠ 1 membership gets 409 `{ error: "org_required" }`). Production keeps working on the old SPA. Phase 6
switches the SPA; Phase 7 deletes the aliases.

## 7. MCP

### 7.1 Org-scoped bearer tokens (D5, C-4)

- `mcp_tokens.org_id NOT NULL`; minted from `/api/o/:slug/mcp-tokens`. Existing tokens backfilled to
  SaplingLearn — the plugin config (`<origin>/mcp`, no org in it) does not change.
- OAuth: `oauth_grants.org_id NOT NULL`. `/oauth/authorize`'s consent page lists the person's orgs (radio;
  preselected and hidden when there is one); the POST carries the chosen org, re-checked against
  `memberships`; `issueAuthorization` (`src/auth/oauth.ts:195`) writes it on the grant and code. Refresh
  rotation keeps the grant, so the org is stable for the life of the connection. Settings › Connected apps
  shows each grant's org.
- `resolveBearerTenant` resolves the token AND joins `memberships` in one statement: a token whose holder is
  no longer a member is treated as invalid (`401 invalid_token`), even before revocation.

### 7.2 Per-request server bound to (user, org)

`buildCanopyMcpServer(ctx: TenantContext, env)` (`src/mcp.ts:84`) — every tool closes over `ctx`, none
over `env.DB`. `update_plan` registers when `ctx.role` is admin/owner (`src/mcp.ts:641`). The lane rule's
admin exceptions (`tickets-agent.ts:91,122`) read `ctx.role`. `list_people` returns members of `ctx.orgId`
with `title`/`responsibilities` from `memberships`. `get_repo_dashboard` reads the org's primary repo.
Artifact and handoff URLs are built as `<origin>/o/<slug>/#…`. The 42-tool surface is otherwise unchanged
and no confirm verb is added (D6).

## 8. Gate, FTS, cron, email, webhooks, artifacts

### 8.1 Gate (`src/consumer.ts`)

`consume(ctx, …)` and every `ingest*` take the ctx. Ledger read/write (`consumer.ts:65,81`;
`handoffs.ts:105,136`) key on `(org_id, session_id, item_index)`. Content-hash dedupe reads
`doc_versions WHERE org_id = ? AND slug = ? AND content_hash = ?` and `adrs WHERE org_id = ? AND
content_hash = ?`. Vocabulary stays global. `docImageProblems` requires `doc_images` rows in `ctx.orgId`.
The author rule is unchanged (author = `ctx.userId`). `artifact_links` in a batch validate the target in
`ctx.orgId`.

### 8.2 FTS (`src/tools/reads.ts`, `src/tools/quick-search.ts`, `src/tools/artifacts.ts`, `src/tools/prompts.ts`)

Every MATCH statement gets `AND <fts>.org_id = ?` in the same `WHERE` that carries the `LIMIT` (audit F-2).
The bm25 statistics side channel (F-3) is accepted and documented under D9.

### 8.3 Cron (C-7)

`handleRepoCron` keeps its tick schedule; per tick:
- **D1-only jobs run for every org** in one invocation: `expireDueHandoffs` (already a single global
  UPDATE — stays global, it is retention), `pruneRepoCapture`, `pruneOAuth` (global retention sweeps, on
  the platform allowlist §4.4).
- **Subrequest jobs take ONE org per invocation via `cron_cursor`**: health pings every tick for the next
  org that has environments; `:00` usage polls; `:10` progress; `:20` reconcile. Each reads that org's
  `org_repos` / `org_secrets` and runs exactly today's code path with `systemTenant(…, orgId, "system")`.
  An org with nothing configured is skipped without spending a slot. With N configured orgs each org is
  reached every N slots: hourly polls become every N hours, reconcile every 6N hours. The org's own
  "Poll now" / Sync GitHub (TA routes) are unaffected.
- This is correct but degrades past a handful of configured orgs — see Q4 (Workers Paid raises the
  subrequest cap; Queues is a deferred seam per `CLAUDE.md`).

### 8.4 Email (D11)

- `handleNotificationCron` iterates orgs: for each org, its `notification_settings` (send hour, timezone)
  decides whether this hour is due; `runDigest(ctx, cadence)` selects that org's MEMBERS with an address
  (`JOIN memberships`), resolves cadence with the existing order (user pref for `(org, user, kind)` →
  org policy → registry default), renders with `ctx`, and writes the outbox with key
  `org:user:cadence:window`. One digest per (person, org); subject `"<Org name> — Canopy digest"`.
- `ensureNotificationPolicySeeded` becomes "seed on org creation" (and a one-off per existing org in 0037);
  the per-isolate call in `src/index.ts:19,62` is removed.
- Unsubscribe stays global (`persons.email_unsubscribed`, one click stops all Canopy mail) — Q8.
- `from_address` → platform env `EMAIL_FROM`; per-org `from_name` only.

### 8.5 Webhooks (D10, C-6)

- New URL **`POST /webhook/github/:hook_id`** (`hook_id` = `org_repos.id`). Order: look up the row (unknown →
  bare 401, same as a bad signature, so ids are not probeable), HMAC-verify the raw body with that row's
  `webhook_secret` from `org_secrets`, then require `repository.full_name` (NOCASE) to equal the row's
  `repo_full_name` (else 202 ignored). Only then build `systemTenant(…, row.org_id, "github-webhook")` and run
  today's handler unchanged in shape (`ingestEvent`, `progressSeam`, `mirrorIssue`, `ingestRepoEvent`,
  `metricsFromStatus`, `fillFailedJob`, `refreshDrift`).
- Non-primary repos: events are captured with their `repo`; the mirror, progress and dashboard read the
  primary repo only.
- **Legacy** `POST /webhook/github` (env `GITHUB_WEBHOOK_SECRET`) routes to the `org_repos` row with
  `legacy_hook = 1` until the owner re-points SaplingLearn's GitHub webhook at the new URL; Phase 7 deletes
  the route, the env secret and the flag.
- The settings UI (Phase 6) shows each repo's webhook URL and lets an admin rotate its secret (shown ONCE
  at creation/rotation, never again).
- Unmapped logins raise `identity_tasks` per org; `ticket-mirror` requester/assignees resolve through the
  per-org map.

### 8.6 Artifacts on a separate origin (D12, C-12)

- New var `ARTIFACT_ORIGIN` (e.g. `https://canopyusercontent.com`, a second custom domain on the SAME
  Worker). `src/index.ts` routes by `Host`: on the artifact host ONLY `GET /r/:token` is served (everything
  else 404, no cookies read or set); on the app host `/raw/*` is removed.
- The app's artifact detail DTO carries `raw_url = <ARTIFACT_ORIGIN>/r/<token>`, token = HMAC over
  `{org_id, page_id, version, viewer, exp}` (5 minutes, key derived from `COOKIE_SECRET` with its own
  purpose label — the download-token pattern, `src/artifacts/download.ts`). Visibility is re-checked at
  serve time. Headers unchanged from `raw.ts` (active CSP + `sandbox allow-scripts`, `nosniff`); the SPA
  iframe keeps `sandbox="allow-scripts"`, never `allow-same-origin`, and `frame-ancestors` names the app
  origin. This is a short-lived read capability, not an action token in a link (D4's principle is about
  action links).
- Owner prerequisite: provision the domain + route. Until it exists, the app keeps serving `/raw/a/*` from
  its own origin behind `tenantGate` (today's opaque-origin sandbox) — Q5.

## 9. Hardcoded references (D10) — disposition

Every item in audit §9 is resolved as: **org data** (`GITHUB_REPO`, `REPO_ENVIRONMENTS` → `org_repos`;
`GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`,
`SAPLING_METRICS_TOKEN` → `org_secrets`; `ADMIN_LOGINS` → `memberships.role`), **parameter** (
`parseTicketLink(raw, repo)` loses its default — callers pass the org's primary repo; `DEFAULT_TICKET_REPO`
deleted; SPA `REPO_URL` / `ARTIFACT_REPOS` / handoff default repo come from `GET /api/o/:slug/me`'s
`repos`), **deleted** (`SAPLING_ORG`, `isActiveOrgMember`, the env fallbacks after cut-over), or **copy**
(landing/denied/guide/invite text rewritten without "Sapling team"). `PUBLIC_ORIGIN` stays a platform var.
`pollSaplingMetrics` is renamed `pollAppMetrics` (the contract is generic; the `sap_` metric prefix stays —
renaming stored metrics is a data migration with no user value). `src/repo/product.ts`'s registry stays as a
labelling table for known keys.

## 10. Testing

### 10.1 Throughout

`npm test` + `npm run typecheck` green at every phase boundary. `scripts/seed/reset.mjs` seeds two orgs
(SaplingLearn = the existing six persons + content; `org_b` with its own two persons) so every existing
test runs in org A unchanged and the isolation suite has a ready neighbour. Existing tests change only in
how they obtain a context (`helpers/tenant.ts`).

### 10.2 Cross-tenant isolation matrix (`test/isolation/*.test.ts`)

- **Fixture**: org A with one row of EVERY tenant table (doc + staged version, feed, ADR draft + ratified,
  triage item, identity task, event + PR summary + issue summary, plan + version, sprint + resource +
  progress, ticket + assignee/link/comment/event + sub-ticket, handoff, prompt + versions, artifact
  text + binary + link + upload token, doc image, repo event/snapshot/metric, notification policy/settings/
  prefs/outbox, MCP token, OAuth grant). Every text field carries a canary `CANARY_A_<table>_<n>`.
  Org B: member `bob`, plus content of its own.
- **Matrix rows are generated from the registries**, not hand-listed: every route in the Hono app
  (`app.routes`) and every tool registered on `buildCanopyMcpServer` (`server._registeredTools`). A test
  fails if a route/tool has no matrix entry (so a new endpoint cannot ship untested).
- **Per entry**, as `bob` (cookie, B's slug; and bearer bound to B): call it with A's ids/slugs/handles/
  shas (and, separately, call A's slug path). Assert:
  1. **Read / search**: status is 404 or the body is B-only; the raw response text contains no
     `CANARY_A`.
  2. **Stage / confirm / mutate**: a digest of every org-A row (`SELECT * … WHERE org_id = 'A' ORDER BY
     pk`, hashed per table) is identical before and after; `processed_items`, FTS tables and R2 keys likewise.
  3. **Cross-org edges**: linking B's ticket to A's sprint/parent/artifact, assigning an A-only handle,
     sending a handoff to an A-only handle, embedding A's image sha — refused and no row written in B either.
- **Non-session surfaces**: webhook delivered to A's hook with B's secret → 401, no rows; B's hook with a
  payload naming A's repo → ignored; upload/download/artifact-origin tokens minted in A used by bob → 404;
  B's bearer never sees A in `query` / `get_my_work` / `list_people`; cron/email runs produce no A rows in
  B's outbox and no A content in B's digest bodies (`notification_outbox_bodies`).
- **Membership lifecycle**: removed member's cookie → 404 on the org, bearer → 401; pending invite does
  not grant access; declined/revoked invite cannot be accepted; last owner cannot leave.

### 10.3 Mutation check (`scripts/mt/mutate.mjs`, CI job `isolation-mutation`)

For a deterministic sample (seeded by the commit SHA; default 30 statements, at least one per tenant table
that has a read path), rewrite ONE `<alias.>org_id = ?` predicate in the source to
`(<alias.>org_id = <alias.>org_id OR ? IS NULL)` — the org filter becomes a tautology while the bound
parameter count is unchanged (so a red result means a leak was caught, not a bind error) — run the
isolation suite, and require it to FAIL. A mutant that survives fails the job and names the statement.
`--all` runs every predicate (nightly / before Phase 7 sign-off). Inserts are mutated by replacing the bound
`ctx.orgId` with the other org's id in the data helper for that one call site.

### 10.4 CI (`.github/workflows/ci.yml`)

On every push and PR: Node 22, `npm ci`, `npm run typecheck`, `npm test`, `npm run build:web`; second job:
the mutation sample. No secrets needed (the suite is hermetic). Note: pushing a workflow file can require
the `workflows` permission on the pushing token; if the push is refused, the owner adds the file.

## 11. Phase plan

Each phase is one PR to `main` (which deploys), must leave production working for SaplingLearn, and adds
its lines to `web/src/releases.ts` per `CLAUDE.md`.

| Phase | Scope | Exit criteria | Prod-safe because |
|---|---|---|---|
| **2 · Schema + migration** | 0037–0040; reset seed with two orgs; migration tests (§3.3, §3.4 script); rollback script + test | suite green; convergence test; up→down test; owner runs `verify-migration` on the prod export and it passes | transitional DEFAULT; queries unchanged still hit SaplingLearn |
| **3 · TenantContext + data layer** | `src/data/*`; port every repository to `ctx`/`PlatformContext`; add `org_id` predicates; static enforcement tests (§4.4) | suite green; static tests green; zero `prepare` outside `src/data` | routes still pass a SaplingLearn ctx via the alias resolver |
| **4 · HTTP routes + membership** | `tenantGate`, `/api/o/:slug/*`, org/member/invite routes, role gates replace `isAdmin`; compat aliases; sign-in gate removed | suite green; route-level isolation tests for HTTP | old SPA uses aliases; SaplingLearn members all have exactly one org |
| **5a · MCP** | org-scoped tokens + OAuth org picker; server bound to ctx | MCP isolation tests | existing tokens backfilled to SaplingLearn |
| **5b · Gate, FTS, cron, email, webhooks** | §8.1–8.5; `org_repos`/`org_secrets` + secret routes; legacy hook | remaining isolation rows; cron/email multi-org tests | owner seeds SaplingLearn secrets via the TA routes BEFORE the env fallback is removed (runbook) |
| **6 · SPA** | `/o/:slug/` + hash routing (the Worker answers `GET /o/*` with `env.ASSETS.fetch("/index.html")` — no reliance on assets SPA-mode semantics); org switcher; create-org; invite + accept; members page with roles; org settings (repos, webhook URL, secrets); copy without "Sapling" | render tests; Playwright smoke | deploy flips the SPA to the new paths |
| **7 · Isolation suite + CI + cleanup** | full matrix generated from registries; mutation job; CI workflow; `0041` drops defaults/legacy columns; delete aliases, legacy webhook, env fallbacks; artifact origin (if Q5 provisioned) | matrix covers 100% routes/tools; mutation sample all killed; `--all` run clean | — |

The isolation suite grows from Phase 4 onward (each phase adds its rows); Phase 7 makes it exhaustive and
CI-enforced. The CI workflow itself can land in Phase 2 so every later phase runs under it — recommended.

## 12. Decisions needed before Phase 2 (owner)

1. **Q1 — Google sign-in.** (a) *Recommended:* keep Google; `org_invites` accepts a GitHub login OR an email,
   so non-engineers can still be invited; (b) literal D4: invites by GitHub login only, Google becomes
   link-only for existing persons and new Google-only people cannot join.
2. **Q2 — Per-org ticket/handoff numbers.** (a) *Recommended:* add `number` per org (SaplingLearn keeps its
   numbers; new orgs start at #1; no cross-tenant volume leak); (b) keep global ids.
3. **Q3 — SaplingLearn backfill.** Every existing non-reserved person becomes a member; `andres` (and
   `AndresL230` if it still exists) owner; nobody else admin. Confirm, or list other admins.
4. **Q4 — Cron scale.** (a) *Recommended for now:* round-robin cursor on the free plan (fine for a few
   configured orgs); (b) move to Workers Paid and keep per-org cadence; (c) activate Queues (overrides the
   `CLAUDE.md` deferred-seam rule).
5. **Q5 — Artifact origin.** Provide a domain for `ARTIFACT_ORIGIN` (e.g. `canopyusercontent.com`). Until
   then raw content stays on the app origin behind the existing opaque-origin sandbox.
6. **Q6 — Who may create an org.** *Recommended:* any signed-in GitHub user, capped at 10 orgs per person.
7. **Q7 — Shipping.** *Recommended:* phase-by-phase to `main` with compat aliases (above). Alternative: a
   long-lived integration branch merged once (bigger single cut-over, no aliases).
8. **Q8 — Email.** Global one-click unsubscribe (recommended) vs per-org; sending address platform-level
   (`EMAIL_FROM`), orgs set only a display name.
9. **Q9 — `title`/`responsibilities`** move from `persons` to `memberships` (C-8). Confirm.
10. **Q10 — Repos.** Many `org_repos` per org for webhook capture, ONE primary repo drives the dashboard,
    mirror and progress. Confirm.

## 13. Risks

- **Rebuild of ~41 tables and 7 FTS indexes in production** — mitigated by the export + Time Travel bookmark, the local
  verification run, atomic files, and a quiet-window deploy.
- **A missed predicate** — mitigated three ways: static test, composite FKs for edges, runtime matrix +
  mutation sampling.
- **Login rename/reuse on GitHub** binds an invite to the current holder (pre-existing identity model;
  follow-up: store GitHub numeric ids).
- **Cron fairness** past a few orgs (Q4).
- **Secrets in D1** — encrypted under one Worker secret; rotation of `ORG_SECRETS_KEY` needs a re-encrypt
  script (follow-up), and the key's loss loses every org's credentials (recoverable by re-entry).
- **bm25 side channel** (audit F-3) — accepted.
