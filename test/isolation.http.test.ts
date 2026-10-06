// Route-level cross-tenant isolation (canopy-multitenancy.md §10.2), for EVERY route registered on the app.
//
// The matrix rows are generated from the Hono route registry (`app.routes`), not hand-listed: a route with
// no entry below fails "every registered route has a matrix entry", so a new endpoint cannot ship untested.
//
// Fixture: org A (SaplingLearn) holds content whose every text field carries `CANARY_A`; org B (acme) has
// a member `bob`, an owner `boss`, and content of its own under the SAME slugs. Per tenant route, with A's
// ids / slugs / handles / shas in the path and a body that would succeed against A:
//   • under A's slug — bob, boss, a SUPERADMIN with no membership (§5.4), a REMOVED member and a person in
//     no org all get the one 404 `{ "error": "not_found" }`;
//   • under B's slug — bob and boss get a refusal or a B-only body: never a 5xx, never `CANARY_A` anywhere in
//     the raw response (body or headers);
//   • at the old alias path — bob's only org is B (same assertions); a person with no org is 409
//     `org_required`; a member of a SUSPENDED org is 404;
//   • and a digest of every org-A row (each org-keyed table, plus A's people, identities and the legacy
//     `invites` table) is identical before and after.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { CapturedEvent } from "@shared/contract";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import { docImageKey } from "@shared/doc-images";
import { app } from "../src/routes";
import { ingestEvent } from "../src/consumer";
import { append_feed, promote_doc, propose_doc_update, ratify_adr, route_triage, stage_adr } from "../src/tools/writes";
import { create_ticket, add_ticket_comment, set_ticket_parent, set_ticket_sprint } from "../src/tools/tickets";
import { create_sprint, add_sprint_resource } from "../src/tools/sprints";
import { createHandoff } from "../src/tools/handoffs";
import { savePrompt } from "../src/tools/prompts";
import { createPage, sha256Hex } from "../src/tools/artifacts";
import { all, first, run } from "./helpers/db";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, mintTokenFor, platformCtx, systemCtx } from "./helpers/tenant";

const CANARY = "CANARY_A";
const ORG_C = "org_c";
const A = () => systemCtx(ORG_A);
const B = () => systemCtx(ORG_B);
const NOT_FOUND = JSON.stringify({ error: "not_found" });
const ORG_REQUIRED = JSON.stringify({ error: "org_required" });
const ALICE = "iso-alice"; // in A only
const OWNER_A = "AndresL230";
const INVITED = "canary-invitee@x.io";

// ── the fixture ──────────────────────────────────────────────────────────────

type Who = "bob" | "boss" | "root" | "gone" | "nobody" | "sue";
interface Fx {
  cookies: Record<Who, string>;
  alice: string; ownerA: string;
  docSlug: string; promptSlug: string; artifactSlug: string;
  adrId: number; triageId: number; ticketId: number; subTicketId: number; linkId: number; sprintId: number; handoffId: number;
  inviteId: number; hookId: string; envKey: string; imgSha: string; login: string; tokenId: number;
  bTicketId: number;
}

const doc = (slug: string, text: string) =>
  ({ slug, section: "reference", title: `${text} doc title`, body: `${text} doc body`, change_summary: `${text} summary`, confidence: "high" as const });

