#!/usr/bin/env node
// Local-only seed for the artifact-inspector-width end-to-end test (docs/testing/artifact-inspector-width-test-log.md):
// Ask's inspector opens an artifact at 400px and every other kind at 480px. Applied ON TOP of the dev seed
// (`npm run seed`), to LOCAL D1 and LOCAL R2 only (it refuses --remote). Idempotent: every run deletes the rows it owns
// (ids 9401–9420 for artifact pages, 9401–9409 for threads, 94001–94099 for messages) and writes them again.
//
// Fixtures (org_saplinglearn, all obviously fake: `test-aiw-` slugs, "test-aiw" titles):
//   art-html      test-aiw-html       an org HTML page, published, wider than the panel (a 900px table)
//   art-markdown  test-aiw-markdown   an org Markdown page
//   art-svg       test-aiw-svg        an org SVG drawing, 1200×300
//   art-mermaid   test-aiw-mermaid    an org Mermaid diagram
//   art-image     test-aiw-image      an org PNG (fixtures/dev/ai-showcase/railway-build-log.png, in local R2)
//   art-pdf       test-aiw-pdf        an org one-page PDF (generated here, in local R2)
//   art-file      test-aiw-file       an org CSV file (generated here, in local R2)
//   art-private   test-aiw-private    AndresL230's PRIVATE Markdown page (the inspector's "Publish to org" card)
//   art-longtitle test-aiw-long-title an org page whose title is long, with unicode and emoji
//   art-deleted   test-aiw-deleted    a soft-deleted org page (the server resolves nothing for it)
//   art-hidden    test-aiw-hidden     meilin's PRIVATE page (AndresL230 cannot see it)
//   thread-kinds  thread 9401 "test-aiw: every kind" — one answer naming every artifact above plus a ticket, a pull
//                 request, a doc, a sprint and a person, so each opens the inspector from a chip
//   thread-one    thread 9402 "test-aiw: one artifact" — one answer naming test-aiw-html alone
//   thread-member thread 9403 "test-aiw: as a member" — MEILIN's (a member, not the author): test-aiw-html (she sees it, no
//                 Publish card) and AndresL230's private page (she cannot see it: plain text)
//
// The chips are stored as the RefViews the running Worker builds (`POST /ask/peek`, like ai-showcase.mjs), so a dev
// server signed in as AndresL230 must be up: pass `--server <origin>` (default http://localhost:8812).
//
// usage: npm run seed && node scripts/seed/artifact-inspector-width.mjs --server http://localhost:8812
//        (another checkout's server: add --persist-to=<checkout>/.wrangler/state so the rows land in ITS local D1/R2)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targetsRemote } from "./build.mjs";
import { localD1 } from "./local-d1.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("artifact-inspector-width seed: refusing --remote. This seed only ever targets LOCAL D1 and R2.");
  process.exit(1);
}
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const SERVER = arg("--server", "http://localhost:8812").replace(/\/+$/, "");
// `--persist-to <dir>` (or `--persist-to=<dir>`): another checkout's `.wrangler/state` (the base worktree's server).
const PERSIST = argv.find((a) => a.startsWith("--persist-to="))?.slice(13) ?? arg("--persist-to", null);

const ORG = "org_saplinglearn", SLUG = "saplinglearn", ME = "AndresL230", OTHER = "meilin";
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table, obj) => `INSERT INTO ${table} (${Object.keys(obj).join(", ")}) VALUES (${Object.values(obj).map((v) => (v !== null && typeof v === "object" ? q(JSON.stringify(v)) : q(v))).join(", ")})`;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const d1 = localD1({ persistTo: PERSIST });
const ENV = { ...process.env, npm_config_loglevel: "error" };

// ── the bytes of the binary kinds ──────────────────────────────────────────────────────────────────────────────────
const png = readFileSync(fileURLToPath(new URL("../../fixtures/dev/ai-showcase/railway-build-log.png", import.meta.url)));
function onePagePdf(text) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const pdf = onePagePdf("test-aiw: a one-page PDF");
const csv = Buffer.from("id,name,email\n1,test-aiw one,one@example.com\n2,test-aiw two,two@example.com\n", "utf8");

