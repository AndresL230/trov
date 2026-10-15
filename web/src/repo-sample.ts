// The Repo dashboard's SAMPLE set — the placeholder data from the Claude Design
// `Canopy Repo Dashboard.dc.html`, as a full `RepoDashboard` with every section
// live. It exists so the sections nothing has been captured for yet can still be
// seen (and visually tested) in their finished shape. It never reaches the Worker, is
// loaded on demand (a dynamic import — not in the main bundle), and the screen
// labels it "sample data" for as long as it is showing.

import {
  deployDots, envPartOf,
  type RepoDashboard, type RepoDeployRow, type RepoEnvPart, type RepoPerson, type RepoRange, type RepoUsageEnv, type RepoUsageMetric,
  type RepoActivityKind, type RepoPrState, type RepoProductEnv, type RepoProductGroup, REPO_RANGES,
} from "@shared/repo";
import type { PersonColor } from "@shared/rows";
import type {
  DeployState, HostingMetric, HostingProviderId, PartRole, ProviderDeployDTO, ProviderResources, ProviderTrafficRange, RepoProviderPart,
} from "@shared/hosting";
import type { AppKind } from "@shared/repo-apps-core";
import { APP_KIND_ROLE } from "@shared/repo-apps-core";
import type { PartExtras, UsageFamily, UsageOutcome } from "@shared/usage-families-core";
import {
  narrowFacts,
  type FactsApp, type FactsAttention, type FactsCi, type FactsCommitGroup, type FactsConnect, type FactsDeploy, type FactsDriftStep,
  type FactsFound, type FactsHealth, type FactsNotShipped, type FactsOutOfStep, type FactsPart, type FactsPreview, type FactsRelease,
  type FactsUnseen, type FactsWeekFigure, type RepoFacts, type WeekKey,
} from "@shared/repo-facts-core";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const PEOPLE: Record<string, [PersonColor, string]> = {
  "jose-a": ["moss", "Jose Alvarez"], meilin: ["sky", "Mei Lin"], "dev-raj": ["plum", "Dev Raj"], sanaok: ["rose", "Sana Okafor"],
  "priya-k": ["fern", "Priya Kumar"], "tom-h": ["rust", "Tom Hale"], "ana-r": ["slate", "Ana Ruiz"], "kenji-m": ["ochre", "Kenji Mori"],
};
const person = (login: string): RepoPerson => ({ login, handle: login, name: PEOPLE[login]?.[1] ?? null, color: PEOPLE[login]?.[0] ?? null });

