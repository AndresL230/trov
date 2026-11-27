// Every operation Trov can ask for, scoped to ONE org. Trov names the org and the person; this file makes
// sure an op only ever touches sandboxes carrying that org's label, whatever id it is handed.
import { Daytona, DaytonaError, shq, type Sandbox } from "./daytona";

export const ORG_LABEL = "trov_org";
export const BY_LABEL = "trov_created_by";

const OUTPUT_LIMIT = 60_000;
const DEFAULT_AUTO_STOP = 60;
const DEFAULT_AUTO_DELETE = 60 * 24 * 7; // a stopped sandbox nobody restarts goes after a week

export class OpError extends Error {
  constructor(readonly code: "not_found" | "bad_request" | "conflict" | "upstream" | "unauthorized", message: string) {
    super(message);
    this.name = "OpError";
  }
}

export interface OpRequest {
  org: string;
  actor: string;
  op: string;
  args: Record<string, unknown>;
}

export function sandboxView(sb: Sandbox) {
  return {
    id: sb.id,
    name: sb.name,
    state: sb.state ?? null,
    snapshot: sb.snapshot ?? null,
    public: sb.public,
    cpu: sb.cpu,
    memory_gib: sb.memory,
    disk_gib: sb.disk,
    auto_stop_minutes: sb.autoStopInterval ?? null,
    created_by: sb.labels?.[BY_LABEL] ?? null,
    created_at: sb.createdAt ?? null,
    ...(sb.errorReason ? { error: sb.errorReason } : {}),
  };
}

function tail(s: string, limit = OUTPUT_LIMIT) {
  if (s.length <= limit) return s;
  return `[...${s.length - limit} earlier chars cut...]\n${s.slice(-limit)}`;
}

