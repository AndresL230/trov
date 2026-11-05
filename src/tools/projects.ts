// Projects — the rules and the authored writers (docs/architecture/projects.md; the spec is
// docs/superpowers/specs/2026-11-05-projects.md, the contract shared/projects-core.ts). Direct "promote-class" writers
// (CLAUDE.md invariant 1), reached only from the cookie routes (src/projects/routes.ts) and Ask's routes — never MCP
// (projects' MCP tools are a later phase). The author of every write is `ctx.userId` (invariant 3).
//
// WHO MAY DO WHAT is decided here and nowhere else (`accessOf`, `mayChange`):
//   · the owner (`projects.owner`) does everything;
//   · a member row is `editor` (details, instructions, pins, files, members, archive) or `viewer` (reads, starts chats);
//   · an `org` project opens for every live member of the org as a viewer; a `private` one for its owner alone (its
//     member rows are kept and ignored);
//   · an org ADMIN who is not the owner or a member reads an `org` project as a viewer and may archive, restore and
//     delete it — but a `members` / `private` project they are not in is the one 404 to them too (the spec's table:
//     "Open … `org` projects only"; every route answers a project the person can't open with the ONE 404).
// Refusals, in order: the one `not_found` (404) for a project the person can't open — unknown, deleted, another org's,
// private, members-only — then `forbidden` (403) for one they can open but not change, then `archived` (409) for a
// write to an archived project, then `invalid` / `private_pin` (400). A plan limit is the app's one 402 (`requirePlan`).
//
// Nothing here imports src/ai/: what needs Ask's code (a pin's RefView, the project's chats) is handed in by the caller.
import { hasRole, type TenantContext } from "../data/context";
import { memberHandles, projectThreadCounts } from "../data/ask";
import {
  addPins, artifactCounts, artifactsOf, insertProject, membersOf, pinCounts, pinsOf, projectById, projectBySlug, projectHoldings, projectsByIds, projectsFor,
  removePin, replaceMembers, setArchived, setArtifactProject, slugTaken, updateProject,
  type ProjectArtifactRow, type ProjectForRow, type ProjectMemberRow,
} from "../data/projects";
import { all } from "../data/sql";
import { createPage } from "./artifacts";
import { ARTIFACT_IMAGE_TYPES, isTextKind, type ArtifactKind } from "@shared/artifacts-core";
import { planFor, requirePlan, limitUse } from "../plans/gate";
import { resolveEntitlements } from "@shared/plans";
import { ASK_REF_TOKEN_RE, askRefTokens, parseAskRef, type AskThreadProject, type AskThreadSummary, type RefView } from "@shared/ai-ask-core";
import {
  PROJECT_PIN_TYPES, projectSlug,
  type ProjectAccess, type ProjectArtifact, type ProjectCreateBody, type ProjectDetail, type ProjectError, type ProjectIcon, type ProjectColor,
  type ProjectList, type ProjectMember, type ProjectMembersBody, type ProjectPatchBody, type ProjectPin, type ProjectSummary,
} from "@shared/projects-core";

