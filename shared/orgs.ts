// Orgs, memberships, invites and the superadmin surface (canopy-multitenancy.md §5.3, §5.4) — the ONE
// contract the Worker and the SPA share. Zod-free: the SPA imports the slug rule and these types as-is.
import type { PersonColor } from "./rows";
import { AVATAR_MAX_BYTES, AVATAR_TYPES } from "./people";
import type { MyGrant, PlatformOrgPlan } from "./plans";

export type OrgRole = "owner" | "admin" | "member";
export type OrgStatus = "active" | "suspended";

/** How many organizations a person may create with NO grant — on the Free plan, and counted as the Free
 *  organizations they OWN at a time (src/plans/free.ts): one. Anything else comes from a superadmin
 *  (Platform) or a grant (0044_plans; a superadmin's, or a payment's). `persons.org_limit`, the per-person
 *  allowance from before grants, is read by nothing. */
export const DEFAULT_ORG_LIMIT = 1;
export const ORG_NAME_MAX = 80;

/** The `orgs.slug` CHECK (0042_organizations): 2–39 of [a-z0-9-], starting with a letter or digit. */
export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** Refused in code, not by CHECK, so the list can grow: every first path segment the app or its
 *  hosts answer on, plus the product's own names.
 *
 *  AN ORG'S PAGE IS `/<slug>/` (`orgPath`), so this list is also what keeps an org from shadowing a
 *  route: the Worker serves the app shell for `GET /<slug>/` only when the segment is NOT here
 *  (src/index.ts). Every route segment the Worker answers at the root, and every top-level static
 *  page, MUST be listed — test/spa-shell.test.ts walks the app's routes and fails on a missing one. */
export const RESERVED_ORG_SLUGS: readonly string[] = [
  "api", "o", "orgs", "org", "auth", "oauth", "mcp", "new", "settings", "admin", "platform", "raw", "img",
  "avatar", "u", "webhook", "static", "assets", "www", "app", "trov", "canopy", "invites", "invite", "me",
  "help", "support", "docs", "login", "logout", "signup", "system",
  // Static pages and files at the root (web/*.html, web/public/).
  "index", "pricing", "privacy", "terms", "guide", "favicon", "robots", "sitemap", "billing",
  // Root routes of the Hono app (src/routes.ts and the routers mounted at "/"), and screen names kept
  // free so a path can never be mistaken for one.
  "feed", "doc", "adr", "adrs", "roadmap", "search", "tickets", "ticket", "sprints", "sprint", "repo", "repos",
  "sync", "persons", "people", "proposals", "needs-triage", "identity-tasks", "ingest", "plan", "prompts",
  "handoffs", "artifacts", "notifications", "integrations", "environments", "members", "usage", "audit",
  "admins", "grants", "github", "google", "onboard", "callback", "identities", "handle-check", "mcp-token",
  "mcp-tokens", "oauth-grants", "org-logo", "logo", "policy", "prefs", "outbox", "preview", "fetch",
  "upload-url", "test-send", "triage", "mywork", "site", "releases", "unsubscribe", "unplaced", "maintenance",
];

export type OrgSlugProblem = "invalid" | "reserved";
export function orgSlugProblem(slug: string): OrgSlugProblem | null {
  if (!ORG_SLUG_RE.test(slug)) return "invalid";
  return RESERVED_ORG_SLUGS.includes(slug) ? "reserved" : null;
}

/** An org's home path — `/<slug>/`, with the screen in the hash after it (`/acme/#tickets/12`). */
export const orgPath = (slug: string): string => `/${slug}/`;

/** The org a page path names, or null: `/<slug>` or `/<slug>/` where the segment is a valid slug that
 *  is not reserved. The old form `/o/<slug>[/…]` is still read (the Worker redirects it; a cached page
 *  or an old link may still be on it). Nothing deeper is an org page — the route lives in the hash. */
export function orgSlugOfPath(pathname: string): string | null {
  const m = /^\/o\/([^/]+)(?:\/|$)/.exec(pathname) ?? /^\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  return orgSlugProblem(slug) === null ? slug : null;
}

