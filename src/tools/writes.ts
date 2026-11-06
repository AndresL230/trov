import type { DocRow, DocVersionRow, AdrRow, NeedsTriageRow, IdentityTaskRow } from "@shared/rows";
import { DocProposal, AdrDraft, FeedEntry } from "@shared/contract";
import { isSection } from "@shared/vocabulary";
import { normalizeTagName } from "@shared/tags-core";
import { DEFAULT_SPACE } from "@shared/docs-core";
import { liveTagNames } from "./tags";
import { type TenantContext, type Stmt, first, run, stmt, batch, nowIso } from "../data/sql";
import type { PlatformContext } from "../data/platform-sql";
import { memberPerson, resolvePersonForLogin } from "../auth/persons";
import { routeAi } from "./ai-route";
import { REVIEW_ITEM, reviewRef, supersedeOpenSuggestions } from "../data/ai";
import { linkStmts, promoteTreeStmts, type StmtGuard } from "./doc-tree";
// NOTE: writes.ts ↔ consumer.ts is a deliberate circular import. consumer.ts
// imports the low-level writers below; assign_triage imports the gate functions.
// It is safe because every reference is INSIDE a function body (resolved lazily
// at call time, long after both modules finish initializing) — never at module
// init. assign_triage MUST reuse the gate so an assigned item is vocab-checked
// and reconciled exactly like any other write; it never hand-inserts.
import { ingestDocProposal, ingestAdrDraft, ingestFeedEntry } from "../consumer";

