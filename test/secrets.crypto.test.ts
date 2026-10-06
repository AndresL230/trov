// canopy-multitenancy.md §10.5 — the envelope encryption itself (src/data/secrets.ts): round trip,
// IVs, rotation of a secret / the org's data key / the platform key, the moved-ciphertext cases (D19),
// and who `getSecret` serves.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import {
  Secret, SecretAccessError, SecretConflictError, SecretDecryptError, SecretNotFoundError, SecretValueError, SecretsUnavailableError,
  deleteSecret, getSecret, getSecretMeta, lastErrorText, listOrgAudit, markSecretUsed, recordSecretOutcome,
  rotateOrgKey, rotateSecret, scrub, secretsAvailable, setSecret, getIntegrationConfig, setIntegrationConfig,
} from "../src/data/secrets";
import { deleteEnvironment, listEnvironments, putEnvironment, reorderEnvironments } from "../src/integrations/settings";
import { seedOrgSettings } from "./helpers/integrations";
import { RoleError } from "../src/data/context";
import { ORG_A, ORG_B, bearerCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const TOKEN = "tok_" + "A1b2C3d4".repeat(8); // 68 characters
const OTHER = "tok_" + "z9Y8x7W6".repeat(8);
// `on` = the Env the context is built from: a secret is sealed and opened with THAT Env's TROV_KEK.
const owner = (on?: Env) => tenantCtx("AndresL230", undefined, { env: on });
const ownerB = (on?: Env) => tenantCtx("bob-b", "owner", { orgId: ORG_B, env: on });

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
    const meta = await setSecret(ctx, "github_token", "", TOKEN);
    expect(meta).toMatchObject({ kind: "github_token", scope: "", hint_last4: TOKEN.slice(-4), created_by: "AndresL230", rotated_at: null, last_error: null });
    expect(meta).not.toHaveProperty("ciphertext");
    const got = await getSecret(ctx, "github_token", "");
    expect(got).toBeInstanceOf(Secret);
    expect(got!.reveal()).toBe(TOKEN);
    const r = (await row(ORG_A, "github_token", ""))!;
    expect(r.ciphertext).not.toContain(TOKEN);
    expect(atob(r.ciphertext)).not.toContain(TOKEN.slice(0, 8));
    expect(atob(r.iv).length).toBe(12);
    expect(r.key_version).toBe(1);
    expect(await getSecret(ctx, "github_token", "nope")).toBeNull();
  });

  it("creates the org's data key on its first write, wrapped by the current KEK", async () => {
    const ctx = await owner();
    expect(await keyRows(ORG_A)).toEqual([]);
    await setSecret(ctx, "github_token", "", TOKEN);
    await setSecret(ctx, "railway", "staging", OTHER);
    const keys = await keyRows(ORG_A);
    expect(keys.length).toBe(1);
    expect(keys[0].kek_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(atob(keys[0].wrapped_key).length).toBe(32 + 16); // the raw key + the GCM tag
    expect(keys[0].retired_at).toBeNull();
  });

  it("uses a fresh IV on every write — the same value never encrypts the same way twice", async () => {
    const ctx = await owner();
    await setSecret(ctx, "railway", "staging", TOKEN);
    await setSecret(ctx, "railway", "production", TOKEN);
    const a = (await row(ORG_A, "railway", "staging"))!;
    const b = (await row(ORG_A, "railway", "production"))!;
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    await rotateSecret(ctx, "railway", "staging", TOKEN);
    const a2 = (await row(ORG_A, "railway", "staging"))!;
    expect(a2.iv).not.toBe(a.iv);
    expect(a2.ciphertext).not.toBe(a.ciphertext);
  });

  it("set refuses an existing secret; rotate replaces it and refuses a missing one", async () => {
    const ctx = await owner();
    await expect(rotateSecret(ctx, "github_token", "", TOKEN)).rejects.toBeInstanceOf(SecretNotFoundError);
    await setSecret(ctx, "github_token", "", TOKEN);
    await env.DB.prepare(`UPDATE org_secrets SET last_error = 'old failure'`).run();
    await expect(setSecret(ctx, "github_token", "", OTHER)).rejects.toBeInstanceOf(SecretConflictError);
    expect((await getSecret(ctx, "github_token", ""))!.reveal()).toBe(TOKEN);
    const meta = await rotateSecret(ctx, "github_token", "", OTHER);
    expect(meta.rotated_at).not.toBeNull();
    expect(meta.hint_last4).toBe(OTHER.slice(-4));
    expect(meta.last_error).toBeNull();
    expect((await getSecret(ctx, "github_token", ""))!.reveal()).toBe(OTHER);
  });

  it("delete removes the row; a second delete is not found", async () => {
    const ctx = await owner();
    await setSecret(ctx, "github_token", "", TOKEN);
    await deleteSecret(ctx, "github_token", "");
    expect(await row(ORG_A, "github_token", "")).toBeNull();
    expect(await getSecret(ctx, "github_token", "")).toBeNull();
    await expect(deleteSecret(ctx, "github_token", "")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("audits set / rotate / delete in the same batch, never with a value", async () => {
    const ctx = await owner();
    await setSecret(ctx, "railway", "staging", TOKEN);
    await rotateSecret(ctx, "railway", "staging", OTHER);
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
    expect((await setSecret(ctx, "github_token", "", "short-token-123")).hint_last4).toBe("");
    expect((await setSecret(ctx, "railway", "staging", "sixteen-chars-ok")).hint_last4).toBe("s-ok");
  });

  it("refuses a bad value without echoing it", async () => {
    const ctx = await owner();
    for (const bad of ["", ` ${TOKEN}`, `${TOKEN}\n`, `${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`, "x".repeat(4097)]) {
      const err = await setSecret(ctx, "github_token", "", bad).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(SecretValueError);
      expect((err as Error).message).not.toContain(TOKEN.slice(0, 8));
    }
    await expect(setSecret(ctx, "github_webhook", "hook_x", "tooshort")).rejects.toBeInstanceOf(SecretValueError);
    expect(await row(ORG_A, "github_token", "")).toBeNull();
  });

  it("writes are admin+: a member and a system context are refused", async () => {
    await expect(setSecret(await tenantCtx("meilin", "member"), "github_token", "", TOKEN)).rejects.toBeInstanceOf(RoleError);
    await expect(setSecret(systemCtx(), "github_token", "", TOKEN)).rejects.toBeInstanceOf(RoleError);
    await setSecret(await tenantCtx("meilin", "admin"), "github_token", "", TOKEN);
    await expect(deleteSecret(await tenantCtx("sanaok", "member"), "github_token", "")).rejects.toBeInstanceOf(RoleError);
    await expect(rotateOrgKey(await tenantCtx("meilin", "admin"))).rejects.toBeInstanceOf(RoleError);
  });
});

describe("getSecret — who it serves (§8.7.5)", () => {
  it("throws for an MCP (bearer) context, even an admin's, and for a member; serves system and admin sessions", async () => {
    await setSecret(await owner(), "github_token", "", TOKEN);
    await expect(getSecret(await bearerCtx("meilin", "admin"), "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
    await expect(getSecret(await bearerCtx("AndresL230"), "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
    await expect(getSecret(await tenantCtx("sanaok", "member"), "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
    // …and it refuses BEFORE looking: a kind with nothing stored throws too, it does not answer null.
    await expect(getSecret(await bearerCtx("meilin", "admin"), "railway", "staging")).rejects.toBeInstanceOf(SecretAccessError);
    expect((await getSecret(systemCtx(), "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(systemCtx(ORG_A, "github-webhook"), "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(await tenantCtx("meilin", "admin"), "github_token", ""))!.reveal()).toBe(TOKEN);
    expect(await getSecret(systemCtx(ORG_B), "github_token", "")).toBeNull();
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
    await setSecret(a, "github_token", "", TOKEN);
    await setSecret(b, "github_token", "", OTHER);
    await copyRow([ORG_A, "github_token", ""], [ORG_B, "github_token", ""]);
    await expect(getSecret(b, "github_token", "")).rejects.toBeInstanceOf(SecretDecryptError);
    expect((await getSecret(a, "github_token", ""))!.reveal()).toBe(TOKEN);
  });

  it("…and under A's key row copied into B as well (the wrapped key is bound to its org)", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, "github_token", "", TOKEN);
    await setSecret(b, "github_token", "", OTHER);
    await copyRow([ORG_A, "github_token", ""], [ORG_B, "github_token", ""]);
    const ak = (await keyRows(ORG_A))[0];
    await env.DB.prepare(`UPDATE org_keys SET wrapped_key = ?, wrap_iv = ?, kek_fingerprint = ? WHERE org_id = ? AND key_version = 1`)
      .bind(ak.wrapped_key, ak.wrap_iv, ak.kek_fingerprint, ORG_B).run();
    const err = await getSecret(b, "github_token", "").catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SecretDecryptError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(TOKEN.slice(0, 8));
  });

  it("a row moved between kinds or scopes inside one org throws", async () => {
    const a = await owner();
    await setSecret(a, "railway", "staging", TOKEN);
    await setSecret(a, "railway", "production", OTHER);
    await setSecret(a, "metrics_endpoint", "staging", OTHER);
    await copyRow([ORG_A, "railway", "staging"], [ORG_A, "railway", "production"]);      // scope → scope
    await copyRow([ORG_A, "railway", "staging"], [ORG_A, "metrics_endpoint", "staging"]); // kind → kind
    await expect(getSecret(a, "railway", "production")).rejects.toBeInstanceOf(SecretDecryptError);
    await expect(getSecret(a, "metrics_endpoint", "staging")).rejects.toBeInstanceOf(SecretDecryptError);
    expect((await getSecret(a, "railway", "staging"))!.reveal()).toBe(TOKEN);
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
      await setSecret(a, "github_token", "", TOKEN);
      const r = (await row(ORG_A, "github_token", ""))!;
      await env.DB.prepare(`UPDATE org_secrets SET ${col} = ? WHERE org_id = ?`).bind(flip(r[col], at), ORG_A).run();
      await expect(getSecret(a, "github_token", "")).rejects.toBeInstanceOf(SecretDecryptError);
    }
  });
});

describe("rotating the org's data key", () => {
  it("re-encrypts every secret under a new version and retires the old one, in one audited batch", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, "github_token", "", TOKEN);
    await setSecret(a, "railway", "staging", OTHER);
    await setSecret(b, "github_token", "", OTHER);
    const before = (await row(ORG_A, "github_token", ""))!;
    expect(await rotateOrgKey(a)).toEqual({ rotated: true, key_version: 2, secrets: 2 });

    const keys = await keyRows(ORG_A);
    expect(keys.map((k) => [k.key_version, k.retired_at !== null])).toEqual([[1, true], [2, false]]);
    const after = (await row(ORG_A, "github_token", ""))!;
    expect(after.key_version).toBe(2);
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(after.iv).not.toBe(before.iv);
    expect((await row(ORG_A, "railway", "staging"))!.key_version).toBe(2);
    expect((await getSecret(a, "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(a, "railway", "staging"))!.reveal()).toBe(OTHER);
    // The old ciphertext is useless under the new version.
    await env.DB.prepare(`UPDATE org_secrets SET ciphertext = ?, iv = ? WHERE org_id = ? AND kind = 'github_token'`).bind(before.ciphertext, before.iv, ORG_A).run();
    await expect(getSecret(a, "github_token", "")).rejects.toBeInstanceOf(SecretDecryptError);

    // Org B was not touched; a new write lands on the new version.
    expect((await keyRows(ORG_B)).map((k) => k.key_version)).toEqual([1]);
    expect((await getSecret(b, "github_token", ""))!.reveal()).toBe(OTHER);
    await setSecret(a, "railway", "production", TOKEN);
    expect((await row(ORG_A, "railway", "production"))!.key_version).toBe(2);
    const audit = await listOrgAudit(a);
    expect(audit[1]).toMatchObject({ action: "key.rotate", target: "org_keys", detail: { key_version: 2, from_version: 1, secrets: 2 } });
  });

  it("has nothing to rotate before the first secret, and stops on a secret that does not decrypt", async () => {
    const a = await owner();
    expect(await rotateOrgKey(a)).toEqual({ rotated: false, key_version: null, secrets: 0 });
    await setSecret(a, "railway", "staging", TOKEN);
    await setSecret(a, "railway", "production", OTHER);
    const s = (await row(ORG_A, "railway", "staging"))!;
    await env.DB.prepare(`UPDATE org_secrets SET ciphertext = ?, iv = ? WHERE org_id = ? AND scope = 'production'`).bind(s.ciphertext, s.iv, ORG_A).run();
    const err = await rotateOrgKey(a).catch((x: unknown) => x);
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
      const err = await setSecret(await owner(withKek(bad)), "github_token", "", TOKEN).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(SecretsUnavailableError);
      expect((err as Error).message).toMatch(/^secrets unavailable: TROV_KEK /);
      if (bad) expect((err as Error).message).not.toContain(bad);
      expect(await secretsAvailable(withKek(bad))).toBe(false);
    }
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM org_secrets`).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM org_keys`).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await secretsAvailable(e)).toBe(true);
    // A stored secret cannot be read without the key either.
    await setSecret(a, "github_token", "", TOKEN);
    await expect(getSecret(await owner(withKek(undefined)), "github_token", "")).rejects.toBeInstanceOf(SecretsUnavailableError);
  });

  it("rotates: TROV_KEK_PREVIOUS still unwraps old data keys, picked by fingerprint", async () => {
    const [a, b] = [await owner(), await ownerB()];
    await setSecret(a, "github_token", "", TOKEN);
    // The same two people, on a Worker whose key was rotated (the old one kept as TROV_KEK_PREVIOUS).
    const rotated = withKek(K2, e.TROV_KEK);
    const [a2, b2] = [await owner(rotated), await ownerB(rotated)];
    expect((await getSecret(a2, "github_token", ""))!.reveal()).toBe(TOKEN);
    // An org whose first write comes after the rotation is wrapped by the NEW key.
    await setSecret(b2, "github_token", "", OTHER);
    const [fa, fb] = [(await keyRows(ORG_A))[0].kek_fingerprint, (await keyRows(ORG_B))[0].kek_fingerprint];
    expect(fa).not.toBe(fb);
    // A's writes keep using A's existing data key (still wrapped by the old KEK) until it is re-wrapped.
    await rotateSecret(a2, "github_token", "", OTHER);
    expect((await getSecret(a2, "github_token", ""))!.reveal()).toBe(OTHER);
    // Rotating A's data key re-wraps under the current KEK.
    await rotateOrgKey(a2);
    expect((await keyRows(ORG_A))[1].kek_fingerprint).toBe(fb);
    // With the previous key removed: B (new key) reads; the old KEK alone cannot read B.
    const only2 = withKek(K2);
    expect((await getSecret(await ownerB(only2), "github_token", ""))!.reveal()).toBe(OTHER);
    expect((await getSecret(await owner(only2), "github_token", ""))!.reveal()).toBe(OTHER);
    await expect(getSecret(b, "github_token", "")).rejects.toBeInstanceOf(SecretsUnavailableError);
  });
});

describe("last_used_at / last_error", () => {
  it("writes last_used_at at most once per 10 minutes per row", async () => {
    const a = await owner();
    await setSecret(a, "github_token", "", TOKEN);
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
    await setSecret(a, "github_token", "", TOKEN);
    const secret = (await getSecret(a, "github_token", ""))!;
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

// Two orgs holding the SAME (kind, scope) and the same environment keys: every write and every
// by-name read below is keyed on names both orgs share, so only its org predicate keeps them apart.
// (Added from the mutation spot check: each of these predicates survived being neutralised.)
describe("two orgs with identical kinds, scopes and environment keys", () => {
  const both = async () => {
    await seedOrgSettings(ORG_A);
    await seedOrgSettings(ORG_B, "hook_b");
    const [a, b] = [await owner(), await ownerB()];
    for (const [ctx, value] of [[a, TOKEN], [b, OTHER]] as const) {
      await setSecret(ctx, "github_token", "", value);
      await setSecret(ctx, "railway", "staging", value);
    }
    return { a, b };
  };

  it("non-secret config, last_used_at and the data key are per org", async () => {
    const { a, b } = await both();
    await setIntegrationConfig(a, "railway", "staging", { project: "a-project" });
    await setIntegrationConfig(b, "railway", "staging", { project: "b-project" });
    expect([await getIntegrationConfig(a, "railway", "staging"), await getIntegrationConfig(b, "railway", "staging")])
      .toEqual([{ project: "a-project" }, { project: "b-project" }]);

    await markSecretUsed(a, "github_token", "");
    expect((await row(ORG_A, "github_token", ""))!.last_used_at).not.toBeNull();
    expect((await row(ORG_B, "github_token", ""))!.last_used_at).toBeNull();

    // Rotating A's key retires A's version 1 — not B's version 1 — and each org counts its own versions.
    expect((await rotateOrgKey(a)).key_version).toBe(2);
    expect((await keyRows(ORG_B)).map((k) => [k.key_version, k.retired_at])).toEqual([[1, null]]);
    expect((await rotateOrgKey(a)).key_version).toBe(3);
    expect((await rotateOrgKey(b)).key_version).toBe(2); // not 4
    expect((await getSecret(a, "github_token", ""))!.reveal()).toBe(TOKEN);
    expect((await getSecret(b, "github_token", ""))!.reveal()).toBe(OTHER);
  });

  it("editing, reordering and deleting an environment in A leaves B's environment, config and secrets alone", async () => {
    const { a, b } = await both();
    await setIntegrationConfig(b, "railway", "staging", { project: "b-project" });
    const snapshotB = async () => ({
      envs: (await listEnvironments(b)).map((x) => [x.key, x.position, x.label, x.updated_by]),
      secret: (await getSecret(b, "railway", "staging"))?.reveal(),
      config: await getIntegrationConfig(b, "railway", "staging"),
    });
    const before = await snapshotB();

    await putEnvironment(a, "staging", { label: "A staging" });
    await reorderEnvironments(a, ["production", "staging"]);
    expect(await snapshotB()).toEqual(before);
    expect((await listEnvironments(a)).map((x) => [x.key, x.label])).toEqual([["production", "production"], ["staging", "A staging"]]);

    expect(await deleteEnvironment(a, "staging")).toEqual(["railway:staging"]);
    expect(await snapshotB()).toEqual(before);
    expect(await getSecret(a, "railway", "staging")).toBeNull();
    expect((await listEnvironments(a)).map((x) => x.key)).toEqual(["production"]);
  });
});
