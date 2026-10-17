// Markdown import runs (0081_docs_library `doc_imports`, 0082_doc_import_manifest; docs/architecture/docs-library.md
// › Import): the run's lifecycle over the cookie routes, the org's one lock and a stale run, the caps, the daily
// limit, the server's re-validation of every page and image, links and images rewritten end to end, conflicts
// (skip / new version / rename), a retried batch replaying through the gate's ledger, Review's Approve all /
// Reject all, a bearer refused, and the doc_links backfill for pages promoted before the table existed.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { ImportPagesAnswer, ImportRunView, ImportStartAnswer, ImportsDTO, ImportReviewAnswer, ImportManifestFile } from "@shared/docs-import-core";
import { IMPORT_STALE_MS, MAX_FILES, MAX_MD_BYTES, titleFromMarkdown } from "@shared/docs-import-core";
import { docImageKey } from "@shared/doc-images";
import { app } from "../src/routes";
import { ingestDocProposal } from "../src/consumer";
import { promote_doc } from "../src/tools/writes";
import { sidebarBadges } from "../src/tools/badges";
import { LIMITS } from "../src/platform/limits";
import { DOC_LINKS_DONE, DOC_LINKS_JOB, backfillDocLinks } from "../src/platform/doc-links-backfill";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, mintTokenFor, systemCtx } from "./helpers/tenant";

const OWNER = "AndresL230";          // the org's owner (and the platform's superadmin: never rate limited)
const MEMBER = "lpcooper-arch";
const OTHER = "Darkest-Teddy";
const BASE = "/api/o/saplinglearn/imports";
const A = () => systemCtx(ORG_A);

/** A manifest entry for a Markdown file: its size and its heading, as the browser computes them. */
const md = (path: string, text: string): ImportManifestFile => ({ path, size: new TextEncoder().encode(text).byteLength, title: titleFromMarkdown(text) });
const start = (cookie: string, body: Record<string, unknown>) => call<ImportStartAnswer & { error?: string; run?: ImportRunView }>("POST", BASE, cookie, body);
const pages = (cookie: string, id: number, list: { path: string; text: string }[]) => call<ImportPagesAnswer & { error?: string }>("POST", `${BASE}/${id}/pages`, cookie, { pages: list });
const finish = (cookie: string, id: number, body: unknown = {}) => call<{ run: ImportRunView; error?: string }>("POST", `${BASE}/${id}/finish`, cookie, body);
async function image(cookie: string, id: number, path: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("path", path);
  form.set("file", new File([bytes], path.split("/").pop() ?? "x", { type: "application/octet-stream" }));
  const res = await app.request(`${BASE}/${id}/images`, { method: "POST", headers: { cookie, ...headers }, body: form }, env);
  return { status: res.status, json: (await res.json()) as { path?: string; sha?: string; error?: string } };
}
const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const versions = (where = "1 = 1", ...params: unknown[]) =>
  all<{ slug: string; version: number; status: string; body: string; import_id: number | null; import_path: string | null; created_by: string }>(env.DB,
    `SELECT slug, version, status, body, import_id, import_path, created_by FROM doc_versions WHERE org_id = ? AND ${where} ORDER BY id`, ORG_A, ...params);
const docRow = (slug: string) => first<{ title: string; parent_slug: string | null; current_version: number; space: string }>(env.DB,
  `SELECT title, parent_slug, current_version, space FROM docs WHERE org_id = ? AND slug = ?`, ORG_A, slug);
async function livePage(slug: string, title: string, o: { parent?: string; body?: string } = {}) {
  const r = await ingestDocProposal(A(), { slug, section: "reference", title, body: o.body ?? `${title} body`, change_summary: "s", confidence: "high", space: "engineering", ...(o.parent ? { parent_slug: o.parent } : {}) }, OWNER, { sessionId: crypto.randomUUID(), itemIndex: 0 });
  if (r.outcome !== "written") throw new Error(JSON.stringify(r));
  await promote_doc(A(), slug, r.version, OWNER);
}

