import { app } from "./routes";
import { handleMcp } from "./mcp";
import { handleGithubWebhook, webhookPath } from "./github-hook";
import { resolveBearerTenant } from "./data/bearer";
import { meterMcp, pruneUsage } from "./data/meter";
import { platform } from "./data/context";
import { pruneLimits } from "./platform/limits";
import { mcpUnauthorized, oauthOrigin } from "./auth/oauth";
import { DAILY_CRON, WEEKLY_CRON, handleNotificationCron } from "./notifications/cron";
import { REPO_CRON, handleRepoCron } from "./repo/cron";
import { verifyUnsubscribeToken } from "./notifications/unsubscribe";
import { run } from "./data/platform-sql";
import { handleArtifactUpload, isUploadRequest } from "./artifacts/upload";
import { handleArtifactDownload, isDownloadRequest } from "./artifacts/download";
import type { Env } from "./env";

/** `index.html` from the assets binding. Its html handling may answer `/index.html` with a redirect to
 *  `/`; that one hop is followed here, so the browser's URL never changes. */
async function spaShell(request: Request, env: Env, url: URL): Promise<Response> {
  const ask = (path: string) => env.ASSETS.fetch(new Request(new URL(path, url), { method: request.method, headers: request.headers }));
  const res = await ask("/index.html");
  const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  return next ? ask(new URL(next, url).pathname) : res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // (notification_policy is seeded per org: by createOrg for a new org, and by the digest cron for
    // any registry kind an org has no row for yet — src/notifications/cron.ts.)
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    if (url.pathname === "/mcp") {
      // Bearer class: a pasted `trov_mcp_` (or legacy `canopy_mcp_`) token or an OAuth access token. The 401
      // points MCP clients at the OAuth metadata (RFC 9728) so Claude Code / claude.ai
      // can sign the person in; `error="invalid_token"` when a token was presented.
      // The token is bound to (person, org) — the org on its row / grant, never one from the request — and
      // resolves only through a live membership of it (src/data/bearer.ts); anything else is this 401.
      const bearer = await resolveBearerTenant(env, request);
      if (!bearer.ok) {
        const presented = /^Bearer\s+\S/i.test(request.headers.get("authorization") ?? "");
        return mcpUnauthorized(oauthOrigin(request.url), presented);
      }
      ctx.waitUntil(meterMcp(env, bearer.ctx, request)); // usage: one `mcp_request` + one `mcp_tool:<name>` per tool call
      return handleMcp(request, env, ctx, bearer.ctx);
    }
    // Third auth class: GitHub webhook deliveries, HMAC-verified over the raw
    // body against the `github_webhook` secret of the repo the URL names:
    // `/webhook/github/<org_repos.id>` per org, and the legacy `/webhook/github`
    // for the one `legacy_hook` repo (src/github-hook.ts). Never touches sessionGate.
    const hook = request.method === "POST" ? webhookPath(url.pathname) : null;
    if (hook) return handleGithubWebhook(request, env, { hookId: hook.hookId, waitUntil: (p) => ctx.waitUntil(p) });
    // Signed one-click unsubscribe (canopy-email.md §7): the single token
    // exception. POST (what List-Unsubscribe-Post mail clients send) verifies the
    // HMAC and can ONLY set email_unsubscribed = 1 for the login it names. A
    // human GET (the footer link) is redirected to the cookie-gated in-app screen
    // and flips nothing. Never touches sessionGate.
    if (url.pathname.startsWith("/u/")) {
      if (request.method !== "POST") return Response.redirect(new URL("/#unsubscribe", url).toString(), 302);
      const login = await verifyUnsubscribeToken(url.pathname.slice(3), env.COOKIE_SECRET);
      if (!login) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      await run(platform(env, login), `UPDATE persons SET email_unsubscribed = 1 WHERE handle = ?`, login);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Artifact binary upload (issue #52): the single-use token minted by
    // POST /api/artifacts/upload-url IS the auth — no session, so it is dispatched
    // here, before the app and its sessionGate (src/artifacts/upload.ts).
    if (isUploadRequest(request.method, url.pathname)) return handleArtifactUpload(request, env);
    // Artifact agent download (issue #52 · Track F): the signed, 5-minute URL that
    // artifact_get mints IS the auth — no session, dispatched here before the app. The
    // page is re-checked for the token's principal at download time
    // (src/artifacts/download.ts).
    if (isDownloadRequest(url.pathname)) return handleArtifactDownload(request, env);
    // The SPA lives at `/o/<slug>/` (hash routing after it): any GET under `/o/` is the app shell, asked of
    // the assets binding by name — no reliance on its SPA mode. The shell is public (it signs the visitor in);
    // the org's data is behind `/api/o/:slug` and its membership gate.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/o/")) return spaShell(request, env, url);
    return app.fetch(request, env, ctx);
  },

  // Dispatched by cron expression (see wrangler.toml [triggers]):
  //  • the two notification triggers → the digest runner, for EVERY active org,
  //    each gated in code by its own notification_settings (send_hour + timezone)
  //    at fire time;
  //  • the repo trigger (every 10 minutes) → handleRepoCron (src/repo/cron.ts),
  //    which spreads ONE heavy job per invocation across the ticks and runs it
  //    for every org by rotation: health pings every tick; the three hourly
  //    usage polls at :00; and, every 6th hour, the sprint-progress cache
  //    backstop at :10, the GitHub reconcile (deploys/checks/runs/branches/
  //    drift/open-PRs) at :20 and the capture prune at :30 — see the subrequest
  //    budget at that dispatcher.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === DAILY_CRON || controller.cron === WEEKLY_CRON) {
      await pruneUsage(platform(env, "system")).catch(() => undefined); // org_usage_daily retention (400 days)
      await pruneLimits(platform(env, "system")).catch(() => undefined); // abuse_counters of past windows
      await handleNotificationCron(env, controller.cron, new Date(controller.scheduledTime));
      return;
    }
    if (controller.cron === REPO_CRON) await handleRepoCron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
