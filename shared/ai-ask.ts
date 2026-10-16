// Ask Trov's contract, ZOD half (docs/architecture/ask.md): the schemas for the shapes in
// `shared/ai-ask-core.ts`, which this module re-exports — `@shared/ai-ask` is the one import path on the server,
// `@shared/ai-ask-core` on the web. Route bodies are parsed with these; every SSE event and DTO is checked
// against them in test/ask.contract.test.ts, and so is every fixture in shared/ai-fixtures.ts › Ask Trov.
import { z } from "zod";
import {
  ASK_ACTION_KINDS, ASK_ACTION_STATES, ASK_ACTIVITY_ICONS, ASK_ATTACH_FILES_MAX, ASK_ATTACH_KINDS, ASK_CHART_QUERIES, ASK_COMMANDS,
  ASK_DIAGRAM_NODES_MAX, ASK_DRAFT_MAX, ASK_ERROR_CODES, ASK_FOLLOWUPS_MAX, ASK_INSTRUCTIONS_MAX, ASK_MARKS, ASK_MODE_IDS, ASK_ORIGINS,
  ASK_PEEK_MAX, ASK_REF_TYPES, ASK_REFS_MAX, ASK_TEXT_MAX, ASK_THREAD_GROUPS, ASK_TITLE_MAX, ASK_TONES, ASK_WRONG_REASONS,
  type AskAction, type AskActionPreview, type AskAttachment, type AskBlock, type AskCancelBody, type AskConfirmBody, type AskEventMap, type AskEventName, type AskMessage,
  type AskRequest, type AskSaveBody, type AskSearchHit, type AskSettings, type AskSettingsPut, type AskState, type AskThreadDetail,
  type AskThreadPatch, type AskThreadSummary, type PeekResult, type RefView,
} from "./ai-ask-core";

export * from "./ai-ask-core";

export const AskModeSchema = z.enum(ASK_MODE_IDS);
export const AskRefSchema = z.string().regex(/^[a-z]+:[A-Za-z0-9][A-Za-z0-9_.@/-]{0,99}$/);

export const RefViewSchema = z.object({
  ref: z.string(),
  type: z.enum(ASK_REF_TYPES),
  num: z.number().int().optional(),
  title: z.string(),
  status: z.object({ mark: z.enum(ASK_MARKS), tone: z.enum(ASK_TONES), word: z.string(), tip: z.string() }).nullable(),
  owner: z.string().nullable().optional(),
  updated: z.string().nullable().optional(),
  href: z.string().nullable(),
  extra: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<RefView>;

export const PeekResultSchema = z.union([z.object({ ref: z.string(), hidden: z.literal(true) }), RefViewSchema]) satisfies z.ZodType<PeekResult>;

const saved = z.object({ slug: z.string(), title: z.string(), visibility: z.enum(["private", "org"]), url: z.string() });

export const AskBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("items"), items: z.array(RefViewSchema) }),
  z.object({ kind: z.literal("chart"), chart: z.object({
    title: z.string(), total: z.number(), rows: z.array(z.object({ label: z.string(), value: z.number() })), unit: z.string(),
    query: z.enum(ASK_CHART_QUERIES), params: z.record(z.string(), z.unknown()),
  }) }),
  z.object({ kind: z.literal("themes"), themes: z.object({
    title: z.string(), caption: z.string(), weeks: z.array(z.string()),
    lanes: z.array(z.object({ theme: z.string(), color: z.string(), values: z.array(z.number().min(0).max(1)) })),
  }) }),
  z.object({ kind: z.literal("diagram"), diagram: z.object({
    title: z.string(), caption: z.string().nullable(),
    nodes: z.array(z.object({ id: z.string(), label: z.string(), eyebrow: z.string().nullable(), ref: z.string().nullable(), view: RefViewSchema.nullable() })).max(ASK_DIAGRAM_NODES_MAX),
    edges: z.array(z.tuple([z.string(), z.string()])), layout: z.enum(["chain", "list"]),
  }) }),
  z.object({ kind: z.literal("not_found"), notFound: z.object({
    query: z.string(), tries: z.array(z.string()).max(2), searched: z.array(z.object({ area: z.string(), scope: z.string() })),
  }) }),
  z.object({ kind: z.literal("save_form"), form: z.object({
    messageId: z.number().int().nullable(), block: z.number().int().nullable(), title: z.string(), kind: z.enum(["markdown", "html"]),
    visibility: z.enum(["private", "org"]), saved: saved.nullable(),
  }) }),
]) satisfies z.ZodType<AskBlock>;