// The handbook: a folder page with its own README, a nested folder without one, a link between pages and an image.
const README = "# Engineering handbook\n\nStart with [your first week](onboarding/first-week.md).\n";
const FIRST_WEEK = "# Your first week\n\n![The office](../attachments/office.png)\n\nThen read the [glossary](../glossary.md#terms) and [a missing page](nope.md).\n";
const GLOSSARY = "# Glossary\n\nWords we use.\n";
const handbook = (): Record<string, unknown> => ({
  space: "engineering", file_name: "handbook.zip", file_size: 2048,
  files: [
    md("handbook/README.md", README), md("handbook/onboarding/first-week.md", FIRST_WEEK), md("handbook/glossary.md", GLOSSARY),
    { path: "handbook/attachments/office.png", size: PNG.byteLength }, { path: "handbook/design/logo.sketch", size: 10 }, { path: "handbook/notes/.DS_Store", size: 4 },
  ],
});
const handbookPages = () => [
  { path: "handbook/README.md", text: README },
  { path: "handbook/glossary.md", text: GLOSSARY },
  { path: "handbook/onboarding/", text: "" },
  { path: "handbook/onboarding/first-week.md", text: FIRST_WEEK },
];

describe("an import run, end to end", () => {
  it("plans on the server, uploads an image, stages every page through the gate with links and images rewritten, and finishes partial", async () => {
    const cookie = await cookieFor(MEMBER);
    const s = await start(cookie, handbook());
    expect(s.status).toBe(201);
    const { run, plan } = s.json;
    expect(run).toMatchObject({ status: "running", space: "engineering", space_name: "Engineering", file_name: "handbook.zip", file_size: 2048, file_count: 6, by: MEMBER });
    expect(run.counts).toMatchObject({ pages: 4, new_pages: 4, versions: 0, images: 1, skipped_files: 2, staged: 0 });
    expect(plan.writes.map((w) => [w.key, w.mode, w.slug])).toEqual([
      ["handbook/", "new", "handbook"], ["handbook/glossary.md", "new", "glossary"], ["handbook/onboarding/", "new", "onboarding"],
      ["handbook/onboarding/first-week.md", "new", "first-week"],
    ]);
    expect(plan.skipped.map((x) => [x.path, x.code])).toEqual([["handbook/design/logo.sketch", "not_markdown"], ["handbook/notes/.DS_Store", "hidden"]]);
    expect(run.failures).toHaveLength(2);

    const img = await image(cookie, run.id, "handbook/attachments/office.png", PNG);
    expect(img.status).toBe(200);
    const sha = await sha256(PNG);
    expect(img.json).toMatchObject({ path: "handbook/attachments/office.png", sha });
    expect(await env.ARTIFACTS_BUCKET.head(docImageKey(sha))).not.toBeNull();
    expect(await first(env.DB, `SELECT content_type, size_bytes, uploaded_by FROM doc_images WHERE org_id = ? AND sha256 = ?`, ORG_A, sha)).toEqual({ content_type: "image/png", size_bytes: PNG.byteLength, uploaded_by: MEMBER });

    const sent = await pages(cookie, run.id, handbookPages());
    expect(sent.status).toBe(200);
    expect(sent.json.results.map((r) => r.outcome)).toEqual(["staged", "staged", "staged", "staged"]);
    expect(sent.json.run.counts).toMatchObject({ staged: 4, staged_new: 4, images_uploaded: 1 });

    // Nothing is live; every version is tagged with the run, written by the person.
    const vs = await versions("import_id = ?", run.id);
    expect(vs.map((v) => [v.slug, v.version, v.status, v.import_path, v.created_by])).toEqual([
      ["handbook", 1, "staged", "handbook/README.md", MEMBER], ["glossary", 1, "staged", "handbook/glossary.md", MEMBER],
      ["onboarding", 1, "staged", "handbook/onboarding/", MEMBER], ["first-week", 1, "staged", "handbook/onboarding/first-week.md", MEMBER],
    ]);
    // The tree: the folder pages nest, the heading became the title (and left the body).
    expect(await docRow("handbook")).toMatchObject({ title: "Engineering handbook", parent_slug: null, current_version: 0 });
    expect(await docRow("onboarding")).toMatchObject({ title: "Onboarding", parent_slug: "handbook" });
    expect(await docRow("first-week")).toMatchObject({ title: "Your first week", parent_slug: "onboarding" });
    expect(await docRow("glossary")).toMatchObject({ parent_slug: "handbook" });
    const body = (slug: string) => vs.find((v) => v.slug === slug)!.body;
    expect(body("handbook")).toBe("Start with [[first-week|your first week]].\n");
    expect(body("first-week")).toContain(`![The office](/img/${sha})`);
    expect(body("first-week")).toContain("[[glossary]]");
    expect(body("first-week")).toContain("and a missing page.");
    expect(body("first-week")).not.toContain("# Your first week");

    // Review carries the import.
    const proposals = (await call<{ proposals: { slug: string; import_id: number | null; import_file_name: string | null; import_path: string | null; import_by: string | null; parent_slug: string | null }[] }>("GET", "/api/o/saplinglearn/proposals", cookie)).json.proposals;
    expect(proposals.filter((p) => p.import_id === run.id)).toHaveLength(4);
    expect(proposals.find((p) => p.slug === "first-week")).toMatchObject({ import_file_name: "handbook.zip", import_path: "handbook/onboarding/first-week.md", import_by: MEMBER, parent_slug: "onboarding" });

    // Finish: two files were skipped → partial; history lists it, nothing is running.
    const done = await finish(cookie, run.id);
    expect(done.status).toBe(200);
    expect(done.json.run).toMatchObject({ status: "partial", waiting: 4 });
    expect(done.json.run.ended_at).not.toBeNull();
    const hist = (await call<ImportsDTO>("GET", BASE, cookie)).json;
    expect(hist.running).toBe(0);
    expect(hist.imports[0]).toMatchObject({ id: run.id, status: "partial", counts: { staged: 4 } });
    expect((await call<{ run: ImportRunView }>("GET", `${BASE}/${run.id}`, cookie)).json.run.id).toBe(run.id);
    // An ended run takes nothing more.
    expect((await pages(cookie, run.id, handbookPages().slice(0, 1))).json).toMatchObject({ error: "not_running" });

    // The doc page says where it came from.
    const pg = (await call<{ page: { info: { imported_from: { path: string; file_name: string } | null } } }>("GET", "/api/o/saplinglearn/doc/first-week", cookie)).json.page;
    expect(pg.info.imported_from).toEqual({ path: "handbook/onboarding/first-week.md", file_name: "handbook.zip" });
  });

  it("everything planned staged and nothing skipped is done; a run under a page nests its top level there", async () => {
    const cookie = await cookieFor(MEMBER);
    await livePage("runbooks", "Runbooks");
    const text = "# Deploys\n\nShip it.\n";
    const s = await start(cookie, { space: "engineering", parent_slug: "runbooks", file_name: "deploys.md", files: [md("deploys.md", text)] });
    expect(s.json.run.parent_path).toEqual(["Runbooks"]);
    expect(s.json.plan.writes[0]).toMatchObject({ slug: "deploys", parent_slug: "runbooks" });
    await pages(cookie, s.json.run.id, [{ path: "deploys.md", text }]);
    expect((await finish(cookie, s.json.run.id)).json.run.status).toBe("done");
    expect(await docRow("deploys")).toMatchObject({ parent_slug: "runbooks", title: "Deploys" });
  });

  it("a run that stages nothing because every page failed is failed; cancelling keeps what was sent and frees the lock", async () => {
    const cookie = await cookieFor(MEMBER);
    const s = await start(cookie, { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n\nx\n")] });
    // The text is not what the manifest described.
    const r = await pages(cookie, s.json.run.id, [{ path: "a.md", text: "# Not A\n\nx\n" }]);
    expect(r.json.results[0]).toMatchObject({ outcome: "failed", code: "changed" });
    const f = await finish(cookie, s.json.run.id);
    expect(f.json.run).toMatchObject({ status: "failed", counts: { failed: 1, staged: 0 } });
    expect(f.json.run.failures).toContainEqual({ path: "a.md", code: "changed" });

    const t = await start(cookie, { space: "engineering", file_name: "two.zip", files: [md("one.md", "# One\n"), md("two.md", "# Two\n")] });
    await pages(cookie, t.json.run.id, [{ path: "one.md", text: "# One\n" }]);
    const c = await finish(cookie, t.json.run.id, { cancel: true });
    expect(c.json.run).toMatchObject({ status: "abandoned", cancelled: true, counts: { staged: 1 } });
    expect(await versions("import_id = ?", t.json.run.id)).toHaveLength(1);
    expect((await start(cookie, { space: "engineering", file_name: "b.md", files: [md("b.md", "# B\n")] })).status).toBe(201);
  });
});

describe("one running import per org", () => {
  it("a second start is refused while one runs (with the run); a stale run is abandoned and frees the lock", async () => {
    const member = await cookieFor(MEMBER);
    const other = await cookieFor(OTHER);
    const s = await start(member, { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n")] });
    const busy = await start(other, { space: "engineering", file_name: "b.md", files: [md("b.md", "# B\n")] });
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ error: "import_running", run: { id: s.json.run.id, by: MEMBER } });
    // The badge counts it.
    expect((await sidebarBadges(A(), MEMBER)).imports).toBe(1);
    expect((await call<ImportsDTO>("GET", BASE, other)).json.running).toBe(1);
    // Another org is not locked by it.
    await ensureMember(OTHER, "member", ORG_B);
    expect((await call("POST", "/api/o/acme/imports", other, { space: "engineering", file_name: "b.md", files: [md("b.md", "# B\n")] })).status).toBe(201);
    // Only its starter adds to it.
    expect((await pages(other, s.json.run.id, [{ path: "a.md", text: "# A\n" }])).json).toMatchObject({ error: "forbidden" });
    // Gone quiet for longer than the window: it reads as abandoned, and a new run starts.
    await env.DB.prepare(`UPDATE doc_imports SET updated_at = ? WHERE id = ?`).bind(new Date(Date.now() - IMPORT_STALE_MS - 1000).toISOString(), s.json.run.id).run();
    expect((await call<{ run: ImportRunView }>("GET", `${BASE}/${s.json.run.id}`, member)).json.run.status).toBe("abandoned");
    expect((await sidebarBadges(A(), MEMBER)).imports).toBe(0);
    const next = await start(other, { space: "engineering", file_name: "b.md", files: [md("b.md", "# B\n")] });
    expect(next.status).toBe(201);
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM doc_imports WHERE id = ?`, s.json.run.id))?.status).toBe("abandoned");
    expect((await pages(member, s.json.run.id, [{ path: "a.md", text: "# A\n" }])).json).toMatchObject({ error: "not_running" });
  });

  it("someone else may not end a run; an admin may stop one (Cancel import)", async () => {
    const member = await cookieFor(MEMBER);
    const s = await start(member, { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n")] });
    expect((await finish(await cookieFor(OTHER), s.json.run.id, { cancel: true })).status).toBe(403);
    expect((await finish(await cookieFor(OTHER), s.json.run.id)).status).toBe(403);
    const owner = await cookieFor(OWNER);
    expect((await finish(owner, s.json.run.id)).status).toBe(403);   // ending it is the starter's
    expect((await finish(owner, s.json.run.id, { cancel: true })).json.run).toMatchObject({ status: "abandoned", cancelled: true });
  });
});

describe("the caps, the space, the limit", () => {
  it("refuses too many files, too many bytes, no Markdown, a Markdown file without its heading, an unknown or archived space", async () => {
    const cookie = await cookieFor(MEMBER);
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => md(`p${i}.md`, "# P\n"));
    expect((await start(cookie, { space: "engineering", file_name: "x.zip", files: many })).json).toMatchObject({ error: "too_many_files" });
    expect((await start(cookie, { space: "engineering", file_name: "x.zip", files: many })).status).toBe(413);
    const huge = [{ path: "a.md", size: 30 * 1024 * 1024, title: "A" }, { path: "b.md", size: 30 * 1024 * 1024, title: "B" }];
    expect((await start(cookie, { space: "engineering", file_name: "x.zip", files: huge })).json).toMatchObject({ error: "too_large" });
    expect((await start(cookie, { space: "engineering", file_name: "x.zip", files: [{ path: "a.png", size: 4 }] })).json).toMatchObject({ error: "no_markdown" });
    expect((await start(cookie, { space: "engineering", file_name: "x.zip", files: [{ path: "a.md", size: 4 }] })).json).toMatchObject({ error: "invalid" });
    expect((await start(cookie, { space: "nowhere", file_name: "x.md", files: [md("a.md", "# A\n")] })).json).toMatchObject({ error: "not_found" });
    await env.DB.prepare(`UPDATE doc_spaces SET archived_at = 't' WHERE org_id = ? AND slug = 'design'`).bind(ORG_A).run();
    expect((await start(cookie, { space: "design", file_name: "x.md", files: [md("a.md", "# A\n")] })).json).toMatchObject({ error: "archived" });
    expect((await start(cookie, { space: "engineering", parent_slug: "no-such-page", file_name: "x.md", files: [md("a.md", "# A\n")] })).json).toMatchObject({ error: "not_found" });
    // None of it started a run, and none of it took a unit of the daily limit.
    expect(await all(env.DB, `SELECT id FROM doc_imports`)).toHaveLength(0);
    expect(await all(env.DB, `SELECT 1 FROM abuse_counters WHERE action = 'doc_import'`)).toHaveLength(0);
  });

  it("doc_import: a person's starts per day are limited (429), a superadmin is not", async () => {
    const cookie = await cookieFor(MEMBER);
    const bucket = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(`INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES (?, 'doc_import', ?, ?, ?)`)
      .bind(MEMBER, bucket, LIMITS.doc_import.max, new Date().toISOString()).run();
    const r = await start(cookie, { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n")] });
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ error: "rate_limited" });
    expect((await start(await cookieFor(OWNER), { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n")] })).status).toBe(201);
  });

  it("a bearer is refused on every import route, and Review's group actions", async () => {
    const cookie = await cookieFor(MEMBER);
    const { raw } = await mintTokenFor(MEMBER);
    const headers = { authorization: `Bearer ${raw}` };
    expect((await call("POST", BASE, cookie, { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n")] }, { headers })).status).toBe(403);
    expect((await call("GET", BASE, cookie, undefined, { headers })).status).toBe(403);
    const s = await start(cookie, { space: "engineering", file_name: "a.md", files: [md("a.md", "# A\n")] });
    for (const rest of ["/pages", "/finish", "/approve-all", "/reject-all"]) {
      expect((await call("POST", `${BASE}/${s.json.run.id}${rest}`, cookie, {}, { headers })).status, rest).toBe(403);
    }
    expect((await image(cookie, s.json.run.id, "x.png", PNG, headers)).status).toBe(403);
  });
});

describe("the server re-validates what it is sent", () => {
  it("a batch naming a path that is not a page of the plan, not Markdown, or outside the zip is refused whole — nothing written", async () => {
    const cookie = await cookieFor(MEMBER);
    const s = await start(cookie, handbook());
    const id = s.json.run.id;
    const ok = { path: "handbook/glossary.md", text: GLOSSARY };
    expect((await pages(cookie, id, [ok, { path: "handbook/other.md", text: "# Other\n" }])).json).toMatchObject({ error: "not_in_manifest" });
    expect((await pages(cookie, id, [ok, { path: "handbook/design/logo.sketch", text: "x" }])).json).toMatchObject({ error: "not_markdown" });
    expect((await pages(cookie, id, [ok, { path: "../etc/passwd.md", text: "x" }])).json).toMatchObject({ error: "bad_path" });
    expect((await pages(cookie, id, [ok, { path: "handbook/notes/", text: "" }])).json).toMatchObject({ error: "not_in_manifest" });
    expect((await pages(cookie, id, Array.from({ length: 26 }, () => ok))).json).toMatchObject({ error: "too_many_pages" });
    expect(await versions("import_id = ?", id)).toHaveLength(0);
  });

  it("a page larger than 1 MB, or not the text the manifest described, fails with a code; the rest of the batch goes through", async () => {
    const cookie = await cookieFor(MEMBER);
    const big = `# Big\n\n${"x".repeat(MAX_MD_BYTES)}`;
    const s = await start(cookie, { space: "engineering", file_name: "x.zip", files: [{ path: "big.md", size: 100, title: "Big" }, md("fine.md", "# Fine\n\nok\n"), md("liar.md", "# Liar\n")] });
    const r = await pages(cookie, s.json.run.id, [{ path: "big.md", text: big }, { path: "fine.md", text: "# Fine\n\nok\n" }, { path: "liar.md", text: "# Liar\n\nmuch longer than it said it was" }]);
    expect(r.json.results.map((x) => [x.path, x.outcome, x.code ?? null])).toEqual([["big.md", "failed", "too_large"], ["fine.md", "staged", null], ["liar.md", "failed", "changed"]]);
    expect(r.json.run.counts).toMatchObject({ staged: 1, failed: 2 });
    // A retry that now succeeds clears the page's failure.
    const again = await pages(cookie, s.json.run.id, [{ path: "liar.md", text: "# Liar\n" }]);
    expect(again.json.results[0].outcome).toBe("staged");
    expect(again.json.run.failures.map((f) => f.path)).toEqual(["big.md"]);
  });

  it("an image: only one the manifest lists, no larger than it said, sniffed from its bytes (the name's type is not trusted)", async () => {
    const cookie = await cookieFor(MEMBER);
    const s = await start(cookie, { space: "engineering", file_name: "x.zip", files: [md("a.md", "# A\n\n![x](pic.png)\n"), { path: "pic.png", size: JPEG.byteLength }, { path: "small.gif", size: 2 }] });
    const id = s.json.run.id;
    expect((await image(cookie, id, "other.png", PNG)).json).toMatchObject({ error: "not_in_manifest" });
    expect((await image(cookie, id, "small.gif", PNG)).status).toBe(413);
    expect((await image(cookie, id, "pic.png", new Uint8Array([1, 2, 3, 4]))).json).toMatchObject({ error: "not_an_image" });
    const ok = await image(cookie, id, "pic.png", JPEG);
    expect(ok.status).toBe(200);
    expect(ok.json.sha).toBe(await sha256(JPEG));
    expect((await first<{ content_type: string }>(env.DB, `SELECT content_type FROM doc_images WHERE org_id = ? AND sha256 = ?`, ORG_A, ok.json.sha))?.content_type).toBe("image/jpeg");
    const r = await pages(cookie, id, [{ path: "a.md", text: "# A\n\n![x](pic.png)\n" }]);
    expect(r.json.results[0].outcome).toBe("staged");
    expect((await versions("import_id = ?", id))[0].body).toBe(`![x](/img/${ok.json.sha})\n`);
  });

  it("an image never uploaded is dropped to its alt text, and the page still stages (the gate never sees a dangling image)", async () => {
    const cookie = await cookieFor(MEMBER);
    const text = "# A\n\n![a diagram](pic.png)\n";
    const s = await start(cookie, { space: "engineering", file_name: "x.zip", files: [md("a.md", text), { path: "pic.png", size: PNG.byteLength }] });
    const r = await pages(cookie, s.json.run.id, [{ path: "a.md", text }]);
    expect(r.json.results[0].outcome).toBe("staged");
    expect((await versions("import_id = ?", s.json.run.id))[0].body).toBe("a diagram\n");
  });
});

describe("conflicts with pages already in the space", () => {
  it("the default stages a new version on the existing page; skip writes nothing and nests the children under the existing page; rename is a new page", async () => {
    const cookie = await cookieFor(MEMBER);
    await livePage("local-setup", "Local setup");
    await livePage("deploys", "Deploys");
    await livePage("paging", "Paging and escalation");
    const files = [
      md("local-setup.md", "# Local setup\n\nNode 20.\n"),
      md("operations/deploys.md", "# Deploys\n\nNew deploy steps.\n"),
      md("paging.md", "# Paging and escalation\n\nNew.\n"),
      md("ops.md", "# Deploys\n"),   // a folder's own file: `ops/` merges into it
      md("ops/rollback.md", "# Rolling back\n"),
    ];
    const s = await start(cookie, { space: "engineering", file_name: "handbook.zip", files, choices: { "ops/": "skip", "paging.md": { choice: "rename", title: "Paging (handbook)" } } });
    const w = Object.fromEntries(s.json.plan.writes.map((x) => [x.key, x]));
    expect(s.json.plan.conflicts.map((c) => c.key).sort()).toEqual(["local-setup.md", "operations/deploys.md", "ops/", "paging.md"]);
    expect(w["local-setup.md"]).toMatchObject({ mode: "version", slug: "local-setup" });
    expect(w["ops/"]).toMatchObject({ mode: "skip", slug: "deploys" });
    expect(w["ops/rollback.md"]).toMatchObject({ mode: "new", parent_slug: "deploys" });
    expect(w["paging.md"]).toMatchObject({ mode: "new", title: "Paging (handbook)" });
    expect(s.json.run.counts).toMatchObject({ versions: 2, skipped_pages: 1 });
    const r = await pages(cookie, s.json.run.id, s.json.plan.writes.filter((x) => x.mode !== "skip").map((x) => ({ path: x.path ?? x.key, text: files.find((f) => f.path === x.path) ? texts[x.path as string] : "" })));
    expect(r.json.results.every((x) => x.outcome === "staged")).toBe(true);
    // The version: on the existing slug, the live page unchanged until it is approved.
    expect((await versions("slug = 'local-setup'")).map((v) => [v.version, v.status, v.import_id])).toEqual([[1, "promoted", null], [2, "staged", s.json.run.id]]);
    expect(await docRow("local-setup")).toMatchObject({ title: "Local setup", current_version: 1 });
    expect(await docRow("rollback")).toMatchObject({ parent_slug: "deploys" });
    expect(await docRow(w["paging.md"].slug)).toMatchObject({ title: "Paging (handbook)", current_version: 0 });
    expect((await finish(cookie, s.json.run.id)).json.run.counts).toMatchObject({ staged: 5, staged_new: 3, staged_versions: 2 });
  });
});
const texts: Record<string, string> = {
  "local-setup.md": "# Local setup\n\nNode 20.\n", "operations/deploys.md": "# Deploys\n\nNew deploy steps.\n",
  "paging.md": "# Paging and escalation\n\nNew.\n", "ops.md": "# Deploys\n", "ops/rollback.md": "# Rolling back\n",
};

describe("a retried batch replays through the gate's ledger", () => {
  it("the same pages sent twice stage once, and the second answer says staged again", async () => {
    const cookie = await cookieFor(MEMBER);
    const s = await start(cookie, handbook());
    await image(cookie, s.json.run.id, "handbook/attachments/office.png", PNG);
    const first1 = await pages(cookie, s.json.run.id, handbookPages());
    const again = await pages(cookie, s.json.run.id, handbookPages());
    expect(again.json.results.map((r) => r.outcome)).toEqual(first1.json.results.map((r) => r.outcome));
    expect(await versions("import_id = ?", s.json.run.id)).toHaveLength(4);
    expect(again.json.run.counts.staged).toBe(4);
    expect(await all(env.DB, `SELECT 1 FROM processed_items WHERE org_id = ? AND session_id = ?`, ORG_A, `import:${s.json.run.id}`)).toHaveLength(4);
  });

  it("a page identical to the live one is unchanged (listed, not an error), and the run is still done", async () => {
    const cookie = await cookieFor(MEMBER);
    await livePage("same", "Same", { body: "Same body.\n" });
    const text = "# Same\n\nSame body.\n";
    const s = await start(cookie, { space: "engineering", file_name: "same.md", files: [md("same.md", text)] });
    const r = await pages(cookie, s.json.run.id, [{ path: "same.md", text }]);
    expect(r.json.results[0]).toMatchObject({ outcome: "unchanged", code: "unchanged" });
    const f = await finish(cookie, s.json.run.id);
    expect(f.json.run).toMatchObject({ status: "done", counts: { unchanged: 1, failed: 0, staged: 0 } });
  });
});

describe("Review: Approve all / Reject all for one import", () => {
  async function imported(cookie: string) {
    const s = await start(cookie, handbook());
    await image(cookie, s.json.run.id, "handbook/attachments/office.png", PNG);
    await pages(cookie, s.json.run.id, handbookPages());
    await finish(cookie, s.json.run.id);
    return s.json.run.id;
  }

  it("approve-all promotes every waiting page through the promote writer: live, links rebuilt, the tree kept", async () => {
    const cookie = await cookieFor(MEMBER);
    const id = await imported(cookie);
    const r = await call<ImportReviewAnswer>("POST", `${BASE}/${id}/approve-all`, cookie, {});
    expect(r.json).toMatchObject({ ok: true, done: 4, remaining: 0, space: "engineering", space_name: "Engineering" });
    expect((await versions("import_id = ?", id)).every((v) => v.status === "promoted")).toBe(true);
    expect(await docRow("first-week")).toMatchObject({ current_version: 1, parent_slug: "onboarding" });
    expect(await all(env.DB, `SELECT from_slug, to_slug FROM doc_links WHERE org_id = ? ORDER BY from_slug, to_slug`, ORG_A)).toEqual([
      { from_slug: "first-week", to_slug: "glossary" }, { from_slug: "handbook", to_slug: "first-week" },
    ]);
    expect((await call<{ run: ImportRunView }>("GET", `${BASE}/${id}`, cookie)).json.run.waiting).toBe(0);
    // Nothing left: a second call does nothing.
    expect((await call<ImportReviewAnswer>("POST", `${BASE}/${id}/approve-all`, cookie, {})).json).toMatchObject({ done: 0, remaining: 0 });
  });

  it("reject-all is soft, and leaves alone a page whose newest change is someone else's", async () => {
    const cookie = await cookieFor(MEMBER);
    const id = await imported(cookie);
    // An agent stages a newer change on top of the imported glossary: that is what Review shows for the page now.
    const agent = await ingestDocProposal(A(), { slug: "glossary", section: "reference", body: "An agent's glossary.", change_summary: "s", confidence: "high" }, OTHER, { sessionId: "agent", itemIndex: 0 });
    expect(agent).toMatchObject({ outcome: "written", version: 2 });
    const r = await call<ImportReviewAnswer>("POST", `${BASE}/${id}/reject-all`, cookie, {});
    expect(r.json).toMatchObject({ done: 3, remaining: 0 });
    const vs = await versions("import_id = ?", id);
    expect(vs.filter((v) => v.status === "rejected").map((v) => v.slug).sort()).toEqual(["first-week", "handbook", "onboarding"]);
    expect(vs.find((v) => v.slug === "glossary")?.status).toBe("staged");
    // Soft: the rows and their bodies stay.
    expect(vs.every((v) => v.body.length > 0 || v.slug === "onboarding")).toBe(true);
    expect((await versions("slug = 'glossary' AND version = 2"))[0].status).toBe("staged");
  });

  it("another org's import is not found", async () => {
    const cookie = await cookieFor(MEMBER);
    const id = await imported(cookie);
    await ensureMember(OTHER, "member", ORG_B);
    const outsider = await cookieFor(OTHER);
    for (const rest of ["/approve-all", "/reject-all"]) expect((await call("POST", `/api/o/acme/imports/${id}${rest}`, outsider, {})).status).toBe(404);
    expect((await call("GET", `/api/o/acme/imports/${id}`, outsider)).status).toBe(404);
    expect((await versions("import_id = ? AND status = 'staged'", id))).toHaveLength(4);
  });
});

describe("the doc_links backfill", () => {
  it("fills in the links of live pages promoted before the table existed — bounded, resumable, then done", async () => {
    await livePage("target", "Target");
    await livePage("p1", "P1", { body: "See [[target]] and [[nowhere]]." });
    await livePage("p2", "P2", { body: "`[[code]]` only, and [[target|the target]]." });
    await livePage("p3", "P3", { body: "No links." });
    // As before 0081's promote wrote them.
    await env.DB.prepare(`DELETE FROM doc_links`).run();
    await env.DB.prepare(`DELETE FROM cron_cursor WHERE job = ?`).bind(DOC_LINKS_JOB).run();
    const step = await backfillDocLinks(env as unknown as import("../src/env").Env, 1);
    expect(step).toMatchObject({ done: false });
    let out = step;
    for (let i = 0; i < 10 && !out.done; i++) out = await backfillDocLinks(env as unknown as import("../src/env").Env, 1);
    expect(out.done).toBe(true);
    expect(await all(env.DB, `SELECT org_id, from_slug, to_slug FROM doc_links ORDER BY from_slug, to_slug`)).toEqual([
      { org_id: ORG_A, from_slug: "p1", to_slug: "nowhere" }, { org_id: ORG_A, from_slug: "p1", to_slug: "target" }, { org_id: ORG_A, from_slug: "p2", to_slug: "target" },
    ]);
    expect((await first<{ last_key: string }>(env.DB, `SELECT last_key FROM cron_cursor WHERE job = ?`, DOC_LINKS_JOB))?.last_key).toBe(DOC_LINKS_DONE);
    // Done: it reads nothing again, and a page that has rows is never rewritten by it.
    await env.DB.prepare(`DELETE FROM doc_links WHERE from_slug = 'p2'`).run();
    expect(await backfillDocLinks(env as unknown as import("../src/env").Env)).toEqual({ pages: 0, links: 0, done: true });
    expect(await all(env.DB, `SELECT 1 FROM doc_links WHERE from_slug = 'p2'`)).toHaveLength(0);
  });

  it("charges the pages it reads, not a full page per org: an org with nothing to read costs no budget (E2E CR1)", async () => {
    // org_b (read first, by id) has no page. With a budget of one page-read's worth, the run still reaches
    // SaplingLearn and finishes — before, org_b's empty read used the whole budget and the run stopped short.
    await livePage("target", "Target");
    await livePage("p1", "P1", { body: "See [[target]]." });
    await env.DB.prepare(`DELETE FROM doc_links`).run();
    await env.DB.prepare(`DELETE FROM cron_cursor WHERE job = ?`).bind(DOC_LINKS_JOB).run();
    const out = await backfillDocLinks(env as unknown as import("../src/env").Env, 50);
    expect(out).toEqual({ pages: 1, links: 1, done: true });
    expect(await all(env.DB, `SELECT org_id, from_slug, to_slug FROM doc_links`)).toEqual([{ org_id: ORG_A, from_slug: "p1", to_slug: "target" }]);
  });
});
