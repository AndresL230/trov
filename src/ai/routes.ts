// Org settings › AI and the answers to what Trov wrote (docs/architecture/ai.md, organizations.md): tenant
// routes under `/api/o/:slug` (`AI_ROUTES`, shared/ai-core.ts), COOKIE ONLY — a request carrying an
// Authorization header is refused (`cookieOnly`), and none of this is an MCP tool. `tenantGate` (mounted on
// /api/o/:slug/* in src/routes.ts) has already resolved `c.var.ctx`; there is no old-path alias.
//
//   GET  /ai/settings                  any member — `AiSettings`; a failed read is 503 `{ error }`, never a 500
//   PUT  /ai/settings { enabled?, chatAuto? }  admin+ — the AI switch (`orgs.ai_automation`, audited `org.ai`)
//                                      and/or Ask Trov's Auto switch (`orgs.ai_chat_auto`, audited
//                                      `org.ai_chat_auto`); → `AiSettings`
//   POST /ai/suggestions/:id/accept    the kind's handler's role (./suggestions.ts) — writes AS the caller
//   POST /ai/suggestions/:id/dismiss   any member
//   POST /ai/feedback                  any member — "Wrong?": hides the item for the caller, idempotent
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import type { AppEnv } from "../auth/principal";
import {
  AI_ALLOWANCE_KEYS, AI_NEVER_SENT, AI_ROUTES, AI_SENDS, AiAcceptBodySchema, AiFeedbackBodySchema, AiSettingsPutSchema, type AiSettings,
} from "@shared/ai";
import { hasRole, type TenantContext } from "../data/context";
import { recordFeedback, setAiAutomation, setAiChatAuto } from "../data/ai";
import { cookieOnly } from "../orgs/routes";
import { planAndAiSettings } from "../plans/gate";
import { allowanceUse, eligibilityOf } from "./eligibility";
import { aiPreview, aiPreviewMode } from "./preview";
import {
  ASK_SCENARIOS, ASK_SCENARIO_QUESTION, askRefFixtures, askSearchFixture, askSettingsFixture, askStateFixture, askThreadsFixture, askTranscript,
  isAskScenario,
} from "@shared/ai-fixtures";
import { acceptSuggestion, dismissSuggestion, type SuggestionAnswer } from "./suggestions";

/** What Org settings › AI shows, from ONE statement: both switches, the eligibility, this month's use of all
 *  four AI allowances, and what is sent to whom. Any member reads it; `canEdit` says whether the switches
 *  are theirs. Nothing here calls a model. */
export async function aiSettings(env: Pick<Env, "ANTHROPIC_API_KEY">, ctx: TenantContext, now: Date = new Date()): Promise<AiSettings> {
  const a = await planAndAiSettings(ctx, now);
  return {
    enabled: a.enabled,
    canEdit: hasRole(ctx, "admin"),
    eligibility: eligibilityOf(env, a.enabled, a.plan, a.used.ai_runs),
    allowances: Object.fromEntries(AI_ALLOWANCE_KEYS.map((k) => [k, allowanceUse(a.plan, k, a.used[k], now)])) as AiSettings["allowances"],
    chatAuto: a.chatAuto,
    sends: [...AI_SENDS],
    neverSent: AI_NEVER_SENT,
  };
}

export const aiApp = new Hono<AppEnv>();
aiApp.use("/ai/*", cookieOnly);

const settingsOr503 = async (c: Context<AppEnv>) => {
  try {
    const s = await aiSettings(c.env, c.var.ctx);
    // LOCAL DEVELOPMENT ONLY (./preview.ts): the sample numbers over the real switches.
    const preview = aiPreview(c.env, c.req.url);
    return c.json(preview ? { ...s, ...preview.settings } : s);
  } catch (e) {
    console.error("ai settings", e instanceof Error ? e.name : "error");
    return c.json({ error: "Couldn't read the AI settings" }, 503);
  }
};

aiApp.get(AI_ROUTES.settings, settingsOr503);

aiApp.put(AI_ROUTES.settings, async (c) => {
  if (!hasRole(c.var.ctx, "admin")) return c.json({ error: "forbidden" }, 403);
  const parsed = AiSettingsPutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", message: "Send { enabled: true | false }, { chatAuto: true | false }, or both." }, 400);
  if (parsed.data.enabled !== undefined) await setAiAutomation(c.var.ctx, parsed.data.enabled);
  if (parsed.data.chatAuto !== undefined) await setAiChatAuto(c.var.ctx, parsed.data.chatAuto);
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
  // An empty or unreadable body is `{}`; one the contract refuses is answered only after the id is found.
  const parsed = AiAcceptBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  return answer(c, await acceptSuggestion(c.var.ctx, id, parsed.success ? parsed.data : null));
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

// ── Ask Trov's replay (LOCAL DEVELOPMENT ONLY; docs/architecture/ask.md › Fixtures) ──────────────────────────────
// Under `wrangler dev` with LOCAL_AI_PREVIEW set (the same guard as every preview: a loopback http origin, no live
// Stripe key — ./preview.ts), the Ask frontend can be built and screenshotted without a key:
//   GET /ai/ask-replay                 the scenarios, and the fixtures the screens read beside the stream
//   GET /ai/ask-replay/:scenario       that scenario's recorded SSE transcript, streamed at real pacing
//                                      (`?speed=4` plays it four times as fast; `?speed=0` all at once)
// Anywhere else both are 404, as if they did not exist. It lives here, not in src/ai/ask/, because the preview's
// guard reads the billing config — and nothing under src/ai/ask/ imports src/billing/.
aiApp.get("/ai/ask-replay", (c) => {
  if (!aiPreviewMode(c.env, c.req.url)) return c.json({ error: "not_found" }, 404);
  const now = new Date();
  return c.json({
    scenarios: ASK_SCENARIOS, questions: ASK_SCENARIO_QUESTION,
    state: { pro: askStateFixture("pro", now), free: askStateFixture("free", now) },
    settings: { pro: askSettingsFixture("pro"), free: askSettingsFixture("free") },
    threads: askThreadsFixture(now), search: { q: "netlify", hits: askSearchFixture(now) }, refs: askRefFixtures(now),
  });
});

aiApp.get("/ai/ask-replay/:scenario", (c) => {
  const scenario = c.req.param("scenario");
  if (!aiPreviewMode(c.env, c.req.url) || !isAskScenario(scenario)) return c.json({ error: "not_found" }, 404);
  const speed = Math.min(50, Math.max(0, Number(c.req.query("speed") ?? "1") || 0));
  const steps = askTranscript(scenario, new Date());
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const play = (async () => {
    try {
      for (const s of steps) {
        if (speed > 0 && s.delayMs > 0) await new Promise((r) => setTimeout(r, s.delayMs / speed));
        await writer.write(enc.encode(`event: ${s.event.event}\ndata: ${JSON.stringify(s.event.data)}\n\n`));
      }
    } catch {
      // the client went away
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();
  try { c.executionCtx.waitUntil(play); } catch { /* no ExecutionContext (a test): the stream drives it */ }
  return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
});
