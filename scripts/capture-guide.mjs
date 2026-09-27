// Capture the Get Started guide screenshots against the real (cookie-gated) app over
// `wrangler dev`, with Playwright's Chromium at 2× device scale for crisp images.
// Verification/authoring-only; no app code depends on it. Companion to dev-shot.mjs —
// this one knows the guide's surface list and the framing each shot needs (a hash route,
// a sub-page to open, a query to type, a section to scroll to).
//
//   1. seed + run the app:   npm run seed && npm run dev   (DEV_LOGIN=AndresL230 in .dev.vars)
//   2. capture every figure:  node scripts/capture-guide.mjs  (first creates the sample
//      artifacts in fixtures/dev/artifacts.json when the local store has none)
//
// Writes web/public/guide/<name>-<theme>.png for each surface × theme (dark/light),
// so the guide can show the variant matching the viewer's active theme. Override the target
// dir with CANOPY_SHOT_DIR, the base URL with CANOPY_URL, or the theme list with
// CANOPY_THEMES (comma-separated). `node scripts/capture-guide.mjs docs search` captures
// only those figures.
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CANOPY_URL ?? "http://localhost:8787";
const OUT_DIR = process.env.CANOPY_SHOT_DIR ?? join(HERE, "..", "web", "public", "guide");
const THEMES = (process.env.CANOPY_THEMES ?? "dark,light").split(",").map((t) => t.trim()).filter(Boolean);

