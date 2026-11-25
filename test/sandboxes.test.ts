// Sandboxes (docs/architecture/sandboxes.md): the sandbox tools on /mcp, driven through the REAL registered tools
// against a stand-in for the trov-sandbox Worker (the `SANDBOX` binding is a Fetcher; the runner's own behaviour —
// Daytona, labels — is tested in that Worker's repo). What is pinned here is Trov's half: the switch, the plan limit,
// org ownership before the runner is asked, the rows and their reconcile, and who is named as the actor.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import type { TenantContext } from "../src/data/context";
import { ORG_A, ORG_B, bearerCtx } from "./helpers/tenant";

const e = env as unknown as Env;

/** A stand-in runner: remembers each org's sandboxes, answers like trov-sandbox's POST /op. */
function fakeRunner() {
  const calls: { org: string; actor: string; op: string; args: Record<string, unknown> }[] = [];
  const boxes = new Map<string, { id: string; org: string; state: string; created_by: string }>();
  let seq = 0;
  let down = false;
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const fetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (down) throw new Error("connection refused");
      const req = new Request(input as RequestInfo, init);
      const body = (await req.json()) as { org: string; actor: string; op: string; args: Record<string, unknown> };
      calls.push(body);
      const view = (b: { id: string; state: string; created_by: string }) => ({ id: b.id, name: b.id, state: b.state, public: false, created_by: b.created_by });
      if (body.op === "list") return ok({ sandboxes: [...boxes.values()].filter((b) => b.org === body.org).map(view) });
      if (body.op === "create") {
        const b = { id: `sb-${++seq}`, org: body.org, state: "started", created_by: body.actor };
        boxes.set(b.id, b);
        return ok(view(b));
      }
      const b = boxes.get(String(body.args.sandbox));
      if (!b || b.org !== body.org) return Response.json({ ok: false, code: "not_found", error: `No sandbox "${body.args.sandbox}" in this organization.` }, { status: 404 });
      if (body.op === "delete") { boxes.delete(b.id); return ok({ deleted: b.id, name: b.id }); }
      if (body.op === "stop") { b.state = "stopped"; return ok(view(b)); }
      if (body.op === "exec") return ok({ exit_code: 0, output: `ran ${body.args.command}` });
      return ok(view(b));
    },
  };
  return { fetcher: fetcher as unknown as Fetcher, calls, boxes, setDown: (v: boolean) => { down = v; } };
}

let runner: ReturnType<typeof fakeRunner>;
const withRunner = (): Env => ({ ...e, SANDBOX: runner.fetcher });

async function setCap(orgId: string, cap: number | null | undefined) {
  const overrides = cap === undefined ? {} : { sandboxes: cap };
  await e.DB.prepare(`UPDATE orgs SET plan_overrides = ? WHERE id = ?`).bind(JSON.stringify(overrides), orgId).run();
}

async function connect(ctx: TenantContext, envUsed: Env, sandboxes = true) {
  const server = buildTrovMcpServer(envUsed, ctx, { origin: "https://trov.test", orgSlug: null, sandboxes });
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

const rows = (orgId: string) =>
  e.DB.prepare(`SELECT sandbox_id, created_by, deleted_at, deleted_by FROM org_sandboxes WHERE org_id = ? ORDER BY sandbox_id`).bind(orgId)
    .all<{ sandbox_id: string; created_by: string; deleted_at: string | null; deleted_by: string | null }>().then((r) => r.results);

const SANDBOX_TOOLS = [
  "sandbox_configure", "sandbox_create", "sandbox_delete", "sandbox_exec", "sandbox_get", "sandbox_list", "sandbox_list_files",
  "sandbox_logs", "sandbox_preview_url", "sandbox_read_file", "sandbox_run_background", "sandbox_start", "sandbox_stop", "sandbox_write_file",
];

beforeEach(() => { runner = fakeRunner(); });
afterEach(async () => { await setCap(ORG_A, undefined); await setCap(ORG_B, undefined); });

describe("listing", () => {
  it("no SANDBOX binding: no sandbox tool, whatever the caller asks for", async () => {
    const m = await connect(await bearerCtx("AndresL230"), e, true);
    const names = (await m.client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("sandbox_"))).toEqual([]);
    await m.close();
  });

  it("with the binding and the org switched on: the 14 tools, the reads marked read-only", async () => {
    const m = await connect(await bearerCtx("AndresL230"), withRunner());
    const tools = (await m.client.listTools()).tools.filter((t) => t.name.startsWith("sandbox_"));
    expect(tools.map((t) => t.name).sort()).toEqual(SANDBOX_TOOLS);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort())
      .toEqual(["sandbox_get", "sandbox_list", "sandbox_list_files", "sandbox_logs", "sandbox_read_file"]);
    await m.close();
  });
});

