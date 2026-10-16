// Accepting the Roadmap's two suggestions (docs/architecture/ai.md › Suggestions; roadmap-my-work.md › Roadmap
// intelligence). An ADMIN's decision over the cookie route (`POST /ai/suggestions/:id/accept`, ./routes.ts) —
// never MCP, never the pass. Accepting runs the EXISTING writers AS THAT ADMIN (`ctx` is the signed-in person's
// own context; the author is always the authenticated principal):
//
//   sprint_draft    `create_sprint` for each proposed sprint (created UPCOMING, like the New sprint panel — an
//                   admin starts one when they choose), then `set_ticket_sprint` for its tickets. A ticket that is
//                   no longer open in the backlog (closed, deleted, or put in a sprint since) is left where it is —
//                   never moved out of another sprint. Nothing is marked done or started.
//   plan_narrative  `write_plan` with the narrative and no sprint entries (sprints not listed are untouched), so
//                   it is versioned like any plan write; over `PLAN_NARRATIVE_MAX` it refuses and writes nothing.
//
// The value is the suggested one, or the admin's edited one (`{ value }` on the accept), checked here against the
// contract. A refusal throws: the suggestion goes back to open (src/ai/suggestions.ts).
import { AiPlanNarrativeValueSchema, AiSprintDraftValueSchema } from "@shared/ai";
import { all, ph, type TenantContext } from "../data/sql";
import { create_sprint, SprintError } from "../tools/sprints";
import { set_ticket_sprint } from "../tools/tickets";
import { write_plan } from "../tools/plan";
import type { AcceptHandler } from "./suggestions";

export const SPRINT_DRAFT_ACCEPT: AcceptHandler = {
  role: "admin",
  async apply(ctx: TenantContext, _row, value) {
    const parsed = AiSprintDraftValueSchema.safeParse(value);
    if (!parsed.success) throw new SprintError("bad_request", "that sprint draft is not one Trov can create");
    const numbers = [...new Set(parsed.data.sprints.flatMap((s) => s.tickets))];
    const open = new Set((await all<{ number: number }>(ctx,
      `SELECT number FROM tickets WHERE org_id = ? AND sprint_id IS NULL AND status IN ('submitted', 'in_progress', 'testing') AND number IN (${ph(numbers.length)})`,
      ctx.orgId, ...numbers)).map((r) => r.number));
    const placed = new Set<number>();
    for (const sp of parsed.data.sprints) {
      const sprint = await create_sprint(ctx, { label: sp.name, summary: sp.goal || null, urgency: "normal" }, ctx.userId);
      for (const n of sp.tickets) {
        if (!open.has(n) || placed.has(n)) continue;
        await set_ticket_sprint(ctx, n, sprint.id);
        placed.add(n);
      }
    }
  },
};

export const PLAN_NARRATIVE_ACCEPT: AcceptHandler = {
  role: "admin",
  async apply(ctx: TenantContext, _row, value) {
    const parsed = AiPlanNarrativeValueSchema.safeParse(value);
    if (!parsed.success) throw new SprintError("bad_request", "that narrative is empty");
    await write_plan(ctx, { narrative: parsed.data.narrative, sprints: [] }, ctx.userId);
  },
};
