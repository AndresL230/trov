#!/usr/bin/env node
// The AI SHOWCASE seed: SaplingLearn as it looks once Trov's AI has run for a while — every new AI surface of the
// server-side AI build (#178) filled with realistic output, written to the REAL tables, so each screen shows it
// through its REAL read with LOCAL_AI_PREVIEW OFF. Local D1 only: it refuses --remote, like every other seed.
//
//   cd <the folder wrangler dev serves from> && node <this repo>/scripts/seed/ai-showcase.mjs [--server <origin>] [--print]
//
//   --server <origin>  the RUNNING local Worker (default http://localhost:8790). Every item an Ask answer cites is
//                      stored as the RefView THAT server builds for it (`POST /api/o/saplinglearn/ask/peek`, signed in
//                      by DEV_LOGIN=AndresL230), so a chip is exactly what a live answer would have stored. Start
//                      `npm run dev` (or the preview's wrangler dev) first.
//   --print            print the statements of the first stage and touch nothing.
//
// RUN IT AFTER the base seeds: `npm run seed` (it carries brief-dev, themes-dev and ai-roadmap-dev), then
// `node scripts/seed/repo-setups.mjs` (the hosting parts and deploys the repo state names). It reads both.
//
// IDEMPOTENT, and stamped against the clock at run time. It deletes and rewrites ONLY what it owns, in org_saplinglearn:
//   • its own id blocks — sprint 9701; tickets 9800–9899 (their numbers are kept across runs); handoff 9801; Unplaced
//     items, feed entries, artifacts, Ask threads / cards / attachments, suggestions, "Wrong?" rows and Ask flags
//     9500–9599 (Ask messages 95000–95999); the tag `agents` (org_tags 9501) and Sift runs 9501–9509 with the
//     suggestions and item tags those runs added. Autoincrement moves past each block, so a row a person (or a live
//     AI pass) writes later lands above it and is never touched by a rerun.
//   • whole AI outputs that the screens show one of: AndresL230's person_brief versions (brief-dev's v1 is rewritten
//     under the showcase's v2), the primary repository's repo_state versions, org_insights (sprint notes, the drift),
//     digest_highlights, the open Roadmap suggestions (item_type 'roadmap'), the org's Sift switch (tag.fit), and
//     AndresL230's Ask settings and "Only when something needs me".
//   • the org's AI metering (`ai_*`, `summary*` in org_usage_daily) over the last 40 days.
//   • computed facts it SETS on rows it does not own (idempotent UPDATEs): feed.importance and pr_summaries.importance
//     on a few entries and PRs, and AndresL230's memberships.mywork_opened_at.
// A decision a person makes on a showcase row (Accept a ticket suggestion, Confirm the Publish card, Accept a sprint
// draft…) runs the real writer and may write rows outside these blocks; a rerun resets the showcase rows only.
//
// THE STAGES: 0 reads the owned numbers; A writes the content the AI output talks about (a current sprint with real
// ticket history, a handoff, Unplaced items, Trov's session digests, the image an Ask question attached); B reads the
// org back and asks the running server for the RefViews; C writes the AI output itself; D checks every surface's rows.
import { createHash } from "node:crypto";
import { targetsRemote } from "./build.mjs";
import { briefDevStatements } from "./brief-dev.mjs";

// ── who and where ────────────────────────────────────────────────────────────────────────────────────────────────
export const SHOWCASE_ORG = "org_saplinglearn";
const ORG = SHOWCASE_ORG;
const SLUG = "saplinglearn";
const ME = "AndresL230";
const REPO = "SaplingLearn/sapling";
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const JEV = "jev-1.13.0";
const MIN = 60_000;
const DAY = 86_400_000;

/** The id blocks the showcase owns. */
export const IDS = {
  sprint: 9701,
  tickets: { A: 9801, B: 9802, C: 9803, D: 9804, E: 9805, F: 9806, G: 9807, H: 9808 },
  handoff: 9801,
  triage: { railway: 9501, evals: 9502 },
  feed: { hosting: 9501, orgs: 9502, checkout: 9503, fly: 9504, netlify: 9505 },
  artifact: { attachment: 9501, saved: 9502 },
  tag: 9501,
  runs: { agents: 9501, data: 9502 },
};
const BLOCK = (col, lo = 9500, hi = 9599) => `${col} BETWEEN ${lo} AND ${hi}`;

// ── literals ─────────────────────────────────────────────────────────────────────────────────────────────────────
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const raw = (sql) => ({ sql });
/** A row → `INSERT INTO t (cols) VALUES (…)`: null → NULL, number → as is, {sql} → raw SQL, object/array → JSON text. */
function insert(table, row, verb = "INSERT") {
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
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ── the clock ────────────────────────────────────────────────────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
function mondayOf(d) {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7));
  return u.toISOString().slice(0, 10);
}
function weekStarts(now, weeks) {
  const thisMonday = new Date(`${mondayOf(now)}T00:00:00Z`).getTime();
  return Array.from({ length: weeks }, (_, i) => new Date(thisMonday - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
}
/** ISO week id of a local date (src/notifications/window.ts `isoWeekId`). */
function isoWeekId(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7)).padStart(2, "0")}`;
}
/** The org's local date (its digests' time zone) as [y, m, d]. */
function localDate(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return [Number(parts.year), Number(parts.month), Number(parts.day)];
}
function makeClock(now) {
  const t = now.getTime();
  const iso = (ms) => new Date(Math.min(ms, t - 20_000)).toISOString();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    now, t,
    ago: (min) => iso(t - min * MIN),
    days: (d, extraMin = 0) => iso(t - d * DAY - extraMin * MIN),
    /** A moment TODAY (UTC) — `frac` of the way from midnight to now — so the Ask list groups it under Today. */
    today: (frac) => iso(dayStart + Math.max(60_000, (t - dayStart) * frac)),
    date: (dDays) => new Date(t + dDays * DAY).toISOString().slice(0, 10),
    /** `at` moved by `min` minutes, never past now. */
    plus: (at, min) => iso(Date.parse(at) + min * MIN),
    clamp: (ms) => iso(ms),
  };
}

// ── stage 0: what a rerun keeps ──────────────────────────────────────────────────────────────────────────────────
export const PRE_SQL = [
  `SELECT id, number FROM tickets WHERE org_id = '${ORG}' AND ${BLOCK("id", 9800, 9899)}`,
  `SELECT COALESCE(MAX(number), 0) AS m FROM tickets WHERE org_id = '${ORG}' AND id NOT BETWEEN 9800 AND 9899`,
  `SELECT number FROM handoffs WHERE org_id = '${ORG}' AND id = ${IDS.handoff}`,
  `SELECT COALESCE(MAX(number), 0) AS m FROM handoffs WHERE org_id = '${ORG}' AND id <> ${IDS.handoff}`,
  `SELECT occurred_at FROM events WHERE org_id = '${ORG}' AND event_type = 'pr_merged' AND ref_number = 185`,
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chat_threads', 'chat_thread_people', 'person_brief', 'org_insights', 'digest_highlights', 'repo_state', 'repo_apps', 'org_tag_runs')`,
  `SELECT COUNT(*) AS n FROM memberships WHERE org_id = '${ORG}' AND user_id = '${ME}'`,
];
/** Stage 0's rows → the numbers the owned tickets and handoff carry (kept across runs, else the next free ones). */
export function preFrom(results) {
  const [owned, maxT, hand, maxH, pr185, tables, me] = results;
  const byId = new Map(owned.map((r) => [Number(r.id), Number(r.number)]));
  let next = Number(maxT[0]?.m ?? 0);
  const used = new Set(byId.values());
  const N = {};
  for (const [k, id] of Object.entries(IDS.tickets)) {
    if (byId.has(id)) { N[k] = byId.get(id); continue; }
    do next++; while (used.has(next));
    used.add(next);
    N[k] = next;
  }
  const HN = hand[0]?.number ? Number(hand[0].number) : Number(maxH[0]?.m ?? 0) + 1;
  return { N, HN, pr185At: pr185[0]?.occurred_at ?? null, tables: new Set(tables.map((r) => r.name)), member: Number(me[0]?.n ?? 0) > 0 };
}

