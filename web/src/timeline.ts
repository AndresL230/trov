// Roadmap › Timeline — the sprints on a calendar (a Gantt graph).
//
// Same contract as sprints.ts / tickets.ts: PURELY presentational. The sprints,
// the optimistic "confirmed done" set, the person list and the clock come in as
// props; an HTML string goes out. No fetching, no state. Every string is escaped
// through `esc` / `attr` from ./ui.
//
// Layout: one surface card holding
//   1. the header (title, note, legend);
//   2. a summary strip — sprint counts by state, the next due date, and ticket
//      progress over every scheduled sprint (each a number derived below);
//   3. the graph — a two-tier date axis (months over weeks, or years over months
//      for a long plan), a red "today" line, and the SCHEDULED sprints in three
//      LANES, In progress / Upcoming / Done, each ordered by start date. One row
//      per sprint: the lead's avatar, a state tag and how early/late it is on the
//      left; on the track, a bar from start to due, filled by its ticket progress,
//      carrying its name and closed/total (beside the bar when the bar is too
//      short — a container query on the bar decides, so "fits" is measured, not
//      guessed); a hover/focus popover with the rest;
//   4. the sprints with no due date ("Unscheduled"), which have no place on it.
//
// Why lanes by STATE, not by `phase`: `phase` is optional free text (most sprints
// carry none, and the create form never sets it), so phase lanes would mostly be
// one "no phase" bucket; the state lanes are the same In Progress / Upcoming /
// Done split the Narrative tab groups its cards by, so the two tabs agree.
//
// Everything is positioned in PERCENT of the track, so the graph fits its card
// at any width instead of scrolling; the popover is clamped to the track
// (`left: clamp(…)`) and the lower half of the rows open it upward, so it never
// runs off the graph's edge. The narrow layout is a container query in trov.css.
//
// ── What each date is, and the fallbacks (nothing here is invented) ──────────
// • END   = `due` (YYYY-MM-DD), inclusive — the bar runs to the end of that day.
//           A sprint with no `due` (or one that does not parse) is NOT drawn; it
//           is listed under "Unscheduled".
// • START = the sprint's own `start` (YYYY-MM-DD, column `start_date`, 0035) when
//           it is set. Else — a sprint from before 0035 that the backfill could not
//           read — the first date found in the free-text `dates` range ("may 1 –
//           jun 10", "SEP 8 – 19", "2026-05-01 → …"): an ISO date, else "<month>
//           <day> [year]". A month/day with no year takes the due date's year, or
//           the year before when that would put it after the due date.
//           FALLBACK — no `start`, and `dates` absent, unparseable, after the due
//           date, or more than a year before it: the bar is drawn as the two weeks
//           ending on the due date, with a dashed left edge, and the row and
//           popover say the start is not set. Only that ESTIMATE is dashed, and it
//           never produces "starts in Nd"; a real `start` (or a parsed one) does.
// • TODAY = the LOCAL calendar date of `now` (passed in). Overdue / "due in" /
//           "starts in" are whole calendar days against it: a sprint due today is
//           "due today", and overdue from the day after — the ONE due-date rule,
//           `sprintDueState` in shared/sprints-core.ts, shared with every surface. The line is drawn only
//           when today falls within 60 days of the sprints' span, so a plan wholly
//           in the past (or far future) is not squashed to make room for it.

import type { SprintView } from "@shared/sprints";
import { emptyLayout, skBar, skBox, skCard, skList, skW } from "./skeleton";
import { isoDayKey, localDayKey, sprintDueState } from "@shared/sprints-core";
import type { PersonSummary } from "./api";
import { esc, attr, surface } from "./ui";
import { personAvatarLink } from "./people";

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Two weeks, inclusive of the due day — the estimated span when no start is known. */
const FALLBACK_DAYS = 14;
/** How far outside the sprints' span today may sit and still be drawn. */
const TODAY_REACH_DAYS = 60;
/** Up to this span the axis is weeks under months; beyond it, months under years. */
const WEEK_AXIS_MAX_DAYS = 182;

