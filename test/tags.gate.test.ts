// The gate and the organization's tag list (0054_org_tags; docs/architecture/ingestion-gate.md).
//
// A feed entry's tags are read against the ORG's own live list. A tag on it is written; one that is
// not no longer sends the entry to needs_triage — the entry is written with the tags it may have, and
// the other is recorded as a suggestion for an admin. Everything else about the gate is as it was:
// the replay ledger, and the section / confidence routing of docs and decisions.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IngestPayload } from "@shared/contract";
import type { NeedsTriageRow } from "@shared/rows";
import { consume, ingestFeedEntry } from "../src/consumer";
import { buildTrovMcpServer } from "../src/mcp";
import { get_feed } from "../src/tools/reads";
import { addTag, liveTagNames, mergeTag, retireTag } from "../src/tools/tags";
import mcpSource from "../src/mcp.ts?raw";
import { all } from "./helpers/db";
import { ORG_A, ORG_B, bearerCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const session = { id: "sess-tags", author: "andres", ended_at: "2026-10-13T00:00:00Z", skill_version: "1.0" };
const artifacts = { prs: [], commits: [], issues: [] };
const entry = (summary: string, tags: string[]) => ({ summary, body: "b", tags, artifacts });
const suggestions = (org = ORG_A) => all<{ name: string; entry_type: string; entry_id: string; suggested_by: string; source: string; state: string }>(env.DB,
  `SELECT tag AS name, entry_type, entry_id, suggested_by, source, state FROM org_tag_suggestions WHERE org_id = ? ORDER BY id`, org);
const tagsOf = (id: number, org = ORG_A) => all<{ tag: string }>(env.DB, `SELECT tag FROM entry_tags WHERE org_id = ? AND entry_type = 'feed' AND entry_id = ? ORDER BY tag`, org, String(id)).then((r) => r.map((x) => x.tag));

async function callTool(name: string, args: Record<string, unknown>, handle = "agent"): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { text: res.content[0].text, isError: res.isError };
  } finally { await client.close(); await server.close(); }
}

