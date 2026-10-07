// The organization's image (0042_organizations) — the repository behind `POST /api/o/:slug/logo[/remove]`,
// `GET /org-logo/<sha>` and the GitHub import. The contract is `shared/orgs.ts`. A PLATFORM module:
// `orgs` is a global table; a function that acts inside one org also takes the caller's TenantContext.
//
// An image is the person photo's sibling (src/tools/people.ts): content-addressed and immutable, bytes
// in R2 (`ARTIFACTS_BUCKET`) at `org-logos/<sha256>`, never deleted, checked by the SAME code
// (`checkedImage` — type allowlist, no SVG; the magic bytes; `AVATAR_MAX_BYTES`). `orgs.logo_sha` says
// which one an org shows, `orgs.logo_source` where it came from:
//   'upload'  an admin's or owner's (`setOrgLogo`); `logo_by` is who.
//   'github'  the avatar of the org's PRIMARY repository's owner (`importOrgLogo`); `logo_from` is that login.
//   NULL      none — the SPA draws the initial tile.
//
// THE RULE (`IMPORTABLE`, one SQL predicate used by the read that decides and the UPDATE that writes):
// an import writes only while the source is NULL or 'github'. So:
//   none   → github   the first import
//   github → github   a refresh, when the owner's avatar (or the primary repo's owner) changed
//   upload → upload   the import is skipped before anything is fetched; an upload is never replaced
//   upload → none     `removeOrgLogo` — which re-enables the import; the route runs it at once
// Removing is an UPLOAD's alone: an imported image is replaced by uploading one (removing it would only
// bring it back at the next reconcile). Disconnecting the repository imports nothing and KEEPS the image
// the org already shows; a new primary repository's owner replaces an imported one at the next import.
//
// The import never trusts GitHub's answer further than it must: ONE fixed lookup host, the avatar only
// from `https://avatars.githubusercontent.com`, no redirect followed, a size cap, the type read from the
// bytes, a timeout. It is TOTAL — a failure changes nothing, is logged without the upstream's words
// (and with the token scrubbed from a thrown fetch), and never reaches the caller as a throw.
// This module must stay free of `src/data/secrets.ts`: the token is resolved by the caller
// (src/integrations/logo.ts, which MCP cannot reach) and passed down.
import { type PlatformContext, first, stmt, batch, nowIso } from "../data/platform-sql";
import { requireRole, type TenantContext } from "../data/context";
import { checkedImage, readImage, sniffAvatarType, storeImage, type UploadedFile } from "../tools/people";
import { sha256Hex } from "../tools/artifacts";
import { scrubbedMessage } from "../repo/github";
import { ORG_LOGO_MAX_BYTES, orgLogoOf, type OrgLogo, type OrgLogoSource } from "@shared/orgs";
import { auditStmt } from "./repo";

const SHA_RE = /^[0-9a-f]{64}$/;
export const orgLogoKey = (sha: string): string => `org-logos/${sha}`;

interface LogoRow { logo_sha: string | null; logo_source: OrgLogoSource | null; logo_by: string | null; logo_from: string | null; logo_at: string | null }
const LOGO_COLS = `logo_sha, logo_source, logo_by, logo_from, logo_at`;

export async function getOrgLogo(p: PlatformContext, orgId: string): Promise<OrgLogo> {
  return orgLogoOf(await first<LogoRow>(p, `SELECT ${LOGO_COLS} FROM orgs WHERE id = ?`, orgId));
}

/**
 * Upload the org's image (admin+): checked like a person's photo, stored at `org-logos/<sha256>`, then
 * the org points at it as an UPLOAD — whatever it showed before, and out of the import's reach.
 * Throws `RoleError`, or the check's `PeopleError`.
 */
export async function setOrgLogo(p: PlatformContext, ctx: TenantContext, bucket: R2Bucket, file: UploadedFile | null): Promise<OrgLogo> {
  requireRole(ctx, "admin");
  const img = await checkedImage(file, "an org image");
  await storeImage(bucket, orgLogoKey(img.sha), img);
  const at = nowIso();
  await batch(p, [
    stmt(p, `UPDATE orgs SET logo_sha = ?, logo_source = 'upload', logo_by = ?, logo_from = NULL, logo_at = ? WHERE id = ?`, img.sha, ctx.userId, at, ctx.orgId),
    auditStmt(p, ctx.orgId, "org.logo.set", "logo", { sha: img.sha, type: img.type, bytes: img.bytes.byteLength }, at),
  ]);
  return getOrgLogo(p, ctx.orgId);
}

/**
 * Remove the org's UPLOADED image (admin+; the R2 bytes stay). The org then has none, which re-enables
 * the import — the route tries it at once. An org showing an imported image, or none, is left as it is
 * (`false`, nothing audited).
 */
export async function removeOrgLogo(p: PlatformContext, ctx: TenantContext): Promise<boolean> {
  requireRole(ctx, "admin");
  const row = await first<LogoRow>(p, `SELECT ${LOGO_COLS} FROM orgs WHERE id = ?`, ctx.orgId);
  if (row?.logo_source !== "upload") return false;
  await batch(p, [
    stmt(p, `UPDATE orgs SET logo_sha = NULL, logo_source = NULL, logo_by = NULL, logo_from = NULL, logo_at = NULL WHERE id = ? AND logo_source = 'upload'`, ctx.orgId),
    auditStmt(p, ctx.orgId, "org.logo.remove", "logo", { sha: row.logo_sha }),
  ]);
  return true;
}

/** Bytes + type for GET /org-logo/<sha>, or null (malformed sha, no object, or not an image type). */
export async function readOrgLogo(bucket: R2Bucket, sha: string): Promise<{ body: ReadableStream; content_type: string; size_bytes: number } | null> {
  return SHA_RE.test(sha) ? readImage(bucket, orgLogoKey(sha)) : null;
}

