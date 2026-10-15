// Trov's type, self-hosted (docs/architecture/web-ui.md › Fonts). Zod-free and value-only: the build
// (web/site-build.ts), the Worker's own pages (src/auth/oauth-pages.ts) and the tests read it.
//
// The files live in web/src/fonts/ beside their licenses: Geist and Archivo Narrow, both SIL Open Font
// License 1.1, as the variable woff2 subsets Google Fonts serves (Geist v5, Archivo Narrow v35). The SPA and
// the prerendered pages reach them through trov.css's `@font-face` (Vite hashes them into /assets/); the
// Worker renders a few pages itself and cannot know a hashed name, so the build ALSO writes each file, and
// each license, at a stable path under FONTS_PATH. Nothing ever loads type from a third party.

/** Where the build writes the stable copies (a reserved org slug: shared/orgs.ts). */
export const FONTS_PATH = "/fonts";

/** Google Fonts' `unicode-range` for each subset, so a page fetches latin-ext only when it draws one of
 *  its characters. trov.css declares the same ranges (test/render.fonts.test.ts holds them equal). */
export const LATIN_RANGE = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
export const LATIN_EXT_RANGE = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF";

export interface FontFile {
  family: "Geist" | "Archivo Narrow";
  file: string;
  /** The variable font's weight axis. */
  weight: string;
  range: string;
}

export const FONT_FILES: readonly FontFile[] = [
  { family: "Geist", file: "geist-latin.woff2", weight: "100 900", range: LATIN_RANGE },
  { family: "Geist", file: "geist-latin-ext.woff2", weight: "100 900", range: LATIN_EXT_RANGE },
  { family: "Archivo Narrow", file: "archivo-narrow-latin.woff2", weight: "400 700", range: LATIN_RANGE },
];

/** The license of each family, written beside the files wherever they are served. */
export const FONT_LICENSES: readonly string[] = ["Geist-OFL.txt", "ArchivoNarrow-OFL.txt"];

/** `@font-face` rules for a page the Worker renders: the stable copies, by absolute path (same origin, so
 *  its CSP needs only `font-src 'self'`). */
export function stableFontFaceCss(): string {
  return FONT_FILES.map((f) =>
    `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url("${FONTS_PATH}/${f.file}") format("woff2");unicode-range:${f.range}}`,
  ).join("");
}
