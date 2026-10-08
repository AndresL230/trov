// Vercel (#98) — a WEB part: one Vercel project's deploys (production, or the previews of one branch) from
// Vercel's REST API. Research: docs/superpowers/specs/2026-10-07-hosting-providers-research.md › Vercel.
//
//   connection   BEST: the Vercel Integration ("Connect with Vercel") — the admin installs it on their
//                personal account or one team and picks the projects it may see; Vercel sends the browser
//                back with a single-use `code` that `install.exchange` trades for a long-lived access token,
//                and an uninstall on Vercel's side reaches `POST /webhook/hosting/vercel` as
//                `integration-configuration.removed`. FALLBACK: a pasted access token — narrowest is a
//                PROJECT-scoped one (2026), else one team; Vercel has NO read-only token either way.
//   requests     `api.vercel.com` only, `Authorization: Bearer <token>`, and `teamId=<team_id>` on EVERY call
//                when the org's config names a team (without it Vercel looks in the personal account and a
//                team's project reads as a 404). vercel.com is the BROWSER host of the install page only —
//                no credential is ever sent there, so it is not in `apiHosts`.
//   deploys      ONE `GET /v7/deployments` per poll (`pollCost` 1): the 20 newest of the project, filtered to
//                the part's target. Vercel's list is the record of what shipped where, with the commit it
//                built — so unlike Cloudflare / Railway nothing here waits on a GitHub delivery.
//   metrics      NONE. Vercel has no documented public usage API: the `vercel metrics` CLI calls an
//                undocumented `POST /v2/observability/query` that needs Observability Plus (Pro /
//                Enterprise). So every web metric is `unavailable` with that reason, `covered` is null, and
//                nothing is ever stored as a zero — the dashboard says "not available", never "no traffic".
//
// UNCONFIRMED against the live API (no credential was available to the build; each is handled defensively
// and listed in the owner checks): the `meta` commit keys (`githubCommitSha` / `…Ref` / `…Message` and the
// gitlab / bitbucket spellings), whether `projectId=` accepts a project NAME as well as a `prj_` id (the SDK
// says "ID or name"), whether `target=preview` is accepted (not sent — previews are filtered client-side),
// the uninstall webhook's payload path to the configuration id and its HMAC-SHA1 signature, whether a
// project-scoped token may read `/v2/user`, whether an integration's token may read its own
// `/v1/integrations/configuration/{id}` (the exchange's confirmation of an id it did not return), and the
// team-scoped integrations page `manageUrl` links to.
//
// Pure apart from `pc.fetch` (the fixed-host fetch) — no D1, no env, no logging, no src/data/secrets.ts.
import { metricsForRole, type DeployState, type DeployTarget, type HostingMetric, type PartRole } from "@shared/hosting";
import type { HostingDeploy, HostingProvider, InstallGrant, ProviderContext } from "../types";
import {
  HostingError, asHostingError, instant, probeFailure, readJson, record, refuse, str,
  type HostFetch, type Revealed, type SecretLike,
} from "../http";

const API = "https://api.vercel.com";
const UA = "trov-hosting";
/** The newest deploys one poll reads (and returns). `hosting_deploys` is an upsert keyed by id, so a poll
 *  only has to see what changed since the last one: 20 covers far more than an hour of deploys. */
const DEPLOYS_LIMIT = 20;
/** The exchange's body is a handful of short strings — never read more than this of it. */
const EXCHANGE_READ_BYTES = 64_000;

// ── patterns (anchored; the registry's `checkFields` applies the settings ones on write) ─────────────────
const TEAM_ID = /^team_[A-Za-z0-9]{1,64}$/;
/** A team's — or a personal account's — URL slug: vercel.com/<slug>. */
const TEAM_SLUG = /^[a-z0-9-]{1,64}$/;
const PROJECT_ID = /^prj_[A-Za-z0-9]{1,64}$/;
/** A project id, or a project NAME (Vercel names are lower-case letters, digits, `.`, `_`, `-`, ≤ 100) —
 *  never `.` or `..` alone: the name goes into a URL PATH, where a dot segment (even `%2e%2e`) is resolved
 *  away and the read would land on another endpoint. */
