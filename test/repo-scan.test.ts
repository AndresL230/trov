/**
 * The repo scan against real D1 (repo setups, Phase D — src/repo/scan.ts, scan-reads.ts, scan-store.ts,
 * scan-routes.ts, signals.ts): its cost (one tree read + one GraphQL batch, + one describe per connected host) and
 * THE TREE-SHA SKIP; seen signals; describe() with stubbed hosts; the suggestion lifecycle (accept with Undo, ignore,
 * Scan again); THE GUARD that suggestions change nothing until accepted; the facts' found / unseen reads; the
 * reconcile arm; the routes. GitHub and the hosts are stubbed at the `Response` level.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/auth/principal";
import { sessionGate } from "../src/auth/principal";
import { platformContext, soleTenantGate, tenantGate } from "../src/data/gate";
import type { Env } from "../src/env";
import { setSecret } from "../src/data/secrets";
import { RoleError } from "../src/data/context";
import { SettingsError } from "../src/integrations/settings";
import { listRepoApps } from "../src/repo/apps";
import { listAllParts } from "../src/hosting/parts";
import { hostFetch } from "../src/hosting/http";
import { PROVIDERS } from "../src/hosting/registry";
import type { HostingProvider } from "../src/hosting/types";
import { reconcileRepo } from "../src/repo/github";
import { SCAN_COST, scanRepo, type DescribeSource } from "../src/repo/scan";
import { seenSignals } from "../src/repo/signals";
import { acceptSuggestion, ignoreSuggestion, listSuggestions, readFound, readScan, readUnseen, runScanNow, undoAccept, UNDO_WINDOW_MS } from "../src/repo/scan-store";
import { makeScanApp } from "../src/repo/scan-routes";
import { decide } from "@shared/repo-layout-core";
import { layoutInputOf } from "@shared/repo-facts-core";
import { all, first, run } from "./helpers/db";
import { ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import { send } from "./helpers/hosting-setup";
import { ENVS, LONG_TOKEN, leakedFragments } from "./helpers/repo";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";

const REPO = "SaplingLearn/sapling";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const TOKEN = `ghp_${LONG_TOKEN.slice(0, 36)}`;

const RAW = import.meta.glob("../fixtures/repo-scan/storefront/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const STOREFRONT = new Map(Object.entries(RAW).map(([k, v]) => [k.slice("../fixtures/repo-scan/storefront/".length).replace(/^_github\//, ".github/"), v] as [string, string]).filter(([p]) => p !== "README.md"));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeGh { fetchImpl: typeof fetch; calls: string[]; graphqlPaths: string[][] }
/** A fake api.github.com serving one repository: the tree (`sha`), its files over the GraphQL batch. */
function fakeGh(files: Map<string, string>, o: { sha?: string; truncated?: boolean; treeStatus?: number; extraTree?: string[]; host?: (url: string) => Response | undefined } = {}): FakeGh {
  const calls: string[] = [];
  const graphqlPaths: string[][] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const hosted = o.host?.(url);
    if (hosted) return hosted;
    if (url.includes("/git/trees/HEAD?recursive=1")) {
      if (o.treeStatus) return new Response(`{"message":"Bad credentials ${TOKEN}"}`, { status: o.treeStatus });
      return json({ sha: o.sha ?? "tree1", truncated: o.truncated ?? false, tree: [...files.keys(), ...(o.extraTree ?? [])].map((path) => ({ path, type: "blob" })) });
    }
    if (url === "https://api.github.com/graphql") {
      const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
      const repository: Record<string, unknown> = {};
      const asked: string[] = [];
      for (const [k, v] of Object.entries(variables)) {
        if (!/^p\d+$/.test(k)) continue;
        const path = v.replace(/^HEAD:/, "");
        asked.push(path);
        const text = files.get(path);
        repository[`f${k.slice(1)}`] = text === undefined ? null : { text, isBinary: false, byteSize: text.length };
      }
      graphqlPaths.push(asked);
      return json({ data: { repository } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, graphqlPaths };
}
const gh = (f: FakeGh) => ({ token: TOKEN, repo: REPO, fetchImpl: f.fetchImpl });

let seq = 0;
/** One captured GitHub row for SaplingLearn (what the webhook capture writes). */
async function capture(kind: "deploy" | "check" | "run", name: string | null, raw: Record<string, unknown>, o: { number?: number; actor?: string; sha?: string; at?: string; url?: string } = {}): Promise<void> {
  const n = o.number ?? ++seq + 1000;
  await run(env.DB, `INSERT INTO repo_events (org_id, semantic_key, kind, ref, sha, number, name, actor_login, url, raw, provenance, occurred_at, recorded_at)
    VALUES (?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, 'webhook', ?, ?)`,
  ORG_A, `t:${kind}:${n}:${++seq}`, kind, o.sha ?? `sha${seq}`, n, name, o.actor ?? null, o.url ?? null, JSON.stringify(raw), o.at ?? "2026-10-14T10:00:00Z", "2026-10-14T10:00:00Z");
}
/** The storefront's deploy names, as Vercel / Render / Fly report them. */
async function seedSignals(): Promise<void> {
  for (const n of [1, 2, 3]) await capture("deploy", "Production – storefront-web", { signal: "deployment" }, { number: n, actor: "vercel[bot]" });
  await capture("deploy", "Production – storefront-web", { signal: "deployment" }, { number: 3, actor: "vercel[bot]" }); // a second status of deployment 3
  await capture("deploy", "production - storefront-api", { signal: "deployment" }, { number: 10, actor: "render[bot]" });
  await capture("deploy", "main - storefront-api", { signal: "deployment" }, { number: 11, actor: "render[bot]" });
  await capture("check", "build (web)", { app: "github-actions" }); // a CI job: the workflow is the signal
  await capture("run", "Deploy jobs", { path: ".github/workflows/deploy-jobs.yml" });
  await capture("deploy", "Vercel", { signal: "status", context: "Vercel" }, { url: "https://vercel.com/acme/x" });
  await capture("deploy", "old", { signal: "deployment" }, { at: "2026-08-01T00:00:00Z" }); // outside 30 days
}

const ctxA = () => systemCtx(ORG_A);
const admin = () => tenantCtx("AndresL230", undefined, { orgId: ORG_A });

describe("the scan: cost and the tree-sha skip", () => {
  it("costs one tree read + ONE GraphQL batch of ≤ 24 files; writes pending suggestions and the scan row", async () => {
    await seedOrgSettings();
    const f = fakeGh(STOREFRONT);
    const out = await scanRepo(ctxA(), gh(f), { now: NOW });
    expect(out).toMatchObject({ skipped: false, treeSha: "tree1", requests: 2, added: 5, pending: 5 });
    expect(f.calls).toEqual([`https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`, "https://api.github.com/graphql"]);
    expect(f.graphqlPaths).toHaveLength(1);
    expect(f.graphqlPaths[0].length).toBeLessThanOrEqual(24);
    expect(SCAN_COST).toBe(2 + 3); // + one describe per describe-capable host (Vercel, Render, Netlify)
    const scan = await readScan(ctxA(), REPO);
    expect(scan).toMatchObject({ treeSha: "tree1", scannedAt: "2026-10-15T12:00:00.000Z", error: null });
    expect(scan.looked).toEqual(expect.arrayContaining(["wrangler.toml", "vercel.json", "Dockerfile"]));
    const list = await listSuggestions(ctxA(), REPO, NOW);
    expect(list.map((s) => [s.key, s.folder, s.kind, s.provider, s.state])).toEqual([
      ["api", "apps/api", "Service", "render", "pending"], ["docs", "apps/docs", "Site", "cloudflare", "pending"],
      ["jobs", "apps/jobs", "Service", "fly", "pending"], ["web", "apps/web", "Site", "vercel", "pending"], ["ui", "packages/ui", "Package", null, "pending"],
    ]);
    expect(list.find((s) => s.key === "ui")!.usedBy).toEqual(["apps/docs", "apps/web"]);
    expect(list.find((s) => s.key === "jobs")!.parts).toEqual([
      { env: "production", provider: "fly", settings: { app: "storefront-jobs" } },
    ]);
  });

  it("THE GUARD: the same root tree sha → zero further requests (no file batch, no describe), nothing rewritten", async () => {
    await seedOrgSettings();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    const before = await all(env.DB, `SELECT * FROM repo_app_suggestions WHERE org_id = ? ORDER BY id`, ORG_A);
    const f = fakeGh(STOREFRONT);
    const describe = vi.fn(async (): Promise<DescribeSource[]> => []);
    const again = await scanRepo(ctxA(), gh(f), { now: NOW + 3_600_000, describe });
    expect(again).toMatchObject({ skipped: true, treeSha: "tree1", requests: 1 });
    expect(f.calls).toEqual([`https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`]);
    expect(describe).not.toHaveBeenCalled();
    expect(await all(env.DB, `SELECT * FROM repo_app_suggestions WHERE org_id = ? ORDER BY id`, ORG_A)).toEqual(before);
    expect((await readScan(ctxA(), REPO)).scannedAt).toBe("2026-10-15T12:00:00.000Z");
    // A changed tree is read again.
    const changed = fakeGh(STOREFRONT, { sha: "tree2" });
    expect(await scanRepo(ctxA(), gh(changed), { now: NOW + 7_200_000 })).toMatchObject({ skipped: false, treeSha: "tree2", requests: 2 });
  });

  it("a truncated tree is scanned with what GitHub listed and says so; a refused tree records fixed words (no token), never a throw", async () => {
    await seedOrgSettings();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT, { truncated: true })), { now: NOW });
    expect((await readScan(ctxA(), REPO)).error).toBe("the repository is too large to list in one read; Trov looked at the files GitHub listed");
    expect((await listSuggestions(ctxA(), REPO, NOW)).length).toBe(5);
    expect(await scanRepo(ctxA(), gh(fakeGh(STOREFRONT, { sha: "tree9", treeStatus: 403 })), { now: NOW })).toMatchObject({ failed: true, requests: 1 });
    const scan = await readScan(ctxA(), REPO);
    expect(scan.error).toBe("GitHub refused to list the repository's files (HTTP 403)");
    expect(scan.treeSha).toBe("tree1"); // the last good sha stays
    expect(leakedFragments(JSON.stringify(scan), TOKEN)).toEqual([]);
  });

  it("a refused scan never claims to have scanned: it keeps the last good scan's time (or none), and only says why (e2e A8b)", async () => {
    await seedOrgSettings();
    // Never scanned, refused: no scan time — the Apps tab reads "not scanned yet" beside the reason.
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT, { treeStatus: 403 })), { now: NOW });
    expect(await readScan(ctxA(), REPO)).toMatchObject({ scannedAt: null, error: "GitHub refused to list the repository's files (HTTP 403)" });
    // A good scan, then a refused one an hour later: the time stays the good scan's.
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT, { sha: "tree9", treeStatus: 403 })), { now: NOW + 3_600_000 });
    expect(await readScan(ctxA(), REPO)).toMatchObject({ scannedAt: new Date(NOW).toISOString(), error: "GitHub refused to list the repository's files (HTTP 403)" });
  });
});

