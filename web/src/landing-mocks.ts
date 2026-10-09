// ── The tour's dialog mockups: each screen, drawn at the dialog's size ───────
// The landing page's tour rows carry a small teaser mockup (landing.ts). When a row is opened
// (`featureDialog`), the dialog has room for the screen itself, so each of the seven gets a fuller
// drawing here, built from what the REAL screen shows — its header controls, its section titles,
// its chips and their wording. Where the product exports the words, they are imported (a rename
// then changes the mock, and the test that pins them); the rest is copied from the renderer named
// beside each mock, and must be changed with it:
//
//   docs ...... render.ts `docsView`: the tree's sections, the open doc's outline, the STAGED
//               banner ("You're viewing the promoted version…" / Review proposal), Version history
//   feed ...... render.ts `feedView`: Filter, For reading / For agents, an entry's brief, agent
//               mark and PR / commit / issue chips; the aside's This week and Waiting on review
//   tickets ... tickets.ts `boardView` / `boardCard` and `tableView` / `groupHeader` / `tableRow`
//   roadmap ... timeline.ts `timelineView`: legend, the summary strip, lanes by status, state tags
//   mywork .... mywork.ts `ticketsTile`, `reviewTile`, `sessionsTile`, `repoTile`
//   handoffs .. handoffs.ts `handoffsView` (the two sections, the row) and `handoffDetail`
//               ("Where it stands")
//   artifacts . artifacts.ts viewer: the version picker, Draft / Published / Ratified, New version,
//               the Org switch, Linked work; `diffView`'s "Compare versions"
//
// Rules: a mock shows NOTHING the product does not have; it is inert (the dialog wraps it in
// `aria-hidden`, and nothing here is a button, a link or carries `data-act`); it draws with the
// theme tokens only, so the dark theme shows the dark app; and its sample data is the page's own
// fictional team (Maya Chen, Leo Park, Sam Ortiz; tickets #209–#230; PR #142; ADR-0012).
// Layout lives in trov.css (`.fxm*`): one window that fills the dialog's stage, panes that fold
// under 640px (`.fxm-wide` is the pane a phone drops).

import { TICKET_STATUSES, TICKET_STATUS_LABEL, type TicketStatus } from "@shared/tickets-core";
import { ARTIFACT_STATUSES } from "@shared/artifacts-core";

export const MOCK_KEYS = ["docs", "feed", "tickets", "roadmap", "mywork", "handoffs", "artifacts"] as const;
export type MockKey = (typeof MOCK_KEYS)[number];

