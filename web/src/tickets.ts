// Tickets surface — componentized from `Canopy Tickets.dc.html` (the locked
// design): the queue (table + board), the new-ticket form, and the ticket detail.
//
// Every function here is PURELY presentational: data arrives through props and
// renders to an HTML string in the app's template-string idiom (inline styles
// over the trov.css custom properties). Interactions dispatch via
// data-act / data-arg, handled in main.ts. No fetching, no state, no inline data
// — same contract as review.ts / maintenance.ts.
//
// The status machine is NOT re-declared here: `legalMoves` / TICKET_STATUS_LABEL
// come from @shared/tickets-core, the one definition the routes enforce too.
// (Values are imported from `tickets-core` rather than `@shared/tickets` on
// purpose — the latter evaluates zod schemas at module load and would drag the
// whole of zod into the browser bundle. Types still come from @shared/tickets.)

import {
  legalMoves, isOpenStatus, TICKET_STATUSES, TICKET_STATUS_LABEL, TICKET_CATEGORIES, TICKET_PRIORITIES,
  sourceIssueNumber, boardOrder, OPEN_STATUSES,
  type TicketStatus, type TicketCategory, type TicketPriority, type TicketSource,
} from "@shared/tickets-core";
import type { TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter } from "@shared/tickets";
import type { SprintView } from "@shared/sprints";
import { sprintDatesLabel } from "@shared/sprints-core";
import type { PersonSummary } from "./api";
import { esc, attr, relTime, primaryBtn, WORK_SHELL, DETAIL_SHELL, SURFACE, surface, hitArea, HITBOX } from "./ui";
import { personChip, personLink, personAvatarLink, personNameLink } from "./people";
import { renderMarkdown } from "./markdown";
import { mentionCandidates, mentionPickerTop, COMMENT_BOX } from "./mentions";
import { searchFilterBar, type FilterMenuProps } from "./filter-menu";
import { segmented } from "./segmented";
import { dangerTrigger, confirmModal } from "./confirm";
import { skeleton, skBar, skBox, skLine, skLines, skList, skW, skProse } from "./skeleton";

// ── shared atoms ─────────────────────────────────────────────────────────────

/** The design's `pill()` / `prioSt()` base: label-face, 10px, bordered, non-shrinking. */
const CHIP_BASE =
  "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none;";

/** Tinted pill styling for one status — design call #5: Triage blue,
 *  In progress green (accent), Done muted, Declined red at reduced opacity. */
function ticketPillStyle(status: TicketStatus): string {
  const tint = (c: string) =>
    `${CHIP_BASE}color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;
  if (status === "in_progress") return tint("var(--accent)");
  if (status === "submitted") return tint("var(--blue)");
  if (status === "testing") return tint("var(--amber)");
  if (status === "done") return `${CHIP_BASE}color:var(--fg-55);border:1px solid var(--border-strong)`;
  return `${CHIP_BASE}color:var(--red);border:1px solid color-mix(in srgb,var(--red) 35%,transparent);opacity:.75`;
}

/** The status pill (design call #5). The ONE place a ticket status is painted. */
export function ticketPill(status: TicketStatus): string {
  return `<span style="${ticketPillStyle(status)}">${esc(TICKET_STATUS_LABEL[status].toUpperCase())}</span>`;
}

/** The priority chip — MONOCHROME by design call #5 (weight, not hue, carries it). */
export function priorityChip(p: TicketPriority): string {
  const st = p === "high"
    ? `${CHIP_BASE}color:var(--fg);border:1px solid var(--border-strong)`
    : p === "normal"
      ? `${CHIP_BASE}color:var(--fg-55);border:1px solid var(--border)`
      : `${CHIP_BASE}color:var(--fg-40);border:1px solid var(--border)`;
  return `<span style="${st}">${esc(p.toUpperCase())}</span>`;
}

/** A small label-face chip (category / sprint tag / relation marker). */
export function tagChip(
  text: string,
  opts: { color?: string; border?: string; size?: number; spacing?: string; pad?: string } = {}
): string {
  const { color = "var(--fg-40)", border = "var(--border)", size = 10, spacing = ".05em", pad = "2px 6px" } = opts;
  return `<span style="font-family:var(--label);font-size:${size}px;font-weight:600;letter-spacing:${spacing};color:${color};border:1px solid ${border};border-radius:5px;padding:${pad};white-space:nowrap;flex:none">${esc(text)}</span>`;
}

const categoryChip = (c: string) => tagChip(c, { color: "var(--fg-55)", border: "var(--border-strong)" });

/** The table's category and priority: plain text, no box — inside the table's one surface
 *  only the status pill (whose hue means something) keeps an outline. Priority stays
 *  MONOCHROME (design call #5): weight and tone, not hue. */
const tableCategory = (c: string) =>
  `<span style="font-size:12.5px;color:var(--fg-55);white-space:nowrap">${esc(c)}</span>`;
const tablePriority = (p: TicketPriority) =>
  `<span style="font-family:var(--label);font-size:10.5px;letter-spacing:.05em;white-space:nowrap;${p === "high" ? "font-weight:700;color:var(--fg)" : p === "normal" ? "font-weight:600;color:var(--fg-55)" : "font-weight:600;color:var(--fg-40)"}">${esc(p.toUpperCase())}</span>`;

/** The system requester of a mirrored ticket whose issue author maps to no person
 *  (0032). Not in the people directory, so it gets its own display name. */
const MIRROR_HANDLE = "github-webhook";

/** "GITHUB #214" on a ticket mirrored from a GitHub issue; nothing on a native one. */
export function sourceChip(t: { source: TicketSource; source_ref: string | null }): string {
  if (t.source !== "github") return "";
  const n = sourceIssueNumber(t.source_ref);
  return tagChip(n !== null ? `GitHub #${n}` : "GitHub", { size: 9.5, pad: "1px 6px" });
}

/** Short age from an ISO timestamp: "42m" / "6h" / "3d" (the design's `age()`).
 *  Distinct from ui.relTime, which is the "…ago" form used for timestamps. */
