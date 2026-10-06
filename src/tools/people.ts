// Person profiles (0036) — the repository behind `GET|PUT /api/people/:handle`, the avatar
// upload and `GET /avatar/<sha>`, and MCP `list_people`. The contract is `shared/people.ts`.
//
// Every write here is a DIRECT AUTHORED write — no gate, no staging, no MCP counterpart.
// A person changes only their own PHOTO; role and responsibilities are ADMIN-set (the
// owner's call, 2026-09-27 — Maintenance › People), never by the person themselves. The ONE agent surface is the read `listPeopleForAgents`
// (handle, name, role, responsibilities — nothing else about a person reaches MCP).
//
// A person is ONE row across every org; what an org sees of them is its MEMBERS, and the role
// and responsibilities are per org (Q9): `memberships.title` (it still travels as `role`) and
// `memberships.responsibilities`. A person who is not a member of the context's org is
// `not_found` here, exactly like an unknown handle. The photo is the person's own, in every org.
//
// An avatar is content-addressed and immutable, like a doc image: bytes in R2
// (`ARTIFACTS_BUCKET`) at `avatars/<sha256>`, never deleted — "remove" only clears
// `persons.avatar_sha`, so the provider picture shows again. There is no avatars table:
// the R2 object's own `httpMetadata.contentType` (the SNIFFED type) is what is served.

import { type TenantContext, all, stmt, batch, nowIso } from "../data/sql";
import { hasRole } from "../data/context";
import { type PlatformContext, first as platformFirst, run as platformRun } from "../data/platform-sql";
import { RESERVED_HANDLES, memberHandle } from "../auth/persons";
import { sha256Hex } from "./artifacts";
import type { PersonColor } from "@shared/rows";
import {
  AVATAR_MAX_BYTES, AVATAR_TYPES, RESPONSIBILITIES_MAX, ROLE_MAX, avatarSrc,
  type AvatarType, type PersonForAgents, type PersonProfile, type PersonProfileWrite,
} from "@shared/people";

export type PeopleErrorCode = "not_found" | "forbidden" | "bad_request" | "too_large";
export class PeopleError extends Error {
  constructor(readonly code: PeopleErrorCode, message: string) { super(message); }
}
export const PEOPLE_ERROR_STATUS: Record<PeopleErrorCode, 400 | 403 | 404 | 413> = {
  not_found: 404, forbidden: 403, bad_request: 400, too_large: 413,
};

const SHA_RE = /^[0-9a-f]{64}$/;
export const avatarKey = (sha: string): string => `avatars/${sha}`;
const isReserved = (h: string): boolean => RESERVED_HANDLES.includes(h.toLowerCase());
const sameHandle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

interface ProfileRow {
  handle: string; name: string | null; color: PersonColor; avatar_url: string | null; avatar_sha: string | null;
  role: string | null; responsibilities: string | null; created_at: string; org_role: "owner" | "admin" | "member";
}

/**
 * The person card of `handle` as `viewer` sees it (the modal a click on a name opens, and
 * Maintenance › People's editor). An unknown or RESERVED handle is `not_found` (a system
 * principal is not a person). `responsibilities` travels only to admins — the editor fills
 * from it; no page renders it, and the person themselves does not get it (they cannot edit
 * it). "Admin" is the ORG role (§5.2): `editable` is the caller's (`ctx.role` admin or owner),
 * `admin` the viewed member's. D1 only: the member and their GitHub login in ONE batch.
 */
export async function getPersonProfile(ctx: TenantContext, handle: string, viewer: string): Promise<PersonProfile> {
  if (isReserved(handle)) throw new PeopleError("not_found", "not found");
  const [p, g] = await batch(ctx, [
      stmt(ctx, `SELECT p.handle, p.name, p.color, p.avatar_url, p.avatar_sha, m.title AS role, m.responsibilities, p.created_at, m.role AS org_role
                   FROM persons p JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
                  WHERE p.handle = ? COLLATE NOCASE`, ctx.orgId, handle),
      stmt(ctx, `SELECT subject FROM identities WHERE provider = 'github' AND person = ? COLLATE NOCASE
                  ORDER BY linked_at ASC LIMIT 1`, handle),
  ]);
  const person = p.results?.[0] as ProfileRow | undefined;
  const gh = g.results?.[0] as { subject: string } | undefined;
  if (!person) throw new PeopleError("not_found", "not found");
  const self = sameHandle(person.handle, viewer);
  const editor = hasRole(ctx, "admin");
  return {
    handle: person.handle,
    name: person.name,
    color: person.color,
    avatar_url: avatarSrc(person),
    role: person.role,
    github: gh?.subject ?? null,
    joined: person.created_at,
    admin: person.org_role === "owner" || person.org_role === "admin",
    editable: editor,
    self,
    ...(editor ? { responsibilities: person.responsibilities } : {}),
  };
}

/** One field of a `PersonProfileWrite`: absent = untouched, "" / null = clear, over the cap = refused. */
function field(v: unknown, name: string, max: number): { set: false } | { set: true; value: string | null } {
  if (v === undefined) return { set: false };
  if (v === null) return { set: true, value: null };
  if (typeof v !== "string") throw new PeopleError("bad_request", `${name} must be a string or null`);
  const t = v.trim();
  if (t.length > max) throw new PeopleError("bad_request", `${name} is at most ${max} characters`);
  return { set: true, value: t === "" ? null : t };
}

