import { type PlatformContext, first } from "../data/platform-sql";
import type { IdentityProvider, IdentityRow } from "@shared/rows";
import { hmacSeal, hmacUnseal, b64uEncode, b64uDecode } from "./crypto";
import { liveLegacyInvite } from "../data/legacy";
import { findIdentity, findPersonByVerifiedEmail, linkIdentity, listIdentities, recordSignIn, recordVerifiedEmail, bindProviderUid, isValidHandle } from "./persons";

// `uid` is the provider's IMMUTABLE account id where `subject` is not one already: GitHub's numeric id
// (its `subject` is the login, which can be renamed away and re-registered — 0042_organizations). Absent for Google.
export interface ProviderProfile { provider: IdentityProvider; subject: string; label: string; email: string | null; name: string | null; avatar_url: string | null; uid?: string | null }
// `exp` is added internally by sealOnboard (not supplied by callers building a payload
// to hand to it) and is present once a sealed cookie has been opened by openOnboard.
// `invite_email` is set when onboarding REQUIRES a pending invite for that address — a Google sign-in
// (below); it is null for GitHub, which needs none.
export interface OnboardPayload extends ProviderProfile { suggested_handle: string; invite_email: string | null; exp?: number }
export const ONBOARD_COOKIE = "onboard";
// The sealed cookie carries the provider gate result forward for its lifetime below. A GitHub
// account has no gate (§5.1): anyone with one reaches onboarding. A Google account's gate — a
// pending invite for its verified email, checked in completeSignIn — IS re-checked in
// POST /auth/onboard, because an invite can be revoked within the 10-minute window and the
// person row must not be created for a no-longer-invited address.
export const ONBOARD_TTL_S = 600;

export type ForkResult = { kind: "session"; handle: string } | { kind: "onboard"; payload: OnboardPayload } | { kind: "denied" };

/** github → login lowercased; otherwise the email local part squeezed into the handle alphabet. */
export function suggestHandle(p: ProviderProfile): string {
  const raw = p.provider === "github" ? p.subject : (p.email ?? p.label).split("@")[0];
  let h = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  if (!/^[a-z]/.test(h)) h = `p-${h}`.slice(0, 24);
  return isValidHandle(h) ? h : "me-" + Math.random().toString(36).slice(2, 8);
}

/** Seals the payload as a capability token good for ONBOARD_TTL_S from now — the expiry
 *  is computed here (not trusted from a caller-supplied field) so a sealed cookie can
 *  never outlive its TTL no matter what the payload passed in looks like. */
export function sealOnboard(payload: OnboardPayload, secret: string): Promise<string> {
  const withExp: OnboardPayload = { ...payload, exp: Date.now() + ONBOARD_TTL_S * 1000 };
  return hmacSeal(b64uEncode(JSON.stringify(withExp)), `onboard:${secret}`);
}

/** Verifies the HMAC, then the shape (provider/subject/label) and expiry — a sealed
 *  onboard token is a capability, so a malformed or expired one must be null exactly
 *  like a tampered one, not merely "trust whatever JSON was inside". `now` is
 *  injectable for tests. */
export async function openOnboard(sealed: string, secret: string, now: () => number = Date.now): Promise<OnboardPayload | null> {
  const v = await hmacUnseal(sealed, `onboard:${secret}`);
  if (!v) return null;
  let obj: unknown;
  try { obj = JSON.parse(b64uDecode(v)); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.exp !== "number" || o.exp <= now()) return null;
  if (o.provider !== "github" && o.provider !== "google") return null;
  if (typeof o.subject !== "string" || typeof o.label !== "string") return null;
  return o as unknown as OnboardPayload;
}

/** The identity row was bound to one provider account (0042_organizations) and this sign-in comes from ANOTHER with the
 *  same login. Unbound rows (never signed in since 0042_organizations) and providers with no `uid` never mismatch. */
const uidMismatch = (known: IdentityRow, profile: ProviderProfile): boolean =>
  !!known.provider_uid && !!profile.uid && known.provider_uid !== profile.uid;

/**
 * Is there a PENDING invite addressed to this (provider-verified) email — an `org_invites` row of any
 * org that is not suspended, or a live legacy invite (org #1's old `invites` table)? This is what lets a
 * Google account reach onboarding (Q1). It grants nothing by itself: becoming a member is the accept
 * step (or, for a legacy invite, `consumeLegacyInvite`).
 */
