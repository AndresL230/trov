/** `GET /api/o/<slug>/badges`: the sidebar's counts, without the lists they count (src/tools/badges.ts).
 *  `logins` is every pending login; the web shows it to an admin only, as it did from the list. */
export interface SidebarBadges {
  review: number;    // staged doc proposals + draft ADRs
  unplaced: number;  // the Unplaced queue (needs_triage)
  logins: number;    // identity tasks waiting to be matched
  tickets: number;   // native, open, unassigned tickets
  handoffs: number;  // pending handoffs addressed to me
  prompts: number;   // staged prompts
}
