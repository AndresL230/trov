// Cookie-gated notification routes (canopy-email.md §8). A tenant sub-app: mounted at
// `/api/o/:slug/notifications` and, as the cut-over alias, `/api/notifications` (src/routes.ts), so
// every route here already passed sessionGate and a tenant gate; admin routes additionally
// check the ORG role (admin or owner of `c.var.ctx`'s org — §5.2). NEVER MCP tools.
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { Cadence, RunCadence, type PrefsKindView, type PrefsView, type PolicyKindView } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationPolicyRow, NotificationSettingsRow, PersonRow } from "@shared/rows";
import type { AppEnv } from "../auth/principal";
import { memberHandle } from "../auth/persons";
import { hasRole } from "../data/context";
import { type TenantContext, all, first, run, nowIso } from "../data/sql";
import { type PlatformContext, first as platformFirst, run as platformRun } from "../data/platform-sql";
import { REGISTRY, getKind } from "./registry";
import { loadPolicies, loadPrefs, resolveWith } from "./resolve";
import { loadSettings } from "./cron";
import { computeWindow } from "./window";
import { renderSections, buildMessage, deliverRow, outboxKey } from "./run";
import { PLATFORM_FROM_ADDRESS, SENDER_NAME_MAX, bareAddress, deliveryFor, senderNamePart, senderNameProblem } from "./resend";
import { rateLimited } from "../platform/limits";
import { unsubscribeUrl } from "./unsubscribe";
import { sampleSections } from "./sample";

export const notificationsApp = new Hono<AppEnv>();

// ── per-user prefs ────────────────────────────────────────────────────────────


/** The person's address and (global) unsubscribe come from `p`; the kinds are resolved in `ctx`'s org. */
export async function prefsView(ctx: TenantContext, p: PlatformContext, login: string): Promise<PrefsView> {
  const person = await platformFirst<PersonRow>(p, `SELECT * FROM persons WHERE handle = ?`, login);
  const policies = await loadPolicies(ctx);
  const prefs = await loadPrefs(ctx, login);
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

/** Is `email` already `handle`'s address (case-insensitively)? A re-save is not a change. */
async function sameEmail(p: PlatformContext, handle: string, email: string): Promise<boolean> {
  const row = await platformFirst<{ email: string | null }>(p, `SELECT email FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
  return (row?.email ?? "").toLowerCase() === email.toLowerCase();
}

const PrefsWrite = z.object({
  email: Email.optional(),                                 // "" clears the address
  unsubscribed: z.boolean().optional(),
  prefs: z.record(z.string(), Cadence.nullable()).optional(), // null = reset (delete the row)
});

notificationsApp.get("/prefs", async (c) => c.json(await prefsView(c.var.ctx, c.var.p, c.get("principal").handle)));

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

  // `persons.email` is a NOTIFICATION address, not an identity: sign-in and invites match on
  // `identities.verified_email`, never on it. So it is not unique, and this route does not say whether
  // an address is on someone else's row — the old 409 `email_in_use` told any signed-in stranger which
  // addresses are on file. A CHANGE of address is rate-limited (the caller has not proven they own it).
  if (body.email && !(await sameEmail(c.var.p, login, body.email))) {
    const refused = await rateLimited(c, "email_change");
    if (refused) return refused;
  }

  const now = nowIso();
  const ctx = c.var.ctx;
  if (body.email !== undefined) await platformRun(c.var.p, `UPDATE persons SET email = ? WHERE handle = ?`, body.email === "" ? null : body.email, login);
  if (body.unsubscribed !== undefined) await platformRun(c.var.p, `UPDATE persons SET email_unsubscribed = ? WHERE handle = ?`, body.unsubscribed ? 1 : 0, login);
  for (const w of writes) {
    if (w.cadence === null) await run(ctx, `DELETE FROM notification_prefs WHERE org_id = ? AND user_id = ? AND kind = ?`, ctx.orgId, login, w.kind);
    else await run(ctx, `INSERT INTO notification_prefs (org_id, user_id, kind, cadence, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, user_id, kind) DO UPDATE SET cadence = excluded.cadence, updated_at = excluded.updated_at`, ctx.orgId, login, w.kind, w.cadence, now);
  }
  return c.json(await prefsView(ctx, c.var.p, login));
});

// ── admin: policy / settings / outbox / teammate address ─────────────────────

const adminOnly: MiddlewareHandler<AppEnv> = async (c, next) => (hasRole(c.var.ctx, "admin") ? next() : c.json({ error: "admin only" }, 403));
for (const path of ["/policy", "/settings", "/outbox", "/persons/*", "/preview", "/test-send"]) notificationsApp.use(path, adminOnly);


async function policyView(ctx: TenantContext): Promise<{ kinds: PolicyKindView[] }> {
  const policies = await loadPolicies(ctx);
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

notificationsApp.get("/policy", async (c) => c.json(await policyView(c.var.ctx)));

notificationsApp.put("/policy", async (c) => {
  const parsed = PolicyWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const { kind: kindId, enabled, default_cadence } = parsed.data;
  const kind = getKind(kindId);
  if (!kind) return c.json({ error: `unknown kind: ${kindId}` }, 400);
  if (default_cadence !== undefined && !kind.allowedCadences.includes(default_cadence)) {
    return c.json({ error: `cadence ${default_cadence} not allowed for ${kindId}` }, 400);
  }
  const ctx = c.var.ctx;
  const existing = await first<NotificationPolicyRow>(ctx, `SELECT * FROM notification_policy WHERE org_id = ? AND kind = ?`, ctx.orgId, kindId);
  await run(
    ctx,
    `INSERT INTO notification_policy (org_id, kind, default_cadence, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, kind) DO UPDATE SET default_cadence = excluded.default_cadence, enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ctx.orgId,
    kindId,
    default_cadence ?? existing?.default_cadence ?? kind.defaultCadence,
    enabled === undefined ? (existing?.enabled ?? 1) : enabled ? 1 : 0,
    nowIso(),
    c.get("principal").handle
  );
  return c.json(await policyView(ctx));
});

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const SENDER_NAME_ERRORS = {
  empty: "a sender name is required",
  too_long: `a sender name is at most ${SENDER_NAME_MAX} characters`,
  characters: "a sender name may contain letters, digits, spaces and . & ' + _ - only",
  reserved: "a sender name may not read as Trov's own",
} as const;
/**
 * `from_address` is the org's SENDER NAME: `Name` or `Name <hello@trov.dev>` (the shape the stored value
 * and the current SPA use). The address is the platform's and is not settable — any other address is a
 * 400 — and the name is held to `senderNameProblem`. Stored normalised as `Name <platform address>`.
 */
