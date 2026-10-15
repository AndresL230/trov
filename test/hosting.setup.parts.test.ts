// Org settings › Hosting — an environment's PARTS, written (src/hosting/part-writes.ts through
// src/hosting/routes.ts): validation with fixed-text refusals, the audit trail (keys, never values), the
// per-environment cap, Cloudflare and Railway stored like every other provider, a provider change clearing
// the old provider's poll state and deploys, the role and cookie-only gates, and an environment's deletion
// taking its parts with it.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { MAX_PARTS_PER_ENVIRONMENT, type EnvironmentPartDTO } from "@shared/hosting";
import { all, first, run } from "./helpers/db";
import { ownerCookie, roleCookie, seedOrgSettings } from "./helpers/integrations";
import { fakeProviders, hostingTestApp, installEnv, seedBareEnvironment, send } from "./helpers/hosting-setup";
import { ORG_A } from "./helpers/tenant";

const A = "/api/o/saplinglearn";
const partPath = (envKey: string, part: string) => `${A}/environments/${envKey}/parts/${part}`;
const partsOf = (envKey: string) => all<{ part_key: string; provider: string; role: string; label: string; settings: string; position: number }>(env.DB,
  `SELECT part_key, provider, role, label, settings, position FROM org_environment_parts WHERE org_id = ? AND env_key = ? ORDER BY position`, ORG_A, envKey);
const adminAudit = (action: string) => all<{ actor: string; target: string; detail: string }>(env.DB,
  `SELECT actor, target, detail FROM org_admin_audit WHERE org_id = ? AND action = ? ORDER BY id`, ORG_A, action);

async function seedPollAndDeploys(envKey: string, part: string, provider: string): Promise<void> {
  const at = "2026-10-06T10:00:00.000Z";
  await run(env.DB, `INSERT INTO hosting_poll_state (org_id, env, part, provider, polled_at, status, detail, last_ok_at, covered_from, covered_to, unavailable)
    VALUES (?, ?, ?, ?, ?, 'ok', 'wrote 3', ?, '2026-10-06T07:00:00.000Z', '2026-10-06T10:00:00.000Z', '[]')`, ORG_A, envKey, part, provider, at, at);
  await run(env.DB, `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, created_at, recorded_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`, ORG_A, envKey, part, provider, `dpl_${provider}_${part}`, at, at, at);
}
const count = async (table: string, envKey?: string) => (await first<{ n: number }>(env.DB,
  `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?${envKey ? " AND env = ?" : ""}`, ORG_A, ...(envKey ? [envKey] : [])))!.n;

