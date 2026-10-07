// The organization's image (0042_organizations; the contract is shared/orgs.ts, the code src/orgs/logo.ts):
//   • POST /api/o/:slug/logo[/remove] — who may, what is refused, what is audited, the daily limit;
//   • GET /org-logo/<sha> — the headers, and who can load it (a non-member invitee, the superadmin);
//   • `logo_url` on every answer that carries an org;
//   • the GitHub import — every transition of THE rule (an upload is never replaced), the host
//     allowlist, no redirect followed, no credential in a log line, and isolation between two orgs.
// Real D1 + local R2 through the real Hono app; GitHub is a stubbed `fetch`, never the network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/tools/artifacts";
import { setSecret } from "../src/data/secrets";
import { importOrgLogo, checkAvatarUrl, orgLogoKey, LOGO_IMPORT_COST, type LogoImport } from "../src/orgs/logo";
import { importLogoForOrg } from "../src/integrations/logo";
import { runOrgJob, reconcileCost } from "../src/repo/cron";
import { LIMITS } from "../src/platform/limits";
import { ORG_LOGO_MAX_BYTES, type MyOrgsResponse, type OrgLogoResponse, type OrgMeResponse, type OrgSettings, type PlatformOrgDetail, type PlatformOrgRow, type PlatformUsageResponse } from "@shared/orgs";
import { cookieFor } from "./helpers/persons";
import { bearerCtx, ensureMember, platformCtx, systemCtx, tenantCtx, ORG_A, ORG_B } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";

const e = env as unknown as Env;

// Minimal images: only the magic bytes are sniffed, the rest is padding (test/people.test.ts).
const PNG = (seed = "a") => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`org-png-${seed}`)]);
const JPEG = (seed = "a") => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`org-jpeg-${seed}`)]);
const SVG = () => new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

/** Acme (org B): an owner, an admin and a member — none of them in SaplingLearn. */
async function acme() {
  await ensureMember("olive", "owner", ORG_B);
  await ensureMember("adam", "admin", ORG_B);
  await ensureMember("mia", "member", ORG_B);
  const c = (h: string) => cookieFor(h, { member: false });
  return { owner: await c("olive"), admin: await c("adam"), member: await c("mia") };
}

async function upload(slug: string, cookie: string, bytes: Uint8Array, type: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], "logo.img", { type }));
  const res = await app.request(`/api/o/${slug}/logo`, { method: "POST", headers: { cookie, ...headers }, body: form }, env);
  return { status: res.status, json: (await res.json().catch(() => null)) as OrgLogoResponse & { error?: string; message?: string }, res };
}
const remove = (slug: string, cookie: string, headers: Record<string, string> = {}) =>
  call<OrgLogoResponse & { error?: string }>("POST", `/api/o/${slug}/logo/remove`, cookie, undefined, { headers });

interface LogoCols { logo_sha: string | null; logo_source: string | null; logo_by: string | null; logo_from: string | null; logo_at: string | null }
const cols = async (orgId: string) => (await one<LogoCols>(`SELECT logo_sha, logo_source, logo_by, logo_from, logo_at FROM orgs WHERE id = ?`, orgId))!;
const NONE: LogoCols = { logo_sha: null, logo_source: null, logo_by: null, logo_from: null, logo_at: null };
const audit = (orgId: string) => rows<{ actor: string; action: string; target: string; detail: string }>(
  `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? AND action LIKE 'org.logo.%' ORDER BY id`, orgId);
const fill = (subject: string) => exec(`INSERT OR REPLACE INTO abuse_counters (subject, action, bucket, count, last_at) VALUES (?, 'org_logo_upload', ?, ?, ?)`,
  subject, new Date().toISOString().slice(0, 10), LIMITS.org_logo_upload.max, new Date().toISOString());
const spent = async (subject: string) => (await one<{ count: number }>(`SELECT count FROM abuse_counters WHERE subject = ? AND action = 'org_logo_upload'`, subject))?.count ?? 0;

// ── a stubbed GitHub ─────────────────────────────────────────────────────────
interface Seen { url: string; auth: string | null; redirect: string | undefined }
interface Github {
  /** `GET api.github.com/users/<owner>`; default: 200 with `avatar` as its `avatar_url`. */
  user?: (owner: string, auth: string | null) => Response | Promise<Response>;
  /** The profile's `avatar_url` (default: GitHub's avatar host). */
  avatarUrl?: string;
  /** The avatar's response (default: 200, `bytes`). */
  avatar?: (url: URL) => Response | Promise<Response>;
  bytes?: Uint8Array;
}
const AVATAR = "https://avatars.githubusercontent.com/u/4242?v=4";
function github(g: Github = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url: url.toString(), auth, redirect: init?.redirect });
    if (url.origin === "https://api.github.com" && url.pathname.startsWith("/users/")) {
      const owner = url.pathname.slice("/users/".length);
      return g.user ? g.user(owner, auth) : Response.json({ login: owner, avatar_url: g.avatarUrl ?? AVATAR });
    }
    if (url.hostname === "avatars.githubusercontent.com") {
      return g.avatar ? g.avatar(url) : new Response(g.bytes ?? PNG("gh"), { headers: { "content-type": "image/png" } });
    }
    return new Response("not found", { status: 404 }); // the reconcile's own reads, and anything unexpected
  }) as typeof fetch;
  return { seen, fetchImpl, logoCalls: () => seen.filter((s) => s.url.includes("/users/") || s.url.includes("avatars.")) };
}
const importB = (g: ReturnType<typeof github>, o: { repo?: string | null; token?: string | null } = {}): Promise<LogoImport> =>
  importOrgLogo(platformCtx("system"), env.ARTIFACTS_BUCKET, ORG_B, { repo: o.repo === undefined ? "acme-co/widgets" : o.repo, token: o.token, fetchImpl: g.fetchImpl });

