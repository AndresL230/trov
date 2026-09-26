---
name: record-session
description: Use when a person explicitly asks to wrap up, record, log, or capture the current Claude Code session into Canopy (triggers — "record this session", "session-end", "log this to Canopy", "save what we did"). Explicit invocation only — must never auto-fire at a natural stopping point.
disable-model-invocation: true
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue view:*), Bash(uuidgen:*), mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__record_session, mcp__canopy__upload_asset, Bash(shasum -a 256:*), Bash(sha256sum:*), Bash(wc -c:*), Bash(curl -X PUT:*)
---

# Record Session → Canopy

## Overview

At the **end** of a session, when a person asks for it, this skill observes what the session
actually shipped, **reconciles it against what Canopy already knows**, and emits ONE structured,
per-target payload that declares exactly what was touched and from what base. The worker is the
**gate**: it drops no-ops, stages only real deltas, classifies each doc change, and is replay-safe.
You build the payload; you never bypass the gate and you never confirm (promote/ratify/complete).

**Core principle: observe and reconcile, never recall.** Every artifact (commit, PR, issue) is
copied from real `git`/`gh` output. Every doc/ADR you touch is first **read back from Canopy** so
you write a true delta from a known base — not from memory of the conversation.

Part of the **`canopy`** skill set — this is the **writer** half of the loop; the `canopy` skill is the
umbrella, and `load-context` is the reader that orients before work.

## When to use / NOT use

- Use only when a person **explicitly** says: record / log / wrap up / capture this session. **One**
  payload per explicit request.
- **Never auto-fire.** A natural endpoint (tests pass, branch done) is not a trigger — an auto-firing
  writer floods the store and erodes trust.
- Never **promote, ratify, or complete** anything. Promote and ratify are cookie routes you cannot
  reach at all; `complete_sprint` IS an MCP tool — and still not yours, because a sprint
  is finished when a person says so, never because a session wrapped up. Same for resolving a ticket:
  recording work is not closing the request that asked for it.

## Procedure

### 1. Inventory + classify

Observe what shipped and sort it into target types. Classify placement with the controlled vocab
(see Vocabulary); if nothing fits, that is the LOW-confidence signal (step 3), not license to coin a tag.

| Need | Command (copy values verbatim) |
|------|--------------------------------|
| Branch | `git branch --show-current` |
| Session commits | `git log "$(git merge-base HEAD <default-branch>)"..HEAD --format='%H %s'` |
| PR | `gh pr view --json number,url` or `gh pr list --head <branch> --json number,url` |
| Issues | numbers referenced by those commits/PR, confirmed via `gh issue view <n>` |

If `gh` is unavailable, or a fact is not in `git`/`gh`, it does **not** go in artifacts. No exceptions.

### 2. Read-before-write (every doc and ADR)

Before composing ANY `doc_proposal` or `adr_draft`, orient with the read tools so you write a delta,
not a blind overwrite:

- `mcp__canopy__query` to find the area's current authoritative context (respect the authority flags —
  never treat `staged_pending`/`draft`/`unpromoted` as settled).
- `mcp__canopy__get_doc` for the exact slug you intend to touch. **Capture its `current_version`** and
  pass it as the doc's **`base_version`** — that records the version your edit was based on, so the
  gate can flag a stale edit. If the doc doesn't exist, it's a new slug (omit `base_version`).
- Ground **confidence** honestly against what you read. Reconfirming a settled convention is HIGH; a
  speculative or hard-to-place change is LOW.

### 3. Confidence decides the path (placement certainty, not importance)

- **HIGH** — an in-vocab placement truly fits and the change is grounded. The gate stages/appends it.
- **LOW** — no fitting placement, or you're guessing. Set it low and let the gate route it to
  `needs_triage` for a human to place. **Routing to triage is the correct outcome for an uncertain
  entry, not a failure.** Do not force an unrelated in-vocab tag/section to fake a clean write.

### 4. One feeder block per type (emit the contract object)

Build at most one of each, only for what the session genuinely touched:

- **Feed** — one entry **per shipped unit** of work. `{ summary, brief, body, tags[], artifacts:{ prs[],
  commits[], issues[] } }`. Artifacts are the observed git/gh values from step 1. This is the default;
  almost everything is a feed entry. **Its size and shape are fixed — see "Feed entry format" below.**