// ── the GitHub import ────────────────────────────────────────────────────────

/** THE rule, as SQL over `orgs`: may an import write this row? Never over an upload. */
const IMPORTABLE = `(logo_source IS NULL OR logo_source = 'github')`;

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";
/** Each of the import's requests is bounded, like every other GitHub read. */
export const LOGO_FETCH_TIMEOUT_MS = 5_000;
/** The side the avatar is asked for at (GitHub's `s`): what the SPA's own upload is cropped to. */
export const LOGO_IMPORT_SIDE = 512;
/** Worst-case outbound requests of one import: the owner lookup, its unauthenticated retry, the avatar. */
export const LOGO_IMPORT_COST = 3;
// GitHub's own login shape (src/integrations/settings.ts `REPO_FULL_NAME`).
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type LogoImportStatus = "imported" | "unchanged" | "kept_upload" | "no_repo" | "no_token" | "failed";
/** What one import came to. `reason` is one of this module's fixed phrases — never upstream text. */
export interface LogoImport { status: LogoImportStatus; reason?: string }

/** The avatar URL GitHub named, if it is one this Worker will fetch: https, exactly the avatar host,
 *  no port and no credentials. Returned with the size pinned (`s`), or null. */
export function checkAvatarUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== GITHUB_AVATAR_HOST || u.port || u.username || u.password) return null;
  u.searchParams.set("s", String(LOGO_IMPORT_SIDE));
  u.hash = "";
  return u;
}

/** A response body, read up to `max` bytes; null when it is longer (the rest is cancelled, not read). */
async function cappedBytes(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export interface LogoImportOpts {
  /** The org's primary repository (`owner/repo`), or null when it has none. */
  repo: string | null;
  /** The org's GitHub token, already revealed by a caller allowed to; absent = an unauthenticated lookup. */
  token?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Import the avatar of the primary repository's OWNER (a GitHub user or organization) as the org's
 * image — THE one function an import goes through, whoever asked (a repo connected or made primary, the
 * token set or rotated, the periodic reconcile, an upload removed). It writes ONLY `orgId`'s row, and
 * only while `IMPORTABLE` holds — checked before anything is fetched, and again in the UPDATE itself, so
 * an upload that lands while the avatar is in flight still wins.
 *
 * `GET api.github.com/users/<owner>` (with the token when there is one; once more without it on a 401,
 * so a dead token does not cost a public owner's image) → its `avatar_url` (`checkAvatarUrl`) → the
 * bytes, with NO credential. Neither request follows a redirect. TOTAL: never throws.
 */
export async function importOrgLogo(p: PlatformContext, bucket: R2Bucket, orgId: string, opts: LogoImportOpts): Promise<LogoImport> {
  const token = opts.token || null;
  const failed = (reason: string): LogoImport => {
    console.error("org logo import", reason, `org=${orgId}`);
    return { status: "failed", reason };
  };
  try {
    if (!opts.repo) return { status: "no_repo" };
    const owner = opts.repo.split("/")[0] ?? "";
    if (!OWNER_RE.test(owner)) return failed("not a GitHub owner");
    const cur = await first<{ logo_sha: string | null; importable: number }>(p, `SELECT logo_sha, ${IMPORTABLE} AS importable FROM orgs WHERE id = ?`, orgId);
    if (!cur) return failed("no such org");
    if (!cur.importable) return { status: "kept_upload" };

    const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    const lookup = (withToken: boolean) => doFetch(`${GITHUB_API_ORIGIN}/users/${owner}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "trov-worker", ...(withToken && token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: "manual", signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
    });
    let res = await lookup(true);
    if (token && res.status === 401) res = await lookup(false);
    if (res.status !== 200) return failed(`owner lookup answered ${res.status}`);
    const profile = (await res.json().catch(() => null)) as { login?: unknown; avatar_url?: unknown } | null;
    const url = checkAvatarUrl(profile?.avatar_url);
    if (!url) return failed("the avatar is not on GitHub's avatar host");

    const got = await doFetch(url.toString(), { headers: { accept: "image/*", "user-agent": "trov-worker" }, redirect: "manual", signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
    if (got.status !== 200) return failed(`avatar answered ${got.status}`);
    const bytes = await cappedBytes(got, ORG_LOGO_MAX_BYTES);
    if (!bytes) return failed("the avatar is too large");
    const type = sniffAvatarType(bytes);
    if (!type) return failed("the avatar is not an image");
    const sha = await sha256Hex(bytes);
    if (sha === cur.logo_sha) return { status: "unchanged" };

    await storeImage(bucket, orgLogoKey(sha), { bytes, type, sha });
    const from = typeof profile?.login === "string" && OWNER_RE.test(profile.login) ? profile.login : owner;
    const at = nowIso();
    const [write] = await batch(p, [
      stmt(p, `UPDATE orgs SET logo_sha = ?, logo_source = 'github', logo_by = NULL, logo_from = ?, logo_at = ? WHERE id = ? AND ${IMPORTABLE}`, sha, from, at, orgId),
      // Audited only when the UPDATE above took (same batch): the row then carries exactly this import.
      stmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
               SELECT ?, ?, 'org.logo.import', 'logo', ?, ? WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ? AND logo_source = 'github' AND logo_sha = ? AND logo_at = ?)`,
        orgId, p.actor, JSON.stringify({ sha, from }), at, orgId, sha, at),
    ]);
    return (write?.meta.changes ?? 0) > 0 ? { status: "imported" } : { status: "kept_upload" };
  } catch (e) {
    // A thrown fetch can quote its own request back — so the message is scrubbed of the token.
    return failed(scrubbedMessage(e, token ?? ""));
  }
}
