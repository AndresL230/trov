# Handoff — Multitenancy Phases 2–6 are done on this branch, with the gaps to a first outside org closed; Phase 7 (cleanup) is next

> For: **andres**'s local Claude Code session. A FILE because Trov's MCP (`send_handoff`) was not connected
> in the cloud session that started it. Delete this file before the branch merges.

The Worker and the SPA are multi-tenant end to end: every repository takes a `TenantContext` or a
`PlatformContext`, every tenant route is served at `/api/o/:slug/…` (old paths kept as aliases), a bearer is
bound to (person, org), every background job runs per org with that org's own credentials, and the SPA lives
at `/o/<slug>/`. The superadmin can take on an organization, name its admin, and that admin does the rest —
invite the team (by mail), connect a repository, set keys — with nothing crossing between orgs. The whole flow
for a human operator: `docs/architecture/organizations.md`. Nothing is merged or deployed. `npm test`,
`npm run typecheck` and `npm run build:web` are green.

## The GitHub App (branch `feat/github-app`, issue #95) — built, NOT pushed, NOT deployed

An org now connects its repositories by installing Trov's GitHub App; the pasted token and the per-repo
webhook stay as the fallback. Everything about it — the flow, the security argument, tokens, the webhook,
permissions, and the OWNER CHECKLIST — is `docs/architecture/github-app.md`. `npm run typecheck`,
`npm test` and the web build are green; GitHub was stubbed in every test and in the browser check, so the
real round trip is unverified until the owner runs it (that doc › "Verify after deploy").

- **Schema**: `0043_github_app` — additive (`org_github_installations`; `org_repos.connection`,
  `access_lost_at`). A merge to `main` applies it. Its rollback is by hand (the statements are in its
  header) and must run BEFORE `scripts/mt/rollback/0042_organizations.down.sql` if that is ever used.
- **New routes**: `GET /api/o/:slug/github` (member), `GET …/github/install`, `GET|POST
  …/github/repositories`, `POST …/github/test`, `POST …/github/disconnect` (admin+, cookie only);
  `POST /webhook/github/app`; `/auth/callback` also answers the App's install return.
- **Credential order** for every GitHub read: installation token → stored `github_token` → SaplingLearn's
  legacy secret (`resolveGithubCredential`, `src/github-app/credential.ts`).
- **Changed shapes**: `OrgRepoDTO` gains `connection`, `access_lost`; `IntegrationsListDTO` gains
  `github_app`; `PlatformOrgRow` gains `github_account`; `org_admin_audit` gains the `github.*` actions.
- **Owner, to make it work in production** (in order; detail in the doc): `wrangler secret put
  GITHUB_APP_ID`; `wrangler secret put GITHUB_APP_PRIVATE_KEY < file.pem`; `GITHUB_APP_SLUG` in
  `wrangler.toml`; deploy; on GitHub make the App's webhook Active (`https://trov.dev/webhook/github/app`
  + the eight events); then Org settings › Repositories › Connect with GitHub; then retire SaplingLearn's
  old webhook and the two legacy Worker secrets.
- **Not done here**: capture for non-primary repositories (the capture's keys carry no repository — still
  the first "smaller follow-up" below); several installations per org; Phase 7's removal of the legacy
  hook and the env-secret fallback, which this makes possible once SaplingLearn is on the App.
- Merged as #103; its release entry is `0.19` in `web/src/releases.ts`.

## Context

| Field | Value |
|---|---|
| repo | `AndresL230/trov` (the remote still reads `SaplingLearn/canopy`; GitHub redirects) |
| branch | `claude/sharp-hawking-m0jgdp` (local commits on top of the pushed `73b43d6`; NOT pushed) |
| deploy target | what `wrangler.toml` names: Worker `trov`, D1 `trov`, R2 `trov-artifacts`, in andres's account |
| task | Multitenancy — Phase 7 (cleanup), after the owner's deploy decisions below |

### Done (each checkable on the branch)

