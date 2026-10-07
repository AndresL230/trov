// Plans (tiers) and their entitlements — the ONE definition the Worker, the SPA and the landing page
// share (docs/architecture/plans.md). Zod-free and dependency-free.
//
// A plan is a name over a table of LIMITS. An org holds a plan (`orgs.plan`, 0044_plans) and, optionally,
// per-org OVERRIDES of any limit (`orgs.plan_overrides`) — how the superadmin sizes an Enterprise org, and
// how they make an exception on any plan. Every number below is a PLACEHOLDER for the owner to decide:
// change it here and nothing else needs to change (the enforcement points read the resolved value).
// No prices, here or anywhere in Trov: a plan's price is a Stripe Price id in `wrangler.toml`
// (src/billing/config.ts, docs/architecture/billing.md) and its amount is shown at Stripe's checkout.
import type { OrgBillingView, PlatformOrgBilling } from "./billing";

export const PLAN_IDS = ["personal", "team", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);

/** Every limit a plan sets. `null` as a value means UNLIMITED. */
export const LIMIT_KEYS = ["seats", "repositories", "environments", "artifact_bytes", "agent_connections", "ai_summaries"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Entitlements = Record<LimitKey, number | null>;
/** Per-org exceptions: a key that is present replaces the plan's value (null = unlimited); absent = the plan's. */
export type PlanOverrides = Partial<Entitlements>;

export interface LimitDef {
  /** Sentence-case name, for a table row ("Seats"). */
  label: string;
  /** What is counted, singular and plural, for a sentence ("10 seats"). */
  one: string;
  many: string;
  /** What counts toward it — one line, shown under the row and in the docs. */
  counts: string;
  /** Counted per org, or per person within the org. */
  per: "org" | "person";
  unit: "count" | "bytes";
  /** The smallest value an override may set (a seat cap of 0 would lock the owner out). */
  min: number;
  /** An ALLOWANCE that resets each calendar month (UTC), not a size: use is "N of M this month", and
   *  reaching it is never "over the limit" — `atCap` says what happens instead. */
  period?: "month";
  atCap?: string;
}

export const LIMITS: Record<LimitKey, LimitDef> = {
  seats: { label: "Seats", one: "seat", many: "seats", counts: "Members plus pending invitations.", per: "org", unit: "count", min: 1 },
  repositories: { label: "Repositories", one: "repository", many: "repositories", counts: "Connected repositories.", per: "org", unit: "count", min: 0 },
  environments: { label: "Environments", one: "environment", many: "environments", counts: "Environments the Repo dashboard reports on.", per: "org", unit: "count", min: 0 },
  artifact_bytes: { label: "Artifact storage", one: "byte", many: "bytes", counts: "Every stored version of every artifact.", per: "org", unit: "bytes", min: 0 },
  agent_connections: { label: "Agent connections", one: "agent connection", many: "agent connections", counts: "Your own MCP tokens and connected apps for this organization.", per: "person", unit: "count", min: 0 },
  // The one MONTHLY allowance (docs/architecture/plans.md › AI summaries). It refuses nothing with a 402:
  // past it a new pull request or issue is stored with its excerpt, and a later Sync fills it in.
  ai_summaries: {
    label: "AI summaries", one: "AI summary", many: "AI summaries", counts: "Summaries of pull requests and issues attempted this calendar month (UTC).",
    per: "org", unit: "count", min: 0, period: "month", atCap: "New pull requests and issues show an excerpt until next month.",
  },
};

/** A plan's price, when one is written in code. Unused: prices are deployment config (`STRIPE_PRICE_*`),
 *  resolved by src/billing/config.ts, so the owner changes one without a release. */
export interface PlanBilling {
  /** The payment provider's id of this plan's price. */
  price_id: string;
}

export interface PlanDef {
  id: PlanId;
  name: string;
  /** One line: who it is for. */
  description: string;
  entitlements: Entitlements;
  /** null: the price id is deployment config (see `PlanBilling`). */
  billing: PlanBilling | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

// PLACEHOLDER NUMBERS — the owner decides. `seats` are the owner's own (1 / 10 / set per org); the rest
// are first guesses. Enterprise's repositories and environments are the platform's caps from before
// plans (10 each: the repo cron's budget is shared), so an existing org sees no change.
// `ai_summaries` (per calendar month) is a PLACEHOLDER too: 300 / 3,000 / unlimited — sized so that one
// org cannot run up the platform's one Gemini bill, not from measured use (plans.md › AI summaries).
export const PLANS: Record<PlanId, PlanDef> = {
  personal: {
    id: "personal", name: "Personal", description: "One person's own organization.",
    entitlements: { seats: 1, repositories: 1, environments: 2, artifact_bytes: 250 * MB, agent_connections: 5, ai_summaries: 300 },
    billing: null,
  },
  team: {
    id: "team", name: "Team", description: "A team of up to 10 people.",
    entitlements: { seats: 10, repositories: 5, environments: 5, artifact_bytes: 5 * GB, agent_connections: 10, ai_summaries: 3000 },
    billing: null,
  },
  enterprise: {
    id: "enterprise", name: "Enterprise", description: "Limits set for the organization by Trov.",
    entitlements: { seats: null, repositories: 10, environments: 10, artifact_bytes: null, agent_connections: null, ai_summaries: null },
    billing: null,
  },
};

/** The plan an unknown or missing id resolves to: the smallest (fail closed). */
export const FALLBACK_PLAN: PlanId = "personal";
export const planDef = (id: string | null | undefined): PlanDef => (isPlanId(id) ? PLANS[id] : PLANS[FALLBACK_PLAN]);

// ── per-org state ────────────────────────────────────────────────────────────

/** `orgs.plan_source` — who put the org on its plan: the superadmin (or a grant of theirs), or billing. */
export const PLAN_SOURCES = ["granted", "billing"] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];
/** `orgs.plan_status`. `past_due` changes nothing (the grace period is Stripe's retry schedule); `canceled` keeps the org
 *  readable and working but refuses every ADDITION a limit governs, until the plan is set again. */
export const PLAN_STATUSES = ["active", "past_due", "canceled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface OrgPlanState {
  plan: PlanId; overrides: PlanOverrides; status: PlanStatus;
  /** Who put the org on the plan. Only `billing` matters here: a refusal then says so (`PlanRefusal.paid`). */
  source?: PlanSource | null;
}

const OVERRIDE_MAX = Number.MAX_SAFE_INTEGER;

/** Validate overrides from a request or a stored JSON value. Unknown keys and bad values are refused
 *  (`null` on failure) — never silently dropped, so a typo cannot read as "unlimited". */
export function parseOverrides(input: unknown): PlanOverrides | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out: PlanOverrides = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) return null;
    const key = k as LimitKey;
    if (v === null) { out[key] = null; continue; }
    if (typeof v !== "number" || !Number.isInteger(v) || v < LIMITS[key].min || v > OVERRIDE_MAX) return null;
    out[key] = v;
  }
  return out;
}

