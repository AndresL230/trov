# The Docs Library: spaces, the page tree, links and import

<!-- The area doc for the Docs Library (handoff #16). Built in three stacked PRs: Spaces (this part), the page
tree and doc page, and Markdown import. Each PR extends this file. Keep it current when you change the area. -->

## The schema (`0081_docs_library`)

ONE additive migration holds the schema for the whole feature, so the later PRs never edit a migration:
`doc_spaces` and `doc_space_owners` (this part), `docs.parent_slug` / `tree_rank`, `doc_versions.parent_slug`,
`doc_links` (the page tree and links), `doc_versions.import_id` / `import_path` and `doc_imports` (import, modelled
on `sync_runs`). Every new table binds `org_id` and is in `ORG_TABLES`, `scripts/seed/reset.mjs` and — for each
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

## The screens (web)

The views are `web/src/library.ts` (pure); their reads and writes `web/src/library-actions.ts` (every `lib…` act);
the API calls `web/src/api.ts` (`getLibrary`, `getSpaceHome`, `createSpace`, `editSpace`, `setSpaceOwners`,
`moveSpace`, `archiveSpace`, `restoreSpace`). Tests: `test/render.library.test.ts`, plus the screens' rows in
`render.empty`, `render.skeleton` and `render.sidebar`.

**Routes** (`web/src/hash.ts`). `#library` is Library home (screen `library`); `#library/<space>` a space's home
(screen `space`; its tab is state, `spaceTab`, so a switch never replays the entrance); `#doc/<slug>` opens a doc
in the existing reader (screen `docs`; the slug is left out of `pageKey`, and the reader writes the address itself
when a tree click swaps it in place); `#docs/new` is New page (screen `newdoc`). The old `#docs` and
`#docs/<space>` land on `#library`. All four screens light the sidebar's Library group.

**State.** `library: Loadable<LibraryDTO | null>` is read once per org at boot (the rail shows it on every screen)
and again after every space write; `spaceHome: Loadable<SpaceHomeDTO | null>` is the open space's, kept on screen
while it is read again. `libUi` holds the dialogs and the description edited in place. Under `?preview=empty` the
Library has no space and a space's home keeps the real space with no page (preview.ts).

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
  changed last), All pages (with its count), Recently updated, Least recently updated, A to Z (letter groups) —
  flat for now. No page: "No pages yet" with New page (the design's Import clause waits for Import).
- *Create space* (an admin; over Library home, or the space's home it was opened from): Name (40, a live
  duplicate check through `spaceNamedLike` that says the other space's name and keeps the CTA off), the 12 icons,
  the 8 colours, a short description (140), the sidebar preview. Created: the new space's home and "Created ‹Name›".
- *The reader* (`#doc/<slug>`): its tree lists the open doc's space; the breadcrumb and the header crumb
  ("Library › ‹Space›") name it. *New page*: the Space picker is the live spaces (`segmented()` up to four, a
  `dropdown()` past that), preset to where it was opened; Cancel goes back to that space.
- Unplaced › assign offers the live spaces by name; a promoted handoff's doc starts in `engineering` while it is
  live, else the Library's first space.

**Rules.** A page's status is `authorityMark` (marks.ts `AUTHORITY_MARK`): nothing for live, "Change pending
review" (amber ring), "Not yet approved" (a grey dashed ring), each with its tooltip. A space's tile is `spaceTile`:
its corner is `--spt-r`, scaled in the corners block (`.cnpy-spt`). Every space write is a cookie route; a
refusal is a sentence (`spaceErrorText`).
