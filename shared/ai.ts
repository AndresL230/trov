// The AI contracts, zod half: schemas for the shapes in ./ai-core (the zod-free value
// half, which the SPA imports) — the Worker validates what it stores and returns
// against these, and the preview fixtures are checked against them in tests. Every
// value and type in ./ai-core is re-exported, so `@shared/ai` is the one server-side
// import path.

import { z } from "zod";
import {
  AI_STATES, AI_NEXT_KINDS, AI_ORIGINS, AI_THEME_RANGES, AI_THEME_COLORS, AI_THEME_STATUSES,
  AI_SUGGESTION_STATES, AI_ITEM_TYPES, AI_ELIGIBILITY, AI_LIST_MAX, AI_PROVIDER_NAMES,
  type AiCite, type AiLine, type AiBrief, type AiRepoState, type AiFeedMeta, type AiThemes,
  type AiThemeLane, type AiSuggestion, type AiFeedbackBody, type AiAcceptBody, type AiSettings, type AiSettingsPut, type AiUsage,
  type AiAllowanceUse, type AiRoadmapLine, type AiPlanDrift, type AiSprintDraftValue, type AiPlanNarrativeValue,
} from "./ai-core";

export * from "./ai-core";
// Ask Trov's modes (#12 §2.1): THE one table to retune — model, tools, call limit and what an answer counts as.
// Defined zod-free in ./ai-ask-core (the SPA's mode menu reads it); re-exported here as the server-side path.
export { ASK_MODES, ASK_DEFAULT_MODE, askMode, askModesFor, type AskModeDef, type AskMode } from "./ai-ask-core";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AiCiteSchema = z.object({
  ref: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  href: z.string().max(2000).nullable(),
}) satisfies z.ZodType<AiCite>;

export const AiLineSchema = z.object({
  text: z.string().min(1).max(600),
  cites: z.array(AiCiteSchema).max(20),
}) satisfies z.ZodType<AiLine>;

const meta = {
  state: z.enum(AI_STATES),
  generatedAt: z.string().nullable(),
  model: z.string().nullable(),
  resumesOn: isoDay.nullable(),
  upgrade: z.boolean(),
};

export const AiBriefSchema = z.object({
  ...meta,
  now: AiLineSchema.nullable(),
  recently: AiLineSchema.nullable(),
  next: z.object({
    items: z.array(z.object({
      ref: z.string().min(1).max(200),
      kind: z.enum(AI_NEXT_KINDS),
      title: z.string().min(1).max(300),
      why: z.string().min(1).max(300),
      cites: z.array(AiCiteSchema).min(1).max(10),
    })).max(AI_LIST_MAX),
  }),
}) satisfies z.ZodType<AiBrief>;

export const AiRepoStateSchema = z.object({
  ...meta,
  headline: z.string().min(1).max(300).nullable(),
  shipped: z.array(AiLineSchema).max(AI_LIST_MAX),
  inFlight: z.array(AiLineSchema).max(AI_LIST_MAX),
  attention: z.array(AiLineSchema).max(AI_LIST_MAX),
  eventCount: z.number().int().min(0).nullable(),
  ageDays: z.number().int().min(0).optional(),
}) satisfies z.ZodType<AiRepoState>;

export const AiFeedMetaSchema = z.object({
  origin: z.enum(AI_ORIGINS),
  subject: z.string().nullable(),
  sources: z.array(AiCiteSchema).max(10),
  moreCount: z.number().int().min(0),
  generatedAt: z.string().nullable(),
  model: z.string().nullable(),
}) satisfies z.ZodType<AiFeedMeta>;

export const AiThemeLaneSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  colorKey: z.enum(AI_THEME_COLORS),
  description: z.string().max(400),
  counts: z.array(z.number().int().min(0)),
  prs: z.array(AiCiteSchema).max(50),
  status: z.enum(AI_THEME_STATUSES),
  suggestionId: z.number().int().positive().nullable(),
}) satisfies z.ZodType<AiThemeLane>;

export const AiThemesSchema = z.object({
  ...meta,
  caption: z.string().min(1).max(400).nullable(),
  prCount: z.number().int().min(0).nullable(),
  range: z.enum(AI_THEME_RANGES),
  weeks: z.array(isoDay),
  lanes: z.array(AiThemeLaneSchema).max(8),
}).refine((t) => t.lanes.every((l) => l.counts.length === t.weeks.length), "every lane has one count per week") satisfies z.ZodType<AiThemes>;

