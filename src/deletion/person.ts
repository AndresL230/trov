// Deleting a person's ACCOUNT — the one core for "Delete my account" (Settings, src/auth/routes.ts) and a
// superadmin's deletion in Platform (src/platform/routes.ts). What it removes and keeps, and why:
// docs/architecture/organizations.md › What deletion removes and what it keeps.
//
// The guard rails protect OTHER people, and are the same for both callers (`accountDeletionPreview`):
//   • `last_owner` — the only owner of an organization that other people are in: it would be left with nobody
//     who can run it. Make another member an owner, or delete the organization, first.
//   • `billing_buyer` — the buyer of a subscription that is still renewing for an organization that carries on:
//     it would go on charging their card for a team they left. Cancel the plan (it then runs to the end of the
//     period already paid and stops) or have Trov move the billing, first.
//   • `last_superadmin` — the platform would have no superadmin.
//   • from Platform only: a superadmin's account (`superadmin`) and your own (`self`) are not deleted there.
// An organization NOBODY ELSE is in is deleted with the account, through the organization core (./org.ts):
// the confirmation names each one.
//
// In order, and nothing is deleted unless every Stripe call succeeded:
//   1. BILLING: open checkouts the person started are expired; the subscriptions of their unused paid grants
//      and of the organizations deleted with them are cancelled now (no refund for the period already paid).
//   2. Each organization nobody else is in: deleted (./org.ts), its billing already settled in step 1.
//   3. ONE D1 batch for the person: every personal row deleted (sessions, sign-ins, tokens and connections,
//      email preferences and outbox, memberships, attribution map, superadmin role, answered invitations,
//      support messages, rate-limit counters), and every other column that holds their handle — authored
//      content, history, the audit trail — rewritten to a TOMBSTONE handle (`deleted-<random>`) by the same
//      `HANDLE_COLUMNS` list a rename uses. The `persons` row itself becomes that tombstone: no name, e-mail,
//      photo or profile — it stays only because content (a ticket's requester) must point at a person row.
//      One `person.delete` audit row records it, naming the tombstone, never the old handle.
//      Their PRIVATE Ask attachments go in the same batch, hard-deleted (`ASK_ATTACHMENTS_OF`; the owner's ruling).
//   4. R2, after the commit: their uploaded photo and their private Ask attachments' bytes, each only if no one
//      else's row points at the same bytes (./r2.ts).
import type { Env } from "../env";
import { type PlatformContext, type Stmt, all, first, stmt, batch, ph, nowIso } from "../data/platform-sql";
import { isSuperadmin } from "../data/context";
import { getPerson, HANDLE_COLUMNS, RESERVED_HANDLES } from "../auth/persons";
import { hmacSeal } from "../auth/crypto";
import { subscriptionEnded } from "../billing/cancel";
import {
  TOMBSTONE_NAME, TOMBSTONE_PREFIX, type AccountBlocker, type AccountDeletionPreview, type DeletionBy, type OrgRef,
} from "@shared/deletion-core";
import type { OrgRole } from "@shared/orgs";
import {
  DeletionError, deleteOrganization, endAtStripe, openCheckouts, orgForDeletion, orgSubscriptions, type OrgToDelete,
} from "./org";
import { artifactShas, noCandidates, sweepR2, type R2Sweep } from "./r2";

/** The person's PRIVATE Ask attachments, in every org (the owner's ruling — docs/architecture/ask.md › Deleting a
 *  thread or an account): pages they authored, still private, that a thread carries as an attachment — one of their
 *  own threads, or one shared with them to continue (0077_ask_people_sharing). A subquery; binds ?1 = the handle. */
const ASK_ATTACHMENTS_OF = `SELECT p.id FROM artifact_pages p
    JOIN chat_artifacts ca ON ca.artifact_id = p.id AND ca.org_id = p.org_id AND ca.role = 'attachment'
   WHERE p.author_id = ?1 COLLATE NOCASE AND p.visibility = 'private'`;

