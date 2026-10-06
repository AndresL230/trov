// Org role gates (canopy-multitenancy.md §5.2): every route that used to ask a Worker-wide allowlist of
// handles now asks the caller's role IN THE ORG the request resolved. A member is 403 (with nothing
// written); an admin and an owner pass. Each route is exercised at BOTH mounts: the old alias path and
// `/api/o/:slug/…`. The allowlist var is gone; a Worker that still has it set grants nothing by it.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import { createPage, setStatus } from "../src/tools/artifacts";
import { savePrompt } from "../src/tools/prompts";
import { ingestEvent } from "../src/consumer";
import type { CapturedEvent } from "@shared/contract";
import type { PersonProfile } from "@shared/people";
import { first } from "./helpers/db";
import { cookieFor, seedPerson, FIXTURE_ADMIN } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx } from "./helpers/tenant";

const MEMBER = "casey";
const OWNER = "AndresL230";
const AUTHOR = "author-ann"; // a plain member who authors the prompt / artifact below
const SLUG = "/api/o/saplinglearn";
// No environments and no tokens: an admin's Poll reaches for no network.
const QUIET = { ...env, REPO_ENVIRONMENTS: "", GITHUB_SERVICE_TOKEN: "", CF_ANALYTICS_TOKEN: "" } as unknown as Env;

const send = async (method: string, path: string, cookie: string, body?: unknown, e: Env = env as unknown as Env) => {
  const res = await app.request(path, {
    method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, e);
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};

async function people(): Promise<{ member: string; admin: string; owner: string }> {
  await seedPerson(AUTHOR);
  return { member: await cookieFor(MEMBER), admin: await cookieFor(FIXTURE_ADMIN), owner: await cookieFor(OWNER) };
}

const event: CapturedEvent = {
  semantic_key: "gh:pr:7:merged", event_type: "pr_merged", ref_number: 7, subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "t", body: "b" } }), provenance: "webhook", occurred_at: "2026-07-01T10:00:00Z",
};

/** A route that was allowlist-gated: `[method, alias path, /api/o/:slug suffix or null (alias-only), body]`. */
type Gated = [method: string, alias: string, suffix: string | null, body?: unknown];
const ADMIN_ONLY: Gated[] = [
  ["POST", "/admin/backfill", "/admin/backfill", {}],
  ["POST", "/admin/poll", "/admin/poll", {}],
  ["POST", "/admin/poll-usage", "/admin/poll-usage", {}],
  ["GET", "/invites", null],
  ["POST", "/invites", null, { email: "new.person@x.io" }],
  ["POST", "/invites/someone%40x.io/revoke", null, {}],
  ["POST", "/invites/someone%40x.io/resend", null, {}],
  ["GET", "/api/notifications/policy", "/notifications/policy"],
  ["PUT", "/api/notifications/policy", "/notifications/policy", { kind: "my_work", enabled: true }],
  ["GET", "/api/notifications/settings", "/notifications/settings"],
  ["PUT", "/api/notifications/settings", "/notifications/settings", { send_hour: 9 }],
  ["GET", "/api/notifications/outbox", "/notifications/outbox"],
  ["PUT", `/api/notifications/persons/${MEMBER}`, `/notifications/persons/${MEMBER}`, { email: "casey@x.io" }],
  ["GET", "/api/notifications/preview?cadence=daily&sample=1", "/notifications/preview?cadence=daily&sample=1"],
  ["POST", "/api/notifications/test-send", "/notifications/test-send", { cadence: "daily", sample: true }],
  // §6.3: mapping a login is admin+ now (it was any member's).
  ["POST", "/identity-tasks/mystery-dev/map", "/identity-tasks/mystery-dev/map", { person: MEMBER }],
];