// ── stage A: the content the AI output talks about ───────────────────────────────────────────────────────────────
/** What the showcase deletes first: everything it owns (see the header). */
export function deleteStatements(c) {
  const since = c.date(-40);
  const s = [
    `DELETE FROM chat_thread_people WHERE org_id = '${ORG}' AND ${BLOCK("thread_id")}`,
    `DELETE FROM chat_actions WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    `DELETE FROM chat_artifacts WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    `DELETE FROM chat_messages WHERE org_id = '${ORG}' AND ${BLOCK("id", 95000, 95999)}`,
    `DELETE FROM chat_threads WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    `DELETE FROM person_ask_settings WHERE org_id = '${ORG}' AND handle = '${ME}'`,
    `DELETE FROM ask_flags WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    `DELETE FROM ai_feedback WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    `DELETE FROM ai_suggestions WHERE org_id = '${ORG}' AND (${BLOCK("id")} OR item_type = 'roadmap')`,
    `DELETE FROM org_insights WHERE org_id = '${ORG}'`,
    `DELETE FROM repo_state WHERE org_id = '${ORG}' AND repo = '${REPO}'`,
    `DELETE FROM person_brief WHERE org_id = '${ORG}' AND handle = '${ME}'`,
    `DELETE FROM digest_highlights WHERE org_id = '${ORG}'`,
    `DELETE FROM notification_person_prefs WHERE org_id = '${ORG}' AND user_id = '${ME}'`,
    // Sift: the item tags the showcase's runs added, then their rows, then its tag.
    `DELETE FROM entry_tags WHERE org_id = '${ORG}' AND EXISTS (SELECT 1 FROM org_tag_suggestions s WHERE s.org_id = entry_tags.org_id AND (${BLOCK("s.id")} OR ${BLOCK("s.run_id", 9501, 9509)}) AND s.state = 'accepted' AND s.tag = entry_tags.tag AND s.entry_type = entry_tags.entry_type AND s.entry_id = entry_tags.entry_id)`,
    `DELETE FROM org_tag_suggestions WHERE org_id = '${ORG}' AND (${BLOCK("id")} OR ${BLOCK("run_id", 9501, 9509)})`,
    `DELETE FROM org_tag_runs WHERE org_id = '${ORG}' AND ${BLOCK("id", 9501, 9509)}`,
    `DELETE FROM entry_tags WHERE org_id = '${ORG}' AND tag = (SELECT name FROM org_tags WHERE org_id = '${ORG}' AND id = ${IDS.tag})`,
    `DELETE FROM org_tags WHERE org_id = '${ORG}' AND id = ${IDS.tag}`,
    `DELETE FROM org_ai_settings WHERE org_id = '${ORG}' AND kind = 'tag.fit'`,
    // Trov's session digests.
    `DELETE FROM entry_tags WHERE org_id = '${ORG}' AND entry_type = 'feed' AND CAST(entry_id AS INTEGER) BETWEEN 9500 AND 9599`,
    `DELETE FROM ai_sessions WHERE org_id = '${ORG}' AND ${BLOCK("feed_id")}`,
    `DELETE FROM feed WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    // The current sprint, its tickets, the handoff, the Unplaced items.
    ...["ticket_events", "ticket_assignees", "ticket_links", "ticket_comments"].map((t) => `DELETE FROM ${t} WHERE org_id = '${ORG}' AND ${BLOCK("ticket_id", 9800, 9899)}`),
    `DELETE FROM tickets WHERE org_id = '${ORG}' AND ${BLOCK("id", 9800, 9899)}`,
    `DELETE FROM sprints WHERE org_id = '${ORG}' AND id = ${IDS.sprint}`,
    `DELETE FROM handoffs WHERE org_id = '${ORG}' AND id = ${IDS.handoff}`,
    `DELETE FROM needs_triage WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    // Artifacts (an attachment, a saved answer): versions and links, then the page (its trigger drops the search row).
    `DELETE FROM artifact_links WHERE org_id = '${ORG}' AND ${BLOCK("page_id")}`,
    `DELETE FROM artifact_versions WHERE org_id = '${ORG}' AND ${BLOCK("page_id")}`,
    `DELETE FROM artifact_pages WHERE org_id = '${ORG}' AND ${BLOCK("id")}`,
    // Metering.
    `DELETE FROM org_usage_daily WHERE org_id = '${ORG}' AND day >= '${since}' AND (metric GLOB 'ai_*' OR metric GLOB 'summary*')`,
  ];
  return s;
}

/** The owned tickets of the current sprint "Hosting providers rollout" (and one duplicate report outside it). */
function ticketDefs(c) {
  const t185 = c.pr185At ? Date.parse(c.pr185At) : c.t - 2 * 60 * MIN;
  return [
    { k: "A", title: "Connect hosting providers: Vercel, Render, Netlify and Fly.io", body: "One provider interface for every host, so an environment's deploys show on Repo › Hosting whoever runs it. Org settings › Hosting connects each account once.", category: "request", priority: "high", requester: ME, assignees: [ME], sprint: true,
      moves: [["submitted", c.days(9, 30), ME], ["in_progress", c.days(8), ME], ["done", c.clamp(t185 + 4 * MIN), ME]] },
    { k: "B", title: "Netlify: connect with a personal access token", body: "Netlify's OAuth app needs a review we don't have yet. Let an admin paste a personal access token instead, stored like the other hosting tokens.", category: "request", priority: "normal", requester: ME, assignees: ["Jose-Gael-Cruz-Lopez"], sprint: true,
      moves: [["submitted", c.days(9, 20), ME], ["in_progress", c.days(7), "Jose-Gael-Cruz-Lopez"], ["done", c.days(4), "Jose-Gael-Cruz-Lopez"]] },
    { k: "C", title: "Vercel: show preview deploys on their pull request", body: "A preview deploy should name the pull request it was built from, so Repo › Hosting can link straight to it.", category: "request", priority: "normal", requester: ME, assignees: ["lpcooper-arch"], sprint: true,
      moves: [["submitted", c.days(9, 10), ME], ["in_progress", c.days(8, -60), "lpcooper-arch"], ["done", c.days(6), "lpcooper-arch"]] },
    { k: "D", title: "Production backend deploy fails on Railway: 2 type errors in the e2e tests", body: "The last Production backend deploy failed at the build step: `tsc` found 2 errors in `test-e2e`. Production is still serving the previous build. Staging is fine.", category: "bug", priority: "high", requester: "meilin", assignees: [ME], sprint: true,
      moves: [["submitted", c.today(0.2), "meilin"], ["in_progress", c.today(0.3), ME]] },
    { k: "E", title: "Render: poll deploys every 10 minutes like the other hosts", body: "Render is the only host still polled hourly. Move it onto the shared 10-minute poll.", category: "request", priority: "normal", requester: ME, assignees: [], sprint: true,
      moves: [["submitted", c.days(3, -2), ME]] },
    { k: "F", title: "Fly.io: one part per region, not one per machine", body: "A Fly app with three machines in two regions shows three parts. It should show one per region, with the machine count beside it.", category: "bug", priority: "normal", requester: "Darkest-Teddy", assignees: ["Darkest-Teddy"], sprint: true,
      moves: [["submitted", c.days(7, 30), "Darkest-Teddy"], ["in_progress", c.days(6), "Darkest-Teddy"], ["testing", c.days(5), "Darkest-Teddy"]] },
    { k: "G", title: "Docs: how to connect each hosting provider", body: "One page per host: where the token comes from, what Trov reads, and how to disconnect.", category: "request", priority: "low", requester: ME, assignees: [], sprint: true,
      moves: [["submitted", c.days(3, -3), ME]] },
    { k: "H", title: "Gradebook export comes back empty for a whole school", body: "Exporting the gradebook for the whole school gives an empty CSV. Exporting one class works. Teachers at Northside need the term grades by Friday.", category: "other", priority: "normal", requester: "sanaok", assignees: [], sprint: false,
      moves: [["submitted", c.days(1, 200), "sanaok"]] },
  ];
}

/** Trov's session digests: what the AI pass writes through the gate after a burst of work. */
function digestDefs(c) {
  const foot = (prs, commits) => `\n\n_Written by Trov from ${[prs ? `${prs} pull request${prs === 1 ? "" : "s"}` : null, commits ? `${commits} commit${commits === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ")} in ${REPO}. Not reviewed by a person._`;
  const t185 = c.pr185At ? Date.parse(c.pr185At) : c.t - 2 * 60 * MIN;
  return [
    { id: IDS.feed.hosting, login: ME, subject: ME, at: c.clamp(t185 + 46 * MIN), tags: ["infra"], importance: "notable",
      summary: "Shipped: hosting providers behind one interface",
      brief: "Vercel, Render, Netlify and Fly.io now connect through one hosting interface, so each environment's deploys show on the Repo screen whoever hosts it.",
      body: "**What** One provider interface for hosting: Vercel, Render, Netlify and Fly.io connect in Org settings › Hosting, and Repo › Hosting shows each environment's deploys.\n**Why** Each host had its own poller and settings screen, so adding one meant copying the last.\n**Impact** An org can mix hosts across its environments and still see every deploy in one place." + foot(1, 3),
      prs: ["185"], commits: ["8c41d2e", "b7a09f3", "51e6c0d"] },
    { id: IDS.feed.orgs, login: ME, subject: ME, at: c.days(2, 300), tags: ["auth"], importance: "breaking",
      summary: "Shipped: several orgs can share one GitHub installation",
      brief: "One GitHub App installation can now serve several Trov organizations, and each connects only the repositories its people can read.",
      body: "**What** Several organizations may share one GitHub App installation and connect the repositories they can read.\n**Why** A person in two orgs had to install the app twice, and the second install took the repositories from the first.\n**Impact** Existing connections keep working; a second org now connects without an admin reinstalling the app." + foot(1, 2),
      prs: ["171"], commits: ["e4f1a90", "2d7c3b8"] },
    { id: IDS.feed.checkout, login: ME, subject: ME, at: c.days(4, 700), tags: ["api", "ui"], importance: "routine",
      summary: "Shipped: a new account that chose Pro reaches checkout",
      brief: "Someone who signs up in order to buy Pro now lands on checkout right after creating the account, instead of on an empty org.",
      body: "**What** A new account that chose Pro now reaches checkout after signing up.\n**Why** The sign-up redirect dropped the plan the person had picked.\n**Impact** Fewer abandoned Pro sign-ups; nothing changes for existing orgs." + foot(1, 1),
      prs: ["168"], commits: ["9b0e6f2"] },
    { id: IDS.feed.fly, login: "Darkest-Teddy", subject: "Darkest-Teddy", at: c.days(2, 60), tags: ["infra"], importance: null,
      summary: "Status: Fly.io parts are counted once per region",
      brief: "Fly.io apps are being grouped by region so a host with several machines shows one part per region. It passes locally and is waiting on a second look.",
      body: "**State** Fly.io machines are grouped by region, with the machine count beside each part.\n**Blocked on** A test app with machines in two regions to check it against.\n**Next** Open a pull request once it is checked on a real app." + foot(0, 3),
      prs: [], commits: ["5a9c2e1", "f03b7d4", "c18e6a0"] },
    { id: IDS.feed.netlify, login: "Jose-Gael-Cruz-Lopez", subject: "Jose-Gael-Cruz-Lopez", at: c.days(6, 120), tags: ["infra", "auth"], importance: null,
      summary: "Status: Netlify connects with a personal access token",
      brief: "Netlify can be connected with a pasted personal access token while its OAuth app waits for review. The token is stored like the other hosting tokens.",
      body: "**State** An admin can paste a Netlify personal access token in Org settings › Hosting; it is checked once and stored encrypted.\n**Next** Swap in OAuth once Netlify approves the app." + foot(0, 2),
      prs: [], commits: ["7e2d91c", "a4b6f08"] },
  ];
}

export function contentStatements(pre, now = new Date(), image = null) {
  const c = { ...makeClock(now), pr185At: pre.pr185At };
  const N = pre.N;
  const s = [...deleteStatements(c)];
  // The reserved author Trov writes as (0061 inserts it; the reset deletes every person before re-seeding its own).
  s.push(`INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('trov', 'Trov', 'stone', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`);

  // The current sprint: started 9 days ago, due in 6 — real ticket history, so its forecast is the server's arithmetic.
  s.push(insert("sprints", {
    id: IDS.sprint, org_id: ORG, title: "Hosting providers rollout", description: "Every host behind one provider interface: connect Vercel, Render, Netlify and Fly.io once, and see each environment's deploys on Repo › Hosting.",
    summary: "Hosting providers behind one interface, and every environment's deploys on the Repo screen.", target_date: c.date(6), status: "in_progress",
    created_at: c.days(10), created_by: ME, updated_at: c.days(1), urgency: "high", lead: ME, domain: "infra", start_date: c.date(-9),
  }));
  for (const t of ticketDefs(c)) {
    const id = IDS.tickets[t.k];
    const last = t.moves.at(-1);
    s.push(insert("tickets", {
      id, org_id: ORG, number: N[t.k], title: t.title, body: t.body, category: t.category, priority: t.priority, status: last[0],
      requester: t.requester, parent_id: null, sprint_id: t.sprint ? IDS.sprint : null, created_at: t.moves[0][1], updated_at: last[1], source: "canopy",
    }));
    for (const login of t.assignees) s.push(insert("ticket_assignees", { org_id: ORG, ticket_id: id, login }));
    let from = null;
    for (const [to, at, actor] of t.moves) {
      s.push(insert("ticket_events", { org_id: ORG, ticket_id: id, actor, from_status: from, to_status: to, created_at: at }));
      from = to;
    }
  }
  s.push(insert("ticket_links", { org_id: ORG, ticket_id: IDS.tickets.A, url: `https://github.com/${REPO}/pull/185`, kind: "github", label: "sapling #185", meta: "GITHUB · PULL REQUEST", created_by: ME, created_at: c.plus(ticketDefs(c)[0].moves[2][1], -2), locked: 0 }));
  s.push(insert("ticket_comments", { org_id: ORG, ticket_id: IDS.tickets.D, author: "meilin", body: "Railway shows the build log. Production still serves yesterday's build, so nobody is blocked yet.", created_at: c.today(0.22) }));
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES ('${ORG}', 'ticket', (SELECT COALESCE(MAX(number), 0) FROM tickets WHERE org_id = '${ORG}')) ON CONFLICT(org_id, name) DO UPDATE SET value = MAX(org_counters.value, excluded.value)`);

  // The handoff Andres sent from Ask (thread 9502's confirmed card): pending, to Jose.
  const handoffAt = c.today(0.52);
  s.push(insert("handoffs", {
    id: IDS.handoff, org_id: ORG, number: pre.HN, sender: ME, recipient: "Jose-Gael-Cruz-Lopez", status: "pending",
    body: "Fix the two tsc errors that fail the Production backend build on Railway.\n\n`test-e2e/quiz.spec.ts` passes a string where the quiz timer expects a number, and `test-e2e/streaks.spec.ts` reads `freezeDays`, which the `Streak` type doesn't have yet. Production still serves the previous build.",
    context: { repo: REPO, branch: "main", task: "Fix the two tsc errors failing the Production backend build", done: ["Read the Railway build log: 2 errors, both in test-e2e", "Filed it as a ticket in the Hosting providers rollout sprint"], next: ["Fix the timer type in quiz.spec.ts", "Add freezeDays to the Streak type, or drop it from the test", "Redeploy Production backend and check Railway shows it ready"], files: ["test-e2e/quiz.spec.ts", "test-e2e/streaks.spec.ts", "backend/models/streak.ts"] },
    created_at: handoffAt, expires_at: new Date(Date.parse(handoffAt) + 7 * DAY).toISOString(),
  }));
  s.push(`INSERT INTO org_counters (org_id, name, value) VALUES ('${ORG}', 'handoff', ${pre.HN}) ON CONFLICT(org_id, name) DO UPDATE SET value = MAX(org_counters.value, excluded.value)`);

  // Two doc-shaped Unplaced items an agent filed under a section that does not exist (the destination card's case).
  s.push(insert("needs_triage", { id: IDS.triage.railway, org_id: ORG, source_author: "Jose-Gael-Cruz-Lopez", resolved: 0, created_at: c.days(1, 90), reason: "unknown section: runbooks",
    raw: JSON.stringify({ slug: "sapling-railway-deploys", section: "runbooks", title: "Railway deploys", confidence: "high", change_summary: "New runbook for the backend's Railway deploys",
      body: "# Railway deploys\n\nThe backend deploys to Railway from the `production` branch; Staging deploys from `main`.\n\n## When a deploy fails\n\n1. Open the build log in Railway (Deployments › the failed one › Build Logs).\n2. A failed build leaves the previous deploy serving: nobody is down.\n3. Fix forward on `main`, let Staging go green, then merge to `production`.\n\n## Rolling back\n\nRailway › Deployments › the last good one › Redeploy." }) }));
  s.push(insert("needs_triage", { id: IDS.triage.evals, org_id: ORG, source_author: "Darkest-Teddy", resolved: 0, created_at: c.ago(170), reason: "unknown section: evals",
    raw: JSON.stringify({ slug: "sapling-quiz-agent-evals", section: "evals", title: "Quiz agent evals", confidence: "high", change_summary: "How the quiz agent is evaluated",
      body: "# Quiz agent evals\n\nThe quiz agent is checked against 38 real failures exported to `fixtures/evals/quiz_failures.jsonl`.\n\nRun `python -m backend.evals.quiz_agent_eval` before and after a prompt change; it prints the pass rate for each.\n\nTarget: under 1% of quiz calls failing validation." }) }));

  // Trov's session digests, with the bookkeeping the Feed links their sources by.
  for (const d of digestDefs(c)) {
    s.push(insert("feed", { id: d.id, org_id: ORG, author: "trov", summary: d.summary, brief: d.brief, body: d.body, artifacts: { prs: d.prs, commits: d.commits, issues: [] }, created_at: d.at, origin: "ai", model: HAIKU, subject: d.subject, importance: d.importance }));
    for (const tag of d.tags) s.push(insert("entry_tags", { org_id: ORG, tag, entry_type: "feed", entry_id: String(d.id) }));
    s.push(insert("ai_sessions", { org_id: ORG, repo: REPO, actor_login: d.login, started_at: c.plus(d.at, -160), ended_at: c.plus(d.at, -46), status: "done", reason: null, shas: d.commits, prs: d.prs.map(Number), feed_id: d.id, model: HAIKU, prompt_version: "digest-1", created_at: d.at }));
  }

  // The image Andres attached to an Ask question: a PRIVATE artifact, its bytes in R2 (stage A puts them there).
  if (image) {
    const at = c.today(0.5);
    s.push(insert("artifact_pages", { id: IDS.artifact.attachment, org_id: ORG, slug: "railway-build-log-png", title: "railway-build-log.png", kind: "image", area: "data", repo: "", author_id: ME, status: "draft", visibility: "private", current_version: 1, created_at: at, updated_at: at }));
    s.push(insert("artifact_versions", { org_id: ORG, page_id: IDS.artifact.attachment, version_no: 1, summary: "Attached in Ask Trov", content: null, r2_key: `artifacts/${image.sha}`, size_bytes: image.size, content_type: "image/png", sha256: image.sha, filename: "railway-build-log.png", created_by: ME, created_at: at }));
    s.push(insert("artifacts_fts", { page_id: String(IDS.artifact.attachment), title: "railway-build-log.png", description: "Attached in Ask Trov", body: "", org_id: ORG }));
  }
  return s;
}

// ── stage B: reading the org back ────────────────────────────────────────────────────────────────────────────────
export const SNAP_SQL = [
  `SELECT id, number, title, status, priority, category, sprint_id, updated_at FROM tickets WHERE org_id = '${ORG}'`,
  `SELECT id, title, status, start_date, target_date FROM sprints WHERE org_id = '${ORG}'`,
  `SELECT number, sender, recipient, status, body FROM handoffs WHERE org_id = '${ORG}'`,
  `SELECT slug, title, owner, body FROM docs WHERE org_id = '${ORG}'`,
  `SELECT slug, version, created_by, body FROM doc_versions WHERE org_id = '${ORG}' AND status = 'staged' ORDER BY version DESC`,
  `SELECT id, title, status FROM adrs WHERE org_id = '${ORG}'`,
  `SELECT e.ref_number AS n, e.occurred_at AS at, s.title FROM events e LEFT JOIN pr_summaries s ON s.org_id = e.org_id AND s.repo = e.repo AND s.semantic_key = e.semantic_key WHERE e.org_id = '${ORG}' AND e.event_type = 'pr_merged'`,
  `SELECT p.pr_number AS n, p.theme_id FROM pr_themes p JOIN repo_themes t ON t.id = p.theme_id AND t.org_id = p.org_id WHERE p.org_id = '${ORG}' AND t.status = 'active'`,
  `SELECT id, name, color_key, status, position FROM repo_themes WHERE org_id = '${ORG}' AND status = 'active' ORDER BY position, id`,
  `SELECT (SELECT COUNT(*) FROM docs WHERE org_id = '${ORG}') AS docs, (SELECT COUNT(*) FROM tickets WHERE org_id = '${ORG}') AS tickets,
          (SELECT COUNT(*) FROM ticket_comments WHERE org_id = '${ORG}') AS comments, (SELECT COUNT(*) FROM feed WHERE org_id = '${ORG}' AND created_at >= '2026-09-01') AS feed,
          (SELECT COUNT(*) FROM artifact_pages WHERE org_id = '${ORG}' AND deleted_at IS NULL AND visibility = 'org') AS artifacts`,
  `SELECT d.env, d.part, d.state, d.inspect_url, d.url, d.created_at FROM hosting_deploys d WHERE d.org_id = '${ORG}' ORDER BY d.created_at DESC, d.id DESC`,
  `SELECT key, label FROM org_environments WHERE org_id = '${ORG}'`,
  `SELECT env_key, part_key, label FROM org_environment_parts WHERE org_id = '${ORG}'`,
  `SELECT number, state, title FROM repo_events WHERE org_id = '${ORG}' AND kind = 'pr' AND number IS NOT NULL ORDER BY id DESC`,
  `SELECT timezone FROM notification_settings WHERE org_id = '${ORG}'`,
];
export function snapFrom(results) {
  const [tickets, sprints, handoffs, docs, staged, adrs, merged, prThemes, themes, counts, deploys, envs, parts, prEvents, tz] = results;
  return { tickets, sprints, handoffs, docs, staged, adrs, merged, prThemes, themes, counts: counts[0] ?? {}, deploys, envs, parts, prEvents, timezone: tz[0]?.timezone ?? "America/New_York" };
}

// ── the AI output ────────────────────────────────────────────────────────────────────────────────────────────────
const prCite = (n) => ({ ref: `pr:${n}`, label: `#${n}`, href: `https://github.com/${REPO}/pull/${n}` });
const ticketCite = (n) => ({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });
const handoffCite = (n) => ({ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` });
const feedCite = (id, summary) => ({ ref: `feed:${id}`, label: summary.slice(0, 80), href: "#feed" });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s) => (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
/** "a and b", "a, b, and c". */
const listWords = (xs) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);

/** One contiguous changed region of `before` → `after` (common prefix and suffix), as Ask's doc hunks. */
function oneHunk(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let k = 0;
  while (k < a.length - p && k < b.length - p && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  let heading = null;
  for (let i = p - 1; i >= 0; i--) if (/^#{1,6}\s/.test(a[i])) { heading = a[i]; break; }
  return { index: 0, heading, before: a.slice(p, a.length - k).join("\n"), after: b.slice(p, b.length - k).join("\n") };
}

/** The Ask threads: shapes of the design's scenario transcripts (shared/ai-fixtures.ts › askTranscript) over
 *  SaplingLearn's real items. `v` resolves a ref to the RefView the running server built (or records it). */
function threadDefs(x) {
  const { c, N, HN, v, snap } = x;
  const T = (k) => `[[ticket:${N[k]}]]`;
  const sprint = snap.sprints.find((s) => s.id === IDS.sprint);
  const token = snap.sprints.find((s) => s.id === 3);
  const archStaged = snap.staged.find((d) => d.slug === "sapling-architecture");
  const archLive = snap.docs.find((d) => d.slug === "sapling-architecture");
  const tk = (k) => snap.tickets.find((t) => t.id === IDS.tickets[k]);

  // The charts are the server's fixed queries, run on the rows that exist (src/ai/ask/charts.ts).
  const mergedChart = (at) => {
    const starts = weekStarts(new Date(at), 8);
    const counts = starts.map(() => 0);
    for (const m of snap.merged) {
      if (!m.at || m.at > at) continue;
      const i = starts.indexOf(mondayOf(new Date(m.at)));
      if (i >= 0) counts[i]++;
    }
    return { kind: "chart", chart: { title: "Merged PRs by week", unit: "merged pull requests", query: "merged_prs_by_week", params: { weeks: 8 }, total: counts.reduce((a, b) => a + b, 0), rows: starts.map((s, i) => ({ label: shortDay(s), value: counts[i] })) } };
  };
  const themesBlock = (at) => {
    const starts = weekStarts(new Date(at), 8);
    const perWeek = starts.map(() => 0);
    const byTheme = new Map(snap.themes.map((t) => [t.id, starts.map(() => 0)]));
    for (const m of snap.merged) {
      if (!m.at || m.at > at) continue;
      const i = starts.indexOf(mondayOf(new Date(m.at)));
      if (i < 0) continue;
      perWeek[i]++;
      const th = snap.prThemes.find((p) => p.n === m.n);
      if (th && byTheme.has(th.theme_id)) byTheme.get(th.theme_id)[i]++;
    }
    const lanes = snap.themes.map((t) => ({ theme: t.name, color: t.color_key, values: byTheme.get(t.id).map((n, i) => (perWeek[i] ? Math.round((n / perWeek[i]) * 100) / 100 : 0)) }))
      .filter((l) => l.values.some((n) => n > 0));
    return { kind: "themes", themes: { title: "Where the time went, by theme", caption: "Share of merged PRs", weeks: starts.map(shortDay), lanes } };
  };
  const items = (...refs) => ({ kind: "items", items: refs.map((r) => v(r)).filter(Boolean) });

  const threads = [];
  // 1 · PINNED — a plain answer with items, a chart, the theme strip and a diagram; then saved as an artifact.
  {
    const qAt = c.ago(7), aAt = c.ago(6), q2 = c.ago(4), a2 = c.ago(3);
    threads.push({ id: 9501, title: "Where hosting stands this week", mode: "smart", pinned: 1, turn: 2, savedFrom: 0,
      messages: [
        { role: "user", at: qAt, text: "Where does the hosting work stand, and what's blocking the sprint?", context: [`sprint:${IDS.sprint}`] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [17_880, 1_240, 14_310],
          activity: [
            { tool: "get_sprint", icon: "sprint", label: "Looked at the Hosting providers rollout sprint", results: [`sprint:${IDS.sprint}`, ...["A", "B", "C", "D", "E", "F", "G"].map((k) => `ticket:${N[k]}`)] },
            { tool: "get_repo_dashboard", icon: "ci", label: `Checked deploys on ${REPO}`, results: [`repo:${REPO}`], resultLine: "1 result" },
            { tool: "get_events", icon: "pr", label: `Read merged PRs on ${REPO}`, results: ["pr:185", "pr:171", "pr:168"], resultLine: "3 results" },
            { tool: "show_items", icon: "read", label: "Showed items", results: [`ticket:${N.D}`, "pr:185", `sprint:${IDS.sprint}`] },
            { tool: "show_chart", icon: "read", label: "Charted merged PRs by week", results: [] },
          ],
          parts: [
            { md: `Hosting is mostly built: [[pr:185]] put Vercel, Render, Netlify and Fly.io behind one interface, and three of the sprint's seven tickets are done. What holds [[sprint:${IDS.sprint}]] back is narrow.\n\n## What is blocking\n\n- The Production backend build fails on Railway with two type errors. ${T("D")} tracks it and [[person:jose-gael-cruz-lopez]] has the fix.\n- ${T("F")} is in testing with [[person:darkest-teddy]].\n- ${T("E")} and ${T("G")} have no owner yet.\n\n| Ticket | Status | Owner |\n| --- | --- | --- |\n| ${T("D")} | [[ticket:${N.D}|status]] | Andres |\n| ${T("F")} | [[ticket:${N.F}|status]] | Jack |\n| ${T("E")} | [[ticket:${N.E}|status]] | Unassigned |\n| ${T("G")} | [[ticket:${N.G}|status]] | Unassigned |\n\n` },
            { block: items(`ticket:${N.D}`, "pr:185", `sprint:${IDS.sprint}`) },
            { md: "## Pace\n\nMerged pull requests came in a burst in mid-September and have been steady since. Lately the work moved from billing and sign-in to the Repo dashboard.\n\n" },
            { block: mergedChart(aAt) },
            { block: themesBlock(aAt) },
            { block: { kind: "diagram", diagram: { title: "What waits on what", caption: "Each step waits on the one before it", layout: "chain", nodes: [
              { id: "fix", eyebrow: "Handoff", label: "Fix the two type errors", ref: `handoff:${HN}`, view: v(`handoff:${HN}`) },
              { id: "bug", eyebrow: "Ticket", label: `#${N.D} Production backend build`, ref: `ticket:${N.D}`, view: v(`ticket:${N.D}`) },
              { id: "repo", eyebrow: "Production", label: "A green Railway deploy", ref: `repo:${REPO}`, view: v(`repo:${REPO}`) },
              { id: "sprint", eyebrow: "Sprint", label: `Hosting providers rollout, due ${shortDay(sprint.target_date)}`, ref: `sprint:${IDS.sprint}`, view: v(`sprint:${IDS.sprint}`) },
            ], edges: [["fix", "bug"], ["bug", "repo"], ["repo", "sprint"]] } } },
            { md: `Fixing the build unblocks the Production deploy. At the current pace the sprint finishes after its due date, so it may be worth moving ${T("G")} to the next one.` },
          ],
          followups: ["Move the hosting docs ticket to the next sprint", "What changed in PR #185?", "Save this as a doc"] },
        { role: "user", at: q2, text: "Save this as a doc", context: [] },
        { role: "assistant", at: a2, mode: "smart", tokens: [21_040, 150, 20_480],
          activity: [{ tool: "save_artifact", icon: "read", label: "Prepared a save form", results: [] }],
          parts: [{ save: true }, { md: "Saved it as a private artifact. Publish it from Artifacts when you want the team to see it." }],
          followups: [] },
      ] });
  }
  // 2 · TODAY — a question with an attached image (the Railway build log) and a CONFIRMED write card (a handoff).
  {
    const qAt = c.today(0.48), aAt = c.today(0.5), decided = c.today(0.52);
    threads.push({ id: 9502, title: "Why the Production backend deploy failed", mode: "smart", turn: 1, attachment: true,
      messages: [
        { role: "user", at: qAt, text: "The Production backend deploy just failed on Railway. Here's the build log. What broke, and who should fix it?", context: [`ticket:${N.D}`] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [24_610, 690, 19_200],
          activity: [
            { tool: "read_attachment", icon: "read", label: "Read railway-build-log.png", results: [] },
            { tool: "get_ticket", icon: "tickets", label: `Read ticket #${N.D}`, results: [`ticket:${N.D}`, `sprint:${IDS.sprint}`, "person:andresl230"] },
            { tool: "get_repo_dashboard", icon: "ci", label: `Checked deploys on ${REPO}`, results: [`repo:${REPO}`], resultLine: "1 result" },
            { tool: "list_people", icon: "read", label: "Looked up who works on the backend", results: ["person:jose-gael-cruz-lopez", "person:darkest-teddy"], resultLine: "2 results" },
          ],
          parts: [
            { md: `The build stopped at the type check, before anything was deployed. Two errors, both in the e2e tests:\n\n- \`quiz.spec.ts\` passes a string where the quiz timer expects a number.\n- \`streaks.spec.ts\` reads \`freezeDays\`, which the \`Streak\` type doesn't have yet.\n\nNo app code failed, so Production keeps serving the previous build ([[repo:${REPO}]] shows it as the last good deploy). ${T("D")} already tracks this.\n\n[[person:jose-gael-cruz-lopez]] owns the backend and wrote the streaks change, so he is the quickest to fix both. I drafted a handoff for him:` },
            { action: { id: 9501, tool: "send_handoff", kind: "handoff", state: "confirmed", decided,
              args: { body: "Fix the two tsc errors that fail the Production backend build on Railway.", recipient: "Jose-Gael-Cruz-Lopez", context: { repo: REPO, branch: "main", task: "Fix the two tsc errors failing the Production backend build", done: ["Read the Railway build log: 2 errors, both in test-e2e", "Filed it as a ticket in the Hosting providers rollout sprint"], next: ["Fix the timer type in quiz.spec.ts", "Add freezeDays to the Streak type, or drop it from the test", "Redeploy Production backend and check Railway shows it ready"], files: ["test-e2e/quiz.spec.ts", "test-e2e/streaks.spec.ts", "backend/models/streak.ts"] } },
              preview: { title: "New handoff", item: null, lines: [
                { label: "From", value: `@${ME}` }, { label: "To", value: "@Jose-Gael-Cruz-Lopez" }, { label: "Task", value: "Fix the two tsc errors failing the Production backend build" },
                { label: "Done", value: "Read the Railway build log: 2 errors, both in test-e2e; Filed it as a ticket in the Hosting providers rollout sprint" },
                { label: "Next", value: "Fix the timer type in quiz.spec.ts; Add freezeDays to the Streak type, or drop it from the test; Redeploy Production backend and check Railway shows it ready" },
                { label: "Files", value: "test-e2e/quiz.spec.ts, test-e2e/streaks.spec.ts, backend/models/streak.ts" },
              ] },
              result: { id: HN, recipient: "Jose-Gael-Cruz-Lopez", url: `#handoffs/${HN}` }, undo: { id: HN } } },
          ],
          followups: [`Move #${N.D} to Testing once Railway is green`, "What else changed in the streaks work?"] },
      ] });
  }
  // 3 · TODAY — a PR answer: the chip opens the PR in the inspector.
  {
    const qAt = c.today(0.7), aAt = c.today(0.72);
    threads.push({ id: 9503, title: "What changed in PR #185", mode: "smart", turn: 1, draft: "Who reviewed #185",
      messages: [
        { role: "user", at: qAt, text: "What changed in #185, and is anything left to do after it?", context: [] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [9_420, 410, 7_990],
          activity: [
            { tool: "get_events", icon: "pr", label: "Read PR #185", results: ["pr:185"] },
            { tool: "list_tickets", icon: "tickets", label: "Read the Hosting providers rollout tickets", results: [`ticket:${N.A}`, `ticket:${N.E}`, `ticket:${N.G}`], resultLine: "3 results" },
          ],
          parts: [
            { md: `[[pr:185]] put every hosting provider behind one interface. Vercel, Render, Netlify and Fly.io now connect once in Org settings › Hosting, and Repo › Hosting shows each environment's deploys whoever hosts it.\n\nIt closed ${T("A")}. Two follow-ups from its review are still open in the sprint:\n\n- ${T("E")}: Render is the only host still polled hourly.\n- ${T("G")}: a page per host on connecting it.\n\n` },
            { block: items("pr:185", `ticket:${N.A}`) },
          ],
          followups: ["Who reviewed #185?", "Show the hosting tickets that are still open"] },
      ] });
  }
  // 4 · TODAY — a ⌘J panel thread opened on a ticket.
  {
    const qAt = c.today(0.85), aAt = c.today(0.87);
    threads.push({ id: 9504, title: `What's left on #${N.D}`, mode: "smart", turn: 1, origin: "panel", contextRef: `ticket:${N.D}`,
      messages: [
        { role: "user", at: qAt, text: "What's left before this can close?", context: [`ticket:${N.D}`] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [6_310, 240, 5_120],
          activity: [
            { tool: "get_ticket", icon: "tickets", label: `Read ticket #${N.D}`, results: [`ticket:${N.D}`, "person:andresl230", `sprint:${IDS.sprint}`] },
            { tool: "get_handoff", icon: "handoffs", label: `Read handoff #${HN}`, results: [`handoff:${HN}`] },
          ],
          parts: [{ md: `Two things:\n\n- The two type errors in the e2e tests. [[handoff:${HN}]] hands them to [[person:jose-gael-cruz-lopez]], and it isn't claimed yet.\n- A green Production backend deploy after the fix. Move ${T("D")} to Testing once Railway shows it ready.` }],
          followups: ["Remind Jose about the handoff"] },
      ] });
  }
  // 5 · THIS WEEK — an answer from a doc that is out of date: Andres pressed "Wrong?" › "It is out of date".
  {
    const qAt = c.days(1, 190), aAt = c.days(1, 189);
    threads.push({ id: 9505, title: "Running the migration runner against prod", mode: "smart", turn: 1, wrong: { reason: "out_of_date", at: c.days(1, 170), cites: ["doc:sapling-infrastructure"] },
      messages: [
        { role: "user", at: qAt, text: "Is it safe to run python -m db.migrate against prod now?", context: [] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [11_250, 300, 9_870],
          activity: [
            { tool: "query", icon: "search", label: "Searched docs for 'migrate prod'", results: ["doc:sapling-infrastructure", "doc:sapling-architecture"], resultLine: "2 results" },
            { tool: "get_doc", icon: "docs", label: "Read Infrastructure — Data, Observability, Security & Deploy", results: ["doc:sapling-infrastructure"] },
          ],
          parts: [{ md: "Not yet, going by [[doc:sapling-infrastructure]]: the runner tracks applied files in `public.schema_migrations`, but prod has no such table. A plain `python -m db.migrate` would treat every file as pending and fail on the first table that already exists.\n\nBaseline prod into the runner first, or apply a single file through Supabase's own tooling." }],
          followups: ["What does the feed say about the migration runner?"] },
      ] });
  }
  // 6 · THIS WEEK — Auto: a group of two writes that ran on their own (with Undo), and a Publish that WAITS.
  {
    const qAt = c.days(3, -1), aAt = c.days(3, -2);
    const E = tk("E"), G = tk("G");
    const hunk = archLive && archStaged ? oneHunk(archLive.body, archStaged.body) : null;
    threads.push({ id: 9506, title: "File the hosting review follow-ups", mode: "smart", turn: 1, auto: 1,
      messages: [
        { role: "user", at: qAt, text: "File the two follow-ups from the hosting review in the sprint: Render should poll every 10 minutes like the others, and we need a page on connecting each host. Then publish Jose's observability section in the architecture doc.", context: [] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [12_900, 560, 10_640],
          activity: [
            { tool: "get_sprint", icon: "sprint", label: "Looked at the Hosting providers rollout sprint", results: [`sprint:${IDS.sprint}`] },
            { tool: "get_doc", icon: "docs", label: "Read Architecture", results: ["doc:sapling-architecture"] },
          ],
          parts: [
            { action: { id: 9502, tool: "create_ticket", kind: "ticket", state: "auto", group: "9506-1-1", decided: aAt,
              args: { title: E.title, body: "Render is the only host still polled hourly. Move it onto the shared 10-minute poll.", category: "request", priority: "normal", assignees: [], sprint_id: IDS.sprint },
              preview: { title: "New ticket", item: null, lines: [{ label: "Title", value: E.title }, { label: "Description", value: "Render is the only host still polled hourly. Move it onto the shared 10-minute poll." }, { label: "Category", value: "request" }, { label: "Priority", value: "normal" }, { label: "Assignee", value: "Unassigned" }, { label: "Sprint", value: "Hosting providers rollout" }] },
              result: { id: N.E, title: E.title }, undo: { id: N.E, stamp: E.updated_at } } },
            { action: { id: 9503, tool: "create_ticket", kind: "ticket", state: "auto", group: "9506-1-1", decided: aAt,
              args: { title: G.title, body: "One page per host: where the token comes from, what Trov reads, and how to disconnect.", category: "request", priority: "low", assignees: [], sprint_id: IDS.sprint },
              preview: { title: "New ticket", item: null, lines: [{ label: "Title", value: G.title }, { label: "Description", value: "One page per host: where the token comes from, what Trov reads, and how to disconnect." }, { label: "Category", value: "request" }, { label: "Priority", value: "low" }, { label: "Assignee", value: "Unassigned" }, { label: "Sprint", value: "Hosting providers rollout" }] },
              result: { id: N.G, title: G.title }, undo: { id: N.G, stamp: G.updated_at } } },
            ...(archStaged ? [{ action: { id: 9504, tool: "publish_doc", kind: "publish", state: "waiting", group: "9506-1-2", decided: null,
              args: { slug: "sapling-architecture", version: archStaged.version },
              preview: { title: "Publish Architecture", item: v("doc:sapling-architecture"), canPublish: true, lines: [
                { label: "Version", value: `v${archStaged.version}` }, { label: "Staged by", value: `@${archStaged.created_by}` },
                { label: "What it does", value: `Publishing makes v${archStaged.version} live for the org. Agents read it from then on.` },
              ], hunks: hunk ? [hunk] : [] },
              result: null, undo: null } }] : []),
            { md: "Filed both in the sprint. Publishing waits for you, even on Auto." },
          ],
          followups: ["Who should take the Render poll?"] },
      ] });
  }
  // 7 · THIS WEEK — Ask mode: one write CONFIRMED then UNDONE, one CANCELLED.
  {
    const qAt = c.days(4, 20), aAt = c.days(4, 19), done = c.days(4, 17), undone = c.days(4, 15), cancelled = c.days(4, 16);
    const F = tk("F");
    threads.push({ id: 9507, title: "Tidy the hosting board", mode: "smart", turn: 1,
      messages: [
        { role: "user", at: qAt, text: `Move #${N.F} to Done and put Jack on #${N.E}.`, context: [] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [7_730, 320, 6_210],
          activity: [
            { tool: "get_ticket", icon: "tickets", label: `Read ticket #${N.F}`, results: [`ticket:${N.F}`, "person:darkest-teddy"] },
            { tool: "get_ticket", icon: "tickets", label: `Read ticket #${N.E}`, results: [`ticket:${N.E}`] },
          ],
          parts: [
            { md: "Two changes. Nothing happens until you confirm each one." },
            { action: { id: 9505, tool: "transition_ticket", kind: "move", state: "undone", group: "9507-1-1", decided: done,
              args: { id: N.F, to: "done" },
              preview: { title: `Move #${N.F} to Done`, lines: [{ label: "Status", value: "Testing → Done" }], item: v(`ticket:${N.F}`) },
              result: { id: N.F, title: F.title, status: "done" }, undo: { id: N.F, to: "testing", stamp: F.updated_at }, undoneAt: undone } },
            { action: { id: 9506, tool: "assign_ticket", kind: "ticket", state: "cancelled", group: "9507-1-2", decided: cancelled,
              args: { id: N.E, login: "Darkest-Teddy", on: true },
              preview: { title: `Assign @Darkest-Teddy to #${N.E}`, lines: [{ label: "Assignee", value: "Add @Darkest-Teddy" }], item: v(`ticket:${N.E}`) },
              result: null, undo: null } },
          ],
          followups: [] },
      ] });
  }
  // 8 · THIS WEEK — Thinking, with its summary.
  {
    const qAt = c.days(5, 40), aAt = c.days(5, 38);
    threads.push({ id: 9508, title: "Is Token rotation & audit log still realistic?", mode: "thinking", turn: 1,
      messages: [
        { role: "user", at: qAt, text: "Is Token rotation & audit log still realistic, or should we move its tickets?", context: ["sprint:3"] },
        { role: "assistant", at: aAt, mode: "thinking", tokens: [26_300, 1_820, 18_400],
          thinking: { seconds: 21, summary: "Started from the sprint's four tickets and their history. Only #4 closed, and it was a question rather than build work. #3 and #7 moved after the due date, so the work is alive but the date is not. Checked whether the open tickets depend on each other before suggesting a split." },
          activity: [
            { tool: "get_sprint", icon: "sprint", label: "Looked at the Token rotation & audit log sprint", results: ["sprint:3", "ticket:1", "ticket:3", "ticket:4", "ticket:7"] },
            { tool: "get_ticket", icon: "tickets", label: "Read ticket #7", results: ["ticket:7", "person:jose-gael-cruz-lopez"] },
            { tool: "get_ticket", icon: "tickets", label: "Read ticket #1", results: ["ticket:1", "person:meilin"] },
          ],
          parts: [{ md: `Not on its date. [[sprint:3]] was due on ${shortDay(token?.target_date ?? "2026-06-10")} and one of its four tickets is closed, so the date no longer tells you anything.\n\nThe work itself is still moving:\n\n- [[ticket:3]] is in progress with you.\n- [[ticket:7]] is in progress with [[person:jose-gael-cruz-lopez]].\n- [[ticket:1]] has no assignee. It is a gradebook export bug and fits a reporting sprint better than token rotation.\n\nI'd give the sprint a new date for #3 and #7, and move #1 to the backlog.` }],
          followups: ["Move #1 to the backlog", "Draft a new date for the sprint"] },
      ] });
  }
  // 9 · THIS WEEK — Fast.
  {
    const qAt = c.days(2, 30), aAt = c.days(2, 29);
    threads.push({ id: 9509, title: "Handoffs waiting on me", mode: "fast", turn: 1,
      messages: [
        { role: "user", at: qAt, text: "Which handoffs are waiting on me?", context: [] },
        { role: "assistant", at: aAt, mode: "fast", tokens: [4_120, 210, 3_300],
          activity: [{ tool: "list_handoffs", icon: "handoffs", label: "Read the open handoffs", results: ["handoff:16", "handoff:17", "handoff:15"], resultLine: "3 results" }],
          parts: [{ md: "Two are left for you, and one for anyone:\n\n- [[handoff:16]] from [[person:jose-gael-cruz-lopez]]: resume tokens work on the backend; the reader still drops the stream on reconnect.\n- [[handoff:17]] from [[person:darkest-teddy]]: the quiz agent's parser is fixed; the prompt and the eval are what remain.\n- [[handoff:15]], left for anyone: OCR retries use up the Gemini quota on large PDFs." }],
          followups: ["Claim the resume tokens handoff"] },
      ] });
  }
  // 10 · EARLIER — nothing found: what Trov searched, with the server's own counts.
  {
    const qAt = c.days(9, 50), aAt = c.days(9, 49);
    const k = snap.counts;
    threads.push({ id: 9510, title: "SSO pricing on the Northside call", mode: "smart", turn: 1,
      messages: [
        { role: "user", at: qAt, text: "What did Northside say about SSO pricing on the last call?", context: [] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [6_900, 120, 5_800],
          activity: [
            { tool: "query", icon: "search", label: "Searched docs for 'Northside SSO pricing'", results: [], resultLine: "No results" },
            { tool: "list_tickets", icon: "tickets", label: "Searched tickets and comments", results: [], resultLine: "No results" },
            { tool: "get_feed", icon: "feed", label: "Searched the feed since Sep 1", results: [], resultLine: "No results" },
            { tool: "show_not_found", icon: "search", label: "Checked what was searched", results: [] },
          ],
          parts: [{ block: { kind: "not_found", notFound: { query: "what Northside said about SSO pricing on the last call", tries: ["What do our docs say about SSO?", "Which tickets mention SSO?"], searched: [
            { area: "Docs", scope: `Technical and Product, ${k.docs} docs` },
            { area: "Tickets and comments", scope: `${k.tickets} tickets, ${k.comments} comments` },
            { area: "Feed", scope: `${k.feed} entries since Sep 1` },
            ...(Number(k.artifacts) ? [{ area: "Artifacts", scope: `${k.artifacts} artifact${Number(k.artifacts) === 1 ? "" : "s"}` }] : []),
          ] } } }],
          followups: [] },
      ] });
  }
  // 11 · EARLIER — a summary with a chart.
  {
    const qAt = c.days(12, 40), aAt = c.days(12, 38);
    const sept = snap.merged.filter((m) => m.at && m.at.startsWith("2026-09")).map((m) => m.n);
    const list = (ns) => ns.filter((n) => sept.includes(n)).map((n) => `[[pr:${n}]]`).join(", ");
    threads.push({ id: 9511, title: "What shipped in September", mode: "smart", turn: 1,
      messages: [
        { role: "user", at: qAt, text: "Summarize what we shipped in September for the team update.", context: [] },
        { role: "assistant", at: aAt, mode: "smart", tokens: [15_200, 980, 12_100],
          activity: [{ tool: "get_events", icon: "pr", label: `Read merged PRs on ${REPO} for September`, results: sept.map((n) => `pr:${n}`), resultLine: `${sept.length} results` }],
          parts: [
            { md: `September went to organizations, plans and e-mail:\n\n- **Organizations and sign-in**: ${list([93, 103, 111, 120])}. Trov became multi-tenant, connects repositories through the GitHub App, and lets anyone sign up with Google.\n- **Billing and plans**: ${list([104, 106, 117, 123])}. Personal, Pro and Enterprise plans, Stripe checkout, and gifted plans.\n- **E-mail**: ${list([34, 37, 43, 114, 127, 130])}. Daily and weekly digests, a preview for admins, and a design that fits a phone.\n\n` },
            { block: mergedChart(aAt) },
            { md: "Mid-September was the busiest week of the quarter." },
          ],
          followups: ["Turn this into a feed entry", "Who reviewed the billing work?"] },
      ] });
  }
  // 12 · EARLIER — Fast, people and docs.
  {
    const qAt = c.days(20, 30), aAt = c.days(20, 29);
    threads.push({ id: 9512, title: "Who owns the document pipeline?", mode: "fast", turn: 1,
      messages: [
        { role: "user", at: qAt, text: "Who owns the document pipeline?", context: [] },
        { role: "assistant", at: aAt, mode: "fast", tokens: [3_640, 150, 2_900],
          activity: [{ tool: "query", icon: "search", label: "Searched docs for 'document pipeline'", results: ["doc:sapling-document-pipeline", "doc:sapling-architecture", "doc:sapling-backend-ai"], resultLine: "3 results" }],
          parts: [{ md: "[[person:darkest-teddy]] owns [[doc:sapling-document-pipeline]], which covers upload, OCR and streaming. [[person:jose-gael-cruz-lopez]] owns the two docs it builds on, [[doc:sapling-architecture]] and [[doc:sapling-backend-ai]]." }],
          followups: ["What changed in the document pipeline lately?"] },
      ] });
  }
  return threads;
}