// Forge the dev session cookie the same way scripts/dev-cookie.mjs does, so the SPA's
// same-origin fetches are authed even if DEV_LOGIN weren't set.
async function forgeCookie() {
  const devVars = readFileSync(join(HERE, "..", ".dev.vars"), "utf8");
  const line = devVars.split("\n").find((l) => l.startsWith("COOKIE_SECRET="));
  if (!line) throw new Error("COOKIE_SECRET not found in .dev.vars");
  const secret = line.slice("COOKIE_SECRET=".length).trim().replace(/^["']|["']$/g, "");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("devsession"));
  const b64url = Buffer.from(sig).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `devsession.${b64url}`;
}

const click = (page, sel) => page.locator(sel).first().click();

// Each figure: a name, the hash route to open, an optional step once it has loaded, and
// how long to let async fetches + the entrance animation settle.
const SHOTS = [
  { name: "mywork", hash: "#mywork" },
  // The Board is the queue's default view; the Table is the other.
  { name: "tickets", hash: "#tickets",
    step: (p) => click(p, '[data-act=navSub][data-arg="tickets:queue"]') },
  { name: "board", hash: "#tickets",
    step: (p) => click(p, '[data-act=navSub][data-arg="tickets:board"]') },
  { name: "ticket", hash: "#tickets/3" },
  { name: "roadmap", hash: "#roadmap" },
  { name: "timeline", hash: "#roadmap/timeline" },
  { name: "sprint", hash: "#sprints/3" },
  // The local seed has no repo capture, so every section reads "not connected"; the
  // screen's own "Preview with sample data" fills it client-side (labelled on screen).
  { name: "repo", hash: "#repo", step: (p) => click(p, "[data-act=repoSampleOn]") },
  { name: "repo-usage", hash: "#repo/usage", step: (p) => click(p, "[data-act=repoSampleOn]") },
  { name: "handoffs", hash: "#handoffs" },
  { name: "feed", hash: "#feed" },
  // Docs opens on the Technical space and auto-selects the first doc (sapling-architecture)
  // with its heading outline expanded and the "proposal awaiting review" banner.
  { name: "docs", hash: "#docs", settle: 1900 },
  // Artifacts come from fixtures/dev/artifacts.json via prepareArtifacts() below.
  { name: "artifacts", hash: "#artifacts" },
  // The viewer's address strip shows the page's own origin; show production's instead.
  { name: "artifact", hash: "#artifacts/curriculum-planner-lesson-duration-field", settle: 1900,
    dress: (p) => p.evaluate(() => {
      const walk = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        n.nodeValue = n.nodeValue.replace(/(https?:\/\/)?localhost:\d+/g, "canopy.saplinglearn.com");
      }
    }) },
  { name: "prompts", hash: "#prompts" },
  // The sidebar box's "search everything" dropdown paints once typing PAUSES (1s).
  { name: "quicksearch", hash: "#mywork", settle: 2400,
    step: async (p) => { await p.locator("input.cnpy-search-in").first().click(); await p.keyboard.type("token", { delay: 60 }); } },
  { name: "search", hash: "#search",
    step: async (p) => { await p.locator("input[data-act=setSearch]").first().fill("gate"); } },
  { name: "review", hash: "#review" },
  { name: "maintenance", hash: "#maintenance" },
  { name: "settings", hash: "#settings" },
  { name: "releases", hash: "#releases" },
  // Mints a (local) token and opens the one-time setup modal. The figure shows the
  // production origin and no token value; `after` revokes the token so the next theme's
  // Settings figure is unchanged.
  { name: "connect", hash: "#settings",
    step: async (p) => {
      await click(p, "[data-act=connectOpen]");
      await p.waitForFunction(() => /canopy_mcp_[A-Za-z0-9_-]{12,}/.test(document.querySelector("[data-overlay=connect]")?.textContent ?? ""));
    },
    // Run just before the shot: a later rerender would put the real text back.
    dress: (p) => p.evaluate(() => {
      const walk = document.createTreeWalker(document.querySelector("[data-overlay=connect]"), NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        n.nodeValue = n.nodeValue
          .replace(/http:\/\/localhost:\d+/g, "https://canopy.saplinglearn.com")
          .replace(/canopy_mcp_[A-Za-z0-9_-]{12,}/g, "canopy_mcp_••••••••");
      }
    }),
    after: (p) => p.evaluate(async () => {
      const { tokens } = await (await fetch("/auth/mcp-tokens")).json();
      for (const t of tokens) await fetch(`/auth/mcp-tokens/${t.id}/revoke`, { method: "POST" });
    }) },
];

// `npm run seed` has no artifacts (their bodies are hashed and indexed by the repository),
// so create the sample set through the real API, once: skipped when any artifact exists.
async function prepareArtifacts(context) {
  const { artifacts: samples } = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "dev", "artifacts.json"), "utf8"));
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  const made = await page.evaluate(async (samples) => {
    const call = async (method, path, body) => {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    if ((await call("GET", "/api/artifacts")).artifacts.length) return 0;
    for (const a of samples) {
      const { slug } = await call("POST", "/api/artifacts", {
        title: a.title, area: a.area, kind: a.kind, content: a.content, summary: a.summary, links: a.links,
      });
      let version = 1;
      for (const v of a.versions ?? []) {
        await call("POST", `/api/artifacts/${slug}/versions`, { content: v.content, summary: v.summary });
        version++;
      }
      if (a.status) await call("PATCH", `/api/artifacts/${slug}`, { status: a.status });
      if (a.ratify) await call("POST", `/api/artifacts/${slug}/ratify`, { version });
    }
    return samples.length;
  }, samples);
  if (made) process.stdout.write(`created ${made} sample artifacts\n`);
  await page.close();
}

const only = process.argv.slice(2);
const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const cookie = await forgeCookie();
{
  const context = await browser.newContext();
  await context.addCookies([{ name: "session", value: cookie, url: BASE }]);
  await prepareArtifacts(context);
  await context.close();
}

for (const theme of THEMES) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await context.addCookies([{ name: "session", value: cookie, url: BASE }]);
  // The SPA reads its theme and sidebar state from localStorage on boot; pin them so every
  // figure shows the expanded rail in the requested theme.
  await context.addInitScript((t) => {
    localStorage.setItem("canopy.theme", t);
    localStorage.setItem("canopy.collapsed", "0");
    localStorage.removeItem("canopy.navOpen");
  }, theme);
  for (const shot of shots) {
    const page = await context.newPage();
    await page.goto(`${BASE}/${shot.hash}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    if (shot.step) {
      await shot.step(page);
      await page.waitForLoadState("networkidle");
    }
    await page.waitForTimeout(shot.settle ?? 1400);
    if (shot.dress) await shot.dress(page);
    const path = join(OUT_DIR, `${shot.name}-${theme}.png`);
    await page.screenshot({ path });
    process.stdout.write(`${path}\n`);
    if (shot.after) await shot.after(page);
    await page.close();
  }
  await context.close();
}

await browser.close();
