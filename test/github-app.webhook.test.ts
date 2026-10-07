/**
 * The GitHub App's ONE webhook, `POST /webhook/github/app` (src/github-app/webhook.ts;
 * docs/architecture/github-app.md › The webhook). Every installation delivers to the same URL, so the
 * org comes from the delivery's installation id — and only through a LIVE binding. Every refusal and
 * every ignored delivery is checked to have written NOTHING, in any table.
 */
import { beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import { all, first, run, nowIso } from "./helpers/db";
import { ORG_A, ORG_B, tenantCtx } from "./helpers/tenant";
import { SAPLING_HOOK, addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS } from "./helpers/repo";
import { APP_WEBHOOK_SECRET, fakeApp, seedInstallation, signAppWebhook } from "./helpers/github-app";
import { setSecret } from "../src/data/secrets";
import { clearInstallationTokens } from "../src/github-app/api";
import { clearRepoLists } from "../src/github-app/repos";
import { handleGithubAppWebhook } from "../src/github-app/webhook";
import prMerged from "./fixtures/gh-pr-merged.json";
import workflowRun from "./fixtures/gh-workflow-run.json";

const e = env as unknown as Env;
const LEGACY_SECRET = "test-webhook-secret"; // vitest.config.ts — the Worker's GITHUB_WEBHOOK_SECRET
const SECRET_B = "whsec_beta_0123456789abcdef0123456789";
const REPO_A = "SaplingLearn/sapling";
const REPO_B = "beta-co/app";
const HOOK_B = "hook_beta_app";
const INST_A = 601;
const INST_B = 501;
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeEach(() => { clearInstallationTokens(); clearRepoLists(); });

/** One delivery to the App's endpoint through the Worker's own fetch handler — routing included. */
async function deliver(eventName: string, payload: unknown, o: { secret?: string | null; sig?: string | null; env?: Env } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = o.sig !== undefined ? o.sig : await signAppWebhook(body, o.secret ?? APP_WEBHOOK_SECRET);
  return worker.fetch(new Request("https://trov.test/webhook/github/app", {
    method: "POST", body, headers: { "x-github-event": eventName, "content-type": "application/json", ...(sig === null ? {} : { "x-hub-signature-256": sig }) },
  }), o.env ?? e, execCtx);
}
/** The same event through an org's OLD per-repo (or legacy) webhook, signed with that hook's secret. */
async function deliverOld(hook: string | null, secret: string, eventName: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return worker.fetch(new Request(`https://trov.test/webhook/github${hook === null ? "" : `/${hook}`}`, {
    method: "POST", body, headers: { "x-github-event": eventName, "x-hub-signature-256": await signAppWebhook(body, secret), "content-type": "application/json" },
  }), e, execCtx);
}

const pr = (repo: string, installation: number | null) => ({ ...prMerged, repository: { full_name: repo }, ...(installation === null ? {} : { installation: { id: installation } }) });
const issue = (repo: string, installation: number, number = 31) => ({
  action: "opened", repository: { full_name: repo }, installation: { id: installation },
  issue: { number, title: "Checkout button is dead", body: "Steps…", html_url: `https://github.com/${repo}/issues/${number}`, state: "open", state_reason: null, updated_at: "2026-09-20T10:00:00Z", user: { login: "someone" }, assignees: [], labels: [] },
});

async function everything(): Promise<string> {
  const tables = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.name] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM "${t.name}"`))!.n;
  return JSON.stringify({
    counts,
    installations: await all(env.DB, `SELECT * FROM org_github_installations ORDER BY id`),
    repos: await all(env.DB, `SELECT * FROM org_repos ORDER BY id`),
    secrets: await all(env.DB, `SELECT org_id, kind, scope, last_used_at, last_error FROM org_secrets ORDER BY org_id, kind, scope`),
  });
}
const eventOrgs = async () => (await all<{ org_id: string }>(env.DB, `SELECT org_id FROM events ORDER BY org_id`)).map((r) => r.org_id);
const binding = (org: string) => first<{ suspended_at: string | null; removed_at: string | null; removed_reason: string | null; repository_selection: string }>(env.DB,
  `SELECT suspended_at, removed_at, removed_reason, repository_selection FROM org_github_installations WHERE org_id = ? ORDER BY id DESC LIMIT 1`, org);
const audit = (org: string) => all<{ actor: string; action: string; target: string }>(env.DB, `SELECT actor, action, target FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%' ORDER BY id`, org);

/** SaplingLearn and Acme, each with its primary repository connected through its OWN installation. */
async function twoOrgs(): Promise<void> {
  await addOrgRepo(REPO_A, ORG_A, { id: SAPLING_HOOK, legacyHook: true });
  await addOrgRepo(REPO_B, ORG_B, { id: HOOK_B });
  await run(env.DB, `UPDATE org_repos SET connection = 'app'`);
  await seedInstallation(ORG_A, INST_A, "SaplingLearn");
  await seedInstallation(ORG_B, INST_B, "beta-co", { by: "bob" });
}

describe("POST /webhook/github/app — is it GitHub?", () => {
  it("a delivery signed with the App's secret is captured into the org its installation is connected to", async () => {
    await twoOrgs();
    const res = await deliver("pull_request", pr(REPO_B, INST_B));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await eventOrgs()).toEqual([ORG_B]);
    expect(await all(env.DB, `SELECT org_id FROM repo_events`)).toEqual([{ org_id: ORG_B }]);
  });

  it("unsigned, malformed, signed with another secret, or no secret configured: the SAME bare 401 as the per-repo hook's, and no rows", async () => {
    await twoOrgs();
    await setSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "github_webhook", HOOK_B, SECRET_B);
    const before = await everything();
    const payload = pr(REPO_B, INST_B);
    const refusals: [string, Response][] = [
      ["unsigned", await deliver("pull_request", payload, { sig: null })],
      ["empty", await deliver("pull_request", payload, { sig: "" })],
      ["no digest", await deliver("pull_request", payload, { sig: "sha256=" })],
      ["not hex", await deliver("pull_request", payload, { sig: "sha256=zz" })],
      ["sha1", await deliver("pull_request", payload, { sig: "sha1=abcdef" })],
      ["another secret", await deliver("pull_request", payload, { secret: "not-the-secret" })],
      ["the legacy webhook's secret", await deliver("pull_request", payload, { secret: LEGACY_SECRET })],
      ["org B's per-repo secret", await deliver("pull_request", payload, { secret: SECRET_B })],
      ["no secret configured", await deliver("pull_request", payload, { env: { ...e, GITHUB_APP_WEBHOOK_SECRET: "" } as Env })],
      ["no secret configured (the binding is absent)", await deliver("pull_request", payload, { env: { ...e, GITHUB_APP_WEBHOOK_SECRET: undefined } as Env })],
      ["an installation event, badly signed", await deliver("installation", { action: "deleted", installation: { id: INST_B } }, { secret: "nope" })],
      // …and the per-repo hook's own refusal, to compare with.
      ["per-repo hook, unknown id", await deliverOld("hook_nobody", SECRET_B, "pull_request", payload)],
    ];
    const shape = async (res: Response) => JSON.stringify({ status: res.status, headers: [...res.headers].sort(), body: await res.text() });
    const shapes = await Promise.all(refusals.map(([, res]) => shape(res)));
    expect(shapes[0]).toBe(JSON.stringify({ status: 401, headers: [["content-type", "application/json"]], body: `{"error":"unauthorized"}` }));
    refusals.forEach(([name], i) => expect(shapes[i], name).toBe(shapes[0]));
    expect(await everything()).toBe(before); // not an event, not a ticket, not a last_error, the binding untouched
  });

  it("only POST is a delivery, and `app` is never read as a repository's hook id", async () => {
    await twoOrgs();
    const get = await worker.fetch(new Request("https://trov.test/webhook/github/app"), e, execCtx);
    expect(get.status).not.toBe(200);
    // Signed with the App's secret it reaches the App's handler; signed with anything else it is the bare 401.
    expect((await deliver("ping", { zen: "x" })).status).toBe(202);
    expect(await eventOrgs()).toEqual([]);
  });
});

