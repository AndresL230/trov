// One type per D1 table — the exact row shape returned by db helpers.

// Tickets (0024) are defined ONCE, as Zod schemas in shared/tickets.ts (the
// contract the SPA and the Worker share), and re-exported here so `@shared/rows`
// stays the single index of D1 row shapes. Type-only: no runtime import.
export type {
  TicketRow, TicketAssigneeRow, TicketLinkRow, TicketCommentRow, TicketEventRow,
  TicketCategory, TicketPriority, TicketStatus, TicketLinkKind,
} from "./tickets";

// Sprints (the table 0025_sprints.sql renamed in place) are defined ONCE, as Zod
// schemas in shared/sprints.ts, and re-exported here for the same reason.
export type {
  SprintRow, SprintResourceRow,
  SprintStatus, SprintUrgency, SprintDomain, SprintResourceKind,
} from "./sprints";

// Artifacts (0030) are defined in shared/artifacts-rows.ts (the vocab unions come
// from the zod-free core) and re-exported here. Type-only.
export type { ArtifactPageRow, ArtifactVersionRow, ArtifactLinkRow, ArtifactUploadTokenRow } from "./artifacts-rows";

export interface SectionRow { name: string; description: string | null; }
export interface TagRow { tag: string; description: string | null; }

export interface DocRow {
  slug: string;
  section: string;
  title: string;
  body: string;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
  space: string;   // 'technical' | 'product' — the Docs tab this doc lives under (UI grouping, not access)
  /** A person handle: who proposed the doc's FIRST version (0035). Set at creation, never
   *  overwritten by later edits/promotions; renamed with the person. NULL only for a doc
   *  row with no version and no updated_by at backfill time. */
  owner: string | null;
}

/** A doc without its body — `GET /docs?fields=meta` (My Work's "Docs you own" cell). */
export type DocMetaRow = Pick<DocRow, "slug" | "section" | "title" | "current_version" | "updated_at" | "updated_by" | "space" | "owner">;

export interface DocVersionRow {
  id: number;
  slug: string;
  version: number;
  body: string;
  summary: string | null;
  // 'rejected' is set only by Phase 3's reject route; Phase 2 never sets it.
  status: "staged" | "promoted" | "rejected";
  confidence: string | null;
  created_at: string;
  created_by: string;
  content_hash: string | null;   // SHA-256 of body — the dedupe key (0009)
  base_version: number | null;   // the version this edit was based on (0009)
  change_kind: "new" | "edit" | "rewrite" | null; // server-classified delta size (0009)
  low_confidence: number;        // 1 = staged-and-flagged (low-conf on an existing slug) (0009)
}

export interface FeedRow {
  id: number;
  author: string;
  summary: string;
  brief: string | null;
  body: string | null;
  artifacts: string | null;
  created_at: string;
}

export interface AdrRow {
  id: number;
  title: string;
  context: string | null;
  decision: string | null;
  rationale: string | null;
  // 'rejected' is set only by Phase 3's reject route; Phase 2 never sets it.
  status: "draft" | "ratified" | "rejected";
  confidence: string | null;
  created_at: string;
  created_by: string;
  content_hash: string | null;   // SHA-256 of title+context+decision+rationale — dedupe key (0009)
}

export interface EntryTagRow {
  tag: string;
  entry_type: "doc" | "feed" | "adr";
  entry_id: string;
}

export interface NeedsTriageRow {
  id: number;
  raw: string;
  reason: string;
  source_author: string | null;
  resolved: number;
  created_at: string;
  // Phase 3 (0010) resolution audit. NULL until resolved; `resolved` flips to 1
  // when set. Soft only — a resolved item leaves the queue, it is never deleted.
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: "assigned" | "discarded" | null;
  assigned_ref: string | null;   // what an 'assigned' item materialized into (e.g. "doc:slug@2")
}

export const PERSON_COLORS = ["moss", "fern", "sky", "slate", "plum", "rose", "rust", "ochre", "clay", "stone"] as const;
export type PersonColor = (typeof PERSON_COLORS)[number];

// The root identity (0023). handle is chosen once at onboarding (migrated
// GitHub users keep their login). email is the notification address (0021 rule:
// never overwrites a user/admin-set value).
export interface PersonRow {
  handle: string;
  name: string | null;
  color: PersonColor;
  avatar_url: string | null;
  email: string | null;
  email_unsubscribed: number;
  created_at: string;
  onboarded_at: string;
  /** SHA-256 of an UPLOADED avatar (0036), bytes in R2 at `avatars/<sha>`. Outranks
   *  `avatar_url` — never read this pair directly for display; use `avatarSrc`. */
  avatar_sha: string | null;
  /** The provider `avatar_url` came from (0036 PART B): only a sign-in with it refreshes the picture. */
  avatar_source: IdentityProvider | null;
  role: string | null;             // 0036: a short title ("Backend engineer")
  responsibilities: string | null; // 0036: what they own — for agents and editors, never rendered
}

export type IdentityProvider = "github" | "google";

// One sign-in method attached to a person (0023). github.subject = login;
// google.subject = the stable `sub` claim. label is what a human sees.
export interface IdentityRow {
  provider: IdentityProvider;
  subject: string;
  label: string;
  person: string;
  linked_at: string;
  linked_by: string;
  /** The email the provider VERIFIED at this identity's last sign-in (0042_organizations) — what invites and the sign-in link match. */
  verified_email?: string | null;
  /** The provider account's immutable id where `subject` is not one — GitHub's numeric id (0042_organizations); NULL until its next sign-in. */
  provider_uid?: string | null;
}

