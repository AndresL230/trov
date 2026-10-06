import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import { all } from "../src/db";
import type { FeedRow, NeedsTriageRow } from "@shared/rows";
import { bearerCtx } from "./helpers/tenant";

const AUTHOR = "agent";

// Drive the ACTUAL registered MCP `append_feed` tool through an in-memory MCP
// client/server pair — the same closure production runs. The prior test only
// exercised the feedEntryFromMcpArgs HELPER, which the live tool never imported,
// so prs/commits were silently dropped at the real call site. This drives the
// registered tool end-to-end through the gate (audit F3).
async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx(AUTHOR));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("registered MCP append_feed tool carries prs/commits through the gate", () => {
  it("stores the brief beside the body", async () => {
    const brief = "Tutor answers no longer vanish mid-turn — the reply finishes instead of asking students to retry.";
    const res = await callTool("append_feed", { summary: "Shipped: textless turns finish", brief, body: "**What** long record", tags: ["api"] });
    expect(JSON.parse(res.text).outcome).toBe("written");
    const [row] = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(row.brief).toBe(brief);
    expect(row.body).toBe("**What** long record");
  });

  it("a brief over 280 characters is refused and nothing is written", async () => {
    const res = await callTool("append_feed", { summary: "too long", brief: "x".repeat(281), tags: ["api"] });
    expect(res.isError).toBe(true);
    expect((await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length).toBe(0);
  });

  it("an entry without a brief stores NULL", async () => {
    await callTool("append_feed", { summary: "no brief", tags: ["api"] });
    const [row] = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(row.brief).toBeNull();
  });

  it("round-trips prs/commits/issues into the stored feed artifacts json", async () => {
    const res = await callTool("append_feed", {
      summary: "shipped",
      body: "widened append_feed",
      tags: ["infra"],
      prs: ["14"],
      commits: ["abc123"],
      issues: [7],
    });
    expect(JSON.parse(res.text).outcome).toBe("written");

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    expect(feed[0].author).toBe(AUTHOR); // author is the bearer principal, not client-supplied
    const artifacts = JSON.parse(feed[0].artifacts!);
    expect(artifacts.prs).toEqual(["14"]);
    expect(artifacts.commits).toEqual(["abc123"]);
    expect(artifacts.issues).toEqual([7]);
  });

  it("an out-of-vocab tag routes the whole entry to needs_triage (gate still holds on the real tool)", async () => {
    const res = await callTool("append_feed", { summary: "bad", tags: ["not-a-real-tag"], prs: ["1"] });
    expect(JSON.parse(res.text).outcome).toBe("triaged");

    expect((await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length).toBe(0);
    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].source_author).toBe(AUTHOR);
  });
});
