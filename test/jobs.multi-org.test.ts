/**
 * Multitenancy Phase 5b — the repo cron is PER ORG (canopy-multitenancy.md §8.3, §10.2).
 *
 * Two orgs, each with its own repo, its own environment (the SAME key in both, on purpose) and its
 * own stored credentials. Every unit must call its upstream with ITS credential and write only ITS
 * rows; one org's failing upstream must not stop the other; the rotation must resume from the cursor
 * and visit every unit; a suspended org and an org with nothing configured must cost nothing. The
 * fetch is stubbed at the Response level and records what each request carried; rows are asserted
 * in real D1.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first, run, nowIso } from "./helpers/db";
import { ORG_A, ORG_B, bearerCtx, ensureMember, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { app } from "../src/routes";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS, fakeGithub, leakedFragments } from "./helpers/repo";
import { setIntegrationConfig, setSecret } from "../src/data/secrets";
import { handleRepoCron, runReconcileJob, runUsagePolls, HEALTH_COST } from "../src/repo/cron";
import { newBudget, rotated, serveJob, type Unit } from "../src/repo/dispatch";
import { JobAccessError, readCursor } from "../src/platform/jobs";
import { runBackfill } from "../src/tools/backfill";
import type { RepoEnvConfig } from "../src/repo/config";

const e = env as unknown as Env;
const HOURLY = Date.parse("2026-09-20T12:00:00Z");
const QUIET = Date.parse("2026-09-20T12:40:00Z");     // health only
const PROGRESS = Date.parse("2026-09-20T12:10:00Z");
const RECONCILE = Date.parse("2026-09-20T12:20:00Z");
const CF_URL = "https://api.cloudflare.com/client/v4/graphql";
const RW_URL = "https://backboard.railway.com/graphql/v2";
const GH = "https://api.github.com/";

interface OrgFixture { org: string; tag: string; repo: string; cfg: RepoEnvConfig; secrets: Record<"gh" | "cf" | "rw" | "app", string>; account: string }
const fixture = (org: string, tag: string): OrgFixture => ({
  org, tag, repo: `${tag}-co/app`,
  cfg: {
    ...ENVS[0], key: "live", label: "live", branch: "main", worker: `${tag}-worker`,
    frontendUrl: `https://${tag}.example.test`, apiUrl: `https://api.${tag}.example.test`, healthPath: "/health",
    railwayEnvironmentId: `rw-env-${tag}`, railwayServiceId: `rw-svc-${tag}`,
  },
  secrets: {
    gh: `ghs_${tag}_${"0123456789abcdef".repeat(3)}`, cf: `cf_${tag}_${"fedcba9876543210".repeat(2)}`,
    rw: `rw_${tag}_${"13579bdf02468ace".repeat(2)}`, app: `app_${tag}_${"a1b2c3d4e5f60718".repeat(2)}`,
  },
  account: `acct-${tag}-7f3a91`,
});
const A = fixture(ORG_A, "alpha");
const B = fixture(ORG_B, "beta");
const everySecret = (f: OrgFixture): string[] => [...Object.values(f.secrets), f.account];

/** The org's repo, its one environment and all five kinds of credential — STORED, as an admin enters them. */
async function configure(f: OrgFixture): Promise<void> {
  const admin = f.org === ORG_A ? await tenantCtx("AndresL230") : await tenantCtx("bob", "admin", { orgId: f.org });
  await addOrgRepo(f.repo, f.org);
  await setOrgEnvironments([f.cfg], f.org);
  await setSecret(admin, "github_token", "", f.secrets.gh);
  await setSecret(admin, "cloudflare_analytics", "", f.secrets.cf);
  await setIntegrationConfig(admin, "cloudflare_analytics", "", { account_id: f.account });
  await setSecret(admin, "railway", "live", f.secrets.rw);
  await setSecret(admin, "metrics_endpoint", "live", f.secrets.app);
}

