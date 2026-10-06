import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { all, first } from "./helpers/db";
import { ingestEvent } from "../src/consumer";
import { getMyWork } from "../src/tools/mywork";
import { seedPerson } from "./helpers/persons";
import type { IdentityTaskWithSample } from "../src/tools/reads";
import type { IdentityTaskRow, IdentityRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

async function authedCookie(login: string): Promise<string> {
  await seedPerson(login);
  const { id } = await createSession(platformCtx(), login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const getJson = async <T>(path: string, cookie: string): Promise<T> =>
  (await (await app.request(path, { headers: { cookie } }, env)).json()) as T;

// A merged-PR event whose raw carries everything getMyWork's projection parses
// (number, title, html_url, merged) — so the retroactive test is end-to-end real.
const prEvent = (n: number, login: string, title: string, occurredAt: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`,
  event_type: "pr_merged",
  ref_number: n,
  subject_login: login,
  // `milestone` below is GitHub's own key — not Trov vocabulary.
  raw: JSON.stringify({
    pr: { number: n, title, body: "b", html_url: `https://github.com/SaplingLearn/sapling/pull/${n}`, merged: true, merged_at: occurredAt, closed_at: occurredAt, user: { login }, milestone: null },
  }),
  provenance: "webhook",
  occurred_at: occurredAt,
});

describe("GET /identity-tasks", () => {
  it("lists pending tasks with a small LIVE sample: newest-first, capped at 3, titles extracted from raw", async () => {
    const cookie = await authedCookie("andres");
    for (let i = 1; i <= 4; i++) {
      await ingestEvent(systemCtx(), platformCtx(), prEvent(i, "mystery-dev", `PR number ${i}`, `2026-07-0${i}T10:00:00Z`), "github-webhook");
    }

    const { tasks } = await getJson<{ tasks: IdentityTaskWithSample[] }>("/identity-tasks", cookie);
    expect(tasks.length).toBe(1);
    expect(tasks[0].login).toBe("mystery-dev");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].sample.length).toBe(3); // capped — 4 events captured
    expect(tasks[0].sample[0]).toMatchObject({
      semantic_key: "gh:pr:4:merged",
      event_type: "pr_merged",
      ref_number: 4,
      title: "PR number 4", // extracted from the event's own raw
      occurred_at: "2026-07-04T10:00:00Z",
    });
  });

  it("a malformed raw yields title:null instead of failing the list", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(
      systemCtx(),
      platformCtx(),
      { ...prEvent(5, "glitchy-dev", "x", "2026-07-05T10:00:00Z"), raw: "not json at all" },
      "github-webhook"
    );
    const { tasks } = await getJson<{ tasks: IdentityTaskWithSample[] }>("/identity-tasks", cookie);
    expect(tasks[0].sample[0].title).toBeNull();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/identity-tasks", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /identity-tasks/:login/map", () => {
  it("maps the login, resolves the task, and drops it from the pending list", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    await seedPerson("casey");

    const res = await post("/identity-tasks/mystery-dev/map", cookie, { person: "casey" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, login: "mystery-dev", person: "casey", status: "resolved" });

    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'mystery-dev'`))?.person).toBe("casey");
    const { tasks } = await getJson<{ tasks: unknown[] }>("/identity-tasks", cookie);
    expect(tasks.length).toBe(0); // leaves the queue
    const row = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(row?.status).toBe("resolved"); // soft — the row remains
    expect(row?.resolved_by).toBe("andres");
  });

  it("400 on a missing/empty person, an unknown person, and an unknown login", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    await seedPerson("casey");
    expect((await post("/identity-tasks/mystery-dev/map", cookie, {})).status).toBe(400);
    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "   " })).status).toBe(400);
    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "ghost" })).status).toBe(400); // no such person
    expect((await post("/identity-tasks/nobody-here/map", cookie, { person: "casey" })).status).toBe(400); // no such identity task
  });

  it("returns 401 without a session cookie (and does not mutate)", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    const res = await app.request("/identity-tasks/mystery-dev/map", { method: "POST" }, env);
    expect(res.status).toBe(401);
    expect(await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE provider = 'github' AND subject = 'mystery-dev'`)).toBeNull();
  });

  // Settled decision 5: identity mapping is retroactive for free — My Work
  // resolves login→person at READ time via `identities`, so one linked identity
  // surfaces all of the login's already-captured events with no backfill job.
  it("retroactively surfaces already-captured events in My Work — no backfill", async () => {
    const cookie = await authedCookie("andres");
    await seedPerson("casey");
    // Computed relative to the real clock (not fixed 2026-07-01/02 dates) so this
    // test never goes red once the real date passes getMyWork's 14-day recency
    // window. Do not pass getMyWork's opts.now here — that parameter is being
    // removed on another in-flight branch, so relative event dates are the only
    // form valid under both implementations.
    const dayMs = 24 * 60 * 60 * 1000;
    const twoDaysAgo = new Date(Date.now() - 2 * dayMs).toISOString();
    const oneDayAgo = new Date(Date.now() - 1 * dayMs).toISOString();
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "mystery-dev", "First PR", twoDaysAgo), "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(2, "mystery-dev", "Second PR", oneDayAgo), "github-webhook");

    // Before mapping: captured but unsurfaced — "mystery-dev" is not (yet) any
    // person's handle or identity, so it resolves to nothing.
    const before = await getMyWork(systemCtx(), "mystery-dev");
    expect(before).toEqual({ person: null, previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false });

    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "casey" })).status).toBe(200);

    // After mapping: BOTH pre-existing events surface for the PERSON, purely at read time.
    const after = await getMyWork(systemCtx(), "casey");
    expect(after.person).toBe("casey");
    expect(after.previousActivity.length).toBe(2);
    expect(after.previousActivity[0].title).toBe("Second PR"); // newest first
    expect(after.degraded).toBe(false);
  });

  it("map to an existing handle links the login; unknown person → 400", async () => {
    const cookie = await authedCookie("andres");
    await seedPerson("casey");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "mystery-dev", "t", "2026-07-01T00:00:00Z"), "github-webhook");
    const ok = await post("/identity-tasks/mystery-dev/map", cookie, { person: "casey" });
    expect(ok.status).toBe(200);
    expect((await first<IdentityRow>(env.DB, `SELECT * FROM identities WHERE subject = 'mystery-dev'`))?.person).toBe("casey");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(2, "other-dev", "t", "2026-07-01T00:00:00Z"), "github-webhook");
    expect((await post("/identity-tasks/other-dev/map", cookie, { person: "ghost" })).status).toBe(400);
  });
});
