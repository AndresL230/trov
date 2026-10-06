// The App JWT (spec §4): RS256 over the App's private key, what GitHub's `/app/*` endpoints authenticate.
// Web Crypto only imports PKCS#8, and GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`), so a PKCS#1 key is
// wrapped into PKCS#8 here, by hand, in DER. The key is imported per call (`extractable: false`) and never
// cached across requests — a JWT is minted once per job, and an isolate holds no key between them.
//
// No error here quotes the key, or any part of it: every message is fixed text.
import { b64uEncode } from "../auth/crypto";
import type { GithubAppConfig } from "./config";

/** A refused private key. Fixed text — the key is never in it. */
export class GithubAppKeyError extends Error {
  constructor(message: string) { super(message); this.name = "GithubAppKeyError"; }
}

// ── DER ──────────────────────────────────────────────────────────────────────

/** A DER length: short form under 128, else 0x80 | n followed by n big-endian bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag: number, content: Uint8Array | number[]): number[] => [tag, ...derLength(content.length), ...content];

/** AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }. */
const RSA_ALGORITHM = der(0x30, [...der(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), 0x05, 0x00]);

/** PrivateKeyInfo { version 0, rsaEncryption, OCTET STRING { the PKCS#1 RSAPrivateKey } } (RFC 5208). */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const octets = [0x04, ...derLength(pkcs1.length)];
  const body = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...octets];
  const head = [0x30, ...derLength(body.length + pkcs1.length)];
  const out = new Uint8Array(head.length + body.length + pkcs1.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(pkcs1, head.length + body.length);
  return out;
}

// ── PEM ──────────────────────────────────────────────────────────────────────

const PEM = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

/**
 * The PKCS#8 DER of a PEM private key: `BEGIN PRIVATE KEY` as it is, `BEGIN RSA PRIVATE KEY` (PKCS#1, what
 * GitHub downloads) wrapped. Anything else — an encrypted key, a public key, a certificate, no PEM at all,
 * a body that is not base64 — is refused, naming the rule and never the input.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const m = PEM.exec(pem);
  if (!m) throw new GithubAppKeyError("the GitHub App private key is not a PEM block");
  const label = m[1];
  if (label !== "PRIVATE KEY" && label !== "RSA PRIVATE KEY") {
    throw new GithubAppKeyError("the GitHub App private key must be BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY (unencrypted)");
  }
  const b64 = m[2].replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new GithubAppKeyError("the GitHub App private key's body is not base64");
  let bin: string;
  try { bin = atob(b64); } catch { throw new GithubAppKeyError("the GitHub App private key's body is not base64"); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] !== 0x30) throw new GithubAppKeyError("the GitHub App private key is not a DER sequence");
  return label === "RSA PRIVATE KEY" ? wrapPkcs1(bytes) : bytes;
}

// ── the JWT ──────────────────────────────────────────────────────────────────

const bytesB64u = (bytes: ArrayBuffer): string => {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * A fresh App JWT: `iat` 60 s in the past (GitHub's advice for clock drift), `exp` 9 minutes ahead (its
 * ceiling is 10), `iss` the App id. Throws `GithubAppKeyError` for a key that does not parse or import.
 */
export async function appJwt(cfg: GithubAppConfig, nowMs: number): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(cfg.privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    if (e instanceof GithubAppKeyError) throw e;
    throw new GithubAppKeyError("the GitHub App private key could not be imported as an RSA key");
  }
  const now = Math.floor(nowMs / 1000);
  const head = b64uEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64uEncode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(cfg.appId) }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${bytesB64u(signature)}`;
}
