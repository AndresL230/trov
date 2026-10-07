// Netlify (#100) — a WEB host: one Netlify site per part, read from Netlify's REST API
// (`https://api.netlify.com/api/v1`, `Authorization: Bearer <token>`). What Trov can read, and what it cannot:
//
//   deploys   YES — `GET /sites/{site_id}/deploys`, ≤ 20 newest first: state, commit, branch, deploy context,
//             title, permalink. A part reads EITHER the site's production deploys (`production=true`) OR one
//             branch's (`branch=<b>`: its branch deploys and the deploy previews of PRs from it) — the
//             `context` part setting. ONE request per poll (`pollCost` 1).
//   metrics   NO — Netlify publishes no usage or analytics API: Observability is dashboard-only and the
//             analytics endpoints its dashboard calls are undocumented, so building on them would be guessing
//             at a shape that can change under us. Every web metric is `unavailable` with that reason, `covered`
//             is null, and the Usage tab says "unavailable", never "0" (never guess).
//
// Connection, best first (#97: install > oauth > token — Netlify offers no installable integration an
// outside poller can use: an Extension's token works only inside an extension hosted ON Netlify):
//   oauth   "Connect with Netlify" — an OAuth application Trov's OPERATOR registers once (Netlify › User
//           settings › Applications › OAuth applications › New OAuth app — path UNCONFIRMED; Redirect URI
//           `<origin>/hosting/netlify/callback`) and puts in `NETLIFY_OAUTH_CLIENT_ID` /
//           `NETLIFY_OAUTH_CLIENT_SECRET`. Netlify OAuth has NO SCOPES: the token acts as the person who
//           approves it, across every team they belong to, and no expiry or refresh is documented. There is no
//           documented revoke API (so `install.revoke` is absent: Disconnect deletes Trov's copy and the person
//           revokes the grant on Netlify) and no uninstall notice (so no `install.webhook`: a revoked grant
//           surfaces as a 401 on the next poll, which the framework records).
//   token   a personal access token — the same reach as OAuth (Netlify has no scoped or read-only token),
//           pasted by hand, with the expiration the person chose.
//
// The credential is sent ONLY to api.netlify.com (`apiHosts`; ./http.ts refuses every other host and never
// follows a redirect). The browser — never the credential — goes to app.netlify.com for the consent screen and
// the console links. Nothing here logs; every message is fixed text or `refuse`'s scrubbed reason.
//
// UNCONFIRMED (researched from netlify/open-api's swagger.yml; vendor docs were unreachable from the build —
// docs/superpowers/specs/2026-10-07-hosting-providers-research.md › Netlify), each handled defensively below:
//   - the deploy `committer` field (outside the swagger's documented set) → `by`, null when absent;
//   - `skipped: true` on a build the ignore command cancelled, and the "Canceled build…" `error_message` a
//     cancelled build carries under `state: "error"`;
//   - the deploy's `name` being the SITE's name, and `https://app.netlify.com/sites/<name>/deploys/<id>` being
//     its log page (Netlify renamed sites to "projects" in its UI; the /sites/ links are expected to redirect);
//   - the token endpoint's response (`access_token` is all Trov reads) and the OAuth error body.
import { metricsForRole, type DeployState } from "@shared/hosting";
import type { HostingDeploy, HostingField, HostingProvider, InstallGrant, PartRef, ProviderContext } from "../types";
import { HostingError, type Revealed, type SecretLike, asHostingError, instant, readJson, record, refuse, str } from "../http";

const API = "https://api.netlify.com/api/v1";
const TOKEN_URL = "https://api.netlify.com/oauth/token";
const AUTHORIZE_URL = "https://app.netlify.com/authorize";
const APP = "https://app.netlify.com";
/** Netlify asks API clients to identify themselves with a User-Agent. */
const USER_AGENT = "trov-hosting";
const DEPLOYS_PER_POLL = 20;

