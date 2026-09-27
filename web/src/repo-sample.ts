// The Repo dashboard's SAMPLE set — the placeholder data from the Claude Design
// `Canopy Repo Dashboard.dc.html`, as a full `RepoDashboard` with every section
// live. It exists so the sections nothing has been captured for yet can still be
// seen (and visually tested) in their finished shape. It never reaches the Worker, is
// loaded on demand (a dynamic import — not in the main bundle), and the screen
// labels it "sample data" for as long as it is showing.

import type {
  RepoDashboard, RepoDeployRow, RepoEnvPart, RepoPartName, RepoPerson, RepoRange, RepoUsageEnv, RepoUsageMetric, RepoCfRow,
  RepoActivityKind, RepoPrState, RepoProductEnv, RepoProductGroup,
} from "@shared/repo";
import type { PersonColor } from "@shared/rows";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const PEOPLE: Record<string, [PersonColor, string]> = {
  "jose-a": ["moss", "Jose Alvarez"], meilin: ["sky", "Mei Lin"], "dev-raj": ["plum", "Dev Raj"], sanaok: ["rose", "Sana Okafor"],
  "priya-k": ["fern", "Priya Kumar"], "tom-h": ["rust", "Tom Hale"], "ana-r": ["slate", "Ana Ruiz"], "kenji-m": ["ochre", "Kenji Mori"],
};
const person = (login: string): RepoPerson => ({ login, handle: login, name: PEOPLE[login]?.[1] ?? null, color: PEOPLE[login]?.[0] ?? null });

