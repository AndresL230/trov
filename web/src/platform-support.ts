// Platform › Support (superadmin) — the bug reports and messages people send, signed in (the header's
// bug button, Settings › Contact support) or signed out (the site's Contact form) —
// docs/architecture/support.md — over /api/platform/support.
//
//   THE LIST    a count of open reports (also on the tab), a status switch and a kind dropdown, and
//               a table — kind, subject, who, organization, when, status — newest first, paged.
//   ONE REPORT  (`#platform/support/<id>`) the whole message, the context the form attached (screen,
//               organization, version, browser), what became of the mail to the operator, Resolve /
//               Reopen, and "Reply by email" — a `mailto:` to the reporter's verified address.
//
// A report holds what its reporter typed plus a slug and a route: a superadmin reads nothing of the
// organization it came from here, and is not a member of it.
//
// Purely presentational: state in, markup out; interactions dispatch `platSupport…` acts
// (platform-support-actions.ts).

import {
  SUPPORT_KINDS, SUPPORT_KIND_LABEL, supportMailSubject,
  type SupportKind, type SupportKindFilter, type SupportReport, type SupportStatusFilter,
} from "@shared/support-core";
import { esc, attr, relTime, statusBadge, surface } from "./ui";
import { segmented } from "./segmented";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { tabLead } from "./org-ui";
import { skeleton, skCard, skDetail, skTable } from "./skeleton";

interface Slice<T> { status: "idle" | "loading" | "ok" | "error"; data: T }

export interface SupportTabState {
  /** The page(s) of the list read so far, newest first. */
  list: Slice<SupportReport[]>;
  /** Every open report, whatever the filter — the tab's count. null until a read says. */
  open: number | null;
  /** Where the next page starts, or null at the end of the list. */
  next: number | null;
  more: "idle" | "loading" | "error";
  status: SupportStatusFilter;
  kind: SupportKindFilter;
  /** The report on screen (`#platform/support/<id>`), or null for the list. */
  reportId: number | null;
  detail: Slice<SupportReport | null>;
  /** The detail read answered 404: there is no such report. */
  missing: boolean;
  /** Resolve / Reopen is in flight. */
  busy: boolean;
  actionError: string | null;
}

export const initialSupportTab = (): SupportTabState => ({
  list: { status: "idle", data: [] }, open: null, next: null, more: "idle",
  status: "open", kind: "all",
  reportId: null, detail: { status: "idle", data: null }, missing: false, busy: false, actionError: null,
});

export const SUPPORT_STATUS_FILTERS: readonly SupportStatusFilter[] = ["open", "resolved", "all"];
const STATUS_LABEL: Record<SupportStatusFilter, string> = { open: "Open", resolved: "Resolved", all: "All" };
export const isSupportStatusFilter = (v: unknown): v is SupportStatusFilter => (SUPPORT_STATUS_FILTERS as readonly unknown[]).includes(v);
export const isSupportKindFilter = (v: unknown): v is SupportKindFilter => v === "all" || (SUPPORT_KINDS as readonly unknown[]).includes(v);

const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const QUIET = "font-size:11.5px;color:var(--fg-40)";
const BTN = "height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;white-space:nowrap";
const KIND_TONE: Record<SupportKind, string> = { bug: "var(--red)", question: "var(--blue)", feedback: "var(--accent)" };
const kindChip = (k: SupportKind): string => statusBadge(SUPPORT_KIND_LABEL[k].toUpperCase(), KIND_TONE[k]);
const statusChip = (s: SupportReport["status"]): string => (s === "open" ? statusBadge("OPEN", "var(--amber)") : statusBadge("RESOLVED", "var(--green)"));
const dateTitle = (iso: string | null): string => (iso ? ` title="${attr(new Date(iso).toLocaleString("en-US"))}"` : "");
const retry = (what: string): string =>
  `<div role="alert" style="font-size:13px;color:var(--fg-70);padding:10px 0">Couldn't load ${esc(what)}. <button type="button" data-act="platReload" class="cnpy-mutelink" style="padding:0;font-size:13px;font-weight:500;color:var(--accent)">Try again</button></div>`;
const dashed = (title: string, sub: string): string =>
  `<div data-support-empty style="border:1px dashed var(--border-strong);border-radius:11px;padding:22px 24px;text-align:center"><div style="font-size:13.5px;font-weight:600;color:var(--fg-70)">${esc(title)}</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:4px;line-height:1.5">${esc(sub)}</div></div>`;

