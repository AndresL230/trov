// The Repo screen's per-repository defaults (0071_repo_settings): `PUT /api/o/:slug/repo/settings` — admin, cookie
// only, audited — and the data-layer read the Overview's facts read uses (`readRepoSettings` → `facts.groupDefault`).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { REPO_SETTINGS_ROUTE, type RepoSettingsDTO } from "@shared/repo";
import { readRepoSettings } from "../src/data/repo-settings";
import { ORG_TABLES } from "../src/deletion/tables";
import { HANDLE_COLUMNS } from "../src/auth/persons";
import { all, first } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";

const BASE = "/api/o/saplinglearn";
const MEMBER = "repo-member";
const REPO = "acme/storefront";

async function put<T = unknown>(cookie: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await app.request(`${BASE}${REPO_SETTINGS_ROUTE}`, {
    method: "PUT", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }, env as unknown as Env);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}
const row = (orgId = ORG_A) => first<{ repo: string; overview_group: string | null; updated_by: string }>(env.DB, `SELECT repo, overview_group, updated_by FROM repo_settings WHERE org_id = ?`, orgId);

describe("PUT /api/o/:slug/repo/settings", () => {
  it("an admin sets, changes and clears a repository's default Group by — each audited, the read follows", async () => {
    await addOrgRepo(REPO);
    const admin = await cookieFor(FIXTURE_ADMIN);
    expect(await readRepoSettings(systemCtx(), REPO)).toEqual({ repo: REPO, overview_group: null, updated_at: null, updated_by: null });

    const set = await put<RepoSettingsDTO>(admin, { repo: "ACME/Storefront", overview_group: "app" });
    expect(set.status).toBe(200);
    // stored under the org's own spelling of the repository, as the admin
    expect(set.json).toMatchObject({ repo: REPO, overview_group: "app", updated_by: FIXTURE_ADMIN });
    expect(await row()).toEqual({ repo: REPO, overview_group: "app", updated_by: FIXTURE_ADMIN });
    expect((await readRepoSettings(systemCtx(), REPO)).overview_group).toBe("app");

    expect((await put<RepoSettingsDTO>(admin, { repo: REPO, overview_group: "env" })).json.overview_group).toBe("env");
    expect((await put<RepoSettingsDTO>(admin, { repo: REPO, overview_group: null })).json.overview_group).toBeNull();
    expect(await readRepoSettings(systemCtx(), REPO)).toMatchObject({ overview_group: null, updated_by: FIXTURE_ADMIN });

    const audit = await all<{ actor: string; target: string; detail: string }>(env.DB,
      `SELECT actor, target, detail FROM org_admin_audit WHERE org_id = ? AND action = 'repo.settings' ORDER BY id`, ORG_A);
    expect(audit.map((a) => [a.actor, a.target, JSON.parse(a.detail)])).toEqual([
      [FIXTURE_ADMIN, REPO, { overview_group: "app", was: null }],
      [FIXTURE_ADMIN, REPO, { overview_group: "env", was: "app" }],
      [FIXTURE_ADMIN, REPO, { overview_group: null, was: "env" }],
    ]);
  });

  it("a member is refused (403) and nothing is written; a bad body is 400; a repository the org lacks is 404", async () => {
    await addOrgRepo(REPO);
    await ensureMember(MEMBER);
    expect((await put(await cookieFor(MEMBER), { repo: REPO, overview_group: "app" })).status).toBe(403);
    expect(await row()).toBeNull();
    const admin = await cookieFor(FIXTURE_ADMIN);
    for (const body of [{ repo: REPO, overview_group: "table" }, { repo: REPO }, { overview_group: "env" }, { repo: "", overview_group: "env" }, null]) {
      expect((await put(admin, body)).status).toBe(400);
    }
    expect((await put(admin, { repo: "someone/else", overview_group: "env" })).status).toBe(404);
    expect(await row()).toBeNull();
  });

  it("is cookie only: a request carrying a bearer is refused", async () => {
    await addOrgRepo(REPO);
    const r = await put(await cookieFor(FIXTURE_ADMIN), { repo: REPO, overview_group: "env" }, { authorization: "Bearer trov_mcp_x" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await row()).toBeNull();
  });

  it("one org's setting is never another's: the read binds the context's org and its own repositories", async () => {
    await addOrgRepo(REPO);
    await put(await cookieFor(FIXTURE_ADMIN), { repo: REPO, overview_group: "app" });
    expect((await readRepoSettings(systemCtx(ORG_B), REPO)).overview_group).toBeNull();
    expect(await row(ORG_B)).toBeNull();
  });

  it("the table goes with the org and its handle column follows a rename", () => {
    expect(ORG_TABLES).toContain("repo_settings");
    expect(HANDLE_COLUMNS).toContainEqual(["repo_settings", "updated_by"]);
  });
});
