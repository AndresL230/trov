/**
 * Apps (0070_repo_apps, src/repo/apps.ts): an app is a part key with a home. What matters: the migration
 * writes a row per existing part key (kind from the role — a Cloudflare web part is a Worker), a part key
 * with no row still reads as an app at the primary repository's root, and the writers are admin-only,
 * validated and audited in the same batch.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import migration from "../migrations/0070_repo_apps.sql?raw";
import { all } from "./helpers/db";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, ORG_B, tenantCtx, systemCtx } from "./helpers/tenant";
import { ENVS } from "./helpers/repo";
import { deleteRepoApp, listRepoApps, normaliseFolder, putRepoApp } from "../src/repo/apps";
import { SettingsError } from "../src/integrations/settings";

async function addPart(orgId: string, envKey: string, key: string, provider: string, role: "web" | "service", label: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, 0, ?, ?, ?, '{}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'test')`,
  ).bind(orgId, envKey, key, label, role, provider).run();
}

/** Section 2 of the migration (the per-part-key rows), cut on its marker lines. */
const SECTION_2 = migration.split("-- ── 2.")[1].split("-- ── 3.")[0];

describe("0070_repo_apps", () => {
  it("writes one app per part key per org — kind from the role, label from the first environment's part, repo the primary", async () => {
    await env.DB.prepare(`DELETE FROM repo_apps`).run();
    await addOrgRepo("acme/shop", ORG_B);
    await setOrgEnvironments(ENVS, ORG_B); // staging, then production
    await addPart(ORG_B, "production", "web", "vercel", "web", "Storefront (prod)");
    await addPart(ORG_B, "staging", "web", "vercel", "web", "Storefront");
    await addPart(ORG_B, "staging", "edge", "cloudflare", "web", "Edge");
    await addPart(ORG_B, "staging", "api", "render", "service", "API");
    await setOrgEnvironments(ENVS, ORG_A);
    await addPart(ORG_A, "staging", "frontend", "cloudflare", "web", "Frontend"); // no repo: '' (the primary, once one exists)
    await env.DB.exec(SECTION_2.split("\n").slice(1).filter((l) => !l.trim().startsWith("--")).join(" "));
    const rows = await all<{ org_id: string; key: string; repo: string; label: string; kind: string; source: string; folder: string; watch: string; created_by: string }>(
      env.DB, `SELECT org_id, key, repo, label, kind, source, folder, watch, created_by FROM repo_apps ORDER BY org_id, key`);
    expect(rows).toEqual([
      { org_id: ORG_B, key: "api", repo: "acme/shop", label: "API", kind: "Service", source: "migrated", folder: "/", watch: '["/"]', created_by: "migration" },
      { org_id: ORG_B, key: "edge", repo: "acme/shop", label: "Edge", kind: "Worker", source: "migrated", folder: "/", watch: '["/"]', created_by: "migration" },
      { org_id: ORG_B, key: "web", repo: "acme/shop", label: "Storefront", kind: "Site", source: "migrated", folder: "/", watch: '["/"]', created_by: "migration" },
      { org_id: ORG_A, key: "frontend", repo: "", label: "Frontend", kind: "Worker", source: "migrated", folder: "/", watch: '["/"]', created_by: "migration" },
    ]);
  });

  it("seeds SaplingLearn's frontend (a Worker) and backend (a Service)", async () => {
    const apps = await listRepoApps(systemCtx(ORG_A));
    expect(apps.map((a) => [a.key, a.kind, a.repo, a.source])).toEqual([
      ["frontend", "Worker", "SaplingLearn/sapling", "migrated"], ["backend", "Service", "SaplingLearn/sapling", "migrated"],
    ]);
  });
});

describe("listRepoApps", () => {
  it("synthesises an app for a part key with no row: the primary repo's root, kind from the role", async () => {
    await addOrgRepo("acme/shop", ORG_B);
    await setOrgEnvironments(ENVS, ORG_B);
    await addPart(ORG_B, "staging", "jobs", "railway", "service", "Jobs");
    await addPart(ORG_B, "staging", "site", "netlify", "web", "Site");
    const apps = await listRepoApps(systemCtx(ORG_B));
    expect(apps).toEqual([
      { key: "jobs", repo: "acme/shop", label: "Jobs", folder: "/", kind: "Service", watch: ["/"], releaseSignal: null, source: "synthesised", position: 0 },
      { key: "site", repo: "acme/shop", label: "Site", folder: "/", kind: "Site", watch: ["/"], releaseSignal: null, source: "synthesised", position: 1 },
    ]);
    // Never another org's rows: SaplingLearn's seeded apps are not Acme's.
    expect(apps.some((a) => a.key === "frontend")).toBe(false);
  });

  it("narrows to one repository, case-insensitively; a row stored with repo '' is the primary's", async () => {
    await addOrgRepo("acme/shop", ORG_B);
    await addOrgRepo("acme/docs", ORG_B, { primary: false });
    const admin = await tenantCtx("AndresL230", "admin", { orgId: ORG_B });
    await putRepoApp(admin, "docs", { kind: "Site", repo: "acme/docs", folder: "site/" });
    await env.DB.prepare(`INSERT INTO repo_apps (org_id, key, repo, label, kind, created_at, created_by, updated_at, updated_by)
      VALUES (?, 'api', '', 'API', 'Service', 'x', 'migration', 'x', 'migration')`).bind(ORG_B).run();
    expect((await listRepoApps(systemCtx(ORG_B), "ACME/DOCS")).map((a) => [a.key, a.folder, a.watch])).toEqual([["docs", "site", ["site"]]]);
    expect((await listRepoApps(systemCtx(ORG_B), "acme/shop")).map((a) => a.key)).toEqual(["api"]);
  });
});

