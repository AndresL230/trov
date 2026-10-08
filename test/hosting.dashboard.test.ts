/**
 * The Repo dashboard's `providers` section (src/tools/repo.ts `projectProviders`) — every part of every
 * environment, provider-neutral, read back from what the polls stored: `hx_*` points, `hosting_deploys`,
 * `hosting_poll_state` — and, for the LEGACY Cloudflare frontend / Railway backend, from their own captures
 * (`cf_*` + `cf_polled`, `rw_*`, the GitHub deploy strips). D1 only; providers are FAKES (labels,
 * capabilities, console links) beside the real legacy descriptors.
 *
 * Never guess: a missing hour is zero only inside the covered interval, a figure is null when nothing is
 * known, a gauge only while it is current, a part never polled is `not_connected`.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { ProviderTrafficRange, RepoProviderPart } from "@shared/hosting";
import { ENVS } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { ingestRepoEvent } from "../src/consumer";
import { emptyRepoDashboard, getRepoDashboard } from "../src/tools/repo";
import { shapeRepoDashboard, PROVIDER_DEPLOY_VIEW_LIMIT } from "../src/tools/repo-agent";
import { putMetrics, putSnapshot } from "../src/repo/store";
import { PROVIDERS } from "../src/hosting/registry";
import type { HostingProvider } from "../src/hosting/types";
import type { RepoEnvConfig } from "../src/repo/config";
import type { RepoEvent } from "../src/repo/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-20T12:05:00Z");    // the last complete hour ends at 12:00
const t = (iso: string) => new Date(iso).toISOString();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function provider(id: HostingProvider["id"], label: string, metrics: HostingProvider["capabilities"]["metrics"], consoleUrl: HostingProvider["consoleUrl"]): HostingProvider {
  return {
    id, label, status: "available", summary: "", roles: ["web", "service"], apiHosts: [], docsUrl: "", credentialScope: "org",
    connectionMethods: [], orgConfigFields: [], partSettings: [], capabilities: { deploys: true, metrics }, planNote: null, pollCost: 1,
    consoleUrl, probe: async () => ({ ok: true, detail: "" }), poll: async () => { throw new Error("never polled here"); },
  };
}
/** Vercel reads NO traffic (no public usage API); Render reads everything; Netlify's console link throws. */
const FAKES = {
  ...PROVIDERS,
  vercel: provider("vercel", "Vercel", [], (part, config) => (config.team && part.settings.project_id ? `https://vercel.com/${config.team}/${part.settings.project_id}` : null)),
  render: provider("render", "Render", ["requests", "errors", "latency_p95_ms", "bandwidth_bytes", "cpu", "mem_mb"], (part) => `https://dashboard.render.com/${part.settings.service_id ?? ""}`),
  netlify: provider("netlify", "Netlify", [], () => { throw new Error("boom"); }),
};

/** Environments with NO legacy columns, so only stored parts exist. */
const bare = (key: string): RepoEnvConfig => ({ ...ENVS[0], key, label: key, worker: "", workerCheck: "", railwayEnv: "" });
const BARE = [bare("staging"), bare("production")];

