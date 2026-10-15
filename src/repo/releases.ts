// Releases (Repo setups, Phase F; 0074_releases): a repository's published releases and bare tags — captured
// from the `release` / `create` webhooks and reconcile's `releases` arm, always through the gate
// (`ingestRepoRelease`, src/consumer.ts), and read back as the Overview's release facts.
//
// THREE parts, kept apart:
//   1. PURE derivations — one verified delivery, or one GitHub list item, → a `ReleaseCapture` (no DB, no clock).
//   2. The reconcile arm — `reconcileReleases`, at most `RELEASES_RECONCILE_COST` (2) GitHub requests: the 30
//      newest releases and, ONLY when the repository has none, its 30 newest tags. Never on a render path.
//   3. The reads — `readRelease`, `readTags`, `releaseWeekFigure` — D1 only, never a fetch.
//
// Never guess: a date is GitHub's own (never "when Trov saw it"); `since` is `null` where capture began after
// the release; a pull request is a FEATURE only when its title has a `feat` prefix (`feat:`, `feat(scope):`) or
// it carries a label named feature / enhancement — `isFeaturePr`, the one place that rule lives.
import { type TenantContext, all, first, fanOut } from "../data/sql";
import { ingestRepoRelease } from "../consumer";
import type { ReleaseCapture } from "./release-store";
import { type GhOpts, ghGraphql, ghJson } from "./gh-http";
import { orgEnvironments } from "./config";
import { recordingSince } from "./reads";
import { getSnapshot, putSnapshot } from "./store";
import type { FactsRelease, FactsReleaseWaiting, FactsUnseen, FactsWeekFigure } from "@shared/repo-facts-core";
import { parseReleaseSignal, type ReleaseSignal } from "@shared/repo-apps-core";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const DAY = 86_400_000;
/** A full commit sha — a release's `target_commitish` is a sha only when it is exactly this. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

// ── 1. pure derivations ──────────────────────────────────────────────────────

/** Release actions that (re)state a published release, and the two that end one. A draft is never captured. */
const UPSERT_ACTIONS = ["published", "released", "prereleased", "edited"];
const REMOVE_ACTIONS = ["deleted", "unpublished"];

/** One release object (a `release` delivery's `release`, or a `GET /releases` item) → its capture, or null for a
 *  draft or a release with no tag / no `published_at`. */
export function releaseCapture(repo: string, r: unknown, provenance: "webhook" | "backfill"): ReleaseCapture | null {
  const rel = obj(r);
  const tag = str(rel?.tag_name);
  const publishedAt = str(rel?.published_at);
  if (!rel || !tag || rel.draft === true || !publishedAt) return null;
  const target = str(rel.target_commitish);
  return {
    op: "upsert", repo, tag, publishedAt, provenance,
    name: str(rel.name)?.slice(0, 300) ?? null,
    author: str(obj(rel.author)?.login),
    notes: str(rel.body),
    prerelease: rel.prerelease === true,
    sha: target && FULL_SHA.test(target) ? target.toLowerCase() : null,
  };
}

/** `repository.pushed_at` is unix seconds in a `push` delivery and an ISO string in every other one. */
function pushedAt(repository: Obj | null): string | null {
  const v = repository?.pushed_at;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return str(v);
}

/** One verified `release` / `create` delivery → its release captures (none for anything else). A `create` of a
 *  tag carries no date of its own: `repository.pushed_at` (GitHub's — the push that made the tag) stands in,
 *  and without it nothing is written (reconcile reads the tag's real date later). */
export function releaseEventsFromDelivery(eventName: string, payload: unknown, repo: string): ReleaseCapture[] {
  const p = obj(payload);
  if (!p) return [];
  if (eventName === "release") {
    const action = str(p.action);
    const rel = obj(p.release);
    const tag = str(rel?.tag_name);
    if (!action || !rel || !tag) return [];
    if (REMOVE_ACTIONS.includes(action)) return [{ op: "remove", repo, tag, provenance: "webhook" }];
    if (!UPSERT_ACTIONS.includes(action)) return [];
    const c = releaseCapture(repo, rel, "webhook");
    return c ? [c] : [];
  }
  if (eventName === "create") {
    const tag = str(p.ref);
    const at = pushedAt(obj(p.repository));
    if (str(p.ref_type) !== "tag" || !tag || !at) return [];
    return [{ op: "tag", repo, tag, publishedAt: at, author: str(obj(p.sender)?.login), provenance: "webhook" }];
  }
  return [];
}

