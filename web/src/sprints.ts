// Sprints surface — componentized from `Canopy Tickets.dc.html` (the locked
// design): the Roadmap Timeline's sprint cards (design 770–805), the New sprint
// panel (design 156–197) and the Sprint screen (design 490–571).
//
// Same contract as tickets.ts / review.ts / maintenance.ts: every function here
// is PURELY presentational. Data arrives through props, output is an HTML string
// in the app's template-string idiom (inline styles over the trov.css custom
// properties), and interactions dispatch through data-act / data-arg handled in
// main.ts. No fetching, no state, no inline data.
//
// A sprint is the container the Roadmap shows; its progress is `closed/total`
// over the sprint's TICKETS ONLY (closed = done + declined) — computed
// server-side (src/tools/sprints.ts `sprintProgress`) and read off
// `SprintView.progress` here. Nothing is recomputed in the browser. The cached
// GitHub issue counts (`SprintView.issues`) are NOT shown on these surfaces;
// they appear only in the Roadmap's Narrative spotlight (web/src/render.ts).

import type {
  SprintView, SprintDetail, SprintUrgency, SprintDomain, SprintResourceView, SprintTicketRow,
} from "@shared/sprints";
import { SPRINT_URGENCIES, SPRINT_DOMAINS, sprintDueState, sprintDatesLabel } from "@shared/sprints-core";
import type { PersonSummary } from "./api";
import { esc, attr, DETAIL_SHELL, SURFACE, surface, hitArea, HITBOX } from "./ui";
import { personChip, personLink } from "./people";
import { renderMarkdown } from "./markdown";
import { segmented } from "./segmented";
import { ticketPill, priorityChip, age, avatarStack, tagChip } from "./tickets";
import { emptyLayout, skeleton, skBar, skBox, skLine, skLines, skList, skW } from "./skeleton";

// ── atoms ────────────────────────────────────────────────────────────────────

/** The design's `tagBase` — the label-face chip every sprint tag is drawn from. */
const TAG_BASE =
  "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 7px;white-space:nowrap;flex:none;";
