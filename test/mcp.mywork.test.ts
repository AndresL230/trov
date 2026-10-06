import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import { ingestEvent } from "../src/consumer";
import { create_ticket } from "../src/tools/tickets";
import { seedPerson } from "./helpers/persons";
import type { CapturedEvent } from "@shared/contract";
import { bearerCtx } from "./helpers/tenant";

const NOW = new Date().toISOString();

function prEvent(number: number, login: string): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`,
    event_type: "pr_merged",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      pr: {
        number,
        title: `PR ${number}`,
        body: "body",
        html_url: `https://github.com/o/r/pull/${number}`,
        merged: true,
        merged_at: NOW,
        closed_at: NOW,
        user: { login },
        milestone: null, // GitHub's own key — not Trov vocabulary
      },
    }),
    provenance: "webhook",
    occurred_at: NOW,
  };
}

function issueEvent(number: number, login: string): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:opened:${NOW}`,
    event_type: "issue",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      action: "opened",
      issue: {
        number,
        title: `Issue ${number}`,
        html_url: `https://github.com/o/r/issues/${number}`,
        state: "open",
        updated_at: NOW,
        user: { login },
        assignees: [{ login }],
        labels: [],
        milestone: null, // GitHub's own key — not Trov vocabulary
      },
    }),
    provenance: "webhook",
    occurred_at: NOW,
  };
}

async function callTool(login: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx(login));
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

describe("registered MCP get_my_work tool", () => {
  it("returns only the CALLING principal's projection", async () => {
    await ingestEvent(env.DB, prEvent(101, "AndresL230"), "github-webhook");
    await ingestEvent(env.DB, prEvent(102, "Jose-Gael-Cruz-Lopez"), "github-webhook");

    const res = await callTool("AndresL230", "get_my_work", {});
    const data = JSON.parse(res.text);
    expect(data.person).toBe("Andres");
    expect(data.previousActivity.map((p: { number: number }) => p.number)).toEqual([101]);
  });

  it("carries the tickets list — the third My Work surface crosses the MCP seam too", async () => {
    await seedPerson("meilin", { name: "Meilin Zhao", github: false });
    await create_ticket(
      env.DB,
      { title: "Laptop won't join the VPN", body: "", category: "access", priority: "normal", assignees: ["AndresL230"] },
      "meilin"
    );

    const res = await callTool("AndresL230", "get_my_work", {});
    const data = JSON.parse(res.text);
    expect(data.tickets).toHaveLength(1);
    expect(data.tickets[0]).toMatchObject({
      title: "Laptop won't join the VPN", category: "access", status: "submitted", source: "canopy", requester: "meilin", sprint: null,
    });
    expect(data.ticketsTotal).toBe(1);
  });
});

describe("registered MCP get_events tool", () => {
  it("respects the type filter", async () => {
    await ingestEvent(env.DB, prEvent(201, "AndresL230"), "github-webhook");
    await ingestEvent(env.DB, issueEvent(7, "AndresL230"), "github-webhook");

    const res = await callTool("AndresL230", "get_events", { type: "issue" });
    const data = JSON.parse(res.text) as Array<{ event_type: string; ref_number: number }>;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ event_type: "issue", ref_number: 7 });
  });
});
