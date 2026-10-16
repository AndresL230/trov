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
//   • ALSO (the daily only; owner ruling Q43) — at most 3 notable or breaking items since the person's last send that
//     touch their work: a ticket they are assigned to or requested, a pull request they authored, a repository they
//     pushed to in the last 14 days. Merged pull requests as My Work maps them (`toMyWorkPr`, Sift's `importance`) and
//     feed entries as the Feed reads them (`get_feed`: `importance`). Breaking first, then newest; each links into Trov.
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

/** "Also" looks back to the person's last daily digest sent in this org (a test send is not one) — else the window's
 *  start — and never further than this. */
export const ALSO_LOOKBACK_DAYS = 14;
/** A repository the person pushed to in this many days is part of their work. */
export const PUSHED_DAYS = 14;
const DAY_MS = 86_400_000;

/** Since when "Also" looks (owner ruling Q43): the person's last SENT daily digest in this org, else the window's
 *  start; at most `ALSO_LOOKBACK_DAYS` back, never after the window's end. */
async function alsoSince(ctx: TenantContext, handle: string, window: Window): Promise<number> {
  const r = await first<{ at: string | null }>(ctx,
    `SELECT MAX(sent_at) AS at FROM notification_outbox
      WHERE org_id = ? AND user_id = ? COLLATE NOCASE AND cadence = 'daily' AND status = 'sent' AND window_id NOT LIKE '%(test)'`,
    ctx.orgId, handle);
  const last = r?.at ? Date.parse(r.at) : NaN;
  const since = Number.isFinite(last) && last < window.end.getTime() ? last : window.start.getTime();
  return Math.max(since, window.end.getTime() - ALSO_LOOKBACK_DAYS * DAY_MS);
}

/** A GitHub pull request's address, as a key (`ticket_links` and the PR's `html_url` agree on it). */
const prKey = (url: string | null | undefined): string => (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
/** The repository a pull request belongs to, from its address (`owner/name`, lowercased) — the captured event's own
 *  `repo` column is not filled per repository, its `html_url` is. */
const repoOfPr = (url: string | null | undefined): string | null => prKey(url).match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1] ?? null;
/** A feed entry's PR reference ("#173", "173", "owner/repo#173") → its number and, when named, its repository. */
function prRef(x: unknown): { n: number; repo: string | null } | null {
  const m = String(x).trim().match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/);
  return m ? { n: Number(m[2]), repo: m[1] ?? null } : null;
}

/**
 * "Also" (owner ruling Q43): at most 3 items Sift rated notable or breaking since the last send that touch the person's
 * work — a ticket they are assigned to or requested, a pull request they authored, or a repository they pushed to in
 * the last 14 days. Breaking first, then newest. Each links INTO Trov, never to GitHub: their own pull request to My
 * Work, one on their ticket to that ticket, one in their repository to its Repo dashboard, a feed entry to the Feed.
 * Ratings made while the AI switch was on still count with it off (they are stored facts; nothing new is sent).
 */