export function age(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Directory lookup for a stored handle (case-insensitive, like personFor in render.ts). */
function person(persons: PersonSummary[], handle: string): PersonSummary | null {
  return persons.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}
const nameOf = (persons: PersonSummary[], handle: string): string =>
  person(persons, handle)?.name || (handle === MIRROR_HANDLE ? "GitHub" : handle);
/** The person a name may link to — a known person, never the GitHub mirror's system handle. */
const linkable = (persons: PersonSummary[], handle: string): PersonSummary | null =>
  handle === MIRROR_HANDLE ? null : person(persons, handle);
/** A name in the rail: a link to their person card when the handle is a known person (never
 *  the GitHub mirror's system handle), else plain text. `style` is the text's own. */
function personName(persons: PersonSummary[], handle: string, label: string, style: string): string {
  return personNameLink(linkable(persons, handle), label, style);
}
const firstNameOf = (persons: PersonSummary[], handle: string): string => nameOf(persons, handle).split(" ")[0];

/** Avatar row — the design's `asgAvs` (-7px overlap, ring in the page background). The
 *  corners layer in trov.css lays them side by side instead (`.cnpy-avstack`). `linked`:
 *  each known person's photo is its own button to their card — for a stack that is not
 *  itself inside a button (a `hitArea` card, the sprint card); an unknown handle stays plain. */
export function avatarStack(handles: string[], persons: PersonSummary[], size = 20, linked = false): string {
  return `<div class="cnpy-avstack" style="display:flex;flex:none">${handles.map((h, i) =>
    `<span style="display:flex;flex:none;border-radius:50%;box-shadow:0 0 0 2px var(--bg);${i > 0 ? "margin-left:-7px;" : ""}z-index:${9 - i}">${linked ? personAvatarLink(linkable(persons, h), h, size) : personChip(person(persons, h), size, h)}</span>`
  ).join("")}</div>`;
}

/** The assignee cell's text: italic "Unassigned", one full name, or "First +N". */
function assigneeLabel(handles: string[], persons: PersonSummary[]): string {
  if (handles.length === 0) return "Unassigned";
  if (handles.length === 1) return nameOf(persons, handles[0]);
  return `${firstNameOf(persons, handles[0])} +${handles.length - 1}`;
}

/** The statuses a segment covers — also the board's columns, in this order. */
export const SEG_STATUSES: Record<TicketSeg, TicketStatus[]> = {
  open: [...OPEN_STATUSES],
  closed: ["done", "declined"],
  all: [...TICKET_STATUSES],
};

/** Design call #6 — "needs attention" = unassigned AND `submitted` (Triage). Rendered as the
 *  selected-card idiom (2px inset left rule + faint fill), never a new color. */
export function needsAttention(t: { assignees: string[]; status: TicketStatus }): boolean {
  return t.assignees.length === 0 && t.status === "submitted";
}
/** The marker is the faint fill ALONE — `.cnpy-attn` in trov.css, kept there
 *  rather than inline so `.cnpy-trow:hover` (class + pseudo-class) still outranks
 *  it and a needs-attention row keeps its hover background. The 2px inset left
 *  rule this used to carry inline was dropped at the owner's request: the fill
 *  says it quietly enough, in both the table rows and the board cards. */
const NEEDS_ATTENTION_CLASS = " cnpy-attn";

const chipStyle = (on: boolean) =>
  `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}`;
/** The hover layer's hook for the chip pick idiom (trov.css). The state above
 *  is painted inline, so `is-on` is what tells the hover rule which chips to leave
 *  alone — an unpicked one firms its border, the current pick keeps its accent.
 *  (Segments are the shared `segmented()` switch.) */
const chipClass = (on: boolean) => `cnpy-pickchip${on ? " is-on" : ""}`;
/** Every dropdown/picker row shares ONE hover class (`.cnpy-menurow`), and the
 *  keyboard-active row reuses the same fill through `.is-active`. */
const MENU_ROW_CLASS = "cnpy-menurow";

const MONO_EYEBROW =
  "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

// The table's column template — shared by the header row and every ticket row so
// the two can never drift apart.
const TABLE_COLS = "minmax(0,2.4fr) 1.15fr .75fr .7fr 1fr 1.05fr .5fr";

// ── the queue ────────────────────────────────────────────────────────────────

export interface QueueProps {
  /** The rows the server returned — already filtered by seg / assignee / category.
   *  Search, priority and sprint narrow them further here (`queueRows`). */
  tickets: TicketListItem[];
  /** Sprint order drives the table's group order (BACKLOG is always appended last). */
  sprints: SprintView[];
  persons: PersonSummary[];
  seg: TicketSeg;
  assignee: TicketAssigneeFilter;
  category: "all" | TicketCategory;
  view: "table" | "board";
  /** Unassigned + open across the WHOLE queue (= the sidebar badge), not this page. */
  unassignedCount: number;
  /** The search box (client-side, over the loaded rows). */
  q?: string;
  priority?: "all" | TicketPriority;
  /** "all", "backlog", or a sprint id as a string. */
  sprint?: string;
  /** One person's tickets (a handle; "" = nobody picked). The server's assignee
   *  filter knows only anyone / me / unassigned, so this narrows client-side over
   *  an `anyone` fetch. */
  person?: string;
  /** The shared filter menu (web/src/filter-menu.ts). */
  filterOpen?: boolean;
  filterCat?: QueueFilterCat;
  fmOpening?: string | null;
  /** The queue's first read is still out: the toolbar is real, and the board's columns
   *  (or the table's rows) hold a skeleton instead of "Nothing here". */
  loading?: boolean;
}

export const QUEUE_FILTER_CATS = ["assignee", "category", "priority", "sprint"] as const;
export type QueueFilterCat = (typeof QUEUE_FILTER_CATS)[number];

const ASSIGNEE_OPTIONS: [TicketAssigneeFilter, string][] = [
  ["anyone", "Any assignee"],
  ["me", "Assigned to me"],
  ["unassigned", "Unassigned"],
];

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** Does a ticket sit in the picked sprint filter? "backlog" = no sprint. */
function inSprint(t: TicketListItem, sprint: string): boolean {
  if (sprint === "all") return true;
  if (sprint === "backlog") return t.sprint_id === null;
  return String(t.sprint_id) === sprint;
}

/** The rows the queue shows: the server's rows narrowed by the client-side
 *  filters (priority, sprint) and the search box — title, #number, the
 *  requester, the assignees, the sprint, the category, the source issue. */
export function queueRows(p: QueueProps): TicketListItem[] {
  const q = (p.q ?? "").trim().toLowerCase();
  const prio = p.priority ?? "all";
  const sprint = p.sprint ?? "all";
  const who = (p.person ?? "").toLowerCase();
  return p.tickets
    .filter((t) => !who || t.assignees.some((h) => h.toLowerCase() === who))
    .filter((t) => prio === "all" || t.priority === prio)
    .filter((t) => inSprint(t, sprint))
    .filter((t) => {
      if (!q) return true;
      const people = [t.requester, ...t.assignees].map((h) => `${h} ${nameOf(p.persons, h)}`).join(" ");
      return `#${t.id} ${t.title} ${people} ${t.sprint_label ?? "backlog"} ${t.category} ${t.source_ref ?? ""}`.toLowerCase().includes(q);
    });
}

/** The queue's filter menu: Assignee and Category refetch (server-side), Priority
 *  and Sprint narrow the loaded rows. Counts only where they are honest — the
 *  two client-side groups, counted over what the server returned. */
function queueFilterMenu(p: QueueProps, shown: number): FilterMenuProps {
  const prio = p.priority ?? "all";
  const sprint = p.sprint ?? "all";
  const person = p.person ?? "";
  const active = (p.assignee !== "anyone" || person ? 1 : 0) + (p.category !== "all" ? 1 : 0) + (prio !== "all" ? 1 : 0) + (sprint !== "all" ? 1 : 0);
  const sprintOpts: [string, string][] = [["all", "Any sprint"], ...p.sprints.map((sp): [string, string] => [String(sp.id), sp.label]), ["backlog", "Backlog"]];
  return {
    id: "queue", open: !!p.filterOpen, opening: p.fmOpening === "queue", cat: p.filterCat ?? "assignee", activeCount: active,
    showLabel: `Show ${shown} ${shown === 1 ? "ticket" : "tickets"}`, clearAct: "queueFilterClear",
    align: "stretch", ariaLabel: "Filter tickets",
    groups: [
      {
        // A person is `@<handle>`, one list with the three modes. Their counts are
        // honest only over an `anyone` fetch, so they show only then.
        key: "assignee", label: "Assignee", value: person ? `@${person}` : p.assignee, none: "anyone",
        options: [
          ...ASSIGNEE_OPTIONS.map(([v, l]) => ({ v, l, act: "queueAssignee", arg: v })),
          ...[...p.persons].sort((a, b) => (a.name || a.handle).localeCompare(b.name || b.handle)).map((pp) => ({
            v: `@${pp.handle}`, l: pp.name || pp.handle, act: "queueAssignee", arg: `@${pp.handle}`,
            lead: personChip(pp, 18, pp.handle),
            n: p.assignee === "anyone" ? p.tickets.filter((t) => t.assignees.some((h) => h.toLowerCase() === pp.handle.toLowerCase())).length : undefined,
          })),
        ],
      },
      {
        key: "category", label: "Category", value: p.category, none: "all",
        options: [["all", "All categories"] as [string, string], ...TICKET_CATEGORIES.map((c): [string, string] => [c, cap(c)])]
          .map(([v, l]) => ({ v, l, act: "queueCategory", arg: v })),
      },
      {
        key: "priority", label: "Priority", value: prio, none: "all",
        options: [["all", "Any priority"] as [string, string], ...[...TICKET_PRIORITIES].reverse().map((x): [string, string] => [x, cap(x)])]
          .map(([v, l]) => ({ v, l, act: "queuePriority", arg: v, n: v === "all" ? p.tickets.length : p.tickets.filter((t) => t.priority === v).length })),
      },
      {
        key: "sprint", label: "Sprint", value: sprint, none: "all",
        options: sprintOpts.map(([v, l]) => ({ v, l, act: "queueSprint", arg: v, n: p.tickets.filter((t) => inSprint(t, v)).length })),
      },
    ],
  };
}

/** The toolbar: the Artifacts library's search + Filter pair, then the
 *  Open / Closed / All switch, then the count. */
function filterRow(p: QueueProps, shown: number): string {
  const segs: [TicketSeg, string][] = [["all", "All"], ["open", "Open"], ["closed", "Closed"]];
  const segment = segmented({
    id: "queue-seg", ariaLabel: "Ticket status", act: "queueSeg", value: p.seg, size: "sm", className: "cnpy-seg--bar",
    options: segs.map(([value, label]) => ({ value, label })),
  });

  const menu = queueFilterMenu(p, shown);
  const q = p.q ?? "";
  const search = searchFilterBar({
    search: { act: "queueQ", field: "queueQ", value: q, placeholder: "Search by title, #number or person", ariaLabel: "Search tickets", clearAct: "queueClearQ" },
    menu, hoverBlur: true,
  });

  // "N shown · M unassigned" — M is the org-wide unassigned+open count (the same
  // number as the sidebar badge), NOT the filtered page's.
  // Nothing is claimed while the first read is out ("0 shown" would be a guess).
  const count = p.loading ? "" : `${shown} shown · ${p.unassignedCount} unassigned`;

  return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px">
    ${search}
    ${segment}
    <span style="font-size:12px;color:var(--fg-40);white-space:nowrap;margin-left:auto;flex:none">${esc(count)}</span>
  </div>`;
}

/** The relation marker: "N sub" on a parent, "↳ sub-ticket" on a child, else nothing. */
function relationChip(t: TicketListItem): string {
  if (t.sub_count > 0) return tagChip(`${t.sub_count} sub`, { size: 9.5, pad: "1px 6px" });
  if (t.parent_id !== null) return tagChip("↳ sub-ticket", { size: 9.5, pad: "1px 6px" });
  return "";
}

/** A table row: no hairline of its own — the hover fill marks a row, and one hairline
 *  between sprint groups is the only rule inside the body. A `hitArea` row, so the
 *  requester and each assignee's photo open their person card while the rest opens the ticket. */
function tableRow(t: TicketListItem, persons: PersonSummary[]): string {
  const attn = needsAttention(t);
  const asgText = assigneeLabel(t.assignees, persons);
  const asgStyle = t.assignees.length ? "color:var(--fg-70)" : "color:var(--fg-55);font-style:italic";
  return `<div class="cnpy-trow${attn ? NEEDS_ATTENTION_CLASS : ""} ${HITBOX}" style="display:grid;grid-template-columns:${TABLE_COLS};gap:12px;align-items:center;width:100%;text-align:left;padding:11px 20px;transition:background .12s ease">
    <div style="display:flex;align-items:center;gap:7px;min-width:0"><span style="min-width:0;font-size:13.5px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>${relationChip(t)}${sourceChip(t)}</div>
    <div style="display:flex;min-width:0">${personLink(linkable(persons, t.requester), t.requester, 20, nameOf(persons, t.requester), "min-width:0;font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap")}</div>
    <div>${tableCategory(t.category)}</div>
    <div>${tablePriority(t.priority)}</div>
    <div>${ticketPill(t.status)}</div>
    <div style="display:flex;align-items:center;gap:7px;min-width:0">${avatarStack(t.assignees, persons, 20, true)}<span style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${asgStyle}">${esc(asgText)}</span></div>
    <div style="font-size:11.5px;color:var(--fg-40);text-align:right;font-family:var(--label)">${esc(age(t.created_at))}</div>
    ${hitArea("openTicket", String(t.id), `#${t.id} ${t.title}`)}
  </div>`;
}

interface QueueGroup {
  key: number | null;
  label: string;
  dates: string;
  active: boolean;
  rows: TicketListItem[];
}

/** Table groups: one per sprint in `sprints` order, BACKLOG always last. Empty
 *  groups are dropped (the design hides them rather than showing "0 tickets").
 *
 *  NOTHING IS EVER DROPPED. A ticket whose `sprint_id` matches no loaded sprint
 *  — `GET /sprints` failed or is still in flight, or the sprint row was removed
 *  by hand behind the soft ref — folds into BACKLOG rather than vanishing from
 *  the table while the footer still counts it. */
export function queueGroups(tickets: TicketListItem[], sprints: SprintView[]): QueueGroup[] {
  const known = new Set(sprints.map((sp) => sp.id));
  const defs: QueueGroup[] = sprints.map((sp) => ({
    key: sp.id,
    label: sp.label.toUpperCase(),
    dates: sprintDatesLabel(sp) ?? sp.due ?? "",   // real start/due first, then the authored label
    active: sp.active,
    rows: tickets.filter((t) => t.sprint_id === sp.id),
  }));
  defs.push({
    key: null,
    label: "BACKLOG",
    dates: "NO SPRINT",
    active: false,
    rows: tickets.filter((t) => t.sprint_id === null || !known.has(t.sprint_id)),
  });
  return defs.filter((g) => g.rows.length > 0);
}

function groupHeader(g: QueueGroup): string {
  const openLink = g.key !== null
    ? `<button data-act="openSprint" data-arg="${g.key}" title="Open sprint screen" class="cnpy-grouplink" style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:500;color:var(--fg-55);white-space:nowrap;flex:none;padding:2px 6px">Open sprint →</button>`
    : "";
  const meta = `<span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40);white-space:nowrap">${esc(g.dates)}${g.active ? `<span style="color:var(--accent)"> · ACTIVE</span>` : ""}</span>`;
  return `<div class="cnpy-tgrp" style="display:flex;align-items:center;gap:9px;padding:18px 20px 6px">
    <span style="width:7px;height:7px;border-radius:50%;flex:none;background:${g.active ? "var(--accent)" : "var(--border-strong)"}"></span>
    <span style="font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;white-space:nowrap;color:${g.active ? "var(--accent)" : "var(--fg-55)"}">${esc(g.label)}</span>
    ${meta}
    ${openLink}
    <div style="flex:1"></div>
    <span style="font-family:var(--label);font-size:10px;font-weight:600;color:var(--fg-40);white-space:nowrap;flex:none">${g.rows.length} ${g.rows.length === 1 ? "ticket" : "tickets"}</span>
  </div>`;
}

/** The table while the queue's first read is out: one sprint group's header and rows,
 *  on the table's own column template. */
function tableSkeleton(): string {
  const row = (i: number) => `<div class="cnpy-trow" style="display:grid;grid-template-columns:${TABLE_COLS};gap:12px;align-items:center;padding:11px 20px">
    ${skLine(skW(i), 13.5, 1.5)}${skLine("70%", 12.5, 1.6)}${skLine("60%", 12.5, 1.6)}${skLine("50%", 12.5, 1.6)}${skLine("64%", 12.5, 1.6)}${skLine("72%", 12.5, 1.6)}${skLine("60%", 11.5, 1.6, "justify-content:flex-end")}
  </div>`;
  return skeleton("tickets-table", "Loading the queue&hellip;",
    `<div class="cnpy-tgrp" style="display:flex;align-items:center;gap:9px;padding:18px 20px 6px">${skBox(7, 7)}${skLine(140, 10.5, 1.5)}</div>${skList(8, row)}`);
}

function tableView(p: QueueProps): string {
  const head = `<div class="cnpy-thead" style="display:grid;grid-template-columns:${TABLE_COLS};gap:12px;padding:14px 20px 10px;border-bottom:1px solid var(--border);font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40)">
    <div>TITLE</div><div>OPENED BY</div><div>CATEGORY</div><div>PRIORITY</div><div>STATUS</div><div>ASSIGNEE</div><div style="text-align:right">AGE</div>
  </div>`;
  // Each group is a `.cnpy-tgroup`; trov.css draws the ONE hairline between groups.
  const groups = queueGroups(p.tickets, p.sprints)
    .map((g) => `<div class="cnpy-stagger cnpy-tgroup">${groupHeader(g)}${g.rows.map((t) => tableRow(t, p.persons)).join("")}</div>`)
    .join("");
  const empty = p.loading ? tableSkeleton()
    : p.tickets.length === 0
    ? `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">Nothing in this view.</div>`
    : "";
  // The table is ONE surface with 20px sides; rows carry no dividers (a hairline
  // separates sprint groups), and a row's hover fill runs to the surface's edges
  // (overflow clips the corners). Narrow
  // (`.cnpy-ttable`, a container query in trov.css) each row reflows into a small card.
  return `<div${surface("margin-top:8px;overflow:hidden", { cls: "cnpy-ttable" })}>${head}${groups}${empty}</div>`;
}

/** A board card — the plain one: the title, then #number · priority (only when
 *  it is not normal) · the assignees. Everything else is one click away.
 *  Every card drags between columns (main.ts's pointer-driven board drag) —
 *  a resolved ticket moves back as freely as an open one. A `hitArea` card: a press
 *  anywhere still drags it, a click opens the ticket, and a click on an assignee's
 *  photo opens their person card. */
function boardCard(t: TicketListItem, persons: PersonSummary[]): string {
  const canMove = legalMoves(t.status).length > 0;
  const prio = t.priority === "normal" ? ""
    : `<span style="font-size:11.5px;font-weight:${t.priority === "high" ? "600;color:var(--fg)" : "500;color:var(--fg-40)"}">${t.priority === "high" ? "High" : "Low"}</span>`;
  const sep = `<span style="color:var(--fg-40);font-size:11.5px">·</span>`;
  const asg = t.assignees.length
    ? avatarStack(t.assignees, persons, 18, true)
    : `<span style="font-size:11.5px;color:var(--fg-40);font-style:italic">Unassigned</span>`;
  return `<div${canMove ? ` data-tdrag="${t.id}" data-status="${t.status}"` : ""} class="cnpy-tcard ${SURFACE} cnpy-card${needsAttention(t) ? NEEDS_ATTENTION_CLASS : ""} ${HITBOX}" style="display:block;width:100%;text-align:left;padding:11px 12px;margin-bottom:8px;cursor:${canMove ? "grab" : "pointer"}">
    <div style="font-size:13.5px;font-weight:600;letter-spacing:-0.005em;line-height:1.4;color:var(--fg);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(t.title)}</div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:9px;min-height:18px">
      <span style="font-size:11.5px;color:var(--fg-40)">#${t.id}</span>
      ${prio ? `${sep}${prio}` : ""}
      ${sourceMark(t)}
      <span style="margin-left:auto;display:flex;align-items:center">${asg}</span>
    </div>
    ${hitArea("openTicket", String(t.id), `#${t.id} ${t.title}`)}
  </div>`;
}

/** A mirrored ticket's quiet marker on a board card: the GitHub mark, with
 *  "GitHub #214" as its tooltip and accessible name — most of the queue is
 *  mirrored, so a chip on every card would be noise. Native: nothing. */
function sourceMark(t: TicketListItem): string {
  if (t.source !== "github") return "";
  const n = sourceIssueNumber(t.source_ref);
  const label = n !== null ? `GitHub #${n}` : "GitHub";
  return `<span title="${attr(label)}" aria-label="${attr(label)}" style="display:inline-flex;color:var(--fg-40)"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"></path></svg></span>`;
}

/** A board column while the queue's first read is out: cards in the real card's box
 *  (a title of one or two lines, then the #number · assignee row). */
function boardColumnSkeleton(st: TicketStatus): string {
  const n = st === "submitted" ? 3 : st === "in_progress" ? 2 : 1;
  const card = (i: number) => `<div class="${SURFACE}" style="padding:11px 12px;margin-bottom:8px">
    ${skLines(i % 2 ? [skW(i)] : ["94%", skW(i + 1, ["48%", "62%"])], 13.5, 1.4)}
    <div style="display:flex;align-items:center;gap:6px;margin-top:9px;min-height:18px">${skBar(30, 8)}<span style="margin-left:auto;display:flex">${skBox(18, 18)}</span></div>
  </div>`;
  return skeleton(`tickets-col-${st}`, "Loading the queue&hellip;", skList(n, card));
}

function boardView(p: QueueProps, rows: TicketListItem[]): string {
  const statuses = SEG_STATUSES[p.seg];
  const cols = statuses.map((st) => {
    // A column is in its saved board order (`boardOrder`, tickets-core — the order
    // `move_ticket` places into), not the table's newest-first.
    const cards = rows.filter((t) => t.status === st).sort(boardOrder);
    const headColor = st === "in_progress" ? "color:var(--accent)" : st === "submitted" ? "color:var(--blue)" : st === "testing" ? "color:var(--amber)" : "color:var(--fg-40)";
    const empty = p.loading ? ""
      : cards.length === 0
      ? `<div class="cnpy-tdrop-empty" style="border:1px dashed var(--border);border-radius:10px;padding:16px;text-align:center;font-size:12px;color:var(--fg-40)">Nothing here</div>`
      : "";
    // The whole column (down to the grid's floor) is the drop target.
    return `<div data-tdrop="${st}" class="cnpy-tcol" style="min-width:0;display:flex;flex-direction:column;border-radius:12px;padding:0 6px 6px;margin:0 -6px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:9px;border-bottom:1px solid var(--border-strong);margin-bottom:10px">
        <span style="font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;white-space:nowrap;${headColor}">${esc(TICKET_STATUS_LABEL[st].toUpperCase())}</span>
        <span style="font-size:12px;color:var(--fg-40);white-space:nowrap;flex:none">${p.loading ? "" : cards.length}</span>
      </div>
      <div class="cnpy-stagger">${p.loading ? boardColumnSkeleton(st) : cards.map((t) => boardCard(t, p.persons)).join("")}</div>
      ${empty}
      <div style="flex:1;min-height:40px"></div>
    </div>`;
  }).join("");
  // `.cnpy-board`: under a tablet's width the columns keep a readable width and the board
  // scrolls sideways inside itself, a column per snap (trov.css).
  return `<div class="cnpy-board" style="display:grid;gap:14px;align-items:stretch;margin-top:12px;min-height:calc(100vh - 190px);grid-template-columns:repeat(${Math.max(statuses.length, 1)},minmax(0,1fr))">${cols}</div>`;
}

/** The whole queue screen: toolbar + Board or Table. */
export function queueView(p: QueueProps): string {
  const rows = queueRows(p);
  return `<div style="${WORK_SHELL}">
    ${filterRow(p, rows.length)}
    ${p.view === "board" ? boardView(p, rows) : tableView({ ...p, tickets: rows })}
  </div>`;
}

// ── new ticket ───────────────────────────────────────────────────────────────

export interface NewTicketProps {
  title: string;
  /** null = nothing picked = filed as `other` (the design's `fCat ?? "other"`). */
  category: TicketCategory | null;
  priority: TicketPriority;
  description: string;
  assignees: string[];
  /** Raw link input; parsed server-side by the SHARED parser on create. */
  link: string;
  /** null = Backlog. */
  sprintId: number | null;
  sprints: SprintView[];
  persons: PersonSummary[];
  /** Whether the sprint picker is open — the same `sprMenu` flag the detail
   *  rail's picker uses (the two screens are never mounted together). */
  sprMenu: boolean;
}

/** How tall a ticket screen's body runs: the window, less the header, the
 *  shell's own padding and a bottom breath. The form's card and the detail's
 *  two columns both take it, so a ticket screen fills the window it is in
 *  rather than floating in the top third of a large one. */
const CARD_MIN_H = "calc(100vh - 210px)";

const FIELD_LABEL = "display:block;font-size:13px;font-weight:500;margin-bottom:8px";
const TEXT_INPUT =
  "width:100%;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none";

function personChipButton(act: string, arg: string, label: string, on: boolean, avatar: string): string {
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" class="${chipClass(on)}" style="display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:7px;font-size:12.5px;font-weight:500;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}">${avatar}${esc(label)}</button>`;
}