/** The R2 keys of those attachments' versions — read BEFORE the batch, freed after it. */
async function askAttachmentKeys(p: PlatformContext, handle: string): Promise<string[]> {
  const rows = await all<{ r2_key: string | null }>(p, `SELECT r2_key FROM artifact_versions WHERE page_id IN (${ASK_ATTACHMENTS_OF})`, handle);
  return rows.map((r) => r.r2_key).filter((k): k is string => !!k);
}

/** Who is asking: the person (`self`), or a superadmin in Platform (`platform`, `actor` = their handle). */
export interface AccountAsk { by: DeletionBy; actor: string }

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** `deleted-` + 10 random base32 characters: a valid handle (shared/deletion-core.ts reserves the prefix). */
export function tombstoneHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return TOMBSTONE_PREFIX + Array.from(bytes, (b) => B32[b & 31]).join("");
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The `person.delete` audit row's `ref`: HMAC-SHA256 of the deleted handle (lower-cased) under
 * `COOKIE_SECRET`, as the abuse limits key an IP (src/platform/support-routes.ts). It cannot be turned back into
 * the handle, but the operator can compute it for every person in a database restored from BEFORE the
 * deletion (D1 Time Travel) and delete the match again (docs/architecture/organizations.md › After a restore).
 * It matches only while `COOKIE_SECRET` is the same.
 */
export async function deletionRef(secret: string, handle: string): Promise<string> {
  const sealed = await hmacSeal(`person-delete:${handle.toLowerCase()}`, secret);
  return sealed.slice(sealed.lastIndexOf(".") + 1);
}

interface MembershipRow { org_id: string; slug: string; name: string; role: OrgRole; members: number; owners: number }

/** The person's organizations, with how many people and owners each has. */
const membershipsOf = (p: PlatformContext, handle: string): Promise<MembershipRow[]> =>
  all<MembershipRow>(p,
    `SELECT m.org_id, o.slug, o.name, m.role,
            (SELECT COUNT(*) FROM memberships x WHERE x.org_id = m.org_id) AS members,
            (SELECT COUNT(*) FROM memberships x WHERE x.org_id = m.org_id AND x.role = 'owner') AS owners
       FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? COLLATE NOCASE ORDER BY o.name COLLATE NOCASE, o.slug`, handle);

/** An org nobody else is in, which the person owns: deleted with the account. */
const goesWithAccount = (m: MembershipRow): boolean => m.members <= 1 && m.role === "owner";

/** Subscriptions bought by `handle` that still renew, for organizations that carry on. */
const billedOrgs = (p: PlatformContext, handle: string): Promise<(OrgRef & { org_id: string })[]> =>
  all<OrgRef & { org_id: string }>(p,
    `SELECT o.id AS org_id, o.slug, o.name FROM billing_subscriptions s JOIN orgs o ON o.billing_subscription_id = s.subscription_id
      WHERE s.person = ? COLLATE NOCASE AND o.plan_source = 'billing' AND s.cancel_at_period_end = 0
        AND s.stripe_status NOT IN ('canceled', 'incomplete_expired')
      ORDER BY o.name COLLATE NOCASE`, handle);

/** The person's GitHub logins (their own sign-in, and the logins an org's attribution map gives them), every
 *  address a provider verified for them plus their notification address, and each identity's subject. */
async function addressesOf(p: PlatformContext, handle: string, email: string | null): Promise<{ logins: string[]; emails: string[]; identities: { provider: string; subject: string }[] }> {
  const [ids, mapped] = await Promise.all([
    all<{ provider: string; subject: string; label: string; verified_email: string | null }>(p, `SELECT provider, subject, label, verified_email FROM identities WHERE person = ? COLLATE NOCASE`, handle),
    all<{ github_login: string }>(p, `SELECT DISTINCT github_login FROM org_login_map WHERE person = ? COLLATE NOCASE`, handle),
  ]);
  const logins = new Set<string>([...ids.filter((i) => i.provider === "github").map((i) => i.subject), ...mapped.map((m) => m.github_login)]);
  const emails = new Set<string>();
  for (const i of ids) {
    if (i.verified_email) emails.add(i.verified_email.toLowerCase());
    if (i.provider === "google" && i.label.includes("@")) emails.add(i.label.toLowerCase());
  }
  if (email && email.includes("@")) emails.add(email.trim().toLowerCase());
  return { logins: [...logins], emails: [...emails], identities: ids.map((i) => ({ provider: i.provider, subject: i.subject })) };
}