/** A stored `plan_overrides` value: bad JSON or a bad shape reads as "no overrides" (the plan's own limits). */
export function storedOverrides(json: string | null | undefined): PlanOverrides {
  if (!json) return {};
  try { return parseOverrides(JSON.parse(json)) ?? {}; } catch { return {}; }
}

/** THE resolution: the plan's defaults with the org's overrides on top. */
export function resolveEntitlements(plan: string | null | undefined, overrides: PlanOverrides = {}): Entitlements {
  const base = planDef(plan).entitlements;
  const out = { ...base };
  for (const k of LIMIT_KEYS) if (k in overrides && overrides[k] !== undefined) out[k] = overrides[k] as number | null;
  return out;
}

// ── the refusal ──────────────────────────────────────────────────────────────

/** The body of every plan refusal (HTTP 402; an MCP tool error with `code: "plan_limit"`). */
export interface PlanRefusal {
  error: "plan_limit";
  /** Which limit refused. */
  limit: LimitKey;
  /** What the org (or, for a per-person limit, the caller) uses now. */
  used: number;
  /** The limit in force: the plan's, or the org's override. Never null — an unlimited limit refuses nothing. */
  cap: number;
  plan: PlanId;
  /** `canceled` when the refusal is the plan's status rather than its size. */
  status: PlanStatus;
  /** One plain sentence. */
  message: string;
  /** The org pays for its plan through billing: its owner can change it themselves (Org settings). Absent otherwise. */
  paid?: true;
}

/** The smallest plan whose own seats allow more than one person — what a Personal org is pointed at. */
export const firstTeamPlan = (): PlanDef => PLAN_IDS.map((id) => PLANS[id]).find((d) => d.entitlements.seats === null || d.entitlements.seats > 1) ?? PLANS.team;

