// Sample DTOs for the four AI screens (and Org settings › AI's numbers), built from the mockup's sample data
// (docs/superpowers/specs/2026-10-14-ai-screens-mock.md). Read ONLY by the
// `LOCAL_AI_PREVIEW` path (src/ai/preview.ts, honoured under `wrangler dev` alone) and by
// tests — production never returns them. Zod-free, so render tests in `web/` can import
// them too. Every date is relative to `now`, so "12 min ago" stays true in a screenshot.

import type { FeedRow } from "./rows";
import {
  AI_ALLOWANCE_KEYS, AI_MODEL, AI_THEME_RANGE_WEEKS, nextMonthStart,
  type AiBrief, type AiRepoState, type AiThemes, type AiThemeLane, type AiThemeRange, type AiCite, type AiState,
  type AiAllowanceKey, type AiAllowanceUse, type AiSettings,
} from "./ai-core";

export { nextMonthStart };

/** What `LOCAL_AI_PREVIEW` may be set to. `proposed` is the themes' proposed state; the other
 *  screens show `ready` under it. Anything else in the var is ignored (no preview). */
export const AI_PREVIEW_MODES = ["ready", "empty", "capped", "proposed"] as const;
export type AiPreviewMode = (typeof AI_PREVIEW_MODES)[number];
export const isAiPreviewMode = (v: unknown): v is AiPreviewMode =>
  typeof v === "string" && (AI_PREVIEW_MODES as readonly string[]).includes(v);