export function newTicketView(p: NewTicketProps): string {
  const canSubmit = p.title.trim().length > 0;

  const catChips = TICKET_CATEGORIES.map((c) =>
    `<button data-act="ntCategory" data-arg="${c}" class="${chipClass(p.category === c)}" style="${chipStyle(p.category === c)};font-family:var(--label)">${c}</button>`).join("");

  const prioSeg = segmented({
    id: "nt-priority", ariaLabel: "Priority", act: "ntPriority", value: p.priority,
    options: TICKET_PRIORITIES.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })),
  });

  // One picker, not a chip per sprint: the roadmap carries a dozen-plus sprints
  // with long labels, which crammed the rail and overflowed the card.
  const pickedSprint = p.sprintId === null ? null : p.sprints.find((sp) => sp.id === p.sprintId) ?? null;
  const sprintPicker = `<div style="position:relative">
    <button data-act="ntSprintMenu" class="cnpy-outlinebtn" style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:38px;padding:0 11px;border:1px solid var(--border-strong);border-radius:9px;font-size:12.5px;font-weight:500;color:${p.sprintId === null ? "var(--fg-70)" : "var(--fg)"};transition:all .12s ease">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pickedSprint ? pickedSprint.label : "Backlog")}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;color:var(--fg-40)"><path d="m6 9 6 6 6-6"></path></svg>
    </button>
    ${p.sprMenu ? sprintMenuBox(p.sprints, p.sprintId, "ntSprint") : ""}
  </div>`;

  const dashedAvatar = `<span style="width:20px;height:20px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:8px;font-weight:600;flex:none;color:var(--fg-40)">–</span>`;
  const asgChips = [personChipButton("ntAssignee", "", "Unassigned", p.assignees.length === 0, dashedAvatar)]
    .concat(p.persons.map((pp) =>
      personChipButton("ntAssignee", pp.handle, pp.name || pp.handle, p.assignees.includes(pp.handle), personChip(pp, 20, pp.handle))))
    .join("");

  return `<div style="${WORK_SHELL}">
    <div${surface(`padding:26px 28px;display:flex;flex-direction:column;min-height:${CARD_MIN_H}`)}>
      <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 288px;gap:32px;flex:1;min-height:0">
        <div style="min-width:0;display:flex;flex-direction:column">
          <label style="${FIELD_LABEL}">Title</label>
          <input data-act="ntTitle" data-field="ntTitle" value="${attr(p.title)}" placeholder="One line: what do you need?" style="${TEXT_INPUT}" />
          <label style="${FIELD_LABEL};margin:20px 0 8px">Description</label>
          <textarea data-act="ntDescription" data-field="ntDescription" placeholder="What's happening, and what would good look like?" style="width:100%;flex:1;min-height:190px;padding:10px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;line-height:1.6;outline:none;resize:vertical">${esc(p.description)}</textarea>
          <label style="${FIELD_LABEL};margin:20px 0 8px">Linked work <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
          <input data-act="ntLink" data-field="ntLink" value="${attr(p.link)}" placeholder="GitHub or Figma URL, or #issue-number" style="${TEXT_INPUT};height:38px;font-size:12.5px;font-family:var(--label)" />
        </div>
        <div style="min-width:0;border-left:1px solid var(--border);padding-left:26px">
          <label style="${FIELD_LABEL}">Category</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${catChips}</div>
          <label style="${FIELD_LABEL};margin:20px 0 8px">Priority</label>
          ${prioSeg}
          <label style="${FIELD_LABEL};margin:20px 0 8px">Sprint</label>
          ${sprintPicker}
          <label style="${FIELD_LABEL};margin:20px 0 8px">Assignees <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${asgChips}</div>
          <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Leave unassigned to let the queue pick it up.</div>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
        <button data-act="ticketsBack" class="cnpy-outlinebtn" style="padding:8px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Cancel</button>
        ${primaryBtn("Submit ticket", canSubmit, "ntSubmit", "", "padding:8px 16px")}
      </div>
    </div>
  </div>`;
}

