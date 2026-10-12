// Deleting an account or an organization — the views (pure: state in, markup out). Where each lives:
//   • Settings › Delete account (`accountDeleteTile`, `accountDeleteModal`) — anyone signed in, for themselves;
//   • Org settings › General › Delete organization (`orgDeleteTile`, `orgDeleteModal`) — an OWNER;
//   • Platform › an organization, and Platform › Admins › Delete an account — a superadmin
//     (`orgDeleteModal` / `personDeleteSection` / `personDeleteModal`, with `platform` copy).
// Every one confirms in the ONE confirmation modal (confirm.ts) with the handle or the slug TYPED, says what
// is deleted, what is kept and why (the sentences of shared/deletion-core.ts), and shows a guard rail as the
// reason the button is not there yet — never as blame. The acts are deletion-actions.ts's (Settings, Org
// settings) and platform-actions.ts's (Platform); the server re-checks everything (src/deletion/).
import { esc, attr } from "./ui";
import { confirmModal, dangerTrigger } from "./confirm";
import { dangerLink } from "./org-ui";
import {
  ACCOUNT_DELETE_AFTER, ACCOUNT_DELETE_AFTER_THEIRS, ACCOUNT_DELETE_KEEPS, ACCOUNT_DELETE_KEEPS_THEIRS, ACCOUNT_DELETE_REMOVES,
  ACCOUNT_DELETE_REMOVES_THEIRS, ORG_DELETE_BILLING, ORG_DELETE_KEEPS, ORG_DELETE_REMOVES,
  type AccountDeletionPreview, type OrgDeletionPreview,
} from "@shared/deletion-core";

export interface DeleteSlice<P> { status: "idle" | "loading" | "ok" | "error"; data: P | null }
/** One deletion's UI: its preview (what it would do), whether the confirmation is open, what was typed. */
export interface DeleteUi<P> {
  preview: DeleteSlice<P>;
  open: boolean;
  typed: string;
  busy: boolean;
  /** Why the last attempt was refused, as a sentence. */
  error: string | null;
}
export const initialDeleteUi = <P>(): DeleteUi<P> => ({ preview: { status: "idle", data: null }, open: false, typed: "", busy: false, error: null });

const LABEL = "font-size:11px;font-weight:600;font-family:var(--label);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:10px";
const TEXT = "font-size:12.5px;line-height:1.55;color:var(--fg-55)";
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const names = (xs: { name: string }[]): string => {
  const n = xs.map((x) => `<strong>${esc(x.name)}</strong>`);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};
const li = (label: string, text: string): string => `<li><strong>${esc(label)}</strong> ${text}</li>`;

/** The guard rails that stand in the way, as a list of sentences (each names its organization). */
function blockerList(id: string, b: AccountDeletionPreview["blockers"]): string {
  return `<ul id="${attr(id)}" class="cnpy-del-blockers">${b.map((x) => `<li>${esc(x.message)}</li>`).join("")}</ul>`;
}

// ── your own account (Settings) ──────────────────────────────────────────────

export const ACCOUNT_DELETE_ID = "acct-delete-confirm";

/** Settings › Delete account: one sentence, the guard rails when there are any, and the button. */
export function accountDeleteTile(ui: DeleteUi<AccountDeletionPreview>): string {
  const p = ui.preview.data;
  const blocked = !!p && p.blockers.length > 0;
  const status = ui.preview.status === "error"
    ? `<div role="alert" style="${TEXT};margin-top:8px">Trov couldn't check what deleting your account involves. <button type="button" data-act="acctDelLoad" class="cnpy-mutelink" style="padding:0;font-size:12.5px;font-weight:500;color:var(--accent)">Try again</button></div>`
    : blocked ? `<div style="${TEXT};margin-top:8px">Before you can delete your account:</div>${blockerList("acct-delete-blockers", p!.blockers)}`
    : "";
  const button = blocked
    ? `<button type="button" disabled aria-describedby="acct-delete-blockers" class="cnpy-dangerbtn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-40);white-space:nowrap;opacity:.7">Delete my account…</button>`
    : dangerTrigger({ label: "Delete my account…", act: "acctDelArm", armed: ui.open, controls: ACCOUNT_DELETE_ID });
  return `<section class="cnpy-tile cnpy-surface cnpy-set-delete" aria-labelledby="acct-delete-h">
    <div id="acct-delete-h" style="${LABEL}">Delete account</div>
    <div class="cnpy-set-who">
      <div style="flex:1 1 320px;min-width:0">
        <div style="${TEXT}">Deletes your account and signs you out everywhere. What you wrote in organizations that carry on stays for the people you worked with, credited to “Deleted user”.</div>
        ${status}
      </div>
      ${button}
    </div>
  </section>`;
}

