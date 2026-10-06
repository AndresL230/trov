// Artifacts — who can see and write what, end to end (issue #52 · Track E):
// 6. private-page 404 parity across every HTTP, raw, MCP, query and ticket surface —
//    and a SOFT-DELETED page (0035 PART D) is the same byte-identical not-found;
// 11. MCP permission checks for a second principal.
// Entry points: `worker.fetch` (src/index.ts) and the real /mcp endpoint with a bearer.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "./helpers/db";
import { create_ticket } from "../src/tools/tickets";
import type { ArtifactDetailDTO } from "@shared/artifacts";
import {
  MCP_NOT_FOUND, NOT_FOUND, cookieFor, createBinary, createText, get, jsonInit, mcpCall, mcpToolSchema, multipart,
  put, seedPerson, sha256Hex, uniqueBytes, uploadUrl, wf,
} from "./helpers/artifacts";

import { systemCtx } from "./helpers/tenant";
const OWNER = "acc-owner";
const OTHER = "acc-other";

async function seedTicket(): Promise<number> {
  await seedPerson(OWNER);
  return create_ticket(systemCtx(), { title: "Parity ticket", body: "", category: "other", priority: "normal", assignees: [] }, OWNER);
}

/**
 * Three pages OTHER must not be able to tell from a missing slug:
 *   `privtext` — OWNER's private markdown (v2, published, linked to the ticket);
 *   `privbin`  — OWNER's private image;
 *   `pendpage` — OWNER's org pdf whose upload never landed (current_version 0, linked).
 *   `delpage`  — OWNER's org markdown (linked), soft-DELETED by OWNER (0035 PART D).
 * `missing` does not exist. `orgpage` is a plain org page (the control).
 */
async function seedWorld() {
  const owner = await cookieFor(OWNER);
  const other = await cookieFor(OTHER);
  const tid = await seedTicket();
  await createText(owner, { title: "Privtext", content: "okapi secret words", visibility: "private", summary: "okapi", links: [{ target_type: "ticket", target_ref: String(tid) }] });
  await wf("/api/artifacts/privtext/versions", jsonInit("POST", { content: "okapi secret words v2" }, owner));
  await createBinary(owner, { title: "Privbin", kind: "image", area: "ui", visibility: "private", summary: "okapi" }, { bytes: uniqueBytes("privbin"), name: "p.png", type: "image/png" });
  const pend = await uploadUrl(owner, { kind: "pdf", size_bytes: 10, sha256: "a".repeat(64), title: "Pendpage", area: "api", summary: "okapi", links: [{ target_type: "ticket", target_ref: String(tid) }] });
  expect(pend.status).toBe(201);
  await createText(owner, { title: "Orgpage", content: "okapi public words", links: [{ target_type: "ticket", target_ref: String(tid) }] });
  await createText(owner, { title: "Delpage", content: "okapi deleted words", summary: "okapi", links: [{ target_type: "ticket", target_ref: String(tid) }] });
  expect((await wf("/api/artifacts/delpage/delete", jsonInit("POST", {}, owner))).status).toBe(200);
  return { owner, other, tid };
}

const HIDDEN = ["privtext", "privbin", "pendpage", "delpage"] as const;