export interface TimelineProps {
  sprints: SprintView[];
  /** Sprints confirmed done in this session, ahead of the server (`AppState.confirmedSprints`). */
  confirmed: Record<string, boolean>;
  persons: PersonSummary[];
  /** The clock, in ms — passed in so the module stays pure (and testable). */
  now: number;
}

export type TlState = "done" | "ready" | "overdue" | "active" | "upcoming";
export type TlLane = "in_progress" | "upcoming" | "done";

const STATE_LABEL: Record<TlState, string> = {
  done: "Done", ready: "Ready to complete", overdue: "Overdue", active: "In progress", upcoming: "Upcoming",
};
const STATE_TAG: Record<TlState, string> = {
  done: "Done", ready: "Ready", overdue: "Overdue", active: "In progress", upcoming: "Upcoming",
};
/** The state's colour — theme vars only. Upcoming is the neutral fg family. */
const STATE_COLOR: Record<TlState, string> = {
  done: "var(--green)", ready: "var(--accent)", overdue: "var(--red)", active: "var(--accent)", upcoming: "var(--fg-55)",
};
const LANES: { id: TlLane; label: string; color: string }[] = [
  { id: "in_progress", label: "In progress", color: "var(--accent)" },
  { id: "upcoming", label: "Upcoming", color: "var(--fg-55)" },
  { id: "done", label: "Done", color: "var(--green)" },
];

// ── dates ────────────────────────────────────────────────────────────────────

/** An ISO calendar date → UTC midnight ms (the day's key), or null — the shared rule's own parse. */
const isoDay = isoDayKey;

/** The LOCAL calendar date of `now`, as the same UTC-midnight day key as `isoDay`. */
export const todayKey = (now: number): number => localDayKey(now);

/** The first date in a free-text range, anchored to the due date's year (see the header). */
export function parseStart(dates: string | null, due: number): number | null {
  if (!dates) return null;
  const iso = dates.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return isoDay(iso[0]);
  const m = dates.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  const day = Number(m[2]);
  const dueYear = new Date(due).getUTCFullYear();
  const at = (y: number): number | null => {
    const t = Date.UTC(y, month, day);
    return new Date(t).getUTCDate() === day ? t : null;
  };
  if (m[3]) return at(Number(m[3]));
  const same = at(dueYear);
  if (same !== null && same <= due) return same;
  return at(dueYear - 1);
}

/** "Sep 8", or "Sep 8, 2026" with the year. */
function dayLabel(t: number, withYear = false): string {
  const d = new Date(t);
  return `${MON_LABEL[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ""}`;
}

/** "Sep 8 – Sep 19, 2026" (the start's year too when the range crosses one). */
function rangeLabel(start: number, end: number): string {
  const crosses = new Date(start).getUTCFullYear() !== new Date(end).getUTCFullYear();
  return `${dayLabel(start, crosses)} – ${dayLabel(end, true)}`;
}

const days = (from: number, to: number): number => Math.round((to - from) / DAY);

// ── the sprints, placed ──────────────────────────────────────────────────────

export interface Placed {
  sp: SprintView;
  state: TlState;
  lane: TlLane;
  start: number;          // day key of the first day
  end: number;            // day key of the due day (inclusive)
  estimated: boolean;     // the start is the two-week fallback
}

const isDone = (sp: SprintView, confirmed: Record<string, boolean>): boolean =>
  sp.status === "done" || !!confirmed[String(sp.id)];

/** The Narrative tab's grouping: done (status or a confirm this session), else active, else upcoming. */
function laneOf(sp: SprintView, confirmed: Record<string, boolean>): TlLane {
  if (isDone(sp, confirmed)) return "done";
  return sp.active ? "in_progress" : "upcoming";
}

/** The sprint card's rules (./sprints `sprintCard`); overdue is the shared `sprintDueState`. */
function stateOf(sp: SprintView, confirmed: Record<string, boolean>, now: number): TlState {
  if (isDone(sp, confirmed)) return "done";
  if (sp.progress.total > 0 && sp.progress.closed >= sp.progress.total) return "ready";
  if (sprintDueState(sp.due, now)?.overdue) return "overdue";
  return sp.active ? "active" : "upcoming";
}

