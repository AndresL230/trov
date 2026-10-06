// The MCP artifact surface (issue #52 · Track C; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md, contract:
// docs/artifact-contract.md) — thin adapters over the repository in ./artifacts.ts.
//
// Every rule lives in the repository and is enforced there with the BEARER
// principal's handle as the viewer: visibility (private pages are their author's
// alone), the one not_found (missing slug, private-to-someone-else and a version-0
// page are indistinguishable), caps, the sha no-op, the status machine. What this
// module adds is only the agent's SHAPE of it:
//
//   • absolute links — `url` (the SPA page `<origin>/#artifacts/<slug>`), an absolute
//     `upload_url` for the binary PUT, an absolute `raw_url`;
//   • `warnings: string[]` on EVERY result — non-empty when text content calls into
//     something only claude.ai provides (`CLAUDE_ONLY_MARKERS`) or is a bundled Claude
//     Design export that must be flattened (`isBundledExport`). A warning, never a
//     rejection: the write has already happened;
//   • the input split between the text path (content / old_str+new_str) and the
//     binary path (size_bytes + sha256 → a single-use, 5-minute upload URL).
//
// There is deliberately NO ratify here and no path to `ratify()`: ratifying is a
// human act over a session-cookie route (POST /api/artifacts/:slug/ratify), exactly
// like /doc/:slug/promote and /adr/:id/ratify. Artifacts are authored writes in the
// promote class — nothing is staged, nothing goes through the ingestion gate.

import type { DB } from "../db";
import {
  ArtifactError, addLink, addTextVersion, createPage, getPage, listPages, mintUploadToken, versionFilename, writablePageKind,
} from "./artifacts";
import { downloadFilename, mintDownloadToken } from "../artifacts/download";
import { mintDocImageUpload } from "./doc-images";
import {
  ARTIFACT_INLINE_MAX, claudeOnlyHits, isBinaryKind, isBundledExport, isTextKind, parseSlugVersion,
  type ArtifactArea, type ArtifactDetailDTO, type ArtifactKind, type ArtifactLinkInput, type ArtifactLinkType,
  type ArtifactStatus, type ArtifactTextKind, type ArtifactVisibility,
} from "@shared/artifacts";

export interface ArtifactAgentCtx {
  db: DB;
  /** The bearer principal's handle — the author and the viewer of every call. */
  handle: string;
  /** Absolute origin for links (`env.PUBLIC_ORIGIN`, else the request's), no trailing slash. "" → relative. */
  origin: string;
  /** COOKIE_SECRET — the root the download-URL key is DERIVED from (src/artifacts/download.ts). Absent → no download_url. */
  downloadSecret?: string;
}

/** `PUBLIC_ORIGIN` wins; else the request's own origin; else "" (relative links). */
export function artifactOrigin(publicOrigin: string | undefined, requestOrigin: string | undefined): string {
  return (publicOrigin || requestOrigin || "").replace(/\/+$/, "");
}

const pageUrl = (ctx: ArtifactAgentCtx, slug: string): string => `${ctx.origin}/#artifacts/${slug}`;
const absolute = (ctx: ArtifactAgentCtx, path: string): string => `${ctx.origin}${path}`;
const bad = (m: string): ArtifactError => new ArtifactError("bad_request", m);

/** One warning per CLAUDE_ONLY_MARKERS hit in text content, plus one for a bundled Claude Design
 *  export. [] for binary / null content. */
export function artifactWarnings(content: string | null | undefined): string[] {
  if (typeof content !== "string") return [];
  const warnings = claudeOnlyHits(content).map(
    (m) => `content references \`${m}\`, which only exists inside claude.ai — it will not work in Trov's viewer`
  );
  if (isBundledExport(content)) {
    warnings.push(
      "content is a bundled Claude Design export: it loads its scripts from blob: URLs and compiles code at runtime, " +
        "which Trov's viewer blocks, so it will render blank — flatten it (every script inline, no eval) and add a new version"
    );
  }
  return warnings;
}

const BINARY_FIELDS = ["size_bytes", "sha256", "content_type", "filename"] as const;

// ── upload_asset (was artifact_create) ───────────────────────────────────
// ONE tool for everything an agent puts into Trov's asset stores, split by
// `destination`: "artifact" (the default) creates an artifact page exactly as
// artifact_create did; "doc" uploads an image a doc embeds as `![alt](/img/<sha256>)`
// (src/tools/doc-images.ts) — content-addressed, so a stored image needs no PUT.

export type AssetDestination = "artifact" | "doc";

export interface AgentCreateInput {
  destination?: AssetDestination;
  title?: string;
  kind?: ArtifactKind;
  content?: string;
  area?: ArtifactArea;
  repo?: string;
  visibility?: ArtifactVisibility;
  links?: ArtifactLinkInput[];
  summary?: string;
  size_bytes?: number;
  sha256?: string;
  content_type?: string;
  filename?: string;
}

