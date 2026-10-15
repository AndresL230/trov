# Repo setups — end-to-end browser test log

Feature: the Repo screen for every repo setup (`feat/repo-setups`, PR #186). Spec: `docs/superpowers/specs/2026-10-15-repo-setups.md`
(+ the design export `docs/superpowers/specs/repo-setups-design/`, area reference `docs/architecture/repo-apps.md`).
Browser: Claude in Chrome against `wrangler dev` on 127.0.0.1 (branch :8811, base `main` :8812), local D1 only.

**Local environment (both branches):** `.dev.vars` = a dummy `COOKIE_SECRET` + `DEV_LOGIN` only — no GitHub, Stripe,
Anthropic, Resend or host keys; `wrangler dev --var NOTIFICATIONS_MODE:local --var PUBLIC_ORIGIN:http://localhost:<port>`
(PUBLIC_ORIGIN must not equal the browsed host, or `canonicalRedirect` sends plain http to https). No platform key → the
"Credentials can't be saved right now" banner shows on Hosting on BOTH branches (an environment fact, not a bug). Nothing
is sent to a real person or service: no case clicks Test connection on a CONNECTED host (that would call a real API with a
dummy token) — Test on an UNCONNECTED host answers without probing (Phase 0).

**Seed:** `node scripts/seed-dev.mjs && node scripts/seed/repo-setups.mjs` (base: `… --base`). Fixtures: `sapling-live`
(org saplinglearn), `new-org-found` (acme), `unseen-org` (test-unseen) — see the script header. Re-run before a session
(health older than 30 min reads stale by design) and after any case that writes.

**Roles:** admin = `DEV_LOGIN=AndresL230` (owner of saplinglearn and test-unseen, admin of acme); member =
`DEV_LOGIN=meilin` (member of saplinglearn). Switching role = restart `wrangler dev` with the other `DEV_LOGIN`.

## Matrix

Surfaces × the dimensions that apply. Count: **109 cases** (≤ 150, run without a size check-in; first drafted as 107, a miscount of the rows below). Result: **85 pass, 23 fail → fixed (12 distinct bugs; P21–P44 counts its 12 phone shots), 1 question**, 3 pre-existing bugs left alone.

| Surface | Dimensions crossed | Cases |
| --- | --- | --- |
| Org settings › Hosting | fixture sapling-live; admin / member; write (remove leftovers); desktop light + phone dark; sample Flow | 11 |
| Org settings › Integrations, Environments | admin | 3 |
| Org settings › Repositories › Apps | 3 fixtures; admin / member; accept / undo / ignore / scan / add / remove; input validation; double submit | 18 |
| Repo › Overview (live) | 3 fixtures; admin / member; App menu (all / one / repo-wide); Group by + default; desktop / phone; light / dark; keyboard | 21 |
| Repo › Code, CI, Usage (live) | sapling-live; all apps / one app | 5 |
| Repo › sample preview | 14 scenarios + variants (20 openers); 6 scenarios × light/dark × desktop/phone (24 shots); sample writes | 46 |
| Routes | unknown repo / app; member on admin routes; bearer on cookie routes | 5 |

**Dropped combinations (cannot occur or not testable locally):** member × Org settings tabs other than a refusal (admin-only
tabs — one refusal case covers them); Test connection on a connected host (would contact a real host); Poll now / Sync GitHub
/ Scan again succeeding (needs a real GitHub credential — the refusal path is tested instead); live monorepo Code/CI narrowing
with captured PR files (needs GitHub; covered by sample scenario E and the render tests); reduced motion (the CSS rule is
pinned by tests; one spot check only); signed-out (DEV_LOGIN always signs in locally).

## Baseline

- **Tests** — branch: typecheck 0 errors; `npm test` 312 files / 7259 tests passing (Phase E's run on this tree; the master
  reruns after the follow-up fixes — see Final pass). Base `main` (6c965ac5): typecheck 0 errors; `npm test` 277 files / 5706 tests, all passing.
- **Pre-existing surfaces on base, same seed** (`docs/testing/repo-setups-shots/base/`): B01 Hosting providers — THREE
  Railway cards ("Railway · Staging / Production — Connected · Workspace token ••5024 / ••51b1 · not used by a part")
  while both Backend parts read "Not connected" (the bug Phase 0 fixes, reproduced); B02 Integrations lists Hosting tokens
  and per-environment app-metrics tokens; B03 Environments; B04 the old Repo Overview (two env cards, Production "Failing").
- **Console / network before touching anything (base):** no console errors on Hosting, Integrations, Environments, Repo.

## Cases

Columns: id · surface · state (fixture, role, viewport, theme) · expected · source · actual · result · evidence · fix.
`expected` is written before the case runs and never edited to match.

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| H1 | Hosting | sapling-live, admin, 1456 desktop, light | ONE Railway card, "Not connected", with one quiet line counting 2 old per-environment tokens and asking to connect once with a workspace token; no "Railway · Staging/Production" cards | spec Phase 0 "One card per provider…", "Leftovers show inside the provider's card" | One Railway card "Not connected" + "2 old per-environment tokens from before Oct 15 aren't used. Connect Railway once with a workspace token. Review old tokens"; no scoped cards | pass | page text; [repo-setups-shots/branch/H1-hosting-one-railway-card.jpg](repo-setups-shots/branch/H1-hosting-one-railway-card.jpg) |  |
| H2 | Hosting | same | lead counts connections without leftovers: Cloudflare working, Railway not → "1 of 2" (the providers the parts use) | spec "not counted in N of M connections working" | "4 parts in 2 environments · 1 of 2 connections working" | pass | page text |  |
| H3 | Hosting › Railway Manage | same | Manage lists each leftover as "Project token (no longer used)" with its environment and last 4, and offers "Remove old tokens" | spec "A leftover reads Project token (no longer used)"; "Manage holds Remove old tokens behind confirmModal" | Dialog "Old tokens · nothing reads them" lists "Project token (no longer used) · Staging · ••••5024" and "· Production · ••••51b1" with Remove old tokens | pass | [repo-setups-shots/branch/H3-railway-old-tokens.jpg](repo-setups-shots/branch/H3-railway-old-tokens.jpg) |  |
| H4 | Hosting › Remove old tokens | same, write | confirmModal opens (not window.confirm); confirm → `DELETE …/hosting/railway/leftovers` 200; the 2 scoped `railway` rows gone; an `org_admin_audit` `hosting.leftovers_removed` row; the leftover line disappears; Railway still "Not connected" | spec Phase 0; CLAUDE.md confirmModal rule | In-page confirm "Remove 2 old Railway tokens?" → DELETE …/hosting/railway/leftovers 200; only cloudflare_analytics (scope '') left; audit hosting.leftovers_removed {scopes:[production,staging],count:2} by AndresL230; line gone; Railway still Not connected | pass | server log, D1 rows, [repo-setups-shots/branch/H4a-confirm-remove.jpg](repo-setups-shots/branch/H4a-confirm-remove.jpg), [repo-setups-shots/branch/H4b-after-remove.jpg](repo-setups-shots/branch/H4b-after-remove.jpg) |  |
| H5 | Hosting › Cloudflare card | same | metadata says what uses it ("Frontend in Staging and Production") as plain text | spec table "Each card lists what uses it" | "API token ••••c0f1 · Frontend in Staging and Production" | pass | page text |  |
| H6 | Hosting | same | no environment tiles with part rows; parts are pointed to Repositories › Apps | spec table (Hosting no longer shows tiles; Phase D owns parts) | No tiles; PARTS shows one line per environment "Parts are set per app in Repositories › SaplingLearn/sapling › Apps →" | pass | page text |  |
| H7 | Hosting checklist | same | "Connect Railway" step present and not done; agrees with the card's Not connected | spec "One status function … checklist" | Checklist "Connect Railway — Used by Staging › Backend, Production › Backend" | pass | page text |  |
| H8 | Hosting sample preview | admin, desktop | Flow switcher has "Leftover tokens"; in it Railway card/part rows/checklist all say Not connected | spec "Sample states" | Flow "Leftover tokens" × Stack "Cloudflare + Railway": card Not connected + leftover line, checklist Connect Railway, lead "1 of 2 connections working" | pass | page text |  |
| H9 | Test this part (Railway backend) | sapling-live, admin | answers "Railway isn't connected." with a Connect Railway button; never "No secret is set"; no request to Railway | spec "Test this part on an unconnected provider…" | "Railway isn't connected. Its parts read nothing until it is." + Connect Railway (disabled: no platform key locally); no request at all (answered client-side) | pass | server log (no /test call), [repo-setups-shots/branch/A3-H9-backend-test-not-connected.jpg](repo-setups-shots/branch/A3-H9-backend-test-not-connected.jpg) |  |
| H10 | Hosting | member (meilin) | the Hosting tab is not offered / opening `#org/hosting` refuses (admin-only), no data shown | hosting-providers.md "admins only — ADMIN_TABS" | meilin's tabs: Repositories, Environments, Members, Tags, General; #org/hosting shows no provider data | pass | page text |  |
| H11 | Hosting | admin, 360 phone, dark | one card per row, no horizontal scroll, text readable | web-ui.md; hosting-providers.md "one at phone width" | 390px (in an iframe — the automation window cannot resize): no horizontal scroll (scrollWidth 390), banner/cards stack, dark readable | pass | [repo-setups-shots/branch/O16-H11-A18-phone-light-overview-apps-hosting.jpg](repo-setups-shots/branch/O16-H11-A18-phone-light-overview-apps-hosting.jpg), [repo-setups-shots/branch/O16-H11-A18-phone-dark-overview-apps-hosting.jpg](repo-setups-shots/branch/O16-H11-A18-phone-dark-overview-apps-hosting.jpg) |  |
| I1 | Integrations | admin | GitHub group present; NO hosting credentials (cloudflare_analytics, railway…); one line linking to Hosting | spec table Integrations | GitHub group only + "Hosting credentials (Cloudflare, Railway, Vercel and the rest) are set on Hosting. An app's metrics token is set in its part's editor, under Repositories › a repository › Apps. Open Hosting →" | pass | page text; base B02 for contrast |  |
| I2 | Integrations | admin | no per-environment "App metrics endpoint" rows (moved to the part) | spec "The app metrics endpoint token moves … to the part" | No per-environment App metrics rows | pass | page text |  |
| E1 | Environments | admin | environments with name, branch, drift order, health URL; no parts | spec table Environments | Name, drift head/base, branch, URLs, no parts — but the link read "What each one runs is in Hosting" (Hosting only points on to Repositories) | fail → fixed | page text | 8f858a30 (E1b) |
| A1 | Repositories | sapling-live, admin | the repo row has an Apps button → `#org/repos/SaplingLearn/sapling`; apps frontend (Worker) and backend (Service) with targets lines | spec Phase D; OrgSetup.dc.html | Apps button → #org/repos/SaplingLearn/sapling: Frontend (Worker · Cloudflare Workers), Backend (Service · Railway), "Staging from main · Production from production". Nit: "Scan again" on a never-scanned repo | pass | [repo-setups-shots/branch/A1-apps-list.jpg](repo-setups-shots/branch/A1-apps-list.jpg) |  |
| A2 | App page frontend | same | kind segmented shows Worker; folder "/"; watch paths list; one target row per environment showing the Cloudflare part (Connected) | spec Phase D "an app's page (kind, folder, watch paths, its parts)" | Kind segmented (Worker), Folder /, Watch paths /, target rows = Hosting's part rows (Connected) | pass | [repo-setups-shots/branch/A2-app-frontend.jpg](repo-setups-shots/branch/A2-app-frontend.jpg) |  |
| A3 | App page backend | same | target rows show Railway Not connected (same status as Hosting) | spec "One status function" | Railway parts Not connected, as on Hosting | pass | [repo-setups-shots/branch/A3-H9-backend-test-not-connected.jpg](repo-setups-shots/branch/A3-H9-backend-test-not-connected.jpg) |  |
| A4 | Apps (acme/new-thing) | new-org-found, admin | 3 suggestions — web (Site, Vercel), worker (Worker, Cloudflare), shared (Package, no host) — each "Suggested" with its evidence; "Accept all 3" | OrgSetup.dc.html; spec "Results land in … suggestions" | 3 suggestions with ring "Suggested", kind · host, evidence incl. "GitHub deployment “Production – new-thing-web” seen 12 times"; "Accept all 3"; "Nothing changes until you accept them" (first run showed the signal as unassigned — my seed wrote the evidence signal in the wrong format; fixed in the seed) | pass | page text | seed only |
| A5 | Accept web | same, write | toast "Accepted web…" with Undo; `repo_apps` web (source suggested) + audit `app.set`; suggestion accepted; the Repo screen now shows web | spec "Accept writes repo_apps … audited, with Undo" | Toast "Accepted web. The Repo screen now shows it. · Undo"; repo_apps web (apps/web, Site, source suggested, by AndresL230); suggestion accepted; audit app.set; POST accept 200 | pass | D1 rows, server log |  |
| A6 | Undo accept | same, write | within the toast: web removed, suggestion pending again | spec "with Undo" | Undo → "Undone.", shared pending again; app row gone; POST undo 200 (first run: "The undo token is not valid" — my seed's ids were not the scan's sg_ format; fixed in the seed) | pass | D1 rows, server log | seed only |
| A7 | Ignore worker | same, write | worker hidden; toast "Ignored worker. Scan again brings it back."; state ignored | spec "Ignore hides a suggestion until Scan again" | "Ignored worker. Scan again brings it back. · Undo"; worker hidden; "Accept all 2"; state ignored | pass | D1 row, server log |  |
| A8 | Scan again | same, write | no GitHub credential locally → a calm message saying the scan could not read GitHub (no 500, nothing changed, the error recorded on the scan) | D1 decision: scan refusals are `repo_scans.error` | Toast "The last scan could not run: GitHub isn't connected for this repository"; POST scan 200; nothing changed — but the line above it read "scanned just now" (a refused scan stamped scanned_at) | fail → fixed | page text, D1 repo_scans row | 01733d93 (A8b) |
| A9 | Add an app by hand | sapling-live, admin, write | name `test-docs`, folder `apps/docs`, kind Site → saved and listed; audit `app.set` | spec "adding an app by hand" | "Added test-docs to SaplingLearn/sapling."; opens its page; repo_apps test-docs (apps/docs, Site, manual); PUT 201; audit app.set | pass | D1 rows, server log |  |
| A10 | Add an app — invalid names | same | `Test Docs`, `<b>x</b>`, an emoji name and a 40-char name are each refused beside the field, nothing saved, no markup rendered | key CHECK `[a-z0-9_-]{1,32}` (0070) | All four refused beside the field "1 to 32 characters: a to z, 0 to 9, - or _."; nothing saved; no markup rendered | pass | DOM |  |
| A11 | Add an app — existing key | same | adding `frontend` again does not silently overwrite the existing app | question unless the spec says | "An app called frontend exists already." and Add app disabled (client-side; the PUT is an edit by design) | pass | DOM |  |
| A12 | Remove app | same, write | Remove → confirmModal with keep / remove parts (keep default) → removed, toast with Undo | spec "and remove"; D2 | In-page confirm with Keep them / Remove them too (keep default) → "Removed test-docs. Its parts stay in their environments. · Undo"; row gone, part kept, audit app.delete. test-docs then lists as an implicit root app (the dialog says so) — see Questions | pass | DOM, D1 rows |  |
| A13 | Signal picker | new-org-found after accepting web | the deploy-signal picker offers only "Production – new-thing-web" (seen 12 times), nothing never seen | spec "the deploy-signal picker (only signals seen in 30 days)" | Staging picker offers "Deployment “Production – sapling-docs” · Vercel · 3 times · last 5h ago" and "Workflow deploy-docs.yml · 1 time", not the 40-day-old "Preview – stale-thing"; Save → github part {environment:"Production – sapling-docs"} and its 3 deploys filled from history (source github) | pass | DOM, D1 rows |  |
| A14 | Release signal (Package shared) | new-org-found | offers only choices backed by what was seen: no tag option (no tags read), "Not tracked" | D2 / F (tags null until read) | shared (Package, acme): only "Not tracked" (no tags read, no environments). On SaplingLearn the release choice offered "A workflow run of deploy-docs.yml on production · Seen 1 time" for a run seen on main only | fail → fixed | DOM | 4b3e0d6f (A14b) |
| A15 | Apps (test-unseen) | unseen-org, admin | no suggestions; an empty state; Add an app available | OrgSetup "new" screen | Empty state "Nothing to suggest. Trov looked for … and railway.json and more and at the deploys GitHub reported." (doubled "and") | fail → fixed | page text | 161ca1ff (A15b) |
| A16 | Apps | sapling-live, member | no Apps button; `#org/repos/…` refuses; `GET …/apps` 403 | spec "Accept … as that admin"; cookie admin routes | No Apps button; the deep link shows only the read-only repository list; GET …/apps 403 | pass | DOM, fetch |  |
| A17 | Accept double-click | new-org-found, admin, write | double-clicking Accept writes one app (no duplicate row, no error toast) | prompt "duplicate submit" | Two clicks → one POST accept, one repo_apps row | pass | server log, D1 |  |
| A18 | Apps | admin, 360 phone | the list and an app page fit without horizontal scroll | web-ui.md | 390px: list and app page fit, no horizontal scroll | pass | [repo-setups-shots/branch/O16-H11-A18-phone-light-overview-apps-hosting.jpg](repo-setups-shots/branch/O16-H11-A18-phone-light-overview-apps-hosting.jpg) |  |
| O1 | Overview | sapling-live, admin, desktop, light | opener = environment cards (R6): Staging and Production, a row per app | layout core `decide`: 2 apps, same envs → envCards | Environment cards Staging + Production, a row per app (after a reseed; with A12's implicit test-docs on staging only the rules correctly picked the apps table) | pass | [repo-setups-shots/branch/O1-overview-env-cards-light-desktop.jpg](repo-setups-shots/branch/O1-overview-env-cards-light-desktop.jpg) |  |
| O2 | Overview verdicts | same | Staging Healthy (checks pass, both live); Production Failing (backend's newest deploy failed) | repo-apps.md verdict order | Staging Healthy; Production Failing | pass | page text, pills |  |
| O3 | Overview rows | same | Production frontend: "Rolled back from e07b3a2 by andres 8m ago."; backend: "71f0e3a failed 12m ago · Build failed: test-e2e tsc found 2 errors. b4c21de is still serving." | design `rowFor`; seed | "Rolled back from e07b3a2 by andres 7m ago." / "71f0e3a failed 12m ago · Build failed: test-e2e tsc found 2 errors. b4c21de is still serving." | pass | page text |  |
| O4 | Attention | same | a failed item and a rolled-back item in the design's sentence shapes, hosts by their part label, actions link out (https) | design attentionModel; C1 | Sentences right but with FULL 40-char shas ("deploy 71f0e3afffff… failed"); the apps table's Production chip also 40 chars | fail → fixed | page text | 6c016969 (O4) |
| O5 | Header pills | same | Staging green dot; Production red diamond; tooltips "Production: Failing. A deploy here failed." | design headerPills; MARKS | data-verdict healthy / failing; tips "Staging: Healthy. Checks pass…", "Production: Failing. A deploy here failed." | pass | DOM |  |
| O6 | App menu | same | present (2 apps): All apps / frontend / backend / Repo-wide only | design `appMenu` (≥ 2 apps) | All apps / Frontend / Backend / Repo-wide only (no PR count where unknown) | pass | DOM |  |
| O7 | App menu → backend | same | only backend rows; `#repo?app=backend`; `GET /repo/dashboard?…app=backend`; pills recomputed | spec `?app=`; narrowFacts | #repo?app=backend; only Backend rows; frontend item gone; GET …/repo/dashboard?app=frontend 200 seen on the next switch | pass | DOM, network |  |
| O8 | App menu → Repo-wide only | same | a short repo-wide note instead of the opener; no app rows | C1 `repoWide` | "Files outside every app — … Deploys belong to apps, so none is shown here"; no rows, no pills | pass | page text |  |
| O9 | Group by | same | offered (2 apps × 2 envs); App → the apps table; admin offered "Make this the default" | design canGroup; spec Phase C | Group by App → apps table; "Make this the default" offered after the flip | pass | [repo-setups-shots/branch/O9-overview-apps-table-light-desktop.jpg](repo-setups-shots/branch/O9-overview-apps-table-light-desktop.jpg) |  |
| O10 | Make this the default | same, write | `PUT /api/o/saplinglearn/repo/settings` 200; `repo_settings.overview_group = 'app'`; after reload the apps table is the default | spec "group-by default is an admin setting in repo_settings.overview_group" | Toast "Group by app is now the default for SaplingLearn/sapling."; PUT 200; repo_settings app by AndresL230; audit repo.settings; facts.groupDefault "app" from the server | pass | D1, fetch |  |
| O11 | Week tiles | same | figures with "vs last week"; unknown → "—", never 0 | design weekModel; never guess | Figures right, but Open PRs / Releases read "unknown until Railway is connected" (they wait on GitHub capture, not Railway) | fail → fixed | page text | f5c4e81e (O11) |
| O12 | Connect card | same | Railway not connected → an admin connect card naming Railway with Connect (opens Org settings › Hosting); copy consistent with Railway deploys already shown | spec Phase C connect card | Card said "Railway does not report deploys to GitHub, so Trov cannot see what is running" beside the Railway deploys it showed (and Railway does post GitHub deployments) | fail → fixed | page text | f5c4e81e (O12) |
| O13 | Not shipped | same | no compare ran locally → nothing claimed: no "up to date", no count | never guess; B2 | Every not-shipped count null → "Unknown", never "Up to date" | pass | fetch facts, DOM |  |
| O14 | Links row | same | Usage summary from capabilities/connection ("from Cloudflare Workers", Railway not connected), never by provider id | C1 usageSummary | "Usage → from Cloudflare Workers" | pass | page text |  |
| O15 | Overview | sapling-live, member | no connect action (note only), no "Make this the default", no Poll now | spec "only an admin can connect"; C1 | No Poll now, no Make this the default, no Connect button — but no connect card at all for a member (the design says members see the note) | fail → fixed | DOM | b47dd792 (O15b) |
| O16 | Overview | admin, 360 phone, light + dark | no horizontal scroll; Group by hidden on phone (design); cards stack | design `[data-phone]`; web-ui.md | 390px (iframe): no horizontal scroll; the apps table scrolls inside its own scroller (nothing lost). But the phone drew the apps table from the admin default, while Group by is hidden there (design: phones draw the rules' opener) | fail → fixed | [repo-setups-shots/branch/O16-phone-before-fix-apps-table.jpg](repo-setups-shots/branch/O16-phone-before-fix-apps-table.jpg) → [repo-setups-shots/branch/O16-H11-A18-phone-light-overview-apps-hosting.jpg](repo-setups-shots/branch/O16-H11-A18-phone-light-overview-apps-hosting.jpg) | 69e88173 (O16b) |
| O17 | Overview keyboard | admin, desktop | Tab reaches the repository/App menus and Group by; Enter/Space operate them; focus ring visible | web-ui.md focus rings | Header controls are native tabbable buttons; ↓ opens the App menu, Escape closes onto its trigger; a focus-visible rule exists. (Real key presses do not reach the hidden automation window — checked with dispatched key events) | pass | DOM |  |
| O18 | Overview (acme) | new-org-found, admin | opener = found (R1): "Trov found 3 apps in acme/new-thing", Accept / Ignore, deploys seen "Production – new-thing-web … 12 times" | decide → found | Found card right, but each evidence line read "from from apps/web/vercel.json" | fail → fixed | [repo-setups-shots/branch/O18-found-card-dark-desktop.jpg](repo-setups-shots/branch/O18-found-card-dark-desktop.jpg) | 697097fa (O18b) |
| O19 | Found card Accept + Undo | same, write | toast with Undo; the opener changes after accept (an app with no target → release, R3); Undo restores R1 | decide; D2 wiring | "Accepted. The Repo screen now shows it. · Undo"; after it the Overview had NO opener (rule R3 with no release draws nothing — the design's own rule); Undo restored R1 | question | DOM |  |
| O20 | Overview (test-unseen) | unseen-org, admin | opener = unseen (R2): what it looked for and found none; Tags "4 tags · latest v1.8.0, 6 days ago"; recent tags; "Add an app by hand" | decide → unseen; F readTags | "Trov does not see deploys for this repository", what it looked for, "4 tags; the latest is v1.8.0, 6 days ago", 4 recent tags, Add an app by hand; Releases tile "1 ▲ 1 vs last week" | pass | [repo-setups-shots/branch/O20-unseen-card-dark-desktop.jpg](repo-setups-shots/branch/O20-unseen-card-dark-desktop.jpg) |  |
| O21 | Week tiles (acme) | new-org-found | PR/CI figures unknown → "—" | never guess | All week figures "— not known yet" | pass | page text |  |
| C1 | Code | sapling-live, admin | PR list includes #318; its "touches" cell empty (files never read), never a guessed app | Phase E "unknown never guessed" | #318 "In review · 40m", touches cell empty (files unread) — after adding the prs_reconciled marker to the seed; before it the documented pre-capture fallback showed recently closed PRs | pass | page text | seed only |
| C2 | Code, App = backend | same | scope line; #318 NOT listed under backend (unread files), no guess | Phase E | Scope "Pull requests that touch the whole repository"; #318 not listed; tiles "— 1 pull request not read yet", "— 2 commits with paths unknown" | pass | page text |  |
| C3 | CI & deploys | same | deploy strips per app × environment ("Production · Frontend"…), failed deploy red | Phase E / repo-dashboard | Deploy history per app × environment; Backend Production "1 of 2 succeeded" | pass | page text |  |
| U1 | Usage | same | a card per target: frontend (Cloudflare, connected) shows figures or "No recent reading"; backend (Railway) "Not connected" with Connect for an admin | Phase G four states | Frontend Staging/Production "from Cloudflare Workers" with figures; Backend cards "Not connected" + Connect Railway. Product block said the token "is set in Org settings › Integrations" (moved in Phase 0) | fail → fixed | [repo-setups-shots/branch/U1-usage-dark-desktop.jpg](repo-setups-shots/branch/U1-usage-dark-desktop.jpg) | 43fa8eaf (U3) |
| U2 | Usage | same | no "not connected" on a Cloudflare (connected) card | Phase G guard | No "not connected" on the Cloudflare cards | pass | page text |  |
| P1–P20 | Sample preview openers | admin, desktop | A envCards · A/outOfStep envCards · A/trouble envCards · B production · B/failed production · B/trouble production · C production · D production · E appsTable · F appsTable · G appsTable · G/signals appsTable · G/after appsTable · H envCards · I release · J chain · K chain · L found · M unseen · N envCards (N/trov production) | layout core over `repoScenario` (repo-apps.md table) | All 21 openers as expected (A, A/outOfStep, A/trouble, H, J, K, N → env cards; B, B/failed, B/trouble, C, D, N/trov → production; E, F, G, G/signals, G/after → apps table; I → release; L → found; M → unseen). chain and envCards draw the same blocks (env cards + drift), so J/K read as env cards in the DOM; no console errors, no overflow at 1300px | pass | DOM (opener block per scenario) |  |
| P21–P44 | Sample screenshots | A, B, E, I, L, N × light/dark × desktop/phone | each draws without overflow or console errors; phone stacks | Phase H screenshots | All 24 draw without page overflow or console errors (desktop 1300px, phone 390px iframe; light and dark). First pass: on a phone the repository scope menu in the header collapsed to an empty chip (inline-size containment from the phone crumb rule gave it no width) | fail → fixed | [repo-setups-shots/sample/](repo-setups-shots/sample/) (before: zz-before-fix-I-L-N-light-phone.jpg) | 0ae2c293, 7ef3d95b (P-phone) |
| P45 | Sample writes | L, admin | the found card's Accept/Ignore are disabled with a reason; no request sent | C3 sample rule | L: every Accept / Ignore disabled with the tip "Sample data: nothing is changed."; clicking one sends no request | pass | DOM, resource timing |  |
| P46 | Sample switch | admin | Scenario × Variant dropdowns switch the facts without a reload; leaving sample returns to live | C1 | Scenario and Variant dropdowns switch the facts in place (same document, no navigation); Leave sample returns to the live facts (the live attention items and the saved group default come back) | pass | DOM, navigation timing |  |
| R1 | Route | admin | `GET /api/o/saplinglearn/repo/dashboard?repo=nope/nope` → 404 `{error}` | B2 | 404 {error:"unknown repository"} | pass | fetch |  |
| R2 | Route | admin | `…?app=nope` → 200 with `facts.app` null (all apps) | B2 (unknown app = all apps) | 200, facts.app null, apps [frontend, backend] | pass | fetch |  |
| R3 | Route | member | `PUT …/repo/settings` → 403 | C1 | 403 {error:"admin only"} | pass | fetch (meilin) |  |
| R4 | Route | member | `GET …/repos/SaplingLearn/sapling/apps` → 403 | D2 | 403 {error:"forbidden"} | pass | fetch (meilin) |  |
| R5 | Route | admin | a cookie route with an `Authorization` header → 403 | CLAUDE.md invariant 8 | 403 forbidden on GET …/apps and PUT …/repo/settings with an Authorization header | pass | fetch |  |

## Bugs

All found by this pass and fixed on the feature branch (one bug → one test → one fix → retest), then retested in the final pass.

| case | what | cause | fix | test |
|---|---|---|---|---|
| A8b | A refused scan (no GitHub credential) showed "scanned just now" above "the last scan could not run" | the refusal path stamped `repo_scans.scanned_at` like a successful scan | 01733d93 | test/repo-scan.test.ts |
| A14b | A workflow release signal was offered on a branch the workflow never ran on | `seenSignals` kept workflow runs per file, not per branch | 4b3e0d6f | test/repo-scan.test.ts, test/render.repo-apps.test.ts |
| A15b | "… railway.json and more and at the deploys GitHub reported" (doubled "and") | the looked-for list and the GitHub clause were each joined with "and" | 161ca1ff | test/render.repo-apps.test.ts |
| O4 | Attention sentences and the apps table's sha chip showed full 40-char shas | the server sends full shas; those paths skipped the 7-char cut | 6c016969 | test/render.repo-overview.test.ts |
| O11 | Week tiles said Open PRs / Releases were "unknown until Railway is connected" | the "host not connected" reason was applied to every unknown figure, not only deploy figures | f5c4e81e | test/render.repo-overview.test.ts |
| O12 | The connect card / unknown rows said "Railway does not report deploys to GitHub" beside the Railway deploys it showed | the copy assumed every unconnected host is invisible to GitHub | f5c4e81e | test/render.repo-env-cards.test.ts, test/render.repo-production.test.ts |
| O15b | A member saw no connect card at all (the design shows members the note) | the server built the connect hint only for admins (my Phase B2 prompt asked for that) | b47dd792 | test/repo-facts.test.ts |
| O16b | A phone drew the apps table from the admin's saved default although Group by is hidden there | the layout honoured the default / session flip on a phone | 69e88173 | test/render.repo-overview.test.ts |
| O18b | Found-card evidence read "from from apps/web/vercel.json" | the renderer prefixed "from" to evidence the scan already writes as a sentence | 697097fa | test/render.repo-found.test.ts |
| U3 (case U1) | Usage › Product and Poll now's App metrics line pointed to Org settings › Integrations | the copy was not updated when Phase 0 moved the token to the part editor | 43fa8eaf | test/render.repo.test.ts |
| E1b | Environments said "What each one runs is in Hosting" (Hosting only points on to Repositories) | stale link copy from before Phase D | 8f858a30 | test/render.org-settings.test.ts |
| P-phone | On a phone the repository scope menu collapsed to an empty chip | the phone header's crumb rule (`contain: inline-size`) also hit the scope menu | 0ae2c293, 7ef3d95b | test/render.phone.test.ts |

Seed-only fixes (not product bugs; `scripts/seed/repo-setups.mjs`): the evidence signal format, scan suggestion ids (`sg_…`),
the `prs_reconciled` marker, the picker's seen signals.

## Questions for Andres

- **O19**: after accepting a found app that has no target and no release, rule R3 draws nothing (the design's own rule), but the
  toast says "The Repo screen now shows it." Keep the rule and change the toast, or draw something for R3 with no release?
- **A12**: "Remove app, keep its parts" leaves the parts in place, so the folder lists again as an implicit root app. The design
  says "the deploy name is unassigned again". Is the implicit app right, or should kept parts stop implying an app?
- **CLAUDE.md invariant 8**: the wording now names `/api/internal/metrics` beside `/mcp` as a bearer surface. Please confirm.

## Pre-existing (seen, not fixed; also on `main`)

- The guided setup says "Connect a repository: to do" with a repository connected.
- The Merged PRs week tile reads 0 (counted from events) where it is really unknown before capture.
- The Poll now strip's Health line points to Integrations.

## Final pass

From a clean seed after every fix, the whole matrix was rerun in the browser (admin, then member with `DEV_LOGIN=meilin`, then
admin restored): every case passes, except O19, which is still the question it was. DB checks rerun for H4, A5–A7, A9, A12,
A13 (3 github deploys backfilled on test-docs), A17 and O10.

- **Suite:** `npm test` 312 files / 7275 tests passing (base `main`: 277 / 5706; no test removed or failing).
- **Typecheck:** `npm run typecheck` 0 errors (base 0).
- **Console:** no errors on any surface or sample scenario.
- **Environment notes:** the automation window ended up 567px wide (phone layout), so desktop cases ran in a 1300px
  same-origin iframe reloaded after sizing (a media-query change event does not fire in a hidden window), and phone cases in a
  390px one. Real key presses do not reach the hidden window, so keyboard cases use dispatched key events.

Screenshots: [base](repo-setups-shots/base/), [branch](repo-setups-shots/branch/), [sample](repo-setups-shots/sample/).