/** GitHub's login shape — an invite by login is validated, never looked up (§5.3). */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
export const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every `org_admin_audit.action` (0042_organizations). Kept here, not in a CHECK, so it can grow. */
export const ORG_AUDIT_ACTIONS = [
  "org.create", "org.update", "org.suspend", "org.unsuspend",
  // The org's image (0042_organizations, src/orgs/logo.ts): an admin's upload / removal, and a GitHub import that changed it.
  "org.logo.set", "org.logo.remove", "org.logo.import",
  "member.add", "member.update", "member.remove", "member.leave",
  "invite.create", "invite.revoke", "invite.accept", "invite.decline",
  // Org settings › Repositories / Environments (src/integrations/settings.ts).
  "repo.add", "repo.remove", "repo.primary", "environment.set", "environment.delete", "environment.reorder",
  // The GitHub App's installation (0043_github_app, src/github-app/store.ts).
  "github.connect", "github.disconnect", "github.uninstall", "github.suspend", "github.unsuspend", "github.repos", "github.permissions",
  "platform.org_limit", "platform.admin.grant", "platform.admin.revoke",
  // Plans and grants (0044_plans, src/plans): an org's plan / limits / status changed; a grant made, revoked, used.
  "plan.change", "plan.overrides", "plan.status", "grant.create", "grant.revoke", "grant.use",
  // A person created a Free organization of their own (src/plans/free.ts): the row is also the guard that
  // keeps them to one owned Free org at a time.
  "org.create_free",
] as const;
export type OrgAuditAction = (typeof ORG_AUDIT_ACTIONS)[number];

// ── the org's image (0042_organizations) ─────────────────────────────────────
// An org shows ONE image wherever its name is (the initial tile without one): an admin's UPLOAD, or the
// avatar of its primary repository's owner IMPORTED from GitHub — bytes in R2 at `org-logos/<sha>`,
// served by the session-gated `GET /org-logo/<sha>`. An upload is never replaced by an import
// (src/orgs/logo.ts holds the rule). The checks are the person photo's (shared/people.ts).

export const ORG_LOGO_MAX_BYTES = AVATAR_MAX_BYTES;
export const ORG_LOGO_TYPES = AVATAR_TYPES;
export type OrgLogoSource = "upload" | "github";

/** THE image rule: every DTO's `logo_url` is this — the app's own route, never a third party's URL. */
export function orgLogoSrc(o: { logo_sha?: string | null }): string | null {
  return o.logo_sha ? `/org-logo/${o.logo_sha}` : null;
}

/** The image and where it came from (Org settings › General). `by` is the uploader's handle (an upload),
 *  `from` the GitHub login it was imported from (an import); all null when there is no image. */
export interface OrgLogo {
  url: string | null;
  source: OrgLogoSource | null;
  by: string | null;
  from: string | null;
  at: string | null;
}

/** `orgs`' five image columns (0042_organizations) as the wire's `OrgLogo`: they travel together — no image, no provenance. */
export function orgLogoOf(r: { logo_sha: string | null; logo_source: OrgLogoSource | null; logo_by: string | null; logo_from: string | null; logo_at: string | null } | null): OrgLogo {
  return r?.logo_sha
    ? { url: orgLogoSrc(r), source: r.logo_source, by: r.logo_by, from: r.logo_from, at: r.logo_at }
    : { url: null, source: null, by: null, from: null, at: null };
}

// ── user-level: GET /api/orgs ────────────────────────────────────────────────

/** `logo_url` (0042_organizations) is on every org the Worker sends — here, an invitation's `org`, `OrgSummary`, the
 *  Platform rows. It is typed optional so that an answer cached from before it existed reads as "no image". */
export interface MyOrg { slug: string; name: string; role: OrgRole; logo_url?: string | null }

/** A pending invite that is the caller's (§5.3). `role` is what accepting grants — `owner` for a
 *  superadmin's owner invite. Exactly one of `github_login` / `email` is set: what it matched on. */