async function seed(): Promise<Fx> {
  const T = "2026-10-01T00:00:00.000Z";
  // ── people ──
  await seedPerson(ALICE, { name: `${CANARY} Alice` });
  await run(env.DB, `UPDATE memberships SET title = ?, responsibilities = ? WHERE org_id = ? AND user_id = ?`, `${CANARY} title`, `${CANARY} responsibilities`, ORG_A, ALICE);
  await ensureMember("bob", "member", ORG_B);
  await ensureMember("boss", "owner", ORG_B);
  await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by, suspended_at, suspended_by) VALUES (?, 'cedar', 'Cedar', ?, 'test', ?, 'test')`, ORG_C, T, T);
  await ensureMember("sue", "owner", ORG_C);
  const ownerA = await cookieFor(OWNER_A);
  const cookies = {
    bob: await cookieFor("bob", { member: false }), boss: await cookieFor("boss", { member: false }),
    root: await cookieFor("root", { member: false }), gone: await cookieFor("gone"),
    nobody: await cookieFor("nobody", { member: false }), sue: await cookieFor("sue", { member: false }),
  };
  await run(env.DB, `INSERT INTO platform_admins (person, granted_at, granted_by) VALUES ('root', ?, 'seed')`, T);
  // `gone` WAS a member of A: removed through the real route (membership, tokens and grants go).
  expect((await app.request("/api/o/saplinglearn/members/gone", { method: "DELETE", headers: { cookie: ownerA } }, env)).status).toBe(200);

  // ── org A: one of everything, every text field a canary ──
  await propose_doc_update(A(), doc("iso-doc", CANARY), ALICE);
  await promote_doc(A(), "iso-doc", 1, ALICE);
  await propose_doc_update(A(), doc("iso-doc", `${CANARY} staged`), ALICE); // v2, staged
  await append_feed(A(), { author: ALICE, summary: `${CANARY} feed summary`, body: `${CANARY} feed body`, tags: ["infra"] });
  const adr = (n: string) => ({ title: `${CANARY} adr ${n}`, context: CANARY, decision: CANARY, rationale: CANARY, confidence: "high" as const });
  const adrId = await stage_adr(A(), adr("draft"), ALICE);
  await ratify_adr(A(), await stage_adr(A(), adr("ratified"), ALICE));
  const triageId = await route_triage(A(), { raw: doc("iso-triaged", CANARY), reason: `${CANARY} reason`, source_author: ALICE });
  const login = "canary-a-login";
  const event: CapturedEvent = {
    semantic_key: "gh:pr:7:merged", event_type: "pr_merged", ref_number: 7, subject_login: login,
    raw: JSON.stringify({ pr: { number: 7, title: `${CANARY} pr title`, body: CANARY } }), provenance: "webhook", occurred_at: T,
  };
  await ingestEvent(A(), platformCtx(), event, "github-webhook"); // events + the identity task for `login`

  const sprintId = (await create_sprint(A(), SprintCreate.parse({ label: `${CANARY} sprint` }), ALICE)).id;
  await add_sprint_resource(A(), sprintId, `https://example.com/${CANARY}-resource`);
  const ticketId = await create_ticket(A(), TicketCreate.parse({ title: `${CANARY} ticket`, body: `${CANARY} ticket body`, assignees: [ALICE], link: `https://example.com/${CANARY}-link` }), ALICE);
  await add_ticket_comment(A(), ticketId, `${CANARY} comment`, ALICE);
  const subTicketId = await create_ticket(A(), TicketCreate.parse({ title: `${CANARY} sub-ticket` }), ALICE);
  await set_ticket_parent(A(), ticketId, subTicketId);
  await set_ticket_sprint(A(), ticketId, sprintId);
  const linkId = (await first<{ id: number }>(env.DB, `SELECT id FROM ticket_links WHERE org_id = ? AND ticket_id = ?`, ORG_A, ticketId))!.id;

  const handoffId = (await createHandoff(A(), ALICE, { body: `${CANARY} handoff body`, context: { task: `${CANARY} task` } })).handoff.id;
  await savePrompt(A(), ALICE, { slug: "iso-prompt", title: `${CANARY} prompt`, body: `${CANARY} prompt body`, tags: ["review"], status: "published" }, "human");
  const artifactSlug = (await createPage(A(), { title: `${CANARY} artifact`, kind: "markdown", area: "auth", content: `# ${CANARY} artifact content` }, ALICE)).slug;

  const png = new TextEncoder().encode(`\x89PNG\r\n\x1a\n${CANARY}-image-bytes:${"x".repeat(40)}`);
  const imgSha = await sha256Hex(png);
  await env.ARTIFACTS_BUCKET.put(docImageKey(imgSha), png, { httpMetadata: { contentType: "image/png" } });
  await run(env.DB, `INSERT INTO doc_images (org_id, sha256, content_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, 'image/png', ?, ?, ?)`, ORG_A, imgSha, png.byteLength, ALICE, T);

  // Config and credentials: a repo, an environment, an email invite (the legacy route: `org_invites` + its sidecar), an MCP token.
  const hookId = "hook_canary_a";
  await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by) VALUES (?, ?, ?, 1, ?, ?)`, hookId, ORG_A, `canary-a/${CANARY}-repo`, T, ALICE);
  const envKey = "canary-env";
  await run(env.DB, `INSERT INTO org_environments (org_id, key, position, label, branch, created_at, updated_at, updated_by) VALUES (?, ?, 0, ?, 'main', ?, ?, ?)`, ORG_A, envKey, `${CANARY} env`, T, T, ALICE);
  const invited = await app.request("/invites", { method: "POST", headers: { cookie: ownerA, "content-type": "application/json" }, body: JSON.stringify({ email: INVITED, name: `${CANARY} Invitee` }) }, env);
  expect(invited.status).toBe(200);
  const inviteId = (await first<{ id: number }>(env.DB, `SELECT id FROM org_invites WHERE org_id = ? AND email = ?`, ORG_A, INVITED))!.id;
  await mintTokenFor(ALICE, ORG_A);
  const tokenId = (await first<{ id: number }>(env.DB, `SELECT id FROM mcp_tokens WHERE org_id = ? AND person = ?`, ORG_A, ALICE))!.id;
  await run(env.DB, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, ?, 'my_work', 'daily', ?)`, ORG_A, ALICE, T);

  // ── org B: its own content under the SAME slugs, and a ticket for the cross-org edges ──
  await propose_doc_update(B(), doc("iso-doc", "B-own"), "boss");
  await promote_doc(B(), "iso-doc", 1, "boss");
  await savePrompt(B(), "boss", { slug: "iso-prompt", title: "B-own prompt", body: "B-own prompt body", tags: ["review"], status: "published" }, "human");
  const bTicketId = await create_ticket(B(), TicketCreate.parse({ title: "B-own ticket" }), "boss");

  return {
    cookies, alice: await cookieFor(ALICE), ownerA,
    docSlug: "iso-doc", promptSlug: "iso-prompt", artifactSlug, adrId, triageId, ticketId, subTicketId, linkId, sprintId, handoffId,
    inviteId, hookId, envKey, imgSha, login, tokenId, bTicketId,
  };
}

// ── the digest of org A ──────────────────────────────────────────────────────

