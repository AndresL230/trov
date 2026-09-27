import type { DB } from "../db";
import type { IdentityProvider } from "@shared/rows";
import { hmacSeal, hmacUnseal, b64uEncode, b64uDecode } from "./crypto";
import { findIdentity, findPersonByEmail, linkIdentity, listIdentities, recordSignIn, isValidHandle } from "./persons";
import { findLiveInvite } from "./invites";

export interface ProviderProfile { provider: IdentityProvider; subject: string; label: string; email: string | null; name: string | null; avatar_url: string | null }
// `exp` is added internally by sealOnboard (not supplied by callers building a payload
// to hand to it) and is present once a sealed cookie has been opened by openOnboard.
export interface OnboardPayload extends ProviderProfile { suggested_handle: string; invite_email: string | null; exp?: number }
export const ONBOARD_COOKIE = "onboard";
// The sealed cookie deliberately carries the provider gate result (GitHub org
// membership checked in /auth/callback; the Google admin invite checked in
// completeSignIn) forward for its lifetime below. It is NOT re-checked for GitHub —
// the callback's org-membership check is the only gate a GitHub onboard gets. The
// invite IS re-checked for Google, in POST /auth/onboard, because an invite can be
// revoked within the 10-minute window and the person row must not be created for a
// no-longer-invited address.
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

/**
 * The fork both callbacks run after their provider gate passed.
 * 1 known identity → session. 2 verified email matches a person → link + session.
 * 3 live invite (Google) / org member (GitHub) → onboard. 4 otherwise → denied.
 *
 * Contract: `p.email` MUST already be provider-verified by the CALLER before this
 * runs (GitHub: the primary + verified address from `GET /user/emails`; Google:
 * the ID token claim with `email_verified === true`) or passed as `null` — branch 2
 * links a new identity onto whichever person owns that address, so an unverified
 * email here would let an attacker hijack someone else's account by claiming their
 * address.
 */
export async function completeSignIn(db: DB, p: ProviderProfile): Promise<ForkResult> {
  const known = await findIdentity(db, p.provider, p.subject);
  if (known) {
    await recordSignIn(db, known.person, { provider: p.provider, avatar_url: p.avatar_url, email: p.email });
    return { kind: "session", handle: known.person };
  }
  if (p.email) {
    const byEmail = await findPersonByEmail(db, p.email);
    if (byEmail) {
      await linkIdentity(db, { provider: p.provider, subject: p.subject, label: p.label, person: byEmail.handle, linkedBy: byEmail.handle });
      await recordSignIn(db, byEmail.handle, { provider: p.provider, avatar_url: p.avatar_url, email: p.email });
      return { kind: "session", handle: byEmail.handle };
    }
  }
  const invite = p.email ? await findLiveInvite(db, p.email) : null;
  if (p.provider === "github" || invite) {
    return { kind: "onboard", payload: { ...p, name: p.name ?? invite?.name ?? null, suggested_handle: suggestHandle(p), invite_email: invite?.email ?? null } };
  }
  return { kind: "denied" };
}

/**
 * Link mode: attach the identity to the signed-in person unless someone else already
 * owns it, or the signed-in person already has an identity of this provider (a person
 * gets at most one github + one google identity — `unlinkIdentity` couldn't otherwise
 * disambiguate which one to remove).
 */
export async function linkSignIn(db: DB, handle: string, p: ProviderProfile): Promise<"linked" | "belongs_to_other" | "provider_already_linked"> {
  const known = await findIdentity(db, p.provider, p.subject);
  if (known) return known.person.toLowerCase() === handle.toLowerCase() ? "linked" : "belongs_to_other";
  const mine = await listIdentities(db, handle);
  if (mine.some((i) => i.provider === p.provider)) return "provider_already_linked";
  await linkIdentity(db, { provider: p.provider, subject: p.subject, label: p.label, person: handle, linkedBy: handle });
  return "linked";
}
