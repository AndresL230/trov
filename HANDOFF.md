# Deploy runbook

How Trov reaches production, how to check that it did, and how to go back. Steps and checks only: what each
area does is in `docs/architecture/`, and what each release needed is its `ops` list in `web/src/releases.ts`
(Help › What's new › patch notes).

| | |
|---|---|
| Production | `https://trov.dev` — Worker `trov`, D1 `trov`, R2 `trov-artifacts` (`wrangler.toml`) |
| Repository | `AndresL230/trov`; `main` is production |
| Deploys | Cloudflare Workers Builds, on every push to GitHub. Its build and deploy commands are settings in the Cloudflare dashboard, not files in this repo |
| CI | GitHub Actions (`.github/workflows/ci.yml`), on every push and pull request: typecheck, the test suite, the web build, and that the generated `0042_organizations` rollback is current |
| Every name the Worker reads | `docs/architecture/env.md` |

Run every `wrangler` command that talks to Cloudflare (`--remote`, `secret`, `triggers`, `deployments`,
`rollback`) with `CLOUDFLARE_ACCOUNT_ID` set to the `account_id` in `wrangler.toml`, so it cannot act on
another account your login reaches.

## 1. Before a merge

1. `npm test` and `npm run typecheck` are green locally (typecheck is not part of `npm test`), and CI is
   green on the pull request.
2. The pull request's lines are in the top entry of `web/src/releases.ts`, with an `ops` line for every
   migration, secret, var or trigger change it carries. The merging PR cuts the version (that file's header).
3. A new migration is **additive and safe beside the Worker already running** (a new table, a nullable
   column, a column with a default), and its header says how to undo it by hand. See section 3 for why this
   is not optional today.
4. A new secret is set BEFORE the merge that reads it (section 4); a new var is in `wrangler.toml` `[vars]`
   and, if a Preview needs it, `[previews.vars]`.
5. A new R2 bucket or D1 database a binding names exists before the deploy that carries the binding, or the
   deploy fails.

## 2. A merge to `main`

A merge to `main` IS a production deploy. Workers Builds builds the web bundle (`npm run build:web`) and runs
the production deploy command, which:

- **applies every migration not yet recorded** in the production database's `d1_migrations`, and
- **deploys the Worker** with the `[vars]` in `wrangler.toml` (a value changed only in the dashboard is put
  back).

It does NOT update the cron schedule (section 5), and it does not set secrets.

After the merge: watch the build in the Cloudflare dashboard (the Worker `trov`, its Builds) until it
succeeds, then run the checks in section 6. If the build fails after migrations were applied, the old Worker
is still serving against the new schema — which is why step 3 above matters; fix forward or roll back
(section 7).

## 3. A push of any other branch — what happens today

**A push of ANY branch applies that branch's new migrations to the PRODUCTION database. It does not deploy
the Worker.** Verified 2026-10-09.

This is a Cloudflare build setting, not a decision in the code, and the owner intends to change it: the
non-production deploy command in Workers Builds is meant to be `npm run deploy:preview` (which migrates and
deploys only the Preview's own empty database, `trov-preview` — `docs/architecture/env.md` › Preview
deployments). While it is the production command, Cloudflare refuses the Worker deploy from a branch build
but not the `d1 migrations apply`.

Until the setting is changed:

1. Treat pushing a branch that adds a migration as a production schema change. Push it only when the
   migration is one you would apply to production now: additive, and safe beside `main`'s Worker.
2. Do not rename, renumber or edit a migration file once its branch has been pushed. Production records
   migrations by file NAME; a renamed file is a new migration and would be applied again.
3. A destructive or all-or-nothing migration must not be pushed on a branch at all before its deploy
   window.

**Check what production has applied** (read-only):

```bash
CLOUDFLARE_ACCOUNT_ID=<account_id from wrangler.toml> \
  npx wrangler d1 execute trov --remote \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 10"
```

Compare the names with `ls migrations/` on `main`: a name production has that `main` does not came from a
branch push. `npx wrangler d1 migrations list trov --remote` (also read-only) lists what the current checkout
has that production has not.

**To confirm the setting was changed:** push a branch carrying a throwaway additive migration, run the query
above, and see that production did NOT record it (the Preview's database did).

## 4. Secrets and vars

The full list — what each is, and what happens without it — is `docs/architecture/env.md`. No value is ever
written in this repo, a log or a response.

- **Set a secret:** `npx wrangler secret put <NAME>` (it prompts for the value; pipe a file for a multi-line
  one: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem`). **List the names that are set:**
  `npx wrangler secret list`.
- **Changing a secret redeploys.** `wrangler secret put` / `delete` creates a new production deployment at
  once, from the latest uploaded version of the Worker. Do it when that is the version you mean to run, and
  run the checks in section 6 afterwards.
- **`TROV_KEK`** wraps every organization's stored credentials. Keep a copy outside Cloudflare: losing it
  loses all of them. Rotation uses `TROV_KEK_PREVIOUS` (`src/data/secrets.ts`).
- **A var** is changed in `wrangler.toml` `[vars]` and ships with the next merge. Never give a var and a
  secret the same name: the deploy fails.
- **Stripe:** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are a pair from the same Stripe mode, and the
  price id in `wrangler.toml` must be from that mode too. Changing mode is `docs/architecture/billing.md` ›
  Owner checklist, step 9.
- **Per-organization credentials are not Worker secrets**: each organization enters its own on Org settings ›
  Integrations (`docs/architecture/organizations.md`).

## 5. After a change to `[triggers] crons`

A Workers Builds deploy does not update the schedule. After the merge:

```bash
CLOUDFLARE_ACCOUNT_ID=<account_id from wrangler.toml> npx wrangler triggers deploy
```

Check: the Worker's Settings › Triggers in the dashboard lists the three expressions in `wrangler.toml`.
Cloudflare cron weekdays are 1–7 or SUN–SAT, never 0. `REPO_CRON` in `src/repo/cron.ts` must equal the repo expression (a test pins it).

## 6. Verify a deploy

1. **The served bundle is the release you merged.** The newest release is the first `version:` in the main
   bundle:

   ```bash
   main=$(curl -s https://trov.dev/ | grep -oE '/assets/main-[A-Za-z0-9_-]+\.js' | head -1)
   curl -s "https://trov.dev$main" | grep -oE 'version:"0\.[0-9]+"' | head -1
   ```

   It must print the top `version` in `web/src/releases.ts` on `main`. (In the app: Help › What's new.)
2. **Billing is in the state you expect:** `curl -s https://trov.dev/api/billing/config` (public). `available`
   is `true` only with both Stripe secrets set; `mode` is `test` or `live` by the key; `plans.team.purchasable`
   is `true` only with `STRIPE_PRICE_TEAM` set, and `intervals` lists what it can be bought on.
3. **Migrations:** the query in section 3 shows every migration the release's `ops` names.
4. **Sign in** with GitHub and with Google, and open an organization (`https://trov.dev/<slug>/`).
5. **MCP:** in Claude Code, `/mcp` › trov shows connected, and a `get_connection` call answers.
6. **The release's own `ops` checks** — for a mail change, one real send; for a GitHub App change,
   `docs/architecture/github-app.md` › Verify after deploy; for billing, `billing.md` › Owner checklist.
7. The Worker's logs in the dashboard (`[observability]` is on in `wrangler.toml`) show no new error after the first cron tick
   (every ten minutes).

## 7. Rollback

- **The Worker:** `npx wrangler deployments list`, then `npx wrangler rollback [<version-id>]` to the version
  before. It restores the Worker, not the database. Follow it by reverting the merge on `main` — otherwise
  the next merge (or secret change) ships the bad code again.
- **A migration:** every migration since `0043` is additive, and its header carries the statements that undo
  it by hand (`0046_sync_runs`, one added table, states none), to be run together with a Worker rollback to
  the version from before it. Run them with
  `npx wrangler d1 execute trov --remote --command "…"` only after the Worker no longer reads what they drop.
  A migration undone by hand is still recorded in `d1_migrations`: delete its row too, or it will never be
  applied again.
- **`0042_organizations`** is all-or-nothing and has a GENERATED rollback,
  `scripts/mt/rollback/0042_organizations.down.sql` (`scripts/mt/build-rollback.py`; its header lists what is
  lost, and it refuses once a second organization exists).
- **Data:** D1 Time Travel. Note a bookmark BEFORE a risky change (`npx wrangler d1 time-travel info trov`),
  and restore with `npx wrangler d1 time-travel restore trov --bookmark=<bookmark>` inside its window. It
  restores the WHOLE database, every organization's writes since included.
- **A secret:** put the previous value back (`wrangler secret put`); that redeploys (section 4).

## 8. Live state as of release 0.25 (2026-10-09)

Facts from `wrangler.toml`, `web/src/releases.ts` (0.25 `ops`) and the checks in section 6. Re-check before
relying on any of them.

- **Release:** 0.25 is served.
- **Migrations:** through `0051_mcp_connection_orgs`. The numbers `0037`–`0040` and `0050` are unused: no
  such files exist, and none should be added under those numbers.
- **Plans:** Free, Pro (plan id `team`) and Enterprise; Personal is a legacy id, no longer sold
  (`docs/architecture/plans.md`).
- **Billing:** Stripe is in LIVE mode (`GET /api/billing/config` → `available: true`, `mode: "live"`).
  `STRIPE_PRICE_TEAM` is the live Pro per-seat monthly price; `STRIPE_PRICE_TEAM_YEARLY` is empty, so Pro is
  sold monthly only. `STRIPE_TAX = "on"`: Stripe Tax is set up in test and live mode with no registrations,
  so no tax is charged until one is added in Stripe.
- **Mail:** `NOTIFICATIONS_MODE = "resend"` — mail is really sent, from the one platform address.
  `SUPPORT_NOTIFY_EMAIL` is set: bug reports and support messages are mailed to the operator's inbox, which
  must receive mail.
- **GitHub App:** `GITHUB_APP_SLUG` is set; organizations connect repositories by installing it.
- **Previews:** `[previews.vars]` has no GitHub App slug, no Stripe price, no support address and
  `NOTIFICATIONS_MODE = "local"`.
- **Branch builds:** still apply migrations to production (section 3).
- **Plugin:** the Trov plugin's version is in `plugins/trov/.claude-plugin/plugin.json`; people update with
  `claude plugin marketplace update trov` then `claude plugin update trov@trov`.

## 9. Do not

- Do not `git add -A`, `git add .` or `git add <directory>` in the owner's checkout: it holds untracked local
  files (a production data dump among them) that must never be committed. Stage explicit paths, and run
  `git status --short` before every commit.
- Do not edit `migrations/0042_organizations.sql` without re-running `python3 scripts/mt/build-rollback.py`
  (CI fails if the rollback is stale), and keep it ONE file under 100 KB. Never touch a migration production
  has recorded.
- Do not rename the stored contracts that still say "canopy": the `canopy/*` commit-status contexts, the
  `canopy-health` / `canopy-metrics` user-agents, `tickets.source = 'canopy'`, and the accepted `canopy_*`
  token prefixes.
- Do not activate Cloudflare Queues or Vectorize (deferred seams, `CLAUDE.md`).
- Do not run `npm run build:web` under a running `wrangler dev` (it empties `web/dist`).
