import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { propose_doc_update, stage_adr, promote_doc, ratify_adr } from "../src/tools/writes";
import { first } from "../src/db";
import type { DocRow, DocVersionRow, AdrRow } from "@shared/rows";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";

const base = { slug: "architecture", section: "reference", title: "Architecture", confidence: "high" as const };

describe("promote_doc", () => {
  it("flips the version to promoted, copies body into docs, bumps current_version, keeps prior versions", async () => {
    await propose_doc_update(systemCtx(), { ...base, body: "# v1", change_summary: "first" }, "andres");
    await propose_doc_update(systemCtx(), { ...base, body: "# v2", change_summary: "second" }, "andres");

    const out = await promote_doc(systemCtx(), "architecture", 2, "andres");
    expect(out).toEqual({ slug: "architecture", version: 2, status: "promoted" });

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(2);
    expect(doc?.body).toBe("# v2");
    expect(doc?.updated_by).toBe("andres");

    const v1 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ? AND version = 1`, "architecture");
    const v2 = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ? AND version = 2`, "architecture");
    expect(v1?.status).toBe("staged");   // prior version intact, untouched
    expect(v1?.body).toBe("# v1");
    expect(v2?.status).toBe("promoted");
  });

  it("rejects a version that does not exist", async () => {
    await propose_doc_update(systemCtx(), { ...base, body: "# v1", change_summary: "first" }, "andres");
    await expect(promote_doc(systemCtx(), "architecture", 99, "andres")).rejects.toThrow();
  });

  it("rejects promoting an already-promoted (non-staged) version", async () => {
    await propose_doc_update(systemCtx(), { ...base, body: "# v1", change_summary: "first" }, "andres");
    await promote_doc(systemCtx(), "architecture", 1, "andres");
    await expect(promote_doc(systemCtx(), "architecture", 1, "andres")).rejects.toThrow();
  });
});

describe("ratify_adr", () => {
  it("flips a draft to ratified", async () => {
    const id = await stage_adr(systemCtx(), { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const out = await ratify_adr(systemCtx(), id);
    expect(out).toEqual({ id, status: "ratified" });
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("ratified");
  });

  it("rejects a missing adr", async () => {
    await expect(ratify_adr(systemCtx(), 4242)).rejects.toThrow();
  });

  it("rejects an already-ratified adr", async () => {
    const id = await stage_adr(systemCtx(), { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    await ratify_adr(systemCtx(), id);
    await expect(ratify_adr(systemCtx(), id)).rejects.toThrow();
  });
});

describe("promote/ratify HTTP routes (session-gated)", () => {
  it("POST /doc/:slug/promote promotes for an authenticated principal", async () => {
    await propose_doc_update(systemCtx(), { ...base, body: "# v1", change_summary: "first" }, "andres");
    const cookie = await cookieFor("andres");
    const res = await app.request(
      "/doc/architecture/promote",
      { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) },
      env
    );
    expect(res.status).toBe(200);
    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(1);
  });

  it("POST /adr/:id/ratify is rejected with 401 without a session", async () => {
    const id = await stage_adr(systemCtx(), { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const res = await app.request(`/adr/${id}/ratify`, { method: "POST" }, env);
    expect(res.status).toBe(401);
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("draft"); // unchanged
  });

  it("POST /adr/:id/ratify ratifies for an authenticated principal", async () => {
    const id = await stage_adr(systemCtx(), { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    const cookie = await cookieFor("andres");
    const res = await app.request(`/adr/${id}/ratify`, { method: "POST", headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("ratified");
  });
});