/** Every console channel, captured for the duration of `fn` (test/jobs.multi-org.test.ts). */
async function captured<T>(fn: () => Promise<T>): Promise<{ out: T; logged: string }> {
  const spies = (["error", "warn", "log", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  try {
    const out = await fn();
    return { out, logged: JSON.stringify(spies.flatMap((s) => s.mock.calls).map((c) => c.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a)))) };
  } finally { for (const s of spies) s.mockRestore(); }
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── upload / remove ──────────────────────────────────────────────────────────

describe("POST /api/o/:slug/logo", () => {
  it("an owner's PNG is stored at org-logos/<sha256> with its type and becomes the org's image, audited", async () => {
    const { owner } = await acme();
    const bytes = PNG("owner");
    const sha = await sha256Hex(bytes);
    const r = await upload("acme", owner, bytes, "image/png");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, logo: { url: `/org-logo/${sha}`, source: "upload", by: "olive", from: null, at: expect.any(String) } });
    expect(await cols(ORG_B)).toEqual({ logo_sha: sha, logo_source: "upload", logo_by: "olive", logo_from: null, logo_at: r.json.logo.at });
    const obj = await env.ARTIFACTS_BUCKET.get(orgLogoKey(sha));
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    expect(await audit(ORG_B)).toEqual([{ actor: "olive", action: "org.logo.set", target: "logo", detail: JSON.stringify({ sha, type: "image/png", bytes: bytes.byteLength }) }]);
    expect(await cols(ORG_A)).toEqual(NONE); // the other org's row is untouched
  });

  it("an admin may too; a member is 403 and spends nothing; a non-member is 404; no session is 401", async () => {
    const { admin, member } = await acme();
    expect((await upload("acme", admin, JPEG(), "image/jpeg")).json.logo).toMatchObject({ source: "upload", by: "adam" });
    const before = await cols(ORG_B);

    const refused = await upload("acme", member, PNG("member"), "image/png");
    expect([refused.status, refused.json.error]).toEqual([403, "forbidden"]);
    expect(await spent("mia")).toBe(0);
    expect((await remove("acme", member)).status).toBe(403);

    const outsider = await cookieFor("outsider", { member: false });
    expect((await upload("acme", outsider, PNG(), "image/png")).status).toBe(404);
    expect((await remove("acme", outsider)).status).toBe(404);
    expect((await upload("nope", admin, PNG(), "image/png")).status).toBe(404);
    expect((await upload("acme", "", PNG(), "image/png")).status).toBe(401);
    // A SaplingLearn admin is nobody in Acme.
    expect((await upload("acme", await cookieFor("admin-user"), PNG(), "image/png")).status).toBe(404);
    expect(await cols(ORG_B)).toEqual(before);
    expect((await audit(ORG_B)).map((a) => a.action)).toEqual(["org.logo.set"]);
  });

  it("refuses a request that carries an Authorization header — upload and removal", async () => {
    const { owner } = await acme();
    const bearer = { authorization: "Bearer trov_mcp_anything" };
    const up = await upload("acme", owner, PNG(), "image/png", bearer);
    expect([up.status, up.json.error]).toEqual([403, "forbidden"]);
    expect((await remove("acme", owner, bearer)).status).toBe(403);
    expect(await cols(ORG_B)).toEqual(NONE);
  });

  it("refuses a type off the allowlist (SVG), bytes that are not the declared type, an empty or missing file, and a non-multipart body", async () => {
    const { owner } = await acme();
    for (const [bytes, type] of [
      [SVG(), "image/svg+xml"],          // not on the allowlist
      [SVG(), "image/png"],              // an SVG wearing a PNG's type
      [PNG(), "image/jpeg"],             // a real PNG, declared as something else
      [new TextEncoder().encode("<html><script>alert(1)</script></html>"), "image/gif"],
      [new Uint8Array(), "image/png"],
    ] as const) {
      const r = await upload("acme", owner, bytes as Uint8Array, type);
      expect([r.status, r.json.error], type).toEqual([400, "invalid_image"]);
    }
    const noFile = new FormData();
    noFile.append("other", "x");
    expect((await app.request("/api/o/acme/logo", { method: "POST", headers: { cookie: owner }, body: noFile }, env)).status).toBe(400);
    expect((await app.request("/api/o/acme/logo", { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: "{}" }, env)).status).toBe(400);
    expect(await cols(ORG_B)).toEqual(NONE);
    expect(await audit(ORG_B)).toEqual([]);
  });

  it("refuses an oversized image — by its declared length before the body is read, and by its bytes", async () => {
    const { owner } = await acme();
    const declared = await app.request("/api/o/acme/logo", { method: "POST", headers: { cookie: owner, "content-length": String(ORG_LOGO_MAX_BYTES + 65 * 1024) }, body: "x" }, env);
    expect(declared.status).toBe(413);
    expect(await spent("olive")).toBe(0); // refused before the allowance is taken
    const big = new Uint8Array(ORG_LOGO_MAX_BYTES + 1);
    big.set(PNG());
    const r = await upload("acme", owner, big, "image/png");
    expect([r.status, r.json.error]).toEqual([413, "too_large"]);
    expect(await cols(ORG_B)).toEqual(NONE);
  });

  it("is limited per PERSON per day: the 21st upload is 429 with a retry-after, and writes nothing", async () => {
    const { admin } = await acme();
    expect((await upload("acme", admin, PNG("one"), "image/png")).status).toBe(200);
    expect(await spent("adam")).toBe(1);
    await fill("adam");
    const before = await cols(ORG_B);
    const limited = await upload("acme", admin, PNG("two"), "image/png");
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited", retry_after: expect.any(Number) });
    expect(limited.res.headers.get("retry-after")).toBe(String((limited.json as unknown as { retry_after: number }).retry_after));
    expect(await cols(ORG_B)).toEqual(before);
    // The allowance is the person's, not the org's: another admin of the same org still uploads.
    expect((await upload("acme", await cookieFor("olive", { member: false }), PNG("three"), "image/png")).status).toBe(200);
  });
});

