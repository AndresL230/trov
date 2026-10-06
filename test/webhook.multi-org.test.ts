/**
 * Multitenancy Phase 5b — GitHub webhooks are PER ORG (canopy-multitenancy.md §8.5, §10.2 "non-session
 * surfaces"). `POST /webhook/github/:hookId` verifies against THAT repo's secret and writes into THAT
 * org; the legacy `POST /webhook/github` delivers only to the `legacy_hook` repo (SaplingLearn's, on
 * the Worker's GITHUB_WEBHOOK_SECRET). Every refusal is checked to have written NOTHING, in any table.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import { all, first, run, nowIso } from "./helpers/db";
import { ORG_A, ORG_B, tenantCtx } from "./helpers/tenant";
import { SAPLING_HOOK, addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS } from "./helpers/repo";
import { rotateSecret, setSecret } from "../src/data/secrets";
import { webhookPath } from "../src/github-hook";
import prMerged from "./fixtures/gh-pr-merged.json";
import workflowRun from "./fixtures/gh-workflow-run.json";

const e = env as unknown as Env;
const LEGACY_SECRET = "test-webhook-secret"; // vitest.config.ts — the Worker's GITHUB_WEBHOOK_SECRET
const SECRET_B = "whsec_beta_0123456789abcdef0123456789";
const REPO_A = "SaplingLearn/sapling";
const REPO_B = "beta-co/app";
const HOOK_B = "hook_beta_app";
const GH_TOKEN_B = "ghs_beta_0123456789abcdef0123456789abcdef";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One delivery through the Worker's own fetch handler — routing included. `hook` null = the legacy URL. */
async function deliver(hook: string | null, secret: string, eventName: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return worker.fetch(new Request(`https://trov.test/webhook/github${hook === null ? "" : `/${hook}`}`, {
    method: "POST", body,
    headers: { "x-github-event": eventName, "x-hub-signature-256": await sign(secret, body), "content-type": "application/json" },
  }), e, execCtx);
}

const pr = (repo: string | null) => ({ ...prMerged, ...(repo === null ? {} : { repository: { full_name: repo } }) });
const issue = (repo: string, number = 31) => ({
  action: "opened", repository: { full_name: repo },
  issue: {
    number, title: "Checkout button is dead", body: "Steps…", html_url: `https://github.com/${repo}/issues/${number}`, state: "open", state_reason: null,
    updated_at: "2026-09-20T10:00:00Z", user: { login: "someone" }, assignees: [], labels: [],
  },
});