/** The account confirmation's list: what goes, what stays, the organizations that go with it. */
function accountDetail(p: AccountDeletionPreview, platform: boolean): string {
  const items: string[] = [li("Deleted:", esc(platform ? ACCOUNT_DELETE_REMOVES_THEIRS : ACCOUNT_DELETE_REMOVES))];
  if (p.deletes.length) {
    const paid = p.deletes.some((d) => d.paid);
    items.push(li("Also deleted:", `${names(p.deletes)}, which nobody else is in — with everything in ${p.deletes.length === 1 ? "it" : "them"}.${paid ? ` ${esc(ORG_DELETE_BILLING)}` : ""}`));
  }
  if (p.unused_paid) items.push(li("Cancelled:", `${p.unused_paid === 1 ? "a Pro plan" : `${p.unused_paid} Pro plans`} paid for but never set up, at Stripe right away. The time already paid for is not refunded.`));
  if (p.leaves.length) items.push(li("Left:", `${names(p.leaves)}.`));
  items.push(li("Kept:", esc(platform ? ACCOUNT_DELETE_KEEPS_THEIRS : ACCOUNT_DELETE_KEEPS)));
  return `<ul>${items.join("")}</ul><p style="margin:10px 0 0">${esc(platform ? ACCOUNT_DELETE_AFTER_THEIRS : ACCOUNT_DELETE_AFTER)}</p>`;
}

/** The confirmation for one's own account (Settings) or, with `platform`, a superadmin's for someone else's. */
export function accountDeleteModal(ui: DeleteUi<AccountDeletionPreview>, o: { platform?: boolean; id?: string; acts?: { go: string; cancel: string; typed: string } } = {}): string {
  const p = ui.preview.data;
  if (!ui.open || !p) return "";
  const platform = o.platform === true;
  const acts = o.acts ?? { go: "acctDelGo", cancel: "acctDelCancel", typed: "acctDelTyped" };
  return confirmModal({
    id: o.id ?? ACCOUNT_DELETE_ID, wide: true,
    title: platform ? `Delete @${p.handle}'s account?` : "Delete your account?",
    body: platform ? "This can't be undone. Their account is deleted for good." : "This can't be undone. Your account is deleted for good.",
    detail: accountDetail(p, platform),
    typed: { label: platform ? `Type their handle, ${p.confirm}, to confirm` : `Type your handle, ${p.confirm}, to confirm`, expected: p.confirm, value: ui.typed, act: acts.typed },
    error: ui.error,
    confirmLabel: platform ? "Delete account" : "Delete my account", busyLabel: "Deleting…",
    confirmAct: acts.go, cancelAct: acts.cancel, busy: ui.busy,
  });
}

// ── an organization (Org settings › General; Platform) ───────────────────────

export const ORG_DELETE_ID = "org-delete-confirm";

/** Org settings › General › Delete organization — shown to an OWNER only (the caller decides). Org settings'
 *  hierarchy (org-ui.ts): a destructive act there is a quiet text action (`dangerLink`), never a bordered one. */
export function orgDeleteTile(org: { name: string }, ui: DeleteUi<OrgDeletionPreview>): string {
  const trigger = dangerLink("Delete organization…", "orgDelArm", { label: `Delete ${org.name}` })
    .replace("<button ", `<button data-confirm-trigger aria-expanded="${ui.open}" aria-controls="${ORG_DELETE_ID}" `);
  return `<section class="cnpy-tile cnpy-surface cnpy-org-gen-delete" aria-labelledby="org-delete-h">
    <div id="org-delete-h" style="${LABEL}">Delete organization</div>
    <div class="cnpy-set-who">
      <div style="flex:1 1 320px;min-width:0;${TEXT}">Deletes ${esc(org.name)} and everything in it, for everyone in it. Its members keep their Trov accounts. If it pays for Pro, the subscription is cancelled right away, without a refund for the time already paid.</div>
      ${trigger}
    </div>
    ${ui.preview.status === "error" && !ui.open ? `<div role="alert" style="${TEXT};margin-top:8px;color:var(--red)">${esc(ui.error ?? "Trov couldn't check what deleting it involves. Try again.")}</div>` : ""}
  </section>`;
}

