/**
 * Tenant isolation — MCP is bound to (user, org) (Multitenancy Phase 5a; canopy-multitenancy.md §7, §10.2).
 *
 * `dana` is a member of BOTH orgs and holds one token per org; `bob` is in org B only. Every tool the
 * server registers is called under a token bound to ONE org with the OTHER org's ids, slugs and handles:
 * a read answers not-found or with the token's own org only, a write is refused or lands in the token's
 * own org, the raw response text never carries a canary of the other org, and a digest of every org-keyed
 * table's rows for the other org is identical before and after. The matrix is checked against the
 * server's own registry, so a tool added without an entry fails here.
 *
 * The context each server is bound to comes from the REAL resolver (`resolveBearerTenant` over a request
 * carrying the token), so what is under test is the binding itself: nothing but the token row names the org.
 *
 * Also here: the membership lifecycle as a bearer sees it (removed → 401, suspended → 401, a role change
 * on the next request), the OAuth consent page's org picker, and the old `/auth/mcp-token…` aliases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../src/index";
import MIGRATION_0051 from "../migrations/0051_mcp_connection_orgs.sql?raw";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import type { TenantContext } from "../src/data/context";
import { buildTrovMcpServer } from "../src/mcp";
import { resolveBearerTenant } from "../src/data/bearer";
import { pkce, sha256Hex } from "../src/auth/crypto";
import { registerClient, refreshAccessToken, OAuthError, ACCESS_TTL_MS } from "../src/auth/oauth";
import { removeMember } from "../src/orgs/repo";
import { promote_doc } from "../src/tools/writes";
import { cookieFor, seedPerson, FIXTURE_ADMIN } from "./helpers/persons";
import { ENVS, seedOrgRepoConfig } from "./helpers/repo";
import { ORG_A, ORG_B, ensureMember, mintTokenFor, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const SLUG = { [ORG_A]: "saplinglearn", [ORG_B]: "acme" } as const;
type Org = typeof ORG_A | typeof ORG_B;
type Tag = "A" | "B";
const TAG: Record<Org, Tag> = { [ORG_A]: "A", [ORG_B]: "B" };
const other = (org: Org): Org => (org === ORG_A ? ORG_B : ORG_A);
/** A person who is a member of that org and of no other (`meilin` is one of SaplingLearn's seeded six). */
const ONLY: Record<Org, string> = { [ORG_A]: "meilin", [ORG_B]: "bob" };

// ── driving the real server under a real token ───────────────────────────────

const bearerReq = (raw: string) => new Request("https://trov.test/mcp", { method: "POST", headers: { authorization: `Bearer ${raw}` } });

/** Token → context, through the production resolver. Throws when the token does not resolve. */
async function ctxOf(raw: string): Promise<TenantContext> {
  const r = await resolveBearerTenant(e, bearerReq(raw));
  if (!r.ok) throw new Error("the token did not resolve — fixture is wrong");
  return r.ctx;
}

interface ToolResult { text: string; isError: boolean }