/** The tab's count: every open report. Hidden at zero, and while it is not known. */
export function supportTabBadge(open: number | null): string {
  const n = open ?? 0;
  return `<span class="cnpy-badge" data-n="${n}" title="${attr(`${n} open ${n === 1 ? "report" : "reports"}`)}">${n}</span>`;
}

/** The kind filter — a dropdown: four choices, and the lead line has no room for a second switch. */
export const supportKindDropdown = (value: SupportKindFilter): DropdownProps => ({
  id: "plat-support-kind", act: "platSupportKind", value, size: "sm", ariaLabel: "Kind",
  options: [{ value: "all", label: "All kinds" }, ...SUPPORT_KINDS.map((k) => ({ value: k, label: SUPPORT_KIND_LABEL[k] }))],
});

/** Where a reply goes: a signed-in reporter's VERIFIED address, or — signed out — the address typed. */
export const supportReplyAddress = (r: Pick<SupportReport, "reporter" | "contact_email">): string | null => (r.reporter ? r.reporter.email : r.contact_email);
/** A report sent from the public site: no account behind it, and an address nobody verified. */
export const SIGNED_OUT = "Signed out";
export const UNVERIFIED = "unverified, as typed";
const anonChip = (): string => statusBadge("SIGNED OUT", "var(--fg-55)");

/** `mailto:` the reporter with the subject prefilled — the same subject the notice was mailed under. */
export function supportReplyHref(r: Pick<SupportReport, "kind" | "subject" | "reporter" | "contact_email">): string | null {
  const to = supportReplyAddress(r);
  if (!to || !/^[^\s@<>"]+@[^\s@<>"]+$/.test(to)) return null;
  return `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${encodeURIComponent(`Re: ${supportMailSubject(r.kind, r.subject)}`)}`;
}

const GRID = "plat-support-grid";
function reportRow(r: SupportReport): string {
  const cell = (label: string, inner: string, cls = "") => `<div class="plat-c${cls ? ` ${cls}` : ""}" style="min-width:0"><span class="plat-cl">${label}</span>${inner}</div>`;
  const done = r.status === "resolved";
  return `<button type="button" data-act="platSupportOpen" data-arg="${r.id}" data-field="platSupportRow:${r.id}" class="plat-row ${GRID}" aria-label="${attr(`${SUPPORT_KIND_LABEL[r.kind]}: ${r.subject}, from ${r.reporter ? `@${r.reporter.handle}` : "a signed-out visitor"}, ${done ? "resolved" : "open"} — open`)}" style="width:100%;text-align:left;padding:12px 20px;border-bottom:1px solid var(--border);margin-bottom:-1px">
    ${cell("Kind", kindChip(r.kind))}
    <div class="plat-c plat-c-name" style="min-width:0"><span style="display:block;font-size:13.5px;font-weight:600;color:${done ? "var(--fg-55)" : "var(--fg)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject)}</span></div>
    ${cell("From", r.reporter
      ? `<span style="display:block;font-size:12.5px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.reporter.name ?? r.reporter.handle)} <span style="color:var(--fg-40)">@${esc(r.reporter.handle)}</span></span>`
      : `<span data-support-anon style="display:flex;align-items:center;gap:7px;min-width:0">${anonChip()}<span style="font-size:12px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.contact_email ?? "")}</span></span>`, "plat-c-wide")}
    ${cell("Organization", r.org ? `<span style="display:block;font-family:var(--code);font-size:12px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.org.slug)}</span>` : `<span style="font-size:12.5px;color:var(--fg-40)">&mdash;</span>`, "plat-c-wide")}
    ${cell("When", `<span style="font-size:12px;color:var(--fg-40);white-space:nowrap"${dateTitle(r.created_at)}>${esc(relTime(r.created_at))}</span>`)}
    ${cell("Status", statusChip(r.status))}
  </button>`;
}

function lead(s: SupportTabState, dd: DropdownUi): string {
  const n = s.open;
  const sentence = `${n === null ? "" : n === 0 ? "No open reports. " : `<strong>${n}</strong> open ${n === 1 ? "report" : "reports"}. `}Bug reports and messages people send from the app and from the site's Contact form. Each one is mailed to you; replying answers the person who wrote it.`;
  const filters = `${segmented({ id: "plat-support-status", ariaLabel: "Status", act: "platSupportStatus", value: s.status, size: "sm", inertOn: true, options: SUPPORT_STATUS_FILTERS.map((v) => ({ value: v, label: STATUS_LABEL[v] })) })}${dropdown(supportKindDropdown(s.kind), dd)}`;
  return tabLead(sentence, filters);
}

