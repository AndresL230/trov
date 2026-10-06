// The GitHub App's platform configuration (issue #95; docs/superpowers/specs/2026-10-06-github-app-design.md §2):
// six Worker secrets, ONE App for every org. Pure — no D1, no network, no clock.
//
// None of these values is ever logged, returned, put in an error or stored in D1. `appSecrets` is the list
// every scrub of a GitHub App message includes (src/github-app/client.ts, credential.ts).
import type { Env } from "../env";

export interface GithubAppConfig {
  appId: string;          // the App JWT's `iss`
  slug: string;           // https://github.com/apps/<slug>
  clientId: string;       // the install flow's OAuth hop
  clientSecret: string;
  privateKeyPem: string;  // PKCS#1 or PKCS#8 PEM, real newlines
  webhookSecret: string;  // `POST /webhook/github-app`'s HMAC
}

const value = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The App's config, or null = "not configured": no Install button, `/webhook/github-app` is a bare 401 and
 * every org keeps its pasted token. ALL SIX must be non-empty after a trim — one missing secret is an App
 * that cannot work, never a partial one. A private key set as ONE line (`.dev.vars` cannot hold a newline)
 * carries literal `\n` escapes; they are turned back into newlines here, so the PEM parser sees one shape.
 */
export function githubAppConfig(env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_SLUG" | "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_APP_WEBHOOK_SECRET">): GithubAppConfig | null {
  const appId = value(env.GITHUB_APP_ID);
  const slug = value(env.GITHUB_APP_SLUG);
  const clientId = value(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = value(env.GITHUB_APP_CLIENT_SECRET);
  const rawKey = value(env.GITHUB_APP_PRIVATE_KEY);
  const webhookSecret = value(env.GITHUB_APP_WEBHOOK_SECRET);
  if (!appId || !slug || !clientId || !clientSecret || !rawKey || !webhookSecret) return null;
  return { appId, slug, clientId, clientSecret, privateKeyPem: rawKey.replace(/\\n/g, "\n"), webhookSecret };
}

/**
 * What every scrub of an App message includes: the private key — whole, and its base64 body with the line
 * breaks removed, so a quote of the key in either spelling is caught — the client secret and the webhook
 * secret. The app id, slug and client id are public (GitHub prints them on the App's page).
 */
export function appSecrets(cfg: GithubAppConfig): string[] {
  const body = cfg.privateKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return [cfg.privateKeyPem, body, cfg.clientSecret, cfg.webhookSecret].filter((v) => v.length > 0);
}
