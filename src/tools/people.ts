// Person profiles (0036) — the repository behind `GET|PUT /api/people/:handle`, the avatar
// upload and `GET /avatar/<sha>`, and MCP `list_people`. The contract is `shared/people.ts`.
//
// Every write here is a DIRECT AUTHORED write — no gate, no staging, no MCP counterpart.
// A person changes only their own PHOTO; role and responsibilities are ADMIN-set (the
// owner's call, 2026-09-27 — Maintenance › People), never by the person themselves. The ONE agent surface is the read `listPeopleForAgents`
// (handle, name, role, responsibilities — nothing else about a person reaches MCP).
//
// An avatar is content-addressed and immutable, like a doc image: bytes in R2
// (`ARTIFACTS_BUCKET`) at `avatars/<sha256>`, never deleted — "remove" only clears
// `persons.avatar_sha`, so the provider picture shows again. There is no avatars table:
// the R2 object's own `httpMetadata.contentType` (the SNIFFED type) is what is served.

import { first, all, run, type DB } from "../db";
import { RESERVED_HANDLES } from "../auth/persons";
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
  role: string | null; responsibilities: string | null; created_at: string;
}

/**
 * The person card of `handle` as `viewer` sees it (the modal a click on a name opens, and
 * Maintenance › People's editor). An unknown or RESERVED handle is `not_found` (a system
 * principal is not a person). `responsibilities` travels only to admins — the editor fills
 * from it; no page renders it, and the person themselves does not get it (they cannot edit
 * it). D1 only: the person and their GitHub login in ONE batch.
 */
export async function getPersonProfile(
  db: DB, handle: string, viewer: string, isAdmin: (h: string) => boolean,
): Promise<PersonProfile> {
  if (isReserved(handle)) throw new PeopleError("not_found", "not found");
  const [p, g] = await db.batch([
      db.prepare(`SELECT handle, name, color, avatar_url, avatar_sha, role, responsibilities, created_at
                    FROM persons WHERE handle = ? COLLATE NOCASE`).bind(handle),
      db.prepare(`SELECT subject FROM identities WHERE provider = 'github' AND person = ? COLLATE NOCASE
                   ORDER BY linked_at ASC LIMIT 1`).bind(handle),
  ]);
  const person = p.results?.[0] as ProfileRow | undefined;
  const gh = g.results?.[0] as { subject: string } | undefined;
  if (!person) throw new PeopleError("not_found", "not found");
  const self = sameHandle(person.handle, viewer);
  const editor = isAdmin(viewer);
  return {
    handle: person.handle,
    name: person.name,
    color: person.color,
    avatar_url: avatarSrc(person),
    role: person.role,
    github: gh?.subject ?? null,
    joined: person.created_at,
    admin: isAdmin(person.handle),
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
 * `PUT /api/people/:handle` — ADMINS only (role and responsibilities are admin-set);
 * anyone else, the person themselves included, is `forbidden` and nothing is written. Every field is validated BEFORE the one UPDATE,
 * so an over-cap value writes nothing (not even the other, valid field).
 */
export async function writePersonProfile(
  db: DB, handle: string, viewer: string, isAdmin: (h: string) => boolean, body: unknown,
): Promise<PersonProfile> {
  if (isReserved(handle)) throw new PeopleError("not_found", "not found");
  const person = await first<{ handle: string }>(db, `SELECT handle FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
  if (!person) throw new PeopleError("not_found", "not found");
  if (!isAdmin(viewer)) throw new PeopleError("forbidden", "only an admin may set a person's role and responsibilities");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PeopleError("bad_request", "the body must be a JSON object");
  const b = body as PersonProfileWrite;
  const role = field(b.role, "role", ROLE_MAX);
  const resp = field(b.responsibilities, "responsibilities", RESPONSIBILITIES_MAX);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (role.set) { sets.push("role = ?"); binds.push(role.value); }
  if (resp.set) { sets.push("responsibilities = ?"); binds.push(resp.value); }
  if (sets.length) await run(db, `UPDATE persons SET ${sets.join(", ")} WHERE handle = ?`, ...binds, person.handle);
  return getPersonProfile(db, person.handle, viewer, isAdmin);
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
  db: DB, bucket: R2Bucket, viewer: string, file: { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null,
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
  await run(db, `UPDATE persons SET avatar_sha = ? WHERE handle = ? COLLATE NOCASE`, sha, viewer);
  return { avatar_url: avatarSrc({ avatar_sha: sha }) as string };
}

/** Clear the viewer's uploaded avatar (the R2 bytes stay); returns the picture that now shows. */
export async function clearAvatar(db: DB, viewer: string): Promise<{ avatar_url: string | null }> {
  await run(db, `UPDATE persons SET avatar_sha = NULL WHERE handle = ? COLLATE NOCASE`, viewer);
  const row = await first<{ avatar_url: string | null }>(db, `SELECT avatar_url FROM persons WHERE handle = ? COLLATE NOCASE`, viewer);
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

/** MCP `list_people`: every non-reserved person's handle, name, role and responsibilities — nothing else. */
export function listPeopleForAgents(db: DB): Promise<PersonForAgents[]> {
  return all<PersonForAgents>(db, `SELECT handle, name, role, responsibilities FROM persons
                                    WHERE handle NOT IN (${RESERVED_HANDLES.map(() => "?").join(", ")})
                                    ORDER BY handle COLLATE NOCASE ASC`, ...RESERVED_HANDLES);
}