/** Unused grants a payment made for this person, whose subscription can still charge. */
async function unusedPaidGrants(p: PlatformContext, handle: string, a: { logins: string[]; emails: string[] }): Promise<string[]> {
  const theirs = [
    "g.person = ? COLLATE NOCASE",
    ...(a.logins.length ? [`g.github_login IN (${ph(a.logins.length)})`] : []),
    ...(a.emails.length ? [`lower(g.email) IN (${ph(a.emails.length)})`] : []),
  ].join(" OR ");
  const rows = await all<{ id: string; stripe_status: string | null }>(p,
    `SELECT g.external_ref AS id, s.stripe_status FROM org_grants g LEFT JOIN billing_subscriptions s ON s.subscription_id = g.external_ref
      WHERE g.status = 'unused' AND g.source = 'billing' AND g.external_ref IS NOT NULL AND (${theirs})`,
    handle, ...a.logins, ...a.emails);
  return rows.filter((r) => !r.stripe_status || !subscriptionEnded(r.stripe_status)).map((r) => r.id);
}

/**
 * What deleting `handle`'s account would do, and what stands in the way. `null` for a person who does not
 * exist (or is a tombstone already).
 */
export async function accountDeletionPreview(p: PlatformContext, handle: string, ask: AccountAsk): Promise<AccountDeletionPreview | null> {
  const person = await getPerson(p, handle);
  // A tombstone is gone already; a RESERVED handle (`github-webhook`, `trov`, …) is a system principal that content
  // must keep pointing at, never an account anyone can delete.
  if (!person || person.handle.toLowerCase().startsWith(TOMBSTONE_PREFIX) || RESERVED_HANDLES.includes(person.handle.toLowerCase())) return null;
  const h = person.handle;
  const self = ask.by === "self";
  const you = self ? "You're" : `@${h} is`;
  const [orgs, billed, superadmin, admins, addresses] = await Promise.all([
    membershipsOf(p, h), billedOrgs(p, h), isSuperadmin(p, h),
    first<{ n: number }>(p, `SELECT COUNT(*) AS n FROM platform_admins`), addressesOf(p, h, person.email),
  ]);
  const deletes = orgs.filter(goesWithAccount);
  const leaves = orgs.filter((m) => !goesWithAccount(m));
  const blockers: AccountBlocker[] = [];
  if (!self && ask.actor.toLowerCase() === h.toLowerCase()) {
    blockers.push({ code: "self", org: null, message: "This is your own account. Delete it from your own Settings." });
  } else if (!self && superadmin) {
    blockers.push({ code: "superadmin", org: null, message: `@${h} is a superadmin. A superadmin's account isn't deleted from Platform: they can delete it themselves in Settings.` });
  }
  if (self && superadmin && (admins?.n ?? 0) <= 1) {
    blockers.push({ code: "last_superadmin", org: null, message: "You're the platform's only superadmin. Make someone else a superadmin in Platform › Admins first." });
  }
  for (const m of leaves) {
    if (m.role !== "owner" || m.owners > 1 || m.members <= 1) continue;
    const others = plural(m.members - 1, "other person is", "other people are");
    blockers.push({
      code: "last_owner", org: { slug: m.slug, name: m.name },
      message: self
        ? `You're the only owner of ${m.name}, and ${others} in it. Make one of them an owner in Org settings › Members, or delete the organization first.`
        : `${you} the only owner of ${m.name} (${m.slug}), and ${others} in it. Make one of them an owner (Add another owner), or delete the organization first.`,
    });
  }
  const gone = new Set(deletes.map((d) => d.org_id));
  for (const b of billed) {
    if (gone.has(b.org_id)) continue; // its subscription is cancelled with it
    blockers.push({
      code: "billing_buyer", org: { slug: b.slug, name: b.name },
      message: self
        ? `You pay for ${b.name}'s Pro plan, which is still renewing. Cancel the plan in Org settings › General (it stays Pro until the end of the period already paid), or contact us to move the billing to another owner, first.`
        : `@${h} pays for ${b.name}'s (${b.slug}) Pro plan, which is still renewing. Its owner cancels the plan in Org settings › General, or delete the organization first.`,
    });
  }
  const paid = await Promise.all(deletes.map(async (d) => {
    const org = await orgForDeletion(p, { id: d.org_id });
    return org ? (await orgSubscriptions(p, org)).some((s) => s.live) : false;
  }));
  return {
    handle: h,
    leaves: leaves.map((m) => ({ slug: m.slug, name: m.name, role: m.role })),
    deletes: deletes.map((d, i) => ({ slug: d.slug, name: d.name, paid: paid[i] })),
    unused_paid: (await unusedPaidGrants(p, h, addresses)).length,
    blockers,
    confirm: h,
  };
}

