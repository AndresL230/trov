# CLAUDE.md

Trov — a multi-tenant shared context store. **One** Cloudflare Worker on one origin serves the HTTP API (Hono,
session cookie), a stateless MCP endpoint at `/mcp` (bearer), the GitHub webhooks (HMAC) and the web SPA via
the `ASSETS` binding; `scheduled()` runs the repo cron and two email-digest crons. Agents propose knowledge
through a reconciling gate and humans confirm it; authored and computed writes go direct.

This file holds only what applies to EVERY change. The detail for each area lives in `docs/architecture/` —
**read the matching file before changing that area** (table at the bottom), and update it in the same PR
when you change behavior there. **Don't grow this file with feature detail**: a new rule belongs here only
if it applies to every change; everything else goes in the area file.

## Working memory (use the skills)

Trov is the team's working memory; the skills under `.claude/skills/` (symlinks into `plugins/trov/skills/`
— edit there) are how it stays living: **orient → work → record**.

- **`trov`** — the map: loop, authority model, tool map. `references/querying.md` is the `query` reference.
- **`load-context`** (auto-fires, read-only) — orient before touching an existing area; ALWAYS before
  proposing a doc change (note the doc's `current_version` as the writer's base). Calls `get_my_work` and
  lists waiting handoffs at session start.
- **`record-session`** (explicit only) — at session end, stage ONE reconciled batch via `record_session`.
- **`tickets`** (explicit only) — work the queue over the scoped MCP writes; per-team taste in `tickets.config.md`.
- `read-plan` / `update-plan` (admin) and `my-work` for the roadmap and My Work; `artifacts`, `handoff` and
  `prompts` for those libraries.

Trust `live`; scrutinize `staged_pending` / `unpromoted` / `draft` — not settled, not fact.

## Commands

- `npm test` — Vitest against a real Miniflare D1 (the source of truth for "is it green").
  One file: `npx vitest run test/<file>.test.ts`.
- `npm run typecheck` — `tsc` over worker + web. NOT part of `npm test`; run it too.
- `npm run dev` — build web, `wrangler dev`, and a `vite build --watch` beside it: a web change is live on a
  plain reload. Never run `build:web` (which empties `web/dist`) under a running `wrangler dev`.
- `npm run build:web`, `npm run deploy`; `npm run db:create` / `db:migrate:local` / `db:migrate:remote`.
- A merge to `main` deploys to production (Workers Builds). A change to `[triggers] crons` also needs
  `wrangler triggers deploy` after the merge. The deploy runbook is `HANDOFF.md`.

## Layout

- `shared/` — the ONLY code shared by `src/` and `web/` (`@shared` alias): the Zod ingest contract,
  vocabulary, row types, DTOs. **Rule: anything the SPA imports as a VALUE lives in a zod-free `*-core.ts`**
  (`tickets-core.ts`, `sprints-core.ts`, `artifacts-core.ts`, …) and the zod module re-exports it, so the
  browser bundle never pulls in zod and the server keeps one definition.
- `src/` — the Worker. `index.ts` (fetch + `scheduled()` dispatch), `routes.ts` (Hono), `mcp.ts` (MCP tools),
  `consumer.ts` (**the gate**), `webhook.ts` / `github-hook.ts`, `data/` (the ONLY place D1 is reached),
  `tools/` (one module per domain; writers in `tools/writes.ts`), `auth/`, `repo/` (Repo-dashboard capture),
  `github-app/`, `sync/`, `orgs/`, `platform/`, `plans/`, `billing/`, `integrations/`, `artifacts/`,
  `notifications/`.
- `migrations/` — numbered, append-only D1 SQL; each file's header says what it does. Multi-part migrations
  use marker lines that tests cut on. `0042_organizations` is all-or-nothing and must stay under 100 KB; its
  rollback is GENERATED (`scripts/mt/build-rollback.py`, CI fails if stale).
- `web/` — TypeScript/Vite SPA, no framework: `main.ts` (state + acts), `render.ts`, one module per screen,
  `hash.ts` (routes), `trov.css`. `web/src/releases.ts` is Help › What's new (see Conventions).
