import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import { all, first } from "./helpers/db";
import type { SprintRow, PlanRow, PlanVersionRow } from "@shared/rows";
import { PLAN_NARRATIVE_MAX } from "@shared/sprints";
import { bearerCtx } from "./helpers/tenant";
import { narr, narrText } from "./helpers/plan";

// update_plan registers for an org ADMIN (§7.2): the client below binds this handle as one.
const AUTHOR = "admin-user";

// Drive the ACTUAL registered MCP `update_plan` tool through an in-memory MCP
// client/server pair — the same closure production runs (mirrors
// test/mcp.append_feed.test.ts's callTool helper).
async function withClient<T>(login: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = buildTrovMcpServer(env as unknown as import("../src/env").Env, await bearerCtx(login, login === AUTHOR ? "admin" : undefined));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callTool(login: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  return withClient(login, async (client) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  });
}

describe("registered MCP update_plan tool", () => {
  it("writes as the bearer principal — author stamped from the principal, never the payload", async () => {
    const res = await callTool(AUTHOR, "update_plan", {
      ...narr("shipped via MCP"),
      sprints: [{ label: "MCP Sprint", summary: "via the tool", due: "2026-08-01", status: "upcoming", urgency: "high", domain: "tickets" }],
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.text);
    expect(body.version).toBe(1);
    expect(body.sprints).toHaveLength(1);

    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan?.updated_by).toBe(AUTHOR);
    expect(plan?.narrative).toBe(narrText("shipped via MCP"));

    const sprints = await all<SprintRow>(env.DB, `SELECT * FROM sprints`);
    expect(sprints).toHaveLength(1);
    expect(sprints[0].created_by).toBe(AUTHOR);
    // The tool takes the DTO vocabulary; the row keeps the column names.
    expect(sprints[0].title).toBe("MCP Sprint");
    expect(sprints[0].target_date).toBe("2026-08-01");
    expect(sprints[0].summary).toBe("via the tool");
    expect(sprints[0].urgency).toBe("high");
    expect(sprints[0].domain).toBe("tickets");
  });

  it("sprints default to [] when omitted", async () => {
    const res = await callTool(AUTHOR, "update_plan", { ...narr("narrative only") });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.text);
    expect(body.version).toBe(1);
    expect(body.sprints).toEqual([]);
  });

  it("rejects the pre-rename vocabulary: `title`/`target_date` on a sprint is a validation error", async () => {
    const res = await callTool(AUTHOR, "update_plan", {
      ...narr("n"),
      sprints: [{ title: "Old words", target_date: "2026-08-01", status: "upcoming" }],
    });
    expect(res.isError).toBeTruthy();
    expect(await all<SprintRow>(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
  });
});

describe("registered MCP update_plan tool — the narrative cap", () => {
  // The cap counts the composed text (34 characters of labels and breaks, then the three parts).
  const atCap = (extra = 0) => narr("x".repeat(PLAN_NARRATIVE_MAX - narrText("", "", "").length - "Next.".length - "Later.".length + extra));

  it("a narrative of exactly the cap writes", async () => {
    const res = await callTool(AUTHOR, "update_plan", { ...atCap() });
    expect(res.isError).toBeFalsy();
    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan?.narrative.length).toBe(PLAN_NARRATIVE_MAX);
  });

  it("one over the cap is refused naming the cap and the length, and nothing is written", async () => {
    const res = await callTool(AUTHOR, "update_plan", {
      ...atCap(1),
      sprints: [{ label: "Should not land", due: "2026-08-01", status: "upcoming" }],
    });
    expect(res.isError).toBeTruthy();
    expect(res.text).toContain(`${PLAN_NARRATIVE_MAX + 1} characters`);
    expect(res.text).toContain(`the cap is ${PLAN_NARRATIVE_MAX}`);

    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan?.narrative).toBe("");
    expect(plan?.current_version).toBe(0);
    expect(await all<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions`)).toHaveLength(0);
    expect(await all<SprintRow>(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
  });

  it("the tool's description states the cap and the three parts up front", async () => {
    const { tools } = await withClient(AUTHOR, (client) => client.listTools());
    const tool = tools.find((t) => t.name === "update_plan")!;
    expect(tool.description).toContain(`${PLAN_NARRATIVE_MAX} characters`);
    expect(tool.description).toContain("THREE parts");
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    for (const k of ["now", "next", "later"]) expect(props[k].description, k).toContain("One short paragraph");
    expect(props.narrative.description).toContain("DEPRECATED");
  });
});

describe("registered MCP update_plan tool — Now / Next / Later (both input forms)", () => {
  const stored = async () => (await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`))?.narrative;

  it("now / next / later: the server composes and stores the ONE form", async () => {
    const res = await callTool(AUTHOR, "update_plan", { now: "Hosting.", next: "Billing.", later: "Docs." });
    expect(res.isError).toBeFalsy();
    expect(await stored()).toBe("**Now:** Hosting.\n\n**Next:** Billing.\n\n**Later:** Docs.");
  });

  it("an older plugin's `narrative` is taken only when it reads Now / Next / Later", async () => {
    const ok = await callTool(AUTHOR, "update_plan", { narrative: "**Now:** hosting. **Next:** billing. **Later:** docs." });
    expect(ok.isError).toBeFalsy();
    expect(await stored()).toBe("**Now:** hosting.\n\n**Next:** billing.\n\n**Later:** docs.");
  });

  it("a free-text `narrative` is refused with what to send instead, and nothing is written", async () => {
    const res = await callTool(AUTHOR, "update_plan", {
      narrative: "We are shipping hosting this week.",
      sprints: [{ label: "Should not land", due: "2026-08-01", status: "upcoming" }],
    });
    expect(res.isError).toBeTruthy();
    expect(JSON.parse(res.text)).toMatchObject({ code: "bad_request" });
    expect(res.text).toContain("pass `now`, `next` and `later`");
    expect(await stored()).toBe("");
    expect(await all<SprintRow>(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
  });

  it("a missing part is refused, naming it", async () => {
    const res = await callTool(AUTHOR, "update_plan", { now: "Hosting.", next: "Billing." });
    expect(res.isError).toBeTruthy();
    expect(res.text).toContain("later is empty");
    expect(await stored()).toBe("");
  });
});

describe("update_plan is admin-only — non-admin principals don't even get the tool", () => {
  it("a non-admin's tools/list omits update_plan but still includes get_roadmap", async () => {
    const { tools } = await withClient("agent", (client) => client.listTools());
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("update_plan");
    expect(names).toContain("get_roadmap");
  });

  it("an admin's tools/list includes update_plan", async () => {
    const { tools } = await withClient(AUTHOR, (client) => client.listTools());
    const names = tools.map((t) => t.name);
    expect(names).toContain("update_plan");
  });

  it("a non-admin calling update_plan gets a tool-not-found MCP error", async () => {
    const res = await callTool("agent", "update_plan", { narrative: "should not land" });
    expect(res.isError).toBeTruthy();
    expect(res.text.toLowerCase()).toContain("not found");

    // Nothing was written — the seeded plan row is untouched.
    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan?.narrative).not.toBe("should not land");
  });
});
