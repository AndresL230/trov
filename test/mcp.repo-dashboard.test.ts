/**
 * The MCP `get_repo_dashboard` tool — the Repo dashboard's READ, for every
 * bearer principal. Same projection the screen reads (`getRepoDashboard`, D1
 * only), reshaped for an agent's context by `src/tools/repo-agent.ts`: `tab`
 * narrows to one tab's sections (the screen's own mapping), `range` picks one
 * usage view, and trend arrays are stripped unless asked for.
 *
 * Driven over the REAL registered tool (in-memory transport, real Miniflare D1).
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCanopyMcpServer } from "../src/mcp";
import { putMetrics, putSnapshot } from "../src/repo/store";
import { emptyRepoDashboard } from "../src/tools/repo";
import { DRIFT_GROUP_LIMIT, shapeRepoDashboard, type RepoAgentView } from "../src/tools/repo-agent";
import { REPO_RANGES, REPO_TAB_SECTIONS, type RepoDashboard, type RepoDrift, type RepoRange, type RepoUsageEnv } from "@shared/repo";
import type { Env } from "../src/env";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALL_SECTIONS = Object.values(REPO_TAB_SECTIONS).flat();

// Obviously fake, distinct per secret, and long enough that a fragment check means something.
const SECRETS = {
  COOKIE_SECRET: `cookie-${LONG_TOKEN}`,
  GITHUB_CLIENT_SECRET: `ghcs-${LONG_TOKEN.split("").reverse().join("")}`,
  GITHUB_WEBHOOK_SECRET: "whsec-5f1c0e9a7b3d2468ace013579bdf2468",
  GITHUB_SERVICE_TOKEN: "ghs_FAKEfakeFAKEfake0123456789abcdefABCDEF",
  CF_ANALYTICS_TOKEN: "cfat_FAKE_9d8c7b6a5f4e3d2c1b0a99887766554433",
  CF_ANALYTICS_ACCOUNT_ID: "acct00ffee11dd22cc33bb44aa5566778899",
  RAILWAY_TOKEN_STAGING: "rwstg-1a2b3c4d-5e6f-7a8b-9c0d-e1f2a3b4c5d6",
  RAILWAY_TOKEN_PRODUCTION: "rwprd-6d5c4b3a-2f1e-0d9c-8b7a-6f5e4d3c2b1a",
  SAPLING_METRICS_TOKEN: `sap-${LONG_TOKEN.toUpperCase()}`,
  GEMINI_API_KEY: "AIzaFAKE_gemini_key_0123456789_abcdefghij",
  RESEND_API_KEY: "re_FAKE_resend_key_abcdefghijklmnop012345",
} as const;

const testEnv = (over: Partial<Record<keyof Env, unknown>> = {}): Env =>
  ({ ...(env as unknown as Env), ...SECRETS, ...over }) as Env;

async function withClient<T>(handle: string, e: Env, fn: (c: Client) => Promise<T>): Promise<T> {
  const server = buildCanopyMcpServer(e, { handle });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(args: Record<string, unknown> = {}, e: Env = testEnv(), handle = "beatrix"): Promise<{ text: string; isError?: boolean }> {
  return withClient(handle, e, async (client) => {
    const res = (await client.callTool({ name: "get_repo_dashboard", arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  });
}
const view = async (args: Record<string, unknown> = {}, e?: Env): Promise<RepoAgentView> => {
  const r = await call(args, e);
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.text) as RepoAgentView;
};
const okData = <T>(s: unknown): T => {
  expect((s as { status: string }).status).toBe("ok");
  return (s as { data: T }).data;
};
/** Every key named `trend` anywhere in a JSON value. */
function trendPaths(v: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => trendPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "trend") out.push(`${path}.${k}`);
      trendPaths(x, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Usage (Cloudflare + active users), product metrics, coverage and a drift
 *  snapshot — relative to the real clock, because the tool reads `Date.now()`.
 *  Hosting, branches, health, environments… are deliberately left uncaptured. */
async function seedDashboard(): Promise<void> {
  const hourFloor = Math.floor(Date.now() / HOUR) * HOUR;
  const midnight = Math.floor(Date.now() / DAY) * DAY;
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows: Parameters<typeof putMetrics>[1] = [];
  // 10 days of hourly Cloudflare points, ending at the last complete hour.
  for (let h = 1; h <= 10 * 24; h++) {
    rows.push({ metric: "cf_requests", env: "staging", part: "frontend", value: 100 + (h % 7), at: iso(hourFloor - h * HOUR) });
    rows.push({ metric: "cf_errors", env: "staging", part: "frontend", value: h % 3, at: iso(hourFloor - h * HOUR) });
  }
  for (const [w, n] of [["24h", 74], ["7d", 310], ["30d", 1204]] as const)
    rows.push({ metric: `active_users_${w}`, env: "staging", part: "", value: n, at: iso(hourFloor) });
  // Product: a current reading + five midnights (the trend), and a total.
  for (const at of [hourFloor, ...[0, 1, 2, 3, 4].map((d) => midnight - d * DAY)]) {
    rows.push({ metric: "sap_c_signups_24h", env: "staging", part: "", value: 3, at: iso(at) });
    rows.push({ metric: "sap_c_signups_7d", env: "staging", part: "", value: 21, at: iso(at) });
    rows.push({ metric: "sap_c_signups_30d", env: "staging", part: "", value: 96, at: iso(at) });
    rows.push({ metric: "sap_t_users", env: "staging", part: "", value: 1204, at: iso(at) });
  }
  for (const d of [12, 8, 4, 0]) rows.push({ metric: "coverage", env: "", part: "", value: 70 + d / 4, at: iso(hourFloor - d * DAY) });
  await putMetrics(env.DB, rows);

  const drift: RepoDrift = {
    head: "main", base: "production", ahead: 3, behind: 0,
    groups: [{
      tag: "#482", kind: "pr", title: "Add the thing", meta: "jose-a · 3 commits",
      commits: [1, 2, 3].map((n) => ({ sha: `abc000${n}`, msg: `commit ${n}`, at: iso(hourFloor - n * HOUR) })),
    }],
  };
  await putSnapshot(env.DB, "drift", drift);
}

describe("MCP get_repo_dashboard — registration", () => {
  it("is listed for a NON-admin principal, with the three optional inputs", async () => {
    const tools = await withClient("beatrix", testEnv(), async (c) => (await c.listTools()).tools);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("update_plan"); // beatrix really is non-admin
    expect(names).toContain("get_repo_dashboard");
    const tool = tools.find((t) => t.name === "get_repo_dashboard")!;
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(["include_trends", "range", "tab"]);
    expect(tool.inputSchema.required ?? []).toEqual([]);
    expect(tool.description).toMatch(/not_connected/);
    // …and the FIELD-level rule: a null inside an `ok` section is unknown too.
    expect(tool.description).toMatch(/null/);
    expect(tool.description).toMatch(/never zero/i);
    expect(tool.description).toMatch(/seen/);
    // …and what include_trends does to drift.
    expect(tool.description).toMatch(/groupCount/);
    expect(tool.description).toMatch(/every group/i);
  });

  it("exposes no repo WRITE or poll over MCP — not even to an admin", async () => {
    const names = await withClient("admin-user", testEnv(), async (c) => (await c.listTools()).tools.map((t) => t.name));
    expect(names).toContain("update_plan"); // admin-user really is admin
    expect(names.filter((n) => /repo|poll|sync|backfill|reconcile/i.test(n))).toEqual(["get_repo_dashboard"]);
  });
});

describe("MCP get_repo_dashboard — the default call", () => {
  it("returns the header and EVERY section, a 7d usage view, and no trend arrays", async () => {
    await seedDashboard();
    const v = await view();

    expect(v.repo).toBe("SaplingLearn/sapling");
    expect(v.degraded).toBe(false);
    expect(v.tab).toBe("all");
    expect(v.range).toBe("7d");
    expect(Number.isNaN(Date.parse(v.generatedAt))).toBe(false);
    expect(Object.keys(v).sort()).toEqual(["degraded", "generatedAt", "range", "repo", "sections", "tab"]);
    expect(Object.keys(v.sections).sort()).toEqual([...ALL_SECTIONS].sort());

    // usage: ONE range's environments (an array), not the three-range record.
    const usage = okData<RepoUsageEnv[]>(v.sections.usage);
    expect(Array.isArray(usage)).toBe(true);
    const staging = usage.find((u) => u.name === "staging")!;
    expect(staging.requests?.value).toBeTruthy();
    expect(staging.users?.value).toBe("310"); // the 7d gauge, not 24h's 74 or 30d's 1.2K
    expect(okData<unknown[]>(v.sections.cloudflare)).toBeInstanceOf(Array);

    // product: each count collapsed to the range's single figure.
    const product = okData<{ name: string; groups: { metrics: Record<string, unknown>[] }[]; totals: Record<string, unknown>[] }[]>(v.sections.product);
    const signups = product.find((p) => p.name === "staging")!.groups.flatMap((g) => g.metrics).find((m) => m.key === "signups")!;
    expect(signups).toMatchObject({ key: "signups", value: "21", raw: 21 });
    expect(signups).not.toHaveProperty("values");
    expect(product.find((p) => p.name === "staging")!.totals[0]).toMatchObject({ key: "users", raw: 1204 });

    // coverage keeps its figure, loses its sparkline.
    expect(okData<Record<string, unknown>>(v.sections.coverage)).toMatchObject({ value: expect.any(String), delta: expect.any(String) });
    expect(trendPaths(v)).toEqual([]);

    // drift keeps the headline and the groups; the per-commit breakdown becomes a count.
    const drift = okData<{ ahead: number; groups: Record<string, unknown>[] }>(v.sections.drift);
    expect(drift.ahead).toBe(3);
    expect(drift.groups[0]).toMatchObject({ tag: "#482", title: "Add the thing", commitCount: 3 });
    expect(drift.groups[0]).not.toHaveProperty("commits");
    expect(drift).toMatchObject({ groupCount: 1 });
  });

  it("drift: the default lists the first 20 groups and says how many there are; include_trends returns them all", async () => {
    const at = new Date().toISOString();
    const big: RepoDrift = {
      head: "main", base: "production", ahead: 120, behind: 0,
      groups: Array.from({ length: 120 }, (_, g) => ({
        tag: `#${600 - g}`, kind: "pr" as const, title: `Squash merge ${600 - g}`, meta: "jose-a · 1 commit",
        commits: [{ sha: `sha${g}`, msg: `Squash merge ${600 - g} (#${600 - g})`, at }],
      })),
    };
    await putSnapshot(env.DB, "drift", big);

    type DriftView = { ahead: number; groupCount: number; groups: { tag: string; commitCount: number; commits?: unknown[] }[] };
    const cut = okData<DriftView>((await view({ tab: "overview" })).sections.drift);
    expect(DRIFT_GROUP_LIMIT).toBe(20);
    expect(cut.ahead).toBe(120); // the header stays truthful…
    expect(cut.groupCount).toBe(120); // …and says the list below was cut
    expect(cut.groups.map((g) => g.tag)).toEqual(big.groups.slice(0, 20).map((g) => g.tag)); // the snapshot's own order
    expect(cut.groups.every((g) => g.commitCount === 1 && g.commits === undefined)).toBe(true);

    const full = okData<DriftView>((await view({ tab: "overview", include_trends: true })).sections.drift);
    expect(full.groupCount).toBe(120);
    expect(full.groups).toHaveLength(120);
    expect(full.groups.every((g) => g.commits?.length === 1)).toBe(true);
  });

  it("never coerces: not_connected stays not_connected, empty stays empty", async () => {
    await seedDashboard();
    const v = await view();
    for (const name of ["hosting", "branches", "health", "environments", "deploys", "ciFailures", "bundle", "todos"] as const)
      expect(v.sections[name], name).toEqual({ status: "not_connected" });
    expect(v.sections.sprint).toEqual({ status: "empty" });
    // …and on an untouched database nothing is invented either.
    for (const s of Object.values(v.sections)) expect(["ok", "empty", "not_connected"]).toContain((s as { status: string }).status);
  });

  it("prs: no open count before the prs_reconciled marker; the real one (here 0) after it", async () => {
    // Before the marker there is nothing to count off — the section is `empty`,
    // never an ok list claiming "0 open".
    expect((await view({ tab: "code" })).sections.prs).toEqual({ status: "empty" });
    await putSnapshot(env.DB, "prs_reconciled", { at: new Date().toISOString() });
    expect(okData<{ openCount: number | null; rows: unknown[] }>((await view({ tab: "code" })).sections.prs)).toEqual({ rows: [], openCount: 0 });
  });

  it("a cold database reads not_connected / empty throughout — never zeros", async () => {
    const v = await view({ tab: "usage" });
    for (const name of REPO_TAB_SECTIONS.usage) expect(v.sections[name]).toEqual({ status: "not_connected" });
  });
});

describe("MCP get_repo_dashboard — tab, range, include_trends", () => {
  it("tab returns exactly that tab's sections — the screen's own mapping", async () => {
    await seedDashboard();
    for (const tab of Object.keys(REPO_TAB_SECTIONS) as (keyof typeof REPO_TAB_SECTIONS)[]) {
      const v = await view({ tab });
      expect(v.tab).toBe(tab);
      expect(Object.keys(v.sections)).toEqual([...REPO_TAB_SECTIONS[tab]]);
    }
    expect(Object.keys((await view({ tab: "usage" })).sections)).toEqual(["usage", "cloudflare", "hosting", "product"]);
  });

  it("range picks that range's view", async () => {
    await seedDashboard();
    const figures: Record<string, { users: string; signups: string }> = {};
    for (const range of REPO_RANGES) {
      const v = await view({ tab: "usage", range });
      expect(v.range).toBe(range);
      const usage = okData<RepoUsageEnv[]>(v.sections.usage).find((u) => u.name === "staging")!;
      const product = okData<{ name: string; groups: { metrics: { key: string; value: string }[] }[] }[]>(v.sections.product);
      figures[range] = {
        users: usage.users!.value,
        signups: product.find((p) => p.name === "staging")!.groups.flatMap((g) => g.metrics).find((m) => m.key === "signups")!.value,
      };
    }
    expect(figures).toEqual({
      "24h": { users: "74", signups: "3" },
      "7d": { users: "310", signups: "21" },
      "30d": { users: "1.2K", signups: "96" },
    });
  });

  it("include_trends: true brings the arrays (and the drift commits) back", async () => {
    await seedDashboard();
    const v = await view({ include_trends: true });
    const paths = trendPaths(v);
    expect(paths.some((p) => p.startsWith("$.sections.usage"))).toBe(true);
    expect(paths.some((p) => p.startsWith("$.sections.product"))).toBe(true);
    expect(paths).toContain("$.sections.coverage.data.trend");

    const staging = okData<RepoUsageEnv[]>(v.sections.usage).find((u) => u.name === "staging")!;
    expect(staging.requests!.trend.length).toBeGreaterThan(1);
    const product = okData<{ name: string; groups: { metrics: { key: string; trend: number[] }[] }[] }[]>(v.sections.product);
    expect(product[0].groups[0].metrics[0].trend.length).toBeGreaterThanOrEqual(4);
    const drift = okData<{ groups: { commits: unknown[]; commitCount: number }[] }>(v.sections.drift);
    expect(drift.groups[0].commits).toHaveLength(3);
    expect(drift.groups[0].commitCount).toBe(3);
  });

  it("an invalid tab or range is a schema error, not a crash", async () => {
    for (const args of [{ tab: "deploys" }, { range: "90d" }, { include_trends: "yes" }]) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBeTruthy();
    }
    // …and the server is still fine afterwards.
    expect((await view()).degraded).toBe(false);
  });
});

