// Doc images — the repository (spec: docs/superpowers/specs/2026-09-24-doc-images-design.md).
// An image is content-addressed and immutable: one `doc_images` row per (org, sha256), bytes in
// R2 at `doc-images/<sha256>` — the object is shared by every org that uploaded those bytes, the
// ROW is what makes an image an org's (C-10): no row in the caller's org, no image. Nothing here is ingestion — an upload is raw bytes, not
// proposed knowledge; the gate's part is refusing a doc proposal that references an
// image with no row (`docImageProblems`, called from ingestDocProposal), so a staged
// doc can never show a broken or third-party image.
//
// The upload is the artifact PUT's twin: MCP `upload_asset` (destination "doc") mints a
// single-use, 5-minute token bound to principal + sha256 + size + type, and the SAME
// route (`PUT /api/artifacts/upload/<token>`) consumes it — `consumeDocImageToken`
// returns null for a token it does not own, and the handler falls through to artifacts.

import { fanOut, first, run, nowIso, type TenantContext } from "../data/sql";
import { sha256Hex, randomToken } from "../auth/crypto";
import { ArtifactError } from "./artifacts";
import { ARTIFACT_BINARY_CAP, ARTIFACT_IMAGE_TYPES, ARTIFACT_UPLOAD_TTL_MS, SHA256_HEX_RE } from "@shared/artifacts";
import { docImageKey, docImageRef, scanDocImages } from "@shared/doc-images";

export interface DocImageRow {
  sha256: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: string;
}

export type DocImageMint =
  | { ref: string; sha256: string; uploaded: true }
  | { ref: string; sha256: string; uploaded: false; token: string; upload_url: string; expires_at: string };

const bad = (m: string): ArtifactError => new ArtifactError("bad_request", m);

/**
 * Validate the declared image and either say it is already stored IN THIS ORG (`uploaded: true` —
 * no PUT needed; the same bytes are the same image) or mint the PUT token. Another org's row never
 * counts: an org gets an image only by sending its bytes.
 */