const PROJECT = /^(?!\.{1,2}$)(?:prj_[A-Za-z0-9]{1,64}|[a-z0-9._-]{1,100})$/;
const TARGET = /^(?:production|preview)$/;
/** A git branch name, conservatively: no spaces, no `..`-style tricks matter here (it is only compared). */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/+-]{0,199}$/;
/** The integration's slug in vercel.com/integrations/<slug> (a Worker var, never a secret). */
const INTEGRATION_SLUG = /^[a-z0-9-]{1,100}$/;
/** Provider ids Trov stores or puts in a path: a deployment `dpl_…`, a configuration `icfg_…`, a user id.
 *  Deliberately looser than the documented prefixes — a format drift must not lose a whole poll. */
const VERCEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const NO_USAGE = "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)";
const NOT_A_SERVICE = "Vercel runs web parts only — it reports no CPU or memory";

/** Why a metric cannot be read for a part of `role` — every metric of the role, always (see the header). */
const unavailableFor = (role: PartRole): { metric: HostingMetric; reason: string }[] =>
  metricsForRole(role).map((metric) => ({ metric, reason: role === "web" ? NO_USAGE : NOT_A_SERVICE }));

/**
 * Vercel's `readyState` (falling back to `state`) → `DEPLOY_STATES`. Anything not named here is SKIPPED —
 * never guessed into a state:
 *
 *   QUEUED        → queued     waiting for a build slot
 *   INITIALIZING  → queued     the builder is being set up; nothing has run yet
 *   BUILDING      → building
 *   READY         → ready
 *   ERROR         → error
 *   CANCELED      → canceled   someone stopped it (or a newer push superseded it) — never a failure
 *   BLOCKED       → error      Vercel REFUSED to build it (a commit author outside the team, a protection
 *                              or spend rule): nothing shipped and a person must act, so it reads as a
 *                              failure. `canceled` would hide it under the dashboard's non-decisive policy.
 *   DELETED       → skipped    the deployment was removed after the fact; it is neither in flight nor a
 *                              failure, and a row stored while it existed keeps its last real state.
 */
const STATES: Readonly<Record<string, DeployState>> = {
  QUEUED: "queued", INITIALIZING: "queued", BUILDING: "building", READY: "ready", ERROR: "error", CANCELED: "canceled", BLOCKED: "error",
};
const IN_FLIGHT: ReadonlySet<DeployState> = new Set(["queued", "building"]);

/** The commit keys Vercel's git integrations put in a deployment's `meta` (a flat string map), per git
 *  provider. UNCONFIRMED spellings (from the SDK and CLI source): the first provider with ANY of its three
 *  keys present wins, and a value that does not look right is dropped on its own, never guessed. */
const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

// ── small helpers ────────────────────────────────────────────────────────────

/** A value fit to SHOW in a fixed-text detail: it matches `re`, else null (the caller falls back). */
const shown = (v: string | null, re: RegExp): string | null => (v && re.test(v) ? v : null);

/** One line of display text from an upstream: control characters out, whitespace folded, cut. */
const line = (v: unknown, max: number): string | null => {
  const s = str(v);
  if (!s) return null;
  const one = s.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return one || null;
};

/** An https URL from Vercel: `url` is a BARE host (`web-k3m9x2p7q-acme.vercel.app`), `inspectorUrl` a full
 *  URL — the scheme is added when absent. Anything that is not https once parsed is dropped. */
function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 500) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
    return u.pathname === "/" && !u.search && !u.hash ? u.href.slice(0, -1) : u.href;
  } catch { return null; }
}

/** An api.vercel.com URL: `path` + `params`, plus `teamId` whenever the org's config names a team. */
function apiUrl(path: string, config: Readonly<Record<string, string>>, params: Readonly<Record<string, string>> = {}): string {
  const u = new URL(path, API);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (config.team_id) u.searchParams.set("teamId", config.team_id);
  return u.toString();
}

/** The header block of every authenticated call. The token is revealed HERE and nowhere else. */
const authHeaders = (token: SecretLike | string): Record<string, string> => ({
  authorization: `Bearer ${typeof token === "string" ? token : token.reveal()}`,
  accept: "application/json",
  "user-agent": UA,
});

