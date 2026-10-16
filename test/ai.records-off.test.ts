// Ingested vs computed when AI is off (owner rulings 2026-10-16, Q29 / Q32; docs/architecture/ai.md › The read rule):
// what Trov already WROTE INTO THE RECORD stays a record. A feed entry Trov wrote keeps its `ai` mark (author `trov`,
// its subject, its sources) and Sift's stored importance keeps showing — in the Feed (`GET /feed`, MCP `get_feed`)
// and in the daily e-mail's "Also" — with the org's switch off AND with no Anthropic key. Only the computed surfaces
// (brief, state, themes, notes, suggestions) go (test/ai.read-rule.test.ts). The web's "Trov now writes…" note reads
// the switch from `GET /ai/settings` (`enabled`, `eligibility`), which says it.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { append_feed } from "../src/tools/writes";
import { get_feed } from "../src/tools/reads";
import { briefContent } from "../src/notifications/renderers/my-work";
import type { FeedRow } from "@shared/rows";
import { run } from "./helpers/db";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { ensureTrovPerson } from "./helpers/ai-roadmap";
import { withoutAiKey, useAiKey } from "./helpers/ai-key";

useAiKey();

const ME = "AndresL230";
const ctx = () => systemCtx(ORG_A);

async function seed(): Promise<{ trov: number; rated: number }> {
  await ensureTrovPerson();
  const trov = await append_feed(ctx(), { author: ME, summary: "Shipped: hosting screens", body: "b", tags: [] });
  const rated = await append_feed(ctx(), { author: ME, summary: "Incident: deploys failing", body: "b", tags: [] });
  await run(env.DB, `UPDATE feed SET origin = 'ai', author = 'trov', subject = ?, model = 'claude-haiku-5-5' WHERE id = ?`, ME, trov);
  await run(env.DB, `UPDATE feed SET importance = 'breaking' WHERE id = ?`, rated);
  // A merged pull request of theirs that Sift rated breaking — what the daily's "Also" lists (Q43: their own PRs).
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  await run(env.DB, `INSERT INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
    VALUES (?, 'gh:pr:4711:merged', 'pr_merged', 4711, ?, ?, 'webhook', ?, ?, 'github-webhook')`,
  ORG_A, ME, JSON.stringify({ pr: { number: 4711, title: "Fix deploys", html_url: "https://github.com/AndresL230/trov/pull/4711", base: { ref: "main" } } }), at, at);
  await run(env.DB, `INSERT INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, title, what, why, impact, importance)
    VALUES (?, 'gh:pr:4711:merged', 4711, 'claude-haiku-5-5', ?, 'Deploys fixed', 'what', 'why', 'impact', 'breaking')`, ORG_A, at);
  return { trov, rated };
}

async function webFeed(): Promise<FeedRow[]> {
  const res = await app.request("/api/o/saplinglearn/feed", { headers: { cookie: await cookieFor(ME) } }, env as unknown as Env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { feed: FeedRow[] }).feed;
}

describe("records stay records with AI off (Q29 / Q32)", () => {
  let ids: { trov: number; rated: number };
  beforeEach(async () => { ids = await seed(); });

  const check = async () => {
    for (const feed of [await webFeed(), await get_feed(ctx(), { viewer: ME })]) {
      const trov = feed.find((r) => r.id === ids.trov);
      expect(trov?.ai).toMatchObject({ origin: "ai", subject: ME });
      expect(trov?.author).toBe("trov");
      expect(feed.find((r) => r.id === ids.rated)?.importance).toBe("breaking");
    }
    const day = { cadence: "daily" as const, start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000), id: "today" };
    const also = (await briefContent(ctx(), ME, day))!.also;
    expect(also.map((a) => a.title)).toContain("Deploys fixed");
  };

  it("on: Trov's entry carries its `ai`, the rated entry its importance, and the daily's Also lists their rated PR", check);

  it("the org's switch off: the same — and `GET /ai/settings` says off, for the web's one-time note", async () => {
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    await check();
    const res = await app.request("/api/o/saplinglearn/ai/settings", { headers: { cookie: await cookieFor(ME) } }, env as unknown as Env);
    expect(await res.json()).toMatchObject({ enabled: false, eligibility: "off" });
  });

  it("no Anthropic key: the same — and `GET /ai/settings` says no_key", async () => {
    await withoutAiKey(async () => {
      await check();
      const res = await app.request("/api/o/saplinglearn/ai/settings", { headers: { cookie: await cookieFor(ME) } }, env as unknown as Env);
      expect(await res.json()).toMatchObject({ enabled: true, eligibility: "no_key" });
    });
  });
});