describe("POST /api/o/:slug/logo/remove", () => {
  it("removes an uploaded image — audited, the bytes stay in R2 — and an org with no repository falls back to the initial tile", async () => {
    const { owner, admin } = await acme();
    const sha = (await upload("acme", owner, PNG("rm"), "image/png")).json.logo.url!.slice("/org-logo/".length);
    const called = vi.fn();
    vi.stubGlobal("fetch", called);
    const r = await remove("acme", admin);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, logo: { url: null, source: null, by: null, from: null, at: null } });
    expect(called).not.toHaveBeenCalled(); // no repository: nothing is asked of GitHub
    expect(await cols(ORG_B)).toEqual(NONE);
    expect(await env.ARTIFACTS_BUCKET.head(orgLogoKey(sha))).not.toBeNull();
    expect((await audit(ORG_B)).map((a) => [a.actor, a.action, a.detail])).toEqual([
      ["olive", "org.logo.set", expect.any(String)], ["adam", "org.logo.remove", JSON.stringify({ sha })],
    ]);
  });

  it("with a repository connected, removing the upload brings GitHub's image back at once", async () => {
    const { owner } = await acme();
    await addOrgRepo("acme-co/widgets", ORG_B);
    await upload("acme", owner, PNG("mine"), "image/png");
    const g = github({ bytes: PNG("octo") });
    vi.stubGlobal("fetch", g.fetchImpl);
    const r = await remove("acme", owner);
    const sha = await sha256Hex(PNG("octo"));
    expect(r.json.logo).toEqual({ url: `/org-logo/${sha}`, source: "github", by: null, from: "acme-co", at: expect.any(String) });
    expect(g.seen.map((s) => s.url)).toEqual(["https://api.github.com/users/acme-co", `${AVATAR}&s=512`]);
  });

  it("GitHub failing does not fail the removal: the org simply has no image", async () => {
    const { owner } = await acme();
    await addOrgRepo("acme-co/widgets", ORG_B);
    await upload("acme", owner, PNG("mine"), "image/png");
    vi.stubGlobal("fetch", (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch);
    const { out: r } = await captured(() => remove("acme", owner));
    expect(r.status).toBe(200);
    expect(r.json.logo.url).toBeNull();
    expect(await cols(ORG_B)).toEqual(NONE);
  });

  it("leaves an imported image, and an org with none, as they are — nothing audited", async () => {
    const { owner } = await acme();
    expect((await remove("acme", owner)).json).toEqual({ ok: true, logo: { url: null, source: null, by: null, from: null, at: null } });
    expect((await importB(github())).status).toBe("imported");
    const imported = await cols(ORG_B);
    const called = vi.fn();
    vi.stubGlobal("fetch", called);
    const r = await remove("acme", owner);
    expect(r.json.logo).toMatchObject({ source: "github", from: "acme-co" });
    expect(await cols(ORG_B)).toEqual(imported);
    expect(called).not.toHaveBeenCalled();
    expect((await audit(ORG_B)).map((a) => a.action)).toEqual(["org.logo.import"]);
  });
});

// ── serving ──────────────────────────────────────────────────────────────────