export const AskActionPreviewSchema = z.object({
  title: z.string(),
  lines: z.array(z.object({ label: z.string(), value: z.string() })),
  item: RefViewSchema.nullable(),
  hunks: z.array(z.object({ index: z.number().int(), heading: z.string().nullable(), before: z.string(), after: z.string() })).max(3).optional(),
  canPublish: z.boolean().optional(),
}) satisfies z.ZodType<AskActionPreview>;

export const AskActionSchema = z.object({
  id: z.number().int(), groupId: z.string().nullable(), tool: z.string(), kind: z.enum(ASK_ACTION_KINDS), state: z.enum(ASK_ACTION_STATES),
  preview: AskActionPreviewSchema, fields: z.record(z.string(), z.unknown()), editable: z.array(z.string()), note: z.string().nullable(),
  result: z.unknown(), ref: z.string().nullable(), undo: z.boolean(), createdAt: z.string(), decidedAt: z.string().nullable(),
}) satisfies z.ZodType<AskAction>;

const tokens = z.object({ in: z.number(), out: z.number(), cached: z.number() });
const actionResult = z.object({
  id: z.number().int(), groupId: z.string().nullable(), tool: z.string(), kind: z.enum(ASK_ACTION_KINDS), preview: AskActionPreviewSchema,
  state: z.enum(["confirmed", "auto", "undone", "cancelled", "failed"]),
  result: z.unknown(), ref: z.string().nullable(), undo: z.boolean(), at: z.string(),
});

/** One schema per SSE event's `data`. */
export const AskEventSchemas = {
  thread: z.object({ id: z.number().int(), title: z.string(), mode: AskModeSchema, auto: z.boolean(), origin: z.enum(ASK_ORIGINS), contextRef: z.string().nullable(), autoOff: z.literal(true).optional() }),
  thinking: z.union([z.object({ state: z.literal("run") }), z.object({ state: z.literal("done"), seconds: z.number().min(0), summary: z.string() })]),
  activity: z.union([
    z.object({ step: z.number().int().min(1), tool: z.string(), icon: z.enum(ASK_ACTIVITY_ICONS), label: z.string(), state: z.literal("run") }),
    z.object({ step: z.number().int().min(1), state: z.literal("done"), results: z.array(z.string()).optional(), resultLine: z.string().optional() }),
  ]),
  text: z.object({ delta: z.string() }),
  block: AskBlockSchema,
  action: z.object({
    id: z.number().int(), groupId: z.string().nullable(), tool: z.string(), kind: z.enum(ASK_ACTION_KINDS), preview: AskActionPreviewSchema,
    fields: z.record(z.string(), z.unknown()), editable: z.array(z.string()), note: z.string().nullable(), state: z.enum(["proposed", "waiting"]),
  }),
  action_result: actionResult,
  artifact_saved: saved,
  followups: z.object({ items: z.array(z.string()).max(ASK_FOLLOWUPS_MAX) }),
  done: z.object({ messageId: z.number().int(), questionId: z.number().int().optional(), cites: z.array(RefViewSchema), tokens, stopped: z.boolean().optional() }),
  error: z.object({ code: z.enum(ASK_ERROR_CODES), message: z.string() }),
} satisfies { [K in AskEventName]: z.ZodType<AskEventMap[K]> };

export const AskRequestSchema = z.strictObject({
  threadId: z.number().int().positive().nullable().optional(),
  text: z.string().max(ASK_TEXT_MAX).default(""),
  command: z.enum(ASK_COMMANDS).optional(),
  mode: AskModeSchema,
  auto: z.boolean().default(false),
  context: z.array(AskRefSchema).max(ASK_REFS_MAX).default([]),
  attachments: z.array(z.number().int().positive()).max(ASK_ATTACH_FILES_MAX).default([]),
  replaceFrom: z.number().int().positive().optional(),
  origin: z.enum(ASK_ORIGINS).optional(),
}) satisfies z.ZodType<AskRequest, unknown>;

export const AskPeekBodySchema = z.strictObject({ refs: z.array(AskRefSchema).min(1).max(ASK_PEEK_MAX) });

export const AskThreadPatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(ASK_TITLE_MAX).optional(),
  pinned: z.boolean().optional(),
  auto: z.boolean().optional(),
  mode: AskModeSchema.optional(),
  draft: z.string().max(ASK_DRAFT_MAX).optional(),
}) satisfies z.ZodType<AskThreadPatch>;