export async function hasPendingEmailInvite(p: PlatformContext, email: string): Promise<boolean> {
  const org = await first(p,
    `SELECT 1 AS x FROM org_invites i JOIN orgs o ON o.id = i.org_id
      WHERE i.email = ? AND i.status = 'pending' AND o.suspended_at IS NULL LIMIT 1`, email.trim().toLowerCase());
  // MT: the legacy table is read until Phase 7 moves what is left of it onto `org_invites`.
  return org !== null || (await liveLegacyInvite(p, email)) !== null;
}

/**
 * The fork both callbacks run once the provider has named the account (§5.1) — sign-in is tied to no
 * GitHub org:
 * 1 known identity → session.
 * 2 the provider-verified email is another identity's verified email → link + session.
 * 3 GitHub → onboard, always. Google → onboard only with a pending invite for the verified email.
 * 4 otherwise (a Google account nobody invited) → denied.
 * Onboarding creates a PERSON, never a membership: a new person is in no org until they accept an invite
 * or create one (the one exception is a legacy invite — POST /auth/onboard).
 *
 * Contract: `profile.email` MUST already be provider-verified by the CALLER before this
 * runs (GitHub: the primary + verified address from `GET /user/emails`; Google:
 * the ID token claim with `email_verified === true`) or passed as `null` — branch 2
 * links a new identity onto whichever person owns that address, so an unverified
 * email here would let an attacker hijack someone else's account by claiming their
 * address. For the same reason branch 2 matches `identities.verified_email` — what a
 * provider asserted at an earlier sign-in — and never `persons.email`, which is editable.
 */
export async function completeSignIn(p: PlatformContext, profile: ProviderProfile): Promise<ForkResult> {
  const known = await findIdentity(p, profile.provider, profile.subject);
  if (known) {
    // The login is on file — but is it the same ACCOUNT? A GitHub login that was renamed away and
    // re-registered by someone else must not sign in as the person the row names (0042_organizations).
    if (uidMismatch(known, profile)) return { kind: "denied" };
    await bindProviderUid(p, profile.provider, profile.subject, profile.uid);
    await recordSignIn(p, known.person, { provider: profile.provider, avatar_url: profile.avatar_url, email: profile.email });
    await recordVerifiedEmail(p, profile.provider, profile.subject, profile.email);
    return { kind: "session", handle: known.person };
  }
  if (profile.email) {
    const byEmail = await findPersonByVerifiedEmail(p, profile.email);
    if (byEmail) {
      await linkIdentity(p, { provider: profile.provider, subject: profile.subject, label: profile.label, person: byEmail.handle, linkedBy: byEmail.handle, verifiedEmail: profile.email, providerUid: profile.uid });
      await recordSignIn(p, byEmail.handle, { provider: profile.provider, avatar_url: profile.avatar_url, email: profile.email });
      return { kind: "session", handle: byEmail.handle };
    }
  }
  // MT: a legacy invite still seeds the name the admin typed for the invitee.
  const legacy = profile.email ? await liveLegacyInvite(p, profile.email) : null;
  const payload = (inviteEmail: string | null): OnboardPayload =>
    ({ ...profile, name: profile.name ?? legacy?.name ?? null, suggested_handle: suggestHandle(profile), invite_email: inviteEmail });
  if (profile.provider === "github") return { kind: "onboard", payload: payload(null) };
  if (profile.email && (legacy || (await hasPendingEmailInvite(p, profile.email)))) return { kind: "onboard", payload: payload(profile.email.trim().toLowerCase()) };
  return { kind: "denied" };
}

/**
 * Link mode: attach the identity to the signed-in person unless someone else already
 * owns it, or the signed-in person already has an identity of this provider (a person
 * gets at most one github + one google identity — `unlinkIdentity` couldn't otherwise
 * disambiguate which one to remove).
 */
export async function linkSignIn(p: PlatformContext, handle: string, profile: ProviderProfile): Promise<"linked" | "belongs_to_other" | "provider_already_linked"> {
  const known = await findIdentity(p, profile.provider, profile.subject);
  if (known) return known.person.toLowerCase() === handle.toLowerCase() && !uidMismatch(known, profile) ? "linked" : "belongs_to_other";
  const mine = await listIdentities(p, handle);
  if (mine.some((i) => i.provider === profile.provider)) return "provider_already_linked";
  await linkIdentity(p, { provider: profile.provider, subject: profile.subject, label: profile.label, person: handle, linkedBy: handle, verifiedEmail: profile.email, providerUid: profile.uid });
  return "linked";
}
