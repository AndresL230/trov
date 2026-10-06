// canopy-multitenancy.md §10.5 — the envelope encryption itself (src/data/secrets.ts): round trip,
// IVs, rotation of a secret / the org's data key / the platform key, the moved-ciphertext cases (D19),
// and who `getSecret` serves.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  Secret, SecretAccessError, SecretConflictError, SecretDecryptError, SecretNotFoundError, SecretValueError, SecretsUnavailableError,
  deleteSecret, getSecret, getSecretMeta, lastErrorText, listOrgAudit, markSecretUsed, recordSecretOutcome,
  rotateOrgKey, rotateSecret, scrub, secretsAvailable, setSecret,
} from "../src/data/secrets";
import { RoleError } from "../src/data/context";
import { ORG_A, ORG_B, bearerCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const TOKEN = "tok_" + "A1b2C3d4".repeat(8); // 68 characters
const OTHER = "tok_" + "z9Y8x7W6".repeat(8);
const owner = () => tenantCtx("AndresL230");
const ownerB = () => tenantCtx("bob-b", "owner", { orgId: ORG_B });

const row = (orgId: string, kind: string, scope: string) =>
  env.DB.prepare(`SELECT * FROM org_secrets WHERE org_id = ? AND kind = ? AND scope = ?`).bind(orgId, kind, scope)
    .first<{ ciphertext: string; iv: string; key_version: number; hint_last4: string; rotated_at: string | null; last_used_at: string | null; last_error: string | null }>();
const keyRows = (orgId: string) =>
  env.DB.prepare(`SELECT * FROM org_keys WHERE org_id = ? ORDER BY key_version`).bind(orgId)
    .all<{ key_version: number; wrapped_key: string; wrap_iv: string; kek_fingerprint: string; retired_at: string | null }>().then((r) => r.results);

describe("Secret", () => {
  it("renders [secret] however it is stringified, and reveals only through reveal()", () => {
    const s = new Secret(TOKEN);
    expect(String(s)).toBe("[secret]");
    expect(`${s}`).toBe("[secret]");
    expect(JSON.stringify({ s })).toBe(`{"s":"[secret]"}`);
    expect(Object.keys(s)).toEqual([]);
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(s))).not.toContain(TOKEN);
    expect((s as unknown as Record<symbol, () => string>)[Symbol.for("nodejs.util.inspect.custom")]()).toBe("[secret]");
    expect(s.reveal()).toBe(TOKEN);
  });

  it("scrub removes every revealed value before anything is cut", () => {
    const text = `401 from upstream: Bearer ${TOKEN} and again ${encodeURIComponent("a b/" + TOKEN)} and ${OTHER}`;
    const out = scrub(text, [new Secret(TOKEN), OTHER, null, undefined, ""]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(OTHER);
    expect(out).toContain("[redacted]");
    // A token that straddles the 300-character cut is removed whole: scrub first, cut second.
    const straddle = "x".repeat(280) + TOKEN;
    const cut = lastErrorText(straddle, TOKEN);
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(cut).not.toContain(TOKEN.slice(0, 8));
  });
});

