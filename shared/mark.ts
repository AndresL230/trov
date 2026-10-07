// The Trov mark (A1-2): three stepped blocks on a 100 × 100 grid. One definition for
// every place it is drawn — the SPA, the site and legal pages, the tab icon, the
// OAuth pages (Worker-rendered) and the emails (which rebuild it from table cells,
// because Gmail strips SVG). No imports, so `web/` can take it as a value.

/** The mark's outline, in a `0 0 100 100` viewBox. */
export const TROV_MARK_PATH =
  "M0 83.72H46.51V46.51H0ZM46.51 46.51H83.72V0H46.51ZM83.72 46.51V83.72H46.51V100H100V46.51Z";

/** The mark's colour: the brand purple on a light ground, the dark theme's green accent on a dark one. */
export const TROV_MARK_COLORS = { light: "#616ACB", dark: "#9aab65" } as const;

/** The mark as inline SVG. `fill` defaults to the page's `--mark` token (falling back to the light purple). */
export function trovMark(size: number, fill = `var(--mark,${TROV_MARK_COLORS.light})`): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" style="flex:none"><path fill="${fill}" d="${TROV_MARK_PATH}"></path></svg>`;
}

/**
 * The same mark as a 3 × 3 grid, for renderers that have no SVG: column widths and
 * row heights as fractions of the side, and which cells are filled.
 */
export const TROV_MARK_GRID = {
  tracks: [0.4651, 0.3721, 0.1628],
  filled: [
    [false, true, false],
    [true, false, true],
    [false, true, true],
  ],
} as const;
