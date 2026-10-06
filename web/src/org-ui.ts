// The small presentational atoms Org settings' two modules share (org-settings.ts and
// integrations.ts): buttons, a labelled field, a section head, an empty state, a banner.
// Pure markup over the trov.css tokens; no state, no imports from either screen module.

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
/** A text link that goes somewhere in the app. */
export function goLink(text: string, act: string, arg?: string): string {
  return `<button type="button" data-act="${attr(act)}"${arg !== undefined ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-mutelink cnpy-org-link" style="padding:0;font-size:12.5px;font-weight:500;color:var(--fg-55);text-align:left">${esc(text)} &rarr;</button>`;
}
/** A section's heading inside a tab: a title, an optional count, an optional one-line hint. */
export function orgHead(title: string, hint = "", count: number | null = null): string {
  const n = count === null ? "" : `<span class="cnpy-badge" data-n="${count}">${count}</span>`;
  return `<div class="cnpy-org-head"><h2 style="margin:0;font-size:14px;font-weight:600;letter-spacing:-0.005em;display:flex;align-items:center;gap:8px">${esc(title)}${n}</h2>${hint ? `<p style="margin:3px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg-55)">${hint}</p>` : ""}</div>`;
}
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
export const roleChip = (role: OrgRole): string => statusBadge(ROLE_WORD[role], ROLE_TONE[role], "font-size:10.5px;border-radius:5px;padding:2px 7px");
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