export type AgentCreateResult =
  | { id: number; slug: string; url: string; version: number; warnings: string[] }
  | { id: number; slug: string; url: string; upload_url: string; expires_at: string; warnings: string[] }
  | { destination: "doc"; ref: string; markdown: string; sha256: string; uploaded: true; warnings: string[] }
  | { destination: "doc"; ref: string; markdown: string; sha256: string; uploaded: false; upload_url: string; expires_at: string; warnings: string[] };

/** Fields that only mean something for an artifact page — refused for a doc image. */
const PAGE_FIELDS = ["title", "area", "repo", "visibility", "links", "summary", "filename", "content"] as const;

export async function agentUploadAsset(ctx: ArtifactAgentCtx, input: AgentCreateInput): Promise<AgentCreateResult> {
  const destination = input.destination ?? "artifact";
  if (destination === "doc") {
    if (input.kind !== undefined && input.kind !== "image") throw bad(`destination "doc" is for images — kind must be "image" (or omitted)`);
    const extra = PAGE_FIELDS.filter((f) => input[f] !== undefined);
    if (extra.length) throw bad(`${extra.join(", ")} are for artifact pages — a doc image takes only size_bytes, sha256 and content_type`);
    const m = await mintDocImageUpload(ctx.db, input, ctx.handle);
    const markdown = `![<describe the image>](${m.ref})`;
    return m.uploaded
      ? { destination: "doc", ref: m.ref, markdown, sha256: m.sha256, uploaded: true, warnings: [] }
      : { destination: "doc", ref: m.ref, markdown, sha256: m.sha256, uploaded: false, upload_url: absolute(ctx, m.upload_url), expires_at: m.expires_at, warnings: [] };
  }
  if (destination !== "artifact") throw bad(`destination must be "artifact" or "doc"`);
  const missing = (["title", "kind", "area", "repo", "visibility"] as const).filter((f) => input[f] === undefined);
  if (missing.length) throw bad(`an artifact needs ${missing.join(", ")}`);
  return createArtifact(ctx, input as AgentCreateInput & { title: string; kind: ArtifactKind; area: ArtifactArea; repo: string; visibility: ArtifactVisibility });
}

async function createArtifact(
  ctx: ArtifactAgentCtx, input: AgentCreateInput & { title: string; kind: ArtifactKind; area: ArtifactArea; repo: string; visibility: ArtifactVisibility }
): Promise<AgentCreateResult> {
  const page = { title: input.title, area: input.area, repo: input.repo, visibility: input.visibility, links: input.links };
  if (isTextKind(input.kind)) {
    if (typeof input.content !== "string") throw bad(`a ${input.kind} artifact needs \`content\``);
    const extra = BINARY_FIELDS.filter((f) => input[f] !== undefined);
    if (extra.length) throw bad(`${extra.join(", ")} are for binary kinds (image, pdf, file) — a ${input.kind} artifact takes \`content\``);
    const d = await createPage(ctx.db, { ...page, kind: input.kind as ArtifactTextKind, content: input.content, summary: input.summary }, ctx.handle);
    return { id: d.id, slug: d.slug, url: pageUrl(ctx, d.slug), version: d.current_version, warnings: artifactWarnings(d.content) };
  }
  if (!isBinaryKind(input.kind)) throw bad("unknown kind");
  if (input.content !== undefined) throw bad(`a ${input.kind} artifact is uploaded, not inlined — pass size_bytes and sha256 instead of content`);
  if (input.size_bytes === undefined || input.sha256 === undefined) {
    throw bad(`a ${input.kind} artifact needs size_bytes and sha256 (e.g. \`shasum -a 256 <file>\`)`);
  }
  const t = await mintUploadToken(ctx.db, {
    ...page, kind: input.kind, size_bytes: input.size_bytes, sha256: input.sha256,
    content_type: input.content_type, filename: input.filename, summary: input.summary,
  }, ctx.handle);
  return { id: t.id, slug: t.slug, url: pageUrl(ctx, t.slug), upload_url: absolute(ctx, t.upload_url), expires_at: t.expires_at, warnings: [] };
}

// ── artifact_update ──────────────────────────────────────────────────────────

export interface AgentUpdateInput {
  slug: string;
  summary: string;
  content?: string;
  old_str?: string;
  new_str?: string;
  size_bytes?: number;
  sha256?: string;
  content_type?: string;
  filename?: string;
}

export type AgentUpdateResult =
  | { id: number; slug: string; url: string; version: number; unchanged: boolean; warnings: string[] }
  | { id: number; slug: string; url: string; upload_url: string; expires_at: string; warnings: string[] };

