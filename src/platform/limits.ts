// Abuse limits (docs/architecture/abuse-limits.md; 0046 `abuse_counters`). Anyone with a GitHub account
// can sign in, so each action that sends mail, stores bytes or answers a lookup is capped PER PERSON —
// across every org they are in or create. Every number is in `LIMITS`; nothing else in src/ holds one.
//
// One unit is taken by ONE statement — an upsert that only counts while the window has room — so two
// racing requests cannot both take the last unit. D1 only: no Durable Object, no Queue. A superadmin
// is exempt. A refusal writes nothing, and a D1 failure here fails the request (closed), like any
// other statement of the route.
import type { Context } from "hono";
import type { AppEnv } from "../auth/principal";
import { isSuperadmin } from "../data/context";
import { type PlatformContext, run } from "../data/platform-sql";

export interface Limit { max: number; window: "day" | "hour" }

export const LIMITS = {
  /** Invites created or re-sent (the invite mail, and a pending invite on someone's sign-in screen). */
  invite: { max: 50, window: "day" },
  /** `POST …/notifications/test-send`: a digest mailed to the caller's own address. */
  test_send: { max: 20, window: "day" },
  /** A change of notification address (the caller's own, or a member's by their admin). */
  email_change: { max: 5, window: "day" },
  /** `POST …/people/me/avatar`: an image stored in R2. */
  avatar_upload: { max: 20, window: "day" },
  /** `POST /api/o/:slug/logo`: an org's image stored in R2 — the uploader's allowance, across their orgs. */
  org_logo_upload: { max: 20, window: "day" },
  /** `GET /auth/handle-check`: is a handle taken. */
  handle_check: { max: 60, window: "hour" },
} as const satisfies Record<string, Limit>;

export type LimitedAction = keyof typeof LIMITS;

/** Counters of past windows are deleted once they are this old (the daily cron, `pruneLimits`). */
export const LIMIT_RETENTION_DAYS = 2;

const HOUR_MS = 3_600_000;
const windowMs = (l: Limit): number => (l.window === "day" ? 24 * HOUR_MS : HOUR_MS);
/** The UTC start of the window `now` is in: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH'. */
const bucketOf = (l: Limit, now: number): string => new Date(now).toISOString().slice(0, l.window === "day" ? 10 : 13);

/**
 * Take one unit of `action` for `subject`. Null = taken; otherwise the whole seconds until the window
 * turns over (at least 1) — the 429's `retry_after`.
 */
export async function takeLimit(p: PlatformContext, subject: string, action: LimitedAction, now: number = Date.now()): Promise<number | null> {
  const limit: Limit = LIMITS[action];
  const res = await run(p,
    `INSERT INTO abuse_counters (subject, action, bucket, count, last_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(subject, action, bucket) DO UPDATE SET count = count + 1, last_at = excluded.last_at
     WHERE abuse_counters.count < ?`,
    subject, action, bucketOf(limit, now), new Date(now).toISOString(), limit.max);
  if ((res.meta.changes ?? 0) > 0) return null;
  const size = windowMs(limit);
  return Math.max(1, Math.ceil((Math.floor(now / size) * size + size - now) / 1000));
}

/**
 * The route guard: null when the caller may go on, else the refusal to return —
 * 429 `{ error: "rate_limited", retry_after }` with a `Retry-After` header. `subject` defaults to the
 * session principal's handle; a superadmin is never limited (and never counted).
 */
export async function rateLimited(c: Context<AppEnv>, action: LimitedAction, subject?: string): Promise<Response | null> {
  const handle = c.get("principal")?.handle;
  if (handle && (await isSuperadmin(c.var.p, handle))) return null;
  const who = subject ?? handle;
  if (!who) return null;
  const retryAfter = await takeLimit(c.var.p, who, action);
  if (retryAfter === null) return null;
  return c.json({ error: "rate_limited", retry_after: retryAfter }, 429, { "retry-after": String(retryAfter) });
}

/** The daily cron: drop counters whose window is long over. */
export async function pruneLimits(p: PlatformContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LIMIT_RETENTION_DAYS * 24 * HOUR_MS).toISOString();
  return (await run(p, `DELETE FROM abuse_counters WHERE last_at < ?`, cutoff)).meta.changes ?? 0;
}