/** The statements of step 3: everything the person's rows hold, deleted or rewritten to `tomb`. */
function personStmts(p: PlatformContext, h: string, tomb: string, a: { logins: string[]; emails: string[]; identities: { provider: string; subject: string }[] }, ask: AccountAsk, orgsDeleted: string[], at: string, ref: string): Stmt[] {
  const inEmails = (col: string) => (a.emails.length ? ` OR lower(${col}) IN (${ph(a.emails.length)})` : "");
  const counters = a.identities.map((i) => `onboard:${i.provider}:${i.subject}`);
  const needles = [...new Set([h, ...a.logins, ...a.emails])];
  return [
    stmt(p, "PRAGMA defer_foreign_keys = true"),
    // Signing in, and every way an agent acted as them.
    stmt(p, `DELETE FROM sessions WHERE person = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE person = ? COLLATE NOCASE)`, h),
    stmt(p, `DELETE FROM oauth_codes WHERE person = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM oauth_grant_orgs WHERE person = ?1 COLLATE NOCASE OR grant_id IN (SELECT id FROM oauth_grants WHERE person = ?1 COLLATE NOCASE)`, h),
    stmt(p, `DELETE FROM oauth_grants WHERE person = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM mcp_tokens WHERE person = ? COLLATE NOCASE`, h),
    // A handoff they were still uploading the prompt of (0080): it holds their text and was never sent.
    stmt(p, `DELETE FROM handoff_upload_tokens WHERE principal = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM identities WHERE person = ? COLLATE NOCASE`, h),
    // E-mail: their preferences, and every digest addressed to them (with its dev-only body).
    stmt(p, `DELETE FROM notification_outbox_bodies WHERE idempotency_key IN (SELECT idempotency_key FROM notification_outbox WHERE user_id = ? COLLATE NOCASE)`, h),
    stmt(p, `DELETE FROM notification_outbox WHERE user_id = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM notification_prefs WHERE user_id = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM notification_person_prefs WHERE user_id = ? COLLATE NOCASE`, h), // 0067: "only when something needs me"
    stmt(p, `DELETE FROM library_prefs WHERE handle = ? COLLATE NOCASE`, h), // 0084: their own sidebar and cards
    // Ask Trov (0066_ask): their PRIVATE attachments first (`ASK_ATTACHMENTS_OF`; they go with the account — every
    // version, link and search row; the bytes after the commit), then their threads, in every org, with everything
    // that hangs off them, and their settings. An attachment they published to the org, and every answer they SAVED,
    // stay in the library as every artifact of theirs does. These run BEFORE the threads go (the subquery reads
    // `chat_artifacts`) and before the handle becomes the tombstone.
    stmt(p, `DELETE FROM artifact_upload_tokens WHERE page_id IN (${ASK_ATTACHMENTS_OF})`, h),
    stmt(p, `DELETE FROM artifact_links WHERE page_id IN (${ASK_ATTACHMENTS_OF})`, h),
    stmt(p, `DELETE FROM artifact_versions WHERE page_id IN (${ASK_ATTACHMENTS_OF})`, h),
    stmt(p, `DELETE FROM artifacts_fts WHERE CAST(page_id AS INTEGER) IN (${ASK_ATTACHMENTS_OF})`, h),
    stmt(p, `DELETE FROM artifact_pages WHERE id IN (${ASK_ATTACHMENTS_OF})`, h),
    // A file of theirs in someone ELSE's thread (shared with them to continue, 0077) leaves its link behind: it goes
    // too (their question keeps the file's name, as every reader saw it).
    stmt(p, `DELETE FROM chat_artifacts WHERE role = 'attachment'
               AND NOT EXISTS (SELECT 1 FROM artifact_pages p WHERE p.id = chat_artifacts.artifact_id AND p.org_id = chat_artifacts.org_id)`),
    // Sharing by name (0077): who their threads are shared with, and every share naming them. Their turns in someone
    // else's thread stay, under the tombstone (`asked_by` is in HANDLE_COLUMNS), so that conversation stays whole.
    stmt(p, `DELETE FROM chat_thread_people WHERE handle = ? COLLATE NOCASE
               OR thread_id IN (SELECT id FROM chat_threads WHERE handle = ? COLLATE NOCASE)`, h, h),
    stmt(p, `DELETE FROM chat_actions WHERE thread_id IN (SELECT id FROM chat_threads WHERE handle = ? COLLATE NOCASE)`, h),
    stmt(p, `DELETE FROM chat_artifacts WHERE thread_id IN (SELECT id FROM chat_threads WHERE handle = ? COLLATE NOCASE)`, h),
    stmt(p, `DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE handle = ? COLLATE NOCASE)`, h),
    stmt(p, `DELETE FROM chat_threads WHERE handle = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM person_ask_settings WHERE handle = ? COLLATE NOCASE`, h),
    ...(a.emails.length ? [stmt(p, `DELETE FROM platform_outbox_bodies WHERE lower(to_address) IN (${ph(a.emails.length)})`, ...a.emails)] : []),
    // Every organization they leave says so in the admin trail, then the memberships go.
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
             SELECT org_id, ?1, 'member.leave', ?1, '{"account_deleted":true}', ?2 FROM memberships WHERE user_id = ?3 COLLATE NOCASE`, tomb, at, h),
    stmt(p, `DELETE FROM memberships WHERE user_id = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM org_login_map WHERE person = ? COLLATE NOCASE`, h),
    stmt(p, `DELETE FROM platform_admins WHERE person = ? COLLATE NOCASE`, h),
    // Invitations they answered.
    stmt(p, `DELETE FROM org_invites WHERE responded_by = ? COLLATE NOCASE`, h),
    // Their messages to the operator: signed in, or sent from one of their addresses.
    stmt(p, `DELETE FROM support_reports WHERE reporter = ? COLLATE NOCASE${inEmails("contact_email")}`, h, ...a.emails),
    // Grants addressed to them: one not yet used is revoked, and none names them any more.
    stmt(p, `UPDATE org_grants SET
               revoked_at = CASE WHEN status = 'unused' THEN ?1 ELSE revoked_at END,
               revoked_by = CASE WHEN status = 'unused' THEN 'system' ELSE revoked_by END,
               status = CASE WHEN status = 'unused' THEN 'revoked' ELSE status END,
               person = ?2, github_login = NULL, email = NULL
             WHERE person = ?3 COLLATE NOCASE${a.logins.length ? ` OR github_login IN (${a.logins.map((_, i) => `?${4 + i}`).join(", ")})` : ""}${a.emails.length ? ` OR lower(email) IN (${a.emails.map((_, i) => `?${4 + a.logins.length + i}`).join(", ")})` : ""}`,
      at, tomb, h, ...a.logins, ...a.emails),
    // The AI router's stale scopes that name them (0058_ai_dirty): their brief (`person:<handle>`) and their GitHub
    // sessions (`session:<repo>:<login>`). No other scope key names a person.
    stmt(p, `DELETE FROM ai_dirty WHERE scope = 'person' AND scope_key = ? COLLATE NOCASE`, h),
    // Their briefs (0063_person_brief): written about them, for them alone — gone with the account, never renamed.
    stmt(p, `DELETE FROM person_brief WHERE handle = ? COLLATE NOCASE`, h),
    ...[h, ...a.logins].map((n) => stmt(p, `DELETE FROM ai_dirty WHERE scope = 'session' AND lower(substr(scope_key, -length(?1) - 1)) = lower(':' || ?1)`, n)),
    // The session digests' bookkeeping (0061_ai_digests) keyed by those logins. The digests themselves stay, as
    // content: their `subject` becomes the tombstone through HANDLE_COLUMNS, like every other entry.
    ...(a.logins.length ? [stmt(p, `DELETE FROM ai_sessions WHERE lower(actor_login) IN (${a.logins.map((_, i) => `lower(?${i + 1})`).join(", ")})`, ...a.logins)] : []),
    // Their live agent links end (0078_agent_links), in every org: a draft or a request is cancelled, an open link
    // closed — by them, so `closed_by` names the tombstone once HANDLE_COLUMNS below rewrites it. No one's agent goes
    // on writing to a side whose person is gone. The thread stays, as content, like a handoff's body.
    stmt(p, `UPDATE agent_links SET state = CASE WHEN state = 'open' THEN 'closed' ELSE 'cancelled' END, closed_at = ?2,
               closed_by = CASE WHEN state = 'open' THEN ?1 ELSE closed_by END,
               close_reason = CASE WHEN state = 'open' THEN 'account deleted' ELSE close_reason END
             WHERE state IN ('draft', 'requested', 'open') AND (requester = ?1 COLLATE NOCASE OR recipient = ?1 COLLATE NOCASE)`, h, at),
    // Rate-limit counters (two days at most anyway), by handle and by the sign-ins they were onboarded with.
    stmt(p, `DELETE FROM abuse_counters WHERE subject = ? COLLATE NOCASE${counters.length ? ` OR subject IN (${ph(counters.length)})` : ""}`, h, ...counters),
    // The ONE sentence Trov writes with a handle in it (src/tools/handoffs.ts: "<sender> left a handoff for
    // <recipient>: …", a feed entry's summary) names the tombstone instead — and its search row follows (the
    // feed's FTS has no update trigger). Text PEOPLE typed is never rewritten: a mention stays as typed.
    stmt(p, `UPDATE feed SET summary = ?2 || substr(summary, length(?1) + 1) WHERE substr(summary, 1, length(?1) + 20) = ?1 || ' left a handoff for '`, h, tomb),
    stmt(p, `UPDATE feed SET summary = replace(summary, ' left a handoff for ' || ?1 || ':', ' left a handoff for ' || ?2 || ':') WHERE instr(summary, ' left a handoff for ' || ?1 || ':') > 0`, h, tomb),
    stmt(p, `UPDATE feed_fts SET summary = (SELECT f.summary FROM feed f WHERE CAST(f.id AS TEXT) = feed_fts.feed_id)
              WHERE feed_id IN (SELECT CAST(id AS TEXT) FROM feed WHERE instr(summary, ?) > 0)`, tomb),
    // The admin trail: the person as a target, and their handle, logins and addresses inside an entry's details.
    stmt(p, `UPDATE org_admin_audit SET target = ? WHERE target = ? COLLATE NOCASE`, tomb, h),
    ...needles.map((n) => stmt(p, `UPDATE org_admin_audit SET detail = replace(detail, ?1, ?2) WHERE instr(detail, ?1) > 0`, JSON.stringify(n), JSON.stringify(tomb))),
    // The person row becomes the tombstone, and every column that held the handle names it instead.
    stmt(p, `UPDATE persons SET handle = ?1, name = ?2, color = 'stone', avatar_url = NULL, avatar_sha = NULL, avatar_source = NULL,
               email = NULL, email_unsubscribed = 1, role = NULL, responsibilities = NULL, org_limit = NULL, created_at = ?3, onboarded_at = ?3
             WHERE handle = ?4 COLLATE NOCASE`, tomb, TOMBSTONE_NAME, at, h),
    ...HANDLE_COLUMNS.map(([t, c]) => stmt(p, `UPDATE ${t} SET ${c} = ? WHERE ${c} = ? COLLATE NOCASE`, tomb, h)),
    // The one record that it happened: the tombstone (never the old handle), who asked, and `ref` — a keyed
    // hash of the old handle (`deletionRef`), which names no one but lets the operator find the person again
    // in a database restored from before the deletion (D1 Time Travel), to delete them again.
    stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (NULL, ?, 'person.delete', ?, ?, ?)`,
      ask.by === "self" ? tomb : ask.actor, tomb, JSON.stringify({ by: ask.by, ref, ...(orgsDeleted.length ? { orgs_deleted: orgsDeleted } : {}) }), at),
  ];
}

