// my_work — "Your brief" and "Also" (Phase E: the shorter e-mail, led by the brief; notifications.md › The digest's
// shape). A PURE READ, through the reads the app already has:
//
//   • YOUR BRIEF — the SAME stored brief My Work's `briefTile` shows (`storedBrief`, src/tools/mywork.ts: the
//     `DashboardData.brief` shape): its "Now" line and up to 3 "Next" items, each the item's own title linked, with
//     its one-line why — only a brief that is `ready`. EVERY missing brief (owner ruling Q42) — none stored, an empty
//     one, "Wrong?" on it, the org's switch off or no key (storedBrief's null), the allowance used up (`capped`), or
//     any other state that is not `ready` (a stale one) — falls back to the 3 most recently updated tickets assigned
//     to the person (`listAssignedTickets`, the read My Work uses), in plain words. A capped brief adds ONE footer
//     line, for an admin or owner only: why briefs are paused.
//   • ALSO (the daily only) — at most 3 notable or breaking items that touched the person's work in the window, as a
//     title and a link: their merged pull requests as My Work maps them (`toMyWorkPr`, Sift's `importance`), and feed
//     entries as the Feed reads them (`get_feed`: `importance`, and `ai.subject` on an entry Trov wrote for them).
//
// The section offers the mail's SUBJECT: the top Next item ("Netlify test failing, plus 1 more"), or the first
// assigned ticket with no brief. `needsMe` is what "Only when something needs me" asks (src/notifications/run.ts).
import { isFeedImportance, type AiBrief, type FeedImportance } from "@shared/ai";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import type { MyWorkTicket } from "@shared/dashboard";
import { type TenantContext, all, first, ph } from "../../data/sql";
import { planAndAiRuns } from "../../plans/gate";
import { planDef } from "@shared/plans";
import { countAssignedTickets, listAssignedTickets, storedBrief, toMyWorkPr, type PrEventJoinRow } from "../../tools/mywork";
import { get_feed } from "../../tools/reads";
import { memberGithubLogins, memberPerson } from "../../auth/persons";
import { escapeHtml, isoOf } from "../html";
import { EMAIL_STYLE as S, EMAIL_CARD as K, EMAIL_SPACE as SP, appHref } from "../assemble";

const DEEP_LINK = "/#mywork";
/** Next items the e-mail shows (the design: "up to 3"). */
export const BRIEF_NEXT_SHOWN = 3;
/** "Also" lines (the design: "at most 3"). */
export const ALSO_MAX = 3;
const SUBJECT_TITLE_MAX = 60;

const STATUS_WORDS: Record<MyWorkTicket["status"], string> = { in_progress: "In progress", testing: "In testing", submitted: "Not started" };

/** One Next row: the item's own title (linked) and one plain line under it; `overdue` draws My Work's "Overdue" word. */
export interface NextRow { title: string; href: string | null; line: string; overdue?: boolean }
/** One Also row. */
export interface AlsoRow { title: string; href: string; importance: Exclude<FeedImportance, "routine">; at: string }