const FromAddress = z.string().trim().max(254).transform((value, ctx) => {
  const fail = (message: string) => { ctx.addIssue({ code: "custom", message }); return z.NEVER; };
  if (/[<>@]/.test(value) && bareAddress(value).toLowerCase() !== PLATFORM_FROM_ADDRESS) {
    return fail(`mail is sent from ${PLATFORM_FROM_ADDRESS}; only the sender name can be changed`);
  }
  const name = senderNamePart(value).replace(/\s+/g, " ");
  const problem = senderNameProblem(name);
  return problem ? fail(SENDER_NAME_ERRORS[problem]) : `${name} <${PLATFORM_FROM_ADDRESS}>`;
});
const SettingsWrite = z.object({
  send_hour: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).refine(validTimeZone, "unknown IANA timezone").optional(),
  from_address: FromAddress.optional(),
});

notificationsApp.get("/settings", async (c) => c.json(await loadSettings(c.var.ctx)));

notificationsApp.put("/settings", async (c) => {
  const parsed = SettingsWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const ctx = c.var.ctx;
  const cur = await loadSettings(ctx);
  const next: NotificationSettingsRow = { ...cur, ...parsed.data, org_id: ctx.orgId };
  await run(
    ctx,
    `INSERT INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET send_hour = excluded.send_hour, timezone = excluded.timezone, from_address = excluded.from_address`,
    ctx.orgId,
    next.send_hour,
    next.timezone,
    next.from_address
  );
  return c.json(await loadSettings(ctx));
});

notificationsApp.get("/outbox", async (c) => {
  const limit = Math.trunc(Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200));
  const rows = await all<NotificationOutboxRow>(c.var.ctx, `SELECT * FROM notification_outbox WHERE org_id = ? ORDER BY created_at DESC, idempotency_key DESC LIMIT ${limit}`, c.var.ctx.orgId);
  return c.json({ rows });
});

const PersonEmailWrite = z.object({ email: Email });