export function formatBytes(n: number): string {
  if (n >= GB) return `${+(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${+(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
/** A count as text, with thousands separators: "10", "3,000". The ONE place a limit's number is written. */
export const formatCount = (n: number): string => n.toLocaleString("en-US");
/** A limit's value as text: "10", "3,000", "5 GB", "Unlimited" — THE formatter the Plan block, Platform
 *  and the pricing page all show a limit (and a use of one) through. */
export function formatLimit(key: LimitKey, value: number | null): string {
  if (value === null) return "Unlimited";
  return LIMITS[key].unit === "bytes" ? formatBytes(value) : formatCount(value);
}
/** A limit's name inside a sentence: "seats", "artifact storage", "AI summaries" — never a lower-cased
 *  label (which would write "ai summaries"). */
export const limitNoun = (key: LimitKey): string => (LIMITS[key].unit === "bytes" ? LIMITS[key].label.toLowerCase() : LIMITS[key].many);
/** A plan's limit as a phrase: ["3,000", "AI summaries per month"], ["10", "seats"], ["5 GB", "artifact
 *  storage"], ["5", "agent connections per person"], ["Unlimited", "AI summaries"]. An unlimited
 *  allowance has no period to name. */
export function limitPhrase(key: LimitKey, value: number | null): [value: string, what: string] {
  const d = LIMITS[key];
  const what = value === 1 && d.unit !== "bytes" ? d.one : limitNoun(key);
  return [formatLimit(key, value), `${what}${d.per === "person" ? " per person" : ""}${d.period && value !== null ? ` per ${d.period}` : ""}`];
}
/** A plan's seats in words: "for one person", "up to 10 people", "any number of people". */
export function seatsPhrase(seats: number | null, sentence = false): string {
  const s = seats === null ? "any number of people" : seats === 1 ? "for one person" : `up to ${seats} people`;
  if (!sentence) return s;
  return seats === 1 ? "For one person: you" : seats === null ? "For any number of people" : `For up to ${seats} people`;
}
/** "7 of 10", "1.2 GB of 5 GB", "7" (unlimited); a monthly allowance says so: "1,212 of 3,000 this month". */
export function formatUse(key: LimitKey, used: number, cap: number | null): string {
  const u = formatLimit(key, used);
  return cap === null ? u : `${u} of ${formatLimit(key, cap)}${LIMITS[key].period === "month" ? " this month" : ""}`;
}

function refusalMessage(state: OrgPlanState, limit: LimitKey, cap: number): string {
  const name = planDef(state.plan).name;
  if (state.status === "canceled") return `This organization's ${name} plan has ended, so nothing can be added until it is renewed.`;
  const d = LIMITS[limit];
  if (limit === "seats" && cap <= 1) return `The ${name} plan is for one person. Invitations start with the ${firstTeamPlan().name} plan.`;
  if (d.unit === "bytes") return `This organization has reached the ${formatBytes(cap)} of ${limitNoun(limit)} its ${name} plan includes.`;
  const what = `${formatCount(cap)} ${cap === 1 ? d.one : d.many}`;
  return d.per === "person"
    ? `You have reached the ${what} per person this organization's ${name} plan includes.`
    : `This organization has reached the ${what} its ${name} plan includes.`;
}

/**
 * THE question — "may this org add `adding` more of `limit`, given it uses `used` now?" — and its one
 * answer: null (yes), or the typed refusal. Every enforcement point calls it; none compares a count to
 * a number itself. An org OVER a limit (a downgrade, a lowered override) is refused additions of that
 * kind and nothing else: reads, removals and everything the limit does not govern keep working.
 */
export function planRefusal(state: OrgPlanState, limit: LimitKey, used: number, adding = 1): PlanRefusal | null {
  const cap = resolveEntitlements(state.plan, state.overrides)[limit];
  const plan = planDef(state.plan).id;
  const paid = state.source === "billing" ? { paid: true as const } : {};
  if (state.status === "canceled") return { error: "plan_limit", limit, used, cap: cap ?? used, plan, status: state.status, message: refusalMessage(state, limit, cap ?? used), ...paid };
  if (cap === null || used + adding <= cap) return null;
  return { error: "plan_limit", limit, used, cap, plan, status: state.status, message: refusalMessage(state, limit, cap), ...paid };
}

/** Is a parsed JSON body a plan refusal? (The SPA's one check, on a 402.) */
export function isPlanRefusal(v: unknown): v is PlanRefusal {
  const r = v as Partial<PlanRefusal> | null;
  return !!r && typeof r === "object" && r.error === "plan_limit" && typeof r.limit === "string" && typeof r.message === "string";
}

/** Who can change a plan, said to the person who hit a limit. An owner of an org that PAYS for its plan
 *  changes it themselves (`paid_owner`, `ended_owner`); an owner of a granted one asks Trov. */
