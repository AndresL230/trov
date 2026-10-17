# Docs Library — end-to-end browser test log

Feature: the Docs Library (handoff #16) — spaces, the page tree and doc page, Markdown import — on `feat/docs-import`
(three stacked PRs: `feat/docs-spaces` → `feat/docs-tree` → `feat/docs-import`; base `origin/main` 17a530a4; tested at
bc4b684c + this log's commit). Spec: the Prompt Library prompt `docs-library-build` (handoff #16's build prompt), the
build brief's decisions, and the design spec from the Claude Design prototype (its §12 and §14 list what the design
leaves open — those are `question`s here, not guesses). Area reference: `docs/architecture/docs-library.md`.

**Phase 1 (this commit): the map, the seed, the baseline and the matrix. No case has been run yet** — the matrix is over
150 cases, so the owner sees the count first. `actual` / `result` / `evidence` / `fix` stay empty until Phase 2.

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

## Cases

Columns: id · surface · state (fixture, role, viewport, theme) · expected · source · actual · result · evidence · fix.
`expected` is written before the case runs and never edited to match. "design §N" = the design spec; "brief" = the
build brief's decisions (handoff #16); "prompt" = the Prompt Library prompt; code paths are on this branch.
Unless the state says otherwise: org `test-docs`, desktop 1512 px, light.

### SB — App sidebar › Library group

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| SB1 | Sidebar | spaces-many, admin | Knowledge › "Library" row (label → Library home) + a separate chevron button `aria-label` "Show or hide spaces"; group open by default; one row per LIVE space in order (Engineering, Product, Design, Security, the 40-char one, Onboarding), each a 14px tile + name; NO page rows; an "Imports" row; actions "+ New space" and "Import" | design §1.1; brief "The design wins…" | | | | |
| SB2 | Sidebar | spaces-many, member | as SB1 but no "+ New space"; "Import" still there | design §1.1, §12 | | | | |
| SB3 | Sidebar | admin | the chevron collapses / expands the group (rotates 90°, rows hidden / shown); the "Library" label still goes to Library home | design §1.1 | | | | |
| SB4 | Sidebar | admin; visit library, space, doc, newpage, import, imports | the Library row is active on all six; the space row is active (fg, 500, bar on the guide) on space / doc / newpage for that page's space; the Imports row is active on `#imports` | design §1.1 | | | | |
| SB5 | Sidebar › Review badge | test-docs admin; then test-docs-nospaces | Review's badge = total pages waiting for review (11 in test-docs); hidden when 0 | design §1.1, §14.7 | | | | |
| SB6 | Sidebar › Imports badge | test-docs-one (import-running); then test-docs (only a stale run) | test-docs-one: Imports badge "1"; test-docs: no badge (the stale run is not in progress) | design §1.1, §14.7; brief "stale after a heartbeat window" | | | | |
| SB7 | Sidebar | spaces-none, admin | "No spaces yet" (12px, fg40) + one hollow row in place of the space rows; "+ New space" and "Import" still shown | design §1.1 | | | | |
| SB8 | Sidebar | spaces-one (test-docs-one), member | exactly one space row (Engineering) | design §1.1 | | | | |
| SB9 | Sidebar | space-long | the 40-character name is cut with an ellipsis inside the 228px sidebar; no horizontal scroll | design §1.1; prompt (no overflow) | | | | |
| SB10 | Sidebar | space-archived, admin | Old Wiki and the archived "Design" are never listed | brief "archive … leaves the sidebar" (Spaces) | | | | |
| SB11 | Sidebar | admin; navigate library → space → doc → imports | the sidebar's nodes are the same elements before and after (state is attributes / classes only) | CLAUDE.md web UI rule (stable sidebar DOM) | | | | |
| SB12 | Sidebar › Collapse | admin; footer "Collapse" | **question** (design §14.6: the collapsed sidebar is not designed for the Library group). I would expect the Library icon to stay, open Library home, and the spaces to be hidden while collapsed | design §14.6 | | | | |
| SB13 | Sidebar actions | admin on Library home, then on Space home (Product) | "+ New space" opens Create space; "Import" opens Import — with no space preset from Library home, with Product preset from Product's home | design §1.1 | | | | |

### LH — Library home

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| LH1 | Library home | spaces-many, admin | h1 "Library"; subtitle "Guides, runbooks, specs and decisions for the whole team, grouped into spaces."; "Import" (secondary) and "New space" (primary); "Spaces" heading and a 3-column grid of 6 cards (32px tile, name, description or "No description yet.", owner avatars, count, "· N waiting" when any) and the dashed "New space" card ("For a team or a topic. Only admins can create spaces.") | design §3 | | | | |
| LH2 | Library home | spaces-many, member | no "New space" button and no dashed card; "Import" present | design §3, §12 | | | | |
| LH3 | Library home cards | spaces-many | Security "No pages yet", Onboarding "1 page", others "N pages"; Engineering "· 10 waiting", Product "· 1 waiting" | design §0.5, §3 | | | | |
| LH4 | Library home | admin | a card opens that space's home; a Recently updated row opens its doc | design §3 | | | | |
| LH5 | Library home | test-docs, then test-docs-one | test-docs: "11 pages are waiting for review" with a pending shape → Review; test-docs-one (nothing waiting): no link | design §3 | | | | |
| LH6 | Library home › Recently updated | spaces-many | the 6 most recently updated pages across spaces; each: 14px tile, title, path "Space › ancestors" below; a status mark only for non-live; "‹Short› · ‹when›" with an avatar | design §3, §0.3 | | | | |
| LH7 | Library home › archived | space-archived; admin, then member | an admin finds the archived spaces and restores Old Wiki: it returns to the Library and the sidebar with slug `old-wiki` unchanged; a member sees no archived space and no Restore | brief (Spaces: archive / restore admin; slug reserved) | | | | |
| LH8 | Library home › restore | space-archived-clash, admin | restoring the archived "Design" is refused with a sentence that the name is taken; nothing changes | brief "Name unique … among NON-archived spaces" | | | | |
| LH9 | Library home | admin; `/spaces` delayed | loading: the title block stays, waiting link hidden, 3 skeleton cards, "Recently updated" heading + 5 skeleton rows | design §3 loading | | | | |
| LH10 | Library home | spaces-none, admin | dashed box "No spaces yet" + "A space holds the pages for one team or topic, like Engineering or Onboarding. Create one, then write pages in it or import Markdown files you already have." + outlined "New space"; then 3 hollow cards, "Recently updated", 3 hollow rows | design §3 empty | | | | |
| LH11 | Library home | spaces-none, member | as LH10 without the "New space" button | design §3 empty | | | | |
| LH12 | Library home | admin; `/spaces` answers 503 | a sentence that the Library could not be read; no blank screen, no console exception | CLAUDE.md invariant 7 | | | | |
| LH13 | Library home | space-long | the 40-char name and 140-char description wrap / ellipsize inside the card; no horizontal scroll | design §3; prompt | | | | |
| LH14 | Library home | member | "Import" opens the wizard at Where with no space preset | design §3, §8 | | | | |

### CS — Create space

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| CS1 | Create space | admin, Library header "New space" | 480px modal "New space", intro "A space holds the pages for one team or topic. Only admins can create one.", Name focused and empty (placeholder "Like Security or Onboarding"), shield selected, `#b4562c`, empty description, "Create space" disabled | design §7 | | | | |
| CS2 | Create space | admin, from sidebar "+ New space" and from the dashed card | the same reset state from each entry point | design §7 | | | | |
| CS3 | Create space | admin; Name " engineering " | red border + ring and "There's already a space called Engineering. Pick another name."; Create disabled | design §7 | | | | |
| CS4 | Create space | space-archived, admin; Name "Old Wiki" | allowed (an archived space frees its name); the new space's slug is `old-wiki-2` (slugs stay reserved) | brief (Spaces) | | | | |
| CS5 | Create space | admin; "Test Created Space", rocket, `#2467af`, a description | creates it; lands on its empty Space home; toast "Created Test Created Space"; the creator is the only owner; a sidebar row appears; DB `doc_spaces` row slug `test-created-space`, `doc_space_owners` = test-dl-admin | design §7; brief | | | | |
| CS6 | Create space | admin | Name takes at most 40 characters | design §7 | | | | |
| CS7 | Create space | admin | "Short description" muted "Optional", "‹n›/140" counter, at most 140 characters | design §7 | | | | |
| CS8 | Create space | admin | "In the sidebar" preview: 14px tile in the chosen color/icon + the name, or "New space" while empty | design §7 | | | | |
| CS9 | Create space | admin; Name `<b>Test 🚀</b>` | created; the name shows as literal text (with the emoji) in the modal preview, sidebar, card and header — never as HTML | prompt (HTML injection, unicode) | | | | |
| CS10 | Create space | admin; double-click Create | exactly one space is created | prompt (duplicate submit) | | | | |
| CS11 | Create space | admin; Cancel, then Esc | the modal closes; nothing is created | design §7 | | | | |
| CS12 | Create space | admin; Name "   " | Create stays disabled | design §7 (empty name disables) | | | | |
| CS13 | Create space | admin | 12 icon buttons in order braces … lock; 8 round swatches (`aria-label` "Color") in the design's order; the selected icon / swatch drawn as specified | design §7 | | | | |

