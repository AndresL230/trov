# Server-side AI — Phase H e2e, Tier 1: the `screens` group

The procedure is `docs/superpowers/specs/2026-10-15-server-ai-e2e.md`; the cases and their EXPECTED results are
`docs/testing/server-ai-test-matrix.md` (§ 4 BR / ST / TH / FD / FI / TC / UP / RV / RM / SG / WR, § 6 and § 7 for
those surfaces; Tier 1 = § 10). Expected text below is the matrix's, written before the run; it was not edited to
match what was seen.

**Run.** Branch `ai/e2e-screens` from `af26ce3c` (everything merged: phases A–G, Ask, main's #186). Own local D1
(`.wrangler/state` of this worktree): `npx wrangler d1 migrations apply trov --local`, then
`node scripts/seed/server-ai-e2e.mjs` (121 of 121 fixtures) and `node scripts/seed/repo-setups.mjs`, plus one session
row `e2e-andres` → AndresL230 for the #186 scenarios (no seeded session exists for him; `DEV_LOGIN` is unset so
fixture cookies work). Reseeded between cases that write. `wrangler dev --port 8820`, `.dev.vars` from
trov-preview-ai with `DEV_LOGIN` commented out, every AI / Stripe key blank, **`LOCAL_AI_PREVIEW` unset** for every
case except the preview sweep (P:*, named in its rows). Browser: Playwright Chromium (headless), cookies from
`scripts/dev-cookie.mjs test-session-<handle>`; desktop 1440×900, phone 360×780, `colorScheme` light / dark,
`reducedMotion` emulated. MCP cases POST `/mcp` with the `bearer-token` fixture. Motion evidence is
`document.getAnimations()` sampled under the surface (`anims`), after a route change, after a rerender that is not
a route change (opening and closing the command palette), and during an exit.

Screenshots: `docs/testing/server-ai-shots/screens/<case>.png`.

## Baseline

- Typecheck at the branch head: clean (`npm run typecheck`, run before each commit). The full suite runs once,
  through the gate script, at the final commit (RULES 1) — result at the end of this log.
- The base for "existed on main" surfaces is the baseline server at :8800 (main 2b7d0183, seeded with the dev seed).
- No console error and no failed request on My Work, Repo, Feed, Tickets, Review, Unplaced or Roadmap on first load
  (every case below records `console` / `failed`; the only console line seen anywhere is Chromium's
  "geist-latin… was preloaded using link preload but not used within a few seconds" WARNING on some loads — the
  font preload, not this feature).

## Cases

