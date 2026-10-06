# Handoff — Multitenancy Phases 2–5 are done on this branch; Phase 6 (SPA) is in progress, Phase 7 (cleanup) is next

> For: **andres**'s local Claude Code session. A FILE because Trov's MCP (`send_handoff`) was not connected
> in the cloud session that started it. Delete this file before the branch merges.

The Worker is multi-tenant end to end: every repository takes a `TenantContext` or a `PlatformContext`, every
tenant route is served at `/api/o/:slug/…` (old paths kept as aliases), a bearer is bound to (person, org), and
every background job runs per org with that org's own credentials. Admin is the ORG role — `isAdmin` /
`ADMIN_LOGINS` are deleted. Anyone with a GitHub account can sign in and create an org, so the Worker now has
per-person rate limits and a fixed mail sender (`docs/architecture/abuse-limits.md`). Nothing is merged or
deployed. `npm test` + `npm run typecheck` are green.

## Context

| Field | Value |
|---|---|
| repo | `AndresL230/trov` (the remote still reads `SaplingLearn/canopy`; GitHub redirects) |
| branch | `claude/sharp-hawking-m0jgdp` (local, ahead of origin, NOT pushed) |
| deploy target | what `wrangler.toml` names: Worker `trov`, D1 `trov`, R2 `trov-artifacts`, in andres's account |
| task | Multitenancy — Phase 6 (SPA, in the `mt/p6-spa` worktree), then Phase 7 (cleanup) |

### Done (each checkable on the branch)

- **Phases 0–2**: `canopy-multitenancy-audit.md`, `canopy-multitenancy.md` (rev 2, APPROVED); migrations
  `0037_orgs`, `0038_tenant_columns`, `0039_tenant_rebuilds`, `0040_tenant_fts`, `0041_trov_name`,
  `0042_platform_admins`; `test/migrations.multitenancy.test.ts`, `test/multitenancy.schema.test.ts`;
  the generated rollback `scripts/mt/rollback/0037-0040.down.sql` (`scripts/mt/build-rollback.py`, CI fails if
  stale); `scripts/mt/verify-migration.mjs`; Terms / Privacy; the Canopy → Trov rename (plugin `plugins/trov`).
- **Phase 3** (spec §4): `src/data/` — contexts, the two query surfaces, gates, bearer, metering, secrets;
  every repository ported; `test/data-layer.static.test.ts` + `test/isolation.*.test.ts`; orgs / members /
  invites, the superadmin surface (`0043_platform_orgs`), per-org secrets and the Integrations API.
- **Phase 4** (spec §5, §6): every tenant route defined once, served at `/api/o/:slug/<suffix>` (`tenantGate`)
  and at its old path (`soleTenantGate`); org roles on every route; cookie-only confirm verbs; sign-in checks
  no GitHub org and onboarding creates a person with no membership; `/auth/me` carries `orgs`, `superadmin`,
  `pending_invites`; `0045_identity_provider_uid` pins a GitHub identity to the account's numeric id.
  Tests: `test/isolation.http.test.ts` (generated from the route registry), `test/role-gates.http.test.ts`,
  `test/signin.multitenant.test.ts`.
- **Phase 5a** (spec §7): MCP tokens and OAuth grants carry their org; `/api/o/:slug/mcp-tokens…`
  (`/auth/mcp-token…` is the one-org alias); the consent page has an org picker; `update_plan` and the lane's
  admin exceptions read the org role. `test/isolation.mcp.test.ts`.
- **Phase 5b** (spec §8.3–§8.5): the rotation dispatcher, per-(org, environment) / per-org jobs reading
  `org_repos` / `org_environments` and `resolveCredential`; `POST /webhook/github/:hookId` (+ the legacy
  hook); per-org digests. `test/jobs.multi-org.test.ts`, `test/webhook.multi-org.test.ts`,
  `test/notifications.multi-org.test.ts`.
- **The seams and the hardening** (this session):
  - `POST …/admin/{backfill,poll,poll-usage}` act on the CALLER's org only (the `notLegacyOrg` 503 is gone):
    its repo, its environments, its stored credentials — never SaplingLearn's Worker-secret fallback — and an
    org with nothing configured answers "not configured" with no outbound request. Proven over HTTP for two
    orgs in `test/jobs.multi-org.test.ts`.
  - `isAdmin` and `ADMIN_LOGINS` are deleted (function, `Env`, `wrangler.toml`, `vitest.config.ts`).
  - `src/data/legacy.ts` keeps only what is still org #1's: the legacy `invites` sidecar and the id the
    env-secret fallback reads. `legacySystemTenant` is gone. The static test lists each caller and why.
  - The webhook answers one bare 401 for an unknown hook id, a suspended org's, a repo with no secret and a
    bad signature (it was 404 for the first two).
  - Abuse limits: migration `0046_abuse_limits` + `src/platform/limits.ts`; every mail path sends from the
    platform address with a sanitised display name; `PUT …/notifications/settings` accepts a sender NAME
    only; the notification address no longer answers 409 `email_in_use`. `test/abuse-limits.test.ts`.
  - Rollback `scripts/mt/rollback/0046.down.sql` (0045 is one nullable column: no down file).

