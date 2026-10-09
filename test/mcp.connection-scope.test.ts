/**
 * How an MCP connection chooses among its person's organizations (0051; docs/architecture/data-layer.md
 * § Bearer). Everything here goes through the REAL surfaces: the consent page and its POST, the token
 * endpoint, `POST /mcp` on the Worker, and the Settings routes — so what is under test is the rule
 * itself (src/data/bearer.ts), not a re-implementation of it.
 *
 * The cast: `dana` — admin of SaplingLearn (A), member of Acme (B) and of a third org (C); `bob` — B only;
 * `meilin` — A only. Repositories: `team/app` in A, `dana/side` in B, `shared/both` in A and B,
 * `third/thing` in C.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import { pkce, sha256Hex } from "../src/auth/crypto";
import { registerClient } from "../src/auth/oauth";
import { removeMember } from "../src/orgs/repo";
import { limitUse } from "../src/plans/gate";
import { normalizeRepoRef, normalizeOrgSlug } from "@shared/repo-ref";
import { consentPage, defaultConsentChoice } from "../src/auth/oauth-pages";
import { cookieFor, seedPerson } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";
import { ORG_A, ORG_B, ensureMember, mintTokenFor, platformCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const ORG_C = "org_c";
const REDIRECT = "http://localhost:4444/callback";

const one = <T>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).first<T>();
const rows = async <T>(sql: string, ...p: unknown[]) => (await env.DB.prepare(sql).bind(...p).all<T>()).results;
const n = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;

beforeEach(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by) VALUES (?, 'third', 'Third', '2026-10-06T00:00:00.000Z', 'seed')`).bind(ORG_C).run();
  await seedPerson("dana", { member: false });
  await seedPerson("bob", { member: false });
  await ensureMember("dana", "admin", ORG_A);
  await ensureMember("dana", "member", ORG_B);
  await ensureMember("dana", "member", ORG_C);
  await ensureMember("bob", "member", ORG_B);
  await addOrgRepo("team/app", ORG_A);
  await addOrgRepo("dana/side", ORG_B);
  await addOrgRepo("shared/both", ORG_A, { primary: false });
  await addOrgRepo("shared/both", ORG_B, { primary: false });
  await addOrgRepo("third/thing", ORG_C);
});

// ── the real flow: consent → code → token ────────────────────────────────────

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

async function registered() {
  const c = await registerClient(platformCtx(), { client_name: "Claude Code", redirect_uris: [REDIRECT] }, Date.now());
  const { verifier, challenge } = await pkce();
  const qs = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1" });
  return { c, verifier, qs };
}
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const consentGet = (qs: URLSearchParams, cookie: string) => app.request(`/oauth/authorize?${qs}`, { headers: { cookie } }, env);
/** POST the consent form with `fields` (a key may repeat: `[["org","acme"],["org","saplinglearn"]]`). */
async function consentPost(qs: URLSearchParams, cookie: string, fields: [string, string][]): Promise<Response> {
  const body = new URLSearchParams(qs);
  body.set("csrf", csrfOf(await (await consentGet(qs, cookie)).text()));
  body.set("decision", "allow");
  for (const [k, v] of fields) body.append(k, v);
  return app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, env);
}

interface Pair { access_token: string; refresh_token: string; client_id: string; grantId: number }
/** A whole connection as `handle`, with the consent form's `fields`: the token pair a client ends up holding. */
async function connect(handle: string, fields: [string, string][]): Promise<Pair> {
  const { c, verifier, qs } = await registered();
  const r = await consentPost(qs, await cookieFor(handle, { member: false }), fields);
  expect(r.status, await r.clone().text()).toBe(302);
  const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
  const t = await app.request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }), env);
  expect(t.status).toBe(200);
  const grantId = (await one<{ id: number }>(`SELECT MAX(id) AS id FROM oauth_grants WHERE person = ?`, handle))!.id;
  return { ...((await t.json()) as { access_token: string; refresh_token: string }), client_id: c.client_id, grantId };
}
const followRepo = (handle: string) => connect(handle, [["mode", "repo"]]);
const manual = (handle: string, orgs: string[], current: string) => connect(handle, [["mode", "manual"], ...orgs.map((o): [string, string] => ["org", o]), ["current", current]]);
const refresh = (p: Pair) => app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: p.refresh_token, client_id: p.client_id }), env);

// ── driving /mcp over HTTP, as a client does ─────────────────────────────────

interface Rpc { status: number; raw: string; isError: boolean; json: Record<string, unknown> | null; text: string }
async function rpc(token: string, method: string, params: unknown): Promise<{ status: number; raw: string; result: Record<string, unknown> | null }> {
  const exec = createExecutionContext();
  const res = await worker.fetch(new Request("https://trov.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }) as Parameters<typeof worker.fetch>[0], e, exec);
  const raw = await res.text();
  await waitOnExecutionContext(exec);
  const data = raw.split("\n").find((l) => l.startsWith("data: "));
  const body = data ? (JSON.parse(data.slice(6)) as { result?: Record<string, unknown> }) : null;
  return { status: res.status, raw, result: body?.result ?? null };
}
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const content = (r.result?.content as { text: string }[] | undefined) ?? [];
  const text = content.map((c) => c.text).join("\n");
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON result */ }
  return { status: r.status, raw: r.raw, isError: r.result?.isError === true, json, text };
}
const whereAmI = async (token: string, args: Record<string, unknown> = {}) => (await call(token, "get_connection", args)).json as {
  handle: string; mode: string; organization: { slug: string; name: string } | null; role: string | null; current: string | null;
  organizations: { slug: string; name: string; role: string }[]; unresolved?: { code: string; message: string };
};
/** How many rows of the tables an agent can write — a refusal must leave it unchanged. */
const written = () => n(`SELECT (SELECT COUNT(*) FROM feed) + (SELECT COUNT(*) FROM tickets) + (SELECT COUNT(*) FROM docs) + (SELECT COUNT(*) FROM handoffs) + (SELECT COUNT(*) FROM needs_triage) AS n`);

// ── the repository reference ─────────────────────────────────────────────────

