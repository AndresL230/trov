// The GitHub App in tests (src/github-app/): a generated RSA key in both PEM forms, an Env with all six
// GITHUB_APP_* secrets set (the pool blanks them — vitest.config.ts), and a fake GitHub that answers the
// App's six calls and records what each request carried. Nothing reaches the network.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";

const b64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const pem = (label: string, der: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${b64(der).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/** One DER element at `at`: its tag, where its content starts, and its length. */
function derAt(bytes: Uint8Array, at: number): { tag: number; start: number; length: number } {
  const tag = bytes[at];
  let length = bytes[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + bytes[at + 2 + i];
    start += n;
  }
  return { tag, start, length };
}

/** The PKCS#1 RSAPrivateKey inside a PKCS#8 PrivateKeyInfo: SEQUENCE { INTEGER, SEQUENCE, OCTET STRING { … } }. */
export function unwrapPkcs8(pkcs8: Uint8Array): Uint8Array {
  const outer = derAt(pkcs8, 0);
  const version = derAt(pkcs8, outer.start);
  const algorithm = derAt(pkcs8, version.start + version.length);
  const octets = derAt(pkcs8, algorithm.start + algorithm.length);
  if (outer.tag !== 0x30 || version.tag !== 0x02 || algorithm.tag !== 0x30 || octets.tag !== 0x04) throw new Error("not a PKCS#8 RSA key");
  return pkcs8.slice(octets.start, octets.start + octets.length);
}

export interface AppKeys {
  pkcs8: Uint8Array;
  pkcs8Pem: string;    // BEGIN PRIVATE KEY
  pkcs1Pem: string;    // BEGIN RSA PRIVATE KEY — what GitHub downloads
  publicKey: CryptoKey;
}

let cached: AppKeys | null = null;

/** An RSA-2048 key (generated once per test file — it takes a moment). */
export async function makeAppKeys(): Promise<AppKeys> {
  if (cached) return cached;
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  cached = { pkcs8, pkcs8Pem: pem("PRIVATE KEY", pkcs8), pkcs1Pem: pem("RSA PRIVATE KEY", unwrapPkcs8(pkcs8)), publicKey: pair.publicKey };
  return cached;
}

/** The six values `appEnv` sets — 64-character secrets, the length a real one has (`LONG_TOKEN`'s lesson). */
export const APP = {
  id: "424242",
  slug: "trov-test-app",
  clientId: "Iv23liTestClientId01",
  clientSecret: "cs".padEnd(64, "0123456789abcdef"),
  webhookSecret: "wh".padEnd(64, "fedcba9876543210"),
};

/** `e` with the App configured: all six secrets, the key PKCS#1 by default (as GitHub issues it). */
export async function appEnv(e: Env = env as unknown as Env, over: Partial<Env> = {}): Promise<Env> {
  const keys = await makeAppKeys();
  return {
    ...e,
    GITHUB_APP_ID: APP.id,
    GITHUB_APP_SLUG: APP.slug,
    GITHUB_APP_CLIENT_ID: APP.clientId,
    GITHUB_APP_CLIENT_SECRET: APP.clientSecret,
    GITHUB_APP_PRIVATE_KEY: keys.pkcs1Pem,
    GITHUB_APP_WEBHOOK_SECRET: APP.webhookSecret,
    ...over,
  };
}

/** The installation token the fake mints for installation `id` — 64 characters after its prefix. */
export const installationToken = (id: number): string => `ghs_inst${id}_`.padEnd(68, "9a8b7c6d5e4f3021");
export const USER_TOKEN = "ghu_".padEnd(68, "1029384756abcdef");

export interface AppCall { method: string; url: string; auth: string | null; headers: Record<string, string>; body: string }

export interface FakeAppGithub {
  /** `POST /app/installations/{id}/access_tokens`: a status (201 by default) or a throw. */
  mint?: number | "throw";
  /** `GET /app/installations/{id}` → this object (null = 404). Default: an Organization account, all repos. */
  installation?: (id: number) => Record<string, unknown> | null;
  /** `GET /installation/repositories` — the installation's repos. */
  repos?: { id: number; full_name: string; private?: boolean }[];
  /** `GET /user/installations/{id}/repositories` — the person's (null = 404). */
  userRepos?: { id: number; full_name: string; private?: boolean }[] | null;
  /** The code exchange's body (default `{ access_token: USER_TOKEN }`). */
  exchange?: Record<string, unknown>;
  /** Any other request (the jobs' own GitHub reads): answered by this, else `[]`. */
  fallback?: typeof fetch;
}

/**
 * A fake GitHub for the App's calls, recording each request (its method, URL, authorization, every header
 * and the body). A failing answer ECHOES the request — headers and body — back, the worst an upstream can do.
 */
export function fakeAppGithub(o: FakeAppGithub = {}): { fetchImpl: typeof fetch; calls: AppCall[] } {
  const calls: AppCall[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers);
    const call: AppCall = { method: init?.method ?? "GET", url, auth: h.get("authorization"), headers: Object.fromEntries(h), body: String(init?.body ?? "") };
    calls.push(call);
    const echo = `echo authorization=${call.auth} headers=${JSON.stringify(call.headers)} body=${call.body}`;
    const u = new URL(url);
    let m: RegExpExecArray | null;
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname)) && call.method === "POST") {
      if (o.mint === "throw") throw new Error(`connection reset: ${echo}`);
      const status = o.mint ?? 201;
      if (status !== 201) return json({ message: `Bad credentials ${echo}` }, status);
      return json({ token: installationToken(Number(m[1])), expires_at: "2026-10-06T22:00:00Z", permissions: {}, repository_selection: "selected" }, 201);
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(u.pathname))) {
      const id = Number(m[1]);
      const inst = o.installation ? o.installation(id) : { id, account: { login: "acme", id: 9001, type: "Organization" }, repository_selection: "all", suspended_at: null };
      return inst ? json(inst) : json({ message: "Not Found" }, 404);
    }
    const page = Number(u.searchParams.get("page") ?? "1");
    const per = Number(u.searchParams.get("per_page") ?? "30");
    const pageOf = (list: { id: number; full_name: string; private?: boolean }[]) =>
      json({ total_count: list.length, repositories: list.slice((page - 1) * per, page * per).map((r) => ({ ...r, private: r.private ?? false })) });
    if (u.pathname === "/installation/repositories") return pageOf(o.repos ?? []);
    if (/^\/user\/installations\/\d+\/repositories$/.test(u.pathname)) return o.userRepos === null ? json({ message: "Not Found" }, 404) : pageOf(o.userRepos ?? o.repos ?? []);
    if (url === "https://github.com/login/oauth/access_token") return json(o.exchange ?? { access_token: USER_TOKEN, token_type: "bearer", scope: "" });
    if (/^\/applications\/[^/]+\/token$/.test(u.pathname) && call.method === "DELETE") return new Response(null, { status: 204 });
    if (o.fallback) return await o.fallback(input, init); // awaited here, so a throwing fallback is never an unhandled rejection
    return json([]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Decode a JWT's header and claims (no verification — `verifyJwt` does that). */
export function jwtParts(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; signature: Uint8Array } {
  const [h, c, s] = jwt.split(".");
  const dec = (x: string) => JSON.parse(new TextDecoder().decode(b64uBytes(x))) as Record<string, unknown>;
  return { header: dec(h), claims: dec(c), signed: `${h}.${c}`, signature: b64uBytes(s) };
}

function b64uBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Does `jwt`'s RS256 signature verify with `publicKey`? */
export async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const { signed, signature } = jwtParts(jwt);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, new TextEncoder().encode(signed));
}

/** Bind installation `id` to `orgId` straight in D1 (fixture SQL), with `repos` as its list. */
export async function seedInstallation(orgId: string, id: number, repos: { id: number; full_name: string }[] = [], o: { suspended?: string | null; login?: string } = {}): Promise<void> {
  const at = "2026-10-06T00:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO github_installations (installation_id, org_id, account_login, account_id, account_type, repository_selection, suspended_at, connected_by, connected_at, updated_at)
     VALUES (?, ?, ?, 9001, 'Organization', 'selected', ?, 'AndresL230', ?, ?)`,
  ).bind(id, orgId, o.login ?? "acme", o.suspended ?? null, at, at).run();
  for (const r of repos) {
    await env.DB.prepare(`INSERT INTO github_installation_repos (org_id, installation_id, repo_id, repo_full_name, private) VALUES (?, ?, ?, ?, 0)`)
      .bind(orgId, id, r.id, r.full_name).run();
  }
}

/** Attach an `org_repos` row to installation `id` (fixture SQL). */
export const attachRepo = (orgRepoId: string, id: number | null) =>
  env.DB.prepare(`UPDATE org_repos SET installation_id = ? WHERE id = ?`).bind(id, orgRepoId).run();
