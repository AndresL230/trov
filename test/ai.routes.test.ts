// Org settings › AI and the answers to what Trov wrote (src/ai/routes.ts, docs/architecture/ai.md): the switch
// (0055_ai_automation), suggestions and "Wrong?" (0056_ai_suggestions). Cookie routes only — none is an MCP tool.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { AI_NEVER_SENT, AI_ROUTES, AI_SENDS, AiSettingsSchema, AiSuggestionSchema, type AiSettings } from "@shared/ai";
import { AI_ACCEPT_HANDLERS, type AcceptHandler } from "../src/ai/suggestions";
import { hiddenFor, putSuggestion, type AiSuggestionRow } from "../src/data/ai";
import { mcpToolCatalog } from "../src/mcp-catalog";
import type { TenantContext } from "../src/data/context";
import { all, first, run } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, systemCtx } from "./helpers/tenant";
import { FAKE_ANTHROPIC_KEY } from "./helpers/anthropic";

const BASE = "/api/o/saplinglearn";
const MEMBER = "ai-member";

async function call<T = unknown>(method: string, path: string, cookie: string, body?: unknown, e: Env = env as unknown as Env, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method, headers: { cookie, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, e);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}

const suggestion = (o: Partial<Parameters<typeof putSuggestion>[1]> = {}, orgId: string = ORG_A) => putSuggestion(systemCtx(orgId), {
  itemType: "ticket", itemRef: "14", kind: "category", value: "bug", confidence: 0.8, reason: "The body describes a crash.",
  cites: [{ ref: "ticket:14", label: "#14", href: "#tickets/14" }], model: "claude-haiku-5-5", promptVersion: "1", ...o,
}) as Promise<number>;
const row = (id: number) => first<{ state: string; decided_by: string | null; decided_at: string | null }>(env.DB, `SELECT state, decided_by, decided_at FROM ai_suggestions WHERE id = ?`, id);

/** Register a handler for `kind` for the length of `fn` — the registry is empty in production. */
async function withHandler<T>(kind: string, h: AcceptHandler, fn: () => Promise<T>): Promise<T> {
  const reg = AI_ACCEPT_HANDLERS as Record<string, AcceptHandler>;
  reg[kind] = h;
  try { return await fn(); } finally { delete reg[kind]; }
}

