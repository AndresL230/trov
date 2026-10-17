#!/usr/bin/env node
// The `team` scenario's RICH LAYER: SaplingLearn as a busy small team — 73 more tickets across every status, four
// sprints (done, late, current, planned), ten handoffs, 41 feed entries over six weeks, seven docs with version
// history and staged proposals, four decisions, Unplaced items, prompts, artifacts, and twelve weeks of repository
// activity for the Repo screen (pushes, PRs, reviews, CI runs, deploys on both environments, health, hourly usage,
// product metrics, releases). The content is scripts/seed/team-content.mjs; this file writes it.
//
// LOCAL D1 ONLY — it refuses --remote, like every seed. It runs two ways:
//   • inside the `team` scenario (`npm run seed`, scripts/seed/scenarios.mjs), after the canonical dev fixtures and
//     before the AI showcase;
//   • ALONE, on top of whatever SaplingLearn already holds (the shared preview server):
//       cd <the folder wrangler dev serves from> && node <this repo>/scripts/seed/team-rich.mjs [--persist-to <dir>]
//     then rerun scripts/seed/ai-showcase.mjs if the AI rows should talk about the new repository state.
//
// IDEMPOTENT, stamped against the clock at run time. It deletes and rewrites ONLY what it owns, in org_saplinglearn:
//   • id blocks 7000–7999: tickets 7008–7080 (NUMBERS 8–80, the gap the canonical fixtures leave), sprints, feed,
//     Unplaced items, artifact pages and the four tags it adds; handoffs 7001–7010 (numbers 1–10); ADRs 7–10;
//   • its docs and prompts (by slug), its sections (INSERT OR IGNORE), plan version 2 (the Sapling narrative);
//   • the repository's captured activity for PR / issue numbers 206–262 (events + pr_summaries), every repo_events
//     row whose semantic key starts `rich:`, and — like scripts/seed/repo-setups.mjs, whose SaplingLearn rows it
//     replaces — the org's environments, parts, deploys, poll state, hosting credentials (DUMMY metadata, never a
//     key), health / hosting / product / coverage metrics, repo snapshots and releases;
//   • two made-up members (`priya-n`, `omar-h`: example.com e-mail, fake GitHub logins), Jose's admin role, and
//     one pending invitation to new-hire@example.com.
//   • the org's plumbing rows marked `dev-seed` (placeholder MCP / OAuth token HASHES, spent upload links, the ingest
//     ledger, mail it "sent"), and wholesale for the org: Sync runs, the AI pass's dirty list, notification policy /
//     preferences, the GitHub App binding, the audit trails.
// It also SETS, on rows it does not own: the canonical fixtures' sprints 3–7's dates and statuses
// (`CANONICAL_SPRINT_DATES`, relative to today — otherwise they read months overdue; sprint 3 done) and the plan
// narrative (version 2, Sapling's own).
// Running scripts/seed/repo-setups.mjs afterwards puts its e2e hosting rows back (last one wins).
import { createHash } from "node:crypto";
import { targetsRemote } from "./build.mjs";
import * as C from "./team-content.mjs";
import guideArtifacts from "../../fixtures/dev/artifacts.json" with { type: "json" };

export const ORG = "org_saplinglearn";
const { ME, JOSE, LUKE, JACK, MEI, SANA, PRIYA, OMAR, REPO } = C;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** GitHub logins (identity), by handle — the two added members have obviously fake ones. */
export const LOGIN = { [ME]: ME, [JOSE]: JOSE, [LUKE]: LUKE, [JACK]: JACK, [PRIYA]: "priya-example", [OMAR]: "omar-example" };
const login = (h) => LOGIN[h] ?? h;

// ── literals ─────────────────────────────────────────────────────────────────────────────────────────────────────
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "object") return q(JSON.stringify(v));
  return q(v);
};
/** A row → `INSERT INTO t (cols) VALUES (…)`; objects/arrays are stored as JSON text. */
export const insert = (table, row, verb = "INSERT") => `${verb} INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(lit).join(", ")})`;
/** Many rows with the same columns → multi-row INSERTs of at most `per` rows and ~60 KB each (D1 refuses a
 *  statement over 100 KB: SQLITE_TOOBIG). */
