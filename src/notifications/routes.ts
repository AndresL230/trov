// Cookie-gated notification routes (canopy-email.md §8). Mounted under
// /api/notifications by the Hono app, so every route here already passed
// sessionGate; admin routes additionally check isAdmin. NEVER MCP tools.
import { Hono } from "hono";
import { z } from "zod";
import { Cadence, RunCadence, type PrefsKindView, type PrefsView, type PolicyKindView } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationPolicyRow, NotificationSettingsRow, PersonRow } from "@shared/rows";
import { type AppEnv, isAdmin } from "../auth/principal";
import { findPersonByEmail } from "../auth/persons";
import { type DB, all, first, run, nowIso } from "../db";
import { REGISTRY, getKind } from "./registry";
import { loadPolicies, loadPrefs, resolveWith } from "./resolve";
import { loadSettings } from "./cron";
import { computeWindow } from "./window";
import { renderSections, buildMessage, deliverRow } from "./run";
import { deliveryFor } from "./resend";
import { unsubscribeUrl } from "./unsubscribe";
import { sampleSections } from "./sample";
import { LEGACY_ORG_ID } from "../legacy-org";
import { legacyDb } from "../data/legacy";

export const notificationsApp = new Hono<AppEnv>();

// ── per-user prefs ────────────────────────────────────────────────────────────


export async function prefsView(db: DB, login: string): Promise<PrefsView> {
  const person = await first<PersonRow>(db, `SELECT * FROM persons WHERE handle = ?`, login);
  const policies = await loadPolicies(db);
  const prefs = await loadPrefs(db, login);
  const kinds: PrefsKindView[] = [];
  for (const k of REGISTRY) {
    const policy = policies.get(k.id);
    if (policy && policy.enabled === 0) continue;
    const pref = prefs.get(k.id);
    kinds.push({
      id: k.id,
      label: k.label,
      description: k.description,
      allowedCadences: k.allowedCadences,
      cadence: resolveWith(k, policy, pref),
      orgDefault: resolveWith(k, policy, undefined),
      inherited: pref === undefined,
    });
  }
  return { email: person?.email ?? null, unsubscribed: (person?.email_unsubscribed ?? 0) === 1, kinds };
}

const Email = z.string().trim().max(254).refine((s) => s === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), "invalid email");

const PrefsWrite = z.object({
  email: Email.optional(),                                 // "" clears the address
  unsubscribed: z.boolean().optional(),
  prefs: z.record(z.string(), Cadence.nullable()).optional(), // null = reset (delete the row)
});

notificationsApp.get("/prefs", async (c) => c.json(await prefsView(legacyDb(c.var.ctx), c.get("principal").handle)));

notificationsApp.put("/prefs", async (c) => {
  const login = c.get("principal").handle; // the ONLY row a user can touch
  const parsed = PrefsWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const body = parsed.data;

  // Validate every pref against the kind's allowedCadences BEFORE writing anything.
  const writes: { kind: string; cadence: Cadence | null }[] = [];
  for (const [kindId, cadence] of Object.entries(body.prefs ?? {})) {
    const kind = getKind(kindId);
    if (!kind) return c.json({ error: `unknown kind: ${kindId}` }, 400);
    if (cadence !== null && !kind.allowedCadences.includes(cadence)) {
      return c.json({ error: `cadence ${cadence} not allowed for ${kindId} (allowed: ${kind.allowedCadences.join(", ")})` }, 400);
    }
    writes.push({ kind: kindId, cadence });
  }

  // persons.email is an auth matcher (the sign-in fork's branch 2 links on it) but has
  // no DB-level UNIQUE constraint — guard it here instead: a non-empty address already
  // on someone ELSE's row is refused (409) before anything is written. Re-saving your
  // own address is fine (case-insensitive compare against the caller's own handle).
  if (body.email) {
    const existing = await findPersonByEmail(legacyDb(c.var.p), body.email);
    if (existing && existing.handle.toLowerCase() !== login.toLowerCase()) {
      return c.json({ error: "email_in_use" }, 409);
    }
  }

  const now = nowIso();
  if (body.email !== undefined) await run(legacyDb(c.var.p), `UPDATE persons SET email = ? WHERE handle = ?`, body.email === "" ? null : body.email, login);
  if (body.unsubscribed !== undefined) await run(legacyDb(c.var.p), `UPDATE persons SET email_unsubscribed = ? WHERE handle = ?`, body.unsubscribed ? 1 : 0, login);
  for (const w of writes) {
    if (w.cadence === null) await run(legacyDb(c.var.ctx), `DELETE FROM notification_prefs WHERE user_id = ? AND kind = ?`, login, w.kind);
    else await run(legacyDb(c.var.ctx), `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, user_id, kind) DO UPDATE SET cadence = excluded.cadence, updated_at = excluded.updated_at`, login, w.kind, w.cadence, now);
  }
  return c.json(await prefsView(legacyDb(c.var.ctx), login));
});

