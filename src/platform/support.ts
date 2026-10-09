// Support reports (0049_support_reports; docs/architecture/support.md): the repository. A GLOBAL table,
// so every statement here is a platform statement — and none names a tenant table: a report holds what
// its reporter typed plus the slug and route the form showed them, and reading one reads nothing of
// the organization it was sent from (a superadmin has no access to an org's content).
import { type PlatformContext, all, first, run, nowIso } from "../data/platform-sql";
import {
  SUPPORT_PAGE, SUPPORT_PAGE_MAX,
  type SupportKind, type SupportKindFilter, type SupportListResponse, type SupportMailStatus, type SupportReport,
  type SupportStatus, type SupportStatusFilter,
} from "@shared/support";

/** Who a report is from: the session's person, or — signed out — the address typed (unverified). Exactly one. */
export type ReportSender = { handle: string } | { contactEmail: string };

export interface NewReport {
  from: ReportSender;
  kind: SupportKind;
  subject: string;
  message: string;
  /** The org it was sent from — only ever one the reporter is a member of (the route checks). */
  org: { id: string; slug: string } | null;
  route: string | null;
  appVersion: string | null;
  userAgent: string | null;
}

/** File one report. `from` is decided by the ROUTE — the authenticated principal, or for a request with
 *  no session the address it typed — never read from a body field that names an author. */
export async function createReport(p: PlatformContext, r: NewReport): Promise<{ id: number; created_at: string }> {
  const at = nowIso();
  const res = await run(p,
    `INSERT INTO support_reports (kind, subject, message, reporter, contact_email, from_org, from_org_slug, route, app_version, user_agent, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    r.kind, r.subject, r.message, "handle" in r.from ? r.from.handle : null, "contactEmail" in r.from ? r.from.contactEmail : null,
    r.org?.id ?? null, r.org?.slug ?? null, r.route, r.appVersion, r.userAgent, at);
  return { id: res.meta.last_row_id, created_at: at };
}

/** Record what became of the mail to the operator. `error` is already scrubbed and cut by the sender. */
export async function recordReportMail(p: PlatformContext, id: number, o: { status: SupportMailStatus; at: string; error: string | null }): Promise<void> {
  await run(p, `UPDATE support_reports SET mail_status = ?, mail_at = ?, mail_error = ? WHERE id = ?`, o.status, o.at, o.error, id);
}

interface Row {
  id: number; kind: SupportKind; subject: string; message: string; reporter: string | null; contact_email: string | null; reporter_name: string | null; reporter_email: string | null;
  from_org_slug: string | null; org_name: string | null; route: string | null; app_version: string | null; user_agent: string | null;
  status: SupportStatus; resolved_by: string | null; resolved_at: string | null; created_at: string;
  mail_status: SupportMailStatus | null; mail_at: string | null; mail_error: string | null;
}

// The reporter's name and newest provider-VERIFIED address (never the editable notification address —
// abuse-limits.md), and the name of the org it was sent from: all three are global rows.
const SELECT = `SELECT s.id, s.kind, s.subject, s.message, s.reporter, s.contact_email, pe.name AS reporter_name,
    (SELECT d.verified_email FROM identities d WHERE d.person = s.reporter COLLATE NOCASE AND d.verified_email IS NOT NULL ORDER BY d.linked_at DESC LIMIT 1) AS reporter_email,
    s.from_org_slug, o.name AS org_name, s.route, s.app_version, s.user_agent, s.status, s.resolved_by, s.resolved_at, s.created_at,
    s.mail_status, s.mail_at, s.mail_error
  FROM support_reports s
  LEFT JOIN persons pe ON pe.handle = s.reporter COLLATE NOCASE
  LEFT JOIN orgs o ON o.id = s.from_org`;

const view = (r: Row): SupportReport => ({
  id: r.id, kind: r.kind, subject: r.subject, message: r.message,
  reporter: r.reporter === null ? null : { handle: r.reporter, name: r.reporter_name, email: r.reporter_email },
  contact_email: r.reporter === null ? r.contact_email : null,
  org: r.from_org_slug ? { slug: r.from_org_slug, name: r.org_name } : null,
  route: r.route, app_version: r.app_version, user_agent: r.user_agent,
  status: r.status, resolved_by: r.resolved_by, resolved_at: r.resolved_at, created_at: r.created_at,
  mail: { status: r.mail_status, at: r.mail_at, error: r.mail_error },
});

export interface ReportQuery { status?: SupportStatusFilter; kind?: SupportKindFilter; before?: number | null; limit?: number }

/** Newest first, filtered, one page at a time (`before` = the last id of the page above). */
export async function listReports(p: PlatformContext, q: ReportQuery = {}): Promise<SupportListResponse> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? SUPPORT_PAGE) || SUPPORT_PAGE), SUPPORT_PAGE_MAX);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status && q.status !== "all") { where.push("s.status = ?"); params.push(q.status); }
  if (q.kind && q.kind !== "all") { where.push("s.kind = ?"); params.push(q.kind); }
  if (q.before) { where.push("s.id < ?"); params.push(q.before); }
  const [page, open] = await Promise.all([
    all<Row>(p, `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY s.id DESC LIMIT ?`, ...params, limit + 1),
    openReportCount(p),
  ]);
  const more = page.length > limit;
  const rows = more ? page.slice(0, limit) : page;
  return { reports: rows.map(view), next_before: more ? rows[rows.length - 1].id : null, open };
}

export async function openReportCount(p: PlatformContext): Promise<number> {
  return (await first<{ n: number }>(p, `SELECT COUNT(*) AS n FROM support_reports WHERE status = 'open'`))?.n ?? 0;
}

export async function getReport(p: PlatformContext, id: number): Promise<SupportReport | null> {
  const row = await first<Row>(p, `${SELECT} WHERE s.id = ?`, id);
  return row ? view(row) : null;
}

/** Resolve or reopen. Resolving stamps who and when (`p.actor`); reopening clears both. Null = no such report. */
export async function setReportStatus(p: PlatformContext, id: number, status: SupportStatus): Promise<SupportReport | null> {
  if (status === "resolved") {
    // An already-resolved report keeps its first resolver and time.
    await run(p, `UPDATE support_reports SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'`, p.actor, nowIso(), id);
  } else {
    await run(p, `UPDATE support_reports SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?`, id);
  }
  return getReport(p, id);
}
