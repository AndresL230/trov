// Sandboxes (docs/architecture/sandboxes.md; 0089_sandboxes, 0090_sandbox_monitor): Daytona VMs an organization's
// agents create and drive over MCP, and its people watch on Monitor › Sandboxes. Trov does the deciding — who is
// calling, which org, whether that org has sandboxes, whether the sandbox is the org's, what its name is — and the
// trov-sandbox Worker (the `SANDBOX` Service Binding) does the running: it holds the Daytona key, so no MCP path here
// ever reads a secret (canopy-multitenancy.md D14), and it labels and checks every sandbox with the org it is told.
//
// Every operation on a sandbox writes ONE `sandbox_events` row: Trov's own record of what happened, which the
// Monitor screen tells as stories (shared/sandboxes-core.ts `sandboxStories`). A call from MCP is source `agent`;
// the same functions called from the web app's cookie routes are source `person`.
//
// The switch is the `sandboxes` limit (shared/plans.ts, `sandboxAccess`): the plan's number (Free none, Pro 3,
// Enterprise no limit), or 0 set by a superadmin in Platform, which turns sandboxes off for the org.
//
// A profile's boot needs a GitHub token to clone a private repository, and nothing reachable from src/mcp.ts may
// mint one (CLAUDE.md invariant 12). So a create from a profile leaves its row `pending` and notes it in
// src/sandboxes/pending.ts; src/index.ts then runs src/sandboxes/boot.ts in `waitUntil`, outside the MCP graph.
import type { Env } from "../env";
import { all, first, run, nowIso, type TenantContext } from "../data/sql";
import { requirePlan, sandboxAccess } from "../plans/gate";
import { notePendingBoot } from "../sandboxes/pending";
import {
  SANDBOX_NAME_HINT, SANDBOX_NAME_RE, SANDBOX_OUTPUT_KEEP, SANDBOX_SIZES,
  type SandboxBootState, type SandboxEventSource, type SandboxSize,
} from "@shared/sandboxes-core";

