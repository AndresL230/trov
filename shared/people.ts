// Person profiles (0036) — the ONE contract the Worker, the SPA and MCP share. Zod-free:
// the SPA imports the caps and `avatarSrc` as values.
//
// Three new person fields:
//   • avatar — an UPLOADED photo (`persons.avatar_sha`, bytes in R2 at `avatars/<sha>`,
//     served by the session-gated `GET /avatar/<sha>`). It outranks the provider picture
//     (`persons.avatar_url`); `avatarSrc` is the ONE rule, and every DTO's `avatar_url`
//     is already resolved through it, so `personChip` needs no change.
//   • role — a short title, shown on the profile and in the people directory.
//   • responsibilities — what the person owns / should be assigned. NEVER rendered on a
//     profile; returned only to the person themselves, to admins (for editing) and to MCP
//     (`list_people` / `get_person`), where an agent reads it when assigning work.
//
// Who writes: a person edits their OWN role, responsibilities and avatar (Settings); an
// admin (`isAdmin`) may edit ANY person's role and responsibilities (Maintenance › People).
// Nothing here is an MCP write.

import type { PersonColor } from "./rows";

export const ROLE_MAX = 80;
export const RESPONSIBILITIES_MAX = 2000;
/** The upload cap for an avatar, in bytes (the SPA downsizes to 512px first, so this is generous). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

/** THE avatar rule: an uploaded avatar wins, else the provider picture, else none (initials). */
export function avatarSrc(p: { avatar_sha?: string | null; avatar_url?: string | null }): string | null {
  return p.avatar_sha ? `/avatar/${p.avatar_sha}` : p.avatar_url ?? null;
}

/** One person as every list shows them (`GET /persons`, now with `role`). `avatar_url` is resolved. */
export interface PersonSummary {
  handle: string;
  name: string | null;
  color: PersonColor;
  avatar_url: string | null;
  role: string | null;
}

/** A ticket line on a profile (open, assigned to the person). */
export interface ProfileTicket {
  id: number;
  title: string;
  status: string;
  priority: string;
  updated_at: string;
}

/**
 * `GET /api/people/:handle` — the profile page. Session cookie. An unknown or reserved
 * handle is 404. `responsibilities` is present ONLY when the viewer is that person or an
 * admin (so the edit form can fill it); the profile never renders it.
 */
export interface PersonProfile extends PersonSummary {
  /** GitHub login from `identities`, when linked (for a "GitHub" link). */
  github: string | null;
  joined: string;                              // persons.created_at
  admin: boolean;                              // this person is an admin
  /** The viewer may edit this person's role / responsibilities (self or admin). */
  editable: boolean;
  /** The viewer is this person (may also change the avatar). */
  self: boolean;
  responsibilities?: string | null;
  /** Open tickets assigned to them (both sources), most recently updated first, max 8. */
  tickets: ProfileTicket[];
  ticketsOpen: number;                         // uncapped count of the same rule
  /** Their latest feed entries, max 5. */
  sessions: Array<{ id: number; summary: string; brief: string | null; created_at: string }>;
  /** Live docs they own (`docs.owner`), max 8. */
  docs: Array<{ slug: string; title: string; updated_at: string }>;
}

/** `PUT /api/people/:handle` body — self or admin; every field optional, "" / null clears. */
export interface PersonProfileWrite {
  role?: string | null;
  responsibilities?: string | null;
}

/** MCP `list_people` / `get_person` — what an agent reads to decide whom to assign. */
export interface PersonForAgents {
  handle: string;
  name: string | null;
  role: string | null;
  responsibilities: string | null;
  github: string | null;
  admin: boolean;
  /** Open tickets assigned to them right now (both sources) — their current load. */
  openTickets: number;
}
