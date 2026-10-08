// Organizations — the controller behind the switcher, the picker and the create dialog
// (web/src/org-picker.ts holds the views). Every `orgs…` act main.ts dispatches lands here.
//
// Opening an org is a PAGE LOAD (`/<slug>/`), never an in-place swap: everything the app holds
// in memory belongs to the org it was read for, and a fresh page cannot show one org's data under
// another's name.

import type { AppState } from "./render";
import { ApiError, Unauthorized, createOrg, respondToInvite } from "./api";
import { acceptLanding, blankCreateOrg, createOrgErrors, createOrgServerError } from "./org-picker";
import { slugFromName } from "./platform";
import { orgHref } from "./org-context";
import type { MyOrgsResponse } from "@shared/orgs";

export interface OrgsHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** Read `GET /api/orgs` again (the one loader, in main.ts). */
  reloadOrgs(): Promise<MyOrgsResponse | null>;
  /** Leave for another org's page. */
  go(url: string): void;
  /** Open Org settings in the current org. */
  openSettings(): void;
}

export function createOrgsController(h: OrgsHost) {
  const { state, mount } = h;
  const ui = () => state.orgsUi;
  const focus = (sel: string): void => { mount.querySelector<HTMLElement>(sel)?.focus(); };
  const code = (e: unknown): string => (e instanceof ApiError ? e.message : "");

  function closeMenu(refocus: boolean): void {
    if (!ui().menu) return;
    ui().menu = false;
    h.rerender();
    if (refocus) focus("[data-orgsw-trigger]");
  }
  function openMenu(): void {
    ui().menu = true; ui().inviteError = null;
    h.rerender();
    // Onto the current org's row (or the first row): the arrows move from there.
    (mount.querySelector<HTMLElement>('[data-orgs-menu] [aria-current="true"]') ?? mount.querySelector<HTMLElement>("[data-orgs-menu] [data-orgs-item]"))?.focus();
    // Invitations may have arrived since the page loaded.
    void h.reloadOrgs();
  }

  function closeCreate(): void {
    const d = ui().create;
    if (!d || d.busy) return;
    ui().create = null;
    h.rerender();
    focus(state.view === "app" ? "[data-orgsw-trigger]" : '[data-field^="orgsCreateOpen"]');
  }
  function submitCreate(): void {
    const d = ui().create;
    if (!d || d.busy) return;
    d.errors = createOrgErrors(d);
    if (d.errors.name || d.errors.slug) {
      h.rerender();
      focus(d.errors.name ? "#orgs-create-name" : "#orgs-create-slug");
      return;
    }
    d.busy = true; h.rerender();
    createOrg({ slug: d.slug, name: d.name.trim(), ...(d.grant ? { grant: d.grant.id } : {}) })
      // Its admin lands in Org settings, on the setup checklist.
      .then((org) => h.go(orgHref(org.slug, "#org")))
      .catch((e) => {
        if (e instanceof Unauthorized) { h.unauth(e); return; }
        const cur = ui().create;
        if (!cur) return;
        cur.busy = false;
        cur.errors = createOrgServerError(code(e), cur);
        if (code(e) === "no_grant") void h.reloadOrgs(); // the grant is gone: the card and the menu row go with it
        h.rerender();
        focus(cur.errors.slug ? "#orgs-create-slug" : "#orgs-create-name");
      });
  }

  function answerInvite(id: number, accept: boolean): void {
    const u = ui();
    const invite = state.myOrgs.data?.invites.find((i) => i.id === id);
    if (!invite || u.inviteBusy !== null) return;
    u.inviteBusy = id; u.inviteError = null;
    h.rerender();
    respondToInvite(id, accept)
      .then(() => {
        // Accepted: straight into the org — its new OWNER (a superadmin's owner invite) onto Org settings,
        // where the setup checklist is, exactly as creating an org does. Declined: the list again, without it.
        if (accept) { h.go(acceptLanding(invite)); return; }
        return h.reloadOrgs().then(() => { ui().inviteBusy = null; h.flash(`Declined the invitation to ${invite.org.name}`); });
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { h.unauth(e); return; }
        ui().inviteBusy = null;
        ui().inviteError = code(e) === "not_found"
          ? `The invitation to ${invite.org.name} is no longer open. It may have been revoked.`
          : `The invitation to ${invite.org.name} wasn't ${accept ? "accepted" : "declined"}. Check your connection and try again.`;
        if (code(e) === "not_found") void h.reloadOrgs();
        h.rerender();
      });
  }

  /** Every `orgs…` act. */
  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    switch (name) {
      case "orgsMenu": if (u.menu) closeMenu(true); else openMenu(); return;
      case "orgsMenuClose": closeMenu(true); return;
      // A row is a real link (a page load); this runs for a keyboard activation of one.
      case "orgsSwitch": if (arg) h.go(orgHref(arg, state.view === "app" ? "" : location.hash)); return;
      case "orgsSettings": u.menu = false; h.openSettings(); return;
      case "orgsReload": void h.reloadOrgs(); return;
      case "orgsInvite": {
        const [what, id] = (arg ?? "").split(":");
        const n = Number(id);
        if ((what === "accept" || what === "decline") && Number.isInteger(n)) answerInvite(n, what === "accept");
        return;
      }
      case "orgsCreateOpen": {
        // `arg` = the grant to use (a card on the picker); from the switcher's menu, the oldest.
        const grants = state.myOrgs.data?.grants ?? [];
        const grant = grants.find((g) => String(g.id) === arg) ?? grants[0] ?? null;
        u.menu = false;
        u.create = blankCreateOrg(grant);
        h.rerender();
        focus("#orgs-create-name");
        return;
      }
      case "orgsCreateClose": closeCreate(); return;
      case "orgsCreateName":
        if (!u.create) return;
        u.create.name = value ?? "";
        if (!u.create.slugTouched) { u.create.slug = slugFromName(u.create.name); delete u.create.errors.slug; }
        delete u.create.errors.name; delete u.create.errors.form;
        break;
      case "orgsCreateSlug":
        if (!u.create) return;
        u.create.slug = (value ?? "").toLowerCase().replace(/\s+/g, "-");
        u.create.slugTouched = u.create.slug !== "";
        delete u.create.errors.slug; delete u.create.errors.form;
        break;
      case "orgsCreateSubmit": submitCreate(); return;
      default: return;
    }
    h.rerender();
  }

  // The menu's keyboard: Escape closes it onto its button, ↑ / ↓ (Home / End) move between rows.
  // The create dialog's: Escape closes it, Tab stays inside it.
  document.addEventListener("keydown", (e) => {
    if (ui().create) {
      const dlg = mount.querySelector<HTMLElement>("[data-orgs-create]");
      if (!dlg) return;
      if (e.key === "Escape") { e.preventDefault(); closeCreate(); return; }
      if (e.key !== "Tab") return;
      const items = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const last = items.length - 1;
      if (at < 0 || (e.shiftKey && at === 0) || (!e.shiftKey && at === last)) { e.preventDefault(); items[e.shiftKey ? last : 0].focus(); }
      return;
    }
    if (!ui().menu) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    const menu = mount.querySelector<HTMLElement>("[data-orgs-menu]");
    if (!menu) return;
    if (e.key === "Tab") {
      // Tab walks every control in the menu, then leaves it — which closes it.
      const all = Array.from(menu.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (at < 0 || (e.shiftKey ? at === 0 : at === all.length - 1)) { e.preventDefault(); closeMenu(true); }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>("[data-orgs-item]"));
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[at < 0 && e.key === "ArrowUp" ? items.length - 1 : next].focus();
  }, true);

  return { act, closeMenu };
}
