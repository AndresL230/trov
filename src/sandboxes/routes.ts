// Monitor › Sandboxes and Org settings › Sandboxes (0090_sandbox_monitor, docs/architecture/sandboxes.md): tenant
// routes under `/api/o/:slug`, COOKIE ONLY (`cookieOnly`). `tenantGate` has resolved `c.var.ctx`.
//
//   GET    /sandboxes                    any member — the screen: access, rules, every live sandbox and the ones gone
//                                        this week, each with its stories, from D1 ONLY (invariant 7: no runner call
//                                        on a render path) → `SandboxesPage`
//   POST   /sandboxes/refresh            any member — the explicit Refresh: asks the runner what each sandbox is
//                                        doing now, reconciles, reads boots, starts pending ones → `SandboxRefreshAnswer`
//                                        (503 `{ degraded: true, error }` when the runner cannot answer)
//   POST   /sandboxes/:id/start|stop     who may act (`sandbox_members_act`: anyone, else admins) — recorded `person`
//   DELETE /sandboxes/:id                the same rule — the VM goes; Trov's record of it stays
//   POST   /sandboxes/:id/preview        any member — a signed preview link for `{ port }`, an hour
//   GET    /sandbox-settings             any member — rules, every profile with its recent boots → `SandboxSettingsPage`
//   PUT    /sandbox-settings/rules       admin — `{ members_act?, public_previews? }`, audited `sandbox.rules`
//   PUT    /sandbox-profiles/:key        admin — create or replace a profile (shared `checkSandboxProfile`), audited
//   DELETE /sandbox-profiles/:key        admin — soft: the key stays reserved, audited
import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth/principal";
import { hasRole, type TenantContext } from "../data/context";
import { all, batch, first, nowIso, run, stmt } from "../data/sql";
import { cookieOnly } from "../orgs/routes";
import { sandboxAccess } from "../plans/gate";
import { PlanLimitError, PLAN_LIMIT_STATUS } from "../plans/state";
import {
  SANDBOXES_ROUTE, SANDBOXES_REFRESH_ROUTE, SANDBOX_SETTINGS_ROUTE, SANDBOX_RULES_ROUTE, SANDBOX_PROFILES_ROUTE,
  activityBuckets, checkSandboxProfile, sandboxStories,
  type SandboxBootState, type SandboxEventView, type SandboxLive, type SandboxProfileView, type SandboxRowView, type SandboxesPage,
  type SandboxRefreshAnswer, type SandboxSettingsPage,
} from "@shared/sandboxes-core";
import {
  PROFILE_COLS, SandboxError, callRunner, deleteSandbox, liveSandboxRows, pollBoots, reconcileSandboxes, sandboxGate, sandboxPreviewUrl,
  sandboxRules, startSandbox, stopSandbox, type ProfileRow, type SandboxView,
} from "../tools/sandboxes";
import { drainBoots } from "./boot";

export const sandboxesApp = new Hono<AppEnv>();
for (const r of [`${SANDBOXES_ROUTE}`, `${SANDBOXES_ROUTE}/*`, SANDBOX_SETTINGS_ROUTE, `${SANDBOX_SETTINGS_ROUTE}/*`, `${SANDBOX_PROFILES_ROUTE}/*`]) sandboxesApp.use(r, cookieOnly);

const STORY_EVENTS = 120;
const HISTORY_DAYS = 7;

function fail(c: Context<AppEnv>, err: unknown) {
  if (err instanceof PlanLimitError) return c.json({ error: err.code, message: err.message }, PLAN_LIMIT_STATUS);
  if (err instanceof SandboxError) {
    const status = err.code === "not_found" ? 404 : err.code === "bad_request" ? 400 : err.code === "conflict" ? 409
      : err.code === "forbidden" || err.code === "not_enabled" ? 403 : 503;
    return c.json({ error: err.code, message: err.message }, status);
  }
  throw err;
}

interface PageRow {
  sandbox_id: string; name: string | null; profile_key: string | null; created_by: string; created_at: string;
  deleted_at: string | null; deleted_by: string | null; boot_state: SandboxBootState;
}
interface EventRow extends Omit<SandboxEventView, "failed"> { sandbox_id: string; failed: number }

const eventView = (e: EventRow): SandboxEventView => ({
  id: e.id, at: e.at, actor: e.actor, source: e.source, tool: e.tool, subject: e.subject, result: e.result,
  exit_code: e.exit_code, ms: e.ms, failed: e.failed === 1, output: e.output,
});

