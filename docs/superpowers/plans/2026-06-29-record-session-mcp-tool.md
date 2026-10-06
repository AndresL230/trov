# record_session MCP Batch Tool (close I1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bearer-only agent complete a session-end write by adding an MCP tool `record_session` that routes the full `IngestPayload` through the same `consume()` gate, then point the writer skill at it and prove the path with a revert-red bearer test.

**Architecture:** `src/index.ts` routes `/mcp` through the bearer resolver and everything else through the cookie gate. The agent already speaks MCP under its bearer, so a new MCP tool inherits bearer auth for free. The tool is a thin adapter over the existing `consume()` — the one reconciling write path — so there is still exactly one gate. The cookie `/ingest` HTTP route and all human-confirm routes are byte-unchanged.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, `@modelcontextprotocol/sdk` (`McpServer` + in-memory client/server transport), Zod (`@shared/contract`), Vitest against real Miniflare D1.

## Global Constraints

- **One reconciling write path.** `record_session` and the cookie `/ingest` route BOTH funnel through `consume()` (`src/consumer.ts:277`). No parallel write logic, no hand-inserts, no second write surface.
- **No second auth path.** The tool resolves its principal the same way the other MCP write tools do — the bearer `principal` already in scope inside `buildCanopyMcpServer`. Do NOT add a token-in-a-header path or widen any route's auth. `/mcp` stays bearer-only; the cookie `/ingest` route and human-confirm routes stay cookie-only.
- **Author is ALWAYS the authenticated principal.** `consume()` already stamps `author = principal.login` and ignores the client-supplied `session.author`. Do not change that.
- **Staging stays non-destructive.** No hard-deletes anywhere.
- **`src/routes.ts` is byte-unchanged.** The cookie `/ingest` route (`src/routes.ts:24-33`) and the human-confirm routes must not be touched. `git diff src/routes.ts` must be empty at the end.
- **`test/ingest.route.test.ts` is left as-is** — it legitimately covers the human cookie path.
- **Diff scope:** only `src/mcp.ts`, `.claude/skills/record-session/SKILL.md`, the new `test/record-session.mcp.test.ts`, and the two retitled test files (`test/mcp-writes.gated.test.ts`, `test/roadmap.test.ts`). Do NOT touch `CLAUDE.md`, `README.md`, or the `canopy`/`load-context` skills.
- **Green bar:** `npm test` AND `npm run typecheck` both pass (typecheck is NOT part of `npm test`; run both).
- **Run one test file:** `npx vitest run test/<file>.test.ts`.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/mcp.ts` | Modify | Register the `record_session` MCP tool alongside the existing tools; it forwards a full `IngestPayload` to `consume()` under the bearer principal already in scope. |
| `test/record-session.mcp.test.ts` | Create | The acceptance test: drives the registered `record_session` tool through real MCP dispatch under a real-resolved bearer principal (no cookie); asserts counts, rows, bearer author, and replay. Revert-red. |
| `.claude/skills/record-session/SKILL.md` | Modify | Writer skill now calls the `record_session` MCP tool instead of curling the cookie-gated `/ingest`. |
| `test/mcp-writes.gated.test.ts` | Modify (retitle only) | Titles/comment must say plainly it drives the gate functions directly, not the registered MCP tools. |
| `test/roadmap.test.ts` | Modify (retitle only) | One test title must say `consume()` (what it calls), not `/ingest` (which it does not hit). |

Reference facts the tasks rely on (already verified in the codebase — do not re-derive):
- `buildCanopyMcpServer(env, principal)` — `src/mcp.ts:39`. The bearer `principal` is in scope for every tool closure; the write tools use `principal.login`.
- `consume(db, payload, principal)` — `src/consumer.ts:277`. Reads `author = principal.login`, ignores `payload.session.author`, keys the replay ledger on `payload.session.id` + per-item index, returns `IngestResult` (per-type `{written/staged, unchanged, triaged}` counts).
- `IngestPayload` (Zod) — `shared/contract.ts:108`. `.shape` is the raw shape; arrays default to `[]`, `focus` is optional.
- `resolveBearerPrincipal(request, env)` — `src/auth/principal.ts:22`. Reads `Authorization: Bearer <raw>`, returns `{ login } | null`. This is exactly what `index.ts:13` calls before `handleMcp`.
- `mintToken(db, login)` — `src/auth/tokens.ts:7`. Returns `{ raw }` (a `canopy_mcp_…` token), stores only its hash.
- Author columns per table: `feed.author`, `doc_versions.created_by`, `adrs.created_by` (`shared/rows.ts`).
- The InMemoryTransport dispatch pattern is established in `test/mcp.append_feed.test.ts` and `test/query.mcp-route.test.ts` — copy its shape.
- `record_session` takes the WHOLE payload, so unlike the per-call write tools it must NOT use an ephemeral session id — `consume()` already keys the ledger on `payload.session.id`, which is what makes the replay test pass.

---

## Task 0: Branch off main

- [ ] **Step 1: Confirm clean tree on main**

Run: `git status --short && git branch --show-current`
Expected: empty status, `main`.

- [ ] **Step 2: Create the working branch**

```bash
git checkout -b feat/record-session-mcp-tool
```

---

## Task 1: Register `record_session` + the real bearer-path acceptance test

This is the heart of the task and one TDD cycle: the test cannot pass without the tool, and the tool is not proven without the test. Write the test first, watch it fail (tool not registered), implement, watch it pass, then deliberately break the wiring to confirm it is revert-red.

**Files:**
- Create: `test/record-session.mcp.test.ts`
- Modify: `src/mcp.ts` (add imports near `src/mcp.ts:9-10`; register the tool after `set_focus` at `src/mcp.ts:142`)

**Interfaces:**
- Consumes: `buildCanopyMcpServer(env, principal)` (`src/mcp.ts:39`), `resolveBearerPrincipal` (`src/auth/principal.ts:22`), `mintToken` (`src/auth/tokens.ts:7`), `consume` (`src/consumer.ts:277`), `IngestPayload` (`shared/contract.ts:108`).
- Produces: a registered MCP tool named exactly `record_session` whose result `content[0].text` is `JSON.stringify(IngestResult)`.

- [ ] **Step 1: Write the failing acceptance test**

Create `test/record-session.mcp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCanopyMcpServer } from "../src/mcp";
import { resolveBearerPrincipal } from "../src/auth/principal";
import type { Principal } from "../src/auth/principal";
import { mintToken } from "../src/auth/tokens";
import { all } from "../src/db";
import type { FeedRow, DocVersionRow, AdrRow } from "@shared/rows";
import type { IngestResult } from "../src/consumer";

