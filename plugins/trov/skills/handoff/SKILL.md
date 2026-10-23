---
name: handoff
description: Use when a person explicitly asks to leave a handoff for the next session or another teammate (triggers — "leave a handoff", "hand this off", "I'm switching to someone else", "we're running out of context, write it up for the next session"). Explicit invocation only — must never auto-fire at a natural stopping point.
disable-model-invocation: true
allowed-tools: Bash(git remote get-url:*), Bash(git branch:*), Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(uuidgen:*), Bash(mktemp:*), Bash(shasum -a 256:*), Bash(sha256sum:*), Bash(wc -c:*), Bash(curl -sS -X PUT:*), Write, mcp__trov__send_handoff, mcp__trov__list_handoffs, mcp__trov__get_connection
---

# Handoff → Trov

## Overview

A **handoff** is an addressed message from one session to the next: where the work stands, what is
done, what is next, and the files it touched. It waits in Trov as `pending` until a session **claims**
it — exactly once — and then it is that session's task. A handoff is not knowledge: it does **not** go
through the gate and nobody confirms it. It is a note to a colleague, sent the moment you call the tool.

Part of the **`trov`** skill set. The receiving side is `load-context`, which lists pending handoffs at
session start and claims one only when the person picks it.

## When to use

- The context window is running out mid-task and the next session has to pick it up.
- The work is moving to another person (name them as the recipient) or to whoever gets to it first
  (`anyone`).
- The person is stopping mid-task and wants the next session to start where this one ended.

## When NOT to use

- The work is finished — record it with `record-session` instead; a handoff for done work is noise.
- To file a request for someone else's work — that is a ticket (the `tickets` skill).

## Which organization — pass `repo` on every call

One Trov connection covers every organization you belong to, so every Trov tool takes the repository
you are working in. Once per session, run `git remote get-url origin` and reduce it to `owner/name`
(`git@github.com:acme/app.git` and `https://github.com/acme/app` are both `acme/app`). Pass that as
`repo` on EVERY Trov call this skill makes. No remote, or not a GitHub one: leave `repo` out.

- A connection that **follows the repository** acts in the organization that has that repository
  connected. `repo_required` / `not_connected` mean NOTHING was read or written: tell the person this
  repository is not connected to any of their organizations (Trov › Org settings › Repositories) and
  stop — never pass a different repository to get an answer. `ambiguous_org` lists the candidates:
  ask the person which, then pass it as `org`.
- A **manual** connection ignores `repo` and acts in its current organization. `org_unavailable` /
  `org_not_allowed` list what it may use: ask the person, never guess, and prefer `org` on the call
  over `switch_org` (a switch moves every session that shares the connection).
- Not sure where you are? `get_connection` (same `repo`) answers: the organization this call would
  act in, the connection's mode, and what it can reach.

## Procedure

### 1. Fill the context from git, not from memory

The context has a **fixed shape** — `{ repo, branch, task, done[], next[], files[] }` — and every field
comes from something you can observe:

| Field | Source |
|-------|--------|
| `repo` | `git remote get-url origin` → `owner/name` (strip the host and `.git`) — the same value you pass as the call's own `repo` argument |
| `branch` | `git branch --show-current` |
| `files` | `git diff --name-only main...HEAD` **plus** uncommitted changes (`git status --porcelain`), deduped |
| `task` | one line: what this session was in the middle of |
| `done` | what actually landed this session — one short item each, each one checkable |
| `next` | the concrete next steps, in the order the next session should take them |

Use the repo's real default branch if it is not `main`. Leave a field empty rather than invent it.

### 2. Write the body — short

The **body** is a markdown summary, **under 300 words**. Its **first line is the title** the inbox
shows, so make it say where things stand ("Parser is fixed; prompt and eval aren't."). Then a few
sentences of what the next session must know: the current state, the trap to avoid, where to start.

Long, step-by-step instructions — the kind you would paste into a fresh session — go in the
**prompt** (with a short `prompt.title`), not the body. The prompt belongs to this handoff only; it is
not added to the Prompt Library. How the prompt travels depends on its size (step 3).

### 3. Send exactly one

Call `mcp__trov__send_handoff` with `{ body, recipient, context, prompt?, session }`:

- `recipient` — a person's handle, or `anyone` (the first session to claim it gets it). Default `anyone`.
- `session` — one id for this session (`uuidgen` once, reuse it). A retry of the same handoff with the
  same session does not create a second one; a different handoff from this session is a new one — a
  session may leave as many as the person asks for.

**The prompt — inline or uploaded.** Typing a long prompt into the tool call is slow: every character
is output you have to write out. So:

- **Short prompt (about 2 KB or less), or no shell** (a chat on the web): send it inline,
  `prompt: { title, body }`. The call returns `{ id, url }`.
- **Longer prompt, with a shell:** upload it instead of typing it into the call.
  1. Write the prompt to a temp file (`mktemp`, then the Write tool) — UTF-8 text, at most 32 KB.
  2. `shasum -a 256 <file>` (or `sha256sum <file>`) for the hex digest, `wc -c < <file>` for the size.
  3. Call `send_handoff` with `prompt: { title, sha256, size_bytes }` (no `body` in the prompt). It
     returns `{ upload_url, expires_at }` — **nothing is sent yet**.
  4. `curl -sS -X PUT --data-binary @<file> -H 'Content-Type: text/markdown' "<upload_url>"` within 5
     minutes. THAT creates the handoff and answers `{ id, url }`.
  - A `400` means the bytes did not match what you declared (an edited file, a wrong digest): fix it and
    PUT again — the link stays usable until it expires. A `410` means it was used or has expired: call
    `send_handoff` again with the same `session`.
  - If the call answers `{ id, url, replayed: true }` instead, this session already sent this same
    handoff: there is nothing to PUT.

### 4. Report it

Tell the person **`Left handoff #N for <recipient>`** with the url — for an upload, only once the PUT
has answered with the `id`. Refer to it as `#N` from then on.

## Hard rules

- **Explicit only.** Never leave a handoff on your own at a natural stopping point.
- **Observed, not recalled.** `repo`, `branch` and `files` come from git output, copied verbatim.
- **Body under 300 words; long instructions in the prompt** — uploaded when it is over about 2 KB and you
  have a shell.
- **No `#N` before the PUT.** An upload-form call has sent nothing until its PUT answers.
- You never claim or expire your own handoff to "clean up" — those belong to the receiving session and
  the person.
