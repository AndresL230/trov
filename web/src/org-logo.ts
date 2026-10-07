// The organization's image (shared/orgs.ts › the org's image) — two views:
//   THE TILE     — `orgTile`: the square beside an org's name everywhere it is shown (the sidebar
//                  switcher and its menu, the org picker, invitations, Platform). The image when
//                  the org has one, laid OVER its initial — so an image that fails to load leaves
//                  the initial, and stays out across rerenders (people.ts `markAvatarFailed`, the
//                  ONE capture-phase `error` listener in main.ts).
//   THE CONTROL  — `orgLogoSection`: Org settings › General. For an admin the tile IS the control,
//                  exactly as Settings › Profile's photo is (render.ts `profileSection`): a veil
//                  with a camera on hover / focus, a small menu — Upload image (Change image over an
//                  uploaded one), Remove image only over an UPLOADED one, the accepted types — over
//                  a hidden file input; the pick is centre-cropped to a square and re-encoded in
//                  the browser (avatar.ts) before it is sent. Everyone sees the image and where it
//                  came from. Its classes are the photo control's (`cnpy-avbtn…`, `cnpy-avmenu`).
// Purely presentational: props in, markup out. The acts (`orgLogo…`) are run by org-logo-actions.ts.

import { esc, attr, relTime } from "./ui";
import { O_LABEL, O_ERR } from "./org-ui";
import { AVATAR_IMG_CLASS, avatarFailed } from "./people";
import { ORG_LOGO_MAX_BYTES, ORG_LOGO_TYPES, type OrgLogo } from "@shared/orgs";

/** An org's square mark: its image when it has one, else the first letter of its name. Decorative —
 *  the name is always beside it — so it is hidden from assistive tech and the image has no alt text. */
export function orgTile(name: string, size = 24, logoUrl: string | null = null, radius = 7): string {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const url = logoUrl && !avatarFailed(logoUrl) ? logoUrl : null;
  // The image carries the page's own background, so a logo with transparency never shows the letter through it.
  const img = url
    ? `<img class="${AVATAR_IMG_CLASS}" src="${attr(url)}" width="${size}" height="${size}" alt="" decoding="async" style="position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;background:var(--bg)" />`
    : "";
  return `<span class="cnpy-orgtile" aria-hidden="true"${url ? ' data-logo="1"' : ""} style="position:relative;overflow:hidden;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px;border-radius:${radius}px">${esc(letter)}${img}</span>`;
}

// ── Org settings › General ───────────────────────────────────────────────────

export interface OrgLogoUi {
  /** The menu the tile opens (upload / change / remove). */
  menu: boolean;
  /** A write in flight: the veil shows a spinner and the menu won't open. */
  busy: "upload" | "remove" | null;
  /** The last refusal, as a sentence (a wrong type, too large, the daily limit). */
  error: string | null;
}
export const initialOrgLogoUi = (): OrgLogoUi => ({ menu: false, busy: null, error: null });

const NO_LOGO: OrgLogo = { url: null, source: null, by: null, from: null, at: null };
const MAX_MB = Math.round(ORG_LOGO_MAX_BYTES / (1024 * 1024));
/** The accepted types and size, as the menu's footnote says them. */
export const ORG_LOGO_ACCEPTS = `Square crop · PNG, JPEG, WebP, GIF · up to ${MAX_MB} MB`;
/** The rule an admin needs to know before uploading — said once, on every state. */
export const ORG_LOGO_RULE = "An uploaded image is never replaced by GitHub's.";

/** Where the image on screen came from, in words. `repo` is the org's primary repository
 *  (`owner/repo`) when the page knows it. */
export function orgLogoSource(logo: OrgLogo, repo: string | null): string {
  const when = logo.at ? ` ${esc(relTime(logo.at))}` : "";
  if (logo.url && logo.source === "upload") return `Uploaded${logo.by ? ` by <strong style="font-weight:600;color:var(--fg)">@${esc(logo.by)}</strong>` : ""}${when}.`;
  if (logo.url && logo.source === "github") {
    const owner = logo.from ? `<strong style="font-weight:600;color:var(--fg)">${esc(logo.from)}</strong>` : "the repository owner";
    const of = repo && logo.from && repo.toLowerCase().startsWith(`${logo.from.toLowerCase()}/`) ? `, the owner of <code style="font-family:var(--code);font-size:12px">${esc(repo)}</code>` : "";
    return `Imported from GitHub${when}: the avatar of ${owner}${of}.`;
  }
  return "No image yet. The first letter of the name stands in for it.";
}