### Changed for API clients (the SPA needs these)

| Route | Was | Is |
|---|---|---|
| `POST …/admin/poll`, `…/admin/poll-usage` for an org other than SaplingLearn | 503 `service token or repo not configured` | 200 with `"not_configured"` per source (the same body SaplingLearn gets when unconfigured) |
| `POST …/admin/backfill` | (unchanged) 503 `service token or repo not configured` when the caller's org has no repo or token | the GitHub error text now ends `(check the org's GitHub token)` |
| `POST /webhook/github/:hookId`, unknown or suspended hook | 404 `{ error: "not_found" }` | 401 `{ error: "unauthorized" }` |
| `PUT …/notifications/prefs`, `PUT …/notifications/persons/:handle` with an address on another person's row | 409 `{ error: "email_in_use" }` | 200, saved (the code is never returned any more) |
| `PUT …/notifications/settings` `from_address` | any string of 3–254 characters | a sender name, or `Name <hello@trov.dev>`; another address or a bad name → 400 `invalid payload`; the stored / returned value is always `Name <hello@trov.dev>` |
| `POST /api/o/:slug/invites`, `POST /invites`, `POST /invites/:email/resend`, `POST …/notifications/test-send`, `PUT …/notifications/prefs` (address change), `PUT …/notifications/persons/:handle`, `POST …/people/me/avatar`, `GET /auth/handle-check` | — | may answer 429 `{ error: "rate_limited", retry_after }` + `Retry-After` |
| `/auth/me` `admin`, every `admin only` 403 | (unchanged shapes) | decided by the org role alone; `admin_handle_not_allowlisted` is never returned |

### Next, in order

1. **Phase 6 — the SPA** (in progress in the `mt/p6-spa` worktree; do not edit `web/` from here): call
   `/api/o/:slug/…`, the org picker, Org settings (Members, Integrations), Settings › MCP access per org,
   `<origin>/o/<slug>/#…` links, flip `WEBHOOKS_LIVE` in `web/src/integrations.ts`, handle 429 `rate_limited`
   and the sender-name field, drop the `admin_handle_not_allowlisted` and `email_in_use` messages, replace the
   "Sapling" copy in the invite and welcome mails with the org's name.