export function insertMany(table, rows, per = 150, verb = "INSERT") {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const head = `${verb} INTO ${table} (${cols.join(", ")}) VALUES `;
  const out = [];
  let batch = [], size = 0;
  for (const r of rows) {
    const v = `(${cols.map((c) => lit(r[c])).join(", ")})`;
    if (batch.length && (batch.length >= per || size + v.length > 60_000)) { out.push(head + batch.join(", ")); batch = []; size = 0; }
    batch.push(v);
    size += v.length + 2;
  }
  if (batch.length) out.push(head + batch.join(", "));
  return out;
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** A made-up commit sha, stable for a given name (a prefix keeps the ones the feed names). */
const sha = (name, prefix = "") => (prefix + createHash("sha1").update(`sapling:${name}`).digest("hex")).slice(0, 40);
/** A small fixed pseudo-random sequence in [0, 1). */
function sequence(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

/** The clock: `days(d)` is d days BEFORE now (negative = after), never later than a few seconds ago. */
export function makeClock(now = new Date()) {
  const t = now.getTime();
  return {
    t,
    days: (d) => new Date(Math.min(t - d * DAY, d >= 0 ? t - 5_000 : Infinity)).toISOString(),
    date: (d) => new Date(t + d * DAY).toISOString().slice(0, 10),
    hourFloor: (ms) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString(),
  };
}

// ── the canonical fixtures' sprints, against the clock ─────────────────────────────────────────────────────────
/**
 * fixtures/dev/roadmap.json's sprints 3–7 as every DEV seed loads them: [id, start, due (days from today), status,
 * done (days ago it was completed)]. The fixture keeps its absolute June dates — it is the TEST seed's too, and tests
 * pin them — so a dev seed dates it here instead (`datedRoadmap`), and the Roadmap never rots into months-overdue
 * sprints. ONE late sprint in the dev data, on purpose: the rich layer's 7002 "Gradebook export rework" (owner ruling
 * 2026-10-16) — so sprint 3 "Token rotation & audit log" is DONE (a person's act; a seed may set it, invariant 5),
 * completed 3 days ago, after the showcase's Ask thread that asked whether its date was still realistic.
 * Sprints 1 and 2 are done with their own (past) dates and stay as they are.
 */
export const CANONICAL_SPRINT_DATES = [[3, -40, -12, "done", 3], [4, -18, 3, "in_progress"], [5, 12, 40, "upcoming"], [6, 30, 60, "upcoming"], [7, 45, 75, "upcoming"]];
/** `CANONICAL_SPRINT_DATES` against clock `c`: id → the fields a dev seed writes. */
function datedSprints(c) {
  return CANONICAL_SPRINT_DATES.map(([id, start, due, status, doneAgo]) => {
    const a = c.date(start), b = c.date(due);
    return [id, { start_date: a, target_date: b, dates: `${shortDay(a)} – ${shortDay(b)}`, status, updated_at: doneAgo === undefined ? null : c.days(doneAgo) }];
  });
}
/** The roadmap fixture as a dev seed loads it (any path that builds the canonical fixtures for a person to look at):
 *  a COPY with sprints 3–7 dated against `now`. The fixture object itself is left alone. */
export function datedRoadmap(roadmap, now = new Date()) {
  const by = new Map(datedSprints(makeClock(now)));
  return { ...roadmap, sprints: (roadmap.sprints ?? []).map((sp) => (by.has(sp.id) ? { ...sp, ...by.get(sp.id), updated_at: by.get(sp.id).updated_at ?? sp.updated_at } : sp)) };
}

// ── what the layer owns ─────────────────────────────────────────────────────────────────────────────────────────
const BLOCK = "BETWEEN 7000 AND 7999";
const DOC_SLUGS = C.DOCS.map((d) => d.slug);
const PROMPT_SLUGS = C.PROMPTS.map((p) => p.slug);
const inList = (xs) => `(${xs.map(q).join(", ")})`;
const PR_LO = 206, PR_HI = 262;
const HOSTING_KINDS = ["cloudflare_analytics", "railway", "vercel", "render", "netlify", "fly", "metrics_endpoint"];

export function deleteStatements() {
  const O = q(ORG);
  return [
    // tickets (children first)
    ...["ticket_events", "ticket_assignees", "ticket_links", "ticket_comments"].map((t) => `DELETE FROM ${t} WHERE org_id = ${O} AND ticket_id ${BLOCK}`),
    `UPDATE tickets SET parent_id = NULL WHERE org_id = ${O} AND parent_id ${BLOCK}`,
    `DELETE FROM tickets WHERE org_id = ${O} AND id ${BLOCK}`,
    `DELETE FROM sprint_resources WHERE org_id = ${O} AND sprint_id ${BLOCK}`,
    `DELETE FROM sprint_progress WHERE org_id = ${O} AND sprint_id ${BLOCK}`,
    `DELETE FROM sprints WHERE org_id = ${O} AND id ${BLOCK}`,
    `DELETE FROM handoffs WHERE org_id = ${O} AND id ${BLOCK}`,
    // knowledge
    `DELETE FROM entry_tags WHERE org_id = ${O} AND ((entry_type = 'feed' AND CAST(entry_id AS INTEGER) ${BLOCK}) OR (entry_type = 'doc' AND entry_id IN ${inList(DOC_SLUGS)}) OR (entry_type = 'adr' AND CAST(entry_id AS INTEGER) BETWEEN 7 AND 10) OR tag IN (SELECT name FROM org_tags WHERE org_id = ${O} AND id ${BLOCK}))`,
    `DELETE FROM feed WHERE org_id = ${O} AND id ${BLOCK}`,
    `DELETE FROM org_tags WHERE org_id = ${O} AND id ${BLOCK}`,
    `DELETE FROM adrs WHERE org_id = ${O} AND id BETWEEN 7 AND 10`,
    `DELETE FROM needs_triage WHERE org_id = ${O} AND id ${BLOCK}`,
    `DELETE FROM doc_versions WHERE org_id = ${O} AND slug IN ${inList(DOC_SLUGS)}`,
    `DELETE FROM docs WHERE org_id = ${O} AND slug IN ${inList(DOC_SLUGS)}`,
    `DELETE FROM prompt_versions WHERE org_id = ${O} AND slug IN ${inList(PROMPT_SLUGS)}`,
    `DELETE FROM prompts WHERE org_id = ${O} AND slug IN ${inList(PROMPT_SLUGS)}`,
    `DELETE FROM artifact_links WHERE org_id = ${O} AND page_id ${BLOCK}`,
    `DELETE FROM artifact_versions WHERE org_id = ${O} AND page_id ${BLOCK}`,
    `DELETE FROM artifact_pages WHERE org_id = ${O} AND id ${BLOCK}`,
    `DELETE FROM plan_versions WHERE org_id = ${O} AND version = 2`,
    // the repository
    `DELETE FROM pr_summaries WHERE org_id = ${O} AND pr_number BETWEEN ${PR_LO} AND ${PR_HI}`,
    `DELETE FROM events WHERE org_id = ${O} AND ref_number BETWEEN ${PR_LO} AND ${PR_HI} AND event_type IN ('pr_merged', 'pr_closed', 'issue')`,
    `DELETE FROM repo_events WHERE org_id = ${O} AND (semantic_key LIKE 'rich:%' OR semantic_key LIKE 'test-e2e:%')`, // test-e2e: repo-setups' rows, which this layer replaces
    ...["hosting_deploys", "hosting_poll_state", "org_environment_parts", "repo_snapshots", "releases", "commit_paths", "pr_files", "pr_file_reads", "repo_settings", "repo_scans", "repo_app_suggestions"]
      .map((t) => `DELETE FROM ${t} WHERE org_id = ${O}`),
    `DELETE FROM repo_metrics WHERE org_id = ${O} AND (metric GLOB 'hx_*' OR metric GLOB 'health_*' OR metric GLOB 'active_users_*' OR metric GLOB 'sap_*' OR metric IN ('coverage', 'bundle_kb', 'todo_count'))`,
    `DELETE FROM org_hosting_connections WHERE org_id = ${O}`,
    `DELETE FROM org_secrets WHERE org_id = ${O} AND kind IN ${inList(HOSTING_KINDS)}`,
    `DELETE FROM org_environments WHERE org_id = ${O}`,
    // people
    `DELETE FROM org_invites WHERE org_id = ${O} AND email IN ${inList(C.INVITES.map((i) => i.email))}`,
  ];
}

// ── people ──────────────────────────────────────────────────────────────────────────────────────────────────────
function peopleStatements(c) {
  const s = [];
  for (const p of C.NEW_PEOPLE) {
    s.push(`INSERT INTO persons (handle, name, color, email, created_at, onboarded_at, role, responsibilities) VALUES (${q(p.handle)}, ${q(p.name)}, ${q(p.color)}, ${q(p.email)}, ${q(c.days(60))}, ${q(c.days(60))}, ${q(p.role)}, ${q(p.responsibilities)}) ` +
      `ON CONFLICT(handle) DO UPDATE SET name = excluded.name, color = excluded.color, email = excluded.email, role = excluded.role, responsibilities = excluded.responsibilities`);
    s.push(insert("identities", { provider: "google", subject: `google-sub-${p.handle}`, label: p.email, person: p.handle, linked_at: c.days(60), linked_by: "seed", verified_email: p.email }, "INSERT OR REPLACE"));
    s.push(insert("identities", { provider: "github", subject: LOGIN[p.handle], label: LOGIN[p.handle], person: p.handle, linked_at: c.days(60), linked_by: "seed" }, "INSERT OR REPLACE"));
    s.push(insert("memberships", { org_id: ORG, user_id: p.handle, role: "member", title: p.role, responsibilities: p.responsibilities, created_at: c.days(60), created_by: ME }, "INSERT OR REPLACE"));
    s.push(insert("org_login_map", { org_id: ORG, github_login: LOGIN[p.handle], person: p.handle, mapped_at: c.days(60), mapped_by: "seed" }, "INSERT OR REPLACE"));
  }
  for (const [h, role] of Object.entries(C.ROLES)) s.push(`UPDATE memberships SET role = ${q(role)} WHERE org_id = ${q(ORG)} AND user_id = ${q(h)}`);
  for (const i of C.INVITES) s.push(insert("org_invites", { org_id: ORG, email: i.email, role: i.role, invited_by: i.invited_by, status: "pending", created_at: c.days(i.days), name: i.name }));
  return s;
}

// ── tickets, sprints, handoffs ──────────────────────────────────────────────────────────────────────────────────
const sprintId = (key) => C.SPRINTS.find((x) => x.key === key)?.id ?? null;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

function workStatements(c) {
  const s = [];
  for (const sp of C.SPRINTS) {
    const start = c.date(sp.start), due = c.date(sp.due);
    s.push(insert("sprints", {
      id: sp.id, org_id: ORG, title: sp.title, description: sp.description, summary: sp.summary, phase: null, dates: `${shortDay(start)} – ${shortDay(due)}`,
      start_date: start, target_date: due, status: sp.status, urgency: sp.urgency, lead: sp.lead, domain: sp.domain, github_ref: null,
      created_at: c.days(Math.max(-sp.start + 3, 3)), created_by: sp.lead, updated_at: c.days(sp.status === "done" ? -sp.due : 1),
    }));
    for (const [url, kind, label, meta] of sp.resources) s.push(insert("sprint_resources", { org_id: ORG, sprint_id: sp.id, url, kind, label, meta }));
  }
  // The canonical fixtures' sprints 3–7 carry fixed dates from June, so by now they read months overdue: their dates
  // and statuses come from `CANONICAL_SPRINT_DATES` (an idempotent UPDATE on rows the layer does not own — the AI
  // showcase reads sprint 3's date back, so run it after this layer, as the `team` scenario does).
  for (const [id, sp] of datedSprints(c)) {
    s.push(`UPDATE sprints SET start_date = ${q(sp.start_date)}, target_date = ${q(sp.target_date)}, dates = ${q(sp.dates)}, status = ${q(sp.status)}${sp.updated_at ? `, updated_at = ${q(sp.updated_at)}` : ""} WHERE org_id = ${q(ORG)} AND id = ${id}`);
  }
  for (const [n, title, category, priority, requester, assignees, sprint, moves, body, extra = {}] of C.TICKETS) {
    const id = 7000 + n;
    const last = moves.at(-1);
    const lastComment = Math.min(...(extra.comments ?? []).map((x) => x[1]), last[1]);
    s.push(insert("tickets", {
      id, org_id: ORG, number: n, title, body, category, priority, status: last[0], requester, parent_id: null, sprint_id: sprint ? sprintId(sprint) : null,
      created_at: c.days(moves[0][1]), updated_at: c.days(lastComment), source: "canopy",
    }));
    for (const a of assignees) s.push(insert("ticket_assignees", { org_id: ORG, ticket_id: id, login: a }));
    let from = null;
    for (const [to, d, actor] of moves) {
      s.push(insert("ticket_events", { org_id: ORG, ticket_id: id, actor, from_status: from, to_status: to, created_at: c.days(d) }));
      from = to;
    }
    for (const [url, kind, label, meta, d, by] of extra.links ?? []) s.push(insert("ticket_links", { org_id: ORG, ticket_id: id, url, kind, label, meta, created_by: by, created_at: c.days(d), locked: 0 }));
    for (const [author, d, text] of extra.comments ?? []) s.push(insert("ticket_comments", { org_id: ORG, ticket_id: id, author, body: text, created_at: c.days(d) }));
  }
  // Parents in a second pass (tickets.parent_id references tickets(id)).
  for (const [n, , , , , , , , , extra = {}] of C.TICKETS) if (extra.parent) s.push(`UPDATE tickets SET parent_id = ${7000 + extra.parent} WHERE org_id = ${q(ORG)} AND id = ${7000 + n}`);
  // The org's ticket counter moves past every number (the next ticket filed in the app continues the series).
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES (${q(ORG)}, 'ticket', (SELECT COALESCE(MAX(number), 0) FROM tickets WHERE org_id = ${q(ORG)})) ON CONFLICT(org_id, name) DO UPDATE SET value = MAX(org_counters.value, excluded.value)`);

  for (const [n, sender, recipient, status, created, claimed, claimedBy, body, ctx, prompt] of C.HANDOFFS) {
    const at = c.days(created);
    s.push(insert("handoffs", {
      id: 7000 + n, org_id: ORG, number: n, sender, recipient, status, body,
      context: { repo: REPO, branch: ctx.branch ?? "", task: ctx.task ?? "", done: ctx.done ?? [], next: ctx.next ?? [], files: ctx.files ?? [] },
      prompt_title: prompt?.title ?? null, prompt_body: prompt?.body ?? null, created_at: at,
      claimed_at: claimed == null ? null : c.days(claimed), claimed_by: claimedBy, claimed_by_session: claimedBy ? `session-${n}-${claimedBy.toLowerCase()}` : null,
      expires_at: new Date(Date.parse(at) + 7 * DAY).toISOString(),
    }));
  }
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES (${q(ORG)}, 'handoff', (SELECT COALESCE(MAX(number), 0) FROM handoffs WHERE org_id = ${q(ORG)})) ON CONFLICT(org_id, name) DO UPDATE SET value = MAX(org_counters.value, excluded.value)`);
  return s;
}

// ── knowledge: tags, feed, decisions, Unplaced, docs, prompts, artifacts, the roadmap narrative ──────────────────────
function knowledgeStatements(c) {
  const s = [];
  for (const t of C.TAGS) s.push(insert("org_tags", { id: t.id, org_id: ORG, name: t.name, description: t.description, color: t.color, starter: 0, created_at: c.days(t.days), created_by: t.by }));
  C.FEED.forEach(([author, d, summary, body, tags, artifacts, importance], i) => {
    const id = 7001 + i;
    s.push(insert("feed", { id, org_id: ORG, author, summary, body, artifacts, created_at: c.days(d), importance: importance ?? null, origin: "agent" }));
    for (const tag of tags) s.push(insert("entry_tags", { org_id: ORG, tag, entry_type: "feed", entry_id: String(id) }));
  });
  for (const [id, title, status, by, d, context, decision, rationale, confidence] of C.ADRS) {
    s.push(insert("adrs", { id, org_id: ORG, title, context, decision, rationale, status, confidence, created_at: c.days(d), created_by: by }));
  }
  s.push(insert("entry_tags", { org_id: ORG, tag: "teachers", entry_type: "adr", entry_id: "8" }), insert("entry_tags", { org_id: ORG, tag: "auth", entry_type: "adr", entry_id: "8" }));
  C.TRIAGE.forEach(([author, d, reason, raw], i) => {
    s.push(insert("needs_triage", { id: 7001 + i, org_id: ORG, raw: typeof raw === "string" ? raw : JSON.stringify(raw), reason, source_author: author, resolved: 0, created_at: c.days(d) }));
  });
  for (const [name, description] of C.SECTIONS) s.push(`INSERT OR IGNORE INTO sections (name, description) VALUES (${q(name)}, ${q(description)})`);
  const docTags = { "sapling-teacher-dashboard": ["teachers", "ui"], "sapling-gradebook-export": ["teachers", "api"], "sapling-deploys": ["infra"], "sapling-spaced-repetition": ["data"], "sapling-incident-exam-week": ["incident", "infra"], "sapling-offline-mode": ["ui"] };
  for (const d of C.DOCS) {
    const live = d.versions.filter((v) => v[1] === "promoted").at(-1);
    s.push(insert("docs", { org_id: ORG, slug: d.slug, section: d.section, space: d.space, title: d.title, body: live[5], current_version: live[0], updated_at: c.days(live[3]), updated_by: live[2], owner: d.owner }));
    for (const [version, status, by, days, summary, body, kind] of d.versions) {
      s.push(insert("doc_versions", { org_id: ORG, slug: d.slug, version, body, summary, status, confidence: "high", created_at: c.days(days), created_by: by,
        content_hash: sha256(body), base_version: version > 1 ? version - 1 : null, change_kind: kind ?? (version === 1 ? "create" : "edit"), low_confidence: 0 }));
    }
    for (const tag of docTags[d.slug] ?? []) s.push(insert("entry_tags", { org_id: ORG, tag, entry_type: "doc", entry_id: d.slug }));
  }
  for (const p of C.PROMPTS) {
    const published = p.versions.filter((v) => v[1] === "published").at(-1) ?? p.versions.at(-1);
    s.push(insert("prompts", { org_id: ORG, slug: p.slug, title: p.title, description: p.description, tags: p.tags, author: p.author, current_version: published[0],
      created_at: c.days(p.versions[0][3]), updated_at: c.days(p.versions.at(-1)[3]), use_count: p.use_count, last_used_at: p.last_used_days == null ? null : c.days(p.last_used_days) }));
    for (const [version, status, author, d, summary, body] of p.versions) s.push(insert("prompt_versions", { org_id: ORG, slug: p.slug, version, status, author, summary, body, created_at: c.days(d) }));
  }
  // Artifacts: the Guide's four samples (fixtures/dev/artifacts.json) and the layer's own, written as the repository
  // writes them (artifact_pages + versions + the search row it keeps itself).
  const authors = [LUKE, JOSE, PRIYA, JACK];
  const arts = [
    ...guideArtifacts.artifacts.map((a, i) => ({ slug: slugify(a.title), title: a.title, kind: a.kind, area: a.area, author: authors[i % authors.length], status: a.ratify ? "ratified" : a.status ?? "draft",
      days: 20 - i * 4, summary: a.summary ?? "", content: a.content, versions: a.versions ?? [], links: (a.links ?? []).map((l) => [l.target_type, String(l.target_ref)]) })),
    ...C.EXTRA_ARTIFACTS.map((a) => ({ ...a, versions: [] })),
  ];
  arts.forEach((a, i) => {
    const id = 7001 + i;
    const created = c.days(a.days);
    const contents = [{ content: a.content, summary: a.summary || "First version" }, ...a.versions.map((v) => (typeof v === "string" ? { content: v, summary: "Revised" } : { content: v.content, summary: v.summary ?? "Revised" }))];
    const ratified = a.status === "ratified";
    s.push(insert("artifact_pages", {
      id, org_id: ORG, slug: a.slug, title: a.title, kind: a.kind, area: a.area, repo: REPO, author_id: a.author, status: a.status, visibility: "org", current_version: contents.length,
      ratified_version: ratified ? contents.length : null, ratified_by: ratified ? ME : null, ratified_at: ratified ? c.days(Math.max(a.days - 2, 0.5)) : null,
      created_at: created, updated_at: c.days(Math.max(a.days - contents.length + 1, 0.2)), published_at: a.status === "draft" ? null : created,
    }));
    contents.forEach((v, k) => {
      const bytes = Buffer.byteLength(v.content, "utf8");
      s.push(insert("artifact_versions", { org_id: ORG, page_id: id, version_no: k + 1, summary: v.summary, content: v.content, r2_key: null, size_bytes: bytes,
        content_type: { html: "text/html; charset=utf-8", markdown: "text/markdown; charset=utf-8", svg: "image/svg+xml", mermaid: "text/vnd.mermaid; charset=utf-8" }[a.kind] ?? "text/plain; charset=utf-8",
        sha256: sha256(v.content), filename: null, created_by: a.author, created_at: c.days(Math.max(a.days - k, 0.2)) }));
    });
    s.push(insert("artifacts_fts", { page_id: String(id), title: a.title, description: a.summary ?? "", body: a.kind === "html" || a.kind === "svg" ? "" : contents.at(-1).content, org_id: ORG }));
    for (const [type, ref] of a.links) s.push(insert("artifact_links", { org_id: ORG, page_id: id, target_type: type, target_ref: ref, created_by: a.author, created_at: created }, "INSERT OR IGNORE"));
  });
  // The roadmap narrative, version 2: Sapling's own (the canonical fixture's v1 is about Trov).
  s.push(insert("plan_versions", { org_id: ORG, version: 2, narrative: C.NARRATIVE, sprints_json: C.SPRINTS.map((x) => ({ id: x.id, title: x.title })), created_at: c.days(6), created_by: MEI }));
  s.push(`UPDATE plan SET narrative = ${q(C.NARRATIVE)}, current_version = 2, updated_at = ${q(c.days(6))}, updated_by = ${q(MEI)} WHERE org_id = ${q(ORG)}`);
  return s;
}
const slugify = (t) => t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// ── the repository ──────────────────────────────────────────────────────────────────────────────────────────────
const SUBJECTS = ["fix: handle empty deck", "feat: topic grid", "test: cover quiet students", "refactor: split mastery query", "chore: bump deps", "fix: streak time zone", "feat: export job progress", "docs: export format", "fix: citation page labels", "perf: batch topic reads", "feat: class code lookup", "ci: cache playwright browsers", "fix: roster CSV trailing column", "style: dashboard spacing", "feat: offline cache shell"];
const BRANCHES = ["feat/sm2-scheduler", "feat/retention-curve", "fix/flip-animation", "feat/stream-export", "fix/grade-rounding", "feat/ocr-queue", "feat/mastery-api", "feat/topic-grid", "fix/parent-cache", "feat/rate-limit", "ops/pooler", "feat/class-codes", "chore/deps", "feat/dashboard-filters"];
const ISSUES = [
  [218, SANA, "Streak lost after a long flight", ["bug"], 44, 30],
  [220, MEI, "Pilot schools: dashboard wishlist", ["teacher-pilot"], 41, null],
  [223, SANA, "Quiz images don't load on school Wi-Fi", ["bug"], 37, 25],
  [225, LUKE, "Upgrade Playwright to 1.5x", ["chore"], 34, 12],
  [226, SANA, "Parent can't unlink a child account", ["bug"], 31, null],
  [227, JACK, "Rotate the Gemini key quarterly", ["ops"], 29, null],
  [228, OMAR, "Device lab: add a Galaxy A14", ["qa"], 28, 20],
  [231, MEI, "Gradebook export fails for whole schools", ["bug", "teacher-pilot"], 35, null],
  [232, SANA, "Tutor answers in English when asked in Spanish", ["bug", "tutor"], 22, null],
  [240, MEI, "Teacher dashboard beta", ["teacher-pilot"], 20, null],
  [246, SANA, "Wrong page in citations for scanned PDFs", ["bug", "tutor"], 9, null],
  [261, OMAR, "Quiet flag ignores the student's time zone", ["bug", "teacher-pilot"], 0.9, null],
  [262, SANA, "Export button hidden behind the keyboard on Android", ["bug"], 0.4, null],
];

function repoStatements(c) {
  const s = [];
  const rnd = sequence(2026);
  const O = ORG;
  const at = (d) => c.days(d);
  const ghUrl = (kind, n) => `https://github.com/${REPO}/${kind}/${n}`;

  // The shas the screens name: main moved past production this morning (#257); production is on 3e9a1f2.
  const PROD_HEAD = sha("prod-head", "3e9a1f2");
  const MAIN_HEAD = sha("main-head", "8d4c0b7");
  const PREV_PROD = sha("v2.18.0", "b4c21de");
  const FAILED = sha("prod-head", "3e9a1f2"); // the backend build of the same commit failed on Railway

  // ── events: merged / closed PRs (Code tab, Activity, My Work's previous activity) and issues ──
  for (const [n, author, d, title, what, why, impact] of C.PRS_MERGED) {
    const key = `gh:pr:${n}:merged`;
    const t = at(d);
    const raw = { pr: { number: n, title, body: what, html_url: ghUrl("pull", n), merged: true, merged_at: t, closed_at: t, user: { login: login(author) }, milestone: null, base: { ref: "main" } } };
    s.push(insert("events", { org_id: O, repo: REPO, semantic_key: key, event_type: "pr_merged", ref_number: n, subject_login: login(author), raw, provenance: "webhook", occurred_at: t, recorded_at: t, recorded_by: "github-webhook" }));
    s.push(insert("pr_summaries", { org_id: O, repo: REPO, semantic_key: key, pr_number: n, model: "claude-haiku-5-5", created_at: t, title, what, why, impact }));
  }
  {
    const t = at(13);
    const raw = { pr: { number: 237, title: "Spike: GraphQL gateway for the dashboard", body: "Closed: REST is enough for the beta.", html_url: ghUrl("pull", 237), merged: false, merged_at: null, closed_at: t, user: { login: login(LUKE) }, milestone: null, base: { ref: "main" } } };
    s.push(insert("events", { org_id: O, repo: REPO, semantic_key: "gh:pr:237:closed", event_type: "pr_closed", ref_number: 237, subject_login: login(LUKE), raw, provenance: "webhook", occurred_at: t, recorded_at: t, recorded_by: "github-webhook" }));
  }
  for (const [n, author, title, labels, opened, closed] of ISSUES) {
    const issue = (state, updated) => ({ number: n, title, body: "", html_url: ghUrl("issues", n), state, state_reason: state === "closed" ? "completed" : null, updated_at: updated, user: { login: login(author) }, assignees: [], labels, milestone: null });
    const t1 = at(opened);
    s.push(insert("events", { org_id: O, repo: REPO, semantic_key: `gh:issue:${n}:opened:${t1}`, event_type: "issue", ref_number: n, subject_login: login(author), raw: { action: "opened", issue: issue("open", t1) }, provenance: "webhook", occurred_at: t1, recorded_at: t1, recorded_by: "github-webhook" }));
    if (closed != null) {
      const t2 = at(closed);
      s.push(insert("events", { org_id: O, repo: REPO, semantic_key: `gh:issue:${n}:closed:${t2}`, event_type: "issue", ref_number: n, subject_login: login(author), raw: { action: "closed", issue: issue("closed", t2) }, provenance: "webhook", occurred_at: t2, recorded_at: t2, recorded_by: "github-webhook" }));
    }
  }

  // ── repo_events ──
  const ev = [];
  let k = 0;
  const E = (o) => ev.push({ org_id: O, repo: REPO, semantic_key: `rich:${o.kind}:${++k}`, kind: o.kind, ref: o.ref ?? null, sha: o.sha ?? null, number: o.number ?? null, env: null, part: null,
    state: o.state ?? null, name: o.name ?? null, actor_login: o.by ?? null, title: o.title ?? null, url: o.url ?? null, count: o.count ?? null, raw: o.raw ?? {}, provenance: o.prov ?? "webhook", occurred_at: o.at, recorded_at: o.at });
  // Pushes: twelve weeks, weekdays mostly, each engineer on their branches (and merges to main).
  const pushers = [[JOSE, 0.75], [LUKE, 0.7], [ME, 0.55], [JACK, 0.45], [OMAR, 0.35], [PRIYA, 0.08]];
  for (let back = 84; back >= 0; back--) {
    const dow = new Date(c.t - back * DAY).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    for (const [who, p] of pushers) {
      if (who === OMAR && back > 45) continue;
      if (rnd() > p * (weekend ? 0.15 : 1)) continue;
      const n = 1 + Math.floor(rnd() * 5);
      const t = c.t - back * DAY - (2 + rnd() * 9) * HOUR;
      if (t > c.t - 10 * MIN) continue;
      const tIso = new Date(t).toISOString();
      const commits = Array.from({ length: n }, (_, i) => ({ id: sha(`push-${k}-${i}`), distinct: true, subject: SUBJECTS[Math.floor(rnd() * SUBJECTS.length)], at: tIso, author: login(who) }));
      E({ kind: "push", ref: rnd() < 0.2 ? "main" : back < 5 ? C.PRS_OPEN[Math.floor(rnd() * C.PRS_OPEN.length)][5] : BRANCHES[Math.floor(rnd() * BRANCHES.length)], sha: commits.at(-1).id, by: login(who), count: n, at: tIso,
        title: commits.at(-1).subject, url: `https://github.com/${REPO}/compare/${sha(`b-${k}`).slice(0, 7)}...${commits.at(-1).id.slice(0, 7)}`, raw: { before: sha(`before-${k}`), forced: false, commits } });
    }
  }
  // The two branch heads (env_heads below agrees): production this morning, main after #257.
  E({ kind: "push", ref: "production", sha: PROD_HEAD, by: login(JACK), count: 9, at: at(0.5), title: "Fast-forward production", raw: { before: PREV_PROD, forced: false, commits: [{ id: PROD_HEAD, distinct: true, subject: "Merge #256 e2e: quiz timer spec uses a fake clock", at: at(0.5), author: login(OMAR) }] } });
  E({ kind: "push", ref: "main", sha: MAIN_HEAD, by: login(LUKE), count: 2, at: at(0.3), title: "Merge #257 Dashboard: needs-attention sort", raw: { before: PROD_HEAD, forced: false, commits: [{ id: sha("257-a"), distinct: true, subject: "feat: needs-attention sort", at: at(0.32), author: login(LUKE) }, { id: MAIN_HEAD, distinct: true, subject: "Merge #257", at: at(0.3), author: login(LUKE) }] } });
  // Checks on both heads (all green) and on the open PRs.
  for (const [head, ref, d] of [[MAIN_HEAD, "main", 0.28], [PROD_HEAD, "production", 0.48]]) {
    ["build", "test", "lint", "e2e"].forEach((name, i) => E({ kind: "check", ref, sha: head, number: 880000 + k, name, state: "success", at: at(d - i * 0.002), url: `https://github.com/${REPO}/runs/${880000 + k}`, raw: { app: "github-actions", status: "completed", output_title: null } }));
  }
  // PRs: every merged one opened → merged (the list shows the newest eight of the last 90 days), and the open ones.
  for (const [n, author, d, title] of C.PRS_MERGED) {
    const head = sha(`pr-${n}`);
    const branch = `${n % 4 === 0 ? "fix" : "feat"}/${slugify(title).slice(0, 28).replace(/-+$/, "")}`;
    E({ kind: "pr", number: n, state: "review", ref: branch, sha: head, by: login(author), title, url: ghUrl("pull", n), at: at(d + 1 + (n % 3)), raw: { action: "opened", base: "main", draft: false, labels: [] } });
    E({ kind: "pr", number: n, state: "merged", ref: branch, sha: head, by: login(author), title, url: ghUrl("pull", n), at: at(d), raw: { action: "closed", base: "main", draft: false, labels: [] } });
    const reviewer = [JOSE, LUKE, ME, JACK].filter((x) => x !== author)[n % 3];
    E({ kind: "review", number: n, state: "approved", by: login(reviewer), url: `${ghUrl("pull", n)}#pullrequestreview-${n}01`, at: at(d + 0.1), raw: { action: "submitted" } });
  }
  for (const [n, author, d, state, title, branch] of C.PRS_OPEN) {
    const head = sha(`pr-${n}`);
    E({ kind: "pr", number: n, state: state === "draft" ? "draft" : "review", ref: branch, sha: head, by: login(author), title, url: ghUrl("pull", n), at: at(d), raw: { action: "opened", base: "main", draft: state === "draft", labels: n === 258 ? ["teacher-pilot"] : [] } });
    const checks = n === 254 ? [["build", "success"], ["test", "failure"]] : n === 260 ? [["build", "pending"], ["test", "pending"]] : [["build", "success"], ["test", "success"]];
    for (const [name, st] of checks) E({ kind: "check", ref: branch, sha: head, number: 890000 + k, name, state: st, at: at(Math.max(d - 0.05, 0.01)), url: `https://github.com/${REPO}/runs/${890000 + k}`, raw: { app: "github-actions", status: st === "pending" ? "in_progress" : "completed", output_title: st === "failure" ? "2 failed, 311 passed" : null } });
  }
  E({ kind: "review", number: 254, state: "changes_requested", by: login(OMAR), url: `${ghUrl("pull", 254)}#pullrequestreview-25401`, at: at(1), raw: { action: "submitted" } });
  E({ kind: "review", number: 250, state: "commented", by: login(JACK), url: `${ghUrl("pull", 250)}#pullrequestreview-25001`, at: at(2), raw: { action: "submitted" } });
  E({ kind: "review", number: 255, state: "approved", by: login(OMAR), url: `${ghUrl("pull", 255)}#pullrequestreview-25501`, at: at(0.3), raw: { action: "submitted" } });
  // CI runs: three weeks, about eight a weekday, ~9% failing (a 7-day failure rate and its trend).
  const WORKFLOWS = [["CI", ".github/workflows/ci.yml", ["test (unit)", "typecheck", "lint"]], ["e2e", ".github/workflows/e2e.yml", ["e2e (chromium)", "e2e (webkit)"]], ["Deploy", ".github/workflows/deploy.yml", ["deploy (staging)"]]];
  let runNo = 4100;
  for (let back = 22; back >= 0; back--) {
    const dow = new Date(c.t - back * DAY).getUTCDay();
    const runs = dow === 0 || dow === 6 ? 2 : 6 + Math.floor(rnd() * 5);
    for (let i = 0; i < runs; i++) {
      const t = c.t - back * DAY - (1 + rnd() * 10) * HOUR;
      if (t > c.t - 5 * MIN) continue;
      const [name, path, jobs] = WORKFLOWS[Math.floor(rnd() * WORKFLOWS.length)];
      const roll = rnd();
      const state = back === 4 && i < 3 && name === "e2e" ? "failure" : roll < 0.085 ? "failure" : roll < 0.095 ? "timed_out" : roll < 0.12 ? "cancelled" : "success";
      const by = [JOSE, LUKE, ME, JACK, OMAR][Math.floor(rnd() * 5)];
      const id = 9_100_000 + runNo;
      E({ kind: "run", number: id, name, ref: rnd() < 0.4 ? "main" : C.PRS_OPEN[Math.floor(rnd() * C.PRS_OPEN.length)][5], sha: sha(`run-${runNo}`), state, title: state === "success" || state === "cancelled" ? null : jobs[Math.floor(rnd() * jobs.length)], by: login(by),
        url: `https://github.com/${REPO}/actions/runs/${id}`, count: 1, at: new Date(t).toISOString(), raw: { event: "push", started_at: new Date(t - 6 * MIN).toISOString(), path, run_number: runNo } });
      runNo++;
    }
  }
  s.push(...insertMany("repo_events", ev, 120));

  // ── environments, parts, credentials (DUMMY metadata), deploys, poll state ──
  const env = (key, position, label, branch, fe, api, note) => insert("org_environments", { org_id: O, key, position, label, note, branch, frontend_url: fe, api_url: api, health_path: "/health", created_at: at(120), updated_at: at(30), updated_by: JACK });
  s.push(env("staging", 0, "Staging", "main", "https://staging.sapling.example.com", "https://api.staging.sapling.example.com", "Every merge to main"));
  s.push(env("production", 1, "Production", "production", "https://app.sapling.example.com", "https://api.sapling.example.com", "Fast-forwarded from main after the e2e suite passes"));
  const part = (env_key, part_key, position, label, role, provider, settings) => insert("org_environment_parts", { org_id: O, env_key, part_key, position, label, role, provider, settings, created_at: at(90), updated_at: at(30), updated_by: JACK });
  s.push(part("staging", "frontend", 0, "Frontend", "web", "cloudflare", { worker: "sapling-staging" }));
  s.push(part("staging", "backend", 1, "Backend", "service", "railway", { project_id: "example-project", environment_id: "example-env-staging", service_id: "example-api" }));
  s.push(part("production", "frontend", 0, "Frontend", "web", "cloudflare", { worker: "sapling" }));
  s.push(part("production", "backend", 1, "Backend", "service", "railway", { project_id: "example-project", environment_id: "example-env-production", service_id: "example-api" }));
  s.push(`INSERT OR IGNORE INTO org_keys (org_id, key_version, wrapped_key, wrap_iv, kek_fingerprint, created_at) VALUES (${q(O)}, 1, 'dev-seed-not-a-key', 'dev-seed-iv', 'dev-seed', ${q(at(120))})`);
  const secret = (kind, last4, usedMin) => insert("org_secrets", { org_id: O, kind, scope: "", ciphertext: "dev-seed-not-a-secret", iv: "dev-seed-iv", key_version: 1, hint_last4: last4, created_by: JACK, created_at: at(60), rotated_at: null, last_used_at: c.days(usedMin / 1440), last_error: null });
  s.push(secret("cloudflare_analytics", "7c2e", 4), secret("railway", "41d9", 4));

  const deploys = [];
  let did = 0;
  const D = (o) => deploys.push({ org_id: O, env: o.env, part: o.part, provider: o.part === "frontend" ? "cloudflare" : "railway", deploy_id: `rich-${++did}`, state: o.state, target: o.target ?? "production",
    sha: o.sha, branch: o.branch, message: o.message ?? null, actor: login(o.by), url: o.url ?? null, inspect_url: o.log ?? null, created_at: at(o.d), ready_at: o.state === "ready" ? at(o.d - 0.0015) : null,
    recorded_at: at(o.d), updated_at: at(o.d), source: "provider", reason: o.reason ?? null, sha_source: "provider", rolled_back_from: o.rolledBackFrom ?? null });
  // Staging: both apps on every merge to main in the last five weeks (a failed and a cancelled one among them).
  for (const [n, author, d, title] of C.PRS_MERGED.filter((p) => p[2] <= 35).sort((a, b) => b[2] - a[2])) {
    const st = n === 222 ? "error" : n === 242 ? "canceled" : "ready";
    D({ env: "staging", part: "frontend", state: st, sha: n === 257 ? MAIN_HEAD : sha(`merge-${n}`), branch: "main", by: author, d: d - 0.004, message: `Merge #${n} ${title}`, url: "https://staging.sapling.example.com",
      reason: st === "error" ? "Build failed: wrangler deploy exited 1 (bundle over 3 MiB)" : null, log: st === "error" ? "https://dash.cloudflare.example.com/builds/1" : null });
    D({ env: "staging", part: "backend", state: n === 236 ? "error" : "ready", sha: n === 257 ? MAIN_HEAD : sha(`merge-${n}`), branch: "main", by: author, d: d - 0.006, message: `Merge #${n} ${title}`,
      reason: n === 236 ? "Healthcheck failed: /health returned 503 for 5 minutes" : null });
  }
  // Production: each release, then this morning's fast-forward — the frontend shipped, the backend build failed twice.
  for (const [tag, d, by] of C.RELEASES) {
    D({ env: "production", part: "frontend", state: "ready", sha: tag === "v2.18.0" ? PREV_PROD : sha(tag), branch: "production", by, d: d - 0.01, message: `Release ${tag}`, url: "https://app.sapling.example.com" });
    D({ env: "production", part: "backend", state: "ready", sha: tag === "v2.18.0" ? PREV_PROD : sha(tag), branch: "production", by, d: d - 0.012, message: `Release ${tag}` });
  }
  D({ env: "production", part: "frontend", state: "ready", sha: PROD_HEAD, branch: "production", by: JACK, d: 0.49, message: "Fast-forward production to 3e9a1f2", url: "https://app.sapling.example.com" });
  D({ env: "production", part: "backend", state: "error", sha: FAILED, branch: "production", by: JACK, d: 0.485, message: "Fast-forward production to 3e9a1f2", reason: "Build failed: test-e2e tsc found 2 errors", log: "https://railway.example.com/project/example-project/deployments/1" });
  D({ env: "production", part: "backend", state: "error", sha: FAILED, branch: "production", by: MEI, d: 0.13, message: "Redeploy", reason: "Build failed: test-e2e tsc found 2 errors", log: "https://railway.example.com/project/example-project/deployments/2" });
  // A preview of the open dashboard PR.
  D({ env: "production", part: "frontend", state: "ready", target: "preview", sha: sha("pr-252"), branch: "feat/quiet-students", by: LUKE, d: 2.2, message: "Preview #252", url: "https://feat-quiet-students.sapling.example.com" });
  s.push(...insertMany("hosting_deploys", deploys, 80));

  const hourStart = Math.floor(c.t / HOUR) * HOUR;
  for (const [e, p, prov, coveredDays] of [["staging", "frontend", "cloudflare", 14], ["staging", "backend", "railway", 7], ["production", "frontend", "cloudflare", 30], ["production", "backend", "railway", 7]]) {
    s.push(insert("hosting_poll_state", { org_id: O, env: e, part: p, provider: prov, polled_at: c.days(4 / 1440), status: "ok", detail: null, last_ok_at: c.days(4 / 1440),
      covered_from: new Date(hourStart - coveredDays * DAY).toISOString(), covered_to: new Date(hourStart).toISOString(), unavailable: [] }));
  }

  // ── metrics: health (fresh), hourly hosting, product, coverage / bundle / TODOs ──
  const m = [];
  const M = (metric, envKey, partKey, value, atIso) => m.push({ org_id: O, metric, env: envKey, part: partKey, value, at: atIso });
  const tenMin = Math.floor((c.t - 2 * MIN) / (10 * MIN)) * 10 * MIN;
  for (let i = 0; i < 12; i++) {
    const tIso = new Date(tenMin - i * 10 * MIN).toISOString();
    for (const [e, p, base] of [["staging", "frontend", 140], ["staging", "backend", 92], ["production", "frontend", 118], ["production", "backend", 86]]) {
      M("health_up", e, p, 1, tIso);
      M("health_ms", e, p, Math.round(base * (0.85 + rnd() * 0.4)), tIso);
    }
  }
  // School-hours traffic (US, so 13:00–23:00 UTC), quieter at weekends; the exam-week incident 18 days ago.
  const incidentHour = Math.floor((c.t - 18 * DAY) / DAY) * DAY + 13 * HOUR;
  for (const [e, days, scale] of [["production", 30, 1], ["staging", 14, 0.02]]) {
    for (let h = days * 24; h >= 1; h--) {
      const t = hourStart - h * HOUR;
      const d = new Date(t);
      const hr = d.getUTCHours(), weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      const school = hr >= 13 && hr <= 23 ? 1 : hr >= 0 && hr <= 3 ? 0.55 : 0.12;
      const growth = 1 + (days * 24 - h) / (days * 24) * 0.25;
      const req = Math.round(9200 * school * (weekend ? 0.45 : 1) * growth * scale * (0.85 + rnd() * 0.3));
      const incident = e === "production" && t === incidentHour;
      const iso = d.toISOString();
      M("hx_requests", e, "frontend", req, iso);
      M("hx_errors", e, "frontend", incident ? Math.round(req * 0.09) : Math.round(req * (0.0008 + rnd() * 0.0015)), iso);
      M("hx_latency_p95_ms", e, "frontend", incident ? 2900 : Math.round(150 + school * 70 + rnd() * 50), iso);
      M("hx_bandwidth_bytes", e, "frontend", req * Math.round(38_000 + rnd() * 9_000), iso);
      if (h <= 7 * 24) {
        M("hx_cpu", e, "backend", Math.round((0.08 + school * (e === "production" ? 0.62 : 0.05) * (weekend ? 0.5 : 1) + rnd() * 0.06) * 100) / 100, iso);
        M("hx_mem_mb", e, "backend", Math.round((e === "production" ? 410 : 300) + school * 120 + rnd() * 40), iso);
      }
    }
  }
  // Active users and the app's product metrics (the metrics endpoint's counts), the current hour and a daily trend.
  const hourIso = new Date(hourStart).toISOString();
  M("active_users_24h", "production", "", 1386, hourIso); M("active_users_7d", "production", "", 4120, hourIso); M("active_users_30d", "production", "", 7954, hourIso);
  M("active_users_24h", "staging", "", 14, hourIso); M("active_users_7d", "staging", "", 31, hourIso); M("active_users_30d", "staging", "", 47, hourIso);
  const PRODUCT = { signups: [64, 410, 1710], logins: [2210, 11900, 41800], tutor_sessions: [3120, 19800, 77400], quizzes_completed: [1840, 11250, 46100], llm_calls: [26400, 161000, 648000], llm_cost_cents: [4170, 26900, 108300], errors_5xx: [21, 340, 1180] };
  for (const [key, [d1, d7, d30]] of Object.entries(PRODUCT)) {
    M(`sap_c_${key}_24h`, "production", "", d1, hourIso); M(`sap_c_${key}_7d`, "production", "", d7, hourIso); M(`sap_c_${key}_30d`, "production", "", d30, hourIso);
    for (let d = 30; d >= 1; d--) {
      const day = new Date(Math.floor((c.t - d * DAY) / DAY) * DAY);
      const wk = day.getUTCDay() === 0 || day.getUTCDay() === 6 ? 0.5 : 1;
      M(`sap_c_${key}_24h`, "production", "", key === "errors_5xx" && d === 18 ? d1 * 9 : Math.round(d1 * wk * (0.8 + rnd() * 0.35) * (1 - d / 120)), day.toISOString());
    }
  }
  M("sap_t_users", "production", "", 21480, hourIso); M("sap_t_tutor_sessions", "production", "", 612300, hourIso); M("sap_t_quizzes_completed", "production", "", 284900, hourIso);
  for (let d = 30; d >= 0; d -= 3) {
    const tIso = new Date(c.t - d * DAY - 3 * HOUR).toISOString();
    M("coverage", "", "", Math.round((78.1 + (30 - d) * 0.12 + rnd() * 0.3) * 10) / 10, tIso);
    M("bundle_kb", "", "", d > 23 ? 431 - Math.round(rnd() * 3) : 402 + Math.round(rnd() * 4), tIso);
  }
  for (let d = 88; d >= 0; d -= 8) M("todo_count", "", "", 64 - Math.round((88 - d) / 12), new Date(c.t - d * DAY - 2 * HOUR).toISOString());
  s.push(...insertMany("repo_metrics", m, 200));

  // ── snapshots, releases, the settings and the scan ──
  const snap = (kind, json, d = 20 / 1440) => insert("repo_snapshots", { org_id: O, kind, json, computed_at: c.days(d) });
  s.push(snap("prs_reconciled", { at: c.days(20 / 1440) }));
  s.push(snap("env_heads", { main: MAIN_HEAD, production: PROD_HEAD }));
  s.push(snap("branches", { active: 9, stale: 3, head: "main", rows: [
    { name: "feat/export-jobs", at: at(2.9), ahead: 6, behind: 4, stale: false }, { name: "fix/class-code-collisions", at: at(1.2), ahead: 3, behind: 1, stale: false },
    { name: "feat/quiet-students", at: at(2.2), ahead: 5, behind: 3, stale: false }, { name: "feat/roster-import", at: at(1.9), ahead: 4, behind: 2, stale: false },
    { name: "feat/early-stream", at: at(3.2), ahead: 7, behind: 6, stale: false }, { name: "spike/offline-sw", at: at(1), ahead: 2, behind: 0, stale: false },
    { name: "ops/pool-alert", at: at(0.6), ahead: 1, behind: 0, stale: false }, { name: "spike/graphql-gateway", at: at(19), ahead: 11, behind: 64, stale: true },
  ] }));
  s.push(snap("drift", { head: "main", base: "production", ahead: 2, behind: 0, groups: [
    { tag: "#257", kind: "pr", title: "Dashboard: needs-attention sort", meta: `${login(LUKE)} · 2 commits`, commits: [{ sha: sha("257-a"), msg: "feat: needs-attention sort", at: at(0.32) }, { sha: MAIN_HEAD, msg: "Merge #257", at: at(0.3) }] },
  ] }));
  s.push(snap("releases_reconciled", { repo: REPO }));
  const rel = C.RELEASES.map(([tag, d, by, notes]) => ({ org_id: O, repo: REPO, tag, name: `Sapling ${tag}`, published_at: at(d), author: login(by), notes, is_prerelease: 0, is_draft: 0,
    sha: tag === "v2.18.0" ? PREV_PROD : sha(tag), source: "release", content_hash: sha256(`${tag}:${notes}`), captured_at: at(d) }));
  s.push(...insertMany("releases", rel));
  s.push(insert("repo_settings", { org_id: O, repo: REPO, overview_group: "env", updated_at: at(10), updated_by: JACK }));
  s.push(insert("repo_scans", { org_id: O, repo: REPO, tree_sha: sha("tree"), scanned_at: at(1), looked: ["vercel.json", "netlify.toml", "wrangler.toml", "fly.toml", "render.yaml", "railway.json", "Dockerfile"], error: null }));
  s.push(insert("repo_app_suggestions", { org_id: O, repo: REPO, id: "sg_dev_seed_docs_site01", key: "docs", folder: "docs", kind: "Site", provider: "vercel", evidence: [{ kind: "file", text: "from docs/vercel.json" }], parts: [], used_by: [], state: "ignored", decided_at: at(9), decided_by: JACK, created_at: at(12) }));
  // Which files the open PRs and the last pushes touched (the App menu narrows by them once there are several apps).
  const files = { 250: ["backend/agents/tutor.py", "backend/rag/rerank.py"], 252: ["web/app/teacher/[classId]/QuietMark.tsx", "web/app/teacher/[classId]/page.tsx"], 254: ["backend/importers/roster.py", "backend/importers/test_roster.py"],
    255: ["backend/routers/schools.py"], 258: ["backend/jobs/export.py", "backend/storage/r2.py"], 259: ["web/public/sw.js", "web/app/layout.tsx"], 260: ["ops/alerts/pool.yml"] };
  for (const [n, paths] of Object.entries(files)) {
    for (const path of paths) s.push(insert("pr_files", { org_id: O, repo: REPO, number: Number(n), path }));
    s.push(insert("pr_file_reads", { org_id: O, repo: REPO, number: Number(n), head_sha: sha(`pr-${n}`), complete: 1, content_hash: sha256(paths.join("\n")), fetched_at: at(0.2) }));
  }
  s.push(...insertMany("commit_paths", [
    { org_id: O, repo: REPO, sha: MAIN_HEAD, path: "web/app/teacher/[classId]/page.tsx", scope: "push", at: at(0.3) },
    { org_id: O, repo: REPO, sha: sha("257-a"), path: "web/app/teacher/[classId]/sort.ts", scope: "commit", at: at(0.32) },
    { org_id: O, repo: REPO, sha: PROD_HEAD, path: "e2e/quiz.spec.ts", scope: "push", at: at(0.5) },
  ]));
  return s;
}

// ── the org's plumbing: agent connections, upload links, the GitHub App, settings, mail, audit trails ────────────
// What a real org accumulates behind the screens (Settings › MCP, Org settings › Integrations / Notifications, the
// audit trails), so every org-keyed table has rows in the `team` scenario (test/seed-scenarios.test.ts). Every
// credential here is a placeholder: a token HASH no token produces, a ciphertext that decrypts to nothing.
const DEV = "dev-seed";
export function plumbingDeleteStatements() {
  const O = q(ORG);
  const grants = `(SELECT id FROM oauth_grants WHERE org_id = ${O} AND client_id = '${DEV}-client')`;
  return [
    `DELETE FROM oauth_tokens WHERE grant_id IN ${grants}`,
    `DELETE FROM oauth_codes WHERE grant_id IN ${grants}`,
    `DELETE FROM oauth_grant_orgs WHERE grant_id IN ${grants}`,
    `DELETE FROM oauth_grants WHERE id IN ${grants}`,
    `DELETE FROM mcp_tokens WHERE org_id = ${O} AND token_hash LIKE '${DEV}-%'`,
    `DELETE FROM artifact_upload_tokens WHERE org_id = ${O} AND token_hash LIKE '${DEV}-%'`,
    `DELETE FROM doc_image_upload_tokens WHERE org_id = ${O} AND token_hash LIKE '${DEV}-%'`,
    `DELETE FROM doc_images WHERE org_id = ${O} AND uploaded_by = '${PRIYA}'`,
    `DELETE FROM processed_items WHERE org_id = ${O} AND session_id LIKE '${DEV}-%'`,
    `DELETE FROM notification_outbox_bodies WHERE org_id = ${O} AND idempotency_key LIKE '${DEV}:%'`,
    `DELETE FROM notification_outbox WHERE org_id = ${O} AND idempotency_key LIKE '${DEV}:%'`,
    ...["sync_runs", "ai_dirty", "notification_prefs", "notification_policy", "org_github_installation_repos", "org_github_installations", "org_audit", "org_admin_audit"].map((t) => `DELETE FROM ${t} WHERE org_id = ${O}`),
    `DELETE FROM org_integration_config WHERE org_id = ${O} AND kind = 'cloudflare_analytics'`,
    // The Docs Library (0081_docs_library): the spaces' owners, a link between two of the layer's docs, one import run.
    `DELETE FROM doc_space_owners WHERE org_id = ${O}`,
    `DELETE FROM doc_links WHERE org_id = ${O} AND from_slug IN ${inList(DOC_SLUGS)}`,
    `DELETE FROM doc_imports WHERE org_id = ${O} AND file_name = '${DEV}-handbook.zip'`,
  ];
}
function plumbingStatements(c) {
  const s = [...plumbingDeleteStatements()];
  const O = ORG;
  // Agent connections: pasted tokens for four people, and Claude Code connected over OAuth for two.
  [[ME, 40, 0.1, "x7Qa"], [ME, 75, 30, "m2Kd"], [JOSE, 33, 0.4, "c9Pe"], [LUKE, 28, 1.2, "t4Wn"], [JACK, 21, 0.8, "r8Zs"]].forEach(([who, made, used, hint], i) => {
    s.push(insert("mcp_tokens", { org_id: O, person: who, token_hash: `${DEV}-${sha256(`mcp-${i}`)}`, token_hint: hint, created_at: c.days(made), last_used_at: c.days(used), revoked: i === 1 ? 1 : 0 }));
  });
  s.push(insert("oauth_clients", { client_id: `${DEV}-client`, client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"], created_at: c.days(50) }, "INSERT OR IGNORE"));
  for (const [i, who] of [[1, ME], [2, OMAR]]) {
    const grant = `(SELECT id FROM oauth_grants WHERE org_id = '${O}' AND client_id = '${DEV}-client' AND person = ${q(who)})`;
    s.push(insert("oauth_grants", { person: who, client_id: `${DEV}-client`, client_name: "Claude Code", created_at: c.days(20 + i), last_used_at: c.days(0.2 * i), org_id: O, mode: i === 1 ? "repo" : "manual" }));
    s.push(`INSERT INTO oauth_grant_orgs (grant_id, org_id, person, added_at) SELECT ${grant}, ${q(O)}, ${q(who)}, ${q(c.days(20 + i))}`);
    s.push(`INSERT INTO oauth_codes (code_hash, client_id, person, grant_id, redirect_uri, code_challenge, resource, created_at, expires_at, used_at, org_id) SELECT ${q(`${DEV}-${sha256(`code-${i}`)}`)}, '${DEV}-client', ${q(who)}, ${grant}, 'http://localhost:33418/callback', ${q(sha256(`pkce-${i}`))}, NULL, ${q(c.days(20 + i))}, ${q(c.days(20 + i - 0.007))}, ${q(c.days(20 + i - 0.001))}, ${q(O)}`);
  }
  // Upload links (spent) and one doc image a doc can embed.
  s.push(insert("artifact_upload_tokens", { token_hash: `${DEV}-${sha256("art-upload")}`, principal: JOSE, page_id: 7005, kind: "image", size_bytes: 48213, sha256: sha256("export-job.png"), content_type: "image/png", filename: "export-job.png", summary: "Screenshot", expires_at: c.days(11.9), used_at: c.days(11.95), created_at: c.days(12), org_id: O }));
  const img = sha256("dashboard-grid.png");
  s.push(insert("doc_images", { org_id: O, sha256: img, content_type: "image/png", size_bytes: 61440, uploaded_by: PRIYA, created_at: c.days(12) }));
  s.push(insert("doc_image_upload_tokens", { token_hash: `${DEV}-${sha256("img-upload")}`, principal: PRIYA, sha256: img, size_bytes: 61440, content_type: "image/png", expires_at: c.days(11.9), used_at: c.days(11.95), created_at: c.days(12), org_id: O }));
  // The ingest ledger of two recorded sessions.
  [["feed", "7039", JOSE, 2.9], ["doc", "sapling-gradebook-export@3", JOSE, 2.8], ["feed", "7041", LUKE, 0.25], ["doc", "sapling-teacher-dashboard@4", LUKE, 0.6]].forEach(([type, ref, who, d], i) =>
    s.push(insert("processed_items", { org_id: O, session_id: `${DEV}-${who.toLowerCase()}-${Math.floor(d)}`, item_index: i, item_type: type, outcome: "staged", ref, created_at: c.days(d) })));
  // The Library: who owns each starter space, one [[link]] between two docs, and a finished Markdown import.
  for (const [space, who, d] of [["engineering", ME, 40], ["engineering", JOSE, 30], ["product", MEI, 35], ["design", LUKE, 25]]) {
    s.push(insert("doc_space_owners", { org_id: O, space_slug: space, handle: who, added_at: c.days(d), added_by: ME }));
  }
  s.push(insert("doc_links", { org_id: O, from_slug: DOC_SLUGS[0], to_slug: DOC_SLUGS[1] }));
  s.push(insert("doc_imports", { org_id: O, space_slug: "engineering", parent_slug: null, file_name: `${DEV}-handbook.zip`, started_by: JOSE, started_at: c.days(6), updated_at: c.days(5.99), ended_at: c.days(5.99), status: "done", counts: { pages: 4, images: 1, skipped: 0 }, failures: [], total: 5 }));
  // Sync GitHub runs, and what the AI pass still has to look at.
  s.push(insert("sync_runs", { org_id: O, repo: REPO, started_by: ME, started_at: c.days(9), updated_at: c.days(8.99), ended_at: c.days(8.99), status: "ok", batch: 4, batches: 4, phase: "done", done: 412, total: 412, counts: { prs: 58, issues: 31, runs: 240, deploys: 83 }, failures: [], previous_at: c.days(30) }));
  s.push(insert("sync_runs", { org_id: O, repo: REPO, started_by: JACK, started_at: c.days(2), updated_at: c.days(1.99), ended_at: c.days(1.99), status: "partial", batch: 3, batches: 3, phase: "done", done: 120, total: 131, counts: { prs: 14, issues: 6, runs: 100 }, failures: [{ step: "releases", detail: "GitHub answered 502 twice" }], previous_at: c.days(9) }));
  s.push(insert("ai_dirty", { org_id: O, scope: "brief", scope_key: OMAR, dirty_since: c.days(0.2), last_run_at: c.days(1), attempts: 0, last_error: null, marked_at: c.days(0.2), urgent: 0 }));
  s.push(insert("ai_dirty", { org_id: O, scope: "repo_state", scope_key: REPO, dirty_since: c.days(0.13), last_run_at: c.days(0.5), attempts: 1, last_error: null, marked_at: c.days(0.13), urgent: 1 }));
  // E-mail: the org's policy (every kind the registry has), a few people's choices, and last week's sent digests.
  for (const [kind, cadence] of [["my_work", "daily"], ["week_recap", "weekly"], ["review_queue", "daily"], ["roadmap_plan", "weekly"], ["ticketq", "daily"]]) {
    s.push(insert("notification_policy", { org_id: O, kind, default_cadence: cadence, enabled: 1, updated_at: c.days(40), updated_by: ME }));
  }
  [[MEI, "roadmap_plan", "daily"], [SANA, "ticketq", "daily"], [JOSE, "my_work", "off"], [LUKE, "week_recap", "off"]].forEach(([who, kind, cadence]) => s.push(insert("notification_prefs", { org_id: O, user_id: who, kind, cadence, updated_at: c.days(12) })));
  for (const who of [ME, MEI, LUKE]) {
    const key = `${DEV}:${O}:${who}:weekly:${c.date(-6)}`;
    s.push(insert("notification_outbox", { idempotency_key: key, user_id: who, cadence: "weekly", window_id: c.date(-6), kinds: ["week_recap", "roadmap_plan"], status: "sent", resend_id: null, error: null, created_at: c.days(6), sent_at: c.days(6), org_id: O }));
    s.push(insert("notification_outbox_bodies", { idempotency_key: key, to_address: `${who.toLowerCase()}@example.com`, subject: "SaplingLearn this week", html: "<p>Your week in SaplingLearn.</p>", text: "Your week in SaplingLearn.", created_at: c.days(6), org_id: O }));
  }
  // The GitHub App installation that connects SaplingLearn/sapling, and Cloudflare's account id.
  s.push(insert("org_github_installations", { org_id: O, installation_id: 40_000_001, account_login: "SaplingLearn", account_id: "90000001", account_type: "Organization", repository_selection: "selected", connected_by: ME, connected_at: c.days(70), last_used_at: c.days(0.02), repo_access: "selected" }));
  s.push(`INSERT INTO org_github_installation_repos (org_id, binding_id, repo_id, repo_full_name, private) SELECT ${q(O)}, id, 70000001, ${q(REPO)}, 1 FROM org_github_installations WHERE org_id = ${q(O)}`);
  s.push(insert("org_integration_config", { org_id: O, kind: "cloudflare_analytics", scope: "", config: { account_id: "0123456789abcdef0123456789abcdef" }, updated_at: c.days(60), updated_by: JACK }));
  s.push(insert("org_hosting_connections", { org_id: O, provider: "railway", scope: "", method: "token", external_id: null, account_id: null, account_label: "SaplingLearn workspace", status: "active", connected_by: JACK, connected_at: c.days(60) }));
  // The audit trails: who stored which credential, and the admin changes behind the members list.
  [["secret.set", "cloudflare_analytics", 60], ["secret.set", "railway", 60], ["secret.rotate", "railway", 14]].forEach(([action, target, d]) =>
    s.push(insert("org_audit", { org_id: O, actor: JACK, action, target, detail: { scope: "" }, at: c.days(d) })));
  [[ME, "member.add", PRIYA, { role: "member" }, 60], [ME, "member.add", OMAR, { role: "member" }, 45], [ME, "member.role", JOSE, { from: "member", to: "admin" }, 30],
    [JACK, "part.set", "production/backend", { provider: "railway" }, 30], [ME, "invite.create", "new-hire@example.com", { role: "member" }, 2]].forEach(([actor, action, target, detail, d]) =>
    s.push(insert("org_admin_audit", { org_id: O, actor, action, target, detail, at: c.days(d) })));
  return s;
}

/** Every statement of the layer, deletes first. Pure: the same `now` gives the same statements. */
export function teamRichStatements(now = new Date()) {
  const c = makeClock(now);
  // The plumbing's deletes go first: a spent upload link points at one of the artifact pages deleteStatements drops.
  return [...plumbingDeleteStatements(), ...deleteStatements(), ...peopleStatements(c), ...workStatements(c), ...knowledgeStatements(c), ...repoStatements(c), ...plumbingStatements(c).slice(plumbingDeleteStatements().length)];
}

// ── the checks (each surface's rows, at least) ──────────────────────────────────────────────────────────────────
const O = `'${ORG}'`;
export const CHECKS = [
  ["Members › people", `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ${O}`, 8],
  ["Members › admins", `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ${O} AND role = 'admin'`, 1],
  ["Members › pending invitations", `SELECT COUNT(*) AS n FROM org_invites WHERE org_id = ${O} AND status = 'pending'`, 1],
  ["Tickets › the layer's tickets (#8–#80)", `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ${O} AND id ${BLOCK}`, 73],
  ["Tickets › every status", `SELECT COUNT(DISTINCT status) AS n FROM tickets WHERE org_id = ${O} AND id ${BLOCK}`, 5],
  ["Tickets › comments", `SELECT COUNT(*) AS n FROM ticket_comments WHERE org_id = ${O} AND ticket_id ${BLOCK}`, 40],
  ["Tickets › links", `SELECT COUNT(*) AS n FROM ticket_links WHERE org_id = ${O} AND ticket_id ${BLOCK}`, 25],
  ["Tickets › sub-tickets", `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ${O} AND parent_id ${BLOCK}`, 8],
  ["Roadmap › sprints: done, late, current, planned", `SELECT COUNT(*) AS n FROM sprints WHERE org_id = ${O} AND id ${BLOCK}`, 4],
  ["Roadmap › Sapling's narrative (plan v2)", `SELECT COUNT(*) AS n FROM plan WHERE org_id = ${O} AND current_version = 2`, 1],
  ["Handoffs › #1–#10 (pending, claimed, expired)", `SELECT COUNT(DISTINCT status) AS n FROM handoffs WHERE org_id = ${O} AND id ${BLOCK}`, 3],
  ["Feed › entries in the last six weeks", `SELECT COUNT(*) AS n FROM feed WHERE org_id = ${O} AND id ${BLOCK}`, 40],
  ["Feed › kinds (Shipped, Status, Decision, Finding, Incident, Triage)", `SELECT COUNT(DISTINCT substr(summary, 1, instr(summary, ':'))) AS n FROM feed WHERE org_id = ${O} AND id ${BLOCK} AND instr(summary, ':') > 0`, 6],
  ["Tags › the team's own", `SELECT COUNT(*) AS n FROM org_tags WHERE org_id = ${O} AND id ${BLOCK}`, 4],
  ["Docs › the layer's docs", `SELECT COUNT(*) AS n FROM docs WHERE org_id = ${O} AND slug IN ${inList(DOC_SLUGS)}`, 7],
  ["Review › staged doc proposals (the layer's)", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = ${O} AND status = 'staged' AND slug IN ${inList(DOC_SLUGS)}`, 3],
  ["Review › decision drafts (the layer's)", `SELECT COUNT(*) AS n FROM adrs WHERE org_id = ${O} AND id BETWEEN 7 AND 10 AND status = 'draft'`, 2],
  ["Unplaced › the layer's items", `SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = ${O} AND id ${BLOCK} AND resolved = 0`, 4],
  ["Prompt Library › the layer's prompts", `SELECT COUNT(*) AS n FROM prompts WHERE org_id = ${O} AND slug IN ${inList(PROMPT_SLUGS)}`, 4],
  ["Artifacts › shared with the org", `SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = ${O} AND id ${BLOCK} AND visibility = 'org'`, 8],
  ["Repo › merged PRs (12 weeks)", `SELECT COUNT(*) AS n FROM events WHERE org_id = ${O} AND event_type = 'pr_merged' AND ref_number BETWEEN ${PR_LO} AND ${PR_HI}`, 30],
  ["Repo › open PRs", `SELECT COUNT(DISTINCT number) AS n FROM repo_events WHERE org_id = ${O} AND semantic_key LIKE 'rich:pr:%' AND state IN ('review', 'draft') AND number >= 250 AND number NOT IN (SELECT number FROM repo_events WHERE org_id = ${O} AND kind = 'pr' AND state = 'merged')`, 6],
  ["Repo › pushes (12 weeks)", `SELECT COUNT(*) AS n FROM repo_events WHERE org_id = ${O} AND semantic_key LIKE 'rich:push:%'`, 150],
  ["Repo › CI runs (3 weeks)", `SELECT COUNT(*) AS n FROM repo_events WHERE org_id = ${O} AND semantic_key LIKE 'rich:run:%'`, 80],
  ["Repo › deploys on both environments", `SELECT COUNT(DISTINCT env || part) AS n FROM hosting_deploys WHERE org_id = ${O}`, 4],
  ["Repo › hourly hosting readings", `SELECT COUNT(*) AS n FROM repo_metrics WHERE org_id = ${O} AND metric GLOB 'hx_*'`, 2000],
  ["Repo › product metrics", `SELECT COUNT(*) AS n FROM repo_metrics WHERE org_id = ${O} AND metric GLOB 'sap_*'`, 100],
  ["Repo › releases", `SELECT COUNT(*) AS n FROM releases WHERE org_id = ${O}`, 6],
];

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (targetsRemote(argv)) {
    console.error("team-rich: refusing --remote. This seed only ever targets LOCAL D1.");
    process.exit(1);
  }
  const statements = teamRichStatements(new Date());
  if (argv.includes("--print")) { for (const st of statements) console.log(st + ";"); return; }
  const i = argv.indexOf("--persist-to");
  const { localD1 } = await import("./local-d1.mjs");
  const db = localD1({ persistTo: i >= 0 ? argv[i + 1] : null });
  const [members] = db.query([`SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${ORG}' AND user_id = '${ME}'`]);
  if (!Number(members[0]?.n)) { console.error(`team-rich: ${ME} is not a member of ${ORG} here — run \`npm run seed\` first.`); process.exit(1); }
  console.log("team-rich: writing SaplingLearn's rich layer to LOCAL D1…");
  db.apply("rich layer", statements);
  const counts = db.query([`SELECT ${CHECKS.map(([, sql], k) => `(${sql}) AS c${k}`).join(", ")}`])[0][0] ?? {};
  let bad = 0;
  console.log("\nSurfaces:");
  CHECKS.forEach(([what, , least], k) => {
    const n = Number(counts[`c${k}`] ?? 0);
    if (n < least) bad++;
    console.log(`  ${n >= least ? "ok     " : "MISSING"} ${what}: ${n}${n >= least ? "" : ` (want ≥ ${least})`}`);
  });
  console.log("\nRerun scripts/seed/ai-showcase.mjs to bring the AI rows (brief, repo state, Ask) in line with this repository state.");
  if (bad) process.exit(1);
}

if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  await main();
}
