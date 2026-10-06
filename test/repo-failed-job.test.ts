import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { first } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { fillFailedJob } from "../src/repo/github";

const jobs = { jobs: [
  { name: "lint", conclusion: "success", steps: [] },
  { name: "e2e", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Run supabase/setup-cli@v1", conclusion: "failure" }, { name: "Teardown", conclusion: "failure" }] },
] };

describe("fillFailedJob", () => {
  it("records the first failing job and its first failing step", async () => {
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:run:9:1", kind: "run", number: 9, name: "e2e", state: "failure", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T09:20:00Z" });
    const fetchImpl = (async (u: RequestInfo | URL) => {
      expect(String(u)).toBe("https://api.github.com/repos/o/r/actions/runs/9/jobs?filter=latest&per_page=100");
      return new Response(JSON.stringify(jobs), { status: 200 });
    }) as typeof fetch;
    await fillFailedJob(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, 9, "gh:run:9:1");
    expect(await first(env.DB, `SELECT title FROM repo_events WHERE semantic_key = 'gh:run:9:1'`)).toEqual({ title: "e2e · Run supabase/setup-cli@v1" });
  });

  it("leaves the row alone when GitHub fails", async () => {
    await ingestRepoEvent(systemCtx(), { semantic_key: "gh:run:9:1", kind: "run", number: 9, state: "failure", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T09:20:00Z" });
    const fetchImpl = (async () => new Response("no", { status: 502 })) as typeof fetch;
    await expect(fillFailedJob(systemCtx(), { token: "t", repo: "o/r", fetchImpl }, 9, "gh:run:9:1")).resolves.toBeUndefined();
    expect(await first(env.DB, `SELECT title FROM repo_events WHERE semantic_key = 'gh:run:9:1'`)).toEqual({ title: null });
  });
});