describe("which org — and only that org", () => {
  it("an installation Trov does not know, or a payload naming none: acknowledged, ignored, no rows", async () => {
    await twoOrgs();
    const before = await everything();
    for (const [name, payload] of [
      ["pull_request", pr(REPO_B, 99999)], ["pull_request", pr(REPO_B, null)], ["issues", issue(REPO_A, 424242)],
      ["pull_request", { ...pr(REPO_B, null), installation: { id: "501" } }], ["pull_request", { ...pr(REPO_B, null), installation: null }],
      ["installation", { action: "deleted", installation: { id: 99999 } }], ["installation", { action: "created", installation: { id: 99999 } }],
      ["installation_repositories", { action: "removed", installation: { id: 99999 }, repositories_removed: [{ full_name: REPO_B }] }],
    ] as const) {
      const res = await deliver(name, payload);
      expect(res.status, name).toBe(202);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    // A body that is not JSON at all, correctly signed.
    const raw = "not json";
    const res = await worker.fetch(new Request("https://trov.test/webhook/github/app", { method: "POST", body: raw, headers: { "x-github-event": "push", "x-hub-signature-256": await signAppWebhook(raw) } }), e, execCtx);
    expect(res.status).toBe(202);
    expect(await everything()).toBe(before);
  });

  it("org A's installation never delivers into org B: a delivery naming a repository THAT org does not track is ignored, in both orgs", async () => {
    await twoOrgs();
    const before = await everything();
    // A's installation, B's repository — and the reverse. Each is validly signed (the App has ONE secret).
    for (const [name, payload] of [["pull_request", pr(REPO_B, INST_A)], ["issues", issue(REPO_B, INST_A)], ["pull_request", pr(REPO_A, INST_B)], ["issues", issue(REPO_A, INST_B)], ["pull_request", pr("beta-co/other", INST_B)]] as const) {
      const res = await deliver(name, payload);
      expect(res.status, `${name} ${JSON.stringify((payload as { installation?: unknown }).installation)}`).toBe(202);
    }
    expect(await everything()).toBe(before);
    // Each installation's own repository lands in its own org, and nowhere else.
    expect((await deliver("issues", issue(REPO_A, INST_A, 7))).status).toBe(200);
    expect((await deliver("issues", issue(REPO_B, INST_B, 7))).status).toBe(200); // the same issue number, the other org's repo
    expect(await all(env.DB, `SELECT org_id, source_ref FROM tickets ORDER BY org_id`)).toEqual([
      { org_id: ORG_B, source_ref: `${REPO_B}#7` }, { org_id: ORG_A, source_ref: `${REPO_A}#7` },
    ]);
    expect(await eventOrgs()).toEqual([ORG_B, ORG_A]);
  });

  it("an installation bound to another org delivers to THAT org only — whichever org used to hold it", async () => {
    await twoOrgs();
    // B lets its installation go; A's is untouched. The freed installation is then connected by A's neighbour… to nobody yet.
    await run(env.DB, `UPDATE org_github_installations SET removed_at = ?, removed_reason = 'disconnected' WHERE org_id = ?`, nowIso(), ORG_B);
    const before = await everything();
    expect((await deliver("pull_request", pr(REPO_B, INST_B))).status).toBe(202); // an ended binding is no binding
    expect(await everything()).toBe(before);
    // Now SaplingLearn's installation id is 501 (it reconnected through the other account) and it tracks that repo.
    await run(env.DB, `UPDATE org_github_installations SET removed_at = ?, removed_reason = 'disconnected' WHERE org_id = ?`, nowIso(), ORG_A);
    await seedInstallation(ORG_A, INST_B, "beta-co");
    await run(env.DB, `UPDATE org_repos SET repo_full_name = ? WHERE org_id = ?`, REPO_B, ORG_A);
    expect((await deliver("pull_request", pr(REPO_B, INST_B))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]); // B tracks the very same repository name, and got nothing
  });

  it("the repository name is compared without case; a non-primary repository is ignored (capture is the primary's)", async () => {
    await twoOrgs();
    await addOrgRepo("beta-co/docs", ORG_B, { id: "hook_beta_docs", primary: false });
    expect((await deliver("pull_request", pr("beta-co/docs", INST_B))).status).toBe(202);
    expect(await eventOrgs()).toEqual([]);
    expect((await deliver("pull_request", pr("Beta-Co/App", INST_B))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_B]);
  });

  it("a suspended Trov org captures nothing — but an uninstall on GitHub still ends its binding", async () => {
    await twoOrgs();
    await run(env.DB, `UPDATE orgs SET suspended_at = ?, suspended_by = 'AndresL230' WHERE id = ?`, nowIso(), ORG_B);
    const before = await everything();
    expect((await deliver("pull_request", pr(REPO_B, INST_B))).status).toBe(202);
    expect(await everything()).toBe(before);
    expect((await deliver("installation", { action: "deleted", installation: { id: INST_B } })).status).toBe(200);
    expect(await binding(ORG_B)).toMatchObject({ removed_reason: "uninstalled" });
  });
});

describe("one event through BOTH paths (the cut-over)", () => {
  it("a pull request delivered through the App's webhook and the org's old per-repo webhook yields ONE set of rows, in either order", async () => {
    await twoOrgs();
    await setSecret(await tenantCtx("bob", "admin", { orgId: ORG_B }), "github_webhook", HOOK_B, SECRET_B);
    const rows = async () => JSON.stringify({
      events: await all(env.DB, `SELECT org_id, event_type, semantic_key FROM events ORDER BY id`),
      repo: await all(env.DB, `SELECT org_id, kind, semantic_key FROM repo_events ORDER BY id`),
      processed: (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM processed_items`))!.n,
      summaries: (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM pr_summaries`))!.n,
    });
    // App first, then the old hook.
    const first1 = await deliver("pull_request", pr(REPO_B, INST_B));
    expect(await first1.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    const once = await rows();
    const second = await deliverOld(HOOK_B, SECRET_B, "pull_request", pr(REPO_B, INST_B));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 1 } });
    expect(await rows()).toBe(once);
    // …and a third time through the App again.
    expect(await (await deliver("pull_request", pr(REPO_B, INST_B))).json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 1 } });
    expect(await rows()).toBe(once);
    expect(JSON.parse(once).events).toHaveLength(1);

    // SaplingLearn: its LEGACY hook first, then the App.
    const legacy = await deliverOld(null, LEGACY_SECRET, "issues", issue(REPO_A, INST_A, 9));
    expect(legacy.status).toBe(200);
    const afterLegacy = await all(env.DB, `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ?`, ORG_A);
    const viaApp = await deliver("issues", issue(REPO_A, INST_A, 9));
    expect(await viaApp.json()).toMatchObject({ ok: true, captured: 0, unchanged: 1 });
    expect(await all(env.DB, `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ?`, ORG_A)).toEqual(afterLegacy);
    expect(await all(env.DB, `SELECT org_id, source_ref FROM tickets`)).toEqual([{ org_id: ORG_A, source_ref: `${REPO_A}#9` }]);
    expect(await all(env.DB, `SELECT COUNT(*) AS n FROM events WHERE org_id = ?`, ORG_A)).toEqual([{ n: 1 }]);
  });
});