export function repoSample(now: number = Date.now()): RepoDashboard {
  const at = (ms: number): string => new Date(now - ms).toISOString();
  const GH = "https://github.com/acme/web";

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

  // ── the Cloudflare frontend and the Railway backend: ordinary parts ────────
  // Each environment ships a Railway API and a Cloudflare Workers web build from
  // the same commit; the frontend lands a couple of minutes behind the API. Both
  // are provider deploys like every other part's (`hostDeploys` below), and the
  // environment cards and deploy strips are derived from the parts' deploys by
  // the projection's own functions (`envPartOf` / `deployDots`).
  type Dot = [string, number, string, "ok" | "fail" | "cancel"];
  const API: Record<"staging" | "production", Dot[]> = {
    staging: [["8c11d02", 3 * DAY, "meilin", "ok"], ["e4907fa", 3 * DAY, "sanaok", "ok"], ["1b6c3e9", 2 * DAY, "jose-a", "ok"], ["77d20ba", 2 * DAY, "priya-k", "cancel"], ["f0a94c7", 2 * DAY, "priya-k", "ok"], ["93be511", DAY, "tom-h", "ok"], ["ab27e64", DAY, "dev-raj", "ok"], ["c58f1d3", 22 * HOUR, "dev-raj", "fail"], ["d94ea08", 21 * HOUR, "dev-raj", "ok"], ["a3f82c1", 26 * MIN, "dev-raj", "ok"]],
    production: [["41c9de7", 14 * DAY, "jose-a", "ok"], ["5b803af", 12 * DAY, "meilin", "ok"], ["68d1c42", 11 * DAY, "kenji-m", "ok"], ["7e5b9d0", 9 * DAY, "sanaok", "ok"], ["8f26a13", 8 * DAY, "meilin", "fail"], ["90ab7c5", 8 * DAY, "meilin", "ok"], ["a1c38e6", 6 * DAY, "meilin", "ok"], ["b273f19", 5 * DAY, "tom-h", "ok"], ["c3841da", 3 * DAY, "priya-k", "ok"], ["9d417be", 2 * DAY, "jose-a", "ok"]],
  };

  // Requests / error rate (summed over each environment's web parts, below) and
  // active users connect independently (the hosting providers vs. the app's own
  // metrics endpoint) — the sample keeps them all live to show the section's
  // finished shape; `tone: "neutral"` on requests/users is a required field,
  // not a color decision (only the error metric's tone drives its value color).
  const metric = (value: string, trend: number[], tone: RepoUsageMetric["tone"]): RepoUsageMetric => ({ value, trend, tone });
  const USERS: Record<"staging" | "production", Record<RepoRange, [string, number[]]>> = {
    staging: { "24h": ["6", [2, 3, 3, 4, 5, 6, 6, 5, 4, 5, 6, 6]], "7d": ["9", [5, 6, 7, 6, 8, 9, 9]], "30d": ["9", [6, 6, 7, 7, 8, 7, 8, 8, 9, 8, 9, 9, 9, 9]] },
    production: {
      "24h": ["74", [40, 52, 61, 70, 78, 82, 85, 80, 76, 72, 70, 74]], "7d": ["318", [265, 280, 296, 305, 312, 322, 318]],
      "30d": ["318", [210, 226, 240, 252, 260, 272, 280, 290, 296, 304, 310, 318, 315, 318]],
    },
  };

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

  // ── hosting providers: every part of every environment, provider-neutral ──
  // It holds every state the projection (src/tools/repo.ts `projectProviders`) can produce: a Cloudflare
  // Workers frontend (requests and errors only) and a Railway backend (resources); Vercel and Netlify web
  // parts with deploys and NO traffic (`traffic: null`, `unavailable` saying why — neither has a public
  // usage API); Render, a service (CPU / memory with a 24-hour trend) and a web part (requests, errors,
  // latency and bandwidth in every range); Fly.io, a service whose releases carry no sha and a web part;
  // one part whose last poll FAILED and one that is `empty` (polled, nothing to show). Every total is the
  // sum of its trend, every error rate errors ÷ requests — the numbers agree the way the Worker's do.
  const hour0 = Math.floor(now / HOUR) * HOUR;               // the current hour's start; the last complete hour ends here
  const isoAt = (t: number) => new Date(t).toISOString();
  /** `n` values summing EXACTLY to `total`, shaped by `shape(i)` (deterministic, never random). */
  const spread = (total: number, n: number, shape: (i: number) => number): number[] => {
    const w = Array.from({ length: n }, (_, i) => Math.max(0.05, shape(i)));
    const sum = w.reduce((a, b) => a + b, 0);
    const out = w.map((x) => Math.floor((x / sum) * total));
    out[n - 1] += total - out.reduce((a, b) => a + b, 0);
    return out;
  };
  /** A day's traffic: low overnight (UTC), a peak mid-afternoon, a little wobble. */
  const diurnal = (i: number) => 0.55 + 0.45 * Math.sin(((i - 9) / 24) * 2 * Math.PI) + ((i * 7) % 5) * 0.03;
  const weekly = (i: number) => 1 + ((i * 3) % 7) * 0.04 - (i % 7 === 5 || i % 7 === 6 ? 0.18 : 0);
  type Totals = { requests: number; errors: number; latency?: number; bandwidth?: number };
  /** One web part's traffic in all three ranges, from each range's totals. Buckets end at the last complete
   *  hour: hourly for 24h, daily for 7d / 30d. Bandwidth / latency are null where the provider has none. */
  const traffic = (t: Record<RepoRange, Totals>): Record<RepoRange, ProviderTrafficRange> => {
    const one = (range: RepoRange): ProviderTrafficRange => {
      const n = range === "24h" ? 24 : range === "7d" ? 7 : 30;
      const step = range === "24h" ? HOUR : DAY;
      const shape = range === "24h" ? diurnal : weekly;
      const req = spread(t[range].requests, n, shape);
      const err = spread(t[range].errors, n, (i) => shape(i) * (i === n - 3 ? 3 : 1)); // one bad bucket
      const start = hour0 - n * step;
      return {
        requests: t[range].requests, errors: t[range].errors,
        error_rate: Math.round((t[range].errors / t[range].requests) * 10_000) / 100,
        latency_p95_ms: t[range].latency ?? null, bandwidth_bytes: t[range].bandwidth ?? null,
        trend: req.map((v, i) => ({ at: isoAt(start + i * step), requests: v, errors: err[i] })),
      };
    };
    return { "24h": one("24h"), "7d": one("7d"), "30d": one("30d") };
  };
  /** A service part's last 24 hourly readings, never zero-filled — one hour missing (a poll that did not land). */
  const resources = (cpu: number, mem: number, missing = 9): ProviderResources => {
    const trend = Array.from({ length: 24 }, (_, i) => i).filter((i) => i !== missing).map((i) => ({
      at: isoAt(hour0 - (24 - i) * HOUR),
      cpu: Math.round(cpu * (0.7 + 0.3 * diurnal(i)) * 100) / 100,
      mem_mb: Math.round(mem * (0.92 + 0.08 * diurnal(i)) * 10) / 10,
    }));
    trend[trend.length - 1] = { ...trend[trend.length - 1], cpu, mem_mb: mem };
    return { cpu, mem_mb: mem, at: trend[trend.length - 1].at, trend };
  };
  type Dep = [id: string, state: DeployState, ms: number, sha: string | null, msg: string | null, by: string | null];
  const SHA = (seed: string) => (seed.repeat(8) + "0123456789abcdef".repeat(3)).slice(0, 40);
  const hostDeploys = (rows: Dep[], o: { branch: string | null; target: ProviderDeployDTO["target"]; url?: (id: string) => string; inspect: (id: string) => string }): ProviderDeployDTO[] =>
    rows.map(([id, state, ms, sha, message, by]) => ({
      id, state, target: o.target, sha, branch: o.branch, message, by, at: at(ms),
      ready_at: state === "ready" || state === "error" ? at(ms - 2 * MIN) : null,
      url: o.url && state === "ready" ? o.url(id) : null, inspect_url: o.inspect(id),
    }));
  /** The Cloudflare frontend's and the Railway backend's deploys, NEWEST first, from the `API` rows above: the
   *  frontend (`lag` 2 minutes) lands a little after the API it ships with. */
  const DOT_STATE = { ok: "ready", fail: "error", cancel: "canceled" } as const;
  const stackDeploys = (envKey: "staging" | "production", half: "frontend" | "backend", branch: string): ProviderDeployDTO[] => {
    const CF = `https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/${envKey === "staging" ? "frontend-staging" : "frontend"}/production`;
    const RW = "https://railway.com/project/5e1f0c2a-7b3d-4c8e-9a10-2b3c4d5e6f70/service/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    return hostDeploys([...API[envKey]].reverse().map(([sha, ms, by, result]): Dep =>
      [half === "frontend" ? `cfv-${sha}` : `rw-${sha}`, DOT_STATE[result], half === "frontend" ? ms - 2 * MIN : ms, SHA(sha), null, by]),
    { branch, target: "production", inspect: (id) => (half === "frontend" ? `${CF}/deployments` : `${RW}?id=${id}`) });
  };
  const unavailableWeb = (reason: string): { metric: HostingMetric; reason: string }[] =>
    (["requests", "errors", "latency_p50_ms", "latency_p95_ms", "bandwidth_bytes"] as const).map((metric) => ({ metric, reason }));
  const LABELS: Record<HostingProviderId, string> = {
    cloudflare: "Cloudflare Workers", railway: "Railway", vercel: "Vercel", render: "Render", netlify: "Netlify", fly: "Fly.io", aws: "AWS", github: "GitHub deployments",
  };
  const polledOk = (ms: number, detail: string): RepoProviderPart["last_poll"] => ({ at: at(ms), status: "ok", detail });
  const part = (envKey: "staging" | "production", key: string, label: string, role: PartRole, provider: HostingProviderId,
    o: Partial<RepoProviderPart> & Pick<RepoProviderPart, "deploys" | "tone" | "status">): RepoProviderPart => ({
    env: envKey, env_label: envKey, part: key, label, role, provider, provider_label: LABELS[provider], console_url: null,
    traffic: null, resources: null, unavailable: [], last_poll: null,
    seen: { traffic: role === "web" && !!o.traffic, resources: role === "service" && !!o.resources, deploys: o.deploys.length > 0 },
    ...o,
  });
  const providers: RepoProviderPart[] = [
    // ── staging ──
    part("staging", "frontend", "Frontend", "web", "cloudflare", {
      console_url: "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/frontend-staging/production",
      deploys: stackDeploys("staging", "frontend", "main"), status: "ok", tone: "warn", // 2.41% errors in the last 24 h
      traffic: traffic({ "24h": { requests: 12_400, errors: 299 }, "7d": { requests: 86_200, errors: 2_100 }, "30d": { requests: 402_000, errors: 4_500 } }),
      last_poll: polledOk(18 * MIN, "2 new points, 1 new or changed deploy"),
    }),
    part("staging", "backend", "Backend", "service", "railway", {
      deploys: stackDeploys("staging", "backend", "main"), status: "ok", tone: "good", resources: resources(0.12, 410),
      last_poll: polledOk(18 * MIN, "2 new points, 1 new or changed deploy"),
    }),
    part("staging", "web", "Marketing site", "web", "vercel", {
      console_url: "https://vercel.com/acme/marketing", status: "ok", tone: "neutral", // the newest deploy is still building
      deploys: hostDeploys([
        ["dpl_8Fq2kLm", "building", 4 * MIN, SHA("c91d2ae"), "rollup: batch D1 reads per window", "dev-raj"],
        ["dpl_7Hn1jKp", "ready", 2 * HOUR, SHA("9b04e7f"), "sse: re-send bearer on reconnect", "jose-a"],
        ["dpl_6Gm0hJo", "error", 5 * HOUR, SHA("7f92b45"), "docs: note D1 batch limits", "kenji-m"],
        ["dpl_5Fl9gIn", "ready", DAY, SHA("6e15a3c"), "chore: bump wrangler 4.86 lockfile", "tom-h"],
        ["dpl_4Ek8fHm", "canceled", DAY + 3 * HOUR, SHA("5d0c821"), "test: fix flaky keyset spec", "priya-k"],
        ["dpl_3Dj7eGl", "ready", 2 * DAY, SHA("2f19c3a"), "hotfix: clamp digest window to 24h", "kenji-m"],
      ], { branch: "main", target: "preview", url: (id) => `https://marketing-${id.slice(4, 10).toLowerCase()}-acme.vercel.app`, inspect: (id) => `https://vercel.com/acme/marketing/${id.slice(4)}` }),
      unavailable: unavailableWeb("Vercel has no public usage API — traffic needs Observability Plus"),
      last_poll: polledOk(18 * MIN, "0 new points, 2 new or changed deploys"),
    }),
    part("staging", "api", "API", "service", "render", {
      console_url: "https://dashboard.render.com/web/srv-cq1a2b3c4d5e6f7g8h9i", status: "ok", tone: "good",
      deploys: hostDeploys([
        ["dep-cs1k9e2", "ready", 26 * MIN, SHA("a3f82c1"), "wire usage endpoint to rollup", null],
        ["dep-cs0j8d1", "ready", 21 * HOUR, SHA("d94ea08"), "retry: idempotent digest send", null],
        ["dep-cr9i7c0", "error", 22 * HOUR, SHA("c58f1d3"), "migration 0027: quiet_hours", null],
      ], { branch: "main", target: null, inspect: (id) => `https://dashboard.render.com/web/srv-cq1a2b3c4d5e6f7g8h9i/deploys/${id}` }),
      resources: resources(0.31, 742),
      last_poll: polledOk(18 * MIN, "3 new points, 1 new or changed deploy"),
    }),
    part("staging", "edge", "Edge cache", "web", "fly", {
      console_url: "https://fly.io/apps/acme-edge-staging", status: "ok", tone: "good",
      deploys: hostDeploys([
        ["01J9ZB6Q4X", "ready", 3 * HOUR, null, null, "kenji@acme.example"],
        ["01J9Y2M7R1", "ready", 3 * DAY, null, null, "kenji@acme.example"],
      ], { branch: null, target: "production", inspect: () => "https://fly.io/apps/acme-edge-staging/monitoring" }),
      traffic: traffic({
        "24h": { requests: 8_900, errors: 6, latency: 41, bandwidth: 1_840_000_000 },
        "7d": { requests: 61_300, errors: 52, latency: 41, bandwidth: 12_600_000_000 },
        "30d": { requests: 248_000, errors: 260, latency: 41, bandwidth: 51_200_000_000 },
      }),
      unavailable: [{ metric: "latency_p50_ms", reason: "Fly's edge histogram is read for p95 only" }],
      last_poll: polledOk(18 * MIN, "6 new points, 0 new or changed deploys"),
    }),
    // ── production ──
    part("production", "frontend", "Frontend", "web", "cloudflare", {
      console_url: "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/frontend/production",
      deploys: stackDeploys("production", "frontend", "production"), status: "ok", tone: "good",
      traffic: traffic({ "24h": { requests: 168_000, errors: 302 }, "7d": { requests: 1_240_000, errors: 2_600 }, "30d": { requests: 5_100_000, errors: 12_200 } }),
      last_poll: polledOk(18 * MIN, "2 new points, 0 new or changed deploys"),
    }),
    part("production", "backend", "Backend", "service", "railway", {
      deploys: stackDeploys("production", "backend", "production"), status: "ok", tone: "good", resources: resources(0.48, 1229),
      last_poll: polledOk(18 * MIN, "2 new points, 0 new or changed deploys"),
    }),
    part("production", "web", "Marketing site", "web", "netlify", {
      console_url: "https://app.netlify.com/sites/acme-marketing", status: "ok", tone: "warn", // the last poll failed
      deploys: hostDeploys([
        ["66f0c1a2b3c4d5e6f7a8b9c0", "ready", 2 * DAY, SHA("9d417be"), "Release 0.14.2", "meilin"],
        ["66ee71d0e1f2a3b4c5d6e7f8", "ready", 6 * DAY, SHA("a1c38e6"), "Pricing page copy", "ana-r"],
        ["66ec2bf9a8b7c6d5e4f3a2b1", "error", 6 * DAY + 2 * HOUR, SHA("90ab7c5"), "Pricing page copy", "ana-r"],
      ], { branch: "production", target: "production", url: () => "https://www.example.com", inspect: (id) => `https://app.netlify.com/sites/acme-marketing/deploys/${id}` }),
      unavailable: unavailableWeb("Netlify has no documented usage API"),
      last_poll: { at: at(18 * MIN), status: "failed", detail: "netlify deploys 401: Unauthorized — the credential is not valid" },
    }),
    part("production", "site", "Docs site", "web", "render", {
      console_url: "https://dashboard.render.com/static/srv-d0k1l2m3n4o5p6q7r8s9", status: "ok", tone: "good",
      deploys: hostDeploys([
        ["dep-ct4n2h5", "ready", 2 * DAY, SHA("c3841da"), "docs: environments and parts", null],
        ["dep-ct3m1g4", "ready", 9 * DAY, SHA("7e5b9d0"), "docs: Poll now", null],
      ], { branch: "production", target: null, inspect: (id) => `https://dashboard.render.com/static/srv-d0k1l2m3n4o5p6q7r8s9/deploys/${id}` }),
      traffic: traffic({
        "24h": { requests: 41_200, errors: 37, latency: 212, bandwidth: 3_900_000_000 },
        "7d": { requests: 296_000, errors: 310, latency: 198, bandwidth: 27_800_000_000 },
        "30d": { requests: 1_210_000, errors: 1_420, latency: 205, bandwidth: 113_000_000_000 },
      }),
      last_poll: polledOk(18 * MIN, "4 new points, 0 new or changed deploys"),
    }),
    part("production", "worker", "Queue worker", "service", "fly", {
      console_url: "https://fly.io/apps/acme-worker", status: "ok", tone: "bad", // the newest release failed
      deploys: hostDeploys([
        ["01JA0C2D3E", "error", 50 * MIN, null, null, "jose@acme.example"],
        ["01J9X8Y7Z6", "ready", 2 * DAY, null, null, "jose@acme.example"],
        ["01J9V5W4X3", "ready", 8 * DAY, null, null, "meilin@acme.example"],
      ], { branch: null, target: "production", inspect: () => "https://fly.io/apps/acme-worker/monitoring" }),
      resources: resources(0.9, 1830, 4),
      last_poll: polledOk(18 * MIN, "2 new points, 1 new or changed deploy"),
    }),
    part("production", "docs", "Status page", "web", "netlify", {
      console_url: "https://app.netlify.com/sites/acme-status", status: "empty", tone: "neutral", deploys: [], // polled: nothing in 90 days
      unavailable: unavailableWeb("Netlify has no documented usage API"),
      last_poll: polledOk(18 * MIN, "0 new points, 0 new or changed deploys"),
    }),
  ];

  // ── what the projection derives from the parts: the environment cards' lines, the deploy strips, and the
  // Usage compare's requests / error rate (each environment's web parts summed, as `projectUsage` does) ──
  const envParts = (envKey: "staging" | "production"): RepoEnvPart[] =>
    providers.filter((p) => p.env === envKey).map((p) => envPartOf(p, p.deploys));
  const deployRows: RepoDeployRow[] = providers.flatMap((p) => {
    const dots = deployDots(p.deploys);
    return dots.length ? [{ env: p.env, part: p.part, label: `${p.env_label} · ${p.label}`, deploys: dots }] : [];
  });
  const usageEnv = (envKey: "staging" | "production", host: string, range: RepoRange): RepoUsageEnv => {
    const web = providers.filter((p) => p.env === envKey && p.traffic).map((p) => p.traffic![range]);
    const requests = web.reduce((n, t) => n + (t.requests ?? 0), 0);
    const errors = web.reduce((n, t) => n + (t.errors ?? 0), 0);
    const reqTrend = web[0].trend.map((_, i) => web.reduce((n, t) => n + (t.trend[i]?.requests ?? 0), 0));
    const errTrend = web[0].trend.map((_, i) => web.reduce((n, t) => n + (t.trend[i]?.errors ?? 0), 0));
    const rate = (errors / requests) * 100;
    const [users, usersA] = USERS[envKey][range];
    return {
      name: envKey, host,
      requests: metric(compact(requests), reqTrend, "neutral"),
      errorRate: metric(`${rate.toFixed(2)}%`, errTrend.map((e, i) => (reqTrend[i] ? (e / reqTrend[i]) * 100 : 0)), rate >= 1 ? "warn" : "good"),
      users: metric(users, usersA, "neutral"),
      seen: { requests: true, users: true },
    };
  };
  const usage = Object.fromEntries((["24h", "7d", "30d"] as const).map((r) =>
    [r, [usageEnv("staging", "staging.example.com", r), usageEnv("production", "example.com", r)]])) as Record<RepoRange, RepoUsageEnv[]>;

  const cbVals = [3, 5, 2, 7, 4, 6, 1, 6, 7, 5, 8, 4, 7, 5];
  const commits = (rows: [string, string, number][]) => rows.map(([sha, msg, ms]) => ({ sha, msg, at: at(ms) }));

  return {
    repo: "acme/web", generatedAt: at(0), degraded: false, sample: true,

    environments: { status: "ok", data: [
      { key: "staging", name: "staging", note: "main", tone: "warn", pill: "DEGRADED", parts: envParts("staging"), ci: "1 of 6 checks failing — e2e-smoke", ciTone: "bad", url: "https://staging.example.com" },
      // The queue worker's newest release failed: a failed part is FAILING whatever the checks say.
      { key: "production", name: "production", note: "production", tone: "bad", pill: "FAILING", parts: envParts("production"), ci: "All 6 checks passing", ciTone: "good", url: "https://example.com" },
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
      { env: "staging · web", url: "https://staging.example.com", up: true, ms: 148 },
      { env: "staging · api", url: "https://api.staging.example.com/api/health", up: true, ms: 212 },
      { env: "production · web", url: "https://example.com", up: true, ms: 121 },
      { env: "production · api", url: "https://api.example.com/api/health", up: true, ms: 168 },
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
    providers: { status: "ok", data: providers },
    product: { status: "ok", data: [productEnv("staging", 12), productEnv("production", 1)] },

    sprint: { status: "ok", data: { id: 0, label: "M6 — Notifications GA", due: new Date(now + 12 * DAY).toISOString().slice(0, 10), closed: 21, total: 34, pct: 62 } },
    contributors: { status: "ok", data: ([["jose-a", 14, 3, 6], ["meilin", 11, 4, 8], ["dev-raj", 9, 2, 3], ["sanaok", 7, 1, 5], ["priya-k", 6, 2, 2], ["tom-h", 4, 1, 1], ["ana-r", 3, 0, 4], ["kenji-m", 2, 1, 0]] as [string, number, number, number][])
      .map(([login, pushes, merged, reviews]) => ({ person: person(login), pushes, merged, reviews })) },
    labels: { status: "ok", data: { total: 24, rows: [{ name: "enhancement", count: 9 }, { name: "bug", count: 6 }, { name: "infra", count: 4 }, { name: "docs", count: 3 }, { name: "design", count: 2 }] } },
    todos: { status: "ok", data: { count: 43, delta: -18, since: "Aug 1", trend: [61, 58, 59, 54, 50, 51, 47, 44, 45, 43] } },
  };
}

// ── Repo setups: the design's scenarios A–N as `RepoFacts` ────────────────────
// The scenarios of docs/superpowers/specs/repo-setups-design/repo-data.js (`SC.A` … `SC.N`, with their variants),
// translated into the facts the server reads (shared/repo-facts-core.ts), so the Overview's sample switch and
// the tests draw from the same object a live repository produces. Each scenario below is written in the
// design's own shape (apps, envs, targets with ages like '26m') and `factsOf` turns it into `RepoFacts`: ages →
// ISO times before `now`, hosts → provider ids, a target → a part with its serving / latest / history deploys
// and health. test/repo-sample.scenarios.test.ts holds every fixture to the design's `buildScreen` (same rule,
// opener and Group by) for every variant, App narrowing and Group by.

// The keys, titles and variants live in ./repo-sample-keys.ts (no fixture data), so the Overview's sample switch can
// draw its dropdowns without pulling this module into the main bundle; they are re-exported here unchanged.
import { SCENARIO_VARIANTS, type ScenarioKey } from "./repo-sample-keys";
export { SCENARIO_KEYS, SCENARIO_TITLES, SCENARIO_VARIANTS, REPO_SCENARIOS, isScenarioKey, type ScenarioKey } from "./repo-sample-keys";

// `github` joins HOSTING_PROVIDERS in Phase A (the GitHub-deployments provider); until then the one part that
// needs it (H's normalizer, on Cloud Run, which no provider reads) names it through this cast.
const GITHUB_PROVIDER = "github" as string as HostingProviderId;
const PROVIDER_OF_HOST: Record<string, HostingProviderId> = {
  Cloudflare: "cloudflare", "Cloudflare Pages": "cloudflare", Railway: "railway", Vercel: "vercel", Render: "render", Netlify: "netlify",
  "Fly.io": "fly", "Cloud Run": GITHUB_PROVIDER,
};
/** The providers' labels as the registry has them (src/hosting/providers/*.ts). */
const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare Workers", railway: "Railway", vercel: "Vercel", render: "Render", netlify: "Netlify", fly: "Fly.io", aws: "AWS",
  github: "GitHub deployments",
};
/** Whether each provider reports any usage metric — the registry's `capabilities.metrics` non-empty
 *  (src/hosting/providers/*.ts): Vercel and Netlify publish none, GitHub deployments carry no metrics. */
