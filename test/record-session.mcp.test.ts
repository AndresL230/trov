import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Principal } from "../src/auth/principal";
import { all } from "./helpers/db";
import type { FeedRow, DocVersionRow, AdrRow } from "@shared/rows";
import type { IngestResult } from "../src/consumer";
import { seedPerson } from "./helpers/persons";
import { bearerCtx, credentialOf, mintTokenFor } from "./helpers/tenant";

type Env = import("../src/env").Env;

// Seed a member and mint a REAL bearer token for them (hash stored, raw returned once).
async function seedUserWithBearer(login: string): Promise<string> {
  await seedPerson(login);
  const { raw } = await mintTokenFor(login);
  return raw;
}

// Resolve the principal the SAME way index.ts does for /mcp: a bearer token in the
// Authorization header, NO cookie, through the real bearer resolver. The
// principal handed to the server is the resolver's output, never a hand-written literal.
async function bearerPrincipal(rawToken: string): Promise<Principal> {
  const req = new Request("https://trov.example/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${rawToken}` },
  });
  const principal = await credentialOf(req);
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
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(principal.handle));
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
      { summary: "shipped record_session", brief: "Agents can now record a whole session in one step.", body: "the agent path", tags: ["infra"], artifacts: { prs: ["99"], commits: ["deadbeef"], issues: [7] } },
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
    expect(principal).toMatchObject({ handle: "bearer-agent" });

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
    expect(feed[0].brief).toBe("Agents can now record a whole session in one step.");

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

  it("the retired write tools stay retired: no proposal or sprint writer in tools/list, and calling one errors", async () => {
    const raw = await seedUserWithBearer("bearer-agent-narrow");
    const principal = await bearerPrincipal(raw);

    const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(principal.handle));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // propose_doc_update is the ONLY agent proposal tool left: the roadmap one
      // went with its queue (0025), and focus was retired back in 0014.
      expect(names.filter((n) => n.startsWith("propose_"))).toEqual(["propose_doc_update"]);
      expect(names).not.toContain("set_focus");
      // Sprints are authored, never proposed — no staged sprint writer exists.
      for (const banned of ["propose_sprint", "promote_sprint"]) {
        expect(names).not.toContain(banned);
      }

      // An unregistered tool name resolves with isError (SDK -32602 "Tool not found"),
      // rather than rejecting the call promise — assert on that, not a rejection.
      const proposeSprintRes = (await client.callTool({
        name: "propose_sprint",
        arguments: {
          label: "Should not register",
          due: "2026-09-01",
          status: "upcoming",
          change_summary: "narrowing test",
          confidence: "high",
        },
      })) as { isError?: boolean };
      expect(proposeSprintRes.isError).toBe(true);

      const setFocusRes = (await client.callTool({
        name: "set_focus",
        arguments: { working_on: "narrowing test" },
      })) as { isError?: boolean };
      expect(setFocusRes.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