// ── shared pieces (the page's small mockups use these too) ───────────────────
const LBL = "font-family:var(--label);font-weight:600;letter-spacing:.08em;text-transform:uppercase";
/** A label-face status pill; `c` is a color var name (green / amber / blue / red / fg-55). */
export function pill(text: string, c: string, size = "8.5px", pad = "1.5px 5px"): string {
  const edge = c === "fg-55" ? "var(--border-strong)" : `color-mix(in srgb, var(--${c}) 45%, transparent)`;
  const fill = c === "fg-55" ? "transparent" : `color-mix(in srgb, var(--${c}) 11%, transparent)`;
  return `<span style="font-family:var(--label);font-size:${size};font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--${c});border:1px solid ${edge};background:${fill};border-radius:4px;padding:${pad};flex:none;white-space:nowrap">${text}</span>`;
}
/** A person's initials tile. The page's people: MC (Maya Chen), LP (Leo Park), SO (Sam Ortiz). */
const PERSON_COLOR: Record<string, string> = { MC: "accent", LP: "blue", SO: "amber" };
export function initials(text: string, size = 26, font = "10px"): string {
  const c = PERSON_COLOR[text] ?? "accent";
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;background:color-mix(in srgb, var(--${c}) 16%, transparent);color:var(--${c});font-size:${font};font-weight:600;display:grid;place-items:center;flex:none">${text}</span>`;
}
export const AGENT_TAG = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 5px;white-space:nowrap"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M12 8V4M8 13h.01M16 13h.01"></path></svg>agent</span>`;
const GH = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="flex:none;color:var(--fg-40)"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`;
const ARROW = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`;
const DOT = (c: string, size = 7) => `<span style="width:${size}px;height:${size}px;border-radius:2px;background:var(--${c});flex:none"></span>`;
const SEP = `<span style="color:var(--fg-40)">·</span>`;
const cap = (text: string, size = "9.5px", color = "fg-40") => `<span style="${LBL};font-size:${size};color:var(--${color})">${text}</span>`;
/** A header button as the app draws it: the accent one (Submit a ticket, New sprint) or the outline one. */
const hbtn = (label: string, accent = false) =>
  `<span style="display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:7px;font-size:11.5px;font-weight:600;white-space:nowrap;${accent ? "background:var(--accent);color:var(--accent-fg)" : "border:1px solid var(--border-strong);color:var(--fg-70)"}">${accent ? "+ " : ""}${label}</span>`;
/** A pick-one switch (segmented.ts), drawn still. */
const seg = (options: string[], on: number) =>
  `<span style="display:inline-flex;border:1px solid var(--border);border-radius:7px;padding:2px;gap:2px;font-size:11px;font-weight:500">${options.map((o, i) => `<span style="padding:3px 9px;border-radius:5px;white-space:nowrap;${i === on ? "background:var(--hover);color:var(--fg)" : "color:var(--fg-55)"}">${o}</span>`).join("")}</span>`;
/** One screen: its header line (the title and the screen's own controls), then its body. */
function win(title: string, right: string, body: string, grow = true): string {
  return `<div class="fxm" style="border-radius:12px${grow ? "" : ";flex:none"}">
    <div class="fxm-head"><span style="font-size:13px;font-weight:600">${title}</span><span style="margin-left:auto;display:flex;align-items:center;gap:7px">${right}</span></div>
    <div class="fxm-body">${body}</div>
  </div>`;
}
const SURF = "border:1px solid var(--border);background:var(--surface);border-radius:9px";

// ── Docs: the tree with the open doc's outline, the reader, the staged banner ──
function docsMock(): string {
  const sec = (t: string, top = 14) => `<div style="padding:${top}px 6px 5px">${cap(t, "9px")}</div>`;
  const row = (t: string, on = false, open = false) => `<div style="padding:4px 6px;font-size:11.5px;${on ? "color:var(--accent);font-weight:500" : "color:var(--fg-70)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${open ? "▾" : "▸"} ${t}</div>`;
  const sub = (t: string, on = false) => `<div style="padding:3px 6px 3px 22px;font-size:11px;color:var(--${on ? "accent" : "fg-55"})">${t}</div>`;
  const tree = `<div class="fxm-wide" style="width:176px;flex:none;border-right:1px solid var(--border);padding:2px 8px 12px;overflow:hidden">
      ${sec("Operations", 10)}${row("Deploy process", true, true)}${sub("Before you merge")}${sub("Migrations", true)}${sub("Rollbacks")}${row("Onboarding checklist")}${row("Incident runbook")}
      ${sec("Architecture")}${row("Rate limiting on the public API")}${row("Webhook delivery")}
      ${sec("Decisions")}${row("ADR-0012 · Retry budget")}${row("ADR-0009 · Token bucket per org")}
    </div>`;
  const reader = `<div style="flex:1;min-width:0;padding:14px 18px 16px;overflow:hidden">
      <div style="${SURF};display:flex;align-items:center;gap:10px;padding:9px 12px">
        ${pill("staged", "amber", "9px", "2px 6px")}
        <span style="flex:1;min-width:0;font-size:11.5px;line-height:1.45;color:var(--fg-70)">You're viewing the <b style="font-weight:600;color:var(--fg)">promoted</b> version. A newer proposal is awaiting review.</span>
        <span style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:500;color:var(--accent);white-space:nowrap">Review proposal ${ARROW}</span>
      </div>
      <div style="margin-top:16px">${cap("Technical <span style=\"opacity:.5\">/</span> Operations", "9px")}</div>
      <div style="margin-top:6px;font-size:22px;font-weight:650;letter-spacing:-0.02em">Deploy process</div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;padding-bottom:12px;border-bottom:1px solid var(--border)">
        ${initials("LP", 20, "8px")}<span style="font-size:11.5px;color:var(--fg-55)">Updated by <span style="color:var(--blue)">@leo</span> · 2d ago</span>
        <span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:6px;padding:3px 8px;white-space:nowrap"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path></svg>Version history</span>
      </div>
      <div style="margin-top:14px;font-size:14.5px;font-weight:600">Before you merge</div>
      <div style="margin-top:6px;font-size:12.5px;line-height:1.7;color:var(--fg-70)">Open a PR and get one review. CI runs typecheck and tests on every push; a red check blocks the merge.</div>
      <div style="margin-top:14px;font-size:14.5px;font-weight:600">Migrations</div>
      <div style="margin-top:6px;font-size:12.5px;line-height:1.7;color:var(--fg-70)">Merges to main deploy automatically. CI applies D1 migrations before the deploy step, so schema and code always land together.</div>
      <div style="margin-top:10px;border:1px solid var(--border);border-radius:8px;background:var(--hover);padding:9px 12px;font-family:var(--code);font-size:11px;line-height:1.7;color:var(--fg-70)">npm run db:migrate:remote<br>npm run deploy</div>
      <div style="margin-top:14px;font-size:14.5px;font-weight:600">Rollbacks</div>
      <div style="margin-top:6px;font-size:12.5px;line-height:1.7;color:var(--fg-70)">Redeploy the previous tag. Migrations are forward-only.</div>
    </div>`;
  return win("Docs", hbtn("New doc"), `<div style="display:flex;height:100%">${tree}${reader}</div>`);
}

// ── Feed: entries with their brief and links, beside This week and Waiting on review ──
function feedMock(): string {
  const ref = (kind: string, id: string) => `<span style="border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-family:var(--label);font-size:10px;white-space:nowrap"><span style="color:var(--fg-40)">${kind}</span> <span style="color:var(--fg-70)">${id}</span></span>`;
  const entry = (who: string, handle: string, c: string, title: string, brief: string, when: string, agent: boolean, refs: string) => `<div style="${SURF};padding:12px 14px;display:flex;gap:11px">
      ${initials(who)}
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:600;line-height:1.35">${title}</div>
        <div style="margin-top:3px;font-size:11.5px;line-height:1.55;color:var(--fg-70)">${brief}</div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--fg-55)"><span style="color:var(--${c})">${handle}</span>${agent ? AGENT_TAG : ""}${SEP}${when}</div>
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap">${refs}</div>
      </div>
    </div>`;
  const asideHead = (t: string, link: string) => `<div style="display:flex;align-items:baseline;padding:11px 13px 0"><span style="font-size:12.5px;font-weight:600">${t}</span><span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fg-40);white-space:nowrap">${link} ${ARROW}</span></div>`;
  const waiting = (title: string, kind: string, c: string, who: string, when: string) => `<div style="padding:8px 13px;border-top:1px solid var(--border)"><div style="font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div><div style="margin-top:3px;display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--fg-55)">${DOT(c, 6)}${kind}${SEP}${who}${SEP}${when}</div></div>`;
  const body = `<div style="display:flex;gap:12px;padding:14px;height:100%;box-sizing:border-box">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:10px">
        ${entry("LP", "@leo", "blue", "Rate limiting shipped on the public API", "Each organization now has its own request budget. A caller that goes over is told when to try again.", "1d ago", true, `${ref("PR", "#142")}${ref("commit", "3f2a9c1")}${ref("issue", "#128")}`)}
        ${entry("SO", "@sam", "amber", "Tickets move freely on the board", "Drag a ticket to any column. The order you leave it in is saved for everyone.", "3d ago", false, `${ref("PR", "#139")}${ref("commit", "b81e04d")}`)}
        ${entry("MC", "@maya", "accent", "Email digests de-duplicate on Mondays", "The Monday digest no longer repeats Friday's entries.", "5d ago", true, `${ref("PR", "#137")}${ref("issue", "#218")}`)}
      </div>
      <div class="fxm-wide" style="width:190px;flex:none;display:flex;flex-direction:column;gap:10px">
        <div style="${SURF};overflow:hidden">${asideHead("This week", "Everything this week")}
          <div style="padding:3px 13px 10px;font-size:10.5px;color:var(--fg-55)">Whole team, last 7 days</div>
          <div style="display:flex;align-items:baseline;gap:6px;padding:0 13px 9px"><span style="font-size:19px;font-weight:500;line-height:1">6</span><span style="font-size:11px;color:var(--fg-55)">entries · 3 people</span></div>
          <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px;padding:0 13px 11px">${[0, 40, 100, 0, 60, 40, 60].map((h, i) => `<span style="display:flex;flex-direction:column;gap:4px"><span style="display:flex;align-items:flex-end;height:30px;background:var(--hover)">${h ? `<span style="display:block;width:100%;height:${h}%;background:var(--accent)"></span>` : ""}</span><span style="text-align:center;font-size:9.5px;line-height:1;color:var(--fg-40)">${"FSSMTWT"[i]}</span></span>`).join("")}</div>
          <div style="padding:8px 13px 10px;border-top:1px solid var(--border)"><div style="font-size:10.5px;font-weight:500;color:var(--fg-40);margin-bottom:6px">Top tags</div><div style="display:flex;gap:5px;flex-wrap:wrap">${[["api", 3], ["ui", 2], ["infra", 1]].map(([t, n]) => `<span style="border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-size:10.5px;color:var(--fg-70)">${t} <span style="color:var(--fg-40)">${n}</span></span>`).join("")}</div></div>
        </div>
        <div style="${SURF};overflow:hidden">${asideHead("Waiting on review", "Review")}
          <div style="padding:3px 13px 10px;font-size:10.5px;color:var(--fg-55)"><b style="color:var(--fg);font-weight:600">2</b> waiting · 1 proposal, 1 decision</div>
          ${waiting("Deploy process", "Proposal", "amber", "@maya", "2h")}
          ${waiting("ADR-0012 · Retry budget", "Decision", "blue", "@leo", "1d")}
        </div>
      </div>
    </div>`;
  return win("Feed", `${hbtn("Filter")}${seg(["For reading", "For agents"], 0)}`, body);
}