export function placeSprint(sp: SprintView, confirmed: Record<string, boolean>, now: number): Placed | null {
  const end = isoDay(sp.due);
  if (end === null) return null;
  // The real start first (validated on write, so start <= due); a stored value that
  // somehow is not a usable day falls through to the label, then to the estimate.
  const own = isoDay(sp.start);
  const parsed = own !== null && own <= end ? own : parseStart(sp.dates, end);
  const ok = parsed !== null && parsed <= end && (parsed === own || end - parsed <= 366 * DAY);
  return {
    sp, state: stateOf(sp, confirmed, now), lane: laneOf(sp, confirmed), end,
    start: ok ? parsed : end - (FALLBACK_DAYS - 1) * DAY,
    estimated: !ok,
  };
}

/** How early or late a sprint is, in whole calendar days — "" when there is nothing to say. */
export function timingText(p: Placed, now: number): string {
  const today = todayKey(now);
  const dueIn = (n: number) => (n === 0 ? "due today" : `due in ${n}d`);
  switch (p.state) {
    case "done": return "";
    case "ready": return "all tickets closed";
    case "overdue": return `${sprintDueState(p.sp.due, now)?.daysLate ?? days(p.end, today)}d overdue`;
    case "active": return dueIn(days(today, p.end));
    case "upcoming":
      // An estimated start is ours, not the plan's — never count down to it.
      if (!p.estimated && p.start > today) return `starts in ${days(today, p.start)}d`;
      return dueIn(days(today, p.end));
  }
}

export interface TimelineSummary {
  inProgress: number; upcoming: number; done: number; overdue: number; unscheduled: number;
  /** The earliest due date on or after today among sprints not done. */
  next: { label: string; id: number; due: number; inDays: number } | null;
  /** Tickets over every SCHEDULED sprint (unscheduled ones are not on the calendar). */
  tickets: { closed: number; total: number; pct: number };
}

export function timelineSummary(sprints: SprintView[], confirmed: Record<string, boolean>, now: number): TimelineSummary {
  const today = todayKey(now);
  const placed = sprints.map((sp) => placeSprint(sp, confirmed, now)).filter((x): x is Placed => x !== null);
  let next: TimelineSummary["next"] = null;
  for (const p of placed) {
    if (p.state === "done" || p.end < today) continue;
    if (!next || p.end < next.due) next = { label: p.sp.label, id: p.sp.id, due: p.end, inDays: days(today, p.end) };
  }
  const closed = placed.reduce((n, p) => n + p.sp.progress.closed, 0);
  const total = placed.reduce((n, p) => n + p.sp.progress.total, 0);
  return {
    inProgress: sprints.filter((sp) => laneOf(sp, confirmed) === "in_progress").length,
    upcoming: sprints.filter((sp) => laneOf(sp, confirmed) === "upcoming").length,
    done: sprints.filter((sp) => laneOf(sp, confirmed) === "done").length,
    overdue: placed.filter((p) => p.state === "overdue").length,
    unscheduled: sprints.length - placed.length,
    next,
    tickets: { closed, total, pct: total > 0 ? Math.round((closed / total) * 100) : 0 },
  };
}

// ── the axis ─────────────────────────────────────────────────────────────────

interface Axis {
  min: number; max: number;
  /** The fine ticks (Mondays, or month starts) — a light gridline each, some labelled. */
  minor: { t: number; label: string | null; alt: boolean }[];
  /** The coarse segments above them (months, or years) — a band and a stronger line each. */
  major: { from: number; to: number; label: string }[];
}

/** Weeks under months for a span up to ~26 weeks, months under years beyond. The
 *  domain snaps to whole ticks, which is also its padding. */