/** Every ref the Ask threads name (for the server's peek). */
export function showcaseRefs(pre, snap, now = new Date()) {
  const c = { ...makeClock(now), pr185At: pre.pr185At };
  const seen = new Set();
  const v = (r) => { seen.add(r); return null; };
  const threads = threadDefs({ c, N: pre.N, HN: pre.HN, v, snap });
  const tokenRe = /\[\[(ticket|pr|doc|decision|feed|sprint|handoff|artifact|person|prompt|repo):([A-Za-z0-9][A-Za-z0-9_.@/-]{0,99})(?:\|status)?\]\]/g;
  for (const t of threads) for (const m of t.messages) {
    for (const r of m.context ?? []) seen.add(r);
    for (const a of m.activity ?? []) for (const r of a.results ?? []) seen.add(r);
    for (const p of m.parts ?? []) if (p.md) for (const mt of p.md.matchAll(tokenRe)) seen.add(`${mt[1]}:${mt[2]}`);
  }
  return [...seen];
}

/** Ref tokens → Markdown links for a saved answer (src/ai/ask/render.ts `tokensToMarkdown`). */
function tokensToMarkdown(text, views, appBase) {
  const abs = (h) => (!h ? null : h.startsWith("#") ? `${appBase}/${h}` : h);
  const label = (x) => (x.num !== undefined && ["ticket", "pr", "handoff"].includes(x.type) ? `#${x.num} ${x.title}` : x.title);
  return text.replace(/\[\[(ticket|pr|doc|decision|feed|sprint|handoff|artifact|person|prompt|repo):([A-Za-z0-9][A-Za-z0-9_.@/-]{0,99})(?:\|(status))?\]\]/g, (_m, type, key, status) => {
    const x = views.get(type === "person" ? `${type}:${key.toLowerCase()}` : `${type}:${key}`);
    if (status) return x?.status?.word ?? "";
    if (!x) return `${type} ${key}`;
    const href = abs(x.href);
    return href ? `[${label(x)}](${href})` : label(x);
  });
}
function blockMarkdown(b, views, appBase) {
  const abs = (h) => (!h ? null : h.startsWith("#") ? `${appBase}/${h}` : h);
  const label = (x) => (x.num !== undefined && ["ticket", "pr", "handoff"].includes(x.type) ? `#${x.num} ${x.title}` : x.title);
  switch (b.kind) {
    case "items": return b.items.map((x) => `- ${abs(x.href) ? `[${label(x)}](${abs(x.href)})` : label(x)}${x.status ? ` · ${x.status.word}` : ""}`).join("\n");
    case "chart": return [`**${b.chart.title}** (${b.chart.total} ${b.chart.unit})`, "", `| | ${b.chart.unit} |`, "| --- | ---: |", ...b.chart.rows.map((r) => `| ${r.label} | ${r.value} |`), `| Total | ${b.chart.total} |`].join("\n");
    case "themes": return [`**${b.themes.title}** (${b.themes.caption})`, "", `| Theme | ${b.themes.weeks.join(" | ")} |`, `| --- |${b.themes.weeks.map(() => " ---: |").join("")}`, ...b.themes.lanes.map((l) => `| ${l.theme} | ${l.values.map((x) => `${Math.round(x * 100)}%`).join(" | ")} |`)].join("\n");
    case "diagram": {
      const id = (s) => `n_${s.replace(/[^A-Za-z0-9_]/g, "_")}`;
      const t = (s) => s.replace(/["\n\r]/g, " ").trim();
      return [`**${b.diagram.title}**${b.diagram.caption ? `: ${b.diagram.caption}` : ""}`, "", "```mermaid", "flowchart LR",
        ...b.diagram.nodes.map((n) => `  ${id(n.id)}["${t([n.eyebrow, n.label, n.view?.status?.word].filter(Boolean).join(" · "))}"]`),
        ...b.diagram.edges.map(([a, z]) => `  ${id(a)} --> ${id(z)}`), "```"].join("\n");
    }
    default: return "";
  }
}

/** Stage C: the AI output, from the snapshot and the server's RefViews. */
export function aiStatements(pre, snap, viewsObj, now = new Date(), opts = {}) {
  const c = { ...makeClock(now), pr185At: pre.pr185At };
  const { N, HN } = pre;
  const views = new Map(Object.entries(viewsObj));
  const v = (r) => views.get(r) ?? null;
  const appBase = `${opts.origin ?? "http://localhost:8790"}/${SLUG}`;
  const s = [];
  const unresolved = new Set();
  const sprint = snap.sprints.find((x) => x.id === IDS.sprint);
  const tk = (k) => snap.tickets.find((t) => t.id === IDS.tickets[k]);
  const byNum = (n) => snap.tickets.find((t) => t.number === n);
  const handoff = (n) => snap.handoffs.find((h) => h.number === n);

  // ── Ask Trov: the threads, as the Ask route stores them ──
  const threads = threadDefs({ c, N, HN, v, snap });
  const tokenRe = /\[\[(ticket|pr|doc|decision|feed|sprint|handoff|artifact|person|prompt|repo):([A-Za-z0-9][A-Za-z0-9_.@/-]{0,99})(?:\|status)?\]\]/g;
  let msgId = 95001;
  const MODEL_OF = { fast: HAIKU, smart: SONNET, thinking: OPUS };
  const UNITS = { fast: 1, smart: 1, thinking: 5 };
  let savedArtifact = null;
  for (const t of threads) {
    const first = t.messages[0], last = t.messages.at(-1);
    s.push(insert("chat_threads", {
      id: t.id, org_id: ORG, handle: ME, title: t.title, mode: t.mode, origin: t.origin ?? "page", context_ref: t.contextRef ?? null, pinned: t.pinned ?? 0,
      auto_mode: t.auto ?? 0, draft: t.draft ?? "", summary: "", summary_through: 0, turn: t.turn, stop_requested: 0, created_at: first.at, updated_at: last.at,
    }));
    let question = null;
    const answers = [];
    for (const m of t.messages) {
      const id = msgId++;
      if (m.role === "user") {
        const ctx = (m.context ?? []).filter((r) => { if (!v(r)) unresolved.add(r); return !!v(r); });
        let attachments = [];
        if (t.attachment) {
          attachments = [{ id: 9501, slug: "railway-build-log-png", title: "railway-build-log.png", kind: "image", contentType: "image/png", size: opts.image?.size ?? 0, sha256: opts.image?.sha ?? "", thumbUrl: `/api/o/${SLUG}/raw/a/railway-build-log-png@v1` }];
          s.push(insert("chat_artifacts", { id: 9501, org_id: ORG, thread_id: t.id, artifact_id: IDS.artifact.attachment, role: "attachment", message_id: id, created_at: m.at }));
        }
        s.push(insert("chat_messages", { id, org_id: ORG, thread_id: t.id, role: "user", mode: t.mode, content_json: { text: m.text, command: null, context: ctx, refs: ctx, attached: attachments.map((a) => ({ id: a.id, title: a.title })) }, cites_json: [], attachments_json: attachments, model: null, units: 0, created_at: m.at }));
        question = { id, m };
        continue;
      }
      // An answer: its text (the text parts in order), blocks, activity, cards — with the ORDER they streamed in.
      let text = "";
      const blocks = [];
      const parts = [];
      const seen = new Set(question?.m.context ?? []);
      const activity = (m.activity ?? []).map((a, i) => {
        for (const r of a.results ?? []) seen.add(r);
        return { step: i + 1, tool: a.tool, icon: a.icon, label: a.label, results: (a.results ?? []).filter((r) => v(r)), resultLine: a.resultLine ?? null };
      });
      for (const p of m.parts) {
        if (p.md !== undefined) { text += p.md; parts.push({ kind: "text", md: p.md }); }
        else if (p.block) { parts.push({ kind: "block", index: blocks.length }); blocks.push(p.block); for (const x of p.block.items ?? []) seen.add(x.ref); }
        else if (p.save) {
          const target = answers[t.savedFrom ?? 0];
          const title = `${t.title}, ${shortDay(c.ago(0).slice(0, 10))}`;
          const slug = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
          savedArtifact = { title, slug, target, at: m.at, thread: t.id };
          parts.push({ kind: "block", index: blocks.length });
          blocks.push({ kind: "save_form", form: { messageId: target.id, block: null, title, kind: "markdown", visibility: "private", saved: { slug, title, visibility: "private", url: `#artifacts/${slug}` } } });
        } else if (p.action) {
          const a = p.action;
          parts.push({ kind: "action", id: a.id });
          s.push(insert("chat_actions", {
            id: a.id, org_id: ORG, thread_id: t.id, message_id: id, turn: t.turn, tool: a.tool, kind: a.kind, group_id: a.group ?? null, tool_use_id: `toolu_showcase_${a.id}`,
            args_json: a.args, preview_json: a.preview, state: a.state, result_json: a.result === null ? null : a.result, undo_json: a.undo === null ? null : a.undo,
            created_at: m.at, decided_at: a.state === "undone" ? a.undoneAt : a.decided,
          }));
          if (a.preview.item) seen.add(a.preview.item.ref);
        }
      }
      // The answer's cites: its tokens that resolve, in order of first appearance (src/ai/ask/refs.ts `linkAnswer`).
      const cites = [];
      for (const mt of text.matchAll(tokenRe)) {
        const r = mt[1] === "person" ? `${mt[1]}:${mt[2].toLowerCase()}` : `${mt[1]}:${mt[2]}`;
        seen.add(r);
        const view = v(r);
        if (!view) { unresolved.add(r); continue; }
        if (!cites.some((x) => x.ref === r)) cites.push(view);
      }
      const [tin, tout, tcached] = m.tokens ?? [0, 0, 0];
      s.push(insert("chat_messages", {
        id, org_id: ORG, thread_id: t.id, role: "assistant", mode: m.mode,
        content_json: { text, refs: [...seen].filter((r) => v(r)), blocks, activity, followups: m.followups ?? [], thinking: m.thinking ?? null, parts },
        cites_json: cites, attachments_json: [], model: MODEL_OF[m.mode], tokens_in: tin, tokens_out: tout, tokens_cached: tcached, units: UNITS[m.mode], stopped: 0, created_at: m.at,
      }));
      answers.push({ id, text, blocks, cites, at: m.at, mode: m.mode });
      if (t.wrong) {
        s.push(insert("ai_feedback", { id: 9501, org_id: ORG, handle: ME, item_type: "ask", item_ref: String(id), kind: "ask", model: MODEL_OF[m.mode], prompt_version: "ask-2", created_at: t.wrong.at,
          detail_json: { reason: t.wrong.reason, mode: m.mode, cites: t.wrong.cites, messageId: id } }));
      }
    }
  }
  // The saved answer: a private Markdown artifact written from the STORED answer, linked to the thread (role saved) and
  // to the tickets and sprints it cites (src/ai/ask/routes.ts `saveFromThread`).
  if (savedArtifact) {
    const a = savedArtifact.target;
    const content = `# ${savedArtifact.title}\n\n${[tokensToMarkdown(a.text, views, appBase), ...a.blocks.map((b) => blockMarkdown(b, views, appBase)).filter(Boolean)].filter((x) => x.trim()).join("\n\n")}\n`;
    const bytes = Buffer.from(content, "utf8");
    s.push(insert("artifact_pages", { id: IDS.artifact.saved, org_id: ORG, slug: savedArtifact.slug, title: savedArtifact.title, kind: "markdown", area: "data", repo: "", author_id: ME, status: "draft", visibility: "private", current_version: 1, created_at: savedArtifact.at, updated_at: savedArtifact.at }));
    s.push(insert("artifact_versions", { org_id: ORG, page_id: IDS.artifact.saved, version_no: 1, summary: "Saved from Ask Trov", content, r2_key: null, size_bytes: bytes.length, content_type: "text/markdown; charset=utf-8", sha256: sha256(bytes), filename: null, created_by: ME, created_at: savedArtifact.at }));
    s.push(insert("artifacts_fts", { page_id: String(IDS.artifact.saved), title: savedArtifact.title, description: "Saved from Ask Trov", body: content, org_id: ORG }));
    const links = [...new Map(a.cites.filter((x) => x.type === "ticket" || x.type === "sprint").map((x) => [x.ref, x])).values()];
    for (const l of links) s.push(insert("artifact_links", { org_id: ORG, page_id: IDS.artifact.saved, target_type: l.type, target_ref: l.ref.split(":")[1], created_by: ME, created_at: savedArtifact.at }, "INSERT OR IGNORE"));
    s.push(insert("chat_artifacts", { id: 9502, org_id: ORG, thread_id: savedArtifact.thread, artifact_id: IDS.artifact.saved, role: "saved", message_id: a.id, created_at: savedArtifact.at }));
  }
  // Settings › Trov.
  s.push(insert("person_ask_settings", { org_id: ORG, handle: ME, default_mode: "smart", updated_at: c.days(6),
    instructions: "Lead with the answer in a sentence or two, then bullets. Cite the ticket or PR for every claim. I work on the backend and hosting, so skip frontend detail unless I ask." }));
  // Sharing (0076_ask_sharing, 0077_ask_people_sharing): the migration-runner thread shared by name — Mei Lin may
  // continue it, Jose may read it — and the deploy thread with the whole org, so a teammate signed in (`npm run dev:as
  // -- meilin`) finds rows under Shared with you and Organization.
  s.push(insert("chat_thread_people", { org_id: ORG, thread_id: 9505, handle: "meilin", access: "continue", shared_at: c.days(1) }));
  s.push(insert("chat_thread_people", { org_id: ORG, thread_id: 9505, handle: "Jose-Gael-Cruz-Lopez", access: "read", shared_at: c.days(1) }));
  s.push(`UPDATE chat_threads SET shared_at = '${c.days(1)}' WHERE org_id = '${ORG}' AND id = 9502`);
  // Review › "Flagged in Ask": Andres's "out of date" on the migration answer, and teammates' earlier flags (no handle).
  [["doc:sapling-infrastructure", "out_of_date", c.days(1, 170)], ["doc:sapling-infrastructure", "out_of_date", c.days(2, 400)], ["doc:sapling-architecture", "source_wrong", c.days(3, 100)], ["decision:5", "source_wrong", c.days(6, 30)]]
    .forEach(([ref, reason, at], i) => s.push(insert("ask_flags", { id: 9501 + i, org_id: ORG, item_ref: ref, reason, created_at: at })));

  // ── My Work › Your brief (brief-dev's v1 kept as the older version) ──
  s.push(...briefDevStatements(new Date(c.t - 26 * 60 * MIN)).filter((x) => x.startsWith("INSERT")));
  const D = tk("D");
  // The brief's fixed shape (the owner's rulings; shared/ai-core.ts AI_BRIEF_*): Now and Recently ONE sentence each,
  // at most 160 characters and 3 cites, no ISO date; Next AT MOST 3, one per kind group — the failing build and ONE
  // handoff — each why at most 80 characters. No "overdue" item: the one late sprint (7002, Gradebook export rework)
  // holds none of Andres's tickets, and sprint 3 is done (owner ruling 2026-10-16; team-rich.mjs CANONICAL_SPRINT_DATES).
  const h16 = handoff(16);
  const nextItems = [
    { ref: `ticket:${N.D}`, kind: "failing", title: D.title, why: "The Production backend deploy is failing at its build step.", cites: [ticketCite(N.D)] },
    ...(h16 ? [{ ref: "handoff:16", kind: "handoff", title: clip(firstLine(h16.body), 140), why: "Jose left it for you, with the backend half done.", cites: [handoffCite(16)] }] : []),
  ].slice(0, 3);
  const brief = {
    now: { text: "You have the failed Production backend build in progress, with its fix handed to Jose.", cites: [ticketCite(N.D), handoffCite(HN)] },
    recently: { text: "You shipped hosting providers behind one interface and shared GitHub installs across orgs.", cites: [prCite(185), prCite(171), feedCite(IDS.feed.hosting, "Shipped: hosting providers behind one interface")] },
    next: { items: nextItems },
  };
  s.push(insert("person_brief", { org_id: ORG, handle: ME, version: 2, generated_at: c.ago(9), model: HAIKU, prompt_version: "brief.3", input_hash: "ai-showcase", brief_json: brief }));
  s.push(`UPDATE memberships SET mywork_opened_at = ${q(c.ago(2))} WHERE org_id = '${ORG}' AND user_id = '${ME}'`);

  // ── Repo › Overview › State: three versions, the newest drawn ──
  const envLabel = new Map(snap.envs.map((e) => [e.key, e.label]));
  const partLabel = (env, part) => `${envLabel.get(env) ?? env} ${snap.parts.find((p) => p.env_key === env && p.part_key === part)?.label ?? part}`;
  const latestDeploy = (env, part) => snap.deploys.find((d) => d.env === env && d.part === part) ?? null;
  const httpsOrNull = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);
  const deployCite = (env, part) => { const d = latestDeploy(env, part); return { ref: `deploy:${env}/${part}`, label: partLabel(env, part), href: httpsOrNull(d?.inspect_url) ?? httpsOrNull(d?.url) }; };
  const hasPart = (env, part) => snap.parts.some((p) => p.env_key === env && p.part_key === part);
  const newestPr = new Map();
  for (const p of snap.prEvents) if (!newestPr.has(p.number)) newestPr.set(p.number, p);
  const openPr = [...newestPr.values()].find((p) => p.state === "review" || p.state === "draft") ?? null;
  const backendFailed = latestDeploy("production", "backend")?.state === "error";
  const fd = (k) => feedCite(IDS.feed[k], digestDefs(c).find((d) => d.id === IDS.feed[k]).summary);
  const states = [
    { version: 1, at: c.days(2, 600), events: 3, json: {
      headline: "Pro checkout works for new accounts; the GitHub connection rework is under way.",
      shipped: [{ text: "A new account that chose Pro now reaches checkout after signing up.", cites: [prCite(168), fd("checkout")] }],
      inFlight: [{ text: "Netlify can be connected with a pasted personal access token while its OAuth app waits for review.", cites: [fd("netlify")] }],
      attention: [] } },
    { version: 2, at: c.days(1, 120), events: 4, json: {
      headline: "Several organizations can now share one GitHub installation; hosting providers are still on a branch.",
      shipped: [{ text: "Several organizations can share one GitHub App installation.", cites: [prCite(171), fd("orgs")] }, { text: "A new account that chose Pro now reaches checkout.", cites: [prCite(168)] }],
      inFlight: [{ text: "Fly.io parts are being grouped by region.", cites: [fd("fly")] }, { text: "Netlify connects with a personal access token.", cites: [fd("netlify")] }],
      attention: [] } },
    { version: 3, at: c.ago(24), events: 7, json: {
      headline: backendFailed ? "Hosting providers are merged; the Production backend build is failing on Railway." : "Hosting providers are merged and every environment reports its deploys.",
      shipped: [
        { text: "Vercel, Render, Netlify and Fly.io connect through one hosting interface.", cites: [prCite(185), fd("hosting")] },
        { text: "Several organizations can share one GitHub App installation.", cites: [prCite(171), fd("orgs")] },
        { text: "A new account that chose Pro now reaches checkout after signing up.", cites: [prCite(168)] },
      ],
      inFlight: [
        ...(openPr ? [{ text: "The Repo screen's apps and targets are in review.", cites: [{ ...prCite(openPr.number) }] }] : []),
        { text: "Fly.io parts are being grouped by region, one per region.", cites: [fd("fly")] },
      ],
      attention: [
        ...(backendFailed && hasPart("production", "backend") ? [{ text: "The Production backend build failed on Railway with two type errors; Production still serves the previous build.", cites: [deployCite("production", "backend"), ticketCite(N.D)] }] : []),
        ...(hasPart("production", "frontend") ? [{ text: "Production frontend was rolled back to its previous build.", cites: [deployCite("production", "frontend")] }] : []),
      ] } },
  ];
  for (const st of states) s.push(insert("repo_state", { org_id: ORG, repo: REPO, version: st.version, generated_at: st.at, basis_until: st.at, model: HAIKU, prompt_version: "state-1", event_count: st.events, state_json: st.json }));

  // ── Feed: Sift's importance on a few entries and PRs (computed facts) ──
  for (const [id, imp] of [[101, "notable"], [901, "notable"], [902, "routine"], [103, "notable"]]) s.push(`UPDATE feed SET importance = '${imp}' WHERE org_id = '${ORG}' AND id = ${id}`);
  for (const [n, imp] of [[185, "notable"], [171, "breaking"], [168, "routine"], [136, "notable"], [162, "notable"]]) s.push(`UPDATE pr_summaries SET importance = '${imp}' WHERE org_id = '${ORG}' AND pr_number = ${n}`);

  // ── Tags › Sift: two runs an admin started — tags it added (with Undo) and items "to review" ──
  s.push(insert("org_ai_settings", { org_id: ORG, kind: "tag.fit", enabled: 1, updated_at: c.days(5), updated_by: ME }));
  s.push(insert("org_tags", { id: IDS.tag, org_id: ORG, name: "agents", description: "AI agents, their prompts and the tools they call", color: "plum", starter: 0, created_at: c.days(4, 30), created_by: ME }));
  const runs = [
    { id: IDS.runs.agents, tag: "agents", at: c.days(4, 29), candidates: 14, items: [
      ["doc", "sapling-backend-ai", 0.97, "Mentions “Agents live in backend/agents/ and use Pydantic AI”"],
      ["doc", "sapling-adr-pydantic-ai", 0.94, "Mentions “New agents live in backend/agents/”"],
      ["doc", "sapling-adr-model-routing", 0.91, "Mentions “every worker agent hardcoded gemini-2.5-flash”"],
      ["doc", "sapling-adr-drop-orchestrator", 0.89, "Mentions “a document_agent that wrapped the graph-update step”"],
      ["adr", "1", 0.87, "Mentions “Agents post to Trov at the end of a session over MCP”"],
      ["doc", "sapling-knowledge-graph", 0.79, "Mentions “dispatches chat messages to a Pydantic AI agent”"],
      ["doc", "sapling-document-pipeline", 0.68, "Mentions “continues to the agent pipeline”"],
      ["doc", "sapling-overview", 0.62, "Sift rates it a fit (62%)"],
    ] },
    { id: IDS.runs.data, tag: "data", at: c.days(2, 200), candidates: 9, items: [
      ["doc", "sapling-infrastructure", 0.93, "Mentions “Schema lives in backend/db/migrations/ as numbered SQL files”"],
      ["doc", "sapling-caching", 0.86, "Mentions “Redis (optional) dedups across workers”"],
      ["doc", "sapling-adr-durable-execution", 0.71, "Mentions “re-checks the idempotency cache before re-running”"],
    ] },
  ];
  let sugId = 9501;
  for (const r of runs) {
    const added = r.items.filter(([, , p]) => p >= 0.85);
    s.push(insert("org_tag_runs", { id: r.id, org_id: ORG, tag: r.tag, status: "done", started_by: ME, started_at: r.at, ended_at: c.plus(r.at, 2), candidates: r.candidates, calls: r.candidates, checked: r.candidates, added: added.length }));
    for (const [type, id, p, reason] of r.items) {
      if (p >= 0.85) {
        s.push(insert("entry_tags", { org_id: ORG, tag: r.tag, entry_type: type, entry_id: id }, "INSERT OR IGNORE"));
        s.push(insert("org_tag_suggestions", { id: sugId++, org_id: ORG, entry_type: type, entry_id: id, tag: r.tag, source: "model", confidence: p, reason, model: JEV, prompt_version: "jev-fit-1", suggested_by: "system", suggested_at: c.plus(r.at, 1), state: "accepted", resolved_to: r.tag, resolved_at: c.plus(r.at, 1), resolved_by: "jev", run_id: r.id }));
      } else {
        s.push(insert("org_tag_suggestions", { id: sugId++, org_id: ORG, entry_type: type, entry_id: id, tag: r.tag, source: "model", confidence: p, reason, model: JEV, prompt_version: "jev-fit-1", suggested_by: "system", suggested_at: c.plus(r.at, 1), state: "open", run_id: r.id }));
      }
    }
  }

  // ── Tickets, Review, Unplaced: Jev's cards (ai_suggestions, value_json as JSON) ──
  const sug = (id, row) => s.push(insert("ai_suggestions", { id, org_id: ORG, state: "open", cites_json: [], created_at: c.ago(40), ...row }));
  const H = tk("H");
  sug(9501, { item_type: "ticket", item_ref: String(N.H), kind: "ticket.category", value_json: JSON.stringify("bug"), confidence: 0.88, reason: "it says “gives an empty CSV”", model: JEV, prompt_version: "jev-ticket-1", created_at: c.plus(H.updated_at, 3) });
  sug(9502, { item_type: "ticket", item_ref: String(N.H), kind: "ticket.priority", value_json: JSON.stringify("high"), confidence: 0.79, reason: "it says “need the term grades by Friday”", model: JEV, prompt_version: "jev-ticket-1", created_at: c.plus(H.updated_at, 3) });
  sug(9503, { item_type: "ticket", item_ref: String(N.H), kind: "ticket.duplicate", value_json: { number: 1, label: `#1 ${clip(byNum(1)?.title ?? "CSV export from the gradebook fails over 1,000 rows", 80)}` }, confidence: 0.93, reason: "both mention “export”, “gradebook” and “empty”", cites_json: [ticketCite(1)], model: JEV, prompt_version: "jev-ticket-1", created_at: c.plus(H.updated_at, 3) });
  sug(9504, { item_type: "ticket", item_ref: "6", kind: "ticket.priority", value_json: JSON.stringify("high"), confidence: 0.81, reason: "it says “spins for ~60s and then errors”", model: JEV, prompt_version: "jev-ticket-1", created_at: c.days(3, 200) });
  const stagedOf = (slug) => snap.staged.find((d) => d.slug === slug) ?? null;
  const arch = stagedOf("sapling-architecture"), infra = stagedOf("sapling-infrastructure");
  if (arch) sug(9505, { item_type: "proposal", item_ref: `doc:sapling-architecture@${arch.version}`, kind: "review.risk", value_json: { risk: "contradicts", label: "Contradicts a doc" }, confidence: 0.74,
    reason: "it adds “Every request carries an X-Request-ID correlation id, logged from the edge worker through to each agent call.”; the live doc “Infrastructure — Data, Observability, Security & Deploy” covers the same ground",
    cites_json: [{ ref: "doc:sapling-infrastructure", label: "Infrastructure — Data, Observability, Security & Deploy", href: null }], model: JEV, prompt_version: "jev-risk-1", created_at: c.days(2, 300) });
  if (infra) sug(9506, { item_type: "proposal", item_ref: `doc:sapling-infrastructure@${infra.version}`, kind: "review.risk", value_json: { risk: "process", label: "Changes a process" }, confidence: 0.68,
    reason: "it replaces “but **prod has no such table** — prod's schema was applied via Supabase-native…” with “and prod was baselined into it (every file through 0029)…”",
    model: JEV, prompt_version: "jev-risk-1", created_at: c.days(1, 300) });
  if (snap.adrs.some((a) => a.id === 5 && a.status === "draft")) sug(9507, { item_type: "proposal", item_ref: "adr:5", kind: "review.risk", value_json: { risk: "decision", label: "Changes a decision" }, confidence: 0.83,
    reason: "it decides “Store absolute closed/total per sprint, written by the webhook and a scheduled backstop; never computed at render.”; the ratified decision “Events are external fact, deduped by semantic key” covers the same ground",
    cites_json: [{ ref: "adr:4", label: "ADR-004", href: null }], model: JEV, prompt_version: "jev-risk-1", created_at: c.days(5, 100) });
  sug(9508, { item_type: "unplaced", item_ref: String(IDS.triage.railway), kind: "unplaced.destination", confidence: 0.78, model: JEV, prompt_version: "jev-place-1", created_at: c.days(1, 80),
    value_json: { type: "doc", section: "reference", near: "sapling-infrastructure", label: "reference, next to “Infrastructure — Data, Observability, Security & Deploy”" },
    reason: "it mentions “Railway › Deployments › the last good one › Redeploy”, like the doc “Infrastructure — Data, Observability, Security & Deploy” in reference",
    cites_json: [{ ref: "doc:sapling-infrastructure", label: "Infrastructure — Data, Observability, Security & Deploy", href: null }] });
  sug(9509, { item_type: "unplaced", item_ref: String(IDS.triage.evals), kind: "unplaced.destination", confidence: 0.71, model: JEV, prompt_version: "jev-place-1", created_at: c.ago(160),
    value_json: { type: "doc", section: "reference", near: "sapling-backend-ai", label: "reference, next to “Backend & AI Agents”" },
    reason: "it mentions “the quiz agent”, like the doc “Backend & AI Agents” in reference",
    cites_json: [{ ref: "doc:sapling-backend-ai", label: "Backend & AI Agents", href: null }] });

  // ── Roadmap: sprint notes, the drift line, and an admin's two suggestion cards ──
  const ins = (kind, key, version, at, json, pv) => s.push(insert("org_insights", { org_id: ORG, kind, key, version, generated_at: at, model: HAIKU, prompt_version: pv, json }));
  // No note on sprint 3: it is done (team-rich.mjs CANONICAL_SPRINT_DATES), and a note shows on an active sprint only.
  ins("sprint_note", "4", 1, c.days(1, 60), { text: "Its one ticket, #2, is in progress with Luke; nothing in the feed names it this week.", cites: [ticketCite(2)] }, "note-1");
  ins("sprint_note", String(IDS.sprint), 1, c.days(1, 60), { text: `#${N.A}, #${N.B} and #${N.C} are done; #${N.F} is in testing, and #${N.E} and #${N.G} have no assignee.`, cites: [ticketCite(N.A), ticketCite(N.B), ticketCite(N.C), ticketCite(N.F), ticketCite(N.E), ticketCite(N.G)] }, "note-1");
  ins("sprint_note", String(IDS.sprint), 2, c.ago(30), { text: `#${N.D}, the failed Production backend build, is in progress with a handoff to Jose; #${N.E} and #${N.G} still have no assignee.`, cites: [ticketCite(N.D), handoffCite(HN), ticketCite(N.E), ticketCite(N.G)] }, "note-1");
  // The drift's shares are the server's: each active theme's share of the PRs merged in the last 14 days.
  const windowStart = new Date(c.t - 14 * DAY).toISOString();
  const recent = snap.merged.filter((m) => m.at && m.at >= windowStart);
  const counts = new Map();
  for (const m of recent) { const th = snap.prThemes.find((p) => p.n === m.n); if (th) counts.set(th.theme_id, (counts.get(th.theme_id) ?? 0) + 1); }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total) {
    const hostingTheme = snap.themes.find((t) => /repo dashboard/i.test(t.name));
    const raw = [...counts.entries()].map(([id, n]) => ({ id, pct: (n / total) * 100 })).sort((a, b) => b.pct - a.pct);
    const floor = raw.map((r) => ({ ...r, p: Math.floor(r.pct) }));
    let left = 100 - floor.reduce((a, r) => a + r.p, 0);
    for (const r of [...floor].sort((a, b) => (b.pct - b.p) - (a.pct - a.p))) { if (left <= 0) break; r.p++; left--; }
    const shares = floor.map((r) => { const t = snap.themes.find((x) => x.id === r.id); return { themeId: String(r.id), theme: t?.name ?? "", pct: r.p, inSprint: r.id === hostingTheme?.id }; }).filter((x) => x.theme);
    const outside = shares.filter((x) => !x.inSprint && x.pct >= 25);
    if (outside.length) {
      ins("plan_drift", "", 1, c.ago(180), {
        text: `The last two weeks split between ${listWords(shares.map((x) => x.theme))}; only the ${hostingTheme?.name ?? "hosting"} work is in a sprint.`,
        cites: shares.map((x) => ({ ref: `theme:${x.themeId}`, label: x.theme, href: "#repo/planning" })), windowDays: 14, shares,
      }, "drift-1");
    }
  }
  const backlog = snap.tickets.filter((t) => t.sprint_id === null && ["submitted", "in_progress", "testing"].includes(t.status));
  const has = (n) => backlog.some((t) => t.number === n);
  const draft = [
    { name: "Study streaks", goal: "The streak features learners asked for: a freeze day and a home-screen widget.", tickets: [81, 82].filter(has) },
    { name: "Reports and exports", goal: "Reports that finish and exports that are never empty.", tickets: [6, N.H].filter(has) },
  ].filter((d) => d.tickets.length);
  if (draft.length) s.push(insert("ai_suggestions", { id: 9520, org_id: ORG, item_type: "roadmap", item_ref: "org", kind: "sprint_draft", value_json: { sprints: draft }, confidence: null,
    reason: "these open tickets sit outside every sprint and group cleanly by what they touch.", cites_json: draft.flatMap((d) => d.tickets).map(ticketCite), model: HAIKU, prompt_version: "draft-1", state: "open", created_at: c.days(1, 30) }));
  s.push(insert("ai_suggestions", { id: 9521, org_id: ORG, item_type: "roadmap", item_ref: "org", kind: "plan_narrative", confidence: null,
    value_json: { narrative: "**Now:** hosting providers rolled out across every environment, and the gradebook export rework that is past its date.\n\n**Next:** reports and exports that finish, and the roadmap reading itself against what shipped.\n\n**Later:** semantic search ranking and the self-host guide." },
    reason: "the narrative predates the Hosting providers rollout sprint and this month's hosting work.", cites_json: [{ ref: `sprint:${IDS.sprint}`, label: "Hosting providers rollout", href: `#sprints/${IDS.sprint}` }, prCite(185)],
    model: HAIKU, prompt_version: "narrative-1", state: "open", created_at: c.days(2, 90) }));

  // ── E-mail: this week's "This week" highlights (and last week's), and "Only when something needs me" ──
  const week = (ms) => isoWeekId(...localDate(ms, snap.timezone));
  s.push(insert("digest_highlights", { org_id: ORG, week_id: week(c.t), generated_at: c.ago(150), model: HAIKU, prompt_version: "week.1", highlights_json: [
    { text: "Hosting providers shipped: Vercel, Render, Netlify and Fly.io now connect through one interface.", cites: [prCite(185), ticketCite(N.A)] },
    { text: "Several organizations can now share one GitHub App installation.", cites: [prCite(171)] },
    { text: "The Production backend build is failing on Railway; Jose has a handoff with the fix.", cites: [ticketCite(N.D), handoffCite(HN)] },
  ] }));
  s.push(insert("digest_highlights", { org_id: ORG, week_id: week(c.t - 7 * DAY), generated_at: c.days(7, 150), model: HAIKU, prompt_version: "week.1", highlights_json: [
    { text: "Pro checkout works for accounts that sign up in order to buy it.", cites: [prCite(168)] },
    { text: "Netlify connects with a personal access token while its OAuth app waits for review.", cites: [ticketCite(N.B)] },
  ] }));
  s.push(insert("notification_person_prefs", { org_id: ORG, user_id: ME, only_when_needed: 1, updated_at: c.days(3) }));

  // ── Usage: a believable 40 days of AI metering (Org settings › AI, Platform › Usage) ──
  s.push(...usageStatements(c));
  return { statements: s, unresolved: [...unresolved] };
}

