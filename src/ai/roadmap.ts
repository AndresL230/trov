// THE ROADMAP'S PRODUCERS (Phase D, Feature E — docs/architecture/roadmap-my-work.md › Roadmap intelligence;
// docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase D, "Roadmap"). Four Haiku jobs of the AI pass, in
// its org-rollup stage (`org`, `sprint` scopes):
//
//   job                    kind            scope       how            writes
//   roadmap.sprint_note    org.rollup      sprint:<id> direct, ≤10/call  `org_insights` sprint_note (an ACTIVE sprint)
//   roadmap.plan_drift     org.rollup      org         direct         `org_insights` plan_drift — only with themes
//   roadmap.sprint_draft   sprint.draft    org         Batch API      `ai_suggestions` sprint_draft (≥8 open tickets
//                                                                     outside any sprint and none active)
//   roadmap.plan_narrative plan.narrative  org         Batch API      `ai_suggestions` plan_narrative (weekly)
//
// The sprint FORECAST is not here: it is arithmetic, computed on read (`sprintForecast`, src/tools/sprints.ts).
//
// What every job keeps (./grounding.ts): the model fills fields and the server renders — each line's cites must
// be refs that were IN its input (the server builds the `AiCite`), and every number it states must be one the
// server gave it; a line that fails either is not written. For the drift the SERVER counts the theme shares and
// passes them in; the model writes the words. NOTHING HERE MARKS WORK DONE (invariant 5): no job writes a ticket
// or a sprint — the two suggestions change the plan only when an admin accepts them (./roadmap-accept.ts), and
// then through the existing writers, as that admin.
import { z } from "zod";
import {
  AI_DRIFT_WINDOW_DAYS, AI_ROADMAP_ITEM, type AiCite, type AiSprintDraftValue, type AiThemeShare,
} from "@shared/ai";
import { PLAN_NARRATIVE_MAX, planNarrativeProblem } from "@shared/sprints-core";
import type { SprintForecast } from "@shared/sprints";
import { all, first, ph, type TenantContext } from "../data/sql";
import { lastRoadmapSuggestionAt, planDrift, putInsight, sprintNotes } from "../data/org-insights";
import { putSuggestion } from "../data/ai";
import { sprintForecast, ticketCountsBySprint } from "../tools/sprints";
import { each, keep, sections } from "./sections";
import { allowedNumbers, cleanLine, fenced, FENCE_RULE, numbersGiven, sendable, validCites } from "./grounding";
import type { AiJob, ClaudeJob, JobItem } from "./jobs";

const DAY = 86_400_000;
/** A theme this big a share of the window's merged PRs, in no active sprint, is drift. */
export const DRIFT_MIN_PCT = 25;
/** Sprint drafts are offered only with at least this many open tickets outside any sprint (and none active). */
export const DRAFT_MIN_BACKLOG = 8;
/** How often the narrative is proposed, and how long a dismissed draft keeps the next one away. */
export const ROADMAP_SUGGESTION_EVERY_DAYS = 7;

// ── cites the server builds ──────────────────────────────────────────────────

const ticketCite = (n: number): AiCite => ({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });
const sprintCite = (id: number, title: string): AiCite => ({ ref: `sprint:${id}`, label: title.slice(0, 80) || `sprint ${id}`, href: `#sprints/${id}` });
const prCite = (repo: string | null, n: number): AiCite =>
  ({ ref: `pr:${n}`, label: `#${n}`, href: repo ? `https://github.com/${repo}/pull/${n}` : null });
const feedCite = (id: number, summary: string): AiCite => ({ ref: `feed:${id}`, label: summary.replace(/\s+/g, " ").trim().slice(0, 60) || "feed entry", href: "#feed" });
const themeCite = (id: string, name: string): AiCite => ({ ref: `theme:${id}`, label: name.slice(0, 80), href: "#repo/planning" });

const dayParts = (iso: string | null | undefined): number[] => {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
};

/** The PR a GitHub link names: `owner/repo` and its number, or null. */
function prOfUrl(url: string): { repo: string; n: number } | null {
  const m = url.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  return m ? { repo: m[1], n: Number(m[2]) } : null;
}