async function withServer<T>(ctx: TenantContext, fn: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, client: Client) => Promise<T>): Promise<T> {
  const server = buildTrovMcpServer(e, ctx, { origin: "https://trov.test" });
  const client = new Client({ name: "isolation", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    return await fn(async (name, args = {}) => {
      try {
        const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
        return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
      } catch (err) {
        // A tool this context does not have (update_plan for a non-admin), or input the schema refuses.
        return { text: err instanceof Error ? err.message : String(err), isError: true };
      }
    }, client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** The names on the server's own registry — the SDK's `_registeredTools`, not a hand-kept list. */
function registeredTools(ctx: TenantContext): string[] {
  const server = buildTrovMcpServer(e, ctx) as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(server._registeredTools).sort();
}

// ── the fixture: one of everything, per org, each text field carrying that org's canary ───────────

interface Fixture {
  org: Org; tag: Tag; token: string;
  sprint: number; ticket: number; child: number; handoff: number; artifact: string;
  doc: string; prompt: string;
}

const canary = (tag: Tag, what: string) => `CANARY_${tag}_${what}`;
const leak = (tag: Tag) => new RegExp(`CANARY_${tag}_`, "i");
const SHARED_DOC = "shared-doc"; // the same slug in both orgs: each token reads its own
const SHARED_PROMPT = "shared-prompt";

async function seedOrg(org: Org): Promise<Fixture> {
  const tag = TAG[org];
  const c = (what: string) => canary(tag, what);
  await ensureMember("dana", "admin", org);
  await env.DB.prepare(`UPDATE memberships SET title = ?, responsibilities = ? WHERE org_id = ? AND user_id = 'dana'`).bind(c("title"), c("responsibilities"), org).run();
  await env.DB.prepare(`UPDATE memberships SET title = ? WHERE org_id = ? AND user_id = ?`).bind(c("only_member_title"), org, ONLY[org]).run();
  // The org's own dashboard configuration, and a captured event attributed to dana's login THERE.
  await seedOrgRepoConfig(env.DB, org, `canary-${tag.toLowerCase()}/${c("repo")}`, ENVS.map((x) => ({ ...x, label: c(`env_${x.key}`) })));
  await env.DB.prepare(`INSERT OR IGNORE INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, 'dana', 'dana', '2026-01-01T00:00:00Z', 'seed')`).bind(org).run();
  const issue = { action: "opened", issue: { number: 7, title: c("issue"), html_url: `https://github.com/x/y/issues/7`, state: "open", updated_at: "2026-09-01T00:00:00Z", user: { login: "dana" }, assignees: [{ login: "dana" }], labels: [] } };
  await env.DB.prepare(
    `INSERT INTO events (org_id, repo, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, 'x/y', 'gh:issue:7:opened', 'issue', 7, 'dana', ?, 'webhook', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'github-webhook')`,
  ).bind(org, JSON.stringify(issue)).run();

  // A ticket's and a handoff's id over MCP is its per-org NUMBER, and both orgs count from 1 — so to make
  // "the other org's id" name NOTHING in the caller's own org (the matrix expects a refusal), org A's
  // counters start far ahead: A's rows are #101…, B's #1… The matrix therefore proves both halves: a
  // number that is only the other org's is not found, and no response ever carries the other org's canary.
  if (org === ORG_A) {
    await env.DB.prepare(`INSERT INTO org_counters (org_id, name, value) VALUES (?, 'ticket', 100), (?, 'handoff', 100)
                          ON CONFLICT(org_id, name) DO UPDATE SET value = 100`).bind(org, org).run();
  }
  const token = (await mintTokenFor("dana", org)).raw;
  const ids = await withServer(await ctxOf(token), async (call) => {
    const ok = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await call(name, args);
      if (r.isError) throw new Error(`fixture ${tag} ${name}: ${r.text}`);
      return JSON.parse(r.text) as T;
    };
    const sprint = (await ok<{ id: number }>("create_sprint", { label: c("sprint"), summary: c("sprint_summary"), description: c("sprint_description") })).id;
    const ticket = (await ok<{ id: number }>("create_ticket", { title: c("ticket"), body: c("ticket_body"), assignees: ["dana"], sprint_id: sprint, link: "https://example.com/" + c("link") })).id;
    const child = (await ok<{ id: number }>("create_ticket", { title: c("child"), body: c("child_body"), assignees: ["dana"] })).id;
    await ok("add_ticket_comment", { id: ticket, body: c("comment") });
    await ok("add_sprint_resource", { id: sprint, raw: "https://example.com/" + c("resource") });
    await ok("append_feed", { summary: c("feed"), brief: c("feed_brief"), body: c("feed_body"), tags: ["api"] });
    for (const slug of [SHARED_DOC, `only-${tag.toLowerCase()}-doc`]) {
      await ok("propose_doc_update", { slug, section: "reference", title: c(`doc_title_${slug}`), body: c(`doc_body_${slug}`), change_summary: c("doc_change"), confidence: "high" });
      await promote_doc(systemCtx(org), slug, 1, "dana");
    }
    for (const slug of [SHARED_PROMPT, `only-${tag.toLowerCase()}-prompt`]) {
      await ok("save_prompt", { slug, title: c(`prompt_title_${slug}`), body: c(`prompt_body_${slug}`) + " {{name}}", tags: ["api"], summary: c("prompt_summary") });
    }
    const handoff = (await ok<{ id: number }>("send_handoff", { body: c("handoff"), context: { repo: "x/y", branch: "main", task: c("handoff_task"), done: [c("handoff_done")], next: [], files: [] }, prompt: { title: c("handoff_prompt"), body: c("handoff_prompt_body") } })).id;
    const artifact = (await ok<{ slug: string }>("upload_asset", { title: c("artifact"), kind: "markdown", area: "api", repo: "", visibility: "org", content: c("artifact_body"), summary: c("artifact_summary"), links: [{ target_type: "ticket", target_ref: String(ticket) }] })).slug;
    await ok("update_plan", { narrative: c("narrative"), sprints: [] });
    return { sprint, ticket, child, handoff, artifact };
  });
  return { org, tag, token, ...ids, doc: `only-${tag.toLowerCase()}-doc`, prompt: `only-${tag.toLowerCase()}-prompt` };
}

let FX: Record<Org, Fixture>;
let ORG_TABLES: string[];

beforeEach(async () => {
  await seedPerson("dana", { member: false });
  await seedPerson("bob", { member: false });
  await ensureMember("bob", "member", ORG_B);
  FX = { [ORG_A]: await seedOrg(ORG_A), [ORG_B]: await seedOrg(ORG_B) } as Record<Org, Fixture>;
  if (!ORG_TABLES) {
    const tables = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%'`).all<{ name: string }>();
    ORG_TABLES = [];
    for (const t of tables.results) {
      const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(t.name).all<{ name: string }>();
      if (cols.results.some((col) => col.name === "org_id")) ORG_TABLES.push(t.name);
    }
    ORG_TABLES.sort();
  }
});

/**
 * Every row of every org-keyed table for `org` (FTS tables included), one hash per table. `mcp_tokens`
 * is hashed without `last_used_at` — resolving a token bumps it, which is not a write to the org's data.
 */
async function digest(org: Org): Promise<Record<string, string>> {
  const results = await env.DB.batch<Record<string, unknown>>(ORG_TABLES.map((t) => env.DB.prepare(`SELECT * FROM ${t} WHERE org_id = ?`).bind(org)));
  const out: Record<string, string> = {};
  for (const [i, t] of ORG_TABLES.entries()) {
    const rows = results[i].results.map((r) => JSON.stringify(t === "mcp_tokens" ? { ...r, last_used_at: null } : r)).sort();
    out[t] = `${rows.length}:${await sha256Hex(rows.join("\n"))}`;
  }
  return out;
}

// ── the matrix: every tool, called with the OTHER org's ids ─────────────────────────

/**
 * What a call made with the other org's ids must do:
 *   refused — an error (or a null result), and NEITHER org's rows change: the cross-org edge writes
 *             nothing in the caller's own org either;
 *   inert   — it may answer, but neither org's rows change;
 *   own     — it may succeed and write, in the caller's OWN org only.
 * `sees: true` also requires the caller's own canary in the text (the read is not vacuously empty).
 */
interface Probe { args: Record<string, unknown>; expect: "refused" | "inert" | "own"; sees?: true }
type Entry = (o: Fixture, m: Fixture) => Probe[];

const read = (args: Record<string, unknown> = {}): Probe => ({ args, expect: "inert", sees: true });
const refused = (args: Record<string, unknown>): Probe => ({ args, expect: "refused" });

const MATRIX: Record<string, Entry> = {
  // knowledge
  query: () => [read({ q: "canary" }), read({ q: "canary", types: ["doc", "decision", "feed", "sprint", "artifact"], limit: 50, pointer_limit: 50 })],
  get_doc: (o) => [refused({ slug: o.doc }), read({ slug: SHARED_DOC })],
  list_docs: () => [read(), read({ section: "reference" })],
  get_feed: () => [read(), read({ author: "dana" })],
  append_feed: () => [{ args: { summary: "written under the other token", body: "b", tags: ["api"] }, expect: "own" }],
  propose_doc_update: (o) => [{ args: { slug: o.doc, section: "reference", title: "t", body: "an attempt on the other org's doc", change_summary: "s", confidence: "high", base_version: 1 }, expect: "own" }],
  record_session: (o, m) => [{
    args: {
      session: { id: `iso-${m.tag}`, author: "dana", ended_at: "2026-10-06T00:00:00Z", skill_version: "test" },
      artifact_links: [
        { slug: o.artifact, target_type: "ticket", target_ref: String(m.ticket) }, // their page → my ticket
        { slug: m.artifact, target_type: "ticket", target_ref: String(o.ticket) }, // my page → their ticket
        { slug: m.artifact, target_type: "sprint", target_ref: String(o.sprint) },
      ],
    },
    expect: "inert",
  }],
  get_roadmap: () => [read()],
  update_plan: (o) => [{ args: { narrative: "n", sprints: [{ id: o.sprint, label: "hijacked", due: "", status: "done" }] }, expect: "own" }],
  // tickets
  list_tickets: () => [read({ seg: "all" }), read({ seg: "all", assignee: "me" })],
  get_ticket: (o) => [refused({ id: o.ticket })],
  create_ticket: (o) => [
    refused({ title: "to their member", assignees: [ONLY[o.org]] }),
    refused({ title: "into their sprint", sprint_id: o.sprint }),
  ],
  edit_ticket: (o) => [refused({ id: o.ticket, title: "pwned" })],
  transition_ticket: (o) => [refused({ id: o.ticket, to: "done" })],
  add_ticket_comment: (o) => [refused({ id: o.ticket, body: "hello from the other org" })],
  add_ticket_link: (o) => [refused({ id: o.ticket, raw: "https://example.com/x" })],
  set_ticket_sprint: (o, m) => [refused({ id: o.ticket, sprint_id: null }), refused({ id: m.ticket, sprint_id: o.sprint })],
  set_ticket_parent: (o, m) => [refused({ id: o.ticket, child_id: m.child }), refused({ id: m.ticket, child_id: o.child })],
  assign_ticket: (o, m) => [refused({ id: o.ticket, login: "dana", on: true }), refused({ id: m.ticket, login: ONLY[o.org], on: true })],
  get_my_work: () => [read()],
  list_people: () => [read()],
  get_events: () => [read(), read({ subject: "dana" })],
  get_repo_dashboard: () => [read(), read({ include_trends: true })],
  // sprints
  list_sprints: () => [read()],
  get_sprint: (o) => [refused({ id: o.sprint })],
  // A sprint's lead must be a member of the caller's org (`sprintLead`): the other org's person is refused, nothing written.
  create_sprint: (o) => [refused({ label: "led by their member", lead: ONLY[o.org] })],
  set_sprint_active: (o) => [refused({ id: o.sprint, active: true })],
  complete_sprint: (o) => [refused({ id: o.sprint })],
  delete_sprint: (o) => [refused({ id: o.sprint })],
  add_sprint_resource: (o) => [refused({ id: o.sprint, raw: "https://example.com/x" })],
  // artifacts
  upload_asset: (o) => [
    refused({ title: "linked to their ticket", kind: "markdown", area: "api", repo: "", visibility: "org", content: "x", links: [{ target_type: "ticket", target_ref: String(o.ticket) }] }),
    refused({ title: "linked to their sprint", kind: "markdown", area: "api", repo: "", visibility: "org", content: "x", links: [{ target_type: "sprint", target_ref: String(o.sprint) }] }),
  ],
  artifact_update: (o) => [refused({ slug: o.artifact, summary: "s", content: "pwned" })],
  artifact_get: (o) => [refused({ slug: o.artifact }), refused({ slug: `${o.artifact}@v1`, include_content: true })],
  artifact_list: (o) => [read(), read({ q: "canary" }), { args: { ticket: o.ticket }, expect: "inert" }, { args: { sprint: o.sprint }, expect: "inert" }],
  // handoffs
  send_handoff: (o) => [refused({ body: "for their member", recipient: ONLY[o.org] })],
  list_handoffs: () => [read({ box: "sent" }), read({ box: "mine" }), { args: {}, expect: "inert" }, { args: { box: "anyone" }, expect: "inert" }],
  get_handoff: (o) => [refused({ id: o.handoff })],
  claim_handoff: (o) => [refused({ id: o.handoff, session: "iso-session" })],
  expire_handoff: (o) => [refused({ id: o.handoff })],
  // prompts
  search_prompts: () => [read(), read({ q: "canary" }), read({ tags: ["api"] })],
  get_prompt: (o) => [refused({ slug: o.prompt, vars: { name: "x" } }), { args: { slug: SHARED_PROMPT }, expect: "own", sees: true }],
  save_prompt: (o) => [{ args: { slug: o.prompt, title: "t", body: "a prompt of the same slug, in my own org" }, expect: "own" }],
  // The connection's own tools (0051): a token is bound to ONE org — it can be told where it is, and
  // can neither be asked about nor moved to the other one.
  get_connection: (o) => [{ args: {}, expect: "inert" }, { args: { org: SLUG[o.org] }, expect: "inert" }, { args: { repo: `canary-${o.tag.toLowerCase()}/${canary(o.tag, "repo")}` }, expect: "inert" }],
  switch_org: (o) => [refused({ org: SLUG[o.org] })],
};

/** Run the whole matrix as `ctx` (bound to `mine.org`) against `theirs`. `owner` = the fixture's own
 *  author (dana), for whom `sees` is asserted; bob authored nothing, so for him it is not. */
async function runMatrix(ctx: TenantContext, mine: Fixture, theirs: Fixture, owner: boolean): Promise<void> {
  expect(ctx.orgId).toBe(mine.org);
  await withServer(ctx, async (call) => {
    for (const [tool, entry] of Object.entries(MATRIX)) {
      for (const [i, probe] of entry(theirs, mine).entries()) {
        const at = `${tool}[${i}] as ${ctx.userId}@${mine.tag} with ${theirs.tag}'s ids`;
        const before = { theirs: await digest(theirs.org), mine: await digest(mine.org) };
        const r = await call(tool, probe.args);
        expect(r.text, `${at}: the response carries the other org's canary`).not.toMatch(leak(theirs.tag));
        expect(await digest(theirs.org), `${at}: the other org's rows changed`).toEqual(before.theirs);
        if (probe.expect === "refused") expect(r.isError || r.text === "null", `${at}: expected a refusal, got ${r.text.slice(0, 200)}`).toBe(true);
        if (probe.expect !== "own") expect(await digest(mine.org), `${at}: a refused / read-only call wrote in the caller's own org`).toEqual(before.mine);
        if (probe.sees && owner) {
          expect(r.isError, `${at}: ${r.text.slice(0, 200)}`).toBe(false);
          expect(r.text, `${at}: the caller's own org is missing from the response`).toMatch(leak(mine.tag));
        }
      }
    }
  });
}

describe("the matrix covers the registry", () => {
  it("every tool the server registers — for an admin, so update_plan is there — has a matrix entry, and nothing else does", async () => {
    const admin = await ctxOf(FX[ORG_A].token);
    expect(admin.role).toBe("admin");
    expect(registeredTools(admin)).toEqual(Object.keys(MATRIX).sort());
    // A plain member's registry is the same minus the one admin tool.
    const member = await ctxOf((await mintTokenFor("bob", ORG_B)).raw);
    expect(registeredTools(member)).toEqual(Object.keys(MATRIX).filter((t) => t !== "update_plan").sort());
  });

  it("the fixture really put a canary in both orgs (so its absence below means something)", async () => {
    for (const org of [ORG_A, ORG_B] as const) {
      const fx = FX[org];
      await withServer(await ctxOf(fx.token), async (call) => {
        for (const [tool, args] of [["get_ticket", { id: fx.ticket }], ["get_sprint", { id: fx.sprint }], ["get_handoff", { id: fx.handoff }], ["artifact_get", { slug: fx.artifact }], ["get_doc", { slug: fx.doc }], ["get_prompt", { slug: fx.prompt }]] as const) {
          const r = await call(tool, args);
          expect(r.isError, `${tool}: ${r.text.slice(0, 200)}`).toBe(false);
          expect(r.text, tool).toMatch(leak(fx.tag));
          expect(r.text, tool).not.toMatch(leak(TAG[other(org)]));
        }
      });
    }
  });
});

describe("one person, two orgs, one token each", () => {
  it("dana's org-B token: every tool, given org A's ids, stays in B", async () => {
    await runMatrix(await ctxOf(FX[ORG_B].token), FX[ORG_B], FX[ORG_A], true);
  });

  it("dana's org-A token: every tool, given org B's ids, stays in A", async () => {
    await runMatrix(await ctxOf(FX[ORG_A].token), FX[ORG_A], FX[ORG_B], true);
  });

  it("bob, a member of B only: every tool, given org A's ids, stays in B", async () => {
    await runMatrix(await ctxOf((await mintTokenFor("bob", ORG_B)).raw), FX[ORG_B], FX[ORG_A], false);
  });

  it("list_people, get_my_work and query answer for the token's org and no other", async () => {
    for (const org of [ORG_A, ORG_B] as const) {
      const fx = FX[org];
      await withServer(await ctxOf(fx.token), async (call) => {
        const people = (JSON.parse((await call("list_people")).text) as { people: { handle: string; role: string | null; responsibilities: string | null }[] }).people;
        const handles = people.map((p) => p.handle);
        expect(handles).toContain("dana");
        expect(handles).toContain(ONLY[org]);
        expect(handles).not.toContain(ONLY[other(org)]);
        const dana = people.find((p) => p.handle === "dana")!;
        expect([dana.role, dana.responsibilities]).toEqual([canary(fx.tag, "title"), canary(fx.tag, "responsibilities")]); // the title held THERE
        const work = JSON.parse((await call("get_my_work")).text) as { tickets: { id: number }[] };
        expect(work.tickets.map((t) => t.id).sort()).toEqual([fx.ticket, fx.child].sort());
        const dash = JSON.parse((await call("get_repo_dashboard")).text) as { repo: string };
        expect(dash.repo).toBe(`canary-${fx.tag.toLowerCase()}/${canary(fx.tag, "repo")}`); // the org's own primary repo
      });
    }
  });

  it("the org is the token's alone: nothing in the request — a header, a query string, a body field — moves it", async () => {
    const raw = FX[ORG_B].token;
    const forged = new Request(`https://trov.test/mcp?org=${SLUG[ORG_A]}&org_id=${ORG_A}`, {
      method: "POST", headers: { authorization: `Bearer ${raw}`, "x-org": SLUG[ORG_A], "x-org-id": ORG_A, "x-trov-org": ORG_A },
    });
    expect(await resolveBearerTenant(e, forged)).toMatchObject({ ok: true, ctx: { orgId: ORG_B, userId: "dana", via: "bearer" } });
  });

  it("end to end over /mcp: each token's tools/call is answered from its own org", async () => {
    for (const org of [ORG_A, ORG_B] as const) {
      const exec = createExecutionContext();
      const res = await worker.fetch(new Request("https://trov.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${FX[org].token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_tickets", arguments: { seg: "all", org_id: other(org), repo: `canary-${TAG[other(org)].toLowerCase()}/x` } } }),
      }) as Parameters<typeof worker.fetch>[0], e, exec);
      const text = await res.text();
      await waitOnExecutionContext(exec);
      expect(res.status).toBe(200);
      expect(text).toMatch(leak(TAG[org]));
      expect(text).not.toMatch(leak(TAG[other(org)]));
    }
  });

  it("a token that NAMES the other org (`org`) is refused, not answered from its own: nothing from either org comes back", async () => {
    for (const org of [ORG_A, ORG_B] as const) {
      const before = { mine: await digest(org), theirs: await digest(other(org)) };
      const exec = createExecutionContext();
      const res = await worker.fetch(new Request("https://trov.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${FX[org].token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_tickets", arguments: { seg: "all", org: SLUG[other(org)] } } }),
      }) as Parameters<typeof worker.fetch>[0], e, exec);
      const text = await res.text();
      await waitOnExecutionContext(exec);
      expect(res.status).toBe(200);
      expect(text).toContain("org_not_allowed");
      expect(text).not.toMatch(leak(TAG[org]));
      expect(text).not.toMatch(leak(TAG[other(org)]));
      expect({ mine: await digest(org), theirs: await digest(other(org)) }).toEqual(before);
    }
  });
});

