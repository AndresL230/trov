// A stubbed GitHub for the App's tests (src/github-app/): the token exchange, the user endpoints, the
// App's own endpoints and an installation's repository list — answered from a small in-memory world,
// with every request recorded. Never the network.
import { env } from "cloudflare:test";
import { b64uToBytes } from "../../src/auth/crypto";

export const APP_ID = 424242; // vitest.config.ts
export const APP_WEBHOOK_SECRET = "test-app-webhook-secret";

export interface FakeInstallation {
  account: { login: string; id: number; type: "User" | "Organization" };
  repos: { full_name: string; private?: boolean }[];
  selection?: "all" | "selected";
  suspended?: boolean;
  /** GitHub no longer knows it (uninstalled): 404 on every App request about it. */
  gone?: boolean;
}
export interface Seen { method: string; url: string; auth: string | null; body: string }

export interface FakeWorld {
  /** The GitHub account the OAuth code belongs to. null = the exchange fails. */
  user: { login: string; id: number } | null;
  installations: Record<number, FakeInstallation>;
  /** The installations `GET /user/installations` lists for `user`. */
  reachable: number[];
  /** How many of an installation's repositories `user` can read; default = all of them. */
  userRepoCount: Record<number, number>;
  /** Respond to App-JWT requests with 401 (a wrong key / app id). */
  badAppCredentials?: boolean;
  /** Called first; a Response (or a throw) overrides the world's answer. */
  intercept?: (s: Seen) => Response | undefined;
  now: () => number;
}

export interface FakeApp { fetchImpl: typeof fetch; seen: Seen[]; minted: string[]; world: FakeWorld; tokenFor(id: number): string | undefined }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The claims of a JWT whose RS256 signature verifies against the pool's throwaway public key, else null. */
export async function verifiedAppJwt(jwt: string): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown> } | null> {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) return null;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.TEST_GITHUB_APP_PUBLIC_JWK) as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uToBytes(s), new TextEncoder().encode(`${h}.${c}`));
  if (!ok) return null;
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(b64uToBytes(part))) as Record<string, unknown>;
  return { header: decode(h), claims: decode(c) };
}

export function fakeApp(over: Partial<FakeWorld> = {}): FakeApp {
  const world: FakeWorld = { user: { login: "AndresL230", id: 9001 }, installations: {}, reachable: [], userRepoCount: {}, now: () => Date.now(), ...over };
  const seen: Seen[] = [];
  const minted: string[] = [];
  const tokens = new Map<string, number>(); // token → installation id
  const USER_TOKEN = "ghu_user_token_0123456789abcdef0123";

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), url, auth, body: typeof init?.body === "string" ? init.body : "" };
    seen.push(s);
    const forced = world.intercept?.(s);
    if (forced) return forced;
    const bearer = auth?.replace(/^Bearer /, "") ?? "";
    const u = new URL(url);

    if (url === "https://github.com/login/oauth/access_token") return world.user ? json({ access_token: USER_TOKEN }) : json({ error: "bad_verification_code" });
    if (u.host !== "api.github.com") return new Response("not found", { status: 404 });

    // ── as the user ──
    if (u.pathname === "/user" || u.pathname === "/user/emails" || u.pathname.startsWith("/user/installations")) {
      if (bearer !== USER_TOKEN || !world.user) return json({ message: "Bad credentials" }, 401);
      if (u.pathname === "/user") return json({ id: world.user.id, login: world.user.login, name: null, avatar_url: null });
      if (u.pathname === "/user/emails") return json([]);
      if (u.pathname === "/user/installations") {
        const list = world.reachable.filter((id) => world.installations[id] && !world.installations[id].gone);
        return json({ total_count: list.length, installations: list.map((id) => ({ id, account: world.installations[id].account })) });
      }
      const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(u.pathname);
      if (m) {
        const id = Number(m[1]);
        const inst = world.installations[id];
        if (!inst || !world.reachable.includes(id)) return json({ message: "Not Found" }, 404);
        return json({ total_count: world.userRepoCount[id] ?? inst.repos.length, repositories: [] });
      }
    }

    // ── as the App (a JWT) ──
    const app = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(u.pathname);
    if (app) {
      const jwt = await verifiedAppJwt(bearer);
      const nowS = Math.floor(world.now() / 1000);
      const c = jwt?.claims;
      if (world.badAppCredentials || !jwt || c?.iss !== APP_ID || typeof c.exp !== "number" || typeof c.iat !== "number" || c.exp <= nowS || c.exp - c.iat > 600 || c.iat > nowS) {
        return json({ message: `A JSON web token could not be decoded (authorization: ${auth})` }, 401);
      }
      const id = Number(app[1]);
      const inst = world.installations[id];
      if (!inst || inst.gone) return json({ message: "Not Found" }, 404);
      if (app[2]) {
        if (s.method !== "POST") return json({ message: "Not Found" }, 404);
        if (inst.suspended) return json({ message: "This installation has been suspended" }, 403);
        const token = `ghs_inst${id}_${String(minted.length + 1).padStart(2, "0")}_${"0123456789abcdef".repeat(2)}`;
        minted.push(token);
        tokens.set(token, id);
        return json({ token, expires_at: new Date(world.now() + 3_600_000).toISOString(), permissions: { contents: "read" }, repository_selection: inst.selection ?? "all" }, 201);
      }
      return json({ id, account: { ...inst.account, avatar_url: `https://avatars.githubusercontent.com/u/${inst.account.id}?v=4` }, repository_selection: inst.selection ?? "all", suspended_at: inst.suspended ? "2026-10-01T00:00:00Z" : null });
    }

    // ── as an installation ──
    if (u.pathname === "/installation/repositories") {
      const id = tokens.get(bearer);
      const inst = id === undefined ? undefined : world.installations[id];
      if (!inst || inst.gone || inst.suspended) return json({ message: `Bad credentials (authorization: ${auth})` }, 401);
      const per = Number(u.searchParams.get("per_page") ?? 30);
      const page = Number(u.searchParams.get("page") ?? 1);
      return json({ total_count: inst.repos.length, repositories: inst.repos.slice((page - 1) * per, page * per).map((r) => ({ full_name: r.full_name, private: r.private === true })) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, seen, minted, world, tokenFor: (id) => [...tokens].reverse().find(([, i]) => i === id)?.[0] };
}

/** Bind an installation to an org directly (what the connect flow writes), for tests that start connected. */
export async function seedInstallation(orgId: string, installationId: number, account: string, o: { type?: "User" | "Organization"; by?: string; suspended?: boolean; accountId?: string } = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO org_github_installations (org_id, installation_id, account_login, account_id, account_type, repository_selection, connected_by, connected_at, suspended_at)
     VALUES (?, ?, ?, ?, ?, 'all', ?, '2026-10-06T00:00:00.000Z', ?)`,
  ).bind(orgId, installationId, account, o.accountId ?? String(installationId), o.type ?? "Organization", o.by ?? "AndresL230", o.suspended ? "2026-10-06T00:00:00.000Z" : null).run();
}

export async function signAppWebhook(body: string, secret: string = APP_WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