// ── ticket detail ────────────────────────────────────────────────────────────

export interface TicketDetailProps {
  ticket: TicketDetail;
  /** The queue list, used ONLY for the sub-ticket candidate filter. */
  allTickets: TicketListItem[];
  sprints: SprintView[];
  persons: PersonSummary[];
  commentDraft: string;
  linkDraft: string;
  /** Re-opens the link field after at least one link exists (design call #8). */
  linkOpen: boolean;
  asgMenu: boolean;
  sprMenu: boolean;
  relMenu: boolean;
  /** The linked-work chip whose ⋯ menu is open (a link id; null = none). */
  lkMenu: number | null;
  /** Which status control has its menu open (null = neither). */
  stMenu: StatusMenuAnchor | null;
  /**
   * The open @mention token in the comment box (main.ts computes it from the
   * textarea's value + caret). null = the picker is closed. Candidates are
   * derived here, so "no candidates" also renders nothing. `line` is the caret's
   * 0-based line — the picker hangs under THAT line, not under the whole box.
   */
  mention: { query: string; start: number; index: number; line: number } | null;
  /** The comment box's dragged height (the bottom-left grip), null = resting. */
  commentHeight: number | null;
  /** The Artifacts block under Linked work (artifacts.ts), pre-rendered; absent = none. */
  artifactsBlock?: string;
  /** The title/body editor's drafts while editing; null (or absent) = reading. */
  edit?: { title: string; body: string } | null;
  /** The delete confirm is open (render.ts puts `ticketDeleteModal` at the root). */
  deleteArm?: boolean;
}