/** A pull request is a feature ONLY when its title has a `feat` prefix (`feat:` or `feat(scope):`, any case) or
 *  it carries a label named `feature` or `enhancement` (any case). Never otherwise — not a word in the title,
 *  not a branch name, not a guess. */
const FEAT_PREFIX = /^feat(\([^)]*\))?:/i;
const FEATURE_LABELS = ["feature", "enhancement"];
export function isFeaturePr(title: string | null, labels: readonly string[]): boolean {
  if (title && FEAT_PREFIX.test(title.trim())) return true;
  return labels.some((l) => FEATURE_LABELS.includes(l.trim().toLowerCase()));
}

/** A release body as the block shows it: headings and HTML comments dropped, whitespace collapsed, ≤ 280
 *  characters cut at a word ("…"). `null` when nothing is left. */
export function releaseNotesText(body: string | null): string | null {
  if (!body) return null;
  const text = body.replace(/<!--[\s\S]*?-->/g, " ").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= 280) return text;
  const cut = text.slice(0, 280);
  const at = cut.lastIndexOf(" ");
  return `${(at > 200 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

// ── 2. the reconcile arm ─────────────────────────────────────────────────────

/** The worst case of `reconcileReleases`: the releases list, and the tags query when there are no releases.
 *  `reconcileCost` / `refreshSubrequests` (src/repo/cron.ts) count it. */
export const RELEASES_RECONCILE_COST = 2;
/** One page of each — enough for the cadence (≤ 9) and the week figure (the last 14 days). */
const PAGE = 30;
/** `repo_snapshots` kind: written once the arm has read the repository's list — what makes "0 releases this
 *  week" a fact rather than "not read yet". `{ repo }`. */
export const RELEASES_RECONCILED = "releases_reconciled";

/** Tags newest first, with GitHub's dates: REST `/tags` carries none, so ONE GraphQL page instead.
 *  `TAG_COMMIT_DATE` orders tags (verified for src/repo/github.ts's branches query). An annotated tag's date
 *  and author are its tagger's; a lightweight tag's are its commit's. */
const TAGS_QUERY = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
  tags: refs(refPrefix:"refs/tags/", first:${PAGE}, orderBy:{field:TAG_COMMIT_DATE, direction:DESC}){ nodes{
    name target{ __typename oid
      ... on Commit { committedDate author{ user{ login } } }
      ... on Tag { tagger{ date user{ login } } target{ oid } } } } } } }`;

interface GqlTagTarget {
  __typename?: string; oid?: string | null; committedDate?: string | null;
  author?: { user?: { login?: string | null } | null } | null;
  tagger?: { date?: string | null; user?: { login?: string | null } | null } | null;
  target?: { oid?: string | null } | null;
}
interface GqlTags { repository?: { tags?: { nodes?: ({ name?: string | null; target?: GqlTagTarget | null } | null)[] | null } | null } | null }

/** One tag node → its capture, or null without a name or a date. */
export function tagCapture(repo: string, node: { name?: string | null; target?: GqlTagTarget | null } | null): ReleaseCapture | null {
  const tag = str(node?.name);
  const t = node?.target;
  if (!tag || !t) return null;
  const annotated = t.__typename === "Tag";
  const at = annotated ? str(t.tagger?.date) : str(t.committedDate);
  if (!at) return null;
  return {
    op: "tag", repo, tag, publishedAt: at, provenance: "backfill",
    author: annotated ? str(t.tagger?.user?.login) : str(t.author?.user?.login),
    sha: annotated ? str(t.target?.oid) : str(t.oid),
  };
}