export interface DeletedAccount { tombstone: string; orgs_deleted: string[]; cancelled: string[]; r2: R2Sweep }

/**
 * Delete `handle`'s account. Re-checks the guard rails (a stale preview cannot get past them): `blocked`
 * (409) with the blockers, `not_found`, or a billing refusal — and in each case nothing is deleted.
 */
export async function deleteAccount(env: Env, p: PlatformContext, handle: string, ask: AccountAsk, fetchImpl?: typeof fetch): Promise<DeletedAccount> {
  const preview = await accountDeletionPreview(p, handle, ask);
  if (!preview) throw new DeletionError("not_found", "no such person");
  if (preview.blockers.length) throw new DeletionError("blocked", preview.blockers.map((b) => b.message).join(" "), preview.blockers);
  const h = preview.handle;
  const person = (await getPerson(p, h))!;
  const addresses = await addressesOf(p, h, person.email);

  // 1. Billing, for everything at once — before anything is deleted.
  const orgs: OrgToDelete[] = [];
  for (const d of preview.deletes) {
    const org = await orgForDeletion(p, { slug: d.slug });
    if (org) orgs.push(org);
  }
  const subs = new Set(await unusedPaidGrants(p, h, addresses));
  const checkouts = new Set(await openCheckouts(p, { person: h }));
  for (const org of orgs) {
    for (const s of await orgSubscriptions(p, org)) if (s.live) subs.add(s.id);
    for (const c of await openCheckouts(p, { forOrg: org.id })) checkouts.add(c);
  }
  const cancelled = await endAtStripe(env, [...subs], [...checkouts], fetchImpl);

  // 2. The organizations nobody else is in.
  const actor = ask.by === "self" ? h : ask.actor;
  for (const org of orgs) await deleteOrganization(env, p, org, { by: ask.by, actor, fetchImpl, billingSettled: true, withAccount: true });

  // 3. The person — one batch. A tombstone that is somehow taken already aborts it whole; one retry.
  const at = nowIso();
  const avatar = person.avatar_sha;
  const askKeys = await askAttachmentKeys(p, h);
  const ref = await deletionRef(env.COOKIE_SECRET, h);
  let tomb = tombstoneHandle();
  try {
    await batch(p, personStmts(p, h, tomb, addresses, ask, orgs.map((o) => o.slug), at, ref));
  } catch (e) {
    if (!/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) throw e;
    tomb = tombstoneHandle();
    await batch(p, personStmts(p, h, tomb, addresses, ask, orgs.map((o) => o.slug), at, ref));
  }

  // 4. Their photo and their private Ask attachments' bytes, each if nobody else's is the same bytes.
  const r2 = await sweepR2(p, env.ARTIFACTS_BUCKET, { ...noCandidates(), artifacts: artifactShas(askKeys), avatars: avatar ? [avatar] : [] });
  return { tombstone: tomb, orgs_deleted: orgs.map((o) => o.slug), cancelled, r2 };
}
