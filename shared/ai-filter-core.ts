// The plain-language filter (#162), zod-free half: the screens it serves, each screen's filter as the
// SPA applies it, the route and the answer. `shared/ai-filter.ts` builds the zod schemas on these and
// re-exports all of it. The SPA imports values from here (the *-core.ts rule).
//
// A filter is the screen's OWN filter state — what the person could set by hand in its Filter menu,
// switch and search box — never results: the model fills these fields, the server checks every one
// (an enum value it does not know, a person or sprint or tag the org does not have: dropped), and the
// screen applies what is left exactly as a click would (docs/architecture/ai.md › The plain-language filter).

import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "./tickets-core";
import { ARTIFACT_AREAS, ARTIFACT_KINDS, ARTIFACT_STATUSES } from "./artifacts-core";

/** The screens with a plain-language filter. */
export const AI_FILTER_SCREENS = ["tickets", "feed", "artifacts"] as const;
export type AiFilterScreen = (typeof AI_FILTER_SCREENS)[number];
export const isAiFilterScreen = (v: unknown): v is AiFilterScreen =>
  typeof v === "string" && (AI_FILTER_SCREENS as readonly string[]).includes(v);

/** `POST /api/o/:slug/ai/filter { screen, text }` — cookie only. */
export const AI_FILTER_ROUTE = "/ai/filter";
/** The longest request a person may type. */
export const AI_FILTER_TEXT_MAX = 300;
/** The longest search text a filter may carry (the screens' search boxes). */
export const AI_FILTER_SEARCH_MAX = 120;
/** At most this many "not a filter here" phrases are returned, each at most this long. */
export const AI_FILTER_UNMATCHED_MAX = 5;
export const AI_FILTER_PHRASE_MAX = 80;

/** The ticket queue's Open / Closed / All switch. */
export const TICKET_FILTER_STATUSES = ["open", "closed", "all"] as const;
/** The ticket queue's three assignee modes (a person is `person`). */
export const TICKET_FILTER_ASSIGNEES = ["anyone", "me", "unassigned"] as const;
/** The Feed's Time group. */
export const FEED_FILTER_RANGES = ["24h", "7d", "all"] as const;

// Re-stated so the schemas and the prompt name the same lists the screens offer.
export const AI_FILTER_VALUES = {
  ticketCategories: TICKET_CATEGORIES,
  ticketPriorities: TICKET_PRIORITIES,
  artifactAreas: ARTIFACT_AREAS,
  artifactKinds: ARTIFACT_KINDS,
  artifactStatuses: ARTIFACT_STATUSES,
} as const;

/** Tickets: the Open / Closed / All switch, the Filter menu (assignee or one person, category,
 *  priority, sprint) and the search box. `sprint` is "backlog" or a sprint's id (as a string, as the
 *  menu keeps it); `person` a member's handle. A field that is absent is "no filter" there. */
export interface TicketsAiFilter {
  status?: (typeof TICKET_FILTER_STATUSES)[number];
  assignee?: (typeof TICKET_FILTER_ASSIGNEES)[number];
  person?: string;
  category?: (typeof TICKET_CATEGORIES)[number];
  priority?: (typeof TICKET_PRIORITIES)[number];
  sprint?: string;
  text?: string;
}

/** The Feed: the Filter menu's Author (a member's handle), Tag (one of the org's tags) and Time. It has
 *  no search box. */
export interface FeedAiFilter {
  author?: string;
  tag?: string;
  range?: (typeof FEED_FILTER_RANGES)[number];
}

/** The Artifacts library: the Filter menu (area, kind, author, status, sprint) and the search box. */
export interface ArtifactsAiFilter {
  area?: (typeof ARTIFACT_AREAS)[number];
  kind?: (typeof ARTIFACT_KINDS)[number];
  author?: string;
  status?: (typeof ARTIFACT_STATUSES)[number];
  sprint?: string;
  text?: string;
}

export interface AiFilterByScreen {
  tickets: TicketsAiFilter;
  feed: FeedAiFilter;
  artifacts: ArtifactsAiFilter;
}

export interface AiFilterBody {
  screen: AiFilterScreen;
  text: string;
}

/** 200: the filter to apply, every value already checked against the org's real rows. `unmatched` are
 *  words of the request (quoted from it, never model prose) that this screen cannot filter by — the
 *  screen says so instead of guessing. */
export interface AiFilterAnswer<S extends AiFilterScreen = AiFilterScreen> {
  screen: S;
  filter: AiFilterByScreen[S];
  unmatched: string[];
}

/** A refusal the screen shows in words: `invalid` (400), `unreadable` (422: nothing in the request is a
 *  filter here, or the model gave no answer), `off` (403: the org's AI switch), `no_key` (503: the
 *  deployment has no model key). The allowance is the house 402 `plan_limit`; too many requests the
 *  house 429 `rate_limited`. */
export type AiFilterErrorCode = "invalid" | "unreadable" | "off" | "no_key";
export interface AiFilterError {
  error: AiFilterErrorCode;
  message: string;
}

/** The plain-words answer for each refusal (the server sends it as `message`). `unreadable` is said per screen
 *  (`aiFilterUnreadable`): this is its first sentence. */
export const AI_FILTER_MESSAGES: Record<AiFilterErrorCode, string> = {
  invalid: "Type what you want to see, in a sentence.",
  unreadable: "Trov couldn't turn that into a filter on this screen.",
  off: "AI is switched off for this organization.",
  no_key: "AI isn't available right now.",
};

/** What each screen CAN be filtered by, in its schema's words (the interfaces above): the hint an `unreadable`
 *  refusal ends with. The Feed has no status, priority or search; Tickets and Artifacts have no time. */
export const AI_FILTER_TRY: Record<AiFilterScreen, string> = {
  tickets: "Try naming a person, a status, a category, a priority or a sprint.",
  feed: "Try naming a person, a tag or a time.",
  artifacts: "Try naming a person, a kind, an area, a status or a sprint.",
};
/** The `unreadable` refusal's sentence on `screen`. */
export const aiFilterUnreadable = (screen: AiFilterScreen): string => `${AI_FILTER_MESSAGES.unreadable} ${AI_FILTER_TRY[screen]}`;

/** The input's example, per screen. The field opens under the Filter menu's "Describe a filter" option, which
 *  already says what it is, so the example is only the sentence. */
export const AI_FILTER_PLACEHOLDER: Record<AiFilterScreen, string> = {
  tickets: "my open high-priority bugs",
  feed: "my entries from the last 7 days",
  artifacts: "published designs about auth",
};
