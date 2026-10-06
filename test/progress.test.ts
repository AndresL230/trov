import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { run, all, first, nowIso } from "../src/db";
import type { SprintProgressRow } from "@shared/rows";
import type { Env } from "../src/env";
import { eventsFromDelivery, handleGithubWebhook } from "../src/webhook";
import { ingestEvent } from "../src/consumer";
import worker from "../src/index";
import {
  upsertProgress,
  getProgress,
  applyEventProgress,
  recomputeAllProgress,
} from "../src/tools/progress";
import issueClosed from "./fixtures/gh-issue-closed.json";

// GitHub's own signing recipe — HMAC-SHA256 hex, prefixed `sha256=`. Mirrors
// test/webhook.test.ts's sign() helper.
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedSprint(githubRef: string | null, title = "M"): Promise<number> {
  const res = await run(
    env.DB,
    `INSERT INTO sprints (title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    title,
    "2026-08-01",
    "in_progress",
    githubRef,
    nowIso(),
    "andres"
  );
  return res.meta.last_row_id as number;
}

// A stub `fetch` returning canned GitHub issue / issue-group JSON, keyed by URL,
// mirroring test/roadmap.test.ts:96-103.
function stubFetch(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.endsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function issuePayload(number: number, state: "open" | "closed", action: string) {
  return {
    action,
    issue: {
      number,
      title: `Issue ${number}`,
      html_url: `https://github.com/o/r/issues/${number}`,
      state,
      updated_at: "2026-07-01T10:00:00Z",
      user: { login: "AndresL230" },
      assignees: [],
      labels: [],
      milestone: null, // GitHub's own key — not Trov vocabulary
    },
  };
}