const humanizeSlug = (slug: string): string =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The values `doc_versions.status` and `adrs.status` take — the columns have no CHECK (no table rebuild for one), so
 * this file, their one writer, is where they are held. Every move is a compare-and-set on the from-state:
 *   doc version: staged → promoted   (a person's promote, only of a version NEWER than the live one)
 *                staged → rejected   (a person's reject)
 *                staged → superseded (the promote of a newer version of the page: what waited under it is stale)
 *   ADR:         draft → ratified | rejected (a person; nothing else moves)
 */
export const DOC_VERSION_STATUSES = ["staged", "promoted", "rejected", "superseded"] as const;
export const ADR_STATUSES = ["draft", "ratified", "rejected"] as const;

/**
 * The gate's writers below take `extra`: statements run in the SAME batch, after the write — the replay-ledger row
 * (src/consumer.ts), so an item and its ledger record land together or not at all. Such a statement may name the row
 * just written as the org's newest of its table (`MAX(id)`): a batch is one transaction, nothing interleaves.
 */
export async function append_feed(
  ctx: TenantContext,
  entry: {
    author: string; summary: string; brief?: string; body?: string; artifacts?: unknown; tags?: string[];
    /** Set ONLY for an entry Trov wrote (0061_ai_digests; the gate's `ingestFeedEntry` with `ai`): origin 'ai', the
     *  model that wrote it and the member it was for. Absent = an agent's entry, exactly as before. */
    ai?: { model: string; subject: string | null };
  },
  extra: Stmt[] = []
): Promise<number> {
  const created_at = nowIso();
  // ONE batch: the entry, its tags (each naming the entry just written — the org's newest) and the caller's extra.
  const res = await batch(ctx, [
    stmt(
      ctx,
      `INSERT INTO feed (org_id, author, summary, brief, body, artifacts, created_at, origin, model, subject) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.orgId,
      entry.author,
      entry.summary,
      entry.brief ?? null,
      entry.body ?? null,
      entry.artifacts !== undefined ? JSON.stringify(entry.artifacts) : null,
      created_at,
      entry.ai ? "ai" : "agent",
      entry.ai?.model ?? null,
      entry.ai?.subject ?? null
    ),
    ...(entry.tags ?? []).map((tag) => stmt(
      ctx,
      `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) SELECT ?, ?, 'feed', CAST(MAX(f.id) AS TEXT) FROM feed f WHERE f.org_id = ?`,
      ctx.orgId,
      tag,
      ctx.orgId
    )),
    ...extra,
  ]);
  return res[0].meta.last_row_id as number;
}

export async function propose_doc_update(
  ctx: TenantContext,
  proposal: {
    slug: string;
    section: string;
    title?: string;
    body: string;
    change_summary: string;
    confidence: "high" | "low";
    // Reconciler-computed metadata (set by the gate; defaulted for direct callers).
    space?: string;               // a live doc_spaces slug — the gate resolves and checks it (0081_docs_library)
    content_hash?: string | null;
    base_version?: number | null;
    change_kind?: "new" | "edit" | "rewrite" | null;
    low_confidence?: boolean;
    // The page tree (0081_docs_library), checked by the gate: the parent asked for (a NEW doc's row takes it, and
    // `tree_rank`, at insert; every version records it on doc_versions.parent_slug, applied on promote).
    parent_slug?: string | null;
    tree_rank?: number | null;
    // Server-only (never the contract): the import run and the file's path in it.
    import_id?: number | null;
    import_path?: string | null;
    // Set by the gate when the slug's row is an EMPTY SHELL (never approved, every version rejected — src/tools/spaces.ts
    // `inLibrary`): this proposal takes the row over as a NEW page — its section, title, space, owner and place.
    revive?: boolean;
  },
  author: string,
  extra: Stmt[] = []
): Promise<{ slug: string; version: number; status: "staged" }> {
  const created_at = nowIso();
  const existing = proposal.revive ? null : await first<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, proposal.slug);
  const stmts: Stmt[] = [];

  if (!existing) {
    // Title resolution on first creation only: proposal.title ?? humanizeSlug(slug).
    // (On an existing doc we never rewrite title/section — a human may have set them.)
    // `space` (audit F4) is persisted with the row: the space the gate checked, else the default space.
    // `owner` (0035) = the proposer of the FIRST version, set here once and never overwritten — later proposals and
    // promotions leave it alone. (A shell taken over is a new page: its first live-able version is this one.)
    const title = proposal.title ?? humanizeSlug(proposal.slug);
    const cols = [proposal.section, title, created_at, author, proposal.space ?? DEFAULT_SPACE, author, proposal.parent_slug ?? null, proposal.tree_rank ?? null];
    stmts.push(proposal.revive
      ? stmt(ctx,
        `UPDATE docs SET section = ?, title = ?, updated_at = ?, updated_by = ?, space = ?, owner = ?, parent_slug = ?, tree_rank = ?
          WHERE org_id = ? AND slug = ? AND current_version = 0 AND archived_at IS NULL`,
        ...cols, ctx.orgId, proposal.slug)
      // OR IGNORE: when a proposal of the same new slug landed first, it made the page and this is its next version.
      : stmt(ctx,
        `INSERT OR IGNORE INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by, space, owner, parent_slug, tree_rank)
         VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId, proposal.slug, ...cols));
  }

  // The version number is taken INSIDE the insert (the slug's highest + 1), so two proposals of one page never both
  // read the same highest; the unique index on (org, slug, version) (0088) holds it in the schema too.
  stmts.push(stmt(
    ctx,
    `INSERT INTO doc_versions
       (org_id, slug, version, body, summary, status, confidence, created_at, created_by,
        content_hash, base_version, change_kind, low_confidence, parent_slug, import_id, import_path)
     SELECT ?, ?, COALESCE(MAX(w.version), 0) + 1, ?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM doc_versions w WHERE w.org_id = ? AND w.slug = ?
     RETURNING version`,
    ctx.orgId,
    proposal.slug,
    proposal.body,
    proposal.change_summary,
    proposal.confidence,
    created_at,
    author,
    proposal.content_hash ?? null,
    proposal.base_version ?? null,
    proposal.change_kind ?? null,
    proposal.low_confidence ? 1 : 0,
    proposal.parent_slug ?? null,
    proposal.import_id ?? null,
    proposal.import_path ?? null,
    ctx.orgId,
    proposal.slug
  ));
  const at = stmts.length - 1;
  const res = await batch<{ version: number }>(ctx, [...stmts, ...extra]);
  const version = res[at].results[0].version;

  // docs.current_version intentionally untouched — promotion is a human action (out of scope).
  return { slug: proposal.slug, version, status: "staged" };
}

