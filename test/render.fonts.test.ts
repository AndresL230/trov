/**
 * Trov's type and its diagram renderer come from Trov's own origin (docs/architecture/web-ui.md › Fonts):
 * no page, stylesheet or Worker-rendered page asks Google Fonts or a CDN for anything. Geist and Archivo
 * Narrow are vendored in web/src/fonts/ with their OFL licenses; trov.css declares them (Vite hashes them),
 * every built page preloads Geist latin, and a metric-matched fallback keeps the swap from moving prerendered
 * text. Mermaid is an exact-pinned dependency loaded by a dynamic import(), never a CDN URL.
 */
import { describe, it, expect } from "vitest";
import { SITE_PAGES } from "../shared/site-pages";
import { FONTS_PATH, FONT_FILES, FONT_LICENSES, LATIN_EXT_RANGE, LATIN_RANGE, stableFontFaceCss } from "../shared/fonts";
import { RESERVED_ORG_SLUGS } from "../shared/orgs";
import { FONT_PRELOAD, appShellHtml, sitePageHtml } from "../web/src/site-prerender";
import { shell } from "../src/auth/oauth-pages";
import css from "../web/src/trov.css?raw";
import oauthRoutesSrc from "../src/auth/oauth-routes.ts?raw";
import artifactsSrc from "../web/src/artifacts.ts?raw";
import geistLicense from "../web/src/fonts/Geist-OFL.txt?raw";
import archivoLicense from "../web/src/fonts/ArchivoNarrow-OFL.txt?raw";
import pkg from "../package.json";

const THIRD_PARTY = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/;
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
const fontFaces = [...stripped.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]);
const webSources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("fonts — self-hosted, preloaded, with a metric-matched fallback", () => {
  const documents: [string, string][] = [...SITE_PAGES.map((p): [string, string] => [p.path, sitePageHtml(p)]), ["app shell", appShellHtml()]];

  it("no built page links a third party: no Google Fonts stylesheet, no preconnect", () => {
    for (const [name, html] of documents) {
      expect(html, name).not.toMatch(THIRD_PARTY);
      expect(html, name).not.toContain('rel="preconnect"');
      expect(html, name).not.toMatch(/<link[^>]*rel="stylesheet"[^>]*https?:/);
    }
  });

  it("every page preloads Geist latin — and only it — as a CORS font, by the path Vite hashes", () => {
    expect(FONT_PRELOAD).toBe('<link rel="preload" href="/src/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin />');
    for (const [name, html] of documents) {
      const preloads = html.match(/<link rel="preload"[^>]*>/g) ?? [];
      expect(preloads, name).toEqual([FONT_PRELOAD]);
    }
  });

  it("trov.css declares each vendored file: family, the variable axis, swap, Google's unicode-range", () => {
    expect(css).not.toMatch(THIRD_PARTY);
    for (const f of FONT_FILES) {
      const face = fontFaces.find((b) => b.includes(`url("./fonts/${f.file}")`));
      expect(face, f.file).toBeDefined();
      expect(face).toContain(`font-family:'${f.family}'`);
      expect(face).toContain(`font-weight:${f.weight}`);
      expect(face).toContain("font-display:swap");
      expect(face).toContain(`unicode-range:${f.range}`);
    }
    expect(FONT_FILES.find((f) => f.file === "geist-latin.woff2")?.weight).toBe("100 900"); // 640 is a real weight
    expect(new Set(FONT_FILES.map((f) => f.range))).toEqual(new Set([LATIN_RANGE, LATIN_EXT_RANGE]));
  });

  it("'Geist Fallback' is the system Arial scaled to Geist's metrics, and follows 'Geist' in every stack", () => {
    const fallback = fontFaces.filter((b) => b.includes("font-family:'Geist Fallback'"));
    expect(fallback.length).toBeGreaterThan(0);
    for (const b of fallback) {
      expect(b).toMatch(/src:local\("Arial[^"]*"\)/);
      for (const d of ["size-adjust", "ascent-override", "descent-override", "line-gap-override"]) expect(b).toMatch(new RegExp(`${d}:[\\d.]+%`));
      expect(b).toMatch(/font-weight:\d+ \d+/);
    }
    const stacks = [stripped, ...Object.entries(webSources).filter(([f]) => !f.endsWith("/releases.ts")).map(([, s]) => s)]
      .flatMap((s) => [...s.matchAll(/(?:font-family:|--(?:sans|label):)\s*'Geist'([^;"`]*)/g)].map((m) => m[1]));
    expect(stacks.length).toBeGreaterThan(5);
    for (const rest of stacks) if (!rest.startsWith(";") && rest.trim()) expect(rest).toMatch(/^,'Geist Fallback',/);
  });

  it("the files and their licenses are vendored side by side", () => {
    const vendored = Object.keys(import.meta.glob("../web/src/fonts/*")).map((k) => k.replace("../web/src/fonts/", ""));
    for (const f of [...FONT_FILES.map((x) => x.file), ...FONT_LICENSES]) expect(vendored).toContain(f);
    expect(geistLicense).toContain("Copyright 2024 The Geist Project Authors");
    expect(archivoLicense).toContain("Copyright 2019 The Archivo Narrow Project Authors");
    for (const l of [geistLicense, archivoLicense]) expect(l).toContain("SIL Open Font License, Version 1.1");
  });

  it("the Worker's own pages (OAuth, billing notices) load the stable copies from Trov's origin only", () => {
    const html = shell("Sign in", "<p>x</p>");
    expect(html).not.toMatch(THIRD_PARTY);
    expect(html).not.toContain("<link");
    expect(html).toContain(stableFontFaceCss());
    for (const f of FONT_FILES) expect(html).toContain(`url("${FONTS_PATH}/${f.file}")`);
    const csp = /export const PAGE_CSP = "([^"]+)"/.exec(oauthRoutesSrc)?.[1] ?? "";
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    expect(RESERVED_ORG_SLUGS).toContain(FONTS_PATH.slice(1));
  });
});

describe("mermaid — pinned and self-hosted", () => {
  it("is an exact version in package.json, loaded by a dynamic import(), with no CDN URL left", () => {
    const deps = (pkg as { dependencies: Record<string, string> }).dependencies;
    expect(deps.mermaid).toMatch(/^\d+\.\d+\.\d+$/);
    expect(artifactsSrc).toContain('import("mermaid")');
    expect(artifactsSrc).not.toMatch(/^import[^;]*from "mermaid"/m); // never a static import: it would land in the main bundle
    for (const [file, src] of Object.entries(webSources)) if (!file.endsWith("/releases.ts")) expect(src, file).not.toMatch(THIRD_PARTY);
  });

  it("keeps its strict security level and Trov's theming", () => {
    expect(artifactsSrc).toMatch(/securityLevel: "strict"/);
    expect(artifactsSrc).toMatch(/startOnLoad: false/);
  });
});