/**
 * Reconcile's `releases` arm: the backfill and the self-heal of `releases`, idempotent (every row goes through
 * the gate's content hash). `GET /releases?per_page=30` — drafts skipped; a list SHORTER than the page is the
 * whole history, so a captured release no longer in it is removed (deleted while the webhook was not
 * subscribed). Only when the repository has NO published release: one GraphQL page of tags. Writes the
 * `releases_reconciled` marker after a successful read. THROWS on a failed read — the caller's `safely`
 * names the arm.
 */
export async function reconcileReleases(ctx: TenantContext, opts: GhOpts, now: number = Date.now()): Promise<{ written: number; unchanged: number }> {
  const out = { written: 0, unchanged: 0 };
  const take = async (c: ReleaseCapture | null): Promise<void> => {
    if (!c) return;
    if ((await ingestRepoRelease(ctx, c)).outcome === "written") out.written++; else out.unchanged++;
  };
  const list = await ghJson<unknown[]>(opts, `/releases?per_page=${PAGE}`);
  const items = Array.isArray(list) ? list : [];
  const published = items.map((r) => releaseCapture(opts.repo, r, "backfill")).filter((c): c is ReleaseCapture => c !== null);
  if (published.length) {
    for (const c of published) await take(c);
    if (items.length < PAGE) {
      const listed = new Set(published.map((c) => c.tag));
      const held = await all<{ tag: string }>(ctx, `SELECT tag FROM releases WHERE org_id = ? AND repo = ? AND source = 'release'`, ctx.orgId, opts.repo);
      for (const r of held) if (!listed.has(r.tag)) await take({ op: "remove", repo: opts.repo, tag: r.tag, provenance: "backfill" });
    }
  } else {
    const [owner, name] = opts.repo.split("/");
    const data = await ghGraphql<GqlTags>(opts, TAGS_QUERY, { owner, name });
    const nodes = data?.repository?.tags?.nodes;
    for (const n of Array.isArray(nodes) ? nodes : []) await take(tagCapture(opts.repo, n));
  }
  await putSnapshot(ctx, RELEASES_RECONCILED, { repo: opts.repo }, new Date(now).toISOString());
  return out;
}

// ── 3. the reads (D1 only) ───────────────────────────────────────────────────

interface Row { tag: string; published_at: string; author: string | null; notes: string | null; sha: string | null; source: "release" | "tag" }

/** An app's `release_signal`, parsed (`parseReleaseSignal` — the form `putRepoApp` accepts): `tag:<glob>`
 *  ("tag:v*", "tag:ui-kit@*") narrows its releases to the tags matching the glob (SQLite GLOB);
 *  `workflow:<file>@<branch>` reads that workflow's runs instead (`workflowRelease`); none reads every release. */
async function appSignal(ctx: TenantContext, app: string | null | undefined): Promise<ReleaseSignal | null> {
  if (!app) return null;
  const row = await first<{ release_signal: string | null }>(ctx, `SELECT release_signal FROM repo_apps WHERE org_id = ? AND key = ?`, ctx.orgId, app);
  return parseReleaseSignal(row?.release_signal);
}

/** The release pool, newest first: published non-prerelease RELEASES when the repository has any, else its
 *  bare tags (a repository that ships by tags alone). `after` bounds it to rows published after that instant —
 *  the pool's KIND is still decided over every row, never by what falls in the window. */
async function pool(ctx: TenantContext, repo: string, glob: string | null, limit: number, after?: string): Promise<Row[]> {
  const read = (source: "release" | "tag", since: string) => all<Row>(ctx,
    `SELECT tag, published_at, author, notes, sha, source FROM releases
      WHERE org_id = ? AND repo = ? AND source = ? AND is_prerelease = 0 AND is_draft = 0 AND published_at > ?${glob ? " AND tag GLOB ?" : ""}
      ORDER BY published_at DESC, tag DESC LIMIT ?`,
    ...[ctx.orgId, repo, source, since, ...(glob ? [glob] : []), limit]);
  const hasRelease = (await first<{ n: number }>(ctx,
    `SELECT 1 AS n FROM releases WHERE org_id = ? AND repo = ? AND source = 'release' AND is_prerelease = 0 AND is_draft = 0${glob ? " AND tag GLOB ?" : ""} LIMIT 1`,
    ...[ctx.orgId, repo, ...(glob ? [glob] : [])])) !== null;
  return read(hasRelease ? "release" : "tag", after ?? "");
}

