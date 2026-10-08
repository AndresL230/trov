/**
 * The hosting providers in the repo cron and Poll now (src/repo/cron.ts) — and their retention.
 *
 *   :40      the `hosting` job: one unit per (org, environment, STORED part) of every active org, costed at
 *            its provider's `pollCost`, served by rotation after health's half of the budget — and NOT a
 *            job at all (health keeps the whole tick) when no org has a stored part.
 *   Poll now a `hosting` arm after usage, present in the result ONLY when the org has a stored part, skipped
 *            part by part (`BUDGET_SKIP`) when the whole refresh would not fit the free plan's 50.
 *   prune    `hx_*` points with the other hourly usage series (100 days), `hosting_deploys` at 180 days.
 *
 * Providers are FAKES handed in through the `providers` parameter; rows are asserted in real D1.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all } from "./helpers/db";
import { ENVS, LONG_TOKEN } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, ORG_B, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { setSecret } from "../src/data/secrets";
import { BUDGET_SKIP, HEALTH_COST, handleRepoCron, runPartJob, runRepoRefresh } from "../src/repo/cron";
import { DEFAULT_HOSTING_COST, hostingPollCost, providerPollCost, type ProviderMap } from "../src/hosting/poll";
import { PROVIDERS } from "../src/hosting/registry";
import { listStoredParts } from "../src/hosting/parts";
import { readCursor } from "../src/platform/jobs";
import { pruneRepoCapture } from "../src/platform/sweeps";
import { putMetrics } from "../src/repo/store";
import type { HostingProvider, ProviderContext } from "../src/hosting/types";
import type { RepoEnvConfig } from "../src/repo/config";

const e = env as unknown as Env;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AT_40 = Date.parse("2026-09-20T12:40:00Z");
const API = "https://api.vercel.test";

/** One poll = exactly `cost` fetches (its declared worst case), so the budget the test watches is real. */
function fakeVercel(log: string[], cost = 2): HostingProvider {
  return {
    id: "vercel", label: "Vercel", status: "available", summary: "", roles: ["web"], apiHosts: ["api.vercel.test"], docsUrl: "",
    credentialScope: "org", connectionMethods: [], orgConfigFields: [], partSettings: [], capabilities: { deploys: true, metrics: ["requests"] },
    planNote: null, pollCost: cost, consoleUrl: () => null, probe: async () => ({ ok: true, detail: "" }),
    async poll(pc: ProviderContext, part) {
      for (let i = 0; i < cost; i++) await pc.fetch(`${API}/poll/${part.env}/${part.key}`, { headers: { authorization: `Bearer ${pc.credential.secret.reveal()}` } });
      log.push(`${part.orgId}/${part.env}/${part.key}`);
      return { deploys: [], points: [{ metric: "requests", at: "2026-09-20T11:00:00.000Z", value: 5 }], unavailable: [], covered: null };
    },
  };
}

/** Records every request; answers 200. */
function world() {
  const urls: string[] = [];
  const fetchImpl = (async (u: RequestInfo | URL) => { urls.push(String(u)); return new Response("ok", { status: 200 }); }) as typeof fetch;
  return { urls, fetchImpl, pings: () => urls.filter((u) => !u.startsWith(API)), polls: () => urls.filter((u) => u.startsWith(API)) };
}

