// The small presentational atoms the organization pages share — Org settings (org-settings.ts,
// integrations.ts), Platform (platform.ts, platform-usage.ts) and the picker (org-picker.ts):
// buttons, a labelled field, a tab's lead line, a section head, a row that opens, an empty
// state, a banner. Pure markup over the trov.css tokens; no state, no imports from a screen.
//
// THE HIERARCHY THESE PAGES KEEP (the Settings bento's and the Repo dashboard's, not a new one):
//   1. the page title — the header's <h1>, 15px / 600. Nothing in the body repeats it.
//   2. the tab bar (tabs.ts), 13.5px / 500.
//   3. a tab's LEAD (`tabLead`): one 13px sentence saying what is here and what needs
//      attention, with the tab's ONE primary action (the only accent button) at its right.
//   4. a SECTION (`orgHead`): the uppercase eyebrow, 10.5px / 600 / fg-40, with a count and a
//      quiet aside. It is the only heading level inside a tab.
//   5. a ROW inside one surface per section: its name at 13.5px / 600 and its status chip
//      first, quiet 12px metadata after, one quiet action. Everything else about it — what it
//      is for, how to get it, its less-used and its destructive actions — is behind the row
//      (`openRow`) or in its dialog.
// Destructive actions are text (`dangerLink`), last in their cluster, never beside the primary.

import { esc, attr, statusBadge } from "./ui";
import type { OrgRole } from "@shared/orgs";

/** One read: where it is, what it returned, and why it failed. */
export interface OrgSlice<T> { status: "idle" | "loading" | "ok" | "error"; data: T; error?: string }

export const O_LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";
export const O_FIELD = "display:block;width:100%;box-sizing:border-box;height:36px;padding:0 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--fg);font-size:13.5px;font-family:var(--sans);outline:none";
export const O_HELP = "font-size:11.5px;line-height:1.5;color:var(--fg-40);margin-top:6px";
export const O_ERR = "font-size:12.5px;line-height:1.5;color:var(--red);margin-top:6px";
const O_BTN = "height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;white-space:nowrap";

export interface BtnOpts { arg?: string; disabled?: boolean; label?: string; field?: string; extra?: string; busy?: boolean; title?: string }
const wire = (act: string, o: BtnOpts): string =>
  ` type="button" data-act="${attr(act)}"${o.arg !== undefined ? ` data-arg="${attr(o.arg)}"` : ""}${o.field ? ` data-field="${attr(o.field)}"` : ""}${o.disabled ? " disabled" : ""}${o.busy ? ' aria-busy="true"' : ""}${o.label ? ` aria-label="${attr(o.label)}"` : ""}${o.title ? ` title="${attr(o.title)}"` : ""}`;
/** The accent button; disabled it is the app's inert outline (ui.ts `primaryBtn`), and really disabled. */
export function accentBtn(text: string, act: string, o: BtnOpts = {}): string {
  const on = !o.disabled;
  return `<button${wire(act, o)} class="${on ? "cnpy-accentbtn" : "cnpy-org-off"}" style="${O_BTN};font-weight:600;${on ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent" : "background:transparent;color:var(--fg-40);border:1px solid var(--border)"};${o.extra ?? ""}">${esc(text)}</button>`;
}
/** The quiet outline button every secondary action uses. */
export function quietBtn(text: string, act: string, o: BtnOpts = {}): string {
  return `<button${wire(act, o)} class="${o.disabled ? "cnpy-org-off" : "cnpy-ghostbtn"}" style="${O_BTN};font-weight:500;border:1px solid var(--border);color:${o.disabled ? "var(--fg-40)" : "var(--fg-70)"};background:transparent;${o.extra ?? ""}">${esc(text)}</button>`;
}
/** A destructive action's trigger: quiet until hovered or focused, then red (`.cnpy-rejectbtn`). */
export function dangerBtn(text: string, act: string, o: BtnOpts = {}): string {
  return `<button${wire(act, o)} class="${o.disabled ? "cnpy-org-off" : "cnpy-rejectbtn"}" aria-haspopup="dialog" style="${O_BTN};font-weight:500;border:1px solid var(--border);color:${o.disabled ? "var(--fg-40)" : "var(--fg-55)"};background:transparent;${o.extra ?? ""}">${esc(text)}</button>`;
}
/** A destructive action's trigger as TEXT: quiet until hovered or focused, then red. It sits
 *  last in an opened row's actions (or a form's footer), never at the weight of the others. */
