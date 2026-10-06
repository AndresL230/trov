// Cross-tenant isolation for the library (canopy-multitenancy.md §10.2): artifacts, doc images,
// prompts and handoffs. Every case writes under one org and reads / writes from the other, through
// the repositories with a context per org and — where a route or a token is the boundary — through
// the real Worker entry with a member of each org. The rule throughout: a row of the other org is
// ABSENT (the one not_found, an empty list, null), never forbidden, and nothing of it changes.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { all, first, run } from "./helpers/db";
import {
  ArtifactError, addBinaryVersion, addLink, addTextVersion, consumeUploadToken, createPage, deletePage, getPage,
  getVersionPair, listPages, mintUploadToken, patchPage, ratify, readRaw, readRawByPageId, removeLink, restorePage,
  searchArtifacts, sha256Hex, uniqueSlug, versionFilename, writablePageKind,
} from "../src/tools/artifacts";
import { agentArtifactGet, agentArtifactList, artifactsForTicket } from "../src/tools/artifacts-agent";
import { mintDownloadToken } from "../src/artifacts/download";
import { consumeDocImageToken, docImageProblems, mintDocImageUpload, readDocImage } from "../src/tools/doc-images";
import {
  PromptError, deletePrompt, getPrompt, listPromptVersions, listPrompts, publishPrompt, recordPromptUse, restorePrompt,
  savePrompt, setPromptTags,
} from "../src/tools/prompts";
import {
  HandoffError, claimHandoff, createHandoff, expireHandoff, getHandoff, listHandoffs,
} from "../src/tools/handoffs";
import { cookieFor } from "./helpers/persons";
import { ensureMember, platformCtx, systemCtx, ORG_A, ORG_B } from "./helpers/tenant";
import { expireDueHandoffs } from "../src/platform/sweeps";

const A = () => systemCtx(ORG_A);
const B = () => systemCtx(ORG_B);
const BUCKET = () => env.ARTIFACTS_BUCKET;
const SECRET = "test-cookie-secret"; // COOKIE_SECRET in vitest.config.ts
const ORIGIN = "https://trov.test";
const NOT_FOUND = JSON.stringify({ error: "not_found" });

const ANN = "iso-ann"; // acts in org A
const BOB = "iso-bob"; // acts in org B

const exec = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;
const wf = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env, exec);

/** Session cookies for a member of A only and a member of B only (the routes resolve the caller's one org). */
async function cookies(): Promise<{ ann: string; bob: string }> {
  const ann = await cookieFor(ANN);
  const bob = await cookieFor(BOB, { member: false });
  await ensureMember(BOB, "member", ORG_B);
  return { ann, bob };
}

const artifactNotFound = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ArtifactError);
  expect((e as ArtifactError).code).toBe("not_found");
};
const promptNotFound = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(PromptError);
  expect((e as PromptError).code).toBe("not_found");
};
const handoffNotFound = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(HandoffError);
  expect((e as HandoffError).code).toBe("not_found");
};

const text = (o: Record<string, unknown> = {}) =>
  ({ title: "Auth flow", kind: "markdown" as const, area: "auth" as const, content: "# Auth\n\nquokka tokens", ...o });

/** Bytes no other test (or org) has stored: R2 is not reset between tests. */
function bytes(tag: string): Uint8Array {
  return new TextEncoder().encode(`\x89PNG\r\n\x1a\n${tag}:${crypto.randomUUID()}:${"x".repeat(48)}`);
}
const stream = (b: Uint8Array) => new Response(b).body!;

const pageRow = (id: number) =>
  first<{ org_id: string; title: string; status: string; visibility: string; current_version: number; deleted_at: string | null }>(
    env.DB, `SELECT org_id, title, status, visibility, current_version, deleted_at FROM artifact_pages WHERE id = ?`, id);

// ── artifacts ────────────────────────────────────────────────────────────────

