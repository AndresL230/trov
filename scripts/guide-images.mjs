// The Guide's screenshots as the app serves them (web-ui.md › The Guide's screenshots): each capture
// (2560×1600, Chromium at 2× of a 1280×800 window) becomes TWO WebP files in web/public/guide/ —
//   <name>-<theme>-1720.webp  the figure in the column (at most 860 CSS px wide, so 1720 px covers 2×)
//   <name>-<theme>.webp       the full capture, for a 3× screen and the lightbox
// No PNG is kept: every browser the app supports decodes WebP. Lossy at quality 82 / 85 with sharp's
// smart chroma subsampling (coloured text stays crisp) — about 70% / 50% smaller than the optimised PNG.
//
// scripts/capture-guide.mjs writes every capture through `writeGuideImages`. Run directly, this
// converts PNG captures taken some other way (scripts/dev-shot.mjs, a hand-made one) and removes them:
//   node scripts/guide-images.mjs [dir]   (default web/public/guide)
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The column size: `GUIDE_SHOT_W` in web/src/render.ts must say the same. */
export const GUIDE_COLUMN_W = 1720;

let sharpMod = null;
async function sharp() {
  if (sharpMod) return sharpMod;
  try { sharpMod = (await import("sharp")).default; } catch {
    throw new Error("sharp is missing: it ships with wrangler (miniflare's dependency), so run `npm install` first");
  }
  return sharpMod;
}

/** Write `<base>-1720.webp` and `<base>.webp` beside each other from one PNG capture; returns their paths. */
export async function writeGuideImages(dir, base, png) {
  const s = await sharp();
  const webp = (q) => ({ quality: q, smartSubsample: true, effort: 6 });
  const column = await s(png).resize({ width: GUIDE_COLUMN_W, withoutEnlargement: true }).webp(webp(82)).toBuffer();
  const full = await s(png).webp(webp(85)).toBuffer();
  const paths = [join(dir, `${base}-${GUIDE_COLUMN_W}.webp`), join(dir, `${base}.webp`)];
  writeFileSync(paths[0], column);
  writeFileSync(paths[1], full);
  return paths;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "web", "public", "guide");
  const pngs = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  let before = 0, after = 0;
  for (const f of pngs) {
    const png = readFileSync(join(dir, f));
    const paths = await writeGuideImages(dir, f.slice(0, -4), png);
    const sizes = paths.map((p) => readFileSync(p).length);
    before += png.length; after += sizes[0];
    rmSync(join(dir, f));
    process.stdout.write(`${f}  ${png.length} → ${sizes[0]} (${GUIDE_COLUMN_W}w) + ${sizes[1]} (full)\n`);
  }
  if (pngs.length) process.stdout.write(`${pngs.length} PNGs, ${before} bytes → ${after} bytes in the column (${Math.round((1 - after / before) * 100)}% less)\n`);
}
