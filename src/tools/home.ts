// Home (`GET /home`, shared/home-core.ts): the org's daily activity over HOME_DAYS local days, the team and what each
// is on, the repositories with their last push, and the backlog / Triage counts. D1 only, one batch of reads; nothing
// here calls GitHub or a model. A day a figure could not be counted for is null, never 0 (Docs promoted before
// 0077_home timed promotions).
import { HOME_DAYS, type HomeData, type HomeDay, type HomeRepo, type HomeTeamRow } from "@shared/home-core";
import { RESERVED_HANDLES } from "../auth/persons";
import { OPEN_STATUS_SQL } from "@shared/tickets-core";
import { type TenantContext, all, first } from "../data/sql";
import { feedStatsWindow, isFeedStatsTz } from "./feed-stats";

export { isFeedStatsTz as isHomeTz };

type DayCount = { day: string | null; n: number };

export async function homeData(ctx: TenantContext, opts: { tzOffsetMin?: number; now?: number } = {}): Promise<HomeData> {
  const tz = opts.tzOffsetMin ?? 0;
  if (!isFeedStatsTz(tz)) throw new RangeError("tz out of range");
  const now = opts.now ?? Date.now();
  const { since, until, dates } = feedStatsWindow(HOME_DAYS, tz, now);
  // SQLite's date() shifts by the modifier before truncating: the event's LOCAL day.
  const shift = `${tz >= 0 ? "+" : "-"}${Math.abs(tz)} minutes`;
  const reserved = RESERVED_HANDLES.map(() => "?").join(", ");

  const [ticketsDone, claimed, promoted, sessions, org, members, onTicket, onFeed, seen, repos, pushes, backlog, triage] = await Promise.all([
    // A ticket set done twice in one day counts once that day.
    all<DayCount>(ctx,
      `SELECT date(created_at, ?) AS day, COUNT(DISTINCT ticket_id) AS n FROM ticket_events
        WHERE org_id = ? AND to_status = 'done' AND created_at >= ? AND created_at < ? GROUP BY day`,
      shift, ctx.orgId, since, until),
    all<DayCount>(ctx,
      `SELECT date(claimed_at, ?) AS day, COUNT(*) AS n FROM handoffs
        WHERE org_id = ? AND claimed_at >= ? AND claimed_at < ? GROUP BY day`,
      shift, ctx.orgId, since, until),
    all<DayCount>(ctx,
      `SELECT date(promoted_at, ?) AS day, COUNT(*) AS n FROM doc_versions
        WHERE org_id = ? AND promoted_at >= ? AND promoted_at < ? GROUP BY day`,
      shift, ctx.orgId, since, until),
    // A session recorded = an entry an agent wrote to the Feed (Trov's own digests are not sessions).
    all<DayCount>(ctx,
      `SELECT date(created_at, ?) AS day, COUNT(*) AS n FROM feed
        WHERE org_id = ? AND COALESCE(origin, 'agent') = 'agent' AND created_at >= ? AND created_at < ? GROUP BY day`,
      shift, ctx.orgId, since, until),
    first<{ created_at: string; promotions_timed_at: string | null }>(ctx,
      `SELECT created_at, promotions_timed_at FROM orgs WHERE id = ?`, ctx.orgId),
    all<{ handle: string }>(ctx,
      `SELECT p.handle FROM persons p JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
        WHERE p.handle NOT IN (${reserved}) ORDER BY m.created_at`,
      ctx.orgId, ...RESERVED_HANDLES),
    // What each is on: their newest ticket in progress or testing…
    all<{ login: string; number: number; title: string; at: string }>(ctx,
      `SELECT a.login AS login, t.number AS number, t.title AS title, t.updated_at AS at
         FROM ticket_assignees a JOIN tickets t ON t.org_id = a.org_id AND t.id = a.ticket_id
        WHERE a.org_id = ? AND t.status IN ('in_progress','testing') ORDER BY t.updated_at DESC`,
      ctx.orgId),
    // …else their newest Feed entry.
    all<{ author: string; summary: string }>(ctx,
      `SELECT f.author AS author, f.summary AS summary FROM feed f
        WHERE f.org_id = ? AND COALESCE(f.origin, 'agent') = 'agent'
          AND f.id = (SELECT MAX(g.id) FROM feed g WHERE g.org_id = f.org_id AND g.author = f.author AND COALESCE(g.origin, 'agent') = 'agent')`,
      ctx.orgId),
    // When each last did something Trov saw.
    all<{ who: string; at: string }>(ctx,
      `SELECT who, MAX(at) AS at FROM (
          SELECT author AS who, created_at AS at FROM feed WHERE org_id = ? AND COALESCE(origin, 'agent') = 'agent'
          UNION ALL SELECT actor, created_at FROM ticket_events WHERE org_id = ?
          UNION ALL SELECT sender, created_at FROM handoffs WHERE org_id = ?
          UNION ALL SELECT claimed_by, claimed_at FROM handoffs WHERE org_id = ? AND claimed_at IS NOT NULL
          UNION ALL SELECT person, last_used_at FROM mcp_tokens WHERE org_id = ? AND last_used_at IS NOT NULL
        ) GROUP BY who`,
      ctx.orgId, ctx.orgId, ctx.orgId, ctx.orgId, ctx.orgId),
    all<{ repo_full_name: string; is_primary: number; access_lost_at: string | null }>(ctx,
      `SELECT repo_full_name, is_primary, access_lost_at FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, repo_full_name`,
      ctx.orgId),
    // A push captured with no repository named ('') is the primary's (repo_events' default).
    all<{ repo: string; at: string }>(ctx,
      `SELECT repo, MAX(occurred_at) AS at FROM repo_events WHERE org_id = ? AND kind = 'push' GROUP BY repo`,
      ctx.orgId),
    first<{ n: number }>(ctx,
      `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ? AND sprint_id IS NULL AND status IN ${OPEN_STATUS_SQL}`,
      ctx.orgId),
    first<{ n: number; oldest: string | null }>(ctx,
      `SELECT COUNT(*) AS n, MIN(t.created_at) AS oldest FROM tickets t
        WHERE t.org_id = ? AND t.status = 'submitted'
          AND NOT EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.org_id = t.org_id AND a.ticket_id = t.id)`,
      ctx.orgId),
  ]);

  const perDay = (rows: DayCount[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.day !== null) m.set(r.day, (m.get(r.day) ?? 0) + r.n);
    return m;
  };
  const t = perDay(ticketsDone), h = perDay(claimed), d = perDay(promoted), s = perDay(sessions);
  // Promotions are timed from 0077_home (or the org's creation, for an org made after it): the local day that
  // moment falls on is the first one counted whole only if timing began at its start — so it, and every day before,
  // is unknown unless timing began before the window.
  const timedFrom = org ? Date.parse(org.promotions_timed_at ?? org.created_at) : NaN;
  const off = tz * 60_000;
  const firstTimedDay = Number.isNaN(timedFrom) ? null : new Date(Math.floor((timedFrom + off) / 86_400_000) * 86_400_000 + 86_400_000).toISOString().slice(0, 10);
  const timedFromOrgStart = !!org && org.promotions_timed_at === null;
  const days: HomeDay[] = dates.map((date) => ({
    date,
    tickets: t.get(date) ?? 0,
    handoffs: h.get(date) ?? 0,
    docs: timedFromOrgStart || (firstTimedDay !== null && date >= firstTimedDay) || d.has(date) ? d.get(date) ?? 0 : null,
    sessions: s.get(date) ?? 0,
  }));

  const lower = (x: string): string => x.toLowerCase();
  const onT = new Map<string, string>();
  for (const r of onTicket) if (!onT.has(lower(r.login))) onT.set(lower(r.login), `#${r.number} ${r.title}`);
  const onF = new Map(onFeed.map((r) => [lower(r.author), r.summary.replace(/\*\*|`/g, "").split("\n")[0].slice(0, 120)]));
  const at = new Map(seen.filter((r) => r.who).map((r) => [lower(r.who), r.at]));
  const team: HomeTeamRow[] = members.map((m) => {
    const k = lower(m.handle);
    return { handle: m.handle, on: onT.get(k) ?? onF.get(k) ?? null, at: at.get(k) ?? null, invited: false };
  });

  const pushAt = new Map(pushes.map((p) => [p.repo, p.at]));
  const homeRepos: HomeRepo[] = repos.map((r) => ({
    repo: r.repo_full_name,
    primary: r.is_primary === 1,
    lastPush: pushAt.get(r.repo_full_name) ?? (r.is_primary === 1 ? pushAt.get("") ?? null : null),
    accessLost: r.access_lost_at !== null,
  }));

  return { days, team, repos: homeRepos, backlog: backlog?.n ?? 0, triage: { count: triage?.n ?? 0, oldest: triage?.oldest ?? null } };
}