describe("the follow-up reads", () => {
  it("use the delivering org's INSTALLATION token, minted for its own installation — never another org's, never the Worker's", async () => {
    await twoOrgs();
    await setOrgEnvironments(ENVS, ORG_B);
    await setOrgEnvironments(ENVS, ORG_A);
    const gh = fakeApp({ installations: {
      [INST_A]: { account: { login: "SaplingLearn", id: 1, type: "Organization" }, repos: [{ full_name: REPO_A }] },
      [INST_B]: { account: { login: "beta-co", id: 2, type: "Organization" }, repos: [{ full_name: REPO_B }] },
    } });
    const reads: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/repos/")) { reads.push({ url, auth: new Headers(init?.headers).get("authorization") }); return new Response(JSON.stringify({ jobs: [] }), { status: 200 }); }
      return gh.fetchImpl(input, init);
    }) as typeof fetch;
    const withLegacyToken = { ...e, GITHUB_SERVICE_TOKEN: "ghs_legacy_worker_token_0000000000" } as Env;
    const send = async (repo: string, installation: number, runId: number) => {
      const body = JSON.stringify({ ...workflowRun, workflow_run: { ...workflowRun.workflow_run, id: runId }, repository: { full_name: repo }, installation: { id: installation } });
      return handleGithubAppWebhook(new Request("https://trov.test/webhook/github/app", { method: "POST", body, headers: { "x-github-event": "workflow_run", "x-hub-signature-256": await signAppWebhook(body) } }), withLegacyToken, { fetchImpl });
    };
    expect((await send(REPO_B, INST_B, 1)).status).toBe(200);
    expect((await send(REPO_A, INST_A, 2)).status).toBe(200);
    expect(reads).toHaveLength(2);
    expect(reads[0].url).toContain(`/repos/${REPO_B}/actions/runs/`);
    expect(reads[0].auth).toBe(`Bearer ${gh.tokenFor(INST_B)}`);
    expect(reads[1].url).toContain(`/repos/${REPO_A}/actions/runs/`);
    expect(reads[1].auth).toBe(`Bearer ${gh.tokenFor(INST_A)}`); // SaplingLearn too: the installation outranks the Worker's legacy token
    expect(gh.tokenFor(INST_A)).not.toBe(gh.tokenFor(INST_B));
    expect(gh.seen.filter((s) => s.url.includes("/access_tokens")).map((s) => s.url)).toEqual([
      `https://api.github.com/app/installations/${INST_B}/access_tokens`, `https://api.github.com/app/installations/${INST_A}/access_tokens`,
    ]);
    // The token was minted once per installation and reused by the next delivery.
    expect((await send(REPO_B, INST_B, 3)).status).toBe(200);
    expect(gh.minted).toHaveLength(2);
    expect(reads[2].auth).toBe(reads[0].auth);
  });
});

