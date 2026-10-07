import { env } from "cloudflare:test";
import { run } from "./db";
import { createSession } from "../../src/auth/session";
import { hmacSeal } from "../../src/auth/crypto";
import type { PersonColor } from "@shared/rows";

import { platformCtx } from "./tenant";
export interface SeedPersonOpts {
  name?: string | null; email?: string | null; unsubscribed?: 0 | 1; color?: PersonColor; avatar_url?: string | null; github?: boolean; member?: boolean;
  /** `email` is ALSO the github identity's provider-VERIFIED email — what a real GitHub sign-in records
   *  (`recordVerifiedEmail`), what a second provider's sign-in links on and what an email invite matches.
   *  Without it `email` is only `persons.email`, the editable notification address. */
  verified?: boolean;
}

/** The suite's "an org admin" (§5.2): `seedPerson` / `cookieFor` give this handle the ADMIN role in
 *  SaplingLearn; every other seeded handle is a plain member (and `AndresL230`, from the reset seed, is
 *  the owner). The role is the membership's — nothing reads the handle itself. */
export const FIXTURE_ADMIN = "admin-user";

/** Insert if missing (INSERT OR IGNORE; pass explicit UPDATEs for pre-seeded handles) a person, and by default its github identity = handle
 *  and its SaplingLearn membership (what 0042_organizations gave every person; `member: false` for a person in no org). Idempotent. */
export async function seedPerson(handle: string, o: SeedPersonOpts = {}): Promise<void> {
  await run(env.DB, `INSERT OR IGNORE INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    handle, o.name === undefined ? handle : o.name, o.color ?? "stone", o.avatar_url ?? null, o.email ?? null, o.unsubscribed ?? 0);
  if (o.github !== false) {
    await run(env.DB, `INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by, verified_email) VALUES ('github', ?, ?, ?, '2026-01-01T00:00:00Z', 'seed', ?)`,
      handle, handle, handle, o.verified && o.email ? o.email.toLowerCase() : null);
  }
  if (o.member !== false) {
    await run(env.DB, `INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at, created_by) VALUES ('org_saplinglearn', ?, ?, '2026-01-01T00:00:00Z', 'seed')`,
      handle, handle === FIXTURE_ADMIN ? "admin" : "member");
  }
}

/** A signed session cookie for `handle`, seeding the person if needed. */
export async function cookieFor(handle: string, o: SeedPersonOpts = {}): Promise<string> {
  await seedPerson(handle, o);
  const { id } = await createSession(platformCtx(), handle);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}
