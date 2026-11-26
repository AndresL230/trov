// Sandboxes (docs/architecture/sandboxes.md; 0089_sandboxes): Daytona VMs an organization's agents create and drive
// over MCP. Trov does the deciding — who is calling, which org, whether that org has sandboxes on, whether the sandbox
// is the org's — and the trov-sandbox Worker (the `SANDBOX` Service Binding) does the running: it holds the Daytona
// key, so no MCP path here ever reads a secret (canopy-multitenancy.md D14), and it labels and checks every sandbox
// with the org it is told, so a wrong id from here still cannot reach another org's VM.
//
// The ONE switch is the `sandboxes` limit (shared/plans.ts): 0 on every plan, set per org by a superadmin in
// Platform. 0 refuses every tool; N caps the sandboxes the org has at once.
import type { Env } from "../env";
import { all, first, run, nowIso, type TenantContext } from "../data/sql";
import { limitCap, requirePlan } from "../plans/gate";

export class SandboxError extends Error {
  constructor(readonly code: "not_enabled" | "not_found" | "bad_request" | "conflict" | "unavailable", message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** What the runner answers for one sandbox. */
export interface SandboxView {
  id: string;
  name: string;
  state: string | null;
  public: boolean;
  created_by: string | null;
  [k: string]: unknown;
}

const NOT_ENABLED = "Sandboxes aren't turned on for this organization. Nothing was created or run.";

/** Is the sandbox capability on for this org at all? (The binding is there, it is not a Sample workspace, cap > 0.) */
export async function sandboxesEnabled(env: Pick<Env, "SANDBOX">, ctx: TenantContext): Promise<boolean> {
  if (!env.SANDBOX) return false;
  const org = await first<{ sample: number }>(ctx, `SELECT sample FROM orgs WHERE id = ?`, ctx.orgId);
  if (!org || org.sample === 1) return false;
  const cap = await limitCap(ctx, "sandboxes");
  return cap === null || cap > 0;
}

async function gate(env: Env, ctx: TenantContext): Promise<Fetcher> {
  if (!(await sandboxesEnabled(env, ctx))) throw new SandboxError("not_enabled", NOT_ENABLED);
  return env.SANDBOX!;
}

/** One op on the runner, for this org and this person. */
async function call<T>(runner: Fetcher, ctx: TenantContext, op: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await runner.fetch("https://trov-sandbox/op", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ctx.orgId, actor: ctx.userId, op, args }),
    });
  } catch {
    throw new SandboxError("unavailable", "The sandbox service is unreachable right now. Try again shortly.");
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; code?: string; error?: string } | null;
  if (res.ok && body?.ok) return body.result as T;
  const message = typeof body?.error === "string" ? body.error.slice(0, 500) : `The sandbox service answered ${res.status}.`;
  const code = body?.code === "not_found" || body?.code === "bad_request" || body?.code === "conflict" ? body.code : "unavailable";
  throw new SandboxError(code, message);
}

/** The org's live sandbox `ref` names, or not_found — checked here before the runner is asked anything. */
async function ownedId(ctx: TenantContext, ref: unknown): Promise<string> {
  if (typeof ref !== "string" || !ref.trim()) throw new SandboxError("bad_request", "sandbox is required: an id from sandbox_list.");
  const row = await first<{ sandbox_id: string }>(ctx,
    `SELECT sandbox_id FROM org_sandboxes WHERE org_id = ? AND sandbox_id = ? AND deleted_at IS NULL`, ctx.orgId, ref.trim());
  if (!row) throw new SandboxError("not_found", `No sandbox "${ref.trim()}" in this organization. sandbox_list shows the ones it has.`);
  return row.sandbox_id;
}

/**
 * Line the org's rows up with what Daytona has: a live row Daytona no longer lists was auto-deleted there
 * (`deleted_by` NULL); a sandbox carrying this org's label with no row (a create whose row write failed) gets one.
 */
async function reconcile(ctx: TenantContext, seen: SandboxView[]): Promise<void> {
  const live = await all<{ sandbox_id: string }>(ctx, `SELECT sandbox_id FROM org_sandboxes WHERE org_id = ? AND deleted_at IS NULL`, ctx.orgId);
  const seenIds = new Set(seen.map((s) => s.id));
  const now = nowIso();
  for (const r of live) {
    if (!seenIds.has(r.sandbox_id)) {
      await run(ctx, `UPDATE org_sandboxes SET deleted_at = ? WHERE org_id = ? AND sandbox_id = ? AND deleted_at IS NULL`, now, ctx.orgId, r.sandbox_id);
    }
  }
  const known = new Set(live.map((r) => r.sandbox_id));
  for (const s of seen) {
    if (!known.has(s.id)) {
      await run(ctx, `INSERT OR IGNORE INTO org_sandboxes (org_id, sandbox_id, created_by, created_at) VALUES (?, ?, ?, ?)`,
        ctx.orgId, s.id, s.created_by ?? ctx.userId, now);
    }
  }
}