export async function stage_adr(
  ctx: TenantContext,
  draft: { title: string; context: string; decision: string; rationale: string; confidence: "high" | "low" },
  author: string,
  contentHash?: string | null,
  extra: Stmt[] = []
): Promise<number> {
  const created_at = nowIso();
  const res = await batch(ctx, [stmt(
    ctx,
    `INSERT INTO adrs (org_id, title, context, decision, rationale, status, confidence, created_at, created_by, content_hash)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    ctx.orgId,
    draft.title,
    draft.context,
    draft.decision,
    draft.rationale,
    draft.confidence,
    created_at,
    author,
    contentHash ?? null
  ), ...extra]);
  return res[0].meta.last_row_id as number;
}

export async function route_triage(
  ctx: TenantContext,
  item: { raw: unknown; reason: string; source_author?: string },
  extra: Stmt[] = []
): Promise<number> {
  const created_at = nowIso();
  const raw = typeof item.raw === "string" ? item.raw : JSON.stringify(item.raw);
  const res = await batch(ctx, [stmt(
    ctx,
    `INSERT INTO needs_triage (org_id, raw, reason, source_author, resolved, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    ctx.orgId,
    raw,
    item.reason,
    item.source_author ?? null,
    created_at
  ), ...extra]);
  const id = res[0].meta.last_row_id as number;
  await routeAi(ctx, { type: "unplaced", id });
  return id;
}

/**
 * Identity intake (Maintenance group): ensure one pending identity task exists
 * for an unmapped GitHub login. Called by ingestEvent AFTER the event row lands,
 * so capture never depends on this. login is the PK — INSERT OR IGNORE collapses
 * many events from one unknown person into one task and never re-raises a
 * resolved one. A login this org already attributes (`resolvePersonForLogin`: its
 * attribution map, or a MEMBER's own GitHub sign-in) raises nothing — a login that
 * belongs to a person in some OTHER org is still unknown here.
 * That same PK makes a DISCARD sticky: a discarded row stays, so the IGNORE
 * swallows every later event from that login until a person restores it — the
 * event itself is captured all the same. NEVER throws: like storePrSummary, this is a post-capture side-task, and a
 * failure here must not break event capture or the caller's downstream
 * summary/progress seams.
 */
export async function ensure_identity_task(ctx: TenantContext, _p: PlatformContext, login: string): Promise<void> {
  try {
    // GitHub reserves the "[bot]" suffix for app identities — bot activity is
    // captured in events but never raises an identity task (nobody maps a bot).
    if (login.endsWith("[bot]")) return;
    if (await resolvePersonForLogin(ctx, login)) return;
    await run(
      ctx,
      `INSERT OR IGNORE INTO identity_tasks (org_id, login, first_seen, status) VALUES (?, ?, ?, 'pending')`,
      ctx.orgId,
      login,
      nowIso()
    );
  } catch {
    // Never throw — see doc comment.
  }
}

/**
 * Human placement (Maintenance group, ADMIN+ at the route): resolve an identity
 * task by ATTRIBUTING the login to an existing MEMBER of this org (by handle) in
 * the org's own map, `org_login_map` (§5.3, C-1). It never writes the global
 * `identities` table: that is sign-in, and a row there would let whoever holds
 * the GitHub login sign in AS the person. A direct authored write in the
 * human-placement class — never a gate re-run. My Work and the Repo dashboard
 * resolve login→person at read time (the map, then a member's own identity), so
 * the mapping retroactively surfaces every already-captured event for this login
 * with no backfill. Idempotent-safe: mapping an already-resolved task surfaces
 * the recorded mapping without re-writing anything.
 */
export async function map_identity(
  ctx: TenantContext,
  _p: PlatformContext,
  login: string,
  personHandle: string,
  by: string
): Promise<{ login: string; person: string; status: "resolved" }> {
  const task = await first<IdentityTaskRow>(ctx, `SELECT * FROM identity_tasks WHERE org_id = ? AND login = ?`, ctx.orgId, login);
  if (!task) throw new Error(`no such identity task: ${login}`);
  if (task.status === "resolved") {
    // Already resolved — idempotent no-op, surface the recorded mapping.
    const existing = await resolvePersonForLogin(ctx, login);
    return { login, person: existing?.handle ?? personHandle, status: "resolved" };
  }
  // A member of THIS org: an unknown handle, a reserved one and a person in another org read the same.
  const person = await memberPerson(ctx, personHandle);
  if (!person) throw new Error(`no such person: ${personHandle}`);
  // Pre-check so a stale/unresolved task pointing at an already-attributed login fails
  // with a clean message instead of silently re-pointing it.
  const existing = await resolvePersonForLogin(ctx, login);
  if (existing) throw new Error(`login already linked to ${existing.handle}`);
  const at = nowIso();
  // The upsert covers a stale map row whose person has left the org (it reads as unmapped above).
  await batch(ctx, [
    stmt(ctx,
      `INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, github_login) DO UPDATE SET person = excluded.person, mapped_at = excluded.mapped_at, mapped_by = excluded.mapped_by`,
      ctx.orgId, login, person.handle, at, by),
    stmt(ctx, `UPDATE identity_tasks SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND login = ?`,
      at, by, ctx.orgId, login),
  ]);
  return { login, person: person.handle, status: "resolved" };
}

/** An identity-task write the route answers with a status: `not_found` 404, `conflict` 409. */
export class IdentityTaskError extends Error {
  constructor(readonly code: "not_found" | "conflict", message: string) {
    super(message);
  }
}

/**
 * Human placement (Maintenance group): discard an identity task — a login that
 * will never be a person (an outside contributor). Soft: the row stays, marked
 * `discarded` with the audit columns, and leaves the pending list. STICKY: the
 * row keeps the login's PK, so `ensure_identity_task`'s INSERT OR IGNORE never
 * re-raises it; the login's events are still captured. Idempotent on a
 * discarded task; a mapped (resolved) one is a conflict — it is not noise.
 */
export async function discard_identity_task(
  ctx: TenantContext,
  login: string,
  by: string
): Promise<{ login: string; status: "discarded" }> {
  const task = await first<IdentityTaskRow>(ctx, `SELECT * FROM identity_tasks WHERE org_id = ? AND login = ?`, ctx.orgId, login);
  if (!task) throw new IdentityTaskError("not_found", `no such identity task: ${login}`);
  if (task.status === "discarded") return { login, status: "discarded" }; // idempotent no-op
  if (task.status === "resolved") throw new IdentityTaskError("conflict", `identity task ${login} is already mapped`);
  await run(
    ctx,
    `UPDATE identity_tasks SET status = 'discarded', resolved_at = ?, resolved_by = ? WHERE org_id = ? AND login = ? AND status = 'pending'`,
    nowIso(),
    by,
    ctx.orgId,
    login
  );
  return { login, status: "discarded" };
}

/**
 * Undo a discard: the task is pending again (back in the list, audit columns
 * cleared), and the login raises tasks as normal. Idempotent on a pending task.
 * A mapped task, or a discarded login that has since been linked some other way
 * (a GitHub sign-in), is a conflict — there is nothing left to map.
 */
export async function restore_identity_task(ctx: TenantContext, _p: PlatformContext, login: string): Promise<{ login: string; status: "pending" }> {
  const task = await first<IdentityTaskRow>(ctx, `SELECT * FROM identity_tasks WHERE org_id = ? AND login = ?`, ctx.orgId, login);
  if (!task) throw new IdentityTaskError("not_found", `no such identity task: ${login}`);
  if (task.status === "pending") return { login, status: "pending" }; // idempotent no-op
  if (task.status === "resolved") throw new IdentityTaskError("conflict", `identity task ${login} is already mapped`);
  const linked = await resolvePersonForLogin(ctx, login);
  if (linked) throw new IdentityTaskError("conflict", `login already linked to ${linked.handle}`);
  await run(
    ctx,
    `UPDATE identity_tasks SET status = 'pending', resolved_at = NULL, resolved_by = NULL WHERE org_id = ? AND login = ? AND status = 'discarded'`,
    ctx.orgId,
    login
  );
  return { login, status: "pending" };
}

/** A promote of a version of an ARCHIVED page (0083_doc_archive) — the route answers 409 `archived`. */
export class DocArchivedError extends Error {
  readonly code = "archived";
  constructor(slug: string) {
    super(`${slug} is archived: restore the page before approving a version of it`);
    this.name = "DocArchivedError";
  }
}

/** A promote of a version that is not NEWER than the page's live one — approving it would roll the page back. The
 *  route answers 409 `stale`. */
export class DocStaleVersionError extends Error {
  readonly code = "stale";
  constructor(slug: string, version: number, current: number) {
    super(`${slug} v${version} is older than the live v${current}: it can't be approved over it`);
    this.name = "DocStaleVersionError";
  }
}

/** Why a doc version can't be promoted, read again after the guarded promote found it moved on (a race). */
async function promoteRefusal(ctx: TenantContext, slug: string, version: number): Promise<Error> {
  const [ver, doc] = await Promise.all([
    first<DocVersionRow>(ctx, `SELECT * FROM doc_versions WHERE org_id = ? AND slug = ? AND version = ?`, ctx.orgId, slug, version),
    first<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, slug),
  ]);
  if (!ver) return new Error(`no such doc version: ${slug} v${version}`);
  if (ver.status !== "staged") return new Error(`doc version not staged: ${slug} v${version} is ${ver.status}`);
  // An archived page (0083_doc_archive) takes no version: its staged ones wait, hidden from Review, until it is restored.
  if (doc?.archived_at) return new DocArchivedError(slug);
  if (doc && version <= doc.current_version) return new DocStaleVersionError(slug, version, doc.current_version);
  return new Error(`doc version not promoted: ${slug} v${version}`);
}