describe("GET /org-logo/<sha>", () => {
  const get = (path: string, cookie: string) => app.request(path, { headers: cookie ? { cookie } : {} }, env);

  it("serves the stored bytes with the stored type, immutable caching and the lock-down headers — whatever the request says", async () => {
    const { owner, member } = await acme();
    const bytes = JPEG("serve");
    const { url } = (await upload("acme", owner, bytes, "image/jpeg")).json.logo;
    const res = await app.request(`${url}?type=text/html`, { headers: { cookie: member, accept: "text/html" } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("location")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("an invitee who is not a member, and the superadmin who is in no org of it, can load it; a signed-out request cannot", async () => {
    const { owner, admin } = await acme();
    const { url } = (await upload("acme", owner, PNG("invitee"), "image/png")).json.logo;

    // The invitee: sees Acme's name and image in their invitations (GET /api/orgs), and is in no org at all.
    const invitee = await cookieFor("newcomer", { member: false });
    expect((await call("POST", "/api/o/acme/invites", admin, { github_login: "newcomer" })).status).toBe(201);
    const mine = await call<MyOrgsResponse>("GET", "/api/orgs", invitee);
    expect(mine.json.orgs).toEqual([]);
    expect(mine.json.invites.map((i) => i.org)).toEqual([{ slug: "acme", name: "Acme", logo_url: url }]);
    expect((await call("GET", "/api/o/acme/settings", invitee)).status).toBe(404); // still a stranger to the org itself
    expect((await get(url!, invitee)).status).toBe(200);

    // The superadmin: not a member of Acme, sees it in Platform.
    const boss = await cookieFor(SUPERADMIN);
    expect((await call("GET", "/api/o/acme/me", boss)).status).toBe(404);
    const list = await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", boss);
    expect(list.json.orgs.find((o) => o.slug === "acme")?.logo_url).toBe(url);
    expect((await get(url!, boss)).status).toBe(200);

    expect((await get(url!, "")).status).toBe(401);
  });

  it("an unknown or malformed sha is 404 with the lock-down headers, and only an org image is served here", async () => {
    const cookie = await cookieFor("viewer");
    for (const sha of ["a".repeat(64), "A".repeat(64), "abc", "..%2Favatars%2Fx"]) {
      const res = await get(`/org-logo/${sha}`, cookie);
      expect(res.status, sha).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // A person's avatar is not an org image, and an org image is not an avatar: the two prefixes never cross.
    const form = new FormData();
    const mine = PNG("a-person");
    form.append("file", new File([mine], "me.png", { type: "image/png" }));
    expect((await app.request("/api/people/me/avatar", { method: "POST", headers: { cookie }, body: form }, env)).status).toBe(200);
    const personSha = await sha256Hex(mine);
    expect((await get(`/avatar/${personSha}`, cookie)).status).toBe(200);
    expect((await get(`/org-logo/${personSha}`, cookie)).status).toBe(404);
    const { owner } = await acme();
    const orgUrl = (await upload("acme", owner, PNG("an-org"), "image/png")).json.logo.url!;
    expect((await get(orgUrl.replace("/org-logo/", "/avatar/"), cookie)).status).toBe(404);
  });
});

// ── the API shape ────────────────────────────────────────────────────────────

describe("every answer that carries an org carries its image", () => {
  it("/auth/me, GET /api/orgs, /me, /settings and Platform's list, detail and usage", async () => {
    await acme();
    await ensureMember(SUPERADMIN, "owner", ORG_B);
    const boss = await cookieFor(SUPERADMIN);
    const url = (await upload("acme", boss, PNG("shape"), "image/png")).json.logo.url!;
    const logoOf = (list: { slug: string; logo_url?: string | null }[]) => Object.fromEntries(list.map((o) => [o.slug, o.logo_url]));
    const both = { acme: url, saplinglearn: null };

    expect(logoOf((await call<{ orgs: { slug: string; logo_url: string | null }[] }>("GET", "/auth/me", boss)).json.orgs)).toEqual(both);
    expect(logoOf((await call<MyOrgsResponse>("GET", "/api/orgs", boss)).json.orgs)).toEqual(both);
    expect((await call<OrgMeResponse>("GET", "/api/o/acme/me", boss)).json.org).toEqual({ slug: "acme", name: "Acme", logo_url: url });
    expect((await call<OrgMeResponse>("GET", "/api/o/saplinglearn/me", boss)).json.org.logo_url).toBeNull();
    const settings = (await call<{ org: OrgSettings }>("GET", "/api/o/acme/settings", boss)).json.org;
    expect(settings.logo).toEqual({ url, source: "upload", by: SUPERADMIN, from: null, at: expect.any(String) });
    // A plain member reads the same image and provenance (General shows it; only the control is an admin's).
    expect((await call<{ org: OrgSettings; can_edit: boolean }>("GET", "/api/o/acme/settings", await cookieFor("mia", { member: false }))).json)
      .toMatchObject({ can_edit: false, org: { logo: { url, source: "upload" } } });

    expect(logoOf((await call<{ orgs: PlatformOrgRow[] }>("GET", "/api/platform/orgs", boss)).json.orgs)).toEqual(both);
    const detail = (await call<PlatformOrgDetail>("GET", "/api/platform/orgs/acme", boss)).json;
    expect([detail.org.logo_url, detail.usage.logo_url]).toEqual([url, url]);
    expect(logoOf((await call<PlatformUsageResponse>("GET", "/api/platform/usage", boss)).json.orgs)).toEqual(both);
  });
});

// ── the GitHub import ────────────────────────────────────────────────────────

describe("the avatar URL the import will fetch", () => {
  it("is https on GitHub's avatar host, with the size pinned — and nothing else", () => {
    expect(checkAvatarUrl(AVATAR)?.toString()).toBe(`${AVATAR}&s=512`);
    expect(checkAvatarUrl("https://avatars.githubusercontent.com/u/1?s=4000&v=4")?.searchParams.get("s")).toBe("512");
    for (const bad of [
      "http://avatars.githubusercontent.com/u/1", "https://avatars.githubusercontent.com.evil.test/u/1", "https://evil.test/avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com:8443/u/1", "https://user:pw@avatars.githubusercontent.com/u/1", "https://github.com/u/1.png",
      "https://169.254.169.254/latest/meta-data", "//avatars.githubusercontent.com/u/1", "javascript:alert(1)", "", null, undefined, 42,
    ]) expect(checkAvatarUrl(bad), String(bad)).toBeNull();
  });
});

describe("importOrgLogo — the rule: an upload is never replaced", () => {
  it("none → github: the primary repository owner's avatar becomes the image, fetched with the token on the lookup ONLY, no redirect followed", async () => {
    const g = github({ bytes: PNG("first") });
    expect(await importB(g, { token: "ghp_orgtoken_0123456789" })).toEqual({ status: "imported" });
    const sha = await sha256Hex(PNG("first"));
    expect(await cols(ORG_B)).toEqual({ logo_sha: sha, logo_source: "github", logo_by: null, logo_from: "acme-co", logo_at: expect.any(String) });
    expect((await env.ARTIFACTS_BUCKET.get(orgLogoKey(sha)))?.httpMetadata?.contentType).toBe("image/png");
    expect(g.seen).toEqual([
      { url: "https://api.github.com/users/acme-co", auth: "Bearer ghp_orgtoken_0123456789", redirect: "manual" },
      { url: `${AVATAR}&s=512`, auth: null, redirect: "manual" }, // the avatar host never sees the token
    ]);
    expect(await audit(ORG_B)).toEqual([{ actor: "system", action: "org.logo.import", target: "logo", detail: JSON.stringify({ sha, from: "acme-co" }) }]);
    expect(await cols(ORG_A)).toEqual(NONE);
  });

  it("with no token the lookup is unauthenticated", async () => {
    const g = github();
    expect((await importB(g)).status).toBe("imported");
    expect(g.seen.map((s) => s.auth)).toEqual([null, null]);
  });

  it("a 401 on the lookup (a dead token) is retried once without it", async () => {
    const g = github({ user: (owner, auth) => (auth ? new Response("bad credentials", { status: 401 }) : Response.json({ login: owner, avatar_url: AVATAR })) });
    expect((await importB(g, { token: "ghp_dead_0123456789abcdef" })).status).toBe("imported");
    expect(g.seen.map((s) => s.auth)).toEqual(["Bearer ghp_dead_0123456789abcdef", null, null]);
    expect(g.seen.length).toBeLessThanOrEqual(LOGO_IMPORT_COST);
  });

  it("github → github: a changed avatar refreshes the image; the same avatar writes nothing", async () => {
    await importB(github({ bytes: PNG("v1") }));
    const v1 = await cols(ORG_B);
    expect(await importB(github({ bytes: PNG("v1") }))).toEqual({ status: "unchanged" });
    expect(await cols(ORG_B)).toEqual(v1);
    expect(await importB(github({ bytes: JPEG("v2") }))).toEqual({ status: "imported" });
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(JPEG("v2")), logo_source: "github" });
    expect((await audit(ORG_B)).map((a) => a.action)).toEqual(["org.logo.import", "org.logo.import"]);
  });

  it("github → github: a new primary repository's owner replaces the imported image", async () => {
    await importB(github({ bytes: PNG("old-owner") }));
    expect((await importB(github({ bytes: PNG("new-owner") }), { repo: "Other-Org/site" })).status).toBe("imported");
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("new-owner")), logo_from: "Other-Org" });
  });

  it("upload → the import is skipped before anything is fetched", async () => {
    const { owner } = await acme();
    await upload("acme", owner, PNG("uploaded"), "image/png");
    const before = await cols(ORG_B);
    const g = github({ bytes: PNG("octo") });
    expect(await importB(g, { token: "ghp_orgtoken_0123456789" })).toEqual({ status: "kept_upload" });
    expect(g.seen).toEqual([]);
    expect(await cols(ORG_B)).toEqual(before);
    expect((await audit(ORG_B)).map((a) => a.action)).toEqual(["org.logo.set"]);
  });

  it("an upload that lands while the avatar is in flight still wins (the UPDATE re-checks the rule)", async () => {
    const { owner } = await acme();
    const g = github({ avatar: async () => { await upload("acme", owner, PNG("raced"), "image/png"); return new Response(PNG("octo")); } });
    expect(await importB(g)).toEqual({ status: "kept_upload" });
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("raced")), logo_source: "upload", logo_by: "olive" });
    expect((await audit(ORG_B)).map((a) => a.action)).toEqual(["org.logo.set"]); // no import row for an import that did not take
  });

  it("upload removed → github on the next import", async () => {
    const { owner } = await acme();
    await upload("acme", owner, PNG("uploaded"), "image/png");
    expect((await importB(github())).status).toBe("kept_upload");
    expect((await remove("acme", owner)).json.logo.url).toBeNull(); // no repository row: nothing imported by the route
    expect((await importB(github({ bytes: PNG("back") }))).status).toBe("imported");
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("back")), logo_source: "github", logo_by: null });
  });

  it("an imported image replaced by an upload stays the upload, import after import", async () => {
    const { owner } = await acme();
    await importB(github({ bytes: PNG("octo") }));
    await upload("acme", owner, PNG("ours"), "image/png");
    for (let i = 0; i < 2; i++) expect((await importB(github({ bytes: PNG(`octo-${i}`) }))).status).toBe("kept_upload");
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("ours")), logo_source: "upload", logo_from: null });
  });

  it("no repository: nothing is imported, nothing is fetched — and a repository disconnected later keeps the image already imported", async () => {
    const g = github();
    expect(await importB(g, { repo: null })).toEqual({ status: "no_repo" });
    expect(g.seen).toEqual([]);
    expect(await cols(ORG_B)).toEqual(NONE);

    await importB(github({ bytes: PNG("kept") }));
    const imported = await cols(ORG_B);
    const after = github();
    expect(await importB(after, { repo: null })).toEqual({ status: "no_repo" }); // the repository is gone
    expect(after.seen).toEqual([]);
    expect(await cols(ORG_B)).toEqual(imported);
  });

  it("a failing, oversized, non-image, wrong-host or redirecting answer changes nothing — over no image and over an imported one", async () => {
    const big = new Uint8Array(ORG_LOGO_MAX_BYTES + 1);
    big.set(PNG());
    const cases: Record<string, Github> = {
      "owner lookup 404": { user: () => new Response("{}", { status: 404 }) },
      "owner lookup 500": { user: () => new Response("boom", { status: 500 }) },
      "owner lookup 403 (rate limited)": { user: () => new Response("rate limit", { status: 403 }) },
      "owner lookup redirects": { user: () => new Response(null, { status: 302, headers: { location: "https://evil.test/users/x" } }) },
      "owner lookup is not JSON": { user: () => new Response("<html>") },
      "no avatar_url": { user: (owner) => Response.json({ login: owner }) },
      "avatar on another host": { avatarUrl: "https://evil.test/a.png" },
      "avatar on a look-alike host": { avatarUrl: "https://avatars.githubusercontent.com.evil.test/u/1" },
      "avatar over http": { avatarUrl: "http://avatars.githubusercontent.com/u/1" },
      "avatar 404": { avatar: () => new Response("nope", { status: 404 }) },
      "avatar redirects elsewhere": { avatar: () => new Response(null, { status: 302, headers: { location: "https://evil.test/a.png" } }) },
      "avatar too large (declared)": { avatar: () => new Response(PNG(), { headers: { "content-length": String(ORG_LOGO_MAX_BYTES + 1) } }) },
      "avatar too large (streamed, no length)": { avatar: () => new Response(new ReadableStream({ start(c) { c.enqueue(big.slice(0, big.length / 2)); c.enqueue(big.slice(big.length / 2)); c.close(); } })) },
      "avatar is HTML": { avatar: () => new Response("<html><script>alert(1)</script></html>", { headers: { "content-type": "image/png" } }) },
      "avatar is SVG": { avatar: () => new Response(SVG(), { headers: { "content-type": "image/svg+xml" } }) },
      "avatar is empty": { avatar: () => new Response(new Uint8Array()) },
      "the fetch throws": { user: () => { throw new Error("connection reset"); } },
      "the fetch times out": { avatar: () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } },
    };
    for (const seeded of [false, true]) {
      if (seeded) await importB(github({ bytes: PNG("good") }));
      const before = await cols(ORG_B);
      const auditBefore = await audit(ORG_B);
      for (const [name, g] of Object.entries(cases)) {
        const stub = github(g);
        const { out } = await captured(() => importB(stub, { token: "ghp_orgtoken_0123456789" }));
        expect(out.status, name).toBe("failed");
        expect(await cols(ORG_B), name).toEqual(before);
        // Nothing but GitHub's API and its avatar host was ever asked — a redirect's target least of all.
        for (const s of stub.seen) expect(["api.github.com", "avatars.githubusercontent.com"], `${name}: ${s.url}`).toContain(new URL(s.url).hostname);
      }
      expect(await audit(ORG_B)).toEqual(auditBefore);
    }
  });

  it("no log line carries the token — not from an upstream that echoes the request, nor from a fetch that throws it back", async () => {
    const TOKEN = "ghp_SECRET_org_token_0123456789abcdef";
    const echo = (auth: string | null) => `you sent authorization: ${auth}`;
    const cases: Github[] = [
      { user: (_o, auth) => new Response(echo(auth), { status: 500 }) },
      { user: (_o, auth) => new Response(echo(auth), { status: 403 }) },
      { user: (_o, auth) => Response.json({ login: `x ${auth}`, avatar_url: `https://evil.test/?leak=${auth}`, message: echo(auth) }) },
      { user: (_o, auth) => { throw new Error(`fetch failed: request headers {"authorization":"${auth}"}`); } },
      { user: (_o, auth) => new Response(`{"broken": "${auth}`) },
      { avatar: () => { throw new Error(`fetch failed with Bearer ${TOKEN}`); } },
    ];
    for (const g of cases) {
      const { out, logged } = await captured(() => importB(github(g), { token: TOKEN }));
      expect(out.status).toBe("failed");
      expect(logged).toContain("org logo import"); // the failure IS logged…
      expect(logged).not.toContain(TOKEN);         // …without the credential
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }
    expect(await cols(ORG_B)).toEqual(NONE);
  });
});