function buildAxis(from: number, to: number): Axis {
  const span = (to - from) / DAY;
  const minor: Axis["minor"] = [];
  const major: Axis["major"] = [];
  if (span <= WEEK_AXIS_MAX_DAYS) {
    const dow = (new Date(from).getUTCDay() + 6) % 7; // Monday = 0
    const min = from - dow * DAY;
    let max = min;
    while (max < to) max += 7 * DAY;
    const n = Math.round((max - min) / (7 * DAY));
    const step = n <= 26 ? 1 : 2;
    let labelled = 0;
    for (let i = 0; i < n; i++) {
      const t = min + i * 7 * DAY;
      const show = i % step === 0;
      minor.push({ t, label: show ? String(new Date(t).getUTCDate()) : null, alt: show && labelled++ % 2 === 1 });
    }
    for (let k = 0; ; k++) {
      const f = new Date(min);
      const a = Math.max(min, Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + k, 1));
      const b = Math.min(max, Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + k + 1, 1));
      if (a >= max) break;
      const d = new Date(a);
      const withYear = k === 0 || d.getUTCMonth() === 0;
      major.push({ from: a, to: b, label: `${MON_FULL[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ""}` });
    }
    return { min, max, minor, major };
  }
  const f = new Date(from);
  const g = new Date(to);
  const min = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1);
  const max = Date.UTC(g.getUTCFullYear(), g.getUTCMonth() + 1, 1);
  const months: number[] = [];
  for (let k = 0; Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + k, 1) < max; k++) {
    months.push(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + k, 1));
  }
  const step = months.length <= 18 ? 1 : months.length <= 36 ? 2 : 3;
  let labelled = 0;
  months.forEach((t, i) => {
    const show = i % step === 0;
    minor.push({ t, label: show ? MON_LABEL[new Date(t).getUTCMonth()] : null, alt: show && labelled++ % 2 === 1 });
  });
  for (let y = f.getUTCFullYear(); Date.UTC(y, 0, 1) < max; y++) {
    major.push({ from: Math.max(min, Date.UTC(y, 0, 1)), to: Math.min(max, Date.UTC(y + 1, 0, 1)), label: String(y) });
  }
  return { min, max, minor, major };
}

// ── markup ───────────────────────────────────────────────────────────────────

const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;

const LABEL_FACE = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase";

function personOf(persons: PersonSummary[], handle: string): PersonSummary | null {
  return persons.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}
const nameOf = (persons: PersonSummary[], handle: string): string => personOf(persons, handle)?.name || handle;

