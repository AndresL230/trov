// MCP `list_people` (0036): the ONE thing an agent may read about people — handle, name,
// role, responsibilities — so it can choose `assignees` on create_ticket. Nothing else
// about a person reaches MCP, and there is no people/profile WRITE tool at all. Drives the
// REAL registered closures over an in-memory transport.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { run } from "./helpers/db";
import type { PersonForAgents } from "@shared/people";
import { seedPerson } from "./helpers/persons";
import { bearerCtx } from "./helpers/tenant";

async function withClient<T>(handle: string, fn: (client: Client) => Promise<T>): Promise<T> {
  await seedPerson(handle);
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const listPeople = (handle = "agent-owner") => withClient(handle, async (client) => {
  const res = (await client.callTool({ name: "list_people", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0].text) as { people: PersonForAgents[] };
});

describe("MCP list_people", () => {
  it("returns every non-reserved person as EXACTLY { handle, name, role, responsibilities }", async () => {
    const { people } = await listPeople();
    for (const p of people) expect(Object.keys(p).sort()).toEqual(["handle", "name", "responsibilities", "role"]);
    expect(people.some((p) => p.handle === "github-webhook")).toBe(false);
    expect(people.find((p) => p.handle === "Jose-Gael-Cruz-Lopez")).toEqual({
      handle: "Jose-Gael-Cruz-Lopez", name: "Jose", role: "Backend engineer",
      responsibilities: expect.stringMatching(/Sapling API/),
    });
    // Google-only people are listed too (assignment is by handle, not by GitHub login).
    expect(people.map((p) => p.handle)).toEqual(expect.arrayContaining(["meilin", "sanaok"]));
  });

  it("an unset profile reads null (unknown), never a guess — and no avatar or email ever travels", async () => {
    await seedPerson("blank", { avatar_url: "https://a/b.png", email: "blank@example.com" });
    await run(env.DB, `UPDATE persons SET avatar_sha = ? WHERE handle = 'blank'`, "a".repeat(64));
    const { people } = await listPeople();
    expect(people.find((p) => p.handle === "blank")).toEqual({ handle: "blank", name: "blank", role: null, responsibilities: null });
    expect(JSON.stringify(people)).not.toMatch(/avatar|b\.png|example\.com/);
  });

  it("is registered for EVERY principal, read-only — and is the ONLY people tool (no profile write)", async () => {
    const tools = await withClient("agent-owner", async (client) => (await client.listTools()).tools);
    const people = tools.filter((t) => /person|people|profile|avatar|responsibilit/i.test(t.name));
    expect(people.map((t) => t.name)).toEqual(["list_people"]);
    const tool = people[0];
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["repo", "org"]); // no input of its own: only the two every tool takes to say WHICH org (0051)
    expect(tool.inputSchema.required ?? []).toEqual([]);
    expect(tool.description).toMatch(/create_ticket/);
    expect(tool.description).toMatch(/never guess/i);
  });

  it("create_ticket's description points at list_people", async () => {
    const tools = await withClient("agent-owner", async (client) => (await client.listTools()).tools);
    expect(tools.find((t) => t.name === "create_ticket")?.description).toMatch(/list_people/);
  });
});