export const AiSuggestionSchema = z.object({
  id: z.number().int().positive(),
  itemType: z.string().min(1),
  itemRef: z.string().min(1),
  kind: z.string().min(1),
  value: z.unknown(),
  label: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  cites: z.array(AiCiteSchema),
  state: z.enum(AI_SUGGESTION_STATES),
}) satisfies z.ZodType<AiSuggestion>;

export const AiFeedbackBodySchema = z.object({
  itemType: z.enum(AI_ITEM_TYPES),
  itemRef: z.string().min(1).max(200),
  kind: z.string().min(1).max(60),
  // Nullable, and an OMITTED one is null (Q15): a client that does not know how the item was written leaves them out.
  model: z.string().max(80).nullish().transform((v) => v ?? null),
  promptVersion: z.string().max(40).nullish().transform((v) => v ?? null),
}) satisfies z.ZodType<AiFeedbackBody, unknown>;

export const AiAcceptBodySchema = z.object({ value: z.unknown().optional() }) satisfies z.ZodType<AiAcceptBody>;

/** Any of the switches — never none, never another key. */
export const AiSettingsPutSchema = z.strictObject({ enabled: z.boolean().optional(), chatAuto: z.boolean().optional(), chatGithub: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.chatAuto !== undefined || b.chatGithub !== undefined, "send enabled, chatAuto or chatGithub") satisfies z.ZodType<AiSettingsPut>;

const AiAllowanceUseSchema = z.object({
  used: z.number().int().min(0), cap: z.number().int().min(0).nullable(), resumesOn: isoDay.nullable(),
}) satisfies z.ZodType<AiAllowanceUse>;

export const AiSettingsSchema = z.object({
  enabled: z.boolean(),
  canEdit: z.boolean(),
  eligibility: z.enum(AI_ELIGIBILITY),
  allowances: z.object({
    ai_summaries: AiAllowanceUseSchema, ai_runs: AiAllowanceUseSchema, jev_checks: AiAllowanceUseSchema, ai_chat: AiAllowanceUseSchema,
  }),
  chatAuto: z.boolean(),
  chatGithub: z.boolean(),
  keys: z.object({ anthropic: z.boolean(), typesafe: z.boolean() }),
  planEnded: z.string().nullable(),
  sends: z.array(z.object({ provider: z.enum(AI_PROVIDER_NAMES), what: z.string(), for: z.string() })),
  neverSent: z.string(),
}) satisfies z.ZodType<AiSettings>;

export const AiUsageSchema = z.object({
  runs: z.number().int().min(0).optional(),
  failed: z.number().int().min(0).optional(),
  capped: z.number().int().min(0).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  tokensCached: z.number().int().min(0).optional(),
  jevChecks: z.number().int().min(0).optional(),
  jevTokensIn: z.number().int().min(0).optional(),
  jevTokensOut: z.number().int().min(0).optional(),
}) satisfies z.ZodType<AiUsage>;

// ── Roadmap (Phase D): sprint notes, plan drift, the two suggestions' values ────────────────────────
export const AiRoadmapLineSchema = z.object({
  text: z.string().min(1).max(400),
  cites: z.array(AiCiteSchema).min(1).max(10),
  generatedAt: z.string().min(1),
  model: z.string().nullable(),
  state: z.literal("capped").optional(),
  resumesOn: z.string().nullable().optional(),
  upgrade: z.boolean().optional(),
}) satisfies z.ZodType<AiRoadmapLine>;

export const AiPlanDriftSchema = AiRoadmapLineSchema.extend({
  windowDays: z.number().int().positive(),
  shares: z.array(z.object({ themeId: z.string().min(1), theme: z.string().min(1), pct: z.number().int().min(0).max(100), inSprint: z.boolean() })).max(12),
}) satisfies z.ZodType<AiPlanDrift>;

/** What accepting a sprint draft takes (the suggested value, or the admin's edited one). */
export const AiSprintDraftValueSchema = z.object({
  sprints: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    goal: z.string().trim().max(200),
    tickets: z.array(z.number().int().positive()).min(1).max(40),
  })).min(1).max(4),
}) satisfies z.ZodType<AiSprintDraftValue>;

/** What accepting a narrative proposal takes. The cap itself is `write_plan`'s (PLAN_NARRATIVE_MAX). */
export const AiPlanNarrativeValueSchema = z.object({ narrative: z.string().trim().min(1) }) satisfies z.ZodType<AiPlanNarrativeValue>;
