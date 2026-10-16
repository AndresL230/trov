// The AI fields on the existing reads (docs/architecture/ai.md › The screens' fields): `brief` on My Work,
// `state` / `themes` on the Repo dashboard, `ai` on a feed row. Nothing produces them yet, so production
// omits every one — and `LOCAL_AI_PREVIEW` fills them from shared/ai-fixtures.ts ONLY for a request to a
// loopback http origin (`wrangler dev`) with no live Stripe key, and never over MCP (src/ai/preview.ts).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import { aiPreviewMode, withPreviewFeed } from "../src/ai/preview";
import { shapeRepoDashboard } from "../src/tools/repo-agent";
import { emptyRepoDashboard } from "../src/tools/repo";
import { append_feed } from "../src/tools/writes";
import { AiBriefSchema, AiFeedMetaSchema, AiRepoStateSchema, AiSettingsSchema, AiThemesSchema, AI_ALLOWANCE_KEYS, AI_ROUTES, AI_THEME_RANGES, nextMonthStart, type AiSettings } from "@shared/ai";
import { aiPreviewFixtures, aiSettingsFixture } from "@shared/ai-fixtures";
import type { FeedRow } from "@shared/rows";
import { cookieFor } from "./helpers/persons";
import { ORG_A, bearerCtx, systemCtx } from "./helpers/tenant";
import { run } from "./helpers/db";
import { useAiKey } from "./helpers/ai-key";
import { FAKE_ANTHROPIC_KEY } from "./helpers/anthropic";

const ME = "AndresL230";
const LOCAL = "http://localhost:8787";
const DEPLOYED = "https://trov.dev";
const withVars = (over: Partial<Env>): Env => ({ ...(env as unknown as Env), ...over });

async function get<T>(origin: string, path: string, e: Env = env as unknown as Env): Promise<T> {
  const res = await app.request(`${origin}/api/o/saplinglearn${path}`, { headers: { cookie: await cookieFor(ME) } }, e);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}
type Dash = Record<string, unknown>;
const feedOf = async (origin: string, e?: Env, q = "") => (await get<{ feed: FeedRow[] }>(origin, `/feed${q}`, e)).feed;

async function mcp<T>(tool: string, args: Record<string, unknown>, e: Env): Promise<T> {
  const server = buildTrovMcpServer(e, await bearerCtx(ME));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.content[0].text) as T;
  } finally {
    await client.close();
    await server.close();
  }
}

/** No AI field anywhere on the three reads (and the two MCP reads). */
async function expectNoAiFields(origin: string, e: Env): Promise<void> {
  const dash = await get<Dash>(origin, "/me/dashboard", e);
  expect(dash).not.toHaveProperty("brief");
  const repo = await get<Dash>(origin, "/repo/dashboard", e);
  expect(repo).not.toHaveProperty("state");
  expect(repo).not.toHaveProperty("themes");
  const feed = await feedOf(origin, e);
  expect(feed.length).toBeGreaterThan(0);
  expect(feed.filter((r) => "ai" in r)).toEqual([]);
}

describe("production: every AI field is omitted", () => {
  it("/me/dashboard, /repo/dashboard and /feed carry no brief / state / themes / ai, and nor do get_my_work, get_repo_dashboard, get_feed", async () => {
    await append_feed(systemCtx(), { author: ME, summary: "an agent's entry", body: "b", tags: [] });
    await expectNoAiFields(DEPLOYED, env as unknown as Env);
    await expectNoAiFields(LOCAL, env as unknown as Env); // LOCAL_AI_PREVIEW is blank in the pool (vitest.config.ts)
    expect(await mcp<Dash>("get_my_work", {}, env as unknown as Env)).not.toHaveProperty("brief");
    const repo = await mcp<Dash>("get_repo_dashboard", {}, env as unknown as Env);
    expect(repo).not.toHaveProperty("state");
    expect(repo).not.toHaveProperty("themes");
    expect((await mcp<FeedRow[]>("get_feed", {}, env as unknown as Env)).filter((r) => "ai" in r)).toEqual([]);
  });
});

