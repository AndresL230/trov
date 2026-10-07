// Typed fetch layer over the real (cookie-gated) Worker routes — the ONLY place
// that knows route URLs and response shapes. Row types come from @shared/rows;
// the route RESPONSE envelopes + SearchResult + progress live in src/tools/* (not
// @shared, and web/ can't import src/), so they are re-declared here atop the
// @shared rows. All requests carry the session cookie (credentials:"same-origin");
// the MCP bearer is for /mcp only and never appears here.
import type {
  FeedRow, DocRow, DocMetaRow, DocVersionRow, AdrRow, NeedsTriageRow, EventRow,
  PersonColor,
} from "@shared/rows";
// Type-only (erased at build): the sprint DTOs the roadmap renders. Importing the
// zod module for types costs the bundle nothing.
import type { SprintView, SprintDetail, SprintCreate } from "@shared/sprints";
import type {
  TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter, TicketCategory, TicketCreate,
} from "@shared/tickets";
import type { DashboardData } from "@shared/dashboard";
import type { FeedStats } from "@shared/feed-stats";
import type { RepoDashboard, RepoRefreshResult } from "@shared/repo";
import type { Cadence, PrefsView, PolicyKindView } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationSettingsRow, OAuthGrantSummary, McpTokenSummary } from "@shared/rows";
import type {
  ArtifactSummaryDTO, ArtifactDetailDTO, ArtifactDiffDTO, ArtifactFetchDTO,
  ArtifactKind, ArtifactVisibility, ArtifactLinkType,
} from "@shared/artifacts-core";
import type { QuickSearchResult } from "@shared/quick-search";
// Person profiles (0036): the DTOs and caps are one zod-free contract with the Worker.
import type { PersonSummary, PersonProfile } from "@shared/people";
import type {
  HandoffView, HandoffBox, HandoffCreate, PromptSummary, PromptDetail, PromptVersion, PromptSort, PromptSave, DocProposeBody,
} from "@shared/handoffs";