// ── Tickets: the board (a column per status) over the table (grouped by sprint) ──
const STATUS_COLOR: Record<TicketStatus, string> = { submitted: "blue", in_progress: "accent", testing: "amber", done: "fg-55", declined: "fg-55" };
function ticketsMock(): string {
  const nobody = `<span style="font-size:10.5px;color:var(--fg-40);font-style:italic">Unassigned</span>`;
  const card = (title: string, id: number, prio: "" | "High" | "Low", who: string, mirrored = false) => `<div style="${SURF};padding:8px 9px">
      <div style="font-size:11.5px;font-weight:600;line-height:1.35">${title}</div>
      <div style="margin-top:7px;display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--fg-40);min-height:18px">#${id}${prio ? `${SEP}<span style="font-weight:${prio === "High" ? "600;color:var(--fg)" : "500"}">${prio}</span>` : ""}${mirrored ? GH : ""}<span style="margin-left:auto;display:flex">${who ? initials(who, 18, "7.5px") : nobody}</span></div>
    </div>`;
  const cards: Record<TicketStatus, string[]> = {
    submitted: [card("Email digest lands twice on Mondays", 218, "", ""), card("Onboarding checklist is stale", 230, "Low", "SO", true)],
    in_progress: [card("Rate limiting on the public API", 212, "High", "LP")],
    testing: [card("Retry-After on 429 responses", 213, "", "MC")],
    done: [card("SSO step in the checklist", 209, "", "SO")],
    declined: [card("Per-user rate limits", 205, "", "")],
  };
  const column = (s: TicketStatus, i: number) => `<div${i > 2 ? ` class="fxm-wide"` : ""} style="min-width:0;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;padding-bottom:5px;border-bottom:1px solid var(--border)">${cap(TICKET_STATUS_LABEL[s], "8.5px", STATUS_COLOR[s])}<span style="margin-left:auto;font-size:10px;color:var(--fg-40)">${cards[s].length}</span></div>
      ${cards[s].join("")}
    </div>`;
  const board = `<div class="fxm-board">${TICKET_STATUSES.map(column).join("")}</div>`;

  const COLS = "minmax(0,2.3fr) 62px 88px minmax(0,1fr)";
  const group = (name: string, meta: string, count: string, active: boolean) => `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px 4px">${DOT(active ? "accent" : "border-strong")}${cap(name, "9px", active ? "accent" : "fg-55")}<span style="font-size:10px;color:var(--fg-40);white-space:nowrap">${meta}</span><span style="flex:1;height:1px;background:var(--border)"></span><span style="font-size:10px;color:var(--fg-40);white-space:nowrap">${count}</span></div>`;
  const trow = (title: string, chip: string, prio: string, s: TicketStatus, who: string) => `<div style="display:grid;grid-template-columns:${COLS};gap:10px;align-items:center;padding:6px 14px">
      <span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>${chip ? `<span style="font-size:9.5px;color:var(--fg-55);border:1px solid var(--border);border-radius:4px;padding:1px 6px;white-space:nowrap;flex:none">${chip}</span>` : ""}</span>
      <span>${pill(prio, prio === "high" ? "fg" : "fg-55")}</span>
      <span>${pill(TICKET_STATUS_LABEL[s], s === "done" || s === "declined" ? "fg-55" : s === "in_progress" ? "accent" : STATUS_COLOR[s])}</span>
      <span style="display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;color:var(--fg-70)">${who ? `${initials(who, 18, "7.5px")}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${who === "LP" ? "Leo" : who === "MC" ? "Maya" : "Sam"}</span>` : nobody}</span>
    </div>`;
  const table = `<div style="${SURF};overflow:hidden;margin:0 12px 12px">
      <div style="display:grid;grid-template-columns:${COLS};gap:10px;padding:8px 14px 7px;border-bottom:1px solid var(--border)">${cap("Title", "8.5px")}${cap("Priority", "8.5px")}${cap("Status", "8.5px")}${cap("Assignee", "8.5px")}</div>
      ${group("Hardening the public API", "Sep 22 – Oct 12 · <span style=\"color:var(--accent);font-weight:600\">ACTIVE</span>", "2 tickets", true)}
      ${trow("Rate limiting on the public API", "1 sub", "high", "in_progress", "LP")}
      ${trow("Retry-After on 429 responses", "↳ sub-ticket", "normal", "testing", "MC")}
      ${group("Backlog", "NO SPRINT", "2 tickets", false)}
      ${trow("Email digest lands twice on Mondays", "", "normal", "submitted", "")}
      ${trow("Onboarding checklist is stale", "GitHub #230", "low", "submitted", "SO")}
    </div>`;
  const head = (on: number) => `${seg(["Board", "Table"], on)}${hbtn("Submit a ticket", true)}`;
  // Two views of ONE queue: the screen shows one at a time (its Board / Table switch).
  return `<div class="fxm-stack">${win("Tickets", head(0), board, false)}<div class="fxm-wide" style="display:flex;flex:1;min-height:0">${win("Tickets", head(1), `<div style="padding-top:12px">${table}</div>`)}</div></div>`;
}