describe("seen signals", () => {
  it("groups the untagged signals of 30 days in ONE statement — distinct deployments, host from the creator, CI check runs left to their workflow", async () => {
    await seedOrgSettings();
    await seedSignals();
    const s = await seenSignals(ctxA(), REPO, 30, NOW);
    const by = (name: string) => s.find((x) => x.name === name);
    expect(by("Production – storefront-web")).toMatchObject({ kind: "deployment", provider: "vercel", count: 3 });
    expect(by("main - storefront-api")).toMatchObject({ kind: "deployment", provider: "render", count: 1 });
    expect(by("deploy-jobs.yml")).toMatchObject({ kind: "workflow", provider: null, count: 1, source: ".github/workflows/deploy-jobs.yml", branches: [{ name: "main", count: 1 }] });
    expect(by("Vercel")).toMatchObject({ kind: "status", provider: "vercel" });
    expect(by("build (web)")).toBeUndefined();
    expect(by("old")).toBeUndefined();
    // The capture is the primary repository's: any other repository has no signals (never another's).
    expect(await seenSignals(ctxA(), "acme/other", 30, NOW)).toEqual([]);
  });

  it("matched signals join their suggestion: evidence, the proposed github parts, the found card", async () => {
    await seedOrgSettings();
    await seedSignals();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    const list = await listSuggestions(ctxA(), REPO, NOW);
    const web = list.find((x) => x.key === "web")!;
    expect(web.evidence.map((e) => e.text)).toEqual(["from apps/web/vercel.json", "workspace package @acme/web (pnpm-workspace.yaml)", "GitHub deployment “Production – storefront-web” seen 3 times"]);
    expect(web.signals.map((x) => x.name)).toEqual(["Production – storefront-web"]);
    expect(web.parts).toEqual([{ env: "production", provider: "github", settings: { environment: "Production – storefront-web" } }]);
    const api = list.find((x) => x.key === "api")!;
    expect(api.parts).toEqual([
      { env: "staging", provider: "github", settings: { environment: "main - storefront-api" } },
      { env: "production", provider: "github", settings: { environment: "production - storefront-api" } },
    ]);
    const jobs = list.find((x) => x.key === "jobs")!;
    expect(jobs.signals.map((x) => x.name)).toEqual(["deploy-jobs.yml"]);

    const found = await readFound(ctxA(), REPO, NOW);
    expect(found!.apps.map((a) => [a.id.slice(0, 3), a.folder, a.evidence])).toContainEqual(["sg_", "apps/web", "from apps/web/vercel.json"]);
    expect(found!.signals[0]).toEqual({ name: "Production – storefront-web", provider: "vercel", count: 3 });
  });
});