async function canAct(ctx: TenantContext): Promise<boolean> {
  return hasRole(ctx, "admin") || (await sandboxRules(ctx)).members_act;
}

export async function sandboxesPage(env: AppEnv["Bindings"], ctx: TenantContext, now = Date.now()): Promise<SandboxesPage> {
  const since = new Date(now - HISTORY_DAYS * 86_400_000).toISOString();
  const [access, rules, rows, profiles] = await Promise.all([
    sandboxAccess(ctx),
    sandboxRules(ctx),
    all<PageRow>(ctx,
      `SELECT sandbox_id, name, profile_key, created_by, created_at, deleted_at, deleted_by, boot_state FROM org_sandboxes
        WHERE org_id = ? AND (deleted_at IS NULL OR deleted_at >= ?) ORDER BY created_at DESC LIMIT 60`, ctx.orgId, since),
    all<{ key: string; name: string; repo: string | null }>(ctx,
      `SELECT key, name, repo FROM sandbox_profiles WHERE org_id = ? AND deleted_at IS NULL ORDER BY name`, ctx.orgId),
  ]);
  const ids = rows.map((r) => r.sandbox_id);
  const events = new Map<string, EventRow[]>();
  const counts = new Map<string, number>();
  if (ids.length) {
    const marks = ids.map(() => "?").join(", ");
    const [evs, cnt] = await Promise.all([
      // The latest events of each sandbox (a window function keeps it to STORY_EVENTS apiece).
      all<EventRow>(ctx,
        `SELECT id, sandbox_id, at, actor, source, tool, subject, result, exit_code, ms, failed, output FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY sandbox_id ORDER BY id DESC) AS rn FROM sandbox_events
            WHERE org_id = ? AND sandbox_id IN (${marks})) WHERE rn <= ${STORY_EVENTS} ORDER BY id`, ctx.orgId, ...ids),
      all<{ sandbox_id: string; n: number }>(ctx,
        `SELECT sandbox_id, COUNT(*) AS n FROM sandbox_events WHERE org_id = ? AND sandbox_id IN (${marks}) GROUP BY sandbox_id`, ctx.orgId, ...ids),
    ]);
    for (const e of evs) (events.get(e.sandbox_id) ?? events.set(e.sandbox_id, []).get(e.sandbox_id)!).push(e);
    for (const r of cnt) counts.set(r.sandbox_id, r.n);
  }
  const view = (r: PageRow): SandboxRowView => {
    const evs = (events.get(r.sandbox_id) ?? []).map(eventView);
    return {
      id: r.sandbox_id, name: r.name ?? r.sandbox_id, profile: r.profile_key, created_by: r.created_by, created_at: r.created_at,
      deleted_at: r.deleted_at, deleted_by: r.deleted_by, boot_state: r.boot_state,
      last_event_at: evs.length ? evs[evs.length - 1].at : null,
      activity: activityBuckets(evs.map((e) => e.at), now),
      stories: sandboxStories(evs, r.profile_key),
      event_count: counts.get(r.sandbox_id) ?? 0,
    };
  };
  const live = rows.filter((r) => r.deleted_at === null).map(view);
  const isAdmin = hasRole(ctx, "admin");
  return {
    access, used: live.length, rules, can_act: isAdmin || rules.members_act, is_admin: isAdmin,
    sandboxes: live, history: rows.filter((r) => r.deleted_at !== null).map(view), profiles, runner: !!env.SANDBOX,
  };
}

sandboxesApp.get(SANDBOXES_ROUTE, async (c) => {
  try {
    return c.json(await sandboxesPage(c.env, c.var.ctx));
  } catch (e) {
    console.error("sandboxes page", e instanceof Error ? e.message : String(e));
    return c.json({ degraded: true, error: "Sandboxes couldn't be read right now." }, 503);
  }
});

interface InspectView extends SandboxView {
  cpu?: number; memory_gib?: number; disk_gib?: number; error?: string; disk_used_gib: number | null; ports: number[]; processes: string[];
}

