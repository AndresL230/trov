// The LOCAL dev seed's NAMED SCENARIOS (docs/architecture/local-dev.md): each a complete organization that loads on
// its own, so a feature can be tried against the state it has to handle. `npm run seed` (scripts/seed-dev.mjs) loads
// them; the Worker test test/seed-scenarios.test.ts runs the same builders through `env.DB`.
//
//   team         SaplingLearn (org_saplinglearn, /saplinglearn/): a busy small team — the canonical dev fixtures, the
//                rich layer (scripts/seed/team-rich.mjs) and the AI showcase (scripts/seed/ai-showcase.mjs) on top.
//                Every org-keyed table has rows here (the test holds it to ORG_TABLES).
//   empty        Day One Labs (/dayone/): created two hours ago by Robin Vale — nothing in it yet.
//   free-at-cap  Pinecone Tutoring (/pinecone/): on Free with every limit reached (seats, repositories,
//                environments, tags, artifact storage, agent connections, this month's AI allowances).
//   pro          Northwind Academy (/northwind/): on Pro, well inside its limits; Sana is an admin here AND a member
//                of SaplingLearn (a person in two orgs).
//   hosting      Fernhill Labs (/fernhill/): environments whose parts are in every connection state — connected
//                (install and token), an error, not connected with leftover tokens, revoked, and connected with no
//                recent reading. AndresL230 is an admin here too.
//
// A FEATURE THAT ADDS A STATE adds its fixture here: a new scenario (a new org, with its own `org_dev_*` id and slug), or
// rows in the one that fits — see local-dev.md › Adding a scenario.
//
// Every scenario REWRITES its own org: all of the org's rows go first (`orgWipeStatements`, every table with an org_id
// column, children first), then it is written again, stamped against the clock. Other orgs, your sessions and anything
// you created in another org are kept — `--reset` (scripts/seed-dev.mjs) wipes everything first instead.
// LOCAL D1 ONLY: nothing here reaches a network or a remote database; every credential is a placeholder.
import { createHash } from "node:crypto";
import { buildSeedStatements } from "./build.mjs";
import { RESET_STATEMENTS } from "./reset.mjs";
import { platformDevStatements } from "./platform-dev.mjs";
import { themesDevStatements } from "./themes-dev.mjs";
import { briefDevStatements } from "./brief-dev.mjs";
import { aiRoadmapDevStatements } from "./ai-roadmap-dev.mjs";
import { teamRichStatements, insert, insertMany, makeClock, datedRoadmap } from "./team-rich.mjs";
import * as showcase from "./ai-showcase.mjs";
import docs from "../../fixtures/dev/docs.json" with { type: "json" };
import feed from "../../fixtures/dev/feed.json" with { type: "json" };
import adrs from "../../fixtures/dev/adrs.json" with { type: "json" };
import triage from "../../fixtures/dev/triage.json" with { type: "json" };
import roadmap from "../../fixtures/dev/roadmap.json" with { type: "json" };
import tickets from "../../fixtures/dev/tickets.json" with { type: "json" };
import events from "../../fixtures/dev/events.json" with { type: "json" };
import identity from "../../fixtures/dev/identity.json" with { type: "json" };
import handoffs from "../../fixtures/dev/handoffs.json" with { type: "json" };
import prompts from "../../fixtures/dev/prompts.json" with { type: "json" };
import themes from "../../fixtures/dev/themes.json" with { type: "json" };
import ai from "../../fixtures/dev/ai.json" with { type: "json" };
import aiRoadmap from "../../fixtures/dev/ai-roadmap.json" with { type: "json" };

/** The canonical dev fixtures (what `npm run seed` always loaded), for the team scenario. */
export const DEV_FIXTURES = { docs, feed, adrs, triage, roadmap, tickets, events, identity, handoffs, prompts, themes, ai, aiRoadmap };

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const MB = 1024 * 1024;

// ── the shared shape of a scenario's org ────────────────────────────────────────────────────────────────────────
/** A made-up person: Google-only, an example.com address. Upserted (persons are global; a rerun keeps the row). */
function personStatements(p, at) {
  return [
    `INSERT INTO persons (handle, name, color, email, created_at, onboarded_at, role, responsibilities) VALUES (${q(p.handle)}, ${q(p.name)}, ${q(p.color)}, ${q(p.email)}, ${q(at)}, ${q(at)}, ${q(p.role ?? null)}, ${q(p.responsibilities ?? null)}) ` +
      `ON CONFLICT(handle) DO UPDATE SET name = excluded.name, color = excluded.color, email = excluded.email, role = excluded.role, responsibilities = excluded.responsibilities`,
    insert("identities", { provider: "google", subject: `google-sub-${p.handle}`, label: p.email, person: p.handle, linked_at: at, linked_by: "seed", verified_email: p.email }, "INSERT OR REPLACE"),
  ];
}
const KINDS = [["my_work", "daily"], ["week_recap", "weekly"], ["review_queue", "daily"], ["roadmap_plan", "weekly"], ["ticketq", "daily"]];
const STARTER_TAGS = [["auth", "Sign-in, sessions, tokens, permissions", "plum"], ["architecture", "How the system is put together", "slate"], ["infra", "Deploys, hosting, CI", "rust"],
  ["api", "Routes and what they return", "sky"], ["ui", "Screens and components", "rose"], ["data", "Tables, migrations, storage", "fern"]];
