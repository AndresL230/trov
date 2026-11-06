// The Sample workspace (0087_sample_orgs; organizations.md › 1e): an organization every new person gets at
// onboarding, filled with made-up content (src/orgs/sample-content.ts) so they — and anyone reviewing the MCP
// connector, who signs in through the MCP OAuth flow — can try every tool with nothing set up.
//
// It is an ordinary org written by `createOrg` (owner, plan row, counters, starter tags and spaces, notification
// rows), on Free with `orgs.sample = 1`, and its content rides in `createOrg`'s `extra`: ONE batch, all or nothing.
// What makes it different:
//   · it does not count toward the one Free org a person may own (src/plans/free.ts `OWNED_FREE`);
//   · it is INERT: `ai_automation = 0` (no model), every digest kind disabled (no mail), and every background job
//     skips it (src/platform/jobs.ts, the sweeps, src/plans/gifts.ts) — nothing ever calls GitHub, a hosting
//     provider or the mail sender for it; Sync GitHub and Poll now refuse it (`sampleRefusal`, src/routes.ts);
//   · one per person: a second ask returns the one they own (the guard row below holds it inside the batch).
// Every author is the person themselves (there are no made-up persons; every handle column is in HANDLE_COLUMNS).
import { type PlatformContext, type Stmt, first as platformFirst, stmt as platformStmt } from "../data/platform-sql";
import { stmt, type TenantContext } from "../data/sql";
import { contentHash } from "../hash";
import { scrub } from "../data/secrets";
import { FREE_PLAN } from "@shared/plans";
import { orgSlugProblem } from "@shared/orgs";
import { extractDocLinks } from "@shared/docs-links-core";
import { composePlanNarrative } from "@shared/sprints-core";
import { OrgError, createOrg, type OrgRow } from "./repo";
import * as C from "./sample-content";

const DAY = 86_400_000;
const HOUR = 3_600_000;

const ORG_COLS = `o.id, o.slug, o.name, o.created_at, o.created_by, o.suspended_at, o.suspended_by, o.logo_sha`;
// The sample orgs `handle` OWNS — suspended ones too, like OWNED_FREE.
const OWNED_SAMPLE = `FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 COLLATE NOCASE AND m.role = 'owner' AND o.sample = 1`;

/** The Sample workspace `handle` owns (the oldest, should there be more), or null. */
export function ownedSampleOrg(p: PlatformContext, handle: string): Promise<OrgRow | null> {
  return platformFirst<OrgRow>(p, `SELECT ${ORG_COLS} ${OWNED_SAMPLE} ORDER BY o.created_at ASC LIMIT 1`, handle);
}

/** Is `orgId` a Sample workspace? A platform read; false for an unknown id. */
export async function isSampleOrg(p: PlatformContext, orgId: string): Promise<boolean> {
  return (await platformFirst<{ sample: number }>(p, `SELECT sample FROM orgs WHERE id = ?`, orgId))?.sample === 1;
}

/** What a route that would reach GitHub or a host answers for a Sample workspace (Sync GitHub, Poll now, …). */
export const SAMPLE_REFUSAL = {
  error: "sample_org",
  message: "This is a Sample workspace: its data is made up, so it connects to nothing. Create an organization of your own to connect GitHub or a host.",
} as const;

/**
 * The tenant routes (after `/api/o/:slug`) that could make Trov call GitHub, a hosting provider or any other
 * outside service for the org — run a job (Sync GitHub, Poll now), start or test a connection, store a credential,
 * connect a repository (its image is imported from GitHub), Scan again, or remove an image (the import is retried).
 * On a Sample workspace each is refused with 409 `sample_org` and does nothing (`sampleGuard`, src/routes.ts).
 */
const OUTBOUND: ReadonlyArray<readonly [method: string, path: RegExp]> = [
  ["POST", /^\/admin\/(backfill|poll|poll-usage)$/],
  ["GET", /^\/github\/install$/],
  ["POST", /^\/github\/(repositories|test)$/],
  ["POST", /^\/hosting\/[^/]+\/(connect|test)$/],
  ["PUT", /^\/integrations(\/|$)/],
  ["POST", /^\/integrations(\/|$)/],
  ["POST", /^\/repos$/],
  ["POST", /^\/repos\/[^/]+\/[^/]+\/scan$/],
  ["POST", /^\/logo\/remove$/],
];

/** Does `method` + `suffix` (the path after `/api/o/:slug`) reach outside Trov? */
export const reachesOutside = (method: string, suffix: string): boolean => OUTBOUND.some(([m, re]) => m === method && re.test(suffix));

