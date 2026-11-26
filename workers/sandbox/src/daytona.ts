// Thin fetch client for the Daytona REST API. No SDK: the official one pulls in socket.io,
// the AWS S3 client and OpenTelemetry, none of which we need inside a Worker.
//
// Two surfaces:
//   control plane  `${apiUrl}/sandbox/...`               (create, list, start, stop, preview urls)
//   toolbox        `${toolboxProxyUrl}/${sandboxId}/...`  (exec, files, sessions)
// Both take the same `Authorization: Bearer <api key>`.

export const DEFAULT_API_URL = "https://app.daytona.io/api";

export class DaytonaError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = "DaytonaError";
  }
}

export interface Sandbox {
  id: string;
  name: string;
  state?: string;
  snapshot?: string;
  public: boolean;
  cpu: number;
  memory: number;
  disk: number;
  labels?: Record<string, string>;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  createdAt?: string;
  errorReason?: string;
  toolboxProxyUrl?: string;
  [k: string]: unknown;
}

export interface CreateSandboxInput {
  name?: string;
  snapshot?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  cpu?: number;
  memory?: number;
  disk?: number;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modTime?: string;
  mode?: string;
}

type Fetch = typeof fetch;

export class Daytona {
  private readonly apiUrl: string;

  constructor(
    private readonly apiKey: string,
    apiUrl: string = DEFAULT_API_URL,
    private readonly fetcher: Fetch = (...a) => fetch(...a),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  // ---- low level ----------------------------------------------------------

  private async call(url: string, init: RequestInit = {}, accept: "json" | "text" | "bytes" = "json"): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("X-Daytona-Source", "daytona-mcp-worker");
    if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await this.fetcher(url, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let msg = body;
      try {
        const j = JSON.parse(body);
        msg = j.message ?? j.error ?? body;
        if (Array.isArray(msg)) msg = msg.join("; ");
      } catch { /* not json */ }
      throw new DaytonaError(`Daytona ${init.method ?? "GET"} ${new URL(url).pathname} failed (${res.status}): ${String(msg).slice(0, 500)}`, res.status, body);
    }
    if (accept === "bytes") return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    if (accept === "text") return text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  private api(path: string, init?: RequestInit, accept?: "json" | "text" | "bytes") {
    return this.call(`${this.apiUrl}${path}`, init, accept);
  }

  private async toolbox(sandboxRef: string, path: string, init?: RequestInit, accept?: "json" | "text" | "bytes") {
    const sb = await this.getSandbox(sandboxRef);
    if (sb.state && sb.state !== "started") {
      throw new DaytonaError(`Sandbox ${sb.name} is ${sb.state}, not started. Call start_sandbox first.`, 409, "");
    }
    let proxy = sb.toolboxProxyUrl;
    if (!proxy) proxy = (await this.api(`/sandbox/${enc(sb.id)}/toolbox-proxy-url`)).url as string;
    return this.call(`${proxy.replace(/\/+$/, "")}/${enc(sb.id)}${path}`, init, accept);
  }

  // ---- sandboxes ----------------------------------------------------------

  async listSandboxes(opts: { limit?: number; cursor?: string; labels?: Record<string, string> } = {}) {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.labels) q.set("labels", JSON.stringify(opts.labels));
    const res = await this.api(`/sandbox${q.size ? `?${q}` : ""}`);
    // Current API pages ({items, nextCursor}); older deployments return a bare array.
    if (Array.isArray(res)) return { items: res as Sandbox[], nextCursor: null as string | null };
    return { items: (res?.items ?? []) as Sandbox[], nextCursor: (res?.nextCursor ?? null) as string | null };
  }

  getSandbox(ref: string): Promise<Sandbox> {
    return this.api(`/sandbox/${enc(ref)}`);
  }