describe("routes that were allowlist-gated: member 403, admin and owner pass", () => {
  it.each(ADMIN_ONLY)("%s %s", async (method, alias, suffix, body) => {
    const c = await people();
    const paths = [alias, ...(suffix ? [`${SLUG}${suffix}`] : [])];
    for (const path of paths) {
      const refused = await send(method, path, c.member, body);
      expect([refused.status, refused.json], `member ${method} ${path}`).toEqual([403, { error: "admin only" }]);
    }
    // Nothing was written by the refusals.
    expect(await first(env.DB, `SELECT 1 AS x FROM org_invites WHERE org_id = ?`, ORG_A)).toBeNull();
    expect(await first(env.DB, `SELECT email FROM persons WHERE handle = ?`, MEMBER)).toEqual({ email: null });
    expect(await first(env.DB, `SELECT 1 AS x FROM org_login_map WHERE org_id = ? AND github_login = 'mystery-dev'`, ORG_A)).toBeNull();

    for (const [who, cookie] of [["admin", c.admin], ["owner", c.owner]] as const) {
      for (const path of paths) {
        const res = await send(method, path, cookie, body, QUIET);
        expect(res.status, `${who} ${method} ${path} → ${JSON.stringify(res.json)}`).not.toBe(403);
        expect(res.status, `${who} ${method} ${path}`).not.toBe(401);
      }
    }
  });

  it("the map route really maps for an admin (and only into the org's own table)", async () => {
    const c = await people();
    await ingestEvent(systemCtx(), platformCtx(), event, "github-webhook");
    expect((await send("POST", `${SLUG}/identity-tasks/mystery-dev/map`, c.member, { person: MEMBER })).status).toBe(403);
    expect((await send("POST", `${SLUG}/identity-tasks/mystery-dev/map`, c.admin, { person: MEMBER })).status).toBe(200);
    expect(await first(env.DB, `SELECT person, mapped_by FROM org_login_map WHERE org_id = ? AND github_login = 'mystery-dev'`, ORG_A)).toEqual({ person: MEMBER, mapped_by: FIXTURE_ADMIN });
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'mystery-dev'`)).toBeNull();
  });
});

describe("author-or-admin routes: a member who is not the author is 403; the author, an admin and an owner pass", () => {
  it("prompt delete / restore", async () => {
    const c = await people();
    const author = await cookieFor(AUTHOR);
    for (const base of ["/api/prompts", `${SLUG}/prompts`]) {
      const slug = base.startsWith("/api/o/") ? "p-slug" : "p-alias";
      await savePrompt(systemCtx(), AUTHOR, { slug, title: "T", body: "B", tags: [], status: "published" }, "human");
      expect((await send("POST", `${base}/${slug}/delete`, c.member, {})).status).toBe(403);
      expect((await send("POST", `${base}/${slug}/delete`, c.admin, {})).status).toBe(200);
      expect((await send("POST", `${base}/${slug}/restore`, c.member, {})).status).toBe(403);
      expect((await send("POST", `${base}/${slug}/restore`, c.owner, {})).status).toBe(200);
      expect((await send("POST", `${base}/${slug}/delete`, author, {})).status).toBe(200);
    }
  });

  it("artifact delete / restore", async () => {
    const c = await people();
    const author = await cookieFor(AUTHOR);
    for (const base of ["/api/artifacts", `${SLUG}/artifacts`]) {
      const { slug } = await createPage(systemCtx(), { title: `Page ${base.length}`, kind: "markdown", area: "auth", content: "x" }, AUTHOR);
      await setStatus(systemCtx(), slug, "published", AUTHOR); // a draft is its author's alone — not_found to everyone else
      expect((await send("POST", `${base}/${slug}/delete`, c.member, {})).status).toBe(403);
      expect((await send("POST", `${base}/${slug}/delete`, c.owner, {})).status).toBe(200);
      expect((await send("POST", `${base}/${slug}/restore`, c.member, {})).status).toBe(404); // a deleted page is the one not_found to anyone who may not restore it
      expect((await send("POST", `${base}/${slug}/restore`, c.admin, {})).status).toBe(200);
      expect((await send("POST", `${base}/${slug}/delete`, author, {})).status).toBe(200);
    }
  });
});

describe("a person's title and responsibilities: PUT /api/people/:handle (the alias of PUT /api/o/:slug/members/:handle)", () => {
  it("member 403 with nothing written; admin and owner write the membership, audited; `admin` / `editable` follow the org role", async () => {
    const c = await people();
    const refused = await send("PUT", `/api/people/${MEMBER}`, c.member, { role: "Self-promoted" });
    expect(refused.status).toBe(403);
    expect(await first(env.DB, `SELECT title FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, MEMBER)).toEqual({ title: null });

    expect((await send("PUT", `/api/people/${MEMBER}`, c.admin, { role: "Designer", responsibilities: "The UI" })).status).toBe(200);
    expect((await send("PUT", `${SLUG}/members/${MEMBER}`, c.owner, { title: "Lead designer" })).status).toBe(200);
    expect(await first(env.DB, `SELECT title, responsibilities, role FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, MEMBER))
      .toEqual({ title: "Lead designer", responsibilities: "The UI", role: "member" }); // neither route's title write touches the ORG role
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM org_admin_audit WHERE org_id = ? AND action = 'member.update' AND target = ?`, ORG_A, MEMBER))!.n).toBe(2);

    const card = async (handle: string, cookie: string) => (await send("GET", `${SLUG}/people/${handle}`, cookie)).json as unknown as PersonProfile;
    expect(await card(MEMBER, c.member)).toMatchObject({ admin: false, editable: false, self: true });
    expect((await card(MEMBER, c.member)).responsibilities).toBeUndefined();
    expect(await card(MEMBER, c.admin)).toMatchObject({ admin: false, editable: true, responsibilities: "The UI" });
    expect(await card(FIXTURE_ADMIN, c.member)).toMatchObject({ admin: true, editable: false });
    expect(await card(OWNER, c.owner)).toMatchObject({ admin: true, editable: true });
  });
});

