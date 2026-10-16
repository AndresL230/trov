import { app, isAppRoute } from "./routes";
import { handleGithubWebhook, webhookPath } from "./github-hook";
import { STRIPE_WEBHOOK_PATH, handleStripeWebhook } from "./billing/webhook";
import { pruneEvents } from "./billing/store";
import { BILLING_CHECKOUT_PATH, BILLING_DONE_PATH } from "@shared/billing";
import { APP_WEBHOOK_PATH, handleGithubAppWebhook } from "./github-app/webhook";
import { handleHostingWebhook, hostingWebhookPath } from "./hosting/webhook";
import { resolveBearerConnection } from "./data/bearer";
import { INTERNAL_METRICS_PATH, handleInternalMetrics } from "./internal-metrics";
import { meterMcp, pruneUsage } from "./data/meter";
import { pruneSyncRuns } from "./platform/sweeps";
import { platform } from "./data/context";
import { pruneLimits } from "./platform/limits";
import { mcpUnauthorized, oauthOrigin } from "./auth/oauth";
import { DAILY_CRON, WEEKLY_CRON, handleNotificationCron } from "./notifications/cron";
import { REPO_CRON, handleRepoCron } from "./repo/cron";
import { UNSUBSCRIBE_PREFIX, handleUnsubscribe } from "./notifications/unsubscribe";
import { handleArtifactUpload, isUploadRequest } from "./artifacts/upload";
import { handleArtifactDownload, isDownloadRequest } from "./artifacts/download";
import type { Env } from "./env";
import { orgPath, orgSlugOfPath, orgSlugProblem } from "@shared/orgs";
import { APP_SHELL_PATH, assetPage, canonicalRedirect, noindex, notFound, sitePublic } from "./site";
import { withErrorHint } from "./error-hints";

/** The app shell (web/app.html, asked for at its clean path `/app`) from the assets binding — never the
 *  landing page, which is `/` signed out (src/site.ts). */
const spaShell = (request: Request, env: Env, url: URL): Promise<Response> => assetPage(request, env, url, APP_SHELL_PATH);

