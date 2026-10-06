import { type PlatformContext, first, all, run, stmt, batch, nowIso } from "../data/platform-sql";
import { type TenantContext, first as tenantFirst, all as tenantAll } from "../data/sql";
import { PERSON_COLORS, type PersonColor, type PersonRow, type IdentityRow, type IdentityProvider } from "@shared/rows";
import { avatarSrc, type PersonSummary } from "@shared/people";

export const HANDLE_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const RESERVED_HANDLES: readonly string[] = ["github-webhook", "system", "admin", "canopy", "trov", "me"];
export type HandleProblem = "invalid" | "reserved" | "taken";

export class HandleTakenError extends Error {
  constructor(handle: string) { super(`handle taken: ${handle}`); }
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}

/** Stable color for a migrated/derived person: FNV-1a over the seed, mod the palette. */
export function defaultColor(seed: string): PersonColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

export function getPerson(p: PlatformContext, handle: string): Promise<PersonRow | null> {
  return first<PersonRow>(p, `SELECT * FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
}

export class PersonError extends Error {
  readonly code = "bad_request" as const;
  constructor(message: string) { super(message); this.name = "PersonError"; }
}

/** `handle` as a MEMBER of the context's org, in its canonical `persons.handle` spelling — or null:
 *  an unknown handle, a RESERVED one (a system principal is not a person) and a real person who is
 *  not in this org all read the same, so a handle is never an existence oracle across orgs. */
export async function memberHandle(ctx: TenantContext, handle: string): Promise<string | null> {
  const row = await tenantFirst<{ handle: string }>(ctx,
    `SELECT p.handle FROM persons p JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
      WHERE p.handle = ? COLLATE NOCASE`, ctx.orgId, handle);
  return row && !RESERVED_HANDLES.includes(row.handle.toLowerCase()) ? row.handle : null;
}

/** Every handle taken from input that must be a person IN THE ORG goes through this (§4.3): the
 *  canonical handle, or `bad_request` "no such person" — one refusal for all three cases above. */
export async function requireMember(ctx: TenantContext, handle: string): Promise<string> {
  const member = await memberHandle(ctx, handle);
  if (!member) throw new PersonError(`no such person: ${handle}`);
  return member;
}

/** A MEMBER's person row — `getPerson` for a tenant module, with `memberHandle`'s rule: a person who is
 *  not in the context's org (or a reserved handle) reads as null, so no name crosses an org boundary. */
export async function memberPerson(ctx: TenantContext, handle: string): Promise<PersonRow | null> {
  const row = await tenantFirst<PersonRow>(ctx,
    `SELECT p.* FROM persons p JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
      WHERE p.handle = ? COLLATE NOCASE`, ctx.orgId, handle);
  return row && !RESERVED_HANDLES.includes(row.handle.toLowerCase()) ? row : null;
}

/** The GitHub logins linked to a MEMBER (what My Work joins events on); none for a non-member. */
export async function memberGithubLogins(ctx: TenantContext, handle: string): Promise<string[]> {
  const rows = await tenantAll<{ subject: string }>(ctx,
    `SELECT i.subject FROM identities i JOIN memberships m ON m.user_id = i.person AND m.org_id = ?
      WHERE i.person = ? COLLATE NOCASE AND i.provider = 'github' ORDER BY i.linked_at ASC`, ctx.orgId, handle);
  return rows.map((r) => r.subject);
}

export function findIdentity(p: PlatformContext, provider: IdentityProvider, subject: string): Promise<IdentityRow | null> {
  return first<IdentityRow>(p, `SELECT * FROM identities WHERE provider = ? AND subject = ?`, provider, subject);
}

/** The person a GitHub login belongs to, via the github identity row; null when unmapped. */
export async function resolvePersonForLogin(p: PlatformContext, login: string): Promise<PersonRow | null> {
  return first<PersonRow>(p,
    `SELECT p.* FROM identities i JOIN persons p ON p.handle = i.person WHERE i.provider = 'github' AND i.subject = ?`, login);
}

/** Ambiguous (more than one person sharing the address, e.g. via the admin-edit path
 *  bypassing the self-service guard) returns null rather than guessing — every caller
 *  (the sign-in fork's branch 2, the email-guard checks) falls through to its next
 *  step (invite/denied, or "address free") instead of auto-linking the wrong person. */
export async function findPersonByEmail(p: PlatformContext, email: string): Promise<PersonRow | null> {
  const rows = await all<PersonRow>(p, `SELECT * FROM persons WHERE lower(email) = lower(?) LIMIT 2`, email);
  return rows.length === 1 ? rows[0] : null;
}

/** The title a person holds in their ONLY org (`memberships.title`, Q9) — what `/auth/me` carries as
 *  `role` through the cut-over. Null with no membership or with several: no one org to speak for. */
export async function soleTitle(p: PlatformContext, handle: string): Promise<string | null> {
  const rows = await all<{ title: string | null }>(p, `SELECT title FROM memberships WHERE user_id = ? COLLATE NOCASE LIMIT 2`, handle);
  return rows.length === 1 ? rows[0].title : null;
}

export async function handleAvailable(p: PlatformContext, handle: string): Promise<{ available: boolean; reason?: HandleProblem }> {
  if (!isValidHandle(handle)) return { available: false, reason: "invalid" };
  if (RESERVED_HANDLES.includes(handle)) return { available: false, reason: "reserved" };
  if (await getPerson(p, handle)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Every sign-in: write email ONLY when the row has none (0021 rule), and the provider
 *  picture ONLY from the provider that owns it (`avatar_source`, 0036 PART B) — a NULL
 *  picture is claimed by whichever provider brings one first, the owner may refresh it,
 *  and a sign-in with the OTHER provider never touches it, so a person's picture never
 *  flips with how they signed in. The name is never written here: it is seeded at
 *  onboarding and edited in Settings (`updateProfile`), and a sign-in must not clobber
 *  it. An uploaded avatar (`avatar_sha`, 0036) is never touched and keeps outranking all
 *  of it. (SQLite evaluates every SET against the OLD row, so both CASEs see the old owner.) */
export async function recordSignIn(p: PlatformContext, handle: string, s: { provider: IdentityProvider; avatar_url: string | null; email: string | null }): Promise<void> {
  await run(p, `UPDATE persons SET
      avatar_url = CASE WHEN ? IS NOT NULL AND (avatar_source IS NULL OR avatar_source = ?) THEN ? ELSE avatar_url END,
      avatar_source = CASE WHEN ? IS NOT NULL AND avatar_source IS NULL THEN ? ELSE avatar_source END,
      email = COALESCE(email, ?)
    WHERE handle = ? COLLATE NOCASE`,
    s.avatar_url, s.provider, s.avatar_url, s.avatar_url, s.provider, s.email, handle);
}

/** `avatar_source` names the provider `avatar_url` came from (onboarding passes its own);
 *  it is stored only beside a picture, so a person with none is claimable at sign-in. */
export async function createPerson(p: PlatformContext, n: { handle: string; name: string | null; color: PersonColor; avatar_url: string | null; avatar_source?: IdentityProvider | null; email: string | null }): Promise<PersonRow> {
  const now = nowIso();
  try {
    await run(p, `INSERT INTO persons (handle, name, color, avatar_url, avatar_source, email, email_unsubscribed, created_at, onboarded_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      n.handle, n.name, n.color, n.avatar_url, n.avatar_url ? n.avatar_source ?? null : null, n.email, now, now);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) throw new HandleTakenError(n.handle);
    throw e;
  }
  return (await getPerson(p, n.handle))!;
}

