// An organization's tile: its logo, else its first letter on a square. Its own module so the sidebar's org switcher —
// and the site's hero, which draws the app's own sidebar — need not load Org settings.
import { esc, attr } from "./ui";
import { AVATAR_IMG_CLASS, avatarFailed } from "./people";

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