/** What `createOrg` writes for a new org (src/orgs/repo.ts), plus its members. `plan`: [id, source, overrides]. */
function orgStatements(o, at) {
  const s = [
    `INSERT INTO orgs (id, slug, name, created_at, created_by, plan, plan_overrides, plan_source, plan_status, plan_changed_at, plan_changed_by) VALUES (${q(o.id)}, ${q(o.slug)}, ${q(o.name)}, ${q(at)}, ${q(o.owner)}, ${q(o.plan[0])}, ${q(JSON.stringify(o.plan[2] ?? {}))}, ${q(o.plan[1])}, 'active', ${q(at)}, ${q(o.owner)}) ` +
      `ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, created_at = excluded.created_at, created_by = excluded.created_by, plan = excluded.plan, plan_overrides = excluded.plan_overrides, ` +
      `plan_source = excluded.plan_source, plan_status = 'active', plan_period_end = NULL, billing_customer_id = NULL, billing_subscription_id = NULL, plan_changed_at = excluded.plan_changed_at, plan_changed_by = excluded.plan_changed_by, ` +
      `plan_gift_until = NULL, suspended_at = NULL, suspended_by = NULL, ai_automation = 1, ai_chat_auto = 1`,
    insert("org_counters", { org_id: o.id, name: "ticket", value: 0 }), insert("org_counters", { org_id: o.id, name: "handoff", value: 0 }),
    insert("plan", { org_id: o.id, narrative: "", current_version: 0 }),
    insert("notification_settings", { org_id: o.id, send_hour: 8, timezone: o.timezone ?? "America/New_York", from_address: "Trov <hello@trov.dev>" }),
    ...KINDS.map(([kind, cadence]) => insert("notification_policy", { org_id: o.id, kind, default_cadence: cadence, enabled: 1, updated_at: at, updated_by: "registry" })),
    ...STARTER_TAGS.map(([name, description, color]) => insert("org_tags", { org_id: o.id, name, description, color, starter: 1, created_at: at, created_by: "migration" })),
    insert("org_admin_audit", { org_id: o.id, actor: o.owner, action: "org.create", target: o.slug, detail: { name: o.name, owner: o.owner, plan: o.plan[0] }, at }),
  ];
  for (const [handle, role, title] of o.members) {
    s.push(insert("memberships", { org_id: o.id, user_id: handle, role, title: title ?? null, responsibilities: null, created_at: at, created_by: o.owner }));
    s.push(insert("org_admin_audit", { org_id: o.id, actor: o.owner, action: "member.add", target: handle, detail: { role }, at }));
  }
  return s;
}

/** The tables with an `org_id` column, children before the tables they reference (so deletes never trip a foreign
 *  key), read from the live schema — a new table is covered the day its migration lands. */
export const ORG_TABLES_SQL = [
  `SELECT m.name AS t, (SELECT group_concat(f."table") FROM pragma_foreign_key_list(m.name) f) AS parents FROM sqlite_master m
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND m.name NOT LIKE 'd1_%'
      AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'org_id') ORDER BY m.name`,
];
export function orgTablesInOrder(rows) {
  const parents = new Map(rows.map((r) => [r.t, new Set(String(r.parents ?? "").split(",").filter((p) => p && p !== r.t))]));
  const out = [];
  const left = new Set(parents.keys());
  while (left.size) {
    // A table may go once no table still waiting references it.
    const ready = [...left].filter((t) => ![...left].some((o) => o !== t && parents.get(o).has(t))).sort();
    const next = ready.length ? ready : [...left].sort(); // a cycle (none today): fall back to name order
    for (const t of next) { out.push(t); left.delete(t); }
  }
  return out;
}
/** Rows written WITHOUT an id (the fixtures' Unplaced items, the AI samples' suggestions, starter tags…) take the next
 *  autoincrement value. After a scenario's wipe that counter may sit inside an id block another layer owns (the rich
 *  layer's 7000–7999, the showcase's 9500–9899), and the owner's next delete would take those rows with it — so a
 *  counter left anywhere in 6000–9998 moves to 9999 first. */
export const AUTOINCREMENT_PAST_BLOCKS = [`UPDATE sqlite_sequence SET seq = 9999 WHERE seq BETWEEN 6000 AND 9998`];
/** Every row of `orgId` (and the OAuth tokens of its connections, which have no org_id), children first. */
export function orgWipeStatements(orgId, tables) {
  const O = q(orgId);
  return [
    `UPDATE tickets SET parent_id = NULL WHERE org_id = ${O}`,
    `DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE org_id = ${O})`,
    ...tables.map((t) => `DELETE FROM "${t}" WHERE org_id = ${O}`),
  ];
}

