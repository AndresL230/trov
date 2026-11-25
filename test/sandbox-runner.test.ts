// trov-sandbox (workers/sandbox, docs/architecture/sandboxes.md): the runner's POST /op against an in-memory fake of Daytona's
// REST API — the org label on every sandbox, the not_found for another org's, and the dev loop. Trov's own half (the
// switch, the limit, ownership in D1) is test/sandboxes.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../workers/sandbox/src/index";

const API = "https://daytona.fake/api";
const PROXY = "https://proxy.fake/toolbox";

type Call = { method: string; url: string; body?: any };

function fakeDaytona() {
  const calls: Call[] = [];
  const sandboxes = new Map<string, any>();
  const files = new Map<string, Uint8Array>();
  const sessions = new Map<string, Map<string, { output: string; exitCode: number | null }>>();
  let seq = 0;

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    let body: any;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    else if (init.body instanceof FormData) body = init.body;
    calls.push({ method, url: url.toString(), body });
    if (headers.get("Authorization") !== "Bearer dtn_test") return json({ message: "Unauthorized" }, 401);

    const p = url.pathname;
    // control plane
    if (url.origin === new URL(API).origin) {
      const rest = p.replace(/^\/api/, "");
      if (rest === "/sandbox" && method === "POST") {
        const id = `sb-${++seq}`;
        const sb = { id, name: body.name ?? id, state: "creating", public: !!body.public, cpu: 1, memory: 1, disk: 3, labels: body.labels, autoStopInterval: body.autoStopInterval, toolboxProxyUrl: PROXY };
        sandboxes.set(id, sb);
        return json(sb);
      }
      if (rest === "/sandbox" && method === "GET") return json({ items: [...sandboxes.values()], nextCursor: null });
      const m = rest.match(/^\/sandbox\/([^/]+)(\/.*)?$/);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        const sb = sandboxes.get(ref) ?? [...sandboxes.values()].find((s) => s.name === ref);
        if (!sb) return json({ message: "Sandbox not found" }, 404);
        const sub = m[2] ?? "";
        if (!sub && method === "GET") {
          if (sb.state === "creating") sb.state = "started"; // comes up on the first poll
          return json(sb);
        }
        if (!sub && method === "DELETE") { sandboxes.delete(sb.id); return new Response(null, { status: 200 }); }
        if (sub === "/stop") { sb.state = "stopped"; return json(sb); }
        if (sub === "/start") { sb.state = "started"; return json(sb); }
        let mm;
        if ((mm = sub.match(/^\/public\/(true|false)$/))) { sb.public = mm[1] === "true"; return new Response(null); }
        if ((mm = sub.match(/^\/autostop\/(\d+)$/))) { sb.autoStopInterval = Number(mm[1]); return new Response(null); }
        if ((mm = sub.match(/^\/ports\/(\d+)\/preview-url$/))) return json({ sandboxId: sb.id, url: `https://${mm[1]}-${sb.id}.proxy.fake`, token: "tok" });
        if ((mm = sub.match(/^\/ports\/(\d+)\/signed-preview-url$/))) return json({ sandboxId: sb.id, port: Number(mm[1]), token: "s", url: `https://${mm[1]}-s-${sb.id}.proxy.fake?exp=${url.searchParams.get("expiresInSeconds")}` });
      }
      return json({ message: `no route ${method} ${p}` }, 404);
    }

    // toolbox
    const t = p.match(/^\/toolbox\/([^/]+)(\/.*)$/);
    if (t) {
      const sub = t[2];
      if (sub === "/process/execute") {
        const cmd: string = body.command;
        if (cmd.startsWith("mkdir")) return json({ exitCode: 0, result: "" });
        if (cmd === "big") return json({ exitCode: 0, result: "x".repeat(70_000) + "END" });
        return json({ exitCode: cmd.includes("fail") ? 1 : 0, result: `ran: ${cmd} in ${body.cwd ?? "~"} t=${body.timeout}` });
      }
      if (sub === "/process/session" && method === "POST") {
        if (sessions.has(body.sessionId)) return json({ message: "session already exists" }, 409);
        sessions.set(body.sessionId, new Map());
        return new Response(null, { status: 201 });
      }
      let mm;
      if ((mm = sub.match(/^\/process\/session\/([^/]+)\/exec$/))) {
        const cmdId = `cmd-${++seq}`;
        sessions.get(mm[1])!.set(cmdId, { output: `started ${body.command} async=${body.runAsync}\nlistening on 5173\n`, exitCode: null });
        return json({ cmdId });
      }
      if ((mm = sub.match(/^\/process\/session\/([^/]+)\/command\/([^/]+)\/logs$/))) {
        const c = sessions.get(mm[1])?.get(mm[2]);
        return c ? new Response(c.output) : json({ message: "no command" }, 404);
      }
      if ((mm = sub.match(/^\/process\/session\/([^/]+)\/command\/([^/]+)$/))) {
        const c = sessions.get(mm[1])?.get(mm[2]);
        return c ? json({ id: mm[2], command: "x", exitCode: c.exitCode }) : json({ message: "no command" }, 404);
      }
      if (sub === "/files/upload-v2") {
        const f = (body as FormData).get("file") as unknown as Blob;
        files.set(url.searchParams.get("path")!, new Uint8Array(await f.arrayBuffer()));
        return json({});
      }
      if (sub === "/files/download") {
        const f = files.get(url.searchParams.get("path")!);
        return f ? new Response(f) : json({ message: "file not found" }, 404);
      }
      if (sub === "/files") {
        const dir = url.searchParams.get("path")!;
        return json([...files.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => ({ name: k.slice(dir.length + 1), isDir: false, size: files.get(k)!.length, modTime: "2026-11-25" })));
      }
    }
    return json({ message: `no route ${method} ${url}` }, 404);
  };
  return { fetcher: fetcher as typeof fetch, calls, sandboxes, files };
}