export async function mintDocImageUpload(
  ctx: TenantContext, input: { size_bytes?: number; sha256?: string; content_type?: string }, principal: string
): Promise<DocImageMint> {
  const sha = String(input.sha256 ?? "").trim().toLowerCase();
  if (!SHA256_HEX_RE.test(sha)) throw bad("sha256 must be 64 hex characters (e.g. `shasum -a 256 <file>`)");
  const size = input.size_bytes;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) throw bad("size_bytes must be a positive integer");
  if (size > ARTIFACT_BINARY_CAP) throw new ArtifactError("too_large", `a doc image is at most ${ARTIFACT_BINARY_CAP} bytes (10 MB)`);
  const ct = String(input.content_type ?? "").trim().toLowerCase();
  if (!(ARTIFACT_IMAGE_TYPES as readonly string[]).includes(ct)) {
    throw bad(`a doc image's content_type must be one of ${ARTIFACT_IMAGE_TYPES.join(", ")}`);
  }
  const ref = docImageRef(sha);
  if (await first(ctx, `SELECT 1 AS x FROM doc_images WHERE sha256 = ? AND org_id = ?`, sha, ctx.orgId)) return { ref, sha256: sha, uploaded: true };
  const token = randomToken();
  const now = Date.now();
  const expires_at = new Date(now + ARTIFACT_UPLOAD_TTL_MS).toISOString();
  await run(
    ctx,
    `INSERT INTO doc_image_upload_tokens (org_id, token_hash, principal, sha256, size_bytes, content_type, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ctx.orgId, await sha256Hex(token), principal, sha, size, ct, expires_at, new Date(now).toISOString(),
  );
  return { ref, sha256: sha, uploaded: false, token, upload_url: `/api/artifacts/upload/${token}`, expires_at };
}

/**
 * The PUT for a doc-image token. `null` when the token is not a doc-image token OF THIS ORG (the
 * caller then tries artifacts). Otherwise: claim it (single use, unexpired), stream the
 * body through FixedLengthStream into R2 with R2's own sha256 check — always a put, so
 * knowing a hash never attaches bytes the caller does not have — then record the row
 * (INSERT OR IGNORE: a second upload of the same image is a no-op). Expired / used →
 * gone; a size or hash mismatch → bad_request, and the claim is released so the same
 * token can retry within its TTL.
 */
export async function consumeDocImageToken(
  ctx: TenantContext, bucket: R2Bucket, token: string, body: ReadableStream<Uint8Array> | null
): Promise<{ ref: string; sha256: string; size_bytes: number; content_type: string } | null> {
  const hash = await sha256Hex(String(token ?? ""));
  const t = await first<{ principal: string; sha256: string; size_bytes: number; content_type: string }>(
    ctx, `SELECT principal, sha256, size_bytes, content_type FROM doc_image_upload_tokens WHERE token_hash = ? AND org_id = ?`, hash, ctx.orgId,
  );
  if (!t) return null;
  const now = nowIso();
  const claim = await run(ctx, `UPDATE doc_image_upload_tokens SET used_at = ? WHERE token_hash = ? AND org_id = ? AND used_at IS NULL AND expires_at > ?`, now, hash, ctx.orgId, now);
  if (!claim.meta.changes) throw new ArtifactError("gone", "this upload link has expired or was already used");
  const release = () => run(ctx, `UPDATE doc_image_upload_tokens SET used_at = NULL WHERE token_hash = ? AND org_id = ? AND used_at = ?`, hash, ctx.orgId, now);
  if (!body) {
    await release();
    throw bad("the upload body is empty");
  }
  try {
    const fixed = new FixedLengthStream(t.size_bytes);
    const [piped, put] = await Promise.allSettled([
      body.pipeTo(fixed.writable),
      bucket.put(docImageKey(t.sha256), fixed.readable, { sha256: t.sha256, httpMetadata: { contentType: t.content_type } }),
    ]);
    if (piped.status === "rejected" || put.status === "rejected" || !put.value) throw new Error("upload stream failed");
  } catch {
    await release();
    throw bad("the upload did not match its declared size_bytes or sha256");
  }
  await run(
    ctx,
    `INSERT OR IGNORE INTO doc_images (org_id, sha256, content_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ctx.orgId, t.sha256, t.content_type, t.size_bytes, t.principal, now,
  );
  return { ref: docImageRef(t.sha256), sha256: t.sha256, size_bytes: t.size_bytes, content_type: t.content_type };
}

/**
 * The gate's image rule for a doc body, or null when it passes: every `/img/<sha>`
 * must be an image uploaded in this org, and no other image source is allowed (an external URL
 * would load a third party into every reader's browser and could change after the
 * doc is promoted). Code blocks are not scanned (see scanDocImages).
 */
export async function docImageProblems(ctx: TenantContext, body: string): Promise<string | null> {
  const { shas, others } = scanDocImages(body);
  const problems: string[] = [];
  if (others.length) {
    const shown = others.slice(0, 3).map((s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s) || "(empty)").join(", ");
    problems.push(`images must be uploaded to Trov (upload_asset with destination "doc") and referenced as /img/<sha256>; not allowed: ${shown}`);
  }
  if (shas.length) {
    const rows = await fanOut<{ sha256: string }>(ctx, shas, (ph) => `SELECT sha256 FROM doc_images WHERE org_id = ? AND sha256 IN (${ph})`, [ctx.orgId]);
    const found = new Set(rows.map((r) => r.sha256));
    const missing = shas.filter((s) => !found.has(s));
    if (missing.length) {
      problems.push(`not uploaded yet: ${missing.map(docImageRef).join(", ")} — upload each with upload_asset (destination "doc") and PUT the bytes first`);
    }
  }
  return problems.length ? problems.join("; ") : null;
}

/** Bytes + type for GET /img/<sha>, or null when the org has no such image. */
export async function readDocImage(ctx: TenantContext, bucket: R2Bucket, sha: string): Promise<{ body: ReadableStream; content_type: string; size_bytes: number } | null> {
  const row = await first<DocImageRow>(ctx, `SELECT * FROM doc_images WHERE sha256 = ? AND org_id = ?`, sha, ctx.orgId);
  if (!row) return null;
  const obj = await bucket.get(docImageKey(sha));
  if (!obj) return null;
  return { body: obj.body, content_type: row.content_type, size_bytes: row.size_bytes };
}