describe("a stored part", () => {
  it("is created (201), described, and audited by KEY — then replaced (200) with only what changed named", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();

    const made = await send(web, "PUT", partPath("staging", "web"), me, { provider: "vercel", settings: { project: "secret-ish-project" } });
    expect(made.status).toBe(201);
    const part = (made.json as { part: EnvironmentPartDTO; created: boolean });
    expect(part.created).toBe(true);
    expect(part.part).toMatchObject({
      env: "staging", key: "web", label: "Web", role: "web", provider: "vercel", settings: { project: "secret-ish-project" },
      connection: "not_connected", console_url: "https://fake-host.test/personal/secret-ish-project", last_poll: null, updated_by: "AndresL230",
    });
    // After the migrated Cloudflare frontend (0) and Railway backend (1).
    expect((await partsOf("staging")).slice(2)).toEqual([{ part_key: "web", provider: "vercel", role: "web", label: "Web", settings: JSON.stringify({ project: "secret-ish-project" }), position: 2 }]);

    const replaced = await send(web, "PUT", partPath("staging", "web"), me, { provider: "vercel", label: "Marketing site", settings: { project: "other", branch: "main" } });
    expect(replaced.status).toBe(200);
    expect((replaced.json as { created: boolean }).created).toBe(false);
    // A second part takes the next position; a label-only change keeps the stored settings (same provider).
    expect((await send(web, "PUT", partPath("staging", "docs"), me, { provider: "vercel", settings: { project: "docs" } })).status).toBe(201);
    expect((await send(web, "PUT", partPath("staging", "docs"), me, { provider: "vercel", label: "Docs site" })).status).toBe(200);
    expect((await partsOf("staging")).slice(2).map((p) => [p.part_key, p.label, p.position, JSON.parse(p.settings)])).toEqual([
      ["web", "Marketing site", 2, { project: "other", branch: "main" }], ["docs", "Docs site", 3, { project: "docs" }],
    ]);

    const audit = await adminAudit("part.set");
    expect(audit.map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([
      ["AndresL230", "staging/web", { provider: "vercel", created: true, fields: ["settings.project"] }],
      ["AndresL230", "staging/web", { provider: "vercel", created: false, fields: ["label", "settings.branch", "settings.project"] }],
      ["AndresL230", "staging/docs", { provider: "vercel", created: true, fields: ["settings.project"] }],
      ["AndresL230", "staging/docs", { provider: "vercel", created: false, fields: ["label"] }],
    ]);
    for (const a of audit) expect(a.detail).not.toMatch(/secret-ish|other|docs"/);
  });

  it("refuses what it cannot store — fixed text naming the field, never the value — and writes nothing", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    const VALUE = "Zq-not-echoed-9";
    const before = await partsOf("staging"); // the migrated Cloudflare frontend and Railway backend
    const cases: [path: string, body: unknown, status: number, error: string, field?: string][] = [
      [partPath("staging", "web"), "not json", 400, "invalid_json"],
      [partPath("staging", "web"), { provider: "vercel", settings: { project: "x" }, extra: VALUE }, 400, "invalid", "body"],
      [partPath("staging", "Web Site"), { provider: "vercel", settings: { project: "x" } }, 400, "invalid", "part"],
      [partPath("nowhere", "web"), { provider: "vercel", settings: { project: "x" } }, 404, "not_found"],
      [partPath("staging", "web"), { provider: VALUE }, 400, "invalid", "provider"],
      [partPath("staging", "web"), { provider: "aws", settings: { resource_type: "ecs", resource: "a/b" } }, 400, "invalid", "provider"],
      [partPath("staging", "web"), { provider: "vercel", role: "service", settings: { project: "x" } }, 400, "invalid", "role"],
      [partPath("staging", "web"), { provider: "vercel", label: "x".repeat(61), settings: { project: "x" } }, 400, "invalid", "label"],
      [partPath("staging", "web"), { provider: "vercel", label: "  ", settings: { project: "x" } }, 400, "invalid", "label"],
      [partPath("staging", "web"), { provider: "vercel" }, 400, "invalid", "settings.project"],
      [partPath("staging", "web"), { provider: "vercel", settings: { project: VALUE } }, 400, "invalid", "settings.project"],
      [partPath("staging", "web"), { provider: "vercel", settings: { project: "x", [VALUE]: "y" } }, 400, "invalid", "settings"],
      [partPath("staging", "web"), { provider: "vercel", settings: { project: "x\ny" } }, 400, "invalid", "settings.project"],
    ];
    for (const [path, body, status, error, field] of cases) {
      const r = await send(web, "PUT", path, me, body);
      expect([r.status, r.json?.error, r.json?.field], `${path} ${JSON.stringify(body)}`).toEqual([status, error, field]);
      expect(JSON.stringify(r.json)).not.toContain(VALUE);
    }
    expect(await partsOf("staging")).toEqual(before);
    expect(await adminAudit("part.set")).toEqual([]);
    // AWS is described but `later`: its refusal says so.
    const aws = await send(web, "PUT", partPath("staging", "web"), me, { provider: "aws", settings: { resource_type: "ecs", resource: "a/b" } });
    expect(aws.json?.message).toBe("AWS is not supported yet");
  });

  it(`an environment holds at most ${MAX_PARTS_PER_ENVIRONMENT} parts, its Cloudflare and Railway ones counted; replacing one at the cap is fine`, async () => {
    await seedOrgSettings(); // staging already has a Cloudflare frontend and a Railway backend
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    for (let i = 0; i < MAX_PARTS_PER_ENVIRONMENT - 2; i++) {
      expect((await send(web, "PUT", partPath("staging", `p${i}`), me, { provider: "vercel", settings: { project: `p${i}` } })).status).toBe(201);
    }
    const over = await send(web, "PUT", partPath("staging", "one-more"), me, { provider: "vercel", settings: { project: "x" } });
    expect([over.status, over.json?.error]).toEqual([409, "too_many_parts"]);
    expect((await send(web, "PUT", partPath("staging", "p0"), me, { provider: "vercel", settings: { project: "renamed" } })).status).toBe(200);
    expect((await partsOf("staging")).length).toBe(MAX_PARTS_PER_ENVIRONMENT);
  });

  it("changing its provider drops its poll state and the OLD provider's deploys in the same write; a same-provider edit keeps them", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    expect((await send(web, "PUT", partPath("staging", "web"), me, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
    expect((await send(web, "PUT", partPath("production", "web"), me, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
    await seedPollAndDeploys("staging", "web", "vercel");
    await seedPollAndDeploys("production", "web", "vercel");

    expect((await send(web, "PUT", partPath("staging", "web"), me, { provider: "vercel", settings: { project: "site-2" } })).status).toBe(200);
    expect([await count("hosting_poll_state", "staging"), await count("hosting_deploys", "staging")]).toEqual([1, 1]);

    const moved = await send(web, "PUT", partPath("staging", "web"), me, { provider: "render", settings: { service_id: "srv-abc" } });
    expect(moved.status).toBe(200);
    expect(moved.json?.part).toMatchObject({ provider: "render", role: "service", label: "Web", settings: { service_id: "srv-abc" } });
    expect([await count("hosting_poll_state", "staging"), await count("hosting_deploys", "staging")]).toEqual([0, 0]);
    expect([await count("hosting_poll_state", "production"), await count("hosting_deploys", "production")]).toEqual([1, 1]); // another part's, untouched
    expect(JSON.parse((await adminAudit("part.set")).at(-1)!.detail)).toEqual({
      provider: "render", created: false, fields: ["provider", "role", "settings.project", "settings.service_id"], previous_provider: "vercel",
    });
  });

  it("is deleted with its poll state and deploys, audited; a second delete is 404", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    for (const p of ["web", "docs"]) expect((await send(web, "PUT", partPath("staging", p), me, { provider: "vercel", settings: { project: p } })).status).toBe(201);
    await seedPollAndDeploys("staging", "web", "vercel");
    await seedPollAndDeploys("staging", "docs", "vercel");
    const del = await send(web, "DELETE", partPath("staging", "web"), me);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true, removed: { env: "staging", part: "web", provider: "vercel" } });
    expect((await partsOf("staging")).map((p) => p.part_key)).toEqual(["frontend", "backend", "docs"]);
    expect(await all(env.DB, `SELECT part FROM hosting_poll_state WHERE org_id = ?`, ORG_A)).toEqual([{ part: "docs" }]);
    expect(await all(env.DB, `SELECT part FROM hosting_deploys WHERE org_id = ?`, ORG_A)).toEqual([{ part: "docs" }]);
    expect((await adminAudit("part.delete")).map((a) => [a.target, JSON.parse(a.detail)])).toEqual([["staging/web", { provider: "vercel" }]]);
    expect((await send(web, "DELETE", partPath("staging", "web"), me)).status).toBe(404);
    expect((await send(web, "DELETE", partPath("nowhere", "web"), me)).status).toBe(404);
  });
});

describe("Cloudflare and Railway are ordinary providers", () => {
  it("are stored parts under any key, with their own settings — written, replaced and deleted like any other", async () => {
    await seedBareEnvironment(ORG_A, "qa", 0, "QA");
    const me = await ownerCookie();
    const put = (part: string, body: unknown) => send(app, "PUT", partPath("qa", part), me, body, env as never);

    const fe = await put("edge", { provider: "cloudflare", settings: { worker: "qa-frontend" } });
    expect(fe.status).toBe(201);
    expect(fe.json?.part).toMatchObject({ key: "edge", label: "Edge", provider: "cloudflare", role: "web", settings: { worker: "qa-frontend" }, last_poll: null });
    expect(fe.json?.part).not.toHaveProperty("legacy");
    const be = await put("api", { provider: "railway", settings: { environment_id: "env-1", service_id: "svc-1" } });
    expect(be.status).toBe(201);
    expect(be.json?.part).toMatchObject({ key: "api", provider: "railway", role: "service", settings: { environment_id: "env-1", service_id: "svc-1" } });
    expect((await partsOf("qa")).map((p) => [p.part_key, p.provider, JSON.parse(p.settings)])).toEqual([
      ["edge", "cloudflare", { worker: "qa-frontend" }], ["api", "railway", { environment_id: "env-1", service_id: "svc-1" }],
    ]);
    expect((await put("edge", { provider: "cloudflare", label: "Frontend", settings: { worker: "qa-frontend-2" } })).status).toBe(200);
    expect((await adminAudit("part.set")).map((a) => [a.target, JSON.parse(a.detail).fields])).toEqual([
      ["qa/edge", ["settings.worker"]], ["qa/api", ["settings.environment_id", "settings.service_id"]], ["qa/edge", ["label", "settings.worker"]],
    ]);

    expect((await send(app, "DELETE", partPath("qa", "edge"), me, undefined, env as never)).json).toEqual({ ok: true, removed: { env: "qa", part: "edge", provider: "cloudflare" } });
    expect((await send(app, "DELETE", partPath("qa", "api"), me, undefined, env as never)).status).toBe(200);
    expect(await partsOf("qa")).toEqual([]);
    expect((await send(app, "DELETE", partPath("qa", "edge"), me, undefined, env as never)).status).toBe(404);
  });

  it("a migrated `frontend` / `backend` part can move to another provider, and another provider's part can become Cloudflare", async () => {
    await seedOrgSettings(); // staging: Cloudflare frontend + Railway backend
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    const moved = await send(web, "PUT", partPath("staging", "frontend"), me, { provider: "vercel", settings: { project: "site" } });
    expect(moved.status).toBe(200);
    expect(JSON.parse((await adminAudit("part.set")).at(-1)!.detail)).toMatchObject({ provider: "vercel", previous_provider: "cloudflare" });
    const back = await send(web, "PUT", partPath("staging", "frontend"), me, { provider: "cloudflare", settings: { worker: "w" } });
    expect(back.status).toBe(200);
    expect((await partsOf("staging")).map((p) => [p.part_key, p.provider])).toEqual([["frontend", "cloudflare"], ["backend", "railway"]]);
  });
});

describe("gates", () => {
  it("a member is 403 and writes nothing; a request carrying an Authorization header is 403 even with the owner's cookie", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const member = await roleCookie("casey", "member");
    const owner = await ownerCookie();
    const body = { provider: "vercel", settings: { project: "x" } };
    expect((await send(web, "PUT", partPath("staging", "web"), member, body)).json).toEqual({ error: "forbidden" });
    expect((await send(web, "DELETE", partPath("staging", "frontend"), member)).status).toBe(403);
    const bearer = await send(web, "PUT", partPath("staging", "web"), owner, body, installEnv(), { authorization: "Bearer trov_mcp_x" });
    expect([bearer.status, bearer.json?.error]).toEqual([403, "forbidden"]);
    expect((await send(web, "DELETE", partPath("staging", "frontend"), owner, undefined, installEnv(), { authorization: "Bearer x" })).status).toBe(403);
    expect((await partsOf("staging")).map((p) => p.part_key)).toEqual(["frontend", "backend"]);
    // An admin passes.
    expect((await send(web, "PUT", partPath("staging", "web"), await roleCookie("admin-user", "admin"), body)).status).toBe(201);
  });
});

describe("deleting an environment", () => {
  it("removes its stored parts, their poll state and deploys in the same batch — another environment's stay", async () => {
    await seedOrgSettings();
    const { providers } = fakeProviders();
    const web = hostingTestApp(providers);
    const me = await ownerCookie();
    for (const e of ["staging", "production"]) {
      expect((await send(web, "PUT", partPath(e, "web"), me, { provider: "vercel", settings: { project: "site" } })).status).toBe(201);
      await seedPollAndDeploys(e, "web", "vercel");
    }
    const del = await send(app, "DELETE", `${A}/environments/staging`, me, undefined, env as never);
    expect(del.status).toBe(200);
    expect(await all(env.DB, `SELECT DISTINCT env_key FROM org_environment_parts WHERE org_id = ?`, ORG_A)).toEqual([{ env_key: "production" }]);
    expect([await count("hosting_poll_state", "staging"), await count("hosting_deploys", "staging")]).toEqual([0, 0]);
    expect([await count("hosting_poll_state", "production"), await count("hosting_deploys", "production")]).toEqual([1, 1]);
    const [audit] = await adminAudit("environment.delete");
    expect(JSON.parse(audit.detail)).toEqual({ removed_secrets: [], removed_parts: ["frontend", "backend", "web"] });
  });
});
