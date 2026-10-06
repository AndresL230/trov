// Artifacts — cross-cutting properties, end to end (issue #52 · Track E): per-kind caps,
// the sha256 no-op, slug collisions, the status machine, and ratify gating. Everything
// goes through the Worker's own fetch (src/index.ts) or the real /mcp endpoint.
// Companions: artifacts.security-access.test.ts (private 404 parity, MCP permissions)
// and artifacts.security-raw.test.ts (raw headers, R2, upload tokens, SSRF).

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { mintToken } from "../src/auth/tokens";
import { ARTIFACT_BINARY_CAP, ARTIFACT_SLUG_MAX, ARTIFACT_TEXT_CAP, type ArtifactDetailDTO } from "@shared/artifacts";
import {
  cookieFor, createBinary, createText, get, jsonInit, mcpCall, mcpRpc, mcpToolNames, multipart, put, sha256Hex,
  uniqueBytes, uploadUrl, wf,
} from "./helpers/artifacts";
import { platformCtx, ORG_A } from "./helpers/tenant";

const ME = "sec-author";
const YOU = "sec-teammate";

const ftsRows = (slug: string) =>
  all<{ rowid: number; title: string; description: string; body: string }>(env.DB,
    `SELECT f.rowid, f.title, f.description, f.body FROM artifacts_fts f JOIN artifact_pages p ON CAST(f.page_id AS INTEGER) = p.id WHERE p.slug = ?`, slug);