- **Phases 0–2**: `canopy-multitenancy-audit.md`, `canopy-multitenancy.md` (rev 2, APPROVED); migrations
  `0041_trov_name` (already applied to production) and `0042_organizations` — ONE file holding the whole
  schema change of every phase below, in ten titled sections (it was ten files, consolidated before release;
  old → new map at the top of spec §3); `test/migrations.multitenancy.test.ts`,
  `test/multitenancy.schema.test.ts`; the generated rollback `scripts/mt/rollback/0042_organizations.down.sql`
  (`scripts/mt/build-rollback.py`, CI fails if stale); `scripts/mt/verify-migration.mjs`; Terms / Privacy; the
  Canopy → Trov rename (plugin `plugins/trov`).
- **Phase 3** (spec §4): `src/data/` — contexts, the two query surfaces, gates, bearer, metering, secrets;
  every repository ported; `test/data-layer.static.test.ts` + `test/isolation.*.test.ts`; orgs / members /
  invites, the superadmin surface (section 6 of the migration), per-org secrets and the Integrations API.
- **Phase 4** (spec §5, §6): every tenant route defined once, served at `/api/o/:slug/<suffix>` (`tenantGate`)
  and at its old path (`soleTenantGate`); org roles on every route; cookie-only confirm verbs; sign-in checks
  no GitHub org; `/auth/me` carries `orgs`, `superadmin`, `pending_invites`; `identities.provider_uid` (section 7).
  Tests: `test/isolation.http.test.ts` (generated from the route registry), `test/role-gates.http.test.ts`,
  `test/signin.multitenant.test.ts`.
- **Phase 5a** (spec §7): MCP tokens and OAuth grants carry their org; the consent page's org picker.
  `test/isolation.mcp.test.ts`.
- **Phase 5b** (spec §8.3–§8.5): the rotation dispatcher, per-(org, environment) jobs, `POST
  /webhook/github/:hookId`, per-org digests. `test/jobs.multi-org.test.ts`, `test/webhook.multi-org.test.ts`,
  `test/notifications.multi-org.test.ts`.
- **The seams and the hardening**: Sync / Poll act on the caller's org only; `isAdmin` / `ADMIN_LOGINS`
  deleted; the bare 401 for an unknown hook; abuse limits (section 8 of the migration, `src/platform/limits.ts`) and
  the fixed mail sender. `test/abuse-limits.test.ts`.
- **Phase 6 — the SPA**: `/o/<slug>/` + hash routing, one API prefix (`web/src/api.ts` `apiUrl`,
  `test/api.prefix.test.ts`), the org switcher / picker / create dialog, Org settings (Integrations,
  Repositories, Environments, Members, General, the setup checklist), Platform, Settings › MCP access per org.
- **The gaps to a first outside org** (this session):
  1. **Invitations are mailed.** Section 9 of the migration (four nullable columns on `org_invites`).
     `POST /api/o/:slug/invites` takes `name`, mails an e-mail invite and returns the outcome on the row;
     `POST …/invites/:id/resend`; the superadmin's owner invite mails "You have been made the owner of <org>
     on Trov". The mail names the org, the inviter and the role; its only link is the site root. The welcome
     names the org and goes out on a person's FIRST membership of any org. Members uses the org routes for
     people in any number of orgs. `src/orgs/mail.ts`, `test/org-invite-mail.test.ts`.
  2. **Raw artifacts per org**: `GET /api/o/:slug/raw/a/…` — one sub-app, two mounts, every header and access
     rule shared; in the isolation matrix; the SPA's "can't open here yet" state is gone.
  3. **`/platform/`**: the Platform screens outside any org, for a superadmin with no membership.
  4. **Per-org numbers are the ids** (spec §12 Q2): a ticket's and a handoff's `id` on every surface is its
     number within the org; the row id never leaves the Worker. SaplingLearn's numbers equal its ids (asserted
     over the migrated fixture; `verify-migration.mjs` checks it on the export). `test/numbers.per-org.test.ts`.
  5. **Links name their org**: MCP results and digest deep links are `<origin>/o/<slug>/#…`.
  6. **SPA follow-ups**: "Not connected" sources, Sync with nothing configured, the sender NAME field, the
     429 sentence. `email_in_use` had no handling left to remove.
  7. Release notes (0.18) corrected; the D1 name is `trov` in every script; `DEFAULT_TICKET_REPO` deleted;
     dead CSS removed; Settings › Account wraps; a sprint's `lead` must be a member.
  8. Docs: this file, `docs/architecture/data-layer.md`, `docs/architecture/organizations.md`.

