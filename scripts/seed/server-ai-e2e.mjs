#!/usr/bin/env node
// The server-side AI end-to-end seed (Phase H, docs/superpowers/specs/2026-10-15-server-ai-e2e.md § 2). The matrix
// it serves is docs/testing/server-ai-test-matrix.md: its "state" column names the fixtures below.
//
// LOCAL D1 ONLY — it refuses --remote outright, like scripts/seed-dev.mjs.
//
//   node scripts/seed/server-ai-e2e.mjs [--persist-to <dir>] [--no-base] [--list]
//
//   --persist-to <dir>  the local D1 state directory, passed to `wrangler d1 execute --local` (default: wrangler's
//                       own, the `.wrangler/state` that `npm run dev` reads)
//   --no-base           leave out the dev seed (fixtures/dev/*: SaplingLearn's content) and seed only the test fixtures
//   --list              print the sections and the fixtures, touch nothing
//
// IDEMPOTENT: every run starts from the canonical reset (scripts/seed/reset.mjs), then the dev seed, then the test
// fixtures; run it again to go back to a clean state between cases. Every fixture is obviously fake: `test-`
// handles, slugs and titles, example.com e-mails, `org_test_*` ids, `test-org/*` repositories.
//
// SECTIONS. Each phase of the AI build is one section, naming the tables and columns it writes. When the database
// lacks one (its branch's migration is not merged yet) the section is SKIPPED with a message naming the migration
// and the branch, and the rest still seeds — run it on `ai/screens` now and again after each merge.
//
// AFTER IT (default local state only — that seed has no --persist-to): `node scripts/seed/repo-setups.mjs` (PR #186,
// on main) gives Repo › Overview real RepoFacts — sapling-live (org_saplinglearn, ≈ scenario A), new-org-found
// (org_b, scenario L) and unseen-org (org_test_unseen, scenario M). The `repo-facts` section below puts Trov's State on
// sapling-live's repository. Run this seed first: it resets everything, repo-setups only adds.
//
// SIGNING IN AS A FIXTURE PERSON. Every test person has a session row `test-session-<handle>`. With DEV_LOGIN UNSET
// in .dev.vars (it overrides every cookie), print the cookie with `node scripts/dev-cookie.mjs test-session-<handle>`
// and set it at http://localhost:8787 (`document.cookie = "session=…; path=/"`). No cookie = signed out. The
// `bearer-token` fixture's raw token is TEST_BEARER below (for "cookie only" refusals and MCP reads).
// The statement builders are importable from a Worker test (test/seed-server-ai-e2e.test.ts): only node:crypto is
// imported up front; the CLI's fs / os / path / child_process / url are imported inside `main()`.
import { createHash } from "node:crypto";
import { RESET_STATEMENTS } from "./reset.mjs";
import { buildSeedStatements, targetsRemote } from "./build.mjs";
import { datedRoadmap } from "./team-rich.mjs";

// ── literals ─────────────────────────────────────────────────────────────────────────────────────────────────────
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const MIN = 60_000;
const DAY = 86_400_000;
const raw = (sql) => ({ sql });

/** A row → `INSERT INTO t (cols) VALUES (…)`. null → NULL, number → as is, {sql} → raw SQL, an object/array → JSON
 *  text, anything else → a quoted string. */
export function insert(table, row, verb = "INSERT") {
  const cols = Object.keys(row);
  const vals = cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "1" : "0";
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "sql" in v) return v.sql;
    if (typeof v === "object") return q(JSON.stringify(v));
    return q(v);
  });
  return `${verb} INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
}

/** The raw bearer token of the `bearer-token` fixture (test-member in org-enterprise). Fake; local only. */
export const TEST_BEARER = "trov_mcp_test0e2e0bearer000000000000000000000000";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ── the schema the database has (what decides which sections run) ──────────────────────────────────────────────
/** One row per (table, column) of the database; the CLI runs it through wrangler, the test through Miniflare's D1. */
export const SCHEMA_SQL =
  "SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'";
export function schemaFromRows(rows) {
  const out = new Map();
  for (const { t, c } of rows) {
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(c);
  }
  return out;
}
/** The first table or column of `needs` the schema lacks ("table" / "table.column"); null when it has them all. */
export function missingFrom(schema, needs) {
  for (const [table, cols] of Object.entries(needs)) {
    const have = schema.get(table);
    if (!have) return table;
    for (const c of cols) if (!have.has(c)) return `${table}.${c}`;
  }
  return null;
}

// ── who and where ────────────────────────────────────────────────────────────────────────────────────────────────
/** The test people. `email: null` = no digest address; `unsub` = unsubscribed from every e-mail. */
export const PEOPLE = [
  { handle: "test-owner", name: "Test Owner", color: "moss" },
  { handle: "test-admin", name: "Test Admin", color: "sky" },
  { handle: "test-member", name: "Test Member", color: "fern" },
  { handle: "test-member2", name: "Test Member Two", color: "plum" },
  { handle: "test-outsider", name: "Test Outsider", color: "rust" },
  { handle: "test-solo", name: "Test Solo", color: "ochre" },
  { handle: "test-superadmin", name: "Test Superadmin", color: "slate" },
  { handle: "test-noemail", name: "Test No Email", color: "rose", email: null },
  { handle: "test-unsub", name: "Test Unsubscribed", color: "stone", unsub: true },
];
const emailOf = (p) => (p.email === null ? null : `${p.handle}@example.com`);

const STAFF = { owner: "test-owner", admin: ["test-admin"], member: ["test-member", "test-member2", "test-noemail", "test-unsub"] };
const SMALL = { owner: "test-owner", admin: ["test-admin"], member: ["test-member"] };

/** The test organizations: one per plan / switch / allowance state the matrix names. `n` keeps every row id apart. */
export const ORGS = [
  { fixture: "org-enterprise", n: 1, id: "org_test_ent", slug: "test-ent", name: "Test Enterprise", plan: "enterprise", source: "granted", people: STAFF },
  { fixture: "org-pro-5-seats", n: 2, id: "org_test_pro", slug: "test-pro", name: "Test Pro", plan: "team", source: "billing", overrides: { seats: 5 }, billing: true, people: SMALL },
  { fixture: "org-pro-gifted-3-members", n: 3, id: "org_test_gift", slug: "test-gift", name: "Test Gifted Pro", plan: "team", source: "granted", giftDays: 60, people: { owner: "test-owner", admin: [], member: ["test-member", "test-member2"] } },
  { fixture: "org-free", n: 4, id: "org_test_free", slug: "test-free", name: "Test Free", plan: "free", source: null, people: SMALL },
  { fixture: "org-personal", n: 5, id: "org_test_personal", slug: "test-personal", name: "Test Personal", plan: "personal", source: "granted", people: { owner: "test-solo", admin: [], member: [] } },
  { fixture: "org-ai-off", n: 6, id: "org_test_ai_off", slug: "test-ai-off", name: "Test AI Off", plan: "enterprise", source: "granted", aiOff: true, people: SMALL },
  { fixture: "org-auto-off", n: 7, id: "org_test_auto_off", slug: "test-auto-off", name: "Test Auto Off", plan: "team", source: "billing", overrides: { seats: 5 }, billing: true, autoOff: true, people: SMALL },
  { fixture: "org-at-cap", n: 8, id: "org_test_at_cap", slug: "test-at-cap", name: "Test At Cap", plan: "free", source: null, people: SMALL },
  { fixture: "org-past-cap", n: 9, id: "org_test_past_cap", slug: "test-past-cap", name: "Test Past Cap", plan: "free", source: null, people: SMALL },
  { fixture: "org-chat-3-left", n: 10, id: "org_test_chat_low", slug: "test-chat-low", name: "Test Chat Low", plan: "team", source: "billing", overrides: { seats: 1 }, billing: true, people: { owner: "test-owner", admin: [], member: ["test-member"] } },
  { fixture: "org-chat-override-10", n: 11, id: "org_test_chat_ovr", slug: "test-chat-ovr", name: "Test Chat Override", plan: "enterprise", source: "granted", overrides: { ai_chat: 10 }, people: { owner: "test-owner", admin: [], member: ["test-member"] } },
  { fixture: "org-canceled", n: 12, id: "org_test_canceled", slug: "test-canceled", name: "Test Canceled", plan: "team", source: "billing", overrides: { seats: 3 }, billing: true, canceled: true, people: { owner: "test-owner", admin: [], member: ["test-member"] } },
  { fixture: "empty-org", n: 13, id: "org_test_empty", slug: "test-empty", name: "Test Empty", plan: "enterprise", source: "granted", people: { owner: "test-owner", admin: [], member: ["test-member"] } },
  { fixture: "other-org", n: 14, id: "org_test_other", slug: "test-other", name: "Test Other", plan: "enterprise", source: "granted", people: { owner: "test-outsider", admin: [], member: [] } },
];
const ORG = Object.fromEntries(ORGS.map((o) => [o.fixture, o]));
const repoOf = (o) => `test-org/${o.slug}-repo`;
/** Row ids: org n's tickets are 100000 + n*1000 + number (and so on), so no two orgs or tables collide. */
const tid = (o, num) => 100000 + o.n * 1000 + num;
const sid = (o, k) => 100000 + o.n * 100 + k;
const hid = (o, num) => 100000 + o.n * 1000 + num;
const rid = (o, k) => 700000 + o.n * 1000 + k; // feed, adrs, needs_triage, artifact pages
const cid = (o, k) => 800000 + o.n * 1000 + k; // Ask threads, messages, actions

// ── the sections ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Each section: what it needs, where that comes from, and the fixtures it creates. */
export const SECTIONS = [
  { id: "core", title: "ai/screens: people, orgs, plans, allowances, content, Sift, suggestions, the router, e-mail prefs", branch: "ai/screens", migration: "0055–0059",
    needs: { orgs: ["ai_automation", "ai_chat_auto"], ai_suggestions: ["kind"], ai_feedback: ["handle"], ai_dirty: ["marked_at", "urgent"], org_ai_settings: ["kind"] } },
  { id: "ask", title: "Ask Trov's backend: threads, messages, cards, settings, flags", branch: "ai/screens (Phase F)", migration: "0066_ask",
    needs: { chat_threads: ["mode", "origin"], chat_messages: ["replaced_at"], chat_actions: ["group_id", "undo_json"], chat_artifacts: ["role"], person_ask_settings: ["default_mode"], ask_flags: ["reason"], ai_feedback: ["detail_json"] } },
  { id: "phase-c-tickets", title: "Phase C cards: ticket / Unplaced / Review suggestions (rendered once ai/phase-c-tickets is merged)", branch: "ai/phase-c-tickets", migration: "none (0055 ai_suggestions)",
    needs: { ai_suggestions: ["value_json"] } },
  { id: "phase-c-feed", title: "Phase C importance: feed and PR ratings", branch: "ai/phase-c-feed", migration: "0060_ai_importance",
    needs: { feed: ["importance"], pr_summaries: ["importance"] } },
  { id: "phase-d-digests", title: "Phase D: Trov's session digests and repo state", branch: "ai/phase-d-digests", migration: "0061_ai_digests + 0062_repo_state",
    needs: { feed: ["origin", "model", "subject"], ai_sessions: ["status"], repo_state: ["state_json"] } },
  { id: "phase-d-brief", title: "Phase D: the brief on My Work", branch: "ai/phase-d-brief", migration: "0063_person_brief",
    needs: { person_brief: ["brief_json"], memberships: ["mywork_opened_at"] } },
  { id: "phase-d-themes", title: "Phase D: Where the work went (themes)", branch: "ai/phase-d-themes", migration: "0064_repo_themes",
    needs: { repo_themes: ["status"], pr_themes: ["source"], repo_theme_captions: ["caption"] } },
  { id: "phase-d-roadmap", title: "Phase D: sprint notes, plan drift, Roadmap suggestions", branch: "ai/phase-d-roadmap", migration: "0065_org_insights",
    needs: { org_insights: ["json"] } },
  { id: "phase-e-emails", title: "Phase E: \"Only when something needs me\" and the weekly \"This week\" highlights", branch: "ai/phase-e-emails", migration: "0067_digest_email",
    needs: { notification_person_prefs: ["only_when_needed"], digest_highlights: ["highlights_json"] } },
  { id: "repo-facts", title: "Repo › Overview after PR #186 (RepoFacts): Trov's State over SaplingLearn/sapling — then run scripts/seed/repo-setups.mjs (scenarios sapling-live / new-org-found / unseen-org)", branch: "main (#186, 0070_repo_apps) + ai/phase-d-digests (0062_repo_state)", migration: "0070_repo_apps + 0062_repo_state",
    needs: { repo_apps: ["key", "kind"], repo_state: ["state_json"] } },
];

/** Every fixture: its name (the matrix's state column), its section, what it is, and the checks the CLI runs after
 *  seeding — each `[sql returning one row {n}, the least n it must be]`. Filled by the section builders below. */
export const FIXTURES = [];
const fixture = (section, name, what, ...checks) => FIXTURES.push({ section, name, what, checks });

// ── the builders ─────────────────────────────────────────────────────────────────────────────────────────────────
function makeClock(now) {
  const t = now.getTime();
  const ago = (min) => new Date(t - min * MIN).toISOString();
  const days = (d) => new Date(t - d * DAY).toISOString();
  const ahead = (d) => new Date(t + d * DAY).toISOString();
  const today = new Date(t).toISOString().slice(0, 10);
  const lastMonth = new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 0)).toISOString().slice(0, 10);
  return { iso: new Date(t).toISOString(), ago, days, ahead, today, lastMonth, dateIn: (d) => new Date(t + d * DAY).toISOString().slice(0, 10) };
}

const tc = (o, num) => ({ ref: `ticket:${num}`, label: `#${num}`, href: `#tickets/${num}` });
const pc = (o, num) => ({ ref: `pr:${num}`, label: `#${num}`, href: `https://github.com/${repoOf(o)}/pull/${num}` });
const hc = (num) => ({ ref: `handoff:${num}`, label: `handoff #${num}`, href: `#handoffs/${num}` });