async function alsoFor(ctx: TenantContext, handle: string, window: Window): Promise<AlsoRow[]> {
  const since = await alsoSince(ctx, handle, window);
  const end = window.end.getTime();
  const logins = await memberGithubLogins(ctx, handle);
  const lower = new Set(logins.map((l) => l.toLowerCase()));

  // Their repositories: pushed to in the last PUSHED_DAYS days.
  const repos = new Set<string>();
  if (logins.length) {
    const rows = await all<{ repo: string }>(ctx,
      `SELECT DISTINCT repo FROM repo_events
        WHERE org_id = ? AND kind = 'push' AND lower(actor_login) IN (${ph(logins.length)}) AND occurred_at >= ? AND occurred_at < ?`,
      ctx.orgId, ...[...lower], isoOf(new Date(end - PUSHED_DAYS * DAY_MS)), isoOf(window.end));
    for (const r of rows) repos.add(r.repo.toLowerCase());
  }

  // Their tickets: assigned to them, or requested by them — the pull requests linked to each, and a mirrored one's issue.
  const tickets = await all<{ id: number; number: number | null; source_ref: string | null }>(ctx,
    `SELECT t.id, t.number, t.source_ref FROM tickets t
      WHERE t.org_id = ? AND (t.requester = ? COLLATE NOCASE
        OR EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.org_id = t.org_id AND a.ticket_id = t.id AND a.login = ? COLLATE NOCASE))`,
    ctx.orgId, handle, handle);
  const ticketOfPr = new Map<string, number>(); // PR address → the ticket's number
  const ticketOfIssue = new Map<number, number>(); // issue number → the ticket's number
  if (tickets.length) {
    const byId = new Map(tickets.map((t) => [t.id, t.number ?? t.id]));
    for (const t of tickets) {
      const m = t.source_ref?.match(/#(\d+)$/);
      if (m) ticketOfIssue.set(Number(m[1]), byId.get(t.id)!);
    }
    const links = await all<{ ticket_id: number; url: string }>(ctx,
      `SELECT ticket_id, url FROM ticket_links WHERE org_id = ? AND kind = 'github' AND ticket_id IN (${ph(tickets.length)})`,
      ctx.orgId, ...tickets.map((t) => t.id));
    for (const l of links) if (/\/pull\/\d+/.test(l.url)) ticketOfPr.set(prKey(l.url), byId.get(l.ticket_id)!);
  }

  // Merged pull requests rated notable or breaking since the last send; and every PR's number → author, repository.
  const prs = await all<PrEventJoinRow>(ctx,
    `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact, s.importance AS s_importance
       FROM events e JOIN pr_summaries s ON s.semantic_key = e.semantic_key AND s.org_id = e.org_id
      WHERE e.org_id = ? AND e.event_type = 'pr_merged' AND s.importance IN ('notable', 'breaking')
        AND COALESCE(e.occurred_at, e.recorded_at) >= ? AND COALESCE(e.occurred_at, e.recorded_at) < ?
      ORDER BY COALESCE(e.occurred_at, e.recorded_at) DESC, e.id DESC LIMIT 200`,
    ctx.orgId, isoOf(new Date(since)), isoOf(window.end));
  const rows: AlsoRow[] = [];
  const listed = new Set<number>();
  for (const r of prs) {
    let pr;
    try { pr = toMyWorkPr(r); } catch { continue; }
    if (pr.importance !== "notable" && pr.importance !== "breaking") continue;
    const ticket = ticketOfPr.get(prKey(pr.url));
    const repo = repoOfPr(pr.url);
    const href = lower.has(r.subject_login.toLowerCase()) ? appHref("#mywork")
      : ticket !== undefined ? appHref(`#tickets/${ticket}`)
      : repo && repos.has(repo) ? appHref(`#repo?repo=${encodeURIComponent(pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull/i)![1])}`)
      : null;
    if (!href) continue;
    listed.add(pr.number);
    rows.push({ title: pr.displayTitle ?? pr.title, href, importance: pr.importance, at: pr.occurredAt });
  }

  // Feed entries rated notable or breaking since the last send, that name one of those — or were written about a
  // burst of work in one of their repositories (a Trov session digest's `ai_sessions.repo`).
  const feed = (await get_feed(ctx, { since: isoOf(new Date(since)), limit: 200 }))
    .filter((f) => Date.parse(f.created_at) < end && isFeedImportance(f.importance) && f.importance !== "routine");
  if (feed.length) {
    const refs = new Map<number, { prs: { n: number; repo: string | null }[]; issues: number[] }>();
    for (const f of feed) {
      let a: { prs?: unknown[]; issues?: unknown[] } = {};
      try { a = JSON.parse(f.artifacts ?? "{}") as typeof a; } catch { /* no artifacts */ }
      refs.set(f.id, {
        prs: (a.prs ?? []).map(prRef).filter((x): x is NonNullable<typeof x> => !!x),
        issues: (a.issues ?? []).map(Number).filter(Number.isFinite),
      });
    }
    const numbers = [...new Set([...refs.values()].flatMap((r) => r.prs.map((p) => p.n)))];
    const prInfo = new Map<number, { authors: Set<string>; repos: Set<string>; urls: Set<string> }>();
    if (numbers.length) {
      const named = await all<{ ref_number: number; subject_login: string; raw: string }>(ctx,
        `SELECT ref_number, subject_login, raw FROM events WHERE org_id = ? AND event_type IN ('pr_merged', 'pr_closed') AND ref_number IN (${ph(numbers.length)})`,
        ctx.orgId, ...numbers);
      for (const e of named) {
        const i = prInfo.get(e.ref_number) ?? { authors: new Set<string>(), repos: new Set<string>(), urls: new Set<string>() };
        i.authors.add(e.subject_login.toLowerCase());
        let url: string | undefined;
        try { url = (JSON.parse(e.raw) as { pr?: { html_url?: string } }).pr?.html_url; } catch { /* no url */ }
        if (url) { i.urls.add(prKey(url)); const repo = repoOfPr(url); if (repo) i.repos.add(repo); }
        prInfo.set(e.ref_number, i);
      }
    }
    const sessions = await all<{ feed_id: number; repo: string }>(ctx,
      `SELECT feed_id, repo FROM ai_sessions WHERE org_id = ? AND feed_id IN (${ph(feed.length)})`, ctx.orgId, ...feed.map((f) => f.id));
    const sessionRepo = new Map(sessions.map((x) => [x.feed_id, x.repo.toLowerCase()]));
    for (const f of feed) {
      const r = refs.get(f.id)!;
      const named = r.prs.map((p) => ({ p, i: prInfo.get(p.n) }));
      const touches = named.some(({ p, i }) => !!i && (
          (!p.repo || i.repos.has(p.repo.toLowerCase())) && ([...i.authors].some((a) => lower.has(a)) || [...i.urls].some((u) => ticketOfPr.has(u)))))
        || named.some(({ p, i }) => (p.repo ? repos.has(p.repo.toLowerCase()) : !!i && [...i.repos].some((x) => repos.has(x))))
        || r.issues.some((n) => ticketOfIssue.has(n))
        || (sessionRepo.has(f.id) && repos.has(sessionRepo.get(f.id)!));
      if (!touches) continue;
      if (r.prs.length && r.prs.every((p) => listed.has(p.n))) continue; // the pull request is already a line
      rows.push({ title: f.summary, href: appHref("#feed"), importance: f.importance as AlsoRow["importance"], at: f.created_at });
    }
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
