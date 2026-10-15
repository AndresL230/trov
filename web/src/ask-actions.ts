// Ask Trov — write cards, Save as artifact and "Wrong?" (the ACTIONS part; inventory §3, §4, §2f › Wrong?;
// scenarios `actions-ask`, `actions-auto`, `artifact`, `artifact-saved`; design ask-trov.dc.html L475–590,
// L1651–1672, L630–638; #12 §2.11–12, §2.14, §3).
//
//   • A CARD (`action` event, state proposed | waiting): the eyebrow ("New ticket", "New handoff", "Doc edit",
//     "Publish doc"), a mark ("Draft, not created yet" / "Waiting for you"), the body per kind, inline Edit of the
//     fields the tool's input takes (`editable` — ticket: title, category, priority, assignee; handoff: recipient,
//     task; doc edit: the `+` text of each hunk), and Cancel / Confirm. `confirm { args }` sends ONLY the edited
//     fields; the server re-validates them and rebuilds the card. A Publish card never runs in Auto (it waits with
//     the server's note) and offers Confirm only when `preview.canPublish` — else "Open in Review".
//   • A LINE (after the decision): done (linked to `ref`, a time, Undo while the server offers it), "Cancelled: …",
//     "Undone: …", "Expired: …" or "Didn't work: …". Consecutive cards of one `groupId` are ONE card / ONE line
//     ("Filed tickets #30, #31 and #32") with one Confirm and one Undo for the group. Undo refused because the item
//     changed since (409 `changed`) says "Changed since. Undo it by hand." with a link to the item.
//   • SAVE AS ARTIFACT: `saveButton` (the footer, a block) asks the server for a `save_form` block (no model call)
//     and adds it under that answer; the form (Title, Kind and Who can see it as `segmented()`, Save) becomes the
//     saved line ("Saved as artifact: <title> · Private", Open). In Auto the server saves at once: the stream's
//     `action_result` for `save_artifact` draws the same saved line, with Undo.
//   • WRONG?: `wrongButton` toggles a row of the three reasons; a pick posts the reason (the server records it with
//     the mode, the message and its cites), closes the row and says "Thanks. The team can see this in Review."
//
// THE INTERFACE (the conversation calls these):
//   ActionsUi / initialActionsUi()                  this part's state, at `AppState.ask.actions`
//   actionGroupView(v, answer, ids)                 one card / line for consecutive actions of one group
//   saveFormView(v, answer, block, index)           a `save_form` block (the form, or the saved line)
//   feedbackView(v, answer)                         under the footer: the Wrong? reasons row while it is open
//   wrongButton(v, answer) / saveButton(answer, block?)   the footer's / a block's buttons (or use the acts below)
//   applyResults(ctx, ans)                          fold Confirm / Cancel / Undo answers into the conversations
//   actionsPart                                     the acts (`askAc…`), the Wrong? row's Escape layer
// Acts and their args (`|` separates; an answer is named by its key `a…` / `m…`, or by its stored message id):
//   askAcConfirm / askAcCancel / askAcUndo  "<id>[,<id>…]"   (the card's / group's ids)
//   askAcEdit "<id>"   askAcField "<id>|<field>[|<value>]" (value from the input when absent)   askAcHunk "<id>|<index>"
//   askAcSaveForm "<answer>[|<block>]"   askAcSaveTitle / askAcSaveKind / askAcSaveVis / askAcSave "<answer>|<index>[|<value>]"
//   askAcWrong "<answer>"   askAcWrongReason "<answer>|<reason>"
// MOTION (ask-motion.ts): every card / line / form sits in a `data-ask-tween` wrapper, so a card collapsing to its
// line, a form becoming its saved line and the Edit form opening or closing glide; a line, the Edit form and the
// save form enter once (a new `data-morph-key`), the Wrong? row pops in and out (`ctx.exit`, `data-closing`).
// Nothing replays on a rerender: the page is `data-morph`, and an unchanged key is patched in place.
// CSS: `/* ── Ask: actions ── */` in trov.css.

import { esc, attr, relTime } from "./ui";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { applyActionResult, newTurn, withTurnOfAction, type AskActionVm, type AskAnswer, type AskConvo, type AskMsg, type AskTurn } from "./ask-stream";
import { AskApiError } from "./ask-api";
import { segmented } from "./segmented";
import { glyph, markShape, priorityIcon, PRIORITY_LABEL } from "./marks";
import { personName, personOf, refAvatar, refStatusMark } from "./ask-refs";
import { askIcon } from "./ask-icons";
import { closingAttr } from "./ask-motion";
import {
  ASK_WRONG_LABELS, ASK_WRONG_REASONS, parseAskRef, type AskActionAnswer, type AskBlock, type AskDocHunk, type AskEventMap, type AskSaveForm,
  type AskWrongReason,
} from "@shared/ai-ask-core";
import { TICKET_CATEGORIES, TICKET_STATUS_LABEL, type TicketPriority, type TicketStatus } from "@shared/tickets-core";

export interface ActionsUi {
  /** Cards with a decision in flight (no double Confirm). */
  busy: Record<number, boolean>;
  /** Answers whose Wrong? row is open (by answer key). */
  wrongOpen: Record<string, boolean>;
  /** Cards whose Edit form is open. */
  editing: Record<number, boolean>;
  /** The edited fields per card (kept until Confirm, also while the form is shut). `hunks` maps a hunk's index → text. */
  drafts: Record<number, Record<string, unknown>>;
  /** Undo refused because the item changed since: the server's words and the item to undo by hand (per card id). */
  refused: Record<number, { message: string; ref: string | null }>;
  /** A save form's picks before Save, by `<answer key>|<block index>`. */
  forms: Record<string, { title?: string; kind?: AskSaveForm["kind"]; visibility?: AskSaveForm["visibility"] }>;
  /** Save forms being saved, and answers asking for a form (same keys). */
  saving: Record<string, boolean>;
}
export const initialActionsUi = (): ActionsUi => ({ busy: {}, wrongOpen: {}, editing: {}, drafts: {}, refused: {}, forms: {}, saving: {} });

