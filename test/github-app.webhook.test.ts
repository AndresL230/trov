// The GitHub App's webhook (src/github-app/webhook.ts; spec §7): ONE URL for every installation, signed with the
// App's secret, whose INSTALLATION names the org. Every refusal writes nothing; an installation bound to org A
// never delivers into org B, nor into a repo of A's that is not its own, attached and primary; installation
// lifecycle events keep the binding true even for a suspended org, whose capture is ignored; a capture is the
// per-repo hook's own (a redelivery — or the legacy hook's copy — is `unchanged`), and its follow-up reads use an
// installation token, minted once. No App secret, JWT or installation token in a response or a console line.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/index";
import { githubAppWebhookPath, handleGithubAppWebhook } from "../src/github-app/webhook";
import { githubAppConfig } from "../src/github-app/config";
import { setSecret } from "../src/data/secrets";
import { all, first, run, nowIso } from "./helpers/db";
import { ORG_A, ORG_B, tenantCtx } from "./helpers/tenant";
import { addOrgRepo, setOrgEnvironments } from "./helpers/org-config";
import { ENVS, fakeGithub, leakedFragments } from "./helpers/repo";
import { APP, appEnv, attachRepo, fakeAppGithub, installationToken, seedInstallation } from "./helpers/github-app";
import prMerged from "./fixtures/gh-pr-merged.json";
import workflowRun from "./fixtures/gh-workflow-run.json";
import pushFixture from "./fixtures/gh-push.json";

const e = env as unknown as Env;
const URL_APP = "https://trov.test/webhook/github-app";
const ID = 5150;            // bound to org A; covers REPO (attached, primary) and acme/lib
const OTHER_ID = 6160;      // a second installation bound to org A
const FOREIGN_ID = 7170;    // bound to org B
const UNBOUND_ID = 9090;    // nobody bound it
const REPO = "acme/app";
const HOOK_A = "hook_a_app";
const HOOK_B = "hook_b_app"; // org B's primary: the SAME name, connected the 0037 way
const HOOK_SECRET = "whsec_alpha_".padEnd(48, "2468ace0");
const PASTED = "ghp_pasted_".padEnd(64, "a1b2c3d4e5f60789");
const INST = installationToken(ID);
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let APPENV: Env;
beforeAll(async () => { APPENV = await appEnv(); });

// ── every console line and response body of every test is checked for every secret ──
const logged: unknown[][] = [];
const bodies: string[] = [];
const jwts: string[] = [];
beforeEach(() => {
  logged.length = 0;
  bodies.length = 0;
  jwts.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const cfg = githubAppConfig(APPENV)!;
  const keyBody = cfg.privateKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const lines = logged.map((args) => args.map((a) => `${String(a)} ${inspect(a, { depth: 6 })} ${a instanceof Error ? a.stack : ""}`).join(" ")).join("\n");
  const stored = JSON.stringify(await all(env.DB, `SELECT * FROM github_installations`)) + JSON.stringify(await all(env.DB, `SELECT * FROM org_admin_audit`))
    + JSON.stringify(await all(env.DB, `SELECT last_error FROM org_secrets`));
  const text = `${lines}\n${bodies.join("\n")}\n${stored}`;
  for (const secret of [keyBody, APP.clientSecret, APP.webhookSecret, INST, PASTED, ...jwts]) expect(leakedFragments(text, secret), secret.slice(0, 10)).toEqual([]);
});

// ── deliveries ───────────────────────────────────────────────────────────────

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface DeliverOpts { secret?: string; sig?: string | null; raw?: string; env?: Env; method?: string }

/** One App delivery through the Worker's own fetch handler — routing included. Signed with the App's secret
 *  unless `secret` / `sig` say otherwise; `raw` sends that text instead of the payload's JSON. */
async function deliver(event: string, payload: unknown, o: DeliverOpts = {}): Promise<Response> {
  const body = o.raw ?? JSON.stringify(payload);
  const sig = o.sig === undefined ? await sign(o.secret ?? APP.webhookSecret, body) : o.sig;
  const res = await worker.fetch(new Request(URL_APP, {
    method: o.method ?? "POST", body: o.method === "GET" ? undefined : body,
    headers: { "x-github-event": event, "content-type": "application/json", ...(sig === null ? {} : { "x-hub-signature-256": sig }) },
  }), o.env ?? APPENV, execCtx);
  bodies.push(await res.clone().text());
  return res;
}

