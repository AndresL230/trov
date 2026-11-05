# Projects

A project is a place to work on one piece of work. It **points at** team records (pins) and **owns** only what is made
inside it: its details, its instructions, its members, the Ask threads started in it and the artifacts saved from them
or uploaded into it. The decided design is `docs/superpowers/specs/2026-11-05-projects.md` (the prototype beside it is
`2026-11-05-projects.dc.html`); where the code and the spec disagree, the code wins and this file says so (› Where this
differs from the spec).

## Shape

| Piece | Where |
|---|---|
| Contract (zod-free values, DTOs, routes, words; SPA-importable) | `shared/projects-core.ts` — `PROJECT_VISIBILITIES`, `PROJECT_ROLES`, `PROJECT_PIN_TYPES`, `PROJECT_LIMITS`, `ASK_PROJECT_CONTEXT_MAX`, `PROJECT_ROUTES`, the DTOs, `projectSlug` |
| Contract (zod) | `shared/projects.ts` — the request bodies and every DTO's schema (the tests parse each answer with them) |
| Ask's half of the contract | `shared/ai-ask-core.ts` — `AskRequest.projectId`, `AskThreadSummary.project` (`AskThreadProject`), `AskThreadPatch.project` |
| Rows | `migrations/0086_projects.sql` — `projects`, `project_members`, `project_pins`, `chat_threads.project_id`, `artifact_pages.project_id`; every statement in `src/data/projects.ts` (and the threads' half in `src/data/ask.ts`) |
| The rules and the writers | `src/tools/projects.ts` (`accessOf`, `mayChange`, every writer, the reads that build the DTOs) — imports nothing from `src/ai/` |
| Routes | `src/projects/routes.ts` (`projectsApp`, mounted under `/api/o/:slug`, cookie only) |
| Ask in a project | `src/ai/ask/project.ts` (the turn's fenced block, the activity line, pinned-first), wired in `src/ai/ask/routes.ts` |
| Deletion | `src/deletion/projects.ts` |
| Plan limits | `projects`, `project_pins` in `shared/plans.ts`; counted in `src/plans/gate.ts` |
| Dev seed | `scripts/seed/projects.mjs` (the team scenario, after the AI showcase) |
| Tests | `test/projects.routes.test.ts`, `test/projects.ask.test.ts`, `test/projects.seed.test.ts` |

## Routes (cookie only, under `/api/o/:slug`)

A request carrying an `Authorization` header is refused (403, invariant 8). None of this is an MCP tool.

| Route | Answers | Who |
|---|---|---|
| `GET /projects?q=` | `ProjectList`: live projects the person can open (most recently updated first), the archived ones, the org's `projects` limit | any member |
| `POST /projects` | `{ project: ProjectSummary }` | any member (becomes its owner) |
| `GET /projects/:project` | `ProjectDetail` | who can open it |
| `PATCH /projects/:project` | `ProjectDetail` | details and instructions: owner, editor; `visibility`: owner |
| `DELETE /projects/:project` | `ProjectDeleted` `{ ok: true, chats, artifacts }` (what went, what stayed) | owner; an org admin who can open it |
| `POST /projects/:project/archive`, `…/restore` | `ProjectSummary` | owner, editor; an org admin who can open it |
| `PUT /projects/:project/members` | `ProjectDetail` | owner, editor; never on a private project |
| `POST /projects/:project/pins` | `ProjectDetail` | owner, editor |
| `DELETE /projects/:project/pins/:ref` (the ref URL-encoded) | `ProjectDetail` | owner, editor |
| `POST /projects/:project/files` (multipart) | `ProjectDetail` | owner, editor |

A slug comes from the name (`projectSlug`) at creation and never changes with a rename. A clash with ANY project of the
org — live, archived or deleted — adds `-2`, `-3`… (a deleted project's slug stays reserved, invariant 11).

## Access

`accessOf` (src/tools/projects.ts) is the one rule; every route and Ask go through it.

- The **owner** is `projects.owner` (never a member row) and does everything.
- A **member row** is `editor` (details, instructions, pins, files, members, archive / restore) or `viewer` (reads,
  starts their own chats).
- **`org`**: every live member of the org opens it as a viewer. **`members`**: the owner and the people added.
  **`private`**: the owner alone — adding members is `400 invalid`; switching to private keeps the member rows and
  ignores them (they come back when it is switched back).
- An **org admin** who is not the owner or a member reads an `org` project as a viewer and may archive, restore and
  delete it. A `members` / `private` project they are not in is the one 404 to them too.
- The refusals, in order: the ONE `404 { error: "not_found" }` for a project the person can't open (unknown, deleted,
  another org's, private, members-only); `403 { error: "forbidden", message }` for one they can open but not change
  (the message says who may: "Only the owner can change who can see this project.", "Only the owner or an org admin can
  delete this project."; the screen shows it, `projectErrorText`);
  `409 { error: "archived" }` for a write to an archived project; then `400 invalid` / `400 private_pin`; a plan limit
  is the app's one `402 plan_limit`.
- **Archived** is read-only: every write but restore and delete is 409; it is left out of new answers (› Ask in a
  project) and does not count toward `projects`.

**Members** (`PUT …/members`) is the WHOLE list, replacing the one before, checked whole before anything is written:
each handle a member of the org (stored in the member's own spelling), never the owner, none twice, at most
`PROJECT_LIMITS.membersMax` — else `400 invalid` and nothing changes. A person kept keeps when they were added.

**Pins** (`POST …/pins`, at most `PROJECT_LIMITS.pinsPerRequest`): each ref must parse (`parseAskRef`), be one of
`PROJECT_PIN_TYPES` (ticket, sprint, doc, decision, pr, repo, artifact) and name something the person can see now
(Ask's `resolveViews`) — else `400 invalid`, nothing pinned. A private artifact on a project that is not private is
`400 private_pin` (the screen offers Publish to org); switching a project away from private while it pins a private
artifact is refused the same way. A ref already pinned is left as it is and is not counted again. Every pin is drawn
through Ask's `RefView` for the READER: one they can't see is `{ ref, hidden: true }` and never enters their answers.

**Files** (`POST …/files`) take Ask's attachment rules (`checkFiles`: ≤ 5 files, 10 MB each, images / PDFs / text and
code, checked whole first); each becomes an artifact of the uploader's through `createPage` — private on a private
project, else the org's — is the project's (`artifact_pages.project_id`) and is pinned. The pins are asked of the plan
before anything is stored; the bytes count toward `artifact_bytes` as any artifact does. Too many files is said in the
project's words (`400 invalid` "Add at most 5 files at a time.", before `checkFiles`, whose sentence is a message's); a
file the artifacts store refuses (`ArtifactError` from `createPage`) is its own status (`ARTIFACT_ERROR_STATUS`) with
`{ error: code, message }`, never a 500. The screen checks the count and the size first (`uploadRefusalText`).

**Add to Knowledge** on the screen sends at most `pinsPerRequest` refs a call, each call committed alone. So the dialog
refuses a pick past the project's room (`pinRoomText`: `pinLimit.cap - used`, when capped) before sending anything; if
a later call is still refused after earlier ones landed, the page takes the last answer (what is pinned now), the
dialog says "Added N of M." and the refusal, and what landed leaves the pick.

**Chats** (`ProjectDetail.chats`, `ProjectSummary.chats`) keep Ask's own privacy (`projectThreadsFor` /
`projectThreadCounts` in src/data/ask.ts, `threadFor`'s rule with the project as a filter): the reader's own threads in
the project, then threads others shared with them by name or with the org (while their owner is a member). Being in a
project never shares a thread. **Artifacts** are the project's the reader may see (the org's, and their own private ones).

## Limits (`shared/plans.ts`)

| Key | Free / Personal | Pro | Enterprise | Counted | Enforced at |
|---|---|---|---|---|---|
| `projects` | 2 | unlimited | unlimited | the org's LIVE projects (not archived, not deleted) | `createProject`, `restoreProject` |
| `project_pins` | 20 | 200 | unlimited | PER PROJECT: its pins (`LimitDef.per: "project"`) | `pinRefs`, `uploadIntoProject` (before anything is stored) |

Both through `requirePlan` (`requirePlan(ctx, "project_pins", n, { project })` — the scope argument is how a
per-project limit is counted). Not per seat. `projects` is listed (the pricing page, the Plan block, Settings › Limits);
`project_pins` is NOT listed: those surfaces draw one number per limit, and this one has one per project — the project
page says it ("N of 200 pinned", `ProjectDetail.pinLimit`). `OrgPlanView.usage.project_pins` is the most-pinned live
project's count.

## Ask in a project

- **`POST /ask { projectId }`** on a NEW thread (ignored with a `threadId`): the project must be one the person can
  open (else the one `404 { error: "not_found" }`, JSON, before anything streams) and live (else `409 archived`). The
  thread's `project_id` is set and the project moves up the list. The conversation says the refusal in place of Ask's
  generic error (`turnErrorWords`, web/src/ask-conversation.ts): `archived` the server's sentence, `not_found` "This
  project isn't there any more." — neither with Try again.
- **`PATCH /ask/threads/:id { project }`**: its owner only (anyone else is Ask's own 404), into a live project they can
  open (its slug — else the one 404 / 409, checked before anything in the PATCH is written) or out (`null`).
- **`AskThreadSummary.project`** (`{ slug, name, icon, color }`) on every thread read — the person's list, the shared
  list, a thread's detail, search hits, the PATCH answer and the project page — for a project the READER can open
  (archived included); absent otherwise, so a thread whose project the reader can't open reads as one with none.
- **Every turn** in a project's thread whose project is live and one the ASKER can open (`projectForTurn` — for a
  shared thread, the person continuing it, not its owner) adds ONE fenced block in front of the question
  (`projectTurnContext`): the project's name, its instructions and its pins' RefView cards (newest first, the same JSON
  the turn hands the model for attached context), within `ASK_PROJECT_CONTEXT_MAX` (6000 tokens, read as 4 characters
  each); past it the newest pins go first and a line says how many were left out. It travels in the turn's nonce fence
  (`fence`, ask.md › Grounding): the instructions are other people's words and never reach the system prompt — the
  context block only says the conversation is in a project and that its block is data that guides focus, tone and
  format. Pins the asker can't see never enter. The visible pins join the thread's seen set, so the answer may link them.
- **The activity line**: before the model is called the turn emits `{ tool: "project", icon: "docs", label: "Read the
  project's instructions" }` run → done at once (`resultLine` "N pinned items" when any), stored with the answer like
  the attachment notices (it is the first of them).
- **Pinned first**: the search and list tools' results (`query`, `list_tickets`, `list_docs`, `list_sprints`,
  `artifact_list`) and `/search`'s cards put the project's pinned items first (`pinnedFirst`); no new tool.
- **Save as artifact** from a project thread (the save form, Save, Auto's save) sets `artifact_pages.project_id` when
  the person can open the project and it is live.
- An **archived** project's threads still open and read; a new question answers as a thread with no project.
- No new model call site (invariant 14): the block is built from Trov's rows; nothing here calls a model.

## Deleting

`DELETE /projects/:project` → `src/deletion/projects.ts` (CLAUDE.md invariant 11). ONE batch: the project's pins and
members go, its artifacts' `project_id` is cleared (they stay in Artifacts with their own visibility), and the project
row is marked `deleted_at` — soft, its slug reserved. THEN every thread in the project — the owner's, other members'
own, and those shared with others — is hard-deleted through Ask's own `deleteAskThread` (its attachments with it,
unless a ticket or a doc refers to one; R2 after the commit). The batch goes first so nobody can start a thread in it
or move one into it meanwhile; a thread a failure leaves behind names a deleted project, which every read treats as
none. The tickets, docs and PRs it pinned are not touched. The answer counts what went and what stayed (`chats`,
`artifacts`); the toast says the chats ("Hosting providers deleted, with its 5 chats").

**The confirmation's numbers** are `ProjectSummary.deleteCounts` (`{ chats, artifacts }`: EVERY thread in the project,
anyone's, and every artifact it holds — what the delete takes, not what the reader can open), sent only to a reader who
may delete it (the owner, or an org admin who can open it) on every summary — the list, the page, archive / restore.
Two grouped counts (`projectHoldings`, src/data/projects.ts) for the deletable projects of the read; counts only,
nothing of a thread the reader can't open.

- **An account's deletion** (`src/deletion/person.ts`) takes the person's project memberships; a project they OWN
  stays, under the `deleted-…` tombstone (`projects.owner` is in `HANDLE_COLUMNS`), for its members — and, for an `org`
  project, an org admin can delete it.
- **An org's deletion** takes every project row (`ORG_TABLES`: `project_pins`, `project_members`, `projects`).
- A rename rewrites `projects.owner` / `archived_by`, `project_members.handle` / `added_by`, `project_pins.added_by`.

## Where this differs from the spec

- `project_members`' key is `(org_id, project_id, handle)` and `project_pins`' unique key `(org_id, project_id, ref)`:
  the org leads every key a tenant upsert names (`data-layer.md` › Writing a statement).
- `DELETE /projects/:project` answers `{ ok: true, chats, artifacts }` (`ProjectDeleted`) — the spec's `{ ok: true }`
  plus the counts.
- `ProjectSummary.deleteCounts` is not in the spec's contract: its delete copy wants the TRUE number of chats, which the
  reader's own `chats` undercounts (others' private threads go too).
- An org admin's archive / delete reaches the projects they can OPEN (`org` ones, or ones they are in): the spec's
  table says "Archive / restore ✓, Delete ✓" for an org admin and the contract's comment "any project of the org",
  but the spec also says every route answers a project the person can't open with the one 404 — the one 404 wins, so a
  `members` / `private` project's existence never shows to an admin outside it.

## Tests

`test/projects.routes.test.ts` (CRUD and slugs, the access table row by row for a `members` and an `org` project,
another org, cookie only, private and archived, Free's 2 projects and 20 pins, hidden pins and `private_pin`, members
validation, deletion and `deleteCounts`, uploads: the count in the project's words and an `ArtifactError` as its own
4xx), `test/projects.ask.test.ts` (`projectId`, the refusal, PATCH in / out, the project page's
Chats, the turn's fenced block and its activity line, hidden pins, an unopenable or archived project, pinned first,
save), `test/projects.seed.test.ts` (the dev seed's promises), `test/render.projects-dialogs.test.ts` (the dialogs and
the controller's writes: the 403's sentence, the delete counts and toast, the pin room, a chunked add refused halfway,
the upload check), `test/render.projects-ask.test.ts` (Ask in a project, the refusal of a new thread). The schema guards cover the new tables:
`test/deletion.org.test.ts` (`ORG_TABLES`), `test/rename-handle.test.ts` (`HANDLE_COLUMNS`),
`test/data-layer.static.test.ts`, `test/seed-scenarios.test.ts`.