describe("artifacts — text pages and versions", () => {
  it("a page written in A is absent from every read in B, by slug and by id", async () => {
    const a = await createPage(A(), text(), ANN);
    await addTextVersion(A(), a.slug, { content: "# Auth v2", summary: "second" }, ANN);

    expect(await listPages(B(), {}, BOB)).toEqual([]);
    expect(await listPages(B(), {}, ANN)).toEqual([]); // the same handle in another org sees nothing either
    await artifactNotFound(getPage(B(), a.slug, null, BOB));
    await artifactNotFound(getPage(B(), a.slug, 1, BOB));
    await artifactNotFound(getVersionPair(B(), a.slug, 1, 2, BOB));
    await artifactNotFound(readRaw(B(), BUCKET(), a.slug, null, BOB));
    await artifactNotFound(readRawByPageId(B(), BUCKET(), a.id, 1, BOB));
    await artifactNotFound(writablePageKind(B(), a.slug, BOB));
    expect(await versionFilename(B(), a.id, 1)).toBeNull();

    expect((await listPages(A(), {}, ANN)).map((p) => p.slug)).toEqual([a.slug]);
    expect((await getVersionPair(A(), a.slug, 1, 2, ANN)).b.content).toBe("# Auth v2");
  });

  it("a slug is per org: the same title makes the same slug in each, and each page keeps its own content", async () => {
    const a = await createPage(A(), text({ content: "from A" }), ANN);
    expect(await uniqueSlug(B(), "Auth flow")).toBe(a.slug); // A's page does not reserve it in B
    const b = await createPage(B(), text({ content: "from B" }), BOB);
    expect(b.slug).toBe(a.slug);
    expect(b.id).not.toBe(a.id);

    await addTextVersion(B(), b.slug, { content: "from B, again" }, BOB);
    expect((await getPage(A(), a.slug, null, ANN)).content).toBe("from A");
    expect((await getPage(A(), a.slug, null, ANN)).current_version).toBe(1);
    expect((await getPage(B(), b.slug, null, BOB)).content).toBe("from B, again");
    expect((await readRaw(A(), BUCKET(), a.slug, null, ANN)).text).toBe("from A");
    expect(await uniqueSlug(A(), "Auth flow")).toBe(`${a.slug}-2`);

    // A's id is not B's page, even though B has a page under the same slug
    await artifactNotFound(readRawByPageId(B(), BUCKET(), a.id, 1, BOB));
    expect((await readRawByPageId(B(), BUCKET(), b.id, 1, BOB)).text).toBe("from B");
  });

  it("the rows of a new page attach to the writer's page when the other org already holds the slug", async () => {
    const link = { target_type: "pr" as const, target_ref: "o/r#3" };
    const b = await createPage(B(), text({ title: "Second", content: "B first", links: [link] }), BOB);
    const a = await createPage(A(), text({ title: "Second", content: "A second", links: [link] }), ANN);
    expect(a.slug).toBe(b.slug);
    for (const [page, org] of [[a, ORG_A], [b, ORG_B]] as const) {
      for (const table of ["artifact_versions", "artifact_links"]) {
        expect(await all(env.DB, `SELECT org_id FROM ${table} WHERE page_id = ?`, page.id), `${table} ${org}`).toEqual([{ org_id: org }]);
      }
      expect(await all(env.DB, `SELECT org_id FROM artifacts_fts WHERE page_id = ?`, String(page.id))).toEqual([{ org_id: org }]);
    }
    expect((await getPage(A(), a.slug, null, ANN)).content).toBe("A second");
    expect((await getPage(B(), b.slug, null, BOB)).content).toBe("B first");

    // an upload ticket for the shared slug names the caller's page
    const png = bytes("shared-slug");
    const shot = { title: "Shot", kind: "image" as const, area: "ui" as const, repo: "", visibility: "org" as const, size_bytes: png.byteLength, sha256: await sha256Hex(png), content_type: "image/png" };
    const pendB = await mintUploadToken(B(), shot, BOB);
    const pendA = await mintUploadToken(A(), shot, ANN);
    expect(pendA.slug).toBe(pendB.slug);
    expect(pendA.id).not.toBe(pendB.id);
    expect((await pageRow(pendA.id))!.org_id).toBe(ORG_A);
    expect(await all(env.DB, `SELECT org_id FROM artifact_upload_tokens WHERE page_id = ?`, pendA.id)).toEqual([{ org_id: ORG_A }]);
    const again = await mintUploadToken(A(), { slug: pendA.slug, kind: "image", size_bytes: png.byteLength, sha256: shot.sha256, content_type: "image/png" }, ANN);
    expect(again.id).toBe(pendA.id);
    expect((await consumeUploadToken(A(), BUCKET(), again.token, stream(png))).page.id).toBe(pendA.id);
    expect((await pageRow(pendB.id))!.current_version).toBe(0);
  });

  it("no write from B reaches A's page: every one is the one not_found and the row is untouched", async () => {
    const a = await createPage(A(), text({ title: "Only in A" }), ANN);
    await patchPage(A(), a.slug, { status: "published" }, ANN);
    const before = await pageRow(a.id);

    await artifactNotFound(addTextVersion(B(), a.slug, { content: "hijack" }, BOB));
    await artifactNotFound(addBinaryVersion(B(), BUCKET(), a.slug, { bytes: bytes("hijack") }, BOB));
    await artifactNotFound(patchPage(B(), a.slug, { title: "Renamed from B", visibility: "private" }, BOB));
    await artifactNotFound(ratify(B(), a.slug, 1, BOB));
    await artifactNotFound(addLink(B(), a.slug, { target_type: "pr", target_ref: "o/r#1" }, BOB));
    await artifactNotFound(removeLink(B(), a.slug, { target_type: "pr", target_ref: "o/r#1" }, BOB));
    await artifactNotFound(deletePage(B(), a.slug, BOB, true)); // an admin of B is nobody in A
    await artifactNotFound(mintUploadToken(B(), { slug: a.slug, kind: "image", size_bytes: 10, sha256: "a".repeat(64), content_type: "image/png" }, BOB));
    // the author's own handle, acting in B
    await artifactNotFound(addTextVersion(B(), a.slug, { content: "hijack" }, ANN));
    await artifactNotFound(deletePage(B(), a.slug, ANN, false));

    expect(await pageRow(a.id)).toEqual(before);
    expect(await all(env.DB, `SELECT 1 FROM artifact_versions WHERE org_id = ?`, ORG_B)).toEqual([]);

    // a deleted page of A cannot be restored from B, and stays deleted
    await deletePage(A(), a.slug, ANN, false);
    await artifactNotFound(restorePage(B(), a.slug, BOB, true));
    await artifactNotFound(restorePage(B(), a.slug, ANN, false));
    expect((await pageRow(a.id))!.deleted_at).not.toBeNull();
  });

  it("a private page is its author's alone, inside its org only", async () => {
    const a = await createPage(A(), text({ title: "Private notes", visibility: "private" }), ANN);
    expect((await getPage(A(), a.slug, null, ANN)).visibility).toBe("private");
    await artifactNotFound(getPage(A(), a.slug, null, "iso-carl")); // another member of A
    await artifactNotFound(getPage(B(), a.slug, null, ANN));        // the author, in another org
    await artifactNotFound(getPage(B(), a.slug, null, BOB));
    expect(await listPages(B(), {}, ANN)).toEqual([]);
    expect(await searchArtifacts(B(), "quokka", ANN)).toEqual([]);
  });

  it("every row a page write makes carries the writer's org", async () => {
    const b = await createPage(B(), text({ links: [{ target_type: "pr", target_ref: "o/r#7" }] }), BOB);
    await addTextVersion(B(), b.slug, { content: "v2" }, BOB);
    await addLink(B(), b.slug, { target_type: "issue", target_ref: "o/r#8" }, BOB);
    await mintUploadToken(B(), { title: "Pending", kind: "file", area: "data", repo: "", visibility: "org", size_bytes: 4, sha256: "b".repeat(64) }, BOB);
    for (const table of ["artifact_pages", "artifact_versions", "artifact_links", "artifact_upload_tokens", "artifacts_fts"]) {
      const orgs = await all<{ org_id: string }>(env.DB, `SELECT DISTINCT org_id FROM ${table}`);
      expect(orgs, table).toEqual([{ org_id: ORG_B }]);
    }
  });
});