/** `sample-<handle>`, fixed up to be a valid slug: lowercase, every other character a hyphen, at most 39. */
export function sampleSlug(handle: string): string {
  const base = `sample-${handle.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`.replace(/-{2,}/g, "-").slice(0, 39).replace(/-+$/, "");
  return orgSlugProblem(base) ? "sample-workspace" : base;
}

const suffixed = (slug: string): string => {
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  return `${slug.slice(0, 34).replace(/-+$/, "")}-${tail}`;
};

/** The guard (the pattern of src/plans/free.ts `freeGuardStmt`): the org's `org.create_sample` audit row, with a NULL
 *  `detail` — which fails the batch — when, counting the org being created, the person owns more than one. */
const guardStmt = (p: PlatformContext, handle: string, orgId: string, slug: string, at: string): Stmt =>
  platformStmt(p, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at)
                   VALUES (?2, ?1, 'org.create_sample', ?3, CASE WHEN (SELECT COUNT(*) ${OWNED_SAMPLE}) <= 1 THEN '{}' END, ?4)`,
    handle, orgId, slug, at);
const SAMPLE_SPENT = /NOT NULL constraint failed: org_admin_audit\.detail/i;

/**
 * The Sample workspace of `handle`: the one they own, or a new one. `p.actor` is recorded as its creator. A slug
 * that is taken gets a short random suffix, once. Throws what `createOrg` throws otherwise — the onboarding caller
 * logs it and carries on (a person is never kept from signing in by this).
 */
export async function createSampleOrg(p: PlatformContext, handle: string): Promise<OrgRow> {
  const owned = await ownedSampleOrg(p, handle);
  if (owned) return owned;
  const hashes = await contentHashes();
  const attempt = (slug: string) => createOrg(p, {
    slug, name: C.SAMPLE_ORG_NAME, owner: handle,
    plan: { id: FREE_PLAN, overrides: {}, source: "granted" },
    extra: (orgId, at, sys) => [
      guardStmt(p, handle, orgId, slug, at),
      // Inert: a sample, no model, no digest.
      platformStmt(p, `UPDATE orgs SET sample = 1, ai_automation = 0 WHERE id = ?`, orgId),
      stmt(sys, `UPDATE notification_policy SET enabled = 0, updated_by = 'registry' WHERE org_id = ?`, sys.orgId),
      ...sampleContentStmts(sys, handle, Date.parse(at), hashes),
    ],
  });
  const slug = sampleSlug(handle);
  try {
    try {
      return await attempt(slug);
    } catch (e) {
      if (e instanceof OrgError && e.code === "slug_taken") return await attempt(suffixed(slug));
      throw e;
    }
  } catch (e) {
    // A racing request made theirs first: answer with it.
    if (SAMPLE_SPENT.test(e instanceof Error ? e.message : String(e))) {
      const now = await ownedSampleOrg(p, handle);
      if (now) return now;
    }
    throw e;
  }
}

/**
 * `createSampleOrg` for a person who just signed up, which NEVER throws: a failure is logged (scrubbed, then cut —
 * nothing here reveals a credential, but the rule is the rule) and sign-in carries on without a sample.
 */
export async function createSampleOrgSafely(p: PlatformContext, handle: string): Promise<OrgRow | null> {
  try {
    return await createSampleOrg(p, handle);
  } catch (e) {
    console.error("sample workspace", e instanceof Error ? e.name : "error", scrub(e instanceof Error ? e.message : String(e), []).slice(0, 300));
    return null;
  }
}

// ── the content ──────────────────────────────────────────────────────────────────────────────────────────────

interface Hashes { docs: Map<string, string>; adrs: string[] }

async function contentHashes(): Promise<Hashes> {
  const docs = new Map<string, string>();
  for (const d of C.DOCS) for (const [, , body] of d.versions) docs.set(body, await contentHash(body));
  // The gate's ADR hash (src/consumer.ts): the four fields joined by NUL.
  const adrs = await Promise.all(C.ADRS.map(([title, , , context, decision, rationale]) => contentHash([title, context, decision, rationale].join("\u0000"))));
  return { docs, adrs };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** A made-up 40-character commit sha, stable for a name. */
function fakeSha(name: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  let out = "";
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${name}:${round}`) {
      h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
      h2 = Math.imul(h2 + ch.charCodeAt(0), 2246822519) >>> 0;
    }
    out += (h1 ^ h2).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

/**
 * Every tenant row of the sample content, as `sys` (the new org's system tenant). `now` is the creation instant;
 * every time is relative to it and never later than it (a sprint's dates may be in the future).
 */
