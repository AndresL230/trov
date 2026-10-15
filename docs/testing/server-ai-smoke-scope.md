# Server-side AI: smoke-test report scope (Trov prompt `smoke-test-artifact`, step 1)

> Mode: **SUBAGENT** (decided by the owner). This is step 1 (Scope) only; steps 2–7 run AFTER the Phase H e2e run.
> It shares its states with the e2e matrix — `docs/testing/server-ai-test-matrix.md` — and cites its case ids
> instead of repeating them. Read at the same commits as the matrix (its header table), 2026-10-15.

Scope = `git diff main...<branch>` for `ai/screens` (a870c8a1), `ai/phase-c-tickets`, `ai/phase-c-feed`,
`ai/phase-d-digests`, `ai/phase-d-brief`, `ai/phase-d-roadmap`, `ai/phase-e-emails` and `ai/ask` (the Ask
frontend, WIP). Background jobs and the gate are in the e2e matrix only (nothing to look at); they appear here only
where a Run button proves them. "On main?" = the route existed on `main` (needed for before/after); main is
2b7d0183 (PR #186 merged: the Repo Overview there is already the rebuilt one).

## 1. Screens and routes (visual check: yes for all)

| # | item (route) | change | states to capture (matrix ids) | action / backend call to fire (Run button) | on main? |
| --- | --- | --- | --- | --- | --- |
| S1 | Org settings › AI (`#org/ai`) | NEW tab | admin ready, member, no key, capped, empty, loading, load failed, mobile (OA-1, OA-2, OA-12, OA-10, OA-21, OA-24, OA-25; EV-OA-*) | `GET /ai/settings` (200 shape); `PUT /ai/settings {enabled:false}` as member → 403, as admin → 200 **[writes]** | Org settings yes, this tab no → before/after of the tab bar only |
| S2 | Tags (`#org/tags`) Sift cell + New tag modal | changed | no key, org off, Sift off, used up, partly used, modal disabled, member (SF-1…SF-13) | `PUT /tag-settings {enabled:true}` **[writes]**; `POST /tags/test-hosting/run` → busy (SF-14) **[writes]** | yes |
| S3 | Platform › Usage (`/platform/#platform/usage`, `#platform/orgs/test-ent`) | changed | with key (dummy), without key, org open, non-superadmin (PU-1…PU-4) | `GET /api/platform/usage?days=30` | yes |
| S4 | Tickets / Feed / Artifacts filter box (`#tickets`, `#feed`, `#artifacts`) | NEW panel | hidden (no key / off), idle, busy, applied + unmatched, 422, 402, 429 (FL-1…FL-22) | `POST /ai/filter {screen:"tickets", text:"my open bugs"}` → 503 no_key / P:ready 200 / org-at-cap 402 (no network) | yes (screens) |
| S5 | Handoff detail (`#handoffs/1`) reading list | NEW block | after Claim (non-empty), empty, after reload (RL-1…RL-3) | `POST /handoffs/1/claim` **[writes]** | yes |
| S6 | My Work (`#mywork`) Your brief tile | NEW tile, bento layout changes | ready 5 Next, one Next, empty, capped, absent, preview ready / empty / capped (BR-1, BR-3…BR-7, BR-15…BR-17) | `GET /me/dashboard` (`brief` shape); Wrong? → `POST /ai/feedback` **[writes]** | yes |
| S7 | Repo › Overview (`#repo`) State in `data-repo-state-slot` | NEW section over #186's RepoFacts | ready, capped, no event count, absent (malformed / off / Wrong?), over sapling-live (A), found (L), unseen (M), preview × 3 (ST-1…ST-19) | `GET /repo/dashboard` (`state`); Wrong? **[writes]** | yes (#186 Overview) |
| S8 | Repo › Planning (`#repo/planning`) Where the work went | NEW section | admin with proposal, member, proposed only, 8 themes, malformed, quarter, off, preview × 4 (TH-1…TH-18) | `POST /ai/suggestions/5401/accept` (admin 200, member 403) **[writes]**; `/dismiss` **[writes]** | yes (Planning tab) |
| S9 | Feed (`#feed`) Trov entries, Source switch, note, importance marks | changed | Trov entry linked / no subject / unlinked / bad artifacts / many cites, Source All / Agents / Trov, note, marks, off (FD-1…FD-16, FI-1…FI-3) | `GET /feed` (`ai`, `importance`); Got it (localStorage) | yes |
| S10 | Ticket detail (`#tickets/2`) suggestion chips | NEW chips | three chips, reason open, decided (none), done ticket, off, preview (TC-1…TC-15) | `POST /ai/suggestions/5101/accept` **[writes]**, `/5102/dismiss` **[writes]** | yes |
| S11 | Unplaced (`#unplaced`) | NEW mark + chip | doc-shaped with chip, free-form (UP-1, UP-2) | accept 5116 → staged proposal **[writes]** | yes |
| S12 | Review (`#review`) | NEW risk mark + line, Trov's doc-drift proposal, "Flagged in Ask" | list marks, detail line, drift proposal, flags (RV-1, RV-2, RV-7, RV-8) | `GET /proposals`, `GET /adrs?status=draft` (`ai`, `askFlags`); dismiss 5117 **[writes]** | yes |
| S13 | Roadmap (`#roadmap`) Narrative + sprint cards | NEW lines + cards | forecast late / early / none, note, drift, admin cards, member, off, preview (RM-1…RM-17) | accept 5501 (narrative) **[writes]**; accept 5502 (sprint draft) **[writes]** | yes |
| S14 | Settings › Email notifications (`#settings`) | NEW switch "Only when something needs me" | off, on, unsubscribed (EM-17, EM-18) | `PUT /notifications/prefs {onlyWhenNeeded:true}` **[writes]** | yes |
| S15 | The digest e-mails (daily, weekly) | changed layout (brief-led, Also, queue lines, This week) | daily AI on, daily AI off, weekly with highlights, weekly numbers only, skipped (EM-2…EM-16) — rendered from `notification_outbox_bodies` HTML, desktop + 390 px, light + dark | `GET /notifications/preview?cadence=daily|weekly` (admin); `POST /notifications/test-send` **[writes, local mode only]** | yes (main's preview route renders the old layout → before/after) |
| S16 | Sidebar: the "Trov" item | NEW item | collapsed / expanded, mobile | — | yes |
| S17 | Ask Trov (`#ask` — the route name per `ai/ask`) | NEW screen | live, answer, answer-pr, actions-ask, actions-auto, artifact, artifact-saved, search, notfound, streaming, thinking, composer used up / off / low / too large, phone × 3 (AU-1…AU-32) | `GET /ask/state`; `POST /ask` `/search netlify` (keyless SSE); replay `GET /ai/ask-replay/<scenario>?speed=0`; confirm 801201 **[writes]**; undo 801211 **[writes]** | no |
| S18 | ⌘J panel (over any page, e.g. `#tickets/1`) | NEW overlay | open with context, inspector to its left (AU-12) | ⌘J | no |
| S19 | Settings › Trov | NEW section | Pro, Free (AU-16, AU-28) | `PUT /ask/settings {instructions}` **[writes]** | Settings yes, section no |
| S20 | `/terms`, `/privacy` | changed text (Phase G DRAFT) | signed out, mobile (LG-1…LG-3) | — | yes |

## 2. API endpoints (no screen; Run buttons in the report, expected status from the matrix)

| endpoint | new / changed | Run (expected) | matrix |
| --- | --- | --- | --- |
| `GET`/`PUT /api/o/:slug/ai/settings` | new | 200 shape; member PUT 403; bad body 400 | OA-4, OA-8 |
| `POST /api/o/:slug/ai/suggestions/:id/accept`, `/dismiss` | new | 404 bad id, 409 not_open / not_available, 403 theme member, 200 | SG-1…SG-7, TH-8 |
| `POST /api/o/:slug/ai/feedback` | new | 400 without `model`, 200 idempotent | WR-1…WR-3 |
| `POST /api/o/:slug/ai/filter` | new | 400 / 403 off / 402 / 429 / 503 no_key / 200 (P:ready) | FL-5…FL-19 |
| `GET /api/o/:slug/ai/ask-replay[/:scenario]` | new (dev only) | 404 without preview; 200 SSE with | AR-1…AR-10 |
| `/api/o/:slug/ask/*` (state, peek, item, ask, threads, save-form, save, confirm, cancel, undo, attachments, wrong, settings, stop, export) | new | as AK-1…AK-70 | AK-* |
| the gate on both mounts | new mounts | 401 / 404 / 403 cookie-only | G-1…G-61 |
| `GET /me/dashboard` (`brief`), `/repo/dashboard` (`state`, `themes`), `/feed` (`ai`, `importance`), `/tickets/:id` (`ai`), `/needs-triage`, `/proposals`, `/adrs` (`ai`, `askFlags`), `/roadmap`, `/sprints` (forecast, notes, suggestions), `/tags` (`ai`), `/handoffs/:id/claim` (`reading_list`), `/api/platform/usage` (`ai`) | changed | 200 with the new field present / absent per fixture | the screen rows above |
| `/notifications/prefs` (`onlyWhenNeeded`), `/notifications/preview`, `/notifications/test-send` | changed | 200; member preview 403 | EM-17, EM-19, EM-20 |
| MCP `get_my_work`, `get_repo_dashboard`, `get_feed`, `get_roadmap`, `list_sprints`, `get_sprint`, `get_ticket`, `claim_handoff` | changed | the AI fields over MCP; never the preview; never `ai` on `get_ticket` | MC-1…MC-4, BR-14, ST-13, TH-20, RM-14, RL-8 |
| crons: the `*/10` tick (router / pass / `:50` pre-warm), the digest crons | changed | `ai_dirty` rows after a write; nothing runs keyless | JB-1…JB-10, EM-25 |

Skipped (the diff doesn't affect anything to see): `src/ai/{batches,client,jobs,prefix,router,sections}.ts` and the
job modules (no route; covered by JB and the CI evals), `src/tools/{classify,summarize,ticket-mirror}.ts` (summaries
and the mirror read the switch; no new screen), `web/src/releases.ts` (Help › What's new: one look at the 0.34 lines
under S16's sidebar run is enough).

## 3. Tooling, and the before/after build

- **Playwright: present.** `playwright ^1.63.0` is a devDependency (`package.json:34`), Chromium is cached
  (`~/.cache/ms-playwright/chromium-1243`), and the repo already drives it from scripts (`scripts/capture-guide.mjs`,
  `scripts/dev-shot.mjs`). There is NO Playwright test runner config and no `*.spec.ts` / `smoke/` convention yet — the
  report's scripts would be the first; step 7's "regression tests that follow the project's existing e2e
  conventions" has no convention to follow (Vitest + Miniflare is the suite) — **question for the owner**.
- **axe-core: MISSING.** Neither `axe-core` nor `@axe-core/playwright` is installed. Needed: `npm i -D
  @axe-core/playwright` (pulls `axe-core`), or inject `axe-core/axe.min.js` with `page.addScriptTag`. Not installed
  (the owner decides).
- **Widths.** The smoke prompt says 1440 / 390; the e2e matrix uses 360 for phone. Capture 390 for the report and keep
  360 for the e2e EV cases, or ask the owner to pick one.
- **main on a separate port (before/after) — steps, not run:**
  1. `git worktree add ../trov-main-smoke origin/main` (2b7d0183); `ln -s /home/andresl/Projects/trov/node_modules
     node_modules` there; copy `.dev.vars` with `DEV_LOGIN` unset, `LOCAL_AI_PREVIEW` unset, the AI keys blank,
     `NOTIFICATIONS_MODE=local`, `PUBLIC_ORIGIN=http://localhost:8788`.
  2. In THAT worktree (its own default `.wrangler/state`): `npx wrangler d1 migrations apply DB --local`, then
     `node scripts/seed-dev.mjs && node scripts/seed/repo-setups.mjs` — main has no AI tables after 0057 (no
     0058–0067), so `server-ai-e2e.mjs` would skip every section; the before shots use the dev seed's
     org_saplinglearn and #186's fixtures, so compare the same routes there (S2–S16, S20).
  3. `npm run build:web` (in that worktree, before starting it), then `npx wrangler dev --port 8788`.
  4. Sign in with `node scripts/dev-cookie.mjs <id>` after inserting a `sessions` row for `AndresL230` (reset deletes
     sessions). The AI build's server runs on 8787 at the same time from the integration worktree.
  - Expected friction: main lacks `ai_automation` etc., so S1 / S17–S19 have no "before"; the e-mail before/after
    (S15) works through main's own preview route.
- **Safety for the report's Run buttons:** localhost only; every **[writes]** row above is labelled; the reset
  button runs `node scripts/seed/server-ai-e2e.mjs --persist-to <the run's state>` (idempotent).

## 4. Subagent split (step 2, after the e2e run)

One capture subagent per group, each with the seed already applied and its own sign-in cookie; none of them may start
or stop the dev server (one server, started by the coordinator):

1. Org settings › AI, Tags › Sift, Platform › Usage (S1–S3)
2. Filter box, reading list (S4, S5)
3. My Work brief, Repo State + Planning (S6–S8)
4. Feed, ticket / Unplaced / Review cards (S9–S12)
5. Roadmap, Settings › Email notifications, the e-mails (S13–S15)
6. Ask screen, ⌘J, Settings › Trov (S17–S19), replay-driven
7. Sidebar + legal + the API Run list (S16, S20, § 2)
