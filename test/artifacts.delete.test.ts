// Artifact soft delete (0035 PART D): POST /api/artifacts/:slug/delete + /restore.
// The author or an admin deletes; the page becomes the ONE byte-identical not-found on
// every surface (library, detail, raw, MCP artifact_get / artifact_list / artifact_update,
// query, /search, /search/quick, a ticket's artifacts, a signed download minted BEFORE
// the delete, an upload token minted before it) while its versions, links and R2 bytes
// stay; its slug stays reserved; restore brings it all back; a rename rewrites
// deleted_by; there is no MCP delete. Driven through the real Worker fetch and /mcp.

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "./helpers/db";
import { create_ticket } from "../src/tools/tickets";
import { deletePage, restorePage } from "../src/tools/artifacts";
import { renamePerson } from "../src/auth/persons";
import type { ArtifactDetailDTO } from "@shared/artifacts";
import type { QuickSearchResult } from "@shared/quick-search";
import {
  MCP_NOT_FOUND, NOT_FOUND, cookieFor, createBinary, createText, get, jsonInit, mcpCall, mcpToolNames, put, seedPerson, uniqueBytes,
  sha256Hex, uploadUrl, wf,
} from "./helpers/artifacts";
import { systemCtx, platformCtx } from "./helpers/tenant";

const AUTHOR = "adel-author";
const OTHER = "adel-other";
const ADMIN = "admin-user"; // FIXTURE_ADMIN: seeded as an org admin (test/helpers/persons.ts)
const SLUG = "zebra-page";

let tid = 0;
beforeEach(async () => {
  for (const h of [AUTHOR, OTHER, ADMIN]) await seedPerson(h);
  tid = await create_ticket(systemCtx(), { title: "Zebra ticket", body: "", category: "other", priority: "normal", assignees: [] }, AUTHOR);
  const c = await cookieFor(AUTHOR);
  await createText(c, { title: "Zebra page", content: "# Zebra\n\nstripes quagga", summary: "quagga", links: [{ target_type: "ticket", target_ref: String(tid) }] });
  await wf(`/api/artifacts/${SLUG}/versions`, jsonInit("POST", { content: "# Zebra\n\nstripes quagga v2", summary: "quagga two" }, c)); // v2 publishes it
});

const post = async (path: string, who: string, headers: Record<string, string> = {}) =>
  wf(path, jsonInit("POST", {}, await cookieFor(who), headers));
const del = (who: string, slug = SLUG) => post(`/api/artifacts/${slug}/delete`, who);
const restore = (who: string, slug = SLUG) => post(`/api/artifacts/${slug}/restore`, who);

/** Every surface an artifact can be read on, as `viewer` — true where it shows. */
async function visibility(viewer = OTHER, slug = SLUG): Promise<Record<string, boolean>> {
  const c = await cookieFor(viewer);
  const slugs = async (qs: string) => ((await (await get(`/api/artifacts${qs}`, c)).json()) as { artifacts: { slug: string }[] }).artifacts.map((a) => a.slug);
  const quick = (await (await get("/search/quick?q=quagga", c)).json()) as { result: QuickSearchResult };
  const q = await mcpCall(viewer, "query", { q: "quagga", types: ["artifact"] });
  const browse = await mcpCall(viewer, "query", { types: ["artifact"] });
  const ids = (r: { body: { primary: { id: string }[]; pointers: { id: string }[] } }) => [...r.body.primary, ...r.body.pointers].map((h) => h.id);
  const list = await mcpCall(viewer, "artifact_list", {});
  const ticket = await mcpCall(viewer, "get_ticket", { id: tid });
  const fts = await first<{ n: number }>(env.DB,
    `SELECT COUNT(*) AS n FROM artifacts_fts WHERE page_id = (SELECT CAST(id AS TEXT) FROM artifact_pages WHERE slug = ?)`, slug);
  return {
    list: (await slugs("")).includes(slug),
    listQ: (await slugs("?q=quagga")).includes(slug),
    listTicket: (await slugs(`?ticket=${tid}`)).includes(slug),
    detail: (await get(`/api/artifacts/${slug}`, c)).status === 200,
    raw: (await get(`/raw/a/${slug}`, c)).status === 200,
    search: (await (await get("/search?q=quagga", c)).text()).includes(slug),
    quick: (quick.result.groups.find((g) => g.type === "artifact")?.hits ?? []).some((h) => h.id === slug),
    mcpGet: !(await mcpCall(viewer, "artifact_get", { slug })).isError,
    mcpList: (list.body.artifacts as { slug: string }[]).some((a) => a.slug === slug),
    mcpQuery: ids(q).includes(slug),
    mcpBrowse: ids(browse).includes(slug),
    ticket: (ticket.body.artifacts as { slug: string }[]).some((a) => a.slug === slug),
    fts: fts!.n > 0,
  };
}
const everywhere = (v: boolean) => ({
  list: v, listQ: v, listTicket: v, detail: v, raw: v, search: v, quick: v, mcpGet: v, mcpList: v, mcpQuery: v, mcpBrowse: v, ticket: v, fts: v,
});