/** Fixed words for a 404 / 403 on a project read — what an admin should check. */
const PROJECT_HINTS: Readonly<Record<number, string>> = {
  404: "no such project — check the project name or id, that the token (or the installed integration) can see it, and Team ID when it belongs to a team",
  403: "the credential cannot read this project — a token scoped to another project or team, or an integration installed without it",
};
const ACCOUNT_HINTS: Readonly<Record<number, string>> = {
  403: "the credential cannot read the account — a token scoped to one project may not; add a part and test against its project",
};

/** One authenticated GET → its JSON body as a record. A thrown fetch / an unreadable body becomes a
 *  fixed-text `HostingError`; a non-2xx goes through `refuse` (scrubbed of the token BEFORE it is cut). */
async function getJson(pc: ProviderContext, what: string, url: string, hints?: Readonly<Record<number, string>>): Promise<Record<string, unknown>> {
  const secret = pc.credential.secret;
  let res: Response;
  try {
    res = await pc.fetch(url, { method: "GET", headers: authHeaders(secret) });
  } catch (e) { throw asHostingError(what, e); }
  if (!res.ok) await refuse(what, res, secret, hints);
  try {
    return record(await readJson(res, what));
  } catch (e) { throw asHostingError(what, e); }
}

/** A best-effort GET for a DISPLAY value with a fresh token (the install's account label): `{}` on any
 *  failure, never a throw — a missing label must not cost an admin the install. */
async function bestEffort(fetch: HostFetch, url: string, token: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(url, { method: "GET", headers: authHeaders(token) });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return {}; }
    return record(await readJson(res, "vercel account", EXCHANGE_READ_BYTES));
  } catch { return {}; }
}

/**
 * Does Vercel confirm `id` as the configuration THIS token belongs to? ONE `GET /v1/integrations/configuration/
 * {id}` (in the grant's team) with the new token: only a 200 whose body names exactly `id` is a yes. Anything
 * else — a 403 / 404, a thrown fetch, a body for another id or none — is a no, never a throw: the grant itself
 * is good, only the installation id stays unknown. UNCONFIRMED against the live API: that the endpoint answers
 * an integration's own access token (the SDK's `getConfiguration`, `{ id, … }`); if it does not, the id is
 * simply stored as null.
 */
async function confirmedConfiguration(fetch: HostFetch, id: string, config: Readonly<Record<string, string>>, token: string): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(`/v1/integrations/configuration/${encodeURIComponent(id)}`, config), { method: "GET", headers: authHeaders(token) });
    if (res.status !== 200) { await res.body?.cancel().catch(() => undefined); return false; }
    return str(record(await readJson(res, "vercel configuration", EXCHANGE_READ_BYTES)).id) === id;
  } catch { return false; }
}

/** The commit a deployment built, from its `meta` (see `GIT_PROVIDERS`). */
function gitOf(meta: Record<string, unknown>): { sha: string | null; branch: string | null; message: string | null } {
  for (const p of GIT_PROVIDERS) {
    const sha = str(meta[`${p}CommitSha`]), ref = str(meta[`${p}CommitRef`]), msg = str(meta[`${p}CommitMessage`]);
    if (!sha && !ref && !msg) continue;
    return {
      sha: sha && SHA.test(sha) ? sha.toLowerCase() : null,
      branch: ref && !/[\u0000-\u001f\u007f\s]/.test(ref) ? ref.slice(0, 200) : null,
      message: line(msg, 200),
    };
  }
  return { sha: null, branch: null, message: null }; // a CLI deploy (`vercel deploy`) carries no commit
}

/**
 * One list item → a `HostingDeploy`, or null (skipped on its own, never guessed): no usable id, a state not
 * in `STATES`, no creation time, a target other than the part's, or — for previews narrowed to a branch —
 * another branch.
 *
 * `target` is `"production"` / `"staging"` (custom environments) / null (a preview). A row with NO `target`
 * key at all is trusted to the server's filter when this poll asked for `target=production`, and skipped
 * otherwise (a preview cannot be told from a production deploy without it).
 */