describe("describe(): a connected host says which folder its project builds", () => {
  const stub = (body: unknown, seen: string[]) => (async (input: RequestInfo | URL) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return json(body);
  }) as typeof fetch;
  const pcOf = (p: HostingProvider, f: typeof fetch, config: Record<string, string> = {}) =>
    ({ fetch: hostFetch(p.apiHosts, f), credential: { secret: { reveal: () => "tok_host", toString: () => "[secret]" }, config }, now: NOW });

  it("Vercel: rootDirectory + link.repo, one list call (teamId sent)", async () => {
    const seen: string[] = [];
    const out = await PROVIDERS.vercel.describe!(pcOf(PROVIDERS.vercel, stub({ projects: [
      { id: "prj_1", name: "storefront-web", rootDirectory: "apps/web", link: { type: "github", org: "SaplingLearn", repo: "sapling" } },
      { id: "prj_2", name: "elsewhere", rootDirectory: null, link: { type: "github", org: "acme", repo: "other" } },
      { id: "prj_3", name: "gitlab", rootDirectory: null, link: { type: "gitlab", org: "SaplingLearn", repo: "sapling" } },
      { id: "prj_4", name: "root-site", rootDirectory: null, link: { type: "github", org: "saplinglearn", repo: "SAPLING" } },
    ] }, seen), { team_id: "team_abc" }) as never, REPO);
    expect(out).toEqual([
      { name: "storefront-web", folder: "apps/web", settings: { project: "storefront-web" }, kind: "Site" },
      { name: "root-site", folder: "/", settings: { project: "root-site" }, kind: "Site" },
    ]);
    expect(seen).toEqual(["https://api.vercel.com/v9/projects?limit=100&teamId=team_abc"]);
  });

  it("Render: rootDir and type; Netlify: build_settings.base and repo_url", async () => {
    const seen: string[] = [];
    expect(await PROVIDERS.render.describe!(pcOf(PROVIDERS.render, stub([
      { cursor: "c1", service: { id: "srv-api", name: "storefront-api", type: "web_service", repo: "https://github.com/SaplingLearn/sapling", rootDir: "apps/api" } },
      { cursor: "c2", service: { id: "srv-cron", name: "nightly", type: "cron_job", repo: "https://github.com/SaplingLearn/sapling.git", rootDir: "" } },
      { cursor: "c3", service: { id: "srv-x", name: "x", type: "web_service", repo: "https://github.com/acme/x", rootDir: "" } },
    ], seen)) as never, REPO)).toEqual([
      { name: "storefront-api", folder: "apps/api", settings: { service_id: "srv-api" }, kind: "Service" },
      { name: "nightly", folder: "/", settings: { service_id: "srv-cron" }, kind: "Job" },
    ]);
    expect(await PROVIDERS.netlify.describe!(pcOf(PROVIDERS.netlify, stub([
      { id: "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c", name: "storefront-docs", build_settings: { repo_url: "https://github.com/SaplingLearn/sapling", base: "apps/docs" } },
      { id: "x", name: "other", build_settings: { repo_path: "acme/other", base: "" } },
    ], seen)) as never, REPO)).toEqual([
      { name: "storefront-docs", folder: "apps/docs", settings: { site_id: "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c", site_name: "storefront-docs" }, kind: "Site" },
    ]);
    expect(seen).toEqual(["https://api.render.com/v1/services?limit=100", "https://api.netlify.com/api/v1/sites?per_page=100"]);
  });

  it("in the scan: counted, it upgrades the evidence and fills the host's settings; a refused describe is no evidence, never a failure", async () => {
    await seedOrgSettings();
    const seen: string[] = [];
    const vercel: DescribeSource = { provider: PROVIDERS.vercel, pc: pcOf(PROVIDERS.vercel, stub({ projects: [
      { id: "prj_1", name: "storefront-web", rootDirectory: "apps/web", link: { type: "github", org: "SaplingLearn", repo: "sapling" } },
    ] }, seen)) as never };
    const render: DescribeSource = { provider: PROVIDERS.render, pc: pcOf(PROVIDERS.render, (async () => new Response("nope", { status: 401 })) as typeof fetch) as never };
    const out = await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW, describe: async () => [vercel, render] });
    expect(out.requests).toBe(4);
    const web = (await listSuggestions(ctxA(), REPO, NOW)).find((s) => s.key === "web")!;
    expect(web.evidence.map((e) => e.text)).toContain("Vercel project storefront-web builds apps/web");
    expect(web.parts).toEqual([{ env: "production", provider: "vercel", settings: { project: "storefront-web" } }]);
  });
});

