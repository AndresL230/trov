// The provider CONTRACT (src/hosting/types.ts "THE RULES"), checked for EVERY registered provider — so a
// provider added later is held to it the day it is registered. Each provider's own behaviour (its endpoints,
// its state mapping) is tested in test/hosting.provider.<id>.test.ts; this file checks what they must all share.
import { describe, expect, it } from "vitest";
import {
  HOSTING_INTEGRATION_KIND, HOSTING_METRICS, HOSTING_PROVIDERS, LEGACY_PART_KEY, isLegacyProvider, type HostingProviderId,
} from "@shared/hosting";
import { INTEGRATION_KINDS } from "@shared/integrations";
import { PROVIDERS, allProviders, checkFields, providerDTO } from "../src/hosting/registry";
import { HostRefusedError, HostingError, hostFetch, pollWindow, probeFailure, refuse, HOUR, SETTLE_MS } from "../src/hosting/http";
import { CONNECTION_METHODS } from "@shared/hosting";

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

describe("the registry", () => {
  it("registers every provider id exactly once, under its own id", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...HOSTING_PROVIDERS].sort());
    for (const id of HOSTING_PROVIDERS) expect(PROVIDERS[id].id).toBe(id);
    expect(allProviders().map((p) => p.id)).toEqual([...HOSTING_PROVIDERS]);
  });

  it("maps every provider to an integration kind the secrets table admits", () => {
    for (const id of HOSTING_PROVIDERS) expect(INTEGRATION_KINDS).toContain(HOSTING_INTEGRATION_KIND[id]);
  });
});

