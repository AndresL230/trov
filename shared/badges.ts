/** `GET /api/o/<slug>/badges`: the sidebar's counts, without the lists they count (src/tools/badges.ts).
 *  One key per list, so the web can replace a count with its list's own once that list lands.
 *  `logins` is every pending login; the web shows it to an admin only, as it did from the list. */
export interface SidebarBadges {
  proposals: number; // staged doc versions newer than live (Review)
  decisions: number; // draft ADRs (Review)
  unplaced: number;  // the Unplaced queue (needs_triage)
  logins: number;    // identity tasks waiting to be matched
  tickets: number;   // native, open, unassigned tickets
  handoffs: number;  // pending handoffs addressed to me
  links: number;     // link requests waiting for me (`GET /links?box=waiting`); the web adds it to the Handoffs badge
  prompts: number;   // staged prompts
}
