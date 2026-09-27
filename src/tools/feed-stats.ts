// The Feed aside's "This week" numbers — a read over the WHOLE window, never the
// Feed screen's loaded page (50 entries undercounts a busy week). Two statements:
// entries grouped by (local day, author), and feed tags grouped by tag.
import {
  FEED_STATS_MAX_DAYS, FEED_STATS_MIN_DAYS, FEED_STATS_MAX_TZ_MIN, FEED_STATS_TOP_AUTHORS, FEED_STATS_TOP_TAGS,
  type FeedStats,
} from "@shared/feed-stats";
import { type DB, all } from "../db";

const DAY_MS = 86_400_000;

export interface FeedStatsOptions {
  /** 1–30 calendar days, the current one last. */
  days: number;
  /** Minutes EAST of UTC for the day boundaries (0 = UTC days). */
  tzOffsetMin?: number;
  now?: number;
}

/** The window: `days` local calendar days ending with today, as UTC instants, plus each day's date. */
export function feedStatsWindow(days: number, tzOffsetMin: number, now: number): { since: string; until: string; dates: string[] } {
  const off = tzOffsetMin * 60_000;
  const todayStartLocal = Math.floor((now + off) / DAY_MS) * DAY_MS;
  const startLocal = todayStartLocal - (days - 1) * DAY_MS;
  const dates = Array.from({ length: days }, (_, i) => new Date(startLocal + i * DAY_MS).toISOString().slice(0, 10));
  return {
    since: new Date(startLocal - off).toISOString(),
    until: new Date(todayStartLocal + DAY_MS - off).toISOString(),
    dates,
  };
}

export function isFeedStatsDays(n: number): boolean {
  return Number.isInteger(n) && n >= FEED_STATS_MIN_DAYS && n <= FEED_STATS_MAX_DAYS;
}
export function isFeedStatsTz(n: number): boolean {
  return Number.isInteger(n) && Math.abs(n) <= FEED_STATS_MAX_TZ_MIN;
}

export async function feedStats(db: DB, opts: FeedStatsOptions): Promise<FeedStats> {
  const tz = opts.tzOffsetMin ?? 0;
  if (!isFeedStatsDays(opts.days)) throw new RangeError(`days must be an integer from ${FEED_STATS_MIN_DAYS} to ${FEED_STATS_MAX_DAYS}`);
  if (!isFeedStatsTz(tz)) throw new RangeError("tz out of range");
  const { since, until, dates } = feedStatsWindow(opts.days, tz, opts.now ?? Date.now());
  // SQLite's date() shifts by the modifier before truncating: the entry's LOCAL day.
  const shift = `${tz >= 0 ? "+" : "-"}${Math.abs(tz)} minutes`;

  const [byDayAuthor, byTag] = await Promise.all([
    all<{ day: string | null; author: string; n: number }>(db,
      `SELECT date(created_at, ?) AS day, author, COUNT(*) AS n
         FROM feed WHERE created_at >= ? AND created_at < ?
        GROUP BY day, author`,
      shift, since, until),
    all<{ tag: string; n: number }>(db,
      `SELECT et.tag AS tag, COUNT(*) AS n
         FROM feed f JOIN entry_tags et ON et.entry_type = 'feed' AND et.entry_id = CAST(f.id AS TEXT)
        WHERE f.created_at >= ? AND f.created_at < ?
        GROUP BY et.tag ORDER BY n DESC, et.tag ASC LIMIT ${FEED_STATS_TOP_TAGS}`,
      since, until),
  ]);

  const perDay = new Map<string, number>(dates.map((d) => [d, 0]));
  const perAuthor = new Map<string, number>();
  for (const r of byDayAuthor) {
    // A row whose day falls outside the listed days (an unparseable created_at) counts nowhere,
    // so the total always equals the sum of the bars.
    if (r.day === null || !perDay.has(r.day)) continue;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.n);
    perAuthor.set(r.author, (perAuthor.get(r.author) ?? 0) + r.n);
  }
  const days = dates.map((date) => ({ date, count: perDay.get(date) ?? 0 }));
  const topAuthors = [...perAuthor]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0))
    .slice(0, FEED_STATS_TOP_AUTHORS);
  return {
    days,
    total: days.reduce((sum, d) => sum + d.count, 0),
    people: perAuthor.size,
    topTags: byTag.map((r) => ({ tag: r.tag, count: r.n })),
    topAuthors,
  };
}