/**
 * Human confirmation: promote a staged doc version into the live doc.
 * Non-destructive — prior versions remain. Refused when the version is missing or not staged, when its page is
 * archived (`DocArchivedError`), and when it is not newer than the live version (`DocStaleVersionError`: approving
 * it would roll the page back). The page's OLDER versions still staged become `superseded` in the same batch.
 */
export async function promote_doc(
  ctx: TenantContext,
  slug: string,
  version: number,
  author: string
): Promise<{ slug: string; version: number; status: "promoted" }> {
  const ver = await first<DocVersionRow>(
    ctx,
    `SELECT * FROM doc_versions WHERE org_id = ? AND slug = ? AND version = ?`,
    ctx.orgId,
    slug,
    version
  );
  const doc = await first<DocRow>(ctx, `SELECT * FROM docs WHERE org_id = ? AND slug = ?`, ctx.orgId, slug);
  if (!ver || ver.status !== "staged" || doc?.archived_at || (doc && version <= doc.current_version)) throw await promoteRefusal(ctx, slug, version);

  const updated_at = nowIso();
  // ONE batch: the version, its risk closed (Q37: open suggestions superseded), the live body, the page's older staged
  // versions superseded, its links rebuilt from that body, and — when the version asked for a parent that is still a
  // valid place — the move under it (src/tools/doc-tree.ts; the tree PR of 0081_docs_library).
  // The FIRST statement is the compare-and-set: still staged, newer than the live version, the page not archived. Every
  // statement after it runs only if it applied (`won`: this version promoted at this instant), so a promote that lost a
  // race — another version went live, the page was archived — writes nothing at all.
  const won: StmtGuard = {
    sql: `EXISTS (SELECT 1 FROM doc_versions pw WHERE pw.org_id = ? AND pw.slug = ? AND pw.version = ? AND pw.status = 'promoted' AND pw.promoted_at = ?)`,
    params: [ctx.orgId, slug, version, updated_at],
  };
  const tree = doc ? await promoteTreeStmts(ctx, doc, ver.body, ver.parent_slug ?? null, won) : linkStmts(ctx, slug, ver.body, won);
  const res = await batch(ctx, [
    // `promoted_at` (0077_home): when, for Home's Docs promoted figure.
    stmt(ctx, `UPDATE doc_versions SET status = 'promoted', promoted_at = ? WHERE org_id = ? AND slug = ? AND version = ? AND status = 'staged'
                 AND ? > (SELECT d.current_version FROM docs d WHERE d.org_id = ? AND d.slug = ? AND d.archived_at IS NULL)`,
      updated_at, ctx.orgId, slug, version, version, ctx.orgId, slug),
    supersedeOpenSuggestions(ctx, REVIEW_ITEM, reviewRef.doc(slug, version), won),
    stmt(ctx, `UPDATE docs SET body = ?, current_version = ?, updated_at = ?, updated_by = ? WHERE org_id = ? AND slug = ? AND archived_at IS NULL AND current_version < ? AND ${won.sql}`,
      ver.body, version, updated_at, author, ctx.orgId, slug, version, ...won.params),
    stmt(ctx, `UPDATE doc_versions SET status = 'superseded' WHERE org_id = ? AND slug = ? AND status = 'staged' AND version < ? AND ${won.sql}`,
      ctx.orgId, slug, version, ...won.params),
    ...tree,
  ]);
  if ((res[0].meta.changes ?? 0) === 0) throw await promoteRefusal(ctx, slug, version);
  await routeAi(ctx, { type: "doc_promoted", slug });
  return { slug, version, status: "promoted" };
}