function toDeploy(raw: unknown, want: "production" | "preview", branch: string | null): HostingDeploy | null {
  const d = record(raw);
  const id = str(d.uid) ?? str(d.id);
  if (!id || !VERCEL_ID.test(id)) return null;
  const vercelState = (str(d.readyState) ?? str(d.state))?.toUpperCase() ?? "";
  const state = Object.hasOwn(STATES, vercelState) ? STATES[vercelState] : null;
  if (!state) return null;
  const target: DeployTarget = !("target" in d) ? (want === "production" ? "production" : null)
    : d.target === "production" ? "production" : d.target === null ? "preview" : null;
  if (target !== want) return null;
  const createdAt = instant(d.created ?? d.createdAt);
  if (!createdAt) return null;
  const git = gitOf(record(d.meta));
  if (branch && git.branch !== branch) return null;
  return {
    id,
    state,
    target,
    sha: git.sha,
    branch: git.branch,
    message: git.message,
    by: line(record(d.creator).username, 100),
    createdAt,
    // `ready` is when the build finished — only meaningful once it HAS (an in-flight row has none).
    readyAt: IN_FLIGHT.has(state) ? null : instant(d.ready),
    url: httpsUrl(d.url),
    inspectUrl: httpsUrl(d.inspectorUrl),
  };
}

// ── the provider ─────────────────────────────────────────────────────────────