describe("POST /api/artifacts/:slug/delete", () => {
  it("the author deletes: gone from every surface, versions / links kept, the delete stamped", async () => {
    expect(await visibility()).toEqual(everywhere(true));
    const res = await del(AUTHOR);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: SLUG, title: "Zebra page", versions: 2 });

    expect(await visibility()).toEqual(everywhere(false));
    expect(await visibility(AUTHOR)).toEqual(everywhere(false)); // its own author too — restore is the way back
    // the ONE not-found, byte for byte, as a missing slug answers
    for (const path of [`/api/artifacts/${SLUG}`, `/raw/a/${SLUG}@v1`, `/api/artifacts/${SLUG}/diff?a=1&b=2`]) {
      const res = await get(path, await cookieFor(OTHER));
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(NOT_FOUND);
    }
    expect((await mcpCall(OTHER, "artifact_get", { slug: SLUG })).text).toBe(MCP_NOT_FOUND);
    const upd = await mcpCall(AUTHOR, "artifact_update", { slug: SLUG, content: "x", summary: "s" });
    expect(upd.text).toBe(MCP_NOT_FOUND);

    const row = await first<{ deleted_at: string | null; deleted_by: string | null; current_version: number }>(env.DB,
      `SELECT deleted_at, deleted_by, current_version FROM artifact_pages WHERE slug = ?`, SLUG);
    expect(row!.deleted_by).toBe(AUTHOR);
    expect(row!.deleted_at).toMatch(/^\d{4}-/);
    expect(row!.current_version).toBe(2);
    expect(await all(env.DB, `SELECT version_no FROM artifact_versions v JOIN artifact_pages p ON p.id = v.page_id WHERE p.slug = ? ORDER BY version_no`, SLUG))
      .toEqual([{ version_no: 1 }, { version_no: 2 }]);
    expect(await all(env.DB, `SELECT target_type, target_ref FROM artifact_links l JOIN artifact_pages p ON p.id = l.page_id WHERE p.slug = ?`, SLUG))
      .toEqual([{ target_type: "ticket", target_ref: String(tid) }]);
  });

  it("a deleted page takes no writes: PATCH, versions, links, ratify, a second delete — all the one not-found", async () => {
    await del(AUTHOR);
    const c = await cookieFor(AUTHOR);
    for (const [label, res] of [
      ["patch", await wf(`/api/artifacts/${SLUG}`, jsonInit("PATCH", { title: "x" }, c))],
      ["version", await wf(`/api/artifacts/${SLUG}/versions`, jsonInit("POST", { content: "x" }, c))],
      ["link", await wf(`/api/artifacts/${SLUG}/links`, jsonInit("POST", { target_type: "pr", target_ref: "o/r#1" }, c))],
      ["ratify", await wf(`/api/artifacts/${SLUG}/ratify`, jsonInit("POST", { version: 2 }, c))],
      ["delete", await del(AUTHOR)],
    ] as const) {
      expect(res.status, label).toBe(404);
      expect(await res.text(), label).toBe(NOT_FOUND);
    }
    const r = await mcpCall(AUTHOR, "record_session", {
      session: { id: crypto.randomUUID(), author: AUTHOR, ended_at: "2026-09-26T00:00:00Z", skill_version: "2.0" },
      artifact_links: [{ slug: SLUG, target_type: "pr", target_ref: "o/r#9" }],
    });
    expect(r.body.artifact_links[0].outcome).toBe("not_found");
    expect(await all(env.DB, `SELECT page_id FROM artifact_links WHERE target_type = 'pr'`)).toEqual([]);
    expect((await first<{ title: string }>(env.DB, `SELECT title FROM artifact_pages WHERE slug = ?`, SLUG))!.title).toBe("Zebra page");
  });

  it("anyone else is 403 and nothing is written", async () => {
    const res = await del(OTHER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("forbidden");
    expect(body.message).toMatch(/author or an admin/);
    expect(await first(env.DB, `SELECT deleted_at, deleted_by FROM artifact_pages WHERE slug = ?`, SLUG)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await visibility()).toEqual(everywhere(true));
  });

  it("an admin may delete someone else's org page", async () => {
    expect((await del(ADMIN)).status).toBe(200);
    expect((await first<{ deleted_by: string }>(env.DB, `SELECT deleted_by FROM artifact_pages WHERE slug = ?`, SLUG))!.deleted_by).toBe(ADMIN);
  });

  it("the author check is case-insensitive, like every handle", async () => {
    await expect(deletePage(systemCtx(), SLUG, AUTHOR.toUpperCase(), false)).resolves.toEqual({ slug: SLUG, title: "Zebra page", versions: 2 });
  });

  it("private pages keep their rule: only the author sees it, so only the author can delete it — an admin gets the plain 404", async () => {
    const c = await cookieFor(AUTHOR);
    await createText(c, { title: "Secret okapi", content: "okapi", visibility: "private" });
    for (const who of [OTHER, ADMIN]) {
      const res = await del(who, "secret-okapi");
      expect(res.status, who).toBe(404);
      expect(await res.text()).toBe(NOT_FOUND);
    }
    expect((await del(AUTHOR, "secret-okapi")).status).toBe(200);
    for (const who of [OTHER, ADMIN]) {
      const res = await restore(who, "secret-okapi");
      expect(res.status, who).toBe(404);
      expect(await res.text()).toBe(NOT_FOUND);
    }
    expect((await restore(AUTHOR, "secret-okapi")).status).toBe(200);
  });

  it("a person's action, never a token's: a request carrying Authorization is refused, nothing written", async () => {
    const res = await post(`/api/artifacts/${SLUG}/delete`, AUTHOR, { authorization: "Bearer canopy_mcp_x" });
    expect(res.status).toBe(403);
    expect(await first(env.DB, `SELECT deleted_at FROM artifact_pages WHERE slug = ?`, SLUG)).toEqual({ deleted_at: null });
  });

  it("an unknown slug is the one 404", async () => {
    const res = await del(AUTHOR, "no-such-page");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND);
  });

  it("is never an MCP tool — no agent can delete or restore an artifact", async () => {
    const names = await mcpToolNames(ADMIN);
    expect(names).toContain("artifact_update");
    expect(names.filter((n) => /delete|restore|remove|trash/.test(n) && /artifact|asset/.test(n))).toEqual([]);
  });
});