/** Human confirmation: ratify an ADR DRAFT. Refused if missing, already ratified, or rejected — only a draft moves. */
export async function ratify_adr(ctx: TenantContext, id: number): Promise<{ id: number; status: "ratified" }> {
  const adr = await first<AdrRow>(ctx, `SELECT * FROM adrs WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!adr) throw new Error(`no such adr: ${id}`);
  if (adr.status === "ratified") throw new Error(`adr already ratified: ${id}`);
  if (adr.status !== "draft") throw new Error(`cannot ratify adr ${id}: it is ${adr.status}`);
  // Ratifying closes its open risk (owner ruling Q37): superseded in the same batch, gone from Review and /adrs.
  // Compare-and-set on `draft`: a reject that landed first wins, and this ratifies nothing.
  const res = await batch(ctx, [
    stmt(ctx, `UPDATE adrs SET status = 'ratified' WHERE id = ? AND org_id = ? AND status = 'draft'`, id, ctx.orgId),
    supersedeOpenSuggestions(ctx, REVIEW_ITEM, reviewRef.adr(id)),
  ]);
  if ((res[0].meta.changes ?? 0) === 0) {
    const now = await first<AdrRow>(ctx, `SELECT * FROM adrs WHERE id = ? AND org_id = ?`, id, ctx.orgId);
    throw new Error(now?.status === "ratified" ? `adr already ratified: ${id}` : `cannot ratify adr ${id}: it is ${now?.status ?? "gone"}`);
  }
  return { id, status: "ratified" };
}

/**
 * Human confirmation: flip a live sprint to 'done'. Rejects if missing or already
 * done. `done` is NEVER set by the worker and NEVER inferred from issue closure or
 * from every ticket being resolved — a sprint is completed by an admin, here or in
 * the plan write. Direct authored write (promote class), not the ingestion gate.
 *
 * DEFINED in ./sprints.ts — every sprint writer has one home there. This
 * re-export keeps the older `from "./tools/writes"` import path working.
 */
export { complete_sprint } from "./sprints";

// ── Phase 3 — triage write-back (soft only; nothing here hard-deletes) ─────────

/**
 * Reject a staged doc version: soft status flip to 'rejected' so it leaves the
 * proposals queue. Non-destructive (the row and its body remain) and
 * idempotent-safe: a second reject on an already-rejected version is a no-op.
 */
export async function reject_doc_version(
  ctx: TenantContext,
  slug: string,
  version: number
): Promise<{ slug: string; version: number; status: "rejected" }> {
  const ver = await first<DocVersionRow>(
    ctx,
    `SELECT * FROM doc_versions WHERE org_id = ? AND slug = ? AND version = ?`,
    ctx.orgId,
    slug,
    version
  );
  if (!ver) throw new Error(`no such doc version: ${slug} v${version}`);
  if (ver.status === "rejected") return { slug, version, status: "rejected" }; // idempotent
  if (ver.status !== "staged") throw new Error(`cannot reject ${slug} v${version}: it is ${ver.status}`);
  // Compare-and-set on `staged`: a promote that landed first wins, and this rejects nothing.
  const res = await batch(ctx, [
    stmt(ctx, `UPDATE doc_versions SET status = 'rejected' WHERE org_id = ? AND slug = ? AND version = ? AND status = 'staged'`, ctx.orgId, slug, version),
    supersedeOpenSuggestions(ctx, REVIEW_ITEM, reviewRef.doc(slug, version)),
  ]);
  if ((res[0].meta.changes ?? 0) === 0) {
    const now = await first<{ status: string }>(ctx, `SELECT status FROM doc_versions WHERE org_id = ? AND slug = ? AND version = ?`, ctx.orgId, slug, version);
    if (now?.status !== "rejected") throw new Error(`cannot reject ${slug} v${version}: it is ${now?.status ?? "gone"}`);
  }
  return { slug, version, status: "rejected" };
}

/**
 * Reject an ADR draft: soft status flip to 'rejected' so it leaves the decisions
 * queue. Idempotent-safe: a second reject on an already-rejected draft is a no-op.
 */
export async function reject_adr(ctx: TenantContext, id: number): Promise<{ id: number; status: "rejected" }> {
  const adr = await first<AdrRow>(ctx, `SELECT * FROM adrs WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!adr) throw new Error(`no such adr: ${id}`);
  if (adr.status === "rejected") return { id, status: "rejected" }; // idempotent
  if (adr.status !== "draft") throw new Error(`cannot reject adr ${id}: it is ${adr.status}`);
  // Rejecting closes its open risk too (Q37). Compare-and-set on `draft`: a ratify that landed first wins.
  const res = await batch(ctx, [
    stmt(ctx, `UPDATE adrs SET status = 'rejected' WHERE id = ? AND org_id = ? AND status = 'draft'`, id, ctx.orgId),
    supersedeOpenSuggestions(ctx, REVIEW_ITEM, reviewRef.adr(id)),
  ]);
  if ((res[0].meta.changes ?? 0) === 0) {
    const now = await first<AdrRow>(ctx, `SELECT * FROM adrs WHERE id = ? AND org_id = ?`, id, ctx.orgId);
    if (now?.status !== "rejected") throw new Error(`cannot reject adr ${id}: it is ${now?.status ?? "gone"}`);
  }
  return { id, status: "rejected" };
}