async function addPart(orgId: string, envKey: string, key: string, provider: string, role: "web" | "service", settings: Record<string, string> = {}, position = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'test')`,
  ).bind(orgId, envKey, key, position, `${key} label`, role, provider, JSON.stringify(settings)).run();
}
async function pollState(orgId: string, envKey: string, part: string, provider: string,
  o: { status?: string; detail?: string | null; covered?: [string, string]; unavailable?: unknown[]; lastOk?: string | null } = {}): Promise<void> {
  const status = o.status ?? "ok";
  await env.DB.prepare(
    `INSERT INTO hosting_poll_state (org_id, env, part, provider, polled_at, status, detail, last_ok_at, covered_from, covered_to, unavailable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orgId, envKey, part, provider, ago(20 * 60_000), status, o.detail ?? null,
    o.lastOk !== undefined ? o.lastOk : status === "ok" ? ago(20 * 60_000) : null,
    o.covered?.[0] ?? null, o.covered?.[1] ?? null, JSON.stringify(o.unavailable ?? [])).run();
}
async function deployRow(orgId: string, envKey: string, part: string, provider: string, id: string, state: string, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, inspect_url, created_at, ready_at, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'production', 'abc1234', 'main', ?, 'jose-a', 'https://x.example', 'https://x.example/i', ?, NULL, ?, ?)`,
  ).bind(orgId, envKey, part, provider, id, state, `msg ${id}`, createdAt, createdAt, createdAt).run();
}
const hx = (metric: string, envKey: string, part: string, at: string, value: number, orgId = ORG_A) =>
  putMetrics(systemCtx(orgId), [{ metric: `hx_${metric}`, env: envKey, part, at: t(at), value }]);

async function section(envs: RepoEnvConfig[] = BARE, now = NOW, orgId = ORG_A) {
  return (await getRepoDashboard(systemCtx(orgId), "o/r", now, envs, FAKES)).providers;
}
async function parts(envs: RepoEnvConfig[] = BARE, now = NOW, orgId = ORG_A): Promise<RepoProviderPart[]> {
  const s = await section(envs, now, orgId);
  expect(s.status).not.toBe("not_connected");
  return s.status === "ok" ? s.data : [];
}
const partOf = async (key: string, envKey = "staging", envs: RepoEnvConfig[] = BARE, now = NOW) => {
  const s = await section(envs, now);
  if (s.status !== "ok") throw new Error(`section is ${s.status}`);
  return s.data.find((p) => p.part === key && p.env === envKey)!;
};
const strip = (r: ProviderTrafficRange) => ({ ...r, trend: r.trend.map((b) => [b.at.slice(5, 16), b.requests, b.errors]) });

describe("the providers section — which parts, and its own status", () => {
  it("no part (or no environment) → not_connected; the empty dashboard says the same", async () => {
    expect(emptyRepoDashboard("o/r", true).providers).toEqual({ status: "not_connected" });
    await setOrgEnvironments(BARE, ORG_A);
    expect(await section()).toEqual({ status: "not_connected" });
    await addPart(ORG_A, "staging", "web", "render", "web");
    expect(await section([])).toEqual({ status: "not_connected" });
    // A part that was never polled and has nothing: the section exists but nothing is ok → empty.
    expect(await section()).toEqual({ status: "empty" });
  });
});

describe("a stored WEB part — traffic", () => {
  it("sums real points, takes the LATEST latency, an error rate over real points, and zero-fills only inside the covered interval", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web", { service_id: "srv-1" });
    await pollState(ORG_A, "staging", "web", "render", { covered: [t("2026-09-20T06:00:00Z"), t("2026-09-20T12:00:00Z")] });
    await hx("requests", "staging", "web", "2026-09-20T07:00:00Z", 100);
    await hx("requests", "staging", "web", "2026-09-20T09:00:00Z", 50);
    await hx("requests", "staging", "web", "2026-09-20T11:00:00Z", 30);
    await hx("requests", "staging", "web", "2026-09-20T12:00:00Z", 999);        // the RUNNING hour: never counted
    await hx("errors", "staging", "web", "2026-09-20T09:00:00Z", 5);
    await hx("latency_p95_ms", "staging", "web", "2026-09-20T08:00:00Z", 200);
    await hx("latency_p95_ms", "staging", "web", "2026-09-20T11:00:00Z", 150);
    await hx("bandwidth_bytes", "staging", "web", "2026-09-20T11:00:00Z", 1000);
    const p = await partOf("web");
    expect(p).toMatchObject({
      env: "staging", env_label: "staging", part: "web", label: "web label", role: "web", provider: "render", provider_label: "Render",
      console_url: "https://dashboard.render.com/srv-1", resources: null, deploys: [], unavailable: [], status: "ok", tone: "warn",
      seen: { traffic: true, resources: false, deploys: false }, last_poll: { status: "ok", detail: null },
    });
    expect(strip(p.traffic!["24h"])).toEqual({
      requests: 180, errors: 5, error_rate: 2.78, latency_p95_ms: 150, bandwidth_bytes: 1000,
      // Dense from the covered interval's start (06:00) to the last complete hour; a quiet hour inside it is 0.
      trend: [["09-20T06:00", 0, 0], ["09-20T07:00", 100, 0], ["09-20T08:00", 0, 0], ["09-20T09:00", 50, 5], ["09-20T10:00", 0, 0], ["09-20T11:00", 30, 0]],
    });
    // The day buckets: the covered stretch began inside today's bucket, so no WHOLE day is drawn — the totals stand.
    expect(strip(p.traffic!["7d"])).toEqual({ requests: 180, errors: 5, error_rate: 2.78, latency_p95_ms: 150, bandwidth_bytes: 1000, trend: [] });
  });

  it("a HOLE — an earlier stretch, an outage, then the current interval: zeros only from the interval's start, totals from every real point", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web");
    await pollState(ORG_A, "staging", "web", "render", { covered: [t("2026-09-20T08:00:00Z"), t("2026-09-20T12:00:00Z")] });
    await hx("requests", "staging", "web", "2026-09-19T14:00:00Z", 10);
    await hx("requests", "staging", "web", "2026-09-19T15:00:00Z", 10);
    await hx("requests", "staging", "web", "2026-09-20T09:00:00Z", 7);
    const r = (await partOf("web")).traffic!["24h"];
    expect(r.requests).toBe(27);
    expect(r.trend.map((b) => [b.at.slice(11, 16), b.requests])).toEqual([["08:00", 0], ["09:00", 7], ["10:00", 0], ["11:00", 0]]);
  });

  it("coverage alone is a KNOWN zero for a stored part — but no error rate (0 of 0 is not a rate); a part never polled is unknown", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web");
    await addPart(ORG_A, "production", "web", "render", "web");
    await pollState(ORG_A, "staging", "web", "render", { covered: [t("2026-09-20T09:00:00Z"), t("2026-09-20T12:00:00Z")] });
    const [quiet, never] = await parts();
    expect(strip(quiet.traffic!["24h"])).toEqual({
      requests: 0, errors: 0, error_rate: null, latency_p95_ms: null, bandwidth_bytes: 0,
      trend: [["09-20T09:00", 0, 0], ["09-20T10:00", 0, 0], ["09-20T11:00", 0, 0]],
    });
    expect(quiet).toMatchObject({ status: "ok", tone: "neutral", seen: { traffic: false } });
    expect(never.traffic!["24h"]).toEqual({ requests: null, errors: null, error_rate: null, latency_p95_ms: null, bandwidth_bytes: null, trend: [] });
    expect(never).toMatchObject({ status: "not_connected", last_poll: null });
  });

  it("a metric the provider cannot read is never zero-filled: unknown, with its reason", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web");
    await pollState(ORG_A, "staging", "web", "render", {
      covered: [t("2026-09-20T09:00:00Z"), t("2026-09-20T12:00:00Z")],
      unavailable: [{ metric: "bandwidth_bytes", reason: "needs the Pro plan" }, { metric: "bogus", reason: "dropped" }],
    });
    const p = await partOf("web");
    expect(p.traffic!["24h"].bandwidth_bytes).toBeNull();
    expect(p.traffic!["24h"].requests).toBe(0);
    expect(p.unavailable).toEqual([{ metric: "bandwidth_bytes", reason: "needs the Pro plan" }]);
  });
});

describe("a stored part — deploys, Vercel's absent traffic, the console link", () => {
  it("newest first, at most 10, the last 90 days, the part's CURRENT provider only; traffic null when the provider reads none", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "vercel", "web", { project_id: "prj_1" });
    await env.DB.prepare(`INSERT INTO org_integration_config (org_id, kind, scope, config, updated_at, updated_by) VALUES (?, 'vercel', '', ?, 'x', 'test')`)
      .bind(ORG_A, JSON.stringify({ team: "acme" })).run();
    await pollState(ORG_A, "staging", "web", "vercel", { unavailable: [{ metric: "requests", reason: "Vercel has no public usage API" }] });
    for (let i = 0; i < 12; i++) await deployRow(ORG_A, "staging", "web", "vercel", `dpl_${i}`, i === 11 ? "building" : "ready", ago((12 - i) * HOUR));
    await deployRow(ORG_A, "staging", "web", "vercel", "dpl_ancient", "ready", ago(91 * DAY));
    await deployRow(ORG_A, "staging", "web", "netlify", "former_host", "ready", ago(30 * 60_000));
    const p = await partOf("web");
    expect(p.deploys.map((d) => d.id)).toEqual(["dpl_11", "dpl_10", "dpl_9", "dpl_8", "dpl_7", "dpl_6", "dpl_5", "dpl_4", "dpl_3", "dpl_2"]);
    expect(p.deploys[0]).toEqual({
      id: "dpl_11", state: "building", target: "production", sha: "abc1234", branch: "main", message: "msg dpl_11", by: "jose-a",
      at: ago(HOUR), ready_at: null, url: "https://x.example", inspect_url: "https://x.example/i",
    });
    expect(p).toMatchObject({
      traffic: null, resources: null, status: "ok", tone: "neutral",         // the newest deploy is still building
      console_url: "https://vercel.com/acme/prj_1", seen: { traffic: false, resources: false, deploys: true },
      unavailable: [{ metric: "requests", reason: "Vercel has no public usage API" }],
    });
  });

  it("a console link that throws, or is not https, is no link", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "netlify", "web");
    await deployRow(ORG_A, "staging", "web", "netlify", "d1", "ready", ago(HOUR));
    expect((await partOf("web")).console_url).toBeNull();
    const insecure = { ...FAKES, netlify: { ...FAKES.netlify, consoleUrl: () => "http://app.netlify.com/x" } };
    const s = (await getRepoDashboard(systemCtx(), "o/r", NOW, BARE, insecure)).providers;
    expect(s.status === "ok" && s.data[0].console_url).toBeNull();
  });
});

describe("a stored SERVICE part — resources", () => {
  it("the latest reading while ≤ 3 hours old; a 24-hour trend that is never zero-filled; stale → null, the trend stays", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "api", "render", "service");
    await pollState(ORG_A, "staging", "api", "render");
    await hx("cpu", "staging", "api", "2026-09-19T11:00:00Z", 0.9);       // over 24 hours old: not in the trend
    await hx("cpu", "staging", "api", "2026-09-20T09:00:00Z", 0.5);
    await hx("cpu", "staging", "api", "2026-09-20T11:00:00Z", 0.4);
    await hx("mem_mb", "staging", "api", "2026-09-20T11:00:00Z", 512);
    const p = await partOf("api");
    expect(p).toMatchObject({ role: "service", traffic: null, status: "ok", seen: { traffic: false, resources: true } });
    expect(p.resources).toEqual({
      cpu: 0.4, mem_mb: 512, at: "2026-09-20T11:00:00.000Z",
      trend: [{ at: "2026-09-20T09:00:00.000Z", cpu: 0.5, mem_mb: null }, { at: "2026-09-20T11:00:00.000Z", cpu: 0.4, mem_mb: 512 }],
    });
    // Three hours later the 11:00 reading is over 3 hours old: no current figure, an EMPTY part (it was polled).
    const later = (await getRepoDashboard(systemCtx(), "o/r", NOW + 3 * HOUR, BARE, FAKES)).providers;
    expect(later.status).toBe("empty");
  });
});

describe("the LEGACY parts — SaplingLearn's Cloudflare frontend and Railway backend, from their own captures", () => {
  const base = { raw: "{}", provenance: "webhook" as const };
  const deploy = (id: number, state: string, sha: string, at: string): RepoEvent =>
    ({ ...base, semantic_key: `gh:deploy:${id}:${state}`, kind: "deploy", number: id, env: "staging", part: "backend", sha, state, actor_login: "railway-app[bot]", occurred_at: at });
  const check = (id: number, state: string, sha: string, at: string): RepoEvent =>
    ({ ...base, semantic_key: `gh:check:${id}:completed`, kind: "check", number: id, name: "Workers Builds: frontend-staging", state, sha, ref: "main", env: "staging", part: "frontend", occurred_at: at });

  it("maps the cf_* series (with cf_polled coverage), the rw_* gauges and the GitHub deploy strips into provider parts", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await putSnapshot(systemCtx(), "cf_polled", { staging: { from: t("2026-09-20T08:00:00Z"), to: t("2026-09-20T11:00:00Z") } });
    await putMetrics(systemCtx(), [
      { metric: "cf_requests", env: "staging", part: "frontend", value: 400, at: t("2026-09-20T08:00:00Z") },
      { metric: "cf_errors", env: "staging", part: "frontend", value: 2, at: t("2026-09-20T08:00:00Z") },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 600, at: t("2026-09-20T10:00:00Z") },
      { metric: "rw_cpu", env: "staging", part: "backend", value: 0.12, at: t("2026-09-20T11:00:00Z") },
      { metric: "rw_mem_mb", env: "staging", part: "backend", value: 409.6, at: t("2026-09-20T11:00:00Z") },
    ]);
    await env.DB.prepare(`INSERT INTO org_integration_config (org_id, kind, scope, config, updated_at, updated_by) VALUES (?, 'cloudflare_analytics', '', ?, 'x', 'test')`)
      .bind(ORG_A, JSON.stringify({ account_id: "0123456789abcdef0123456789abcdef" })).run();
    for (const ev of [deploy(1, "success", "aaaaaaa1111", ago(3 * HOUR)), deploy(2, "failure", "bbbbbbb2222", ago(HOUR)), check(10, "success", "aaaaaaa1111", ago(2 * HOUR))]) {
      await ingestRepoEvent(systemCtx(), ev);
    }
    const all = await parts(ENVS);
    expect(all.map((p) => `${p.env}/${p.part}:${p.provider}:${p.role}:${p.status}`)).toEqual([
      "staging/frontend:cloudflare:web:ok", "staging/backend:railway:service:ok",
      "production/frontend:cloudflare:web:not_connected", "production/backend:railway:service:not_connected",
    ]);
    const [front, back] = all;
    expect(front).toMatchObject({
      label: "Frontend", provider_label: "Cloudflare Workers", unavailable: [], last_poll: null, tone: "good",
      console_url: "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/frontend-staging/production",
    });
    // Requests and errors only — Cloudflare's poll reads no latency or bandwidth.
    expect(strip(front.traffic!["24h"])).toEqual({
      requests: 1000, errors: 2, error_rate: 0.2, latency_p95_ms: null, bandwidth_bytes: null,
      trend: [["09-20T08:00", 400, 2], ["09-20T09:00", 0, 0], ["09-20T10:00", 600, 0]],
    });
    expect(front.deploys).toEqual([{
      id: `github:aaaaaaa@${ago(2 * HOUR)}`, state: "ready", target: null, sha: "aaaaaaa", branch: "main", message: null, by: null,
      at: ago(2 * HOUR), ready_at: ago(2 * HOUR), url: null, inspect_url: null,
    }]);
    expect(back).toMatchObject({ label: "Backend", provider_label: "Railway", console_url: null, traffic: null, tone: "bad" });   // its newest deploy failed
    expect(back.resources).toMatchObject({ cpu: 0.12, mem_mb: 409.6, at: "2026-09-20T11:00:00.000Z" });
    expect(back.deploys.map((d) => [d.state, d.sha, d.branch, d.by])).toEqual([["error", "bbbbbbb", null, "railway-app[bot]"], ["ready", "aaaaaaa", null, "railway-app[bot]"]]);
  });

  it("Cloudflare's marker alone is not a reading (a Worker it does not know answers with no rows too): requests unknown, the part `empty`", async () => {
    await setOrgEnvironments([ENVS[0]], ORG_A);
    await putSnapshot(systemCtx(), "cf_polled", { staging: { from: t("2026-09-20T08:00:00Z"), to: t("2026-09-20T11:00:00Z") } });
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, [ENVS[0]], FAKES)).providers).toEqual({ status: "empty" });
    // A sibling with something to show makes the section ok, so the legacy part's own state can be read.
    await addPart(ORG_A, "staging", "web", "render", "web");
    await deployRow(ORG_A, "staging", "web", "render", "anchor", "ready", ago(HOUR));
    const [front, back] = await parts([ENVS[0]]);
    expect(front).toMatchObject({ part: "frontend", status: "empty", seen: { traffic: false } });
    expect(front.traffic!["24h"]).toEqual({ requests: null, errors: null, error_rate: null, latency_p95_ms: null, bandwidth_bytes: null, trend: [] });
    expect(back).toMatchObject({ part: "backend", status: "not_connected" });
  });
});

describe("statuses and tones", () => {
  /** The staging part after `setupFn`. A production sibling with one ready deploy keeps the SECTION ok, so
   *  the staging part can be read whatever its own status is. */
  const one = async (setupFn: () => Promise<void>): Promise<RepoProviderPart> => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web");
    await addPart(ORG_A, "production", "web", "render", "web");
    await deployRow(ORG_A, "production", "web", "render", "anchor", "ready", ago(HOUR));
    await setupFn();
    return (await parts()).find((p) => p.env === "staging")!;
  };

  it("never polled → not_connected, neutral", async () => {
    expect((await one(async () => undefined))).toMatchObject({ status: "not_connected", tone: "neutral", last_poll: null });
  });
  it("a poll skipped as `not connected` never looked: still not_connected", async () => {
    const p = await one(() => pollState(ORG_A, "staging", "web", "render", { status: "skipped", detail: "not connected" }));
    expect(p).toMatchObject({ status: "not_connected", last_poll: { status: "skipped", detail: "not connected" } });
  });
  it("a failed poll is a connected part with nothing to show — empty, and warn", async () => {
    const p = await one(() => pollState(ORG_A, "staging", "web", "render", { status: "failed", detail: "render 401" }));
    expect(p).toMatchObject({ status: "empty", tone: "warn", last_poll: { status: "failed", detail: "render 401" } });
  });
  it("the newest deploy decides between bad / good / neutral; canceled is never a failure", async () => {
    expect((await one(() => deployRow(ORG_A, "staging", "web", "render", "d", "error", ago(HOUR)))).tone).toBe("bad");
  });
  it("…ready → good", async () => {
    expect((await one(() => deployRow(ORG_A, "staging", "web", "render", "d", "ready", ago(HOUR)))).tone).toBe("good");
  });
  it("…canceled newest → neutral", async () => {
    const p = await one(async () => {
      await deployRow(ORG_A, "staging", "web", "render", "d1", "error", ago(2 * HOUR));
      await deployRow(ORG_A, "staging", "web", "render", "d2", "canceled", ago(HOUR));
    });
    expect(p.tone).toBe("neutral");
  });
  it("a 24-hour error rate ≥ 5% is bad even beside a ready deploy", async () => {
    const p = await one(async () => {
      await deployRow(ORG_A, "staging", "web", "render", "d", "ready", ago(HOUR));
      await hx("requests", "staging", "web", "2026-09-20T10:00:00Z", 100);
      await hx("errors", "staging", "web", "2026-09-20T10:00:00Z", 6);
    });
    expect(p).toMatchObject({ tone: "bad", traffic: { "24h": { error_rate: 6 } } });
  });
  it("a poll state left by a DIFFERENT provider (the part was re-pointed) is not this part's", async () => {
    const p = await one(() => pollState(ORG_A, "staging", "web", "vercel", { status: "failed", detail: "vercel 401" }));
    expect(p).toMatchObject({ status: "not_connected", last_poll: null, tone: "neutral" });
  });
});

describe("a failed hosting read", () => {
  it("costs the providers section alone — not_connected, and the dashboard says it is degraded", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await putMetrics(systemCtx(), [{ metric: "rw_cpu", env: "staging", part: "backend", value: 0.12, at: t("2026-09-20T11:00:00Z") }]);
    // A database without the hosting tables yet (code deployed before its migration): the read throws.
    await env.DB.prepare(`ALTER TABLE hosting_poll_state RENAME TO hosting_poll_state_away`).run();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS, FAKES);
      expect(d.degraded).toBe(true);
      expect(d.providers).toEqual({ status: "not_connected" });
      expect(d.hosting.status).toBe("ok");               // every other section is read as before
      expect(JSON.stringify(spy.mock.calls)).toContain("org=org_saplinglearn");
    } finally {
      spy.mockRestore();
      await env.DB.prepare(`ALTER TABLE hosting_poll_state_away RENAME TO hosting_poll_state`).run();
    }
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS, FAKES)).degraded).toBe(false);
  });
});

describe("isolation", () => {
  it("another org's parts, points, deploys, poll state and settings never reach this org's projection", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await setOrgEnvironments(BARE, ORG_B);
    await addPart(ORG_A, "staging", "web", "vercel", "web", { project_id: "prj_a" });
    await addPart(ORG_B, "staging", "web", "vercel", "web", { project_id: "prj_b" });
    await addPart(ORG_B, "production", "api", "render", "service");
    await pollState(ORG_B, "staging", "web", "vercel", { status: "failed", detail: "b's failure" });
    await deployRow(ORG_B, "staging", "web", "vercel", "b_deploy", "ready", ago(HOUR));
    await hx("requests", "staging", "web", "2026-09-20T10:00:00Z", 5, ORG_B);
    await env.DB.prepare(`INSERT INTO org_integration_config (org_id, kind, scope, config, updated_at, updated_by) VALUES (?, 'vercel', '', ?, 'x', 'test')`)
      .bind(ORG_B, JSON.stringify({ team: "b-team" })).run();
    const s = await section();
    expect(s).toEqual({ status: "empty" });   // A's one part: never polled, nothing — and nothing of B's
    const json = JSON.stringify(await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, BARE, FAKES));
    for (const leak of ["b_deploy", "b's failure", "b-team", "prj_b", "\"api\""]) expect(json, leak).not.toContain(leak);
    // B's own projection has all of it.
    const b = await getRepoDashboard(systemCtx(ORG_B), "o/r", NOW, BARE, FAKES);
    expect(b.providers.status === "ok" && b.providers.data.map((p) => `${p.env}/${p.part}`)).toEqual(["staging/web", "production/api"]);
  });
});

describe("the MCP view (get_repo_dashboard)", () => {
  it("collapses each part's traffic to the asked range, drops every trend, and cuts the deploy strip to its newest few", async () => {
    await setOrgEnvironments(BARE, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web");
    await addPart(ORG_A, "staging", "api", "render", "service", {}, 1);
    await pollState(ORG_A, "staging", "web", "render", { covered: [t("2026-09-20T09:00:00Z"), t("2026-09-20T12:00:00Z")] });
    await hx("requests", "staging", "web", "2026-09-20T10:00:00Z", 40);
    await hx("cpu", "staging", "api", "2026-09-20T11:00:00Z", 0.3);
    for (let i = 0; i < 5; i++) await deployRow(ORG_A, "staging", "web", "render", `d${i}`, "ready", ago((5 - i) * HOUR));
    const dash = await getRepoDashboard(systemCtx(), "o/r", NOW, BARE, FAKES);
    const view = shapeRepoDashboard(dash, { tab: "usage", range: "24h" });
    const [web, api] = (view.sections.providers as { data: Record<string, unknown>[] }).data;
    expect(web.traffic).toEqual({ requests: 40, errors: 0, error_rate: 0, latency_p95_ms: null, bandwidth_bytes: 0 });
    expect(web.deployCount).toBe(5);
    expect((web.deploys as { id: string }[]).map((d) => d.id)).toEqual(["d4", "d3", "d2", "d1", "d0"].slice(0, PROVIDER_DEPLOY_VIEW_LIMIT));
    expect(api.traffic).toBeNull();
    expect(api.resources).toEqual({ cpu: 0.3, mem_mb: null, at: "2026-09-20T11:00:00.000Z" });
    expect(JSON.stringify(view)).not.toContain("\"trend\"");
    // include_trends: the full strip and every series.
    const full = shapeRepoDashboard(dash, { tab: "usage", range: "7d", includeTrends: true });
    const [webFull] = (full.sections.providers as { data: Record<string, unknown>[] }).data;
    expect((webFull.deploys as unknown[]).length).toBe(5);
    expect((webFull.traffic as { trend: unknown[] }).trend).toEqual([]);   // 7d: one partial day only
    expect(JSON.stringify(full)).toContain("\"trend\"");
    // A section that is not ok passes through untouched.
    expect(shapeRepoDashboard(emptyRepoDashboard("o/r", false), { tab: "usage" }).sections.providers).toEqual({ status: "not_connected" });
  });
});
