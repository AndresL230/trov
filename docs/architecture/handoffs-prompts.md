# Handoffs and the Prompt Library

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Handoffs & Prompt Library — direct writers, NOT the ingestion gate

Ported from the Claude Design project `2c8cfa50`: **Handoffs** (Workspace; `#handoffs`, `#handoffs/new`,
`#handoffs/<id>` — `web/src/handoffs.ts`), **Prompt Library** (Knowledge; `#prompts`, `#prompts/new`,
`#prompts/<slug>`, `#prompts/<slug>/edit|version` — `web/src/prompts.ts`), **Docs › New doc** (`#docs/new`) and
**Unplaced** (Triage; `#unplaced` — `web/src/maintenance.ts`, the screen id is still `maintenance`). It was the
tabbed Maintenance until 2026-10-06: Identity and People moved into Org settings › Members and the admin
email-notification sections into Org settings › Notifications; `#maintenance`, `#maintenance/identity` and
`#maintenance/people` still resolve (`web/src/hash.ts`).
Storage is `0028_handoffs_prompts` (`handoffs` with an INTEGER id rendered `#12`, `context` JSON
`{ repo, branch, task, done[], next[], files[] }`, an inline prompt that is both-or-neither, `expires_at` =
created + 7 days; `prompts` / `prompt_versions`; standalone `prompts_fts` over slug/title/description/body/tags
kept at the LATEST version by triggers on BOTH tables). DTOs + helpers: `shared/handoffs.ts`.

- **A handoff is an addressed message, not knowledge** — `src/tools/handoffs.ts` writes it directly (no vocab,
  no confidence, never staged). The sender is always the principal. A create carrying a session id is
  replay-safe through `processed_items` (item_type `handoff`, same session-id + item-index key as `/ingest`).
  **Claim is ONE conditional UPDATE** (`… WHERE status = 'pending' AND (recipient = 'anyone' OR recipient = me OR
  sender = me)`); on 0 changes it re-reads for 404 / 403 / 409 `handoff is <status>`, so a race has one winner.
  Expire: sender or named recipient, pending only. Create writes a feed row through `append_feed` (no tags).
  The repo cron expires overdue pending handoffs on EVERY tick (`expireDueHandoffs`, D1 only, before the `:00`
  early return).
- **Prompts** (`src/tools/prompts.ts`): every save appends a version; the latest version's status/body ARE the
  prompt's. `savePrompt(…, via)` — a person (`via: "human"`, the cookie route) saves draft/staged/published and
  may rename the slug (both tables, one batch); an agent (`via: "agent"`, MCP `save_prompt`) is FORCED to
  `staged` and may not rename. Publishing a staged version and retagging are session-cookie only. **Usage**
  (0035): `use_count` / `last_used_at` (on `PromptSummary` / `PromptDetail`) are bumped by ONE conditional UPDATE
  in `recordPromptUse` — from MCP `get_prompt` (every principal) and `POST /api/prompts/:slug/used` (the web Copy
  button; 404 unknown slug, 503 on a D1 failure, never a 500); a use is not an edit, so `updated_at` stays, and
  `GET /api/prompts?sort=used` lists the most used first.
- **Delete is SOFT** (0035 PART C; `deletePrompt` / `restorePrompt`): `POST /api/prompts/:slug/delete` stamps
  `deleted_at` / `deleted_by` and touches nothing else — every `prompt_versions` row stays in D1. Only the prompt's
  AUTHOR (case-insensitive) or an org ADMIN / owner; anyone else is 403 with nothing written. A deleted prompt is
  gone from EVERY read — the library, `GET /api/prompts/:slug` (the same 404 as an unknown slug), versions,
  `/search/quick`, MCP `search_prompts` / `get_prompt`, `prompts_fts`, and so every picker fed by the library — and
  takes no write (tags / publish / use / a second delete are 404). **Its slug stays RESERVED**: a save to it (new,
  rename target, or an agent's `save_prompt`) is a 409 `slug <s> belongs to a deleted prompt — restore it instead
  of reusing the slug` — chosen over reuse because a reused slug would silently re-point everything that names it
  (handoffs, skills, agents' `get_prompt` calls) at different instructions, and would collide with a restore.
  `POST /api/prompts/:slug/restore` (same people; 409 `prompt is not deleted` on a live one) clears both columns,
  so the prompt is back exactly as it was. Both are session-cookie only — there is NO MCP delete, so an agent can
  never remove a prompt. On screen: "Delete prompt" in the prompt page's header (author / admins only), the shared
  confirmation MODAL (`web/src/confirm.ts` — see "The confirmation modal" under Artifacts; never `window.confirm`),
  then the library with a toast "Deleted “<title>” · Undo" (`flash(msg, ms, action)` — a
  toast may carry ONE `data-act` button) whose Undo calls restore. There is no list of deleted prompts.
- **Routes** (session cookie, `{ error }` on failure): `GET /api/handoffs?box=mine|me|anyone|sent`,
  `GET /api/handoffs/:id`, `POST /api/handoffs`, `POST /api/handoffs/:id/claim`, `POST /api/handoffs/:id/expire`,
  `GET /api/prompts?q&tags&sort`, `GET /api/prompts/:slug`, `GET /api/prompts/:slug/versions`, `POST /api/prompts`,
  `POST /api/prompts/:slug/tags`, `POST /api/prompts/:slug/publish`, `POST /api/prompts/:slug/delete|restore`, and
  `POST /api/docs/propose` (a person stages
  a NEW doc through `ingestDocProposal`; an existing slug is a 409). The Hono app stays cookie-only — agents
  reach these through MCP, not a bearer on `/api/*` (no new auth class).
- **MCP** (every principal): `send_handoff`, `list_handoffs` (pending `me` + `anyone` by default; only `sent`
  shows claimed/expired), `get_handoff`, `claim_handoff` (returns one markdown block: prompt, `## Handoff
  summary`, `## Context`), `expire_handoff`, `search_prompts`, `get_prompt` (fills `{{vars}}`, lists `unfilled`),
  `save_prompt` (always staged). There is no per-token rate limit in Trov today.
- Skills: `handoff`, `prompts`, and `load-context` (lists waiting handoffs at session start; never auto-claims).
