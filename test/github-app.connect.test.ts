/**
 * Connecting an org to a GitHub App installation, end to end against a stubbed GitHub
 * (src/github-app/connect.ts; docs/architecture/github-app.md › The connect flow).
 *
 * The property under test: an `installation_id` in a URL proves nothing. An installation is bound only
 * for the org and person OUR sealed cookie names, when GitHub itself says that person's account can
 * reach it — and every refusal writes NOTHING, in any table.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { buildAuthApp } from "../src/auth/routes";
import { hmacSeal } from "../src/auth/crypto";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, ensureMember } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";
import { USER_TOKEN, fakeApp, repoId, seedInstallation, type FakeApp, type FakeWorld } from "./helpers/github-app";
import { fakeGithubFetch } from "./helpers/github";
import { REPO_ID_PAGES, clearInstallationTokens, installationRepoIds, revokeUserToken, userInstallationRepoIds } from "../src/github-app/api";
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
const repos = (outcome: string, slug = "acme"): string => `/${slug}/?github=${outcome}#org/repos`;

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

  it("a start that comes from ANOTHER site is refused: no cookie, no trip to GitHub — only Trov's own page (or the address bar) starts one", async () => {
    const cookie = await olive();
    for (const query of ["", "?existing=1", "?existing=1&account=acme-gh"]) {
      for (const site of ["cross-site", "same-site"]) {
        const res = await app.request(`/api/o/acme/github/install${query}`, { headers: { cookie, "sec-fetch-site": site } }, e);
        expect(landed(res), `${site} ${query}`).toBe(repos("expired"));
        expect(setCookies(res)).toEqual([]);
      }
      for (const site of ["same-origin", "none"]) {
        const res = await app.request(`/api/o/acme/github/install${query}`, { headers: { cookie, "sec-fetch-site": site } }, e);
        expect(new URL(landed(res)).host, `${site} ${query}`).toBe("github.com");
      }
    }
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
    // Refused before GitHub was asked who this is: each attempt is the exchange, then the revoke of what it gave.
    expect(gh.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["POST /login/oauth/access_token", "DELETE /applications/test-client-id/token", "POST /login/oauth/access_token", "DELETE /applications/test-client-id/token"]);
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

  it("an installation already connected to ANOTHER Trov org is refused; a different one for THIS org replaces its connection", async () => {
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
    // This org connects another one; a different installation then takes its place (the admin chose
    // another GitHub account) — the old binding is ended as `disconnected`, never left beside the new.
    const c = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: "502", setup_action: "install", state: stateOf(c.res) }, [cookie, c.install]))).toBe(repos("connected"));
    await run(env.DB, `UPDATE org_github_installations SET removed_at = '2026-10-07T00:00:00Z', removed_reason = 'disconnected' WHERE org_id = ?`, ORG_A);
    const d = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(d.res) }, [cookie, d.install]))).toBe(repos("connected"));
    expect((await bindings()).filter((r) => r.removed_at === null)).toEqual([{ org_id: ORG_B, installation_id: INSTALL, account_login: "acme-gh", connected_by: "olive", removed_at: null }]);
    expect(await all(env.DB, `SELECT installation_id, removed_reason FROM org_github_installations WHERE org_id = ? AND removed_at IS NOT NULL`, ORG_B)).toEqual([{ installation_id: 502, removed_reason: "disconnected" }]);
    expect((await all<{ action: string }>(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? AND action LIKE 'github.%' ORDER BY id`, ORG_B)).map((r) => r.action)).toEqual(["github.connect", "github.disconnect", "github.connect"]);
    // The same installation again (an "update" return) refreshes it: still one live row, no further audit row.
    const f = await start(cookie);
    expect(landed(await callback(gh, { code: "abc", installation_id: String(INSTALL), setup_action: "update", state: stateOf(f.res) }, [cookie, f.install]))).toBe(repos("connected"));
    expect(await all(env.DB, `SELECT action FROM org_admin_audit WHERE org_id = ? AND action = 'github.connect'`, ORG_B)).toHaveLength(2);
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

describe("no escalation: the installation's repository ids must ALL be ones the connecting account can read", () => {
  const big = (n: number): FakeWorld["installations"] => ({ [INSTALL]: { ...structuredClone(ACME), repos: Array.from({ length: n }, (_, i) => ({ full_name: `acme-gh/r${i}`, private: true })) } });
  async function attempt(cookie: string, gh: FakeApp, id = INSTALL): Promise<string> {
    clearInstallationTokens();
    const { res, install } = await start(cookie);
    return landed(await callback(gh, { code: "abc", installation_id: String(id), setup_action: "install", state: stateOf(res) }, [cookie, install]));
  }
  const pagesOf = (gh: FakeApp, path: string): string[] => gh.seen.filter((s) => new URL(s.url).pathname === path).map((s) => new URL(s.url).search);

  it("a superset passes: every repository of the installation, and others besides", async () => {
    const cookie = await olive();
    const gh = world({ userRepos: { [INSTALL]: ["acme-gh/docs", 31337, "acme-gh/app"] } });
    expect(await attempt(cookie, gh)).toBe(repos("connected"));
    // The installation's list was read with a token that spans it and carries Metadata alone.
    expect(gh.mints).toEqual([{ installation: INSTALL, repositories: null, permissions: { metadata: "read" }, token: gh.minted[0] }]);
    expect(gh.seen.find((s) => s.url.includes("/installation/repositories"))!.auth).toBe(`Bearer ${gh.minted[0]}`);
    expect(gh.seen.find((s) => s.url.includes(`/user/installations/${INSTALL}/repositories`))!.auth).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("a missing id is refused with a COUNT and no repository's name; nothing is written", async () => {
    const cookie = await olive();
    const before = await everything();
    const to = await attempt(cookie, world({ userRepos: { [INSTALL]: ["acme-gh/app"] } })); // a collaborator on one of the two
    expect(to).toBe(repos("partial_access&missing=1"));
    expect(to).not.toMatch(/docs|acme-gh/);
    // GitHub's 404 for the user's view means they read none of it.
    expect(await attempt(cookie, world({ userRepos: { [INSTALL]: [] } }))).toBe(repos("partial_access&missing=2"));
    expect(await everything()).toBe(before);
  });

  it("EQUAL COUNTS, different repositories: refused — the case a count comparison lets through", async () => {
    const cookie = await olive();
    const before = await everything();
    // Two of the installation's, two the account reads — but one of the account's is some other repository.
    expect(await attempt(cookie, world({ userRepos: { [INSTALL]: ["acme-gh/app", 31337] } }))).toBe(repos("partial_access&missing=1"));
    expect(await attempt(cookie, world({ userRepos: { [INSTALL]: [31337, 31338] } }))).toBe(repos("partial_access&missing=2"));
    expect(await everything()).toBe(before);
  });

  it("both lists are read to the end, page by page", async () => {
    const cookie = await olive();
    const gh = world({ installations: big(250) });
    expect(await attempt(cookie, gh)).toBe(repos("connected"));
    const three = ["?per_page=100&page=1", "?per_page=100&page=2", "?per_page=100&page=3"];
    expect(pagesOf(gh, "/installation/repositories").slice(0, 3)).toEqual(three);
    expect(pagesOf(gh, `/user/installations/${INSTALL}/repositories`)).toEqual(three);
    // The one repository the account cannot read is on the LAST page of the installation's list.
    await run(env.DB, `DELETE FROM org_github_installations`);
    await run(env.DB, `DELETE FROM org_admin_audit WHERE action LIKE 'github.%'`);
    const short = world({ installations: big(250) });
    short.world.userRepos[INSTALL] = short.world.installations[INSTALL].repos.slice(0, 249).map((r) => r.full_name);
    expect(await attempt(cookie, short)).toBe(repos("partial_access&missing=1"));
    expect(await bindings()).toEqual([]);
  });

  it(`the cap: ${REPO_ID_PAGES} pages (1,000 repositories) are checked; one more is refused with what to do, after ONE request`, async () => {
    const cookie = await olive();
    const before = await everything();
    const over = world({ installations: big(REPO_ID_PAGES * 100 + 1) });
    expect(await attempt(cookie, over)).toBe(repos("too_many_repos"));
    expect(pagesOf(over, "/installation/repositories")).toEqual(["?per_page=100&page=1"]); // GitHub's own count said so
    expect(over.seen.some((s) => s.url.includes(`/user/installations/${INSTALL}/repositories`))).toBe(false);
    expect(await everything()).toBe(before);
    // A list that keeps going past the cap without ever reaching its count is refused the same way.
    const endless = (async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return Response.json({ total_count: 1000, repositories: Array.from({ length: 100 }, (_, i) => ({ id: (page % 9) * 100 + i + 1 })) });
    }) as typeof fetch;
    expect(await installationRepoIds("t", endless)).toEqual({ ok: false, reason: "too_many" });
    // Exactly at the cap it is read in full.
    const exact = world({ installations: big(REPO_ID_PAGES * 100) });
    expect(await attempt(cookie, exact)).toBe(repos("connected"));
    expect(pagesOf(exact, `/user/installations/${INSTALL}/repositories`)).toHaveLength(REPO_ID_PAGES);
  });

  it("a page that fails, throws, comes short, or is not a list of ids fails CLOSED — on either side", async () => {
    const cookie = await olive();
    const before = await everything();
    const inst = (page: number) => (s: { url: string }) => s.url.includes("/installation/repositories") && s.url.endsWith(`page=${page}`);
    const user = (page: number) => (s: { url: string }) => s.url.includes(`/user/installations/${INSTALL}/repositories`) && s.url.endsWith(`page=${page}`);
    const row = (i: number) => ({ id: repoId(INSTALL, i), full_name: `acme-gh/r${i}` });
    const answers: [string, (s: { url: string }) => boolean, () => Response][] = [
      ["500", inst(2), () => new Response("{}", { status: 500 })],
      ["a throw", inst(2), () => { throw new Error("connection reset"); }],
      ["a 404 on the installation's own list", inst(1), () => new Response("{}", { status: 404 })],
      ["a short page that is not the last", inst(1), () => Response.json({ total_count: 250, repositories: [row(0), row(1)] })],
      ["no total_count", inst(1), () => Response.json({ repositories: [row(0)] })],
      ["not a list", inst(1), () => Response.json({ total_count: 250, repositories: null })],
      ["a row with no id", inst(1), () => Response.json({ total_count: 1, repositories: [{ full_name: "acme-gh/r0" }] })],
      ["more rows than the count", inst(1), () => Response.json({ total_count: 1, repositories: [row(0), row(1)] })],
      ["500 (the user's list)", user(3), () => new Response("{}", { status: 500 })],
      ["a throw (the user's list)", user(1), () => { throw new Error("connection reset"); }],
      ["a 404 past the first page (the user's list)", user(2), () => new Response("{}", { status: 404 })],
      ["a short page (the user's list)", user(2), () => Response.json({ total_count: 250, repositories: [row(100)] })],
    ];
    for (const [name, hit, answer] of answers) {
      const gh = world({ installations: big(250), intercept: (s) => (hit(s) ? answer() : undefined) });
      expect(await attempt(cookie, gh), name).toBe(repos("github_failed"));
    }
    expect(await everything()).toBe(before);
    // The two lists themselves, directly.
    const stub = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    expect(await installationRepoIds("t", stub({ total_count: 0, repositories: [] }))).toEqual({ ok: true, ids: new Set() });
    expect(await installationRepoIds("t", stub({}, 404))).toEqual({ ok: false, reason: "failed" });
    expect(await userInstallationRepoIds("t", 9, stub({}, 404))).toEqual({ ok: true, ids: new Set() });
    expect(await userInstallationRepoIds("t", 9, stub({}, 403))).toEqual({ ok: false, reason: "failed" });
  });

  it("a PERSONAL account's installation takes the same check — its owner reads all of it and passes; someone else's does not", async () => {
    const cookie = await olive();
    const gh = world();
    gh.world.installations[502] = { account: { login: "olive", id: 9001, type: "User" }, repos: [{ full_name: "olive/dotfiles" }, { full_name: "olive/notes", private: true }] };
    gh.world.reachable = [502];
    const before = await everything();
    gh.world.userRepos[502] = ["olive/dotfiles"]; // (what GitHub would say of a collaborator on one of them)
    expect(await attempt(cookie, gh, 502)).toBe(repos("partial_access&missing=1"));
    expect(await everything()).toBe(before);
    gh.world.userRepos = {};
    expect(await attempt(cookie, gh, 502)).toBe(repos("connected"));
    expect(gh.seen.some((s) => s.url.includes("/user/installations/502/repositories"))).toBe(true); // no exemption: it was asked
  });
});

describe("the GitHub user token is revoked once the decision is made", () => {
  const BASIC = `Basic ${btoa("test-client-id:test-client-secret")}`;
  const REVOKE = "https://api.github.com/applications/test-client-id/token";
  async function attempt(cookie: string, gh: FakeApp, id: string = String(INSTALL), cookies?: (c: string, install: string | null) => (string | null)[]): Promise<Response> {
    clearInstallationTokens();
    const { res, install } = await start(cookie);
    return callback(gh, { code: "abc", installation_id: id, setup_action: "install", state: stateOf(res) }, cookies ? cookies(cookie, install) : [cookie, install]);
  }

  it("after a binding: ONE DELETE, Basic client id : secret, the token in the body — and it is the last thing asked of GitHub", async () => {
    const cookie = await olive();
    const gh = world();
    expect(landed(await attempt(cookie, gh))).toBe(repos("connected"));
    expect(gh.revoked).toEqual([USER_TOKEN]);
    const last = gh.seen[gh.seen.length - 1];
    expect([last.method, last.url, last.auth]).toEqual(["DELETE", REVOKE, BASIC]);
    expect(JSON.parse(last.body)).toEqual({ access_token: USER_TOKEN });
    expect(gh.seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
    // Linking an existing installation ends the same way.
    await run(env.DB, `DELETE FROM org_github_installations`);
    clearInstallationTokens();
    const linked = world();
    const s = await start(cookie, "?existing=1");
    expect(landed(await callback(linked, { code: "abc", state: new URL(landed(s.res)).searchParams.get("state")! }, [cookie, s.install, s.tx]))).toBe(repos("connected"));
    expect(linked.revoked).toEqual([USER_TOKEN]);
    expect(linked.seen[linked.seen.length - 1].url).toBe(REVOKE);
  });

  it("after EVERY refusal that got as far as a token — and never when there was none", async () => {
    const cookie = await olive();
    const boss = await cookieFor("boss", { member: false });
    await ensureMember("boss", "owner", ORG_B);
    await seedInstallation(ORG_A, 503, "taken-co");
    const before = await everything();
    const taken = { account: { login: "taken-co", id: 79, type: "Organization" as const }, repos: [{ full_name: "taken-co/x" }] };
    const cases: [string, FakeApp, string, string?, ((c: string, install: string | null) => (string | null)[])?][] = [
      ["wrong_person", world(), "wrong_person", undefined, (_c, install) => [boss, install]],
      ["wrong_account", world({ user: { login: "mallory", id: 666 } }), "wrong_account"],
      ["GitHub does not list installations", world({ intercept: (s) => (s.url.includes("/user/installations?") ? new Response("{}", { status: 502 }) : undefined) }), "github_failed"],
      ["not_yours", world(), "not_yours", "777"],
      ["taken", world({ installations: { 503: taken }, reachable: [503] }), "taken", "503"],
      ["suspended", world({ installations: { [INSTALL]: { ...structuredClone(ACME), suspended: true } } }), "suspended"],
      ["the App's credentials refused", world({ badAppCredentials: true }), "not_configured"],
      ["partial_access", world({ userRepos: { [INSTALL]: ["acme-gh/app"] } }), "partial_access&missing=1"],
      ["too_many_repos", world({ installations: { [INSTALL]: { ...structuredClone(ACME), repos: Array.from({ length: 1001 }, (_, i) => ({ full_name: `acme-gh/r${i}` })) } } }), "too_many_repos"],
      ["a thrown fetch mid-flow", world({ intercept: (s) => { if (s.url.endsWith("/user")) throw new Error("boom"); return undefined; } }), "github_failed"],
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const [name, gh, outcome, id, cookies] of cases) {
        expect(landed(await attempt(cookie, gh, id, cookies)), name).toBe(repos(outcome));
        expect(gh.revoked, name).toEqual([USER_TOKEN]);
        expect(gh.seen[gh.seen.length - 1].url, name).toBe(REVOKE);
      }
      // No longer an admin: refused before GitHub was asked who this is — the token is revoked all the same.
      await run(env.DB, `UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = 'olive'`, ORG_B);
      const demoted = world();
      const s = await start(await olive("admin"));
      await run(env.DB, `UPDATE memberships SET role = 'member' WHERE org_id = ? AND user_id = 'olive'`, ORG_B);
      expect(landed(await callback(demoted, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: stateOf(s.res) }, [cookie, s.install]))).toBe(repos("not_admin"));
      expect(demoted.revoked).toEqual([USER_TOKEN]);
      await run(env.DB, `UPDATE memberships SET role = 'admin' WHERE org_id = ? AND user_id = 'olive'`, ORG_B);
      expect(await everything()).toBe(before);
      // No token was ever issued (a code GitHub will not exchange; a refusal before the exchange): nothing to revoke, nothing sent.
      const none = world({ user: null });
      expect(landed(await attempt(cookie, none))).toBe(repos("github_failed"));
      expect(none.seen.map((x) => x.method)).toEqual(["POST"]);
      const early = world();
      const a = await start(cookie);
      expect(landed(await callback(early, { code: "abc", installation_id: String(INSTALL), setup_action: "install", state: "not-ours" }, [cookie, a.install]))).toBe(repos("expired"));
      expect(early.seen).toEqual([]);
    } finally { errors.mockRestore(); }
  });

  it("a revoke that fails changes NOTHING the person sees — bound stays bound, refused stays refused — and no secret reaches a log line, the response or D1", async () => {
    const cookie = await olive();
    const logged: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args); }));
    const responses: Response[] = [];
    const minted: string[] = [];
    try {
      const failures: [string, () => Response][] = [
        ["500, echoing what it was sent", () => new Response(JSON.stringify({ message: `denied: ${BASIC} ${USER_TOKEN}` }), { status: 500 })],
        ["404 (already gone)", () => new Response("{}", { status: 404 })],
        ["401", () => new Response("{}", { status: 401 })],
        ["a throw that quotes the request", () => { throw new Error(`fetch failed: authorization=${BASIC} body={"access_token":"${USER_TOKEN}"}`); }],
        ["a 200 that is not the 204", () => new Response("{}", { status: 200 })],
      ];
      for (const [name, answer] of failures) {
        await run(env.DB, `DELETE FROM org_github_installations`);
        const gh = world({ intercept: (s) => (s.method === "DELETE" ? answer() : undefined) });
        const done = await attempt(cookie, gh);
        expect(landed(done), name).toBe(repos("connected"));
        expect(await bindings(), name).toEqual([{ org_id: ORG_B, installation_id: INSTALL, account_login: "acme-gh", connected_by: "olive", removed_at: null }]);
        expect(gh.seen.filter((s) => s.method === "DELETE"), name).toHaveLength(1); // attempted once, not retried
        const refused = world({ userRepos: { [INSTALL]: ["acme-gh/app"] }, intercept: (s) => (s.method === "DELETE" ? answer() : undefined) });
        const no = await attempt(cookie, refused, "777");
        expect(landed(no), name).toBe(repos("not_yours"));
        responses.push(done, no);
        minted.push(...gh.minted, ...refused.minted);
      }
      // Without a client id or secret there is nothing to revoke WITH: no request at all, and still no throw.
      const sent: string[] = [];
      const record = (async (input: RequestInfo | URL) => { sent.push(String(input)); return new Response(null, { status: 204 }); }) as typeof fetch;
      expect(await revokeUserToken({ GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "x" }, USER_TOKEN, record)).toBe(false);
      expect(await revokeUserToken({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "" }, USER_TOKEN, record)).toBe(false);
      expect(sent).toEqual([]);
      expect(await revokeUserToken({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "x" }, USER_TOKEN, record)).toBe(true);
    } finally { for (const s of spies) s.mockRestore(); }

    // The failed revoke is ONE fixed line each time — and nothing anywhere carries a token or the client secret.
    const lines = logged.map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    expect(lines.filter((l) => l.includes("revoking"))).toEqual(Array(10).fill("github app connect: GitHub did not confirm revoking the user token"));
    const secrets = [USER_TOKEN, "ghu_user_token", "test-client-secret", BASIC, BASIC.slice(6), ...minted];
    expect(minted.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(lines.join("\n"), "console").not.toContain(secret);
      for (const res of responses) {
        expect(`${res.headers.get("location")} ${setCookies(res).join(" ")} ${await res.clone().text()}`, "response").not.toContain(secret);
      }
    }
    const tables = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '%_fts%'`);
    for (const t of tables) {
      const dump = JSON.stringify(await all(env.DB, `SELECT * FROM "${t.name}"`));
      for (const secret of secrets) expect(dump, t.name).not.toContain(secret);
    }
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
    expect(landed(await link(cookie, gh))).toBe(`/acme/?github=choose&accounts=acme-gh,olive#org/repos`);
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
    expect(landed(await link(cookie, world({ userRepos: { [INSTALL]: ["acme-gh/app"] } })))).toBe(repos("partial_access&missing=1"));
    const gh = world();
    const s = await start(cookie, "?existing=1");
    const state = new URL(landed(s.res)).searchParams.get("state")!;
    expect(landed(await callback(gh, { code: "abc", state }, [other, s.install, s.tx]))).toBe(repos("wrong_person"));
    const s2 = await start(cookie, "?existing=1");
    expect(landed(await callback(gh, { code: "abc", state: new URL(landed(s2.res)).searchParams.get("state")! }, [cookie, s2.tx]))).toBe(repos("expired"));
    expect(await everything()).toBe(before);
  });
});
