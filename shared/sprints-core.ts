// The ZOD-FREE core of the sprints contract: the controlled vocabulary tuples.
// `shared/sprints.ts` builds its Zod enums on top of these and RE-EXPORTS every
// one of them, so nothing outside this file has to know the split —
// `import { SPRINT_DOMAINS } from "@shared/sprints"` keeps working.
//
// Why the split (the same reason `shared/tickets-core.ts` exists): the SPA needs
// the vocabulary as VALUES at runtime (the New sprint panel's urgency segment and
// domain chips iterate it), and `web/` importing a module that evaluates
// `z.object(...)` at load time drags the whole of zod into the browser bundle
// (+70 kB minified, measured in Phase 5a). This module has no imports at all.
//
// These tuples MUST match the CHECK constraints in `migrations/0025_sprints.sql`.

export const SPRINT_URGENCIES = ["low", "normal", "high"] as const;
export const SPRINT_DOMAINS = ["notifications", "tickets", "gate", "feed", "search", "infra"] as const;
export const SPRINT_STATUSES = ["upcoming", "in_progress", "done"] as const;
export const SPRINT_RESOURCE_KINDS = ["github", "figma", "plain"] as const;

export type SprintUrgency = (typeof SPRINT_URGENCIES)[number];
export type SprintDomain = (typeof SPRINT_DOMAINS)[number];
export type SprintStatus = (typeof SPRINT_STATUSES)[number];
export type SprintResourceKind = (typeof SPRINT_RESOURCE_KINDS)[number];

// ── the plan narrative cap ────────────────────────────────────────────────────
// The narrative is the Roadmap's "What's happening" card — Now / Next / Later, a
// sentence or two each (its shape: below); the sprints and the timeline carry the
// detail. Over the cap is a validation error that writes NOTHING (the writer
// resends a shorter one), enforced once at the write seam (`write_plan`), over the
// COMPOSED text (labels included). A narrative already stored over the cap still
// reads — nothing is truncated.
export const PLAN_NARRATIVE_MAX = 800;

/** The refusal for an over-cap narrative (trimmed length), or null when it fits. */
export function planNarrativeProblem(narrative: string): string | null {
  const length = narrative.trim().length;
  return length > PLAN_NARRATIVE_MAX
    ? `narrative is ${length} characters; the cap is ${PLAN_NARRATIVE_MAX}. Shorten it to a few sentences (Now / Next / Later) and resend — nothing was written.`
    : null;
}

// ── the plan narrative's shape: Now / Next / Later (2026-10-18) ──────────────
// The owner's call: the "What's happening" card is a STRUCTURED box — three rows, Now, Next and Later — and the
// structure is enforced AT WRITE, not guessed at render. Every writer (`update_plan` over MCP, Ask Trov's card,
// Trov's accepted narrative proposal) gives the three parts; `write_plan` composes ONE canonical form and stores it
// in the existing `plan.narrative` column (no migration):
//
//   **Now:** <one paragraph>\n\n**Next:** <one paragraph>\n\n**Later:** <one paragraph>
//
// Each part is one paragraph (whitespace runs, newlines included, are folded to one space), trimmed and non-empty;
// inline markdown emphasis is allowed. The cap is still `PLAN_NARRATIVE_MAX` over the COMPOSED text (labels
// included), so the old message and the old count hold. `parsePlanNarrative` reads a stored narrative back into its
// parts — the canonical form, and the run-together `**Now:** … **Next:** … **Later:** …` written before the rule
// (each label bold, or plain and capitalised, in that order, Now first) — or null for an older free-text narrative,
// which the card still draws as plain markdown (legacy fallback). Zod-free: the SPA draws the box with it.
export const PLAN_NARRATIVE_PARTS = ["now", "next", "later"] as const;
export type PlanNarrativePart = (typeof PLAN_NARRATIVE_PARTS)[number];
export type PlanNarrativeParts = Record<PlanNarrativePart, string>;
export const PLAN_NARRATIVE_LABELS: Record<PlanNarrativePart, string> = { now: "Now", next: "Next", later: "Later" };

/** One paragraph: every whitespace run (a newline too) is one space; trimmed. */
const paragraph = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The ONE stored form of a narrative's three parts. */
export function composePlanNarrative(p: PlanNarrativeParts): string {
  return PLAN_NARRATIVE_PARTS.map((k) => `**${PLAN_NARRATIVE_LABELS[k]}:** ${paragraph(p[k])}`).join("\n\n");
}