export class ProjectRefusal extends Error {
  constructor(readonly code: ProjectError, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
const notFound = () => new ProjectRefusal("not_found", 404, "not found");
const forbidden = (m: string) => new ProjectRefusal("forbidden", 403, m);
const archived = () => new ProjectRefusal("archived", 409, "This project is archived. Restore it to change it.");
const invalid = (m: string) => new ProjectRefusal("invalid", 400, m);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** What `ctx`'s person may do with the project, or null when they can't open it (see the header). */
export function accessOf(ctx: TenantContext, p: ProjectForRow): ProjectAccess | null {
  if (p.deleted_at) return null;
  if (same(p.owner, ctx.userId)) return "owner";
  if (p.visibility === "private") return null;
  if (p.member_role) return p.member_role;
  return p.visibility === "org" ? "viewer" : null;
}

export type ProjectAct = "edit" | "visibility" | "members" | "archive" | "delete";

/** May the person do `act` to a project they can open? An org admin archives and deletes what they can open. */
export function mayChange(ctx: TenantContext, access: ProjectAccess, act: ProjectAct): boolean {
  if (access === "owner") return true;
  const admin = hasRole(ctx, "admin");
  switch (act) {
    case "edit": case "members": return access === "editor";
    case "visibility": return false;
    case "archive": return access === "editor" || admin;
    case "delete": return admin;
  }
}

export interface Opened { row: ProjectForRow; access: ProjectAccess }

/** The project the person can open, by slug — else the one 404. */
export async function openProject(ctx: TenantContext, slug: string): Promise<Opened> {
  const row = /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? await projectBySlug(ctx, ctx.userId, slug) : null;
  const access = row ? accessOf(ctx, row) : null;
  if (!row || !access) throw notFound();
  return { row, access };
}

/** The project the person can open AND may `act` on; `live`: refused while archived. */
async function changeable(ctx: TenantContext, slug: string, act: ProjectAct, live = true): Promise<Opened> {
  const o = await openProject(ctx, slug);
  if (!mayChange(ctx, o.access, act)) {
    throw forbidden(act === "visibility" ? "Only the owner can change who can see this project."
      : act === "delete" ? "Only the owner or an org admin can delete this project." : "You can read this project, not change it.");
  }
  if (live && o.row.archived_at) throw archived();
  return o;
}

// ── writers ──────────────────────────────────────────────────────────────────

/** A new project, its slug from the name (`-2`, `-3`… past a live, archived or deleted one). Counts toward `projects`. */
export async function createProject(ctx: TenantContext, b: ProjectCreateBody): Promise<string> {
  await requirePlan(ctx, "projects");
  const base = projectSlug(b.name);
  let slug = base;
  for (let n = 2; await slugTaken(ctx, slug); n++) slug = `${base}-${n}`;
  await insertProject(ctx, {
    slug, name: b.name.trim(), description: (b.description ?? "").trim(), icon: b.icon, color: b.color.toLowerCase(),
    instructions: b.instructions ?? "", visibility: b.visibility, owner: ctx.userId,
  });
  return slug;
}

/** Details and instructions (owner or editor); who can see it (the owner). Leaving `private` checks the pins. */
export async function patchProject(ctx: TenantContext, slug: string, b: ProjectPatchBody): Promise<void> {
  const { visibility, ...rest } = b;
  const changesVisibility = visibility !== undefined;
  const o = await changeable(ctx, slug, changesVisibility ? "visibility" : "edit");
  if (changesVisibility && visibility !== o.row.visibility && visibility !== "private") await assertNoPrivatePins(ctx, o.row.id);
  await updateProject(ctx, o.row.id, {
    ...(rest.name !== undefined ? { name: rest.name.trim() } : {}),
    ...(rest.description !== undefined ? { description: rest.description.trim() } : {}),
    ...(rest.icon !== undefined ? { icon: rest.icon } : {}),
    ...(rest.color !== undefined ? { color: rest.color.toLowerCase() } : {}),
    ...(rest.instructions !== undefined ? { instructions: rest.instructions } : {}),
    ...(changesVisibility ? { visibility } : {}),
  });
}

/** A project that is not `private` may not pin a private artifact (it would be less visible than the project). */
async function assertNoPrivatePins(ctx: TenantContext, projectId: number): Promise<void> {
  const rows = await all<{ ref: string }>(ctx,
    `SELECT pp.ref FROM project_pins pp JOIN artifact_pages a ON a.org_id = pp.org_id AND 'artifact:' || a.slug = pp.ref
      WHERE pp.org_id = ? AND pp.project_id = ? AND a.visibility = 'private' AND a.deleted_at IS NULL`, ctx.orgId, projectId);
  if (rows.length) throw new ProjectRefusal("private_pin", 400, "A private artifact is pinned. Publish it to the org, or unpin it, before sharing the project.");
}

export async function archiveProject(ctx: TenantContext, slug: string): Promise<void> {
  const o = await changeable(ctx, slug, "archive", false);
  if (!o.row.archived_at) await setArchived(ctx, o.row.id, ctx.userId);
}

/** Restore an archived project: it counts toward `projects` again, so the plan is asked first. */
export async function restoreProject(ctx: TenantContext, slug: string): Promise<void> {
  const o = await changeable(ctx, slug, "archive", false);
  if (!o.row.archived_at) return;
  await requirePlan(ctx, "projects");
  await setArchived(ctx, o.row.id, null);
}

/** Replace the member list (owner or editor; never on a private project). Checked WHOLE before anything is written:
 *  each a member of this org (stored in their own spelling), never the owner, none twice. */
export async function putMembers(ctx: TenantContext, slug: string, b: ProjectMembersBody): Promise<void> {
  const o = await changeable(ctx, slug, "members");
  if (o.row.visibility === "private") throw invalid("A private project is its owner's alone. Change who can see it first.");
  const keys = b.members.map((m) => m.handle.toLowerCase());
  if (new Set(keys).size !== keys.length) throw invalid("Each person can be added once.");
  if (keys.includes(o.row.owner.toLowerCase())) throw invalid("The owner is not added as a member.");
  const stored = new Map((await memberHandles(ctx, b.members.map((m) => m.handle))).map((h) => [h.toLowerCase(), h]));
  const members = b.members.map((m) => ({ handle: stored.get(m.handle.toLowerCase()) ?? "", role: m.role }));
  if (members.some((m) => !m.handle)) throw invalid("Add only members of this organization.");
  await replaceMembers(ctx, o.row.id, members, ctx.userId);
}

/** Ask's RefView code, handed in (src/ai/ask/refs.ts `resolveViews`): what `viewer` may see of each ref, now. */
export type PinViews = (ctx: TenantContext, viewer: string, refs: readonly string[]) => Promise<Map<string, RefView>>;

/** Pin refs (owner or editor): each a pinnable type, naming something the person can see; a private artifact only on a
 *  private project (`private_pin`). One already pinned is left as it is; the new ones count toward `project_pins`. */
export async function pinRefs(ctx: TenantContext, slug: string, refs: readonly string[], views: PinViews): Promise<void> {
  const o = await changeable(ctx, slug, "edit");
  const want = [...new Set(refs.map((r) => (r.startsWith("person:") ? r.toLowerCase() : r)))];
  const bad = want.filter((r) => { const p = parseAskRef(r); return !p || !(PROJECT_PIN_TYPES as readonly string[]).includes(p.type); });
  if (bad.length) throw invalid(`These can't be pinned: ${bad.join(", ")}. Pin tickets, sprints, docs, decisions, PRs, repos or artifacts.`);
  const seen = await views(ctx, ctx.userId, want);
  const missing = want.filter((r) => !seen.has(r));
  if (missing.length) throw invalid(`Not found: ${missing.join(", ")}.`);
  if (o.row.visibility !== "private" && want.some((r) => seen.get(r)!.type === "artifact" && seen.get(r)!.extra.visibility === "private")) {
    throw new ProjectRefusal("private_pin", 400, "That artifact is private. Publish it to the org before pinning it here.");
  }
  const already = new Set((await pinsOf(ctx, o.row.id)).map((p) => p.ref));
  const fresh = want.filter((r) => !already.has(r));
  if (!fresh.length) return;
  await requirePlan(ctx, "project_pins", fresh.length, { project: o.row.id });
  await addPins(ctx, o.row.id, fresh, ctx.userId);
}

export async function unpinRef(ctx: TenantContext, slug: string, ref: string): Promise<void> {
  const o = await changeable(ctx, slug, "edit");
  await removePin(ctx, o.row.id, ref);
}

/** One file to store, as Ask's attachment check (src/ai/ask/attachments.ts `checkFiles`) classified it. */
export interface ProjectFile { name: string; type: string; bytes: Uint8Array; kind: ArtifactKind }

/**
 * Upload files into a project (owner or editor, live): each becomes an artifact of the person's — private on a private
 * project, else the org's — through the artifacts store's own writer (`createPage`: the size caps, `artifact_bytes`),
 * is the project's (`project_id`) and is pinned. The pins are asked of the plan BEFORE anything is stored.
 */
export async function uploadIntoProject(ctx: TenantContext, bucket: R2Bucket, slug: string, files: readonly ProjectFile[]): Promise<string[]> {
  const o = await changeable(ctx, slug, "edit");
  await requirePlan(ctx, "project_pins", files.length, { project: o.row.id });
  const visibility = o.row.visibility === "private" ? "private" as const : "org" as const;
  const refs: string[] = [];
  for (const f of files) {
    const base = { title: f.name.slice(0, 200) || "File", area: "data" as const, repo: "", visibility, summary: `Uploaded to ${o.row.name}`.slice(0, 200) };
    const page = isTextKind(f.kind)
      ? await createPage(ctx, { ...base, kind: f.kind, content: new TextDecoder().decode(f.bytes) }, ctx.userId)
      : await createPage(ctx, {
        ...base, kind: f.kind as "image" | "pdf" | "file", bytes: f.bytes, filename: f.name,
        content_type: f.kind === "image" ? ((ARTIFACT_IMAGE_TYPES as readonly string[]).includes(f.type) ? f.type : null) : f.kind === "file" ? "text/plain" : f.type,
      }, ctx.userId, bucket);
    await setArtifactProject(ctx, page.id, o.row.id);
    refs.push(`artifact:${page.slug}`);
  }
  await addPins(ctx, o.row.id, refs, ctx.userId);
  return refs;
}

/** The project the person may pin into (owner or editor, live): Add to <project>'s candidates are theirs to ask for. */
export async function projectForPinning(ctx: TenantContext, slug: string): Promise<ProjectForRow> {
  return (await changeable(ctx, slug, "edit")).row;
}

/** The project the person may delete: its owner, or an org admin who can open it (archived or not). */
export async function projectToDelete(ctx: TenantContext, slug: string): Promise<ProjectForRow> {
  return (await changeable(ctx, slug, "delete", false)).row;
}

// ── Ask's side (src/ai/ask/routes.ts) ────────────────────────────────────────

/** The project a person starts a thread in (`POST /ask { projectId }`) or moves their thread into (`PATCH { project }`):
 *  one they can open (else the one 404) and live (else `archived`). Any member who can open it may (a viewer too). */
export async function projectForAsk(ctx: TenantContext, slug: string): Promise<ProjectForRow> {
  const o = await openProject(ctx, slug);
  if (o.row.archived_at) throw archived();
  return o.row;
}

/** A thread's project as the thread list and the crumb draw it — for the projects `handle` can open (an archived one
 *  included); any other (deleted, unopenable) is left out, so the thread reads as one with no project. */
export async function projectMarks(ctx: TenantContext, projectIds: readonly (number | null)[]): Promise<Map<number, AskThreadProject>> {
  const ids = [...new Set(projectIds.filter((x): x is number => typeof x === "number"))];
  const rows = await projectsByIds(ctx, ctx.userId, ids);
  return new Map(rows.filter((r) => accessOf(ctx, r)).map((r) => [r.id, { slug: r.slug, name: r.name, icon: r.icon, color: r.color }]));
}

/** What a turn in a project's thread reads: the project — live, and one the ASKER can open — and its pins' refs,
 *  newest first. Null otherwise (an archived project's thread answers as one with no project context). */
export async function projectForTurn(ctx: TenantContext, projectId: number | null): Promise<{ row: ProjectForRow; refs: string[] } | null> {
  if (projectId === null) return null;
  const row = await projectById(ctx, ctx.userId, projectId);
  if (!row || !accessOf(ctx, row) || row.archived_at) return null;
  return { row, refs: (await pinsOf(ctx, row.id)).map((p) => p.ref) };
}

/** The project a SAVED answer goes into: the thread's, when the person can open it and it is live. */
export async function projectForSave(ctx: TenantContext, projectId: number | null): Promise<number | null> {
  return (await projectForTurn(ctx, projectId))?.row.id ?? null;
}

// ── reads ────────────────────────────────────────────────────────────────────

const PREVIEW_LINES = 3;
const TEXT_KINDS = new Set(["markdown", "html", "mermaid"]);

/** Markdown as the plain words a card shows: headings, lists, quotes, emphasis, code marks, rules and table pipes
 *  gone; a link or an image its text. Ask's ref tokens (`[[pr:185]]`) are left for `withRefWords`. */
export function plainMarkdown(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|[^[])\[([^\][]+)\]\([^)]*\)/g, "$1$2")
    .split(/\r?\n/)
    .map((l) => l
      .replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*>\s?/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/, "").replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, "")
      .replace(/^\s*\|(.*)\|\s*$/, (_m, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" · "))
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2").replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g, "$1$2")
      .replace(/(^|\W)_(?=\S)([^_\n]+?)(?<=\S)_(?=\W|$)/g, "$1$2").replace(/~~(.+?)~~/g, "$1").replace(/`([^`\n]+)`/g, "$1"))
    .join("\n");
}

/** A few lines of a text artifact for its card: the first non-empty lines as plain text — markup stripped from HTML,
 *  Markdown's marks dropped (and a first heading that only repeats the title) — or a diagram's own first lines. */
export function previewOf(kind: string, content: string | null, title = ""): string | null {
  if (!content || !TEXT_KINDS.has(kind)) return null;
  const text = kind === "html" ? content.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ")
    : kind === "markdown" ? plainMarkdown(content.replace(/^\s{0,3}#{1,6}\s+(.+)\n/, (m, h: string) => (h.trim().toLowerCase() === title.trim().toLowerCase() ? "" : m)))
    : content;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, PREVIEW_LINES);
  const out = lines.join("\n").slice(0, 280);
  return out || null;
}

/** How a card's plain text names a ref, the way Ask's chips do: `#87`, `PR #185`, else the item's title (a sprint's
 *  name, a doc's) — for the reader; one they can't see (or that is gone) is "an item". */
