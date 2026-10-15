/**
 * The `github` provider (repo setups, Phase A): GitHub deployments, with NO credential of its own. What
 * matters: its settings are exactly one of an environment / a check run / a workflow, a poll resolves no
 * credential and fetches nothing, and nothing lists it as a connection to make (no card, no checklist step,
 * no Integrations slot) — its parts are as connected as GitHub is.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first } from "./helpers/db";
import { setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { ENVS } from "./helpers/repo";
import { github, workflowPath } from "../src/hosting/providers/github";
import { listAllParts } from "../src/hosting/parts";
import { putPart } from "../src/hosting/part-writes";
import { hostingPollCost, pollPart, providerPollCost } from "../src/hosting/poll";
import { PROVIDERS, providerDTO } from "../src/hosting/registry";
import { getHostingSetup } from "../src/hosting/setup";
import { SettingsError } from "../src/integrations/settings";

const e = env as unknown as Env;

describe("the github provider's settings", () => {
  it("are exactly one of: a deployment environment, a check run (app AND name), a workflow file", () => {
    expect(github.checkSettings!({ environment: "Production – web" })).toBeNull();
    expect(github.checkSettings!({ check_app: "cloudflare-workers-and-pages", check_name: "Workers Builds: web" })).toBeNull();
    expect(github.checkSettings!({ workflow: ".github/workflows/deploy.yml" })).toBeNull();
    expect(github.checkSettings!({})?.field).toBe("settings");
    expect(github.checkSettings!({ environment: "x", workflow: "deploy.yml" })?.field).toBe("settings");
    expect(github.checkSettings!({ check_app: "vercel" })?.field).toBe("settings.check_name");
    expect(github.checkSettings!({ check_name: "Vercel" })?.field).toBe("settings.check_app");
    expect(workflowPath("deploy.yml")).toBe(".github/workflows/deploy.yml");
    expect(workflowPath(".github/workflows/deploy.yml")).toBe(".github/workflows/deploy.yml");
  });

  it("a part write holds them to it", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const admin = await tenantCtx("AndresL230");
    const refused = async (settings: Record<string, string>): Promise<string | undefined> => {
      try { await putPart(admin, "staging", "jobs", { provider: "github", role: "service", settings }); return "accepted"; } catch (x) { return x instanceof SettingsError ? x.field : String(x); }
    };
    expect(await refused({})).toBe("settings");
    expect(await refused({ environment: "jobs / staging", workflow: "deploy.yml" })).toBe("settings");
    expect(await refused({ workflow: "deploy.sh" })).toBe("settings.workflow");
    const { part } = await putPart(admin, "staging", "jobs", { provider: "github", role: "service", settings: { workflow: "deploy-jobs.yml" } });
    expect(part).toMatchObject({ provider: "github", role: "service", settings: { workflow: "deploy-jobs.yml" } });
  });
});

describe("a github part is never polled with a credential", () => {
  it("costs nothing, resolves nothing, fetches nothing — and its state says where its deploys come from", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await env.DB.prepare(`INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
      VALUES (?, 'staging', 'jobs', 0, 'Jobs', 'service', 'github', '{"workflow":"deploy-jobs.yml"}', 'x', 'x', 'test')`).bind(ORG_A).run();
    const [part] = await listAllParts(systemCtx(ORG_A));
    expect(providerPollCost(PROVIDERS, "github")).toBe(0);
    expect(hostingPollCost([part])).toBe(0);
    const calls: string[] = [];
    const out = await pollPart(e, systemCtx(ORG_A), part, Date.parse("2026-10-15T12:40:00Z"), (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response("{}"); }) as typeof fetch);
    expect(out).toEqual({ env: "staging", part: "jobs", provider: "github", status: "ok", written: 0 });
    expect(calls).toEqual([]);
    const st = await first<{ status: string; detail: string; unavailable: string }>(env.DB, `SELECT status, detail, unavailable FROM hosting_poll_state WHERE org_id = ?`, ORG_A);
    expect(st?.status).toBe("ok");
    expect(st?.detail).toBe("deploys come from GitHub — nothing to poll");
    expect(JSON.parse(st!.unavailable).map((u: { metric: string }) => u.metric)).toEqual(["cpu", "mem_mb"]);
    expect(await all(env.DB, `SELECT kind FROM org_secrets WHERE org_id = ?`, ORG_A)).toEqual([]);
  });
});

describe("the setup read", () => {
  it("lists no connection, card step or checklist step for it; its part reads connected; its DTO says via_github", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    const admin = await tenantCtx("AndresL230");
    await putPart(admin, "staging", "jobs", { provider: "github", role: "service", settings: { environment: "jobs / staging" } });
    const dto = await getHostingSetup(admin, e);
    expect(dto.connections.map((c) => c.provider)).not.toContain("github");
    expect(dto.checklist.map((c) => c.id).filter((id) => id.includes("github"))).toEqual([]);
    expect(dto.environments.find((x) => x.key === "staging")!.parts[0]).toMatchObject({ provider: "github", connection: "connected" });
    expect(dto.providers.find((p) => p.id === "github")).toMatchObject({ via_github: true, connection_methods: [] });
    expect(providerDTO(PROVIDERS.vercel, {}).via_github).toBeUndefined();
  });
});