export async function linkIdentity(p: PlatformContext, i: { provider: IdentityProvider; subject: string; label: string; person: string; linkedBy: string }): Promise<void> {
  await run(p, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)`,
    i.provider, i.subject, i.label, i.person, nowIso(), i.linkedBy);
}

export async function unlinkIdentity(p: PlatformContext, person: string, provider: IdentityProvider): Promise<"ok" | "last_identity" | "not_found"> {
  const mine = await listIdentities(p, person);
  const target = mine.find((i) => i.provider === provider);
  if (!target) return "not_found";
  if (mine.length <= 1) return "last_identity";
  // Unlinking the provider that owns the picture releases it (0036 PART B): the picture
  // stays, and the remaining provider claims — and from then on refreshes — it at its next
  // sign-in, rather than the picture freezing with no owner left to refresh it.
  await batch(p, [
    stmt(p, `DELETE FROM identities WHERE provider = ? AND subject = ?`, target.provider, target.subject),
    stmt(p, `UPDATE persons SET avatar_source = NULL WHERE handle = ? COLLATE NOCASE AND avatar_source = ?`, person, target.provider),
  ]);
  return "ok";
}

export function listIdentities(p: PlatformContext, person: string): Promise<IdentityRow[]> {
  return all<IdentityRow>(p, `SELECT * FROM identities WHERE person = ? COLLATE NOCASE ORDER BY linked_at ASC`, person);
}

export async function updateProfile(p: PlatformContext, handle: string, patch: { name?: string | null; color?: PersonColor }): Promise<PersonRow | null> {
  const row = await getPerson(p, handle);
  if (!row) return null;
  await run(p, `UPDATE persons SET name = ?, color = ? WHERE handle = ? COLLATE NOCASE`,
    patch.name === undefined ? row.name : patch.name, patch.color ?? row.color, handle);
  return getPerson(p, handle);
}

/** The org's people directory (pickers, avatars): its MEMBERS, with the title each holds in it
 *  (`memberships.title`, Q9 — it travels as `role`). A RESERVED handle is a system principal,
 *  not a person — `github-webhook` has a row only because the GitHub mirror files
 *  tickets as it (0032) — so it is never listed and never offered as an assignee. */
export async function listPersons(ctx: TenantContext): Promise<PersonSummary[]> {
  const rows = await tenantAll<Pick<PersonRow, "handle" | "name" | "color" | "avatar_url" | "avatar_sha" | "role">>(ctx,
    `SELECT p.handle, p.name, p.color, p.avatar_url, p.avatar_sha, m.title AS role FROM persons p
       JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
      WHERE p.handle NOT IN (${RESERVED_HANDLES.map(() => "?").join(", ")})
      ORDER BY p.handle COLLATE NOCASE ASC`, ctx.orgId, ...RESERVED_HANDLES);
  // `avatar_url` goes out RESOLVED: an uploaded avatar (0036) outranks the provider's.
  return rows.map((r) => ({ handle: r.handle, name: r.name, color: r.color, avatar_url: avatarSrc(r), role: r.role }));
}

/** Every (table, column) that stores a person handle. A rename rewrites all of them. */
export const HANDLE_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["identities", "person"], ["identities", "linked_by"],
  ["sessions", "person"], ["mcp_tokens", "person"],
  ["feed", "author"],
  ["docs", "updated_by"], ["docs", "owner"], ["doc_versions", "created_by"],
  ["adrs", "created_by"],
  // Sprints (0025 renamed the table in place; `lead` is new there).
  ["sprints", "created_by"], ["sprints", "lead"],
  ["needs_triage", "source_author"], ["needs_triage", "resolved_by"], ["identity_tasks", "resolved_by"],
  ["events", "recorded_by"],
  // Tickets (0024). `ticket_assignees.login` keeps the brief's column name but
  // stores a person HANDLE, like every other column in this block.
  ["tickets", "requester"], ["ticket_assignees", "login"], ["ticket_links", "created_by"],
  ["ticket_comments", "author"], ["ticket_events", "actor"],
  ["plan", "updated_by"], ["plan_versions", "created_by"],
  ["notification_policy", "updated_by"], ["notification_prefs", "user_id"], ["notification_outbox", "user_id"],
  ["invites", "invited_by"], ["invites", "accepted_by"],
  // Artifacts (0030): plain TEXT handles, no FK.
  ["artifact_pages", "author_id"], ["artifact_pages", "ratified_by"], ["artifact_pages", "deleted_by"], ["artifact_versions", "created_by"],
  ["artifact_links", "created_by"], ["artifact_upload_tokens", "principal"],
  // Handoffs + Prompt Library (0028). `handoffs.recipient` may hold the literal
  // 'anyone'; the rename's WHERE only ever matches a real handle.
  ["handoffs", "sender"], ["handoffs", "recipient"], ["handoffs", "claimed_by"],
  ["prompts", "author"], ["prompts", "deleted_by"], ["prompt_versions", "author"],
  // MCP OAuth (0029): a rename carries a person's connections and in-flight codes.
  ["oauth_grants", "person"], ["oauth_codes", "person"],
  // Multitenancy (0037): a handle is ONE person across every org, so a rename spans them all.
  ["memberships", "user_id"], ["memberships", "created_by"], ["orgs", "created_by"],
  ["org_invites", "invited_by"], ["org_invites", "responded_by"],
  ["org_login_map", "person"], ["org_login_map", "mapped_by"],
  ["org_repos", "created_by"], ["org_environments", "updated_by"],
  ["org_secrets", "created_by"], ["org_integration_config", "updated_by"], ["org_audit", "actor"],
  ["platform_admins", "person"], ["platform_admins", "granted_by"],
  // The org + platform backend (0043).
  ["orgs", "suspended_by"], ["org_usage_daily", "actor"], ["org_admin_audit", "actor"],
];

export type RenameResult = { ok: true } | { ok: false; reason: HandleProblem | "same" | "not_found" };

/**
 * Rename `from` → `to` everywhere, in ONE D1 batch (atomic). FK checks are deferred for the
 * batch because identities/sessions/mcp_tokens reference persons(handle) with no ON UPDATE CASCADE.
 * Validation: unknown `from` → "not_found"; `to` equal to `from` (case-insensitively) → "same";
 * otherwise `to` must pass handleAvailable (regex, reserved, case-insensitive uniqueness).
 */
export async function renamePerson(p: PlatformContext, from: string, to: string): Promise<RenameResult> {
  if (!(await getPerson(p, from))) return { ok: false, reason: "not_found" };
  if (from.toLowerCase() === to.toLowerCase()) return { ok: false, reason: "same" };
  const avail = await handleAvailable(p, to);
  if (!avail.available) return { ok: false, reason: avail.reason! };
  await batch(p, [
    stmt(p, "PRAGMA defer_foreign_keys = true"),
    stmt(p, "UPDATE persons SET handle = ? WHERE handle = ? COLLATE NOCASE", to, from),
    ...HANDLE_COLUMNS.map(([t, c]) => stmt(p, `UPDATE ${t} SET ${c} = ? WHERE ${c} = ? COLLATE NOCASE`, to, from)),
  ]);
  return { ok: true };
}