const SYSTEM_HEAD = `You write short, factual lines for a software team's Roadmap in Trov. ${FENCE_RULE}
Rules you never break:
- Use only facts in the input. Never invent a person, ticket, pull request, theme, date or number.
- NUMBERS: state only numbers that appear in the input exactly as given. Never compute, round, estimate or convert one. When unsure, use words ("most", "a few") instead.
- Never say work is done, finished, complete or should be closed or marked done — people decide that.
- Cite the refs from the input that support what you wrote (exactly as written, e.g. "ticket:14", "pr:173").
- Plain sentences: no markdown, no lists, no quotes, no emoji.`;

// ── sprint notes (`sprint:<id>`) ─────────────────────────────────────────────

export interface NoteInput {
  sprintId: number;
  title: string;
  due: string | null;
  closed: number;
  total: number;
  forecast: SprintForecast | null;
  tickets: { ref: string; title: string; status: string; priority: string; assignees: string[] }[];
  prs: { ref: string; title: string; what: string }[];
  entries: { ref: string; summary: string; at: string }[];
  offered: Map<string, AiCite>;
  allowed: Set<string>;
}

/** What one ACTIVE sprint's note is written from: its tickets (status, priority, assignees), the cards of the PRs
 *  they link, and the last week's feed entries naming those PRs. Null — no call, the scope clears — for a sprint
 *  that is gone, not active, or holds no ticket. */