// ── words ────────────────────────────────────────────────────────────────────

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const keyOf = (ref: string | null): string | null => (ref ? parseAskRef(ref)?.key ?? null : null);
const statusWord = (s: unknown): string | null => (typeof s === "string" && s in TICKET_STATUS_LABEL ? TICKET_STATUS_LABEL[s as TicketStatus] : null);
/** "#30", "#30 and #31", "#30, #31 and #32". */
export function listNumbers(ns: string[]): string {
  const xs = ns.map((n) => `#${n}`);
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
const line = (vm: AskActionVm, label: string): string | null => vm.preview?.lines.find((l) => l.label === label)?.value ?? null;
const docTitle = (vm: AskActionVm): string => vm.preview?.item?.title ?? line(vm, "Doc") ?? str(vm.fields.title) ?? str(vm.fields.slug) ?? "the doc";
const refWord = (ref: string): string => {
  const p = parseAskRef(ref);
  if (!p) return ref;
  if (p.type === "ticket" || p.type === "handoff") return `${p.type} #${p.key}`;
  if (p.type === "pr") return `PR #${p.key}`;
  return `${p.type} ${p.key}`;
};

/** The write a card is. An Auto write streams its result with no card before it, so the tool is read from the
 *  result's shape when the stream did not say (a contract gap: `action_result` carries no `tool`). */
export function toolOf(vm: AskActionVm): string | null {
  if (vm.tool) return vm.tool;
  const p = vm.ref ? parseAskRef(vm.ref) : null;
  const r = rec(vm.result);
  if (p?.type === "handoff" && "recipient" in r) return "send_handoff";
  if (p?.type === "artifact") return "save_artifact";
  if (p?.type === "ticket") {
    if ("title" in r && !("status" in r)) return "create_ticket";
    if ("status" in r && !("title" in r)) return "transition_ticket";
  }
  return null;
}

/** What a done line says ("Created ticket #30", "Filed tickets #30, #31 and #32", "Moved ticket #14 to In progress"). */
export function doneText(vms: AskActionVm[]): string {
  const vm = vms[0];
  const tool = toolOf(vm);
  const nums = vms.map((x) => keyOf(x.ref)).filter((x): x is string => x !== null);
  const n = nums[0] ?? keyOf(vm.preview?.item?.ref ?? null);
  const r = rec(vm.result);
  const more = (s: string) => (vms.length > 1 ? `${s} and ${vms.length - 1} more` : s);
  switch (tool) {
    case "create_ticket": return vms.length > 1 && nums.length ? `Filed tickets ${listNumbers(nums)}` : n ? `Created ticket #${n}` : "Created the ticket";
    case "transition_ticket": return more(`Moved ticket #${n} to ${statusWord(r.status) ?? statusWord(vm.fields.to) ?? "its new status"}`);
    case "edit_ticket": return more(`Edited ticket #${n}`);
    case "add_ticket_comment": return more(`Commented on ticket #${n}`);
    case "add_ticket_link": return more(`Linked work to ticket #${n}`);
    case "set_ticket_sprint": return more(`Moved ticket #${n} to ${str(rec(r.sprint).label) ?? "the backlog"}`);
    case "set_ticket_parent": return more(`Nested a sub-ticket under ticket #${n}`);
    case "assign_ticket": return more(`Changed who is on ticket #${n}`);
    case "send_handoff": {
      const to = str(r.recipient) ?? str(vm.fields.recipient);
      return more(`Sent handoff #${n} to ${!to || to === "anyone" ? "anyone" : `@${to}`}`);
    }
    case "claim_handoff": return `Claimed handoff #${n}`;
    case "expire_handoff": return `Expired handoff #${n}`;
    case "propose_doc_update": return `Proposed an edit to ${docTitle(vm)}. It waits in Review.`;
    case "publish_doc": return `Published ${docTitle(vm)} to the org`;
    case "create_sprint": return more(`Created the sprint ${str(r.label) ?? ""}`.trim());
    case "complete_sprint": return `Completed ${vm.preview?.item?.title ?? "the sprint"}`;
    case "update_plan": return "Updated the roadmap plan";
    case "save_prompt": return `Staged the prompt ${str(r.slug) ?? ""}`.trim();
    case "append_feed": return "Added a feed entry";
    case "save_artifact": return `Saved as artifact: ${str(r.title) ?? "Untitled"}`;
    default: return more(vm.preview?.title ?? (vm.ref ? `Changed ${refWord(vm.ref)}` : "Done"));
  }
}

/** What was proposed, for "Cancelled: …" / "Expired: …" ("new ticket", "move ticket #14 to Testing"). */
export function proposedText(vms: AskActionVm[]): string {
  const vm = vms[0];
  switch (toolOf(vm)) {
    case "create_ticket": return vms.length > 1 ? `${vms.length} new tickets` : "New ticket";
    case "send_handoff": return "New handoff";
    case "propose_doc_update": return `Doc edit to ${docTitle(vm)}`;
    case "publish_doc": return `Publish ${docTitle(vm)}`;
  }
  const t = vm.preview?.title ?? "Change";
  // A ticket's card says "#14"; the line says "ticket #14".
  return vm.preview?.item?.type === "ticket" || vm.kind === "move" ? t.replace(/(^|\s)#(\d+)/g, "$1ticket #$2") : t;
}

const EYEBROW: Record<string, string> = { create_ticket: "New ticket", send_handoff: "New handoff", propose_doc_update: "Doc edit", publish_doc: "Publish doc" };
const KIND_WORD: Record<string, string> = { ticket: "Ticket", handoff: "Handoff", doc_edit: "Doc edit", move: "Move", publish: "Publish doc", sprint: "Sprint", other: "Change" };
const CREATES = new Set(["create_ticket", "send_handoff", "propose_doc_update", "create_sprint", "save_prompt", "append_feed"]);

// ── icons the design draws (not in ask-icons.ts) ─────────────────────────────

const svgIcon = (size: number, sw: number, paths: string) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const I_CHECK = svgIcon(13, 2.4, `<path d="m5 12.5 4.5 4.5L19 7.5"></path>`);
const I_UNDO = svgIcon(12, 2, `<path d="M9 14 4 9l5-5"></path><path d="M4 9h11a5 5 0 0 1 0 10h-3"></path>`);
const I_OPEN = svgIcon(12, 2, `<path d="M7 17 17 7"></path><path d="M8 7h9v9"></path>`);
const I_SAVE = svgIcon(13, 1.9, `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M12 12v5M9.5 14.5h5"></path>`);

/** A state as the design draws it on a card or a line: its shape alone (the sentence beside it names it). */
const SHAPE = {
  done: () => markShape("check", "var(--accent)", 10),
  off: () => markShape("square", "var(--fg-40)", 9),
  bad: () => markShape("diamond", "var(--red)", 9),
  warn: () => markShape("triangle", "var(--amber)", 9),
  waiting: () => markShape("ring", "var(--fg-55)", 9),
};

// ── cards ────────────────────────────────────────────────────────────────────

const draftOf = (v: AskView, id: number): Record<string, unknown> => v.ui.actions.drafts[id] ?? {};
/** A field's value on screen: the person's edit, else the card's. */
const fieldOf = (v: AskView, vm: AskActionVm, f: string): unknown => (f in draftOf(v, vm.id) ? draftOf(v, vm.id)[f] : vm.fields[f]);
const label = (k: string, body: string) => `<div><div class="ask-act-k">${esc(k)}</div>${body}</div>`;
const canEdit = (vm: AskActionVm, f: string) => vm.editable.includes(f);

/** The people a pick offers: the picked one, the viewer, then the org's members — five at most (a switch, not a list). */
function peopleFor(v: AskView, picked: string | null, max: number, withMe = true): string[] {
  const me = v.app.me?.handle ?? null;
  const out: string[] = [];
  const add = (h: string | null | undefined) => { if (h && !out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h); };
  add(picked);
  if (withMe) add(me);
  for (const p of [...v.look.persons].sort((a, b) => (a.name ?? a.handle).localeCompare(b.name ?? b.handle))) {
    if (out.length >= max) break;
    if (!withMe && me && p.handle.toLowerCase() === me.toLowerCase()) continue;
    add(p.handle);
  }
  return out.slice(0, max);
}
const firstName = (v: AskView, h: string): string => (personOf(v.look, h)?.name ?? h).split(/\s+/)[0];

function ticketBody(v: AskView, vm: AskActionVm, editing: boolean): string {
  const title = String(fieldOf(v, vm, "title") ?? vm.preview?.title ?? "");
  const body = String(vm.fields.body ?? line(vm, "Description") ?? "");
  const cat = String(fieldOf(v, vm, "category") ?? line(vm, "Category") ?? "other");
  const prio = String(fieldOf(v, vm, "priority") ?? line(vm, "Priority") ?? "normal") as TicketPriority;
  const asg = (fieldOf(v, vm, "assignee") as string | null | undefined) ?? null;
  const sprint = line(vm, "Sprint") ?? "Backlog";
  if (!editing) {
    return `<div class="ask-act-body" data-morph-key="view">
      <div class="ask-act-row">${glyph("todo", "var(--fg-55)", 13)}<div class="ask-act-main"><div class="ask-act-title">${esc(title)}</div>${body ? `<div class="ask-act-desc">${esc(body)}</div>` : ""}</div></div>
      <div class="ask-act-grid">
        ${label("Category", `<span class="ask-act-v">${esc(cat)}</span>`)}
        ${label("Priority", `<span class="ask-act-v ask-act-iv">${PRIORITY_LABEL[prio] ? `${priorityIcon(prio, 13, false)}${esc(PRIORITY_LABEL[prio])}` : esc(prio)}</span>`)}
        ${label("Assignee", `<span class="ask-act-v ask-act-iv ask-act-strong">${asg ? `${refAvatar(v.look, asg, 18)}${esc(personName(v.look, asg))}` : "Unassigned"}</span>`)}
        ${label("Sprint", `<span class="ask-act-v">${esc(sprint)}</span>`)}
      </div>
    </div>`;
  }
  const id = vm.id;
  const field = (f: string, inner: string) => (canEdit(vm, f) ? inner : "");
  return `<div class="ask-act-form" data-morph-key="edit">
    ${field("title", `<label class="ask-field">Title<input class="ask-input-line" data-act="askAcField" data-arg="${id}|title" data-field="askAcTitle${id}" value="${attr(title)}" maxlength="200" /></label>`)}
    ${field("category", `<div class="ask-field"><span>Category</span>${segmented({ id: `ask-ac-cat-${id}`, ariaLabel: "Category", value: cat, act: "askAcField", size: "sm",
      options: TICKET_CATEGORIES.map((c) => ({ value: c, label: c, arg: `${id}|category|${c}` })) })}</div>`)}
    ${field("priority", `<div class="ask-field"><span>Priority</span>${segmented({ id: `ask-ac-prio-${id}`, ariaLabel: "Priority", value: prio, act: "askAcField", size: "sm",
      options: (["high", "normal", "low"] as TicketPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: priorityIcon(p, 12, false, "currentColor"), arg: `${id}|priority|${p}` })) })}</div>`)}
    ${field("assignee", `<div class="ask-field"><span>Assignee</span>${segmented({ id: `ask-ac-asg-${id}`, ariaLabel: "Assignee", value: asg ?? "", act: "askAcField", size: "sm",
      options: peopleFor(v, asg, 5).map((h) => ({ value: h, label: firstName(v, h), icon: refAvatar(v.look, h, 16), arg: `${id}|assignee|${h}` })) })}</div>`)}
  </div>`;
}