- `plugins/trov/` — the Claude Code plugin + skills; `.claude-plugin/marketplace.json` distributes it.
- `docs/architecture/` — per-area reference. `docs/superpowers/specs|plans/` — design history (dated; the
  code wins if they disagree).
- Full per-file and per-migration tour: `docs/architecture/layout.md`.

## Invariants — break none of these

1. **Ingested content is gated; authored & computed writes are direct.** Agent-proposed knowledge (feed,
   doc proposals, ADR drafts, events, repo events) goes through the per-type gate functions in
   `src/consumer.ts` (replay ledger, content-hash dedupe, server-computed `change_kind`, vocab/confidence
   routing to triage). A new ingestion path goes INTO the gate — never a second surface. Authored writes
   (plan, tickets, sprints, handoffs, prompts, artifacts, people) and computed writes (progress, summaries,
   repo metrics/snapshots, the GitHub issue mirror) are direct "promote-class" writers in `src/tools/`.
2. **Agents stage; humans confirm.** Promote / reject / ratify / triage assign & discard, artifact ratify,
   prompt publish, every delete, which orgs a connection may use — session-cookie routes, NEVER MCP tools.
3. **The author is always the authenticated principal**, passed in by the caller; client-supplied authors
   are ignored. An MCP write is recorded as the token's person (no separate provenance).
4. **Every tenant statement binds `ctx.orgId`.** D1 is reached only through a context, inside `src/data/`
   (`sql.ts` for tenant data, `platform-sql.ts` for the global tables); a static test enforces it
   (`test/data-layer.static.test.ts`). A bearer call acts in ONE org, chosen only among its person's LIVE
   memberships and only in `src/data/bearer.ts`: a token's org, a manual connection's current org, or the
   org that has the call's `repo` connected (else nothing is read or written). A ticket's / handoff's `id`
   on every surface is its per-org NUMBER, never the row id.
5. **Nothing infers a resolution.** `done`/`declined` tickets and `done` sprints are set by a person, never
   by a merge, issue close, webhook or cron — except a ticket MIRRORED from a GitHub issue follows its own
   issue's close/reopen.
6. **MCP ticket writes are lane-scoped** in `src/tools/tickets-agent.ts` (the only place the rule lives):
   the bearer must already be an assignee; `create_ticket` is open; `assign_ticket` and admin
   `set_ticket_sprint` have their own rules. Unknown id is `not_found` before `forbidden`.
7. **Never guess on read.** Unknown is `null` / `not_connected` / "—", never `0`. Reads that back a screen
   degrade (`degraded: true`, 503 `{ error }`) — never a 500. Nothing on a render path calls GitHub or any
   other external service; external reads happen in the webhook, reconcile, Sync or cron.
8. **Three auth classes, don't add a fourth:** session cookie (GitHub + Google feeding one sign-in fork),
   bearer on `/mcp` (pasted `canopy_mcp_` or OAuth `canopy_oat_`, same person + org), HMAC on the webhooks.
   The Hono app is cookie-only. Signed-token exceptions (`/u/`, artifact upload/download) sit in
   `src/index.ts` before the session gate.
9. **Admin is the ORG role** (`hasRole(ctx, "admin")`) — there is no handle allowlist. Superadmin is a
   separate platform role with no implicit access to any org's content.
10. **Handles, not logins.** `persons.handle` is identity; every `*_by` / owner column is a handle and must
    be listed in `HANDLE_COLUMNS` so a rename rewrites it. GitHub logins map through `identities`.
11. **Soft by default.** Doc/ADR reject, triage exits, prompt and artifact delete are soft and restorable; a
    deleted slug stays reserved. Hard deletes exist only for tickets and sprints.
12. **Credentials go through their one resolver; secrets never reach logs or responses.** A GitHub read
    uses `resolveGithubCredential`, any other integration `resolveCredential` — never a Worker secret or
    var directly. Scrub (`scrubbedMessage` / `scrubbedLog`) BEFORE any cut. Nothing reachable from
    `src/mcp.ts` may import `src/github-app/`.
13. **A per-org limit goes in `PLANS` and is enforced with `requirePlan`** (402 `plan_limit`) — never an
    ad-hoc check.

## Conventions & gotchas

