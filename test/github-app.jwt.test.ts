/**
 * The GitHub App's own credential and its installation tokens (src/github-app/jwt.ts, api.ts;
 * docs/architecture/github-app.md › Tokens). The key is a THROWAWAY one made for this run
 * (vitest.config.ts); GitHub is a stub that verifies the JWT it is sent.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all } from "./helpers/db";
import { ORG_B, tenantCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { APP_ID, fakeApp, seedInstallation, verifiedAppJwt } from "./helpers/github-app";
import { APP_JWT_SKEW_S, APP_JWT_TTL_S, GithubAppKeyError, appIdOf, pemToPkcs8, pkcs1ToPkcs8, signAppJwt } from "../src/github-app/jwt";
import {
  TOKEN_REFRESH_MARGIN_MS, appConfigured, appSlug, clearInstallationTokens, forgetInstallationToken, installUrl, installationToken, manageUrl, mintInstallationToken,
} from "../src/github-app/api";
import { resolveGithubCredential } from "../src/github-app/credential";
import { clearRepoLists, visibleRepos } from "../src/github-app/repos";
import { liveInstallation } from "../src/github-app/store";

const e = env as unknown as Env;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const PKCS1 = env.GITHUB_APP_PRIVATE_KEY!;
const PKCS8 = env.TEST_GITHUB_APP_PKCS8;

beforeEach(() => { clearInstallationTokens(); clearRepoLists(); });

describe("the App JWT", () => {
  it("is RS256 with iat back-dated, exp under ten minutes and iss the numeric App id — and verifies against the public key", async () => {
    const jwt = await signAppJwt("424242", PKCS1, NOW);
    const v = await verifiedAppJwt(jwt);
    expect(v).not.toBeNull();
    expect(v!.header).toEqual({ alg: "RS256", typ: "JWT" });
    const sec = Math.floor(NOW / 1000);
    expect(v!.claims).toEqual({ iat: sec - APP_JWT_SKEW_S, exp: sec + APP_JWT_TTL_S, iss: APP_ID });
    expect((v!.claims.exp as number) - (v!.claims.iat as number)).toBeLessThanOrEqual(600);
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("imports GitHub's PKCS#1 PEM and a PKCS#8 PEM alike: both sign what the one public key verifies", async () => {
    expect(PKCS1).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(PKCS8).toContain("-----BEGIN PRIVATE KEY-----");
    expect(await verifiedAppJwt(await signAppJwt("424242", PKCS1, NOW))).not.toBeNull();
    expect(await verifiedAppJwt(await signAppJwt("424242", PKCS8, NOW))).not.toBeNull();
    // The wrap IS the conversion: PKCS#1 bytes, wrapped, are byte-for-byte the PKCS#8 file's.
    expect([...pemToPkcs8(PKCS1)]).toEqual([...pemToPkcs8(PKCS8)]);
    // A key pasted on one line with literal \n (a .dev.vars value) reads the same.
    expect(await verifiedAppJwt(await signAppJwt("424242", PKCS1.trim().replace(/\n/g, "\\n"), NOW))).not.toBeNull();
  });

  it("wraps with DER long-form lengths (a 2048-bit key's body is over 255 bytes)", () => {
    const short = pkcs1ToPkcs8(new Uint8Array(10).fill(7));
    expect([...short.subarray(0, 2)]).toEqual([0x30, 3 + 15 + 2 + 10]);
    const long = pkcs1ToPkcs8(new Uint8Array(1200).fill(7));
    expect([...long.subarray(0, 4)]).toEqual([0x30, 0x82, (3 + 15 + 4 + 1200) >> 8, (3 + 15 + 4 + 1200) & 0xff]);
  });

  it("a malformed key fails closed, with an error that carries no part of it", async () => {
    const body = PKCS1.split("\n").slice(1, -2).join("");
    const broken = [
      "", "not a key", "-----BEGIN RSA PRIVATE KEY-----\n!!!!\n-----END RSA PRIVATE KEY-----",
      `-----BEGIN RSA PRIVATE KEY-----\n${body.slice(0, 400)}\n-----END RSA PRIVATE KEY-----`, // truncated: parses as base64, is not a key
      `-----BEGIN PRIVATE KEY-----\n${btoa("x".repeat(600))}\n-----END PRIVATE KEY-----`,     // base64 that is not a key at all
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,                   // mismatched armour
    ];
    for (const pem of broken) {
      const err = await signAppJwt("424242", pem, NOW).then(() => null, (x: unknown) => x);
      expect(err, pem.slice(0, 40)).toBeInstanceOf(GithubAppKeyError);
      const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
      expect(text).not.toContain(body.slice(0, 24));
      expect(text).not.toContain(body.slice(200, 224));
      expect((err as Error).message).toMatch(/^github app key: /);
    }
    await expect(signAppJwt(undefined, PKCS1, NOW)).rejects.toBeInstanceOf(GithubAppKeyError);
    await expect(signAppJwt("Iv1.abcdef", PKCS1, NOW)).rejects.toBeInstanceOf(GithubAppKeyError); // a client id is not the App id
    expect(appIdOf(" 424242 ")).toBe("424242");
    expect(appIdOf("0")).toBeNull();
  });
});

describe("is the App configured on this deployment?", () => {
  it("needs the slug, the id and the key; the links are built from the slug and the installation", () => {
    expect(appConfigured(e)).toBe(true);
    expect(appSlug(e)).toBe("trov-test");
    for (const over of [{ GITHUB_APP_SLUG: "" }, { GITHUB_APP_SLUG: "bad slug/" }, { GITHUB_APP_ID: "" }, { GITHUB_APP_ID: "abc" }, { GITHUB_APP_PRIVATE_KEY: "" }]) {
      expect(appConfigured({ ...e, ...over }), JSON.stringify(over)).toBe(false);
    }
    expect(installUrl("trov-test", "a b")).toBe("https://github.com/apps/trov-test/installations/new?state=a%20b");
    expect(manageUrl({ installation_id: 7, account_login: "acme", account_type: "Organization" })).toBe("https://github.com/organizations/acme/settings/installations/7");
    expect(manageUrl({ installation_id: 7, account_login: "octo", account_type: "User" })).toBe("https://github.com/settings/installations/7");
  });
});

describe("installation tokens", () => {
  const world = () => fakeApp({ now: () => NOW, installations: { 501: { account: { login: "acme", id: 77, type: "Organization" }, repos: [{ full_name: "acme/app" }] } } });

  it("mints with a JWT GitHub accepts, and returns the token with its expiry", async () => {
    const gh = world();
    const minted = await mintInstallationToken(e, 501, gh.fetchImpl, NOW);
    expect(minted).toEqual({ ok: true, token: gh.minted[0], expiresAt: NOW + 3_600_000 });
    expect(gh.seen).toHaveLength(1);
    expect(gh.seen[0].method).toBe("POST");
    expect(gh.seen[0].url).toBe("https://api.github.com/app/installations/501/access_tokens");
  });

  it("ONE mint per installation until shortly before expiry; then a fresh one", async () => {
    const gh = world();
    const first = await installationToken(e, 501, gh.fetchImpl, NOW);
    for (const later of [1, 10 * 60_000, 3_600_000 - TOKEN_REFRESH_MARGIN_MS - 1]) {
      expect(await installationToken(e, 501, gh.fetchImpl, NOW + later)).toEqual(first);
    }
    expect(gh.minted).toHaveLength(1);
    // Concurrent callers share one mint.
    clearInstallationTokens();
    await Promise.all([installationToken(e, 501, gh.fetchImpl, NOW), installationToken(e, 501, gh.fetchImpl, NOW), installationToken(e, 501, gh.fetchImpl, NOW)]);
    expect(gh.minted).toHaveLength(2);
    // Inside the margin the cached token is no longer handed out.
    gh.world.now = () => NOW + 3_600_000 - TOKEN_REFRESH_MARGIN_MS;
    const renewed = await installationToken(e, 501, gh.fetchImpl, NOW + 3_600_000 - TOKEN_REFRESH_MARGIN_MS);
    expect(gh.minted).toHaveLength(3);
    expect(renewed).toMatchObject({ ok: true, token: gh.minted[2] });
    // …and another installation never shares a token.
    gh.world.installations[502] = { account: { login: "beta", id: 78, type: "Organization" }, repos: [] };
    expect(await installationToken(e, 502, gh.fetchImpl, gh.world.now())).toMatchObject({ ok: true, token: gh.minted[3] });
  });

  it("a 401 on a read made with the token forgets it: the next use mints again", async () => {
    await addOrgRepo("acme/app", ORG_B);
    await seedInstallation(ORG_B, 501, "acme");
    const gh = world();
    const ctx = await tenantCtx("bob", "admin", { orgId: ORG_B });
    const cred = (await resolveGithubCredential(ctx, e, { repo: "acme/app", fetchImpl: gh.fetchImpl, now: NOW }))!;
    expect(cred.source).toBe("app");
    expect(cred.token.reveal()).toBe(gh.minted[0]);
    // The reader's fetch sees a 401 (the token was revoked on GitHub's side).
    const watched = cred.fetch((async () => new Response("{}", { status: 401 })) as typeof fetch)!;
    await watched("https://api.github.com/repos/acme/app", { headers: { authorization: `Bearer ${cred.token.reveal()}` } });
    const again = (await resolveGithubCredential(ctx, e, { repo: "acme/app", fetchImpl: gh.fetchImpl, now: NOW }))!;
    expect(gh.minted).toHaveLength(2);
    expect(again.token.reveal()).toBe(gh.minted[1]);
    // An explicit forget does the same; a 200 does not.
    forgetInstallationToken(e, 501);
    await resolveGithubCredential(ctx, e, { repo: "acme/app", fetchImpl: gh.fetchImpl, now: NOW });
    expect(gh.minted).toHaveLength(3);
    const ok = (await resolveGithubCredential(ctx, e, { repo: "acme/app", fetchImpl: gh.fetchImpl, now: NOW }))!;
    await ok.fetch((async () => new Response("{}", { status: 200 })) as typeof fetch)!("https://api.github.com/x");
    await resolveGithubCredential(ctx, e, { repo: "acme/app", fetchImpl: gh.fetchImpl, now: NOW });
    expect(gh.minted).toHaveLength(3);
  });

  it("a refusal says WHY in fixed words — gone, suspended, the App's own credentials, an outage — and is never cached", async () => {
    const gh = world();
    gh.world.installations[501].gone = true;
    expect(await installationToken(e, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: false, kind: "not_found", status: 404 });
    gh.world.installations[501] = { ...gh.world.installations[501], gone: false, suspended: true };
    expect(await installationToken(e, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: false, kind: "suspended", status: 403 });
    gh.world.installations[501].suspended = false;
    gh.world.badAppCredentials = true;
    expect(await installationToken(e, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: false, kind: "credentials", status: 401 });
    gh.world.badAppCredentials = false;
    gh.world.intercept = () => new Response("upstream down", { status: 502 });
    expect(await installationToken(e, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: false, kind: "failed", status: 502 });
    gh.world.intercept = () => { throw new Error("connect failed"); };
    expect(await installationToken(e, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: false, kind: "failed", status: 0 });
    // A key that does not import is the App's problem too — and nothing was sent.
    const before = gh.seen.length;
    expect(await installationToken({ ...e, GITHUB_APP_PRIVATE_KEY: "nope" }, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: false, kind: "credentials" });
    expect(gh.seen).toHaveLength(before);
    gh.world.intercept = undefined;
    expect(await installationToken(e, 501, gh.fetchImpl, NOW)).toMatchObject({ ok: true }); // none of the refusals stuck
  });
});

describe("nothing leaks", () => {
  it("an upstream that echoes the Authorization header back: no token, JWT or key material reaches a log line or a D1 column", async () => {
    await addOrgRepo("acme/app", ORG_B);
    await seedInstallation(ORG_B, 501, "acme");
    const ctx = await tenantCtx("bob", "admin", { orgId: ORG_B });
    const gh = fakeApp({ now: () => NOW, installations: { 501: { account: { login: "acme", id: 77, type: "Organization" }, repos: [{ full_name: "acme/app" }] } } });
    const jwts: string[] = [];
    const logged: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args); }));
    try {
      // 1. the mint itself is refused, quoting the JWT it was sent.
      gh.world.intercept = (s) => {
        if (!s.url.includes("/app/installations/")) return undefined;
        jwts.push(s.auth ?? "");
        return new Response(JSON.stringify({ message: `denied: authorization=${s.auth}` }), { status: 500 });
      };
      expect(await resolveGithubCredential(ctx, e, { repo: "acme/app", fetchImpl: gh.fetchImpl, now: NOW })).toBeNull();
      // 2. the mint works; the read made with the token is refused, quoting the token (in a body AND a thrown fetch).
      gh.world.intercept = (s) => (s.url.includes("/installation/repositories") ? new Response(JSON.stringify({ message: `denied: authorization=${s.auth}` }), { status: 500 }) : undefined);
      expect(await visibleRepos(ctx, e, { fetchImpl: gh.fetchImpl, now: NOW })).toMatchObject({ ok: false, reason: "github_failed" });
      gh.world.intercept = (s) => { if (s.url.includes("/installation/repositories")) throw new Error(`fetch failed with authorization=${s.auth}`); return undefined; };
      expect(await visibleRepos(ctx, e, { fetchImpl: gh.fetchImpl, now: NOW, refresh: true })).toMatchObject({ ok: false, reason: "github_failed" });
    } finally { for (const s of spies) s.mockRestore(); }

    expect(jwts.length).toBeGreaterThan(0);
    expect(gh.minted.length).toBeGreaterThan(0);
    const secrets = [...gh.minted, ...jwts.map((j) => j.replace(/^Bearer /, "")), ...jwts.map((j) => j.split(".")[2]), PKCS1.split("\n")[1], PKCS1.split("\n")[5]];
    const text = JSON.stringify(logged.map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : a))));
    for (const s of secrets) expect(text, "console").not.toContain(s);
    // Every column of every table: nothing minted or signed was ever written.
    const tables = await all<{ name: string }>(env.DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '%_fts%'`);
    for (const t of tables) {
      const dump = JSON.stringify(await all(env.DB, `SELECT * FROM "${t.name}"`));
      for (const s of secrets) expect(dump, t.name).not.toContain(s);
    }
    // …and the binding says what went wrong, in fixed words.
    expect((await liveInstallation(ctx))?.last_error).toBe("list the installation's repositories: github request failed");
  });
});