// The Google gate (0023): only an invited, verified address may create a person.
export interface InviteRow {
  email: string;
  name: string | null;
  invited_by: string;
  invited_at: string;
  accepted_by: string | null;
  revoked_at: string | null;
  email_sent_at: string | null;
  email_id: string | null;
  email_error: string | null;
}

export interface SessionRow {
  id: string;
  person: string;
  created_at: string;
  expires_at: string;
}

export interface McpTokenRow {
  id: number;
  person: string;
  token_hash: string;
  token_hint: string | null; // 0026 — first characters of the random part; null before it
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

/** What Settings lists for a token: enough to recognise it, nothing to authenticate with. */
export interface McpTokenSummary {
  id: number;
  hint: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Settings › Connected apps: one OAuth connection (a grant). Never a token. A connection is made
 *  into ONE org (the consent page's choice, §7.1); `org` names it. */
export interface OAuthGrantSummary {
  id: number;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
  org: { slug: string; name: string };
}

// The replay ledger (0009). One row per (session_id, item_index) the worker has
// seen; a re-POST of the same payload hits every row and drops as unchanged.
export interface ProcessedItemRow {
  session_id: string;
  item_index: number;
  item_type: "feed" | "doc" | "adr" | "triage" | "event" | "handoff";
  outcome: string;        // the gate's verdict (written | staged | triaged | unchanged)
  ref: string | null;     // what it became (e.g. "slug@2", a feed/adr id)
  created_at: string;
}

// Captured GitHub event (0012). semantic_key is the dedupe identity.
export interface EventRow {
  id: number;
  semantic_key: string;
  event_type: "pr_merged" | "pr_closed" | "issue";
  ref_number: number;
  subject_login: string;
  raw: string;             // JSON snapshot slice — the truth
  provenance: "webhook" | "backfill";
  occurred_at: string | null;
  recorded_at: string;
  recorded_by: string;
}

// Worker-generated completed-PR summary (0012; structured fields 0018; the
// legacy prose `summary` column dropped in 0019 — PRs are structured-only).
// Derived, regenerable, never truth. Structured fields are NULL on excerpt-
// fallback rows (model='excerpt'), which carry no content and are retried by Sync.
export interface PrSummaryRow {
  semantic_key: string;
  pr_number: number;
  model: string | null;    // 'excerpt' = deterministic fallback
  created_at: string;
  title: string | null;    // humanized display title (0018)
  what: string | null;     // "What changed" (0018)
  why: string | null;      // motivation, only when the body states one (0018)
  impact: string | null;   // user-facing outcome sentence, never files (0018)
}

// Worker-generated summary of ONE assigned issue's own body (0017; structured
// fields 0018). Derived, regenerable, never truth — keyed by issue number (not
// semantic_key), since only the current summary matters across reassignments/
// edits. Structured fields NULL on prose-era and excerpt-fallback rows.
export interface IssueSummaryRow {
  issue_number: number;
  summary: string;
  model: string | null;      // 'excerpt' = deterministic fallback
  created_at: string;
  title: string | null;      // humanized display title (0018)
  next_step: string | null;  // only when the issue states/implies one (0018)
}

// Absolute per-sprint progress cache (added in 0012; the table and its key
// column were renamed in 0025). Event-derived GitHub issue counts ONLY — they
// are `SprintView.issues`, never `SprintView.progress`, which is the sprint's
// tickets counted at read time.
export interface SprintProgressRow {
  sprint_id: number;
  closed: number;
  total: number;
  source: "event" | "recompute";
  computed_at: string;
}

// Identity triage task (0016): one pending row per unknown GitHub login seen on
// a captured event. Raised by ingestEvent after the event write; resolved by the
// map-to-person route (the `people` table's only runtime writer). Soft resolve.
// `discarded` (no migration — status carries no CHECK) is a login that will never be
// a person; the row keeps the PK, so the login is never re-raised until restored.
export interface IdentityTaskRow {
  login: string;
  first_seen: string;
  status: "pending" | "resolved" | "discarded";
  resolved_at: string | null;
  resolved_by: string | null;
}

// The plan singleton (0012).
export interface PlanRow {
  org_id: string;
  narrative: string;
  current_version: number;
  updated_at: string | null;
  updated_by: string | null;
}

// Non-destructive plan snapshot (0012).
export interface PlanVersionRow {
  version: number;
  narrative: string;
  sprints_json: string;    // full sprints snapshot AFTER this write (SprintRow[])
  created_at: string;
  created_by: string;
}

// ── Email notifications (0021) ─────────────────────────────────────────────────

// Org-wide per-kind policy, seeded from the registry, admin-edited.
export interface NotificationPolicyRow {
  kind: string;
  default_cadence: "daily" | "weekly" | "off";
  enabled: number;                    // 0 = off for everyone; user layer not consulted
  updated_at: string;
  updated_by: string;
}

// The org-level schedule singleton (id = 1).
export interface NotificationSettingsRow {
  org_id: string;
  send_hour: number;
  timezone: string;
  from_address: string;
}

// Sparse per-user override; absence inherits.
export interface NotificationPrefRow {
  user_id: string;
  kind: string;
  cadence: "daily" | "weekly" | "off";
  updated_at: string;
}

// One row per (user, cadence, window) — the run idempotency ledger.
export interface NotificationOutboxRow {
  idempotency_key: string;            // org:user:cadence:window_id
  user_id: string;
  cadence: "daily" | "weekly";
  window_id: string;
  kinds: string;                      // JSON array of kind ids rendered
  status: "pending" | "sent" | "skipped" | "failed";
  resend_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}
