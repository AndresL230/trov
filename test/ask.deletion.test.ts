// Ask Trov's attachments when what holds them goes (src/deletion/ask.ts, src/deletion/person.ts; the owner's ruling,
// docs/architecture/ask.md › Deleting a thread or an account): deleting a THREAD deletes its attachments — rows and
// R2 bytes — except a file a ticket or a doc still refers to, or one the person published; deleting an ACCOUNT deletes
// the person's PRIVATE attachments; deleting an ORGANIZATION takes them with every other artifact.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { addLink, createPage, patchPage } from "../src/tools/artifacts";
import { add_ticket_comment, create_ticket } from "../src/tools/tickets";
import { deleteAccount } from "../src/deletion/person";
import { addressGlobs } from "../src/deletion/ask";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, platformCtx, tenantCtx } from "./helpers/tenant";
import { BASE, KEYED, call, threadOf } from "./helpers/ask";

const ME = "ask-deleter";
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n + 1, n + 2, n + 3]);

interface Att { id: number; slug: string; sha256: string }
async function upload(cookie: string, files: { name: string; bytes: Uint8Array }[], threadId?: number): Promise<{ threadId: number; attachments: Att[] }> {
  const form = new FormData();
  for (const f of files) form.append("file", new File([f.bytes], f.name, { type: "image/png" }));
  // With no thread given, a real one: an upload with no thread is PENDING (Q60), and these are a thread's files.
  form.append("threadId", String(threadId ?? (await threadOf(cookie))));
  const res = await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie }, body: form }, KEYED);
  expect(res.status).toBe(200);
  return res.json();
}