/** Content every org with data shares: tickets, a sprint, handoffs, docs, an ADR, Unplaced items, agent feed, PRs. */
function contentFor(o, c, s, { rich }) {
  const owner = o.people.owner;
  const member = o.people.member[0] ?? owner;
  const member2 = o.people.member[1] ?? member;
  const repo = repoOf(o);
  s.push(insert("org_repos", { id: `hook_${o.id}`, org_id: o.id, repo_full_name: repo, is_primary: 1, legacy_hook: 0, created_at: c.days(90), created_by: owner }));
  // The six starter tags (0056) — copied from the seed org's rows, which the reset just wrote.
  s.push(`INSERT INTO org_tags (org_id, name, description, color, starter, created_at, created_by) SELECT ${q(o.id)}, name, description, color, starter, created_at, created_by FROM org_tags WHERE org_id = 'org_saplinglearn' AND starter = 1`);
  s.push(insert("org_tags", { org_id: o.id, name: "test-hosting", description: "test- Hosting providers and deploys", color: "ochre", starter: 0, created_at: c.days(30), created_by: owner }));

  // Sprints: one active (started 10 days ago, due in 4 — a forecast), one upcoming, one done.
  const sprint = (k, title, status, start, target) =>
    s.push(insert("sprints", { org_id: o.id, id: sid(o, k), title, description: `${title}: test sprint`, summary: `${title}.`, status, start_date: start, target_date: target, created_at: c.days(40), created_by: owner, updated_at: c.days(1), urgency: "normal", lead: owner, domain: "infra" }));
  const activeSprint = o.fixture !== "org-pro-5-seats" && o.fixture !== "org-free"; // Pro and Free: no active sprint (a sprint draft can be due)
  sprint(1, "test-Sprint Hosting", activeSprint ? "in_progress" : "upcoming", c.dateIn(-10), c.dateIn(4));
  sprint(2, "test-Sprint Search", "upcoming", c.dateIn(5), c.dateIn(20));
  sprint(3, "test-Sprint Billing", "done", c.dateIn(-40), c.dateIn(-20));

  // Tickets: numbers 1–14. #1–#6 are in sprint 1 (2 of 5 done: a forecast); #7–#14 are the backlog.
  const T = [
    [1, "test-Login page is blank on Safari", "bug", "high", "in_progress", [member], 1, "The login page renders blank on Safari 18 after the update. Console shows a CSP error."],
    [2, "test-Blank login screen after the Safari update", "other", "normal", "submitted", [], 1, "Since this morning the login screen is blank in Safari. Chrome works."],
    [3, "test-<img src=x onerror=alert(1)> <b>bold</b> **markdown** title", "question", "normal", "submitted", [member], 1, "<script>alert('test-xss')</script> and [a link](javascript:alert(1))"],
    [4, "test-Résumé upload fails for 日本語 names 🚀", "bug", "low", "testing", [member], 1, "Unicode: ñ, 日本語, emoji 🚀🔥, RTL שלום."],
    [5, "test-Netlify deploy preview is failing", "bug", "high", "done", [member], 1, "Fixed by the redirect change."],
    [6, "test-Add a dark mode to the docs reader", "request", "normal", "done", [member2], 1, "Done in the reader."],
    [7, "test-Export tickets to CSV", "request", "normal", "submitted", [], null, "A CSV export of the queue."],
    [8, "test-Give the support team access to Review", "access", "normal", "submitted", [], null, "Sana's team needs to read Review."],
    [9, "test-Rate limit the public search", "request", "high", "submitted", [], null, "Search gets hammered by bots."],
    [10, "test-Show sprint burn-down on the Roadmap", "request", "low", "in_progress", [owner], null, "A small chart per sprint."],
    [11, "test-Typo on the pricing page", "bug", "low", "submitted", [], null, "\"recieve\" on /pricing."],
    [12, "test-Retry failed webhook deliveries", "request", "normal", "submitted", [], null, "GitHub redelivers; we should too."],
    [13, "test-How do I rotate an MCP token?", "question", "normal", "submitted", [], null, "Asked in support."],
    [14, "test-Declined: rewrite in Rust", "request", "low", "declined", [], null, "Not now."],
  ];
  const tickets = rich ? T : T.slice(0, 6).concat(T.slice(6, o.fixture === "org-free" ? 13 : 14));
  for (const [num, title, category, priority, status, assignees, sprintK, body] of tickets) {
    const at = c.days(20 - num);
    s.push(insert("tickets", { org_id: o.id, id: tid(o, num), number: num, title, body, category, priority, status, requester: owner, parent_id: null, sprint_id: sprintK ? sid(o, sprintK) : null, created_at: at, updated_at: at }));
    for (const login of assignees) s.push(insert("ticket_assignees", { org_id: o.id, ticket_id: tid(o, num), login }));
    s.push(insert("ticket_events", { org_id: o.id, ticket_id: tid(o, num), actor: owner, from_status: null, to_status: "submitted", created_at: at }));
    if (status !== "submitted") s.push(insert("ticket_events", { org_id: o.id, ticket_id: tid(o, num), actor: owner, from_status: "submitted", to_status: status, created_at: at }));
  }
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES (${q(o.id)}, 'ticket', (SELECT COALESCE(MAX(number), 0) FROM tickets WHERE org_id = ${q(o.id)}))`);

  // Handoffs: #1 to the member with words that match a doc (a reading list), #2 to anyone, #3 claimed, #4 stop words only.
  const H = [
    [1, member2, member, "pending", "Finish the deploy checklist for the Netlify preview: the redirect rules and the cache headers.", { task: "Deploy checklist: Netlify redirect rules and cache headers", done: ["Redirect rules drafted"], next: ["Cache headers", "Update the deploy checklist doc"], files: ["netlify.toml"] }],
    [2, owner, "anyone", "pending", "Someone pick up the webhook retries: GitHub redelivery and our own retry queue.", { task: "Webhook retries", done: [], next: ["Read the webhook doc"], files: [] }],
    [3, owner, member, "claimed", "Claimed already: the CSV export.", { task: "CSV export", done: [], next: [], files: [] }],
    [4, member2, member, "pending", "Fix it, ok", { task: "", done: [], next: [], files: [] }],
  ];
  for (const [num, sender, recipient, status, body, ctx] of H) {
    const at = c.ago(30 + num * 60);
    s.push(insert("handoffs", { org_id: o.id, id: hid(o, num), number: num, sender, recipient, status, body, context: { repo, branch: "main", ...ctx }, created_at: at, claimed_at: status === "claimed" ? c.ago(20) : null, claimed_by: status === "claimed" ? recipient : null, expires_at: c.ahead(6) }));
  }
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES (${q(o.id)}, 'handoff', ${H.length})`);

  // Docs: two live, one with a staged proposal (Review); an ADR draft and a ratified one; Unplaced items.
  const docs = [
    ["test-deploy-checklist", "test-Deploy checklist", "# Deploy checklist\n\nBefore a Netlify deploy: check the redirect rules, the cache headers and the preview URL.\n\n## Rollback\n\nRedeploy the previous build."],
    ["test-webhook-retries", "test-Webhook retries", "# Webhook retries\n\nGitHub redelivers a failed webhook delivery once. Our retry queue is not built yet."],
    ["test-auth-sessions", "test-Auth sessions", "# Auth sessions\n\nSessions last 30 days. We decided on cookie sessions in ADR-1."],
  ];
  for (const [slug, title, body] of docs) {
    s.push(insert("docs", { org_id: o.id, slug, section: "reference", space: "technical", title, body, current_version: 1, updated_at: c.days(10), updated_by: owner, owner }));
    s.push(insert("doc_versions", { org_id: o.id, slug, version: 1, body, summary: "first version", status: "promoted", confidence: "high", created_at: c.days(10), created_by: owner, change_kind: "new", base_version: null, low_confidence: 0 }));
  }
  s.push(insert("doc_versions", { org_id: o.id, slug: "test-auth-sessions", version: 2, body: "# Auth sessions\n\nSessions now last 7 days, and we move to bearer tokens for the web app.", summary: "test- Shorter sessions; bearer tokens on the web", status: "staged", confidence: "medium", created_at: c.ago(90), created_by: member, change_kind: "edit", base_version: 1, low_confidence: 0 }));
  s.push(insert("adrs", { org_id: o.id, id: rid(o, 1), title: "test-ADR: cookie sessions for the web app", context: "We need web sign-in.", decision: "Cookie sessions, never bearer tokens on the web.", rationale: "CSRF is handled.", status: "ratified", confidence: "high", created_at: c.days(60), created_by: owner }));
  s.push(insert("adrs", { org_id: o.id, id: rid(o, 2), title: "test-ADR draft: bearer tokens for the web app", context: "Mobile needs tokens.", decision: "Use bearer tokens in the web app too.", rationale: "One auth path.", status: "draft", confidence: "medium", created_at: c.ago(120), created_by: member }));
  s.push(insert("needs_triage", { org_id: o.id, id: rid(o, 3), raw: JSON.stringify({ slug: "test-runbook-netlify", section: "runbooks", title: "test-Netlify runbook", body: "When a Netlify deploy fails: check the build log, then the redirect rules.", change_summary: "new", confidence: "low" }), reason: "unknown section: runbooks", source_author: member, resolved: 0, created_at: c.ago(200) }));
  s.push(insert("needs_triage", { org_id: o.id, id: rid(o, 4), raw: "test- free-form note: remember to ask about the staging database", reason: "not a doc", source_author: member2, resolved: 0, created_at: c.ago(300) }));

  // Agent feed entries (the Feed, the filter's author / range).
  const F = [
    [5, member, "Shipped: test- the Netlify redirect fix", "Redirects now keep the query string.", 60, ["infra"]],
    [6, member2, "Finding: test- Safari blocks the login iframe", "CSP frame-ancestors is too strict.", 600, ["auth", "ui"]],
    [7, owner, "Decision: test- keep cookie sessions", "Bearer tokens stay MCP-only.", 3 * 1440, ["auth"]],
    [8, member, "Status: test- webhook retries half done", "The queue table exists; the worker does not.", 9 * 1440, ["api"]],
  ];
  for (const [k, author, summary, body, agoMin, tags] of F) {
    s.push(insert("feed", { org_id: o.id, id: rid(o, k), author, summary, body, artifacts: { prs: [], commits: [], issues: [] }, created_at: c.ago(agoMin) }));
    for (const tag of tags) s.push(insert("entry_tags", { org_id: o.id, tag, entry_type: "feed", entry_id: String(rid(o, k)) }));
  }

  // Merged PRs with cards over the last 12 weeks: 16 in a rich org (past the 15 the theme proposal needs), 14 elsewhere.
  const prCount = rich ? 16 : 14;
  for (let i = 0; i < prCount; i++) {
    const num = 100 + i;
    const at = c.days(80 - i * 5);
    const key = `gh:pr:${num}:merged`;
    const title = `test-PR ${num}: ${["hosting", "search", "billing", "auth"][i % 4]} change`;
    s.push(insert("events", { org_id: o.id, repo, semantic_key: key, event_type: "pr_merged", ref_number: num, subject_login: member, raw: { pr: { number: num, title, body: `test- body of PR ${num}`, html_url: `https://github.com/${repo}/pull/${num}`, merged: true, merged_at: at, base: { ref: "main" }, head: { ref: `test-branch-${num}` }, user: { login: member } } }, provenance: "backfill", occurred_at: at, recorded_at: at, recorded_by: "github-webhook" }));
    s.push(insert("pr_summaries", { org_id: o.id, repo, semantic_key: key, pr_number: num, model: "claude-haiku-5-5", created_at: at, title, what: `test- what PR ${num} changed`, why: "test- why", impact: "test- impact" }));
  }
  // A private artifact by member2 (hidden from everyone else) and an org one.
  const art = (k, slug, title, visibility, author) => {
    const body = `# ${title}\n\ntest- artifact body.`;
    s.push(insert("artifact_pages", { org_id: o.id, id: rid(o, k), slug, title, kind: "markdown", area: "infra", repo, author_id: author, status: "published", visibility, current_version: 1, created_at: c.days(3), updated_at: c.days(3), published_at: c.days(3) }));
    s.push(insert("artifact_versions", { org_id: o.id, page_id: rid(o, k), version_no: 1, summary: "first", content: body, r2_key: null, size_bytes: new TextEncoder().encode(body).length, content_type: "text/markdown", sha256: sha256(body), filename: null, created_by: author, created_at: c.days(3) }));
  };
  art(9, `test-${o.slug}-checkout-design`, "test-Checkout design", "org", owner);
  art(10, `test-${o.slug}-private-notes`, "test-Private notes", "private", member2);
}