describe("normalizeRepoRef — one spelling for a repository however git prints it", () => {
  it("reads owner/name out of the plain, https, ssh and scp-like forms", () => {
    for (const form of [
      "team/app", " team/app ", "team/app.git", "team/app/", "https://github.com/team/app", "https://github.com/team/app.git",
      "http://www.github.com/team/app/", "git@github.com:team/app.git", "ssh://git@github.com/team/app.git", "ssh://git@github.com:22/team/app",
      "git://github.com/team/app.git", "https://x-access-token@github.com/team/app.git",
    ]) expect(normalizeRepoRef(form), form).toBe("team/app");
    expect(normalizeRepoRef("Team/App")).toBe("Team/App"); // the lookup, not the spelling, ignores case
  });

  it("refuses anything that is not a GitHub owner/name", () => {
    for (const bad of [
      "", "app", "team/", "/app", "team/app/extra", "https://gitlab.com/team/app", "git@bitbucket.org:team/app.git", "https://github.com/team",
      "team/a b", "te am/app", "-team/app", "team/..", "team/.", "team/app?x=1", "team/app#frag", "a".repeat(40) + "/app", `team/${"a".repeat(101)}`,
      "team/app' OR 1=1 --", null, undefined, 7, {}, ["team/app"],
    ]) expect(normalizeRepoRef(bad), String(bad)).toBeNull();
  });

  it("an org slug is the slug's shape or nothing", () => {
    expect(normalizeOrgSlug(" Acme ")).toBe("acme");
    for (const bad of ["", "a", "-acme", "acme!", "a/b", "x".repeat(40), null, 3]) expect(normalizeOrgSlug(bad), String(bad)).toBeNull();
  });
});

// ── a connection made the old way: nothing widened ───────────────────────────

