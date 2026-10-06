---
name: prompts
description: Use when a task matches a reusable team prompt, or a person asks for one from the Trov Prompt Library (triggers — "use the SSE review prompt", "is there a prompt for…", "run the migration review", "save this as a prompt"). Reading and filling prompts is safe; save_prompt only ever stages a version a human must publish.
allowed-tools: mcp__trov__search_prompts, mcp__trov__get_prompt, mcp__trov__save_prompt
---

# Prompts ← Trov Prompt Library

## Overview

The **Prompt Library** holds the team's reusable instructions — "review an SSE endpoint", "reconcile a
session before record_session" — each addressed by a **slug**, versioned, and marked `published`,
`staged` or `draft`. A prompt body carries `{{variables}}` for the parts that change per use. Use the
library instead of re-deriving instructions the team has already written down and refined.

Part of the **`trov`** skill set.

## When to use

- A task clearly matches something the team does repeatedly (a review, a triage, a lint pass).
- A person names a prompt, or asks whether one exists.
- You have written the **same** instructions twice — that is the signal to stage a new prompt.

## When NOT to use

- One-off instructions nobody will reuse — don't stage them.
- A handoff's own instructions — those go in the handoff's `prompt.body` (the `handoff` skill), not the
  library.

## Procedure

### 1. Find it

`mcp__trov__search_prompts` with `q` (free text over slug, title, description, body, tags) and/or
`tags` (every tag must match). Results are summaries — `slug`, `title`, `tags`, `version`, `status`,
`excerpt`. Prefer `published`; a `staged` or `draft` prompt is not settled — say so if you use one.

### 2. Fill it

`mcp__trov__get_prompt` with `{ slug, vars }`. Fill every variable you can from the task in front of
you (a file path, an endpoint, a PR number). The response returns the body with those replaced **and
lists every variable still unfilled**.

**Ask the person for each unfilled variable. Never guess one** — a guessed file path or table name
turns a good prompt into confident wrong work.

### 3. Follow it

Treat the filled body as the instructions for the task. It does not override the person or the repo's
own rules; if the two conflict, say so.

### 4. Stage a new prompt — only after writing the same instructions twice

`mcp__trov__save_prompt` with `{ slug, title, body, tags?, summary? }`. Write `{{name}}` for anything
the caller fills in. The version is **always staged**, whatever you pass — it shows as STAGED in the
library and **waits for a human to publish it**. Tell the person the slug and version, and that
someone has to publish it in the Prompt Library before it counts. Saving to an existing slug stages a
new version of it; you cannot rename a slug.

## Hard rules

- **Never guess a variable.** Ask for every one `get_prompt` lists as unfilled.
- **Staged is not published.** A staged or draft prompt is a proposal; say so when you rely on it.
- **Stage only what has been written twice.** The library is for reuse, not for this session's notes.
- You cannot publish — publishing is a person's click in the web app.