export interface MyInvite {
  id: number;
  org: { slug: string; name: string; logo_url?: string | null };
  role: OrgRole;
  invited_by: string;
  created_at: string;
  github_login: string | null;
  email: string | null;
}

export interface MyOrgsResponse {
  orgs: MyOrg[];
  invites: MyInvite[];
  superadmin: boolean;
  /** The person can create an organization here: with a usable grant (0044_plans), or on Free. Never true
   *  for a superadmin: Platform is where they add one. */
  can_create: boolean;
  /** The grants this person can use, oldest first: each makes ONE organization on its plan. */
  grants: MyGrant[];
  /** Free (src/plans/free.ts): can this person create a Free organization now — `owned` is the one they
   *  already own, which is what stops them (`DEFAULT_ORG_LIMIT`). */
  free: { can_create: boolean; owned: OrgSummary | null };
}

// ── tenant: /api/o/:slug/… ───────────────────────────────────────────────────

export interface OrgSummary { slug: string; name: string; logo_url?: string | null }

/** The org's connected repositories as `owner/repo` (§9): `primary` is what an issue `#214`, the Repo
 *  dashboard and a handoff's default repo resolve against — null until one is connected; `all` lists
 *  every one, primary first. The SPA builds its GitHub URLs from these, never from a constant. */
export interface OrgRepos { primary: string | null; all: string[] }

export interface OrgMeResponse {
  org: OrgSummary;
  role: OrgRole;
  title: string | null;
  responsibilities: string | null;
  repos: OrgRepos;
}

export interface OrgSettings { slug: string; name: string; created_at: string; created_by: string; logo?: OrgLogo }

/** `POST /api/o/:slug/logo` and `…/logo/remove`: the image that shows now. After a removal that is the
 *  GitHub image when the org has a repository to import from (tried at once), else none. */
export interface OrgLogoResponse { ok: true; logo: OrgLogo }

/** `responsibilities` is present only for an admin+ caller (shared/people.ts: never rendered to members). */
export interface OrgMember {
  handle: string;
  name: string | null;
  color: PersonColor;
  avatar_url: string | null;
  role: OrgRole;
  title: string | null;
  responsibilities?: string | null;
  joined_at: string;
}

export type OrgInviteStatus = "pending" | "accepted" | "declined" | "revoked";
export interface OrgInvite {
  id: number;
  github_login: string | null;
  email: string | null;
  /** What accepting grants: `owner` only for a superadmin's owner invite. */
  role: OrgRole;
  status: OrgInviteStatus;
  invited_by: string;
  created_at: string;
  responded_at: string | null;
  responded_by: string | null;
  /** The invitee's name as the inviter typed it (the mail's greeting). */
  name: string | null;
  /** The invitation e-mail's LAST attempt. `null` = none was sent: a GitHub-login invite has no address
   *  (the person sees it when they sign in), and a row from before 0042_organizations was never mailed from here. */
  mail_status: InviteMailStatus | null;
  mail_at: string | null;
  /** The provider's refusal when `mail_status` is `failed`. */
  mail_error: string | null;
}
export type InviteMailStatus = "sent" | "failed";
export const INVITE_NAME_MAX = 120;

// ── superadmin: /api/platform/… ──────────────────────────────────────────────

export interface PlatformOrgOwner { handle: string; name: string | null }

export interface PlatformOrgRow {
  slug: string;
  name: string;
  logo_url?: string | null;
  status: OrgStatus;
  created_at: string;
  created_by: string;
  suspended_at: string | null;
  suspended_by: string | null;
  owners: PlatformOrgOwner[];
  member_count: number;
  pending_invites: number;
  last_activity_at: string | null;
  /** The org's plan and seat use (0044_plans). Optional: an answer cached from before it reads as "unknown". */
  plan?: PlatformOrgPlan;
  /** The GitHub account the org's App installation is on (0043_github_app), or null: connected by a
   *  pasted token, or not at all. Read-only here. */
  github_account?: string | null;
}

/** Who a superadmin names as an org's admin: exactly one key. */
export type AdminTarget = { handle: string } | { github_login: string } | { email: string };