export class Unauthorized extends Error {
  constructor() { super("unauthorized"); }
}
export class ApiError extends Error {
  status: number;
  /** A 429 `rate_limited`'s `retry_after`: whole seconds until the caller's limit turns over. */
  retryAfter: number | null = null;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const retryAfterOf = (j: { retry_after?: unknown }): number | null =>
  typeof j.retry_after === "number" && Number.isFinite(j.retry_after) && j.retry_after > 0 ? j.retry_after : null;

/** Is this the per-person limit's refusal (docs/architecture/abuse-limits.md)? */
export const isRateLimited = (e: unknown): e is ApiError => e instanceof ApiError && (e.message === "rate_limited" || e.status === 429);
/**
 * The ONE sentence a limited route's refusal is shown as, wherever it is called (invites, the test
 * send, the notification address, an avatar upload, the handle check); null for any other error.
 * The time is the viewer's local clock, with the weekday when it is not today.
 */
export function rateLimitText(e: unknown, now: Date = new Date()): string | null {
  if (!isRateLimited(e)) return null;
  if (e.retryAfter === null) return "You've hit today's limit for this; try again later.";
  const at = new Date(now.getTime() + e.retryAfter * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = at.toDateString() === now.toDateString() ? "" : `${at.toLocaleDateString(undefined, { weekday: "long" })} `;
  return `You've hit today's limit for this; try again after ${day}${time}.`;
}
export class NotFound extends Error {}

// ── the current org: ONE prefix ──────────────────────────────────────────────
// Every tenant route lives at `/api/o/<slug>/<suffix>` (canopy-multitenancy.md §6.3). The functions
// below still name a route by its SUFFIX (`/feed`, `/api/handoffs`); `apiUrl` is the one place that
// turns it into the current org's URL, and every request in the SPA is sent through `call`. main.ts
// sets the slug once at boot from the page's path (`/o/<slug>/`); switching org is a page load.
let apiOrg: string | null = null;
export function setApiOrg(slug: string | null): void { apiOrg = slug; }
export const apiOrgSlug = (): string | null => apiOrg;

/** Person-level and platform routes: not an org's, so never prefixed (docs/architecture/data-layer.md › Routes and gates). */
const GLOBAL_PATH = /^\/(?:auth|avatar|org-logo)\/|^\/api\/(?:orgs|invites|platform|o)(?:[/?]|$)/;
export const isGlobalPath = (path: string): boolean => GLOBAL_PATH.test(path);

/** The URL a route is requested at: a tenant route under the current org, anything else as written.
 *  The old `/api/` of handoffs / prompts / docs / people / artifacts / notifications is dropped. */
export function apiUrl(path: string): string {
  if (GLOBAL_PATH.test(path)) return path;
  if (!apiOrg) throw new ApiError(409, "org_required");
  return `/api/o/${encodeURIComponent(apiOrg)}${path.replace(/^\/api(?=\/)/, "")}`;
}

/** The same URL for markup (an `href`, an image `src`): never throws — with no org open (a
 *  render before boot has one) it is an inert `#`, never the unprefixed alias. */
export function tenantHref(path: string): string {
  try { return apiUrl(path); } catch { return "#"; }
}

// A 404 from an org's route is either a missing thing or the membership gate (removed from the org,
// org suspended, unknown slug) — the same answer by design. So a 404 there asks the gate directly,
// once: `GET /api/o/<slug>/me` answers 404 only when the org is no longer the caller's.
let onOrgLost: ((slug: string) => void) | null = null;
/** main.ts: what to do when the current org turns out not to be the caller's (the org picker). */
export function setOrgLostHandler(fn: ((slug: string) => void) | null): void { onOrgLost = fn; }
let probing = false;
function probeOrg(): void {
  const slug = apiOrg;
  if (!slug || probing || !onOrgLost) return;
  probing = true;
  fetch(`/api/o/${encodeURIComponent(slug)}/me`, { credentials: "same-origin", headers: { accept: "application/json" } })
    .then((res) => { if (res.status === 404 && apiOrg === slug) onOrgLost?.(slug); })
    .catch(() => undefined)
    .finally(() => { probing = false; });
}

/** THE sender: prefixes the path, carries the session cookie, turns a 401 into `Unauthorized`. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiUrl(path);
  const res = await fetch(url, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) } });
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 404 && url.startsWith("/api/o/") && !url.endsWith("/me")) probeOrg();
  return res;
}
/** A refused call's error code: the body's `error`, else the status. */
async function refusal(res: Response): Promise<ApiError> {
  let msg = String(res.status);
  let retryAfter: number | null = null;
  try { const j = (await res.json()) as { error?: string; retry_after?: unknown }; if (j.error) msg = j.error; retryAfter = retryAfterOf(j); } catch { /* non-JSON */ }
  const err = new ApiError(res.status, msg);
  err.retryAfter = retryAfter;
  return err;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await call(path);
  if (!res.ok) {
    const err = new ApiError(res.status, `${path} -> ${res.status}`);
    // A limited read (the handle check) says when it may be asked again.
    if (res.status === 429) { try { err.retryAfter = retryAfterOf((await res.json()) as { retry_after?: unknown }); } catch { /* non-JSON */ } }
    throw err;
  }
  return res.json() as Promise<T>;
}

async function writeJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const res = await call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw await refusal(res);
  return res.json() as Promise<T>;
}
const postJson = <T>(path: string, body: unknown = {}): Promise<T> => writeJson<T>("POST", path, body);
const putJson = <T>(path: string, body: unknown = {}): Promise<T> => writeJson<T>("PUT", path, body);

// ── reads ────────────────────────────────────────────────────────────────────
export interface FeedQuery { author?: string; tags?: string[]; limit?: number; }
export function getFeed(q: FeedQuery = {}): Promise<FeedRow[]> {
  const p = new URLSearchParams();
  if (q.author) p.set("author", q.author);
  if (q.tags && q.tags.length) p.set("tags", q.tags.join(","));
  if (q.limit) p.set("limit", String(q.limit));
  const qs = p.toString();
  return getJson<{ feed: FeedRow[] }>(`/feed${qs ? `?${qs}` : ""}`).then((r) => r.feed);
}

/** The Feed aside's "This week" (`GET /feed/stats`): the last `days` of the WHOLE
 *  feed, bucketed into the viewer's local days (`tz` = minutes east of UTC). */
export function getFeedStats(days = 7, tz = -new Date().getTimezoneOffset()): Promise<FeedStats> {
  return getJson<FeedStats>(`/feed/stats?days=${days}&tz=${tz}`);
}

export function listDocs(): Promise<DocRow[]> {
  return getJson<{ docs: DocRow[] }>("/docs").then((r) => r.docs);
}
/** Every doc without its body (`/docs?fields=meta`) — My Work's "Docs you own". */
export function listDocMeta(): Promise<DocMetaRow[]> {
  return getJson<{ docs: DocMetaRow[] }>("/docs?fields=meta").then((r) => r.docs);
}

export function getDoc(slug: string): Promise<{ doc: DocRow; versions: DocVersionRow[] }> {
  return getJson<{ doc: DocRow; versions: DocVersionRow[] }>(`/doc/${encodeURIComponent(slug)}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) throw new NotFound(slug);
    throw e;
  });
}

// The read-side query envelope, re-declared here (web/ can't import the @shared
// contract's Zod module). Mirrors shared/contract.ts QueryResult exactly.
export type Authority = "live" | "staged_pending" | "unpromoted" | "draft";
export type QueryType = "doc" | "decision" | "feed" | "sprint" | "artifact";
export interface QueryPrimary {
  type: QueryType; id: string; title: string;
  section: string | null; space: string | null;
  body: string; authority: Authority;
  current_version: number | null; pending_version: number | null;
  staged_body: string | null; confidence: string | null;
  updated_at: string | null; updated_by: string | null; score: number;
}
export interface QueryPointer {
  type: QueryType; id: string; title: string; snippet: string; authority: Authority; score: number;
}
export interface QueryResult {
  primary: QueryPrimary[]; pointers: QueryPointer[]; meta: { engine: "fts5"; total: number };
}

// Human Search: the route forces include_staged:false, so results are live-only.
/** The "search everything" dropdown (GET /search/quick): titles + one-line excerpts per
 *  type, never bodies. `signal` aborts it when the next keystroke lands. */
export async function quickSearch(q: string, signal?: AbortSignal, limit?: number): Promise<QuickSearchResult> {
  const p = new URLSearchParams({ q });
  if (limit) p.set("limit", String(limit));
  const res = await call(`/search/quick?${p}`, { signal });
  if (!res.ok) throw new ApiError(res.status, `/search/quick -> ${res.status}`);
  return ((await res.json()) as { result: QuickSearchResult }).result;
}

export function search(q: string, opts: { types?: QueryType[]; section?: string; space?: string; limit?: number } = {}): Promise<QueryResult> {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (opts.types && opts.types.length) p.set("types", opts.types.join(","));
  if (opts.section) p.set("section", opts.section);
  if (opts.space) p.set("space", opts.space);
  if (opts.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  return getJson<{ result: QueryResult }>(`/search${qs ? `?${qs}` : ""}`).then((r) => r.result);
}

// The roadmap read is the ADMIN plan: an authored narrative + version metadata
// alongside the sprints (each carrying its computed progress — no live GitHub).
// Mirrors src/tools/plan.ts's PlanView exactly (web/ can't import src/, so the
// envelope is re-declared here; SprintView itself comes from @shared/sprints).
export interface PlanView {
  narrative: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  sprints: SprintView[];
}
export function getRoadmap(): Promise<PlanView> {
  return getJson<PlanView>("/roadmap");
}

export function listNeedsTriage(): Promise<NeedsTriageRow[]> {
  return getJson<{ items: NeedsTriageRow[] }>("/needs-triage").then((r) => r.items);
}
export function listAdrs(status?: string): Promise<AdrRow[]> {
  return getJson<{ adrs: AdrRow[] }>(`/adrs${status ? `?status=${encodeURIComponent(status)}` : ""}`).then((r) => r.adrs);
}
export interface MeIdentity { provider: "github" | "google"; label: string; linked_at: string }
/** `avatar_url` is already resolved (`avatarSrc`: an uploaded photo, else the provider's
 *  picture). `role` is optional so a Worker from before 0036 still reads. */
/** `orgs` is every org the person is in, each with THEIR role there — what the SPA routes and gates on
 *  (there is no person-level `admin`: admin means admin or owner of the org on screen). */
export interface Me {
  handle: string; name: string | null; avatar_url: string | null; color: PersonColor; identities: MeIdentity[];
  orgs: OrgT.MyOrg[]; superadmin: boolean; pending_invites: number;
}
export function getMe(): Promise<Me> {
  return getJson<Me>("/auth/me");
}

// ── onboarding (sealed `onboard` cookie; 401 → Unauthorized) ─────────────────
export interface OnboardPrefill { provider: "github" | "google"; label: string; email: string | null; name: string | null; avatar_url: string | null; suggested_handle: string }
export function getOnboardPrefill(): Promise<OnboardPrefill> { return getJson<OnboardPrefill>("/auth/onboard"); }
export function checkHandle(handle: string): Promise<{ available: boolean; reason?: "invalid" | "reserved" | "taken" }> {
  return getJson(`/auth/handle-check?handle=${encodeURIComponent(handle)}`);
}
export function submitOnboard(b: { handle: string; name: string | null; color: PersonColor }): Promise<{ ok: true; handle: string; redirect?: string }> { return postJson("/auth/onboard", b); }

// ── profile + identities ──────────────────────────────────────────────────────
export function updateMe(b: { name?: string | null; color?: PersonColor }): Promise<{ ok: true; name: string | null; color: PersonColor }> { return putJson("/auth/me", b); }
export function unlinkIdentity(provider: "github" | "google"): Promise<{ ok: true }> { return postJson(`/auth/identities/${provider}/unlink`); }
export function renameHandle(handle: string): Promise<{ ok: true; handle: string }> { return postJson("/auth/me/handle", { handle }); }

// ── persons directory + profiles ──────────────────────────────────────────────
export function listPersons(): Promise<PersonSummary[]> { return getJson<{ persons: PersonSummary[] }>("/persons").then((r) => r.persons); }
/** One person's profile page. 404 (an unknown or reserved handle) is NotFound. `responsibilities`
 *  arrives only for the person themselves or an admin. */
export function getPersonProfile(handle: string): Promise<PersonProfile> {
  return getJson<PersonProfile>(`/api/people/${encodeURIComponent(handle)}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) throw new NotFound(handle);
    throw e;
  });
}
/** Upload MY avatar (multipart `file`; the caller downsizes it first). 400 a type the Worker
 *  refuses, 413 over `AVATAR_MAX_BYTES`. Answers with the resolved `avatar_url`. */
