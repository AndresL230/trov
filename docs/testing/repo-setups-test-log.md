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

Surfaces × the dimensions that apply. Count: **107 cases** (≤ 150, run without a size check-in).

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
| H1 | Hosting | sapling-live, admin, 1456 desktop, light | ONE Railway card, "Not connected", with one quiet line counting 2 old per-environment tokens and asking to connect once with a workspace token; no "Railway · Staging/Production" cards | spec Phase 0 "One card per provider…", "Leftovers show inside the provider's card" | | | | |
| H2 | Hosting | same | lead counts connections without leftovers: Cloudflare working, Railway not → "1 of 2" (the providers the parts use) | spec "not counted in N of M connections working" | | | | |
| H3 | Hosting › Railway Manage | same | Manage lists each leftover as "Project token (no longer used)" with its environment and last 4, and offers "Remove old tokens" | spec "A leftover reads Project token (no longer used)"; "Manage holds Remove old tokens behind confirmModal" | | | | |
| H4 | Hosting › Remove old tokens | same, write | confirmModal opens (not window.confirm); confirm → `DELETE …/hosting/railway/leftovers` 200; the 2 scoped `railway` rows gone; an `org_admin_audit` `hosting.leftovers_removed` row; the leftover line disappears; Railway still "Not connected" | spec Phase 0; CLAUDE.md confirmModal rule | | | | |
| H5 | Hosting › Cloudflare card | same | metadata says what uses it ("Frontend in Staging and Production") as plain text | spec table "Each card lists what uses it" | | | | |
| H6 | Hosting | same | no environment tiles with part rows; parts are pointed to Repositories › Apps | spec table (Hosting no longer shows tiles; Phase D owns parts) | | | | |
| H7 | Hosting checklist | same | "Connect Railway" step present and not done; agrees with the card's Not connected | spec "One status function … checklist" | | | | |
| H8 | Hosting sample preview | admin, desktop | Flow switcher has "Leftover tokens"; in it Railway card/part rows/checklist all say Not connected | spec "Sample states" | | | | |
| H9 | Test this part (Railway backend) | sapling-live, admin | answers "Railway isn't connected." with a Connect Railway button; never "No secret is set"; no request to Railway | spec "Test this part on an unconnected provider…" | | | | |
| H10 | Hosting | member (meilin) | the Hosting tab is not offered / opening `#org/hosting` refuses (admin-only), no data shown | hosting-providers.md "admins only — ADMIN_TABS" | | | | |
| H11 | Hosting | admin, 360 phone, dark | one card per row, no horizontal scroll, text readable | web-ui.md; hosting-providers.md "one at phone width" | | | | |
| I1 | Integrations | admin | GitHub group present; NO hosting credentials (cloudflare_analytics, railway…); one line linking to Hosting | spec table Integrations | | | | |
| I2 | Integrations | admin | no per-environment "App metrics endpoint" rows (moved to the part) | spec "The app metrics endpoint token moves … to the part" | | | | |
| E1 | Environments | admin | environments with name, branch, drift order, health URL; no parts | spec table Environments | | | | |
| A1 | Repositories | sapling-live, admin | the repo row has an Apps button → `#org/repos/SaplingLearn/sapling`; apps frontend (Worker) and backend (Service) with targets lines | spec Phase D; OrgSetup.dc.html | | | | |
| A2 | App page frontend | same | kind segmented shows Worker; folder "/"; watch paths list; one target row per environment showing the Cloudflare part (Connected) | spec Phase D "an app's page (kind, folder, watch paths, its parts)" | | | | |
| A3 | App page backend | same | target rows show Railway Not connected (same status as Hosting) | spec "One status function" | | | | |
| A4 | Apps (acme/new-thing) | new-org-found, admin | 3 suggestions — web (Site, Vercel), worker (Worker, Cloudflare), shared (Package, no host) — each "Suggested" with its evidence; "Accept all 3" | OrgSetup.dc.html; spec "Results land in … suggestions" | | | | |
| A5 | Accept web | same, write | toast "Accepted web…" with Undo; `repo_apps` web (source suggested) + audit `app.set`; suggestion accepted; the Repo screen now shows web | spec "Accept writes repo_apps … audited, with Undo" | | | | |
| A6 | Undo accept | same, write | within the toast: web removed, suggestion pending again | spec "with Undo" | | | | |
| A7 | Ignore worker | same, write | worker hidden; toast "Ignored worker. Scan again brings it back."; state ignored | spec "Ignore hides a suggestion until Scan again" | | | | |
| A8 | Scan again | same, write | no GitHub credential locally → a calm message saying the scan could not read GitHub (no 500, nothing changed, the error recorded on the scan) | D1 decision: scan refusals are `repo_scans.error` | | | | |
| A9 | Add an app by hand | sapling-live, admin, write | name `test-docs`, folder `apps/docs`, kind Site → saved and listed; audit `app.set` | spec "adding an app by hand" | | | | |
| A10 | Add an app — invalid names | same | `Test Docs`, `<b>x</b>`, an emoji name and a 40-char name are each refused beside the field, nothing saved, no markup rendered | key CHECK `[a-z0-9_-]{1,32}` (0070) | | | | |
| A11 | Add an app — existing key | same | adding `frontend` again does not silently overwrite the existing app | question unless the spec says | | | | |
| A12 | Remove app | same, write | Remove → confirmModal with keep / remove parts (keep default) → removed, toast with Undo | spec "and remove"; D2 | | | | |
| A13 | Signal picker | new-org-found after accepting web | the deploy-signal picker offers only "Production – new-thing-web" (seen 12 times), nothing never seen | spec "the deploy-signal picker (only signals seen in 30 days)" | | | | |
| A14 | Release signal (Package shared) | new-org-found | offers only choices backed by what was seen: no tag option (no tags read), "Not tracked" | D2 / F (tags null until read) | | | | |
| A15 | Apps (test-unseen) | unseen-org, admin | no suggestions; an empty state; Add an app available | OrgSetup "new" screen | | | | |
| A16 | Apps | sapling-live, member | no Apps button; `#org/repos/…` refuses; `GET …/apps` 403 | spec "Accept … as that admin"; cookie admin routes | | | | |
| A17 | Accept double-click | new-org-found, admin, write | double-clicking Accept writes one app (no duplicate row, no error toast) | prompt "duplicate submit" | | | | |
| A18 | Apps | admin, 360 phone | the list and an app page fit without horizontal scroll | web-ui.md | | | | |
| O1 | Overview | sapling-live, admin, desktop, light | opener = environment cards (R6): Staging and Production, a row per app | layout core `decide`: 2 apps, same envs → envCards | | | | |
| O2 | Overview verdicts | same | Staging Healthy (checks pass, both live); Production Failing (backend's newest deploy failed) | repo-apps.md verdict order | | | | |
| O3 | Overview rows | same | Production frontend: "Rolled back from e07b3a2 by andres 8m ago."; backend: "71f0e3a failed 12m ago · Build failed: test-e2e tsc found 2 errors. b4c21de is still serving." | design `rowFor`; seed | | | | |
| O4 | Attention | same | a failed item and a rolled-back item in the design's sentence shapes, hosts by their part label, actions link out (https) | design attentionModel; C1 | | | | |
| O5 | Header pills | same | Staging green dot; Production red diamond; tooltips "Production: Failing. A deploy here failed." | design headerPills; MARKS | | | | |
| O6 | App menu | same | present (2 apps): All apps / frontend / backend / Repo-wide only | design `appMenu` (≥ 2 apps) | | | | |
| O7 | App menu → backend | same | only backend rows; `#repo?app=backend`; `GET /repo/dashboard?…app=backend`; pills recomputed | spec `?app=`; narrowFacts | | | | |
| O8 | App menu → Repo-wide only | same | a short repo-wide note instead of the opener; no app rows | C1 `repoWide` | | | | |
| O9 | Group by | same | offered (2 apps × 2 envs); App → the apps table; admin offered "Make this the default" | design canGroup; spec Phase C | | | | |
| O10 | Make this the default | same, write | `PUT /api/o/saplinglearn/repo/settings` 200; `repo_settings.overview_group = 'app'`; after reload the apps table is the default | spec "group-by default is an admin setting in repo_settings.overview_group" | | | | |
| O11 | Week tiles | same | figures with "vs last week"; unknown → "—", never 0 | design weekModel; never guess | | | | |
| O12 | Connect card | same | Railway not connected → an admin connect card naming Railway with Connect (opens Org settings › Hosting); copy consistent with Railway deploys already shown | spec Phase C connect card | | | | |
| O13 | Not shipped | same | no compare ran locally → nothing claimed: no "up to date", no count | never guess; B2 | | | | |
| O14 | Links row | same | Usage summary from capabilities/connection ("from Cloudflare Workers", Railway not connected), never by provider id | C1 usageSummary | | | | |
| O15 | Overview | sapling-live, member | no connect action (note only), no "Make this the default", no Poll now | spec "only an admin can connect"; C1 | | | | |
| O16 | Overview | admin, 360 phone, light + dark | no horizontal scroll; Group by hidden on phone (design); cards stack | design `[data-phone]`; web-ui.md | | | | |
| O17 | Overview keyboard | admin, desktop | Tab reaches the repository/App menus and Group by; Enter/Space operate them; focus ring visible | web-ui.md focus rings | | | | |
| O18 | Overview (acme) | new-org-found, admin | opener = found (R1): "Trov found 3 apps in acme/new-thing", Accept / Ignore, deploys seen "Production – new-thing-web … 12 times" | decide → found | | | | |
| O19 | Found card Accept + Undo | same, write | toast with Undo; the opener changes after accept (an app with no target → release, R3); Undo restores R1 | decide; D2 wiring | | | | |
| O20 | Overview (test-unseen) | unseen-org, admin | opener = unseen (R2): what it looked for and found none; Tags "4 tags · latest v1.8.0, 6 days ago"; recent tags; "Add an app by hand" | decide → unseen; F readTags | | | | |
| O21 | Week tiles (acme) | new-org-found | PR/CI figures unknown → "—" | never guess | | | | |
| C1 | Code | sapling-live, admin | PR list includes #318; its "touches" cell empty (files never read), never a guessed app | Phase E "unknown never guessed" | | | | |
| C2 | Code, App = backend | same | scope line; #318 NOT listed under backend (unread files), no guess | Phase E | | | | |
| C3 | CI & deploys | same | deploy strips per app × environment ("Production · Frontend"…), failed deploy red | Phase E / repo-dashboard | | | | |
| U1 | Usage | same | a card per target: frontend (Cloudflare, connected) shows figures or "No recent reading"; backend (Railway) "Not connected" with Connect for an admin | Phase G four states | | | | |
| U2 | Usage | same | no "not connected" on a Cloudflare (connected) card | Phase G guard | | | | |
| P1–P20 | Sample preview openers | admin, desktop | A envCards · A/outOfStep envCards · A/trouble envCards · B production · B/failed production · B/trouble production · C production · D production · E appsTable · F appsTable · G appsTable · G/signals appsTable · G/after appsTable · H envCards · I release · J chain · K chain · L found · M unseen · N envCards (N/trov production) | layout core over `repoScenario` (repo-apps.md table) | | | | |
| P21–P44 | Sample screenshots | A, B, E, I, L, N × light/dark × desktop/phone | each draws without overflow or console errors; phone stacks | Phase H screenshots | | | | |
| P45 | Sample writes | L, admin | the found card's Accept/Ignore are disabled with a reason; no request sent | C3 sample rule | | | | |
| P46 | Sample switch | admin | Scenario × Variant dropdowns switch the facts without a reload; leaving sample returns to live | C1 | | | | |
| R1 | Route | admin | `GET /api/o/saplinglearn/repo/dashboard?repo=nope/nope` → 404 `{error}` | B2 | | | | |
| R2 | Route | admin | `…?app=nope` → 200 with `facts.app` null (all apps) | B2 (unknown app = all apps) | | | | |
| R3 | Route | member | `PUT …/repo/settings` → 403 | C1 | | | | |
| R4 | Route | member | `GET …/repos/SaplingLearn/sapling/apps` → 403 | D2 | | | | |
| R5 | Route | admin | a cookie route with an `Authorization` header → 403 | CLAUDE.md invariant 8 | | | | |

## Bugs

_(one row per bug: case id, what, cause, fix commit, test)_

## Questions for Andres

_(cases marked `question`)_

## Final pass

_(the whole matrix rerun from a clean seed after all fixes; suite + typecheck vs baseline)_