/** Row count of EVERY table, plus the bookkeeping columns a delivery may touch: a refusal must leave it identical. */
async function everything(): Promise<string> {
  const tables = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.name] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM "${t.name}"`))!.n;
  const secrets = await all(env.DB, `SELECT org_id, kind, scope, last_used_at, last_error FROM org_secrets ORDER BY org_id, kind, scope`);
  return JSON.stringify({ counts, secrets });
}
const eventOrgs = async () => (await all<{ org_id: string }>(env.DB, `SELECT org_id FROM events ORDER BY org_id`)).map((r) => r.org_id);
const lastUsed = async (org: string, scope: string) =>
  (await first<{ last_used_at: string | null }>(env.DB, `SELECT last_used_at FROM org_secrets WHERE org_id = ? AND kind = 'github_webhook' AND scope = ?`, org, scope))?.last_used_at ?? null;

/** SaplingLearn as 0037 leaves it (its repo flagged `legacy_hook`, no stored secret) and Acme with a stored one. */
async function twoOrgs(): Promise<void> {
  await addOrgRepo(REPO_A, ORG_A, { id: SAPLING_HOOK, legacyHook: true });
  await addOrgRepo(REPO_B, ORG_B, { id: HOOK_B });
  await setSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "github_webhook", HOOK_B, SECRET_B);
}

describe("webhookPath", () => {
  it("names the legacy hook, a per-org hook, or nothing", () => {
    expect(webhookPath("/webhook/github")).toEqual({ hookId: null });
    expect(webhookPath("/webhook/github/hook_beta_app")).toEqual({ hookId: "hook_beta_app" });
    for (const path of ["/webhook/github/", "/webhook/github/a/b", "/webhook/github/a%2Fb", "/webhook/gitlab/x", "/webhook"]) expect(webhookPath(path), path).toBeNull();
  });
});

describe("POST /webhook/github/:hookId", () => {
  it("a delivery signed with the repo's own secret is captured into THAT org, and marks the secret used", async () => {
    await twoOrgs();
    const res = await deliver(HOOK_B, SECRET_B, "pull_request", pr(REPO_B));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await eventOrgs()).toEqual([ORG_B]);
    expect(await all(env.DB, `SELECT org_id FROM repo_events`)).toEqual([{ org_id: ORG_B }]);
    expect(await lastUsed(ORG_B, HOOK_B)).not.toBeNull(); // what "Test connection" reports for a webhook
  });

  it("SaplingLearn's own per-org URL works too, on the legacy Worker secret, until its admin stores one", async () => {
    await twoOrgs();
    expect((await deliver(SAPLING_HOOK, LEGACY_SECRET, "pull_request", pr(REPO_A))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]);
    // Once a secret is stored it is the ONLY one that verifies — on either URL.
    const stored = "whsec_alpha_0123456789abcdef0123456789";
    await setSecret(await tenantCtx("AndresL230"), "github_webhook", SAPLING_HOOK, stored);
    const before = await everything();
    expect((await deliver(SAPLING_HOOK, LEGACY_SECRET, "issues", issue(REPO_A))).status).toBe(401);
    expect((await deliver(null, LEGACY_SECRET, "issues", issue(REPO_A))).status).toBe(401);
    expect(await everything()).toBe(before);
    expect((await deliver(null, stored, "issues", issue(REPO_A))).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, source_ref FROM tickets`)).toEqual([{ org_id: ORG_A, source_ref: `${REPO_A}#31` }]);
  });

  it("the wrong secret → 401 and NO rows: A's secret on B's hook, B's on A's, B's old secret after a rotation", async () => {
    await twoOrgs();
    const before = await everything();
    for (const [hook, secret, repo] of [
      [HOOK_B, LEGACY_SECRET, REPO_B], [HOOK_B, LEGACY_SECRET, REPO_A], [SAPLING_HOOK, SECRET_B, REPO_A], [SAPLING_HOOK, SECRET_B, REPO_B], [null, SECRET_B, REPO_A],
    ] as const) {
      for (const [name, payload] of [["pull_request", pr(repo)], ["issues", issue(repo)], ["workflow_run", { ...workflowRun, repository: { full_name: repo } }]] as const) {
        const res = await deliver(hook, secret, name, payload);
        expect(res.status, `${hook} ${name}`).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(res.headers.get("www-authenticate")).toBeNull();
      }
    }
    expect(await everything()).toBe(before); // not an event, not a ticket, not even a last_error
    await rotateSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "github_webhook", HOOK_B, "whsec_beta_rotated_0123456789abcdef");
    const rotated = await everything();
    expect((await deliver(HOOK_B, SECRET_B, "pull_request", pr(REPO_B))).status).toBe(401);
    expect(await everything()).toBe(rotated);
  });

  it("an unsigned or malformed signature → 401 and no rows", async () => {
    await twoOrgs();
    const before = await everything();
    for (const sig of [null, "", "sha256=", "sha256=zz", "sha1=abcdef"]) {
      const res = await worker.fetch(new Request(`https://trov.test/webhook/github/${HOOK_B}`, {
        method: "POST", body: JSON.stringify(pr(REPO_B)), headers: { "x-github-event": "pull_request", ...(sig === null ? {} : { "x-hub-signature-256": sig }) },
      }), e, execCtx);
      expect(res.status, String(sig)).toBe(401);
    }
    expect(await everything()).toBe(before);
  });

  it("an unknown hook id → the bare 401 and no rows, whatever it is signed with", async () => {
    await twoOrgs();
    const before = await everything();
    for (const secret of [LEGACY_SECRET, SECRET_B]) {
      const res = await deliver("hook_nobody", secret, "pull_request", pr(REPO_B));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await everything()).toBe(before);
  });

  it("unknown, suspended, no secret stored and a bad signature are indistinguishable: status, body and headers (§8.5)", async () => {
    await twoOrgs();
    await addOrgRepo("beta-co/unset", ORG_B, { id: "hook_beta_unset", primary: false }); // a real hook id with no secret
    await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by, suspended_at, suspended_by) VALUES ('org_gone', 'gone', 'Gone', ?, 'test', ?, 'test')`, nowIso(), nowIso());
    await addOrgRepo("gone-co/app", "org_gone", { id: "hook_gone_app" });
    const before = await everything();
    const refusals: [string, Response][] = [
      ["unknown", await deliver("hook_nobody", SECRET_B, "pull_request", pr(REPO_B))],
      ["suspended", await deliver("hook_gone_app", SECRET_B, "pull_request", pr("gone-co/app"))],
      ["no secret", await deliver("hook_beta_unset", SECRET_B, "pull_request", pr("beta-co/unset"))],
      ["bad signature", await deliver(HOOK_B, "not-the-secret", "pull_request", pr(REPO_B))],
      ["legacy, bad signature", await deliver(null, "not-the-secret", "pull_request", pr(REPO_A))],
    ];
    const shape = async (res: Response) => JSON.stringify({ status: res.status, headers: [...res.headers].sort(), body: await res.text() });
    const shapes = await Promise.all(refusals.map(([, res]) => shape(res)));
    expect(shapes[0]).toBe(JSON.stringify({ status: 401, headers: [["content-type", "application/json"]], body: `{"error":"unauthorized"}` }));
    refusals.forEach(([name], i) => expect(shapes[i], name).toBe(shapes[0]));
    expect(await everything()).toBe(before);
  });

  it("B's hook, B's secret, a payload naming A's repo (or none) → acknowledged, ignored, no rows in either org", async () => {
    await twoOrgs();
    await deliver(HOOK_B, SECRET_B, "pull_request", pr(REPO_B)); // so last_used_at is already inside its throttle
    const before = await everything();
    for (const [name, payload] of [
      ["pull_request", pr(REPO_A)], ["issues", issue(REPO_A)], ["pull_request", pr(null)], ["pull_request", pr("beta-co/other")],
    ] as const) {
      const res = await deliver(HOOK_B, SECRET_B, name, payload);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(await everything()).toBe(before);
  });

  it("the repo name is compared without case, as GitHub compares it", async () => {
    await twoOrgs();
    expect((await deliver(HOOK_B, SECRET_B, "pull_request", pr("Beta-Co/App"))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_B]);
  });

  it("an issue delivered to B's hook becomes a ticket in B — numbered and keyed in B, invisible to A", async () => {
    await twoOrgs();
    expect((await deliver(HOOK_B, SECRET_B, "issues", issue(REPO_B, 7))).status).toBe(200);
    expect((await deliver(null, LEGACY_SECRET, "issues", issue(REPO_A, 7))).status).toBe(200); // the same issue number, SaplingLearn's repo
    expect(await all(env.DB, `SELECT org_id, source_ref FROM tickets ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, source_ref: `${REPO_B}#7` }, { org_id: ORG_A, source_ref: `${REPO_A}#7` },
    ]);
    expect(await eventOrgs()).toEqual([ORG_B, ORG_A]);
  });

  it("the follow-up GitHub reads use the hook's ORG's token and repo — never the Worker's, never another org's", async () => {
    await twoOrgs();
    await setOrgEnvironments(ENVS, ORG_B);
    await setSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "github_token", "", GH_TOKEN_B);
    const seen: { url: string; auth: string | null }[] = [];
    const { handleGithubWebhook } = await import("../src/github-hook");
    const send = async (hook: string | null, secret: string, repo: string, env2: Env) => {
      const body = JSON.stringify({ ...workflowRun, repository: { full_name: repo } });
      return handleGithubWebhook(new Request("https://trov.test/x", {
        method: "POST", body, headers: { "x-github-event": "workflow_run", "x-hub-signature-256": await sign(secret, body) },
      }), env2, {
        hookId: hook,
        fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => {
          seen.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") });
          return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }) as typeof fetch,
      });
    };
    const withLegacyToken = { ...e, GITHUB_SERVICE_TOKEN: "ghs_legacy_worker_token_0000000000" } as Env;
    expect((await send(HOOK_B, SECRET_B, REPO_B, withLegacyToken)).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain(`/repos/${REPO_B}/actions/runs/`);
    expect(seen[0].auth).toBe(`Bearer ${GH_TOKEN_B}`);
    // SaplingLearn's legacy hook still reads with the Worker's token (its fallback) and its own repo.
    expect((await send(null, LEGACY_SECRET, REPO_A, withLegacyToken)).status).toBe(200);
    expect(seen[1].url).toContain(`/repos/${REPO_A}/actions/runs/`);
    expect(seen[1].auth).toBe("Bearer ghs_legacy_worker_token_0000000000");
    // An org with no token makes no GitHub read at all — the Worker's token is not its fallback.
    await run(env.DB, `DELETE FROM org_secrets WHERE org_id = ? AND kind = 'github_token'`, ORG_B);
    const again = { ...workflowRun, workflow_run: { ...workflowRun.workflow_run, id: workflowRun.workflow_run.id + 1 }, repository: { full_name: REPO_B } };
    const body = JSON.stringify(again);
    const res = await handleGithubWebhook(new Request("https://trov.test/x", { method: "POST", body, headers: { "x-github-event": "workflow_run", "x-hub-signature-256": await sign(SECRET_B, body) } }),
      withLegacyToken, { hookId: HOOK_B, fetchImpl: (async () => { throw new Error("no GitHub read expected"); }) as typeof fetch });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it("a non-primary repo's hook verifies but captures nothing yet", async () => {
    await twoOrgs();
    const second = await addOrgRepo("beta-co/docs", ORG_B, { id: "hook_beta_docs", primary: false });
    await setSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "github_webhook", second, "whsec_beta_docs_0123456789abcdef");
    const res = await deliver(second, "whsec_beta_docs_0123456789abcdef", "pull_request", pr("beta-co/docs"));
    expect(res.status).toBe(202);
    expect(await eventOrgs()).toEqual([]);
    expect(await lastUsed(ORG_B, second)).not.toBeNull(); // the delivery WAS verified
  });

  it("a suspended org's hook reads as unknown", async () => {
    await twoOrgs();
    await run(env.DB, `UPDATE orgs SET suspended_at = ?, suspended_by = 'AndresL230' WHERE id = ?`, nowIso(), ORG_B);
    const before = await everything();
    expect((await deliver(HOOK_B, SECRET_B, "pull_request", pr(REPO_B))).status).toBe(401);
    expect(await everything()).toBe(before);
  });

  it("only POST is a delivery", async () => {
    await twoOrgs();
    const res = await worker.fetch(new Request(`https://trov.test/webhook/github/${HOOK_B}`), e, execCtx);
    expect(res.status).not.toBe(200);
    expect(await eventOrgs()).toEqual([]);
  });
});

