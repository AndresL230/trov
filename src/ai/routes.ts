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
//   POST /ai/feedback                  any member — "Wrong?": hides the item for the caller, idempotent; an
//                                      omitted `model` / `promptVersion` is null. A failed write (here and
//                                      on PUT /ai/settings) is 503 `{ error }`, never a 500
//   POST /ai/filter { screen, text }   any member — the plain-language filter (#162, ./filter.ts): the screen's
//                                      own filter fields, checked against the org's rows; never results
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import type { AppEnv } from "../auth/principal";
import {
  AI_ALLOWANCE_KEYS, AI_NEVER_SENT, AI_ROUTES, AI_SENDS, AiAcceptBodySchema, AiFeedbackBodySchema, AiSettingsPutSchema, type AiSettings,
} from "@shared/ai";
import { hasRole, platform, type TenantContext } from "../data/context";
import { recordFeedback, setAiAutomation, setAiChatAuto } from "../data/ai";
import { cookieOnly } from "../orgs/routes";
import { aiShown, planAndAiSettings } from "../plans/gate";
import { aiAllowance, allowanceUse, eligibilityOf } from "./eligibility";
import { aiPreview, aiPreviewMode } from "./preview";
import {
  ASK_SCENARIOS, ASK_SCENARIO_QUESTION, askRefFixtures, askSearchFixture, askSettingsFixture, askStateFixture, askThreadsFixture, askTranscript,
  isAskScenario,
} from "@shared/ai-fixtures";
import { acceptSuggestion, dismissSuggestion, type SuggestionAnswer } from "./suggestions";
import { isPreviewSuggestionId } from "@shared/ai-fixtures";
import { AI_FILTER_MESSAGES, AI_FILTER_ROUTE, AiFilterBodySchema, aiFilterUnreadable, type AiFilterAnswer, type AiFilterErrorCode, type AiFilterScreen } from "@shared/ai-filter";
import { planDef, planRefusal, resolveEntitlements, type PlanRefusal } from "@shared/plans";
import { PLAN_LIMIT_STATUS } from "../plans/state";
import { aiRunCappedMetric, meterBy } from "../data/meter";
import { rateLimited } from "../platform/limits";
import { AI_FILTER_ACTOR, isEmptyFilter, previewAiFilter, runAiFilter } from "./filter";

/** What Org settings › AI shows, from ONE statement: both switches, the eligibility, this month's use of all
 *  four AI allowances, and what is sent to whom. Any member reads it; `canEdit` says whether the switches
 *  are theirs. Nothing here calls a model. */
export async function aiSettings(env: Pick<Env, "ANTHROPIC_API_KEY" | "TYPESAFE_API_KEY">, ctx: TenantContext, now: Date = new Date()): Promise<AiSettings> {
  const a = await planAndAiSettings(ctx, now);
  const eligibility = eligibilityOf(env, a.enabled, a.plan, a.used.ai_runs);
  return {
    enabled: a.enabled,
    canEdit: hasRole(ctx, "admin"),
    eligibility,
    allowances: Object.fromEntries(AI_ALLOWANCE_KEYS.map((k) => [k, allowanceUse(a.plan, k, a.used[k], now)])) as AiSettings["allowances"],
    chatAuto: a.chatAuto,
    // Anthropic's from the eligibility (`no_key` is its one key check), so the key stays read where it is listed.
    keys: { anthropic: eligibility !== "no_key", typesafe: !!env.TYPESAFE_API_KEY },
    planEnded: a.plan.status === "canceled" ? planDef(a.plan.plan).name : null,
    sends: [...AI_SENDS],
    neverSent: AI_NEVER_SENT,
  };
}

export const aiApp = new Hono<AppEnv>();
aiApp.use("/ai/*", cookieOnly);

const settingsOr503 = async (c: Context<AppEnv>) => {
  try {
    const s = await aiSettings(c.env, c.var.ctx);
    // LOCAL DEVELOPMENT ONLY (./preview.ts): the sample numbers over the real switches — never over an `off` or
    // `no_key` eligibility, which is THE read rule's off and is shown as it is (owner ruling Q13).
    const preview = s.eligibility === "off" || s.eligibility === "no_key" ? null : aiPreview(c.env, c.req.url);
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
  // A failed write is 503 `{ error }`, never a 500 (invariant 7).
  try {
    if (parsed.data.enabled !== undefined) await setAiAutomation(c.var.ctx, parsed.data.enabled);
    if (parsed.data.chatAuto !== undefined) await setAiChatAuto(c.var.ctx, parsed.data.chatAuto);
  } catch (e) {
    console.error("ai settings write", e instanceof Error ? e.name : "error", `org=${c.var.ctx.orgId}`);
    return c.json({ error: "Couldn't save the AI settings" }, 503);
  }
  return settingsOr503(c);
});

