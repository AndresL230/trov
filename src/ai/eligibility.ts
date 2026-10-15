// May Trov make a model call for this org NOW? (docs/architecture/ai.md › Eligibility.) The one answer the
// AI pass (./pass.ts) asks before every org and Org settings › AI shows (./routes.ts):
//   • `no_key` — the deployment has no `ANTHROPIC_API_KEY`: nothing runs anywhere;
//   • `off`    — the org's admin switched it off (`orgs.ai_automation = 0`, 0055_ai);
//   • `capped` — the org has used its month's `ai_runs` (shared/plans.ts), or its plan has ended;
//   • `ok`.
// The plan, the switch and the month's `ai_run:*` count are read in ONE statement (`planAndAiRuns`, as
// `planAndSummaries` reads the summaries' allowance). Nothing here calls a model, and nothing reachable
// from src/mcp.ts imports it.
import type { Env } from "../env";
import { nextMonthStart, type AiEligibility } from "@shared/ai";
import { planRefusal, resolveEntitlements } from "@shared/plans";
import type { TenantContext } from "../data/context";
import { planAndAiRuns } from "../plans/gate";
import type { OrgPlan } from "../plans/state";

export interface AiAllowance {
  eligibility: AiEligibility;
  /** `orgs.ai_automation`. */
  enabled: boolean;
  /** `ai_run:*` this calendar month (UTC). */
  used: number;
  /** The plan's `ai_runs` in force; null = unlimited. */
  cap: number | null;
  /** The first day of next month — set only when the ALLOWANCE is what stops it (not an ended plan, which
   *  resumes when it is renewed, not on a date). */
  resumesOn: string | null;
  plan: OrgPlan;
}

/** The whole answer, for the settings read and the pass. ONE statement; a failed read THROWS (the settings
 *  route degrades to 503; `aiEligibility` reads it as `off`). The key is checked first, but the read is made
 *  either way: the settings screen shows the switch and the month's use with or without a key. */
export async function aiAllowance(ctx: TenantContext, env: Pick<Env, "ANTHROPIC_API_KEY">, now: Date = new Date()): Promise<AiAllowance> {
  const { plan, enabled, used } = await planAndAiRuns(ctx, now);
  const cap = resolveEntitlements(plan.plan, plan.overrides).ai_runs;
  // The one question (shared/plans.ts): may this org add one more of `ai_runs`?
  const refusal = planRefusal(plan, "ai_runs", used, 1);
  const spent = !!refusal && plan.status !== "canceled";
  const eligibility: AiEligibility = !env.ANTHROPIC_API_KEY ? "no_key" : !enabled ? "off" : refusal ? "capped" : "ok";
  return { eligibility, enabled, used, cap, resumesOn: spent ? nextMonthStart(now) : null, plan };
}

/** `ok` | `off` | `no_key` | `capped`. Never throws: with no key nothing is read; a failed read is `off`. */
export async function aiEligibility(ctx: TenantContext, env: Pick<Env, "ANTHROPIC_API_KEY">, now: Date = new Date()): Promise<AiEligibility> {
  if (!env.ANTHROPIC_API_KEY) return "no_key";
  try {
    return (await aiAllowance(ctx, env, now)).eligibility;
  } catch (e) {
    console.error("ai eligibility: read failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    return "off";
  }
}