/**
 * Which tickets may be attached as a sub-ticket of `d` — the design's
 * `relCandidates`, and §A's rule: exclude self, its parent, anything that
 * already has a parent (tickets nest ONE level), anything that already has
 * children, and anything closed.
 */
export function relCandidates(
  all: TicketListItem[],
  d: { id: number; parent_id: number | null }
): TicketListItem[] {
  return all.filter((x) =>
    x.id !== d.id &&
    x.id !== d.parent_id &&
    x.parent_id === null &&
    x.sub_count === 0 &&
    isOpenStatus(x.status));
}

/** Escape, then paint `@mentions` that resolve to a person (design's `mention()`). */
function mentionize(text: string, persons: PersonSummary[]): string {
  const known = new Map<string, string>();
  for (const p of persons) {
    known.set(p.handle.toLowerCase(), p.handle);
    const first = (p.name || p.handle).split(" ")[0];
    known.set(first.toLowerCase(), p.handle);
  }
  return esc(text).replace(/@([A-Za-z0-9_-]+)/g, (whole, name: string) => {
    const handle = known.get(name.toLowerCase());
    if (!handle) return whole;
    // A mention is a name too: it opens that person's card, like the photo and name beside a comment.
    return `<button data-act="openPerson" data-arg="${attr(handle)}" class="cnpy-mention" title="${attr(nameOf(persons, handle))}" style="display:inline;font:inherit;color:var(--accent);font-weight:600;background:var(--accent-soft);border-radius:4px;padding:0 4px;cursor:pointer">@${esc(firstNameOf(persons, handle))}</button>`;
  });
}

const LINK_ICON: Record<string, string> = {
  github: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`,
  figma: `<svg width="12" height="17" viewBox="0 0 38 57" aria-hidden="true"><path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"></path><path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"></path><path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"></path><path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"></path><path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"></path></svg>`,
  plain: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>`,
};
const EXTERNAL_ARROW = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="flex:none;color:var(--fg-40);margin-left:2px"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>`;
const RAIL_ARROW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;color:var(--fg-40)"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>`;
const PLUS_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"></path></svg>`;
/** Menu tick — accent when this row is the current choice, invisible otherwise
 *  (kept in flow so the labels don't shift, exactly like the design's checkSt). */
const checkMark = (on: boolean): string =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="flex:none;${on ? "color:var(--accent)" : "visibility:hidden"}"><path d="M20 6 9 17l-5-5"></path></svg>`;

/** Defense in depth: a stored link url must be http(s) before it reaches an href. */
const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

const MENU_BOX = "position:absolute;top:calc(100% + 6px);right:0;z-index:30;background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;padding:5px;box-shadow:0 14px 38px rgba(0,0,0,.38)";
const MENU_BACKDROP = `<div data-act="closeTicketMenus" style="position:fixed;inset:0;z-index:29"></div>`;
const RAIL_ROW = "display:flex;align-items:center;gap:10px;width:100%;text-align:left;height:38px;padding:0";
const RAIL_BOX = "width:24px;height:24px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);font-size:11px;flex:none";
const RAIL_TITLE = "display:block;font-size:13px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
const RAIL_META = "display:block;font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);white-space:nowrap;margin-top:2px";
const ICON_BTN = "width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--fg-40);transition:all .12s ease";
const RAIL_SECTION_HEAD = "display:flex;align-items:center;justify-content:space-between;gap:8px;height:22px;margin-bottom:6px";
const PROP_ROW = "display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center;height:30px";
const PROP_LABEL = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)";

/** THE sprint picker — Backlog plus every sprint, the current one ticked. The
 *  ticket detail rail and the new-ticket form both render this ONE menu (they
 *  differ only in the act a row fires), so a sprint is picked the same way
 *  before and after the ticket exists. A menu is also what keeps a long,
 *  authored sprint label in bounds: the box is bounded in both axes and each
 *  row ellipsises, where the chip-per-sprint stack this replaced in the form
 *  put a nowrap chip wider than the rail column and spilled out of the card. */
function sprintMenuBox(sprints: SprintView[], current: number | null, act: string): string {
  const options: { id: number | null; label: string }[] = [
    { id: null, label: "Backlog" },
    ...sprints.map((s) => ({ id: s.id, label: s.label })),
  ];
  const rows = options.map((o) => {
    const on = current === o.id;
    return `<button data-act="${attr(act)}" data-arg="${o.id ?? ""}" class="${MENU_ROW_CLASS}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;color:${on ? "var(--fg)" : "var(--fg-70)"}"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(o.label)}</span>${checkMark(on)}</button>`;
  }).join("");
  // 230px, or the trigger's own width when that is wider (the form's picker is a
  // full-width control, the rail's is a 22px icon button) — one expression, so
  // both screens really are the same menu.
  return `${MENU_BACKDROP}<div style="${MENU_BOX};width:230px;min-width:100%;max-height:298px;overflow-y:auto">${rows}</div>`;
}

/** Which anchor has the status menu open — the header control or the rail's
 *  STATUS row. Both render the same menu, so one flag naming the anchor keeps
 *  exactly one of them open. */
/** Where a status menu hangs. One place since the header control went: the rail. */
export type StatusMenuAnchor = "rail";

/** THE status control. A status is a property a person SETS, so it is rendered
 *  as the pill you click, not as a row of action buttons: the old "Start" +
 *  "Decline" pair read as an accept/reject gate on the assignment, which is not
 *  what a status is (and assignment never gated anything — `toggle_assignee`
 *  does not touch status). The menu lists the statuses in pipeline order with
 *  the current one ticked; every other status is clickable (`TICKET_TRANSITIONS`
 *  allows every move), done and declined included. */
function statusControl(status: TicketStatus, open: boolean, anchor: StatusMenuAnchor): string {
  const moves = legalMoves(status);
  if (moves.length === 0) return ticketPill(status);
  // A row is the PILL itself — `ticketPill` already spells the status out, so a
  // label beside it would just say it twice.
  const rows = TICKET_STATUSES.filter((s) => s === status || moves.includes(s)).map((s) => {
    const on = s === status;
    const row = "display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;white-space:nowrap";
    return on
      ? `<div style="${row}">${ticketPill(s)}${checkMark(true)}</div>`
      : `<button data-act="ticketStatus" data-arg="${s}" class="${MENU_ROW_CLASS}" style="${row}">${ticketPill(s)}${checkMark(false)}</button>`;
  }).join("");
  const menu = open ? `${MENU_BACKDROP}<div style="${MENU_BOX};width:172px;min-width:100%">${rows}</div>` : "";
  // The trigger IS the pill — same tint as `ticketPill`, with the chevron inside
  // it. It used to be the pill nested in an outlined button, which read as a chip
  // sitting in a box; the affordance is now the chevron plus a ring in the
  // status's own colour on hover / while open (`.cnpy-statusbtn`).
  return `<div style="position:relative;display:inline-flex">
    <button data-act="ticketStatusMenu" data-arg="${anchor}" title="Set status" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}" class="cnpy-statusbtn" style="${ticketPillStyle(status)};display:inline-flex;align-items:center;gap:5px;padding:3px 6px 3px 8px;cursor:pointer">
      ${esc(TICKET_STATUS_LABEL[status].toUpperCase())}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" style="flex:none;opacity:.7"><path d="m6 9 6 6 6-6"></path></svg>
    </button>${menu}
  </div>`;
}

/** The ticket body is markdown — people paste lists, bold and links into it,
 *  and agents file tickets in markdown — so it goes through `renderMarkdown`
 *  (marked + DOMPurify), the same sanitizing pipeline as a doc body or a sprint
 *  description, and is NEVER additionally esc()'d. `.cnpy-td-body` keeps a
 *  typed single line break inside a paragraph (`white-space:pre-line` on `p`),
 *  which the old `pre-wrap` text block did and plain markdown would swallow. */
function ticketBody(body: string): string {
  if (!body.trim()) return "";
  return `<div class="cnpy-md cnpy-td-body" style="font-size:13.5px;line-height:1.65;color:var(--fg-70);max-width:640px">${renderMarkdown(body)}</div>`;
}

/** A linked-work chip's menu: copy the url, or remove the link (the one
 *  destructive row, in red). It pops straight out of the ⋯: top-left corner
 *  4px right of the button (which sits 8px in from the chip's right, 22px
 *  square, vertically centred) and level with its top, growing from there.
 *  A LOCKED link (a mirrored ticket's source issue, 0032) has no Remove row —
 *  the server refuses it anyway — and says why in its place. */
function linkMenuBox(linkId: number, locked = false): string {
  const row = "display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap";
  const last = locked
    ? `<div style="${row};color:var(--fg-40);cursor:default">${LOCK_SVG}Source issue — locked</div>`
    : `<button role="menuitem" data-act="ticketLinkRemove" data-arg="${linkId}" class="${MENU_ROW_CLASS}" style="${row};color:var(--red)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"></path></svg>Remove link</button>`;
  return `${MENU_BACKDROP}<div role="menu" class="cnpy-lkmenu" style="${MENU_BOX};top:calc(50% - 11px);right:auto;left:calc(100% - 4px);width:${locked ? 190 : 170}px">
    <button role="menuitem" data-act="ticketLinkCopy" data-arg="${linkId}" class="${MENU_ROW_CLASS}" style="${row};color:var(--fg-70)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>Copy link</button>
    ${last}
  </div>`;
}

const LOCK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`;