/**
 * Resolve a triage item: set the audit columns + flip `resolved` so it leaves the
 * queue. Soft only — the row remains. Idempotent-safe: resolving an
 * already-resolved item returns its recorded resolution without re-writing.
 */
export async function resolve_triage(
  ctx: TenantContext,
  id: number,
  by: string,
  resolution: "assigned" | "discarded" = "discarded",
  assigned_ref: string | null = null
): Promise<{ id: number; resolution: "assigned" | "discarded"; assigned_ref: string | null }> {
  const row = await first<NeedsTriageRow>(ctx, `SELECT * FROM needs_triage WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!row) throw new Error(`no such triage item: ${id}`);
  if (row.resolved) {
    // Already resolved — idempotent no-op, surface what it became.
    return { id, resolution: row.resolution ?? resolution, assigned_ref: row.assigned_ref };
  }
  // Compare-and-set on `resolved = 0`: of a discard and an assign racing (or two of either), the first one stands and
  // the other reports what the item became.
  const res = await run(
    ctx,
    `UPDATE needs_triage SET resolved = 1, resolved_at = ?, resolved_by = ?, resolution = ?, assigned_ref = ? WHERE id = ? AND org_id = ? AND resolved = 0`,
    nowIso(),
    by,
    resolution,
    assigned_ref,
    id,
    ctx.orgId
  );
  if ((res.meta.changes ?? 0) === 0) {
    const now = await first<NeedsTriageRow>(ctx, `SELECT * FROM needs_triage WHERE id = ? AND org_id = ?`, id, ctx.orgId);
    if (!now) throw new Error(`no such triage item: ${id}`);
    return { id, resolution: now.resolution ?? resolution, assigned_ref: now.assigned_ref };
  }
  return { id, resolution, assigned_ref };
}

/** Thrown by `restore_triage`: the item is not this org's (404) or was placed, not discarded (409). */
export class TriageRestoreError extends Error {
  constructor(readonly code: "not_found" | "assigned", readonly status: 404 | 409, message: string) { super(message); }
}

/**
 * Undo a DISCARD (Unplaced's Undo toast): the item goes back to the queue, unresolved, its audit columns cleared —
 * exactly as it was before. Only a discarded item: one that was placed made something through the gate, which this
 * cannot take back (409). An item that is already unresolved is an idempotent no-op. A person's write, cookie only.
 */
export async function restore_triage(ctx: TenantContext, id: number): Promise<{ id: number; restored: boolean }> {
  const row = await first<NeedsTriageRow>(ctx, `SELECT * FROM needs_triage WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!row) throw new TriageRestoreError("not_found", 404, `no such triage item: ${id}`);
  if (!row.resolved) return { id, restored: false };
  if (row.resolution !== "discarded") throw new TriageRestoreError("assigned", 409, "this item was placed, not discarded, so it can't be put back");
  await run(
    ctx,
    `UPDATE needs_triage SET resolved = 0, resolved_at = NULL, resolved_by = NULL, resolution = NULL, assigned_ref = NULL
      WHERE id = ? AND org_id = ? AND resolution = 'discarded'`,
    id,
    ctx.orgId
  );
  return { id, restored: true };
}