/** Every read/write probe of one slug, as a list of [label, request]. */
function httpProbes(slug: string, cookie: string): [string, () => Promise<Response>][] {
  const png = uniqueBytes("probe");
  return [
    ["GET", () => get(`/api/artifacts/${slug}`, cookie)],
    ["GET ?v=1", () => get(`/api/artifacts/${slug}?v=1`, cookie)],
    ["GET @v1", () => get(`/api/artifacts/${slug}@v1`, cookie)],
    ["GET /v1", () => get(`/api/artifacts/${slug}/v1`, cookie)],
    ["GET @v2", () => get(`/api/artifacts/${slug}@v2`, cookie)],
    ["diff", () => get(`/api/artifacts/${slug}/diff?a=1&b=1`, cookie)],
    ["PATCH title", () => wf(`/api/artifacts/${slug}`, jsonInit("PATCH", { title: "Mine now" }, cookie))],
    ["PATCH status", () => wf(`/api/artifacts/${slug}`, jsonInit("PATCH", { status: "published" }, cookie))],
    ["PATCH private", () => wf(`/api/artifacts/${slug}`, jsonInit("PATCH", { visibility: "private" }, cookie))],
    ["PATCH org", () => wf(`/api/artifacts/${slug}`, jsonInit("PATCH", { visibility: "org" }, cookie))],
    ["versions text", () => wf(`/api/artifacts/${slug}/versions`, jsonInit("POST", { content: "x" }, cookie))],
    ["versions edit", () => wf(`/api/artifacts/${slug}/versions`, jsonInit("POST", { old_str: "okapi", new_str: "x" }, cookie))],
    ["versions multipart", () => wf(`/api/artifacts/${slug}/versions`, { method: "POST", headers: { cookie }, body: multipart({ summary: "s" }, { bytes: png, name: "a.png", type: "image/png" }) })],
    ["links add", () => wf(`/api/artifacts/${slug}/links`, jsonInit("POST", { target_type: "pr", target_ref: "o/r#1" }, cookie))],
    ["links remove", () => wf(`/api/artifacts/${slug}/links/remove`, jsonInit("POST", { target_type: "pr", target_ref: "o/r#1" }, cookie))],
    ["ratify", () => wf(`/api/artifacts/${slug}/ratify`, jsonInit("POST", { version: 1 }, cookie))],
    ["delete", () => wf(`/api/artifacts/${slug}/delete`, jsonInit("POST", {}, cookie))],
    ["restore", () => wf(`/api/artifacts/${slug}/restore`, jsonInit("POST", {}, cookie))],
    ["upload-url", () => wf("/api/artifacts/upload-url", jsonInit("POST", { slug, kind: "image", size_bytes: 3, sha256: "b".repeat(64), content_type: "image/png" }, cookie))],
    ["upload-url pdf", () => wf("/api/artifacts/upload-url", jsonInit("POST", { slug, kind: "pdf", size_bytes: 3, sha256: "b".repeat(64) }, cookie))],
    ["raw", () => get(`/raw/a/${slug}`, cookie)],
    ["raw @v1", () => get(`/raw/a/${slug}@v1`, cookie)],
    ["raw /v1", () => get(`/raw/a/${slug}/v1`, cookie)],
    ["raw download", () => get(`/raw/a/${slug}@v1?download=1`, cookie)],
  ];
}

const snapshot = async (res: Response) => ({
  status: res.status,
  body: await res.text(),
  type: res.headers.get("content-type"),
  csp: res.headers.get("content-security-policy"),
});

// ── 6. 404 parity ────────────────────────────────────────────────────────────