describe("the lifecycle", () => {
  it("accept writes the app (source suggested) and its parts as the admin, audited; Undo removes them; the key must be free", async () => {
    await seedOrgSettings();
    await seedSignals();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    const list = await listSuggestions(ctxA(), REPO, NOW);
    const api = list.find((s) => s.key === "api")!;
    const ctx = await admin();
    const res = await acceptSuggestion(ctx, "AndresL230", api.id, { now: NOW });
    expect(res.app).toMatchObject({ key: "api", repo: REPO, folder: "apps/api", kind: "Service", source: "suggested" });
    expect(res.parts).toEqual([{ env: "staging", key: "api", provider: "github" }, { env: "production", key: "api", provider: "github" }]);
    expect((await listAllParts(ctxA())).filter((p) => p.key === "api").map((p) => [p.env, p.provider, p.role, p.settings])).toEqual([
      ["staging", "github", "service", { environment: "main - storefront-api" }], ["production", "github", "service", { environment: "production - storefront-api" }],
    ]);
    const audit = await all<{ action: string; target: string; actor: string }>(env.DB, `SELECT action, target, actor FROM org_admin_audit WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(audit).toEqual([
      { action: "app.set", target: "api", actor: "AndresL230" }, { action: "part.set", target: "staging/api", actor: "AndresL230" }, { action: "part.set", target: "production/api", actor: "AndresL230" },
    ]);
    expect(await first(env.DB, `SELECT state, decided_by FROM repo_app_suggestions WHERE org_id = ? AND id = ?`, ORG_A, api.id)).toEqual({ state: "accepted", decided_by: "AndresL230" });
    // Listed as accepted while its app exists; never pending again; a second accept is refused.
    expect((await listSuggestions(ctxA(), REPO, NOW)).find((s) => s.id === api.id)!.state).toBe("accepted");
    await expect(acceptSuggestion(ctx, "AndresL230", api.id, { now: NOW })).rejects.toMatchObject({ code: "already_accepted" });

    const undone = await undoAccept(ctx, "AndresL230", res.undo, NOW + 5_000);
    expect(undone).toEqual({ id: api.id, undone: "accept" });
    expect((await listRepoApps(ctxA())).map((a) => a.key)).toEqual(["frontend", "backend"]);
    expect((await listAllParts(ctxA())).some((p) => p.key === "api")).toBe(false);
    expect((await all<{ action: string }>(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? ORDER BY id`, ORG_A)).map((a) => a.action).slice(3).sort()).toEqual(["app.delete", "part.delete", "part.delete"]);
    expect((await listSuggestions(ctxA(), REPO, NOW)).find((s) => s.id === api.id)!.state).toBe("pending");
    // The same token again, or too late, is refused.
    await expect(undoAccept(ctx, "AndresL230", res.undo, NOW + 6_000)).rejects.toMatchObject({ code: "not_found" });
    const again = await acceptSuggestion(ctx, "AndresL230", api.id, { now: NOW });
    await expect(undoAccept(ctx, "AndresL230", again.undo, NOW + UNDO_WINDOW_MS + 1)).rejects.toMatchObject({ code: "too_late" });

    // A key that already names a part is refused before anything is written.
    const web = list.find((s) => s.key === "web")!;
    await run(env.DB, `UPDATE repo_app_suggestions SET key = 'frontend' WHERE org_id = ? AND id = ?`, ORG_A, web.id);
    await expect(acceptSuggestion(ctx, "AndresL230", web.id, { now: NOW })).rejects.toMatchObject({ code: "key_taken", status: 409 });
    // A member may not.
    const member = await tenantCtx("meilin", "member", { orgId: ORG_A });
    await expect(acceptSuggestion(member, "meilin", web.id)).rejects.toBeInstanceOf(RoleError);
  });

  it("a Package is accepted with no part; a part a host refuses rolls the accept back", async () => {
    await seedOrgSettings();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    const ui = (await listSuggestions(ctxA(), REPO, NOW)).find((s) => s.key === "ui")!;
    const ctx = await admin();
    expect((await acceptSuggestion(ctx, "AndresL230", ui.id, { now: NOW })).parts).toEqual([]);
    // Fill production to the cap, then accept jobs (a fly part on production): refused, and nothing of it stays.
    const jobs = (await listSuggestions(ctxA(), REPO, NOW)).find((s) => s.key === "jobs")!;
    for (let i = 0; i < 20; i++) {
      await run(env.DB, `INSERT OR IGNORE INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
        VALUES (?, 'production', ?, ?, 'x', 'web', 'vercel', '{"project":"x"}', 'now', 'now', 't')`, ORG_A, `filler${i}`, 10 + i);
    }
    await expect(acceptSuggestion(ctx, "AndresL230", jobs.id, { now: NOW })).rejects.toBeInstanceOf(SettingsError);
    expect((await listRepoApps(ctxA())).some((a) => a.key === "jobs")).toBe(false);
    expect(await first(env.DB, `SELECT state FROM repo_app_suggestions WHERE org_id = ? AND id = ?`, ORG_A, jobs.id)).toEqual({ state: "pending" });
  });

  it("ignore hides it through a reconcile's scan; an admin's Scan again brings it back; an accepted one is never re-suggested; a vanished one goes", async () => {
    await seedOrgSettings();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    const ctx = await admin();
    const list = await listSuggestions(ctxA(), REPO, NOW);
    const docs = list.find((s) => s.key === "docs")!;
    const web = list.find((s) => s.key === "web")!;
    const ig = await ignoreSuggestion(ctx, "AndresL230", docs.id, NOW);
    await acceptSuggestion(ctx, "AndresL230", web.id, { now: NOW });
    expect((await listSuggestions(ctxA(), REPO, NOW)).some((s) => s.id === docs.id)).toBe(false);
    // Undo of an ignore.
    expect(await undoAccept(ctx, "AndresL230", ig.undo, NOW + 1000)).toEqual({ id: docs.id, undone: "ignore" });
    await ignoreSuggestion(ctx, "AndresL230", docs.id, NOW);

    // A reconcile's scan (a changed tree, no reset): docs stays ignored; web stays accepted (and its folder now has an app).
    const less = new Map(STOREFRONT);
    less.delete("apps/jobs/fly.toml"); less.delete("apps/jobs/Dockerfile");
    await scanRepo(ctxA(), gh(fakeGh(less, { sha: "tree2" })), { now: NOW + 1 });
    const rows = await all<{ key: string; state: string; kind: string }>(env.DB, `SELECT key, state, kind FROM repo_app_suggestions WHERE org_id = ? ORDER BY key`, ORG_A);
    expect(rows).toEqual([
      { key: "api", state: "pending", kind: "Service" }, { key: "docs", state: "ignored", kind: "Site" },
      { key: "jobs", state: "pending", kind: "Package" }, // fly.toml gone: jobs is a plain workspace member now — a NEW suggestion (another kind); the Service one went
      { key: "ui", state: "pending", kind: "Package" }, { key: "web", state: "accepted", kind: "Site" },
    ]);
    // Scan again (forced, reset): docs is back.
    await scanRepo(ctxA(), gh(fakeGh(less, { sha: "tree2" })), { now: NOW + 2, force: true, resetIgnored: true });
    expect(await first(env.DB, `SELECT state, decided_at FROM repo_app_suggestions WHERE org_id = ? AND id = ?`, ORG_A, docs.id)).toEqual({ state: "pending", decided_at: null });
  });

  it("THE GUARD: a scan with suggestions changes nothing — the apps, the parts and the facts' layout are what they were", async () => {
    await seedOrgSettings();
    const snapshot = async () => {
      const apps = await listRepoApps(ctxA(), REPO);
      const parts = await listAllParts(ctxA());
      const found = await readFound(ctxA(), REPO, NOW);
      const layout = decide(layoutInputOf({
        apps: apps.map((a) => ({ key: a.key, kind: a.kind })) as never, envs: ENVS.map((e) => ({ key: e.key })) as never,
        parts: parts.map((p) => ({ app: p.key, env: p.env })) as never, found,
      }));
      return { apps, parts, layout, appRows: await all(env.DB, `SELECT * FROM repo_apps WHERE org_id = ? ORDER BY key`, ORG_A) };
    };
    const before = await snapshot();
    await seedSignals();
    const out = await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    expect(out.pending).toBe(5);
    const after = await snapshot();
    expect(after.apps).toEqual(before.apps);
    expect(after.parts).toEqual(before.parts);
    expect(after.appRows).toEqual(before.appRows);
    expect(after.layout).toEqual(before.layout);
    expect((await readFound(ctxA(), REPO, NOW))!.apps).toHaveLength(5); // the found card is the one thing that knows
  });
});

