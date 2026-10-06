import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "./helpers/db";

// pr_summaries.semantic_key REFERENCES events(semantic_key) — seed the parent
// row first, mirroring the real call order (same idiom as summarize.test.ts).
async function seedEvent(semanticKey: string, prNumber: number): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, 'pr_merged', ?, 'someone', '{}', 'webhook', NULL, ?, 'github-webhook')`,
    semanticKey,
    prNumber,
    nowIso()
  );
}

describe("0018_structured_summaries schema", () => {
  it("pr_summaries accepts and returns the four structured columns", async () => {
    await seedEvent("gh:pr:900:merged", 900);
    await run(
      env.DB,
      `INSERT INTO pr_summaries (semantic_key, pr_number, model, created_at, title, what, why, impact)
       VALUES ('gh:pr:900:merged', 900, 'm', ?, 'T', 'W', 'Y', 'I')`,
      nowIso()
    );
    const rows = await all<{ title: string | null; what: string | null; why: string | null; impact: string | null }>(
      env.DB,
      `SELECT title, what, why, impact FROM pr_summaries WHERE semantic_key = 'gh:pr:900:merged'`
    );
    expect(rows[0]).toEqual({ title: "T", what: "W", why: "Y", impact: "I" });
  });

  it("issue_summaries accepts and returns title/next_step, and both default NULL", async () => {
    await run(
      env.DB,
      `INSERT INTO issue_summaries (issue_number, summary, model, created_at, title, next_step)
       VALUES (901, 'prose', 'm', ?, 'T', 'N')`,
      nowIso()
    );
    await run(
      env.DB,
      `INSERT INTO issue_summaries (issue_number, summary, model, created_at) VALUES (902, 'prose', 'excerpt', ?)`,
      nowIso()
    );
    const rows = await all<{ issue_number: number; title: string | null; next_step: string | null }>(
      env.DB,
      `SELECT issue_number, title, next_step FROM issue_summaries ORDER BY issue_number`
    );
    expect(rows).toEqual([
      { issue_number: 901, title: "T", next_step: "N" },
      { issue_number: 902, title: null, next_step: null },
    ]);
  });
});
