// The App's six GitHub calls (src/github-app/client.ts; spec §4): what each sends — URL, method, the App JWT or
// the token, the house headers, the body — what each returns (credentials as `Secret`), and that a failure's
// message carries GitHub's reason but never the JWT, the key, the client secret or a token, even from an
// upstream that echoes the whole request back.
import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { Secret } from "../src/data/secrets";
import { githubAppConfig, type GithubAppConfig } from "../src/github-app/config";
import {
  GithubAppError, exchangeUserCode, getAppInstallation, listInstallationRepos, listUserInstallationRepos,
  mintInstallationToken, revokeUserToken,
} from "../src/github-app/client";
import { APP, USER_TOKEN, appEnv, fakeAppGithub, installationToken, jwtParts, makeAppKeys, verifyJwt } from "./helpers/github-app";
import { leakedFragments } from "./helpers/repo";

const e = env as unknown as Env;
const NOW = Date.parse("2026-10-06T21:00:00.000Z");
const config = async (): Promise<GithubAppConfig> => githubAppConfig(await appEnv())!;

async function caught(p: Promise<unknown>): Promise<GithubAppError> {
  try { await p; } catch (err) { expect(err).toBeInstanceOf(GithubAppError); return err as GithubAppError; }
  throw new Error("expected a GithubAppError");
}

/** No 8-character piece of any App secret, of `jwt` or of any of `tokens` is in `text`. */
async function expectClean(text: string, jwt: string | null, ...tokens: string[]): Promise<void> {
  const cfg = await config();
  const body = cfg.privateKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  for (const secret of [body, APP.clientSecret, APP.webhookSecret, ...(jwt ? [jwt] : []), ...tokens]) {
    expect(leakedFragments(text, secret), secret.slice(0, 12)).toEqual([]);
  }
}