/** The same delivery straight into the handler, with a fake GitHub for its follow-up reads (awaited: no waitUntil). */
async function deliverDirect(event: string, payload: unknown, fetchImpl: typeof fetch): Promise<Response> {
  const body = JSON.stringify(payload);
  const res = await handleGithubAppWebhook(new Request(URL_APP, {
    method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": await sign(APP.webhookSecret, body) },
  }), APPENV, { fetchImpl, summarizer: null, issueSummarizer: null });
  bodies.push(await res.clone().text());
  return res;
}

const via = (id: number) => ({ installation: { id, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u" } });
const pr = (repo = REPO, id = ID) => ({ ...prMerged, repository: { full_name: repo }, ...via(id) });
const issue = (repo = REPO, number = 31, id = ID) => ({
  action: "opened", repository: { full_name: repo }, ...via(id),
  issue: {
    number, title: "Checkout button is dead", body: "Steps…", html_url: `https://github.com/${repo}/issues/${number}`, state: "open", state_reason: null,
    updated_at: "2026-09-20T10:00:00Z", user: { login: "someone" }, assignees: [], labels: [],
  },
});
/** An `installation` event: `o` overrides the installation object's fields, except `repositories`, which GitHub
 *  sends beside it at the top level. */
const lifecycle = (action: string, o: Record<string, unknown> = {}, id = ID) => {
  const { repositories, ...inst } = o;
  return {
    action, installation: { id, account: { login: "acme", id: 9001, type: "Organization" }, repository_selection: "selected", suspended_at: null, ...inst },
    ...(repositories === undefined ? {} : { repositories }), sender: { login: "octo" },
  };
};
const repoChange = (action: "added" | "removed", repos: { id: number; full_name: string }[], id = ID) => ({
  action, ...via(id), repository_selection: "selected",
  repositories_added: action === "added" ? repos.map((r) => ({ ...r, private: true })) : [],
  repositories_removed: action === "removed" ? repos : [],
});

// ── state ────────────────────────────────────────────────────────────────────

/**
 * Org A: REPO primary, attached to installation ID (which also covers acme/lib), a second installation OTHER_ID.
 * Org B: the SAME repo name as its primary, connected the 0037 way, and its own installation FOREIGN_ID.
 */
async function world(o: { attached?: boolean } = {}): Promise<void> {
  await addOrgRepo(REPO, ORG_A, { id: HOOK_A });
  await seedInstallation(ORG_A, ID, [{ id: 77, full_name: REPO }, { id: 78, full_name: "acme/lib" }]);
  await seedInstallation(ORG_A, OTHER_ID, [], { login: "acme-other" });
  if (o.attached !== false) await attachRepo(HOOK_A, ID);
  await addOrgRepo(REPO, ORG_B, { id: HOOK_B });
  await seedInstallation(ORG_B, FOREIGN_ID, [{ id: 90, full_name: "beta-co/web" }], { login: "beta-co" });
}

/** Row count of EVERY table, plus the bookkeeping a delivery may touch: a refusal must leave it identical. */
async function everything(): Promise<string> {
  const tables = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.name] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM "${t.name}"`))!.n;
  return JSON.stringify({
    counts,
    secrets: await all(env.DB, `SELECT org_id, kind, scope, last_used_at, last_error FROM org_secrets ORDER BY org_id, kind, scope`),
    installations: await all(env.DB, `SELECT * FROM github_installations ORDER BY installation_id`),
    repos: await all(env.DB, `SELECT org_id, id, repo_full_name, is_primary, installation_id FROM org_repos ORDER BY id`),
  });
}
const eventOrgs = async () => (await all<{ org_id: string }>(env.DB, `SELECT org_id FROM events ORDER BY org_id`)).map((r) => r.org_id);
const lastDelivery = async (id = ID) =>
  (await first<{ last_delivery_at: string | null }>(env.DB, `SELECT last_delivery_at FROM github_installations WHERE installation_id = ?`, id))?.last_delivery_at ?? null;
const attachment = async (hook: string) =>
  (await first<{ installation_id: number | null }>(env.DB, `SELECT installation_id FROM org_repos WHERE id = ?`, hook))?.installation_id ?? null;
const audit = (org = ORG_A) => all<{ actor: string; action: string; target: string; detail: string }>(env.DB,
  `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? ORDER BY id`, org);
const suspendOrg = (org: string) => run(env.DB, `UPDATE orgs SET suspended_at = ?, suspended_by = 'AndresL230' WHERE id = ?`, nowIso(), org);

/** A fake GitHub: the App's mint, and every other read through `fakeGithub`. The JWTs it sees join the leak check. */
function github(o: Parameters<typeof fakeAppGithub>[0] = {}) {
  const reads = fakeGithub({ "/actions/runs/": { jobs: [] } });
  const gh = fakeAppGithub({ fallback: reads.fetchImpl, ...o });
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    try { return await gh.fetchImpl(u, init); } finally {
      const last = gh.calls.at(-1);
      if (last?.url.includes("/access_tokens") && last.auth) jwts.push(last.auth.replace(/^Bearer /, ""));
    }
  }) as typeof fetch;
  return {
    fetchImpl, calls: gh.calls,
    mints: () => gh.calls.filter((c) => c.url.endsWith("/access_tokens")),
    reads: () => gh.calls.filter((c) => c.url.startsWith(`https://api.github.com/repos/${REPO}/`)),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("githubAppWebhookPath", () => {
  it("is exactly /webhook/github-app — never a per-repo hook path", () => {
    expect(githubAppWebhookPath("/webhook/github-app")).toBe(true);
    for (const path of ["/webhook/github-app/", "/webhook/github-app/x", "/webhook/github", "/webhook/github/github-app", "/webhook/github-apps"]) {
      expect(githubAppWebhookPath(path), path).toBe(false);
    }
  });
});

describe("refusals write nothing", () => {
  it("the App NOT configured (the pool's default) → the bare 401, however the delivery is signed", async () => {
    await world();
    const before = await everything();
    for (const secret of [APP.webhookSecret, "test-webhook-secret"]) {
      const res = await deliver("pull_request", pr(), { secret, env: e });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    // One missing secret is an App that cannot work: still unconfigured.
    expect((await deliver("pull_request", pr(), { env: await appEnv(e, { GITHUB_APP_PRIVATE_KEY: "" }) })).status).toBe(401);
    expect(await everything()).toBe(before);
  });

  it("a missing, malformed or wrong signature → the same bare 401 (status, body, headers) and NO rows — not even last_delivery_at", async () => {
    await world();
    await setSecret(await tenantCtx("AndresL230"), "github_webhook", HOOK_A, HOOK_SECRET);
    const before = await everything();
    const refusals: Response[] = [];
    for (const sig of [null, "", "sha256=", "sha256=zz", "sha1=abcdef"]) refusals.push(await deliver("pull_request", pr(), { sig }));
    for (const secret of ["test-webhook-secret", HOOK_SECRET, APP.clientSecret, "not-the-secret"]) {
      for (const [name, payload] of [["pull_request", pr()], ["issues", issue()], ["installation", lifecycle("deleted")]] as const) {
        refusals.push(await deliver(name, payload, { secret }));
      }
    }
    // A signature over a DIFFERENT body than the one sent.
    refusals.push(await deliver("pull_request", pr(), { sig: await sign(APP.webhookSecret, JSON.stringify(pr(REPO, ID + 1))) }));
    const shape = async (res: Response) => JSON.stringify({ status: res.status, headers: [...res.headers].sort(), body: await res.text() });
    for (const res of refusals) {
      expect(await shape(res)).toBe(JSON.stringify({ status: 401, headers: [["content-type", "application/json"]], body: `{"error":"unauthorized"}` }));
    }
    expect(await everything()).toBe(before);
  });

  it("a verified body that is not a JSON object → 400 bad_request, nothing written", async () => {
    await world();
    const before = await everything();
    for (const raw of ["{not json", "", "null", "[1,2]", "42", `"text"`]) {
      const res = await deliver("pull_request", null, { raw });
      expect(res.status, raw).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(await everything()).toBe(before);
  });

  it("no usable installation id (a ping, github_app_authorization, a bad id) → 202 ignored, nothing written", async () => {
    await world();
    const before = await everything();
    const cases: [string, unknown][] = [
      ["ping", { zen: "Keep it logically awesome.", hook_id: 1, hook: { type: "App", app_id: 424242 } }],
      ["github_app_authorization", { action: "revoked", sender: { login: "octo" } }],
      ...[String(ID), -ID, 0, 1.5, 2 ** 60, null].map((id): [string, unknown] => ["pull_request", { ...pr(), installation: { id } }]),
      ["pull_request", { ...pr(), installation: null }],
      ["installation", { ...lifecycle("deleted"), installation: { id: String(ID) } }],
    ];
    for (const [name, payload] of cases) {
      const res = await deliver(name, payload);
      expect(res.status, JSON.stringify(payload).slice(0, 60)).toBe(202);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(await everything()).toBe(before);
  });

  it("an installation nobody bound → 202 ignored and nothing written: capture and lifecycle alike", async () => {
    await world();
    const before = await everything();
    for (const [name, payload] of [
      ["pull_request", pr(REPO, UNBOUND_ID)], ["issues", issue(REPO, 31, UNBOUND_ID)],
      ["installation", lifecycle("created", { repositories: [{ id: 77, full_name: REPO }] }, UNBOUND_ID)], ["installation", lifecycle("deleted", {}, UNBOUND_ID)],
      ["installation_repositories", repoChange("added", [{ id: 77, full_name: REPO }], UNBOUND_ID)],
    ] as const) {
      const res = await deliver(name, payload);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(await everything()).toBe(before);
  });

  it("only POST is a delivery", async () => {
    await world();
    const before = await everything();
    expect((await deliver("pull_request", pr(), { method: "GET" })).status).not.toBe(200);
    expect(await everything()).toBe(before);
  });

  it("an unexpected failure after the signature verified is a 503 — never a 500 — logged without a secret", async () => {
    await world();
    const boom = new Proxy(e.DB, {
      get: (target, prop) => prop === "prepare"
        ? () => { throw new Error(`D1 exploded near ${APP.webhookSecret} and ${APP.clientSecret}`); }
        : Reflect.get(target, prop),
    });
    const res = await deliver("pull_request", pr(), { env: { ...APPENV, DB: boom } as Env });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toBe("github app webhook failed");
    expect(String(logged[0][2])).toContain("[redacted]");
  });
});

describe("isolation: the installation names the org, and only its own attached primary is captured", () => {
  it("installation ID (org A) delivering a repo org B ALSO connected (same name) writes into A only", async () => {
    await world();
    const res = await deliver("pull_request", pr());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await eventOrgs()).toEqual([ORG_A]);
    expect(await all(env.DB, `SELECT org_id FROM repo_events`)).toEqual([{ org_id: ORG_A }]);
    expect((await deliver("issues", issue())).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, source_ref FROM tickets`)).toEqual([{ org_id: ORG_A, source_ref: `${REPO}#31` }]);
  });

  it("anything else is acknowledged and ignored, writing nothing in either org", async () => {
    await world();
    await addOrgRepo("acme/lib", ORG_A, { id: "hook_a_lib", primary: false });
    await attachRepo("hook_a_lib", ID);
    await addOrgRepo("beta-co/web", ORG_B, { id: "hook_b_web", primary: false });
    await attachRepo("hook_b_web", FOREIGN_ID);
    const before = await everything();
    for (const [what, name, payload] of [
      ["org B's repo through A's installation", "pull_request", pr("beta-co/web", ID)],
      ["org B's installation naming the shared name (B's row is token-connected)", "pull_request", pr(REPO, FOREIGN_ID)],
      ["org B's installation, its own attached NON-primary repo", "issues", issue("beta-co/web", 3, FOREIGN_ID)],
      ["A's installation, A's attached NON-primary repo", "pull_request", pr("acme/lib", ID)],
      ["A's other installation naming A's primary (attached to ID, not to it)", "pull_request", pr(REPO, OTHER_ID)],
      ["a repo no org connected", "issues", issue("someone/else", 4, ID)],
      ["no repository at all", "pull_request", { ...pr(), repository: null }],
      ["an event the capture does not read", "star", { action: "created", repository: { full_name: REPO }, ...via(ID) }],
      ["an event the capture does not read", "issue_comment", { action: "created", repository: { full_name: REPO }, ...via(ID) }],
    ] as const) {
      const res = await deliver(name, payload);
      expect(res.status, what).toBe(202);
      expect(await res.json(), what).toEqual({ ok: true, ignored: true });
    }
    expect(await everything()).toBe(before);
  });

  it("org A's primary connected the 0037 way (not attached) is not the App's to deliver", async () => {
    await world({ attached: false });
    const before = await everything();
    expect((await deliver("pull_request", pr())).status).toBe(202);
    expect(await everything()).toBe(before);
  });

  it("org A's primary attached to ANOTHER of its installations is delivered by that one only", async () => {
    await world();
    await attachRepo(HOOK_A, OTHER_ID);
    const before = await everything();
    expect((await deliver("pull_request", pr(REPO, ID))).status).toBe(202);
    expect(await everything()).toBe(before);
    expect((await deliver("pull_request", pr(REPO, OTHER_ID))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]);
    expect(await lastDelivery(OTHER_ID)).not.toBeNull();
    expect(await lastDelivery(ID)).toBeNull();
  });

  it("the repo name is compared without case, as GitHub compares it", async () => {
    await world();
    expect((await deliver("pull_request", pr("Acme/App"))).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]);
  });
});

describe("capture", () => {
  it("an issue becomes an event and a mirrored ticket in org A; a redelivery is unchanged", async () => {
    await world();
    const first1 = await deliver("issues", issue());
    expect(first1.status).toBe(200);
    expect(await first1.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 0, unchanged: 0 } });
    const again = await deliver("issues", issue());
    expect(await again.json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 0 } });
    expect(await all(env.DB, `SELECT org_id, source, source_ref FROM tickets`)).toEqual([{ org_id: ORG_A, source: "github", source_ref: `${REPO}#31` }]);
    expect(await eventOrgs()).toEqual([ORG_A]);
  });

  it("a merged PR is an event and a repo_events row; a redelivery is unchanged in both", async () => {
    await world();
    expect(await (await deliver("pull_request", pr())).json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await (await deliver("pull_request", pr())).json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 1 } });
    expect(await all(env.DB, `SELECT org_id, semantic_key FROM events`)).toEqual([{ org_id: ORG_A, semantic_key: "gh:pr:42:merged" }]);
  });

  it("stamps last_delivery_at, at most once per 10 minutes", async () => {
    await world();
    expect(await lastDelivery()).toBeNull();
    await deliver("issues", issue(REPO, 31));
    const stamped = await lastDelivery();
    expect(stamped).not.toBeNull();
    await deliver("issues", issue(REPO, 32));
    expect(await lastDelivery()).toBe(stamped); // throttled
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await run(env.DB, `UPDATE github_installations SET last_delivery_at = ? WHERE installation_id = ?`, old, ID);
    await deliver("issues", issue(REPO, 33));
    expect((await lastDelivery())! > old).toBe(true);
    expect(await lastDelivery(OTHER_ID)).toBeNull();
  });

  it("a delivery that needs no follow-up read mints nothing", async () => {
    await world();
    const gh = github();
    expect((await deliverDirect("issues", issue(), gh.fetchImpl)).status).toBe(200);
    expect((await deliverDirect("pull_request", pr(), gh.fetchImpl)).status).toBe(200);
    expect(gh.calls).toEqual([]);
  });

  it("a failed workflow_run's job lookup reads with an INSTALLATION token for THIS repo, minted once", async () => {
    await world();
    await setOrgEnvironments(ENVS, ORG_A);
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", PASTED);
    const gh = github();
    const res = await deliverDirect("workflow_run", { ...workflowRun, repository: { full_name: REPO }, ...via(ID) }, gh.fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: { captured: 1, unchanged: 0 } });
    expect(gh.mints()).toHaveLength(1);
    expect(gh.mints()[0].url).toBe(`https://api.github.com/app/installations/${ID}/access_tokens`);
    expect(JSON.parse(gh.mints()[0].body)).toMatchObject({ repositories: ["app"] });
    expect(gh.reads().map((c) => c.url)).toEqual([expect.stringContaining(`/repos/${REPO}/actions/runs/${workflowRun.workflow_run.id}/jobs`)]);
    for (const c of gh.reads()) expect(c.auth).toBe(`Bearer ${INST}`);
    // The pasted token was not the one used, so its row is untouched.
    expect((await first<{ last_used_at: string | null }>(env.DB, `SELECT last_used_at FROM org_secrets WHERE org_id = ? AND kind = 'github_token'`, ORG_A))?.last_used_at).toBeNull();
  });

  it("a push to an environment branch refreshes drift with the installation token — one mint for the delivery", async () => {
    await world();
    await setOrgEnvironments(ENVS, ORG_A);
    const gh = github();
    const res = await deliverDirect("push", { ...pushFixture, repository: { ...pushFixture.repository, full_name: REPO }, ...via(ID) }, gh.fetchImpl);
    expect(res.status).toBe(200);
    expect(gh.mints()).toHaveLength(1);
    expect(gh.reads().length).toBeGreaterThan(0);
    expect(gh.reads().some((c) => c.url.includes("/compare/"))).toBe(true);
    for (const c of gh.reads()) expect(c.auth).toBe(`Bearer ${INST}`);
  });

  it("a mint GitHub refuses (echoing the request) falls back to the pasted token, which is then marked used", async () => {
    await world();
    await setOrgEnvironments(ENVS, ORG_A);
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", PASTED);
    const gh = github({ mint: 401 });
    const res = await deliverDirect("workflow_run", { ...workflowRun, repository: { full_name: REPO }, ...via(ID) }, gh.fetchImpl);
    expect(res.status).toBe(200);
    expect(gh.mints()).toHaveLength(1);
    expect(gh.reads()).toHaveLength(1);
    expect(gh.reads()[0].auth).toBe(`Bearer ${PASTED}`);
    expect((await first<{ last_used_at: string | null }>(env.DB, `SELECT last_used_at FROM org_secrets WHERE org_id = ? AND kind = 'github_token'`, ORG_A))?.last_used_at).not.toBeNull();
  });

  it("a SUSPENDED installation's capture is ignored; unsuspended, it is captured again", async () => {
    await world();
    const suspend = await deliver("installation", lifecycle("suspend", { suspended_at: "2026-10-06T12:00:00Z" }));
    expect(suspend.status).toBe(200);
    expect(await suspend.json()).toEqual({ ok: true });
    const before = await everything();
    expect((await deliver("issues", issue())).status).toBe(202);
    expect((await deliver("pull_request", pr())).status).toBe(202);
    expect(await everything()).toBe(before);
    expect((await deliver("installation", lifecycle("unsuspend"))).status).toBe(200);
    expect((await deliver("pull_request", pr())).status).toBe(200);
    expect(await eventOrgs()).toEqual([ORG_A]);
  });

  it("the legacy per-repo hook and the App delivering the SAME event: the second copy is unchanged — one row each", async () => {
    await world();
    await setSecret(await tenantCtx("AndresL230"), "github_webhook", HOOK_A, HOOK_SECRET);
    const legacy = async (name: string, payload: unknown) => {
      const body = JSON.stringify(payload);
      const res = await worker.fetch(new Request(`https://trov.test/webhook/github/${HOOK_A}`, {
        method: "POST", body, headers: { "x-github-event": name, "x-hub-signature-256": await sign(HOOK_SECRET, body) },
      }), APPENV, execCtx);
      bodies.push(await res.clone().text());
      return res;
    };
    expect(await (await legacy("pull_request", pr())).json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await (await deliver("pull_request", pr())).json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 1 } });
    // …and the other way round, for an issue and its mirrored ticket.
    expect(await (await deliver("issues", issue())).json()).toMatchObject({ captured: 1 });
    expect(await (await legacy("issues", issue())).json()).toMatchObject({ captured: 0, unchanged: 1 });
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM events`))!.n).toBe(2);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM repo_events`))!.n).toBe(1);
    expect(await all(env.DB, `SELECT org_id, source_ref FROM tickets`)).toEqual([{ org_id: ORG_A, source_ref: `${REPO}#31` }]);
  });
});