async function addPart(orgId: string, envKey: string, key: string, provider = "vercel", position = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, 'web', ?, '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'test')`,
  ).bind(orgId, envKey, key, position, key, provider).run();
}
async function connect(orgId: string, token: string): Promise<void> {
  const admin = orgId === ORG_A ? await tenantCtx("AndresL230") : await tenantCtx("bob", "admin", { orgId });
  await setSecret(admin, "vercel", "", token);
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spies = (["error", "warn"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};
const oneEnv = (key: string): RepoEnvConfig => ({ ...ENVS[0], key, label: key, frontendUrl: `https://${key}.example.test`, apiUrl: `https://api.${key}.example.test` });

describe("the :40 tick — the hosting job", () => {
  it("polls every stored part of every active org with that org's credential, after the health pings", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await setOrgEnvironments([oneEnv("live")], ORG_B);
    await addPart(ORG_A, "staging", "web");
    await addPart(ORG_A, "production", "web");
    await addPart(ORG_B, "live", "site");
    await connect(ORG_A, `a_${LONG_TOKEN}`);
    await connect(ORG_B, `b_${LONG_TOKEN}`);
    const log: string[] = [];
    const w = world();
    await handleRepoCron(e, AT_40, w.fetchImpl, undefined, { vercel: fakeVercel(log) });
    // The lister's stable order: org id, then environment position, then part position.
    expect(log).toEqual([`${ORG_B}/live/site`, `${ORG_A}/staging/web`, `${ORG_A}/production/web`]);
    expect(w.pings()).toHaveLength(6);             // health first: two pings for each of the three environments
    expect(w.polls()).toHaveLength(6);             // two fetches per part
    const rows = await all<{ org_id: string; env: string; part: string; metric: string }>(env.DB,
      `SELECT org_id, env, part, metric FROM repo_metrics WHERE metric LIKE 'hx_%' ORDER BY org_id, env, part`);
    expect(rows).toEqual([
      { org_id: ORG_B, env: "live", part: "site", metric: "hx_requests" },
      { org_id: ORG_A, env: "production", part: "web", metric: "hx_requests" },
      { org_id: ORG_A, env: "staging", part: "web", metric: "hx_requests" },
    ]);
    // Every unit was served: the rotation's cursor is never written.
    expect(await readCursor(platformCtx("system"), "hosting")).toBe("");
  });

  it("no other tick polls a provider, and a suspended org's parts are not listed", async () => {
    await setOrgEnvironments([oneEnv("live")], ORG_A);
    await setOrgEnvironments([oneEnv("live")], ORG_B);
    await addPart(ORG_A, "live", "web");
    await addPart(ORG_B, "live", "web");
    await connect(ORG_A, `a_${LONG_TOKEN}`);
    await connect(ORG_B, `b_${LONG_TOKEN}`);
    const log: string[] = [];
    for (const minute of ["00", "10", "20", "30", "50"]) {
      await quiet(() => handleRepoCron(e, Date.parse(`2026-09-20T12:${minute}:00Z`), world().fetchImpl, undefined, { vercel: fakeVercel(log) }));
    }
    expect(log).toEqual([]);
    await env.DB.prepare(`UPDATE orgs SET suspended_at = '2026-09-01T00:00:00.000Z' WHERE id = ?`).bind(ORG_B).run();
    await handleRepoCron(e, AT_40, world().fetchImpl, undefined, { vercel: fakeVercel(log) });
    expect(log).toEqual([`${ORG_A}/live/web`]);
  });

  it("rotation: a budget too small for every part serves a slice per tick and resumes from the cursor", async () => {
    await setOrgEnvironments([oneEnv("live")], ORG_A);
    for (const [i, key] of ["p1", "p2", "p3"].entries()) await addPart(ORG_A, "live", key, "vercel", i);
    await connect(ORG_A, LONG_TOKEN);
    const log: string[] = [];
    // 6: health may use half (3) — its one unit costs 2 — and two parts (2 each) fit after it.
    await handleRepoCron(e, AT_40, world().fetchImpl, 6, { vercel: fakeVercel(log) });
    expect(log).toEqual([`${ORG_A}/live/p1`, `${ORG_A}/live/p2`]);
    expect(await readCursor(platformCtx("system"), "hosting")).toBe(`${ORG_A}/live/p2`);
    await handleRepoCron(e, AT_40 + HOUR, world().fetchImpl, 6, { vercel: fakeVercel(log) });
    expect(log.slice(2)).toEqual([`${ORG_A}/live/p3`, `${ORG_A}/live/p1`]);
    expect(await readCursor(platformCtx("system"), "hosting")).toBe(`${ORG_A}/live/p1`);
  });

  it("health keeps HALF the budget only when there is a part to poll — with none, it keeps the whole tick", async () => {
    await setOrgEnvironments(["one", "two", "three"].map(oneEnv), ORG_A);
    const w = world();
    // No stored part anywhere: :40 is a health-only tick, and 3 units × 2 pings fit a budget of 6.
    await handleRepoCron(e, AT_40, w.fetchImpl, 3 * HEALTH_COST, { vercel: fakeVercel([]) });
    expect(w.pings()).toHaveLength(6);
    // A stored part (and its credential) makes :40 a heavy tick: health may use only half (3) — one unit.
    await addPart(ORG_A, "one", "web");
    await connect(ORG_A, LONG_TOKEN);
    const log: string[] = [];
    const w2 = world();
    await quiet(() => handleRepoCron(e, AT_40 + HOUR, w2.fetchImpl, 3 * HEALTH_COST, { vercel: fakeVercel(log) }));
    expect(w2.pings()).toHaveLength(2);
    expect(log).toEqual([`${ORG_A}/one/web`]);
  });

  it("an org with a stored part but no credential costs the tick no request", async () => {
    await setOrgEnvironments([oneEnv("live")], ORG_A);
    await addPart(ORG_A, "live", "web");
    const log: string[] = [];
    const w = world();
    await handleRepoCron(e, AT_40, w.fetchImpl, undefined, { vercel: fakeVercel(log) });
    expect(log).toEqual([]);
    expect(w.polls()).toEqual([]);
    expect(await all(env.DB, `SELECT status, detail FROM hosting_poll_state`)).toEqual([{ status: "skipped", detail: "not connected" }]);
  });

  it("a unit costs its provider's pollCost — the default when the provider is unknown or declares nonsense", () => {
    const fake = fakeVercel([], 3);
    expect(providerPollCost({ vercel: fake }, "vercel")).toBe(3);
    expect(providerPollCost({ vercel: { ...fake, pollCost: Number.NaN } }, "vercel")).toBe(DEFAULT_HOSTING_COST);
    expect(providerPollCost({ vercel: { ...fake, pollCost: 0 } }, "vercel")).toBe(DEFAULT_HOSTING_COST);
    expect(providerPollCost(PROVIDERS, "heroku")).toBe(DEFAULT_HOSTING_COST);
    expect(providerPollCost({}, "render")).toBe(DEFAULT_HOSTING_COST);
  });

  it("runPartJob is total: a part removed since it was listed is a no-op", async () => {
    await setOrgEnvironments([oneEnv("live")], ORG_A);
    const log: string[] = [];
    await runPartJob(e, ORG_A, "live", "gone", AT_40, world().fetchImpl, { vercel: fakeVercel(log) });
    await runPartJob(e, "org_nowhere", "live", "web", AT_40, world().fetchImpl, { vercel: fakeVercel(log) });
    expect(log).toEqual([]);
  });
});

describe("Poll now — the hosting arm", () => {
  const noReconcile = async () => ({ written: 0, unchanged: 0, failed: [] });

  it("an org with no stored part gets exactly the result it always did — no `hosting` key", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const res = await runRepoRefresh(e, systemCtx(ORG_A), AT_40, world().fetchImpl, noReconcile, { vercel: fakeVercel([]) });
    expect(Object.keys(res)).toEqual(["health", "cloudflare", "railway", "sapling", "github"]);
  });

  it("with stored parts, one outcome per part — after usage, before GitHub", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await addPart(ORG_A, "staging", "web");
    await addPart(ORG_A, "production", "web");
    await connect(ORG_A, LONG_TOKEN);
    const log: string[] = [];
    const res = await runRepoRefresh(e, systemCtx(ORG_A), AT_40, world().fetchImpl, noReconcile, { vercel: fakeVercel(log) });
    expect(Object.keys(res)).toEqual(["health", "cloudflare", "railway", "sapling", "hosting", "github"]);
    expect(res.hosting).toEqual([
      { env: "staging", part: "web", provider: "vercel", status: "ok", written: 1 },
      { env: "production", part: "web", provider: "vercel", status: "ok", written: 1 },
    ]);
    expect(JSON.stringify(res)).not.toContain(LONG_TOKEN);
  });

  it("skipped part by part when the WHOLE refresh would not fit the 50 — GitHub keeps its reservation", async () => {
    await setOrgEnvironments(ENVS, ORG_A);                      // 19 + 7 × 2 = 33 before hosting
    await addPart(ORG_A, "staging", "web");
    await addPart(ORG_A, "production", "web");
    await connect(ORG_A, LONG_TOKEN);
    const parts = await listStoredParts(systemCtx(ORG_A));
    const log: string[] = [];
    // 2 × 9 = 18: 51 > 50 — skipped, nothing fetched for them.
    expect(hostingPollCost(parts, { vercel: fakeVercel([], 9) })).toBe(18);
    const w = world();
    const skipped = await runRepoRefresh(e, systemCtx(ORG_A), AT_40, w.fetchImpl, noReconcile, { vercel: fakeVercel(log, 9) });
    expect(skipped.hosting).toEqual(parts.map((p) => ({ env: p.env, part: p.key, provider: "vercel", status: "skipped", written: 0, detail: BUDGET_SKIP })));
    expect(log).toEqual([]);
    expect(w.polls()).toEqual([]);
    // 2 × 8 = 16: 49 fits.
    const fits = await runRepoRefresh(e, systemCtx(ORG_A), AT_40, world().fetchImpl, noReconcile, { vercel: fakeVercel(log, 8) });
    expect((fits.hosting as { status: string }[]).map((o) => o.status)).toEqual(["ok", "ok"]);
  });
});

