import { type PlatformContext, first, all, run, nowIso } from "../data/platform-sql";
import type { InviteRow } from "@shared/rows";
import { findPersonByEmail } from "./persons";

const norm = (e: string) => e.trim().toLowerCase();

export async function findLiveInvite(p: PlatformContext, email: string): Promise<InviteRow | null> {
  return first<InviteRow>(p, `SELECT * FROM invites WHERE email = ? AND revoked_at IS NULL AND accepted_by IS NULL`, norm(email));
}

export async function createInvite(p: PlatformContext, i: { email: string; name: string | null; invitedBy: string }): Promise<InviteRow> {
  const email = norm(i.email);
  if (await findPersonByEmail(p, email)) throw new Error("already_a_person");
  if (await findLiveInvite(p, email)) throw new Error("invite_exists");
  await run(p,
    `INSERT INTO invites (email, name, invited_by, invited_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, invited_by = excluded.invited_by, invited_at = excluded.invited_at,
       accepted_by = NULL, revoked_at = NULL, email_sent_at = NULL, email_id = NULL, email_error = NULL`,
    email, i.name, i.invitedBy, nowIso());
  return (await first<InviteRow>(p, `SELECT * FROM invites WHERE email = ?`, email))!;
}

export async function acceptInvite(p: PlatformContext, email: string, handle: string): Promise<void> {
  await run(p, `UPDATE invites SET accepted_by = ? WHERE email = ? AND accepted_by IS NULL`, handle, norm(email));
}

export async function revokeInvite(p: PlatformContext, email: string): Promise<boolean> {
  const row = await first<InviteRow>(p, `SELECT * FROM invites WHERE email = ?`, norm(email));
  if (!row) return false;
  if (!row.revoked_at) await run(p, `UPDATE invites SET revoked_at = ? WHERE email = ?`, nowIso(), row.email);
  return true;
}

/** One invite row by address, live or not (the admin list's resend / re-read). */
export function getInvite(p: PlatformContext, email: string): Promise<InviteRow | null> {
  return first<InviteRow>(p, `SELECT * FROM invites WHERE email = ?`, norm(email));
}

export function listInvites(p: PlatformContext): Promise<InviteRow[]> {
  return all<InviteRow>(p, `SELECT * FROM invites ORDER BY invited_at DESC, email ASC`);
}

export async function recordInviteEmail(p: PlatformContext, email: string, r: { id: string | null; error: string | null }): Promise<void> {
  await run(p, `UPDATE invites SET email_sent_at = ?, email_id = ?, email_error = ? WHERE email = ?`, nowIso(), r.id, r.error, norm(email));
}