export class SandboxError extends Error {
  constructor(readonly code: "not_enabled" | "not_found" | "bad_request" | "conflict" | "unavailable" | "forbidden", message: string) {
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

export interface SandboxRow {
  sandbox_id: string;
  name: string | null;
  created_by: string;
  created_at: string;
  profile_key: string | null;
  boot_state: SandboxBootState;
  boot_detail: string | null;
}

const ROW_COLS = `sandbox_id, name, created_by, created_at, profile_key, boot_state, boot_detail`;

const NOT_ENABLED = "Sandboxes aren't turned on for this organization. Nothing was created or run.";
const NOT_INCLUDED = "This organization's plan doesn't include sandboxes (Pro has three at once). Nothing was created or run.";

/** Is the sandbox capability on for this org at all? (The binding is there, it is not a Sample workspace, the plan has them.) */
export async function sandboxesEnabled(env: Pick<Env, "SANDBOX">, ctx: TenantContext): Promise<boolean> {
  if (!env.SANDBOX) return false;
  const org = await first<{ sample: number }>(ctx, `SELECT sample FROM orgs WHERE id = ?`, ctx.orgId);
  if (!org || org.sample === 1) return false;
  return (await sandboxAccess(ctx)).status === "on";
}

async function gate(env: Env, ctx: TenantContext): Promise<Fetcher> {
  if (!env.SANDBOX) throw new SandboxError("not_enabled", NOT_ENABLED);
  const org = await first<{ sample: number }>(ctx, `SELECT sample FROM orgs WHERE id = ?`, ctx.orgId);
  if (!org || org.sample === 1) throw new SandboxError("not_enabled", NOT_ENABLED);
  const access = await sandboxAccess(ctx);
  if (access.status === "off") throw new SandboxError("not_enabled", NOT_ENABLED);
  if (access.status === "not_included") throw new SandboxError("not_enabled", NOT_INCLUDED);
  return env.SANDBOX;
}

/** One op on the runner, for this org and this person. */
export async function callRunner<T>(runner: Fetcher, ctx: TenantContext, op: string, args: Record<string, unknown> = {}): Promise<T> {
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

// ── rows ─────────────────────────────────────────────────────────────────────

/** The org's live sandbox `ref` names — by id or by name — or not_found, checked before the runner is asked anything. */
export async function ownedRow(ctx: TenantContext, ref: unknown): Promise<SandboxRow> {
  if (typeof ref !== "string" || !ref.trim()) throw new SandboxError("bad_request", "sandbox is required: a name or id from sandbox_list.");
  const r = ref.trim();
  const row = await first<SandboxRow>(ctx,
    `SELECT ${ROW_COLS} FROM org_sandboxes WHERE org_id = ? AND deleted_at IS NULL AND (sandbox_id = ? OR name = ?)
      ORDER BY sandbox_id = ? DESC LIMIT 1`, ctx.orgId, r, r, r);
  if (!row) throw new SandboxError("not_found", `No sandbox "${r}" in this organization. sandbox_list shows the ones it has.`);
  return row;
}

const liveRows = (ctx: TenantContext) =>
  all<SandboxRow>(ctx, `SELECT ${ROW_COLS} FROM org_sandboxes WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at`, ctx.orgId);

async function nameTaken(ctx: TenantContext, name: string): Promise<boolean> {
  return !!(await first(ctx, `SELECT 1 AS x FROM org_sandboxes WHERE org_id = ? AND deleted_at IS NULL AND name = ?`, ctx.orgId, name));
}

const hex4 = () => Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0")).join("");

async function pickName(ctx: TenantContext, asked: string | undefined, base: string): Promise<string> {
  if (asked !== undefined) {
    const n = asked.trim();
    if (!SANDBOX_NAME_RE.test(n)) throw new SandboxError("bad_request", `name: ${SANDBOX_NAME_HINT}.`);
    if (await nameTaken(ctx, n)) throw new SandboxError("conflict", `This organization already has a sandbox named "${n}". Pick another name, or use that one.`);
    return n;
  }
  for (let i = 0; i < 6; i++) {
    const n = `${base.slice(0, 34)}-${hex4()}`;
    if (!(await nameTaken(ctx, n))) return n;
  }
  return `${base.slice(0, 30)}-${hex4()}${hex4()}`;
}

/** Fill a row's name the first time it is seen without one (a row from before 0090, or one reconcile added). */
async function ensureName(ctx: TenantContext, row: SandboxRow): Promise<string> {
  if (row.name) return row.name;
  const name = await pickName(ctx, undefined, row.profile_key ?? "sandbox");
  await run(ctx, `UPDATE org_sandboxes SET name = ? WHERE org_id = ? AND sandbox_id = ? AND name IS NULL`, name, ctx.orgId, row.sandbox_id);
  row.name = name;
  return name;
}

/**
 * Line the org's rows up with what Daytona has: a live row Daytona no longer lists was auto-deleted there
 * (`deleted_by` NULL); a sandbox carrying this org's label with no row (a create whose row write failed) gets one.
 */
async function reconcile(ctx: TenantContext, seen: SandboxView[]): Promise<SandboxRow[]> {
  const live = await liveRows(ctx);
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
  return liveRows(ctx);
}

async function markGone(ctx: TenantContext, id: string, by: string | null): Promise<void> {
  await run(ctx, `UPDATE org_sandboxes SET deleted_at = ?, deleted_by = ? WHERE org_id = ? AND sandbox_id = ? AND deleted_at IS NULL`,
    nowIso(), by, ctx.orgId, id);
}

// ── the record ───────────────────────────────────────────────────────────────

export interface EventInput {
  tool: string;
  subject?: string;
  result?: string;
  exit_code?: number | null;
  ms?: number | null;
  failed?: boolean;
  output?: string | null;
  source?: SandboxEventSource;
  at?: string;
}

const TOKENISH: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"], [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\b(?:trov|canopy)_(?:mcp|oat)_[A-Za-z0-9_-]{10,}/g, "[redacted]"], [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/(x-access-token:)[^@\s]+@/g, "$1[redacted]@"], [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
];

/** Take known values and anything shaped like a token out of `text`, THEN cut it (the scrub-before-cut rule). */
export function scrubOutput(text: string, values: readonly string[] = [], keep = SANDBOX_OUTPUT_KEEP): string {
  let s = text;
  for (const v of [...values].filter((x) => x && x.length >= 6).sort((a, b) => b.length - a.length)) s = s.split(v).join("[redacted]");
  for (const [re, to] of TOKENISH) s = s.replace(re, to);
  return s.length > keep ? `…${s.slice(-keep)}` : s;
}

const sourceOf = (ctx: TenantContext): SandboxEventSource => (ctx.via === "bearer" ? "agent" : ctx.via === "system" ? "boot" : "person");

export async function recordEvent(ctx: TenantContext, sandboxId: string, e: EventInput): Promise<void> {
  await run(ctx,
    `INSERT INTO sandbox_events (org_id, sandbox_id, at, actor, source, tool, subject, result, exit_code, ms, failed, output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, sandboxId, e.at ?? nowIso(), ctx.userId, e.source ?? sourceOf(ctx), e.tool, (e.subject ?? "").slice(0, 500),
    (e.result ?? "").slice(0, 200), e.exit_code ?? null, e.ms ?? null, e.failed ? 1 : 0, e.output ?? null,
  ).catch((err) => console.error("sandbox event", err instanceof Error ? err.message : String(err)));
}

// ── rules and profiles (read here; written by the cookie routes) ────────────

export async function sandboxRules(ctx: TenantContext): Promise<{ members_act: boolean; public_previews: boolean }> {
  const r = await first<{ a: number; p: number }>(ctx, `SELECT sandbox_members_act AS a, sandbox_public AS p FROM orgs WHERE id = ?`, ctx.orgId);
  return { members_act: (r?.a ?? 1) === 1, public_previews: (r?.p ?? 0) === 1 };
}

export interface ProfileRow {
  key: string; name: string; description: string; repo: string | null; branch: string; size: SandboxSize; image: string | null;
  setup: string; start_cmd: string | null; port: number | null; env: string; auto_stop: number; delete_days: number;
}

export const PROFILE_COLS = `key, name, description, repo, branch, size, image, setup, start_cmd, port, env, auto_stop, delete_days`;

export const profileRow = (ctx: TenantContext, key: string) =>
  first<ProfileRow>(ctx, `SELECT ${PROFILE_COLS} FROM sandbox_profiles WHERE org_id = ? AND key = ? AND deleted_at IS NULL`, ctx.orgId, key);

const parseJson = <T>(s: string | null, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

/** The steps a profile's boot runs, by label — what `boot_detail.steps` holds and the boot events are named after. */
export function bootSteps(p: Pick<ProfileRow, "repo" | "branch" | "setup" | "start_cmd" | "port">): string[] {
  const steps: string[] = [];
  if (p.repo) steps.push(`clone ${p.repo}@${p.branch}`);
  steps.push(...parseJson<string[]>(p.setup, []));
  if (p.start_cmd && p.port) steps.push(`${p.start_cmd} (waits for port ${p.port})`);
  return steps;
}

// ── the operations, one per MCP tool ───────────────────────────────────────

/** The fields Trov adds to the runner's view: its name, profile and boot. */
function withRow(v: SandboxView, row: SandboxRow | undefined) {
  return { ...v, id: v.id, name: row?.name ?? v.id, profile: row?.profile_key ?? null, boot: row?.boot_state ?? "none", created_by: row?.created_by ?? v.created_by };
}

export async function listSandboxes(env: Env, ctx: TenantContext) {
  const runner = await gate(env, ctx);
  const { sandboxes } = await callRunner<{ sandboxes: SandboxView[] }>(runner, ctx, "list");
  const rows = await reconcile(ctx, sandboxes);
  for (const r of rows) await ensureName(ctx, r);
  await pollBoots(runner, ctx, rows);
  const byId = new Map(rows.map((r) => [r.sandbox_id, r]));
  const access = await sandboxAccess(ctx);
  return { sandboxes: sandboxes.map((s) => withRow(s, byId.get(s.id))), limit: access.cap };
}

export interface CreateArgs {
  name?: string;
  profile?: string;
  branch?: string;
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
  const rules = await sandboxRules(ctx);
  if (args.public === true && !rules.public_previews) {
    throw new SandboxError("forbidden", "This organization doesn't allow public previews. Create it private and share a signed link from sandbox_preview_url.");
  }
  let profile: ProfileRow | null = null;
  if (args.profile !== undefined) {
    profile = await profileRow(ctx, args.profile.trim());
    if (!profile) {
      const keys = (await all<{ key: string }>(ctx, `SELECT key FROM sandbox_profiles WHERE org_id = ? AND deleted_at IS NULL ORDER BY key`, ctx.orgId)).map((r) => r.key);
      throw new SandboxError("not_found", `No profile "${args.profile}". ${keys.length ? `This organization has: ${keys.join(", ")}.` : "This organization has none yet (Org settings › Sandboxes)."}`);
    }
  }
  if (args.branch !== undefined && !profile) throw new SandboxError("bad_request", "branch: only with a profile, whose repository it picks the branch of.");
  if (args.branch !== undefined && !/^[A-Za-z0-9._/-]{1,200}$/.test(args.branch)) throw new SandboxError("bad_request", "branch: a branch name.");
  const name = await pickName(ctx, args.name, profile?.key ?? "sandbox");
  // Count what Daytona really has first, so a sandbox it auto-deleted gives its slot back.
  const { sandboxes } = await callRunner<{ sandboxes: SandboxView[] }>(runner, ctx, "list");
  await reconcile(ctx, sandboxes);
  await requirePlan(ctx, "sandboxes", 1);

  const size = profile ? SANDBOX_SIZES[profile.size] : null;
  const profileEnv = profile ? parseJson<Record<string, string>>(profile.env, {}) : {};
  const started = Date.now();
  const sb = await callRunner<SandboxView>(runner, ctx, "create", {
    snapshot: args.snapshot ?? profile?.image ?? undefined,
    env: { ...profileEnv, ...(args.env ?? {}) },
    public: args.public ?? false,
    cpu: args.cpu ?? size?.cpu, memory_gib: args.memory_gib ?? size?.memory_gib, disk_gib: args.disk_gib ?? size?.disk_gib,
    auto_stop_minutes: args.auto_stop_minutes ?? profile?.auto_stop,
    auto_delete_minutes: profile ? profile.delete_days * 1440 : undefined,
    labels: profile ? { trov_profile: profile.key } : undefined,
  });
  const branch = args.branch ?? profile?.branch ?? null;
  const steps = profile ? bootSteps({ ...profile, branch: branch ?? profile.branch }) : [];
  const boot: SandboxBootState = steps.length ? "pending" : "none";
  await run(ctx,
    `INSERT OR IGNORE INTO org_sandboxes (org_id, sandbox_id, created_by, created_at, name, profile_key, boot_state, boot_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, sb.id, ctx.userId, nowIso(), name, profile?.key ?? null, boot, steps.length ? JSON.stringify({ steps, branch }) : null);
  await recordEvent(ctx, sb.id, { tool: "sandbox_create", subject: profile ? `from ${profile.key}` : (args.snapshot ?? ""), result: sb.state ?? "", ms: Date.now() - started });
  if (boot === "pending") notePendingBoot(ctx.orgId, sb.id);
  const view = withRow(sb, { sandbox_id: sb.id, name, created_by: ctx.userId, created_at: "", profile_key: profile?.key ?? null, boot_state: boot, boot_detail: null });
  const notes: string[] = [];
  if (sb.state !== "started") notes.push(`It is ${sb.state}; call sandbox_get until it reads started.`);
  if (boot === "pending") notes.push(`Booting from ${profile!.key}: ${steps.length} step${steps.length === 1 ? "" : "s"} (${steps.join(" → ")}). sandbox_get shows how far it is; run nothing that needs them until boot reads ready.`);
  return notes.length ? { ...view, note: notes.join(" ") } : view;
}

/** An op on ONE of the org's sandboxes: gate, ownership here, then the runner (which checks the org label again). */
async function onSandbox<T>(env: Env, ctx: TenantContext, op: string, args: Record<string, unknown>, ev: (r: T | null, err: SandboxError | null, row: SandboxRow) => EventInput | null): Promise<{ result: T; row: SandboxRow }> {
  const runner = await gate(env, ctx);
  const row = await ownedRow(ctx, args.sandbox);
  const started = Date.now();
  try {
    const result = await callRunner<T>(runner, ctx, op, { ...args, sandbox: row.sandbox_id });
    const e = ev(result, null, row);
    if (e) await recordEvent(ctx, row.sandbox_id, { ms: Date.now() - started, ...e });
    return { result, row };
  } catch (err) {
    // Gone on Daytona's side (auto-deleted): the row says so from now on.
    if (err instanceof SandboxError && err.code === "not_found" && /No sandbox/.test(err.message)) await markGone(ctx, row.sandbox_id, null);
    else if (err instanceof SandboxError) {
      const e = ev(null, err, row);
      if (e) await recordEvent(ctx, row.sandbox_id, { ms: Date.now() - started, ...e, failed: true, output: scrubOutput(err.message) });
    }
    throw err;
  }
}

const lifecycle = (tool: string) => (r: SandboxView | null) => ({ tool, result: r?.state ?? "" });

export async function getSandbox(env: Env, ctx: TenantContext, args: { sandbox: string }) {
  const runner = await gate(env, ctx);
  const row = await ownedRow(ctx, args.sandbox);
  await ensureName(ctx, row);
  await pollBoots(runner, ctx, [row]);
  const fresh = (await first<SandboxRow>(ctx, `SELECT ${ROW_COLS} FROM org_sandboxes WHERE org_id = ? AND sandbox_id = ?`, ctx.orgId, row.sandbox_id)) ?? row;
  const { result } = await onSandbox<SandboxView>(env, ctx, "get", args, () => null);
  const detail = parseJson<{ steps?: string[]; branch?: string | null; done?: number; failed_step?: string }>(fresh.boot_detail, {});
  return {
    ...withRow(result, fresh),
    ...(detail.steps ? { boot_steps: detail.steps, boot_done: detail.done ?? 0, ...(detail.failed_step ? { boot_failed_step: detail.failed_step } : {}) } : {}),
  };
}

export async function startSandbox(env: Env, ctx: TenantContext, args: { sandbox: string }) {
  const { result, row } = await onSandbox<SandboxView>(env, ctx, "start", args, lifecycle("sandbox_start"));
  return withRow(result, row);
}

export async function stopSandbox(env: Env, ctx: TenantContext, args: { sandbox: string }) {
  const { result, row } = await onSandbox<SandboxView>(env, ctx, "stop", args, lifecycle("sandbox_stop"));
  return withRow(result, row);
}

export async function deleteSandbox(env: Env, ctx: TenantContext, args: { sandbox: string }) {
  const { result, row } = await onSandbox<{ deleted: string }>(env, ctx, "delete", args, () => ({ tool: "sandbox_delete", result: "deleted" }));
  await markGone(ctx, result.deleted, ctx.userId);
  return { deleted: result.deleted, name: row.name ?? result.deleted };
}

export async function configureSandbox(env: Env, ctx: TenantContext, args: { sandbox: string; auto_stop_minutes?: number; public?: boolean }) {
  if (args.public === true && !(await sandboxRules(ctx)).public_previews) {
    throw new SandboxError("forbidden", "This organization doesn't allow public previews. Share a signed link from sandbox_preview_url instead.");
  }
  const subject = [args.auto_stop_minutes !== undefined ? `auto-stop ${args.auto_stop_minutes} min` : "", args.public !== undefined ? (args.public ? "previews public" : "previews private") : ""].filter(Boolean).join(", ");
  const { result, row } = await onSandbox<SandboxView>(env, ctx, "configure", args, () => ({ tool: "sandbox_configure", subject }));
  return withRow(result, row);
}

export async function execInSandbox(env: Env, ctx: TenantContext, args: { sandbox: string; command: string; cwd?: string; env?: Record<string, string>; timeout_seconds?: number }) {
  const { result } = await onSandbox<{ exit_code: number | null; output: string }>(env, ctx, "exec", args, (r, err) => {
    const failed = !!err || (r?.exit_code ?? 0) !== 0;
    return {
      tool: "sandbox_exec", subject: scrubOutput(args.command, Object.values(args.env ?? {}), 500),
      exit_code: r?.exit_code ?? null, failed,
      output: failed && r ? scrubOutput(r.output, Object.values(args.env ?? {})) : null,
    };
  });
  return result;
}

export async function runBackground(env: Env, ctx: TenantContext, args: { sandbox: string; command: string; session?: string }) {
  const { result } = await onSandbox<{ session: string; command_id: string }>(env, ctx, "run_background", args,
    (r) => ({ tool: "sandbox_run_background", subject: scrubOutput(args.command, [], 500), result: r?.command_id ?? "" }));
  return result;
}

export async function sandboxLogs(env: Env, ctx: TenantContext, args: { sandbox: string; command_id: string; session?: string; tail_chars?: number }) {
  const { result } = await onSandbox<{ running: boolean; exit_code: number | null; output: string }>(env, ctx, "logs", args, (r) => {
    const failed = !!r && !r.running && (r.exit_code ?? 0) !== 0;
    return { tool: "sandbox_logs", subject: args.command_id, result: r ? (r.running ? "running" : `exited ${r.exit_code ?? "?"}`) : "", exit_code: r?.exit_code ?? null, failed, output: failed && r ? scrubOutput(r.output) : null };
  });
  return result;
}

export async function listSandboxFiles(env: Env, ctx: TenantContext, args: { sandbox: string; path: string }) {
  return (await onSandbox<unknown>(env, ctx, "list_files", args, () => ({ tool: "sandbox_list_files", subject: args.path }))).result;
}
export async function readSandboxFile(env: Env, ctx: TenantContext, args: { sandbox: string; path: string }) {
  return (await onSandbox<unknown>(env, ctx, "read_file", args, () => ({ tool: "sandbox_read_file", subject: args.path }))).result;
}
export async function writeSandboxFile(env: Env, ctx: TenantContext, args: { sandbox: string; path: string; content: string }) {
  return (await onSandbox<unknown>(env, ctx, "write_file", args, () => ({ tool: "sandbox_write_file", subject: args.path, result: `${new TextEncoder().encode(args.content).length} bytes` }))).result;
}
export async function sandboxPreviewUrl(env: Env, ctx: TenantContext, args: { sandbox: string; port: number; signed?: boolean; expires_seconds?: number }) {
  return (await onSandbox<unknown>(env, ctx, "preview_url", args, () => ({ tool: "sandbox_preview_url", subject: `port ${args.port}` }))).result;
}

export async function listSandboxProfiles(env: Env, ctx: TenantContext) {
  await gate(env, ctx);
  const rows = await all<ProfileRow>(ctx, `SELECT ${PROFILE_COLS} FROM sandbox_profiles WHERE org_id = ? AND deleted_at IS NULL ORDER BY key`, ctx.orgId);
  return {
    profiles: rows.map((p) => ({
      key: p.key, name: p.name, description: p.description, repo: p.repo, branch: p.branch, size: p.size,
      boot: bootSteps(p), start_command: p.start_cmd, port: p.port,
      env: Object.keys(parseJson<Record<string, string>>(p.env, {})), auto_stop_minutes: p.auto_stop, delete_after_days: p.delete_days,
    })),
  };
}

// ── boots: reading how one went ─────────────────────────────────────────────

interface BootStatus { state: string | null; steps: { i: number; exit: number; ms: number }[]; done: "ready" | "failed" | null; output?: string | null }

/**
 * For each `booting` row: ask the runner how far the boot is, write a `boot` event for each step not yet recorded,
 * and settle the row `ready` / `failed` when the script has finished. Idempotent: steps are numbered, and a step
 * already recorded is not written again. A runner that cannot answer leaves the row as it is.
 */
export async function pollBoots(runner: Fetcher, ctx: TenantContext, rows: readonly SandboxRow[]): Promise<void> {
  for (const row of rows) {
    if (row.boot_state !== "booting") continue;
    let st: BootStatus;
    try { st = await callRunner<BootStatus>(runner, ctx, "boot_status", { sandbox: row.sandbox_id }); } catch { continue; }
    await settleBoot(ctx, row, st);
  }
}

export async function settleBoot(ctx: TenantContext, row: SandboxRow, st: BootStatus): Promise<SandboxBootState> {
  const detail = parseJson<{ steps?: string[]; branch?: string | null; done?: number; failed_step?: string }>(row.boot_detail, {});
  const labels = detail.steps ?? [];
  const recorded = (await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM sandbox_events WHERE org_id = ? AND sandbox_id = ? AND source = 'boot'`, ctx.orgId, row.sandbox_id))?.n ?? 0;
  for (const s of st.steps.filter((x) => x.i >= recorded).sort((a, b) => a.i - b.i)) {
    const failed = s.exit !== 0;
    await run(ctx,
      `INSERT INTO sandbox_events (org_id, sandbox_id, at, actor, source, tool, subject, result, exit_code, ms, failed, output)
       VALUES (?, ?, ?, ?, 'boot', 'boot_step', ?, ?, ?, ?, ?, ?)`,
      ctx.orgId, row.sandbox_id, nowIso(), row.created_by, (labels[s.i] ?? `step ${s.i + 1}`).slice(0, 500), `step ${s.i + 1} of ${labels.length}`,
      s.exit, s.ms, failed ? 1 : 0, failed && st.output ? scrubOutput(st.output) : null);
  }
  const next: SandboxBootState = st.done === "ready" ? "ready" : st.done === "failed" ? "failed" : "booting";
  const failedStep = st.steps.find((x) => x.exit !== 0);
  const nextDetail = { ...detail, done: st.steps.filter((x) => x.exit === 0).length, ...(failedStep ? { failed_step: labels[failedStep.i] ?? `step ${failedStep.i + 1}` } : {}) };
  await run(ctx, `UPDATE org_sandboxes SET boot_state = ?, boot_detail = ? WHERE org_id = ? AND sandbox_id = ?`, next, JSON.stringify(nextDetail), ctx.orgId, row.sandbox_id);
  row.boot_state = next;
  row.boot_detail = JSON.stringify(nextDetail);
  return next;
}

export async function liveSandboxRows(ctx: TenantContext): Promise<SandboxRow[]> { return liveRows(ctx); }
export { reconcile as reconcileSandboxes, markGone as markSandboxGone, gate as sandboxGate };