const PROVIDER_METRICS: Record<string, boolean> = {
  cloudflare: true, railway: true, vercel: false, render: true, netlify: false, fly: true, aws: true, github: false,
};
const WEEK_KEY: Record<string, WeekKey> = {
  "Merged PRs": "mergedPrs", Deploys: "deploys", "Failed deploys": "failedDeploys", "Open PRs": "openPrs", Commits: "commits",
  Releases: "releases", "CI runs": "ciRuns",
};
// The design's scenario A is one real organization's repository; the SPA names no organization
// (test/render.orgs.test.ts), so A reads as `acme/tutor` here — the same apps, environments, shas and people.
const ORG_REPOS = {
  own: ["acme/tutor", "AndresL230/trov"],
  acme: ["acme/storefront", "acme/platform", "acme/payments", "acme/ingest", "acme/ui-kit", "acme/core", "acme/web-app", "acme/web-api", "acme/site", "acme/dashboard"],
  acmeNew: ["acme/new-thing", "acme/mobile"],
};

const AGE_RE = /^(\d+)([mhd])$/;
const ageMs = (age: string): number => {
  const m = AGE_RE.exec(age);
  if (!m) throw new Error(`not an age: ${age}`);
  return Number(m[1]) * (m[2] === "m" ? MIN : m[2] === "h" ? HOUR : DAY);
};
/** A stable placeholder sha for the deploys a 20-deploy strip has and the design does not name. */
const placeholderSha = (seed: string): string => {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 7);
};

type StripState = "live" | "failed" | "building" | "rolledBack";
type PreviewState = "live" | "failed" | "building";
/** The design's `D20`: 20 deploys, oldest first, `fails` failed and `extra` overriding single slots. */
const d20 = (fails: number[] = [], extra: Record<number, StripState> = {}): StripState[] =>
  Array.from({ length: 20 }, (_, i) => extra[i] ?? (fails.includes(i) ? "failed" : "live"));

interface ScApp { name: string; folder: string; kind: AppKind; host?: string; via?: string; prs: number; previews?: boolean; usedBy?: string[] }
interface ScTarget {
  app: string; env: string; sha?: string; age?: string; by?: string; url?: string; ms?: number | null; via?: string;
  state?: "building" | "failed"; prev?: { sha: string; age: string };
  failedSha?: string; failedAge?: string; failedBy?: string; failedWhy?: string;
  health?: "down" | "stale"; staleFor?: string;
  /** The design's `unknown: true`: a target whose host reports nothing Trov can read yet. */
  unknown?: boolean;
}
/** A single-target scenario's last 20 deploys: the states, the gap between unnamed ones, and the named ones. */
interface ScStrip { states: StripState[]; step: string; named: Record<number, { sha: string; age: string; by?: string; reason?: string; rolledFrom?: string }> }
interface ScPreview { pr: number; title: string; branch: string; by: string; state: PreviewState; age: string; url?: string; streak?: { count: number; since: string } }
interface ScGroup { pr: number | null; title: string; by: string[]; merged: string | null; commits: [string, string, string][]; more?: number }
interface Scenario {
  org: keyof typeof ORG_REPOS; repo: string; appSource?: FactsApp["source"];
  envs: { name: string; branch: string }[];
  apps: ScApp[]; targets: ScTarget[];
  /** Providers with no org connection (every other one is connected). */
  notConnected?: HostingProviderId[];
  strip?: ScStrip;
  ci?: [env: string, state: FactsCi["state"], total: number | null, failing: number | null, sha: string, names?: string[]][];
  drift?: { from: string; to: string; ahead: number; groups: ScGroup[] }[];
  previews?: ScPreview[];
  previewsByApp?: Record<string, PreviewState[]>;
  /** Per app, in Production: [count (null = unknown), oldest age, groups]. */
  notShippedByApp?: Record<string, [number | null, string?, ScGroup[]?]>;
  outOfStep?: FactsOutOfStep[];
  attention?: FactsAttention[];
  week: [label: string, value: number | null, delta: number | null][];
  release?: FactsRelease;
  found?: FactsFound;
  unseen?: FactsUnseen;
  connect?: FactsConnect | null;
}

