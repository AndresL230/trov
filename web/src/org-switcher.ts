// The sidebar's org switcher button (org-picker.ts has its menu). Its own module so the site's hero, which draws the
// app's own sidebar, need not load the org picker.
import type { MyOrg } from "@shared/orgs";
import { esc, attr } from "./ui";
import { orgTile } from "./org-tile";

export const UPDOWN = `<svg class="cnpy-lbl" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;color:var(--fg-40)"><path d="m7 9 5-5 5 5"></path><path d="m7 15 5 5 5-5"></path></svg>`;

export interface OrgSwitcherProps {
  /** The org on screen (null only before the first paint has one). */
  org: MyOrg | null;
  open: boolean;
  /** Pending invitations, as a count on the button (0 = none). */
  invites: number;
  /** Logins waiting in Org settings › Members for an admin to match (0 for a member): they
   *  join the button's count, since the menu behind it is the way to Org settings. */
  logins?: number;
  collapsed: boolean;
}
/** What the switcher's count stands for, in words. */
export function orgWaitingTitle(invites: number, logins: number): string {
  const parts = [invites ? `${invites} pending ${invites === 1 ? "invitation" : "invitations"}` : "", logins ? `${logins} ${logins === 1 ? "login" : "logins"} to match in Org settings` : ""].filter(Boolean);
  return parts.join(" · ") || "Nothing waiting";
}
/** The sidebar header's button: the current org's name; it opens the menu (`orgMenu`). Always
 *  emitted — collapsed, the rail keeps the tile and its tooltip names the org. */
export function orgSwitcherButton(p: OrgSwitcherProps): string {
  const name = p.org?.name ?? "Organizations";
  const waiting = p.invites + (p.logins ?? 0);
  return `<div class="cnpy-orgsw" data-tip="${attr(p.org ? `${name}: switch organization` : "Organizations")}">
    <button type="button" data-act="orgsMenu" data-field="orgsMenu" data-orgsw-trigger class="cnpy-orgsw-b${p.open ? " is-open" : ""}" style="border-radius:8px" aria-haspopup="dialog" aria-expanded="${p.open}" aria-controls="orgs-menu" aria-label="${attr(p.org ? `${name}: switch organization` : "Organizations")}">
      ${orgTile(name, 24, p.org?.logo_url)}
      <span class="cnpy-lbl cnpy-orgsw-n">${esc(name)}</span>
      <span class="cnpy-lbl cnpy-badge" data-n="${waiting}" title="${attr(orgWaitingTitle(p.invites, p.logins ?? 0))}">${waiting}</span><span class="cnpy-dot" data-n="${waiting}"></span>
      ${UPDOWN}
    </button>
  </div>`;
}
