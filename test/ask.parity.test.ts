// Ask Trov's tools against the MCP catalog (src/ai/ask/tools.ts; docs/architecture/ask.md › Tools): every MCP tool
// is either wired into Ask or excluded with its reason; a wired tool takes exactly the arguments MCP serves (less
// the connection's own); admin-only tools are offered only to an admin; Fast is offered the index only.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MCP_TOOLS, MCP_TOOL_NAMES } from "@shared/mcp-tools.generated";
import { ASK_EXCLUDED_TOOLS, ASK_ONLY_TOOLS, ASK_MODES } from "@shared/ai-ask-core";
import { ASK_MODES as FROM_AI } from "@shared/ai";
import { ASK_TOOLS, INDEX_TOOLS, askInputSchema, offeredTools } from "../src/ai/ask/tools";
import { WRITES } from "../src/ai/ask/actions";
import { tenantCtx } from "./helpers/tenant";
import { FIXTURE_ADMIN, seedPerson } from "./helpers/persons";

describe("the MCP parity", () => {
  it("every MCP tool is wired into Ask or excluded with a reason — never both, never neither", () => {
    const names = MCP_TOOL_NAMES.map((t) => t.name);
    expect(names.length).toBeGreaterThan(40);
    const neither = names.filter((n) => !(n in ASK_TOOLS) && !(n in ASK_EXCLUDED_TOOLS));
    const both = names.filter((n) => n in ASK_TOOLS && n in ASK_EXCLUDED_TOOLS);
    expect(neither, "an MCP tool is neither wired into Ask nor in ASK_EXCLUDED_TOOLS").toEqual([]);
    expect(both).toEqual([]);
    // The design's exclusions, the one this build adds (a delete is a person's step), and the six agent-link tools
    // until Ask becomes a side (agent links, Phase 4: then only link_inbox stays).
    expect(Object.keys(ASK_EXCLUDED_TOOLS).sort()).toEqual([
      "close_link", "delete_sprint", "get_connection", "join_link", "link_inbox", "list_links", "record_session", "request_link", "send_link_note",
      "switch_org", "upload_asset",
    ]);
    for (const n of Object.keys(ASK_EXCLUDED_TOOLS)) expect(names, n).toContain(n);
    // Ask's own tools are wired and are not MCP tools.
    for (const n of ASK_ONLY_TOOLS) {
      expect(n in ASK_TOOLS, n).toBe(true);
      expect(names).not.toContain(n);
    }
  });

  it("a wired tool's input takes exactly what MCP serves, less `repo`, `org` and `session`", () => {
    for (const t of MCP_TOOLS) {
      if (t.name in ASK_EXCLUDED_TOOLS) continue;
      const served = Object.keys((askInputSchema(t.inputSchema).properties ?? {}) as Record<string, unknown>).sort();
      const input = ASK_TOOLS[t.name].input as z.ZodType;
      const shape = (input as unknown as { shape?: Record<string, unknown> }).shape;
      expect(shape, `${t.name} has an object input`).toBeTruthy();
      expect(Object.keys(shape!).sort(), t.name).toEqual(served);
    }
  });

  it("every write is a card with a kind; every Confirm-only write says why it waits", () => {
    for (const [name, w] of Object.entries(WRITES)) {
      expect(["ticket", "handoff", "doc_edit", "move", "publish", "sprint", "other"], name).toContain(w.card);
      if (w.confirmOnly) expect(w.confirmOnly, name).toMatch(/waits for you, even on Auto\.$/);
    }
    expect(WRITES.update_plan.confirmOnly).toBeTruthy();
    expect(WRITES.publish_doc.confirmOnly).toBe("Publishing waits for you, even on Auto.");
    expect(WRITES.publish_doc.outsideCap).toBe(true);
    // The human-only steps are not tools at all.
    for (const n of ["promote_doc", "reject_doc", "ratify_adr", "publish_prompt", "accept_suggestion", "delete_sprint", "delete_ticket"]) {
      expect(n in ASK_TOOLS && !(n in ASK_EXCLUDED_TOOLS), n).toBe(false);
    }
  });
});

describe("what each person and mode is offered", () => {
  it("admin-only tools exactly as MCP lists them: update_plan for an admin, not for a member", async () => {
    await seedPerson("ask-plain");
    await seedPerson(FIXTURE_ADMIN);
    const member = offeredTools(await tenantCtx("ask-plain"), "smart").map((t) => t.name);
    const admin = offeredTools(await tenantCtx(FIXTURE_ADMIN), "smart").map((t) => t.name);
    const adminOnly = MCP_TOOL_NAMES.filter((t) => t.admin).map((t) => t.name);
    expect(adminOnly).toEqual(["update_plan"]);
    for (const n of adminOnly) {
      expect(member).not.toContain(n);
      expect(admin).toContain(n);
    }
    expect(admin.filter((n) => !member.includes(n))).toEqual(adminOnly);
    // No excluded tool is ever offered; no offered definition names the connection's arguments.
    for (const n of Object.keys(ASK_EXCLUDED_TOOLS)) expect(admin).not.toContain(n);
    for (const t of offeredTools(await tenantCtx(FIXTURE_ADMIN), "smart").filter((x) => MCP_TOOLS.some((m) => m.name === x.name))) {
      expect(Object.keys(((t.input_schema.properties ?? {}) as Record<string, unknown>)), t.name).not.toEqual(expect.arrayContaining(["repo"]));
      expect((t.input_schema as { $schema?: unknown }).$schema).toBeUndefined();
    }
  });

  it("Fast is offered only the index (search and list tools, stored cards); Smart and Thinking the full catalog", async () => {
    const ctx = await tenantCtx("AndresL230");
    const fast = offeredTools(ctx, "fast").map((t) => t.name);
    expect(fast.every((n) => INDEX_TOOLS.has(n))).toBe(true);
    expect(fast).not.toContain("create_ticket");
    expect(fast).not.toContain("save_artifact");
    expect(offeredTools(ctx, "smart").map((t) => t.name)).toEqual(offeredTools(ctx, "thinking").map((t) => t.name));
    expect(offeredTools(ctx, "smart").map((t) => t.name)).toContain("create_ticket");
  });

  it("the modes are ONE table, re-exported from shared/ai.ts: Fast / Smart / Thinking with their models, limits and counts", () => {
    expect(FROM_AI).toBe(ASK_MODES);
    expect(ASK_MODES.map((m) => [m.id, m.model, m.maxCalls, m.countsAs])).toEqual([
      ["fast", "claude-haiku-5-5", 3, 1], ["smart", "claude-sonnet-5-5", 8, 1], ["thinking", "claude-opus-5-5", 8, 5],
    ]);
    expect(ASK_MODES.find((m) => m.id === "thinking")!.hint).toContain("Counts as 5 questions.");
  });
});
