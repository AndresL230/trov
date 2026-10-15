// The plain-language filter (#162), zod half: each screen's filter schema, defined ONCE. The route
// (src/ai/filter.ts) sends the model this schema as its output format and checks what comes back against
// it field by field; the answer it returns is validated against it again. Every value and type of
// ./ai-filter-core is re-exported, so `@shared/ai-filter` is the one server-side import path.

import { z } from "zod";
import {
  AI_FILTER_PHRASE_MAX, AI_FILTER_SCREENS, AI_FILTER_SEARCH_MAX, AI_FILTER_TEXT_MAX, AI_FILTER_UNMATCHED_MAX,
  AI_FILTER_VALUES, FEED_FILTER_RANGES, TICKET_FILTER_ASSIGNEES, TICKET_FILTER_STATUSES,
  type AiFilterAnswer, type AiFilterBody, type AiFilterScreen, type ArtifactsAiFilter, type FeedAiFilter, type TicketsAiFilter,
} from "./ai-filter-core";

export * from "./ai-filter-core";

/** A name the server resolves against the org's rows (a handle, a sprint's id or title, a tag). */
const name = z.string().trim().min(1).max(120);
const search = z.string().trim().min(1).max(AI_FILTER_SEARCH_MAX);

export const TicketsAiFilterSchema = z.object({
  status: z.enum(TICKET_FILTER_STATUSES).optional(),
  assignee: z.enum(TICKET_FILTER_ASSIGNEES).optional(),
  person: name.optional(),
  category: z.enum(AI_FILTER_VALUES.ticketCategories).optional(),
  priority: z.enum(AI_FILTER_VALUES.ticketPriorities).optional(),
  sprint: name.optional(),
  text: search.optional(),
}).strict() satisfies z.ZodType<TicketsAiFilter>;

export const FeedAiFilterSchema = z.object({
  author: name.optional(),
  tag: name.optional(),
  range: z.enum(FEED_FILTER_RANGES).optional(),
}).strict() satisfies z.ZodType<FeedAiFilter>;

export const ArtifactsAiFilterSchema = z.object({
  area: z.enum(AI_FILTER_VALUES.artifactAreas).optional(),
  kind: z.enum(AI_FILTER_VALUES.artifactKinds).optional(),
  author: name.optional(),
  status: z.enum(AI_FILTER_VALUES.artifactStatuses).optional(),
  sprint: name.optional(),
  text: search.optional(),
}).strict() satisfies z.ZodType<ArtifactsAiFilter>;

/** THE table: a screen → its filter schema. */
export const AI_FILTER_SCHEMAS = {
  tickets: TicketsAiFilterSchema,
  feed: FeedAiFilterSchema,
  artifacts: ArtifactsAiFilterSchema,
} as const satisfies Record<AiFilterScreen, z.ZodObject>;

export const AiFilterBodySchema = z.object({
  screen: z.enum(AI_FILTER_SCREENS),
  text: z.string().trim().min(1).max(AI_FILTER_TEXT_MAX),
}).strict() satisfies z.ZodType<AiFilterBody>;

const unmatched = z.array(z.string().min(1).max(AI_FILTER_PHRASE_MAX)).max(AI_FILTER_UNMATCHED_MAX);

/** The 200 answer, one variant per screen. */
export const AiFilterAnswerSchema = z.discriminatedUnion("screen", [
  z.object({ screen: z.literal("tickets"), filter: TicketsAiFilterSchema, unmatched }).strict(),
  z.object({ screen: z.literal("feed"), filter: FeedAiFilterSchema, unmatched }).strict(),
  z.object({ screen: z.literal("artifacts"), filter: ArtifactsAiFilterSchema, unmatched }).strict(),
]) satisfies z.ZodType<AiFilterAnswer>;
