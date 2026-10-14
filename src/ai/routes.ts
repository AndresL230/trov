// Org settings › AI and the answers to what Trov wrote (docs/architecture/ai.md, organizations.md): tenant
// routes under `/api/o/:slug` (`AI_ROUTES`, shared/ai-core.ts), COOKIE ONLY — a request carrying an
// Authorization header is refused (`cookieOnly`), and none of this is an MCP tool. `tenantGate` (mounted on
// /api/o/:slug/* in src/routes.ts) has already resolved `c.var.ctx`; there is no old-path alias.
//
//   GET  /ai/settings                  any member — `AiSettings`; a failed read is 503 `{ error }`, never a 500
//   PUT  /ai/settings { enabled }      admin+ — the switch (`orgs.ai_automation`), audited; → `AiSettings`
//   POST /ai/suggestions/:id/accept    the kind's handler's role (./suggestions.ts) — writes AS the caller
//   POST /ai/suggestions/:id/dismiss   any member
//   POST /ai/feedback                  any member — "Wrong?": hides the item for the caller, idempotent
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import type { AppEnv } from "../auth/principal";
import {
  AI_NEVER_SENT, AI_ROUTES, AI_SENDS, AiAcceptBodySchema, AiFeedbackBodySchema, AiSettingsPutSchema, type AiSettings,
} from "@shared/ai";
import { hasRole, type TenantContext } from "../data/context";
import { recordFeedback, setAiAutomation } from "../data/ai";
import { cookieOnly } from "../orgs/routes";
import { aiAllowance } from "./eligibility";
import { acceptSuggestion, dismissSuggestion, type SuggestionAnswer } from "./suggestions";

/** What Org settings › AI shows. Any member reads it; `canEdit` says whether the switch is theirs. */
export async function aiSettings(env: Pick<Env, "ANTHROPIC_API_KEY">, ctx: TenantContext, now: Date = new Date()): Promise<AiSettings> {
  const a = await aiAllowance(ctx, env, now);
  return {
    enabled: a.enabled,
    canEdit: hasRole(ctx, "admin"),
    eligibility: a.eligibility,
    runs: { used: a.used, cap: a.cap, resumesOn: a.resumesOn },
    sends: [...AI_SENDS],
    neverSent: AI_NEVER_SENT,
  };
}

export const aiApp = new Hono<AppEnv>();
aiApp.use("/ai/*", cookieOnly);

const settingsOr503 = async (c: Context<AppEnv>) => {
  try {
    return c.json(await aiSettings(c.env, c.var.ctx));
  } catch (e) {
    console.error("ai settings", e instanceof Error ? e.name : "error");
    return c.json({ error: "Couldn't read the AI settings" }, 503);
  }
};

aiApp.get(AI_ROUTES.settings, settingsOr503);

aiApp.put(AI_ROUTES.settings, async (c) => {
  if (!hasRole(c.var.ctx, "admin")) return c.json({ error: "forbidden" }, 403);
  const parsed = AiSettingsPutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", message: "Send { enabled: true | false }." }, 400);
  await setAiAutomation(c.var.ctx, parsed.data.enabled);
  return settingsOr503(c);
});

/** A suggestion's id from the path: a positive integer, else nothing to find. */
const suggestionId = (c: Context<AppEnv>): number | null => {
  const raw = c.req.param("id") ?? "";
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
};
const answer = (c: Context<AppEnv>, a: SuggestionAnswer) => (a.ok ? c.json({ ok: true, suggestion: a.suggestion }) : c.json({ error: a.error }, a.status));

aiApp.post("/ai/suggestions/:id/accept", async (c) => {
  const id = suggestionId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  const parsed = AiAcceptBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  return answer(c, await acceptSuggestion(c.var.ctx, id, parsed.data));
});

aiApp.post("/ai/suggestions/:id/dismiss", async (c) => {
  const id = suggestionId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  return answer(c, await dismissSuggestion(c.var.ctx, id));
});

aiApp.post(AI_ROUTES.feedback, async (c) => {
  const parsed = AiFeedbackBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  await recordFeedback(c.var.ctx, c.var.ctx.userId, parsed.data);
  return c.json({ ok: true });
});