/** A suggestion's id from the path: a positive integer, else nothing to find. */
const suggestionId = (c: Context<AppEnv>): number | null => {
  const raw = c.req.param("id") ?? "";
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
};
/** LOCAL_AI_PREVIEW (Q5): a sample suggestion has no row (its id is made up), so its Accept / Dismiss would be
 *  `not_found`. Under the preview it answers `{ ok: true, preview: true }` instead, and nothing is written: the screen
 *  takes the decision locally and says "Not saved in preview". A REAL row with that id wins (it is answered as usual). */
const previewDecision = (c: Context<AppEnv>, id: number, a: SuggestionAnswer): boolean =>
  !a.ok && a.error === "not_found" && isPreviewSuggestionId(id) && aiPreviewMode(c.env, c.req.url) !== null;
const answer = (c: Context<AppEnv>, a: SuggestionAnswer) =>
  a.ok ? c.json({ ok: true, suggestion: a.suggestion }) : c.json(a.message ? { error: a.error, message: a.message } : { error: a.error }, a.status);

aiApp.post("/ai/suggestions/:id/accept", async (c) => {
  const id = suggestionId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  // An empty or unreadable body is `{}`; one the contract refuses is answered only after the id is found.
  const parsed = AiAcceptBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  try {
    const a = await acceptSuggestion(c.var.ctx, id, parsed.success ? parsed.data : null, undefined, { origin: new URL(c.req.url).origin });
    return previewDecision(c, id, a) ? c.json({ ok: true, preview: true }) : answer(c, a);
  } catch (e) {
    // A handler's writer refused (a bad date, an over-long narrative, a ticket gone): the suggestion is open again
    // (./suggestions.ts) and the person is told why, in the writer's own words. Anything else stays a 500.
    if (e instanceof Error && HANDLER_REFUSALS.has(e.name)) return c.json({ error: "invalid", message: e.message }, 400);
    throw e;
  }
});
/** The typed refusals of the writers an accept handler runs (src/tools/sprints.ts, tickets.ts, src/auth/persons.ts). */
const HANDLER_REFUSALS = new Set(["SprintError", "TicketError", "PersonError"]);

aiApp.post("/ai/suggestions/:id/dismiss", async (c) => {
  const id = suggestionId(c);
  if (id === null) return c.json({ error: "not_found" }, 404);
  const a = await dismissSuggestion(c.var.ctx, id);
  return previewDecision(c, id, a) ? c.json({ ok: true, preview: true }) : answer(c, a);
});

aiApp.post(AI_ROUTES.feedback, async (c) => {
  const parsed = AiFeedbackBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  try {
    await recordFeedback(c.var.ctx, c.var.ctx.userId, parsed.data);
  } catch (e) {
    console.error("ai feedback", e instanceof Error ? e.name : "error", `org=${c.var.ctx.orgId}`);
    return c.json({ error: "Couldn't save that" }, 503);
  }
  return c.json({ ok: true });
});

// ── The plain-language filter (#162, ./filter.ts) ────────────────────────────
// Gates in order, each spending nothing when it refuses: the body (400 `invalid`), the org's AI switch (403
// `off`), the key (503 `no_key`) — the preview honours both — then, unless `LOCAL_AI_PREVIEW` answers from the
// screen's fixture with no call and no count, the month's `ai_runs` (the house 402
// `plan_limit`, one `ai_run_capped:filter` counted), the person's `ai_filter` rate (429). Then ONE call. An
// answer that sets nothing is 422 `unreadable`, naming the request's words that are no filter here.
const filterRefusal = (c: Context<AppEnv>, code: AiFilterErrorCode, status: 400 | 403 | 422 | 503, message: string = AI_FILTER_MESSAGES[code]) =>
  c.json({ error: code, message }, status);

/** An answer that sets nothing is `unreadable`, said in the words of THAT screen's filter schema (Q-F2: the Feed
 *  has no status or priority to suggest). */