/** Everything but the public answers of src/site.ts. The caller tags every GET / HEAD answer from here `noindex`. */
async function serve(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // (notification_policy is seeded per org: by createOrg for a new org, and by the digest cron for
  // any registry kind an org has no row for yet — src/notifications/cron.ts.)
  // Static assets are served by the assets binding before this handler runs (all but `/`: src/site.ts).
  if (url.pathname === "/mcp") {
    // Bearer class: a pasted `trov_mcp_` (or legacy `canopy_mcp_`) token or an OAuth access token. The 401
    // points MCP clients at the OAuth metadata (RFC 9728) so Claude Code / claude.ai
    // can sign the person in; `error="invalid_token"` when a token was presented.
    // A connection reaches only organizations its person is a live member of, and WHICH one a call acts
    // in is decided per call (src/data/bearer.ts) — a token's one org, a manual connection's current
    // one, or the one that has the call's repository connected. Nowhere to act at all is this 401.
    const bearer = await resolveBearerConnection(env, request);
    if (!bearer.ok) {
      const presented = /^Bearer\s+\S/i.test(request.headers.get("authorization") ?? "");
      return mcpUnauthorized(oauthOrigin(request.url), presented);
    }
    // usage: a tool call is counted in the org it resolves to (src/mcp.ts); a request with none, here.
    ctx.waitUntil(meterMcp(env, bearer.conn.current?.ctx ?? null, request));
    // Loaded on the first /mcp request, not at startup: the bundler wraps a dynamically imported module in a
    // lazy initialiser, so the MCP server, its SDK and the tool modules only it reaches are evaluated by the
    // isolate that first answers /mcp, never by one that only serves the app (docs/architecture/env.md › Bundle).
    const { handleMcp } = await import("./mcp");
    return handleMcp(request, env, ctx, bearer.conn);
  }
  // Trov's OWN app metrics endpoint (contract v3, src/internal-metrics.ts): the SAME bearer class as /mcp — a Trov MCP
  // credential, its organization chosen only by src/data/bearer.ts — read-only, D1-only, before the cookie-only app.
  if (url.pathname === INTERNAL_METRICS_PATH) return handleInternalMetrics(request, env);
  // Stripe's deliveries (docs/architecture/billing.md): the `Stripe-Signature` over the raw body is the
  // auth, against STRIPE_WEBHOOK_SECRET; a bad one is a bare 401 and writes nothing (src/billing/webhook.ts).
  if (request.method === "POST" && url.pathname === STRIPE_WEBHOOK_PATH) return handleStripeWebhook(request, env);
  // Third auth class: GitHub webhook deliveries, HMAC-verified over the raw
  // body against the `github_webhook` secret of the repo the URL names:
  // `/webhook/github/<org_repos.id>` per org, and the legacy `/webhook/github`
  // for the one `legacy_hook` repo (src/github-hook.ts). Never touches sessionGate.
  // The GitHub App's own endpoint comes first: ONE URL for every installation, verified against the
  // App's webhook secret, the org found from the delivery's installation id (src/github-app/webhook.ts).
  if (request.method === "POST" && url.pathname === APP_WEBHOOK_PATH) return handleGithubAppWebhook(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
  const hook = request.method === "POST" ? webhookPath(url.pathname) : null;
  if (hook) return handleGithubWebhook(request, env, { hookId: hook.hookId, waitUntil: (p) => ctx.waitUntil(p) });
  // A hosting provider's notices (src/hosting/webhook.ts): the signature over the raw body, keyed with the
  // integration's client secret, is the auth. "Uninstalled" revokes that installation's credential in the
  // org(s) that hold it; a deployment / project event polls that project's parts again, after the response.
  // Never touches sessionGate; an unverified delivery is a bare 401 that writes nothing.
  const hostingHook = request.method === "POST" ? hostingWebhookPath(url.pathname) : null;
  if (hostingHook) return handleHostingWebhook(request, env, hostingHook.provider, { waitUntil: (p) => ctx.waitUntil(p) });
  // Signed unsubscribe (canopy-email.md §7): the single token exception. The HMAC token names ONE person
  // and can ONLY set email_unsubscribed = 1 for them, whoever is signed in here (src/notifications/
  // unsubscribe.ts). A GET (the footer link — and every mail scanner's prefetch) is a page that changes
  // nothing; its button POSTs the token back. A POST without the page's marker is the RFC 8058 one-click
  // List-Unsubscribe-Post mail clients send. Never touches sessionGate.
  if (url.pathname.startsWith(UNSUBSCRIBE_PREFIX)) return handleUnsubscribe(request, env, url);
  // Artifact binary upload (issue #52): the single-use token minted by
  // POST /api/artifacts/upload-url IS the auth — no session, so it is dispatched
  // here, before the app and its sessionGate (src/artifacts/upload.ts).
  // (These two, the API and the 404 answer an agent too: each JSON error carries a `hint` — src/error-hints.ts.)
  if (isUploadRequest(request.method, url.pathname)) return withErrorHint(request, await handleArtifactUpload(request, env));
  // Artifact agent download (issue #52 · Track F): the signed, 5-minute URL that
  // artifact_get mints IS the auth — no session, dispatched here before the app. The
  // page is re-checked for the token's principal at download time
  // (src/artifacts/download.ts).
  if (isDownloadRequest(url.pathname)) return withErrorHint(request, await handleArtifactDownload(request, env));
  // The SPA lives at `/<slug>/` (hash routing after it): a GET for `/<slug>` or `/<slug>/`, where the
  // segment is a valid org slug that is NOT reserved (shared/orgs.ts `orgSlugOfPath` — every route and
  // static page at the root is reserved, so an org can never shadow one), is the app shell, asked of the
  // assets binding by name — no reliance on its SPA mode. The shell is public (it signs the visitor in);
  // the org's data is behind `/api/o/:slug` and its membership gate. The address used to be
  // `/o/<slug>/…`: that is redirected for good, query kept (the browser carries the hash across).
  // `/platform` is the superadmin's area OUTSIDE any org (a superadmin may belong to none): the same
  // shell; what it shows comes from `/api/platform/*`, which 404s everyone who is not a superadmin.
  // `/billing/done` is the waiting room Stripe sends a buyer back to (web/src/billing.ts): the same shell,
  // outside any org — the buyer has none yet. What it shows comes from `/api/billing/status`.
  // `/billing/checkout` is the payment page of embedded checkout (web/src/billing-checkout.ts): the same shell
  // again. The shell holds nothing of the buyer's: the session it mounts comes from `POST /api/billing/checkout`
  // (or the org's upgrade route), which answer the signed-in buyer only.
  const readOnly = request.method === "GET" || request.method === "HEAD";
  const old = readOnly ? /^\/o\/([^/]+)(?:\/.*)?$/.exec(url.pathname) : null;
  if (old && orgSlugProblem(old[1].toLowerCase()) === null) return Response.redirect(new URL(`${orgPath(old[1].toLowerCase())}${url.search}`, url).toString(), 301);
  const isShellPath = (orgSlugOfPath(url.pathname) !== null && !url.pathname.startsWith("/o/")) || url.pathname === "/platform" || url.pathname.startsWith("/platform/") || url.pathname === BILLING_DONE_PATH || url.pathname === BILLING_CHECKOUT_PATH;
  if (readOnly && isShellPath) return spaShell(request, env, url);
  // An address no route answers is a 404 page for everyone, before the session gate — never its 401
  // (a real cookie route keeps that: src/routes.ts `isAppRoute`). A single segment that is a valid,
  // unreserved slug never gets here: it is an org's page above, whether or not that org exists, and
  // finding out would mean telling a stranger which organizations do.
  if (!isAppRoute(request.method, url.pathname)) return withErrorHint(request, await notFound(request, env, url));
  return withErrorHint(request, await app.fetch(request, env, ctx));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // One address per page (src/site.ts): `www.` and plain http go to the public origin, for good.
    const moved = canonicalRedirect(request, url, env);
    if (moved) return moved;
    // The public site first (src/site.ts): /robots.txt, /sitemap.xml and `/`, before any session check.
    const site = await sitePublic(request, env, url);
    if (site) return site;
    // Everything else the Worker answers is the app, its API, sign-in, MCP, a webhook or a signed link:
    // never indexed. The header goes on what a crawler can fetch (GET / HEAD) — JSON and redirects too,
    // where a meta tag cannot — and nothing else: a webhook's bare 401 stays bare.
    const res = await serve(request, env, ctx, url);
    return request.method === "GET" || request.method === "HEAD" ? noindex(res) : res;
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
  //    budget at that dispatcher. On every tick with no heavy job the AI pass
  //    (src/ai/pass.ts) follows the health pings on the same budget; its job
  //    registry is empty, so today it does nothing.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === DAILY_CRON || controller.cron === WEEKLY_CRON) {
      await pruneUsage(platform(env, "system")).catch(() => undefined); // org_usage_daily retention (400 days)
      await pruneLimits(platform(env, "system")).catch(() => undefined); // abuse_counters of past windows
      await pruneEvents(platform(env, "system")).catch(() => undefined); // billing_events past Stripe's retry horizon
      await pruneSyncRuns(platform(env, "system"), controller.scheduledTime).catch(() => undefined); // sync_runs retention (90 days)
      await handleNotificationCron(env, controller.cron, new Date(controller.scheduledTime));
      return;
    }
    if (controller.cron === REPO_CRON) await handleRepoCron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