describe("the switch", () => {
  it("cap 0 (every plan's default): every tool refuses not_enabled and the runner is never asked", async () => {
    const m = await connect(await bearerCtx("AndresL230"), withRunner());
    for (const name of SANDBOX_TOOLS) {
      const r = await m.call(name, { sandbox: "sb-1", command: "id", path: "/", content: "", port: 80, command_id: "c" });
      expect(r.isError, name).toBe(true);
      expect(r.body.code, name).toBe("not_enabled");
    }
    expect(runner.calls).toEqual([]);
    await m.close();
  });

  it("a Sample workspace is refused even with a cap", async () => {
    await setCap(ORG_A, 5);
    await e.DB.prepare(`UPDATE orgs SET sample = 1 WHERE id = ?`).bind(ORG_A).run();
    try {
      const m = await connect(await bearerCtx("AndresL230"), withRunner());
      expect((await m.call("sandbox_list")).body.code).toBe("not_enabled");
      expect(runner.calls).toEqual([]);
      await m.close();
    } finally {
      await e.DB.prepare(`UPDATE orgs SET sample = 0 WHERE id = ?`).bind(ORG_A).run();
    }
  });
});

describe("with sandboxes on", () => {
  it("creates as the bearer, records the row, and refuses past the cap with plan_limit", async () => {
    await setCap(ORG_A, 2);
    const m = await connect(await bearerCtx("AndresL230"), withRunner());
    const one = await m.call("sandbox_create", { auto_stop_minutes: 30 });
    expect(one.isError).toBe(false);
    expect(one.body).toMatchObject({ id: "sb-1", state: "started", created_by: "AndresL230" });
    const create = runner.calls.find((c) => c.op === "create")!;
    expect(create).toMatchObject({ org: ORG_A, actor: "AndresL230", args: { auto_stop_minutes: 30 } });
    await m.call("sandbox_create");
    const third = await m.call("sandbox_create");
    expect(third.isError).toBe(true);
    expect(third.body.code).toBe("plan_limit");
    expect(runner.calls.filter((c) => c.op === "create")).toHaveLength(2);
    expect((await rows(ORG_A)).map((r) => [r.sandbox_id, r.created_by, r.deleted_at])).toEqual([["sb-1", "AndresL230", null], ["sb-2", "AndresL230", null]]);
    expect((await m.call("sandbox_list")).body).toMatchObject({ limit: 2, sandboxes: [{ id: "sb-1" }, { id: "sb-2" }] });
    await m.close();
  });

  it("another org's sandbox is not_found here, before the runner is asked", async () => {
    await setCap(ORG_A, 2);
    await setCap(ORG_B, 2);
    const a = await connect(await bearerCtx("AndresL230"), withRunner());
    const made = (await a.call("sandbox_create")).body;
    await a.close();

    const b = await connect(await bearerCtx("AndresL230", "owner", undefined, ORG_B), withRunner());
    const before = runner.calls.length;
    for (const name of ["sandbox_get", "sandbox_exec", "sandbox_stop", "sandbox_delete", "sandbox_read_file", "sandbox_preview_url"]) {
      const r = await b.call(name, { sandbox: made.id, command: "id", path: "/etc/passwd", port: 3000 });
      expect(r.body.code, name).toBe("not_found");
    }
    expect(runner.calls.length).toBe(before);
    expect(runner.boxes.get(made.id)!.state).toBe("started");
    await b.close();
  });

  it("forwards ops on its own sandbox with the org and person, and delete records who", async () => {
    await setCap(ORG_A, 1);
    const m = await connect(await bearerCtx("AndresL230"), withRunner());
    const sb = (await m.call("sandbox_create")).body;
    expect((await m.call("sandbox_exec", { sandbox: sb.id, command: "node -v" })).body).toEqual({ exit_code: 0, output: "ran node -v" });
    expect(runner.calls.at(-1)).toMatchObject({ org: ORG_A, actor: "AndresL230", op: "exec", args: { sandbox: sb.id, command: "node -v" } });
    expect((await m.call("sandbox_stop", { sandbox: sb.id })).body.state).toBe("stopped");
    expect((await m.call("sandbox_delete", { sandbox: sb.id })).body).toMatchObject({ deleted: sb.id });
    const [row] = await rows(ORG_A);
    expect(row.deleted_by).toBe("AndresL230");
    expect(row.deleted_at).not.toBeNull();
    // the slot is free again
    expect((await m.call("sandbox_create")).isError).toBe(false);
    // and the deleted one is gone from this org
    expect((await m.call("sandbox_get", { sandbox: sb.id })).body.code).toBe("not_found");
    await m.close();
  });

  it("a sandbox Daytona auto-deleted gives its slot back on the next list or create", async () => {
    await setCap(ORG_A, 1);
    const m = await connect(await bearerCtx("AndresL230"), withRunner());
    const sb = (await m.call("sandbox_create")).body;
    runner.boxes.delete(sb.id); // gone on Daytona's side
    expect((await m.call("sandbox_create")).isError).toBe(false);
    const r = await rows(ORG_A);
    expect(r.find((x) => x.sandbox_id === sb.id)).toMatchObject({ deleted_by: null });
    expect(r.find((x) => x.sandbox_id === sb.id)!.deleted_at).not.toBeNull();
    await m.close();
  });

  it("the runner being down is a plain tool error, not a crash", async () => {
    await setCap(ORG_A, 1);
    runner.setDown(true);
    const m = await connect(await bearerCtx("AndresL230"), withRunner());
    const r = await m.call("sandbox_list");
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe("unavailable");
    await m.close();
  });
});