describe("a signed download or an upload minted BEFORE the delete", () => {
  it("the download URL from artifact_get fails once the page is deleted, and works again after a restore", async () => {
    const g = await mcpCall(OTHER, "artifact_get", { slug: SLUG });
    const url = g.body.download_url as string;
    expect((await wf(url)).status).toBe(200);
    await del(AUTHOR);
    const gone = await wf(url);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe(NOT_FOUND);
    await restore(AUTHOR);
    expect((await wf(url)).status).toBe(200);
  });

  it("an upload token for a new binary version cannot land on a deleted page; upload-url is the one 404", async () => {
    const c = await cookieFor(AUTHOR);
    const bytes = uniqueBytes("logo-v1");
    const page = await createBinary(c, { title: "Logo", kind: "image", area: "ui" }, { bytes, name: "l.png", type: "image/png" });
    const next = uniqueBytes("logo-v2");
    const mint = await uploadUrl(c, { slug: page.slug, kind: "image", size_bytes: next.byteLength, sha256: await sha256Hex(next), content_type: "image/png" });
    expect(mint.status).toBe(201);
    expect((await del(AUTHOR, page.slug)).status).toBe(200);
    const res = await put(mint.path!, next);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND);
    const again = await uploadUrl(c, { slug: page.slug, kind: "image", size_bytes: next.byteLength, sha256: await sha256Hex(next), content_type: "image/png" });
    expect(again.status).toBe(404);
    expect(again.text).toBe(NOT_FOUND);
    expect((await first<{ current_version: number }>(env.DB, `SELECT current_version FROM artifact_pages WHERE slug = ?`, page.slug))!.current_version).toBe(1);
    // the bytes are still in R2: restore, and v1 is served again
    expect((await restore(AUTHOR, page.slug)).status).toBe(200);
    expect((await get(`/raw/a/${page.slug}`, c)).status).toBe(200);
  });
});