/** GitHub logins → handles (logins are case-insensitive): a member's own sign-in identity, then the org's
 *  attribution map, which wins. A login with no person stays the login. */
async function handlesOf(ctx: TenantContext, logins: (string | null)[]): Promise<(login: string | null) => string | null> {
  if (!logins.some(Boolean)) return (l) => l;
  const rows = await all<{ subject: string; handle: string }>(ctx,
    `SELECT i.subject AS subject, p.handle AS handle FROM identities i
       JOIN persons p ON p.handle = i.person
       JOIN memberships m ON m.user_id = p.handle AND m.org_id = ?
      WHERE i.provider = 'github'
      UNION ALL
     SELECT l.github_login AS subject, l.person AS handle FROM org_login_map l WHERE l.org_id = ?`,
    ctx.orgId, ctx.orgId);
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.subject.toLowerCase(), r.handle);
  return (l) => (l ? map.get(l.toLowerCase()) ?? l : null);
}

/** At most this many merged pull requests are listed as waiting (newest first); `since.prs` counts them all. */
const WAITING_MAX = 10;

/**
 * The Overview's release facts (`RepoFacts.release`), or null when Trov holds no release (nor tag) of the
 * repository. D1 only.
 * - The release: the newest published non-prerelease release — or, for a repository with no release, the newest
 *   tag. `app` narrows by that app's `release_signal`: `tag:<glob>` keeps the matching tags; `workflow:<file>@<branch>`
 *   reads that workflow's latest successful run on that branch instead (`workflowRelease`, below).
 * - `since`: on the default branch (the first environment's, else `main` — as every repo read), counted from
 *   the push that carried the tagged commit when one was captured, else from the release's date. `commits` sums
 *   captured pushes after it, `prs` counts pull requests merged into that branch after it — each `null` unless
 *   its capture was recording by then (`recordingSince`), so a count never covers only part of the stretch.
 * - `waiting`: the pull requests merged since (newest first, ≤ 10) — facts, listed even when the count is
 *   unknown; `feature` only by `isFeaturePr`.
 * - `cadence`: the ≤ 8 releases before it, newest LAST.
 */
export async function readRelease(ctx: TenantContext, repo: string, app?: string | null): Promise<FactsRelease | null> {
  const signal = await appSignal(ctx, app);
  if (signal?.kind === "workflow") return workflowRelease(ctx, repo, signal);
  const rows = await pool(ctx, repo, signal?.kind === "tag" ? signal.glob : null, 9);
  const latest = rows[0];
  if (!latest) return null;
  const branch = (await orgEnvironments(ctx))[0]?.branch ?? "main";
  return releaseFacts(ctx, {
    tag: latest.tag, at: latest.published_at, author: latest.author, sha: latest.sha,
    notes: latest.source === "release" ? releaseNotesText(latest.notes) : null,
  }, branch, rows.slice(1, 9).reverse().map((r) => ({ tag: r.tag, at: r.published_at })));
}

/** At most this many captured runs are read for a workflow release (re-run attempts of one run collapse into one). */
const WORKFLOW_RUNS_READ = 40;

/**
 * A `workflow:<file>@<branch>` app's release: its latest SUCCESSFUL captured `run` of that workflow file
 * (`raw.path`) on that branch — the tag `<file> #<run number>` (or `<file> <short sha>` for a run captured without
 * its number), dated by the run's completion, by its actor, no notes; `since` / `waiting` from the run's head sha
 * on THAT branch; `cadence` the ≤ 8 successful runs before it. A run says nothing about whether it reached a store,
 * and nothing here claims it did. Runs are the PRIMARY repository's capture, so another repository's app reads
 * null, and so does an app whose workflow has no successful run captured. D1 only.
 */