// ── admin: policy / settings / outbox / teammate address ─────────────────────

const adminOnly = notificationsApp.use("/policy", async (c, next) => (isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403)));
adminOnly.use("/settings", async (c, next) => (isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403)));
adminOnly.use("/outbox", async (c, next) => (isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403)));
adminOnly.use("/persons/*", async (c, next) => (isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403)));
adminOnly.use("/preview", async (c, next) => (isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403)));
adminOnly.use("/test-send", async (c, next) => (isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403)));


async function policyView(db: DB): Promise<{ kinds: PolicyKindView[] }> {
  const policies = await loadPolicies(db);
  return {
    kinds: REGISTRY.map((k) => {
      const p = policies.get(k.id);
      return {
        id: k.id, label: k.label, description: k.description, allowedCadences: k.allowedCadences, registryDefault: k.defaultCadence,
        enabled: p ? p.enabled === 1 : true,
        default_cadence: p?.default_cadence ?? k.defaultCadence,
        updated_at: p?.updated_at ?? null,
        updated_by: p?.updated_by ?? null,
      };
    }),
  };
}

const PolicyWrite = z.object({ kind: z.string(), enabled: z.boolean().optional(), default_cadence: Cadence.optional() });

notificationsApp.get("/policy", async (c) => c.json(await policyView(legacyDb(c.var.ctx))));

