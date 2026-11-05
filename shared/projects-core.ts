// Projects — the zod-free values and DTOs, SPA-importable (CLAUDE.md › Layout). The zod schemas re-export these
// from shared/projects.ts. The design is the Claude Design canvas "Trov Projects" (the clickable prototype);
// the area file is docs/architecture/projects.md.
//
// A project is a place to work, not a new owner of team records. It POINTS AT tickets, sprints, docs, PRs, repos
// and artifacts (pins, by Ask ref: `ticket:87`, `doc:deploys`), and it OWNS only what is made inside it: its
// instructions, its Ask threads (`chat_threads.project_id`) and the artifacts saved from them or uploaded into it
// (`artifacts.project_id`). Every Ask turn in a project's thread reads the project's instructions and its pins.

import { SPACE_COLORS, SPACE_ICONS, type SpaceColor, type SpaceIcon } from "./docs-core";
import type { AskThreadSummary, RefView } from "./ai-ask-core";

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Who can open a project. `private`: its owner only (members are ignored and cannot be added). `members`: the
 *  owner and the people added. `org`: every live member of the org can open it and start chats in it; only the
 *  owner and editors change it. */
export const PROJECT_VISIBILITIES = ["private", "members", "org"] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];
export const isProjectVisibility = (v: unknown): v is ProjectVisibility =>
  typeof v === "string" && (PROJECT_VISIBILITIES as readonly string[]).includes(v);

/** A member's role. Editors change the instructions, the pins and the details; viewers read them and start their
 *  own chats. The owner is not a member row: the owner is `projects.owner`. */
export const PROJECT_ROLES = ["editor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** What the person reading may do with a project. An org admin who is not owner or member reads an `org` project
 *  as a viewer and may archive or delete any project of the org (CLAUDE.md invariant 9: admin is the org role). */
export type ProjectAccess = "owner" | "editor" | "viewer";
export const canEditProject = (a: ProjectAccess): boolean => a === "owner" || a === "editor";

/** A project's icon and colour are the Library spaces' sets, so the two tiles read as one family. */
export const PROJECT_ICONS = SPACE_ICONS;
export type ProjectIcon = SpaceIcon;
export const PROJECT_COLORS = SPACE_COLORS;
export type ProjectColor = SpaceColor;

/** What a project may pin: the Ask ref types that name team records. */
export const PROJECT_PIN_TYPES = ["ticket", "sprint", "doc", "decision", "pr", "repo", "artifact"] as const;
export type ProjectPinType = (typeof PROJECT_PIN_TYPES)[number];

export const PROJECT_LIMITS = {
  nameMax: 60,
  descriptionMax: 140,
  instructionsMax: 2000,
  /** People added by name (the owner is not counted). */
  membersMax: 50,
  /** Refs in one `POST …/pins`. */
  pinsPerRequest: 25,
} as const;

/** The most of an Ask turn's prompt a project's context may take, in tokens (about 4 characters each): its name, its
 *  instructions and its pins' cards. Past it, the newest pins go first and a line says how many were left out. */
export const ASK_PROJECT_CONTEXT_MAX = 6000;

/** The plan limits (shared/plans.ts `LIMIT_KEYS`): `projects` per org (live, not archived), `project_pins` per
 *  project. Free 2 and 20; Personal as Free; Pro and Enterprise unlimited projects, 200 pins. Enforced with
 *  `requirePlan` (402 `plan_limit`). */
export const PROJECT_PLAN_KEYS = ["projects", "project_pins"] as const;

/** The words the screen shows for a visibility (the segmented switch, the list's column, the hint under it). The
 *  org's own name replaces "the org" at render time. */
export const PROJECT_VISIBILITY_WORDS: Record<ProjectVisibility, { label: string; hint: string }> = {
  private: { label: "Private", hint: "Only you. Good for your own notes and drafts." },
  members: { label: "Members", hint: "Only the people you add. The rest of the org won’t see it." },
  org: { label: "Org", hint: "Everyone in the org can open it and start chats. Only the people you add can change it." },
};

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  /** Unique per org, from the name; a deleted project's slug stays reserved (invariant 11). */
  slug: string;
  name: string;
  description: string;
  icon: ProjectIcon;
  color: ProjectColor;
  visibility: ProjectVisibility;
  /** The owner's handle. */
  owner: string;
  /** What the person reading may do. */
  access: ProjectAccess;
  /** The owner first, then members by when they were added; at most 3 (the avatar stack). */
  people: string[];
  /** Owner plus members. */
  memberCount: number;
  /** Threads in the project this person can open: their own, and others' shared with them or the org. */
  chats: number;
  pins: number;
  artifacts: number;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: string | null;
  /** What deleting it takes — EVERY thread in it (anyone's, private ones too) and every artifact it holds — for the
   *  delete confirmation. Only for a reader who may delete it (its owner, or an org admin who can open it); absent
   *  otherwise. Counts only: nothing of a thread the reader can't open is said. */
  deleteCounts?: { chats: number; artifacts: number };
}