export function repoSample(now: number = Date.now()): RepoDashboard {
  const at = (ms: number): string => new Date(now - ms).toISOString();
  const GH = "https://github.com/SaplingLearn/sapling";

  const prRows: [string, number, string, string, RepoPrState, "pass" | "fail" | "run", number][] = [
    ["Batch D1 reads in usage rollup", 482, "dev-raj", "feature/usage-rollup", "review", "pass", 24 * MIN],
    ["Notifications digest: quiet hours", 480, "meilin", "notif/quiet-hours", "approved", "pass", HOUR],
    ["fix: SSE reconnect drops auth header", 479, "jose-a", "fix/sse-auth", "review", "fail", 2 * HOUR],
    ["Coverage gate at 80% for worker", 477, "sanaok", "chore/coverage-gate", "draft", "run", 5 * HOUR],
    ["Migrate feed pagination to keyset", 474, "priya-k", "feat/keyset-pagination", "merged", "pass", 8 * HOUR],
    ["Triage map: fuzzy person match", 470, "ana-r", "design/triage-map", "review", "pass", DAY],
    ["D1 backup cron + restore script", 468, "kenji-m", "ops/d1-backup", "draft", "pass", 2 * DAY],
  ];

  const evRows: [RepoActivityKind, string | null, string, number][] = [
    ["push", "meilin", "pushed 2 commits to notif/quiet-hours", 12 * MIN],
    ["deploy", "dev-raj", "deployed a3f82c1 to staging", 26 * MIN],
    ["push", "dev-raj", "pushed 3 commits to feature/usage-rollup", 34 * MIN],
    ["issue", "sanaok", "opened #512 “Digest email renders twice on resend”", HOUR],
    ["review", "kenji-m", "approved #480", 2 * HOUR],
    ["push", "jose-a", "pushed 1 commit to fix/sse-auth", 2 * HOUR],
    ["issue", "tom-h", "opened #511 “wrangler dev hot-reload loops”", 3 * HOUR],
    ["push", "kenji-m", "pushed 2f19c3a to main (hotfix: clamp digest window)", 3 * HOUR],
    ["review", "meilin", "requested changes on #482", 4 * HOUR],
    ["push", "sanaok", "pushed 2 commits to chore/coverage-gate", 5 * HOUR],
    ["issue", "ana-r", "opened #510 “Triage map misses dotted handles”", 6 * HOUR],
    ["merge", "priya-k", "merged #474 “Migrate feed pagination to keyset”", 8 * HOUR],
    ["review", "dev-raj", "commented on #479", DAY],
    ["push", "ana-r", "pushed 4 commits to design/triage-map", DAY],
    ["close", "meilin", "closed #504 “Feed dedupe misses edits” as completed", DAY],
    ["merge", "tom-h", "merged #473 “chore: bump wrangler 4.86”", DAY],
    ["push", "priya-k", "pushed 1 commit to main (test: fix flaky keyset spec)", DAY],
    ["deploy", "jose-a", "deployed 9d417be to main", 2 * DAY],
    ["release", "meilin", "published v0.14.2", 6 * DAY],
    ["push", "tom-h", "pushed 1 commit to spike/edge-cache", 16 * DAY],
  ];

  // ── two deployables per environment ───────────────────────────────────────
  // Each environment ships a Railway API and a Cloudflare web build from the
  // same commit; the frontend lands a couple of minutes behind the API.
  type Dot = [string, number, string, "ok" | "fail" | "cancel"];
  const deploys = (rows: Dot[]) => rows.map(([sha, ms, by, result]) => ({ sha, at: at(ms), by, result }));
  const web = (rows: Dot[]): Dot[] => rows.map((r, i) => (i === rows.length - 1 ? [r[0], r[1] - 2 * MIN, r[2], r[3]] : r));
  const API: Record<"staging" | "production", Dot[]> = {
    staging: [["8c11d02", 3 * DAY, "meilin", "ok"], ["e4907fa", 3 * DAY, "sanaok", "ok"], ["1b6c3e9", 2 * DAY, "jose-a", "ok"], ["77d20ba", 2 * DAY, "priya-k", "cancel"], ["f0a94c7", 2 * DAY, "priya-k", "ok"], ["93be511", DAY, "tom-h", "ok"], ["ab27e64", DAY, "dev-raj", "ok"], ["c58f1d3", 22 * HOUR, "dev-raj", "fail"], ["d94ea08", 21 * HOUR, "dev-raj", "ok"], ["a3f82c1", 26 * MIN, "dev-raj", "ok"]],
    production: [["41c9de7", 14 * DAY, "jose-a", "ok"], ["5b803af", 12 * DAY, "meilin", "ok"], ["68d1c42", 11 * DAY, "kenji-m", "ok"], ["7e5b9d0", 9 * DAY, "sanaok", "ok"], ["8f26a13", 8 * DAY, "meilin", "fail"], ["90ab7c5", 8 * DAY, "meilin", "ok"], ["a1c38e6", 6 * DAY, "meilin", "ok"], ["b273f19", 5 * DAY, "tom-h", "ok"], ["c3841da", 3 * DAY, "priya-k", "ok"], ["9d417be", 2 * DAY, "jose-a", "ok"]],
  };
  const strips: Record<"staging" | "production", Record<RepoPartName, Dot[]>> = {
    staging: { backend: API.staging, frontend: web(API.staging) },
    production: { backend: API.production, frontend: web(API.production) },
  };
  const PART = { backend: ["api", "Railway"], frontend: ["web", "Cloudflare"] } as const;
  const deployRows: RepoDeployRow[] = (["staging", "production"] as const).flatMap((env) =>
    (["backend", "frontend"] as const).map((part) => ({ env, part, label: `${env} · ${PART[part][0]}`, deploys: deploys(strips[env][part]) })));
  const envParts = (env: "staging" | "production"): RepoEnvPart[] =>
    (["backend", "frontend"] as const).map((part) => {
      const [sha, ms, by, result] = strips[env][part][strips[env][part].length - 1];
      return { part, host: PART[part][1], sha, deployedAt: at(ms), deployedBy: by, result };
    });

  // Requests/error rate/active users connect independently (Cloudflare
  // analytics vs. the app's own metrics endpoint) — the sample keeps them all
  // live to show the section's finished shape; `tone: "neutral"` on
  // requests/users is a required field, not a color decision (only the error
  // metric's tone drives its value color).
  const metric = (value: string, trend: number[], tone: RepoUsageMetric["tone"]): RepoUsageMetric => ({ value, trend, tone });
  const env = (name: string, host: string, d: { req: string; reqA: number[]; err: number; errA: number[]; users: string; usersA: number[] }, warn: boolean): RepoUsageEnv => ({
    name, host,
    requests: metric(d.req, d.reqA, "neutral"),
    errorRate: metric(`${d.err.toFixed(2)}%`, d.errA, warn ? "warn" : "good"),
    users: metric(d.users, d.usersA, "neutral"),
    seen: { requests: true, users: true },
  });
  const usage: Record<RepoRange, RepoUsageEnv[]> = {
    "24h": [
      env("staging", "staging.saplinglearn.com", { req: "12.4K", reqA: [8, 11, 9, 14, 12, 18, 22, 17, 13, 15, 19, 16], err: 2.41, errA: [0.4, 0.6, 0.5, 1.1, 2.8, 3.4, 2.9, 2.2, 2.6, 2.4, 2.5, 2.4], users: "6", usersA: [2, 3, 3, 4, 5, 6, 6, 5, 4, 5, 6, 6] }, true),
      env("production", "saplinglearn.com", { req: "168K", reqA: [110, 125, 140, 160, 175, 190, 210, 195, 180, 170, 165, 172], err: 0.18, errA: [0.2, 0.15, 0.2, 0.18, 0.22, 0.16, 0.14, 0.19, 0.2, 0.17, 0.18, 0.18], users: "74", usersA: [40, 52, 61, 70, 78, 82, 85, 80, 76, 72, 70, 74] }, false),
    ],
    "7d": [
      env("staging", "staging.saplinglearn.com", { req: "86.2K", reqA: [10, 12, 14, 11, 16, 13, 12], err: 2.41, errA: [0.5, 0.7, 0.6, 0.9, 1.8, 2.6, 2.4], users: "9", usersA: [5, 6, 7, 6, 8, 9, 9] }, true),
      env("production", "saplinglearn.com", { req: "1.24M", reqA: [150, 165, 172, 180, 176, 190, 184], err: 0.21, errA: [0.24, 0.2, 0.19, 0.25, 0.22, 0.18, 0.21], users: "318", usersA: [265, 280, 296, 305, 312, 322, 318] }, false),
    ],
    "30d": [
      env("staging", "staging.saplinglearn.com", { req: "402K", reqA: [9, 11, 12, 10, 13, 12, 14, 13, 15, 12, 14, 16, 13, 12], err: 1.12, errA: [0.6, 0.5, 0.8, 0.7, 0.6, 0.9, 0.8, 0.7, 1, 0.9, 1.4, 2, 2.6, 2.4], users: "9", usersA: [6, 6, 7, 7, 8, 7, 8, 8, 9, 8, 9, 9, 9, 9] }, true),
      env("production", "saplinglearn.com", { req: "5.1M", reqA: [120, 132, 140, 150, 148, 158, 164, 170, 168, 176, 182, 188, 186, 184], err: 0.24, errA: [0.3, 0.28, 0.26, 0.3, 0.25, 0.22, 0.24, 0.26, 0.23, 0.2, 0.22, 0.21, 0.2, 0.21], users: "318", usersA: [210, 226, 240, 252, 260, 272, 280, 290, 296, 304, 310, 318, 315, 318] }, false),
    ],
  };
  // The Cloudflare panel's requests ARE the Requests metric's — the real
  // projection formats both from one sum, so the sample reads them off the same
  // field rather than keep a second set of numbers that can drift. Errors are
  // that row's requests × its error rate.
  const CF_ERRORS: Record<RepoRange, [string, string]> = { "24h": ["299", "302"], "7d": ["2.1K", "2.6K"], "30d": ["4.5K", "12.2K"] };
  const cf = (range: RepoRange): RepoCfRow[] => usage[range].flatMap((e, i) => [
    { env: e.name, label: "Workers requests", value: e.requests?.value ?? "0" },
    { env: e.name, label: "Workers errors", value: CF_ERRORS[range][i] },
  ]);

  // ── product metrics: what the app reports about itself ────────────────────
  // Production's numbers; staging is the same shape at a twelfth of the volume.
  // The windows nest (24h ≤ 7d ≤ 30d), as the contract guarantees, and the
  // figures are formatted as the Worker formats them (src/tools/repo.ts).
  const compact = (n: number): string => (n >= 999_950 ? `${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
  const dollars = (cents: number): string => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  /** Fourteen daily totals wandering up to today's — placeholder shape, deterministic. */
  // A small daily count (a handful of signups, a few 5xx) wobbles rather than climbs.
  const WOBBLE = [0.6, 1.3, 1, 1.6, 0.7, 1, 1.3, 2, 1, 0.7, 1.3, 1.6, 1.3, 1];
  const daily = (today: number): number[] => Array.from({ length: 14 }, (_, i) =>
    Math.round(today * (today < 20 ? WOBBLE[i] : 0.72 + 0.02 * i + ((i * 7) % 5) * 0.015)));
  // Labels and notes as the Worker's registry has them (src/repo/product.ts) —
  // this chunk cannot import it, so test/render.repo.test.ts holds the two together.
  const NOTES: Record<string, string> = {
    llm_cost_cents: "lower bound — unpriced models are not counted",
    flashcards_created: "lower bound — deleted cards are not counted",
    errors_4xx: "includes bot traffic and refused polls",
  };
  const PRODUCT: [string, string, [string, string, number, number, number][]][] = [
    ["growth", "Growth", [["signups", "Signups", 3, 21, 96], ["approvals", "Approvals", 2, 18, 88], ["logins", "Logins", 74, 182, 306]]],
    ["learning", "Learning activity", [
      ["tutor_sessions", "Tutor sessions", 212, 1_380, 5_640], ["chat_messages", "Chat messages", 1_840, 12_300, 49_800],
      ["quizzes_started", "Quizzes started", 96, 640, 2_710], ["quizzes_completed", "Quizzes completed", 71, 488, 2_050],
      ["documents_uploaded", "Documents uploaded", 38, 251, 1_020], ["flashcards_created", "Flashcards created", 410, 2_960, 11_400],
      ["notes_created", "Notes created", 57, 392, 1_610],
    ]],
    ["community", "Community", [["room_messages", "Room messages", 264, 1_910, 7_320], ["feedback", "Feedback", 4, 19, 73], ["issue_reports", "Issue reports", 1, 6, 22]]],
    ["ai", "AI spend", [["llm_calls", "LLM calls", 3_120, 21_400, 86_900], ["llm_tokens", "LLM tokens", 4_800_000, 33_100_000, 134_000_000], ["llm_cost_cents", "LLM cost", 412, 2_961, 11_830]]],
    ["reliability", "Reliability", [["errors_5xx", "5xx errors", 3, 17, 61], ["errors_4xx", "4xx errors", 142, 980, 3_870], ["quiz_generation_failed", "Quiz generation failed", 1, 9, 31], ["quiz_context_write_failed", "Quiz context write failed", 0, 0, 2],
      // Measured zeros beside real failures: the Reliability block folds the zeros into one line.
      ["rag_retrieval_failed", "RAG retrieval failed", 0, 0, 3], ["rag_visibility_resync_failed", "RAG visibility resync failed", 0, 0, 0], ["rag_chunks_dropped", "RAG runs that dropped chunks", 2, 11, 40],
    ]],
  ];
  const TOTALS: [string, string, number][] = [["users", "Users", 1_204], ["users_pending", "Users pending", 7], ["documents", "Documents", 8_420], ["flashcards", "Flashcards", 96_300], ["notes", "Notes", 12_750], ["rooms", "Rooms", 58]];
  const productEnv = (name: string, div: number): RepoProductEnv => {
    const scale = (n: number) => Math.round(n / div);
    const groups: RepoProductGroup[] = PRODUCT.map(([id, title, rows]) => ({ id, title, metrics: rows.map(([key, label, a, b, c]) => {
      const raw = { "24h": scale(a), "7d": scale(b), "30d": scale(c) };
      const fmt = key === "llm_cost_cents" ? dollars : compact;
      return { key, label, raw, values: { "24h": fmt(raw["24h"]), "7d": fmt(raw["7d"]), "30d": fmt(raw["30d"]) }, trend: daily(raw["24h"]), ...(NOTES[key] ? { note: NOTES[key] } : {}) };
    }) }));
    const totals = TOTALS.map(([key, label, n]) => ({ key, label, raw: scale(n), value: compact(scale(n)), trend: daily(scale(n)) }));
    return { name, groups, totals };
  };

  const cbVals = [3, 5, 2, 7, 4, 6, 1, 6, 7, 5, 8, 4, 7, 5];
  const commits = (rows: [string, string, number][]) => rows.map(([sha, msg, ms]) => ({ sha, msg, at: at(ms) }));

  return {
    repo: "SaplingLearn/sapling", generatedAt: at(0), degraded: false, sample: true,

    environments: { status: "ok", data: [
      { key: "staging", name: "staging", note: "main", tone: "warn", pill: "DEGRADED", parts: envParts("staging"), ci: "1 of 6 checks failing — e2e-smoke", ciTone: "bad", url: "https://staging.saplinglearn.com" },
      { key: "production", name: "production", note: "production", tone: "good", pill: "HEALTHY", parts: envParts("production"), ci: "All 6 checks passing", ciTone: "good", url: "https://saplinglearn.com" },
    ] },
    drift: { status: "ok", data: { head: "staging", base: "main", ahead: 12, behind: 1, groups: [
      { tag: "#482", kind: "pr", title: "Batch D1 reads in usage rollup", meta: "dev-raj · 3 commits", commits: commits([["c91d2ae", "rollup: batch D1 reads per window", 24 * MIN], ["b02f1cd", "fix window math off-by-one", HOUR], ["a3f82c1", "wire usage endpoint to rollup", 2 * HOUR]]) },
      { tag: "#480", kind: "pr", title: "Notifications digest: quiet hours", meta: "meilin · 4 commits", commits: commits([["f21ac03", "quiet hours: per-person window", HOUR], ["e0b391d", "digest: skip empty batches", 4 * HOUR], ["d7c25aa", "policy: quiet-hours pref plumbing", 7 * HOUR], ["c5590fe", "migration 0027: quiet_hours", 9 * HOUR]]) },
      { tag: "#479", kind: "pr", title: "fix: SSE reconnect drops auth header", meta: "jose-a · 2 commits", commits: commits([["9b04e7f", "sse: re-send bearer on reconnect", 2 * HOUR], ["8a3c1d0", "test: reconnect keeps principal", 3 * HOUR]]) },
      { tag: "PUSH", kind: "push", title: "Direct pushes to staging", meta: "3 commits", commits: commits([["7f92b45", "docs: note D1 batch limits", 5 * HOUR], ["6e15a3c", "chore: bump wrangler 4.86 lockfile", DAY], ["5d0c821", "test: fix flaky keyset spec", DAY]]) },
      { tag: "BEHIND", kind: "behind", title: "Only on main — not yet on staging", meta: "1 commit", commits: commits([["2f19c3a", "hotfix: clamp digest window to 24h", 3 * HOUR]]) },
    ] } },
    stats: { status: "ok", data: [
      { label: "Open PRs", value: 7, delta: 2, tone: "neutral" },
      { label: "Awaiting review", value: 3, delta: 1, tone: "neutral" },
      { label: "Open issues", value: 24, delta: -3, tone: "good" },
      { label: "Open bugs", value: 6, delta: 1, tone: "warn" },
    ] },
    health: { status: "ok", data: [
      { env: "staging · web", url: "https://staging.saplinglearn.com", up: true, ms: 148 },
      { env: "staging · api", url: "https://api.staging.saplinglearn.com/api/health", up: true, ms: 212 },
      { env: "production · web", url: "https://saplinglearn.com", up: true, ms: 121 },
      { env: "production · api", url: "https://api.saplinglearn.com/api/health", up: true, ms: 168 },
    ] },

    codeStats: { status: "ok", data: [
      { label: "Open PRs", value: 7, sub: "3 awaiting review", tone: "neutral" },
      { label: "Merged this week", value: 9, sub: "by 5 people", tone: "neutral" },
      { label: "Commits this week", value: 42, sub: "▲ 8 vs last week", tone: "neutral" },
      { label: "Active branches", value: 14, sub: "2 stale", tone: "warn" },
    ] },
    bars: { status: "ok", data: {
      title: "Commit activity — last 14 days", note: "70 commits · all branches",
      days: cbVals.map((count, i) => ({ date: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10), count })),
    } },
    // 7 open, matching the "Open PRs" tile above.
    prs: { status: "ok", data: { openCount: 7, rows: prRows.map(([title, number, login, branch, state, checks, ms]) => ({
      number, title, url: `${GH}/pull/${number}`, author: person(login), branch, state, checks, at: at(ms),
    })) } },
    branches: { status: "ok", data: { active: 14, stale: 2, head: "main", rows: [
      { name: "feature/usage-rollup", at: at(24 * MIN), ahead: 4, behind: 0, stale: false },
      { name: "notif/quiet-hours", at: at(HOUR), ahead: 2, behind: 1, stale: false },
      { name: "fix/sse-auth", at: at(2 * HOUR), ahead: 1, behind: 0, stale: false },
      { name: "chore/coverage-gate", at: at(5 * HOUR), ahead: 3, behind: 2, stale: false },
      { name: "spike/edge-cache", at: at(16 * DAY), ahead: 7, behind: 31, stale: true },
      { name: "design/triage-map", at: at(21 * DAY), ahead: 2, behind: 48, stale: true },
    ] } },

    deploys: { status: "ok", data: deployRows },
    ciFailures: { status: "ok", data: { rate: 6.7, trend: [4, 9, 6, 3, 11, 8, 5], rows: [
      { workflow: "e2e-smoke", branch: "staging", job: "auth flow · shard 1/2", at: at(26 * MIN), url: `${GH}/actions` },
      { workflow: "test", branch: "fix/sse-auth", job: "vitest · shard 2/4", at: at(2 * HOUR), url: `${GH}/actions` },
      { workflow: "deploy-staging", branch: "staging", job: "wrangler publish", at: at(22 * HOUR), url: `${GH}/actions` },
    ], total: 3 } },
    coverage: { status: "ok", data: { value: "78.4%", trend: [76.1, 76.4, 76.2, 77.0, 77.4, 77.2, 77.9, 78.1, 78.0, 78.4], delta: "+1.2", tone: "good", note: "this month · gate at 75%" } },
    bundle: { status: "ok", data: { value: "412 KB", trend: [388, 390, 395, 393, 398, 401, 406, 404, 409, 412], delta: "+6 KB", tone: "warn", note: "this week · gzip, main bundle" } },
    activity: { status: "ok", data: evRows.map(([kind, login, text, ms]) => ({ kind, actor: login ? person(login) : null, text, url: null, at: at(ms) })) },

    usage: { status: "ok", data: usage },
    // The target app has no D1 (it runs on Supabase) — this panel is the
    // frontend Workers only, so its second row is Workers errors, not D1 reads.
    cloudflare: { status: "ok", data: { "24h": cf("24h"), "7d": cf("7d"), "30d": cf("30d") } },
    // Placeholder rows like every other section: the banner promises EVERY
    // section is shown with sample values, and an unconnected block here would
    // tell someone previewing the screen to go and set a Railway secret.
    hosting: { status: "ok", data: [
      { env: "staging", cpu: "0.12 vCPU", memory: "410 MB" },
      { env: "production", cpu: "0.48 vCPU", memory: "1229 MB" },
    ] },
    product: { status: "ok", data: [productEnv("staging", 12), productEnv("production", 1)] },

    sprint: { status: "ok", data: { id: 0, label: "M6 — Notifications GA", due: new Date(now + 12 * DAY).toISOString().slice(0, 10), closed: 21, total: 34, pct: 62 } },
    contributors: { status: "ok", data: ([["jose-a", 14, 3, 6], ["meilin", 11, 4, 8], ["dev-raj", 9, 2, 3], ["sanaok", 7, 1, 5], ["priya-k", 6, 2, 2], ["tom-h", 4, 1, 1], ["ana-r", 3, 0, 4], ["kenji-m", 2, 1, 0]] as [string, number, number, number][])
      .map(([login, pushes, merged, reviews]) => ({ person: person(login), pushes, merged, reviews })) },
    labels: { status: "ok", data: { total: 24, rows: [{ name: "enhancement", count: 9 }, { name: "bug", count: 6 }, { name: "infra", count: 4 }, { name: "docs", count: 3 }, { name: "design", count: 2 }] } },
    todos: { status: "ok", data: { count: 43, delta: -18, since: "Aug 1", trend: [61, 58, 59, 54, 50, 51, 47, 44, 45, 43] } },
  };
}