describe("putRepoApp / deleteRepoApp", () => {
  it("is admin-only", async () => {
    await addOrgRepo("acme/shop", ORG_B);
    const member = await tenantCtx("Jose-Gael-Cruz-Lopez", "member", { orgId: ORG_B });
    await expect(putRepoApp(member, "web", { kind: "Site" })).rejects.toThrow();
    await expect(deleteRepoApp(member, "web")).rejects.toThrow();
    expect(await all(env.DB, `SELECT key FROM repo_apps WHERE org_id = ?`, ORG_B)).toEqual([]);
  });

  it("writes, updates and removes an app — each audited with the changed keys, never a value", async () => {
    await addOrgRepo("acme/shop", ORG_B);
    const admin = await tenantCtx("AndresL230", "admin", { orgId: ORG_B });
    const made = await putRepoApp(admin, "web", { kind: "Site", label: "Storefront", folder: "/apps/web/" });
    expect(made.created).toBe(true);
    expect(made.app).toMatchObject({ key: "web", repo: "acme/shop", label: "Storefront", folder: "apps/web", kind: "Site", watch: ["apps/web"], source: "manual" });
    const changed = await putRepoApp(admin, "web", { watch: ["apps/web/**", "packages/ui/**"], source: "suggested" });
    expect(changed.created).toBe(false);
    expect(changed.app).toMatchObject({ folder: "apps/web", watch: ["apps/web/**", "packages/ui/**"], source: "suggested" });
    await deleteRepoApp(admin, "web");
    expect(await all(env.DB, `SELECT key FROM repo_apps WHERE org_id = ?`, ORG_B)).toEqual([]);
    const audit = await all<{ action: string; target: string; actor: string; detail: string }>(
      env.DB, `SELECT action, target, actor, detail FROM org_admin_audit WHERE org_id = ? ORDER BY id`, ORG_B);
    expect(audit.map((a) => [a.action, a.target, a.actor])).toEqual([["app.set", "web", "AndresL230"], ["app.set", "web", "AndresL230"], ["app.delete", "web", "AndresL230"]]);
    expect(JSON.parse(audit[1].detail)).toEqual({ created: false, kind: "Site", fields: ["source", "watch"] });
    expect(audit.map((a) => a.detail).join(" ")).not.toContain("Storefront");
  });

  it("refuses what an app cannot be", async () => {
    await addOrgRepo("acme/shop", ORG_B);
    const admin = await tenantCtx("AndresL230", "admin", { orgId: ORG_B });
    const field = async (key: string, body: unknown): Promise<string | undefined> => {
      try { await putRepoApp(admin, key, body); return "accepted"; } catch (e) { return e instanceof SettingsError ? e.field : String(e); }
    };
    expect(await field("Web", { kind: "Site" })).toBe("key");
    expect(await field("web", {})).toBe("kind");
    expect(await field("web", { kind: "Lambda" })).toBe("kind");
    expect(await field("web", { kind: "Site", repo: "other/repo" })).toBe("repo");
    expect(await field("web", { kind: "Site", folder: "../etc" })).toBe("folder");
    expect(await field("web", { kind: "Site", watch: [] })).toBe("watch");
    expect(await field("web", { kind: "Site", source: "migrated" })).toBe("source");
    expect(await field("web", { kind: "Site", owner: "x" })).toBe("body");
    expect(await all(env.DB, `SELECT key FROM repo_apps WHERE org_id = ?`, ORG_B)).toEqual([]);
    await expect(deleteRepoApp(admin, "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("normalises a folder", () => {
    expect(normaliseFolder("/")).toBe("/");
    expect(normaliseFolder("")).toBe("/");
    expect(normaliseFolder("/apps/web/")).toBe("apps/web");
    expect(normaliseFolder("apps//web")).toBeNull();
    expect(normaliseFolder("apps/../web")).toBeNull();
    expect(normaliseFolder(3)).toBeNull();
  });
});