export function dangerLink(text: string, act: string, o: BtnOpts = {}): string {
  return `<button${wire(act, o)} class="${o.disabled ? "cnpy-org-off" : "cnpy-org-danger"}" aria-haspopup="dialog" style="height:32px;padding:0 4px;border-radius:6px;font-size:12.5px;font-weight:500;white-space:nowrap;color:${o.disabled ? "var(--fg-40)" : "var(--fg-55)"};${o.extra ?? ""}">${esc(text)}</button>`;
}
/** A text link that goes somewhere in the app. */
export function goLink(text: string, act: string, arg?: string): string {
  return `<button type="button" data-act="${attr(act)}"${arg !== undefined ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-mutelink cnpy-org-link" style="padding:0;font-size:12.5px;font-weight:500;color:var(--fg-55);text-align:left">${esc(text)} &rarr;</button>`;
}
/** A tab's first line: `summary` (markup — a sentence, its figures in <strong>) says what is here
 *  and what needs attention; `action` is the tab's ONE primary action, at the right. */
export function tabLead(summary: string, action = ""): string {
  return `<div class="cnpy-lead"><p class="cnpy-lead-t">${summary}</p>${action ? `<div class="cnpy-lead-a">${action}</div>` : ""}</div>`;
}
/** Something in a lead that needs attention: an icon and words in the tone's colour (the words
 *  carry the meaning; the colour repeats it). */
export function leadFlag(text: string, tone: "red" | "amber" = "red"): string {
  return `<span class="cnpy-lead-flag" style="color:var(--${tone})"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5"></path><path d="M12 16.5h.01"></path><circle cx="12" cy="12" r="9"></circle></svg>${esc(text)}</span>`;
}
/** A section's heading inside a tab — the only heading level there: the uppercase eyebrow (the
 *  Settings tiles' and the Repo dashboard's), an optional count, and a quiet aside at the right
 *  (`hint` is markup: a short phrase, or a small action). `id` names it for `aria-labelledby`. */
export function orgHead(title: string, hint = "", count: number | null = null, id = ""): string {
  const n = count === null ? "" : `<span class="cnpy-badge" data-n="${count}">${count}</span>`;
  return `<div class="cnpy-sechead"><h2${id ? ` id="${attr(id)}"` : ""} style="${O_LABEL};margin:0">${esc(title)}</h2>${n}${hint ? `<span class="cnpy-sechead-a">${hint}</span>` : ""}</div>`;
}

const ROW_CHEV = (open: boolean): string => `<svg class="cnpy-xrow-c" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(${open ? 90 : 0}deg)"><path d="M9 6l6 6-6 6"></path></svg>`;
export interface OpenRowOpts {
  /** Unique on the page: the toggle's arg, and the body's element id. */
  key: string;
  open: boolean;
  /** The act the head dispatches (arg = `key`). */
  act: string;
  /** What a screen reader hears for the toggle ("GitHub token, set"). */
  label: string;
  /** Markup inside the toggle: the name and its status chip. */
  head: string;
  /** Quiet metadata at the head's right (markup; hidden first when room runs out). */
  meta?: string;
  /** The row's one always-visible action (markup), outside the toggle. */
  action?: string;
  /** Markup always shown under the head, open or not (an error, a test's answer). */
  always?: string;
  /** The detail the row opens to. */
  body: string;
  /** Extra attributes on the <li> (data hooks). */
  attrs?: string;
}
/** A row that opens: its name and status first, the rest behind a real button
 *  (`aria-expanded`), so a list of them reads as a list of names. */