const DEPLOY_STATE: Record<StripState, DeployState> = { live: "ready", failed: "error", building: "building", rolledBack: "ready" };

function factsOf(sc: Scenario, now: number): RepoFacts {
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  const at = (age: string): string => ago(ageMs(age));
  const envKey = (name: string): string => name.toLowerCase();
  const messages = new Map<string, string>();
  for (const g of [...(sc.drift ?? []).flatMap((d) => d.groups), ...Object.values(sc.notShippedByApp ?? {}).flatMap((n) => n[2] ?? [])]) {
    for (const [sha, msg] of g.commits) messages.set(sha, msg);
  }
  const group = (g: ScGroup): FactsCommitGroup => ({
    kind: g.pr === null ? "direct" : "pr", pr: g.pr, title: g.title, by: g.by, mergedAt: g.merged ? at(g.merged) : null,
    commits: g.commits.map(([sha, msg, age]) => ({ sha, msg, at: at(age) })), more: g.more ?? 0,
  });

  const apps: FactsApp[] = sc.apps.map((a) => ({
    key: a.name, label: a.name, folder: a.folder === "/" ? "/" : a.folder.replace(/\/$/, ""), kind: a.kind,
    watch: [a.folder === "/" ? "**" : `${a.folder.replace(/\/$/, "")}/**`], source: sc.appSource ?? "manual",
    usedBy: a.usedBy ?? null, previews: !!a.previews, openPrs: a.prs,
  }));

  const parts: FactsPart[] = sc.targets.map((t) => {
    const a = sc.apps.find((x) => x.name === t.app);
    const env = sc.envs.find((e) => e.name === t.env);
    if (!a || !a.host || !env) throw new Error(`scenario ${sc.repo}: target ${t.app}/${t.env} has no app, host or environment`);
    const provider = PROVIDER_OF_HOST[a.host];
    const via = t.via ?? a.via ?? null;
    const connection = provider === GITHUB_PROVIDER || !(sc.notConnected ?? []).includes(provider) ? "connected" : "not_connected";
    const viaGithub = !t.unknown && connection === "not_connected" && provider !== GITHUB_PROVIDER;
    const source = provider === GITHUB_PROVIDER || viaGithub ? "github" : "provider";
    const key = `${t.app}-${envKey(t.env)}`;
    const deploy = (n: number | string, state: DeployState, sha: string, ms: number, by: string | null, more: Partial<FactsDeploy> = {}): FactsDeploy => ({
      id: `${key}-${n}`, state, target: "production", sha, shaSource: "provider", branch: env.branch, message: messages.get(sha) ?? null, by,
      createdAt: ago(state === "ready" ? ms + 90_000 : ms), readyAt: state === "ready" ? ago(ms) : null,
      url: null, logUrl: null, reason: null, rolledBackFrom: null, source, ...more,
    });

    let serving: FactsDeploy | null = null, latest: FactsDeploy | null = null, history: FactsDeploy[] = [];
    if (t.unknown) {
      // nothing reported: no deploys, `not_connected`
    } else if (sc.strip) {
      const { states, step, named } = sc.strip;
      const ages: number[] = [];
      for (let i = states.length - 1; i >= 0; i--) ages[i] = named[i] ? ageMs(named[i].age) : ages[i + 1] + ageMs(step);
      const all = states.map((st, i) => deploy(i, DEPLOY_STATE[st], named[i]?.sha ?? placeholderSha(`${sc.repo}:${i}`), ages[i], named[i]?.by ?? null, {
        reason: named[i]?.reason ?? null, rolledBackFrom: st === "rolledBack" ? named[i]?.rolledFrom ?? null : null,
      }));
      history = all.filter((d) => d.state === "ready" || d.state === "error" || d.state === "canceled");
      serving = [...history].reverse().find((d) => d.state === "ready") ?? null;
      const newest = all[all.length - 1];
      latest = newest && newest !== serving ? newest : null;
    } else if (t.sha && t.age) {
      if (t.state === "building") {
        serving = t.prev ? deploy("prev", "ready", t.prev.sha, ageMs(t.prev.age), null) : null;
        latest = deploy("next", "building", t.sha, ageMs(t.age), t.by ?? null);
      } else {
        serving = deploy("serving", "ready", t.sha, ageMs(t.age), t.by ?? null);
        if (t.state === "failed" && t.failedSha && t.failedAge) {
          latest = deploy("failed", "error", t.failedSha, ageMs(t.failedAge), t.failedBy ?? null, { reason: t.failedWhy ?? null });
        }
      }
      history = [serving, latest].filter((d): d is FactsDeploy => !!d && (d.state === "ready" || d.state === "error"));
    }

    const url = t.url ? `https://${t.url}` : null;
    let health: FactsHealth | null = null;
    if (url && t.health === "down") health = { url, up: false, ms: null, at: at("1m"), stale: false };
    else if (url && t.health === "stale") health = { url, up: true, ms: null, at: at(t.staleFor ?? "31m"), stale: true };
    else if (url && typeof t.ms === "number") health = { url, up: true, ms: t.ms, at: at("3m"), stale: false };

    const role: PartRole = APP_KIND_ROLE[a.kind] ?? "service";
    return {
      app: t.app, env: envKey(t.env), label: t.app, role, provider, host: PROVIDER_LABEL[provider] ?? a.host,
      via, connection, reportsDeploys: true, viaGithub, serving, latest, history, health, url, consoleUrl: null,
      reportsMetrics: PROVIDER_METRICS[provider] ?? false,
    };
  });

  const envs = sc.envs.map((e, position) => ({ key: envKey(e.name), name: e.name, branch: e.branch, position }))
    .filter((e) => parts.some((p) => p.env === e.key));

  // Previews per app (E, F) are made the way the design's `narrow()` makes them, numbered down from #650 across
  // the repository so no two apps' previews share a PR number.
  let prNo = 650;
  const byApp = Object.entries(sc.previewsByApp ?? {}).flatMap(([app, states]) => states.map((state, i): ScPreview & { app: string } => {
    const pr = prNo; prNo -= 3;
    const age = ["20m", "2h", "1d", "2d"][i % 4];
    return {
      app, pr, title: `${app}: preview ${i + 1}`, branch: `${app}-change-${i + 1}`, by: ["tom-h", "ana-r", "kenji-m", "dev-raj"][i % 4], state, age,
      url: state === "live" ? `${app}-pr-${pr}.preview.acme.dev` : undefined,
    };
  }));
  const previews: FactsPreview[] = [...(sc.previews ?? []).map((p) => ({ app: sc.apps[0].name, ...p })), ...byApp].map((p) => ({
    app: p.app, pr: p.pr, title: p.title, branch: p.branch, by: p.by, state: DEPLOY_STATE[p.state], at: at(p.age),
    url: p.url ? `https://${p.url}` : null, failStreak: p.state === "failed" ? p.streak?.count ?? 1 : 0,
    failingSince: p.state === "failed" ? at(p.streak?.since ?? p.age) : null,
  }));

  const prodEnv = envs.find((e) => e.name === "Production")?.key ?? "production";
  const notShipped: FactsNotShipped[] = Object.entries(sc.notShippedByApp ?? {}).map(([app, [count, oldest, groups]]) => ({
    app, env: prodEnv, count, oldestAt: count && oldest ? at(oldest) : null, groups: (groups ?? []).map(group),
  }));

  const envOfBranch = (branch: string): string => envs.find((e) => e.branch === branch)?.key ?? branch;
  const drift: FactsDriftStep[] = (sc.drift ?? []).map((d) => ({
    fromEnv: envOfBranch(d.from), toEnv: envOfBranch(d.to), from: d.from, to: d.to, ahead: d.ahead, behind: 0, groups: d.groups.map(group),
  }));

  const ci: FactsCi[] = (sc.ci ?? []).map(([env, state, total, failing, sha, names]) => ({ env: envKey(env), sha, state, total, failing, names: names ?? [] }));
  const week: FactsWeekFigure[] = sc.week.map(([label, value, delta]) => {
    const key = WEEK_KEY[label];
    if (!key) throw new Error(`no week key for ${label}`);
    return { key, value, delta };
  });

  return {
    repo: sc.repo, app: null, repos: ORG_REPOS[sc.org], allApps: apps, apps, envs, parts, previews, notShipped,
    outOfStep: sc.outOfStep ?? [], drift, ci, release: sc.release ?? null, found: sc.found ?? null, unseen: sc.unseen ?? null, week,
    attention: sc.attention ?? [], connect: sc.connect ?? null, groupDefault: null,
  };
}