  async createSandbox(input: CreateSandboxInput, waitSeconds = 90): Promise<Sandbox> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) body[k] = v;
    const sb: Sandbox = await this.api(`/sandbox`, { method: "POST", body: JSON.stringify(body) });
    return this.waitFor(sb.id, ["started"], waitSeconds, sb);
  }

  async startSandbox(ref: string, waitSeconds = 60) {
    const sb = await this.api(`/sandbox/${enc(ref)}/start`, { method: "POST" });
    return this.waitFor(sb?.id ?? ref, ["started"], waitSeconds, sb);
  }

  async stopSandbox(ref: string, waitSeconds = 60) {
    const sb = await this.api(`/sandbox/${enc(ref)}/stop`, { method: "POST" });
    return this.waitFor(sb?.id ?? ref, ["stopped"], waitSeconds, sb);
  }

  async deleteSandbox(ref: string) {
    await this.api(`/sandbox/${enc(ref)}`, { method: "DELETE" });
  }

  async setPublic(ref: string, isPublic: boolean) {
    await this.api(`/sandbox/${enc(ref)}/public/${isPublic}`, { method: "POST" });
  }

  async setAutoStop(ref: string, minutes: number) {
    await this.api(`/sandbox/${enc(ref)}/autostop/${Math.max(0, Math.floor(minutes))}`, { method: "POST" });
  }

  async previewUrl(ref: string, port: number): Promise<{ url: string; token: string }> {
    return this.api(`/sandbox/${enc(ref)}/ports/${port}/preview-url`);
  }

  async signedPreviewUrl(ref: string, port: number, expiresInSeconds: number): Promise<{ url: string }> {
    return this.api(`/sandbox/${enc(ref)}/ports/${port}/signed-preview-url?expiresInSeconds=${expiresInSeconds}`);
  }

  private async waitFor(ref: string, want: string[], waitSeconds: number, first?: Sandbox | null): Promise<Sandbox> {
    const failed = new Set(["error", "build_failed", "destroyed"]);
    let sb = first && first.state ? first : await this.getSandbox(ref);
    const deadline = Date.now() + waitSeconds * 1000;
    while (sb.state && !want.includes(sb.state) && !failed.has(sb.state) && Date.now() < deadline) {
      await this.sleep(1500);
      sb = await this.getSandbox(ref);
    }
    return sb;
  }

  // ---- toolbox ------------------------------------------------------------

  async exec(ref: string, command: string, opts: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number } = {}) {
    const body: Record<string, unknown> = { command };
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.env) body.envs = opts.env;
    if (opts.timeoutSeconds) body.timeout = opts.timeoutSeconds;
    const res = await this.toolbox(ref, `/process/execute`, { method: "POST", body: JSON.stringify(body) });
    return { exitCode: (res?.exitCode ?? null) as number | null, output: String(res?.result ?? "") };
  }

  async ensureSession(ref: string, sessionId: string) {
    try {
      await this.toolbox(ref, `/process/session`, { method: "POST", body: JSON.stringify({ sessionId }) });
    } catch (e) {
      // Already exists: fine, reuse it.
      if (e instanceof DaytonaError && (e.status === 409 || /exist/i.test(e.body))) return;
      throw e;
    }
  }

  async runInSession(ref: string, sessionId: string, command: string, background: boolean) {
    await this.ensureSession(ref, sessionId);
    const res = await this.toolbox(ref, `/process/session/${enc(sessionId)}/exec`, {
      method: "POST",
      body: JSON.stringify({ command, runAsync: background, async: background }),
    });
    return {
      commandId: String(res?.cmdId ?? ""),
      exitCode: (res?.exitCode ?? null) as number | null,
      output: (res?.output ?? null) as string | null,
    };
  }

  async sessionLogs(ref: string, sessionId: string, commandId: string) {
    const res = await this.toolbox(ref, `/process/session/${enc(sessionId)}/command/${enc(commandId)}/logs`, {}, "text");
    // Newer toolboxes answer {output, stdout, stderr}; older ones plain text.
    try {
      const j = JSON.parse(res);
      if (j && typeof j === "object") return { output: String(j.output ?? `${j.stdout ?? ""}${j.stderr ?? ""}`), stdout: j.stdout ?? null, stderr: j.stderr ?? null };
    } catch { /* plain text */ }
    return { output: String(res), stdout: null, stderr: null };
  }

  async commandStatus(ref: string, sessionId: string, commandId: string) {
    const res = await this.toolbox(ref, `/process/session/${enc(sessionId)}/command/${enc(commandId)}`);
    return { exitCode: (res?.exitCode ?? null) as number | null, command: (res?.command ?? null) as string | null };
  }

  async listSessions(ref: string) {
    return (await this.toolbox(ref, `/process/session`)) ?? [];
  }

  async deleteSession(ref: string, sessionId: string) {
    await this.toolbox(ref, `/process/session/${enc(sessionId)}`, { method: "DELETE" });
  }

  async listFiles(ref: string, path: string): Promise<FileEntry[]> {
    return (await this.toolbox(ref, `/files?path=${encodeURIComponent(path)}`)) ?? [];
  }

  async downloadFile(ref: string, path: string): Promise<Uint8Array> {
    return this.toolbox(ref, `/files/download?path=${encodeURIComponent(path)}`, {}, "bytes");
  }

  async uploadFile(ref: string, path: string, content: Uint8Array | string) {
    const form = new FormData();
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    form.append("file", new Blob([bytes]), path.split("/").pop() || "file");
    await this.toolbox(ref, `/files/upload-v2?path=${encodeURIComponent(path)}`, { method: "POST", body: form });
  }
}

const enc = encodeURIComponent;

/** Single-quote a string for POSIX sh. */
export function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
