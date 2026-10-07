/**
 * Connecting an org to a GitHub App installation, end to end against a stubbed GitHub
 * (src/github-app/connect.ts; docs/architecture/github-app.md › The connect flow).
 *
 * The property under test: an `installation_id` in a URL proves nothing. An installation is bound only
 * for the org and person OUR sealed cookie names, when GitHub itself says that person's account can
 * reach it — and every refusal writes NOTHING, in any table.
 */
import { beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { buildAuthApp } from "../src/auth/routes";
import { hmacSeal } from "../src/auth/crypto";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";
import { fakeApp, seedInstallation, type FakeApp, type FakeWorld } from "./helpers/github-app";
import { fakeGithubFetch } from "./helpers/github";
import { clearInstallationTokens } from "../src/github-app/api";
import { clearRepoLists } from "../src/github-app/repos";
import { INSTALL_TTL_S } from "../src/github-app/connect";

const e = env as unknown as Env;
// The start route stamps its cookie with the real clock, so the callbacks are driven at the real "now".
const NOW = Date.now();
const INSTALL = 501;
const ACME = { account: { login: "acme-gh", id: 77, type: "Organization" as const }, repos: [{ full_name: "acme-gh/app" }, { full_name: "acme-gh/docs", private: true }] };

beforeEach(() => { clearInstallationTokens(); clearRepoLists(); });

/** olive: an ADMIN of Acme whose GitHub identity is pinned to account 9001. */
async function olive(role: "owner" | "admin" | "member" = "admin"): Promise<string> {
  const cookie = await cookieFor("olive", { member: false });
  await ensureMember("olive", role, ORG_B);
  await run(env.DB, `UPDATE identities SET provider_uid = '9001' WHERE provider = 'github' AND subject = 'olive'`);
  return cookie;
}
const world = (over: Partial<FakeWorld> = {}): FakeApp =>
  fakeApp({ now: () => NOW, user: { login: "olive", id: 9001 }, installations: { [INSTALL]: structuredClone(ACME) }, reachable: [INSTALL], ...over });

/** Every Set-Cookie of a response (the workers types do not declare `getSetCookie`). */
const setCookies = (res: Response): string[] => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
const cookieOf = (res: Response, name: string): string | null => {
  const hit = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(";")[0] : null;
};
const stateOf = (res: Response): string => new URL(res.headers.get("location")!).searchParams.get("state")!;

/** `GET /api/o/acme/github/install` as `cookie` → the redirect, and the sealed cookie it set. */
async function start(cookie: string, query = "", envOver: Env = e): Promise<{ res: Response; install: string | null; tx: string | null }> {
  const res = await app.request(`/api/o/acme/github/install${query}`, { headers: { cookie } }, envOver);
  return { res, install: cookieOf(res, "gh_install"), tx: cookieOf(res, "oauth_tx") };
}
/** GitHub's return to `/auth/callback`, with `cookies` — against a stubbed GitHub. */
async function callback(gh: { fetchImpl: typeof fetch }, query: Record<string, string>, cookies: (string | null)[], now = NOW, envOver: Env = e): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  return buildAuthApp({ fetchImpl: gh.fetchImpl, now: () => now }).request(`/callback?${qs}`, { headers: { cookie: cookies.filter(Boolean).join("; ") } }, envOver);
}
const landed = (res: Response): string => { expect(res.status).toBe(302); return res.headers.get("location")!; };
const repos = (outcome: string, slug = "acme"): string => `/o/${slug}/?github=${outcome}#org/repos`;

/** Every table's row count, and the rows a connection could touch: a refusal must leave it identical. */
async function everything(): Promise<string> {
  const tables = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'sessions' ORDER BY name`);
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.name] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM "${t.name}"`))!.n;
  return JSON.stringify({
    counts,
    installations: await all(env.DB, `SELECT * FROM org_github_installations ORDER BY id`),
    repos: await all(env.DB, `SELECT * FROM org_repos ORDER BY id`),
    identities: await all(env.DB, `SELECT * FROM identities ORDER BY provider, subject`),
  });
}
const bindings = () => all<{ org_id: string; installation_id: number; account_login: string; connected_by: string; removed_at: string | null }>(env.DB,
  `SELECT org_id, installation_id, account_login, connected_by, removed_at FROM org_github_installations ORDER BY id`);