describe("the gate reads the org's tag list", () => {
  it("a tag on the list is written; an unknown one becomes a suggestion and the entry is NOT sent to triage", async () => {
    const payload = IngestPayload.parse({ session, feed_entries: [entry("known", ["auth"]), entry("mixed", ["ui", "billing"]), entry("only unknown", ["billing"])] });
    const result = await consume(systemCtx(), payload, { handle: "andres" });

    expect(result.feed).toEqual({ written: 3, unchanged: 0, triaged: 0 });
    expect(result.suggested_tags).toEqual(["billing"]);
    expect(await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`)).toEqual([]);

    const feed = await get_feed(systemCtx(), {});
    const by = Object.fromEntries(feed.map((f) => [f.summary, f]));
    expect(by.known.tags).toEqual(["auth"]);
    expect(by.mixed.tags).toEqual(["ui"]);          // in the feed, without the unknown tag
    expect(by["only unknown"].tags).toEqual([]);

    // Who sent it, and on which entries — one row per item.
    expect(await suggestions()).toEqual([
      { name: "billing", entry_type: "feed", entry_id: String(by.mixed.id), suggested_by: "andres", source: "agent", state: "open" },
      { name: "billing", entry_type: "feed", entry_id: String(by["only unknown"].id), suggested_by: "andres", source: "agent", state: "open" },
    ]);
    // Nothing an agent sends adds a tag to the list.
    expect(await liveTagNames(systemCtx())).toEqual(["auth", "architecture", "infra", "api", "ui", "data"]);
  });

  it("replay safety is unchanged: the same payload again writes nothing and records no second suggestion", async () => {
    const payload = IngestPayload.parse({ session, feed_entries: [entry("mixed", ["ui", "billing"])] });
    await consume(systemCtx(), payload, { handle: "andres" });
    const again = await consume(systemCtx(), payload, { handle: "andres" });

    expect(again.feed).toEqual({ written: 0, unchanged: 1, triaged: 0 });
    expect(again.suggested_tags).toBeUndefined();
    expect((await get_feed(systemCtx(), {})).length).toBe(1);
    expect((await suggestions()).length).toBe(1);
  });

  it("a batch with no unknown tag reads exactly as before (no suggested_tags key)", async () => {
    const result = await consume(systemCtx(), IngestPayload.parse({ session, feed_entries: [entry("known", ["auth", "data"])] }), { handle: "andres" });
    expect(result).toEqual({
      feed: { written: 1, unchanged: 0, triaged: 0 }, docs: { staged: 0, unchanged: 0, triaged: 0 },
      adrs: { staged: 0, unchanged: 0, triaged: 0 }, triage: { recorded: 0, unchanged: 0 },
    });
  });

  it("every other gate rule holds: an out-of-vocab section and a low-confidence decision still go to triage", async () => {
    const result = await consume(systemCtx(), IngestPayload.parse({
      session,
      doc_proposals: [{ slug: "bad-section", section: "made-up", body: "x", change_summary: "s", confidence: "high" }],
      adr_drafts: [{ title: "t", context: "c", decision: "d", rationale: "r", confidence: "low" }],
    }), { handle: "andres" });
    expect(result.docs.triaged).toBe(1);
    expect(result.adrs.triaged).toBe(1);
    expect((await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`)).length).toBe(2);
  });

  it("an agent's spelling is read as the tag's: case, spaces and underscores; what is not a tag at all is dropped", async () => {
    const r = await ingestFeedEntry(systemCtx(), entry("spelling", [" Auth ", "API", "not a tag!", "", "customer_success"]), "andres");
    expect(r).toMatchObject({ outcome: "written", tags: ["auth", "api"], suggested_tags: ["customer-success"], ignored_tags: ["not a tag!", ""] });
    if (r.outcome !== "written") throw new Error("unreachable");
    expect(await tagsOf(r.id)).toEqual(["api", "auth"]);
    expect((await suggestions()).map((s) => s.name)).toEqual(["customer-success"]);
  });

  it("org A's own tag is unknown in org B", async () => {
    const admin = await tenantCtx("AndresL230");
    await addTag(admin, { name: "billing", description: "Invoices and seats" });

    const inA = await ingestFeedEntry(systemCtx(ORG_A), entry("a", ["billing"]), "andres");
    const inB = await ingestFeedEntry(systemCtx(ORG_B), entry("b", ["billing"]), "andres");
    expect(inA).toMatchObject({ outcome: "written", tags: ["billing"] });
    expect(inB).toMatchObject({ outcome: "written", tags: [], suggested_tags: ["billing"] });

    expect(await liveTagNames(systemCtx(ORG_B))).not.toContain("billing");
    expect(await suggestions(ORG_A)).toEqual([]);
    expect((await suggestions(ORG_B)).map((s) => s.name)).toEqual(["billing"]);
    // …and org B's feed never shows org A's entry or its tag.
    expect((await get_feed(systemCtx(ORG_B), { tags: ["billing"] }))).toEqual([]);
    expect((await get_feed(systemCtx(ORG_A), { tags: ["billing"] })).map((f) => f.summary)).toEqual(["a"]);
  });

  it("a retired tag can no longer be picked: an agent that sends it gets a suggestion; a merged name reads as its target", async () => {
    const admin = await tenantCtx("AndresL230");
    await addTag(admin, { name: "onboarding" });
    await addTag(admin, { name: "signup" });
    await retireTag(admin, "onboarding");
    await mergeTag(admin, "signup", "auth");

    const r = await ingestFeedEntry(systemCtx(), entry("late", ["onboarding", "signup"]), "andres");
    expect(r).toMatchObject({ outcome: "written", tags: ["auth"], suggested_tags: ["onboarding"] });
  });

  it("an org with no tag rows (created by the Worker from before 0054) is given the starters on first read", async () => {
    await env.DB.prepare(`DELETE FROM org_tags WHERE org_id = ?`).bind(ORG_B).run();
    const r = await ingestFeedEntry(systemCtx(ORG_B), entry("first", ["infra"]), "andres");
    expect(r).toMatchObject({ outcome: "written", tags: ["infra"] });
    expect(await liveTagNames(systemCtx(ORG_B))).toEqual(["auth", "architecture", "infra", "api", "ui", "data"]);
  });
});

describe("MCP: agents read the list and can only use it", () => {
  it("list_tags returns the org's live tags with what each is for", async () => {
    const admin = await tenantCtx("AndresL230");
    await addTag(admin, { name: "billing", description: "Invoices and seats" });
    await addTag(admin, { name: "gone" });
    await retireTag(admin, "gone");
    const { tags } = JSON.parse((await callTool("list_tags", {})).text) as { tags: { name: string; description: string }[] };
    expect(tags.map((t) => t.name)).toEqual(["auth", "architecture", "infra", "api", "ui", "data", "billing"]);
    expect(tags.find((t) => t.name === "billing")).toEqual({ name: "billing", description: "Invoices and seats" });
  });

  it("append_feed writes the entry and reports the tag it could not use", async () => {
    const res = JSON.parse((await callTool("append_feed", { summary: "seat counts", tags: ["ui", "billing"] })).text);
    expect(res).toMatchObject({ outcome: "written", tags: ["ui"], suggested_tags: ["billing"] });
    expect((await suggestions())[0]).toMatchObject({ name: "billing", suggested_by: "agent" });
    expect(await liveTagNames(systemCtx())).not.toContain("billing");
  });

  it("get_feed carries each entry's tags", async () => {
    await callTool("append_feed", { summary: "tagged", tags: ["ui", "api"] });
    const { 0: row } = JSON.parse((await callTool("get_feed", {})).text) as { tags: string[] }[];
    expect(row.tags).toEqual(["api", "ui"]);
  });

  it("no MCP tool changes the list: src/mcp.ts imports only the read from src/tools/tags.ts", () => {
    const imports = [...mcpSource.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/tools\/tags"/g)].map((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
    expect(imports).toEqual([["listTagRefs"]]);
    expect(mcpSource).not.toMatch(/from\s*"\.\/tags\/routes"/);
  });
});
