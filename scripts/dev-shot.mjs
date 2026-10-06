// Screenshot the real (cookie-gated) app over `wrangler dev`, injecting the forged
// session cookie via the Chrome DevTools Protocol so the SPA's same-origin fetches are
// authed. Verification-only; no app code depends on it.
//
//   TROV_COOKIE=$(node scripts/dev-cookie.mjs | sed 's/^session=//') \
//   TROV_SHOT_DIR=/path node scripts/dev-shot.mjs <outName> ['<jsToEvalBeforeShot>']
//
// e.g. ... node scripts/dev-shot.mjs roadmap 'document.querySelector("[data-act=goRoadmap]").click()'
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN ?? "/home/andresl/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
const PORT = Number(process.env.CDP_PORT ?? 9333);
const BASE = process.env.TROV_URL ?? "http://localhost:8787";
const OUT = process.argv[2] ?? "shot";
const EVAL_JS = process.argv[3] ?? null;
const COOKIE = process.env.TROV_COOKIE; // "<id>.<sig>" (cookie VALUE only)
const DIR = process.env.TROV_SHOT_DIR ?? process.cwd();
if (!COOKIE) throw new Error("TROV_COOKIE env (cookie value) required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "trov-cdp-"))}`,
  "--window-size=1200,760", "about:blank",
], { stdio: "ignore" });

async function targetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("CDP page target not found");
}

const ws = new WebSocket(await targetWs());
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await cmd("Page.enable");
const host = new URL(BASE).hostname;
await cmd("Network.setCookie", { name: "session", value: COOKIE, domain: host, path: "/" });
await cmd("Page.navigate", { url: BASE });
await sleep(2500); // SPA boot + async data fetches
if (EVAL_JS) { await cmd("Runtime.evaluate", { expression: EVAL_JS }); await sleep(1500); }
const shot = await cmd("Page.captureScreenshot", { format: "png" });
const path = join(DIR, `${OUT}.png`);
writeFileSync(path, Buffer.from(shot.result.data, "base64"));
process.stdout.write(`${path}\n`);
chrome.kill();
process.exit(0);