type Env = import("../src/env").Env;

// Seed a member and mint a REAL bearer token for them (hash stored, raw returned once).
async function seedUserWithBearer(login: string): Promise<string> {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`)
    .bind(login, login, "2026-01-01T00:00:00Z").run();
  const { raw } = await mintToken(env.DB, login);
  return raw;
}

// Resolve the principal the SAME way index.ts does for /mcp: a bearer token in the
// Authorization header, NO cookie, through the real resolveBearerPrincipal. The
// principal handed to the server is the resolver's output, never a hand-written literal.
async function bearerPrincipal(rawToken: string): Promise<Principal> {
  const req = new Request("https://canopy.example/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${rawToken}` },
  });
  const principal = await resolveBearerPrincipal(req, env as unknown as Env);
  if (!principal) throw new Error("bearer did not resolve — test setup is wrong");
  return principal;
}

// Drive the ACTUAL registered record_session tool through real MCP dispatch
// (SDK Client → Server over an in-memory transport) under the resolved bearer
// principal. Returns the structured IngestResult the tool emits.
async function callRecordSession(
  principal: Principal,
  payload: unknown
): Promise<{ result: IngestResult; isError?: boolean }> {
  const server = buildCanopyMcpServer(env as unknown as Env, principal);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({
      name: "record_session",
      arguments: payload as Record<string, unknown>,
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { result: JSON.parse(res.content[0].text) as IngestResult, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

// A full payload: feed + doc + adr. session.author is a DELIBERATELY WRONG value so
// we can prove the server ignores it and stamps the bearer principal instead.
function fullPayload(sessionId: string) {
  return {
    session: { id: sessionId, author: "client-spoofed-NOT-the-author", ended_at: "2026-06-29T00:00:00Z", skill_version: "2.0" },
    feed_entries: [
      { summary: "shipped record_session", body: "the agent path", tags: ["infra"], artifacts: { prs: ["99"], commits: ["deadbeef"], issues: [7] } },
    ],
    doc_proposals: [
      { slug: "agent-path", section: "reference", title: "Agent Path", body: "the bearer agent write path", change_summary: "init", confidence: "high" },
    ],
    adr_drafts: [
      { title: "Agents write via MCP", context: "ctx", decision: "record_session over /mcp", rationale: "bearer-only agents reach the gate over the channel they hold", confidence: "high" },
    ],
  };
}

describe("record_session MCP tool — the real bearer-only agent write path", () => {
  it("a bearer principal (no cookie) writes a whole session through record_session and gets counts back", async () => {
    const raw = await seedUserWithBearer("bearer-agent");
    const principal = await bearerPrincipal(raw); // real auth resolution, no cookie
    expect(principal).toEqual({ login: "bearer-agent" });

    const { result, isError } = await callRecordSession(principal, fullPayload("record-session-mcp-S1"));
    expect(isError).toBeFalsy();

    // Structured per-type counts come back, exactly like /ingest reports.
    expect(result.feed).toEqual({ written: 1, unchanged: 0, triaged: 0 });
    expect(result.docs).toEqual({ staged: 1, unchanged: 0, triaged: 0 });
    expect(result.adrs).toEqual({ staged: 1, unchanged: 0, triaged: 0 });

    // Rows landed, and the author on EVERY row is the bearer principal — never the
    // client-supplied session.author.
    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.map((f) => f.author)).toEqual(["bearer-agent"]);

    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(versions).toHaveLength(1);
    expect(versions[0].created_by).toBe("bearer-agent");
    expect(versions[0].status).toBe("staged");

    const adrs = await all<AdrRow>(env.DB, `SELECT * FROM adrs`);
    expect(adrs).toHaveLength(1);
    expect(adrs[0].created_by).toBe("bearer-agent");
    expect(adrs[0].status).toBe("draft");
  });

  it("replay: a second record_session call with the same session.id is all-unchanged with zero new doc_versions", async () => {
    const raw = await seedUserWithBearer("bearer-agent");
    const principal = await bearerPrincipal(raw);
    const payload = fullPayload("record-session-mcp-replay-S2");

    const firstCall = await callRecordSession(principal, payload);
    expect(firstCall.result.docs.staged).toBe(1);

    const versionsBefore = (await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`)).length;

    const replay = await callRecordSession(principal, payload);
    // The ledger (keyed on session.id) drops every item — proven at the TOOL surface.
    expect(replay.result.feed).toEqual({ written: 0, unchanged: 1, triaged: 0 });
    expect(replay.result.docs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect(replay.result.adrs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });

    const versionsAfter = (await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`)).length;
    expect(versionsAfter).toBe(versionsBefore); // nothing new staged on replay
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS (tool not registered yet)**

Run: `npx vitest run test/record-session.mcp.test.ts`
Expected: FAIL. The `client.callTool({ name: "record_session", ... })` rejects because no tool by that name is registered (MCP error, e.g. "tool not found" / method-not-found). Both `it` blocks red. This is the initial proof the test depends on the tool.

- [ ] **Step 3: Add the imports to `src/mcp.ts`**

In `src/mcp.ts`, extend the consumer import (currently `src/mcp.ts:9`) to add `consume`:

```ts
import { ingestFeedEntry, ingestDocProposal, ingestMilestoneProposal, ingestFocusUpdate, consume } from "./consumer";
```

And add the contract import directly below the `feedEntryFromMcpArgs` import (`src/mcp.ts:10`):

```ts
import { IngestPayload } from "@shared/contract";
```

- [ ] **Step 4: Register the `record_session` tool**

In `src/mcp.ts`, immediately after the `set_focus` tool registration (the block ending at `src/mcp.ts:142`) and before `return server;`, insert:

```ts
  server.tool(
    "record_session",
    "Record a whole Claude Code session into Canopy in ONE reconciled batch: pass a full IngestPayload (session + feed_entries / doc_proposals / adr_drafts / milestone_proposals / focus). Routes through the SAME gate as /ingest — drops no-ops, stages real deltas, classifies each doc change, and is replay-safe on session.id. The author is your authenticated bearer principal; session.author is advisory and ignored. Returns per-type outcome counts. Used by the record-session skill at session end; you only ever stage — humans confirm.",
    IngestPayload.shape,
    // Same reconciling path as the cookie /ingest route: forward the full payload to
    // consume() under the bearer principal already in scope. Re-parse with the contract
    // so defaults (empty arrays) are applied and the type is exactly IngestPayload —
    // the SDK already validated against IngestPayload.shape, so this never throws.
    async (payload) => runTool(() => consume(env.DB, IngestPayload.parse(payload), principal)),
  );
```

- [ ] **Step 5: Run the test to verify it PASSES**

Run: `npx vitest run test/record-session.mcp.test.ts`
Expected: PASS (both `it` blocks).

- [ ] **Step 6: Confirm the test is REVERT-RED (break the wiring, watch it fail, restore)**

Temporarily comment out the entire `server.tool("record_session", …)` block you added in Step 4, then:

Run: `npx vitest run test/record-session.mcp.test.ts`
Expected: FAIL — `callRecordSession` rejects at `client.callTool` because the tool is gone. Record the exact failure message.

Then restore the block and re-run:

Run: `npx vitest run test/record-session.mcp.test.ts`
Expected: PASS again.

(Capture both outputs for the final report — this is the hard acceptance gate. If you prefer, additionally verify the `consume()`-severed variant: temporarily replace the handler body with a stub returning empty counts and confirm the count/row/author assertions go red. Either break suffices; report which you ran and its failing assertion.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If `tsc` flags the `IngestPayload.parse(payload)` arg, the parse already yields a precise `IngestPayload`; no cast should be needed. Do not add a cast unless tsc demands it.)

- [ ] **Step 8: Commit**

```bash
git add src/mcp.ts test/record-session.mcp.test.ts
git commit -m "feat(mcp): add record_session tool routing a full IngestPayload through consume()

Closes the bearer-path gap (I1): a bearer-only agent can now complete a
session-end write over /mcp through the SAME reconciling gate as /ingest.
Author is the bearer principal; session.author stays advisory. Proven by a
revert-red real-dispatch test under a real-resolved bearer (no cookie)."
```

---

## Task 2: Point the writer skill at the `record_session` MCP tool

**Files:**
- Modify: `.claude/skills/record-session/SKILL.md`

No automated test (it is a skill doc). Verification: `npm run typecheck` stays green (no code change) and the diff reads as intended.

- [ ] **Step 1: Update `allowed-tools` frontmatter — drop curl, add the new tool**

In `.claude/skills/record-session/SKILL.md` (`:5`), replace the `allowed-tools` line:

Old:
```
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue view:*), Bash(uuidgen:*), Bash(curl:*), mcp__canopy__query, mcp__canopy__get_doc
```
New:
```
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue view:*), Bash(uuidgen:*), mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__record_session
```

- [ ] **Step 2: Rewrite step 5 — call the MCP tool, not a cookie curl**

Replace the whole of section 5 (`.claude/skills/record-session/SKILL.md:85-109`), i.e. from the heading `### 5. Assemble ONE payload and POST once to ` through the paragraph ending `…correctly dropped it.`, with:

```markdown
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
  "milestone_proposals": [ /* step 4, only if new */ ],
  "focus":               { "working_on": "…", "next_up": "…" }
}
```

Call `mcp__canopy__record_session` with that payload. The MCP channel carries your bearer, so the
call authenticates as you and routes through the SAME gate as the human `/ingest` path;
**`session.author` is advisory and ignored — the server stamps the author from your authenticated
principal.** Then **report the structured counts** the tool returns, e.g.
`{ "docs": { "staged": 1, "unchanged": 2, "triaged": 0 }, … }` → "3 docs: 1 staged, 2 unchanged."
`unchanged` means the gate recognised a no-op or a replay and correctly dropped it.
```

- [ ] **Step 3: Remove the misleading bearer-in-a-body framing from the hard rules**

In the "Hard rules (invariants)" list, replace the line (`.claude/skills/record-session/SKILL.md:123`):

Old:
```
- Never write **secrets, tokens, or your bearer** into a body or artifact.
```
New:
```
- Never write **secrets or tokens** into a doc body or artifact.
```

- [ ] **Step 4: Update the Install note — bearer covers the write tool too, no `CANOPY_ORIGIN` curl**

Replace the Install paragraph (`.claude/skills/record-session/SKILL.md:136-139`):

Old:
```
The skill ships in the repo at `.claude/skills/record-session/` and is **auto-discovered**. Configure
the `canopy` MCP server with your **personal** bearer (for the read tools `query`/`get_doc`) and set
`CANOPY_ORIGIN` to the Canopy origin for the `/ingest` POST. See the repo README, "Canopy MCP setup".
```
New:
```
The skill ships in the repo at `.claude/skills/record-session/` and is **auto-discovered**. Configure
the `canopy` MCP server with your **personal** bearer — it carries the read tools (`query`/`get_doc`)
and the session-end writer (`record_session`) over the same channel. See the repo README,
"Canopy MCP setup".
```

- [ ] **Step 5: Sanity-check the skill no longer references the cookie curl path**

Run: `grep -nE "curl|/ingest|CANOPY_ORIGIN" .claude/skills/record-session/SKILL.md`
Expected: no matches (the only write surface the skill now names is `record_session`).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/record-session/SKILL.md
git commit -m "docs(skills): record-session now calls the record_session MCP tool

The writer reaches the gate over the bearer channel it holds, instead of
curling the cookie-gated /ingest (which 401s for a headless agent)."
```

---

## Task 3: Retitle the two tests that imply coverage they lack

**Files:**
- Modify: `test/mcp-writes.gated.test.ts` (gate-function tests mis-titled as MCP-tool tests)
- Modify: `test/roadmap.test.ts` (one `consume()` test mis-titled as an `/ingest` test)

No behavior change — titles/comments only. The suite must stay green.

- [ ] **Step 1: Rewrite the file comment in `test/mcp-writes.gated.test.ts`**

Replace the comment block (`test/mcp-writes.gated.test.ts:8-10`):

Old:
```ts
// These are the exact gate functions the MCP `append_feed` / `propose_doc_update`
// tools delegate to (see src/mcp.ts). Driving them proves the vocabulary/confidence
// gate now holds on the MCP write surface, identically to the /ingest consumer.
```
New:
```ts
// These call the gate functions in src/consumer.ts DIRECTLY (ingestFeedEntry /
// ingestDocProposal) — the layer beneath BOTH the MCP write tools and /ingest. They
// prove the vocabulary/confidence gate itself. The registered MCP tools are driven
// end-to-end through real dispatch in mcp.append_feed / mcp.propose_doc /
// record-session.mcp tests, not here.
```

- [ ] **Step 2: Retitle the `describe` block**

Replace (`test/mcp-writes.gated.test.ts:13`):

Old:
```ts
describe("MCP write tools route through the vocabulary gate", () => {
```
New:
```ts
describe("gate functions (consumer.ts) enforce the vocabulary/confidence gate", () => {
```

- [ ] **Step 3: Retitle each `it` to name the function it actually calls**

Make these five exact replacements in `test/mcp-writes.gated.test.ts`:

- `"append_feed: an in-vocab tag is written to the feed, nothing triaged"` → `"ingestFeedEntry: an in-vocab tag is written to the feed, nothing triaged"`
- `"append_feed: an out-of-vocab tag routes the whole entry to needs_triage and writes no feed row"` → `"ingestFeedEntry: an out-of-vocab tag routes the whole entry to needs_triage and writes no feed row"`
- `"propose_doc_update: in-vocab high-confidence stages a version (non-destructive), nothing triaged"` → `"ingestDocProposal: in-vocab high-confidence stages a version (non-destructive), nothing triaged"`
- `"propose_doc_update: an out-of-vocab section routes to triage and writes no doc/version"` → `"ingestDocProposal: an out-of-vocab section routes to triage and writes no doc/version"`
- `"propose_doc_update: a low-confidence proposal routes to triage and writes no doc/version"` → `"ingestDocProposal: a low-confidence proposal routes to triage and writes no doc/version"`

- [ ] **Step 4: Retitle the mis-named test in `test/roadmap.test.ts`**

Replace (`test/roadmap.test.ts:80`):

Old:
```ts
  it("/ingest funnels milestone_proposals through the same gate and stages them", async () => {
```
New:
```ts
  it("consume() funnels milestone_proposals through the same gate and stages them", async () => {
```

- [ ] **Step 5: Run both retitled files to confirm still green**

Run: `npx vitest run test/mcp-writes.gated.test.ts test/roadmap.test.ts`
Expected: PASS (identical test count, only names changed).

- [ ] **Step 6: Commit**

```bash
git add test/mcp-writes.gated.test.ts test/roadmap.test.ts
git commit -m "test: retitle gate-function tests so no name implies tool/route coverage it lacks

mcp-writes.gated drives the consumer.ts gate functions directly (not the
registered MCP tools); the roadmap test calls consume() (not the /ingest route)."
```

---

## Task 4: Full gate + scope verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, all files including the new `record-session.mcp.test.ts` and the unchanged `ingest.route.test.ts`.

- [ ] **Step 2: Typecheck (worker + web)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Confirm `src/routes.ts` is byte-unchanged**

Run: `git diff --stat main -- src/routes.ts`
Expected: empty (the cookie `/ingest` route and human-confirm routes are untouched).

- [ ] **Step 4: Confirm the overall diff scope**

Run: `git diff --stat main`
Expected: exactly these paths — `src/mcp.ts`, `.claude/skills/record-session/SKILL.md`, `test/record-session.mcp.test.ts` (new), `test/mcp-writes.gated.test.ts`, `test/roadmap.test.ts`, and this plan doc under `docs/superpowers/plans/`. Nothing else (no `CLAUDE.md`, no `README.md`, no `src/routes.ts`, no `src/consumer.ts`).

- [ ] **Step 5: Update memory — the bearer gap is now closed**

The memory note `canopy-ingest-bearer-gap.md` recorded this exact open decision. Update it (and its `MEMORY.md` pointer) to RESOLVED: the `record_session` MCP tool routes a full `IngestPayload` through `consume()` over the bearer channel, so the writer no longer needs the cookie `/ingest` route. (This lives under `~/.claude/...`, outside the repo diff.)

---

## Self-Review (run before handing back)

**Spec coverage:**
- Part 1 (MCP batch tool, `record_session`, full `IngestPayload` via the contract, bearer principal reuse, calls `consume()`, returns counts) → Task 1, Steps 3-4.
- Part 2 (writer skill calls the MCP tool, removes cookie-curl + misleading bearer line, keeps read-before-write/feeders/session.id/explicit-trigger/report-counts) → Task 2.
- Part 3 (real dispatch, bearer principal, no cookie, asserts counts + rows + bearer author; revert-red; replay through the tool) → Task 1, Steps 1-2, 5-6.
- Part 4 (two retitles) → Task 3.
- Gate (npm test + typecheck green; one reconciling path; no second auth path; `/mcp` bearer; `/ingest` route byte-unchanged; staging non-destructive; scoped diff) → Global Constraints + Task 4.

**Placeholder scan:** every code/edit step shows exact old/new text or full code. No "TBD"/"add error handling"/"similar to".

**Type consistency:** the tool returns `IngestResult` (the test imports the same type from `../src/consumer`); author columns asserted as `feed.author` / `doc_versions.created_by` / `adrs.created_by` match `shared/rows.ts`; `record_session` passes the payload's own `session.id` to `consume()` (no ephemeral id), which is what makes the replay assertion hold.

## Report back (state explicitly)

- That `record_session` routes through `consume()` — cite `src/mcp.ts` (the new registration) and `src/consumer.ts:277`.
- How the bearer principal is resolved: reuse of the `principal` already in scope in `buildCanopyMcpServer` (same as every other MCP write tool), and in the test, the real `resolveBearerPrincipal` of a minted bearer with no cookie — not a new path, not a hand-written literal.
- Exactly how you confirmed Part 3 is revert-red: which wiring you broke, the failing message you observed, and that it went green again on restore.
- Each test listed with the surface and auth it drives (e.g. `record-session.mcp.test.ts` → registered `record_session` via real MCP dispatch under a real-resolved bearer, no cookie; `ingest.route.test.ts` → live cookie `/ingest` route, unchanged).
- Anything you could not do truthfully.