// ── Roadmap › Timeline: sprints on the calendar, by status ───────────────────
function roadmapMock(): string {
  const stat = (n: string, label: string, c = "fg") => `<div><div style="font-size:19px;font-weight:650;line-height:1;color:var(--${c})">${n}</div><div style="margin-top:5px">${cap(label, "8px")}</div></div>`;
  const legend = (c: string, t: string) => `<span style="display:inline-flex;align-items:center;gap:5px">${DOT(c, 6)}${t}</span>`;
  const month = (label: string, left: number) => `<span style="position:absolute;left:${left}%;font-size:10px;font-weight:500;color:var(--fg-40)">${label}</span>`;
  const lane = (label: string, n: number, c: string) => `<div style="display:flex;align-items:center;gap:7px;margin-top:10px">${DOT(c, 6)}${cap(label, "9px", "fg-70")}<span style="font-size:10px;color:var(--fg-40)">${n}</span></div>`;
  const TONE: Record<string, [string, string]> = { Overdue: ["red", "red"], "In progress": ["accent", "accent"], Ready: ["accent", "accent"], Upcoming: ["fg-55", "fg-55"], Done: ["green", "green"] };
  const sprint = (who: string, tag: keyof typeof TONE & string, when: string, range: string, name: string, left: number, width: number, pct: number, count: string, side: "l" | "r" = "r") => {
    const [c] = TONE[tag];
    const label = `<span class="fxm-lab" style="position:absolute;top:0;bottom:0;display:flex;align-items:center;font-size:11px;font-weight:600;white-space:nowrap;${side === "r" ? `left:calc(${left + width}% + 7px)` : `right:calc(${100 - left}% + 7px)`}">${name}</span>`;
    return `<div class="fxm-sprint" style="display:flex;align-items:center;gap:10px;margin-top:7px">
      <div class="fxm-wide" style="width:150px;flex:none;display:flex;align-items:center;gap:8px">${initials(who, 20, "8px")}<div style="min-width:0"><div style="display:flex;align-items:center;gap:6px">${pill(tag, c, "8px", "1px 5px")}<span style="font-size:10.5px;font-weight:500;color:var(--${tag === "Overdue" ? "red" : "fg-70"});white-space:nowrap">${when}</span></div><div style="margin-top:3px;font-size:10px;color:var(--fg-40);white-space:nowrap">${range}</div></div></div>
      <div style="position:relative;flex:1;height:26px">
        <div style="position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;border:1px solid color-mix(in srgb, var(--${c}) 50%, transparent);background:color-mix(in srgb, var(--${c}) 9%, transparent);border-radius:6px;overflow:hidden">
          <span style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:color-mix(in srgb, var(--${c}) 26%, transparent)"></span>
          <span style="position:relative;display:flex;align-items:center;justify-content:center;height:100%;font-size:9.5px;font-weight:600;color:var(--fg-70)">${count}</span>
        </div>
        ${label}
      </div>
    </div>`;
  };
  const body = `<div style="padding:0 16px 14px">
      <div style="display:flex;gap:18px;border-bottom:1px solid var(--border);font-size:12px;font-weight:500"><span style="padding:10px 0;color:var(--fg-55)">Narrative</span><span style="padding:10px 0;color:var(--fg);box-shadow:0 2px 0 var(--accent);display:inline-flex;align-items:center;gap:6px">Timeline${DOT("red", 6)}</span></div>
      <div style="margin-top:12px;font-size:10.5px;color:var(--fg-55)">Timeline</div>
      <div style="margin-top:2px;font-size:15px;font-weight:500;letter-spacing:-0.01em">Sprints on the calendar</div>
      <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--fg-55)">${legend("green", "Done")}${legend("accent", "In progress")}${legend("fg-55", "Upcoming")}${legend("red", "Overdue")}<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:2px;height:10px;background:var(--red)"></span>Today</span></div>
      <div style="margin-top:12px;${SURF};display:flex;align-items:stretch;flex-wrap:wrap">
        <div style="display:flex;gap:14px;padding:11px 12px">${stat("3", "In progress")}${stat("1", "Upcoming")}${stat("1", "Done")}${stat("1", "Overdue", "red")}</div>
        <div class="fxm-wide" style="padding:11px 12px;border-left:1px solid var(--border)">${cap("Next due", "8px")}<div style="margin-top:4px;font-size:13px;font-weight:600">Oct 12 <span style="font-size:10.5px;font-weight:400;color:var(--fg-55)">in 3d</span></div><div style="margin-top:2px;font-size:10.5px;color:var(--fg-55)">Hardening the public API</div></div>
        <div style="flex:1 1 190px;min-width:0;padding:11px 12px;border-left:1px solid var(--border);white-space:nowrap;overflow:hidden">${cap("Tickets done · scheduled sprints", "8px")}<div style="margin-top:4px;font-size:13px;font-weight:600">13/23 <span style="font-size:10.5px;font-weight:400;color:var(--fg-55)">57%</span></div><div style="margin-top:6px;height:3px;background:var(--border)"><div style="width:57%;height:100%;background:var(--accent)"></div></div></div>
      </div>
      <div class="fxm-lanes" style="position:relative;margin-top:11px">
        <span style="position:absolute;z-index:1;top:16px;bottom:0;width:1.5px;background:var(--red);opacity:.8;left:calc(var(--lab) + (100% - var(--lab)) * .57)"></span>
        <div style="display:flex;gap:10px"><div class="fxm-wide" style="width:150px;flex:none"></div><div style="position:relative;flex:1;height:14px">${month("Aug", 0)}${month("Sep", 25)}${month("Oct", 50)}${month("Nov", 75)}</div></div>
        ${lane("In progress", 3, "accent")}
        ${sprint("LP", "In progress", "due in 3d", "Sep 22 – Oct 12", "Hardening the public API", 43, 16, 66, "4/6")}
        ${sprint("SO", "Ready", "all tickets closed", "Sep 15 – Oct 10", "Digest preferences", 37, 20, 100, "3/3")}
        ${sprint("MC", "Overdue", "6d overdue", "Sep 1 – Oct 3", "Notifications and digests", 26, 26, 37, "3/8")}
        ${lane("Upcoming", 1, "fg-55")}
        ${sprint("SO", "Upcoming", "starts in 11d", "Oct 20 – Nov 14", "Self-host guide", 66, 20, 0, "0/3", "l")}
        ${lane("Done", 1, "green")}
        ${sprint("LP", "Done", "", "Aug 4 – Aug 29", "Token rotation and audit log", 2, 20, 100, "3/3")}
      </div>
    </div>`;
  return win("Roadmap", hbtn("New sprint", true), body);
}

