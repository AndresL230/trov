import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { propose_doc_update } from "../src/tools/writes";
import { first, all } from "../src/db";
import type { DocRow, DocVersionRow } from "@shared/rows";

describe("non-destructive doc write", () => {
  it("stages v1, creates the doc with empty body, leaves current_version at 0", async () => {
    const proposal = {
      slug: "architecture",
      section: "reference",
      title: "Architecture",
      body: "# v1 body",
      change_summary: "initial draft",
      confidence: "high" as const,
    };

    const out = await propose_doc_update(systemCtx(), proposal, "andres");
    expect(out).toEqual({ slug: "architecture", version: 1, status: "staged" });

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(0);
    expect(doc?.body).toBe("");
    expect(doc?.title).toBe("Architecture");

    const versions = await all<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = ? ORDER BY version`,
      "architecture"
    );
    expect(versions.length).toBe(1);
    expect(versions[0].status).toBe("staged");
    expect(versions[0].version).toBe(1);
    expect(versions[0].body).toBe("# v1 body");
  });

  it("derives a humanized title when the proposal omits one", async () => {
    const out = await propose_doc_update(
      systemCtx(),
      { slug: "auth-flow", section: "reference", body: "x", change_summary: "s", confidence: "high" },
      "andres"
    );
    expect(out.version).toBe(1);
    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "auth-flow");
    expect(doc?.title).toBe("Auth Flow");
  });

  it("appends v2 on a second proposal and still promotes nothing", async () => {
    const base = { slug: "architecture", section: "reference", title: "Architecture", confidence: "high" as const };
    await propose_doc_update(systemCtx(), { ...base, body: "# v1", change_summary: "first" }, "andres");
    const second = await propose_doc_update(systemCtx(), { ...base, body: "# v2", change_summary: "second" }, "andres");
    expect(second.version).toBe(2);

    const doc = await first<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = ?`, "architecture");
    expect(doc?.current_version).toBe(0);
    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = ?`, "architecture");
    expect(versions.length).toBe(2);
  });
});
