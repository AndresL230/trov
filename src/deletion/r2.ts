// R2 after a deletion (docs/architecture/organizations.md › What deletion removes and what it keeps). Every
// object Trov stores is CONTENT-ADDRESSED — `artifacts/<sha256>`, `doc-images/<sha256>`, `org-logos/<sha256>`,
// `avatars/<sha256>` — so two organizations (or two people) that stored the same bytes share ONE object. An
// object is deleted only when, after the deletion's batch has committed, no row anywhere still points at it
// and no upload of the same bytes is in flight; anything else is left alone.
//
// The order is the rule: D1 first, R2 after. A failure here leaves an orphaned object (bytes nothing points
// at), never a row pointing at bytes that are gone. Best effort: it never throws, and says what it did.
//
// Residual race, accepted and documented: an upload of the SAME bytes that starts after the check below and
// lands before the delete (a few milliseconds) would find its object gone. Artifact and doc-image uploads
// register a single-use token in D1 before their bytes arrive, and an unexpired token counts as a reference,
// which closes most of that window; a photo or an org image has no token.
import { type PlatformContext, fanOut, nowIso } from "../data/platform-sql";
import { avatarKey } from "../tools/people";
import { orgLogoKey } from "../orgs/logo";
import { docImageKey } from "@shared/doc-images";

const SHA_RE = /^[0-9a-f]{64}$/;
const shaOf = (key: string, prefix: string): string | null => {
  const sha = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  return SHA_RE.test(sha) ? sha : null;
};

/** The R2 objects a deletion may free, by kind (shas, not keys). */
export interface R2Candidates { artifacts: string[]; docImages: string[]; orgLogos: string[]; avatars: string[] }
export const noCandidates = (): R2Candidates => ({ artifacts: [], docImages: [], orgLogos: [], avatars: [] });

/** `artifact_versions.r2_key` values (`artifacts/<sha>`) as shas. */
export const artifactShas = (keys: (string | null)[]): string[] =>
  [...new Set(keys.map((k) => (k ? shaOf(k, "artifacts/") : null)).filter((s): s is string => s !== null))];

/** Which of `shas` something still references — any org's row, or an upload still in flight. Cross-org on
 *  purpose (test/data-layer.static.test.ts allows it): a yes / no per sha, no content read. */
async function stillReferenced(p: PlatformContext, c: R2Candidates, now: string): Promise<Set<string>> {
  const held = new Set<string>();
  const add = (rows: { sha: string }[], prefix: string) => rows.forEach((r) => held.add(`${prefix}${r.sha}`));
  add(await fanOut<{ sha: string }>(p, c.artifacts.map((s) => `artifacts/${s}`),
    (ph) => `SELECT substr(r2_key, 11) AS sha FROM artifact_versions WHERE r2_key IN (${ph})`), "a:");
  add(await fanOut<{ sha: string }>(p, c.artifacts,
    (ph) => `SELECT sha256 AS sha FROM artifact_upload_tokens WHERE used_at IS NULL AND expires_at > ? AND sha256 IN (${ph})`, [now]), "a:");
  add(await fanOut<{ sha: string }>(p, c.docImages,
    (ph) => `SELECT sha256 AS sha FROM doc_images WHERE sha256 IN (${ph})`), "d:");
  add(await fanOut<{ sha: string }>(p, c.docImages,
    (ph) => `SELECT sha256 AS sha FROM doc_image_upload_tokens WHERE used_at IS NULL AND expires_at > ? AND sha256 IN (${ph})`, [now]), "d:");
  add(await fanOut<{ sha: string }>(p, c.orgLogos,
    (ph) => `SELECT logo_sha AS sha FROM orgs WHERE logo_sha IN (${ph})`), "l:");
  add(await fanOut<{ sha: string }>(p, c.avatars,
    (ph) => `SELECT avatar_sha AS sha FROM persons WHERE avatar_sha IN (${ph})`), "p:");
  return held;
}

export interface R2Sweep { deleted: string[]; kept: string[]; failed: number }

/**
 * Delete each candidate object nothing references any more. Called AFTER the deletion's batch committed.
 * R2's own multi-key delete (up to 1,000 keys a call) keeps the number of calls small for a big org.
 */
export async function sweepR2(p: PlatformContext, bucket: R2Bucket | undefined, c: R2Candidates, now: string = nowIso()): Promise<R2Sweep> {
  const out: R2Sweep = { deleted: [], kept: [], failed: 0 };
  const all = [
    ...c.artifacts.filter((s) => SHA_RE.test(s)).map((s) => ({ ref: `a:${s}`, key: `artifacts/${s}` })),
    ...c.docImages.filter((s) => SHA_RE.test(s)).map((s) => ({ ref: `d:${s}`, key: docImageKey(s) })),
    ...c.orgLogos.filter((s) => SHA_RE.test(s)).map((s) => ({ ref: `l:${s}`, key: orgLogoKey(s) })),
    ...c.avatars.filter((s) => SHA_RE.test(s)).map((s) => ({ ref: `p:${s}`, key: avatarKey(s) })),
  ];
  if (!all.length || !bucket) return out;
  let held: Set<string>;
  try {
    held = await stillReferenced(p, c, now);
  } catch (e) {
    console.error("deletion: R2 reference check failed; nothing deleted from R2", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return { ...out, kept: all.map((x) => x.key), failed: all.length };
  }
  const free = all.filter((x) => !held.has(x.ref)).map((x) => x.key);
  out.kept = all.filter((x) => held.has(x.ref)).map((x) => x.key);
  for (let i = 0; i < free.length; i += 1000) {
    const chunk = free.slice(i, i + 1000);
    try {
      await bucket.delete(chunk);
      out.deleted.push(...chunk);
    } catch (e) {
      out.failed += chunk.length; // orphaned bytes: acceptable (nothing points at them), and logged
      console.error("deletion: R2 delete failed", chunk.length, e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
  }
  return out;
}
