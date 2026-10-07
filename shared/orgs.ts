// Orgs, memberships, invites and the superadmin surface (canopy-multitenancy.md §5.3, §5.4) — the ONE
// contract the Worker and the SPA share. Zod-free: the SPA imports the slug rule and these types as-is.
import type { PersonColor } from "./rows";
import { AVATAR_MAX_BYTES, AVATAR_TYPES } from "./people";

export type OrgRole = "owner" | "admin" | "member";
export type OrgStatus = "active" | "suspended";

/** How many orgs a person may CREATE when `persons.org_limit` is NULL. Zero: only a superadmin adds an
 *  organization, and does it in Platform (Add organization), until self-serve creation is opened;
 *  `persons.org_limit` (Platform › Admins & limits) lets one named person create some. */
export const DEFAULT_ORG_LIMIT = 0;
export const ORG_NAME_MAX = 80;

/** The `orgs.slug` CHECK (0042_organizations): 2–39 of [a-z0-9-], starting with a letter or digit. */
export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** Refused in code, not by CHECK, so the list can grow: every first path segment the app or its
 *  hosts answer on, plus the product's own names. */
export const RESERVED_ORG_SLUGS: readonly string[] = [
  "api", "o", "orgs", "org", "auth", "oauth", "mcp", "new", "settings", "admin", "platform", "raw", "img",
  "avatar", "u", "webhook", "static", "assets", "www", "app", "trov", "canopy", "invites", "invite", "me",
  "help", "support", "docs", "login", "logout", "signup", "system",
];

export type OrgSlugProblem = "invalid" | "reserved";
export function orgSlugProblem(slug: string): OrgSlugProblem | null {
  if (!ORG_SLUG_RE.test(slug)) return "invalid";
  return RESERVED_ORG_SLUGS.includes(slug) ? "reserved" : null;
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
  "platform.org_limit", "platform.admin.grant", "platform.admin.revoke",
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
  can_create: boolean;
  /** Orgs this person has created / may create (a superadmin has no exemption: Platform is where they add one). */
  created: number;
  limit: number | null;
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
}

export interface PlatformUsageResponse {
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