interface Seen { url: string; auth: string | null; rwToken: string | null; body: string }
/** Every upstream answers; `over` may replace an answer. Records what each request carried. */
function world(over: (s: Seen) => Response | undefined = () => undefined) {
  const seen: Seen[] = [];
  const gh = fakeGithub({ "/issues/1": { state: "closed" } });
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const s: Seen = { url: String(u), auth: headers.get("authorization"), rwToken: headers.get("project-access-token"), body: String(init?.body ?? "") };
    seen.push(s);
    const custom = over(s);
    if (custom) return custom;
    // The org image's import rides the reconcile unit (src/orgs/logo.ts): the repo owner's profile, then its avatar.
    if (s.url.startsWith(`${GH}users/`)) return Response.json({ login: s.url.slice(`${GH}users/`.length), avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" });
    if (s.url.startsWith("https://avatars.githubusercontent.com/")) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    if (s.url.startsWith(GH)) return gh.fetchImpl(u, init);
    if (s.url === CF_URL) return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
      { dimensions: { datetimeHour: "2026-09-20T10:00:00Z" }, sum: { requests: 640, errors: 3 } },
    ] }] } } }), { status: 200 });
    if (s.url === RW_URL) return new Response(JSON.stringify({ data: { metrics: [
      { measurement: "CPU_USAGE", values: [{ ts: Date.parse("2026-09-20T11:00:00Z") / 1000, value: 0.12 }] },
      { measurement: "MEMORY_USAGE_GB", values: [{ ts: Date.parse("2026-09-20T11:00:00Z") / 1000, value: 0.4 }] },
    ] } }), { status: 200 });
    if (s.url.endsWith("/api/internal/metrics")) return new Response(JSON.stringify({ active_users: { "24h": 7, "7d": 30, "30d": 30 } }), { status: 200 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** Runs `fn` with every console channel captured; returns what was logged, flattened. */
async function captured<T>(fn: () => Promise<T>): Promise<{ out: T; logged: string; lines: number }> {
  const spies = (["error", "warn", "log", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  try {
    const out = await fn();
    const calls = spies.flatMap((s) => s.mock.calls);
    return { out, lines: calls.length, logged: JSON.stringify(calls.map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a)))) };
  } finally { for (const s of spies) s.mockRestore(); }
}

const metricsOf = (org: string) => all<{ metric: string; env: string }>(env.DB, `SELECT metric, env FROM repo_metrics WHERE org_id = ? ORDER BY metric`, org);
const metricOrgs = async () => (await all<{ org_id: string }>(env.DB, `SELECT DISTINCT org_id FROM repo_metrics ORDER BY org_id`)).map((r) => r.org_id);
const secretRows = (org: string) => all<{ kind: string; scope: string; last_used_at: string | null; last_error: string | null }>(env.DB,
  `SELECT kind, scope, last_used_at, last_error FROM org_secrets WHERE org_id = ? ORDER BY kind, scope`, org);

describe("the hourly tick, two orgs", () => {
  it("each (org, environment) unit calls its upstream with ITS credential and writes only ITS rows", async () => {
    await configure(A);
    await configure(B);
    const w = world();
    const { lines } = await captured(() => handleRepoCron(e, HOURLY, w.fetchImpl));
    expect(lines).toBe(0); // a healthy tick logs nothing

    for (const f of [A, B]) {
      const other = f === A ? B : A;
      const mine = w.seen.filter((s) => s.url.includes(`${f.tag}.example.test`) || s.body.includes(`${f.tag}-worker`) || s.body.includes(`rw-env-${f.tag}`));
      expect(mine).toHaveLength(5); // 2 health pings + Cloudflare + Railway + the app's metrics
      const cf = mine.find((s) => s.url === CF_URL)!;
      expect(cf.auth).toBe(`Bearer ${f.secrets.cf}`);
      expect((JSON.parse(cf.body) as { variables: { a: string } }).variables.a).toBe(f.account);
      expect(mine.find((s) => s.url === RW_URL)!.rwToken).toBe(f.secrets.rw);
      expect(mine.find((s) => s.url.endsWith("/api/internal/metrics"))!.auth).toBe(`Bearer ${f.secrets.app}`);
      // …and never the other org's — in any header or body of any of its requests.
      for (const s of mine) for (const secret of everySecret(other)) expect(JSON.stringify(s)).not.toContain(secret);

      const rows = await metricsOf(f.org);
      expect(rows.map((r) => r.metric)).toEqual([
        "active_users_24h", "active_users_30d", "active_users_7d", "cf_errors", "cf_requests",
        "health_ms", "health_ms", "health_up", "health_up", "rw_cpu", "rw_mem_mb",
      ]);
      expect(new Set(rows.map((r) => r.env))).toEqual(new Set(["live"]));
      // The Integrations screen: every credential that was used says so, and none carries an error.
      const used = (await secretRows(f.org)).filter((r) => r.kind !== "github_token");
      expect(used.map((r) => [r.kind, r.scope])).toEqual([["cloudflare_analytics", ""], ["metrics_endpoint", "live"], ["railway", "live"]]);
      for (const r of used) { expect(r.last_used_at, r.kind).not.toBeNull(); expect(r.last_error, r.kind).toBeNull(); }
    }
    expect(w.seen).toHaveLength(10);
    expect(await metricOrgs()).toEqual([ORG_B, ORG_A]);
    expect(await all(env.DB, `SELECT org_id FROM repo_snapshots ORDER BY org_id`)).toEqual([{ org_id: ORG_B }, { org_id: ORG_A }]); // each org's own cf_polled
  });

  it("one org's upstreams failing — each echoing its request back — never stops the other, and no credential reaches a log line or a last_error", async () => {
    await configure(A);
    await configure(B);
    // ORG_B sorts first, so its three failures happen BEFORE SaplingLearn's units are served.
    const w = world((s) => {
      const beta = s.url.includes("beta.example.test") || s.body.includes("beta-worker") || s.body.includes("rw-env-beta");
      if (!beta || s.url === B.cfg.frontendUrl) return undefined;
      const echo = `denied authorization=${s.auth} project-access-token=${s.rwToken} body=${s.body}`;
      if (s.url === RW_URL) throw new Error(`connect failed: ${echo}`);
      return new Response(JSON.stringify({ message: echo, errors: [{ message: echo }] }), { status: s.url === CF_URL ? 403 : 500 });
    });
    const { logged } = await captured(() => handleRepoCron(e, HOURLY, w.fetchImpl));

    // SaplingLearn's tick is whole.
    expect((await metricsOf(ORG_A)).map((r) => r.metric)).toEqual([
      "active_users_24h", "active_users_30d", "active_users_7d", "cf_errors", "cf_requests",
      "health_ms", "health_ms", "health_up", "health_up", "rw_cpu", "rw_mem_mb",
    ]);
    for (const r of await secretRows(ORG_A)) expect(r.last_error, r.kind).toBeNull();
    // The failing org wrote its health readings and nothing else…
    expect([...new Set((await metricsOf(ORG_B)).map((r) => r.metric))]).toEqual(["health_ms", "health_up"]);
    // …and each failure is recorded on ITS integration row, scrubbed.
    const failed = (await secretRows(ORG_B)).filter((r) => r.kind !== "github_token");
    expect(failed).toHaveLength(3);
    for (const r of failed) {
      expect(r.last_error, r.kind).toBeTruthy();
      for (const secret of [...everySecret(A), ...everySecret(B)]) expect(r.last_error, r.kind).not.toContain(secret);
    }
    expect(failed.find((r) => r.kind === "railway")!.last_error).toContain("[redacted]");
    // The failures WERE logged — with the org's id on nothing but the dispatcher's own lines, and no secret anywhere.
    expect(logged).toContain("pollRailway");
    expect(logged).toContain("[redacted]");
    for (const secret of [...everySecret(A), ...everySecret(B)]) {
      expect(logged).not.toContain(secret);
      expect(leakedFragments(logged, secret, 12)).toEqual([]);
    }
  });

  it("a SUSPENDED org is skipped entirely; lifting the suspension brings it back", async () => {
    await configure(A);
    await configure(B);
    await run(env.DB, `UPDATE orgs SET suspended_at = ?, suspended_by = 'AndresL230' WHERE id = ?`, nowIso(), ORG_B);
    const w = world();
    await handleRepoCron(e, HOURLY, w.fetchImpl);
    expect(w.seen).toHaveLength(5);
    expect(w.seen.some((s) => JSON.stringify(s).includes("beta"))).toBe(false);
    expect(await metricOrgs()).toEqual([ORG_A]);

    await run(env.DB, `UPDATE orgs SET suspended_at = NULL, suspended_by = NULL WHERE id = ?`, ORG_B);
    await handleRepoCron(e, HOURLY + 3_600_000, w.fetchImpl);
    expect(await metricOrgs()).toEqual([ORG_B, ORG_A]);
  });
});

describe("an org with nothing configured", () => {
  const TICKS = [QUIET, HOURLY, PROGRESS, RECONCILE];

  it("no repo, no environment, no credential: no request, no row, no log line, no cursor write — on every kind of tick", async () => {
    const before = await all(env.DB, `SELECT job, last_key, updated_at FROM cron_cursor ORDER BY job`);
    for (const tick of TICKS) {
      const w = world();
      const { lines } = await captured(() => handleRepoCron(e, tick, w.fetchImpl));
      expect(w.seen, new Date(tick).toISOString()).toEqual([]);
      expect(lines, new Date(tick).toISOString()).toBe(0);
    }
    expect(await all(env.DB, `SELECT 1 FROM repo_metrics`)).toEqual([]);
    expect(await all(env.DB, `SELECT 1 FROM repo_snapshots`)).toEqual([]);
    expect(await all(env.DB, `SELECT job, last_key, updated_at FROM cron_cursor ORDER BY job`)).toEqual(before);
  });

  it("a repo and an environment but no credential and no URLs yet: still no request and no log line", async () => {
    await addOrgRepo(B.repo, ORG_B);
    await setOrgEnvironments([{ ...B.cfg, frontendUrl: "", apiUrl: "" }], ORG_B);
    for (const tick of TICKS) {
      const w = world();
      const { lines } = await captured(() => handleRepoCron(e, tick, w.fetchImpl));
      expect(w.seen, new Date(tick).toISOString()).toEqual([]);
      expect(lines, new Date(tick).toISOString()).toBe(0);
    }
    expect(await all(env.DB, `SELECT 1 FROM repo_metrics`)).toEqual([]); // an unconfigured target is unknown, never "down"
  });

  it("the legacy Worker secrets answer for SaplingLearn ONLY — another org with the same environment key gets none of them", async () => {
    const legacy = {
      ...e, GITHUB_SERVICE_TOKEN: "legacy-github-token-000000", CF_ANALYTICS_TOKEN: "legacy-cf-token-0000000", CF_ANALYTICS_ACCOUNT_ID: "legacy-account",
      RAILWAY_TOKEN_LIVE: "legacy-railway-live-00000", SAPLING_METRICS_TOKEN: "legacy-metrics-token-000",
    } as unknown as Env;
    for (const f of [A, B]) { await addOrgRepo(f.repo, f.org); await setOrgEnvironments([f.cfg], f.org); }
    const w = world();
    await handleRepoCron(legacy, HOURLY, w.fetchImpl);
    await handleRepoCron(legacy, RECONCILE, w.fetchImpl);
    const beta = w.seen.filter((s) => JSON.stringify(s).includes("beta"));
    expect(beta.map((s) => s.url).sort()).toEqual([B.cfg.apiUrl + "/health", B.cfg.apiUrl + "/health", B.cfg.frontendUrl, B.cfg.frontendUrl]); // its health pings, twice
    for (const s of beta) { expect(s.auth).toBeNull(); expect(s.rwToken).toBeNull(); }
    // SaplingLearn polled and reconciled on the fallback, as it does in production today.
    expect(w.seen.find((s) => s.url === RW_URL)!.rwToken).toBe("legacy-railway-live-00000");
    expect(w.seen.some((s) => s.url.startsWith(`${GH}repos/${A.repo}`) && s.auth === "Bearer legacy-github-token-000000")).toBe(true);
    expect(w.seen.some((s) => s.url.startsWith(`${GH}repos/${B.repo}`))).toBe(false);
  });
});

describe("the 6-hourly GitHub jobs, two orgs", () => {
  const sprint = (org: string) => run(env.DB,
    `INSERT INTO sprints (org_id, title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, '2026-10-01', 'in_progress', '[1]', ?, 'andres')`, org, `M ${org}`, nowIso());

  it(":20 reconciles each org's OWN repo with its OWN token, into its own rows", async () => {
    await configure(A);
    await configure(B);
    const w = world();
    await handleRepoCron(e, RECONCILE, w.fetchImpl);
    for (const f of [A, B]) {
      const mine = w.seen.filter((s) => s.url.startsWith(`${GH}repos/${f.repo}`));
      expect(mine.length).toBeGreaterThan(5);
      for (const s of mine) expect(s.auth).toBe(`Bearer ${f.secrets.gh}`);
      const kinds = (await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_snapshots WHERE org_id = ? ORDER BY kind`, f.org)).map((r) => r.kind);
      expect(kinds).toEqual(expect.arrayContaining(["branches", "prs_reconciled"]));
      expect((await secretRows(f.org)).find((r) => r.kind === "github_token")).toMatchObject({ last_error: null });
      expect((await secretRows(f.org)).find((r) => r.kind === "github_token")!.last_used_at).not.toBeNull();
    }
    // GraphQL calls name the repo in their variables; none carries the other org's token.
    for (const s of w.seen.filter((x) => x.url === `${GH}graphql`)) {
      const f = s.body.includes("alpha-co") ? A : B;
      expect(s.auth).toBe(`Bearer ${f.secrets.gh}`);
    }
  });

  it(":10 recomputes each org's sprint progress from its own repo; a repo that cannot be reached costs only that org", async () => {
    await configure(A);
    await configure(B);
    await sprint(ORG_A);
    await sprint(ORG_B);
    const w = world((s) => { if (s.url.startsWith(`${GH}repos/${B.repo}`)) throw new Error(`unreachable, sent ${s.auth}`); return undefined; });
    const { logged } = await captured(() => handleRepoCron(e, PROGRESS, w.fetchImpl));
    expect(w.seen.some((s) => s.url.startsWith(`${GH}repos/${B.repo}`) && s.auth === `Bearer ${B.secrets.gh}`)).toBe(true);
    expect(w.seen.some((s) => s.url.startsWith(`${GH}repos/${A.repo}`) && s.auth === `Bearer ${A.secrets.gh}`)).toBe(true);
    expect(logged).not.toContain(B.secrets.gh);
    expect(await all(env.DB, `SELECT org_id FROM sprint_progress`)).toEqual([{ org_id: ORG_A }]);
  });

  it("a GitHub that echoes every request back: the failing org's token reaches no log line and no last_error, and the other org reconciles", async () => {
    await configure(A);
    await configure(B);
    const w = world((s) => {
      if (!s.url.startsWith(GH) || !(s.url.includes(B.repo) || s.body.includes("beta-co"))) return undefined;
      const echo = `denied authorization=${s.auth} body=${s.body}`;
      if (s.url.endsWith("/graphql")) return new Response(JSON.stringify({ errors: [{ message: echo }] }), { status: 200 });
      throw new Error(`request failed: ${echo}`);
    });
    const { logged } = await captured(() => handleRepoCron(e, RECONCILE, w.fetchImpl));
    expect(logged).toContain("reconcileRepo");
    expect(logged).toContain(`org=${ORG_B}`);
    for (const secret of [...everySecret(A), ...everySecret(B)]) {
      expect(logged).not.toContain(secret);
      expect(leakedFragments(logged, secret, 12)).toEqual([]);
    }
    const row = (await secretRows(ORG_B)).find((r) => r.kind === "github_token")!;
    expect(row.last_error).toMatch(/^reconcile: arms failed: [a-z_, ]+$/); // arm NAMES — nothing an upstream wrote
    expect((await secretRows(ORG_A)).find((r) => r.kind === "github_token")).toMatchObject({ last_error: null });
    expect((await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_snapshots WHERE org_id = ?`, ORG_A)).map((r) => r.kind)).toContain("prs_reconciled");
    expect((await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_snapshots WHERE org_id = ?`, ORG_B)).map((r) => r.kind)).not.toContain("prs_reconciled");
  });

  it("an org with a repo but no token is skipped without a word", async () => {
    await configure(A);
    await addOrgRepo(B.repo, ORG_B);
    const w = world();
    const { lines } = await captured(() => handleRepoCron(e, RECONCILE, w.fetchImpl));
    expect(lines).toBe(0);
    expect(w.seen.some((s) => s.url.includes(B.repo))).toBe(false);
    expect(await all(env.DB, `SELECT 1 FROM repo_snapshots WHERE org_id = ?`, ORG_B)).toEqual([]);
  });
});

describe("rotation", () => {
  const unit = (key: string, cost = 2): Unit => ({ key, orgId: key.split("/")[0], cost });

  it("rotated() starts after the cursor, wraps, and restarts from the top when the cursor's unit is gone", () => {
    const units = ["a/1", "a/2", "b/1", "c/1"].map((k) => unit(k));
    const keys = (last: string) => rotated(units, last).map((u) => u.key);
    expect(keys("")).toEqual(["a/1", "a/2", "b/1", "c/1"]);
    expect(keys("a/2")).toEqual(["b/1", "c/1", "a/1", "a/2"]);
    expect(keys("c/1")).toEqual(["a/1", "a/2", "b/1", "c/1"]);
    expect(keys("gone/9")).toEqual(["a/1", "a/2", "b/1", "c/1"]);
  });

  it("serveJob stops at the budget, stores the cursor, resumes after it, and clears it once everything was served", async () => {
    const p = platformCtx("system");
    const units = ["a/1", "a/2", "b/1", "c/1", "c/2"].map((k) => unit(k));
    const ran: string[][] = [];
    const tick = async (limit: number) => {
      const budget = newBudget((async () => new Response("ok")) as typeof fetch, limit);
      const mine: string[] = [];
      ran.push(mine);
      return captured(() => serveJob(p, "health", units, budget, limit, async (u) => { mine.push(u.key); await budget.fetch("https://x.test/1"); await budget.fetch("https://x.test/2"); }));
    };
    expect((await tick(4)).out).toEqual({ served: ["a/1", "a/2"], deferred: 3 });
    expect(await readCursor(p, "health")).toBe("a/2");
    expect((await tick(4)).out.served).toEqual(["b/1", "c/1"]);
    expect(await readCursor(p, "health")).toBe("c/1");
    expect((await tick(4)).out.served).toEqual(["c/2", "a/1"]); // wraps: nobody waits more than one lap
    expect(await readCursor(p, "health")).toBe("a/1");
    // Every unit was visited within three ticks, none starved.
    expect(new Set(ran.flat())).toEqual(new Set(units.map((u) => u.key)));
    // A budget that fits them all serves them all and clears the cursor.
    expect((await tick(100)).out).toEqual({ served: ["a/2", "b/1", "c/1", "c/2", "a/1"], deferred: 0 });
    expect(await readCursor(p, "health")).toBe("");
  });

  it("a unit that throws is logged by NAME and org id only, and the next unit still runs", async () => {
    const p = platformCtx("system");
    const ran: string[] = [];
    const { out, logged } = await captured(() => serveJob(p, "usage", [unit("org_x/a"), unit("org_y/a")], newBudget(), 100, async (u) => {
      ran.push(u.key);
      if (u.orgId === "org_x") throw new TypeError("boom with tok_supersecret_value_0000");
    }));
    expect(ran).toEqual(["org_x/a", "org_y/a"]);
    expect(out.deferred).toBe(0);
    expect(logged).toContain("org=org_x");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("tok_supersecret_value_0000");
  });

  it("through the cron: with a budget of two units per tick, three ticks ping every environment of every org", async () => {
    await setOrgEnvironments(["one", "two", "three"].map((key) => ({ ...A.cfg, key, frontendUrl: `https://${key}.alpha.example.test`, apiUrl: `https://${key}.alpha.example.test` })), ORG_A);
    await setOrgEnvironments(["one", "two"].map((key) => ({ ...B.cfg, key, frontendUrl: `https://${key}.beta.example.test`, apiUrl: `https://${key}.beta.example.test` })), ORG_B);
    const pinged: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const w = world();
      await captured(() => handleRepoCron(e, QUIET - 600_000 + i * 600_000, w.fetchImpl, 2 * HEALTH_COST)); // :30, :40, :50 — no heavy job
      expect(w.seen).toHaveLength(4); // two units, two pings each
      pinged.push([...new Set(w.seen.map((s) => new URL(s.url).host))]);
    }
    expect(pinged).toEqual([
      ["one.beta.example.test", "two.beta.example.test"],
      ["one.alpha.example.test", "two.alpha.example.test"],
      ["three.alpha.example.test", "one.beta.example.test"],
    ]);
    expect(await readCursor(platformCtx("system"), "health")).toBe(`${ORG_B}/one`);
    // Each tick wrote its own readings, for its own org.
    const rows = await all<{ org_id: string; env: string }>(env.DB, `SELECT DISTINCT at, org_id, env FROM repo_metrics WHERE metric = 'health_up' ORDER BY at, org_id, env`)
      .then((r) => r.map(({ org_id, env: key }) => ({ org_id, env: key })));
    expect(rows).toEqual([
      { org_id: ORG_B, env: "one" }, { org_id: ORG_B, env: "two" },
      { org_id: ORG_A, env: "one" }, { org_id: ORG_A, env: "two" },
      { org_id: ORG_B, env: "one" }, { org_id: ORG_A, env: "three" },
    ]);
  });

  it("on an hourly tick health may use only HALF the budget, so the usage polls are never starved", async () => {
    await configure(A);
    await configure(B);
    const w = world();
    // 10 = the whole tick for two units (2 × (2 + 3)); health's half (5) fits both of its units' 2 + 2.
    await captured(() => handleRepoCron(e, HOURLY, w.fetchImpl, 10));
    expect(w.seen).toHaveLength(10);
    // 6: health's half is 3 — ONE unit (2) — and the usage job still gets a unit (3) of the rest.
    const tight = world();
    await captured(() => handleRepoCron(e, HOURLY + 3_600_000, tight.fetchImpl, 6));
    expect(tight.seen.map((s) => s.url)).toEqual([B.cfg.frontendUrl, B.cfg.apiUrl + "/health", CF_URL, RW_URL, B.cfg.apiUrl + "/api/internal/metrics"]);
    expect(await readCursor(platformCtx("system"), "health")).toBe(`${ORG_B}/live`);
    expect(await readCursor(platformCtx("system"), "usage")).toBe(`${ORG_B}/live`);
  });
});

describe("on demand, for the caller's org", () => {
  it("Poll usage now, Sync GitHub and the reconcile run for the CALLER's org — with its credentials, into its rows", async () => {
    await configure(A);
    await configure(B);
    const bob = await tenantCtx("bob", "admin", { orgId: ORG_B });
    const w = world();
    expect(await runUsagePolls(e, bob, HOURLY, w.fetchImpl)).toEqual({
      cloudflare: [{ env: "live", status: "ok", written: 2 }], railway: [{ env: "live", status: "ok", written: 2 }], sapling: [{ env: "live", status: "ok", written: 3 }],
    });
    expect(await runReconcileJob(e, bob, HOURLY, { fetchImpl: w.fetchImpl })).toMatchObject({ failed: [] });
    const sync = await runBackfill(e, bob, "bob", { fetchImpl: w.fetchImpl, summarizer: null, issueSummarizer: null });
    expect(sync.ok).toBe(true);
    for (const s of w.seen) for (const secret of everySecret(A)) expect(JSON.stringify(s)).not.toContain(secret);
    expect(w.seen.some((s) => s.url.includes(A.repo) || s.url.includes("alpha"))).toBe(false);
    expect(w.seen.filter((s) => s.url.startsWith(GH) && !s.url.endsWith("/graphql")).every((s) => s.url.startsWith(`${GH}repos/${B.repo}`))).toBe(true);
    expect(await metricOrgs()).toEqual([ORG_B]);
    expect(await all(env.DB, `SELECT 1 FROM repo_snapshots WHERE org_id = ?`, ORG_A)).toEqual([]);
  });

  it("a bearer (MCP) context can run none of them", async () => {
    await configure(A);
    const mcp = await bearerCtx("AndresL230");
    const w = world();
    await expect(runUsagePolls(e, mcp, HOURLY, w.fetchImpl)).rejects.toBeInstanceOf(JobAccessError);
    await expect(runReconcileJob(e, mcp, HOURLY, { fetchImpl: w.fetchImpl })).rejects.toBeInstanceOf(JobAccessError);
    await expect(runBackfill(e, mcp, "AndresL230", { fetchImpl: w.fetchImpl })).rejects.toBeInstanceOf(JobAccessError);
    expect(w.seen).toEqual([]);
  });

  it("the refresh lock is per org", async () => {
    await configure(A);
    await configure(B);
    await run(env.DB, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'refresh_lock', '{}', ?)`, ORG_A, new Date(HOURLY).toISOString());
    const { runLockedRepoRefresh } = await import("../src/repo/cron");
    const w = world();
    expect((await runLockedRepoRefresh(e, systemCtx(ORG_A), "andres", HOURLY + 1000, w.fetchImpl)).ok).toBe(false);
    expect((await captured(() => runLockedRepoRefresh(e, systemCtx(ORG_B), "bob", HOURLY + 1000, w.fetchImpl))).out.ok).toBe(true);
    expect(await first(env.DB, `SELECT 1 AS held FROM repo_snapshots WHERE org_id = ? AND kind = 'refresh_lock'`, ORG_A)).toEqual({ held: 1 });
  });
});

// ── the admin routes: Sync GitHub / Poll now / Poll usage now ────────────────
// The routes have no fetch seam (they call the real `fetch`), so these swap the GLOBAL one.

describe("POST …/admin/{backfill,poll,poll-usage}: an admin acts on THEIR org only", () => {
  const ROUTES = ["/admin/backfill", "/admin/poll", "/admin/poll-usage"] as const;
  const NOT = "not_configured";
  /** SaplingLearn's legacy Worker secrets, all set: what `resolveCredential` may fall back to for org #1 ALONE. */
  const LEGACY = {
    GITHUB_SERVICE_TOKEN: "legacy-github-token-000000", CF_ANALYTICS_TOKEN: "legacy-cf-token-0000000", CF_ANALYTICS_ACCOUNT_ID: "legacy-account-0000",
    RAILWAY_TOKEN_LIVE: "legacy-railway-live-00000", SAPLING_METRICS_TOKEN: "legacy-metrics-token-000",
  };
  const legacyEnv = { ...e, ...LEGACY } as unknown as Env;

  const post = async (path: string, cookie: string) => {
    const res = await app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }, legacyEnv);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  /** Run `fn` with the global fetch replaced by a recording world; nothing may reach the network. */
  async function stubbed<T>(fn: () => Promise<T>): Promise<{ out: T; seen: Seen[] }> {
    const w = world();
    vi.stubGlobal("fetch", w.fetchImpl);
    try {
      return { out: (await captured(fn)).out, seen: w.seen };
    } finally { vi.unstubAllGlobals(); }
  }
  /** Every row `org` owns, per org-keyed table — the "nothing of theirs moved" check. */
  async function rowsOf(org: string): Promise<Record<string, string>> {
    const names = await all<{ name: string }>(env.DB,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%' ORDER BY name`);
    const tables: { name: string }[] = [];
    for (const t of names) if ((await all<{ name: string }>(env.DB, `SELECT name FROM pragma_table_info(?)`, t.name)).some((c) => c.name === "org_id")) tables.push(t);
    const out: Record<string, string> = {};
    for (const t of tables) out[t.name] = JSON.stringify((await all(env.DB, `SELECT * FROM "${t.name}" WHERE org_id = ?`, org)).map((r) => JSON.stringify(r)).sort());
    return out;
  }
  const boss = async () => { await ensureMember("boss", "owner", ORG_B); return cookieFor("boss", { member: false }); };
  const carries = (s: Seen, secrets: string[]) => secrets.filter((x) => JSON.stringify(s).includes(x));

  it("an org with nothing configured: a clean not-configured answer and NO outbound request — whatever SaplingLearn and the Worker hold", async () => {
    await configure(A);
    const before = await rowsOf(ORG_A);
    const cookie = await boss();
    const { out, seen } = await stubbed(async () => {
      const got: Record<string, unknown> = {};
      for (const base of ["", "/api/o/acme"]) for (const r of ROUTES) got[base + r] = await post(base + r, cookie);
      return got;
    });
    for (const base of ["", "/api/o/acme"]) {
      expect(out[`${base}/admin/backfill`]).toEqual({ status: 503, json: { error: "service token or repo not configured" } });
      expect(out[`${base}/admin/poll`]).toEqual({ status: 200, json: { health: NOT, cloudflare: NOT, railway: NOT, sapling: NOT, github: NOT } });
      expect(out[`${base}/admin/poll-usage`]).toEqual({ status: 200, json: { cloudflare: NOT, railway: NOT, sapling: NOT } });
    }
    expect(seen).toEqual([]);
    expect(await rowsOf(ORG_A)).toEqual(before);
    expect(await all(env.DB, `SELECT 1 FROM repo_metrics WHERE org_id = ?`, ORG_B)).toEqual([]);
    expect(await all(env.DB, `SELECT 1 FROM repo_snapshots WHERE org_id = ?`, ORG_B)).toEqual([]); // the refresh lock was released
  });

  it("a repo and an environment but no stored credential: only its own health pings go out — never a legacy Worker secret", async () => {
    await configure(A);
    await addOrgRepo(B.repo, ORG_B);
    await setOrgEnvironments([B.cfg], ORG_B);
    const before = await rowsOf(ORG_A);
    const cookie = await boss();
    const { out, seen } = await stubbed(async () => ({
      sync: await post("/api/o/acme/admin/backfill", cookie), poll: await post("/api/o/acme/admin/poll", cookie), usage: await post("/api/o/acme/admin/poll-usage", cookie),
    }));
    expect(out.sync).toEqual({ status: 503, json: { error: "service token or repo not configured" } });
    expect(out.poll).toMatchObject({ status: 200, json: { cloudflare: NOT, railway: NOT, sapling: NOT, github: NOT } });
    expect(out.usage).toEqual({ status: 200, json: { cloudflare: NOT, railway: NOT, sapling: NOT } });
    expect(seen.map((s) => s.url).sort()).toEqual([B.cfg.apiUrl + "/health", B.cfg.frontendUrl]);
    for (const s of seen) {
      expect([s.auth, s.rwToken]).toEqual([null, null]);
      expect(carries(s, [...Object.values(LEGACY), ...everySecret(A)])).toEqual([]);
    }
    expect(await rowsOf(ORG_A)).toEqual(before);
  });

  it("both orgs configured: each admin's run carries ITS org's stored credentials to ITS repo and environments, and writes only ITS rows", async () => {
    await configure(A);
    await configure(B);
    const admins: Record<string, string> = { [ORG_A]: await cookieFor("AndresL230"), [ORG_B]: await boss() };
    for (const [f, other, slug] of [[B, A, "acme"], [A, B, "saplinglearn"]] as const) {
      const before = await rowsOf(other.org);
      const { out, seen } = await stubbed(async () => {
        const got = [];
        for (const r of ROUTES) got.push(await post(`/api/o/${slug}${r}`, admins[f.org]));
        return got;
      });
      expect(out.map((r) => r.status), slug).toEqual([200, 200, 200]);
      expect(out[1].json, slug).toMatchObject({ github: { failed: [] }, cloudflare: [{ env: "live", status: "ok" }], railway: [{ env: "live", status: "ok" }], sapling: [{ env: "live", status: "ok" }] });

      // Every request is this org's: its repo, its hosts, its credentials — and no one else's, the Worker's included.
      expect(seen.length, slug).toBeGreaterThan(20);
      for (const s of seen) {
        expect(carries(s, [...everySecret(other), ...Object.values(LEGACY)]), `${slug} ${s.url}`).toEqual([]);
        expect(JSON.stringify(s).includes(other.tag), `${slug} ${s.url}`).toBe(false);
        if (s.url.startsWith(GH)) expect(s.auth, s.url).toBe(`Bearer ${f.secrets.gh}`);
        if (s.url.startsWith(GH) && !s.url.endsWith("/graphql")) expect(s.url.startsWith(`${GH}repos/${f.repo}`), s.url).toBe(true);
        if (s.url === CF_URL) expect(s.auth).toBe(`Bearer ${f.secrets.cf}`);
        if (s.url === RW_URL) expect(s.rwToken).toBe(f.secrets.rw);
        if (s.url.endsWith("/api/internal/metrics")) expect(s.auth).toBe(`Bearer ${f.secrets.app}`);
      }
      expect(seen.filter((s) => s.url === CF_URL || s.url === RW_URL || s.url.endsWith("/api/internal/metrics")), slug).toHaveLength(6); // Poll now + Poll usage now
      expect((await metricsOf(f.org)).length, slug).toBeGreaterThan(0);
      expect((await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_snapshots WHERE org_id = ?`, f.org)).map((r) => r.kind), slug).toContain("prs_reconciled");
      expect(await rowsOf(other.org), `${slug} changed a row of ${other.org}`).toEqual(before);
    }
  });
});