// ── My Work: the four tiles ──────────────────────────────────────────────────
function myworkMock(): string {
  const tileHead = (title: string, link: string, dot = false) => `<div style="display:flex;align-items:baseline;padding:11px 13px 0"><span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600">${dot ? DOT("accent", 6) : ""}${title}</span><span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fg-40);white-space:nowrap">${link} ${ARROW}</span></div>`;
  const sub = (html: string) => `<div style="padding:3px 13px 10px;font-size:10.5px;color:var(--fg-55)">${html}</div>`;
  const ticket = (prio: string, title: string, status: TicketStatus, sprint: string, due: string, c: string) => `<div style="display:flex;gap:10px;padding:8px 13px;border-top:1px solid var(--border)"><span style="width:38px;flex:none;font-size:10.5px;font-weight:${prio === "High" ? 600 : 500};color:var(--${prio === "High" ? "fg" : "fg-40"});padding-top:1px">${prio}</span><span style="min-width:0"><span style="display:block;font-size:12px;font-weight:600;line-height:1.35">${title}</span><span style="margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10.5px;color:var(--fg-55)">${DOT(STATUS_COLOR[status], 6)}${TICKET_STATUS_LABEL[status]}${SEP}${sprint}${SEP}<span style="color:var(--${c})">${due}</span></span></span></div>`;
  const review = (title: string, badge: string, c: string, kind: string, when: string, accept: string) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 13px;border-top:1px solid var(--border)"><span style="flex:1;min-width:0"><span style="display:block;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span><span style="margin-top:3px;display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--fg-55)">${DOT(c, 6)}<span style="${LBL};font-size:9.5px;letter-spacing:.04em">${badge}</span>${SEP}${kind}${SEP}${when}</span></span><span style="height:22px;padding:0 8px;border:1px solid var(--border);border-radius:6px;font-size:10.5px;font-weight:500;color:var(--fg-70);display:inline-flex;align-items:center">Reject</span><span style="height:22px;padding:0 8px;border-radius:6px;background:var(--accent);color:var(--accent-fg);font-size:10.5px;font-weight:500;display:inline-flex;align-items:center">${accept}</span></div>`;
  const session = (title: string, when: string) => `<div style="display:flex;align-items:baseline;gap:10px;padding:8px 13px;border-top:1px solid var(--border)"><span style="flex:1;min-width:0;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span><span style="font-size:10.5px;color:var(--fg-40);white-space:nowrap">${when}</span></div>`;
  const pr = (title: string, ref: string, when: string, c: string) => `<div style="display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 13px;border-top:1px solid var(--border)">${DOT(c, 6)}<span style="min-width:0;display:flex;align-items:baseline;gap:7px"><span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span><span style="font-family:var(--label);font-size:10.5px;color:var(--fg-40);flex:none">${ref}</span></span><span style="font-size:10.5px;color:var(--fg-40);white-space:nowrap">${when}</span></div>`;
  const body = `<div style="padding:16px 16px 14px">
      <div style="font-size:19px;font-weight:650;letter-spacing:-0.015em">Good morning, Maya</div>
      <div style="margin-top:3px;font-size:11.5px;color:var(--fg-55)">Thursday, October 9 · 2 tickets open, 2 to review, 1 handoff waiting</div>
      <div class="fxm-tiles" style="margin-top:14px">
        <div style="${SURF};overflow:hidden">${tileHead("Tickets for you", "Queue")}${sub(`2 open · <span style="color:var(--amber)">1 due this week</span>`)}
          ${ticket("Normal", "Retry-After on 429 responses", "testing", "Hardening the public API", "due Oct 12", "amber")}
          ${ticket("High", "Digest de-dupe on Mondays", "in_progress", "Notifications and digests", "overdue Oct 3", "red")}
        </div>
        <div style="${SURF};overflow:hidden">${tileHead("Needs your review", "View all", true)}
          <div style="display:flex;align-items:baseline;gap:8px;padding:2px 13px 10px"><span style="font-size:22px;font-weight:650;line-height:1.1">2</span><span style="font-size:10.5px;color:var(--fg-55)">1 to promote, 1 to ratify</span></div>
          ${review("Deploy process", "Staged", "amber", "Proposal", "2h", "Promote")}
          ${review("ADR-0012 · Retry budget", "Draft", "blue", "Decision", "1d", "Ratify")}
        </div>
        <div style="${SURF};overflow:hidden">${tileHead("Your sessions", "Feed")}${sub("1 handoff waiting for a fresh session")}
          ${session("Email digests de-duplicate on Mondays", "Oct 4")}
          ${session("Digest preferences moved to Settings", "Oct 1")}
          <div style="margin:8px 13px 12px;border:1px solid color-mix(in srgb, var(--blue) 40%, transparent);background:color-mix(in srgb, var(--blue) 7%, transparent);border-radius:7px;padding:8px 10px;display:flex;gap:7px;font-size:11.5px;line-height:1.45"><span style="margin-top:4px">${DOT("blue", 6)}</span><span><span style="${LBL};font-size:9.5px;color:var(--blue)">For you</span> Retry-After is wired, the tests aren't</span></div>
        </div>
        <div class="fxm-wide" style="${SURF};overflow:hidden"><div style="display:flex;align-items:baseline;padding:11px 13px 0"><span style="font-size:12.5px;font-weight:600">Repo</span><span style="margin-left:7px;font-size:10.5px;color:var(--fg-40)">acme/api</span><span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fg-40)">Dashboard ${ARROW}</span></div>
          <div style="padding:8px 13px 10px">${seg(["PRs", "CI", "Deploys"], 0)}</div>
          ${pr("Retry-After on 429 responses", "#145", "2h", "green")}
          ${pr("Digest de-dupe on Mondays", "#144", "1d", "amber")}
        </div>
      </div>
    </div>`;
  return win("My Work", "", body);
}

