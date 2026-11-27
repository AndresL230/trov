// Monitor › Sandboxes and Org settings › Sandboxes (0090_sandbox_monitor, docs/architecture/sandboxes.md): names, the
// event record and its stories, the org's rules, profiles and their boot, the access statuses, and the cookie routes.
// The runner is a stand-in Fetcher, as in test/sandboxes.test.ts; the boot script itself is pinned in
// test/sandbox-runner.test.ts.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import type { TenantContext } from "../src/data/context";
import { drainBoots } from "../src/sandboxes/boot";
import { takePendingBoots } from "../src/sandboxes/pending";
import { sandboxAccess } from "../src/plans/gate";
import { scrubOutput } from "../src/tools/sandboxes";
import { ORG_TABLES } from "../src/deletion/tables";
import { HANDLE_COLUMNS } from "../src/auth/persons";
import {
  SANDBOXES_ROUTE, SANDBOX_PROFILES_ROUTE, SANDBOX_RULES_ROUTE, SANDBOX_SETTINGS_ROUTE, activityBuckets, checkSandboxProfile, sandboxStories,
  type SandboxEventView, type SandboxesPage, type SandboxSettingsPage,
} from "@shared/sandboxes-core";
import { ORG_A, bearerCtx, ensureMember, systemCtx } from "./helpers/tenant";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";

const e = env as unknown as Env;
type Op = { org: string; actor: string; op: string; args: Record<string, unknown> };

function fakeRunner() {
  const calls: Op[] = [];
  const boxes = new Map<string, { id: string; org: string; state: string; created_by: string; public: boolean }>();
  let seq = 0;
  let boot: { steps: { i: number; exit: number; ms: number }[]; done: "ready" | "failed" | null; output?: string } = { steps: [], done: null };
  let execAnswer = { exit_code: 0, output: "ok" };
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const view = (b: { id: string; state: string; created_by: string; public: boolean }) => ({ id: b.id, name: b.id, state: b.state, public: b.public, created_by: b.created_by, cpu: 1, memory_gib: 1, disk_gib: 3 });
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const body = (await new Request(input as RequestInfo, init).json()) as Op;
      calls.push(body);
      const mine = [...boxes.values()].filter((b) => b.org === body.org);
      if (body.op === "list") return ok({ sandboxes: mine.map(view) });
      if (body.op === "inspect") return ok({ sandboxes: mine.map((b) => ({ ...view(b), disk_used_gib: 1.2, ports: [5173], processes: ["node vite"] })) });
      if (body.op === "create") {
        const b = { id: `sb-${++seq}`, org: body.org, state: "started", created_by: body.actor, public: body.args.public === true };
        boxes.set(b.id, b);
        return ok(view(b));
      }
      const b = boxes.get(String(body.args.sandbox));
      if (!b || b.org !== body.org) return Response.json({ ok: false, code: "not_found", error: `No sandbox "${body.args.sandbox}" in this organization.` }, { status: 404 });
      if (body.op === "delete") { boxes.delete(b.id); return ok({ deleted: b.id, name: b.id }); }
      if (body.op === "stop") { b.state = "stopped"; return ok(view(b)); }
      if (body.op === "start") { b.state = "started"; return ok(view(b)); }
      if (body.op === "exec") return ok(execAnswer);
      if (body.op === "boot") return ok({ started: true, command_id: "c-boot" });
      if (body.op === "boot_status") return ok({ state: "started", ...boot });
      if (body.op === "preview_url") return ok({ url: "https://5173-x.proxy.daytona.works?sig=1", expires_in_seconds: 3600 });
      return ok(view(b));
    },
  };
  return {
    fetcher: fetcher as unknown as Fetcher, calls, boxes,
    setBoot: (v: typeof boot) => { boot = v; }, setExec: (v: typeof execAnswer) => { execAnswer = v; },
  };
}

let runner: ReturnType<typeof fakeRunner>;
const withRunner = (): Env => ({ ...e, SANDBOX: runner.fetcher });