type At = (age: string) => string;
const SC: Record<Exclude<ScenarioKey, "N">, (v: string, at: At) => Scenario> = {
  A: (v, at): Scenario => {
    const oos = v === "outOfStep", down = v === "trouble";
    return {
      org: "own", repo: "acme/tutor", appSource: "migrated",
      envs: [{ name: "Staging", branch: "main" }, { name: "Production", branch: "production" }],
      apps: [{ name: "web", folder: "web/", kind: "Worker", host: "Cloudflare", prs: 4 }, { name: "api", folder: "api/", kind: "Service", host: "Railway", prs: 3 }],
      targets: [
        { app: "web", env: "Staging", sha: "3e9a1f2", age: "26m", by: "dev-raj", url: "staging.tutor.acme.com", ms: 142 },
        down ? { app: "api", env: "Staging", sha: "3e9a1f2", age: "2m", by: "dev-raj", url: "api.staging.tutor.acme.com", state: "building", prev: { sha: "d94ea08", age: "21h" }, health: "stale", staleFor: "34m" }
          : { app: "api", env: "Staging", sha: "3e9a1f2", age: "28m", by: "dev-raj", url: "api.staging.tutor.acme.com", ms: 88 },
        down ? { app: "web", env: "Production", sha: "b4c21de", age: "2h", by: "jose-a", url: "tutor.acme.com", health: "down" }
          : { app: "web", env: "Production", sha: "b4c21de", age: "2h", by: "jose-a", url: "tutor.acme.com", ms: 131 },
        oos ? { app: "api", env: "Production", sha: "71f0e3a", age: "2d", by: "meilin", url: "api.tutor.acme.com", ms: 94 }
          : { app: "api", env: "Production", sha: "b4c21de", age: "2h", by: "jose-a", url: "api.tutor.acme.com", ms: 94 },
      ],
      ci: [["Staging", "pass", 14, 0, "3e9a1f2"], ["Production", "pass", 14, 0, "b4c21de"]],
      drift: [{ from: "main", to: "production", ahead: 9, groups: [
        { pr: 214, title: "Tutor sessions resume from the last message", by: ["meilin"], merged: "5h", commits: [["3e9a1f2", "Resume tutor session from last message id", "5h"], ["9b02c4e", "Store last message id on the session", "6h"]] },
        { pr: 212, title: "Quiz timer drifts when the tab is hidden", by: ["dev-raj"], merged: "1d", commits: [["a71d3f0", "Use performance.now for the quiz timer", "1d"], ["4c8e912", "Pause the timer on visibilitychange", "1d"], ["e2f6b07", "Test: hidden tab keeps time", "1d"]] },
        { pr: 209, title: "api: rate limit /tutor/ask per user", by: ["jose-a"], merged: "2d", commits: [["5d1c8a4", "Token bucket per user on /tutor/ask", "2d"], ["0e7f2b9", "Return Retry-After on 429", "2d"]] },
        { pr: null, title: "2 commits pushed straight to main", by: ["kenji-m", "tom-h"], merged: null, commits: [["8a6e1d3", "chore: bump wrangler 4.86", "1d"], ["c2b94f0", "docs: staging seed notes", "2d"]] },
      ] }],
      outOfStep: oos ? [{ env: "production", app: "api", sha: "71f0e3a", of: "web", ofSha: "b4c21de", behindBy: 3 }] : [],
      attention: oos ? [{ kind: "outOfStep", app: "api", env: "production", refs: { sha: "71f0e3a", behindBy: 3, of: "web", provider: "railway" } }]
        : down ? [
          { kind: "down", app: "web", env: "production", refs: { url: "https://tutor.acme.com", since: at("6m") } },
          { kind: "stale", app: "api", env: "staging", refs: { since: at("34m"), provider: "railway", nextSha: "3e9a1f2" } },
        ] : [],
      week: [["Merged PRs", 12, 3], ["Deploys", 18, 2], ["Failed deploys", 1, -1], ["Open PRs", 7, 0]],
    };
  },

  B: (v, at): Scenario => {
    const failed = v === "failed", tr = v === "trouble";
    const signals: ScGroup = { pr: 320, title: "Repo: read deploy signals per target", by: ["andres"], merged: failed ? "14m" : "34m",
      commits: failed ? [["e07b3a2", "Read deploy signals per target", "14m"]] : [["e07b3a2", "Read deploy signals per target", "34m"], ["f19ad20", "Fix: signal reader handles a missing environment", "3m"]] };
    // B/trouble: c41e7d9 had been live a day, e07b3a2 replaced it, and the rollback put c41e7d9 back (slots 16–18
    // name what the design's sentence says happened); f19ad20 is building.
    const strip: ScStrip = failed ? { states: d20([2], { 19: "failed" }), step: "14h", named: { 18: { sha: "c41e7d9", age: "1d", by: "andres" }, 19: { sha: "e07b3a2", age: "12m", by: "andres", reason: "Build failed in Workers Builds: tsc found 2 errors" } } }
        : tr ? { states: d20([2], { 18: "rolledBack", 19: "building" }), step: "14h", named: { 16: { sha: "c41e7d9", age: "1d", by: "andres" }, 17: { sha: "e07b3a2", age: "30m", by: "andres" }, 18: { sha: "c41e7d9", age: "8m", by: "andres", rolledFrom: "e07b3a2" }, 19: { sha: "f19ad20", age: "2m", by: "andres" } } }
          : { states: d20([7]), step: "14h", named: { 19: { sha: "c41e7d9", age: "41m", by: "andres" } } };
    return {
      org: "own", repo: "AndresL230/trov",
      envs: [{ name: "Production", branch: "main" }],
      apps: [{ name: "trov", folder: "/", kind: "Worker", host: "Cloudflare", prs: 2, previews: true }],
      targets: [{ app: "trov", env: "Production", url: "trov.dev", ms: tr ? 102 : 96 }],
      strip,
      ci: [failed ? ["Production", "fail", 9, 2, "e07b3a2"] : tr ? ["Production", "running", null, null, "f19ad20"] : ["Production", "pass", 9, 0, "c41e7d9"]],
      previews: [
        { pr: 318, title: "Repo screen: apps and targets", branch: "repo-apps", by: "andres", state: "live", age: "40m", url: "repo-apps.trov.workers.dev" },
        { pr: 316, title: "Usage: Railway poller", branch: "railway-poller", by: "jose-a", state: "failed", age: tr ? "3d" : "3h", streak: tr ? { count: 4, since: "3d" } : undefined },
      ],
      notShippedByApp: failed ? { trov: [1, "12m", [signals]] } : tr ? { trov: [2, "30m", [signals]] } : {},
      attention: failed ? [{ kind: "failed", app: "trov", env: "production", refs: { failedSha: "e07b3a2", sha: "c41e7d9", since: at("12m"), provider: "cloudflare", reason: "Build failed in Workers Builds: tsc found 2 errors" } }]
        : tr ? [
          { kind: "rolledBack", app: "trov", env: "production", refs: { sha: "c41e7d9", prevSha: "e07b3a2", nextSha: "f19ad20", since: at("8m") } },
          { kind: "previewFailing", app: "trov", env: null, refs: { pr: 316, count: 4, since: at("3d") } },
        ] : [],
      week: [["Merged PRs", 9, 2], ["Deploys", 11, 1], ["Failed deploys", failed ? 1 : 0, failed ? 1 : 0], ["Open PRs", 2, -1]],
    };
  },

  C: (): Scenario => ({
    org: "acme", repo: "acme/site",
    envs: [{ name: "Production", branch: "main" }],
    apps: [{ name: "site", folder: "/", kind: "Site", host: "Netlify", prs: 6, previews: true }],
    targets: [{ app: "site", env: "Production", url: "acme.com", ms: 48 }],
    strip: { states: d20([11]), step: "1d", named: { 19: { sha: "5f2c0e8", age: "3h", by: "ana-r" } } },
    ci: [["Production", "pass", 4, 0, "5f2c0e8"]],
    previews: [
      { pr: 88, title: "Pricing page: annual toggle", branch: "pricing-annual", by: "ana-r", state: "live", age: "20m", url: "deploy-preview-88--acme-site.netlify.app" },
      { pr: 87, title: "Blog: RSS feed", branch: "blog-rss", by: "tom-h", state: "live", age: "2h", url: "deploy-preview-87--acme-site.netlify.app" },
      { pr: 86, title: "Launch hero copy", branch: "hero-copy", by: "meilin", state: "building", age: "1m" },
      { pr: 85, title: "Footer links on mobile", branch: "fix-footer", by: "dev-raj", state: "live", age: "5h", url: "deploy-preview-85--acme-site.netlify.app" },
      { pr: 84, title: "Case studies index", branch: "case-studies", by: "ana-r", state: "live", age: "1d", url: "deploy-preview-84--acme-site.netlify.app" },
      { pr: 83, title: "Docs navigation", branch: "docs-nav", by: "kenji-m", state: "failed", age: "1d" },
    ],
    week: [["Merged PRs", 5, 1], ["Deploys", 7, 0], ["Failed deploys", 0, 0], ["Open PRs", 6, 2]],
  }),

  D: (): Scenario => ({
    org: "acme", repo: "acme/dashboard",
    envs: [{ name: "Production", branch: "main" }],
    apps: [{ name: "dashboard", folder: "/", kind: "Site", host: "Vercel", prs: 3, previews: true }],
    targets: [{ app: "dashboard", env: "Production", url: "dashboard.acme.com", ms: 211 }],
    strip: { states: d20([4, 13]), step: "17h", named: { 19: { sha: "8b31f6d", age: "1h", by: "priya-k" } } },
    ci: [["Production", "pass", 6, 0, "8b31f6d"]],
    previews: [
      { pr: 402, title: "Orders: CSV export", branch: "orders-export", by: "tom-h", state: "live", age: "35m", url: "dashboard-git-orders-export-acme.vercel.app" },
      { pr: 399, title: "Settings: team roles", branch: "team-roles", by: "kenji-m", state: "live", age: "4h", url: "dashboard-git-team-roles-acme.vercel.app" },
      { pr: 397, title: "Move API routes to the app router", branch: "app-router-api", by: "priya-k", state: "live", age: "1d", url: "dashboard-git-app-router-api-acme.vercel.app" },
    ],
    week: [["Merged PRs", 8, 2], ["Deploys", 10, 3], ["Failed deploys", 0, -1], ["Open PRs", 3, 0]],
  }),

  E: (_v, at): Scenario => ({
    org: "acme", repo: "acme/storefront",
    envs: [{ name: "Production", branch: "main" }],
    apps: [
      { name: "web", folder: "apps/web", kind: "Site", host: "Vercel", prs: 4, previews: true },
      { name: "api", folder: "apps/api", kind: "Service", host: "Render", prs: 3, previews: true },
      { name: "docs", folder: "apps/docs", kind: "Site", host: "Cloudflare Pages", prs: 1, previews: true },
      { name: "jobs", folder: "apps/jobs", kind: "Job", host: "Fly.io", via: "deploy-jobs.yml", prs: 1 },
      { name: "ui", folder: "packages/ui", kind: "Package", usedBy: ["web", "docs"], prs: 2 },
    ],
    // Usage reads "from Render and Cloudflare": Fly.io is not connected, so jobs' deploys come via its workflow.
    notConnected: ["fly"],
    targets: [
      { app: "web", env: "Production", sha: "9c4e2b1", age: "2d", by: "tom-h", url: "storefront.acme.com", ms: 188 },
      { app: "api", env: "Production", sha: "2b8e6c4", age: "3d", by: "kenji-m", url: "api.storefront.acme.com", ms: 102, state: "failed", failedSha: "7f3a9d0", failedAge: "25m", failedBy: "priya-k", failedWhy: "Render: build exited with status 1" },
      { app: "docs", env: "Production", sha: "a1d07e3", age: "5h", by: "ana-r", url: "docs.storefront.acme.com", ms: 64 },
      { app: "jobs", env: "Production", sha: "e5b2f19", age: "1d", by: "kenji-m", via: "deploy-jobs.yml" },
    ],
    previewsByApp: { web: ["live", "live", "building"], api: ["live"], docs: ["live"] },
    notShippedByApp: {
      web: [4, "2d", [
        { pr: 651, title: "Checkout: saved addresses", by: ["tom-h"], merged: "2d", commits: [["c8a1e40", "Saved addresses on checkout", "2d"], ["13fd9b2", "Address book API client", "2d"]] },
        { pr: 648, title: "web: lazy-load the product gallery", by: ["ana-r"], merged: "2d", commits: [["6e02a7c", "Lazy-load gallery images", "2d"]] },
        { pr: null, title: "1 commit pushed straight to main", by: ["dev-raj"], merged: null, commits: [["f4b7d21", "fix: typo in the cart drawer", "2d"]] },
      ]],
      api: [1, "25m"], docs: [0], jobs: [0],
    },
    attention: [
      { kind: "failed", app: "api", env: "production", refs: { failedSha: "7f3a9d0", sha: "2b8e6c4", since: at("25m"), provider: "render", reason: "Render: build exited with status 1" } },
      { kind: "waiting", app: "web", env: "production", refs: { count: 4, since: at("2d") } },
    ],
    week: [["Merged PRs", 21, 4], ["Deploys", 26, 5], ["Failed deploys", 2, 1], ["Open PRs", 11, 1]],
  }),

  F: (_v, at): Scenario => {
    const A: [string, string, AppKind, string | null, StripState?, string?, string?, string?, [number, string?]?, PreviewState[]?][] = [
      ["checkout", "services/checkout", "Service", "Render", "failed", "41b7e09", "18m", "tom-h", [3, "1h"], ["live", "failed"]],
      ["search", "services/search", "Service", "Fly.io", "failed", "d2a6f31", "52m", "kenji-m", [1, "52m"], []],
      ["admin", "apps/admin", "Site", "Vercel", "building", "7c19e5a", "3m", "ana-r", [0], ["live", "live"]],
      ["web", "apps/web", "Site", "Vercel", "live", "0f4d8b2", "2h", "priya-k", [0], ["live", "live", "live", "building"]],
      ["api", "services/api", "Service", "Render", "live", "b83e2c7", "4h", "dev-raj", [0], ["live"]],
      ["auth", "services/auth", "Service", "Render", "live", "5a0c9d4", "1d", "meilin", [0], []],
      ["billing", "services/billing", "Service", "Render", "live", "e61f3b8", "3d", "sanaok", [2, "3d"], []],
      ["notifications", "workers/notifications", "Worker", "Cloudflare", "live", "92d4a7e", "6h", "jose-a", [0], ["live"]],
      ["media", "workers/media", "Worker", "Cloudflare", "live", "3be8f10", "1d", "kenji-m", [0], []],
      ["docs", "apps/docs", "Site", "Cloudflare Pages", "live", "aa47c62", "5h", "ana-r", [0], ["live"]],
      ["status", "apps/status", "Site", "Netlify", "live", "1c9e0f5", "9d", "tom-h", [0], []],
      ["reports", "jobs/reports", "Job", "Fly.io", "live", "6f2b3d1", "1d", "dev-raj", [0], []],
      ["sdk", "packages/sdk", "Package", null],
      ["tokens", "packages/tokens", "Package", null],
    ];
    const hosted = A.filter((a) => a[3]);
    return {
      org: "acme", repo: "acme/platform",
      envs: [{ name: "Production", branch: "main" }],
      apps: A.map(([name, folder, kind, host, , , , , , pv]) => ({
        name, folder, kind, host: host ?? undefined, previews: !!(pv && pv.length), prs: pv ? pv.length : 1,
        usedBy: kind === "Package" ? (name === "sdk" ? ["web", "admin", "checkout"] : ["web", "admin", "docs", "status"]) : undefined,
      })),
      targets: hosted.map(([app, , , , state, sha, age, by]): ScTarget => ({
        app, env: "Production", sha, age, by, ms: 80, url: `${app}.platform.acme.com`,
        ...(state === "failed" ? { state: "failed" as const, sha: app === "checkout" ? "c07a1e2" : "88e4b10", age: app === "checkout" ? "2d" : "4d", failedSha: sha, failedAge: age } : {}),
        ...(state === "building" ? { state: "building" as const, prev: { sha: "2d91c08", age: "1d" } } : {}),
      })),
      previewsByApp: Object.fromEntries(hosted.map((a) => [a[0], a[9] ?? []])),
      notShippedByApp: Object.fromEntries(hosted.map((a): [string, [number, string?]] => [a[0], a[8] ?? [0]])),
      attention: [
        { kind: "failed", app: "checkout", env: "production", refs: { failedSha: "41b7e09", sha: "c07a1e2", since: at("18m"), provider: "render" } },
        { kind: "failed", app: "search", env: "production", refs: { failedSha: "d2a6f31", sha: "88e4b10", since: at("52m"), provider: "fly" } },
      ],
      week: [["Merged PRs", 64, 9], ["Deploys", 83, 12], ["Failed deploys", 5, 2], ["Open PRs", 23, -3]],
    };
  },

  G: (v, at): Scenario => {
    // '' = Railway not connected and nothing from GitHub; `signals` = GitHub deployments report the services, Railway
    // still not connected (CPU and memory need it); `after` = Railway connected.
    const after = v === "after", signals = v === "signals", known = after || signals;
    const S: [string, string][] = [["gateway", "services/gateway"], ["ledger", "services/ledger"], ["notifier", "services/notifier"], ["settle", "jobs/settle"]];
    const seen: Record<string, [string, string, string, string, "building"?][]> = {
      gateway: [["Production", "6d0b3f9", "1d", "sanaok"], ["Staging", "a24e81c", "3h", "dev-raj"]],
      ledger: [["Production", "6d0b3f9", "1d", "sanaok"], ["Staging", "a24e81c", "3h", "dev-raj", "building"]],
      notifier: [["Production", "f13c9a7", "6d", "meilin"], ["Staging", "a24e81c", "3h", "dev-raj"]],
      settle: [["Production", "6d0b3f9", "1d", "sanaok"], ["Staging", "a24e81c", "3h", "dev-raj"]],
    };
    return {
      org: "acme", repo: "acme/payments",
      envs: [{ name: "Production", branch: "production" }, { name: "Staging", branch: "main" }],
      apps: S.map(([name, folder]) => ({ name, folder, kind: name === "settle" ? "Job" : "Service", host: "Railway", prs: name === "ledger" ? 2 : 1 })),
      notConnected: after ? [] : ["railway"],
      // ledger's Staging deploy is building with no earlier deploy in the design: nothing is serving there (never guessed).
      targets: S.flatMap(([app]) => seen[app].map(([env, sha, age, by, st]): ScTarget => (known
        ? { app, env, sha, age, by, state: st, ms: app === "settle" ? null : 70 }
        : { app, env, unknown: true }))),
      notShippedByApp: known ? { gateway: [3, "3h"], ledger: [3, "3h"], notifier: [5, "6d"], settle: [3, "3h"] } : { gateway: [null], ledger: [null], notifier: [null], settle: [null] },
      connect: after ? null : { provider: "railway", need: signals ? "metrics" : "deploys", apps: S.map(([name]) => name) },
      attention: known ? [{ kind: "waiting", app: "notifier", env: "production", refs: { sha: "f13c9a7", count: 5, since: at("6d") } }] : [],
      week: [["Merged PRs", 7, 1], known ? ["Deploys", 14, 2] : ["Deploys", null, null], known ? ["Failed deploys", 0, 0] : ["Failed deploys", null, null], ["Open PRs", 5, 0]],
    };
  },

  H: (): Scenario => ({
    org: "acme", repo: "acme/ingest",
    envs: [{ name: "Staging", branch: "main" }, { name: "Production", branch: "production" }],
    apps: [
      { name: "collector", folder: "collector/", kind: "Service", host: "Fly.io", via: "deploy-collector.yml", prs: 2 },
      { name: "normalizer", folder: "normalizer/", kind: "Service", host: "Cloud Run", via: "deploy-normalizer.yml", prs: 1 },
    ],
    // Usage reads "not connected": collector's deploys come via its workflow while Fly.io is not connected;
    // normalizer runs on Cloud Run, which no provider reads, so its parts are `github` parts on its workflow.
    notConnected: ["fly"],
    targets: [
      { app: "collector", env: "Staging", sha: "4e1a9c7", age: "1h", by: "kenji-m", via: "deploy-collector.yml", url: "collector-staging.fly.dev", ms: 61 },
      { app: "normalizer", env: "Staging", sha: "4e1a9c7", age: "4m", by: "kenji-m", via: "deploy-normalizer.yml", state: "building", prev: { sha: "0b72d3e", age: "1d" } },
      { app: "collector", env: "Production", sha: "0b72d3e", age: "1d", by: "sanaok", via: "deploy-collector.yml", url: "collector.fly.dev", ms: 58 },
      { app: "normalizer", env: "Production", sha: "0b72d3e", age: "1d", by: "sanaok", via: "deploy-normalizer.yml", url: "normalizer-prod-4kq.a.run.app", ms: 140 },
    ],
    ci: [["Staging", "running", null, null, "4e1a9c7", ["deploy-normalizer.yml"]], ["Production", "pass", 7, 0, "0b72d3e"]],
    drift: [{ from: "main", to: "production", ahead: 3, groups: [
      { pr: 77, title: "normalizer: drop events older than 7 days", by: ["kenji-m"], merged: "1h", commits: [["4e1a9c7", "Drop stale events before normalising", "1h"], ["9c3d0e1", "Config: max event age", "1h"]] },
      { pr: null, title: "1 commit pushed straight to main", by: ["tom-h"], merged: null, commits: [["ba0f6e2", "ci: pin flyctl 0.3.40", "5h"]] },
    ] }],
    week: [["Merged PRs", 4, 0], ["Deploys", 9, 1], ["Failed deploys", 0, 0], ["Open PRs", 3, 1]],
  }),

  I: (_v, at): Scenario => ({
    org: "acme", repo: "acme/ui-kit",
    envs: [], apps: [{ name: "ui-kit", folder: "/", kind: "Package", prs: 6 }], targets: [],
    release: {
      tag: "v2.4.0", at: at("9d"), by: "meilin",
      notes: "Select gains async options and a loading state. Tooltip waits 300 ms before opening. Fixes focus return in Dialog when it closes from Escape.",
      since: { commits: 18, prs: 5 },
      waiting: [
        { pr: 231, title: "feat: DatePicker range mode", by: "ana-r", mergedAt: at("2d"), feature: true },
        { pr: 228, title: "feat: Toast stacking and swipe to dismiss", by: "tom-h", mergedAt: at("4d"), feature: true },
        { pr: 230, title: "fix: Menu keeps scroll position on reopen", by: "dev-raj", mergedAt: at("3d"), feature: false },
        { pr: 227, title: "docs: theming guide", by: "meilin", mergedAt: at("6d"), feature: false },
        { pr: 226, title: "chore: bump Storybook 9.1", by: "kenji-m", mergedAt: at("8d"), feature: false },
      ],
      cadence: [{ tag: "v2.1.0", at: at("91d") }, { tag: "v2.2.0", at: at("70d") }, { tag: "v2.3.0", at: at("56d") }, { tag: "v2.3.1", at: at("35d") }, { tag: "v2.3.2", at: at("23d") }],
    },
    week: [["Merged PRs", 5, 1], ["Commits", 18, 6], ["Releases", 0, -1], ["Open PRs", 6, 2]],
  }),

  J: (): Scenario => ({
    org: "acme", repo: "acme/core",
    envs: [{ name: "Dev", branch: "develop" }, { name: "Staging", branch: "main" }, { name: "Production", branch: "release" }],
    apps: [{ name: "core", folder: "/", kind: "Service", host: "Render", prs: 5 }],
    targets: [
      { app: "core", env: "Dev", sha: "7aa3c90", age: "18m", by: "dev-raj", url: "core-dev.onrender.com", ms: 120 },
      { app: "core", env: "Staging", sha: "2f6e14b", age: "1d", by: "meilin", url: "core-staging.onrender.com", ms: 104 },
      { app: "core", env: "Production", sha: "c90b5d2", age: "8d", by: "sanaok", url: "core.acme.com", ms: 97 },
    ],
    ci: [["Dev", "fail", 11, 1, "7aa3c90", ["integration: outbox relay"]], ["Staging", "pass", 11, 0, "2f6e14b"], ["Production", "pass", 11, 0, "c90b5d2"]],
    drift: [
      { from: "develop", to: "main", ahead: 6, groups: [
        { pr: 305, title: "Batch writes in the outbox relay", by: ["dev-raj"], merged: "18m", commits: [["7aa3c90", "Batch outbox writes", "18m"], ["31be7c2", "Outbox relay metrics", "1h"]] },
        { pr: 303, title: "Retry policy per queue", by: ["jose-a"], merged: "1d", commits: [["e0d1f48", "Retry policy per queue", "1d"], ["b5c2a91", "Default retry policy", "1d"], ["44f7e0d", "Docs: retry policy", "1d"], ["0c3b6aa", "Test: retry backoff", "1d"]] },
      ] },
      { from: "main", to: "release", ahead: 14, groups: [
        { pr: 298, title: "Tenant export endpoint", by: ["meilin"], merged: "1d", commits: [["2f6e14b", "Tenant export endpoint", "1d"]] },
        // The design's "+ 6 PRs — 13 more commits since c90b5d2": the rest of the step, not returned commit by commit.
        { pr: null, title: "13 more commits since c90b5d2", by: [], merged: null, commits: [], more: 13 },
      ] },
    ],
    attention: [{ kind: "degraded", app: null, env: "dev", refs: { count: 1, check: "integration: outbox relay" } }],
    week: [["Merged PRs", 9, 2], ["Deploys", 12, 0], ["Failed deploys", 0, 0], ["Open PRs", 5, 0]],
  }),

  K: (): Scenario => ({
    org: "acme", repo: "acme/web-app",
    envs: [{ name: "Staging", branch: "main" }, { name: "Production", branch: "production" }],
    apps: [{ name: "web-app", folder: "/", kind: "Site", host: "Vercel", prs: 4, previews: true }],
    targets: [
      { app: "web-app", env: "Staging", sha: "1e8d4a0", age: "35m", by: "ana-r", url: "staging.app.acme.com", ms: 150 },
      { app: "web-app", env: "Production", sha: "9f02b6c", age: "1d", by: "ana-r", url: "app.acme.com", ms: 142 },
    ],
    ci: [["Staging", "pass", 8, 0, "1e8d4a0"], ["Production", "pass", 8, 0, "9f02b6c"]],
    drift: [{ from: "main", to: "production", ahead: 3, groups: [
      { pr: 121, title: "Checkout reads prices from web-api v2", by: ["ana-r"], merged: "35m", commits: [["1e8d4a0", "Use /v2/prices", "35m"], ["6b3f9c2", "Price cache per region", "2h"], ["d05e7a1", "Test: v2 price shape", "2h"]] },
    ] }],
    week: [["Merged PRs", 6, 1], ["Deploys", 9, 2], ["Failed deploys", 0, 0], ["Open PRs", 4, 0]],
  }),

  L: (): Scenario => ({
    org: "acmeNew", repo: "acme/new-thing",
    envs: [], apps: [], targets: [],
    found: {
      apps: [
        { id: "apps/web", folder: "apps/web", kind: "Site", provider: "vercel", evidence: "apps/web/vercel.json" },
        { id: "apps/worker", folder: "apps/worker", kind: "Worker", provider: "cloudflare", evidence: "apps/worker/wrangler.toml" },
        { id: "packages/shared", folder: "packages/shared", kind: "Package", provider: null, evidence: "packages/shared/package.json" },
      ],
      signals: [{ name: "Production – new-thing-web", provider: "vercel", count: 12 }, { name: "Preview – new-thing-web", provider: "vercel", count: 41 }],
    },
    week: [["Merged PRs", 6, null], ["Commits", 31, null], ["CI runs", 48, null], ["Open PRs", 4, null]],
  }),

  M: (_v, at): Scenario => ({
    org: "acmeNew", repo: "acme/mobile",
    envs: [], apps: [], targets: [], found: { apps: [], signals: [] },
    unseen: {
      looked: ["vercel.json", "netlify.toml", "wrangler.toml", "fly.toml", "render.yaml", "railway.json", "Dockerfile"],
      tags: {
        count: 14, latest: { tag: "v1.8.0", at: at("6d"), by: "ana-r" },
        recent: [{ tag: "v1.8.0", at: at("6d"), by: "ana-r" }, { tag: "v1.7.2", at: at("19d"), by: "tom-h" }, { tag: "v1.7.1", at: at("27d"), by: "tom-h" }, { tag: "v1.7.0", at: at("41d"), by: "ana-r" }],
      },
      prs: { open: 4, mergedThisMonth: 9 },
      workflows: ["eas-build.yml", "test.yml"],
      deploymentsSeen30d: 0,
    },
    week: [["Merged PRs", 9, 2], ["Commits", 37, 4], ["CI runs", 52, 6], ["Open PRs", 4, 0]],
  }),
};


