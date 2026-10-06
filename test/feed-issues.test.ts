import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { FeedEntry } from "@shared/contract";
import { ingestFeedEntry } from "../src/consumer";
import { all } from "./helpers/db";
import type { FeedRow } from "@shared/rows";

describe("feed entry issue links", () => {
  it("defaults artifacts.issues to [] when omitted", () => {
    const parsed = FeedEntry.parse({ summary: "s", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [] } });
    expect(parsed.artifacts.issues).toEqual([]);
  });

  it("round-trips issues:[42] into the stored feed artifacts json", async () => {
    const r = await ingestFeedEntry(
      systemCtx(),
      { summary: "linked", body: "b", tags: ["auth"], artifacts: { prs: [], commits: [], issues: [42] } },
      "andres"
    );
    expect(r.outcome).toBe("written");

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    const artifacts = JSON.parse(feed[0].artifacts!);
    expect(artifacts.issues).toEqual([42]);
    expect(artifacts.prs).toEqual([]);
    expect(artifacts.commits).toEqual([]);
  });
});