describe("the installation's own events", () => {
  it("installation.deleted ends the binding (audited as the webhook), frees the repositories back to manual, and later deliveries are ignored", async () => {
    await twoOrgs();
    const res = await deliver("installation", { action: "deleted", installation: { id: INST_B, account: { login: "beta-co" } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, installation: "deleted" });
    expect(await binding(ORG_B)).toMatchObject({ removed_reason: "uninstalled" });
    expect((await binding(ORG_B))!.removed_at).not.toBeNull();
    expect(await audit(ORG_B)).toEqual([{ actor: "github-webhook", action: "github.uninstall", target: "beta-co" }]);
    expect(await all(env.DB, `SELECT connection, access_lost_at FROM org_repos WHERE org_id = ?`, ORG_B)).toEqual([{ connection: "manual", access_lost_at: null }]);
    // SaplingLearn's binding and repositories are untouched.
    expect(await binding(ORG_A)).toMatchObject({ removed_at: null });
    expect(await all(env.DB, `SELECT connection FROM org_repos WHERE org_id = ?`, ORG_A)).toEqual([{ connection: "app" }]);
    expect(await audit(ORG_A)).toEqual([]);
    const before = await everything();
    expect((await deliver("pull_request", pr(REPO_B, INST_B))).status).toBe(202);
    expect((await deliver("installation", { action: "deleted", installation: { id: INST_B } })).status).toBe(202); // a redelivery: nothing left to end
    expect(await everything()).toBe(before);
  });

  it("suspend / unsuspend mark the binding and are audited once each; new_permissions_accepted is recorded", async () => {
    await twoOrgs();
    expect((await deliver("installation", { action: "suspend", installation: { id: INST_B } })).status).toBe(200);
    expect((await binding(ORG_B))!.suspended_at).not.toBeNull();
    expect((await deliver("installation", { action: "suspend", installation: { id: INST_B } })).status).toBe(200); // redelivered
    expect((await deliver("installation", { action: "unsuspend", installation: { id: INST_B } })).status).toBe(200);
    expect((await binding(ORG_B))!.suspended_at).toBeNull();
    expect((await deliver("installation", { action: "new_permissions_accepted", installation: { id: INST_B } })).status).toBe(200);
    expect((await audit(ORG_B)).map((a) => [a.actor, a.action])).toEqual([
      ["github-webhook", "github.suspend"], ["github-webhook", "github.unsuspend"], ["github-webhook", "github.permissions"],
    ]);
    // `created` binds nothing: a binding is only ever made by the connect flow.
    expect((await deliver("installation", { action: "created", installation: { id: INST_B } })).status).toBe(202);
    expect(await binding(ORG_A)).toMatchObject({ suspended_at: null, removed_at: null });
  });

  it("installation_repositories: a removed repository is marked as no longer visible, an added one as reachable again", async () => {
    await twoOrgs();
    await addOrgRepo("beta-co/docs", ORG_B, { id: "hook_beta_docs", primary: false }); // connected by hand
    const marks = () => all(env.DB, `SELECT repo_full_name, connection, access_lost_at IS NOT NULL AS lost FROM org_repos WHERE org_id = ? ORDER BY repo_full_name`, ORG_B);
    const removed = await deliver("installation_repositories", {
      action: "removed", installation: { id: INST_B }, repository_selection: "selected",
      repositories_added: [], repositories_removed: [{ full_name: "Beta-Co/App" }, { full_name: "beta-co/unrelated" }],
    });
    expect(removed.status).toBe(200);
    expect(await marks()).toEqual([{ repo_full_name: REPO_B, connection: "app", lost: 1 }, { repo_full_name: "beta-co/docs", connection: "manual", lost: 0 }]);
    expect(await binding(ORG_B)).toMatchObject({ repository_selection: "selected" });
    const added = await deliver("installation_repositories", {
      action: "added", installation: { id: INST_B }, repository_selection: "selected",
      repositories_added: [{ full_name: REPO_B }, { full_name: "beta-co/docs" }], repositories_removed: [],
    });
    expect(added.status).toBe(200);
    expect(await marks()).toEqual([{ repo_full_name: REPO_B, connection: "app", lost: 0 }, { repo_full_name: "beta-co/docs", connection: "app", lost: 0 }]);
    expect(await all(env.DB, `SELECT actor, action, detail FROM org_admin_audit WHERE org_id = ? AND action = 'github.repos' ORDER BY id`, ORG_B)).toEqual([
      { actor: "github-webhook", action: "github.repos", detail: JSON.stringify({ installation_id: INST_B, added: [], removed: ["Beta-Co/App", "beta-co/unrelated"] }) },
      { actor: "github-webhook", action: "github.repos", detail: JSON.stringify({ installation_id: INST_B, added: [REPO_B, "beta-co/docs"], removed: [] }) },
    ]);
    // SaplingLearn's rows did not move.
    expect(await all(env.DB, `SELECT connection, access_lost_at FROM org_repos WHERE org_id = ?`, ORG_A)).toEqual([{ connection: "app", access_lost_at: null }]);
  });
});