describe("mintInstallationToken", () => {
  it("POSTs a fresh App JWT to /app/installations/{id}/access_tokens with the repositories and permissions, and returns a Secret", async () => {
    const keys = await makeAppKeys();
    const gh = fakeAppGithub();
    const out = await mintInstallationToken(await config(), 42, { repositories: ["widgets"], permissions: { contents: "read", issues: "read" } },
      { fetchImpl: gh.fetchImpl, now: NOW });
    expect(gh.calls).toHaveLength(1);
    const [c] = gh.calls;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(c.headers).toMatchObject({ accept: "application/vnd.github+json", "user-agent": "trov-worker", "x-github-api-version": "2022-11-28" });
    expect(JSON.parse(c.body)).toEqual({ repositories: ["widgets"], permissions: { contents: "read", issues: "read" } });
    const jwt = c.auth!.replace(/^Bearer /, "");
    expect(c.auth).toBe(`Bearer ${jwt}`);
    expect(await verifyJwt(jwt, keys.publicKey)).toBe(true);
    expect(jwtParts(jwt).claims).toMatchObject({ iss: APP.id, iat: Math.floor(NOW / 1000) - 60 });
    expect(out.token).toBeInstanceOf(Secret);
    expect(out.token.reveal()).toBe(installationToken(42));
    expect(`${out.token}`).toBe("[secret]");
    expect(JSON.stringify(out)).not.toContain(installationToken(42));
    expect(inspect(out)).not.toContain(installationToken(42));
    expect(out.expires_at).toBe("2026-10-06T22:00:00Z");
  });

  it("omits what it was not given (GitHub then grants the installation's own scope)", async () => {
    const gh = fakeAppGithub();
    await mintInstallationToken(await config(), 7, {}, { fetchImpl: gh.fetchImpl, now: NOW });
    expect(JSON.parse(gh.calls[0].body)).toEqual({});
  });

  it("a non-2xx is an `http` error with GitHub's reason — scrubbed of the JWT and every App secret", async () => {
    const gh = fakeAppGithub({ mint: 401 });
    const err = await caught(mintInstallationToken(await config(), 42, { repositories: ["widgets"] }, { fetchImpl: gh.fetchImpl, now: NOW }));
    expect(err.code).toBe("http");
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/^GitHub POST \/app\/installations\/\{id\}\/access_tokens answered 401: Bad credentials/);
    expect(err.message).toContain("[redacted]");
    await expectClean(err.message, gh.calls[0].auth!.replace(/^Bearer /, ""));
    expect(err.message.length).toBeLessThan(260);
  });

  it("a thrown fetch is a `network` error, scrubbed the same way", async () => {
    const gh = fakeAppGithub({ mint: "throw" });
    const err = await caught(mintInstallationToken(await config(), 42, {}, { fetchImpl: gh.fetchImpl, now: NOW }));
    expect(err.code).toBe("network");
    await expectClean(err.message, gh.calls[0].auth!.replace(/^Bearer /, ""));
  });

  it("refuses an installation id that is not a positive integer before any request", async () => {
    const gh = fakeAppGithub();
    for (const id of [0, -1, 1.5, Number.NaN, "42/../x" as unknown as number]) {
      expect((await caught(mintInstallationToken(await config(), id, {}, { fetchImpl: gh.fetchImpl }))).code).toBe("invalid_request");
    }
    expect(gh.calls).toEqual([]);
  });

  it("a key that does not import is `app_key`, in fixed words", async () => {
    const cfg = githubAppConfig(await appEnv(e, { GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMAMCAQA=\n-----END PRIVATE KEY-----" }))!;
    const gh = fakeAppGithub();
    const err = await caught(mintInstallationToken(cfg, 42, {}, { fetchImpl: gh.fetchImpl }));
    expect(err.code).toBe("app_key");
    expect(gh.calls).toEqual([]);
  });
});

describe("getAppInstallation", () => {
  it("reads the account, selection and suspension with the App JWT; a 404 is null", async () => {
    const gh = fakeAppGithub({
      installation: (id) => id === 5 ? { id, account: { login: "Acme", id: 77, type: "User" }, repository_selection: "selected", suspended_at: "2026-10-01T00:00:00Z" } : null,
    });
    const cfg = await config();
    expect(await getAppInstallation(cfg, 5, { fetchImpl: gh.fetchImpl, now: NOW })).toEqual({
      id: 5, account: { login: "Acme", id: 77, type: "User" }, repository_selection: "selected", suspended_at: "2026-10-01T00:00:00Z",
    });
    expect(gh.calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/app/installations/5" });
    expect(gh.calls[0].auth).toMatch(/^Bearer ey/);
    expect(await getAppInstallation(cfg, 6, { fetchImpl: gh.fetchImpl, now: NOW })).toBeNull();
  });

  it("an account Trov cannot hold (an Enterprise) is `invalid_response`", async () => {
    const gh = fakeAppGithub({ installation: (id) => ({ id, account: { login: "ent", id: 1, type: "Enterprise" }, repository_selection: "all", suspended_at: null }) });
    expect((await caught(getAppInstallation(await config(), 5, { fetchImpl: gh.fetchImpl }))).code).toBe("invalid_response");
  });
});

describe("the repository lists", () => {
  const many = (n: number, owner = "acme") => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, full_name: `${owner}/r${i}`, private: i % 2 === 0 }));

  it("listInstallationRepos pages 100 at a time with the installation token, to the end", async () => {
    const gh = fakeAppGithub({ repos: many(105) });
    const token = new Secret(installationToken(3));
    const repos = await listInstallationRepos(token, { fetchImpl: gh.fetchImpl });
    expect(repos).toHaveLength(105);
    expect(repos[0]).toEqual({ id: 1000, full_name: "acme/r0", private: true });
    expect(gh.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/installation/repositories?per_page=100&page=1",
      "https://api.github.com/installation/repositories?per_page=100&page=2",
    ]);
    for (const c of gh.calls) expect(c.auth).toBe(`Bearer ${installationToken(3)}`);
  });

  it("refuses past 10 pages rather than return a prefix as the whole list", async () => {
    const gh = fakeAppGithub({ repos: many(1001) });
    const err = await caught(listInstallationRepos(new Secret(installationToken(3)), { fetchImpl: gh.fetchImpl }));
    expect(err.code).toBe("too_many_repositories");
    expect(gh.calls).toHaveLength(10);
  });

  it("listUserInstallationRepos reads with the PERSON's token; a 404 (their account cannot see it) is null", async () => {
    const gh = fakeAppGithub({ userRepos: many(3) });
    const user = new Secret(USER_TOKEN);
    expect(await listUserInstallationRepos(user, 9, { fetchImpl: gh.fetchImpl })).toHaveLength(3);
    expect(gh.calls[0]).toMatchObject({ url: "https://api.github.com/user/installations/9/repositories?per_page=100&page=1", auth: `Bearer ${USER_TOKEN}` });
    expect(await listUserInstallationRepos(user, 9, { fetchImpl: fakeAppGithub({ userRepos: null }).fetchImpl })).toBeNull();
  });

  it("a failing list's message never carries the token", async () => {
    const echo = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ message: `denied ${JSON.stringify(init?.headers)}` }), { status: 403 })) as typeof fetch;
    const err = await caught(listInstallationRepos(new Secret(installationToken(3)), { fetchImpl: echo }));
    expect(err.code).toBe("http");
    await expectClean(err.message, null, installationToken(3));
    const err2 = await caught(listUserInstallationRepos(new Secret(USER_TOKEN), 9, { fetchImpl: echo }));
    await expectClean(err2.message, null, USER_TOKEN);
  });
});

