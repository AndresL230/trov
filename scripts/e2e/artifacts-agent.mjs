#!/usr/bin/env node
// End-to-end check of agent access to artifacts (issue #52 · Track F) against a LIVE
// Trov Worker — normally a local `wrangler dev`. It does what an agent (and the
// `artifacts` skill) does, over the real wire:
//
//   MCP over streamable HTTP at <base>/mcp with a bearer: initialize → tools/list →
//   tools/call upload_asset (markdown, html, and a binary PNG) → PUT the PNG's bytes to
//   its upload_url → artifact_list shows all three → artifact_get → download_url →
//   download each, check sha256 + size + byte equality against what was sent → save the
//   html where the skill would (.trov/artifacts/<slug>/v<n>.html, under a temp dir),
//   serve it with `python3 -m http.server` on a free port and fetch it back → a tampered
//   download token is a 404.
//
//   usage:  TROV_MCP_TOKEN=trov_mcp_… node scripts/e2e/artifacts-agent.mjs [baseUrl]
//           (baseUrl default http://127.0.0.1:8811)
//
// SAFETY: it writes artifacts as the token's person. Every upload/download URL the server
// hands back must be on the SAME origin as baseUrl, or the script stops before using it —
// so a Worker whose PUBLIC_ORIGIN points elsewhere (wrangler.toml's is production) can
// never make this script touch another deployment. Run `wrangler dev` with
// `--var PUBLIC_ORIGIN:<baseUrl>`. Exits non-zero on the first failure.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8811").replace(/\/+$/, "");
const TOKEN = process.env.TROV_MCP_TOKEN ?? "";
const ORIGIN = new URL(BASE).origin;
const RUN = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

const report = [];
const ok = (msg) => { report.push(`  ok   ${msg}`); console.log(`  ok   ${msg}`); };
class E2EFail extends Error {}
const fail = (msg) => { throw new E2EFail(msg); };
const check = (cond, msg) => { if (!cond) fail(msg); };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sameOrigin = (url, what) => {
  check(new URL(url).origin === ORIGIN, `${what} is on ${new URL(url).origin}, not ${ORIGIN} — refusing to use it (set --var PUBLIC_ORIGIN:${BASE})`);
  return url;
};

