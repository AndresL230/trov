import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { IngestPayload } from "@shared/contract";
import { consume } from "../src/consumer";
import { get_feed } from "../src/tools/reads";
import { all } from "./helpers/db";
import type { NeedsTriageRow, DocVersionRow } from "@shared/rows";

const session = { id: "sess-vocab", author: "andres", ended_at: "2026-06-24T00:00:00Z", skill_version: "1.0" };

describe("vocabulary gate", () => {
  // 0054_org_tags: a tag that is not on the org's list no longer sends the entry to triage. The entry
  // is written without it and the tag waits as a suggestion (test/tags.gate.test.ts has the detail).
  it("writes feed entries with the tags on the org's list; an unknown tag is a suggestion, never a triage item", async () => {
    const payload = IngestPayload.parse({
      session,
      feed_entries: [
        { summary: "known", body: "good", tags: ["auth"], artifacts: { prs: [], commits: [], issues: [] } },
        { summary: "unknown", body: "bad", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [], issues: [] } },
      ],
    });

    const result = await consume(systemCtx(), payload, { handle: "andres" });
    expect(result.feed.written).toBe(2);
    expect(result.feed.triaged).toBe(0);
    expect(result.suggested_tags).toEqual(["not-a-real-tag"]);

    const feed = await get_feed(systemCtx(), {});
    expect(feed.find((f) => f.summary === "known")?.tags).toEqual(["auth"]);
    expect(feed.find((f) => f.summary === "unknown")?.tags).toEqual([]);

    expect(await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`)).toEqual([]);
    expect(await all<{ tag: string; state: string }>(env.DB, `SELECT tag, state FROM org_tag_suggestions`)).toEqual([{ tag: "not-a-real-tag", state: "open" }]);
  });

  it("routes out-of-vocab doc sections and low-confidence items to triage, stages valid ones", async () => {
    const payload = IngestPayload.parse({
      session,
      doc_proposals: [
        { slug: "good-doc", section: "reference", body: "ok", change_summary: "s", confidence: "high" },
        { slug: "bad-section", section: "made-up", body: "x", change_summary: "s", confidence: "high" },
        { slug: "low-conf", section: "reference", body: "x", change_summary: "s", confidence: "low" },
      ],
      adr_drafts: [
        { title: "good adr", context: "c", decision: "d", rationale: "r", confidence: "high" },
        { title: "weak adr", context: "c", decision: "d", rationale: "r", confidence: "low" },
      ],
      needs_triage: [{ raw: "raw blob", reason: "ambiguous section" }],
    });

    const result = await consume(systemCtx(), payload, { handle: "andres" });
    expect(result.docs.staged).toBe(1);
    expect(result.adrs.staged).toBe(1);
    // bad-section + low-conf doc (docs.triaged) + weak adr (adrs.triaged) + explicit
    // triage item (triage.recorded) = 4 routed to needs_triage in total.
    expect(result.docs.triaged).toBe(2);
    expect(result.adrs.triaged).toBe(1);
    expect(result.triage.recorded).toBe(1);

    const staged = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`);
    expect(staged.length).toBe(1);
    expect(staged[0].slug).toBe("good-doc");

    const triage = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    expect(triage.length).toBe(4);
  });
});