export type AssignType = "doc" | "adr" | "feed";
export interface AssignTarget {
  type?: AssignType;
  section?: string;          // doc: the corrected section (the human's placement)
  space?: string;            // doc: a live space of the org (Unplaced offers the Library's spaces); the gate checks it
  tags?: string[];           // feed: corrected tags
}

/**
 * Assign-materialize a triaged item: parse its `raw`, re-run it through the SAME
 * gate path for the target type (so it is vocab-checked + reconciled exactly like
 * a normal write — never hand-inserted), then resolve the triage item as
 * 'assigned' with assigned_ref pointing at what it became.
 *
 * The author is the authenticated principal (`by`). Confidence is forced 'high'
 * because the human's act of assigning vouches for the item. The gate never sends
 * anything back to the queue: what it REFUSES (a space that is not live, an archived
 * page) throws with the gate's reason — the route answers the person 400 and the item
 * stays unresolved. Idempotent-safe: a second assign on an already-resolved item
 * materializes nothing new; and the gate's replay ledger is keyed by the ITEM
 * (`triageLedger`), so a retry after a write whose resolve never landed — or two
 * assigns racing — replays the first one's write instead of making the thing twice.
 */
export async function assign_triage(
  ctx: TenantContext,
  id: number,
  by: string,
  target: AssignTarget = {}
): Promise<{ id: number; resolution: "assigned" | "discarded"; assigned_ref: string }> {
  const row = await first<NeedsTriageRow>(ctx, `SELECT * FROM needs_triage WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!row) throw new Error(`no such triage item: ${id}`);
  if (row.resolved) {
    // Idempotent: surface the ACTUAL recorded resolution, stage nothing new.
    return { id, resolution: row.resolution ?? "assigned", assigned_ref: row.assigned_ref ?? "" };
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new Error("cannot assign a free-form triage item; discard it instead");
  }

  const type: AssignType = target.type ?? "doc";
  // The ledger key is the ITEM's (stable across retries), so whatever the first assign wrote is what a retry gets back.
  // A refusal is never ledgered, so placing the item again after one (another space) stages as usual.
  const ledger = triageLedger(row);
  // What the first assign made, when the gate answers this one as a replay (`unchanged` with no slug / id).
  const replayed = async (): Promise<string | null> => {
    const hit = await first<{ item_type: string; ref: string | null }>(ctx,
      `SELECT item_type, ref FROM processed_items WHERE org_id = ? AND session_id = ? AND item_index = ?`, ctx.orgId, ledger.sessionId, ledger.itemIndex);
    return hit ? `${hit.item_type}:${hit.ref ?? "unchanged"}` : null;
  };
  let assigned_ref: string;

  if (type === "doc") {
    const section = target.section ?? (raw.section as string | undefined);
    if (!section || !isSection(section)) throw new Error("a valid section is required to place this as a doc");
    const proposal = DocProposal.parse({
      ...raw,
      section,
      confidence: "high",            // human-vouched on assign
      space: target.space ?? (typeof raw.space === "string" ? raw.space : undefined),
    });
    const r = await ingestDocProposal(ctx, proposal, by, ledger);
    if (r.outcome === "refused") throw new Error(`could not place doc: ${r.reason}`);
    assigned_ref = r.outcome === "written" ? `doc:${r.slug}@${r.version}`
      : r.slug ? `doc:${r.slug}` : (await replayed()) ?? `doc:${proposal.slug}`;
  } else if (type === "adr") {
    const draft = AdrDraft.parse({ ...raw, confidence: "high" });
    const r = await ingestAdrDraft(ctx, draft, by, ledger);
    assigned_ref = r.id !== undefined ? `adr:${r.id}` : (await replayed()) ?? "adr:unchanged";
  } else {
    // Tags the PERSON picked must be on the org's list (the picker offers nothing else). With none
    // picked, the item's own tags go to the gate as they came: it keeps the ones on the list and
    // records the rest as suggestions, exactly as it would have on the way in.
    if (target.tags) {
      const live = await liveTagNames(ctx);
      const unknown = target.tags.filter((t) => { const n = normalizeTagName(t); return !n || !live.includes(n); });
      if (unknown.length > 0) throw new Error(`unknown tag: ${unknown.join(", ")} — pick tags from this organization's list`);
    }
    const entry = FeedEntry.parse({ ...raw, tags: target.tags ?? (raw.tags as string[] | undefined) ?? [] });
    const r = await ingestFeedEntry(ctx, entry, by, ledger);
    if (r.outcome === "triaged") throw new Error(`could not place feed entry: ${r.reason}`);
    assigned_ref = r.outcome === "written" ? `feed:${r.id}` : (await replayed()) ?? "feed:unchanged";
  }

  // Guarded: when the item was resolved meanwhile (a discard, another assign), this reports what it became.
  const res = await resolve_triage(ctx, id, by, "assigned", assigned_ref);
  return { id, resolution: res.resolution, assigned_ref: res.assigned_ref ?? "" };
}

/** The replay-ledger key of placing one Unplaced item: the item's own (its id and when it was held), the same on every
 *  retry, in a namespace of its own (an agent's session ids are UUIDs; an import's are `import:<id>`). */
const triageLedger = (row: Pick<NeedsTriageRow, "id" | "created_at">) => ({ sessionId: `triage:${row.id}:${row.created_at}`, itemIndex: 0 });