const pageOf = (slug: string) => first<{ id: number; visibility: string }>(env.DB, `SELECT id, visibility FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, slug);
const inR2 = async (sha: string) => (await env.ARTIFACTS_BUCKET.head(`artifacts/${sha}`)) !== null;
/** Every row the artifact had: page, versions, links, search row. */
async function rowsOf(slug: string, id: number) {
  return {
    page: !!(await pageOf(slug)),
    versions: (await all(env.DB, `SELECT id FROM artifact_versions WHERE page_id = ?`, id)).length,
    links: (await all(env.DB, `SELECT page_id FROM artifact_links WHERE page_id = ?`, id)).length,
    fts: (await all(env.DB, `SELECT page_id FROM artifacts_fts WHERE page_id = ?`, String(id))).length,
  };
}

describe("the address match", () => {
  it("finds the app link, the raw link and a ref token — never a longer slug that starts with it", () => {
    const globs = addressGlobs("shot-png");
    expect(globs).toEqual(["*artifacts/shot-png[^a-z0-9-]*", "*artifacts/shot-png", "*raw/a/shot-png[^a-z0-9-]*", "*raw/a/shot-png", "*[[][[]artifact:shot-png[^a-z0-9-]*"]);
  });
});

describe("deleting a thread deletes its attachments, except what a ticket or a doc still refers to", () => {
  it("rows and bytes of the rest go; ticket links, ticket text, doc bodies, staged versions and published files keep theirs", async () => {
    const cookie = await cookieFor(ME);
    const ctx = await tenantCtx(ME);
    const up = await upload(cookie, [
      { name: "plain.png", bytes: png(1) },         // nothing refers to it → deleted
      { name: "linked.png", bytes: png(10) },       // linked to a ticket → kept
      { name: "in-comment.png", bytes: png(20) },   // its raw address in a ticket comment → kept
      { name: "in-doc.png", bytes: png(30) },       // its app address in a live doc → kept
    ]);
    const up2 = await upload(cookie, [
      { name: "staged.png", bytes: png(40) },       // its ref token in a STAGED doc version only → kept
      { name: "published.png", bytes: png(50) },    // the person shared it with the org → kept
      { name: "shared-bytes.png", bytes: png(60) }, // nothing refers to it, but another artifact holds the same bytes → rows go, bytes stay
    ], up.threadId);
    const [plain, linked, inComment, inDoc] = up.attachments;
    const [staged, published, sharedBytes] = up2.attachments;

    const n = await create_ticket(ctx, { title: "Has a file", body: "", category: "bug", priority: "normal", assignees: [ME] }, ME);
    await addLink(ctx, linked.slug, { target_type: "ticket", target_ref: String(n) }, ME);
    await add_ticket_comment(ctx, n, `the screenshot: /api/o/saplinglearn/raw/a/${inComment.slug}@v1`, ME);
    // A doc names in-doc.png, and a slug that merely STARTS with plain.png's does not keep plain.png.
    await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('runbook', 'reference', 'Runbook', ?, 1, '2026-10-15', 'AndresL230')`,
      `See [the error](/saplinglearn/#artifacts/${inDoc.slug}) and [another](#artifacts/${plain.slug}-2).`);
    await run(env.DB, `INSERT INTO doc_versions (slug, version, body, status, created_at, created_by) VALUES ('runbook', 2, ?, 'staged', '2026-10-15', 'AndresL230')`,
      `Proposed: [[artifact:${staged.slug}]] shows it.`);
    await patchPage(ctx, published.slug, { visibility: "org" }, ME);
    await createPage(await tenantCtx("AndresL230"), { title: "Same bytes", kind: "image", area: "ui", repo: "", visibility: "org", bytes: png(60), filename: "same.png", content_type: "image/png" }, "AndresL230", env.ARTIFACTS_BUCKET);

    // Another thread of theirs: untouched.
    const other = await upload(cookie, [{ name: "elsewhere.png", bytes: png(70) }]);
    const ids = Object.fromEntries(await Promise.all([plain, linked, inComment, inDoc, staged, published, sharedBytes, other.attachments[0]].map(async (a) => [a.slug, (await pageOf(a.slug))!.id])));
    for (const a of [plain, sharedBytes]) expect(await inR2(a.sha256)).toBe(true);

    expect((await call("DELETE", `${BASE}/ask/threads/${up.threadId}`, cookie)).status).toBe(200);

    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE id = ?`, up.threadId)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_artifacts WHERE thread_id = ?`, up.threadId)).toEqual([]);
    // Gone: every row, and the bytes.
    expect(await rowsOf(plain.slug, ids[plain.slug])).toEqual({ page: false, versions: 0, links: 0, fts: 0 });
    expect(await inR2(plain.sha256)).toBe(false);
    // Rows gone, bytes kept: another artifact points at the same object.
    expect(await rowsOf(sharedBytes.slug, ids[sharedBytes.slug])).toEqual({ page: false, versions: 0, links: 0, fts: 0 });
    expect(await inR2(sharedBytes.sha256)).toBe(true);
    // Kept whole, rows and bytes.
    for (const a of [linked, inComment, inDoc, staged, published]) {
      expect((await rowsOf(a.slug, ids[a.slug])), a.slug).toMatchObject({ page: true, versions: 1 });
      expect(await inR2(a.sha256), a.slug).toBe(true);
    }
    expect((await rowsOf(linked.slug, ids[linked.slug])).links).toBe(1);
    expect((await pageOf(published.slug))!.visibility).toBe("org");
    // The other thread and its file are as they were.
    expect(await all(env.DB, `SELECT id FROM chat_artifacts WHERE thread_id = ?`, other.threadId)).toHaveLength(1);
    expect(await inR2(other.attachments[0].sha256)).toBe(true);
  });

  it("a saved answer is not an attachment: deleting its thread keeps it", async () => {
    const cookie = await cookieFor(ME);
    const ctx = await tenantCtx(ME);
    const up = await upload(cookie, [{ name: "x.png", bytes: png(80) }]);
    const saved = await createPage(ctx, { title: "Saved answer", kind: "markdown", area: "data", repo: "", visibility: "private", content: "# answer" }, ME);
    await run(env.DB, `INSERT INTO chat_artifacts (org_id, thread_id, artifact_id, role, message_id, created_at) VALUES (?, ?, ?, 'saved', NULL, '2026-10-15')`, ORG_A, up.threadId, saved.id);
    expect((await call("DELETE", `${BASE}/ask/threads/${up.threadId}`, cookie)).status).toBe(200);
    expect(await pageOf(saved.slug)).not.toBeNull();
    expect(await pageOf(up.attachments[0].slug)).toBeNull();
  });

  it("someone else's thread is the one not_found, and nothing of theirs is touched", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "mine.png", bytes: png(90) }]);
    const other = await cookieFor("ask-stranger");
    expect((await call("DELETE", `${BASE}/ask/threads/${up.threadId}`, other)).status).toBe(404);
    expect(await pageOf(up.attachments[0].slug)).not.toBeNull();
    expect(await inR2(up.attachments[0].sha256)).toBe(true);
  });
});

