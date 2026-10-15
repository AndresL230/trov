// The Hosting screens' sample data (web/src/hosting-sample.ts) is a DATA STUB the UI is designed and built
// against — so it must stay true to the contract: the provider catalogue IS the registry's, every part's
// settings pass its provider's own checks, and every reference (a part's provider, a connection's users, a
// checklist action) points at something the payload holds.
import { describe, expect, it } from "vitest";
import { type HostingSetupDTO, HOSTING_METRICS, PART_KEY_RE } from "@shared/hosting";
import { allProviders, checkFields, providerDTO, providerOf } from "../src/hosting/registry";
import { HOSTING_SAMPLES, HOSTING_SAMPLE_PROVIDERS, hostingScenario } from "../web/src/hosting-sample";
import { HOSTING_SAMPLE_KEYS, HOSTING_STACK_KEYS } from "../web/src/hosting-keys";

// The deployment the sample describes: the Vercel integration and the Netlify OAuth app both configured.
const SAMPLE_ENV = {
  VERCEL_INTEGRATION_CLIENT_ID: "x", VERCEL_INTEGRATION_CLIENT_SECRET: "x", VERCEL_INTEGRATION_SLUG: "x",
  NETLIFY_OAUTH_CLIENT_ID: "x", NETLIFY_OAUTH_CLIENT_SECRET: "x",
};

describe("the Hosting sample data", () => {
  it("carries the registry's own provider catalogue (regenerate it when a provider changes)", () => {
    expect(HOSTING_SAMPLE_PROVIDERS).toEqual(allProviders().map((p) => providerDTO(p, SAMPLE_ENV)));
  });

  // The fixed states the render tests use, and every flow × stack the preview's two switchers can show.
  const ALL: [string, HostingSetupDTO][] = [
    ...Object.entries(HOSTING_SAMPLES),
    ...HOSTING_SAMPLE_KEYS.flatMap((f) => HOSTING_STACK_KEYS.map((st): [string, HostingSetupDTO] => [`${f} × ${st}`, hostingScenario(f, st)])),
  ];

  it("a scenario's detection agrees with what it holds", () => {
    for (const f of HOSTING_SAMPLE_KEYS) {
      for (const st of HOSTING_STACK_KEYS) {
        const d = hostingScenario(f, st);
        const at = `${f} × ${st}`;
        expect(d.detection, at).toBeDefined();
        if (f === "start") expect(d.detection, at).toEqual({ state: "no_repo", repo: null, checked_at: null });
        if (d.detection!.state === "found") expect(d.detected.length, at).toBeGreaterThan(0);
        if (d.detection!.state === "none") expect(d.detected, at).toEqual([]);
        // Only hosts that post GitHub check runs are ever detected.
        for (const x of d.detected) expect(["cloudflare", "vercel", "netlify"], at).toContain(x.provider);
        expect(d.secrets_available, at).toBe(f !== "locked");
      }
    }
  });

  describe.each(ALL)("state %s", (_name, setup) => {
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
        // Nothing connected holds no settings yet (as the server answers); anything else holds valid ones.
        if (c.status === "not_connected") { expect(c.method).toBeNull(); expect(c.config).toEqual({}); }
        else expect(checkFields(fields, c.config, "config")).toEqual({ values: c.config });
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