describe("artifacts — links", () => {
  it("a ticket or sprint of the other org does not exist for a link, and never resolves a label", async () => {
    await run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, 'A-only ticket', 'meilin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, ORG_A);
    await run(env.DB, `INSERT INTO sprints (org_id, title, target_date, status, created_at, created_by, updated_at) VALUES (?, 'A-only sprint', '2026-09-01', 'upcoming', '2026-01-01T00:00:00Z', 'meilin', '2026-01-01T00:00:00Z')`, ORG_A);
    const ticketId = (await first<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE title = 'A-only ticket'`))!.id;
    const sprintId = (await first<{ id: number }>(env.DB, `SELECT id FROM sprints WHERE title = 'A-only sprint'`))!.id;

    const a = await createPage(A(), text({ links: [{ target_type: "ticket", target_ref: String(ticketId) }] }), ANN);
    expect(a.links[0].label).toBe("A-only ticket");
    const b = await createPage(B(), text(), BOB);

    for (const link of [{ target_type: "ticket" as const, target_ref: String(ticketId) }, { target_type: "sprint" as const, target_ref: String(sprintId) }]) {
      const e = await addLink(B(), b.slug, link, BOB).then(() => null, (x: unknown) => x);
      expect((e as ArtifactError).code).toBe("bad_request"); // the answer for an id that does not exist
      expect((e as ArtifactError).message).toBe(`no such ${link.target_type}: ${link.target_ref}`);
    }
    expect((await getPage(B(), b.slug, null, BOB)).links).toEqual([]);

    // the per-ticket listing is the org's own
    expect((await listPages(A(), { ticket: String(ticketId) }, ANN)).map((p) => p.id)).toEqual([a.id]);
    expect(await listPages(B(), { ticket: String(ticketId) }, BOB)).toEqual([]);
    expect(await artifactsForTicket(B(), ticketId, BOB)).toEqual([]);

    // a stale cross-org link row (written before the ids were org-checked) resolves no label
    await run(env.DB, `INSERT INTO artifact_links (org_id, page_id, target_type, target_ref, created_by, created_at) VALUES (?, ?, 'ticket', ?, 'x', '2026-01-01T00:00:00Z')`, ORG_B, b.id, String(ticketId));
    await run(env.DB, `INSERT INTO artifact_links (org_id, page_id, target_type, target_ref, created_by, created_at) VALUES (?, ?, 'sprint', ?, 'x', '2026-01-02T00:00:00Z')`, ORG_B, b.id, String(sprintId));
    expect((await getPage(B(), b.slug, null, BOB)).links).toEqual([
      { target_type: "ticket", target_ref: String(ticketId), label: null, meta: null },
      { target_type: "sprint", target_ref: String(sprintId), label: null, meta: null },
    ]);
  });
});

describe("artifacts — search", () => {
  it("FTS and the library filter return only the caller's org, in both directions", async () => {
    const a = await createPage(A(), text({ title: "Wombat design", content: "the wombat burrow plan" }), ANN);
    expect((await searchArtifacts(A(), "wombat", ANN)).map((h) => h.id)).toEqual([a.id]);
    expect(await searchArtifacts(B(), "wombat", BOB)).toEqual([]);
    expect(await listPages(B(), { q: "wombat" }, BOB)).toEqual([]);
    expect(await listPages(B(), { q: "burrow" }, BOB)).toEqual([]); // body-only match, through the FTS subquery

    const b = await createPage(B(), text({ title: "Wombat notes", content: "another wombat burrow" }), BOB);
    expect((await searchArtifacts(B(), "wombat", BOB)).map((h) => h.id)).toEqual([b.id]);
    expect((await searchArtifacts(A(), "wombat", ANN)).map((h) => h.id)).toEqual([a.id]);
    expect((await listPages(A(), { q: "burrow" }, ANN)).map((p) => p.id)).toEqual([a.id]);
    expect((await listPages(B(), { q: "burrow" }, BOB)).map((p) => p.id)).toEqual([b.id]);

    // B's writes maintain B's index rows only
    await patchPage(B(), b.slug, { title: "Renamed" }, BOB);
    await deletePage(B(), b.slug, BOB, false);
    expect(await searchArtifacts(B(), "wombat", BOB)).toEqual([]);
    expect((await searchArtifacts(A(), "wombat", ANN)).map((h) => h.title)).toEqual(["Wombat design"]);
  });

  it("the agent list and get are bound to the caller's org", async () => {
    const a = await createPage(A(), text(), ANN);
    const agentB = { tenant: B(), handle: BOB, origin: ORIGIN, downloadSecret: SECRET };
    expect((await agentArtifactList(agentB)).artifacts).toEqual([]);
    await artifactNotFound(agentArtifactGet(agentB, { slug: a.slug }));
    const agentA = { tenant: A(), handle: ANN, origin: ORIGIN, downloadSecret: SECRET };
    expect((await agentArtifactGet(agentA, { slug: a.slug })).slug).toBe(a.slug);
  });
});

describe("artifacts — binary pages, upload and download tokens, raw serving", () => {
  it("a binary page of A cannot be read from B; B gets the bytes only by sending them", async () => {
    const png = bytes("binary");
    const sha = await sha256Hex(png);
    const a = await createPage(A(), { title: "Logo", kind: "image", area: "ui", bytes: png, content_type: "image/png", filename: "logo.png" }, ANN, BUCKET());
    await artifactNotFound(readRaw(B(), BUCKET(), a.slug, null, BOB));
    await artifactNotFound(readRawByPageId(B(), BUCKET(), a.id, 1, BOB));
    expect(await versionFilename(B(), a.id, 1)).toBeNull();

    // declaring A's hash in B attaches nothing: the token's page stays pending until the bytes arrive
    const mint = await mintUploadToken(B(), { title: "Logo", kind: "image", area: "ui", repo: "", visibility: "org", size_bytes: png.byteLength, sha256: sha, content_type: "image/png" }, BOB);
    await artifactNotFound(getPage(B(), mint.slug, null, BOB));
    const wrong = await consumeUploadToken(B(), BUCKET(), mint.token, stream(bytes("not-the-logo"))).then(() => null, (x: unknown) => x);
    expect((wrong as ArtifactError).code).toBe("bad_request");
    await artifactNotFound(getPage(B(), mint.slug, null, BOB));

    await consumeUploadToken(B(), BUCKET(), mint.token, stream(png));
    const raw = await readRaw(B(), BUCKET(), mint.slug, null, BOB);
    expect(new Uint8Array(await new Response(raw.object!.body).arrayBuffer())).toEqual(png);
    expect((await getPage(A(), a.slug, null, ANN)).current_version).toBe(1);
  });

  it("an upload token resolves only in the org that minted it, and survives the other org's attempt", async () => {
    const png = bytes("token");
    const input = { title: "Shot", kind: "image" as const, area: "ui" as const, repo: "", visibility: "org" as const, size_bytes: png.byteLength, sha256: await sha256Hex(png), content_type: "image/png" };
    const mintA = await mintUploadToken(A(), input, ANN);
    await artifactNotFound(consumeUploadToken(B(), BUCKET(), mintA.token, stream(png)));
    expect(await first(env.DB, `SELECT used_at FROM artifact_upload_tokens WHERE org_id = ?`, ORG_A)).toEqual({ used_at: null });
    const landed = await consumeUploadToken(A(), BUCKET(), mintA.token, stream(png));
    expect(landed.version_no).toBe(1);

    const mintB = await mintUploadToken(B(), input, BOB);
    await artifactNotFound(consumeUploadToken(A(), BUCKET(), mintB.token, stream(png)));
    expect(await first(env.DB, `SELECT used_at FROM artifact_upload_tokens WHERE org_id = ?`, ORG_B)).toEqual({ used_at: null });
    // The PUT route has no session and acts on the legacy org until it resolves the org from the
    // token row: B's token is the unknown-token 404 there — never a write into A.
    const res = await wf(mintB.upload_url, { method: "PUT", body: png });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND);
    expect(await all(env.DB, `SELECT 1 FROM artifact_versions WHERE org_id = ?`, ORG_B)).toEqual([]);
    expect((await consumeUploadToken(B(), BUCKET(), mintB.token, stream(png))).version_no).toBe(1);
  });

  it("a signed download URL serves only a page of its holder's org", async () => {
    await cookies();
    const a = await createPage(A(), text({ content: "download me" }), ANN);
    const url = async (handle: string) =>
      `/api/artifacts/download/${(await mintDownloadToken(SECRET, { handle, page_id: a.id, version_no: 1 })).token}`;
    const ok = await wf(await url(ANN));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("download me");
    // a validly signed token for a member of B, naming A's page id
    const other = await wf(await url(BOB));
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(NOT_FOUND);
  });

  it("the routes: A's slug is the one 404 for a member of B — detail, raw, list, write", async () => {
    const { ann, bob } = await cookies();
    const a = await createPage(A(), text({ kind: "html", content: "<p>only A</p>" }), ANN);

    expect((await wf(`/raw/a/${a.slug}`, { headers: { cookie: ann } })).status).toBe(200);
    for (const path of [`/raw/a/${a.slug}`, `/raw/a/${a.slug}@v1`, `/raw/a/${a.slug}/v1`, `/api/artifacts/${a.slug}`, `/api/artifacts/${a.slug}/diff?a=1&b=1`]) {
      const res = await wf(path, { headers: { cookie: bob } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(NOT_FOUND);
    }
    const list = await wf(`/api/artifacts`, { headers: { cookie: bob } });
    expect(await list.json()).toEqual({ artifacts: [] });

    const json = (method: string, body: unknown) => ({ method, headers: { cookie: bob, "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const [path, init] of [
      [`/api/artifacts/${a.slug}`, json("PATCH", { title: "Taken over" })],
      [`/api/artifacts/${a.slug}/versions`, json("POST", { content: "<p>B</p>" })],
      [`/api/artifacts/${a.slug}/ratify`, json("POST", { version: 1 })],
      [`/api/artifacts/${a.slug}/delete`, json("POST", {})],
      [`/api/artifacts/${a.slug}/restore`, json("POST", {})],
    ] as const) {
      const res = await wf(path, init);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(NOT_FOUND);
    }
    expect((await getPage(A(), a.slug, null, ANN)).title).toBe("Auth flow");

    // and B's own page under the same slug is B's alone
    const made = await wf(`/api/artifacts`, json("POST", text({ content: "only B" })));
    expect(made.status).toBe(201);
    expect((await pageRow(((await made.json()) as { id: number }).id))!.org_id).toBe(ORG_B);
    expect(await (await wf(`/raw/a/${a.slug}`, { headers: { cookie: bob } })).text()).toBe("only B");
    expect(await (await wf(`/raw/a/${a.slug}?download=1`, { headers: { cookie: ann } })).text()).toBe("<p>only A</p>");
  });
});

// ── doc images ───────────────────────────────────────────────────────────────

describe("doc images", () => {
  async function uploadIn(ctx: ReturnType<typeof systemCtx>, who: string, b: Uint8Array) {
    const m = await mintDocImageUpload(ctx, { sha256: await sha256Hex(b), size_bytes: b.byteLength, content_type: "image/png" }, who);
    if (!m.uploaded) await consumeDocImageToken(ctx, BUCKET(), m.token, stream(b));
    return m;
  }

  it("an image uploaded in A is no image in B: no read, no doc reference, no shortcut around the bytes", async () => {
    const png = bytes("doc-image");
    const sha = await sha256Hex(png);
    const a = await uploadIn(A(), ANN, png);
    expect(a.uploaded).toBe(false);
    expect((await readDocImage(A(), BUCKET(), sha))!.size_bytes).toBe(png.byteLength);
    expect(await docImageProblems(A(), `![x](/img/${sha})`)).toBeNull();

    expect(await readDocImage(B(), BUCKET(), sha)).toBeNull();
    expect(await docImageProblems(B(), `![x](/img/${sha})`)).toContain("not uploaded yet");
    // B is asked for the bytes even though the object exists
    const mint = await mintDocImageUpload(B(), { sha256: sha, size_bytes: png.byteLength, content_type: "image/png" }, BOB);
    expect(mint.uploaded).toBe(false);
    expect(await readDocImage(B(), BUCKET(), sha)).toBeNull();
    expect(await all(env.DB, `SELECT org_id FROM doc_images WHERE sha256 = ?`, sha)).toEqual([{ org_id: ORG_A }]);

    // once B sends them, each org has its own row
    if (!mint.uploaded) await consumeDocImageToken(B(), BUCKET(), mint.token, stream(png));
    expect((await readDocImage(B(), BUCKET(), sha))!.content_type).toBe("image/png");
    expect((await all<{ org_id: string }>(env.DB, `SELECT org_id FROM doc_images WHERE sha256 = ? ORDER BY org_id`, sha)).map((r) => r.org_id)).toEqual([ORG_B, ORG_A].sort());
    expect((await mintDocImageUpload(B(), { sha256: sha, size_bytes: png.byteLength, content_type: "image/png" }, BOB)).uploaded).toBe(true);
  });

  it("a doc-image token is no token in the other org, and stays usable in its own", async () => {
    const png = bytes("doc-token");
    const sha = await sha256Hex(png);
    const mint = await mintDocImageUpload(A(), { sha256: sha, size_bytes: png.byteLength, content_type: "image/png" }, ANN);
    if (mint.uploaded) throw new Error("expected a token");
    expect(await consumeDocImageToken(B(), BUCKET(), mint.token, stream(png))).toBeNull(); // "not a doc-image token"
    await artifactNotFound(consumeUploadToken(B(), BUCKET(), mint.token, stream(png)));    // …nor an artifact one
    expect(await all(env.DB, `SELECT 1 FROM doc_images WHERE sha256 = ?`, sha)).toEqual([]);
    expect((await consumeDocImageToken(A(), BUCKET(), mint.token, stream(png)))!.sha256).toBe(sha);
    expect(await all(env.DB, `SELECT org_id FROM doc_image_upload_tokens`)).toEqual([{ org_id: ORG_A }]);
  });

  it("GET /img/<sha>: 200 for a member of the image's org, the plain 404 for a member of the other", async () => {
    const { ann, bob } = await cookies();
    const png = bytes("doc-route");
    const sha = await sha256Hex(png);
    await uploadIn(A(), ANN, png);
    const mine = await wf(`/img/${sha}`, { headers: { cookie: ann } });
    expect(mine.status).toBe(200);
    expect(new Uint8Array(await mine.arrayBuffer())).toEqual(png);
    const theirs = await wf(`/img/${sha}`, { headers: { cookie: bob } });
    const unknown = await wf(`/img/${"0".repeat(64)}`, { headers: { cookie: bob } });
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toBe(await unknown.text());
  });
});

// ── prompts ──────────────────────────────────────────────────────────────────

describe("prompts", () => {
  const input = (o: Record<string, unknown> = {}) =>
    ({ slug: "sse-review", title: "SSE review", body: "Review the axolotl stream handler.", tags: ["review"], status: "published" as const, ...o });

  it("a prompt of A is absent from B: get, list, search, versions, use", async () => {
    await savePrompt(A(), ANN, input(), "human");
    await savePrompt(A(), ANN, input({ body: "Review the axolotl stream handler, twice." }), "human");

    expect(await getPrompt(B(), "sse-review")).toBeNull();
    expect(await listPrompts(B())).toEqual([]);
    expect(await listPrompts(B(), { q: "axolotl" })).toEqual([]);
    expect(await listPrompts(B(), { tags: ["review"] })).toEqual([]);
    expect(await listPromptVersions(B(), "sse-review")).toEqual([]);
    expect(await recordPromptUse(B(), "sse-review")).toBe(false);

    expect((await listPrompts(A(), { q: "axolotl" })).map((p) => p.slug)).toEqual(["sse-review"]);
    expect((await listPromptVersions(A(), "sse-review")).map((v) => v.version)).toEqual([2, 1]);
    expect((await getPrompt(A(), "sse-review"))!.use_count).toBe(0);
  });

  it("the same slug in each org is two prompts with their own versions, uses and search rows", async () => {
    await savePrompt(A(), ANN, input(), "human");
    await savePrompt(A(), ANN, input({ body: "A's second version" }), "human");
    const b = await savePrompt(B(), BOB, input({ body: "B's own axolotl prompt" }), "human");
    expect(b.version).toBe(1); // a new prompt in B, not version 3 of A's
    expect(b.author).toBe(BOB);

    await recordPromptUse(B(), "sse-review");
    expect((await getPrompt(B(), "sse-review"))!.use_count).toBe(1);
    expect((await getPrompt(A(), "sse-review"))!.use_count).toBe(0);
    expect((await getPrompt(A(), "sse-review"))!.body).toBe("A's second version");
    expect((await listPrompts(B(), { q: "axolotl" })).map((p) => p.author)).toEqual([BOB]);
    expect(await listPrompts(A(), { q: "axolotl" })).toEqual([]); // A's current version no longer says it

    // a rename in B moves B's prompt and B's versions only
    await savePrompt(B(), BOB, input({ slug: "sse-review-b", base_slug: "sse-review", body: "renamed" }), "human");
    expect(await getPrompt(B(), "sse-review")).toBeNull();
    expect((await listPromptVersions(B(), "sse-review-b")).map((v) => v.version)).toEqual([2, 1]);
    expect((await listPromptVersions(A(), "sse-review")).map((v) => v.version)).toEqual([2, 1]);
    expect(await getPrompt(A(), "sse-review-b")).toBeNull();
  });

  it("no write from B reaches A's prompt: not_found, and nothing changes", async () => {
    await savePrompt(A(), ANN, input({ status: "staged" }), "human");
    const before = await all(env.DB, `SELECT * FROM prompts`);
    const versionsBefore = await all(env.DB, `SELECT * FROM prompt_versions`);

    await promptNotFound(setPromptTags(B(), "sse-review", ["taken"]));
    await promptNotFound(publishPrompt(B(), "sse-review", 1));
    await promptNotFound(deletePrompt(B(), "sse-review", BOB, true)); // an admin of B
    await promptNotFound(deletePrompt(B(), "sse-review", ANN, false)); // the author's handle, in B
    await promptNotFound(restorePrompt(B(), "sse-review", BOB, true));
    await promptNotFound(savePrompt(B(), BOB, input({ slug: "mine-now", base_slug: "sse-review" }), "human"));

    expect(await all(env.DB, `SELECT * FROM prompts`)).toEqual(before);
    expect(await all(env.DB, `SELECT * FROM prompt_versions`)).toEqual(versionsBefore);

    // a deleted prompt of A reserves its slug in A only, and B cannot restore it
    await deletePrompt(A(), "sse-review", ANN, false);
    await promptNotFound(restorePrompt(B(), "sse-review", BOB, true));
    expect((await savePrompt(B(), BOB, input(), "human")).version).toBe(1);
    await deletePrompt(B(), "sse-review", BOB, false);
    expect((await restorePrompt(A(), "sse-review", ANN, false)).author).toBe(ANN);
    expect(await getPrompt(B(), "sse-review")).toBeNull(); // A's restore did not bring B's back
  });

  it("with the slug held in both orgs, each writer changes its own prompt only", async () => {
    await savePrompt(A(), ANN, input({ status: "staged" }), "human");
    await savePrompt(B(), BOB, input({ status: "staged" }), "human");
    const rowA = () => first(env.DB, `SELECT * FROM prompts WHERE org_id = ? AND slug = 'sse-review'`, ORG_A);
    const versionsA = () => all(env.DB, `SELECT * FROM prompt_versions WHERE org_id = ? ORDER BY slug, version`, ORG_A);
    const before = { row: await rowA(), versions: await versionsA() };

    await publishPrompt(B(), "sse-review", 1);
    await setPromptTags(B(), "sse-review", ["b-only"]);
    await savePrompt(B(), BOB, input({ title: "B's title", body: "B v2", description: "B's" }), "human");
    await recordPromptUse(B(), "sse-review");
    expect({ row: await rowA(), versions: await versionsA() }).toEqual(before);
    expect((await getPrompt(B(), "sse-review"))!.version).toBe(2);

    // a slug another org holds is free to rename onto
    await savePrompt(A(), ANN, { slug: "held-by-a", title: "Held", body: "x" }, "human");
    expect((await savePrompt(B(), BOB, input({ slug: "held-by-a", base_slug: "sse-review" }), "human")).slug).toBe("held-by-a");
    expect((await getPrompt(A(), "held-by-a"))!.author).toBe(ANN);
    await savePrompt(B(), BOB, input({ slug: "sse-review", base_slug: "held-by-a" }), "human");

    // each author deletes their own — the other org's, by another author, is neither consulted nor touched
    expect((await deletePrompt(B(), "sse-review", BOB, false)).slug).toBe("sse-review");
    expect((await getPrompt(A(), "sse-review"))!.author).toBe(ANN);
    expect((await restorePrompt(B(), "sse-review", BOB, false)).author).toBe(BOB);
    expect(await deletePrompt(A(), "sse-review", ANN, false)).toEqual({ slug: "sse-review", title: "SSE review" });
    expect(await getPrompt(A(), "sse-review")).toBeNull();
    expect((await getPrompt(B(), "sse-review"))!.author).toBe(BOB);
  });

  it("the routes answer a member of B with the plain 404 for A's slug", async () => {
    const { ann, bob } = await cookies();
    await savePrompt(A(), ANN, input(), "human");
    expect((await wf(`/api/prompts/sse-review`, { headers: { cookie: ann } })).status).toBe(200);
    for (const path of [`/api/prompts/sse-review`, `/api/prompts/sse-review/versions`]) {
      expect((await wf(path, { headers: { cookie: bob } })).status, path).toBe(404);
    }
    expect(await (await wf(`/api/prompts`, { headers: { cookie: bob } })).json()).toEqual({ prompts: [] });
    expect((await wf(`/api/prompts/sse-review/used`, { method: "POST", headers: { cookie: bob } })).status).toBe(404);
    expect((await getPrompt(A(), "sse-review"))!.use_count).toBe(0);
  });
});

// ── handoffs ─────────────────────────────────────────────────────────────────

describe("handoffs", () => {
  const leave = (ctx: ReturnType<typeof systemCtx>, sender: string, body = "Pick up the narwhal migration") =>
    createHandoff(ctx, sender, { body }).then((r) => r.handoff);
  const statusOf = async (id: number) => (await first<{ status: string }>(env.DB, `SELECT status FROM handoffs WHERE id = ?`, id))!.status;

  it("a handoff of A is absent from B: get and every box, for any handle", async () => {
    const h = await leave(A(), ANN);
    expect((await getHandoff(A(), h.id))!.sender).toBe(ANN);
    expect(await getHandoff(B(), h.id)).toBeNull();
    for (const box of ["mine", "me", "anyone", "sent"] as const) {
      expect(await listHandoffs(B(), ANN, box), box).toEqual([]); // the sender's own handle, in B
      expect(await listHandoffs(B(), BOB, box), box).toEqual([]);
    }
    expect((await listHandoffs(A(), BOB, "anyone")).map((x) => x.id)).toEqual([h.id]);
    expect((await first<{ org_id: string }>(env.DB, `SELECT org_id FROM handoffs WHERE id = ?`, h.id))!.org_id).toBe(ORG_A);
  });

  it("claim and expire from B are not_found — also for an `anyone` handoff and for its sender's handle", async () => {
    const h = await leave(A(), ANN);
    await handoffNotFound(claimHandoff(B(), h.id, BOB, "sess-b"));
    await handoffNotFound(claimHandoff(B(), h.id, ANN, "sess-b"));
    await handoffNotFound(expireHandoff(B(), h.id, ANN));
    expect(await statusOf(h.id)).toBe("pending");

    expect((await claimHandoff(A(), h.id, "iso-carl", "sess-a")).claimed_by).toBe("iso-carl");
  });

  // The ONE deliberately cross-org statement here (§4.4): the cron's expiry sweep is a platform-level,
  // write-only retention sweep, so a single run covers every org — and only what is actually due.
  it("the expiry sweep is cross-org by design: one run expires every org's due handoffs, and nothing else", async () => {
    const a = await leave(A(), ANN);
    const b = await leave(B(), BOB);
    const p = platformCtx("system");
    expect(await expireDueHandoffs(p, Date.now())).toBe(0); // neither is due yet
    expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(["pending", "pending"]);
    await run(env.DB, `UPDATE handoffs SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, b.id);
    expect(await expireDueHandoffs(p, Date.now())).toBe(1); // B's is due, A's is not
    expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(["pending", "expired"]);
    expect(await expireDueHandoffs(p, Date.now() + 30 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await statusOf(a.id)).toBe("expired");
  });

  it("numbers are per org: each org counts its own handoffs from where it left off", async () => {
    const numberOf = async (id: number) => (await first<{ number: number }>(env.DB, `SELECT number FROM handoffs WHERE id = ?`, id))!.number;
    const a1 = await leave(A(), ANN);
    const b1 = await leave(B(), BOB);
    const b2 = await leave(B(), BOB);
    const a2 = await leave(A(), ANN);
    expect([await numberOf(b1.id), await numberOf(b2.id)]).toEqual([1, 2]); // B starts at 1 whatever A's ids are
    expect(await numberOf(a2.id)).toBe((await numberOf(a1.id)) + 1);       // A is not advanced by B's two
    expect(new Set([a1.id, b1.id, b2.id, a2.id]).size).toBe(4);
    expect(await all(env.DB, `SELECT org_id, value FROM org_counters WHERE name = 'handoff' AND org_id = ?`, ORG_B)).toEqual([{ org_id: ORG_B, value: 2 }]);
  });

  it("the replay ledger is per org: one session item writes one handoff in each", async () => {
    const ledger = { sessionId: "iso-session", itemIndex: 0 };
    const a = await createHandoff(A(), ANN, { body: "from A" }, ledger);
    const b = await createHandoff(B(), BOB, { body: "from B" }, ledger);
    expect(b.replayed).toBe(false);
    expect(b.handoff.id).not.toBe(a.handoff.id);
    const again = await createHandoff(B(), BOB, { body: "from B" }, ledger);
    expect(again).toEqual({ handoff: b.handoff, replayed: true });
    expect((await createHandoff(A(), ANN, { body: "from A" }, ledger)).handoff.id).toBe(a.handoff.id);
    expect(await all(env.DB, `SELECT org_id, ref FROM processed_items WHERE session_id = 'iso-session' ORDER BY org_id`))
      .toEqual([{ org_id: ORG_B, ref: String(b.handoff.id) }, { org_id: ORG_A, ref: String(a.handoff.id) }].sort((x, y) => x.org_id.localeCompare(y.org_id)));
  });

  it("the routes answer a member of B with 404 for A's handoff", async () => {
    const { ann, bob } = await cookies();
    const h = await leave(A(), ANN);
    expect((await wf(`/api/handoffs/${h.id}`, { headers: { cookie: ann } })).status).toBe(200);
    expect((await wf(`/api/handoffs/${h.id}`, { headers: { cookie: bob } })).status).toBe(404);
    for (const action of ["claim", "expire"]) {
      const res = await wf(`/api/handoffs/${h.id}/${action}`, { method: "POST", headers: { cookie: bob, "content-type": "application/json" }, body: "{}" });
      expect(res.status, action).toBe(404);
    }
    expect(await (await wf(`/api/handoffs?box=anyone`, { headers: { cookie: bob } })).json()).toEqual({ handoffs: [] });
    expect(await statusOf(h.id)).toBe("pending");
  });
});