| id | surface | state (fixture · who · viewport · theme) | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| BR-1 | My Work › Your brief | brief-ready-5-next · member · 1440 · light | `.mw-bento-brief`; Now (cites #1, #3), Recently (#115, #113), Next ×5 in server order (Failing CI run 4812 · Due soon #4 unicode intact · Handoff #1 · Handoff #4 · ticket #3 injection title as TEXT); titles linked to `cites[0].href`; "Written by Trov, …ago" + Wrong? | matrix BR-1; `web/src/mywork.ts` `briefTile` | exactly that: tile `data-ai-state=ready`; Next order Failing → Due soon → Handoff → Handoff → #3; titles → `#tickets/4`, `#handoffs/1`, `#handoffs/4`, `#tickets/3`; the run's title is plain text (its cite href is null); `#115`/`#113` open GitHub in a new tab; 0 `<img>`/`<b>` in the tile, no dialog; footer "Written by Trov, 16m ago" + Wrong?; the Next list scrolls inside the fixed-height tile (owner's bento rule); no console error | pass | BR-1.png; DOM text + links | |
| BR-2 | `GET /me/dashboard` | same | `brief.state:"ready"`, `generatedAt` = version 6's; v1–5 never shown | matrix BR-2 | `state:"ready"`, `generatedAt 2026-10-15T21:19:17.527Z` = `person_brief` v6 (v1–v5 older) | pass | API body + `person_brief` rows | |
| BR-3 | brief tile | brief-one-next · member · org-free | no Now; Recently; one Next "test-Login page is blank on Safari", "You have it in progress." | matrix BR-3 | Recently (#113) + one Next `#1` "test-Login page is blank on Safari" / "You have it in progress."; no Now | pass | BR-3.png | |
| BR-4 | brief tile | brief-empty · admin · org-enterprise | the empty sentence; no byline, no Wrong? | matrix BR-4 (Q24) | "Trov writes your brief after your next push or when something is assigned to you. It reads your sessions, pull requests, tickets and handoffs."; no byline, no Wrong? | pass (Q24 stays open) | BR-4.png | |
| BR-5 | brief tile | brief-capped · member · org-at-cap (Free) | Now muted; "Monthly AI allowance used; your brief resumes <1st next month>." + "Upgrade to Pro" | matrix BR-5; `aiCapped` | Now line, then "Monthly AI allowance used; your brief resumes Nov 1. Upgrade to Pro"; byline "Written by Trov, Oct 6" + Wrong? | pass | BR-5.png | |
| BR-6 | brief tile | brief-capped, org-at-cap set to `personal` | no Upgrade link | matrix BR-6 | capped line without "Upgrade to Pro" (restored to free after) | pass | BR-6.png | |
| BR-7 | My Work | brief-ai-off · member · org-ai-off | NO tile; the five tiles + library strip as before | matrix BR-7 | tiles `tickets, review, sessions, repo, library`; no `[data-mw=brief]` | pass | BR-7.png | |
| BR-8 | My Work | brief-malformed · member2 | no tile | matrix BR-8 | no brief tile; classic layout | pass | BR-8.png | |
| BR-9 | My Work | brief-wrong-pressed · owner | no tile for test-owner; test-member still sees theirs | matrix BR-9 | owner: no tile; member: tile (BR-1) | pass | BR-9.png | |
| BR-10 | brief tile | member · press Wrong? | tile hidden; reload → still hidden; it leaves by the AI kit's one exit (owner ruling; MO-18 "the bento re-flows smoothly") | matrix BR-10, MO-18; master's ruling | **before the fix:** hidden and `ai_feedback` row written (ref = v6's `generated_at`), still hidden after reload — but the tile VANISHED at once (no `.cnpy-ai-leave`, 0 animations at +60 ms) and the bento jumped to its other layout. **After:** the tile collapses in its slot (`.mw-bento-brief > .cnpy-ai-leave`, `cnpy-ai-leave` running at +80 ms), then the classic bento fades in (`.mw-bento.cnpy-flash`); toast "Hidden for you. Thanks: Trov is told it was wrong."; reload: still hidden | fail → fixed | MO-18-brief-leaving.png, BR-10-after.png; animations | 6c658685 (`test/render.ai-motion.test.ts` › My Work's brief leaves…) |
| BR-11 | brief tile | brief-stale (20 days) · org-pro | shown, no staleness rule | matrix BR-11 (Q25) | shown; byline "Written by Trov, Sep 25" (relTime switches to a date past a week, so not "20 days ago") | pass (Q25 open) | BR-11.png | |
| BR-12 | My Work | brief-not-wanted · test-noemail | no tile | matrix BR-12 | no tile | pass | BR-12.png | |
| BR-13 | `memberships.mywork_opened_at` | member | 5 min old → unchanged; 2 h old → now | matrix BR-13 | 21:35:10 → 21:35:10 (unchanged); 19:40:16 → 21:40:17 (set) | pass | DB rows before/after | |
| BR-14 | MCP `get_my_work` | bearer | `brief` present; `mywork_opened_at` NOT written | matrix BR-14 | `brief.state:"ready"` in the result; `mywork_opened_at` stayed 10:00:00 | pass | MCP body; DB row | |
| ST-1 | Repo › Overview › State | repo-state-ready · member · org-enterprise | "State" + "Written by Trov from 6 events, 1h ago"; headline; Shipped recently (2) / In flight (1) / Needs attention (1) with done / half / warn glyphs; "#115 · #113" → GitHub; "CI run 4812" plain text; "test- webhook retries half done" → `#feed`; Wrong? bottom right | matrix ST-1; `web/src/repo-ai.ts` | all of it ("from 6 events, 2h ago" — the seed's time); `#115`/`#113` new tab; the run plain text; the feed cite → `#feed`; Wrong? at the bottom right | pass | ST-1.png | |
| ST-2 | `GET /repo/dashboard` | same | `state` = version 2 only | matrix ST-2 | `state.generatedAt` = v2's, `eventCount 6` | pass | API body | |
| ST-3 | State | repo-state-capped · org-at-cap | headline + "Monthly AI allowance used; this state is from <date> and resumes <1st>." + Upgrade (Free) | matrix ST-3 | "…this state is from Oct 15 and resumes Nov 1. Upgrade to Pro" under the headline | pass | ST-3.png | |
| ST-4 | State | repo-state-no-event-count · org-free | byline without "from N events" | matrix ST-4 | "Written by Trov, 2h ago" | pass | ST-4.png | |
| ST-5 | Overview | repo-state-malformed · org-pro | NO State; the rest unchanged | matrix ST-5 | no `[data-ai=repo_state]`; blocks `unseen, week` as without it | pass | ST-5.png | |
| ST-6 | State | repo-state-stale · org-pro-gifted | shown, 30 days old | matrix ST-6 (Q25) | shown, "…from 6 events, Sep 15" (relTime's date form) | pass (Q25 open) | ST-6.png | |
| ST-7 | Overview | repo-state-wrong-pressed · member2 | no section for member2 | matrix ST-7 | none (member sees it, ST-1) | pass | ST-7.png | |
| ST-8 | Overview | org-ai-off (rows stored) | no section | matrix ST-8 | none | pass | ST-8.png | |
| ST-9 | Overview | empty-org | no section (no repo) | matrix ST-9 (Q23) | none; the no-repository page | pass (Q23 open) | ST-9.png | |
| ST-10 | State | member · Wrong?, reload; then a newer version | still hidden; a NEWER version shows again | matrix ST-10 | leaves by the kit's exit (`cnpy-ai-leave` running at +80 ms); toast; `ai_feedback` ref `test-org/test-ent-repo@<v2 time>`; reload: hidden; after inserting v3: shown, "Written by Trov from 6 events, just now" | pass | MO-22-state-leaving.png | |
| ST-11 | Repo tabs | member · Overview → Planning → Overview | the section only on Overview | matrix ST-11 | 0 on Planning, 1 back on Overview | pass | DOM counts | |
| ST-12 | Repo sample | member · Preview with sample data | NO State on the sample | matrix ST-12 | 0 sections on the sample | pass | ST-12.png | |
| ST-13 | MCP `get_repo_dashboard` | bearer · no tab / overview / ci | `state` with no tab and overview; absent with `ci` | matrix ST-13 | `state.state:"ready"` (no tab, overview); absent with `tab:"ci"` | pass | MCP bodies | |
| ST-15 | Overview over RepoFacts | repo-state-over-repofacts + repo-setups · saplinglearn · AndresL230 | State sits IN `<div data-repo-state-slot>` above the rule-picked block (R6 env cards); deploy cite reads "Production backend" (part label, not provider id) | matrix ST-15; `docs/architecture/repo-apps.md:307` | the cite reads "Production backend" (plain text) ✓; State is ABOVE the attention / env-card blocks ✓ — but NOT in the slot: `repoAiSection` draws it as its own card above "Group by" and the panel, and the slot `<div data-repo-state-slot>` inside the panel stays empty | question (Q-S1) | ST-15.png; DOM (`inSlot:false, slotEmpty:true`) | not fixed: moving it into the panel puts a card inside the panel's surface — a visual call for the owner |
| ST-16 | Overview health words | same | "Healthy" only when `ci.state` is pass; nothing unknown drawn as 0 | matrix ST-16 | Staging "Healthy" with "All 3 checks passing"; Production "Failing" (deploy failed); Releases "— not known yet"; Railway not connected → the connect card | pass | ST-15.png, panel text | |
| ST-17 | Overview | new-org-found (acme) · AndresL230 | found-apps card (R1); no State | matrix ST-17 | blocks `found, week`; no State | pass | ST-17.png | |
| ST-18 | Overview | unseen-org (test-unseen) | "Trov does not see deploys" card (R2); no State | matrix ST-18 | blocks `unseen, week`; no State | pass | ST-18.png | |
| FD-1 | Feed › Trov entry | trov-entry-linked · member | AI-mark avatar, "Trov", "for @test-member", time, summary, body What/Why/Impact + italic footer; "From #115, 65b9f1f and a1c04e2" → GitHub; Wrong?; NO tags | matrix FD-1 | all of it; the body (What / Why / Impact / "Written by Trov from 1 pull request and 2 commits… Not reviewed by a person.") shows under **For agents**; **For reading** (the default) shows the entry's brief, like every entry; 0 tags | pass | FD-1.png, FD-1-agents.png | |
| FD-2 | Trov entry | trov-entry-no-subject | byline "written by Trov" | matrix FD-2 | "Trov · written by Trov · 2h ago" | pass | FD-1.png | |
| FD-3 | Trov entry | trov-entry-unlinked | sources as plain text | matrix FD-3 | "From #113 and e5f6071", 0 links | pass | FD-1.png | |
| FD-4 | Trov entry | trov-entry-bad-artifacts | no "From …" line | matrix FD-4 | no From line ✓ — but its tooltip read "Written by Trov from . Not official; check the sources." (`aiFeedTip` with no sources). After the fix: "Written by Trov. Not official; check the sources." | fail → fixed | DOM `data-mtip` before / after | c303b3d9 (`test/render.ai.test.ts` › the entry's tooltip…) |
| FD-5 | Trov entry | trov-entry-many-cites | "From #110, #111, 1111111 and 2 more"; tooltip "Written by Trov from … and 2 more. <not official>" | matrix FD-5 | exactly that | pass | DOM | |
| FD-6 | Source switch | member · Source = Trov | only `origin='ai'` rows | matrix FD-6 | 701020–701024 only | pass | FD-6.png | |
| FD-7 | Source switch | member · Source = Agents | only agent rows | matrix FD-7 | the 4 agent entries, 0 Trov cards | pass | DOM | |
| FD-9 | Feed | org-free (no Trov rows) | NO Source switch | matrix FD-9 | no switch, no note | pass | DOM | |
| FD-10 | the note | member, first time | the note's sentence + "AI settings" + "Got it", above the first Trov entry | matrix FD-10 | exactly that, before the first Trov card | pass | FD-1.png | |
| FD-11 | the note | member · Got it, reload; member2 | note gone (localStorage `trov.aiFeedNote`, per handle); member2 still sees it | matrix FD-11 | leaves by the kit's exit; `trov.aiFeedNote = ["test-member"]`; gone after reload; member2 (same storage) sees it | pass | DOM, localStorage | |
| FD-12 | the note | storage throws | no error; note hides for this page | matrix FD-12 | `localStorage` getter throwing: Got it hides it, no console error | pass | console | |
| FD-13 | Feed | trov-entry-wrong-pressed · member2 | the Safari entry hidden for member2 only | matrix FD-13 (Q28) | member2: 701020 absent, 701021–701024 shown; member: shown | pass (Q28 open) | DOM | |
| FD-14 | Feed | trov-entries-ai-off · org-ai-off | Trov entries STILL show with AI styling | matrix FD-14 (Q29) | they show (706020, 706021) with the AI styling — and so do the Source switch and the note, whose sentence ("Trov now writes entries from your commits…") is not true while the org's AI is off | question (Q29) | FD-14.png | |
| FD-15 | `GET /feed?author=test-member` | member | digests ABOUT test-member are not included | matrix FD-15 (Q30) | only 701005, 701008 (her own) | pass (Q30 open) | API body | |
| FD-17 | MCP `get_feed` | bearer | Trov rows carry `ai`; Wrong? NOT applied over MCP | matrix FD-17 | `ai` on every Trov row ✓; but 701021, which test-member flagged on the web, is LEFT OUT over MCP (`src/mcp.ts` `hideWrongFor`) — what `docs/architecture/feed-and-search.md:185` says ("`/feed` and MCP `get_feed` both leave out a Trov entry the caller flagged") | question (Q-S2) | MCP body; `ai_feedback` row | the matrix and the area doc disagree; code follows the doc |
| FD-19 | People | admin · Org settings › People; `/persons` | `trov` never listed | matrix FD-19 | not in People, not in `/persons` | pass | DOM, API | |
| FI-1 | Feed importance marks | feed-importance-mixed | 701005 "Breaking" (amber triangle, tip "Sift rates this a breaking change: …A rating, not official."); 701006 "Notable" (accent dot); 701007 routine and 701008 NULL: nothing | matrix FI-1 | exactly that (the mark is an element with `data-mtip`, no pill) | pass | FD-1.png | |
| FI-2 | `GET /feed` | same | `importance` only on 701005 / 701006 / 701007; absent on 701008 | matrix FI-2 | breaking / notable / routine; ABSENT on 701008 and the Trov rows | pass | API body | |
| FI-3 | Feed | feed-importance-ai-off | marks STILL drawn | matrix FI-3 (Q32) | drawn | pass (Q32 open) | FD-14.png | |
| FI-4 | Trov entry | 701020 set notable | the mark on the Trov card too | matrix FI-4 | "· Notable" with its tooltip on the Trov card | pass | FI-4.png | |
| FI-6 | MCP `get_feed` | bearer | same `importance` field | matrix FI-6 | breaking / notable / routine as on `/feed` | pass | MCP body | |
| TH-1 | Repo › Planning › Where the work went | themes-active-and-proposed · admin | header "Themes and caption written by Trov from N pull requests, <rel>"; the caption; 5 lanes (4 active + test-Emails proposed); first lane picked, others .55; "Band height is merged pull requests per week."; chip "Suggested: test-Emails, because…" Accept / Rename / Remove; Edit themes | matrix TH-1 | exactly that ("…from 10 pull requests, 1h ago"); lanes `aria-pressed` true + false ×4 at opacity .55 | pass | TH-1.png | |
| TH-2 | same | member | no Edit themes; "Waiting for an admin to accept themes", no buttons | matrix TH-2 | that; the chip has only "because…" | pass | TH-2.png | |
| TH-3 | Edit themes | admin | focuses `#repo-themes-proposed` | matrix TH-3 | `activeElement.id = repo-themes-proposed` | pass | DOM | |
| TH-4 | Accept 5401 | admin | 200; "Accepted"; the dashboard re-reads; test-Emails active, chip gone; `status='active'`, `decided_by='test-admin'`; `ai_dirty theme_backfill` | matrix TH-4 | all of it; the chip leaves by the kit's exit (`cnpy-ai-leave` at +80 ms). The lane then reads "test-Emails: 0 merged pull requests" (1 while proposed), the byline "from 9 pull requests" — Q-S3 | pass (Q-S3) | MO-26-theme-leaving.png, TH-4.png; DB | |
| TH-5 | Rename 5401 → "test-Mail" (Enter) | admin | 200; lane test-Mail, active | matrix TH-5 | name test-Mail, active, decided_by test-admin; lane drawn | pass | TH-5.png | |
| TH-6 | Rename with bad input | admin · "", 45 chars, "(x)", "test-Hosting", `<img src=x onerror=alert(1)>` | "": nothing sent; 41+ / "(x)" / taken: 400 → "Couldn't do that. Try again." (Q20) | matrix TH-6 | "": nothing sent; the field is `maxlength=40` now (Q20's 60 ≠ 40 is gone), so 45 chars types as 40 and is accepted; "(x)" and "test-Hosting": 400 `invalid` → "Couldn't do that. Try again.", field kept; the markup name is accepted and drawn as text (0 `<img>`, aria-label literal) | pass (Q20: words stay generic) | TH-6.png, TH-6-markup-name.png | |
| TH-7 | Remove 5401 | admin | 200; "Removed"; theme `removed` | matrix TH-7 | that; lane gone | pass | DB, DOM | |
| TH-8 | `POST …/5401/dismiss` | member | 403 `forbidden` | matrix TH-8 | 403 | pass | API | |
| TH-9 | accept `{value:{mergeInto:<test-Hosting>}}` | admin · API | 200; proposed → removed, `merged_into`, seeds unioned | matrix TH-9 | 200; theme 27 removed, `merged_into 23`; test-Hosting `seed_prs [] → [100,104,108]` | pass | DB | |
| TH-10 | Planning | themes-proposed-only · org-pro · admin | one proposed lane + chip; no caption | matrix TH-10 | that; byline "Themes written by Trov from 0 pull requests" (Q-S4) | pass (Q-S4) | TH-10.png | |
| TH-11 | Planning | themes-at-8 · org-free | 8 lanes, no proposal | matrix TH-11 | lanes A–H, no chip | pass | TH-11.png | |
| TH-12 | Planning | themes-malformed · org-pro-gifted | bad-seeds lane empty; removed theme not drawn; its caption hidden | matrix TH-12 | "test-Bad seeds: 0 …, proposed" + "test-Live"; no removed lane; no caption | pass | TH-12.png | |
| TH-13 | Planning | themes-ai-off | no section | matrix TH-13 | none | pass | TH-13.png | |
| TH-15 | range → Quarter | admin | 13 weeks; no caption | matrix TH-15 | 13 columns; "Themes written by Trov from 16 pull requests"; only the segmented slide animates | pass | TH-15.png | |
| TH-16 | Wrong? on 8 weeks, reload | member | hidden on the next read; Quarter still shows; leaves by the kit's exit (ruling) | matrix TH-16 | **before:** the card swapped AT ONCE to "You marked this range wrong…" (0 animations). **After:** caption, byline, proposals, chart and detail collapse inside the card (`cnpy-ai-leave` ×2 at +80 ms), heading + switch kept, then the sentence; reload: hidden; Quarter draws; reduced motion: at once | fail → fixed | MO-26-themes-wrong-leaving.png | 994dd1dd (`test/render.ai-motion.test.ts` › Where the work went…) |
| TH-17 | P:proposed · admin · Accept a fixture chip | | 404 → "Couldn't do that. Try again." (Q5) | matrix TH-17 | that toast | pass (Q5 open) | P-proposed-themes.png | |
| TH-18 | P:ready / empty / capped / proposed | admin | the four states; empty "Themes appear once this repo has 15 merged pull requests."; capped "…themes resume <day>." + Upgrade | matrix TH-18 | ready: 6 lanes + caption; empty: that sentence; capped: "…themes resume Nov 1. Upgrade to Pro"; proposed: 6 chips | pass | P-*-themes.png | |
| TH-19 | Accept on a stale page | admin (5401 decided meanwhile) | 409 → "Someone already answered that suggestion." | matrix TH-19 | that toast | pass | DOM | |
| TH-20 | MCP `get_repo_dashboard {tab:"planning"}` | bearer | carries `themes` | matrix TH-20 | `themes.8w` with lanes | pass | MCP | |
| TH-21 | lane buttons | member | `aria-pressed`, aria-label "<name>: N merged pull request(s)[, proposed]"; ≤ 8 PR cites | matrix TH-21 | that; Billing lists 3 cites; the pick re-enters nothing | pass | DOM | |
| TC-1 | ticket chips | ticket-with-suggestions · member · `#tickets/2` | "Suggested: bug category, because…" / "…high priority…" under Properties after OPENED; "possible duplicate of #1 …" above Linked work, `href="#tickets/1"` | matrix TC-1 | **first run:** "Suggested: null category" / "null priority" — the SEED stored `value_json` as bare `bug`, not JSON. After the seed fix: exactly as expected | fail → fixed (seed) | TC-1.png | 65d6b8db (`test/seed-server-ai-e2e.test.ts`) |
| TC-2 | because… | member | `aria-expanded` toggles; the reason | matrix TC-2 | false → true; "because both mention “login”, “blank” and “safari” #1" | pass | TC-2.png | |
| TC-3 | Accept 5101 | member | 200; "Accepted"; category bug; no `ticket_events` row; chip gone | matrix TC-3 | (after the seed fix) that; events 1 → 1; the chip leaves by the exit | pass | MO-34-chip-leaving.png | |
| TC-4 | Accept 5103 | member | `ticket_links` `#1` (url `<origin>/test-ent/#tickets/1`, meta `TROV · TICKET`) by test-member; both stay open | matrix TC-4 | exactly that; #1 in_progress, #2 submitted | pass | TC-4.png; DB | |
| TC-5 | Accept 5103 again | member | 200 no-op | matrix TC-5 | 200; one link | pass | API, DB | |
| TC-6 | Dismiss 5102 | member | "Removed"; chip gone; ticket unchanged | matrix TC-6 | that | pass | DB | |
| TC-7 | ticket-suggestion-decided | member | no chips | matrix TC-7 | none | pass | DOM | |
| TC-8 | ticket-done-with-suggestion | member | open chip on a done ticket (Q35) | matrix TC-8 | "Suggested: request category" on done #5 | pass (Q35 open) | TC-8.png | |
| TC-9 | Accept 5115 (#99) | member · API | Q36: 500 today | matrix TC-9 | **409 `not_available`** (no 500) | pass (Q36 changed) | API | |
| TC-10 | org-ai-off | member | no `ai`, no chips | matrix TC-10 | none; `ai` absent | pass | DOM, API | |
| TC-11 | org-free | member | chips drawn | matrix TC-11 | the three chips | pass | DOM | |
| TC-12 | accept 5114 `{value:"nope"}` | member · API | Q36: 500 today | matrix TC-12 | **400 `invalid`** (no 500) | pass (Q36 changed) | API | |
| TC-14 | P:ready · `#tickets/3` | member | 901 bug, 902 high, 903 duplicate of #2; Accept → "Couldn't do that." | matrix TC-14 | exactly that | pass | P-ready-ticket3.png | |
| TC-15 | P:ready · `#tickets/1`, `#tickets/5` | member | no duplicate on #1; nothing on #5 | matrix TC-15 | that | pass | DOM | |
| UP-1 | Unplaced | unplaced-with-suggestion | row "· [mark] reference, next to “test-Deploy checklist”" (no button); chip above "File it as" | matrix UP-1 | that; the mark's words were cut off on narrow rows → fixed under EV-UP-chip-P | pass | UP-1.png, UP-1-detail.png | |
| UP-2 | Unplaced | free-form item | no mark, no chip | matrix UP-2 | none | pass | DOM | |
| UP-3 | Accept 5116 | member | filed as a staged doc proposal in `reference` by test-member through the gate; nothing promoted; the queue re-reads | matrix UP-3 | `test-runbook-netlify v1 staged, created_by test-member, change_kind new`; test-deploy-checklist still v1; item resolved `assigned → doc:test-runbook-netlify@1`; queue 2 → 1 | pass | DB | |
| UP-4 | Accept again | member | 200 | matrix UP-4 | 200 | pass | API | |
| RV-1 | Review list | review-with-risk | "· [mark] Changes a decision" on the proposal; "· Contradicts a doc" on the draft ADR; no buttons | matrix RV-1 | that | pass | RV-1.png | |
| RV-2 | Review detail | same | "Trov: Changes a decision, because…" + Dismiss only; Promote / Reject unchanged | matrix RV-2 | that, on both; 0 Accept | pass | RV-8.png | |
| RV-3 | accept 5118 | member · API | 409 `not_available` | matrix RV-3 | 409 | pass | API | |
| RV-4 | Dismiss 5117 | member | 200; only the line changes | matrix RV-4 | "Removed"; line + list mark leave by the exit; 4 rows before and after | pass | DOM | |
| RV-5 | `GET /adrs?status=ratified` | adr-ratified-with-risk | 5119 still attached (Q37) | matrix RV-5 | attached | pass (Q37 open) | API | |
| RV-7 | Review | doc-drift-proposal | test-webhook-retries v2 by **trov**, low confidence, "Trov: …"; Promote / Reject | matrix RV-7 | "Low confidence · Trov: the retry queue table exists now. From feed entries…", @trov | pass | RV-7.png | |
| RV-8 | Review detail | ask-flags-review | "Flagged in Ask": reasons + counts; never question / answer / asker | matrix RV-8; handoff #12 § 2.14 | **before:** NO line — the reads carry `askFlags`, the SPA dropped them. **After:** "Flagged in Ask: A source is wrong (2) · It is out of date (1)" on the staged doc, "…A source is wrong (1)" on the draft ADR | fail → fixed | RV-8.png | 376ffb1e (`test/render.review.test.ts` › Flagged in Ask) |
| RV-OWNER-1 | Review list cards | the owner's report + layout (coordinator, 2026-10-15) · desktop / 360 · light / dark | footer ALWAYS one line: author avatar only (handle in tooltip + accessible name, still opens the person), kind, where (section path in sentence case or ADR number — the part that truncates, full text on hover), time; the AI risk a mark top-right of the header (Low confidence first, the risk under it); the title wraps left of the marks; same meta height with or without a risk; the risk keeps the kit's exit | the owner | **before** (owner's screenshot, RV-1.png, EV-RV-*): "Proposal · TECHNICAL / ARCHITECTURE · TR @trov · 12h ago · Changes a decision" wrapping to 1–2 lines, the risk a dotted word in the byline, the path UPPERCASE. **After (code + render tests):** the card is a surface with a hit area (`hitArea("reviewSelect")`) so the avatar can be its own `openPerson` button (never a button in a button); `.cnpy-rv-meta` is one nowrap line of fixed height with slots author · kind · where · time, only "where" ellipsizes (`data-mtip` = full path); the path is sentence case (also in the detail header); the risk is `aiStateMark` (marks.ts) in `.cnpy-rv-marks` beside the title, stacked under Low confidence, still leaving by `aiLeaving` | fail → fixed in code; **browser retest NOT run** (the owner stopped all test runs, RULES § 9) | RV-1.png (before) | this commit (`test/render.review.test.ts` › Review cards: one meta row…; snapshot `render.ai-cards` Review updated on purpose) |
| RV-9 | `GET /proposals`, `/adrs?status=draft` | same | `askFlags[{ref, reason, count, lastAt}]` | matrix RV-9 | doc: out_of_date 1, source_wrong 2; `decision:701002` source_wrong 1 | pass | API | |
| RM-1 | Roadmap | sprint-active-forecast · member | "At this pace, done <date>, N days late/early", arithmetic tooltip, NO AI mark | matrix RM-1 | "At this pace, done Nov 6, 18 days late", tooltip "Arithmetic, not a prediction…", no mark | pass | RM-1.png | |
| RM-2 | Roadmap | same | no forecast on upcoming / done | matrix RM-2 | one forecast only | pass | DOM | |
| RM-3 | sprint note | sprint-note | note + "Written by Trov, 5h ago" + cites + Wrong? on the ACTIVE sprint only | matrix RM-3 | that; `#1 #2 #5` | pass | RM-1.png | |
| RM-4 | drift | plan-drift | the line + "test-Search 48% (in no sprint) · test-Hosting 32% · test-Auth 20% (in no sprint)" + "…from the last 14 days, 4h ago" | matrix RM-4 | exactly that | pass | RM-1.png | |
| RM-5 | cards | roadmap-suggestions · admin | "Suggested: a new plan narrative, because…" + the markdown | matrix RM-5 | that | pass | RM-5.png | |
| RM-6 | cards | member | none | matrix RM-6 | none | pass | DOM | |
| RM-7 | Accept 5501 | admin | `write_plan` as test-admin; "Accepted"; the narrative reloads | matrix RM-7 | plan v2 by test-admin; "Accepted"; the card's exit; the narrative on screen | pass | RM-7.png | |
| RM-8 | cards | org-pro · admin | 5502 "Suggested: 2 sprints from 4 backlog tickets" with names, goals, #7 #8 #9 #12; 5503 skipped | matrix RM-8 | **before:** NO card — 5503's `sprints:"not a list"` threw in `roadmapLabel` and the read's catch dropped every suggestion (server log "suggestions read failed TypeError"). **After:** the 5502 card as expected; 5503 not drawn | fail → fixed | RM-8.png | a1ce308d (`test/ai.roadmap.test.ts`) |
| RM-9 | Accept 5502 | org-pro · admin | two UPCOMING sprints, no dates, by test-admin; #7 #8 #9 #12 moved | matrix RM-9 | "test-Draft: Exports" / "…Hardening", upcoming, `start_date` null, `target_date` "", by test-admin; the four tickets in them | pass | RM-9.png; DB | |
| RM-10 | drift | org-pro (15 days old) | none | matrix RM-10 | none | pass | DOM | |
| RM-11 | note | sprint-note-malformed | none | matrix RM-11 | none | pass | DOM | |
| RM-12 | Roadmap | roadmap-ai-off · admin | no notes / drift / cards; forecast shows | matrix RM-12 | that | pass | RM-12.png | |
| RM-13 | Wrong? on the note, reload | member | hidden for test-member | matrix RM-13 | the exit; reload: hidden; `ai_feedback sprint_note 100101@…` | pass | MO-38-note-leaving.png | |
| RM-14 | MCP `get_roadmap` / `get_sprint` / `list_sprints` | bearer | forecast, notes, drift; never suggestions; a web-hidden note still shows | matrix RM-14 | all of it | pass | MCP | |
| RM-15 | `#sprints/<id>` | member | Q39 | matrix RM-15 | no note, no forecast there | pass (Q39 open) | RM-15.png | |
| RM-16 | accept 5503 | admin · API | 400 `invalid`, "that sprint draft is not one Trov can create"; reopened | matrix RM-16 | exactly that; still open | pass (Q40 open) | API, DB | |
| RM-17 | P:ready · admin | | notes, drift "The last two weeks went mostly to Billing and plans…", 9101 / 9102 (Accept → 404) | matrix RM-17 | that; Accept → "Couldn't do that. Try again." | pass | P-ready-roadmap.png | |
| SG-1 | `/ai/suggestions/abc`, `/0` | member | 404 | matrix SG-1 | 404 ×2 | pass | API | |
| SG-2 | accept 5001 | member | 409 `not_available` | matrix SG-2 | 409 | pass | API | |
| SG-3 | dismiss 5001 | member | 200, dismissed by test-member, `decided_at` | matrix SG-3 | that | pass | DB | |
| SG-4 | accept / dismiss 5002 | member | 409 `not_open` ×2 | matrix SG-4 | 409 ×2 | pass | API | |
| SG-5 | dismiss 5001 twice in parallel | member | one 200, one 409 | matrix SG-5 | 200 + 409 | pass | API | |
| SG-6 | accept 5401 with `"x"` / `[]` | admin (5401 is admin-only; a member gets 403 first — SG-7) | 400 `invalid` | matrix SG-6 | 400 ×2 (and `{value:{name:""}}`); still open | pass | API | |
| SG-7 | accept 5401 | member | 403 | matrix SG-7 | 403 | pass | API | |
| SG-x | accept 5003 (other org) | member | 404 | matrix § 3 | 404 | pass | API | |
| WR-1 | feedback without `model` / `promptVersion` | member | 400 (Q15) | matrix WR-1 | 400 with both issues | pass (Q15 open) | API | |
| WR-2 | bad itemType / 201-char ref / 61-char kind | member | 400 each | matrix WR-2 | 400 ×3 | pass | API | |
| WR-3 | a valid body twice | member | 200 ×2; ONE row | matrix WR-3 | that | pass | DB | |
| WR-4 | Wrong? offline | member · Feed | it comes back + "Couldn't send that. It is back on screen; try again." | matrix WR-4 | that | pass | WR-4.png | |
| WR-5 | Wrong? | member | hidden at once + "Hidden for you. Thanks: Trov is told it was wrong." | matrix WR-5 | that, on the brief, State, a Trov entry, themes | pass | toasts | |
| BR-15 | brief | P:ready | the fixture brief | matrix BR-15 | Now / Recently / Next = the fixture's (= `mywork-brief-ready-*.png`) | pass | P-ready-brief.png | |
| BR-16 | brief | P:empty | the empty sentence | matrix BR-16 | that | pass | P-empty-brief.png | |
| BR-17 | brief | P:capped | capped line | matrix BR-17 | "…resumes Nov 1. Upgrade to Pro" | pass | P-capped-brief.png | |
| BR-18 | brief | P:ready · org-ai-off | fixture still shows (Q13) | matrix BR-18 | it shows, every mode | pass (Q13 open) | P-*-brief-ai-off.png | |
| ST-14 | State | P:ready / empty / capped | fixtures replace the real one | matrix ST-14 | ready "Release 0.30 is live…"; empty "Written by Trov" + the sentence (= the design shot); capped "…from Oct 6 and resumes Nov 1. Upgrade to Pro" | pass | P-*-state.png | |
| ST-19 | State | P:ready over sapling-live | fixture State; RepoFacts blocks unchanged | matrix ST-19 | blocks `attention, connect, envCards, week, links` unchanged | pass | P-ready-state-sapling.png | |
| FD-16 | Feed | P:ready | 990001 / 990002 merged; not with another author or a tag | matrix FD-16 | merged; `?author=test-owner` / `?tags=auth` carry no 99000x | pass | P-ready-feed.png | |

### § 6 environment (pairwise: each surface's main states at desktop dark, 360 light, 360 dark) and keyboard

| id | surface | state | expected | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|
| EV-BR-{ready,capped,one}-{D,P,PD} | brief | BR-1 / BR-5 / BR-3 | no page h-scroll, nothing clipped, readable, no console error | 9 clean (full-width tile under 700 px of container) | pass | EV-BR-*.png | |
| EV-ST-{ready,capped,repofacts}-{D,P,PD} | State | ST-1 / ST-3 / ST-15 | same | 9 clean; at 360 the Repo TAB BAR scrolls inside itself (#186's header, not State) | pass | EV-ST-*.png | |
| EV-TH-{admin,member,malformed}-{D,P,PD} | themes | TH-1 / TH-2 / TH-12 | chart scrolls INSIDE its card at 360 | that; 0 page h-scroll | pass | EV-TH-*.png | |
| EV-FD-trov-{D,P,PD} | Feed | FD-1 + FD-10 | same | clean | pass | EV-FD-*.png | |
| EV-TC-chips-{D,P,PD} | ticket chips | TC-1 | chips wrap | clean | pass | EV-TC-*.png | |
| EV-UP-chip-{D,P,PD} | Unplaced | UP-1 | nothing clipped | the row mark's words were cut mid-quote, no ellipsis (360 and the desktop list pane) → now "…" (tooltip keeps all) | fail → fixed | EV-UP-chip-P.png → EV-UP-chip-P-after.png | 7bb27177 (`test/render.ai-cards.test.ts` › Unplaced…) |
| EV-RV-detail-{D,P,PD} | Review | RV-1 / RV-2 | same | clean | pass | EV-RV-*.png | |
| EV-RM-{lines,cards}-{D,P,PD} | Roadmap | RM-1 / RM-8 | same | clean | pass | EV-RM-*.png | |
| EV-*-K | all | keyboard only | every AI control a real button / link in the tab order, a focus ring, operable | all focusable with a ring (cites inside a CLOSED because… are `hidden` — right); lanes, range switch, Rename (Enter saves), Got it work — **but on the ticket detail, Unplaced and Planning, because… or a lane dropped focus to `<body>`** (page rebuilt): the disclosure could not be closed again, Tab restarted at the top → each now names a `data-field` the rerender restores | fail → fixed | kb runs | 8cfc42fc (`test/render.ai.test.ts` › … keep keyboard focus) |
| contrast | all | both themes | 4.5:1 | the sweep's flags were false positives (a 4 %-alpha hover tint taken as an opaque background); by hand: `--fg-55` on white ≈ 5:1, lane names `--fg` | pass | probe | |

### § 7 motion (owner's ruling)

| id | surface | expected | actual | result | fix |
|---|---|---|---|---|---|
| MO-16…19 | brief | entrance once; no replay on a rerender; Wrong? leaves by the kit's exit; nothing under RM | `cnpy-rise` ×12 on the tile at +150 ms, none after; palette rerender 0; Wrong? fixed (BR-10); RM 0, gone at once | pass after fix | 6c658685 |
| MO-20…23 | State | same; back from another tab State flashes with the panel (by design) | entrance 1; palette 0; back from Code one `cnpy-rise` (the documented flash); Wrong? `cnpy-ai-leave`; RM 0 | pass | |
| MO-24…27 | themes | same; lane / range never re-enter | lane 0; range: only the segmented slide; Accept / Rename / Remove: the chip's exit; Wrong? fixed (TH-16); RM 0 | pass after fix | 994dd1dd |
| MO-28…31 | Feed | same; Source switch flashes the list (by design) | entrance; palette 0; Source: the flash; Wrong? / Got it: `cnpy-ai-leave`; RM 0 | pass | |
| MO-32…35 | ticket / Unplaced / Review | with the screen; Accept re-reads without re-entering; Dismiss: the exit | the screen enters; chips land with the read's settle fade (read after the route's entrance — `syncSkeletons`); palette 0; Accept / Dismiss: `cnpy-ai-leave`, one re-read; RM 0 | pass | |
| MO-36…39 | Roadmap | same | entrance; palette 0; Accept: card exit then re-read; Wrong?: exit; RM 0 | pass | |

## Fixes (one bug, one test, one commit)

| case | what was wrong | cause | fix | test |
|---|---|---|---|---|
| BR-10 / MO-18 | Wrong? on the brief: the tile vanished, the bento jumped | `render.ts` dropped the brief at once; My Work never used `aiLeaving` | the tile leaves in its slot, then the other bento fades in | 6c658685 · `test/render.ai-motion.test.ts` |
| FD-4 | tooltip "Written by Trov from . Not official…" | `aiFeedTip` over an empty source list | "Written by Trov." | c303b3d9 · `test/render.ai.test.ts` |
| TH-16 / MO-26 | Wrong? on a range swapped the card at once | no leaving path in `themesSection` | written parts collapse inside the card, or the whole card | 994dd1dd · `test/render.ai-motion.test.ts` |
| RV-8 | no "Flagged in Ask" in Review | `listStagedProposals` / `listAdrs` dropped `askFlags`; nothing drew them | `attachAskFlags` + `askFlagsLine` | 376ffb1e · `test/render.review.test.ts` |
| TC-1 / TC-3 | "Suggested: null category"; Accept refused | the e2e SEED stored `value_json` as bare text | the seed stores JSON | 65d6b8db · `test/seed-server-ai-e2e.test.ts` |
| RM-8 | a good sprint draft never reached its admin | `roadmapLabel` TypeError on a non-list → the catch returned `[]` | a non-list is no sprints | a1ce308d · `test/ai.roadmap.test.ts` |
| EV-UP-chip-P | Unplaced row mark cut mid-quote | `flex:none` in a nowrap / hidden byline | it shrinks and ellipsizes | 7bb27177 · `test/render.ai-cards.test.ts` |
| EV-K | keyboard focus fell to `<body>` after because… / a lane | page rebuilt; focus restored only by `data-field` | `data-field` on both | 8cfc42fc · `test/render.ai.test.ts` |

## Final pass and what is left

- Final rerun from a clean seed (every script, reseeded between writers) on the build before RV-OWNER-1: BR, ST, FD,
  FI, TH (after making the scripts look themes up by name — their ids change per seed), TC / UP / RV, RV-8, RM, SG,
  WR, § 6 and § 7 — same results as above. th6 (TH-6's input sweep) failed in the rerun on a script locator, not
  re-investigated before the stop.
- **Left (the owner stopped all test runs, RULES § 9):** RV-OWNER-1 in the browser (desktop / 360, light / dark,
  keyboard reaching the avatar, before/after shots); TH-6 rerun; the full gate (`fulltest.sh`) at the final commit —
  NOT run. Render tests for every fix were run single-file while fixing, before the stop.

## Questions for the owner (spec silent or in conflict — not guessed)

- **Q-S1 (ST-15).** `repo-apps.md:307` and the smoke scope put State IN `<div data-repo-state-slot>` (the panel's
  first block, under Group by). It is its own card ABOVE Group by and the panel; the slot stays empty. The order on
  screen is right. Move it into the panel (it would need a block style — a card inside the panel's card is against
  the surfaces), or keep it and fix the doc? I'd keep it and fix the doc.
- **Q-S2 (FD-17).** The matrix expects "Wrong? NOT applied over MCP"; `feed-and-search.md:185` says `/feed` AND
  `get_feed` leave a flagged entry out, and the code does. The Roadmap's MCP reads do NOT apply it (RM-14);
  `get_repo_dashboard` does. One rule for every AI field over MCP?
- **Q-S3 (TH-4 / TH-5).** Accepting a proposed theme drops its lane from 1 merged PR to 0 (byline 10 → 9): a proposed
  lane counts its seed PRs, an active one only `pr_themes`, written later by the `theme_backfill` Batch job (never,
  keyless). Keep the seed PRs counted until the backfill lands? I'd expect yes.
- **Q-S4 (TH-10).** "Themes written by Trov from 0 pull requests" on a proposed-only org. Drop "from 0 …"?
- **Q29 extended (FD-14).** AI off: past Trov entries keep their styling — and the Source switch and the one-time
  note ("Trov now writes entries from your commits…", no longer true) still show. The note at least should not.
- **Q36 changed (TC-9 / TC-12).** A missing ticket → 409 `not_available` ("Not available yet"), a bad value → 400
  `invalid`; no 500s. The intended codes and words?
- Unchanged and met here: Q5, Q13, Q15, Q20 (words only), Q23, Q24, Q25, Q28, Q30, Q32, Q35, Q37, Q39, Q40.

## Pre-existing (recorded, not fixed)

- At 360 px Repo's tab bar is wider than the screen and scrolls inside itself (#186's header; no page h-scroll).
- Chromium's "geist-latin… preloaded but not used" console WARNING on some loads.

## Dropped here

- Matrix § 8 D-1…D-11 stand. Also: ST-16's Usage-tab wording (#186's own e2e; this run read the Overview's words);
  FD-8 has no fixture (Q27 open); RV-6 (Q38, preview id collision) seen only as "both marks drawn"; BR-20 (Q26) has no
  overdue fixture.