export const AskSaveBodySchema = z.strictObject({
  messageId: z.number().int().positive().optional(),
  block: z.number().int().min(0).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(["markdown", "html"]).optional(),
  visibility: z.enum(["private", "org"]).optional(),
}) satisfies z.ZodType<AskSaveBody>;

export const AskConfirmBodySchema = z.strictObject({ args: z.record(z.string(), z.unknown()).optional(), only: z.boolean().optional() }) satisfies z.ZodType<AskConfirmBody>;
export const AskCancelBodySchema = z.strictObject({ only: z.boolean().optional() }) satisfies z.ZodType<AskCancelBody>;
export const AskWrongBodySchema = z.strictObject({ reason: z.enum(ASK_WRONG_REASONS) });

export const AskSettingsPutSchema = z.strictObject({
  instructions: z.string().max(ASK_INSTRUCTIONS_MAX).optional(),
  defaultMode: AskModeSchema.optional(),
}) satisfies z.ZodType<AskSettingsPut>;

export const AskSettingsSchema = z.object({
  instructions: z.string().max(ASK_INSTRUCTIONS_MAX), defaultMode: AskModeSchema, modes: z.array(AskModeSchema),
}) satisfies z.ZodType<AskSettings>;

export const AskStateSchema = z.object({
  enabled: z.boolean(),
  eligibility: z.enum(["ok", "off", "no_key", "capped"]),
  plan: z.string(),
  modes: z.array(z.object({ id: AskModeSchema, label: z.string(), hint: z.string(), countsAs: z.number().int().min(1), canSend: z.boolean().optional() })).min(1),
  defaultMode: AskModeSchema,
  allowance: z.object({ used: z.number(), cap: z.number().nullable(), resetsAt: z.string(), low: z.boolean() }),
  autoAllowed: z.boolean(),
  attach: z.object({ maxFiles: z.number().int(), maxBytes: z.number().int(), kinds: z.array(z.enum(ASK_ATTACH_KINDS)) }),
  starters: z.array(z.string()).min(1).max(6),
  proPerSeat: z.number().int().min(1).nullable(),
}) satisfies z.ZodType<AskState>;

export const AskAttachmentSchema = z.object({
  id: z.number().int(), slug: z.string(), title: z.string(), kind: z.enum(ASK_ATTACH_KINDS), contentType: z.string(), size: z.number().int(),
  sha256: z.string(), thumbUrl: z.string().optional(),
}) satisfies z.ZodType<AskAttachment>;

export const AskThreadSummarySchema = z.object({
  id: z.number().int(), title: z.string(), pinned: z.boolean(), mode: AskModeSchema, auto: z.boolean(), origin: z.enum(ASK_ORIGINS),
  contextRef: z.string().nullable(), hasDraft: z.boolean(), group: z.enum(ASK_THREAD_GROUPS), createdAt: z.string(), updatedAt: z.string(),
}) satisfies z.ZodType<AskThreadSummary>;

export const AskSearchHitSchema = z.object({
  thread: AskThreadSummarySchema,
  snippet: z.object({ text: z.string(), matches: z.array(z.tuple([z.number().int(), z.number().int()])) }).nullable(),
  matchCount: z.number().int().min(0),
}) satisfies z.ZodType<AskSearchHit>;

export const AskMessageSchema = z.object({
  id: z.number().int(), role: z.enum(["user", "assistant"]), mode: AskModeSchema, text: z.string(), command: z.enum(ASK_COMMANDS).nullable(),
  context: z.array(z.string()), blocks: z.array(AskBlockSchema),
  activity: z.array(z.object({ step: z.number().int(), tool: z.string(), icon: z.enum(ASK_ACTIVITY_ICONS), label: z.string(), results: z.array(z.string()), resultLine: z.string().nullable() })),
  followups: z.array(z.string()), thinking: z.object({ seconds: z.number(), summary: z.string() }).nullable(), cites: z.array(RefViewSchema),
  attachments: z.array(AskAttachmentSchema), actions: z.array(AskActionSchema),
  parts: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), md: z.string() }), z.object({ kind: z.literal("block"), index: z.number().int().min(0) }), z.object({ kind: z.literal("action"), id: z.number().int() }),
  ])).optional(),
  stopped: z.boolean(), model: z.string().nullable(),
  units: z.number().int(), createdAt: z.string(),
}) satisfies z.ZodType<AskMessage>;

export const AskThreadDetailSchema = z.object({
  thread: AskThreadSummarySchema.extend({ draft: z.string() }),
  messages: z.array(AskMessageSchema),
}) satisfies z.ZodType<AskThreadDetail>;
