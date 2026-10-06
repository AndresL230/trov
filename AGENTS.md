# AGENTS.md

A short guide for coding agents working in or against **Trov**, the team's shared context store. The
full developer notes for this repository are in `CLAUDE.md`.

## Connect

Trov speaks MCP at `<origin>/mcp` with a personal bearer token (web app → Settings → *Get connection
command*). Every write you make is recorded as the person who owns the token.

## Use the trov skill

The skills in `plugins/trov/skills/` (symlinked from `.claude/skills/`) are how Trov stays living:
`trov` is the map — start there — `load-context` orients before you touch an existing area, and
`record-session` records what a session shipped, only when a person asks. The `query` parameter
reference is `plugins/trov/skills/trov/references/querying.md`.

## The rules that matter

- **Knowledge is staged, a person confirms.** Doc changes, ADRs and feed entries go through the gate
  (`propose_doc_update`, `append_feed`, `record_session`); promoting and ratifying are web-only.
- **Authored work is direct, and scoped.** Tickets: only ones already assigned to you (filing is the
  exception; `assign_ticket` is open to an admin, the ticket's requester or an assignee). Sprints and the plan: admin only.
- **Trust `live`.** Anything flagged `staged_pending`, `unpromoted` or `draft` is not settled yet.

## Artifacts

Versioned pages — HTML, markdown, SVG, mermaid, images, PDFs, files — that you find with `artifact_list`
(or `query`, or a ticket's `artifacts`), read with `artifact_get`, and create and update with
`upload_asset` / `artifact_update`. **To use one in code**, `artifact_get` gives every kind a signed,
five-minute `download_url`: `curl -fsSL "$download_url" -o .trov/artifacts/<slug>/v<n>.<ext>`, then
check `shasum -a 256` against its `sha256` (`.trov/` is gitignored). Binary files go up through a
single-use, five-minute upload URL. When a person only wants to see it, give them its `url`. **Ratifying
an artifact is a person's act on the web; no tool does it.** The procedure is the `artifacts` skill;
kinds, caps, statuses, permissions and the upload / download flows: **`docs/artifact-contract.md`**.
