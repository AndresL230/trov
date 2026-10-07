// The Handoffs + Prompt Library MCP tools, driven through the REAL registered
// closures over an in-memory transport (a missing registration fails here).
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { all, first } from "./helpers/db";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import handoffs from "../fixtures/dev/handoffs.json";
import prompts from "../fixtures/dev/prompts.json";
import { bearerCtx } from "./helpers/tenant";

beforeEach(async () => {
  for (const stmt of buildSeedStatements({ handoffs, prompts })) await env.DB.prepare(stmt).run();
});

async function call(handle: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer({ ...(env as unknown as Env), PUBLIC_ORIGIN: "https://trov.example/" } as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content[0].text, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("send_handoff", () => {
  it("creates as the bearer principal and returns { id, url }", async () => {
    const r = await call("Jose-Gael-Cruz-Lopez", "send_handoff", {
      body: "Resume works.\n\nOnly the test left.", recipient: "AndresL230",
      context: { repo: "SaplingLearn/sapling", branch: "feat/x", task: "Finish resume", done: ["a"], next: ["b"], files: ["f.ts"] },
    });
    const out = JSON.parse(r.text) as { id: number; url: string };
    expect(typeof out.id).toBe("number");
    expect(out.url).toBe(`https://trov.example/#handoffs/${out.id}`);
    const row = await first<{ sender: string; recipient: string; context: string }>(env.DB, `SELECT sender, recipient, context FROM handoffs WHERE id = ?`, out.id);
    expect(row!.sender).toBe("Jose-Gael-Cruz-Lopez");
    expect(JSON.parse(row!.context).task).toBe("Finish resume");
  });

  it("the replay ledger dedupes a repeated call with the same session", async () => {
    const args = { body: "Once only", session: "sess-mcp-7" };
    const a = JSON.parse((await call("AndresL230", "send_handoff", args)).text) as { id: number };
    const b = JSON.parse((await call("AndresL230", "send_handoff", args)).text) as { id: number; replayed?: boolean };
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect((await all(env.DB, `SELECT id FROM handoffs WHERE body = 'Once only'`)).length).toBe(1);
    expect((await all(env.DB, `SELECT * FROM feed WHERE summary LIKE '%Once only%'`)).length).toBe(1);
  });

  it("an unknown recipient is an error that writes nothing", async () => {
    const r = await call("AndresL230", "send_handoff", { body: "x", recipient: "ghost" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ code: "bad_request" });
  });
});

describe("list_handoffs / get_handoff", () => {
  it("defaults to pending 'me' + 'anyone'; only 'sent' shows claimed/expired", async () => {
    const def = JSON.parse((await call("AndresL230", "list_handoffs")).text) as { id: number; status: string; task: string; excerpt: string }[];
    expect(def.map((h) => h.id).sort()).toEqual([15, 16, 17]);
    expect(def.every((h) => h.status === "pending")).toBe(true);
    expect(def.find((h) => h.id === 17)!.task).toBe("Get quiz agent validation failures under 1%");
    const sent = JSON.parse((await call("AndresL230", "list_handoffs", { box: "sent" })).text) as { id: number; status: string }[];
    expect(sent.map((h) => h.status).sort()).toEqual(["claimed", "pending"]);
    const got = JSON.parse((await call("AndresL230", "get_handoff", { id: 17 })).text) as { status: string };
    expect(got.status).toBe("pending"); // read-only: not claimed
  });
});

describe("claim_handoff", () => {
  it("returns one markdown block (prompt, summary, context) and claims atomically", async () => {
    const r = await call("AndresL230", "claim_handoff", { id: 17, session: "sess-claim" });
    expect(r.isError).toBeFalsy();
    const promptAt = r.text.indexOf("You're picking up the Gemini quiz-agent hardening");
    const summaryAt = r.text.indexOf("## Handoff summary");
    const contextAt = r.text.indexOf("## Context");
    expect(promptAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(promptAt);
    expect(contextAt).toBeGreaterThan(summaryAt);
    expect(r.text).toContain("- Branch: fix/quiz-agent-json");
    expect((await first<{ claimed_by_session: string }>(env.DB, `SELECT claimed_by_session FROM handoffs WHERE id = 17`))!.claimed_by_session).toBe("sess-claim");

    const again = await call("AndresL230", "claim_handoff", { id: 17, session: "other" });
    expect(again.isError).toBe(true);
    expect(JSON.parse(again.text)).toMatchObject({ error: "handoff is claimed", status: "claimed", claimed_by: "AndresL230" });
  });

  it("expire_handoff flips a pending one the principal sent", async () => {
    const r = JSON.parse((await call("AndresL230", "expire_handoff", { id: 13 })).text) as { status: string };
    expect(r.status).toBe("expired");
  });
});

describe("prompt tools", () => {
  it("search_prompts is FTS + tags", async () => {
    const r = JSON.parse((await call("AndresL230", "search_prompts", { q: "heartbeat" })).text) as { slug: string }[];
    expect(r.map((p) => p.slug)).toEqual(["sse-endpoint-review"]);
  });

  it("get_prompt fills vars and lists the unfilled ones", async () => {
    const r = JSON.parse((await call("AndresL230", "get_prompt", { slug: "sse-endpoint-review", vars: { endpoint: "/stream" } })).text) as { body: string; variables: string[]; unfilled: string[] };
    expect(r.body).toContain("`/stream`");
    expect(r.variables).toEqual(["endpoint", "router_file", "client_file"]);
    expect(r.unfilled).toEqual(["router_file", "client_file"]);
  });

  it("save_prompt is forced to staged, even over a published prompt, and cannot publish", async () => {
    const r = JSON.parse((await call("Darkest-Teddy", "save_prompt", { slug: "adr-draft", title: "Draft an ADR", body: "New body {{x}}", branch: "feat/adr" })).text) as { slug: string; version: number; status: string };
    expect(r).toEqual({ slug: "adr-draft", version: 3, status: "staged" });
    const v = await first<{ status: string; summary: string; author: string }>(env.DB, `SELECT status, summary, author FROM prompt_versions WHERE slug = 'adr-draft' AND version = 3`);
    expect(v).toEqual({ status: "staged", summary: "Staged by a session on feat/adr", author: "Darkest-Teddy" });
    const fresh = JSON.parse((await call("AndresL230", "save_prompt", { slug: "brand-new", title: "Brand new", body: "b" })).text) as { version: number; status: string };
    expect(fresh).toEqual({ slug: "brand-new", version: 1, status: "staged" });
  });

  it("save_prompt without `tags` keeps the prompt's tags; with them, replaces them (lowercased, deduped)", async () => {
    // adr-draft is seeded with ["architecture"]; a new version that omits tags must not wipe them.
    await call("Darkest-Teddy", "save_prompt", { slug: "adr-draft", title: "Draft an ADR", body: "v3 body" });
    const kept = await first<{ tags: string }>(env.DB, `SELECT tags FROM prompts WHERE slug = 'adr-draft'`);
    expect(JSON.parse(kept!.tags)).toEqual(["architecture"]);
    await call("Darkest-Teddy", "save_prompt", { slug: "adr-draft", title: "Draft an ADR", body: "v4 body", tags: ["API", "api", "Infra"] });
    const replaced = await first<{ tags: string }>(env.DB, `SELECT tags FROM prompts WHERE slug = 'adr-draft'`);
    expect(JSON.parse(replaced!.tags)).toEqual(["api", "infra"]);
  });
});
