# The Docs Library: spaces, the page tree, links and import

<!-- The area doc for the Docs Library (handoff #16). Built in three stacked PRs: Spaces, the page tree and doc
page, and Markdown import. Each PR extends this file. Keep it current when you change the area. -->

## The schema (`0076_10_17_staging` › `0081_docs_library`)

The Library's schema is three parts of the 10-17 epic's one migration, `0076_10_17_staging` (`layout.md`): they were
the files `0081_docs_library`, `0082_doc_import_manifest` and `0083_doc_archive`, and each keeps its name as a
`-- ══ part … ══` marker with its own header and rollback. The `0081_docs_library` part holds the schema for the whole
feature:
`doc_spaces` and `doc_space_owners` (this part), `docs.parent_slug` / `tree_rank`, `doc_versions.parent_slug`,
`doc_links` (the page tree and links), `doc_versions.import_id` / `import_path` and `doc_imports` (import, modelled
on `sync_runs`). The `0082_doc_import_manifest` part adds two columns on `doc_imports`: the
run's server-side plan and its uploaded images (a run spans many requests, so it must remember what it was asked). Every new table binds `org_id` and is in `ORG_TABLES`, `scripts/seed/reset.mjs` and — for each
handle column (`doc_spaces.created_by` / `archived_by`, `doc_space_owners.handle` / `added_by`,
`doc_imports.started_by`) — `HANDLE_COLUMNS`. Archive page's `0083_doc_archive` part adds `docs.archived_at` /
`archived_by`, the latter in `HANDLE_COLUMNS` (§ Archiving a page). The `0081_docs_library` part seeds every existing org with the three starter spaces
and moves every doc not in `product` to `engineering`; `test/spaces.migration.test.ts` holds its claims.

## Spaces

An organization's Library is a list of **spaces** (`doc_spaces`, PK `(org_id, slug)`): a name (1–40 characters),
an icon (`SPACE_ICONS`), a color (`SPACE_COLORS`), a one-line description (≤ 140), a place (`sort_rank`) and
its owners (`doc_space_owners`). A page's `docs.space` is a space's slug — there is no reference (no rebuild of
`docs`); the gate checks it. Everything shared lives in **`shared/docs-core.ts`** (zod-free, imported by the SPA
as a value): `SPACE_ALIASES` / `resolveSpaceAlias`, `DEFAULT_SPACE`, `STARTER_SPACES`, the name / slug rules,
`spaceOrder`, `placeSpace`, `pageAuthority`, and the DTOs.

- **Every org starts with three**, in A to Z order: Design (`design`), Engineering (`engineering`), Product (`product`), created by
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
- **Order** is A to Z by name (`spaceOrder`: case and accents aside, then oldest, then slug), so a rename moves a
  space to its new place. Nobody sets an org order — there is no move route and no Position field; `sort_rank` is
  still written (`rankAfterAll`) but orders nothing. Each person shapes their own view of it (below).
- **Archive is soft** (`archived_at` / `archived_by`): the space leaves the Library, the sidebar and `list_spaces`,
  and takes no NEW page (the gate triages a proposal that names it; the New page route refuses it). Its pages stay —
  readable by link, searchable, and an edit of one still stages in its own space. An admin restores it.
- **Statuses** in every list come from the query engine's authority flags (`pageAuthority`): `live` (no mark),
  `staged_pending` ("Change pending review"), `unpromoted` ("Not yet approved"). A space's `waiting` counts its pages
  that are not live.

### Your own Library (`0076_10_17_staging` › `0084_library_prefs`)

Each person, in each org, has their own view (`library_prefs`, PK `(org_id, handle)`; `LibraryPrefsDTO` in
`shared/docs-core.ts`): `sidebar` (a JSON list of at most `SIDEBAR_SPACES_MAX` = 5 space slugs, in their order; NULL =
the default, the first five in the org's order), `pinned` (cards pinned to the top of Library home, in pinning order)
and `hidden` (cards hidden there). Slugs only: a stale one (an archived space) is dropped on read (`liveLibraryPrefs`),
and a space is never both pinned and hidden.
- **Read** with the Library: `GET /spaces` carries `prefs` (the reader's own). **Written** only by that person,
  `PUT /spaces/prefs/me` `{ sidebar?, pinned?, hidden? }` (cookie only; a bearer is refused; a list left out keeps
  what was saved; `checkLibraryPrefs` refuses a duplicate, an unknown or archived space, more than five in the
  sidebar, or a space pinned and hidden — 400 `invalid` with its `field`). Never MCP: it is a person's own screen.
- **The sidebar** shows `sidebarSpaces` (at most five), then — always emitted, shown by attribute — "N more spaces"
  (to Library home) when it leaves some out, and a Customize icon in its action row.
- **Library home** (`libraryCards`): Pinned (when any), then All spaces (or Spaces) in the org's order, then "Show
  hidden spaces · N", which shows the hidden cards dimmed. Each card's "…" (a `hitctl` beside the hit area, shown on
  hover or focus) opens Pin to top / Unpin, Show in sidebar / Remove from sidebar (when the sidebar is full it says
  so instead), and Hide from / Show on Library home. Each change applies at once and is saved; a refusal puts it back.
- **Customize sidebar** (a neutral `confirmModal`, from the sidebar or Library home's "Customize sidebar"): the picked
  spaces in order with up / down / remove, every other live space with Add (disabled at five), and "Reset to the
  Library's order" (saved as NULL, so the sidebar follows the org's order again). Renders on any screen.
- `library_prefs` is in `ORG_TABLES` and `HANDLE_COLUMNS`; deleting an account deletes the person's rows.

### Who may do what

| | Who | Where |
| --- | --- | --- |
| Read the Library, a space's home | any member | `GET /spaces`, `GET /spaces/:slug` (cookie) |
| Create, rename, re-icon / re-color, archive, restore | an **admin** (`adminOnly`: `hasRole(ctx, "admin")`; a refusal says what only an admin may do) | `POST /spaces`, `PUT /spaces/:slug` (`name` / `icon` / `color`), `POST /spaces/:slug/archive` / `restore` |
| Edit the description and the owners | an admin **or an owner of that space** | `PUT /spaces/:slug` (`description` only), `PUT /spaces/:slug/owners` |
| Read the live spaces | an agent | MCP `list_spaces` |
| Archive / restore a PAGE | an admin **or an owner of the page's space**, while the space is live — never an agent | `POST /doc/:slug/archive` / `restore` (cookie; § Archiving a page) |

The routes are `src/spaces/routes.ts` (`spacesApp`, mounted on the tenant API: `/api/spaces…` and
`/api/o/:slug/spaces…`) over `src/tools/spaces.ts`, where the role is checked — no route can forget it. **Cookie
only**: a request carrying an `Authorization` header is refused 403, and none of it is an MCP tool (agents stage,
humans confirm). A creator is the new space's only owner; an owner must be a member of the org (400
`not_member`); a space may have no owner (its admins edit it). Each write records its `org_admin_audit` row
(`space.create` / `edit` / `archive` / `restore` / `owners`) in the same batch. A failed read is a 503
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

- **At most `MAX_DEPTH` = 6 levels** (depth 0–5; the owner's ruling — the deepest that still reads in the 252px
  docs pane). A move checks the moved page's whole subtree; so do a proposal's parent (an invalid one is ignored) and
  the import planner (a folder is a level; what goes past it is skipped, "Nested more than 6 levels deep"). Every
  message names the constant. **A page already deeper** (stored while the limit was 10) is never moved for you: it
  reads and renders as usual (`buildTree` / `flattenTree` and the pane have no depth cut; the indent keeps 9px a
  level), and `planMove` refuses only a move that takes it DEEPER than it already is — a reorder among its siblings
  or a move up is allowed. Nothing new goes under it.
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
would have written (INSERT OR IGNORE; a page with rows is never touched), at most 300 pages read (and 60 queries)
per invocation — an org with nothing to read costs no page of that budget — org by org and slug by slug, resumed from `cron_cursor` job `doc_links_backfill`; once every org has been read the cursor
says done and it reads nothing again (every later promote writes its own rows). A computed write: no gate.

## Archiving a page (`0083_doc_archive`)

The owner's rule: a page "should not be able to be deleted or archived with the agent mcp". **Archive page** is a
PERSON's soft write; there is no hard delete of a page anywhere.

- **Who.** An org admin, or an owner of the page's space (`doc_space_owners`) — the people who edit the space's
  description — while the space is live (`src/tools/doc-tree.ts` `mayArchiveIn` / `isPageArchiver`). `GET
  /spaces/:slug` carries `can_archive`, `GET /doc/:slug`'s `page` too; others see no Archive action.
- **The routes.** `POST /doc/:slug/archive` and `POST /doc/:slug/restore` (`src/tools/doc-archive.ts`, the only
  writer of the two columns), under `cookieOnly` with promote / reject: a request with an `Authorization` header is
  refused 403 before anything is read. Refusals `{ error, message }`: `not_found` 404 (no such page of the org —
  another org's page included), `forbidden` 403, `archived` / `not_archived` / `space_archived` 409. **No MCP tool**,
  no plugin skill text offering it, and nothing reachable from `src/mcp.ts` imports `doc-archive.ts`.
- **Archive** sets `archived_at` / `archived_by` and, in the SAME batch, moves the page's DIRECT children up to its
  own parent (same space), taking its place among its siblings in their own order — the new sibling list (siblings
  before it, its children, siblings after it) is renumbered `RANK_STEP` apart (`shared/docs-tree-core.ts`
  `planArchive`). Grandchildren stay under their parents. Nothing goes deeper, so the 6-level cap holds. Its own
  `parent_slug` is KEPT (its old place, for Restore). Its slug stays reserved forever.
- **Restore** clears the two columns and puts the page back as the LAST child of its old parent when that page is in
  the Library, in the same space, and the cap allows it — else at the end of the space's top level (`planRestore`).
  It comes back alone: the children it moved up stay where they are.
- **Reads.** An archived page is in no tree and no list: Space home's pages and counts, the docs pane, Library
  home's counts and Recently updated, `GET /docs`, `list_docs` / `get_doc` (MCP and Ask: `null`, exactly as a slug
  that never existed), `query` (search and browse), quick search, Review and the badge, tag pages, Sift's candidates,
  Ask's references and doc drift. Space home's **Archived pages** (`archived_pages`: title, who, when) lists them.
  `GET /doc/:slug` still reads it (`page.archived: { at, by }`) — the doc page shows it read-only.
- **Links.** A `[[slug]]` to an archived page is `page.archived_links` (`{ slug, title }`, never `broken_links`) and
  draws as plain text with the "Archived" mark. `doc_links` rows are kept; a backlink FROM an archived page is left
  out of the other pages' Linked from (the source is no page in the tree).
- **Pending work.** Its staged versions stay `staged` and are HIDDEN from Review (the list, an import's Approve all /
  Reject all and counts, the sidebar badge — each joins `d.archived_at IS NULL`); promoting one is refused 409
  `archived`. Restore brings them back to Review. (Not rejected: the gate keeps an archived page's proposals out by
  triage rather than turning them down, and Restore must give back what was waiting.)
- **No indirect path.** The gate triages a proposal for an archived slug (`archived page: <slug>`) — MCP
  `propose_doc_update`, `record_session`, `/ingest`, Ask, an import and a person's New page alike (`/docs/propose`
  refuses the slug 409 "an archived page is named ‹slug›", which New page words as such); an archived page is no parent (`checkParent` and the promote's parent read only the pages in
  the Library, so it is ignored as `not_found`); nothing moves next to or under it (`POST /doc/:slug/move` 409
  `archived` for the page, 404 for a ref). An import can't target it (404), its title is no conflict, its slug is
  never reused (the planner's taken slugs include archived pages).
- **Tests**: `test/docs-archive.test.ts` (the rules, the routes, who, the reads, links, Review, every agent path),
  `test/mcp-catalog.test.ts` (no tool archives, restores or deletes a page), `test/secrets.mcp.test.ts` (the import
  graph), `test/isolation.http.test.ts` (both routes in the matrix), `test/rename-handle.test.ts`, and the screens in
  `render.docs` / `render.library`.

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
pages under one card; inside a group the read's order (newest first) reversed is the import's own order. An import's
version with a newer staged change of the same page on top (an agent's) is left out of the list — and of the sidebar
badge, which shares the clause (`NOT_SUPERSEDED_IMPORT`, `src/tools/reads.ts`): the page sits with the newer change,
and the import's older version is never approved on its own (Approve all leaves it alone too).

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
- **Drop to import** works over a space's home, a doc page, New page and the sidebar's space rows: good files open the
  wizard at Preview with that space; over Library home and Imports (no space) at Where with the files kept
  (`mainDropTarget`); Review and an archived space are no target; anything else is the design's toast.
- **Imports history** (`#imports`, screen `imports`) reads `GET /imports`, polling every 4 s while a run is going and
  the screen is open; statuses are marks (`importRunMark`: In progress, Done, Done with skipped files, Failed, and
  Stopped / Cancelled for an abandoned run), one row open at a time, Cancel import for the run's starter and for an
  admin (the server's finish lets an admin cancel).
- **Review** groups `GET /proposals` (`reviewGroups`, keyed by `groupKeyOf`): an import's pages by `import_id` (the
  server order reversed is the import's tree order, depth from `parent_slug` inside the group), and every other doc
  change by its author — the design's "Written by ‹Name›'s agent" (a spark on slate; "N pages · ‹when›"; its rows
  read "Change" or "New page"). A drafted decision is never in a group: it stays a card of its own. One keyed card
  per group (`rvg:<key>`: `7`, `agent:<handle>`), Approve all / Reject all (a red `confirmModal` with the design's
  copy for an import or an agent; its red button takes the focus, and closing it gives the focus back to that
  group's Reject all) leaving through Review's exit pattern: an import's loops `approve-all` /
  `reject-all` until `remaining` is 0; an agent's calls each page's own promote / reject route (the ones a person
  uses page by page), oldest first, so a page's newest change goes live last — no new write. The filter is All /
  Imports / Written by agents; the list pane is the design's (`.95fr`, at least 420px) beside the page pane
  (`1.05fr`).
  A group's page, picked, is the design's **page pane** (`reviewPagePane`): "Page i of N · ‹short›" with the arrows
  (wrapping in the group); the crumb — the page's own space, then the titles above it (`GET /proposals` carries each
  page's `path`, read from the org's tree like the Library's); the title; the kind ("New page", "New version of
  ‹Title›" for an import, "Change to a live page" for an agent) with "from ‹file›" for an import, and the
  low-confidence mark; Trov's risk line, Ask's flags and a stale base; for a change, the diff box ("What changes",
  "N lines added, M removed", the collapsed line diff); then the page rendered by the reader's renderer (a `[[link]]`
  as its words). Its footer — "Approving makes this page live for everyone.", Reject, ✓ Approve — is the queue's own
  `reviewAccept` / `reviewReject` (cookie routes); deciding moves to the next undecided page of the group, wrapping,
  and a verdict button that had focus hands it to the next page's. A drafted decision keeps Review's own detail
  (the record, Ratify / Reject in its header). Departures from the design: a page decided on its own leaves the
  list instead of staying dimmed with Undo (a promote is not undone); nothing is selected until a page or a
  decision is picked; the Unified / Side by side / Rendered switch is not on the page pane.
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
plays on the content only. The pane: "PAGES" and the space's page count (while dragging, "the top level"; the
space's name and home are the sidebar's and the content's, so the pane has no head row), then a 28px row per page (`indentPx`, a
guide per ancestor level, a chevron when it has children, the status SHAPE for a page that is not live, a long
title's `data-mtip`), and on hover, keyboard focus or an open menu "+" (a page inside) and "…" (Copy link; Move to the
top level; New page inside; Archive page for `can_archive`) — out of the flow, laid over the end of the title (left of the status shape) on the row's
tint over the page (`--dp-tint`, the one value its `::before` draws), so hidden they take no room. The page being read
and every page above it start open; a chevron the person turns wins (`state.treeOpen`). The active row is scrolled
into view once per page opened. Loading: nine skeleton rows; no page: "No pages yet…" over three hollow rows. Under
900px the pane and the content take turns (the bar's Pages button, `docsTree`).

**Moving pages** (`web/src/tree-drag.ts` on `web/src/pointer-drag.ts`, the app's one pointer drag — the ticket
board's cards use it too: the slop, the swallowed click, Escape, the held paints). Over a row: its top 30% is before,
its bottom 30% after, the middle into; the "PAGES" row is the top level; a target the rules refuse is no target ("too
deep" says so in the hint). The ghost (the title, and a pill: "Put inside ‹Title›", "Move above / below ‹Title›",
"Move to the top level of ‹Space›"), the 2px drop line with its square handle, the ringed row. On release
`web/src/tree-actions.ts` applies the move at once (`applyMove`), posts it, flashes the row and toasts with **Undo**
(the reverse move: before the page that followed it, else after the one before it, else into its old parent); once
the Worker has a move (or its Undo) the open doc page is read again (its "Pages under" and breadcrumb); a
refusal puts the tree back and says why. The keyboard does the same on a focused row: Alt+↑ / Alt+↓ (above the page
before / below the page after), Alt+→ (inside the page before), Alt+← (out to the parent's level).

**The doc page** (`web/src/doc-page.ts`). A banner when the page is not simply live (a change waits in Review —
"You're reading the live version…"; never approved — "This page isn't live yet…", with "It was imported" for an
import), each with Open in Review; the breadcrumb (the space, each page above, the page); the title; the meta row —
the status mark ("Live" is said here, the one place, with its tooltip), "Updated ‹when› by ‹Name›" ("Proposed" /
"Imported" for a page never approved) and History (the versions newest first, the live one marked, a rejected one
muted with its "Rejected" mark); the Tags row; the body, its `[[slug]]` links substituted BEFORE Markdown renders (`linkedBody`: a link that
resolves is `<a class="cnpy-doclink" href="#doc/<slug>">` with its label or the target's title, the target's path as
its tooltip; one to no page is flagged text — a dashed amber underline — with a tooltip saying no such page exists
yet; code is left as written); then "Pages under ‹Title›" (not for a page never approved). The 210px sticky rail: On
this page (h2/h3 from the body, plus Pages under; scroll-spied by main.ts `updateActiveHeading` over `#cnpy-libmain` —
the last heading within 120px of the top; a click smooth-scrolls to it with 24px to spare, instant under reduced
motion), Owner, Last edited by, Version (+ History; "Version N is waiting for review" / "Not approved yet"), Imported
from, and Linked from. Loading: the article's and the rail's shapes; no page picked: the page drawn empty with New
page; no such page: a sentence. Not built from the design: an Edit button (editing is a proposal — an agent's, or New
page), the link hover card (the tooltip says where a link goes), diffs in History.

**Archive page on the screens** (`0083_doc_archive`). For `can_archive` only: "Archive page" in a pane row's "…" menu
and in the doc page's meta row (beside History). Both open ONE red `confirmModal` (`archivePageDialog`, any Library
screen): "‹Title› leaves the Library. N pages under it move up a level. You can restore it from ‹Space›'s Archived
pages." (`archivePageText`; the middle sentence only when it has children). Then a toast "Archived ‹Title›" with
**Undo** (a Restore), and the space, the Library, Review, the badges and the open doc page are read again
(`library-actions.ts`; main.ts `pageChanged`). An archived page opened by its link reads READ-ONLY: the banner "This
page is archived. Archived ‹when› by ‹Name›…" with Restore page for `can_archive`, the "Archived" mark in the meta row
(a `kindMark` "off", its tooltip says what it means), no Tags row, no Archive. A `[[link]]` to one is its words as
plain text and the same mark (`.cnpy-doclink-arch`). Restore's toast says where it went ("under ‹Parent›" / "to the
top level of ‹Space›"). Refusals in words (`pageArchiveErrorText`).

**New page** (`web/src/newdoc.ts`, its acts `web/src/newdoc-actions.ts`) is TWO STEPS, one centered column each
(`draft.step`; the owner's call — a short middle beside a long side panel read badly). **Step 1 · Pick a template**:
the nine templates as radio cards (Runbook preselected), each listing the sections it starts the page with; picking
one (`ndTemplate`, click or keyboard) seeds the body and the section and moves on, the title focused. **Step 2 ·
Details**: the template picked, with "Change template" (`ndStep`) back to step 1 — what was typed is kept, and a body
that is still the old template's seed takes the new one's; "Goes in": a location button opening a picker — the spaces
as `segmented()` (a `dropdown()` past four), then the space's tree ("Top level of ‹Space›" first, each page with its
own chevron) — preset to where it was opened (a space's top level, or under the row whose "+" was pressed); Title
(placeholder "Untitled ‹template›"), Section (`segmented()`, preset by the template), the body (seeded with the
template's), and at the foot the Review note and Create page. Each step's column is its own `data-morph-key`
(`nd-step:…`); the fields keep their `data-field` ids. Create page stages it through `POST /api/docs/propose`
with `parent_slug` (the gate; a parent it ignores is said in the toast) and lands on the new page ("Not yet approved")
with "Page created in ‹Space›". With no space, the empty layout offers an admin New space. A handoff's "Promote to
doc" opens step 2 directly, prefilled on Blank (its body is already written). Tests: `test/render.docs.test.ts` (the pane, the doc page, the drag's rules),
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
- *A space's home*: the 40px tile, the name and the description as plain text, the meta line ("Owned by …" with the
  owners' full names, the page count, the waiting link), and on the right ONE button, New page, with a "…" menu
  beside it holding everything else, offered by who may (`headMenu`): Edit space (an admin: the Create space dialog
  in edit mode — name, icon, colour, description; no position, no sidebar preview), Edit description / Add a
  description (`can_edit`: edited in place — Enter saves, Esc cancels, leaving the field saves; a description-only
  `PUT`, which is all an owner may send), Edit owners (`can_edit`: a dialog of the org's people as checkboxes),
  Import (anyone), Archive space (an admin: a red `confirmModal`). An item that opens a dialog first hands the focus
  to the "…", so closing the dialog returns it there; Escape or a click outside closes the menu. Archived: the "Archived" mark, nothing to
  edit, no New page, Restore for an admin. Tabs (`tabBar()`): Overview (Top-level pages cards, then the five
  changed last; each card counts the pages under it and carries the page's first sentence — `pageSummary` in
  `shared/docs-core.ts`, derived from the body it shows when `GET /spaces/:slug` is read (`summaries`), nothing
  stored; a page with no text has no line), All pages (with its count: the whole tree flattened in tree
  order, 18px a level), Recently updated (newest first), Least recently updated, A to Z (letter groups; an accented
  letter under its base letter, symbols and digits in one "#" group first), Archived pages (with its count, always
  there: each archived page with who archived it and when — `byCell` — opening it by its link, and Restore for
  `can_archive`; none: the empty layout `space-archived`). No page: "No pages yet" with New page and
  Import (Archived pages still lists what is archived). An unknown space: a sentence, and no docs pane.
- *Create space* (an admin; over Library home, or the space's home it was opened from): Name (40, a live
  duplicate check through `spaceNamedLike` that says the other space's name and keeps the CTA off), the 12 icons,
  the 8 colours, a short description (140), the sidebar preview, in the design's 480 px dialog (Create and Edit space;
  the owners and Archive dialogs keep the confirm's 420). Created: the new space's home and "Created ‹Name›".
  Name takes the focus on open; closing any space dialog without a write (Create / Edit space, Edit owners, Archive —
  Cancel, Escape, the backdrop) gives the focus back to what opened it (`library-actions.ts` `remember` / `giveBack`).
- *A doc page* and *New page*: below; the header crumb reads "Library › ‹Space›" / "Library › New page".
- Unplaced › assign offers the live spaces by name; a promoted handoff's doc starts in `engineering` while it is
  live, else the Library's first space.

**Rules.** A page's status is `authorityMark` (marks.ts `AUTHORITY_MARK`): nothing for live, "Change pending
review" (amber ring), "Not yet approved" (a grey dashed ring), each with its tooltip. A space's tile is `spaceTile`:
its corner is `--spt-r`, scaled in the corners block (`.cnpy-spt`). Every space write is a cookie route; a
refusal is a sentence (`spaceErrorText`).