### SH — Space home

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| SH1 | Space home | Engineering, admin | 40px tile, h1 "Engineering", description ghost button with pencil; meta: owner avatars, "Owned by Olu Test-Owner and Ada Test-Admin" (full names), "· 45 pages", "· 10 waiting for review" (link); "Import" + "New page"; the docs pane with its head active | design §4, §0.5 | | | | |
| SH2 | Space home › Overview | Engineering | "Top-level pages" with "All pages ›" (switches tab); cards: "N pages inside" / "1 page inside" / "No pages inside", title, description, "Updated ‹when›"; then "Recently updated" (top 5; path "Top level" for root pages) | design §4 | | | | |
| SH3 | Space home › All pages | Engineering | column header "Page / Status / Last updated"; every page flattened in tree order, indented depth × 18px, depth 0 weight 500; the tab's count badge = all pages | design §4 | | | | |
| SH4 | Space home › Recently / Least recently updated | Engineering | **question**: design §4 says the three tabs are "Sorted by update time ascending, by update time descending, or by title" — read in tab order that makes "Recently updated" oldest first. I would expect Recently updated = newest first and Least recently updated = oldest first | design §4 | | | | |
| SH5 | Space home › A to Z | Product | rows by title with a letter label before the first title of each letter | design §4 | | | | |
| SH6 | Space home › A to Z | Engineering (titles "<img…", "Ünïcödé…") | **question**: which group does a title starting with a symbol or an accented letter go in? I would expect accents with their base letter (Ü under U) and symbols / digits in one "#" group first | design §4 (silent) | | | | |
| SH7 | Space home tabs | Engineering | `tabBar()` with a sliding 2px accent indicator; switching tabs keeps the pane and does not replay the page entrance | design §4; CLAUDE.md (tabBar) | | | | |
| SH8 | Space home › description | Engineering, admin; type, Enter | the ghost button becomes an input (placeholder "What is this space for?", focused, ≤ 140), helper "Enter to save · Esc to cancel" + "‹n›/140"; Enter saves trimmed; DB updated | design §4 | | | | |
| SH9 | Space home › description | admin; Esc; then blur | Esc restores the old text; leaving the field saves | design §4 | | | | |
| SH10 | Space home › description | Engineering, space owner (test-dl-spaceowner) | may edit and save the description | brief "Description + owners: editable by an admin OR an owner" | | | | |
| SH11 | Space home › description | Engineering, member (not an owner) | the description is not editable (no edit affordance) | brief (same) | | | | |
| SH12 | Space home › description | admin; clear it, Enter | saved empty; the button reads "Add a short description" in fg40 | design §4 | | | | |
| SH13 | Space home › owners | Design, space owner; add test-dl-member, then remove them | "Owned by …" follows each change; DB `doc_space_owners` matches | brief (owners editable by admin or owner) | | | | |
| SH14 | Space home › owners | space-no-desc (Product, no owner) | **question**: the design has no wording for a space with no owner. I would expect the owner part of the meta line to be left out (or "No owner yet") | design §4, §0.5 (silent) | | | | |
| SH15 | Space home | Engineering, member | no Edit owners, Edit space or Archive; "New page" and "Import" present | design §4 (not gated); brief (admin shapes spaces) | | | | |
| SH16 | Space home | Engineering, member | "New page" → New page at Engineering's top level; "Import" → wizard with Engineering preset; "10 waiting for review" → Review | design §4 | | | | |
| SH17 | Space home | space-empty (Security), admin | meta "0 pages"; dashed "No pages yet" + "Write the first page, or import Markdown files you already have. Imported pages wait in Review until someone approves them." + outlined New page and Import; "Top-level pages" with 3 hollow cards; "Recently updated" with 3 hollow rows; the pane's hollow tree | design §4 empty | | | | |
| SH18 | Space home | Engineering; `/spaces/engineering` delayed | skeleton header (40px square, bars, two avatars, button blocks), tabs without the count, skeleton cards and rows; the pane's skeleton | design §4 loading | | | | |
| SH19 | Space home › Edit space | Design, admin; rename "Design Test", icon flask, color `#966800`; then rename to "Product" | the name / tile change everywhere, slug stays `design`; renaming to a live space's name is refused with a sentence | brief (rename, slug reserved, unique names) | | | | |
| SH20 | Space home › position | admin; move Onboarding first | the order changes in the sidebar and the Library and stays after a reload | brief (reorder, sort_rank) | | | | |
| SH21 | Space home › Archive | Onboarding, admin | a red `confirmModal`; confirmed: it leaves the sidebar and the Library; `#doc/test-welcome` still reads | brief (archive soft); CLAUDE.md (confirmModal) | | | | |
| SH22 | Space home (archived) | space-archived via `#library/old-wiki`; admin, then member | readable with its pages; no way to add a page; an admin can restore it, a member cannot | brief (archive soft: no NEW page; admin restore) | | | | |
| SH23 | Space home | `#library/test-nope` | a "no such space" sentence; no crash | CLAUDE.md invariant 7 | | | | |
| SH24 | Space home › All pages | tree-many (Product, 31 pages) | every page listed (Release notes' 25 children indented under it); the page scrolls, no overflow | design §4 | | | | |
| SH25 | Space home › description | admin; `<img src=x onerror=alert(1)> 🚀` | saved and shown as literal text; no alert | prompt (injection, unicode) | | | | |

### DP — Docs pane

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| DP1 | Docs pane | Engineering home, admin | 252px pane: head (20px tile, "Engineering", "+" `aria-label` "New page"); "PAGES" + the space's page count; 28px rows; a chevron only on pages with children; a non-live page has its 8px shape (amber ring pending, dashed ring staged) and no word | design §1.2, §0.2 | | | | |
| DP2 | Docs pane | tree-deep-10, `#doc/test-deep-9` | indent 14px per level to level 4, then 9px; a guide line per ancestor level; the 10-level chain fits the pane with no horizontal scroll | design §1.2 | | | | |
| DP3 | Docs pane | tree-deep-10 | a title over 24 characters has its full title as a `data-mtip` tooltip | design §1.2 | | | | |
| DP4 | Docs pane | Architecture | the chevron opens / closes the page's children without opening the page | design §1.2 | | | | |
| DP5 | Docs pane | open `#doc/test-deep-9` directly | its ancestors are expanded; its row is active (accent tint, accent text, 500) and scrolled into view (~45% of the pane) | design §1.2 | | | | |
| DP6 | Docs pane | hover "API" | "+" (`aria-label` "New page inside") and "…" (`aria-label` "More") fade in; "+" opens New page with API as the parent | design §1.2 | | | | |
| DP7 | Docs pane head | Engineering doc page | the head goes to Space home; its "+" opens New page at the top level; the head is active only on Space home | design §1.2 | | | | |
| DP8 | Docs pane › "…" More | any row | **question** (design §14.1: the menu is unspecified). The build offers Copy link and Move to the top level; I would expect at least those, plus Rename and New page inside | design §1.2, §14.1 | | | | |
| DP9 | Docs pane | tree-orphan, tree-loop, tree-cross-parent | the orphan, both loop pages and the cross-space-parent page are drawn at Engineering's top level; no page is missing; nothing hangs | code `shared/docs-tree-core.ts` `buildTree` | | | | |
| DP10 | Docs pane | tree-unranked (Runbooks) | ranked children first by rank ("Writing an incident review"), then unranked ones A to Z (Deploys, Imported and approved A / B, Paging and escalation) | code `treeOrder` | | | | |
| DP11 | Docs pane | space-empty (Security) | "No pages yet" (fg40) + three hollow 9px bars (64 / 48 / 56%); count "0" | design §1.2 | | | | |
| DP12 | Docs pane | Engineering; `/spaces/engineering` delayed | 9 skeleton rows of 28px; the count hidden | design §1.2 | | | | |
| DP13 | Docs pane | visit library, import, imports, review | the pane is never shown on those | design §1.2 | | | | |
| DP14 | Docs pane | page-staged, member | **question**: the staged banner says "Only people who can review see it", but in Trov any member may promote. I would expect every member to see staged pages (all members can review) | design §5 banner; CLAUDE.md invariant 2 | | | | |
| DP15 | Docs pane | open Authentication, then Single sign-on | the pane is patched, not rebuilt: open chevrons and the pane's scroll stay | code `render.ts libraryFrame` (data-morph) | | | | |

### TM — Moving pages in the tree

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| TM1 | Tree drag | admin; drag "Error codes" over the top 30% of "Rate limits" | the row drops to 38% opacity; ghost chip + pill "Move above Rate limits"; a 2px drop line with the 8px square handle; on release the row flashes; toast "Moved “Error codes”" with Undo; DB tree_rank changed; same order after reload | design §1.3; brief (move) | | | | |
| TM2 | Tree drag | admin; drop "Data model" on the middle of "API" | API row ringed + tinted, pill "Put inside API"; Data model becomes API's last child; API expands; toast "Moved “Data model” inside API"; DB parent_slug `test-api` | design §1.3 | | | | |
| TM3 | Tree drag | admin; drop "Sidebar and navigation" on the pane head | pill "Move to the top level of Engineering"; appended to the end of the top level; toast "Moved “Sidebar and navigation” to the top level of Engineering"; DB parent_slug NULL | design §1.3 | | | | |
| TM4 | Tree drag › Undo | after TM2 | Undo restores the previous tree on screen and in the DB | design §1.3 | | | | |
| TM5 | Tree drag | admin; drag "Architecture" onto "Web app" (its child) and onto itself | no drop target; nothing moves | design §1.3; brief (no cycles) | | | | |
| TM6 | Tree drag | tree-deep-10; drag "Platform" into "Getting started" | refused (no target / the hint says it would be too deep); tree and DB unchanged | brief MAX_DEPTH = 10 | | | | |
| TM7 | Tree drag | tree-deep-10; drag "Data model" into the level-10 page | refused as too deep; nothing moves | brief MAX_DEPTH = 10 | | | | |
| TM8 | Tree drag | pointer down + up with < 5px movement on a row | the page opens; nothing moves | design §1.3 | | | | |
| TM9 | Tree drag | mid-drag, press Escape | the drag ends; nothing moves; the click is not turned into an open | code `web/src/pointer-drag.ts` | | | | |
| TM10 | Tree drag | member | a member can move pages (TM1-style move works) | design §12; brief (any signed-in member) | | | | |
| TM11 | Tree moves (keyboard) | admin; focus a row, Alt+↑ / Alt+↓ / Alt+→ / Alt+← | the same moves as a drag (above / below / inside the previous page / out a level), with the toast and Undo | code `tree-drag.ts`; prompt (every control by keyboard) | | | | |
| TM12 | Tree drag | tree-unranked; drop "Paging and escalation" above "Deploys" | the list's order on screen is exactly the drop's order and is the same after a reload | design §1.3; code `placeAmong` (renumber) | | | | |
| TM13 | Tree drag | space-archived (Old Wiki pane via `#doc/test-old-wiki-page`) | a move is refused with a sentence; the tree returns to its place | code `doc-tree.ts` (`archived` 409) | | | | |
| TM14 | Tree drag | admin; `/doc/:slug/move` answers 409 | the optimistic move is put back and a sentence says why | code `tree-actions.ts` | | | | |

### DOC — Doc page

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| DOC1 | Doc page | page-live (test-authentication), member | no banner; breadcrumb "Engineering › Architecture › API › Authentication" (all but the last clickable); h1 "Authentication"; meta "Live" mark (hover: "This is the version everyone reads.") · "Updated 3 days ago by Ada"; History and Edit buttons | design §5, §0.2 | | | | |
| DOC2 | Doc page › History | page-live | rows "v3" "Added the steps for rotating keys" (Ada · 3 days ago) [Live], "v1" …; **question** for v2 (rejected): the design shows no rejected version. I would expect rejected versions to be left out (or shown muted with "Rejected") | design §5; §14.2 | | | | |
| DOC3 | Doc page › Edit | page-live | **question** (design §14.2: edit is a toast only; the build has no Edit button). I would expect the Edit button with the toast "Editing opens here. Saving makes a new version." until editing is designed | design §5, §14.2 | | | | |
| DOC4 | Doc page › On this page | page-live | entries from h2 / h3 (h3 indented); the current heading accent with a 2px bar while scrolling (last heading within 120px of the top); a click smooth-scrolls with 24px to spare; "Pages under Authentication" appended | design §5 | | | | |
| DOC5 | Doc page › rail info | page-live | "Owner" Olu Test-Owner; "Last edited by" Ada Test-Admin + "3 days ago"; "Version" "Version 3" + an inline "History" link that toggles the panel | design §5 | | | | |
| DOC6 | Doc page › Linked from | page-live | label + count 1; row "Links and backlinks test" with its path ("Engineering") | design §5; brief (backlinks, live sources) | | | | |
| DOC7 | Doc page › links | page-links (test-links) | `[[test-authentication]]` renders as an accent link (page icon, 34% underline) titled "Authentication"; click opens it and expands the tree to it | design §5, §0.1; brief (links) | | | | |
| DOC8 | Doc page › links | page-links | `[[test-rate-limits\|the rate limits]]` shows "the rate limits" and opens Rate limits | brief (`[[slug\|label]]`) | | | | |
| DOC9 | Doc page › broken link | page-links | `[[test-no-such-page]]` is flagged text (not a working link) with a `data-mtip` saying the page does not exist | brief "a broken one … flagged text with a data-mtip" | | | | |
| DOC10 | Doc page › code | page-links | `` `[[test-in-code]]` `` and the fenced `[[test-in-fence]]` show as written code, not links | brief "Code spans and fenced blocks are not scanned" | | | | |
| DOC11 | Doc page › link hover card | page-links; hover the Authentication link | a 280px card 6px below the link: path "Engineering › Architecture › API", title, description (or "Linked from this page."), status mark + "· Updated ‹when›"; gone on mouseleave and on scroll | design §5 | | | | |
| DOC12 | Doc page | page-pending (test-rate-limits) | banner (amber ring) "You're reading the live version. A change to this page is waiting for review." + "Open in Review ›"; meta "Change pending review"; the LIVE body ("100 requests a minute."); Version note "Version 2 is waiting for review" | design §5 | | | | |
| DOC13 | Doc page | page-staged (test-first-change, written by an agent) | **question**: the design's staged banner says "It was imported…", but this page was written by an agent. I would expect "This page isn't live yet. It is waiting for someone to approve it. Only people who can review see it." | design §5 (only the imported case) | | | | |
| DOC14 | Doc page | page-imported-staged (test-imp-first-week) | banner (dashed ring) "This page isn't live yet. It was imported and is waiting for someone to approve it. Only people who can review see it."; meta "Not yet approved" · "Imported ‹when› by Ada"; history "v1 Imported from handbook/onboarding/first-week.md"; Version "Version 1" + "Not approved yet"; "Imported from" handbook/onboarding/first-week.md "in test-handbook-v2.zip"; Linked from "No pages link here yet. Links from other pages show up once this one is approved."; no "Pages under" | design §5 | | | | |
| DOC15 | Doc page › children | page-live (Authentication) | "Pages under Authentication" with cards Single sign-on, Tokens for agents (description, else "Part of Authentication."); a card opens the child | design §5 | | | | |
| DOC16 | Doc page › code block | page-live | the code block's "Copy" copies it and flips to "Copied" with a green check for ~1.4s | design §5 | | | | |
| DOC17 | Doc page | space-archived (`#doc/test-old-wiki-home`) | the page reads normally | brief (archived pages stay readable) | | | | |
| DOC18 | Doc page | page-xss | the title shows the literal `<img …>` text; the body's script and onerror do nothing (no alert); the javascript: link does not run | prompt (injection) | | | | |
| DOC19 | Doc page | page-unicode | "Ünïcödé — 日本語のページ 🚀 test" correct in h1, breadcrumb, pane, tab title | prompt (unicode) | | | | |
| DOC20 | Doc page | `#doc/test-nope` | a "no such page" sentence; no crash | CLAUDE.md invariant 7 | | | | |
| DOC21 | Doc page | admin of test-docs; `#doc/test-other-secret` | not found — the other org's page is never shown | CLAUDE.md invariant 4 | | | | |
| DOC22 | Doc page | tree-deep-10, `#doc/test-deep-9` | the 10-crumb breadcrumb wraps or truncates inside the article; no horizontal scroll | design §5; prompt | | | | |
| DOC23 | Doc page | `GET /doc/:slug` delayed | the article and rail skeletons of design §5 | design §5 loading | | | | |
| DOC24 | Doc page › when() | page-pending history; page-live | "45 minutes ago" (0.03 day, rounded to 5), "2 weeks ago" (14 days), "2 months ago" (60 days) | design §0.3 | | | | |
| DOC25 | Doc page | page-pending; "Open in Review ›" | goes to Review | design §5 | | | | |
| DOC26 | Doc page › links | page-links | the cross-space link (Pricing and plans), the link to a never-approved page (Your first change) and to the archived space's page (Old wiki home) are links that open their page | brief (broken = no such doc) | | | | |

### NP — New page

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| NP1 | New page | Engineering home › New page, member | h1 "New page"; "Goes in" button with a 16px tile + "Engineering" (top level) + chevron; the pane visible | design §6, §4 | | | | |
| NP2 | New page | pane row "API" › "+" | "Goes in" reads "Engineering › Architecture › API" | design §6 | | | | |
| NP3 | New page › picker | spaces-many | a 340px popover; the spaces as `segmented()` — or a `dropdown()` where six do not fit; the tree below; Done | design §6; CLAUDE.md (dropdown when no room) | | | | |
| NP4 | New page › picker | spaces-one | one space option | design §6 | | | | |
| NP5 | New page › picker | Engineering | first row "Top level of Engineering"; pages indented 10 + depth × 16 with their own chevrons, expanding to depth 2; the pick gets the tint + check; Done closes; the location follows | design §6 | | | | |
| NP6 | New page › templates | any | "Pick a template": 9 cards in order Guide, How-to, Reference, Runbook, Spec, Product brief, Decision record, Onboarding, Blank with the design's descriptions and icons; Runbook selected; Blank dashed | design §6, §6.1; brief | | | | |
| NP7 | New page › preview | pick each template | "Preview", the name, description; the mini page with the template's sections (§6.1); Blank: "An empty page, ready for you." | design §6, §6.1 | | | | |
| NP8 | New page › Title | Runbook, then Spec | placeholder "Untitled runbook", then "Untitled spec" | design §6 | | | | |
| NP9 | New page › Create page | member, Engineering top level, title "Test NP9" | **question**: the design opens the new doc with the toast "Page created in Engineering"; the brief's "nothing goes live without a person" makes it a staged proposal. I would expect a staged page (not live), and to land on that new page (shown "Not yet approved") with the design's toast | design §6; prompt §2; CLAUDE.md invariant 1 | | | | |
| NP10 | New page › section | Decision record, Product brief, Spec, Guide | the staged proposal's section: decisions, context, context, reference (the request body) | brief (Templates) | | | | |
| NP11 | New page › create | under API, title "Test NP11" | DB: `docs` row parent_slug `test-api`, current_version 0, space engineering; it shows under API in the tree with the dashed ring | brief "on a NEW doc the row takes it at insert … Not yet approved in the tree" | | | | |
| NP12 | New page › create | title "Test unicode" (slug of an existing page) | refused with a sentence; nothing staged | code `src/routes.ts` /docs/propose (409) | | | | |
| NP13 | New page | member | a member can create a page | design §12 | | | | |
| NP14 | New page | space-archived | Old Wiki is not offered in the picker; a propose naming it is refused | brief (archived takes no new page) | | | | |
| NP15 | New page | parent test-deep-9 (would be level 11) | the page is created at the space's top level and the person is told the parent was ignored | brief "invalid parent … ignored with a note" | | | | |
| NP16 | New page | Blank, no title, no body | creates "Untitled blank" | design §6 | | | | |
| NP17 | New page | double-click Create page | one page | prompt (duplicate submit) | | | | |
| NP18 | New page | SaplingLearn (team), AndresL230; a handoff's "Promote to doc" | New page opens prefilled (title / body from the handoff) on Blank | code (arch: handoff promote); base flow B03 | | | | |
| NP19 | New page | spaces-none | **question**: no design for New page with no space. I would expect the empty layout saying a space is needed (with New space for an admin) | design (silent) | | | | |
| NP20 | New page | title `<b>Test</b> 🚀` | the title shows as literal text in the tree, Review and the doc page | prompt (injection, unicode) | | | | |

### IW — Import wizard

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| IW1 | Import › Where | member, from Library | stepper Where / Files / Preview / Import (current step accent); h2 "Where should the pages go?" + "Pick a space. You can also put everything inside a page that already exists."; 3-column space cards (24px tile, name, "N pages", check when picked); "Inside a page" + "Optional" tree with "Top level of ‹Space›"; footer "Pages will go in ‹Space›", Cancel (→ Library), "Continue ›"; no docs pane | design §8, §8.1 | | | | |
| IW2 | Import › Where | pick Engineering, a parent, then Product | changing the space clears the parent | design §8.1 | | | | |
| IW3 | Import › Where | from Engineering home "Import" | Engineering preselected | design §4, §8 | | | | |
| IW4 | Import › Where | space-archived | Old Wiki / archived Design are not offered | brief (archived takes no new page) | | | | |
| IW5 | Import › Where | spaces-none | **question**: not designed. I would expect the empty layout "No spaces yet" saying an admin creates one (New space for an admin) | design (silent) | | | | |
| IW6 | Import › Files | Engineering | h2 "Add your files" + "Markdown files (.md), or one .zip of Markdown files. Folders inside a zip become pages with the files nested under them."; 200px drop zone: "Drop files here", "or", "Choose files", "Up to 500 files or 50 MB"; hidden input `multiple`, `accept=".md,.markdown,.zip"`; footer "Going to Engineering", Back, "Check the files ›" disabled | design §8.2 | | | | |
| IW7 | Import › Files | test-handbook.zip | a row: zip icon, name, "3 KB · zip", "Reading…" then a green check "Ready"; "Check the files ›" enabled | design §8.2 | | | | |
| IW8 | Import › Files | remove × | the row goes; with no file the button is disabled again | design §8.2 | | | | |
| IW9 | Import › Files → Preview | test-single.md + test-second.md | two rows "· Markdown"; Preview reads "From 2 files into Engineering" | design §8.2, §8.3 | | | | |
| IW10 | Import › Files | test-handbook.zip + test-single.md together | **question**: "Markdown files, or one .zip" does not say what happens with both. I would expect a sentence that a zip is imported on its own, keeping one choice | design §8.2; brief | | | | |
| IW11 | Import › Files | test-notes.txt via Choose files (all files) | the row says it can't be imported (not Markdown); not "Ready"; the button stays disabled | brief (.md only) | | | | |
| IW12 | Import › Preview | test-handbook.zip → Engineering top level | h2 "Check what will be added" + "From test-handbook.zip into Engineering. Nothing is added until you confirm."; summary 15 "pages to add", 3 "titles already exist", 3 "files won't be imported", 2 "images found", 7 "links found"; "Pages to add" tree: Engineering handbook › Onboarding (Your first week, Local setup, Accounts and access), Practices (Code review, Testing ✅…), Operations (Deploys, Paging and escalation, Runbooks › Rolling back a bad deploy), glossary, Code sample — each with its source path; sticky footer "Pages go to Review first. Nothing is live until someone approves it." + "Add 15 pages to Review" | design §8.3; brief planner rules | | | | |
| IW13 | Import › Preview › conflicts | test-handbook.zip | "Already in Engineering" 3: Local setup "Already at Getting started › Local setup", Deploys "Already at Runbooks › Deploys", Paging and escalation "Already at Runbooks › Paging and escalation"; each Skip / Add as new version / Rename (default version → row flag "New version", amber tint); Skip → row struck through + "Skipped", count 14; Rename → input "Local setup (test-handbook)", row title follows, "Renamed" | design §8.3 | | | | |
| IW14 | Import › Preview › For all | test-handbook.zip | "Skip all" / "New version for all" set every conflict; an option shows on only when every conflict has it | design §8.3 | | | | |
| IW15 | Import › Preview › Won't be imported | test-handbook.zip | 3 rows: handbook/design/logo.sketch "Not a Markdown file", handbook/notes/.DS_Store "Hidden system file", handbook/drafts/empty.md "The file is empty"; the attachments / images-only folders are not listed (they are images) | design §8.3; brief | | | | |
| IW16 | Import › Preview › Images and links | test-handbook.zip | images: uploaded with the pages that use them (1 used of 2 found); links: 7, of which 1 points to a file not in the zip and stays as plain text | design §8.3 | | | | |
| IW17 | Import › progress | start IW12 | card "Adding pages to Review" + accent %, "test-handbook.zip into Engineering", 6px bar, "x of 15 pages" / "y of 1 images", "Adding ‹path›", "You can leave this page. The import keeps going.", "Cancel import"; then Done | design §8.4 | | | | |
| IW18 | Import › done | after IW17 | 40px check tile; "15 pages added to Review"; "Nothing is live yet. Once someone approves them in Review, they show up in Engineering. 3 files were skipped."; 12 "new pages" / 3 "new versions of existing pages" / 1 "images"; "Open Review ›", "See import details", "Import more"; all 4 steps done | design §8.5 | | | | |
| IW19 | Import › DB | after IW17 | one `doc_imports` row (partial: skipped files) with counts and failures (codes only); 15 staged `doc_versions` with import_id / import_path; nothing live (new docs current_version 0; Local setup / Deploys / Paging still at their live version); "Engineering handbook" is a top-level page of Engineering (no new space); flow.png in `doc_images` and the README body says `/img/<sha256>`; the .md links are `[[slug]]`; the missing link plain text; the code block untouched | brief (Import flow, planner rules) | | | | |
| IW20 | Import › parent | test-two-folders.zip into Engineering › Runbooks | the zip's top-level pages are children of Runbooks | brief (optional parent) | | | | |
| IW21 | Import › Skip all | test-handbook.zip, Skip all | no staged version on Local setup / Deploys / Paging; 12 pages | design §8.3 | | | | |
| IW22 | Import › Rename | Local setup → "Local setup (test-handbook)" | a NEW page with that title (new slug); Local setup untouched | brief (rename) | | | | |
| IW23 | Import › Cancel import | mid-run (pages slowed) | **question**: the wizard's design toast is "Import cancelled. Nothing was added." but the brief and history say pages already sent stay in Review. I would expect "Import cancelled. N pages already added stay in Review." and the run abandoned | design §8.4, §11; brief | | | | |
| IW24 | Import › leave | mid-run, go to Library | it keeps going; the sidebar Imports badge "1"; Imports history "In progress" | design §8.4, §1.1 | | | | |
| IW25 | Import › reload | mid-run, reload | a leave prompt; after the reload the run stops and later reads as stopped (abandoned) once its heartbeat is stale; pages already sent stay in Review | brief (lock stale after a heartbeat window) | | | | |
| IW26 | Import › network failure | `/imports/:id/pages` fails once | the run stalls with a sentence and Retry; Retry resends; no page staged twice | brief (ledger replay) | | | | |
| IW27 | Import › double submit | double-click "Add 15 pages to Review" | one run | prompt; brief (one running import per org) | | | | |
| IW28 | Import › lock | import-running (test-docs-one), member starts another | refused with a sentence that another import is running | brief (lock) | | | | |
| IW29 | Import › stale | test-docs (only the stale run 6306) | a new import starts | brief (stale lock) | | | | |
| IW30 | Import › rate limit | admin; 21 starts in a day | the 21st is refused (429) with a sentence | brief (`doc_import` in LIMITS) | | | | |
| IW31 | Import › damaged zip | test-damaged-truncated.zip | "This zip is damaged or unsupported."; not Ready; nothing sent | brief (zip reader) | | | | |
| IW32 | Import › damaged zip | test-damaged-crc.zip | same as IW31 | brief | | | | |
| IW33 | Import › encrypted | test-encrypted.zip | same as IW31 (unsupported) | brief "zip64/encrypted → damaged or unsupported" | | | | |
| IW34 | Import › method | test-unsupported-method.zip | same as IW31 | brief "stored + deflate only" | | | | |
| IW35 | Import › cap | test-over-500-files.zip | refused before anything is sent (over 500 files) | brief caps; design §8.2 copy | | | | |
| IW36 | Import › cap | test-exactly-500-files.zip | accepted: Preview lists the 500 pages and the folder's page | brief caps | | | | |
| IW37 | Import › cap | test-over-50mb.zip | refused before inflating (over 50 MB); nothing sent | brief caps | | | | |
| IW38 | Import › no Markdown | test-no-markdown.zip | refused: nothing to import | code `no_markdown`; brief | | | | |
| IW39 | Import › traversal | test-traversal.zip | `../evil.md`, `/abs.md`, `a/../../b.md`, `..\win.md` listed as won't be imported ("The file's name or folder isn't allowed"); only "The good page" is a page | brief (path safety) | | | | |
| IW40 | Import › too deep | test-too-deep.zip | deep.md listed "Nested more than 10 levels deep"; "Shallow" imported | brief MAX_DEPTH; code SKIP_REASONS | | | | |
| IW41 | Import › too deep under a parent | test-two-folders.zip under test-deep-8 (level 9) | no page lands deeper than level 10: what would go past it is refused or listed, never stored deeper | brief MAX_DEPTH | | | | |
| IW42 | Import › page cap | test-big-page.zip | huge.md "The file is too large"; small.md imported | brief (1 MB per file) | | | | |
| IW43 | Import › images | test-images.zip | ok.png uploaded (`/img/<sha>` in the body); fake.png refused as not an image (its reference stays plain / alt text); huge.png over 10 MB not uploaded and said | brief (images, sniffed, 10 MB) | | | | |
| IW44 | Import › duplicates | test-duplicate.zip | one page; the other file "Another file has the same name" | code SKIP_REASONS | | | | |
| IW45 | Import › not UTF-8 | test-not-utf8.md | "The file isn't readable text"; not imported | brief (UTF-8) | | | | |
| IW46 | Import › empty | test-empty.md | "The file is empty"; not imported | design §8.3 | | | | |
| IW47 | Import › stored | test-stored.zip | reads and imports "Stored page" | brief (stored + deflate) | | | | |
| IW48 | Import › folders | test-two-folders.zip → Product | three top-level pages in Product (Alpha, Beta folder pages with their intro, "A loose page"); no new space | brief "never new spaces" | | | | |
| IW49 | Import › injection | test-xss.md | the title shows literally in Preview, Review and the doc page; nothing executes | prompt (injection) | | | | |
| IW50 | Import › conflict (loose) | test-local-setup.md → Engineering | one conflict "Already at Getting started › Local setup" with the three choices | design §8.3 | | | | |
| IW51 | Import › messages | IW31–IW38 | **question** (design §14.5: no copy for over 500 files, over 50 MB, no Markdown). I would expect each to name the limit ("Up to 500 files or 50 MB …") and what to do | design §14.5 | | | | |
| IW52 | Import › done buttons | after IW18 | "Open Review ›" → Review; "See import details" → Imports; "Import more" → Files with no file | design §8.5 | | | | |

### DR — Drop to import

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| DR1 | Drop overlay | Engineering home; drag 2 .md over the main column | veil + inset 14px dashed accent edge; 48px tile with upload icon; "Drop to import into Engineering"; "2 Markdown files. You can check everything before it goes to Review." | design §10 | | | | |
| DR2 | Drop overlay | one .md | "1 file. You can check everything before it goes to Review." | design §10 | | | | |
| DR3 | Drop | drop 2 .md on Engineering home | the wizard at Preview with Engineering preset | design §10 | | | | |
| DR4 | Drop overlay (bad) | drag test-report.pdf | red dashed edge, red ban tile; "Only Markdown files can be imported"; "test-report.pdf isn't a Markdown file. Drop .md files, or one .zip of them." | design §10 | | | | |
| DR5 | Drop (bad) | drop test-report.pdf on the main column | toast "test-report.pdf isn't a Markdown file. Use .md files or a .zip of them."; nothing opens | design §10 | | | | |
| DR6 | Drop › sidebar row | drag 2 .md over the Product row | the row tinted + ringed; pill "Drop to import into Product" + "2 files"; the main column veiled lightly | design §10 | | | | |
| DR7 | Drop › sidebar row | drop on Product | the wizard at Preview with Product preset | design §10 | | | | |
| DR8 | Drop › sidebar row (bad) | drop test-notes.txt on a row | toast "Only Markdown files, or a .zip of them, can be imported." | design §10 | | | | |
| DR9 | Drop | drop test-handbook.zip on a doc page and on New page | Preview with that page's space | design §10 | | | | |
| DR10 | Drop | Library home, Imports, Review, an archived space's home | **question**: "works on any library screen except Import", but Library home and Imports have no current space and an archived space takes no page. I would expect: Library home and Imports open the wizard at Where with the files kept; archived and Review not targets | design §10 | | | | |
| DR11 | Drop | on the Import screen | not a drop target for this overlay (the Files step has its own zone) | design §10 | | | | |

### IH — Imports history

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| IH1 | Imports | imports-history, admin | h1 "Imports" + "Every Markdown import into the library, newest first." + "Import"; header File / Into / Status / Pages / Run by / When; rows newest first (6306 … 6301): icon, file name, size line ("3.1 MB · 8 files"), Into tile + path ("Engineering › Getting started"), status mark, Pages, avatar + short name, When; chevron | design §11 | | | | |
| IH2 | Imports › filter | imports-history | All 6 / In progress 0 / Done 3 (done ×2 + done with skipped files) / Failed 1 | design §11 | | | | |
| IH3 | Imports › partial | expand 6302 | "5 pages went to Review. 3 files were skipped:" + bordered list (file + reason) + "Open in Review ›" | design §11 | | | | |
| IH4 | Imports › done | expand 6301 (2 pages, approved) | "2 pages were added and approved." + "Open in the library" → Engineering | design §11 | | | | |
| IH5 | Imports › done (1 page) | expand 6303 | "1 page was added and approved by Max." | design §11 | | | | |
| IH6 | Imports › failed | expand 6304; "Try another file" | the button opens Import at Files with Product preset | design §11 | | | | |
| IH7 | Imports › failed wording | expand 6304 (page failures: not UTF-8, couldn't be added) | **question**: the design's only failure copy is the damaged-zip sentence, and a damaged zip never reaches the server here. I would expect "Nothing was added." + each file with its reason | design §11, §14.5 | | | | |
| IH8 | Imports › abandoned | 6305 (cancelled), 6306 (stale) | **question**: the design has no status for a cancelled or stopped run. I would expect a neutral mark with "Cancelled" / "Stopped" and the pages already added | design §11 table | | | | |
| IH9 | Imports › rows | open 6302, then 6304 | one row open at a time; the chevron turns 90°; the open row has the faint background; detail indented 42px | design §11 | | | | |
| IH10 | Imports › in progress | import-running (test-docs-one), member (the starter) | "In progress" (progress pie); Pages "12 of 40"; detail "Adding pages to Engineering. You can leave this page; the import keeps going.", a 5px bar at 30%, "Cancel import" | design §11 | | | | |
| IH11 | Imports › cancel | IH10, Cancel import | toast "Import cancelled. Pages already added stay in Review."; the row no longer in progress; DB status abandoned with a `cancelled` failure | design §11; brief | | | | |
| IH12 | Imports › cancel (admin) | import-running, test-dl-admin (not the starter) | **question**: the server lets an admin stop someone's import (commit 87d278eb) but the build shows Cancel to the starter only. I would expect an admin to see Cancel import too | design §11 (no gating); code | | | | |
| IH13 | Imports | spaces-none | dashed "No imports yet" + "Import Markdown files or a .zip of them, and each run is listed here with what was added and what was skipped." + outlined "Import"; 3 hollow rows; no filter counts | design §11 empty | | | | |
| IH14 | Imports | `/imports` delayed | 6 skeleton rows of 56px on the same grid | design §11 loading | | | | |
| IH15 | Imports › live | a run going in another tab | the open history updates (pages, bar, status) without a reload | code (polling) | | | | |
| IH16 | Imports | other-org | 6309 (test-docs-other) is not listed in test-docs | CLAUDE.md invariant 4 | | | | |
| IH17 | Imports › When | imports-history | the design's phrasing: "Just now", "2 hours ago", "Yesterday", a date like "Oct 12" for older | design §11 | | | | |

### RV — Review grouped by import

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| RV1 | Review | review-import-group + review-agent-group, admin | header "Review"; left: group cards — "Import from test-handbook-v2.zip" (upload icon on accent tint; "N pages · into Engineering · by Ada · ‹when›") and the agent's ("Written by …", spark on slate); actions "Review one by one", "Reject all", "Approve all N"; no docs pane | design §9 | | | | |
| RV2 | Review › filter | same | `segmented()` All / Imports / Written by agents with counts of pending pages; each filter shows only its groups | design §9 | | | | |
| RV3 | Review › grouping | test-deploys (import v2 + agent v3 on top) | **question**: which group holds a page with both an import's and an agent's change waiting? I would expect the agent's group (its newest change), with the import's version not approvable on its own | design §9 (silent); code | | | | |
| RV4 | Review › one by one | open the import group | rows 32px indented 16 + depth × 16, a dashed ring per undecided row, kinds "New page" / "New version"; the toggle reads "Hide pages" | design §9 | | | | |
| RV5 | Review › page | select "Your first week" | right pane: "Page i of N · test-handbook-v2.zip" + prev / next (wrap); crumb "Engineering › Getting started › Onboarding (imported)"; h1; "New page" mark + "from handbook/onboarding/first-week.md"; the rendered page | design §9 | | | | |
| RV6 | Review › diff | select Local setup (new version) | "New version of Local setup"; diff box "What changes" + "N lines added, M removed"; removals red "−", additions green "+" | design §9 | | | | |
| RV7 | Review › decide | undecided page | footer "Approving makes this page live for everyone." + Reject + "✓ Approve"; deciding moves to the next undecided page of the group | design §9 | | | | |
| RV8 | Review › decided | after RV7 | the mark "Approved" / "Rejected", "Undo", "Next page ›" | design §9 | | | | |
| RV9 | Review › progress | 2 decided | "2 of N reviewed"; the button "Approve k left" | design §9 | | | | |
| RV10 | Review › Approve all | the import group | every undecided page approved; verdict overlay "✓ Approved", the card collapses and goes (~330ms); toast "‹k› pages are now live in Engineering" + "Open Engineering"; DB versions promoted, current_version raised, parents applied, doc_links written | design §9; brief | | | | |
| RV11 | Review › Approve all | test-deploys (agent's v3 on top of the import's v2) | Approve all leaves test-deploys alone: still live v1, both staged | code `src/imports/runs.ts` (someone else's change on top) | | | | |
| RV12 | Review › Reject all | the import group | `confirmModal` "Reject ‹k› pages from test-handbook-v2.zip?" / "They won't be added to Engineering. The import stays in Imports, so you can run it again later." / Cancel + red "Reject ‹k› pages" | design §9; CLAUDE.md (confirmModal) | | | | |
| RV13 | Review › Reject all | Cancel | nothing changes | design §9 | | | | |
| RV14 | Review › Reject all | confirm | the group leaves; toast "‹k› pages rejected" + "Open Engineering"; DB status rejected, bodies kept (soft) | design §9; brief (soft) | | | | |
| RV15 | Review › agent group | review-agent-group | Approve all / Reject all on the agent's group; its confirm body "The agent's changes are thrown away. The live pages stay as they are." | design §9 | | | | |
| RV16 | Review › last page | decide the group's last undecided page | the group leaves with "Every page from ‹short› has been reviewed" | design §9 | | | | |
| RV17 | Review › nothing selected | load Review | right pane "Open a group and pick a page to read it here. Or approve a whole group at once." over a hollow page | design §9 | | | | |
| RV18 | Review | spaces-none (nothing waiting) | dashed "Nothing to review" + "Pages that are imported or written by agents wait here until someone approves them. You'll see each import as one group."; 2 hollow cards; right: the hollow outline | design §9 empty | | | | |
| RV19 | Review | `/proposals` delayed | 3 skeleton group cards; right skeleton bars | design §9 loading | | | | |
| RV20 | Review | member | a member can Approve all / Reject all | design §9 (not gated); CLAUDE.md invariant 2 (cookie human action) | | | | |
| RV21 | Review › counts | after RV10 | the sidebar Review badge, Library waiting link and the space's waiting count drop by the approved pages | design §1.1, §3 | | | | |
| RV22 | Review | SaplingLearn (team), AndresL230 | the ADR drafts (decisions) are still listed and can be ratified / rejected as on base | base B02 (nothing in the spec removes them) | | | | |
| RV23 | Review › promote | proposal-parent (test-moves-on-promote v2) | after Promote the page sits under Runbooks | brief (parent applied on promote) | | | | |
| RV24 | Review › promote | proposal-badparent | promoted; the page stays where it was (the parent would be too deep) | brief "else the tree is left as is" | | | | |
| RV25 | Review › links on promote | approve a page whose body has `[[test-architecture]]` (test-single.md imported) | after promote Architecture's "Linked from" lists it | brief (doc_links rebuilt on promote) | | | | |
| RV26 | Review | SaplingLearn, AndresL230; promote one ordinary proposal | promotes as on base (no regression) | base B02 | | | | |

### TR — Unplaced › assign

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| TR1 | Unplaced | triage-space, admin; the `test-nowhere` item | reason "unknown space: test-nowhere" shown; "Doc section" asks for a space among the org's LIVE spaces by name (not technical / product) | brief (Triage › Unplaced assign) | | | | |
| TR2 | Unplaced › assign | TR1 → Engineering | a staged page in Engineering; the item leaves Unplaced (resolved) | brief | | | | |
| TR3 | Unplaced | the `old-wiki` item | reason "archived space: old-wiki"; Old Wiki not offered | brief | | | | |
| TR4 | Unplaced | SaplingLearn, AndresL230 | items file as on base; the doc space choice lists Engineering / Product / Design | base B04; brief | | | | |

### API — HTTP routes

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| API1 | `/api/o/test-docs/spaces`, `/imports` | signed out (no DEV_LOGIN) | 401; no data | CLAUDE.md invariant 8 | | | | |
| API2 | `/test-docs/#library` | signed out | the sign-in / landing; no Library data requested successfully | CLAUDE.md invariant 8 | | | | |
| API3 | `/test-docs/#library` | test-dl-outsider | no access to test-docs (not a member); nothing of it shown | CLAUDE.md invariant 4 | | | | |
| API4 | `GET /api/o/test-docs/spaces`, `/imports`, `/doc/test-getting-started` | test-dl-outsider | refused (403 / 404); no test-docs data | CLAUDE.md invariant 4 | | | | |
| API5 | `GET /api/o/test-docs/doc/test-other-secret` | test-dl-admin | 404 | CLAUDE.md invariant 4 | | | | |
| API6 | `POST /spaces` | member | 403 forbidden | brief (admin cookie routes) | | | | |
| API7 | `PUT /spaces/engineering` | member: `{name}`, `{description}` | both 403 | brief | | | | |
| API8 | `PUT /spaces/engineering`, `/owners` | space owner: `{description}` 200, `{name}` 403, owners 200 | as stated | brief | | | | |
| API9 | `POST /spaces/:slug/archive` / `restore` / `move` | member | 403 each | brief | | | | |
| API10 | `/spaces` GET + POST | bearer (member token) | refused (403 / 401); never served | brief (cookie-only); CLAUDE.md invariant 8 | | | | |
| API11 | `POST /imports` | bearer | refused | brief | | | | |
| API12 | `POST /doc/test-api/move` | bearer | refused | brief | | | | |
| API13 | `POST /imports/6302/approve-all` | bearer | refused | brief; CLAUDE.md invariant 2 | | | | |
| API14 | `POST /spaces` | admin: bad icon, bad color, empty name, 41-char name, 141-char description | 400 `invalid` with the field | code `src/tools/spaces.ts` | | | | |
| API15 | `POST /spaces` | admin, name "Old Wiki" | 201, slug `old-wiki-2` | brief (slug reserved forever) | | | | |
| API16 | `PUT /spaces/design/owners` | admin, `["test-dl-outsider"]` | 400 `not_member` | code | | | | |
| API17 | `GET /spaces/test-nope`, `/spaces/old-wiki` | member | 404; 200 with `archived: true` | code | | | | |
| API18 | `POST /docs/propose` | admin, space `old-wiki` | 400 "the old-wiki space is archived"; nothing staged | brief; code | | | | |
| API19 | `POST /docs/propose` | admin, space `technical` | staged in `engineering` | brief (aliases) | | | | |
| API20 | `GET /search?q=…&space=technical` / `space=test-nope` | member | Engineering pages / nothing | brief (filters) | | | | |
| API21 | `POST /imports` | member: no body, no files, files not an array | 400 `invalid` | code `src/imports/runs.ts` | | | | |
| API22 | `POST /imports` | member: manifest with `../evil.md`, `/abs.md` beside `ok.md` | the server's plan skips (or refuses) the unsafe paths; never a page outside the space | brief "server re-validates every file" | | | | |
| API23 | `POST /imports/:id/pages` | the starter, a path not in the manifest | 400 `not_in_manifest`; nothing staged | brief; code | | | | |
| API24 | `POST /imports/:id/pages` | another member on admin's run | 403 `forbidden` | code | | | | |
| API25 | `POST /imports/:id/pages` | the starter, text longer than declared | that page `failed` with `changed` | brief (the browser's plan is advisory); code | | | | |
| API26 | `POST /imports/:id/images` | text as `x.png`; an 11 MB body | 400 `not_an_image`; 413 `too_large` | brief (sniffed, 10 MB) | | | | |
| API27 | `GET /imports/abc` | member | 404 | code | | | | |
| API28 | `POST /imports/:id/finish` | another member (not the starter): plain finish 403; admin `{cancel:true}` ends it (abandoned) | as stated | code; commit 87d278eb | | | | |
| API29 | `POST /imports/6309/approve-all`, `reject-all` | test-docs admin (6309 is test-docs-other's) | 404 | CLAUDE.md invariant 4 | | | | |
| API30 | `POST /doc/:slug/move` | admin: ref in Product (409 `other_space`), ref = itself (409 `self`), unknown ref (404), target "sideways" (400) | as stated | brief (same-space); code `doc-tree.ts` | | | | |
| API31 | `GET /proposals` | admin | each import version carries `import_id`, `import_path`, `import_file_name`, `import_by`, `import_at`; others null | brief "GET /proposals carries import_id / import file name" | | | | |
| API32 | `POST /imports` | admin: space `old-wiki` (409 `archived`); parent `test-pricing` with space engineering (404) | as stated | brief; code | | | | |

### MCP — tools

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| MCP1 | `list_spaces` | member token | the 6 live spaces (slug, name, description, page count); no archived | brief (MCP) | | | | |
| MCP2 | `list_docs` | `space: "technical"`, `"product"`, `"test-nope"` | Engineering docs / Product docs / none | brief | | | | |
| MCP3 | `query` | `space: "engineering"` | results from Engineering only | brief | | | | |
| MCP4 | `propose_doc_update` | new doc, space `test-nowhere` | triaged; an Unplaced item "unknown space: test-nowhere" | brief (never guessed) | | | | |
| MCP5 | `propose_doc_update` | space `old-wiki` | triaged "archived space: old-wiki" | brief | | | | |
| MCP6 | `propose_doc_update` | new doc, no space | staged in engineering | brief (default) | | | | |
| MCP7 | `propose_doc_update` | new doc, `parent_slug: "test-api"` | staged; the docs row's parent is test-api ("Not yet approved" under API) | brief | | | | |
| MCP8 | `propose_doc_update` | new doc, parent in Product / missing / test-deep-9 | staged at the top level; the result notes the parent was ignored; not triaged | brief | | | | |
| MCP9 | `propose_doc_update` | existing test-error-codes, `parent_slug: "test-runbooks"` | `doc_versions.parent_slug` stored; the tree unchanged until promote | brief | | | | |
| MCP10 | `get_doc` | test-sso | shows `parent_slug: test-authentication` | code (arch) | | | | |
| MCP11 | `list_spaces`, `get_doc` | outsider token; member token on test-other-secret | outsider sees test-docs-other only; member's get_doc test-other-secret is not found | CLAUDE.md invariant 4 | | | | |
| MCP12 | `tools/list` | member token | no tool creates / edits / archives a space, moves a page, imports, or approves | brief (never MCP) | | | | |
| MCP13 | `propose_doc_update` | space `technical` | staged in engineering | brief (aliases) | | | | |

### CR — doc_links backfill

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| CR1 | cron | page-unbackfilled; trigger the daily cron | a `doc_links` row test-unbackfilled → test-architecture; the cursor reads done | code `src/platform/doc-links-backfill.ts`; brief (links on promote) | | | | |
| CR2 | cron | trigger again | nothing read or written; existing rows untouched | code | | | | |
| CR3 | Doc page | after CR1, `#doc/test-architecture` | "Linked from" lists "Links not yet backfilled" | brief (backlinks) | | | | |

### RT — routes and screens the diff touched

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| RT1 | `#docs` | admin | lands on `#library` | brief "Old #docs routes redirect to the library" | | | | |
| RT2 | `#docs/technical`, `#docs/product` | admin | land on the Library | brief | | | | |
| RT3 | `#docs/new` | admin | New page | code `hash.ts` | | | | |
| RT4 | `#doc/test-sso` | reload | the page loads directly with its tree | brief (doc page route) | | | | |
| RT5 | quick search (Ctrl K) | "Authentication" | the doc is found and opens `#doc/test-authentication` | code `quicksearch.ts` (changed) | | | | |
| RT6 | My Work › Docs you own | test-dl-spaceowner | the link opens the Library / the doc | code `mywork.ts` (changed) | | | | |
| RT7 | Feed / triage map links to docs | SaplingLearn, AndresL230 | a doc link opens `#doc/<slug>` | code `triage-map.ts` (changed) | | | | |
| RT8 | landing page `/` | signed out | renders its mocks (changed); no console error | code `landing.ts`, `landing-mocks.ts` (changed) | | | | |
| RT9 | Help › What's new | admin | the Unreleased entry carries the Docs Library lines | CLAUDE.md (releases rule) | | | | |
| RT10 | `?preview=empty` | admin; Library, a space, a doc | the empty layouts (no space / no page) | code `preview.ts` | | | | |

### ENV — each screen × environment

Expected for every row: no horizontal scroll (`scrollWidth` = `clientWidth`), nothing cut off or overlapping, text and
marks readable (dark tokens; contrast), no console error. Keyboard rows: every control reachable with Tab / Shift+Tab, a
visible focus ring, Enter / Space activate, Escape closes popovers and modals. Source: prompt §4 (every case's checks);
design §0.1; CLAUDE.md web UI rules.

| id | surface | state | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| ENV1 | Sidebar Library group | spaces-many, 360 px, dark | as above (the drawer) | prompt | | | | |
| ENV2 | Sidebar Library group | spaces-many, desktop, dark | as above | prompt | | | | |
| ENV3 | Sidebar Library group | keyboard | Library label, chevron, space rows, Imports, New space, Import | prompt | | | | |
| ENV4 | Library home | spaces-many, 360 px, dark | cards in one column | prompt | | | | |
| ENV5 | Library home | desktop, dark | as above | prompt | | | | |
| ENV6 | Library home | keyboard | Import, New space, each card, waiting link, recent rows | prompt | | | | |
| ENV7 | Library home empty | spaces-none, 360 px, dark | as above | prompt | | | | |
| ENV8 | Library home empty | desktop, dark | hollow shapes visible in dark | prompt | | | | |
| ENV9 | Library home empty | keyboard | New space reachable | prompt | | | | |
| ENV10 | Create space | 360 px, dark | the modal fits the width | prompt | | | | |
| ENV11 | Create space | desktop, dark | as above | prompt | | | | |
| ENV12 | Create space | keyboard | Name, every icon, every swatch, description, Cancel, Create; Escape closes; focus returns | prompt | | | | |
| ENV13 | Space home | Engineering, 360 px, dark | header, tabs and lists fit; the tree reachable | prompt | | | | |
| ENV14 | Space home | desktop, dark | as above | prompt | | | | |
| ENV15 | Space home | keyboard | description edit, tabs (arrow keys), cards, rows, New page, Import | prompt | | | | |
| ENV16 | Space home empty | Security, 360 px, dark | as above | prompt | | | | |
| ENV17 | Space home empty | desktop, dark | as above | prompt | | | | |
| ENV18 | Space home empty | keyboard | New page, Import | prompt | | | | |
| ENV19 | Docs pane (deep) | tree-deep-10, 360 px, dark | the pane / tree fits | prompt | | | | |
| ENV20 | Docs pane (deep) | desktop, dark | guides and status shapes visible | prompt | | | | |
| ENV21 | Doc page | page-live, 360 px, dark | article, rail and code blocks fit | prompt | | | | |
| ENV22 | Doc page | desktop, dark | link underline, banner, marks readable | prompt | | | | |
| ENV23 | Doc page | keyboard | breadcrumb, History, links, TOC, Copy, child cards | prompt | | | | |
| ENV24 | New page | 360 px, dark | template grid and preview fit | prompt | | | | |
| ENV25 | New page | desktop, dark | as above | prompt | | | | |
| ENV26 | New page | keyboard | location picker (open, choose, Done), templates, Title, Create | prompt | | | | |
| ENV27 | Import › Where | 360 px, dark | as above | prompt | | | | |
| ENV28 | Import › Where | desktop, dark | as above | prompt | | | | |
| ENV29 | Import › Where | keyboard | space cards, tree rows, Continue | prompt | | | | |
| ENV30 | Import › Files | 360 px, dark | as above | prompt | | | | |
| ENV31 | Import › Files | desktop, dark | as above | prompt | | | | |
| ENV32 | Import › Files | keyboard | Choose files, remove ×, Back, Check the files | prompt | | | | |
| ENV33 | Import › Preview | test-handbook.zip, 360 px, dark | the grid stacks; sticky footer fits | prompt | | | | |
| ENV34 | Import › Preview | desktop, dark | amber pending-row tint and flags readable | prompt | | | | |
| ENV35 | Import › Preview | keyboard | For all, each conflict's choice, rename input, Back, Add to Review | prompt | | | | |
| ENV36 | Import › progress / done | 360 px, dark | cards fit | prompt | | | | |
| ENV37 | Import › progress / done | desktop, dark | as above | prompt | | | | |
| ENV38 | Import › progress / done | keyboard | Cancel import; Open Review, See import details, Import more | prompt | | | | |
| ENV39 | Imports history | imports-history, 360 px, dark | the 7-column table fits or reflows; no page scroll sideways | prompt | | | | |
| ENV40 | Imports history | desktop, dark | marks readable | prompt | | | | |
| ENV41 | Imports history | keyboard | filter, rows (expand), links in details, Cancel import | prompt | | | | |
| ENV42 | Review | 360 px, dark | the two panes take turns or stack | prompt | | | | |
| ENV43 | Review | desktop, dark | group cards, diff colors readable | prompt | | | | |
| ENV44 | Review | keyboard | filter, one by one, rows, prev / next, Approve all, Reject all + confirm | prompt | | | | |
| ENV45 | Reduced motion | the shipped stylesheet, read in the browser | its `prefers-reduced-motion` block turns off the new motion: tree row flash, drag ghost, drop overlay bob / breathe, sidebar group open, tab indicator, card entrances, Review card leave | design §0.1 "All of it is off under prefers-reduced-motion"; CLAUDE.md | | | | |