describe("MCP get_repo_dashboard — never an MCP error, never a secret", () => {
  it("a projection throw yields the degraded empty payload, not an MCP error", async () => {
    const throwingDb = {
      prepare() { throw new Error("D1 is down"); },
      batch() { throw new Error("D1 is down"); },
    } as unknown as Env["DB"];
    const r = await call({ tab: "overview", range: "24h" }, testEnv({ DB: throwingDb }));
    expect(r.isError).toBeFalsy();
    const v = JSON.parse(r.text) as RepoAgentView;
    expect(v.degraded).toBe(true);
    expect(v.tab).toBe("overview");
    expect(v.range).toBe("24h");
    const empty = emptyRepoDashboard("SaplingLearn/sapling", true);
    for (const name of REPO_TAB_SECTIONS.overview) expect(v.sections[name]).toEqual(empty[name]);
    expect(r.text).not.toContain("D1 is down");
  });

  it("serializes no secret value — not even a fragment of one — and no internal config id", async () => {
    await seedDashboard();
    const NEVER_IN_DTO = ["railwayEnvironmentId", "railwayServiceId", "worker", "workerCheck", "railwayEnv"] as const;
    const DTO_WORDS = new Set(["frontend", "backend"]);
    const configured = JSON.parse((env as unknown as Env).REPO_ENVIRONMENTS ?? "[]") as Record<string, unknown>[];
    expect(configured.length).toBeGreaterThanOrEqual(2); // wrangler.toml's staging + production
    for (const args of [{}, { include_trends: true }, { tab: "usage", range: "30d" }]) {
      const { text } = await call(args);
      for (const [name, secret] of Object.entries(SECRETS)) {
        expect(text, name).not.toContain(secret);
        expect(leakedFragments(text, secret, 12), name).toEqual([]);
      }
      expect(text).not.toMatch(/canopy_mcp_|Bearer |Project-Access-Token/);
      // Config-derived: `repoEnvironments()` hands the projection the WHOLE parsed
      // entry, so these are one careless `...cfg` away from the DTO. Only key /
      // label / note / branch and the public URLs may travel.
      for (const cfg of configured) {
        for (const field of NEVER_IN_DTO) {
          const value = cfg[field];
          expect(typeof value, `${cfg.key}.${field} is configured`).toBe("string");
          // Production's Worker is literally named "frontend" — also the DTO's own
          // part name, so its absence proves nothing; every other value is distinctive.
          if (DTO_WORDS.has(value as string)) continue;
          expect(text, `${cfg.key}.${field}`).not.toContain(value as string);
        }
      }
    }
  });
});