describe("Org settings › AI — GET / PUT /ai/settings", () => {
  it("any member reads it: the switch, who may change it, eligibility, this month's runs, what is sent", async () => {
    const r = await call<AiSettings>("GET", `${BASE}${AI_ROUTES.settings}`, await cookieFor(MEMBER));
    expect(r.status).toBe(200);
    expect(AiSettingsSchema.parse(r.json)).toEqual({
      enabled: true, canEdit: false, eligibility: "no_key", // the pool has no key
      runs: { used: 0, cap: null, resumesOn: null }, // the seed org is Enterprise: unlimited
      sends: [...AI_SENDS], neverSent: AI_NEVER_SENT,
    });
    expect((await call<AiSettings>("GET", `${BASE}${AI_ROUTES.settings}`, await cookieFor(FIXTURE_ADMIN))).json.canEdit).toBe(true);
  });

  it("with a key: ok, and on Free at 250 capped with the day it resumes", async () => {
    const keyed = { ...(env as unknown as Env), ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY };
    const cookie = await cookieFor(MEMBER);
    expect((await call<AiSettings>("GET", `${BASE}${AI_ROUTES.settings}`, cookie, undefined, keyed)).json.eligibility).toBe("ok");
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    const day = new Date().toISOString().slice(0, 10);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, 'ai_run:brief', 'ai-pass', 250, ?)`, ORG_A, day, new Date().toISOString());
    const r = (await call<AiSettings>("GET", `${BASE}${AI_ROUTES.settings}`, cookie, undefined, keyed)).json;
    const next = new Date(); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
    expect(r).toMatchObject({ eligibility: "capped", runs: { used: 250, cap: 250, resumesOn: next.toISOString().slice(0, 10) } });
  });

  it("an admin turns it off (audited) and on; a member's PUT is 403 and changes nothing; a bad body is 400", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    const off = await call<AiSettings>("PUT", `${BASE}${AI_ROUTES.settings}`, admin, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ enabled: false, eligibility: "no_key", canEdit: true });
    expect(await first(env.DB, `SELECT ai_automation FROM orgs WHERE id = ?`, ORG_A)).toEqual({ ai_automation: 0 });
    const keyed = { ...(env as unknown as Env), ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY };
    expect((await call<AiSettings>("GET", `${BASE}${AI_ROUTES.settings}`, admin, undefined, keyed)).json.eligibility).toBe("off");
    expect(await all(env.DB, `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? AND action = 'org.ai'`, ORG_A))
      .toEqual([{ actor: FIXTURE_ADMIN, action: "org.ai", target: "ai", detail: JSON.stringify({ enabled: false }) }]);

    const member = await cookieFor(MEMBER);
    expect(await call("PUT", `${BASE}${AI_ROUTES.settings}`, member, { enabled: true })).toEqual({ status: 403, json: { error: "forbidden" } });
    expect(await first(env.DB, `SELECT ai_automation FROM orgs WHERE id = ?`, ORG_A)).toEqual({ ai_automation: 0 });
    expect((await call("PUT", `${BASE}${AI_ROUTES.settings}`, admin, { enabled: "yes" })).status).toBe(400);
    expect((await call<AiSettings>("PUT", `${BASE}${AI_ROUTES.settings}`, admin, { enabled: true })).json.enabled).toBe(true);
    // Another org's switch is its own.
    expect(await first(env.DB, `SELECT ai_automation FROM orgs WHERE id = ?`, ORG_B)).toEqual({ ai_automation: 1 });
  });

  it("is a signed-in person's: a request carrying an Authorization header is refused, and no MCP tool does any of it", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    const auth = { authorization: "Bearer trov_mcp_x" };
    expect((await call("PUT", `${BASE}${AI_ROUTES.settings}`, admin, { enabled: false }, env as unknown as Env, auth)).status).toBe(403);
    expect((await call("POST", `${BASE}${AI_ROUTES.feedback}`, admin, { itemType: "brief", itemRef: "x", kind: "brief", model: null, promptVersion: null }, env as unknown as Env, auth)).status).toBe(403);
    expect(await first(env.DB, `SELECT ai_automation FROM orgs WHERE id = ?`, ORG_A)).toEqual({ ai_automation: 1 });
    const names = (await mcpToolCatalog()).map((t) => t.name);
    expect(names.filter((n) => /\bai\b|ai_|suggest|feedback|automation/i.test(n))).toEqual([]);
  });

  it("has no old-path alias: it exists only under /api/o/:slug", async () => {
    expect((await call("GET", AI_ROUTES.settings, await cookieFor(MEMBER))).status).toBe(404);
  });
});

describe("suggestions — accept and dismiss", () => {
  it("accept with the empty registry is 409 not_available for every kind, and the suggestion stays open", async () => {
    const id = await suggestion();
    const r = await call("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor(FIXTURE_ADMIN), {});
    expect(r).toEqual({ status: 409, json: { error: "not_available" } });
    expect((await row(id))!.state).toBe("open");
  });

  it("an unknown id, another org's id and a malformed id are 404 not_found — before forbidden", async () => {
    const theirs = await suggestion({}, ORG_B);
    await withHandler("category", { role: "admin", apply: async () => undefined }, async () => {
      const member = await cookieFor(MEMBER);
      for (const id of [999_999, theirs]) {
        expect(await call("POST", `${BASE}${AI_ROUTES.accept(id)}`, member, {}), String(id)).toEqual({ status: 404, json: { error: "not_found" } });
        expect(await call("POST", `${BASE}${AI_ROUTES.dismiss(id)}`, member, {}), String(id)).toEqual({ status: 404, json: { error: "not_found" } });
      }
      expect((await call("POST", `${BASE}/ai/suggestions/abc/accept`, member, {})).status).toBe(404);
    });
    expect((await row(theirs))!.state).toBe("open");
  });

  it("with a handler: it runs AS the cookie person, then the row is accepted with decided_by; a member below its role is 403", async () => {
    const id = await suggestion();
    const seen: { who: string; via: string; org: string; value: unknown; kind: string }[] = [];
    const handler: AcceptHandler = {
      role: "admin",
      apply: async (ctx: TenantContext, s: AiSuggestionRow, value: unknown) => { seen.push({ who: ctx.userId, via: ctx.via, org: ctx.orgId, value, kind: s.kind }); },
    };
    await withHandler("category", handler, async () => {
      expect(await call("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor(MEMBER), {})).toEqual({ status: 403, json: { error: "forbidden" } });
      expect(seen).toEqual([]);
      const r = await call<{ ok: true; suggestion: unknown }>("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor(FIXTURE_ADMIN), { value: "feature" });
      expect(r.status).toBe(200);
      expect(AiSuggestionSchema.parse(r.json.suggestion)).toMatchObject({ id, state: "accepted", kind: "category", reason: "The body describes a crash." });
      // The person's replacement value (Rename) is what the handler wrote.
      expect(seen).toEqual([{ who: FIXTURE_ADMIN, via: "session", org: ORG_A, value: "feature", kind: "category" }]);
      expect(await row(id)).toMatchObject({ state: "accepted", decided_by: FIXTURE_ADMIN, decided_at: expect.any(String) });
      // Decided: a second accept (or a dismiss) is not_open, and the handler is not run again.
      expect(await call("POST", `${BASE}${AI_ROUTES.accept(id)}`, await cookieFor(FIXTURE_ADMIN), {})).toEqual({ status: 409, json: { error: "not_open" } });
      expect(await call("POST", `${BASE}${AI_ROUTES.dismiss(id)}`, await cookieFor(FIXTURE_ADMIN), {})).toEqual({ status: 409, json: { error: "not_open" } });
      expect(seen).toHaveLength(1);
    });
  });

  it("with no value in the body, the suggested value is applied; a handler that throws leaves it open", async () => {
    const id = await suggestion({ value: { category: "bug" } });
    const values: unknown[] = [];
    await withHandler("category", { role: "member", apply: async (_c, _s, v) => { values.push(v); throw new Error("refused"); } }, async () => {
      // The handler's error is the app's (a real 500 — or, for a PlanLimitError, the app's 402).
      const req = app.request(`${BASE}${AI_ROUTES.accept(id)}`, { method: "POST", headers: { cookie: await cookieFor(MEMBER), "content-type": "application/json" }, body: "{}" }, env);
      const status = await Promise.resolve(req).then((r: Response) => r.status, () => 500);
      expect(status).toBe(500);
    });
    expect(values).toEqual([{ category: "bug" }]);
    expect(await row(id)).toEqual({ state: "open", decided_by: null, decided_at: null });
  });

  it("dismiss is any member's, and the decision is remembered: a re-run supersedes only an OPEN suggestion", async () => {
    const id = await suggestion();
    const r = await call<{ ok: true; suggestion: { state: string } }>("POST", `${BASE}${AI_ROUTES.dismiss(id)}`, await cookieFor(MEMBER), {});
    expect(r).toMatchObject({ status: 200, json: { ok: true, suggestion: { state: "dismissed" } } });
    expect(await row(id)).toMatchObject({ state: "dismissed", decided_by: MEMBER });
    // A re-run of the same kind for the same item: the dismissed one stays dismissed, a new one is open.
    const again = await suggestion({ reason: "Still looks like a crash." });
    const open = await suggestion({ reason: "Third time." });
    expect((await row(id))!.state).toBe("dismissed");
    expect((await row(again))!.state).toBe("superseded");
    expect((await row(open))!.state).toBe("open");
    // No reason, no suggestion.
    expect(await putSuggestion(systemCtx(), { itemType: "ticket", itemRef: "14", kind: "category", value: "x", confidence: null, reason: "  ", cites: [], model: null, promptVersion: null })).toBeNull();
    expect((await row(open))!.state).toBe("open");
  });
});

describe('"Wrong?" — POST /ai/feedback', () => {
  const body = { itemType: "brief", itemRef: "person:ai-member", kind: "brief", model: "claude-haiku-5-5", promptVersion: "3" };

  it("writes one row per (person, item), idempotently, for the cookie person; hiddenFor returns it", async () => {
    const cookie = await cookieFor(MEMBER);
    expect(await call("POST", `${BASE}${AI_ROUTES.feedback}`, cookie, body)).toEqual({ status: 200, json: { ok: true } });
    expect(await call("POST", `${BASE}${AI_ROUTES.feedback}`, cookie, body)).toEqual({ status: 200, json: { ok: true } });
    await call("POST", `${BASE}${AI_ROUTES.feedback}`, await cookieFor(FIXTURE_ADMIN), body);
    expect(await all(env.DB, `SELECT org_id, handle, item_type, item_ref, kind, model, prompt_version FROM ai_feedback ORDER BY handle`)).toEqual([
      { org_id: ORG_A, handle: MEMBER, item_type: "brief", item_ref: "person:ai-member", kind: "brief", model: "claude-haiku-5-5", prompt_version: "3" },
      { org_id: ORG_A, handle: FIXTURE_ADMIN, item_type: "brief", item_ref: "person:ai-member", kind: "brief", model: "claude-haiku-5-5", prompt_version: "3" },
    ].sort((a, b) => a.handle.localeCompare(b.handle)));
    expect([...(await hiddenFor(systemCtx(), MEMBER, "brief"))]).toEqual(["person:ai-member"]);
    expect([...(await hiddenFor(systemCtx(), MEMBER, "feed"))]).toEqual([]);
    // Another org's reader sees nothing of it.
    await ensureMember(MEMBER, "member", ORG_B);
    expect([...(await hiddenFor(systemCtx(ORG_B), MEMBER, "brief"))]).toEqual([]);
  });

  it("a body the contract refuses is 400 and writes nothing", async () => {
    const cookie = await cookieFor(MEMBER);
    for (const bad of [{ ...body, itemType: "ticket" }, { ...body, itemRef: "" }, { itemType: "brief" }, null]) {
      expect((await call("POST", `${BASE}${AI_ROUTES.feedback}`, cookie, bad)).status).toBe(400);
    }
    expect(await all(env.DB, `SELECT id FROM ai_feedback`)).toEqual([]);
  });
});