function linkedWorkBlock(p: TicketDetailProps): string {
  const links = p.ticket.links;
  const hasLinks = links.length > 0;
  // Design call #8: the link field shows until a link exists; after that the
  // plain "Linked to engineering work" line (the field is still reachable
  // through the Add link toggle, which only appears once a link is there).
  const addToggle = hasLinks
    ? `<button data-act="ticketLinkToggle" style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:500;color:var(--fg-40);white-space:nowrap;opacity:.7;transition:all .12s ease"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Add link</button>`
    : "";
  const chips = hasLinks
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${links.map((lk) =>
        // Linear's pattern: the <a> is the whole chip and opens the link. On hover
        // its arrow gives way to a ⋯ (a SIBLING laid over the arrow's slot — a
        // button may not sit inside a link) that opens Copy link / Remove link;
        // right-clicking the chip opens the same menu. Removing is two deliberate
        // clicks, never one stray one at the spot you reach for to open the link.
        `<span class="cnpy-lk${p.lkMenu === lk.id ? " is-open" : ""}" data-ctx="ticketLinkMenuOpen" data-arg="${lk.id}" style="position:relative;display:inline-flex">
          <a href="${attr(safeHref(lk.url))}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:9px;padding:7px 13px 7px 10px;border:1px solid var(--border);border-radius:9px;text-decoration:none;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
          <span style="flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-70);background:color-mix(in srgb,var(--fg) 6%,transparent)">${LINK_ICON[lk.kind] ?? LINK_ICON.plain}</span>
          <span style="min-width:0">
            <span style="display:block;font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px">${esc(lk.label)}</span>
            <span style="display:flex;align-items:center;gap:4px;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px;white-space:nowrap">${lk.locked ? `<span title="The issue this ticket mirrors — this link can't be removed" style="display:flex">${LOCK_SVG.replace('width="13" height="13"', 'width="10" height="10"')}</span>` : ""}${esc(lk.locked ? `${lk.meta} · SOURCE` : lk.meta)}</span>
          </span><span class="cnpy-lkarr" style="display:flex">${EXTERNAL_ARROW}</span>
          </a>
          <button data-act="ticketLinkMenu" data-arg="${lk.id}" class="cnpy-lkmore" title="Link actions" aria-label="Actions for ${attr(lk.label)}" aria-haspopup="menu" aria-expanded="${p.lkMenu === lk.id ? "true" : "false"}" style="position:absolute;padding:0;top:50%;right:8px;margin-top:-11px;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-55)"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button>
          ${p.lkMenu === lk.id ? linkMenuBox(lk.id, lk.locked === 1) : ""}
        </span>`).join("")}</div>`
    : "";
  const linkedLine = hasLinks
    ? `<div style="font-size:12px;color:var(--fg-40);margin-top:10px">Linked to engineering work</div>`
    : "";
  const field = !hasLinks || p.linkOpen
    ? `<div style="display:flex;gap:8px;margin-top:10px">
        <input data-act="ticketLinkDraft" data-field="ticketLinkDraft" value="${attr(p.linkDraft)}" placeholder="Paste a GitHub or Figma URL, or #issue — it links on paste or Enter" style="flex:1;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--label);outline:none" />
        <button data-act="ticketLinkAdd" class="cnpy-outlinebtn" style="padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Link</button>
      </div>`
    : "";
  return `<div style="display:flex;align-items:baseline;gap:10px;margin-top:26px">
      <div style="${MONO_EYEBROW};flex:none">Linked work</div>${addToggle}
    </div>${chips}${linkedLine}${field}`;
}

/**
 * The @mention autocomplete list, hung under the LINE being typed inside the
 * comment textarea (`mentionPickerTop`) rather than under the whole box, which
 * left it floating far below the caret on a multi-line draft. Beyond the locked
 * design (which has no picker), so it borrows the design's own popover skin:
 * bordered card on `--bg`, soft shadow, `--hover` on the active row — and that
 * fill now comes from `.cnpy-menurow.is-active`, the same declaration :hover
 * uses, so the keyboard-active row and the hovered row look identical.
 *
 * Renders "" when the picker is closed OR when nothing matches — the caller
 * never has to check twice. Rows dispatch `mentionPick` with the handle.
 */
function mentionPicker(p: TicketDetailProps, boxHeight: number): string {
  if (!p.mention) return "";
  const cands = mentionCandidates(p.persons, p.mention.query);
  if (!cands.length) return "";
  // main.ts wraps the index as it moves, but a stale index (the query narrowed
  // the list between keystrokes) must never paint an out-of-range row.
  const active = ((p.mention.index % cands.length) + cands.length) % cands.length;
  const top = mentionPickerTop(p.mention.line, { height: boxHeight });
  const rows = cands.map((c, i) =>
    `<button data-act="mentionPick" data-arg="${attr(c.handle)}" role="option" aria-selected="${i === active}" class="${MENU_ROW_CLASS}${i === active ? " is-active" : ""}" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:6px 9px;border-radius:7px">
      ${personChip(c, 20, c.handle)}
      <span style="font-size:13px;color:var(--fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name || c.handle)}</span>
      <span style="font-family:var(--sans);font-size:11.5px;color:var(--fg-55);margin-left:auto;flex:none">@${esc(c.handle)}</span>
    </button>`).join("");
  return `<div role="listbox" aria-label="Mention someone" style="position:absolute;top:${top}px;left:0;right:0;min-width:220px;z-index:30;background:var(--bg);border:1px solid var(--border-strong);border-radius:9px;box-shadow:0 8px 30px rgba(0,0,0,.35);padding:5px">
    ${rows}
    <div style="font-family:var(--label);font-size:10.5px;color:var(--fg-40);padding:5px 9px 3px;border-top:1px solid var(--border);margin-top:4px">↑↓ to move · Enter to mention · Esc to close</div>
  </div>`;
}

/**
 * The comment box's resize grip, bottom-LEFT (the corner the native resizer used
 * to sit in is now the Comment button's).
 *
 * The textarea sets `resize:none` and this drives the height instead, for a
 * reason beyond the corner swap: a natively-resized height is written INLINE on
 * the element, and the next keystroke's `rerender()` swaps the whole mount's
 * innerHTML — so the native handle's effect was thrown away on the very next
 * character. main.ts drags this one into `state.commentHeight`, which survives.
 */
const COMMENT_GRIP =
  `<button data-act="commentGrip" title="Drag to resize" aria-label="Resize the comment box" class="cnpy-grip" style="position:absolute;left:10px;bottom:10px;width:12px;height:12px;display:grid;place-items:center;color:var(--fg-40);cursor:ns-resize;touch-action:none"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M1 1 11 11"></path><path d="M1 6 6 11"></path></svg></button>`;

interface ThreadRow { ts: number; html: string }

function threadBlock(p: TicketDetailProps): string {
  const t = p.ticket;
  const rows: ThreadRow[] = [];
  for (const c of t.comments) {
    rows.push({
      ts: new Date(c.created_at).getTime(),
      html: `<div style="display:flex;align-items:flex-start;gap:11px;padding:14px 0;border-bottom:1px solid var(--border)">
        <div style="margin-top:1px">${personAvatarLink(linkable(p.persons, c.author), c.author, 26)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:7px">${personName(p.persons, c.author, nameOf(p.persons, c.author), "font-size:12.5px;font-weight:600;white-space:nowrap;color:var(--fg)")}<span style="font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(relTime(c.created_at))}</span></div>
          <div style="font-size:13px;line-height:1.6;color:var(--fg-70);margin-top:4px">${mentionize(c.body, p.persons)}</div>
        </div>
      </div>`,
    });
  }
  for (const ev of t.events) {
    // The opening row reads "opened this ticket" (the design's `dThread.move`);
    // every later row is "from → to".
    const move = ev.from_status === null
      ? "opened this ticket"
      : `${TICKET_STATUS_LABEL[ev.from_status]} → ${TICKET_STATUS_LABEL[ev.to_status]}`;
    rows.push({
      ts: new Date(ev.created_at).getTime(),
      html: `<div style="display:flex;align-items:center;gap:9px;padding:8px 0 8px 8px;border-bottom:1px solid var(--border)">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--border-strong);flex:none;margin:0 6px"></span>
        ${personLink(linkable(p.persons, ev.actor), ev.actor, 16, ev.actor === MIRROR_HANDLE ? "GitHub" : nameOf(p.persons, ev.actor), "font-size:12px;font-weight:600;color:var(--fg-70);white-space:nowrap")}
        <span style="font-size:12px;color:var(--fg-40);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(move)}</span>
        <span style="font-size:11px;color:var(--fg-40);margin-left:auto;flex:none;white-space:nowrap">${esc(relTime(ev.created_at))}</span>
      </div>`,
    });
  }
  rows.sort((a, b) => a.ts - b.ts);

  const canPost = p.commentDraft.trim().length > 0;
  // The box's two corners: the grip bottom-LEFT, Comment bottom-RIGHT, with the
  // textarea filling everything between. `padBottom` is what keeps the last line
  // of text from running under the button.
  const boxHeight = Math.max(p.commentHeight ?? COMMENT_BOX.height, COMMENT_BOX.minHeight);
  const textarea = `<textarea data-act="ticketComment" data-field="ticketComment" placeholder="Write a comment — @mention to loop someone in…" style="display:block;width:100%;height:${boxHeight}px;min-height:${COMMENT_BOX.minHeight}px;padding:${COMMENT_BOX.padTop}px 0 ${COMMENT_BOX.padBottom}px;border:none;outline:none;background:transparent;color:var(--fg);font-size:${COMMENT_BOX.fontSize}px;line-height:${COMMENT_BOX.lineRatio};resize:none">${esc(p.commentDraft)}</textarea>`;
  // The thread is what absorbs the column's leftover height (the screen is as
  // tall as it is wide-ish now): the rows grow, so the composer sits at the
  // bottom of the window rather than halfway up an empty column.
  return `<div style="display:flex;flex-direction:column;flex:1;min-height:0">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:30px;padding-bottom:9px;border-bottom:1px solid var(--border-strong);flex:none">
      <div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55);white-space:nowrap;flex:none">THREAD</div>
      <div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap;flex:none">${t.comments.length} ${t.comments.length === 1 ? "comment" : "comments"}</div>
    </div>
    <div style="flex:1;min-height:0">${rows.map((r) => r.html).join("")}</div>
    <div${surface("position:relative;padding:12px;margin-top:16px;flex:none")}>
      <div style="position:relative">
        ${textarea}
        ${mentionPicker(p, boxHeight)}
      </div>
      ${COMMENT_GRIP}
      ${primaryBtn("Comment", canPost, "ticketCommentPost", "", "position:absolute;right:8px;bottom:8px")}
    </div>
  </div>`;
}

function assigneeRail(p: TicketDetailProps): string {
  const assigned = p.ticket.assignees;
  const addable = p.persons.filter((pp) => !assigned.includes(pp.handle));
  const addBtn = addable.length
    ? `<button data-act="ticketAsgMenu" title="Add assignee" class="cnpy-iconbtn" style="${ICON_BTN}">${PLUS_SVG}</button>`
    : "";
  const menu = p.asgMenu && addable.length
    ? `${MENU_BACKDROP}<div style="${MENU_BOX};width:200px">${addable.map((pp) =>
        `<button data-act="ticketAsgAdd" data-arg="${attr(pp.handle)}" class="${MENU_ROW_CLASS}" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-70)">${personChip(pp, 20, pp.handle)}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pp.name || pp.handle)}</span></button>`).join("")}</div>`
    : "";
  const list = assigned.length
    ? assigned.map((h) => `<div style="display:flex;align-items:center;gap:10px;height:34px">
        <span style="flex:1;min-width:0;display:flex">${personLink(linkable(p.persons, h), h, 24, nameOf(p.persons, h), "min-width:0;font-size:13px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis")}</span>
        <button data-act="ticketAsgRemove" data-arg="${attr(h)}" title="Remove" class="cnpy-iconbtn" style="flex:none;${ICON_BTN};opacity:.45"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
      </div>`).join("")
    : `<div style="display:flex;align-items:center;gap:10px;height:34px">
        <div style="width:24px;height:24px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:9px;font-weight:600;color:var(--fg-40);flex:none">–</div>
        <span style="font-size:12.5px;color:var(--fg-40);font-style:italic">Unassigned</span>
      </div>`;
  return `<div>
    <div style="${RAIL_SECTION_HEAD}">
      <div style="${MONO_EYEBROW}">Assignees</div>
      <div style="position:relative;display:flex;align-items:center">${addBtn}${menu}</div>
    </div>${list}
  </div>`;
}

