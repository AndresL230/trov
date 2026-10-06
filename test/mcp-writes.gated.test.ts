import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { ingestFeedEntry, ingestDocProposal } from "../src/consumer";
import { get_feed } from "../src/tools/reads";
import { all } from "../src/db";
import type { DocRow, DocVersionRow, NeedsTriageRow } from "@shared/rows";

// These call the gate functions in src/consumer.ts DIRECTLY (ingestFeedEntry /
// ingestDocProposal) — the layer beneath BOTH the MCP write tools and /ingest. They
// prove the vocabulary/confidence gate itself. The registered MCP tools are driven
// end-to-end through real dispatch in mcp.append_feed / mcp.propose_doc /
// record-session.mcp tests, not here.
const AUTHOR = "real-user";

describe("gate functions (consumer.ts) enforce the vocabulary/confidence gate", () => {
  it("ingestFeedEntry: an in-vocab tag is written to the feed, nothing triaged", async () => {
    const r = await ingestFeedEntry(
      systemCtx(),
      { summary: "ok", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [], issues: [] } },
      AUTHOR
    );
    expect(r.outcome).toBe("written");

    const feed = await get_feed(systemCtx(), {});
    expect(feed.length).toBe(1);
    expect(feed[0].author).toBe(AUTHOR);

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(0);
  });

  it("ingestFeedEntry: an out-of-vocab tag routes the whole entry to needs_triage and writes no feed row", async () => {
    const r = await ingestFeedEntry(
      systemCtx(),
      { summary: "bad", body: "b", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [], issues: [] } },
      AUTHOR
    );
    expect(r.outcome).toBe("triaged");

    const feed = await get_feed(systemCtx(), {});
    expect(feed.length).toBe(0);

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].reason).toContain("not-a-real-tag");
    expect(triage[0].source_author).toBe(AUTHOR);
  });

  it("ingestDocProposal: in-vocab high-confidence stages a version (non-destructive), nothing triaged", async () => {
    const r = await ingestDocProposal(
      systemCtx(),
      { slug: "architecture", section: "reference", title: "Architecture", body: "# v1", change_summary: "s", confidence: "high" },
      AUTHOR
    );
    expect(r).toMatchObject({ outcome: "written", slug: "architecture", version: 1, status: "staged" });

    const doc = (await all<DocRow>(env.DB, `SELECT * FROM docs`))[0];
    expect(doc.current_version).toBe(0); // promotion is still a human action

    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(versions.length).toBe(1);
    expect(versions[0].status).toBe("staged");

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(0);
  });

  it("ingestDocProposal: an out-of-vocab section routes to triage and writes no doc/version", async () => {
    const r = await ingestDocProposal(
      systemCtx(),
      { slug: "bad-section", section: "made-up", body: "x", change_summary: "s", confidence: "high" },
      AUTHOR
    );
    expect(r.outcome).toBe("triaged");

    const docs = await all<DocRow>(env.DB, `SELECT * FROM docs`);
    expect(docs.length).toBe(0);
    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(versions.length).toBe(0);

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].reason).toContain("made-up");
  });

  it("ingestDocProposal: a low-confidence proposal routes to triage and writes no doc/version", async () => {
    const r = await ingestDocProposal(
      systemCtx(),
      { slug: "low-conf", section: "reference", body: "x", change_summary: "s", confidence: "low" },
      AUTHOR
    );
    expect(r.outcome).toBe("triaged");

    const docs = await all<DocRow>(env.DB, `SELECT * FROM docs`);
    expect(docs.length).toBe(0);
    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(versions.length).toBe(0);

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(1);
    expect(triage[0].reason).toContain("low confidence");
  });
});