describe("lifecycle", () => {
  it("installation.deleted: the binding is gone, its repos detached, audited as github-webhook; a redelivery is ignored", async () => {
    await world();
    const res = await deliver("installation", lifecycle("deleted"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await all(env.DB, `SELECT installation_id FROM github_installations WHERE installation_id = ?`, ID)).toEqual([]);
    expect(await all(env.DB, `SELECT repo_id FROM github_installation_repos WHERE installation_id = ?`, ID)).toEqual([]);
    expect(await attachment(HOOK_A)).toBeNull();
    expect((await audit()).map((a) => [a.actor, a.action, a.target])).toEqual([
      ["github-webhook", "repo.detach", REPO], ["github-webhook", "github.uninstall", "acme"],
    ]);
    // Org B's installation and rows are untouched.
    expect(await all(env.DB, `SELECT installation_id FROM github_installations WHERE org_id = ?`, ORG_B)).toEqual([{ installation_id: FOREIGN_ID }]);
    const after = await everything();
    expect((await deliver("installation", lifecycle("deleted"))).status).toBe(202);
    // …and its capture is now ignored.
    expect((await deliver("pull_request", pr())).status).toBe(202);
    expect(await everything()).toBe(after);
  });

  it("suspend stores GitHub's time, unsuspend clears it; each audited once, a redelivery writes nothing", async () => {
    await world();
    expect((await deliver("installation", lifecycle("suspend", { suspended_at: "2026-10-06T12:00:00Z" }))).status).toBe(200);
    expect(await first(env.DB, `SELECT suspended_at FROM github_installations WHERE installation_id = ?`, ID)).toEqual({ suspended_at: "2026-10-06T12:00:00.000Z" });
    const once = await everything();
    expect((await deliver("installation", lifecycle("suspend", { suspended_at: "2026-10-06T12:00:00Z" }))).status).toBe(200);
    expect(await everything()).toBe(once);
    expect((await deliver("installation", lifecycle("unsuspend"))).status).toBe(200);
    expect(await first(env.DB, `SELECT suspended_at FROM github_installations WHERE installation_id = ?`, ID)).toEqual({ suspended_at: null });
    expect((await audit()).map((a) => [a.actor, a.action])).toEqual([["github-webhook", "github.suspend"], ["github-webhook", "github.unsuspend"]]);
    // A suspend with no time of its own is stamped now.
    expect((await deliver("installation", lifecycle("suspend", { suspended_at: undefined }))).status).toBe(200);
    expect((await first<{ suspended_at: string | null }>(env.DB, `SELECT suspended_at FROM github_installations WHERE installation_id = ?`, ID))?.suspended_at).not.toBeNull();
  });

  it("installation_repositories added attaches a matching unattached repo; removed detaches — counts audited", async () => {
    await world();
    await addOrgRepo("acme/new", ORG_A, { id: "hook_a_new", primary: false });
    await addOrgRepo("acme/new", ORG_B, { id: "hook_b_new", primary: false }); // the same name in org B is never touched
    const added = await deliver("installation_repositories", repoChange("added", [{ id: 79, full_name: "acme/new" }]));
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ ok: true });
    expect(await all(env.DB, `SELECT repo_id, repo_full_name, private FROM github_installation_repos WHERE installation_id = ? ORDER BY repo_id`, ID)).toEqual([
      { repo_id: 77, repo_full_name: REPO, private: 0 }, { repo_id: 78, repo_full_name: "acme/lib", private: 0 }, { repo_id: 79, repo_full_name: "acme/new", private: 1 },
    ]);
    expect(await attachment("hook_a_new")).toBe(ID);
    expect(await attachment("hook_b_new")).toBeNull();
    const removed = await deliver("installation_repositories", repoChange("removed", [{ id: 77, full_name: REPO }]));
    expect(removed.status).toBe(200);
    expect(await attachment(HOOK_A)).toBeNull();
    expect((await audit()).map((a) => [a.actor, a.action, a.target, JSON.parse(a.detail)])).toEqual([
      ["github-webhook", "repo.attach", "acme/new", { installation_id: ID }],
      ["github-webhook", "github.repos", "acme", { installation_id: ID, added: 1, removed: 0 }],
      ["github-webhook", "repo.detach", REPO, { installation_id: ID }],
      ["github-webhook", "github.repos", "acme", { installation_id: ID, added: 0, removed: 1 }],
    ]);
    expect(await audit(ORG_B)).toEqual([]);
    // Detached, REPO's events are no longer this installation's to deliver.
    expect((await deliver("pull_request", pr())).status).toBe(202);
    // An action we do not handle is ignored.
    expect((await deliver("installation_repositories", { ...repoChange("added", []), action: "renamed" })).status).toBe(202);
  });

  it("created / new_permissions_accepted: a SELECTED list replaces; an ALL list only adds; no list writes nothing", async () => {
    await world();
    await addOrgRepo("acme/lib", ORG_A, { id: "hook_a_lib", primary: false });
    await attachRepo("hook_a_lib", ID);
    const repoIds = async () => (await all<{ repo_id: number }>(env.DB, `SELECT repo_id FROM github_installation_repos WHERE installation_id = ? ORDER BY repo_id`, ID)).map((r) => r.repo_id);

    const none = await everything();
    expect((await deliver("installation", lifecycle("new_permissions_accepted"))).status).toBe(200);
    expect(await everything()).toBe(none);

    // `all`: acme/lib is missing from the (maybe truncated) list — it is NOT detached; acme/x is added.
    expect((await deliver("installation", lifecycle("new_permissions_accepted", {
      repository_selection: "all", repositories: [{ id: 77, full_name: REPO }, { id: 80, full_name: "acme/x" }],
    }))).status).toBe(200);
    expect(await repoIds()).toEqual([77, 78, 80]);
    expect(await attachment("hook_a_lib")).toBe(ID);
    expect(await first(env.DB, `SELECT repository_selection, repos_synced_at FROM github_installations WHERE installation_id = ?`, ID))
      .toEqual({ repository_selection: "all", repos_synced_at: null });

    // `selected`: the list IS the selection — acme/lib and acme/x leave, acme/lib's row is detached.
    expect((await deliver("installation", lifecycle("created", { repositories: [{ id: 77, full_name: REPO }] }))).status).toBe(200);
    expect(await repoIds()).toEqual([77]);
    expect(await attachment("hook_a_lib")).toBeNull();
    expect(await attachment(HOOK_A)).toBe(ID);
    expect(await first(env.DB, `SELECT repository_selection FROM github_installations WHERE installation_id = ?`, ID)).toEqual({ repository_selection: "selected" });
    expect((await first<{ repos_synced_at: string | null }>(env.DB, `SELECT repos_synced_at FROM github_installations WHERE installation_id = ?`, ID))?.repos_synced_at).not.toBeNull();
    expect((await audit()).every((a) => a.actor === "github-webhook")).toBe(true);
  });

  it("an installation action we do not handle is ignored", async () => {
    await world();
    const before = await everything();
    expect((await deliver("installation", lifecycle("unknown_action"))).status).toBe(202);
    expect(await everything()).toBe(before);
  });

  it("a SUSPENDED org: lifecycle still applies (the binding stays true to GitHub), capture does not", async () => {
    await world();
    await addOrgRepo("acme/new", ORG_A, { id: "hook_a_new", primary: false });
    await suspendOrg(ORG_A);
    const before = await everything();
    for (const [name, payload] of [["pull_request", pr()], ["issues", issue()], ["push", { ...pushFixture, repository: { full_name: REPO }, ...via(ID) }]] as const) {
      const res = await deliver(name, payload);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(await everything()).toBe(before); // not an event, not a ticket, not last_delivery_at
    expect((await deliver("installation_repositories", repoChange("added", [{ id: 79, full_name: "acme/new" }]))).status).toBe(200);
    expect(await attachment("hook_a_new")).toBe(ID);
    expect((await deliver("installation", lifecycle("suspend", { suspended_at: "2026-10-06T12:00:00Z" }))).status).toBe(200);
    expect((await deliver("installation", lifecycle("deleted"))).status).toBe(200);
    expect(await all(env.DB, `SELECT installation_id FROM github_installations WHERE org_id = ?`, ORG_A)).toEqual([{ installation_id: OTHER_ID }]);
    expect(await attachment(HOOK_A)).toBeNull();
    expect((await audit()).map((a) => a.action)).toEqual(["repo.attach", "github.repos", "github.suspend", "repo.detach", "repo.detach", "github.uninstall"]);
  });
});