// ── Handoffs: the list, and one opened to "Where it stands" ──────────────────
function handoffsMock(): string {
  const anyone = `<span style="width:18px;height:18px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:8px;font-weight:600;color:var(--fg-40);flex:none">–</span>`;
  const state = (s: "pending" | "claimed" | "expired") => pill(s, s === "pending" ? "blue" : s === "expired" ? "red" : "fg-55", "8.5px", "2px 6px");
  const row = (id: number, title: string, prompt: boolean, dir: "From" | "To", who: string, name: string, s: "pending" | "claimed" | "expired", when: string) => `<div style="display:grid;grid-template-columns:minmax(0,2.4fr) minmax(0,1fr) auto 46px;gap:10px;align-items:center;padding:9px 13px;border-top:1px solid var(--border)">
      <span style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);flex:none">#${id}</span><span style="font-size:12px;font-weight:${s === "pending" ? 600 : 500};color:var(--${s === "pending" ? "fg" : "fg-55"});overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>${prompt ? `<span class="fxm-wide" style="font-family:var(--label);font-size:9px;font-weight:600;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px;white-space:nowrap;flex:none">+ prompt</span>` : ""}</span>
      <span style="display:flex;align-items:center;gap:6px;min-width:0">${cap(dir, "8.5px")}${who ? initials(who, 18, "7.5px") : anyone}<span style="font-size:11.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span></span>
      ${state(s)}
      <span style="font-size:10.5px;color:var(--fg-40);text-align:right;white-space:nowrap">${when}</span>
    </div>`;
  const head = (label: string, n: number, top: number) => `<div style="display:flex;align-items:center;padding:${top}px 2px 7px">${cap(label, "9px", "fg-55")}<span style="margin-left:auto;font-size:10px;color:var(--fg-40)">${n}</span></div>`;
  const check = (t: string, done: boolean) => `<div style="display:flex;align-items:flex-start;gap:8px;font-size:11.5px;line-height:1.5"><span style="width:12px;height:12px;border-radius:4px;flex:none;margin-top:3px;display:grid;place-items:center;box-sizing:border-box;${done ? "background:var(--accent)" : "border:1.5px solid var(--border-strong)"}">${done ? `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" stroke-width="4"><path d="M20 6 9 17l-5-5"></path></svg>` : ""}</span><span style="color:var(--${done ? "fg-40" : "fg-70"})">${t}</span></div>`;
  const body = `<div style="padding:12px 16px 14px">
      <div style="font-size:11.5px;color:var(--fg-55)">Handoffs you sent or that were left for you. A pending handoff waits until a session claims it.</div>
      ${head("Waiting to be claimed", 2, 12)}
      <div style="${SURF};overflow:hidden;margin-top:-1px"><div style="margin-top:-1px">
        ${row(17, "Retry-After is wired, the tests aren't", true, "From", "LP", "Leo", "pending", "14m ago")}
        ${row(16, "Digest preview needs a dark theme pass", false, "To", "", "Anyone", "pending", "3h ago")}
      </div></div>
      ${head("History", 2, 14)}
      <div style="${SURF};overflow:hidden"><div style="margin-top:-1px">
        ${row(15, "Limiter is merged, the dashboard tile is not", true, "To", "SO", "Sam", "claimed", "1d ago")}
        ${row(12, "Self-host guide: the secrets section is a stub", false, "From", "SO", "Sam", "expired", "Sep 30")}
      </div></div>
      <div style="margin-top:14px;${SURF};padding:13px 15px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${state("pending")}<span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">#17</span><span style="font-size:11.5px;color:var(--fg-55)">Leo Park → You · 14m ago</span><span style="margin-left:auto;height:24px;padding:0 12px;border-radius:7px;background:var(--accent);color:var(--accent-fg);font-size:11px;font-weight:600;display:inline-flex;align-items:center">Claim</span></div>
        <div style="display:flex;align-items:baseline;margin-top:12px">${cap("Where it stands", "9.5px", "accent")}<span style="margin-left:auto;font-family:var(--label);font-size:10px;font-weight:600;color:var(--fg-40)">1 of 3 done</span></div>
        <div style="height:3px;background:var(--border);margin-top:8px"><div style="width:33%;height:100%;background:var(--accent)"></div></div>
        <div style="margin-top:11px;font-size:12.5px;font-weight:500">Return Retry-After on every 429</div>
        <div style="margin-top:3px;font-family:var(--label);font-size:10px;color:var(--fg-40)">acme/api · feat/retry-after</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">${check("429s carry Retry-After from the bucket's reset time", true)}${check("Add limiter tests for the reset edge", false)}${check("Note the header in the API doc", false)}</div>
        <div class="fxm-wide" style="margin-top:10px;padding-top:9px;border-top:1px solid var(--border);font-family:var(--label);font-size:10px;color:var(--fg-40)">src/limits/bucket.ts<br>test/limits.test.ts</div>
      </div>
    </div>`;
  return win("Handoffs", hbtn("New handoff", true), body);
}