notificationsApp.put("/policy", async (c) => {
  const parsed = PolicyWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const { kind: kindId, enabled, default_cadence } = parsed.data;
  const kind = getKind(kindId);
  if (!kind) return c.json({ error: `unknown kind: ${kindId}` }, 400);
  if (default_cadence !== undefined && !kind.allowedCadences.includes(default_cadence)) {
    return c.json({ error: `cadence ${default_cadence} not allowed for ${kindId}` }, 400);
  }
  const existing = await first<NotificationPolicyRow>(legacyDb(c.var.ctx), `SELECT * FROM notification_policy WHERE kind = ?`, kindId);
  await run(
    legacyDb(c.var.ctx),
    `INSERT INTO notification_policy (kind, default_cadence, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, kind) DO UPDATE SET default_cadence = excluded.default_cadence, enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    kindId,
    default_cadence ?? existing?.default_cadence ?? kind.defaultCadence,
    enabled === undefined ? (existing?.enabled ?? 1) : enabled ? 1 : 0,
    nowIso(),
    c.get("principal").handle
  );
  return c.json(await policyView(legacyDb(c.var.ctx)));
});

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const SettingsWrite = z.object({
  send_hour: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).refine(validTimeZone, "unknown IANA timezone").optional(),
  from_address: z.string().trim().min(3).max(254).optional(),
});

notificationsApp.get("/settings", async (c) => c.json(await loadSettings(legacyDb(c.var.ctx))));

notificationsApp.put("/settings", async (c) => {
  const parsed = SettingsWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const cur = await loadSettings(legacyDb(c.var.ctx));
  const next: NotificationSettingsRow = { ...cur, ...parsed.data, org_id: LEGACY_ORG_ID };
  await run(
    legacyDb(c.var.ctx),
    `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET send_hour = excluded.send_hour, timezone = excluded.timezone, from_address = excluded.from_address`,
    LEGACY_ORG_ID,
    next.send_hour,
    next.timezone,
    next.from_address
  );
  return c.json(await loadSettings(legacyDb(c.var.ctx)));
});

notificationsApp.get("/outbox", async (c) => {
  const limit = Math.trunc(Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200));
  const rows = await all<NotificationOutboxRow>(legacyDb(c.var.ctx), `SELECT * FROM notification_outbox ORDER BY created_at DESC, idempotency_key DESC LIMIT ${limit}`);
  return c.json({ rows });
});

const PersonEmailWrite = z.object({ email: Email });

notificationsApp.put("/persons/:handle", async (c) => {
  const parsed = PersonEmailWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const handle = c.req.param("handle");
  // Same email-matcher guard as self-service PUT /prefs: a different handle already
  // holding this address is refused, never silently reassigned.
  if (parsed.data.email) {
    const existing = await findPersonByEmail(legacyDb(c.var.p), parsed.data.email);
    if (existing && existing.handle.toLowerCase() !== handle.toLowerCase()) {
      return c.json({ error: "email_in_use" }, 409);
    }
  }
  const res = await run(legacyDb(c.var.p), `UPDATE persons SET email = ? WHERE handle = ?`, parsed.data.email === "" ? null : parsed.data.email, handle);
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "no such person" }, 404);
  return c.json({ ok: true, handle, email: parsed.data.email || null });
});

// ── admin: preview + test send ───────────────────────────────────────────────
// Both render for the CALLER over every policy-enabled kind (prefs ignored —
// the admin wants to see everything), for the window a run at `now` would use.

async function enabledKinds(db: DB) {
  const policies = await loadPolicies(db);
  return REGISTRY.filter((k) => (policies.get(k.id)?.enabled ?? 1) === 1);
}

/** GET /preview?cadence=daily|weekly[&format=html|text][&sample=1] → the rendered digest, no outbox row. */
notificationsApp.get("/preview", async (c) => {
  const cadence = RunCadence.safeParse(c.req.query("cadence") ?? "daily");
  if (!cadence.success) return c.json({ error: "cadence must be daily or weekly" }, 400);
  const login = c.get("principal").handle;
  const settings = await loadSettings(legacyDb(c.var.ctx));
  const window = computeWindow(cadence.data, new Date(), settings.timezone);
  const kinds = await enabledKinds(legacyDb(c.var.ctx));
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const sections = c.req.query("sample") === "1" ? sampleSections() : (await renderSections(legacyDb(c.var.ctx), login, kinds, window)).sections;
  if (sections.length === 0) {
    return c.html(`<!DOCTYPE html><meta charset="utf-8"><body style="font-family:system-ui;padding:32px;color:#444"><h2>Nothing to render</h2><p>No section had anything to say for <b>${login}</b> in the ${cadence.data} window (${window.id}). A real run would mark this user <code>skipped</code>. Add <code>&amp;sample=1</code> to see the layout with sample data.</p></body>`);
  }
  const msg = await buildMessage(sections, { login, window, timeZone: settings.timezone }, {
    delivery: { send: async () => ({ id: null }) },
    origin,
    unsubscribeUrl: (l) => unsubscribeUrl(origin, l, c.env.COOKIE_SECRET),
  });
  return c.req.query("format") === "text" ? c.text(msg.text) : c.html(msg.html);
});

const TestSend = z.object({ cadence: RunCadence, sample: z.boolean().optional() });

/**
 * POST /test-send {cadence, sample?} → sends the caller's digest to the caller's
 * address through the REAL delivery gate (local mode → bodies table; resend
 * mode → Resend). Logged as its own outbox row keyed `login:cadence:test-<ts>`
 * so it never claims (or is blocked by) the scheduled window.
 */
notificationsApp.post("/test-send", async (c) => {
  const parsed = TestSend.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const login = c.get("principal").handle;
  const person = await first<PersonRow>(legacyDb(c.var.p), `SELECT * FROM persons WHERE handle = ?`, login);
  if (!person?.email) return c.json({ error: "no email on file for you — set one in Settings first" }, 400);

  const settings = await loadSettings(legacyDb(c.var.ctx));
  const window = computeWindow(parsed.data.cadence, new Date(), settings.timezone);
  const kinds = await enabledKinds(legacyDb(c.var.ctx));
  const preset = parsed.data.sample ? sampleSections() : undefined;
  if (!preset) {
    const probe = await renderSections(legacyDb(c.var.ctx), login, kinds, window);
    if (probe.sections.length === 0) return c.json({ error: `nothing to render for ${login} in the ${parsed.data.cadence} window (${window.id}); pass sample:true to send the sample digest` }, 400);
  }

  let delivery;
  try {
    delivery = deliveryFor(c.env, { from: settings.from_address });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 503);
  }
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const key = `${login}:${parsed.data.cadence}:test-${nowIso().replace(/[:.]/g, "-")}`;
  await run(
    legacyDb(c.var.ctx),
    `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    key, login, parsed.data.cadence, `${window.id} (test)`, JSON.stringify(kinds.map((k) => k.id)), nowIso()
  );
  const status = await deliverRow(
    legacyDb(c.var.ctx),
    { key, login, email: person.email, kinds, window, timeZone: settings.timezone },
    { delivery, origin, unsubscribeUrl: (l) => unsubscribeUrl(origin, l, c.env.COOKIE_SECRET) },
    preset
  );
  const row = await first<{ resend_id: string | null; error: string | null }>(legacyDb(c.var.ctx), `SELECT resend_id, error FROM notification_outbox WHERE idempotency_key = ?`, key);
  return c.json({ ok: status === "sent", status, key, mode: delivery.mode, to: person.email, resend_id: row?.resend_id ?? null, error: row?.error ?? null });
});
