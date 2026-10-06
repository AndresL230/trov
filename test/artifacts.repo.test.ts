// The artifacts repository (Track A) on a real Miniflare D1 + local R2. Every rule in
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md "Track A" and
// shared/artifacts-core.ts has a test here.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run, nowIso } from "../src/db";
import {
  ArtifactError, ARTIFACT_ERROR_STATUS, slugify, uniqueSlug, ftsBody, binaryContentType, sha256Hex,
  createPage, addTextVersion, addBinaryVersion, patchPage, setStatus, ratify, addLink, removeLink,
  listPages, getPage, getVersionPair, readRaw, searchArtifacts, mintUploadToken, consumeUploadToken,
  normalizeLinkRef,
} from "../src/tools/artifacts";
import { ARTIFACT_TEXT_CAP, ARTIFACT_BINARY_CAP, type ArtifactDetailDTO } from "@shared/artifacts";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

const DB = () => env.DB;
const BUCKET = () => env.ARTIFACTS_BUCKET;
const ME = "AndresL230";
const YOU = "Jose-Gael-Cruz-Lopez";

/** The thrown ArtifactError (fails the test if nothing, or something else, is thrown). */
async function errOf(p: Promise<unknown>): Promise<ArtifactError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ArtifactError);
    return e as ArtifactError;
  }
  throw new Error("expected an ArtifactError, nothing was thrown");
}

const mkText = (o: Partial<{ title: string; kind: "html" | "markdown" | "svg" | "mermaid"; content: string; area: "auth" | "ui" | "api" | "data" | "infra" | "architecture"; repo: string; visibility: "org" | "private"; summary: string; links: { target_type: "ticket" | "sprint" | "pr" | "issue"; target_ref: string }[] }> = {}, who = ME) =>
  createPage(DB(), {
    title: o.title ?? "Auth flow", kind: o.kind ?? "markdown", content: o.content ?? "# Hello\n\nworld",
    area: o.area ?? "auth", repo: o.repo, visibility: o.visibility, summary: o.summary, links: o.links,
  }, who);

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const streamOf = (b: Uint8Array): ReadableStream<Uint8Array> => new Response(b).body!;

