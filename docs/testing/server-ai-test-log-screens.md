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
