import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first } from "./helpers/db";
import type { DocRow, DocVersionRow, FeedRow } from "@shared/rows";
import type { IngestResult } from "../src/consumer";
import { cookieFor as authedCookie } from "./helpers/persons";

// A valid IngestPayload: one doc proposal + one feed entry, parametrized by
// session.id so we can replay it and test the ledger-guard.
function makePayload(sessionId: string) {
  return {
    session: {
      id: sessionId,
      author: "agent",
      ended_at: "2026-06-28T00:00:00Z",
      skill_version: "2.0",
    },
    doc_proposals: [
      {
        slug: "route-doc",
        section: "reference",
        title: "Route Doc",
        body: "route ingest test body",
        change_summary: "init",
        confidence: "high",
      },
    ],
    feed_entries: [
      {
        summary: "shipped route test",
        body: "the route feed body",
        tags: ["infra"],
        artifacts: { prs: ["42"], commits: ["abc123"], issues: [1] },
      },
    ],
  };
}

// Hit the LIVE route — exercises IngestPayload.safeParse + the Hono handler in
// routes.ts, NOT consume() directly.
async function postIngest(
  payload: unknown,
  cookie?: string
): Promise<Response> {
  return app.request(
    "/ingest",
    {
      method: "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    env
  );
}

describe("live POST /ingest route", () => {
  it("200 with IngestResult counts and rows land in D1", async () => {
    const cookie = await authedCookie("agent-user");

    // This hits the live route (src/routes.ts `app.post("/ingest", ...)`),
    // exercising IngestPayload.safeParse and routing through consume().
    const res = await postIngest(makePayload("ingest-route-S1"), cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: IngestResult };
    expect(body.ok).toBe(true);

    // Per-type outcome counts reflect what landed.
    expect(body.result.docs.staged).toBe(1);
    expect(body.result.docs.unchanged).toBe(0);
    expect(body.result.docs.triaged).toBe(0);
    expect(body.result.feed.written).toBe(1);
    expect(body.result.feed.unchanged).toBe(0);
    expect(body.result.feed.triaged).toBe(0);

    // Rows actually landed in D1.
    const doc = await first<DocRow>(
      env.DB,
      `SELECT * FROM docs WHERE slug = 'route-doc'`
    );
    expect(doc).not.toBeNull();
    expect(doc?.space).toBe("technical"); // default space when not specified

    const version = await first<DocVersionRow>(
      env.DB,
      `SELECT * FROM doc_versions WHERE slug = 'route-doc'`
    );
    expect(version?.status).toBe("staged");
    expect(version?.change_kind).toBe("new");

    const feed = await all<FeedRow>(env.DB, `SELECT * FROM feed`);
    expect(feed.length).toBe(1);
    expect(feed[0].author).toBe("agent-user"); // author = authenticated principal, not advisory
    expect(feed[0].summary).toBe("shipped route test");
  });

  it("replay: same session.id returns all-unchanged with zero new rows", async () => {
    const cookie = await authedCookie("agent-user");
    const payload = makePayload("ingest-route-replay-S2");

    // First POST.
    const first_res = await postIngest(payload, cookie);
    expect(first_res.status).toBe(200);
    const firstBody = (await first_res.json()) as { ok: boolean; result: IngestResult };
    expect(firstBody.result.docs.staged).toBe(1);
    expect(firstBody.result.feed.written).toBe(1);

    // Snapshot row counts before the replay.
    const countBefore = {
      docs: (await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`)).length,
      feed: (await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length,
    };

    // Replay: same payload, same session.id.
    const replay_res = await postIngest(payload, cookie);
    expect(replay_res.status).toBe(200);
    const replayBody = (await replay_res.json()) as { ok: boolean; result: IngestResult };
    expect(replayBody.ok).toBe(true);

    // All items report unchanged — the ledger dropped them.
    expect(replayBody.result.docs).toEqual({ staged: 0, unchanged: 1, triaged: 0 });
    expect(replayBody.result.feed).toEqual({ written: 0, unchanged: 1, triaged: 0 });

    // Zero new rows of any kind.
    const countAfter = {
      docs: (await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions`)).length,
      feed: (await all<FeedRow>(env.DB, `SELECT * FROM feed`)).length,
    };
    expect(countAfter).toEqual(countBefore);
  });

  it("401 when no session cookie is sent (the gate)", async () => {
    // No cookie — sessionGate must close with 401 before the handler runs.
    const res = await postIngest(makePayload("ingest-route-no-auth"), undefined);
    expect(res.status).toBe(401);
  });

  it("400 when the payload fails IngestPayload.safeParse (invalid JSON shape)", async () => {
    const cookie = await authedCookie("agent-user");
    // Missing required `session` field — safeParse will fail.
    const res = await postIngest({ not_valid: true }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("invalid payload");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("narrows the contract: a payload still carrying the retired arms (the roadmap-proposal queue and focus, both tables now dropped) is 200'd, stripped by zod, and writes nothing", async () => {
    const cookie = await authedCookie("agent-user");
    const payload = {
      session: {
        id: "ingest-route-narrow-S1",
        author: "agent",
        ended_at: "2026-06-28T00:00:00Z",
        skill_version: "2.0",
      },
      // Both of these were real IngestPayload arms once. Their tables are gone
      // (0014 dropped focus; 0025 dropped the roadmap-proposal queue), so the only
      // correct behaviour is to drop the keys on the floor: not a 400, not a write.
      sprint_proposals: [
        { label: "GA", due: "2026-09-01", status: "upcoming", change_summary: "s", confidence: "high" },
      ],
      focus: { working_on: "narrow the contract", next_up: "ship it" },
    };

    const res = await postIngest(payload, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; result: Record<string, unknown> };
    // The result envelope has exactly the four surviving arms — nothing else ran.
    expect(Object.keys(body.result).sort()).toEqual(["adrs", "docs", "feed", "triage"]);

    // …and nothing landed anywhere: no sprint created, no triage row raised.
    expect(await all(env.DB, `SELECT * FROM sprints`)).toHaveLength(0);
    expect(await all(env.DB, `SELECT * FROM needs_triage`)).toHaveLength(0);
    expect(await all<FeedRow>(env.DB, `SELECT * FROM feed`)).toHaveLength(0);
  });
});