export const PLAN_CHANGE_POINTER = {
  owner: "Ask Trov to change your plan.",
  paid_owner: "You can upgrade or manage billing in Org settings.",
  ended_owner: "You can renew it in Org settings.",
  other: "Ask one of this organization's owners.",
} as const;
/** A refusal as the ONE sentence the SPA shows, with who can change it. */
export function planRefusalSentence(r: Pick<PlanRefusal, "message"> & Partial<Pick<PlanRefusal, "paid" | "status">>, role: "owner" | "admin" | "member" | null): string {
  const pointer = role !== "owner" ? PLAN_CHANGE_POINTER.other
    : !r.paid ? PLAN_CHANGE_POINTER.owner
    : r.status === "canceled" ? PLAN_CHANGE_POINTER.ended_owner : PLAN_CHANGE_POINTER.paid_owner;
  return `${r.message} ${pointer}`;
}

// ── wire: an org's plan, as its members read it (GET /api/o/:slug/plan) ───────

export interface OrgPlanView {
  plan: PlanId;
  name: string;
  description: string;
  status: PlanStatus;
  source: PlanSource | null;
  /** The paid period's end (`orgs.plan_period_end`): the renewal date, or when a cancelled plan ends. Null for a granted org. */
  period_end: string | null;
  /** How the org pays (shared/billing.ts) — only for an org on a Stripe subscription; null / absent = nothing about payment is shown. */
  billing?: OrgBillingView | null;
  entitlements: Entitlements;
  /** The limits this org has an override for. */
  overridden: LimitKey[];
  /** Current use. `seats` = members + pending invitations; `agent_connections` = the CALLER's own. */
  usage: Record<LimitKey, number>;
  /** `seats` split, for the Members tab. */
  seats: { members: number; pending: number };
  /** The limits the org is over right now (use > cap): additions of that kind are refused. */
  over: LimitKey[];
}

/** The limits an org is over — use above the cap in force. A monthly allowance is never "over": using
 *  it up refuses nothing, and it resets by itself (`LimitDef.atCap`). */
export function overLimits(entitlements: Entitlements, usage: Partial<Record<LimitKey, number>>): LimitKey[] {
  return LIMIT_KEYS.filter((k) => !LIMITS[k].period && entitlements[k] !== null && (usage[k] ?? 0) > (entitlements[k] as number));
}

/** The first instant's DAY of the calendar month `now` falls in, UTC: 'YYYY-MM-01' — where a monthly
 *  allowance starts counting. */
export const monthStartDay = (now: Date = new Date()): string => `${now.toISOString().slice(0, 7)}-01`;

// ── wire: grants ─────────────────────────────────────────────────────────────

/** `expired` is derived (an unused grant past `expires_at`); the row itself stays `unused`. */
export type OrgGrantStatus = "unused" | "used" | "revoked" | "expired";
/** Who a grant is for: exactly one key (the three ways Platform names a person). */
export type GrantTarget = { handle: string } | { github_login: string } | { email: string };
export const GRANT_NOTE_MAX = 280;
/** The expiry choices Platform offers, in days (null = never). The API takes any 1–365. */
export const GRANT_EXPIRY_DAYS = [7, 30, 90] as const;
export const GRANT_EXPIRY_MAX_DAYS = 365;

/** A grant the signed-in person can use (GET /api/orgs `grants`). */
export interface MyGrant {
  id: number;
  plan: PlanId;
  plan_name: string;
  entitlements: Entitlements;
  granted_by: string;
  created_at: string;
  expires_at: string | null;
}

/** A grant as the superadmin sees it (GET /api/platform/grants). */
export interface PlatformGrant {
  id: number;
  handle: string | null;
  github_login: string | null;
  email: string | null;
  plan: PlanId;
  overrides: PlanOverrides;
  note: string | null;
  source: PlanSource;
  granted_by: string;
  created_at: string;
  expires_at: string | null;
  status: OrgGrantStatus;
  used_at: string | null;
  used_by: string | null;
  /** The org the grant became. */
  org: { slug: string; name: string } | null;
  revoked_at: string | null;
  revoked_by: string | null;
  /** The notice e-mail's outcome (an e-mail grant only); null = none sent. */
  mail_status: "sent" | "failed" | null;
  mail_at: string | null;
  mail_error: string | null;
}

/** An org's plan as Platform lists it. */
export interface PlatformOrgPlan {
  plan: PlanId;
  overrides: PlanOverrides;
  status: PlanStatus;
  source: PlanSource | null;
  entitlements: Entitlements;
  /** Members + pending invitations. */
  seats_used: number;
  /** The Stripe subscription behind a paid org (shared/billing.ts); null / absent for a granted one. */
  billing?: PlatformOrgBilling | null;
}
