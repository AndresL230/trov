/**
 * The Docs screen's reads send no body they do not show (feed-and-search.md › The Docs screen's reads):
 * GET /docs is every doc's metadata + its server-built outline, GET /doc/:slug the live body with its
 * versions' metadata only, and GET /doc/:slug/versions/:version one version's body. MCP list_docs /
 * get_doc are unchanged (bodies included). A failed read is a 503 { error }, never a 500.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx, platformCtx, ORG_B } from "./helpers/tenant";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { seedPerson } from "./helpers/persons";
import { propose_doc_update, promote_doc } from "../src/tools/writes";
import { get_doc, list_docs } from "../src/tools/reads";
import { run } from "./helpers/db";
import type { Env } from "../src/env";

async function cookieFor(login: string): Promise<string> {
  await seedPerson(login);
  const { id } = await createSession(platformCtx(), login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

const V1 = "Intro.\n\n## Setup\n\nRun it.\n\n### Keys\n\n```\n## not a heading\n```\n\nV1 ONLY TEXT";
const V2 = "Intro.\n\n## Setup\n\nRun it again.\n\n## Setup\n\nV2 STAGED TEXT";

async function seedDoc(): Promise<void> {
  const p = (body: string) => ({ slug: "gate", section: "reference", title: "Gate", body, change_summary: "s", confidence: "high" as const });
  await propose_doc_update(systemCtx(), p(V1), "AndresL230");
  await promote_doc(systemCtx(), "gate", 1, "AndresL230");
  await propose_doc_update(systemCtx(), p(V2), "meilin"); // v2 stays staged
}

/** `path` is an org route's suffix, under SaplingLearn's prefix (the org every cookie here belongs to). */
async function get(cookie: string, path: string, e: Env = env): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
  const res = await app.request(`/api/o/saplinglearn${path}`, { headers: { cookie } }, e);
  const raw = await res.text();
  return { status: res.status, json: JSON.parse(raw) as Record<string, unknown>, raw };
}

describe("GET /docs — the Docs tree", () => {
  it("each doc's metadata and its H2/H3 outline, never its body", async () => {
    await seedDoc();
    const cookie = await cookieFor("AndresL230");
    const { status, json, raw } = await get(cookie, "/docs");
    expect(status).toBe(200);
    const [doc] = json.docs as Record<string, unknown>[];
    expect(doc).toMatchObject({ slug: "gate", title: "Gate", section: "reference", current_version: 1, owner: "AndresL230" });
    expect(doc).not.toHaveProperty("body");
    expect(doc.outline).toEqual([{ level: 2, text: "Setup", id: "setup" }, { level: 3, text: "Keys", id: "keys" }]);
    expect(raw).not.toContain("V1 ONLY TEXT");
    // `section` still narrows it.
    expect(((await get(cookie, "/docs?section=reference")).json.docs as unknown[]).length).toBe(1);
    expect((await get(cookie, "/docs?section=context")).json.docs).toEqual([]);
  });
});

describe("GET /doc/:slug — the reader", () => {
  it("the live body and tags, and every version without its body", async () => {
    await seedDoc();
    const { status, json, raw } = await get(await cookieFor("AndresL230"), "/doc/gate");
    expect(status).toBe(200);
    expect((json.doc as { body: string }).body).toBe(V1);
    expect(json.tags).toEqual([]);
    const versions = json.versions as Record<string, unknown>[];
    expect(versions.map((v) => [v.version, v.status, v.created_by])).toEqual([[1, "promoted", "AndresL230"], [2, "staged", "meilin"]]);
    for (const v of versions) {
      expect(v).not.toHaveProperty("body");
      expect(v).toHaveProperty("summary", "s");
      expect(v).toHaveProperty("change_kind");
    }
    expect(raw).not.toContain("V2 STAGED TEXT");
  });

  it("an unknown slug is a 404", async () => {
    expect((await get(await cookieFor("AndresL230"), "/doc/nope")).status).toBe(404);
  });
});

describe("GET /doc/:slug/versions/:version — one version's body", () => {
  it("the version with its body", async () => {
    await seedDoc();
    const cookie = await cookieFor("AndresL230");
    const two = await get(cookie, "/doc/gate/versions/2");
    expect(two.status).toBe(200);
    expect(two.json.version).toMatchObject({ slug: "gate", version: 2, status: "staged", body: V2, created_by: "meilin" });
    expect((await get(cookie, "/doc/gate/versions/1")).json.version).toMatchObject({ version: 1, body: V1 });
  });

  it("a bad version is a 400; an unknown doc or version, or another org's, is a 404", async () => {
    await seedDoc();
    await run(env.DB, `INSERT INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by, space) VALUES (?, 'b-only', 'reference', 'B', 'B BODY', 1, '2026-10-01', 'bob', 'technical')`, ORG_B);
    await run(env.DB, `INSERT INTO doc_versions (org_id, slug, version, body, summary, status, confidence, created_at, created_by) VALUES (?, 'b-only', 1, 'B BODY', 's', 'promoted', 'high', '2026-10-01', 'bob')`, ORG_B);
    const cookie = await cookieFor("AndresL230");
    for (const v of ["0", "-1", "1.5", "x", "01"]) expect((await get(cookie, `/doc/gate/versions/${v}`)).status, v).toBe(400);
    expect((await get(cookie, "/doc/gate/versions/3")).status).toBe(404);
    expect((await get(cookie, "/doc/nope/versions/1")).status).toBe(404);
    const other = await get(cookie, "/doc/b-only/versions/1");
    expect(other.status).toBe(404);
    expect(other.raw).not.toContain("B BODY");
  });
});

describe("MCP list_docs / get_doc keep their contract", () => {
  it("bodies included, every version's too", async () => {
    await seedDoc();
    const [doc] = await list_docs(systemCtx());
    expect(doc.body).toBe(V1);
    expect(doc).not.toHaveProperty("outline");
    const found = await get_doc(systemCtx(), "gate");
    expect(found?.versions.map((v) => v.body)).toEqual([V1, V2]);
  });
});

describe("a failed read degrades", () => {
  it("each is a 503 { error }, never a 500", async () => {
    await seedDoc();
    const cookie = await cookieFor("AndresL230");
    // Sessions resolve first; only the docs statements hit the broken binding.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/FROM (docs|doc_versions)\b/.test(sql)) throw new Error("D1 is down");
            return realPrepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    for (const path of ["/docs", "/docs?fields=meta", "/doc/gate", "/doc/gate/versions/1"]) {
      const res = await get(cookie, path, { ...env, DB });
      expect(res.status, path).toBe(503);
      expect(typeof res.json.error, path).toBe("string");
    }
  });
});