describe("deleting an account deletes the person's PRIVATE Ask attachments", () => {
  it("their private attachments (rows and bytes) go even when referenced; a published one stays; another person's stay", async () => {
    const cookie = await cookieFor(ME);
    const ctx = await tenantCtx(ME);
    const up = await upload(cookie, [{ name: "private.png", bytes: png(100) }, { name: "referenced.png", bytes: png(110) }, { name: "public.png", bytes: png(120) }]);
    const [priv, referenced, pub] = up.attachments;
    const n = await create_ticket(ctx, { title: "Refers", body: "", category: "bug", priority: "normal", assignees: [ME] }, ME);
    await addLink(ctx, referenced.slug, { target_type: "ticket", target_ref: String(n) }, ME);
    await patchPage(ctx, pub.slug, { visibility: "org" }, ME);
    const keeper = await cookieFor("ask-keeper-2");
    const theirs = (await upload(keeper, [{ name: "theirs.png", bytes: png(130) }])).attachments[0];
    const ids = { priv: (await pageOf(priv.slug))!.id, referenced: (await pageOf(referenced.slug))!.id };

    await deleteAccount(env as unknown as Env, platformCtx(), ME, { by: "self", actor: ME });

    for (const [a, id] of [[priv, ids.priv], [referenced, ids.referenced]] as const) {
      expect(await rowsOf(a.slug, id), a.slug).toEqual({ page: false, versions: 0, links: 0, fts: 0 });
      expect(await inR2(a.sha256), a.slug).toBe(false);
    }
    // Published to the org: it stays, its author now the tombstone.
    const kept = await first<{ author_id: string; visibility: string }>(env.DB, `SELECT author_id, visibility FROM artifact_pages WHERE org_id = ? AND slug = ?`, ORG_A, pub.slug);
    expect(kept).toMatchObject({ visibility: "org" });
    expect(kept!.author_id).toMatch(/^deleted-/);
    expect(await inR2(pub.sha256)).toBe(true);
    expect(await pageOf(theirs.slug)).not.toBeNull();
    expect(await inR2(theirs.sha256)).toBe(true);
  });
});

describe("deleting an organization takes its Ask attachments with every other artifact", () => {
  it("the org's batch deletes the attachment rows and frees the bytes nothing else holds", async () => {
    const { deleteOrganization, orgForDeletion } = await import("../src/deletion/org");
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "org.png", bytes: png(140) }]);
    const att = up.attachments[0];
    const org = await orgForDeletion(platformCtx(), { id: ORG_A });
    await deleteOrganization(env as unknown as Env, platformCtx("AndresL230"), org!, { by: "platform", actor: "AndresL230", billingSettled: true });
    expect(await all(env.DB, `SELECT id FROM artifact_pages WHERE org_id = ?`, ORG_A)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_artifacts WHERE org_id = ?`, ORG_A)).toEqual([]);
    expect(await inR2(att.sha256)).toBe(false);
  });
});
