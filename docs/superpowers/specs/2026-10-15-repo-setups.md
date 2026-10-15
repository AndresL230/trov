# Repo setups: the Repo screen for every repo setup (handoff #11)

Built on `main` at #185 (hosting providers, `0057_hosting_providers`). One branch, `feat/repo-setups`, one PR.
Where this file and the background spec ("Trov repo setups: backend spec") disagree, **this file wins** — it
is the handoff prompt, kept as decided.

**The design** is exported verbatim from Claude Design (project `5bcaced3-c81f-429b-bd0b-e10d6c6f4b8c`) into
`docs/superpowers/specs/repo-setups-design/`: `Repo Prototype.dc.html` (the entry), `RepoScreen.dc.html`,
`OrgSetup.dc.html`, `Sidebar.dc.html`, the block components (`EnvCard`, `AppsTable`, `ProductionCard`,
`PreviewsList`, `DriftStrip`, `NotShipped`, `ReleaseBlock`, `NeedsAttention`, `FoundApps`, `ScopeMenu`,
`UsageTarget`, `Mark`), the canvas pages (Scenarios A–G / H–N, Phone and Dark, Screen Redesign, Setup) and the
data module `repo-data.js` (`trovData`). Its `decide()`, `RULES`, `MARKS` and scenarios A–N are the screen
contract. (`support.js` is the generic `.dc.html` React runtime and carries no design content; it is not
exported.) Step-0 findings: `2026-10-15-repo-setups-step0.md`.

## Migration numbers (reserved)

`main`'s highest is `0057_hosting_providers`. Open PR #178 (`ai/screens`) reserved `0057`–`0066` before #185
took `0057`, so it will renumber into roughly `0058`–`0067`. This build takes **`0070`–`0079`** to stay clear:

| # | Phase | What |
| --- | --- | --- |
| `0070_repo_apps` | A | `repo_apps` (+ a row per existing part key), `hosting_deploys.source` / `reason` / `sha_source` / `rolled_back_from` |
| `0071_repo_settings` | C | `repo_settings` (`overview_group`) |
| `0072_repo_scans` | D | `repo_scans`, `repo_app_suggestions` |
| `0073_commit_paths` | E | `commit_paths`, PR files |
| `0074_releases` | F | `releases` |
| `0075`–`0079` | — | spare (Phase 0 / G if they need one) |

## How it works

**Keep #185's model and add apps on top.**

- **Environments** stay org-wide (`org_environments`), **parts** stay (`org_environment_parts`), and **deploys
  stay provider-first** in `hosting_deploys`.
