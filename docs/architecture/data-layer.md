# Data layer — how to port a module (Multitenancy Phase 3)

Spec: `canopy-multitenancy.md` §4. The scaffolding is in `src/data/`; every entry point already builds a
context and calls the unported repositories with `legacyDb(ctx)`. Porting a module removes that wrapper.

## The two contexts

| | Type | Built by | Query surface |
|---|---|---|---|
| Tenant data (any table with `org_id`) | `TenantContext { orgId, userId, role, via }` | `resolveTenant`, `resolveSoleTenant` (cut-over alias), `resolveBearerTenant` (`src/data/bearer.ts`), `systemTenant` | `src/data/sql.ts` |
| Global tables (`persons`, `identities`, `sessions`, `invites`, `oauth_clients`, `oauth_tokens`, `orgs`, `memberships`, `org_*`, `platform_admins`) and the §4.2 platform modules (`src/auth/*`; token / grant lookup by hash is platform even though `mcp_tokens`, `oauth_grants`, `oauth_codes` carry `org_id`) | `PlatformContext { actor }` | `platform(env, actor)` | `src/data/platform-sql.ts` |

Where a context comes from today: `c.var.ctx` / `c.var.p` on every session route (`src/data/gate.ts`, mounted
in `src/routes.ts`; `/auth/*` and `/avatar/*` have only `p`); `ctx` in `buildTrovMcpServer(env, ctx)`; and
`const ctx = legacySystemTenant(env, …)` at the top of the webhook, cron, backfill and upload handlers (marked
`// MT:` — a later phase replaces each with a real org lookup; do not move them).

## Porting one module

1. **Import** — replace `import { type DB, first, all, run, … } from "../db"` with
   `import { type TenantContext, first, all, run, stmt, batch, fanOut, nowIso, ph } from "../data/sql"`
   (or `type PlatformContext … from "../data/platform-sql"` for a global-table module). Same names, same
   argument order after the first.
2. **Signature** — `fn(db: DB, …)` → `fn(ctx: TenantContext, …)` (`p: PlatformContext` for a platform module).
   Keep every other parameter. A module that touches BOTH kinds takes the tenant ctx and receives the
   platform one as an extra parameter from its caller — never build a context inside a repository.
3. **Every statement names the org** (§4.3 — the mutation check and the static test match these shapes):
   - a read/update/delete predicate is written exactly `org_id = ?` or `<alias>.org_id = ?`, bound from
     `ctx.orgId` — never a literal, never a request value. One per tenant table the statement references,
     JOINed tables included (`JOIN ticket_links l ON l.ticket_id = t.id AND l.org_id = ?`);
   - every `INSERT INTO <tenant table>` lists `org_id` in its column list, bound from `ctx.orgId`;
   - a lookup by a global id is `WHERE id = ? AND org_id = ?` — another org's id reads as not found;
   - an upsert target names the org key (`ON CONFLICT(org_id, …)`); FTS tables carry `org_id` LAST and every
     `MATCH` statement adds `AND <fts>.org_id = ?` in the `WHERE` that carries the `LIMIT` (§8.2);
   - `fanOut(ctx, ids, (ph) => \`… WHERE org_id = ? AND id IN (${ph})\`, [ctx.orgId])` — the org goes in `leading`.
4. **Batches** — `db.prepare(sql).bind(a, b)` → `stmt(ctx, sql, a, b)`; `db.batch([...])` → `batch(ctx, [...])`.
   A one-off `db.prepare(…).bind(…).all()/.first()/.run()` becomes `all` / `first` / `run`.
5. **`LEGACY_ORG_ID`** — replace each use with `ctx.orgId`. `src/legacy-org.ts` is deleted when none is left
   outside `src/data/legacy.ts`.
6. **Call sites** — `fn(legacyDb(c.var.ctx), …)` → `fn(c.var.ctx, …)`, `fn(legacyDb(ctx), …)` → `fn(ctx, …)`,
   `fn(legacyDb(c.var.p), …)` → `fn(c.var.p, …)`. If you decide a function is platform-level but its caller
   passes the tenant ctx (or the reverse), switch the argument — both are in scope on every session route.
   A ported module that calls an UNPORTED one passes `legacyDb(ctx)` itself (import from `../data/legacy`).
   Drop the `legacyDb` import from a file once it has no use left.
7. **Never** call `.prepare(` / `.batch(` / `env.DB` or name `D1Database` outside `src/data/` (§4.4), and do
   not import `d1Of`.

## Tests

`test/helpers/tenant.ts`:

```ts
import { systemCtx, tenantCtx, bearerCtx, platformCtx, ensureMember, ORG_A, ORG_B } from "./helpers/tenant";

await list_docs(systemCtx());                 // was list_docs(env.DB) — a system ctx on SaplingLearn, no write
await create_ticket(await tenantCtx("meilin"), …);            // a real member, via "session"
await tenantCtx("meilin", "admin");           // …with a role (creates the person / membership if missing)
buildTrovMcpServer(env, await bearerCtx(h));  // the /mcp context, via "bearer"
await getPerson(platformCtx(), "meilin");     // a platform module
systemCtx(ORG_B)                              // the neighbour org, for an isolation assertion
```

- `seedPerson` / `cookieFor` (`test/helpers/persons.ts`) add the SaplingLearn membership; `{ member: false }`
  makes a person in no org (their tenant routes answer 409 `org_required`).
- Fixture SQL run straight on `env.DB` (`INSERT INTO docs …`) keeps working through the transitional
  `org_id` DEFAULT; leave it unless the test asserts on another org.
- Each ported module should gain one isolation assertion: write through `systemCtx(ORG_B)`, read through
  `systemCtx()` (or the reverse) and expect nothing.

## Not yet (later phases)

`tenantGate` and `/api/o/:slug/*` routes (Phase 4), `isAdmin` → `requireRole` (Phase 4), org-scoped tokens
(5a), per-org cron / webhook (5b), the static enforcement test `test/data-layer.static.test.ts` (end of Phase 3,
once `legacyDb` is gone).