export async function uploadAvatar(file: Blob, filename = "avatar"): Promise<{ ok: true; avatar_url: string | null }> {
  const fd = new FormData();
  fd.set("file", file, filename);
  const res = await call("/api/people/me/avatar", { method: "POST", body: fd });
  if (!res.ok) throw await refusal(res);
  return res.json() as Promise<{ ok: true; avatar_url: string | null }>;
}
/** Drop MY uploaded avatar: `avatar_url` falls back to the provider picture, or null (initials). */
export function removeAvatar(): Promise<{ ok: true; avatar_url: string | null }> {
  return postJson("/api/people/me/avatar/remove");
}

// ── Org settings (/api/orgs, /api/o/:slug/… — web/src/org-settings.ts, integrations.ts) ──
// Self-contained: its own sender, so a refusal keeps the server's `message` and `field` (they
// never carry a submitted value). Nothing here ever RECEIVES a secret: the API is write-only.
// Namespace imports under names of their own, so this block never collides with another import of the same types.
import type * as OrgT from "@shared/orgs";
import type * as IntT from "@shared/integrations";
/** A refused org-settings call: `message` is the error CODE (as everywhere in this file),
 *  `detail` the server's sentence, `field` the input it is about. */
export class OrgApiError extends ApiError {
  constructor(status: number, code: string, readonly detail: string | null, readonly field: string | null) { super(status, code); }
}
async function orgRefusal(res: Response): Promise<OrgApiError> {
  let j: { error?: unknown; message?: unknown; field?: unknown; retry_after?: unknown } = {};
  try { j = (await res.json()) as typeof j; } catch { /* non-JSON */ }
  const err = new OrgApiError(res.status, typeof j.error === "string" ? j.error : String(res.status), typeof j.message === "string" ? j.message : null, typeof j.field === "string" ? j.field : null);
  err.retryAfter = retryAfterOf(j);
  return err;
}
async function orgSend<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const res = await call(path, init);
  if (!res.ok) throw await orgRefusal(res);
  return res.json() as Promise<T>;
}
const orgPath = (slug: string, rest: string): string => `/api/o/${encodeURIComponent(slug)}${rest}`;
const integrationPath = (slug: string, kind: IntT.IntegrationKind, scope: string, action = ""): string =>
  orgPath(slug, `/integrations/${kind}${scope ? `/${encodeURIComponent(scope)}` : ""}${action}`);

/** My orgs, my pending invites and the superadmin flag (`GET /api/orgs`). */
export function getMyOrgs(): Promise<OrgT.MyOrgsResponse> { return orgSend("GET", "/api/orgs"); }
/** Create an org; the caller becomes its owner. Refusals: `invalid_slug`, `reserved_slug`, `slug_taken`, `invalid_name`, `org_limit`. */
export function createOrg(body: { slug: string; name: string }): Promise<OrgT.MyOrg> {
  return orgSend<{ org: OrgT.MyOrg }>("POST", "/api/orgs", body).then((r) => r.org);
}
/** Answer one of MY pending invites (`GET /api/orgs`'s `invites`). */
export function respondToInvite(id: number, accept: boolean): Promise<unknown> { return orgSend("POST", `/api/invites/${id}/${accept ? "accept" : "decline"}`); }
/** My membership of one org, and its connected repositories. A 404 = not mine (or suspended, or unknown). */
export function getOrgMe(slug: string): Promise<OrgT.OrgMeResponse> { return orgSend("GET", orgPath(slug, "/me")); }
/** MY personal MCP tokens for the CURRENT org (never another org's, never anyone else's). */
export function listMcpTokens(): Promise<McpTokenSummary[]> { return getJson<{ tokens: McpTokenSummary[] }>("/mcp-tokens").then((r) => r.tokens); }
export function revokeMcpToken(id: number): Promise<{ ok: true }> { return postJson(`/mcp-tokens/${id}/revoke`); }
export function getOrgSettings(slug: string): Promise<{ org: OrgT.OrgSettings; can_edit: boolean }> { return orgSend("GET", orgPath(slug, "/settings")); }
export function putOrgSettings(slug: string, name: string): Promise<{ ok: true; org: OrgT.OrgSettings }> { return orgSend("PUT", orgPath(slug, "/settings"), { name }); }
/** Upload the org's image (multipart `file`; the caller crops and downsizes it first — avatar.ts). Admin+.
 *  Refusals: `invalid_image` (400), `too_large` (413), `rate_limited` (429). Answers with the image that shows now. */