- **An app is a part key.** `repo_apps(org_id, key, repo, label, folder, kind, watch, release_signal, source,
  position, created_*/updated_*)`, PK `(org_id, key)`.
  - `kind` ∈ Site, Service, Worker, Job, Package. Role follows kind: Site and Worker are `web`; Service and
    Job are `service`; a Package has no parts.
  - A part's `part_key` names its app. A part key with no `repo_apps` row reads as an app at the primary
    repo's root, kind from its role, so nothing existing breaks.
  - The migration writes `repo_apps` rows for every existing part key (SaplingLearn's `frontend`, `backend`).
  - The Repo screen for repo R shows R's apps and their parts. An environment with no part of R's apps is
    hidden on R's screen.
- **A target in the design is a part.** Previews are not parts: they are `hosting_deploys` rows with
  `target = 'preview'` from the app's production part.
- **GitHub becomes a provider.** `github` in the registry: label "GitHub deployments", no credential (it uses
  the App), `deploys: true`, no metrics, `pollCost` 0. Its part settings name a GitHub deployment environment,
  a check run (app slug plus name) or a workflow file. Its deploys are written from webhook capture, never
  polled. Covers Actions-deployed apps (scenario H) and any host with no credential yet.
- **Re-capture GitHub deploy signals, untagged.** `deployment_status` deliveries and commit `status` contexts
  other than `canopy/*` go into `repo_events` as new kinds through the gate, untagged, kept 90 days by
  `pruneRepoCapture`. They feed `detect.ts`, the `github` provider's parts, and the commit join.
- **Every deploy has a commit, or says it doesn't.** `hosting_deploys` gains `source` (`provider` | `github`),
  `reason` (scrubbed failure reason, ≤ 140 chars), `sha_source` (`provider` | `joined` | NULL),
  `rolled_back_from`.
  - Providers that report no sha get one by a **join**: a GitHub signal for the same app on the
    environment's branch that finished within 10 minutes before the deploy. Exactly one candidate sets
    `sha_source = 'joined'`; none or several leave sha NULL. If step 0 confirms the Workers Builds API,
    Cloudflare reads the commit from it instead.
  - Netlify's `error_message`, Vercel's and Render's failure fields, and the GitHub description or check
    `output.title` fill `reason`.
- **Rollback.** A non-preview part's new `ready` deploy whose sha differs from the previous one → one
  `compare` (previous...new). GitHub answers `behind` → set `rolled_back_from`.
- **Previews.** Vercel, Netlify and Render polls read production and preview deploys for a production part
  (`pollCost` +1 where a second list call is needed). Previews are matched to open PRs by branch.

**One facts read, layout in shared code.**

- `GET /repo/dashboard?repo=&app=` stays D1-only, never a 500. `repo` checked against `org_repos`; `app` is
  an app key or `__repo`.
- The Overview's sections become one `facts` object (`shared/repo-facts-core.ts`, zod-free): apps,
  environments, parts with their serving / latest / history deploys, health, out-of-step, previews, not
  shipped, drift steps, CI per environment, release, found, unseen, week figures, attention items, a connect
  hint. Unknown is `null`, never zero. The other tabs keep their sections and take the `app` filter.
- **`decide()`, `RULES` and the group-by override move from `trovData` into `shared/repo-layout-core.ts`
  unchanged.** The SPA and MCP both run it. MCP `get_repo_dashboard` gains `repo` and `app` and returns
  `facts` plus `layout`.
- **Attention is structured on the server** (`{kind, app, env, refs}`) and worded in the SPA.
- **Not shipped** per part: `compare` (serving sha...branch head), grouped by PR, filtered by watch paths.
  **Out of step**: one `compare` per environment where apps serve different shas. **Drift** per adjacent pair
  of environments (the promotion chain). All in reconcile and on a push to the branch; `reconcileCost` counts it.

**Detection suggests; a person decides.**

- `detect.ts` keeps provider-level "Detected". App-level detection:
  - **The repo scan** in reconcile, only when the default branch's root tree sha changed: one tree read plus
    one GraphQL batch of ≤ 24 files.
  - A **detector registry** (`src/repo/detect/<id>.ts`): workspaces (pnpm, package.json, lerna, go.work,
    Cargo), wrangler (name, Pages output dir, `d1_databases`, `triggers.crons`), vercel.json, netlify.toml,
    fly.toml, render.yaml, railway.*, amplify.yml, `.do/app.yaml`, Procfile, Dockerfile plus a deploying workflow.
  - **Seen signals**: untagged GitHub signals from 30 days, matched to candidates by token rules on
    normalised names.
  - **Provider `describe()`** (optional): for a connected host, which folder a project builds (Vercel
    `rootDirectory` and `link.repo`, Render `rootDir`, Netlify `build_settings.base`).
- Results land in `repo_scans` and `repo_app_suggestions`. **Accept** writes `repo_apps` and the parts as that
  admin, audited, with Undo. **Ignore** hides a suggestion until Scan again. A suggestion never changes the
  Repo screen except the found-apps card.

**Usage reads metric families, never provider names.**

- `HOSTING_METRICS` → families: traffic (requests, errors, bandwidth), latency (p50, p95), compute (CPU, memory).
- Cloudflare-only families: outcomes (requests by status), storage (D1), schedules (crons). Outcomes and
  storage extend the Cloudflare poll; quantiles (CPU p50/p99, wall time) read once a day for the completed day,
  stored as daily points; D1 ids and cron schedules come from the scan's wrangler detector, written into the
  part's settings on accept.
- **App metrics contract v3**: self-described labels, groups and shapes (`ranked`, `stats`, `figure`,
  `status`); v1 and v2 still parse. Trov's own `/api/internal/metrics` in v3 (scenario B's Product block).
- The three empty states stay: "Not connected", "Not available from <host>", "No recent reading".

## Phases (each green: `npm test`, `npm run typecheck`; push, PR status comment, `record_session`)