// A label: `**Now:**`, `**Now**:` (either case of the first letter), or a plain capitalised `Now:` — at the start or
// after whitespace. The emphasis is not part of the text that follows.
const LABEL_RE = /(^|\s)(?:\*\*([Nn]ow|[Nn]ext|[Ll]ater)\s*:\s*\*\*|\*\*([Nn]ow|[Nn]ext|[Ll]ater)\*\*\s*:|(Now|Next|Later):)/g;

/** A stored narrative's three parts, or null when it is not Now / Next / Later (exactly one of each, in that order,
 *  Now first, none empty) — an older free-text narrative, or "". */
export function parsePlanNarrative(narrative: string): PlanNarrativeParts | null {
  const text = narrative.trim();
  const marks: { part: PlanNarrativePart; start: number; end: number }[] = [];
  for (const m of text.matchAll(LABEL_RE)) {
    const word = (m[2] ?? m[3] ?? m[4]).toLowerCase() as PlanNarrativePart;
    marks.push({ part: word, start: (m.index ?? 0) + m[1].length, end: (m.index ?? 0) + m[0].length });
  }
  if (marks.length !== 3 || marks.some((m, i) => m.part !== PLAN_NARRATIVE_PARTS[i]) || marks[0].start !== 0) return null;
  const parts = {} as PlanNarrativeParts;
  marks.forEach((m, i) => { parts[m.part] = paragraph(text.slice(m.end, marks[i + 1]?.start ?? text.length)); });
  return PLAN_NARRATIVE_PARTS.every((k) => parts[k]) ? parts : null;
}

/** The refusal for three parts that cannot be stored, or null: each must be non-empty, none may carry a label of
 *  its own (it would not read back as the same three), and the composed text fits `PLAN_NARRATIVE_MAX`. */
export function planNarrativePartsProblem(p: Partial<Record<PlanNarrativePart, unknown>>): string | null {
  const missing = PLAN_NARRATIVE_PARTS.filter((k) => typeof p[k] !== "string" || !paragraph(p[k] as string));
  if (missing.length) return `the narrative needs all three parts — now, next and later — each a short paragraph; ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty. Nothing was written.`;
  const parts = p as PlanNarrativeParts;
  const composed = composePlanNarrative(parts);
  const back = parsePlanNarrative(composed);
  if (!back || PLAN_NARRATIVE_PARTS.some((k) => back[k] !== paragraph(parts[k]))) {
    return "a narrative part may not contain a Now: / Next: / Later: label of its own — give each part's text alone. Nothing was written.";
  }
  return planNarrativeProblem(composed);
}

/** What a plan write may say about its narrative: the three parts, or — from an older client — one `narrative`
 *  that already reads as Now / Next / Later. */
export interface PlanNarrativeInput { now?: string; next?: string; later?: string; narrative?: string }

/** The three parts a plan write gives (`write_plan`, the ONE seam), or why it cannot be written. A `narrative`
 *  string is accepted ONLY when it parses into the three parts; parts and a narrative together are refused. */
export function planNarrativeParts(input: PlanNarrativeInput): { parts: PlanNarrativeParts } | { problem: string } {
  const given = PLAN_NARRATIVE_PARTS.some((k) => input[k] !== undefined);
  if (given && input.narrative !== undefined) return { problem: "give the narrative as now, next and later — not together with `narrative`. Nothing was written." };
  if (given) {
    const problem = planNarrativePartsProblem(input);
    return problem ? { problem } : { parts: { now: paragraph(input.now!), next: paragraph(input.next!), later: paragraph(input.later!) } };
  }
  const parsed = typeof input.narrative === "string" ? parsePlanNarrative(input.narrative) : null;
  if (!parsed) return { problem: "the narrative is three parts now: pass `now`, `next` and `later` (one short paragraph each) instead of a free-text `narrative`. Nothing was written." };
  const problem = planNarrativePartsProblem(parsed);
  return problem ? { problem } : { parts: parsed };
}

// ── the ONE due-date rule ─────────────────────────────────────────────────────
// Every surface that says "overdue" or "due this week" about a sprint (the
// Roadmap's sprint cards, its Now box and Timeline-tab dot, the Timeline, My
// Work's ticket rows) reads it HERE, so none can flip on a different day. A
// sprint's `due` (YYYY-MM-DD) is a CALENDAR day in the reader's LOCAL time zone:
// it is due all of that day and overdue from the calendar day AFTER; "soon" (due
// this week) is due today through 7 days out. Whether a done or ready sprint
// counts as overdue is the caller's call — this is only about the date. Pure:
// the clock is injected.

const DAY_MS = 86_400_000;

