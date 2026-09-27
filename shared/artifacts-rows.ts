// D1 row shapes for the artifacts tables (0030_artifacts.sql), re-exported by
// shared/rows.ts. Person columns hold HANDLES. Type-only; no zod.

import type { ArtifactKind, ArtifactStatus, ArtifactVisibility, ArtifactLinkType, ArtifactBinaryKind } from "./artifacts-core";

export interface ArtifactPageRow {
  id: number;
  slug: string;
  title: string;
  kind: ArtifactKind;
  area: string;
  repo: string;
  author_id: string;
  status: ArtifactStatus;
  visibility: ArtifactVisibility;
  /** 0 = a binary page whose upload has not landed — invisible to every reader. */
  current_version: number;
  ratified_version: number | null;
  ratified_by: string | null;
  ratified_at: string | null;
  created_at: string;
  /** created_at of the latest version — the library's sort key. */
  updated_at: string;
  /** When the current published content went live (0035); NULL while draft. Ratify leaves it. */
  published_at: string | null;
  /** Soft delete (0035 PART D): set = the page is gone from every read; NULL = live. */
  deleted_at: string | null;
  /** The handle that deleted it (HANDLE_COLUMNS); NULL while live. */
  deleted_by: string | null;
}

export interface ArtifactVersionRow {
  id: number;
  page_id: number;
  version_no: number;
  summary: string;
  /** Text kinds only. */
  content: string | null;
  /** Binary kinds only: `artifacts/<sha256>`. */
  r2_key: string | null;
  size_bytes: number;
  content_type: string;
  sha256: string;
  filename: string | null;
  created_by: string;
  created_at: string;
}

export interface ArtifactLinkRow {
  page_id: number;
  target_type: ArtifactLinkType;
  /** ticket / sprint → the integer id as a string; pr / issue → "owner/repo#n". */
  target_ref: string;
  created_by: string;
  created_at: string;
}

export interface ArtifactUploadTokenRow {
  token_hash: string;
  principal: string;
  page_id: number;
  kind: ArtifactBinaryKind;
  size_bytes: number;
  sha256: string;
  content_type: string;
  filename: string | null;
  summary: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}