describe("importLogoForOrg — the org's own repository and token", () => {
  it("imports for ONE org with ITS repository and ITS token; the other org's row, token and repository are never touched", async () => {
    await addOrgRepo("SaplingLearn/sapling", ORG_A);
    await addOrgRepo("acme-co/widgets", ORG_B);
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", "ghp_sapling_token_0123456789");
    await setSecret(await tenantCtx("olive", "owner", { orgId: ORG_B }), "github_token", "", "ghp_acme_token_0123456789ab");

    const g = github({ bytes: PNG("acme-only") });
    expect((await importLogoForOrg(e, platformCtx("system"), systemCtx(ORG_B), { fetchImpl: g.fetchImpl })).status).toBe("imported");
    expect(g.seen[0]).toMatchObject({ url: "https://api.github.com/users/acme-co", auth: "Bearer ghp_acme_token_0123456789ab" });
    expect(JSON.stringify(g.seen)).not.toContain("sapling");
    expect(await cols(ORG_B)).toMatchObject({ logo_source: "github", logo_from: "acme-co" });
    expect(await cols(ORG_A)).toEqual(NONE);
    expect(await audit(ORG_A)).toEqual([]);

    // …and the other way round, A's import leaves B's image alone.
    const before = await cols(ORG_B);
    const ga = github({ bytes: PNG("sapling-only") });
    expect((await importLogoForOrg(e, platformCtx("system"), await tenantCtx("AndresL230"), { fetchImpl: ga.fetchImpl })).status).toBe("imported");
    expect(ga.seen[0]).toMatchObject({ url: "https://api.github.com/users/SaplingLearn", auth: "Bearer ghp_sapling_token_0123456789" });
    expect(await cols(ORG_A)).toMatchObject({ logo_sha: await sha256Hex(PNG("sapling-only")), logo_from: "SaplingLearn" });
    expect(await cols(ORG_B)).toEqual(before);
  });

  it("an org with no repository asks nothing; a bearer context is refused", async () => {
    const g = github();
    expect(await importLogoForOrg(e, platformCtx("system"), systemCtx(ORG_B), { fetchImpl: g.fetchImpl })).toEqual({ status: "no_repo" });
    await addOrgRepo("SaplingLearn/sapling", ORG_A);
    const { out } = await captured(async () => importLogoForOrg(e, platformCtx("system"), await bearerCtx("AndresL230"), { fetchImpl: g.fetchImpl }));
    expect(out.status).toBe("failed");
    expect(g.seen).toEqual([]);
    expect(await cols(ORG_A)).toEqual(NONE);
  });
});