const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Netlify site name — its `<name>.netlify.app` subdomain: lower-case letters, digits and hyphens. */
const SITE_NAME = /^[a-z0-9-]{1,63}$/;
/** Git allows more, but a branch Trov puts in a query string is kept to the characters real branches use. */
const BRANCH = /^[A-Za-z0-9._/+@-]{1,200}$/;
/** Netlify deploy ids are 24 hex characters (Mongo object ids); accepted a little wider, never with a `/`. */
const DEPLOY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
/** A bearer token Trov will put in a header: printable ASCII, no spaces, a sane length. */
const TOKEN_SHAPE = /^[\x21-\x7e]{8,1024}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const NO_USAGE_API = "Netlify exposes no public usage API (Observability is dashboard-only)";
const NOT_A_SERVICE = "Netlify hosts sites, not long-running services — there is no CPU or memory to read";
const NO_SITE_ID = "Netlify: the part has no Site ID";
const BRANCH_MISSING = "Netlify: \"Deploy context\" is branch but the part has no Branch — set the branch whose deploys Trov should read";

/** Fixed words for what Netlify's refusals mean HERE (./http.ts `statusHint` appends them). */
const TOKEN_HINTS = { 401: "the token is not valid (expired, revoked, or the Netlify OAuth grant was removed)" } as const;
const SITE_HINTS = {
  ...TOKEN_HINTS,
  404: "no site with this Site ID that the token can see (check the Site ID, and that the token's account is on the site's team)",
} as const;
const EXCHANGE_HINTS = {
  400: "the code expired or was already used, or the redirect URI does not match the OAuth application's",
  401: "the OAuth application's client id or secret is not valid",
} as const;

const PART_SETTINGS: readonly HostingField[] = [
  {
    key: "site_id", label: "Site ID", required: true, placeholder: "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c", pattern: SITE_ID,
    description: "The site's API id, a UUID: Site configuration › Site details › Site ID (Netlify now calls sites \"projects\", so it may read Project configuration › Project details › Project ID).",
  },
  {
    key: "context", label: "Deploy context", required: false, placeholder: "production", pattern: /^(production|branch)$/,
    description: "production (the default) reads the site's production deploys; branch reads the deploys of the Branch below — its branch deploys and the deploy previews of pull requests from it.",
  },
  {
    key: "branch", label: "Branch", required: false, placeholder: "staging", pattern: BRANCH,
    description: "The Git branch whose deploys to read. Required when Deploy context is branch; ignored for production.",
  },
  {
    key: "site_name", label: "Site name", required: false, placeholder: "my-site", pattern: SITE_NAME,
    description: "Optional: the site's name (its <name>.netlify.app subdomain), used only for the Open in Netlify link — Trov polls by Site ID.",
  },
];