export async function noteInput(ctx: TenantContext, key: string, now: Date = new Date()): Promise<NoteInput | null> {
  const id = Number(key);
  if (!Number.isInteger(id) || id <= 0) return null;
  const sp = await first<{ id: number; title: string; status: string; start_date: string | null; target_date: string }>(ctx,
    `SELECT id, title, status, start_date, target_date FROM sprints WHERE org_id = ? AND id = ?`, ctx.orgId, id);
  if (!sp || sp.status !== "in_progress") return null;
  const tickets = await all<{ id: number; number: number; title: string; status: string; priority: string }>(ctx,
    `SELECT id, number, title, status, priority FROM tickets WHERE org_id = ? AND sprint_id = ? ORDER BY updated_at DESC, id DESC LIMIT 40`, ctx.orgId, id);
  if (!tickets.length) return null;
  const ids = tickets.map((t) => t.id);
  const [assignees, links, counts] = await Promise.all([
    all<{ ticket_id: number; login: string }>(ctx, `SELECT ticket_id, login FROM ticket_assignees WHERE org_id = ? AND ticket_id IN (${ph(ids.length)}) ORDER BY login`, ctx.orgId, ...ids),
    all<{ ticket_id: number; url: string }>(ctx, `SELECT ticket_id, url FROM ticket_links WHERE org_id = ? AND kind = 'github' AND ticket_id IN (${ph(ids.length)}) ORDER BY id`, ctx.orgId, ...ids),
    ticketCountsBySprint(ctx, [id]),
  ]);
  const prNums = [...new Map(links.map((l) => prOfUrl(l.url)).filter((p): p is { repo: string; n: number } => !!p).map((p) => [`${p.repo}#${p.n}`, p])).values()].slice(0, 10);
  const cards = prNums.length
    ? await all<{ repo: string; pr_number: number; title: string | null; what: string | null }>(ctx,
      `SELECT repo, pr_number, title, what FROM pr_summaries WHERE org_id = ? AND pr_number IN (${ph(prNums.length)})`, ctx.orgId, ...prNums.map((p) => p.n))
    : [];
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const recent = prNums.length
    ? await all<{ id: number; summary: string; artifacts: string | null; created_at: string }>(ctx,
      `SELECT id, summary, artifacts, created_at FROM feed WHERE org_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 50`, ctx.orgId, since)
    : [];
  const prSet = new Set(prNums.map((p) => String(p.n)));
  const entries = recent.filter((f) => {
    try { return ((JSON.parse(f.artifacts ?? "{}") as { prs?: unknown[] }).prs ?? []).some((p) => prSet.has(String(p).replace(/^#/, ""))); } catch { return false; }
  }).slice(0, 5);

  const c = counts.get(id) ?? { total: tickets.length, closed: 0 };
  const forecast = sprintForecast({ status: sp.status, start: sp.start_date, due: sp.target_date || null, closed: c.closed, total: c.total }, now);
  const offered = new Map<string, AiCite>();
  for (const t of tickets) offered.set(`ticket:${t.number}`, ticketCite(t.number));
  const prs = prNums.map((p) => {
    const card = cards.find((x) => x.pr_number === p.n && x.repo.toLowerCase() === p.repo.toLowerCase());
    offered.set(`pr:${p.n}`, prCite(p.repo, p.n));
    return { ref: `pr:${p.n}`, title: sendable(card?.title ?? `pull request ${p.n}`, 140), what: sendable(card?.what ?? "", 300) };
  });
  for (const f of entries) offered.set(`feed:${f.id}`, feedCite(f.id, f.summary));
  const due = sp.target_date || null;
  return {
    sprintId: id, title: sp.title, due, closed: c.closed, total: c.total, forecast,
    tickets: tickets.map((t) => ({
      ref: `ticket:${t.number}`, title: sendable(t.title, 140), status: t.status, priority: t.priority,
      assignees: assignees.filter((a) => a.ticket_id === t.id).map((a) => a.login),
    })),
    prs,
    entries: entries.map((f) => ({ ref: `feed:${f.id}`, summary: sendable(f.summary, 200), at: f.created_at.slice(0, 10) })),
    offered,
    allowed: allowedNumbers(
      c.closed, c.total, c.total - c.closed, ...tickets.map((t) => t.number), ...prNums.map((p) => p.n),
      forecast?.remaining, forecast ? Math.abs(forecast.daysLate ?? 0) : null, ...dayParts(due), ...dayParts(forecast?.projected),
    ),
  };
}

const NoteItem = z.object({
  sprint: z.number().int(),
  text: z.string().min(1).max(240),
  cites: z.array(z.string().max(80)).min(1).max(6),
});
export const NotesAnswer = sections({ notes: z.array(each(NoteItem)).max(20) });
type NotesAnswer = z.infer<typeof NotesAnswer>;

export const NOTE_SYSTEM = `${SYSTEM_HEAD}
Task: for EACH sprint in the input write ONE note — one sentence, at most 200 characters — saying where the sprint stands and what its open work waits on (a blocker, an unassigned ticket, a failing or open pull request). Return one entry per sprint with its "sprint" id, the "text", and 1–4 "cites".`;

export function notePrompt(items: readonly JobItem<NoteInput>[]): { system: string; input: string } {
  return {
    system: NOTE_SYSTEM,
    input: fenced("sprints", items.map(({ input: i }) => ({
      sprint: i.sprintId, title: i.title, due: i.due,
      tickets: { closed: i.closed, total: i.total, open: i.total - i.closed },
      forecast: i.forecast ? { projectedFinish: i.forecast.projected, daysLateVsDue: i.forecast.daysLate } : null,
      items: i.tickets, pullRequests: i.prs, feedEntries: i.entries,
    }))),
  };
}

/** One answered note as it may be stored, or null (no valid cite, a number it was not given, no text). */
export function checkNote(i: NoteInput, n: { text: string; cites: string[] }): { text: string; cites: AiCite[] } | null {
  const text = cleanLine(n.text, 240);
  if (!text || !numbersGiven(text, i.allowed)) return null;
  if (/\b(?:is|are|was|now) (?:done|finished|complete)\b|\bmark(?:ed)? (?:it |them |the sprint )?(?:as )?done\b|\bclose (?:the|this) sprint\b/i.test(text)) return null;
  const cites = validCites(n.cites, i.offered, 4);
  return cites.length ? { text, cites } : null;
}

export const SPRINT_NOTE_JOB: ClaudeJob<NoteInput, NotesAnswer> = {
  provider: "claude", kind: "org.rollup", name: "roadmap.sprint_note", scope: "sprint", promptVersion: "note-1",
  group: 10, schema: NotesAnswer, maxTokens: 2000,
  input: (ctx, s) => noteInput(ctx, s.key),
  prompt: notePrompt,
  async write(ctx, items, out, meta) {
    const written: string[] = [];
    for (const n of keep(out).kept.notes ?? []) {
      const item = items.find((it) => it.input.sprintId === n.sprint);
      if (!item || written.includes(item.scope.key)) continue;
      const line = checkNote(item.input, n);
      if (!line) continue;
      await putInsight(ctx, "sprint_note", item.scope.key, line, { model: meta.model, promptVersion: SPRINT_NOTE_JOB.promptVersion });
      written.push(item.scope.key);
    }
    return written;
  },
};

// ── plan drift (`org`) ───────────────────────────────────────────────────────

/** Theme shares of the window's merged pull requests — COUNTED HERE, never by a model — and whether an active
 *  sprint holds work of each theme. Reads Phase D's `repo_themes` / `pr_themes` (0064, another job's tables) through
 *  this ONE helper: until they exist (or with no active theme, or nothing merged) it answers null and the drift
 *  says nothing. Switch to the themes module's own reader when it lands. */
export async function themeShares(ctx: TenantContext, now: Date, windowDays = AI_DRIFT_WINDOW_DAYS): Promise<AiThemeShare[] | null> {
  const since = new Date(now.getTime() - windowDays * DAY).toISOString();
  let merged: { repo: string; ref_number: number }[];
  let themed: { repo: string; pr_number: number; theme_id: string; name: string }[];
  try {
    merged = await all<{ repo: string; ref_number: number }>(ctx,
      `SELECT repo, ref_number FROM events WHERE org_id = ? AND event_type = 'pr_merged' AND occurred_at >= ?`, ctx.orgId, since);
    if (!merged.length) return null;
    themed = await all<{ repo: string; pr_number: number; theme_id: string; name: string }>(ctx,
      `SELECT p.repo AS repo, p.pr_number AS pr_number, p.theme_id AS theme_id, t.name AS name
         FROM pr_themes p JOIN repo_themes t ON t.org_id = ? AND t.repo = p.repo AND t.id = p.theme_id AND t.status = 'active'
        WHERE p.org_id = ? AND p.theme_id IS NOT NULL`, ctx.orgId, ctx.orgId);
  } catch {
    return null; // the themes tables are not there yet (0064): the drift says nothing
  }
  if (!themed.length) return null;
  const key = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;
  const themeOf = new Map(themed.map((t) => [key(t.repo, t.pr_number), t]));
  const counts = new Map<string, { name: string; n: number }>();
  for (const m of merged) {
    const t = themeOf.get(key(m.repo, m.ref_number));
    if (!t) continue;
    const c = counts.get(t.theme_id) ?? { name: t.name, n: 0 };
    c.n++;
    counts.set(t.theme_id, c);
  }
  if (!counts.size) return null;
  // Which themes the ACTIVE sprints hold: their tickets' linked PRs, by theme.
  const links = await all<{ url: string }>(ctx,
    `SELECT tl.url AS url FROM ticket_links tl
       JOIN tickets t ON t.org_id = ? AND t.id = tl.ticket_id
       JOIN sprints s ON s.org_id = ? AND s.id = t.sprint_id AND s.status = 'in_progress'
      WHERE tl.org_id = ? AND tl.kind = 'github'`, ctx.orgId, ctx.orgId, ctx.orgId);
  const inSprint = new Set<string>();
  for (const l of links) {
    const p = prOfUrl(l.url);
    const t = p ? themeOf.get(key(p.repo, p.n)) : undefined;
    if (t) inSprint.add(t.theme_id);
  }
  return [...counts.entries()]
    .map(([themeId, c]) => ({ themeId, theme: c.name, pct: Math.round((100 * c.n) / merged.length), inSprint: inSprint.has(themeId) }))
    .filter((s) => s.pct > 0)
    .sort((a, b) => b.pct - a.pct || a.theme.localeCompare(b.theme))
    .slice(0, 8);
}

export interface DriftInput {
  windowDays: number;
  shares: AiThemeShare[];
  offPlan: string[];
  sprints: { ref: string; title: string }[];
  offered: Map<string, AiCite>;
  allowed: Set<string>;
}

/** The drift's input, or null when there is nothing to say: no themes, nothing merged in the window, or every big
 *  theme sits in an active sprint. `shares` is the server's count — the model only words it. */
export async function driftInput(ctx: TenantContext, now: Date = new Date(), shares?: AiThemeShare[] | null): Promise<DriftInput | null> {
  const s = shares === undefined ? await themeShares(ctx, now) : shares;
  if (!s?.length) return null;
  const offPlan = s.filter((x) => x.pct >= DRIFT_MIN_PCT && !x.inSprint).map((x) => x.themeId);
  if (!offPlan.length) return null;
  const sprints = await all<{ id: number; title: string }>(ctx,
    `SELECT id, title FROM sprints WHERE org_id = ? AND status = 'in_progress' ORDER BY id LIMIT 10`, ctx.orgId);
  const offered = new Map<string, AiCite>();
  for (const x of s) offered.set(`theme:${x.themeId}`, themeCite(x.themeId, x.theme));
  for (const sp of sprints) offered.set(`sprint:${sp.id}`, sprintCite(sp.id, sp.title));
  const windowDays = AI_DRIFT_WINDOW_DAYS;
  return {
    windowDays, shares: s, offPlan, offered,
    sprints: sprints.map((sp) => ({ ref: `sprint:${sp.id}`, title: sendable(sp.title, 120) })),
    allowed: allowedNumbers(windowDays, windowDays / 7, ...s.map((x) => x.pct)),
  };
}

const DriftItem = z.object({ text: z.string().min(1).max(240), cites: z.array(z.string().max(80)).min(1).max(4) });
export const DriftAnswer = sections({ drift: DriftItem });
type DriftAnswer = z.infer<typeof DriftAnswer>;

export const DRIFT_SYSTEM = `${SYSTEM_HEAD}
Task: write ONE sentence (at most 200 characters) on where the team's merged work went against its plan in the window given. The input lists each theme's share of the merged pull requests (counted by Trov) and whether any active sprint holds work of that theme. Lead with the theme(s) in "offPlan": they took a large share but are not in any active sprint. Cite each theme you name ("theme:<id>"), and a sprint ("sprint:<id>") only when you name it.`;

export function driftPrompt(items: readonly JobItem<DriftInput>[]): { system: string; input: string } {
  const i = items[0].input;
  return {
    system: DRIFT_SYSTEM,
    input: fenced("drift", {
      windowDays: i.windowDays,
      themes: i.shares.map((x) => ({ ref: `theme:${x.themeId}`, name: x.theme, sharePct: x.pct, inActiveSprint: x.inSprint })),
      offPlan: i.offPlan.map((t) => `theme:${t}`),
      activeSprints: i.sprints,
    }),
  };
}

/** The drift as it may be stored, or null: it must name (cite) an off-plan theme and state no number it was not
 *  given. */
export function checkDrift(i: DriftInput, d: { text: string; cites: string[] }): { text: string; cites: AiCite[] } | null {
  const text = cleanLine(d.text, 240);
  if (!text || !numbersGiven(text, i.allowed)) return null;
  const cites = validCites(d.cites, i.offered, 4);
  if (!cites.some((c) => i.offPlan.includes(c.ref.slice("theme:".length)) && c.ref.startsWith("theme:"))) return null;
  return { text, cites };
}

export const PLAN_DRIFT_JOB: ClaudeJob<DriftInput, DriftAnswer> = {
  provider: "claude", kind: "org.rollup", name: "roadmap.plan_drift", scope: "org", promptVersion: "drift-1",
  group: 1, schema: DriftAnswer, maxTokens: 800,
  input: (ctx) => driftInput(ctx),
  prompt: driftPrompt,
  async write(ctx, items, out, meta) {
    const item = items[0];
    const d = keep(out).kept.drift;
    const line = d ? checkDrift(item.input, d) : null;
    if (!line) return [];
    await putInsight(ctx, "plan_drift", "", { ...line, windowDays: item.input.windowDays, shares: item.input.shares }, { model: meta.model, promptVersion: PLAN_DRIFT_JOB.promptVersion });
    return [item.scope.key];
  },
};

// ── sprint drafts (`org`, Batch API) ─────────────────────────────────────────

export interface DraftInput {
  tickets: { ref: string; number: number; title: string; category: string; priority: string; parent: number | null; links: string[] }[];
  numbers: Set<number>;
  allowed: Set<string>;
}

const recent = (at: string | undefined, now: Date): boolean => !!at && now.getTime() - Date.parse(at) < ROADMAP_SUGGESTION_EVERY_DAYS * DAY;

/** The backlog a draft is made from — or null: a sprint is active, fewer than `DRAFT_MIN_BACKLOG` open tickets sit
 *  outside every sprint, a draft is still open, or one was made in the last week (dismissed ones included). */
export async function draftInput(ctx: TenantContext, now: Date = new Date()): Promise<DraftInput | null> {
  const active = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM sprints WHERE org_id = ? AND status = 'in_progress'`, ctx.orgId);
  if ((active?.n ?? 0) > 0) return null;
  const backlog = await first<{ n: number }>(ctx,
    `SELECT COUNT(*) AS n FROM tickets WHERE org_id = ? AND sprint_id IS NULL AND status IN ('submitted', 'in_progress', 'testing')`, ctx.orgId);
  if ((backlog?.n ?? 0) < DRAFT_MIN_BACKLOG) return null;
  const last = await lastRoadmapSuggestionAt(ctx, "sprint_draft");
  if (last && (last.open || recent(last.at, now))) return null;
  const rows = await all<{ id: number; number: number; title: string; category: string; priority: string; parent_number: number | null }>(ctx,
    `SELECT t.id, t.number, t.title, t.category, t.priority, (SELECT p.number FROM tickets p WHERE p.org_id = ? AND p.id = t.parent_id) AS parent_number
       FROM tickets t WHERE t.org_id = ? AND t.sprint_id IS NULL AND t.status IN ('submitted', 'in_progress', 'testing')
      ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at DESC, t.id DESC LIMIT 60`,
    ctx.orgId, ctx.orgId);
  const ids = rows.map((r) => r.id);
  const links = ids.length
    ? await all<{ ticket_id: number; label: string }>(ctx, `SELECT ticket_id, label FROM ticket_links WHERE org_id = ? AND ticket_id IN (${ph(ids.length)}) ORDER BY id`, ctx.orgId, ...ids)
    : [];
  const tickets = rows.map((r) => ({
    ref: `ticket:${r.number}`, number: r.number, title: sendable(r.title, 140), category: r.category, priority: r.priority, parent: r.parent_number,
    links: links.filter((l) => l.ticket_id === r.id).map((l) => sendable(l.label, 60)).slice(0, 3),
  }));
  return { tickets, numbers: new Set(rows.map((r) => r.number)), allowed: allowedNumbers(...rows.map((r) => r.number), ...tickets.flatMap((t) => [t.title, ...t.links])) };
}

const DraftSprint = z.object({
  name: z.string().min(1).max(60),
  goal: z.string().min(1).max(160),
  tickets: z.array(z.number().int()).min(1).max(20),
});
export const DraftAnswer = sections({ sprints: z.array(each(DraftSprint)).max(4), reason: z.string().min(1).max(200) });
type DraftAnswer = z.infer<typeof DraftAnswer>;

export const DRAFT_SYSTEM = `${SYSTEM_HEAD}
Task: no sprint is active and these open tickets sit outside every sprint. Propose 2 to 4 sprints that group them by the work they touch. Each sprint: a short "name" (at most 40 characters, no numbers), a one-sentence "goal" (at most 140 characters), and the "tickets" it takes, by their numbers from the input. A ticket goes in at most one sprint; leave out what fits nowhere; keep a parent and its sub-tickets together. Then one "reason" (at most 160 characters) saying why these groups.`;

export function draftPrompt(items: readonly JobItem<DraftInput>[]): { system: string; input: string } {
  return { system: DRAFT_SYSTEM, input: fenced("backlog", items[0].input.tickets.map(({ number, title, category, priority, parent, links }) => ({ number, title, category, priority, parent, links }))) };
}

/** The draft as it may be suggested, or null: only backlog tickets, each once; names and goals with no number
 *  they were not given; at least two sprints left. */
export function checkDraft(i: DraftInput, a: Partial<DraftAnswer>): { value: AiSprintDraftValue; reason: string; cites: AiCite[] } | null {
  const reason = cleanLine(a.reason, 200);
  if (!reason || !numbersGiven(reason, i.allowed)) return null;
  const used = new Set<number>();
  const sprints: AiSprintDraftValue["sprints"] = [];
  for (const sp of a.sprints ?? []) {
    const name = cleanLine(sp.name, 60);
    const goal = cleanLine(sp.goal, 160);
    if (!name || !goal || !numbersGiven(`${name} ${goal}`, i.allowed)) continue;
    const tickets = sp.tickets.filter((n) => i.numbers.has(n) && !used.has(n));
    if (!tickets.length) continue;
    for (const n of tickets) used.add(n);
    sprints.push({ name, goal, tickets });
  }
  if (sprints.length < 2) return null;
  return { value: { sprints }, reason, cites: sprints.flatMap((s) => s.tickets).slice(0, 6).map(ticketCite) };
}

export const SPRINT_DRAFT_JOB: ClaudeJob<DraftInput, DraftAnswer> = {
  provider: "claude", kind: "sprint.draft", name: "roadmap.sprint_draft", scope: "org", promptVersion: "draft-1",
  group: 1, batch: true, schema: DraftAnswer, maxTokens: 2500,
  input: (ctx) => draftInput(ctx),
  prompt: draftPrompt,
  async write(ctx, items, out, meta) {
    const item = items[0];
    const d = checkDraft(item.input, keep(out).kept);
    if (!d) return [];
    const id = await putSuggestion(ctx, {
      ...AI_ROADMAP_ITEM, kind: "sprint_draft", value: d.value, confidence: null, reason: d.reason, cites: d.cites,
      model: meta.model, promptVersion: SPRINT_DRAFT_JOB.promptVersion,
    });
    return id === null ? [] : [item.scope.key];
  },
};

// ── the weekly narrative proposal (`org`, Batch API) ─────────────────────────

export interface NarrativeInput {
  current: string;
  sprints: { ref: string; title: string; status: string; due: string | null; closed: number; total: number }[];
  notes: { sprint: string; text: string }[];
  drift: string | null;
  entries: { ref: string; summary: string; at: string }[];
  offered: Map<string, AiCite>;
  allowed: Set<string>;
}

/** What a narrative proposal is written from — or null: one was proposed in the last week (any state), or there
 *  is nothing to write from (no open sprint and no entry this week). */
export async function narrativeInput(ctx: TenantContext, now: Date = new Date()): Promise<NarrativeInput | null> {
  const last = await lastRoadmapSuggestionAt(ctx, "plan_narrative");
  if (last && recent(last.at, now)) return null;
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const [plan, sprints, entries, notes, drift] = await Promise.all([
    first<{ narrative: string }>(ctx, `SELECT narrative FROM plan WHERE org_id = ?`, ctx.orgId),
    all<{ id: number; title: string; status: string; target_date: string }>(ctx,
      `SELECT id, title, status, target_date FROM sprints WHERE org_id = ? AND status != 'done'
        ORDER BY CASE WHEN target_date = '' THEN 1 ELSE 0 END, target_date, id LIMIT 12`, ctx.orgId),
    all<{ id: number; summary: string; created_at: string }>(ctx,
      `SELECT id, summary, created_at FROM feed WHERE org_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 10`, ctx.orgId, since),
    sprintNotes(ctx),
    planDrift(ctx, now),
  ]);
  if (!sprints.length && !entries.length) return null;
  const counts = await ticketCountsBySprint(ctx, sprints.map((s) => s.id));
  const offered = new Map<string, AiCite>();
  for (const s of sprints) offered.set(`sprint:${s.id}`, sprintCite(s.id, s.title));
  for (const f of entries) offered.set(`feed:${f.id}`, feedCite(f.id, f.summary));
  const current = (plan?.narrative ?? "").trim();
  const rows = sprints.map((s) => ({
    ref: `sprint:${s.id}`, title: sendable(s.title, 120), status: s.status, due: s.target_date || null,
    closed: counts.get(s.id)?.closed ?? 0, total: counts.get(s.id)?.total ?? 0,
  }));
  const noteRows = [...notes.entries()].filter(([k]) => sprints.some((s) => String(s.id) === k)).map(([k, n]) => ({ sprint: `sprint:${k}`, text: n.text }));
  const entryRows = entries.map((f) => ({ ref: `feed:${f.id}`, summary: sendable(f.summary, 200), at: f.created_at.slice(0, 10) }));
  return {
    current: sendable(current, 1600), sprints: rows, notes: noteRows, drift: drift?.text ?? null, entries: entryRows, offered,
    allowed: allowedNumbers(current, ...rows.flatMap((r) => [r.title, r.closed, r.total, ...dayParts(r.due)]), ...noteRows.map((n) => n.text), drift?.text, ...entryRows.map((e) => e.summary)),
  };
}

export const NarrativeAnswer = sections({
  narrative: z.string().min(1).max(PLAN_NARRATIVE_MAX),
  reason: z.string().min(1).max(200),
  cites: z.array(z.string().max(80)).min(1).max(6),
});
type NarrativeAnswer = z.infer<typeof NarrativeAnswer>;

export const NARRATIVE_SYSTEM = `${SYSTEM_HEAD}
Task: propose a fresh plan narrative for the Roadmap's "What's happening" card, from the current narrative, the open sprints, Trov's sprint notes and drift line, and this week's feed entries. Write Now / Next / Later in two to four short sentences, at most ${PLAN_NARRATIVE_MAX - 100} characters; markdown emphasis is allowed, no headings or lists. Keep what is still true from the current narrative; no sprint-by-sprint detail or dated logs. Then one "reason" (at most 160 characters) saying what changed, and 1–4 "cites" (sprint or feed refs) it rests on.`;

export function narrativePrompt(items: readonly JobItem<NarrativeInput>[]): { system: string; input: string } {
  const i = items[0].input;
  return {
    system: NARRATIVE_SYSTEM,
    input: fenced("plan", { currentNarrative: i.current || null, openSprints: i.sprints, sprintNotes: i.notes, drift: i.drift, feedThisWeek: i.entries }),
  };
}

/** The proposal as it may be suggested, or null: within the cap, different from today's, no number it was not
 *  given, at least one valid cite. */
export function checkNarrative(i: NarrativeInput, a: Partial<NarrativeAnswer>): { narrative: string; reason: string; cites: AiCite[] } | null {
  const narrative = typeof a.narrative === "string" ? a.narrative.replace(/<[^>]*>/g, "").trim() : "";
  if (!narrative || planNarrativeProblem(narrative) || narrative === i.current.trim()) return null;
  if (!numbersGiven(narrative, i.allowed)) return null;
  const reason = cleanLine(a.reason, 200);
  if (!reason || !numbersGiven(reason, i.allowed)) return null;
  const cites = validCites(a.cites, i.offered, 4);
  return cites.length ? { narrative, reason, cites } : null;
}

export const PLAN_NARRATIVE_JOB: ClaudeJob<NarrativeInput, NarrativeAnswer> = {
  provider: "claude", kind: "plan.narrative", name: "roadmap.plan_narrative", scope: "org", promptVersion: "narrative-1",
  group: 1, batch: true, schema: NarrativeAnswer, maxTokens: 1500,
  input: (ctx) => narrativeInput(ctx),
  prompt: narrativePrompt,
  async write(ctx, items, out, meta) {
    const item = items[0];
    const n = checkNarrative(item.input, keep(out).kept);
    if (!n) return [];
    const id = await putSuggestion(ctx, {
      ...AI_ROADMAP_ITEM, kind: "plan_narrative", value: { narrative: n.narrative }, confidence: null, reason: n.reason, cites: n.cites,
      model: meta.model, promptVersion: PLAN_NARRATIVE_JOB.promptVersion,
    });
    return id === null ? [] : [item.scope.key];
  },
};

/** The roadmap's jobs, in the order the pass runs them within the org-rollup stage. */
export const ROADMAP_JOBS: readonly AiJob[] = [SPRINT_NOTE_JOB, PLAN_DRIFT_JOB, SPRINT_DRAFT_JOB, PLAN_NARRATIVE_JOB];