// ── size discipline — the pure shaper over a worst-case-ish dashboard ─────────
function richDashboard(): RepoDashboard {
  const at = "2026-09-20T12:00:00.000Z";
  const trend = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i * 37);
  const person = (login: string) => ({ login, handle: login, name: `Person ${login}`, color: null });
  const metric = (value: string) => ({ value, trend: trend(30), tone: "neutral" as const });
  const usageEnv = (name: string): RepoUsageEnv => ({
    name, host: "Cloudflare", requests: metric("1.2M"), errorRate: metric("0.42%"), users: metric("1,204"),
    seen: { requests: true, users: true },
  });
  const byRange = <T>(f: (r: RepoRange) => T) => Object.fromEntries(REPO_RANGES.map((r) => [r, f(r)])) as Record<RepoRange, T>;
  const productEnv = (name: string) => ({
    name,
    groups: ["Growth", "Learning activity", "Community", "AI spend", "Reliability", "Other"].map((title, g) => ({
      id: title.toLowerCase(), title,
      metrics: Array.from({ length: 8 }, (_, i) => ({
        key: `metric_key_${g}_${i}`, label: `Metric label ${g}-${i}`,
        values: byRange(() => "12,345"), raw: byRange(() => 12_345), trend: trend(30), note: i === 0 ? "A lower bound — see the contract." : undefined,
      })),
    })),
    totals: Array.from({ length: 24 }, (_, i) => ({ key: `total_${i}`, label: `Total ${i}`, value: "98,765", raw: 98_765, trend: trend(30) })),
  });
  const ok = <T>(data: T) => ({ status: "ok" as const, data });
  return {
    repo: "SaplingLearn/sapling", generatedAt: at, degraded: false,
    environments: ok(["staging", "production"].map((key) => ({
      key, name: key, note: key, tone: "good" as const, pill: "HEALTHY", ci: "All 8 checks passing", ciTone: "good" as const, url: `https://${key}.example.com`,
      parts: (["backend", "frontend"] as const).map((part) => ({ part, host: part === "backend" ? "Railway" as const : "Cloudflare" as const, sha: "abc1234", deployedAt: at, deployedBy: "jose-a", result: "ok" as const })),
    }))),
    drift: ok({
      // The compare cap in a squash-merge repo: 250 commits = 250 PRs = 250 groups.
      head: "main", base: "production", ahead: 250, behind: 40,
      groups: Array.from({ length: 250 }, (_, g) => ({
        tag: `#${900 - g}`, kind: "pr" as const, title: `A pull request title of ordinary length, number ${g}`, meta: "jose-a · 1 commit",
        commits: [{ sha: `deadbeef${g}`, msg: `A pull request title of ordinary length, number ${g} (#${900 - g})`, at }],
      })),
    }),
    stats: ok(Array.from({ length: 4 }, (_, i) => ({ label: `Stat ${i}`, value: 12, delta: 3, tone: "neutral" as const }))),
    health: ok(Array.from({ length: 4 }, (_, i) => ({ env: `env ${i}`, url: "https://api.example.com/api/health", up: true, ms: 120 }))),
    codeStats: ok(Array.from({ length: 4 }, (_, i) => ({ label: `Code stat ${i}`, value: 40, sub: "+12 vs last week", tone: "neutral" as const }))),
    bars: ok({ title: "Commits", note: "last 14 days", days: Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(7 + i).padStart(2, "0")}`, count: i })) }),
    prs: ok({ openCount: 23, rows: Array.from({ length: 8 }, (_, i) => ({
      number: 480 + i, title: `A pull request title of ordinary length, number ${i}`, url: `https://github.com/SaplingLearn/sapling/pull/${480 + i}`,
      author: person("jose-a"), branch: `feat/some-branch-${i}`, state: "review" as const, checks: "pass" as const, at,
    })) }),
    branches: ok({ active: 12, stale: 3, head: "main", rows: Array.from({ length: 8 }, (_, i) => ({ name: `feat/branch-${i}`, at, ahead: 3, behind: 1, stale: false })) }),
    deploys: ok(["staging", "production"].flatMap((e) => (["backend", "frontend"] as const).map((part) => ({
      env: e, part, label: `${e} · ${part}`, deploys: Array.from({ length: 14 }, () => ({ sha: "abc1234", at, by: "jose-a", result: "ok" as const })),
    })))),
    ciFailures: ok({ rate: 4.2, trend: trend(7), total: 17, rows: Array.from({ length: 5 }, (_, i) => ({ workflow: "CI", branch: `feat/branch-${i}`, job: "e2e", at, url: "https://github.com/SaplingLearn/sapling/actions/runs/1" })) }),
    coverage: ok({ value: "81.2%", trend: trend(10), delta: "+1.4", tone: "good" as const, note: "over 30 days" }),
    bundle: ok({ value: "412 KB", trend: trend(10), delta: "-8", tone: "good" as const, note: "over 30 days" }),
    activity: ok(Array.from({ length: 20 }, (_, i) => ({ kind: "push" as const, actor: person("jose-a"), text: `pushed 3 commits to feat/branch-${i}`, url: "https://github.com/SaplingLearn/sapling/commit/abc", at }))),
    usage: ok(byRange(() => [usageEnv("staging"), usageEnv("production")])),
    cloudflare: ok(byRange(() => Array.from({ length: 6 }, (_, i) => ({ env: "staging", label: `Cloudflare row ${i}`, value: "12,345" })))),
    hosting: ok([{ env: "staging", cpu: "0.4 vCPU", memory: "512 MB" }, { env: "production", cpu: "1.1 vCPU", memory: "900 MB" }]),
    product: ok([productEnv("staging"), productEnv("production")]),
    sprint: ok({ id: 3, label: "Sprint 12", due: "2026-09-30", closed: 8, total: 14, pct: 57 }),
    contributors: ok(Array.from({ length: 8 }, (_, i) => ({ person: person(`person-${i}`), pushes: 9, merged: 3, reviews: null }))),
    labels: ok({ total: 40, rows: Array.from({ length: 6 }, (_, i) => ({ name: `label-${i}`, count: 6 })) }),
    todos: ok({ count: 132, delta: -4, since: "since Jun 22", trend: trend(10) }),
  };
}