describe("GET /api/o/:slug/github/install — the start", () => {
  it("an admin is sent to GitHub's install page with a random state, bound to { org, person } in a sealed HttpOnly cookie", async () => {
    const cookie = await olive();
    const { res, install } = await start(cookie);
    const to = new URL(landed(res));
    expect(to.origin + to.pathname).toBe("https://github.com/apps/trov-test/installations/new");
    expect(to.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const set = setCookies(res).find((c) => c.startsWith("gh_install="))!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/auth", `Max-Age=${INSTALL_TTL_S}`]) expect(set, attr).toContain(attr);
    expect(install).not.toContain("olive"); // the value is base64url, sealed — not readable JSON
    // Two starts never share a state.
    expect(stateOf((await start(cookie)).res)).not.toBe(to.searchParams.get("state"));
    expect(await bindings()).toEqual([]); // starting writes nothing
  });

  it("a member is sent back with a sentence and gets NO cookie; a non-member gets the org's 404; a token is refused", async () => {
    const member = await olive("member");
    const { res, install } = await start(member);
    expect(landed(res)).toBe(repos("not_admin"));
    expect(install).toBeNull();
    const outsider = await cookieFor("zed", { member: false });
    expect((await start(outsider)).res.status).toBe(404);
    const admin = await olive("admin");
    const bearer = await app.request("/api/o/acme/github/install", { headers: { cookie: admin, authorization: "Bearer trov_mcp_x" } }, e);
    expect(bearer.status).toBe(403);
  });

  it("when the App is not configured on this deployment it says so and never leaves for GitHub", async () => {
    const cookie = await olive();
    for (const over of [{ GITHUB_APP_SLUG: "" }, { GITHUB_APP_ID: "" }, { GITHUB_APP_PRIVATE_KEY: "" }]) {
      const { res, install } = await start(cookie, "", { ...e, ...over } as Env);
      expect(landed(res), JSON.stringify(over)).toBe(repos("not_configured"));
      expect(install).toBeNull();
      const linked = await start(cookie, "?existing=1", { ...e, ...over } as Env);
      expect(landed(linked.res)).toBe(repos("not_configured"));
    }
  });
});

describe("GET /auth/callback — GitHub's return after an install", () => {
  it("the happy path: the installation is bound to the org the cookie names, by the person who started, and audited", async () => {
    const cookie = await olive();
    await addOrgRepo("acme-gh/app", ORG_B);           // connected by hand before: now reachable through the App
    await addOrgRepo("elsewhere/site", ORG_B, { primary: false });
    const gh = world();
    const { res, install } = await start(cookie);
    const done = await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) }, [cookie, install]);
    expect(landed(done)).toBe(repos("connected"));
    expect(setCookies(done).some((c) => c.startsWith("gh_install=;"))).toBe(true); // spent

    expect(await all(env.DB, `SELECT org_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, suspended_at, removed_at FROM org_github_installations`)).toEqual([
      { org_id: ORG_B, installation_id: INSTALL, account_login: "acme-gh", account_id: "77", account_type: "Organization", repository_selection: "all", connected_by: "olive", suspended_at: null, removed_at: null },
    ]);
    expect(await all(env.DB, `SELECT org_id, actor, action, target, detail FROM org_admin_audit WHERE action LIKE 'github.%'`)).toEqual([
      { org_id: ORG_B, actor: "olive", action: "github.connect", target: "acme-gh", detail: JSON.stringify({ installation_id: INSTALL, account_type: "Organization", repository_selection: "all" }) },
    ]);
    // The org's repositories: the one the installation can see is now `app`; the other is untouched.
    expect(await all(env.DB, `SELECT repo_full_name, connection FROM org_repos WHERE org_id = ? ORDER BY repo_full_name`, ORG_B)).toEqual([
      { repo_full_name: "acme-gh/app", connection: "app" }, { repo_full_name: "elsewhere/site", connection: "manual" },
    ]);

    // GitHub began this authorization, so the exchange carries no PKCE verifier and no redirect_uri…
    const exchange = JSON.parse(gh.seen.find((s) => s.url.endsWith("/login/oauth/access_token"))!.body) as Record<string, unknown>;
    expect(Object.keys(exchange).sort()).toEqual(["client_id", "client_secret", "code"]);
    // …the installation was looked up on GitHub's own list for THIS user, and its account read as the App.
    const paths = gh.seen.map((s) => new URL(s.url).pathname);
    expect(paths).toContain("/user/installations");
    expect(paths).toContain(`/app/installations/${INSTALL}`);
    expect(paths.indexOf("/user/installations")).toBeLessThan(paths.indexOf(`/app/installations/${INSTALL}`));
    // No token of any kind was stored anywhere.
    const dump = JSON.stringify([await all(env.DB, `SELECT * FROM org_github_installations`), await all(env.DB, `SELECT * FROM org_admin_audit`), await all(env.DB, `SELECT * FROM org_secrets`)]);
    for (const secret of [...gh.minted, "ghu_user_token"]) expect(dump).not.toContain(secret);

    // The page now reports it — to a member too, without the id, the error or the manage link.
    const status = await (await app.request("/api/o/acme/github", { headers: { cookie } }, e)).json() as Record<string, unknown>;
    expect(status).toMatchObject({ configured: true, lost: null, installation: { installation_id: INSTALL, account_login: "acme-gh", connected_by: "olive", manage_url: `https://github.com/organizations/acme-gh/settings/installations/${INSTALL}` } });
    const member = await cookieFor("mem", { member: false });
    await ensureMember("mem", "member", ORG_B);
    expect(await (await app.request("/api/o/acme/github", { headers: { cookie: member } }, e)).json()).toMatchObject({ installation: { installation_id: null, account_login: "acme-gh", manage_url: null, last_error: null } });
  });

  it("a FORGED installation_id — one this GitHub account cannot reach — is refused and nothing is written", async () => {
    const cookie = await olive();
    const gh = world();
    gh.world.installations[777] = { account: { login: "victim-org", id: 500, type: "Organization" }, repos: [{ full_name: "victim-org/secrets", private: true }] };
    const before = await everything();
    for (const forged of ["777", "999999"]) {
      const { res, install } = await start(cookie);
      const done = await callback(gh, { code: "abc", installation_id: forged, setup_action: "install", state: stateOf(res) }, [cookie, install]);
      expect(landed(done), forged).toBe(repos("not_yours"));
    }
    expect(await everything()).toBe(before);
    // It was refused on GitHub's list — before Trov asked the App anything about that installation.
    expect(gh.seen.some((s) => s.url.includes("/app/installations/777"))).toBe(false);
    expect(gh.minted).toEqual([]);
    // Not a number at all: refused before any request.
    const { res, install } = await start(cookie);
    const n = gh.seen.length;
    for (const junk of ["abc", "-5", "1e3", "0x1f5", " 501", "501 OR 1=1", "0", ""]) {
      expect(landed(await callback(gh, { code: "abc", installation_id: junk, setup_action: "install", state: stateOf(res) }, [cookie, install])), junk).toBe(repos("github_failed"));
    }
    expect(gh.seen).toHaveLength(n);
    expect(await everything()).toBe(before);
  });

  it("the state: missing, wrong, from another start, or an expired / tampered cookie — refused, nothing written, GitHub never asked", async () => {
    const cookie = await olive();
    const gh = world();
    const before = await everything();
    const a = await start(cookie);
    const b = await start(cookie);
    const q = { code: "abc", installation_id: String(INSTALL), setup_action: "install" };
    expect(landed(await callback(gh, q, [cookie, a.install]))).toBe(repos("expired"));                                   // no state
    expect(landed(await callback(gh, { ...q, state: "nope" }, [cookie, a.install]))).toBe(repos("expired"));             // wrong state
    expect(landed(await callback(gh, { ...q, state: stateOf(b.res) }, [cookie, a.install]))).toBe(repos("expired"));     // another start's state
    expect(landed(await callback(gh, { ...q, state: stateOf(a.res) }, [cookie, a.install], NOW + INSTALL_TTL_S * 1000 + 60_000))).toBe(repos("expired")); // too late
    // A cookie we did not seal is no cookie at all: the signed-in person is told how to connect, nothing more.
    const forgedCookie = `gh_install=${await hmacSeal(a.install!.split("=")[1].split(".")[0], "gh-install:another-secret")}`;
    for (const bad of [forgedCookie, `gh_install=${a.install!.split("=")[1].slice(0, -3)}abc`, "gh_install=garbage"]) {
      expect(landed(await callback(gh, { ...q, state: stateOf(a.res) }, [cookie, bad]))).toBe(repos("unlinked"));
    }
    expect(gh.seen).toEqual([]);
    expect(await everything()).toBe(before);
  });

  it("someone else's browser: a different signed-in person than the one who started, or nobody — refused", async () => {
    const cookie = await olive();
    const other = await cookieFor("boss", { member: false });
    await ensureMember("boss", "owner", ORG_B); // an owner of the same org, with a GitHub identity of their own
    const gh = world();
    const before = await everything();
    const { res, install } = await start(cookie);
    const q = { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) };
    expect(landed(await callback(gh, q, [other, install]))).toBe(repos("wrong_person"));
    expect(landed(await callback(gh, q, [install]))).toBe(repos("wrong_person"));
    expect(await everything()).toBe(before);
  });

  it("the person is no longer an admin of that org when they come back — refused", async () => {
    const cookie = await olive();
    const gh = world();
    const { res, install } = await start(cookie);
    await run(env.DB, `UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = 'olive'`, ORG_B);
    const before = await everything();
    const q = { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) };
    expect(landed(await callback(gh, q, [cookie, install]))).toBe(repos("not_admin"));
    const again = await start(cookie); // …and they cannot start another
    expect(landed(again.res)).toBe(repos("not_admin"));
    await run(env.DB, `DELETE FROM memberships WHERE org_id = ? AND user_id = 'olive'`, ORG_B);
    expect(landed(await callback(gh, q, [cookie, install]))).toBe(repos("not_admin")); // no longer a member at all
    expect(await bindings()).toEqual([]);
    expect(gh.seen.filter((s) => !s.url.endsWith("/login/oauth/access_token"))).toEqual([]); // refused before GitHub was asked who this is
  });

  it("the GitHub account behind the code is not this person's linked identity — another login, or the same login on another account id", async () => {
    const cookie = await olive();
    await cookieFor("mallory", { member: false });
    const before = await everything();
    for (const user of [{ login: "mallory", id: 666 }, { login: "olive", id: 4242 }, { login: "nobody-here", id: 1 }]) {
      const gh = world({ user });
      const { res, install } = await start(cookie);
      const done = await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) }, [cookie, install]);
      expect(landed(done), user.login).toBe(repos("wrong_account"));
      expect(gh.seen.some((s) => s.url.includes("/installations")), "nothing about installations is asked for the wrong account").toBe(false);
    }
    expect(await everything()).toBe(before);
    // A code GitHub will not exchange.
    const gh = world({ user: null });
    const { res, install } = await start(cookie);
    expect(landed(await callback(gh, { code: "stale", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) }, [cookie, install]))).toBe(repos("github_failed"));
    expect(await everything()).toBe(before);
  });

  it("an installation already connected to ANOTHER Trov org is refused; so is a second installation for this org", async () => {
    const cookie = await olive();
    const gh = world();
    gh.world.installations[502] = { account: { login: "olive", id: 9001, type: "User" }, repos: [{ full_name: "olive/dotfiles" }] };
    gh.world.reachable = [INSTALL, 502];
    await seedInstallation(ORG_A, INSTALL, "acme-gh");
    const before = await everything();
    const a = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(a.res) }, [cookie, a.install]))).toBe(repos("taken"));
    expect(await everything()).toBe(before);
    // Even while the org that holds it is suspended.
    await run(env.DB, `UPDATE orgs SET suspended_at = '2026-10-07T00:00:00Z', suspended_by = 'x' WHERE id = ?`, ORG_A);
    const b = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(b.res) }, [cookie, b.install]))).toBe(repos("taken"));
    await run(env.DB, `UPDATE orgs SET suspended_at = NULL, suspended_by = NULL WHERE id = ?`, ORG_A);
    // This org connects another one; a second, different installation is then refused.
    const c = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: "502", setup_action: "install", state: stateOf(c.res) }, [cookie, c.install]))).toBe(repos("connected"));
    await run(env.DB, `UPDATE org_github_installations SET removed_at = '2026-10-07T00:00:00Z', removed_reason = 'disconnected' WHERE org_id = ?`, ORG_A);
    const d = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(d.res) }, [cookie, d.install]))).toBe(repos("already_connected"));
    expect((await bindings()).filter((r) => r.removed_at === null)).toEqual([{ org_id: ORG_B, installation_id: 502, account_login: "olive", connected_by: "olive", removed_at: null }]);
    // The same installation again (an "update" return) refreshes it: still one row, no second audit row.
    const f = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: "502", setup_action: "update", state: stateOf(f.res) }, [cookie, f.install]))).toBe(repos("connected"));
    expect(await all(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? AND action = 'github.connect'`, ORG_B)).toHaveLength(1);
  });

  it("no escalation: an account that can read only SOME of the installation's repositories cannot connect it", async () => {
    const cookie = await olive();
    const gh = world({ userRepoCount: { [INSTALL]: 1 } }); // a collaborator on one of the two
    const before = await everything();
    const a = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(a.res) }, [cookie, a.install]))).toBe(repos("partial_access"));
    expect(await everything()).toBe(before);
    // GitHub not answering either count is not a yes.
    clearInstallationTokens();
    gh.world.userRepoCount = {};
    gh.world.intercept = (s) => (s.url.includes(`/user/installations/${INSTALL}/repositories`) ? new Response("{}", { status: 500 }) : undefined);
    const b = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(b.res) }, [cookie, b.install]))).toBe(repos("github_failed"));
    expect(await everything()).toBe(before);
    // The owner of a PERSONAL account's installation needs no count: the installation is their account.
    gh.world.intercept = undefined;
    gh.world.installations[502] = { account: { login: "olive", id: 9001, type: "User" }, repos: [{ full_name: "olive/dotfiles" }] };
    gh.world.reachable = [502];
    const c = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: "502", setup_action: "install", state: stateOf(c.res) }, [cookie, c.install]))).toBe(repos("connected"));
    expect(gh.seen.some((s) => s.url.includes("/user/installations/502/repositories"))).toBe(false);
  });

  it("GitHub not answering, a suspended installation, or App credentials GitHub refuses — nothing is connected", async () => {
    const cookie = await olive();
    const before = await everything();
    const attempt = async (gh: FakeApp): Promise<string> => {
      clearInstallationTokens();
      const { res, install } = await start(cookie);
      return landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) }, [cookie, install]));
    };
    expect(await attempt(world({ intercept: (s) => (s.url.endsWith("/user/installations?per_page=100&page=1") ? new Response("{}", { status: 502 }) : undefined) }))).toBe(repos("github_failed"));
    const suspended = world();
    suspended.world.installations[INSTALL].suspended = true;
    expect(await attempt(suspended)).toBe(repos("suspended"));
    expect(await attempt(world({ badAppCredentials: true }))).toBe(repos("not_configured"));
    expect(await attempt(world({ intercept: (s) => { if (s.url.includes("/app/installations/")) throw new Error("boom"); return undefined; } }))).toBe(repos("github_failed"));
    expect(await everything()).toBe(before);
  });

  it("setup_action=request: nothing exists yet — a sentence, no GitHub call, no row", async () => {
    const cookie = await olive();
    const gh = world();
    const before = await everything();
    const { res, install } = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", setup_action: "request", state: stateOf(res) }, [cookie, install]))).toBe(repos("requested"));
    // …and without our cookie (requested from GitHub's side), for a signed-in admin: the same sentence on their org.
    expect(landed(await callback(gh, { setup_action: "request" }, [cookie]))).toBe(repos("requested"));
    expect(gh.seen).toEqual([]);
    expect(await everything()).toBe(before);
  });

  it("an install Trov did not start (no cookie of ours) binds NOTHING: a signed-in admin is told how to connect it, anyone else gets the landing page", async () => {
    const cookie = await olive();
    const plain = await cookieFor("plain", { member: false });
    const gh = world();
    const before = await everything();
    const q = { code: "abc", installation_id: String(INSTALL), setup_action: "install" };
    expect(landed(await callback(gh, q, [cookie]))).toBe(repos("unlinked"));
    expect(landed(await callback(gh, { ...q, setup_action: "update", state: "whatever" }, [cookie]))).toBe(repos("unlinked"));
    // Signed in, but an admin of no org: the app's root.
    expect(landed(await callback(gh, q, [plain]))).toBe("/");
    // Not signed in: the landing page — the code is NOT used to sign anyone in, and no session is made.
    const anon = await callback(gh, q, []);
    expect(landed(anon)).toBe("/");
    expect(setCookies(anon).some((c) => c.startsWith("session="))).toBe(false);
    expect(gh.seen).toEqual([]);
    expect(await everything()).toBe(before);
  });

  it("never JSON, never a 500 for a human: every install return is a redirect", async () => {
    const cookie = await olive();
    const gh = world({ intercept: () => { throw new Error("github is down"); } });
    const { res, install } = await start(cookie);
    for (const q of [
      { installation_id: String(INSTALL) }, { setup_action: "install" }, { installation_id: "x", setup_action: "y", state: "z", code: "c" },
      { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(res) },
    ] as Record<string, string>[]) {
      for (const cookies of [[cookie, install], [cookie], [install], []]) {
        const done = await callback(gh, q, cookies);
        expect(done.status, JSON.stringify(q)).toBe(302);
        expect(done.headers.get("content-type") ?? "").not.toContain("json");
      }
    }
    expect(await bindings()).toEqual([]);
  });
});

describe("ordinary sign-in is untouched", () => {
  it("a callback with no installation_id runs the sign-in exactly as before: its own cookie, state and PKCE verifier", async () => {
    await olive();
    const seen: { url: string; body: string }[] = [];
    const inner = fakeGithubFetch({ login: "olive", name: null, avatar_url: null, id: 9001 });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" }); return inner(input, init); }) as typeof fetch;
    const auth = buildAuthApp({ fetchImpl: f });
    const login = await auth.request("/login", {}, e);
    const res = await auth.request(`/callback?code=abc&state=${stateOf(login)}`, { headers: { cookie: cookieOf(login, "oauth_tx")! } }, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(setCookies(res).some((c) => c.startsWith("session="))).toBe(true);
    const exchange = JSON.parse(seen[0].body) as Record<string, unknown>;
    expect(Object.keys(exchange).sort()).toEqual(["client_id", "client_secret", "code", "code_verifier", "redirect_uri"]);
    expect(exchange.redirect_uri).toBe("http://localhost/auth/callback");
    // The same refusals, byte for byte.
    const none = await auth.request("/callback", {}, e);
    expect([none.status, await none.text()]).toEqual([400, `{"error":"invalid_request"}`]);
    const mismatch = await auth.request(`/callback?code=abc&state=other`, { headers: { cookie: cookieOf(login, "oauth_tx")! } }, e);
    expect([mismatch.status, await mismatch.text()]).toEqual([403, `{"error":"state_mismatch"}`]);
    expect(await bindings()).toEqual([]);
  });

  it("an install return that DOES answer a sign-in transaction (no cookie of ours, not signed in) signs in — and still binds nothing", async () => {
    await olive();
    const auth = buildAuthApp({ fetchImpl: fakeGithubFetch({ login: "olive", name: null, avatar_url: null, id: 9001 }) });
    const login = await auth.request("/login", {}, e);
    const res = await auth.request(`/callback?code=abc&state=${stateOf(login)}&installation_id=${INSTALL}&setup_action=install`, { headers: { cookie: cookieOf(login, "oauth_tx")! } }, e);
    expect(res.headers.get("location")).toBe("/");
    expect(setCookies(res).some((c) => c.startsWith("session="))).toBe(true);
    expect(await bindings()).toEqual([]);
  });
});

describe("linking an installation that already exists (?existing=1)", () => {
  /** Start → GitHub's authorize redirect (state + PKCE) → the callback with both cookies. */
  async function link(cookie: string, gh: FakeApp, query = ""): Promise<Response> {
    const s = await start(cookie, `?existing=1${query}`);
    const to = new URL(landed(s.res));
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("code_challenge")).toBeTruthy();
    return callback(gh, { code: "abc", state: to.searchParams.get("state")! }, [cookie, s.install, s.tx]);
  }

  it("with ONE reachable installation it is bound — through the same checks, and this time with a PKCE verifier", async () => {
    const cookie = await olive();
    const gh = world();
    expect(landed(await link(cookie, gh))).toBe(repos("connected"));
    expect(await bindings()).toEqual([{ org_id: ORG_B, installation_id: INSTALL, account_login: "acme-gh", connected_by: "olive", removed_at: null }]);
    const exchange = JSON.parse(gh.seen.find((s) => s.url.endsWith("/login/oauth/access_token"))!.body) as Record<string, unknown>;
    expect(typeof exchange.code_verifier).toBe("string");
    expect(typeof exchange.redirect_uri).toBe("string");
  });

  it("none reachable, all taken, several to choose from, and a chosen account", async () => {
    const cookie = await olive();
    expect(landed(await link(cookie, world({ reachable: [] })))).toBe(repos("none_found"));
    const gh = world();
    gh.world.installations[502] = { account: { login: "olive", id: 9001, type: "User" }, repos: [{ full_name: "olive/dotfiles" }] };
    gh.world.reachable = [INSTALL, 502];
    expect(landed(await link(cookie, gh))).toBe(`/o/acme/?github=choose&accounts=acme-gh,olive#org/repos`);
    expect(await bindings()).toEqual([]);
    expect(landed(await link(cookie, gh, "&account=nobody"))).toBe(repos("none_found"));
    // One of the two belongs to another org: the free one is the only candidate.
    await seedInstallation(ORG_A, INSTALL, "acme-gh");
    expect(landed(await link(cookie, gh, "&account=acme-gh"))).toBe(repos("taken"));
    expect(landed(await link(cookie, gh))).toBe(repos("connected"));
    expect((await bindings()).filter((r) => r.org_id === ORG_B)).toEqual([{ org_id: ORG_B, installation_id: 502, account_login: "olive", connected_by: "olive", removed_at: null }]);
  });

  it("the wrong person, the wrong GitHub account and a partial reader are refused here too; a connect transaction without our cookie binds nothing", async () => {
    const cookie = await olive();
    const other = await cookieFor("boss", { member: false });
    await ensureMember("boss", "owner", ORG_B);
    const before = await everything();
    expect(landed(await link(cookie, world({ user: { login: "mallory", id: 666 } })))).toBe(repos("wrong_account"));
    expect(landed(await link(cookie, world({ userRepoCount: { [INSTALL]: 1 } })))).toBe(repos("partial_access"));
    const gh = world();
    const s = await start(cookie, "?existing=1");
    const state = new URL(landed(s.res)).searchParams.get("state")!;
    expect(landed(await callback(gh, { code: "abc", state }, [other, s.install, s.tx]))).toBe(repos("wrong_person"));
    const s2 = await start(cookie, "?existing=1");
    expect(landed(await callback(gh, { code: "abc", state: new URL(landed(s2.res)).searchParams.get("state")! }, [cookie, s2.tx]))).toBe(repos("expired"));
    expect(await everything()).toBe(before);
  });
});
