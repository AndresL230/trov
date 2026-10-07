import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type TenantContext, all } from "../../data/sql";
import { listOpenAssignedIssues, toMyWorkPr, type PrEventJoinRow } from "../../tools/mywork";
import { memberPerson, memberGithubLogins } from "../../auth/persons";
import { escapeHtml, isoOf } from "../html";
import { EMAIL_STYLE as S, EMAIL_CARD as K, EMAIL_SPACE as SP } from "../assemble";

const DEEP_LINK = "/#mywork";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pad = (s: string, w: number) => s.padEnd(w);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 20" from a date-only or ISO string; empty when unparseable. */
function shortDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}
const TOP = 5;

/** A merged PR item, mirroring the app's prActivityCard: #number, title, What changed / Why / Impact rows, MERGED chip. */
function prItem(pr: ReturnType<typeof toMyWorkPr>, first: boolean): string {
  const rows: string[] = [];
  if (pr.what !== null) {
    rows.push(K.row("What changed", K.prose(escapeHtml(pr.what))));
    if (pr.why) rows.push(K.row("Why", K.prose(escapeHtml(pr.why))));
  } else {
    rows.push(K.row("What changed", "No summary recorded for this PR."));
  }
  if (pr.impact) rows.push(K.row("Impact", K.prose(escapeHtml(pr.impact))));
  const into = pr.baseRef ? `<span style="padding-left:8px;">into <span style="font-family:'Archivo Narrow',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${escapeHtml(pr.baseRef)}</span></span>` : "";
  return K.item({ title: escapeHtml(pr.displayTitle ?? pr.title), number: pr.number, url: escapeHtml(pr.url), rows, footer: `${K.chip("MERGED", "green")}${into}`, first });
}

/** An assigned-issue item, mirroring todoCard: Summary / Sprint / Next step rows, priority + label chips. */
function issueItem(i: Awaited<ReturnType<typeof listOpenAssignedIssues>>[number], first: boolean): string {
  const rows: string[] = [];
  if (i.summary) rows.push(K.row("Summary", K.prose(escapeHtml(i.summary))));
  if (i.sprint) {
    const due = i.sprint.dueOn ? ` <span style="font-size:11.5px;">&middot; due ${escapeHtml(shortDate(i.sprint.dueOn))}</span>` : "";
    rows.push(K.row("Sprint", `${escapeHtml(i.sprint.title)}${due}`));
  }
  if (i.nextStep) rows.push(K.row("Next step", K.prose(escapeHtml(i.nextStep)), "accent"));
  const chips = [
    i.priority ? K.chip(escapeHtml(i.priority), "amber") : "",
    ...i.labels.slice(0, 3).map((l) => K.chip(escapeHtml(l), "muted")),
  ].filter(Boolean).join(" ");
  return K.item({ title: escapeHtml(i.displayTitle ?? i.title), number: i.number, url: escapeHtml(i.url), rows, footer: chips || undefined, first });
}

/**
 * my_work — the event spine, scoped to the window: merged PRs whose occurred_at
 * falls in [start, end), summarized exactly as My Work does (same join, same
 * mapping), plus the user's open assigned issues (not windowed — it is their
 * plate). Same identity gate as the dashboard: an unknown handle, or one with
 * no GitHub identity, renders null.
 */
async function render(ctx: TenantContext, handle: string, window: Window): Promise<Section | null> {
  const me = await memberPerson(ctx, handle);
  if (!me) return null;
  const logins = await memberGithubLogins(ctx, me.handle);
  if (logins.length === 0) return null;

  const prRows = await all<PrEventJoinRow>(
    ctx,
    `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact
       FROM events e
       LEFT JOIN pr_summaries s ON s.semantic_key = e.semantic_key AND s.org_id = ?
      WHERE e.org_id = ?
        AND e.event_type = 'pr_merged'
        AND e.subject_login IN (${logins.map(() => "?").join(",")})
        AND datetime(e.occurred_at) >= datetime(?)
        AND datetime(e.occurred_at) <  datetime(?)
      ORDER BY e.occurred_at DESC, e.id DESC`,
    ctx.orgId,
    ctx.orgId,
    ...logins,
    isoOf(window.start),
    isoOf(window.end)
  );
  const merged = prRows.map(toMyWorkPr);
  const todo = await listOpenAssignedIssues(ctx, logins);
  if (merged.length === 0 && todo.length === 0) return null;

  const html: string[] = [];
  const text: string[] = [];
  if (merged.length) {
    const shown = merged.slice(0, TOP);
    html.push(`<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">MERGED</div>`);
    html.push(shown.map((pr, i) => prItem(pr, i === 0)).join(""));
    if (merged.length > TOP) html.push(`<div style="${S.muted}padding-top:${SP.s}px;">+${merged.length - TOP} more in My Work</div>`);
    for (const pr of shown) {
      text.push(`  ${pad("merged", 7)} ${pad(`#${pr.number}`, 5)} ${pr.displayTitle ?? pr.title}`);
      if (pr.what) text.push(`  ${pad("", 13)} What changed: ${pr.what}`);
    }
    if (merged.length > TOP) text.push(`  ${pad("", 13)} +${merged.length - TOP} more in My Work`);
  }
  if (todo.length) {
    html.push(`<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">OPEN &amp; ASSIGNED</div>`);
    html.push(todo.map((t, i) => issueItem(t, i === 0)).join(""));
    for (const i of todo) {
      text.push(`  ${pad("open", 7)} ${pad(`#${i.number}`, 5)} ${i.priority ? `[${i.priority}] ` : ""}${i.displayTitle ?? i.title}`);
      if (i.nextStep) text.push(`  ${pad("", 13)} Next step: ${i.nextStep}`);
    }
  }

  const summary = [
    merged.length ? `${plural(merged.length, "PR", "PRs")} merged` : null,
    todo.length ? `${plural(todo.length, "assigned issue", "assigned issues")} open` : null,
  ].filter(Boolean).join(" · ");

  return { heading: "My Work", summary, html: html.join(""), text: text.join("\n"), deepLink: DEEP_LINK, linkLabel: "My Work" };
}

export const myWorkKind: NotificationKind<TenantContext> = {
  id: "my_work",
  label: "My Work",
  description: "Your merged PRs and the issues assigned to you.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