export const vercel: HostingProvider = {
  id: "vercel",
  label: "Vercel",
  status: "available",
  summary: "A Vercel project: its production deploys (or one branch's previews) with commit, branch, state and URL from Vercel's REST API. Vercel has no public usage API, so no traffic figures.",
  roles: ["web"],
  apiHosts: ["api.vercel.com"],
  docsUrl: "https://vercel.com/docs/rest-api",
  credentialScope: "org",
  connectionMethods: [
    {
      method: "install",
      label: "Connect with Vercel",
      howTo: "Vercel opens its install screen for Trov's integration: pick your personal account or the team that owns the project, choose \"Specific Projects\" and select only the projects Trov should read (\"All Projects\" works but grants more), then confirm — Vercel sends you back here. Trov asks for read access to projects and deployments only. Uninstalling the integration on Vercel (Settings › Integrations) disconnects Trov too. The access token Vercel issues is stored encrypted and only ever sent to api.vercel.com.",
      grants: ["Projects: Read — on the projects you pick", "Deployments: Read — on the projects you pick"],
      requires: ["VERCEL_INTEGRATION_CLIENT_ID", "VERCEL_INTEGRATION_CLIENT_SECRET", "VERCEL_INTEGRATION_SLUG"],
    },
    {
      method: "token",
      label: "Paste an access token",
      howTo: "In Vercel open Account Settings › Tokens › Create Token. Scope it to the ONE project Trov should read (a project-scoped token) — or, where that is not offered, to the one team that owns it; never Full Account — and set an expiry (Vercel allows 1 day to 1 year; Trov shows a 401 when it lapses). Vercel has no read-only token: whoever holds it can also change what it reaches, which is why one project is the narrowest choice. When the project belongs to a team, also set Team ID below. The token is only ever sent to api.vercel.com.",
      grants: ["Full access to ONE project (or one team) — Vercel has no read-only token"],
    },
  ],
  orgConfigFields: [
    { key: "team_id", label: "Team ID", description: "The team that owns the projects (Team Settings › General › Team ID). Leave empty for a personal account. Filled in for you when you connect with Vercel.", required: false, placeholder: "team_a1B2c3D4e5F6g7H8i9J0k1L2", pattern: TEAM_ID },
    { key: "team_slug", label: "Team URL slug", description: "The name in your Vercel dashboard's address (vercel.com/<slug>) — your username for a personal account. Used only for links to Vercel.", required: false, placeholder: "acme", pattern: TEAM_SLUG },
  ],
  partSettings: [
    { key: "project", label: "Project", description: "The Vercel project's name, or its id (prj_…, Project › Settings › General).", required: true, placeholder: "my-web-app", pattern: PROJECT },
    { key: "target", label: "Deploys shown", description: "production (the default): the project's production deploys. preview: its preview deploys — set Branch to narrow them to one branch (e.g. a staging environment = the previews of main).", required: false, placeholder: "production", pattern: TARGET },
    { key: "branch", label: "Branch (previews only)", description: "With preview: show only the previews of this git branch, e.g. main. Ignored for production.", required: false, placeholder: "main", pattern: BRANCH },
  ],
  capabilities: { deploys: true, metrics: [] },
  planNote: "Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented), so a Vercel part shows deploys only.",
  pollCost: 1,

  // Where the grant is managed. An installed integration: the team's integrations page when the install told
  // Trov the team (`team_id` + `team_slug`) — `vercel.com/<team-slug>/~/integrations`, UNCONFIRMED (the
  // pattern Vercel's own `next` URL used in the research, not a documented page) — else the dashboard's
  // integrations page, which picks the scope itself. A pasted token: the account's tokens page.
  manageUrl(config, method) {
    if (method === "token") return "https://vercel.com/account/tokens";
    if (method !== "install") return null;
    const slug = config.team_slug;
    if (config.team_id && TEAM_ID.test(config.team_id) && slug && TEAM_SLUG.test(slug)) return `https://vercel.com/${encodeURIComponent(slug)}/~/integrations`;
    return "https://vercel.com/dashboard/integrations";
  },

  // vercel.com/<scope>/<project NAME> is exact; a `prj_` id has no dashboard URL of its own, and without the
  // slug the scope is unknown — so null rather than a guess.
  consoleUrl(part, config) {
    const project = part.settings.project, slug = config.team_slug;
    if (!project || !slug || PROJECT_ID.test(project) || !PROJECT.test(project) || !TEAM_SLUG.test(slug)) return null;
    return `https://vercel.com/${encodeURIComponent(slug)}/${encodeURIComponent(project)}`;
  },

  // ONE fetch. With a part: the project itself (`GET /v9/projects/{idOrName}`) — proves the credential AND
  // that it reaches this project in this scope. Without one: the team (when Team ID is set) or the token's
  // own user, which proves the credential alone.
  async probe(pc, part) {
    const config = pc.credential.config;
    // "(team …)" only when a team is configured — a personal account's slug is its username, not a team.
    const scope = config.team_id ? shown(config.team_slug ?? null, TEAM_SLUG) ?? shown(config.team_id, TEAM_ID) : null;
    const inTeam = scope ? ` (team ${scope})` : "";
    try {
      if (part) {
        const project = part.settings.project;
        if (!project || !PROJECT.test(project)) return { ok: false, detail: "this part has no valid Vercel project set" };
        const body = await getJson(pc, "vercel project", apiUrl(`/v9/projects/${encodeURIComponent(project)}`, config), PROJECT_HINTS);
        const name = shown(str(body.name), PROJECT) ?? project;
        return { ok: true, detail: `Vercel answered for project ${name}${inTeam}.` };
      }
      if (config.team_id) {
        const body = await getJson(pc, "vercel team", apiUrl(`/v2/teams/${encodeURIComponent(config.team_id)}`, config), ACCOUNT_HINTS);
        const slug = shown(str(body.slug), TEAM_SLUG) ?? scope ?? "this team";
        return { ok: true, detail: `Vercel answered for team ${slug}.` };
      }
      const body = await getJson(pc, "vercel user", apiUrl("/v2/user", config), ACCOUNT_HINTS);
      const username = shown(str(record(body.user).username), USERNAME);
      return { ok: true, detail: username ? `Vercel answered for ${username}'s account.` : "Vercel answered for this token's account." };
    } catch (e) {
      return probeFailure("vercel", e); // keeps a refusal's status: a 401 ends an installed connection
    }
  },

  // ONE fetch: `GET /v7/deployments?projectId=…&limit=20[&target=production][&teamId=…]`.
  //   production  `target=production` is sent AND re-checked per row (a server that ignored the filter must
  //               not put previews on a production strip).
  //   preview     no `target` is sent (whether Vercel accepts `target=preview` is UNCONFIRMED); rows whose
  //               `target` is null are kept, and with Branch set only that branch's. So a busy project may
  //               leave fewer than 20 — harmless: deploys are upserted by id, and each poll only needs what
  //               changed since the last.
  // No metric is read (see the header): every metric of the part's role is `unavailable`, `covered` null.
  async poll(pc, part) {
    const project = part.settings.project;
    if (!project || !PROJECT.test(project)) throw new HostingError("this part has no valid Vercel project set");
    const want = part.settings.target === "preview" ? "preview" : "production";
    const branch = want === "preview" ? part.settings.branch || null : null;
    const params: Record<string, string> = { projectId: project, limit: String(DEPLOYS_LIMIT) };
    if (want === "production") params.target = "production";
    const body = await getJson(pc, "vercel deployments", apiUrl("/v7/deployments", pc.credential.config, params), PROJECT_HINTS);
    if (!Array.isArray(body.deployments)) throw new HostingError("vercel deployments: the response has no deployments list");
    const seen = new Set<string>();
    const deploys: HostingDeploy[] = [];
    for (const item of body.deployments) {
      const d = toDeploy(item, want, branch);
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      deploys.push(d);
    }
    // Newest first, whatever order the page came in (ISO strings of one format sort as instants).
    deploys.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return { deploys: deploys.slice(0, DEPLOYS_LIMIT), points: [], unavailable: unavailableFor(part.role), covered: null };
  },

  install: {
    clientIdVar: "VERCEL_INTEGRATION_CLIENT_ID",
    clientSecretVar: "VERCEL_INTEGRATION_CLIENT_SECRET",

    // The Integration's install page on vercel.com (the BROWSER host — no credential goes there). Its Redirect
    // URL is not a parameter: it is fixed in Vercel's Integration Console as `<origin>/hosting/vercel/callback`,
    // so `redirectUri` / `clientId` are not sent; `state` comes back on the callback untouched.
    authorizeUrl({ state, vars }) {
      const slug = vars.VERCEL_INTEGRATION_SLUG;
      if (!slug || !INTEGRATION_SLUG.test(slug)) throw new HostingError("the Vercel integration's slug is not configured");
      const u = new URL(`https://vercel.com/integrations/${encodeURIComponent(slug)}/new`);
      u.searchParams.set("state", state);
      return u.toString();
    },

    // `POST /v2/oauth/access_token` (form-encoded) → `{ token_type, access_token, installation_id, user_id,
    // team_id }` (team_id null = a personal account). The response is validated whole, else a fixed-text
    // refusal; the client secret and the code are scrubbed from any upstream message (`revealed`).
    //
    // THE INSTALLATION ID NEVER COMES FROM THE URL. The callback's `configurationId` is something anyone can
    // type, and the id is what binds the installation to ONE org and what an uninstall notice revokes by — so
    // a typed id must not be able to claim another org's installation (or get its uninstall). The exchange's
    // own `installation_id` is used when present. Without it, the callback's `configurationId` is only a
    // CANDIDATE: ONE `GET /v1/integrations/configuration/{id}` (in the grant's team) with the NEW token must
    // answer 200 for exactly that id — Vercel answers that only for a configuration this token belongs to —
    // else the id is stored as null (Disconnect then removes nothing on Vercel's side; the token still works).
    //
    // Then ONE best-effort read with the new token for the account's display name and URL slug
    // (`/v2/teams/{id}` or `/v2/user`) — 3 requests at most, and a failure there only leaves the label empty.
    async exchange({ fetch, code, clientId, clientSecret, redirectUri, query }) {
      const what = "vercel token exchange";
      const revealed: Revealed = [clientSecret, code];
      let res: Response;
      try {
        res = await fetch(`${API}/v2/oauth/access_token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": UA },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString(),
        });
      } catch (e) { throw asHostingError(what, e); }
      if (!res.ok) await refuse(what, res, revealed);
      let body: Record<string, unknown>;
      try {
        body = record(await readJson(res, what, EXCHANGE_READ_BYTES));
      } catch (e) { throw asHostingError(what, e); }

      const accessToken = str(body.access_token);
      const { token_type: tokenType, team_id: teamId, user_id: userId, installation_id: installationId } = body;
      const optional = (v: unknown, re: RegExp) => v === undefined || v === null || (typeof v === "string" && re.test(v));
      if (!accessToken || accessToken.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(accessToken)
        || !(tokenType === undefined || (typeof tokenType === "string" && tokenType.toLowerCase() === "bearer"))
        || !optional(teamId, TEAM_ID) || !optional(userId, VERCEL_ID) || !optional(installationId, VERCEL_ID)) {
        throw new HostingError(`${what}: the response is not in the expected form`); // fixed text: nothing quoted
      }
      const team = typeof teamId === "string" ? teamId : null;
      const user = typeof userId === "string" ? userId : null;
      const config: Record<string, string> = {};
      if (team) config.team_id = team;
      // The installation id: the exchange's own `installation_id`, else the callback's `configurationId` ONLY
      // once Vercel confirms it for this token (see above) — never the URL's word alone.
      const candidate = query.configurationId && VERCEL_ID.test(query.configurationId) ? query.configurationId : null;
      const externalId = typeof installationId === "string" ? installationId
        : candidate && (await confirmedConfiguration(fetch, candidate, config, accessToken)) ? candidate : null;

      let accountLabel: string | null = null;
      if (team) {
        const t = await bestEffort(fetch, apiUrl(`/v2/teams/${encodeURIComponent(team)}`, config), accessToken);
        const slug = shown(str(t.slug), TEAM_SLUG);
        if (slug) config.team_slug = slug;
        accountLabel = line(t.name, 100) ?? slug;
      } else {
        const u = record((await bestEffort(fetch, apiUrl("/v2/user", config), accessToken)).user);
        const username = shown(str(u.username), TEAM_SLUG);
        if (username) config.team_slug = username; // a personal account's dashboard lives at vercel.com/<username>
        accountLabel = username; // the handle, not the person's full name
      }
      const grant: InstallGrant = { accessToken, externalId, accountId: team ?? user, accountLabel, config };
      return grant;
    },

    // `DELETE /v1/integrations/configuration/{id}` with the installation's own token. A 404 means it is
    // already gone (uninstalled on Vercel's side) — the goal is met, so it is a success. No id: nothing to
    // remove on Vercel's side (a pasted token; or a refused grant whose installation is ANOTHER org's live one —
    // Vercel's only removal is the whole configuration, so the connect callback passes null), so no request.
    async revoke({ fetch, secret, externalId, config }) {
      if (!externalId) return;
      const what = "vercel uninstall";
      if (!VERCEL_ID.test(externalId)) throw new HostingError(`${what}: the installation id is not in the expected form`);
      let res: Response;
      try {
        res = await fetch(apiUrl(`/v1/integrations/configuration/${encodeURIComponent(externalId)}`, config), { method: "DELETE", headers: authHeaders(secret) });
      } catch (e) { throw asHostingError(what, e); }
      if (res.ok || res.status === 404) { await res.body?.cancel().catch(() => undefined); return; }
      await refuse(what, res, secret);
    },

    webhook: {
      // `x-vercel-signature` = hex HMAC-SHA1 of the RAW body keyed with the integration's Client Secret
      // (UNCONFIRMED against Vercel's own page — the owner confirms on a real uninstall). Compared by Web
      // Crypto's `verify`, which is constant-time; a header that is not 40 hex digits is refused before it.
      async verify({ rawBody, headers, clientSecret }) {
        const sig = (headers.get("x-vercel-signature") ?? "").trim().toLowerCase();
        if (!clientSecret || !/^[0-9a-f]{40}$/.test(sig)) return false;
        const bytes = new Uint8Array(20);
        for (let i = 0; i < 20; i++) bytes[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
        try {
          const enc = new TextEncoder();
          const key = await crypto.subtle.importKey("raw", enc.encode(clientSecret), { name: "HMAC", hash: "SHA-1" }, false, ["verify"]);
          return await crypto.subtle.verify("HMAC", key, bytes, enc.encode(rawBody));
        } catch { return false; }
      },

      // `{ type: "integration-configuration.removed", payload: { configuration: { id }, team, user } }` — the
      // documented shape. The exact path to the id is UNCONFIRMED, so the flat `payload.configurationId` an
      // older delivery format used is accepted too. Any other event (deployment.*, project.*) is null.
      removedExternalId(payload) {
        const p = record(payload);
        if (p.type !== "integration-configuration.removed") return null;
        const inner = record(p.payload);
        const id = str(record(inner.configuration).id) ?? str(inner.configurationId);
        return id && VERCEL_ID.test(id) ? id : null;
      },
    },
  },
};
