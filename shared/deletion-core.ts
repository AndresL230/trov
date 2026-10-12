// Deleting an account or an organization — the ZOD-FREE contract (the *-core.ts rule: the SPA imports VALUES
// from here). The rules live in src/deletion/ and are described ONCE, in
// docs/architecture/organizations.md › "What deletion removes and what it keeps (and why)"; the sentences below
// are the product's own words for the same thing, shown in Settings, Org settings and Platform. Change them with
// that section.

import type { OrgRole } from "./orgs";

/** A deleted person's handle becomes `deleted-<random>`: what their authored content is credited to from then
 *  on. The prefix is RESERVED (no one can sign up as, or rename to, a `deleted-…` handle), so a tombstone can
 *  never be claimed by a new account and inherit someone's past work. */
export const TOMBSTONE_PREFIX = "deleted-";
export const isTombstoneHandle = (h: string | null | undefined): boolean =>
  typeof h === "string" && h.toLowerCase().startsWith(TOMBSTONE_PREFIX);
/** What a tombstone's `name` is, so a screen that shows a name says this rather than a random handle. */
export const TOMBSTONE_NAME = "Deleted user";

/** Who asked: the person or org owner themselves, or a superadmin in Platform. */
export type DeletionBy = "self" | "platform";

export interface OrgRef { slug: string; name: string }

/** `GET /api/o/:slug/deletion` (owner) and `GET /api/platform/orgs/:slug/deletion` (superadmin): what deleting
 *  this organization would do. Counts only — never its content. */
export interface OrgDeletionPreview {
  org: OrgRef;
  /** People who are members now (the caller included). Their accounts are not deleted. */
  members: number;
  pending_invites: number;
  repositories: number;
  /** A subscription that would be cancelled at Stripe NOW, as part of the deletion; null when nothing is paid. */
  subscription: { period_end: string | null; cancel_at_period_end: boolean } | null;
  /** False when a live subscription exists but this deployment has no Stripe keys to cancel it with: the
   *  deletion is refused until it can be cancelled (`billing_unavailable`). */
  billing_ready: boolean;
  /** The confirmation must type exactly this (the slug). */
  confirm: string;
}

export const ACCOUNT_BLOCKERS = ["last_owner", "billing_buyer", "last_superadmin", "superadmin", "self"] as const;
/** Why an account cannot be deleted yet:
 *  • `last_owner` — the only owner of an organization other people are in (it would be left with nobody to run it);
 *  • `billing_buyer` — the person whose card pays for an organization that carries on (it would go on charging them);
 *  • `last_superadmin` — the platform would have no superadmin;
 *  • `superadmin` / `self` — Platform only: a superadmin's account, or your own, is not deleted from Platform. */
export type AccountBlockerCode = (typeof ACCOUNT_BLOCKERS)[number];
export interface AccountBlocker { code: AccountBlockerCode; org: OrgRef | null; message: string }

/** `GET /auth/me/deletion` (yourself) and `GET /api/platform/persons/:handle/deletion` (superadmin). */
export interface AccountDeletionPreview {
  handle: string;
  /** Organizations the person leaves; what they wrote there stays, credited to a deleted user. */
  leaves: (OrgRef & { role: OrgRole })[];
  /** Organizations nobody else is in: deleted with the account (each one's subscription cancelled, as an
   *  organization's deletion does). */
  deletes: (OrgRef & { paid: boolean })[];
  /** Paid plans bought but never set up as an organization: their subscriptions are cancelled. */
  unused_paid: number;
  blockers: AccountBlocker[];
  /** The confirmation must type exactly this (the handle). */
  confirm: string;
}

/** A refusal from a deletion route: `{ error, message, blockers? }`. */
export const DELETION_ERRORS = [
  "confirm_mismatch", "blocked", "forbidden", "not_found", "billing_failed", "billing_unavailable",
] as const;
export type DeletionErrorCode = (typeof DELETION_ERRORS)[number];

// ── the words ────────────────────────────────────────────────────────────────

export const ACCOUNT_DELETE_REMOVES =
  "Your sign-ins (GitHub and Google), every session, your agent connections and tokens, your email settings and digests, your photo, and your support messages.";
export const ACCOUNT_DELETE_KEEPS =
  "What you wrote in organizations that carry on (docs, tickets, comments, handoffs and the rest) stays for the people you worked with, credited to “Deleted user” instead of you.";
export const ACCOUNT_DELETE_AFTER =
  "You are signed out. Signing in again with the same GitHub or Google account starts a new, empty account.";
/** The same three, as a superadmin reads them about someone else's account (Platform). */
export const ACCOUNT_DELETE_REMOVES_THEIRS =
  "Their sign-ins (GitHub and Google), every session, their agent connections and tokens, their email settings and digests, their photo, and their support messages.";
export const ACCOUNT_DELETE_KEEPS_THEIRS =
  "What they wrote in organizations that carry on stays for the people they worked with, credited to “Deleted user” instead of them.";
export const ACCOUNT_DELETE_AFTER_THEIRS =
  "They are signed out everywhere and are not told. Signing in again with the same GitHub or Google account starts a new, empty account.";

export const ORG_DELETE_REMOVES =
  "Everything in it, for everyone: docs and their history, decisions, the feed, tickets, sprints and the roadmap, handoffs, prompts, artifacts and images, repositories, environments and integration keys, members and invitations, and its email settings.";
export const ORG_DELETE_KEEPS =
  "Members keep their Trov accounts and their other organizations. The GitHub App stays installed on GitHub until you uninstall it there.";
export const ORG_DELETE_BILLING =
  "Its Pro subscription is cancelled at Stripe right away. The time already paid for is not refunded, and its invoices stay available from Stripe.";

/** Does what was typed confirm `expected`? Case and the spaces around it do not matter; anything else does. */
export const confirms = (typed: unknown, expected: string): boolean =>
  typeof typed === "string" && typed.trim().toLowerCase() === expected.toLowerCase();