let fake: ReturnType<typeof fakeDaytona>;
const env = { DAYTONA_API_KEY: "dtn_test", DAYTONA_API_URL: API };

async function op(org: string, name: string, args: Record<string, unknown> = {}, e: any = env) {
  const res = await handle(
    new Request("https://runner/op", { method: "POST", body: JSON.stringify({ org, actor: "andres", op: name, args }) }),
    e,
    fake.fetcher,
  );
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(() => { fake = fakeDaytona(); });

describe("the door", () => {
  it("only POST /op", async () => {
    const r = await handle(new Request("https://runner/"), env, fake.fetcher);
    expect(r.status).toBe(404);
  });
  it("503 without a key", async () => {
    expect((await op("org_a", "list", {}, { DAYTONA_API_KEY: "" })).status).toBe(503);
  });
  it("a refused key reads as upstream, never echoes it", async () => {
    const r = await op("org_a", "list", {}, { DAYTONA_API_KEY: "wrong", DAYTONA_API_URL: API });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("wrong");
  });
  it("unknown op and missing args are 400", async () => {
    expect((await op("org_a", "nope")).body.code).toBe("bad_request");
    expect((await op("org_a", "exec", { sandbox: "x" })).status).toBe(404); // no sandbox x
  });
});

describe("org isolation", () => {
  it("labels every sandbox with its org and person, and a caller cannot override the org label", async () => {
    const r = await op("org_a", "create", { labels: { trov_org: "org_b", team: "web" } });
    expect(r.status).toBe(200);
    const sent = fake.calls.find((c) => c.method === "POST" && c.url === `${API}/sandbox`)!.body;
    expect(sent.labels).toEqual({ team: "web", trov_org: "org_a", trov_created_by: "andres" });
    expect(sent.autoStopInterval).toBe(60);
    expect(sent.autoDeleteInterval).toBe(10080);
    expect(r.body.result).toMatchObject({ state: "started", created_by: "andres", public: false });
  });

  it("another org's sandbox is not_found for every op, by id and by name, and list leaves it out", async () => {
    const a = (await op("org_a", "create", {})).body.result;
    await op("org_b", "create", {});
    for (const [name, args] of [
      ["get", {}], ["start", {}], ["stop", {}], ["delete", {}], ["configure", { public: true }],
      ["exec", { command: "id" }], ["run_background", { command: "x" }], ["logs", { command_id: "c" }],
      ["list_files", { path: "/" }], ["read_file", { path: "/etc/passwd" }], ["write_file", { path: "/x", content: "" }],
      ["preview_url", { port: 80 }],
    ] as const) {
      for (const ref of [a.id, a.name]) {
        const r = await op("org_b", name, { sandbox: ref, ...args });
        expect(r.status, `${name} ${ref}`).toBe(404);
        expect(r.body.error).toMatch(/No sandbox/);
      }
    }
    expect(fake.sandboxes.get(a.id).state).toBe("started"); // untouched
    const listed = (await op("org_b", "list")).body.result.sandboxes;
    expect(listed.map((s: any) => s.id)).toEqual(["sb-2"]);
  });
});

describe("the dev loop", () => {
  it("exec, files, background, logs, preview, configure, stop/start, delete", async () => {
    const sb = (await op("org_a", "create", {})).body.result;
    const ex = (await op("org_a", "exec", { sandbox: sb.id, command: "node -v", cwd: "/w", timeout_seconds: 9999 })).body.result;
    expect(ex).toEqual({ exit_code: 0, output: "ran: node -v in /w t=600" });

    expect((await op("org_a", "write_file", { sandbox: sb.id, path: "/w/a b/x.ts", content: "hi\n" })).body.result).toEqual({ path: "/w/a b/x.ts", bytes: 3 });
    expect(fake.calls.some((c) => c.body?.command === "mkdir -p -- '/w/a b'")).toBe(true);
    expect((await op("org_a", "read_file", { sandbox: sb.id, path: "/w/a b/x.ts" })).body.result).toEqual({ path: "/w/a b/x.ts", content: "hi\n", truncated: false, size: 3 });
    expect((await op("org_a", "list_files", { sandbox: sb.id, path: "/w/a b" })).body.result.entries[0].name).toBe("x.ts");
    fake.files.set("/bin/b", new Uint8Array([1, 0, 2]));
    expect((await op("org_a", "read_file", { sandbox: sb.id, path: "/bin/b" })).body.result).toEqual({ path: "/bin/b", binary: true, size: 3 });

    const bg = (await op("org_a", "run_background", { sandbox: sb.id, command: "npm run dev -- --host 0.0.0.0" })).body.result;
    expect(bg.session).toBe("main");
    expect((await op("org_a", "run_background", { sandbox: sb.id, command: "again" })).status).toBe(200);
    expect((await op("org_a", "run_background", { sandbox: sb.id, command: "x", session: "../bad" })).status).toBe(400);
    const logs = (await op("org_a", "logs", { sandbox: sb.id, command_id: bg.command_id })).body.result;
    expect(logs).toMatchObject({ running: true, exit_code: null });
    expect(logs.output).toMatch(/listening on 5173/);

    expect((await op("org_a", "preview_url", { sandbox: sb.id, port: 5173 })).body.result).toEqual({ url: "https://5173-s-sb-1.proxy.fake?exp=3600", expires_in_seconds: 3600 });
    expect((await op("org_a", "preview_url", { sandbox: sb.id, port: 5173, signed: false })).body.result.token).toBe("tok");
    const conf = (await op("org_a", "configure", { sandbox: sb.id, auto_stop_minutes: 0, public: true })).body.result;
    expect(conf).toMatchObject({ public: true, auto_stop_minutes: 0 });
    expect((await op("org_a", "preview_url", { sandbox: sb.id, port: 5173 })).body.result).toEqual({ url: "https://5173-sb-1.proxy.fake", public: true });

    expect((await op("org_a", "stop", { sandbox: sb.id })).body.result.state).toBe("stopped");
    const blocked = await op("org_a", "exec", { sandbox: sb.id, command: "ls" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/stopped, not started/);
    expect((await op("org_a", "start", { sandbox: sb.id })).body.result.state).toBe("started");

    expect((await op("org_a", "delete", { sandbox: sb.id })).body.result).toEqual({ deleted: "sb-1", name: "sb-1" });
    expect(fake.sandboxes.size).toBe(0);
  });

  it("long output keeps the end", async () => {
    const sb = (await op("org_a", "create", {})).body.result;
    const r = (await op("org_a", "exec", { sandbox: sb.id, command: "big" })).body.result;
    expect(r.output.endsWith("END")).toBe(true);
    expect(r.output).toMatch(/^\[\.\.\.\d+ earlier chars cut/);
  });
});
