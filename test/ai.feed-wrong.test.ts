// "Wrong?" on an entry Trov wrote, filtered IN SQL (owner ruling Q28; src/tools/reads.ts `get_feed`'s `viewer`):
// the Feed (`GET /feed`) and MCP `get_feed` leave out what the reader flagged BEFORE the LIMIT, so a page is never
// short — the reader gets `limit` rows whenever there are that many they may see. Only Trov's entries can be hidden
// (an agent's entry with the same id-shaped ref is not), for the person who pressed it only; the record stays.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import { append_feed } from "../src/tools/writes";
import { get_feed } from "../src/tools/reads";
import { recordFeedback } from "../src/data/ai";
import { aiItemRef } from "@shared/ai";
import type { FeedRow } from "@shared/rows";
import { run } from "./helpers/db";
import { ORG_A, bearerCtx, systemCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { ensureTrovPerson } from "./helpers/ai-roadmap";

const ME = "AndresL230";
const OTHER = "jose-a";
const ctx = () => systemCtx(ORG_A);
const e = env as unknown as Env;

/** Three entries, oldest first: two agent entries and, newest, one Trov wrote — which ME flags "Wrong?". */
async function seed(): Promise<{ older: number; old: number; trov: number }> {
  await ensureTrovPerson();
  await run(env.DB, `DELETE FROM feed WHERE org_id = ?`, ORG_A);
  const older = await append_feed(ctx(), { author: ME, summary: "Decision: keep D1", body: "b", tags: [] });
  const old = await append_feed(ctx(), { author: ME, summary: "Finding: cron weekdays", body: "b", tags: [] });
  const trov = await append_feed(ctx(), { author: ME, summary: "Shipped: hosting screens", body: "b", tags: [] });
  await run(env.DB, `UPDATE feed SET created_at = ? WHERE id = ?`, "2026-10-01T10:00:00.000Z", older);
  await run(env.DB, `UPDATE feed SET created_at = ? WHERE id = ?`, "2026-10-02T10:00:00.000Z", old);
  await run(env.DB, `UPDATE feed SET origin = 'ai', author = 'trov', subject = ?, model = 'claude-haiku-5-5', created_at = ? WHERE id = ?`, ME, "2026-10-03T10:00:00.000Z", trov);
  const fb = { itemType: "feed" as const, itemRef: aiItemRef.feed(trov), kind: "digest.session", model: "claude-haiku-5-5", promptVersion: null };
  await recordFeedback(ctx(), ME, fb);
  // The same ref on an AGENT entry's id hides nothing: only Trov's entries take "Wrong?".
  await recordFeedback(ctx(), ME, { ...fb, itemRef: aiItemRef.feed(old) });
  return { older, old, trov };
}

async function webFeed(handle: string, q: string): Promise<number[]> {
  const res = await app.request(`/api/o/saplinglearn/feed${q}`, { headers: { cookie: await cookieFor(handle) } }, e);
  expect(res.status).toBe(200);
  return ((await res.json()) as { feed: FeedRow[] }).feed.map((r) => r.id);
}

async function mcpFeed(handle: string, args: Record<string, unknown>): Promise<number[]> {
  const server = buildTrovMcpServer(e, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name: "get_feed", arguments: args })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    return (JSON.parse(res.content[0].text) as FeedRow[]).map((r) => r.id);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("the Feed's per-person 'Wrong?' is filtered in SQL — a page is never short (Q28)", () => {
  let ids: { older: number; old: number; trov: number };
  beforeEach(async () => { ids = await seed(); });

  it("limit=2: the flagger gets the TWO newest entries they may see — not one", async () => {
    expect(await webFeed(ME, "?limit=2")).toEqual([ids.old, ids.older]);
    expect(await mcpFeed(ME, { limit: 2 })).toEqual([ids.old, ids.older]);
  });

  it("only for the person who pressed it: anyone else gets Trov's entry first", async () => {
    expect(await webFeed(OTHER, "?limit=2")).toEqual([ids.trov, ids.old]);
    expect(await mcpFeed(OTHER, { limit: 2 })).toEqual([ids.trov, ids.old]);
  });

  it("the record stays: a read with no viewer (the e-mail, the pass) sees all three", async () => {
    expect((await get_feed(ctx(), {})).map((r) => r.id)).toEqual([ids.trov, ids.old, ids.older]);
    expect((await get_feed(ctx(), { viewer: ME })).map((r) => r.id)).toEqual([ids.old, ids.older]);
  });
});