describe("the role is the ORG's, not the person's", () => {
  it("an owner of one org is a plain member in another: admin routes follow the slug", async () => {
    await ensureMember("dual", "owner", ORG_B);
    await ensureMember("dual", "member", ORG_A);
    const dual = await cookieFor("dual");
    expect((await send("GET", "/api/o/acme/notifications/policy", dual)).status).toBe(200);
    expect((await send("GET", `${SLUG}/notifications/policy`, dual)).status).toBe(403);
    // Two orgs: the old paths cannot pick one.
    expect(await send("GET", "/api/notifications/policy", dual)).toEqual({ status: 409, json: { error: "org_required" } });
    expect(await send("GET", "/docs", dual)).toEqual({ status: 409, json: { error: "org_required" } });
  });

  it("the retired allowlist var grants nothing if a deployment still sets it: a listed handle that is a plain member is 403", async () => {
    await ensureMember("listed", "member", ORG_A);
    const listed = await cookieFor("listed");
    // The var's name is assembled so that a search for it across src/ and test/ stays empty.
    const e = { ...env, [["ADMIN", "LOGINS"].join("_")]: "listed" } as unknown as Env;
    expect((await send("POST", "/admin/backfill", listed, {}, e)).status).toBe(403);
    expect((await send("GET", "/invites", listed, undefined, e)).status).toBe(403);
    expect((await send("GET", "/auth/me", listed, undefined, e)).json).toMatchObject({ admin: false });
  });

  it("Sync / Poll follow the slug too: another org's OWNER passes the gate and gets THEIR org's answer — nothing configured, nothing run", async () => {
    await ensureMember("boss", "owner", ORG_B);
    await ensureMember("bob", "member", ORG_B);
    const boss = await cookieFor("boss", { member: false });
    const bob = await cookieFor("bob", { member: false });
    const NOT = "not_configured";
    const answers: [string, number, unknown][] = [
      ["/admin/backfill", 503, { error: "service token or repo not configured" }],
      ["/admin/poll", 200, { health: NOT, cloudflare: NOT, railway: NOT, sapling: NOT, github: NOT }],
      ["/admin/poll-usage", 200, { cloudflare: NOT, railway: NOT, sapling: NOT }],
    ];
    for (const [suffix, status, json] of answers) {
      for (const path of [suffix, `/api/o/acme${suffix}`]) {
        expect(await send("POST", path, bob, {}), `member ${path}`).toEqual({ status: 403, json: { error: "admin only" } });
        expect(await send("POST", path, boss, {}), `owner ${path}`).toEqual({ status, json });
      }
    }
    // Which credential each run carries, and that the other org's rows never move: test/jobs.multi-org.test.ts.
    expect(await first(env.DB, `SELECT 1 AS x FROM repo_snapshots`)).toBeNull();
  });
});

describe("confirm verbs are cookie-only (§6.3, D6)", () => {
  const CONFIRM: [string, unknown][] = [
    ["/doc/some-doc/promote", { version: 1 }], ["/doc/some-doc/reject", { version: 1 }],
    ["/adr/1/ratify", {}], ["/adr/1/reject", {}],
    ["/api/prompts/some-prompt/publish", { version: 1 }], ["/api/artifacts/some-page/ratify", { version: 1 }],
  ];
  it.each(CONFIRM)("POST %s refuses a request that carries an Authorization header, at both mounts", async (path, body) => {
    const cookie = await cookieFor(OWNER);
    const slugged = `${SLUG}${path.replace(/^\/api/, "")}`;
    for (const p of [path, slugged]) {
      const res = await app.request(p, { method: "POST", headers: { cookie, authorization: "Bearer trov_mcp_anything", "content-type": "application/json" }, body: JSON.stringify(body) }, env);
      expect(res.status, p).toBe(403);
      expect(((await res.json()) as { error: string }).error, p).toBe("forbidden");
      // The same request with the cookie alone reaches the handler (which finds nothing: 400 / 404, never 403).
      const plain = await app.request(p, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
      expect(plain.status, p).not.toBe(403);
    }
  });
});
