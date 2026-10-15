# Server-side AI e2e — Tier 1, group `platform` (settings & plumbing)

Phase H run (`docs/superpowers/specs/2026-10-15-server-ai-e2e.md`), Tier 1 of `docs/testing/server-ai-test-matrix.md`
§ 10 for the sections **G, OA, SF, PU, FL, RL, EM, JB, MC, LG**, plus their § 6 environment and § 7 motion cells.
Branch `ai/e2e-platform` from `af26ce3c`. Screenshots: `docs/testing/server-ai-shots/platform/` (linked by name below).

## Setup

- Local only: `wrangler dev --port 8830 --inspector-port 9830 --test-scheduled` in this worktree, its own
  `.wrangler/state` D1 (`npx wrangler d1 migrations apply DB --local`, then `node scripts/seed/server-ai-e2e.mjs`:
  121 of 121 fixtures). Re-seeded between cases that write.
- `.dev.vars` copied from `trov-preview-ai`, then: `DEV_LOGIN` **unset** (cookie sign-in per fixture person with the
  `test-session-<handle>` rows), `NOTIFICATIONS_MODE=local` (wrangler.toml's top-level value is `resend`: without the
  override a digest would be handed to Resend — no `RESEND_API_KEY` exists, so it would fail, but local is what the
  run needs), `PUBLIC_ORIGIN=http://127.0.0.1:8830` (see B-1). No Stripe, no live keys.
- Keys, by phase: **none** (the default); **`K:dummy`** = `ANTHROPIC_API_KEY=sk-ant-e2e-dummy-not-a-key`,
  `TYPESAFE_API_KEY=ts-e2e-dummy-not-a-key`, used ONLY for requests the server refuses before any network call
  (400 / 402 / 403 / 429 / Sift `off` / `busy` / `capped` / `not_found`; a refusal path was read in the code before each
  case, and the 429 case checked its rate-limit bucket was the current hour first); **`P:<mode>`** =
  `LOCAL_AI_PREVIEW=<mode>` with no keys. Nothing was sent to Anthropic, TypeSafe AI, Resend, Stripe or GitHub.
- Browser: Playwright Chromium (scripts kept out of the repo, in the session scratchpad), desktop 1440×900 and phone
  360×780, light / dark via `prefers-color-scheme`, reduced motion via `prefers-reduced-motion`.
- Crons: `GET /__scheduled?cron=…` on the local server (Q16 — answered here by doing it locally only). Wrangler's
  `/__scheduled` ignores a `time=` parameter, so the digest cron was fired at the real New York hour with
  `notification_settings.send_hour` set to it, and the `:50` pre-warm at a real `:50`.

## Baseline