- **Doc** — only when the session durably changed a convention/architecture note that belongs in a doc.
  `{ slug, section, space, title?, body, change_summary, confidence, base_version }` (`base_version`
  from step 2; `space` is `sapling` for product docs, `canopy` for tooling docs).
  **Images in a doc** — only uploaded ones: for each picture, `upload_asset { destination: "doc",
  sha256, size_bytes, content_type }` (png / jpeg / gif / webp, ≤ 10 MB), PUT the bytes to its
  `upload_url` unless it answers `uploaded: true`, then write `![what it shows](/img/<sha256>)` in the
  body. Do the uploads BEFORE `record_session`: a doc with a not-yet-uploaded `/img/` ref, or any other
  image source (an external URL, a `data:` URI), comes back under `refused` with the reason and is not
  staged — upload, then send the same batch again (a refused doc is not ledgered, so it stages).
- **ADR** — when the session settled a real decision. `{ title, context, decision, rationale,
  confidence }`. (Previously nothing emitted these — now they land typed in the decisions queue.)
- **Artifact links** — when the session CREATED or VERSIONED artifacts (`upload_asset` /
  `artifact_update` results earlier in the conversation carry their `slug`; the `artifacts` skill
  reports each one's `url`), link each to what it belongs to — its ticket above all, and the PR that
  shipped the work it describes: `{ slug, target_type: "ticket" | "sprint" | "pr" | "issue", target_ref }` — a ticket or
  sprint id, or a PR / issue as `owner/repo#n` (observed via `gh`, like every other artifact fact).
  Only slugs a tool call actually returned — never a slug you guess. These are NOT staged: after the
  batch is reconciled each is linked directly, as you (idempotent; a page you cannot see is
  `not_found`). Contract: `docs/artifact-contract.md`.

### 5. Assemble ONE payload and call `record_session` once

Mint a session id (`uuidgen`) — it is the **replay key**: re-running the same payload stages
nothing new. Assemble a single `IngestPayload` and pass it to the **`record_session` MCP tool** in
**one** call:

```jsonc
{
  "session": { "id": "<uuid>", "author": "ignored", "ended_at": "<ISO8601>", "skill_version": "2.0" },
  "feed_entries":        [ /* step 4 */ ],
  "doc_proposals":       [ /* step 4, with base_version */ ],
  "adr_drafts":          [ /* step 4 */ ],
  "needs_triage":        [ /* step 4 */ ],
  "artifact_links":      [ /* step 4 — { slug, target_type, target_ref }, only when the session produced artifacts */ ]
}
```

Call `mcp__canopy__record_session` with that payload. The MCP channel carries your bearer, so the
call authenticates as you and routes through the SAME gate as the human `/ingest` path;
**`session.author` is advisory and ignored — the server stamps the author from your authenticated
principal.** Then **report the structured counts** the tool returns, e.g.
`{ "docs": { "staged": 1, "unchanged": 2, "triaged": 0 }, … }` → "3 docs: 1 staged, 2 unchanged."
`unchanged` means the gate recognised a no-op or a replay and correctly dropped it. When you sent
`artifact_links`, the result also carries `artifact_links` — one `{ slug, target_type, target_ref,
outcome }` per link, `linked` / `not_found` / `error` (with the reason) — report any that did not link.

## Feed entry format — two readers, three fields

Every entry is read two ways. The Feed's **For reading** view (the default, for people) shows only
`summary` + `brief`. **For agents** — and `get_feed` / `query` — show the full `body`. Write each field
for its reader.

- `summary` — the title. **One line, ≤ 100 characters**, starting with the type word: `Shipped:`,
  `Decision:`, `Triage:`, `Status:`, `Finding:`, `Incident:`. Inline markdown only.
- `brief` — **1–2 plain sentences, ≤ 280 characters (hard limit — over it the call fails).** The problem
  that was solved and who it helps, said so a person who uses or runs the product gets it in five
  seconds. No file names, function names, PR/issue numbers, commit shas, migrations or jargon — those go
  in `body` and `artifacts`. Not a restatement of the summary: the summary says WHAT, the brief says
  WHY IT MATTERS. Always send it.
- `body` — the **agent record**: what changed, why, the evidence, what is still open. Aim for
  **≤ 2,500 characters**. Open with the labelled lines of the entry's type (below), in order, as
  `**Label** text`; short `##` headings and short lists are fine after them. No tables, no pasted logs,
  no sign-off. Longer than that → link a doc, ADR or PR through `artifacts` instead of pasting it.
  Every character here is one the skill has to write, so don't pad.
- **One entry = one type = one subject.** A session that did two things (a triage AND a status check)
  writes **two entries**.

**The six types — choose by what the entry is FOR:**

| Type | Use it when | Body opens with, in this order |
|---|---|---|
| `Shipped:` | work merged / deployed (the default) | `**What**` · `**Why**` · `**Impact**` · `**Follow-up**` (optional) |
| `Decision:` | a call was made that is not ADR-sized | `**Decided**` · `**Because**` · `**Instead of**` |
| `Triage:` | PRs / issues / queue were closed, kept, split or moved | `**Closed**` · `**Kept**` · `**Moved to**` · `**Why**` |
| `Status:` | where something in flight stands, incl. what it is waiting on | `**State**` · `**Blocked on**` · `**Next**` |
| `Finding:` | an investigation or measurement produced a result | `**Found**` · `**Evidence**` · `**So**` |
| `Incident:` | something broke in a shared environment | `**What broke**` · `**Cause**` · `**Fix**` · `**Guard**` |

**Worked example:**

```
summary: Shipped: document indexing is a tracked, retried job
brief:   Course documents students upload no longer silently fail to reach the tutor — indexing now
         retries on its own, and admins can see and re-run anything stuck.
body:
**What** documents.index_status is the indexing queue; a sweeper claims one per turn, three spaced attempts
**Why** a failed index was invisible — a Gemini hiccup or a deploy left documents retrieval could never find
**Impact** /upload/sync now indexes too, so syllabus uploads reach RAG; admin list + reindex endpoints
**Follow-up** run the labelling backfill AFTER the shareability backfill (it deletes chunks it withdraws)

## Found along the way
- backfill_document_chunks.py re-indexed private documents as shared — now a caller of index_document
- a wrong ENCRYPTION_KEY indexed ciphertext as course text — extracted_text now decrypts strictly
```

A bad brief, and why: `Added index_status + sweeper (#658), retries 3x with lease backoff` — that is the
body's first line; it names internals and says nothing about who was hurt before.

## Vocabulary — source of truth is `shared/vocabulary.ts` (verify before tagging)

- **Feed tags:** `auth`, `architecture`, `infra`, `api`, `ui`, `data`.
- **Doc sections** (`doc_proposals` only): `reference`, `context`, `decisions`.
- A feed entry has **no section** — tags alone place it. No tag fits → that's the LOW signal, not
  license to coin a tag.

## Hard rules (invariants)

- Never set or spoof **author** — the authenticated principal owns it, server-side.
- Never mark `'done'`, never **promote / ratify / complete**. You only stage/append; humans confirm.
- Never **invent vocab**. In-vocab, or out-of-vocab → triage. Nothing in between.
- Never write **secrets or tokens** into a doc body or artifact.
- **Artifacts are observed** from git/gh, never recalled. Docs/ADRs are **read back before written**.
- **Call once.** The session id makes a re-run replay-safe, but emit one payload per explicit ask.
- **Every feed entry has a brief** — 1–2 plain sentences, ≤ 280 characters, product words only (count
  before you send; over 280 the call fails). `summary` ≤ 100 characters; `body` aims for ≤ 2,500 —
  past that, link a doc/ADR/PR instead of pasting.

## Common mistakes

- Composing a doc body from memory instead of reading the live doc first (step 2) — you lose the base
  and risk a stale rewrite.
- Listing a commit/PR/issue `git`/`gh` does not show → fabricated artifact.
- Forcing an in-vocab tag/section onto work it doesn't describe → should have been low/triage.
- Auto-firing at a natural stopping point instead of waiting for an explicit ask.
- Writing a feed entry as a report — tables, pasted logs, several subjects in one body. Pick one
  type, open with its labelled lines, stay near 2,500 characters, and split the rest into more
  entries or a doc.
- A brief that is really a changelog line (`Added X table + Y endpoint (#12)`). Say what problem is
  gone and for whom, in words a non-engineer would use.

## Install (one-time, per teammate)

The skill ships in the repo at `.claude/skills/record-session/` and is **auto-discovered**. Configure
the `canopy` MCP server with your **personal** bearer — it carries the read tools (`query`/`get_doc`)
and the session-end writer (`record_session`) over the same channel. See the repo README,
"Canopy MCP setup".
