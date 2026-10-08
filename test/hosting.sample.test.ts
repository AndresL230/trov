// The Hosting screens' sample data (web/src/hosting-sample.ts) is a DATA STUB the UI is designed and built
// against — so it must stay true to the contract: the provider catalogue IS the registry's, every part's
// settings pass its provider's own checks, and every reference (a part's provider, a connection's users, a
// checklist action) points at something the payload holds.
import { describe, expect, it } from "vitest";
import { HOSTING_METRICS, LEGACY_PART_KEY, PART_KEY_RE, isLegacyProvider } from "@shared/hosting";
import { allProviders, checkFields, providerDTO, providerOf } from "../src/hosting/registry";
import { HOSTING_SAMPLES, HOSTING_SAMPLE_PROVIDERS } from "../web/src/hosting-sample";

// The deployment the sample describes: the Vercel integration and the Netlify OAuth app both configured.
const SAMPLE_ENV = {
  VERCEL_INTEGRATION_CLIENT_ID: "x", VERCEL_INTEGRATION_CLIENT_SECRET: "x", VERCEL_INTEGRATION_SLUG: "x",
  NETLIFY_OAUTH_CLIENT_ID: "x", NETLIFY_OAUTH_CLIENT_SECRET: "x",
};

describe("the Hosting sample data", () => {
  it("carries the registry's own provider catalogue (regenerate it when a provider changes)", () => {
    expect(HOSTING_SAMPLE_PROVIDERS).toEqual(allProviders().map((p) => providerDTO(p, SAMPLE_ENV)));
  });

  describe.each(Object.entries(HOSTING_SAMPLES))("state %s", (_name, setup) => {
    it("uses the one provider catalogue", () => {
      expect(setup.providers).toBe(HOSTING_SAMPLE_PROVIDERS);
    });

    it("has parts whose settings pass their provider's own checks", () => {
      for (const env of setup.environments) {
        for (const part of env.parts) {
          expect(part.env).toBe(env.key);
          expect(part.key).toMatch(PART_KEY_RE);
          const p = providerOf(part.provider);
          expect(p.roles).toContain(part.role);
          expect(checkFields(p.partSettings, part.settings, "settings")).toEqual({ values: part.settings });
          expect(part.legacy).toBe(isLegacyProvider(part.provider));
          if (isLegacyProvider(part.provider)) expect(part.key).toBe(LEGACY_PART_KEY[part.provider]);
          for (const u of part.last_poll?.unavailable ?? []) expect(HOSTING_METRICS[u.metric].role, `${part.key} ${u.metric}`).toBe(part.role);
        }
        expect(new Set(env.parts.map((p) => p.key)).size).toBe(env.parts.length);
      }
    });

    it("has connections whose users and config are real", () => {
      const parts = new Set(setup.environments.flatMap((e) => e.parts.map((p) => `${e.key}/${p.key}`)));
      for (const c of setup.connections) {
        for (const u of c.used_by) expect(parts.has(`${u.env}/${u.part}`), `${c.provider} used by ${u.env}/${u.part}`).toBe(true);
        const fields = providerOf(c.provider).orgConfigFields;
        expect(checkFields(fields, c.config, "config")).toEqual({ values: c.config });
        if (c.status === "not_connected") expect(c.method).toBeNull();
      }
    });

    it("has checklist actions that point at what the payload holds", () => {
      const envs = new Set(setup.environments.map((e) => e.key));
      const ids = new Set<string>();
      for (const item of setup.checklist) {
        expect(ids.has(item.id), item.id).toBe(false);
        ids.add(item.id);
        const a = item.action;
        if (a.kind === "add_part" || a.kind === "edit_part") expect(envs.has(a.env)).toBe(true);
        if (a.kind === "connect" || a.kind === "configure" || a.kind === "test") expect(allProviders().map((p) => p.id)).toContain(a.provider);
        if (item.done) expect(a.kind).toBe("none");
      }
    });
  });
});