export async function uploadOrgLogo(slug: string, file: Blob, filename = "logo"): Promise<OrgT.OrgLogo> {
  const fd = new FormData();
  fd.set("file", file, filename);
  const res = await call(orgPath(slug, "/logo"), { method: "POST", body: fd });
  if (!res.ok) throw await orgRefusal(res);
  return ((await res.json()) as OrgT.OrgLogoResponse).logo;
}
/** Remove the org's UPLOADED image. What shows now: GitHub's, when the org has a repository to import from, else none. */
export function removeOrgLogo(slug: string): Promise<OrgT.OrgLogo> {
  return orgSend<OrgT.OrgLogoResponse>("POST", orgPath(slug, "/logo/remove")).then((r) => r.logo);
}
export function listOrgMembers(slug: string): Promise<OrgT.OrgMember[]> { return orgSend<{ members: OrgT.OrgMember[] }>("GET", orgPath(slug, "/members")).then((r) => r.members); }
export function updateOrgMember(slug: string, handle: string, patch: { role?: OrgT.OrgRole; title?: string | null; responsibilities?: string | null }): Promise<OrgT.OrgMember[]> {
  return orgSend<{ members: OrgT.OrgMember[] }>("PUT", orgPath(slug, `/members/${encodeURIComponent(handle)}`), patch).then((r) => r.members);
}
export function removeOrgMember(slug: string, handle: string): Promise<{ ok: true; left: boolean }> { return orgSend("DELETE", orgPath(slug, `/members/${encodeURIComponent(handle)}`)); }
export function listOrgInvites(slug: string): Promise<OrgT.OrgInvite[]> { return orgSend<{ invites: OrgT.OrgInvite[] }>("GET", orgPath(slug, "/invites")).then((r) => r.invites); }
/** Invite by GitHub login or e-mail. An e-mail invite is MAILED by the same call — the row's `mail_status` says how that went. */
export function createOrgInvite(slug: string, body: ({ github_login: string } | { email: string; name?: string }) & { role: "admin" | "member" }): Promise<OrgT.OrgInvite> {
  return orgSend<{ invite: OrgT.OrgInvite }>("POST", orgPath(slug, "/invites"), body).then((r) => r.invite);
}
/** Mail a pending e-mail invite again; the row comes back with the new outcome. 409 `no_address` for a GitHub-login invite. */
export function resendOrgInvite(slug: string, id: number): Promise<OrgT.OrgInvite> {
  return orgSend<{ invite: OrgT.OrgInvite }>("POST", orgPath(slug, `/invites/${id}/resend`)).then((r) => r.invite);
}
export function revokeOrgInvite(slug: string, id: number): Promise<{ ok: true }> { return orgSend("POST", orgPath(slug, `/invites/${id}/revoke`)); }
export function listOrgRepos(slug: string): Promise<IntT.OrgRepoDTO[]> { return orgSend<{ repos: IntT.OrgRepoDTO[] }>("GET", orgPath(slug, "/repos")).then((r) => r.repos); }
/** Add a repository, or — naming one the org already has with `is_primary: true` — make it the primary. */
export function addOrgRepo(slug: string, repo_full_name: string, is_primary?: boolean): Promise<IntT.OrgRepoDTO[]> {
  return orgSend<{ repos: IntT.OrgRepoDTO[] }>("POST", orgPath(slug, "/repos"), is_primary === undefined ? { repo_full_name } : { repo_full_name, is_primary }).then((r) => r.repos);
}
export function removeOrgRepo(slug: string, id: string): Promise<{ removed_secrets: string[]; repos: IntT.OrgRepoDTO[] }> { return orgSend("DELETE", orgPath(slug, `/repos/${encodeURIComponent(id)}`)); }
export function listOrgEnvironments(slug: string): Promise<IntT.OrgEnvironmentDTO[]> { return orgSend<{ environments: IntT.OrgEnvironmentDTO[] }>("GET", orgPath(slug, "/environments")).then((r) => r.environments); }
export type OrgEnvironmentWrite = Partial<Omit<IntT.OrgEnvironmentDTO, "key" | "position" | "created_at" | "updated_at" | "updated_by">>;
export function putOrgEnvironment(slug: string, key: string, body: OrgEnvironmentWrite): Promise<{ environment: IntT.OrgEnvironmentDTO; created: boolean; removed_secrets: string[] }> {
  return orgSend("PUT", orgPath(slug, `/environments/${encodeURIComponent(key)}`), body);
}
export function reorderOrgEnvironments(slug: string, order: string[]): Promise<IntT.OrgEnvironmentDTO[]> {
  return orgSend<{ environments: IntT.OrgEnvironmentDTO[] }>("PUT", orgPath(slug, "/environments"), { order }).then((r) => r.environments);
}
export function deleteOrgEnvironment(slug: string, key: string): Promise<{ removed_secrets: string[]; environments: IntT.OrgEnvironmentDTO[] }> { return orgSend("DELETE", orgPath(slug, `/environments/${encodeURIComponent(key)}`)); }
export function listOrgIntegrations(slug: string): Promise<IntT.IntegrationsListDTO> { return orgSend("GET", orgPath(slug, "/integrations")); }
/** Store a credential (409 `already_configured` if one is set — rotate instead). The value goes out once and never comes back. */
export function setOrgIntegration(slug: string, kind: IntT.IntegrationKind, scope: string, secret: string, config?: Record<string, string>): Promise<IntT.IntegrationDTO> {
  return orgSend<{ integration: IntT.IntegrationDTO }>("PUT", integrationPath(slug, kind, scope), config ? { secret, config } : { secret }).then((r) => r.integration);
}
export function rotateOrgIntegration(slug: string, kind: IntT.IntegrationKind, scope: string, secret: string): Promise<IntT.IntegrationDTO> {
  return orgSend<{ integration: IntT.IntegrationDTO }>("POST", integrationPath(slug, kind, scope, "/rotate"), { secret }).then((r) => r.integration);
}
export function deleteOrgIntegration(slug: string, kind: IntT.IntegrationKind, scope: string): Promise<IntT.IntegrationDTO> {
  return orgSend<{ integration: IntT.IntegrationDTO }>("DELETE", integrationPath(slug, kind, scope)).then((r) => r.integration);
}
export function putOrgIntegrationConfig(slug: string, kind: IntT.IntegrationKind, scope: string, config: Record<string, string>): Promise<IntT.IntegrationDTO> {
  return orgSend<{ integration: IntT.IntegrationDTO }>("PUT", integrationPath(slug, kind, scope, "/config"), { config }).then((r) => r.integration);
}
export function testOrgIntegration(slug: string, kind: IntT.IntegrationKind, scope: string): Promise<IntT.IntegrationTestDTO> { return orgSend("POST", integrationPath(slug, kind, scope, "/test")); }
/** Owner only: a new data key, every stored secret re-encrypted under it. */
export function rotateOrgKey(slug: string): Promise<{ rotated: boolean; key_version: number | null; secrets: number }> { return orgSend("POST", orgPath(slug, "/integrations/rotate-key")); }
export function listOrgAudit(slug: string, limit = 50): Promise<IntT.OrgAuditDTO[]> { return orgSend<{ audit: IntT.OrgAuditDTO[] }>("GET", orgPath(slug, `/integrations/audit?limit=${limit}`)).then((r) => r.audit); }

// ── Org settings › Hosting (/api/o/:slug/hosting…, …/environments/:key/parts/:part — src/hosting/routes.ts) ──
// Admin+ except the provider catalogue. A token is pasted through the Integrations calls above (the provider's
// kind is `HOSTING_INTEGRATION_KIND[provider]`); an install / OAuth connection is `startHostingConnect` + a
// full-page navigation to its `url` — the provider sends the browser back to `/hosting/<provider>/callback`,
// which lands on `#org/hosting?connected=<provider>` or `?connect_error=<code>`.
import type * as HostT from "@shared/hosting";
/** Everything Org settings › Hosting shows, in one read: providers, environments + parts, connections, checklist. */
export function getHostingSetup(slug: string): Promise<HostT.HostingSetupDTO> { return orgSend("GET", orgPath(slug, "/hosting")); }
/** The provider catalogue alone (any member). */
export function listHostingProviders(slug: string): Promise<HostT.HostingProviderDTO[]> {
  return orgSend<{ providers: HostT.HostingProviderDTO[] }>("GET", orgPath(slug, "/hosting/providers")).then((r) => r.providers);
}
/** Create or replace a part. Cloudflare / Railway are the environment's `frontend` / `backend` (their own columns).
 *  Refusals: `invalid` (+ `field`), `not_found`, `too_many_parts`, `part_conflict`. */