export async function agentArtifactUpdate(ctx: ArtifactAgentCtx, input: AgentUpdateInput): Promise<AgentUpdateResult> {
  // The page's kind decides the path. Resolved through the repository's visibility
  // rule FIRST, so a private / missing / pending-for-someone-else slug is the one
  // not_found before any input-shape error could hint at what the page is.
  const kind = await writablePageKind(ctx.db, input.slug, ctx.handle);
  const hasText = input.content !== undefined || input.old_str !== undefined || input.new_str !== undefined;
  if (isTextKind(kind)) {
    const extra = BINARY_FIELDS.filter((f) => input[f] !== undefined);
    if (extra.length) throw bad(`${extra.join(", ")} are for binary kinds — this is a ${kind} artifact; pass content, or old_str and new_str`);
    let edit: { content: string; summary: string } | { old_str: string; new_str: string; summary: string };
    if (input.content !== undefined) {
      if (input.old_str !== undefined || input.new_str !== undefined) throw bad("give content OR old_str and new_str, not both");
      edit = { content: input.content, summary: input.summary };
    } else if (input.old_str !== undefined && input.new_str !== undefined) {
      if (input.old_str === "") throw bad("old_str must not be empty");
      edit = { old_str: input.old_str, new_str: input.new_str, summary: input.summary };
    } else {
      throw bad("give content, or old_str and new_str (old_str must occur exactly once in the latest version)");
    }
    const r = await addTextVersion(ctx.db, input.slug, edit, ctx.handle);
    return {
      id: r.page.id, slug: r.page.slug, url: pageUrl(ctx, r.page.slug), version: r.version_no, unchanged: r.unchanged,
      warnings: artifactWarnings(r.page.content),
    };
  }
  if (!isBinaryKind(kind)) throw bad("unknown kind");
  if (hasText) throw bad(`this is a ${kind} artifact — upload a new file with size_bytes and sha256, not text`);
  if (input.size_bytes === undefined || input.sha256 === undefined) throw bad(`a new ${kind} version needs size_bytes and sha256`);
  const t = await mintUploadToken(ctx.db, {
    slug: input.slug, kind, size_bytes: input.size_bytes, sha256: input.sha256,
    content_type: input.content_type, filename: input.filename, summary: input.summary,
  }, ctx.handle);
  return { id: t.id, slug: t.slug, url: pageUrl(ctx, t.slug), upload_url: absolute(ctx, t.upload_url), expires_at: t.expires_at, warnings: [] };
}

// ── artifact_get ─────────────────────────────────────────────────────────────

export type AgentGetResult = ArtifactDetailDTO & {
  url: string;
  warnings: string[];
  /** Absolute, signed, reusable for 5 minutes: a plain GET (no header) returns the exact stored bytes of THIS version. */
  download_url: string | null;
  download_expires_at: string | null;
  /** The name the download's Content-Disposition carries: the stored filename, else `<slug>-v<n>.<ext>`. */
  download_filename: string;
  /** SHA-256 (hex) of THIS version's bytes — what the download must hash to. */
  sha256: string;
  /**
   * true when a text version over ARTIFACT_INLINE_MAX came back with `content: null` because
   * `include_content` was not true — fetch `download_url` instead. false on every other result.
   */
  content_omitted: boolean;
};

/**
 * `slug`, `slug@v3` or `slug/v3`; an explicit `version` must agree with an embedded one.
 * Adds (Track F) a signed `download_url` for EVERY kind, and the requested version's
 * `sha256` + `size_bytes` at the top level so the agent can verify what it downloaded.
 * NOTE: top-level `size_bytes` is the REQUESTED version's here (the library DTO's is the
 * latest's) — identical unless an older version was asked for.
 * A text version over ARTIFACT_INLINE_MAX bytes is NOT inlined unless `include_content: true`
 * (`content: null`, `content_omitted: true`): a tool result lands whole in the agent's context,
 * and the file is one `download_url` away. `warnings` are computed over the full text either way.
 */