/** A small fixed pseudo-random sequence in [0, 1) (platform-dev's). */
function sequence(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}
function usageStatements(c) {
  const rnd = sequence(1717);
  const rows = [];
  const put = (day, metric, actor, n) => { if (n > 0) rows.push(`(${q(ORG)}, ${q(day)}, ${q(metric)}, ${q(actor)}, ${Math.round(n)}, ${q(`${day}T23:50:00.000Z`)})`); };
  const people = [[ME, 1], ["Jose-Gael-Cruz-Lopez", 0.6], ["lpcooper-arch", 0.35], ["Darkest-Teddy", 0.45]];
  for (let back = 39; back >= 0; back--) {
    const ms = c.t - back * DAY;
    const day = new Date(ms).toISOString().slice(0, 10);
    const dow = new Date(ms).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const k = weekend ? 0.25 : 1;
    const r = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * k);
    // Capture-time summaries (the webhook).
    put(day, "summary:pr", "github-webhook", r(2, 9));
    put(day, "summary:issue", "github-webhook", r(0, 3));
    // The AI pass: one run per call, its tokens; Jev's requests and tokens.
    const runs = { "digest.session": r(2, 7), "repo.state": r(1, 3), "brief.person": r(2, 5), "org.rollup": r(0, 2), "themes.caption": dow === 1 ? 1 : 0, "digest.week": dow === 1 ? 1 : 0, "doc.drift": rnd() < 0.15 ? 1 : 0 };
    let n = 0;
    for (const [kind, x] of Object.entries(runs)) { put(day, `ai_run:${kind}`, "ai-pass", x); n += x; }
    if (rnd() < 0.12) put(day, "ai_run_failed:digest.session", "ai-pass", 1);
    put(day, "ai_tokens_in", "ai-pass", n * (2_100 + rnd() * 800));
    put(day, "ai_tokens_out", "ai-pass", n * (220 + rnd() * 90));
    put(day, "ai_tokens_cached", "ai-pass", n * (4_800 + rnd() * 1_200));
    const jev = r(18, 64) + (back === 4 ? 14 : 0) + (back === 2 ? 9 : 0);
    put(day, "ai_suggest", "ai-pass", jev);
    put(day, "ai_jev_tokens_in", "ai-pass", jev * (290 + rnd() * 60));
    put(day, "ai_jev_tokens_out", "ai-pass", jev * 4);
    // The plain-language filter.
    const f = rnd() < 0.5 ? r(0, 4) : 0;
    put(day, "ai_run:filter", "ai-filter", f);
    // Ask Trov, per person (its tokens are counted per person too).
    for (const [who, w] of people) {
      const asks = Math.round((rnd() * 7 + 1) * w * k);
      if (!asks) continue;
      put(day, "ai_chat", who, asks + (who === ME && rnd() < 0.2 ? 5 : 0));
      put(day, "ai_tokens_in", who, asks * (9_000 + rnd() * 6_000));
      put(day, "ai_tokens_out", who, asks * (420 + rnd() * 300));
      put(day, "ai_tokens_cached", who, asks * (7_000 + rnd() * 4_000));
    }
  }
  const out = [];
  for (let i = 0; i < rows.length; i += 50) out.push(`INSERT OR REPLACE INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES ${rows.slice(i, i + 50).join(", ")}`);
  return out;
}