describe("when the import runs", () => {
  /** One JSON request with a real ExecutionContext; resolves once everything it left for later is done. */
  async function later(method: string, path: string, cookie: string, body: unknown): Promise<number> {
    const ctx = createExecutionContext();
    const res = await app.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env, ctx);
    await waitOnExecutionContext(ctx);
    return res.status;
  }

  it("connecting a repository imports its owner's avatar after the response — unauthenticated, the org having no token", async () => {
    const { admin } = await acme();
    const g = github({ bytes: PNG("on-connect") });
    vi.stubGlobal("fetch", g.fetchImpl);
    expect(await later("POST", "/api/o/acme/repos", admin, { repo_full_name: "acme-co/widgets" })).toBe(201);
    expect(g.logoCalls()).toEqual([
      { url: "https://api.github.com/users/acme-co", auth: null, redirect: "manual" }, { url: `${AVATAR}&s=512`, auth: null, redirect: "manual" },
    ]);
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("on-connect")), logo_source: "github", logo_from: "acme-co" });
    expect((await audit(ORG_B)).map((a) => [a.actor, a.action])).toEqual([["adam", "org.logo.import"]]);
  });

  it("making another repository the primary re-imports from ITS owner; a failing GitHub never fails the write", async () => {
    const { admin } = await acme();
    vi.stubGlobal("fetch", github({ bytes: PNG("first-owner") }).fetchImpl);
    await later("POST", "/api/o/acme/repos", admin, { repo_full_name: "acme-co/widgets" });
    vi.stubGlobal("fetch", github({ bytes: PNG("second-owner") }).fetchImpl);
    expect(await later("POST", "/api/o/acme/repos", admin, { repo_full_name: "Other-Org/site", is_primary: true })).toBe(201);
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("second-owner")), logo_from: "Other-Org" });

    vi.stubGlobal("fetch", (async () => { throw new Error("github is down"); }) as unknown as typeof fetch);
    const before = await cols(ORG_B);
    const { out } = await captured(() => later("POST", "/api/o/acme/repos", admin, { repo_full_name: "acme-co/widgets", is_primary: true }));
    expect(out).toBe(200);
    expect(await cols(ORG_B)).toEqual(before);
  });

  it("setting and rotating the GitHub token import with that token — and never over an uploaded image", async () => {
    const { owner } = await acme();
    await addOrgRepo("acme-co/widgets", ORG_B);
    const g = github({ bytes: PNG("on-token") });
    vi.stubGlobal("fetch", g.fetchImpl);
    expect(await later("PUT", "/api/o/acme/integrations/github_token", owner, { secret: "ghp_first_token_0123456789abc" })).toBe(201);
    expect(g.logoCalls()[0]).toMatchObject({ url: "https://api.github.com/users/acme-co", auth: "Bearer ghp_first_token_0123456789abc" });
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("on-token")), logo_source: "github" });

    const g2 = github({ bytes: PNG("on-rotate") });
    vi.stubGlobal("fetch", g2.fetchImpl);
    expect(await later("POST", "/api/o/acme/integrations/github_token/rotate", owner, { secret: "ghp_second_token_0123456789ab" })).toBe(200);
    expect(g2.logoCalls()[0].auth).toBe("Bearer ghp_second_token_0123456789ab");
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("on-rotate")) });

    await upload("acme", owner, PNG("ours"), "image/png");
    const g3 = github({ bytes: PNG("ignored") });
    vi.stubGlobal("fetch", g3.fetchImpl);
    await later("POST", "/api/o/acme/integrations/github_token/rotate", owner, { secret: "ghp_third_token_0123456789abc" });
    expect(g3.logoCalls()).toEqual([]);
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("ours")), logo_source: "upload" });
  });

  it("another integration's secret, and a member's refused write, import nothing", async () => {
    const { owner, member } = await acme();
    await addOrgRepo("acme-co/widgets", ORG_B);
    const g = github();
    vi.stubGlobal("fetch", g.fetchImpl);
    expect(await later("PUT", "/api/o/acme/integrations/cloudflare_analytics", owner, { secret: "cf_token_0123456789abcdef", config: { account_id: "a".repeat(32) } })).toBe(201);
    expect(await later("POST", "/api/o/acme/repos", member, { repo_full_name: "mia-co/x" })).toBe(403);
    expect(g.logoCalls()).toEqual([]);
    expect(await cols(ORG_B)).toEqual(NONE);
  });

  it("the periodic reconcile imports it for an org with a token, refreshes it — and asks nothing for an org without one", async () => {
    await addOrgRepo("acme-co/widgets", ORG_B);
    const quiet = github();
    await captured(() => runOrgJob(e, ORG_B, "reconcile", Date.parse("2026-09-20T12:20:00Z"), quiet.fetchImpl));
    expect(quiet.seen).toEqual([]); // no token: the job makes no request for this org at all
    expect(await cols(ORG_B)).toEqual(NONE);

    await setSecret(await tenantCtx("olive", "owner", { orgId: ORG_B }), "github_token", "", "ghp_acme_token_0123456789ab");
    const g = github({ bytes: PNG("cron-1") });
    await captured(() => runOrgJob(e, ORG_B, "reconcile", Date.parse("2026-09-20T12:20:00Z"), g.fetchImpl));
    expect(g.logoCalls()[0]).toMatchObject({ url: "https://api.github.com/users/acme-co", auth: "Bearer ghp_acme_token_0123456789ab" });
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("cron-1")), logo_source: "github", logo_from: "acme-co" });
    expect((await audit(ORG_B)).map((a) => [a.actor, a.action])).toEqual([["system", "org.logo.import"]]);
    expect(await cols(ORG_A)).toEqual(NONE);

    const g2 = github({ bytes: PNG("cron-2") }); // the owner changed their avatar
    await captured(() => runOrgJob(e, ORG_B, "reconcile", Date.parse("2026-09-20T18:20:00Z"), g2.fetchImpl));
    expect(await cols(ORG_B)).toMatchObject({ logo_sha: await sha256Hex(PNG("cron-2")) });
    // The dispatcher budgets the unit for it.
    expect(reconcileCost(2)).toBe(19 + 2 * 2 + LOGO_IMPORT_COST);
  });
});

describe("the columns", () => {
  it("accept only a 64-character hash and the two sources", async () => {
    await expect(exec(`UPDATE orgs SET logo_sha = 'short' WHERE id = ?`, ORG_B)).rejects.toThrow();
    await expect(exec(`UPDATE orgs SET logo_source = 'gravatar' WHERE id = ?`, ORG_B)).rejects.toThrow();
    await exec(`UPDATE orgs SET logo_sha = ?, logo_source = 'github' WHERE id = ?`, "b".repeat(64), ORG_B);
    expect((await cols(ORG_B)).logo_source).toBe("github");
  });
});