export async function agentArtifactGet(
  ctx: ArtifactAgentCtx,
  input: { slug: string; version?: number; include_content?: boolean },
): Promise<AgentGetResult> {
  const parsed = parseSlugVersion(String(input.slug ?? "").trim());
  if (!parsed) throw new ArtifactError("not_found", "not_found");
  if (input.version !== undefined && parsed.version !== null && input.version !== parsed.version) {
    throw bad(`the slug names v${parsed.version} but version is ${input.version}`);
  }
  const d = await getPage(ctx.db, parsed.slug, input.version ?? parsed.version, ctx.handle);
  const v = d.version;
  const filename = await versionFilename(ctx.db, d.id, v.version_no);
  const omit = isTextKind(d.kind) && typeof d.content === "string" && v.size_bytes > ARTIFACT_INLINE_MAX && input.include_content !== true;
  const dl = ctx.downloadSecret
    ? await mintDownloadToken(ctx.downloadSecret, { handle: ctx.handle, page_id: d.id, version_no: v.version_no })
    : null;
  return {
    ...d,
    content: omit ? null : d.content,
    content_omitted: omit,
    size_bytes: v.size_bytes,
    sha256: v.sha256,
    raw_url: absolute(ctx, d.raw_url),
    url: pageUrl(ctx, d.slug),
    download_url: dl ? absolute(ctx, `/api/artifacts/download/${dl.token}`) : null,
    download_expires_at: dl ? dl.expires_at : null,
    download_filename: downloadFilename({ slug: d.slug, version_no: v.version_no, kind: d.kind, content_type: v.content_type, filename }),
    warnings: artifactWarnings(d.content),
  };
}

// ── artifact_list ────────────────────────────────────────────────────────────

export interface AgentListInput {
  q?: string;
  kind?: string;
  area?: string;
  author?: string;
  status?: string;
  ticket?: string | number;
  sprint?: string | number;
  limit?: number;
}

export interface AgentListItem {
  slug: string;
  title: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  version: number;
  updated_at: string;
  url: string;
  area: string;
  author: string;
  visibility: ArtifactVisibility;
}

export const ARTIFACT_LIST_DEFAULT = 25;
export const ARTIFACT_LIST_MAX = 100;

/**
 * The pages `ctx.handle` can see, newest first — the repository's `listPages` (the SAME
 * filters and visibility rule as the web library), cut to `limit`. `total` is the full
 * count, `truncated` whether anything was cut. (Track F, 2026-09-24.)
 */
export async function agentArtifactList(
  ctx: ArtifactAgentCtx, input: AgentListInput = {}
): Promise<{ artifacts: AgentListItem[]; total: number; truncated: boolean }> {
  const str = (x: string | number | undefined): string | undefined => (x === undefined ? undefined : String(x));
  const pages = await listPages(ctx.db, {
    q: input.q, kind: input.kind, area: input.area, author: input.author, status: input.status,
    ticket: str(input.ticket), sprint: str(input.sprint),
  }, ctx.handle);
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? ARTIFACT_LIST_DEFAULT)), ARTIFACT_LIST_MAX);
  const artifacts = pages.slice(0, limit).map((p) => ({
    slug: p.slug, title: p.title, kind: p.kind, status: p.status, version: p.current_version, updated_at: p.updated_at,
    url: pageUrl(ctx, p.slug), area: p.area, author: p.author_id, visibility: p.visibility,
  }));
  return { artifacts, total: pages.length, truncated: pages.length > limit };
}

// ── reads other tools borrow ─────────────────────────────────────────────────

export interface TicketArtifactRef { slug: string; title: string; kind: ArtifactKind; status: ArtifactStatus; version: number }

/** The pages linked to a ticket that `handle` can see (private ones only to their author). */
export async function artifactsForTicket(db: DB, ticketId: number, handle: string): Promise<TicketArtifactRef[]> {
  const pages = await listPages(db, { ticket: String(ticketId) }, handle);
  return pages.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, status: p.status, version: p.current_version }));
}

// ── record_session / /ingest: artifact_links ─────────────────────────────────

export interface ArtifactLinkRequest { slug: string; target_type: ArtifactLinkType; target_ref: string }
export type ArtifactLinkOutcome = ArtifactLinkRequest & (
  | { outcome: "linked" }
  | { outcome: "not_found" }
  | { outcome: "error"; error: string }
);

/**
 * Apply a batch's `artifact_links` AFTER the batch was reconciled. Each is a DIRECT
 * authored write through the repository's `addLink` under `handle` (the same read
 * check as the web: a page the caller cannot see is `not_found`) — not an ingested
 * item, so no ledger: `addLink` is idempotent, which is what makes a replay safe.
 * One failure never stops the rest.
 */
export async function applyArtifactLinks(db: DB, links: readonly ArtifactLinkRequest[], handle: string): Promise<ArtifactLinkOutcome[]> {
  const out: ArtifactLinkOutcome[] = [];
  for (const l of links) {
    const base = { slug: l.slug, target_type: l.target_type, target_ref: l.target_ref };
    try {
      await addLink(db, l.slug, { target_type: l.target_type, target_ref: l.target_ref }, handle);
      out.push({ ...base, outcome: "linked" });
    } catch (e) {
      if (e instanceof ArtifactError && e.code === "not_found") out.push({ ...base, outcome: "not_found" });
      else out.push({ ...base, outcome: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