export function putEnvironmentPart(slug: string, env: string, part: string, body: HostT.PartWrite): Promise<{ part: HostT.EnvironmentPartDTO; created: boolean }> {
  return orgSend("PUT", orgPath(slug, `/environments/${encodeURIComponent(env)}/parts/${encodeURIComponent(part)}`), body);
}
export function deleteEnvironmentPart(slug: string, env: string, part: string): Promise<{ ok: true; removed: { env: string; part: string; provider: HostT.HostingProviderId; legacy: boolean } }> {
  return orgSend("DELETE", orgPath(slug, `/environments/${encodeURIComponent(env)}/parts/${encodeURIComponent(part)}`));
}
/** Begin an install / OAuth connection; then `location.assign(result.url)`. The call also sets the nonce cookie the
 *  callback checks, so it must be made from the browser that will follow the URL. Refusals (409): `not_available`,
 *  `not_installable`, `not_configured` — offer the token method instead. */
export function startHostingConnect(slug: string, provider: HostT.HostingProviderId): Promise<HostT.ConnectStartDTO> {
  return orgSend("POST", orgPath(slug, `/hosting/${provider}/connect`));
}
/** Disconnect from Trov's side: an installed integration is removed on the provider's side too (best effort). */
export function disconnectHosting(slug: string, provider: HostT.HostingProviderId, scope = ""): Promise<{ connection: HostT.HostingConnectionDTO; upstream: "revoked" | "failed" | "none" }> {
  return orgSend("POST", orgPath(slug, `/hosting/${provider}/disconnect`), scope ? { scope } : {});
}
/** Test connection — the credential alone, or against one part (`{ env, part }`). `scope` for Railway's per-environment token. */
export function testHosting(slug: string, provider: HostT.HostingProviderId, target: { scope?: string; env?: string; part?: string } = {}): Promise<HostT.HostingTestDTO> {
  return orgSend("POST", orgPath(slug, `/hosting/${provider}/test`), target);
}

// ADMIN action: trigger the server-side GitHub backfill (admin-only route). The
// worker holds the service token and fetches GitHub directly — no webhook secret.
// `batch` (1-based) / `of` (the client's own cap) let the server run the
// repo-capture reconcile on whichever batch ends the loop — including one that
// hits the cap while the summary budget is still exhausted, which the server
// otherwise has no way to see (src/tools/backfill.ts's isFinalBackfillBatch).
export function adminBackfill(batch: number, of: number): Promise<{
  ok: boolean;
  captured: number;
  unchanged: number;
  summarized: number;
  summaryBudgetExhausted: boolean;
  prSummarizedCount: number;
  issueSummarizedCount: number;
  prs: number;
  issues: number;
  issuesToSummarize: number;
  /** Present only on the batch that ends a Sync — the repo-capture reconcile
   *  (src/repo/github.ts's reconcileRepo) rides that batch only. `failed` names
   *  each arm of it that threw ("deployments", "runs", …); empty on a clean run. */
  repo?: { written: number; unchanged: number; failed: string[] };
}> {
  return postJson("/admin/backfill", { batch, of });
}

// ADMIN action: "Poll now" — refresh what the Repo dashboard polls for
// (admin-only route, no body): health pings, the three usage pollers, then the
// GitHub reconcile. Every write is idempotent with the cron's. Resolves to
// per-source outcomes; the response never carries a token, a header or an
// account id. A 409 (`ApiError.status`) means another refresh holds the lock.
// (The older, narrower `POST /admin/poll-usage` still exists; the SPA no longer calls it.)
export function adminPoll(): Promise<RepoRefreshResult> {
  return postJson("/admin/poll");
}

export function getMyDashboard(): Promise<DashboardData> {
  return getJson<DashboardData>("/me/dashboard");
}

/** The Repo dashboard — a D1-only projection; uncaptured sections arrive `not_connected`. */
export function getRepoDashboard(): Promise<RepoDashboard> {
  return getJson<RepoDashboard>("/repo/dashboard");
}

// The Triage "Proposals" queue = staged doc versions newer than the live doc.
// Backed by the single server-joined GET /proposals route (Phase 3, G9) — no more
// N+1 over /docs + /doc/:slug. Each proposal carries both bodies (so the detail
// pane diffs staged vs promoted without extra fetches) plus the Phase 2 reconciler
// metadata (change_kind / low_confidence / base_version) Phase 4 renders by shape.
export interface StagedProposal {
  slug: string;
  version: number;
  title: string;
  section: string;
  space: string;
  summary: string | null;
  author: string;
  confidence: string | null;
  status: string;
  change_kind: "new" | "edit" | "rewrite" | null;
  low_confidence: number;
  base_version: number | null;
  current_version: number;
  created_at: string;
  stagedBody: string;
  promotedBody: string;
}
export function listStagedProposals(): Promise<StagedProposal[]> {
  return getJson<{ proposals: StagedProposal[] }>("/proposals").then((r) => r.proposals);
}