function buildCore(c, s) {
  // People: a Google identity each (example.com), a session row, a digest address (unless the fixture says no).
  for (const p of PEOPLE) {
    s.push(insert("persons", { handle: p.handle, name: p.name, color: p.color, email: emailOf(p), email_unsubscribed: p.unsub ? 1 : 0, created_at: c.days(100), onboarded_at: c.days(100), role: null }));
    s.push(insert("identities", { provider: "google", subject: `google-sub-${p.handle}`, label: `${p.handle}@example.com`, person: p.handle, linked_at: c.days(100), linked_by: "seed", verified_email: `${p.handle}@example.com` }));
    s.push(insert("sessions", { id: `test-session-${p.handle}`, person: p.handle, created_at: c.iso, expires_at: c.ahead(30) }));
  }
  fixture("core", "person-owner / person-admin / person-member / person-member2", "the four roles of org-enterprise (owner, admin, two members); sessions test-session-<handle>",
    ["SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'test-session-%'", PEOPLE.length]);
  fixture("core", "person-outsider", "test-outsider: owner of other-org only, a member of nothing else",
    ["SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'test-outsider'", 1]);
  s.push(insert("platform_admins", { person: "test-superadmin", granted_at: c.days(100), granted_by: "seed" }));
  fixture("core", "person-superadmin", "test-superadmin: a platform admin who is a member of NO org (no implicit access)",
    ["SELECT COUNT(*) AS n FROM platform_admins WHERE person = 'test-superadmin'", 1]);
  fixture("core", "person-noemail", "test-noemail: a member of org-enterprise with no digest address", ["SELECT COUNT(*) AS n FROM persons WHERE handle = 'test-noemail' AND email IS NULL", 1]);
  fixture("core", "person-unsubscribed", "test-unsub: a member of org-enterprise unsubscribed from e-mail", ["SELECT COUNT(*) AS n FROM persons WHERE handle = 'test-unsub' AND email_unsubscribed = 1", 1]);

  for (const o of ORGS) {
    s.push(insert("orgs", {
      id: o.id, slug: o.slug, name: o.name, created_at: c.days(100), created_by: o.people.owner,
      plan: o.plan, plan_source: o.source, plan_overrides: o.overrides ?? {}, plan_status: o.canceled ? "canceled" : "active",
      billing_customer_id: o.billing ? `cus_test_${o.n}` : null, billing_subscription_id: o.billing ? `sub_test_${o.n}` : null,
      plan_gift_until: o.giftDays ? c.ahead(o.giftDays) : null, ai_automation: o.aiOff ? 0 : 1, ai_chat_auto: o.autoOff ? 0 : 1,
    }));
    const role = (handle, r) => s.push(insert("memberships", { org_id: o.id, user_id: handle, role: r, title: null, responsibilities: null, created_at: c.days(100), created_by: "seed" }));
    role(o.people.owner, "owner");
    for (const h of o.people.admin) role(h, "admin");
    for (const h of o.people.member) role(h, "member");
    s.push(insert("plan", { org_id: o.id, narrative: o.fixture === "empty-org" ? "" : "**Now:** test- hosting. **Next:** test- search. **Later:** test- billing.", current_version: o.fixture === "empty-org" ? 0 : 1, updated_at: c.days(14), updated_by: o.people.owner }));
    s.push(insert("notification_settings", { org_id: o.id, send_hour: 8, timezone: "America/New_York", from_address: "Trov <hello@trov.dev>" }));
    fixture("core", o.fixture, `${o.name} (${o.slug}): plan ${o.plan}${o.source ? `/${o.source}` : ""}${o.overrides ? ` overrides ${JSON.stringify(o.overrides)}` : ""}${o.aiOff ? ", AI switch OFF" : ""}${o.autoOff ? ", Auto OFF" : ""}${o.canceled ? ", plan CANCELED" : ""}${o.giftDays ? `, gifted until +${o.giftDays}d` : ""}`,
      [`SELECT COUNT(*) AS n FROM orgs WHERE id = ${q(o.id)}`, 1]);
  }
  // Content: rich in org-enterprise (and other-org, the isolation target); the same in the plan / switch orgs so each
  // screen has something to show; nothing in empty-org.
  for (const o of ORGS) {
    if (o.fixture === "empty-org" || o.fixture === "org-personal") continue;
    contentFor(o, c, s, { rich: ["org-enterprise", "other-org", "org-ai-off"].includes(o.fixture) });
  }
  const ent = ORG["org-enterprise"];
  fixture("core", "tickets-many", "org-enterprise: tickets #1–#14 (sprint 1 holds #1–#6, 2 of 5 open done), statuses submitted → declined",
    [`SELECT COUNT(*) AS n FROM tickets WHERE org_id = '${ent.id}'`, 14]);
  fixture("core", "ticket-html-injection", "ticket #3 in every org with content: HTML / script / markdown / javascript: link in title and body",
    [`SELECT COUNT(*) AS n FROM tickets WHERE org_id = '${ent.id}' AND number = 3 AND title LIKE '%<img%'`, 1]);
  fixture("core", "ticket-unicode", "ticket #4: accents, CJK, emoji, RTL", [`SELECT COUNT(*) AS n FROM tickets WHERE org_id = '${ent.id}' AND number = 4`, 1]);
  fixture("core", "sprint-active-forecast", "sprint 1 'test-Sprint Hosting' in_progress, started 10 days ago, due in 4, 2 of 5 done (none in org-pro / org-free: no active sprint)",
    [`SELECT COUNT(*) AS n FROM sprints WHERE org_id = '${ent.id}' AND status = 'in_progress'`, 1]);
  fixture("core", "backlog-8 / backlog-7", "open tickets outside any sprint: 8 in org-pro (a sprint draft is due — no active sprint), 7 in org-free (one short)",
    [`SELECT COUNT(*) AS n FROM tickets WHERE org_id = '${ORG["org-pro-5-seats"].id}' AND sprint_id IS NULL AND status IN ('submitted','in_progress','testing')`, 6]);
  fixture("core", "handoff-reading-list", "handoff #1 to test-member: words match the doc test-deploy-checklist (a non-empty reading list on claim)",
    [`SELECT COUNT(*) AS n FROM handoffs WHERE org_id = '${ent.id}' AND number = 1 AND status = 'pending'`, 1]);
  fixture("core", "handoff-reading-list-empty", "handoff #4 'Fix it, ok' (stop words only: an empty reading list)", [`SELECT COUNT(*) AS n FROM handoffs WHERE org_id = '${ent.id}' AND number = 4`, 1]);
  fixture("core", "handoff-anyone", "handoff #2 to anyone (person scope for up to 20 members)", [`SELECT COUNT(*) AS n FROM handoffs WHERE org_id = '${ent.id}' AND recipient = 'anyone'`, 1]);
  fixture("core", "doc-staged-proposal", "test-auth-sessions v2 staged (Review), contradicting ADR test-ADR: cookie sessions",
    [`SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = '${ent.id}' AND status = 'staged'`, 1]);
  fixture("core", "adr-draft / adr-ratified", "a draft ADR (Review) and a ratified one", [`SELECT COUNT(*) AS n FROM adrs WHERE org_id = '${ent.id}'`, 2]);
  fixture("core", "unplaced-doc-item / unplaced-freeform-item", "two Unplaced items: one doc-shaped (JSON raw with slug/body), one free-form",
    [`SELECT COUNT(*) AS n FROM needs_triage WHERE org_id = '${ent.id}' AND resolved = 0`, 2]);
  fixture("core", "feed-agent-entries", "four agent feed entries (1 h, 10 h, 3 d, 9 d old) — the filter's 24h / 7d / all", [`SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ent.id}'`, 4]);
  fixture("core", "prs-merged-16 / prs-merged-14", "carded merged PRs in 12 weeks: 16 in org-enterprise (themes can be proposed), 14 elsewhere (one short)",
    [`SELECT COUNT(*) AS n FROM pr_summaries WHERE org_id = '${ent.id}' AND what IS NOT NULL`, 16]);
  fixture("core", "artifacts-org-and-private", "test-…-checkout-design (org) and test-…-private-notes (private, by test-member2: hidden from others)",
    [`SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = '${ent.id}'`, 2]);

  // Sift: on in org-enterprise; off (no row) elsewhere; a run in progress in org-free.
  s.push(insert("org_ai_settings", { org_id: ent.id, kind: "tag.fit", enabled: 1, updated_at: c.days(5), updated_by: ent.people.owner }));
  s.push(insert("org_ai_settings", { org_id: ORG["org-ai-off"].id, kind: "tag.fit", enabled: 1, updated_at: c.days(5), updated_by: "test-owner" }));
  s.push(insert("org_ai_settings", { org_id: ORG["org-free"].id, kind: "tag.fit", enabled: 1, updated_at: c.days(5), updated_by: "test-owner" }));
  s.push(insert("org_tag_runs", { org_id: ORG["org-free"].id, tag: "test-hosting", status: "running", started_by: "test-owner", started_at: c.ago(1), candidates: 10, calls: 2, checked: 2, added: 0 }));
  fixture("core", "sift-on", "Sift switch on: org-enterprise, org-free, org-ai-off (where the ORG switch stops it)", [`SELECT COUNT(*) AS n FROM org_ai_settings WHERE enabled = 1 AND org_id LIKE 'org_test_%'`, 3]);
  fixture("core", "sift-run-busy", "org-free: a Sift run of test-hosting in progress (Find items says busy)", [`SELECT COUNT(*) AS n FROM org_tag_runs WHERE status = 'running' AND org_id = '${ORG["org-free"].id}'`, 1]);

  // Allowances, this month (`day` = today, UTC). Exact numbers per org; one row LAST month that must not count.
  const use = (o, metric, actor, count, day = c.today) => s.push(insert("org_usage_daily", { org_id: o.id, day, metric, actor, count, last_at: c.iso }, "INSERT OR REPLACE"));
  const allow = (o, { summaries, runs, jev, chat }) => {
    if (summaries) use(o, "summary:pr", "github-webhook", summaries);
    if (runs) use(o, "ai_run:filter", "ai-filter", runs);
    if (jev) use(o, "ai_suggest", "ai-pass", jev);
    if (chat) use(o, "ai_chat", "test-member", chat);
  };
  allow(ent, { summaries: 412, runs: 37, jev: 1520, chat: 64 });
  allow(ORG["org-pro-5-seats"], { summaries: 1000, runs: 1200, jev: 4000, chat: 400 });
  allow(ORG["org-pro-gifted-3-members"], { summaries: 20, runs: 10, jev: 40, chat: 299 }); // gate cap 900 (300 × 3 members); /ask/state may say 300
  allow(ORG["org-free"], { summaries: 120, runs: 120, jev: 300, chat: 20 });
  allow(ORG["org-at-cap"], { summaries: 300, runs: 250, jev: 1000, chat: 50 });
  allow(ORG["org-past-cap"], { summaries: 310, runs: 260, jev: 1012, chat: 55 });
  allow(ORG["org-chat-3-left"], { chat: 297 });
  allow(ORG["org-chat-override-10"], { chat: 9 });
  allow(ORG["org-canceled"], { runs: 1 });
  use(ORG["org-free"], "ai_run:filter", "ai-filter", 999, c.lastMonth);
  fixture("core", "allowance-partly-used", "org-enterprise / org-pro / org-free: every allowance partly used this month", [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG["org-pro-5-seats"].id}'`, 4]);
  fixture("core", "allowance-at-cap", "org-at-cap: summaries 300/300, runs 250/250, Sift 1000/1000, Ask 50/50", [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG["org-at-cap"].id}'`, 4]);
  fixture("core", "allowance-past-cap", "org-past-cap: 310/300, 260/250, 1012/1000, 55/50", [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG["org-past-cap"].id}'`, 4]);
  fixture("core", "allowance-last-month", "org-free: 999 ai_run:filter dated last month (must NOT count)", [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG["org-free"].id}' AND day = '${c.lastMonth}'`, 1]);
  fixture("core", "chat-3-left", "org-chat-3-left: Pro, 1 paid seat, Ask 297/300 (Smart fits, Thinking's 5 does not; under 20% left)", [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG["org-chat-3-left"].id}' AND metric = 'ai_chat' AND count = 297`, 1]);
  fixture("core", "chat-override-10", "org-chat-override-10: Enterprise with ai_chat overridden to 10, 9 used (edit the row to 5 / 10 / 11)", [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG["org-chat-override-10"].id}' AND count = 9`, 1]);

  // Platform › Usage's AI line: every AI metric in org-enterprise and org-pro.
  for (const [o, k] of [[ent, 1], [ORG["org-pro-5-seats"], 3]]) {
    use(o, "ai_run:ticket.category", "ai-pass", 5 * k);
    use(o, "ai_run_failed:digest.session", "ai-pass", 2 * k);
    use(o, "ai_run_capped:brief.person", "ai-pass", 1 * k);
    use(o, "ai_tokens_in", "ai-pass", 18000 * k);
    use(o, "ai_tokens_out", "ai-pass", 2400 * k);
    use(o, "ai_tokens_cached", "ai-pass", 9000 * k);
    use(o, "ai_jev_tokens_in", "ai-pass", 3000 * k);
    use(o, "ai_jev_tokens_out", "ai-pass", 40 * k);
  }
  fixture("core", "usage-platform-ai", "org-enterprise and org-pro: runs, failed, capped, Claude tokens, Sift checks and tokens (Platform › Usage)",
    [`SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ent.id}' AND metric GLOB 'ai_*'`, 8]);

  // The filter's rate limit: test-admin has used this hour's 60.
  s.push(insert("abuse_counters", { subject: "test-admin", action: "ai_filter", bucket: c.iso.slice(0, 13), count: 60, last_at: c.iso }, "INSERT OR REPLACE"));
  fixture("core", "filter-rate-limited", "test-admin has spent this UTC hour's 60 filter requests (the 429)", ["SELECT COUNT(*) AS n FROM abuse_counters WHERE subject = 'test-admin' AND action = 'ai_filter'", 1]);

  // Generic suggestions and "Wrong?" — what ai/screens alone can answer (no accept handler yet: not_available).
  const sug = (id, o, row) => s.push(insert("ai_suggestions", { id, org_id: o.id, confidence: 0.8, cites_json: [], model: "test-model", prompt_version: "test-1", created_at: c.ago(60), ...row }));
  sug(5001, ent, { item_type: "theme", item_ref: `${repoOf(ent)}#999`, kind: "test.unhandled", value_json: { name: "test-Theme" }, reason: "test- a kind no handler answers", state: "open" });
  sug(5002, ent, { item_type: "theme", item_ref: `${repoOf(ent)}#998`, kind: "test.unhandled", value_json: { name: "test-Old" }, reason: "test- already dismissed", state: "dismissed", decided_by: "test-admin", decided_at: c.ago(30) });
  sug(5003, ORG["other-org"], { item_type: "ticket", item_ref: "2", kind: "ticket.category", value_json: JSON.stringify("bug"), reason: "it says “test- blank”", state: "open" });
  fixture("core", "suggestion-unhandled-open", "suggestion 5001 (org-enterprise): open, a kind with no handler → accept 409 not_available, dismiss 200", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5001", 1]);
  fixture("core", "suggestion-dismissed", "suggestion 5002: already dismissed → 409 not_open", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5002 AND state = 'dismissed'", 1]);
  fixture("core", "suggestion-other-org", "suggestion 5003 belongs to other-org → 404 from any org-enterprise person", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5003", 1]);

  // The router's rows: a dirty card, a session, an urgent person, a scope parked after 3 failures, a clean repo.
  const dirty = (o, scope, scope_key, extra = {}) => s.push(insert("ai_dirty", { org_id: o.id, scope, scope_key, dirty_since: c.ago(120), marked_at: c.ago(60), last_run_at: null, attempts: 0, last_error: null, urgent: 0, ...extra }));
  dirty(ent, "card", "ticket:2");
  dirty(ent, "session", `${repoOf(ent)}:test-member`, { dirty_since: c.ago(50), marked_at: c.ago(50) });
  dirty(ent, "person", "test-member", { urgent: 1 });
  dirty(ent, "repo", repoOf(ent), { attempts: 3, last_error: "no_answer" });
  dirty(ent, "org", "", { last_run_at: c.ago(10), marked_at: c.ago(300) });
  fixture("core", "ai-dirty-scopes", "org-enterprise: a dirty card, a 50-min-old session, an urgent person, a repo parked after 3 failures, a clean org scope", [`SELECT COUNT(*) AS n FROM ai_dirty WHERE org_id = '${ent.id}'`, 5]);

  // E-mail: everyone in PEOPLE has an address except test-noemail; prefs: test-member gets daily, test-member2 weekly only.
  const pref = (o, user_id, kind, cadence) => s.push(insert("notification_prefs", { org_id: o.id, user_id, kind, cadence, updated_at: c.days(3) }));
  pref(ent, "test-member", "my_work", "daily");
  pref(ent, "test-member2", "my_work", "weekly");
  pref(ent, "test-member2", "review_queue", "off");
  s.push(insert("notification_outbox", { org_id: ent.id, idempotency_key: `${ent.id}:test-member:daily:test-failed`, user_id: "test-member", cadence: "daily", window_id: "test-failed", kinds: ["my_work"], status: "failed", error: "test- send failed", created_at: c.ago(300) }));
  fixture("core", "digest-recipients", "org-enterprise members with example.com addresses; test-member daily, test-member2 weekly; a failed outbox row (retry)",
    [`SELECT COUNT(*) AS n FROM persons WHERE handle LIKE 'test-%' AND email LIKE '%@example.com'`, PEOPLE.length - 1]);

  // A bearer token (pasted MCP) for test-member in org-enterprise.
  s.push(insert("mcp_tokens", { person: "test-member", token_hash: sha256(TEST_BEARER), created_at: c.days(2), token_hint: TEST_BEARER.slice(-4), org_id: ent.id, revoked: 0 }));
  fixture("core", "bearer-token", `test-member's MCP token in org-enterprise: Authorization: Bearer ${TEST_BEARER}`, ["SELECT COUNT(*) AS n FROM mcp_tokens WHERE person = 'test-member'", 1]);
}

/** A RefView snapshot as Ask stores it in `cites_json` (not re-resolved on read). */
const refView = (num, title, word = "In progress", mark = "half") => ({ ref: `ticket:${num}`, type: "ticket", num, title, status: { mark, tone: "accent", word, tip: `${word}.` }, owner: "test-member", updated: null, href: `#tickets/${num}`, extra: { priority: "high", assignees: ["test-member"], sprint: null } });

function buildAsk(c, s) {
  const ent = ORG["org-enterprise"];
  const thread = (o, k, row) => s.push(insert("chat_threads", { id: cid(o, k), org_id: o.id, mode: "smart", origin: "page", pinned: 0, auto_mode: 0, draft: "", turn: 1, created_at: row.updated_at, ...row }));
  const msg = (o, k, threadK, role, content, extra = {}) => s.push(insert("chat_messages", { id: cid(o, k), org_id: o.id, thread_id: cid(o, threadK), role, mode: extra.mode ?? "smart", content_json: content, cites_json: extra.cites ?? [], attachments_json: [], model: role === "assistant" ? "claude-sonnet-5-5" : null, units: role === "assistant" ? 1 : 0, created_at: extra.at ?? c.ago(55) }));
  const userText = (text) => ({ text, command: null, context: [], refs: [], attached: [] });
  const answer = (text, refs = []) => ({ text, refs, blocks: [], activity: [], followups: ["test- What changed since?"], thinking: null });

  // test-member's threads in org-enterprise: one per list group, a pinned one, an injection one, an untitled one.
  thread(ent, 1, { handle: "test-member", title: "test-What is blocking #1?", updated_at: c.ago(50) });
  msg(ent, 101, 1, "user", userText("What is blocking #1?"), { at: c.ago(56) });
  msg(ent, 102, 1, "assistant", answer("[[ticket:1]] waits on the CSP fix; [[ticket:2]] looks like the same report.", ["ticket:1", "ticket:2"]), { cites: [refView(1, "test-Login page is blank on Safari"), refView(2, "test-Blank login screen after the Safari update", "Triage", "todo")] });
  thread(ent, 2, { handle: "test-member", title: "test-Pinned: sprint plan", pinned: 1, updated_at: c.days(20) });
  msg(ent, 103, 2, "user", userText("Plan the hosting sprint"), { at: c.days(20) });
  msg(ent, 104, 2, "assistant", answer("Here is a plan for the hosting sprint."), { at: c.days(20) });
  thread(ent, 3, { handle: "test-member", title: "test-This week: webhook retries", updated_at: c.days(3) });
  msg(ent, 105, 3, "user", userText("Where are webhook retries?"), { at: c.days(3) });
  msg(ent, 106, 3, "assistant", answer("Half done: the queue table exists, the worker does not."), { at: c.days(3) });
  thread(ent, 4, { handle: "test-member", title: "test-<img src=x onerror=alert(1)> Résumé 🚀 日本語", updated_at: c.days(30) });
  msg(ent, 107, 4, "user", userText("<script>alert('test-xss')</script> **bold** 日本語 🚀"), { at: c.days(30) });
  msg(ent, 108, 4, "assistant", answer("Plain answer with <b>tags</b>, [a link](javascript:alert(1)) and `code`."), { at: c.days(30) });
  thread(ent, 5, { handle: "test-member", title: "", updated_at: c.ago(5), turn: 0 });
  thread(ent, 6, { handle: "test-member2", title: "test-Member Two's private thread", updated_at: c.ago(40) });
  msg(ent, 109, 6, "user", userText("test- a private question"), { at: c.ago(40) });
  thread(ent, 7, { handle: "test-member", title: "test-Panel thread about #1", origin: "panel", context_ref: "ticket:1", updated_at: c.ago(45) });
  thread(ent, 8, { handle: "test-admin", title: "test-Admin's thread with an update_plan card", updated_at: c.ago(35) });
  msg(ent, 110, 8, "user", userText("Update the plan narrative"), { at: c.ago(36) });
  msg(ent, 111, 8, "assistant", answer("Here is the change; confirm it below."), { at: c.ago(35) });
  const other = ORG["other-org"];
  thread(other, 1, { handle: "test-outsider", title: "test-Other org's thread", updated_at: c.ago(30) });
  const free = ORG["org-free"];
  thread(free, 1, { handle: "test-member", title: "test-Free org thread", updated_at: c.ago(20) });
  msg(free, 101, 1, "user", userText("What shipped this week?"), { at: c.ago(21) });
  msg(free, 102, 1, "assistant", answer("Two PRs merged."), { at: c.ago(20) });

  // Cards on thread 1 (turn 1, the answer 102). Ticket #1 is test-member's (the lane lets them move it).
  const t1 = ent.id;
  const card = (k, row) => s.push(insert("chat_actions", { id: cid(ent, k), org_id: t1, thread_id: cid(ent, row.threadK ?? 1), message_id: cid(ent, row.msgK ?? 102), turn: row.turn ?? 1, tool: row.tool, kind: row.kind, group_id: row.group ?? null, tool_use_id: `toolu_test_${k}`, args_json: row.args, preview_json: row.preview, state: row.state, result_json: row.result ?? null, undo_json: row.undo ?? null, created_at: c.ago(50), decided_at: ["proposed", "waiting"].includes(row.state) ? null : c.ago(49) }));
  const pv = (title, lines = []) => ({ title, lines, item: null });
  const t1At = c.days(19); // ticket #1's updated_at, as contentFor wrote it (days(20 - 1))
  card(201, { tool: "create_ticket", kind: "ticket", args: { title: "test-E2E ticket from Ask", body: "", category: "bug", priority: "normal", assignees: [] }, preview: pv("New ticket", [{ label: "Title", value: "test-E2E ticket from Ask" }]), state: "proposed" });
  card(202, { tool: "transition_ticket", kind: "move", args: { id: 1, to: "testing" }, preview: pv("Move #1 to Testing", [{ label: "Status", value: "In progress → Testing" }]), state: "proposed" });
  card(203, { tool: "create_ticket", kind: "ticket", group: "test-group-1", args: { title: "test-Grouped ticket A", body: "", category: "other", priority: "normal", assignees: [] }, preview: pv("New ticket", [{ label: "Title", value: "test-Grouped ticket A" }]), state: "proposed" });
  card(204, { tool: "create_ticket", kind: "ticket", group: "test-group-1", args: { title: "test-Grouped ticket B", body: "", category: "other", priority: "normal", assignees: [] }, preview: pv("New ticket", [{ label: "Title", value: "test-Grouped ticket B" }]), state: "proposed" });
  card(205, { tool: "send_handoff", kind: "handoff", args: { body: "test- Fix the connect test", recipient: "test-member2", context: { task: "test- Fix the connect test" } }, preview: pv("New handoff", [{ label: "To", value: "@test-member2" }]), state: "proposed" });
  card(206, { tool: "publish_doc", kind: "publish", args: { slug: "test-auth-sessions" }, preview: { ...pv("Publish test-Auth sessions v2"), canPublish: true }, state: "waiting" });
  card(207, { tool: "create_ticket", kind: "ticket", args: { title: "test-Expired card" }, preview: pv("New ticket"), state: "expired" });
  card(208, { tool: "create_ticket", kind: "ticket", turn: 0, args: { title: "test-Stale-turn card", body: "", category: "other", priority: "normal", assignees: [] }, preview: pv("New ticket"), state: "proposed" });
  card(209, { tool: "add_ticket_comment", kind: "other", args: { id: 1, body: "test- already confirmed" }, preview: pv("Comment on #1"), state: "confirmed", result: { ok: true } });
  card(210, { tool: "create_ticket", kind: "ticket", args: { title: "test-Cancelled card" }, preview: pv("New ticket"), state: "cancelled" });
  card(211, { tool: "transition_ticket", kind: "move", args: { id: 1, to: "in_progress" }, preview: pv("Move #1 to In progress"), state: "auto", result: { ok: true }, undo: { id: 1, to: "submitted", stamp: t1At } });
  card(212, { tool: "transition_ticket", kind: "move", args: { id: 4, to: "testing" }, preview: pv("Move #4 to Testing"), state: "auto", result: { ok: true }, undo: { id: 4, to: "submitted", stamp: "2000-01-01T00:00:00.000Z" } });
  card(213, { tool: "update_plan", kind: "sprint", threadK: 8, msgK: 111, args: { narrative: "**Now:** test- e2e.", sprints: [] }, preview: pv("Update the roadmap plan"), state: "waiting" });
  card(214, { tool: "transition_ticket", kind: "move", args: { id: 7, to: "in_progress" }, preview: pv("Move #7 to In progress"), state: "proposed" });
  fixture("ask", "ask-threads-member", "test-member's org-enterprise threads: today (#1), pinned 20 d (#2), this week (#3), earlier 30 d (#4, injection + unicode), untitled (#5), panel (#7)",
    [`SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = '${ent.id}' AND handle = 'test-member'`, 6]);
  fixture("ask", "ask-thread-other-person", `thread ${cid(ent, 6)} is test-member2's → 404 for test-member; thread ${cid(ent, 8)} is test-admin's`, [`SELECT COUNT(*) AS n FROM chat_threads WHERE id = ${cid(ent, 6)}`, 1]);
  fixture("ask", "ask-thread-other-org", `thread ${cid(other, 1)} is in other-org`, [`SELECT COUNT(*) AS n FROM chat_threads WHERE id = ${cid(other, 1)}`, 1]);
  fixture("ask", "ask-thread-injection", `thread ${cid(ent, 4)}: HTML / script / markdown / emoji in title, question and answer (search, export)`, [`SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ${cid(ent, 4)}`, 2]);
  fixture("ask", "ask-free-thread", `test-member's thread in org-free (${cid(free, 1)})`, [`SELECT COUNT(*) AS n FROM chat_threads WHERE id = ${cid(free, 1)}`, 1]);
  const cards = [
    ["ask-card-proposed-create-ticket", 201, "proposed create_ticket"], ["ask-card-proposed-transition", 202, "proposed transition_ticket #1 → testing (test-member is its assignee)"],
    ["ask-card-group", 203, `proposed group test-group-1 (${cid(ent, 203)} + ${cid(ent, 204)})`], ["ask-card-send-handoff", 205, "proposed send_handoff to test-member2"],
    ["ask-card-publish-doc", 206, "waiting publish_doc test-auth-sessions (staged v2)"], ["ask-card-expired", 207, "expired"], ["ask-card-stale-turn", 208, "proposed but turn 0 (thread at 1) → confirm expires it"],
    ["ask-card-confirmed", 209, "already confirmed"], ["ask-card-cancelled", 210, "cancelled"], ["ask-card-auto-undo", 211, "auto transition #1 with an undo whose stamp matches ticket #1 (undo works until #1 changes)"],
    ["ask-card-auto-changed", 212, "auto transition #4 with a stale stamp → undo 409 changed"], ["ask-card-update-plan", 213, "waiting update_plan on test-admin's thread"],
    ["ask-card-lane-refused", 214, "proposed transition of #7 (no assignee: test-member is not in its lane → confirm 200 with state failed)"],
  ];
  for (const [name, k, what] of cards) fixture("ask", name, `card ${cid(ent, k)}: ${what}`, [`SELECT COUNT(*) AS n FROM chat_actions WHERE id = ${cid(ent, k)}`, 1]);

  s.push(insert("person_ask_settings", { org_id: ent.id, handle: "test-member", instructions: "test- Answer briefly, in bullet points.", default_mode: "fast", updated_at: c.days(2) }));
  s.push(insert("person_ask_settings", { org_id: free.id, handle: "test-member", instructions: "", default_mode: "thinking", updated_at: c.days(2) }));
  fixture("ask", "ask-settings-member", "test-member in org-enterprise: instructions + default Fast", [`SELECT COUNT(*) AS n FROM person_ask_settings WHERE org_id = '${ent.id}'`, 1]);
  fixture("ask", "ask-settings-free-thinking", "test-member in org-free: a stored Thinking default the plan does not offer (reads as Smart)", [`SELECT COUNT(*) AS n FROM person_ask_settings WHERE org_id = '${free.id}' AND default_mode = 'thinking'`, 1]);
  for (const [ref, reason, n] of [["doc:test-auth-sessions", "source_wrong", 2], ["doc:test-auth-sessions", "out_of_date", 1], [`decision:${rid(ent, 2)}`, "source_wrong", 1]]) {
    for (let i = 0; i < n; i++) s.push(insert("ask_flags", { org_id: ent.id, item_ref: ref, reason, created_at: c.ago(100 + i) }));
  }
  fixture("ask", "ask-flags-review", "Flagged in Ask: the staged doc test-auth-sessions (2 × source_wrong, 1 × out_of_date) and the draft ADR", [`SELECT COUNT(*) AS n FROM ask_flags WHERE org_id = '${ent.id}'`, 4]);
}

function buildPhaseCTickets(c, s) {
  const sug = (id, o, row) => s.push(insert("ai_suggestions", { id, org_id: o.id, model: "jev-1.13.0", created_at: c.ago(45), state: "open", cites_json: [], ...row }));
  for (const [o, base] of [[ORG["org-enterprise"], 5100], [ORG["org-ai-off"], 5200], [ORG["org-free"], 5300]]) {
    sug(base + 1, o, { item_type: "ticket", item_ref: "2", kind: "ticket.category", value_json: JSON.stringify("bug"), confidence: 0.91, reason: "it says “the login screen is blank in Safari”", prompt_version: "jev-ticket-1" });
    sug(base + 2, o, { item_type: "ticket", item_ref: "2", kind: "ticket.priority", value_json: JSON.stringify("high"), confidence: 0.83, reason: "it says “Since this morning the login screen is blank”", prompt_version: "jev-ticket-1" });
    sug(base + 3, o, { item_type: "ticket", item_ref: "2", kind: "ticket.duplicate", value_json: { number: 1, label: "#1 test-Login page is blank on Safari" }, confidence: 0.94, reason: "both mention “login”, “blank” and “safari”", cites_json: [tc(o, 1)], prompt_version: "jev-ticket-1" });
  }
  const ent = ORG["org-enterprise"];
  sug(5111, ent, { item_type: "ticket", item_ref: "1", kind: "ticket.category", value_json: JSON.stringify("question"), confidence: 0.75, reason: "it says “CSP error”", prompt_version: "jev-ticket-1", state: "dismissed", decided_by: "test-member", decided_at: c.ago(20) });
  sug(5112, ent, { item_type: "ticket", item_ref: "1", kind: "ticket.priority", value_json: JSON.stringify("low"), confidence: 0.8, reason: "it says “after the update”", prompt_version: "jev-ticket-1", state: "accepted", decided_by: "test-admin", decided_at: c.ago(20) });
  sug(5113, ent, { item_type: "ticket", item_ref: "1", kind: "ticket.priority", value_json: JSON.stringify("normal"), confidence: 0.7, reason: "superseded by a later run", prompt_version: "jev-ticket-1", state: "superseded" });
  sug(5114, ent, { item_type: "ticket", item_ref: "5", kind: "ticket.category", value_json: JSON.stringify("request"), confidence: 0.8, reason: "it says “redirect change”", prompt_version: "jev-ticket-1" });
  sug(5115, ent, { item_type: "ticket", item_ref: "99", kind: "ticket.category", value_json: JSON.stringify("bug"), confidence: 0.8, reason: "it says “test- gone”", prompt_version: "jev-ticket-1" });
  sug(5116, ent, { item_type: "unplaced", item_ref: String(rid(ent, 3)), kind: "unplaced.destination", value_json: { type: "doc", section: "reference", near: "test-deploy-checklist", label: "reference, next to “test-Deploy checklist”" }, confidence: 0.7, reason: "it mentions “redirect rules”, like the doc “test-Deploy checklist” in reference", cites_json: [{ ref: "doc:test-deploy-checklist", label: "test-Deploy checklist", href: null }], prompt_version: "jev-place-1" });
  sug(5117, ent, { item_type: "proposal", item_ref: "doc:test-auth-sessions@2", kind: "review.risk", value_json: { risk: "decision", label: "Changes a decision" }, confidence: 0.82, reason: "it says “we move to bearer tokens for the web app”, against “cookie sessions”", cites_json: [{ ref: `adr:${rid(ent, 1)}`, label: "test-ADR: cookie sessions", href: null }], prompt_version: "jev-risk-1" });
  sug(5118, ent, { item_type: "proposal", item_ref: `adr:${rid(ent, 2)}`, kind: "review.risk", value_json: { risk: "contradicts", label: "Contradicts a doc" }, confidence: 0.77, reason: "it says “bearer tokens in the web app too”", cites_json: [{ ref: "doc:test-auth-sessions", label: "test-Auth sessions", href: null }], prompt_version: "jev-risk-1" });
  sug(5119, ent, { item_type: "proposal", item_ref: `adr:${rid(ent, 1)}`, kind: "review.risk", value_json: { risk: "process", label: "Changes a process" }, confidence: 0.7, reason: "left open on a ratified ADR", prompt_version: "jev-risk-1" });
  fixture("phase-c-tickets", "ticket-with-suggestions", "ticket #2 in org-enterprise (5101–5103), org-ai-off (5201–5203: hidden), org-free (5301–5303): category bug, priority high, duplicate of #1",
    ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id BETWEEN 5101 AND 5103 AND state = 'open'", 3]);
  fixture("phase-c-tickets", "ticket-suggestion-decided", "ticket #1: 5111 dismissed, 5112 accepted, 5113 superseded (none shows)", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id BETWEEN 5111 AND 5113", 3]);
  fixture("phase-c-tickets", "ticket-done-with-suggestion", "ticket #5 (done) with an open category suggestion 5114", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5114", 1]);
  fixture("phase-c-tickets", "suggestion-missing-ticket", "5115 names ticket #99, which does not exist (accept → the handler's refusal)", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5115", 1]);
  fixture("phase-c-tickets", "unplaced-with-suggestion", "5116: the doc-shaped Unplaced item → reference, next to test-Deploy checklist", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5116", 1]);
  fixture("phase-c-tickets", "review-with-risk", "5117 Changes a decision (staged doc), 5118 Contradicts a doc (draft ADR)", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id IN (5117, 5118)", 2]);
  fixture("phase-c-tickets", "adr-ratified-with-risk", "5119: an open risk left on the RATIFIED ADR", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id = 5119", 1]);
}

function buildPhaseCFeed(c, s) {
  for (const o of [ORG["org-enterprise"], ORG["org-ai-off"]]) {
    s.push(`UPDATE feed SET importance = 'breaking' WHERE org_id = '${o.id}' AND id = ${rid(o, 5)}`);
    s.push(`UPDATE feed SET importance = 'notable' WHERE org_id = '${o.id}' AND id = ${rid(o, 6)}`);
    s.push(`UPDATE feed SET importance = 'routine' WHERE org_id = '${o.id}' AND id = ${rid(o, 7)}`);
    s.push(`UPDATE pr_summaries SET importance = 'notable' WHERE org_id = '${o.id}' AND pr_number = 115`);
    s.push(`UPDATE pr_summaries SET importance = 'breaking' WHERE org_id = '${o.id}' AND pr_number = 114`);
  }
  const ent = ORG["org-enterprise"];
  fixture("phase-c-feed", "feed-importance-mixed", "org-enterprise feed: one breaking, one notable, one routine (no mark), one NULL (no mark)",
    [`SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ent.id}' AND importance IS NOT NULL`, 3]);
  fixture("phase-c-feed", "pr-importance", "PR 115 notable, PR 114 breaking (My Work's merged PRs, MCP)", [`SELECT COUNT(*) AS n FROM pr_summaries WHERE org_id = '${ent.id}' AND importance IS NOT NULL`, 2]);
  fixture("phase-c-feed", "feed-importance-ai-off", "the same ratings in org-ai-off", [`SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ORG["org-ai-off"].id}' AND importance IS NOT NULL`, 3]);
}

function buildPhaseDDigests(c, s) {
  // The reserved author (0061 inserts it, but the reset deletes every person before re-seeding its own).
  s.push(`INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('trov', 'Trov', 'moss', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`);
  const trovEntry = (o, k, { subject = "test-member", summary, body, artifacts, agoMin, session = true }) => {
    const id = rid(o, k);
    s.push(insert("feed", { org_id: o.id, id, author: "trov", summary, brief: summary.replace(/^(Shipped|Status): /, ""), body, artifacts, created_at: c.ago(agoMin), origin: "ai", model: "claude-haiku-5-5", subject }));
    if (session && typeof artifacts === "object") {
      s.push(insert("ai_sessions", { org_id: o.id, repo: repoOf(o), actor_login: subject ?? "test-ghost", started_at: c.ago(agoMin + 90), ended_at: c.ago(agoMin + 45), status: "done", reason: null, shas: artifacts.commits, prs: (artifacts.prs ?? []).map(Number), feed_id: id, model: "claude-haiku-5-5", prompt_version: "digest-1", created_at: c.ago(agoMin) }));
    }
  };
  const foot = (o, prs, commits) => `\n\n_Written by Trov from ${prs} pull request${prs === 1 ? "" : "s"} and ${commits} commit${commits === 1 ? "" : "s"} in ${repoOf(o)}. Not reviewed by a person._`;
  for (const o of [ORG["org-enterprise"], ORG["org-ai-off"]]) {
    trovEntry(o, 20, { summary: "Shipped: test- the Safari login fix", body: "**What** The login page loads on Safari again.\n\n**Why** A CSP rule blocked the frame.\n\n**Impact** Safari users can sign in." + foot(o, 1, 2), artifacts: { prs: ["115"], commits: ["65b9f1f", "a1c04e2"], issues: [] }, agoMin: 30 });
    trovEntry(o, 21, { subject: null, summary: "Status: test- webhook retries in progress", body: "**State** The queue table exists.\n\n**Next** The worker." + foot(o, 0, 3), artifacts: { prs: [], commits: ["b2c3d4e", "c3d4e5f", "d4e5f60"], issues: [] }, agoMin: 120 });
  }
  const ent = ORG["org-enterprise"];
  trovEntry(ent, 22, { summary: "Shipped: test- search ranking (no session row: sources unlinked)", body: "**What** Ranking." + foot(ent, 1, 1), artifacts: { prs: ["113"], commits: ["e5f6071"], issues: [] }, agoMin: 240, session: false });
  trovEntry(ent, 23, { summary: "Shipped: test- malformed artifacts (no sources line)", body: "**What** Something." + foot(ent, 1, 0), artifacts: raw("'not json'"), agoMin: 300, session: false });
  trovEntry(ent, 24, { summary: "Shipped: test- five sources (3 shown, +2 more)", body: "**What** Many." + foot(ent, 2, 3), artifacts: { prs: ["110", "111"], commits: ["1111111", "2222222", "3333333"], issues: [] }, agoMin: 360 });
  s.push(insert("ai_feedback", { org_id: ent.id, handle: "test-member2", item_type: "feed", item_ref: String(rid(ent, 20)), kind: "digest.session", model: "claude-haiku-5-5", prompt_version: "digest-1", created_at: c.ago(10) }));
  s.push(insert("ai_sessions", { org_id: ent.id, repo: repoOf(ent), actor_login: "test-member", started_at: c.ago(900), ended_at: c.ago(855), status: "skipped", reason: "agent_recorded", shas: ["aaaaaaa"], prs: [], feed_id: null, model: null, prompt_version: null, created_at: c.ago(850) }));
  s.push(insert("ai_sessions", { org_id: ent.id, repo: repoOf(ent), actor_login: "test-member", started_at: c.ago(1900), ended_at: c.ago(1855), status: "skipped", reason: "not_substantive", shas: ["bbbbbbb", "ccccccc"], prs: [], feed_id: null, model: null, prompt_version: null, created_at: c.ago(1850) }));
  fixture("phase-d-digests", "trov-entry-linked", "a Trov Shipped entry for test-member with an ai_sessions row (sources link to GitHub)", [`SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ent.id}' AND origin = 'ai'`, 5]);
  fixture("phase-d-digests", "trov-entry-no-subject", "a Trov Status entry whose login maps to no member ('written by Trov')", [`SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ent.id}' AND origin = 'ai' AND subject IS NULL`, 1]);
  fixture("phase-d-digests", "trov-entry-unlinked / trov-entry-bad-artifacts / trov-entry-many-cites", "no session row (plain-text sources); artifacts not JSON (no From line); 5 sources (3 + 2 more)", [`SELECT COUNT(*) AS n FROM feed WHERE id IN (${rid(ent, 22)}, ${rid(ent, 23)}, ${rid(ent, 24)})`, 3]);
  fixture("phase-d-digests", "trov-entry-wrong-pressed", "test-member2 pressed Wrong? on the Safari entry (hidden for them only)", [`SELECT COUNT(*) AS n FROM ai_feedback WHERE org_id = '${ent.id}' AND item_type = 'feed'`, 1]);
  fixture("phase-d-digests", "trov-entries-ai-off", "the same two Trov entries in org-ai-off", [`SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ORG["org-ai-off"].id}' AND origin = 'ai'`, 2]);
  fixture("phase-d-digests", "ai-sessions-skipped", "two skipped bursts: agent_recorded and not_substantive", [`SELECT COUNT(*) AS n FROM ai_sessions WHERE org_id = '${ent.id}' AND status = 'skipped'`, 2]);

  const state = (o, version, { at, json, events = 6 }) => s.push(insert("repo_state", { org_id: o.id, repo: repoOf(o), version, generated_at: at, basis_until: at, model: "claude-haiku-5-5", prompt_version: "state-1", event_count: events, state_json: json }));
  const good = (o) => ({
    headline: "test- Safari login is fixed; webhook retries are half done; main is green.",
    shipped: [{ text: "test- The Safari login fix shipped.", cites: [pc(o, 115)] }, { text: "test- Search ranking shipped.", cites: [pc(o, 113)] }],
    inFlight: [{ text: "test- Webhook retries: the worker is next.", cites: [{ ref: `feed:${rid(o, 8)}`, label: "test- webhook retries half done", href: "#feed" }] }],
    attention: [{ text: "test- CI run 4812 failed on main.", cites: [{ ref: "run:4812", label: "CI run 4812", href: null }] }],
  });
  for (const o of [ent, ORG["org-ai-off"], ORG["org-at-cap"], ORG["org-free"]]) {
    state(o, 1, { at: c.days(2), json: { ...good(o), headline: "test- an older state (version 1)" } });
    state(o, 2, { at: c.ago(90), json: good(o), events: o === ORG["org-free"] ? null : 6 });
  }
  state(ORG["org-pro-5-seats"], 1, { at: c.ago(60), json: { headline: "test- malformed", shipped: {}, attention: [] } });
  state(ORG["org-pro-gifted-3-members"], 1, { at: c.days(30), json: good(ORG["org-pro-gifted-3-members"]) });
  s.push(insert("ai_feedback", { org_id: ent.id, handle: "test-member2", item_type: "repo_state", item_ref: `${repoOf(ent)}@${c.ago(90)}`, kind: "repo.state", model: "claude-haiku-5-5", prompt_version: "state-1", created_at: c.ago(5) }));
  fixture("phase-d-digests", "repo-state-ready", "org-enterprise: versions 1 and 2 (the newer shows): headline, 2 shipped, 1 in flight, 1 attention", [`SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${ent.id}'`, 2]);
  fixture("phase-d-digests", "repo-state-capped", "org-at-cap: a stored state while ai_runs are spent", [`SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${ORG["org-at-cap"].id}'`, 2]);
  fixture("phase-d-digests", "repo-state-no-event-count", "org-free: the newest state has event_count NULL (no 'from N events')", [`SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${ORG["org-free"].id}' AND event_count IS NULL`, 1]);
  fixture("phase-d-digests", "repo-state-malformed", "org-pro: state_json with shipped as an object (section absent)", [`SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${ORG["org-pro-5-seats"].id}'`, 1]);
  fixture("phase-d-digests", "repo-state-stale", "org-pro-gifted: the only state is 30 days old", [`SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${ORG["org-pro-gifted-3-members"].id}'`, 1]);
  fixture("phase-d-digests", "repo-state-wrong-pressed", "test-member2 pressed Wrong? on org-enterprise's newest state", [`SELECT COUNT(*) AS n FROM ai_feedback WHERE org_id = '${ent.id}' AND item_type = 'repo_state'`, 1]);
}

function buildPhaseDBrief(c, s) {
  const ent = ORG["org-enterprise"];
  const brief = (o, handle, version, { at, model = "claude-haiku-5-5", json }) => s.push(insert("person_brief", { org_id: o.id, handle, version, generated_at: at, model, prompt_version: "brief.1", input_hash: `test-${version}`, brief_json: json }));
  const full = (o) => ({
    now: { text: "test- You have the Safari login fix in testing, and #3 is waiting on you.", cites: [tc(o, 1), tc(o, 3)] },
    recently: { text: "test- You shipped the Safari login fix and the search ranking.", cites: [pc(o, 115), pc(o, 113)] },
    next: { items: [
      { ref: "run:4812", kind: "failing", title: "test- CI run 4812 is failing on your pull request #115", why: "It is failing on your pull request #115.", cites: [{ ref: "run:4812", label: "CI run 4812", href: null }] },
      { ref: "ticket:4", kind: "due", title: "test-Résumé upload fails for 日本語 names 🚀", why: "Its sprint, test-Sprint Hosting, is due in 4 days.", cites: [tc(o, 4)] },
      { ref: "handoff:1", kind: "handoff", title: "test- Finish the deploy checklist for the Netlify preview", why: "@test-member2 left it for you.", cites: [hc(1)] },
      { ref: "handoff:4", kind: "handoff", title: "test- Fix it, ok", why: "@test-member2 left it for you.", cites: [hc(4)] },
      { ref: "ticket:3", kind: "ticket", title: "test-<img src=x onerror=alert(1)> <b>bold</b> **markdown** title", why: "It is assigned to you.", cites: [tc(o, 3)] },
    ] },
  });
  for (let v = 1; v <= 6; v++) brief(ent, "test-member", v, { at: c.ago(12 + (6 - v) * 600), json: v === 6 ? full(ent) : { ...full(ent), now: { text: `test- an older brief (version ${v})`, cites: [tc(ent, 1)] } } });
  brief(ent, "test-admin", 1, { at: c.ago(30), model: null, json: { now: null, recently: null, next: { items: [] } } });
  brief(ent, "test-member2", 1, { at: c.ago(30), json: { now: "not an object", recently: null } });
  brief(ent, "test-owner", 1, { at: c.ago(25), json: full(ent) });
  s.push(insert("ai_feedback", { org_id: ent.id, handle: "test-owner", item_type: "brief", item_ref: c.ago(25), kind: "brief.person", model: "claude-haiku-5-5", prompt_version: "brief.1", created_at: c.ago(5) }));
  brief(ORG["org-at-cap"], "test-member", 1, { at: c.days(9), json: full(ORG["org-at-cap"]) });
  brief(ORG["org-ai-off"], "test-member", 1, { at: c.ago(30), json: full(ORG["org-ai-off"]) });
  const free = ORG["org-free"];
  brief(free, "test-member", 1, { at: c.ago(40), json: { now: null, recently: { text: "test- You shipped the Safari login fix.", cites: [pc(free, 113)] }, next: { items: [{ ref: "ticket:1", kind: "ticket", title: "test-Login page is blank on Safari", why: "You have it in progress.", cites: [tc(free, 1)] }] } } });
  brief(ORG["org-pro-5-seats"], "test-member", 1, { at: c.days(20), json: full(ORG["org-pro-5-seats"]) });
  s.push(`UPDATE memberships SET mywork_opened_at = '${c.ago(5)}' WHERE org_id LIKE 'org_test_%' AND user_id IN ('test-member', 'test-admin', 'test-owner')`);
  s.push(`UPDATE memberships SET mywork_opened_at = '${c.days(15)}' WHERE org_id = '${ent.id}' AND user_id = 'test-noemail'`);
  fixture("phase-d-brief", "brief-ready-5-next", "test-member in org-enterprise: 6 versions (the newest shows): Now, Recently, 5 Next (failing, due, 2 handoffs, an injection title)", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ent.id}' AND handle = 'test-member'`, 6]);
  fixture("phase-d-brief", "brief-empty", "test-admin in org-enterprise: an empty brief (model NULL)", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ent.id}' AND handle = 'test-admin' AND model IS NULL`, 1]);
  fixture("phase-d-brief", "brief-malformed", "test-member2 in org-enterprise: brief_json fails the schema (no tile)", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ent.id}' AND handle = 'test-member2'`, 1]);
  fixture("phase-d-brief", "brief-wrong-pressed", "test-owner pressed Wrong? on their brief (no tile for them)", [`SELECT COUNT(*) AS n FROM ai_feedback WHERE org_id = '${ent.id}' AND item_type = 'brief'`, 1]);
  fixture("phase-d-brief", "brief-capped", "test-member in org-at-cap: a 9-day-old brief while ai_runs are spent", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ORG["org-at-cap"].id}'`, 1]);
  fixture("phase-d-brief", "brief-ai-off", "test-member in org-ai-off: a stored brief behind the switch", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ORG["org-ai-off"].id}'`, 1]);
  fixture("phase-d-brief", "brief-one-next", "test-member in org-free: no Now, one Recently, one Next", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${free.id}'`, 1]);
  fixture("phase-d-brief", "brief-stale", "test-member in org-pro: a 20-day-old brief", [`SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ORG["org-pro-5-seats"].id}'`, 1]);
  fixture("phase-d-brief", "brief-not-wanted", "test-noemail: no address and My Work last opened 15 days ago (the pass writes no brief)", [`SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'test-noemail' AND mywork_opened_at IS NOT NULL`, 1]);
}

function buildPhaseDThemes(c, s) {
  const themeId = (o, name) => raw(`(SELECT id FROM repo_themes WHERE org_id = '${o.id}' AND name = ${q(name)} AND status <> 'removed')`);
  const theme = (o, i, name, status, color, seeds = [], extra = {}) => s.push(insert("repo_themes", { org_id: o.id, repo: repoOf(o), name, description: `test- ${name} work`, color_key: color, status, position: i, seed_prs: seeds, model: "claude-haiku-5-5", prompt_version: "propose-1", created_by: "trov", created_at: c.days(status === "proposed" ? 2 : 60), decided_by: status === "proposed" ? null : "test-owner", decided_at: status === "proposed" ? null : c.days(59), ...extra }));
  const pick = (o, num, name, person = null) => s.push(insert("pr_themes", { org_id: o.id, repo: repoOf(o), pr_number: num, theme_id: themeId(o, name), source: person ? "person" : "ai", confidence: person ? null : 0.92, model: person ? null : "jev-1.13.0", prompt_version: person ? null : "pr-theme-1", set_by: person, set_at: c.days(1) }, "INSERT OR REPLACE"));
  const proposal = (o, id, name, seeds) => s.push(insert("ai_suggestions", { id, org_id: o.id, item_type: "theme", item_ref: raw(`${q(repoOf(o) + "#")} || (SELECT id FROM repo_themes WHERE org_id = '${o.id}' AND name = ${q(name)} AND status <> 'removed')`), kind: "themes.propose", value_json: { name, description: `test- ${name} work` }, confidence: null, reason: `test- ${name} work`, cites_json: seeds.slice(0, 3).map((n) => pc(o, n)), model: "claude-haiku-5-5", prompt_version: "propose-1", state: "open", created_at: c.days(2) }));
  const ACTIVE = [["test-Hosting", "slate"], ["test-Search", "fern"], ["test-Billing", "ochre"], ["test-Auth", "sky"]];
  for (const o of [ORG["org-enterprise"], ORG["org-ai-off"]]) {
    ACTIVE.forEach(([name, color], i) => theme(o, i, name, "active", color));
    theme(o, 4, "test-Emails", "proposed", "plum", [100, 104, 108]);
    proposal(o, o === ORG["org-enterprise"] ? 5401 : 5402, "test-Emails", [100, 104, 108]);
    for (let i = 0; i < 16; i++) if (![0, 4, 8].includes(i)) pick(o, 100 + i, ACTIVE[i % 4][0]);
    pick(o, 101, "test-Billing", "test-owner");
    s.push(insert("repo_theme_captions", { org_id: o.id, repo: repoOf(o), range: "8w", caption: "Most of the work went to test-Hosting and test-Search; lately it moved to test-Auth.", theme_ids: raw(`json_array((SELECT id FROM repo_themes WHERE org_id = '${o.id}' AND name = 'test-Hosting'), (SELECT id FROM repo_themes WHERE org_id = '${o.id}' AND name = 'test-Search'), (SELECT id FROM repo_themes WHERE org_id = '${o.id}' AND name = 'test-Auth'))`), basis_hash: "test", model: "claude-haiku-5-5", prompt_version: "caption-1", generated_at: c.ago(60) }));
  }
  const pro = ORG["org-pro-5-seats"];
  theme(pro, 0, "test-Proposed only", "proposed", "rose", [100, 101, 102]);
  proposal(pro, 5403, "test-Proposed only", [100, 101, 102]);
  const free = ORG["org-free"];
  ["A", "B", "C", "D", "E", "F", "G", "H"].forEach((x, i) => theme(free, i, `test-Theme ${x}`, "active", ["slate", "fern", "ochre", "sky", "plum", "rose", "rust", "moss"][i]));
  for (let i = 0; i < 14; i++) pick(free, 100 + i, `test-Theme ${"ABCDEFGH"[i % 8]}`);
  const gift = ORG["org-pro-gifted-3-members"];
  theme(gift, 0, "test-Bad seeds", "proposed", "zzz", raw("'not json'"));
  proposal(gift, 5404, "test-Bad seeds", []);
  theme(gift, 1, "test-Live", "active", "sky");
  theme(gift, 2, "test-Gone", "removed", "rust");
  for (let i = 0; i < 14; i++) pick(gift, 100 + i, "test-Live");
  s.push(insert("repo_theme_captions", { org_id: gift.id, repo: repoOf(gift), range: "8w", caption: "Most of the work went to test-Gone, which was removed since.", theme_ids: raw(`json_array((SELECT id FROM repo_themes WHERE org_id = '${gift.id}' AND name = 'test-Gone'))`), basis_hash: "test", model: "claude-haiku-5-5", prompt_version: "caption-1", generated_at: c.ago(60) }));
  const ent = ORG["org-enterprise"];
  fixture("phase-d-themes", "themes-active-and-proposed", "org-enterprise: 4 active themes, 1 proposed (test-Emails, open suggestion 5401), a caption; PR 101 picked by a person", [`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = '${ent.id}'`, 5]);
  fixture("phase-d-themes", "theme-person-pick", "PR 101 in org-enterprise: source person (the AI never overwrites it)", [`SELECT COUNT(*) AS n FROM pr_themes WHERE org_id = '${ent.id}' AND source = 'person'`, 1]);
  fixture("phase-d-themes", "themes-proposed-only", "org-pro: one proposed theme with open suggestion 5403, nothing active", [`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = '${pro.id}' AND status = 'proposed'`, 1]);
  fixture("phase-d-themes", "themes-at-8", "org-free: 8 active themes (the cap: no room for a proposal)", [`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = '${free.id}' AND status = 'active'`, 8]);
  fixture("phase-d-themes", "themes-malformed", "org-pro-gifted: a proposed theme with seed_prs 'not json' and color 'zzz'; a removed theme; a caption naming only the removed theme (hidden)", [`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = '${gift.id}'`, 3]);
  fixture("phase-d-themes", "themes-ai-off", "the same themes in org-ai-off (field absent)", [`SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = '${ORG["org-ai-off"].id}'`, 5]);
}

function buildPhaseDRoadmap(c, s) {
  const insight = (o, kind, key, version, at, json) => s.push(insert("org_insights", { org_id: o.id, kind, key, version, generated_at: at, model: "claude-haiku-5-5", prompt_version: kind === "sprint_note" ? "note-1" : "drift-1", json }));
  const drift = (o) => ({ text: "test- The last two weeks went mostly to test-Search, which is in no sprint.", cites: [{ ref: "theme:search", label: "test-Search", href: "#repo/planning" }], windowDays: 14, shares: [{ themeId: "search", theme: "test-Search", pct: 48, inSprint: false }, { themeId: "hosting", theme: "test-Hosting", pct: 32, inSprint: true }, { themeId: "auth", theme: "test-Auth", pct: 20, inSprint: false }] });
  for (const o of [ORG["org-enterprise"], ORG["org-ai-off"]]) {
    insight(o, "sprint_note", String(sid(o, 1)), 1, c.ago(300), { text: "test- #1 is in progress and #2 has no assignee; #5 closed this week.", cites: [tc(o, 1), tc(o, 2), tc(o, 5)] });
    insight(o, "sprint_note", String(sid(o, 3)), 1, c.ago(300), { text: "test- a note on a DONE sprint (not drawn).", cites: [tc(o, 6)] });
    insight(o, "plan_drift", "", 1, c.ago(240), drift(o));
  }
  const gift = ORG["org-pro-gifted-3-members"];
  insight(gift, "sprint_note", String(sid(gift, 1)), 1, c.ago(300), { text: "test- no cites (not drawn)", cites: [] });
  insight(ORG["org-pro-5-seats"], "plan_drift", "", 1, c.days(15), drift(ORG["org-pro-5-seats"]));
  const ent = ORG["org-enterprise"];
  const pro = ORG["org-pro-5-seats"];
  s.push(insert("ai_suggestions", { id: 5501, org_id: ent.id, item_type: "roadmap", item_ref: "org", kind: "plan_narrative", value_json: { narrative: "**Now:** test- the Safari fix and webhook retries. **Next:** test- search ranking. **Later:** test- billing." }, confidence: null, reason: "test- the narrative predates the active sprint.", cites_json: [{ ref: `sprint:${sid(ent, 1)}`, label: "test-Sprint Hosting", href: `#sprints/${sid(ent, 1)}` }], model: "claude-haiku-5-5", prompt_version: "narrative-1", state: "open", created_at: c.ago(170) }));
  s.push(insert("ai_suggestions", { id: 5502, org_id: pro.id, item_type: "roadmap", item_ref: "org", kind: "sprint_draft", value_json: { sprints: [{ name: "test-Draft: Exports", goal: "test- CSV and access.", tickets: [7, 8] }, { name: "test-Draft: Hardening", goal: "test- Rate limits and retries.", tickets: [9, 12] }] }, confidence: null, reason: "test- these open tickets sit outside every sprint.", cites_json: [tc(pro, 7), tc(pro, 8), tc(pro, 9)], model: "claude-haiku-5-5", prompt_version: "draft-1", state: "open", created_at: c.ago(180) }));
  s.push(insert("ai_suggestions", { id: 5503, org_id: pro.id, item_type: "roadmap", item_ref: "org", kind: "sprint_draft", value_json: { sprints: "not a list" }, confidence: null, reason: "test- a value that does not parse (card skipped)", cites_json: [], model: "claude-haiku-5-5", prompt_version: "draft-1", state: "open", created_at: c.ago(190) }));
  s.push(insert("ai_suggestions", { id: 5504, org_id: ORG["org-ai-off"].id, item_type: "roadmap", item_ref: "org", kind: "plan_narrative", value_json: { narrative: "test- hidden behind the switch" }, confidence: null, reason: "test- switch off", cites_json: [], model: "claude-haiku-5-5", prompt_version: "narrative-1", state: "open", created_at: c.ago(170) }));
  // Doc drift: Trov's own staged, low-confidence proposal through the gate (the trov person comes from 0061 / the digests section).
  s.push(`INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('trov', 'Trov', 'moss', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`);
  s.push(insert("doc_versions", { org_id: ent.id, slug: "test-webhook-retries", version: 2, body: "# Webhook retries\n\nGitHub redelivers a failed webhook delivery once. Our retry queue table exists; the worker is next.", summary: "Trov: the retry queue table exists now. From feed entries “test- webhook retries half done”. Low confidence: check it against them before promoting.", status: "staged", confidence: "low", created_at: c.ago(600), created_by: "trov", change_kind: "edit", base_version: 1, low_confidence: 1 }));
  fixture("phase-d-roadmap", "sprint-note / plan-drift", "org-enterprise: a note on the active sprint, one on a done sprint (not drawn), a drift line with 3 shares", [`SELECT COUNT(*) AS n FROM org_insights WHERE org_id = '${ent.id}'`, 3]);
  fixture("phase-d-roadmap", "sprint-note-malformed", "org-pro-gifted: a note with no cites (not drawn)", [`SELECT COUNT(*) AS n FROM org_insights WHERE org_id = '${gift.id}'`, 1]);
  fixture("phase-d-roadmap", "plan-drift-stale", "org-pro: a drift written 15 days ago (past 14: not drawn)", [`SELECT COUNT(*) AS n FROM org_insights WHERE org_id = '${pro.id}'`, 1]);
  fixture("phase-d-roadmap", "roadmap-suggestions", "5501 narrative (org-enterprise); 5502 sprint draft, 5503 unparseable draft (org-pro, 8 backlog tickets, no active sprint)", ["SELECT COUNT(*) AS n FROM ai_suggestions WHERE id BETWEEN 5501 AND 5503", 3]);
  fixture("phase-d-roadmap", "roadmap-ai-off", "org-ai-off: notes, drift and a narrative suggestion behind the switch", [`SELECT COUNT(*) AS n FROM org_insights WHERE org_id = '${ORG["org-ai-off"].id}'`, 3]);
  fixture("phase-d-roadmap", "doc-drift-proposal", "test-webhook-retries v2: staged, low confidence, by trov (Review)", [`SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = '${ent.id}' AND created_by = 'trov'`, 1]);
}

/** ISO-8601 week id (`YYYY-Www`) of a UTC date — the same rule as src/notifications/window.ts `isoWeekId` (the weekly
 *  run uses the org's LOCAL send date; at 8:00 New York on a Monday that is the same week). */
export function isoWeekId(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function buildPhaseE(c, s) {
  const ent = ORG["org-enterprise"];
  const free = ORG["org-free"];
  // "Only when something needs me" (no row = OFF): test-member2 (no valid brief → nothing needs them → skipped) and
  // test-member in org-free (a brief with one Next item → sent). test-member in org-enterprise has no row (every digest).
  s.push(insert("notification_person_prefs", { org_id: ent.id, user_id: "test-member2", only_when_needed: 1, updated_at: c.days(2) }));
  s.push(insert("notification_person_prefs", { org_id: free.id, user_id: "test-member", only_when_needed: 1, updated_at: c.days(2) }));
  s.push(insert("notification_person_prefs", { org_id: ent.id, user_id: "test-admin", only_when_needed: 0, updated_at: c.days(2) }));
  fixture("phase-e-emails", "notify-only-when-needed-skip", "test-member2 in org-enterprise: the option ON and no valid brief (its brief_json fails the schema) → the digest is skipped unless a notable/breaking item touched their work",
    [`SELECT COUNT(*) AS n FROM notification_person_prefs WHERE org_id = '${ent.id}' AND user_id = 'test-member2' AND only_when_needed = 1`, 1]);
  fixture("phase-e-emails", "notify-only-when-needed-send", "test-member in org-free: the option ON and a brief with one Next item → sent",
    [`SELECT COUNT(*) AS n FROM notification_person_prefs WHERE org_id = '${free.id}' AND only_when_needed = 1`, 1]);
  fixture("phase-e-emails", "notify-only-when-needed-off-row", "test-admin in org-enterprise: an explicit OFF row (same as no row)",
    [`SELECT COUNT(*) AS n FROM notification_person_prefs WHERE org_id = '${ent.id}' AND user_id = 'test-admin' AND only_when_needed = 0`, 1]);

  // The weekly "This week": this week's highlights (3, cited), last week's (1), one behind the AI switch, one malformed.
  const thisWeek = isoWeekId(new Date(c.iso));
  const lastWeek = isoWeekId(new Date(c.days(7)));
  const hl = (o, week_id, json, at = c.days(1)) => s.push(insert("digest_highlights", { org_id: o.id, week_id, generated_at: at, model: "claude-haiku-5-5", prompt_version: "week.1", highlights_json: json }));
  const three = (o) => [
    { text: "test- The Safari login fix shipped and closed #1's report.", cites: [pc(o, 115), tc(o, 1)] },
    { text: "test- Webhook retries are half done: the queue table exists.", cites: [{ ref: `feed:${rid(o, 8)}`, label: "test- webhook retries half done", href: "#feed" }] },
    { text: "test- A draft ADR proposes bearer tokens for the web app.", cites: [{ ref: `adr:${rid(o, 2)}`, label: "test-ADR draft: bearer tokens", href: null }] },
  ];
  hl(ent, thisWeek, three(ent));
  hl(ent, lastWeek, three(ent).slice(0, 1), c.days(8));
  hl(ORG["org-ai-off"], thisWeek, three(ORG["org-ai-off"]));
  hl(ORG["org-pro-5-seats"], thisWeek, [{ text: "", cites: [] }]);
  fixture("phase-e-emails", "week-highlights", `org-enterprise: 3 cited highlights for ${thisWeek} and 1 for ${lastWeek}`, [`SELECT COUNT(*) AS n FROM digest_highlights WHERE org_id = '${ent.id}'`, 2]);
  fixture("phase-e-emails", "week-highlights-ai-off", "org-ai-off: highlights stored, the switch is off (not shown)", [`SELECT COUNT(*) AS n FROM digest_highlights WHERE org_id = '${ORG["org-ai-off"].id}'`, 1]);
  fixture("phase-e-emails", "week-highlights-malformed", "org-pro: a row that fails its schema (an empty line: not shown)", [`SELECT COUNT(*) AS n FROM digest_highlights WHERE org_id = '${ORG["org-pro-5-seats"].id}'`, 1]);
  fixture("phase-e-emails", "week-highlights-none", "org-free: no highlights row (the weekly shows the numbers line only)", [`SELECT COUNT(*) AS n FROM orgs WHERE id = '${free.id}'`, 1]);
}

/** Trov's State on the repository #186's repo-setups seed fills with RepoFacts (sapling-live ≈ scenario A: a Worker and
 *  a Service, Staging + Production, a failed Production deploy). Needs the dev seed (org_saplinglearn); the RepoFacts
 *  rows themselves come from `node scripts/seed/repo-setups.mjs`, run AFTER this seed (default local state only). */
function buildRepoFacts(c, s, { base }) {
  if (!base) return;
  const SAP = "org_saplinglearn";
  const repo = "SaplingLearn/sapling";
  const json = {
    headline: "test- Production backend's last deploy failed; Staging is ahead of Production by one change.",
    shipped: [{ text: "test- The redirect fix reached Staging.", cites: [{ ref: "pr:162", label: "#162", href: `https://github.com/${repo}/pull/162` }] }],
    inFlight: [{ text: "test- Pull request #158 is in review.", cites: [{ ref: "pr:158", label: "#158", href: `https://github.com/${repo}/pull/158` }] }],
    attention: [{ text: "test- The Production backend deploy failed.", cites: [{ ref: "deploy:production/backend", label: "Production backend", href: null }] }],
  };
  s.push(`DELETE FROM repo_state WHERE org_id = '${SAP}' AND repo = '${repo}'`);
  s.push(insert("repo_state", { org_id: SAP, repo, version: 1, generated_at: c.ago(40), basis_until: c.ago(40), model: "claude-haiku-5-5", prompt_version: "state-1", event_count: 9, state_json: json }));
  fixture("repo-facts", "repo-state-over-repofacts", "org_saplinglearn / SaplingLearn/sapling: a State whose attention line cites a deploy by its PART LABEL (\"Production backend\"); run scripts/seed/repo-setups.mjs after for the Overview's RepoFacts (scenario A shape: R6 environment cards)",
    [`SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${SAP}'`, 1]);
}

const BUILDERS = { core: buildCore, ask: buildAsk, "phase-c-tickets": buildPhaseCTickets, "phase-c-feed": buildPhaseCFeed, "phase-d-digests": buildPhaseDDigests, "phase-d-brief": buildPhaseDBrief, "phase-d-themes": buildPhaseDThemes, "phase-d-roadmap": buildPhaseDRoadmap, "phase-e-emails": buildPhaseE, "repo-facts": buildRepoFacts };

/** Every fixture of every section, built against a fixed clock (for --list and the test). */
export function allFixtures(now = new Date()) {
  FIXTURES.length = 0;
  const c = makeClock(now);
  for (const sec of SECTIONS) BUILDERS[sec.id](c, [], { base: true });
  return [...FIXTURES];
}

/**
 * The whole seed for a database with `schema`: the canonical reset (and the dev seed unless `base` is false), then
 * every section the schema can take. Returns the statements, which sections ran or were skipped (and why), and the
 * fixtures of the sections that ran.
 */
export function serverAiE2eStatements(schema, { now = new Date(), base = true, fx = null } = {}) {
  const c = makeClock(now);
  const statements = [];
  // Rows of a table the reset does not know (a branch that forgot its reset line) would block deleting the test orgs:
  // clear the test orgs' rows from every such table first, and say so.
  const resetText = RESET_STATEMENTS.join("\n");
  const unreset = [...schema.entries()].filter(([t, cols]) => cols.has("org_id") && !/_fts($|_)/.test(t) && !new RegExp(`\\b${t}\\b`).test(resetText)).map(([t]) => t);
  for (const t of unreset) statements.push(`DELETE FROM ${t} WHERE org_id LIKE 'org_test_%'`);
  // The dev base's roadmap is dated against the clock (team-rich.mjs `datedRoadmap`): its June sprints would otherwise
  // read months overdue on every screen and in every brief.
  statements.push(...(base && fx ? buildSeedStatements(fx.roadmap ? { ...fx, roadmap: datedRoadmap(fx.roadmap, now) } : fx) : RESET_STATEMENTS));
  const sections = [];
  const fixtures = [];
  for (const sec of SECTIONS) {
    const missing = missingFrom(schema, sec.needs);
    if (missing) {
      sections.push({ ...sec, ran: false, missing });
      continue;
    }
    FIXTURES.length = 0;
    const out = [];
    BUILDERS[sec.id](c, out, { base: base && fx !== null });
    statements.push(...out);
    fixtures.push(...FIXTURES);
    sections.push({ ...sec, ran: true, missing: null, count: out.length });
  }
  return { statements, sections, fixtures, unreset };
}

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────
function wranglerArgs(argv) {
  const i = argv.indexOf("--persist-to");
  return ["d1", "execute", "DB", "--local", ...(i >= 0 && argv[i + 1] ? ["--persist-to", argv[i + 1]] : [])];
}
const QUIET = () => ({ ...process.env, npm_config_loglevel: "error" });
function d1Json({ execFileSync }, argv, sql) {
  const out = execFileSync("npx", ["wrangler", ...wranglerArgs(argv), "--json", `--command=${sql}`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024, env: QUIET() });
  return JSON.parse(out)[0]?.results ?? [];
}

async function main() {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cp = { execFileSync };
  const argv = process.argv.slice(2);
  if (targetsRemote(argv)) {
    console.error("server-ai-e2e: refusing --remote. This seed only ever targets LOCAL D1.");
    process.exit(1);
  }
  if (argv.includes("--list")) {
    for (const sec of SECTIONS) {
      console.log(`\n[${sec.id}] ${sec.title}\n  needs ${sec.migration} (${sec.branch})`);
      for (const f of allFixtures().filter((x) => x.section === sec.id)) console.log(`  - ${f.name}: ${f.what}`);
    }
    return;
  }
  const dir = fileURLToPath(new URL("../../fixtures/dev/", import.meta.url));
  const load = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const fx = argv.includes("--no-base") ? null : {
    docs: load("docs.json"), feed: load("feed.json"), adrs: load("adrs.json"), triage: load("triage.json"), roadmap: load("roadmap.json"),
    tickets: load("tickets.json"), events: load("events.json"), identity: load("identity.json"), handoffs: load("handoffs.json"), prompts: load("prompts.json"),
  };
  const schema = schemaFromRows(d1Json(cp, argv, SCHEMA_SQL));
  if (!schema.has("orgs")) {
    console.error("server-ai-e2e: this local D1 has no tables. Apply the migrations first: npx wrangler d1 migrations apply DB --local [--persist-to <dir>]");
    process.exit(1);
  }
  const { statements, sections, fixtures, unreset } = serverAiE2eStatements(schema, { base: fx !== null, fx });
  if (unreset.length) console.warn(`server-ai-e2e: WARNING — tables with org_id that scripts/seed/reset.mjs does not clear: ${unreset.join(", ")} (their test rows are deleted first)`);
  // Applied in files of at most ~80 KB (one file holding the whole seed is refused locally: SQLITE_TOOBIG).
  const chunks = [[]];
  let size = 0;
  for (const st of statements) {
    if (size + st.length > 80_000 && chunks.at(-1).length) { chunks.push([]); size = 0; }
    chunks.at(-1).push(st);
    size += st.length;
  }
  const file = join(mkdtempSync(join(tmpdir(), "trov-ai-e2e-")), "seed.sql");
  console.log(`server-ai-e2e: applying ${statements.length} statements to LOCAL D1 in ${chunks.length} files…`);
  for (const chunk of chunks) {
    writeFileSync(file, chunk.map((st) => st + ";").join("\n"), "utf8");
    execFileSync("npx", ["wrangler", ...wranglerArgs(argv), `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"], env: QUIET() });
  }
  console.log("\nSections:");
  for (const sec of sections) {
    console.log(sec.ran ? `  ran      ${sec.id} (${sec.count} statements)` : `  SKIPPED  ${sec.id}: no ${sec.missing} — merge ${sec.branch} (${sec.migration}) and run this again`);
  }
  console.log("\nFixtures (checked):");
  // Every check in ONE query (each is a scalar subquery), so the check costs one wrangler call.
  const checks = fixtures.flatMap((f) => f.checks);
  const counts = new Map();
  for (let from = 0; from < checks.length; from += 50) {
    const part = checks.slice(from, from + 50);
    const row = d1Json(cp, argv, `SELECT ${part.map(([sql], i) => `(${sql}) AS c${from + i}`).join(", ")}`)[0] ?? {};
    part.forEach((_, i) => counts.set(from + i, Number(row[`c${from + i}`] ?? 0)));
  }
  let bad = 0;
  let at = 0;
  for (const f of fixtures) {
    const fails = [];
    for (const [sql, least] of f.checks) {
      const n = counts.get(at++) ?? 0;
      if (n < least) fails.push(`${n} < ${least}: ${sql}`);
    }
    bad += fails.length ? 1 : 0;
    console.log(`  ${fails.length ? "MISSING" : "ok     "} [${f.section}] ${f.name}${fails.length ? `\n           ${fails.join("\n           ")}` : ""}`);
  }
  console.log(`\nserver-ai-e2e: ${fixtures.length - bad} of ${fixtures.length} fixtures present. Sign in with node scripts/dev-cookie.mjs test-session-<handle> (DEV_LOGIN unset).`);
  if (bad) process.exit(1);
}

if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  await main();
}