function refWord(v: RefView | undefined): string {
  if (!v) return "an item";
  if (v.type === "ticket" && v.num != null) return `#${v.num}`;
  if (v.type === "pr" && v.num != null) return `PR #${v.num}`;
  return v.title;
}

/** Ask's ref tokens in the cards' previews as words (`refWord`), each ref drawn once through Ask's views for the reader. */
async function withRefWords(ctx: TenantContext, views: PinViews, arts: ProjectArtifact[]): Promise<ProjectArtifact[]> {
  const refs = [...new Set(arts.flatMap((a) => (a.preview ? askRefTokens(a.preview) : [])))];
  if (!refs.length) return arts;
  const seen = await views(ctx, ctx.userId, refs);
  return arts.map((a) => (a.preview ? {
    ...a,
    preview: a.preview.replace(ASK_REF_TOKEN_RE, (_m, type: string, key: string, status?: string) => {
      const v = seen.get(type === "person" ? `${type}:${key.toLowerCase()}` : `${type}:${key}`);
      return status ? v?.status?.word ?? "" : refWord(v);
    }),
  } : a));
}

const artifactOf = (a: ProjectArtifactRow): ProjectArtifact => ({
  slug: a.slug, title: a.title, kind: a.kind, visibility: a.visibility, author: a.author_id, updatedAt: a.updated_at,
  threadId: a.thread_id, preview: previewOf(a.kind, a.content, a.title),
});

