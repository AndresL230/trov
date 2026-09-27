// The Feed aside's "This week" read (`GET /feed/stats`) — the DTO the Worker
// returns and the SPA renders. Zod-free: the SPA imports the bounds as values.

/** How many days a stats read may cover, inclusive. */
export const FEED_STATS_MIN_DAYS = 1;
export const FEED_STATS_MAX_DAYS = 30;
/** The widest real UTC offset is ±14h; a `tz` beyond it is refused. */
export const FEED_STATS_MAX_TZ_MIN = 14 * 60;
export const FEED_STATS_TOP_TAGS = 4;
export const FEED_STATS_TOP_AUTHORS = 3;

/**
 * Feed activity over the last `days` calendar days, the current day last. Days are
 * the caller's LOCAL days when it passes `tz` (minutes EAST of UTC — the negation
 * of JS `getTimezoneOffset()`), else UTC. Every day in the window is listed, a
 * day with no entries as `count: 0` — a true zero, since the count is taken over
 * the whole window server-side, never from a loaded page of entries.
 */
export interface FeedStats {
  days: { date: string; count: number }[];
  total: number;
  /** Distinct authors (handles) in the window. */
  people: number;
  /** Most-used tags, most first, ties by tag name. At most FEED_STATS_TOP_TAGS. */
  topTags: { tag: string; count: number }[];
  /** Most active authors, most first, ties by handle. At most FEED_STATS_TOP_AUTHORS. */
  topAuthors: { author: string; count: number }[];
}