/**
 * `PUT /api/people/:handle` — the cut-over alias of `PUT /api/o/:slug/members/:handle` for a member's
 * TITLE (it travels as `role` here) and responsibilities: the org's admins and owners only (§5.2);
 * anyone else, the person themselves included, is `forbidden` and nothing is written. It never changes a
 * member's org role — that is the members route's alone. Every field is validated BEFORE the one UPDATE,
 * so an over-cap value writes nothing (not even the other, valid field). The write lands on the
 * person's MEMBERSHIP of this org, so it says nothing about them anywhere else, and is audited as the
 * members route audits it (`member.update`: the title, and the FACT that responsibilities changed).
 */
export async function writePersonProfile(ctx: TenantContext, handle: string, viewer: string, body: unknown): Promise<PersonProfile> {
  if (isReserved(handle)) throw new PeopleError("not_found", "not found");
  const member = await memberHandle(ctx, handle);
  if (!member) throw new PeopleError("not_found", "not found");
  const person = { handle: member };
  if (!hasRole(ctx, "admin")) throw new PeopleError("forbidden", "only an admin may set a person's role and responsibilities");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PeopleError("bad_request", "the body must be a JSON object");
  const b = body as PersonProfileWrite;
  const role = field(b.role, "role", ROLE_MAX);
  const resp = field(b.responsibilities, "responsibilities", RESPONSIBILITIES_MAX);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (role.set) { sets.push("title = ?"); binds.push(role.value); }
  if (resp.set) { sets.push("responsibilities = ?"); binds.push(resp.value); }
  if (sets.length) {
    const detail = { ...(role.set ? { title: role.value } : {}), ...(resp.set ? { responsibilities: true } : {}) };
    await batch(ctx, [
      stmt(ctx, `UPDATE memberships SET ${sets.join(", ")} WHERE org_id = ? AND user_id = ?`, ...binds, ctx.orgId, person.handle),
      stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'member.update', ?, ?, ?)`,
        ctx.orgId, ctx.userId, person.handle, JSON.stringify(detail), nowIso()),
    ]);
  }
  return getPersonProfile(ctx, person.handle, viewer);
}

/**
 * The image type the BYTES say, or null. The declared type is never trusted: an upload
 * is accepted only when its magic bytes name the same type it declared.
 */
export function sniffAvatarType(b: Uint8Array): AvatarType | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (ch) => ch.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * The viewer's OWN avatar (there is no upload for someone else): type declared in
 * `AVATAR_TYPES` AND confirmed by the magic bytes, ≤ `AVATAR_MAX_BYTES`, stored at
 * `avatars/<sha256>` with R2's own sha256 check — skipped when that object already
 * exists (the same bytes are the same image) — then `persons.avatar_sha` points at it.
 */
export async function setAvatar(
  p: PlatformContext, bucket: R2Bucket, viewer: string, file: { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null,
): Promise<{ avatar_url: string }> {
  if (!file) throw new PeopleError("bad_request", "a `file` part is required");
  if (file.size > AVATAR_MAX_BYTES) throw new PeopleError("too_large", `an avatar is at most ${AVATAR_MAX_BYTES} bytes`);
  if (file.size === 0) throw new PeopleError("bad_request", "the file is empty");
  const declared = file.type.trim().toLowerCase();
  if (!(AVATAR_TYPES as readonly string[]).includes(declared)) {
    throw new PeopleError("bad_request", `an avatar must be one of ${AVATAR_TYPES.join(", ")}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > AVATAR_MAX_BYTES) throw new PeopleError("too_large", `an avatar is at most ${AVATAR_MAX_BYTES} bytes`);
  const sniffed = sniffAvatarType(bytes);
  if (sniffed !== declared) throw new PeopleError("bad_request", `the file is not a valid ${declared}`);
  const sha = await sha256Hex(bytes);
  if (!(await bucket.head(avatarKey(sha)))) {
    await bucket.put(avatarKey(sha), bytes, { sha256: sha, httpMetadata: { contentType: sniffed } });
  }
  await platformRun(p, `UPDATE persons SET avatar_sha = ? WHERE handle = ? COLLATE NOCASE`, sha, viewer);
  return { avatar_url: avatarSrc({ avatar_sha: sha }) as string };
}

/** Clear the viewer's uploaded avatar (the R2 bytes stay); returns the picture that now shows. */
export async function clearAvatar(p: PlatformContext, viewer: string): Promise<{ avatar_url: string | null }> {
  await platformRun(p, `UPDATE persons SET avatar_sha = NULL WHERE handle = ? COLLATE NOCASE`, viewer);
  const row = await platformFirst<{ avatar_url: string | null }>(p, `SELECT avatar_url FROM persons WHERE handle = ? COLLATE NOCASE`, viewer);
  return { avatar_url: row?.avatar_url ?? null };
}

/** Bytes + type for GET /avatar/<sha>, or null (malformed sha, no object, or not an avatar type). */
export async function readAvatar(bucket: R2Bucket, sha: string): Promise<{ body: ReadableStream; content_type: string; size_bytes: number } | null> {
  if (!SHA_RE.test(sha)) return null;
  const obj = await bucket.get(avatarKey(sha));
  if (!obj) return null;
  const ct = obj.httpMetadata?.contentType ?? "";
  if (!(AVATAR_TYPES as readonly string[]).includes(ct)) return null;
  return { body: obj.body, content_type: ct, size_bytes: obj.size };
}

/** MCP `list_people`: every non-reserved MEMBER's handle, name, role and responsibilities — nothing else. */
export function listPeopleForAgents(ctx: TenantContext): Promise<PersonForAgents[]> {
  return all<PersonForAgents>(ctx, `SELECT p.handle, p.name, m.title AS role, m.responsibilities FROM persons p
                                      JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
                                     WHERE p.handle NOT IN (${RESERVED_HANDLES.map(() => "?").join(", ")})
                                     ORDER BY p.handle COLLATE NOCASE ASC`, ctx.orgId, ...RESERVED_HANDLES);
}