/** The description's first readable line, markdown markers stripped; else the summary. */
function firstLine(sp: SprintView): string {
  const line = (sp.description ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  const text = line
    ? line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").replace(/\*\*|__|`/g, "")
    : (sp.summary ?? "");
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
}

/** A state's dot — an element, never a `●` character (CLAUDE.md "Corners"). */
function dot(color: string): string {
  return `<span style="width:7px;height:7px;border-radius:999px;background:${color};flex:none"></span>`;
}

function stateTag(state: TlState): string {
  const c = STATE_COLOR[state];
  return `<span class="tl-tag" style="${LABEL_FACE};font-size:9.5px;letter-spacing:.06em;color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 10%,transparent);border-radius:5px;padding:1px 6px;white-space:nowrap;flex:none">${esc(STATE_TAG[state])}</span>`;
}

function popover(p: Placed, persons: PersonSummary[], center: number, up: boolean, when: string): string {
  const { sp, state } = p;
  const c = STATE_COLOR[state];
  const counted = sp.progress.total > 0;
  const n = days(p.start, p.end) + 1;
  const progress = counted
    ? `<div style="display:flex;align-items:center;gap:8px;margin-top:9px">
        <div style="flex:1;height:4px;border-radius:2px;background:var(--hover);overflow:hidden"><div style="height:100%;width:${sp.progress.pct}%;background:${c}"></div></div>
        <span style="font-size:11.5px;color:var(--fg-70);white-space:nowrap">${sp.progress.closed}/${sp.progress.total} tickets done · ${sp.progress.pct}%</span>
      </div>`
    : `<div style="font-size:11.5px;color:var(--fg-40);margin-top:9px">No tickets in this sprint yet</div>`;
  const facts: [string, string][] = [];
  if (sp.lead) facts.push(["Lead", nameOf(persons, sp.lead)]);
  if (sp.members.length) facts.push(["People", `${sp.members.length} with tickets here`]);
  facts.push(["Urgency", sp.urgency === "high" ? "High" : sp.urgency === "low" ? "Low" : "Normal"]);
  if (sp.domain) facts.push(["Domain", sp.domain]);
  if (sp.phase) facts.push(["Phase", sp.phase]);
  const about = firstLine(sp);
  const side = up ? "bottom:calc(100% + 8px)" : "top:calc(100% + 8px)";
  const range = p.estimated ? `Due ${dayLabel(p.end, true)} · start not set` : `${rangeLabel(p.start, p.end)} · ${n} day${n === 1 ? "" : "s"}`;
  return `<div class="tl-pop" id="tl-pop-${sp.id}" role="tooltip" style="border-radius:8px;${side};left:clamp(0px, calc(${pct(center)} - 140px), calc(100% - 280px))">
    <div style="display:flex;align-items:flex-start;gap:8px">
      <span style="flex:1;min-width:0;font-size:13.5px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);overflow-wrap:anywhere">${esc(sp.label)}</span>
      <span style="${LABEL_FACE};font-size:9.5px;letter-spacing:.06em;color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);border-radius:5px;padding:1px 6px;white-space:nowrap;flex:none">${esc(STATE_LABEL[state])}</span>
    </div>
    <div style="font-size:11.5px;color:var(--fg-55);margin-top:3px;font-family:var(--label)">${esc(range)}${when ? ` · <span style="color:${state === "overdue" ? "var(--red)" : "var(--fg-70)"}">${esc(when)}</span>` : ""}</div>
    ${progress}
    <div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;margin-top:10px;font-size:11.5px">
      ${facts.map(([k, v]) => `<span style="color:var(--fg-40)">${esc(k)}</span><span style="color:var(--fg-70);overflow-wrap:anywhere">${esc(v)}</span>`).join("")}
    </div>
    ${about ? `<p style="font-size:12px;line-height:1.5;color:var(--fg-70);margin:9px 0 0;padding-top:9px;border-top:1px solid var(--border)">${esc(about)}</p>` : ""}
    <div style="font-size:11px;color:var(--fg-40);margin-top:8px">Click to open the sprint</div>
  </div>`;
}

function row(p: Placed, axis: Axis, persons: PersonSummary[], now: number, up: boolean, i: number): string {
  const { sp, state } = p;
  const span = axis.max - axis.min;
  const left = (p.start - axis.min) / span;
  const width = (p.end + DAY - p.start) / span;
  const c = STATE_COLOR[state];
  const counted = sp.progress.total > 0;
  const count = counted ? `${sp.progress.closed}/${sp.progress.total}` : "";
  const when = timingText(p, now);
  const dates = p.estimated ? `Due ${dayLabel(p.end)} · start not set` : `${dayLabel(p.start)} – ${dayLabel(p.end)}`;
  const aria = `${sp.label} — ${STATE_LABEL[state]}${when ? `, ${when}` : ""}, ${p.estimated ? `due ${dayLabel(p.end, true)}` : rangeLabel(p.start, p.end)}${counted ? `, ${sp.progress.closed} of ${sp.progress.total} tickets done` : ""}. Open sprint`;
  // The name + count travel beside a bar too short to hold them — on the right,
  // or on the left when the bar ends in the last ~40% of the track.
  const outSide = left + width > 0.6 ? "l" : "r";
  const lead = sp.lead
    ? personAvatarLink(personOf(persons, sp.lead), sp.lead, 22)
    : `<span title="No lead" style="width:22px;height:22px;border-radius:999px;border:1px dashed var(--border);flex:none"></span>`;
  return `<div class="tl-row">
    <div class="tl-lab">
      ${lead}
      <span style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="display:flex;align-items:center;gap:6px;min-width:0">${stateTag(state)}${when ? `<span style="font-size:11.5px;font-weight:500;color:${state === "overdue" ? "var(--red)" : "var(--fg-70)"};white-space:nowrap">${esc(when)}</span>` : ""}</span>
        <span style="font-size:10.5px;color:var(--fg-40);font-family:var(--label);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(dates)}</span>
      </span>
    </div>
    <div class="tl-track">
      <div class="tl-barwrap" style="left:${pct(left)};width:${pct(width)}">
        <button class="tl-bar" data-act="openSprint" data-arg="${sp.id}" aria-label="${attr(aria)}" aria-describedby="tl-pop-${sp.id}" style="--tl-c:${c};background:color-mix(in srgb,${c} 13%,var(--surface));border:1px solid color-mix(in srgb,${c} 55%,transparent);border-radius:6px${p.estimated ? ";border-left-style:dashed" : ""}">
          <span class="tl-fill" style="--i:${i};width:${sp.progress.pct}%;background:color-mix(in srgb,${c} 34%,var(--surface));box-shadow:inset 0 -3px 0 ${c}"></span>
          <span class="tl-in"><span class="tl-name">${esc(sp.label)}</span>${count ? `<span class="tl-cnt">${count}</span>` : ""}</span>
        </button>
        <span class="tl-out tl-out--${outSide}" aria-hidden="true"><b>${esc(sp.label)}</b>${count ? ` <span>${count}</span>` : ""}</span>
      </div>
      ${popover(p, persons, left + width / 2, up, when)}
    </div>
  </div>`;
}

function legend(): string {
  const item = (state: TlState, text: string) =>
    `<span style="display:inline-flex;align-items:center;gap:6px">${dot(STATE_COLOR[state])}${esc(text)}</span>`;
  return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:11.5px;color:var(--fg-55)">
    ${item("done", "Done")}${item("active", "In progress")}${item("upcoming", "Upcoming")}${item("overdue", "Overdue")}
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:2px;height:11px;background:var(--red);flex:none"></span>Today</span>
  </div>`;
}

function summaryStrip(sum: TimelineSummary): string {
  const cell = (n: number, label: string, color: string) =>
    `<div style="min-width:0"><div style="font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.1;color:${color}">${n}</div><div style="${LABEL_FACE};font-size:9.5px;line-height:1.3;color:var(--fg-40);margin-top:4px">${esc(label)}</div></div>`;
  const counts = `<div class="tl-sum-cell">
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px">
        ${cell(sum.inProgress, "In progress", "var(--fg)")}
        ${cell(sum.upcoming, "Upcoming", "var(--fg)")}
        ${cell(sum.done, "Done", "var(--fg)")}
        ${cell(sum.overdue, "Overdue", sum.overdue > 0 ? "var(--red)" : "var(--fg-40)")}
      </div>
      ${sum.unscheduled ? `<div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">+ ${sum.unscheduled} unscheduled</div>` : ""}
    </div>`;
  const nextBody = sum.next
    ? `<button data-act="openSprint" data-arg="${sum.next.id}" class="mw-more" style="display:block;text-align:left;padding:0;min-width:0;max-width:100%">
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.015em;color:var(--fg)">${esc(dayLabel(sum.next.due))} <span style="font-size:12.5px;font-weight:500;color:var(--fg-55)">${sum.next.inDays === 0 ? "today" : `in ${sum.next.inDays}d`}</span></div>
        <div style="font-size:12.5px;color:var(--fg-70);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sum.next.label)}</div>
      </button>`
    : `<div style="font-size:13px;color:var(--fg-40);margin-top:2px">Nothing due ahead</div>`;
  const next = `<div class="tl-sum-cell"><div style="${LABEL_FACE};font-size:9.5px;color:var(--fg-40);margin-bottom:6px">Next due</div>${nextBody}</div>`;
  const t = sum.tickets;
  const ticketBody = t.total > 0
    ? `<div style="font-size:18px;font-weight:600;letter-spacing:-0.015em;color:var(--fg)">${t.closed}/${t.total} <span style="font-size:12.5px;font-weight:500;color:var(--fg-55)">${t.pct}%</span></div>
       <div style="height:4px;border-radius:2px;background:var(--hover);overflow:hidden;margin-top:8px"><div class="tl-sumfill" style="height:100%;width:${t.pct}%;background:var(--accent)"></div></div>`
    : `<div style="font-size:13px;color:var(--fg-40);margin-top:2px">No tickets in a scheduled sprint yet</div>`;
  const tickets = `<div class="tl-sum-cell"><div style="${LABEL_FACE};font-size:9.5px;color:var(--fg-40);margin-bottom:6px">Tickets done · scheduled sprints</div>${ticketBody}</div>`;
  return `<div class="tl-sum" style="border:1px solid var(--border);border-radius:8px">${counts}${next}${tickets}</div>`;
}

function unscheduledList(items: SprintView[], confirmed: Record<string, boolean>, now: number): string {
  if (items.length === 0) return "";
  const chips = items.map((sp) => {
    const state = stateOf(sp, confirmed, now);
    const count = sp.progress.total > 0 ? `<span style="font-size:11px;color:var(--fg-40);font-family:var(--label)">${sp.progress.closed}/${sp.progress.total}</span>` : "";
    return `<button class="tl-unsched" data-act="openSprint" data-arg="${sp.id}" style="display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:5px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface);font-size:12.5px;color:var(--fg-70)">${dot(STATE_COLOR[state])}<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(sp.label)}</span>${count}</button>`;
  }).join("");
  return `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
    <div style="${LABEL_FACE};color:var(--fg-40);margin-bottom:8px">Unscheduled · no due date</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
  </div>`;
}

/** The graph as shapes: the axis band, then `n` rows (a sprint's name, its bar somewhere along the
 *  calendar) — ONE builder for the Timeline's loading skeleton (render.ts) and its empty layout. */
export function timelineShapes(n: number): string {
  const row = (i: number) => `<div style="display:grid;grid-template-columns:200px minmax(0,1fr);gap:16px;align-items:center;height:44px;padding:0 18px${i ? ";border-top:1px solid var(--border)" : ""}">${skBar(skW(i, [120, 150, 96, 136]), 10)}<span style="display:block;padding-left:${[6, 22, 38, 14, 46, 30][i % 6]}%">${skBox(skW(i, ["34%", "26%", "42%", "30%"]), 16)}</span></div>`;
  return skCard(`<div style="height:38px;border-bottom:1px solid var(--border)"></div>${skList(n, row)}`, "overflow:hidden");
}
/** The Timeline's empty sentence (no sprint exists). The header above it already says what a bar is. */
export const TIMELINE_EMPTY = "No sprints yet. Each one is drawn here as a bar once it has a due date.";

/** Roadmap › Timeline: the header, the summary strip and the Gantt graph of the plan's sprints. */
export function roadmapTimeline(p: TimelineProps): string {
  const placed = p.sprints
    .map((sp) => placeSprint(sp, p.confirmed, p.now))
    .filter((x): x is Placed => x !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.sp.id - b.sp.id);
  const drawn = new Set(placed.map((x) => x.sp.id));
  const unscheduled = p.sprints.filter((sp) => !drawn.has(sp.id));

  const header = `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;margin-bottom:16px">
      <div style="min-width:0">
        <div style="font-size:11.5px;font-weight:500;color:var(--fg-40)">Timeline</div>
        <h1 style="font-size:18px;font-weight:500;letter-spacing:-0.015em;margin:4px 0 4px">Sprints on the calendar</h1>
        <div style="font-size:13px;line-height:1.55;color:var(--fg-55)">Each bar runs from a sprint's start to its due date, filled by its done tickets. Hover for detail, click to open.</div>
      </div>
      ${placed.length ? legend() : ""}
    </div>`;

  let graph: string;
  if (p.sprints.length === 0) {
    graph = emptyLayout("roadmap-timeline", { text: TIMELINE_EMPTY, action: { label: "New sprint", act: "nsToggle" }, sayStyle: "margin-bottom:12px", shapes: timelineShapes(4) });
  } else if (placed.length === 0) {
    graph = `<div style="border:1px dashed var(--border-strong);border-radius:10px;padding:14px 16px;font-size:13px;color:var(--fg-55)">No sprint has a due date yet, so there is nothing to place on the calendar.</div>`;
  } else {
    const first = Math.min(...placed.map((x) => x.start));
    const last = Math.max(...placed.map((x) => x.end + DAY));
    const today = todayKey(p.now);
    const showToday = today >= first - TODAY_REACH_DAYS * DAY && today < last + TODAY_REACH_DAYS * DAY;
    const axis = buildAxis(showToday ? Math.min(first, today) : first, showToday ? Math.max(last, today + DAY) : last);
    const at = (t: number) => (t - axis.min) / (axis.max - axis.min);
    const todayAt = at(today + DAY / 2); // the middle of today's column

    const majors = axis.major
      // A sliver of a month/year at either end gets its band and line, not a clipped label.
      .filter((m) => at(m.to) - at(m.from) >= 0.06)
      .map((m) => `<span class="tl-major" style="left:${pct(at(m.from))};width:${pct(at(m.to) - at(m.from))}">${esc(m.label)}</span>`)
      .join("");
    const minors = axis.minor
      // A label past ~96% would run off the track's right edge — the gridline stays.
      .filter((t) => t.label && at(t.t) <= 0.96)
      .map((t) => `<span class="tl-tick${t.alt ? " tl-alt" : ""}" style="left:${pct(at(t.t))}">${esc(t.label!)}</span>`)
      .join("");
    const todayTag = showToday
      ? `<span class="tl-todaytag" style="left:clamp(0px, calc(${pct(todayAt)} - 22px), calc(100% - 44px));border-radius:4px">Today</span>`
      : "";
    const bands = axis.major
      .map((m, i) => (i % 2 === 1 ? `<span class="tl-band" style="left:${pct(at(m.from))};width:${pct(at(m.to) - at(m.from))}"></span>` : ""))
      .join("");
    const majorStarts = new Set(axis.major.map((m) => m.from));
    const lines = [
      ...axis.minor.filter((t) => !majorStarts.has(t.t)).map((t) => `<span class="tl-grid" style="left:${pct(at(t.t))}"></span>`),
      ...axis.major.filter((m) => m.from > axis.min).map((m) => `<span class="tl-grid tl-grid--major" style="left:${pct(at(m.from))}"></span>`),
    ].join("");
    const todayLine = showToday ? `<span class="tl-today" style="left:${pct(todayAt)}"></span>` : "";

    // The lower half of the rows opens its popover upward, so the last rows'
    // popovers stay inside the graph instead of hanging off the card's bottom.
    const n = placed.length;
    let idx = 0;
    const lanes = LANES.map((lane) => {
      const items = placed.filter((x) => x.lane === lane.id);
      if (items.length === 0) return "";
      const rows = items.map((x) => {
        const i = idx++;
        return row(x, axis, p.persons, p.now, n >= 3 && i >= Math.ceil(n / 2), i);
      }).join("");
      return `<div class="tl-lane" data-lane="${lane.id}"><span class="tl-lanelab">${dot(lane.color)}${esc(lane.label)}<span style="color:var(--fg-40);font-weight:500">${items.length}</span></span></div>${rows}`;
    }).join("");

    graph = `<div class="tl-graph">
      <div class="tl-row tl-head"><div class="tl-lab" aria-hidden="true"></div><div class="tl-axis">${majors}${minors}${todayTag}</div></div>
      <div class="tl-body">
        <div class="tl-layer" aria-hidden="true">${bands}${lines}${todayLine}</div>
        ${lanes}
      </div>
    </div>`;
  }

  return `<section${surface("min-width:0;padding:18px 20px 20px", { cls: "cnpy-rise tl-card" })} data-screen-label="Roadmap · Timeline">
    ${header}
    ${p.sprints.length ? summaryStrip(timelineSummary(p.sprints, p.confirmed, p.now)) : ""}
    ${graph}
    ${unscheduledList(unscheduled, p.confirmed, p.now)}
  </section>`;
}