// ── Artifacts: one artifact's page — versions, status, the ratified line ─────
function artifactsMock(): string {
  const bars = (ws: number[]) => ws.map((w) => `<span style="display:block;height:6px;width:${w}%;border-radius:3px;background:var(--border-strong);margin-top:7px"></span>`).join("");
  const status = ARTIFACT_STATUSES.map((s) => `<span style="padding:3px 9px;border-radius:5px;white-space:nowrap;text-transform:capitalize;${s === "ratified" ? "background:var(--accent-soft);color:var(--accent);display:inline-flex;align-items:center;gap:4px" : "color:var(--fg-55)"}">${s === "ratified" ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"></path><path d="m9 12 2 2 4-4"></path></svg>` : ""}${s}</span>`).join("");
  const ver = (n: number, summary: string, when: string, on = false) => `<div style="display:flex;align-items:center;gap:9px;padding:6px 12px"><span style="font-family:var(--label);font-size:11.5px;font-weight:600;min-width:20px">v${n}</span><span style="flex:1;min-width:0"><span style="display:block;font-size:11.5px;font-weight:500;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${summary}</span><span style="display:block;margin-top:1px;font-size:10px;color:var(--fg-40)">@leo · ${when}</span></span>${on ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" style="flex:none"><path d="M20 6 9 17l-5-5"></path></svg>` : ""}</div>`;
  const body = `<div style="padding:14px 16px 14px">
      <div style="display:flex;align-items:center;gap:10px"><span style="font-size:19px;font-weight:650;letter-spacing:-0.02em;min-width:0">Rate limit headers: design</span>
        <span style="margin-left:auto;display:inline-flex;align-items:center;gap:7px;border:1px solid color-mix(in srgb, var(--green) 45%, transparent);background:color-mix(in srgb, var(--green) 9%, transparent);color:var(--green);border-radius:7px;padding:3px 8px;font-size:11px;font-weight:600;flex:none">Org<span style="width:22px;height:12px;border-radius:6px;background:var(--green);position:relative"><span style="position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:4px;background:var(--surface)"></span></span></span></div>
      <div style="margin-top:12px;${SURF};overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border)">
          <span style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11.5px;font-weight:600;white-space:nowrap">v3 ${cap("Latest", "8.5px")}</span>
          <span class="fxm-wide" style="flex:1;min-width:0;font-family:var(--label);font-size:10px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">trov.dev/acme/#artifacts/rate-limit-headers-design</span>
          <span style="margin-left:auto;display:inline-flex;border:1px solid var(--border);border-radius:7px;padding:2px;gap:2px;font-size:11px;font-weight:500">${status}</span>
          <span class="fxm-wide" style="font-size:11px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:6px;padding:3px 8px;white-space:nowrap">+ New version</span>
        </div>
        <div style="padding:18px 20px 20px;background:var(--hover)">
          <div style="font-size:14px;font-weight:650">Rate limit headers</div>
          <div style="margin-top:3px;font-size:11px;color:var(--fg-55)">What a caller sees when it goes over its budget</div>
          <div style="margin-top:12px;display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:10px">
            ${["Retry-After", "X-RateLimit-Remaining", "X-RateLimit-Reset"].map((h, i) => `<div style="border:1px solid var(--border);background:var(--surface);border-radius:7px;padding:10px 11px;min-width:0"><div style="font-family:var(--code);font-size:10px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h}</div>${bars(i === 0 ? [80, 55] : i === 1 ? [65, 85] : [70, 40])}</div>`).join("")}
          </div>
        </div>
      </div>
      <div style="margin-top:9px;font-size:11px;color:var(--fg-55)">Ratified v3 by Maya · 2d ago</div>
      <div class="fxm-tiles" style="margin-top:12px">
        <div style="${SURF};overflow:hidden;padding-bottom:4px"><div style="padding:9px 12px 4px">${cap("Versions", "9px")}</div>
          ${ver(3, "Adds X-RateLimit-Reset", "3d ago", true)}${ver(2, "Retry-After in seconds, not a date", "5d ago")}${ver(1, "First draft", "6d ago")}
          <div style="height:1px;background:var(--border);margin:4px 8px"></div>
          <div style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11.5px;font-weight:500;color:var(--fg-70)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><path d="M8 3v18M16 3v18M3 8h5M16 16h5"></path></svg>Compare v2 → v3</div>
        </div>
        <div style="${SURF};overflow:hidden"><div style="display:flex;align-items:center;padding:9px 12px 8px">${cap("Linked work", "9px")}<span style="margin-left:auto;font-size:10.5px;color:var(--fg-55)">+ Attach ticket</span></div>
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--border);font-size:11.5px"><span style="color:var(--fg-40)">#212</span><span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Rate limiting on the public API</span></div>
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--border);font-size:11.5px">${DOT("accent", 6)}<span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Hardening the public API</span><span style="margin-left:auto;font-size:10.5px;color:var(--fg-40)">sprint</span></div>
        </div>
      </div>
    </div>`;
  return win(`<span style="color:var(--fg-55);font-weight:500">Artifacts</span> <span style="color:var(--fg-40);font-weight:400">›</span> Rate limit headers: design`, "", body);
}

const MOCKS: Record<MockKey, () => string> = { docs: docsMock, feed: feedMock, tickets: ticketsMock, roadmap: roadmapMock, mywork: myworkMock, handoffs: handoffsMock, artifacts: artifactsMock };
/** The dialog's drawing of a screen. Inert markup; the caller wraps it in `aria-hidden`. */
export function featureMock(key: MockKey): string {
  return MOCKS[key]();
}
/** What a mock SAYS, tags stripped — for the test that pins its vocabulary. */
export const mockText = (key: MockKey): string => featureMock(key).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
