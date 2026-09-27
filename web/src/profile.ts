// People (Workspace › People): the directory (`#people`) and one person's profile
// (`#people/<handle>`), over `GET /persons` and `GET /api/people/:handle`
// (shared/people.ts). Purely presentational: props in, markup out.
//
// ONE RULE shapes the profile: `responsibilities` is NEVER rendered on a profile. It is
// what agents read when deciding whom to assign work, and it (with the role) is set only
// by an ADMIN in Maintenance › People (maintenance.ts `personRoleEditor`) — a person never
// edits their own. The profile's own action is "Edit profile" (Settings: photo, name).

import type { PersonSummary, PersonProfile, ProfileTicket } from "@shared/people";
import { TICKET_STATUSES, TICKET_PRIORITIES, type TicketStatus, type TicketPriority } from "@shared/tickets-core";
import { esc, attr, relTime, surface, DETAIL_SHELL, WORK_SHELL, asideHead, asideNote, statusBadge } from "./ui";
import { personChip, handleTag } from "./people";
import { ticketPill, priorityChip } from "./tickets";
import { renderMarkdownInline } from "./markdown";


// ── the directory ─────────────────────────────────────────────────────────────

/** The directory's search: every word of `q` in the name, handle or role (any case). */
export function peopleMatching(persons: PersonSummary[], q: string): PersonSummary[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return persons;
  return persons.filter((p) => {
    const hay = `${p.name ?? ""} ${p.handle} ${p.role ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface PeopleDirectoryProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  persons: PersonSummary[];
  q: string;
  /** The signed-in handle (its card carries YOU). */
  me: string;
}

const YOU = `<span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px;flex:none">YOU</span>`;
const SEARCH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none;color:var(--fg-40)"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>`;

function personCard(p: PersonSummary, me: string): string {
  const self = me !== "" && p.handle.toLowerCase() === me.toLowerCase();
  return `<button data-act="openPerson" data-arg="${attr(p.handle)}"${surface("display:flex;align-items:center;gap:13px;min-width:0;width:100%;text-align:left;padding:14px 16px", { hover: true })}>
    ${personChip(p, 44, p.handle)}
    <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
      <span style="display:flex;align-items:center;gap:8px;min-width:0"><span style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name || p.handle)}</span>${self ? YOU : ""}</span>
      <span style="font-size:12.5px;color:${p.role ? "var(--fg-70)" : "var(--fg-40)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.role ? esc(p.role) : "No role yet"}</span>
      ${handleTag(p, p.handle, 11.5)}
    </span>
  </button>`;
}

export function peopleDirectoryView(p: PeopleDirectoryProps): string {
  const rows = peopleMatching(p.persons, p.q);
  const search = `<div style="display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;max-width:420px;margin-bottom:18px">
      ${SEARCH_SVG}
      <input data-act="peopleQ" data-field="peopleQ" value="${attr(p.q)}" placeholder="Search by name, handle or role" aria-label="Search people" autocomplete="off" spellcheck="false" class="cnpy-input" style="flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--fg);font-size:13.5px" />
    </div>`;
  const body = p.status === "error" && !p.persons.length ? `<div style="font-size:13px;color:var(--fg-40);padding:6px 0">Couldn't load the team.</div>`
    : p.status !== "ok" && !p.persons.length ? `<div style="font-size:13px;color:var(--fg-40);padding:6px 0">Loading people&hellip;</div>`
    : !rows.length ? `<div style="font-size:13px;color:var(--fg-40);padding:6px 0">Nobody matches “${esc(p.q.trim())}”.</div>`
    : `<div class="cnpy-stagger cnpy-people-grid">${rows.map((x) => personCard(x, p.me)).join("")}</div>`;
  return `<div data-screen-label="People" style="${WORK_SHELL}">
    <div style="font-size:12.5px;color:var(--fg-55);margin:0 0 16px">Everyone on the team — what they do, and what they're working on.</div>
    ${search}${body}
  </div>`;
}

// ── one person's profile ──────────────────────────────────────────────────────

export interface PersonProfileProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  /** The handle the route names (shown while the read is in flight). */
  handle: string;
  profile: PersonProfile | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Joined Sep 2026" from an ISO timestamp (empty when unparseable). */
export function joinedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `Joined ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const asStatus = (s: string): TicketStatus | null => ((TICKET_STATUSES as readonly string[]).includes(s) ? (s as TicketStatus) : null);
const asPriority = (s: string): TicketPriority | null => ((TICKET_PRIORITIES as readonly string[]).includes(s) ? (s as TicketPriority) : null);

const GH_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"></path></svg>`;

const outlineBtn = (act: string, label: string, arg = ""): string =>
  `<button data-act="${attr(act)}"${arg ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-outlinebtn" style="flex:none;display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">${esc(label)}</button>`;

function profileHead(pr: PersonProfile): string {
  const meta: string[] = [];
  if (pr.admin) meta.push(statusBadge("ADMIN", "var(--accent)"));
  const joined = joinedLabel(pr.joined);
  if (joined) meta.push(`<span style="white-space:nowrap">${esc(joined)}</span>`);
  if (pr.github) {
    meta.push(`<a href="https://github.com/${encodeURIComponent(pr.github)}" target="_blank" rel="noopener noreferrer" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:5px;color:var(--fg-55);text-decoration:none;white-space:nowrap">${GH_SVG}<span style="font-family:var(--label)">${esc(pr.github)}</span></a>`);
  }
  // Self edits the photo and name in Settings; role is admin-set in Maintenance › People.
  const action = pr.self ? outlineBtn("goSettings", "Edit profile") : "";
  return `<div class="cnpy-profile-head cnpy-rise" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    ${personChip(pr, 88, pr.handle)}
    <div style="flex:1 1 260px;min-width:0">
      <h2 style="margin:0;font-size:24px;font-weight:600;letter-spacing:-0.02em;overflow-wrap:anywhere">${esc(pr.name || pr.handle)}</h2>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-top:6px">
        ${handleTag(pr, pr.handle, 13)}
        ${pr.role ? `<span style="font-size:13.5px;color:var(--fg-70)">${esc(pr.role)}</span>` : ""}
      </div>
      ${meta.length ? `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:12px;color:var(--fg-40)">${meta.join("")}</div>` : ""}
    </div>
    ${action}
  </div>`;
}

function ticketRow(t: ProfileTicket): string {
  const st = asStatus(t.status);
  const pri = asPriority(t.priority);
  return `<button data-act="openTicket" data-arg="${t.id}" class="mw-row" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:11px 18px;border-top:1px solid var(--border)">
    <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-40);flex:none;min-width:34px">#${t.id}</span>
    <span style="flex:1;min-width:0;font-size:13.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</span>
    <span style="display:inline-flex;align-items:center;gap:8px;flex:none">${pri ? `<span class="cnpy-profile-opt">${priorityChip(pri)}</span>` : ""}${st ? ticketPill(st) : ""}<span class="cnpy-profile-opt" style="font-size:12px;color:var(--fg-40);white-space:nowrap;min-width:52px;text-align:right">${esc(relTime(t.updated_at))}</span></span>
  </button>`;
}

function ticketsBox(pr: PersonProfile): string {
  const first = (pr.name || pr.handle).split(/\s+/)[0];
  const n = Math.max(pr.ticketsOpen, pr.tickets.length);
  const head = `<div style="display:flex;align-items:baseline;gap:10px;padding:14px 18px 10px"><span style="font-size:14px;font-weight:500">Open tickets</span><span style="font-size:12.5px;color:var(--fg-40)">${n}</span></div>`;
  const body = pr.tickets.length
    ? pr.tickets.map(ticketRow).join("")
      + (n > pr.tickets.length ? `<div style="padding:10px 18px 12px;border-top:1px solid var(--border);font-size:12.5px;color:var(--fg-40)">${n - pr.tickets.length} more assigned — the queue's Filter › Assignee lists them all.</div>` : "")
    : asideNote(pr.self ? "Nothing assigned to you right now." : `Nothing assigned to ${esc(first)} right now.`);
  return `<section${surface("overflow:hidden;--i:1", { cls: "cnpy-rise" })}>${head}${body}</section>`;
}

function sessionsBox(pr: PersonProfile): string {
  const rows = pr.sessions.map((x) => `<button data-act="personFeed" data-arg="${attr(pr.handle)}" class="mw-row" style="display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:10px 18px;border-top:1px solid var(--border)">
      <span class="cnpy-md-inline" style="font-size:13.5px;font-weight:500;line-height:1.45;color:var(--fg);text-wrap:pretty">${renderMarkdownInline(x.summary)}</span>
      <span style="font-size:12px;color:var(--fg-40)">${esc(relTime(x.created_at))}</span>
    </button>`).join("");
  const link = pr.sessions.length ? { act: "personFeed", label: "In the feed", arg: pr.handle } : undefined;
  return `<section${surface("overflow:hidden;--i:2", { cls: "cnpy-rise" })}>${asideHead("Recent sessions", link)}${rows || asideNote("No sessions recorded yet.")}</section>`;
}

function docsBox(pr: PersonProfile): string {
  const rows = pr.docs.map((d) => `<button data-act="openDocFrom" data-arg="${attr(d.slug)}" class="mw-row" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 18px;border-top:1px solid var(--border)">
      <span style="flex:1;min-width:0;font-size:13.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.title)}</span>
      <span style="font-size:12px;color:var(--fg-40);white-space:nowrap">${esc(relTime(d.updated_at))}</span>
    </button>`).join("");
  return `<section${surface("overflow:hidden;--i:3", { cls: "cnpy-rise" })}>${asideHead("Docs they own")}${rows || asideNote("No docs yet.")}</section>`;
}

export function personProfileView(p: PersonProfileProps): string {
  const pr = p.profile;
  if (!pr) {
    const msg = p.status === "error" ? "Couldn't load this profile."
      : p.status === "ok" ? `There's nobody called @${esc(p.handle)} here.`
      : "Loading profile&hellip;";
    return `<div data-screen-label="Profile" style="${DETAIL_SHELL}"><div style="font-size:13px;color:var(--fg-40);padding:8px 0">${msg}</div>${p.status === "ok" ? `<div style="margin-top:12px">${outlineBtn("goPeople", "Everyone on the team")}</div>` : ""}</div>`;
  }
  return `<div data-screen-label="Profile" style="${DETAIL_SHELL}">
    ${profileHead(pr)}
    <div class="cnpy-profile-grid">
      <div style="min-width:0">${ticketsBox(pr)}</div>
      <div style="display:flex;flex-direction:column;gap:14px;min-width:0">${sessionsBox(pr)}${docsBox(pr)}</div>
    </div>
  </div>`;
}