// ── the membership lifecycle, as a bearer sees it ────────────────────────────

const mcpStatus = async (raw: string): Promise<[number, string | null]> => {
  const exec = createExecutionContext();
  const res = await worker.fetch(new Request("https://trov.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${raw}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_docs", arguments: {} } }),
  }) as Parameters<typeof worker.fetch>[0], e, exec);
  await res.text();
  await waitOnExecutionContext(exec);
  return [res.status, res.headers.get("www-authenticate")];
};

const REDIRECT = "http://localhost:4444/callback";
/** 0051's backfill statement, cut out of the migration itself (the one between its two marker comments). */
const MIGRATION_0051_BACKFILL = (() => {
  const m = /INSERT OR IGNORE INTO oauth_grant_orgs[\s\S]*?;/.exec(MIGRATION_0051);
  if (!m) throw new Error("0051's backfill statement was not found");
  return m[0].replace(/;$/, "");
})();
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

/** A registered client and the authorize query string for it. */
async function registered() {
  const c = await registerClient(platformCtx(), { client_name: "Claude Code", redirect_uris: [REDIRECT] }, Date.now());
  const { verifier, challenge } = await pkce();
  const qs = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1" });
  return { c, verifier, qs };
}
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const consentPageFor = (qs: URLSearchParams, cookie: string) => app.request(`/oauth/authorize?${qs}`, { headers: { cookie } }, env);
async function postConsent(qs: URLSearchParams, cookie: string, extra: Record<string, string>): Promise<Response> {
  const page = await (await consentPageFor(qs, cookie)).text();
  return postConsentWith(qs, cookie, csrfOf(page), extra);
}
const postConsentWith = (qs: URLSearchParams, cookie: string, csrf: string, extra: Record<string, string>): Promise<Response> => {
  const body = new URLSearchParams(qs); body.set("csrf", csrf); body.set("decision", "allow");
  for (const [k, v] of Object.entries(extra)) body.set(k, v);
  return Promise.resolve(app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, env));
};