// ── MCP over streamable HTTP (stateless JSON-RPC) ─────────────────────────────

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  check(res.ok, `${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  // The SDK answers either plain JSON or one SSE event carrying it.
  const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  const msg = JSON.parse(payload);
  check(!msg.error, `${method}: JSON-RPC error ${JSON.stringify(msg.error)}`);
  return msg.result;
}

async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const body = JSON.parse(r.content?.[0]?.text ?? "null");
  check(!r.isError, `${name} failed: ${JSON.stringify(body)}`);
  return body;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A real, decodable 16×16 RGBA PNG (a gradient), built from scratch. */
function makePng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const W = 16, H = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < H; y++) {
    rows.push(0); // filter: none
    for (let x = 0; x < W; x++) rows.push(x * 16, y * 16, 128, 255);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const MARKDOWN = `# E2E notes ${RUN}\n\nWritten by scripts/e2e/artifacts-agent.mjs — ünïcode ✓, emoji 🌿.\n`;
const HTML = `<!doctype html>\n<html><head><meta charset="utf-8"><title>E2E ${RUN}</title></head>\n<body><h1>Spin me up ${RUN}</h1><p>ünïcode ✓</p></body></html>\n`;
const PNG = makePng();

// ── helpers ──────────────────────────────────────────────────────────────────

async function download(get, expected, label) {
  check(typeof get.download_url === "string", `${label}: artifact_get has no download_url`);
  sameOrigin(get.download_url, `${label} download_url`);
  const res = await fetch(get.download_url); // no header: the signed URL is the credential
  check(res.status === 200, `${label}: download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  check(buf.length === get.size_bytes, `${label}: ${buf.length} bytes, artifact_get says ${get.size_bytes}`);
  check(sha256(buf) === get.sha256, `${label}: sha256 ${sha256(buf)} ≠ artifact_get's ${get.sha256}`);
  check(buf.equals(expected), `${label}: bytes differ from what was sent`);
  const cd = res.headers.get("content-disposition") ?? "";
  check(cd.startsWith("attachment;"), `${label}: not an attachment (${cd})`);
  check(res.headers.get("x-content-type-options") === "nosniff", `${label}: no nosniff`);
  check((res.headers.get("content-security-policy") ?? "").includes("sandbox"), `${label}: no sandbox CSP`);
  ok(`${label}: downloaded ${buf.length} B, sha256 ${get.sha256.slice(0, 12)}… verified, byte-equal (${res.headers.get("content-type")})`);
  return buf;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function serveAndFetch(dir, file) {
  const port = await freePort();
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir], { stdio: "ignore" });
  try {
    const url = `http://127.0.0.1:${port}/${file}`;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) return { url, body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") };
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    fail(`local static server on :${port} never answered`);
  } finally {
    child.kill();
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

async function main() {
  check(TOKEN, "TROV_MCP_TOKEN is not set");
  console.log(`artifacts-agent e2e against ${BASE} (run ${RUN})`);

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "trov-e2e", version: "1.0.0" },
  });
  ok(`initialize → server ${init.serverInfo?.name} ${init.serverInfo?.version}`);

  const names = (await rpc("tools/list", {})).tools.map((t) => t.name);
  for (const n of ["artifact_list", "artifact_get", "upload_asset", "artifact_update"]) check(names.includes(n), `tools/list lacks ${n}`);
  check(!names.some((n) => /ratif/i.test(n)), "a ratify tool is registered");
  ok(`tools/list → ${names.length} tools, incl. artifact_list/get/create/update, no ratify tool`);

  const common = { area: "ui", repo: "", visibility: "org", summary: "e2e" };
  const md = await tool("upload_asset", { ...common, title: `E2E notes ${RUN}`, kind: "markdown", content: MARKDOWN });
  const html = await tool("upload_asset", { ...common, title: `E2E page ${RUN}`, kind: "html", content: HTML });
  ok(`upload_asset markdown → ${md.slug} v${md.version}; html → ${html.slug} v${html.version}`);

  const png = await tool("upload_asset", {
    ...common, title: `E2E logo ${RUN}`, kind: "image", size_bytes: PNG.length, sha256: sha256(PNG), filename: "e2e-logo.png",
  });
  sameOrigin(png.upload_url, "upload_url");
  const put = await fetch(png.upload_url, { method: "PUT", body: PNG, headers: { "content-type": "image/png" } });
  check(put.status === 200, `upload PUT → HTTP ${put.status} ${await put.text()}`);
  ok(`upload_asset image → ${png.slug}; PUT ${PNG.length} B to upload_url → 200`);

  const list = await tool("artifact_list", { limit: 100 });
  const listed = new Set(list.artifacts.map((a) => a.slug));
  for (const s of [md.slug, html.slug, png.slug]) check(listed.has(s), `artifact_list does not show ${s}`);
  const byKind = await tool("artifact_list", { kind: "image", q: RUN });
  check(byKind.artifacts.length === 1 && byKind.artifacts[0].slug === png.slug, `artifact_list {kind:image,q} → ${JSON.stringify(byKind.artifacts.map((a) => a.slug))}`);
  ok(`artifact_list → ${list.total} visible, all three present; {kind:"image", q} → just ${png.slug}`);

  const gMd = await tool("artifact_get", { slug: md.slug });
  check(gMd.content === MARKDOWN, "markdown artifact_get content differs");
  await download(gMd, Buffer.from(MARKDOWN, "utf8"), `markdown ${md.slug}`);

  const gPng = await tool("artifact_get", { slug: png.slug });
  check(gPng.content === null, "binary artifact_get has inline content");
  const pngBack = await download(gPng, PNG, `image ${png.slug}`);
  check(pngBack.subarray(1, 4).toString("ascii") === "PNG", "downloaded image is not a PNG");

  const gHtml = await tool("artifact_get", { slug: html.slug });
  const htmlBack = await download(gHtml, Buffer.from(HTML, "utf8"), `html ${html.slug}`);

  // Spin it up the way the `artifacts` skill does: save under .trov/artifacts/<slug>/,
  // serve that folder, fetch it back.
  const root = mkdtempSync(join(tmpdir(), "trov-e2e-"));
  try {
    const dir = join(root, ".trov", "artifacts", html.slug);
    mkdirSync(dir, { recursive: true });
    const ext = gHtml.download_filename.split(".").pop();
    const file = `v${gHtml.version.version_no}.${ext}`;
    writeFileSync(join(dir, file), htmlBack);
    const served = await serveAndFetch(dir, file);
    check(served.body.equals(Buffer.from(HTML, "utf8")), "served html differs from the artifact");
    check(served.body.toString("utf8").includes(`Spin me up ${RUN}`), "served html lacks its heading");
    ok(`html spun up: .trov/artifacts/${html.slug}/${file} served at ${served.url} (${served.type}), identical`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // A tampered token is the one not_found, and a second use of a URL still works (reusable in its TTL).
  const t = gPng.download_url;
  const i = t.length - 3;
  const tampered = t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
  const bad = await fetch(tampered);
  check(bad.status === 404, `tampered download → HTTP ${bad.status}, expected 404`);
  const again = await fetch(t);
  check(again.status === 200, `re-download within TTL → HTTP ${again.status}`);
  await again.arrayBuffer();
  ok("tampered download token → 404; the same URL re-downloads (reusable within 5 minutes)");

  console.log(`\nPASS — ${report.length} checks. Page links: ${md.url} · ${html.url} · ${png.url}`);
}

main().catch((e) => {
  console.error(`\nFAIL — ${e instanceof E2EFail ? e.message : e?.stack ?? e}`);
  process.exit(1);
});
