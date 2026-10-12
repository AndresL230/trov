// Open Graph preview images for trov.dev's public pages: 1200 × 630 PNGs in web/public/og/<name>.png,
// served as https://trov.dev/og/<name>.png (the pages' og:image / twitter:image). Authoring-only; no app
// code runs this. The card is scripts/og/template.html (the site's brand banner); this fills it per page.
//
//   node scripts/og/render.mjs                 every page in PAGES
//   node scripts/og/render.mjs pricing terms   just the named ones
//
// Run from anywhere (paths are relative to this file). Needs the `playwright` devDependency with a Chromium
// (`npx playwright install chromium`, or point OG_CHROMIUM at a Chrome/Chromium binary) and network access to
// fonts.googleapis.com / fonts.gstatic.com for Geist, the site's face (SIL Open Font License 1.1): the run
// fails rather than render in a fallback font. Output dir: OG_OUT_DIR overrides web/public/og.
//
// ADDING A PAGE is one line in PAGES. The copy is the page's own words — its headline / lede as the page
// shows them — never a claim, number or quote the page itself does not make. Prices come from
// shared/pricing.ts + shared/plans.ts and the mark from shared/mark.ts, so those cannot drift; anything else
// copied here (the landing hero, a legal lede) must be re-rendered when the page's wording changes.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = process.env.OG_OUT_DIR ?? join(ROOT, "web", "public", "og");
const W = 1200, H = 630;
const SIZE_BUDGET = 150 * 1024; // a soft cap: some crawlers drop large previews

// The tabs over /terms and /privacy (web/src/legal.ts `legalView`), the page's own one filled.
const LEGAL_TABS = ["Terms of Service", "Privacy Policy"];

// One line per page. name → web/public/og/<name>.png. `path` is printed under the copy as trov.dev<path>.
//   eyebrow: a small label over the title · tabs: a tab row over it (the current one = `title`)
//   lede: one line under it · plans: true lists the offered plans and their prices (shared/)
const PAGES = [
  { name: "home", path: "", title: "Shared memory for your team and its coding agents.", lede: "Agents load what your team already decided, record what actually shipped, and wait for a person to approve anything that becomes official." },
  { name: "pricing", path: "/pricing", eyebrow: "Pricing", title: "One product, three sizes.", lede: "Every plan is all of Trov.", plans: true },
  { name: "terms", path: "/terms", tabs: LEGAL_TABS, title: "Terms of Service", lede: "These terms cover your use of Trov, the shared context store for teams and their coding agents." },
  { name: "privacy", path: "/privacy", tabs: LEGAL_TABS, title: "Privacy Policy", lede: "This policy explains what Trov collects, why, who processes it, how long it is kept and what you can ask for." },
  // The public docs (web/src/docs-content.ts): each page's title and its lede, its description in
  // shared/site-pages.ts, word for word. Re-render a card when its page's first lines change.
  { name: "docs-setup", path: "/docs/setup", eyebrow: "Docs", title: "Set up Trov", lede: "Sign in, create an organization, connect GitHub and connect your coding agent: everything from a new account to a first session." },
  { name: "docs-connect", path: "/docs/connect", eyebrow: "Docs", title: "Connect an MCP client", lede: "Trov is a remote MCP server at https://trov.dev/mcp. Setup to copy for Claude Code, Claude Desktop, Cursor, VS Code, Codex, Windsurf and any other client." },
  { name: "docs-concepts", path: "/docs/concepts", eyebrow: "Docs", title: "Concepts", lede: "Agents propose and people decide: how Trov keeps what agents read trustworthy, and what live, staged, unpromoted and draft mean." },
  { name: "docs-mcp-tools", path: "/docs/mcp-tools", eyebrow: "Docs", title: "MCP tools reference", lede: "Every tool Trov's MCP server gives an agent, generated from the server's own registrations: what each does, its arguments, and its errors." },
  { name: "docs-changelog", path: "/docs/changelog", eyebrow: "Docs", title: "Changelog", lede: "What changed in Trov, release by release, newest first." },
];

