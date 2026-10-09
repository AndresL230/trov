---
name: handoff
description: Use when a person explicitly asks to leave a handoff for the next session or another teammate (triggers — "leave a handoff", "hand this off", "I'm switching to someone else", "we're running out of context, write it up for the next session"). Explicit invocation only — must never auto-fire at a natural stopping point.
disable-model-invocation: true
allowed-tools: Bash(git remote get-url:*), Bash(git branch:*), Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(uuidgen:*), mcp__trov__send_handoff, mcp__trov__list_handoffs, mcp__trov__get_connection
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
- **Never more than one per session.** If a handoff was already sent this session, report its `#N`
  instead of sending another.

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

Long, step-by-step instructions — the kind you would paste into a fresh session — go in
**`prompt.body`** (with a short `prompt.title`), not the body. The prompt belongs to this handoff only;
it is not added to the Prompt Library.

### 3. Send exactly one

Call `mcp__trov__send_handoff` with `{ body, recipient, context, prompt?, session }`:

- `recipient` — a person's handle, or `anyone` (the first session to claim it gets it). Default `anyone`.
- `session` — one id for this session (`uuidgen` once, reuse it). A retried call with the same session
  does not create a second handoff.

It returns `{ id, url }`.

### 4. Report it

Tell the person **`Left handoff #N for <recipient>`** with the url. Refer to it as `#N` from then on.

## Hard rules

- **Explicit only.** Never leave a handoff on your own at a natural stopping point.
- **One per session.** Report the existing `#N` instead of sending a second.
- **Observed, not recalled.** `repo`, `branch` and `files` come from git output, copied verbatim.
- **Body under 300 words; long instructions in `prompt.body`.**
- You never claim or expire your own handoff to "clean up" — those belong to the receiving session and
  the person.
