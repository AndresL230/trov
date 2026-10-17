# The Docs Library: spaces, the page tree, links and import

<!-- The area doc for the Docs Library (handoff #16). Built in three stacked PRs: Spaces, the page tree and doc
page, and Markdown import. Each PR extends this file. Keep it current when you change the area. -->

## The schema (`0081_docs_library`)

ONE additive migration holds the schema for the whole feature, so the later PRs never edit a migration:
`doc_spaces` and `doc_space_owners` (this part), `docs.parent_slug` / `tree_rank`, `doc_versions.parent_slug`,
`doc_links` (the page tree and links), `doc_versions.import_id` / `import_path` and `doc_imports` (import, modelled
on `sync_runs`). The import PR adds ONE more, `0082_doc_import_manifest` (two additive columns on `doc_imports`: the
run's server-side plan and its uploaded images — a run spans many requests, so it must remember what it was asked). Every new table binds `org_id` and is in `ORG_TABLES`, `scripts/seed/reset.mjs` and — for each
handle column (`doc_spaces.created_by` / `archived_by`, `doc_space_owners.handle` / `added_by`,
`doc_imports.started_by`) — `HANDLE_COLUMNS`. The migration seeds every existing org with the three starter spaces
and moves every doc not in `product` to `engineering`; `test/spaces.migration.test.ts` holds its claims.

## Spaces

An organization's Library is a list of **spaces** (`doc_spaces`, PK `(org_id, slug)`): a name (1–40 characters),
an icon (`SPACE_ICONS`), a color (`SPACE_COLORS`), a one-line description (≤ 140), a place (`sort_rank`) and
its owners (`doc_space_owners`). A page's `docs.space` is a space's slug — there is no reference (no rebuild of
`docs`); the gate checks it. Everything shared lives in **`shared/docs-core.ts`** (zod-free, imported by the SPA
as a value): `SPACE_ALIASES` / `resolveSpaceAlias`, `DEFAULT_SPACE`, `STARTER_SPACES`, the name / slug rules,
`spaceOrder`, `placeSpace`, `pageAuthority`, and the DTOs.

- **Every org starts with three**: Engineering (`engineering`), Product (`product`), Design (`design`), created by
  `system` — 0081 for the orgs that existed, `src/orgs/repo.ts` `createOrg` (`starterSpaceStmts`, in its one
  batch) for every new one, and the seed scripts.
- **The old values.** Agents and older plugins may still send `technical` (→ `engineering`) or `product`. ONE
  alias map, applied by the gate and by the `space` filters of `query`, `list_docs` and `/search`. An unknown
  value is never mapped to anything: the gate triages it, a filter matches nothing.
- **Slugs are reserved forever.** A new space's slug comes from its name (`spaceSlugFromName`), with `-2`, `-3` …
  when ANY space of the org — archived ones too — ever had it (`uniqueSpaceSlug`). A slug never changes; a rename
  changes the name only.
- **Names are unique per org among the live spaces**, trimmed and case-insensitive: the repository checks
  (`spaceNamedLike`) and the partial unique index `idx_doc_spaces_name … WHERE archived_at IS NULL` settles a race.
  An archived space frees its name; restoring it is refused (409 `name_taken`) while a live space has it.
- **Order** is `sort_rank` (none last, then oldest): a new or restored space goes last; a move places it with the
  ticket board's `placeInColumn`, keyed by slug (`placeSpace`, renumbering when a rank is missing or two are too close).
- **Archive is soft** (`archived_at` / `archived_by`): the space leaves the Library, the sidebar and `list_spaces`,
  and takes no NEW page (the gate triages a proposal that names it; the New page route refuses it). Its pages stay —
  readable by link, searchable, and an edit of one still stages in its own space. An admin restores it.
- **Statuses** in every list come from the query engine's authority flags (`pageAuthority`): `live` (no mark),
  `staged_pending` ("Change pending review"), `unpromoted` ("Not yet approved"). A space's `waiting` counts its pages
  that are not live.

### Who may do what

| | Who | Where |
| --- | --- | --- |
| Read the Library, a space's home | any member | `GET /spaces`, `GET /spaces/:slug` (cookie) |
| Create, rename, re-icon / re-color, reorder, archive, restore | an **admin** (`requireRole(ctx, "admin")`) | `POST /spaces`, `PUT /spaces/:slug` (`name` / `icon` / `color`), `POST /spaces/:slug/move` / `archive` / `restore` |
| Edit the description and the owners | an admin **or an owner of that space** | `PUT /spaces/:slug` (`description` only), `PUT /spaces/:slug/owners` |
| Read the live spaces | an agent | MCP `list_spaces` |

The routes are `src/spaces/routes.ts` (`spacesApp`, mounted on the tenant API: `/api/spaces…` and
`/api/o/:slug/spaces…`) over `src/tools/spaces.ts`, where the role is checked — no route can forget it. **Cookie
only**: a request carrying an `Authorization` header is refused 403, and none of it is an MCP tool (agents stage,
humans confirm). A creator is the new space's only owner; an owner must be a member of the org (400
`not_member`); a space may have no owner (its admins edit it). Each write records its `org_admin_audit` row
(`space.create` / `edit` / `reorder` / `archive` / `restore` / `owners`) in the same batch. A failed read is a 503
`{ error }`; a refusal is `{ error: code, message, field? }` — `invalid` 400, `forbidden` 403, `not_found` 404,
`name_taken` / `archived` 409.

`GET /spaces` (`LibraryDTO`) carries the live spaces in order — each with its owners (handles), page count and
`waiting` — the 6 most recently updated pages across them, the total waiting, `can_admin`, and, for an admin only,
the archived spaces. `GET /spaces/:slug` (`SpaceHomeDTO`) carries the space (an archived one too), EVERY page in it
(staged-only ones included; metadata, `parent_slug`, `tree_rank`, the ancestors' titles as `path`, never a body),
and `can_edit` (admin or an owner) / `can_admin`.

### The gate, triage and the agents

`ingestDocProposal` (`ingestion-gate.md`): a sent space resolves through the alias map and must be a live space of
the org — unknown or archived → `needs_triage` with `unknown space: <slug>` / `archived space: <slug>`; no space →
`engineering` for a new doc while it is live, else triage; an existing doc keeps its own space. Triage › Unplaced's
assign offers the org's live spaces and sends the pick back through the same check. MCP `propose_doc_update`,
`list_docs` and `query` take `space` as a string (a slug or an alias), Ask Trov mirrors them, and `list_spaces` is
a read for every principal (Ask wires it too). The plugin's skills (0.10.0) read the spaces rather than assume them.

## The page tree

Inside a space the pages form a tree: `docs.parent_slug` (NULL = the space's top level) and `docs.tree_rank` (its
place among its siblings; NULL = no saved place yet). The RULES are **`shared/docs-tree-core.ts`** (zod-free; the SPA
imports it as a value), so the Worker's move route and the docs pane's optimistic drop run the same functions:

- **At most `MAX_DEPTH` = 10 levels** (the top level is depth 0). A move checks the moved page's whole subtree.
- **Never a loop** (`wouldCycle`: not under itself or a page below it), never onto itself (`self`), and **same space
  only** (`other_space`) — a page changes space only by being re-proposed, never by a drag.
- **Order** (`treeOrder`): ranked siblings by rank, then unranked ones A to Z. The first drop into a list holding an
  unranked page renumbers the whole list in its visible order (`placeAmong`, `shared/placement-core.ts`, the same
  placement as the ticket board and the spaces).
- **Reading is forgiving** (`buildTree`): a page whose parent is missing, in another space, or part of a stored loop is
  drawn at the top level of its own space — never lost.
- `planMove(nodes, slug, target)` → `{ parent_slug, tree_rank, renumber }` or a refusal (`not_found`, `self`, `cycle`,
  `too_deep`, `other_space`); `applyMove` applies a plan to a list; `indentPx` is the pane's indent (14px a level to
  level 4, then 9px, so deep trees fit).

**Moving a page** is `POST /doc/:slug/move` (`src/tools/doc-tree.ts` `moveDoc`): **any signed-in member, cookie only**
(a bearer is refused 403; there is no MCP move — people arrange the tree). Body `{ target: "into" | "before" | "after"
| "top", ref? }`. The plan and its renumber are written in ONE batch; `updated_at` is untouched (a move is not an
edit). The answer is `{ ok, slug, parent_slug, tree_rank, places }` — every page whose place it wrote. Refusals are
`{ error: code, message }`: `invalid` 400, `not_found` 404 (the page, or a ref that is no page of the org), `cycle` /
`too_deep` / `self` / `other_space` / `archived` (the space is archived) 409. Tests: `test/docs-tree.test.ts`.

**A proposal's parent.** `DocProposal.parent_slug` (`ingestion-gate.md`): a NEW page takes a valid parent at insert;
an EXISTING page stores it on `doc_versions.parent_slug` and moves under it when that version is promoted, if it is
still valid then. An invalid one is ignored with `parent_ignored` in the result, never triaged. MCP `get_doc` shows a
doc's `parent_slug` (the row); the plugin's skills (0.10.1) say how to send one and how to link.

## Links between pages

`[[slug]]` and `[[slug|the words shown]]` in a body (**`shared/docs-links-core.ts`**: `findDocLinks`,
`extractDocLinks`, `replaceDocLinks`; a slug follows `DOC_SLUG_RE`, the contract's rule). Inline code spans and fenced
blocks are never scanned. On **promote**, `doc_links` is rebuilt for the page from the body going live, in the
promote's own batch (`linkStmts`; a link to itself is not kept) — so the table only ever holds LIVE links. A link
whose target is no doc is **broken**: it stays in the table (it starts working once that page exists). **Backlinks**
("Linked from") read `doc_links WHERE to_slug = the page`, keeping only sources that are live (`current_version >
0`). **Pages promoted before this shipped** get their rows from a one-pass backfill (`src/platform/doc-links-backfill.ts`
`backfillDocLinks`, the daily cron): a live page whose body holds `[[` and that has no row gets the rows its promote
would have written (INSERT OR IGNORE; a page with rows is never touched), at most 300 pages per invocation, org by
org and slug by slug, resumed from `cron_cursor` job `doc_links_backfill`; once every org has been read the cursor
says done and it reads nothing again (every later promote writes its own rows). A computed write: no gate.

## The doc page's read

`GET /doc/:slug` (cookie) keeps its `doc`, `versions` (no bodies) and `tags`, and adds **`page`** (`DocPageDTO`,
`readDocPage`): `authority`; `parent_slug`; `ancestors` (the breadcrumb, top first); `children` (in tree order);
`body` — the live body, or for a page never approved its NEWEST STAGED body (the page shows what is waiting);
`links` (the `[[…]]` targets that exist, each with its title, space, path and status) and `broken_links` (the slugs
that reach nothing); `backlinks` (live sources only); and `info` — `owner`, `edited_by` / `edited_at` (who wrote the
version shown), `version`, `pending_version` (a newer staged one), `imported_from` (`{ path, file_name }` from
`doc_versions.import_id` → `doc_imports.file_name`, when the version shown came from an import). It reads every page
of the org once (no bodies) and resolves the tree and both kinds of link in memory, as the Library's own read does.
The pane's tree is the space's home read (`GET /spaces/:slug` — every page with `parent_slug`, `tree_rank`, status).

## Import

A person imports Markdown files, or ONE .zip of them, into a space (or under a page of it). **Nothing goes live**:
every page is a STAGED version through the gate, tagged with the run (`doc_versions.import_id` / `import_path`), and
waits in Review, grouped by import.

**Why the browser unzips.** The zip is read in the browser (`web/src/zip-reader.ts`: the zip's central directory,
entries stored or deflated through `DecompressionStream("deflate-raw")`; zip64, encryption, other methods or an index
that does not add up are "damaged or unsupported"; the declared sizes are checked against the caps BEFORE anything
is inflated, and each entry stops inflating the moment it passes its declared size, then its CRC is checked). That
keeps a zip bomb, a 50 MB upload and the inflate CPU out of the Worker, and lets the Preview show everything before
anything is sent. No dependency. **The Worker never unzips — and trusts nothing the browser worked out**: it gets a
manifest, re-runs the planner itself, and re-checks every page and image it is sent against its OWN plan.

**The planner** is `shared/docs-import-core.ts` (zod-free; the Preview and the Worker run the same functions):
`normalizeImportPath` (path safety: no `..`, no absolute path, no control character; hidden and system files
skipped), `planImport` (folders → nested pages, `name.md` beside `name/` and a folder's README / index merge into
its page, an `attachments` folder holds images, titles from the first `# ` heading, slugs from the path, unique
against EVERY slug of the org; title conflicts with the target space's pages; skipped files with the design's
reasons), `applyConflictChoices` (skip / a new version on the existing page / rename — a skipped or versioned
page's children go under the existing page), `prepareBody` (the heading out, relative `.md` links → `[[slug]]`,
relative images → `/img/<sha256>`, anything unmatched left as plain text, code untouched).

**Caps** (constants in the core): 500 files, 50 MB uncompressed, 1 MB per Markdown file, images as doc images (10
MB, png / jpeg / gif / webp, the type SNIFFED from the bytes). The `doc_import` rate limit (20 starts per person per
day, `abuse-limits.md`). **No per-org plan limit** (`plans.md`).

**The run** (`doc_imports`, modelled on `sync_runs`; `src/imports/runs.ts`, routes `src/imports/routes.ts`, mounted at
`/imports` on the tenant API). Cookie only — a request with an `Authorization` header is refused 403, and none of it
is an MCP tool. Any signed-in member.

| Route | Who | What |
| --- | --- | --- |
| `POST /imports` | any member | `{ space, parent_slug?, file_name, file_size?, files: [{ path, size, title }], choices? }` — every Markdown file carries its first heading (the browser read it), so the server's plan and its conflicts are the Preview's. Checked: a live space (`not_found` 404 / `archived` 409), a parent page of it, ≤ 500 files (`too_many_files` 413), ≤ 50 MB (`too_large` 413), some Markdown (`no_markdown` 400). Then the rate limit, then the LOCK — one guarded `INSERT … WHERE NOT EXISTS` a live running run of the org (409 `import_running` with the run). Answers `{ run, plan: { writes, skipped, conflicts, images } }`. The conflict choices are FIXED here: they decide where other pages go. |
| `POST /imports/:id/images` | the starter | multipart `path` + `file`: a path the plan lists as an image, no larger than the manifest said (and ≤ 10 MB), its type sniffed (`not_an_image`), its sha256 computed HERE; stored at R2 `doc-images/<sha>` with R2's own sha256 check (skipped when the object exists), `doc_images` INSERT OR IGNORE, and `[path, sha]` appended to `doc_imports.images`. Answers `{ path, sha }`. |
| `POST /imports/:id/pages` | the starter | ≤ 25 `{ path, text }` (a folder page with no file of its own is sent as its key, `folder/`, with no text). The batch is refused whole when an entry is not a page of the plan (`not_in_manifest`), not Markdown (`not_markdown`) or an unsafe path (`bad_path`). Each page: valid text (`not_utf8`), ≤ 1 MB (`too_large`), no longer than the manifest said and with the heading it said (`changed`), not empty; its body prepared with the SERVER's path → slug map and the run's uploaded images; a new page whose slug another page took meanwhile is `slug_taken`. Then INTO THE GATE: `ingestDocProposal` (confidence high, section `reference`, the run's space, the planned parent — or the nearest planned ancestor that exists, else the run's parent — ledger `import:<id>` × the page's index in the plan, `{ importId, importPath }`). A retried batch replays from the ledger: nothing is staged twice and the answer is the same. Answers `{ run, results: [{ path, outcome: staged / unchanged / skipped / failed, code? }] }`. |
| `POST /imports/:id/finish` | the starter (`cancel`: or an admin) | `done` (everything planned reached Review), `partial` (files were skipped or pages failed), `failed` (nothing reached Review and something failed); a page of the plan never sent is listed as `failed`. `{ cancel: true }` → `abandoned` with `cancelled` — the pages already sent stay in Review. |
| `GET /imports`, `GET /imports/:id` | any member | history, newest first (100), and `running`. A failed read is a 503. |
| `POST /imports/:id/approve-all` | any member | Review's Approve all: the import's versions still waiting (staged, the page's NEWEST staged version, newer than live) through `promote_doc` — links and parents apply as for one promote — 25 per call; `{ done, remaining, space, space_name }`, the client repeats while `remaining`. |
| `POST /imports/:id/reject-all` | any member | Reject all, SOFT (`status = 'rejected'`, the body kept, the open risk closed), 100 per call, the same answer. A page whose newest change is someone else's (an agent's on top) is left alone by both. |

The run record: `status` (`running` / `done` / `partial` / `failed` / `abandoned` — a running run silent for
`IMPORT_STALE_MS` = 3 minutes reads as abandoned and stops holding the lock; the next start marks it so), `counts`
(what the plan writes: pages, new pages, versions, images, skipped files and skipped conflicts; what reached Review,
READ BACK from `doc_versions` after each batch so a retry never counts twice; unchanged, failed, images uploaded),
`failures` — one entry per path, CODES only (the plan's skip codes, and a page's: `too_large`, `not_utf8`, `empty`,
`changed`, `slug_taken`, `refused`, `triaged`, `failed`, `unchanged` — not an error: the page already says that;
`cancelled` with no path), `total` (the pages planned), and (0082) `manifest` — the SERVER's plan (the accepted
files with their sizes and headings, the choices, the writes in order, the path → slug map, the image paths), which
every later request is checked against — and `images`. Only the starter adds to a run (403 `forbidden`); an ended
run takes nothing (409 `not_running`). The sidebar's badge is `GET /badges` `imports` (a live running run; one at
most). Tests: `test/docs-import.test.ts`.

**Review** (`GET /proposals`): each proposal carries `import_id`, `import_path`, `import_file_name`, `import_by`,
`import_at` (null when an agent or a person wrote it) and the page's `parent_slug`, so Review groups an import's
pages under one card; inside a group the read's order (newest first) reversed is the import's own order.

### The import screens (web)

The views are `web/src/import.ts` (pure) and the acts `web/src/import-actions.ts`; drop to import is
`web/src/import-drop.ts` (one overlay node on `<body>`). Tests: `test/render.import.test.ts`,
`test/import-actions.test.ts` (the driver against a stubbed API, zips built in the test), and the screens' rows in
`render.empty`, `render.skeleton`, `render.sidebar` and `hash`.

- **The wizard** (`#import[/<space>]`, screen `import`; the step is state and the space is left out of `pageKey`).
  The page is morphed as `import` and each step is a `data-morph-key` (`imp:where|files|preview|progress|done`).
  The browser unzips (`openZip`) and keeps the files' text in the controller; `state.imp` holds only the manifest
  (path, size, kind, first heading), the conflict choices and renames, and the run's view. A Markdown file that is
  not valid UTF-8 is left out of the manifest and listed locally as `not_utf8`. The Preview runs the shared
  `planImport` over that manifest and the target space's pages (`spaceHome`; its `existingSlugs` are that space's
  slugs), so it is advisory; "Add N pages to Review" starts the run with the choices fixed.