describe("a grant made before 0051 (one organization) is unchanged", () => {
  it("it is a manual connection allowed exactly its one org: it answers from there, and from nowhere else", async () => {
    // The old consent form: a single `org`, no `mode`.
    const p = await connect("dana", [["org", "acme"]]);
    expect(await one(`SELECT mode, org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ mode: "manual", org_id: ORG_B });
    expect(await rows(`SELECT org_id, person FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toEqual([{ org_id: ORG_B, person: "dana" }]);

    expect(await whereAmI(p.access_token)).toMatchObject({
      handle: "dana", mode: "manual", organization: { slug: "acme", name: "Acme" }, role: "member", current: "acme",
      organizations: [{ slug: "acme", name: "Acme", role: "member" }],
    });
    // `repo` means nothing to it — even one that is connected in ANOTHER of dana's orgs.
    expect((await whereAmI(p.access_token, { repo: "team/app" })).organization).toEqual({ slug: "acme", name: "Acme" });
    const feed = await call(p.access_token, "append_feed", { summary: "written from an old connection", tags: ["api"], repo: "team/app" });
    expect(feed.isError).toBe(false);
    expect(await rows(`SELECT org_id, author FROM feed`)).toEqual([{ org_id: ORG_B, author: "dana" }]);

    // It cannot be pointed at an org it was never allowed — one dana IS a member of, one she is not, one that does not exist: all alike.
    const before = await written();
    const answers = [];
    for (const org of ["saplinglearn", "third", "nowhere"]) {
      const r = await call(p.access_token, "list_tickets", { org });
      expect(r.isError).toBe(true);
      expect(r.json).toMatchObject({ code: "org_not_allowed", orgs: ["acme"] });
      answers.push(r.text.replaceAll(org, "X"));
    }
    expect(new Set(answers).size).toBe(1);
    expect((await call(p.access_token, "switch_org", { org: "saplinglearn" })).json).toMatchObject({ code: "org_not_allowed" });
    expect(await one(`SELECT org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ org_id: ORG_B });
    expect(await written()).toBe(before);

    // …and when she leaves that org it stops at once, as it always did: 401, and the grant is revoked.
    await removeMember(platformCtx("dana"), await tenantCtx("dana", undefined, { orgId: ORG_B }), "dana");
    expect((await rpc(p.access_token, "tools/list", {})).status).toBe(401);
    expect(await one(`SELECT revoked_reason FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ revoked_reason: "member_removed" });
    expect((await refresh(p)).status).toBe(400);
  });

  it("a pasted token is bound to its one org for good: no `org`, no switch", async () => {
    const { raw } = await mintTokenFor("dana", ORG_B);
    expect(await whereAmI(raw)).toMatchObject({ mode: "manual", organization: { slug: "acme" }, current: "acme", organizations: [{ slug: "acme" }] });
    expect((await call(raw, "list_tickets", { org: "saplinglearn" })).json).toMatchObject({ code: "org_not_allowed" });
    expect((await call(raw, "switch_org", { org: "saplinglearn" })).json).toMatchObject({ code: "org_not_allowed" });
    expect((await call(raw, "list_tickets", { org: "acme", repo: "team/app" })).isError).toBe(false); // its own org, named: fine
  });
});

// ── follow the repository ────────────────────────────────────────────────────

describe("a connection that follows the repository", () => {
  it("is the person's and no organization's: no org on the grant, no slot taken until it is used", async () => {
    const p = await followRepo("dana");
    expect(await one(`SELECT mode, org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ mode: "repo", org_id: "" });
    expect(await rows(`SELECT org_id FROM oauth_codes WHERE grant_id = ?`, p.grantId)).toEqual([{ org_id: "" }]);
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toBe(0);
  });

  it("resolves each call to the org that has the repository connected, with the role held THERE", async () => {
    const p = await followRepo("dana");
    expect(await whereAmI(p.access_token, { repo: "team/app" })).toMatchObject({
      mode: "repo", organization: { slug: "saplinglearn", name: "SaplingLearn" }, role: "admin", current: null,
      organizations: [{ slug: "acme", role: "member" }, { slug: "saplinglearn", role: "admin" }, { slug: "third", role: "member" }],
    });
    expect(await whereAmI(p.access_token, { repo: "dana/side" })).toMatchObject({ organization: { slug: "acme" }, role: "member" });
    // However git spells it, and whatever its case.
    for (const repo of ["git@github.com:Team/App.git", "https://github.com/TEAM/app", "TEAM/APP"]) {
      expect((await whereAmI(p.access_token, { repo })).organization, repo).toEqual({ slug: "saplinglearn", name: "SaplingLearn" });
    }
    // The admin tool follows the role of the org the call lands in.
    const plan = { narrative: "Now: ship. Next: rest.", sprints: [] };
    expect((await call(p.access_token, "update_plan", { ...plan, repo: "team/app" })).isError).toBe(false);
    const refused = await call(p.access_token, "update_plan", { ...plan, repo: "dana/side" });
    expect(refused.json).toMatchObject({ code: "forbidden" });
    expect(await rows(`SELECT org_id FROM plan`)).toEqual([{ org_id: ORG_A }]);
  });

  it("writes are recorded as the token's person, in the org the call resolved to — and links carry that org's slug", async () => {
    const p = await followRepo("dana");
    expect((await call(p.access_token, "append_feed", { summary: "side work", tags: ["api"], repo: "dana/side" })).isError).toBe(false);
    expect((await call(p.access_token, "append_feed", { summary: "team work", tags: ["api"], repo: "team/app", author: "bob" })).isError).toBe(false);
    expect(await rows(`SELECT org_id, author, summary FROM feed ORDER BY summary`)).toEqual([
      { org_id: ORG_B, author: "dana", summary: "side work" }, { org_id: ORG_A, author: "dana", summary: "team work" },
    ]);
    const t = await call(p.access_token, "create_ticket", { title: "filed from the side repo", repo: "dana/side", requester: "bob" });
    expect(t.json).toMatchObject({ requester: "dana" });
    expect(await rows(`SELECT org_id, requester FROM tickets`)).toEqual([{ org_id: ORG_B, requester: "dana" }]);
    const h = await call(p.access_token, "send_handoff", { body: "pick this up", repo: "team/app" });
    expect(String(h.json?.url)).toContain("/saplinglearn/#handoffs/");
  });

  it("ticket writes are still lane-scoped in the resolved org: unknown is not_found, someone else's is forbidden", async () => {
    const bobs = await mintTokenFor("bob", ORG_B);
    const theirs = (await call(bobs.raw, "create_ticket", { title: "bob's ticket", assignees: ["bob"] })).json as { id: number };
    const p = await followRepo("dana");
    expect((await call(p.access_token, "transition_ticket", { id: 9999, to: "done", repo: "dana/side" })).json).toMatchObject({ code: "not_found" });
    expect((await call(p.access_token, "transition_ticket", { id: theirs.id, to: "done", repo: "dana/side" })).json).toMatchObject({ code: "forbidden" });
    expect((await call(p.access_token, "edit_ticket", { id: theirs.id, title: "mine now", repo: "dana/side" })).json).toMatchObject({ code: "forbidden" });
    // The same id in ANOTHER org is simply not there.
    expect((await call(p.access_token, "get_ticket", { id: theirs.id, repo: "team/app" })).isError).toBe(true);
    expect(await one(`SELECT title, status FROM tickets WHERE org_id = ?`, ORG_B)).toEqual({ title: "bob's ticket", status: "submitted" });
  });

  it("no `repo`, or one that is not a repository: refused with the instruction, nothing read or written", async () => {
    const p = await followRepo("dana");
    const before = await written();
    const none = await call(p.access_token, "list_tickets", {});
    expect(none.isError).toBe(true);
    expect(none.json).toMatchObject({ code: "repo_required" });
    expect(none.text).toContain("git remote get-url origin");
    for (const repo of ["not a repo", "https://gitlab.com/team/app", "team"]) {
      expect((await call(p.access_token, "append_feed", { summary: "x", repo })).json, repo).toMatchObject({ code: "bad_request" });
    }
    expect((await call(p.access_token, "append_feed", { summary: "x" })).json).toMatchObject({ code: "repo_required" });
    expect((await call(p.access_token, "switch_org", { org: "acme" })).json).toMatchObject({ code: "bad_request" });
    expect(await written()).toBe(before);
    // It says where it could work, and that this call would do nothing.
    const me = await whereAmI(p.access_token);
    expect(me.organization).toBeNull();
    expect(me.unresolved?.code).toBe("repo_required");
    expect(me.organizations.map((o) => o.slug)).toEqual(["acme", "saplinglearn", "third"]);
  });

  it("a repository connected only in an org the person is NOT in is byte-identical to one connected nowhere", async () => {
    // meilin is in A only; `dana/side` is connected in B.
    const p = await followRepo("meilin");
    const before = await written();
    const elsewhere = await call(p.access_token, "list_tickets", { repo: "dana/side" });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.json).toMatchObject({ code: "not_connected" });
    expect(elsewhere.text).toContain("dana/side");
    expect(elsewhere.text).toContain("Org settings › Repositories");
    expect(elsewhere.text).not.toMatch(/acme/i);
    const me = await call(p.access_token, "get_connection", { repo: "dana/side" });
    // Now it is connected NOWHERE: the same request gets the same bytes.
    await env.DB.prepare(`DELETE FROM org_repos WHERE repo_full_name = 'dana/side'`).run();
    expect((await call(p.access_token, "list_tickets", { repo: "dana/side" })).raw).toBe(elsewhere.raw);
    expect((await call(p.access_token, "get_connection", { repo: "dana/side" })).raw).toBe(me.raw);
    // …and naming the org she is not in changes nothing about that either.
    await addOrgRepo("dana/side", ORG_B);
    const named = await call(p.access_token, "list_tickets", { repo: "dana/side", org: "acme" });
    await env.DB.prepare(`DELETE FROM org_repos WHERE repo_full_name = 'dana/side'`).run();
    expect((await call(p.access_token, "list_tickets", { repo: "dana/side", org: "acme" })).raw).toBe(named.raw);
    expect(named.json).toMatchObject({ code: "not_connected" });
    expect(await written()).toBe(before);
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs`)).toBe(0); // nothing was admitted anywhere
  });

  it("a repository the org's GitHub App has lost sight of no longer resolves", async () => {
    const p = await followRepo("dana");
    await env.DB.prepare(`UPDATE org_repos SET access_lost_at = '2026-10-07T00:00:00Z' WHERE org_id = ? AND repo_full_name = 'dana/side'`).bind(ORG_B).run();
    expect((await call(p.access_token, "list_tickets", { repo: "dana/side" })).json).toMatchObject({ code: "not_connected" });
  });

  it("a removed membership or a suspended org stops resolving at once — and with no org left it is a 401", async () => {
    const p = await followRepo("dana");
    expect((await call(p.access_token, "list_tickets", { repo: "dana/side" })).isError).toBe(false);
    const unknown = await call(p.access_token, "list_tickets", { repo: "nobody/nothing" });

    await removeMember(platformCtx("dana"), await tenantCtx("dana", undefined, { orgId: ORG_B }), "dana");
    const gone = await call(p.access_token, "list_tickets", { repo: "dana/side" });
    expect(gone.json).toMatchObject({ code: "not_connected" });
    expect(gone.text.replaceAll("dana/side", "R")).toBe(unknown.text.replaceAll("nobody/nothing", "R"));
    // The connection itself lives on (it is not that org's), and still works where she is a member.
    expect(await one(`SELECT revoked_at FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ revoked_at: null });
    expect((await call(p.access_token, "list_tickets", { repo: "team/app" })).isError).toBe(false);

    await env.DB.prepare(`UPDATE orgs SET suspended_at = '2026-10-07T00:00:00Z' WHERE id = ?`).bind(ORG_A).run();
    expect((await call(p.access_token, "list_tickets", { repo: "team/app" })).json).toMatchObject({ code: "not_connected" });
    expect((await whereAmI(p.access_token)).organizations.map((o) => o.slug)).toEqual(["third"]);
    await env.DB.prepare(`UPDATE orgs SET suspended_at = NULL WHERE id = ?`).bind(ORG_A).run();
    expect((await call(p.access_token, "list_tickets", { repo: "team/app" })).isError).toBe(false);

    // A role change shows on the very next call.
    await env.DB.prepare(`UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = 'dana'`).bind(ORG_A).run();
    expect((await whereAmI(p.access_token, { repo: "team/app" })).role).toBe("member");

    // No organization left at all: nowhere to act → 401, and a refresh revokes the grant.
    await env.DB.prepare(`DELETE FROM memberships WHERE user_id = 'dana'`).run();
    expect((await rpc(p.access_token, "tools/list", {})).status).toBe(401);
    expect((await refresh(p)).status).toBe(400);
    expect(await one(`SELECT revoked_reason FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ revoked_reason: "member_removed" });
  });

  it("a repository connected in several of the person's orgs is ambiguous until `org` names one of them", async () => {
    const p = await followRepo("dana");
    const before = await written();
    const both = await call(p.access_token, "append_feed", { summary: "x", tags: ["api"], repo: "shared/both" });
    expect(both.isError).toBe(true);
    expect(both.json).toMatchObject({ code: "ambiguous_org", orgs: ["acme", "saplinglearn"] });
    expect(await written()).toBe(before);
    expect((await whereAmI(p.access_token, { repo: "shared/both" })).unresolved?.code).toBe("ambiguous_org");

    expect((await whereAmI(p.access_token, { repo: "shared/both", org: "acme" })).organization?.slug).toBe("acme");
    expect((await call(p.access_token, "append_feed", { summary: "in acme", tags: ["api"], repo: "shared/both", org: "acme" })).isError).toBe(false);
    expect((await call(p.access_token, "append_feed", { summary: "in sapling", tags: ["api"], repo: "shared/both", org: "SaplingLearn" })).isError).toBe(false);
    expect(await rows(`SELECT org_id FROM feed ORDER BY summary`)).toEqual([{ org_id: ORG_B }, { org_id: ORG_A }]);

    // `org` only chooses among the orgs that HAVE the repository: one of hers without it, and one that
    // does not exist, are the same miss — and it never widens an unambiguous repository either.
    const third = await call(p.access_token, "list_tickets", { repo: "shared/both", org: "third" });
    const nowhere = await call(p.access_token, "list_tickets", { repo: "shared/both", org: "nowhere" });
    expect(third.json).toMatchObject({ code: "not_connected" });
    expect(third.text.replaceAll("third", "X")).toBe(nowhere.text.replaceAll("nowhere", "X"));
    expect((await call(p.access_token, "list_tickets", { repo: "team/app", org: "acme" })).json).toMatchObject({ code: "not_connected" });
    expect((await call(p.access_token, "list_tickets", { repo: "team/app", org: "not a slug!" })).json).toMatchObject({ code: "bad_request" });
    // Someone in only one of the two is never told about the other.
    const bob = await followRepo("bob");
    const r = await call(bob.access_token, "list_tickets", { repo: "shared/both" });
    expect(r.isError).toBe(false);
    expect((await whereAmI(bob.access_token, { repo: "shared/both" })).organizations).toEqual([{ slug: "acme", name: "Acme", role: "member" }]);
  });

  it("the plan's agent-connection limit: it takes a slot in an org the first time it is used there, and is refused there at the cap", async () => {
    await env.DB.prepare(`UPDATE orgs SET plan_overrides = '{"agent_connections":1}' WHERE id = ?`).bind(ORG_B).run();
    const danaB = await tenantCtx("dana", undefined, { orgId: ORG_B });
    const danaA = await tenantCtx("dana", undefined, { orgId: ORG_A });
    const p = await followRepo("dana");
    expect([await limitUse(danaA, "agent_connections"), await limitUse(danaB, "agent_connections")]).toEqual([0, 0]); // made, not yet used: no slot anywhere
    await whereAmI(p.access_token, { repo: "dana/side" });
    expect(await limitUse(danaB, "agent_connections")).toBe(0); // asking where it is admits nothing

    // Its first call into B takes B's one slot; calls after that take nothing more.
    expect((await call(p.access_token, "list_tickets", { repo: "dana/side" })).isError).toBe(false);
    expect((await call(p.access_token, "list_tickets", { repo: "dana/side" })).isError).toBe(false);
    expect([await limitUse(danaA, "agent_connections"), await limitUse(danaB, "agent_connections")]).toEqual([0, 1]);
    expect(await rows(`SELECT org_id, person FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toEqual([{ org_id: ORG_B, person: "dana" }]);

    // A SECOND follow connection cannot be used in B while the first holds the slot — it is not a way around the cap…
    const q = await followRepo("dana");
    const before = await written();
    const full = await call(q.access_token, "append_feed", { summary: "over the cap", tags: ["api"], repo: "dana/side" });
    expect(full.isError).toBe(true);
    expect(full.json).toMatchObject({ code: "plan_limit" });
    expect(await written()).toBe(before);
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs WHERE grant_id = ?`, q.grantId)).toBe(0);
    // …but it works in A, where it takes a slot of A's — and only there.
    expect((await call(q.access_token, "list_tickets", { repo: "team/app" })).isError).toBe(false);
    expect([await limitUse(danaA, "agent_connections"), await limitUse(danaB, "agent_connections")]).toEqual([1, 1]);

    // Revoking the first frees B's slot (the trigger drops its rows), and the second is admitted.
    const cookie = await cookieFor("dana", { member: false });
    expect((await app.request(`/auth/oauth-grants/${p.grantId}/revoke`, { method: "POST", headers: { cookie } }, env)).status).toBe(200);
    expect(await limitUse(danaB, "agent_connections")).toBe(0);
    expect((await call(q.access_token, "append_feed", { summary: "admitted now", tags: ["api"], repo: "dana/side" })).isError).toBe(false);
    expect(await limitUse(danaB, "agent_connections")).toBe(1);
  });

  it("a tool call is metered in the org it resolved to; one that resolved nowhere is metered nowhere", async () => {
    const p = await followRepo("dana");
    await call(p.access_token, "list_docs", { repo: "dana/side" });
    await call(p.access_token, "list_docs", { repo: "team/app" });
    await call(p.access_token, "list_docs", {});
    await rpc(p.access_token, "tools/list", {});
    expect(await rows(`SELECT org_id, metric, actor, count FROM org_usage_daily ORDER BY org_id, metric`)).toEqual([
      { org_id: ORG_B, metric: "mcp_request", actor: "dana", count: 1 }, { org_id: ORG_B, metric: "mcp_tool:list_docs", actor: "dana", count: 1 },
      { org_id: ORG_A, metric: "mcp_request", actor: "dana", count: 1 }, { org_id: ORG_A, metric: "mcp_tool:list_docs", actor: "dana", count: 1 },
    ]);
  });
});

// ── manual: several organizations, one current ───────────────────────────────

describe("a manual connection", () => {
  it("acts in its current org; `org` picks another ALLOWED one for one call; switch_org moves it — for good, among the allowed", async () => {
    const p = await manual("dana", ["acme", "saplinglearn"], "acme");
    expect(await one(`SELECT mode, org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ mode: "manual", org_id: ORG_B });
    expect((await rows<{ org_id: string }>(`SELECT org_id FROM oauth_grant_orgs WHERE grant_id = ? ORDER BY org_id`, p.grantId)).map((r) => r.org_id)).toEqual([ORG_B, ORG_A].sort());
    expect(await whereAmI(p.access_token)).toMatchObject({
      mode: "manual", organization: { slug: "acme" }, role: "member", current: "acme",
      organizations: [{ slug: "acme", role: "member" }, { slug: "saplinglearn", role: "admin" }],
    });

    expect((await call(p.access_token, "append_feed", { summary: "current", tags: ["api"], repo: "team/app" })).isError).toBe(false); // `repo` is ignored
    expect((await call(p.access_token, "append_feed", { summary: "override", tags: ["api"], org: "saplinglearn" })).isError).toBe(false);
    expect((await call(p.access_token, "append_feed", { summary: "current again", tags: ["api"] })).isError).toBe(false);
    expect(await rows(`SELECT org_id, author, summary FROM feed ORDER BY id`)).toEqual([
      { org_id: ORG_B, author: "dana", summary: "current" }, { org_id: ORG_A, author: "dana", summary: "override" }, { org_id: ORG_B, author: "dana", summary: "current again" },
    ]);
    expect(await one(`SELECT org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ org_id: ORG_B }); // an override moves nothing

    const sw = await call(p.access_token, "switch_org", { org: "saplinglearn" });
    expect(sw.json).toMatchObject({ current: { slug: "saplinglearn", name: "SaplingLearn" } });
    expect(await whereAmI(p.access_token)).toMatchObject({ organization: { slug: "saplinglearn" }, role: "admin", current: "saplinglearn" });
    expect((await call(p.access_token, "append_feed", { summary: "after the switch", tags: ["api"] })).isError).toBe(false);
    expect(await one(`SELECT org_id FROM feed WHERE summary = 'after the switch'`)).toEqual({ org_id: ORG_A });

    // An org dana belongs to but did NOT allow, and one that does not exist: the same refusal, and no move.
    const before = await written();
    const answers = [];
    for (const org of ["third", "nowhere"]) {
      for (const tool of ["switch_org", "list_tickets"]) {
        const r = await call(p.access_token, tool, { org });
        expect(r.json, `${tool} ${org}`).toMatchObject({ code: "org_not_allowed", orgs: ["acme", "saplinglearn"] });
        answers.push(r.text.replaceAll(org, "X"));
      }
    }
    expect(new Set(answers).size).toBe(1);
    expect(await one(`SELECT org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ org_id: ORG_A });
    expect(await written()).toBe(before);
  });

  it("no MCP tool can add an organization to a connection: that is a person's act", async () => {
    const p = await manual("dana", ["acme"], "acme");
    const list = (await rpc(p.access_token, "tools/list", {})).result as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] };
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("get_connection");
    expect(names).toContain("switch_org");
    expect(names.filter((x) => /grant|allow|connect_org|add_org|set_mode/.test(x))).toEqual([]);
    // Every org tool takes the two optional scope arguments; neither is ever required.
    for (const t of list.tools) {
      expect(Object.keys(t.inputSchema.properties), t.name).toContain("org");
      if (t.name !== "switch_org") {
        expect(Object.keys(t.inputSchema.properties), t.name).toContain("repo");
        expect(t.inputSchema.required ?? [], t.name).not.toContain("org");
      }
      expect(t.inputSchema.required ?? [], t.name).not.toContain("repo");
    }
    expect((await call(p.access_token, "switch_org", { org: "saplinglearn" })).json).toMatchObject({ code: "org_not_allowed" });
    expect(await rows(`SELECT org_id FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toEqual([{ org_id: ORG_B }]);
  });

  it("when the current org drops out, calls are refused naming what is left — it never falls through to another", async () => {
    const p = await manual("dana", ["acme", "saplinglearn"], "acme");
    await removeMember(platformCtx("dana"), await tenantCtx("dana", undefined, { orgId: ORG_B }), "dana");
    expect(await one(`SELECT revoked_at, org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ revoked_at: null, org_id: ORG_B }); // it still has A
    const before = await written();
    const r = await call(p.access_token, "append_feed", { summary: "where does this go", tags: ["api"] });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ code: "org_unavailable", orgs: ["saplinglearn"] });
    expect(await written()).toBe(before);
    expect(await whereAmI(p.access_token)).toMatchObject({ organization: null, current: null, organizations: [{ slug: "saplinglearn" }], unresolved: { code: "org_unavailable" } });
    expect((await call(p.access_token, "list_tickets", { org: "acme" })).json).toMatchObject({ code: "org_not_allowed" }); // the one she left is not allowed any more
    // One call can still name the org that is left; switching settles it.
    expect((await call(p.access_token, "list_tickets", { org: "saplinglearn" })).isError).toBe(false);
    expect((await call(p.access_token, "switch_org", { org: "saplinglearn" })).isError).toBe(false);
    expect((await call(p.access_token, "append_feed", { summary: "settled", tags: ["api"] })).isError).toBe(false);
    expect(await rows(`SELECT org_id FROM feed`)).toEqual([{ org_id: ORG_A }]);
  });

  it("a suspended current org refuses the same way, and comes back when the suspension is lifted", async () => {
    const p = await manual("dana", ["acme", "saplinglearn"], "acme");
    await env.DB.prepare(`UPDATE orgs SET suspended_at = '2026-10-07T00:00:00Z' WHERE id = ?`).bind(ORG_B).run();
    expect((await call(p.access_token, "list_tickets")).json).toMatchObject({ code: "org_unavailable", orgs: ["saplinglearn"] });
    await env.DB.prepare(`UPDATE orgs SET suspended_at = '2026-10-07T00:00:00Z' WHERE id = ?`).bind(ORG_A).run();
    expect((await rpc(p.access_token, "tools/list", {})).status).toBe(401); // nowhere left
    expect((await refresh(p)).status).toBe(400);
    expect(await one(`SELECT revoked_at FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ revoked_at: null }); // a suspension can be lifted
    await env.DB.prepare(`UPDATE orgs SET suspended_at = NULL`).run();
    expect((await call(p.access_token, "list_tickets")).isError).toBe(false);
  });

  it("counts once in EACH organization it is allowed, and consent is refused whole when one of them is full", async () => {
    const danaA = await tenantCtx("dana", undefined, { orgId: ORG_A });
    const danaB = await tenantCtx("dana", undefined, { orgId: ORG_B });
    const p = await manual("dana", ["acme", "saplinglearn"], "saplinglearn");
    expect([await limitUse(danaA, "agent_connections"), await limitUse(danaB, "agent_connections")]).toEqual([1, 1]);

    await env.DB.prepare(`UPDATE orgs SET plan_overrides = '{"agent_connections":1}' WHERE id = ?`).bind(ORG_B).run();
    const { qs } = await registered();
    const full = await consentPost(qs, await cookieFor("dana", { member: false }), [["mode", "manual"], ["org", "saplinglearn"], ["org", "acme"], ["current", "saplinglearn"]]);
    expect(full.status).toBe(402);
    const fullHtml = await full.text();
    expect(fullHtml).toContain("agent connection");
    expect(fullHtml).toContain("In acme:"); // it says WHICH organization is full
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grants`)).toBe(1); // nothing written — not even for the org with room
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs`)).toBe(2);
    expect(p.grantId).toBeGreaterThan(0);
  });
});

// ── Settings › MCP access: a person changes their own connection ─────────────

describe("Settings: a connection's organizations, current organization and mode (session cookie)", () => {
  const post = async (cookie: string, path: string, body: unknown) => {
    const r = await app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    return { status: r.status, json: (await r.json()) as { error?: string; message?: string; grants?: { id: number; mode: string; org: { slug: string } | null; orgs: { slug: string }[] }[] } };
  };
  const shape = (g: { mode: string; org: { slug: string } | null; orgs: { slug: string }[] } | undefined) => g && [g.mode, g.org?.slug ?? null, g.orgs.map((o) => o.slug)];

  it("adds and removes organizations, switches the current one, and what the agent reaches follows at once", async () => {
    const p = await manual("dana", ["acme"], "acme");
    const cookie = await cookieFor("dana", { member: false });
    const g = `/auth/oauth-grants/${p.grantId}`;

    let r = await post(cookie, `${g}/orgs`, { org: "saplinglearn", on: true });
    expect(r.status).toBe(200);
    expect(shape(r.json.grants!.find((x) => x.id === p.grantId))).toEqual(["manual", "acme", ["acme", "saplinglearn"]]);
    expect((await call(p.access_token, "list_tickets", { org: "saplinglearn" })).isError).toBe(false); // allowed now, without reconnecting
    expect((await post(cookie, `${g}/orgs`, { org: "saplinglearn", on: true })).status).toBe(200); // idempotent
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toBe(2);

    // The current org cannot be removed; switch first.
    r = await post(cookie, `${g}/orgs`, { org: "acme", on: false });
    expect([r.status, r.json.error]).toEqual([409, "current_org"]);
    r = await post(cookie, `${g}/current`, { org: "saplinglearn" });
    expect(shape(r.json.grants!.find((x) => x.id === p.grantId))).toEqual(["manual", "saplinglearn", ["acme", "saplinglearn"]]);
    expect((await whereAmI(p.access_token)).current).toBe("saplinglearn");
    r = await post(cookie, `${g}/orgs`, { org: "acme", on: false });
    expect(r.status).toBe(200);
    expect((await call(p.access_token, "list_tickets", { org: "acme" })).json).toMatchObject({ code: "org_not_allowed" });
    // …and the last one cannot either.
    await env.DB.prepare(`UPDATE oauth_grants SET org_id = ? WHERE id = ?`).bind(ORG_C, p.grantId).run(); // a dangling current, to reach the guard
    r = await post(cookie, `${g}/orgs`, { org: "saplinglearn", on: false });
    expect([r.status, r.json.error]).toEqual([409, "last_org"]);
    await env.DB.prepare(`UPDATE oauth_grants SET org_id = ? WHERE id = ?`).bind(ORG_A, p.grantId).run();

    // Current can only be an org already allowed.
    r = await post(cookie, `${g}/current`, { org: "third" });
    expect([r.status, r.json.error]).toEqual([409, "not_allowed"]);
    expect(await one(`SELECT org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ org_id: ORG_A });
  });

  it("an org the person is not in, and someone else's connection, are the same 404 — nothing is written", async () => {
    const p = await manual("dana", ["acme"], "acme");
    const dana = await cookieFor("dana", { member: false });
    const bob = await cookieFor("bob", { member: false });
    const meilin = await cookieFor("meilin");
    const g = `/auth/oauth-grants/${p.grantId}`;
    await env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = 'dana'`).bind(ORG_C).run();
    for (const [cookie, path, body] of [
      [dana, `${g}/orgs`, { org: "third", on: true }],          // an org dana is not in
      [dana, `${g}/orgs`, { org: "nowhere", on: true }],        // an org that does not exist
      [dana, `${g}/current`, { org: "third" }],
      [dana, `${g}/mode`, { mode: "manual", org: "third" }],
      [bob, `${g}/orgs`, { org: "acme", on: true }],            // bob IS in acme — but it is dana's connection
      [bob, `${g}/current`, { org: "acme" }],
      [bob, `${g}/mode`, { mode: "repo" }],
      [meilin, `${g}/orgs`, { org: "saplinglearn", on: true }],
      [dana, `/auth/oauth-grants/999999/orgs`, { org: "acme", on: true }],
      [dana, `/auth/oauth-grants/999999/mode`, { mode: "repo" }],
    ] as const) {
      const r = await post(cookie, path, body);
      expect([r.status, r.json.error], `${path} ${JSON.stringify(body)}`).toEqual([404, "not_found"]);
    }
    expect(await one(`SELECT mode, org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ mode: "manual", org_id: ORG_B });
    expect(await rows(`SELECT org_id FROM oauth_grant_orgs`)).toEqual([{ org_id: ORG_B }]);
    // No session: no change (the routes are cookie-gated like the rest of /auth).
    const anon = await app.request(`${g}/orgs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.access_token}` }, body: JSON.stringify({ org: "saplinglearn", on: true }) }, env);
    expect(anon.status).toBe(401);
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs`)).toBe(1);
  });

  it("adding an organization over ITS limit is refused there with plan_limit", async () => {
    const p = await manual("dana", ["acme"], "acme");
    await mintTokenFor("dana", ORG_A);
    await env.DB.prepare(`UPDATE orgs SET plan_overrides = '{"agent_connections":1}' WHERE id = ?`).bind(ORG_A).run();
    const cookie = await cookieFor("dana", { member: false });
    const r = await app.request(`/auth/oauth-grants/${p.grantId}/orgs`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ org: "saplinglearn", on: true }) }, env);
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "plan_limit", limit: "agent_connections", used: 1, cap: 1 });
    expect(await rows(`SELECT org_id FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toEqual([{ org_id: ORG_B }]);
    expect((await call(p.access_token, "list_tickets", { org: "saplinglearn" })).json).toMatchObject({ code: "org_not_allowed" });
  });

  it("changes mode both ways: to follow the repository (its org slots are freed), and back to manual in one org", async () => {
    const p = await manual("dana", ["acme", "saplinglearn"], "acme");
    const cookie = await cookieFor("dana", { member: false });
    const g = `/auth/oauth-grants/${p.grantId}`;
    const danaB = await tenantCtx("dana", undefined, { orgId: ORG_B });

    let r = await post(cookie, `${g}/mode`, { mode: "repo" });
    expect(shape(r.json.grants!.find((x) => x.id === p.grantId))).toEqual(["repo", null, []]);
    expect(await one(`SELECT mode, org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ mode: "repo", org_id: "" });
    expect(await limitUse(danaB, "agent_connections")).toBe(0);
    expect((await call(p.access_token, "list_tickets")).json).toMatchObject({ code: "repo_required" });
    expect((await call(p.access_token, "list_tickets", { repo: "third/thing" })).isError).toBe(false); // it now follows the repo into C
    // A follow connection has no organizations to toggle.
    expect([(await post(cookie, `${g}/orgs`, { org: "acme", on: true })).json.error, (await post(cookie, `${g}/current`, { org: "acme" })).json.error]).toEqual(["not_manual", "not_allowed"]);

    r = await post(cookie, `${g}/mode`, { mode: "manual", org: "saplinglearn" });
    expect(shape(r.json.grants!.find((x) => x.id === p.grantId))).toEqual(["manual", "saplinglearn", ["saplinglearn"]]);
    expect(await rows(`SELECT org_id FROM oauth_grant_orgs WHERE grant_id = ?`, p.grantId)).toEqual([{ org_id: ORG_A }]); // C's row (used there) is gone
    expect((await call(p.access_token, "list_tickets", { repo: "third/thing" })).isError).toBe(false); // …and `repo` is ignored again:
    expect((await whereAmI(p.access_token, { repo: "third/thing" })).organization?.slug).toBe("saplinglearn");
    expect((await call(p.access_token, "list_tickets", { org: "third" })).json).toMatchObject({ code: "org_not_allowed" });
    expect((await post(cookie, `${g}/mode`, { mode: "everything" })).status).toBe(404);
  });
});

