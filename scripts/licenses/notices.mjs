// THIRD-PARTY-NOTICES.txt: the third-party software and fonts Trov SHIPS — what ends up in the browser
// bundle (web/dist, built by Vite) and in the Worker (bundled by wrangler/esbuild) — with each one's licence
// text. Authoring-only, like scripts/og/render.mjs; run it after a dependency change and commit the result:
//
//   node scripts/licenses/notices.mjs
//
// It builds both bundles (nothing is written to web/dist or deployed: Vite with `write: false`, wrangler with
// `--dry-run`), reads which node_modules files each OUTPUT actually contains (tree-shaken), groups them by
// package, and prints each package's name, version, declared licence and licence file. The fonts (SIL OFL
// 1.1) come from web/src/fonts. Build-time tools that put no code in either bundle (Vite, TypeScript,
// vitest, esbuild itself) are not listed: nothing of theirs is distributed. The build copies the file beside
// the pages as /third-party-notices.txt (web/site-build.ts; shared/legal-core.ts `NOTICES_PATH`).
// test/legal.notices.test.ts checks the file names the packages it must.
import { build } from "vite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.txt");

/** "…/node_modules/@scope/name/dist/x.js" → the package's directory (the LAST node_modules segment). */
function packageDir(file) {
  const norm = file.split(sep).join("/");
  const i = norm.lastIndexOf("/node_modules/");
  if (i < 0) return null;
  const rest = norm.slice(i + "/node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const base = norm.slice(0, i + "/node_modules/".length) + name;
  return base.startsWith("/") || /^[A-Za-z]:/.test(base) ? base : join(ROOT, base);
}

// ── the browser bundle: every module Rollup put into an output chunk ──────────
async function browserPackages() {
  const dirs = new Set();
  await build({
    configFile: join(ROOT, "web", "vite.config.ts"),
    logLevel: "error",
    build: { write: false, emptyOutDir: false },
    plugins: [{
      name: "trov:notices",
      generateBundle(_opts, bundle) {
        for (const out of Object.values(bundle)) {
          if (out.type !== "chunk") continue;
          for (const [id, info] of Object.entries(out.modules)) {
            if (info.renderedLength === 0) continue; // tree-shaken away
            const dir = packageDir(id.replace(/^\0/, "").replace(/\?.*$/, ""));
            if (dir) dirs.add(dir);
          }
        }
      },
    }],
  });
  return dirs;
}

// ── the Worker: esbuild's metafile, the inputs of the output it wrote ─────────
function workerPackages() {
  const tmp = mkdtempSync(join(tmpdir(), "trov-notices-"));
  try {
    const meta = join(tmp, "meta.json");
    execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(tmp, "out"), "--metafile", meta], { cwd: ROOT, stdio: "ignore" });
    const m = JSON.parse(readFileSync(meta, "utf8"));
    const dirs = new Set();
    for (const out of Object.values(m.outputs)) {
      for (const [file, info] of Object.entries(out.inputs ?? {})) {
        if (!info.bytesInOutput) continue;
        const dir = packageDir(file);
        if (dir) dirs.add(dir);
      }
    }
    return dirs;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-_.][\w.-]+)?$/i;
/** A package that declares no licence in its package.json: read it off its licence file. */
const fromText = (text) => (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(text) ? "MIT"
  : /\bISC License\b/i.test(text) ? "ISC" : /Apache License/i.test(text) ? "Apache-2.0" : /\bBSD\b/.test(text) ? "BSD" : "UNKNOWN");
function describe(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licence = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN");
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  const texts = files.map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), "utf8").trim()}`);
  const declared = licence === "UNKNOWN" && texts.length ? fromText(texts.join("\n")) : licence;
  return { name: pkg.name, version: pkg.version, licence: declared, repo: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? "", texts };
}

const browser = await browserPackages();
const worker = workerPackages();
const all = new Map();
for (const [where, dirs] of [["browser", browser], ["worker", worker]]) {
  for (const dir of dirs) {
    if (!existsSync(join(dir, "package.json"))) continue;
    const d = describe(dir);
    if (d.name === "trov") continue;
    const key = `${d.name}@${d.version}`;
    const had = all.get(key);
    if (had) had.where.add(where);
    else all.set(key, { ...d, where: new Set([where]) });
  }
}
const packages = [...all.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const FONTS_DIR = join(ROOT, "web", "src", "fonts");
const fontLicences = readdirSync(FONTS_DIR).filter((f) => f.endsWith("-OFL.txt")).sort();

const rule = "=".repeat(78);
const lines = [
  "THIRD-PARTY NOTICES — Trov",
  "",
  "Trov (https://trov.dev) is free software under the GNU Affero General Public License v3.0 (LICENSE; the",
  "source of the running version: https://trov.dev/source). It includes the third-party software and fonts",
  "below, each under its own licence. \"browser\" means it is in the web app's bundle (served from trov.dev);",
  "\"worker\" means it is in the Cloudflare Worker. Generated by scripts/licenses/notices.mjs — do not edit.",
  "",
  "Summary",
  "-------",
  ...packages.map((p) => `${p.name}@${p.version}  —  ${p.licence}  (${[...p.where].sort().join(", ")})`),
  ...fontLicences.map((f) => `${f.replace(/-OFL\.txt$/, "")} (font)  —  OFL-1.1  (browser; also served at /fonts/)`),
  "",
  "Lucide icons (several of Trov's inline SVG icons are Lucide's paths, or adapted from them)  —  ISC, with",
  "  portions from Feather (MIT)  (browser)",
  "",
  "The GitHub mark and the Google \"G\" are those companies' trademarks, used only to label their sign-in",
  "buttons. The screenshots under /guide and Trov's own mark are Trov's.",
  "",
];
// Lucide is not an npm dependency: its icon paths are copied into the templates (sidebar.ts and others), so
// its licence is written out here by hand. https://github.com/lucide-icons/lucide/blob/main/LICENSE
const LUCIDE = `ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

--- Feather (the portions above) ---
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
/** A dual-licensed package: the licence Trov takes it under (AGPL-3.0-compatible). */
const ELECTED = { dompurify: "Apache-2.0", wrangler: "MIT", "@cloudflare/unenv-preset": "MIT" };
for (const p of packages) {
  lines.push(rule, `${p.name}@${p.version}`, `Licence: ${p.licence}${ELECTED[p.name] ? ` — used under ${ELECTED[p.name]}` : ""}${p.repo ? `\nSource: ${String(p.repo).replace(/^git\+/, "")}` : ""}`, `Included in: ${[...p.where].sort().join(", ")}`, "");
  if (p.texts.length) lines.push(...p.texts, "");
  else lines.push(`(The package ships no licence file; it declares the ${p.licence} licence in its package.json. The licence's standard text: ${p.licence.replace(/[()]/g, "").split(/\s+OR\s+/).map((id) => `https://spdx.org/licenses/${id}.html`).join(" or ")}.)`, "");
}
lines.push(rule, "Lucide icons — inline SVG paths", "Licence: ISC (portions MIT, from Feather)", "Source: https://lucide.dev", "Included in: browser", "", LUCIDE, "");
for (const f of fontLicences) {
  lines.push(rule, `${f.replace(/-OFL\.txt$/, "")} — font`, "Licence: SIL Open Font License 1.1", "Included in: browser (web/src/fonts, and /fonts/ on trov.dev)", "", readFileSync(join(FONTS_DIR, f), "utf8").trim(), "");
}
writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`${packages.length} packages, ${fontLicences.length} font licences → ${OUT.slice(ROOT.length + 1)}`);