describe("get_repo_dashboard — size discipline", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

  it("the default view of a rich dashboard (250 drift groups) stays under 40 KB; tab + range shrink it further", () => {
    const dash = richDashboard();
    const raw = bytes(dash);
    const withTrends = bytes(shapeRepoDashboard(dash, { includeTrends: true }));
    const compact = bytes(shapeRepoDashboard(dash, {}));
    const usageTab = bytes(shapeRepoDashboard(dash, { tab: "usage", range: "24h" }));
    const overviewTab = bytes(shapeRepoDashboard(dash, { tab: "overview" }));
    console.log(`get_repo_dashboard sizes (bytes) — raw DTO ${raw}, include_trends ${withTrends}, default ${compact}, tab:usage+range:24h ${usageTab}, tab:overview ${overviewTab}`);

    expect(compact).toBeLessThan(40_000);
    expect(compact).toBeLessThan(withTrends);
    expect(withTrends).toBeLessThan(raw); // one range instead of three
    expect(usageTab).toBeLessThan(compact);
    expect(overviewTab).toBeLessThan(compact);
    expect(usageTab).toBeLessThan(20_000);
    // Drift is on the overview tab: 250 groups must not make the narrowest call a big one.
    expect(overviewTab).toBeLessThan(10_000);
    const drift = shapeRepoDashboard(dash, { tab: "overview" }).sections.drift as { data: { groupCount: number; groups: unknown[] } };
    expect(drift.data.groupCount).toBe(250);
    expect(drift.data.groups).toHaveLength(DRIFT_GROUP_LIMIT);
    const all = shapeRepoDashboard(dash, { tab: "overview", includeTrends: true }).sections.drift as { data: { groupCount: number; groups: unknown[] } };
    expect(all.data.groups).toHaveLength(250);
  });

  it("carries prs.openCount and ciFailures.total through, a null openCount as null (never 0)", () => {
    const dash = richDashboard();
    const code = shapeRepoDashboard(dash, { tab: "code" }).sections.prs as { data: { openCount: number | null; rows: unknown[] } };
    expect(code.data.openCount).toBe(23);
    expect(code.data.rows).toHaveLength(8);
    const ci = shapeRepoDashboard(dash, { tab: "ci" }).sections.ciFailures as { data: { total: number; rows: unknown[]; trend?: unknown } };
    expect(ci.data).toMatchObject({ total: 17, rate: 4.2 });
    expect(ci.data.rows).toHaveLength(5);
    expect(ci.data.trend).toBeUndefined();

    const unknown = { ...dash, prs: { status: "ok" as const, data: { rows: [], openCount: null } } };
    const view = shapeRepoDashboard(unknown, { tab: "code" }).sections.prs as { data: { openCount: number | null } };
    expect(view.data.openCount).toBeNull();
    expect(JSON.parse(JSON.stringify(view)).data.openCount).toBeNull();
  });

  it("the shaper never mutates the projection it was given", () => {
    const dash = richDashboard();
    const before = JSON.stringify(dash);
    shapeRepoDashboard(dash, {});
    shapeRepoDashboard(dash, { tab: "usage", range: "30d", includeTrends: true });
    expect(JSON.stringify(dash)).toBe(before);
  });
});