/** The member list as the screen draws it: the owner first, then the people added (none while private). */
function membersOfProject(p: ProjectForRow, rows: readonly ProjectMemberRow[]): ProjectMember[] {
  const added = p.visibility === "private" ? [] : rows.filter((m) => m.project_id === p.id);
  return [{ handle: p.owner, role: "owner", addedAt: null }, ...added.map((m) => ({ handle: m.handle, role: m.role, addedAt: m.added_at }))];
}

interface Counts {
  members: ProjectMemberRow[]; chats: Map<number, number>; pins: Map<number, number>; artifacts: Map<number, number>;
  /** Everything each project the reader may DELETE holds (`ProjectSummary.deleteCounts`); none for the others. */
  holdings: Map<number, { chats: number; artifacts: number }>;
}

/** The counts the summaries of these projects draw. `opened`: each with the reader's access — the ones they may delete
 *  also get what deleting takes (every thread, anyone's; every artifact), as counts only. */
async function countsFor(ctx: TenantContext, opened: readonly { row: ProjectForRow; access: ProjectAccess }[]): Promise<Counts> {
  const ids = opened.map((o) => o.row.id);
  const deletable = opened.filter((o) => mayChange(ctx, o.access, "delete")).map((o) => o.row.id);
  const [members, chats, pins, artifacts, holdings] = await Promise.all([
    membersOf(ctx, ids), projectThreadCounts(ctx, ctx.userId, ids), pinCounts(ctx, ids), artifactCounts(ctx, ids, ctx.userId), projectHoldings(ctx, deletable),
  ]);
  return { members, chats, pins, artifacts, holdings };
}