sandboxesApp.post(SANDBOXES_REFRESH_ROUTE, async (c) => {
  const ctx = c.var.ctx;
  const at = nowIso();
  try {
    const runner = await sandboxGate(c.env, ctx);
    const { sandboxes } = await callRunner<{ sandboxes: InspectView[] }>(runner, ctx, "inspect");
    const rows = await reconcileSandboxes(ctx, sandboxes);
    await pollBoots(runner, ctx, rows);
    await drainBoots(c.env, { orgId: ctx.orgId });
    const live: Record<string, SandboxLive> = {};
    for (const s of sandboxes) {
      live[s.id] = {
        at, state: s.state, public: s.public, cpu: s.cpu ?? null, memory_gib: s.memory_gib ?? null, disk_gib: s.disk_gib ?? null,
        disk_used_gib: s.disk_used_gib, ports: s.ports, processes: s.processes, error: s.error ?? null,
      };
    }
    return c.json({ at, live } satisfies SandboxRefreshAnswer);
  } catch (e) {
    const message = e instanceof SandboxError ? e.message : "The sandbox service couldn't be reached.";
    if (!(e instanceof SandboxError)) console.error("sandboxes refresh", e instanceof Error ? e.message : String(e));
    return c.json({ at, live: {}, degraded: true, error: message } satisfies SandboxRefreshAnswer, 503);
  }
});

for (const [verb, fn] of [["start", startSandbox], ["stop", stopSandbox]] as const) {
  sandboxesApp.post(`${SANDBOXES_ROUTE}/:id/${verb}`, async (c) => {
    if (!(await canAct(c.var.ctx))) return c.json({ error: "forbidden", message: "Only admins may start or stop sandboxes in this organization." }, 403);
    try { return c.json(await fn(c.env, c.var.ctx, { sandbox: c.req.param("id") })); } catch (e) { return fail(c, e); }
  });
}

sandboxesApp.delete(`${SANDBOXES_ROUTE}/:id`, async (c) => {
  if (!(await canAct(c.var.ctx))) return c.json({ error: "forbidden", message: "Only admins may delete sandboxes in this organization." }, 403);
  try { return c.json(await deleteSandbox(c.env, c.var.ctx, { sandbox: c.req.param("id") })); } catch (e) { return fail(c, e); }
});

sandboxesApp.post(`${SANDBOXES_ROUTE}/:id/preview`, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { port?: unknown } | null;
  const port = Number(body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return c.json({ error: "bad_request", message: "Send { port: 1-65535 }." }, 400);
  try { return c.json(await sandboxPreviewUrl(c.env, c.var.ctx, { sandbox: c.req.param("id"), port, signed: true, expires_seconds: 3600 })); } catch (e) { return fail(c, e); }
});

// ── Org settings › Sandboxes ─────────────────────────────────────────────────

const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };

export async function sandboxSettingsPage(ctx: TenantContext): Promise<SandboxSettingsPage> {
  const [access, rules, rows, boots, repos] = await Promise.all([
    sandboxAccess(ctx),
    sandboxRules(ctx),
    all<ProfileRow & { created_by: string; created_at: string; updated_by: string; updated_at: string }>(ctx,
      `SELECT ${PROFILE_COLS}, created_by, created_at, updated_by, updated_at FROM sandbox_profiles WHERE org_id = ? AND deleted_at IS NULL ORDER BY name`, ctx.orgId),
    all<{ profile_key: string; sandbox_id: string; name: string | null; created_at: string; created_by: string; boot_state: SandboxBootState }>(ctx,
      `SELECT profile_key, sandbox_id, name, created_at, created_by, boot_state FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY profile_key ORDER BY created_at DESC) AS rn FROM org_sandboxes
          WHERE org_id = ? AND profile_key IS NOT NULL) WHERE rn <= 5 ORDER BY created_at DESC`, ctx.orgId),
    all<{ repo_full_name: string }>(ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, repo_full_name`, ctx.orgId),
  ]);
  const profiles: SandboxProfileView[] = rows.map((p) => ({
    key: p.key, name: p.name, description: p.description, repo: p.repo, branch: p.branch, size: p.size, image: p.image,
    setup: parse<string[]>(p.setup, []), start_cmd: p.start_cmd, port: p.port, env: parse<Record<string, string>>(p.env, {}),
    auto_stop: p.auto_stop, delete_days: p.delete_days, created_by: p.created_by, created_at: p.created_at, updated_by: p.updated_by, updated_at: p.updated_at,
    boots: boots.filter((b) => b.profile_key === p.key).map((b) => ({ id: b.sandbox_id, name: b.name ?? b.sandbox_id, at: b.created_at, by: b.created_by, boot_state: b.boot_state })),
  }));
  return { access, rules, profiles, repos: repos.map((r) => r.repo_full_name) };
}

sandboxesApp.get(SANDBOX_SETTINGS_ROUTE, async (c) => {
  try { return c.json(await sandboxSettingsPage(c.var.ctx)); } catch (e) {
    console.error("sandbox settings", e instanceof Error ? e.message : String(e));
    return c.json({ degraded: true, error: "Sandbox settings couldn't be read right now." }, 503);
  }
});

sandboxesApp.put(SANDBOX_RULES_ROUTE, async (c) => {
  const ctx = c.var.ctx;
  if (!hasRole(ctx, "admin")) return c.json({ error: "forbidden", message: "Only admins change the organization's sandbox rules." }, 403);
  const body = (await c.req.json().catch(() => null)) as { members_act?: unknown; public_previews?: unknown } | null;
  const a = body?.members_act, p = body?.public_previews;
  if ((a !== undefined && typeof a !== "boolean") || (p !== undefined && typeof p !== "boolean") || (a === undefined && p === undefined)) {
    return c.json({ error: "bad_request", message: "Send { members_act?: boolean, public_previews?: boolean }." }, 400);
  }
  const now = nowIso();
  const stmts = [];
  if (a !== undefined) stmts.push(stmt(ctx, `UPDATE orgs SET sandbox_members_act = ? WHERE id = ?`, a ? 1 : 0, ctx.orgId));
  if (p !== undefined) stmts.push(stmt(ctx, `UPDATE orgs SET sandbox_public = ? WHERE id = ?`, p ? 1 : 0, ctx.orgId));
  stmts.push(stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'sandbox.rules', 'sandboxes', ?, ?)`,
    ctx.orgId, ctx.userId, JSON.stringify({ ...(a !== undefined ? { members_act: a } : {}), ...(p !== undefined ? { public_previews: p } : {}) }), now));
  await batch(ctx, stmts);
  return c.json(await sandboxRules(ctx));
});