function looksBinary(bytes: Uint8Array) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const str = (args: Record<string, unknown>, key: string, required = true): string | undefined => {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new OpError("bad_request", `${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new OpError("bad_request", `${key} must be a string`);
  return v;
};
const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new OpError("bad_request", `${key} must be a number`);
  return v;
};
const bool = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new OpError("bad_request", `${key} must be true or false`);
  return v;
};
const strMap = (args: Record<string, unknown>, key: string): Record<string, string> | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v) || !Object.values(v as object).every((x) => typeof x === "string")) {
    throw new OpError("bad_request", `${key} must be an object of strings`);
  }
  return v as Record<string, string>;
};

/** The org's sandbox by id or name, or not_found. Never reveals that another org's sandbox exists. */
async function owned(d: Daytona, org: string, ref: string): Promise<Sandbox> {
  let sb: Sandbox;
  try {
    sb = await d.getSandbox(ref);
  } catch (e) {
    if (e instanceof DaytonaError && (e.status === 404 || e.status === 400)) throw new OpError("not_found", `No sandbox "${ref}" in this organization.`);
    throw e;
  }
  if (sb.labels?.[ORG_LABEL] !== org) throw new OpError("not_found", `No sandbox "${ref}" in this organization.`);
  return sb;
}

export async function runOp(d: Daytona, req: OpRequest): Promise<unknown> {
  const { org, actor, op, args } = req;
  if (!org || !actor) throw new OpError("bad_request", "org and actor are required");

  switch (op) {
    case "list": {
      const { items } = await d.listSandboxes({ limit: 200, labels: { [ORG_LABEL]: org } });
      // Filter again here: the label query is Daytona's, the isolation is ours.
      return { sandboxes: items.filter((s) => s.labels?.[ORG_LABEL] === org).map(sandboxView) };
    }

    case "create": {
      const sb = await d.createSandbox({
        snapshot: str(args, "snapshot", false),
        env: strMap(args, "env"),
        // The org label is set last so nothing passed in can override it.
        labels: { ...(strMap(args, "labels") ?? {}), [ORG_LABEL]: org, [BY_LABEL]: actor },
        public: bool(args, "public") ?? false,
        cpu: num(args, "cpu"),
        memory: num(args, "memory_gib"),
        disk: num(args, "disk_gib"),
        autoStopInterval: num(args, "auto_stop_minutes") ?? DEFAULT_AUTO_STOP,
        autoDeleteInterval: num(args, "auto_delete_minutes") ?? DEFAULT_AUTO_DELETE,
      });
      return sandboxView(sb);
    }

    case "get":
      return sandboxView(await owned(d, org, str(args, "sandbox")!));

    case "start": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      return sandboxView(await d.startSandbox(sb.id));
    }

    case "stop": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      return sandboxView(await d.stopSandbox(sb.id));
    }

    case "delete": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      await d.deleteSandbox(sb.id);
      return { deleted: sb.id, name: sb.name };
    }

    case "configure": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const minutes = num(args, "auto_stop_minutes");
      const pub = bool(args, "public");
      if (minutes === undefined && pub === undefined) throw new OpError("bad_request", "pass auto_stop_minutes and/or public");
      if (minutes !== undefined) await d.setAutoStop(sb.id, minutes);
      if (pub !== undefined) await d.setPublic(sb.id, pub);
      return sandboxView(await d.getSandbox(sb.id));
    }

    case "exec": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const timeout = Math.min(Math.max(num(args, "timeout_seconds") ?? 120, 1), 600);
      const r = await d.exec(sb.id, str(args, "command")!, { cwd: str(args, "cwd", false), env: strMap(args, "env"), timeoutSeconds: timeout });
      return { exit_code: r.exitCode, output: tail(r.output) };
    }

    case "run_background": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const session = str(args, "session", false) ?? "main";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) throw new OpError("bad_request", "session may use letters, digits, - and _");
      const r = await d.runInSession(sb.id, session, str(args, "command")!, true);
      return { session, command_id: r.commandId };
    }

    case "logs": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const session = str(args, "session", false) ?? "main";
      const commandId = str(args, "command_id")!;
      const [logs, status] = await Promise.all([
        d.sessionLogs(sb.id, session, commandId),
        d.commandStatus(sb.id, session, commandId).catch(() => ({ exitCode: null })),
      ]);
      const exit = status.exitCode ?? null;
      return { running: exit === null, exit_code: exit, output: tail(logs.output, Math.min(num(args, "tail_chars") ?? 8000, OUTPUT_LIMIT)) };
    }

    case "list_files": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const entries = await d.listFiles(sb.id, str(args, "path")!);
      return { entries: entries.map((e) => ({ name: e.name, dir: e.isDir, size: e.size, modified: e.modTime ?? null })) };
    }

    case "read_file": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const path = str(args, "path")!;
      const bytes = await d.downloadFile(sb.id, path);
      if (looksBinary(bytes)) return { path, binary: true, size: bytes.length };
      const s = new TextDecoder().decode(bytes);
      return { path, content: s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) : s, truncated: s.length > OUTPUT_LIMIT, size: bytes.length };
    }

    case "write_file": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const path = str(args, "path")!;
      const content = args.content;
      if (typeof content !== "string") throw new OpError("bad_request", "content must be a string");
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir) await d.exec(sb.id, `mkdir -p -- ${shq(dir)}`, { timeoutSeconds: 30 });
      await d.uploadFile(sb.id, path, content);
      return { path, bytes: new TextEncoder().encode(content).length };
    }

    case "preview_url": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      const port = num(args, "port");
      if (!port || port < 1 || port > 65535 || !Number.isInteger(port)) throw new OpError("bad_request", "port must be 1-65535");
      const signed = bool(args, "signed");
      if (sb.public && signed !== true) return { url: (await d.previewUrl(sb.id, port)).url, public: true };
      if (signed === false) {
        const p = await d.previewUrl(sb.id, port);
        return { url: p.url, token: p.token, header: "X-Daytona-Preview-Token" };
      }
      const expires = Math.min(Math.max(num(args, "expires_seconds") ?? 3600, 60), 86_400);
      return { url: (await d.signedPreviewUrl(sb.id, port, expires)).url, expires_in_seconds: expires };
    }

    case "boot": {
      // A profile's boot, started and left running: Trov reads how it went with boot_status.
      const sb = await owned(d, org, str(args, "sandbox")!);
      const script = bootScript(parseBoot(args));
      const home = (await d.exec(sb.id, `bash -lc ${shq('mkdir -p "$HOME/.trov" && printf %s "$HOME"')}`, { timeoutSeconds: 30 })).output.trim() || "/home/daytona";
      await d.uploadFile(sb.id, `${home}/.trov/boot.sh`, script);
      const r = await d.runInSession(sb.id, BOOT_SESSION, `bash ${shq(`${home}/.trov/boot.sh`)}`, true);
      return { started: true, command_id: r.commandId };
    }

    case "boot_status": {
      const sb = await owned(d, org, str(args, "sandbox")!);
      if (sb.state !== "started") return { state: sb.state ?? null, steps: [], done: null };
      const r = await d.exec(sb.id, `bash -lc ${shq('T="$HOME/.trov"; cat "$T/boot.tsv" 2>/dev/null; echo @@; cat "$T/boot.done" 2>/dev/null')}`, { timeoutSeconds: 30 });
      const [tsv, done] = r.output.split("@@");
      const steps = parseBootTsv(tsv ?? "");
      const failed = steps.find((s) => s.exit !== 0);
      let output: string | null = null;
      if (failed) {
        const log = await d.exec(sb.id, `bash -lc ${shq(`tail -c 4000 "$HOME/.trov/step-${failed.i}.log" 2>/dev/null`)}`, { timeoutSeconds: 30 });
        output = log.output;
      }
      const d0 = (done ?? "").trim();
      return { state: sb.state, steps, done: d0 === "ready" || d0 === "failed" ? d0 : null, output };
    }

    case "inspect": {
      // Refresh in the web app: what each of the org's sandboxes is doing right now.
      const { items } = await d.listSandboxes({ limit: 200, labels: { [ORG_LABEL]: org } });
      const mine = items.filter((s) => s.labels?.[ORG_LABEL] === org);
      const sandboxes = await Promise.all(mine.map(async (sb) => {
        const view = sandboxView(sb);
        if (sb.state !== "started") return { ...view, disk_used_gib: null, ports: [], processes: [] };
        try {
          const r = await d.exec(sb.id, `bash -lc ${shq(INSPECT)}`, { timeoutSeconds: 20 });
          return { ...view, ...parseInspect(r.output) };
        } catch {
          return { ...view, disk_used_gib: null, ports: [], processes: [] };
        }
      }));
      return { sandboxes };
    }

    default:
      throw new OpError("bad_request", `unknown op ${op}`);
  }
}

// ── profile boots ────────────────────────────────────────────────────────────
// A boot is ONE script, uploaded and run in the `trov-boot` session. It writes one line per step to
// ~/.trov/boot.tsv (index, exit code, milliseconds), each step's output to ~/.trov/step-<i>.log, and
// ~/.trov/boot.done ("ready" or "failed") at the end; it stops at the first failing step. The clone URL
// may carry a short-lived token: the script deletes itself first, and the clone's remote is reset to the
// clean URL, so the token is not left on the disk.

export const BOOT_SESSION = "trov-boot";

export interface BootPlan {
  clone: { url: string; clean_url: string; branch: string } | null;
  setup: string[];
  start: { cmd: string; port: number | null } | null;
}

function parseBoot(args: Record<string, unknown>): BootPlan {
  const c = args.clone as Record<string, unknown> | null | undefined;
  const clone = c && typeof c === "object"
    ? { url: str(c, "url")!, clean_url: str(c, "clean_url")!, branch: str(c, "branch")! }
    : null;
  if (clone && !/^https:\/\//.test(clone.url)) throw new OpError("bad_request", "clone.url must be https");
  const setup = Array.isArray(args.setup) ? args.setup : [];
  if (!setup.every((x) => typeof x === "string")) throw new OpError("bad_request", "setup must be a list of commands");
  const s = args.start as Record<string, unknown> | null | undefined;
  const start = s && typeof s === "object" ? { cmd: str(s, "cmd")!, port: num(s, "port") ?? null } : null;
  return { clone, setup: setup as string[], start };
}

export function bootScript(plan: BootPlan): string {
  const lines = [
    "#!/usr/bin/env bash",
    'rm -f -- "$0"',
    'T="$HOME/.trov"; mkdir -p "$T"; : > "$T/boot.tsv"; rm -f "$T/boot.done"',
    "now() { date +%s%3N; }",
    'step() { local i="$1" s e; s=$(now); bash -lc "$2" > "$T/step-$i.log" 2>&1; e=$?; ' +
      'printf "%s\\t%s\\t%s\\n" "$i" "$e" "$(( $(now) - s ))" >> "$T/boot.tsv"; ' +
      'if [ "$e" -ne 0 ]; then echo failed > "$T/boot.done"; exit 0; fi; }',
    'cd "$HOME"',
  ];
  let i = 0;
  if (plan.clone) {
    const { url, clean_url, branch } = plan.clone;
    lines.push(`step ${i++} ${shq(`git clone --depth 1 --branch ${shq(branch)} -- ${shq(url)} repo && git -C repo remote set-url origin ${shq(clean_url)}`)}`);
    lines.push('cd "$HOME/repo"');
  }
  for (const cmd of plan.setup) lines.push(`step ${i++} ${shq(cmd)}`);
  if (plan.start) {
    lines.push(`nohup bash -lc ${shq(plan.start.cmd)} > "$T/start.log" 2>&1 &`);
    if (plan.start.port) {
      const p = plan.start.port;
      lines.push(`step ${i++} ${shq(`for n in $(seq 1 180); do (exec 3<>/dev/tcp/127.0.0.1/${p}) 2>/dev/null && exit 0; sleep 1; done; echo "Nothing answered on port ${p} after 3 minutes."; tail -n 40 "$HOME/.trov/start.log"; exit 1`)}`);
    }
  }
  lines.push('echo ready > "$T/boot.done"');
  return `${lines.join("\n")}\n`;
}

export function parseBootTsv(tsv: string): { i: number; exit: number; ms: number }[] {
  return tsv.split("\n").map((l) => l.trim().split("\t")).filter((p) => p.length === 3 && p.every((x) => /^\d+$/.test(x)))
    .map(([i, exit, ms]) => ({ i: Number(i), exit: Number(exit), ms: Number(ms) }));
}

// The toolbox's own ports, not the app's.
const DAYTONA_PORTS = new Set([2280, 22220, 22221, 22222, 33333]);
const INSPECT = 'df -k --output=used "$HOME" 2>/dev/null | tail -1; echo @@; ss -ltnH 2>/dev/null | awk \'{print $4}\'; echo @@; ps -eo args= 2>/dev/null | grep -v -e "^\\[" -e "^ps " -e "^bash -lc" -e "^/usr/local/bin/daytona" -e "^sleep " -e "^grep " | head -n 20';

export function parseInspect(out: string): { disk_used_gib: number | null; ports: number[]; processes: string[] } {
  const [df = "", ss = "", ps = ""] = out.split("@@");
  const kb = Number(df.trim());
  const ports = [...new Set(ss.split("\n").map((l) => Number(l.trim().split(":").pop())).filter((p) => Number.isInteger(p) && p > 0 && !DAYTONA_PORTS.has(p)))].sort((a, b) => a - b);
  const processes = ps.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.slice(0, 200));
  return { disk_used_gib: Number.isFinite(kb) && df.trim() ? Math.round((kb / 1048576) * 10) / 10 : null, ports, processes };
}