let orgTables: string[] | null = null;
/** Every table with an `org_id` column, from the live schema (as test/data-layer.static.test.ts derives it) — FTS tables included. */
async function orgKeyedTables(): Promise<string[]> {
  if (orgTables) return orgTables;
  const tables = await all<{ name: string }>(env.DB,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'd1_%' ORDER BY name`);
  const keyed: string[] = [];
  for (const t of tables) {
    const cols = await all<{ name: string }>(env.DB, `SELECT name FROM pragma_table_info(?)`, t.name);
    if (cols.some((c) => c.name === "org_id")) keyed.push(t.name);
  }
  return (orgTables = keyed);
}

/** Every row org A owns, per table (sorted, so the order a statement returns them in is not part of it). */
async function digestA(): Promise<Record<string, string>> {
  const tables = await orgKeyedTables();
  const members = `(SELECT user_id FROM memberships WHERE org_id = '${ORG_A}')`;
  const extra: [string, string][] = [
    ["persons (A's members)", `SELECT * FROM persons WHERE handle IN ${members} OR handle = 'gone'`],
    ["identities (A's members)", `SELECT * FROM identities WHERE person IN ${members}`],
    ["invites (the legacy sidecar)", `SELECT * FROM invites`],
    ["orgs (A)", `SELECT * FROM orgs WHERE id = '${ORG_A}'`],
  ];
  const res = await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`SELECT * FROM "${t}" WHERE org_id = ?`).bind(ORG_A)),
    ...extra.map(([, sql]) => env.DB.prepare(sql)),
  ]);
  const out: Record<string, string> = {};
  [...tables, ...extra.map(([name]) => name)].forEach((name, i) => {
    out[name] = JSON.stringify((res[i].results as unknown[]).map((r) => JSON.stringify(r)).sort());
  });
  return out;
}

// ── requests ─────────────────────────────────────────────────────────────────

interface Sent { status: number; text: string; raw: string }
async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Sent> {
  const res = await app.request(path, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  const text = await res.text();
  return { status: res.status, text, raw: `${text}\n${JSON.stringify([...res.headers])}` };
}

/** A's value for one path parameter of a tenant route. */
function paramValue(suffix: string, name: string, fx: Fx): string {
  const under = (p: string) => suffix.startsWith(p);
  switch (name) {
    case "slug": return under("/doc") ? fx.docSlug : under("/prompts") ? fx.promptSlug : fx.artifactSlug;
    case "id": return String(
      under("/tickets") ? fx.ticketId : under("/sprints") ? fx.sprintId : under("/handoffs") ? fx.handoffId : under("/adr") ? fx.adrId
        : under("/needs-triage") ? fx.triageId : under("/invites") ? fx.inviteId : under("/mcp-tokens") ? fx.tokenId : fx.hookId);
    case "linkId": return String(fx.linkId);
    case "login": return fx.login;
    case "handle": return ALICE;
    case "sha": return fx.imgSha;
    case "ver": return "v1";
    case "key": return fx.envKey;
    case "kind": return "github_token";
    case "a": case "b": return "nope"; // never `test`: Test connection would reach for the network
    case "email": return encodeURIComponent(INVITED);
    case "ref": return fx.artifactSlug;
    default: throw new Error(`no fixture value for :${name} in ${suffix}`);
  }
}
const fill = (suffix: string, fx: Fx): string => suffix.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, (_m, name: string) => paramValue(suffix, name, fx));

// ── the matrix ───────────────────────────────────────────────────────────────

interface Row {
  /** A query string that makes the read look for A's content. */
  query?: string;
  /** A body that would succeed against org A's rows. */
  body?: unknown | ((fx: Fx) => unknown);
  /** 5xx statuses that are this route's documented answer (never a crash). */
  allow?: number[];
}
const J = (o: unknown): Row => ({ body: o });

/** Every route under `/api/o/:slug`, by `METHOD suffix`. */
const TENANT: Record<string, Row> = {
  // src/routes.ts — tenantRoot
  "GET /img/:sha": {},
  "POST /ingest": J({}),
  "GET /docs": {}, "GET /doc/:slug": {}, "GET /feed": { query: `?author=${ALICE}` }, "GET /feed/stats": {},
  "GET /search": { query: "?q=CANARY" }, "GET /search/quick": { query: "?q=CANARY" },
  "GET /needs-triage": {}, "GET /adrs": {}, "GET /proposals": {},
  "POST /doc/:slug/promote": J({ version: 2 }), "POST /doc/:slug/reject": J({ version: 2 }),
  "POST /adr/:id/ratify": J({}), "POST /adr/:id/reject": J({}),
  "POST /needs-triage/:id/discard": J({}), "POST /needs-triage/:id/assign": J({ type: "feed" }),
  "GET /identity-tasks": {}, "POST /identity-tasks/:login/map": J({ person: ALICE }),
  "POST /identity-tasks/:login/discard": J({}), "POST /identity-tasks/:login/restore": J({}),
  "GET /persons": {}, "GET /roadmap": {}, "GET /me/dashboard": {}, "GET /repo/dashboard": {},
  // 503: Sync GitHub's "service token or repo not configured" — the caller's OWN org has none (test/jobs.multi-org.test.ts).
  "POST /admin/backfill": { body: {}, allow: [503] }, "POST /admin/poll": J({}), "POST /admin/poll-usage": J({}),
  "POST /tickets": J({ title: "from the matrix" }), "GET /tickets": { query: "?seg=all" }, "GET /tickets/badge": {}, "GET /tickets/:id": {},
  "POST /tickets/:id/edit": J({ title: "hijacked" }), "POST /tickets/:id/status": J({ to: "in_progress" }),
  "POST /tickets/:id/move": J({ to: "in_progress", after_id: null }), "POST /tickets/:id/assignees": J({ login: "bob", on: true }),
  "POST /tickets/:id/links": J({ raw: "https://example.com/x" }), "POST /tickets/:id/links/:linkId/remove": J({}),
  "POST /tickets/:id/delete": J({}), "POST /tickets/:id/sprint": { body: (fx: Fx) => ({ sprint_id: fx.sprintId }) },
  "POST /tickets/:id/parent": { body: (fx: Fx) => ({ child_id: fx.subTicketId }) }, "POST /tickets/:id/comment": J({ body: "hijack" }),
  "POST /sprints": J({ label: "from the matrix" }), "GET /sprints": {}, "GET /sprints/:id": {},
  "POST /sprints/:id/active": J({ active: true }), "POST /sprints/:id/resources": J({ raw: "https://example.com/r" }),
  "POST /sprints/:id/delete": J({}), "POST /sprints/:id/complete": J({}),
  // src/artifacts/routes.ts
  "GET /artifacts": {}, "POST /artifacts": J({ title: "from the matrix", kind: "markdown", area: "auth", content: "b" }),
  "POST /artifacts/fetch": J({}), "POST /artifacts/upload-url": J({}),
  "GET /artifacts/:slug": {}, "GET /artifacts/:slug/:ver{v[0-9]+}": {}, "PATCH /artifacts/:slug": J({ title: "hijacked" }),
  "POST /artifacts/:slug/versions": J({ content: "hijacked" }), "GET /artifacts/:slug/diff": { query: "?a=1&b=1" },
  "POST /artifacts/:slug/links": J({ target_type: "pr", target_ref: "o/r#1" }), "POST /artifacts/:slug/links/remove": J({ target_type: "pr", target_ref: "o/r#1" }),
  "POST /artifacts/:slug/ratify": J({ version: 1 }), "POST /artifacts/:slug/delete": J({}), "POST /artifacts/:slug/restore": J({}),
  // src/notifications/routes.ts
  "GET /notifications/prefs": {}, "PUT /notifications/prefs": J({ prefs: {} }),
  "GET /notifications/policy": {}, "PUT /notifications/policy": J({ kind: "my_work", enabled: true }),
  "GET /notifications/settings": {}, "PUT /notifications/settings": J({ send_hour: 9 }),
  "GET /notifications/outbox": {}, "PUT /notifications/persons/:handle": J({ email: "hijack@x.io" }),
  "GET /notifications/preview": { query: "?cadence=daily" }, "POST /notifications/test-send": J({ cadence: "daily", sample: true }),
  // src/routes.ts — tenantApi
  "GET /handoffs": { query: "?box=anyone" }, "GET /handoffs/:id": {}, "POST /handoffs": J({ body: "to an A-only person", recipient: ALICE }),
  "POST /handoffs/:id/claim": J({}), "POST /handoffs/:id/expire": J({}),
  "GET /prompts": {}, "GET /prompts/:slug": {}, "GET /prompts/:slug/versions": {}, "POST /prompts": J({ slug: "matrix-prompt", title: "t", body: "b" }),
  "POST /prompts/:slug/tags": J({ tags: ["review"] }), "POST /prompts/:slug/used": J({}), "POST /prompts/:slug/publish": J({ version: 1 }),
  "POST /prompts/:slug/delete": J({}), "POST /prompts/:slug/restore": J({}),
  "POST /docs/propose": J({ title: "From the matrix", section: "reference", space: "technical", body: "b" }),
  "GET /people/:handle": {}, "POST /people/me/avatar": J({}), "POST /people/me/avatar/remove": J({}),
  // src/artifacts/raw.ts — the bytes of A's artifact, by slug (`:ref`, `:slug/:ver`); the alias is `/raw/a/…`
  "GET /raw/a/:ref": {}, "GET /raw/a/:slug/:ver": {},
  // src/orgs/routes.ts
  "GET /me": {}, "GET /settings": {}, "PUT /settings": J({ name: "Acme (renamed)" }),
  "GET /members": {}, "PUT /members/:handle": J({ title: "hijacked", role: "admin" }), "DELETE /members/:handle": {},
  "GET /invites": {}, "POST /invites": J({ email: INVITED }), "POST /invites/:id/revoke": J({}), "POST /invites/:id/resend": J({}),
  // src/integrations/routes.ts
  "GET /integrations": {}, "GET /integrations/audit": {}, "POST /integrations/rotate-key": J({}),
  "PUT /integrations/:kind": J({ secret: "x" }), "PUT /integrations/:kind/:a": J({ secret: "x" }), "PUT /integrations/:kind/:a/:b": J({ secret: "x" }),
  "POST /integrations/:kind/:a": J({ secret: "x" }), "POST /integrations/:kind/:a/:b": J({ secret: "x" }),
  "DELETE /integrations/:kind": {}, "DELETE /integrations/:kind/:a": {},
  "GET /repos": {}, "POST /repos": J({ repo_full_name: "acme/matrix" }), "DELETE /repos/:id": {},
  "GET /environments": {}, "PUT /environments": J({ order: [] }), "PUT /environments/:key": J({ label: "hijacked", branch: "main" }), "DELETE /environments/:key": {},
  // src/auth/token-routes.ts — the caller's OWN tokens for the org in the path (`:id` is alice's token in A)
  "GET /mcp-tokens": {}, "POST /mcp-tokens": J({}), "POST /mcp-tokens/:id/revoke": J({}),
};

/** The org surface (src/orgs, src/integrations) and a member's MCP tokens (src/auth/token-routes.ts) exist ONLY under
 *  `/api/o/:slug`; every other tenant route also has an alias at its old path. The tokens' old paths are not twins of
 *  these — `/auth/mcp-token…` is person-level and resolves the caller's one org itself (PLATFORM, below). */
const NO_ALIAS = (suffix: string): boolean =>
  suffix === "/me" || ["/settings", "/members", "/invites", "/integrations", "/repos", "/environments", "/mcp-tokens"].some((p) => suffix === p || suffix.startsWith(`${p}/`));

/** Old paths whose `/api/o/:slug` form is a DIFFERENT route (or none): behind `soleTenantGate`, exercised in their own test below. */
const LEGACY_ONLY: Record<string, Row> = {
  "GET /invites": {}, "POST /invites": J({ email: INVITED, name: "B's invitee" }),
  "POST /invites/:email/revoke": J({}), "POST /invites/:email/resend": J({}),
  "PUT /api/people/:handle": J({ role: "hijacked", responsibilities: "hijacked" }),
};

/** Session routes that are neither `tenantGate`'s nor `soleTenantGate`'s — and why each is safe with no membership. */
const PLATFORM: Record<string, string> = {
  "GET /auth/login": "public: starts the GitHub OAuth redirect",
  "GET /auth/callback": "public: the OAuth callback — state + PKCE bound to a sealed cookie",
  "GET /auth/google/login": "public: starts the Google OAuth redirect",
  "GET /auth/google/callback": "public: the OAuth callback",
  "GET /auth/onboard": "the sealed onboard cookie: echoes the provider profile it carries",
  "GET /auth/handle-check": "onboard cookie or session: is a handle free (persons are global)",
  "POST /auth/onboard": "the sealed onboard cookie: creates a person, never a membership (except a legacy invite)",
  "GET /auth/me": "the caller's own person, identities, orgs and invite count",
  "PUT /auth/me": "the caller's own name / color",
  "POST /auth/me/handle": "the caller's own handle",
  "POST /auth/identities/:provider/unlink": "the caller's own identities",
  "POST /auth/logout": "the caller's own session",
  "POST /auth/mcp-token": "cut-over alias of POST /api/o/:slug/mcp-tokens: resolves the caller's ONE org itself (409 org_required with none or several, 404 suspended)",
  "GET /auth/mcp-tokens": "cut-over alias: the caller's own tokens for their one org (same refusals)",
  "POST /auth/mcp-tokens/:id/revoke": "cut-over alias: the caller's own token for their one org — someone else's id, or their own for another org, is 404",
  "GET /auth/oauth-grants": "the caller's own grants",
  "POST /auth/oauth-grants/:id/revoke": "the caller's own grants (someone else's id is 404)",
  "GET /.well-known/oauth-protected-resource": "public OAuth metadata",
  "GET /.well-known/oauth-protected-resource/mcp": "public OAuth metadata",
  "GET /.well-known/oauth-authorization-server": "public OAuth metadata",
  "OPTIONS /.well-known/*": "CORS preflight",
  "OPTIONS /oauth/*": "CORS preflight",
  "POST /oauth/register": "public: dynamic client registration (RFC 7591)",
  "POST /oauth/token": "public: code / refresh exchange — the grant names its person and org",
  "POST /oauth/revoke": "public: token revocation by the token itself",
  "GET /oauth/authorize": "reads the session itself; consent names the org (Phase 5a)",
  "POST /oauth/authorize": "reads the session itself",
  "GET /api/orgs": "the caller's own memberships and pending invites",
  "POST /api/orgs": "creates an org the caller owns (cap 3 per person)",
  "GET /api/invites": "the caller's own pending invites (matched on their GitHub login / provider-verified email)",
  "POST /api/invites/:id/accept": "an invite that is the caller's — anyone else's id is 404",
  "POST /api/invites/:id/decline": "an invite that is the caller's",
  "GET /avatar/:sha": "content-addressed person avatar (64 hex): a person's own picture, the same in every org",
  "GET /api/platform/orgs": "requireSuperadmin", "POST /api/platform/orgs": "requireSuperadmin", "GET /api/platform/orgs/:slug": "requireSuperadmin",
  "POST /api/platform/orgs/:slug/admin": "requireSuperadmin", "POST /api/platform/orgs/:slug/suspend": "requireSuperadmin",
  "POST /api/platform/orgs/:slug/unsuspend": "requireSuperadmin", "PUT /api/platform/persons/:handle/org-limit": "requireSuperadmin",
  "GET /api/platform/admins": "requireSuperadmin", "POST /api/platform/admins": "requireSuperadmin", "DELETE /api/platform/admins/:handle": "requireSuperadmin",
  "GET /api/platform/audit": "requireSuperadmin", "GET /api/platform/usage": "requireSuperadmin",
};

// ── the registry ─────────────────────────────────────────────────────────────

const REGISTRY = [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];
const HAS = new Set(REGISTRY);
/** `METHOD suffix` of a route under the org prefix (`:slug` for the org surface, `:org` for the tenant sub-apps), else null. */
const tenantKey = (route: string): string | null => {
  const m = /^(\S+) \/api\/o\/:(?:slug|org)(\/.*)$/.exec(route);
  return m ? `${m[1]} ${m[2]}` : null;
};
const TENANT_ROUTES = REGISTRY.map(tenantKey).filter((k): k is string => k !== null);
/** The old path of a tenant route: its suffix (tenantRoot) or `/api` + its suffix (tenantApi). */
const aliasOf = (key: string): string | null => {
  const [method, suffix] = key.split(" ");
  if (NO_ALIAS(suffix)) return null;
  return HAS.has(`${method} ${suffix}`) ? suffix : `/api${suffix}`;
};

describe("the route registry", () => {
  it("every registered route has a matrix entry", () => {
    const aliases = new Set(TENANT_ROUTES.map((k) => { const a = aliasOf(k); return a ? `${k.split(" ")[0]} ${a}` : null; }));
    const unclassified = REGISTRY.filter((r) => {
      const key = tenantKey(r);
      if (key) return !(key in TENANT);
      return !(r in PLATFORM) && !(r in LEGACY_ONLY) && !aliases.has(r);
    });
    expect(unclassified, "add each to TENANT / LEGACY_ONLY / PLATFORM (with why it is safe) in test/isolation.http.test.ts").toEqual([]);
  });

  it("the matrix names no route that is gone", () => {
    expect(Object.keys(TENANT).filter((k) => !TENANT_ROUTES.includes(k))).toEqual([]);
    expect([...Object.keys(PLATFORM), ...Object.keys(LEGACY_ONLY)].filter((k) => !HAS.has(k))).toEqual([]);
  });

  it("every tenant route outside the org surface and the MCP tokens is mounted twice: under the slug and at its old path", () => {
    const missing = TENANT_ROUTES.filter((k) => !NO_ALIAS(k.split(" ")[1])).filter((k) => !HAS.has(`${k.split(" ")[0]} ${aliasOf(k)}`));
    expect(missing).toEqual([]);
    // …and nothing that is not person-level sits outside both gates: an alias is a tenant route's, or a legacy one.
    expect(TENANT_ROUTES.length).toBeGreaterThan(100);
  });
});

// ── one test per tenant route ────────────────────────────────────────────────

const OUTSIDERS: Who[] = ["bob", "boss", "root", "gone", "nobody"];

function expectClean(label: string, r: Sent, allow: number[] = []): void {
  expect(r.raw.includes(CANARY), `${label} → ${r.status} leaked ${CANARY}: ${r.text.slice(0, 300)}`).toBe(false);
  if (r.status >= 500) expect(allow, `${label} → ${r.status} ${r.text.slice(0, 300)}`).toContain(r.status);
}

describe("every tenant route, called from outside org A with A's ids", () => {
  it.each(TENANT_ROUTES.filter((k) => k in TENANT))("%s", async (key) => {
    const fx = await seed();
    const before = await digestA();
    const [method, suffix] = key.split(" ");
    const row = TENANT[key];
    const path = `${fill(suffix, fx)}${row.query ?? ""}`;
    const body = method === "GET" || method === "DELETE" ? undefined : typeof row.body === "function" ? (row.body as (f: Fx) => unknown)(fx) : row.body;

    // Under A's slug: not a member — one 404 for everyone, whatever the route, role or reason.
    for (const who of OUTSIDERS) {
      const r = await send(method, `/api/o/saplinglearn${path}`, fx.cookies[who], body);
      expect([r.status, r.text], `${who} ${method} /api/o/saplinglearn${path}`).toEqual([404, NOT_FOUND]);
    }
    // Under B's slug: members reach the route, which must find nothing of A's.
    for (const who of ["bob", "boss"] as const) {
      expectClean(`${who} ${method} /api/o/acme${path}`, await send(method, `/api/o/acme${path}`, fx.cookies[who], body), row.allow);
    }
    for (const who of ["root", "gone", "nobody", "sue"] as const) {
      const r = await send(method, `/api/o/acme${path}`, fx.cookies[who], body);
      expect([r.status, r.text], `${who} ${method} /api/o/acme${path}`).toEqual([404, NOT_FOUND]);
    }
    // A suspended org answers its own members as if it were not there.
    expect((await send(method, `/api/o/cedar${path}`, fx.cookies.sue, body)).status).toBe(404);

    // The old alias: the caller's only org.
    const alias = aliasOf(key);
    if (alias) {
      const aliasPath = `${fill(alias, fx)}${row.query ?? ""}`;
      expectClean(`bob ${method} ${aliasPath}`, await send(method, aliasPath, fx.cookies.bob, body), row.allow);
      for (const who of ["root", "gone", "nobody"] as const) {
        const r = await send(method, aliasPath, fx.cookies[who], body);
        expect([r.status, r.text], `${who} ${method} ${aliasPath}`).toEqual([409, ORG_REQUIRED]);
      }
      const suspended = await send(method, aliasPath, fx.cookies.sue, body);
      expect([suspended.status, suspended.text], `sue ${method} ${aliasPath}`).toEqual([404, NOT_FOUND]);
    }

    expect(await digestA(), `${key} changed a row of org A`).toEqual(before);
  });
});

// ── the alias-only routes ────────────────────────────────────────────────────

describe("the legacy alias-only routes are org-scoped", () => {
  it.each(Object.keys(LEGACY_ONLY))("%s", async (key) => {
    const fx = await seed();
    const before = await digestA();
    const [method, pattern] = key.split(" ");
    const path = fill(pattern, fx);
    const body = method === "GET" ? undefined : LEGACY_ONLY[key].body;
    for (const who of ["bob", "boss"] as const) expectClean(`${who} ${key}`, await send(method, path, fx.cookies[who], body));
    for (const who of ["root", "gone", "nobody"] as const) {
      const r = await send(method, path, fx.cookies[who], body);
      expect([r.status, r.text], `${who} ${key}`).toEqual([409, ORG_REQUIRED]);
    }
    expect((await send(method, path, fx.cookies.sue, body)).status).toBe(404);
    expect(await digestA(), `${key} changed a row of org A`).toEqual(before);
  });

  it("B's admin invites the address A already invited: B gets its own invite, A's is neither shown, renamed nor revoked", async () => {
    const fx = await seed();
    const before = await digestA();
    const created = await send("POST", "/invites", fx.cookies.boss, { email: INVITED, name: "B's name for them" });
    expect(created.status).toBe(200); // not `invite_exists`: A's pending invite is not B's business
    expectClean("POST /invites", created);
    const listed = await send("GET", "/invites", fx.cookies.boss);
    expectClean("GET /invites", listed);
    // One row, B's own, with the name B gave and B's own mail outcome (columns of its `org_invites` row, 0047) —
    // never the name A's admin typed for the same address, which lives on A's row and A's sidecar.
    expect((JSON.parse(listed.text) as { invites: unknown[] }).invites).toEqual([
      expect.objectContaining({ email: INVITED, name: "B's name for them", invited_by: "boss", accepted_by: null, revoked_at: null, email_sent_at: expect.any(String), email_error: null }),
    ]);
    expect((await send("POST", `/invites/${encodeURIComponent(INVITED)}/resend`, fx.cookies.boss)).status).toBe(200);
    expect((await send("POST", `/invites/${encodeURIComponent(INVITED)}/revoke`, fx.cookies.boss)).status).toBe(200);
    expect(await all(env.DB, `SELECT org_id, status FROM org_invites WHERE email = ? ORDER BY org_id`, INVITED)).toEqual([
      { org_id: ORG_B, status: "revoked" }, { org_id: ORG_A, status: "pending" },
    ]);
    expect(await digestA()).toEqual(before);
    // A's admin still sees A's invite as it was — name and all.
    const mine = JSON.parse((await send("GET", "/invites", fx.ownerA)).text) as { invites: { email: string; name: string | null; revoked_at: string | null }[] };
    expect(mine.invites).toEqual([expect.objectContaining({ email: INVITED, name: `${CANARY} Invitee`, revoked_at: null })]);
  });
});

// ── the fixture is real: A's own members see the canary, and the digest sees A ─

describe("controls", () => {
  it("a member of A reads the canary through the same routes (so its absence above means something)", async () => {
    const fx = await seed();
    const seen: string[] = [];
    for (const key of TENANT_ROUTES.filter((k) => k.startsWith("GET "))) {
      const [method, suffix] = key.split(" ");
      const r = await send(method, `/api/o/saplinglearn${fill(suffix, fx)}${TENANT[key].query ?? ""}`, fx.ownerA);
      if (r.raw.includes(CANARY)) seen.push(suffix);
    }
    expect(seen).toEqual(expect.arrayContaining([
      "/img/:sha", "/docs", "/doc/:slug", "/feed", "/search", "/search/quick", "/needs-triage", "/adrs", "/proposals", "/identity-tasks",
      "/persons", "/tickets", "/tickets/:id", "/sprints", "/sprints/:id", "/artifacts", "/artifacts/:slug", "/handoffs", "/handoffs/:id",
      "/prompts", "/prompts/:slug", "/prompts/:slug/versions", "/people/:handle", "/members", "/repos", "/environments", "/me",
    ]));
    // …and at the old paths, for a person whose only org is A.
    for (const path of ["/docs", "/feed", "/tickets?seg=all", "/api/prompts", "/api/artifacts", `/api/people/${ALICE}`]) {
      expect((await send("GET", path, fx.alice)).raw, path).toContain(CANARY);
    }
  });

  it("the digest notices a write to org A", async () => {
    const fx = await seed();
    const before = await digestA();
    expect((await send("POST", `/api/o/saplinglearn/tickets/${fx.ticketId}/comment`, fx.ownerA, { body: "a real comment" })).status).toBe(200);
    const after = await digestA();
    expect(Object.keys(after).filter((t) => after[t] !== before[t])).toEqual(expect.arrayContaining(["ticket_comments", "tickets"]));
  });
});

// ── cross-org edges: B's rows must not point into A ──────────────────────────

describe("cross-org edges are refused, and nothing is written in B either", () => {
  const countB = async (table: string) => (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?`, ORG_B))!.n;

  it("a B ticket cannot join A's sprint, adopt A's ticket, or be assigned to an A-only person", async () => {
    const fx = await seed();
    const before = await digestA();
    const t = `/api/o/acme/tickets/${fx.bTicketId}`;
    const refused = [
      await send("POST", `${t}/sprint`, fx.cookies.boss, { sprint_id: fx.sprintId }),
      await send("POST", `${t}/parent`, fx.cookies.boss, { child_id: fx.ticketId }),
      await send("POST", `${t}/assignees`, fx.cookies.boss, { login: ALICE, on: true }),
      await send("POST", `/api/o/acme/tickets`, fx.cookies.boss, { title: "with an A-only assignee", assignees: [ALICE] }),
      await send("POST", `/api/o/acme/tickets`, fx.cookies.boss, { title: "in A's sprint", sprint_id: fx.sprintId }),
    ];
    for (const r of refused) { expect(r.status, r.text).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); expectClean("edge", r); }
    expect(await first(env.DB, `SELECT sprint_id, parent_id FROM tickets WHERE id = ?`, fx.bTicketId)).toEqual({ sprint_id: null, parent_id: null });
    expect(await countB("ticket_assignees")).toBe(0);
    expect(await countB("tickets")).toBe(1);
    expect(await digestA()).toEqual(before);
  });

  it("a handoff to an A-only person, a doc embedding A's image, a login mapped to an A-only person, an A-only member edited", async () => {
    const fx = await seed();
    const before = await digestA();
    await run(env.DB, `INSERT INTO identity_tasks (org_id, login, first_seen, status) VALUES (?, 'b-stranger', '2026-10-01T00:00:00Z', 'pending')`, ORG_B);
    const docsBefore = await countB("doc_versions");
    const refused = [
      await send("POST", "/api/o/acme/handoffs", fx.cookies.boss, { body: "for alice", recipient: ALICE }),
      await send("POST", "/api/o/acme/docs/propose", fx.cookies.boss, { title: "Borrowed picture", section: "reference", space: "technical", body: `![x](/img/${fx.imgSha})` }),
      await send("POST", "/api/o/acme/identity-tasks/b-stranger/map", fx.cookies.boss, { person: ALICE }),
      await send("PUT", `/api/o/acme/members/${ALICE}`, fx.cookies.boss, { title: "hijacked" }),
      await send("DELETE", `/api/o/acme/members/${ALICE}`, fx.cookies.boss),
      await send("PUT", `/api/o/acme/notifications/persons/${ALICE}`, fx.cookies.boss, { email: "hijack@x.io" }),
      await send("PUT", `/api/people/${ALICE}`, fx.cookies.boss, { role: "hijacked" }),
    ];
    for (const r of refused) { expect(r.status, r.text).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); expectClean("edge", r); }
    expect(await countB("handoffs")).toBe(0);
    expect(await countB("doc_versions")).toBe(docsBefore);
    expect(await countB("org_login_map")).toBe(0);
    expect(await first(env.DB, `SELECT status FROM identity_tasks WHERE org_id = ? AND login = 'b-stranger'`, ORG_B)).toEqual({ status: "pending" });
    expect(await digestA()).toEqual(before);
  });
});