/** The outcome of naming an admin: an existing person is an owner at once; anyone else gets an owner invite. */
export type AdminAssignment =
  | { status: "owner"; handle: string }
  | { status: "invited"; invite_id: number; github_login: string | null; email: string | null };

export interface PlatformOrgMember { handle: string; name: string | null; role: OrgRole; title: string | null; joined_at: string }

export interface UsageSizes {
  members: number;
  docs: number;
  feed_entries: number;
  tickets_open: number;
  tickets_total: number;
  sprints: number;
  prompts: number;
  handoffs: number;
  artifacts: number;
  artifact_bytes: number;
  repo_events: number;
  mcp_tokens: number;
  oauth_grants: number;
}

export interface UsageCreated {
  feed_entries: number;
  tickets: number;
  doc_versions: number;
  sprints: number;
  prompts: number;
  handoffs: number;
  artifacts: number;
}

export interface UsageActivity {
  /** `api_reads + api_writes` — session requests through the tenant gates. */
  api_requests: number;
  api_reads: number;
  api_writes: number;
  /** HTTP requests to /mcp (every JSON-RPC message batch, tool call or not). */
  mcp_requests: number;
  mcp_tool_calls: number;
  /** Distinct people with any metered request in the window. */
  active_people: number;
  created: UsageCreated;
  emails_sent: number;
  /** MCP tools by call count, most used first (at most 10). */
  top_tools: { tool: string; count: number }[];
}

/** One UTC day of the window. The series is zero-filled and oldest first — `days` points, always. */
export interface UsageDay { day: string; requests: number; mcp_calls: number }

export interface OrgUsage {
  slug: string;
  name: string;
  logo_url?: string | null;
  status: OrgStatus;
  created_at: string;
  last_activity_at: string | null;
  sizes: UsageSizes;
  activity: UsageActivity;
  series: UsageDay[];
  /** AI summaries in the window, and this calendar month against the plan's allowance. */
  summaries: UsageSummaries & { month_used: number; cap: number | null };
}

/** AI summary calls in the window (`org_usage_daily`, src/data/meter.ts). Counts and sizes only. */
export interface UsageSummaries {
  /** Summarizer calls made. `succeeded = attempted - failed`. */
  attempted: number;
  succeeded: number;
  /** Calls that produced no summary. */
  failed: number;
  /** Items given an excerpt because nothing could be attempted (the allowance, an ended plan). */
  capped: number;
  /** `failed + capped`: items that show an excerpt instead of a summary. */
  fell_back: number;
  /** Characters sent and received — what cost is estimated from (docs/architecture/plans.md). */
  chars_in: number;
  chars_out: number;
  /** The provider's token counts, where its answers carried them; 0 = none recorded. */
  tokens_in: number;
  tokens_out: number;
}

export interface PlatformUsageResponse {
  /** False when the deployment has no summaries key: nothing is attempted, counted or capped. */
  summaries_enabled: boolean;
  /** Every org's summaries in the window, summed. */
  summaries: UsageSummaries;
  days: number;
  since: string;       // first day of the window, 'YYYY-MM-DD' (UTC)
  until: string;       // last day (today, UTC)
  generated_at: string;
  totals: {
    orgs: number;
    suspended_orgs: number;
    persons: number;
    last_activity_at: string | null;
    sizes: UsageSizes;
    activity: UsageActivity;
    series: UsageDay[];
  };
  orgs: OrgUsage[];
}

export interface PlatformOrgDetail {
  org: PlatformOrgRow;
  members: PlatformOrgMember[];
  invites: OrgInvite[];
  usage: OrgUsage;
  /** False when the deployment has no summaries key (`PlatformUsageResponse.summaries_enabled`): the
   *  page says AI summaries are off instead of a line of zeros. */
  summaries_enabled: boolean;
}

export interface PlatformAdmin { handle: string; name: string | null; granted_at: string; granted_by: string }

/** One audit row. `id` is unique across both trails: `a<n>` (org administration) or `s<n>` (integration secrets). */
export interface PlatformAuditRow {
  id: string;
  org: string | null;  // the org's slug; null for a platform-level action
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  at: string;
}
