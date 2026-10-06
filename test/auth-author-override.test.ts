import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { IngestPayload } from "@shared/contract";
import { consume } from "../src/consumer";
import { all } from "../src/db";
import type { FeedRow, DocVersionRow } from "@shared/rows";

describe("author override", () => {
  it("stores the authenticated principal as author, ignoring the payload's claimed session.author", async () => {
    const payload = IngestPayload.parse({
      session: { id: "sess-override", author: "someone-else", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" },
      feed_entries: [{ summary: "s", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [] } }],
      doc_proposals: [{ slug: "architecture", section: "reference", title: "Architecture", body: "x", change_summary: "c", confidence: "high" }],
    });

    await consume(systemCtx(), payload, { handle: "real-user" });

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    expect(feed[0].author).toBe("real-user");

    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(versions[0].created_by).toBe("real-user");
  });
});