describe("nothing written yet, with a key and the switch on: the screens say when Trov writes it (Q23/Q24)", () => {
  const KEYED_ENV = withVars({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY });
  it("/me/dashboard carries an `empty` brief and /repo/dashboard an `empty` state; MCP, no key or the switch off: absent", async () => {
    const empty = { state: "empty", generatedAt: null, model: null, resumesOn: null, upgrade: false };
    await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_q23', ?, 'acme/app', 1, 0, '2026-10-06T00:00:00Z', 'test')`, ORG_A);
    expect((await get<Dash>(DEPLOYED, "/me/dashboard", KEYED_ENV)).brief).toEqual({ ...empty, now: null, recently: null, next: { items: [] } });
    expect((await get<Dash>(DEPLOYED, "/repo/dashboard", KEYED_ENV)).state).toEqual({ ...empty, headline: null, shipped: [], inFlight: [], attention: [], eventCount: null });
    // MCP still leaves them out (nothing written is no field there), and so does a deployment with no key.
    expect(await mcp<Dash>("get_my_work", {}, KEYED_ENV)).not.toHaveProperty("brief");
    expect(await mcp<Dash>("get_repo_dashboard", {}, KEYED_ENV)).not.toHaveProperty("state");
    expect(await get<Dash>(DEPLOYED, "/me/dashboard")).not.toHaveProperty("brief");
    // The month's runs spent: `capped`, never a promise that Trov writes it soon.
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, actor, metric, count, last_at) VALUES (?, ?, 'ai-pass', 'ai_run:repo.state', 250, ?)`, ORG_A, new Date().toISOString().slice(0, 10), new Date().toISOString());
    const capped = { state: "capped", generatedAt: null, model: null, resumesOn: nextMonthStart(new Date()), upgrade: true };
    expect((await get<Dash>(DEPLOYED, "/me/dashboard", KEYED_ENV)).brief).toEqual({ ...capped, now: null, recently: null, next: { items: [] } });
    expect((await get<Dash>(DEPLOYED, "/repo/dashboard", KEYED_ENV)).state).toEqual({ ...capped, headline: null, shipped: [], inFlight: [], attention: [], eventCount: null });
    // The switch off: absent.
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    expect(await get<Dash>(DEPLOYED, "/me/dashboard", KEYED_ENV)).not.toHaveProperty("brief");
    expect(await get<Dash>(DEPLOYED, "/repo/dashboard", KEYED_ENV)).not.toHaveProperty("state");
  });
});

describe("LOCAL_AI_PREVIEW under `wrangler dev`", () => {
  // The preview keeps THE read rule (src/plans/gate.ts `aiShown`): it shows its samples only with a key (a fake one here).
  useAiKey();
  it("fills the three reads with the fixtures, valid against the contracts; the feed's entries merged newest first", async () => {
    await append_feed(systemCtx(), { author: ME, summary: "an agent's entry", body: "b", tags: [] });
    const e = withVars({ LOCAL_AI_PREVIEW: "ready" });
    const dash = await get<Dash>(LOCAL, "/me/dashboard", e);
    expect(AiBriefSchema.parse(dash.brief)).toMatchObject({ state: "ready" });
    const repo = await get<Dash>(LOCAL, "/repo/dashboard", e);
    expect(AiRepoStateSchema.parse(repo.state)).toMatchObject({ state: "ready", eventCount: 6 });
    for (const r of AI_THEME_RANGES) expect(AiThemesSchema.parse((repo.themes as Record<string, unknown>)[r])).toMatchObject({ range: r });
    const feed = await feedOf(LOCAL, e);
    const written = feed.filter((r) => r.ai);
    expect(written.map((r) => r.id)).toEqual([990_001, 990_002]);
    for (const r of written) AiFeedMetaSchema.parse(r.ai);
    expect([...feed].sort((a, b) => b.created_at.localeCompare(a.created_at))).toEqual(feed);
    // Each mode is its fixture.
    const capped = await get<Dash>(LOCAL, "/me/dashboard", withVars({ LOCAL_AI_PREVIEW: "capped" }));
    expect(capped.brief).toMatchObject({ state: "capped", upgrade: true });
    const proposed = await get<Dash>(LOCAL, "/repo/dashboard", withVars({ LOCAL_AI_PREVIEW: "proposed" }));
    expect((proposed.themes as Record<string, { lanes: { status: string }[] }>)["8w"].lanes.every((l) => l.status === "proposed")).toBe(true);
  });

  it("Org settings › AI in every mode: all four allowances, the Auto switch and BOTH providers — the switches stay the org's own", async () => {
    const now = new Date();
    const real = await get<AiSettings>(DEPLOYED, AI_ROUTES.settings, withVars({ LOCAL_AI_PREVIEW: "ready" })); // not honoured: the real numbers
    expect(real.allowances.ai_runs).toEqual({ used: 0, cap: null, resumesOn: null }); // the seed org is Enterprise
    for (const mode of ["ready", "empty", "capped", "proposed"] as const) {
      const s = AiSettingsSchema.parse(await get<AiSettings>(LOCAL, AI_ROUTES.settings, withVars({ LOCAL_AI_PREVIEW: mode })));
      expect(Object.keys(s.allowances), mode).toEqual([...AI_ALLOWANCE_KEYS]);
      expect(s.allowances, mode).toEqual(aiSettingsFixture(mode, now).allowances);
      expect(s.eligibility, mode).toBe(mode === "capped" ? "capped" : "ok");
      expect(s.chatAuto, mode).toBe(true);                       // the org's real switch (0058, default on)
      expect(s.enabled, mode).toBe(true);
      expect([...new Set(s.sends.map((l) => l.provider))], mode).toEqual(["Anthropic", "TypeSafe AI"]);
    }
    const ready = aiSettingsFixture("ready", now).allowances;
    expect(ready.ai_chat).toEqual({ used: 1120, cap: 1500, resumesOn: null }); // a 5-seat Pro org: 300 questions per seat
    expect(Object.values(aiSettingsFixture("empty", now).allowances).every((a) => a.used === 0 && a.cap !== null)).toBe(true);
    expect(Object.values(aiSettingsFixture("capped", now).allowances).every((a) => a.used === a.cap && a.resumesOn === nextMonthStart(now))).toBe(true);
    // The preview fills numbers, never a choice: an admin's switch shows through it.
    await run(env.DB, `UPDATE orgs SET ai_chat_auto = 0 WHERE id = ?`, ORG_A);
    expect((await get<AiSettings>(LOCAL, AI_ROUTES.settings, withVars({ LOCAL_AI_PREVIEW: "ready" }))).chatAuto).toBe(false);
  });

  it("is never on MCP, whatever the request", async () => {
    const e = withVars({ LOCAL_AI_PREVIEW: "ready" });
    expect(await mcp<Dash>("get_my_work", {}, e)).not.toHaveProperty("brief");
    expect(await mcp<Dash>("get_repo_dashboard", {}, e)).not.toHaveProperty("state");
    expect((await mcp<FeedRow[]>("get_feed", {}, e)).filter((r) => "ai" in r)).toEqual([]);
  });

  it("GUARD: a deployed origin, a live Stripe key beside it, or a value that is not a mode → no sample at all", async () => {
    await append_feed(systemCtx(), { author: ME, summary: "an agent's entry", body: "b", tags: [] });
    // With the key the preview needs, the real reads still answer: nothing written is an `empty` brief and state on
    // the screens (Q23/Q24) — never the samples, and no theme or Trov entry.
    const noSample = async (origin: string, e: Env) => {
      const dash = await get<Dash>(origin, "/me/dashboard", e);
      expect((dash.brief as { state?: string } | undefined)?.state ?? "absent").toBe("empty");
      const repo = await get<Dash>(origin, "/repo/dashboard", e);
      expect((repo.state as { state?: string } | undefined)?.state ?? "absent").not.toBe("ready");
      expect(repo).not.toHaveProperty("themes");
      expect((await feedOf(origin, e)).filter((r) => "ai" in r)).toEqual([]);
    };
    await noSample(DEPLOYED, withVars({ LOCAL_AI_PREVIEW: "ready" }));
    await noSample("https://localhost:8787", withVars({ LOCAL_AI_PREVIEW: "ready" })); // https is not `wrangler dev`'s
    await noSample(LOCAL, withVars({ LOCAL_AI_PREVIEW: "ready", STRIPE_SECRET_KEY: "sk_live_x" }));
    await noSample(LOCAL, withVars({ LOCAL_AI_PREVIEW: "ready", STRIPE_SECRET_KEY: "rk_live_x" }));
    for (const v of ["off", "1", "true", "READY ", ""]) await noSample(LOCAL, withVars({ LOCAL_AI_PREVIEW: v }));
  });

  it("aiPreviewMode: the rule on its own", () => {
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: "ready" }, "http://127.0.0.1:8787/x")).toBe("ready");
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: " empty " }, "http://localhost/x")).toBe("empty");
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: "ready", STRIPE_SECRET_KEY: "sk_test_x" }, "http://localhost/x")).toBe("ready");
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: "ready", STRIPE_SECRET_KEY: "sk_live_x" }, "http://localhost/x")).toBeNull();
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: "ready" }, "https://trov.dev/x")).toBeNull();
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: "ready" }, "http://trov.dev/x")).toBeNull();
    expect(aiPreviewMode({ LOCAL_AI_PREVIEW: "ready" }, "http://192.168.1.4:8787/x")).toBeNull();
    expect(aiPreviewMode({}, "http://localhost/x")).toBeNull();
  });

  it("the feed merge follows the page's own filters", () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const extra = aiPreviewFixtures("ready", now).feed;
    const old: FeedRow = { id: 1, author: "x", summary: "s", brief: null, body: null, artifacts: null, created_at: "2026-10-14T11:30:00.000Z" };
    expect(withPreviewFeed([old], extra, {}).map((r) => r.id)).toEqual([old.id, 990_001, 990_002]);
    expect(withPreviewFeed([old], extra, { author: "x" })).toEqual([old]);
    expect(withPreviewFeed([old], extra, { tags: ["infra"] })).toEqual([old]);
    expect(withPreviewFeed([old], extra, { since: "2026-10-14T10:00:00.000Z" }).map((r) => r.id)).toEqual([old.id, 990_001]);
    expect(withPreviewFeed([old], extra, { limit: 2 }).map((r) => r.id)).toEqual([old.id, 990_001]);
  });
});

describe("get_repo_dashboard: what Trov writes travels with the tab it is shown on", () => {
  it("`state` with the overview (or no tab), `themes` with planning (or no tab), neither elsewhere — and absent stays absent", () => {
    const f = aiPreviewFixtures("ready", new Date("2026-10-14T12:00:00.000Z"));
    const dash = { ...emptyRepoDashboard("o/r", false), state: f.repoState, themes: f.themes };
    expect(shapeRepoDashboard(dash)).toMatchObject({ state: f.repoState, themes: f.themes });
    const overview = shapeRepoDashboard(dash, { tab: "overview" });
    expect(overview.state).toEqual(f.repoState);
    expect(overview).not.toHaveProperty("themes");
    const planning = shapeRepoDashboard(dash, { tab: "planning" });
    expect(planning.themes).toEqual(f.themes);
    expect(planning).not.toHaveProperty("state");
    for (const tab of ["code", "ci", "usage"] as const) {
      const v = shapeRepoDashboard(dash, { tab });
      expect(v).not.toHaveProperty("state");
      expect(v).not.toHaveProperty("themes");
    }
    const none = shapeRepoDashboard(emptyRepoDashboard("o/r", false));
    expect(none).not.toHaveProperty("state");
    expect(none).not.toHaveProperty("themes");
  });
});