async function seedTicket(title = "Fix login", status = "in_progress"): Promise<number> {
  const now = nowIso();
  const r = await run(DB(), `INSERT INTO tickets (title, requester, status, created_at, updated_at) VALUES (?, 'meilin', ?, ?, ?)`, title, status, now, now);
  return r.meta.last_row_id as number;
}
async function seedSprint(title = "Sprint 7", status = "in_progress", dates: string | null = "Sep 16 – Sep 30"): Promise<number> {
  const r = await run(DB(), `INSERT INTO sprints (title, target_date, status, dates, created_at, created_by) VALUES (?, '2026-09-30', ?, ?, ?, 'AndresL230')`, title, status, dates, nowIso());
  return r.meta.last_row_id as number;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("slugify / uniqueSlug", () => {
  it("lowercases, folds diacritics, dashes runs of non-alphanumerics, trims, caps at 60", () => {
    expect(slugify("  Auth Flow — v2!  ")).toBe("auth-flow-v2");
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("artifact");
    expect(slugify("")).toBe("artifact");
    const long = slugify("a".repeat(59) + " bbbb");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
  });

  it("suffixes -2, -3 on collision; treats 'new' as taken; cuts the base so base-N fits 60", async () => {
    await mkText({ title: "Auth flow" });
    await mkText({ title: "Auth flow" });
    expect((await mkText({ title: "Auth flow" })).slug).toBe("auth-flow-3");
    expect(await uniqueSlug(DB(), "New")).toBe("new-2");
    const t = "x".repeat(60);
    expect((await mkText({ title: t })).slug).toBe(t);
    const second = await mkText({ title: t });
    expect(second.slug).toBe("x".repeat(58) + "-2");
    expect(second.slug.length).toBe(60);
  });
});

describe("ftsBody / binaryContentType", () => {
  it("strips html/svg tags, scripts and styles; keeps markdown/mermaid raw; binary has no body", () => {
    expect(ftsBody("html", `<div class="zebra"><script>var q=1</script><style>.a{}</style><p>Hello &amp; bye</p></div>`)).toBe("Hello & bye");
    expect(ftsBody("svg", `<svg><text x="1">Label</text></svg>`)).toBe("Label");
    expect(ftsBody("markdown", "# <b>raw</b>")).toBe("# <b>raw</b>");
    expect(ftsBody("image", "whatever")).toBe("");
  });

  it("image only takes the allowed types (inferred from the extension); pdf is forced; file refuses active types", () => {
    expect(binaryContentType("image", "image/PNG; x=1", null)).toBe("image/png");
    expect(binaryContentType("image", null, "shot.JPG")).toBe("image/jpeg");
    expect(() => binaryContentType("image", "image/svg+xml", null)).toThrow(ArtifactError);
    expect(() => binaryContentType("image", null, "x.bmp")).toThrow(ArtifactError);
    expect(binaryContentType("pdf", "text/html", null)).toBe("application/pdf");
    expect(binaryContentType("file", "application/zip", null)).toBe("application/zip");
    expect(binaryContentType("file", "text/html", null)).toBe("application/octet-stream");
    expect(binaryContentType("file", "image/svg+xml", null)).toBe("application/octet-stream");
    expect(binaryContentType("file", "not a mime", null)).toBe("application/octet-stream");
    expect(binaryContentType("file", null, null)).toBe("application/octet-stream");
  });

  it("maps every error code onto its status", () => {
    expect(ARTIFACT_ERROR_STATUS).toEqual({ not_found: 404, forbidden: 403, bad_request: 400, conflict: 409, too_large: 413, gone: 410 });
  });
});

// ── create / text versions ───────────────────────────────────────────────────

describe("createPage (text)", () => {
  it("writes v1 as a draft, with the version, FTS row and DTO in one go", async () => {
    const a = await mkText({ title: "Auth flow", kind: "markdown", content: "# Auth\n\nsessions", summary: "first cut", repo: "AndresL230/trov" });
    expect(a).toMatchObject({
      slug: "auth-flow", title: "Auth flow", kind: "markdown", area: "auth", repo: "AndresL230/trov", author_id: ME,
      status: "draft", visibility: "org", current_version: 1, ratified_version: null, ratified_by: null, ratified_at: null,
      content: "# Auth\n\nsessions", raw_url: "/raw/a/auth-flow@v1", excerpt: "# Auth\n\nsessions", ticket_ids: [], sprint_ids: [],
    });
    expect(a.versions).toHaveLength(1);
    expect(a.version).toMatchObject({ version_no: 1, summary: "first cut", created_by: ME, content_type: "text/markdown; charset=utf-8", size_bytes: 16 });
    expect(a.version.sha256).toBe(await sha256Hex("# Auth\n\nsessions"));
    expect(a.updated_at).toBe(a.version.created_at);
    const fts = await all<{ title: string; description: string; body: string }>(DB(), `SELECT title, description, body FROM artifacts_fts WHERE page_id = ?`, String(a.id));
    expect(fts).toEqual([{ title: "Auth flow", description: "first cut", body: "# Auth\n\nsessions" }]);
  });

  it("refuses a bad area / kind / repo / empty title, and text over the 750 KB cap (413); exactly the cap is fine", async () => {
    expect((await errOf(createPage(DB(), { title: "x", kind: "markdown", content: "c", area: "nope" as "ui" }, ME))).code).toBe("bad_request");
    expect((await errOf(createPage(DB(), { title: "x", kind: "docx" as "markdown", content: "c", area: "ui" }, ME))).code).toBe("bad_request");
    expect((await errOf(createPage(DB(), { title: "x", kind: "markdown", content: "c", area: "ui", repo: "not a repo" }, ME))).code).toBe("bad_request");
    expect((await errOf(createPage(DB(), { title: "   ", kind: "markdown", content: "c", area: "ui" }, ME))).code).toBe("bad_request");
    const over = await errOf(mkText({ content: "a".repeat(ARTIFACT_TEXT_CAP + 1) }));
    expect(over.code).toBe("too_large");
    // UTF-8 bytes, not characters: 3-byte chars count 3.
    expect((await errOf(mkText({ content: "€".repeat(Math.floor(ARTIFACT_TEXT_CAP / 3) + 1) }))).code).toBe("too_large");
    const exact = await mkText({ content: "a".repeat(ARTIFACT_TEXT_CAP) });
    expect(exact.version.size_bytes).toBe(ARTIFACT_TEXT_CAP);
    expect(await all(DB(), `SELECT id FROM artifact_pages`)).toHaveLength(1);
  });

  it("the migration's CHECKs hold: content XOR r2_key, text ≤ the cap (0034), ratified ⇔ ratified_*", async () => {
    const a = await mkText();
    await expect(run(DB(), `INSERT INTO artifact_versions (page_id, version_no, content, r2_key, size_bytes, content_type, sha256, created_by, created_at) VALUES (?, 9, 'x', 'k', 1, 't', ?, 'a', 't')`, a.id, "0".repeat(64))).rejects.toThrow();
    await expect(run(DB(), `INSERT INTO artifact_versions (page_id, version_no, content, size_bytes, content_type, sha256, created_by, created_at) VALUES (?, 9, 'x', ?, 't', ?, 'a', 't')`, a.id, ARTIFACT_TEXT_CAP + 1, "0".repeat(64))).rejects.toThrow();
    await expect(run(DB(), `UPDATE artifact_pages SET status = 'ratified' WHERE id = ?`, a.id)).rejects.toThrow();
    await expect(run(DB(), `UPDATE artifact_pages SET ratified_by = 'x' WHERE id = ?`, a.id)).rejects.toThrow();
  });
});

describe("addTextVersion", () => {
  it("a later version publishes the page and moves updated_at; the same sha256 writes nothing", async () => {
    const a = await mkText({ content: "one" });
    const r = await addTextVersion(DB(), a.slug, { content: "two", summary: "second" }, YOU);
    expect(r.unchanged).toBe(false);
    expect(r.version_no).toBe(2);
    expect(r.page).toMatchObject({ status: "published", current_version: 2, content: "two" });
    expect(r.page.version.created_by).toBe(YOU);
    expect(r.page.updated_at).toBe(r.page.version.created_at);
    const fts = await first<{ description: string; body: string }>(DB(), `SELECT description, body FROM artifacts_fts WHERE page_id = ?`, String(a.id));
    expect(fts).toEqual({ description: "second", body: "two" });

    const same = await addTextVersion(DB(), a.slug, { content: "two", summary: "again" }, ME);
    expect(same.unchanged).toBe(true);
    expect(same.version_no).toBe(2);
    expect(await all(DB(), `SELECT id FROM artifact_versions WHERE page_id = ?`, a.id)).toHaveLength(2);
    // Only the CURRENT version counts: going back to v1's content is a new version.
    expect((await addTextVersion(DB(), a.slug, { content: "one" }, ME)).version_no).toBe(3);
  });

  it("old_str → new_str must match exactly once", async () => {
    const a = await mkText({ content: "alpha beta beta" });
    const r = await addTextVersion(DB(), a.slug, { old_str: "alpha", new_str: "gamma" }, ME);
    expect(r.page.content).toBe("gamma beta beta");
    expect((await errOf(addTextVersion(DB(), a.slug, { old_str: "beta", new_str: "x" }, ME))).code).toBe("bad_request");
    expect((await errOf(addTextVersion(DB(), a.slug, { old_str: "zeta", new_str: "x" }, ME))).code).toBe("bad_request");
    expect((await errOf(addTextVersion(DB(), a.slug, { old_str: "", new_str: "x" }, ME))).code).toBe("bad_request");
  });

  it("the edit result is capped too; a binary page refuses text", async () => {
    const a = await mkText({ content: "x" });
    expect((await errOf(addTextVersion(DB(), a.slug, { content: "a".repeat(ARTIFACT_TEXT_CAP + 1) }, ME))).code).toBe("too_large");
    const img = await createPage(DB(), { title: "Pic", kind: "image", area: "ui", bytes: bytesOf("png-bytes"), content_type: "image/png" }, ME, BUCKET());
    expect((await errOf(addTextVersion(DB(), img.slug, { content: "x" }, ME))).code).toBe("bad_request");
  });
});

// ── status / ratify ──────────────────────────────────────────────────────────

describe("status and ratify", () => {
  it("draft ⇄ published by anyone who can read it; 'ratified' is not a PATCH status", async () => {
    const a = await mkText();
    expect((await setStatus(DB(), a.slug, "published", YOU)).status).toBe("published");
    expect((await setStatus(DB(), a.slug, "draft", YOU)).status).toBe("draft");
    expect((await errOf(patchPage(DB(), a.slug, { status: "ratified" as "draft" }, ME))).code).toBe("bad_request");
  });

  it("ratify: draft → conflict; not the latest → conflict; published latest → ratified", async () => {
    const a = await mkText();
    const d = await errOf(ratify(DB(), a.slug, 1, ME));
    expect(d.code).toBe("conflict");
    expect(d.message).toBe("publish before ratifying");
    await addTextVersion(DB(), a.slug, { content: "v2" }, ME); // → published, v2
    expect((await errOf(ratify(DB(), a.slug, 1, ME))).code).toBe("conflict");
    expect((await errOf(ratify(DB(), a.slug, 3, ME))).code).toBe("conflict");
    const r = await ratify(DB(), a.slug, 2, YOU);
    expect(r).toMatchObject({ status: "ratified", ratified_version: 2, ratified_by: YOU });
    expect(r.ratified_at).toBeTruthy();
    expect((await errOf(ratify(DB(), a.slug, 2, ME))).code).toBe("conflict"); // already ratified
  });

  it("a new version after ratify → published, ratified_* cleared", async () => {
    const a = await mkText();
    await setStatus(DB(), a.slug, "published", ME);
    await ratify(DB(), a.slug, 1, ME);
    const r = await addTextVersion(DB(), a.slug, { content: "changed" }, ME);
    expect(r.page).toMatchObject({ status: "published", ratified_version: null, ratified_by: null, ratified_at: null });
  });

  it("→ draft or → published from ratified clears ratified_*", async () => {
    for (const to of ["draft", "published"] as const) {
      const a = await mkText({ title: `R ${to}` });
      await setStatus(DB(), a.slug, "published", ME);
      await ratify(DB(), a.slug, 1, ME);
      const r = await setStatus(DB(), a.slug, to, ME);
      expect(r).toMatchObject({ status: to, ratified_version: null, ratified_by: null, ratified_at: null });
    }
  });

  it("patch title / area / repo keeps the slug and updated_at, and re-titles the FTS row", async () => {
    const a = await mkText({ title: "Old title" });
    const r = await patchPage(DB(), a.slug, { title: "New shiny title", area: "data", repo: "SaplingLearn/sapling" }, YOU);
    expect(r).toMatchObject({ slug: "old-title", title: "New shiny title", area: "data", repo: "SaplingLearn/sapling", updated_at: a.updated_at });
    expect((await searchArtifacts(DB(), "shiny", ME)).map((h) => h.slug)).toEqual(["old-title"]);
    expect((await errOf(patchPage(DB(), a.slug, { area: "nope" as "ui" }, ME))).code).toBe("bad_request");
  });
});

// ── visibility + 404 parity ──────────────────────────────────────────────────

describe("visibility", () => {
  it("a private page is invisible to everyone but its author — list, get, raw, pair, search, writes", async () => {
    const a = await mkText({ title: "Secret plan", visibility: "private", content: "classified words" });
    expect((await listPages(DB(), {}, ME)).map((p) => p.slug)).toEqual([a.slug]);
    expect(await listPages(DB(), {}, YOU)).toEqual([]);
    expect((await getPage(DB(), a.slug, null, "andresl230")).slug).toBe(a.slug); // handle match is case-insensitive
    expect((await searchArtifacts(DB(), "classified", ME)).length).toBe(1);
    expect(await searchArtifacts(DB(), "classified", YOU)).toEqual([]);
    for (const call of [
      () => getPage(DB(), a.slug, null, YOU), () => readRaw(DB(), BUCKET(), a.slug, null, YOU), () => getVersionPair(DB(), a.slug, 1, 1, YOU),
      () => addTextVersion(DB(), a.slug, { content: "x" }, YOU), () => setStatus(DB(), a.slug, "published", YOU),
      () => ratify(DB(), a.slug, 1, YOU), () => addLink(DB(), a.slug, { target_type: "pr", target_ref: "a/b#1" }, YOU),
      () => removeLink(DB(), a.slug, { target_type: "pr", target_ref: "a/b#1" }, YOU), () => patchPage(DB(), a.slug, { title: "x" }, YOU),
    ]) expect((await errOf(call())).code).toBe("not_found");
  });

  it("only the author may make a page private; publishing private → org also moves draft → published", async () => {
    const a = await mkText();
    const f = await errOf(patchPage(DB(), a.slug, { visibility: "private" }, YOU));
    expect(f.code).toBe("forbidden");
    expect((await patchPage(DB(), a.slug, { visibility: "private" }, ME)).visibility).toBe("private");
    const pub = await patchPage(DB(), a.slug, { visibility: "org" }, ME);
    expect(pub).toMatchObject({ visibility: "org", status: "published" });
    // An explicit status in the same PATCH wins over the private → org rule.
    const b = await mkText({ title: "Explicit", visibility: "private" });
    expect(await patchPage(DB(), b.slug, { visibility: "org", status: "draft" }, ME)).toMatchObject({ visibility: "org", status: "draft" });
    // A ratified private page stays ratified when published to the org.
    await ratify(DB(), a.slug, 1, ME);
    await patchPage(DB(), a.slug, { visibility: "private" }, ME);
    expect((await patchPage(DB(), a.slug, { visibility: "org" }, ME)).status).toBe("ratified");
  });

  it("404 parity: missing slug, private-to-someone-else and version-0 are the identical error", async () => {
    const priv = await mkText({ title: "Private one", visibility: "private" });
    const pending = await mintUploadToken(DB(), { kind: "pdf", size_bytes: 4, sha256: await sha256Hex("%PDF"), title: "Pending", area: "ui" }, YOU);
    const errs = [
      await errOf(getPage(DB(), "does-not-exist", null, YOU)),
      await errOf(getPage(DB(), priv.slug, null, YOU)),
      await errOf(getPage(DB(), pending.slug, null, YOU)), // even to its own author
      await errOf(getPage(DB(), pending.slug, null, ME)),
      await errOf(getPage(DB(), "Not A Slug!", null, YOU)),
    ];
    for (const e of errs) expect({ code: e.code, message: e.message, name: e.name }).toEqual({ code: "not_found", message: "not_found", name: "ArtifactError" });
  });
});

// ── links ────────────────────────────────────────────────────────────────────

describe("links", () => {
  it("normalizes refs: ticket/sprint ids must exist; pr/issue from #n, n, owner/repo#n or a GitHub URL", async () => {
    const t = await seedTicket();
    const s = await seedSprint();
    const repo = "AndresL230/trov";
    expect(await normalizeLinkRef(DB(), "ticket", `#${t}`, repo)).toBe(String(t));
    expect(await normalizeLinkRef(DB(), "sprint", String(s), repo)).toBe(String(s));
    expect((await errOf(normalizeLinkRef(DB(), "ticket", "99999", repo))).code).toBe("bad_request");
    expect((await errOf(normalizeLinkRef(DB(), "sprint", "abc", repo))).code).toBe("bad_request");
    expect(await normalizeLinkRef(DB(), "pr", "#212", repo)).toBe("AndresL230/trov#212");
    expect(await normalizeLinkRef(DB(), "issue", "198", repo)).toBe("AndresL230/trov#198");
    expect(await normalizeLinkRef(DB(), "pr", "other/repo#7", "")).toBe("other/repo#7");
    expect(await normalizeLinkRef(DB(), "pr", "https://github.com/SaplingLearn/sapling/pull/658/files", "")).toBe("SaplingLearn/sapling#658");
    expect(await normalizeLinkRef(DB(), "issue", "https://github.com/SaplingLearn/sapling/issues/12", "")).toBe("SaplingLearn/sapling#12");
    expect((await errOf(normalizeLinkRef(DB(), "pr", "#5", ""))).code).toBe("bad_request"); // no repo to resolve against
    expect((await errOf(normalizeLinkRef(DB(), "pr", "https://evil.com/a/b/pull/1", repo))).code).toBe("bad_request");
    expect((await errOf(normalizeLinkRef(DB(), "wiki" as "pr", "1", repo))).code).toBe("bad_request");
  });

  it("add / remove are idempotent and resolve display labels", async () => {
    const t = await seedTicket("Fix login", "in_progress");
    const s = await seedSprint("Sprint 7", "in_progress", "Sep 16 – Sep 30");
    const s2 = await seedSprint("Sprint 8", "upcoming", null);
    const a = await mkText({ repo: "AndresL230/trov", links: [{ target_type: "ticket", target_ref: String(t) }, { target_type: "ticket", target_ref: `#${t}` }] });
    expect(a.links).toEqual([{ target_type: "ticket", target_ref: String(t), label: "Fix login", meta: "in_progress" }]);
    await addLink(DB(), a.slug, { target_type: "sprint", target_ref: String(s) }, YOU);
    await addLink(DB(), a.slug, { target_type: "sprint", target_ref: String(s2) }, YOU);
    await addLink(DB(), a.slug, { target_type: "pr", target_ref: "#212" }, YOU);
    const d = await addLink(DB(), a.slug, { target_type: "issue", target_ref: "https://github.com/AndresL230/trov/issues/198" }, YOU);
    await addLink(DB(), a.slug, { target_type: "pr", target_ref: "212" }, YOU); // duplicate → no-op
    expect(d.links).toEqual([
      { target_type: "ticket", target_ref: String(t), label: "Fix login", meta: "in_progress" },
      { target_type: "sprint", target_ref: String(s), label: "Sprint 7", meta: "Sep 16 – Sep 30 · ACTIVE" },
      { target_type: "sprint", target_ref: String(s2), label: "Sprint 8", meta: "" },
      { target_type: "pr", target_ref: "AndresL230/trov#212", label: "#212", meta: "PULL REQUEST · AndresL230/trov" },
      { target_type: "issue", target_ref: "AndresL230/trov#198", label: "#198", meta: "ISSUE · AndresL230/trov" },
    ]);
    expect(d.ticket_ids).toEqual([t]);
    expect(d.sprint_ids).toEqual([s, s2]);
    expect(await all(DB(), `SELECT * FROM artifact_links WHERE page_id = ?`, a.id)).toHaveLength(5);

    // A target deleted later reads null, and can still be unlinked.
    await run(DB(), `DELETE FROM sprints WHERE id = ?`, s2);
    expect((await getPage(DB(), a.slug, null, ME)).links[2]).toEqual({ target_type: "sprint", target_ref: String(s2), label: null, meta: null });
    await removeLink(DB(), a.slug, { target_type: "sprint", target_ref: String(s2) }, ME);
    const after = await removeLink(DB(), a.slug, { target_type: "pr", target_ref: "#212" }, ME);
    await removeLink(DB(), a.slug, { target_type: "pr", target_ref: "#212" }, ME); // idempotent
    expect(after.links.map((l) => l.target_ref)).toEqual([String(t), String(s), "AndresL230/trov#198"]);
    expect(after.sprint_ids).toEqual([s]);
  });

  it("a create with a bad link writes nothing", async () => {
    expect((await errOf(mkText({ links: [{ target_type: "ticket", target_ref: "424242" }] }))).code).toBe("bad_request");
    expect(await all(DB(), `SELECT id FROM artifact_pages`)).toEqual([]);
  });
});

// ── library + search ─────────────────────────────────────────────────────────

describe("listPages", () => {
  it("sorts by the latest version's created_at, filters exactly, excerpts markdown/mermaid only", async () => {
    const t = await seedTicket();
    const s = await seedSprint();
    const md = await mkText({ title: "Doc one", kind: "markdown", area: "auth", content: "m".repeat(700), links: [{ target_type: "ticket", target_ref: String(t) }] });
    const html = await mkText({ title: "Page two", kind: "html", area: "ui", content: `<p class="zebra">giraffe</p>` }, YOU);
    const mer = await mkText({ title: "Graph three", kind: "mermaid", area: "data", content: "graph TD; A-->B", links: [{ target_type: "sprint", target_ref: String(s) }] });
    await run(DB(), `UPDATE artifact_pages SET updated_at = '2026-01-0' || id || 'T00:00:00.000Z'`); // pin order: md < html < mer
    expect((await listPages(DB(), {}, ME)).map((p) => p.slug)).toEqual([mer.slug, html.slug, md.slug]);
    await addTextVersion(DB(), md.slug, { content: "fresh" }, ME); // bumps md to the top
    const list = await listPages(DB(), {}, ME);
    expect(list.map((p) => p.slug)).toEqual([md.slug, mer.slug, html.slug]);
    expect(list[0]).toMatchObject({ excerpt: "fresh", size_bytes: 5, ticket_ids: [t], sprint_ids: [], current_version: 2 });
    expect(list.find((p) => p.slug === html.slug)!.excerpt).toBeNull();
    expect(list.find((p) => p.slug === mer.slug)).toMatchObject({ excerpt: "graph TD; A-->B", sprint_ids: [s] });
    expect((await mkText({ title: "Long md", content: "z".repeat(700) })).excerpt).toHaveLength(600);

    const slugs = async (f: Parameters<typeof listPages>[1]) => (await listPages(DB(), f, ME)).map((p) => p.slug).sort();
    expect(await slugs({ area: "ui" })).toEqual([html.slug]);
    expect(await slugs({ kind: "mermaid" })).toEqual([mer.slug]);
    expect(await slugs({ author: "jose-gael-cruz-lopez" })).toEqual([html.slug]);
    expect(await slugs({ status: "published" })).toEqual([md.slug]);
    expect(await slugs({ ticket: String(t) })).toEqual([md.slug]);
    expect(await slugs({ sprint: `#${s}` })).toEqual([mer.slug]);
    expect(await slugs({ sprint: "garbage" })).toEqual([]);
    expect((await slugs({ area: "all", kind: "all" })).length).toBe(4);
    expect(await slugs({ q: "giraffe" })).toEqual([html.slug]); // FTS body
    expect(await slugs({ q: "zebra" })).toEqual([]); // attribute text is stripped
    expect(await slugs({ q: "grap" })).toEqual([mer.slug]); // title substring
    expect(await slugs({ q: "%" })).toEqual([]); // LIKE wildcards are escaped
  });
});

describe("searchArtifacts", () => {
  it("ranks a title hit above a body hit, hides private/pending pages, and returns [] for no match", async () => {
    await mkText({ title: "Unrelated", content: "the rocket launches at dawn" });
    await mkText({ title: "Rocket design", content: "notes" });
    await mkText({ title: "Rocket private", content: "x", visibility: "private" }, YOU);
    const hits = await searchArtifacts(DB(), "rocket", ME);
    expect(hits.map((h) => h.slug)).toEqual(["rocket-design", "unrelated"]);
    expect(hits[0]).toMatchObject({ kind: "markdown", status: "draft", visibility: "org", current_version: 1, description: "" });
    expect(typeof hits[0].rank).toBe("number");
    expect(hits[1].snippet).toContain("rocket");
    expect(await searchArtifacts(DB(), "!!!", ME)).toEqual([]);
    await mintUploadToken(DB(), { kind: "pdf", size_bytes: 4, sha256: "a".repeat(64), title: "Rocket pending", area: "ui" }, ME);
    expect((await searchArtifacts(DB(), "rocket", ME)).map((h) => h.slug)).toEqual(["rocket-design", "unrelated"]);
  });
});

describe("getPage / getVersionPair / readRaw (text)", () => {
  it("serves any existing version and refuses the rest", async () => {
    const a = await mkText({ kind: "html", content: "<p>one</p>" });
    await addTextVersion(DB(), a.slug, { content: "<p>two</p>" }, ME);
    const v1 = await getPage(DB(), a.slug, 1, ME);
    expect(v1).toMatchObject({ content: "<p>one</p>", raw_url: `/raw/a/${a.slug}@v1`, current_version: 2 });
    expect(v1.version.version_no).toBe(1);
    expect(v1.versions.map((v) => v.version_no)).toEqual([1, 2]);
    for (const v of [0, 3, 1.5]) expect((await errOf(getPage(DB(), a.slug, v, ME))).code).toBe("not_found");
    const pair = await getVersionPair(DB(), a.slug, 1, 2, ME);
    expect(pair).toMatchObject({ kind: "html", a: { version_no: 1, content: "<p>one</p>", raw_url: `/raw/a/${a.slug}@v1` }, b: { version_no: 2, content: "<p>two</p>" } });
    expect((await errOf(getVersionPair(DB(), a.slug, 1, 9, ME))).code).toBe("not_found");
    const raw = await readRaw(DB(), BUCKET(), a.slug, null, ME);
    expect(raw).toMatchObject({ slug: a.slug, kind: "html", version_no: 2, content_type: "text/html; charset=utf-8", text: "<p>two</p>", object: null });
    expect((await readRaw(DB(), BUCKET(), a.slug, 1, ME)).text).toBe("<p>one</p>");
  });
});

// ── binary: bytes in hand ────────────────────────────────────────────────────

describe("binary versions with the bytes in hand", () => {
  it("puts the bytes at artifacts/<sha256>, stores the key (no content), and serves them back", async () => {
    const png = bytesOf("\x89PNG fake image bytes");
    const sha = await sha256Hex(png);
    const a = await createPage(DB(), { title: "Screenshot", kind: "image", area: "ui", bytes: png, content_type: "image/png", filename: "../../shot.png", summary: "v1" }, ME, BUCKET());
    expect(a).toMatchObject({ status: "draft", current_version: 1, content: null, excerpt: null, size_bytes: png.byteLength });
    expect(a.version).toMatchObject({ sha256: sha, content_type: "image/png", size_bytes: png.byteLength });
    const row = await first<{ content: string | null; r2_key: string; filename: string }>(DB(), `SELECT content, r2_key, filename FROM artifact_versions WHERE page_id = ?`, a.id);
    expect(row).toEqual({ content: null, r2_key: `artifacts/${sha}`, filename: "shot.png" });
    const obj = await BUCKET().get(`artifacts/${sha}`);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(png);
    const raw = await readRaw(DB(), BUCKET(), a.slug, null, ME);
    expect(raw).toMatchObject({ kind: "image", content_type: "image/png", filename: "shot.png", text: null });
    expect(new Uint8Array(await raw.object!.arrayBuffer())).toEqual(png);
    expect(await first(DB(), `SELECT body FROM artifacts_fts WHERE page_id = ?`, String(a.id))).toEqual({ body: "" });

    // Same bytes → unchanged; new bytes → v2, published.
    expect((await addBinaryVersion(DB(), BUCKET(), a.slug, { bytes: png, content_type: "image/png" }, YOU)).unchanged).toBe(true);
    const r = await addBinaryVersion(DB(), BUCKET(), a.slug, { bytes: bytesOf("other"), content_type: "image/webp" }, YOU);
    expect(r).toMatchObject({ unchanged: false, version_no: 2 });
    expect(r.page).toMatchObject({ status: "published" });
    expect(r.page.version.content_type).toBe("image/webp");
  });

  it("enforces content types, the 10 MB cap, non-empty bytes, and that kind never changes", async () => {
    const mk = (kind: "image" | "pdf" | "file", bytes: Uint8Array, content_type?: string) =>
      createPage(DB(), { title: `${kind} thing`, kind, area: "ui", bytes, content_type }, ME, BUCKET());
    expect((await errOf(mk("image", bytesOf("x"), "image/svg+xml"))).code).toBe("bad_request");
    expect((await mk("pdf", bytesOf("%PDF-1.7"), "text/html")).version.content_type).toBe("application/pdf");
    expect((await mk("file", bytesOf("<html>"), "text/html")).version.content_type).toBe("application/octet-stream");
    expect((await errOf(mk("file", new Uint8Array(0)))).code).toBe("bad_request");
    expect((await errOf(mk("file", new Uint8Array(ARTIFACT_BINARY_CAP + 1)))).code).toBe("too_large");
    const text = await mkText();
    expect((await errOf(addBinaryVersion(DB(), BUCKET(), text.slug, { bytes: bytesOf("x") }, ME))).code).toBe("bad_request");
  });
});

// ── binary: upload tokens ────────────────────────────────────────────────────

describe("upload tokens", () => {
  const PDF = bytesOf("%PDF-1.7 hello world");

  async function mintNew(who = ME, extra: Partial<{ visibility: "org" | "private" }> = {}) {
    return mintUploadToken(DB(), { kind: "pdf", size_bytes: PDF.byteLength, sha256: await sha256Hex(PDF), content_type: "application/pdf", filename: "spec.pdf", summary: "the spec", title: "Spec PDF", area: "api", ...extra }, who);
  }

  it("a new page is created at version 0 — invisible — and lands as a v1 draft on the PUT", async () => {
    const m = await mintNew();
    expect(m).toMatchObject({ slug: "spec-pdf", upload_url: `/api/artifacts/upload/${m.token}` });
    expect(Date.parse(m.expires_at) - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    expect(Date.parse(m.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    // Only the hash is stored.
    const tok = await all<{ token_hash: string }>(DB(), `SELECT token_hash FROM artifact_upload_tokens`);
    expect(tok).toEqual([{ token_hash: await sha256Hex(m.token) }]);
    expect(await listPages(DB(), {}, ME)).toEqual([]);
    expect((await errOf(getPage(DB(), m.slug, null, ME))).code).toBe("not_found");

    const r = await consumeUploadToken(DB(), BUCKET(), m.token, streamOf(PDF));
    expect(r).toMatchObject({ unchanged: false, version_no: 1 });
    expect(r.page).toMatchObject({ slug: "spec-pdf", kind: "pdf", status: "draft", current_version: 1, author_id: ME });
    expect(r.page.version).toMatchObject({ summary: "the spec", content_type: "application/pdf", size_bytes: PDF.byteLength, created_by: ME });
    const raw = await readRaw(DB(), BUCKET(), m.slug, 1, YOU);
    expect(new Uint8Array(await raw.object!.arrayBuffer())).toEqual(PDF);
    expect(raw.object!.httpMetadata?.contentType).toBe("application/pdf");

    // Single use → 410.
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(PDF)))).code).toBe("gone");
  });

  it("unknown → not_found; expired → gone", async () => {
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), "nope", streamOf(PDF)))).code).toBe("not_found");
    const m = await mintNew();
    await run(DB(), `UPDATE artifact_upload_tokens SET expires_at = '2020-01-01T00:00:00.000Z'`);
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(PDF)))).code).toBe("gone");
  });

  it("a short, long or wrong-hash body is refused (400), writes nothing, and releases the claim", async () => {
    // R2 is NOT reset between tests (only D1 is), so this test's bytes are its own.
    const BODY = bytesOf("%PDF-1.7 refusal-test body");
    const m = await mintUploadToken(DB(), { kind: "pdf", size_bytes: BODY.byteLength, sha256: await sha256Hex(BODY), title: "Refusals", area: "api" }, ME);
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(BODY.slice(0, 5))))).code).toBe("bad_request");
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(bytesOf("%PDF-1.7 refusal-test body!!"))))).code).toBe("bad_request");
    const sameLen = bytesOf("%PDF-1.7 REFUSAL-TEST BODY");
    expect(sameLen.byteLength).toBe(BODY.byteLength);
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(sameLen)))).code).toBe("bad_request");
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, null))).code).toBe("bad_request");
    expect(await BUCKET().get(`artifacts/${await sha256Hex(BODY)}`)).toBeNull();
    expect(await all(DB(), `SELECT id FROM artifact_versions`)).toEqual([]);
    // The same token still works with the right bytes.
    expect((await consumeUploadToken(DB(), BUCKET(), m.token, streamOf(BODY))).version_no).toBe(1);
  });

  it("knowing an existing object's sha256 never attaches it without its bytes", async () => {
    const secret = bytesOf("someone else's confidential pdf");
    const sha = await sha256Hex(secret);
    await createPage(DB(), { title: "Theirs", kind: "pdf", area: "ui", bytes: secret, visibility: "private" }, YOU, BUCKET());
    const m = await mintUploadToken(DB(), { kind: "pdf", size_bytes: secret.byteLength, sha256: sha, title: "Mine", area: "ui" }, ME);
    const junk = new Uint8Array(secret.byteLength).fill(65);
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(junk)))).code).toBe("bad_request");
    expect((await errOf(getPage(DB(), m.slug, null, ME))).code).toBe("not_found");
    // The stored object is untouched.
    expect(new Uint8Array(await (await BUCKET().get(`artifacts/${sha}`))!.arrayBuffer())).toEqual(secret);
  });

  it("minting for an existing page: kind must match, sha of the current version → unchanged on PUT", async () => {
    const a = await createPage(DB(), { title: "Doc", kind: "pdf", area: "ui", bytes: PDF }, ME, BUCKET());
    expect((await errOf(mintUploadToken(DB(), { slug: a.slug, kind: "image", size_bytes: 3, sha256: "b".repeat(64), content_type: "image/png" }, ME))).code).toBe("bad_request");
    const m = await mintUploadToken(DB(), { slug: a.slug, kind: "pdf", size_bytes: PDF.byteLength, sha256: await sha256Hex(PDF) }, YOU);
    expect(m.slug).toBe(a.slug);
    const r = await consumeUploadToken(DB(), BUCKET(), m.token, streamOf(PDF));
    expect(r).toMatchObject({ unchanged: true, version_no: 1 });
    const next = bytesOf("%PDF-1.7 v2");
    const m2 = await mintUploadToken(DB(), { slug: a.slug, kind: "pdf", size_bytes: next.byteLength, sha256: (await sha256Hex(next)).toUpperCase() }, YOU);
    const r2 = await consumeUploadToken(DB(), BUCKET(), m2.token, streamOf(next));
    expect(r2).toMatchObject({ unchanged: false, version_no: 2 });
    expect(r2.page).toMatchObject({ status: "published", current_version: 2 });
    expect(r2.page.version.created_by).toBe(YOU);
  });

  it("validates the ticket request: binary kinds only, size 1..10 MB, a 64-hex sha256, new-page fields", async () => {
    const sha = "c".repeat(64);
    expect((await errOf(mintUploadToken(DB(), { kind: "markdown" as "pdf", size_bytes: 1, sha256: sha, title: "x", area: "ui" }, ME))).code).toBe("bad_request");
    expect((await errOf(mintUploadToken(DB(), { kind: "pdf", size_bytes: 0, sha256: sha, title: "x", area: "ui" }, ME))).code).toBe("bad_request");
    expect((await errOf(mintUploadToken(DB(), { kind: "pdf", size_bytes: ARTIFACT_BINARY_CAP + 1, sha256: sha, title: "x", area: "ui" }, ME))).code).toBe("too_large");
    expect((await errOf(mintUploadToken(DB(), { kind: "pdf", size_bytes: 1, sha256: "xyz", title: "x", area: "ui" }, ME))).code).toBe("bad_request");
    expect((await errOf(mintUploadToken(DB(), { kind: "pdf", size_bytes: 1, sha256: sha }, ME))).code).toBe("bad_request");
    expect((await errOf(mintUploadToken(DB(), { kind: "image", size_bytes: 1, sha256: sha, content_type: "image/tiff", title: "x", area: "ui" }, ME))).code).toBe("bad_request");
    expect(await all(DB(), `SELECT id FROM artifact_pages`)).toEqual([]);
    expect(await all(DB(), `SELECT token_hash FROM artifact_upload_tokens`)).toEqual([]);
  });

  it("re-checks visibility at the PUT; a pending page is re-mintable by its author only", async () => {
    const a = await createPage(DB(), { title: "Shared", kind: "file", area: "ui", bytes: bytesOf("abc") }, ME, BUCKET());
    const m = await mintUploadToken(DB(), { slug: a.slug, kind: "file", size_bytes: 3, sha256: await sha256Hex("xyz") }, YOU);
    await patchPage(DB(), a.slug, { visibility: "private" }, ME); // the author hides it before the PUT lands
    expect((await errOf(consumeUploadToken(DB(), BUCKET(), m.token, streamOf(bytesOf("xyz"))))).code).toBe("not_found");

    const p = await mintNew(ME);
    expect((await errOf(mintUploadToken(DB(), { slug: p.slug, kind: "pdf", size_bytes: PDF.byteLength, sha256: await sha256Hex(PDF) }, YOU))).code).toBe("not_found");
    const again = await mintUploadToken(DB(), { slug: p.slug, kind: "pdf", size_bytes: PDF.byteLength, sha256: await sha256Hex(PDF) }, ME);
    expect((await consumeUploadToken(DB(), BUCKET(), again.token, streamOf(PDF))).page.current_version).toBe(1);
  });

  it("a new page minted with links and private visibility keeps both", async () => {
    const t = await seedTicket();
    const m = await mintUploadToken(DB(), { kind: "file", size_bytes: 3, sha256: await sha256Hex("zip"), title: "Bundle", area: "infra", visibility: "private", links: [{ target_type: "ticket", target_ref: String(t) }] }, YOU);
    const r = await consumeUploadToken(DB(), BUCKET(), m.token, streamOf(bytesOf("zip")));
    expect(r.page).toMatchObject({ visibility: "private", ticket_ids: [t], author_id: YOU });
    expect((await errOf(getPage(DB(), m.slug, null, ME))).code).toBe("not_found");
  });
});

// ── harness ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("the harness truncation clears every artifact table and cascades the FTS index", async () => {
    const a: ArtifactDetailDTO = await mkText({ links: [{ target_type: "ticket", target_ref: String(await seedTicket()) }] });
    await mintNew2();
    await env.DB.exec(RESET_STATEMENTS.join("; ") + ";");
    for (const t of ["artifact_pages", "artifact_versions", "artifact_links", "artifact_upload_tokens", "artifacts_fts"]) {
      expect((await first<{ n: number }>(DB(), `SELECT COUNT(*) AS n FROM ${t}`))!.n, t).toBe(0);
    }
    expect(a.id).toBeGreaterThan(0);
  });
});

async function mintNew2() {
  return mintUploadToken(DB(), { kind: "file", size_bytes: 1, sha256: "d".repeat(64), title: "Pending", area: "ui" }, ME);
}