describe("6 · private / pending / missing — byte-identical everywhere", () => {
  it("HTTP API + raw: every probe of a hidden page answers exactly what a missing slug answers", async () => {
    const { other } = await seedWorld();
    for (const [label, missing] of httpProbes("missing", other)) {
      const want = await snapshot(await missing());
      expect(want.status, label).toBe(404);
      expect(want.body, label).toBe(NOT_FOUND);
      for (const slug of HIDDEN) {
        const probe = httpProbes(slug, other).find(([l]) => l === label)![1];
        expect(await snapshot(await probe()), `${label} ${slug}`).toEqual(want);
      }
    }
    // nothing was written by all that probing
    const pages = await all<{ slug: string; title: string; visibility: string; status: string; current_version: number }>(env.DB,
      `SELECT slug, title, visibility, status, current_version FROM artifact_pages ORDER BY slug`);
    expect(pages).toEqual([
      { slug: "delpage", title: "Delpage", visibility: "org", status: "draft", current_version: 1 },
      { slug: "orgpage", title: "Orgpage", visibility: "org", status: "draft", current_version: 1 },
      { slug: "pendpage", title: "Pendpage", visibility: "org", status: "draft", current_version: 0 },
      { slug: "privbin", title: "Privbin", visibility: "private", status: "draft", current_version: 1 },
      { slug: "privtext", title: "Privtext", visibility: "private", status: "published", current_version: 2 },
    ]);
    expect(await all(env.DB, `SELECT target_ref FROM artifact_links WHERE target_type = 'pr'`)).toEqual([]);
    expect(await all(env.DB, `SELECT slug FROM artifact_pages WHERE deleted_at IS NOT NULL`)).toEqual([{ slug: "delpage" }]);
  });

  it("the deleted page is not_found to its OWN author on every read and write but restore", async () => {
    const { owner } = await seedWorld();
    for (const [label, probe] of httpProbes("delpage", owner)) {
      if (label === "restore" || label.startsWith("upload-url")) continue; // restore is the way back; upload-url needs a binary page (artifacts.delete.test.ts)
      const res = await probe();
      expect(res.status, label).toBe(404);
      expect(await res.text(), label).toBe(NOT_FOUND);
    }
  });

  it("the pending page is not_found to its OWN author on every read (it does not exist until the PUT)", async () => {
    const { owner } = await seedWorld();
    for (const path of ["/api/artifacts/pendpage", "/raw/a/pendpage", "/api/artifacts/pendpage/diff?a=1&b=1"]) {
      const res = await get(path, owner);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe(NOT_FOUND);
    }
  });

  it("a non-author making an ORG page private is 403 — but on a hidden page the same request is the plain 404", async () => {
    const { other } = await seedWorld();
    const org = await wf("/api/artifacts/orgpage", jsonInit("PATCH", { visibility: "private" }, other));
    expect(org.status).toBe(403);
    const body = await org.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["error", "message"]);
    expect(body.error).toBe("forbidden");
    for (const slug of [...HIDDEN, "missing"]) {
      const r = await wf(`/api/artifacts/${slug}`, jsonInit("PATCH", { visibility: "private" }, other));
      expect(r.status, slug).toBe(404);
      expect(await r.text()).toBe(NOT_FOUND);
    }
    expect((await first<{ visibility: string }>(env.DB, `SELECT visibility FROM artifact_pages WHERE slug = 'orgpage'`))!.visibility).toBe("org");
  });

  it("the library list: hidden pages are absent under every filter", async () => {
    const { other, owner, tid } = await seedWorld();
    for (const qs of ["", "?q=okapi", "?q=priv", "?q=pend", `?author=${OWNER}`, `?ticket=${tid}`, "?kind=image", "?kind=pdf", "?status=published", "?area=api"]) {
      const res = await get(`/api/artifacts${qs}`, other);
      expect(res.status, qs).toBe(200);
      const slugs = ((await res.json()) as { artifacts: { slug: string }[] }).artifacts.map((a) => a.slug);
      for (const h of HIDDEN) expect(slugs, qs).not.toContain(h);
    }
    // the owner sees their private pages — but never the pending one
    const mine = ((await (await get("/api/artifacts", owner)).json()) as { artifacts: { slug: string }[] }).artifacts.map((a) => a.slug).sort();
    expect(mine).toEqual(["orgpage", "privbin", "privtext"]);
  });

  it("MCP artifact_get / artifact_update: identical {error, code} text for every hidden page and a missing slug", async () => {
    await seedWorld();
    const argSets: [string, (slug: string) => Record<string, unknown>][] = [
      ["artifact_get", (s) => ({ slug: s })],
      ["artifact_get", (s) => ({ slug: `${s}@v1` })],
      ["artifact_get", (s) => ({ slug: `${s}/v2` })],
      ["artifact_get", (s) => ({ slug: s, version: 1 })],
      ["artifact_update", (s) => ({ slug: s, content: "x", summary: "s" })],
      ["artifact_update", (s) => ({ slug: s, old_str: "okapi", new_str: "x", summary: "s" })],
      ["artifact_update", (s) => ({ slug: s, size_bytes: 3, sha256: "c".repeat(64), content_type: "image/png", summary: "s" })],
      ["artifact_update", (s) => ({ slug: s, summary: "s" })], // bad shape: still not_found first
      ["artifact_update", (s) => ({ slug: s, content: "x", sha256: "c".repeat(64), summary: "s" })],
    ];
    for (const [tool, args] of argSets) {
      const miss = await mcpCall(OTHER, tool, args("missing"));
      expect(miss.isError).toBe(true);
      expect(miss.text).toBe(MCP_NOT_FOUND);
      for (const slug of HIDDEN) {
        const r = await mcpCall(OTHER, tool, args(slug));
        expect(r.text, `${tool} ${slug} ${JSON.stringify(args(slug))}`).toBe(MCP_NOT_FOUND);
        expect(r.isError).toBe(true);
      }
    }
    expect(await all(env.DB, `SELECT token_hash FROM artifact_upload_tokens WHERE principal = ?`, OTHER)).toEqual([]);
  });

  it("query (MCP search + browse, and GET /search): hidden pages never appear; the owner finds the private ones", async () => {
    const { other, owner } = await seedWorld();
    const ids = (r: { primary: { id: string; type: string }[]; pointers: { id: string; type: string }[] }) =>
      [...r.primary, ...r.pointers].filter((h) => h.type === "artifact").map((h) => h.id).sort();
    for (const args of [{ q: "okapi" }, { q: "okapi", types: ["artifact"] }, { types: ["artifact"] }, { q: "privtext" }, { q: "pendpage", types: ["artifact"] }, { q: "okapi", include_staged: false }]) {
      const r = await mcpCall(OTHER, "query", args);
      expect(r.isError).toBe(false);
      for (const h of HIDDEN) expect(ids(r.body), JSON.stringify(args)).not.toContain(h);
      expect(r.text).not.toMatch(/privtext|privbin|pendpage|delpage|secret words|deleted words/);
    }
    // the control: the org page IS found, by search and by browse
    expect(ids((await mcpCall(OTHER, "query", { q: "okapi" })).body)).toEqual(["orgpage"]);
    expect(ids((await mcpCall(OTHER, "query", { types: ["artifact"] })).body)).toEqual(["orgpage"]);
    const mine = await mcpCall(OWNER, "query", { q: "okapi", types: ["artifact"] });
    expect(ids(mine.body)).toEqual(["orgpage", "privbin", "privtext"]);
    for (const cookie of [other, owner]) {
      const res = await get("/search?q=okapi", cookie);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toMatch(/pendpage/);
    }
    const s = await get("/search?q=okapi&types=artifact", other);
    expect(await s.text()).not.toMatch(/privtext|privbin|pendpage|delpage/);
    for (const cookie of [other, owner]) expect(await (await get("/search?q=okapi", cookie)).text()).not.toMatch(/delpage|deleted words/);
  });

  it("get_ticket: linked hidden pages are absent from `artifacts` (the pending one even for its owner)", async () => {
    const { tid } = await seedWorld();
    const theirs = await mcpCall(OTHER, "get_ticket", { id: tid });
    expect(theirs.body.artifacts.map((a: { slug: string }) => a.slug)).toEqual(["orgpage"]);
    expect(theirs.text).not.toMatch(/privtext|pendpage/);
    const mine = await mcpCall(OWNER, "get_ticket", { id: tid });
    expect(mine.body.artifacts.map((a: { slug: string }) => a.slug).sort()).toEqual(["orgpage", "privtext"]);
  });

  it("record_session artifact_links: a hidden page reports the same not_found as a missing one, and links nothing", async () => {
    const { tid } = await seedWorld();
    const r = await mcpCall(OTHER, "record_session", {
      session: { id: crypto.randomUUID(), author: OTHER, ended_at: "2026-09-23T00:00:00Z", skill_version: "2.0" },
      artifact_links: [...HIDDEN, "missing"].map((slug) => ({ slug, target_type: "pr", target_ref: "o/r#9" })),
    });
    expect(r.body.artifact_links.map((o: { outcome: string }) => o.outcome)).toEqual(["not_found", "not_found", "not_found", "not_found", "not_found"]);
    expect(r.body.artifact_links.map(({ slug: _s, ...rest }: { slug: string }) => rest)).toEqual(
      Array(5).fill({ target_type: "pr", target_ref: "o/r#9", outcome: "not_found" })
    );
    expect(await all(env.DB, `SELECT page_id FROM artifact_links WHERE target_type = 'pr'`)).toEqual([]);
    void tid;
  });
});