describe("retention", () => {
  it("hx_* points go at 100 days with the hourly usage series; hosting_deploys at 180 days, in every org; poll state stays", async () => {
    const now = Date.parse("2026-09-20T12:30:00Z");
    const old = new Date(now - 101 * DAY).toISOString(), recent = new Date(now - 99 * DAY).toISOString();
    await setOrgEnvironments([oneEnv("live")], ORG_A);
    await putMetrics(systemCtx(ORG_A), [
      { metric: "hx_requests", env: "live", part: "web", value: 1, at: old },
      { metric: "hx_requests", env: "live", part: "web", value: 2, at: recent },
      { metric: "hx_cpu", env: "live", part: "api", value: 0.1, at: old },
    ]);
    const dep = (org: string, id: string, ageDays: number) => env.DB.prepare(
      `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, created_at, recorded_at, updated_at)
       VALUES (?, 'live', 'web', 'vercel', ?, 'ready', ?, ?, ?)`).bind(org, id, new Date(now - ageDays * DAY).toISOString(), "x", "x").run();
    await dep(ORG_A, "a_old", 181);
    await dep(ORG_A, "a_new", 179);
    await dep(ORG_B, "b_old", 200);
    await env.DB.prepare(`INSERT INTO hosting_poll_state (org_id, env, part, provider, polled_at, status) VALUES (?, 'live', 'web', 'vercel', ?, 'ok')`)
      .bind(ORG_A, new Date(now - 400 * DAY).toISOString()).run();
    await pruneRepoCapture(platformCtx("system"), now);
    expect(await all(env.DB, `SELECT metric, value FROM repo_metrics ORDER BY metric`)).toEqual([{ metric: "hx_requests", value: 2 }]);
    expect(await all(env.DB, `SELECT deploy_id FROM hosting_deploys ORDER BY deploy_id`)).toEqual([{ deploy_id: "a_new" }]);
    expect(await all(env.DB, `SELECT part FROM hosting_poll_state`)).toEqual([{ part: "web" }]);
  });
});