- `shared/vocabulary.ts` MUST match `migrations/0002_seed_vocab.sql` — it is the gate's source of truth.
- **Tests** use real Miniflare D1; `scripts/seed/reset.mjs` truncates data tables before each test and is
  the canonical seed: two orgs (`org_saplinglearn` with six persons — four GitHub engineers + Google-only
  `meilin` / `sanaok` — and an empty `org_b`). **Add every new table there.** GitHub I/O, Gemini and other
  network clients are dependency-injected (`fetchImpl`, `summarizer`) — stub at the `Response` level, never
  hit the network. `vitest.config.ts` blanks every network secret from `.dev.vars`; a test that needs one
  passes its own env.
- A test importing `web/src` must be listed in `tsconfig.worker.json` exclude AND `tsconfig.web.json` include.
- **Web UI rules** (details in `docs/architecture/web-ui.md`):
  - The sidebar's DOM is structurally stable — state is attributes/classes, never conditional nodes
    (`test/render.sidebar.test.ts`).
  - Pick-one switches are `segmented()`; page sections are `tabBar()`; a pick-one with no room for a switch
    is `dropdown()`. Never hand-roll one, never a native `<select>`.
  - Every radius is scaled in ONE block at the end of `trov.css`; a new radius value needs a line there
    (`test/render.corners.test.ts`). Status dots are elements, never `●`.
  - Confirmations use `confirmModal` (`web/src/confirm.ts`), never `window.confirm`.
  - A clickable person goes through `web/src/people.ts`; a picture always through `avatarSrc`.
  - Never a button inside a button — use `hitArea`.
  - Motion is off under `prefers-reduced-motion`.
- **Every shipped PR adds its lines to the top entry of `web/src/releases.ts`**: release notes in product
  words, `ops` deploy steps, and patch lines ending `(#N)`. The merging PR cuts "Unreleased" into the next
  `0.N` (the file's header says how).
- **Deferred seams — do NOT activate:** Cloudflare Queue, Vectorize (`// SEAM:` comments only).
- The product was renamed Canopy → Trov, but stored identifiers keep the old name on purpose: the
  `canopy_mcp_` / `canopy_oat_` token prefixes and the `canopy/*` commit-status contexts. Don't rename them.
- `REPO_CRON` in `src/repo/cron.ts` must equal the expression in `wrangler.toml` (pinned by a test);
  Cloudflare cron weekdays are 1–7 or SUN–SAT, never 0.

## Where the detail lives — read before changing the area

| Changing… | Read (`docs/architecture/`) |
| --- | --- |
| `src/consumer.ts`, `/ingest`, `record_session`, triage, doc promote/reject | `ingestion-gate.md` |
| tickets, the board, `tickets-agent.ts`, the GitHub issue mirror | `tickets.md` |
| `reads.ts` / `query`, `/search`, quick search, the feed brief & stats | `feed-and-search.md` |
| plan, sprints, progress, My Work, summaries | `roadmap-my-work.md` |
| `src/repo/`, `tools/repo*.ts`, the Repo screen, the repo cron, pollers | `repo-dashboard.md` |
| `src/auth/`, MCP OAuth, identity, persons, avatars, roles, Settings › MCP | `auth-identity-people.md` |
| artifacts, doc images, R2 | `artifacts.md` (+ `docs/artifact-contract.md`) |
| handoffs, the Prompt Library | `handoffs-prompts.md` |
| `src/notifications/`, digests, invite/welcome mail | `notifications.md` |
| sidebar, morph, segmented, tab bars, entrances, corners | `web-ui.md` |
| `src/data/`, contexts, tenant vs platform SQL, bearer → org, background jobs | `data-layer.md` |
| orgs, memberships, roles, invites, superadmin, how an org is set up | `organizations.md` |
| `src/github-app/`, the install flow, installation tokens, the App webhook | `github-app.md` |
| Sync GitHub, `src/sync/`, the sync panel's copy | `sync.md` |
| plans, limits, grants, the pricing page, the summarizer allowance | `plans.md` |
| Stripe, checkout, `src/billing/` | `billing.md` |
| rate limits, the mail sender, what a stranger can do | `abuse-limits.md` |
| the bug-report / support form, `support_reports`, Platform › Support | `support.md` |
| secrets, vars, bindings, `REPO_ENVIRONMENTS` | `env.md` |
| where a file or migration lives | `layout.md` |