/** One scenario as `RepoFacts`, narrowed by the App menu (`app`: an app key, `REPO_WIDE`, or null for all apps).
 *  N is the trouble states: '' = A/trouble, `trov` = B/trouble. An unknown variant reads as the calm one. */
export function repoScenario(key: ScenarioKey, variant = "", opts: { now?: number; app?: string | null } = {}): RepoFacts {
  const now = opts.now ?? Date.now();
  const at: At = (age) => new Date(now - ageMs(age)).toISOString();
  const [k, v]: [Exclude<ScenarioKey, "N">, string] = key === "N" ? (variant === "trov" ? ["B", "trouble"] : ["A", "trouble"]) : [key, variant];
  return narrowFacts(factsOf(SC[k](SCENARIO_VARIANTS[k].includes(v) ? v : "", at), now), opts.app ?? null);
}

// ── Repo setups, Phase G: the Usage tab of each scenario ─────────────────────
// What the projection (src/tools/repo.ts `projectProviders`, src/tools/repo-extras.ts) would send for the scenario's
// parts: one `RepoProviderPart` per target, with the families its provider REALLY reads (the registry's capabilities,
// mirrored below), its connection as the scenario has it, figures where the host is connected and reads them, and —
// for a Cloudflare Worker — the extra families (outcomes, runtime, D1, crons) the Cloudflare poll stores. The numbers
// are placeholders shaped like the design's `usageExtras` (repo-data.js); every state is one the Worker can produce.
// test/render.repo-usage.test.ts draws each scenario from here.