const REPO = "AndresL230/trov";
const gh = (path: string): string => `https://github.com/${REPO}/${path}`;
const pr = (n: number): AiCite => ({ ref: `pr:${n}`, label: `#${n}`, href: gh(`pull/${n}`) });
const sha = (s: string): AiCite => ({ ref: `sha:${s}`, label: s, href: gh(`commit/${s}`) });
const branch = (b: string): AiCite => ({ ref: `branch:${b}`, label: b, href: gh(`tree/${b}`) });
const run = (id: number): AiCite => ({ ref: `run:${id}`, label: `CI run ${id}`, href: gh(`actions/runs/${id}`) });
const handoff = (n: number): AiCite => ({ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` });
const ticket = (n: number): AiCite => ({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });

const ago = (now: Date, ms: number): string => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The Monday (UTC) of `now`'s week, minus `back` weeks, `YYYY-MM-DD`. */
function monday(now: Date, back: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow - back * 7);
  return d.toISOString().slice(0, 10);
}

function meta(state: AiState, now: Date, writtenAgo: number | null) {
  return {
    state,
    generatedAt: writtenAgo === null ? null : ago(now, writtenAgo),
    model: writtenAgo === null ? null : AI_MODEL,
    resumesOn: state === "capped" ? nextMonthStart(now) : null,
    upgrade: state === "capped",
  };
}

// ── My Work › Your brief ────────────────────────────────────────────────────
export function briefFixture(state: AiState, now: Date): AiBrief {
  if (state === "empty") return { ...meta("empty", now, null), now: null, recently: null, next: { items: [] } };
  const nowLine = {
    text: "You are partway through the hosting screens on feat/hosting-screens. The last push failed CI on the Netlify connect test.",
    cites: [branch("feat/hosting-screens"), run(4812)],
  };
  if (state === "capped") return { ...meta("capped", now, 9 * DAY), now: nowLine, recently: null, next: { items: [] } };
  return {
    ...meta("ready", now, 12 * MIN),
    now: nowLine,
    recently: {
      text: "Shipped status marks across the app, site and digests, and release 0.30 with public docs and account deletion. Trov now connects to Claude on the web.",
      cites: [pr(173), pr(172), pr(171)],
    },
    next: {
      items: [
        { ref: "run:4812", kind: "failing", title: "Fix the Netlify connect test", why: "It blocks the hosting PR you are working on.", cites: [run(4812), branch("feat/hosting-screens")] },
        { ref: "handoff:3", kind: "handoff", title: "Performance plan for trov.dev", why: "Left for anyone yesterday. Nothing in it is built yet.", cites: [handoff(3)] },
        { ref: "ticket:14", kind: "ticket", title: "Guided repository setup", why: "Assigned to you. It builds on the hosting work.", cites: [ticket(14)] },
      ],
    },
  };
}

// ── Repo › Overview › State ─────────────────────────────────────────────────
export function repoStateFixture(state: AiState, now: Date): AiRepoState {
  const headline = "Release 0.30 is live; hosting screens are the open front, and main is green.";
  if (state === "empty") return { ...meta("empty", now, null), headline: null, shipped: [], inFlight: [], attention: [], eventCount: null };
  if (state === "capped") return { ...meta("capped", now, 9 * DAY), headline, shipped: [], inFlight: [], attention: [], eventCount: 6 };
  return {
    ...meta("ready", now, 2 * HOUR),
    headline,
    shipped: [
      { text: "Status marks replace status tags everywhere.", cites: [pr(173)] },
      { text: "Release 0.30: public docs, account deletion, compliance pass.", cites: [pr(172)] },
      { text: "Claude on the web connector; partial-access GitHub orgs.", cites: [pr(171)] },
    ],
    inFlight: [
      { text: "Hosting screens for Vercel and Netlify.", cites: [branch("feat/hosting-screens")] },
      { text: "Performance plan for trov.dev, waiting on an owner.", cites: [handoff(3)] },
    ],
    attention: [
      { text: "CI failing on the hosting branch since this morning.", cites: [{ ...run(4812), label: "run 4812" }] },
      { text: "28 open tickets, none in a sprint.", cites: [{ ref: "tickets", label: "Tickets", href: "#tickets" }] },
    ],
    eventCount: 6,
  };
}

// ── Feed: entries written by Trov ───────────────────────────────────────────
/** Two entries written by Trov, as `/feed` rows. Ids sit far above any real row's so the preview
 *  can merge them into a real feed without colliding. `author` is the system handle. */
export function feedFixtures(now: Date): FeedRow[] {
  return [
    {
      id: 990_001,
      author: "trov",
      summary: "Shipped: status marks replace status tags across the app",
      brief: "States now read the same everywhere, with a short word and a shape you can hover for what it means, so a glance at any screen tells you where things stand.",
      body: null,
      artifacts: JSON.stringify({ prs: ["173"], commits: ["65b9f1f", "a1c04e2"], issues: [] }),
      created_at: ago(now, 1 * HOUR),
      ai: {
        origin: "ai",
        subject: "andres",
        sources: [pr(173), sha("65b9f1f"), sha("a1c04e2")],
        moreCount: 2,
        generatedAt: ago(now, 1 * HOUR),
        model: AI_MODEL,
      },
    },
    {
      id: 990_002,
      author: "trov",
      summary: "Status: hosting screens are partway, CI is red",
      brief: "The Vercel and Netlify connect screens are drafted on a branch. The Netlify connect test fails, so nothing is merged yet.",
      body: null,
      artifacts: JSON.stringify({ prs: [], commits: [], issues: [] }),
      created_at: ago(now, 5 * HOUR),
      ai: {
        origin: "ai",
        subject: "andres",
        sources: [branch("feat/hosting-screens"), { ...run(4812), label: "run 4812" }],
        moreCount: 0,
        generatedAt: ago(now, 5 * HOUR),
        model: AI_MODEL,
      },
    },
  ];
}

// ── Repo › Planning › Where the work went ───────────────────────────────────
// The mock's six lanes. `w` is its relative weekly weight over the last 8 weeks (0 = no band);
// counts are `round(w * 6)`, and the Quarter range pads 5 earlier weeks from `early`.
const LANES: { id: string; name: string; colorKey: AiThemeLane["colorKey"]; w: number[]; early: number[]; description: string; prs: AiCite[] }[] = [
  { id: "multiorg", name: "Multi-org and GitHub App", colorKey: "sky", w: [0, 0, 0.2, 0.6, 0.9, 1, 0.7, 0.3], early: [0, 0, 0, 0, 0], description: "The move from one team to many organizations, the rename to Trov, and the GitHub App install flow.", prs: [{ ...pr(171), label: "#171 One GitHub account, several orgs" }, { ref: "pr:160", label: "Multi-org re-architecture", href: gh("pull/160") }, { ref: "pr:152", label: "GitHub App install flow", href: gh("pull/152") }] },
  { id: "tickets", name: "Tickets and sprints", colorKey: "fern", w: [0.3, 0.8, 1, 0.7, 0.3, 0.1, 0, 0], early: [0.2, 0.4, 0.6, 0.5, 0.3], description: "Tickets as their own records, sprints replacing milestones, and GitHub issues mirrored in.", prs: [{ ref: "pr:78", label: "Tickets and the board", href: gh("pull/78") }, { ref: "pr:75", label: "GitHub issues mirrored as tickets", href: gh("pull/75") }] },
  { id: "repo", name: "Repo dashboard", colorKey: "slate", w: [0.5, 0.6, 0.4, 0.6, 0.5, 0.3, 0.4, 0.2], early: [0.3, 0.5, 0.6, 0.4, 0.5], description: "Capture, health and metrics; hosting connections are the open thread.", prs: [{ ref: "pr:57", label: "Repo dashboard capture", href: gh("pull/57") }, { ref: "branch:feat/hosting-screens", label: "Hosting connections (in flight)", href: gh("tree/feat/hosting-screens") }] },
  { id: "billing", name: "Billing and plans", colorKey: "ochre", w: [0, 0, 0, 0, 0.2, 0.4, 0.8, 0.5], early: [0, 0, 0, 0, 0], description: "Per-seat Pro, Stripe Checkout and the embedded checkout.", prs: [{ ref: "pr:136", label: "#136 Embedded checkout", href: gh("pull/136") }, { ref: "pr:130", label: "Per-seat Pro plan", href: gh("pull/130") }] },
  { id: "site", name: "Public site and docs", colorKey: "plum", w: [0, 0, 0, 0, 0.1, 0.3, 0.6, 1], early: [0, 0.1, 0, 0, 0], description: "The crawlable site, public docs, legal pages and the mobile layout.", prs: [{ ...pr(172), label: "#172 Release 0.30: crawlable site, public docs" }, { ref: "pr:139", label: "#139 Mobile marketing site", href: gh("pull/139") }] },
  { id: "polish", name: "UI polish", colorKey: "rose", w: [0.2, 0.1, 0.2, 0.3, 0.2, 0.2, 0.5, 0.9], early: [0.3, 0.2, 0.4, 0.2, 0.1], description: "Status marks, the Review page and smaller fixes across screens.", prs: [{ ...pr(173), label: "#173 Status marks" }, { ref: "pr:138", label: "#138 Review page", href: gh("pull/138") }] },
];

export function themesFixture(mode: AiPreviewMode, range: AiThemeRange, now: Date): AiThemes {
  const n = AI_THEME_RANGE_WEEKS[range];
  const weeks = Array.from({ length: n }, (_, i) => monday(now, n - 1 - i));
  if (mode === "empty") return { ...meta("empty", now, null), caption: null, prCount: null, range, weeks: [], lanes: [] };
  const proposed = mode === "proposed";
  const lanes: AiThemeLane[] = LANES.map((l, i) => {
    const weights = range === "8w" ? l.w : [...l.early, ...l.w];
    return {
      id: l.id, name: l.name, colorKey: l.colorKey, description: l.description, prs: l.prs,
      counts: weights.map((w) => Math.round(w * 6)),
      status: proposed ? "proposed" : "active",
      suggestionId: proposed ? 900 + i : null,
    };
  });
  const prCount = lanes.reduce((s, l) => s + l.counts.reduce((a, b) => a + b, 0), 0);
  const caption = "Since late August most of the work went to multi-org and the GitHub App. October turned to the public site, billing and polish; tickets went quiet after September.";
  const state: AiState = mode === "capped" ? "capped" : "ready";
  return { ...meta(state, now, state === "capped" ? 9 * DAY : 3 * HOUR), caption: proposed ? null : caption, prCount, range, weeks, lanes };
}

// ── Org settings › AI ───────────────────────────────────────────────────────
/** What the preview puts on `GET /ai/settings`: the eligibility and all four allowances, as a 5-seat Pro org
 *  would see them (Ask Trov: 500 per seat). The switches (`enabled`, `chatAuto`), who may change them and what
 *  is sent stay the org's real ones — the preview fills numbers, never a choice — and what is sent always names
 *  both providers. `ready` / `proposed`: partway through the month; `empty`: nothing used yet; `capped`:
 *  every allowance used up, each resuming on the 1st. */
export function aiSettingsFixture(mode: AiPreviewMode, now: Date): Pick<AiSettings, "eligibility" | "allowances"> {
  const caps: Record<AiAllowanceKey, number> = { ai_summaries: 3000, ai_runs: 2000, jev_checks: 10000, ai_chat: 500 * 5 };
  const used: Record<AiAllowanceKey, number> = mode === "empty" ? { ai_summaries: 0, ai_runs: 0, jev_checks: 0, ai_chat: 0 }
    : mode === "capped" ? caps
    : { ai_summaries: 212, ai_runs: 486, jev_checks: 1240, ai_chat: 1830 };
  const resumesOn = mode === "capped" ? nextMonthStart(now) : null;
  const allowances = Object.fromEntries(AI_ALLOWANCE_KEYS.map((k) => [k, { used: used[k], cap: caps[k], resumesOn }])) as Record<AiAllowanceKey, AiAllowanceUse>;
  return { eligibility: mode === "capped" ? "capped" : "ok", allowances };
}

/** Everything one preview mode puts on the reads. */
export function aiPreviewFixtures(mode: AiPreviewMode, now: Date = new Date()) {
  const state: AiState = mode === "proposed" ? "ready" : mode;
  return {
    brief: briefFixture(state, now),
    repoState: repoStateFixture(state, now),
    feed: feedFixtures(now),
    themes: { "8w": themesFixture(mode, "8w", now), quarter: themesFixture(mode, "quarter", now) } as Record<AiThemeRange, AiThemes>,
    settings: aiSettingsFixture(mode, now),
  };
}