// Org settings › Members · Unmatched logins: pending unknown-login tasks, each with a small LIVE
// activity sample. Mirrors src/tools/reads.ts IdentityTaskWithSample exactly
// (web/ can't import src/, so it's re-declared here atop @shared/rows's
// IdentityTaskRow shape). Envelope: { tasks, discarded }.
export interface IdentitySample {
  semantic_key: string;
  event_type: EventRow["event_type"];
  ref_number: number;
  title: string | null;    // null when the event's raw snapshot is malformed
  occurred_at: string | null;
}
export interface IdentityTask {
  login: string;
  first_seen: string;
  status: "pending" | "resolved" | "discarded";
  resolved_at: string | null;
  resolved_by: string | null;
  sample: IdentitySample[];
}
/** A discarded login Undo can still restore (src/tools/reads.ts DiscardedIdentity). */
export interface DiscardedIdentity {
  login: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
export function listIdentityTasks(): Promise<{ tasks: IdentityTask[]; discarded: DiscardedIdentity[] }> {
  return getJson<{ tasks: IdentityTask[]; discarded?: DiscardedIdentity[] }>("/identity-tasks")
    .then((r) => ({ tasks: r.tasks, discarded: r.discarded ?? [] }));
}

// ── confirms (cookie-authed) ─────────────────────────────────────────────────
export function promoteDoc(slug: string, version: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/doc/${encodeURIComponent(slug)}/promote`, { version });
}
export function ratifyAdr(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/adr/${id}/ratify`);
}
/** Admin confirmation: flip a live sprint to 'done'. Never inferred anywhere. */
export function completeSprint(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/sprints/${id}/complete`);
}

// ── triage write-back (Phase 3): reject / discard / assign-materialize ─────────
export function rejectDoc(slug: string, version: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/doc/${encodeURIComponent(slug)}/reject`, { version });
}
export function rejectAdr(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/adr/${id}/reject`);
}
export function discardTriage(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/needs-triage/${id}/discard`);
}
export interface AssignTarget { type?: "doc" | "adr" | "feed"; section?: string; space?: "technical" | "product"; tags?: string[]; }
export function assignTriage(id: number, target: AssignTarget): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/needs-triage/${id}/assign`, target);
}

// Org settings › Members · Unmatched logins: map a login to a person — the `people` table's only
// runtime write. `person` is a free non-empty string; the picker posts a
// teammate's GitHub login as that value.
export function mapIdentity(login: string, person: string): Promise<{ ok: true; login: string; person: string; status: "resolved" }> {
  return postJson(`/identity-tasks/${encodeURIComponent(login)}/map`, { person });
}
/** Discard a login that will never be a person — soft and sticky (it is never re-raised). */
export function discardIdentity(login: string): Promise<{ ok: true; login: string; status: "discarded" }> {
  return postJson(`/identity-tasks/${encodeURIComponent(login)}/discard`);
}
/** Undo a discard: the login is back in the list and raises tasks as normal. */
export function restoreIdentity(login: string): Promise<{ ok: true; login: string; status: "pending" }> {
  return postJson(`/identity-tasks/${encodeURIComponent(login)}/restore`);
}

// ── email notifications (cookie-gated /api/notifications/*) ──────────────────
export function getNotificationPrefs(): Promise<PrefsView> {
  return getJson<PrefsView>("/api/notifications/prefs");
}
export interface PrefsWrite { email?: string; unsubscribed?: boolean; prefs?: Record<string, Cadence | null>; }
export function putNotificationPrefs(body: PrefsWrite): Promise<PrefsView> {
  return putJson<PrefsView>("/api/notifications/prefs", body);
}
export function getNotificationPolicy(): Promise<{ kinds: PolicyKindView[] }> {
  return getJson<{ kinds: PolicyKindView[] }>("/api/notifications/policy");
}
export function putNotificationPolicy(body: { kind: string; enabled?: boolean; default_cadence?: Cadence }): Promise<{ kinds: PolicyKindView[] }> {
  return putJson<{ kinds: PolicyKindView[] }>("/api/notifications/policy", body);
}
export function getNotificationSettings(): Promise<NotificationSettingsRow> {
  return getJson<NotificationSettingsRow>("/api/notifications/settings");
}
export function putNotificationSettings(body: Partial<Pick<NotificationSettingsRow, "send_hour" | "timezone" | "from_address">>): Promise<NotificationSettingsRow> {
  return putJson<NotificationSettingsRow>("/api/notifications/settings", body);
}
export interface TestSendResult { ok: boolean; status: string; key: string; mode: string; to: string; resend_id: string | null; error: string | null; }
export function testSendNotification(cadence: "daily" | "weekly", sample = false): Promise<TestSendResult> {
  return postJson<TestSendResult>("/api/notifications/test-send", { cadence, sample });
}
export function listNotificationOutbox(limit = 50): Promise<{ rows: NotificationOutboxRow[] }> {
  return getJson<{ rows: NotificationOutboxRow[] }>(`/api/notifications/outbox?limit=${limit}`);
}

// ── tickets (cookie-gated, NEVER MCP) ────────────────────────────────────────
// Every write answers with `{ ok, ticket: TicketDetail }` — the server re-reads
// the ticket so one round-trip repaints the screen. The queue list and the
// detail fetch return the bare payloads (`{ tickets }` / TicketDetail).
// The requester/actor is always the session principal; nothing here sends one.

export interface TicketFilters {
  seg?: TicketSeg;
  assignee?: TicketAssigneeFilter;
  /** "all" / absent = every category. */
  category?: TicketCategory | "all";
}
export function listTickets(f: TicketFilters = {}): Promise<TicketListItem[]> {
  const p = new URLSearchParams();
  if (f.seg) p.set("seg", f.seg);
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.category && f.category !== "all") p.set("category", f.category);
  const qs = p.toString();
  return getJson<{ tickets: TicketListItem[] }>(`/tickets${qs ? `?${qs}` : ""}`).then((r) => r.tickets);
}
export function getTicket(id: number): Promise<TicketDetail> {
  return getJson<TicketDetail>(`/tickets/${id}`);
}
/** The sidebar badge: unassigned + open tickets, org-wide. */
export function getTicketBadge(): Promise<number> {
  return getJson<{ count: number }>("/tickets/badge").then((r) => r.count);
}
type TicketWrite = Promise<TicketDetail>;
const ticketWrite = (path: string, body: unknown = {}): TicketWrite =>
  postJson<{ ok: true; ticket: TicketDetail }>(path, body).then((r) => r.ticket);

export function createTicket(body: TicketCreate): TicketWrite {
  return ticketWrite("/tickets", body);
}
export function transitionTicket(id: number, to: TicketDetail["status"]): TicketWrite {
  return ticketWrite(`/tickets/${id}/status`, { to });
}
/** A board drop: column (status) + the card it lands right after (null = the top). */
export function moveTicket(id: number, to: TicketDetail["status"], afterId: number | null): TicketWrite {
  return ticketWrite(`/tickets/${id}/move`, { to, after_id: afterId });
}
export function toggleTicketAssignee(id: number, login: string, on: boolean): TicketWrite {
  return ticketWrite(`/tickets/${id}/assignees`, { login, on });
}
/** Edit the title and/or body — a mirrored ticket's too (Trov's after import). */
export function editTicket(id: number, patch: { title?: string; body?: string }): TicketWrite {
  return ticketWrite(`/tickets/${id}/edit`, patch);
}
export function addTicketLink(id: number, raw: string): TicketWrite {
  return ticketWrite(`/tickets/${id}/links`, { raw });
}
export function removeTicketLink(id: number, linkId: number): TicketWrite {
  return ticketWrite(`/tickets/${id}/links/${linkId}/remove`);
}
/** Hard-delete a native ticket (a mirrored one is a 403). */
export function deleteTicket(id: number): Promise<{ ok: true; id: number; title: string; detached: number }> {
  return postJson<{ ok: true; id: number; title: string; detached: number }>(`/tickets/${id}/delete`);
}
export function setTicketSprint(id: number, sprintId: number | null): TicketWrite {
  return ticketWrite(`/tickets/${id}/sprint`, { sprint_id: sprintId });
}
/** Nest `childId` under `parentId` — one level only; the route 409s otherwise. */
export function setTicketParent(parentId: number, childId: number): TicketWrite {
  return ticketWrite(`/tickets/${parentId}/parent`, { child_id: childId });
}
export function addTicketComment(id: number, body: string): TicketWrite {
  return ticketWrite(`/tickets/${id}/comment`, { body });
}

// ── sprints (cookie-gated, NEVER MCP) ────────────────────────────────────────
export function listSprints(): Promise<SprintView[]> {
  return getJson<{ sprints: SprintView[] }>("/sprints").then((r) => r.sprints);
}
/** The sprint screen's payload — the bare detail (tickets + resources included). */
export function getSprint(id: number): Promise<SprintDetail> {
  return getJson<SprintDetail>(`/sprints/${id}`);
}
export function createSprint(body: SprintCreate): Promise<SprintView> {
  return postJson<{ ok: true; sprint: SprintView }>("/sprints", body).then((r) => r.sprint);
}
export function setSprintActive(id: number, active: boolean): Promise<SprintView> {
  return postJson<{ ok: true; sprint: SprintView }>(`/sprints/${id}/active`, { active }).then((r) => r.sprint);
}
export function addSprintResource(id: number, raw: string): Promise<SprintDetail> {
  return postJson<{ ok: true; sprint: SprintDetail }>(`/sprints/${id}/resources`, { raw }).then((r) => r.sprint);
}
/** Hard-delete a sprint; its tickets move to the backlog (`moved` of them). */
export function deleteSprint(id: number): Promise<{ ok: true; id: number; label: string; moved: number }> {
  return postJson<{ ok: true; id: number; label: string; moved: number }>(`/sprints/${id}/delete`);
}

// ── Artifacts (/api/artifacts — the spec's Track B routes) ────────────────────
// One sender for every artifact call: JSON bodies, or a FormData (multipart, for a
// binary kind's `file`), where the browser sets the content-type and boundary.
// A 404 is NotFound — the API answers a missing slug and one private to someone
// else identically, and the SPA shows both as the not-found page.
async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await call(path, init);
  if (res.status === 404) throw new NotFound(path);
  if (!res.ok) {
    let msg = String(res.status);
    try { const j = (await res.json()) as { error?: string; message?: string }; msg = j.message || j.error || msg; } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}
const artPath = (slug: string): string => `/api/artifacts/${encodeURIComponent(slug)}`;

export interface ArtifactListFilters { area?: string; kind?: string; author?: string; status?: string; sprint?: number; ticket?: number; q?: string }
export function listArtifacts(f: ArtifactListFilters = {}): Promise<ArtifactSummaryDTO[]> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, String(v));
  const qs = p.toString();
  return sendJson<{ artifacts: ArtifactSummaryDTO[] }>("GET", `/api/artifacts${qs ? `?${qs}` : ""}`).then((r) => r.artifacts);
}
export function getArtifact(slug: string, v: number | null = null): Promise<ArtifactDetailDTO> {
  return sendJson<ArtifactDetailDTO>("GET", `${artPath(slug)}${v !== null ? `?v=${v}` : ""}`);
}
export interface ArtifactCreateFields { title: string; kind: ArtifactKind; area: string; repo: string; visibility: ArtifactVisibility; summary: string }
/** Text kinds post JSON with `content`; binary kinds post multipart: `file` + the same fields. */
export function createArtifact(fields: ArtifactCreateFields, body: { content: string } | { file: Blob; filename: string }): Promise<ArtifactDetailDTO> {
  if ("content" in body) return sendJson("POST", "/api/artifacts", { ...fields, content: body.content });
  const fd = new FormData();
  fd.set("file", body.file, body.filename);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return sendJson("POST", "/api/artifacts", fd);
}
export function patchArtifact(slug: string, body: { title?: string; area?: string; repo?: string; visibility?: ArtifactVisibility; status?: "draft" | "published" }): Promise<unknown> {
  return sendJson("PATCH", artPath(slug), body);
}
/** A new version: full `content`, an `old_str`/`new_str` edit, or (binary) a file — multipart. */
export function addArtifactVersion(
  slug: string,
  body: { content: string; summary: string } | { old_str: string; new_str: string; summary: string } | { file: Blob; filename: string; summary: string },
): Promise<unknown> {
  if ("file" in body) {
    const fd = new FormData();
    fd.set("file", body.file, body.filename);
    fd.set("summary", body.summary);
    return sendJson("POST", `${artPath(slug)}/versions`, fd);
  }
  return sendJson("POST", `${artPath(slug)}/versions`, body);
}
export function addArtifactLink(slug: string, target_type: ArtifactLinkType, target_ref: string): Promise<unknown> {
  return sendJson("POST", `${artPath(slug)}/links`, { target_type, target_ref });
}
export function removeArtifactLink(slug: string, target_type: ArtifactLinkType, target_ref: string): Promise<unknown> {
  return sendJson("POST", `${artPath(slug)}/links/remove`, { target_type, target_ref });
}
export function getArtifactDiff(slug: string, a: number, b: number): Promise<ArtifactDiffDTO> {
  return sendJson("GET", `${artPath(slug)}/diff?a=${a}&b=${b}`);
}
/** Session-only, never an MCP tool (the human confirm gate). Only the latest published version. */
export function ratifyArtifact(slug: string, version: number): Promise<unknown> {
  return sendJson("POST", `${artPath(slug)}/ratify`, { version });
}
/** Soft-delete an artifact page (its author or an admin; 403 otherwise). Session-only, never an
 *  MCP tool. Returns what was deleted, for the "Deleted “<title>” · Undo" toast. */
export async function deleteArtifact(slug: string): Promise<{ slug: string; title: string; versions: number }> {
  const r = await sendJson<{ ok: true; slug: string; title: string; versions: number }>("POST", `${artPath(slug)}/delete`);
  return { slug: r.slug, title: r.title, versions: r.versions };
}
/** Undo a delete: the page is back everywhere, exactly as it was. */
export async function restoreArtifact(slug: string): Promise<ArtifactDetailDTO> {
  return (await sendJson<{ ok: true; artifact: ArtifactDetailDTO }>("POST", `${artPath(slug)}/restore`)).artifact;
}
/** Fetch a page once for the new-artifact form's URL tab (https only; nothing is stored). */
export function fetchArtifactUrl(url: string): Promise<ArtifactFetchDTO> {
  return sendJson("POST", "/api/artifacts/fetch", { url });
}

export function logout(): Promise<{ ok: true }> {
  return postJson<{ ok: true }>("/auth/logout");
}
export async function listOAuthGrants(): Promise<OAuthGrantSummary[]> {
  return (await getJson<{ grants: OAuthGrantSummary[] }>("/auth/oauth-grants")).grants;
}
export function revokeOAuthGrant(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/auth/oauth-grants/${id}/revoke`);
}

