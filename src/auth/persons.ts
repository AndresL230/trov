import { type DB, first, all, run, nowIso } from "../db";
import { PERSON_COLORS, type PersonColor, type PersonRow, type IdentityRow, type IdentityProvider } from "@shared/rows";

export const HANDLE_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const RESERVED_HANDLES: readonly string[] = ["github-webhook", "system", "admin", "canopy", "me"];
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

export function getPerson(db: DB, handle: string): Promise<PersonRow | null> {
  return first<PersonRow>(db, `SELECT * FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
}

export function findIdentity(db: DB, provider: IdentityProvider, subject: string): Promise<IdentityRow | null> {
  return first<IdentityRow>(db, `SELECT * FROM identities WHERE provider = ? AND subject = ?`, provider, subject);
}

/** Ambiguous (more than one person sharing the address, e.g. via the admin-edit path
 *  bypassing the self-service guard) returns null rather than guessing — every caller
 *  (the sign-in fork's branch 2, the email-guard checks) falls through to its next
 *  step (invite/denied, or "address free") instead of auto-linking the wrong person. */
export async function findPersonByEmail(db: DB, email: string): Promise<PersonRow | null> {
  const rows = await all<PersonRow>(db, `SELECT * FROM persons WHERE lower(email) = lower(?) LIMIT 2`, email);
  return rows.length === 1 ? rows[0] : null;
}

export async function handleAvailable(db: DB, handle: string): Promise<{ available: boolean; reason?: HandleProblem }> {
  if (!isValidHandle(handle)) return { available: false, reason: "invalid" };
  if (RESERVED_HANDLES.includes(handle)) return { available: false, reason: "reserved" };
  if (await getPerson(db, handle)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Every sign-in: refresh name/avatar; write email ONLY when the row has none (0021 rule). */
export async function recordSignIn(db: DB, handle: string, p: { name: string | null; avatar_url: string | null; email: string | null }): Promise<void> {
  await run(db, `UPDATE persons SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), email = COALESCE(email, ?) WHERE handle = ? COLLATE NOCASE`,
    p.name, p.avatar_url, p.email, handle);
}

export async function createPerson(db: DB, p: { handle: string; name: string | null; color: PersonColor; avatar_url: string | null; email: string | null }): Promise<PersonRow> {
  const now = nowIso();
  try {
    await run(db, `INSERT INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      p.handle, p.name, p.color, p.avatar_url, p.email, now, now);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) throw new HandleTakenError(p.handle);
    throw e;
  }
  return (await getPerson(db, p.handle))!;
}

export async function linkIdentity(db: DB, i: { provider: IdentityProvider; subject: string; label: string; person: string; linkedBy: string }): Promise<void> {
  await run(db, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?)`,
    i.provider, i.subject, i.label, i.person, nowIso(), i.linkedBy);
}

export async function unlinkIdentity(db: DB, person: string, provider: IdentityProvider): Promise<"ok" | "last_identity" | "not_found"> {
  const mine = await listIdentities(db, person);
  const target = mine.find((i) => i.provider === provider);
  if (!target) return "not_found";
  if (mine.length <= 1) return "last_identity";
  await run(db, `DELETE FROM identities WHERE provider = ? AND subject = ?`, target.provider, target.subject);
  return "ok";
}

export function listIdentities(db: DB, person: string): Promise<IdentityRow[]> {
  return all<IdentityRow>(db, `SELECT * FROM identities WHERE person = ? COLLATE NOCASE ORDER BY linked_at ASC`, person);
}

export async function updateProfile(db: DB, handle: string, patch: { name?: string | null; color?: PersonColor }): Promise<PersonRow | null> {
  const row = await getPerson(db, handle);
  if (!row) return null;
  await run(db, `UPDATE persons SET name = ?, color = ? WHERE handle = ? COLLATE NOCASE`,
    patch.name === undefined ? row.name : patch.name, patch.color ?? row.color, handle);
  return getPerson(db, handle);
}

/** The people directory (pickers, avatars). A RESERVED handle is a system principal,
 *  not a person — `github-webhook` has a row only because the GitHub mirror files
 *  tickets as it (0032) — so it is never listed and never offered as an assignee. */
export function listPersons(db: DB): Promise<Pick<PersonRow, "handle" | "name" | "color" | "avatar_url">[]> {
  return all(db, `SELECT handle, name, color, avatar_url FROM persons
                   WHERE handle NOT IN (${RESERVED_HANDLES.map(() => "?").join(", ")})
                   ORDER BY handle COLLATE NOCASE ASC`, ...RESERVED_HANDLES);
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
];

export type RenameResult = { ok: true } | { ok: false; reason: HandleProblem | "same" | "not_found" };

/**
 * Rename `from` → `to` everywhere, in ONE D1 batch (atomic). FK checks are deferred for the
 * batch because identities/sessions/mcp_tokens reference persons(handle) with no ON UPDATE CASCADE.
 * Validation: unknown `from` → "not_found"; `to` equal to `from` (case-insensitively) → "same";
 * otherwise `to` must pass handleAvailable (regex, reserved, case-insensitive uniqueness).
 */
export async function renamePerson(db: DB, from: string, to: string): Promise<RenameResult> {
  if (!(await getPerson(db, from))) return { ok: false, reason: "not_found" };
  if (from.toLowerCase() === to.toLowerCase()) return { ok: false, reason: "same" };
  const avail = await handleAvailable(db, to);
  if (!avail.available) return { ok: false, reason: avail.reason! };
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = true"),
    db.prepare("UPDATE persons SET handle = ? WHERE handle = ? COLLATE NOCASE").bind(to, from),
    ...HANDLE_COLUMNS.map(([t, c]) => db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ? COLLATE NOCASE`).bind(to, from)),
  ]);
  return { ok: true };
}