/** The usage families each provider reads — `familiesOf(capabilities)` of the registry (test/render.repo-usage.test.ts
 *  holds the two together). */
export const PROVIDER_FAMILIES: Record<string, UsageFamily[]> = {
  cloudflare: ["traffic", "outcomes", "runtime", "storage", "schedules"], railway: ["traffic", "latency", "compute"],
  render: ["traffic", "latency", "compute"], fly: ["traffic", "latency", "compute"], aws: ["traffic", "latency", "compute"],
  vercel: [], netlify: [], github: [],
};
/** Why a host reads no usage, as its poll stores it (`unavailable`). */
const NO_USAGE: Record<string, string> = {
  vercel: "Vercel has no public usage API — traffic needs Observability Plus",
  netlify: "Netlify has no documented usage API",
  github: "GitHub reports deploys only, no traffic or resources — connect the host itself to read them",
};
const SAMPLE_D1 = "6c71838c-18f7-4f68-8513-b58e86c237b9";
const SEED = (s: string): number => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 9973; return h; };
const RANGE_N: Record<RepoRange, number> = { "24h": 24, "7d": 7, "30d": 30 };
const RANGE_SCALE: Record<RepoRange, number> = { "24h": 1 / 7, "7d": 1, "30d": 30 / 7 };

export interface ScenarioUsage {
  usage: RepoDashboard["usage"];
  providers: RepoDashboard["providers"];
  product: RepoDashboard["product"];
}

/** One scenario's Usage tab: its targets (every part of its facts), the extra families of its Workers, and its
 *  Product block — scenario A the app's own v2 metrics, B (and N's `trov`) Trov's own v3 endpoint. */