function sprintRail(p: TicketDetailProps): string {
  const cur = p.ticket.sprint;
  const curSprint = cur ? p.sprints.find((s) => s.id === cur.id) ?? null : null;
  const menu = p.sprMenu ? sprintMenuBox(p.sprints, cur?.id ?? null, "ticketSprintSet") : "";
  const openAttr = cur ? ` data-act="openSprint" data-arg="${cur.id}"` : "";
  return `<div>
    <div style="${RAIL_SECTION_HEAD}">
      <div style="${MONO_EYEBROW}">Sprint</div>
      <div style="position:relative;display:flex;align-items:center">
        <button data-act="ticketSprintMenu" title="Change sprint" class="cnpy-iconbtn" style="${ICON_BTN}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z"></path></svg></button>${menu}
      </div>
    </div>
    <button${openAttr} style="${RAIL_ROW};${cur ? "cursor:pointer" : "cursor:default"}">
      <span style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);flex:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path></svg></span>
      <span style="flex:1;min-width:0">
        <span style="${RAIL_TITLE}">${esc(cur ? cur.label : "Backlog")}</span>
        <span style="${RAIL_META}">${esc(curSprint ? (curSprint.dates ?? curSprint.due ?? "SPRINT") : "NO SPRINT")}</span>
      </span>
      ${cur ? RAIL_ARROW : ""}
    </button>
  </div>`;
}