// ── shared/ as values: one definition of the mark and the prices ────────────────
async function loadShared() {
  const { outputFiles } = await build({
    stdin: {
      contents: `export { TROV_MARK_PATH } from "./shared/mark";
        export { PLANS, OFFERED_PLAN_IDS } from "./shared/plans";
        export { PRICING, canPurchase, formatPrice } from "./shared/pricing";`,
      resolveDir: ROOT, loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The offered plans as web/src/pricing.ts prices them (`priceSlot`, `accentPlan`): Free shows no price,
 *  a plan with none is "Custom pricing" (or "Pricing to be announced" if self-serve). */
function plansRow({ PLANS, OFFERED_PLAN_IDS, PRICING, canPurchase, formatPrice }) {
  const buyable = OFFERED_PLAN_IDS.filter((id) => canPurchase(PRICING[id]));
  const accent = buyable.find((id) => PRICING[id].badge) ?? buyable[buyable.length - 1] ?? null;
  const chips = OFFERED_PLAN_IDS.map((id) => {
    const p = PRICING[id];
    const price = p.price === 0 ? "" : p.price === null ? (p.selfServe ? "Pricing to be announced" : "Custom pricing") : `${formatPrice(p.price)} ${p.per}`;
    return `<div class="plan${id === accent ? " on" : ""}"><b>${esc(PLANS[id].name)}</b>${price ? `<span>${esc(price)}</span>` : ""}</div>`;
  });
  return `<div class="plans">${chips.join("")}</div>`;
}

function cardBody(page, shared) {
  const tabs = page.tabs
    ? `<div class="tabs">${page.tabs.map((t) => `<span class="tab${t === page.title ? " on" : ""}">${esc(t)}</span>`).join("")}</div>`
    : "";
  return [
    page.eyebrow ? `<div class="eyebrow">${esc(page.eyebrow)}</div>` : "",
    tabs,
    `<h1${page.title.length > 40 ? ` class="long"` : ""}>${esc(page.title)}</h1>`,
    page.lede ? `<p class="lede">${esc(page.lede)}</p>` : "",
    page.plans ? plansRow(shared) : "",
  ].join("");
}

// ── Chromium: Playwright's own, else OG_CHROMIUM, else one under PLAYWRIGHT_BROWSERS_PATH ──────────
async function launch() {
  try {
    return await chromium.launch(process.env.OG_CHROMIUM ? { executablePath: process.env.OG_CHROMIUM } : {});
  } catch (err) {
    const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const found = dir && existsSync(dir)
      ? readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
          .map((d) => join(dir, d, "chrome-linux", "chrome")).find((p) => existsSync(p))
      : null;
    if (!found) throw err;
    return chromium.launch({ executablePath: found });
  }
}

/** Width and height from a PNG's IHDR. */
function pngSize(buf) {
  if (buf.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const only = process.argv.slice(2);
const pages = only.length ? PAGES.filter((p) => only.includes(p.name)) : PAGES;
const unknown = only.filter((n) => !PAGES.some((p) => p.name === n));
if (unknown.length) throw new Error(`unknown page(s): ${unknown.join(", ")} — known: ${PAGES.map((p) => p.name).join(", ")}`);

const shared = await loadShared();
const template = readFileSync(join(HERE, "template.html"), "utf8");
mkdirSync(OUT_DIR, { recursive: true });

const browser = await launch();
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light" });
  const tab = await ctx.newPage();
  for (const page of pages) {
    const slots = { mark: shared.TROV_MARK_PATH, body: cardBody(page, shared), url: esc(`trov.dev${page.path}`) };
    const html = template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in slots)) throw new Error(`template.html: unknown slot {{${k}}}`);
      return slots[k];
    });
    await tab.setContent(html, { waitUntil: "load" });
    // Every face the card uses must be Geist, really loaded — never a silent fallback.
    const fontOk = await tab.evaluate(async () => {
      const faces = [...(await document.fonts.load("650 70px Geist", "Trov")), ...(await document.fonts.load("400 27px Geist", "Trov"))];
      await document.fonts.ready;
      return faces.length > 0 && faces.every((f) => f.status === "loaded");
    });
    if (!fontOk) throw new Error("Geist did not load from fonts.googleapis.com (offline, or blocked?) — refusing to render a fallback font");
    // Nothing may run past the card: the copy block must fit its space, every line inside the frame.
    const overflow = await tab.evaluate(({ W, H }) => {
      const main = document.querySelector(".main");
      if (main.scrollHeight > main.clientHeight + 1) return `copy is ${main.scrollHeight - main.clientHeight}px too tall`;
      for (const el of document.querySelectorAll(".brand, .main *, .url")) {
        const r = el.getBoundingClientRect();
        if (r.right > W - 40 || r.bottom > H - 30 || r.left < 40 || r.top < 30) return `"${el.textContent.slice(0, 40)}" reaches the edge`;
      }
      return null;
    }, { W, H });
    if (overflow) throw new Error(`${page.name}: ${overflow} — shorten the copy`);

    const out = join(OUT_DIR, `${page.name}.png`);
    const png = await tab.screenshot({ type: "png", animations: "disabled" });
    const [w, h] = pngSize(png);
    if (w !== W || h !== H) throw new Error(`${page.name}: rendered ${w}×${h}, expected ${W}×${H}`);
    writeFileSync(out, png);
    const kb = (statSync(out).size / 1024).toFixed(1);
    console.log(`${page.name.padEnd(10)} ${w}×${h}  ${kb} KB  ${out.slice(ROOT.length + 1)}${png.length > SIZE_BUDGET ? "  (over the 150 KB budget)" : ""}`);
  }
} finally {
  await browser.close();
}