/** The list: lead, then the table — or its skeleton, error or empty state. */
function listView(s: SupportTabState, dd: DropdownUi): string {
  const rows = s.list.data;
  let body: string;
  if (s.list.status === "error" && !rows.length) body = retry("the support reports");
  else if (s.list.status !== "ok" && !rows.length) {
    // The table that is coming: its header row and five rows on the table's own columns.
    body = skeleton("plat-support", "Loading support reports…", skCard(skTable(5, "64px minmax(0,2.2fr) minmax(0,1.3fr) minmax(0,1fr) 72px 76px", 6, { pad: "0 20px", head: true }), "overflow:hidden"));
  } else if (!rows.length) {
    const filtered = s.kind !== "all" ? ` ${SUPPORT_KIND_LABEL[s.kind as SupportKind].toLowerCase()}` : "";
    body = s.status === "open" ? dashed(`No open${filtered} reports`, "Nothing is waiting for you. A new report appears here and is mailed to you.")
      : s.status === "resolved" ? dashed(`No resolved${filtered} reports`, "A report moves here when you resolve it.")
      : dashed(`No${filtered} reports yet`, "When someone reports a bug or contacts support, signed in or from the site, it appears here.");
  } else {
    const more = s.next === null ? ""
      : `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px"><button type="button" data-act="platSupportMore" data-field="platSupportMore"${s.more === "loading" ? ' disabled aria-busy="true"' : ""} class="cnpy-outlinebtn" style="${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)">${s.more === "loading" ? "Loading…" : "Show older reports"}</button>${s.more === "error" ? `<span role="alert" style="font-size:12.5px;color:var(--red)">Couldn't load more. Try again.</span>` : ""}</div>`;
    body = `<div${surface("overflow:hidden", { cls: `plat-table${s.list.status === "loading" ? " plat-busy" : ""}` })}>
        <div class="plat-thead ${GRID}" aria-hidden="true" style="padding:12px 20px 9px;border-bottom:1px solid var(--border)"><span>Kind</span><span>Subject</span><span>From</span><span>Organization</span><span>When</span><span>Status</span></div>
        ${rows.map(reportRow).join("")}
      </div>${more}`;
  }
  return `${lead(s, dd)}${body}`;
}

const BACK = `<button type="button" data-act="platSupportBack" data-field="platSupportBack" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:6px;padding:0;font-size:12.5px;font-weight:500;color:var(--fg-55)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>All reports</button>`;

/** What became of the mail to the operator, in words. */
export function supportMailLine(m: SupportReport["mail"]): string {
  if (m.status === "sent") return `Mailed to you ${relTime(m.at)}.`;
  if (m.status === "failed") return `The mail to you was not sent${m.error ? `: ${m.error}` : "."}`;
  if (m.status === "skipped") return "Not mailed: no SUPPORT_NOTIFY_EMAIL is set on this deployment.";
  return "No mail outcome was recorded.";
}

