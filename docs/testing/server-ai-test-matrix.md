# Server-side AI: the end-to-end test matrix (Phase H, step 1)

> **675 CASES — OVER THE 150 THRESHOLD. Per the e2e spec § 1.4 the owner must see this matrix and this count BEFORE the run starts.** 442 functional (per surface: G 61 · OA 26 · SF 18 · PU 6 · FL 25 · RL 10 · SG 7 · WR 5 · BR 19 · ST 19 · TH 21 · FD 19 · FI 7 · TC 15 · UP 4 · RV 9 · RM 17 · EM 25 · AK 70 · AR 10 · AU 32 · JB 10 · MC 4 · LG 3) + 181 environment (§ 6) + 52 motion (§ 7). A principled reduction is proposed in § 10 and NOT applied. 62 questions for the owner are in § 9.

The map the Phase H browser run works from (`docs/superpowers/specs/2026-10-15-server-ai-e2e.md` § 1). Every case
has its EXPECTED result and the line it comes from, written BEFORE the run; `question (Qn)` where the spec and the
code are silent (§ 9 lists them for the owner). The seed is `scripts/seed/server-ai-e2e.mjs` (§ 2); the state column
names its fixtures. The smoke-test scope that shares these case ids is `docs/testing/server-ai-smoke-scope.md`.

**What it was read at (2026-10-15, ~14:30Z).** Nothing here is merged into `ai/screens` unless it says so; line
numbers are at these commits and will move on merge — re-check a cited line before marking a case `fail`.