function handoffBody(v: AskView, vm: AskActionVm, editing: boolean): string {
  const from = (line(vm, "From") ?? "").replace(/^@/, "") || v.app.me?.handle || "";
  const to = String(fieldOf(v, vm, "recipient") ?? "anyone");
  const task = String(fieldOf(v, vm, "task") ?? line(vm, "Task") ?? "");
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const done = list(vm.fields.done), next = list(vm.fields.next), files = list(vm.fields.files);
  const anyone = to === "anyone";
  const id = vm.id;
  const head = `<div class="ask-act-who">${from ? `${refAvatar(v.look, from, 18)}<span class="ask-act-strong">${esc(personName(v.look, from))}</span>` : ""}${askIcon("arrow", 14, "var(--fg-40)", 2)}${anyone ? "" : refAvatar(v.look, to, 18)}<span class="ask-act-strong">${esc(anyone ? "Anyone" : personName(v.look, to))}</span>${anyone ? `<span class="ask-act-faint">· any agent session can claim it</span>` : ""}</div>`;
  const editor = editing
    ? `<div class="ask-act-form ask-act-form--in" data-morph-key="edit">
        ${canEdit(vm, "recipient") ? `<div class="ask-field"><span>Send to</span>${segmented({ id: `ask-ac-to-${id}`, ariaLabel: "Send to", value: to, act: "askAcField", size: "sm",
          options: [{ value: "anyone", label: "Anyone", arg: `${id}|recipient|anyone` }, ...peopleFor(v, anyone ? null : to, 4, false).map((h) => ({ value: h, label: firstName(v, h), icon: refAvatar(v.look, h, 16), arg: `${id}|recipient|${h}` }))] })}</div>` : ""}
        ${canEdit(vm, "task") ? `<label class="ask-field">Task<input class="ask-input-line" data-act="askAcField" data-arg="${id}|task" data-field="askAcTask${id}" value="${attr(task)}" /></label>` : ""}
      </div>`
    : `<div class="ask-act-title ask-act-title--h" data-morph-key="view">${esc(task)}</div>`;
  const col = (k: string, xs: string[], g: "done" | "todo") => `<div><div class="ask-act-k">${k}</div>${xs.map((t) => `<div class="ask-act-li${g === "todo" ? " is-next" : ""}"><span>${glyph(g, g === "done" ? "var(--accent)" : "var(--fg-55)", 13)}</span>${esc(t)}</div>`).join("")}</div>`;
  return `<div class="ask-act-body">${head}${editor}
    ${done.length || next.length ? `<div class="ask-act-cols">${col("Done", done, "done")}${col("Next", next, "todo")}</div>` : ""}
    ${files.length ? `<div class="ask-act-files">${files.map((p) => `<span>${esc(p)}</span>`).join("")}</div>` : ""}
  </div>`;
}

function hunksView(v: AskView, vm: AskActionVm, hunks: AskDocHunk[], editing: boolean): string {
  const drafts = rec(draftOf(v, vm.id).hunks);
  return hunks.map((h) => {
    const after = typeof drafts[h.index] === "string" ? String(drafts[h.index]) : h.after;
    const add = editing && canEdit(vm, "hunks")
      ? `<div class="ask-diff-row is-add is-edit"><span class="ask-diff-sign">+</span><textarea rows="2" data-act="askAcHunk" data-arg="${vm.id}|${h.index}" data-field="askAcHunk${vm.id}-${h.index}" aria-label="New text${h.heading ? ` under ${attr(h.heading)}` : ""}">${esc(after)}</textarea></div>`
      : after ? `<div class="ask-diff-row is-add"><span class="ask-diff-sign">+</span><span>${esc(after)}</span></div>` : "";
    return `<div class="ask-diff" data-morph-key="h${h.index}">
      ${h.heading ? `<div class="ask-diff-row is-h"><span class="ask-diff-sign"></span>${esc(h.heading)}</div>` : ""}
      ${h.before ? `<div class="ask-diff-row is-del"><span class="ask-diff-sign">−</span><s>${esc(h.before)}</s></div>` : ""}
      ${add}
    </div>`;
  }).join("");
}