// ── the operations, one per MCP tool ───────────────────────────────────────

export async function listSandboxes(env: Env, ctx: TenantContext) {
  const runner = await gate(env, ctx);
  const { sandboxes } = await call<{ sandboxes: SandboxView[] }>(runner, ctx, "list");
  await reconcile(ctx, sandboxes);
  const cap = await limitCap(ctx, "sandboxes");
  return { sandboxes, limit: cap };
}

export interface CreateArgs {
  snapshot?: string;
  env?: Record<string, string>;
  public?: boolean;
  cpu?: number;
  memory_gib?: number;
  disk_gib?: number;
  auto_stop_minutes?: number;
}

export async function createSandbox(env: Env, ctx: TenantContext, args: CreateArgs) {
  const runner = await gate(env, ctx);
  // Count what Daytona really has first, so a sandbox it auto-deleted gives its slot back.
  const { sandboxes } = await call<{ sandboxes: SandboxView[] }>(runner, ctx, "list");
  await reconcile(ctx, sandboxes);
  await requirePlan(ctx, "sandboxes", 1);
  const sb = await call<SandboxView>(runner, ctx, "create", { ...args });
  await run(ctx, `INSERT OR IGNORE INTO org_sandboxes (org_id, sandbox_id, created_by, created_at) VALUES (?, ?, ?, ?)`,
    ctx.orgId, sb.id, ctx.userId, nowIso());
  return sb.state === "started" ? sb : { ...sb, note: `It is ${sb.state}; call sandbox_get until it reads started.` };
}

/** An op on ONE of the org's sandboxes: gate, ownership here, then the runner (which checks the org label again). */
async function onSandbox<T>(env: Env, ctx: TenantContext, op: string, args: Record<string, unknown>): Promise<T> {
  const runner = await gate(env, ctx);
  const id = await ownedId(ctx, args.sandbox);
  try {
    return await call<T>(runner, ctx, op, { ...args, sandbox: id });
  } catch (err) {
    // Gone on Daytona's side (auto-deleted): the row says so from now on.
    if (err instanceof SandboxError && err.code === "not_found" && /No sandbox/.test(err.message)) {
      await run(ctx, `UPDATE org_sandboxes SET deleted_at = ? WHERE org_id = ? AND sandbox_id = ? AND deleted_at IS NULL`, nowIso(), ctx.orgId, id);
    }
    throw err;
  }
}

export const getSandbox = (env: Env, ctx: TenantContext, args: { sandbox: string }) => onSandbox<SandboxView>(env, ctx, "get", args);
export const startSandbox = (env: Env, ctx: TenantContext, args: { sandbox: string }) => onSandbox<SandboxView>(env, ctx, "start", args);
export const stopSandbox = (env: Env, ctx: TenantContext, args: { sandbox: string }) => onSandbox<SandboxView>(env, ctx, "stop", args);

export async function deleteSandbox(env: Env, ctx: TenantContext, args: { sandbox: string }) {
  const result = await onSandbox<{ deleted: string }>(env, ctx, "delete", args);
  await run(ctx, `UPDATE org_sandboxes SET deleted_at = ?, deleted_by = ? WHERE org_id = ? AND sandbox_id = ? AND deleted_at IS NULL`,
    nowIso(), ctx.userId, ctx.orgId, result.deleted);
  return result;
}

export const configureSandbox = (env: Env, ctx: TenantContext, args: { sandbox: string; auto_stop_minutes?: number; public?: boolean }) =>
  onSandbox<SandboxView>(env, ctx, "configure", args);
export const execInSandbox = (env: Env, ctx: TenantContext, args: { sandbox: string; command: string; cwd?: string; env?: Record<string, string>; timeout_seconds?: number }) =>
  onSandbox<{ exit_code: number | null; output: string }>(env, ctx, "exec", args);
export const runBackground = (env: Env, ctx: TenantContext, args: { sandbox: string; command: string; session?: string }) =>
  onSandbox<{ session: string; command_id: string }>(env, ctx, "run_background", args);
export const sandboxLogs = (env: Env, ctx: TenantContext, args: { sandbox: string; command_id: string; session?: string; tail_chars?: number }) =>
  onSandbox<{ running: boolean; exit_code: number | null; output: string }>(env, ctx, "logs", args);
export const listSandboxFiles = (env: Env, ctx: TenantContext, args: { sandbox: string; path: string }) => onSandbox(env, ctx, "list_files", args);
export const readSandboxFile = (env: Env, ctx: TenantContext, args: { sandbox: string; path: string }) => onSandbox(env, ctx, "read_file", args);
export const writeSandboxFile = (env: Env, ctx: TenantContext, args: { sandbox: string; path: string; content: string }) => onSandbox(env, ctx, "write_file", args);
export const sandboxPreviewUrl = (env: Env, ctx: TenantContext, args: { sandbox: string; port: number; signed?: boolean; expires_seconds?: number }) =>
  onSandbox(env, ctx, "preview_url", args);
