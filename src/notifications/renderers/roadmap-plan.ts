import type { NotificationKind, Section, Window } from "@shared/notifications";
import { sprintDueState } from "@shared/sprints-core";
import { type TenantContext, all } from "../../data/sql";
import { queueLine } from "../assemble";

const DEEP_LINK = "/#roadmap";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface SprintLineRow { id: number; title: string; target_date: string | null; mine: number; done: number; total: number }

/** "due Fri" (within the week), "due today", "due Sep 18", "3 days late"; null with no (or an unreadable) due date. */
export function dueWords(due: string | null, now: Date): string | null {
  const s = sprintDueState(due, now);
  const m = due?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!s || !m) return null;
  if (s.overdue) return `${s.daysLate} ${s.daysLate === 1 ? "day" : "days"} late`;
  if (s.daysLeft === 0) return "due today";
  if (s.daysLeft <= 6) return `due ${WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]}`;
  return `due ${MONTHS[+m[2] - 1]} ${+m[3]}`;
}

/**
 * roadmap_plan — ONE line (Phase E): "Sprint: Hosting, due Fri, 2 of 5 done". The sprint in progress the person has
 * tickets in (else the org's sprint in progress due soonest): its name, when it is due ("due Fri" within the week,
 * "due Nov 2" past it, "3 days late" when overdue), and how many of its tickets a person marked done (declined ones do
 * not count). It rides EVERY daily whatever this kind's cadence (owner ruling Q45, `selectKinds`); the cadence
 * governs the weekly. The full plan diff it used to mail is gone. Null with no sprint in progress. Pure read.
 */
async function render(ctx: TenantContext, handle: string, window: Window): Promise<Section | null> {
  const rows = await all<SprintLineRow>(ctx,
    `SELECT s.id, s.title, s.target_date,
            EXISTS (SELECT 1 FROM tickets t JOIN ticket_assignees a ON a.ticket_id = t.id AND a.org_id = t.org_id
                     WHERE t.org_id = s.org_id AND t.sprint_id = s.id AND a.login = ? COLLATE NOCASE) AS mine,
            (SELECT COUNT(*) FROM tickets t WHERE t.org_id = s.org_id AND t.sprint_id = s.id AND t.status = 'done') AS done,
            (SELECT COUNT(*) FROM tickets t WHERE t.org_id = s.org_id AND t.sprint_id = s.id AND t.status != 'declined') AS total
       FROM sprints s WHERE s.org_id = ? AND s.status = 'in_progress'
      ORDER BY mine DESC, s.target_date IS NULL, s.target_date ASC, s.id ASC LIMIT 1`,
    handle, ctx.orgId);
  const s = rows[0];
  if (!s) return null;
  const parts = [s.title, dueWords(s.target_date, window.end), s.total > 0 ? `${s.done} of ${s.total} done` : null].filter(Boolean);
  return queueLine({ label: "Sprint", rest: parts.join(", "), deepLink: DEEP_LINK, linkLabel: "Roadmap" });
}

export const roadmapPlanKind: NotificationKind<TenantContext> = {
  id: "roadmap_plan",
  label: "Sprint",
  description: "One line: the sprint in progress, when it is due and how much is done. It is in every daily digest; Weekly adds it to the weekly one.",
  defaultCadence: "weekly",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
