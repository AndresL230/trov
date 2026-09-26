// The artifacts contract with zod request schemas on top of the zod-free core
// (`./artifacts-core`, the *-core.ts rule: the SPA imports values from the core and
// never drags zod in). `@shared/artifacts` is the one import path for the server.
//
// These schemas describe REQUEST shapes (HTTP bodies, MCP args). The repository
// (src/tools/artifacts.ts) re-validates every rule that matters for storage, so a
// caller that skips a schema still cannot write a bad row.

import { z } from "zod";
import {
  ARTIFACT_AREAS, ARTIFACT_BINARY_KINDS, ARTIFACT_KINDS, ARTIFACT_LINK_TYPES, ARTIFACT_STATUSES,
  ARTIFACT_SUMMARY_MAX, ARTIFACT_TEXT_KINDS, ARTIFACT_VISIBILITIES,
} from "./artifacts-core";

export * from "./artifacts-core";

export const ARTIFACT_TITLE_MAX = 200;
export const ARTIFACT_FILENAME_MAX = 255;
/** "owner/repo" (GitHub's own character set) or the empty string. */
export const ARTIFACT_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export const ArtifactTextKindSchema = z.enum(ARTIFACT_TEXT_KINDS);
export const ArtifactBinaryKindSchema = z.enum(ARTIFACT_BINARY_KINDS);
export const ArtifactStatusSchema = z.enum(ARTIFACT_STATUSES);
export const ArtifactVisibilitySchema = z.enum(ARTIFACT_VISIBILITIES);
export const ArtifactLinkTypeSchema = z.enum(ARTIFACT_LINK_TYPES);
export const ArtifactAreaSchema = z.enum(ARTIFACT_AREAS);

const title = z.string().trim().min(1).max(ARTIFACT_TITLE_MAX);
const summary = z.string().max(ARTIFACT_SUMMARY_MAX);
const repo = z.string().trim().refine((s) => s === "" || ARTIFACT_REPO_RE.test(s), "repo must be owner/repo");
const sha256 = z.string().trim().toLowerCase().regex(SHA256_HEX_RE, "sha256 must be 64 hex characters");

/** One link, as a client sends it. The repository normalizes `target_ref`. */
export const ArtifactLinkInputSchema = z.object({
  target_type: ArtifactLinkTypeSchema,
  target_ref: z.string().trim().min(1).max(300),
});
export type ArtifactLinkInput = z.infer<typeof ArtifactLinkInputSchema>;

/** The page fields every create carries (text or binary). */
export const ArtifactPageFieldsSchema = z.object({
  title,
  area: ArtifactAreaSchema,
  repo: repo.optional(),
  visibility: ArtifactVisibilitySchema.optional(),
  links: z.array(ArtifactLinkInputSchema).max(50).optional(),
});
export type ArtifactPageFields = z.infer<typeof ArtifactPageFieldsSchema>;

/** Create a TEXT page (JSON body / MCP). The content becomes v1, status draft. */
export const CreateTextArtifactSchema = ArtifactPageFieldsSchema.extend({
  kind: ArtifactTextKindSchema,
  content: z.string(),
  summary: summary.optional(),
});
export type CreateTextArtifactInput = z.infer<typeof CreateTextArtifactSchema>;

/** Add a text version: the full content, OR an exact-once `old_str` → `new_str` edit of the latest. */
export const AddTextVersionSchema = z.union([
  z.object({ content: z.string(), summary: summary.optional() }).strict(),
  z.object({ old_str: z.string().min(1), new_str: z.string(), summary: summary.optional() }).strict(),
]);
export type AddTextVersionInput = z.infer<typeof AddTextVersionSchema>;

/** `PATCH /api/artifacts/:slug`. `status` here is draft ⇄ published only — ratify has its own route. */
export const PatchArtifactSchema = z.object({
  title: title.optional(),
  area: ArtifactAreaSchema.optional(),
  repo: repo.optional(),
  visibility: ArtifactVisibilitySchema.optional(),
  status: z.enum(["draft", "published"]).optional(),
}).strict();
export type PatchArtifactInput = z.infer<typeof PatchArtifactSchema>;

export const RatifyArtifactSchema = z.object({ version: z.number().int().min(1) });

/** The upload-ticket request: the binary's declared size + sha256, for an existing slug or a new page. */
export const UploadTicketSchema = z.object({
  slug: z.string().optional(),
  kind: ArtifactBinaryKindSchema,
  // No .max here: the repository refuses > ARTIFACT_BINARY_CAP as too_large (413), not a 400 (Track E).
  size_bytes: z.number().int().min(1),
  sha256,
  content_type: z.string().max(255).optional(),
  filename: z.string().max(ARTIFACT_FILENAME_MAX).optional(),
  summary: summary.optional(),
  // new-page fields (required when `slug` is absent — checked by the repository)
  title: title.optional(),
  area: ArtifactAreaSchema.optional(),
  repo: repo.optional(),
  visibility: ArtifactVisibilitySchema.optional(),
  links: z.array(ArtifactLinkInputSchema).max(50).optional(),
});
export type UploadTicketInput = z.infer<typeof UploadTicketSchema>;

export const FetchArtifactUrlSchema = z.object({ url: z.string().url().max(2048) });

/** The library's filters (`GET /api/artifacts?…`). Absent or "all" = no filter. */
export const ArtifactListFiltersSchema = z.object({
  area: z.string().optional(),
  kind: z.string().optional(),
  author: z.string().optional(),
  status: z.string().optional(),
  sprint: z.string().optional(),
  ticket: z.string().optional(),
  q: z.string().optional(),
});
export type ArtifactListFilters = z.infer<typeof ArtifactListFiltersSchema>;