### Plans and grants (merged, #104 — release 0.20)

`docs/architecture/plans.md` is the whole of it. In short: every org is on a plan (`shared/plans.ts`:
Personal 1 seat, Team 10, Enterprise set per org — every number a placeholder for the owner), enforced at
the server with one refusal (402 `plan_limit`); a person who is not a superadmin creates an org only by
using a GRANT (Platform › Access); `persons.org_limit` and its Platform control are gone. One additive
migration, `0044_plans` (existing orgs → Enterprise, unlimited seats). No prices, no payment code:
`src/plans/billing.ts` is the seam the billing work builds on. Owner's calls before it ships: the default
numbers, whether a pending invitation counts as a seat, the over-limit rule, whether grants should expire by
default.
The pricing page (#105, `shared/pricing.ts`, `/pricing`) merged after it with every price `null`.

### Billing (branch `feat/billing`, PR #106, up to date with main — NOT merged)

Paying for Personal or Team through Stripe, and setting the organization up with nobody at Trov involved:
`docs/architecture/billing.md` (the flow, the event table, what each state does, the OWNER CHECKLIST).
Migration `0045_billing` (three additive global tables). Nothing is live until the owner sets
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the price ids in `wrangler.toml`: until then every billing
route answers 503 `billing_unavailable` and the app is unchanged. Never exercised against real Stripe —
the first test-mode purchase (checklist step 8) is the verification. Release entry `0.21` (it also carries
the pricing page's line, #105). The pricing page (`/pricing`, on main) links to `GET /billing/start?plan=…`
only for a plan with a price in `shared/pricing.ts` — all `null` today, so nothing public reaches billing;
its link is `billingStartHref` (one source) and it does NOT ask `GET /api/billing/config`. Set a price there
only after billing is on. Terms / Privacy need the paid-plan wording before live keys go in (not edited
here: `web/src/legal.ts`).

### Sync you can see, and AI summaries per org (branch `feat/sync-and-summaries`, merged with `main` at 0.21 — release 0.22)

`docs/architecture/sync.md` (what Sync GitHub does, the credential it reads with, the run record, the
routes) and `plans.md` › AI summaries are the whole of it. In short: a sync is a recorded RUN (`sync_runs`,
`0046_sync_runs`, additive) that reports its phase and counts per batch, holds a per-org lock, and is
readable by every member at `GET /api/o/:slug/sync`; the Sync panel (`web/src/sync.ts`) replaces the
blocking modal. One platform `GEMINI_API_KEY` serves every org: each summarizer call is counted per org
(`org_usage_daily`, `summary*` metrics) and the monthly limit `ai_summaries` turns summaries off for an org
that has used its allowance — the item shows its excerpt, and a later Sync fills it in.
Owner's calls before it ships: the allowance numbers (300 / 3,000 / unlimited are placeholders), how long
run records are kept (90 days), and setting the key (`wrangler secret put GEMINI_API_KEY`) — summaries are
off until then.
What the merge with the GitHub App, plans, the pricing page and billing settled: the panel's "can a sync
start", the batch route and the run all ask ONE credential source (`src/github-app/credential.ts` —
`githubCredentialSource` for the ask, `resolveGithubCredential` for the read), and with none the panel
sends an admin to Repositories where the App is configured and to Integrations where it is not; a plan
that is past due still summarizes and a canceled one does not (`test/summaries.billing.test.ts`); the
allowance shows on the pricing page and in the Plan block through `shared/plans.ts`'s one formatter.
Not verified against the real services: a sync through a real installation token, and a real Gemini call.

### Changed for API clients since the pushed commit

| Route / tool | Was | Is |
|---|---|---|
| `POST /api/o/:slug/invites` | `{ github_login \| email, role }`; no mail | also `name` (≤ 120); an e-mail invite is MAILED; the row carries `name`, `mail_status` (`sent` / `failed` / null), `mail_at`, `mail_error` |
| `POST /api/o/:slug/invites/:id/resend` | — | 200 `{ ok, invite }`; 404 not pending / not this org's; 409 `no_address` (a GitHub-login invite); 429 |
| `GET /api/o/:slug/invites`, Platform org detail `invites` | — | each row carries the four fields above |
| `POST /api/platform/orgs`, `…/orgs/:slug/admin` with `{ email }` | invite row only | also mails the owner invitation (same response body) |
| `GET /api/o/:slug/raw/a/:ref`, `…/:slug/:ver` | — (alias `/raw/a/…` only) | the per-org route; the alias still answers a one-org person |
| every ticket / handoff route and MCP tool | `id`, `parent_id`, `child_id`, `after_id`, `ticket_id` = global row id | = the per-org NUMBER (equal to the old id for every existing SaplingLearn row) |
| `GET …/me/dashboard` `tickets[]` | `id` (row) + `number` | `id` is the number; `number` is gone |
| `artifact_links.target_ref` for a ticket; `?ticket=` on `GET …/artifacts`; MCP `links[].target_ref` | row id | the ticket's number |
| MCP `send_handoff` `url`; artifact tools' `url`, `raw_url` | `<origin>/#handoffs/<id>`, `<origin>/#artifacts/<slug>`, `<origin>/raw/a/…` | `<origin>/o/<slug>/#…`, `<origin>/api/o/<slug>/raw/a/…` |
| a ticket link / sprint resource given as a bare `#214` in an org with no primary repo | resolved against `SaplingLearn/sapling` | 400 naming Org settings › Repositories |
| `POST …/sprints`, MCP `create_sprint` / `update_plan` with a `lead` who is not a member of the org | stored | 400, nothing written |
| `GET /platform`, `/platform/*` | 401 (session gate) | the SPA shell (like `GET /o/*`) |

The earlier table (Sync / Poll `not_configured`, the webhook 401, `email_in_use`, `from_address`, the 429s) still
holds; the SPA now handles each.

### Next, in order

1. **The owner's deploy** (steps below), after the decisions under "Decide before a production deploy".
2. **Phase 7 — cleanup** (spec §11), one cleanup migration and the deletions it allows:
   - remove the old-path aliases, `soleTenantGate` / `resolveSoleTenant`, `/auth/mcp-token…`, the `legacyOnly`
     routes, the `/raw/a/*` alias mount and `src/orgs/legacy-invites.ts`; drop the legacy `invites` table,
     `src/auth/invites.ts`, `src/data/legacy.ts` (the sidecar's columns already live on `org_invites`);
   - remove the legacy `POST /webhook/github` route and `org_repos.legacy_hook`, and `resolveCredential`'s
     env-secret fallback with its Worker secrets and the dead vars `GITHUB_REPO` / `REPO_ENVIRONMENTS`
     (+ `repoEnvironments`);
   - drop every tenant table's transitional `org_id DEFAULT 'org_saplinglearn'`;
   - the artifact origin (§8.6): raw serving off the app origin;
   - the §10.3 mutation job; the tool descriptions' "the team" copy.
3. **Rate limits beyond these** and the open items in `docs/architecture/abuse-limits.md` › Residual risks —
   chiefly: mail only to a verified address (the welcome already does), and resolve a GitHub login to its
   numeric id when an invite is created.
4. Smaller follow-ups: capture for NON-primary repos; split `cf_polled` per environment before Queues make
   units concurrent; per-org numbers for sprints (their ids are still global: a new org's first sprint is not
   `#sprints/1`); the sign-in return-to does not remember `/platform/` (a signed-out superadmin lands on their
   org or the picker, one click away).

### Do not

- Do not `git add -A`, `git add .` or `git add <directory>` in this checkout: `canopy-dump.sql` (production
  data), `wrangler.old.toml`, `copy-data.sh`, `scripts/cutover/`, `MARKETING_BRIEF.md` and three
  `docs/superpowers/plans/*.md` are the owner's local files and must stay untracked. Stage explicit paths only,
  and run `git status --short` before every commit. Never read, move or delete those files.
- Do not activate Cloudflare Queues (`CLAUDE.md` deferred seam; Q4 amended D17 to rotation for now).
- Do not rename these — they are contracts, not branding: the `canopy/coverage|bundle-kb|todo` commit statuses
  and the `canopy-health` / `canopy-metrics` user-agents (Sapling's contracts), the stored
  `tickets.source = 'canopy'`, the HMAC purpose labels, the accepted `canopy_*` token prefixes.
- Do not edit `migrations/0042_organizations.sql` without re-running `python3 scripts/mt/build-rollback.py`,
  and keep it ONE file under 100 KB (it reaches D1 as one request; `test/migrations.multitenancy.test.ts`
  checks). Never touch `0041_trov_name.sql`: production has it recorded.
- A LOCAL database that applied the ten files `0042_organizations` replaced (numbered 0037–0048)
  has their names in `d1_migrations` and their tables in place, so the new file cannot apply on top (it
  stops at its first `ADD COLUMN`: "duplicate column name", nothing changed). Reset the local database:
  `rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local && npm run seed`. Production never recorded the
  old names (its ledger holds 0001–0036 and 0041), so nothing of the kind applies there.

### Decide before a production deploy (the owner's calls, not the code's)

1. **Mail to strangers.** With `NOTIFICATIONS_MODE = "resend"`, ANY org's admin can have Trov mail an
   invitation to any address, from `hello@trov.dev`, carrying the org's name, the inviter's name and the
   invitee's name as typed (escaped, one-line subject, no link but the site root), 50 a day per person
   (`abuse-limits.md` › Residual risks 5). `wrangler.toml` says `local` today, so nothing leaves until you
   flip it. Decide whether that is acceptable before orgs you do not know can sign up.
2. **Raw artifacts are on the app's origin** — now per org, with the same sandbox / CSP, but still this
   origin until §8.6. Decide whether outside orgs may publish HTML before that phase.
3. **Numbers as ids.** Every existing ticket / handoff keeps its number (= its id), so links survive — step 2
   below verifies it on your export. If `verify-migration.mjs` reports rows whose number differs from their
   id, STOP: old `#links` would point elsewhere.
4. **Sprint leads.** A lead is now checked on write. Existing rows are untouched, but a plan rewrite that
   repeats a lead who is not a member is refused. Check first:
   `SELECT id, title, lead FROM sprints s WHERE lead IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = s.org_id AND m.user_id = s.lead COLLATE NOCASE)`.
5. **A superadmin can make themselves an owner** of any org (Platform › Add another owner). It is audited
   under their name; decide whether it should be possible at all.
6. **Clients of the changed shapes** (table above): the Trov plugin's skills pass ticket ids through unchanged
   and see the same values for SaplingLearn; anything that stored an artifact `raw_url` or a handoff `url`
   holds the old form — the old `/#…` links still open for a person with one org.

### OWNER STEPS — a production deploy, in order

"The database" is the one `wrangler.toml` binds as `DB` (`trov`); `npm run db:migrate:*`, the verify script and
the rollback header now say `trov` too. Check `database_name` in `wrangler.toml` before running any of them.

0. If the database is being filled from Canopy with `copy-data.sh`: do that FIRST, from a checkout whose
   migrations stop at `0041` (main). The script applies every migration in the checkout BEFORE it imports, and
   `0042_organizations` makes every person it finds a member of SaplingLearn (andres its owner) and pins every token and
   grant to it — on an empty database it finds nobody, and the 0036-shaped import that follows would add
   people with no membership. (Read from the script and the migration, not run.)
1. **Export and bookmark.** Export the data (the two commands in the header of
   `scripts/mt/verify-migration.mjs`, into `.mt/`) and note the Time Travel bookmark:
   `npx wrangler d1 time-travel info <db>`.
2. **Verify on the export**: `node scripts/mt/verify-migration.mjs .mt/prod-data.sql` must end `OK`. It builds
   0001–0036 + `0041` (production's order), loads the export, applies `0042_organizations` as one
   transaction and checks, among the rest, that every ticket's and handoff's per-org number equals its id.
   (Run on 2026-10-06 against a fresh export, `.mt/trov-data.sql`: `OK`. Re-run it on the export you take
   in step 1.)
3. **Set the key**: `openssl rand -base64 32 | npx wrangler secret put TROV_KEK`. Keep a copy somewhere safe —
   losing it loses every org's stored credentials. (A secret change ships the latest uploaded build: do it
   when that build is the one you mean to run.)
4. **Apply the migration — `0042_organizations`, one file** — in a quiet window: `npx wrangler d1 migrations
   apply <db> --remote`. It must list exactly that one file (`0041_trov_name` is already recorded); it is
   all-or-nothing — if it fails (the foreign-key guard on a dangling row, most likely), nothing has changed
   and it can be applied again after the data is repaired. Then deploy the Worker (`npm run deploy`, or the push that
   deploys main — the schema is not compatible with the old Worker, so the two go together). Rollback inside
   Time Travel's window: `wrangler d1 time-travel restore <db> --bookmark=<step 1>` + `wrangler rollback`.
   Past it: `scripts/mt/rollback/0042_organizations.down.sql` — one file, the whole migration, back to the
   0036 + 0041 schema (it does NOT undo `0041`'s sender rename, refuses once a second org exists, and what is
   lost with it is listed in its header). Section 10 of the migration is the organization's
   image (five nullable columns on `orgs`): no backfill, and each org with a repository and a GitHub token gets
   its repository owner's avatar at the next 6-hourly reconcile — or upload one in Org settings › General.
5. **Confirm Workers Paid.** The repo cron budgets 900 subrequests per invocation
   (`CRON_SUBREQUEST_BUDGET`, `src/repo/dispatch.ts`); the free plan's cap is 50.
6. **Sign in, then have every existing member sign in once** — it binds their GitHub identity to their
   account (`identities.provider_uid`) and records their verified email. Check who is left:
   `SELECT subject, person FROM identities WHERE provider = 'github' AND provider_uid IS NULL`.
7. **Enter SaplingLearn's credentials** on Org settings › Integrations (GitHub token, webhook secret,
   Cloudflare token + account id, each environment's Railway and metrics tokens). Until each is stored, the
   Worker secret of the same purpose answers for SaplingLearn alone.
8. **Promote any other SaplingLearn admins** on Org settings › Members. The migration made andres the owner and
   everyone else a member; the old allowlist is gone, so nobody else is an admin until you do.
9. **Re-point nothing.** SaplingLearn's GitHub webhook keeps delivering to `/webhook/github` (the
   `legacy_hook` repo, on `GITHUB_WEBHOOK_SECRET`) until Phase 7; the per-repo URL
   `/webhook/github/hook_saplinglearn_sapling` also works once a secret is stored for it.
10. Mail: verify `trov.dev` as a Resend sending domain and make `hello@trov.dev` receive mail before
    `NOTIFICATIONS_MODE` is `resend` — every org's mail (digests, invitations, welcomes) is sent from that one
    address. See decision 1 above first.
11. **Take on the first outside org**: `/platform/` › Add organization, as `docs/architecture/organizations.md`
    describes.

Still open from before: the operator name on the legal pages ("Andres Lopez"); re-capturing the Get Started
screenshots (`scripts/capture-guide.mjs`), which still show "Canopy".

### Files

The full list: `git diff --name-only origin/main...HEAD`. Start from: `canopy-multitenancy.md` (§6, §8.6, §11),
`docs/architecture/organizations.md`, `docs/architecture/data-layer.md`, `docs/architecture/abuse-limits.md`,
`src/routes.ts`, `src/data/`, `src/orgs/`, `src/platform/`, `src/tools/tickets.ts` (a ticket's two ids),
`test/data-layer.static.test.ts`, `test/isolation.*.test.ts`, `test/numbers.per-org.test.ts`.

## Prompt — paste into the local session to start

```text
Read HANDOFF.md, docs/architecture/organizations.md, docs/architecture/data-layer.md,
docs/architecture/abuse-limits.md and canopy-multitenancy.md (§6 route map, §8.6 artifact origin, §11 phase
plan). Multitenancy Phases 2–6 and the gaps to a first outside org are on branch claude/sharp-hawking-m0jgdp.
Start Phase 7: one cleanup migration and the deletions listed under "Next". Keep `npm test` (including
test/data-layer.static.test.ts), `npm run typecheck` and `npm run build:web` green at each step, commit in
small steps staging explicit paths only (see "Do not"), and do not push, merge or open a PR without asking.
When done, update HANDOFF.md and tell me what changed.
```
