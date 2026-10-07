// Org settings › the GitHub App, mounted at `/api/o/:slug` behind the app's `tenantGate`
// (docs/architecture/github-app.md):
//
//   GET  /github                the connection, as the page shows it — any member (an admin sees more)
//   GET  /github/install        start connecting (./connect.ts) — admin+, a browser navigation
//   GET  /github/repositories   what the installation can see, to pick from — admin+
//   POST /github/repositories   track one of them (optionally as the primary) — admin+
//   POST /github/test           Test connection: a real read through an installation token — admin+
//   POST /github/disconnect     end the binding in Trov — admin+
//
// Cookie only, never a token (a request with an `Authorization` header is refused, like every org
// setting), and there is no MCP tool for any of it. The callback that finishes a connection is
// `/auth/callback` — person-level, because GitHub returns there (src/auth/routes.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import type { GithubReposDTO } from "@shared/github-app";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireRole } from "../data/context";
import { SecretAccessError, scrub } from "../data/secrets";
import type { TenantContext } from "../data/sql";
import type { Env } from "../env";
import { importLogoLater } from "../integrations/logo";
import type { ProbeResult } from "../integrations/probe";
import { SettingsError, addRepo, listRepoRows, listRepos } from "../integrations/settings";
import { cookieOnly } from "../orgs/routes";
import { countInstallationRepos, forgetInstallationToken, getInstallation } from "./api";
import { startInstall } from "./connect";
import { resolveGithubCredential } from "./credential";
import { githubAppStatus } from "./status";
import { forgetRepoList, visibleRepos } from "./repos";
import { endInstallation, liveInstallation, recordInstallationOutcome, setInstallationSuspended } from "./store";

type C = Context<AppEnv>;
const originOf = (c: C): string => c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;

async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RoleError || e instanceof SecretAccessError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof SettingsError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("github app route failed", e instanceof Error ? e.name : "error"); // the name only — never the Error
    return c.json({ error: "internal" }, 500);
  }
}
const notConnected = (c: C) => c.json({ error: "not_connected", message: "this organization has no GitHub App installation" }, 404);

/**
 * Test connection for the App's row: ask GitHub, as the App, what the installation's state is (so a
 * suspension lifted on GitHub is noticed here), mint a token, and make ONE real read with it. The
 * outcome lands on the binding's `last_error` / `last_used_at`. Every `detail` is fixed text plus an
 * account name and a count — never upstream text.
 */
export async function testGithubApp(ctx: TenantContext, env: Env, now: number = Date.now(), fetchImpl?: typeof fetch): Promise<ProbeResult | null> {
  requireRole(ctx, "admin");
  let row = await liveInstallation(ctx);
  if (!row) return null;
  const done = async (ok: boolean, detail: string, revealed: string[] = []): Promise<ProbeResult> => {
    const clean = scrub(detail, revealed).replace(/\s+/g, " ").trim().slice(0, 300);
    if (row) await recordInstallationOutcome(ctx, row, ok ? { ok: true } : { ok: false, message: clean, revealed }, now).catch(() => undefined);
    if (!ok) console.error("integration test failed", "github_app", clean);
    return { ok, detail: clean };
  };
  const info = await getInstallation(env, row.installation_id, fetchImpl, now);
  if (!info.ok) {
    if (info.kind === "not_found") {
      forgetInstallationToken(env, row.installation_id);
      await endInstallation(ctx, row, "not_found");
      row = null;
      return done(false, "The Trov App is no longer installed on that GitHub account. Connect it again from Repositories.");
    }
    return done(false, info.kind === "credentials" ? "GitHub refused this Trov's App credentials. Whoever runs this Trov needs to check its App id and private key." : info.message);
  }
  await setInstallationSuspended(ctx, row, info.installation.suspended_at !== null);
  if (info.installation.suspended_at !== null) return done(false, `The installation on ${row.account_login} is suspended on GitHub. Unsuspend it there, then test again.`);
  row = (await liveInstallation(ctx)) ?? row;
  const gh = await resolveGithubCredential(ctx, env, { appOnly: true, fetchImpl, now });
  if (!gh) return done(false, (await liveInstallation(ctx))?.last_error ?? "GitHub did not issue a token for the installation.");
  const n = await countInstallationRepos(gh.token.reveal(), gh.fetch(fetchImpl));
  if (n === null) return done(false, "GitHub issued a token, but did not answer a read made with it.", [gh.token.reveal()]);
  return done(true, `GitHub answered through the installation on ${row.account_login}: ${n} ${n === 1 ? "repository" : "repositories"}.`);
}