const versionCount = async (slug: string) =>
  (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifact_pages p ON p.id = v.page_id WHERE p.slug = ?`, slug))!.n;

// ── 1. per-kind caps ─────────────────────────────────────────────────────────

describe("1 · per-kind caps", () => {
  // 2-byte and 4-byte UTF-8: a string's .length is NOT its byte count.
  const atCap2 = "é".repeat(ARTIFACT_TEXT_CAP / 2);          // 768000 bytes, 384000 chars
  const overCap2 = atCap2 + "a";                              // 768001 bytes
  const atCap4 = "😀".repeat(ARTIFACT_TEXT_CAP / 4);          // 768000 bytes, 384000 UTF-16 units
  const overCap4 = "😀".repeat(ARTIFACT_TEXT_CAP / 4 - 1) + "abcde"; // 768001 bytes, far fewer chars than the cap

  it("text: create at exactly the 750 KB cap (multi-byte) is 201 with size_bytes = the cap; +1 byte is 413", async () => {
    const me = await cookieFor(ME);
    for (const [i, content] of [atCap2, atCap4].entries()) {
      const p = await createText(me, { title: `At cap ${i}`, content });
      expect(p.size_bytes).toBe(ARTIFACT_TEXT_CAP);
      expect(p.version.size_bytes).toBe(ARTIFACT_TEXT_CAP);
      expect(p.content).toBe(content);
    }
    for (const content of [overCap2, overCap4]) {
      expect(content.length).toBeLessThan(ARTIFACT_TEXT_CAP); // under the cap in chars, over it in bytes
      const res = await wf("/api/artifacts", jsonInit("POST", { title: "Over", kind: "html", area: "ui", content }, me));
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "too_large" });
    }
    expect(await all(env.DB, `SELECT slug FROM artifact_pages WHERE title = 'Over'`)).toEqual([]);
  });

  it("text: add-version at the cap is 201; +1 byte is 413 — by full content and by an old_str edit", async () => {
    const me = await cookieFor(ME);
    await createText(me, { title: "Grow", content: "seed" });
    const ok = await wf("/api/artifacts/grow/versions", jsonInit("POST", { content: atCap2, summary: "full" }, me));
    expect(ok.status).toBe(201);
    const over = await wf("/api/artifacts/grow/versions", jsonInit("POST", { content: overCap4 }, me));
    expect(over.status).toBe(413);
    // an old_str edit whose RESULT lands exactly on the cap, then one byte over it
    await wf("/api/artifacts/grow/versions", jsonInit("POST", { content: "é".repeat(ARTIFACT_TEXT_CAP / 2 - 1) + "X" }, me)); // 767999 bytes
    const edit1 = await wf("/api/artifacts/grow/versions", jsonInit("POST", { old_str: "X", new_str: "XY" }, me)); // 768000
    expect(edit1.status).toBe(201);
    const edit2 = await wf("/api/artifacts/grow/versions", jsonInit("POST", { old_str: "Y", new_str: "YZ" }, me)); // 768001
    expect(edit2.status).toBe(413);
    expect(await versionCount("grow")).toBe(4);
  });

  it("text over MCP: upload_asset / artifact_update at the cap succeed, +1 byte is too_large", async () => {
    const base = { kind: "markdown", area: "api", repo: "", visibility: "org" };
    const ok = await mcpCall(ME, "upload_asset", { ...base, title: "Mcp cap", content: atCap4 });
    expect(ok.isError).toBe(false);
    const over = await mcpCall(ME, "upload_asset", { ...base, title: "Mcp over", content: overCap2 });
    expect(over.body).toEqual({ error: expect.any(String), code: "too_large" });
    const up = await mcpCall(ME, "artifact_update", { slug: "mcp-cap", content: overCap4, summary: "x" });
    expect(up.body.code).toBe("too_large");
    const upOk = await mcpCall(ME, "artifact_update", { slug: "mcp-cap", content: atCap2, summary: "x" });
    expect(upOk.body).toMatchObject({ version: 2, unchanged: false });
  });

  it("binary: create and add-version (multipart) at exactly 10 MB are 201; +1 byte is 413", async () => {
    const me = await cookieFor(ME);
    const at = uniqueBytes("cap-create", ARTIFACT_BINARY_CAP);
    const p = await createBinary(me, { title: "Big file", kind: "file", area: "data" }, { bytes: at, name: "big.bin", type: "application/octet-stream" });
    expect(p.version.size_bytes).toBe(ARTIFACT_BINARY_CAP);
    const over = uniqueBytes("cap-over", ARTIFACT_BINARY_CAP + 1);
    const r1 = await wf("/api/artifacts", { method: "POST", headers: { cookie: me }, body: multipart({ title: "Too big", kind: "file", area: "data" }, { bytes: over, name: "x.bin", type: "application/octet-stream" }) });
    expect(r1.status).toBe(413);
    const at2 = uniqueBytes("cap-version", ARTIFACT_BINARY_CAP);
    const v2 = await wf("/api/artifacts/big-file/versions", { method: "POST", headers: { cookie: me }, body: multipart({ summary: "v2" }, { bytes: at2, name: "big.bin", type: "application/octet-stream" }) });
    expect(v2.status).toBe(201);
    const v3 = await wf("/api/artifacts/big-file/versions", { method: "POST", headers: { cookie: me }, body: multipart({ summary: "v3" }, { bytes: over, name: "big.bin", type: "application/octet-stream" }) });
    expect(v3.status).toBe(413);
    expect(await versionCount("big-file")).toBe(2);
    expect(await all(env.DB, `SELECT slug FROM artifact_pages WHERE title = 'Too big'`)).toEqual([]);
  });

  it("binary via the upload PUT: a ticket at 10 MB lands; a ticket for +1 byte is 413; a +1 declared body is 413 and leaves the token usable", async () => {
    const me = await cookieFor(ME);
    const at = uniqueBytes("cap-put", ARTIFACT_BINARY_CAP);
    const sha = await sha256Hex(at);
    const overTicket = await uploadUrl(me, { kind: "pdf", size_bytes: ARTIFACT_BINARY_CAP + 1, sha256: sha, title: "Too big pdf", area: "api" });
    expect(overTicket.status).toBe(413);
    expect(JSON.parse(overTicket.text)).toMatchObject({ error: "too_large" });
    const t = await uploadUrl(me, { kind: "pdf", size_bytes: ARTIFACT_BINARY_CAP, sha256: sha, title: "Cap pdf", area: "api" });
    expect(t.status).toBe(201);
    // a declared body over the cap is refused before the token is touched
    const big = await put(t.path!, "x", { "content-length": String(ARTIFACT_BINARY_CAP + 1) });
    expect(big.status).toBe(413);
    const ok = await put(t.path!, at);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ version_no: 1, page: { slug: "cap-pdf", size_bytes: ARTIFACT_BINARY_CAP } });
  });

  it("binary over MCP: a 10 MB ticket is issued, +1 byte is refused", async () => {
    const base = { title: "Mcp big", kind: "file", area: "data", repo: "", visibility: "org", sha256: "d".repeat(64) };
    const ok = await mcpCall(ME, "upload_asset", { ...base, size_bytes: ARTIFACT_BINARY_CAP });
    expect(ok.body.upload_url).toMatch(/\/api\/artifacts\/upload\//);
    const over = await mcpCall(ME, "upload_asset", { ...base, title: "Mcp bigger", size_bytes: ARTIFACT_BINARY_CAP + 1 });
    expect(over.isError).toBe(true);
    expect(over.body.code).toBe("too_large");
    expect(await all(env.DB, `SELECT slug FROM artifact_pages WHERE title = 'Mcp bigger'`)).toEqual([]);
  });
});

// ── 2. sha256 no-op ──────────────────────────────────────────────────────────

describe("2 · sha256 no-op", () => {
  it("identical text → 200 unchanged: no version, no FTS change, updated_at and summary untouched", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    await createText(me, { title: "Noop", content: "same body", summary: "first" });
    const before = { fts: await ftsRows("noop"), page: await get("/api/artifacts/noop", me).then((r) => r.json()) as ArtifactDetailDTO };
    for (const [cookie, body] of [[me, { content: "same body", summary: "different summary" }], [you, { content: "same body" }], [me, { old_str: "same", new_str: "same" }]] as const) {
      const r = await wf("/api/artifacts/noop/versions", jsonInit("POST", body, cookie));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ unchanged: true, version_no: 1, page: { status: "draft", current_version: 1 } });
    }
    expect(await versionCount("noop")).toBe(1);
    expect(await ftsRows("noop")).toEqual(before.fts);
    const after = (await (await get("/api/artifacts/noop", me)).json()) as ArtifactDetailDTO;
    expect(after.updated_at).toBe(before.page.updated_at);
    expect(after.version.summary).toBe("first");
    // over MCP too
    const m = await mcpCall(YOU, "artifact_update", { slug: "noop", content: "same body", summary: "again" });
    expect(m.body).toMatchObject({ unchanged: true, version: 1 });
    expect(await ftsRows("noop")).toEqual(before.fts);
  });

  it("the no-op compares against the CURRENT version only: reverting to v1's body is a real v3", async () => {
    const me = await cookieFor(ME);
    await createText(me, { title: "Revert", content: "one" });
    expect((await wf("/api/artifacts/revert/versions", jsonInit("POST", { content: "two" }, me))).status).toBe(201);
    const back = await wf("/api/artifacts/revert/versions", jsonInit("POST", { content: "one" }, me));
    expect(back.status).toBe(201);
    expect(await back.json()).toMatchObject({ unchanged: false, version_no: 3 });
  });

  it("a no-op on a RATIFIED page writes nothing — it stays ratified", async () => {
    const me = await cookieFor(ME);
    await createText(me, { title: "Kept", content: "x" });
    await wf("/api/artifacts/kept/versions", jsonInit("POST", { content: "y" }, me));
    expect((await wf("/api/artifacts/kept/ratify", jsonInit("POST", { version: 2 }, me))).status).toBe(200);
    const r = await wf("/api/artifacts/kept/versions", jsonInit("POST", { content: "y" }, me));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ unchanged: true, page: { status: "ratified", ratified_version: 2 } });
  });

  it("identical binary bytes → unchanged, by multipart AND by the upload PUT", async () => {
    const me = await cookieFor(ME);
    const bytes = uniqueBytes("noop-bin");
    await createBinary(me, { title: "Same pic", kind: "image", area: "ui" }, { bytes, name: "a.png", type: "image/png" });
    const fts = await ftsRows("same-pic");
    const mp = await wf("/api/artifacts/same-pic/versions", { method: "POST", headers: { cookie: me }, body: multipart({ summary: "again" }, { bytes, name: "b.png", type: "image/png" }) });
    expect(mp.status).toBe(200);
    expect(await mp.json()).toMatchObject({ unchanged: true, version_no: 1 });
    const t = await uploadUrl(me, { slug: "same-pic", kind: "image", size_bytes: bytes.byteLength, sha256: await sha256Hex(bytes), content_type: "image/png", summary: "put again" });
    expect(t.status).toBe(201);
    const p = await put(t.path!, bytes);
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ unchanged: true, version_no: 1, page: { status: "draft" } });
    expect(await versionCount("same-pic")).toBe(1);
    expect(await ftsRows("same-pic")).toEqual(fts);
  });
});

// ── 3. slug collisions ───────────────────────────────────────────────────────

describe("3 · slug collisions", () => {
  it("the same title three times → slug, slug-2, slug-3 (HTTP and MCP share one namespace)", async () => {
    const me = await cookieFor(ME);
    expect((await createText(me, { title: "Deploy map" })).slug).toBe("deploy-map");
    expect((await createText(me, { title: "Deploy  Map!" })).slug).toBe("deploy-map-2");
    const m = await mcpCall(YOU, "upload_asset", { title: "deploy map", kind: "markdown", content: "x", area: "infra", repo: "", visibility: "org" });
    expect(m.body.slug).toBe("deploy-map-3");
  });

  it("a 60-char title: every suffixed slug still fits in 60 and never ends in a dash", async () => {
    const me = await cookieFor(ME);
    const title = "Abcdefghij ".repeat(6).trim(); // slugifies to 65 chars → cut to 60
    const slugs: string[] = [];
    for (let i = 0; i < 3; i++) slugs.push((await createText(me, { title })).slug);
    // a pending binary page takes a slug too
    const t = await uploadUrl(me, { kind: "pdf", size_bytes: 3, sha256: "e".repeat(64), title, area: "api" });
    slugs.push(t.dto.slug);
    expect(new Set(slugs).size).toBe(4);
    for (const s of slugs) {
      expect(s.length).toBeLessThanOrEqual(ARTIFACT_SLUG_MAX);
      expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
    expect(slugs[0].length).toBe(ARTIFACT_SLUG_MAX);
    expect(slugs.slice(1).map((s) => s.slice(s.lastIndexOf("-")))).toEqual(["-2", "-3", "-4"]);
  });

  it('"new" is never issued (the SPA route #artifacts/new)', async () => {
    const me = await cookieFor(ME);
    const a = await createText(me, { title: "New" });
    const b = await createText(me, { title: "  new  " });
    const c = await mcpCall(ME, "upload_asset", { title: "NEW", kind: "markdown", content: "x", area: "ui", repo: "", visibility: "org" });
    const d = await uploadUrl(me, { kind: "file", size_bytes: 3, sha256: "f".repeat(64), title: "new", area: "data" });
    const slugs = [a.slug, b.slug, c.body.slug, d.dto.slug];
    expect(slugs).not.toContain("new");
    expect(slugs).toEqual(["new-2", "new-3", "new-4", "new-5"]);
    expect(await all(env.DB, `SELECT slug FROM artifact_pages WHERE slug = 'new'`)).toEqual([]);
  });
});

// ── 4. status transitions ────────────────────────────────────────────────────

describe("4 · status transitions (artifacts-core's table, over HTTP)", () => {
  const patch = async (cookie: string, slug: string, body: unknown) => {
    const r = await wf(`/api/artifacts/${slug}`, jsonInit("PATCH", body, cookie));
    return { status: r.status, page: (await r.json()) as ArtifactDetailDTO };
  };
  const ratified = (p: ArtifactDetailDTO) => [p.ratified_version, p.ratified_by, p.ratified_at];

  it("create → draft v1; draft ⇄ published by any reader; a new version → published + ratified cleared; → draft clears ratified", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    const c = await createText(me, { title: "Machine", content: "v1" });
    expect(c).toMatchObject({ status: "draft", current_version: 1, ratified_version: null });

    expect((await patch(you, "machine", { status: "published" })).page.status).toBe("published");
    expect((await patch(you, "machine", { status: "draft" })).page.status).toBe("draft");

    // a new version publishes a draft
    const v2 = await wf("/api/artifacts/machine/versions", jsonInit("POST", { content: "v2" }, you));
    expect(await v2.json()).toMatchObject({ page: { status: "published", current_version: 2 } });

    // ratify → a new version → published, ratified_* cleared
    expect((await wf("/api/artifacts/machine/ratify", jsonInit("POST", { version: 2 }, you))).status).toBe(200);
    const v3 = (await (await wf("/api/artifacts/machine/versions", jsonInit("POST", { content: "v3" }, me))).json()) as { page: ArtifactDetailDTO };
    expect(v3.page.status).toBe("published");
    expect(ratified(v3.page)).toEqual([null, null, null]);

    // ratify → PATCH draft clears ratified_*
    await wf("/api/artifacts/machine/ratify", jsonInit("POST", { version: 3 }, me));
    const d = await patch(you, "machine", { status: "draft" });
    expect(d.page.status).toBe("draft");
    expect(ratified(d.page)).toEqual([null, null, null]);

    // ratify → PATCH published also leaves ratified (clears)
    await patch(me, "machine", { status: "published" });
    await wf("/api/artifacts/machine/ratify", jsonInit("POST", { version: 3 }, me));
    const pub = await patch(me, "machine", { status: "published" });
    expect(pub.page.status).toBe("published");
    expect(ratified(pub.page)).toEqual([null, null, null]);

    // a title / area change does not move status
    await wf("/api/artifacts/machine/ratify", jsonInit("POST", { version: 3 }, me));
    const t = await patch(you, "machine", { title: "Machine 2", area: "api" });
    expect(t.page).toMatchObject({ status: "ratified", ratified_version: 3, slug: "machine" });

    // 'ratified' is never a PATCH status
    expect((await patch(me, "machine", { status: "ratified" })).status).toBe(400);
  });

  it("the DB never holds a half-ratified row (the migration's CHECKs)", async () => {
    const me = await cookieFor(ME);
    await createText(me, { title: "Check", content: "x" });
    await expect(env.DB.prepare(`UPDATE artifact_pages SET status = 'ratified' WHERE slug = 'check'`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE artifact_pages SET ratified_by = 'x' WHERE slug = 'check'`).run()).rejects.toThrow();
  });

  it("publishing a private page (→ org) moves draft → published; an explicit status wins; ratified stays ratified", async () => {
    const me = await cookieFor(ME);
    await createText(me, { title: "Priv a", visibility: "private" });
    expect((await patch(me, "priv-a", { visibility: "org" })).page).toMatchObject({ visibility: "org", status: "published" });

    await createText(me, { title: "Priv b", visibility: "private" });
    expect((await patch(me, "priv-b", { visibility: "org", status: "draft" })).page).toMatchObject({ visibility: "org", status: "draft" });

    await createText(me, { title: "Priv c", visibility: "private", content: "1" });
    await wf("/api/artifacts/priv-c/versions", jsonInit("POST", { content: "2" }, me));
    await wf("/api/artifacts/priv-c/ratify", jsonInit("POST", { version: 2 }, me));
    expect((await patch(me, "priv-c", { visibility: "org" })).page).toMatchObject({ visibility: "org", status: "ratified", ratified_version: 2 });

    // org → private does not move status
    await createText(me, { title: "Org d" });
    expect((await patch(me, "org-d", { visibility: "private" })).page).toMatchObject({ visibility: "private", status: "draft" });
  });

  it("a binary page: the PUT's v1 is draft, a later PUT publishes", async () => {
    const me = await cookieFor(ME);
    const b1 = uniqueBytes("status-bin-1");
    const t1 = await uploadUrl(me, { kind: "file", size_bytes: b1.byteLength, sha256: await sha256Hex(b1), title: "Bin status", area: "data" });
    expect(await (await put(t1.path!, b1)).json()).toMatchObject({ version_no: 1, page: { status: "draft" } });
    const b2 = uniqueBytes("status-bin-2");
    const t2 = await uploadUrl(me, { slug: "bin-status", kind: "file", size_bytes: b2.byteLength, sha256: await sha256Hex(b2) });
    expect(await (await put(t2.path!, b2)).json()).toMatchObject({ version_no: 2, page: { status: "published" } });
  });
});