export function openRow(o: OpenRowOpts): string {
  const id = `xrow-${o.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return `<li class="cnpy-xrow" data-open="${o.open ? "1" : "0"}"${o.attrs ?? ""}>
    <div class="cnpy-xrow-h">
      <button type="button" data-act="${attr(o.act)}" data-arg="${attr(o.key)}" data-field="${attr(`row:${o.key}`)}" aria-expanded="${o.open}" aria-controls="${attr(id)}" aria-label="${attr(`${o.label}: ${o.open ? "hide" : "show"} details`)}" class="cnpy-xrow-t">${ROW_CHEV(o.open)}<span class="cnpy-xrow-n">${o.head}</span>${o.meta ? `<span class="cnpy-xrow-m">${o.meta}</span>` : ""}</button>
      ${o.action ? `<div class="cnpy-xrow-a">${o.action}</div>` : ""}
    </div>
    ${o.always ? `<div class="cnpy-xrow-x">${o.always}</div>` : ""}
    <div id="${attr(id)}" class="cnpy-xrow-b"${o.open ? "" : " hidden"}>${o.body}</div>
  </li>`;
}
/** The chip every status on these pages uses (one size). */
export const chip = (text: string, tone: string): string => statusBadge(text, tone, "font-size:10.5px;border-radius:5px;padding:2px 7px");
/** The dashed empty-state card (ui.ts `dashedCard`'s look), with an optional action under it. */
export function orgEmpty(title: string, sub: string, action = ""): string {
  return `<div class="cnpy-org-empty" style="border:1px dashed var(--border-strong);border-radius:11px;padding:28px 20px;text-align:center">
    <div style="font-size:13.5px;font-weight:500;color:var(--fg-70)">${esc(title)}</div>
    <div style="font-size:12.5px;line-height:1.5;color:var(--fg-40);margin-top:4px">${esc(sub)}</div>
    ${action ? `<div style="margin-top:14px;display:flex;justify-content:center">${action}</div>` : ""}
  </div>`;
}
/** A banner across a tab: what is wrong and what to do. `tone` picks the token; the words carry the meaning. */
export function orgBanner(title: string, body: string, tone: "amber" | "red" = "amber"): string {
  const c = `var(--${tone})`;
  return `<div role="${tone === "red" ? "alert" : "status"}" class="cnpy-org-banner" style="border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 9%,transparent);border-radius:10px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
    <div style="min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">${esc(title)}</div><div style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:2px">${body}</div></div>
  </div>`;
}
export const loadingNote = (what: string) => `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0">Loading ${esc(what)}&hellip;</div>`;
export const failedNote = (what: string, act = "orgReload") =>
  `<div role="alert" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--fg-55);padding:10px 0">Couldn't load ${esc(what)}. Check your connection, then ${quietBtn("Try again", act)}</div>`;
/** A slice's placeholder while it has nothing to show, or "" once it does. */
export function sliceNote(s: OrgSlice<unknown>, what: string, has: boolean): string {
  if (has) return "";
  if (s.status === "error") return failedNote(what);
  if (s.status === "ok") return "";
  return loadingNote(what);
}
const ROLE_WORD: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const ROLE_TONE: Record<OrgRole, string> = { owner: "var(--accent)", admin: "var(--blue)", member: "var(--fg-55)" };
export const roleChip = (role: OrgRole): string => chip(ROLE_WORD[role], ROLE_TONE[role]);
export const YOU = `<span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px;flex:none">YOU</span>`;
export const sameHandle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A labelled text field: a real <label>, the input, an optional help line, and the field's
 *  own error under it (`role="alert"`). */
export interface FieldOpts {
  id: string; label: string; act: string; value: string; field: string;
  arg?: string; placeholder?: string; help?: string; error?: string | null; max?: number; disabled?: boolean; enter?: string; required?: boolean;
}
export function textField(o: FieldOpts): string {
  const describe = [o.help ? `${o.id}-h` : "", o.error ? `${o.id}-e` : ""].filter(Boolean).join(" ");
  return `<div class="cnpy-org-field">
    <label for="${attr(o.id)}" style="${O_LABEL}">${esc(o.label)}${o.required ? ` <span style="text-transform:none;letter-spacing:0;font-weight:500">(required)</span>` : ""}</label>
    <input id="${attr(o.id)}" data-act="${attr(o.act)}"${o.arg !== undefined ? ` data-arg="${attr(o.arg)}"` : ""} data-field="${attr(o.field)}" value="${attr(o.value)}"${o.placeholder ? ` placeholder="${attr(o.placeholder)}"` : ""}${o.max ? ` maxlength="${o.max}"` : ""}${o.enter ? ` data-enter="${attr(o.enter)}"` : ""}${o.disabled ? " disabled" : ""}${describe ? ` aria-describedby="${attr(describe)}"` : ""}${o.error ? ' aria-invalid="true"' : ""} autocomplete="off" autocapitalize="off" spellcheck="false" class="cnpy-input" style="${O_FIELD};margin-top:7px;${o.error ? "border-color:var(--red);" : ""}" />
    ${o.help ? `<div id="${attr(o.id)}-h" style="${O_HELP}">${o.help}</div>` : ""}
    ${o.error ? `<div id="${attr(o.id)}-e" role="alert" style="${O_ERR}">${esc(o.error)}</div>` : ""}
  </div>`;
}

const RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };
export const roleAtLeast = (role: OrgRole | null | undefined, min: OrgRole): boolean => !!role && RANK[role] >= RANK[min];