2. **Phase 7 — cleanup** (spec §11), one cleanup migration and the deletions it allows:
   - remove the old-path aliases, `soleTenantGate` / `resolveSoleTenant`, `/auth/mcp-token…`, the `legacyOnly`
     routes and `src/orgs/legacy-invites.ts`; move the invite sidecar's columns onto `org_invites` and drop
     the legacy `invites` table, `src/auth/invites.ts`, `src/data/legacy.ts`;
   - remove the legacy `POST /webhook/github` route and `org_repos.legacy_hook`, and `resolveCredential`'s
     env-secret fallback with its Worker secrets (`GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
     `CF_ANALYTICS_TOKEN`, `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_<ENV>`, `SAPLING_METRICS_TOKEN`) and the
     dead vars `GITHUB_REPO` / `REPO_ENVIRONMENTS` (+ `repoEnvironments`, `DEFAULT_TICKET_REPO`);
   - drop every tenant table's transitional `org_id DEFAULT 'org_saplinglearn'`;
   - the artifact origin (§8.6): `/raw/a/*` off the app origin;
   - per-org ticket / handoff `number` as the user-facing id (routes, MCP, the SPA) instead of the global `id`;
   - the §10.3 mutation job; the tool descriptions' "the team" copy.
3. **Rate limits beyond these** and the open items in `docs/architecture/abuse-limits.md` › Residual risks —
   chiefly: mail only to a verified address, and resolve a GitHub login to its numeric id when an invite is
   created.
4. Smaller follow-ups: capture for NON-primary repos (needs the repo in the capture keys); split `cf_polled`
   per environment before Queues make units concurrent; a sprint's `lead` is stored unchecked.

### Do not

- Do not `git add -A` in this checkout: `canopy-dump.sql`, `wrangler.old.toml`, `copy-data.sh` and `scripts/cutover/` are the owner's local files (production data among them) and must stay untracked.
- Do not activate Cloudflare Queues (`CLAUDE.md` deferred seam; Q4 amended D17 to rotation for now).
- Do not rename these — they are contracts, not branding: the `canopy/coverage|bundle-kb|todo` commit statuses
  and the `canopy-health` / `canopy-metrics` user-agents (Sapling's contracts), the stored
  `tickets.source = 'canopy'`, the HMAC purpose labels, the accepted `canopy_*` token prefixes.
- Do not edit `0037`–`0040` without re-running `python3 scripts/mt/build-rollback.py`.

### OWNER STEPS — a production deploy, in order

"The database" is the one `wrangler.toml` binds as `DB` (`trov` today). The helper scripts and
`npm run db:migrate:*` still spell `canopy`: pass the real name, or the binding `DB`.

0. If the database is being filled from Canopy with `copy-data.sh`: do that FIRST, from a checkout whose
   migrations stop at `0036` (main). The script applies every migration in the checkout BEFORE it imports, and
   `0037` makes every person it finds a member of SaplingLearn (andres its owner) and pins every token and
   grant to it — on an empty database it finds nobody, and the 0036-shaped import that follows would add
   people with no membership. (Read from the script and the migration, not run.)
1. **Export and bookmark.** Export the data (the two commands in the header of
   `scripts/mt/verify-migration.mjs`, into `.mt/`) and note the Time Travel bookmark:
   `npx wrangler d1 time-travel info <db>`.
2. **Verify on the export**: `node scripts/mt/verify-migration.mjs .mt/prod-data.sql` must end `OK`. It applies
   every migration from `0037` up (so `0045` and `0046` too).
3. **Set the key**: `openssl rand -base64 32 | npx wrangler secret put TROV_KEK`. Keep a copy somewhere safe —
   losing it loses every org's stored credentials. (A secret change ships the latest uploaded build: do it
   when that build is the one you mean to run.)
4. **Apply migrations `0037`–`0046`** in a quiet window: `npx wrangler d1 migrations apply <db> --remote`
   (there is no `0044`). Then deploy the Worker (`npm run deploy`, or the push that deploys main — the schema
   is not compatible with the old Worker, so the two go together). Rollback inside Time Travel's window: `wrangler d1 time-travel
   restore <db> --bookmark=<step 1>` + `wrangler rollback`. Past it: `scripts/mt/rollback/0043.down.sql`,
   then `0037-0040.down.sql` (`0046.down.sql` at any point).
5. **Confirm Workers Paid.** The repo cron budgets 900 subrequests per invocation
   (`CRON_SUBREQUEST_BUDGET`, `src/repo/dispatch.ts`); the free plan's cap is 50.
6. **Sign in, then have every existing member sign in once** — it binds their GitHub identity to their
   account (`identities.provider_uid`) and records their verified email. Check who is left:
   `SELECT subject, person FROM identities WHERE provider = 'github' AND provider_uid IS NULL`.
7. **Enter SaplingLearn's credentials** on Org settings › Integrations (GitHub token, webhook secret,
   Cloudflare token + account id, each environment's Railway and metrics tokens). Until each is stored, the
   Worker secret of the same purpose answers for SaplingLearn alone.
8. **Promote any other SaplingLearn admins** on Org settings › Members. `0037` made andres the owner and
   everyone else a member; the old allowlist is gone, so nobody else is an admin until you do.
9. **Re-point nothing.** SaplingLearn's GitHub webhook keeps delivering to `/webhook/github` (the
   `legacy_hook` repo, on `GITHUB_WEBHOOK_SECRET`) until Phase 7; the per-repo URL
   `/webhook/github/hook_saplinglearn_sapling` also works once a secret is stored for it.
10. Mail: verify `trov.dev` as a Resend sending domain and make `hello@trov.dev` receive mail before
    `NOTIFICATIONS_MODE` is `resend` — every org's mail is sent from that one address.

Still open from before: the operator name on the legal pages ("Andres Lopez"); re-capturing the Get Started
screenshots (`scripts/capture-guide.mjs`), which still show "Canopy".

### Files

The full list: `git diff --name-only origin/main...HEAD`. Start from: `canopy-multitenancy.md` (§6, §8.6, §11),
`docs/architecture/data-layer.md`, `docs/architecture/abuse-limits.md`, `src/routes.ts`, `src/data/`,
`src/platform/limits.ts`, `test/data-layer.static.test.ts`, `test/isolation.*.test.ts`.

## Prompt — paste into the local session to start

```text
Read HANDOFF.md, docs/architecture/data-layer.md, docs/architecture/abuse-limits.md and canopy-multitenancy.md
(§6 route map, §8.6 artifact origin, §11 phase plan). Multitenancy Phases 2–5 are on branch
claude/sharp-hawking-m0jgdp and Phase 6 (the SPA) is in the mt/p6-spa worktree. Start Phase 7: one cleanup migration and the
deletions listed under "Next". Keep `npm test` (including test/data-layer.static.test.ts) and
`npm run typecheck` green at each step, commit in small steps, and do not push, merge or open a PR without
asking. When done, update HANDOFF.md and tell me what changed.
```
