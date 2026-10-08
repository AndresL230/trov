/**
 * Migration 0043_github_app, as the schema it leaves (the pool applies every migration in order): the
 * binding's two rules are enforced by the database itself, and what it added to `org_repos` defaults to
 * what every existing repository already was.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import migration from "../migrations/0043_github_app.sql?raw";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, tenantCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { seedInstallation } from "./helpers/github-app";
import { HANDLE_COLUMNS } from "../src/auth/persons";
import { InstallationConflictError, bindInstallation, endInstallation, liveInstallation } from "../src/github-app/store";
import { installationOrg } from "../src/platform/jobs";
import { platformCtx } from "./helpers/tenant";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

const info = (installation_id: number, account = "acme") => ({
  installation_id, account_login: account, account_id: "77", account_type: "Organization" as const, repository_selection: "all" as const, suspended_at: null, avatar_url: null,
});
const insert = (org: string, id: number, o: { removed?: boolean; type?: string; selection?: string; reason?: string | null } = {}) => run(env.DB,
  `INSERT INTO org_github_installations (org_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at, removed_at, removed_reason)
   VALUES (?, ?, 'acme', '77', ?, ?, 'AndresL230', '2026-10-07T00:00:00Z', ?, ?)`,
  org, id, o.type ?? "Organization", o.selection ?? "all", o.removed ? "2026-10-07T01:00:00Z" : null, o.reason === undefined ? (o.removed ? "disconnected" : null) : o.reason);

describe("0043_github_app — the file", () => {
  it("is additive: it creates and adds, and never drops, rebuilds, updates or deletes", () => {
    const sql = migration.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS org_github_installations/);
    expect(sql.match(/ALTER TABLE org_repos ADD COLUMN/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|INSERT)\b/i);
    expect(sql.match(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/g)).toBeNull();
    // Its rollback is written in its own header (there is no generated down file for it).
    expect(migration).toContain("DROP TABLE IF EXISTS org_github_installations;");
    expect(migration).toContain("ALTER TABLE org_repos DROP COLUMN connection;");
  });
});

describe("0043_github_app — the rules the database keeps", () => {
  it("an installation belongs to at most ONE org", async () => {
    await insert(ORG_A, 501);
    await expect(insert(ORG_B, 501)).rejects.toThrow(/UNIQUE/);
  });
  it("an org has at most ONE live installation", async () => {
    await insert(ORG_A, 501);
    await expect(insert(ORG_A, 502)).rejects.toThrow(/UNIQUE/);
    await insert(ORG_B, 502); // another org, another installation: fine
  });
  it("an ended binding frees both: the same installation can be connected again, by this org or another", async () => {
    await insert(ORG_A, 501, { removed: true });
    await insert(ORG_A, 501, { removed: true });
    await insert(ORG_B, 501);
    await insert(ORG_A, 502);
    expect(await all(env.DB, `SELECT org_id, installation_id FROM org_github_installations WHERE removed_at IS NULL ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, installation_id: 501 }, { org_id: ORG_A, installation_id: 502 },
    ]);
  });
  it("refuses an account type, a selection or a reason it does not know, and an org that does not exist", async () => {
    await expect(insert(ORG_A, 1, { type: "Bot" })).rejects.toThrow(/CHECK/);
    await expect(insert(ORG_A, 2, { selection: "some" })).rejects.toThrow(/CHECK/);
    await expect(insert(ORG_A, 3, { removed: true, reason: "because" })).rejects.toThrow(/CHECK/);
    await expect(insert("org_nobody", 4)).rejects.toThrow(/FOREIGN KEY/);
  });
  it("every existing repository is `manual`, and nothing else is a connection", async () => {
    await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_x', ?, 'o/r', 1, 0, '2026-10-06T00:00:00Z', 'seed')`, ORG_A);
    expect(await first(env.DB, `SELECT connection, access_lost_at FROM org_repos WHERE id = 'hook_x'`)).toEqual({ connection: "manual", access_lost_at: null });
    await expect(run(env.DB, `UPDATE org_repos SET connection = 'oauth' WHERE id = 'hook_x'`)).rejects.toThrow(/CHECK/);
  });
});

describe("0043_github_app — the code that goes with it", () => {
  it("replacing: a different installation ends the org's binding and takes its place, in one write", async () => {
    const a = await tenantCtx("AndresL230");
    await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by, connection) VALUES ('hook_r', ?, 'acme/app', 1, 0, '2026-10-06T00:00:00Z', 'seed', 'app')`, ORG_A);
    expect(await bindInstallation(a, info(501))).toBe("connected");
    const old = (await liveInstallation(a))!;
    expect(await bindInstallation(a, info(502, "other-co"), old)).toBe("connected");
    expect(await all(env.DB, `SELECT installation_id, account_login, removed_reason, removed_at IS NULL AS live FROM org_github_installations WHERE org_id = ? ORDER BY id`, ORG_A)).toEqual([
      { installation_id: 501, account_login: old.account_login, removed_reason: "disconnected", live: 0 },
      { installation_id: 502, account_login: "other-co", removed_reason: null, live: 1 },
    ]);
    // The old account's repositories go back to `manual`; both steps are audited, the end naming its successor.
    expect(await first(env.DB, `SELECT connection FROM org_repos WHERE id = 'hook_r'`)).toEqual({ connection: "manual" });
    const audit = await all<{ action: string; detail: string }>(env.DB, `SELECT action, detail FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%' ORDER BY id`, ORG_A);
    expect(audit.map((r) => r.action)).toEqual(["github.connect", "github.disconnect", "github.connect"]);
    expect(JSON.parse(audit[1].detail)).toEqual({ installation_id: 501, reason: "disconnected", replaced_by: 502 });
    // A stale `replace` (that binding already ended) ends nothing: the org's live one still stands in the way.
    await expect(bindInstallation(a, info(503, "third-co"), old)).rejects.toBeInstanceOf(InstallationConflictError);
    expect(await all(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%'`, ORG_A)).toHaveLength(3);
  });
  it("the binding's two writers: a second org, or a second installation, loses with a conflict and writes nothing", async () => {
    const a = await tenantCtx("AndresL230");
    const b = await tenantCtx("bob", "admin", { orgId: ORG_B });
    expect(await bindInstallation(a, info(501))).toBe("connected");
    await expect(bindInstallation(b, info(501))).rejects.toBeInstanceOf(InstallationConflictError);
    await expect(bindInstallation(a, info(502))).rejects.toBeInstanceOf(InstallationConflictError);
    expect(await bindInstallation(a, info(501, "acme-renamed"))).toBe("refreshed");
    expect(await all(env.DB, `SELECT org_id, installation_id, account_login FROM org_github_installations`)).toEqual([{ org_id: ORG_A, installation_id: 501, account_login: "acme-renamed" }]);
    expect(await all(env.DB, `SELECT action FROM org_admin_audit WHERE action LIKE 'github.%'`)).toEqual([{ action: "github.connect" }]); // one connect, no row for a refused one
    // Org B never reads org A's binding.
    expect(await liveInstallation(b)).toBeNull();
    expect(await installationOrg(platformCtx(), 501)).toEqual({ org_id: ORG_A, org_slug: "saplinglearn", org_suspended: 0 });
    expect(await installationOrg(platformCtx(), 999)).toBeNull();
  });
  it("ending a binding twice changes nothing the second time, and frees only THAT org's repositories", async () => {
    await addOrgRepo("acme/app", ORG_A);
    await addOrgRepo("beta/app", ORG_B);
    await run(env.DB, `UPDATE org_repos SET connection = 'app', access_lost_at = '2026-10-06T00:00:00Z'`);
    await seedInstallation(ORG_A, 501, "acme");
    await seedInstallation(ORG_B, 502, "beta");
    const a = await tenantCtx("AndresL230");
    const row = (await liveInstallation(a))!;
    expect(await endInstallation(a, row, "disconnected")).toBe(true);
    expect(await endInstallation(a, row, "uninstalled")).toBe(false);
    expect(await all(env.DB, `SELECT org_id, connection, access_lost_at FROM org_repos ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, connection: "app", access_lost_at: "2026-10-06T00:00:00Z" }, { org_id: ORG_A, connection: "manual", access_lost_at: null },
    ]);
    expect(await all(env.DB, `SELECT org_id, action, detail FROM org_admin_audit WHERE action LIKE 'github.%'`)).toEqual([
      { org_id: ORG_A, action: "github.disconnect", detail: JSON.stringify({ installation_id: 501, reason: "disconnected" }) },
    ]);
    expect(await first(env.DB, `SELECT removed_reason FROM org_github_installations WHERE org_id = ?`, ORG_A)).toEqual({ removed_reason: "disconnected" });
  });
  it("the reset clears the table before the orgs it references, and the handle column is renamed with a person", () => {
    const reset = RESET_STATEMENTS.findIndex((s: string) => s.includes("org_github_installations"));
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThan(RESET_STATEMENTS.findIndex((s: string) => s.startsWith("DELETE FROM orgs")));
    expect(HANDLE_COLUMNS.some(([t, c]) => t === "org_github_installations" && c === "connected_by")).toBe(true);
  });
});
