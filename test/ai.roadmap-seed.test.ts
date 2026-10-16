// The Roadmap's sample content (Phase D, the owner's request): the LOCAL dev seed's rows (scripts/seed/ai-roadmap-dev.mjs
// over fixtures/dev/ai-roadmap.json) light up the Roadmap and Review through the REAL reads, and `LOCAL_AI_PREVIEW`
// fills `/roadmap` under `wrangler dev` only — an admin's suggestions included, never over MCP.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { get_plan, type PlanView } from "../src/tools/plan";
import { list_proposals } from "../src/tools/reads";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { aiRoadmapDevStatements } from "../scripts/seed/ai-roadmap-dev.mjs";
import { AI_PREVIEW_MODES, roadmapFixture } from "@shared/ai-fixtures";
import { AiPlanDriftSchema, AiRoadmapLineSchema, AiSuggestionSchema, AiSprintDraftValueSchema, AiPlanNarrativeValueSchema } from "@shared/ai";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { systemCtx } from "./helpers/tenant";
import docs from "../fixtures/dev/docs.json";
import feed from "../fixtures/dev/feed.json";
import adrs from "../fixtures/dev/adrs.json";
import triage from "../fixtures/dev/triage.json";
import roadmap from "../fixtures/dev/roadmap.json";
import events from "../fixtures/dev/events.json";
import identity from "../fixtures/dev/identity.json";
import tickets from "../fixtures/dev/tickets.json";
import aiRoadmap from "../fixtures/dev/ai-roadmap.json";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

const LOCAL = "http://localhost:8787";
const DEPLOYED = "https://trov.dev";
const withVars = (over: Partial<Env>): Env => ({ ...(env as unknown as Env), ...over });
async function roadmapFor(origin: string, handle: string, e: Env): Promise<PlanView> {
  const res = await app.request(`${origin}/api/o/saplinglearn/roadmap`, { headers: { cookie: await cookieFor(handle) } }, e);
  expect(res.status).toBe(200);
  return (await res.json()) as PlanView;
}

describe("the dev seed's Roadmap and doc-drift rows", () => {
  it("notes on the active sprints, the drift line, an admin's two suggestion cards, and Trov's low-confidence proposal in Review", async () => {
    const fx = { docs, feed, adrs, triage, roadmap, events, identity, tickets, aiRoadmap };
    for (const s of [...buildSeedStatements(fx), ...aiRoadmapDevStatements(fx)]) await env.DB.prepare(s).run();
    const plan = await get_plan(systemCtx());
    expect(plan.sprints.filter((s) => s.note).map((s) => s.id)).toEqual([3, 4]);
    expect(plan.drift?.shares.map((s) => s.pct)).toEqual([48, 29, 23]);
    const admin = await roadmapFor(LOCAL, FIXTURE_ADMIN, env as unknown as Env);
    expect(admin.suggestions?.map((s) => s.kind).sort()).toEqual(["plan_narrative", "sprint_draft"]);
    expect(admin.suggestions?.find((s) => s.kind === "sprint_draft")?.label).toBe("2 sprints from 4 backlog tickets");
    expect((await roadmapFor(LOCAL, "seed-member", env as unknown as Env)).suggestions).toBeUndefined();
    const proposals = await list_proposals(systemCtx());
    const trov = proposals.find((p) => p.slug === "sapling-infrastructure");
    expect(trov).toMatchObject({ low_confidence: 1, author: "trov", confidence: "low" });
    expect(trov?.stagedBody).toContain("(`0001`–`0030`)");
  });
});

describe("LOCAL_AI_PREVIEW on /roadmap", () => {
  it("the fixtures are valid against the contracts in every mode (`empty` is nothing written)", () => {
    for (const mode of AI_PREVIEW_MODES) {
      const f = roadmapFixture(mode === "proposed" ? "ready" : mode, new Date("2026-10-14T12:00:00Z"));
      if (mode === "empty") { expect(f).toBeNull(); continue; }
      for (const n of f!.notes) AiRoadmapLineSchema.parse(n);
      AiPlanDriftSchema.parse(f!.drift);
      for (const s of f!.suggestions) {
        AiSuggestionSchema.parse(s);
        (s.kind === "sprint_draft" ? AiSprintDraftValueSchema : AiPlanNarrativeValueSchema).parse(s.value);
      }
    }
  });

  it("under `wrangler dev` an admin gets notes, the drift and the cards; a member no cards; a deployed origin nothing", async () => {
    const ctx = systemCtx();
    await env.DB.prepare(`INSERT INTO sprints (org_id, title, target_date, status, created_at, created_by) VALUES (?, 'Hosting', '', 'in_progress', '2026-10-01T00:00:00Z', 'AndresL230')`).bind(ctx.orgId).run();
    const e = withVars({ LOCAL_AI_PREVIEW: "ready" });
    const admin = await roadmapFor(LOCAL, FIXTURE_ADMIN, e);
    expect(admin.sprints[0].note?.text).toBeTruthy();
    expect(admin.drift?.windowDays).toBe(14);
    expect(admin.suggestions).toHaveLength(2);
    const member = await roadmapFor(LOCAL, "preview-member", e);
    expect(member.drift).toBeDefined();
    expect(member.suggestions).toBeUndefined();
    const deployed = await roadmapFor(DEPLOYED, FIXTURE_ADMIN, e);
    expect([deployed.drift, deployed.suggestions, deployed.sprints[0].note]).toEqual([undefined, undefined, undefined]);
    const empty = await roadmapFor(LOCAL, FIXTURE_ADMIN, withVars({ LOCAL_AI_PREVIEW: "empty" }));
    expect([empty.drift, empty.suggestions, empty.sprints[0].note]).toEqual([undefined, undefined, undefined]);
  });
});