// ── the pages ──────────────────────────────────────────────────────────────────────────────────────────────────────
const wideTable = `<table style="width:900px;border-collapse:collapse">${Array.from({ length: 6 }, (_, r) => `<tr>${Array.from({ length: 8 }, (_, c) => `<td style="border:1px solid #999;padding:6px">r${r} c${c}</td>`).join("")}</tr>`).join("")}</table>`;
const PAGES = [
  { id: 9401, slug: "test-aiw-html", title: "test-aiw HTML page", kind: "html", content: `<!doctype html><html><body style="font-family:sans-serif;margin:16px"><h1>test-aiw HTML page</h1><p>A table wider than the panel:</p>${wideTable}</body></html>`, type: "text/html; charset=utf-8" },
  { id: 9402, slug: "test-aiw-markdown", title: "test-aiw Markdown page", kind: "markdown", content: "# test-aiw Markdown page\n\nA paragraph, a list:\n\n- one\n- two\n", type: "text/markdown; charset=utf-8" },
  { id: 9403, slug: "test-aiw-svg", title: "test-aiw SVG drawing", kind: "svg", content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 300" width="1200" height="300"><rect x="0" y="0" width="1200" height="300" fill="#e8f0e0"/><text x="40" y="160" font-size="48" fill="#334">test-aiw SVG, 1200 by 300</text></svg>`, type: "image/svg+xml" },
  { id: 9404, slug: "test-aiw-mermaid", title: "test-aiw Mermaid diagram", kind: "mermaid", content: "flowchart LR\n  A[test-aiw start] --> B[middle] --> C[end]\n", type: "text/plain; charset=utf-8" },
  { id: 9405, slug: "test-aiw-image", title: "test-aiw image", kind: "image", bytes: png, type: "image/png", filename: "test-aiw-image.png" },
  { id: 9406, slug: "test-aiw-pdf", title: "test-aiw PDF", kind: "pdf", bytes: pdf, type: "application/pdf", filename: "test-aiw.pdf" },
  { id: 9407, slug: "test-aiw-file", title: "test-aiw CSV file", kind: "file", bytes: csv, type: "text/csv", filename: "test-aiw.csv" },
  { id: 9408, slug: "test-aiw-private", title: "test-aiw private draft", kind: "markdown", content: "# test-aiw private draft\n\nOnly its author sees it.\n", type: "text/markdown; charset=utf-8", visibility: "private", status: "draft" },
  { id: 9409, slug: "test-aiw-long-title", title: "test-aiw ✨ Ünïcödé — a very long artifact title that cannot fit on one line of a 400px panel 🚀📈", kind: "markdown", content: "# Long title\n", type: "text/markdown; charset=utf-8" },
  { id: 9410, slug: "test-aiw-deleted", title: "test-aiw deleted page", kind: "markdown", content: "# Deleted\n", type: "text/markdown; charset=utf-8", deleted: true },
  { id: 9411, slug: "test-aiw-hidden", title: "test-aiw someone else's private page", kind: "markdown", content: "# Hidden\n", type: "text/markdown; charset=utf-8", visibility: "private", status: "draft", author: OTHER },
];

const s = [];
// ── clean what this seed owns ──────────────────────────────────────────────────────────────────────────────────────
s.push(`DELETE FROM chat_messages WHERE org_id = '${ORG}' AND thread_id BETWEEN 9401 AND 9409`);
s.push(`DELETE FROM chat_threads WHERE org_id = '${ORG}' AND id BETWEEN 9401 AND 9409`);
s.push(`DELETE FROM artifacts_fts WHERE page_id IN (${PAGES.map((p) => q(String(p.id))).join(", ")})`);
s.push(`DELETE FROM artifact_links WHERE org_id = '${ORG}' AND page_id BETWEEN 9401 AND 9420`);
s.push(`DELETE FROM artifact_versions WHERE org_id = '${ORG}' AND page_id BETWEEN 9401 AND 9420`);
s.push(`DELETE FROM artifact_pages WHERE org_id = '${ORG}' AND (id BETWEEN 9401 AND 9420 OR slug LIKE 'test-aiw-%')`);

// ── the pages and their one version ────────────────────────────────────────────────────────────────────────────────
const bucket = (readFileSync("wrangler.toml", "utf8").match(/binding\s*=\s*"ARTIFACTS_BUCKET"\s*\n\s*bucket_name\s*=\s*"([^"]+)"/) ?? [])[1] ?? "trov-artifacts";
for (const [i, p] of PAGES.entries()) {
  const at = ago(60 + i);
  const vis = p.visibility ?? "org", status = p.status ?? "published";
  s.push(row("artifact_pages", {
    id: p.id, org_id: ORG, slug: p.slug, title: p.title, kind: p.kind, area: "ui", repo: "", author_id: p.author ?? ME, status, visibility: vis,
    current_version: 1, created_at: at, updated_at: at, published_at: status === "published" ? at : null, deleted_at: p.deleted ? ago(5) : null, deleted_by: p.deleted ? ME : null,
  }));
  const bytes = p.bytes ?? Buffer.from(p.content, "utf8");
  const sha = sha256(bytes);
  if (p.bytes) {
    const dir = mkdtempSync(join(tmpdir(), "trov-aiw-"));
    const file = join(dir, p.filename);
    writeFileSync(file, p.bytes);
    execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/artifacts/${sha}`, "--local", ...(PERSIST ? [`--persist-to=${PERSIST}`] : []), `--file=${file}`, `--content-type=${p.type}`], { stdio: ["ignore", "ignore", "inherit"], env: ENV });
  }
  s.push(row("artifact_versions", {
    org_id: ORG, page_id: p.id, version_no: 1, summary: "test-aiw fixture", content: p.bytes ? null : p.content, r2_key: p.bytes ? `artifacts/${sha}` : null,
    size_bytes: bytes.length, content_type: p.type, sha256: sha, filename: p.filename ?? null, created_by: p.author ?? ME, created_at: at,
  }));
  if (!p.deleted) s.push(row("artifacts_fts", { page_id: String(p.id), title: p.title, description: "test-aiw fixture", body: p.bytes ? "" : p.content, org_id: ORG }));
}
d1.apply("artifact-inspector-width: pages", s);

// ── the chips: the RefViews the running Worker builds ──────────────────────────────────────────────────────────────
const OTHERS = ["ticket:87", "pr:185", "doc:sapling-adr-model-routing", "sprint:9701", "person:meilin"];
const ARTS = PAGES.map((p) => `artifact:${p.slug}`);
const refs = [...ARTS, ...OTHERS];
let views = {};
try {
  const res = await fetch(`${SERVER}/api/o/${SLUG}/ask/peek`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refs }) });
  if (!res.ok) throw new Error(`peek answered ${res.status}`);
  for (const it of (await res.json()).items ?? []) if (!it.hidden) views[it.ref] = it;
} catch (e) {
  console.error(`artifact-inspector-width seed: the local Worker at ${SERVER} did not peek (${e instanceof Error ? e.message : e}). Start it signed in as ${ME}, or pass --server <origin>.`);
  process.exit(1);
}

// ── the threads ────────────────────────────────────────────────────────────────────────────────────────────────────
const t = [];
let msg = 94001;
function thread(id, title, question, answer, minutesAgo, handle = ME) {
  const at = ago(minutesAgo);
  t.push(row("chat_threads", { id, org_id: ORG, handle, title, mode: "smart", origin: "page", context_ref: null, pinned: 0, auto_mode: 0, draft: "", summary: "", summary_through: 0, turn: 1, stop_requested: 0, created_at: at, updated_at: at }));
  t.push(row("chat_messages", { id: msg++, org_id: ORG, thread_id: id, role: "user", mode: "smart", content_json: { text: question, command: null, context: [], refs: [], attached: [] }, cites_json: [], attachments_json: [], model: null, units: 0, created_at: at }));
  const named = [...answer.matchAll(/\[\[(\w+):([^\]|]+)\]\]/g)].map((m) => `${m[1]}:${m[2]}`);
  const known = named.filter((r) => views[r]);
  t.push(row("chat_messages", {
    id: msg++, org_id: ORG, thread_id: id, role: "assistant", mode: "smart",
    content_json: { text: answer, refs: known, blocks: [], activity: [], followups: [], thinking: null, parts: [{ kind: "text", md: answer }] },
    cites_json: [...new Set(known)].map((r) => views[r]), attachments_json: [], model: null, units: 1, stopped: 0, created_at: at,
  }));
}
const line = (label, ref) => `- ${label}: [[${ref}]]`;
thread(9401, "test-aiw: every kind", "test-aiw: list every kind",
  ["Every kind the inspector opens:", "",
    ...PAGES.map((p) => line(p.slug.replace("test-aiw-", ""), `artifact:${p.slug}`)),
    line("ticket", "ticket:87"), line("pull request", "pr:185"), line("doc", "doc:sapling-adr-model-routing"), line("sprint", "sprint:9701"), line("person", "person:meilin")].join("\n"), 3);
thread(9402, "test-aiw: one artifact", "test-aiw: just the HTML page", "The page: [[artifact:test-aiw-html]].", 2);
// meilin's thread: the chips are AndresL230's views, so the private page's view is left out by hand (she cannot see it).
const asMember = { ...views };
delete asMember["artifact:test-aiw-private"];
{ const keep = views; views = asMember; thread(9403, "test-aiw: as a member", "test-aiw: the pages", "The page: [[artifact:test-aiw-html]]. Andres's draft: [[artifact:test-aiw-private]].", 1, OTHER); views = keep; }
d1.apply("artifact-inspector-width: threads", t);

// ── check ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const [pages, threads, msgs] = d1.query([
  `SELECT slug, kind, visibility, status, author_id, deleted_at IS NOT NULL AS deleted FROM artifact_pages WHERE org_id = '${ORG}' AND id BETWEEN 9401 AND 9420 ORDER BY id`,
  `SELECT id, title FROM chat_threads WHERE org_id = '${ORG}' AND id BETWEEN 9401 AND 9409 ORDER BY id`,
  `SELECT COUNT(*) AS n FROM chat_messages WHERE org_id = '${ORG}' AND thread_id BETWEEN 9401 AND 9409`,
]);
console.log("\nPages:");
for (const p of pages) console.log(`  ${p.slug.padEnd(22)} ${p.kind.padEnd(8)} ${p.visibility.padEnd(7)} ${p.status.padEnd(9)} @${p.author_id}${p.deleted ? " (deleted)" : ""}`);
console.log(`Threads: ${threads.map((x) => `${x.id} "${x.title}"`).join(", ")}; ${msgs[0].n} messages.`);
console.log(`Chips the server resolved: ${Object.keys(views).length}/${refs.length}; unresolved (shown as plain text): ${refs.filter((r) => !views[r]).join(", ") || "none"}`);
console.log(`Open: ${SERVER}/${SLUG}/#ask/9401`);