// ── reading helpers ──────────────────────────────────────────────────────────

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`, accept: "application/json", "user-agent": USER_AGENT,
});

/** One authenticated GET → its JSON. A non-2xx is `refuse`d (scrubbed); a thrown fetch or a bad body becomes a
 *  fixed-text `HostingError` (`asHostingError` never repeats the original, which could quote the request). */
async function getJson(pc: ProviderContext, url: string, what: string, hints: Readonly<Record<number, string>>): Promise<unknown> {
  const secret: SecretLike = pc.credential.secret;
  try {
    const res = await pc.fetch(url, { method: "GET", headers: bearer(secret.reveal()) });
    if (!res.ok) await refuse(what, res, secret, hints);
    return await readJson(res, what);
  } catch (e) {
    throw asHostingError(what, e);
  }
}

/** Upstream text for one line of a detail or a card: whitespace collapsed, cut, or null. */
function oneLine(v: unknown, max: number): string | null {
  const s = str(v)?.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** A commit title's FIRST line (Netlify's `title` is the whole commit message). */
function firstLine(v: unknown): string | null {
  const s = str(v);
  return s ? oneLine(s.split(/\r?\n/)[0], 200) : null;
}

/** An https URL as reported — a bare host gains the scheme; anything that is not https is dropped. */
function httpsUrl(v: unknown): string | null {
  const s = str(v)?.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" && !u.username && !u.password ? withScheme : null;
  } catch { return null; }
}

/** The site's address, for a probe's detail only (a custom domain's `url` may be plain http). */
function displayUrl(v: unknown): string | null {
  const s = oneLine(v, 200);
  return s && /^https?:\/\/[^\s/]+/i.test(s) ? s : null;
}

const siteName = (v: unknown): string | null => {
  const s = str(v)?.toLowerCase();
  return s && SITE_NAME.test(s) ? s : null;
};

/** Who a Netlify user record is, for a label: their full name, else their email. */
const accountLabel = (user: Record<string, unknown>): string | null => oneLine(user.full_name, 100) ?? oneLine(user.email, 100);

// ── deploys ──────────────────────────────────────────────────────────────────

/**
 * Netlify deploy `state` → `DEPLOY_STATES`:
 *
 *   new, pending_review, accepted, enqueued, retrying              → queued    (waiting to build; `pending_review`
 *                                                                               is a deploy awaiting a team member's
 *                                                                               approval, `accepted` one approved)
 *   building, uploading, uploaded, preparing, prepared,
 *   processing, processed                                          → building  (the build and the upload/post-
 *                                                                               processing that follows it)
 *   ready                                                          → ready
 *   error                                                          → error
 *   rejected                                                       → error     (a deploy that FAILED review — a team
 *                                                                               member declined it; mapped to error, not
 *                                                                               canceled, because the change that was
 *                                                                               pushed did not ship and someone should
 *                                                                               look: a canceled dot reads as "nothing
 *                                                                               to see")
 *   canceled / cancelled (UNCONFIRMED: not in the documented list) → canceled
 *   `skipped: true`, whatever the state                            → canceled  (the build was skipped — e.g. the
 *                                                                               ignore command said nothing changed)
 *   error with an error_message starting "Canceled build" /
 *   "Cancelled build" (UNCONFIRMED: how Netlify reports a build a
 *   person or the ignore command cancelled)                        → canceled  (abandoned, never a failure — the
 *                                                                               Repo dashboard's non-decisive policy)
 *   anything else                                                  → the item is SKIPPED, never guessed
 *
 * A Map, not an object literal: `state: "constructor"` must not find `Object.prototype`'s.
 */
const STATE = new Map<string, DeployState>([
  ["new", "queued"], ["pending_review", "queued"], ["accepted", "queued"], ["enqueued", "queued"], ["retrying", "queued"],
  ["building", "building"], ["uploading", "building"], ["uploaded", "building"], ["preparing", "building"],
  ["prepared", "building"], ["processing", "building"], ["processed", "building"],
  ["ready", "ready"],
  ["error", "error"], ["rejected", "error"],
  ["canceled", "canceled"], ["cancelled", "canceled"],
]);
const CANCELED_BUILD = /^cancell?ed build\b/i;

function deployState(d: Record<string, unknown>): DeployState | null {
  if (d.skipped === true) return "canceled";
  const raw = str(d.state)?.toLowerCase();
  const state = raw ? STATE.get(raw) ?? null : null;
  if (raw === "error" && CANCELED_BUILD.test(str(d.error_message)?.trim() ?? "")) return "canceled";
  return state;
}

/**
 * One deploy, normalised — or null when it is malformed (no id, an unknown state, no creation time), so the
 * items after it still land. `context` `production` → production; any other context (`deploy-preview`,
 * `branch-deploy`, `dev`…) → preview; none → unknown. `url` is the deploy's own permalink (`deploy_ssl_url`),
 * else the site's https address; `inspectUrl` is the deploy's log page when the site's name is known (the
 * deploy's own `name`, else the part's `site_name`), else the site's admin page.
 */
function toDeploy(v: unknown, partSiteName: string | null): HostingDeploy | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = record(v);
  const id = str(d.id);
  if (!id || !DEPLOY_ID.test(id)) return null;
  const state = deployState(d);
  if (!state) return null;
  const createdAt = instant(d.created_at);
  if (!createdAt) return null;
  const context = str(d.context);
  const sha = str(d.commit_ref);
  const name = siteName(d.name) ?? partSiteName;
  return {
    id,
    state,
    target: context === null ? null : context === "production" ? "production" : "preview",
    sha: sha && SHA.test(sha) ? sha.toLowerCase() : null,
    branch: oneLine(d.branch, 200),
    message: firstLine(d.title),
    by: oneLine(d.committer, 100),
    createdAt,
    readyAt: instant(d.published_at),
    url: httpsUrl(d.deploy_ssl_url) ?? httpsUrl(d.ssl_url),
    inspectUrl: name ? `${APP}/sites/${encodeURIComponent(name)}/deploys/${encodeURIComponent(id)}` : httpsUrl(d.admin_url),
  };
}

type Reads = { production: true } | { production: false; branch: string };

/** Which deploys the part reads. `checkFields` cannot say "Branch is required when Deploy context is branch",
 *  so it is enforced here, before any request: a poll throws (recorded as failed), a probe answers `ok: false`. */
function readsOf(part: PartRef): Reads {
  if (part.settings.context !== "branch") return { production: true };
  const branch = part.settings.branch;
  if (!branch) throw new HostingError(BRANCH_MISSING);
  return { production: false, branch };
}

function siteIdOf(part: PartRef): string {
  const id = part.settings.site_id;
  if (!id) throw new HostingError(NO_SITE_ID);
  return id;
}

function deploysUrl(siteId: string, reads: Reads): string {
  const u = new URL(`${API}/sites/${encodeURIComponent(siteId)}/deploys`);
  u.searchParams.set("per_page", String(DEPLOYS_PER_POLL));
  if (reads.production) u.searchParams.set("production", "true");
  else u.searchParams.set("branch", reads.branch);
  return u.toString();
}

// ── the provider ─────────────────────────────────────────────────────────────

export const netlify: HostingProvider = {
  id: "netlify",
  label: "Netlify",
  status: "available",
  summary: "A Netlify site: its production or branch deploys (state, commit, branch, link) from Netlify's API. Netlify has no public usage API, so no traffic figures.",
  roles: ["web"],
  apiHosts: ["api.netlify.com"],
  docsUrl: "https://docs.netlify.com/api/get-started/",
  credentialScope: "org",
  connectionMethods: [
    {
      method: "oauth",
      label: "Connect with Netlify",
      howTo: "Connect with Netlify sends you to Netlify to approve Trov's OAuth application, then back here. Netlify OAuth has NO scopes: the token acts as the person who approves it, across every team they belong to — so approve with an account that belongs only to the team whose sites Trov should see. Trov only reads deploys. Disconnecting here deletes Trov's copy; to end the grant on Netlify's side too, revoke Trov under User settings › Applications. The token is only ever sent to api.netlify.com.",
      grants: [
        "Everything the approving Netlify account can do, across every team it belongs to — Netlify OAuth has no scopes",
        "Trov uses it only to read sites and their deploys",
      ],
      requires: ["NETLIFY_OAUTH_CLIENT_ID", "NETLIFY_OAUTH_CLIENT_SECRET"],
    },
    {
      method: "token",
      label: "Paste a personal access token",
      howTo: "In Netlify open User settings › Applications › Personal access tokens › New access token, name it \"Trov\" and set an expiration (paste a new one here when it runs out). Netlify has no scoped or read-only tokens: it has full access to your account and every team you belong to, so create it from an account that belongs only to the team whose sites Trov should see. Tick the SAML-team access box only if the site lives in a SAML-based team. The token is only ever sent to api.netlify.com.",
      grants: ["Full access to the account that creates it and every team it belongs to (Netlify has no read-only or per-site token)"],
    },
  ],
  orgConfigFields: [],
  partSettings: PART_SETTINGS,
  capabilities: { deploys: true, metrics: [] },
  planNote: "Netlify publishes no usage or analytics API (Observability is dashboard-only), so a Netlify part shows its deploys but no traffic.",
  pollCost: 1,

  consoleUrl(part) {
    const name = siteName(part.settings.site_name);
    return name ? `${APP}/sites/${encodeURIComponent(name)}/overview` : null;
  },

  /**
   * One request. Without a part: `GET /user` — the token is valid, and whose it is. With one: `GET /sites/{id}`
   * — the token's account can see the site the part names (a 404 is the useful answer here: wrong id, or a
   * site on a team the account is not in). A part whose Branch is missing fails before any request.
   */
  async probe(pc, part) {
    try {
      if (!part) {
        const who = accountLabel(record(await getJson(pc, `${API}/user`, "netlify user", TOKEN_HINTS)));
        return { ok: true, detail: who ? `Netlify answered: the token belongs to ${who}.` : "Netlify answered: the token is valid." };
      }
      const siteId = siteIdOf(part);
      const reads = readsOf(part);
      const site = record(await getJson(pc, `${API}/sites/${encodeURIComponent(siteId)}`, "netlify site", SITE_HINTS));
      const name = siteName(site.name) ?? siteId;
      const where = displayUrl(site.ssl_url) ?? displayUrl(site.url);
      const what = reads.production ? "its production deploys" : `the deploys of branch ${reads.branch}`;
      return { ok: true, detail: `Netlify answered for site ${name}${where ? ` (${where})` : ""}. Trov reads ${what}.` };
    } catch (e) {
      return { ok: false, detail: asHostingError("netlify", e).message };
    }
  },

  /**
   * One request: the part's ≤ 20 newest deploys. No metric is ever read (see the header), so every metric of
   * the part's role is `unavailable` and `covered` is null. A non-2xx throws a scrubbed `HostingError`; a body
   * that is not a list throws too (never read as "no deploys"); a malformed item is skipped on its own.
   */
  async poll(pc, part) {
    const unavailable = metricsForRole(part.role).map((metric) => ({ metric, reason: part.role === "web" ? NO_USAGE_API : NOT_A_SERVICE }));
    const siteId = siteIdOf(part);
    const reads = readsOf(part);
    const body = await getJson(pc, deploysUrl(siteId, reads), "netlify deploys", SITE_HINTS);
    if (!Array.isArray(body)) throw new HostingError("netlify deploys: the response is not a list of deploys");
    const partSiteName = siteName(part.settings.site_name);
    const seen = new Set<string>();
    const deploys: HostingDeploy[] = [];
    for (const item of body) {
      const d = toDeploy(item, partSiteName);
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      deploys.push(d);
    }
    deploys.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { deploys: deploys.slice(0, DEPLOYS_PER_POLL), points: [], unavailable, covered: null };
  },

  install: {
    authorizeUrl({ clientId, redirectUri, state }) {
      const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, state });
      return `${AUTHORIZE_URL}?${q.toString()}`;
    },

    /**
     * The authorization-code exchange (`POST /oauth/token`, form-encoded), then ONE `GET /user` for the label
     * the connection shows (the approving person: `full_name`, else `email`; `id` as the account id). Every
     * message is scrubbed of the client secret, the code and — once it exists — the new token. A refused
     * `/user` fails the exchange: a token that cannot read the person who approved it cannot read their sites.
     * Netlify grants carry no installation id (`externalId` null) and no org config.
     */
    async exchange({ fetch: send, code, clientId, clientSecret, redirectUri }): Promise<InstallGrant> {
      const revealed: Revealed[] = [clientSecret, code];
      try {
        const res = await send(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
          body: new URLSearchParams({
            grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          }).toString(),
        });
        if (!res.ok) await refuse("netlify token exchange", res, revealed, EXCHANGE_HINTS);
        const accessToken = str(record(await readJson(res, "netlify token exchange")).access_token);
        if (!accessToken) throw new HostingError("netlify token exchange: the response carries no access token");
        revealed.push(accessToken);
        if (!TOKEN_SHAPE.test(accessToken)) throw new HostingError("netlify token exchange: the access token is not in the expected form", revealed);
        const ures = await send(`${API}/user`, { method: "GET", headers: bearer(accessToken) });
        if (!ures.ok) await refuse("netlify user", ures, revealed, TOKEN_HINTS);
        const user = record(await readJson(ures, "netlify user"));
        const id = str(user.id);
        return { accessToken, externalId: null, accountId: id && ACCOUNT_ID.test(id) ? id : null, accountLabel: accountLabel(user), config: {} };
      } catch (e) {
        throw asHostingError("netlify token exchange", e);
      }
    },

    // No `revoke`: Netlify documents no API to revoke an OAuth grant, so Disconnect deletes Trov's copy only and
    // the person revokes Trov under Netlify › User settings › Applications. No `webhook`: Netlify sends no
    // notice when a grant is revoked — the next poll's 401 is how Trov learns of it.
    clientIdVar: "NETLIFY_OAUTH_CLIENT_ID",
    clientSecretVar: "NETLIFY_OAUTH_CLIENT_SECRET",
  },
};
