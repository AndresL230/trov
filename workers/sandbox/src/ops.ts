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

    default:
      throw new OpError("bad_request", `unknown op ${op}`);
  }
}