describe.each(HOSTING_PROVIDERS.map((id) => [id] as [HostingProviderId]))("provider %s", (id) => {
  const p = PROVIDERS[id];

  it("describes itself: label, summary, docs, roles", () => {
    expect(p.label.length).toBeGreaterThan(1);
    expect(p.summary.length).toBeGreaterThan(20);
    expect(p.docsUrl).toMatch(/^https:\/\//);
    expect(p.roles.length).toBeGreaterThan(0);
    expect(new Set(p.roles).size).toBe(p.roles.length);
  });

  it("sends its credential to exact, lower-case https hostnames only", () => {
    expect(p.apiHosts.length).toBeGreaterThan(0);
    for (const h of p.apiHosts) {
      expect(h, h).toMatch(HOSTNAME);
      expect(h).not.toMatch(/\*|\/|:/);
    }
  });

  it("offers at least one way to connect, best first, each with how-to text", () => {
    expect(p.connectionMethods.length).toBeGreaterThan(0);
    const order = ["install", "oauth", "token", "assume_role"];
    const ranks = p.connectionMethods.map((m) => order.indexOf(m.method));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const m of p.connectionMethods) {
      expect(m.label.length).toBeGreaterThan(3);
      expect(m.howTo.length, `${id} ${m.method} howTo`).toBeGreaterThan(40);
      expect(m.grants.length, `${id} ${m.method} grants`).toBeGreaterThan(0);
    }
  });

  it("has an install spec exactly when it offers install or OAuth", () => {
    const interactive = p.connectionMethods.some((m) => m.method === "install" || m.method === "oauth");
    expect(!!p.install).toBe(interactive);
    if (p.install) {
      expect(p.install.clientIdVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(p.install.clientSecretVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
      const method = p.connectionMethods.find((m) => m.method === "install" || m.method === "oauth")!;
      expect(method.requires ?? []).toContain(p.install.clientIdVar);
      expect(method.requires ?? []).toContain(p.install.clientSecretVar);
    }
  });

  it("declares only metrics that belong to one of its roles", () => {
    for (const m of p.capabilities.metrics) expect(p.roles, `${id} ${m}`).toContain(HOSTING_METRICS[m].role);
  });

  it("has anchored field patterns, unique keys, and refuses an unknown setting", () => {
    for (const fields of [p.partSettings, p.orgConfigFields]) {
      expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length);
      for (const f of fields) {
        expect(f.key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        expect(f.description.length, `${id}.${f.key}`).toBeGreaterThan(10);
        if (f.pattern) {
          expect(f.pattern.source.startsWith("^"), `${id}.${f.key} pattern`).toBe(true);
          expect(f.pattern.source.endsWith("$"), `${id}.${f.key} pattern`).toBe(true);
          expect(f.pattern.flags).not.toContain("g"); // a global regex keeps state between .test() calls
        }
      }
    }
    expect(checkFields(p.partSettings, { not_a_setting: "x" }, "settings")).toEqual({ field: "settings", message: "settings has a key this provider does not use" });
    const required = p.partSettings.filter((f) => f.required);
    if (required.length) expect("field" in checkFields(p.partSettings, {}, "settings")).toBe(true);
  });

  it("budgets its poll and serialises to the wire description", () => {
    expect(Number.isInteger(p.pollCost)).toBe(true);
    expect(p.pollCost).toBeGreaterThanOrEqual(1);
    expect(p.pollCost).toBeLessThanOrEqual(10);
    const dto = providerDTO(p, {});
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
    expect(dto.legacy_part_key).toBe(isLegacyProvider(id) ? LEGACY_PART_KEY[id] : null);
    for (const f of dto.part_settings) if (f.pattern) expect(() => new RegExp(f.pattern!)).not.toThrow();
    // With no Worker vars, nothing that needs one is offered as available.
    for (const m of dto.connection_methods) {
      const spec = p.connectionMethods.find((s) => s.method === m.method)!;
      if ((spec.requires ?? []).length) expect(m.available).toBe(false);
    }
  });

  it("names where a grant is managed, if it can: an https URL or null, for every method and any config — never a throw", () => {
    for (const method of CONNECTION_METHODS) {
      for (const config of [{}, { team_id: "team_x", team_slug: "x", org_slug: "y" }, { team_slug: "../../evil" }] as Record<string, string>[]) {
        const url = p.manageUrl ? p.manageUrl(config, method) : null;
        if (url !== null) expect(new URL(url).protocol, `${id} ${method}`).toBe("https:");
      }
    }
    // A method the provider does not offer has no page.
    const offered = new Set(p.connectionMethods.map((m) => m.method));
    for (const method of CONNECTION_METHODS) if (!offered.has(method) && p.manageUrl) expect(p.manageUrl({}, method), `${id} ${method}`).toBeNull();
  });

  it("builds console links without throwing, from empty or partial settings", () => {
    expect(() => p.consoleUrl({ settings: {} }, {})).not.toThrow();
    const url = p.consoleUrl({ settings: {} }, {});
    if (url !== null) expect(url).toMatch(/^https:\/\//);
  });
});

describe("a provider marked later", () => {
  it("is never offered as connectable", () => {
    for (const p of allProviders().filter((x) => x.status === "later")) {
      for (const m of providerDTO(p, { AWS_TROV_ACCESS_KEY_ID: "x", AWS_TROV_SECRET_ACCESS_KEY: "y" }).connection_methods) {
        expect(m.available).toBe(false);
        expect(m.unavailable_reason).toMatch(/not supported yet/);
      }
    }
  });
});

describe("hostFetch — the fixed-host allowlist", () => {
  const calls: string[] = [];
  const stub = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(u));
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeTruthy();
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = hostFetch(["api.example.com"], stub);

  it("sends to an allowed host, over https, without following redirects", async () => {
    await f("https://api.example.com/v1/x?y=1");
    expect(calls).toEqual(["https://api.example.com/v1/x?y=1"]);
  });

  it.each([
    ["http://api.example.com/x", "not https"],
    ["https://evil.example.com/x", "not one of the provider's API hosts"],
    ["https://api.example.com.evil.com/x", "not one of the provider's API hosts"],
    ["https://user:pw@api.example.com/x", "carries credentials"],
    ["https://api.example.com:8443/x", "default https port"],
    ["not a url", "not a URL"],
  ])("refuses %s before anything is sent", async (url, why) => {
    const before = calls.length;
    await expect(f(url)).rejects.toBeInstanceOf(HostRefusedError);
    await expect(f(url)).rejects.toThrow(why);
    expect(calls.length).toBe(before);
  });
});

describe("a refusal carries its HTTP status", () => {
  it("`refuse` sets it on the HostingError; `probeFailure` passes it on (a 401 ends an install at Test connection); fixed-text errors have none", async () => {
    const err = await refuse("x read", new Response("{}", { status: 401 }), "tok").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostingError);
    expect((err as HostingError).status).toBe(401);
    expect(probeFailure("x", err)).toEqual({ ok: false, detail: (err as Error).message, status: 401 });
    expect(new HostingError("fixed words").status).toBeUndefined();
    expect(probeFailure("x", new Error("boom"))).toEqual({ ok: false, detail: "x: the request failed" });
    expect(new HostRefusedError("not https").status).toBeUndefined();
  });
});

describe("pollWindow", () => {
  it("is the last three complete hours, each closed for at least SETTLE_MS", () => {
    const now = Date.parse("2026-10-07T12:10:00Z"); // 12:00 closed only 10 min ago → not yet
    const w = pollWindow(now);
    expect(new Date(w.to).toISOString()).toBe("2026-10-07T11:00:00.000Z");
    expect(new Date(w.from).toISOString()).toBe("2026-10-07T08:00:00.000Z");
    const later = pollWindow(Date.parse("2026-10-07T12:20:00Z"));
    expect(new Date(later.to).toISOString()).toBe("2026-10-07T12:00:00.000Z");
    expect(later.to - later.from).toBe(3 * HOUR);
    expect(SETTLE_MS).toBe(15 * 60_000);
  });
});