describe("upsertProgress + getProgress", () => {
  it("inserts then overwrites absolutely — the row reads the latest write, source included", async () => {
    const id = await seedSprint(null);
    await upsertProgress(systemCtx(), id, 3, 10, "event");
    let map = await getProgress(systemCtx());
    expect(map.get(id)).toMatchObject({ sprint_id: id, closed: 3, total: 10, source: "event" });

    await upsertProgress(systemCtx(), id, 5, 10, "recompute");
    map = await getProgress(systemCtx());
    expect(map.get(id)).toMatchObject({ sprint_id: id, closed: 5, total: 10, source: "recompute" });

    const rows = await all<SprintProgressRow>(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
    expect(rows).toHaveLength(1); // absolute overwrite, not a second row
  });
});

describe("applyEventProgress — group-number ref", () => {
  it("issue-closed fixture (GitHub issue group #3) upserts the matching sprint's cache row", async () => {
    // Verified fixture values (test/fixtures/gh-issue-closed.json): the group is
    // { number: 3, open_issues: 1, closed_issues: 5 } → closed:5, total:6.
    const id = await seedSprint("3");
    await applyEventProgress(systemCtx(), issueClosed);
    const row = await first<SprintProgressRow>(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
    expect(row).toMatchObject({ closed: 5, total: 6, source: "event" });
  });

  it("no-ops when no sprint has a matching github_ref", async () => {
    await seedSprint("99");
    await applyEventProgress(systemCtx(), issueClosed);
    expect(await all(env.DB, `SELECT * FROM sprint_progress`)).toHaveLength(0);
  });
});

describe("applyEventProgress — array ref", () => {
  it("recounts from the latest captured snapshot of each issue in the array", async () => {
    const id = await seedSprint("[7,8]");

    const [event7] = eventsFromDelivery("issues", issuePayload(7, "closed", "closed"));
    const [event8] = eventsFromDelivery("issues", issuePayload(8, "open", "opened"));
    await ingestEvent(systemCtx(), platformCtx(), event7, "github-webhook");
    await ingestEvent(systemCtx(), platformCtx(), event8, "github-webhook");

    await applyEventProgress(systemCtx(), issuePayload(7, "closed", "closed"));

    const row = await first<SprintProgressRow>(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
    expect(row).toMatchObject({ closed: 1, total: 2, source: "event" });
  });
});

describe("recomputeAllProgress", () => {
  it("writes source:'recompute' for every sprint with a github_ref; a failing fetch leaves the prior row untouched", async () => {
    const idOk = await seedSprint("5", "OK");
    const idBad = await seedSprint("[1]", "Bad");
    await upsertProgress(systemCtx(), idBad, 1, 4, "event"); // prior cache row that must survive a 401

    const fetchImpl = ((url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/milestones/5")) { // GitHub's own REST path — not Trov vocabulary
        return Promise.resolve(
          new Response(JSON.stringify({ open_issues: 2, closed_issues: 8 }), { status: 200, headers: { "content-type": "application/json" } })
        );
      }
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }) as unknown as typeof fetch;

    const result = await recomputeAllProgress(systemCtx(), { token: "t", repo: "o/r", fetchImpl });
    expect(result.updated).toBe(1);

    const rowOk = await first<SprintProgressRow>(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, idOk);
    expect(rowOk).toMatchObject({ closed: 8, total: 10, source: "recompute" });

    // The 401'd sprint's prior cache row is untouched — never wiped.
    const rowBad = await first<SprintProgressRow>(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, idBad);
    expect(rowBad).toMatchObject({ closed: 1, total: 4, source: "event" });
  });

  it("never writes for sprints with no github_ref", async () => {
    await seedSprint(null);
    const result = await recomputeAllProgress(systemCtx(), { token: "t", repo: "o/r", fetchImpl: stubFetch({}) });
    expect(result.updated).toBe(0);
    expect(await all(env.DB, `SELECT * FROM sprint_progress`)).toHaveLength(0);
  });
});

describe("webhook end-to-end — the progress seam", () => {
  const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding

  it("issue-closed fixture through handleGithubWebhook writes the sprint_progress cache row", async () => {
    const id = await seedSprint("3");
    const body = JSON.stringify(issueClosed);
    const sig = await sign(SECRET, body);
    const res = await handleGithubWebhook(
      new Request("https://x/webhook/github", {
        method: "POST",
        headers: { "x-github-event": "issues", "x-hub-signature-256": sig, "content-type": "application/json" },
        body,
      }),
      env as unknown as Env
    );
    expect(res.status).toBe(200);
    // "issues" is not a REPO_EVENT_NAMES entry, so the repo capture never runs.
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 0, unchanged: 0 } });

    const row = await first<SprintProgressRow>(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, id);
    expect(row).toMatchObject({ closed: 5, total: 6, source: "event" });
  });
});

describe("default export scheduled() — the recompute backstop wiring", () => {
  const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;
  const controller = {} as ScheduledController;

  it("no-ops without GITHUB_SERVICE_TOKEN or GITHUB_REPO (never throws)", async () => {
    await seedSprint("5"); // would be a recompute candidate if the guard didn't short-circuit
    const noToken = { ...env, GITHUB_SERVICE_TOKEN: undefined, GITHUB_REPO: "o/r" } as unknown as Env;
    await worker.scheduled(controller, noToken, ctx);
    expect(await all(env.DB, `SELECT * FROM sprint_progress`)).toHaveLength(0);

    const noRepo = { ...env, GITHUB_SERVICE_TOKEN: "svc-token", GITHUB_REPO: undefined } as unknown as Env;
    await worker.scheduled(controller, noRepo, ctx);
    expect(await all(env.DB, `SELECT * FROM sprint_progress`)).toHaveLength(0);
  });

  it("with a token and repo set, delegates to recomputeAllProgress (no candidates → no network, no rows)", async () => {
    const withToken = { ...env, GITHUB_SERVICE_TOKEN: "svc-token", GITHUB_REPO: "o/r" } as unknown as Env;
    await worker.scheduled(controller, withToken, ctx); // no github_ref sprints seeded → resolves without a real fetch
    expect(await all(env.DB, `SELECT * FROM sprint_progress`)).toHaveLength(0);
  });
});
