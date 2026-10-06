import { app } from "./routes";
import { handleMcp } from "./mcp";
import { handleGithubWebhook } from "./webhook";
import { resolveBearerTenant } from "./data/bearer";
import { meterMcp, pruneUsage } from "./data/meter";
import { platform } from "./data/context";
import { legacySystemTenant } from "./data/legacy";
import { mcpUnauthorized, oauthOrigin } from "./auth/oauth";
import { ensureNotificationPolicySeeded } from "./notifications/policy";
import { DAILY_CRON, WEEKLY_CRON, handleNotificationCron } from "./notifications/cron";
import { REPO_CRON, handleRepoCron } from "./repo/cron";
import { verifyUnsubscribeToken } from "./notifications/unsubscribe";
import { run } from "./data/platform-sql";
import { handleArtifactUpload, isUploadRequest } from "./artifacts/upload";
import { handleArtifactDownload, isDownloadRequest } from "./artifacts/download";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Startup seeding (once per isolate): notification_policy gets a row for
    // any registry kind missing one. Never overwrites; never fails a request.
    // MT: the policy rows are per org; the legacy org's are seeded until org creation seeds its own (§5.3).
    await ensureNotificationPolicySeeded(legacySystemTenant(env, "system")).catch(() => undefined);
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    if (url.pathname === "/mcp") {
      // Bearer class: a pasted `trov_mcp_` (or legacy `canopy_mcp_`) token or an OAuth access token. The 401
      // points MCP clients at the OAuth metadata (RFC 9728) so Claude Code / claude.ai
      // can sign the person in; `error="invalid_token"` when a token was presented.
      // The token names a person; the tenant is their ONE org (the cut-over alias — src/data/bearer.ts).
      const bearer = await resolveBearerTenant(env, request);
      if (!bearer.ok) {
        if (bearer.reason !== "unauthorized") return new Response(JSON.stringify({ error: "org_required" }), { status: 409, headers: { "content-type": "application/json" } });
        const presented = /^Bearer\s+\S/i.test(request.headers.get("authorization") ?? "");
        return mcpUnauthorized(oauthOrigin(request.url), presented);
      }
      ctx.waitUntil(meterMcp(env, bearer.ctx, request)); // usage: one `mcp_request` + one `mcp_tool:<name>` per tool call
      return handleMcp(request, env, ctx, bearer.ctx);
    }
    // Third auth class: GitHub webhook deliveries, HMAC-verified over the raw
    // body against GITHUB_WEBHOOK_SECRET. Never touches sessionGate.
    if (url.pathname === "/webhook/github" && request.method === "POST") {
      return handleGithubWebhook(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
    }
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
    return app.fetch(request, env, ctx);
  },

  // Dispatched by cron expression (see wrangler.toml [triggers]):
  //  • the two notification triggers → the digest runner, gated in code by
  //    notification_settings (send_hour + timezone) at fire time;
  //  • the repo trigger (every 10 minutes) → handleRepoCron (src/repo/cron.ts),
  //    which spreads ONE heavy job per invocation across the ticks: health
  //    pings every tick; the three hourly usage polls at :00; and, every
  //    6th hour, the sprint-progress cache backstop at :10, the GitHub reconcile
  //    (deploys/checks/runs/branches/drift/open-PRs) at :20 and the capture
  //    prune at :30 — see the subrequest budget at that dispatcher.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // MT: as in fetch() — the legacy org's policy rows; a new org's are seeded by createOrg.
    await ensureNotificationPolicySeeded(legacySystemTenant(env, "system")).catch(() => undefined);
    if (controller.cron === DAILY_CRON || controller.cron === WEEKLY_CRON) {
      await pruneUsage(platform(env, "system")).catch(() => undefined); // org_usage_daily retention (400 days)
      await handleNotificationCron(env, controller.cron, new Date(controller.scheduledTime));
      return;
    }
    if (controller.cron === REPO_CRON) await handleRepoCron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
