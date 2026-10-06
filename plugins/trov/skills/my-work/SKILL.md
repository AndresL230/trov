---
name: my-work
description: Use when a person asks what they're working on or what's on their plate (triggers — "what am I working on", "my work", "what's on my plate", "what do I have open"). Read-only — this skill never writes.
allowed-tools: mcp__trov__get_my_work
---

# My Work ← Trov

## Overview

A thin skill that reads the caller's personal **My Work** projection from Trov — recent activity
they shipped plus their open to-do — and renders it. Everything comes from one call; there is no
write path here.

## When to use

- Someone asks what they're working on, what's on their plate, or what they have open.

## When NOT to use

- Reading the roadmap plan itself — that's `read-plan`.
- Orienting on an existing subsystem before doing work — that's `load-context` (which also pulls
  `get_my_work` as part of its own orientation step).

## Procedure

1. **One call**: `mcp__trov__get_my_work` — no args. It returns the CALLER's own projection:
   `{person, previousActivity:[{number, title, url, merged, occurredAt, summary}], todo:[{number,
   title, priority, labels, url, updatedAt}], degraded}`.
2. **Render two lists:**
   - **Previous activity** — what they shipped recently (merged/closed PRs), each with its summary.
   - **To-do** — their open assigned issues, with priority/labels.
3. **Note the caveats when reporting:**
   - `previousActivity` is windowed to the **last 14 days** — older shipped work won't appear here.
   - Each `summary` is a **worker-generated projection**, not the raw event — treat it as a helpful
     gloss, and point to the `url` if the person wants the ground truth.
   - If `degraded` is set, say so — it means the projection is running on incomplete data.

## Hard rules

- **Read-only.** This skill never writes, proposes, or stages anything.
- **Raw events remain truth.** Summaries are convenience projections; don't treat them as more
  authoritative than the linked PR/issue itself.