| branch | commit | what it adds (surfaces) |
| --- | --- | --- |
| `ai/screens` | a870c8a1 (themes + Phase G merged in; the map's line refs are mostly @1d249811) | Phase A switch + Org settings › AI, Phase B router / pass, the filter (#162), the reading list (#167), Ask's backend (0066), themes (0064), the Wave 2 frontend (brief tile, Repo State, Where the work went, Trov feed entries + Source switch, the suggestion chip, Platform › Usage AI lines) — all fed by `LOCAL_AI_PREVIEW` until their producers merge; Phase G legal drafts |
| `ai/phase-c-tickets` | 5220660d (mapped @4f9f75f5) | ticket / Unplaced / Review cards (`ai_suggestions`), accept handlers |
| `ai/phase-c-feed` | 259d63f5 (mapped @dcb2592d) | 0060 importance on feed + PR summaries, Sift on new items |
| `ai/phase-d-digests` | d05a8e2c (mapped @3370686b) | 0061 Trov feed entries, 0062 `repo_state` |
| `ai/phase-d-brief` | 2aaeccd7 (mapped @867967cc) | 0063 `person_brief`, the brief job, `mywork_opened_at` |
| `ai/phase-d-themes` | f939b928 — **merged** into `ai/screens` | 0064 themes |
| `ai/phase-d-roadmap` | a7db2c93 (mapped @8486e4ad) | 0065 `org_insights`: forecast, sprint notes, drift, sprint drafts, narrative, doc drift |
| `ai/phase-e-emails` | 47cc7025 (WIP) | 0067 `digest_email` (`notification_person_prefs`, `digest_highlights`), the brief-led daily, the weekly recap |
| `ai/ask` | 2987ef30 (WIP frontend) | Ask Trov's frontend from handoff #12 (no screen on `ai/screens` yet) |
| `origin/main` | 2b7d0183 (PR #186 Repo setups, about to be merged into `ai/screens`) | RepoFacts (`readRepoFacts`), the rebuilt Repo Overview, migrations 0070–0074, the A–N sample scenarios |

## 0. How to read and run it

- **Ids.** `<SURFACE>-<n>`. Every row of every table below whose first cell is an id is ONE case. § 6 (environment)
  and § 7 (motion) are grids: each filled cell is one case, id `EV-<surface>-<state>-<env>` / `MO-<surface>-<n>`.
- **Defaults.** Unless the state column says otherwise: org `test-ent` (fixture `org-enterprise`), signed in as
  `test-member` by cookie (`test-session-test-member`), desktop 1440×900, light theme, motion allowed,
  `LOCAL_AI_PREVIEW` **unset**, `ANTHROPIC_API_KEY` / `TYPESAFE_API_KEY` **blank** (§ 0.2), `NOTIFICATIONS_MODE=local`,
  `PUBLIC_ORIGIN=http://localhost:8787`, `DEV_LOGIN` **unset**.
- **Who** (seed people; every one has a session row `test-session-<handle>`): `owner` = test-owner, `admin` =
  test-admin, `member` = test-member (also: test-member2), `outsider` = test-outsider (owner of `test-other` only),
  `superadmin` = test-superadmin (platform admin, member of nothing), `signed out` = no cookie, `bearer` = the
  `bearer-token` fixture sent as `Authorization: Bearer …` WITH a cookie.
- **Env shorthands.** `P:<mode>` = `.dev.vars LOCAL_AI_PREVIEW=<mode>` (ready / empty / capped / proposed; restart
  `wrangler dev`). `K:dummy` = a NON-EMPTY fake `ANTHROPIC_API_KEY` used ONLY where the request is refused before any
  network call (capped / off) — any other request with it would call Anthropic and is forbidden (§ 0.2).
  `360` = 360×780 viewport, `dark` = emulated `prefers-color-scheme: dark`, `RM` = emulated `prefers-reduced-motion`.
- **Columns.** id · state (fixture · who · env) · act · expected · source. "absent" = the field is not in the JSON
  and nothing is drawn (byte-identical to before). `Wrong?` = the thumbs-down control.

### 0.1 Setting up a run

```
# in the integration worktree, after every phase is merged into ai/screens (and main's #186 with it):
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e   # a throwaway state, never another worktree's
node scripts/seed/server-ai-e2e.mjs --persist-to .wrangler/e2e          # resets + dev seed + every section; prints the fixture check
node scripts/seed/repo-setups.mjs                                       # ONLY with the default state (it has no --persist-to); #186's RepoFacts
node scripts/dev-cookie.mjs test-session-test-member                    # the cookie to set at http://localhost:8787
```

Re-run the seed between cases that write (accept, dismiss, confirm, undo, settings, uploads, Wrong?).

### 0.2 What this run can NOT do (the e2e rules)

"Never use live payment, email or third-party keys" (e2e spec § Rules). So **no case calls Anthropic, TypeSafe AI
(Jev), Resend or Stripe**. Every model-written row on screen comes from the seed (real rows through the real reads)
or from `LOCAL_AI_PREVIEW`; the jobs themselves are proven by their recorded-answer evals in CI
(`test/ai.evals.test.ts`, `test/ai-evals/<kind>/`). The background-job cases here (§ 4.J) are the KEYLESS
behaviours: no key → nothing runs, the switch off → nothing is marked, the router's rows after a browser write.
Ask's model path is shown only through the dev replay (`/ai/ask-replay`, § 5.AR).

## 1. Surfaces

| id | surface | kind | how reached | branch |
| --- | --- | --- | --- | --- |
| G | the tenant + cookie-only gate in front of every AI route | middleware | any `/api/o/:slug/ai/*`, `/ask/*` | screens |
| OA | Org settings › AI (+ `GET`/`PUT /ai/settings`) | screen tab + API | `#org/ai` | screens |
| SF | Tags › Sift cell, New tag modal, Find items | screen panel | `#org/tags` (admin) | screens (+ phase-c-feed: new items) |
| PU | Platform › Usage › "AI runs" line | screen | `/platform/#platform/usage` | screens |
| FL | the plain-language filter (+ `POST /ai/filter`) | panel + API | `#tickets`, `#feed`, `#artifacts` | screens |
| RL | the reading list on a claimed handoff (+ MCP `claim_handoff`) | panel + API + MCP | `#handoffs/<n>` Claim | screens |
| SG | suggestion Accept / Dismiss routes and the client's chip states | API + chip | `POST /ai/suggestions/:id/accept|dismiss` | screens (handlers per phase) |
| WR | "Wrong?" (`POST /ai/feedback`) | API + button | every AI block that has it | screens |
| BR | My Work › Your brief tile (+ MCP `get_my_work.brief`, `mywork_opened_at`) | bento tile | `#mywork` | screens (UI) + phase-d-brief (rows) |
| ST | Repo › Overview › State (+ MCP `get_repo_dashboard.state`), over #186's RepoFacts | section | `#repo` Overview | screens (UI) + phase-d-digests (rows) + main #186 |
| TH | Repo › Planning › Where the work went, its proposed-theme chips | section + chips | `#repo/planning` | screens |
| FD | Feed: Trov entries, the Source switch (All / Agents / Trov), the one-time note | rows + control | `#feed` | screens (UI) + phase-d-digests (rows) |
| FI | Feed / My Work / MCP importance marks (Notable / Breaking) | byline mark | `#feed` | phase-c-feed |
| TC | ticket detail: category / priority / duplicate chips | chips | `#tickets/<n>` | phase-c-tickets |
| UP | Unplaced: row mark + destination chip | mark + chip | `#unplaced` | phase-c-tickets |
| RV | Review: risk mark + detail line; Trov's doc-drift proposal; "Flagged in Ask" | mark + line | `#review` | phase-c-tickets, phase-d-roadmap, screens (Ask flags) |
| RM | Roadmap: forecast, sprint note, drift, suggestion cards (+ MCP) | lines + cards | `#roadmap` | phase-d-roadmap |
| EM | e-mail: daily, weekly, preview, test send, Settings › Email notifications, the cron, deep links | e-mail + screen | `/api/o/:slug/notifications/*`, `#settings` | phase-e-emails |
| AK | Ask Trov's API: state, peek, item, ask (SSE), threads, save, cards, attachments, wrong, settings | API | `/api/o/:slug/ask/*` | screens |
| AR | Ask's dev replay | API (SSE) | `/api/o/:slug/ai/ask-replay[/<scenario>]` | screens |
| AU | Ask Trov's screen, composer, inspector, ⌘J panel, Settings › Trov, phone | screen | `#ask` (route name per ai/ask) | ai/ask |
| JB | the router (`ai_dirty`), the pass, the `:50` pre-warm, the crons — keyless | background | browser writes + `wrangler dev --test-scheduled` | screens + phases |
| MC | MCP reads that carry AI fields | MCP | `/mcp` with the bearer | per phase |
| LG | Terms / Privacy: Phase G's DRAFT passages | public page | `/terms`, `/privacy` | screens (Phase G) |
| EV | environment: 360 px, dark, keyboard (grid) | — | — | all visual surfaces |
| MO | motion: entrance once, no replay on rerender/poll, smooth exits, none under reduced motion (owner's ruling, RULES § 8) | — | — | all AI UI |

## 2. Dimensions, and where each applies

| dimension | values | applies to |
| --- | --- | --- |
| who | signed out · member · admin · owner · another org's member · superadmin (no membership) · bearer token | every route (G), the admin-only controls (OA, SF, TH, RM, EM preview), Platform (PU) |
| plan | Free (`org-free`) · Personal (`org-personal`) · Pro paid 5 seats (`org-pro-5-seats`) · gifted Pro (`org-pro-gifted-3-members`) · Enterprise (`org-enterprise`) · canceled (`org-canceled`) · override (`org-chat-override-10`) | OA allowances, FL 402 pointer, BR/ST capped + Upgrade, AK modes and caps, debounce (jobs) |
| AI switch | on · off (`org-ai-off`) · Ask Auto off (`org-auto-off`) | every AI field |
| keys | none (default) · `K:dummy` (refusals only) | OA eligibility, FL 503, AK `no_key`, SF |
| preview | unset · `P:ready` · `P:empty` · `P:capped` · `P:proposed` | BR, ST, TH, FD, OA, FL, AR, RM (roadmap's preview), TC/UP/RV (phase C preview) |
| data | empty · one · many · at cap · past cap · stale · malformed · deleted · decided (accepted / dismissed / superseded) · hidden by Wrong? | per surface (the fixtures) |
| async | loading · success · failed (degraded / 503) · partial | screens with a read: OA, BR, ST, TH, FD, RM, AK stream |
| input | valid · empty · whitespace · too long · unicode + emoji · HTML / markdown injection · duplicate submit · out-of-range ids | FL, TH rename, AK (text, title, instructions, attachments), WR body |
| environment | desktop 1440 / 360 · light / dark · keyboard only · reduced motion | every rendered state (§ 6, § 7) |

## 3. Fixtures (the seed's names; `node scripts/seed/server-ai-e2e.mjs --list` prints them with what they hold)

Sections run only when their tables exist. Verified 2026-10-15 on throwaway local states: with `ai/screens`'
migrations (+ 0064) the seed writes 83 of 83 fixtures and SKIPS phase-c-feed, phase-d-digests, phase-d-brief,
phase-d-roadmap, phase-e-emails and repo-facts, each naming the migration to merge; with every branch's migration
layered on (0060–0065, 0067_digest_email, main's 0070–0074) it writes 121 of 121, and a second run gives the same.
(The e2e spec names the seed `scripts/seed/server-ai.mjs`; the Phase H brief named it `server-ai-e2e.mjs` — one
file, this one.)

| section | migration | fixtures |
| --- | --- | --- |
| core | 0055–0059 | person-owner / person-admin / person-member / person-member2, person-outsider, person-superadmin, person-noemail, person-unsubscribed; org-enterprise, org-pro-5-seats, org-pro-gifted-3-members, org-free, org-personal, org-ai-off, org-auto-off, org-at-cap, org-past-cap, org-chat-3-left, org-chat-override-10, org-canceled, empty-org, other-org; tickets-many, ticket-html-injection, ticket-unicode, sprint-active-forecast, backlog-8 / backlog-7, handoff-reading-list, handoff-reading-list-empty, handoff-anyone, doc-staged-proposal, adr-draft / adr-ratified, unplaced-doc-item / unplaced-freeform-item, feed-agent-entries, prs-merged-16 / prs-merged-14, artifacts-org-and-private, sift-on, sift-run-busy, allowance-partly-used, allowance-at-cap, allowance-past-cap, allowance-last-month, chat-3-left, chat-override-10, usage-platform-ai, filter-rate-limited, suggestion-unhandled-open, suggestion-dismissed, suggestion-other-org, ai-dirty-scopes, digest-recipients, bearer-token |
| ask | 0066_ask | ask-threads-member, ask-thread-other-person, ask-thread-other-org, ask-thread-injection, ask-free-thread, ask-card-proposed-create-ticket, ask-card-proposed-transition, ask-card-group, ask-card-send-handoff, ask-card-publish-doc, ask-card-expired, ask-card-stale-turn, ask-card-confirmed, ask-card-cancelled, ask-card-auto-undo, ask-card-auto-changed, ask-card-update-plan, ask-card-lane-refused, ask-settings-member, ask-settings-free-thinking, ask-flags-review |
| phase-c-tickets | none (0055) | ticket-with-suggestions, ticket-suggestion-decided, ticket-done-with-suggestion, suggestion-missing-ticket, unplaced-with-suggestion, review-with-risk, adr-ratified-with-risk |
| phase-c-feed | 0060_ai_importance | feed-importance-mixed, pr-importance, feed-importance-ai-off |
| phase-d-digests | 0061_ai_digests + 0062_repo_state | trov-entry-linked, trov-entry-no-subject, trov-entry-unlinked / trov-entry-bad-artifacts / trov-entry-many-cites, trov-entry-wrong-pressed, trov-entries-ai-off, ai-sessions-skipped, repo-state-ready, repo-state-capped, repo-state-no-event-count, repo-state-malformed, repo-state-stale, repo-state-wrong-pressed |
| phase-d-brief | 0063_person_brief | brief-ready-5-next, brief-empty, brief-malformed, brief-wrong-pressed, brief-capped, brief-ai-off, brief-one-next, brief-stale, brief-not-wanted |
| phase-d-themes | 0064_repo_themes (merged) | themes-active-and-proposed, theme-person-pick, themes-proposed-only, themes-at-8, themes-malformed, themes-ai-off |
| phase-d-roadmap | 0065_org_insights | sprint-note / plan-drift, sprint-note-malformed, plan-drift-stale, roadmap-suggestions, roadmap-ai-off, doc-drift-proposal |
| phase-e-emails | 0067_digest_email | notify-only-when-needed-skip, notify-only-when-needed-send, notify-only-when-needed-off-row, week-highlights, week-highlights-ai-off, week-highlights-malformed, week-highlights-none |
| repo-facts | 0070_repo_apps (#186) + 0062 | repo-state-over-repofacts (then `scripts/seed/repo-setups.mjs`: sapling-live ≈ scenario A, new-org-found = L, unseen-org = M) |

Ids worth knowing: suggestions 5001–5003 (generic), 5101–5119 (Phase C), 5401–5404 (themes), 5501–5504 (roadmap); Ask
rows are `800000 + n·1000 + k` (org-enterprise n=1: threads 801001–801008, cards 801201–801214); content rows
`700000 + n·1000 + k` (feed 701005–701008 agent, 701020–701024 Trov; ADRs 701001 ratified, 701002 draft; Unplaced
701003 doc-shaped, 701004 free-form).

## 4. Functional cases — what `ai/screens` has today (and its producers)

### G — the gate in front of every AI route (one case per route × refusal)

The order is session → tenant → cookie-only (`src/auth/principal.ts:50-64`, `src/data/gate.ts:21-28`,
`src/orgs/routes.ts:34-37`, `src/ai/ask/routes.ts:57-63`). Expected: signed out → 401 `{"error":"unauthorized"}`;
`outsider` on `/api/o/test-ent/…` → 404 `{"error":"not_found"}`; `superadmin` (no membership) → 404; `bearer` WITH a
cookie → 403 `{"error":"forbidden","message":"this is a signed-in person's action, never a token's"}`; bearer WITHOUT a
cookie → 401 (the session gate does not read bearers on `/api/o`).

| route | signed out | outsider | superadmin | bearer + cookie |
| --- | --- | --- | --- | --- |
| `GET /ai/settings` | G-1 | G-2 | G-3 | G-4 |
| `PUT /ai/settings` | G-5 | G-6 | — (same handler as G-3) | G-7 |
| `POST /ai/suggestions/5001/accept` | G-8 | G-9 | G-10 | G-11 |
| `POST /ai/suggestions/5001/dismiss` | G-12 | G-13 | — | G-14 |
| `POST /ai/feedback` | G-15 | G-16 | — | G-17 |
| `POST /ai/filter` | G-18 | G-19 | — | G-20 |
| `GET /ai/ask-replay` (P:ready) | G-21 | G-22 | — | G-23 |
| `GET /ask/state` | G-24 | G-25 | G-26 | G-27 |
| `POST /ask/peek` | G-28 | G-29 | — | G-30 |
| `GET /ask/item/ticket:1` | G-31 | G-32 | — | G-33 |
| `POST /ask` (`command:"search"`) | G-34 | G-35 | — | G-36 |
| `GET /ask/threads` | G-37 | G-38 | — | G-39 |
| `GET|PATCH|DELETE /ask/threads/801001`, `POST …/stop`, `GET …/export` | G-40 | G-41 | — | G-42 |
| `POST /ask/messages/801102/save-form`, `POST /ask/threads/801001/save` | G-43 | G-44 | — | G-45 |
| `POST /ask/actions/801201/confirm|cancel|undo` | G-46 | G-47 | — | G-48 |
| `POST /ask/attachments` | G-49 | G-50 | — | G-51 |
| `POST /ask/messages/801102/wrong` | G-52 | G-53 | — | G-54 |
| `GET|PUT /ask/settings` | G-55 | G-56 | — | G-57 |
| bearer WITHOUT cookie, any of the above | G-58: 401 | | | |

"—": the superadmin path is the same tenant refusal as the route's GET sibling (one handler, one middleware); kept
once per mount (§ 8 D-1).

**Leaks through reads (the AI fields of another org never appear):**

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| G-59 | outsider in `test-other` | `GET /api/o/test-other/me/dashboard`, `/repo/dashboard`, `/feed`, `/tickets/2` | only `test-other`'s rows; no row of `org_test_ent` (suggestion 5003 is test-other's own) | inv. 4 |
| G-60 | member, test-ent | `POST /ai/suggestions/5003/accept` and `/dismiss` (other-org's id) | 404 `not_found` both | `src/ai/suggestions.ts:41-64` |
| G-61 | member, test-ent | `POST /ask/peek {refs:["ticket:2"]}` while `test-other` also has a ticket #2 | test-ent's ticket #2 only | `src/ai/ask/refs.ts:162-320` |

### OA — Org settings › AI and `/ai/settings`

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| OA-1 | org-enterprise · admin | open `#org/ai` | lead "Trov's AI is **on** for Test Enterprise: …and runs Sift on your tags."; rows "AI for this organization" and "Auto mode in Ask Trov", each "On" + a switch; This month: Summaries "412 summaries this month (unlimited)", Written by Trov "37 runs …(unlimited)", Sift "1520 checks …(unlimited)", Ask Trov "64 questions …(unlimited)", no meter (unlimited); "What is sent" three rows; footnote "Counted per calendar month (UTC)…" | `web/src/org-ai.ts:33-126`, `shared/ai-core.ts:229-243` |
| OA-2 | org-enterprise · member | open `#org/ai` | the tab is visible; the words On / On with NO switch; lead adds " Only an admin or an owner can change this." | `web/src/org-ai.ts:68-78`, `org-settings.ts:63-71` |
| OA-3 | org-enterprise · owner | same as OA-1 | identical to OA-1 (owner ⊇ admin) | `src/data/context.ts:153-155` |
| OA-4 | org-enterprise · member | `PUT /ai/settings {enabled:false}` | 403 `{"error":"forbidden"}`; `orgs.ai_automation` stays 1 | `src/ai/routes.ts:72-79` |
| OA-5 | admin | toggle "AI for this organization" off | `aria-busy` while saving; flash "Trov's AI is off for this organization"; lead says **off**; `org_admin_audit` gets `org.ai`; `orgs.ai_automation=0` | `web/src/org-actions.ts:158-178`, `src/data/ai.ts:12-28` |
| OA-6 | admin, after OA-5 | toggle it back on | flash "Trov's AI is on for this organization"; a second audit row | same |
| OA-7 | admin | toggle "Auto mode in Ask Trov" off | flash "Auto mode is off in Ask Trov: every change waits to be confirmed"; `orgs.ai_chat_auto=0`; audit `org.ai_chat_auto` | same |
| OA-8 | admin | `PUT /ai/settings` with `{}`, `{enabled:"yes"}`, `{enabled:true, x:1}` | 400 `{"error":"invalid","message":"Send { enabled: true \| false }, { chatAuto: true \| false }, or both."}` each; nothing changes | `shared/ai.ts:119-120` |
| OA-9 | admin · `K:dummy` · org-free | open | Free caps: "120 of 300 summaries", "120 of 250 runs", "300 of 1000 checks", "20 of 50 questions"; meters drawn, none full | `shared/plans.ts:138-157`, `org-ai.ts:41-53` |
| OA-10 | admin · `K:dummy` · org-at-cap | open | every meter `data-meter="full"`; four amber lines "Used up for this month: … until <1st of next month>" (summaries "new pull requests and issues show an excerpt", runs "Trov writes nothing new", Sift "Sift stops looking for items that fit a tag", Ask "Ask Trov pauses"); eligibility `capped` (no sentence) | `org-ai.ts:33-53`, `src/ai/eligibility.ts:41-52` |
| OA-11 | admin · `K:dummy` · org-past-cap | open | as OA-10; meters clamp at 100 %; "310 of 300 …" text | same |
| OA-12 | admin · no key · org-enterprise | open | a "No key" waiting mark + "This Trov has no Anthropic key, so nothing is written whatever the switch says. Whoever runs this Trov can add one." | `org-ai.ts:25-30`, `eligibility.ts:41` |
| OA-13 | admin · no key · org-ai-off | `GET /ai/settings` | `eligibility:"no_key"` (no_key wins over off) | `eligibility.ts:41-44` |
| OA-14 | admin · `K:dummy` · org-ai-off | `GET /ai/settings` | `enabled:false`, `eligibility:"off"`; no eligibility line | same |
| OA-15 | admin · `K:dummy` · org-canceled | open | `eligibility:"capped"`, `resumesOn:null` → no "Used up" line | `eligibility.ts:49-52` · question (Q10) |
| OA-16 | admin · `K:dummy` · org-pro-gifted-3-members | `GET /ai/settings` | `ai_chat.cap` = 900 (300 × 3 members) | handoff #12 § 2.1, `shared/plans.ts:288-299` |
| OA-17 | admin · `K:dummy` · org-pro-5-seats | `GET /ai/settings` | `ai_chat.cap` = 1500; `ai_runs.cap` = 2000 | same |
| OA-18 | admin · org-chat-override-10 | `GET /ai/settings` | `ai_chat.cap` = 10 (the whole cap, not multiplied) | same |
| OA-19 | admin · org-free | (the 999 last-month row) | runs used = 120, not 1119 | `shared/plans.ts:493` |
| OA-20 | admin · P:ready | open | a 5-seat Pro's numbers 212 / 486 / 1240 / 1120 of 3000 / 2000 / 10000 / 1500; eligibility ok; `enabled` stays REAL | `shared/ai-fixtures.ts:190-199`, `src/ai/routes.ts:58-68` |
| OA-21 | admin · P:empty | open | 0 of each; matches `docs/superpowers/specs/ai-screens-shots/org-ai-empty-*.png` | same |
| OA-22 | admin · P:capped | open | at cap on all four, four "Used up" lines; matches `org-ai-capped-*.png` | same |
| OA-23 | member · P:ready | open | matches `org-ai-member-*.png` | same |
| OA-24 | admin | throttle the network, open `#org/ai` | skeleton "Loading the AI settings…" (`aria-busy`) | `web/src/org-ui.ts:128-140` |
| OA-25 | admin | block `GET /ai/settings` (offline) | "Couldn't load the AI settings. Check your connection, then [Try again]"; Try again reloads | same |
| OA-26 | admin | double-click a switch | one PUT in flight (busy), final state matches the last request | `org-actions.ts:158-178` |

### SF — Tags › Sift (admin)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| SF-1 | member | `GET /tags` | no `ai` field; no Sift cell, no "Added by Sift" column | `src/tools/tags.ts:131-135`, `web/src/tags.ts:273,320,326` |
| SF-2 | admin · no TypeSafe key | open `#org/tags` | "This Trov has no TypeSafe AI key set, so nothing is sent and nothing is tagged."; switch disabled | `web/src/tags.ts:142-146` |
| SF-3 | admin · org-ai-off (Sift row on) · dummy TypeSafe key | open | "Trov's AI is off for this organization (Org settings › AI), so nothing is sent."; switch NOT disabled; meter dimmed | same |
| SF-4 | admin · org-pro (no Sift row) · dummy key | open | "Off: nothing is sent." | same |
| SF-5 | admin · org-at-cap (no row; turn Sift on first) · dummy key | open | "This month's checks are used up: Trov stops looking for items until next month." | same |
| SF-6 | admin · org-free · dummy key | open | "300 of 1000 checks used this month." | same |
| SF-7 | admin · org-enterprise · dummy key | open | "1520 checks used this month." (unlimited) | same |
| SF-8 | member | `PUT /tag-settings {enabled:true}` | 403 | `src/tags/routes.ts:38-47` |
| SF-9 | admin | `PUT /tag-settings {enabled:"on"}` | 400 `{error:"invalid", field:"enabled", message:"enabled must be true or false"}` | same |
| SF-10 | admin · dummy key | toggle Sift on / off | flashes "Suggestions are on. Trov looks for items when you add a tag." / "Suggestions are off. Nothing is sent." | `web/src/tags-actions.ts:279-285` |
| SF-11 | admin · no key | open New tag | scan switch disabled, "This Trov has no TypeSafe AI key set."; confirm "Add"; flash "Added the tag {name}" | `web/src/tags.ts:362-388` |
| SF-12 | admin · org-ai-off | open New tag | disabled with the org-off sentence | same |
| SF-13 | admin · org-pro (Sift off) | open New tag | disabled, "Sift is off for this organization (the switch above the list)." | same |
| SF-14 | admin · org-free · busy run | Find items on test-hosting | flash "Trov is already looking for items for this tag." | `src/ai/sift.ts:38-57`, `tags-actions.ts:371-378` |
| SF-15 | admin · org-pro · Find items | Sift off | "Suggestions are off. Turn them on above first." | same · question (Q9) when the ORG switch is the cause |
| SF-16 | admin · no key | Find items | "This Trov has no TypeSafe AI key set, so it cannot look for items." | same |
| SF-17 | admin · Find items on a retired tag | — | "That tag is not on the list any more. Reload the page." | same |
| SF-18 | admin · org-at-cap with Sift on · dummy key | Find items | "This month's checks are used up. Trov can look again next month." | same |

### PU — Platform › Usage

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| PU-1 | admin (not superadmin) | `GET /api/platform/usage` | 404 `not_found`; the app falls back to the org picker / My Work | `src/platform/routes.ts:32-41`, `web/src/main.ts:2242-2246` |
| PU-2 | superadmin · no key | `/platform/#platform/usage` | no "AI runs" line at all (the Sift figures go too) | `src/platform/routes.ts:94,195` · question (Q7) |
| PU-3 | superadmin · `K:dummy` | open | "AI runs": Runs, Failed, Capped, Tokens in, Tokens out, Cached, Sift checks, Sift tokens in, Sift tokens out, totals "last 30 days, all organizations" | `web/src/platform-usage.ts:104-110` |
| PU-4 | superadmin · `K:dummy` | open `#platform/orgs/test-ent` | the org's own AI line: runs 5 (ticket.category) + 37 (filter), failed 2, capped 1, tokens 18000 / 2400 / 9000, Sift 1520, Sift tokens 3000 / 40; matches `platform-usage-org-open-*.png` layout | `src/platform/usage.ts:157-188` |
| PU-5 | superadmin · `K:dummy` | `?days=1`, `?days=0`, `?days=9999` | 1 → today only; out-of-range clamps to 1..retention, default 30 | `src/platform/usage.ts:20-27` |
| PU-6 | superadmin | the people count | AI metrics never count as a person's activity; `trov` not counted (after phase-d-digests) | `usage.ts:93,112-113` |

### FL — the plain-language filter (`POST /ai/filter`)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| FL-1 | no key | open `#tickets`, open Filter | NO "Describe a filter" row in the menu (never a disabled one), no bar above the toolbar | `web/src/ai-filter-actions.ts` `ensure`, `ai-filter.ts` `aiFilterMenuTop` |
| FL-2 | org-ai-off · `K:dummy` | open `#tickets`, open Filter | no row | same |
| FL-3 | `K:dummy` · org-enterprise | open `#tickets`, `#feed`, `#artifacts`; open Filter; choose "Describe a filter" (click, or ↓ then Enter) | the menu's first row "Describe a filter" (AI mark); choosing it grows the field open with placeholders "my open high-priority bugs" / "my entries from the last 7 days" / "published designs about auth"; `maxlength=300`; Escape closes the menu and focuses Filter | `shared/ai-filter-core.ts` `AI_FILTER_PLACEHOLDER` |
| FL-4 | `K:dummy` | submit "" and "   " | no request; field error "Type what you want to see, in a sentence." | `ai-filter-actions.ts:68-70` |
| FL-5 | `K:dummy` | `POST /ai/filter` with `{screen:"x"}`, a 301-char text, an extra key | 400 `{error:"invalid", message:"Type what you want to see, in a sentence."}` | `src/ai/routes.ts:130-155` |
| FL-6 | `K:dummy` · org-ai-off (box forced via a stale page, Q1) | Apply | 403 `{error:"off", message:"AI is switched off for this organization."}` | same |
| FL-7 | `K:dummy` · org-at-cap · owner | Apply "my bugs" | 402; UI "This organization has reached the 250 AI runs its Free plan includes. Upgrade to Pro for more."; one `ai_run_capped:filter` metered, actor `ai-filter`; NO network call | `src/ai/routes.ts`, `shared/plans.ts:451-457` |
| FL-8 | `K:dummy` · org-at-cap · member | Apply | the same sentence + "Ask one of this organization's owners." | same |
| FL-9 | `K:dummy` · org-canceled · owner | Apply | "This organization's Pro plan has ended, so nothing can be added until it is renewed. You can renew it in Org settings." | same |
| FL-10 | `K:dummy` · org-pro-gifted-3-members at cap (edit runs to 2000) · owner | Apply | pointer "Ask Trov to change your plan." | same |
| FL-11 | `K:dummy` · admin (filter-rate-limited) | Apply | 429 + `Retry-After`; "You've hit this hour's limit for this; try again after {time}." | `src/platform/limits.ts:39,73-81`, `ai-filter-actions.ts:60` |
| FL-12 | `K:dummy` · superadmin who is a member (add one) at 60 | Apply | not rate limited (superadmin exempt) | `limits.ts` |
| FL-13 | no key · box visible via P:ready | Apply on Tickets (P:ready) | 200 fixture: "Filtered: Open · Assigned to you · Bug · High priority." + [Undo]; the list reloads with those filters | `shared/ai-fixtures.ts:218-225`, `web/src/main.ts:186-212` |
| FL-14 | P:ready | Tickets, text contains "overdue" | adds " Not a filter here: “overdue”." | same |
| FL-15 | P:ready | Feed | "Filtered: By you · Last 7 days."; with "about deploys" in the text → unmatched “about deploys” | same |
| FL-16 | P:ready | Artifacts | "Filtered: HTML · Published · search “checkout”." filtered client-side | same |
| FL-17 | P:ready | Undo after two applies | restores the state from before the FIRST apply | `ai-filter-actions.ts:80-84,105-112` |
| FL-18 | P:empty | Apply | 422; "Trov couldn't turn that into a filter on this screen. Try naming a person, a status, a priority or a time." | `src/ai/routes.ts:138-140` |
| FL-19 | P:capped | Apply | 402 with the Free-plan sentence (250 runs) | same |
| FL-20 | P:ready · org-ai-off | open, Apply | box hidden? `enabled` is real (false) → NO box; a direct POST → 403 off | `ai-filter-actions.ts:40-52`, routes |
| FL-21 | P:ready | text `<img src=x onerror=alert(1)> overdue` | unmatched phrase drawn escaped, no script runs | `web/src/org-ui.ts:169-170` |
| FL-22 | P:ready | Enter twice fast | one request (busy drops the second); button "Reading…", `aria-busy` | `ai-filter-actions.ts:65-69` |
| FL-23 | P:ready | change a filter by hand after an apply | question (Q3): the applied line and Undo stay | `ai-filter-actions.ts` |
| FL-24 | P:ready, then admin flips AI off in another tab | Apply without reload | question (Q1): stale box → 403 | same |
| FL-25 | P:ready | type after an error | question (Q2): the error stays | `ai-filter-actions.ts:100-103` |

### RL — the reading list (#167)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| RL-1 | member · handoff-reading-list (#1 to test-member) | Claim on `#handoffs/1` | "Read these first (not complete)" + the sentence; ≥1 row "Doc  test-Deploy checklist" (≥2 matching words), ≤5 rows; Doc opens the doc | `src/tools/handoffs.ts:340-381`, `web/src/handoffs.ts:77-91` |
| RL-2 | member · handoff-reading-list-empty (#4 "Fix it, ok") | Claim | nothing drawn (`[]`) | same |
| RL-3 | after RL-1 | reload | the list is gone (built at claim, never stored) | `web/src/handoffs.ts:249` |
| RL-4 | after RL-1 | Copy as prompt | the clipboard text ends with the list | `handoffs.ts:55-58` |
| RL-5 | member · My Work › Claim & copy on #1 | — | copied text has NO list (copied before the claim) | `web/src/main.ts:3349-3360` |
| RL-6 | member2 (not the recipient) | `POST /handoffs/1/claim` | refused (not recipient / sender / anyone) | `src/tools/handoffs.ts:177-187` |
| RL-7 | admin · handoff-anyone (#2) | Claim | allowed; reading list from "webhook retries" words → doc test-Webhook retries | same |
| RL-8 | bearer · MCP `claim_handoff {id:1}` (re-seed) | — | "## Read these first (not complete)", an intro, `- Doc: test-Deploy checklist (get_doc slug \`test-deploy-checklist\`)` + `> snippet` | `src/mcp.ts:611-613`, `handoffs.ts:399-417` |
| RL-9 | bearer · MCP claim of #4 | — | no section | same |
| RL-10 | the private artifact's words | claim a handoff naming "Private notes" as test-member | the private artifact (test-member2's) is NOT listed | `query()` viewer = claimer |

### SG — suggestions: Accept / Dismiss (what `ai/screens` alone answers)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| SG-1 | member | accept `/ai/suggestions/abc` and `/0` | 404 `not_found` | `src/ai/routes.ts:88-94` |
| SG-2 | member | accept 5001 (open, kind with no handler) | 409 `not_available`; chip (if drawn) says "Not available yet" | `src/ai/suggestions.ts:41-64` |
| SG-3 | member | dismiss 5001 | 200 `{ok:true, suggestion:{state:"dismissed", decided_by:"test-member"}}`; row decided_at set | `suggestions.ts:68-74` |
| SG-4 | member | accept / dismiss 5002 (dismissed) | 409 `not_open` both; UI flash "Someone already answered that suggestion." | same, `web/src/ai-actions.ts:66-91` |
| SG-5 | member | dismiss 5001 twice in parallel | one 200, one 409 `not_open` | `src/data/ai.ts:90-92` |
| SG-6 | member | accept with body `"x"` / `[]` on an open row WITH a handler (theme 5401) | 400 `invalid` | `shared/ai.ts:113` |
| SG-7 | member | accept 5401 (`themes.propose`, admin-only handler) | 403 `forbidden` (member) | `src/ai/accept.ts` (themes) |

### WR — "Wrong?" (`POST /ai/feedback`)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| WR-1 | member | body without `model` / `promptVersion` | 400 `{error:"invalid", issues}` · question (Q15) | `shared/ai.ts:108-114` |
| WR-2 | member | `itemType:"x"`; `itemRef` of 201 chars; `kind` of 61 chars | 400 each | same |
| WR-3 | member | a valid body, twice | 200 `{ok:true}` both; ONE `ai_feedback` row | UNIQUE (org, handle, type, ref) |
| WR-4 | member | press Wrong? while offline | the block comes back, "Couldn't send that. It is back on screen; try again." | `web/src/ai-actions.ts:51-64` |
| WR-5 | member | press Wrong? | hidden at once; "Hidden for you. Thanks: Trov is told it was wrong." | same |

### BR — My Work › Your brief (real rows need phase-d-brief; P:* works now)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| BR-1 | brief-ready-5-next · member | open `#mywork` | the `.mw-bento-brief` layout; Now (2 cites #1, #3), Recently (#115, #113), Next 5 items in the server's order: Failing (red, "Its last CI run failed.") CI run 4812 · Due soon #4 (unicode title intact) · Handoff #1 · Handoff #4 · ticket #3 (the injection title drawn as TEXT); each title linked to `cites[0].href`; footer "Written by Trov, 12m ago" + Wrong? | `web/src/mywork.ts:442-462`, `src/tools/mywork.ts:282-300`@brief |
| BR-2 | same | inspect `GET /me/dashboard` | `brief.state:"ready"`, `generatedAt` = version 6's; versions 1–5 never shown | same |
| BR-3 | brief-one-next · org-free | open | no Now line; Recently; one Next "test-Login page is blank on Safari", why "You have it in progress." | same |
| BR-4 | brief-empty · admin | open | "Trov writes your brief after your next push or when something is assigned to you. It reads your sessions, pull requests, tickets and handoffs."; no byline, no Wrong? | `mywork.ts:442-462` · question (Q24) |
| BR-5 | brief-capped · org-at-cap · `K:dummy` | open | Now (muted), "Monthly AI allowance used; your brief resumes <1st next month>." + "Upgrade to Pro" (Free) | `ai-ui.ts aiCapped` |
| BR-6 | brief-capped, org-at-cap moved to `personal` | open | no Upgrade link | same |
| BR-7 | brief-ai-off · org-ai-off | open | NO tile; the five tiles + library strip as before | `mywork.ts:282-300`@brief |
| BR-8 | brief-malformed · member2 | open | no tile | same |
| BR-9 | brief-wrong-pressed · owner | open | no tile for test-owner; test-member still sees theirs | same |
| BR-10 | member | press Wrong? on BR-1 | tile hidden; reload → still hidden (same `generated_at`) | same, `shared/ai-core.ts:184-190` |
| BR-11 | brief-stale (20 days) · org-pro | open | shown, byline "Written by Trov, 20 days ago" (no staleness rule) | phase-d map · question (Q25) |
| BR-12 | brief-not-wanted · test-noemail | open | no tile (no row) | `person-brief.ts:56-76` |
| BR-13 | member | open `#mywork` | `memberships.mywork_opened_at` updated (it was 5 min ago → unchanged; set it 2 h back → now) | `person-brief.ts:80-87` |
| BR-14 | bearer · MCP `get_my_work` | — | `brief` present (same read); `mywork_opened_at` NOT written | `src/mcp.ts:346-349`@brief |
| BR-15 | P:ready (any org) | open | the fixture brief (failing run 4812, handoff 3, ticket 14) replaces the real one; matches `mywork-brief-ready-*.png` | `shared/ai-fixtures.ts`, `src/routes.ts:733-734` |
| BR-16 | P:empty | open | the empty sentence; matches `mywork-brief-empty-*.png` | same |
| BR-17 | P:capped | open | capped line; matches `mywork-brief-capped-*.png` | same |
| BR-18 | P:ready · org-ai-off | open | the fixture still shows · question (Q13) | `routes.ts:733-734` |
| BR-20 | member · an overdue ticket in Next | — | "Due soon" mark for an overdue item · question (Q26) | `brief.ts:193`@brief |

### ST — Repo › Overview › State (real rows need phase-d-digests; #186's RepoFacts around it)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| ST-1 | repo-state-ready · member | open `#repo` | "State" h2 + "Written by Trov from 6 events, 1h ago"; headline; three columns Shipped recently (2) / In flight (1) / Needs attention (1) with the done / half / warn glyphs; cites "#115 · #113" link to GitHub; "CI run 4812" plain text (href null); "test- webhook retries half done" → `#feed`; Wrong? bottom right | `web/src/repo-ai.ts:50-82`, `src/tools/repo-state.ts:84-112`@digests |
| ST-2 | same | `GET /repo/dashboard` | `state` = version 2 only | same |
| ST-3 | repo-state-capped · org-at-cap · `K:dummy` | open | headline only + "Monthly AI allowance used; this state is from <date> and resumes <1st>." + Upgrade (Free) | `ai-ui.ts aiCapped` |
| ST-4 | repo-state-no-event-count · org-free | open | byline "Written by Trov, 1h ago" with no "from N events" | `repo-ai.ts:50-82` |
| ST-5 | repo-state-malformed · org-pro | open | NO State section; the rest of Overview unchanged | `repo-state.ts:84-112` |
| ST-6 | repo-state-stale · org-pro-gifted | open | shown, "30 days ago" | no expiry · question (Q25) |
| ST-7 | repo-state-wrong-pressed · member2 | open | no section for test-member2 | same |
| ST-8 | org-ai-off (rows stored) | open | no section | same |
| ST-9 | empty-org | open | no section (no repo) | same |
| ST-10 | member | Wrong? on ST-1, reload | still hidden; when a NEWER version is written it shows again | same |
| ST-11 | member | Overview → Planning → Overview | the section only on Overview | `repo.ts:1074-1080` |
| ST-12 | member | "Preview with sample data" | NO State on the sample | `repo.ts:1077` |
| ST-13 | bearer · MCP `get_repo_dashboard` (no tab / `tab:"overview"`) | — | `state` present; with `tab:"ci"` absent | `src/tools/repo-agent.ts:213-219` |
| ST-14 | P:ready / P:empty / P:capped | open | the fixture replaces the real one; matches `repo-state-{ready,empty,capped}-*.png` | `src/routes.ts:755-756` |
| ST-15 | repo-state-over-repofacts + `repo-setups.mjs` · org_saplinglearn · AndresL230 | open `#repo` | the State block sits in `<div data-repo-state-slot>` ABOVE the rule-picked block (R6 environment cards for sapling-live); the deploy cite reads "Production backend" (part label, never the provider id) | `docs/architecture/repo-apps.md:307` (main), `main-186-for-ask.md` § 4 |
| ST-16 | same | the Overview's health words | "Healthy" only when `ci.state` is pass; Railway (not connected) shows its four-state usage wording; nothing unknown drawn as 0 | `repo-apps.md` › RepoFacts (main) |
| ST-17 | new-org-found (org_b, scenario L) · AndresL230 | open `#repo` | found-apps card (R1); no State (none written) | same |
| ST-18 | unseen-org (scenario M) | open | "Trov does not see deploys" card (R2); no State | same |
| ST-19 | P:ready over sapling-live | open | the fixture State in the slot; the RepoFacts blocks unchanged | `routes.ts:755-756` |

### TH — Repo › Planning › Where the work went (merged on `ai/screens`)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| TH-1 | themes-active-and-proposed · admin | open `#repo/planning` | header "Themes and caption written by Trov from N pull requests, <rel>"; caption "Most of the work went to test-Hosting and test-Search; lately it moved to test-Auth."; 5 lanes (4 active + test-Emails proposed); band height ∝ count; "Band height is merged pull requests per week."; first lane picked, others 0.55; proposal chip "Suggested: test-Emails, because…" Accept / Rename / Remove; "Edit themes" button | `web/src/repo-ai.ts:101-201`, `src/tools/themes.ts:54-115` |
| TH-2 | same · member | open | no Edit themes; the chip shows "Waiting for an admin to accept themes", no buttons | `repo-ai.ts:147,153` |
| TH-3 | admin | Edit themes | scrolls to and focuses `#repo-themes-proposed` | `ai-actions.ts:111-119` |
| TH-4 | admin | Accept 5401 | 200; flash "Accepted"; the dashboard re-reads (a870c8a1); test-Emails lane turns active, chip gone; `repo_themes.status='active'`, `decided_by='test-admin'`; `ai_dirty` theme_backfill marked | `src/ai/themes-accept.ts:48-76`, a870c8a1 |
| TH-5 | admin | Rename 5401 to "test-Mail" (Enter) | 200; lane named test-Mail, active | same |
| TH-6 | admin | Rename to "" / 41+ chars / "(x)" / "test-Hosting" (taken) | empty: nothing sent; others 400 → "Couldn't do that. Try again." · question (Q20) (field allows 60, server 40) | `repo-ai.ts:140`, `themes-accept.ts:21` |
| TH-7 | admin | Remove 5401 | 200; "Removed"; theme `removed` | `suggestions.ts:67-80` |
| TH-8 | member | `POST /ai/suggestions/5401/dismiss` | 403 `forbidden` (themes' `dismissRole:"admin"`) | same |
| TH-9 | admin | accept `{value:{mergeInto:<test-Hosting id>}}` (API only) | 200; proposed → removed, `merged_into` set, seeds unioned | `themes-accept.ts:63` |
| TH-10 | themes-proposed-only · org-pro · admin | open | one proposed lane + chip; no caption ("Themes written by Trov …") | `themes.ts:101-114` |
| TH-11 | themes-at-8 · org-free | open | 8 lanes max (`THEME_LANES_MAX`), no proposal | same |
| TH-12 | themes-malformed · org-pro-gifted | open | the bad-seeds lane draws empty; color `zzz` → stone; the removed theme never drawn; the caption naming only the removed theme hidden | `data/themes.ts:44-51`, `themes.ts:107-114` |
| TH-13 | themes-ai-off | open | no section | `themes.ts:99` |
| TH-14 | theme-person-pick | PR 101 | counted in test-Billing (the person's pick), never the AI's | `data/themes.ts:156-167` |
| TH-15 | admin | switch range to Quarter | 13 weeks; no caption on quarter | `shared/ai-core.ts:122`, `themes.ts:107` |
| TH-16 | member | Wrong? on 8w, reload | hidden on the next read (a870c8a1); Quarter still shows | a870c8a1 |
| TH-17 | admin · P:proposed | Accept a fixture chip | ids 900–905 have no rows → 404 → "Couldn't do that. Try again." · question (Q5) | `shared/ai-fixtures.ts:179` |
| TH-18 | P:ready / empty / capped / proposed | open | matches `repo-themes-{ready,empty,capped,proposed}-*.png`; empty "Themes appear once this repo has 15 merged pull requests."; capped "Monthly AI allowance used; themes resume <day>." + Upgrade | `ai-ui.ts:78,145-150` |
| TH-19 | admin · a stale page | Accept a suggestion another admin decided | 409 → "Someone already answered that suggestion." | `ai-actions.ts:67-91` |
| TH-20 | bearer · MCP `get_repo_dashboard {tab:"planning"}` | — | carries `themes` | `src/tools/repo-agent.ts:16-19` |
| TH-21 | member · lane button | press a lane | `aria-pressed`, aria-label "<name>: N merged pull request(s)[, proposed]"; lane detail lists ≤ 8 PR cites | `repo-ai.ts:101-128` |

### FD — Feed: Trov entries, Source switch, the note (real rows need phase-d-digests)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| FD-1 | trov-entry-linked · member | open `#feed` | Trov card: AI-mark avatar, "Trov", "for @test-member", time, summary "Shipped: test- the Safari login fix", body What/Why/Impact + the italic footer; "From #115, 65b9f1f and a1c04e2" linking to GitHub; Wrong?; NO tags on the card | `web/src/render.ts:1227-1253`, `src/tools/feed-ai.ts:15-44`@digests |
| FD-2 | trov-entry-no-subject | — | byline "written by Trov" | `render.ts:1233` |
| FD-3 | trov-entry-unlinked | — | sources as plain text (no links) | `feed-ai.ts:31-40` |
| FD-4 | trov-entry-bad-artifacts | — | no "From …" line | `ai-cites.ts:43-45` |
| FD-5 | trov-entry-many-cites | — | "From #110, #111, 1111111 and 2 more"; tooltip "Written by Trov from … and 2 more. <not official>" | `ai-ui.ts aiFromLine` |
| FD-6 | member | Source = Trov | only `origin='ai'` rows | `render.ts:1203-1217` |
| FD-7 | member | Source = Agents | only agent rows | same |
| FD-8 | member · Source = Trov · a page with no Trov row (filter tags=auth) | — | question (Q27): no cards, no empty text | same |
| FD-9 | org with no Trov rows (org-free) | open | NO Source switch | `feedHasAi` |
| FD-10 | member (first time) | open | the note "Trov now writes entries from your commits, about 45 minutes after your last push. Your agents can stick to decisions and findings." + "AI settings" + "Got it" above the first Trov entry | `render.ts:1219-1226,1262` |
| FD-11 | member | Got it, reload | note gone (localStorage `trov.aiFeedNote`, per handle); member2 still sees it | `ai-actions.ts:37-41,104` |
| FD-12 | private window (storage throws) | Got it | no error; note hides for this page | same |
| FD-13 | trov-entry-wrong-pressed · member2 | open | the Safari entry hidden for member2 only; the page may hold fewer than `limit` rows · question (Q28) | `routes.ts:248-251`@digests |
| FD-14 | trov-entries-ai-off · org-ai-off | open | the Trov entries STILL show with AI styling · question (Q29) | `withAiMeta` never reads the switch |
| FD-15 | member | `?author=test-member` | Trov's digests ABOUT test-member are not included · question (Q30) | `persons.ts:230` |
| FD-16 | P:ready | open `#feed` | fixtures 990001 / 990002 merged (subject "andres"); matches `feed-ready-*.png`; not merged with a tag filter, another author, or `since` | `src/ai/preview.ts:41-47` |
| FD-17 | bearer · MCP `get_feed` | — | Trov rows carry `ai`; Wrong? NOT applied over MCP | `src/mcp.ts` get_feed |
| FD-18 | a deleted subject (delete test-member2's account in a scratch run) | — | "for deleted-…" tombstone · question (Q31) | `HANDLE_COLUMNS` |
| FD-19 | `trov` in Settings › People / pickers | — | never listed (reserved) | `persons.ts:230` |

### FI — importance marks (phase-c-feed)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| FI-1 | feed-importance-mixed | open `#feed` | 701005 "· Breaking" (amber triangle, tooltip "Sift rates this a breaking change: …A rating, not official."); 701006 "· Notable" (accent dot); 701007 routine and 701008 NULL: nothing, byte-identical | `web/src/marks.ts:213-221`@feed, `render.ts:1196-1199` |
| FI-2 | same | `GET /feed` | `importance` key only on 701005 / 701006 / 701007; absent on 701008 | `src/tools/reads.ts:92-95` |
| FI-3 | feed-importance-ai-off | open | marks STILL drawn · question (Q32) | `get_feed` ignores the switch |
| FI-4 | a Trov entry rated notable (set 701020) | open | the mark on the Trov card too | `render.ts:1252` |
| FI-5 | pr-importance | `GET /me/dashboard` (test-member, PR 115 author) | `MyWorkPr.importance` set; nothing drawn on My Work · question (Q33) | `mywork.ts:109`@feed |
| FI-6 | bearer · MCP `get_feed` | — | same `importance` field | `reads.ts:87,92` |
| FI-7 | member | look for a Wrong? / Dismiss on a mark | none · question (Q34) | — |

### TC / UP / RV — Phase C cards (phase-c-tickets; P:ready works for the preview fixtures)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| TC-1 | ticket-with-suggestions · member | open `#tickets/2` | under Properties after OPENED: "Suggested: bug category, because…" and "Suggested: high priority, because…" (Accept / Dismiss each); above Linked work "Suggested: possible duplicate of #1 test-Login page is blank on Safari, because…" with `href="#tickets/1"` | `web/src/ai-cards.ts:29-42`@tickets, `tickets.ts:1066,1078` |
| TC-2 | same | press "because…" | `aria-expanded` toggles; "because it says “the login screen is blank in Safari”" | `ai-ui.ts:185-201` |
| TC-3 | member | Accept 5101 (category) | 200; "Accepted"; ticket re-read; category = bug; no `ticket_events` row; chip gone | `src/ai/jobs/accept.ts:27-77`, `tickets.ts:338-350` |
| TC-4 | member | Accept 5103 (duplicate) | a `ticket_links` row `#1` (url `<origin>/test-ent/#tickets/1`, meta `TROV · TICKET`) by test-member; both tickets stay open | same |
| TC-5 | member | Accept 5103 again (re-seed, link exists) | 200 no-op | `accept.ts:52` |
| TC-6 | member | Dismiss 5102 | "Removed"; chip gone; ticket unchanged | `suggestions.ts:76-82` |
| TC-7 | ticket-suggestion-decided | open `#tickets/1` | no chips (dismissed / accepted / superseded never returned) | `data/ai-cards.ts:39` |
| TC-8 | ticket-done-with-suggestion | open `#tickets/5` | the open chip shows on a done ticket · question (Q35) | `attach.ts` |
| TC-9 | suggestion-missing-ticket | Accept 5115 (ticket #99) | question (Q36): today an unmapped HTTP 500; UI "Couldn't do that. Try again." | `suggestions.ts:65-70`@tickets |
| TC-10 | org-ai-off (5201–5203 stored) | open `#tickets/2` | no `ai`, no chips | `data/ai-cards.ts:31-46` |
| TC-11 | org-free (5301–5303) · member | open | chips drawn (any plan) | same |
| TC-12 | member | `POST accept 5101 {value:"nope"}` (re-seed) | question (Q36): 500 today | `accept.ts` |
| TC-13 | bearer · MCP `get_ticket 2` | — | no `ai` field | `test/ai.cards.test.ts:277-283` |
| TC-14 | P:ready | open `#tickets/3` | fixture chips 901 (bug 0.91), 902 (high), 903 duplicate of #2; Accept → 404 → "Couldn't do that. Try again." | `shared/ai-fixtures.ts:232-271`@tickets |
| TC-15 | P:ready | open `#tickets/1` | no duplicate chip (no #0); done/declined ticket (#5): no fixture | same |
| UP-1 | unplaced-with-suggestion | open `#unplaced` | row 701003: "· [mark] reference, next to “test-Deploy checklist”" (no button); the chip above "File it as": "Suggested: file it as a doc in reference, next to “test-Deploy checklist”," | `web/src/maintenance.ts:132,158`, `ai-cards.ts:45-57` |
| UP-2 | same | the free-form item 701004 | no mark, no chip | `cards.ts:153-161` |
| UP-3 | member | Accept 5116 | the item is filed as a doc proposal in `reference` (staged, by test-member, through the gate); NOTHING promoted; Unplaced re-reads | `accept.ts`, `test/ai.cards.test.ts:219-228` |
| UP-4 | after UP-3 | Accept again | 200 idempotent | same |
| RV-1 | review-with-risk | open `#review` | the staged test-auth-sessions v2 card: "· [mark] Changes a decision"; the draft ADR card: "· Contradicts a doc"; no buttons in the list | `review.ts:130`, `ai-cards.ts:60-65` |
| RV-2 | same | open the proposal's detail | "Trov: Changes a decision, because…" + Dismiss only (NO Accept); cite "test-ADR: cookie sessions" as text; Promote / Reject unchanged | `ai-cards.ts:68-83`, `review.ts:317` |
| RV-3 | member | Accept 5117 via the API | 409 `not_available` | `test/ai.cards.test.ts:235` |
| RV-4 | member | Dismiss 5117 | 200; nothing in Review changes but the line | same |
| RV-5 | adr-ratified-with-risk | `GET /adrs?status=ratified` | 5119 still attached · question (Q37) | `attach.ts:79` |
| RV-6 | P:ready with both proposals and draft ADRs | press because… on one | question (Q38): the twin opens too (ids 905/906 collide) | phase-C map § 5 |
| RV-7 | doc-drift-proposal (phase-d-roadmap) | open `#review` | test-webhook-retries v2 by **trov**, low confidence, summary "Trov: … Low confidence: check it against them before promoting."; Promote / Reject as any proposal | `src/ai/doc-drift.ts:58-191` |
| RV-8 | ask-flags-review | open the staged doc's detail and the draft ADR | a "Flagged in Ask" line: reason words + counts (2 × "A source is wrong", 1 × "It is out of date"); NEVER the question, answer or asker | handoff #12 § 2.14, `src/routes.ts:325,338` |
| RV-9 | same | `GET /proposals`, `GET /adrs?status=draft` | `askFlags[{ref, reason, count, lastAt}]` | same |

### RM — Roadmap (phase-d-roadmap)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| RM-1 | sprint-active-forecast · member | open `#roadmap` (Narrative tab) | on test-Sprint Hosting: "At this pace, done <date>, N days late/early" or ", on the due day" (2 of 5 closed in 11 days → projected from today) with an arithmetic tooltip and NO AI mark | `web/src/roadmap-ai.ts:36-50` |
| RM-2 | same | the upcoming and done sprints | no forecast | `sprintForecast` |
| RM-3 | sprint-note | — | the note "test- #1 is in progress and #2 has no assignee; #5 closed this week." + "Written by Trov, 5h ago" + cites + Wrong? on the ACTIVE sprint; the done sprint's note not drawn | `roadmap-ai.ts:54-67`, `sprints.ts withNote` |
| RM-4 | plan-drift | — | the drift line + "test-Search 48% (in no sprint) · test-Hosting 32% · test-Auth 20% (in no sprint)" + "Written by Trov from the last 14 days, 4h ago" | `roadmap-ai.ts:71-89` |
| RM-5 | roadmap-suggestions · admin · org-enterprise | — | card "Suggested: a new plan narrative, because…" with the markdown | `roadmap-ai.ts:113-126` |
| RM-6 | same · member | — | no suggestion cards | `org-insights.ts:132-152` |
| RM-7 | admin | Accept 5501 | `write_plan` as test-admin; "Accepted"; the Roadmap reloads with the new narrative | `roadmap-accept.ts:22-50` |
| RM-8 | org-pro · admin | — | 5502 card "Suggested: 2 sprints from 4 backlog tickets" with names, goals, `#7` `#8` `#9` `#12` links; 5503 skipped | same |
| RM-9 | org-pro · admin | Accept 5502 | two UPCOMING sprints, no dates, created by test-admin; tickets 7, 8, 9, 12 moved (only still-open backlog ones) | same |
| RM-10 | org-pro | (drift written 15 days ago) | no drift line | `org-insights.ts:77-90` |
| RM-11 | sprint-note-malformed · org-pro-gifted | — | no note | `AiRoadmapLineSchema` |
| RM-12 | roadmap-ai-off | open | no notes, no drift, no suggestion cards; the forecast STILL shows (arithmetic, not gated) | `org-insights.ts:43-48` |
| RM-13 | member | Wrong? on the note, reload | hidden server-side for test-member | `org-insights.ts:132-146` |
| RM-14 | bearer · MCP `get_roadmap`, `list_sprints`, `get_sprint` | — | forecast, notes, drift; never suggestions; a note test-member hid on the web still shows over MCP | `src/mcp.ts:187,224,231` |
| RM-15 | member | open `#sprints/<id>` | question (Q39): note and forecast not drawn on the sprint page | — |
| RM-16 | admin | Accept 5502 whose value fails `AiSprintDraftValueSchema` (5503 via API) | 400 `{error:"invalid", message:"that sprint draft is not one Trov can create"}`; reopened; UI "Couldn't do that. Try again." · question (Q40) | `routes.ts:89-99`@roadmap |
| RM-17 | P:ready · admin | open | the roadmap fixture: notes on active sprints, the drift "The last two weeks went mostly to Billing and plans…", suggestions 9101 / 9102 (Accept → 404) | `preview.ts:42-49`@roadmap |

### EM — e-mail (phase-e-emails, WIP: re-read `src/notifications/*` at merge)

Mail is never sent: `NOTIFICATIONS_MODE=local` writes `notification_outbox_bodies`; read them with
`npx wrangler d1 execute DB --local --json --command "SELECT idempotency_key,to_address,subject,html,text FROM notification_outbox_bodies ORDER BY created_at DESC"`
and open the `html` from a localhost page. A cron run needs `wrangler dev --test-scheduled` (Q16) and
`notification_settings.send_hour` = the current New York hour; delete the window's outbox rows to rerun.

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| EM-1 | admin · brief-ready-5-next exists for test-member | preview `GET /notifications/preview?cadence=daily` as test-member? (admin only: render for the CALLER) | admin preview renders the ADMIN's digest (brief-empty → fallback); "Nothing to render" page when empty | `src/notifications/routes.ts:250-269` |
| EM-2 | cron run (daily) · test-member (brief-ready-5-next) | read the body | subject = the brief's top Next item ("test- CI run 4812 is failing on your pull request #115, plus N more" — Q41); "Your brief": Now + up to 3 Next; links absolute `http://localhost:8787/test-ent/#…` (never a bare `#…`) | `assemble.ts:330-333`@E, spec Phase E · question (Q41, Q42) |
| EM-3 | cron run · org-ai-off · test-member | — | AI off: subject from the first assigned item; the 3 most recent assigned items in plain words; no "Also" | spec Phase E |
| EM-4 | cron · feed-importance-mixed touching test-member (701005 by test-member, breaking) | — | "Also": ≤ 3 one-line items, notable / breaking only, each a title + link | spec Phase E · question (Q43) |
| EM-5 | cron · review queue non-empty (staged doc + draft ADR) | — | "Review: 2 waiting, 1 changes a decision" (5117 risk) | spec Phase E · question (Q44) |
| EM-6 | cron · sprint-active-forecast | — | "Sprint: test-Sprint Hosting, due <weekday>, 2 of 5 done" | spec · question (Q45) |
| EM-7 | cron · removed parts | — | NO per-PR What/Why/Impact rows, NO issue detail rows, NO full plan diff; empty sections omitted | spec Phase E |
| EM-8 | notify-only-when-needed-skip · test-member2 | cron daily | outbox row `skipped`, no body | `run.ts:95-96`@E |
| EM-9 | notify-only-when-needed-send · org-free test-member | cron daily | sent (brief has one Next) | same |
| EM-10 | notify-only-when-needed-off-row · test-admin | cron | sent as usual | same |
| EM-11 | person-noemail / person-unsubscribed | cron | no outbox row for them | `run.ts:133-141` |
| EM-12 | week-highlights · cron weekly (a Monday, or the preview `cadence=weekly`) | — | the brief, then "This week" with 3 cited highlights, then ONE numbers line "N pull requests merged, N tickets done, N entries in the Feed" (zero parts left out) | `renderers/week-recap.ts`@E |
| EM-13 | week-highlights-ai-off | weekly | no highlights (switch off); numbers line only | same |
| EM-14 | week-highlights-malformed · org-pro | weekly | no highlights | same |
| EM-15 | week-highlights-none · org-free | weekly | numbers line only; `prsMerged` null → the PR part left out when no repo (org-free HAS a repo → counted) | same |
| EM-16 | empty-org · weekly | — | all zero, no highlights → section null → `skipped` | same |
| EM-17 | member | Settings › Email notifications | a switch "Only when something needs me" with its sentence; `<button role="switch" aria-checked>` with an accessible name; Enter / Space toggle; `PUT /prefs {onlyWhenNeeded}` persists across reload | `web/src/notifications.ts:132-135`@E, `routes.ts:65,100` |
| EM-18 | person-unsubscribed | Settings | question (Q46): is the new switch dimmed / inert while unsubscribed? | — |
| EM-19 | admin | test send (`POST /notifications/test-send {cadence:"daily"}`) | a body row `org:login:daily:test-<ts>`; rate-limited `test_send` | `routes.ts:279-319` |
| EM-20 | member | `GET /notifications/preview` | 403 (admin only) | `routes.ts:109` |
| EM-21 | the HTML body | open at 360 px and with `prefers-color-scheme: dark` | the card stays fluid (≤ 520 px CSS); the dark swap applies to every new block; no `<link>`, `<img>`, `<script>` or web font | `assemble.ts:174-183,247`, `notifications.email-kinds.test.ts` |
| EM-22 | the text part | read `text` | present for every sent digest; layout · question (Q47) | `assemble.ts:364-383` |
| EM-23 | signed out | open the e-mail's `http://localhost:8787/test-ent/#mywork` link, Sign in | lands on `/test-ent/#mywork` after sign-in (the return-to) | `main.ts:2328-2347,4822-4830` |
| EM-24 | the footer | — | "You're getting the daily Trov digest for test-member" + Unsubscribe; `List-Unsubscribe` header in the stored row | `assemble.ts:359-361` |
| EM-25 | pre-warm at `:50` before send_hour · org-enterprise | `__scheduled` at minute 50 | `ai_dirty (person, <handle>, urgent=1)` for each recipient; org-ai-off: none | `notifications/cron.ts:68-96`, `ai-dirty.ts:69` |

## 5. Ask Trov

### AK — the API (`src/ai/ask/routes.ts` = R; in the browser's own `fetch`)

Keyless unless stated: everything below except AK-14…AK-17 runs with NO key. `/ask` with `command:"search"` is the
whole flow without a model.

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| AK-1 | org-enterprise · member · no key | `GET /ask/state` | `{enabled:true, eligibility:"no_key", plan:"enterprise", modes:[fast,smart,thinking], defaultMode:"fast" (ask-settings-member), allowance:{used:64, cap:null, low:false}, autoAllowed:true, attach:{maxFiles:5, maxBytes:10485760, kinds:["image","pdf","text"]}, starters ≤ 4}` with "What shipped this week?" first and "Summarize ticket #<top assigned>" | R:113-133, 97-111 |
| AK-2 | org-free · member | `GET /ask/state` | `modes:[smart]`; `defaultMode:"smart"` although `thinking` is stored (ask-settings-free-thinking); cap 50, used 20 | R:87, `shared/ai-ask-core.ts:48-50` |
| AK-3 | org-chat-3-left · member · `K:dummy` | `GET /ask/state` | `eligibility:"ok"`, cap 300, used 297, `low:true` | R:90 |
| AK-4 | org-pro-gifted-3-members · `K:dummy` | `GET /ask/state` | cap 900 (300 × 3) · question (Q48): today 300 (`allowanceOf` ignores members) | handoff #12 § 2.1, Ask map § 5.1 |
| AK-5 | org-at-cap · `K:dummy` | `GET /ask/state` | `eligibility:"capped"`, `resetsAt` 1st of next month | R:119 |
| AK-6 | org-ai-off · `K:dummy` | `GET /ask/state` | `enabled:false`, `eligibility:"off"` | same |
| AK-7 | org-auto-off | `GET /ask/state` | `autoAllowed:false` | same |
| AK-8 | member | `POST /ask/peek {refs:["ticket:1","ticket:999","doc:test-deploy-checklist","artifact:test-test-ent-private-notes","person:TEST-ADMIN","foo:1"]}` | in order: ticket #1 RefView (status word "In progress"), `{ref:"ticket:999",hidden:true}`, the doc ("Live"), the private artifact HIDDEN (test-member2's), person lowercased test-admin, foo:1 hidden | R:137-145, `refs.ts:104,162-320` |
| AK-9 | member | peek with `[]`, 51 refs, `["Ticket:1"]`, an extra key | 400 `invalid` each | `shared/ai-ask.ts:113` |
| AK-10 | member2 | peek the private artifact | visible to its author | `refs.ts` |
| AK-11 | member | `GET /ask/item/ticket:1`, `pr:115`, `doc:test-deploy-checklist`, `sprint:<id>`, `handoff:1`, `feed:701005`, `person:test-admin`, `repo:test-org%2Ftest-ent-repo` | `{view, detail}` per type (ticket `{ticket, artifacts, prs}`, pr `{what, why, impact, linkedTo, files:null…}`, doc `{body, versions}`, …) | R:147-190 |
| AK-12 | member | `GET /ask/item/ticket:999`, the private artifact | 404 `{ref, hidden:true}` | R:151 |
| AK-13 | member | `GET /ask/item/%25` | 400/404, never 500 · question (Q49): likely 500 today | Ask map § 5.7, inv. 7 |
| AK-14 | org-at-cap · `K:dummy` | `POST /ask {text:"hi", mode:"smart"}` | 200 SSE: one `error {code:"capped", message:"You've used this month's questions. Resets <Mon D>."}`; no `thread` event; nothing stored, nothing metered, NO network call | R:297-301 |
| AK-15 | org-ai-off · `K:dummy` | `POST /ask` (and with `command:"search"`) | `error {code:"off", message:"Ask Trov is off for this org. An admin can turn it on in Org settings › AI."}` | same |
| AK-16 | org-chat-3-left · `K:dummy` | `POST /ask {mode:"thinking"}` | `capped` (5 > 3 left) while `/ask/state` says ok · question (Q50) | R:297-301 |
| AK-17 | org-canceled · `K:dummy` | `POST /ask` | `capped` | `planRefusal` |
| AK-18 | no key · member | `POST /ask {text:"hi", mode:"smart"}` | `error {code:"no_key", message:"Ask Trov is not set up on this deployment."}` | R:297 |
| AK-19 | no key · member | `POST /ask {text:"/search netlify", command:"search", mode:"smart"}` | events in order: `thread` → `activity {step:1, tool:"search", label:"Searched Trov for 'netlify'", state:"run"}` → `activity {state:"done", resultLine:"N results"}` → `text` → `block {kind:"items"}` (≤ 9) → `thread` (title "Search: netlify") → `done {messageId, cites, tokens 0/0/0}`; stored with `units 0`; NOT metered | R:409-438 |
| AK-20 | same | `command:"search"`, text "x" (1 char) | "Nothing in Trov matches “x”." | same |
| AK-21 | same | stored vs streamed result line | question (Q51): stored "1 results" vs streamed "1 result" | Ask map § 5.8 |
| AK-22 | org-free · member | `POST /ask {mode:"thinking"}` | 403 `{error:"mode_unavailable", message:"Thinking is not on this organization's plan.", modes:[…]}` (also for search) | R:246 |
| AK-23 | member | bodies: unknown key, no `mode`, text 16001 chars, 13 context refs, 6 attachments, `threadId:0` | 400 `invalid` each | `shared/ai-ask.ts:101-111` |
| AK-24 | member | `threadId` of member2's thread (801006) / other org's (814001) | 404 | R:214 |
| AK-25 | member | `replaceFrom` not the last question / answer | 400 "Only the last question or answer can be replaced." | R:223,232 |
| AK-26 | member | edit with empty text; whitespace-only text | 400 "Say something." | R:229,235 |
| AK-27 | member · search | `{auto:true}` in org-auto-off | runs as not-auto (no `auto_off` on POST /ask) · question (Q52) | R:306-308 |
| AK-28 | member · search with `context:["ticket:1","artifact:test-test-ent-private-notes"]`, origin `panel` | then `GET` the thread | stored context keeps ticket:1 only; `context_ref` = raw `context[0]` · question (Q53) when context[0] is hidden | R:307,316-334 |
| AK-29 | member · search with `replaceFrom` = the last question of 801001 | — | the old question + answer get `replaced_at`, out of FTS; the thread's undecided cards (801201…) EXPIRE | `startTurn`, `replaceMessagesFrom` |
| AK-30 | member | `GET /ask/threads` | ask-threads-member: pinned first (801002), then by `updated_at`; groups pinned / today / week / earlier; untitled 801005 listed with `title:""`; NOT 801006 (member2's) | R:494-526 |
| AK-31 | member | `GET /ask/threads?q=webhook` | hits with `snippet{text, matches}` from questions AND answers; a title-only hit has `snippet:null, matchCount:0` | same · question (Q54) ask.md says "own messages" |
| AK-32 | member | `?q="unbalanced` | `[]`, not an error | `data/ask.ts:107` |
| AK-33 | member | `GET /ask/threads/801001` | live messages; cards on 801102 with `editable` only for proposed / waiting; `note:null` on the waiting card · question (Q55) | R:533,555-559 |
| AK-34 | member | `PATCH 801001 {title:"  "}`, `{title: 81 chars}`, `{draft: 16001}` | 400 | strict schema |
| AK-35 | member · org-auto-off thread (create one by search) | `PATCH {auto:true}` | 409 `auto_off` "An admin turned off Auto for this org. Trov asks before every change." | R |
| AK-36 | member · org-free thread 804001 | `PATCH {mode:"thinking"}` | 403 `mode_unavailable` | same |
| AK-37 | member | `PATCH 801003 {pinned:true}` | moves to Pinned; `updated_at` unchanged | same |
| AK-38 | member | `DELETE 801003` twice | `{ok:true}`, then 404; its messages / cards gone; artifacts stay | same |
| AK-39 | member | `GET /ask/threads/801004/export` | `text/markdown`, filename from the title with non `[A-Za-z0-9 _-]` stripped (injection title → "img srcx onerroralert1 Rsum"…), body `# title`, `**You**` / `**Trov (smart)**`; HTML stays text | R:595-607 · question (Q56) |
| AK-40 | member | `POST /ask/messages/801102/save-form` | `{block:{kind:"save_form", form{title:"test-What is blocking #1?, Oct 15", kind:"markdown", visibility:"private"}}}`; twice → two forms | R:610-623 |
| AK-41 | member | save-form on a user message (801101) | 404 | same |
| AK-42 | member | `POST /ask/threads/801001/save {messageId:801102, title:"test-Saved", kind:"markdown", visibility:"private"}` | `{slug, url:"#artifacts/<slug>"}`; an artifact (area data, "Saved from Ask Trov") linked to tickets #1, #2; `chat_artifacts role='saved'` | R:625-649 |
| AK-43 | member | save with `kind:"pdf"` / title "" | 400 | same |
| AK-44 | member | confirm 801201 (create_ticket) | 200 `{results:[{state:"confirmed", ref:"ticket:15", undo:true}]}`; ticket #15 created by test-member | R:674-723 |
| AK-45 | member | confirm 801202 (transition #1 → testing; member is the assignee) | confirmed; #1 testing | `tickets-agent.ts` |
| AK-46 | member | confirm 801214 (#7, no assignee) | 200 with `state:"failed"`, `result {code:"forbidden"}` | same |
| AK-47 | member | confirm 801203 (group) | BOTH 801203 and 801204 confirmed, in id order; `{only:true}` → one | R |
| AK-48 | member | confirm 801203 with `args:{title:"test-Edited"}` | the edited title used; `args:{nope:1}` → 400 "not editable: nope", state restored | R:703 |
| AK-49 | member | confirm 801207 (expired) / 801208 (stale turn) | 409 `expired` "This card expired with its turn. Ask again."; 801208 becomes expired | R |
| AK-50 | member | confirm 801209 (confirmed) / 801210 (cancelled) / twice | 409 `already` "This card was already <state>." | same |
| AK-51 | member | confirm 801206 (publish_doc, waiting) | the staged test-auth-sessions v2 promoted through the Review path as test-member | handoff #12 § 2.12 |
| AK-52 | member (not admin) | confirm 801213 (update_plan on test-admin's thread) | 404 (not their card) | R |
| AK-53 | admin | confirm 801213 | plan narrative written as test-admin · question (Q57): a member confirming a stale update_plan card | Ask map § 5.2 |
| AK-54 | member | cancel 801205 | `{results:[{state:"cancelled"}]}`; cancel 801207 → 409 `expired` | R:725-735 |
| AK-55 | member | undo 801211 (stamp matches #1) | #1 back to triage; card `undone` | R:739-763 |
| AK-56 | member | undo 801212 (stale stamp) | 409 `changed` "Changed since. Undo it by hand." + `ref` | same |
| AK-57 | member | undo 801201 (proposed) / undo twice | 409 `no_undo` "There is nothing to undo here." | same |
| AK-58 | member | `POST /ask/attachments` multipart with one 10485760-byte text file | 200; a private artifact; `threadId` of a NEW untitled thread | R:774-805 |
| AK-59 | member | 10485761 bytes | 413 `too_large` "<name> is too large. Files can be up to 10 MB." | `attachments.ts:40-51` |
| AK-60 | member | 0 files; 6 files; a 0-byte file; an extensionless octet-stream | 400 "attach at least one file" / "at most 5 files per message" / "<name> is empty"; 415 `unsupported` | same |
| AK-61 | member | JSON body | 400 "Send multipart/form-data with file fields." | same |
| AK-62 | member | `threadId` = 801006 | 404 | same |
| AK-63 | member | `POST /ask/messages/801102/wrong {reason:"source_wrong"}` twice | `{ok:true}` both; one `ai_feedback` (item_type ask) + one `ask_flags` row per cite (ticket:1, ticket:2); second press adds nothing | R:809-820 |
| AK-64 | member | wrong `{reason:"missed"}` | feedback only, no flags | same |
| AK-65 | member | wrong `{reason:"bad"}` | 400 | same |
| AK-66 | member | `GET /ask/settings` | `{instructions:"test- Answer briefly, in bullet points.", defaultMode:"fast", modes}` | R:824-840 |
| AK-67 | member | `PUT {instructions: 501 chars}` / `{instructions:"🚀"×250}` (500 UTF-16 units) | 400 / 200 | same |
| AK-68 | org-free · member | `PUT {defaultMode:"thinking"}` | 403 "On Free, every question uses Smart." | same |
| AK-69 | member | `PUT {instructions:""}` | cleared | same |
| AK-70 | member | `POST /ask/threads/801001/stop` | `{ok:true}`; `stop_requested=1` (observable effect needs a model turn) | R |

### AR — the dev replay

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| AR-1 | preview unset | `GET /ai/ask-replay` | 404 `not_found` | `src/ai/routes.ts:165-178` |
| AR-2 | P:ready on `http://localhost:8787` | `GET /ai/ask-replay` | `{scenarios (17), questions, state:{pro,free}, settings, threads, search, refs}` | same |
| AR-3 | P:ready on `http://127.0.0.1:8787` / `http://[::1]:8787` / a LAN IP | — | 200 / 404 / 404 | `src/platform/loopback.ts:12-25` |
| AR-4 | P:ready | `GET /ai/ask-replay/answer?speed=0` | `text/event-stream`, every event at once, ends with `done` | same |
| AR-5 | P:ready | `streaming` | stops at text token 58, no `done` | Ask map § 4 |
| AR-6 | P:ready | `thinking?speed=1` | a ~14 s pause, then `thinking {state:"done", seconds:14}` | same |
| AR-7 | P:ready | `live`, `ticket`, `settings` | 200, empty body | same |
| AR-8 | P:ready | `/nope` | 404 | same |
| AR-9 | P:ready | `?speed=-3`, `?speed=abc`, `?speed=999` | 0 / 0 / 50 | same |
| AR-10 | P:ready · org-ai-off, no key | `answer` | still replays (ignores plan, key, switch) | same |

### AU — the Ask screen (ai/ask; map from handoff #12 § 3 and the design `docs/superpowers/specs/ask-trov.dc.html`)

The frontend is WIP on `ai/ask`; each case compares to the design scenario named. Real data: the seed's threads and
cards through the real routes; model answers through the replay (P:ready), never a key.

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| AU-1 | member | open the sidebar | one item "Trov" (constellation icon) in Workspace after My Work; nothing else in the sidebar moves; the sidebar DOM stays structurally stable | handoff #12 § 3 Nav, `test/render.sidebar.test.ts` |
| AU-2 | member | open Ask (`live`) | three columns: thread list 260 px (collapsible), conversation ≤ 720 px, inspector closed; header "Trov › <thread title>" | § 3 Ask screen |
| AU-3 | member | the thread list | groups Pinned (test-Pinned: sprint plan), Today, This week, Earlier; the injection title drawn as text | § 2.15 |
| AU-4 | member | thread menu: Rename / Pin / Export / Delete | each through the routes (AK-34…39); Delete asks via `confirmModal` | § 2.15, CLAUDE.md (confirmModal) |
| AU-5 | member | search the list "webhook" | hits with highlighted matches | § 2.15 |
| AU-6 | member | open 801001 | the question bubble right-aligned; the answer with ref chips #1 / #2 (live status marks); hover a chip 320 ms → hover card (priority, assignees, sprint) | § 3 Conversation |
| AU-7 | member | the answer footer | Trov mark, mode word "Smart", "2 sources" (opens a numbered list), Copy, Regenerate (+ "Regenerate with"), Save as artifact, Wrong? with "A source is wrong" / "It is out of date" / "It missed something" | § 3 |
| AU-8 | member | Wrong? → "A source is wrong" | toast "…The team can see this in Review."; AK-63's rows | § 2.14 |
| AU-9 | member | the cards on 801001 (actions-ask) | draft cards with Confirm / Cancel / inline Edit; after each: a done line, "Cancelled: …", "Undone: …"; the group card "Filed tickets …"; the waiting publish card's note "Publishing waits for you, even on Auto." | § 3 Actions, copy changes |
| AU-10 | member | Undo on the auto card 801212 | "Changed since. Undo it by hand." with a link | § 2.12 |
| AU-11 | member | Save as artifact | a save_form card (title, Kind Markdown / HTML page, Who can see it Private / Org); Save → "Saved as artifact: <title>" + visibility + Open | § 3 Save |
| AU-12 | member | ⌘J on `#tickets/1` | the 420 px panel on the right, the ticket as context, "Ask first" label, "Open as thread"; on the Ask screen ⌘J focuses the composer | § 2.18 |
| AU-13 | member | Escape order | picker → menus → hover card → ⌘J panel → inspector | § 3 |
| AU-14 | member | composer: Enter sends, Shift+Enter newline; `@` picker grouped by type (keyboard select); `/` commands | as designed | § 3 Composer |
| AU-15 | member | attach (button / drag "Drop files to attach" / paste) | chips; an 11 MB file → the too-large note "…up to 10 MB" | § 3, copy changes |
| AU-16 | org-free · member | the composer | NO mode switcher; Settings › Trov "On Free, every question uses Smart." | § 2.1 |
| AU-17 | org-pro · member | the mode menu | Fast / Smart / Thinking; Thinking's hint "…Counts as 5 questions." | copy changes |
| AU-18 | org-auto-off | the Ask before changes / Auto switch | Auto disabled with its tooltip | § 3 Composer |
| AU-19 | org-chat-3-left · `K:dummy` | composer | the usage line (under 20 % left) | § 3 |
| AU-20 | org-at-cap · `K:dummy` | composer | the "used up" block; Send disabled | § 3 |
| AU-21 | org-ai-off · `K:dummy` | composer | the "off" block | § 3 |
| AU-22 | no key | composer, send "hi" | the no_key error shown in the answer area ("Ask Trov is not set up on this deployment.") · question (Q58): the design has no no_key state | — |
| AU-23 | no key | send "/search netlify" | a real answer: activity "Searched Trov for 'netlify'" → items; the thread titled "Search: netlify" | AK-19 |
| AU-24 | P:ready | each replay scenario (`streaming`, `thinking`, `answer`, `answer-pr`, `actions-ask`, `actions-auto`, `artifact`, `artifact-saved`, `search`, `notfound`, `cmdj`) | matches the design's scenario: streaming soft cursor; "Thinking… Ns" → "Thought for 14s"; blocks (table with status cells, item cards, bar chart "Data from Trov" + total, theme strip, dependency diagram, not found "What I searched" + two rephrase chips) | § 3 Blocks |
| AU-25 | member | the inspector (`answer-pr`, `insp:<type>`) | 480 px, resizable 380–720; Back with a breadcrumb; Open in page; Close; views per type as § 3 lists | § 3 Inspector |
| AU-26 | member · repo inspector | open `repo:<repo>` on org_saplinglearn after repo-setups | environments with health from RepoFacts: Healthy only when CI passes; null is Unknown; hosts named by part label; usage in the four states; fixtures from #186's scenarios A–N | `main-186-for-ask.md` § 4–6 |
| AU-27 | 360 · `phone`, `phone-plus`, `phone-insp` | open | thread list in a drawer; the composer's controls under one "+" with "Smart · Asks first"; the inspector a full-height sheet | § 3 Phone |
| AU-28 | member | Settings › Trov (`settings`) | "How Trov should answer you" + counter + Try chips; Default mode (Pro); "What Trov can see" (true to the tool list, links to the right Org settings tab: Integrations / Hosting / Environments / Repositories › Apps after #186); Save | § 2.19, `main-186-for-ask.md` § 7 |
| AU-29 | member | Stop while streaming (replay) | "Stopped. The answer above is partial." | § 2.17 |
| AU-30 | member | edit the last question | "Sending replaces the answer below"; the replaced answer's cards expire | § 2.16 |
| AU-31 | member | the error block | "Something went wrong. Nothing was changed. Try again" | § 3 Blocks |
| AU-32 | member | the injection thread 801004 | HTML / script / javascript: link rendered inert as text | — |

## 5b. Background jobs, MCP, legal

### JB — keyless background behaviour (the router writes `ai_dirty`; nothing calls a model)

| id | state | act | expected | source |
| --- | --- | --- | --- | --- |
| JB-1 | member · org-enterprise | create a ticket on `#tickets` | `ai_dirty`: `card ticket:15`, `org ''` (re-mark keeps `dirty_since`, sets `marked_at`, `attempts=0`) | `src/tools/ai-route.ts:77-113`, `ai-dirty.ts:60-144` |
| JB-2 | member | move ticket #1 to Testing | `person test-member`, `sprint <id>`, `org ''` | same |
| JB-3 | member | send a handoff to anyone | `person <member>` for up to 20 members | same |
| JB-4 | admin | promote the staged doc in Review | `card tagfit:doc:test-auth-sessions`, `doc_drift test-auth-sessions` | same |
| JB-5 | member | route an Unplaced item | `card unplaced:<id>` | same |
| JB-6 | bearer | MCP `append_feed` | `card feed:<id>`, `person test-member` | same |
| JB-7 | org-ai-off | JB-1 there | NO `ai_dirty` row | `ai-dirty.ts:69` |
| JB-8 | no key · `wrangler dev --test-scheduled`, `GET /__scheduled?cron=*/10+*+*+*+*` at a non-heavy minute | — | the pass reads nothing for Claude jobs (no `ai_batches`, no `org_usage_daily` change); `ai_dirty` untouched; Jev jobs skip too without the TypeSafe key | `src/ai/pass.ts:117-129` · question (Q16) |
| JB-9 | ai-dirty-scopes | after JB-8 | the parked repo scope (attempts 3) stays parked | `pass.ts` |
| JB-10 | gifted org with `plan_gift_until` in the past (edit org-pro-gifted) | a tick | the org moves to Free | `src/repo/cron.ts:601-610` |

### MC — MCP reads (bearer `bearer-token`, test-member in org-enterprise)

| id | act | expected | source |
| --- | --- | --- | --- |
| MC-1 | `tools/list` | no tool that promotes, ratifies, accepts or dismisses a suggestion; Ask's publish is not an MCP tool | inv. 2, handoff #12 § 2.12 |
| MC-2 | `get_my_work`, `get_repo_dashboard`, `get_feed`, `get_roadmap` with P:ready set | NO preview fixture over MCP | `src/ai/preview.ts` |
| MC-3 | `get_ticket 2` (Phase C) | no `ai` | TC-13 |
| MC-4 | the bearer on `/api/o/test-ent/ai/settings` with a cookie | 403 cookie-only | G-4 |

### LG — Phase G legal drafts (`web/src/legal.ts`)

| id | act | expected | source |
| --- | --- | --- | --- |
| LG-1 | signed out, open `/terms` | the Ask Trov / AI pass / weekly recap passages, marked DRAFT; the widened provider list (Anthropic, TypeSafe AI) | f03e8781 |
| LG-2 | signed out, open `/privacy` | the same, with what is sent and never sent matching Org settings › AI's "What is sent" | `shared/ai-core.ts:229-243` |
| LG-3 | `/terms`, `/privacy` | prerendered, no console error, `noindex` rules unchanged | `web-ui.md` › public pages |

## 6. Environment (grid: one case per ✓)

The functional case named in "base" runs at desktop light (that run is the base case, not counted again). Each ✓ is
one more run of that state: id `EV-<row>-<col>` (cols: `D` desktop dark, `P` 360 light, `PD` 360 dark, `K` keyboard
only at desktop light). Every run checks: no horizontal page scroll (a chart may scroll inside its card: TH),
no overflow or clipped text, text readable (4.5:1) in both themes, marks are elements not glyph pills, every control
reachable and operable by keyboard with a visible focus ring, no console error.

| row | base | D | P | PD | K |
| --- | --- | --- | --- | --- | --- |
| OA-admin | OA-1 | ✓ | ✓ | ✓ | ✓ (both switches: Space / Enter, `aria-checked`) |
| OA-member | OA-2 | ✓ | ✓ | ✓ | — |
| OA-nokey | OA-12 | ✓ | ✓ | ✓ | — |
| OA-capped | OA-10 | ✓ | ✓ | ✓ | — |
| OA-loading | OA-24 | ✓ | ✓ | ✓ | — |
| OA-failed | OA-25 | ✓ | ✓ | ✓ | ✓ (Try again) |
| SF-cell | SF-6 | ✓ | ✓ | ✓ | ✓ (switch, "What is sent" popover opens and closes with Escape) |
| SF-off | SF-3 | ✓ | ✓ | ✓ | — |
| SF-modal | SF-11 | ✓ | ✓ | ✓ | ✓ (focus trapped in the modal, Escape closes) |
| PU-line | PU-3 | ✓ | ✓ | ✓ | — |
| PU-org | PU-4 | ✓ | ✓ | ✓ | — |
| FL-box | FL-3 | ✓ | ✓ | ✓ | ✓ (type, Enter applies, Undo reachable) |
| FL-applied | FL-13 | ✓ | ✓ | ✓ | — |
| FL-error | FL-18 | ✓ | ✓ | ✓ | — |
| FL-402 | FL-7 | ✓ | ✓ | ✓ | — |
| RL-list | RL-1 | ✓ | ✓ | ✓ | ✓ (rows are links) |
| BR-ready | BR-1 | ✓ | ✓ | ✓ | ✓ (Next titles, Wrong?) |
| BR-one | BR-3 | ✓ | ✓ | ✓ | — |
| BR-empty | BR-4 | ✓ | ✓ | ✓ | — |
| BR-capped | BR-5 | ✓ | ✓ | ✓ | ✓ (Upgrade) |
| BR-absent | BR-7 | ✓ | ✓ | ✓ | — |
| ST-ready | ST-1 | ✓ | ✓ | ✓ | ✓ (cites, Wrong?) |
| ST-capped | ST-3 | ✓ | ✓ | ✓ | — |
| ST-repofacts | ST-15 | ✓ | ✓ | ✓ | — |
| ST-found | ST-17 | ✓ | ✓ | ✓ | — |
| TH-admin | TH-1 | ✓ | ✓ (chart scrolls INSIDE its card; lane column 136 px) | ✓ | ✓ (lanes `aria-pressed`, range switch, Accept / Rename (Enter saves) / Remove) |
| TH-member | TH-2 | ✓ | ✓ | ✓ | — |
| TH-malformed | TH-12 | ✓ | ✓ | ✓ | — |
| TH-empty | TH-18 (P:empty) | ✓ | ✓ | ✓ | — |
| FD-trov | FD-1 + FD-10 | ✓ | ✓ | ✓ | ✓ (Source switch is a `segmented()`, Got it, Wrong?) |
| FD-source | FD-6 | ✓ | ✓ | ✓ | — |
| FI-marks | FI-1 | ✓ | ✓ | ✓ | — (tooltips via `data-mtip` on focus) |
| TC-chips | TC-1 + TC-2 | ✓ | ✓ | ✓ | ✓ (because… `aria-expanded`, Accept / Dismiss) |
| UP-chip | UP-1 | ✓ | ✓ | ✓ | ✓ |
| RV-list | RV-1 | ✓ | ✓ | ✓ | — |
| RV-detail | RV-2 | ✓ | ✓ | ✓ | ✓ (Dismiss) |
| RV-flags | RV-8 | ✓ | ✓ | ✓ | — |
| RM-lines | RM-1 + RM-3 + RM-4 | ✓ | ✓ | ✓ | ✓ (Wrong?) |
| RM-cards | RM-5 / RM-8 | ✓ | ✓ | ✓ | ✓ (Accept / Dismiss) |
| EM-daily | EM-2 (the body in a browser) | ✓ | ✓ | ✓ | — |
| EM-weekly | EM-12 | ✓ | ✓ | ✓ | — |
| EM-settings | EM-17 | ✓ | ✓ | ✓ | ✓ |
| AU-live | AU-2 | ✓ | — (phone is its own scenario) | — | ✓ (thread list, menus) |
| AU-answer | AU-6 + AU-7 | ✓ | — | — | ✓ (chips, footer, Wrong? menu) |
| AU-actions-ask | AU-9 | ✓ | — | — | ✓ (Confirm / Cancel / Edit) |
| AU-actions-auto | AU-24 actions-auto | ✓ | — | — | ✓ (Undo) |
| AU-artifact | AU-11 | ✓ | — | — | ✓ (the form) |
| AU-search | AU-23 | ✓ | — | — | — |
| AU-notfound | AU-24 notfound | ✓ | — | — | ✓ (rephrase chips) |
| AU-cmdj | AU-12 | ✓ | — | — | ✓ (⌘J, Escape) |
| AU-settings | AU-28 | ✓ | ✓ | ✓ | ✓ (counter, Try chips, Save) |
| AU-composer-capped | AU-20 | ✓ | ✓ | ✓ | — |
| AU-inspector | AU-25 | ✓ | — | — | ✓ (Back, Close, resize handle by keyboard) |
| AU-phone | AU-27 `phone` | — | (base) | ✓ | ✓ (drawer, "+" menu) |
| AU-phone-plus | AU-27 `phone-plus` | — | ✓ | ✓ | — |
| AU-phone-insp | AU-27 `phone-insp` | — | ✓ | ✓ | — |
| LG-terms | LG-1 | ✓ | ✓ | ✓ | — |
| LG-privacy | LG-2 | ✓ | ✓ | ✓ | — |

## 7. Motion (owner's ruling, RULES § 8 — `docs/architecture/web-ui.md` › Sidebar & motion, › A row leaving a list, › Loading skeletons)

Per AI surface: **a** the entrance (`[data-enter]`, `.cnpy-rise` / `.cnpy-stagger`) plays ONCE when the route changes
into it; **b** it does NOT replay on a rerender (a write elsewhere on the page, a keystroke, a read landing, a poll);
**c** what leaves (a hidden block, a decided chip, a dismissed note, a collapsing card) exits smoothly with the one
exit pattern (`data-morph-list` / keyed rows, `FX_EXIT_MS`), never a jump; **d** under `prefers-reduced-motion`
nothing moves (entrances, exits, skeleton pulses, streamed text all instant). Evidence: `document.getAnimations()`
before/after (the automation tab is `document.hidden` — scrub as the repo's Chrome note says), a screen recording.

| surface | a — entrance once | b — no replay | c — smooth exit | d — reduced motion |
| --- | --- | --- | --- | --- |
| Org settings › AI | MO-1 (`#org/general` → `#org/ai`) | MO-2 (toggle the switch: the page morphs, no re-entrance) | MO-3 (skeleton → content fades, no jump) | MO-4 |
| Tags › Sift | MO-5 | MO-6 (toggle Sift) | MO-7 (New tag modal: `data-in` / `data-closing`) | MO-8 |
| filter box | MO-9 | MO-10 (typing in the box) | MO-11 (the applied line on Undo) | MO-12 |
| reading list | MO-13 (appears after Claim) | MO-14 (a later rerender of the handoff) | — (nothing leaves) | MO-15 |
| My Work › brief tile | MO-16 | MO-17 (a My Work refetch) | MO-18 (Wrong? hides the tile; the bento re-flows smoothly) | MO-19 |
| Repo › State | MO-20 | MO-21 (switch Overview tabs back; the repo poll) | MO-22 (Wrong?) | MO-23 |
| Where the work went | MO-24 | MO-25 (pick a lane; range switch) | MO-26 (Accept / Remove: the chip leaves) | MO-27 |
| Feed Trov entries + note | MO-28 | MO-29 (Source switch; the feed poll) | MO-30 (Wrong? on a row; Got it on the note) | MO-31 |
| ticket / Unplaced / Review chips | MO-32 | MO-33 (Accept re-reads the ticket) | MO-34 (Dismiss: the chip leaves; Review's own exit pattern unchanged) | MO-35 |
| Roadmap lines + cards | MO-36 | MO-37 (Accept reloads the Roadmap) | MO-38 (a decided card leaves) | MO-39 |
| Settings › Email notifications switch | — (existing screen) | MO-40 | — | MO-41 |
| Ask screen | MO-42 (open Ask) | MO-43 (a streamed answer appends without re-entering earlier messages or jumping the scroll) | MO-44 (a card collapses to its done line; Cancel; Undo) | MO-45 |
| Ask inspector / ⌘J / menus / pickers | MO-46 (inspector opens smoothly) | MO-47 (inspector navigation Back keeps the shell) | MO-48 (close: inspector, ⌘J panel, hover card, picker) | MO-49 |
| Ask streaming | MO-50 (activity steps rise in order) | MO-51 (thinking "Ns" counter ticks without re-entering) | — | MO-52 (text appears without the soft cursor animation) |

## 8. Dropped combinations (each cannot occur, or cannot be run under the e2e rules)

| id | dropped | why |
| --- | --- | --- |
| D-1 | the superadmin column for a route's non-GET siblings | one handler, one tenant check per mount; the superadmin refusal is identical to the route's GET (kept once per mount) |
| D-2 | every case that needs a model or Jev answer (the jobs' outputs, Ask's model path, auto mode, regenerate, compaction, timeout, Auto cap, autosave) | the e2e rules forbid live third-party keys; the rows are seeded instead and the jobs are covered by recorded evals in CI (`test/ai.evals.test.ts`) |
| D-3 | environment × any API-only case (G, AK, AR, WR, SG, JB, MC) | a status code or a row does not depend on viewport, theme or motion |
| D-4 | the 360 px / dark columns of the Ask design scenarios other than settings and composer-capped | the design draws phone as its own scenarios (`phone`, `phone-plus`, `phone-insp`); the desktop scenarios at 360 ARE those |
| D-5 | Personal-plan variants of every capped state | Personal = Free on every AI cap (`shared/plans.ts:138-157`); only the Upgrade link differs (BR-6 keeps one) |
| D-6 | D1 failure paths (My Work degraded with no brief; the filter's 503 "Couldn't read that. Try again."; Ask's 503s) | not reachable without faulting the database; the unit suites cover them |
| D-7 | real e-mail delivery (Resend), Stripe, real OAuth sign-in | forbidden by the e2e rules; `NOTIFICATIONS_MODE=local`, session rows + `scripts/dev-cookie.mjs` instead |
| D-8 | `LOCAL_AI_PREVIEW` over MCP, on https, or with a live Stripe key | the guard turns it off (`src/ai/preview.ts:24-29`); MC-2 checks MCP once |
| D-9 | another org's member × a route that has no org in its path (`/api/platform/*`) | that route has no tenant; PU-1 covers non-superadmins |
| D-10 | keyboard for read-only states with no control (rows marked —) | nothing to operate |
| D-11 | the `:50` pre-warm as a separate job case | it is EM-25 |

## 9. Questions for the owner (the spec and the code are silent — expected results NOT guessed)

| Q | question | cases |
| --- | --- | --- |
| Q1 | The filter box reads `/ai/settings` once per page load; after an admin turns AI off, Apply gets 403 until a reload. Intended? | FL-24, FL-6 |
| Q2 | Should typing clear the filter's error? (a comment says so; the code does not) | FL-25 |
| Q3 | The "Filtered: …" line and Undo stay after the person changes filters by hand, and Undo then overwrites that. Intended? | FL-23 |
| Q4 | A 200 whose labels are empty draws a line with only "Undo". Acceptable? | — |
| Q5 | Preview `proposed` Accept / Remove hit ids 900–905 (no rows) → "Couldn't do that." Should the preview answer them? | TH-17 |
| Q6 | "Wrong?" on preview feed rows comes back after a reload. Acceptable for the run? | FD-16 |
| Q7 | Platform › Usage hides the Sift figures when there is no Anthropic key, even with a TypeSafe key. Intended? | PU-2 |
| Q8 | Org settings › AI never says a TypeSafe key is missing (only Tags does). Intended? | OA-12 |
| Q9 | Find items says "Suggestions are off…" even when the ORG switch is the cause. Should it name Org settings › AI? | SF-15 |
| Q10 | On a canceled plan: Sift "used up", no "Used up" line in Org settings, eligibility `capped` with no sentence. What should a person see? | OA-15 |
| Q11 | The meter shows full at ≥ 99.5 % (rounding) with no "Used up" line. Bug? | OA-9 |
| Q12 | Reading list `null`: nothing on the web, "Couldn't build…" over MCP; and the web list disappears on reload. Intended? | RL-3 |
| Q13 | The preview's brief / state / themes / feed ignore the org switch (only the filter honours it). Intended? | BR-18 |
| Q14 | `PUT /ai/settings` and `POST /ai/feedback` don't wrap a D1 failure (500, not 503). Acceptable? | — |
| Q15 | `/ai/feedback` refuses a body that omits the nullable `model` / `promptVersion`. Intended? | WR-1 |
| Q16 | May the run use `wrangler dev --test-scheduled` and `/__scheduled?cron=…` to fire the ticks? | JB-8, EM-2…EM-16, EM-25 |
| Q17 | No `ANTHROPIC_API_KEY`: themes, notes, drift, Roadmap suggestions still render (they check only the switch), against `shared/ai-core.ts:14-16`. Should they? | TH-1 (no key), RM-3 |
| Q18 | Should theme / Roadmap decisions succeed while the org switch is off? (they do) | TH-4 in org-ai-off |
| Q19 | Should Planning ever show `capped` from real data? (the server always sends `ready`) | TH-18 |
| Q20 | Rename: the field allows 60, the server 40; a too-long or taken name says only "Couldn't do that. Try again." What should it say? | TH-6 |
| Q21 | Should a Roadmap Accept's 400 `message` (the writer's words) be shown? | RM-16 |
| Q22 | Phase C cards have no Wrong? and no per-person hide; Dismiss is org-wide for any member. Intended? | TC-6 |
| Q23 | With AI on and nothing written yet, should Overview show the State empty sentence? (today: nothing) | ST-9 |
| Q24 | The brief's empty sentence only appears after a brief went empty, never for someone with no brief yet. Right audience? | BR-4 |
| Q25 | There is no staleness rule: a 20- or 30-day-old brief / state shows as-is. Should old ones hide or say so? | BR-11, ST-6 |
| Q26 | An overdue Next item shows "Due soon" (kind `due`). Own mark / words? | BR-20 |
| Q27 | Source = Trov with no Trov rows on the page: no cards and no text. What should it say? | FD-8 |
| Q28 | `/feed`'s per-viewer Wrong? filter runs after the SQL LIMIT, so a page can come up short. Acceptable? | FD-13 |
| Q29 | With the switch off, past Trov entries still show with AI styling. Hide them, or keep them plain? | FD-14 |
| Q30 | Should `?author=me` and My Work › Your sessions include Trov's digests ABOUT me (`subject = me`)? | FD-15 |
| Q31 | A Trov entry whose subject deleted their account shows the tombstone handle as a link. Right? | FD-18 |
| Q32 | Should switching AI off hide existing importance marks? | FI-3 |
| Q33 | Should My Work's merged-PR cards draw the importance mark? (the field is there, nothing renders it) | FI-5 |
| Q34 | Should a person be able to correct an importance rating (Wrong? / Dismiss)? | FI-7 |
| Q35 | Open suggestions on a done / declined ticket still show and Accept works. Hide them? | TC-8 |
| Q36 | A refused Accept write (deleted ticket, bad value, gate-refused Unplaced item) is an unmapped 500. What status and words? | TC-9, TC-12 |
| Q37 | An open risk stays on an ADR after it is ratified / rejected. Should the decision close it? | RV-5 |
| Q38 | Preview: proposals and draft ADRs share risk ids 905/906, so "because…" opens both. Fix the fixture ids? | RV-6 |
| Q39 | Should the sprint page (`#sprints/<id>`) draw the note and forecast that `get_sprint` returns? | RM-15 |
| Q40 | (Q21 for the sprint-draft value refusal) | RM-16 |
| Q41 | Daily subject: is N in "plus N more" all other Next items or only the shown ones; one item alone; empty Next; AI off with nothing assigned — the old date subject? | EM-2, EM-3 |
| Q42 | Does any null stored brief (no row, empty, Wrong?-hidden, no key, capped) fall back to the "3 most recent assigned" block? What does a capped brief say in mail? | EM-2, EM-3 |
| Q43 | "Also": what does "touched their work" mean, which window, which 3 win, where does each link go? | EM-4 |
| Q44 | Review line with no risk suggestions: "Review: 3 waiting" with the clause dropped? Does every member get it? | EM-5 |
| Q45 | Which sprint feeds the Sprint line; how is "due Fri" written beyond 7 days or overdue; is "done" status `done`? | EM-6 |
| Q46 | Is "Only when something needs me" dimmed while unsubscribed / hidden with no address? Does it apply to the weekly and to preview / test-send? | EM-17, EM-18 |
| Q47 | The plain-text part's new layout. | EM-22 |
| Q48 | `/ask/state` shows a gifted Pro's cap as 300 while the gate allows 300 × members. Which is right on screen? (handoff #12 says × members) | AK-4 |
| Q49 | `GET /ask/item/%25` likely 500s (double decode), against invariant 7. | AK-13 |
| Q50 | `/ask/state` tests adding 1 question; a Thinking default with 1–4 left says ok, then `POST /ask` is capped. Should state reflect the default mode's weight? | AK-16 |
| Q51 | Stored "0 results" / "1 results" vs streamed "No results" / "1 result". | AK-21 |
| Q52 | `POST /ask {auto:true}` in an Auto-off org silently runs not-auto (no `auto_off`). Intended? | AK-27 |
| Q53 | A panel thread's `context_ref` stores `context[0]` even when it is hidden from the person. | AK-28 |
| Q54 | ask.md says thread search covers the person's own messages; FTS also indexes answers. Which is right? | AK-31 |
| Q55 | A waiting card's `note` is lost on reload (`note:null`). | AK-33 |
| Q56 | The export filename strips every non-ASCII character; a Unicode-only title becomes `ask-trov`. OK? | AK-39 |
| Q57 | A non-admin can confirm a seeded or stale `update_plan` card (no admin check on confirm). | AK-53 |
| Q58 | The design has no no-key state for the composer. What should a keyless deployment show? | AU-22 |
| Q59 | Ask's 402 bodies (`plan_limit` on attachments / save) lack `limit` / `used` / `cap`, so the shared refusal sentence can't be built. | AK-58 |
| Q60 | An upload without `threadId` creates a visible untitled thread, and multi-file uploads are not atomic. Intended? | AK-58, AK-60 |
| Q61 | The pass's brief SEAM reads only the person's own feed, not Trov's digests about them (spec: Now = latest Status digest, Recently = last 7 days of digests). Fix at merge? | BR-1 |
| Q62 | The `repo.state` job's deploy cites: after #186, should they read RepoFacts' part labels (main-186 § 4) — today they build "<EnvLabel> <part label>" from `org_environment_parts`. | ST-15 |

## 10. Proposed reduction (NOT applied — for the owner to decide)

Three cuts that keep every code branch covered at least once, then a tiered order to run in. Counts are estimates
from this matrix (total today: **675**).

1. **The gate once per mount (−49).** `/ai/*` and `/ask/*` are each ONE `app.route` with one middleware chain
   (`src/routes.ts:1185-1186`). Run signed out / outsider / superadmin / bearer+cookie once on each mount, plus G-58
   and the three leak cases: 12 instead of 61.
2. **Environment pairwise (≈ −120).** Instead of every visual state × {desktop dark, 360 light, 360 dark}, run each
   state ONCE in a rotated environment so each SURFACE still meets all three (and both themes at both widths
   across the surface), plus every keyboard (K) case: ≈ 60 + 25 instead of 181.
3. **Motion by family (≈ −25).** Reduced motion (d) once per screen in one sweep with the media emulated globally
   (≈ 8), entrance-once (a) and no-replay (b) per surface (≈ 18 — the replay bug is per screen), exits (c) per exit
   pattern (≈ 6): ≈ 32 instead of 52.

After the three cuts: ≈ **480**. To reach ≈ 150, run in tiers and stop at the owner's line:

- **Tier 1 (≈ 150, must-run):** the 12 gate cases; every fixture's FIRST real-data render through the real read
  with `LOCAL_AI_PREVIEW` off (one case per fixture state per surface: the BR / ST / TH / FD / FI / TC / UP / RV / RM
  / EM rows that name a seed fixture); one preview sweep per mode (ready / empty / capped / proposed) against
  `docs/superpowers/specs/ai-screens-shots/`; every write that changes rows (accept, dismiss, confirm, cancel, undo,
  Wrong?, settings toggles, save, attachments) once; every input-injection case; one pairwise environment run per
  surface; one reduced-motion sweep.
- **Tier 2 (≈ 170):** the remaining refusal orders and status codes (AK, SG, WR, FL 4xx), plan variants (gifted,
  override, canceled), the remaining environment pairs.
- **Tier 3 (the rest):** copy-only checks already pinned by render snapshots, the remaining motion cells.

