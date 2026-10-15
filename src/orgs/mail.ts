// The two mails of the org surface, as the routes call them: the invitation (transactional: an e-mail
// invite created or re-sent — by an org admin, or by the superadmin naming an owner) and the welcome
// (a notification: a person's FIRST membership of any org). Both are sent AS the org concerned — its sender name over
// the platform's address (src/notifications/resend.ts) — and neither ever throws: the invite or the
// membership is already written, and the mail is reported, not required.
import type { Env } from "../env";
import { systemTenant } from "../data/context";
import { type PlatformContext, first } from "../data/platform-sql";
import { sendInvite, type InviteMailOutcome } from "../notifications/invite";
import { sendWelcome } from "../notifications/welcome";
import type { OrgInvite } from "@shared/orgs";
import { welcomeRecipient } from "./repo";

/** The absolute origin mail links are built on: the configured public one, else the request's. */
export const mailOrigin = (env: Env, requestUrl: string): string => env.PUBLIC_ORIGIN ?? new URL(requestUrl).origin;

const orgOf = (p: PlatformContext, orgId: string) =>
  first<{ slug: string; name: string }>(p, `SELECT slug, name FROM orgs WHERE id = ?`, orgId);

/**
 * Mail one invitation of `orgId` and record the outcome on its row. Null when there is nothing to
 * mail: a GitHub-login invite (no address), or an org that is gone. `inviter` is `p.actor`.
 */
export async function mailInvite(env: Env, p: PlatformContext, orgId: string, invite: Pick<OrgInvite, "id" | "email" | "name" | "role">, origin: string, fetchImpl?: typeof fetch): Promise<InviteMailOutcome | null> {
  if (invite.email === null) return null;
  const org = await orgOf(p, orgId);
  if (!org) return null;
  return sendInvite(env, systemTenant(p, orgId, "system"), p, {
    inviteId: invite.id, email: invite.email, inviteeName: invite.name, inviterHandle: p.actor,
    orgName: org.name, role: invite.role, origin, fetchImpl,
  });
}

/** Has the person turned Trov email off (`persons.email_unsubscribed`, the one global flag)? */
const unsubscribed = async (p: PlatformContext, handle: string): Promise<boolean> =>
  (await first<{ u: number }>(p, `SELECT email_unsubscribed AS u FROM persons WHERE handle = ?`, handle))?.u === 1;

/**
 * The welcome, when `firstJoin` says this membership is the person's first anywhere (`neverJoined`,
 * asked BEFORE the join was written). No verified address on file = no mail. The welcome is a
 * NOTIFICATION, not transactional mail (shared/email-unsubscribe.ts): a person who has unsubscribed gets
 * none. Never throws.
 */
export async function welcomeFirstJoin(env: Env, p: PlatformContext, orgId: string, handle: string, firstJoin: boolean, origin: string, fetchImpl?: typeof fetch): Promise<void> {
  if (!firstJoin) return;
  try {
    const [org, to] = await Promise.all([orgOf(p, orgId), welcomeRecipient(p, handle)]);
    if (!org || !to) return;
    if (await unsubscribed(p, to.handle)) return;
    await sendWelcome(env, systemTenant(p, orgId, "system"), {
      email: to.email, name: to.name, handle: to.handle, orgName: org.name, orgSlug: org.slug, origin, fetchImpl,
    });
  } catch {
    /* a courtesy: a failed read here must not cost the join */
  }
}
