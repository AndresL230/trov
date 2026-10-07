// Org settings › General's image control — the controller behind org-logo.ts `orgLogoSection`:
// the `orgLogo…` acts, the hidden file input's `change`, Escape on the open menu. It is the photo
// control's behaviour (main.ts, Settings › Profile) for an org: the menu opens onto its first row,
// ↑ / ↓ move between rows (main.ts's handler for `[data-avatar-menu]`, which this menu also is),
// Escape closes it back onto the tile; a pick is cropped and re-encoded by avatar.ts, then uploaded.
// After a write the image is refreshed everywhere the org is shown (the settings slice, `me.orgs`,
// and `GET /api/orgs` through the host's one loader).

import type { AppState } from "./render";
import type { OrgLogo } from "@shared/orgs";
import { ApiError, OrgApiError, Unauthorized, rateLimitText, removeOrgLogo, uploadOrgLogo } from "./api";
import { prepareAvatar } from "./avatar";
import { currentOrg, roleAtLeast } from "./org-settings";

export interface OrgLogoHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  reloadOrgs(): Promise<unknown>;
}

/** A refused upload or removal as a sentence. A picked file avatar.ts refused is already one. */
export function orgLogoErrorText(e: unknown, removing = false): string {
  const fallback = removing ? "Couldn't remove the image." : "Couldn't upload the image.";
  const limited = rateLimitText(e);
  if (limited) return limited;
  if (!(e instanceof ApiError)) return e instanceof Error && e.message && !/fetch|network/i.test(e.message) ? e.message : `${fallback} Check your connection and try again.`;
  if (e.status === 413 || e.message === "too_large") return "That image is too large.";
  if (e.message === "invalid_image") return "That file isn't a PNG, JPEG, WebP or GIF image.";
  if (e.message === "forbidden") return "Only an admin or an owner can change the image.";
  if (e.message === "not_found") return "That no longer exists. Reload the page.";
  return e instanceof OrgApiError && e.detail ? e.detail : `${fallback} Try again.`;
}

export function createOrgLogoActions(host: OrgLogoHost): { act(name: string): boolean } {
  const { state, mount } = host;
  const ui = () => state.org.logo;
  const admin = () => roleAtLeast(currentOrg(state)?.role, "admin");
  const focusTile = () => mount.querySelector<HTMLElement>('[data-act="orgLogoMenu"]')?.focus();

  /** The image changed: the General tab's slice, my own copy of the org, then every list of orgs. */
  function landed(slug: string, logo: OrgLogo, said: string): void {
    ui().busy = null;
    const s = state.org.settings.data;
    if (s && state.org.slug === slug) s.org.logo = logo;
    for (const o of [...(state.me?.orgs ?? []), ...(state.myOrgs.data?.orgs ?? [])]) if (o.slug === slug) o.logo_url = logo.url;
    host.flash(said);
    host.rerender();
    void host.reloadOrgs();
  }
  function refused(e: unknown, removing: boolean): void {
    if (e instanceof Unauthorized) { host.unauth(e); return; }
    ui().busy = null;
    ui().error = orgLogoErrorText(e, removing);
    host.rerender();
  }

  function upload(file: File | undefined | null): void {
    const slug = currentOrg(state)?.slug;
    if (!file || !slug || !admin() || ui().busy) return;
    ui().busy = "upload"; ui().error = null;
    host.rerender();
    prepareAvatar(file)
      .then(({ blob, filename }) => uploadOrgLogo(slug, blob, filename.replace(/^avatar/, "logo")))
      .then((logo) => landed(slug, logo, "Image updated"))
      .catch((e) => refused(e, false));
  }

  function remove(): void {
    const slug = currentOrg(state)?.slug;
    if (!slug || !admin() || ui().busy) return;
    ui().menu = false; ui().busy = "remove"; ui().error = null;
    host.rerender();
    focusTile();
    removeOrgLogo(slug)
      .then((logo) => landed(slug, logo, logo.url ? "Image removed. GitHub's is back." : "Image removed"))
      .catch((e) => refused(e, true));
  }

  // The hidden input the menu's "Upload image" row clicks (a file has no string value to dispatch). On the
  // document, like this controller's other listener: `change` bubbles, and the attribute names the input.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== "file" || !el.hasAttribute("data-orglogo-file")) return;
    upload(el.files?.[0]);
    el.value = ""; // picking the same file again still fires `change`
  });
  // Escape closes the menu and hands focus back to the tile; Tab leaves it, like the other menus.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !ui().menu || state.view !== "app") return;
    ui().menu = false;
    host.rerender();
    focusTile();
  });

  return {
    /** Run one act if it is this control's; any other `org…` act closes its menu and is not consumed. */
    act(name) {
      const u = ui();
      switch (name) {
        // The tile opens its menu (not while a write is in flight); focus moves to the first row.
        case "orgLogoMenu":
          if (u.busy || !admin()) return true;
          u.menu = !u.menu;
          host.rerender();
          if (u.menu) {
            const menu = mount.querySelector<HTMLElement>("[data-orglogo-menu]");
            menu?.classList.add("cnpy-flash"); // it pops once, on the paint that opens it
            menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
          }
          return true;
        case "orgLogoMenuClose": u.menu = false; host.rerender(); return true;
        // Close the menu FIRST, then click the fresh input: a `change` on a detached input never
        // reaches the mount's listener.
        case "orgLogoPick":
          if (u.busy || !admin()) return true;
          u.menu = false;
          host.rerender();
          mount.querySelector<HTMLInputElement>("[data-orglogo-file]")?.click();
          return true;
        case "orgLogoRemove": remove(); return true;
        default: u.menu = false; return false;
      }
    },
  };
}