export function sampleContentStmts(sys: TenantContext, me: string, now: number, hashes: Hashes): Stmt[] {
  const org = sys.orgId;
  const ago = (days: number): string => new Date(now - Math.max(days * DAY, 1_000)).toISOString();
  const date = (daysFromNow: number): string => new Date(now + daysFromNow * DAY).toISOString().slice(0, 10);
  const s: Stmt[] = [];

  // ── the Library: five pages, their history, links and tags ──
  for (const d of C.DOCS) {
    const [liveDays, , liveBody] = d.versions[d.versions.length - 1];
    s.push(stmt(sys, `INSERT INTO docs (org_id, slug, section, space, title, body, current_version, updated_at, updated_by, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      org, d.slug, d.section, d.space, d.title, liveBody, d.versions.length, ago(liveDays), me, me));
    d.versions.forEach(([days, summary, body], i) => {
      s.push(stmt(sys, `INSERT INTO doc_versions (org_id, slug, version, body, summary, status, confidence, created_at, created_by, content_hash, base_version, change_kind, low_confidence, promoted_at)
                        VALUES (?, ?, ?, ?, ?, 'promoted', 'high', ?, ?, ?, ?, ?, 0, ?)`,
        org, d.slug, i + 1, body, summary, ago(days), me, hashes.docs.get(body) ?? null, i === 0 ? null : i, i === 0 ? "create" : "edit", ago(days)));
    });
    for (const to of new Set(extractDocLinks(liveBody))) {
      if (to !== d.slug) s.push(stmt(sys, `INSERT OR IGNORE INTO doc_links (org_id, from_slug, to_slug) VALUES (?, ?, ?)`, org, d.slug, to));
    }
    for (const tag of d.tags) s.push(stmt(sys, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, 'doc', ?)`, org, tag, d.slug));
  }

  // ── decisions ──
  C.ADRS.forEach(([title, status, days, context, decision, rationale], i) => {
    s.push(stmt(sys, `INSERT INTO adrs (org_id, title, context, decision, rationale, status, confidence, created_at, created_by, content_hash) VALUES (?, ?, ?, ?, ?, ?, 'high', ?, ?, ?)`,
      org, title, context, decision, rationale, status, ago(days), me, hashes.adrs[i]));
  });
  s.push(stmt(sys, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) SELECT ?, 'auth', 'adr', CAST(id AS TEXT) FROM adrs WHERE org_id = ? AND title = ?`,
    org, org, C.ADRS[0][0]));

  // ── sprints ──
  for (const sp of C.SPRINTS) {
    const start = date(sp.start), due = date(sp.due);
    s.push(stmt(sys, `INSERT INTO sprints (org_id, title, description, summary, dates, start_date, target_date, status, urgency, lead, created_at, created_by, updated_at, completed_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      org, sp.title, sp.description, sp.summary, `${shortDay(start)} – ${shortDay(due)}`, start, due, sp.status, sp.urgency, me,
      ago(-sp.start + 2), me, ago(sp.status === "done" ? -sp.due : 1), sp.status === "done" ? ago(-sp.due) : null));
  }
  const sprintTitle = (key: string | null): string | null => C.SPRINTS.find((x) => x.key === key)?.title ?? null;

  // ── tickets: every one assigned to the person; numbers 1…N, the counter moved past them ──
  for (const t of C.TICKETS) {
    const last = t.moves[t.moves.length - 1];
    const touched = Math.min(last[1], ...(t.comments ?? []).map((c) => c[0]));
    s.push(stmt(sys, `INSERT INTO tickets (org_id, number, title, body, category, priority, status, requester, sprint_id, created_at, updated_at, source)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM sprints WHERE org_id = ? AND title = ?), ?, ?, 'canopy')`,
      org, t.n, t.title, t.body, t.category, t.priority, last[0], me, org, sprintTitle(t.sprint), ago(t.moves[0][1]), ago(touched)));
    s.push(stmt(sys, `INSERT INTO ticket_assignees (org_id, ticket_id, login) SELECT ?, id, ? FROM tickets WHERE org_id = ? AND number = ?`, org, me, org, t.n));
    let from: string | null = null;
    for (const [to, days] of t.moves) {
      s.push(stmt(sys, `INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) SELECT ?, id, ?, ?, ?, ? FROM tickets WHERE org_id = ? AND number = ?`,
        org, me, from, to, ago(days), org, t.n));
      from = to;
    }
    for (const [days, body] of t.comments ?? []) {
      s.push(stmt(sys, `INSERT INTO ticket_comments (org_id, ticket_id, author, body, created_at) SELECT ?, id, ?, ?, ? FROM tickets WHERE org_id = ? AND number = ?`,
        org, me, body, ago(days), org, t.n));
    }
  }
  for (const t of C.TICKETS) {
    if (t.parent) s.push(stmt(sys, `UPDATE tickets SET parent_id = (SELECT p.id FROM tickets p WHERE p.org_id = ? AND p.number = ?) WHERE org_id = ? AND number = ?`, org, t.parent, org, t.n));
  }
  s.push(stmt(sys, `UPDATE org_counters SET value = ? WHERE org_id = ? AND name = 'ticket'`, C.TICKETS.length, org));

  // ── the feed: authored entries, live, starter tags only ──
  for (const [days, summary, body, tags, importance] of C.FEED) {
    s.push(stmt(sys, `INSERT INTO feed (org_id, author, summary, body, created_at, importance, origin) VALUES (?, ?, ?, ?, ?, ?, 'agent')`,
      org, me, summary, body, ago(days), importance));
    for (const tag of tags) {
      s.push(stmt(sys, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) SELECT ?, ?, 'feed', CAST(id AS TEXT) FROM feed WHERE org_id = ? AND summary = ?`,
        org, tag, org, summary));
    }
  }

  // ── one pending handoff, from the person's "last session" to themselves ──
  const sent = new Date(now - C.HANDOFF.hoursAgo * HOUR).toISOString();
  s.push(stmt(sys, `INSERT INTO handoffs (org_id, number, sender, recipient, status, body, context, created_at, expires_at) VALUES (?, 1, ?, ?, 'pending', ?, ?, ?, ?)`,
    org, me, me, C.HANDOFF.body, JSON.stringify(C.HANDOFF.context), sent, new Date(Date.parse(sent) + 7 * DAY).toISOString()));
  s.push(stmt(sys, `UPDATE org_counters SET value = 1 WHERE org_id = ? AND name = 'handoff'`, org));

  // ── two published prompts ──
  for (const pr of C.PROMPTS) {
    s.push(stmt(sys, `INSERT INTO prompts (org_id, slug, title, description, tags, author, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      org, pr.slug, pr.title, pr.description, JSON.stringify(pr.tags), me, ago(pr.days), ago(pr.days)));
    s.push(stmt(sys, `INSERT INTO prompt_versions (org_id, slug, version, status, author, summary, body, created_at) VALUES (?, ?, 1, 'published', ?, 'First version', ?, ?)`,
      org, pr.slug, me, pr.body, ago(pr.days)));
  }

  // ── the roadmap narrative (version 1), in its one stored form: Now / Next / Later ──
  const narrative = composePlanNarrative(C.NARRATIVE);
  s.push(stmt(sys, `INSERT INTO plan_versions (org_id, version, narrative, sprints_json, created_at, created_by)
                    SELECT ?, 1, ?, (SELECT json_group_array(json_object('id', id, 'title', title)) FROM sprints WHERE org_id = ?), ?, ?`,
    org, narrative, org, ago(8), me));
  s.push(stmt(sys, `UPDATE plan SET narrative = ?, current_version = 1, updated_at = ?, updated_by = ? WHERE org_id = ?`, narrative, ago(8), me, org));

  s.push(...repoStmts(sys, me, now));
  return s;
}