describe("the legacy POST /webhook/github", () => {
  it("delivers to the legacy_hook repo's org on the Worker's secret, unchanged — a payload naming no repository included", async () => {
    await twoOrgs();
    expect((await deliver(null, LEGACY_SECRET, "pull_request", prMerged)).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]);
    expect(await all(env.DB, `SELECT 1 FROM events WHERE org_id = ?`, ORG_B)).toEqual([]);
  });

  it("with no legacy_hook repo left (the owner re-pointed the webhook and cleared the flag) it is a bare 401", async () => {
    await twoOrgs();
    await run(env.DB, `UPDATE org_repos SET legacy_hook = 0`);
    const before = await everything();
    for (const secret of [LEGACY_SECRET, SECRET_B]) expect((await deliver(null, secret, "pull_request", pr(REPO_A))).status).toBe(401);
    expect(await everything()).toBe(before);
    // …while the per-org URL keeps working — for B on its stored secret.
    expect((await deliver(HOOK_B, SECRET_B, "pull_request", pr(REPO_B))).status).toBe(200);
  });

  it("the Worker's secret verifies NOTHING for another org's hook, even one flagged legacy_hook", async () => {
    await addOrgRepo(REPO_B, ORG_B, { id: HOOK_B, legacyHook: true }); // no stored secret, and no SaplingLearn row at all
    const before = await everything();
    expect((await deliver(null, LEGACY_SECRET, "pull_request", pr(REPO_B))).status).toBe(401);
    expect((await deliver(HOOK_B, LEGACY_SECRET, "pull_request", pr(REPO_B))).status).toBe(401);
    expect(await everything()).toBe(before);
  });
});
