// The GitHub App's configuration and its JWT (src/github-app/config.ts, jwt.ts; spec §2, §4): all six secrets
// or "not configured"; a PKCS#1 key (what GitHub downloads) wrapped into PKCS#8 by hand and a PKCS#8 key taken
// as it is, both signing a JWT the public key verifies; and a key that is not one refused in fixed words.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { appSecrets, githubAppConfig } from "../src/github-app/config";
import { appJwt, GithubAppKeyError, pemToPkcs8 } from "../src/github-app/jwt";
import { APP, appEnv, jwtParts, makeAppKeys, verifyJwt } from "./helpers/github-app";
import { leakedFragments } from "./helpers/repo";

const e = env as unknown as Env;
const NOW = Date.parse("2026-10-06T21:00:00.000Z");

describe("githubAppConfig", () => {
  it("is null in the pool (every GITHUB_APP_* is blanked) and with any ONE of the six missing or blank", async () => {
    expect(githubAppConfig(e)).toBeNull();
    const full = await appEnv();
    expect(githubAppConfig(full)).not.toBeNull();
    for (const key of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"] as const) {
      expect(githubAppConfig({ ...full, [key]: undefined }), key).toBeNull();
      expect(githubAppConfig({ ...full, [key]: "   " }), key).toBeNull();
    }
  });

  it("trims each value and turns a one-line key's literal \\n escapes back into newlines", async () => {
    const keys = await makeAppKeys();
    const oneLine = keys.pkcs1Pem.trim().replace(/\n/g, "\\n");
    expect(oneLine).not.toContain("\n");
    const cfg = githubAppConfig(await appEnv(e, { GITHUB_APP_ID: ` ${APP.id} `, GITHUB_APP_PRIVATE_KEY: oneLine }))!;
    expect(cfg).toMatchObject({ appId: APP.id, slug: APP.slug, clientId: APP.clientId, clientSecret: APP.clientSecret, webhookSecret: APP.webhookSecret });
    expect(cfg.privateKeyPem).toBe(keys.pkcs1Pem.trim());
    expect(Array.from(pemToPkcs8(cfg.privateKeyPem))).toEqual(Array.from(keys.pkcs8));
  });

  it("appSecrets lists the key (both spellings), the client secret and the webhook secret — never the public ids", async () => {
    const cfg = githubAppConfig(await appEnv())!;
    const list = appSecrets(cfg);
    expect(list).toEqual(expect.arrayContaining([cfg.privateKeyPem, APP.clientSecret, APP.webhookSecret]));
    expect(list.some((v) => !v.includes("\n") && cfg.privateKeyPem.replace(/\s+/g, "").includes(v) && v.length > 1000)).toBe(true);
    for (const pub of [APP.id, APP.slug, APP.clientId]) expect(list).not.toContain(pub);
  });
});

describe("pemToPkcs8", () => {
  it("takes PKCS#8 as it is, and wraps PKCS#1 into the SAME PKCS#8 bytes (long-form DER lengths included)", async () => {
    const keys = await makeAppKeys();
    expect(Array.from(pemToPkcs8(keys.pkcs8Pem))).toEqual(Array.from(keys.pkcs8));
    const wrapped = pemToPkcs8(keys.pkcs1Pem);
    expect(wrapped[1]).toBe(0x82); // a 2048-bit key's PrivateKeyInfo is over 255 bytes: two length bytes
    expect(Array.from(wrapped)).toEqual(Array.from(keys.pkcs8));
  });

  it("refuses anything else in fixed words — never quoting the input", async () => {
    const keys = await makeAppKeys();
    const body = keys.pkcs8Pem.replace(/-----[A-Z ]+-----/g, "").trim();
    const bad = [
      "",
      body,                                                              // no PEM armour
      keys.pkcs8Pem.replace(/PRIVATE KEY/g, "PUBLIC KEY"),               // a public key
      keys.pkcs8Pem.replace(/PRIVATE KEY/g, "ENCRYPTED PRIVATE KEY"),    // an encrypted key
      "-----BEGIN RSA PRIVATE KEY-----\nnot*base64!\n-----END RSA PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",     // base64, not a DER sequence
    ];
    for (const pem of bad) {
      let caught: unknown;
      try { pemToPkcs8(pem); } catch (err) { caught = err; }
      expect(caught, pem.slice(0, 40)).toBeInstanceOf(GithubAppKeyError);
      expect(leakedFragments((caught as Error).message, body.replace(/\s+/g, ""), 8)).toEqual([]);
    }
  });
});

describe("appJwt", () => {
  for (const form of ["pkcs1Pem", "pkcs8Pem"] as const) {
    it(`signs RS256 with a ${form === "pkcs1Pem" ? "PKCS#1" : "PKCS#8"} key: the public key verifies it, and the claims are GitHub's`, async () => {
      const keys = await makeAppKeys();
      const cfg = githubAppConfig(await appEnv(e, { GITHUB_APP_PRIVATE_KEY: keys[form] }))!;
      const jwt = await appJwt(cfg, NOW + 999); // the clock's milliseconds are floored away
      expect(await verifyJwt(jwt, keys.publicKey)).toBe(true);
      const { header, claims } = jwtParts(jwt);
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      const now = Math.floor(NOW / 1000);
      expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: APP.id });
      expect(typeof claims.iss).toBe("string");
      // A tampered claim no longer verifies.
      const [h, , s] = jwt.split(".");
      const forged = `${h}.${btoa(JSON.stringify({ ...claims, iss: "1" })).replace(/=+$/, "")}.${s}`;
      expect(await verifyJwt(forged, keys.publicKey)).toBe(false);
    });
  }

  it("a key that parses but is no RSA key is refused in fixed words", async () => {
    const junk = "-----BEGIN PRIVATE KEY-----\nMAMCAQA=\n-----END PRIVATE KEY-----"; // SEQUENCE { INTEGER 0 }
    const cfg = githubAppConfig(await appEnv(e, { GITHUB_APP_PRIVATE_KEY: junk }))!;
    await expect(appJwt(cfg, NOW)).rejects.toBeInstanceOf(GithubAppKeyError);
    await expect(appJwt(cfg, NOW)).rejects.toThrow("the GitHub App private key could not be imported as an RSA key");
  });
});