// ── the consent page ─────────────────────────────────────────────────────────

describe("the consent page — how the connection picks an organization", () => {
  const base: Parameters<typeof consentPage>[0] = { clientName: "Claude Code", redirectHost: "localhost", handle: "dana", hidden: { client_id: "c" }, csrf: "x", orgs: [] };
  const three = [{ slug: "acme", name: "Acme" }, { slug: "saplinglearn", name: "SaplingLearn" }, { slug: "third", name: "Third" }];

  it("several orgs: both choices in plain words, follow the repository recommended and preselected, every org ticked", () => {
    const html = consentPage({ ...base, orgs: three });
    expect(html).toContain("Follow the repository");
    expect(html).toContain("Works in whichever of your organizations has the repository you are in connected; anywhere else it reads and writes nothing.");
    expect(html).toContain("Works in the organizations you tick, one at a time.");
    expect(html).toContain(`<input type="radio" name="mode" value="repo" form="consent" checked>`);
    expect(html).toContain(`<input type="radio" name="mode" value="manual" form="consent">`);
    expect(html).toContain(`<span class="rec">Recommended</span>`);
    expect([...html.matchAll(/<input type="checkbox" name="org" value="([^"]+)" form="consent"( checked)?>/g)].map((m) => [m[1], !!m[2]])).toEqual([["acme", true], ["saplinglearn", true], ["third", true]]);
    expect([...html.matchAll(/<input type="radio" name="current" value="([^"]+)" form="consent"( checked)?>/g)].map((m) => [m[1], !!m[2]])).toEqual([["acme", true], ["saplinglearn", false], ["third", false]]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain(`role="alert"`);
  });

  it("many orgs: only the first is ticked; one org: manual, nothing to tick, the org named", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ slug: `org-${i}`, name: `Org ${i}` }));
    expect(defaultConsentChoice(many)).toEqual({ mode: "repo", orgs: ["org-0"], current: "org-0" });
    expect(defaultConsentChoice(three).orgs).toEqual(["acme", "saplinglearn", "third"]);
    const one = consentPage({ ...base, orgs: [three[0]] });
    expect(defaultConsentChoice([three[0]])).toEqual({ mode: "manual", orgs: ["acme"], current: "acme" });
    expect(one).toContain(`<input type="radio" name="mode" value="manual" form="consent" checked>`);
    expect(one).toContain(`<input type="hidden" name="org" value="acme">`);
    expect(one).not.toContain(`type="checkbox"`);
    expect(one).not.toContain("Recommended");
    expect(one).toContain("Works in <strong>Acme</strong>");
  });

  it("comes back with what was chosen and why it could not be granted; every value is escaped", () => {
    const html = consentPage({ ...base, orgs: [{ slug: "acme", name: `<b>"Acme"</b>` }, three[1]], choice: { mode: "manual", orgs: ["saplinglearn"], current: "saplinglearn" }, error: `Tick <one>` });
    expect(html).toContain(`<div class="err" role="alert">Tick &lt;one&gt;</div>`);
    expect(html).toContain(`<input type="radio" name="mode" value="manual" form="consent" checked>`);
    expect(html).toContain(`<input type="checkbox" name="org" value="acme" form="consent">`);
    expect(html).toContain(`<input type="checkbox" name="org" value="saplinglearn" form="consent" checked>`);
    expect(html).toContain("&lt;b&gt;&quot;Acme&quot;&lt;/b&gt;");
    expect(html).not.toContain(`<b>"Acme"</b>`);
  });

  it("POST: manual needs a ticked org and a start among the ticked; a forged org is refused; nothing is written on any refusal", async () => {
    const cookie = await cookieFor("dana", { member: false });
    const none = await consentPost((await registered()).qs, cookie, [["mode", "manual"]]);
    expect(none.status).toBe(400);
    const noneHtml = await none.text();
    expect(noneHtml).toContain("Tick at least one organization");
    expect(noneHtml).toContain(`<form id="consent"`); // the page itself, to try again
    expect(noneHtml).toContain(`<input type="radio" name="mode" value="manual" form="consent" checked>`);

    const start = await consentPost((await registered()).qs, cookie, [["mode", "manual"], ["org", "acme"], ["org", "saplinglearn"], ["current", "third"]]);
    expect(start.status).toBe(400);
    expect(await start.text()).toContain("Choose which of the organizations you ticked this connection starts in.");

    await ensureMember("bob", "member", ORG_B);
    const forged = await consentPost((await registered()).qs, await cookieFor("bob", { member: false }), [["mode", "manual"], ["org", "acme"], ["org", "saplinglearn"], ["current", "acme"]]);
    expect(forged.status).toBe(403); // bob is not in SaplingLearn: the whole consent is refused
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grants`)).toBe(0);
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grant_orgs`)).toBe(0);

    // One ticked org needs no start; a deny writes nothing.
    const p = await connect("dana", [["mode", "manual"], ["org", "saplinglearn"]]);
    expect(await one(`SELECT org_id FROM oauth_grants WHERE id = ?`, p.grantId)).toEqual({ org_id: ORG_A });
  });

  it("says WHO is signed in, above the choice — name and handle — with a Not you? Sign out that is a POST of its own", () => {
    const html = consentPage({ ...base, name: "Dana <Scully>", orgs: three, hidden: { client_id: "c", state: "s" }, csrf: "tok" });
    expect(html).toContain(`<span class="who-label">Signed in as</span><span class="who-name">Dana &lt;Scully&gt; <span class="who-handle">(@dana)</span></span>`);
    expect(html.indexOf('class="who"')).toBeLessThan(html.indexOf("How it picks an organization"));
    expect(html).toMatch(/<form method="post" action="\/oauth\/switch-account" class="who-form"><input type="hidden" name="client_id" value="c"><input type="hidden" name="state" value="s"><input type="hidden" name="csrf" value="tok"><button class="who-out" type="submit">Not you\? Sign out<\/button><\/form>/);
    expect(html).not.toContain("It will act as"); // one account line, not two
    expect(html).not.toMatch(/<a[^>]*sign ?out/i); // signing out is never a link
    // No name, or a name that is just the handle: the handle alone.
    for (const name of [undefined, null, "", "dana"]) expect(consentPage({ ...base, name, orgs: three })).toContain(`<span class="who-name">@dana</span>`);
  });

  it("Not you? Sign out: ends this browser's session and returns to the SAME request, which then asks for a sign-in; it needs the page's own CSRF value", async () => {
    await env.DB.prepare(`UPDATE persons SET name = 'Dana Scully' WHERE handle = 'dana'`).run();
    const cookie = await cookieFor("dana", { member: false });
    const { qs } = await registered();
    const page = await (await consentGet(qs, cookie)).text();
    expect(page).toContain(`Dana Scully <span class="who-handle">(@dana)</span>`);
    const post = (csrf: string, c: string | null = cookie) => {
      const body = new URLSearchParams(qs); body.set("csrf", csrf);
      return app.request("/oauth/switch-account", { method: "POST", headers: { ...(c ? { cookie: c } : {}), "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, env);
    };
    // Forged, or with no session: nothing happens to anyone's session.
    expect((await post("forged")).status).toBe(403);
    expect((await post(csrfOf(page), null)).status).toBe(403);
    expect((await consentGet(qs, cookie)).status).toBe(200);
    expect(await n(`SELECT COUNT(*) AS n FROM sessions`)).toBe(1);

    const out = await post(csrfOf(page));
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe(`/oauth/authorize?${qs}`);
    expect(out.headers.get("set-cookie")).toMatch(/session=;/);
    expect(await n(`SELECT COUNT(*) AS n FROM sessions`)).toBe(0);
    const again = await consentGet(qs, cookie); // the old cookie no longer names a session
    const html = await again.text();
    expect(html).toContain("Sign in to Trov");
    expect(html).not.toContain("Signed in as");
    expect(again.headers.get("set-cookie")).toContain("oauth_pending="); // the request is remembered across the sign-in
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grants`)).toBe(0);
    // A bad request is refused before any session is touched.
    const other = await cookieFor("bob", { member: false });
    const bad = await app.request("/oauth/switch-account", { method: "POST", headers: { cookie: other, "content-type": "application/x-www-form-urlencoded" }, body: "client_id=nope" }, env);
    expect(bad.status).toBe(400);
    expect(await n(`SELECT COUNT(*) AS n FROM sessions`)).toBe(1);
  });

  it("POST: a person in no organization cannot make a connection of either kind", async () => {
    const cookie = await cookieFor("drifter", { member: false });
    for (const fields of [[["mode", "repo"]], [["mode", "manual"]]] as [string, string][][]) {
      const r = await consentPost((await registered()).qs, cookie, fields);
      expect(r.status).toBe(403); // the page it was shown has no form, so no approval can come from it
    }
    expect(await n(`SELECT COUNT(*) AS n FROM oauth_grants`)).toBe(0);
  });
});

it("the access token's hash is all that is stored (the new columns hold no secret)", async () => {
  const p = await followRepo("dana");
  const stored = JSON.stringify(await rows(`SELECT * FROM oauth_grants`)) + JSON.stringify(await rows(`SELECT * FROM oauth_grant_orgs`));
  expect(stored).not.toContain(p.access_token);
  expect(await n(`SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash = ?`, await sha256Hex(p.access_token))).toBe(1);
});