async function workflowRelease(ctx: TenantContext, repo: string, s: { file: string; branch: string }): Promise<FactsRelease | null> {
  const primary = await first<{ r: string }>(ctx, `SELECT repo_full_name AS r FROM org_repos WHERE org_id = ? ORDER BY is_primary DESC, created_at, id LIMIT 1`, ctx.orgId);
  if (!primary || primary.r.toLowerCase() !== repo.toLowerCase()) return null;
  const path = s.file.startsWith(".github/workflows/") ? s.file : `.github/workflows/${s.file}`;
  const rows = await all<{ number: number | null; sha: string | null; actor_login: string | null; occurred_at: string; raw: string }>(ctx,
    `SELECT number, sha, actor_login, occurred_at, raw FROM repo_events
      WHERE org_id = ? AND kind = 'run' AND state = 'success' AND ref = ? AND json_extract(raw, '$.path') = ?
      ORDER BY occurred_at DESC, id DESC LIMIT ${WORKFLOW_RUNS_READ}`,
    ctx.orgId, s.branch, path);
  const seen = new Set<number>();
  const runs = rows.filter((r) => r.number === null || (!seen.has(r.number) && !!seen.add(r.number))).slice(0, 9);
  const latest = runs[0];
  if (!latest) return null;
  const file = path.slice(".github/workflows/".length);
  const tagOf = (r: { sha: string | null; raw: string }): string => {
    let n: unknown = null;
    try { n = (JSON.parse(r.raw) as { run_number?: unknown }).run_number; } catch { /* no number captured */ }
    if (typeof n === "number" && Number.isInteger(n) && n > 0) return `${file} #${n}`;
    return r.sha ? `${file} ${r.sha.slice(0, 7)}` : file;
  };
  return releaseFacts(ctx, { tag: tagOf(latest), at: latest.occurred_at, author: latest.actor_login, sha: latest.sha, notes: null },
    s.branch, runs.slice(1, 9).reverse().map((r) => ({ tag: tagOf(r), at: r.occurred_at })));
}

/** The release facts once the latest release is chosen: `since` and `waiting` on `branch` from the push that carried
 *  its commit (else its date), the handles, the cadence as given. */
async function releaseFacts(
  ctx: TenantContext, latest: { tag: string; at: string; author: string | null; sha: string | null; notes: string | null },
  branch: string, cadence: { tag: string; at: string }[],
): Promise<FactsRelease> {
  const pushed = latest.sha
    ? await first<{ at: string | null }>(ctx, `SELECT MIN(occurred_at) AS at FROM repo_events WHERE org_id = ? AND kind = 'push' AND ref = ? AND sha = ?`, ctx.orgId, branch, latest.sha)
    : null;
  const start = pushed?.at ?? latest.at;

  const pushSince = await recordingSince(ctx, "push");
  const commits = pushSince !== null && pushSince <= start
    ? (await first<{ n: number | null }>(ctx,
        `SELECT SUM(COALESCE(count, 0)) AS n FROM repo_events WHERE org_id = ? AND kind = 'push' AND ref = ? AND occurred_at > ?`,
        ctx.orgId, branch, start))?.n ?? 0
    : null;

  // A PR's merge is the FIRST captured row that says merged (a later edit of a merged PR adds another).
  const merged = await all<{ number: number; merged_at: string }>(ctx,
    `SELECT number, MIN(occurred_at) AS merged_at FROM repo_events
      WHERE org_id = ? AND kind = 'pr' AND state = 'merged' AND number IS NOT NULL AND json_extract(raw, '$.base') = ?
      GROUP BY number HAVING MIN(occurred_at) > ? ORDER BY merged_at DESC, number DESC`,
    ctx.orgId, branch, start);
  const prSince = await recordingSince(ctx, "pr");
  const prs = prSince !== null && prSince <= start ? merged.length : null;

  const shown = merged.slice(0, WAITING_MAX);
  const detail = await fanOut<{ number: number; title: string | null; actor_login: string | null; raw: string }>(
    ctx, shown.map((m) => m.number),
    (p) => `SELECT number, title, actor_login, raw FROM repo_events WHERE org_id = ? AND kind = 'pr' AND number IN (${p}) ORDER BY occurred_at DESC, id DESC`,
    [ctx.orgId]);
  const byNumber = new Map<number, { title: string | null; login: string | null; labels: string[] | null }>();
  for (const d of detail) {
    const cur = byNumber.get(d.number) ?? { title: null, login: null, labels: null };
    cur.title ??= d.title;
    cur.login ??= d.actor_login;
    if (cur.labels === null) {
      try {
        const raw = JSON.parse(d.raw) as { labels?: unknown };
        if (Array.isArray(raw.labels)) cur.labels = raw.labels.filter((l): l is string => typeof l === "string");
      } catch { /* a row without a readable slice says nothing about labels */ }
    }
    byNumber.set(d.number, cur);
  }

  const handle = await handlesOf(ctx, [latest.author, ...[...byNumber.values()].map((d) => d.login)]);
  const waiting: FactsReleaseWaiting[] = shown.map((m) => {
    const d = byNumber.get(m.number);
    const title = d?.title ?? `#${m.number}`;
    return { pr: m.number, title, by: handle(d?.login ?? null), mergedAt: m.merged_at, feature: isFeaturePr(d?.title ?? null, d?.labels ?? []) };
  });

  return { tag: latest.tag, at: latest.at, by: handle(latest.author), notes: latest.notes, since: { commits, prs }, waiting, cadence };
}