describe("the facts' unseen read", () => {
  it("what the scan looked for and what GitHub shows; tags unknown (null) until a reconcile read the releases; PRs unknown until the open-PR list was read", async () => {
    await seedOrgSettings();
    expect(await readUnseen(ctxA(), REPO, NOW)).toBeNull(); // never scanned
    await seedSignals();
    await scanRepo(ctxA(), gh(fakeGh(STOREFRONT)), { now: NOW });
    const u = await readUnseen(ctxA(), REPO, NOW);
    expect(u).toMatchObject({ tags: null, prs: { open: null, mergedThisMonth: null }, workflows: ["deploy-jobs.yml"], deploymentsSeen30d: 5 });
    expect(u!.looked).toContain("fly.toml");
    await run(env.DB, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'prs_reconciled', '{}', ?)`, ORG_A, "2026-10-15T00:00:00Z");
    await capture("pr" as never, "PR", { action: "opened" }, { number: 7 });
    expect((await readUnseen(ctxA(), REPO, NOW))!.prs).toEqual({ open: 0, mergedThisMonth: 0 });
  });
});

describe("the reconcile arm", () => {
  const ghRoutes = (f: FakeGh) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/git/trees/") || (url.endsWith("/graphql") && String(init?.body).includes("object(expression"))) return f.fetchImpl(input, init);
    if (url.endsWith("/graphql")) return json({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { nodes: [] } } } });
    return json(url.includes("/compare/") ? { ahead_by: 0, behind_by: 0, commits: [] } : []);
  }) as typeof fetch;

  it("runs the scan only when asked (not Poll now); a refusal is recorded on the scan; an unexpected throw is the guarded arm's", async () => {
    await seedOrgSettings();
    const f = fakeGh(STOREFRONT);
    const off = await reconcileRepo(ctxA(), { token: TOKEN, repo: REPO, fetchImpl: ghRoutes(f) }, ENVS, NOW);
    expect(off.failed).toEqual([]);
    expect(f.calls).toEqual([]);
    const on = await reconcileRepo(ctxA(), { token: TOKEN, repo: REPO, fetchImpl: ghRoutes(f) }, ENVS, NOW, {});
    expect(on.failed).toEqual([]);
    expect(f.calls.length).toBe(2);
    expect((await listSuggestions(ctxA(), REPO, NOW)).length).toBe(5);
    // A GitHub refusal is the SCAN's to say (the Apps tab), never the reconcile's or the credential's.
    const bad = fakeGh(STOREFRONT, { sha: "x", treeStatus: 500 });
    const refused = await reconcileRepo(ctxA(), { token: TOKEN, repo: REPO, fetchImpl: ghRoutes(bad) }, ENVS, NOW, {});
    expect(refused.failed).toEqual([]);
    expect((await readScan(ctxA(), REPO)).error).toBe("GitHub could not list the repository's files (HTTP 500)");
    // An unexpected error (a registry that cannot be read) is the guarded arm's: `scan` in failed, the other arms ran.
    const broken = await reconcileRepo(ctxA(), { token: TOKEN, repo: REPO, fetchImpl: ghRoutes(fakeGh(STOREFRONT, { sha: "y" })) }, ENVS, NOW,
      { providers: new Proxy({}, { get() { throw new Error("registry unreadable"); } }) as never });
    expect(broken.failed).toEqual(["scan"]);
  });
});

describe("the routes", () => {
  const scanTestApp = (fetchImpl?: typeof fetch) => {
    const a = new Hono<AppEnv>();
    a.use("*", sessionGate);
    a.use("*", platformContext);
    a.use("*", soleTenantGate);
    a.use("/api/o/:slug/*", tenantGate);
    a.route("/api/o/:slug", makeScanApp({ fetchImpl, now: () => NOW }));
    return a;
  };
  const A = "/api/o/saplinglearn/repos/SaplingLearn/sapling";
  const e = env as unknown as Env;

  it("Scan again: admin only, cookie only, the repository checked; no GitHub credential → ok false with the reason", async () => {
    await seedOrgSettings();
    const web = scanTestApp();
    const me = await ownerCookie();
    const none = await send(web, "POST", `${A}/scan`, me, undefined, e);
    expect(none.status).toBe(200);
    expect(none.json).toMatchObject({ ok: false, scan: { error: "GitHub isn't connected for this repository" }, suggestions: [] });
    expect((await send(web, "POST", "/api/o/saplinglearn/repos/acme/other/scan", me, undefined, e)).status).toBe(404);
    expect((await send(web, "POST", `${A}/scan`, await roleCookie("meilin", "member"), undefined, e)).status).toBe(403);
    expect((await send(web, "POST", `${A}/scan`, me, undefined, e, { authorization: "Bearer trov_mcp_x" })).status).toBe(403);
  });

  it("Scan again with the org's GitHub token and a connected Vercel (describe) → suggestions; accept → { undo }; undo; ignore", async () => {
    await seedOrgSettings();
    const owner = await admin();
    await setSecret(owner, "github_token", "", TOKEN);
    await setSecret(owner, "vercel", "", "vercel_token_0123456789abcdef");
    const f = fakeGh(STOREFRONT, { host: (url) => (url.startsWith("https://api.vercel.com/") ? json({ projects: [
      { id: "prj_1", name: "storefront-web", rootDirectory: "apps/web", link: { type: "github", org: "SaplingLearn", repo: "sapling" } },
    ] }) : undefined) });
    const web = scanTestApp(f.fetchImpl);
    const me = await ownerCookie();
    const scanned = await send(web, "POST", `${A}/scan`, me, undefined, e);
    expect(scanned.status).toBe(200);
    const body = scanned.json as { ok: boolean; added: number; suggestions: { id: string; key: string; parts: unknown[] }[] };
    expect(body).toMatchObject({ ok: true, added: 5 });
    expect(f.calls.filter((u) => u.startsWith("https://api.vercel.com/"))).toEqual(["https://api.vercel.com/v9/projects?limit=100"]);
    const s = body.suggestions.find((x) => x.key === "web")!;
    expect(s.parts).toEqual([{ env: "production", provider: "vercel", settings: { project: "storefront-web" } }]);

    const acc = await send(web, "POST", `${A}/suggestions/${s.id}/accept`, me, undefined, e);
    expect(acc.status).toBe(200);
    expect(acc.json).toMatchObject({ undo: expect.stringMatching(/^sg_[0-9a-f]{20}~/), app: { key: "web", source: "suggested" } });
    expect((await send(web, "POST", `${A}/suggestions/undo`, me, { undo: (acc.json as { undo: string }).undo }, e)).json).toEqual({ id: s.id, undone: "accept" });
    expect((await send(web, "POST", `${A}/suggestions/undo`, me, { nope: 1 }, e)).status).toBe(400);
    const ig = await send(web, "POST", `${A}/suggestions/${s.id}/ignore`, me, undefined, e);
    expect(ig.json).toMatchObject({ undo: expect.any(String) });
    expect((await send(web, "POST", `${A}/suggestions/sg_00000000000000000000/accept`, me, undefined, e)).status).toBe(404);
    // A suggestion is answered only under its own repository.
    await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('r2', ?, 'acme/other', 0, 0, 'now', 't')`, ORG_A);
    expect((await send(web, "POST", `/api/o/saplinglearn/repos/acme/other/suggestions/${s.id}/accept`, me, undefined, e)).status).toBe(404);
    expect(leakedFragments(JSON.stringify([scanned.json, acc.json]), TOKEN)).toEqual([]);
  });
});