// ── MCP tokens: a member's own, for the org in the path ──────────────────────

describe("/api/o/:slug/mcp-tokens are the caller's own tokens for that org", () => {
  type Listed = { tokens: { id: number; hint: string | null }[] };
  const list = async (slug: string, cookie: string) => (JSON.parse((await send("GET", `/api/o/${slug}/mcp-tokens`, cookie)).text) as Listed).tokens;
  const live = async (id: number) => (await first<{ revoked: number }>(env.DB, `SELECT revoked FROM mcp_tokens WHERE id = ?`, id))!.revoked === 0;

  it("bob cannot list or revoke alice's token — from outside A, from B, or as a fellow member of A", async () => {
    const fx = await seed();
    const before = await digestA();
    // Outside A: the gate's 404. Under B and at the alias: his own (empty) list, and alice's id is not found.
    expect(await send("GET", "/api/o/saplinglearn/mcp-tokens", fx.cookies.bob)).toMatchObject({ status: 404, text: NOT_FOUND });
    expect(await send("POST", `/api/o/saplinglearn/mcp-tokens/${fx.tokenId}/revoke`, fx.cookies.bob, {})).toMatchObject({ status: 404, text: NOT_FOUND });
    expect(await list("acme", fx.cookies.bob)).toEqual([]);
    for (const path of [`/api/o/acme/mcp-tokens/${fx.tokenId}/revoke`, `/auth/mcp-tokens/${fx.tokenId}/revoke`]) {
      expect(await send("POST", path, fx.cookies.bob, {}), path).toMatchObject({ status: 404, text: NOT_FOUND });
    }
    expect(JSON.parse((await send("GET", "/auth/mcp-tokens", fx.cookies.bob)).text)).toEqual({ tokens: [] });
    expect(await digestA()).toEqual(before);

    // Even as a member of A — an admin of it — another member's tokens are not his to see or revoke.
    await ensureMember("bob", "admin", ORG_A);
    expect(await list("saplinglearn", fx.cookies.bob)).toEqual([]);
    expect((await send("POST", `/api/o/saplinglearn/mcp-tokens/${fx.tokenId}/revoke`, fx.cookies.bob, {})).status).toBe(404);
    expect(await live(fx.tokenId)).toBe(true);
    expect((await list("saplinglearn", fx.alice)).map((t) => t.id)).toEqual([fx.tokenId]);
  });

  it("a token id from org A is not found under org B, for its own holder", async () => {
    const fx = await seed();
    await ensureMember(ALICE, "member", ORG_B);
    expect(await list("acme", fx.alice)).toEqual([]);
    expect((await send("POST", `/api/o/acme/mcp-tokens/${fx.tokenId}/revoke`, fx.alice, {})).status).toBe(404);
    expect(await live(fx.tokenId)).toBe(true);
    // Two orgs now: the old paths cannot pick one, and revoke nothing.
    expect(await send("POST", `/auth/mcp-tokens/${fx.tokenId}/revoke`, fx.alice, {})).toMatchObject({ status: 409, text: ORG_REQUIRED });
    expect(await live(fx.tokenId)).toBe(true);
    // A token minted under B is B's: listed there, absent from A, and revocable only through B's path.
    const minted = await send("POST", "/api/o/acme/mcp-tokens", fx.alice, {});
    expect(minted.status).toBe(200);
    const [inB] = await list("acme", fx.alice);
    expect((await list("saplinglearn", fx.alice)).map((t) => t.id)).toEqual([fx.tokenId]);
    expect((await send("POST", `/api/o/saplinglearn/mcp-tokens/${inB.id}/revoke`, fx.alice, {})).status).toBe(404);
    expect((await send("POST", `/api/o/acme/mcp-tokens/${inB.id}/revoke`, fx.alice, {})).status).toBe(200);
    expect([await live(inB.id), await live(fx.tokenId)]).toEqual([false, true]);
  });
});

