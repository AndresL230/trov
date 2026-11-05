// Projects' contract, ZOD half (docs/architecture/projects.md): the schemas for the shapes in `shared/projects-core.ts`,
// which this module re-exports — `@shared/projects` is the server's import path, `@shared/projects-core` the web's.
// Route bodies are parsed with these; the DTO schemas hold every route's answer to the contract in the tests.
import { z } from "zod";
import {
  PROJECT_COLORS, PROJECT_ICONS, PROJECT_LIMITS, PROJECT_ROLES, PROJECT_VISIBILITIES,
  type ProjectArtifact, type ProjectCreateBody, type ProjectDeleted, type ProjectDetail, type ProjectList, type ProjectMember, type ProjectMembersBody,
  type ProjectPatchBody, type ProjectPin, type ProjectPinsBody, type ProjectSummary,
} from "./projects-core";
import { AskRefSchema, AskThreadSummarySchema, RefViewSchema } from "./ai-ask";

export * from "./projects-core";

/** A colour as the spaces take it: any case of one of the set's values (stored lower-cased). */
const ColorSchema = z.string().transform((v) => v.toLowerCase()).pipe(z.enum(PROJECT_COLORS));
const NameSchema = z.string().trim().min(1).max(PROJECT_LIMITS.nameMax);
const DescriptionSchema = z.string().trim().max(PROJECT_LIMITS.descriptionMax);
const InstructionsSchema = z.string().max(PROJECT_LIMITS.instructionsMax);

export const ProjectCreateBodySchema = z.strictObject({
  name: NameSchema,
  description: DescriptionSchema.optional(),
  icon: z.enum(PROJECT_ICONS),
  color: ColorSchema,
  visibility: z.enum(PROJECT_VISIBILITIES),
  instructions: InstructionsSchema.optional(),
}) satisfies z.ZodType<ProjectCreateBody, unknown>;

export const ProjectPatchBodySchema = z.strictObject({
  name: NameSchema.optional(),
  description: DescriptionSchema.optional(),
  icon: z.enum(PROJECT_ICONS).optional(),
  color: ColorSchema.optional(),
  visibility: z.enum(PROJECT_VISIBILITIES).optional(),
  instructions: InstructionsSchema.optional(),
}) satisfies z.ZodType<ProjectPatchBody, unknown>;

export const ProjectMembersBodySchema = z.strictObject({
  members: z.array(z.strictObject({ handle: z.string().trim().min(1).max(80), role: z.enum(PROJECT_ROLES) })).max(PROJECT_LIMITS.membersMax),
}) satisfies z.ZodType<ProjectMembersBody>;

export const ProjectPinsBodySchema = z.strictObject({
  refs: z.array(AskRefSchema).min(1).max(PROJECT_LIMITS.pinsPerRequest),
}) satisfies z.ZodType<ProjectPinsBody>;

// ── DTOs (what the routes answer; the tests parse every answer with these) ──

export const ProjectSummarySchema = z.strictObject({
  slug: z.string(), name: z.string(), description: z.string(), icon: z.enum(PROJECT_ICONS), color: z.enum(PROJECT_COLORS),
  visibility: z.enum(PROJECT_VISIBILITIES), owner: z.string(), access: z.enum(["owner", "editor", "viewer"]),
  people: z.array(z.string()).max(3), memberCount: z.number().int().min(1), chats: z.number().int().min(0), pins: z.number().int().min(0),
  artifacts: z.number().int().min(0), updatedAt: z.string(), archivedAt: z.string().nullable(), archivedBy: z.string().nullable(),
  deleteCounts: z.strictObject({ chats: z.number().int().min(0), artifacts: z.number().int().min(0) }).optional(),
}) satisfies z.ZodType<ProjectSummary>;

export const ProjectMemberSchema = z.strictObject({
  handle: z.string(), role: z.enum(["owner", ...PROJECT_ROLES]), addedAt: z.string().nullable(),
}) satisfies z.ZodType<ProjectMember>;

export const ProjectPinSchema = z.strictObject({
  ref: z.string(),
  view: z.union([z.strictObject({ ref: z.string(), hidden: z.literal(true) }), RefViewSchema]),
  addedBy: z.string(), addedAt: z.string(),
}) satisfies z.ZodType<ProjectPin>;

export const ProjectArtifactSchema = z.strictObject({
  slug: z.string(), title: z.string(), kind: z.string(), visibility: z.enum(["private", "org"]), author: z.string(), updatedAt: z.string(),
  threadId: z.number().int().nullable(), preview: z.string().nullable(),
}) satisfies z.ZodType<ProjectArtifact>;

export const ProjectDetailSchema = z.strictObject({
  project: ProjectSummarySchema.extend({ instructions: z.string() }),
  members: z.array(ProjectMemberSchema),
  pins: z.array(ProjectPinSchema),
  chats: z.array(AskThreadSummarySchema),
  artifacts: z.array(ProjectArtifactSchema),
  pinLimit: z.strictObject({ used: z.number().int().min(0), cap: z.number().int().nullable() }),
}) satisfies z.ZodType<ProjectDetail>;

export const ProjectListSchema = z.strictObject({
  projects: z.array(ProjectSummarySchema),
  archived: z.array(ProjectSummarySchema),
  limit: z.strictObject({ used: z.number().int().min(0), cap: z.number().int().nullable() }),
}) satisfies z.ZodType<ProjectList>;

export const ProjectDeletedSchema = z.strictObject({
  ok: z.literal(true), chats: z.number().int().min(0), artifacts: z.number().int().min(0),
}) satisfies z.ZodType<ProjectDeleted>;