function relationsRail(p: TicketDetailProps): string {
  const t = p.ticket;
  // A ticket that already has a parent can never become one (tickets nest ONE
  // level, and POST /tickets/:id/parent rejects it), so the add affordance is
  // hidden there rather than offered and 409'd.
  const candidates = t.parent_id === null ? relCandidates(p.allTickets, t) : [];
  const addBtn = candidates.length
    ? `<button data-act="ticketRelMenu" title="Add sub-ticket" class="cnpy-iconbtn" style="${ICON_BTN}">${PLUS_SVG}</button>`
    : "";
  const menu = p.relMenu && candidates.length
    ? `${MENU_BACKDROP}<div style="${MENU_BOX};width:270px">
        <div style="font-size:10px;font-weight:600;font-family:var(--label);letter-spacing:.05em;color:var(--fg-40);padding:6px 10px 4px">LINK A TICKET AS A SUB-TICKET</div>
        ${candidates.map((c) => `<button data-act="ticketRelAdd" data-arg="${c.id}" class="${MENU_ROW_CLASS}" style="display:block;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.title)}</button>`).join("")}
      </div>`
    : "";
  const parentRow = t.parent
    ? `<button data-act="openTicket" data-arg="${t.parent.id}" style="${RAIL_ROW}">
        <span style="${RAIL_BOX}">↰</span>
        <span style="flex:1;min-width:0"><span style="${RAIL_TITLE}">${esc(t.parent.title)}</span><span style="${RAIL_META}">PARENT TICKET</span></span>
        ${RAIL_ARROW}
      </button>`
    : "";
  const childRows = t.children.map((c) =>
    `<button data-act="openTicket" data-arg="${c.id}" style="${RAIL_ROW}">
      <span style="${RAIL_BOX}">↳</span>
      <span style="flex:1;min-width:0"><span style="${RAIL_TITLE}">${esc(c.title)}</span><span style="${RAIL_META}">SUB-TICKET · ${esc(TICKET_STATUS_LABEL[c.status].toUpperCase())}</span></span>
      ${RAIL_ARROW}
    </button>`).join("");
  const empty = !t.parent && t.children.length === 0
    ? `<div style="display:flex;align-items:center;gap:10px;height:34px">
        <div style="width:24px;height:24px;border-radius:6px;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:11px;color:var(--fg-40);flex:none">↳</div>
        <span style="font-size:12.5px;color:var(--fg-40);font-style:italic">No linked tickets</span>
      </div>`
    : "";
  return `<div>
    <div style="${RAIL_SECTION_HEAD}">
      <div style="${MONO_EYEBROW}">Relations</div>
      <div style="position:relative;display:flex;align-items:center">${addBtn}${menu}</div>
    </div>${parentRow}${childRows}${empty}
  </div>`;
}

const PENCIL_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"></path><path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5"></path></svg>`;

/** The title/description editor. Works the same on a mirrored ticket: its title
 *  and body were copied from the GitHub issue at import and are Trov's now. */
function editBlock(e: { title: string; body: string }): string {
  const canSave = e.title.trim().length > 0;
  return `<div style="display:flex;flex-direction:column;gap:10px;margin:0 0 22px">
    <input data-act="ticketEditTitle" data-field="ticketEditTitle" aria-label="Title" value="${attr(e.title)}" style="height:40px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:17px;font-weight:600;letter-spacing:-0.01em;outline:none" />
    <textarea data-act="ticketEditBody" data-field="ticketEditBody" aria-label="Description" placeholder="Describe the ticket (markdown)" style="width:100%;min-height:190px;padding:10px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;line-height:1.6;outline:none;resize:vertical">${esc(e.body)}</textarea>
    <div style="display:flex;justify-content:flex-end;gap:10px">
      <button data-act="ticketEditCancel" class="cnpy-outlinebtn" style="padding:8px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Cancel</button>
      ${primaryBtn("Save", canSave, "ticketEditSave", "", "padding:8px 16px")}
    </div>
  </div>`;
}

/** The SOURCE property on a mirrored ticket: the issue it came from, and the one
 *  rule GitHub still holds over it — closing the issue closes the ticket. */
function sourceRow(t: TicketDetail): string {
  if (t.source !== "github") return "";
  const n = sourceIssueNumber(t.source_ref);
  const url = t.links.find((l) => l.locked === 1)?.url;
  const label = n !== null ? `GitHub #${n}` : "GitHub";
  const chip = url
    ? `<a href="${attr(safeHref(url))}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--fg);font-size:12.5px;font-weight:500">${LINK_ICON.github}${esc(label)}</a>`
    : `<span style="font-size:12.5px;font-weight:500;color:var(--fg)">${esc(label)}</span>`;
  return `<div style="${PROP_ROW}" title="Mirrored from a GitHub issue. Closing or reopening the issue closes or reopens this ticket; everything else is edited here."><div style="${PROP_LABEL}">SOURCE</div><div style="min-width:0">${chip}</div></div>`;
}

export function ticketDetailView(p: TicketDetailProps): string {
  const t = p.ticket;
  // Laid out like the sprint page: the title heads the LEFT column and the rail
  // starts at the top beside it. Status is set in ONE place (the rail's STATUS
  // row), and who filed it and when are the rail's REQUESTER and OPENED rows —
  // nothing sits under the title.
  return `<div style="${DETAIL_SHELL}">
    <div class="cnpy-td-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 258px;gap:34px;min-height:${CARD_MIN_H}">
      <div style="min-width:0;display:flex;flex-direction:column">
        ${p.edit ? editBlock(p.edit) : `<div style="display:flex;align-items:flex-start;gap:10px;margin:0 0 22px">
          <h2 style="margin:0;flex:1;min-width:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(t.title)}</h2>
          <button data-act="ticketEdit" title="Edit title and description" aria-label="Edit title and description" class="cnpy-iconbtn" style="${ICON_BTN};flex:none;margin-top:3px">${PENCIL_SVG}</button>
        </div>
        ${ticketBody(t.body)}`}
        ${linkedWorkBlock(p)}
        ${p.artifactsBlock ?? ""}
        ${threadBlock(p)}
      </div>
      <div style="border-left:1px solid var(--border);padding-left:26px;display:flex;flex-direction:column;gap:26px">
        <div>
          <div style="${RAIL_SECTION_HEAD}"><div style="${MONO_EYEBROW}">Properties</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">STATUS</div><div style="min-width:0">${statusControl(t.status, p.stMenu === "rail", "rail")}</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">CATEGORY</div><div>${categoryChip(t.category)}</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">PRIORITY</div><div>${priorityChip(t.priority)}</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">REQUESTER</div><div style="display:flex;min-width:0">${personLink(linkable(p.persons, t.requester), t.requester, 20, t.requester === MIRROR_HANDLE && t.source_author ? `@${t.source_author}` : nameOf(p.persons, t.requester), "min-width:0;font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis")}</div></div>
          ${sourceRow(t)}
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">OPENED</div><div style="font-size:12.5px;color:var(--fg-70);white-space:nowrap">${esc(relTime(t.created_at))}</div></div>
        </div>
        ${assigneeRail(p)}
        ${sprintRail(p)}
        ${relationsRail(p)}
        ${t.source === "canopy" ? `<div>${dangerTrigger({ label: "Delete ticket", act: "ticketDeleteArm", armed: p.deleteArm === true, controls: "ticket-delete-confirm" })}</div>` : ""}
      </div>
    </div>
  </div>`;
}

/** The ticket page while its read is out: the title and body on the left, the rail's
 *  property rows on the right — the same grid, so the ticket lands in place. */
export function ticketDetailSkeleton(): string {
  const prop = (w: number | string) => `<div style="${PROP_ROW}">${skBar(48, 8)}${skBar(w, 10)}</div>`;
  return skeleton("ticket", "Loading the ticket&hellip;", `<div class="cnpy-td-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 258px;gap:34px;min-height:${CARD_MIN_H}">
      <div style="min-width:0">
        <div style="margin:0 0 22px">${skLine("58%", 22, 1.3)}</div>
        ${skProse(2)}
        <div style="margin-top:34px">${skLine(110, 10.5, 1.6)}</div>
        ${skList(2, (i) => `<div style="display:flex;gap:10px;margin-top:14px">${skBox(24, 24)}<span class="cnpy-skcol">${skLines([skW(i, ["30%", "24%"]), skW(i)], 13, 1.55)}</span></div>`)}
      </div>
      <div style="border-left:1px solid var(--border);padding-left:26px;display:flex;flex-direction:column;gap:26px">
        <div><div style="${RAIL_SECTION_HEAD}">${skBar(70, 8)}</div>${prop(84)}${prop(56)}${prop(50)}${prop(96)}${prop(64)}</div>
        <div><div style="${RAIL_SECTION_HEAD}">${skBar(64, 8)}</div><div style="display:flex;align-items:center;gap:8px;height:30px">${skBox(20, 20)}${skBar(90, 10)}</div></div>
        <div><div style="${RAIL_SECTION_HEAD}">${skBar(46, 8)}</div><div style="display:flex;align-items:center;height:30px">${skBar(120, 10)}</div></div>
      </div>
    </div>`, DETAIL_SHELL);
}

/** The ticket's delete confirmation modal. Only a native ticket gets one — a
 *  mirrored ticket has no Delete (the server 403s it): it follows its GitHub issue. */
export function ticketDeleteModal(t: Pick<TicketDetail, "id" | "title" | "children">, busy: boolean): string {
  const kids = t.children.length;
  return confirmModal({
    id: "ticket-delete-confirm", title: `Delete #${t.id} “${t.title}”?`,
    body: `Its comments, links and history are deleted with it, and this can't be undone.${kids ? ` Its ${kids === 1 ? "sub-ticket stays" : `${kids} sub-tickets stay`}, without a parent.` : ""}`,
    confirmAct: "ticketDelete", cancelAct: "ticketDeleteCancel", busy,
  });
}