export interface OrgLogoProps {
  /** The org's name (the tile's initial, the control's label). */
  name: string;
  logo: OrgLogo | null | undefined;
  /** Admin or owner: the tile is the control. Anyone else sees the image and its source. */
  canEdit: boolean;
  ui: OrgLogoUi;
  repo: string | null;
}

const CAMERA = (size: number, stroke: number) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path><circle cx="12" cy="13" r="3"></circle></svg>`;
const SPINNER = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="animation:cnpy-spin .8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>`;
const UPLOAD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m17 8-5-5-5 5"></path><path d="M12 3v12"></path></svg>`;
const TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg>`;
/** The General tile: 64px, like the profile photo; its corner is the tile's own, scaled. */
const SIDE = 64;
const RADIUS = 14;

/** Org settings › General's first block: the image, where it came from and — for an admin — the
 *  control to change it. Ends with the rule under the surface's own divider. */
export function orgLogoSection(p: OrgLogoProps): string {
  const logo = p.logo ?? NO_LOGO;
  const busy = p.canEdit ? p.ui.busy : null;
  const uploaded = !!logo.url && logo.source === "upload";
  const open = p.canEdit && p.ui.menu && !busy;
  const tile = orgTile(p.name, SIDE, logo.url, RADIUS);
  const row = "display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap";
  const menu = open ? `<div data-act="orgLogoMenuClose" style="position:fixed;inset:0;z-index:29"></div>
      <div role="menu" aria-label="Organization image" data-avatar-menu data-orglogo-menu class="cnpy-avmenu" style="position:absolute;top:calc(100% + 6px);left:0;z-index:30;width:268px;max-width:calc(100vw - 56px);background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;padding:5px;box-shadow:0 14px 38px rgba(0,0,0,.38)">
        <button type="button" role="menuitem" data-act="orgLogoPick" class="cnpy-menurow" style="${row};color:var(--fg-70)">${UPLOAD}${uploaded ? "Change image" : "Upload image"}</button>
        ${uploaded ? `<button type="button" role="menuitem" data-act="orgLogoRemove" class="cnpy-menurow" style="${row};color:var(--red)">${TRASH}Remove image</button>` : ""}
        <div style="height:1px;background:var(--border);margin:5px 4px"></div>
        <div style="padding:4px 10px 5px;font-size:11px;line-height:1.45;color:var(--fg-40)">${ORG_LOGO_ACCEPTS}</div>
      </div>` : "";
  const label = busy === "upload" ? "Uploading image…" : busy === "remove" ? "Removing image…" : "Organization image options";
  const control = p.canEdit
    ? `<div style="position:relative;flex:none">
        <input type="file" data-orglogo-file accept="${attr(ORG_LOGO_TYPES.join(","))}" hidden tabindex="-1" aria-hidden="true" />
        <button type="button" data-act="orgLogoMenu" data-field="orgLogoMenu" class="cnpy-avbtn${busy ? " is-busy" : ""}" aria-label="${label}" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}"${busy ? ' aria-disabled="true" aria-busy="true"' : ""} style="position:relative;display:block;padding:0;border-radius:${RADIUS}px;overflow:hidden">
          ${tile}
          <span class="cnpy-avbtn-veil" aria-hidden="true">${busy ? SPINNER : CAMERA(20, 1.9)}</span>
        </button>
        <span class="cnpy-avbtn-badge" aria-hidden="true" style="border-radius:50%">${CAMERA(11, 2.2)}</span>
        ${menu}
      </div>`
    : `<div style="flex:none" role="img" aria-label="${attr(logo.url ? `Image of ${p.name}` : `${p.name} has no image`)}">${tile}</div>`;
  const hint = !p.canEdit ? ""
    : logo.url && logo.source === "upload" ? ` ${ORG_LOGO_RULE}`
    : logo.url ? ` Upload an image to replace it. ${ORG_LOGO_RULE}`
    : ` Upload one, or connect a repository and Trov imports its owner's GitHub avatar. ${ORG_LOGO_RULE}`;
  return `<div data-org-logo style="display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--border)">
      ${control}
      <div style="flex:1;min-width:0">
        <div style="${O_LABEL}">Image</div>
        <div data-org-logo-source style="font-size:12.5px;line-height:1.55;color:var(--fg-55);margin-top:7px;overflow-wrap:anywhere">${orgLogoSource(logo, p.repo)}${hint}</div>
        ${p.canEdit && p.ui.error ? `<div role="alert" style="${O_ERR}">${esc(p.ui.error)}</div>` : ""}
      </div>
    </div>`;
}
