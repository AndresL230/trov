// A Library space's tile and icon (the sidebar's space rows, Library home, a space's home, the space dialogs). Its own
// module so the sidebar — and the site's hero, which draws the app's own sidebar — need not load the Library screens.
import { NEW_SPACE_ICON, SPACE_COLORS, isSpaceColor, isSpaceIcon, type SpaceIcon } from "@shared/docs-core";

/** The icons' line paths (24×24, stroked) — the design's `IC` set, one entry per `SPACE_ICONS` choice. */
export const SPACE_ICON_PATHS: Record<SpaceIcon, readonly string[]> = {
  braces: ["M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1", "M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"],
  compass: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M15.5 8.5l-2 5-5 2 2-5z"],
  pen: ["M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z", "M14 7l3 3"],
  shield: ["M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"],
  flask: ["M9 3h6", "M10 3v6l-5.5 9.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3", "M7.5 15h9"],
  rocket: ["M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2", "M9 15l-3-3c1-4 4.5-8.5 12-9-.5 7.5-5 11-9 12z", "M14.5 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z"],
  book: ["M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z", "M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  chart: ["M4 20V11", "M10 20V5", "M16 20v-6", "M21 20H3"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01"],
  megaphone: ["M3 10v4h3l6 4V6L6 10z", "M16 9a3.5 3.5 0 0 1 0 6", "M19 6a8 8 0 0 1 0 12"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
};
const PAGE_PATHS = ["M6 3h7l5 5v13H6z", "M13 3v5h5"];
export const lineIcon = (paths: readonly string[], size: number, stroke: number, color = "currentColor"): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"></path>`).join("")}</svg>`;
/** A page's icon (the design's `page`). */
export const pageIcon = (size = 14): string => lineIcon(PAGE_PATHS, size, 1.8);
/** A space's icon alone, in `color` (the icon picker draws it in the text colour). */
export const spaceIconSvg = (icon: string, size: number, color = "currentColor", stroke?: number): string =>
  lineIcon(SPACE_ICON_PATHS[isSpaceIcon(icon) ? icon : NEW_SPACE_ICON], size, stroke ?? (size < 12 ? 2.3 : 1.9), color);

/**
 * A space's tile: a square in the space's colour holding its white line icon (62% of the tile; a heavier stroke
 * under 20px). Its corner is `min(4.8px, size × .25)`, passed as `--spt-r` and scaled in trov.css's corners block
 * (`.cnpy-spt`) like every other radius. A colour that is not one of the choices draws the first one.
 */
export function spaceTile(sp: { icon: string; color: string }, size: number): string {
  const color = isSpaceColor(sp.color) ? sp.color.toLowerCase() : SPACE_COLORS[0];
  const r = Math.min(4.8, size * 0.25);
  return `<span class="cnpy-spt" style="--spt-r:${+r.toFixed(2)}px;width:${size}px;height:${size}px;background:${color}" aria-hidden="true">${spaceIconSvg(sp.icon, Math.round(size * 0.62), "#fff", size < 20 ? 2.3 : 1.9)}</span>`;
}