/** The design's `tint(c)` — colored text, 45% border, 12% fill. */
const tint = (c: string): string =>
  `${TAG_BASE}color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;

const tag = (text: string, style: string): string => `<span style="${style}">${esc(text)}</span>`;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The design's due strings are short and shouty ("SEP 26"); the DTO carries an
 *  ISO date. Anything unparseable falls through uppercased rather than showing
 *  "Invalid Date". */
export function shortDue(due: string): string {
  const m = due.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return due.toUpperCase();
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** The long date label the Roadmap has always shown ("Sep 1, 2026"). */
function longDate(due: string): string {
  const d = new Date(`${due}T12:00:00`);
  return Number.isNaN(d.getTime()) ? due : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function person(persons: PersonSummary[], handle: string): PersonSummary | null {
  return persons.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}
const nameOf = (persons: PersonSummary[], handle: string): string => person(persons, handle)?.name || handle;
const firstNameOf = (persons: PersonSummary[], handle: string): string => nameOf(persons, handle).split(" ")[0];

/**
 * The design's `sprTagsOf`: exactly one urgency tag (▲ HIGH amber / NORMAL /
 * LOW muted), then DUE when the sprint has a due date, then the DOMAIN in blue.
 * The order is load-bearing — it is the card's reading order.
 */
export function sprintTags(sp: Pick<SprintView, "urgency" | "due" | "domain">): string {
  const tags: string[] = [];
  if (sp.urgency === "high") tags.push(tag("▲ HIGH", tint("var(--amber)")));
  else if (sp.urgency === "low") tags.push(tag("LOW", `${TAG_BASE}color:var(--fg-40);border:1px solid var(--border)`));
  else tags.push(tag("NORMAL", `${TAG_BASE}color:var(--fg-55);border:1px solid var(--border)`));
  if (sp.due) tags.push(tag(`DUE ${shortDue(sp.due)}`, `${TAG_BASE}color:var(--fg-55);border:1px solid var(--border-strong)`));
  if (sp.domain) tags.push(tag(sp.domain.toUpperCase(), tint("var(--blue)")));
  return tags.join("");
}

/** The lead block: avatar + first name + " · lead", one chip that opens the lead's person
 *  card. Hidden (empty) with no lead. */
function leadBlock(lead: string | null, persons: PersonSummary[]): string {
  if (!lead) return "";
  return `<span style="display:inline-flex;flex:none">${personLink(person(persons, lead), lead, 18, `${firstNameOf(persons, lead)} · lead`, "font-size:11px;font-weight:500;color:var(--fg-55);white-space:nowrap", 6)}</span>`;
}

const NEXT_UP_STYLE =
  "font-size:9.5px;font-weight:700;font-family:var(--label);letter-spacing:.06em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);border-radius:5px;padding:1px 6px";
const OVERDUE_STYLE =
  "font-size:9.5px;font-weight:700;font-family:var(--label);letter-spacing:.06em;color:var(--red);border:1px solid color-mix(in srgb,var(--red) 45%,transparent);border-radius:5px;padding:1px 6px";

// ── the Roadmap Timeline card ────────────────────────────────────────────────

export interface SprintCardOpts {
  /** Treat the sprint as done although the server still says otherwise — the
   *  Confirm-done click is optimistic (`AppState.confirmedSprints`). */
  done?: boolean;
  /** This is THE next sprint (`nextSprintId`) — the one card that says NEXT UP. */
  nextUp?: boolean;
  /** The clock (ms), injected for tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * THE next sprint, the one that earns NEXT UP: among sprints not done (by status
 * or a confirm this session) and not yet running, the earliest due date that is
 * not past by the shared rule (`sprintDueState` — due today still counts). An
 * unscheduled sprint is never next; a tie goes to the earlier in the list. null
 * when nothing qualifies.
 */
export function nextSprintId(sprints: SprintView[], confirmed: Record<string, boolean>, now: number): number | null {
  let best: { id: number; left: number } | null = null;
  for (const sp of sprints) {
    if (sp.status === "done" || confirmed[String(sp.id)] || sp.active) continue;
    const due = sprintDueState(sp.due, now);
    if (!due || due.overdue) continue;
    if (!best || due.daysLeft < best.left) best = { id: sp.id, left: due.daysLeft };
  }
  return best ? best.id : null;
}

/**
 * One sprint as the Roadmap Timeline shows it (design 770–805): label, the
 * NEXT UP badge on the one next sprint (`opts.nextUp`), the urgency/DUE/DOMAIN tags, the
 * lead, the summary, "phase · dates", the progress bar with "closed/total done",
 * the member avatars and "Open sprint →".
 *
 * Everything is derived from the view, so the card is the same on every surface.
 * The date note is the sprint's real span when it has a `start` ("oct 6 – 17",
 * `sprintDatesLabel`), else the human range the admin authored in `dates`
 * ("SEP 8 – 19"); with neither, the card falls back to the Roadmap's own date note
 * (Due / Was due … overdue / Completed by), which is what the plan has always shown.
 *
 * A sprint whose bar is full but which nobody has confirmed gets the
 * "ready to complete" row + Confirm-done button — completion is a HUMAN act,
 * never inferred from the counts (§A: "Done … set by a person").
 */
export function sprintCard(sp: SprintView, persons: PersonSummary[], opts: SprintCardOpts = {}): string {
  const done = opts.done ?? sp.status === "done";
  const counted = sp.progress.total > 0;
  const ready = !done && counted && sp.progress.closed >= sp.progress.total;
  // Overdue from the calendar day AFTER the due date — the ONE rule, shared/sprints-core.
  const overdue = !done && !ready && !!sprintDueState(sp.due, opts.now ?? Date.now())?.overdue;
  // NEXT UP marks the single next sprint (`nextSprintId`, decided by the caller),
  // never every card that is not yet running.
  const nextUp = !done && !sp.active && !!opts.nextUp;

  const dateLabel = sp.due ? longDate(sp.due) : "No target date";
  const fallbackNote = done
    ? `Completed by ${dateLabel}`
    : overdue
      ? `Was due ${dateLabel} — overdue`
      : `Due ${dateLabel}`;
  const span = sprintDatesLabel(sp);
  const dateNote = [sp.phase, span ? span.toLowerCase() : fallbackNote]
    .filter((v): v is string => !!v)
    .join(" · ");

  const barColor = done ? "var(--green)" : overdue ? "var(--red)" : "var(--accent)";
  const bar = counted
    ? `<div style="display:flex;align-items:center;gap:10px;margin-top:11px">
        <div style="flex:1;height:5px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;border-radius:999px;width:${sp.progress.pct}%;background:${barColor}"></div></div>
        <span style="font-size:11px;color:var(--fg-40);font-family:var(--label);white-space:nowrap;flex:none">${sp.progress.closed}/${sp.progress.total} done</span>
      </div>`
    : "";

  const readyRow = ready
    ? `<div style="display:flex;align-items:center;gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--accent);flex:1"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6 9 17l-5-5"></path></svg><span style="color:var(--fg-70)">Every ticket and issue in this sprint is closed — <strong style="color:var(--fg);font-weight:600">ready to complete</strong>.</span></div>
        <button data-act="confirmSprint" data-arg="${sp.id}" class="cnpy-accentbtn" style="flex:none;display:inline-flex;align-items:center;gap:7px;padding:7px 15px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600">Confirm done</button>
      </div>`
    : "";

  return `<div${surface("padding:14px 16px;margin-bottom:8px")}>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
      <span style="font-size:14.5px;font-weight:600;letter-spacing:-0.01em">${esc(sp.label)}</span>
      ${nextUp ? `<span style="${NEXT_UP_STYLE}">NEXT UP</span>` : ""}
      ${overdue ? `<span style="${OVERDUE_STYLE}">OVERDUE</span>` : ""}
      <span style="flex:1"></span>
      ${sprintTags(sp)}
      ${leadBlock(sp.lead, persons)}
    </div>
    ${sp.summary ? `<p style="font-size:13px;line-height:1.65;color:var(--fg-70);margin:0 0 8px">${esc(sp.summary)}</p>` : ""}
    <span style="font-size:11.5px;color:var(--fg-40);font-family:var(--label)">${esc(dateNote)}</span>
    ${bar}
    <div style="display:flex;align-items:center;gap:10px;margin-top:11px;padding-top:10px;border-top:1px solid var(--border)">
      ${avatarStack(sp.members, persons, 20, true)}
      <span style="flex:1"></span>
      <button data-act="openSprint" data-arg="${sp.id}" class="cnpy-link" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--accent);white-space:nowrap">Open sprint<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
    </div>
    ${readyRow}
  </div>`;
}

// ── the New sprint panel (design 156–197) ────────────────────────────────────

/** The panel's `ns*` slice of AppState, passed whole. */
export interface NewSprintState {
  open: boolean;
  name: string;
  /** `<input type="date">` values: "" or YYYY-MM-DD. */
  start: string;
  desc: string;
  urgency: SprintUrgency;
  due: string;
  lead: string | null;
  domain: SprintDomain | null;
  /** The date refusal to show under the dates (`sprintDatesProblem`, set on Create), or null. */
  error: string | null;
}

const NS_LABEL = "display:block;font-size:12.5px;font-weight:500;margin-bottom:7px";
const NS_INPUT =
  "width:100%;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:13px;outline:none";
/** A native date field on the same box. `cnpy-date` (trov.css) sets `color-scheme`
 *  to the app's theme so the browser's own picker and calendar icon are dark in dark. */
const nsDateInput = (arg: "start" | "due", value: string, label: string, invalid: boolean): string =>
  `<input type="date" class="cnpy-date" data-act="nsField" data-arg="${arg}" data-field="ns-${arg}" value="${attr(value)}" aria-label="${attr(label)}"${invalid ? ` aria-invalid="true" aria-describedby="ns-date-error"` : ""} style="${NS_INPUT};font-family:inherit;${invalid ? "border-color:var(--red);" : ""}" />`;
const chipStyle = (on: boolean) =>
  `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}`;
/** The chip hover hook (trov.css), exactly as the ticket form uses it: the
 *  picked chip is painted inline and carries `is-on`, so the hover rule only firms
 *  up the ones that are NOT the current choice. (Urgency is the shared `segmented()`.) */
const chipClass = (on: boolean) => `cnpy-pickchip${on ? " is-on" : ""}`;

/**
 * The New sprint panel. Closed → renders NOTHING (the toggle lives in the
 * Roadmap's Timeline header, next to the section intro). "Create sprint" is
 * inert until the sprint has a name — the only required field, exactly like the
 * new-ticket form's title (and `POST /sprints` enforces the same rule).
 * Lead and Codebase domain are single-choice chips that toggle OFF when the
 * current pick is clicked again (the design's `s.nsLead === l ? null : l`).
 *
 * Start and Due are native date fields (both optional); main.ts checks them with the
 * ONE sprint-date rule (`sprintDatesProblem`) before it submits, and a refusal shows
 * here, under the dates. There is no free-text "Dates" label any more: every surface
 * derives the span from start/due (`sprintDatesLabel`); `dates` stays on the model for
 * sprints the plan write authored.
 */
export function newSprintPanel(s: NewSprintState, persons: PersonSummary[]): string {
  if (!s.open) return "";
  const canCreate = s.name.trim().length > 0;

  const urgSeg = segmented({
    id: "ns-urgency", ariaLabel: "Urgency", act: "nsUrg", value: s.urgency, size: "sm",
    options: SPRINT_URGENCIES.map((u) => ({ value: u, label: u.charAt(0).toUpperCase() + u.slice(1) })),
  });

  const leadChips = persons.map((p) =>
    `<button data-act="nsLead" data-arg="${attr(p.handle)}" class="${chipClass(s.lead === p.handle)}" style="display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:7px;font-size:12.5px;font-weight:500;transition:all .12s ease;border:1px solid ${s.lead === p.handle ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}">${personChip(p, 20, p.handle)}${esc(p.name || p.handle)}</button>`).join("");

  const domChips = SPRINT_DOMAINS.map((d) =>
    `<button data-act="nsDom" data-arg="${d}" class="${chipClass(s.domain === d)}" style="${chipStyle(s.domain === d)};font-family:var(--label)">${d}</button>`).join("");

  const createStyle = canCreate
    ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent"
    : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default";

  return `<div${surface("padding:18px 20px;margin:14px 0 6px")}>
    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:end">
      <div style="min-width:0">
        <label style="${NS_LABEL}">Sprint name</label>
        <input data-act="nsField" data-arg="name" data-field="ns-name" value="${attr(s.name)}" placeholder="Sprint 14" style="${NS_INPUT}" />
      </div>
      <div>
        <label style="${NS_LABEL}">Urgency</label>
        ${urgSeg}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:15px">
      <div style="min-width:0">
        <label style="${NS_LABEL}">Start date <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
        ${nsDateInput("start", s.start, "Start date", !!s.error)}
      </div>
      <div style="min-width:0">
        <label style="${NS_LABEL}">Due date <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
        ${nsDateInput("due", s.due, "Due date", !!s.error)}
      </div>
    </div>
    <div id="ns-date-error" data-ns-error role="alert" style="font-size:12px;color:var(--red);margin-top:7px${s.error ? "" : ";display:none"}">${esc(s.error ?? "")}</div>
    <label style="${NS_LABEL};margin:15px 0 7px">Goal <span style="font-weight:400;color:var(--fg-40)">— what this sprint is for</span></label>
    <input data-act="nsField" data-arg="desc" data-field="ns-desc" value="${attr(s.desc)}" placeholder="One sentence describing the sprint's goal" style="${NS_INPUT}" />
    <label style="${NS_LABEL};margin:15px 0 7px">Lead</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${leadChips}</div>
    <label style="${NS_LABEL};margin:15px 0 7px">Codebase domain</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${domChips}</div>
    <div style="font-size:11.5px;color:var(--fg-40);margin-top:12px">Sprints are the roadmap — a new sprint appears on the Roadmap timeline automatically.</div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
      <button data-act="nsToggle" class="cnpy-outlinebtn" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Cancel</button>
      <button data-act="nsCreate" style="border-radius:8px;padding:7px 15px;font-size:12.5px;font-weight:600;${createStyle}">Create sprint</button>
    </div>
  </div>`;
}

/** The "New sprint" toggle button — the Timeline header affordance the panel opens from. */
export function newSprintToggle(open: boolean): string {
  return `<button data-act="nsToggle" style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;border:1px solid ${open ? "var(--border-strong)" : "var(--border)"};color:${open ? "var(--fg)" : "var(--fg-70)"};white-space:nowrap;flex:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>New sprint</button>`;
}

// ── the Sprint screen (design 490–571) ───────────────────────────────────────

const PROP_ROW = "display:grid;grid-template-columns:74px 1fr;gap:10px;align-items:center;height:30px";
const PROP_LABEL = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)";
const PROP_CHIP =
  "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-55);border:1px solid var(--border-strong);border-radius:5px;padding:2px 6px;white-space:nowrap";
const RAIL_EYEBROW =
  "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";
const ACTIVE_CHIP =
  "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:var(--accent-soft);border-radius:5px;padding:2px 7px;white-space:nowrap";

/** The resource-chip icons — the SAME three the ticket detail's linked-work chips use. */
const RESOURCE_ICON: Record<string, string> = {
  github: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`,
  figma: `<svg width="12" height="17" viewBox="0 0 38 57" aria-hidden="true"><path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"></path><path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"></path><path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"></path><path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"></path><path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"></path></svg>`,
  plain: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>`,
};
/** Defense in depth: a stored resource url must be http(s) before it reaches an href. */
const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

function resourceRow(lk: SprintResourceView): string {
  return `<a href="${attr(safeHref(lk.url))}" target="_blank" rel="noopener"${surface("display:flex;align-items:center;gap:9px;padding:7px 10px;text-decoration:none", { hover: true })}>
    <span style="flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-70);background:color-mix(in srgb,var(--fg) 6%,transparent)">${RESOURCE_ICON[lk.kind] ?? RESOURCE_ICON.plain}</span>
    <span style="min-width:0;flex:1">
      <span style="display:block;font-size:12px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(lk.label)}</span>
      <span style="display:block;font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px;white-space:nowrap">${esc(lk.meta)}</span>
    </span>
  </a>`;
}

/** One ticket row. `depth: 1` = a child under its root: indented 34px with the ↳ chevron.
 *  The assignee avatars sit between the title and the chips (design 514). */
/**
 * One ticket on the Sprint screen, as a BOX in a grid (not a table row): number +
 * category + status across the top, the title (two lines at most), then who has
 * it, its priority and its age along the bottom. The order is still roots-then-
 * children, and a sub-ticket names its parent ("↳ sub-ticket of #N") since a grid
 * cannot show nesting by indent. A closed ticket (done / declined) is dimmed. A
 * `hitArea` card, so an assignee's photo opens their person card.
 */
function sprintTicketCard(t: SprintTicketRow, persons: PersonSummary[]): string {
  const closed = t.status === "done" || t.status === "declined";
  const who = t.assignees.length > 0
    ? avatarStack(t.assignees, persons, 20, true)
    : `<span style="font-size:11.5px;font-style:italic;color:var(--fg-40)">Unassigned</span>`;
  return `<div class="cnpy-tcard ${SURFACE} ${HITBOX}" style="display:flex;flex-direction:column;gap:10px;min-width:0;min-height:132px;text-align:left;padding:14px 15px 13px;${closed ? "opacity:.6;" : ""}">
    <div style="display:flex;align-items:center;gap:8px;width:100%;min-width:0">
      <span style="font-family:var(--label);font-size:11px;color:var(--fg-40);flex:none">#${t.id}</span>
      ${tagChip(t.category)}
      <span style="margin-left:auto;flex:none">${ticketPill(t.status)}</span>
    </div>
    <div style="width:100%;min-width:0">
      <div style="font-size:13.5px;font-weight:600;line-height:1.4;letter-spacing:-0.005em;color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(t.title)}</div>
      ${t.depth === 1 && t.parent_id !== null ? `<div style="font-size:11.5px;color:var(--fg-40);margin-top:4px">↳ sub-ticket of #${t.parent_id}</div>` : ""}
    </div>
    <div style="display:flex;align-items:center;gap:8px;width:100%;margin-top:auto">
      ${who}
      <span style="margin-left:auto;flex:none">${priorityChip(t.priority)}</span>
      <span style="font-size:11.5px;color:var(--fg-40);font-family:var(--label);flex:none">${esc(age(t.created_at))}</span>
    </div>
    ${hitArea("openTicket", String(t.id), `#${t.id} ${t.title}`)}
  </div>`;
}

export interface SprintScreenProps {
  detail: SprintDetail;
  persons: PersonSummary[];
  /** The Resources rail's "Add a URL…" draft (shared with the ticket detail's link draft). */
  resourceDraft: string;
  /** "Delete sprint" was clicked once — the rail shows the inline confirm instead. */
  deleteArmed?: boolean;
}

/**
 * The Sprint screen: the sprint's own page, reached from a Roadmap card's
 * "Open sprint →" or from a queue group header. Two columns — the ticket list on
 * the left under the title/description/progress, the properties + assignees +
 * resources rail on the right (design 490–571).
 *
 * The description is MARKDOWN (§C.5: "becomes markdown" is a render-side change),
 * so it goes through renderMarkdown — the same sanitizing pipeline doc bodies and
 * the plan narrative use — and is never interpolated raw.
 *
 * "Mark active / Mark inactive" is the human control behind
 * `POST /sprints/:id/active`; `done` is NEVER set here (§C.6 — the plan write or
 * the Roadmap's Confirm-done own that).
 */
/**
 * The rail's last block: a quiet "Delete sprint" that arms an inline confirm
 * (never a browser dialog). The confirm names what happens to the tickets —
 * they move to the backlog, they are not deleted.
 */
function deleteBlock(sp: SprintDetail, armed: boolean): string {
  const n = sp.tickets.length;
  if (!armed) {
    return `<div style="margin-top:28px;padding-top:14px;border-top:1px solid var(--border)"><button data-act="sprintDeleteArm" style="font-size:12px;font-weight:500;color:var(--red)">Delete sprint</button></div>`;
  }
  const fate = n === 0
    ? "It has no tickets."
    : `Its ${n} ticket${n === 1 ? "" : "s"} move${n === 1 ? "s" : ""} to the backlog — nothing else is deleted.`;
  return `<div style="margin-top:28px;padding-top:14px;border-top:1px solid var(--border)">
    <div style="font-size:12px;line-height:1.5;color:var(--fg-70);margin-bottom:10px">Delete <strong style="color:var(--fg);font-weight:600">${esc(sp.label)}</strong> for good? ${fate}</div>
    <div style="display:flex;gap:7px">
      <button data-act="sprintDelete" style="padding:5px 12px;border-radius:7px;background:var(--red);color:#fff;font-size:12px;font-weight:600">Delete</button>
      <button data-act="sprintDeleteCancel" class="cnpy-outlinebtn" style="padding:5px 12px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70)">Cancel</button>
    </div>
  </div>`;
}

/** The sprint page while its read is out: title, progress bar, the ticket grid and
 *  the rail, on the sprint page's own grid. */
/** One ticket card of the sprint page as a shape — the loading skeleton's and the empty layout's. */
const sprintTicketShape = (i: number): string => `<div${surface("padding:12px 13px")}>${skLines([skW(i), "44%"], 13.5, 1.45)}<div style="display:flex;align-items:center;gap:6px;margin-top:10px">${skBar(52, 8)}<span style="margin-left:auto;display:flex">${skBox(18, 18)}</span></div></div>`;
/** A sprint with no tickets: what goes here, and where they come from. */
export const SPRINT_TICKETS_EMPTY = "No tickets in this sprint yet. Move some in from the queue's sprint picker.";

export function sprintSkeleton(): string {
  const card = sprintTicketShape;
  const prop = (w: number) => `<div style="${PROP_ROW}">${skBar(44, 8)}${skBar(w, 10)}</div>`;
  return skeleton("sprint", "Loading the sprint&hellip;", `<div class="cnpy-sprint-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:28px">
      <div style="min-width:0">
        ${skLine("46%", 22, 1.3)}
        <div style="margin-top:9px">${skLine(120, 12, 1.5)}</div>
        <div style="max-width:640px;margin-top:14px">${skLines(["100%", "92%", "60%"], 13.5, 1.65)}</div>
        <div style="display:flex;align-items:center;gap:12px;margin:16px 0 26px">${skBar("100%", 6, "flex:1")}${skBar(54, 8)}</div>
        <div style="padding-bottom:9px;border-bottom:1px solid var(--border-strong)">${skLine(160, 11, 1.5)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:10px;margin-top:14px">${skList(6, card)}</div>
      </div>
      <div style="border-left:1px solid var(--border);padding-left:22px">${skBar(70, 8, "margin-bottom:14px")}${prop(70)}${prop(96)}${prop(60)}${prop(84)}<div style="margin-top:26px">${skBar(70, 8)}</div>${skList(3, (i) => `<div style="display:flex;align-items:center;gap:9px;padding:4px 0;margin-top:${i ? 6 : 12}px">${skBox(22, 22)}${skBar(skW(i, [110, 84, 96]), 10)}</div>`)}</div>
    </div>`, DETAIL_SHELL);
}

export function sprintScreen(p: SprintScreenProps): string {
  const sp = p.detail;
  const activeChip = sp.active ? `<span style="${ACTIVE_CHIP}">ACTIVE</span>` : "";
  const activeBtn = sp.status === "done"
    ? ""
    : `<button data-act="sprintActive" data-arg="${sp.active ? "0" : "1"}" class="cnpy-outlinebtn" style="padding:4px 11px;border-radius:7px;border:1px solid var(--border-strong);font-size:11.5px;font-weight:500;color:var(--fg-70);flex:none">${sp.active ? "Mark inactive" : "Mark active"}</button>`;

  const tickets = sp.tickets.length > 0
    ? `<div class="cnpy-stagger" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:10px;margin-top:14px">${sp.tickets.map((t) => sprintTicketCard(t, p.persons)).join("")}</div>`
    : emptyLayout("sprint-tickets", { text: SPRINT_TICKETS_EMPTY, action: { label: "Open the queue", act: "goTickets" }, contents: true,
        style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:10px;margin-top:14px", shapes: skList(2, sprintTicketShape) });

  const members = sp.members.length > 0
    ? `<div style="display:flex;flex-direction:column;gap:6px">${sp.members.map((h) =>
        `<div style="display:flex;min-width:0;padding:4px 0">${personLink(person(p.persons, h), h, 22, nameOf(p.persons, h), "min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", 9)}</div>`).join("")}</div>`
    : "";

  const resources = sp.resources.length > 0
    ? `<div style="display:flex;flex-direction:column;gap:7px;margin-bottom:10px">${sp.resources.map(resourceRow).join("")}</div>`
    : "";

  const prop = (label: string, cell: string) =>
    `<div style="${PROP_ROW}"><div style="${PROP_LABEL}">${label}</div><div>${cell}</div></div>`;

  return `<div style="${DETAIL_SHELL}">
    <div class="cnpy-sprint-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:28px">
      <div style="min-width:0">
        <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(sp.label)}</h2>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:9px;font-size:12px;color:var(--fg-55)">
          ${activeChip}
          ${activeBtn}
          ${sp.phase ? `<span style="color:var(--fg-40);white-space:nowrap">${esc(sp.phase)}</span>` : ""}
        </div>
        ${sp.description
          ? `<div class="cnpy-md" style="font-size:13.5px;line-height:1.65;color:var(--fg-70);max-width:640px;margin-top:14px">${renderMarkdown(sp.description)}</div>`
          : sp.summary
            ? `<div style="font-size:13.5px;line-height:1.65;color:var(--fg-70);max-width:640px;margin-top:14px">${esc(sp.summary)}</div>`
            : ""}
        <div style="display:flex;align-items:center;gap:12px;margin:16px 0 26px">
          <div style="flex:1;height:6px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;border-radius:999px;width:${sp.progress.pct}%;background:var(--accent)"></div></div>
          <span style="font-size:11.5px;color:var(--fg-55);font-family:var(--label);white-space:nowrap;flex:none">${sp.progress.closed}/${sp.progress.total} done</span>
        </div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;padding-bottom:9px;border-bottom:1px solid var(--border-strong)">
          <div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55);white-space:nowrap;flex:none">TICKETS IN THIS SPRINT</div>
        </div>
        ${tickets}
      </div>
      <div style="border-left:1px solid var(--border);padding-left:22px">
        <div style="${RAIL_EYEBROW};margin-bottom:8px">Properties</div>
        <div style="display:flex;flex-direction:column">
          ${prop("DATES", `<span style="${PROP_CHIP}">${esc(sprintDatesLabel(sp) ?? "—")}</span>`)}
          ${prop("DUE", `<span style="${PROP_CHIP}">${esc(sp.due ? shortDue(sp.due) : "—")}</span>`)}
          ${prop("URGENCY", sprintTags({ urgency: sp.urgency, due: null, domain: null }))}
          ${prop("DOMAIN", sp.domain ? tag(sp.domain.toUpperCase(), tint("var(--blue)")) : `<span style="${PROP_CHIP}">—</span>`)}
          ${prop("LEAD", sp.lead
            ? `<div style="display:flex;min-width:0">${personLink(person(p.persons, sp.lead), sp.lead, 20, nameOf(p.persons, sp.lead), "min-width:0;font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis")}</div>`
            : `<span style="font-size:12.5px;color:var(--fg-40)">Unassigned</span>`)}
        </div>
        <div style="${RAIL_EYEBROW};margin:22px 0 8px">Assignees</div>
        ${members}
        <div style="font-size:11px;color:var(--fg-40);margin-top:8px;line-height:1.5">Everyone assigned to a ticket in this sprint.</div>
        <div style="${RAIL_EYEBROW};margin:22px 0 8px">Resources</div>
        ${resources}
        <div style="display:flex;gap:7px">
          <input data-act="sprintResourceDraft" data-field="sprint-resource" value="${attr(p.resourceDraft)}" placeholder="Add a URL…" style="flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:11.5px;font-family:var(--label);outline:none" />
          <button data-act="sprintResourceAdd" class="cnpy-outlinebtn" style="padding:0 11px;border-radius:8px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70);flex:none">Add</button>
        </div>
        <div style="font-size:11px;color:var(--fg-40);margin-top:8px;line-height:1.5">Sprint-level links plus everything linked from its tickets.</div>
        ${deleteBlock(sp, p.deleteArmed ?? false)}
      </div>
    </div>
  </div>`;
}