// ── 11. MCP permission checks ────────────────────────────────────────────────

describe("11 · MCP permissions for a second principal", () => {
  it("on the first principal's PRIVATE page every artifact tool is the identical not_found, and nothing changes", async () => {
    await seedWorld();
    const before = await all(env.DB, `SELECT * FROM artifact_versions ORDER BY id`);
    const tools: [string, Record<string, unknown>][] = [
      ["artifact_get", { slug: "privtext" }],
      ["artifact_get", { slug: "privtext", version: 2 }],
      ["artifact_update", { slug: "privtext", content: "hijack", summary: "x" }],
      ["artifact_update", { slug: "privtext", old_str: "secret", new_str: "public", summary: "x" }],
      ["artifact_update", { slug: "privbin", size_bytes: 3, sha256: "d".repeat(64), content_type: "image/png", summary: "x" }],
      ["artifact_get", { slug: "privbin" }],
    ];
    for (const [tool, args] of tools) {
      const r = await mcpCall(OTHER, tool, args);
      expect(r.text, `${tool} ${JSON.stringify(args)}`).toBe(MCP_NOT_FOUND);
    }
    expect(await all(env.DB, `SELECT * FROM artifact_versions ORDER BY id`)).toEqual(before);
    // the owner, over the same tools, is allowed
    expect((await mcpCall(OWNER, "artifact_get", { slug: "privtext" })).body.content).toBe("okapi secret words v2");
  });

  it("on an ORG page a second principal may add versions (text and binary) — recorded as them — but can never make it private", async () => {
    await seedWorld();
    const v = await mcpCall(OTHER, "artifact_update", { slug: "orgpage", old_str: "public", new_str: "shared", summary: "teammate edit" });
    expect(v.isError).toBe(false);
    expect(v.body).toMatchObject({ slug: "orgpage", version: 2, unchanged: false });
    const g = await mcpCall(OTHER, "artifact_get", { slug: "orgpage" });
    expect(g.body).toMatchObject({ content: "okapi shared words", status: "published", author_id: OWNER, visibility: "org" });
    expect(g.body.versions.map((x: { created_by: string }) => x.created_by)).toEqual([OWNER, OTHER]);

    // no MCP tool takes `visibility` on an existing page; passing it anyway is ignored
    const schema = await mcpToolSchema(OTHER, "artifact_update");
    expect(Object.keys(schema.properties)).not.toContain("visibility");
    await mcpCall(OTHER, "artifact_update", { slug: "orgpage", content: "okapi v3", summary: "x", visibility: "private" });
    expect((await first<{ visibility: string }>(env.DB, `SELECT visibility FROM artifact_pages WHERE slug = 'orgpage'`))!.visibility).toBe("org");
    // over HTTP the same person is 403 (only the author)
    const other = await cookieFor(OTHER);
    expect((await wf("/api/artifacts/orgpage", jsonInit("PATCH", { visibility: "private" }, other))).status).toBe(403);

    // a binary org page: the teammate's upload lands as their version
    const owner = await cookieFor(OWNER);
    await createBinary(owner, { title: "Org pic", kind: "image", area: "ui" }, { bytes: uniqueBytes("orgpic-1"), name: "a.png", type: "image/png" });
    const bytes = uniqueBytes("orgpic-2");
    const up = await mcpCall(OTHER, "artifact_update", { slug: "org-pic", size_bytes: bytes.byteLength, sha256: await sha256Hex(bytes), content_type: "image/png", summary: "retake" });
    expect(up.body.upload_url).toMatch(/^https:\/\/trov\.test\/api\/artifacts\/upload\/[A-Za-z0-9_-]{43}$/);
    const landed = await put(new URL(up.body.upload_url).pathname, bytes, { cookie: owner }); // a cookie on the PUT changes nothing
    expect(landed.status).toBe(200);
    const after = await mcpCall(OWNER, "artifact_get", { slug: "org-pic" });
    expect(after.body.versions.map((x: { created_by: string }) => x.created_by)).toEqual([OWNER, OTHER]);
    expect(after.body.status).toBe("published");
  });

  it("the second principal cannot re-mint an upload for someone else's PENDING page, but the owner can", async () => {
    await seedWorld();
    const theirs = await mcpCall(OTHER, "artifact_update", { slug: "pendpage", size_bytes: 10, sha256: "a".repeat(64), summary: "x" });
    expect(theirs.text).toBe(MCP_NOT_FOUND);
    const mine = await mcpCall(OWNER, "artifact_update", { slug: "pendpage", size_bytes: 10, sha256: "a".repeat(64), summary: "retry" });
    expect(mine.body.upload_url).toBeTruthy();
  });

  it("a teammate's create is theirs: an org page they authored may be made private only by them", async () => {
    await seedPerson(OTHER);
    const c = await mcpCall(OTHER, "upload_asset", { title: "Theirs", kind: "mermaid", content: "graph TD; A-->B", area: "infra", repo: "", visibility: "org" });
    expect(c.isError).toBe(false);
    const owner = await cookieFor(OWNER);
    expect((await wf("/api/artifacts/theirs", jsonInit("PATCH", { visibility: "private" }, owner))).status).toBe(403);
    const other = await cookieFor(OTHER);
    const ok = await wf("/api/artifacts/theirs", jsonInit("PATCH", { visibility: "private" }, other));
    expect(((await ok.json()) as ArtifactDetailDTO).visibility).toBe("private");
    expect((await mcpCall(OWNER, "artifact_get", { slug: "theirs" })).text).toBe(MCP_NOT_FOUND);
  });
});
