import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "./helpers/db";
import type { IssueSummaryRow } from "@shared/rows";

describe("issue_summaries schema (0017)", () => {
  it("stores a summary keyed by issue_number", async () => {
    await run(
      env.DB,
      `INSERT INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`,
      17,
      "What the issue is about.",
      "test-model",
      "2026-07-04T10:00:00Z"
    );
    const row = await first<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 17);
    expect(row).toMatchObject({
      issue_number: 17,
      summary: "What the issue is about.",
      model: "test-model",
      created_at: "2026-07-04T10:00:00Z",
    });
  });

  it("issue_number is the PK: INSERT OR REPLACE overwrites the prior summary for the same issue", async () => {
    await run(env.DB, `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`, 20, "First summary", "m1", "2026-07-04T10:00:00Z");
    await run(env.DB, `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`, 20, "Second summary", "m2", "2026-07-04T11:00:00Z");
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 20);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Second summary");
    expect(rows[0].model).toBe("m2");
  });

  it("is truncated between tests (test-harness registration)", async () => {
    // If Step 1's row from a prior test file run were still here, this would be 1 not 0.
    expect((await all(env.DB, `SELECT * FROM issue_summaries`)).length).toBe(0);
  });
});
