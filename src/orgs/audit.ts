// One `org_admin_audit` row. Its own leaf module so a small writer (src/orgs/logo.ts) records its change without
// importing ./repo.ts, which reaches the notifications cron and, through it, GitHub and the credential resolver.
import { type PlatformContext, type Stmt, nowIso, stmt } from "../data/platform-sql";
import type { OrgAuditAction } from "@shared/orgs";

/** One `org_admin_audit` row — always a statement in the SAME batch as the change it records. */
export function auditStmt(p: PlatformContext, orgId: string | null, action: OrgAuditAction, target: string, detail: Record<string, unknown> = {}, at: string = nowIso()): Stmt {
  return stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    orgId, p.actor, action, target, JSON.stringify(detail), at);
}