// ── person-level routes: nothing of A's for a stranger ───────────────────────

describe("the person-level routes show a stranger nothing of org A", () => {
  it("bob and a person in no org read their own person-level data only", async () => {
    const fx = await seed();
    for (const who of ["bob", "nobody"] as const) {
      for (const path of ["/auth/me", "/api/orgs", "/api/invites", "/auth/mcp-tokens", "/auth/oauth-grants", `/avatar/${fx.imgSha}`]) {
        const r = await send("GET", path, fx.cookies[who]);
        expectClean(`${who} GET ${path}`, r);
        expect(r.status, `${who} GET ${path}`).toBeLessThan(500);
      }
      // The superadmin surface is closed to both…
      for (const key of Object.keys(PLATFORM).filter((k) => k.includes("/api/platform/"))) {
        const [method, pattern] = key.split(" ");
        const path = pattern.replace(":slug", "saplinglearn").replace(":handle", ALICE);
        const r = await send(method, path, fx.cookies[who], method === "GET" || method === "DELETE" ? undefined : {});
        expect([403, 404], `${who} ${key} → ${r.status}`).toContain(r.status);
        expectClean(`${who} ${key}`, r);
      }
    }
    // …and a doc image of A's is not an avatar: the bytes are not reachable through the person-level image route.
    expect((await send("GET", `/avatar/${fx.imgSha}`, fx.cookies.bob)).status).toBe(404);
  });

  it("a superadmin with no membership reads counts, never content (§5.4)", async () => {
    const fx = await seed();
    // (`/api/platform/orgs/:slug` and `/audit` are left out on purpose: they name an org's MEMBERS and audit targets — people and
    // actions, by design; the canary sits in a member's name.)
    for (const path of ["/api/platform/orgs", "/api/platform/usage"]) {
      const r = await send("GET", path, fx.cookies.root);
      expect(r.status, path).toBe(200);
      expectClean(`root GET ${path}`, r);
    }
  });
});