// ── stage D: the checks ──────────────────────────────────────────────────────────────────────────────────────────
export const CHECKS = [
  ["My Work › Your brief (AndresL230, newest of 2)", `SELECT COUNT(*) AS n FROM person_brief WHERE org_id = '${ORG}' AND handle = '${ME}'`, 2],
  ["Repo › Overview › State (3 versions)", `SELECT COUNT(*) AS n FROM repo_state WHERE org_id = '${ORG}' AND repo = '${REPO}'`, 3],
  ["Repo › Where the work went (active themes)", `SELECT COUNT(*) AS n FROM repo_themes WHERE org_id = '${ORG}' AND status = 'active'`, 1],
  ["Repo › Where the work went (a proposed theme with its open suggestion)", `SELECT COUNT(*) AS n FROM ai_suggestions WHERE org_id = '${ORG}' AND kind = 'themes.propose' AND state = 'open'`, 1],
  ["Repo › Where the work went (a caption)", `SELECT COUNT(*) AS n FROM repo_theme_captions WHERE org_id = '${ORG}'`, 1],
  ["Feed › Trov's session digests", `SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ORG}' AND origin = 'ai'`, 5],
  ["Feed › notable / breaking entries", `SELECT COUNT(*) AS n FROM feed WHERE org_id = '${ORG}' AND importance IN ('notable', 'breaking')`, 4],
  ["Feed › rated PRs", `SELECT COUNT(*) AS n FROM pr_summaries WHERE org_id = '${ORG}' AND importance IS NOT NULL`, 4],
  ["Tags › Added by Sift", `SELECT COUNT(*) AS n FROM org_tag_suggestions WHERE org_id = '${ORG}' AND source = 'model' AND state = 'accepted'`, 5],
  ["Tags › To review", `SELECT COUNT(*) AS n FROM org_tag_suggestions WHERE org_id = '${ORG}' AND source = 'model' AND state = 'open'`, 3],
  ["Tickets › suggestions", `SELECT COUNT(*) AS n FROM ai_suggestions WHERE org_id = '${ORG}' AND item_type = 'ticket' AND state = 'open'`, 4],
  ["Review › risks", `SELECT COUNT(*) AS n FROM ai_suggestions WHERE org_id = '${ORG}' AND kind = 'review.risk' AND state = 'open'`, 2],
  ["Review › Trov's low-confidence doc-drift proposal", `SELECT COUNT(*) AS n FROM doc_versions WHERE org_id = '${ORG}' AND created_by = 'trov' AND status = 'staged' AND low_confidence = 1`, 1],
  ["Review › Flagged in Ask", `SELECT COUNT(*) AS n FROM ask_flags WHERE org_id = '${ORG}'`, 3],
  ["Unplaced › destinations", `SELECT COUNT(*) AS n FROM ai_suggestions WHERE org_id = '${ORG}' AND kind = 'unplaced.destination' AND state = 'open'`, 2],
  ["Roadmap › sprint notes + drift", `SELECT COUNT(*) AS n FROM org_insights WHERE org_id = '${ORG}'`, 4],
  ["Roadmap › admin suggestions", `SELECT COUNT(*) AS n FROM ai_suggestions WHERE org_id = '${ORG}' AND item_type = 'roadmap' AND state = 'open'`, 2],
  ["Roadmap › an active sprint with closed tickets (the forecast)", `SELECT COUNT(*) AS n FROM tickets WHERE org_id = '${ORG}' AND sprint_id = ${IDS.sprint} AND status = 'done'`, 1],
  ["Handoffs › pending for AndresL230", `SELECT COUNT(*) AS n FROM handoffs WHERE org_id = '${ORG}' AND recipient = '${ME}' AND status = 'pending'`, 1],
  ["E-mail › This week", `SELECT COUNT(*) AS n FROM digest_highlights WHERE org_id = '${ORG}'`, 2],
  ["Usage › AI metering this month", `SELECT COUNT(*) AS n FROM org_usage_daily WHERE org_id = '${ORG}' AND metric GLOB 'ai_*'`, 50],
  ["Ask › threads", `SELECT COUNT(*) AS n FROM chat_threads WHERE org_id = '${ORG}' AND handle = '${ME}' AND ${BLOCK("id")}`, 12],
  ["Ask › messages", `SELECT COUNT(*) AS n FROM chat_messages WHERE org_id = '${ORG}' AND ${BLOCK("id", 95000, 95999)}`, 26],
  ["Ask › cards", `SELECT COUNT(*) AS n FROM chat_actions WHERE org_id = '${ORG}' AND ${BLOCK("id")}`, 6],
  ["Ask › attachment + saved artifact", `SELECT COUNT(*) AS n FROM chat_artifacts WHERE org_id = '${ORG}' AND ${BLOCK("id")}`, 2],
  ["Settings › Trov", `SELECT COUNT(*) AS n FROM person_ask_settings WHERE org_id = '${ORG}' AND handle = '${ME}'`, 1],
];

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const argv = process.argv.slice(2);
  if (targetsRemote(argv)) {
    console.error("ai-showcase: refusing --remote. This seed only ever targets LOCAL D1.");
    process.exit(1);
  }
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const server = arg("--server", "http://localhost:8790").replace(/\/+$/, "");
  const ENV = { ...process.env, npm_config_loglevel: "error" };
  const d1 = (sqls) => {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", `--command=${sqls.join(";\n")}`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024, env: ENV });
    return JSON.parse(out).map((r) => r.results ?? []);
  };
  const apply = (label, statements) => {
    const chunks = [[]];
    let size = 0;
    for (const st of statements) {
      if (size + st.length > 80_000 && chunks.at(-1).length) { chunks.push([]); size = 0; }
      chunks.at(-1).push(st);
      size += st.length;
    }
    const file = join(mkdtempSync(join(tmpdir(), "trov-ai-showcase-")), "seed.sql");
    console.log(`ai-showcase: ${label}: ${statements.length} statements in ${chunks.length} file${chunks.length === 1 ? "" : "s"}…`);
    for (const chunk of chunks) {
      writeFileSync(file, chunk.map((st) => st + ";").join("\n"), "utf8");
      execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"], env: ENV });
    }
  };

  // Stage 0.
  const pre = preFrom(d1(PRE_SQL));
  for (const t of ["chat_threads", "chat_thread_people", "person_brief", "org_insights", "digest_highlights", "repo_state", "org_tag_runs"]) {
    if (!pre.tables.has(t)) { console.error(`ai-showcase: this local D1 has no ${t} — apply the migrations first (npx wrangler d1 migrations apply DB --local).`); process.exit(1); }
  }
  if (!pre.member) { console.error(`ai-showcase: ${ME} is not a member of ${ORG} here — run \`npm run seed\` first.`); process.exit(1); }

  // The image an Ask question attached: its bytes go to the LOCAL R2 bucket the Worker reads.
  const pngPath = fileURLToPath(new URL("../../fixtures/dev/ai-showcase/railway-build-log.png", import.meta.url));
  const png = readFileSync(pngPath);
  const image = { sha: sha256(png), size: png.length };
  const content = contentStatements(pre, new Date(), image);
  if (argv.includes("--print")) { for (const st of content) console.log(st + ";"); return; }
  const bucket = (readFileSync("wrangler.toml", "utf8").match(/binding\s*=\s*"ARTIFACTS_BUCKET"\s*\n\s*bucket_name\s*=\s*"([^"]+)"/) ?? [])[1] ?? "trov-artifacts";
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/artifacts/${image.sha}`, "--local", `--file=${pngPath}`, "--content-type=image/png"], { stdio: ["ignore", "ignore", "inherit"], env: ENV });
  console.log(`ai-showcase: stored the attachment in local R2 (${bucket}/artifacts/${image.sha.slice(0, 12)}…)`);

  // Stage A.
  apply("content (sprint, tickets, handoff, Unplaced items, Trov's digests, the attachment)", content);

  // Stage B: the org read back, and the RefViews the running server builds for every ref an answer names.
  const snap = snapFrom(d1(SNAP_SQL));
  const refs = showcaseRefs(pre, snap);
  const views = {};
  for (let i = 0; i < refs.length; i += 50) {
    let res;
    try {
      res = await fetch(`${server}/api/o/${SLUG}/ask/peek`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refs: refs.slice(i, i + 50) }) });
    } catch (e) {
      console.error(`ai-showcase: the local Worker at ${server} did not answer (${e instanceof Error ? e.message : e}). Start it (npm run dev) — every Ask chip is stored as the RefView it builds — or pass --server <origin>.`);
      process.exit(1);
    }
    if (!res.ok) { console.error(`ai-showcase: ${server} /ask/peek answered ${res.status}. It must be signed in as ${ME} (DEV_LOGIN=${ME} in .dev.vars).`); process.exit(1); }
    for (const it of (await res.json()).items ?? []) if (!it.hidden) views[it.ref] = it;
  }

  // Stage C.
  const { statements, unresolved } = aiStatements(pre, snap, views, new Date(), { origin: server, image });
  apply("AI output (brief, state, digests, Sift, cards, Roadmap, e-mail, usage, Ask Trov)", statements);

  // Stage D.
  const counts = d1([`SELECT ${CHECKS.map(([, sql], i) => `(${sql}) AS c${i}`).join(", ")}`])[0][0] ?? {};
  let bad = 0;
  console.log("\nSurfaces:");
  CHECKS.forEach(([what, , least], i) => {
    const n = Number(counts[`c${i}`] ?? 0);
    if (n < least) bad++;
    console.log(`  ${n >= least ? "ok     " : "MISSING"} ${what}: ${n}${n >= least ? "" : ` (want ≥ ${least})`}`);
  });
  console.log(`\nTickets: ${Object.entries(pre.N).map(([k, n]) => `${k}=#${n}`).join(" ")}; handoff #${pre.HN}; sprint ${IDS.sprint}.`);
  if (unresolved.length) console.log(`Refs the server could not resolve (shown as plain text): ${unresolved.join(", ")}`);
  else console.log("Every ref an Ask answer names resolved on the server.");
  if (bad) process.exit(1);
}

if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  await main();
}
