// The App's own credential: an RS256 JWT signed with GITHUB_APP_PRIVATE_KEY (docs/architecture/github-app.md).
// WebCrypto only. Nothing here logs, and every error it throws is FIXED TEXT — never the PEM, never a
// byte of it, never the underlying exception (an importKey failure can quote its input).
import { b64uEncode } from "../auth/crypto";

/** The App is not usable: no id, no key, or a key that does not import. A route answers "not configured". */
export class GithubAppKeyError extends Error {
  readonly code = "github_app_key" as const;
  constructor(why: string) { super(`github app key: ${why}`); this.name = "GithubAppKeyError"; }
}

/** GitHub refuses a JWT that lives longer than 10 minutes; a minute less leaves room for the skew below. */
export const APP_JWT_TTL_S = 9 * 60;
/** `iat` is back-dated: GitHub rejects a token "issued in the future" when its clock runs behind ours. */
export const APP_JWT_SKEW_S = 60;

const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** DER length octets: short form under 128, else 0x80 | n followed by the length in n bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}
const der = (tag: number, body: Uint8Array | number[]): Uint8Array => Uint8Array.from([tag, ...derLength(body.length), ...body]);

// AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/**
 * A PKCS#1 `RSAPrivateKey` (what GitHub's `.pem` holds: `-----BEGIN RSA PRIVATE KEY-----`) wrapped as the
 * PKCS#8 `PrivateKeyInfo` WebCrypto imports:
 *   SEQUENCE { INTEGER 0, AlgorithmIdentifier rsaEncryption, OCTET STRING { the PKCS#1 bytes } }
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return der(0x30, [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...der(0x04, pkcs1)]);
}

const PEM = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----/;

/** The PKCS#8 DER of a private-key PEM — PKCS#1 (GitHub's) or PKCS#8. `\n` typed literally (a key pasted
 *  into a one-line secret) is read as a line break. Throws `GithubAppKeyError`, fixed text. */
export function pemToPkcs8(pem: string): Uint8Array {
  const m = PEM.exec(pem.replace(/\\n/g, "\n"));
  if (!m) throw new GithubAppKeyError("not a PEM private key");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (ch) => ch.charCodeAt(0)); }
  catch { throw new GithubAppKeyError("the PEM body is not base64"); }
  if (bytes.length < 64) throw new GithubAppKeyError("the PEM body is too short");
  return m[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(bytes) : bytes;
}

// Imported once per isolate and per value: non-extractable, sign ONLY. A failed import is not kept.
const keys = new Map<string, Promise<CryptoKey>>();

async function importKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8(pem);
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new GithubAppKeyError("the key could not be imported"); // never the cause: it may quote the key
  }
}

function signingKey(pem: string): Promise<CryptoKey> {
  let held = keys.get(pem);
  if (!held) {
    held = importKey(pem);
    keys.set(pem, held);
    held.catch(() => keys.delete(pem));
  }
  return held;
}

/** The numeric App id as GitHub wants it in `iss`, or null when the value is not one. */
export function appIdOf(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return /^[1-9][0-9]{0,14}$/.test(v) ? v : null;
}

/**
 * An App JWT: `{ alg: RS256, typ: JWT }` . `{ iat: now − 60 s, exp: now + 9 min, iss: <app id> }`, signed
 * RSASSA-PKCS1-v1_5 / SHA-256. `now` is epoch milliseconds. Throws `GithubAppKeyError` (fixed text).
 */
export async function signAppJwt(appId: string | undefined, pem: string | undefined, now: number = Date.now()): Promise<string> {
  const iss = appIdOf(appId);
  if (!iss) throw new GithubAppKeyError("GITHUB_APP_ID is not set to the numeric App id");
  if (!pem) throw new GithubAppKeyError("GITHUB_APP_PRIVATE_KEY is not set");
  const key = await signingKey(pem);
  const sec = Math.floor(now / 1000);
  const head = b64uEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // `iss` goes out as a NUMBER — the form GitHub has always documented for an App id (a string is for a client id).
  const claims = b64uEncode(JSON.stringify({ iat: sec - APP_JWT_SKEW_S, exp: sec + APP_JWT_TTL_S, iss: Number(iss) }));
  let sig: ArrayBuffer;
  try { sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`)); }
  catch { throw new GithubAppKeyError("the key could not sign"); }
  return `${head}.${claims}.${b64u(sig)}`;
}