- **Phase 0 — Org settings bugs, one place for each thing.** The Railway leftover-token bug (one card per
  provider; scoped credentials of an org-wide provider are leftovers shown inside the card with "Remove old
  tokens"; labels from how a token was stored; ONE status function for card / part row / checklist / lead /
  Test this part / dashboard copy; "Leftover tokens" in the sample Flow switcher + an agreement test). Then
  Integrations / Hosting / Environments / Repositories › Apps each own one thing (table in the handoff); the
  app-metrics token moves to its part; until Phase D Hosting keeps a compact read-only parts list with Edit.
- **Phase A** — `repo_apps`, the `github` provider, signal re-capture, the deploy columns, the sha join,
  failure reasons, rollback, previews, App event subscriptions (`ops`).
- **Phase B** — `RepoFacts`, `shared/repo-layout-core.ts`, `?repo=&app=` + MCP args; not shipped, out of step,
  chain drift, health per part; scenarios A–N as `RepoFacts` fixtures in `web/src/repo-sample.ts` with a
  `decide()` test per fixture.
- **Phase C** — the Overview blocks as vanilla TS (`web/src/repo-*.ts`), the header (repo menu, App menu,
  environment pills, Group by; default in `repo_settings.overview_group`), week tiles, attention wording, the
  connect card, the sample scenario switch A–N. House rules win over the design. Scenario G's card: with GitHub
  signals, deploys read "via GitHub" and the card asks to connect Railway for CPU and memory only.
- **Phase D** — the scan, detectors, `describe()`, suggestions; Org settings › Repositories › a repo › Apps
  per `OrgSetup`; found-apps (R1) and unseen (R2) cards.
- **Phase E** — monorepos: `commit_paths`, PR files (≤ 3 pages, repos with ≥ 2 apps), the App menu narrowing
  Code and CI, "touches" / "via <package>", CI failures by app.
- **Phase F** — releases: `release` / `create` events, `releases`, backfill, the release block (R3).
- **Phase G** — Usage from families: the Usage tab per `UsageTarget`; Cloudflare outcomes, D1, schedules, daily
  quantiles; app metrics v3 and Trov's own endpoint. Unconfirmed datasets read "not available" with the reason.
- **Phase H** — docs (`repo-dashboard.md`, `hosting-providers.md`, new `repo-apps.md` in CLAUDE.md's table),
  `releases.ts` lines, screenshots (A, B, E, I, L, N; light/dark; desktop/phone), the `ops` list.
- **Last: the end-to-end browser test** (Andres's request, 2026-10-15): the feature driven in a real browser against a
  local D1 seeded per state (`scripts/seed/repo-setups.*`), a test matrix (surfaces × roles × data states ×
  phone/desktop × light/dark), expected-before-actual, evidence per case, one fix + one test + one retest per bug, a
  log at `docs/testing/repo-setups-test-log.md`. Phase H's screenshots come out of this pass, not a separate one; the
  sample scenarios A–N are reused as the screen-state coverage, and the seed adds only what samples cannot show (roles,
  real routes, writes: accept/undo, remove old tokens, repo settings).

## Rules every phase keeps

Ingested is gated, computed is direct; nothing external on a render path; never guess (no sha without a
provider value or exactly one join candidate; no feature claim without a prefix or label; no unconfirmed
Cloudflare figure); credentials only through their resolvers (`github` uses `resolveGithubCredential`); new
tables in `ORG_TABLES`, `scripts/seed/reset.mjs`, handle columns in `HANDLE_COLUMNS`; plan limits unchanged;
the SPA never branches on a provider id.

## Guards (each proven: remove it, show the test failing, restore)

One card per provider and leftovers never counted; card / part row / checklist / Test agree for every sample
combination; the sha join's one-candidate rule; the rollback compare; untagged signals never set a part's
deploy without a matching part setting; the scan's tree-sha skip; suggestions change nothing until accepted;
`decide()` parity SPA ↔ MCP; watch-path filtering; no "not connected" for absent things, per scenario.

## Out of scope

Jev or any model in matching; K's cross-repo Product view; AWS; plan or pricing changes; writing anything to
GitHub or a host.

## Coordination with #178 (`ai/screens`)

#178 adds a `state` block to Repo › Overview (`web/src/repo-ai.ts`, small edits in `web/src/repo.ts`) and
touches `src/repo/cron.ts`. Not merged at the start of this build: the Overview changes here live in new
modules so its `state` block can sit first, above the rule-picked opener.