describe("the install flow's user token", () => {
  it("exchangeUserCode POSTs JSON to github.com with the client id, secret, code and redirect URI, and returns a Secret", async () => {
    const gh = fakeAppGithub();
    const token = await exchangeUserCode(await config(), "code-0123456789abcdef", "https://trov.test/github/app/setup", { fetchImpl: gh.fetchImpl });
    expect(token).toBeInstanceOf(Secret);
    expect(token.reveal()).toBe(USER_TOKEN);
    expect(gh.calls[0]).toMatchObject({ method: "POST", url: "https://github.com/login/oauth/access_token" });
    expect(gh.calls[0].headers).toMatchObject({ accept: "application/json", "content-type": "application/json", "user-agent": "trov-worker" });
    expect(JSON.parse(gh.calls[0].body)).toEqual({
      client_id: APP.clientId, client_secret: APP.clientSecret, code: "code-0123456789abcdef", redirect_uri: "https://trov.test/github/app/setup",
    });
  });

  it("a 200 carrying `error` is an `oauth` failure naming GitHub's error code, never the code or the secret", async () => {
    const code = "code-fedcba9876543210";
    const gh = fakeAppGithub({ exchange: { error: "bad_verification_code", error_description: `the code ${code} is wrong (${APP.clientSecret})` } });
    const err = await caught(exchangeUserCode(await config(), code, "https://trov.test/github/app/setup", { fetchImpl: gh.fetchImpl }));
    expect(err.code).toBe("oauth");
    expect(err.message).toBe("GitHub refused the authorization code: bad_verification_code");
    await expectClean(err.message, null, code);
  });

  it("revokeUserToken DELETEs with basic client auth, and never throws", async () => {
    const gh = fakeAppGithub();
    expect(await revokeUserToken(await config(), new Secret(USER_TOKEN), { fetchImpl: gh.fetchImpl })).toBe(true);
    expect(gh.calls[0]).toMatchObject({ method: "DELETE", url: `https://api.github.com/applications/${APP.clientId}/token` });
    expect(gh.calls[0].auth).toBe(`Basic ${btoa(`${APP.clientId}:${APP.clientSecret}`)}`);
    expect(JSON.parse(gh.calls[0].body)).toEqual({ access_token: USER_TOKEN });
    const dead = (async () => { throw new Error("network down"); }) as typeof fetch;
    expect(await revokeUserToken(await config(), new Secret(USER_TOKEN), { fetchImpl: dead })).toBe(false);
    const refused = (async () => new Response("nope", { status: 422 })) as typeof fetch;
    expect(await revokeUserToken(await config(), new Secret(USER_TOKEN), { fetchImpl: refused })).toBe(false);
  });
});