export interface ProjectMember {
  handle: string;
  role: "owner" | ProjectRole;
  addedAt: string | null;
}

export interface ProjectPin {
  ref: string;
  /** The ref's view as Ask draws it (permission-checked for the reader): a pin the person can't see is
   *  `{ ref, hidden: true }` and is left out of their answers too. */
  view: RefView | { ref: string; hidden: true };
  addedBy: string;
  addedAt: string;
}

export interface ProjectArtifact {
  slug: string;
  title: string;
  kind: string;
  visibility: "private" | "org";
  author: string;
  updatedAt: string;
  /** The thread it was saved from, when it was. */
  threadId: number | null;
  /** A few lines of its text for the card, when it is a text kind. */
  preview: string | null;
}

export interface ProjectDetail {
  project: ProjectSummary & { instructions: string };
  members: ProjectMember[];
  pins: ProjectPin[];
  /** The person's own threads in the project, then threads shared with them; newest first. Each carries `project`. */
  chats: AskThreadSummary[];
  artifacts: ProjectArtifact[];
  /** The `project_pins` limit for this project: `cap` null = unlimited. */
  pinLimit: { used: number; cap: number | null };
}

export interface ProjectList {
  /** Live projects this person can open, most recently updated first. */
  projects: ProjectSummary[];
  /** Archived projects this person can open. */
  archived: ProjectSummary[];
  /** The `projects` limit for the org: `cap` null = unlimited. */
  limit: { used: number; cap: number | null };
}

// ── request bodies ───────────────────────────────────────────────────────────

export interface ProjectCreateBody {
  name: string;
  description?: string;
  icon: ProjectIcon;
  color: ProjectColor;
  visibility: ProjectVisibility;
  instructions?: string;
}
export type ProjectPatchBody = Partial<ProjectCreateBody>;
/** The WHOLE member list, replacing the one before (like Ask's `people`). */
export interface ProjectMembersBody { members: { handle: string; role: ProjectRole }[] }
export interface ProjectPinsBody { refs: string[] }

// ── routes (cookie only, under /api/o/:slug) ─────────────────────────────────

export const PROJECT_ROUTES = {
  /** GET → ProjectList (`?q=` filters by name and description). POST ProjectCreateBody → { project: ProjectSummary }. */
  list: "/projects",
  /** GET → ProjectDetail. PATCH ProjectPatchBody → ProjectDetail. DELETE → ProjectDeleted `{ ok: true, chats, artifacts }` (owner or org admin). */
  one: "/projects/:project",
  /** POST → ProjectSummary (owner, editor or org admin). */
  archive: "/projects/:project/archive",
  restore: "/projects/:project/restore",
  /** PUT ProjectMembersBody → ProjectDetail (owner or editor; never on a private project). */
  members: "/projects/:project/members",
  /** POST ProjectPinsBody → ProjectDetail. */
  pins: "/projects/:project/pins",
  /** DELETE (the ref URL-encoded) → ProjectDetail. */
  pin: "/projects/:project/pins/:ref",
  /** POST multipart (Ask's attachment rules: ≤ 5 files, 10 MB each) → ProjectDetail: each file becomes an artifact
   *  with `project_id` (private on a private project, else org) and is pinned. */
  upload: "/projects/:project/files",
  /** GET `?q=&type=` → `{ result: QuickSearchResult }`: what Add to <project> offers to pin (owner or editor). The quick
   *  search's own read (`?q=`, 2+ characters), else the most recently changed items per type; artifacts include the
   *  drafts the reader may see (their own private ones), so a private one can be offered with Publish to org. */
  candidates: "/projects/:project/candidates",
} as const;

/** `DELETE /projects/:project`'s answer: what went (`chats`, every thread in it) and what stayed (`artifacts`). */
export interface ProjectDeleted { ok: true; chats: number; artifacts: number }

/** Errors a project route answers with, besides the app's 402 `plan_limit` body. */
export type ProjectError = "not_found" | "forbidden" | "invalid" | "archived" | "private_pin";

/** A slug from a name: lower case, runs of anything else one `-`, at most 48 characters, never empty. The server
 *  adds `-2`, `-3`… on a clash with a live, archived or deleted slug. */
export function projectSlug(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return s || "project";
}