// ── team: SaplingLearn ──────────────────────────────────────────────────────────────────────────────────────────
// What scripts/seed/reset.mjs writes for SaplingLearn (its people, the org, the starter tags, memberships, the login
// map, the plan row, mail settings, its two apps) — written here directly so the scenario can rewrite this ONE org
// without the reset's global wipe. The tests keep using reset.mjs itself; it is not changed.
const TEAM_PEOPLE = [
  ["AndresL230", "Andres", "moss", "Founding engineer", "Trov itself: the Worker, D1 migrations, MCP tools and auth. Deploys and production incidents."],
  ["Jose-Gael-Cruz-Lopez", "Jose", "sky", "Backend engineer", "The Sapling API on Railway: the tutor, quizzes and the RAG pipeline. LLM cost and backend errors."],
  ["lpcooper-arch", "Luke", "fern", "Frontend engineer", "The Sapling web app: study screens, flashcards, onboarding, accessibility and bundle size."],
  ["Darkest-Teddy", "Jack", "plum", "Infrastructure engineer", "CI, the Cloudflare Workers builds, environments and health checks, the metrics endpoint."],
  ["meilin", "Meilin Zhao", "rose", "Product manager", "The roadmap and sprint planning, user research, triage of incoming requests."],
  ["sanaok", "Sana Okafor", "ochre", "Community lead", "Student and teacher support, community content, bug reports from users."],
];
/** A team person another scenario names (Sana in Northwind, Andres in Fernhill), so that scenario loads on its own. */
const teamPerson = (handle) => {
  const [, name, color] = TEAM_PEOPLE.find((p) => p[0] === handle);
  return `INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES (${q(handle)}, ${q(name)}, ${q(color)}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
};
function teamSetupStatements() {
  const T0 = "2026-01-01T00:00:00Z";
  const ORG = "org_saplinglearn";
  const s = [];
  for (const [handle, name, color, role, resp] of TEAM_PEOPLE) {
    s.push(`INSERT INTO persons (handle, name, color, created_at, onboarded_at, role, responsibilities) VALUES (${q(handle)}, ${q(name)}, ${q(color)}, '${T0}', '${T0}', ${q(role)}, ${q(resp)}) ` +
      `ON CONFLICT(handle) DO UPDATE SET name = excluded.name, color = excluded.color, role = excluded.role, responsibilities = excluded.responsibilities`);
  }
  s.push(`INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('github-webhook', 'GitHub', 'stone', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z'), ('trov', 'Trov', 'moss', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`);
  for (const [handle] of TEAM_PEOPLE.slice(0, 4)) s.push(insert("identities", { provider: "github", subject: handle, label: handle, person: handle, linked_at: T0, linked_by: "seed" }, "INSERT OR REPLACE"));
  for (const handle of ["meilin", "sanaok"]) s.push(insert("identities", { provider: "google", subject: `google-sub-${handle}`, label: `${handle}@saplinglearn.org`, person: handle, linked_at: T0, linked_by: "seed", verified_email: `${handle}@saplinglearn.org` }, "INSERT OR REPLACE"));
  s.push(...orgStatements({ id: ORG, slug: "saplinglearn", name: "SaplingLearn", owner: "AndresL230", plan: ["enterprise", "granted", {}], members: [] }, "2026-10-06T00:00:00.000Z")
    .filter((x) => !x.includes("org_admin_audit") && !x.includes("notification_policy")));
  s.push(`UPDATE orgs SET created_by = 'migration' WHERE id = '${ORG}'`);
  for (const [handle, , , role, resp] of TEAM_PEOPLE) s.push(insert("memberships", { org_id: ORG, user_id: handle, role: handle === "AndresL230" ? "owner" : "member", title: role, responsibilities: resp, created_at: T0, created_by: "seed" }));
  for (const [handle] of TEAM_PEOPLE.slice(0, 4)) s.push(insert("org_login_map", { org_id: ORG, github_login: handle, person: handle, mapped_at: T0, mapped_by: "seed" }));
  for (const [key, label, kind, position] of [["frontend", "Frontend", "Worker", 0], ["backend", "Backend", "Service", 1]]) {
    s.push(insert("repo_apps", { org_id: ORG, key, repo: "SaplingLearn/sapling", label, folder: "/", kind, watch: ["/"], release_signal: null, source: "migrated", position, created_at: "2026-10-15T00:00:00.000Z", created_by: "migration", updated_at: "2026-10-15T00:00:00.000Z", updated_by: "migration" }));
  }
  s.push(`INSERT OR IGNORE INTO platform_admins (person, granted_at, granted_by) VALUES ('AndresL230', '2026-10-06T00:00:00.000Z', 'seed')`);
  return s;
}

/** The team scenario's statements BEFORE the AI showcase: setup, the canonical fixtures, the layered dev rows, the
 *  rich layer. (`buildSeedStatements` opens with the reset; the scenario drops that prefix and writes `teamSetup`.) */
export function teamBaseStatements(now = new Date(), { reset = false } = {}) {
  const fx = DEV_FIXTURES;
  // Acme's demo rows (its owner, its usage, the admin trail) are the reset's business: Acme (`org_b`) exists only
  // after the reset — a freshly migrated D1 has SaplingLearn alone, and its usage rows would trip the foreign key
  // (#189) — and on a rerun without --reset the trail would pile up.
  const platform = platformDevStatements(now, { acme: reset });
  return [
    ...teamSetupStatements(),
    // The roadmap's sprints dated against the clock (team-rich.mjs `datedRoadmap`; the fixture keeps the TEST seed's dates).
    ...buildSeedStatements({ ...fx, roadmap: datedRoadmap(fx.roadmap, now) }).slice(RESET_STATEMENTS.length),
    ...platform,
    ...themesDevStatements(fx.themes, now),
    ...briefDevStatements(now),
    ...aiRoadmapDevStatements(fx, now.getTime()),
    ...teamRichStatements(now),
  ];
}

/** The AI showcase over the team (its stages 0–C): `views` are the running server's Ask chips (none offline, and
 *  the answers keep their words without them). */
export async function teamShowcase(db, { now = new Date(), image = null, views = null, origin = "http://localhost:8787" } = {}) {
  const pre = showcase.preFrom(await db.query(showcase.PRE_SQL));
  await db.apply("AI showcase: content", showcase.contentStatements(pre, now, image));
  const snap = showcase.snapFrom(await db.query(showcase.SNAP_SQL));
  const v = views ? await views(showcase.showcaseRefs(pre, snap, now)) : {};
  const { statements, unresolved } = showcase.aiStatements(pre, snap, v, now, { origin, image: image ?? undefined });
  await db.apply("AI showcase: output", statements);
  return { unresolved };
}

// ── empty: Day One Labs ─────────────────────────────────────────────────────────────────────────────────────────
const ROBIN = { handle: "robin-vale", name: "Robin Vale", color: "sky", email: "robin@example.com", role: "Founder" };
function emptyStatements(now) {
  const c = makeClock(now);
  const at = c.days(2 / 24);
  return [...personStatements(ROBIN, at), ...orgStatements({ id: "org_dev_dayone", slug: "dayone", name: "Day One Labs", owner: ROBIN.handle, plan: ["free", "granted"], members: [[ROBIN.handle, "owner", "Founder"]] }, at)];
}

// ── free-at-cap: Pinecone Tutoring ──────────────────────────────────────────────────────────────────────────────
const KAI = { handle: "kai-moreno", name: "Kai Moreno", color: "rust", email: "kai@example.com", role: "Founder" };
const LENA = { handle: "lena-fox", name: "Lena Fox", color: "fern", email: "lena@example.com", role: "Tutor coordinator" };
function freeAtCapStatements(now) {
  const c = makeClock(now);
  const O = "org_dev_pinecone", at = c.days(64), REPO_P = "pinecone-tutoring/web";
  const s = [...personStatements(KAI, at), ...personStatements(LENA, at),
    ...orgStatements({ id: O, slug: "pinecone", name: "Pinecone Tutoring", owner: KAI.handle, plan: ["free", "granted"], members: [[KAI.handle, "owner", "Founder"], [LENA.handle, "member", "Tutor coordinator"]] }, at)];
  // Seats 3 of 3: two members and a pending invitation.
  s.push(insert("org_invites", { org_id: O, email: "third-tutor@example.com", role: "member", invited_by: KAI.handle, status: "pending", created_at: c.days(3), name: "Third tutor" }));
  // Repositories 1 of 1, environments 2 of 2.
  s.push(insert("org_repos", { id: "hook_dev_pinecone_web", org_id: O, repo_full_name: REPO_P, is_primary: 1, legacy_hook: 0, created_at: c.days(60), created_by: KAI.handle }));
  for (const [key, position, label, branch] of [["staging", 0, "Staging", "main"], ["production", 1, "Production", "production"]]) {
    s.push(insert("org_environments", { org_id: O, key, position, label, note: null, branch, frontend_url: `https://${key === "production" ? "" : "staging."}pinecone.example.com`, api_url: "", health_path: "/", created_at: c.days(58), updated_at: c.days(58), updated_by: KAI.handle }));
  }
  // Tags 30 of 30: the six starters and 24 of their own.
  const extra = ["algebra", "geometry", "calculus", "statistics", "physics", "chemistry", "biology", "essays", "grammar", "vocabulary", "sat-prep", "act-prep", "homework", "exam-prep", "scheduling", "billing", "parents", "onboarding", "zoom", "whiteboard", "worksheets", "recordings", "feedback", "retention"];
  extra.forEach((name, i) => s.push(insert("org_tags", { org_id: O, name, description: `${name[0].toUpperCase()}${name.slice(1).replace("-", " ")} sessions and material`, color: ["sky", "fern", "plum", "ochre", "rose", "slate"][i % 6], starter: 0, created_at: c.days(50 - i), created_by: i % 2 ? LENA.handle : KAI.handle })));
  // Artifact storage 250 MB of 250 MB: five recorded sessions, five 10 MB versions each (the bytes are not stored
  // locally — the library and the plan block count them; opening one says it could not be read).
  for (let p = 0; p < 5; p++) {
    const id = 6101 + p;
    s.push(insert("artifact_pages", { id, org_id: O, slug: `session-recording-${p + 1}`, title: `Session recording, week ${p + 1}`, kind: "file", area: "data", repo: "", author_id: KAI.handle, status: "published", visibility: "org", current_version: 5, created_at: c.days(40 - p * 5), updated_at: c.days(30 - p * 5), published_at: c.days(40 - p * 5) }));
    for (let v = 1; v <= 5; v++) {
      s.push(insert("artifact_versions", { org_id: O, page_id: id, version_no: v, summary: v === 1 ? "First upload" : "Re-recorded", content: null, r2_key: `artifacts/dev-seed-pinecone-${p}-${v}`, size_bytes: 10 * MB, content_type: "video/mp4", sha256: sha256(`pinecone-${p}-${v}`), filename: `week-${p + 1}-v${v}.mp4`, created_by: KAI.handle, created_at: c.days(40 - p * 5 - v) }));
    }
    s.push(insert("artifacts_fts", { page_id: String(id), title: `Session recording, week ${p + 1}`, description: "", body: "", org_id: O }));
  }
  // Agent connections 5 of 5 for Kai.
  for (let i = 0; i < 5; i++) s.push(insert("mcp_tokens", { org_id: O, person: KAI.handle, token_hash: `dev-seed-${sha256(`pinecone-${i}`)}`, token_hint: `p${i}x${i}`, created_at: c.days(50 - i * 8), last_used_at: c.days(i + 0.5), revoked: 0 }));
  // This month's AI allowances, all used — counted on TODAY (UTC), so they always fall inside the calendar month.
  const day = now.toISOString().slice(0, 10);
  for (const [metric, actor, count] of [["summary:pr", "github-webhook", 240], ["summary:issue", "github-webhook", 60], ["ai_run:digest.session", "ai-pass", 250], ["ai_suggest", "ai-pass", 1000], ["ai_chat", KAI.handle, 50]]) {
    s.push(insert("org_usage_daily", { org_id: O, day, metric, actor, count, last_at: c.days(0.05) }));
  }
  // A little work, so the rest of the app is not empty.
  const T = [["Book the spring SAT cohort", "request", "high", KAI.handle, "in_progress"], ["Zoom links expire before the session", "bug", "normal", LENA.handle, "submitted"], ["Parents want a monthly progress note", "request", "low", LENA.handle, "submitted"], ["Upgrade to Pro for more seats?", "question", "normal", KAI.handle, "submitted"]];
  T.forEach(([title, category, priority, requester, status], i) => {
    const id = 6101 + i;
    s.push(insert("tickets", { id, org_id: O, number: i + 1, title, body: "", category, priority, status, requester, parent_id: null, sprint_id: null, created_at: c.days(10 - i), updated_at: c.days(9 - i), source: "canopy" }));
    s.push(insert("ticket_events", { org_id: O, ticket_id: id, actor: requester, from_status: null, to_status: "submitted", created_at: c.days(10 - i) }));
    if (status !== "submitted") s.push(insert("ticket_events", { org_id: O, ticket_id: id, actor: KAI.handle, from_status: "submitted", to_status: status, created_at: c.days(9 - i) }));
  });
  s.push(`UPDATE org_counters SET value = ${T.length} WHERE org_id = '${O}' AND name = 'ticket'`);
  s.push(insert("feed", { id: 6101, org_id: O, author: KAI.handle, summary: "Decision: we stay on Free until the spring cohort is booked", body: "Every limit is reached; Pro waits for the spring revenue.", artifacts: null, created_at: c.days(2) }));
  return s;
}

// ── pro: Northwind Academy ──────────────────────────────────────────────────────────────────────────────────────
const AMARA = { handle: "amara-osei", name: "Amara Osei", color: "plum", email: "amara@example.com", role: "Head of digital learning" };
const THEO = { handle: "theo-lind", name: "Theo Lind", color: "sky", email: "theo@example.com", role: "Developer" };
const JUN = { handle: "jun-park", name: "Jun Park", color: "fern", email: "jun@example.com", role: "Developer" };
function proStatements(now) {
  const c = makeClock(now);
  const O = "org_dev_northwind", at = c.days(120), REPO_N = "northwind-academy/portal";
  const s = [teamPerson("sanaok"), ...personStatements(AMARA, at), ...personStatements(THEO, at), ...personStatements(JUN, at),
    ...orgStatements({ id: O, slug: "northwind", name: "Northwind Academy", owner: AMARA.handle, plan: ["team", "granted"], members: [[AMARA.handle, "owner", "Head of digital learning"], ["sanaok", "admin", "Community partner"], [THEO.handle, "member", "Developer"], [JUN.handle, "member", "Developer"]] }, at)];
  s.push(insert("org_repos", { id: "hook_dev_northwind_portal", org_id: O, repo_full_name: REPO_N, is_primary: 1, legacy_hook: 0, created_at: c.days(110), created_by: AMARA.handle }));
  s.push(insert("org_environments", { org_id: O, key: "production", position: 0, label: "Production", note: null, branch: "main", frontend_url: "https://portal.northwind.example.com", api_url: "", health_path: "/", created_at: c.days(110), updated_at: c.days(110), updated_by: THEO.handle }));
  s.push(insert("org_tags", { org_id: O, name: "portal", description: "The parent and student portal", color: "sky", starter: 0, created_at: c.days(100), created_by: AMARA.handle }));
  const sprintAt = c.date(-6), due = c.date(8);
  s.push(insert("sprints", { id: 6201, org_id: O, title: "Parent portal: report cards", description: "Parents download term report cards from the portal.", summary: "Report cards in the portal.", phase: null, dates: null, start_date: sprintAt, target_date: due, status: "in_progress", urgency: "normal", lead: THEO.handle, domain: null, github_ref: null, created_at: c.days(7), created_by: AMARA.handle, updated_at: c.days(1) }));
  const T = [["Report card PDF template", "request", "high", AMARA.handle, [THEO.handle], "done", 6201], ["Portal sign-in with the school's Google accounts", "request", "high", AMARA.handle, [JUN.handle], "in_progress", 6201],
    ["Report card download is slow for large families", "bug", "normal", "sanaok", [THEO.handle], "testing", 6201], ["Translate the portal into Polish", "request", "low", "sanaok", [], "submitted", null],
    ["Parents can't reset their password from the e-mail link", "bug", "high", "sanaok", [JUN.handle], "in_progress", null], ["Archive last year's classes", "request", "normal", AMARA.handle, [], "submitted", null]];
  T.forEach(([title, category, priority, requester, assignees, status, sprint], i) => {
    const id = 6201 + i;
    s.push(insert("tickets", { id, org_id: O, number: i + 1, title, body: "", category, priority, status, requester, parent_id: null, sprint_id: sprint, created_at: c.days(9 - i), updated_at: c.days(2), source: "canopy" }));
    for (const a of assignees) s.push(insert("ticket_assignees", { org_id: O, ticket_id: id, login: a }));
    s.push(insert("ticket_events", { org_id: O, ticket_id: id, actor: requester, from_status: null, to_status: "submitted", created_at: c.days(9 - i) }));
    if (status !== "submitted") s.push(insert("ticket_events", { org_id: O, ticket_id: id, actor: assignees[0] ?? AMARA.handle, from_status: "submitted", to_status: status, created_at: c.days(3) }));
  });
  s.push(`UPDATE org_counters SET value = ${T.length} WHERE org_id = '${O}' AND name = 'ticket'`);
  [[THEO.handle, 4, "Shipped: report card PDF template", ["portal"]], [JUN.handle, 2, "Status: Google sign-in on staging", ["auth"]], ["sanaok", 1, "Triage: three password-reset reports from parents", ["auth", "portal"]]].forEach(([author, d, summary, tags], i) => {
    s.push(insert("feed", { id: 6201 + i, org_id: O, author, summary, body: null, artifacts: null, created_at: c.days(d) }));
    for (const tag of tags) s.push(insert("entry_tags", { org_id: O, tag, entry_type: "feed", entry_id: String(6201 + i) }));
  });
  s.push(insert("docs", { org_id: O, slug: "northwind-portal", section: "Overview", space: "product", title: "The parent portal", body: "# The parent portal\n\nParents and students sign in with the school's Google accounts to see timetables, homework and report cards.\n", current_version: 1, updated_at: c.days(30), updated_by: AMARA.handle, owner: AMARA.handle }));
  s.push(insert("doc_versions", { org_id: O, slug: "northwind-portal", version: 1, body: "# The parent portal\n\nParents and students sign in with the school's Google accounts to see timetables, homework and report cards.\n", summary: "First version", status: "promoted", confidence: "high", created_at: c.days(30), created_by: AMARA.handle, content_hash: sha256("northwind-portal-1"), base_version: null, change_kind: "create", low_confidence: 0 }));
  s.push(insert("handoffs", { id: 6201, org_id: O, number: 1, sender: THEO.handle, recipient: JUN.handle, status: "pending", body: "Report card downloads are slow for families with four children: each PDF is rendered in turn. Batch them.", context: { repo: REPO_N, branch: "fix/report-cards", task: "Render report cards in parallel", done: [], next: ["Render in parallel", "Zip the PDFs"], files: ["portal/reports.py"] }, created_at: c.days(0.5), expires_at: c.days(-6.5) }));
  s.push(`UPDATE org_counters SET value = 1 WHERE org_id = '${O}' AND name = 'handoff'`);
  // Well inside Pro's allowances this month.
  const day = now.toISOString().slice(0, 10);
  for (const [metric, actor, count] of [["summary:pr", "github-webhook", 41], ["ai_run:digest.session", "ai-pass", 64], ["ai_suggest", "ai-pass", 380], ["ai_chat", AMARA.handle, 22]]) s.push(insert("org_usage_daily", { org_id: O, day, metric, actor, count, last_at: c.days(0.05) }));
  s.push(insert("mcp_tokens", { org_id: O, person: THEO.handle, token_hash: `dev-seed-${sha256("northwind-theo")}`, token_hint: "n0rt", created_at: c.days(30), last_used_at: c.days(0.3), revoked: 0 }));
  return s;
}

// ── hosting: Fernhill Labs ──────────────────────────────────────────────────────────────────────────────────────
const INES = { handle: "ines-garcia", name: "Inés García", color: "ochre", email: "ines@example.com", role: "Platform lead" };
function hostingStatements(now) {
  const c = makeClock(now);
  const O = "org_dev_fernhill", at = c.days(90), REPO_F = "fernhill-labs/garden";
  const s = [teamPerson("AndresL230"), ...personStatements(INES, at),
    ...orgStatements({ id: O, slug: "fernhill", name: "Fernhill Labs", owner: INES.handle, plan: ["enterprise", "granted"], members: [[INES.handle, "owner", "Platform lead"], ["AndresL230", "admin", "Consultant"]] }, at)];
  s.push(insert("org_repos", { id: "hook_dev_fernhill_garden", org_id: O, repo_full_name: REPO_F, is_primary: 1, legacy_hook: 0, created_at: c.days(88), created_by: INES.handle }));
  s.push(`INSERT OR IGNORE INTO org_keys (org_id, key_version, wrapped_key, wrap_iv, kek_fingerprint, created_at) VALUES ('${O}', 1, 'dev-seed-not-a-key', 'dev-seed-iv', 'dev-seed', ${q(c.days(88))})`);
  const env = (key, position, label, branch, url) => insert("org_environments", { org_id: O, key, position, label, note: null, branch, frontend_url: url, api_url: "", health_path: "/", created_at: c.days(80), updated_at: c.days(20), updated_by: INES.handle });
  s.push(env("production", 0, "Production", "main", "https://garden.fernhill.example.com"), env("staging", 1, "Staging", "staging", "https://staging.garden.fernhill.example.com"), env("preview", 2, "Preview", "preview", "https://preview.garden.fernhill.example.com"));
  const parts = [
    // [env, key, position, label, role, provider, settings, state]
    ["production", "web", 0, "Web", "web", "vercel", { project: "fernhill-garden", team_slug: "fernhill" }, "connected"],
    ["production", "api", 1, "API", "service", "fly", { app: "garden-api" }, "connected"],
    ["staging", "web", 0, "Web", "web", "render", { owner_id: "tea-dev0seed0000000000000", service_id: "srv-dev0seed0000000000000" }, "error"],
    ["staging", "api", 1, "API", "service", "railway", { environment_id: "00000000-0000-4000-8000-000000000001", service_id: "00000000-0000-4000-8000-000000000002" }, "not_connected"],
    ["preview", "web", 0, "Web", "web", "netlify", { site_id: "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c" }, "revoked"],
    ["preview", "worker", 1, "Worker", "web", "cloudflare", { worker: "garden-preview" }, "stale"],
  ];
  for (const [e, key, position, label, role, provider, settings] of parts) s.push(insert("org_environment_parts", { org_id: O, env_key: e, part_key: key, position, label, role, provider, settings, created_at: c.days(60), updated_at: c.days(20), updated_by: INES.handle }));
  for (const [key, label, kind, position] of [["web", "Web", "Site", 0], ["api", "API", "Service", 1], ["worker", "Worker", "Worker", 2]]) {
    s.push(insert("repo_apps", { org_id: O, key, repo: REPO_F, label, folder: key === "web" ? "/apps/web" : key === "api" ? "/apps/api" : "/apps/worker", kind, watch: [`/apps/${key}`], release_signal: null, source: "manual", position, created_at: c.days(60), created_by: INES.handle, updated_at: c.days(60), updated_by: INES.handle }));
  }
  // The connections: Vercel installed (the Integration), Fly with a read-only token, Render's token refused,
  // Railway never connected org-wide but two old per-environment project tokens left behind, Netlify's grant removed
  // on Netlify's side, Cloudflare connected but its last good reading three days old.
  const secret = (kind, scope, last4, lastError = null) => insert("org_secrets", { org_id: O, kind, scope, ciphertext: "dev-seed-not-a-secret", iv: "dev-seed-iv", key_version: 1, hint_last4: last4, created_by: INES.handle, created_at: c.days(60), rotated_at: null, last_used_at: c.days(0.01), last_error: lastError });
  s.push(secret("vercel", "", "v3rc"), secret("fly", "", "f1y0"), secret("render", "", "r3nd", "Render refused the token — the grant may have been removed; Test connection to confirm"),
    secret("railway", "staging", "51b1"), secret("railway", "production", "5024"), secret("cloudflare_analytics", "", "c0f1"));
  s.push(insert("org_hosting_connections", { org_id: O, provider: "vercel", scope: "", method: "install", external_id: "icfg_devseed0000000000000000", account_id: "team_devseed000000000000000", account_label: "Fernhill (Vercel)", status: "active", connected_by: INES.handle, connected_at: c.days(60) }));
  s.push(insert("org_hosting_connections", { org_id: O, provider: "netlify", scope: "", method: "oauth", external_id: null, account_id: "dev-seed-netlify", account_label: "Fernhill (Netlify)", status: "revoked", connected_by: INES.handle, connected_at: c.days(50), revoked_at: c.days(4), revoked_by: "system", revoked_reason: "uninstalled" }));
  s.push(insert("org_integration_config", { org_id: O, kind: "cloudflare_analytics", scope: "", config: { account_id: "fedcba9876543210fedcba9876543210" }, updated_at: c.days(60), updated_by: INES.handle }));
  s.push(insert("org_integration_config", { org_id: O, kind: "fly", scope: "", config: { org_slug: "fernhill" }, updated_at: c.days(60), updated_by: INES.handle }));
  // Deploys and poll state.
  const deploys = [];
  let did = 0;
  const D = (e, part, provider, state, d, extra = {}) => deploys.push({ org_id: O, env: e, part, provider, deploy_id: `dev-seed-${++did}`, state, target: extra.target ?? "production", sha: createHash("sha1").update(`fern-${did}`).digest("hex"), branch: extra.branch ?? "main", message: extra.message ?? null, actor: INES.handle, url: extra.url ?? null, inspect_url: null, created_at: c.days(d), ready_at: state === "ready" ? c.days(d - 0.002) : null, recorded_at: c.days(d), updated_at: c.days(d), source: "provider", reason: extra.reason ?? null, sha_source: "provider", rolled_back_from: null });
  for (const d of [9, 6, 3, 1, 0.2]) D("production", "web", "vercel", "ready", d, { url: "https://garden.fernhill.example.com" });
  D("production", "web", "vercel", "building", 0.01, { message: "Deploy main" });
  for (const d of [8, 5, 2]) D("production", "api", "fly", "ready", d);
  D("production", "api", "fly", "error", 0.4, { reason: "Machine failed health checks after 3 attempts" });
  for (const d of [12, 7]) D("staging", "web", "render", "ready", d, { branch: "staging" });
  for (const d of [11, 6, 4]) D("preview", "worker", "cloudflare", "ready", d, { branch: "preview" });
  D("preview", "web", "netlify", "ready", 6, { branch: "preview", target: "preview" });
  s.push(...insertMany("hosting_deploys", deploys));
  const hour = Math.floor(c.t / 3_600_000) * 3_600_000;
  const poll = (e, part, provider, status, polledDays, okDays, detail = null, unavailable = []) => insert("hosting_poll_state", { org_id: O, env: e, part, provider, polled_at: c.days(polledDays), status, detail, last_ok_at: okDays == null ? null : c.days(okDays),
    covered_from: okDays == null ? null : new Date(hour - 14 * 86_400_000).toISOString(), covered_to: okDays == null ? null : new Date(hour - Math.round(okDays * 24) * 3_600_000).toISOString(), unavailable });
  s.push(poll("production", "web", "vercel", "ok", 0.004, 0.004, null, [{ metric: "requests", reason: "Vercel has no public usage API" }]));
  s.push(poll("production", "api", "fly", "ok", 0.004, 0.004));
  s.push(poll("staging", "web", "render", "failed", 0.004, 5, "Render refused the token"));
  s.push(poll("staging", "api", "railway", "skipped", 0.004, null, "no credential"));
  s.push(poll("preview", "web", "netlify", "skipped", 0.004, 4, "no credential"));
  s.push(poll("preview", "worker", "cloudflare", "failed", 0.004, 3, "Cloudflare answered 503 three times"));
  // Hourly readings: the Fly API (fresh), and the Cloudflare preview Worker up to three days ago.
  const m = [];
  for (let h = 1; h <= 14 * 24; h++) {
    const t = new Date(hour - h * 3_600_000).toISOString();
    if (h <= 48) { m.push({ org_id: O, metric: "hx_cpu", env: "production", part: "api", value: Math.round((0.15 + Math.abs(Math.sin(h / 5)) * 0.4) * 100) / 100, at: t }); m.push({ org_id: O, metric: "hx_mem_mb", env: "production", part: "api", value: 300 + (h % 7) * 12, at: t }); }
    if (h > 72) { m.push({ org_id: O, metric: "hx_requests", env: "preview", part: "worker", value: 40 + (h % 24) * 6, at: t }); m.push({ org_id: O, metric: "hx_errors", env: "preview", part: "worker", value: h % 13 === 0 ? 2 : 0, at: t }); }
  }
  s.push(...insertMany("repo_metrics", m, 200));
  return s;
}

// ── the registry ────────────────────────────────────────────────────────────────────────────────────────────────
/** `statements(now, opts)` → the scenario's rows (after its org is wiped). `team` also runs the AI showcase. */
export const SCENARIOS = [
  { name: "team", org: "org_saplinglearn", slug: "saplinglearn", what: "SaplingLearn: a busy small team, every surface filled (owner AndresL230, admin Jose-Gael-Cruz-Lopez, members meilin, sanaok, …)",
    signIn: [["AndresL230", "owner"], ["Jose-Gael-Cruz-Lopez", "admin"], ["meilin", "member"], ["sanaok", "member, and admin of Northwind (two orgs)"]], statements: teamBaseStatements, showcase: true },
  { name: "empty", org: "org_dev_dayone", slug: "dayone", what: "Day One Labs: a new org on its first day, nothing in it", signIn: [["robin-vale", "owner"]], statements: emptyStatements },
  { name: "free-at-cap", org: "org_dev_pinecone", slug: "pinecone", what: "Pinecone Tutoring: on Free with every limit reached", signIn: [["kai-moreno", "owner"], ["lena-fox", "member"]], statements: freeAtCapStatements },
  { name: "pro", org: "org_dev_northwind", slug: "northwind", what: "Northwind Academy: on Pro, well inside its limits", signIn: [["amara-osei", "owner"], ["sanaok", "admin (also in SaplingLearn)"], ["theo-lind", "member"]], statements: proStatements },
  { name: "hosting", org: "org_dev_fernhill", slug: "fernhill", what: "Fernhill Labs: hosting parts in every connection state", signIn: [["ines-garcia", "owner"], ["AndresL230", "admin"]], statements: hostingStatements },
];
export const scenarioNames = () => SCENARIOS.map((s) => s.name);

/**
 * Load `names` into the database behind `db` ({ query(sqls) → rows[][], apply(label, statements) }, both async).
 * `reset`: the canonical reset first (every data table, every org but the two seed orgs). `views`: an async
 * function giving the running server's Ask RefViews for the showcase's refs (none offline).
 */
export async function loadScenarios(db, names, { now = new Date(), reset = false, image = null, views = null, origin, log = () => {} } = {}) {
  const chosen = names.map((n) => SCENARIOS.find((s) => s.name === n) ?? (() => { throw new Error(`unknown scenario: ${n} (one of ${scenarioNames().join(", ")})`); })());
  // `team` first: its rows carry fixed ids, and the others' autoincrement past them.
  chosen.sort((a, b) => (a.name === "team" ? -1 : b.name === "team" ? 1 : 0));
  if (reset) await db.apply("reset (every data table)", RESET_STATEMENTS);
  const tables = orgTablesInOrder((await db.query(ORG_TABLES_SQL))[0]);
  const out = {};
  for (const sc of chosen) {
    log(`${sc.name} — ${sc.what}`);
    await db.apply(`${sc.name}: wipe ${sc.org}`, [...orgWipeStatements(sc.org, tables), ...AUTOINCREMENT_PAST_BLOCKS]);
    await db.apply(`${sc.name}: rows`, sc.statements(now, { reset }));
    if (sc.showcase) out[sc.name] = await teamShowcase(db, { now, image, views, origin });
  }
  return out;
}