// Re-export the row types the UI renders, so screens import shapes from one place.
export type { FeedRow, DocRow, DocMetaRow, DocVersionRow, AdrRow, NeedsTriageRow };
export type { SprintView, SprintDetail, SprintCreate };
export type { TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter, TicketCategory, TicketCreate };
export type { DashboardData };
export type { PrefsView, PolicyKindView, Cadence, NotificationOutboxRow, NotificationSettingsRow };
export type { PersonColor };
export type { PersonSummary, PersonProfile };

// ── Handoffs + Prompt Library ────────────────────────────────────────────────
export async function listHandoffs(box: HandoffBox = "mine"): Promise<HandoffView[]> {
  return (await getJson<{ handoffs: HandoffView[] }>(`/api/handoffs?box=${encodeURIComponent(box)}`)).handoffs;
}
export async function getHandoff(id: number): Promise<HandoffView> {
  return (await getJson<{ handoff: HandoffView }>(`/api/handoffs/${id}`)).handoff;
}
export async function createHandoff(body: HandoffCreate): Promise<HandoffView> {
  return (await postJson<{ ok: true; handoff: HandoffView }>("/api/handoffs", body)).handoff;
}
/** 409 `{ error: "handoff is <status>" }` when someone got there first. */
export async function claimHandoff(id: number, session: string): Promise<HandoffView> {
  return (await postJson<{ ok: true; handoff: HandoffView }>(`/api/handoffs/${id}/claim`, { session })).handoff;
}
export async function expireHandoff(id: number): Promise<HandoffView> {
  return (await postJson<{ ok: true; handoff: HandoffView }>(`/api/handoffs/${id}/expire`)).handoff;
}
export async function listPrompts(q: { q?: string; tags?: string[]; sort?: PromptSort } = {}): Promise<PromptSummary[]> {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.tags && q.tags.length) p.set("tags", q.tags.join(","));
  if (q.sort) p.set("sort", q.sort);
  const qs = p.toString();
  return (await getJson<{ prompts: PromptSummary[] }>(`/api/prompts${qs ? `?${qs}` : ""}`)).prompts;
}
export async function getPrompt(slug: string): Promise<PromptDetail> {
  return (await getJson<{ prompt: PromptDetail }>(`/api/prompts/${encodeURIComponent(slug)}`)).prompt;
}
export async function getPromptVersions(slug: string): Promise<PromptVersion[]> {
  return (await getJson<{ versions: PromptVersion[] }>(`/api/prompts/${encodeURIComponent(slug)}/versions`)).versions;
}
export async function savePrompt(body: PromptSave): Promise<PromptDetail> {
  return (await postJson<{ ok: true; prompt: PromptDetail }>("/api/prompts", body)).prompt;
}
export async function setPromptTags(slug: string, tags: string[]): Promise<PromptDetail> {
  return (await postJson<{ ok: true; prompt: PromptDetail }>(`/api/prompts/${encodeURIComponent(slug)}/tags`, { tags })).prompt;
}
/** 409 `{ error: "not staged" }` when that version is not staged. */
export async function publishPrompt(slug: string, version: number): Promise<PromptDetail> {
  return (await postJson<{ ok: true; prompt: PromptDetail }>(`/api/prompts/${encodeURIComponent(slug)}/publish`, { version })).prompt;
}
/** Soft-delete a prompt (its author or an admin; 403 otherwise). Returns what was deleted,
 *  for the "Deleted “<title>” · Undo" toast. */