/** The whole OAuth flow as `handle`, choosing `org` on the consent page: the token pair a client ends up holding. */
async function oauthPair(handle: string, org: Org): Promise<{ access_token: string; refresh_token: string; client_id: string }> {
  const { c, verifier, qs } = await registered();
  const r = await postConsent(qs, await cookieFor(handle, { member: false }), { org: SLUG[org] });
  expect(r.status, await r.clone().text()).toBe(302);
  const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
  const t = await app.request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: c.client_id }), env);
  expect(t.status).toBe(200);
  return { ...((await t.json()) as { access_token: string; refresh_token: string }), client_id: c.client_id };
}
const refresh = (pair: { refresh_token: string; client_id: string }) =>
  app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: pair.client_id }), env);

describe("membership lifecycle over a bearer", () => {
  it("a removed member: the personal token, the still-unexpired OAuth access token and the refresh token for THAT org stop at once; the other org's keep working", async () => {
    const oauthA = await oauthPair("dana", ORG_A);
    const oauthB = await oauthPair("dana", ORG_B);
    for (const raw of [FX[ORG_A].token, FX[ORG_B].token, oauthA.access_token, oauthB.access_token]) expect((await mcpStatus(raw))[0]).toBe(200);

    // An admin of A removes dana (src/orgs/repo.ts) — the production path, which also revokes in its batch.
    await removeMember(platformCtx("AndresL230"), await tenantCtx("AndresL230"), "dana");

    for (const raw of [FX[ORG_A].token, oauthA.access_token]) {
      const [status, challenge] = await mcpStatus(raw);
      expect(status).toBe(401);
      expect(challenge).toContain(`error="invalid_token"`);
    }
    const refused = await refresh(oauthA);
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([400, "invalid_grant"]);
    // …and org B is untouched: both credentials answer, and the refresh token still rotates.
    for (const raw of [FX[ORG_B].token, oauthB.access_token]) expect((await mcpStatus(raw))[0]).toBe(200);
    const rotated = await refresh(oauthB);
    expect(rotated.status).toBe(200);
    expect((await mcpStatus(((await rotated.json()) as { access_token: string }).access_token))[0]).toBe(200);
    expect(await resolveBearerTenant(e, bearerReq(FX[ORG_B].token))).toMatchObject({ ok: true, ctx: { orgId: ORG_B } });
  });

  it("the live check does not wait for a revocation: a membership row gone by ANY path is a 401, and a refresh then revokes the grant", async () => {
    const oauthA = await oauthPair("dana", ORG_A);
    await env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = 'dana'`).bind(ORG_A).run(); // nothing revoked
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens WHERE org_id = ? AND person = 'dana' AND revoked = 0`).bind(ORG_A).first<{ n: number }>()).toEqual({ n: 1 });
    expect((await mcpStatus(FX[ORG_A].token))[0]).toBe(401);
    expect((await mcpStatus(oauthA.access_token))[0]).toBe(401);

    await expect(refreshAccessToken(platformCtx(), { refresh_token: oauthA.refresh_token, client_id: oauthA.client_id }, Date.now())).rejects.toBeInstanceOf(OAuthError);
    const grant = await env.DB.prepare(`SELECT revoked_at, revoked_reason FROM oauth_grants WHERE org_id = ? AND person = 'dana'`).bind(ORG_A).first<{ revoked_at: string | null; revoked_reason: string | null }>();
    expect(grant?.revoked_at).not.toBeNull();
    expect(grant?.revoked_reason).toBe("member_removed");
    // Rejoining does not bring the old connection back: it was revoked, not suspended.
    await ensureMember("dana", "member", ORG_A);
    expect((await refresh(oauthA)).status).toBe(400);
    expect((await mcpStatus(FX[ORG_A].token))[0]).toBe(200); // the personal token row was never revoked on this path
  });

  it("a suspended org: its tokens are 401 and its refresh is refused WITHOUT spending the grant; lifting the suspension restores them", async () => {
    const oauthA = await oauthPair("dana", ORG_A);
    const suspend = (on: boolean) => env.DB.prepare(`UPDATE orgs SET suspended_at = ? WHERE id = ?`).bind(on ? "2026-10-06T00:00:00Z" : null, ORG_A).run();
    await suspend(true);
    expect((await mcpStatus(FX[ORG_A].token))[0]).toBe(401);
    expect((await mcpStatus(oauthA.access_token))[0]).toBe(401);
    expect((await refresh(oauthA)).status).toBe(400);
    expect((await mcpStatus(FX[ORG_B].token))[0]).toBe(200);

    await suspend(false);
    expect((await mcpStatus(FX[ORG_A].token))[0]).toBe(200);
    expect((await mcpStatus(oauthA.access_token))[0]).toBe(200);
    expect((await refresh(oauthA)).status).toBe(200); // the refresh token was not rotated by the refused attempt
  });

  it("a token whose org no longer exists is a 401, like any other unknown credential", async () => {
    const raw = "trov_mcp_for-an-org-that-is-gone";
    await env.DB.prepare(`PRAGMA foreign_keys = OFF`).run();
    await env.DB.prepare(`INSERT INTO mcp_tokens (org_id, person, token_hash, created_at) VALUES ('org_gone', 'dana', ?, '2026-01-01T00:00:00Z')`).bind(await sha256Hex(raw)).run();
    expect(await resolveBearerTenant(e, bearerReq(raw))).toEqual({ ok: false, reason: "unauthorized" });
    await env.DB.prepare(`DELETE FROM mcp_tokens WHERE org_id = 'org_gone'`).run();
  });

  it("a token row written before tokens were org-scoped (no org_id given) is SaplingLearn's, and works as it always did", async () => {
    const legacy = "canopy_mcp_minted-before-multitenancy-0123456789";
    await env.DB.prepare(`INSERT INTO mcp_tokens (person, token_hash, created_at) VALUES ('meilin', ?, '2026-09-01T00:00:00.000Z')`).bind(await sha256Hex(legacy)).run();
    expect(await resolveBearerTenant(e, bearerReq(legacy))).toMatchObject({ ok: true, ctx: { orgId: ORG_A, userId: "meilin", role: "member", via: "bearer" } });
    expect((await mcpStatus(legacy))[0]).toBe(200);
    // The same for a pre-multitenancy OAuth grant: the column default is its org.
    const c = await registerClient(platformCtx(), { client_name: "Old client", redirect_uris: [REDIRECT] }, Date.now());
    const g = await env.DB.prepare(`INSERT INTO oauth_grants (person, client_id, client_name, created_at) VALUES ('meilin', ?, 'Old client', '2026-09-01T00:00:00.000Z')`).bind(c.client_id).run();
    // …and 0051's backfill (its own statement, run again here over a row written the old way) gives that
    // grant exactly ONE organization: the one already on it. Nothing wider.
    await env.DB.prepare(MIGRATION_0051_BACKFILL).run();
    expect((await env.DB.prepare(`SELECT org_id, person FROM oauth_grant_orgs WHERE grant_id = ?`).bind(g.meta.last_row_id).all()).results).toEqual([{ org_id: ORG_A, person: "meilin" }]);
    expect(await env.DB.prepare(`SELECT mode, org_id FROM oauth_grants WHERE id = ?`).bind(g.meta.last_row_id).first()).toEqual({ mode: "manual", org_id: ORG_A });
    const oat = "canopy_oat_issued-before-multitenancy-0123456789";
    await env.DB.prepare(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, 'access', ?, ?)`)
      .bind(await sha256Hex(oat), g.meta.last_row_id, new Date().toISOString(), new Date(Date.now() + ACCESS_TTL_MS).toISOString()).run();
    expect(await resolveBearerTenant(e, bearerReq(oat))).toMatchObject({ ok: true, ctx: { orgId: ORG_A, userId: "meilin" } });
  });

  it("a role change takes effect on the next request: update_plan appears and disappears with the admin role, per org", async () => {
    const names = async (raw: string) => registeredTools(await ctxOf(raw));
    const role = (r: string, org: Org) => env.DB.prepare(`UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = 'dana'`).bind(r, org).run();
    expect(await names(FX[ORG_A].token)).toContain("update_plan");
    await role("member", ORG_A);
    expect((await ctxOf(FX[ORG_A].token)).role).toBe("member");
    expect(await names(FX[ORG_A].token)).not.toContain("update_plan");
    expect(await names(FX[ORG_B].token)).toContain("update_plan"); // still an admin of B: a role is per org
    // The lane's admin exception follows the same role: a member cannot re-home a ticket that is not theirs.
    const theirs = await withServer(await ctxOf((await mintTokenFor("bob", ORG_B)).raw), async (call) => (JSON.parse((await call("create_ticket", { title: "bob's" })).text) as { id: number }).id);
    await withServer(await ctxOf(FX[ORG_B].token), async (call) => expect((await call("set_ticket_sprint", { id: theirs, sprint_id: FX[ORG_B].sprint })).isError).toBe(false));
    await role("member", ORG_B);
    await withServer(await ctxOf(FX[ORG_B].token), async (call) => expect((await call("set_ticket_sprint", { id: theirs, sprint_id: null })).text).toContain(`"forbidden"`));
    await role("owner", ORG_A);
    expect((await ctxOf(FX[ORG_A].token)).role).toBe("owner");
    expect(await names(FX[ORG_A].token)).toContain("update_plan");
  });

  it("nothing but the org role grants update_plan: a plain member has none, whatever their handle; the fixture's org admin has it", async () => {
    // `seedPerson` makes FIXTURE_ADMIN an org ADMIN (test/helpers/persons.ts) — so the plain member here is someone else.
    await seedPerson("plain-member");
    const member = (await mintTokenFor("plain-member")).raw;
    expect((await ctxOf(member)).role).toBe("member");
    expect(registeredTools(await ctxOf(member))).not.toContain("update_plan");
    await seedPerson(FIXTURE_ADMIN);
    const admin = (await mintTokenFor(FIXTURE_ADMIN)).raw;
    expect((await ctxOf(admin)).role).toBe("admin");
    expect(registeredTools(await ctxOf(admin))).toContain("update_plan");
    // The same handle demoted is a plain member on its next request: the handle itself carries nothing.
    await env.DB.prepare(`UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = ?`).bind(ORG_A, FIXTURE_ADMIN).run();
    expect(registeredTools(await ctxOf(admin))).not.toContain("update_plan");
  });
});

// ── minting is per org ───────────────────────────────────────────────────────

describe("/api/o/:slug/mcp-tokens — a member's own tokens for this org", () => {
  const req = (method: string, path: string, cookie: string) => app.request(path, { method, headers: { cookie } }, env);
  const tokensOf = async (slug: string, cookie: string) => ((await (await req("GET", `/api/o/${slug}/mcp-tokens`, cookie)).json()) as { tokens: { id: number; hint: string | null; created_at: string; last_used_at: string | null }[] }).tokens;

  it("mints for the org in the path, lists and revokes only that org's; the token it returns is bound there", async () => {
    const dana = await cookieFor("dana", { member: false });
    const minted = await req("POST", "/api/o/acme/mcp-tokens", dana);
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    expect(token.startsWith("trov_mcp_")).toBe(true);
    expect(await resolveBearerTenant(e, bearerReq(token))).toMatchObject({ ok: true, ctx: { orgId: ORG_B, userId: "dana", role: "admin" } });

    const inB = await tokensOf("acme", dana);
    const inA = await tokensOf("saplinglearn", dana);
    expect(inB).toHaveLength(2); // the fixture's and this one
    expect(inA).toHaveLength(1);
    expect(Object.keys(inB[0]).sort()).toEqual(["created_at", "hint", "id", "last_used_at"]);
    expect(inB.map((t) => t.hint)).toContain(token.slice(9, 13));
    expect(JSON.stringify([inA, inB])).not.toContain(token);

    // B's token id through A's path, another member's id, and junk are the same 404 — and revoke nothing.
    const mine = inB.find((t) => t.hint === token.slice(9, 13))!;
    expect((await req("POST", `/api/o/saplinglearn/mcp-tokens/${mine.id}/revoke`, dana)).status).toBe(404);
    expect((await req("POST", `/api/o/acme/mcp-tokens/${mine.id}/revoke`, await cookieFor("bob", { member: false }))).status).toBe(404);
    expect((await req("POST", "/api/o/acme/mcp-tokens/nope/revoke", dana)).status).toBe(404);
    expect((await resolveBearerTenant(e, bearerReq(token))).ok).toBe(true);

    const revoked = await req("POST", `/api/o/acme/mcp-tokens/${mine.id}/revoke`, dana);
    expect([revoked.status, await revoked.json()]).toEqual([200, { ok: true }]);
    expect(await resolveBearerTenant(e, bearerReq(token))).toEqual({ ok: false, reason: "unauthorized" });
    expect(await tokensOf("acme", dana)).toHaveLength(1);
    expect((await resolveBearerTenant(e, bearerReq(FX[ORG_A].token))).ok).toBe(true); // A's token is untouched
  });

  it("a non-member (and an unknown slug, and a signed-out caller) cannot mint, list or revoke", async () => {
    const bob = await cookieFor("bob", { member: false });
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens`).first<{ n: number }>();
    for (const slug of ["saplinglearn", "no-such-org"]) {
      expect((await req("POST", `/api/o/${slug}/mcp-tokens`, bob)).status, slug).toBe(404);
      expect((await req("GET", `/api/o/${slug}/mcp-tokens`, bob)).status, slug).toBe(404);
      expect((await req("POST", `/api/o/${slug}/mcp-tokens/1/revoke`, bob)).status, slug).toBe(404);
    }
    expect((await req("POST", "/api/o/acme/mcp-tokens", "")).status).toBe(401);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens`).first<{ n: number }>()).toEqual(before);
  });

  it("the old /auth paths: the alias for a person with exactly one org; 409 org_required for dana, who has two", async () => {
    const dana = await cookieFor("dana", { member: false });
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens`).first<{ n: number }>();
    for (const [method, path] of [["POST", "/auth/mcp-token"], ["GET", "/auth/mcp-tokens"], ["POST", "/auth/mcp-tokens/1/revoke"]] as const) {
      const res = await req(method, path, dana);
      expect([res.status, await res.json()], path).toEqual([409, { error: "org_required" }]);
    }
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens`).first<{ n: number }>()).toEqual(before);

    const bob = await cookieFor("bob", { member: false });
    const { token } = (await (await req("POST", "/auth/mcp-token", bob)).json()) as { token: string };
    expect(await resolveBearerTenant(e, bearerReq(token))).toMatchObject({ ok: true, ctx: { orgId: ORG_B, userId: "bob" } });
    const listed = ((await (await req("GET", "/auth/mcp-tokens", bob)).json()) as { tokens: { id: number }[] }).tokens;
    expect(listed).toHaveLength(1);
    expect(await tokensOf("acme", bob)).toEqual(listed); // the same rows as the org route
    expect((await req("POST", `/auth/mcp-tokens/${listed[0].id}/revoke`, bob)).status).toBe(200);
    expect((await resolveBearerTenant(e, bearerReq(token))).ok).toBe(false);
  });
});

// ── the OAuth consent page's org picker ──────────────────────────────────────

describe("OAuth consent — the org picker", () => {
  it("no org: the page explains, offers no form, and nothing can be granted", async () => {
    const cookie = await cookieFor("drifter", { member: false });
    const { qs } = await registered();
    const res = await consentPageFor(qs, cookie);
    const html = await res.text();
    expect(res.status).toBe(409);
    expect(html).toContain("Join an organization first");
    expect(html).toContain("@drifter");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(`name="org"`);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await postConsentWith(qs, cookie, "forged", { org: "saplinglearn" })).status).toBe(403);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_grants WHERE person = 'drifter'`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("one org: no extra step — the org is named, sent as a hidden field, and the grant is bound to it", async () => {
    const cookie = await cookieFor("bob", { member: false });
    const { qs } = await registered();
    const html = await (await consentPageFor(qs, cookie)).text();
    expect(html).toContain("@bob</strong>");
    expect(html).toContain("Works in <strong>Acme</strong>");
    expect(html).toContain(`<input type="hidden" name="org" value="acme">`);
    expect(html).toContain(`<input type="hidden" name="current" value="acme">`);
    expect(html).not.toContain(`type="checkbox"`); // one organization: nothing to tick
    expect(html).toContain(`<input type="radio" name="mode" value="manual" form="consent" checked>`); // …and manual is the default
    expect((await postConsent(qs, cookie, { org: "acme" })).status).toBe(302);
    // A form that names no org at all (the page before this change) still works for a one-org person.
    expect((await postConsent((await registered()).qs, cookie, {})).status).toBe(302);
    const orgs = (await env.DB.prepare(`SELECT org_id FROM oauth_grants WHERE person = 'bob'`).all<{ org_id: string }>()).results.map((r) => r.org_id);
    expect(orgs).toEqual([ORG_B, ORG_B]);
  });

  it("several orgs: a tick per org and where it starts; a form that names none is refused; suspended orgs are not offered", async () => {
    const cookie = await cookieFor("dana", { member: false });
    const { qs } = await registered();
    const html = await (await consentPageFor(qs, cookie)).text();
    expect([...html.matchAll(/<input type="checkbox" name="org" value="([^"]+)" form="consent" checked>/g)].map((m) => m[1])).toEqual(["acme", "saplinglearn"]); // few orgs: all ticked
    expect([...html.matchAll(/<input type="radio" name="current" value="([^"]+)" form="consent"( checked)?>/g)].map((m) => [m[1], !!m[2]])).toEqual([["acme", true], ["saplinglearn", false]]);
    expect(html).toContain(`<input type="radio" name="mode" value="repo" form="consent" checked>`); // several orgs: follow the repository is the default
    expect(html).not.toContain(`type="hidden" name="org"`);
    expect(html).toContain("SaplingLearn");
    expect(html).toContain("Acme");
    expect(html).toContain(`<form id="consent" method="post" action="/oauth/authorize">`);
    expect(html).toContain(`value="deny" formnovalidate`); // Deny never needs a choice

    // No org named → refused, nothing granted (the browser's `required` is not the check).
    const none = await postConsent(qs, cookie, {});
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("Choose which organization");
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_grants`).first<{ n: number }>()).toEqual({ n: 0 });

    await env.DB.prepare(`UPDATE orgs SET suspended_at = '2026-10-06T00:00:00Z' WHERE id = ?`).bind(ORG_A).run();
    const narrowed = await (await consentPageFor(qs, cookie)).text();
    expect(narrowed).toContain(`<input type="hidden" name="org" value="acme">`); // one live org left: no picker
    expect(narrowed).not.toContain("SaplingLearn");
    expect((await postConsent(qs, cookie, { org: "saplinglearn" })).status).toBe(403); // …and it cannot be forced
  });

  it("the chosen org is carried code → token → refresh, and Connected apps names it", async () => {
    const pairA = await oauthPair("dana", ORG_A);
    const pairB = await oauthPair("dana", ORG_B);
    expect(await resolveBearerTenant(e, bearerReq(pairA.access_token))).toMatchObject({ ok: true, ctx: { orgId: ORG_A, userId: "dana", role: "admin", via: "bearer" } });
    expect(await resolveBearerTenant(e, bearerReq(pairB.access_token))).toMatchObject({ ok: true, ctx: { orgId: ORG_B, userId: "dana" } });
    expect((await env.DB.prepare(`SELECT org_id FROM oauth_codes ORDER BY rowid`).all<{ org_id: string }>()).results.map((r) => r.org_id)).toEqual([ORG_A, ORG_B]);

    const rotated = (await (await refresh(pairB)).json()) as { access_token: string };
    expect(await resolveBearerTenant(e, bearerReq(rotated.access_token))).toMatchObject({ ok: true, ctx: { orgId: ORG_B } });

    const cookie = await cookieFor("dana", { member: false });
    const { grants } = (await (await app.request("/auth/oauth-grants", { headers: { cookie } }, env)).json()) as { grants: { id: number; client_name: string; org: { slug: string; name: string } }[] };
    expect(grants.map((g) => g.org)).toEqual([{ slug: "acme", name: "Acme" }, { slug: "saplinglearn", name: "SaplingLearn" }]); // newest first
    expect(Object.keys(grants[0]).sort()).toEqual(["client_name", "created_at", "id", "last_used_at", "mode", "org", "orgs"]);
    expect(grants.map((g) => [(g as unknown as { mode: string }).mode, (g as unknown as { orgs: unknown }).orgs])).toEqual([["manual", [{ slug: "acme", name: "Acme" }]], ["manual", [{ slug: "saplinglearn", name: "SaplingLearn" }]]]);
    // Revoking is user-level: it works from /auth for either org, and ends that org's connection only.
    const a = grants.find((g) => g.org.slug === "saplinglearn")!;
    expect((await app.request(`/auth/oauth-grants/${a.id}/revoke`, { method: "POST", headers: { cookie } }, env)).status).toBe(200);
    expect((await resolveBearerTenant(e, bearerReq(pairA.access_token))).ok).toBe(false);
    expect((await resolveBearerTenant(e, bearerReq(pairB.access_token))).ok).toBe(true);
  });

  it("a forged `org` — an org the person is not in, an unknown slug, an org id — is refused, and no grant or code is written", async () => {
    const bob = await cookieFor("bob", { member: false });
    for (const org of ["saplinglearn", "no-such-org", ORG_A, "acme' OR '1'='1"]) {
      const { qs } = await registered();
      const res = await postConsent(qs, bob, { org });
      expect(res.status, org).toBe(403);
      expect(res.headers.get("location"), org).toBeNull();
      expect(await res.text(), org).toContain("aren&#39;t a member of that organization");
    }
    expect(await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM oauth_grants) + (SELECT COUNT(*) FROM oauth_codes) AS n`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("the membership is checked when Allow is pressed, not when the page was drawn", async () => {
    const cookie = await cookieFor("dana", { member: false });
    const { qs } = await registered();
    const csrf = csrfOf(await (await consentPageFor(qs, cookie)).text());
    await env.DB.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = 'dana'`).bind(ORG_A).run();
    expect((await postConsentWith(qs, cookie, csrf, { org: "saplinglearn" })).status).toBe(403);
    expect((await postConsentWith(qs, cookie, csrf, { org: "acme" })).status).toBe(302);
    expect((await env.DB.prepare(`SELECT org_id FROM oauth_grants`).all<{ org_id: string }>()).results).toEqual([{ org_id: ORG_B }]);
  });
});
