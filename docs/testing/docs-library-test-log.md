# Docs Library — end-to-end browser test log

Feature: the Docs Library (handoff #16) — spaces, the page tree and doc page, Markdown import — on `feat/docs-import`
(three stacked PRs: `feat/docs-spaces` → `feat/docs-tree` → `feat/docs-import`; base `origin/main` 17a530a4; tested at
bc4b684c + this log's commit). Spec: the Prompt Library prompt `docs-library-build` (handoff #16's build prompt), the
build brief's decisions, and the design spec from the Claude Design prototype (its §12 and §14 list what the design
leaves open — those are `question`s here, not guesses). Area reference: `docs/architecture/docs-library.md`.

**Phase 1 (c3bcf618): the map, the seed, the baseline and the matrix.** The owner then trimmed the matrix to 119 cases
and decided the 20 questions (below, Matrix). **Batch A** (the owner rulings in code; Sidebar, Library home, Create
space, Space home, Docs pane, Tree moves, Doc page, New page) and **Batch B** (Import wizard, Drop, Imports history,
Review, Unplaced, the curl set, Environment) are filled in below; **Batch B2** (the owner's round-2 rulings: Review's
agent group and page pane built, SH2, RV18, the IW counts, and Batch B's findings fixed) after them; then **Batch C**,
the final pass over all 119 from a clean seed, and the **Report**.

## Local environment

- Branch: `wrangler dev --port 8821 --ip 127.0.0.1 --test-scheduled --var NOTIFICATIONS_MODE:local --var
  PUBLIC_ORIGIN:http://localhost:8821` in `~/Projects/trov-docs-library`, beside `npm run watch:web` (the two halves of
  `npm run dev`; `build:web` and `scripts/dev/ensure-seeded.mjs` ran first). Base: the same on :8822 in a temporary
  worktree of `origin/main` (removed after the baseline). Local D1 only; nothing is ever `--remote`.
- **`.dev.vars` holds dummy values only** (`COOKIE_SECRET`, `TROV_KEK`, `DEV_LOGIN=AndresL230`, unused GitHub stand-ins).
  The worktree's own copy carried LIVE keys (a live Stripe key, Anthropic, Gemini, TypeSafe, Google, Vercel, Netlify);
  it was set aside OUTSIDE the repo for the test and must be restored by the owner when done (see the report). With no
  key: no AI, no mail (`NOTIFICATIONS_MODE=local`), no billing — none of it is a Docs Library surface.
- Browser: Claude in Chrome, one tab of its own. Phone width is a 360 px iframe of the same page (the automation window
  cannot be resized below the desktop); the theme is `localStorage["trov.theme"]` (`light` / `dark`) and a reload.
- Signing in: `http://127.0.0.1:8821/auth/dev/as?handle=<handle>` (a real session cookie; `docs/architecture/local-dev.md`),
  `/auth/dev/out` to go back to `DEV_LOGIN`. Signed out (API1–2) needs a restart with no `DEV_LOGIN`.
- MCP: `POST http://127.0.0.1:8821/mcp` with the seed's local test bearer tokens (header of `scripts/seed/docs-library.mjs`).
- The cron backfill (CR): `curl "http://127.0.0.1:8821/__scheduled?cron=0+*+*+*+*"` (the daily job's expression; local
  mail mode, so no mail leaves).

## Seed

`node scripts/seed/docs-library.mjs` (in the worktree whose `wrangler dev` you browse; the server may stay up). It wipes
and rewrites FOUR orgs of its own — `test-docs` (main), `test-docs-one` (one space + a running import),
`test-docs-nospaces` (no space), `test-docs-other` (another org) — so SaplingLearn and the dev scenarios are untouched;
regenerates the import fixtures in `scripts/seed/fixtures/docs-library/` (25 files: zips valid / damaged / encrypted /
unsupported / over 500 files / exactly 500 / over 50 MB / no Markdown / traversal / too deep / a page over 1 MB / images
incl. a fake and an 11 MB one / duplicates / stored; loose .md incl. empty, not UTF-8, HTML injection, a title conflict;
a .txt and a .pdf); resets the doc-links backfill cursor; then reads every fixture back (34 checks). `--list` prints the
named fixtures, `--check` only reads back, `--files` only writes the files. Re-run it before a session and after every
case that writes.

People (all made up, example.com): `test-dl-admin` Ada Test-Admin (owner of test-docs / -one / -nospaces = the admin
role), `test-dl-member` Max Test-Member (member), `test-dl-spaceowner` Olu Test-Owner (member, OWNER of Engineering and
Design), `test-dl-agentuser` Pia Test-Agent (member; the agent proposals are hers), `test-dl-outsider` Otto Test-Outsider
(member of test-docs-other only).

Run 2026-10-17 against the branch's local D1: all 34 checks hold (twice in a row — idempotent).

## Baseline

**Tests.**
- Branch (`feat/docs-import` bc4b684c): `npm run typecheck` 0 errors. `npm test`: 403 files, 8816 tests — **1 failed**
  (`test/ai.brief.test.ts` › "the job: one Haiku call, only what the input says › a number the input does not have drops
  the line (and a why); over-length is dropped, never cut" — the known pre-existing failure), 8815 passed.
- Base (`origin/main` 17a530a4, temporary worktree): `npm run typecheck` 0 errors. `npm test`: 390 files, 8573 tests —
  **1 failed**, the same `test/ai.brief.test.ts` case; 8572 passed. Nothing fails on the branch that passes on base.

**Surfaces that existed before, on base, with the base's equivalent seed** (the dev scenarios — `team` / SaplingLearn —
which on base hold the docs in `technical` / `product`; the docs-library seed cannot load on base: its tables do not
exist there). Screenshots in `docs/testing/docs-library-shots/base/`:

| id | surface | state | what it shows | console / network |
|---|---|---|---|---|
| B01 | old Docs screen `#docs` + sidebar (Docs › Technical / Product) | AndresL230 owner, desktop, light | the Technical tree in the docs column, Architecture open with "You're viewing the promoted version. A newer proposal is awaiting review.", Version history, Tags | no console error; every `/api/` request 200 |
| B02 | Review `#review` | same | All 9 · Proposals 5 · Decisions 4; a proposal open with its diff; Reject / Promote | no console error; all 200 |
| B03 | New doc `#docs/new` | same | Title, Body (markdown), Space Technical/Product, Section reference/context/decisions, Summary, "Stage for review" | no console error; all 200 |
| B04 | Unplaced `#unplaced` | same | 11 items; "File it as: Doc section / Decision record / Feed update" | no console error; all 200 |
| B05 | old Docs screen | AndresL230, 360 px iframe, dark | "Technical pages" button, the page column; no horizontal scroll (scrollWidth 359 = clientWidth) | no console error |
| B06 | old Docs screen + sidebar | meilin (member), desktop, light | same as B01 for a member (no admin-only control on this screen) | no console error |

Files: `B01-docs-technical-admin.jpg`, `B02-review-admin.jpg`, `B03-new-doc-admin.jpg`, `B04-unplaced-admin.jpg`,
`B05-docs-phone-dark.png`, `B06-docs-member-sidebar.jpg`.

**Console errors / failed requests before touching anything:** none on base (Docs, Review, New doc, Unplaced, My Work —
every request 200, no console error). Branch smoke (setup check only, not a case): `/test-docs/#library` as
test-dl-admin renders, no console error, every `/api/` request 200
(`docs-library-shots/branch/S00-setup-smoke-library-admin.jpg`, taken before the people were renamed).
Base note: `#docs/product` as a member landed on My Work on base (not a route there) — recorded, not a Docs Library case.

## Map

**Surfaces** (from `git diff --stat origin/main...HEAD`: 143 files, +12 608 / −1 111).

| surface | where | code |
|---|---|---|
| App sidebar › Library group | every screen | `web/src/sidebar.ts`, `render.ts` |
| Library home | `#library` | `web/src/library.ts`, `library-actions.ts` |
| Create space / Edit space modal, Edit owners dialog, Archive confirm | over Library / Space home | same |
| Space home (5 tabs, description in place) | `#library/<space>` | same |
| Docs pane (page tree) + drag / keyboard moves | beside Space home, doc page, New page | `docs-pane.ts`, `tree-drag.ts`, `tree-actions.ts`, `pointer-drag.ts` |
| Doc page | `#doc/<slug>` | `doc-page.ts`, `docs-content.ts` |
| New page + templates + location picker | `#docs/new` | `newdoc.ts`, `newdoc-actions.ts`, `shared/docs-templates-core.ts` |
| Import wizard (Where, Files, Preview, Progress, Done) | `#import[/<space>]` | `import.ts`, `import-actions.ts`, `zip-reader.ts`, `shared/docs-import-core.ts` |
| Drop to import (overlay, sidebar rows) | space / doc / New page, sidebar rows | `import-drop.ts` |
| Imports history | `#imports` | `import.ts` |
| Review grouped by import, Approve all / Reject all | `#review` | `review.ts` |
| Unplaced › assign (space picker) | `#unplaced` | `maintenance.ts`, `triage-map.ts`, `src/tools/writes.ts` |
| Old routes, quick search, My Work, Feed / triage links, landing mocks, What's new | various | `hash.ts`, `quicksearch.ts`, `mywork.ts`, `landing*.ts`, `releases.ts` |
| HTTP: `/spaces…`, `/imports…`, `/doc/:slug/move`, `/doc/:slug` (page read), `/docs/propose`, `/proposals`, `/search`, `/needs-triage/:id/assign`, `/badges` | tenant API | `src/spaces/routes.ts`, `src/imports/routes.ts`, `src/routes.ts`, `src/tools/*` |
| MCP: `list_spaces` (new), `list_docs` / `query` space filter, `propose_doc_update` space + `parent_slug`, `get_doc` | `/mcp` | `src/mcp.ts`, `src/consumer.ts` |
| The gate (`ingestDocProposal`: space aliases, unknown / archived → triage, parent_slug, import tags) | — | `src/consumer.ts` |
| Cron: doc_links backfill (daily) | `scheduled()` | `src/platform/doc-links-backfill.ts` |
| Migrations 0081 / 0082 | — | (covered through the surfaces; the migration test holds its claims) |

No email is added or changed by this feature.

**Dimensions** (from the code's guards):
- **who**: admin (org owner/admin — `requireRole(ctx,"admin")`), member, space owner (`doc_space_owners`), another org's
  member, signed out; a bearer token (cookie-only routes).
- **spaces**: none / one / many (> 4: the picker becomes a dropdown) / archived / archived with a live namesake.
- **tree**: empty / deep (10 levels, the max) / long titles / unranked siblings / orphan / stored loop / cross-space parent.
- **page states**: live / pending (change waiting) / staged (never approved) / imported staged / broken links / backlinks /
  links in code / unbackfilled links / HTML injection / unicode.
- **imports**: none / running (lock) / running-but-stale / done / partial / failed / abandoned (cancelled).
- **zip / files**: valid / damaged / encrypted / unsupported method / > 500 files / = 500 / > 50 MB / no Markdown /
  traversal / too deep / page > 1 MB / images (ok, fake, > 10 MB) / duplicates / not UTF-8 / empty / stored / loose files /
  a title conflict (skip / version / rename, per item and for all).
- **async**: loading (a delayed `fetch`), read failure (503), network failure mid-import, retry, double submit, reload
  mid-run, rate limit.
- **environment**: desktop and 360 px, light and dark, keyboard only, reduced motion.

## Matrix

Count: **353 cases** (over 150 — shown to the owner before running). 20 are `question` before running anything.

| group | surface | dimensions crossed | cases |
|---|---|---|---|
| SB | App sidebar › Library group | role admin/member; spaces none/one/many/archived; badges; active states; long names; stable DOM | 13 |
| LH | Library home | admin/member; populated/empty/loading/503; archived + restore (ok / name taken); long name | 14 |
| CS | Create space modal | entry points; valid / duplicate / archived name / blank / limits / HTML+emoji / double submit / cancel | 13 |
| SH | Space home | 5 tabs; description in place (admin / owner / member; enter / esc / blur / clear / injection); owners; edit / reorder / archive; empty / loading / unknown / archived; many pages | 25 |
| DP | Docs pane | head / rows / indent / guides / tooltip / chevrons / hover actions / More; forgiving tree; order; empty / loading; where it shows; who sees staged | 15 |
| TM | Tree moves | before / after / into / top; undo; self / descendant / too deep (2 ways); click vs drag; Escape; member; keyboard; unranked list; archived; server refusal | 14 |
| DOC | Doc page | live / pending / staged (agent) / staged (imported); history; rail; links good / label / broken / code / cross-space / archived; hover card; children; copy; injection; unicode; unknown; other org; deep breadcrumb; loading; when() | 26 |
| NP | New page | entry points; picker (1 space / many / archived); templates; preview; placeholder; section; create (staged, parent, collision, invalid parent, Blank, double submit, member); handoff promote; no spaces | 20 |
| IW | Import wizard | the 4 steps + progress + done; every zip / file fixture; conflicts per item and for all; parent; lock / stale / rate limit; cancel / leave / reload / network failure; double submit; DB after | 52 |
| DR | Drop to import | main column / sidebar row × good / bad / one / many; doc page + New page; non-targets | 11 |
| IH | Imports history | each status; filter; expand per status; cancel (starter / admin); empty / loading; polling; other org; When | 17 |
| RV | Review grouped | groups; filter; one by one; diff; decide / undo / auto-advance; Approve all / Reject all (confirm, cancel, agent copy); member; empty / loading; ADR drafts; promote with parent; links on promote | 26 |
| TR | Unplaced › assign | unknown / archived space; regression on the team org | 4 |
| API | HTTP routes | signed out; other org; member vs admin vs owner; bearer on cookie-only routes; validation; aliases; import re-validation; move refusals | 32 |
| MCP | MCP tools | list_spaces; filters; propose (unknown / archived / none / alias / parent valid / invalid / existing); get_doc; other org; no write tools | 13 |
| CR | doc_links backfill cron | first run / rerun / backlinks after | 3 |
| RT | Routes and touched screens | old routes; deep link; quick search; My Work; Feed / triage links; landing; What's new; preview=empty | 10 |
| ENV | Each screen × environment | 15 screens × {360 px dark, desktop dark} + 14 × keyboard only + reduced motion | 45 |

**Dropped combinations (cannot occur, or add nothing a kept case does not):**
- Phone 360 px in LIGHT theme for each screen: the layout does not depend on the theme; 360 px is run in dark (both the
  layout and the dark tokens in one shot) and desktop dark covers the theme at width.
- Every data state × every viewport / theme: layout depends on the screen, not the fixture beyond populated / empty /
  loading, which ENV covers per screen.
- A pure `admin` (not owner) role × every case: `requireRole(ctx,"admin")` treats owner and admin alike (admin+); the
  admin-only cases run as the org owner.
- Keyboard at 360 px: keyboard reachability does not change with width. Keyboard on the docs pane: TM11 covers it.
- Reduced motion beyond one check: Claude in Chrome cannot emulate `prefers-reduced-motion` (no CDP emulation); ENV45
  reads the shipped stylesheet's reduced-motion block in the browser instead.
- Drag and drop on a phone: there is no file drag on a touch screen, and tree drag at 360 px is not in the design.
- Another org's member × each write: the tenant gate refuses before any route runs (API3–4, API5, API29, MCP11 cover
  reads, writes and MCP); repeating it per route adds nothing.
- Ask Trov's `list_spaces` / space parity: needs a model key, and this test uses no real key.
- Plan limits: the brief adds no per-org plan limit (`plans.md`); there is no plan dimension.
- Signed out × every screen: the session gate answers before any Library code (API1–2).

**Questions (expected not specified — the owner decides):** SB12, SH4, SH6, SH14, DP8, DP14, DOC2, DOC3, DOC13, NP9,
NP19, IW5, IW10, IW23, IW51, DR10, IH7, IH8, IH12, RV3. Each row says what I would expect and why.
**Decided 2026-10-17:** the owner accepted the defaults; each of the 20 rows' `expected` is rewritten with source
"owner ruling 2026-10-17" (the original question text is in this file's history at c3bcf618).

**Trimmed 2026-10-17 (owner: "do we seriously need to run all 353").** 119 cases are kept; the other 234 rows stay in
the log with result `skipped` and "trimmed by owner 2026-10-17". Kept: SB1 2 5 7 11 12 · LH1 2 7 8 10 · CS1 3 5 9 ·
SH1 2 4 6 8 11 14 17 21 23 · DP1 5 8 9 14 · TM1 2 4 6 11 · DOC1 2 3 7 9 12 13 14 18 20 · NP1 5 6 9 11 15 17 19 ·
IW1 5 9 10 12 13 17 18 19 21 22 23 25 26 30 31 35 39 51 · DR3 5 10 · IH1 3 7 8 12 · RV1 3 5 6 7 10 12 14 18 · TR2 ·
API4 6 8 10 22 29 · MCP1 4 · CR1 · RT2 · ENV4 5 10 11 12 13 14 21 22 24 25 27 28 29 39 40 42 43 45 (one 360 px dark
pass and one desktop dark pass over the 8 main screens, keyboard on the wizard and Create space — the tree's keyboard
is TM11 — and the reduced-motion read). The vitest suite pins what the trimmed HTTP / MCP rows covered.

## Batch A (2026-10-17)

Run against `wrangler dev` :8821 on `feat/docs-import` (from f953a4d6), Claude in Chrome (one tab, desktop 1728 px CSS,
light), re-seeded after every case that wrote. Screenshots: `docs-library-shots/batch-a/`.

**Cases run: 53** (SB 6, LH 5, CS 4, SH 10, DP 5, TM 5, DOC 10, NP 8) — **pass 41** (SB5 among them: it passes once
RV3's fix landed), **fail → fixed 11** (SB1, LH8, CS1, SH6, SH23, DP8, DP14, DOC2, DOC13, NP9, NP19), **still failing 1** (SH2:
the design's page description on the cards — a doc has no description field; needs the owner). Pre-existing (not
fixed): every toast carries the accent check, errors included (`app-root.ts` `toastBlock`, as on base — seen on LH8);
the Review badge counts staged versions, so two agent versions of one page count twice (base's count).

**The owner rulings in code** (each its own commit, a test that failed first, a browser retest): SH6 d93ed284, DP14 +
DOC13 a9674f0b (one line of copy), DOC2 cfc1f153, DP8 5ddeffd9, NP9 b5a97f2e, NP19 27f64817, IW51 9dfa8638, IH12
47f18886, RV3 796ad957, DR10 9bacbd2d. Already as ruled (checked in the browser, no code): SH4, SH14, DOC3, SB12, IW5,
IW10, IH7, IH8. IW23's copy is already the ruled one in `import-actions.ts` `cancel()`; Batch B runs it (a live run).
Batch A's other fixes: SB1 a78d7afd, LH8 c4c61170, CS1 a1287563, SH23 76714599; the seed c79dbee7 (IH12's retest: a
seeded run's stored plan had no `writes`, so finishing it answered 500 — a seed defect, not the product's; the seed's
read-back now checks it, 35 checks). Area doc: 3caacae6. Touched test files (12) + typecheck green after the last fix.

## Batch B (2026-10-17)

Run against `wrangler dev` :8821 on `feat/docs-import` (from c19bdcfe), Claude in Chrome (one tab, desktop 1707 px CSS,
light; dark via `localStorage["trov.theme"]`; 360 px = a borderless 360 px iframe of the same page inside the tab),
re-seeded after every case that wrote. The curl set ran with `curl` against :8821 (sessions from `/auth/dev/as`, the
seed's member bearer on `/mcp`, the daily cron through `/__scheduled`). Fixtures were uploaded from a copy in the
session's scratchpad (the browser tool reads only there). Screenshots: `docs-library-shots/batch-b/`.

**Cases run: 58** (IW 16, DR 2, IH 2, RV 8, TR 1, API 6, MCP 2, CR 1, RT 1, ENV 19) — **pass 48**, **fail → fixed 4**
(CR1, ENV12, ENV13, ENV39), **still failing 4 — for the owner** (RV1, RV5, RV6, RV7: Review's agent group card and
its page pane as designed are not built; RV1's layout half is fixed), **question 2** (IW12, RV18). No new
pre-existing bug.

**Fixes** (each with a test that failed first, the browser retest, and the cases on the same path):
- CR1 cd0501f3 (import) — the doc_links backfill charged a full 50-page take per org even with nothing to read, so a
  daily run read at most six orgs; it charges the pages read now, with its queries bounded on their own (60).
  `test/docs-import.test.ts`.
- RV1 fec5b340 (import) — a Review row's grid box took its card's min-content width: the import group card was 17 px
  wider than the list, which scrolled sideways. `.cnpy-rv-row-in { min-width:0 }` (every Review row and the tag
  review rows). `test/render.review.test.ts`. ENV43 passes on it.
- ENV12 ede930a5 (spaces) — closing New space / Edit space / Edit owners / Archive without a write dropped the focus
  on `<body>`; it goes back to what opened the dialog. `test/render.library.test.ts`; area doc 2cad7a15.
- ENV13 87a822cb (spaces) — at 360 px an admin's four space-header buttons were one flex:none row: New page cut off,
  the main column scrolled sideways; the box stops at the header's width so its wrap applies.
  `test/render.library.test.ts`.
- ENV39 93b2bab6 (import) — at phone width the Imports rows kept Into and Run by (their inline `display:flex` beat the
  stylesheet's `display:none`): rows broke in two and the status was cut off. `test/render.import.test.ts`.

**For the owner:**
- **RV1 / RV5 / RV6 / RV7** — the design's Review for agents and for a selected page is not built: agents' changes
  are single proposal cards, not a "Written by ‹Name›'s agent" group with Approve all / Reject all; the page pane keeps
  the old layout (no crumb, the Unified diff first, "New version" not "New version of ‹Title›", no "N lines added,
  M removed", Promote / Reject in the header instead of the footer "Approving makes this page live for everyone." +
  ✓ Approve). The area doc lists "Review keeps its layout and its Promote / Reject buttons" as a departure; the agent
  group is not mentioned there. Build it, or accept the departure?
- **IW12 (question)** — the expected (15 pages, 3 titles exist) did not count three Engineering pages the seed itself
  holds with the zip's titles: "Accounts and access" and "Your first week" (import 6302's never-approved pages) and
  the live "Runbooks" (the zip's runbooks/ folder page merges into it — "Skipped" by design, a folder has no body to
  version). The planner's rule ("a title that matches an existing page of the target space is a conflict") gives
  14 / 6, which the screen shows. My reading: the product is right and the expected is off; IW18 / IW19 / IW21 used
  the same counts. Should a never-approved page count as "already exists"?
- **RV18 (question)** — the empty Review keeps the base's sentence, extended to imports, instead of the design's
  "Nothing to review" + "Pages that are imported or written by agents wait here …": Review also holds ADR drafts,
  which the design's sentence leaves out. Keep it, or take the design's words?
- SH2 (Batch A) is still open.

**Found outside the kept cases (recorded, not fixed):**
- Preview's links line counts a `[[slug]]` to no page as "to pages already in Trov" (test-single.md's
  `[[test-no-such-page]]`: "2 links: 2 point to pages already in Trov"; `import-actions.ts` `countLinks`).
- The summary strip reads "1 pages to add" (fixed plural labels, `import.ts` `sum.pages`).
- A stalled run's card still says "You can leave this page. The import keeps going." (it does not, until Retry).
- After a wizard step change the focus drops to `<body>`; the Archive / Edit owners dialogs opened from the keyboard
  leave the focus on their trigger instead of moving into the dialog.
- Space header: when the meta row wraps, its "·" separators start or end a line.
- `PUT /spaces/:slug` with `{name}` from a space owner answers "only an admin, or an owner of this space, can do that"
  (one message for every role refusal, `src/spaces/routes.ts`).
- Review's "Page i of N" shifts when another page of the group is decided (decided pages count as before it).
- Seed: the imports' start times are not in id order, so "newest first" (by id) shows "3 days ago" above
  "Yesterday" (real ids follow start time).

**Notes on the run.** IW25 needs a reload mid-run, which arms the browser's own leave prompt: I checked the prompt
with a synthetic `beforeunload` (defaultPrevented), then patched `preventDefault` / `returnValue` and reloaded — the
screenshot call hung for 30 s, so the native prompt most likely showed anyway; one Escape, and the page reloaded.
IW30 set `abuse_counters` (test-dl-admin, `doc_import`, today) to 20 and removed the row after; test-dl-member's
counter holds today's 7 real starts. Seed re-run after the last write; `npm run typecheck` 0 errors; the touched test
files (`docs-import`, `render.review`, `render.library`, `render.import`: 166 tests) pass.

## Batch B2 (2026-10-17)

The owner's round-2 rulings (after Batch B). Run against `wrangler dev` :8821 on `feat/docs-import` (from 620e024c),
Claude in Chrome (one tab, desktop 1499–1707 px CSS, light; 360 px = a 360 px iframe of the same page), re-seeded after
every case that wrote. Screenshots: `docs-library-shots/batch-b2/`.

**Built (each its own commit, with tests, retested in the browser):**
- **Review's agent group** 53f7f44a (import) — every doc change that is not an import's is a page of its author's group,
  "Written by ‹Name›'s agent" (a spark on slate, "N pages · ‹when›", rows "Change" / "New page"), with Review one by
  one, Reject all (the design's agent words) and Approve all — each page's own cookie promote / reject route, oldest
  first; no new write. A drafted decision stays a card of its own. The list pane takes the design's .95fr / 1.05fr
  split (so a group's actions sit on one row). `test/render.review.test.ts`, `test/render.import.test.ts`; the
  ai-cards snapshot (it also takes Batch A's SB1 chevron label, which it had not been updated for).
- **Review's page pane** 95dd9f50 (import) — the design's: "Page i of N · ‹short›" + arrows, the crumb (the page's
  space, then the titles above it: `GET /proposals` now carries each page's `path`), the title, "New page" / "New
  version of ‹Title›" / "Change to a live page" + "from ‹file›", the diff box ("What changes", "N lines added, M
  removed") for a change, then the page rendered; the footer "Approving makes this page live for everyone." + Reject
  + ✓ Approve (the queue's own verdicts; a focused verdict button hands its focus to the next page's). The design
  draws the diff box before the rendered page; that order is kept. The Unified / Side by side / Rendered switch is
  not on the page pane (a drafted decision keeps Review's own detail), so `diffViewer` / `review-rendered.ts` are no
  longer reached from Review — left in place for the owner to keep or remove. `test/render.review.test.ts`,
  `test/docs-import.test.ts`.
- **SH2** 9c4a1d8a (spaces) — a top-level card's line is the page's first sentence (`pageSummary`, derived on read
  from the body it shows; nothing stored). `test/spaces.test.ts`, `test/render.library.test.ts`.
- **RV18** 6848bb17 (import) — the empty Review reads "Nothing to review" + the design's sentence.
  `test/render.review.test.ts`, `test/render.skeleton.test.ts`.
- **IW12 / IW18 / IW19 / IW21** — the owner says the expected was wrong: rewritten to 14 pages and 6 existing titles
  (source "owner ruling 2026-10-17: expected was wrong"), pass on Batch B's evidence.

**Batch B's findings, fixed** (one fix loop each: a test that failed first, the smallest fix, the browser retest):

| finding | cause (one line) | fix | test | retested (same path) |
|---|---|---|---|---|
| a `[[slug]]` to no page counted as "already in Trov" | `countLinks` called every link not in the import "existing"; the wizard never knew the org's pages | dc2343e5 (import) | `test/import-actions.test.ts`, `test/render.import.test.ts` | test-single.md: "2 links: 1 points to a page already in Trov, and 1 to a page that isn't in Trov yet." (`F1-links-missing-page.jpg`) |
| "1 pages to add" | the summary strip's labels were fixed plurals | 4d671075 (import) | `test/render.import.test.ts` | "1 page to add … 2 links found" (`F2-one-page-to-add.png`) |
| "1 new pages" on the done card (found retesting the above) | the done card's breakdown had fixed plurals too | d0ba2d0d (import) | `test/render.import.test.ts` | a one-page import: "1 new page", "0 images" (`F2b-done-one-new-page.jpg`) |
| a stalled run's card says "The import keeps going." | `runStep` showed the leave-is-fine line in every phase | 4f0294f1 (import) | `test/render.import.test.ts` | /pages failed once: "Nothing more is sent until you press Retry."; Retry → done (IW26's path; `F3-stalled-card.jpg`) |
| focus lost after a wizard step change | a step change replaced the step block and the focused button with it | a8202419 (import) | `test/render.import.test.ts` | Enter on Continue → "Add your files" focused, Tab → Choose files (ENV29's path) |
| Archive / Edit owners not focusing in from the keyboard | only New space moved the focus into its dialog | cd468a03 (spaces) | `test/render.library.test.ts` | Enter on Archive → the red "Archive space" focused, Escape → back on Archive; Enter on Edit owners → the first person (ENV12's path; `F5-*.jpg`) |
| "·" at a wrapped line's edge | the meta row joined its items with "·" spans | 3764e15a (spaces) | `test/render.library.test.ts` | Engineering header desktop and 360 px: no dot starts or ends a line (ENV13 / ENV14; `F6-*.png`) |
| a space owner's rename 403 says owners can | one RoleError message for every role refusal | 40f0527f (spaces) | `test/spaces.test.ts` | curl as test-dl-spaceowner: rename → 403 "only an admin can rename a space or change its icon or color"; description → 200; another space → 403 "only an admin, or an owner of this space, can change its description and owners" |
| Review's "Page i of N" shifting | `importPageBar` counted every decided page as before the one shown | 4f0336c2 (import) | `test/render.review.test.ts` | Approve page 4 of 4 → "Page 1 of 4", then Your first week "Page 2 of 4" (RV7; `F8-page-position-stable.jpg`) |
| the seed's import start times not in id order | the seed gave 6303–6305 start times days before 6301 / 6302 | 829577b6 (seed) | the seed's read-back (36 checks; the new one failed on the old data: 8) | Imports: 30 / 45 / 60 / 70 minutes ago, An hour ago, 2 hours ago (IH1; `F9-imports-in-id-order.jpg`) |

**Reran in the browser (B2):** RV1, RV3, RV5, RV6, RV7, RV10, RV12, RV14, RV18 and SH2 — all **pass** now (RV1, RV5,
RV6, RV7, RV18, SH2 fail → fixed). No console error on any of them; no sideways scroll (Review's list 697 = 697, the
page 1707 = 1707). Touched test files (16, 480 tests) and `npm run typecheck` green after the last commit. Seed
re-run after the last write. No full suite run (Batch C does it).

**For Batch C:** rerun the trimmed set from a clean seed. Code paths changed in B2, for a full re-drive: Review (all
RV), Space home (SH1–SH2, ENV13–14), the wizard (IW9, IW12–IW26, ENV27–29), Create / Edit space and Archive (CS*,
ENV10–12), the spaces routes (API6, API8), Imports history (IH1). The ai-cards snapshot was stale on the branch
before B2 (Batch A's SB1 label); it is updated now.

## Batch C — final pass (2026-10-17)

Run against `wrangler dev` :8821 on `feat/docs-import` (from ed762bf5), Claude in Chrome (one tab of this session's
own; desktop 1707 px CSS, light; dark via `localStorage["trov.theme"]`; 360 px = a fresh 360 px iframe of the same page
per screen), the curl set with `curl` against :8821. Clean seed first (`node scripts/seed/docs-library.mjs`: all 36
checks hold), re-seeded after every case that wrote (each re-seed: 36 / 36 checks). Expected values are the rows' own,
unchanged. Screenshots: [`docs-library-shots/batch-c/`](docs-library-shots/batch-c/) (47 files).

**Cases run: 119 of 119** — every kept case once. Fully re-driven (a code path changed since it last passed): all RV,
SH1–2, ENV13–14, the wizard (IW9, IW12–IW26, ENV27–29), CS* and ENV10–12, API6 and API8, IH1, and the paths Batch A /
B / B2 fixed (SB1, LH8, SH6, SH23, DP8, DP14, DOC2, DOC13, NP9, NP19, IW51, DR10, IH12, RV3, CR1, ENV39). The rest:
a quick re-check with evidence. **Result: 119 pass** (CS1 failed first in this batch and passes after its fix).

**Fixes in Batch C** (each: the cause in one line, a test that failed first, the smallest fix, the browser retest, its
own commit):

| case | what was wrong | cause | fix | test | retested (same path) |
|---|---|---|---|---|---|
| CS1 (fail → fixed) | New space was 420 px wide; the design (and CS1's expected) says 480 | the space dialog used `confirmModal`'s 420 px box | dab37e00 (spaces): `#lib-space.cnpy-cmodal-box { width:min(480px, 100%) }`; the owners / archive dialogs keep 420 | `test/render.library.test.ts` "Create / Edit space is the design's 480 px dialog" | CS1 (width 480, Name focused), CS3, CS5, CS9, ENV10 (360 px: 360 = full width), ENV11, ENV12 |
| RV12 (finding on its path; its expected passed) | Reject all opened with Enter left the focus on its own button behind the modal | `reviewGroupReject` set state and repainted but moved no focus (the other delete confirms do) | 1538fa3c (import): the dialog's red button takes the focus; closing it gives the focus back to that group's Reject all | `test/render.review.test.ts` "a group's Reject all moves the focus into its dialog…" | RV12 (import group: focus on "Reject 4 pages", Escape → back on Reject all), RV14 (Enter, Enter → rejected), the agent group's Reject all ("Reject 7 pages" focused, Escape → back) |
| SH21 (finding on its path; its expected passed) | Archive Onboarding read "Its 1 page stay as they are" | a fixed plural verb after `pagesWord` | 05a49958 (spaces): one page "stays as it is" | `test/render.library.test.ts` "archive: the sentence agrees with the page count" | SH21 on Onboarding (1 page) and Engineering (45 pages), cancelled |
| ENV29 path (full suite) | `test/render.focus.test.ts` failed: `.cnpy-imp-h:focus` took the ring away | a8202419 (B2) gave the wizard's step heading the focus with `outline:none` | 8ec54eed (import): the rule removed; the heading shows the focus ring | the existing `test/render.focus.test.ts` (failed in the full run) | ENV29: Enter on Continue → "Add your files" focused, `:focus-visible`, outline auto |
| SB1 path (full suite) | `test/render.ai-absent.test.ts` failed: 4 snapshots held "Show spaces" | a78d7afd (Batch A) renamed the chevron "Show or hide spaces"; these snapshots were not refreshed (B2 refreshed only ai-cards) | e235df4c (spaces): the snapshots updated — the 6 label strings only | `test/render.ai-absent.test.ts` | SB1 (the label in the browser) |

**Per case** (C = this batch's evidence; screenshots in `batch-c/`):

| cases | result | evidence |
|---|---|---|
| SB1 SB2 SB5 SB7 SB11 SB12 | pass ×6 | SB1: chevron "Show or hide spaces", 6 space rows, Imports, + New space, Import (`LH1-SB1-library-admin.jpg`); SB2: member has no + New space, Import shown (`LH2-SB2-library-member.jpg`); SB5: Review badge 11 = the list's 11, none in test-docs-nospaces (`LH10-SB7-nospaces.jpg`); SB7: "No spaces yet" + hollow row (same shot); SB11: 239 sidebar nodes identical across library → engineering → doc → imports → library; SB12: collapsed shows the Library icon only (`SB12-collapsed.jpg`) |
| LH1 LH2 LH7 LH8 LH10 | pass ×5 | LH1/LH2 the shots above; LH7: Restore Old Wiki → toast "Restored Old Wiki", sidebar row, D1 slug `old-wiki` live; member: no Archived section, no Restore; LH8: Restore Design → "There's already a space called Design", D1 unchanged (`LH8-restore-name-taken.jpg`); LH10 (`LH10-SB7-nospaces.jpg`) |
| CS1 CS3 CS5 CS9 | pass ×4 (CS1 after dab37e00) | CS1: width 480, Name focused, Shield + Rust picked, Create disabled; CS3 red "There's already a space called Engineering. Pick another name." (`CS1-CS3-dialog-480-duplicate.jpg`); CS5: lands on #library/test-created-space, toast, D1 rocket / #2467af / description, owners = test-dl-admin (`CS5-created-space-home.jpg`); CS9 literal `<b>Test 🚀</b>` in dialog preview, sidebar, header, crumb, toast (`CS9-html-emoji-literal.jpg`) |
| SH1 SH2 SH4 SH6 SH8 SH11 SH14 SH17 SH21 SH23 | pass ×10 | SH1/SH2 (`SH1-SH2-DP1-engineering-admin.jpg`: owners, 45 pages, 10 waiting, each card's first sentence, Recently updated top 5); SH4 Recently = 70 minutes ago first, Least = 2 weeks ago first; SH6 groups `#ABCDEFGILMNOPRSTUWY`, Ünïcödé under U; SH8 "   test- Batch C description.   " + Enter → D1 `test- Batch C description.`; SH11 member: no edit affordance (`SH11-SH2-engineering-member.jpg`); SH14 Product "No owner yet"; SH17 Security empty states; SH21 see the fix above; SH23 "There is no space here…" and no pane |
| DP1 DP5 DP8 DP9 DP14 | pass ×5 | DP1 (`SH1-SH2-DP1-engineering-admin.jpg`); DP5 Level ten active and in view, 11 ancestors open (`DP5-deep-row-active.jpg`); DP8 nested row: Copy link / Move to the top level / New page inside, a top-level row: Copy link / New page inside (`DP8-more-menu.jpg`); DP9 Loop A, Loop B, Orphan page, Parent in another space at the top level, 45 counted; DP14 member sees Your first change in the pane and its page, no "Only people who can review" (`DP14-DOC13-staged-member.jpg`) |
| TM1 TM2 TM4 TM6 TM11 | pass ×5 | TM1 real drag: toast "Moved “Error codes”", D1 ranks auth 1024 / error 1536 / rate 2048; TM2 real drag: "Moved “Data model” inside API", D1 parent `test-api`; TM4 Undo → "Moved “Error codes” back", order restored; TM6 Platform onto Getting started: no move, no toast, D1 parent null; TM11 Alt+↑/↓/→/← each with its toast ("…inside Authentication"), depth 2 → 3 → 2, focus kept on the row |
| DOC1 DOC2 DOC3 DOC7 DOC9 DOC12 DOC13 DOC14 DOC18 DOC20 | pass ×10 | DOC1/DOC3 member: crumb buttons Engineering / Architecture / API, Live tip "This is the version everyone reads.", no Edit (`DOC1-DOC3-live-member.jpg`); DOC2 v2 muted + Rejected mark (`DOC2-history-rejected.jpg`); DOC7 link opens test-authentication, row active; DOC9 `is-broken` + tip "No page is called “test-no-such-page” yet…"; DOC12 banner, live body, "Version 2 is waiting for review"; DOC13 (`DP14-DOC13-staged-member.jpg`); DOC14 imported banner, Imported from … in test-handbook-v2.zip; DOC18 no img / script / on* / javascript:, alert stub never called; DOC20 "There is no page here…" |
| NP1 NP5 NP6 NP9 NP11 NP15 NP17 NP19 | pass ×8 | NP1/NP6 Goes in Engineering, 9 templates, Runbook picked; NP5 (`NP5-location-picker.jpg`); NP9 + NP17 double-click Create page → one page `test-np9` (v1 staged by test-dl-member, cur 0), toast "Page created in Engineering" (`NP9-NP17-created-staged.jpg`); NP11 D1 parent `test-api` (`NP11-under-api.jpg`); NP15 toast "…at the top level: that parent page could not take it", D1 parent null; NP19 admin: "No spaces yet" + New space |
| IW1 IW5 IW9 IW10 IW12 IW13 IW17 IW18 IW19 IW21 IW22 IW23 IW25 IW26 IW30 IW31 IW35 IW39 IW51 | pass ×19 | IW1 member (`IW1-where-member.jpg`); IW5 no-spaces empty layout; IW9 "From 2 files into Engineering", 2 pages, "1 points to a page already in Trov, and 1 to a page that isn't in Trov yet"; IW10 toast "A .zip is imported on its own: only test-handbook.zip was added."; IW12 14 / 6 / 3 / 2 / 7; IW13 Skip → struck + Skipped, 13; Rename → "Local setup (test-handbook)", Renamed (`IW12-IW13-preview-conflicts.jpg`); IW17 "Adding pages to Review 7%", "0 of 14 pages", "1 of 1 image", Imports badge 1; IW18 "14 pages added to Review", 9 / 5 / "1 image" (`IW18-done-card.jpg`); IW19 run 6320 partial, 14 staged versions (5 on existing pages), `handbook` top level of Engineering, 1 doc_images row, README `/img/<sha256>`; IW21 9 pages, no version on Local setup / Deploys / Paging; IW22 new `local-setup` "Local setup (test-handbook)", test-local-setup untouched; IW23 Cancel at 75 → toast "Import cancelled. 75 pages already added stay in Review.", D1 abandoned, staged 75 = 75 rows (a /pages sent after the cancel got 409); IW25 leave prompt armed (synthetic beforeunload defaultPrevented), the handler neutralised, reload → wizard fresh; run 6324 running at 225, 3 minutes later "Stopped · 225", Review 236 = 11 + 225; IW26 first /pages throws → "The connection dropped…", "Nothing more is sent until you press Retry." → Retry → done, 14 versions / 14 slugs (`IW26-stalled-retry.jpg`); IW30 counter at 20 → POST /imports 429, "You've hit today's limit for this; try again after 8:00 PM.", no run (the counter put back to 8); IW31 "This zip is damaged or unsupported.", Check disabled, no request; IW35 "This zip has more than 500 files. Up to 500 files or 50 MB…"; IW39 Ok + The good page, 4 × "The file's name or folder isn't allowed"; IW51 "This zip is over 50 MB unpacked…", huge.md "Larger than 1 MB, the most a page can be" |
| DR3 DR5 DR10 | pass ×3 | DR3 overlay "Drop to import into Engineering / 2 Markdown files…" → #import/engineering at Preview, 2 pages; DR5 overlay "Only Markdown files can be imported", toast "test-report.pdf isn't a Markdown file…"; DR10 Library home and Imports → #import at Where; Review and #library/old-wiki: no overlay, no navigation |
| IH1 IH3 IH7 IH8 IH12 | pass ×5 | IH1 6306 … 6301 newest first with sizes, Into paths, marks (`IH1-IH3-IH8-imports.jpg`); IH3 "5 pages went to Review. 3 files were skipped:" + 3 reasons + Open in Review; IH7 "Nothing was added." + wiki/a.md / wiki/b.md reasons; IH8 Stopped / Cancelled grey marks; IH12 admin cancels Max's run in test-docs-one → toast, row Cancelled, D1 abandoned |
| RV1 RV3 RV5 RV6 RV7 RV10 RV12 RV14 RV18 | pass ×9 | RV1 both group cards (`RV1-groups.jpg`); RV3 Deploys in Pia's agent group, import group 4 pages (`RV3-groups-open.jpg`); RV5 "Page 2 of 4 · test-handbook-v2.zip", crumb, New page, rendered page, ‹ wraps to 4 (`RV5-page-pane-new-page.jpg`); RV6 "New version of Local setup", "1 line added, 1 removed" (`RV6-page-pane-new-version.jpg`); RV7 Approve on page 4 → "Page 1 of 4" Onboarding (imported), "1 of 4 reviewed", "Approve 3 left", focus on ✓ Approve; RV10 toast "3 pages are now live in Engineering · Open Engineering", Review 7, D1 promoted with parents, Deploys v2 still staged; RV12 / RV14 see the fix above (`RV12-*.jpg`), D1 the 4 versions rejected with their bodies; RV18 (`RV18-review-empty.jpg`) |
| TR2 | pass | Doc section · reference · Engineering → item leaves (Unplaced 2 → 1, Review 11 → 12); D1 needs_triage 6311 assigned `doc:test-triaged-test-nowhere@1` by test-dl-admin; doc in engineering, cur 0 |
| API4 API6 API8 API10 API22 API29 | pass ×6 | curl: API4 outsider → not_found ×3; API6 member → forbidden "only an admin can create a space"; API8 owner {description} ok, {name} forbidden "only an admin can rename a space or change its icon or color", owners ok; API10 bearer → not_found (never read), no space written; API22 member manifest → 201, plan writes only `ok.md`, 4 × bad_path; API29 → not_found "there is no such import" ×2 |
| MCP1 MCP4 | pass ×2 | list_spaces: the 6 live spaces (no old-wiki / design-old); propose_doc_update into `test-nowhere` → `{"outcome":"triaged","reason":"unknown space: test-nowhere"}`, needs_triage by test-dl-member, no docs row |
| CR1 | pass | one `/__scheduled?cron=0+*+*+*+*` → doc_links test-unbackfilled → test-architecture, cursor `\u0001done` |
| RT2 | pass | #docs/technical → #library, #docs/product → #library |
| ENV4 ENV5 ENV10 ENV11 ENV12 ENV13 ENV14 ENV21 ENV22 ENV24 ENV25 ENV27 ENV28 ENV29 ENV39 ENV40 ENV42 ENV43 ENV45 | pass ×19 | desktop dark: page 1707 = 1707 on each (`ENV5`, `ENV11`, `ENV14`, `ENV22`, `ENV25`, `ENV28`, `ENV40`, `ENV43` shots); 360 px dark: the page 360 = 360 on each, only the tab bar and a code block scroll inside themselves (`ENV4`, `ENV10`, `ENV13`, `ENV21`, `ENV24`, `ENV27`, `ENV39`, `ENV42` shots); ENV12 focus log: Name → 12 icons → 8 swatches → description → Cancel → Name (trapped), Escape → back on New space; ENV29 Tab: the 5 other space cards, Top level, every tree row and its chevron, Cancel, Continue, each with a ring; Enter on Continue → "Add your files" focused; ENV45 the loaded stylesheet's reduced-motion blocks hold .cnpy-flash, [data-enter], .cnpy-aside, .cnpy-rvg, .cnpy-rv-card-in, .cnpy-rv-verdict, the drop overlay and the tab indicator |

No console error on any screen (read after each block); every `/api/` request answered as expected (the only non-2xx:
the cases' own 403 / 404 / 409 / 429).

**Found, not fixed (for the owner):**
- After a tree move, an open doc page's "Pages under ‹Title›" keeps its old list until a reload (TM2's path: on API's
  page, moving Data model inside API and Error codes above Rate limits left the card list as Authentication / Rate
  limits / Error codes; a reload shows the new order with Data model). The pane and D1 are right; the page's
  `children` come from the doc read and a move does not refetch it (`tree-actions.ts` `move`). Tree PR. Not a kept
  case's expected, so recorded rather than fixed.
- Seed note: test-docs-one's running run shows "12 of 40 pages in Review so far" but the seed writes no staged rows
  for it, so after IH12's cancel it reads "Nothing was added." (correct for the rows that exist). The seed's counts,
  not the product.

**Notes on the run.** Someone else used the same Chrome window during the run (trusted clicks on the docs pane once a
second, an Alt key, two extra "New Tab"s in this session's group, and finally the group itself removed); nothing they
did wrote to D1 (checked before each write case), the IW25 attempt they interrupted was rerun from a fresh seed, and the
run moved to a new tab group. IW25's reload: `preventDefault` and the `returnValue` setter were neutralised for
`beforeunload` first, so no native prompt showed. IW30's counter was restored to the admin's real 8 starts. Seed re-run
after the last write.

## Report

**Matrix.** 353 cases (each surface of the map × the dimensions in the code's guards; shown to the owner before
running). The owner trimmed it to **119** ("do we seriously need to run all 353"); the other 234 rows stay as `skipped`,
"trimmed by owner 2026-10-17". **Final pass (Batch C, clean seed): 119 of 119 run, 119 pass.**

| final result of the 119 kept cases | count |
|---|---|
| pass (passed the first time it ran) | 94 |
| fail → fixed (failed, fixed with a test, passes now) | 25 — SB1, LH8, CS1, SH2, SH6, SH23, DP8, DP14, DOC2, DOC13, NP9, NP19, IW51, DR10, IH12, RV1, RV3, RV5, RV6, RV7, RV18, CR1, ENV12, ENV13, ENV39 |
| pre-existing (fails the same way on base) | 0 — two pre-existing bugs were seen beside the cases (below) |
| question | 0 — the 20 were decided by the owner 2026-10-17; IW12 and RV18 in round 2 |
| skipped (trimmed by the owner) | 234 |

**Full suite and typecheck vs the Baseline** (run once, after every fix, `npx vitest run --maxWorkers=4`):
- First run at 05a49958: 403 files, 8848 tests — 7 failed: the known `test/ai.brief.test.ts` case (the baseline's one
  failure, on base too) + 4 × `test/render.ai-absent.test.ts` + 2 × `test/render.focus.test.ts`. The last six passed on
  the baseline and were broken by this feature's own E2E fixes (a78d7afd's label, a8202419's `outline:none`); each went
  through the fix loop (8ec54eed, e235df4c — Batch C's fixes table). After them those files pass (rerun alone, with the
  touched library / review files: 165 of 166, the one failure being ai.brief). Nothing that passed on the baseline fails
  now.
- `npm run typecheck`: 0 errors (as on the baseline).

**Every bug fixed** (case · what was wrong · cause · fix commit, PR · test):

| case | what was wrong | cause | fix | test |
|---|---|---|---|---|
| SB1 | the chevron's name flipped "Hide spaces" / "Show spaces" | the label followed the state beside aria-expanded | a78d7afd (spaces); snapshots e235df4c | `test/render.sidebar.test.ts`, `test/render.ai-absent.test.ts` |
| LH8 | a refused restore showed the server's raw lower-case text | `spaceErrorText` passed name_taken's detail through as written | c4c61170 (spaces) | `test/render.library.test.ts` |
| CS1 | Name not focused on open | libNew never focused the field | a1287563 (spaces) | `test/render.library.test.ts` |
| CS1 | the dialog 420 px, not 480 | it used confirmModal's 420 px box | dab37e00 (spaces) | `test/render.library.test.ts` |
| SH2 | cards had no description | a doc has no description field (owner: the first sentence, derived on read) | 9c4a1d8a (spaces) | `test/spaces.test.ts`, `test/render.library.test.ts` |
| SH6 | Ü its own group after Z | A–Z grouped by the raw first character (owner ruling) | d93ed284 (tree) | `test/render.library.test.ts` |
| SH21 | "Its 1 page stay as they are" | a fixed plural verb | 05a49958 (spaces) | `test/render.library.test.ts` |
| SH23 | an unknown space kept a "Loading pages…" pane | libraryFrame drew the pane whenever the org has spaces | 76714599 (spaces) | `test/render.library.test.ts` |
| DP8 | no "New page inside" in the … menu | owner ruling | 5ddeffd9 (tree) | `test/render.docs.test.ts` |
| DP14 / DOC13 | staged copy said only reviewers see it | owner ruling | a9674f0b (tree) | `test/render.docs.test.ts`, `test/render.library.test.ts` |
| DOC2 | a rejected version left out of History | owner ruling | cfc1f153 (tree) | `test/render.docs.test.ts` |
| NP9 | Create page did not land on the new page with "Page created in ‹Space›" | owner ruling | b5a97f2e (tree) | `test/render.newdoc.test.ts` |
| NP19 / IW5 | no spaces: no way on for an admin | owner ruling | 27f64817 (tree) | `test/render.newdoc.test.ts` |
| IW51 | a skipped page said only "The file is too large" | the reason did not name the limit | 9dfa8638 (import) | `test/docs-import-core.test.ts` |
| DR10 | a drop on Library home / Imports was ignored | owner ruling (only a space screen took a drop) | 9bacbd2d (import) | `test/import-actions.test.ts`, `test/render.import.test.ts` |
| IH12 | an admin saw no Cancel on someone else's run | the button checked the starter only (owner ruling); the seed's run had no `writes` (seed) | 47f18886 (import); c79dbee7 (seed) | `test/render.import.test.ts`; the seed's read-back |
| RV3 | an import's version under a newer agent change was offered alone; the badge read 12 | grouping ignored the newer change on top | 796ad957 (import) | `test/badges.routes.test.ts` |
| RV1 | the import card scrolled Review's list sideways | a grid row took its card's min-content width | fec5b340 (import) | `test/render.review.test.ts` |
| RV1 | no "Written by ‹Name›'s agent" group | not built (owner ruling round 2) | 53f7f44a (import) | `test/render.review.test.ts`, `test/render.import.test.ts`, `test/render.ai-cards.test.ts` |
| RV5 / RV6 / RV7 | the page pane kept the old layout | not built (owner ruling round 2) | 95dd9f50 (import) | `test/render.review.test.ts`, `test/docs-import.test.ts` |
| RV7 | "Page i of N" shifted as others were decided | decided pages counted as before the one shown | 4f0336c2 (import) | `test/render.review.test.ts` |
| RV12 | Reject all from the keyboard left the focus behind the modal | the act moved no focus | 1538fa3c (import) | `test/render.review.test.ts` |
| RV18 | the empty Review kept base's sentence | owner ruling round 2 | 6848bb17 (import) | `test/render.review.test.ts`, `test/render.skeleton.test.ts` |
| CR1 | the daily backfill could stop before reaching an org | a full 50-page take charged per org even with nothing to read | cd0501f3 (import) | `test/docs-import.test.ts` |
| ENV12 | closing a space dialog dropped the focus on `<body>` | no focus return | ede930a5 (spaces); doc 2cad7a15 | `test/render.library.test.ts` |
| ENV12 path | Edit space / Edit owners / Archive from the keyboard kept the focus outside | only New space moved the focus in | cd468a03 (spaces) | `test/render.library.test.ts` |
| ENV13 | at 360 px the header's buttons pushed the page sideways | one flex:none row | 87a822cb (spaces) | `test/render.library.test.ts` |
| ENV13 path | "·" at a wrapped meta line's edge | items joined with "·" spans | 3764e15a (spaces) | `test/render.library.test.ts` |
| ENV29 path | a wizard step change dropped the focus | the step block was replaced with the focused button | a8202419 (import) | `test/render.import.test.ts` |
| ENV29 path | the focused step heading had no ring | `.cnpy-imp-h:focus { outline:none }` | 8ec54eed (import) | `test/render.focus.test.ts` |
| ENV39 | at 360 px the Imports rows broke in two | an inline `display:flex` beat the stylesheet | 93b2bab6 (import) | `test/render.import.test.ts` |
| IW9 path | a `[[slug]]` to no page counted as "already in Trov" | countLinks never knew the org's pages | dc2343e5 (import) | `test/import-actions.test.ts`, `test/render.import.test.ts` |
| IW12 / IW18 path | "1 pages to add", "1 new pages" | fixed plurals | 4d671075, d0ba2d0d (import) | `test/render.import.test.ts` |
| IW26 path | a stalled run said "The import keeps going." | one line in every phase | 4f0294f1 (import) | `test/render.import.test.ts` |
| API8 path | a space owner's rename 403 said owners can | one message for every role refusal | 40f0527f (spaces) | `test/spaces.test.ts` |
| IH1 path | seeded imports' start times not in id order | seed data | 829577b6 (seed) | the seed's read-back |

All on `feat/docs-import`; the PR in brackets is where each belongs when the stack is split (spaces / tree / import).

**Owner rulings** (2026-10-17). Round 1: the trim to 119; the 20 questions — SH4 (newest / oldest first), NP9 (Create
page stages and lands on the page with "Page created in ‹Space›"), IW23 (the cancel toast with N), IH12 (admins cancel
others' runs), RV3 (a version under a newer change sits in the agent's group, not approvable alone), DP14 (every member
sees staged pages), DOC13 (the agent-staged banner), DOC3 (no Edit button), DOC2 (rejected versions muted with a
Rejected mark), DP8 (Copy link / Move to the top level / New page inside, no Rename), SB12 (collapsed: the Library icon
only), SH6 (accents under the base letter; symbols and digits in "#"), SH14 ("No owner yet"), NP19 / IW5 (emptyLayout
with New space for admins), IW10 (a zip with other files is imported alone, one sentence), IW51 (each limit named),
DR10 (Library home / Imports drop → the wizard at Where; Review and archived spaces are not targets), IH7 ("Nothing was
added." + reasons), IH8 (Cancelled / Stopped, neutral marks). Round 2: build Review's agent group and the page pane to
the design (RV1 / RV5 / RV6 / RV7 — the "What changes" box before the rendered page, as designed); SH2 = the page's
first sentence, derived on read; RV18 = the design's "Nothing to review"; IW12 / IW18 / IW19 / IW21 — the expected was
wrong (14 pages, 6 existing titles); fix Batch B's findings outside the kept cases.

**Pre-existing bugs left unfixed** (on `origin/main` too): every toast carries the accent check, errors included
(`app-root.ts` `toastBlock`; seen on LH8's refusal); the Review badge counts staged versions, so two agent versions of
one page count twice (base's count).

**Open, for the owner** (not a kept case's expected, so not fixed): after a tree move, an open doc page's "Pages under
‹Title›" stays stale until a reload (tree PR, `tree-actions.ts` `move` does not refetch the open page — Batch C ›
Found, not fixed). Left in place by B2: `diffViewer` / `review-rendered.ts` are no longer reached from Review — keep
or remove.

**Dropped or trimmed.** Dropped before running (cannot occur, or add nothing a kept case does not; Matrix › Dropped
combinations): 360 px in light; every data state × every viewport; a pure admin (not owner) role; keyboard at 360 px;
reduced motion beyond one stylesheet read (Claude in Chrome cannot emulate it); drag and drop on a phone; another org ×
each write (API4 / API29 / MCP cover the gate); Ask Trov parity (needs a real model key); plan limits (none in this
feature); signed out × every screen. Trimmed by the owner: 234 rows (Matrix › Trimmed) — the HTTP / MCP rows the
vitest suite pins, near-duplicate wizard fixtures and states, and environment repeats beyond one 360 px dark and one
desktop dark pass over the 8 main screens plus keyboard on the tree, the wizard and Create space.

**Seed.** `node scripts/seed/docs-library.mjs`, from `~/Projects/trov-docs-library`, against the local D1 its
`wrangler dev` uses (the server may stay up; local only, never `--remote`). It wipes and rewrites the four test orgs,
regenerates the 25 import fixtures in `scripts/seed/fixtures/docs-library/`, resets the backfill cursor and reads 36
checks back; `--list` (the fixtures), `--check` (read back only), `--files` (fixtures only). Then sign in with
`http://127.0.0.1:8821/auth/dev/as?handle=test-dl-admin` (or `test-dl-member`, `test-dl-spaceowner`,
`test-dl-agentuser`, `test-dl-outsider`) and open `/test-docs/#library`.

**Screenshots.** One folder, [`docs-library-shots/`](docs-library-shots/): `base/` (the baseline on origin/main),
`branch/` (setup smoke), `batch-a/`, `batch-b/`, `batch-b2/`, `batch-c/` (the final pass).

## Cases

Columns: id · surface · state (fixture, role, viewport, theme) · expected · source · actual · result · evidence · fix.
`expected` is written before the case runs and never edited to match. "design §N" = the design spec; "brief" = the
build brief's decisions (handoff #16); "prompt" = the Prompt Library prompt; code paths are on this branch.
Unless the state says otherwise: org `test-docs`, desktop 1512 px, light.

### SB — App sidebar › Library group

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| SB1 | Sidebar | spaces-many, admin | Knowledge › "Library" row (label → Library home) + a separate chevron button `aria-label` "Show or hide spaces"; group open by default; one row per LIVE space in order (Engineering, Product, Design, Security, the 40-char one, Onboarding), each a 14px tile + name; NO page rows; an "Imports" row; actions "+ New space" and "Import" | design §1.1; brief "The design wins…" | as expected, except the chevron's name flipped "Hide spaces" / "Show spaces" (cause: the label followed the state beside aria-expanded). After the fix: "Show or hide spaces" in both states; group open; the 6 live spaces; Imports row; + New space and Import | fail → fixed | docs-library-shots/batch-a/LH1-SB1-library-admin.jpg; DOM read (aria-label, aria-expanded, data-open) | a78d7afd (spaces); e235df4c (its stale ai-absent snapshots, Batch C) |
| SB2 | Sidebar | spaces-many, member | as SB1 but no "+ New space"; "Import" still there | design §1.1, §12 | member: no + New space in the sidebar (and none in the Library), Import shown | pass | docs-library-shots/batch-a/LH2-SB2-library-member.jpg |  |
| SB3 | Sidebar | admin | the chevron collapses / expands the group (rotates 90°, rows hidden / shown); the "Library" label still goes to Library home | design §1.1 | trimmed by owner 2026-10-17 | skipped | | |
| SB4 | Sidebar | admin; visit library, space, doc, newpage, import, imports | the Library row is active on all six; the space row is active (fg, 500, bar on the guide) on space / doc / newpage for that page's space; the Imports row is active on `#imports` | design §1.1 | trimmed by owner 2026-10-17 | skipped | | |
| SB5 | Sidebar › Review badge | test-docs admin; then test-docs-nospaces | Review's badge = total pages waiting for review (11 in test-docs); hidden when 0 | design §1.1, §14.7 | before RV3's fix the badge read 12 (it counted staged VERSIONS; test-deploys had two — the count is base's, unchanged). After 796ad957 (RV3) the Review list and the badge both read 11 = the 11 pages waiting. Two agent versions of one page would still count twice (base behaviour) | pass (after RV3 fix) | `GET /badges` proposals 11; Review list 11 items; docs-library-shots/batch-a/RV3-deploys-in-agent-group.jpg | 796ad957 (via RV3) |
| SB6 | Sidebar › Imports badge | test-docs-one (import-running); then test-docs (only a stale run) | test-docs-one: Imports badge "1"; test-docs: no badge (the stale run is not in progress) | design §1.1, §14.7; brief "stale after a heartbeat window" | trimmed by owner 2026-10-17 | skipped | | |
| SB7 | Sidebar | spaces-none, admin | "No spaces yet" (12px, fg40) + one hollow row in place of the space rows; "+ New space" and "Import" still shown | design §1.1 | test-docs-nospaces, admin: "No spaces yet" + the hollow row; + New space and Import shown | pass | docs-library-shots/batch-a/NP19-SB7-newpage-nospaces-admin.jpg |  |
| SB8 | Sidebar | spaces-one (test-docs-one), member | exactly one space row (Engineering) | design §1.1 | trimmed by owner 2026-10-17 | skipped | | |
| SB9 | Sidebar | space-long | the 40-character name is cut with an ellipsis inside the 228px sidebar; no horizontal scroll | design §1.1; prompt (no overflow) | trimmed by owner 2026-10-17 | skipped | | |
| SB10 | Sidebar | space-archived, admin | Old Wiki and the archived "Design" are never listed | brief "archive … leaves the sidebar" (Spaces) | trimmed by owner 2026-10-17 | skipped | | |
| SB11 | Sidebar | admin; navigate library → space → doc → imports | the sidebar's nodes are the same elements before and after (state is attributes / classes only) | CLAUDE.md web UI rule (stable sidebar DOM) | all 239 sidebar nodes are the same elements across library → engineering → doc → imports → library; only classes change (active rows) | pass | DOM identity check in the browser (node-by-node ===) |  |
| SB12 | Sidebar › Collapse | admin; footer "Collapse" | collapsed, the Library group shows only the Library icon (it opens Library home); the spaces and the group's rows are hidden | owner ruling 2026-10-17 | collapsed: the group's list is 0 px high and transparent, its chevron hidden, no space row focusable; the Library icon opens #library (h1 Library) | pass | docs-library-shots/batch-a/SB12-SH14-collapsed-product.jpg; DOM read |  |
| SB13 | Sidebar actions | admin on Library home, then on Space home (Product) | "+ New space" opens Create space; "Import" opens Import — with no space preset from Library home, with Product preset from Product's home | design §1.1 | trimmed by owner 2026-10-17 | skipped | | |

### LH — Library home

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| LH1 | Library home | spaces-many, admin | h1 "Library"; subtitle "Guides, runbooks, specs and decisions for the whole team, grouped into spaces."; "Import" (secondary) and "New space" (primary); "Spaces" heading and a 3-column grid of 6 cards (32px tile, name, description or "No description yet.", owner avatars, count, "· N waiting" when any) and the dashed "New space" card ("For a team or a topic. Only admins can create spaces.") | design §3 | as expected (h1, subtitle, Import + New space, 3-column grid of 6 cards with tiles, descriptions or "No description yet.", owners, counts, "· N waiting", the dashed New space card) | pass | docs-library-shots/batch-a/LH1-SB1-library-admin.jpg |  |
| LH2 | Library home | spaces-many, member | no "New space" button and no dashed card; "Import" present | design §3, §12 | member: no New space button or card; Import shown; no Archived spaces | pass | docs-library-shots/batch-a/LH2-SB2-library-member.jpg; DOM read |  |
| LH3 | Library home cards | spaces-many | Security "No pages yet", Onboarding "1 page", others "N pages"; Engineering "· 10 waiting", Product "· 1 waiting" | design §0.5, §3 | trimmed by owner 2026-10-17 | skipped | | |
| LH4 | Library home | admin | a card opens that space's home; a Recently updated row opens its doc | design §3 | trimmed by owner 2026-10-17 | skipped | | |
| LH5 | Library home | test-docs, then test-docs-one | test-docs: "11 pages are waiting for review" with a pending shape → Review; test-docs-one (nothing waiting): no link | design §3 | trimmed by owner 2026-10-17 | skipped | | |
| LH6 | Library home › Recently updated | spaces-many | the 6 most recently updated pages across spaces; each: 14px tile, title, path "Space › ancestors" below; a status mark only for non-live; "‹Short› · ‹when›" with an avatar | design §3, §0.3 | trimmed by owner 2026-10-17 | skipped | | |
| LH7 | Library home › archived | space-archived; admin, then member | an admin finds the archived spaces and restores Old Wiki: it returns to the Library and the sidebar with slug `old-wiki` unchanged; a member sees no archived space and no Restore | brief (Spaces: archive / restore admin; slug reserved) | admin: Archived spaces lists Old Wiki + Design; Restore Old Wiki → toast "Restored Old Wiki", sidebar row + card `old-wiki` back; member sees no archived space (LH2) | pass | DOM read (sidebar data-drop-space old-wiki, cards); re-seeded after |  |
| LH8 | Library home › restore | space-archived-clash, admin | restoring the archived "Design" is refused with a sentence that the name is taken; nothing changes | brief "Name unique … among NON-archived spaces" | refused, nothing changed — but the toast read the server's raw "there's already a space called Design" (lower case, no stop). Cause: spaceErrorText passed name_taken's detail through as written. After the fix: "There's already a space called Design." | fail → fixed | docs-library-shots/batch-a/LH8-before-fix-lowercase-toast.jpg; toast text after | c4c61170 (spaces) |
| LH9 | Library home | admin; `/spaces` delayed | loading: the title block stays, waiting link hidden, 3 skeleton cards, "Recently updated" heading + 5 skeleton rows | design §3 loading | trimmed by owner 2026-10-17 | skipped | | |
| LH10 | Library home | spaces-none, admin | dashed box "No spaces yet" + "A space holds the pages for one team or topic, like Engineering or Onboarding. Create one, then write pages in it or import Markdown files you already have." + outlined "New space"; then 3 hollow cards, "Recently updated", 3 hollow rows | design §3 empty | dashed "No spaces yet" box with the copy and an outlined New space; 3 hollow cards; Recently updated with 3 hollow rows | pass | docs-library-shots/batch-a/LH10-library-empty-admin.jpg |  |
| LH11 | Library home | spaces-none, member | as LH10 without the "New space" button | design §3 empty | trimmed by owner 2026-10-17 | skipped | | |
| LH12 | Library home | admin; `/spaces` answers 503 | a sentence that the Library could not be read; no blank screen, no console exception | CLAUDE.md invariant 7 | trimmed by owner 2026-10-17 | skipped | | |
| LH13 | Library home | space-long | the 40-char name and 140-char description wrap / ellipsize inside the card; no horizontal scroll | design §3; prompt | trimmed by owner 2026-10-17 | skipped | | |
| LH14 | Library home | member | "Import" opens the wizard at Where with no space preset | design §3, §8 | trimmed by owner 2026-10-17 | skipped | | |

### CS — Create space

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| CS1 | Create space | admin, Library header "New space" | 480px modal "New space", intro "A space holds the pages for one team or topic. Only admins can create one.", Name focused and empty (placeholder "Like Security or Onboarding"), shield selected, `#b4562c`, empty description, "Create space" disabled | design §7 | modal, intro, Name empty with the placeholder, maxlength 40, shield + #b4562c selected, Create disabled — but focus stayed on the New space button (cause: libNew never focused the field). After the fix Name is focused on open — Batch C: the dialog was 420 px wide, not the design's 480 (cause: it used confirmModal's 420 px box). Fixed: 480 at desktop, the full width at 360 px | fail → fixed | docs-library-shots/batch-a/CS1-CS3-duplicate-name.jpg; document.activeElement before/after; docs-library-shots/batch-c/CS1-CS3-dialog-480-duplicate.jpg (getBoundingClientRect width 480) | a1287563 (spaces); dab37e00 (spaces, Batch C) |
| CS2 | Create space | admin, from sidebar "+ New space" and from the dashed card | the same reset state from each entry point | design §7 | trimmed by owner 2026-10-17 | skipped | | |
| CS3 | Create space | admin; Name " engineering " | red border + ring and "There's already a space called Engineering. Pick another name."; Create disabled | design §7 | red border + "There's already a space called Engineering. Pick another name."; Create disabled | pass | docs-library-shots/batch-a/CS1-CS3-duplicate-name.jpg |  |
| CS4 | Create space | space-archived, admin; Name "Old Wiki" | allowed (an archived space frees its name); the new space's slug is `old-wiki-2` (slugs stay reserved) | brief (Spaces) | trimmed by owner 2026-10-17 | skipped | | |
| CS5 | Create space | admin; "Test Created Space", rocket, `#2467af`, a description | creates it; lands on its empty Space home; toast "Created Test Created Space"; the creator is the only owner; a sidebar row appears; DB `doc_spaces` row slug `test-created-space`, `doc_space_owners` = test-dl-admin | design §7; brief | landed on #library/test-created-space; toast "Created Test Created Space"; sidebar row; DB doc_spaces rocket / #2467af / the description, doc_space_owners = test-dl-admin only | pass | docs-library-shots/batch-a/CS5-created-space-home.jpg; D1 rows |  |
| CS6 | Create space | admin | Name takes at most 40 characters | design §7 | trimmed by owner 2026-10-17 | skipped | | |
| CS7 | Create space | admin | "Short description" muted "Optional", "‹n›/140" counter, at most 140 characters | design §7 | trimmed by owner 2026-10-17 | skipped | | |
| CS8 | Create space | admin | "In the sidebar" preview: 14px tile in the chosen color/icon + the name, or "New space" while empty | design §7 | trimmed by owner 2026-10-17 | skipped | | |
| CS9 | Create space | admin; Name `<b>Test 🚀</b>` | created; the name shows as literal text (with the emoji) in the modal preview, sidebar, card and header — never as HTML | prompt (HTML injection, unicode) | created (slug b-test-b); `<b>Test 🚀</b>` literal in the dialog preview, the sidebar, the header, the crumb and the toast | pass | docs-library-shots/batch-a/CS9-html-emoji-name-literal.jpg |  |
| CS10 | Create space | admin; double-click Create | exactly one space is created | prompt (duplicate submit) | trimmed by owner 2026-10-17 | skipped | | |
| CS11 | Create space | admin; Cancel, then Esc | the modal closes; nothing is created | design §7 | trimmed by owner 2026-10-17 | skipped | | |
| CS12 | Create space | admin; Name "   " | Create stays disabled | design §7 (empty name disables) | trimmed by owner 2026-10-17 | skipped | | |
| CS13 | Create space | admin | 12 icon buttons in order braces … lock; 8 round swatches (`aria-label` "Color") in the design's order; the selected icon / swatch drawn as specified | design §7 | trimmed by owner 2026-10-17 | skipped | | |

### SH — Space home

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| SH1 | Space home | Engineering, admin | 40px tile, h1 "Engineering", description ghost button with pencil; meta: owner avatars, "Owned by Olu Test-Owner and Ada Test-Admin" (full names), "· 45 pages", "· 10 waiting for review" (link); "Import" + "New page"; the docs pane with its head active | design §4, §0.5 | as expected; the owners read "Owned by Ada Test-Admin and Olu Test-Owner" (the stored owners' order — the design fixes none) | pass | docs-library-shots/batch-a/SH1-SH2-engineering-admin.jpg |  |
| SH2 | Space home › Overview | Engineering | "Top-level pages" with "All pages ›" (switches tab); cards: "N pages inside" / "1 page inside" / "No pages inside", title, description, "Updated ‹when›"; then "Recently updated" (top 5; path "Top level" for root pages) | design §4; owner ruling 2026-10-17 (the description is the page's first sentence, derived on read) | Top-level pages with All pages ›, inside counts, titles, "Updated ‹when›", Recently updated (top 5) — but the cards have NO page description: a doc has no description field (the design's §13.5 data), so nothing can fill it — B2 (after 9c4a1d8a): each card carries the page's first sentence under its title: "Set up your machine, learn the repository and ship a first change.", "How the web app, the API and the data model fit together.", "A test page." …; the HTML-injection page reads "click me" (no tag, no script text); a page with no text has no line; no console error | fail → fixed (B2) | docs-library-shots/batch-a/SH1-SH2-engineering-admin.jpg; docs-library-shots/batch-b2/SH2-card-first-sentence.jpg | 9c4a1d8a (spaces) |
| SH3 | Space home › All pages | Engineering | column header "Page / Status / Last updated"; every page flattened in tree order, indented depth × 18px, depth 0 weight 500; the tab's count badge = all pages | design §4 | trimmed by owner 2026-10-17 | skipped | | |
| SH4 | Space home › Recently / Least recently updated | Engineering | "Recently updated" lists the pages newest first; "Least recently updated" oldest first | owner ruling 2026-10-17 | Recently updated: newest first (75 minutes ago …); Least recently updated: oldest first (2 weeks ago …) | pass | DOM read of both tabs' first rows |  |
| SH5 | Space home › A to Z | Product | rows by title with a letter label before the first title of each letter | design §4 | trimmed by owner 2026-10-17 | skipped | | |
| SH6 | Space home › A to Z | Engineering (titles "<img…", "Ünïcödé…") | accented letters sit under their base letter (Ünïcödé under U); titles starting with a symbol or a digit sit in one "#" group, first | owner ruling 2026-10-17 | before: Ü made its own group after Z; after the fix: [#] <img…, [A] … [U] Ünïcödé … — # first, Ü under U | fail → fixed | DOM read of the A to Z panel (letter labels + rows) | d93ed284 (spaces) |
| SH7 | Space home tabs | Engineering | `tabBar()` with a sliding 2px accent indicator; switching tabs keeps the pane and does not replay the page entrance | design §4; CLAUDE.md (tabBar) | trimmed by owner 2026-10-17 | skipped | | |
| SH8 | Space home › description | Engineering, admin; type, Enter | the ghost button becomes an input (placeholder "What is this space for?", focused, ≤ 140), helper "Enter to save · Esc to cancel" + "‹n›/140"; Enter saves trimmed; DB updated | design §4 | input (placeholder "What is this space for?", focused, maxlength 140), helper "Enter to save · Esc to cancel" 77/140; typed text with spaces, Enter → saved trimmed, shown, `GET /spaces/engineering` description trimmed | pass | DOM + API read; re-seeded after |  |
| SH9 | Space home › description | admin; Esc; then blur | Esc restores the old text; leaving the field saves | design §4 | trimmed by owner 2026-10-17 | skipped | | |
| SH10 | Space home › description | Engineering, space owner (test-dl-spaceowner) | may edit and save the description | brief "Description + owners: editable by an admin OR an owner" | trimmed by owner 2026-10-17 | skipped | | |
| SH11 | Space home › description | Engineering, member (not an owner) | the description is not editable (no edit affordance) | brief (same) | member: the description is plain text, no pencil, no Edit owners | pass | docs-library-shots/batch-a/SH11-member-no-desc-edit.png |  |
| SH12 | Space home › description | admin; clear it, Enter | saved empty; the button reads "Add a short description" in fg40 | design §4 | trimmed by owner 2026-10-17 | skipped | | |
| SH13 | Space home › owners | Design, space owner; add test-dl-member, then remove them | "Owned by …" follows each change; DB `doc_space_owners` matches | brief (owners editable by admin or owner) | trimmed by owner 2026-10-17 | skipped | | |
| SH14 | Space home › owners | space-no-desc (Product, no owner) | the meta line reads "No owner yet" where the owners would be | owner ruling 2026-10-17 | Product: "No owner yet" in the meta line | pass | docs-library-shots/batch-a/SB12-SH14-collapsed-product.jpg; DOM read |  |
| SH15 | Space home | Engineering, member | no Edit owners, Edit space or Archive; "New page" and "Import" present | design §4 (not gated); brief (admin shapes spaces) | trimmed by owner 2026-10-17 | skipped | | |
| SH16 | Space home | Engineering, member | "New page" → New page at Engineering's top level; "Import" → wizard with Engineering preset; "10 waiting for review" → Review | design §4 | trimmed by owner 2026-10-17 | skipped | | |
| SH17 | Space home | space-empty (Security), admin | meta "0 pages"; dashed "No pages yet" + "Write the first page, or import Markdown files you already have. Imported pages wait in Review until someone approves them." + outlined New page and Import; "Top-level pages" with 3 hollow cards; "Recently updated" with 3 hollow rows; the pane's hollow tree | design §4 empty | meta "0 pages"; dashed No pages yet + copy + New page / Import; 3 hollow cards; 3 hollow rows; the pane's "No pages yet…" + hollow rows | pass | docs-library-shots/batch-a/SH17-security-empty.jpg |  |
| SH18 | Space home | Engineering; `/spaces/engineering` delayed | skeleton header (40px square, bars, two avatars, button blocks), tabs without the count, skeleton cards and rows; the pane's skeleton | design §4 loading | trimmed by owner 2026-10-17 | skipped | | |
| SH19 | Space home › Edit space | Design, admin; rename "Design Test", icon flask, color `#966800`; then rename to "Product" | the name / tile change everywhere, slug stays `design`; renaming to a live space's name is refused with a sentence | brief (rename, slug reserved, unique names) | trimmed by owner 2026-10-17 | skipped | | |
| SH20 | Space home › position | admin; move Onboarding first | the order changes in the sidebar and the Library and stays after a reload | brief (reorder, sort_rank) | trimmed by owner 2026-10-17 | skipped | | |
| SH21 | Space home › Archive | Onboarding, admin | a red `confirmModal`; confirmed: it leaves the sidebar and the Library; `#doc/test-welcome` still reads | brief (archive soft); CLAUDE.md (confirmModal) | red confirmModal "Archive Onboarding?" (Cancel / Archive space); confirmed: toast "Archived Onboarding", gone from the sidebar and the Library cards, listed under Archived spaces; #doc/test-welcome reads — Batch C: the same, but the dialog read "Its 1 page stay as they are" (a finding outside the expected: a fixed plural verb). Fixed: "Its 1 page stays as it is"; Engineering's reads "Its 45 pages stay as they are" | pass | docs-library-shots/batch-a/SH21-archive-confirm.jpg; DOM read; re-seeded after; docs-library-shots/batch-c/SH21-archive-confirm-1-page.jpg | 05a49958 (spaces, Batch C finding) |
| SH22 | Space home (archived) | space-archived via `#library/old-wiki`; admin, then member | readable with its pages; no way to add a page; an admin can restore it, a member cannot | brief (archive soft: no NEW page; admin restore) | trimmed by owner 2026-10-17 | skipped | | |
| SH23 | Space home | `#library/test-nope` | a "no such space" sentence; no crash | CLAUDE.md invariant 7 | the sentence "There is no space here…" — but beside it a docs pane stuck on "Loading pages…" for good (cause: libraryFrame drew the pane whenever the org has spaces). After the fix: the sentence alone; real spaces still draw their pane | fail → fixed | docs-library-shots/batch-a/SH23-before-fix-pane-loading-forever.jpg, docs-library-shots/batch-a/SH23-unknown-space-after-fix.jpg; console clean | 76714599 (tree) |
| SH24 | Space home › All pages | tree-many (Product, 31 pages) | every page listed (Release notes' 25 children indented under it); the page scrolls, no overflow | design §4 | trimmed by owner 2026-10-17 | skipped | | |
| SH25 | Space home › description | admin; `<img src=x onerror=alert(1)> 🚀` | saved and shown as literal text; no alert | prompt (injection, unicode) | trimmed by owner 2026-10-17 | skipped | | |

### DP — Docs pane

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| DP1 | Docs pane | Engineering home, admin | 252px pane: head (20px tile, "Engineering", "+" `aria-label` "New page"); "PAGES" + the space's page count; 28px rows; a chevron only on pages with children; a non-live page has its 8px shape (amber ring pending, dashed ring staged) and no word | design §1.2, §0.2 | 252 px pane; head (20 px tile, Engineering, "+" New page) active on the home; PAGES 45; 28 px rows; chevrons only on parents; Moves / Bad parent on promote carry the amber ring | pass | DOM read; docs-library-shots/batch-a/SH1-SH2-engineering-admin.jpg |  |
| DP2 | Docs pane | tree-deep-10, `#doc/test-deep-9` | indent 14px per level to level 4, then 9px; a guide line per ancestor level; the 10-level chain fits the pane with no horizontal scroll | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP3 | Docs pane | tree-deep-10 | a title over 24 characters has its full title as a `data-mtip` tooltip | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP4 | Docs pane | Architecture | the chevron opens / closes the page's children without opening the page | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP5 | Docs pane | open `#doc/test-deep-9` directly | its ancestors are expanded; its row is active (accent tint, accent text, 500) and scrolled into view (~45% of the pane) | design §1.2 | direct load: every ancestor open, Level ten active (accent text, 500, tint); the pane does not scroll at this height, the row is in view at 69% | pass | docs-library-shots/batch-a/DP5-deep9-direct.jpg; DOM read |  |
| DP6 | Docs pane | hover "API" | "+" (`aria-label` "New page inside") and "…" (`aria-label` "More") fade in; "+" opens New page with API as the parent | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP7 | Docs pane head | Engineering doc page | the head goes to Space home; its "+" opens New page at the top level; the head is active only on Space home | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP8 | Docs pane › "…" More | any row | the "…" menu holds Copy link, Move to the top level (for a page not already there), New page inside; no Rename | owner ruling 2026-10-17 | before: Copy link, Move to the top level; after the fix: Copy link \| Move to the top level \| New page inside (no Rename); New page inside opens New page under API | fail → fixed | docs-library-shots/batch-a/DP8-menu-api.jpg, docs-library-shots/batch-a/DP8-NP6-newpage-inside-api.jpg | 5ddeffd9 (tree) |
| DP9 | Docs pane | tree-orphan, tree-loop, tree-cross-parent | the orphan, both loop pages and the cross-space-parent page are drawn at Engineering's top level; no page is missing; nothing hangs | code `shared/docs-tree-core.ts` `buildTree` | Loop A, Loop B, Orphan page and Parent in another space drawn at Engineering's top level; 45 pages counted | pass | DOM read of the pane rows |  |
| DP10 | Docs pane | tree-unranked (Runbooks) | ranked children first by rank ("Writing an incident review"), then unranked ones A to Z (Deploys, Imported and approved A / B, Paging and escalation) | code `treeOrder` | trimmed by owner 2026-10-17 | skipped | | |
| DP11 | Docs pane | space-empty (Security) | "No pages yet" (fg40) + three hollow 9px bars (64 / 48 / 56%); count "0" | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP12 | Docs pane | Engineering; `/spaces/engineering` delayed | 9 skeleton rows of 28px; the count hidden | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP13 | Docs pane | visit library, import, imports, review | the pane is never shown on those | design §1.2 | trimmed by owner 2026-10-17 | skipped | | |
| DP14 | Docs pane | page-staged, member | every member sees staged pages (pane, lists, doc page); no copy says "Only people who can review see it" | owner ruling 2026-10-17 | member sees staged pages (dashed rings in the pane, the page itself); before the fix the banner and the "Not yet approved" tooltip said only reviewers see it; after: neither does | fail → fixed | docs-library-shots/batch-a/DOC13-DP14-agent-staged-member.jpg | a9674f0b (tree) |
| DP15 | Docs pane | open Authentication, then Single sign-on | the pane is patched, not rebuilt: open chevrons and the pane's scroll stay | code `render.ts libraryFrame` (data-morph) | trimmed by owner 2026-10-17 | skipped | | |

### TM — Moving pages in the tree

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| TM1 | Tree drag | admin; drag "Error codes" over the top 30% of "Rate limits" | the row drops to 38% opacity; ghost chip + pill "Move above Rate limits"; a 2px drop line with the 8px square handle; on release the row flashes; toast "Moved “Error codes”" with Undo; DB tree_rank changed; same order after reload | design §1.3; brief (move) | real mouse drag Error codes onto the top of Rate limits: toast "Moved “Error codes”" + Undo; D1 ranks auth 1024 / error 1536 / rate 2048; same order after reload (the ghost and line were not captured on this fast drag — see TM2's shot) | pass | D1 rows; DOM order after reload |  |
| TM2 | Tree drag | admin; drop "Data model" on the middle of "API" | API row ringed + tinted, pill "Put inside API"; Data model becomes API's last child; API expands; toast "Moved “Data model” inside API"; DB parent_slug `test-api` | design §1.3 | source row at 0.38; API ringed; ghost "Data model" + pill "Put inside API"; toast "Moved “Data model” inside API"; last child of API; D1 parent_slug test-api | pass | docs-library-shots/batch-a/TM2-drag-into-api.png; D1 row |  |
| TM3 | Tree drag | admin; drop "Sidebar and navigation" on the pane head | pill "Move to the top level of Engineering"; appended to the end of the top level; toast "Moved “Sidebar and navigation” to the top level of Engineering"; DB parent_slug NULL | design §1.3 | trimmed by owner 2026-10-17 | skipped | | |
| TM4 | Tree drag › Undo | after TM2 | Undo restores the previous tree on screen and in the DB | design §1.3 | pill "Move above Authentication"; moved; Undo → "Moved “Data model” back", screen and D1 back to auth / error / rate / data model | pass | DOM + D1 rows |  |
| TM5 | Tree drag | admin; drag "Architecture" onto "Web app" (its child) and onto itself | no drop target; nothing moves | design §1.3; brief (no cycles) | trimmed by owner 2026-10-17 | skipped | | |
| TM6 | Tree drag | tree-deep-10; drag "Platform" into "Getting started" | refused (no target / the hint says it would be too deep); tree and DB unchanged | brief MAX_DEPTH = 10 | Platform over Getting started: no ringed row, pill "Pages go at most 10 levels deep"; release: no toast, nothing moved; Escape clears the ghost | pass | docs-library-shots/batch-a/TM6-too-deep-hint.png |  |
| TM7 | Tree drag | tree-deep-10; drag "Data model" into the level-10 page | refused as too deep; nothing moves | brief MAX_DEPTH = 10 | trimmed by owner 2026-10-17 | skipped | | |
| TM8 | Tree drag | pointer down + up with < 5px movement on a row | the page opens; nothing moves | design §1.3 | trimmed by owner 2026-10-17 | skipped | | |
| TM9 | Tree drag | mid-drag, press Escape | the drag ends; nothing moves; the click is not turned into an open | code `web/src/pointer-drag.ts` | trimmed by owner 2026-10-17 | skipped | | |
| TM10 | Tree drag | member | a member can move pages (TM1-style move works) | design §12; brief (any signed-in member) | trimmed by owner 2026-10-17 | skipped | | |
| TM11 | Tree moves (keyboard) | admin; focus a row, Alt+↑ / Alt+↓ / Alt+→ / Alt+← | the same moves as a drag (above / below / inside the previous page / out a level), with the toast and Undo | code `tree-drag.ts`; prompt (every control by keyboard) | focused Error codes: Alt+↑ above Rate limits, Alt+↓ back, Alt+→ "inside Rate limits" (depth 3), Alt+← out (depth 2) — each with its toast and Undo, focus kept on the row | pass | DOM read after each key; re-seeded after |  |
| TM12 | Tree drag | tree-unranked; drop "Paging and escalation" above "Deploys" | the list's order on screen is exactly the drop's order and is the same after a reload | design §1.3; code `placeAmong` (renumber) | trimmed by owner 2026-10-17 | skipped | | |
| TM13 | Tree drag | space-archived (Old Wiki pane via `#doc/test-old-wiki-page`) | a move is refused with a sentence; the tree returns to its place | code `doc-tree.ts` (`archived` 409) | trimmed by owner 2026-10-17 | skipped | | |
| TM14 | Tree drag | admin; `/doc/:slug/move` answers 409 | the optimistic move is put back and a sentence says why | code `tree-actions.ts` | trimmed by owner 2026-10-17 | skipped | | |

### DOC — Doc page

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| DOC1 | Doc page | page-live (test-authentication), member | no banner; breadcrumb "Engineering › Architecture › API › Authentication" (all but the last clickable); h1 "Authentication"; meta "Live" mark (hover: "This is the version everyone reads.") · "Updated 3 days ago by Ada"; History and Edit buttons | design §5, §0.2 | as expected (no banner, the crumb, h1, Live · Updated 3 days ago by Ada, History); no Edit button — owner ruling DOC3 | pass | docs-library-shots/batch-a/DOC1-DOC2-DOC3-auth-history-member.jpg |  |
| DOC2 | Doc page › History | page-live | rows "v3" … [Live], "v1" …, and the rejected v2 shown muted with a "Rejected" mark from marks.ts (not a pill) | owner ruling 2026-10-17 | before: v3, v1 (v2 left out); after the fix: v3 [Live], v2 muted "Rejected" (faded cross), v1 | fail → fixed | docs-library-shots/batch-a/DOC1-DOC2-DOC3-auth-history-member.jpg | cfc1f153 (tree) |
| DOC3 | Doc page › Edit | page-live | no Edit button on the doc page (as built) | owner ruling 2026-10-17 | no Edit button | pass | docs-library-shots/batch-a/DOC1-DOC2-DOC3-auth-history-member.jpg |  |
| DOC4 | Doc page › On this page | page-live | entries from h2 / h3 (h3 indented); the current heading accent with a 2px bar while scrolling (last heading within 120px of the top); a click smooth-scrolls with 24px to spare; "Pages under Authentication" appended | design §5 | trimmed by owner 2026-10-17 | skipped | | |
| DOC5 | Doc page › rail info | page-live | "Owner" Olu Test-Owner; "Last edited by" Ada Test-Admin + "3 days ago"; "Version" "Version 3" + an inline "History" link that toggles the panel | design §5 | trimmed by owner 2026-10-17 | skipped | | |
| DOC6 | Doc page › Linked from | page-live | label + count 1; row "Links and backlinks test" with its path ("Engineering") | design §5; brief (backlinks, live sources) | trimmed by owner 2026-10-17 | skipped | | |
| DOC7 | Doc page › links | page-links (test-links) | `[[test-authentication]]` renders as an accent link (page icon, 34% underline) titled "Authentication"; click opens it and expands the tree to it | design §5, §0.1; brief (links) | accent link with the page icon, tooltip "Architecture › API › Authentication"; click opens it, its row active, ancestors open | pass | docs-library-shots/batch-a/DOC7-DOC9-links.jpg; DOM read |  |
| DOC8 | Doc page › links | page-links | `[[test-rate-limits\|the rate limits]]` shows "the rate limits" and opens Rate limits | brief (`[[slug\|label]]`) | trimmed by owner 2026-10-17 | skipped | | |
| DOC9 | Doc page › broken link | page-links | `[[test-no-such-page]]` is flagged text (not a working link) with a `data-mtip` saying the page does not exist | brief "a broken one … flagged text with a data-mtip" | flagged span (dashed amber underline), tooltip "No page is called “test-no-such-page” yet. The link starts working once one is." | pass | docs-library-shots/batch-a/DOC7-DOC9-links.jpg |  |
| DOC10 | Doc page › code | page-links | `` `[[test-in-code]]` `` and the fenced `[[test-in-fence]]` show as written code, not links | brief "Code spans and fenced blocks are not scanned" | trimmed by owner 2026-10-17 | skipped | | |
| DOC11 | Doc page › link hover card | page-links; hover the Authentication link | a 280px card 6px below the link: path "Engineering › Architecture › API", title, description (or "Linked from this page."), status mark + "· Updated ‹when›"; gone on mouseleave and on scroll | design §5 | trimmed by owner 2026-10-17 | skipped | | |
| DOC12 | Doc page | page-pending (test-rate-limits) | banner (amber ring) "You're reading the live version. A change to this page is waiting for review." + "Open in Review ›"; meta "Change pending review"; the LIVE body ("100 requests a minute."); Version note "Version 2 is waiting for review" | design §5 | banner + Open in Review; "Change pending review" · Updated 2 weeks ago by Olu; live body "100 requests a minute."; rail "Version 2 is waiting for review" | pass | page text read |  |
| DOC13 | Doc page | page-staged (test-first-change, written by an agent) | banner (dashed ring) "This page isn't live yet. It is waiting for someone to approve it." + "Open in Review ›" | owner ruling 2026-10-17 | before: "…It is waiting for someone to approve it. Only people who can review see it."; after: "This page isn't live yet. It is waiting for someone to approve it." + Open in Review | fail → fixed | docs-library-shots/batch-a/DOC13-DP14-agent-staged-member.jpg | a9674f0b (tree) |
| DOC14 | Doc page | page-imported-staged (test-imp-first-week) | banner (dashed ring) "This page isn't live yet. It was imported and is waiting for someone to approve it. Only people who can review see it."; meta "Not yet approved" · "Imported ‹when› by Ada"; history "v1 Imported from handbook/onboarding/first-week.md"; Version "Version 1" + "Not approved yet"; "Imported from" handbook/onboarding/first-week.md "in test-handbook-v2.zip"; Linked from "No pages link here yet. Links from other pages show up once this one is approved."; no "Pages under" | design §5 | dashed banner "…It was imported and is waiting for someone to approve it." (its last sentence dropped by ruling DP14); Not yet approved · Imported 75 minutes ago by Ada; History v1 "Imported from handbook/onboarding/first-week.md"; Version 1 / Not approved yet; Imported from … in test-handbook-v2.zip; the Linked from copy; no Pages under | pass | docs-library-shots/batch-a/DOC14-imported-staged.jpg |  |
| DOC15 | Doc page › children | page-live (Authentication) | "Pages under Authentication" with cards Single sign-on, Tokens for agents (description, else "Part of Authentication."); a card opens the child | design §5 | trimmed by owner 2026-10-17 | skipped | | |
| DOC16 | Doc page › code block | page-live | the code block's "Copy" copies it and flips to "Copied" with a green check for ~1.4s | design §5 | trimmed by owner 2026-10-17 | skipped | | |
| DOC17 | Doc page | space-archived (`#doc/test-old-wiki-home`) | the page reads normally | brief (archived pages stay readable) | trimmed by owner 2026-10-17 | skipped | | |
| DOC18 | Doc page | page-xss | the title shows the literal `<img …>` text; the body's script and onerror do nothing (no alert); the javascript: link does not run | prompt (injection) | h1 literal `<img …> Injection test`; no img / script / on* attribute / javascript: link in the article; an alert stub was never called | pass | DOM read |  |
| DOC19 | Doc page | page-unicode | "Ünïcödé — 日本語のページ 🚀 test" correct in h1, breadcrumb, pane, tab title | prompt (unicode) | trimmed by owner 2026-10-17 | skipped | | |
| DOC20 | Doc page | `#doc/test-nope` | a "no such page" sentence; no crash | CLAUDE.md invariant 7 | "There is no page here. It may have been moved, or the link is wrong."; no console error | pass | docs-library-shots/batch-a/DOC20-no-such-page.jpg; console |  |
| DOC21 | Doc page | admin of test-docs; `#doc/test-other-secret` | not found — the other org's page is never shown | CLAUDE.md invariant 4 | trimmed by owner 2026-10-17 | skipped | | |
| DOC22 | Doc page | tree-deep-10, `#doc/test-deep-9` | the 10-crumb breadcrumb wraps or truncates inside the article; no horizontal scroll | design §5; prompt | trimmed by owner 2026-10-17 | skipped | | |
| DOC23 | Doc page | `GET /doc/:slug` delayed | the article and rail skeletons of design §5 | design §5 loading | trimmed by owner 2026-10-17 | skipped | | |
| DOC24 | Doc page › when() | page-pending history; page-live | "45 minutes ago" (0.03 day, rounded to 5), "2 weeks ago" (14 days), "2 months ago" (60 days) | design §0.3 | trimmed by owner 2026-10-17 | skipped | | |
| DOC25 | Doc page | page-pending; "Open in Review ›" | goes to Review | design §5 | trimmed by owner 2026-10-17 | skipped | | |
| DOC26 | Doc page › links | page-links | the cross-space link (Pricing and plans), the link to a never-approved page (Your first change) and to the archived space's page (Old wiki home) are links that open their page | brief (broken = no such doc) | trimmed by owner 2026-10-17 | skipped | | |

### NP — New page

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| NP1 | New page | Engineering home › New page, member | h1 "New page"; "Goes in" button with a 16px tile + "Engineering" (top level) + chevron; the pane visible | design §6, §4 | h1 New page; Goes in: tile + Engineering; the pane shown | pass | docs-library-shots/batch-a/DP8-NP6-newpage-inside-api.jpg; DOM read |  |
| NP2 | New page | pane row "API" › "+" | "Goes in" reads "Engineering › Architecture › API" | design §6 | trimmed by owner 2026-10-17 | skipped | | |
| NP3 | New page › picker | spaces-many | a 340px popover; the spaces as `segmented()` — or a `dropdown()` where six do not fit; the tree below; Done | design §6; CLAUDE.md (dropdown when no room) | trimmed by owner 2026-10-17 | skipped | | |
| NP4 | New page › picker | spaces-one | one space option | design §6 | trimmed by owner 2026-10-17 | skipped | | |
| NP5 | New page › picker | Engineering | first row "Top level of Engineering"; pages indented 10 + depth × 16 with their own chevrons, expanding to depth 2; the pick gets the tint + check; Done closes; the location follows | design §6 | 340 px picker (a dropdown: six spaces); "Top level of Engineering" tinted with its check; rows with chevrons; Architecture › API opened and picked; Done; Goes in "Engineering › Architecture › API" | pass | docs-library-shots/batch-a/NP5-picker.jpg; DOM read |  |
| NP6 | New page › templates | any | "Pick a template": 9 cards in order Guide, How-to, Reference, Runbook, Spec, Product brief, Decision record, Onboarding, Blank with the design's descriptions and icons; Runbook selected; Blank dashed | design §6, §6.1; brief | 9 cards in order, Runbook selected, Blank drawn apart (`is-blank`) | pass | docs-library-shots/batch-a/DP8-NP6-newpage-inside-api.jpg |  |
| NP7 | New page › preview | pick each template | "Preview", the name, description; the mini page with the template's sections (§6.1); Blank: "An empty page, ready for you." | design §6, §6.1 | trimmed by owner 2026-10-17 | skipped | | |
| NP8 | New page › Title | Runbook, then Spec | placeholder "Untitled runbook", then "Untitled spec" | design §6 | trimmed by owner 2026-10-17 | skipped | | |
| NP9 | New page › Create page | member, Engineering top level, title "Test NP9" | Create page stages the page for Review (not live); it lands on the new page, shown "Not yet approved", with the toast "Page created in Engineering" | owner ruling 2026-10-17 | before: toast "Staged for review in Engineering" and Review; after the fix (member): lands on #doc/test-np9, "Not yet approved", toast "Page created in Engineering" (unit test; the toast was seen again on NP11), Review badge +1 | fail → fixed | docs-library-shots/batch-a/NP9-created-lands-on-page-member.jpg | b5a97f2e (tree) |
| NP10 | New page › section | Decision record, Product brief, Spec, Guide | the staged proposal's section: decisions, context, context, reference (the request body) | brief (Templates) | trimmed by owner 2026-10-17 | skipped | | |
| NP11 | New page › create | under API, title "Test NP11" | DB: `docs` row parent_slug `test-api`, current_version 0, space engineering; it shows under API in the tree with the dashed ring | brief "on a NEW doc the row takes it at insert … Not yet approved in the tree" | under API: lands on #doc/test-np11, depth 2 under API with the dashed ring; D1 parent_slug test-api, current_version 0, space engineering | pass | D1 row; DOM read |  |
| NP12 | New page › create | title "Test unicode" (slug of an existing page) | refused with a sentence; nothing staged | code `src/routes.ts` /docs/propose (409) | trimmed by owner 2026-10-17 | skipped | | |
| NP13 | New page | member | a member can create a page | design §12 | trimmed by owner 2026-10-17 | skipped | | |
| NP14 | New page | space-archived | Old Wiki is not offered in the picker; a propose naming it is refused | brief (archived takes no new page) | trimmed by owner 2026-10-17 | skipped | | |
| NP15 | New page | parent test-deep-9 (would be level 11) | the page is created at the space's top level and the person is told the parent was ignored | brief "invalid parent … ignored with a note" | from the level-ten row's +: Goes in shows the 11-level path; created at depth 0; toast "Page created in Engineering, at the top level: that parent page could not take it" | pass | DOM read; re-seeded after |  |
| NP16 | New page | Blank, no title, no body | creates "Untitled blank" | design §6 | trimmed by owner 2026-10-17 | skipped | | |
| NP17 | New page | double-click Create page | one page | prompt (duplicate submit) | double-click on Create page: one doc (D1: one Test NP11 row, one version) | pass | D1 rows |  |
| NP18 | New page | SaplingLearn (team), AndresL230; a handoff's "Promote to doc" | New page opens prefilled (title / body from the handoff) on Blank | code (arch: handoff promote); base flow B03 | trimmed by owner 2026-10-17 | skipped | | |
| NP19 | New page | spaces-none | the empty layout (`emptyLayout()`) saying a space is needed first, with "New space" for an admin (none for a member) | owner ruling 2026-10-17 | before: the empty layout with no action for anyone; after the fix: admin gets New space (opens the dialog), a member no action | fail → fixed | docs-library-shots/batch-a/NP19-SB7-newpage-nospaces-admin.jpg; DOM read as member | 27f64817 (tree) |
| NP20 | New page | title `<b>Test</b> 🚀` | the title shows as literal text in the tree, Review and the doc page | prompt (injection, unicode) | trimmed by owner 2026-10-17 | skipped | | |

### IW — Import wizard

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| IW1 | Import › Where | member, from Library | stepper Where / Files / Preview / Import (current step accent); h2 "Where should the pages go?" + "Pick a space. You can also put everything inside a page that already exists."; 3-column space cards (24px tile, name, "N pages", check when picked); "Inside a page" + "Optional" tree with "Top level of ‹Space›"; footer "Pages will go in ‹Space›", Cancel (→ Library), "Continue ›"; no docs pane | design §8, §8.1 | member, #import: stepper Where (current, accent) / Files / Preview / Import; h2 + sub as designed; 6 space cards in 3 columns (tile, name, "N pages"); before a pick the footer says "Pick a space first."; Engineering picked: check, "Inside a page · Optional" tree with "Top level of Engineering" checked, footer "Pages will go in Engineering", Cancel, Continue ›; no docs pane | pass | docs-library-shots/batch-b/IW1-where-engineering-member.jpg |  |
| IW2 | Import › Where | pick Engineering, a parent, then Product | changing the space clears the parent | design §8.1 | trimmed by owner 2026-10-17 | skipped | | |
| IW3 | Import › Where | from Engineering home "Import" | Engineering preselected | design §4, §8 | trimmed by owner 2026-10-17 | skipped | | |
| IW4 | Import › Where | space-archived | Old Wiki / archived Design are not offered | brief (archived takes no new page) | trimmed by owner 2026-10-17 | skipped | | |
| IW5 | Import › Where | spaces-none | the empty layout (`emptyLayout()`) saying a space is needed first, with "New space" for an admin (none for a member) | owner ruling 2026-10-17 | as ruled, already built: admin sees "No spaces yet" + New space; member no action | pass (ruling checked in Batch A) | docs-library-shots/batch-a/IW5-import-nospaces-admin.jpg; DOM read as member |  |
| IW6 | Import › Files | Engineering | h2 "Add your files" + "Markdown files (.md), or one .zip of Markdown files. Folders inside a zip become pages with the files nested under them."; 200px drop zone: "Drop files here", "or", "Choose files", "Up to 500 files or 50 MB"; hidden input `multiple`, `accept=".md,.markdown,.zip"`; footer "Going to Engineering", Back, "Check the files ›" disabled | design §8.2 | trimmed by owner 2026-10-17 | skipped | | |
| IW7 | Import › Files | test-handbook.zip | a row: zip icon, name, "3 KB · zip", "Reading…" then a green check "Ready"; "Check the files ›" enabled | design §8.2 | trimmed by owner 2026-10-17 | skipped | | |
| IW8 | Import › Files | remove × | the row goes; with no file the button is disabled again | design §8.2 | trimmed by owner 2026-10-17 | skipped | | |
| IW9 | Import › Files → Preview | test-single.md + test-second.md | two rows "· Markdown"; Preview reads "From 2 files into Engineering" | design §8.2, §8.3 | rows "test-single.md · 1 KB · Markdown" and "test-second.md · 1 KB · Markdown", both Ready; Preview "From 2 files into Engineering. Nothing is added until you confirm.", 2 pages | pass | docs-library-shots/batch-b/IW9-two-md-files.jpg |  |
| IW10 | Import › Files | test-handbook.zip + test-single.md together | the zip is imported on its own; one sentence says the other files were left out because a zip is imported alone | owner ruling 2026-10-17 | as ruled, already built: test-handbook.zip + test-single.md chosen together → toast "A .zip is imported on its own: only test-handbook.zip was added.", the .md left out | pass (ruling checked in Batch A) | toast text + Files list read |  |
| IW11 | Import › Files | test-notes.txt via Choose files (all files) | the row says it can't be imported (not Markdown); not "Ready"; the button stays disabled | brief (.md only) | trimmed by owner 2026-10-17 | skipped | | |
| IW12 | Import › Preview | test-handbook.zip → Engineering top level | h2 "Check what will be added" + "From test-handbook.zip into Engineering. Nothing is added until you confirm."; summary 14 "pages to add", 6 "titles already exist" (the seed's Engineering already holds "Accounts and access", "Your first week" and "Runbooks"), 3 "files won't be imported", 2 "images found", 7 "links found"; "Pages to add" tree: Engineering handbook › Onboarding (Your first week, Local setup, Accounts and access), Practices (Code review, Testing ✅…), Operations (Deploys, Paging and escalation, Runbooks › Rolling back a bad deploy), glossary, Code sample — each with its source path; sticky footer "Pages go to Review first. Nothing is live until someone approves it." + "Add 14 pages to Review" | design §8.3; brief planner rules; owner ruling 2026-10-17: expected was wrong | everything as expected (sub, tree with each source path, Won't be imported 3, 2 images, 7 links, the sticky footer) EXCEPT the counts: 14 pages to add and 6 titles already exist ("Add 14 pages to Review"). The 3 extra conflicts are the seed's own Engineering pages: "Accounts and access" and "Your first week" (import 6302's never-approved pages, "Getting started › Onboarding (imported) › …") and the live "Runbooks" (the zip's runbooks/ folder page merges into it: flag "Skipped" while its choice reads Add as new version — a folder has no body to version, import.ts:373) | pass (expected rewritten by the owner) | docs-library-shots/batch-b/IW12-preview-handbook.jpg |  |
| IW13 | Import › Preview › conflicts | test-handbook.zip | "Already in Engineering" 3: Local setup "Already at Getting started › Local setup", Deploys "Already at Runbooks › Deploys", Paging and escalation "Already at Runbooks › Paging and escalation"; each Skip / Add as new version / Rename (default version → row flag "New version", amber tint); Skip → row struck through + "Skipped", count 14; Rename → input "Local setup (test-handbook)", row title follows, "Renamed" | design §8.3 | the 3 named conflicts with their "Already at …" paths and Skip / Add as new version / Rename; default New version (amber row, flag); Skip: row struck through + "Skipped", 14 → 13; Rename: input "Local setup (test-handbook)", the row's title follows, flag "Renamed"; For all shows neither option while mixed (plus the 3 seed conflicts of IW12) | pass | docs-library-shots/batch-b/IW13-rename-local-setup.jpg |  |
| IW14 | Import › Preview › For all | test-handbook.zip | "Skip all" / "New version for all" set every conflict; an option shows on only when every conflict has it | design §8.3 | trimmed by owner 2026-10-17 | skipped | | |
| IW15 | Import › Preview › Won't be imported | test-handbook.zip | 3 rows: handbook/design/logo.sketch "Not a Markdown file", handbook/notes/.DS_Store "Hidden system file", handbook/drafts/empty.md "The file is empty"; the attachments / images-only folders are not listed (they are images) | design §8.3; brief | trimmed by owner 2026-10-17 | skipped | | |
| IW16 | Import › Preview › Images and links | test-handbook.zip | images: uploaded with the pages that use them (1 used of 2 found); links: 7, of which 1 points to a file not in the zip and stays as plain text | design §8.3 | trimmed by owner 2026-10-17 | skipped | | |
| IW17 | Import › progress | start IW12 | card "Adding pages to Review" + accent %, "test-handbook.zip into Engineering", 6px bar, "x of 15 pages" / "y of 1 images", "Adding ‹path›", "You can leave this page. The import keeps going.", "Cancel import"; then Done | design §8.4 | /pages slowed 2.5 s: "Adding pages to Review" 7%, "test-handbook.zip into Engineering", the bar, "0 of 14 pages" / "1 of 1 image", "Adding handbook/README.md and 13 more", "You can leave this page. The import keeps going.", Cancel import; then Done; sidebar Imports badge 1 while running | pass | docs-library-shots/batch-b/IW17-progress.jpg |  |
| IW18 | Import › done | after IW17 | 40px check tile; "14 pages added to Review"; "Nothing is live yet. Once someone approves them in Review, they show up in Engineering. 3 files were skipped."; 9 "new pages" / 5 "new versions of existing pages" / 1 "images"; "Open Review ›", "See import details", "Import more"; all 4 steps done | design §8.5; owner ruling 2026-10-17: expected was wrong | check tile, "14 pages added to Review", "Nothing is live yet. Once someone approves them in Review, they show up in Engineering. 3 files were skipped.", 9 new pages / 5 new versions / 1 images, Open Review ›, See import details, Import more; 4 steps done (counts per IW12) | pass (expected rewritten by the owner) | docs-library-shots/batch-b/IW18-done.jpg |  |
| IW19 | Import › DB | after IW17 | one `doc_imports` row (partial: skipped files) with counts and failures (codes only); 14 staged `doc_versions` with import_id / import_path; nothing live (new docs current_version 0; Local setup / Deploys / Paging still at their live version); "Engineering handbook" is a top-level page of Engineering (no new space); flow.png in `doc_images` and the README body says `/img/<sha256>`; the .md links are `[[slug]]`; the missing link plain text; the code block untouched | brief (Import flow, planner rules); owner ruling 2026-10-17: expected was wrong | run 6311 partial; failures = codes only (not_markdown, empty, hidden); 14 staged versions with import_id 6311 + import_path; new docs current_version 0; test-local-setup / test-deploys / test-paging still at live v1 (their new versions staged); "handbook" is a top-level page of Engineering, no new space (8 = the seed's); doc_images 4977…1581 image/png 70 B; README body `/img/4977…`, `[[test-local-setup\|Local setup]]`, `[[glossary\|the glossary]]`, the missing link plain text; code.md's fence untouched; no console error | pass (expected rewritten by the owner) | D1 rows (doc_imports, doc_versions, doc_images, docs) |  |
| IW20 | Import › parent | test-two-folders.zip into Engineering › Runbooks | the zip's top-level pages are children of Runbooks | brief (optional parent) | trimmed by owner 2026-10-17 | skipped | | |
| IW21 | Import › Skip all | test-handbook.zip, Skip all | no staged version on Local setup / Deploys / Paging; 9 pages (the 6 existing titles all skipped) | design §8.3; owner ruling 2026-10-17: expected was wrong | Skip all → every conflict Skip, all rows struck "Skipped", "Add 9 pages"; run 6312 staged handbook, code, glossary, onboarding, operations, rollback, practices, code-review, testing — no version on Local setup / Deploys / Paging (9, not 12: the 3 seed conflicts of IW12 are skipped too) | pass (expected rewritten by the owner) | docs-library-shots/batch-b/IW21-skip-all.jpg; D1 doc_versions |  |
| IW22 | Import › Rename | Local setup → "Local setup (test-handbook)" | a NEW page with that title (new slug); Local setup untouched | brief (rename) | run 6313: a new page slug `local-setup`, title "Local setup (test-handbook)", v1 staged under onboarding; test-local-setup untouched (v1 promoted + the seed's 6302 v2 only); Done 10 new / 4 versions | pass | D1 docs + doc_versions |  |
| IW23 | Import › Cancel import | mid-run (pages slowed) | the run is abandoned (`cancelled`); toast "Import cancelled. N pages already added stay in Review." (N = the pages already staged) | owner ruling 2026-10-17 | test-exactly-500-files.zip (501 pages, 25 a batch), /pages slowed 3 s; Cancel import at "50 of 501" → toast "Import cancelled. 100 pages already added stay in Review." (two more batches had landed by the click); run 6314 abandoned, failures [{path:null, code:cancelled}], counts.staged 100 = 100 doc_versions rows; network: 4 × pages 200, then finish 200; the wizard back at Preview | pass | toast text; D1; network log |  |
| IW24 | Import › leave | mid-run, go to Library | it keeps going; the sidebar Imports badge "1"; Imports history "In progress" | design §8.4, §1.1 | trimmed by owner 2026-10-17 | skipped | | |
| IW25 | Import › reload | mid-run, reload | a leave prompt; after the reload the run stops and later reads as stopped (abandoned) once its heartbeat is stale; pages already sent stay in Review | brief (lock stale after a heartbeat window) | exactly-500 zip, /pages slowed; a synthetic beforeunload came back defaultPrevented (the leave prompt is armed). The reload itself: I patched preventDefault / returnValue and reloaded, the screenshot call then hung 30 s (the native prompt most likely showed in spite of the patch), Escape, and the page reloaded. After: the wizard fresh at Where; run 6317 running with its heartbeat stopped at 16:14:11, 175 pages staged (= rows); history "In progress · 175 of 501"; 3 minutes later (IMPORT_STALE_MS) "Stopped", Pages 175, Review badge 186 (11 + 175) | pass | docs-library-shots/batch-b/IW25-after-reload-in-progress.jpg, docs-library-shots/batch-b/IW25-stale-reads-stopped.jpg; D1 |  |
| IW26 | Import › network failure | `/imports/:id/pages` fails once | the run stalls with a sentence and Retry; Retry resends; no page staged twice | brief (ledger replay) | (a) the first /pages throws before sending: "0 of 14 pages", red "The connection dropped while the files were being sent. Retry sends them again; nothing is added twice.", Retry, Cancel import; Retry → pages 200, finish 200, Done; 14 versions / 14 slugs. (b) the first /pages reaches the server (200) and its answer is lost: same stall; Retry → replayed, run 6316 14 versions / 14 distinct slugs, counts.staged 14. Note: the stalled card still says "You can leave this page. The import keeps going." — B2: the stalled card now says "Nothing more is sent until you press Retry." (4f0294f1); Retry → the done card | pass | docs-library-shots/batch-b/IW26-stalled-retry.jpg; D1; docs-library-shots/batch-b2/F3-stalled-card.jpg |  |
| IW27 | Import › double submit | double-click "Add 15 pages to Review" | one run | prompt; brief (one running import per org) | trimmed by owner 2026-10-17 | skipped | | |
| IW28 | Import › lock | import-running (test-docs-one), member starts another | refused with a sentence that another import is running | brief (lock) | trimmed by owner 2026-10-17 | skipped | | |
| IW29 | Import › stale | test-docs (only the stale run 6306) | a new import starts | brief (stale lock) | trimmed by owner 2026-10-17 | skipped | | |
| IW30 | Import › rate limit | admin; 21 starts in a day | the 21st is refused (429) with a sentence | brief (`doc_import` in LIMITS) | admin with 20 `doc_import` units today (abuse_counters set to 20): Add 1 page to Review → POST /imports 429; red line "You've hit today's limit for this; try again after 8:00 PM."; no run written; stays at Preview (the counter row removed after) | pass | docs-library-shots/batch-b/IW30-rate-limit.jpg; network 429 |  |
| IW31 | Import › damaged zip | test-damaged-truncated.zip | "This zip is damaged or unsupported."; not Ready; nothing sent | brief (zip reader) | row "test-damaged-truncated.zip · 1 KB · zip" + red "This zip is damaged or unsupported."; Check the files disabled; no request | pass | docs-library-shots/batch-b/IW31-damaged-zip.jpg |  |
| IW32 | Import › damaged zip | test-damaged-crc.zip | same as IW31 | brief | trimmed by owner 2026-10-17 | skipped | | |
| IW33 | Import › encrypted | test-encrypted.zip | same as IW31 (unsupported) | brief "zip64/encrypted → damaged or unsupported" | trimmed by owner 2026-10-17 | skipped | | |
| IW34 | Import › method | test-unsupported-method.zip | same as IW31 | brief "stored + deflate only" | trimmed by owner 2026-10-17 | skipped | | |
| IW35 | Import › cap | test-over-500-files.zip | refused before anything is sent (over 500 files) | brief caps; design §8.2 copy | "This zip has more than 500 files. Up to 500 files or 50 MB can be imported at once."; Check the files disabled; nothing sent. (IW51's 50 MB message checked too: test-over-50mb.zip → "This zip is over 50 MB unpacked. Up to 500 files or 50 MB can be imported at once.") | pass | docs-library-shots/batch-b/IW35-over-500-files.jpg |  |
| IW36 | Import › cap | test-exactly-500-files.zip | accepted: Preview lists the 500 pages and the folder's page | brief caps | trimmed by owner 2026-10-17 | skipped | | |
| IW37 | Import › cap | test-over-50mb.zip | refused before inflating (over 50 MB); nothing sent | brief caps | trimmed by owner 2026-10-17 | skipped | | |
| IW38 | Import › no Markdown | test-no-markdown.zip | refused: nothing to import | code `no_markdown`; brief | trimmed by owner 2026-10-17 | skipped | | |
| IW39 | Import › traversal | test-traversal.zip | `../evil.md`, `/abs.md`, `a/../../b.md`, `..\win.md` listed as won't be imported ("The file's name or folder isn't allowed"); only "The good page" is a page | brief (path safety) | Preview: 2 pages — the folder page "Ok" (ok/, the brief's folder rule) and "The good page"; Won't be imported 4: ../evil.md, ../win.md (the zip's ..\win.md shown normalised), /abs.md, a/../../b.md, each "The file's name or folder isn't allowed" | pass | docs-library-shots/batch-b/IW39-traversal.jpg |  |
| IW40 | Import › too deep | test-too-deep.zip | deep.md listed "Nested more than 10 levels deep"; "Shallow" imported | brief MAX_DEPTH; code SKIP_REASONS | trimmed by owner 2026-10-17 | skipped | | |
| IW41 | Import › too deep under a parent | test-two-folders.zip under test-deep-8 (level 9) | no page lands deeper than level 10: what would go past it is refused or listed, never stored deeper | brief MAX_DEPTH | trimmed by owner 2026-10-17 | skipped | | |
| IW42 | Import › page cap | test-big-page.zip | huge.md "The file is too large"; small.md imported | brief (1 MB per file) | trimmed by owner 2026-10-17 | skipped | | |
| IW43 | Import › images | test-images.zip | ok.png uploaded (`/img/<sha>` in the body); fake.png refused as not an image (its reference stays plain / alt text); huge.png over 10 MB not uploaded and said | brief (images, sniffed, 10 MB) | trimmed by owner 2026-10-17 | skipped | | |
| IW44 | Import › duplicates | test-duplicate.zip | one page; the other file "Another file has the same name" | code SKIP_REASONS | trimmed by owner 2026-10-17 | skipped | | |
| IW45 | Import › not UTF-8 | test-not-utf8.md | "The file isn't readable text"; not imported | brief (UTF-8) | trimmed by owner 2026-10-17 | skipped | | |
| IW46 | Import › empty | test-empty.md | "The file is empty"; not imported | design §8.3 | trimmed by owner 2026-10-17 | skipped | | |
| IW47 | Import › stored | test-stored.zip | reads and imports "Stored page" | brief (stored + deflate) | trimmed by owner 2026-10-17 | skipped | | |
| IW48 | Import › folders | test-two-folders.zip → Product | three top-level pages in Product (Alpha, Beta folder pages with their intro, "A loose page"); no new space | brief "never new spaces" | trimmed by owner 2026-10-17 | skipped | | |
| IW49 | Import › injection | test-xss.md | the title shows literally in Preview, Review and the doc page; nothing executes | prompt (injection) | trimmed by owner 2026-10-17 | skipped | | |
| IW50 | Import › conflict (loose) | test-local-setup.md → Engineering | one conflict "Already at Getting started › Local setup" with the three choices | design §8.3 | trimmed by owner 2026-10-17 | skipped | | |
| IW51 | Import › messages | IW31–IW38 | each over-limit message names the limit: over 500 files ("500 files"), over 50 MB ("50 MB"), a page over 1 MB ("1 MB") | owner ruling 2026-10-17 | the 500-file / 50 MB refusals already named their limits; a skipped page said only "The file is too large". After the fix: "Larger than 1 MB, the most a page can be" (images: 10 MB) | fail → fixed (Batch B, IW35: the 500-file and 50 MB messages checked live, both name their limit) | docs-library-shots/batch-a/IW51-page-over-1mb-reason.jpg | 9dfa8638 (import) |
| IW52 | Import › done buttons | after IW18 | "Open Review ›" → Review; "See import details" → Imports; "Import more" → Files with no file | design §8.5 | trimmed by owner 2026-10-17 | skipped | | |

### DR — Drop to import

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| DR1 | Drop overlay | Engineering home; drag 2 .md over the main column | veil + inset 14px dashed accent edge; 48px tile with upload icon; "Drop to import into Engineering"; "2 Markdown files. You can check everything before it goes to Review." | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR2 | Drop overlay | one .md | "1 file. You can check everything before it goes to Review." | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR3 | Drop | drop 2 .md on Engineering home | the wizard at Preview with Engineering preset | design §10 | synthetic drag of test-single.md + test-second.md on Engineering home: overlay "Drop to import into Engineering" / "2 Markdown files. You can check everything before it goes to Review."; drop → #import/engineering at Preview, "From 2 files into Engineering", 2 pages | pass | docs-library-shots/batch-b/DR3-drop-two-md-preview.jpg |  |
| DR4 | Drop overlay (bad) | drag test-report.pdf | red dashed edge, red ban tile; "Only Markdown files can be imported"; "test-report.pdf isn't a Markdown file. Drop .md files, or one .zip of them." | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR5 | Drop (bad) | drop test-report.pdf on the main column | toast "test-report.pdf isn't a Markdown file. Use .md files or a .zip of them."; nothing opens | design §10 | drag of test-report.pdf: the bad overlay ("Only Markdown files can be imported"); drop → toast "test-report.pdf isn't a Markdown file. Use .md files or a .zip of them."; stays on #library/engineering | pass | overlay DOM + toast text |  |
| DR6 | Drop › sidebar row | drag 2 .md over the Product row | the row tinted + ringed; pill "Drop to import into Product" + "2 files"; the main column veiled lightly | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR7 | Drop › sidebar row | drop on Product | the wizard at Preview with Product preset | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR8 | Drop › sidebar row (bad) | drop test-notes.txt on a row | toast "Only Markdown files, or a .zip of them, can be imported." | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR9 | Drop | drop test-handbook.zip on a doc page and on New page | Preview with that page's space | design §10 | trimmed by owner 2026-10-17 | skipped | | |
| DR10 | Drop | Library home, Imports, Review, an archived space's home | dropping good files on Library home or Imports opens the wizard at Where with the files kept (no space preset); Review and an archived space's home are not drop targets (no overlay) | owner ruling 2026-10-17 | before: Library home / Imports ignored a drop; after the fix both open #import at Where with the file kept (Files lists it once a space is picked); Review and #library/old-wiki show no overlay and do not take the drop | fail → fixed | docs-library-shots/batch-a/DR10-dropped-on-imports-opens-where.jpg; synthetic DragEvents | 9bacbd2d (import) |
| DR11 | Drop | on the Import screen | not a drop target for this overlay (the Files step has its own zone) | design §10 | trimmed by owner 2026-10-17 | skipped | | |

### IH — Imports history

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| IH1 | Imports | imports-history, admin | h1 "Imports" + "Every Markdown import into the library, newest first." + "Import"; header File / Into / Status / Pages / Run by / When; rows newest first (6306 … 6301): icon, file name, size line ("3.1 MB · 8 files"), Into tile + path ("Engineering › Getting started"), status mark, Pages, avatar + short name, When; chevron | design §11 | as expected: header, sub, Import, File / Into / Status / Pages / Run by / When, rows 6306 → 6301 (Stopped, Cancelled, Failed, Done, Done with skipped files, Done), "3.0 MB · 8 files", "Engineering › Getting start…" (ellipsis), avatars + short names, chevrons. Seed note: the rows go by id, and the seed's start times are not in id order ("3 days ago" above "Yesterday") — real ids follow start time — B2: the seed now starts the runs in id order (829577b6): When reads 30 / 45 / 60 / 70 minutes ago, An hour ago, 2 hours ago, newest first | pass | docs-library-shots/batch-b/IH1-imports-admin.jpg; docs-library-shots/batch-b2/F9-imports-in-id-order.jpg |  |
| IH2 | Imports › filter | imports-history | All 6 / In progress 0 / Done 3 (done ×2 + done with skipped files) / Failed 1 | design §11 | trimmed by owner 2026-10-17 | skipped | | |
| IH3 | Imports › partial | expand 6302 | "5 pages went to Review. 3 files were skipped:" + bordered list (file + reason) + "Open in Review ›" | design §11 | "5 pages went to Review. 3 files were skipped:" + the bordered list (logo.sketch Not a Markdown file, .DS_Store Hidden system file, drafts/empty.md The file is empty) + "Open in Review ›" (opens #review) | pass | docs-library-shots/batch-b/IH3-partial-expanded.jpg |  |
| IH4 | Imports › done | expand 6301 (2 pages, approved) | "2 pages were added and approved." + "Open in the library" → Engineering | design §11 | trimmed by owner 2026-10-17 | skipped | | |
| IH5 | Imports › done (1 page) | expand 6303 | "1 page was added and approved by Max." | design §11 | trimmed by owner 2026-10-17 | skipped | | |
| IH6 | Imports › failed | expand 6304; "Try another file" | the button opens Import at Files with Product preset | design §11 | trimmed by owner 2026-10-17 | skipped | | |
| IH7 | Imports › failed wording | expand 6304 (page failures: not UTF-8, couldn't be added) | the detail reads "Nothing was added." then each file with its reason | owner ruling 2026-10-17 | as ruled, already built: "Nothing was added. What went wrong:" + wiki/a.md "The file isn't readable text", wiki/b.md "It couldn't be added" | pass (ruling checked in Batch A) | row detail text |  |
| IH8 | Imports › abandoned | 6305 (cancelled), 6306 (stale) | 6305 reads "Cancelled", 6306 "Stopped" — neutral marks (faded), never red | owner ruling 2026-10-17 | as ruled, already built: 6305 "Cancelled", 6306 "Stopped", both the faded cross (fg-40); Failed is red | pass (ruling checked in Batch A) | DOM read (mark colours) |  |
| IH9 | Imports › rows | open 6302, then 6304 | one row open at a time; the chevron turns 90°; the open row has the faint background; detail indented 42px | design §11 | trimmed by owner 2026-10-17 | skipped | | |
| IH10 | Imports › in progress | import-running (test-docs-one), member (the starter) | "In progress" (progress pie); Pages "12 of 40"; detail "Adding pages to Engineering. You can leave this page; the import keeps going.", a 5px bar at 30%, "Cancel import" | design §11 | trimmed by owner 2026-10-17 | skipped | | |
| IH11 | Imports › cancel | IH10, Cancel import | toast "Import cancelled. Pages already added stay in Review."; the row no longer in progress; DB status abandoned with a `cancelled` failure | design §11; brief | trimmed by owner 2026-10-17 | skipped | | |
| IH12 | Imports › cancel (admin) | import-running, test-dl-admin (not the starter) | an admin who did not start the run sees "Cancel import" too, and it stops the run | owner ruling 2026-10-17 | before: Cancel import for the starter only; after the fix the admin sees it on Max's run; clicking it first answered 500 — the seed's run had a plan with no writes list (fixed in the seed, c79dbee7); then toast "Import cancelled. Pages already added stay in Review.", row Cancelled | fail → fixed | docs-library-shots/batch-a/IH12-admin-sees-cancel.jpg, docs-library-shots/batch-a/IH12-admin-cancelled.jpg | 47f18886 (import) + seed c79dbee7 |
| IH13 | Imports | spaces-none | dashed "No imports yet" + "Import Markdown files or a .zip of them, and each run is listed here with what was added and what was skipped." + outlined "Import"; 3 hollow rows; no filter counts | design §11 empty | trimmed by owner 2026-10-17 | skipped | | |
| IH14 | Imports | `/imports` delayed | 6 skeleton rows of 56px on the same grid | design §11 loading | trimmed by owner 2026-10-17 | skipped | | |
| IH15 | Imports › live | a run going in another tab | the open history updates (pages, bar, status) without a reload | code (polling) | trimmed by owner 2026-10-17 | skipped | | |
| IH16 | Imports | other-org | 6309 (test-docs-other) is not listed in test-docs | CLAUDE.md invariant 4 | trimmed by owner 2026-10-17 | skipped | | |
| IH17 | Imports › When | imports-history | the design's phrasing: "Just now", "2 hours ago", "Yesterday", a date like "Oct 12" for older | design §11 | trimmed by owner 2026-10-17 | skipped | | |

### RV — Review grouped by import

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| RV1 | Review | review-import-group + review-agent-group, admin | header "Review"; left: group cards — "Import from test-handbook-v2.zip" (upload icon on accent tint; "N pages · into Engineering · by Ada · ‹when›") and the agent's ("Written by …", spark on slate); actions "Review one by one", "Reject all", "Approve all N"; no docs pane | design §9 | (a) the agents' changes are NOT a group card ("Written by …", spark on slate): they stay one proposal card each under "Written by agents 7" — the design's agent group is not built (the area doc: "Review keeps its layout"). (b) BUG: the import card was 352 px in a 335 px row, so the left list scrolled sideways (scrollWidth 366 > 363). Fixed (b): the card fits, no sideways scroll. The rest as expected: header Review, "Import from test-handbook-v2.zip", upload icon on accent tint, "4 pages · into Engineering · by Ada · an hour ago", Review one by one / Reject all / Approve all 4, no docs pane — B2: (a) built (53f7f44a): "Written by Pia's agent", spark on slate, "7 pages · 30 minutes ago" with the 16px spark avatar, Review one by one / Reject all / Approve all 7, rows Deploys … Your first change ("Change" / "New page"); beside "Import from test-handbook-v2.zip" "4 pages · into Engineering · by Ada · an hour ago"; the list pane is the design's .95fr split (697 px here), every action row on one line; list scrollWidth 697 = clientWidth; no console error. Its Reject all asks "Reject 7 pages from Pia's agent?" / "The agent's changes are thrown away. The live pages stay as they are." and rejects all 7 (D1: rejected); its Approve all promotes the 7 one by one (7 × POST /doc/:slug/promote 200; test-moves-on-promote moved under test-runbooks, the bad parent ignored) | fail → fixed | docs-library-shots/batch-b/RV1-review-admin.jpg, docs-library-shots/batch-b/RV1-fixed-group-fits.jpg; docs-library-shots/batch-b2/RV1-agent-group-card.png, docs-library-shots/batch-b2/RV1-RV3-groups.jpg, docs-library-shots/batch-b2/RV-agent-reject-all-confirm.jpg, docs-library-shots/batch-b2/RV-agent-reject-all-toast.jpg, docs-library-shots/batch-b2/RV-agent-approve-all-after.jpg; D1 | fec5b340 + 53f7f44a (import) |
| RV2 | Review › filter | same | `segmented()` All / Imports / Written by agents with counts of pending pages; each filter shows only its groups | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV3 | Review › grouping | test-deploys (import v2 + agent v3 on top) | the page sits in the agent's group (its newest change); the import's older version is not approvable on its own (it is not offered as a page of the import group) | owner ruling 2026-10-17 | before: test-deploys v2 sat in the import's group beside the agent's v3; after the fix the group holds 4 pages (no Deploys), Deploys is the agent's card, and the badge equals the list (11) — B2 rerun: Deploys is a row of Pia's agent's group; the import group holds 4 pages (no Deploys); All 11 = the badge 11; after the agent's Reject all, the import's Deploys v2 is offered again (5 pages) — nothing on top of it any more | fail → fixed | docs-library-shots/batch-a/RV3-deploys-in-agent-group.jpg; docs-library-shots/batch-b2/RV1-RV3-groups.jpg | 796ad957 (import) |
| RV4 | Review › one by one | open the import group | rows 32px indented 16 + depth × 16, a dashed ring per undecided row, kinds "New page" / "New version"; the toggle reads "Hide pages" | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV5 | Review › page | select "Your first week" | right pane: "Page i of N · test-handbook-v2.zip" + prev / next (wrap); crumb "Engineering › Getting started › Onboarding (imported)"; h1; "New page" mark + "from handbook/onboarding/first-week.md"; the rendered page | design §9 | B2 (after 95dd9f50): "Page 2 of 4 · test-handbook-v2.zip" + prev / next; crumb "Engineering › Getting started › Onboarding (imported)"; h1-sized title "Your first week"; "New page" (dashed ring) + "from handbook/onboarding/first-week.md"; then the page rendered (the reader's renderer); no diff box for a new page; footer "Approving makes this page live for everyone." + Reject + ✓ Approve. At 360 px: the pane alone with "‹ All items", the footer's sentence on its own line, nothing past the edge (360 = 360). Batch B saw the old layout (no crumb, the Unified diff first) | fail → fixed | docs-library-shots/batch-b/RV5-import-page-selected.jpg (before); docs-library-shots/batch-b2/RV5-page-pane-new-page.jpg, docs-library-shots/batch-b2/RV-page-pane-360.jpg | 95dd9f50 (import) |
| RV6 | Review › diff | select Local setup (new version) | "New version of Local setup"; diff box "What changes" + "N lines added, M removed"; removals red "−", additions green "+" | design §9 | B2 (after 95dd9f50): "New version of Local setup" + "from handbook/onboarding/local-setup.md"; the diff box "What changes" + "1 line added, 1 removed": − red "Install Node 18 and pnpm.", + green "Install Node 20 and pnpm 9." (context line "# Local setup" plain); then the page rendered. An agent's change reads "Change to a live page" (Rate limits: crumb "Engineering › Architecture › API"). Batch B saw "New version" and the old "WHAT CHANGED" with no counts | fail → fixed | docs-library-shots/batch-b/RV6-new-version-diff.jpg (before); docs-library-shots/batch-b2/RV6-page-pane-new-version.jpg, docs-library-shots/batch-b2/RV-page-pane-agent-change.jpg | 95dd9f50 (import) |
| RV7 | Review › decide | undecided page | footer "Approving makes this page live for everyone." + Reject + "✓ Approve"; deciding moves to the next undecided page of the group | design §9 | B2 (after 95dd9f50 + 4f0336c2): the footer "Approving makes this page live for everyone." + Reject + ✓ Approve. Enter on a focused ✓ Approve (Onboarding (imported), page 1) → promoted, the next undecided page opens ("Page 2 of 4", Your first week), "1 of 4 reviewed", "Approve 3 left", and the focus is on the new page's ✓ Approve. Approve on Local setup (page 4 of 4) → wraps to Onboarding (imported) reading "Page 1 of 4" (Batch B read "Page 2 of 4": fixed, 4f0336c2), then Your first week "Page 2 of 4". On the agent group: Approve on Rate limits (page 2 of 7) → Bad parent on promote "Page 3 of 7", "1 of 7 reviewed", "Approve 6 left" | fail → fixed | docs-library-shots/batch-b/RV7-after-promote-advanced.jpg (before); docs-library-shots/batch-b2/RV7-approve-advances.jpg, docs-library-shots/batch-b2/F8-page-position-stable.jpg | 95dd9f50 + 4f0336c2 (import) |
| RV8 | Review › decided | after RV7 | the mark "Approved" / "Rejected", "Undo", "Next page ›" | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV9 | Review › progress | 2 decided | "2 of N reviewed"; the button "Approve k left" | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV10 | Review › Approve all | the import group | every undecided page approved; verdict overlay "✓ Approved", the card collapses and goes (~330ms); toast "‹k› pages are now live in Engineering" + "Open Engineering"; DB versions promoted, current_version raised, parents applied, doc_links written | design §9; brief | Approve 3 left → the group leaves; toast "3 pages are now live in Engineering · Open Engineering"; badge 10 → 7; D1: the 3 new pages promoted (current_version 1, parents test-getting-started / test-imp-onboarding), test-local-setup v2 promoted (cur 2); test-deploys v2 (agent's v3 on top) still staged; no [[links]] in these bodies, so no doc_links rows. The ~330 ms verdict overlay was not captured — B2 rerun (fresh seed): Approve all 4 → the group leaves; toast "4 pages are now live in Engineering · Open Engineering"; Review 11 → 7; D1: the 3 new pages promoted (cur 1, parents test-getting-started / test-imp-onboarding), test-local-setup cur 2; test-deploys v2 (the agent's v3 on top) still staged, cur 1 | pass | docs-library-shots/batch-b/RV10-approve-all-toast.jpg; D1; docs-library-shots/batch-b2/RV10-approve-all-toast.jpg; D1 |  |
| RV11 | Review › Approve all | test-deploys (agent's v3 on top of the import's v2) | Approve all leaves test-deploys alone: still live v1, both staged | code `src/imports/runs.ts` (someone else's change on top) | trimmed by owner 2026-10-17 | skipped | | |
| RV12 | Review › Reject all | the import group | `confirmModal` "Reject ‹k› pages from test-handbook-v2.zip?" / "They won't be added to Engineering. The import stays in Imports, so you can run it again later." / Cancel + red "Reject ‹k› pages" | design §9; CLAUDE.md (confirmModal) | confirmModal "Reject 4 pages from test-handbook-v2.zip?" / "They won't be added to Engineering. The import stays in Imports, so you can run it again later." / Cancel + red "Reject 4 pages" — B2 rerun: the same dialog, word for word — Batch C: the same words; but opened with Enter the focus stayed on Reject all behind the modal (a finding outside the expected). Fixed: the red "Reject 4 pages" takes the focus, Escape gives it back to that group's Reject all (import and agent groups) | pass | docs-library-shots/batch-b/RV12-reject-all-confirm.jpg; docs-library-shots/batch-b2/RV12-reject-all-confirm.jpg; docs-library-shots/batch-c/RV12-reject-all-confirm.jpg, docs-library-shots/batch-c/RV12-reject-all-focus.jpg; document.activeElement | 1538fa3c (import, Batch C finding) |
| RV13 | Review › Reject all | Cancel | nothing changes | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV14 | Review › Reject all | confirm | the group leaves; toast "‹k› pages rejected" + "Open Engineering"; DB status rejected, bodies kept (soft) | design §9; brief (soft) | the group leaves; toast "4 pages rejected · Open Engineering"; badge 11 → 7; D1: 6302's 4 versions `rejected`, bodies kept; test-deploys v2 left staged — B2 rerun: group leaves; toast "4 pages rejected · Open Engineering"; Review 11 → 7, Imports 0; D1: the 4 versions of 6302 rejected, bodies kept (29–43 B); test-deploys v2 still staged | pass | docs-library-shots/batch-b/RV14-rejected-toast.jpg; D1; docs-library-shots/batch-b2/RV14-rejected-toast.jpg; D1 |  |
| RV15 | Review › agent group | review-agent-group | Approve all / Reject all on the agent's group; its confirm body "The agent's changes are thrown away. The live pages stay as they are." | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV16 | Review › last page | decide the group's last undecided page | the group leaves with "Every page from ‹short› has been reviewed" | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV17 | Review › nothing selected | load Review | right pane "Open a group and pick a page to read it here. Or approve a whole group at once." over a hollow page | design §9 | trimmed by owner 2026-10-17 | skipped | | |
| RV18 | Review | spaces-none (nothing waiting) | dashed "Nothing to review" + "Pages that are imported or written by agents wait here until someone approves them. You'll see each import as one group."; 2 hollow cards; right: the hollow outline | design §9 empty; owner ruling 2026-10-17 (take the design's words) | dashed box + 2 hollow group cards + the right hollow outline as designed; filter All 0 / Imports 0 / Written by agents 0; but the words are the base's sentence adapted — "Nothing is waiting for review. A doc change or a decision an agent stages, and the pages of a Markdown import, show here to approve or reject. Each import is one group." — no "Nothing to review" title. Review also lists ADR drafts, which the design's sentence leaves out — B2 (after 6848bb17): the dashed box reads the title "Nothing to review" and "Pages that are imported or written by agents wait here until someone approves them. You'll see each import as one group."; 2 hollow cards; the right hollow outline | fail → fixed (B2) | docs-library-shots/batch-b/RV18-review-empty.jpg; docs-library-shots/batch-b2/RV18-review-empty.jpg | 6848bb17 (import) |
| RV19 | Review | `/proposals` delayed | 3 skeleton group cards; right skeleton bars | design §9 loading | trimmed by owner 2026-10-17 | skipped | | |
| RV20 | Review | member | a member can Approve all / Reject all | design §9 (not gated); CLAUDE.md invariant 2 (cookie human action) | trimmed by owner 2026-10-17 | skipped | | |
| RV21 | Review › counts | after RV10 | the sidebar Review badge, Library waiting link and the space's waiting count drop by the approved pages | design §1.1, §3 | trimmed by owner 2026-10-17 | skipped | | |
| RV22 | Review | SaplingLearn (team), AndresL230 | the ADR drafts (decisions) are still listed and can be ratified / rejected as on base | base B02 (nothing in the spec removes them) | trimmed by owner 2026-10-17 | skipped | | |
| RV23 | Review › promote | proposal-parent (test-moves-on-promote v2) | after Promote the page sits under Runbooks | brief (parent applied on promote) | trimmed by owner 2026-10-17 | skipped | | |
| RV24 | Review › promote | proposal-badparent | promoted; the page stays where it was (the parent would be too deep) | brief "else the tree is left as is" | trimmed by owner 2026-10-17 | skipped | | |
| RV25 | Review › links on promote | approve a page whose body has `[[test-architecture]]` (test-single.md imported) | after promote Architecture's "Linked from" lists it | brief (doc_links rebuilt on promote) | trimmed by owner 2026-10-17 | skipped | | |
| RV26 | Review | SaplingLearn, AndresL230; promote one ordinary proposal | promotes as on base (no regression) | base B02 | trimmed by owner 2026-10-17 | skipped | | |

### TR — Unplaced › assign

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| TR1 | Unplaced | triage-space, admin; the `test-nowhere` item | reason "unknown space: test-nowhere" shown; "Doc section" asks for a space among the org's LIVE spaces by name (not technical / product) | brief (Triage › Unplaced assign) | trimmed by owner 2026-10-17 | skipped | | |
| TR2 | Unplaced › assign | TR1 → Engineering | a staged page in Engineering; the item leaves Unplaced (resolved) | brief | Doc section · reference · Engineering (the live spaces only) → File it: the item leaves (Unplaced 2 → 1, Review 11 → 12); D1 needs_triage resolved `assigned` doc:test-triaged-test-nowhere@1 by test-dl-admin; docs test-triaged-test-nowhere in engineering, cur 0, v1 staged | pass | docs-library-shots/batch-b/TR2-after-assign.jpg; D1 |  |
| TR3 | Unplaced | the `old-wiki` item | reason "archived space: old-wiki"; Old Wiki not offered | brief | trimmed by owner 2026-10-17 | skipped | | |
| TR4 | Unplaced | SaplingLearn, AndresL230 | items file as on base; the doc space choice lists Engineering / Product / Design | base B04; brief | trimmed by owner 2026-10-17 | skipped | | |

### API — HTTP routes

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| API1 | `/api/o/test-docs/spaces`, `/imports` | signed out (no DEV_LOGIN) | 401; no data | CLAUDE.md invariant 8 | trimmed by owner 2026-10-17 | skipped | | |
| API2 | `/test-docs/#library` | signed out | the sign-in / landing; no Library data requested successfully | CLAUDE.md invariant 8 | trimmed by owner 2026-10-17 | skipped | | |
| API3 | `/test-docs/#library` | test-dl-outsider | no access to test-docs (not a member); nothing of it shown | CLAUDE.md invariant 4 | trimmed by owner 2026-10-17 | skipped | | |
| API4 | `GET /api/o/test-docs/spaces`, `/imports`, `/doc/test-getting-started` | test-dl-outsider | refused (403 / 404); no test-docs data | CLAUDE.md invariant 4 | outsider's cookie: GET /api/o/test-docs/spaces, /imports, /doc/test-getting-started → 404 not_found each, the same body as a missing item | pass | curl |  |
| API5 | `GET /api/o/test-docs/doc/test-other-secret` | test-dl-admin | 404 | CLAUDE.md invariant 4 | trimmed by owner 2026-10-17 | skipped | | |
| API6 | `POST /spaces` | member | 403 forbidden | brief (admin cookie routes) | member POST /spaces → 403 forbidden | pass | curl |  |
| API7 | `PUT /spaces/engineering` | member: `{name}`, `{description}` | both 403 | brief | trimmed by owner 2026-10-17 | skipped | | |
| API8 | `PUT /spaces/engineering`, `/owners` | space owner: `{description}` 200, `{name}` 403, owners 200 | as stated | brief | space owner: PUT {description} 200 (stored), PUT {name} 403, PUT /owners 200. Note: that 403 tells an owner of this space "only an admin, or an owner of this space, can do that" (src/spaces/routes.ts:38, one message for every role refusal) | pass | curl |  |
| API9 | `POST /spaces/:slug/archive` / `restore` / `move` | member | 403 each | brief | trimmed by owner 2026-10-17 | skipped | | |
| API10 | `/spaces` GET + POST | bearer (member token) | refused (403 / 401); never served | brief (cookie-only); CLAUDE.md invariant 8 | member token on GET / POST /api/o/test-docs/spaces → 404: the bearer is never read (the same 404 as no header at all: DEV_LOGIN's own session, not in test-docs); nothing written | pass | curl; D1 (no test-api10 space) |  |
| API11 | `POST /imports` | bearer | refused | brief | trimmed by owner 2026-10-17 | skipped | | |
| API12 | `POST /doc/test-api/move` | bearer | refused | brief | trimmed by owner 2026-10-17 | skipped | | |
| API13 | `POST /imports/6302/approve-all` | bearer | refused | brief; CLAUDE.md invariant 2 | trimmed by owner 2026-10-17 | skipped | | |
| API14 | `POST /spaces` | admin: bad icon, bad color, empty name, 41-char name, 141-char description | 400 `invalid` with the field | code `src/tools/spaces.ts` | trimmed by owner 2026-10-17 | skipped | | |
| API15 | `POST /spaces` | admin, name "Old Wiki" | 201, slug `old-wiki-2` | brief (slug reserved forever) | trimmed by owner 2026-10-17 | skipped | | |
| API16 | `PUT /spaces/design/owners` | admin, `["test-dl-outsider"]` | 400 `not_member` | code | trimmed by owner 2026-10-17 | skipped | | |
| API17 | `GET /spaces/test-nope`, `/spaces/old-wiki` | member | 404; 200 with `archived: true` | code | trimmed by owner 2026-10-17 | skipped | | |
| API18 | `POST /docs/propose` | admin, space `old-wiki` | 400 "the old-wiki space is archived"; nothing staged | brief; code | trimmed by owner 2026-10-17 | skipped | | |
| API19 | `POST /docs/propose` | admin, space `technical` | staged in `engineering` | brief (aliases) | trimmed by owner 2026-10-17 | skipped | | |
| API20 | `GET /search?q=…&space=technical` / `space=test-nope` | member | Engineering pages / nothing | brief (filters) | trimmed by owner 2026-10-17 | skipped | | |
| API21 | `POST /imports` | member: no body, no files, files not an array | 400 `invalid` | code `src/imports/runs.ts` | trimmed by owner 2026-10-17 | skipped | | |
| API22 | `POST /imports` | member: manifest with `../evil.md`, `/abs.md` beside `ok.md` | the server's plan skips (or refuses) the unsafe paths; never a page outside the space | brief "server re-validates every file" | member POST /imports with ../evil.md, /abs.md, a/../../b.md, ..\win.md and ok.md → 201; run 6310's failures 4 × bad_path; the stored manifest's files and writes hold only ok.md (slug ok, top level) | pass | curl; D1 doc_imports |  |
| API23 | `POST /imports/:id/pages` | the starter, a path not in the manifest | 400 `not_in_manifest`; nothing staged | brief; code | trimmed by owner 2026-10-17 | skipped | | |
| API24 | `POST /imports/:id/pages` | another member on admin's run | 403 `forbidden` | code | trimmed by owner 2026-10-17 | skipped | | |
| API25 | `POST /imports/:id/pages` | the starter, text longer than declared | that page `failed` with `changed` | brief (the browser's plan is advisory); code | trimmed by owner 2026-10-17 | skipped | | |
| API26 | `POST /imports/:id/images` | text as `x.png`; an 11 MB body | 400 `not_an_image`; 413 `too_large` | brief (sniffed, 10 MB) | trimmed by owner 2026-10-17 | skipped | | |
| API27 | `GET /imports/abc` | member | 404 | code | trimmed by owner 2026-10-17 | skipped | | |
| API28 | `POST /imports/:id/finish` | another member (not the starter): plain finish 403; admin `{cancel:true}` ends it (abandoned) | as stated | code; commit 87d278eb | trimmed by owner 2026-10-17 | skipped | | |
| API29 | `POST /imports/6309/approve-all`, `reject-all` | test-docs admin (6309 is test-docs-other's) | 404 | CLAUDE.md invariant 4 | test-docs admin POST /imports/6309/approve-all and /reject-all → 404 "there is no such import" | pass | curl |  |
| API30 | `POST /doc/:slug/move` | admin: ref in Product (409 `other_space`), ref = itself (409 `self`), unknown ref (404), target "sideways" (400) | as stated | brief (same-space); code `doc-tree.ts` | trimmed by owner 2026-10-17 | skipped | | |
| API31 | `GET /proposals` | admin | each import version carries `import_id`, `import_path`, `import_file_name`, `import_by`, `import_at`; others null | brief "GET /proposals carries import_id / import file name" | trimmed by owner 2026-10-17 | skipped | | |
| API32 | `POST /imports` | admin: space `old-wiki` (409 `archived`); parent `test-pricing` with space engineering (404) | as stated | brief; code | trimmed by owner 2026-10-17 | skipped | | |

### MCP — tools

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| MCP1 | `list_spaces` | member token | the 6 live spaces (slug, name, description, page count); no archived | brief (MCP) | list_spaces → engineering 45, product 31, design 5, security 0, test-long-space 1, onboarding 1 (slug, name, description, pages); no old-wiki / design-old | pass | MCP response |  |
| MCP2 | `list_docs` | `space: "technical"`, `"product"`, `"test-nope"` | Engineering docs / Product docs / none | brief | trimmed by owner 2026-10-17 | skipped | | |
| MCP3 | `query` | `space: "engineering"` | results from Engineering only | brief | trimmed by owner 2026-10-17 | skipped | | |
| MCP4 | `propose_doc_update` | new doc, space `test-nowhere` | triaged; an Unplaced item "unknown space: test-nowhere" | brief (never guessed) | {"outcome":"triaged","reason":"unknown space: test-nowhere"}; needs_triage row, reason "unknown space: test-nowhere", by test-dl-member, unresolved; no docs row | pass | MCP response; D1 |  |
| MCP5 | `propose_doc_update` | space `old-wiki` | triaged "archived space: old-wiki" | brief | trimmed by owner 2026-10-17 | skipped | | |
| MCP6 | `propose_doc_update` | new doc, no space | staged in engineering | brief (default) | trimmed by owner 2026-10-17 | skipped | | |
| MCP7 | `propose_doc_update` | new doc, `parent_slug: "test-api"` | staged; the docs row's parent is test-api ("Not yet approved" under API) | brief | trimmed by owner 2026-10-17 | skipped | | |
| MCP8 | `propose_doc_update` | new doc, parent in Product / missing / test-deep-9 | staged at the top level; the result notes the parent was ignored; not triaged | brief | trimmed by owner 2026-10-17 | skipped | | |
| MCP9 | `propose_doc_update` | existing test-error-codes, `parent_slug: "test-runbooks"` | `doc_versions.parent_slug` stored; the tree unchanged until promote | brief | trimmed by owner 2026-10-17 | skipped | | |
| MCP10 | `get_doc` | test-sso | shows `parent_slug: test-authentication` | code (arch) | trimmed by owner 2026-10-17 | skipped | | |
| MCP11 | `list_spaces`, `get_doc` | outsider token; member token on test-other-secret | outsider sees test-docs-other only; member's get_doc test-other-secret is not found | CLAUDE.md invariant 4 | trimmed by owner 2026-10-17 | skipped | | |
| MCP12 | `tools/list` | member token | no tool creates / edits / archives a space, moves a page, imports, or approves | brief (never MCP) | trimmed by owner 2026-10-17 | skipped | | |
| MCP13 | `propose_doc_update` | space `technical` | staged in engineering | brief (aliases) | trimmed by owner 2026-10-17 | skipped | | |

### CR — doc_links backfill

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| CR1 | cron | page-unbackfilled; trigger the daily cron | a `doc_links` row test-unbackfilled → test-architecture; the cursor reads done | code `src/platform/doc-links-backfill.ts`; brief (links on promote) | before: the first daily run wrote nothing — the cursor stopped at `org_test_docslib\t` (each of the 6 orgs before it cost a full 50-page take of the 300 budget, with nothing to read); a second run wrote it. After the fix: one run → doc_links test-unbackfilled → test-architecture, cursor done | fail → fixed | D1 doc_links + cron_cursor | cd0501f3 (import) |
| CR2 | cron | trigger again | nothing read or written; existing rows untouched | code | trimmed by owner 2026-10-17 | skipped | | |
| CR3 | Doc page | after CR1, `#doc/test-architecture` | "Linked from" lists "Links not yet backfilled" | brief (backlinks) | trimmed by owner 2026-10-17 | skipped | | |

### RT — routes and screens the diff touched

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| RT1 | `#docs` | admin | lands on `#library` | brief "Old #docs routes redirect to the library" | trimmed by owner 2026-10-17 | skipped | | |
| RT2 | `#docs/technical`, `#docs/product` | admin | land on the Library | brief | #docs/technical → #library (Library home); #docs/product → #library | pass | location.hash + main text |  |
| RT3 | `#docs/new` | admin | New page | code `hash.ts` | trimmed by owner 2026-10-17 | skipped | | |
| RT4 | `#doc/test-sso` | reload | the page loads directly with its tree | brief (doc page route) | trimmed by owner 2026-10-17 | skipped | | |
| RT5 | quick search (Ctrl K) | "Authentication" | the doc is found and opens `#doc/test-authentication` | code `quicksearch.ts` (changed) | trimmed by owner 2026-10-17 | skipped | | |
| RT6 | My Work › Docs you own | test-dl-spaceowner | the link opens the Library / the doc | code `mywork.ts` (changed) | trimmed by owner 2026-10-17 | skipped | | |
| RT7 | Feed / triage map links to docs | SaplingLearn, AndresL230 | a doc link opens `#doc/<slug>` | code `triage-map.ts` (changed) | trimmed by owner 2026-10-17 | skipped | | |
| RT8 | landing page `/` | signed out | renders its mocks (changed); no console error | code `landing.ts`, `landing-mocks.ts` (changed) | trimmed by owner 2026-10-17 | skipped | | |
| RT9 | Help › What's new | admin | the Unreleased entry carries the Docs Library lines | CLAUDE.md (releases rule) | trimmed by owner 2026-10-17 | skipped | | |
| RT10 | `?preview=empty` | admin; Library, a space, a doc | the empty layouts (no space / no page) | code `preview.ts` | trimmed by owner 2026-10-17 | skipped | | |

### ENV — each screen × environment

Expected for every row: no horizontal scroll (`scrollWidth` = `clientWidth`), nothing cut off or overlapping, text and
marks readable (dark tokens; contrast), no console error. Keyboard rows: every control reachable with Tab / Shift+Tab, a
visible focus ring, Enter / Space activate, Escape closes popovers and modals. Source: prompt §4 (every case's checks);
design §0.1; CLAUDE.md web UI rules.

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| ENV1 | Sidebar Library group | spaces-many, 360 px, dark | as above (the drawer) | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV2 | Sidebar Library group | spaces-many, desktop, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV3 | Sidebar Library group | keyboard | Library label, chevron, space rows, Imports, New space, Import | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV4 | Library home | spaces-many, 360 px, dark | cards in one column | prompt | one column of cards, the header's buttons under the intro; 360 = 360, nothing past the edge | pass | docs-library-shots/batch-b/ENV4-library-360-dark.png |  |
| ENV5 | Library home | desktop, dark | as above | prompt | dark tokens, cards and marks readable; no overflow; no console error | pass | docs-library-shots/batch-b/ENV5-library-dark.jpg |  |
| ENV6 | Library home | keyboard | Import, New space, each card, waiting link, recent rows | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV7 | Library home empty | spaces-none, 360 px, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV8 | Library home empty | desktop, dark | hollow shapes visible in dark | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV9 | Library home empty | keyboard | New space reachable | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV10 | Create space | 360 px, dark | the modal fits the width | prompt | a full-width bottom sheet; 12 icons and 8 swatches one row each; Cancel / Create space side by side; no overflow | pass | docs-library-shots/batch-b/ENV10-create-space-360-dark.png |  |
| ENV11 | Create space | desktop, dark | as above | prompt | the dialog over the dimmed page, readable; no overflow | pass | docs-library-shots/batch-b/ENV11-create-space-dark.jpg |  |
| ENV12 | Create space | keyboard | Name, every icon, every swatch, description, Cancel, Create; Escape closes; focus returns | prompt | Name focused on open; Tab: 12 icons, 8 swatches, description, Cancel (disabled Create skipped), back to Name (trapped), each with a ring; Enter on the focused New space opens it. Escape closed it but the focus fell to `<body>`. Fixed: Escape (and Cancel / backdrop) give it back to the opener; reran Archive on Engineering home (Enter opens, Escape → back on Archive, nothing archived) — B2: Edit space, Edit owners and Archive opened from the keyboard now take the focus (cd468a03): Enter on Archive → its red "Archive space" focused, Escape → back on Archive; Enter on Edit owners → the first person (Ada Test-Admin) | fail → fixed | focus log (focusin + :focus-visible); docs-library-shots/batch-b2/F5-archive-focus.jpg, docs-library-shots/batch-b2/F5-owners-focus.jpg | ede930a5 (spaces) |
| ENV13 | Space home | Engineering, 360 px, dark | header, tabs and lists fit; the tree reachable | prompt | as admin the header's four buttons stayed one 395 px row: "+ Ne…" cut off, .cnpy-libmain scrolled sideways (395/336). Fixed: New page wraps under the others, libmain 336/336. The tab bar scrolls inside itself (by design). Cosmetic: the meta's "·" separators start / end wrapped lines — B2: the meta's separators no longer start or end a line (3764e15a): at 360 px "Owned by … Test-Owner" / "45 pages · 10 waiting for review" / "Edit owners" | fail → fixed | docs-library-shots/batch-b/ENV13-space-home-360-before.png, docs-library-shots/batch-b/ENV13-space-home-360-fixed.png; docs-library-shots/batch-b2/F6-meta-wrap-360.png | 87a822cb (spaces) |
| ENV14 | Space home | desktop, dark | as above | prompt | header, tabs, cards and the docs pane fit; no overflow. Cosmetic: when Edit owners wraps, the "·" before it dangles at the line's end — B2: fixed (3764e15a): the wrapped "10 waiting for review · Edit owners" line starts with no dot | pass | docs-library-shots/batch-b/ENV14-space-home-dark.jpg; docs-library-shots/batch-b2/F6-meta-wrap-desktop.png |  |
| ENV15 | Space home | keyboard | description edit, tabs (arrow keys), cards, rows, New page, Import | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV16 | Space home empty | Security, 360 px, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV17 | Space home empty | desktop, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV18 | Space home empty | keyboard | New page, Import | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV19 | Docs pane (deep) | tree-deep-10, 360 px, dark | the pane / tree fits | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV20 | Docs pane (deep) | desktop, dark | guides and status shapes visible | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV21 | Doc page | page-live, 360 px, dark | article, rail and code blocks fit | prompt | title wraps, History under the meta, inline code and the fence inside the column, the rail below the article (Linked from; the owner / version group is hidden under 1100 px by design); no overflow | pass | docs-library-shots/batch-b/ENV21-doc-360-dark.png, docs-library-shots/batch-b/ENV21-doc-360-rail.png |  |
| ENV22 | Doc page | desktop, dark | link underline, banner, marks readable | prompt | the pending banner + Open in Review, the amber ring, the rail; links accent with a 34% underline, the broken one muted with a dashed amber underline; code readable; no overflow | pass | docs-library-shots/batch-b/ENV22-doc-banner-dark.jpg, docs-library-shots/batch-b/ENV22-doc-links-dark.jpg |  |
| ENV23 | Doc page | keyboard | breadcrumb, History, links, TOC, Copy, child cards | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV24 | New page | 360 px, dark | template grid and preview fit | prompt | templates one per row, then the preview, Title, Section, body; all inside the column | pass | docs-library-shots/batch-b/ENV24-new-page-360-dark.png, docs-library-shots/batch-b/ENV24-new-page-360-preview.png |  |
| ENV25 | New page | desktop, dark | as above | prompt | grid, the picked card's ring, the preview panel; no overflow | pass | docs-library-shots/batch-b/ENV25-new-page-dark.jpg |  |
| ENV26 | New page | keyboard | location picker (open, choose, Done), templates, Title, Create | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV27 | Import › Where | 360 px, dark | as above | prompt | stepper (numbers past the current step), cards one per row, the pick ring + check; no overflow | pass | docs-library-shots/batch-b/ENV27-import-where-360-dark.png |  |
| ENV28 | Import › Where | desktop, dark | as above | prompt | stepper and cards readable; no overflow | pass | docs-library-shots/batch-b/ENV28-import-where-dark.jpg |  |
| ENV29 | Import › Where | keyboard | space cards, tree rows, Continue | prompt | Tab reaches the 6 cards (2px ring), Space picks one (focus kept, aria-checked), then Top level, each tree row and its "Show the pages under …" chevron (Enter expands; Enter on a row picks it: "Pages will go in Engineering › Architecture"), Cancel, Continue; Enter on Continue → Files. Note: after a step change the focus drops to `<body>` — B2: after a step change the focus is on the new step's heading (a8202419): Enter on Continue → "Add your files" focused, Tab → Choose files | pass | focus log | 8ec54eed (the step heading's ring, Batch C full suite) |
| ENV30 | Import › Files | 360 px, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV31 | Import › Files | desktop, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV32 | Import › Files | keyboard | Choose files, remove ×, Back, Check the files | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV33 | Import › Preview | test-handbook.zip, 360 px, dark | the grid stacks; sticky footer fits | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV34 | Import › Preview | desktop, dark | amber pending-row tint and flags readable | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV35 | Import › Preview | keyboard | For all, each conflict's choice, rename input, Back, Add to Review | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV36 | Import › progress / done | 360 px, dark | cards fit | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV37 | Import › progress / done | desktop, dark | as above | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV38 | Import › progress / done | keyboard | Cancel import; Open Review, See import details, Import more | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV39 | Imports history | imports-history, 360 px, dark | the 7-column table fits or reflows; no page scroll sideways | prompt | the ≤900 px rule (File · Status · chevron) lost to the Into / Run by cells' inline display:flex: rows broke onto two lines, statuses cut off ("Sto", "Ca", "Fail"), the file name squeezed to "te…". Fixed: one line a row, File + size, the status mark, the chevron; nothing past the edge | fail → fixed | docs-library-shots/batch-b/ENV39-imports-360-before.png, docs-library-shots/batch-b/ENV39-imports-360-fixed.png | 93b2bab6 (import) |
| ENV40 | Imports history | desktop, dark | marks readable | prompt | marks readable (faded crosses, red diamond, accent checks, amber triangle), the open detail; no overflow | pass | docs-library-shots/batch-b/ENV40-imports-dark.jpg |  |
| ENV41 | Imports history | keyboard | filter, rows (expand), links in details, Cancel import | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV42 | Review | 360 px, dark | the two panes take turns or stack | prompt | the list alone; a page picked shows the detail alone with "‹ All items", the page bar, Reject / Promote, the diff; no overflow | pass | docs-library-shots/batch-b/ENV42-review-360-list.png, docs-library-shots/batch-b/ENV42-review-360-detail.png |  |
| ENV43 | Review | desktop, dark | group cards, diff colors readable | prompt | cards, the group card (fits after RV1's fix), the red / green diff rows readable; no overflow | pass | docs-library-shots/batch-b/ENV43-review-dark.jpg |  |
| ENV44 | Review | keyboard | filter, one by one, rows, prev / next, Approve all, Reject all + confirm | prompt | trimmed by owner 2026-10-17 | skipped | | |
| ENV45 | Reduced motion | the shipped stylesheet, read in the browser | its `prefers-reduced-motion` block turns off the new motion: tree row flash, drag ghost, drop overlay bob / breathe, sidebar group open, tab indicator, card entrances, Review card leave | design §0.1 "All of it is off under prefers-reduced-motion"; CLAUDE.md | the loaded stylesheet's reduced-motion blocks cover the row flash and card entrances (.cnpy-flash, [data-enter]), the drop overlay's edge / tile / pill icons, the sidebar group (.cnpy-aside *), the tab indicator, Review's leave (.cnpy-rvg, .cnpy-rv-card-in, .cnpy-rv-verdict) and the wizard's motion; the drag ghost has no animation of its own | pass | CSSOM read in the browser |  |
