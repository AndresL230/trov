// The Repo screen's per-repository settings (0071_repo_settings, docs/architecture/repo-dashboard.md): a tenant
// route under `/api/o/:slug`, COOKIE ONLY — a request carrying an Authorization header is refused (`cookieOnly`),
// and it is not an MCP tool (a default for everyone is a person's act, invariant 2). `tenantGate` (mounted on
// /api/o/:slug/* in src/routes.ts) has already resolved `c.var.ctx`.
//
//   PUT /repo/settings { repo, overview_group }   admin+ — the Overview's default Group by for one of the org's
//                                                 repositories ('env' | 'app' | null), audited `repo.settings`;
//                                                 → `RepoSettingsDTO`. 403 for a member, 400 for a bad body,
//                                                 404 for a repository the org does not have.
import { Hono } from "hono";
import type { AppEnv } from "../auth/principal";
import { REPO_SETTINGS_ROUTE } from "@shared/repo";
import { isGroupBy } from "@shared/repo-layout-core";
import { hasRole } from "../data/context";
import { orgRepoName, setRepoOverviewGroup } from "../data/repo-settings";
import { cookieOnly } from "../orgs/routes";

export const repoSettingsApp = new Hono<AppEnv>();
repoSettingsApp.use(REPO_SETTINGS_ROUTE, cookieOnly);

repoSettingsApp.put(REPO_SETTINGS_ROUTE, async (c) => {
  if (!hasRole(c.var.ctx, "admin")) return c.json({ error: "admin only" }, 403);
  const body = (await c.req.json().catch(() => null)) as { repo?: unknown; overview_group?: unknown } | null;
  const repo = typeof body?.repo === "string" ? body.repo.trim() : "";
  const group = body?.overview_group;
  if (!repo || repo.length > 140 || !(group === null || isGroupBy(group))) {
    return c.json({ error: "invalid", message: "Send { repo: \"owner/name\", overview_group: \"env\" | \"app\" | null }." }, 400);
  }
  const name = await orgRepoName(c.var.ctx, repo);
  if (!name) return c.json({ error: "not found" }, 404);
  return c.json(await setRepoOverviewGroup(c.var.ctx, name, group));
});