- Typecheck on `af26ce3c`: clean. The full suite runs once at the final commit (gate script; result at the end).
- Baseline server (main) at :8800 used for "existed on main" checks (legal pages' `noindex`, the canonical redirect).
- **B-1 (pre-existing, recorded, not fixed):** with `PUBLIC_ORIGIN` set to an `http://localhost:<port>` origin — the
  matrix § 0's own default `http://localhost:8787` — every GET on that host is 301'd to `https://localhost:<port>`
  (`src/site.ts` `canonicalRedirect`, unchanged since 5a6fefcc on main). The run used `PUBLIC_ORIGIN=http://127.0.0.1:8830`
  and browsed `http://localhost:8830`; e-mail links therefore point at `127.0.0.1:8830`.
- No console error or failed request on any page before a case touched it (each case's evidence lists the console).

## Cases

Result: `pass` · `fail → fixed` · `pre-existing` · `question`. "→ shot" names a PNG in the shots folder.

### G — the gate (12 Tier 1 cases; every route of both mounts was swept, 26 routes × 5 callers = 130 requests)

| id | surface | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|---|
| G-1 | `/ai/*` mount | signed out, `GET /ai/settings` | 401 `unauthorized` | `src/auth/principal.ts:50-64` | 401 `{"error":"unauthorized","hint":…}`; same on all 7 `/ai/*` routes | pass | browser `fetch`, sweep log |
| G-2 | `/ai/*` | outsider (test-other only) | 404 `not_found` | `src/data/gate.ts:21-28` | 404 on all 7 | pass | sweep |
| G-3 | `/ai/*` | superadmin, no membership | 404 | same | 404 on all 7 | pass | sweep |
| G-4 | `/ai/*` | bearer + cookie (test-member) | 403 `forbidden`, "this is a signed-in person's action, never a token's" | `src/orgs/routes.ts:34-37` | 403 with that message on all 7 | pass | sweep |
| G-24 | `/ask/*` mount | signed out, `GET /ask/state` | 401 | as G-1 | 401 on all 19 `/ask*` routes | pass | sweep |
| G-25 | `/ask/*` | outsider | 404 | as G-2 | 404 on all 19 | pass | sweep |
| G-26 | `/ask/*` | superadmin | 404 | as G-3 | 404 on all 19 | pass | sweep |
| G-27 | `/ask/*` | bearer + cookie | 403 cookie-only | `src/ai/ask/routes.ts:57-63` | 403 on all 19 | pass | sweep |
| G-58 | both | bearer WITHOUT cookie | 401 | session gate reads no bearer on `/api/o` | 401 on all 26 | pass | sweep |
| G-59 | reads | outsider in test-other: `/me/dashboard`, `/repo/dashboard`, `/feed`, `/tickets/2` | only test-other's rows | inv. 4 | no "test-ent" / `org_test_ent` / "Test Enterprise" in any body; the only suggestion id is 5003 (test-other's own) | pass | `fetch` bodies |
| G-60 | suggestions | member of test-ent: accept / dismiss 5003 (test-other's) | 404 both | `src/ai/suggestions.ts:41-64` | 404 / 404; 5003 still `open` in D1 | pass | `fetch` + D1 |
| G-61 | `/ask/peek` | `refs:["ticket:2"]` while test-other has a #2 | test-ent's #2 only | `src/ai/ask/refs.ts` | test-other's #2 renamed "test-OTHER-ORG ticket two" first: peek returns "test-Blank login screen…" (test-ent's) | pass | `fetch` |

Every refusal body also carries a `hint` (main's error-hint layer) beside the expected `error`.

### OA — Org settings › AI

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| OA-1 | test-ent · admin · K:dummy | lead "…is **on** for Test Enterprise…runs Sift on your tags."; both switches On; unlimited lines, no meter; What is sent; footnote | `web/src/org-ai.ts:33-126` | as expected; "Written by Trov" reads **42** runs (matrix wrote 37: the seed's phase-C section adds 5 `ai_run:ticket.category` to the 37 filter runs — PU-4 counts the same 42). **What is sent named only summaries and Sift** while the Privacy Policy names five AI uses → see LG-2 | **fail → fixed** (0a8519eb) | → `oa-1-test-ent.png`, `oa-1-sent-after-fix.png` |
| OA-2 | member | tab visible; On / On words, no switch; lead adds "Only an admin or an owner can change this." | `org-ai.ts:68-78` | as expected (0 switches) | pass | → `oa-2-member.png` |
| OA-3 | owner | = OA-1 | `context.ts:153-155` | identical numbers, canEdit, 2 switches | pass | text |
| OA-4 | member `PUT {enabled:false}` | 403; `ai_automation` stays 1 | `src/ai/routes.ts:72-79` | 403 `forbidden`; D1 `ai_automation=1` | pass | `fetch` + D1 |
| OA-5 | admin toggles AI off | `aria-busy` while saving; flash "Trov's AI is off for this organization"; lead **off**; audit `org.ai`; `ai_automation=0` | `org-actions.ts:158-178` | busy seen (PUT slowed 700 ms); that flash; lead "…is off…"; audit `org.ai` by test-admin `{"enabled":false}`; D1 0 | pass | → `oa-5-ai-off.png` |
| OA-6 | back on | flash "…is on…"; second audit row | same | flash; `ai_automation=1`; +2 audit rows total | pass | D1 |
| OA-7 | Auto mode off | flash "Auto mode is off in Ask Trov: every change waits to be confirmed"; `ai_chat_auto=0`; audit `org.ai_chat_auto` | same | exactly that | pass | D1 |
| OA-8 | `PUT {}`, `{enabled:"yes"}`, `{enabled:true,x:1}` | 400 `invalid` + the "Send { enabled… }" message; nothing changes | `shared/ai.ts:119-120` | 400 ×3 with that message | pass | `fetch` |
| OA-9 | test-free · K:dummy | 120/300, 120/250, 300/1000, 20/50; meters, none full | `shared/plans.ts:138-157` | exactly; meters `ok` ×4 | pass | → `oa-9-test-free.png` |
| OA-10 | test-at-cap · K:dummy | every meter `full`; four "Used up for this month: … until <1st>" lines; eligibility `capped` | `org-ai.ts:33-53` | four lines "…until Nov 1", meters `full` ×4, `capped` | pass | → `oa-10-test-at-cap.png` |
| OA-11 | test-past-cap | as OA-10; "310 of 300" | same | 310/300, 260/250, 1,012/1,000, 55/50; meters clamp | pass | → `oa-11-test-past-cap.png` |
| OA-12 | no key · test-ent | "No key" mark + "This Trov has no Anthropic key, so nothing is written whatever the switch says…" | `org-ai.ts:25-30` | exactly | pass | → `oa-12-admin-nokey.png` |
| OA-13 | no key · test-ai-off `GET` | `eligibility:"no_key"` | `eligibility.ts:41-44` | `enabled:false`, `no_key` | pass | `fetch` |
| OA-14 | K:dummy · test-ai-off | `enabled:false`, `off`, no eligibility line | same | exactly | pass | `fetch` + text |
| OA-15 | K:dummy · test-canceled | `capped`, no "Used up" line | Q10 | `capped`; 1 of 2,000 runs; no line | question (Q10) | → `oa-15-test-canceled.png` |
| OA-16 | test-gift | `ai_chat.cap` 900 | handoff #12 § 2.1 | 900 | pass | `fetch` |
| OA-17 | test-pro | `ai_chat` 1500, `ai_runs` 2000 | same | 1500 / 2000 | pass | `fetch` |
| OA-18 | test-chat-ovr | `ai_chat.cap` 10 | same | 10 | pass | `fetch` |
| OA-19 | test-free | 120 runs, not 1119 (last month's 999) | `plans.ts:493` | 120 (the 999 row is dated 2026-09-30) | pass | D1 |
| OA-20 | P:ready · admin | 212 / 486 / 1240 / 1120 of 3000 / 2000 / 10000 / 1500; `ok`; `enabled` real | `ai-fixtures.ts:190-199` | exactly (the reference PNG `ai-screens-shots/org-ai-ready-*` predates Phase A's four allowances and two switches — compared on numbers and states, not pixels) | pass | → `oa-pready-admin-*.png` |
| OA-21 | P:empty | 0 of each | same | 0/3000, 0/2000, 0/10000, 0/1500 | pass | → `oa-pempty-admin-*.png` |
| OA-22 | P:capped | at cap on all four, four "Used up" lines | same | exactly, `capped` | pass | → `oa-pcapped-admin-*.png` |
| OA-23 | P:ready · member | the member view on the sample | same | numbers as OA-20, no switches | pass | → `oa-pready-member-*.png` |
| OA-24 | settings read slowed | skeleton "Loading the AI settings…" `aria-busy` | `org-ui.ts:128-140` | exactly | pass | → `oa-24-loading.png` |
| OA-25 | settings read blocked | "Couldn't load the AI settings. Check your connection, then [Try again]"; Try again reloads | same | exactly; Try again loaded the tab | pass | → `oa-25-failed.png` |
| OA-26 | double-click the switch | one PUT in flight, final = last request | `org-actions.ts:158-178` | one PUT `{"enabled":false}`; aria-checked false; D1 0 | pass | request log |

### SF — Tags › Sift

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| SF-1 | member `GET /tags` | no `ai`; no Sift cell, no "Added by Sift" | `src/tools/tags.ts:131-135` | keys `tags, used, cap, suggestions`; 0 cells | pass | → `sf-1-member.png` |
| SF-2 | admin · no TypeSafe key | "This Trov has no TypeSafe AI key set, so nothing is sent and nothing is tagged."; switch disabled | `web/src/tags.ts:142-146` | exactly; disabled; no Find items | pass | → `sf-2-admin-nokey.png` |
| SF-3 | test-ai-off, Sift row on, dummy key | the org-off sentence; switch NOT disabled; meter dimmed | same | exactly; enabled switch; `data-off="1"` | pass | → `sf-3-ai-off.png` |
| SF-4 | test-pro, no row | "Off: nothing is sent." | same | exactly | pass | text |
| SF-5 | test-at-cap, Sift turned on | "This month's checks are used up: Trov stops looking for items until next month." | same | exactly | pass | → `sf-5-at-cap.png` |
| SF-6 | test-free | "300 of 1000 checks used this month." | same | "300 of 1,000 checks used this month." | pass | → `sf-6-free.png` |
| SF-7 | test-ent | "1520 checks used this month." | same | "1,520 checks used this month." | pass | text |
| SF-8 | member `PUT /tag-settings` | 403 | `src/tags/routes.ts:38-47` | 403 | pass | `fetch` |
| SF-9 | admin `{enabled:"on"}` | 400 `invalid`, field `enabled` | same | exactly | pass | `fetch` |
| SF-10 | test-pro toggle on / off | the two flashes | `tags-actions.ts:279-285` | "Suggestions are on. Trov looks for items when you add a tag." / "Suggestions are off. Nothing is sent."; row 1 then 0 | pass | flashes + D1 |
| SF-11 | no key · New tag | scan switch disabled, "This Trov has no TypeSafe AI key set."; Add; flash "Added the tag {name}" | `tags.ts:362-388` | exactly; button reads "Add tag"; flash "Added the tag test-e2e-new" | pass | → `sf-11-newtag-nokey.png` |
| SF-12 | test-ai-off · New tag | disabled, the org-off sentence | same | exactly | pass | text |
| SF-13 | test-pro (Sift off) · New tag | "Sift is off for this organization (the switch above the list)." | same | exactly | pass | text |
| SF-14 | test-free, run going on test-hosting | "Trov is already looking…" | `sift.ts:38-57` | API `{status:"busy"}` (→ that sentence, `tags-actions.ts:375`); the row's Find items is drawn disabled while the run is live | pass | `fetch` + DOM |
| SF-15 | test-pro, Sift off | "Suggestions are off. Turn them on above first." | Q9 | API `{status:"off"}`; Find items is not drawn while Sift is off | pass (Q9 stays open) | `fetch` |
| SF-16 | no key | "…cannot look for items." | same | API `{status:"no_key"}`; no Find items drawn | pass | `fetch` |
| SF-17 | retired tag (`ui` retired in test-at-cap, Sift on) | "That tag is not on the list any more…" | same | `{status:"not_found"}` → that sentence (`tags-actions.ts:377`) | pass | `fetch` |
| SF-18 | test-at-cap, Sift on | "…used up. Trov can look again next month." | same | `{status:"capped"}`; Find items not drawn | pass | `fetch` |

### PU — Platform › Usage

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| PU-1 | admin, not superadmin | 404; the app falls back | `platform/routes.ts:32-41` | 404; `/platform/#platform/usage` lands on the org picker | pass | → `pu-1-admin.png` |
| PU-2 | superadmin · no key | no "AI runs" (nor Sift) | Q7 | none; "AI summaries are off on this deployment (no ANTHROPIC_API_KEY)." | pass (Q7 open) | → `pu-superadmin-nokey.png` |
| PU-3 | superadmin · K:dummy | Runs, Failed, Capped, Tokens in/out, Cached, Sift checks, Sift tokens in/out; "last 30 days, all organizations" | `platform-usage.ts:104-110` | all nine + that line (Runs 2,897, Failed 8, Capped 4, 72.0K / 9,600 / 36.0K, 7,872, 12.0K / 160) | pass | → `pu-3-usage-1440-light.png` |
| PU-4 | `#platform/orgs/test-ent` | runs 42, failed 2, capped 1, 18000/2400/9000, Sift 1520, 3000/40 | `usage.ts:157-188` | Runs 42, Failed 2, Capped 1, 18.0K / 2,400 / 9,000, Sift 1,520, 3,000 / 40 | pass | → `pu-4-org-1440-light.png` |
| PU-5 | `?days=1/0/9999` | 1 → today; out of range → default 30 | `usage.ts:20-27` | 1 → 1; 0 → 30; 9999 → 30 (the code's rule: anything outside 1..retention is the default — the matrix's "clamps" means this; same on main) | pass | `fetch` |
| PU-6 | people count | AI metrics never a person's activity; `trov` not counted | `usage.ts:93,112-113` | persons 15 of 17 rows (`trov`, `github-webhook` out); AI metrics excluded by `PERSON_METRIC` | pass | `fetch` + D1 |

### FL — the plain-language filter

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| FL-1 | no key | no box on Tickets / Feed / Artifacts | `ai-filter-actions.ts:40-52` | 0 boxes on all three | pass | → `fl-1-nokey-tickets.png` |
| FL-2 | test-ai-off · K:dummy | no box | same | 0 | pass | DOM |
| FL-3 | test-ent · K:dummy | the three placeholders; `maxlength=300`; the AI-mark tooltip | `ai-filter-core.ts:115-119` | exactly; tip "Trov turns what you type into this screen's filters…" | pass | → `fl-3-box-tickets.png` |
| FL-4 | submit "" and "   " | no request; "Type what you want to see, in a sentence." | `ai-filter-actions.ts:68-70` | 0 POSTs; the error both times | pass | → `fl-4-empty.png` |
| FL-5 | `{screen:"x"}`, 301 chars, extra key | 400 `invalid` + that message | `src/ai/routes.ts:130-155` | 400 ×3 | pass | `fetch` |
| FL-6 | test-ai-off direct POST | 403 `{error:"off", message:"AI is switched off for this organization."}` | same | exactly (the generic 403 `hint` beside it says "needs a role you do not have…" — finding F-1) | pass | `fetch` |
| FL-7 | test-at-cap · owner | 402; "…reached the 250 AI runs its Free plan includes. Upgrade to Pro for more."; one `ai_run_capped:filter`, actor `ai-filter`; no call | `plans.ts:451-457` | exactly; metric 0 → 1, actor `ai-filter` | pass | → `fl-7-capped-owner.png` |
| FL-8 | test-at-cap · member | same + "Ask one of this organization's owners." | same | exactly; metric 1 → 2 | pass | text |
| FL-9 | test-canceled · owner | "…Pro plan has ended… You can renew it in Org settings." | same | 402 `status:"canceled"`; exactly that line | pass | text |
| FL-10 | test-gift runs at 2000 · owner | "Ask Trov to change your plan." | same | "…reached the 2,000 AI runs its Pro plan includes. Ask Trov to change your plan." | pass | text |
| FL-11 | test-admin, this hour's 60 spent | 429 + `Retry-After`; "You've hit this hour's limit for this; try again after {time}." | `limits.ts:39,73-81` | 429, Retry-After 3018; "…try again after 7:00 PM." | pass | → `fl-11-rate-limited.png` |
| FL-20 | test-ai-off (direct POST); also under P:ready | 403 off; no box | routes | = FL-2 + FL-6; P:ready: no box, POST 403 `off` (the preview honours the real switch) | pass | DOM + `fetch` |
| FL-13 | P:ready · Tickets "my open high priority bugs" | "Filtered: Open · Assigned to you · Bug · High priority." + Undo; the list reloads | `ai-fixtures.ts:218-225` | that line + Undo; the board shows Filter 3, Open, "1 shown" | pass | → `fl-13-applied-tickets.png` |
| FL-14 | P:ready, text has "overdue" | adds " Not a filter here: “overdue”." | same | exactly | pass | text |
| FL-15 | P:ready · Feed, "…about deploys" | "Filtered: By you · Last 7 days." + unmatched “about deploys” | same | exactly | pass | text |
| FL-16 | P:ready · Artifacts | "Filtered: HTML · Published · search “checkout”." | same | exactly | pass | → `fl-16-applied-artifacts.png` |
| FL-17 | P:ready · Undo after two applies | the state before the FIRST apply | `ai-filter-actions.ts:80-112` | 13 shown / no filter → apply → 1 shown / Filter 3 → apply → same → Undo → 13 shown / Filter 0, line gone | pass | DOM |
| FL-18 | P:empty | 422 "Trov couldn't turn that into a filter on this screen. Try naming a person, a status, a priority or a time." | `routes.ts:138-140` | exactly | pass | → `fl-pempty-error.png` |
| FL-19 | P:capped | 402 with the Free-plan sentence | same | "…reached the 250 AI runs its Free plan includes. Ask one of this organization's owners." (member) | pass | → `fl-pcapped-error.png` |
| FL-21 | P:ready · `<img src=x onerror=alert(1)> overdue` | drawn escaped, no script | `org-ui.ts:169-170` | no `<img>` element, no dialog; the fixture echoes only “overdue” as unmatched, so the escaping of an echoed tag is not exercised by the preview | pass | DOM |
| FL-22 | P:ready · Enter twice fast | one request; "Reading…", `aria-busy` | `ai-filter-actions.ts:65-69` | 1 request; "Reading…"; aria-busy | pass | request log |
| FL-23 | P:ready · change a filter by hand after an apply | Q3 | — | the "Filtered: Open · …" line and Undo stay after switching the status to All (2 shown, line still says Open) | question (Q3) | → `fl-23-hand-change.png` |
| FL-25 | P:ready · type after an error | Q2 | — | the error stays while typing | question (Q2) | DOM |

### RL — the reading list

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| RL-1 | member claims #1 | "Read these first (not complete)" + sentence; ≥1 "Doc test-Deploy checklist"; ≤5 rows; Doc opens the doc | `handoffs.ts:340-381` | heading + sentence; Doc test-Deploy checklist, Feed "Shipped: test- the Netlify redirect fix" (2 rows); Doc opens Docs on it | pass | → `rl-1-reading-list.png` |
| RL-2 | #4 "Fix it, ok" | nothing drawn | same | `reading_list: []`, no block | pass | response + DOM |
| RL-3 | reload after RL-1 | the list is gone | `web/src/handoffs.ts:249` | present before the reload (same session), 0 after `reload()` | pass (Q12 open) | DOM |
| RL-4 | Copy as prompt | the text ends with the list | `handoffs.ts:55-58` | ends "## Read these first (not complete)\n- Doc: test-Deploy checklist (test-deploy-checklist)\n- Feed: … (#701005)" | pass | clipboard |
| RL-5 | My Work › Claim & copy #1 | the copied text has NO list | `main.ts:3349-3360` | no "Read these first" | pass | clipboard |
| RL-6 | a non-recipient claims #1 | refused | `handoffs.ts:177-187` | test-admin: 403 `not your handoff`. (The matrix named test-member2, who is #1's SENDER — `claimHandoff` lets a sender claim, so the refusal was shown with test-admin.) | pass | `fetch` |
| RL-7 | admin claims #2 (anyone) | allowed; doc test-Webhook retries | same | 200; Doc test-Webhook retries + 2 feed entries | pass | → `rl-7-anyone.png` |
| RL-8 | MCP `claim_handoff {id:1}` | "## Read these first (not complete)", intro, `- Doc: test-Deploy checklist (get_doc slug \`test-deploy-checklist\`)` + `> snippet` | `mcp.ts:611-613` | exactly, plus the feed entry with its `query` hint | pass | MCP text |
| RL-9 | MCP claim #4 | no section | same | none | pass | MCP text |
| RL-10 | another person's private artifact | not listed for the claimer | `query()` viewer = claimer | The seed's artifact rows have no `artifacts_fts` rows and drafts never list, so two artifacts were made through the app by test-member2 and published: private "test-Quarterly pricing notes" is NOT listed for test-member, IS listed for its author; the org one IS listed for test-member | pass | `fetch` |

### EM — e-mail (`NOTIFICATIONS_MODE=local`: bodies to `notification_outbox_bodies`; nothing sent)

The daily cron was fired at the real New York hour (send_hour set to it); weekly shapes through the admin preview
(`cadence=weekly`, renders for the caller) and `?sample=index`.

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| EM-1 | admin preview `cadence=daily` | renders the ADMIN's digest | `routes.ts:250-269` | test-admin's: Review, Sprint, Tickets lines (no brief: test-admin has none) | pass | → `em-1-admin-preview-daily.png` |
| EM-2 | cron · test-member (brief-ready-5-next) | subject = top Next item "…plus N more"; Now + ≤3 Next; absolute links | spec Phase E · Q41 | "test- CI run 4812 is failing on your pull request #115, plus 4 more" (N = all other Next items); Now + 3 Next; every link `http://127.0.0.1:8830/test-ent/#…`, no bare `#` | pass (Q41 open) | body text |
| EM-3 | cron · test-ai-off · test-member | subject from the first assigned item; 3 assigned in plain words; no "Also" | spec Phase E | subject + ASSIGNED TO YOU ×3 as expected; **"Also" is drawn** (701005 breaking, 701006 notable: ratings made before the switch went off) | question (Q32 / Q43 — the Privacy draft says earlier ratings still count with the switch off) | body text |
| EM-4 | cron · feed-importance-mixed | "Also": ≤3 notable / breaking, title + link | spec · Q43 | "Shipped: test- the Netlify redirect fix (breaking)". With NO Now/Next (test-member2), the block's heading "Also" was followed by a second "ALSO" label in HTML and text | **fail → fixed** (f84f06cd) | → `em-also-only-daily.png` (before), `em-4-also-only-after-fix.png` |
| EM-5 | review queue | "Review: N waiting, 1 changes a decision" | spec · Q44 | "Review: 3 waiting, 1 changes a decision" (staged doc + Trov's doc-drift proposal + draft ADR) | pass | body text |
| EM-6 | sprint-active-forecast | "Sprint: test-Sprint Hosting, due <weekday>, 2 of 5 done" | spec · Q45 | NOT in the default daily: `roadmap_plan` defaults to **weekly** (as on main); in the weekly / admin preview: "Sprint: test-Sprint Hosting, due Mon, 2 of 6 done" (6 non-declined tickets; the matrix's "5" is the fixture note's count) | question (Q45: spec Phase E puts the Sprint line in the Daily) | → `em-12-test-ent-weekly.png` |
| EM-7 | removed parts | no What/Why/Impact, issue rows, plan diff; empty sections out | spec | none in any body | pass | grep of bodies |
| EM-8 | notify-only-when-needed-skip · test-member2 | `skipped`, no body | `run.ts:95-96` | first run `sent`: 701006 (test-member2's own entry, rated notable) touched their work, so `needsMe` is true — by the rule; with 701006 set routine and the row re-run: `skipped`, 0 bodies | pass | D1 |
| EM-9 | only-when-needed send · test-free member | sent | same | sent, subject "test-Login page is blank on Safari" | pass | D1 |
| EM-10 | explicit OFF row · test-admin | sent | same | sent | pass | D1 |
| EM-11 | test-noemail / test-unsub | no outbox row | `run.ts:133-141` | none | pass | D1 |
| EM-12 | week-highlights · weekly | brief, "This week" 3 cited highlights, ONE numbers line (zero parts out) | `week-recap.ts` | 3 cited highlights; "1 pull request merged, 8 entries in the Feed" | pass | → `em-12-test-ent-weekly.png` |
| EM-13 | week-highlights-ai-off | numbers line only | same | "1 pull request merged, 5 entries in the Feed", no highlights | pass | → `em-13-test-ai-off-weekly.png` |
| EM-14 | malformed · test-pro | no highlights | same | numbers only | pass | → `em-14-test-pro-weekly.png` |
| EM-15 | none · test-free | numbers line only | same | "3 entries in the Feed" (0 merged → left out) | pass | → `em-15-test-free-weekly.png` |
| EM-16 | test-empty | skipped | same | daily `skipped` ×2; weekly preview "Nothing to render" | pass | → `em-16-test-empty-weekly.png` |
| EM-17 | member · Settings › Email notifications | the switch + sentence; `role=switch aria-checked` + name; Space / Enter; persists | `notifications.ts:132-135` | exactly; Space → PUT `{"onlyWhenNeeded":true}`, true after reload; Enter → false; D1 0 | pass | → `em-17-settings.png` |
| EM-19 | admin test send | a body row `…:test-<ts>`; local | `routes.ts:279-319` | 200 `mode:"local"`, key `org_test_ent:test-admin:daily:test-2026-10-15T22-01-03-201Z` | pass | D1 |
| EM-20 | member preview | 403 | `routes.ts:109` | 403 `admin only` | pass | `fetch` |
| EM-21 | the HTML at 360 / dark | fluid ≤ 520 px card; dark swap on every block; no `<link>`, `<img>`, `<script>`, web font | `assemble.ts:174-183,247` | no horizontal scroll at 360; dark background / text swap; none of the four; 0 requests when rendered | pass | → `ev-em-daily-360.png`, `ev-em-daily-360-dark.png`, `ev-em-daily-1440-dark.png` |
| EM-22 | the text part | present for every sent digest | `assemble.ts:364-383` | present (e.g. 779 chars) | pass (Q47 open) | D1 |
| EM-23 | signed out opens the deep link, signs in | lands on `/test-ent/#mywork` | `main.ts` return-to | stash `trov.returnHash=#mywork`, `trov.returnOrg=test-ent`; after the cookie, "/" lands on `/test-ent/#mywork` (the OAuth hop stubbed, D-7) | pass | → `em-23-landed.png` |
| EM-24 | the footer | "You're getting the daily Trov digest for test-member" + Unsubscribe; List-Unsubscribe | `assemble.ts:359-361` | footer as expected; the header is built only for Resend (`resend.ts:49`) and local mode stores no headers | pass (header not observable locally) | body |
| EM-sample | `?sample=index` + six samples | each Phase E shape | `sample.ts` | index lists daily-ai, daily-off, daily-empty, weekly-ai, weekly-off, only-when-needed; each renders | pass | → `em-sample-*.png` |

### JB — keyless background behaviour

| id | state | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| JB-1 | member creates a ticket on `#tickets` | `card ticket:15`, `org ''` | `ai-route.ts:77-113` | NEW `card:ticket:15`; `org:''` re-marked (it was clean — ran after its mark — so a new `dirty_since`, by the CLEAN rule) | pass | D1 diff |
| JB-2 | ticket #1 → Testing (status menu) | `person test-member`, `sprint <id>`, `org` | same | re-marked `org` and `person:test-member` (dirty_since kept), NEW `sprint:100101` | pass | D1 diff |
| JB-3 | handoff to anyone | `person` for ≤ 20 members | same | 6 `person` scopes (all 6 members) | pass | D1 diff |
| JB-4 | admin promotes the staged doc | `card tagfit:doc:test-auth-sessions`, `doc_drift test-auth-sessions` | same | both NEW | pass | D1 diff |
| JB-5 | an item lands in Unplaced (MCP low-confidence proposal, out-of-vocab section) | `card unplaced:<id>` | same | `card:unplaced:714025` | pass | D1 diff |
| JB-6 | MCP `append_feed` | `card feed:<id>`, `person test-member` | same | `card:feed:714027`, `person:test-member` re-marked | pass | D1 diff |
| JB-7 | test-ai-off creates a ticket | no row | `ai-dirty.ts:69` | 0 rows | pass | D1 |
| JB-8 | no key, a `*/10` tick at a non-heavy minute | no `ai_batches`, no usage change, `ai_dirty` untouched | `pass.ts:117-129` | 0 → 0 batches; AI usage unchanged; `ai_dirty` byte-identical; tag runs unchanged | pass (Q16: run locally) | D1 before/after |
| JB-9 | after JB-8 | the parked repo scope stays parked | `pass.ts` | `repo test-org/test-ent-repo attempts 3` | pass | D1 |
| JB-10 | test-gift `plan_gift_until` in the past, a tick | moves to Free | `repo/cron.ts:601-610` | `plan: team → free`, gift date cleared | pass | D1 |

### MC — MCP (bearer `bearer-token`, local :8830 only)

| id | act | expected | actual | result | evidence |
|---|---|---|---|---|---|
| MC-1 | `tools/list` | no promote / ratify / accept / dismiss tool; no Ask publish | 45 tools, none of those | pass | list |
| MC-2 | `get_my_work`, `get_repo_dashboard`, `get_feed`, `get_roadmap` with P:ready | NO preview fixture over MCP | the seeded rows ("test- You have the Safari login fix…"), while the cookie `/me/dashboard` at the same moment returns the sample ("You are partway through the hosting screens…") | pass | JSON |
| MC-3 | `get_ticket 2` | no `ai` | no `ai` key | pass | JSON |
| MC-4 | bearer on `/ai/settings` with a cookie | 403 cookie-only | = G-4 | pass | sweep |

### LG — legal DRAFT passages (signed out)

| id | act | expected | source | actual | result | evidence |
|---|---|---|---|---|---|---|
| LG-1 | `/terms` | Ask Trov / AI pass / weekly passages marked DRAFT; Anthropic + TypeSafe AI | f03e8781 | 5 "DRAFT —" markers, rendered and in the prerendered HTML; both providers; Sift named, never Jev | pass | → `lg-terms-1440-light.png` |
| LG-2 | `/privacy` | same; what is sent / never sent matching Org settings › AI | `shared/ai-core.ts` | 16 DRAFT markers; never-sent matches; **the AI rows did not match** (5 AI rows here, 2 in Org settings) → fixed with OA-1 | **fail → fixed** (0a8519eb) | → `lg-privacy-1440-light.png` |
| LG-3 | both | prerendered, no console error, `noindex` unchanged | web-ui.md | 200, no `X-Robots-Tag`, no robots meta — same as main (:8800); 0 console errors | pass | headers |

### § 6 Environment (D = 1440 dark, P = 360 light, PD = 360 dark, K = keyboard at 1440 light)

Every run checked: no horizontal page scroll, no element past the viewport's right edge (outside a scroller), no
console error (except the case's own refused request), the app's dark theme applied (`trov.theme=dark`, as a person
picks it — the app does not follow `prefers-color-scheme` on its own; e-mail bodies do). Shots `ev-<row>-<env>.png`.

| row | D | P | PD | K |
|---|---|---|---|---|
| OA-admin (K:dummy) | pass | pass | pass | **fail → fixed** (daab320d): after Space / Enter on either switch the focus dropped to `<body>` (the switch was `disabled` while saving), so Enter after Space did nothing. Now `aria-disabled`; after the fix: 28 Tabs reach the AI switch (3 px ring), Space → off (D1 0), Enter → on (D1 1), Tab → Auto mode switch, both toggled back |
| OA-member | pass | pass | pass | — |
| OA-nokey | pass | pass | pass | — |
| OA-capped (P:capped) | pass | pass | pass | — |
| OA-ready / OA-empty (preview) | pass | pass | pass | — |
| OA-loading | pass | pass | pass | — |
| OA-failed | pass | pass | pass | pass: Try again reached by Tab (ring), Enter reloads the tab |
| SF-cell (test-free / test-pro, K:dummy) | pass | pass | pass | pass for the switch (reached, Space turns Sift on) and the "What is sent" popover (Enter opens, `aria-expanded`, Escape closes, focus back on the trigger); the switch drops focus to `<body>` while saving — **pre-existing** (P-1) |
| SF-off (SF-3) | pass | pass | pass | — |
| SF-modal (SF-11) | pass | pass | pass | pass: focus lands in Name, 25 Tabs stay inside, Escape closes, focus back on New tag |
| PU-line (PU-3) | pass | pass | pass | — |
| PU-org (PU-4) | pass | pass | pass | — |
| FL-box (FL-3) | pass | pass | pass | (P:ready, below) |
| FL-402 (FL-7) | pass | pass | pass | — |
| RL-list (RL-1) | pass | pass | pass | pass: the first row reached by Tab; Enter opens Docs on test-Deploy checklist |
| EM-daily (EM-2 body) | pass (`ev-em-daily-1440-dark`) | pass | pass | — |
| EM-settings (EM-17) | pass | pass | pass | pass (EM-17) |
| LG-terms / LG-privacy | pass | pass | pass | — |

### § 7 Motion (`document.getAnimations()`, running ones, right after the act; reduced = emulated `prefers-reduced-motion`)

| id | surface | expected | actual | result |
|---|---|---|---|---|
| MO-1 | Org settings › AI, `#org/general` → `#org/ai` | the tab bar's switch, not a page re-entrance | the indicator slides (`cnpy-tabs-ind` transform / width), nothing else — identical to the Members tab (control) | pass |
| MO-2 | toggling Auto mode | the page morphs, no re-entrance | only the switch's own transitions and the toast | pass |
| MO-3 | skeleton → content (slow read) | skeleton pulse, then one short fade | `cnpy-skel-in` + `cnpy-skel-pulse`, then `cnpy-settle` (240 ms) — identical to Members / Tags | pass |
| MO-4 | reduced | nothing moves | none at every step | pass |
| MO-5 | Tags (Sift cell) via the tab bar | as MO-1 | as MO-1 | pass |
| MO-6 | the What is sent popover (a rerender) | no replay | the popover's own `cnpy-pop` only | pass |
| MO-7 | New tag modal | keyframe in / out, no replay while typing | `cnpy-cm-in` / `cnpy-cm-fade`; typing: none; Escape: `cnpy-cm-out` with `data-closing` | pass |
| MO-8 | reduced | nothing moves | no keyframes (only colour transitions on hover) | pass |
| MO-13 | the reading list after Claim | rises in once | **nothing animated** — the list popped in | **fail → fixed** (3b80ae8f): rises with `.cnpy-flash`; a repaint 15 ms later joins the same animation (traced: `cnpy-rise:running` across both repaints) |
| MO-14 | a later rerender (Copy as prompt) | no replay | none on the list | pass |
| MO-15 | reduced | nothing moves | none | pass |
| MO-40 | Settings › Email notifications switch | no re-entrance | the switch's transitions and the toast | pass |
| MO-41 | reduced | nothing moves | none | pass |

**Owner rulings, verified:**
- *The org switch covers every AI feature, PR and issue summaries included; off = no model call, no summary written,
  existing summaries readable.* `test/summaries.switch.test.ts` 7/7 (webhook and Sync: zero summarizer calls, no row,
  no meter; an existing summary unchanged); in the browser with test-ent switched off (OA-5/OA-26): `GET /sync` says
  `summaries.status:"disabled"` ("This organization's AI switch is off…"), and `/me/dashboard` (My Work) still
  returns the stored summaries ("test- what PR 115 changed"). JB-7: no `ai_dirty` row when off. — pass.
- *Settings has "Only when something needs me"* — EM-17, pass.
- *Legal keeps DRAFT markers; Jev never on a public page, Sift the only name* — LG-1/2: markers present; "Jev" in
  neither rendered text nor HTML. — pass.
- *TypeSafe passage*: "The model that sorts and checks items is TypeSafe AI's own, on services hosted in the United
  States, and TypeSafe AI does not train or fine-tune any model on what Trov sends it. TypeSafe AI's own subprocessors
  are listed at trust.typesafe.ai/subprocessors" (a link to https://trust.typesafe.ai/subprocessors). — pass.
- *Attachment deletion wording*: Privacy › retention "Deleting a conversation also deletes the files attached in it,
  except a file a ticket or doc still refers to or one you published to the organization. Deleting your account
  deletes the files you attached in Ask Trov and did not publish."; › deletion "…the files you attached in Ask Trov and
  did not publish to the organization…". — pass.

## Pre-existing (same on main; recorded, not fixed)

- **P-1** (EV-SF-cell-K): Tags › Sift's switch is `disabled` while its write is out (`tags.ts`, `ui.aiBusy`), so Space
  drops the keyboard's focus to `<body>`. The same line is on main. The fix would be the one made for Org settings › AI
  (daab320d) — the owner's call whether to extend it.
- **B-1**: `PUBLIC_ORIGIN=http://localhost:<port>` 301s every GET to https (above).

## Findings that are not failures

- **F-1** (FL-6): the AI routes' own codes (`off`, `no_key`, `unreadable`) have no line in `shared/error-hints.ts`, so
  a 403 `off` carries the generic 403 hint ("needs a role you do not have … Ask an admin"). The UI shows `message`,
  not the hint, and these routes are cookie-only; whether to add hints for them is the owner's call.
- **B-1** above (pre-existing).

## Questions (spec silent or the matrix and the spec disagree — not guessed)

| case | question | what I'd expect, and why |
|---|---|---|
| EM-3 (Q32/Q43) | With the switch OFF, the daily still draws "Also" from importance ratings made earlier (matrix expected none). | Keep it: the Privacy draft says earlier ratings still count with the switch off, and nothing new is sent. But the matrix and the code disagree, so the owner decides. |
| EM-6 (Q45) | The Sprint line is not in the default daily — `roadmap_plan` defaults to weekly (as on main); spec Phase E lists "Sprint: …" among the daily's queue lines. | Default `roadmap_plan` to daily, since the spec's daily shows it; it is a default every member gets, so not changed here. |
| FL-23 (Q3) | After a hand change, the "Filtered: …" line and Undo stay, describing filters that no longer hold. | Clear the line (and Undo) on any hand change. |
| FL-25 (Q2) | The filter's error stays while the person types. | Clear it on input (the code's own comment says so). |
| OA-15 (Q10) | A canceled plan: eligibility `capped`, no "Used up" line, so Org settings › AI says nothing about why. | One line: "This organization's Pro plan has ended, so Trov's AI is paused until it is renewed." |
| PU-2 (Q7) | No Anthropic key hides the Sift figures too. | Show Sift on its own key. |
| SF-15 (Q9) | Find items says "Suggestions are off" when the ORG switch is the cause. | Name Org settings › AI, as the Sift cell does. |
| RL-3 (Q12) | The reading list is gone after a reload. | As built ("never stored") — fine, but say so to the owner. |
| OA-1 (screen copy) | Org settings › AI's What is sent now mirrors the Privacy Policy's AI rows (0a8519eb), four of which are still DRAFT there. | Approve both together; the new screen lines carry no DRAFT marker. |
| F-1 | No `hint` for the AI routes' own codes (`off`, `no_key`, `unreadable`). | Add hints, e.g. off: "This organization's AI switch is off (Org settings › AI): nothing was sent. An admin can turn it on." |
| matrix | The reference shots `ai-screens-shots/org-ai-*` show the pre-Phase-A page (one allowance, one switch). | Replace them with this run's `oa-p*` shots. |