function summaryOf(p: ProjectForRow, access: ProjectAccess, c: Counts): ProjectSummary {
  const members = membersOfProject(p, c.members);
  const holds = c.holdings.get(p.id);
  return {
    slug: p.slug, name: p.name, description: p.description, icon: p.icon as ProjectIcon, color: p.color as ProjectColor, visibility: p.visibility,
    owner: p.owner, access, people: members.slice(0, 3).map((m) => m.handle), memberCount: members.length,
    chats: c.chats.get(p.id) ?? 0, pins: c.pins.get(p.id) ?? 0, artifacts: c.artifacts.get(p.id) ?? 0,
    updatedAt: p.updated_at, archivedAt: p.archived_at, archivedBy: p.archived_by,
    ...(holds ? { deleteCounts: holds } : {}),
  };
}

/** One project's summary, as the person reads it (the answer of create, archive and restore). */
export async function readSummary(ctx: TenantContext, slug: string): Promise<ProjectSummary> {
  const o = await openProject(ctx, slug);
  return summaryOf(o.row, o.access, await countsFor(ctx, [o]));
}

/** `GET /projects` — the live projects the person can open, most recently updated first, and the archived ones;
 *  `q` filters by name and description. `limit` is the org's (`projects`: live projects, whoever can open them). */