export function repoScenarioUsage(key: ScenarioKey, variant = "", opts: { now?: number } = {}): ScenarioUsage {
  const now = opts.now ?? Date.now();
  const f = repoScenario(key, variant, { now });
  const [k, v] = key === "N" ? (variant === "trov" ? ["B", "trouble"] : ["A", "trouble"]) : [key, variant];
  const failed = k === "B" && (v === "failed" || v === "trouble");
  const endHour = Math.floor(now / HOUR) * HOUR;
  const today = Math.floor(now / DAY) * DAY;
  const series = (seed: string, n: number, base: number, amp: number): number[] =>
    Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + ((SEED(`${seed}x${i * 7}`) % 100) / 100) * amp * (0.6 + 0.4 * Math.sin(i * 1.3 + (SEED(seed) % 5))))));

  const parts: RepoProviderPart[] = f.parts.map((p) => {
    const env = f.envs.find((e) => e.key === p.env);
    const families = PROVIDER_FAMILIES[p.provider] ?? [];
    const reads = p.role === "web" ? families.includes("traffic") : families.includes("compute");
    const live = reads && p.connection === "connected" && !p.viaGithub;
    // A/trouble: api's staging Railway reading has gone quiet (the design's stale card).
    const stale = live && k === "A" && v === "trouble" && p.app === "api" && p.env === "staging";
    const seed = `${p.app}:${p.env}`;
    const perDay = (SEED(seed) % 900 + 40) * 1000 / 7;
    const traffic: RepoProviderPart["traffic"] = p.role !== "web" || !reads ? null
      : Object.fromEntries(REPO_RANGES.map((r) => {
        if (!live || stale) return [r, { requests: null, errors: null, error_rate: null, latency_p95_ms: null, bandwidth_bytes: null, trend: [] }];
        const n = RANGE_N[r], step = r === "24h" ? HOUR : DAY;
        const req = series(`${seed}${r}`, n, perDay * (r === "24h" ? 1 / 24 : 1), perDay * 0.4 * (r === "24h" ? 1 / 24 : 1));
        const errs = req.map((x, i) => Math.round(x * (0.001 + ((SEED(`${seed}e${i}`) % 30) / 10000))));
        const requests = req.reduce((a, b) => a + b, 0), errors = errs.reduce((a, b) => a + b, 0);
        const reads2 = families.includes("latency");
        return [r, {
          requests, errors, error_rate: Math.round((errors / requests) * 10000) / 100,
          latency_p95_ms: reads2 ? 120 + (SEED(seed) % 90) : null, bandwidth_bytes: reads2 ? requests * 18_000 : null,
          trend: req.map((x, i) => ({ at: new Date((r === "24h" ? endHour : today) - (n - i) * step).toISOString(), requests: x, errors: errs[i] })),
        }];
      })) as Record<RepoRange, ProviderTrafficRange>;
    const resources: ProviderResources | null = p.role !== "service" ? null : !live || stale
      ? { cpu: null, mem_mb: null, at: null, trend: stale ? Array.from({ length: 20 }, (_, i) => ({ at: new Date(endHour - (24 - i) * HOUR).toISOString(), cpu: 0.1 + (SEED(`${seed}c${i}`) % 20) / 100, mem_mb: 300 + (SEED(`${seed}m${i}`) % 80) })) : [] }
      : {
        cpu: Math.round((0.06 + (SEED(seed) % 40) / 100) * 100) / 100, mem_mb: 120 + (SEED(seed) % 500), at: new Date(endHour - HOUR).toISOString(),
        trend: Array.from({ length: 24 }, (_, i) => ({ at: new Date(endHour - (24 - i) * HOUR).toISOString(), cpu: 0.06 + (SEED(`${seed}c${i}`) % 40) / 100, mem_mb: 120 + (SEED(`${seed}m${i}`) % 500) })),
      };
    const unavailable = NO_USAGE[p.provider] ? (p.role === "web" ? (["requests", "errors", "latency_p50_ms", "latency_p95_ms", "bandwidth_bytes"] as const) : (["cpu", "mem_mb"] as const))
      .map((metric) => ({ metric, reason: NO_USAGE[p.provider] })) : p.provider === "cloudflare"
      ? [{ metric: "latency_p50_ms" as const, reason: "Cloudflare's Workers analytics report CPU and wall time per invocation, not HTTP response latency" },
        { metric: "latency_p95_ms" as const, reason: "Cloudflare's Workers analytics report CPU and wall time per invocation, not HTTP response latency" },
        { metric: "bandwidth_bytes" as const, reason: "Trov reads requests and errors only from Cloudflare's Workers analytics" }] : [];
    const deploys: ProviderDeployDTO[] = [p.serving, p.latest].filter((d): d is FactsDeploy => !!d).map((d) => ({
      id: d.id, state: d.state, target: d.target, sha: d.sha, branch: d.branch, message: d.message, by: d.by, at: d.createdAt, ready_at: d.readyAt, url: d.url, inspect_url: d.logUrl,
    })).sort((a, b) => b.at.localeCompare(a.at));
    const part: RepoProviderPart = {
      env: p.env, env_label: env?.name ?? p.env, part: p.app, label: p.label, role: p.role, provider: p.provider, provider_label: p.host,
      console_url: null, deploys, traffic, resources,
      seen: { traffic: !!traffic && (live || stale), resources: !!resources && (live || stale), deploys: deploys.length > 0 },
      unavailable, status: deploys.length || live ? "ok" : "not_connected", tone: "neutral",
      last_poll: live || stale ? { at: new Date(now - (stale ? 34 : 20) * MIN).toISOString(), status: "ok", detail: null } : null,
      connection: p.viaGithub ? "not_connected" : p.connection, families,
    };
    if (p.provider === "cloudflare" && live) part.extras = workerExtras(seed, k === "B" ? "trov" : "web", failed, now);
    return part;
  });
  const providers: RepoDashboard["providers"] = parts.length ? (parts.some((p) => p.status === "ok") ? { status: "ok", data: parts } : { status: "empty" }) : { status: "not_connected" };

  // Product: A reports the app's own v2 metrics (the sample's production environment); B is Trov's own v3 endpoint.
  const sample = repoSample(now);
  const product: RepoDashboard["product"] = k === "A" && sample.product.status === "ok"
    ? { status: "ok", data: sample.product.data.filter((e) => e.name === "production").map((e) => ({ ...e, name: "Production" })) }
    : k === "B" ? { status: "ok", data: [trovProduct()] } : { status: "not_connected" };
  // Active users ride the app's own endpoint too — A's.
  const usage: RepoDashboard["usage"] = k === "A" && sample.usage.status === "ok"
    ? { status: "ok", data: Object.fromEntries(REPO_RANGES.map((r) => [r, sample.usage.status === "ok" ? sample.usage.data[r].map((u) => ({ ...u, name: u.name === "staging" ? "Staging" : "Production" })) : []])) as Record<RepoRange, RepoUsageEnv[]> }
    : { status: "not_connected" };
  return { usage, providers, product };

  /** A Worker's extra families, shaped like the design's `workerExtras` (and B's D1 and crons). */
  function workerExtras(seed: string, name: string, broke: boolean, at: number): PartExtras {
    const req7 = name === "trov" ? 335_000 : 1_240_000;
    const scale = (n: number, r: RepoRange) => Math.round(n * RANGE_SCALE[r]);
    const outcome = (r: RepoRange): UsageOutcome[] => [
      { status: "success", label: "Success", tone: "good" as const, count: scale(req7 * 0.993, r) },
      { status: "clientDisconnected", label: "Client disconnected", tone: "neutral" as const, count: scale(req7 * 0.0062, r) },
      { status: "scriptThrewException", label: "Script errors", tone: "bad" as const, count: scale(req7 * (broke ? 0.0031 : 0.0006), r) },
      { status: "exceededResources", label: "Exceeded limits", tone: "warn" as const, count: scale(req7 * 0.0001, r) },
    ].filter((b) => b.count > 0);
    const dayIso = (back: number) => new Date(today - back * DAY).toISOString();
    const extras: PartExtras = {
      outcomes: { state: "ok", reason: null, since: null, ranges: Object.fromEntries(REPO_RANGES.map((r) => [r, outcome(r)])) as Record<RepoRange, UsageOutcome[]> },
      runtime: {
        state: "ok", reason: null, day: dayIso(1).slice(0, 10), since: null,
        cpu_p50_ms: name === "trov" ? 2.1 : 1.8, cpu_p99_ms: name === "trov" ? (broke ? 31.6 : 16.4) : 14.2, wall_p50_ms: name === "trov" ? 42 : 38,
        subrequests: Object.fromEntries(REPO_RANGES.map((r) => [r, scale(req7 * 0.28, r)])) as Record<RepoRange, number>,
        trend: series(`${seed}p99`, 14, 12, 8).map((ms, i) => ({ at: dayIso(14 - i), cpu_p99_ms: ms })),
      },
      storage: name === "trov"
        ? { state: "ok", reason: null, databases: [{
            id: SAMPLE_D1,
            read_queries: { "24h": 172_000, "7d": 1_210_000, "30d": 5_190_000 }, write_queries: { "24h": 6_900, "7d": 48_300, "30d": 207_000 },
            rows_read: { "24h": 5_260_000, "7d": 36_800_000, "30d": 157_700_000 }, rows_written: { "24h": 30_300, "7d": 212_000, "30d": 908_000 },
            size_bytes: 41_600_000, size_day: dayIso(1).slice(0, 10),
            trend: series(`${seed}d1`, 14, 150_000, 40_000).map((reads, i) => ({ at: dayIso(14 - i), reads })),
          }] }
        : { state: "unavailable", reason: "no D1 database is named for this part — set its D1 database ids (the repo scan fills them from wrangler)", databases: [] },
      schedules: name === "trov"
        ? { state: "ok", reason: null, since: null, crons: [
            { expr: "*/10 * * * *", runs: { "24h": 144, "7d": 1_008, "30d": 4_320 }, failed: broke ? { "24h": 1, "7d": 3, "30d": 5 } : { "24h": 0, "7d": 2, "30d": 4 }, last_run: new Date(at - 4 * MIN).toISOString() },
            { expr: "0 13 * * *", runs: { "24h": 1, "7d": 7, "30d": 30 }, failed: { "24h": 0, "7d": 0, "30d": 0 }, last_run: new Date(at - HOUR).toISOString() },
            { expr: "0 13 * * MON", runs: { "24h": 0, "7d": 1, "30d": 4 }, failed: { "24h": 0, "7d": 0, "30d": 0 }, last_run: new Date(at - 2 * DAY).toISOString() },
          ] }
        : { state: "none", reason: null, since: null, crons: [] },
    };
    return extras;
  }

  /** Trov's own v3 body as the projection draws it (src/data/own-metrics.ts → src/tools/repo.ts `projectProduct`). */
  function trovProduct(): RepoProductEnv {
    const fmt = (n: number) => (n >= 999_950 ? `${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
    const now1 = (key: string, label: string, n: number) => ({ key, label, values: { "24h": fmt(n), "7d": fmt(n), "30d": fmt(n) }, raw: { "24h": n, "7d": n, "30d": n }, trend: [] as number[] });
    const win = (key: string, label: string, n7: number) => {
      const raw = { "24h": Math.round(n7 / 7), "7d": n7, "30d": Math.round(n7 * 30 / 7) };
      return { key, label, raw, values: { "24h": fmt(raw["24h"]), "7d": fmt(raw["7d"]), "30d": fmt(raw["30d"]) }, trend: [] as number[] };
    };
    const tools: [string, number][] = [["query", 4210], ["get_doc", 1930], ["get_my_work", 862], ["record_session", 312], ["append_feed", 298], ["get_repo_dashboard", 164], ["propose_doc_update", 141]];
    return {
      name: "Production", version: 3, part: "trov", label: "Trov", totals: [],
      groups: [
        { id: "now", title: "Right now", shape: "stats", now: true, metrics: [now1("people", "People", 6), now1("live_docs", "Live docs", 184), now1("awaiting_review", "Awaiting review", 7), now1("in_triage", "In triage", 3), now1("open_tickets", "Open tickets", 41), now1("agents_connected", "Agents connected", 9)] },
        { id: "mcp_tools", title: "MCP tool calls", shape: "ranked", note: "Counted per UTC day: 24h is today so far.", metrics: tools.map(([t, n]) => win(`mcp_${t}`, t, n)) },
        { id: "gate", title: "Agent writes through the gate", shape: "stats", note: "Every agent write goes through the gate; a person promotes or rejects it.", metrics: [win("gate_staged", "Staged", 451), win("gate_promoted", "Promoted", 388), win("gate_rejected", "Rejected", 21), win("gate_to_triage", "To triage", 42)] },
        { id: "activity", title: "Activity", shape: "stats", note: "Counted per UTC day: 24h is today so far.", metrics: [win("sessions_recorded", "Sessions recorded", 312), win("people_active", "People active", 42)] },
      ],
    };
  }
}
