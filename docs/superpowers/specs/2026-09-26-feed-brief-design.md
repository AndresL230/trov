# Feed brief + artifact read/size limits — design

Date: 2026-09-26 · Branch: `feat/feed-brief` · Status: approved in conversation, awaiting spec review

## Why

Nobody reads the Feed. Recent entries carry 2,500–5,000-character bodies with headings and tables, and
even the one-line `summary` runs ~200 characters; the `record-session` skill's 1,200-character cap is not
holding. But that long body is exactly the context agents need when they orient, so it must not be lost.

The answer is two versions of every entry: a **brief** — 1–2 sentences on the problem solved, from a
product standpoint — for people, and the existing body for agents. The Feed gets a switch between them.

The skill update this needs is also the moment to fix a related agent-context cost in artifacts (part 2).

## Part 1 — the feed brief

### Data and contract

- Migration `0034_feed_brief_artifact_cap` (one file for both parts): `ALTER TABLE feed ADD COLUMN brief TEXT` (nullable). No FTS change — the
  brief restates the summary and body, which are already indexed.
- `FeedEntry` (`shared/contract.ts`) gains `brief: z.string().trim().min(1).max(280).optional()`. Over 280
  characters is a validation error: nothing is written, the caller sees the message and resends. It is
  optional so a teammate on an older plugin keeps working; their entry reads as title-only (below).
- `FeedRow` (`shared/rows.ts`) gains `brief: string | null`.
- `append_feed` (`src/tools/writes.ts`) writes it; `ingestFeedEntry` passes it through. It is part of the
  ingested entry, so it travels through the same gate as the rest — the vocab rule, the replay ledger, and a
  triaged entry's `raw` (so a triage assign keeps it).

### Write surfaces

- MCP `append_feed` gains `brief` (same 280 cap, in the tool's zod schema), and `feedEntryFromMcpArgs`
  carries it. The tool description says what a brief is.
- `record_session` and `/ingest` take it through `IngestPayload.feed_entries` with no further change.

### Read surfaces

- `get_feed` (MCP), `GET /feed` and the triage raw all carry `brief` (they select the row).
- `query`'s assembled feed body leads with the brief when there is one, so an agent sees both.

### The `record-session` skill

- Every feed entry now writes `brief`: **1–2 plain sentences, ≤ 280 characters, on the problem solved and
  who it helps**, written for someone who uses or runs the product. No file names, PR/issue numbers, commit
  shas or internal jargon — those live in the body and `artifacts`.
- The body becomes the **agent record**. The 1,200-character hard cap becomes a **soft target of ~2,500
  characters**: the six entry types and their labelled lines stay as the body's structure, headings and
  short lists are allowed, and anything longer is linked (doc, ADR, PR), not pasted. The gate does not
  reject a long body — a hard cap would bounce a whole session's batch.
- `summary` stays one line, ≤ 100 characters, type-word first. It is the title in both views.
- Worked examples updated to include a brief. Plugin version bump (0.6.3 → 0.6.5).

### The Feed screen (`web/src/render.ts`, `web/src/main.ts`)

- A two-segment switch **For reading | For agents** in the Feed header, before the Author chips.
- State `feedView: "reading" | "agents"`, default `"reading"`, saved per viewer in `localStorage`
  (`canopy.feedView`, every read/write in try/catch — a blocked store just means the default).
- **For reading** card: the title (`summary`), the brief below it, then the existing meta row (author,
  agent badge, time) and the artifact chip row (PRs / commits / issues). No body. An entry with no brief
  shows the title alone.
- **For agents** card: exactly today's card (title + full markdown body + meta + chips).
- Switching is a client-side re-render — the feed payload already carries both.

### Backfilling the existing entries

`scripts/backfill-feed-briefs.mjs`, a one-off local script (not shipped Worker code):

1. Read `SELECT id, summary, body FROM feed WHERE brief IS NULL` with `wrangler d1 execute --remote --json`.
2. For each, ask Gemini (`gemini-2.5-flash-lite`, the model `src/tools/summarize.ts` uses; key from
   `GEMINI_API_KEY` in `.dev.vars`) for the brief under the same rules as the skill, as a JSON object.
3. Validate: non-empty, ≤ 280 characters after trim; a failure is logged and that row skipped (it stays
   title-only; the script can be re-run).
4. Default is a dry run that prints `id · summary · brief`. `--limit N` for the sample; `--apply` writes an
   SQL file of `UPDATE feed SET brief = ? WHERE id = ? AND brief IS NULL` statements and runs it with
   `wrangler d1 execute --remote --file`. `AND brief IS NULL` makes a re-run never overwrite a brief an
   agent wrote.
5. **A 10-entry sample is shown to the owner before `--apply` runs on prod.**

### Rollout order

The Worker writes `feed.brief`, and a 500–750 KB artifact needs the rebuilt CHECK, so **`0034_feed_brief_artifact_cap`
must be applied to prod before the merge deploys** (`npm run db:migrate:remote`). Then merge, then the
backfill.

## Part 2 — artifacts: a 750 KB cap, and big text is not inlined to agents

### The cap

`ARTIFACT_TEXT_CAP` (`shared/artifacts-core.ts`) goes from `500 * 1024` to `750 * 1024`. Every enforcement
reads the constant (the repository, the HTTP body limit `JSON_BODY_MAX`, the From-URL fetch cap), and the
existing tests are written against the constant, so they follow. Well inside D1's 2 MB per-value limit.
But 0030 mirrored the old cap in a CHECK on `artifact_versions` (`size_bytes <= 512000`), and SQLite cannot
alter a CHECK, so the same migration rebuilds the table (the 0033 pattern) with `<= 768000`.
Agents still create text artifacts by passing `content` inline — no text upload path (decided: not needed).

### Inline threshold for agent reads

A tool result lands whole in the agent's context, whether the agent needed the text or only wanted to
save, serve or link the page (the `artifacts` skill's pull path curls `download_url` anyway). So:

- New `ARTIFACT_INLINE_MAX = 64 * 1024` in `shared/artifacts-core.ts`.
- `artifact_get` gains `include_content?: boolean`. A text artifact whose requested version is larger than
  `ARTIFACT_INLINE_MAX` comes back with `content: null` and `content_omitted: true` unless
  `include_content: true`; everything else (`download_url`, `sha256`, `size_bytes`, …) is unchanged.
  `content_omitted` is `false` on every other result. `warnings` are still computed over the full text.
- `query`'s assembled artifact body (`assembleArtifactBody`, `src/tools/reads.ts`) applies the same rule:
  over the threshold, the content line is replaced by
  `(<kind> · <size_bytes> bytes — too large to inline; read it with artifact_get)`.
- The `artifacts` skill: for a large page, pull the file with `download_url` and grep / read slices of it;
  pass `include_content: true` only when the whole text is genuinely needed.

## Testing

- Gate: a brief is stored and read back; a 281-character brief is refused with nothing written; an entry
  without one stores `NULL`; a replayed batch does not double-write; a triaged entry's raw keeps the brief.
- MCP: `append_feed` and `record_session` carry `brief`; `get_feed` returns it.
- Render: For reading shows title + brief + chips and no body; For agents is unchanged; a missing brief is
  title-only; the switch renders its active segment.
- Artifacts: the cap tests pass at 750 KB; `artifact_get` omits a >64 KB text body, inlines one ≤ 64 KB,
  and inlines a large one with `include_content: true`; `query` shows the pointer line over the threshold.
- `npm test` and `npm run typecheck` green.

## Out of scope

- A Gemini fallback for new entries that arrive without a brief.
- A text-artifact upload URL.
- Showing topic tags on feed cards.