/** An ISO calendar date (`YYYY-MM-DD…`) → a day key (UTC ms of that date's midnight), or null. */
export function isoDayKey(iso: string | null | undefined): number | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null;
}

/** The LOCAL calendar date of `now`, as the same day key as `isoDayKey`. */
export function localDayKey(now: Date | number): number {
  const d = new Date(now);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

export interface SprintDueState {
  /** From the calendar day after `due`. */
  overdue: boolean;
  /** Due today through 7 days out. */
  soon: boolean;
  /** Whole days past the due day (0 unless overdue). */
  daysLate: number;
  /** Whole days until the due day (0 on the day, and when overdue). */
  daysLeft: number;
}

/** The date half of a sprint's state, or null with no (or an unparseable) due date. */
export function sprintDueState(due: string | null | undefined, now: Date | number): SprintDueState | null {
  const end = isoDayKey(due);
  if (end === null) return null;
  const diff = Math.round((end - localDayKey(now)) / DAY_MS);
  return { overdue: diff < 0, soon: diff >= 0 && diff <= 7, daysLate: Math.max(0, -diff), daysLeft: Math.max(0, diff) };
}

// ── the ONE sprint-date validator ─────────────────────────────────────────────
// A sprint has two real dates: `start` (column `start_date`, 0035) and `due` (column
// `target_date`). Each is either UNSET (null / absent / empty) or a real calendar day
// written `YYYY-MM-DD` — "Oct 17" and "2026-02-30" are refused, not stored. When both
// are set, `start <= due`. Every write path asks HERE — the `POST /sprints` body and
// the `create_sprint` MCP input (both `SprintCreate`), the `update_plan` sprint
// entries, `write_plan` itself (before its first write), and the New sprint panel
// before it submits — so a refusal reads the same everywhere and nothing is written.
// READS never validate: a legacy non-ISO `target_date` stored before this rule still
// reads back as it was (the Timeline lists it as Unscheduled).

/** A string that is exactly `YYYY-MM-DD` (year 1000–9999) AND a real calendar day. */
export function isIsoCalendarDate(value: string): boolean {
  return /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && isoDayKey(value) !== null;
}

/** Null / undefined / blank → null (unset); anything else trimmed. */
export function normalizeSprintDate(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  return v === "" ? null : v;
}

/** The refusal for ONE date field, or null when it is unset or a real ISO day. */
export function sprintDateProblem(field: "start" | "due", value: string | null | undefined): string | null {
  const v = normalizeSprintDate(value);
  if (v === null || isIsoCalendarDate(v)) return null;
  return `${field} must be a real calendar date written YYYY-MM-DD (got ${JSON.stringify(v)}), or empty — nothing was written.`;
}

/** The refusal for a sprint's pair of dates (each field, then the order), or null. */
export function sprintDatesProblem(dates: { start?: string | null; due?: string | null }): string | null {
  const problem = sprintDateProblem("start", dates.start) ?? sprintDateProblem("due", dates.due);
  if (problem) return problem;
  const start = normalizeSprintDate(dates.start);
  const due = normalizeSprintDate(dates.due);
  if (start !== null && due !== null && start > due) {
    return `start (${start}) is after due (${due}); a sprint must start on or before its due date — nothing was written.`;
  }
  return null;
}

// ── the date label a sprint shows ─────────────────────────────────────────────
// One label for every surface that prints a sprint's span (the Roadmap card, the
// sprint screen, the ticket queue's sprint groups, the artifact sprint picker): the
// real `start` / `due` when a start is set, else the free-text `dates` the plan
// authored, else null (the caller shows its own due-date fallback).

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 6 – 17", "Oct 6 – Nov 2", "Dec 20, 2026 – Jan 10, 2027", "From Oct 6"; else `dates`. */
export function sprintDatesLabel(sp: { start?: string | null; due?: string | null; dates?: string | null }): string | null {
  const s = isoDayKey(sp.start && isIsoCalendarDate(sp.start) ? sp.start : null);
  const e = isoDayKey(sp.due && isIsoCalendarDate(sp.due) ? sp.due : null);
  if (s !== null) {
    const a = new Date(s);
    const md = (d: Date) => `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    if (e === null) return `From ${md(a)}`;
    const b = new Date(e);
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${md(a)}, ${a.getUTCFullYear()} – ${md(b)}, ${b.getUTCFullYear()}`;
    if (s === e) return md(a);
    if (a.getUTCMonth() === b.getUTCMonth()) return `${md(a)} – ${b.getUTCDate()}`;
    return `${md(a)} – ${md(b)}`;
  }
  const dates = sp.dates?.trim();
  return dates ? dates : null;
}