const filterAnswer = (c: Context<AppEnv>, screen: AiFilterScreen, a: AiFilterAnswer | null) => {
  if (a && !isEmptyFilter(a)) return c.json(a);
  const not = a?.unmatched.length ? ` Not a filter here: ${a.unmatched.map((u) => `“${u}”`).join(", ")}.` : "";
  return filterRefusal(c, "unreadable", 422, aiFilterUnreadable(screen) + not);
};

/** The preview's `capped`: the refusal a Free org at its month's runs would get. */
const previewCapped = (a: { plan: Parameters<typeof planRefusal>[0] }): PlanRefusal | null => {
  const free = { ...a.plan, plan: "free" as const, overrides: {}, status: "active" as const };
  return planRefusal(free, "ai_runs", resolveEntitlements("free").ai_runs ?? 0, 1);
};

aiApp.post(AI_FILTER_ROUTE, async (c) => {
  const parsed = AiFilterBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return filterRefusal(c, "invalid", 400);
  const ctx = c.var.ctx;
  try {
    const a = await aiAllowance(ctx, c.env);
    if (!a.enabled) return filterRefusal(c, "off", 403);
    if (a.eligibility === "no_key") return filterRefusal(c, "no_key", 503);
    // LOCAL DEVELOPMENT ONLY (./preview.ts): the fixture, checked exactly as a model's answer is — under the same
    // switch and key as a real call (owner ruling Q13), with no call and no count.
    const preview = aiPreviewMode(c.env, c.req.url);
    if (preview === "capped") return c.json(previewCapped(a), PLAN_LIMIT_STATUS);
    if (preview) return filterAnswer(c, parsed.data.screen, await previewAiFilter(ctx, parsed.data, preview));
    // THE allowance (shared/plans.ts `ai_runs`): one call is one run.
    const refusal = planRefusal(a.plan, "ai_runs", a.used, 1);
    if (refusal) {
      await meterBy(platform(c.env, ctx.userId), ctx.orgId, AI_FILTER_ACTOR, [[aiRunCappedMetric("filter"), 1]]);
      return c.json(refusal, PLAN_LIMIT_STATUS);
    }
    const limited = await rateLimited(c, "ai_filter");
    if (limited) return limited;
    return filterAnswer(c, parsed.data.screen, await runAiFilter(ctx, c.env, parsed.data));
  } catch (e) {
    console.error("ai filter", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    return c.json({ error: "Couldn't read what the filter needs." }, 503);
  }
});

// ── Ask Trov's replay (LOCAL DEVELOPMENT ONLY; docs/architecture/ask.md › Fixtures) ──────────────────────────────
// Under `wrangler dev` with LOCAL_AI_PREVIEW set (the same guard as every preview: a loopback http origin, no live
// Stripe key — ./preview.ts — and the read rule: the switch on and a key, any value, never sent), the Ask frontend can be
// built and screenshotted with no real model call:
//   GET /ai/ask-replay                 the scenarios, and the fixtures the screens read beside the stream
//   GET /ai/ask-replay/:scenario       that scenario's recorded SSE transcript, streamed at real pacing
//                                      (`?speed=4` plays it four times as fast; `?speed=0` all at once)
// Anywhere else both are 404, as if they did not exist. It lives here, not in src/ai/ask/, because the preview's
// guard reads the billing config — and nothing under src/ai/ask/ imports src/billing/.
/** The replay is a preview like the others: only under `LOCAL_AI_PREVIEW` AND THE AI read rule (the org's switch on and
 *  an Anthropic key in `.dev.vars` — any value, nothing is sent), so with either off the Ask screen shows its real off
 *  state (`/ask/state`), as production would. */
const replayOn = async (c: Context<AppEnv>): Promise<boolean> =>
  aiPreviewMode(c.env, c.req.url) !== null && (await aiShown(c.var.ctx)).shown;

aiApp.get("/ai/ask-replay", async (c) => {
  if (!(await replayOn(c))) return c.json({ error: "not_found" }, 404);
  const now = new Date();
  return c.json({
    scenarios: ASK_SCENARIOS, questions: ASK_SCENARIO_QUESTION,
    state: { pro: askStateFixture("pro", now), free: askStateFixture("free", now) },
    settings: { pro: askSettingsFixture("pro"), free: askSettingsFixture("free") },
    threads: askThreadsFixture(now), search: { q: "netlify", hits: askSearchFixture(now) }, refs: askRefFixtures(now),
  });
});

aiApp.get("/ai/ask-replay/:scenario", async (c) => {
  const scenario = c.req.param("scenario");
  if (!isAskScenario(scenario) || !(await replayOn(c))) return c.json({ error: "not_found" }, 404);
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
