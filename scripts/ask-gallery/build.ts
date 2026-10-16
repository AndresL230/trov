// The Ask Trov gallery: ONE self-contained HTML page with every surface Ask Trov can put on screen, in every state,
// drawn by the app's own renderers from the app's own fixtures — for reviewing how it all looks (published as a
// claude.ai Artifact: no <html>/<head>/<body>, everything inline, no network).
//
//   npm run ask:gallery [-- <out.html>]      (default .ask-gallery/ask-gallery.html, gitignored)
//
// How: specimens.ts (the states and the renders) is bundled for the browser with the app's `@shared` alias and run in
// headless Chromium (Playwright — the renderers are the SPA's, and the doc reader's markdown needs a DOM); it returns
// the sections as HTML strings. This file lays them out with the app's real CSS (web/src/trov.css, its Geist fonts
// inlined as data URIs), the gallery's chrome (gallery.css), the app's thinking-orb loop (orb.ts) and the page's
// small runtime (runtime.ts: the viewer's theme, frames, inert specimens). Never part of the suite.
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Section, Spec } from "./specimens";

const ROOT = resolve(".");
const HERE = join(ROOT, "scripts", "ask-gallery");
const out = resolve(process.argv[2] ?? join(ROOT, ".ask-gallery", "ask-gallery.html"));

async function bundle(entry: string, minify: boolean): Promise<string> {
  const r = await build({
    entryPoints: [join(HERE, entry)], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
    alias: { "@shared": join(ROOT, "shared") }, minify, legalComments: "none", logLevel: "error",
    loader: { ".css": "text", ".svg": "text" },
  });
  return r.outputFiles[0].text;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const scriptSafe = (js: string): string => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

/** web/src/trov.css with its fonts as data URIs (the app's fallback stacks untouched). */
function appCss(): string {
  const css = readFileSync(join(ROOT, "web", "src", "trov.css"), "utf8");
  return css.replace(/url\("\.\/fonts\/([\w.-]+\.woff2)"\)/g, (_m, f: string) =>
    `url("data:font/woff2;base64,${readFileSync(join(ROOT, "web", "src", "fonts", f)).toString("base64")}")`);
}

function specHtml(s: Spec): string {
  const cap = `<p class="gx-cap"><b>${esc(s.title)}</b> — ${esc(s.state)}</p>`;
  let view: string;
  if (s.kind === "inline") {
    const style = [s.w ? `width:${s.w}px` : "", s.h ? `height:${s.h}px` : "", s.minW ? `min-width:${s.minW}px` : ""].filter(Boolean).join(";");
    const cls = `gx-stage${s.w ? "" : " is-col"}${s.stage ? ` ${s.stage}` : ""}`;
    view = `<div class="gx-scroll"><div class="${cls}" data-cnpy-theme="light"${style ? ` style="${style}"` : ""}>${s.html}</div></div>`;
  } else {
    const w = s.kind === "phone" ? 390 : 1440;
    const h = s.h ?? (s.kind === "phone" ? 844 : 900);
    view = `<template class="gx-src">${s.html}</template><div class="gx-scroll"><div class="gx-frame" data-w="${w}" data-h="${h}"${s.kind === "phone" ? ` data-fixed="1"` : ""} style="--w:${w};--h:${h}"></div></div>`;
  }
  return `<article class="gx-spec" id="${esc(s.id)}" data-kind="${s.kind}">${cap}${view}</article>`;
}

function page(sections: Section[], css: string, gallery: string, orb: string, runtime: string): string {
  const n = sections.reduce((k, s) => k + s.specs.length, 0);
  const body = sections.map((s) => `<section class="gx-sec" id="s-${esc(s.id)}"><h2>${esc(s.title)}</h2><div class="gx-specs">${s.specs.map(specHtml).join("")}</div></section>`).join("");
  const built = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `<title>Ask Trov Gallery</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style id="gx-app-css">${css}</style>
<style>${gallery}</style>
<div class="gx-wrap">
<header class="gx-top"><h1>Ask Trov Gallery</h1><p>Everything Ask Trov's chat can put on screen, in every state, in the order it appears in a conversation (${n} in all). Each is the app's own rendering of sample data (an org called Acme); buttons do nothing here.</p></header>
<main>${body}</main>
<p class="gx-foot">Built ${esc(built)} UTC by <code>npm run ask:gallery</code> (scripts/ask-gallery/).</p>
</div>
<script id="gx-orb-src">${scriptSafe(orb)}</script>
<script>${scriptSafe(runtime)}</script>
`;
}

async function main(): Promise<void> {
  const [specimens, orb, runtime] = await Promise.all([bundle("specimens.ts", false), bundle("orb.ts", true), bundle("runtime.ts", true)]);
  const css = appCss();
  const browser = await chromium.launch();
  const errors: string[] = [];
  let sections: Section[];
  try {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await p.setContent(`<!doctype html><meta charset="utf-8"><body></body>`);
    // The app's CSS, so what a specimen measures (an open dropdown against its trigger) is laid out as in the app.
    await p.addStyleTag({ content: css });
    await p.evaluate(() => document.fonts.ready.then(() => undefined));
    await p.addScriptTag({ content: specimens });
    sections = await p.evaluate(() => (window as unknown as { __askGallery: () => Section[] }).__askGallery());
  } finally {
    await browser.close();
  }
  if (errors.length) console.warn(`ask-gallery: the renderers logged:\n  ${errors.join("\n  ")}`);
  const html = page(sections, css, readFileSync(join(HERE, "gallery.css"), "utf8"), orb, runtime);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const n = sections.reduce((k, s) => k + s.specs.length, 0);
  console.log(`ask-gallery: ${sections.length} sections, ${n} specimens → ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
