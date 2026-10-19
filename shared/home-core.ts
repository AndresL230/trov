// Home (`GET /home`) — the org's front page: what changed, what needs you, how the team is doing. Zod-free (the SPA
// imports these as values; web/src/home.ts). Every figure is a count the server has; unknown is null, never 0.

/** The Activity ranges, in days. */
export const HOME_RANGES = ["7", "30", "90"] as const;
export type HomeRange = (typeof HOME_RANGES)[number];
export const homeRangeDays = (r: HomeRange): number => Number(r);
/** Activity reads twice the longest range, so the 90-day figures have a previous 90 days to compare with. */
export const HOME_DAYS = 180;

/** One local day of the org's activity. A figure the server could not count for that day is null. */
export interface HomeDay {
  /** `YYYY-MM-DD`, in the viewer's time zone. */
  date: string;
  /** Tickets set done that day (a ticket set done twice counts once a day). */
  tickets: number;
  /** Handoffs claimed that day. */
  handoffs: number;
  /** Doc versions promoted that day; null before promotions were timed (0084). */
  docs: number | null;
  /** Sessions recorded: entries agents wrote to the Feed that day. */
  sessions: number;
}

/** A member and what they are on: their newest ticket in progress or testing, else their newest Feed entry. */
export interface HomeTeamRow {
  handle: string;
  /** "#12 Ticket title" or a Feed entry's summary; null when nothing is known. */
  on: string | null;
  /** When they last did something Trov saw (a ticket move, a Feed entry, a handoff, an agent call), else null. */
  at: string | null;
  /** Joined the org but has not done anything yet, or an invite not yet accepted. */
  invited: boolean;
}

/** One connected repository: when it was last pushed to (null: no push captured yet). */
export interface HomeRepo {
  repo: string;
  primary: boolean;
  lastPush: string | null;
  accessLost: boolean;
}

export interface HomeData {
  /** HOME_DAYS days, oldest first, ending today in the viewer's time zone. */
  days: HomeDay[];
  team: HomeTeamRow[];
  repos: HomeRepo[];
  /** Open tickets in no sprint (both sources). */
  backlog: number;
  /** Tickets in Triage (`submitted`) with no assignee, and when the oldest was filed. */
  triage: { count: number; oldest: string | null };
  degraded?: boolean;
}

/** The sum of one figure over the last `n` days ending `end` days before today (0 = up to today); null when any day
 *  in the window is unknown. */
export function homeSum(days: readonly HomeDay[], key: "tickets" | "handoffs" | "docs" | "sessions", n: number, end = 0): number | null {
  const to = days.length - end;
  const from = to - n;
  if (from < 0) return null;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = days[i][key];
    if (v === null) return null;
    sum += v;
  }
  return sum;
}