- **The run** lives in module scope, so it keeps going on any screen (a `beforeunload` prompt while it does): the
  images some page uses first (a refused image is left out — its page shows the alt text), then the pages in
  `plan.writes` order in batches of 25 (a folder page by its key with an empty text), then finish. A network error,
  a 5xx or a 429 stalls it with Retry, which resends the same batch (the ledger replays it); another refusal stops
  it with its sentence. Cancel import is `finish { cancel: true }`. When a run ends, proposals, the Library, the
  space and the badges are read again.
- **Drop to import** works over a space's home, a doc page, New page and the sidebar's space rows (Library home and
  Imports have no space, so they are not targets): good files open the wizard at Preview with that space; anything
  else is the design's toast.
- **Imports history** (`#imports`, screen `imports`) reads `GET /imports`, polling every 4 s while a run is going and
  the screen is open; statuses are marks (`importRunMark`: In progress, Done, Done with skipped files, Failed, and
  Stopped / Cancelled for an abandoned run), one row open at a time, Cancel import for the run's starter only.
- **Review** groups `GET /proposals` by `import_id` (`importGroups`; the server order reversed is the import's
  tree order, depth from `parent_slug` inside the group): one keyed card per import (`rvg:<id>`), Approve all /
  Reject all (a red `confirmModal` with the design's copy) looping `approve-all` / `reject-all` until `remaining`
  is 0 and leaving through Review's exit pattern; the filter is All / Imports / Written by agents. Departures from
  the design: Review keeps its layout and its Promote / Reject buttons in the detail header; a page decided on its
  own leaves the list instead of staying dimmed; the default selection skips import pages (they are opened from
  their group).
- **The sidebar**: an Imports row in the Library group (its badge `badges.imports`, hidden at 0 — the node is always
  there) and an Import action; Library home, Space home and an empty space offer Import too.

## Templates

**`shared/docs-templates-core.ts`**: Guide, How-to, Reference, Runbook (the default), Spec, Product brief, Decision
record, Onboarding, Blank — each a name, a description, its `## ` sections and a default SECTION. A template only
SEEDS a new page — its body (`templateBody`: one `## ` heading per section) and its section — and is **not stored**.
The section stays the gate's vocabulary (`shared/vocabulary.ts`): Decision record → `decisions`; Product brief and
Spec → `context`; the rest → `reference`; the person may change it before staging. A page with no title typed gets
`untitledTitle` ("Untitled runbook").

## The screens (web)

The views are `web/src/library.ts` (pure); their reads and writes `web/src/library-actions.ts` (every `lib…` act);
the API calls `web/src/api.ts` (`getLibrary`, `getSpaceHome`, `createSpace`, `editSpace`, `setSpaceOwners`,
`moveSpace`, `archiveSpace`, `restoreSpace`). Tests: `test/render.library.test.ts`, plus the screens' rows in
`render.empty`, `render.skeleton` and `render.sidebar`.

**Routes** (`web/src/hash.ts`). `#library` is Library home (screen `library`); `#library/<space>` a space's home
(screen `space`; its tab is state, `spaceTab`, so a switch never replays the entrance); `#doc/<slug>` is a doc page
(screen `docs`; the slug is left out of `pageKey`, so another page never replays the entrance); `#docs/new` is New
page (screen `newdoc`). The old `#docs` and `#docs/<space>` land on `#library`. All four screens light the sidebar's
Library group.

**The frame and the docs pane.** A space's home, a doc page and New page sit in ONE frame (render.ts
`libraryFrame`): the **docs pane** (`web/src/docs-pane.ts`, 252px, the space's page tree) beside the content, which
scrolls on its own (`#cnpy-libmain`). The page is `data-morph="lib:<space>"` on all three, so the pane — its rows,
its open chevrons, its scroll — is patched in place across them, and only the content (keyed per screen and per doc)
is replaced; the old reader's DOM edits (`refreshReaderPane`, `applyTreeActive`) are gone, and the screen's entrance
plays on the content only. The pane: the head row (the space's tile and name → its home; "+" → New page at its top
level; while dragging, "the top level"), "PAGES" and the space's page count, then a 28px row per page (`indentPx`, a
guide per ancestor level, a chevron when it has children, the status SHAPE for a page that is not live, a long
title's `data-mtip`), and on hover "+" (a page inside) and "…" (Copy link; Move to the top level). The page being read
and every page above it start open; a chevron the person turns wins (`state.treeOpen`). The active row is scrolled
into view once per page opened. Loading: nine skeleton rows; no page: "No pages yet…" over three hollow rows. Under
900px the pane and the content take turns (the bar's Pages button, `docsTree`).

**Moving pages** (`web/src/tree-drag.ts` on `web/src/pointer-drag.ts`, the app's one pointer drag — the ticket
board's cards use it too: the slop, the swallowed click, Escape, the held paints). Over a row: its top 30% is before,
its bottom 30% after, the middle into; the pane's head is the top level; a target the rules refuse is no target ("too
deep" says so in the hint). The ghost (the title, and a pill: "Put inside ‹Title›", "Move above / below ‹Title›",
"Move to the top level of ‹Space›"), the 2px drop line with its square handle, the ringed row. On release
`web/src/tree-actions.ts` applies the move at once (`applyMove`), posts it, flashes the row and toasts with **Undo**
(the reverse move: before the page that followed it, else after the one before it, else into its old parent); a
refusal puts the tree back and says why. The keyboard does the same on a focused row: Alt+↑ / Alt+↓ (above the page
before / below the page after), Alt+→ (inside the page before), Alt+← (out to the parent's level).

**The doc page** (`web/src/doc-page.ts`). A banner when the page is not simply live (a change waits in Review —
"You're reading the live version…"; never approved — "This page isn't live yet…", with "It was imported" for an
import), each with Open in Review; the breadcrumb (the space, each page above, the page); the title; the meta row —
the status mark ("Live" is said here, the one place, with its tooltip), "Updated ‹when› by ‹Name›" ("Proposed" /
"Imported" for a page never approved) and History (the versions newest first, rejected ones left out, the live one
marked); the Tags row; the body, its `[[slug]]` links substituted BEFORE Markdown renders (`linkedBody`: a link that
resolves is `<a class="cnpy-doclink" href="#doc/<slug>">` with its label or the target's title, the target's path as
its tooltip; one to no page is flagged text — a dashed amber underline — with a tooltip saying no such page exists
yet; code is left as written); then "Pages under ‹Title›" (not for a page never approved). The 210px sticky rail: On
this page (h2/h3 from the body, plus Pages under; scroll-spied by main.ts `updateActiveHeading` over `#cnpy-libmain` —
the last heading within 120px of the top; a click smooth-scrolls to it with 24px to spare, instant under reduced
motion), Owner, Last edited by, Version (+ History; "Version N is waiting for review" / "Not approved yet"), Imported
from, and Linked from. Loading: the article's and the rail's shapes; no page picked: the page drawn empty with New
page; no such page: a sentence. Not built from the design: an Edit button (editing is a proposal — an agent's, or New
page), the link hover card (the tooltip says where a link goes), diffs in History.

**New page** (`web/src/newdoc.ts`, its acts `web/src/newdoc-actions.ts`). "Goes in": a location button opening a
picker — the spaces as `segmented()` (a `dropdown()` past four), then the space's tree ("Top level of ‹Space›" first,
each page with its own chevron) — preset to where it was opened (a space's top level, or under the row whose "+" was
pressed). The nine templates as cards (Runbook preselected) beside a preview of the chosen one's sections; Title
(placeholder "Untitled ‹template›"), Section (`segmented()`, preset by the template) and the body (seeded with the
template's; a template switch keeps a body the person edited). Create page stages it through `POST /api/docs/propose`
with `parent_slug` (the gate; a parent it ignores is said in the toast) and goes to Review. A handoff's "Promote to
doc" opens it prefilled on Blank. Tests: `test/render.docs.test.ts` (the pane, the doc page, the drag's rules),
`test/render.newdoc.test.ts`, the screens' rows in `render.empty` / `render.skeleton`.

**State.** `library: Loadable<LibraryDTO | null>` is read once per org at boot (the rail shows it on every screen)
and again after every space write; `spaceHome: Loadable<SpaceHomeDTO | null>` is the open space's, kept on screen
while it is read again — it is also the docs pane's tree on a doc page and New page (the Library controller's
`ensureSpace` reads a space's pages only when it does not hold them). `docDetail` is the doc page's read (with
`page`); `treeOpen` the pane's chevrons the person turned; `treeMenu` the row whose "…" is open; `nd` New page's
draft. `libUi` holds the dialogs and the description edited in place. Under `?preview=empty` the Library has no space
and a space's home keeps the real space with no page (preview.ts); a doc page shows the empty tree and the empty page.

**Screens.**
- *Library home*: the title, the subtitle, an admin's New space; "N pages are waiting for review" (to Review)
  when any wait; the Spaces cards (tile, name, description, owners, page count, waiting) and an admin's dashed
  New space card; Recently updated (the read's six); an admin's Archived spaces, each with Restore (no confirm:
  it undoes). Loading: three card shapes and five row shapes; no space: the empty layout (New space for an admin).
- *A space's home*: the 40px tile, the name, the description (edited in place for `can_edit`: Enter saves, Esc
  cancels, leaving the field saves; a description-only `PUT`, which is all an owner may send), "Owned by …" with
  the owners' full names and Edit owners (`can_edit`: a dialog of the org's people as checkboxes), the page count
  and the waiting link; New page; an admin's Edit space (the Create space dialog in edit mode, plus a Position
  `dropdown()` that posts `/move`) and Archive (a red `confirmModal`). Archived: the "Archived" mark, nothing to
  edit, no New page, Restore for an admin. Tabs (`tabBar()`): Overview (Top-level pages cards, then the five
  changed last; each card counts the pages under it), All pages (with its count: the whole tree flattened in tree
  order, 18px a level), Recently updated, Least recently updated, A to Z (letter groups). No page: "No pages yet" with New page and Import.
- *Create space* (an admin; over Library home, or the space's home it was opened from): Name (40, a live
  duplicate check through `spaceNamedLike` that says the other space's name and keeps the CTA off), the 12 icons,
  the 8 colours, a short description (140), the sidebar preview. Created: the new space's home and "Created ‹Name›".
- *A doc page* and *New page*: below; the header crumb reads "Library › ‹Space›" / "Library › New page".
- Unplaced › assign offers the live spaces by name; a promoted handoff's doc starts in `engineering` while it is
  live, else the Library's first space.

**Rules.** A page's status is `authorityMark` (marks.ts `AUTHORITY_MARK`): nothing for live, "Change pending
review" (amber ring), "Not yet approved" (a grey dashed ring), each with its tooltip. A space's tile is `spaceTile`:
its corner is `--spt-r`, scaled in the corners block (`.cnpy-spt`). Every space write is a cookie route; a
refusal is a sentence (`spaceErrorText`).