function docBody(v: AskView, vm: AskActionVm, editing: boolean): string {
  const [from, to] = (line(vm, "Version") ?? "").split("→").map((s) => s.trim());
  return `<div class="ask-act-body">
    <div class="ask-act-doc">${askIcon("docs", 14, "var(--fg-55)")}<span class="ask-act-strong">${esc(docTitle(vm))}</span>${from ? `<span class="ask-act-ver">${esc(to ? `${from} → ${to}` : from)}</span>` : ""}<span class="ask-grow"></span><span class="ask-act-faint">Goes to Review before it is live</span></div>
    <div class="ask-diffs" data-morph-list>${hunksView(v, vm, vm.preview?.hunks ?? [], editing)}</div>
    ${line(vm, "More") ? `<div class="ask-act-faint ask-act-more">${esc(line(vm, "More")!)}</div>` : ""}
  </div>`;
}

function publishBody(vm: AskActionVm): string {
  const item = vm.preview?.item ?? null;
  const ver = line(vm, "Version") ?? (typeof item?.extra.version === "number" ? `v${item.extra.version}` : "");
  const space = str(item?.extra.space);
  const staged = (vm.preview?.hunks ?? []).flatMap((h) => h.after.split("\n")).map((s) => s.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean).slice(0, 8);
  const what = line(vm, "What it does") ?? `Publishing makes ${ver || "it"} live for the org. Agents read it from then on.`;
  return `<div class="ask-act-body">
    <div class="ask-act-doc">${askIcon("docs", 14, "var(--fg-55)")}<span class="ask-act-strong">${esc(docTitle(vm))}</span><span class="ask-act-ver">${esc([space ? upperFirst(space) : null, ver].filter(Boolean).join(" · "))}</span><span class="ask-grow"></span>${item?.status ? refStatusMark(item.status, 12) : ""}</div>
    <div class="ask-act-desc">${esc(what)}</div>
    ${staged.length ? `<ul class="ask-act-ul">${staged.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

/** Any other write (a move, a sprint, a comment…): the server's title and its lines. */
function genericBody(vm: AskActionVm): string {
  const lines = (vm.preview?.lines ?? []).filter((l) => l.label !== "What it does");
  return `<div class="ask-act-body">
    <div class="ask-act-title">${esc(vm.preview?.title ?? "Change")}</div>
    ${lines.length ? `<div class="ask-act-lines">${lines.map((l) => `<div class="ask-act-k">${esc(l.label)}</div><div class="ask-act-v">${esc(l.value)}</div>`).join("")}</div>` : ""}
  </div>`;
}

function bodyOf(v: AskView, vm: AskActionVm, editing: boolean): string {
  switch (toolOf(vm)) {
    case "create_ticket": return ticketBody(v, vm, editing);
    case "send_handoff": return handoffBody(v, vm, editing);
    case "propose_doc_update": return docBody(v, vm, editing);
    case "publish_doc": return publishBody(vm);
    default: return genericBody(vm);
  }
}

/** One card: a single write, or the pending writes of one group (stacked in one frame, one Confirm). */
function cardView(v: AskView, vms: AskActionVm[]): string {
  const vm = vms[0];
  const ids = vms.map((x) => x.id);
  const tool = toolOf(vm) ?? "";
  const waiting = vms.some((x) => x.state === "waiting");
  const busy = vms.some((x) => v.ui.actions.busy[x.id] === true || x.state === "running");
  const editable = vms.length === 1 && vm.editable.length > 0 && ["create_ticket", "send_handoff", "propose_doc_update"].includes(tool);
  const editing = editable && v.ui.actions.editing[vm.id] === true;
  const eyebrow = vms.length > 1 && tool === "create_ticket" ? `${vms.length} new tickets` : EYEBROW[tool] ?? KIND_WORD[vm.kind ?? "other"] ?? "Change";
  const draftWord = CREATES.has(tool) ? "Draft, not created yet" : "Draft, not done yet";
  const mark = waiting
    ? `<span class="ask-act-st" data-mtip="${attr(vm.note ?? "It waits for you to confirm it.")}">${SHAPE.warn()}Waiting for you</span>`
    : `<span class="ask-act-st" data-mtip="Nothing happens until you confirm it.">${SHAPE.waiting()}${draftWord}</span>`;
  // A Publish asks for someone who may promote: anyone else gets the Review page instead of Confirm.
  const publishBlocked = tool === "publish_doc" && vm.preview?.canPublish === false;
  const note = vms.map((x) => x.note).find(Boolean) ?? null;
  const arg = ids.join(",");
  const confirm = publishBlocked
    ? `<a class="ask-btn ask-btn--accent" href="#review">Open in Review</a>`
    : `<button type="button" class="ask-btn ask-btn--accent ask-act-confirm" data-act="askAcConfirm" data-arg="${arg}"${busy ? " disabled" : ""}>${I_CHECK}${busy ? "Working…" : "Confirm"}</button>`;
  const bodies = vms.length > 1
    ? `<div class="ask-act-stack" data-morph-list>${vms.map((x) => `<div data-morph-key="g${x.id}">${bodyOf(v, x, false)}</div>`).join("")}</div>`
    : bodyOf(v, vm, editing);
  return `<div class="ask-act" data-morph-key="act:${ids[0]}" data-ask-tween${busy ? ` aria-busy="true"` : ""}>
    <div class="ask-act-head">
      <span class="ask-eyebrow">${esc(eyebrow)}</span>${mark}<span class="ask-grow"></span>
      ${editable ? `<button type="button" class="ask-act-edit" data-act="askAcEdit" data-arg="${vm.id}" aria-expanded="${editing}"${busy ? " disabled" : ""}>${editing ? "Done editing" : "Edit"}</button>` : ""}
    </div>
    ${bodies}
    <div class="ask-act-foot">
      ${note ? `<span class="ask-act-note">${SHAPE.warn()}${esc(note)}</span>` : ""}<span class="ask-grow"></span>
      <button type="button" class="ask-btn" data-act="askAcCancel" data-arg="${arg}"${busy ? " disabled" : ""}>Cancel</button>
      ${confirm}
    </div>
  </div>`;
}

// ── lines ────────────────────────────────────────────────────────────────────

type LineCat = "done" | "cancelled" | "undone" | "expired" | "failed";
const catOf = (s: AskActionVm["state"]): LineCat | null =>
  s === "confirmed" || s === "auto" ? "done" : s === "cancelled" ? "cancelled" : s === "undone" ? "undone" : s === "expired" ? "expired" : s === "failed" ? "failed" : null;
const timeWord = (at: string | null): string => (at ? upperFirst(relTime(at)) : "");

function lineView(v: AskView, vms: AskActionVm[], cat: LineCat): string {
  const vm = vms[0];
  const ids = vms.map((x) => x.id);
  const busy = vms.some((x) => v.ui.actions.busy[x.id] === true);
  const key = `ln:${ids[0]}:${cat}`;
  if (cat !== "done") {
    const text = cat === "cancelled" ? `Cancelled: ${lowerFirst(proposedText(vms))}`
      : cat === "undone" ? `Undone: ${lowerFirst(doneText(vms))}`
      : cat === "expired" ? `Expired: ${lowerFirst(proposedText(vms))}`
      : `Didn't work: ${lowerFirst(proposedText(vms))}`;
    const why = cat === "failed" ? str(rec(vm.result).error) ?? str(rec(vm.result).message) : cat === "expired" ? "This card expired with its turn. Ask again." : null;
    return `<div class="ask-line is-off" data-morph-key="${key}">${cat === "failed" ? SHAPE.bad() : SHAPE.off()}<span class="ask-line-t">${esc(text)}</span>${why ? `<span class="ask-line-why">${esc(why)}</span>` : ""}</div>`;
  }
  const refused = ids.map((id) => v.ui.actions.refused[id]).find(Boolean) ?? null;
  const canUndo = !refused && vms.some((x) => x.undo && (x.state === "confirmed" || x.state === "auto"));
  const undo = canUndo ? `<button type="button" class="ask-undo" data-act="askAcUndo" data-arg="${ids.join(",")}"${busy ? " disabled" : ""}>${I_UNDO}${busy ? "Undoing…" : "Undo"}</button>` : "";
  const refusedHtml = refused
    ? `<span class="ask-line-refused">${SHAPE.warn()}${esc(refused.message)}</span>${refused.ref ? `<button type="button" class="ask-undo" data-act="askShOpen" data-arg="${attr(refused.ref)}">Open ${esc(refWord(refused.ref))}</button>` : ""}`
    : "";
  // Saved as an artifact (Auto saves at once): the saved line, with Open.
  if (toolOf(vm) === "save_artifact") {
    const r = rec(vm.result);
    const vis = r.visibility === "org" ? "Org" : "Private";
    return `<div class="ask-line ask-line--saved" data-morph-key="${key}">${SHAPE.done()}<span class="ask-line-t">Saved as artifact: ${esc(str(r.title) ?? "Untitled")}</span><span class="ask-line-vis">· ${vis}</span><span class="ask-grow"></span>
      ${refusedHtml || `<span class="ask-line-at">${esc(timeWord(vm.at))}</span>`}
      ${vm.ref ? `<button type="button" class="ask-undo" data-act="askShOpen" data-arg="${attr(vm.ref)}">Open${I_OPEN}</button>` : ""}${undo}</div>`;
  }
  const text = doneText(vms);
  const link = vm.ref ?? vm.preview?.item?.ref ?? null;
  return `<div class="ask-line" data-morph-key="${key}">${SHAPE.done()}${link
    ? `<button type="button" class="ask-line-link" data-act="askShOpen" data-arg="${attr(link)}">${esc(text)}</button>`
    : `<span class="ask-line-t">${esc(text)}</span>`}<span class="ask-grow"></span>${refusedHtml || `<span class="ask-line-at">${esc(timeWord(vm.at))}</span>`}${undo}</div>`;
}

/** One card / line for consecutive actions of one group (`shownParts`' `actions` entry). The pending ones are one
 *  card; the decided ones a line per outcome. */
export function actionGroupView(v: AskView, a: AskAnswer, ids: number[]): string {
  const vms = ids.map((id) => a.turn.actions[id]).filter((x): x is AskActionVm => !!x);
  if (!vms.length) return "";
  const pending = vms.filter((x) => x.state === "proposed" || x.state === "waiting" || x.state === "running");
  const out: string[] = [];
  if (pending.length) out.push(cardView(v, pending));
  for (const cat of ["done", "undone", "cancelled", "expired", "failed"] as LineCat[]) {
    const these = vms.filter((x) => catOf(x.state) === cat);
    if (these.length) out.push(lineView(v, these, cat));
  }
  return `<div class="ask-acts" data-ask-tween data-morph-list>${out.join("")}</div>`;
}

// ── Save as artifact ─────────────────────────────────────────────────────────

const orgName = (v: AskView): string => v.app.me?.orgs.find((o) => o.slug === v.app.orgSlug)?.name ?? "your organization";

/** The footer's / a block's "Save as artifact" (no model call: the server adds a save form under the answer). */
export function saveButton(a: AskAnswer, block?: number, cls = "ask-ghostbtn"): string {
  if (a.turn.messageId === null) return "";
  return `<button type="button" class="${attr(cls)}" data-act="askAcSaveForm" data-arg="${attr(block === undefined ? a.key : `${a.key}|${block}`)}">${I_SAVE}Save as artifact</button>`;
}

/** A `save_form` block: the form, or once saved its line. */
export function saveFormView(v: AskView, a: AskAnswer, block: Extract<AskBlock, { kind: "save_form" }>, index: number): string {
  const f = block.form;
  const fk = `${a.key}|${index}`;
  if (f.saved) {
    return `<div class="ask-acts" data-ask-tween><div class="ask-line ask-line--saved" data-morph-key="saved:${attr(fk)}">${SHAPE.done()}<span class="ask-line-t">Saved as artifact: ${esc(f.saved.title)}</span><span class="ask-line-vis">· ${f.saved.visibility === "org" ? "Org" : "Private"}</span><span class="ask-grow"></span>
      <button type="button" class="ask-undo" data-act="askShOpen" data-arg="${attr(`artifact:${f.saved.slug}`)}">Open${I_OPEN}</button></div></div>`;
  }
  const d = v.ui.actions.forms[fk] ?? {};
  const title = d.title ?? f.title;
  const kind = d.kind ?? f.kind;
  const vis = d.visibility ?? f.visibility;
  const busy = v.ui.actions.saving[fk] === true;
  const domKey = fk.replace(/[^A-Za-z0-9_-]/g, "_");
  return `<div class="ask-acts" data-ask-tween><div class="ask-save" data-morph-key="save:${attr(fk)}">
    <div class="ask-save-head">${askIcon("artifacts", 15, "var(--fg-55)")}<span class="ask-eyebrow">Save as artifact</span></div>
    <label class="ask-field">Title<input class="ask-input-line ask-input-line--lg" data-act="askAcSaveTitle" data-arg="${attr(fk)}" data-field="askAcSave${domKey}" value="${attr(title)}" maxlength="200" placeholder="Name it" /></label>
    <div class="ask-save-opts">
      <div class="ask-field"><span>Kind</span>${segmented({ id: `ask-save-k-${domKey}`, ariaLabel: "Kind", value: kind, act: "askAcSaveKind", size: "sm",
        options: [{ value: "markdown", label: "Markdown", arg: `${fk}|markdown` }, { value: "html", label: "HTML page", arg: `${fk}|html` }] })}</div>
      <div class="ask-field"><span>Who can see it</span>${segmented({ id: `ask-save-v-${domKey}`, ariaLabel: "Who can see it", value: vis, act: "askAcSaveVis", size: "sm",
        options: [{ value: "private", label: "Private", arg: `${fk}|private` }, { value: "org", label: "Org", arg: `${fk}|org` }] })}</div>
    </div>
    <div class="ask-save-foot">
      <span class="ask-save-hint">${esc(vis === "org" ? `Everyone in ${orgName(v)} can open it from Artifacts.` : "Only you can see it. You can publish it to the org later.")}</span>
      <button type="button" class="ask-btn ask-btn--accent" data-act="askAcSave" data-arg="${attr(fk)}"${busy || !title.trim() ? " disabled" : ""}>${busy ? "Saving…" : "Save"}</button>
    </div>
  </div></div>`;
}

// ── Wrong? ───────────────────────────────────────────────────────────────────

/** The footer's "Wrong?" (it opens the reasons row under the footer). */
export function wrongButton(v: AskView, a: AskAnswer, cls = "ask-ghostbtn"): string {
  if (a.turn.messageId === null) return "";
  const open = v.ui.actions.wrongOpen[a.key] === true && !v.ui.closing[`wrong:${a.key}`];
  return `<button type="button" class="${attr(cls)}" data-act="askAcWrong" data-arg="${attr(a.key)}" aria-expanded="${open}">Wrong?</button>`;
}

/** Under the footer: the three reasons while Wrong? is open. */
export function feedbackView(v: AskView, a: AskAnswer): string {
  if (!v.ui.actions.wrongOpen[a.key] || a.turn.messageId === null) return "";
  const k = `wrong:${a.key}`;
  return `<div class="ask-wrong" data-morph-key="${attr(k)}" role="group" aria-label="What was wrong?"${closingAttr(v.ui.closing, k)}>
    <span class="ask-wrong-q">What was wrong?</span>
    ${ASK_WRONG_REASONS.map((r) => `<button type="button" class="ask-wrong-opt" data-act="askAcWrongReason" data-arg="${attr(`${a.key}|${r}`)}">${esc(ASK_WRONG_LABELS[r])}</button>`).join("")}
  </div>`;
}

// ── state changes ────────────────────────────────────────────────────────────

const WHERES: AskWhere[] = ["page", "panel"];

/** The answer an arg names: its key (`a…`, `m…`) or its stored message id. */
export function findAnswer(ctx: Pick<AskCtx, "ui">, name: string): { where: AskWhere; answer: AskAnswer } | null {
  const id = /^\d+$/.test(name) ? Number(name) : null;
  for (const where of WHERES) {
    for (const m of ctx.ui[where].messages) {
      if (m.role === "assistant" && (m.key === name || (id !== null && m.turn.messageId === id))) return { where, answer: m };
    }
  }
  return null;
}
function setAnswer(ctx: AskCtx, where: AskWhere, key: string, f: (t: AskTurn) => AskTurn): void {
  const c: AskConvo = ctx.ui[where];
  ctx.ui[where] = { ...c, messages: c.messages.map((m) => (m.role === "assistant" && m.key === key ? { ...m, turn: f(m.turn) } : m)) };
}
function actionVm(ctx: Pick<AskCtx, "ui">, id: number): AskActionVm | null {
  for (const where of WHERES) for (const m of ctx.ui[where].messages) if (m.role === "assistant" && m.turn.actions[id]) return m.turn.actions[id];
  return null;
}
function setActionState(ctx: AskCtx, id: number, state: AskActionVm["state"]): void {
  for (const where of WHERES) {
    ctx.ui[where] = withTurnOfAction(ctx.ui[where], id, (t) => ({ ...t, actions: { ...t.actions, [id]: { ...t.actions[id], state } } }));
  }
}

/** Fold a Confirm / Cancel / Undo answer into whichever conversation holds those cards. */
export function applyResults(ctx: AskCtx, ans: Pick<AskActionAnswer, "results">): void {
  for (const where of WHERES) {
    let c = ctx.ui[where];
    for (const r of ans.results) {
      c = withTurnOfAction(c, r.id, (t) => {
        const prev = t.actions[r.id];
        const next = applyActionResult(t, r);
        // An undone line still says what was done ("Undone: filed tickets #30, #31 and #32"): Undo's own result
        // (what was written back) does not replace the write's.
        return r.state === "undone" && prev ? { ...next, actions: { ...next.actions, [r.id]: { ...next.actions[r.id], result: prev.result, ref: prev.ref } } } : next;
      });
    }
    ctx.ui[where] = c;
  }
  ctx.paint();
}

/** The edited fields a Confirm sends — only the editable ones that changed (`hunks` as `[{ index, after }]`). */
export function editedArgs(vm: AskActionVm, draft: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!draft) return null;
  const out: Record<string, unknown> = {};
  for (const f of vm.editable) {
    if (f === "hunks") {
      const hs = rec(draft.hunks);
      const list = Object.entries(hs).flatMap(([i, after]) => {
        const h = vm.preview?.hunks?.find((x) => x.index === Number(i));
        return typeof after === "string" && h && after !== h.after ? [{ index: Number(i), after }] : [];
      });
      if (list.length) out.hunks = list;
      continue;
    }
    if (!(f in draft)) continue;
    const val = typeof draft[f] === "string" ? (draft[f] as string).trim() : draft[f];
    if (val !== vm.fields[f]) out[f] = val;
  }
  return Object.keys(out).length ? out : null;
}

const parseIds = (arg: string | null): number[] => (arg ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
function setBusy(ctx: AskCtx, ids: number[], on: boolean): void {
  const next = { ...ctx.ui.actions.busy };
  for (const id of ids) { if (on) next[id] = true; else delete next[id]; }
  ctx.ui.actions.busy = next;
}
const pendingOf = (ctx: AskCtx, ids: number[]) => ids.filter((id) => { const s = actionVm(ctx, id)?.state; return s === "proposed" || s === "waiting"; });

/** A refusal the card shows rather than a toast: an expired card collapses to its line. */
function onRefusal(ctx: AskCtx, ids: number[], e: unknown, fallback: string): void {
  if (e instanceof AskApiError && e.code === "expired") {
    for (const id of pendingOf(ctx, ids)) setActionState(ctx, id, "expired");
    ctx.flash(e.message || "This card expired with its turn. Ask again.");
    return;
  }
  ctx.fail(e, fallback);
}

/** Confirm a card or a group: each EDITED card first with its edits (the server confirms that one alone), then the
 *  rest of the group in one call. */
export async function confirmCards(ctx: AskCtx, ids: number[]): Promise<void> {
  const live = pendingOf(ctx, ids);
  if (!live.length || live.some((id) => ctx.ui.actions.busy[id])) return;
  setBusy(ctx, live, true);
  ctx.paint();
  try {
    for (const id of live) {
      const vm = actionVm(ctx, id);
      const args = vm ? editedArgs(vm, ctx.ui.actions.drafts[id]) : null;
      if (!args) continue;
      applyResults(ctx, await ctx.api.confirmAction(id, { args }));
    }
    const rest = pendingOf(ctx, live);
    // The rest of the card in ONE call: the server runs every still-pending card of the group.
    if (rest.length) applyResults(ctx, await ctx.api.confirmAction(rest[0]));
    const done = live.map((id) => actionVm(ctx, id)).filter((x): x is AskActionVm => !!x && (x.state === "confirmed" || x.state === "auto"));
    const failed = live.map((id) => actionVm(ctx, id)).find((x) => x?.state === "failed");
    for (const id of live) { delete ctx.ui.actions.drafts[id]; delete ctx.ui.actions.editing[id]; }
    if (failed) ctx.flash(str(rec(failed.result).error) ?? "That change didn't work. Nothing else was changed.");
    else if (done.length) ctx.flash(doneText(done));
  } catch (e) {
    onRefusal(ctx, live, e, "Couldn't make that change.");
  } finally {
    setBusy(ctx, live, false);
    ctx.paint();
  }
}

export async function cancelCards(ctx: AskCtx, ids: number[]): Promise<void> {
  const live = pendingOf(ctx, ids);
  if (!live.length || live.some((id) => ctx.ui.actions.busy[id])) return;
  setBusy(ctx, live, true);
  ctx.paint();
  try {
    applyResults(ctx, await ctx.api.cancelAction(live[0]));     // the whole group goes
    for (const id of live) { delete ctx.ui.actions.drafts[id]; delete ctx.ui.actions.editing[id]; }
  } catch (e) {
    onRefusal(ctx, live, e, "Couldn't cancel that.");
  } finally {
    setBusy(ctx, live, false);
    ctx.paint();
  }
}

/** Undo a line (the server reverses its whole group, newest first). When someone changed the item since, nothing
 *  more is undone and the line says "Changed since. Undo it by hand." with a link to the item. */
export async function undoCards(ctx: AskCtx, ids: number[]): Promise<void> {
  if (!ids.length || ids.some((id) => ctx.ui.actions.busy[id])) return;
  setBusy(ctx, ids, true);
  ctx.paint();
  try {
    applyResults(ctx, await ctx.api.undoAction(ids[0]));
    ctx.flash("Undone");
  } catch (e) {
    if (e instanceof AskApiError && Array.isArray(e.body.results)) applyResults(ctx, { results: e.body.results as AskEventMap["action_result"][] });
    if (e instanceof AskApiError && e.code === "changed") {
      const next = { ...ctx.ui.actions.refused };
      for (const id of ids) next[id] = { message: e.message || "Changed since. Undo it by hand.", ref: e.ref };
      ctx.ui.actions.refused = next;
    } else ctx.fail(e, "Couldn't undo that.");
  } finally {
    setBusy(ctx, ids, false);
    ctx.paint();
  }
}

/** The footer's / a block's Save as artifact: the server adds a save form under that answer (no model call). */
export async function addSaveForm(ctx: AskCtx, answerName: string, block?: number): Promise<void> {
  const found = findAnswer(ctx, answerName);
  const id = found?.answer.turn.messageId ?? null;
  if (!found || id === null) return;
  const sk = `${found.answer.key}|form`;
  if (ctx.ui.actions.saving[sk]) return;
  // One open form per answer: Save again only brings the person back to it.
  if (found.answer.turn.parts.some((p) => p.kind === "block" && p.block.kind === "save_form" && !p.block.form.saved && p.block.form.block === (block ?? null))) return;
  ctx.ui.actions.saving = { ...ctx.ui.actions.saving, [sk]: true };
  try {
    const r = await ctx.api.saveForm(id, block);
    setAnswer(ctx, found.where, found.answer.key, (t) => ({ ...t, parts: [...t.parts, { kind: "block", block: r.block }] }));
  } catch (e) {
    ctx.fail(e, "Couldn't open the save form.");
  } finally {
    const { [sk]: _gone, ...rest } = ctx.ui.actions.saving;
    ctx.ui.actions.saving = rest;
    ctx.paint();
  }
}

/** The save form's part (by its block index) in a turn. */
function formAt(t: AskTurn, index: number): AskSaveForm | null {
  let n = 0;
  for (const p of t.parts) {
    if (p.kind !== "block") continue;
    if (n++ === index) return p.block.kind === "save_form" ? p.block.form : null;
  }
  return null;
}
function withForm(t: AskTurn, index: number, f: (x: AskSaveForm) => AskSaveForm): AskTurn {
  let n = 0;
  return { ...t, parts: t.parts.map((p) => (p.kind === "block" && n++ === index && p.block.kind === "save_form" ? { kind: "block" as const, block: { kind: "save_form" as const, form: f(p.block.form) } } : p)) };
}

export async function saveArtifact(ctx: AskCtx, fk: string): Promise<void> {
  const cut = fk.lastIndexOf("|");
  const found = findAnswer(ctx, fk.slice(0, cut));
  const index = Number(fk.slice(cut + 1));
  const form = found ? formAt(found.answer.turn, index) : null;
  if (!found || !form || form.saved || ctx.ui.actions.saving[fk]) return;
  const threadId = ctx.ui[found.where].threadId;
  const d = ctx.ui.actions.forms[fk] ?? {};
  const title = (d.title ?? form.title).trim();
  if (threadId === null || !title) return;
  const messageId = form.messageId ?? found.answer.turn.messageId ?? undefined;
  ctx.ui.actions.saving = { ...ctx.ui.actions.saving, [fk]: true };
  ctx.paint();
  try {
    const saved = await ctx.api.saveThread(threadId, {
      ...(messageId !== undefined ? { messageId } : {}), ...(form.block !== null ? { block: form.block } : {}),
      title, kind: d.kind ?? form.kind, visibility: d.visibility ?? form.visibility,
    });
    setAnswer(ctx, found.where, found.answer.key, (t) => withForm(t, index, (x) => ({ ...x, title: saved.title, visibility: saved.visibility, saved })));
    delete ctx.ui.actions.forms[fk];
    ctx.want([`artifact:${saved.slug}`]);
    ctx.flash("Saved to Artifacts");
  } catch (e) {
    ctx.fail(e, "Couldn't save it.");
  } finally {
    const { [fk]: _gone, ...rest } = ctx.ui.actions.saving;
    ctx.ui.actions.saving = rest;
    ctx.paint();
  }
}

/** Close the Wrong? row (it pops out), keyed by answer. */
function closeWrong(ctx: AskCtx, key: string): void {
  if (!ctx.ui.actions.wrongOpen[key]) return;
  ctx.exit(`wrong:${key}`, () => { const { [key]: _gone, ...rest } = ctx.ui.actions.wrongOpen; ctx.ui.actions.wrongOpen = rest; }, 140);
}

export async function markWrong(ctx: AskCtx, answerName: string, reason: AskWrongReason): Promise<void> {
  const found = findAnswer(ctx, answerName);
  const id = found?.answer.turn.messageId ?? null;
  if (!found || id === null || !(ASK_WRONG_REASONS as readonly string[]).includes(reason)) return;
  closeWrong(ctx, found.answer.key);
  try {
    await ctx.api.markWrong(id, reason);
    ctx.flash("Thanks. The team can see this in Review.");
  } catch (e) {
    ctx.fail(e, "Couldn't send that.");
  }
}

// ── the dev replay (ask-replay.ts › replayPlan `actions-ask` / `actions-auto`) ─

/** The exchange BEFORE the streamed turn, as the design draws it (ask-trov.dc.html L1186–1190, L1307, L1318): the
 *  transcript streams only the last turn. A confirmed line and a cancelled one (`actions-ask`); an undone move
 *  (`actions-auto`). Display only — nothing is written in replay mode. */
export function replayPriorExchange(auto: boolean, at = new Date().toISOString()): AskMsg[] {
  const vm = (id: number, tool: string, kind: AskActionVm["kind"], state: AskActionVm["state"], title: string, ref: string | null, extra: Partial<AskActionVm> = {}): AskActionVm =>
    ({ id, groupId: `0-${id}`, tool, kind, state, preview: { title, lines: [], item: null }, fields: {}, editable: [], note: null, result: null, ref, undo: false, at, ...extra });
  const turn = (text: string, vms: AskActionVm[], activity: AskTurn["activity"] = []): AskTurn => ({
    ...newTurn("smart"), messageId: auto ? 5 : 3, activity, done: true,
    parts: [{ kind: "text", md: text }, ...vms.map((x) => ({ kind: "action" as const, id: x.id }))],
    actions: Object.fromEntries(vms.map((x) => [x.id, x])),
  });
  const q = (text: string): AskMsg => ({ role: "user", key: `rq-${auto ? "auto" : "ask"}`, id: null, text, context: [], attachments: [], command: null });
  return auto
    ? [q("Move #14 to Done."), { role: "assistant", key: "ra-auto", turn: turn("Moved it. Undo is there if that was early.", [
        vm(40, "transition_ticket", "move", "undone", "Move #14 to Done", "ticket:14", { fields: { to: "done" } })]) }]
    : [q("File a ticket for the failing Netlify connect test and move #14 to Testing."), { role: "assistant", key: "ra-ask", turn: turn("Done where you confirmed.", [
        vm(29, "create_ticket", "ticket", "confirmed", "New ticket", "ticket:29", { result: { id: 29, title: "Fix the Netlify connect test on main" } }),
        vm(28, "transition_ticket", "move", "cancelled", "Move #14 to Testing", null, { fields: { to: "testing" } }),
      ], [{ step: 1, tool: "get_repo_dashboard", icon: "ci", label: "Checked CI on AndresL230/trov", state: "done", results: [], resultLine: null }]) }];
}

/** What the replay's Confirm answers for the design's cards (the item each one makes), so its done line reads as
 *  the design's: "Created ticket #30", "Sent handoff #12 to anyone", the doc edit, the publish. */
export const REPLAY_WRITES: Record<number, { ref: string; result: unknown }> = {
  31: { ref: "ticket:30", result: { id: 30, title: "Reconnect expired hosting tokens from Org settings" } },
  32: { ref: "handoff:12", result: { id: 12, recipient: "anyone", url: "#handoffs/12" } },
  33: { ref: "doc:hosting-connections", result: { outcome: "staged" } },
  46: { ref: "doc:release-0-30-notes", result: { promoted: true } },
};

// ── the acts ─────────────────────────────────────────────────────────────────

function setDraft(ctx: AskCtx, id: number, f: (d: Record<string, unknown>) => Record<string, unknown>): void {
  ctx.ui.actions.drafts = { ...ctx.ui.actions.drafts, [id]: f(ctx.ui.actions.drafts[id] ?? {}) };
}
function setFormDraft(ctx: AskCtx, fk: string, patch: ActionsUi["forms"][string]): void {
  ctx.ui.actions.forms = { ...ctx.ui.actions.forms, [fk]: { ...(ctx.ui.actions.forms[fk] ?? {}), ...patch } };
}
/** `<head>|<last>` split at the LAST bar (an answer key never holds one; the value might). */
const splitLast = (s: string): [string, string] => { const i = s.lastIndexOf("|"); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };

export const actionsPart: AskPart = {
  code: "Ac",
  act(ctx, name, arg, value) {
    const a = arg ?? "";
    switch (name) {
      case "askAcConfirm": void confirmCards(ctx, parseIds(a)); return;
      case "askAcCancel": void cancelCards(ctx, parseIds(a)); return;
      case "askAcUndo": void undoCards(ctx, parseIds(a)); return;
      case "askAcEdit": {
        const id = Number(a);
        if (!(id > 0)) return;
        ctx.ui.actions.editing = { ...ctx.ui.actions.editing, [id]: !ctx.ui.actions.editing[id] };
        ctx.paint();
        return;
      }
      case "askAcField": {
        const [id, field, picked] = a.split("|");
        const n = Number(id);
        if (!(n > 0) || !field) return;
        const val = picked !== undefined ? picked : value ?? "";
        setDraft(ctx, n, (d) => ({ ...d, [field]: val }));
        // A typed field repaints nothing (the input holds it); a pick moves its switch.
        if (picked !== undefined) ctx.paint();
        return;
      }
      case "askAcHunk": {
        const [id, index] = a.split("|").map(Number);
        if (!(id > 0) || !Number.isInteger(index)) return;
        setDraft(ctx, id, (d) => ({ ...d, hunks: { ...rec(d.hunks), [index]: value ?? "" } }));
        return;
      }
      case "askAcSaveForm": {
        const [ans, block] = a.split("|");
        void addSaveForm(ctx, ans, block !== undefined && /^\d+$/.test(block) ? Number(block) : undefined);
        return;
      }
      case "askAcSaveTitle": {
        setFormDraft(ctx, a, { title: value ?? "" });
        ctx.paint();               // Save is off while the title is empty
        return;
      }
      case "askAcSaveKind": case "askAcSaveVis": {
        const [fk, pick] = splitLast(a);
        if (name === "askAcSaveKind" && (pick === "markdown" || pick === "html")) setFormDraft(ctx, fk, { kind: pick });
        else if (name === "askAcSaveVis" && (pick === "private" || pick === "org")) setFormDraft(ctx, fk, { visibility: pick });
        ctx.paint();
        return;
      }
      case "askAcSave": void saveArtifact(ctx, a); return;
      case "askAcWrong": {
        const found = findAnswer(ctx, a);
        if (!found) return;
        const k = found.answer.key;
        if (ctx.ui.actions.wrongOpen[k] && !ctx.ui.closing[`wrong:${k}`]) closeWrong(ctx, k);
        else { ctx.cancelExit(`wrong:${k}`); ctx.ui.actions.wrongOpen = { ...ctx.ui.actions.wrongOpen, [k]: true }; ctx.paint(); }
        return;
      }
      case "askAcWrongReason": {
        const [ans, reason] = splitLast(a);
        void markWrong(ctx, ans, reason as AskWrongReason);
        return;
      }
    }
  },
  escape: [{
    layer: "menu",
    isOpen: (ctx) => Object.keys(ctx.ui.actions.wrongOpen).some((k) => !ctx.ui.closing[`wrong:${k}`]),
    close: (ctx) => { for (const k of Object.keys(ctx.ui.actions.wrongOpen)) closeWrong(ctx, k); },
  }],
};