/** The Repo dashboard's stored rows: one made-up repository, staging and production, deploys, CI runs, pull requests.
 *  Stored rows only — the screen reads them (invariant 7) and no job ever refreshes them (the jobs skip the org). */
function repoStmts(sys: TenantContext, me: string, now: number): Stmt[] {
  const org = sys.orgId;
  const repo = C.SAMPLE_REPO;
  const ago = (days: number): string => new Date(now - Math.max(days * DAY, 1_000)).toISOString();
  const s: Stmt[] = [];
  const hookId = `hook_sample_${org.slice(4, 20)}`;
  s.push(stmt(sys, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by, connection) VALUES (?, ?, ?, 1, ?, ?, 'manual')`,
    hookId, org, repo, ago(30), me));
  C.ENVIRONMENTS.forEach(([key, label, branch, url, note], i) => {
    s.push(stmt(sys, `INSERT INTO org_environments (org_id, key, position, label, note, branch, frontend_url, api_url, health_path, created_at, updated_at, updated_by)
                      VALUES (?, ?, ?, ?, ?, ?, ?, '', '/health', ?, ?, ?)`, org, key, i, label, note, branch, url, ago(30), ago(30), me));
    s.push(stmt(sys, `INSERT INTO org_environment_parts (org_id, env_key, part_key, position, label, role, provider, settings, created_at, updated_at, updated_by)
                      VALUES (?, ?, 'web', 0, 'Web', 'web', 'vercel', ?, ?, ?, ?)`, org, key, JSON.stringify({ project: `habitloop-${key}` }), ago(30), ago(30), me));
  });

  // Deploys, one web part per environment.
  C.DEPLOYS.forEach(([env, days, state, pr, reason], i) => {
    const branch = C.ENVIRONMENTS.find((e) => e[0] === env)?.[2] ?? "main";
    const url = C.ENVIRONMENTS.find((e) => e[0] === env)?.[3] ?? null;
    s.push(stmt(sys, `INSERT INTO hosting_deploys (org_id, env, part, provider, deploy_id, state, target, sha, branch, message, actor, url, created_at, ready_at, recorded_at, updated_at, source, reason, sha_source)
                      VALUES (?, ?, 'web', 'vercel', ?, ?, 'production', ?, ?, ?, 'habitloop-dev', ?, ?, ?, ?, ?, 'provider', ?, 'provider')`,
      org, env, `sample-${i + 1}`, state, fakeSha(`merge-${pr}`), branch, `Merge #${pr}`, state === "ready" ? url : null,
      ago(days), state === "ready" ? ago(days - 0.002) : null, ago(days), ago(days), reason));
  });

  // repo_events: pull requests (opened → merged, reviews), the branch heads, CI runs.
  let k = 0;
  const ev = (o: { kind: string; ref?: string | null; sha?: string | null; number?: number | null; state?: string | null; name?: string | null; by?: string | null; title?: string | null; url?: string | null; count?: number | null; raw: unknown; days: number }) => {
    k++;
    s.push(stmt(sys, `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'webhook', ?, ?)`,
      org, repo, `sample:${o.kind}:${k}`, o.kind, o.ref ?? null, o.sha ?? null, o.number ?? null, o.state ?? null, o.name ?? null, o.by ?? null,
      o.title ?? null, o.url ?? null, o.count ?? null, JSON.stringify(o.raw), ago(o.days), ago(o.days)));
  };
  const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;
  for (const [n, by, days, title] of C.PRS_MERGED) {
    const branch = `feat/pr-${n}`;
    ev({ kind: "pr", number: n, state: "review", ref: branch, sha: fakeSha(`pr-${n}`), by, title, url: prUrl(n), days: days + 1, raw: { action: "opened", base: "main", draft: false, labels: [] } });
    ev({ kind: "review", number: n, state: "approved", by: "habitloop-reviewer", url: `${prUrl(n)}#pullrequestreview-${n}01`, days: days + 0.2, raw: { action: "submitted" } });
    ev({ kind: "pr", number: n, state: "merged", ref: branch, sha: fakeSha(`pr-${n}`), by, title, url: prUrl(n), days, raw: { action: "closed", base: "main", draft: false, labels: [] } });
    ev({ kind: "push", ref: "main", sha: fakeSha(`merge-${n}`), by, title: `Merge #${n} ${title}`, count: 1, days: days - 0.001,
      raw: { before: fakeSha(`before-${n}`), forced: false, commits: [{ id: fakeSha(`merge-${n}`), distinct: true, subject: `Merge #${n} ${title}`, at: ago(days - 0.001), author: by }] } });
  }
  for (const [n, by, days, title, branch, draft] of C.PRS_OPEN) {
    ev({ kind: "pr", number: n, state: draft ? "draft" : "review", ref: branch, sha: fakeSha(`pr-${n}`), by, title, url: prUrl(n), days, raw: { action: "opened", base: "main", draft, labels: [] } });
  }
  C.RUNS.forEach(([days, name, state, job], i) => {
    const id = 7_700_000 + i;
    ev({ kind: "run", number: id, name, ref: "main", sha: fakeSha(`run-${i}`), state, title: state === "failure" ? job : null, by: "habitloop-dev",
      url: `https://github.com/${repo}/actions/runs/${id}`, count: 1, days,
      raw: { event: "push", started_at: ago(days + 0.004), path: `.github/workflows/${name.toLowerCase()}.yml`, run_number: 300 + i } });
  });
  // Where each environment's branch stands: production is on #43, main on #45.
  const heads = { main: fakeSha("merge-45"), production: fakeSha("merge-43") };
  s.push(stmt(sys, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'env_heads', ?, ?)`, org, JSON.stringify(heads), ago(0.05)));
  s.push(stmt(sys, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'prs_reconciled', ?, ?)`, org, JSON.stringify({ at: ago(0.05) }), ago(0.05)));
  return s;
}