describe("POST /api/artifacts/:slug/restore", () => {
  it("brings it back everywhere, exactly as it was", async () => {
    const before = (await (await get(`/api/artifacts/${SLUG}`, await cookieFor(OTHER))).json()) as ArtifactDetailDTO;
    await del(AUTHOR);
    const res = await restore(AUTHOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; artifact: ArtifactDetailDTO };
    expect(body.artifact.slug).toBe(SLUG);
    expect(await visibility()).toEqual(everywhere(true));
    const after = (await (await get(`/api/artifacts/${SLUG}`, await cookieFor(OTHER))).json()) as ArtifactDetailDTO;
    expect(after).toEqual(before);
    expect(await first(env.DB, `SELECT deleted_at, deleted_by FROM artifact_pages WHERE slug = ?`, SLUG)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("the same people as delete: another member gets the one 404 (the page stays hidden), an admin may", async () => {
    await del(AUTHOR);
    const res = await restore(OTHER);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND);
    expect((await first<{ deleted_by: string }>(env.DB, `SELECT deleted_by FROM artifact_pages WHERE slug = ?`, SLUG))!.deleted_by).toBe(AUTHOR);
    expect((await restore(ADMIN)).status).toBe(200);
  });

  it("a live page is 409 not deleted; an unknown one the one 404", async () => {
    const res = await restore(AUTHOR);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", message: "artifact is not deleted" });
    await expect(restorePage(systemCtx(), "no-such-page", AUTHOR, false)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("a deleted page's slug stays reserved", () => {
  it("a new page with the same title never takes the slug: it gets -2, and the restore still finds the original", async () => {
    await del(AUTHOR);
    const again = await createText(await cookieFor(OTHER), { title: "Zebra page", content: "a different zebra" });
    expect(again.slug).toBe(`${SLUG}-2`);
    const up = await mcpCall(OTHER, "upload_asset", { title: "Zebra page", kind: "markdown", area: "ui", repo: "", visibility: "org", content: "third" });
    expect(up.body.slug).toBe(`${SLUG}-3`);
    expect((await restore(AUTHOR)).status).toBe(200);
    const d = (await (await get(`/api/artifacts/${SLUG}`, await cookieFor(OTHER))).json()) as ArtifactDetailDTO;
    expect(d.author_id).toBe(AUTHOR);
    expect(d.current_version).toBe(2);
  });
});

describe("a handle rename rewrites deleted_by", () => {
  it("deleted_by follows the person, and they can still restore", async () => {
    await del(AUTHOR);
    expect(await renamePerson(platformCtx(), AUTHOR, "adel-renamed")).toEqual({ ok: true });
    expect(await first(env.DB, `SELECT author_id, deleted_by FROM artifact_pages WHERE slug = ?`, SLUG)).toEqual({ author_id: "adel-renamed", deleted_by: "adel-renamed" });
    expect((await restore("adel-renamed")).status).toBe(200);
  });
});