sandboxesApp.put(`${SANDBOX_PROFILES_ROUTE}/:key`, async (c) => {
  const ctx = c.var.ctx;
  if (!hasRole(ctx, "admin")) return c.json({ error: "forbidden", message: "Only admins edit sandbox profiles." }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const check = checkSandboxProfile({ ...(body ?? {}), key: c.req.param("key") });
  if (!check.ok) return c.json({ error: "bad_request", message: check.error }, 400);
  const p = check.profile;
  const existing = await first<{ deleted_at: string | null }>(ctx, `SELECT deleted_at FROM sandbox_profiles WHERE org_id = ? AND key = ?`, ctx.orgId, p.key);
  if (existing?.deleted_at) return c.json({ error: "conflict", message: `"${p.key}" belonged to a deleted profile and stays reserved. Pick another key.` }, 409);
  const now = nowIso();
  const vals = [p.name, p.description, p.repo, p.branch, p.size, p.image, JSON.stringify(p.setup), p.start_cmd, p.port, JSON.stringify(p.env), p.auto_stop, p.delete_days];
  await batch(ctx, [
    existing
      ? stmt(ctx, `UPDATE sandbox_profiles SET name = ?, description = ?, repo = ?, branch = ?, size = ?, image = ?, setup = ?, start_cmd = ?, port = ?, env = ?,
                     auto_stop = ?, delete_days = ?, updated_by = ?, updated_at = ? WHERE org_id = ? AND key = ?`, ...vals, ctx.userId, now, ctx.orgId, p.key)
      : stmt(ctx, `INSERT INTO sandbox_profiles (org_id, key, name, description, repo, branch, size, image, setup, start_cmd, port, env, auto_stop, delete_days,
                     created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.orgId, p.key, ...vals, ctx.userId, now, ctx.userId, now),
    stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'sandbox.profile_set', ?, ?, ?)`,
      ctx.orgId, ctx.userId, p.key, JSON.stringify({ created: !existing }), now),
  ]);
  return c.json((await sandboxSettingsPage(ctx)).profiles.find((x) => x.key === p.key) ?? null, existing ? 200 : 201);
});

sandboxesApp.delete(`${SANDBOX_PROFILES_ROUTE}/:key`, async (c) => {
  const ctx = c.var.ctx;
  if (!hasRole(ctx, "admin")) return c.json({ error: "forbidden", message: "Only admins delete sandbox profiles." }, 403);
  const key = c.req.param("key");
  const now = nowIso();
  const res = await run(ctx, `UPDATE sandbox_profiles SET deleted_at = ?, deleted_by = ? WHERE org_id = ? AND key = ? AND deleted_at IS NULL`, now, ctx.userId, ctx.orgId, key);
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "not_found", message: `No profile "${key}".` }, 404);
  await run(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'sandbox.profile_delete', ?, '{}', ?)`, ctx.orgId, ctx.userId, key, now);
  return c.json({ deleted: key });
});

export { liveSandboxRows };