async function connect(ctx: TenantContext) {
  const server = buildTrovMcpServer(withRunner(), ctx, { origin: "https://trov.test", orgSlug: null, sandboxes: true });
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

const BASE = "/api/o/saplinglearn";
async function req<T = unknown>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(`${BASE}${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }, withRunner());
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}

const events = (id: string) => e.DB.prepare(`SELECT actor, source, tool, subject, result, exit_code, failed, output FROM sandbox_events WHERE org_id = ? AND sandbox_id = ? ORDER BY id`)
  .bind(ORG_A, id).all<Record<string, unknown>>().then((r) => r.results);

const PROFILE = {
  name: "Web app", description: "The SPA with a dev server", repo: "sapling/web", branch: "main", size: "medium",
  setup: ["npm ci"], start_cmd: "npm run dev -- --host 0.0.0.0", port: 5173, env: { NODE_ENV: "development" },
};

beforeEach(() => { runner = fakeRunner(); takePendingBoots(); });
afterEach(async () => {
  await e.DB.prepare(`UPDATE orgs SET plan = 'enterprise', plan_overrides = '{}', sandbox_members_act = 1, sandbox_public = 0 WHERE id = ?`).bind(ORG_A).run();
});

describe("access", () => {
  it("Enterprise has no limit, Pro three, Free none; a Platform override of 0 is off", async () => {
    expect(await sandboxAccess(systemCtx())).toEqual({ status: "on", cap: null, plan: "enterprise" });
    await e.DB.prepare(`UPDATE orgs SET plan = 'team' WHERE id = ?`).bind(ORG_A).run();
    expect(await sandboxAccess(systemCtx())).toEqual({ status: "on", cap: 3, plan: "team" });
    await e.DB.prepare(`UPDATE orgs SET plan = 'free' WHERE id = ?`).bind(ORG_A).run();
    expect(await sandboxAccess(systemCtx())).toMatchObject({ status: "not_included", cap: 0 });
    await e.DB.prepare(`UPDATE orgs SET plan = 'team', plan_overrides = '{"sandboxes":0}' WHERE id = ?`).bind(ORG_A).run();
    expect(await sandboxAccess(systemCtx())).toMatchObject({ status: "off", cap: 0 });
  });
});

describe("names and the record", () => {
  it("names a sandbox, finds it by name, refuses a taken one, and records each call as the bearer", async () => {
    const m = await connect(await bearerCtx("AndresL230"));
    const a = await m.call("sandbox_create", { name: "gradebook-fix" });
    expect(a.body).toMatchObject({ id: "sb-1", name: "gradebook-fix", boot: "none" });
    const dup = await m.call("sandbox_create", { name: "gradebook-fix" });
    expect(dup.body.code).toBe("conflict");
    const bad = await m.call("sandbox_create", { name: "Not OK" });
    expect(bad.body.code).toBe("bad_request");
    const auto = await m.call("sandbox_create");
    expect(auto.body.name).toMatch(/^sandbox-[0-9a-f]{4}$/);

    runner.setExec({ exit_code: 1, output: "npm ERR! token ghp_abcdefghijklmnopqrstuvwx1234 failed" });
    const ran = await m.call("sandbox_exec", { sandbox: "gradebook-fix", command: "npm test", env: { SECRET_THING: "hunter2-long" } });
    expect(ran.body.exit_code).toBe(1);
    expect(runner.calls.find((c) => c.op === "exec")!.args.sandbox).toBe("sb-1"); // the name became the id before the runner was asked
    await m.call("sandbox_write_file", { sandbox: "gradebook-fix", path: "src/a.ts", content: "x" });
    await m.call("sandbox_stop", { sandbox: "gradebook-fix" });

    const ev = await events("sb-1");
    expect(ev.map((x) => [x.source, x.tool])).toEqual([
      ["agent", "sandbox_create"], ["agent", "sandbox_exec"], ["agent", "sandbox_write_file"], ["agent", "sandbox_stop"],
    ]);
    expect(ev[1]).toMatchObject({ actor: "AndresL230", subject: "npm test", exit_code: 1, failed: 1 });
    expect(ev[1].output).toBe("npm ERR! token [redacted] failed"); // a failure keeps a scrubbed tail
    expect(ev[2]).toMatchObject({ subject: "src/a.ts", failed: 0, output: null });
    await m.close();
  });

  it("refuses a public sandbox unless the org allows public previews", async () => {
    const m = await connect(await bearerCtx("AndresL230"));
    expect((await m.call("sandbox_create", { public: true })).body.code).toBe("forbidden");
    expect(runner.calls.some((c) => c.op === "create")).toBe(false);
    await e.DB.prepare(`UPDATE orgs SET sandbox_public = 1 WHERE id = ?`).bind(ORG_A).run();
    expect((await m.call("sandbox_create", { public: true })).body).toMatchObject({ public: true });
    await m.close();
  });

  it("scrubs known values and token shapes before it cuts", () => {
    expect(scrubOutput("clone https://x-access-token:ghs_abc123def456@github.com/a/b", [])).toBe("clone https://x-access-token:[redacted]@github.com/a/b");
    expect(scrubOutput("value=supersecret1", ["supersecret1"])).toBe("value=[redacted]");
    expect(scrubOutput("a".repeat(2000) + "TAIL", [], 10)).toBe("…aaaaaaTAIL");
  });
});

describe("profiles and boots", () => {
  it("an admin saves a profile; a create from it boots: pending → booting (drain) → ready (poll), each step recorded", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    const saved = await req(admin, "PUT", `${SANDBOX_PROFILES_ROUTE}/web`, PROFILE);
    expect(saved.status).toBe(201);
    const audit = await e.DB.prepare(`SELECT action, target FROM org_admin_audit WHERE org_id = ? AND action LIKE 'sandbox.%'`).bind(ORG_A).all();
    expect(audit.results).toEqual([{ action: "sandbox.profile_set", target: "web" }]);

    const m = await connect(await bearerCtx("AndresL230"));
    const profiles = await m.call("sandbox_list_profiles");
    expect(profiles.body.profiles[0]).toMatchObject({ key: "web", boot: ["clone sapling/web@main", "npm ci", "npm run dev -- --host 0.0.0.0 (waits for port 5173)"], env: ["NODE_ENV"] });
    expect(JSON.stringify(profiles.body)).not.toContain("development"); // names, never values

    const made = await m.call("sandbox_create", { profile: "web", branch: "feat/x" });
    expect(made.body).toMatchObject({ name: expect.stringMatching(/^web-/), profile: "web", boot: "pending" });
    expect(runner.calls.find((c) => c.op === "create")!.args).toMatchObject({ cpu: 2, memory_gib: 4, env: { NODE_ENV: "development" }, auto_delete_minutes: 7 * 1440, labels: { trov_profile: "web" } });
    expect(takePendingBoots()).toBe(true);

    expect(await drainBoots(withRunner())).toBe(1);
    const bootCall = runner.calls.find((c) => c.op === "boot")!;
    expect(bootCall.args).toMatchObject({
      sandbox: "sb-1", clone: { url: "https://github.com/sapling/web.git", clean_url: "https://github.com/sapling/web.git", branch: "feat/x" },
      setup: ["npm ci"], start: { cmd: "npm run dev -- --host 0.0.0.0", port: 5173 },
    });
    expect(await drainBoots(withRunner())).toBe(0); // claimed once

    runner.setBoot({ steps: [{ i: 0, exit: 0, ms: 900 }], done: null });
    expect((await m.call("sandbox_get", { sandbox: made.body.name })).body).toMatchObject({ boot: "booting", boot_done: 1 });
    runner.setBoot({ steps: [{ i: 0, exit: 0, ms: 900 }, { i: 1, exit: 0, ms: 30000 }, { i: 2, exit: 0, ms: 4000 }], done: "ready" });
    expect((await m.call("sandbox_get", { sandbox: made.body.name })).body).toMatchObject({ boot: "ready", boot_done: 3 });
    const boots = (await events("sb-1")).filter((x) => x.source === "boot");
    expect(boots.map((x) => x.subject)).toEqual(["clone sapling/web@feat/x", "npm ci", "npm run dev -- --host 0.0.0.0 (waits for port 5173)"]);
    expect(boots.every((x) => x.actor === "AndresL230")).toBe(true);
    await m.close();
  });

  it("a failing step settles the boot failed, keeping that step's output", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    await req(admin, "PUT", `${SANDBOX_PROFILES_ROUTE}/api`, { name: "API", setup: ["make test"] });
    const m = await connect(await bearerCtx("AndresL230"));
    await m.call("sandbox_create", { profile: "api" });
    await drainBoots(withRunner());
    runner.setBoot({ steps: [{ i: 0, exit: 2, ms: 100 }], done: "failed", output: "make: *** No rule" });
    const got = await m.call("sandbox_get", { sandbox: "sb-1" });
    expect(got.body).toMatchObject({ boot: "failed", boot_failed_step: "make test" });
    expect((await events("sb-1")).at(-1)).toMatchObject({ source: "boot", failed: 1, output: "make: *** No rule" });
    await m.close();
  });

  it("validates a profile and keeps a deleted key reserved; members may read but not write", async () => {
    expect(checkSandboxProfile({ key: "Bad Key", name: "x" })).toMatchObject({ ok: false });
    expect(checkSandboxProfile({ key: "ok", name: "x", port: 80 })).toEqual({ ok: false, error: "port: needs a start command to wait for." });
    const admin = await cookieFor(FIXTURE_ADMIN);
    expect((await req(admin, "PUT", `${SANDBOX_PROFILES_ROUTE}/web`, { ...PROFILE, size: "huge" })).status).toBe(400);
    expect((await req(admin, "PUT", `${SANDBOX_PROFILES_ROUTE}/web`, PROFILE)).status).toBe(201);
    expect((await req(admin, "PUT", `${SANDBOX_PROFILES_ROUTE}/web`, { ...PROFILE, name: "Web 2" })).status).toBe(200);
    await ensureMember("sb-member");
    const member = await cookieFor("sb-member");
    expect((await req(member, "PUT", `${SANDBOX_PROFILES_ROUTE}/web`, PROFILE)).status).toBe(403);
    const page = await req<SandboxSettingsPage>(member, "GET", SANDBOX_SETTINGS_ROUTE);
    expect(page.status).toBe(200);
    expect(page.json.profiles.map((p) => [p.key, p.name])).toEqual([["web", "Web 2"]]);
    expect((await req(admin, "DELETE", `${SANDBOX_PROFILES_ROUTE}/web`)).status).toBe(200);
    expect((await req(admin, "PUT", `${SANDBOX_PROFILES_ROUTE}/web`, PROFILE)).status).toBe(409);
  });
});

describe("the screen's routes", () => {
  it("GET reads D1 only; members act unless the rule says admins; acts are recorded as the person", async () => {
    const m = await connect(await bearerCtx("AndresL230"));
    await m.call("sandbox_create", { name: "one" });
    await m.call("sandbox_exec", { sandbox: "one", command: "ls" });
    await m.close();
    runner.calls.length = 0;

    await ensureMember("sb-member");
    const member = await cookieFor("sb-member");
    const page = await req<SandboxesPage>(member, "GET", SANDBOXES_ROUTE);
    expect(page.status).toBe(200);
    expect(runner.calls).toEqual([]); // invariant 7
    expect(page.json).toMatchObject({ access: { status: "on" }, used: 1, can_act: true, is_admin: false, runner: true });
    expect(page.json.sandboxes[0]).toMatchObject({ name: "one", created_by: "AndresL230", event_count: 2 });
    expect(page.json.sandboxes[0].stories.map((s) => [s.kind, s.title])).toEqual([["lifecycle", "Created"], ["commands", "Ran 1 command"]]);

    const refresh = await req<{ live: Record<string, { ports: number[] }> }>(member, "POST", `${SANDBOXES_ROUTE}/refresh`);
    expect(refresh.status).toBe(200);
    expect(refresh.json.live["sb-1"].ports).toEqual([5173]);

    const admin = await cookieFor(FIXTURE_ADMIN);
    expect((await req(member, "PUT", SANDBOX_RULES_ROUTE, { members_act: false })).status).toBe(403);
    expect((await req(admin, "PUT", SANDBOX_RULES_ROUTE, { members_act: false })).json).toEqual({ members_act: false, public_previews: false });
    expect((await req(member, "POST", `${SANDBOXES_ROUTE}/one/stop`)).status).toBe(403);
    expect((await req(admin, "POST", `${SANDBOXES_ROUTE}/one/stop`)).status).toBe(200);
    expect((await events("sb-1")).at(-1)).toMatchObject({ source: "person", actor: FIXTURE_ADMIN, tool: "sandbox_stop" });
    expect((await req(admin, "DELETE", `${SANDBOXES_ROUTE}/one`)).status).toBe(200);

    const after = await req<SandboxesPage>(admin, "GET", SANDBOXES_ROUTE);
    expect(after.json.sandboxes).toEqual([]);
    expect(after.json.history[0]).toMatchObject({ name: "one", deleted_by: FIXTURE_ADMIN });
  });

  it("refuses a bearer on every route", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    for (const path of [SANDBOXES_ROUTE, SANDBOX_SETTINGS_ROUTE]) {
      const res = await app.request(`${BASE}${path}`, { headers: { cookie, authorization: "Bearer trov_mcp_x" } }, withRunner());
      expect(res.status, path).toBe(403);
    }
  });
});

describe("stories (pure)", () => {
  const ev = (id: number, min: number, tool: string, extra: Partial<SandboxEventView> = {}): SandboxEventView => ({
    id, at: new Date(Date.UTC(2026, 10, 27, 1, 0) + min * 60_000).toISOString(), actor: "a", source: "agent", tool,
    subject: "", result: "", exit_code: null, ms: null, failed: false, output: null, ...extra,
  });
  it("groups boot steps, lifecycle calls, background commands with their log reads, and commands split by a pause", () => {
    const s = sandboxStories([
      ev(1, 0, "sandbox_create"), ev(2, 1, "boot_step", { source: "boot", subject: "clone" }), ev(3, 2, "boot_step", { source: "boot", subject: "npm ci" }),
      ev(4, 3, "sandbox_exec"), ev(5, 4, "sandbox_write_file", { subject: "a.ts" }), ev(6, 5, "sandbox_exec", { failed: true }),
      ev(7, 30, "sandbox_exec"), ev(8, 31, "sandbox_run_background", { subject: "npm run dev", result: "c1" }), ev(9, 32, "sandbox_logs", { subject: "c1" }),
    ], "web");
    expect(s.map((x) => [x.kind, x.title, x.events.length])).toEqual([
      ["lifecycle", "Created", 1], ["boot", "Booted from web: 2 steps", 2], ["commands", "Ran 2 commands, touched 1 file; 1 failure", 3],
      ["commands", "Ran 1 command", 1], ["background", "Started in the background: npm run dev", 2],
    ]);
  });
  it("buckets activity by half hour", () => {
    const now = Date.UTC(2026, 10, 27, 6, 0);
    expect(activityBuckets([new Date(now - 60_000).toISOString(), new Date(now - 31 * 60_000).toISOString(), new Date(now - 7 * 3600_000).toISOString()], now))
      .toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });
});

describe("registration", () => {
  it("the new tables are in ORG_TABLES and their handle columns in HANDLE_COLUMNS", () => {
    expect(ORG_TABLES).toEqual(expect.arrayContaining(["sandbox_events", "sandbox_profiles"]));
    const cols = HANDLE_COLUMNS.map(([t, c]) => `${t}.${c}`);
    expect(cols).toEqual(expect.arrayContaining(["sandbox_events.actor", "sandbox_profiles.created_by", "sandbox_profiles.updated_by", "sandbox_profiles.deleted_by"]));
  });
});
