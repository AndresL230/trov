# 10-17 batch: end-to-end browser test log

Branch `epic/10-17-batch` (c6415bdb, on `origin/epic/10-17-staging`) against base `origin/main` (17a530a4). One
worktree, ONE dev server (`wrangler dev` on :8851, inspector :9451), headless Chromium via Playwright scripts in
`/tmp/claude-1000/-home-andresl-Projects-trov/84b29fb1-e762-4297-bd67-750b9f852306/scratchpad/e2e-batch/` (not committed). Local D1 / R2 only; GitHub and the model
only through `scripts/dev/ask-github-stub.mjs` (`LOCAL_UPSTREAM`, fake keys). Dark mode is forced with the app's
stored `trov.theme`. A base-branch comparison stops the batch server and runs the base worktree
(`/tmp/claude-1000/-home-andresl-Projects-trov/70d25bd4-13a0-4b2f-ba96-193a2f49f660/scratchpad/e2e-base`, detached at 17a530a4) on the SAME port, never both at once.

**Status: STOPPED AFTER STEP 1 (the matrix).** The combined matrix is 318 cases, over the prompt's 150: it waits for
the owner's pick (below). The unit suite and typecheck ran first; nothing in the browser has run yet.

## The batch

`git log --first-parent origin/epic/10-17-staging..HEAD`:

| Feature | Merge / commit | Spec source (the "source" column) | Per-feature log |
| --- | --- | --- | --- |
| P: prompt-card copy slug | ced22c8c (feat/prompt-card-copy-slug) | **P-O**: "In the top left of the prompt card there should be a copy slug button…"; the hover "doesn't turn the mouse into the select state…" | `docs/testing/prompt-card-copy-slug-test-log.md` (60 cases, all passed on its branch): here a smoke subset |
| A: artifact inspector width | 0fb3cbef (fix/artifact-sidebar-width) | **A-O**: "When we open an artifact screen sidebar it should open less wide" = Ask's inspector showing an artifact, not ⌘J. **A-B**: until dragged, opens at the shown item's width (artifact 400, else 480; min 380); once dragged (pointer or ←/→) that width holds for every kind until reload; phone with no sideways scroll; main content reflows; reduced motion | `/home/andresl/Projects/trov-artifact-sidebar/docs/testing/artifact-inspector-width-test-log.md` (55-case design, never run; reused below) |
| D: dark accent purple | d90d7285 (fix/dark-accent-purple) | **D-O**: "making the dark mode accent color the same purple instead of that green". **D-B**: every accent use (buttons, links, focus rings, active sidebar item, selected states, public pages, logo / favicon) goes purple — the light purple if readable, else a lighter one meeting WCAG AA; meaningful greens (done, passing CI, live, diff additions) stay green | none before this one |
| L: big-screen layout | 45903bfc (fix/large-screen-layout) | `/home/andresl/Projects/trov/.claude/worktrees/agent-a74d1640b960cda2e/docs/testing/large-screen-layout-test-log.md` (spec, surfaces S1–S37, interactions I1–I8); **the owner picked option A (148 cases)** | that file |
| Z: 4K scaling | 942c5cb4 (fix/4k-scaling, ad75bc8e) | **Z-O**: past ~3000px Trov enlarges itself gradually to ~1.3× at 3840, capped, in one place; ships only if dropdowns, popovers, `data-mtip` tooltips, board drag-and-drop (incl. the ghost), centred modals, Ask's inspector edge drag (1:1), quick search and the sync menu land correctly and nothing scrolls sideways; ≤3000px unchanged. **Z-D**: `docs/architecture/web-ui.md` › Big screens › The big-screen zoom; `web/src/zoom.ts` | none before this one |
| G: Ask's GitHub lookups | a956703d (feat/ask-github-tools) | **G-O**: read-only GitHub reads of connected repositories (files, PRs and changes, issues, commits, checks); each person's OWN access (collaborator-permission check on their linked login); admin switch Org settings › AI, `orgs.ai_chat_github`, default OFF, stacked on the AI switch; legal wording approved (2026-10-17); shared conversation: a reader never triggers lookups, a continuer is checked as themselves. **G-D**: `docs/architecture/ask.md` › GitHub (read-only) | none before this one |
| R: the release entry | 6d864dcc, c6415bdb | What's new 0.12: one entry, every batch line ending (#195) | — |

Also cited: **CL** = CLAUDE.md's rules (no horizontal scroll, marks, keyboard, reduced motion, invariant 7), **code** =
behaviour on base the batch must keep.

