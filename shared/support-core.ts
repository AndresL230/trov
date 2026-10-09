// The ZOD-FREE core of the support contract (the *-core.ts rule: the SPA imports VALUES from here and
// never drags zod in; `shared/support.ts` builds the request schema on top and re-exports all of it).
//
// A support report is what a signed-in person sends from Help › Report a bug / Contact support
// (docs/architecture/support.md): a kind, a subject, a message, and FOUR things attached
// automatically and shown to them before they send — the screen they were on, the organization they
// were in, the app's version and the browser's user agent. Nothing else is captured: no page
// content, no organization data. It is read by the platform's operator (a superadmin) in
// Platform › Support and mailed to `SUPPORT_NOTIFY_EMAIL`.

// ── vocabulary (must match the CHECK constraints in migrations/0049_support_reports.sql) ──
export const SUPPORT_KINDS = ["bug", "question", "feedback"] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];
export const SUPPORT_STATUSES = ["open", "resolved"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
/** What became of the mail to the operator. `skipped` = no recipient is configured: stored, not mailed. */
export const SUPPORT_MAIL_STATUSES = ["sent", "failed", "skipped"] as const;
export type SupportMailStatus = (typeof SUPPORT_MAIL_STATUSES)[number];

export const isSupportKind = (v: unknown): v is SupportKind => (SUPPORT_KINDS as readonly unknown[]).includes(v);
export const isSupportStatus = (v: unknown): v is SupportStatus => (SUPPORT_STATUSES as readonly unknown[]).includes(v);

/** The switch's words, and the table's. */
export const SUPPORT_KIND_LABEL: Record<SupportKind, string> = { bug: "Bug", question: "Question", feedback: "Feedback" };

// ── caps (enforced by the Worker; the form's `maxlength`s are the same numbers) ──
export const SUPPORT_SUBJECT_MAX = 140;
export const SUPPORT_MESSAGE_MAX = 5000;
/** The attached context is cut to these, never refused: a long hash or user agent must not cost a report. */
export const SUPPORT_ROUTE_MAX = 300;
export const SUPPORT_VERSION_MAX = 32;
export const SUPPORT_USER_AGENT_MAX = 400;

/** The list's page size, and the most one request may ask for. */
export const SUPPORT_PAGE = 50;
export const SUPPORT_PAGE_MAX = 100;

/** The subject a report with none is filed under: the message's first line, cut at a word. */
export function supportSubjectFrom(message: string): string {
  const line = (message.trim().split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= SUPPORT_SUBJECT_MAX) return line;
  const cut = line.slice(0, SUPPORT_SUBJECT_MAX - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > 40 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** The mail's subject, and the prefilled subject of a reply: `[Trov bug] <subject>`. */
export const supportMailSubject = (kind: SupportKind, subject: string): string => `[Trov ${kind}] ${subject}`;

// ── wire shapes ──────────────────────────────────────────────────────────────
/** `POST /api/support`. The author is the session's person: nothing here names one. */
export interface SupportSubmitBody {
  kind: SupportKind;
  /** Optional: a report without one is filed under its message's first line. */
  subject?: string;
  message: string;
  /** The four attached values, exactly as the dialog showed them. */
  route?: string | null;
  /** The org the person was in (its slug). Kept only if they are a member of it. */
  org?: string | null;
  app_version?: string | null;
  user_agent?: string | null;
}

export interface SupportSubmitResponse {
  ok: true;
  id: number;
  /** Where a reply will go: the person's provider-verified address, or null when no provider gave one. */
  reply_to: string | null;
}

/** One report as Platform › Support shows it. It holds what the reporter typed plus the slug and the
 *  route — never anything read from the organization. */
export interface SupportReport {
  id: number;
  kind: SupportKind;
  subject: string;
  message: string;
  reporter: { handle: string; name: string | null; email: string | null };
  /** Null when it was sent from outside any organization. `name` is null if the org is gone. */
  org: { slug: string; name: string | null } | null;
  route: string | null;
  app_version: string | null;
  user_agent: string | null;
  status: SupportStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  mail: { status: SupportMailStatus | null; at: string | null; error: string | null };
}

export type SupportStatusFilter = SupportStatus | "all";
export type SupportKindFilter = SupportKind | "all";

/** `GET /api/platform/support`: newest first. `next_before` continues the list (`?before=`), or null at its end. */
export interface SupportListResponse {
  reports: SupportReport[];
  next_before: number | null;
  /** Every OPEN report, whatever the filter — the tab's count. */
  open: number;
}