/** One report: the message whole, what the form attached, and what can be done with it. */
function detailView(s: SupportTabState): string {
  const wrap = (inner: string) => `<div data-support-detail="${s.reportId ?? ""}"><div style="margin-bottom:16px">${BACK}</div>${inner}</div>`;
  const r = s.detail.data && s.detail.data.id === s.reportId ? s.detail.data : null;
  if (!r) {
    if (s.missing) return wrap(dashed("That report doesn't exist", "It may have been a mistyped link. Go back to the list."));
    if (s.detail.status === "error") return wrap(retry("this report"));
    return wrap(skeleton("plat-support-detail", "Loading the report…", skDetail({ actions: 2, paras: 2 })));
  }
  const reply = supportReplyHref(r);
  const done = r.status === "resolved";
  const off = s.busy ? " disabled" : "";
  const act = done
    ? `<button type="button" data-act="platSupportReopen" data-field="platSupportMove"${off}${s.busy ? ' aria-busy="true"' : ""} class="cnpy-outlinebtn" style="${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)">${s.busy ? "Reopening…" : "Reopen"}</button>`
    : `<button type="button" data-act="platSupportResolve" data-field="platSupportMove"${off}${s.busy ? ' aria-busy="true"' : ""} class="cnpy-accentbtn" style="${BTN};border:1px solid transparent;background:var(--accent);color:var(--accent-fg);font-weight:600">${s.busy ? "Resolving…" : "Resolve"}</button>`;
  const replyLink = reply
    ? `<a href="${attr(reply)}" data-support-reply class="cnpy-outlinebtn" style="${BTN};display:inline-flex;align-items:center;box-sizing:border-box;border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70);text-decoration:none">Reply by email</a>`
    : "";
  const row = (label: string, value: string, mono = false) =>
    `<div class="cnpy-support-ctx-r"><dt>${label}</dt><dd${mono ? ` style="font-family:var(--code);font-size:12px"` : ""}>${value}</dd></div>`;
  const who = r.reporter ? `${esc(r.reporter.name ?? r.reporter.handle)} <span style="color:var(--fg-40)">@${esc(r.reporter.handle)}</span>` : SIGNED_OUT;
  const from = r.reporter
    ? `${who}${r.reporter.email ? ` &middot; ${esc(r.reporter.email)}` : ` &middot; <span style="color:var(--amber)">no verified email on file, so there is nowhere to reply</span>`}`
    : `${SIGNED_OUT}: sent from the public site, with no account &middot; ${esc(r.contact_email ?? "no address")} <span data-support-unverified style="color:var(--amber)">(${UNVERIFIED})</span>`;
  return wrap(`<div${surface("padding:18px 20px")}>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div style="min-width:0;flex:1 1 320px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${kindChip(r.kind)}${statusChip(r.status)}${r.reporter ? "" : anonChip()}<span style="${QUIET}">Report #${r.id}</span></div>
          <h2 style="margin:8px 0 0;font-size:19px;font-weight:600;letter-spacing:-0.01em;line-height:1.3;overflow-wrap:anywhere">${esc(r.subject)}</h2>
          <div style="margin-top:4px;font-size:12.5px;color:var(--fg-55);line-height:1.5;overflow-wrap:anywhere">${who} &middot; <span${dateTitle(r.created_at)}>${esc(relTime(r.created_at))}</span>${done && r.resolved_by ? ` &middot; resolved by @${esc(r.resolved_by)}${r.resolved_at ? ` <span${dateTitle(r.resolved_at)}>${esc(relTime(r.resolved_at))}</span>` : ""}` : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${replyLink}${act}</div>
      </div>
      ${s.actionError ? `<div role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:12px">${esc(s.actionError)}</div>` : ""}
      <div data-support-message style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);font-size:14px;line-height:1.65;color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.message)}</div>
    </div>
    <div class="cnpy-sechead"><h2 style="${LABEL};margin:0">Sent with the message</h2></div>
    <div${surface("padding:14px 20px", { cls: "cnpy-support-ctx" })} data-support-context>
      <dl>
        ${row("From", from)}
        ${r.reporter ? row("Organization", r.org ? `${r.org.name ? `${esc(r.org.name)} ` : ""}<span style="font-family:var(--code);font-size:12px;color:var(--fg-55)">${esc(r.org.slug)}</span>` : "None: sent from outside an organization") : ""}
        ${row(r.reporter ? "Screen" : "Page", r.route ? esc(r.route) : "Not given", !!r.route)}
        ${r.reporter ? row("Version", r.app_version ? esc(r.app_version) : "Not given") : ""}
        ${row("Browser", r.user_agent ? esc(r.user_agent) : "Not given")}
      </dl>
      <div style="${QUIET};line-height:1.5;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)" data-support-mail="${r.mail.status ?? "none"}">${esc(supportMailLine(r.mail))} ${r.reporter ? "This is everything the report holds: what they wrote, and the five lines above. Nothing was read from their organization." : "This is everything the report holds: what they wrote, and the three lines above. The address was typed into the public form and nobody verified it; Trov has sent nothing to it."}</div>
    </div>`);
}

/** The Support tab's panel. `dd` = the open dropdown (`state.dd`), for the kind filter's trigger. */
export function supportTab(s: SupportTabState, dd: DropdownUi = initialDropdownUi()): string {
  // The list and a report are different things in the same panel: `data-morph-key` has the page's
  // in-place patch (morph.ts) REPLACE one with the other instead of patching a table into a message.
  return s.reportId !== null
    ? `<div data-morph-key="plat-support:report:${s.reportId}">${detailView(s)}</div>`
    : `<div data-morph-key="plat-support:list">${listView(s, dd)}</div>`;
}