/** Every tag Trov holds for the repository (releases' tags included — a release IS a tag): the count, the
 *  newest, and the newest four — `FactsUnseen.tags` and the Apps tab's release-signal choice
 *  (`RepoAppsSetupDTO.tags`, which takes `count` and `latest`). D1 only. `null` when nothing is held AND reconcile
 *  has not read this repository's list yet (`releases_reconciled`) — "not read yet" is never "no tags". */
export async function readTags(ctx: TenantContext, repo: string): Promise<FactsUnseen["tags"]> {
  const count = (await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM releases WHERE org_id = ? AND repo = ?`, ctx.orgId, repo))?.n ?? 0;
  if (count === 0) {
    const marker = await getSnapshot<{ repo?: unknown }>(ctx, RELEASES_RECONCILED);
    if (!(typeof marker?.data?.repo === "string" && marker.data.repo.toLowerCase() === repo.toLowerCase())) return null;
  }
  const recent = await all<{ tag: string; published_at: string; author: string | null }>(ctx,
    `SELECT tag, published_at, author FROM releases WHERE org_id = ? AND repo = ? ORDER BY published_at DESC, tag DESC LIMIT 4`, ctx.orgId, repo);
  const handle = await handlesOf(ctx, recent.map((r) => r.author));
  const list = recent.map((r) => ({ tag: r.tag, at: r.published_at, by: handle(r.author) }));
  return { count, latest: list[0] ?? null, recent: list };
}

/**
 * The week tile `releases` (`FactsWeekFigure`): releases published in the last 7 days and the change from the
 * 7 before — over the same pool as `readRelease` (releases, else tags; never a prerelease). Both `null` until
 * reconcile has read this repository's list (`releases_reconciled`): before that, 0 would be "not read yet"
 * posing as "none".
 */
export async function releaseWeekFigure(ctx: TenantContext, repo: string, now: number = Date.now()): Promise<FactsWeekFigure> {
  const marker = await getSnapshot<{ repo?: unknown }>(ctx, RELEASES_RECONCILED);
  const read = typeof marker?.data?.repo === "string" && marker.data.repo.toLowerCase() === repo.toLowerCase();
  if (!read) return { key: "releases", value: null, delta: null };
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(now - 14 * DAY).toISOString();
  const rows = await pool(ctx, repo, null, 500, twoWeeksAgo);
  const nowIsoStr = new Date(now).toISOString();
  const thisWeek = rows.filter((r) => r.published_at > weekAgo && r.published_at <= nowIsoStr).length;
  const lastWeek = rows.filter((r) => r.published_at > twoWeeksAgo && r.published_at <= weekAgo).length;
  return { key: "releases", value: thisWeek, delta: thisWeek - lastWeek };
}