function orgDetail(p: OrgDeletionPreview): string {
  const counts = [
    plural(p.members, "member loses", "members lose") + " access",
    ...(p.pending_invites ? [`${plural(p.pending_invites, "pending invitation is", "pending invitations are")} withdrawn`] : []),
    ...(p.repositories ? [`${plural(p.repositories, "repository is", "repositories are")} disconnected`] : []),
  ];
  const items = [
    li("Deleted:", esc(ORG_DELETE_REMOVES)),
    li("For its people:", `${esc(counts.join("; "))}.`),
    ...(p.subscription ? [li("Billing:", esc(ORG_DELETE_BILLING))] : []),
    li("Kept:", esc(ORG_DELETE_KEEPS)),
  ];
  return `<ul>${items.join("")}</ul>`;
}

/** The confirmation for an organization — its owner's (Org settings) or a superadmin's (Platform). */
export function orgDeleteModal(ui: DeleteUi<OrgDeletionPreview>, o: { platform?: boolean; id?: string; acts?: { go: string; cancel: string; typed: string } } = {}): string {
  const p = ui.preview.data;
  if (!ui.open || !p) return "";
  const acts = o.acts ?? { go: "orgDelGo", cancel: "orgDelCancel", typed: "orgDelTyped" };
  const stuck = !p.billing_ready ? "This organization pays through Stripe, and Stripe isn't set up here to cancel it, so it can't be deleted yet. Contact us." : null;
  return confirmModal({
    id: o.id ?? ORG_DELETE_ID, wide: true,
    title: `Delete ${p.org.name}?`,
    body: o.platform ? `This can't be undone. Everything in it is deleted for everyone in it; you are not one of its members.` : "This can't be undone. Everything in it is deleted for everyone in it.",
    detail: orgDetail(p),
    typed: { label: `Type its slug, ${p.confirm}, to confirm`, expected: p.confirm, value: ui.typed, act: acts.typed },
    error: ui.error ?? stuck, confirmDisabled: stuck !== null,
    confirmLabel: "Delete organization", busyLabel: "Deleting…",
    confirmAct: acts.go, cancelAct: acts.cancel, busy: ui.busy,
  });
}

// ── Platform › Admins › Delete an account ────────────────────────────────────

export const PERSON_DELETE_ID = "plat-person-delete-confirm";

/** A superadmin names an account by handle, sees what deleting it would do (and what stands in the way),
 *  then confirms. The account itself is never listed: Platform shows no one's content, only this. */
export function personDeleteSection(handle: string, ui: DeleteUi<AccountDeletionPreview>, field: string): string {
  const p = ui.preview.data && ui.preview.data.handle.toLowerCase() === handle.trim().replace(/^@/, "").toLowerCase() ? ui.preview.data : null;
  const result = ui.preview.status === "loading" ? `<div role="status" style="${TEXT};margin-top:10px">Checking…</div>`
    : ui.preview.status === "error" ? `<div role="alert" style="${TEXT};margin-top:10px;color:var(--red)">${esc(ui.error ?? "No account has that handle.")}</div>`
    : p ? (p.blockers.length
      ? `<div style="${TEXT};margin-top:10px">@${esc(p.handle)}'s account can't be deleted yet:</div>${blockerList("plat-person-blockers", p.blockers)}`
      : `<div style="${TEXT};margin-top:10px">@${esc(p.handle)} is in ${plural(p.leaves.length + p.deletes.length, "organization", "organizations")}${p.deletes.length ? `; ${names(p.deletes)} ${p.deletes.length === 1 ? "has" : "have"} nobody else in ${p.deletes.length === 1 ? "it and goes" : "them and go"} with the account` : ""}.</div>
         <div style="margin-top:6px">${dangerLink("Delete account…", "platPersonDelArm", { label: `Delete @${p.handle}'s account` }).replace("<button ", `<button data-confirm-trigger aria-expanded="${ui.open}" aria-controls="${PERSON_DELETE_ID}" `)}</div>`)
    : "";
  return `<label for="plat-person-delete" style="font-size:12.5px;font-weight:600;color:var(--fg-70)">Delete a person's account</label>
    <div class="plat-inline">
      <input id="plat-person-delete" data-act="platPersonDraft" data-field="${attr(field)}" data-enter="platPersonCheck" value="${attr(handle)}" placeholder="Their Trov handle" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="plat-person-delete-h" class="cnpy-input" style="height:34px;padding:0 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--fg);font-size:13.5px;outline:none;flex:1;min-width:0" />
      <button type="button" data-act="platPersonCheck" class="cnpy-outlinebtn"${handle.trim() ? "" : " disabled"} style="height:34px;padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:500;color:var(--fg-70)">Check</button>
    </div>
    <div id="plat-person-delete-h" style="${TEXT};margin-top:8px">The same deletion the person can do in their Settings: what they wrote stays, credited to “Deleted user”. A superadmin's account, and your own, aren't deleted here.</div>
    ${result}`;
}