## Baseline

### Unit suite and typecheck (step 1 of the brief; no server running)

| | batch `epic/10-17-batch` (c6415bdb) |
| --- | --- |
| `npm ci` | ok (install scripts not run by npm 12's policy; the `workerd` / `esbuild` binaries come from their optional packages and work) |
| `npm test` | **pass: 396 files, 8652 tests, 0 failed** (326 s). The known `test/ai.brief.test.ts` › "a number the input does not have drops the line" did NOT fail in this run. No snapshot or string drift: the merges' hand-edited `.snap` files and `site-pages.test.ts` hold. |
| `npm run typecheck` | **pass** (worker + web) |

No fix commits were needed for the suite.

### Found by reading code before any browser run (to confirm in the browser on base in step 3)

- **Drag ghost one viewport below the pointer (Z's fix): PRE-EXISTING on main.** `origin/main:web/src/trov.css`
  has `.cnpy-tghost { position:fixed; … }` at line 1157 and `.cnpy-hitbox { position:relative; }` at line 1216 (same
  specificity, later wins); `startBoardDrag` (`origin/main:web/src/main.ts` 4654) clones the card, which carries
  `HITBOX` (`tickets.ts` 474), so the ghost is `position:relative`. Fixed in the batch by ad75bc8e (`!important`).
- **Sync-menu crash `reading 'startsWith'` (reported by the 4K builder): PRE-EXISTING on main, not fixed.**
  `shared/sync.ts` (unchanged from main) calls `f.code.startsWith("reconcile:")` in `syncFailureText` (227) and
  `syncFailureTab` (332). The server always writes a `code` (`src/sync/runs.ts` 243–261), but the dev seed's
  `scripts/seed/team-rich.mjs` (main 611, batch 614) stores a partial run with `failures: [{ step, detail }]` — no
  `code` — so opening the sync menu on the `team` seed throws. A malformed stored row, reachable only from the dev
  seed today; recorded, to be shown in the browser on base as case Z32.

### Still to take (step 3, after the owner's pick)

Base suite in the base worktree; base screenshots and console of each pre-existing surface with the same seed; any
console error or failed request on first load.

## Seeds

Existing, run on top of `npm run seed` (all local-only, idempotent):
`scripts/seed/prompt-card-copy-slug.mjs`, `scripts/seed/artifact-inspector-width.mjs`,
`scripts/seed/dark-accent-purple.mjs`, `scripts/seed/ask-github.mjs` (`--github on|off`, `--ai on|off`). The
big-screen and 4K blocks use the dev seed's `team` (SaplingLearn) and `dayone` (Day One Labs) scenarios. A combined
`scripts/seed/10-17-batch.mjs` (all of them in order, then a check query per fixture) will be written in step 2.

## 1. Map

### Surfaces

- **P** Prompt Library cards (the copy button, the card's cursor).
- **A** Ask screen inspector (`#ask/<id>`), the ⌘J panel's inspector, the Artifacts screens (regression).
- **D** every accent use: primary button, link, focus ring, active sidebar item, `segmented()` / `tabBar()` selected,
  switch on, `::selection`, the thinking orb's ink, the sidebar mark, the favicon; the first-run / org-picker banner;
  the site (landing banner + CTA, pricing top plan, legal tabs, public docs, sign-in dialog); the greens that must
  stay (done mark, passing CI, live environment, diff additions, the moss avatar colour).
- **L** S1–S37 and I1–I8 of the big-screen log.
- **Z** `<html>` zoom (boot + resize), every rect → style site listed in web-ui.md, the site's scroll-lock, framed
  artifacts.
- **G** Org settings › AI (the new row), `PUT /ai/settings { chatGithub }`, `POST /ask` turns through the stand-in
  (seven tools, the access check, the bounds), shared conversations, Settings › Trov's "What Trov can see", the
  Privacy Policy / Terms passages.
- **R** Help › What's new (index, 0.12 page).

### Dimensions (from the code)

- **P**: pointer vs keyboard; role (owner, member); theme; phone. (Prompt states were covered by its own 60 cases.)
- **A**: the shown ref's kind (7 artifact kinds, ticket, PR, doc, sprint, person, a conversation block); the
  artifact's state (org, private-mine, long unicode title, deleted, someone else's private); the detail read (ok,
  slow, failed); navigation (open, push another, Back, close + reopen, reload); width (not dragged, pointer drag,
  ←/→, past max, past min); viewport (1440, 1400, 1000, 800, 360); theme; motion; role.
- **D**: the theme state (`trov.theme` dark; `system` + OS dark; nothing stored + OS dark; light); who is looking
  (signed out → site; owner; member; signed-in with no org → the bannered picker; a lost slug); phone.
- **L**: as its log: width, rail, theme, screen sub-state, async, data, role.
- **Z**: window width (≤3000 none; 3420 ≈1.15; 3840 = 1.3; 5120×1440 capped at 1.3) and height (3840×1080 → 1.2 by the
  900px floor); boot vs live resize across 3000; the app vs a prerendered site page; each rect → style site.
- **G**: the org AI switch × the lookups switch × repos connected; the person's GitHub standing (read, none, check
  500, check slow, not linked); mode (Fast vs Smart / Thinking); the tool and its input (each tool; second repo;
  another org's repo; a dot-segment path; a big file; >10 requests); role (admin, member) for the switch; shared
  thread (reader, continuer with or without access); Stop mid-lookup.

### The combined matrix and its count

| Block | Cases | What runs (each id written out in the rows when the run starts) |
| --- | --- | --- |
| **P** prompt-card smoke | **8** | P01 click copies the slug to the clipboard and confirms; P02 the copy does not open the prompt (hash unchanged); P03 `cursor:pointer` over the card body and the button; P04 keyboard: Tab reaches the button, Enter copies, Enter on the card opens it; P05 dark; P06 phone 390, no sideways scroll; P07 member (meilin); P08 at 3840 (zoomed) the button's `data-mtip` sits on it |
| **A** artifact inspector | **53** | the 55-case design minus its two release-entry rows (moved to R). S1 Ask inspector 45: each of 13 kinds' opening width (13); private-mine, long unicode title, deleted, someone else's private (4); slow and failed detail read (2); push artifact→ticket, ticket→artifact, Back, close + reopen, reload, switch thread (6); pointer drag then another kind, ←/→, past max, past min, dragged width after reload (5) + drag on the ticket (1); 1440, 1400, 1000, 800, 360 on the artifact and 360 on a ticket (6); dark × artifact / ticket (2); reduced motion × artifact / ticket (2); keyboard only × artifact / ticket (2); member × artifact / ticket (2). S2 ⌘J panel 6: unchanged width over an artifact page, a ticket from the panel, a drag, phone, dark, reduced motion. S3 Artifacts screens 2: an artifact's page and the list, unchanged |
| **D** dark accent | **36** | stored dark, owner / signed out: the 24 accent and green surfaces above, each with its measured colour and contrast (24); `system` + OS dark on the app and the site (2); nothing stored + OS dark on the app and the site (2); light regression (accent still #525cc3) on button, link, focus ring, active sidebar item, site banner, favicon (6); phone 390 dark: the landing page, the app's drawer (2). The member, the no-org person and the lost slug are inside the 24 (the picker banner, the moss avatar) |
| **L** big screens, option A | **148** | S1–S33 × {1440, 2560, 3840, 390} light (132) + dark at 2560 on S1, S2, S4, S9, S15, S18, S22, S30 (8) + I1–I8 at 3840 (8). Note: since the batch adds Z, every 3840 case runs ZOOMED at 1.3 — the frames are measured in CSS px |
| **Z** 4K zoom | **36** | Z01 none at 3000 (no `zoom`, no `--vu`, `--vw` = 1vw) and Z02 at 2560 / 1440 the same; Z03 3420 ≈ 1.15; Z04 3840 = 1.3; Z05 5120×1440 = 1.3 (cap); Z06 3840×1080 = 1.2 (height floor); Z07 live resize 2560↔3840 (applies / clears, no transition plays); Z08 a prerendered site page paints zoomed from the first frame (`ZOOM_BOOT`); Z09 a `dropdown()` under its trigger; Z10 a dropdown at the right edge flips inside; Z11 a `data-mtip` bubble on its anchor; Z12 the collapsed rail's tooltips; Z13 quick search ⌘K anchored + its height glide; Z14 the sync menu opens at its trigger; Z15 the board drag ghost under the pointer; Z16 a drag that DROPS into another column (status row written) — builder did not verify; Z17 a reorder within a column (slot FLIP + settle, saved order); Z18 a `confirmModal` centred; Z19 Ask's inspector edge drag 1:1 with the pointer; Z20 Ask's hover card on a chip; Z21 Ask's layout width / composer glide; Z22 the ticket comment box's grip; Z23 docs / Guide heading spy and jump; Z24 legal heading spy and jump; Z25 the pricing FAQ accordion; Z26 the site menu's scroll-lock (no shift) — not verified; Z27 the tour dialog's scroll-lock — not verified; Z28 a framed HTML artifact at 4K (not double-scaled, no sideways scroll) — not verified; Z29 an image / PDF artifact at 4K; Z30 a header filter menu (Feed); Z31 a person card popover; Z32 the sync menu on the `team` seed (the `startsWith` crash, on base too); Z33 the ⌘J panel at 4K; Z34 reduced motion at 4K; Z35 dark at 4K; Z36 the drag ghost at 1440 (the ghost fix, every size) |
| **G** Ask GitHub | **34** | G01 the row is OFF by default (admin); G02 admin turns it on (flash, `data-ai-chat-github="on"`, `orgs.ai_chat_github` = 1, audit `org.ai_chat_github`); G03 off again; G04 member sees it read-only; G05 member `PUT` → 403; G06 org AI switch off with lookups on → nothing reaches GitHub; G07 lookups off with repos → no github_ tool offered, the context says an admin can turn them on, no GitHub request; G08 reader `github_read` (access check, then the read, with the fake credential); G09 `github_pull_request` with files; G10 `github_issue`; G11 `github_commit`; G12 `github_list` pulls; G13 `github_ci`; G14 `github_search_code` (qualifiers stripped, `repo:` added); G15 the second repo by name; G16 another org's repo → `not_connected`, no request; G17 a `..` path refused, no request; G18 a big file truncated ("Truncated"); G19 no access → "No access on GitHub", no content request; G20 the check answers 500 → denied; G21 the check is slow → denied (timeout); G22 not linked → "GitHub not linked", no request at all; G23 Fast mode → no github_ tool; G24 more than 10 requests → `limit`; G25 a shared reader opens the thread → no request, cannot send; G26 a continuer without access → checked as themselves, denied though the owner was allowed; G27 a continuer with access → allowed; G28 Stop during a slow lookup; G29 Settings › Trov's "What Trov can see" line; G30 the Privacy Policy / Terms passages and their 2026-10-17 date; G31 the row in dark and at 390; G32 an org with no connected repo → no tool, no "off" note; G33 the switch by keyboard; G34 the stand-in's log: only GETs, only api.github.com paths under the repo, the fake token |
| **R** release entry | **3** | R01 What's new lists 0.12 with every batch line ending (#195); R02 the 0.12 page renders, the Help badge points at it; R03 the same in dark |
| **Total** | **318** | |

Dropped as impossible or redundant (one line each):
- A: every kind × viewport / theme / motion — the width rule reads only the ref's type and the dragged width; AI
  switch off / missing key — Ask is unreachable, no inspector; signed out / another org — unreachable; forward
  navigation — the inspector has Back only; text input — the change takes none.
- D: input, plan, role beyond who-is-looking — the change is colour only; the email (only a comment changed in
  `assemble.ts`).
- L: as its log (the collapsed rail at phone width; overlay scrollbars untestable headless).
- Z: phone and every width ≤3000 except the boundary checks — nothing is written there (Z01, Z02) and L covers
  those widths; the rail collapsed at 4K beyond Z12.
- G: model-side wording beyond the step line — the stand-in is scripted; real GitHub rate limiting (`rate_limited`)
  — the stand-in has no such reply, covered by `test/ask.github.test.ts`.

**318 > 150: stopped here.** Two plans for the owner:

| Plan | What runs | Count |
| --- | --- | --- |
| **Recommended: the whole matrix (318)** | All of the above. Option A alone is 148, so any plan that keeps the owner's pick is over 150; the other blocks are what each spec names as its ship condition (Z's list is the owner's own ship-or-not list; G's access rules are a privacy promise). Run order: suite already green → Z and L at 3840 first (the 4K ship decision) → G → A → D → P → R; one server, one Chromium, pages closed as I go. | **318** |
| Smaller alternative | L at option C (72, instead of A) + Z's ship conditions only: Z01, Z04–Z07, Z09–Z11, Z13–Z20, Z26–Z28, Z32 (20) + G's access and switch rules: G01, G02, G04–G08, G16, G19, G20, G22, G25, G26, G34 (14) + A: the 13 kinds' widths, pointer drag + ←/→, reload, 360, dark, reduced motion (19) + D: the 24 surfaces collapsed to 14 (button, link, focus ring, sidebar, segmented, tab bar, favicon, picker banner, landing banner, pricing CTA, legal tab, done mark, passing CI, diff additions) + P01–P04 (4) + R01 (1) | **144** |

## Cases

Not run yet: waiting for the owner's pick of plan.
