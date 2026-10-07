import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import { promote_doc } from "../src/tools/writes";
import { all, first } from "./helpers/db";
import type { DocRow, DocVersionRow, NeedsTriageRow } from "@shared/rows";
import { bearerCtx, systemCtx } from "./helpers/tenant";

const AUTHOR = "agent";

// Drive the ACTUAL registered MCP `propose_doc_update` tool through an in-memory
// MCP client/server pair — the same closure production runs. Each call creates a
// fresh server, so `ephemeralLedger()` mints a new session UUID per call. That
// means the ONLY replay guard between two identical calls is the content-hash
// dedupe path inside the gate — the exact behavior the audit flagged as untested
// through the registered tool (gaps A4/D2).
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer(
    env as unknown as import("../src/env").Env,
    await bearerCtx(AUTHOR)
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0].text, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

// Convenience wrapper: parse the JSON text and assert no transport error.
async function propose(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // The registered tool name is "propose_doc_update" (src/mcp.ts line 99).
  const { text, isError } = await callTool("propose_doc_update", args);
  expect(isError).toBeFalsy();
  return JSON.parse(text) as Record<string, unknown>;
}

describe("registered MCP propose_doc_update tool — reconciler behaviors", () => {
  it("new slug: stages a doc_versions row with change_kind='new'", async () => {
    const result = await propose({
      slug: "new-doc",
      section: "reference",
      title: "New Doc",
      body: "initial body content",
      change_summary: "initial version",
      confidence: "high",
    });

    expect(result.outcome).toBe("written");
    expect(result.change_kind).toBe("new");

    const version = await first<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = 'new-doc'`
    );
    expect(version).not.toBeNull();
    expect(version?.change_kind).toBe("new");
    expect(version?.status).toBe("staged");
    expect(version?.version).toBe(1);
    expect(version?.content_hash).toBeTruthy();
  });

  it("content-hash dedupe: proposing the identical body again (fresh ephemeral session) is a no-op", async () => {
    // First call stages version 1.
    const first_result = await propose({
      slug: "dedup-doc",
      section: "reference",
      body: "same body content",
      change_summary: "init",
      confidence: "high",
    });
    expect(first_result.outcome).toBe("written");

    const countBefore = (
      await all<DocVersionRow>(
        env.DB,
        `SELECT * FROM doc_versions WHERE slug = 'dedup-doc'`
      )
    ).length;
    expect(countBefore).toBe(1);

    // Second call: identical body, but a DIFFERENT ephemeral session (new server per call).
    // The ledger cannot dedup this — only the content-hash gate can.
    const second_result = await propose({
      slug: "dedup-doc",
      section: "reference",
      body: "same body content",
      change_summary: "init",
      confidence: "high",
    });

    expect(second_result.outcome).toBe("unchanged");

    // Exactly one row — the dedup blocked the second write.
    const countAfter = (
      await all<DocVersionRow>(
        env.DB,
        `SELECT * FROM doc_versions WHERE slug = 'dedup-doc'`
      )
    ).length;
    expect(countAfter).toBe(1);
  });

  it("force:true stages a new version even when the body is byte-identical", async () => {
    // Stage v1.
    await propose({
      slug: "force-doc",
      section: "reference",
      body: "same body",
      change_summary: "v1",
      confidence: "high",
    });

    // Identical body + force=true bypasses content-hash dedupe.
    const result = await propose({
      slug: "force-doc",
      section: "reference",
      body: "same body",
      change_summary: "forced resend",
      confidence: "high",
      force: true,
    });

    expect(result.outcome).toBe("written");

    const versions = await all<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = 'force-doc'`
    );
    expect(versions.length).toBe(2);
  });

  it("an explicit space:'product' persists on the docs row instead of the default (audit A4)", async () => {
    const result = await propose({
      slug: "product-space-doc",
      section: "reference",
      body: "product content here",
      change_summary: "init",
      confidence: "high",
      space: "product",
    });

    expect(result.outcome).toBe("written");

    // The docs row must carry space='product', not the default 'technical'.
    const doc = await first<DocRow>(
      env.DB,
      `SELECT * FROM docs WHERE slug = 'product-space-doc'`
    );
    expect(doc).not.toBeNull();
    expect(doc?.space).toBe("product");
  });

  it("omitted space defaults to 'technical' on the docs row", async () => {
    const result = await propose({
      slug: "default-space-doc",
      section: "reference",
      body: "content with no space specified",
      change_summary: "init",
      confidence: "high",
    });
    expect(result.outcome).toBe("written");

    const doc = await first<DocRow>(
      env.DB,
      `SELECT * FROM docs WHERE slug = 'default-space-doc'`
    );
    expect(doc?.space).toBe("technical");
  });

  it("an off-vocab space is rejected at the tool boundary (hard enum — never written, never triaged)", async () => {
    // The registered tool's Zod enum is exactly {technical, product}; a foreign
    // value fails validation before the gate runs, so the tab set can't be widened
    // by a write. (Contrast: an out-of-vocab section is triaged, not rejected.)
    const { isError } = await callTool("propose_doc_update", {
      slug: "bad-space-doc",
      section: "reference",
      body: "should never be written",
      change_summary: "init",
      confidence: "high",
      space: "sapling",
    });
    expect(isError).toBeTruthy();

    // Nothing was written and nothing was triaged — validation short-circuited the call.
    expect(
      (await all<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'bad-space-doc'`)).length
    ).toBe(0);
    expect(
      (await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`)).length
    ).toBe(0);
  });

  it("low-confidence new slug: routed to needs_triage, no docs or doc_versions row", async () => {
    const result = await propose({
      slug: "low-conf-new",
      section: "reference",
      body: "tentative content",
      change_summary: "unsure",
      confidence: "low",
    });

    expect(result.outcome).toBe("triaged");

    // No docs row, no doc_versions row — the gate blocked creation entirely.
    expect(
      (await all<DocRow>(env.DB, `SELECT * FROM docs WHERE slug = 'low-conf-new'`)).length
    ).toBe(0);
    expect(
      (
        await all<DocVersionRow>(
          env.DB,
          `SELECT * FROM doc_versions WHERE slug = 'low-conf-new'`
        )
      ).length
    ).toBe(0);

    // The triage queue picked it up.
    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].source_author).toBe(AUTHOR);
  });

  it("low-confidence existing slug: staged with low_confidence=1", async () => {
    // Establish the slug with high confidence (so the doc exists).
    await propose({
      slug: "low-conf-existing",
      section: "reference",
      body: "initial version of this doc",
      change_summary: "v1",
      confidence: "high",
    });

    // Propose a different body with low confidence — existing slug → stage-and-flag.
    const result = await propose({
      slug: "low-conf-existing",
      section: "reference",
      body: "updated version with meaningful changes",
      change_summary: "uncertain update",
      confidence: "low",
    });

    expect(result.outcome).toBe("written");
    expect(result.low_confidence).toBe(true);

    // The staged version carries low_confidence = 1 in the DB.
    const v2 = await first<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = 'low-conf-existing' AND version = 2`
    );
    expect(v2).not.toBeNull();
    expect(v2?.low_confidence).toBe(1);
    expect(v2?.status).toBe("staged");
  });

  it("base_version is recorded in the doc_versions row when passed through the registered tool", async () => {
    // Stage v1 via the registered tool.
    await propose({
      slug: "base-version-doc",
      section: "reference",
      body: "initial body for base version test",
      change_summary: "v1",
      confidence: "high",
    });
    // Promote it — a human action, never an MCP tool.
    await promote_doc(systemCtx(), "base-version-doc", 1, "human");

    // Now current_version = 1. Propose v2 and pass base_version: 1 through the tool.
    const result = await propose({
      slug: "base-version-doc",
      section: "reference",
      body: "updated body with entirely new content for the rewrite test",
      change_summary: "v2 update",
      confidence: "high",
      base_version: 1,
    });

    expect(result.outcome).toBe("written");
    expect(result.base_version).toBe(1);

    // The doc_versions row for v2 records base_version = 1.
    const v2 = await first<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = 'base-version-doc' AND version = 2`
    );
    expect(v2).not.toBeNull();
    expect(v2?.base_version).toBe(1);
  });
});