describe("set / get / rotate / delete", () => {
  it("round-trips a secret and stores only ciphertext", async () => {
    const ctx = await owner();
    const meta = await setSecret(ctx, e, "github_token", "", TOKEN);
    expect(meta).toMatchObject({ kind: "github_token", scope: "", hint_last4: TOKEN.slice(-4), created_by: "AndresL230", rotated_at: null, last_error: null });
    expect(meta).not.toHaveProperty("ciphertext");
    const got = await getSecret(ctx, e, "github_token", "");
    expect(got).toBeInstanceOf(Secret);
    expect(got!.reveal()).toBe(TOKEN);
    const r = (await row(ORG_A, "github_token", ""))!;
    expect(r.ciphertext).not.toContain(TOKEN);
    expect(atob(r.ciphertext)).not.toContain(TOKEN.slice(0, 8));
    expect(atob(r.iv).length).toBe(12);
    expect(r.key_version).toBe(1);
    expect(await getSecret(ctx, e, "github_token", "nope")).toBeNull();
  });

  it("creates the org's data key on its first write, wrapped by the current KEK", async () => {
    const ctx = await owner();
    expect(await keyRows(ORG_A)).toEqual([]);
    await setSecret(ctx, e, "github_token", "", TOKEN);
    await setSecret(ctx, e, "railway", "staging", OTHER);
    const keys = await keyRows(ORG_A);
    expect(keys.length).toBe(1);
    expect(keys[0].kek_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(atob(keys[0].wrapped_key).length).toBe(32 + 16); // the raw key + the GCM tag
    expect(keys[0].retired_at).toBeNull();
  });

  it("uses a fresh IV on every write — the same value never encrypts the same way twice", async () => {
    const ctx = await owner();
    await setSecret(ctx, e, "railway", "staging", TOKEN);
    await setSecret(ctx, e, "railway", "production", TOKEN);
    const a = (await row(ORG_A, "railway", "staging"))!;
    const b = (await row(ORG_A, "railway", "production"))!;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    await rotateSecret(ctx, e, "railway", "staging", TOKEN);
    const a2 = (await row(ORG_A, "railway", "staging"))!;
    expect(a2.iv).not.toBe(a.iv);
    expect(a2.ciphertext).not.toBe(a.ciphertext);
  });

  it("set refuses an existing secret; rotate replaces it and refuses a missing one", async () => {
    const ctx = await owner();
    await expect(rotateSecret(ctx, e, "github_token", "", TOKEN)).rejects.toBeInstanceOf(SecretNotFoundError);
    await setSecret(ctx, e, "github_token", "", TOKEN);
    await env.DB.prepare(`UPDATE org_secrets SET last_error = 'old failure'`).run();
    await expect(setSecret(ctx, e, "github_token", "", OTHER)).rejects.toBeInstanceOf(SecretConflictError);
    expect((await getSecret(ctx, e, "github_token", ""))!.reveal()).toBe(TOKEN);
    const meta = await rotateSecret(ctx, e, "github_token", "", OTHER);
    expect(meta.rotated_at).not.toBeNull();
    expect(meta.hint_last4).toBe(OTHER.slice(-4));
    expect(meta.last_error).toBeNull();
    expect((await getSecret(ctx, e, "github_token", ""))!.reveal()).toBe(OTHER);
  });

  it("delete removes the row; a second delete is not found", async () => {
    const ctx = await owner();
    await setSecret(ctx, e, "github_token", "", TOKEN);
    await deleteSecret(ctx, "github_token", "");
    expect(await row(ORG_A, "github_token", "")).toBeNull();
    expect(await getSecret(ctx, e, "github_token", "")).toBeNull();
    await expect(deleteSecret(ctx, "github_token", "")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("audits set / rotate / delete in the same batch, never with a value", async () => {
    const ctx = await owner();
    await setSecret(ctx, e, "railway", "staging", TOKEN);
    await rotateSecret(ctx, e, "railway", "staging", OTHER);
    await deleteSecret(ctx, "railway", "staging");
    const audit = await listOrgAudit(ctx);
    expect(audit.map((a) => [a.action, a.target, a.actor])).toEqual([
      ["secret.delete", "railway:staging", "AndresL230"],
      ["secret.rotate", "railway:staging", "AndresL230"],
      ["secret.set", "railway:staging", "AndresL230"],
    ]);
    expect(audit[2].detail).toEqual({ hint_last4: TOKEN.slice(-4), key_version: 1 });
    expect(JSON.stringify(audit)).not.toContain(TOKEN.slice(0, 8));
    expect(await listOrgAudit(await ownerB())).toEqual([]);
  });

  it("keeps hint_last4 empty for a secret shorter than 16 characters", async () => {
    const ctx = await owner();
    expect((await setSecret(ctx, e, "github_token", "", "short-token-123")).hint_last4).toBe("");
    expect((await setSecret(ctx, e, "railway", "staging", "sixteen-chars-ok")).hint_last4).toBe("s-ok");
  });

  it("refuses a bad value without echoing it", async () => {
    const ctx = await owner();
    for (const bad of ["", ` ${TOKEN}`, `${TOKEN}\n`, `${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`, "x".repeat(4097)]) {
      const err = await setSecret(ctx, e, "github_token", "", bad).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(SecretValueError);
      expect((err as Error).message).not.toContain(TOKEN.slice(0, 8));
    }
    await expect(setSecret(ctx, e, "github_webhook", "hook_x", "tooshort")).rejects.toBeInstanceOf(SecretValueError);
    expect(await row(ORG_A, "github_token", "")).toBeNull();
  });

  it("writes are admin+: a member and a system context are refused", async () => {
    await expect(setSecret(await tenantCtx("meilin", "member"), e, "github_token", "", TOKEN)).rejects.toBeInstanceOf(RoleError);
    await expect(setSecret(systemCtx(), e, "github_token", "", TOKEN)).rejects.toBeInstanceOf(RoleError);
    await setSecret(await tenantCtx("meilin", "admin"), e, "github_token", "", TOKEN);
    await expect(deleteSecret(await tenantCtx("sanaok", "member"), "github_token", "")).rejects.toBeInstanceOf(RoleError);
    await expect(rotateOrgKey(await tenantCtx("meilin", "admin"), e)).rejects.toBeInstanceOf(RoleError);
  });
});

describe("getSecret — who it serves (§8.7.5)", () => {
  it("throws for an MCP (bearer) context, even an admin's, and for a member; serves system and admin sessions", async () => {
    await setSecret(await owner(), e, "github_token", "", TOKEN);
    await expect(getSecret(await bearerCtx("meilin", "admin"), e, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
    await expect(getSecret(await bearerCtx("AndresL230"), e, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
    await expect(getSecret(await tenantCtx("sanaok", "member"), e, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
    // …and it refuses BEFORE looking: a kind with nothing stored throws too, it does not answer null.
    await expect(getSecret(await bearerCtx("meilin", "admin"), e, "railway", "staging")).rejects.toBeInstanceOf(SecretAccessError);
    expect((await getSecret(systemCtx(), e, "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(systemCtx(ORG_A, "github-webhook"), e, "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(await tenantCtx("meilin", "admin"), e, "github_token", ""))!.reveal()).toBe(TOKEN);
    expect(await getSecret(systemCtx(ORG_B), e, "github_token", "")).toBeNull();
  });
});

describe("a moved ciphertext never decrypts (D19)", () => {
  const copyRow = async (from: [string, string, string], to: [string, string, string]) => {
    const src = (await row(...from))!;
    await env.DB.prepare(`UPDATE org_secrets SET ciphertext = ?, iv = ?, key_version = ? WHERE org_id = ? AND kind = ? AND scope = ?`)
      .bind(src.ciphertext, src.iv, src.key_version, ...to).run();
  };

  it("org A's ciphertext in org B's row throws — under B's own key", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, e, "github_token", "", TOKEN);
    await setSecret(b, e, "github_token", "", OTHER);
    await copyRow([ORG_A, "github_token", ""], [ORG_B, "github_token", ""]);
    await expect(getSecret(b, e, "github_token", "")).rejects.toBeInstanceOf(SecretDecryptError);
    expect((await getSecret(a, e, "github_token", ""))!.reveal()).toBe(TOKEN);
  });

  it("…and under A's key row copied into B as well (the wrapped key is bound to its org)", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, e, "github_token", "", TOKEN);
    await setSecret(b, e, "github_token", "", OTHER);
    await copyRow([ORG_A, "github_token", ""], [ORG_B, "github_token", ""]);
    const ak = (await keyRows(ORG_A))[0];
    await env.DB.prepare(`UPDATE org_keys SET wrapped_key = ?, wrap_iv = ?, kek_fingerprint = ? WHERE org_id = ? AND key_version = 1`)
      .bind(ak.wrapped_key, ak.wrap_iv, ak.kek_fingerprint, ORG_B).run();
    const err = await getSecret(b, e, "github_token", "").catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SecretDecryptError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(TOKEN.slice(0, 8));
  });

  it("a row moved between kinds or scopes inside one org throws", async () => {
    const a = await owner();
    await setSecret(a, e, "railway", "staging", TOKEN);
    await setSecret(a, e, "railway", "production", OTHER);
    await setSecret(a, e, "metrics_endpoint", "staging", OTHER);
    await copyRow([ORG_A, "railway", "staging"], [ORG_A, "railway", "production"]);      // scope → scope
    await copyRow([ORG_A, "railway", "staging"], [ORG_A, "metrics_endpoint", "staging"]); // kind → kind
    await expect(getSecret(a, e, "railway", "production")).rejects.toBeInstanceOf(SecretDecryptError);
    await expect(getSecret(a, e, "metrics_endpoint", "staging")).rejects.toBeInstanceOf(SecretDecryptError);
    expect((await getSecret(a, e, "railway", "staging"))!.reveal()).toBe(TOKEN);
  });

  it("a tampered byte — in the ciphertext, the tag or the IV — throws", async () => {
    const a = await owner();
    const flip = (b64: string, at: number): string => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      bytes[at < 0 ? bytes.length + at : at] ^= 0x01;
      return btoa(String.fromCharCode(...bytes));
    };
    for (const [col, at] of [["ciphertext", 0], ["ciphertext", -1], ["iv", 3]] as const) {
      await env.DB.exec(`DELETE FROM org_secrets`);
      await setSecret(a, e, "github_token", "", TOKEN);
      const r = (await row(ORG_A, "github_token", ""))!;
      await env.DB.prepare(`UPDATE org_secrets SET ${col} = ? WHERE org_id = ?`).bind(flip(r[col], at), ORG_A).run();
      await expect(getSecret(a, e, "github_token", "")).rejects.toBeInstanceOf(SecretDecryptError);
    }
  });
});

describe("rotating the org's data key", () => {
  it("re-encrypts every secret under a new version and retires the old one, in one audited batch", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, e, "github_token", "", TOKEN);
    await setSecret(a, e, "railway", "staging", OTHER);
    await setSecret(b, e, "github_token", "", OTHER);
    const before = (await row(ORG_A, "github_token", ""))!;
    expect(await rotateOrgKey(a, e)).toEqual({ rotated: true, key_version: 2, secrets: 2 });

    const keys = await keyRows(ORG_A);
    expect(keys.map((k) => [k.key_version, k.retired_at !== null])).toEqual([[1, true], [2, false]]);
    const after = (await row(ORG_A, "github_token", ""))!;
    expect(after.key_version).toBe(2);
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(after.iv).not.toBe(before.iv);
    expect((await row(ORG_A, "railway", "staging"))!.key_version).toBe(2);
    expect((await getSecret(a, e, "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(a, e, "railway", "staging"))!.reveal()).toBe(OTHER);
    // The old ciphertext is useless under the new version.
    await env.DB.prepare(`UPDATE org_secrets SET ciphertext = ?, iv = ? WHERE org_id = ? AND kind = 'github_token'`).bind(before.ciphertext, before.iv, ORG_A).run();
    await expect(getSecret(a, e, "github_token", "")).rejects.toBeInstanceOf(SecretDecryptError);

    // Org B was not touched; a new write lands on the new version.
    expect((await keyRows(ORG_B)).map((k) => k.key_version)).toEqual([1]);
    expect((await getSecret(b, e, "github_token", ""))!.reveal()).toBe(OTHER);
    await setSecret(a, e, "railway", "production", TOKEN);
    expect((await row(ORG_A, "railway", "production"))!.key_version).toBe(2);
    const audit = await listOrgAudit(a);
    expect(audit[1]).toMatchObject({ action: "key.rotate", target: "org_keys", detail: { key_version: 2, from_version: 1, secrets: 2 } });
  });

  it("has nothing to rotate before the first secret, and stops on a secret that does not decrypt", async () => {
    const a = await owner();
    expect(await rotateOrgKey(a, e)).toEqual({ rotated: false, key_version: null, secrets: 0 });
    await setSecret(a, e, "railway", "staging", TOKEN);
    await setSecret(a, e, "railway", "production", OTHER);
    const s = (await row(ORG_A, "railway", "staging"))!;
    await env.DB.prepare(`UPDATE org_secrets SET ciphertext = ?, iv = ? WHERE org_id = ? AND scope = 'production'`).bind(s.ciphertext, s.iv, ORG_A).run();
    const err = await rotateOrgKey(a, e).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SecretDecryptError);
    expect((err as SecretDecryptError).target).toBe("railway:production");
    expect((await keyRows(ORG_A)).map((k) => [k.key_version, k.retired_at])).toEqual([[1, null]]); // nothing was written
  });
});

describe("the platform key (TROV_KEK)", () => {
  const K2 = btoa("another-kek-0123456789abcdef-two");
  const withKek = (kek: string | undefined, previous?: string): Env => ({ ...e, TROV_KEK: kek, TROV_KEK_PREVIOUS: previous });

  it("fails closed when it is missing or malformed — nothing is stored, and the error carries no value", async () => {
    const a = await owner();
    for (const bad of [undefined, "", "not base64 !!", btoa("too-short"), btoa("x".repeat(33))]) {
      const err = await setSecret(a, withKek(bad), "github_token", "", TOKEN).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(SecretsUnavailableError);
      expect((err as Error).message).toMatch(/^secrets unavailable: TROV_KEK /);
      if (bad) expect((err as Error).message).not.toContain(bad);
      expect(await secretsAvailable(withKek(bad))).toBe(false);
    }
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM org_secrets`).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM org_keys`).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await secretsAvailable(e)).toBe(true);
    // A stored secret cannot be read without the key either.
    await setSecret(a, e, "github_token", "", TOKEN);
    await expect(getSecret(a, withKek(undefined), "github_token", "")).rejects.toBeInstanceOf(SecretsUnavailableError);
  });

  it("rotates: TROV_KEK_PREVIOUS still unwraps old data keys, picked by fingerprint", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, e, "github_token", "", TOKEN);
    const rotated = withKek(K2, e.TROV_KEK);
    expect((await getSecret(a, rotated, "github_token", ""))!.reveal()).toBe(TOKEN);
    // An org whose first write comes after the rotation is wrapped by the NEW key.
    await setSecret(b, rotated, "github_token", "", OTHER);
    const [fa, fb] = [(await keyRows(ORG_A))[0].kek_fingerprint, (await keyRows(ORG_B))[0].kek_fingerprint];
    expect(fa).not.toBe(fb);
    // A's writes keep using A's existing data key (still wrapped by the old KEK) until it is re-wrapped.
    await rotateSecret(a, rotated, "github_token", "", OTHER);
    expect((await getSecret(a, rotated, "github_token", ""))!.reveal()).toBe(OTHER);
    // Rotating A's data key re-wraps under the current KEK.
    await rotateOrgKey(a, rotated);
    expect((await keyRows(ORG_A))[1].kek_fingerprint).toBe(fb);
    // With the previous key removed: B (new key) reads; the old KEK alone cannot read B.
    const only2 = withKek(K2);
    expect((await getSecret(b, only2, "github_token", ""))!.reveal()).toBe(OTHER);
    expect((await getSecret(a, only2, "github_token", ""))!.reveal()).toBe(OTHER);
    await expect(getSecret(b, e, "github_token", "")).rejects.toBeInstanceOf(SecretsUnavailableError);
  });
});

describe("last_used_at / last_error", () => {
  it("writes last_used_at at most once per 10 minutes per row", async () => {
    const a = await owner();
    await setSecret(a, e, "github_token", "", TOKEN);
    const t0 = Date.parse("2026-10-06T12:00:00.000Z");
    await markSecretUsed(a, "github_token", "", t0);
    expect((await row(ORG_A, "github_token", ""))!.last_used_at).toBe("2026-10-06T12:00:00.000Z");
    await markSecretUsed(a, "github_token", "", t0 + 9 * 60_000);
    expect((await row(ORG_A, "github_token", ""))!.last_used_at).toBe("2026-10-06T12:00:00.000Z");
    await markSecretUsed(a, "github_token", "", t0 + 11 * 60_000);
    expect((await row(ORG_A, "github_token", ""))!.last_used_at).toBe("2026-10-06T12:11:00.000Z");
  });

  it("stores a failure scrubbed and capped at 300 characters; a success clears it", async () => {
    const a = await owner();
    await setSecret(a, e, "github_token", "", TOKEN);
    const secret = (await getSecret(a, e, "github_token", ""))!;
    await recordSecretOutcome(a, "github_token", "", { ok: false, message: `upstream said\n  authorization: Bearer ${TOKEN} ` + "y".repeat(400), revealed: secret });
    const failed = (await getSecretMeta(a, "github_token", ""))!;
    expect(failed.last_error).toMatch(/^upstream said authorization: Bearer \[redacted\] y+$/);
    expect(failed.last_error!.length).toBe(300);
    expect(failed.last_used_at).toBeNull();
    await recordSecretOutcome(a, "github_token", "", { ok: true });
    const ok = (await getSecretMeta(a, "github_token", ""))!;
    expect(ok.last_error).toBeNull();
    expect(ok.last_used_at).not.toBeNull();
  });
});