export interface BriefContent {
  /** Where Next came from: the stored brief, or the assigned tickets (no brief to show). */
  source: "brief" | "assigned";
  now: string | null;
  next: NextRow[];
  /** How many Next items there are in all (the subject's "plus N more"). */
  nextTotal: number;
  also: AlsoRow[];
  /** The mail's one footer line about the brief (paused: the allowance is used up, or the plan ended) — set only for
   *  an admin or owner. */
  footnote?: string | null;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
/** A cite's link as an absolute one: an in-app route (`#tickets/14`) hangs off the org's app address. */
const linkOf = (href: string | null | undefined): string | null => (!href ? null : href.startsWith("#") ? appHref(href) : href);

/** The brief's content, or null when there is no brief WITH something to show (then the assigned tickets stand in):
 *  only a `ready` brief is shown — a capped, empty or stale one is a missing brief (Q42). */
function fromBrief(b: AiBrief | null): Omit<BriefContent, "also"> | null {
  if (!b || b.state !== "ready") return null;
  const items = b.next.items;
  if (!b.now && !items.length) return null;
  return {
    source: "brief",
    now: b.now?.text ?? null,
    next: items.slice(0, BRIEF_NEXT_SHOWN).map((i) => ({ title: i.title, href: linkOf(i.cites[0]?.href), line: i.why, ...(i.kind === "overdue" ? { overdue: true } : {}) })),
    nextTotal: items.length,
  };
}

async function fromAssigned(ctx: TenantContext, handle: string): Promise<Omit<BriefContent, "also">> {
  const tickets = await listAssignedTickets(ctx, handle, { sources: "all", limit: BRIEF_NEXT_SHOWN });
  const total = tickets.length ? await countAssignedTickets(ctx, handle, "all") : 0;
  return {
    source: "assigned",
    now: null,
    next: tickets.map((t) => ({
      title: t.title,
      href: appHref(`#tickets/${t.id}`),
      line: [STATUS_WORDS[t.status] ?? t.status, t.sprint ? `in the ${t.sprint.label} sprint` : null, t.priority === "high" ? "high priority" : null].filter(Boolean).join(", "),
    })),
    nextTotal: total,
  };
}

/** What touched the person's work in the window and Sift rated notable or breaking — newest breaking first. */
async function alsoFor(ctx: TenantContext, handle: string, window: Window): Promise<AlsoRow[]> {
  const logins = await memberGithubLogins(ctx, handle);
  const rows: AlsoRow[] = [];
  const mine = new Set<number>(); // the person's pull requests (merged), which an entry may name
  const listed = new Set<number>();
  if (logins.length) {
    const prs = await all<PrEventJoinRow>(ctx,
      `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact, s.importance AS s_importance
         FROM events e LEFT JOIN pr_summaries s ON s.semantic_key = e.semantic_key AND s.org_id = ?
        WHERE e.org_id = ? AND e.event_type = 'pr_merged' AND e.subject_login IN (${ph(logins.length)})
        ORDER BY COALESCE(e.occurred_at, e.recorded_at) DESC, e.id DESC LIMIT 200`,
      ctx.orgId, ctx.orgId, ...logins);
    for (const r of prs) {
      let pr;
      try { pr = toMyWorkPr(r); } catch { continue; }
      mine.add(pr.number);
      const at = Date.parse(pr.occurredAt);
      if (!(at >= window.start.getTime() && at < window.end.getTime())) continue;
      if (pr.importance !== "notable" && pr.importance !== "breaking") continue;
      listed.add(pr.number);
      rows.push({ title: pr.displayTitle ?? pr.title, href: pr.url, importance: pr.importance, at: pr.occurredAt });
    }
  }
  const feed = await get_feed(ctx, { since: isoOf(window.start), limit: 200 });
  for (const f of feed) {
    if (!(Date.parse(f.created_at) < window.end.getTime())) continue;
    if (!isFeedImportance(f.importance) || f.importance === "routine") continue;
    let prs: number[] = [];
    try { prs = ((JSON.parse(f.artifacts ?? "{}") as { prs?: unknown[] }).prs ?? []).map((x) => Number(x)).filter(Number.isFinite); } catch { /* no artifacts */ }
    const yours = f.author.toLowerCase() === handle.toLowerCase() || f.ai?.subject?.toLowerCase() === handle.toLowerCase() || prs.some((n) => mine.has(n));
    if (!yours) continue;
    if (prs.length && prs.every((n) => listed.has(n))) continue; // the pull request is already a line
    rows.push({ title: f.summary, href: appHref("#feed"), importance: f.importance, at: f.created_at });
  }
  const rank = (r: AlsoRow) => (r.importance === "breaking" ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || Date.parse(b.at) - Date.parse(a.at)).slice(0, ALSO_MAX);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 1" from `2026-11-01`. */
const shortDay = (iso: string): string => { const [, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };

/** Why a capped brief is paused — the mail's one footer line, for an admin or owner (Q42); null for anyone else. */
async function pausedNote(ctx: TenantContext, handle: string, brief: AiBrief, now: Date): Promise<string | null> {
  const m = await first<{ role: string }>(ctx, `SELECT role FROM memberships WHERE org_id = ? AND user_id = ? COLLATE NOCASE`, ctx.orgId, handle);
  if (m?.role !== "owner" && m?.role !== "admin") return null;
  const { plan } = await planAndAiRuns(ctx, now);
  if (plan.status === "canceled") return `Your brief is paused: this organization's ${planDef(plan.plan).name} plan has ended, so Trov's AI is paused until it is renewed (Org settings › General).`;
  return `Your brief is paused: this organization has used this month's AI allowance${brief.resumesOn ? `; it resumes ${shortDay(brief.resumesOn)}` : ""} (Org settings › AI).`;
}

/** The section's content for one person and window, or null (not a member). Pure read. */
export async function briefContent(ctx: TenantContext, handle: string, window: Window): Promise<BriefContent | null> {
  const me = await memberPerson(ctx, handle);
  if (!me) return null;
  const brief = await storedBrief(ctx, me.handle, window.end).catch(() => null);
  const head = fromBrief(brief) ?? (await fromAssigned(ctx, me.handle));
  const also = window.cadence === "daily" ? await alsoFor(ctx, me.handle, window) : [];
  const footnote = brief?.state === "capped" ? await pausedNote(ctx, me.handle, brief, window.end) : null;
  return { ...head, also, footnote };
}

/** "Only when something needs me": the brief has a Next item, or a notable or breaking item touched their work. */
export async function needsMe(ctx: TenantContext, handle: string, window: Window): Promise<boolean> {
  const c = await briefContent(ctx, handle, { ...window, cadence: "daily" }); // the Also read, whatever the cadence
  return !!c && (c.next.length > 0 || c.also.length > 0);
}

/** "Netlify test failing, plus 1 more" — the top Next item, or null. */
export function briefSubject(c: Pick<BriefContent, "next" | "nextTotal">): string | null {
  const top = c.next[0];
  if (!top) return null;
  const more = Math.max(0, c.nextTotal - 1);
  return `${clip(top.title, SUBJECT_TITLE_MAX)}${more ? `, plus ${more} more` : ""}`;
}

const LABEL = (t: string, first: boolean) => `<div style="${S.label}padding-top:${first ? SP.m : SP.l}px;padding-bottom:${SP.xs}px;">${t}</div>`;
const linked = (title: string, href: string | null) =>
  href ? `<a href="${escapeHtml(href)}" style="${S.link}font-weight:600;">${escapeHtml(title)}</a>` : `<span style="font-weight:600;">${escapeHtml(title)}</span>`;

export function renderBrief(c: BriefContent): Section | null {
  if (!c.now && !c.next.length && !c.also.length) return null;
  const html: string[] = [];
  const text: string[] = [];
  const hasBrief = !!c.now || c.next.length > 0;
  if (c.now) {
    html.push(`<div data-brief-now style="${S.body}padding-top:${SP.m}px;">${K.prose(escapeHtml(c.now))}</div>`);
    text.push(`  ${c.now}`, "");
  }
  if (c.next.length) {
    html.push(LABEL(c.source === "brief" ? "NEXT" : "ASSIGNED TO YOU", !c.now));
    html.push(`<table data-brief-next ${S.table}>` + c.next.map((n) =>
      `<tr><td style="${S.body}">${linked(n.title, n.href)}${n.overdue ? `<span style="padding-left:10px;">${K.mark("Overdue", "amber")}</span>` : ""}<div style="${S.muted}">${escapeHtml(n.line)}</div></td></tr>`).join("") + `</table>`);
    text.push(c.source === "brief" ? "  NEXT" : "  ASSIGNED TO YOU");
    for (const n of c.next) text.push(`  - ${n.title}${n.overdue ? " (Overdue)" : ""}${n.href ? ` <${n.href}>` : ""}`, `    ${n.line}`);
  }
  if (c.also.length) {
    // With no brief the section's own heading is "Also" (below): no second label under it.
    if (hasBrief) html.push(LABEL("ALSO", false));
    html.push(`${hasBrief ? "" : `<div style="padding-top:${SP.m}px;">`}<table data-brief-also ${S.table}>` + c.also.map((a) =>
      `<tr><td style="${S.body}"><a href="${escapeHtml(a.href)}" style="${S.link}">${escapeHtml(a.title)}</a><span style="padding-left:10px;">${K.mark(a.importance === "breaking" ? "Breaking" : "Notable", a.importance === "breaking" ? "amber" : "accent")}</span></td></tr>`).join("") + `</table>${hasBrief ? "" : "</div>"}`);
    if (text.length) text.push("");
    if (hasBrief) text.push("  ALSO");
    for (const a of c.also) text.push(`  - ${a.title} (${a.importance}) <${a.href}>`);
  }
  const subject = briefSubject(c);
  return {
    ...(c.footnote ? { footnote: c.footnote } : {}),
    heading: hasBrief ? "Your brief" : "Also",
    summary: subject ?? undefined,
    html: html.join(""),
    text: text.join("\n"),
    deepLink: DEEP_LINK,
    linkLabel: "My Work",
    ...(subject ? { subject } : {}),
  };
}

async function render(ctx: TenantContext, handle: string, window: Window): Promise<Section | null> {
  const c = await briefContent(ctx, handle, window);
  return c ? renderBrief(c) : null;
}

export const myWorkKind: NotificationKind<TenantContext> = {
  id: "my_work",
  label: "Your brief",
  description: "Your brief from My Work: what you are in the middle of and what is next.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