export const githubAppRoutes = (() => {
  const r = new Hono<AppEnv>();
  for (const path of ["/github", "/github/*"]) r.use(path, cookieOnly);

  r.get("/github", (c) => guard(c, async () => c.json(await githubAppStatus(c.var.ctx, c.env))));

  r.get("/github/install", (c) => startInstall(c));

  r.get("/github/repositories", (c) => guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const res = await visibleRepos(ctx, c.env, { refresh: c.req.query("refresh") === "1" });
    if (!res.ok) return res.reason === "not_connected" ? notConnected(c) : c.json({ error: "github_failed", message: "GitHub did not list the installation's repositories" }, 502);
    const tracked = new Map((await listRepoRows(ctx)).map((x) => [x.repo_full_name.toLowerCase(), x]));
    const body: GithubReposDTO = {
      repositories: res.list.repositories.map((x) => {
        const mine = tracked.get(x.full_name.toLowerCase());
        return { full_name: x.full_name, private: x.private, tracked: !!mine, is_primary: mine?.is_primary === 1 };
      }),
      total: res.list.total, truncated: res.list.truncated,
    };
    return c.json(body);
  }));

  // Track a repository the installation can see. The name is checked against GitHub's own list — a
  // typed name the installation cannot see is refused here (the manual `POST /repos` still takes one).
  r.post("/github/repositories", (c) => guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_json", message: "the body must be a JSON object" }, 400);
    const name = typeof body.repo_full_name === "string" ? body.repo_full_name.trim() : "";
    const res = await visibleRepos(ctx, c.env);
    if (!res.ok) return res.reason === "not_connected" ? notConnected(c) : c.json({ error: "github_failed", message: "GitHub did not list the installation's repositories" }, 502);
    const seen = res.list.repositories.find((x) => x.full_name.toLowerCase() === name.toLowerCase());
    if (!seen) return c.json({ error: "not_visible", field: "repo_full_name", message: "the installation cannot see that repository" }, 404);
    const { id, created } = await addRepo(ctx, { repo_full_name: seen.full_name, is_primary: body.is_primary }, { connection: "app" });
    importLogoLater(c);
    const repos = await listRepos(ctx, originOf(c), true);
    return c.json({ repo: repos.find((x) => x.id === id) ?? null, repos }, created ? 201 : 200);
  }));

  r.post("/github/test", (c) => guard(c, async () => {
    const result = await testGithubApp(c.var.ctx, c.env);
    if (!result) return notConnected(c);
    return c.json({ ...result, github_app: await githubAppStatus(c.var.ctx, c.env) });
  }));

  // Disconnect: the binding ends in Trov. The App stays installed on GitHub until it is uninstalled
  // there; the org's repositories stay connected and are read with its token again, if it has one.
  r.post("/github/disconnect", (c) => guard(c, async () => {
    const ctx = c.var.ctx;
    requireRole(ctx, "admin");
    const row = await liveInstallation(ctx);
    if (!row) return notConnected(c);
    await endInstallation(ctx, row, "disconnected");
    forgetInstallationToken(c.env, row.installation_id);
    forgetRepoList(row.installation_id);
    return c.json({ ok: true, github_app: await githubAppStatus(c.var.ctx, c.env), repos: await listRepos(ctx, originOf(c), true) });
  }));

  return r;
})();