// A person is ONE row across every org, and `persons.email` is where EVERY org's digest for them goes —
// so an org admin may set it only for a MEMBER of this org (anyone else is the same 404 as an unknown
// handle) who belongs to NO other org. Once a person is in two orgs the address is theirs alone to set
// (`PUT /prefs`): otherwise one org's admin could redirect another org's mail. 409 `email_not_yours_to_set`.
// Like `PUT /prefs`, it does not say whether the address is on someone else's row, and a change is rate-limited.
notificationsApp.put("/persons/:handle", async (c) => {
  const parsed = PersonEmailWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const handle = await memberHandle(c.var.ctx, c.req.param("handle"));
  if (!handle) return c.json({ error: "no such person" }, 404);
  const elsewhere = await platformFirst<{ n: number }>(c.var.p, `SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? COLLATE NOCASE AND org_id <> ?`, handle, c.var.ctx.orgId);
  if ((elsewhere?.n ?? 0) > 0) return c.json({ error: "email_not_yours_to_set" }, 409);
  if (parsed.data.email && !(await sameEmail(c.var.p, handle, parsed.data.email))) {
    const refused = await rateLimited(c, "email_change");
    if (refused) return refused;
  }
  const res = await platformRun(c.var.p, `UPDATE persons SET email = ? WHERE handle = ?`, parsed.data.email === "" ? null : parsed.data.email, handle);
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "no such person" }, 404);
  return c.json({ ok: true, handle, email: parsed.data.email || null });
});

// ── admin: preview + test send ───────────────────────────────────────────────
// Both render for the CALLER over every policy-enabled kind (prefs ignored —
// the admin wants to see everything), for the window a run at `now` would use.

async function enabledKinds(ctx: TenantContext) {
  const policies = await loadPolicies(ctx);
  return REGISTRY.filter((k) => (policies.get(k.id)?.enabled ?? 1) === 1);
}

/** GET /preview?cadence=daily|weekly[&format=html|text][&sample=1] → the rendered digest, no outbox row. */
notificationsApp.get("/preview", async (c) => {
  const cadence = RunCadence.safeParse(c.req.query("cadence") ?? "daily");
  if (!cadence.success) return c.json({ error: "cadence must be daily or weekly" }, 400);
  const login = c.get("principal").handle;
  const settings = await loadSettings(c.var.ctx);
  const window = computeWindow(cadence.data, new Date(), settings.timezone);
  const kinds = await enabledKinds(c.var.ctx);
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const sections = c.req.query("sample") === "1" ? sampleSections() : (await renderSections(c.var.ctx, login, kinds, window)).sections;
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
 * mode → Resend). Logged as its own outbox row keyed `org:login:cadence:test-<ts>`
 * so it never claims (or is blocked by) the scheduled window.
 */
notificationsApp.post("/test-send", async (c) => {
  const parsed = TestSend.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const login = c.get("principal").handle;
  const ctx = c.var.ctx;
  const person = await platformFirst<PersonRow>(c.var.p, `SELECT * FROM persons WHERE handle = ?`, login);
  if (!person?.email) return c.json({ error: "no email on file for you — set one in Settings first" }, 400);
  const refused = await rateLimited(c, "test_send");
  if (refused) return refused;

  const settings = await loadSettings(ctx);
  const window = computeWindow(parsed.data.cadence, new Date(), settings.timezone);
  const kinds = await enabledKinds(ctx);
  const preset = parsed.data.sample ? sampleSections() : undefined;
  if (!preset) {
    const probe = await renderSections(ctx, login, kinds, window);
    if (probe.sections.length === 0) return c.json({ error: `nothing to render for ${login} in the ${parsed.data.cadence} window (${window.id}); pass sample:true to send the sample digest` }, 400);
  }

  let delivery;
  try {
    delivery = deliveryFor(ctx, c.env, { from: settings.from_address });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 503);
  }
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const key = outboxKey(ctx, login, parsed.data.cadence, `test-${nowIso().replace(/[:.]/g, "-")}`);
  await run(
    ctx,
    `INSERT INTO notification_outbox (org_id, idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ctx.orgId, key, login, parsed.data.cadence, `${window.id} (test)`, JSON.stringify(kinds.map((k) => k.id)), nowIso()
  );
  const status = await deliverRow(
    ctx,
    { key, login, email: person.email, kinds, window, timeZone: settings.timezone },
    { delivery, origin, unsubscribeUrl: (l) => unsubscribeUrl(origin, l, c.env.COOKIE_SECRET) },
    preset
  );
  const row = await first<{ resend_id: string | null; error: string | null }>(ctx, `SELECT resend_id, error FROM notification_outbox WHERE idempotency_key = ? AND org_id = ?`, key, ctx.orgId);
  return c.json({ ok: status === "sent", status, key, mode: delivery.mode, to: person.email, resend_id: row?.resend_id ?? null, error: row?.error ?? null });
});
