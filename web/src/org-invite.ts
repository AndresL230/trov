// "Invite someone" (web-ui.md › The app's bundles): ONE form for Org settings › Members and the
// first-run setup's third step (welcome.ts), so both obey the same gate. It is in the app's first
// download because the setup is; org-settings.ts (the lazy Org settings chunk) re-exports it.
import { INVITE_NAME_MAX, GITHUB_LOGIN_RE, INVITE_EMAIL_RE, type MyOrg, type OrgInvite } from "@shared/orgs";
import { esc, attr, relTime, surface } from "./ui";
import { O_FIELD, O_HELP, O_ERR, accentBtn, orgHead, roleOption, roleAtLeast, fieldError } from "./org-ui";
import { inviteGate, seatCapAction, checkoutTerms } from "./org-plan";
import { segmented } from "./segmented";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import type { OrgUi } from "./org-core";

/** Is the invite draft a GitHub login / an email address? (The server validates again.) */
export function inviteDraftOk(by: "github" | "email", draft: string): boolean {
  const v = draft.trim().replace(/^@/, "");
  return by === "github" ? GITHUB_LOGIN_RE.test(v) : INVITE_EMAIL_RE.test(v);
}
/** The role an invite grants: member or admin (an owner is made from a member, in the editor). */
export const inviteRoleDropdown = (ui: Pick<OrgUi, "inviteRole">): DropdownProps => ({
  id: "org-invite-role", act: "orgInviteRole", value: ui.inviteRole, ariaLabel: "Role the invite grants",
  options: [roleOption("member", "As member"), roleOption("admin", "As admin")],
});
/** What happened to an invite's e-mail, as one short phrase for its row (and whether it needs attention). */
export function inviteMailNote(i: OrgInvite): { text: string; bad: boolean } {
  if (i.github_login) return { text: "No email: they see it when they sign in", bad: false };
  if (i.mail_status === "sent") return { text: `Email sent ${i.mail_at ? relTime(i.mail_at) : ""}`.trim(), bad: false };
  if (i.mail_status === "failed") return { text: `Email not sent${i.mail_at ? ` (tried ${relTime(i.mail_at)})` : ""}`, bad: true };
  return { text: "No email sent yet", bad: false };
}

/**
 * "Invite someone" — Members' primary action, and the first-run wizard's third step (welcome.ts):
 * ONE form, so both obey the same gate. The plan's seats (org-plan.ts): a one-person plan offers
 * no invitation at all (""); with every seat in use the form gives way to the sentence the server
 * would answer with — and, for the owner, the one thing that fixes it: "Add a seat" (paid Pro) or
 * "Upgrade to Pro" (Free). One line of controls in one surface, with what happens next said once,
 * under them. Admins only.
 */
export function inviteSection(org: MyOrg, ui: OrgUi, dd: DropdownUi = initialDropdownUi()): string {
  const admin = roleAtLeast(org.role, "admin");
  const canSend = inviteDraftOk(ui.inviteBy, ui.inviteDraft) && !ui.inviteBusy;
  const gate = inviteGate(ui.plan.data, org.role);
  const fix = gate.kind === "full" ? seatCapAction(gate.next, ui.billing, ui.plan.data?.billing?.available ?? false) : "";
  return !admin || gate.kind === "solo" ? ""
    : gate.kind !== "open" ? `<section aria-labelledby="org-invite-t" data-invite-gate="${gate.kind}">
      ${orgHead("Invite someone", "", null, "org-invite-t")}
      <div${surface("padding:14px 16px")}><p role="status" style="margin:0;font-size:13px;line-height:1.55;color:var(--fg-70)">${esc(gate.sentence)}${gate.kind === "full" ? " Removing a member or revoking a pending invite frees a seat." : ""}</p>${fix ? `<div class="cnpy-plan-actions" data-seat-fix="${gate.next ?? ""}">${fix}</div>${gate.next === "upgrade" ? checkoutTerms() : ""}` : ""}${fix && ui.billing.error ? `<div role="alert" style="${O_ERR}">${esc(ui.billing.error)}</div>` : ""}</div>
    </section>`
    : `<section aria-labelledby="org-invite-t">
      ${orgHead("Invite someone", "", null, "org-invite-t")}
      <div${surface("padding:14px 16px")}>
        <div class="cnpy-field-anchor"><div class="cnpy-org-invite">
          ${segmented({ id: "org-invite-by", ariaLabel: "Invite by", act: "orgInviteBy", value: ui.inviteBy, size: "sm", inertOn: true, options: [{ value: "github", label: "GitHub login" }, { value: "email", label: "Email" }] })}
          <input id="org-invite" data-act="orgInviteDraft" data-field="orgInvite" data-enter="orgInviteSend" value="${attr(ui.inviteDraft)}" placeholder="${ui.inviteBy === "github" ? "octocat" : "name@example.com"}" aria-label="${ui.inviteBy === "github" ? "GitHub login to invite" : "Email address to invite"}"${ui.inviteBy === "email" ? ' type="email" inputmode="email"' : ""} autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="org-invite-h${ui.inviteError ? " org-invite-e" : ""}"${ui.inviteError ? ' aria-invalid="true"' : ""} class="cnpy-input" style="${O_FIELD};flex:1 1 200px;width:auto;min-width:0;${ui.inviteError ? "border-color:var(--red);" : ""}" />
          ${ui.inviteBy === "email" ? `<input id="org-invite-name" data-act="orgInviteName" data-field="orgInviteName" data-enter="orgInviteSend" value="${attr(ui.inviteName)}" maxlength="${INVITE_NAME_MAX}" placeholder="Their name (optional)" aria-label="Their name, for the email's greeting (optional)" autocomplete="off" class="cnpy-input" style="${O_FIELD};flex:1 1 160px;width:auto;min-width:0" />` : ""}
          ${dropdown(inviteRoleDropdown(ui), dd)}
          ${accentBtn(ui.inviteBusy ? "Inviting…" : "Invite", "orgInviteSend", { disabled: !canSend, busy: ui.inviteBusy, extra: "height:36px" })}
        </div>${ui.inviteError ? fieldError("org-invite-e", ui.inviteError) : ""}</div>
        <div id="org-invite-h" style="${O_HELP};margin-top:9px">${ui.inviteBy === "email"
          ? "Trov emails them the invitation. They join when they sign in with that address, with Google or GitHub, and accept."
          : "They see the invitation the next time they sign in with that GitHub account, and join when they accept. No email is sent: tell them it is waiting."}</div>
      </div>
    </section>`;
}