export async function deletePrompt(slug: string): Promise<{ slug: string; title: string }> {
  const r = await postJson<{ ok: true; slug: string; title: string }>(`/api/prompts/${encodeURIComponent(slug)}/delete`);
  return { slug: r.slug, title: r.title };
}
/** Undo a delete: the prompt is back everywhere, exactly as it was. */
export async function restorePrompt(slug: string): Promise<PromptDetail> {
  return (await postJson<{ ok: true; prompt: PromptDetail }>(`/api/prompts/${encodeURIComponent(slug)}/restore`)).prompt;
}
/** Count one USE of a prompt (the Copy button). 404 on an unknown slug. Fire-and-forget:
 *  callers should not let a failure here block the copy. */
export async function usePrompt(slug: string): Promise<{ use_count: number; last_used_at: string | null }> {
  const r = await postJson<{ ok: true; use_count: number; last_used_at: string | null }>(`/api/prompts/${encodeURIComponent(slug)}/used`);
  return { use_count: r.use_count, last_used_at: r.last_used_at };
}
/** Stage a version-1 doc proposal through the gate (lands in Review). */
export async function proposeDoc(body: DocProposeBody): Promise<StagedProposal> {
  return (await postJson<{ ok: true; proposal: StagedProposal }>("/api/docs/propose", body)).proposal;
}
export type { HandoffView, HandoffBox, HandoffCreate, PromptSummary, PromptDetail, PromptVersion, PromptSort, PromptSave, DocProposeBody };

// ── orgs + the superadmin surface (/api/orgs, /api/platform/*) ───────────────
// Every /api/platform route answers 404 to a non-superadmin. A failed write throws an
// `ApiError` whose message is the server's error CODE (`slug_taken`, `last_superadmin`, …).
import type {
  PlatformOrgRow, PlatformOrgDetail, AdminTarget, AdminAssignment,
  PlatformAdmin, PlatformAuditRow, PlatformUsageResponse,
} from "@shared/orgs";
export function listPlatformOrgs(): Promise<PlatformOrgRow[]> {
  return getJson<{ orgs: PlatformOrgRow[] }>("/api/platform/orgs").then((r) => r.orgs);
}
export function getPlatformOrg(slug: string): Promise<PlatformOrgDetail> {
  return getJson<PlatformOrgDetail>(`/api/platform/orgs/${encodeURIComponent(slug)}`);
}
export function createPlatformOrg(body: { slug: string; name: string; admin: AdminTarget }): Promise<{ org: PlatformOrgRow; admin: AdminAssignment }> {
  return postJson<{ ok: true; org: PlatformOrgRow; admin: AdminAssignment }>("/api/platform/orgs", body);
}
export function assignPlatformOrgAdmin(slug: string, target: AdminTarget): Promise<AdminAssignment> {
  return postJson<{ ok: true; admin: AdminAssignment }>(`/api/platform/orgs/${encodeURIComponent(slug)}/admin`, target).then((r) => r.admin);
}
export function setPlatformOrgSuspended(slug: string, suspended: boolean): Promise<PlatformOrgRow> {
  return postJson<{ ok: true; org: PlatformOrgRow }>(`/api/platform/orgs/${encodeURIComponent(slug)}/${suspended ? "suspend" : "unsuspend"}`).then((r) => r.org);
}
/** `limit` null = back to the default. */
export function setPersonOrgLimit(handle: string, limit: number | null): Promise<{ handle: string; org_limit: number | null }> {
  return putJson<{ ok: true; person: { handle: string; org_limit: number | null } }>(`/api/platform/persons/${encodeURIComponent(handle)}/org-limit`, { limit }).then((r) => r.person);
}
export function listPlatformAdmins(): Promise<PlatformAdmin[]> {
  return getJson<{ admins: PlatformAdmin[] }>("/api/platform/admins").then((r) => r.admins);
}
export function grantPlatformAdmin(handle: string): Promise<PlatformAdmin[]> {
  return postJson<{ ok: true; admins: PlatformAdmin[] }>("/api/platform/admins", { handle }).then((r) => r.admins);
}
/** 409 `last_superadmin` when it would leave the platform with none. */
export async function revokePlatformAdmin(handle: string): Promise<PlatformAdmin[]> {
  const res = await call(`/api/platform/admins/${encodeURIComponent(handle)}`, { method: "DELETE" });
  if (!res.ok) throw await refusal(res);
  return ((await res.json()) as { admins: PlatformAdmin[] }).admins;
}
export function listPlatformAudit(org = "", limit = 100): Promise<PlatformAuditRow[]> {
  return getJson<{ audit: PlatformAuditRow[] }>(`/api/platform/audit?limit=${limit}${org ? `&org=${encodeURIComponent(org)}` : ""}`).then((r) => r.audit);
}
export function getPlatformUsage(days: number): Promise<PlatformUsageResponse> {
  return getJson<PlatformUsageResponse>(`/api/platform/usage?days=${days}`);
}