// ── 5. ratify gating ─────────────────────────────────────────────────────────

describe("5 · ratify gating — session only, latest published only, never MCP", () => {
  async function published(): Promise<string> {
    const me = await cookieFor(ME);
    await createText(me, { title: "Gate", content: "1" });
    await wf("/api/artifacts/gate/versions", jsonInit("POST", { content: "2" }, me));
    return me;
  }
  const status = async (): Promise<string> => (await first<{ status: string }>(env.DB, `SELECT status FROM artifact_pages WHERE slug = 'gate'`))!.status;

  it("a bearer token — even the author's — is refused: alone 401, beside a cookie 403", async () => {
    const me = await published();
    const { raw } = await mintToken(platformCtx(), ME, ORG_A);
    const alone = await wf("/api/artifacts/gate/ratify", jsonInit("POST", { version: 2 }, undefined, { authorization: `Bearer ${raw}` }));
    expect(alone.status).toBe(401);
    const both = await wf("/api/artifacts/gate/ratify", jsonInit("POST", { version: 2 }, me, { authorization: `Bearer ${raw}` }));
    expect(both.status).toBe(403);
    const anyAuth = await wf("/api/artifacts/gate/ratify", jsonInit("POST", { version: 2 }, me, { authorization: "Basic eDp5" }));
    expect(anyAuth.status).toBe(403);
    expect(await status()).toBe("published");
  });

  it("draft → 409; not the latest → 409; out of range → 409; already ratified → 409; the latest published → 200", async () => {
    const me = await cookieFor(ME);
    const you = await cookieFor(YOU);
    await createText(me, { title: "Gate", content: "1" });
    const r = (v: number, c = you) => wf("/api/artifacts/gate/ratify", jsonInit("POST", { version: v }, c));
    expect((await r(1)).status).toBe(409); // draft
    await wf("/api/artifacts/gate/versions", jsonInit("POST", { content: "2" }, me));
    expect((await r(1)).status).toBe(409); // not latest
    expect((await r(3)).status).toBe(409); // no such version
    const ok = await r(2);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ratified", ratified_version: 2, ratified_by: YOU });
    const again = await r(2, me);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "conflict" });
    // a draft reached by PATCH is 409 again
    await wf("/api/artifacts/gate", jsonInit("PATCH", { status: "draft" }, me));
    expect((await r(2)).status).toBe(409);
  });

  it("no MCP tool can ratify: none is listed (admin included), calling one by name fails, and no write tool smuggles status", async () => {
    await published();
    for (const who of [ME, "admin-user"]) {
      const names = await mcpToolNames(who);
      expect(names).toContain("artifact_update");
      expect(names.filter((n) => /ratif|promote_artifact|artifact_status|set_status/i.test(n))).toEqual([]);
    }
    for (const name of ["ratify", "artifact_ratify", "ratify_artifact"]) {
      const r = await mcpCall(ME, name, { slug: "gate", version: 2 });
      expect(r.isError, name).toBe(true);
    }
    // extra keys on the write tools are ignored, never a status change
    await mcpCall(ME, "artifact_update", { slug: "gate", content: "3", summary: "s", status: "ratified", ratified_version: 3 } as Record<string, unknown>);
    expect(await status()).toBe("published");
    await mcpCall(ME, "upload_asset", { title: "Sneaky", kind: "markdown", content: "x", area: "ui", repo: "", visibility: "org", status: "ratified" });
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM artifact_pages WHERE slug = 'sneaky'`))!.status).toBe("draft");
    // record_session carries no ratification either
    const rs = await mcpRpc(ME, "tools/call", { name: "record_session", arguments: { session: { id: crypto.randomUUID(), author: ME, ended_at: "2026-09-23T00:00:00Z", skill_version: "2.0" }, artifact_ratify: [{ slug: "gate", version: 3 }] } });
    expect(rs.result ?? rs.error).toBeTruthy();
    expect(await status()).toBe("published");
  });
});