export async function readProjectList(ctx: TenantContext, q = ""): Promise<ProjectList> {
  const needle = q.trim().toLowerCase();
  const rows = (await projectsFor(ctx, ctx.userId))
    .map((row) => ({ row, access: accessOf(ctx, row) }))
    .filter((x): x is { row: ProjectForRow; access: ProjectAccess } => x.access !== null)
    .filter((x) => !needle || x.row.name.toLowerCase().includes(needle) || x.row.description.toLowerCase().includes(needle));
  const [c, plan, used] = await Promise.all([countsFor(ctx, rows), planFor(ctx), limitUse(ctx, "projects")]);
  const all = rows.map((x) => summaryOf(x.row, x.access, c));
  return {
    projects: all.filter((s) => !s.archivedAt),
    archived: all.filter((s) => s.archivedAt),
    limit: { used, cap: resolveEntitlements(plan.plan, plan.overrides, plan.members).projects },
  };
}

/** Ask's half of the project page, handed in: the person's threads in the project, then the ones shared with them. */
export type ProjectChats = (ctx: TenantContext, projectId: number, mark: AskThreadProject) => Promise<AskThreadSummary[]>;

/** `GET /projects/:project` — everything the project page draws, for the person reading it. A pin they can't see is
 *  `{ ref, hidden: true }`; its artifacts are the ones they may see; its chats keep Ask's own privacy. */
export async function readProjectDetail(ctx: TenantContext, slug: string, views: PinViews, chats: ProjectChats): Promise<ProjectDetail> {
  const o = await openProject(ctx, slug);
  const p = o.row;
  const [c, pins, arts, plan] = await Promise.all([countsFor(ctx, [o]), pinsOf(ctx, p.id), artifactsOf(ctx, p.id, ctx.userId), planFor(ctx)]);
  const seen = pins.length ? await views(ctx, ctx.userId, pins.map((x) => x.ref)) : new Map<string, RefView>();
  const pinList: ProjectPin[] = pins.map((x) => ({ ref: x.ref, view: seen.get(x.ref) ?? { ref: x.ref, hidden: true as const }, addedBy: x.added_by, addedAt: x.added_at }));
  return {
    project: { ...summaryOf(p, o.access, c), instructions: p.instructions },
    members: membersOfProject(p, c.members),
    pins: pinList,
    chats: await chats(ctx, p.id, { slug: p.slug, name: p.name, icon: p.icon, color: p.color }),
    artifacts: await withRefWords(ctx, views, arts.map(artifactOf)),
    pinLimit: { used: pins.length, cap: resolveEntitlements(plan.plan, plan.overrides, plan.members).project_pins },
  };
}

