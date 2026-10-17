// Ask Trov — write cards, Save as artifact and "Wrong?" (the ACTIONS part; inventory §3, §4, §2f › Wrong?;
// scenarios `actions-ask`, `actions-auto`, `artifact`, `artifact-saved`; design ask-trov.dc.html L475–590,
// L1651–1672, L630–638; #12 §2.11–12, §2.14, §3).
//
//   • A CARD (`action` event, state proposed | waiting): the head — the eyebrow ("New ticket", "Move", …), a mark
//     ("Draft, not created yet" / "Waiting for you") and a waiting card's reason — then the body per kind, designed on
//     its own: it fills the card's width (fields in columns across it, a row's note at its right edge). Cancel /
//     Confirm FLOAT outside the frame, a compact right-aligned pair just under its bottom-right edge, the same for
//     every kind and a group (`cardView`). EVERY field the tool's input takes (`editable` —
//     ticket: title, category, priority, assignee; handoff: recipient, task; doc edit: the `+` text of each hunk; an
//     edit to a ticket: its new title; an assignment: the person) is edited IN PLACE on the card — there is no Edit
//     mode: text is clicked into an input that looks the same (Enter / leaving it keeps it, Escape puts it back), a
//     small fixed set (category, priority) cycles with a click, a person is the app's `dropdown()` (its menu among
//     the root overlays through `actionDropdowns`). `confirm { args }` sends ONLY the changed editable fields; the
//     server re-validates them and rebuilds the card. A Publish card never runs in Auto (it waits with the server's
//     note) and offers Confirm only when `preview.canPublish` — else "Open in Review". An ASSIGNMENT (`assign_ticket`,
//     a group of them, or a handoff's claim) draws the item with its status mark and the people: from → to, "Adds" /
//     "Removes" beside who stays. A MOVE is one row: the ticket, from → to at its right.
//   • A LINE (after the decision), ONE line each: the mark and what happened — done (linked to `ref`), "Cancelled:
//     …", "Undone: …", "Expired: …" or "Didn't work: …" — the reason muted on the same line (cut short, all of it in
//     its tooltip), then the time and Undo / Open at its end. Consecutive cards of one `groupId` are ONE card / ONE
//     line ("Filed tickets #30, #31 and #32") with one Confirm and one Undo for the group. Undo refused because the
//     item changed since (409 `changed`) says "Changed since. Undo it by hand." with Open for the item.
//   • SAVE AS ARTIFACT: `saveButton` (the footer, a block) asks the server for a `save_form` block (no model call)
//     and adds it under that answer; the form (Kind and Who can see it as `segmented()` at its head's right, the
//     title with Save at its end) becomes the saved line ("Saved as artifact: <title> · Private", Open). In Auto the
//     server saves at once: the stream's `action_result` for `save_artifact` draws the same saved line, with Undo.
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
//   actionsPart                                     the acts (`askAc…`), the keys and Escape of text edited in place,
//                                                   the Wrong? row's Escape layer
// Acts and their args (`|` separates; an answer is named by its key `a…` / `m…`, or by its stored message id):
//   askAcConfirm / askAcCancel / askAcUndo  "<id>[,<id>…]"   (the card's / group's ids)
//   askAcText "<id>|<field>" (open text for editing)   askAcField "<id>|<field>[|<value>]" (typed: value from the
//   input; a cycle: the next value)   askAcPick "<id>|<field>" with the dropdown's option as `value` (a person)
//   — a doc hunk's field is `hunk:<index>`
//   askAcSaveForm "<answer>[|<block>]"   askAcSaveTitle / askAcSaveKind / askAcSaveVis / askAcSave "<answer>|<index>[|<value>]"
//   askAcWrong "<answer>"   askAcWrongReason "<answer>|<reason>"
// MOTION (ask-motion.ts): every card / line / form sits in a `data-ask-tween` wrapper, so a card collapsing to its
// line and a form becoming its saved line glide (once — `tweenStart`); a line and the save form enter once (a new
// `data-morph-key`), the Wrong? row pops in and out (`ctx.exit`, `data-closing`). Editing in place moves nothing: the
// card only changes its words. Nothing replays on a rerender: the page is `data-morph`, and an unchanged key is
// patched in place.
// CSS: `/* ── Ask: actions ── */` in trov.css.

import { esc, attr, relTime } from "./ui";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { convoOf, readOnly } from "./ask-state";
import { applyActionResult, newTurn, withTurnOfAction, type AskActionVm, type AskAnswer, type AskConvo, type AskMsg, type AskTurn } from "./ask-stream";
import { AskApiError } from "./ask-api";
import { segmented } from "./segmented";
import { glyph, markShape, priorityIcon, priorityMark, ticketStatusMark, PRIORITY_LABEL } from "./marks";
import { personName, personOf, refAvatar, refStatusMark, type RefLook } from "./ask-refs";
import { dropdown, type DropdownOption, type DropdownProps } from "./dropdown";
import type { AppState } from "./render";
import { askIcon } from "./ask-icons";
import { closingAttr } from "./ask-motion";
import {
  ASK_WRONG_LABELS, ASK_WRONG_REASONS, parseAskRef, type AskActionAnswer, type AskBlock, type AskDocHunk, type AskEventMap, type AskSaveForm,
  type AskWrongReason,
} from "@shared/ai-ask-core";
import { TICKET_CATEGORIES, TICKET_STATUS_LABEL, type TicketPriority, type TicketStatus } from "@shared/tickets-core";
import { sprintDatesLabel } from "@shared/sprints-core";

export interface ActionsUi {
  /** Cards with a decision in flight (no double Confirm). */
  busy: Record<number, boolean>;
  /** Answers whose Wrong? row is open (by answer key). */
  wrongOpen: Record<string, boolean>;
  /** The text field being edited in place, per card, and what it held before (Escape puts that back). */
  inline: Record<number, { field: string; was: unknown; had: boolean }>;
  /** A text input that just opened: focus it after the paint (its data-field). */
  focusInline: string | null;
  /** The edited fields per card (kept until Confirm). `hunks` maps a hunk's index → text. */
  drafts: Record<number, Record<string, unknown>>;
  /** Undo refused because the item changed since: the server's words and the item to undo by hand (per card id). */
  refused: Record<number, { message: string; ref: string | null }>;
  /** A save form's picks before Save, by `<answer key>|<block index>`. */
  forms: Record<string, { title?: string; kind?: AskSaveForm["kind"]; visibility?: AskSaveForm["visibility"] }>;
  /** Save forms being saved, and answers asking for a form (same keys). */
  saving: Record<string, boolean>;
}
export const initialActionsUi = (): ActionsUi => ({ busy: {}, wrongOpen: {}, inline: {}, focusInline: null, drafts: {}, refused: {}, forms: {}, saving: {} });

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
/** "Jose", "Jose and Luke", "Jose, Luke and Meilin". */
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
type Look = Pick<RefLook, "persons">;
/** A person in a sentence: the directory's name when the screen knows it, else the handle. */
const who = (look: Look | undefined, h: string): string => (look ? personName(look, h) : `@${h}`);

// ── assignments (assign_ticket; claim_handoff draws the same frame) ──────────

/** One assignment write: the ticket, the person, adds or removes. From the card's fields (since the server sent
 *  them), else its preview's "Assignee: Add @h" line (a card stored before). */
export interface AssignOne { vm: AskActionVm; num: string | null; login: string; on: boolean }
export function assignOf(vm: AskActionVm, login?: string): AssignOne | null {
  const m = /^(Add|Remove) @(.+)$/.exec(line(vm, "Assignee") ?? "");
  const h = login ?? str(vm.fields.login) ?? m?.[2] ?? null;
  if (!h) return null;
  const on = typeof vm.fields.on === "boolean" ? vm.fields.on : m ? m[1] === "Add" : true;
  const id = vm.fields.id;
  const num = typeof id === "number" ? String(id) : vm.preview?.item?.num != null ? String(vm.preview.item.num) : keyOf(vm.ref);
  return { vm, num, login: h, on };
}
const sameH = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const without = (xs: string[], ys: string[]) => xs.filter((x) => !ys.some((y) => sameH(x, y)));
const handles = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s) : []);
/** Who is on the ticket now (the card's item, read when the card was made). */
const assigneesBefore = (vm: AskActionVm): string[] => handles(vm.preview?.item?.extra.assignees);

/** The writes of a group, ticket by ticket (consecutive assign_ticket calls share one card). */
function byTicket(xs: AssignOne[]): { num: string | null; adds: AssignOne[]; removes: AssignOne[] }[] {
  const out: { num: string | null; adds: AssignOne[]; removes: AssignOne[] }[] = [];
  for (const x of xs) {
    let t = out.find((o) => o.num === x.num);
    if (!t) out.push(t = { num: x.num, adds: [], removes: [] });
    (x.on ? t.adds : t.removes).push(x);
  }
  return out;
}

/** What an assignment group did / would do, in product words: "Assigned ticket #87 to Jose", "Reassigned ticket #87
 *  from Andres to Jose", "Took Luke off ticket #87", "Assigned tickets #87 and #6 to Jose". null: not one sentence. */
function assignWords(vms: AskActionVm[], look: Look | undefined, done: boolean): string | null {
  const xs = vms.map((x) => assignOf(x)).filter((x): x is AssignOne => !!x);
  if (!xs.length || xs.length !== vms.length) return null;
  const ts = byTicket(xs);
  const names = (ys: AssignOne[]) => listWords(ys.map((y) => who(look, y.login)));
  const tk = (n: string | null) => (n ? `ticket #${n}` : "the ticket");
  if (ts.length > 1) {
    // Several tickets: one sentence only when it is the same person, all added (or all removed).
    const one = xs.every((x) => sameH(x.login, xs[0].login) && x.on === xs[0].on);
    const nums = ts.map((t) => t.num).filter((n): n is string => !!n);
    if (!one || nums.length !== ts.length) return null;
    return xs[0].on
      ? `${done ? "Assigned" : "Assign"} tickets ${listNumbers(nums)} to ${who(look, xs[0].login)}`
      : `${done ? "Took" : "Take"} ${who(look, xs[0].login)} off tickets ${listNumbers(nums)}`;
  }
  const t = ts[0];
  if (t.adds.length && t.removes.length) return `${done ? "Reassigned" : "Reassign"} ${tk(t.num)} from ${names(t.removes)} to ${names(t.adds)}`;
  if (t.adds.length) return `${done ? "Assigned" : "Assign"} ${tk(t.num)} to ${names(t.adds)}`;
  return `${done ? "Took" : "Take"} ${names(t.removes)} off ${tk(t.num)}`;
}
const docTitle = (vm: AskActionVm): string => vm.preview?.item?.title ?? line(vm, "Doc") ?? str(vm.fields.title) ?? str(vm.fields.slug) ?? "the doc";
const refWord = (ref: string): string => {
  const p = parseAskRef(ref);
  if (!p) return ref;
  if (p.type === "ticket" || p.type === "handoff") return `${p.type} #${p.key}`;
  if (p.type === "pr") return `PR #${p.key}`;
  return `${p.type} ${p.key}`;
};

/** The write a card is: the card's (or, for an Auto write, its `action_result`'s) `tool`. The shape-reading below is
 *  only for a stream recorded before `action_result` named its tool. */
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

/** What a done line says ("Created ticket #30", "Filed tickets #30, #31 and #32", "Moved ticket #14 to In progress",
 *  "Assigned ticket #87 to Jose"). `look` names people by their names (else their handles). */
export function doneText(vms: AskActionVm[], look?: Look): string {
  const vm = vms[0];
  const tool = toolOf(vm);
  const nums = vms.map((x) => keyOf(x.ref)).filter((x): x is string => x !== null);
  const n = nums[0] ?? keyOf(vm.preview?.item?.ref ?? null);
  const r = rec(vm.result);
  const more = (s: string) => (vms.length > 1 ? `${s} and ${vms.length - 1} more` : s);
  // The item's name with its number, or without one when the number is unknown (never "#null": invariant 7).
  const ticket = n ? `ticket #${n}` : "the ticket";
  const handoff = n ? `handoff #${n}` : "the handoff";
  switch (tool) {
    case "create_ticket": return vms.length > 1 && nums.length ? `Filed tickets ${listNumbers(nums)}` : n ? `Created ticket #${n}` : "Created the ticket";
    case "transition_ticket": return more(`Moved ${ticket} to ${statusWord(r.status) ?? statusWord(vm.fields.to) ?? "its new status"}`);
    case "edit_ticket": return more(`Edited ${ticket}`);
    case "add_ticket_comment": return more(`Commented on ${ticket}`);
    case "add_ticket_link": return more(`Linked work to ${ticket}`);
    case "set_ticket_sprint": return more(`Moved ${ticket} to ${str(rec(r.sprint).label) ?? "the backlog"}`);
    case "set_ticket_parent": return more(`Nested a sub-ticket under ${ticket}`);
    case "assign_ticket": return assignWords(vms, look, true) ?? more(`Changed who is on ${ticket}`);
    case "send_handoff": {
      const to = str(r.recipient) ?? str(vm.fields.recipient);
      return more(`Sent ${handoff} to ${!to || to === "anyone" ? "anyone" : `@${to}`}`);
    }
    case "claim_handoff": return `Claimed ${handoff}`;
    case "expire_handoff": return `Expired ${handoff}`;
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
export function proposedText(vms: AskActionVm[], look?: Look): string {
  const vm = vms[0];
  switch (toolOf(vm)) {
    case "assign_ticket": { const w = assignWords(vms, look, false); if (w) return w; break; }
    case "create_ticket": return vms.length > 1 ? `${vms.length} new tickets` : "New ticket";
    case "send_handoff": return "New handoff";
    case "propose_doc_update": return `Doc edit to ${docTitle(vm)}`;
    case "publish_doc": return `Publish ${docTitle(vm)}`;
  }
  const t = vm.preview?.title ?? "Change";
  // A ticket's card says "#14"; the line says "ticket #14".
  return vm.preview?.item?.type === "ticket" || vm.kind === "move" ? t.replace(/(^|\s)#(\d+)/g, "$1ticket #$2") : t;
}

const EYEBROW: Record<string, string> = {
  create_ticket: "New ticket", send_handoff: "New handoff", propose_doc_update: "Doc edit", publish_doc: "Publish doc", assign_ticket: "Assignment", claim_handoff: "Claim handoff",
};
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

const draftOf = (v: Pick<AskView, "ui">, id: number): Record<string, unknown> => v.ui.actions.drafts[id] ?? {};
/** A field's value on screen: the person's edit, else the card's. A doc hunk's field is `hunk:<index>`. */
const fieldOf = (v: Pick<AskView, "ui">, vm: AskActionVm, f: string): unknown => {
  const d = draftOf(v, vm.id);
  if (f.startsWith("hunk:")) {
    const i = Number(f.slice(5));
    const hs = rec(d.hunks);
    return i in hs ? hs[i] : vm.preview?.hunks?.find((h) => h.index === i)?.after ?? "";
  }
  return f in d ? d[f] : vm.fields[f];
};
const label = (k: string, body: string) => `<div class="ask-act-field"><div class="ask-act-k">${esc(k)}</div>${body}</div>`;
const canEdit = (vm: AskActionVm, f: string) => vm.editable.includes(f.startsWith("hunk:") ? "hunks" : f);

/** A card's closing row (most kinds): its fields, its people from → to, or its new title — the content alone, across
 *  the card's whole width (Cancel / Confirm are never in it: they float under the card, `cardView`). A keyed list,
 *  so an edit in place changes only its words. `cls`: is-fields (label-over-value fields in columns that fill the
 *  row), is-ruled (a hairline above), is-people. */
const metaRow = (pieces: string, cls = ""): string =>
  `<div class="ask-act-meta${cls ? ` ${cls}` : ""}" data-morph-key="meta" data-morph-list>${pieces}</div>`;
/** The quiet words a row ends on, at its right edge ("Andres Lopez stays on it", "Goes to Review before it is
 *  live") — so a row's content and its note span the card; narrow, the note takes the next line, left-aligned. */
const aside = (text: string, key = "aside"): string => `<span class="ask-act-aside" data-morph-key="${attr(key)}">${esc(text)}</span>`;
/** Label-over-value fields in columns that share the row's width (a new ticket's four, a sprint's, a write's short
 *  lines): one field fills the row, four split it. */
const fieldsRow = (fields: string[], cls = ""): string =>
  metaRow(`<div class="ask-act-fields${cls ? ` ${cls}` : ""}" data-morph-key="fields" style="--n:${fields.length}">${fields.join("")}</div>`, "is-fields is-ruled");

// ── editing in place ─────────────────────────────────────────────────────────
// There is no Edit mode: every field the write's input takes (`editable`) is a control on the pending card itself.
//   • a small fixed set (priority, category) is a CYCLE — one click steps to the next value (its tooltip lists them);
//   • a person (assignee, recipient, an assignment's person) is the app's `dropdown()` — its menu among the root
//     overlays (`actionDropdowns`);
//   • text (a title, a task, a doc hunk's new text) reads as text; a click turns it into an input that looks the
//     same (`inline`), Enter or leaving it keeps the edit, Escape puts back what it held.
// Each edit is a draft (`drafts`); Confirm sends only the changed editable fields (`editedArgs`), as before.

/** The data-field of a text control (the text and its input share it, so focus moves between them). */
const textField = (id: number, field: string): string => `askAcT${id}-${field.replace(/[^A-Za-z0-9]/g, "-")}`;
const inlineOpen = (v: Pick<AskView, "ui">, id: number, field: string): boolean => v.ui.actions.inline[id]?.field === field;

/** Text that edits in place: the text (a button that reads as it), or, while open, an input styled like it. */
function textEdit(v: AskView, vm: AskActionVm, field: string, value: string, cls: string, name: string, multiline = false): string {
  const id = vm.id;
  const df = textField(id, field);
  if (!canEdit(vm, field)) return `<span class="${cls}">${esc(value)}</span>`;
  if (inlineOpen(v, id, field)) {
    return multiline
      ? `<textarea class="ask-act-input ${cls}" rows="2" data-act="askAcField" data-arg="${id}|${field}" data-field="${df}" data-ask-inline="${id}" aria-label="${attr(name)}">${esc(value)}</textarea>`
      : `<input class="ask-act-input ${cls}" data-act="askAcField" data-arg="${id}|${field}" data-field="${df}" data-ask-inline="${id}" value="${attr(value)}" maxlength="200" aria-label="${attr(name)}" />`;
  }
  return `<button type="button" class="ask-act-txt ${cls}" data-act="askAcText" data-arg="${id}|${field}" data-field="${df}" aria-label="${attr(`${name}: ${value}. Click to edit`)}">${esc(value)}</button>`;
}

/** A small fixed set, cycled by a click: the value as a mark-like word; the tooltip says what comes next. */
function cycleEdit(vm: AskActionVm, field: string, value: string, options: { value: string; label: string; icon?: string }[], name: string): string {
  const cur = options.find((o) => o.value === value) ?? { value, label: value };
  const inner = `${cur.icon ?? ""}<span>${esc(cur.label)}</span>`;
  if (!canEdit(vm, field)) return `<span class="ask-act-v ask-act-iv">${inner}</span>`;
  const next = options[(options.findIndex((o) => o.value === value) + 1) % options.length];
  return `<button type="button" class="ask-act-cyc ask-act-v ask-act-iv" data-act="askAcField" data-arg="${vm.id}|${field}|${attr(next.value)}" aria-label="${attr(`${name}: ${cur.label}. Change to ${next.label}`)}" data-mtip="${attr(`${options.map((o) => o.label).join(" · ")} — click for ${next.label}`)}">${inner}</button>`;
}

/** The people a person-pick offers: every member, with their avatar ("You" beside the viewer). */
function peopleOptions(v: AskView, except: string[] = []): DropdownOption[] {
  const me = v.app.me?.handle ?? null;
  return v.look.persons
    .filter((p) => !except.some((x) => sameH(x, p.handle)))
    .map((p) => ({ value: p.handle, label: personName(v.look, p.handle), icon: refAvatar(v.look, p.handle, 18), ...(me && sameH(p.handle, me) ? { hint: "You" } : {}) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
const NONE = "~none";

/** A new ticket's Assignee pick. */
function assigneeProps(v: AskView, vm: AskActionVm): DropdownProps {
  const asg = (fieldOf(v, vm, "assignee") as string | null | undefined) ?? null;
  const cur = asg ? personOf(v.look, asg)?.handle ?? asg : NONE;
  const options = [{ value: NONE, label: "Unassigned" }, ...peopleOptions(v)];
  if (asg && !options.some((o) => sameH(o.value, cur))) options.push({ value: cur, label: personName(v.look, cur), icon: refAvatar(v.look, cur, 18) });
  return { id: `ask-ac-asg-${vm.id}`, act: "askAcPick", arg: `${vm.id}|assignee`, value: cur, options, ariaLabel: "Assignee", size: "sm" };
}
/** A new handoff's Send to pick: Anyone, or a member (not the sender). */
function recipientProps(v: AskView, vm: AskActionVm): DropdownProps {
  const to = String(fieldOf(v, vm, "recipient") ?? "anyone");
  const me = v.app.me?.handle ?? null;
  const cur = to === "anyone" ? "anyone" : personOf(v.look, to)?.handle ?? to;
  const options: DropdownOption[] = [{ value: "anyone", label: "Anyone", hint: "Any agent session can claim it" }, ...peopleOptions(v, me ? [me] : [])];
  if (!options.some((o) => sameH(o.value, cur))) options.push({ value: cur, label: personName(v.look, cur), icon: refAvatar(v.look, cur, 18) });
  return { id: `ask-ac-to-${vm.id}`, act: "askAcPick", arg: `${vm.id}|recipient`, value: cur, options, ariaLabel: "Send to", size: "sm" };
}
/** A dropdown on a card: the app's trigger, quiet until hovered (the card's text, with a caret). */
const pickIn = (v: AskView, p: DropdownProps, key: string): string => `<span class="ask-act-pick" data-morph-key="${attr(key)}">${dropdown(p, v.app.dd)}</span>`;

const CATEGORY_OPTS = TICKET_CATEGORIES.map((c) => ({ value: c, label: c }));
const PRIORITY_OPTS = (["high", "normal", "low"] as TicketPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: priorityIcon(p, 13, false) }));

/** A new ticket: its title (edits in place) and description, then its fields in four columns across the card —
 *  Category and Priority (a click cycles them), Assignee (a dropdown), Sprint. */
function ticketBody(v: AskView, vm: AskActionVm): string {
  const title = String(fieldOf(v, vm, "title") ?? vm.preview?.title ?? "");
  const body = String(vm.fields.body ?? line(vm, "Description") ?? "");
  const cat = String(fieldOf(v, vm, "category") ?? line(vm, "Category") ?? "other");
  const prio = String(fieldOf(v, vm, "priority") ?? line(vm, "Priority") ?? "normal");
  const asg = (fieldOf(v, vm, "assignee") as string | null | undefined) ?? null;
  const sprint = line(vm, "Sprint") ?? "Backlog";
  const assignee = canEdit(vm, "assignee") ? pickIn(v, assigneeProps(v, vm), "asg")
    : `<span class="ask-act-v ask-act-iv ask-act-strong">${asg ? `${refAvatar(v.look, asg, 18)}${esc(personName(v.look, asg))}` : "Unassigned"}</span>`;
  return `<div class="ask-act-body">
    <div class="ask-act-row">${glyph("todo", "var(--fg-55)", 13)}<div class="ask-act-main">${textEdit(v, vm, "title", title, "ask-act-title", "Title")}${body ? `<div class="ask-act-desc">${esc(body)}</div>` : ""}</div></div>
    ${fieldsRow([
      label("Category", cycleEdit(vm, "category", cat, CATEGORY_OPTS, "Category")),
      label("Priority", cycleEdit(vm, "priority", prio, PRIORITY_OPTS, "Priority")),
      label("Assignee", assignee),
      label("Sprint", `<span class="ask-act-v ask-act-iv">${esc(sprint)}</span>`),
    ], "is-ticket")}
  </div>`;
}

/** A person on a write card: their avatar and name (people.ts through `refAvatar`). `strong`: the one who comes or
 *  goes — the change the card is about. */
const personTag = (v: AskView, h: string, strong = false, key = `p:${h.toLowerCase()}`): string =>
  `<span class="ask-asg-p${strong ? " is-strong" : ""}" data-morph-key="${attr(key)}">${refAvatar(v.look, h, 20)}<span class="ask-asg-n">${esc(personName(v.look, h))}</span></span>`;
const toArrow = () => `<span class="ask-asg-to" data-morph-key="to">${askIcon("arrow", 14, "var(--fg-40)", 2)}<span class="cnpy-sr">to</span></span>`;
/** The faint words after the people ("Andres Lopez stays on it", "No one else can claim it after"), at the row's
 *  right edge. */
const peopleHint = (text: string, key = "stays"): string => aside(text, key);

/** A new handoff: the task (edits in place), Done / Next, its files, then who it goes from → to — the recipient a
 *  dropdown — with what that means at the row's right (the assignment card's people row). */
function handoffBody(v: AskView, vm: AskActionVm): string {
  const from = (line(vm, "From") ?? "").replace(/^@/, "") || v.app.me?.handle || "";
  const to = String(fieldOf(v, vm, "recipient") ?? "anyone");
  const task = String(fieldOf(v, vm, "task") ?? line(vm, "Task") ?? "");
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const done = list(vm.fields.done), next = list(vm.fields.next), files = list(vm.fields.files);
  const anyone = to === "anyone";
  const rcpt = canEdit(vm, "recipient") ? pickIn(v, recipientProps(v, vm), "rcpt")
    : anyone ? `<span class="ask-asg-p is-strong" data-morph-key="rcpt">Anyone</span>` : personTag(v, to, true, "rcpt");
  const who = `${from ? personTag(v, from, false, "from") : ""}${toArrow()}${rcpt}${anyone ? peopleHint("Any agent session can claim it") : ""}`;
  const col = (k: string, xs: string[], g: "done" | "todo") => `<div><div class="ask-act-k">${k}</div>${xs.map((t) => `<div class="ask-act-li${g === "todo" ? " is-next" : ""}"><span>${glyph(g, g === "done" ? "var(--accent)" : "var(--fg-55)", 13)}</span>${esc(t)}</div>`).join("")}</div>`;
  return `<div class="ask-act-body">${textEdit(v, vm, "task", task, "ask-act-title", "Task")}
    ${done.length || next.length ? `<div class="ask-act-cols">${col("Done", done, "done")}${col("Next", next, "todo")}</div>` : ""}
    ${files.length ? `<div class="ask-act-files">${files.map((p) => `<span>${esc(p)}</span>`).join("")}</div>` : ""}
    ${metaRow(who, "is-people is-ruled")}
  </div>`;
}

/** A doc edit's hunks: the heading for context, the old line struck out, the new one (edits in place). */
function hunksView(v: AskView, vm: AskActionVm, hunks: AskDocHunk[]): string {
  return hunks.map((h) => {
    const f = `hunk:${h.index}`;
    const after = String(fieldOf(v, vm, f) ?? "");
    const add = canEdit(vm, f) || after
      ? `<div class="ask-diff-row is-add"><span class="ask-diff-sign">+</span>${textEdit(v, vm, f, after, "ask-diff-t", `New text${h.heading ? ` under ${h.heading}` : ""}`, true)}</div>`
      : "";
    return `<div class="ask-diff" data-morph-key="h${h.index}">
      ${h.heading ? `<div class="ask-diff-row is-h"><span class="ask-diff-sign"></span>${esc(h.heading)}</div>` : ""}
      ${h.before ? `<div class="ask-diff-row is-del"><span class="ask-diff-sign">−</span><s>${esc(h.before)}</s></div>` : ""}
      ${add}
    </div>`;
  }).join("");
}

/** A doc edit: the doc and its version step, "Goes to Review before it is live" at that row's right, then the hunks
 *  across the card. */
function docBody(v: AskView, vm: AskActionVm): string {
  const [from, to] = (line(vm, "Version") ?? "").split("→").map((s) => s.trim());
  const more = line(vm, "More");
  return `<div class="ask-act-body">
    <div class="ask-act-doc">${askIcon("docs", 14, "var(--fg-55)")}<span class="ask-act-strong">${esc(docTitle(vm))}</span>${from ? `<span class="ask-act-ver">${esc(to ? `${from} → ${to}` : from)}</span>` : ""}${aside(`${more ? `${more} · ` : ""}Goes to Review before it is live`)}</div>
    <div class="ask-diffs" data-morph-list>${hunksView(v, vm, vm.preview?.hunks ?? [])}</div>
  </div>`;
}

/** Publish a staged doc: the doc (its space, version and status at the row's right), what is staged, then what
 *  publishing does. */
function publishBody(vm: AskActionVm): string {
  const item = vm.preview?.item ?? null;
  const ver = line(vm, "Version") ?? (typeof item?.extra.version === "number" ? `v${item.extra.version}` : "");
  const space = str(item?.extra.space);
  const staged = (vm.preview?.hunks ?? []).flatMap((h) => h.after.split("\n")).map((s) => s.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean).slice(0, 8);
  const what = line(vm, "What it does") ?? `Publishing makes ${ver || "it"} live for the org. Agents read it from then on.`;
  return `<div class="ask-act-body">
    <div class="ask-act-doc">${askIcon("docs", 14, "var(--fg-55)")}<span class="ask-act-strong">${esc(docTitle(vm))}</span><span class="ask-act-ver">${esc([space ? upperFirst(space) : null, ver].filter(Boolean).join(" · "))}</span><span class="ask-grow"></span>${item?.status ? refStatusMark(item.status, 12) : ""}</div>
    ${staged.length ? `<ul class="ask-act-ul">${staged.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${metaRow(`<span class="ask-act-lead" data-morph-key="what">${esc(what)}</span>`, "is-ruled")}
  </div>`;
}

const NOBODY = `<span class="ask-asg-none" data-morph-key="none">Unassigned</span>`;
/** An item on a card: its number and title, a click opens it. */
const itemTag = (ref: string | null, num: string | null, title: string, key = "item"): string => {
  const inner = `${num ? `<span class="ask-asg-num">#${esc(num)}</span>` : ""}<span class="ask-asg-title">${esc(title)}</span>`;
  return ref ? `<button type="button" class="ask-asg-item" data-morph-key="${key}" data-act="askShOpen" data-arg="${attr(ref)}">${inner}</button>` : `<span class="ask-asg-item" data-morph-key="${key}">${inner}</span>`;
};

/** The picker for one assignment write: the app's dropdown (never a native select), every member who could take it
 *  (an add) or everyone on it now (a removal), each with their avatar. Its menu is a root overlay
 *  (`actionDropdowns`, render.ts) — the same props on both sides. */
function assignPickProps(v: AskView, one: AssignOne): DropdownProps {
  const vm = one.vm;
  const cur = personOf(v.look, one.login)?.handle ?? one.login;
  const before = assigneesBefore(vm);
  const me = v.app.me?.handle ?? null;
  const pool = one.on
    ? v.look.persons.map((p) => p.handle).filter((h) => sameH(h, cur) || !before.some((b) => sameH(b, h)))
    : [...before];
  if (!pool.some((h) => sameH(h, cur))) pool.unshift(cur);
  const options = pool
    .map((h) => ({ value: personOf(v.look, h)?.handle ?? h, label: personName(v.look, h), icon: refAvatar(v.look, h, 18), ...(me && sameH(h, me) ? { hint: "You" } : {}) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { id: `ask-ac-asg-${vm.id}`, act: "askAcPick", arg: `${vm.id}|login`, value: cur, options, ariaLabel: one.on ? "Assign to" : "Take off", size: "sm" };
}

/** May this write's person be picked? An add: any member. A removal: only when someone else is on it to pick. */
const pickable = (one: AssignOne): boolean => canEdit(one.vm, "login") && (one.on || assigneesBefore(one.vm).length > 1);

/** The writes a card shows, with the person's pick in place of the proposed one. */
const assignsOf = (v: AskView, vms: AskActionVm[]): AssignOne[] =>
  vms.map((x) => assignOf(x, str(fieldOf(v, x, "login")) ?? undefined)).filter((x): x is AssignOne => !!x);

/** An assignment card's body: per ticket, the item (number, title, its status mark — a click opens it) and the
 *  change in people. A replacement reads from → to ("Andres → Jose"), an add to an unassigned ticket "Unassigned →
 *  Jose", a removal of the last one "Luke → Unassigned"; an add beside others "Adds Jose · Andres stays on it", a
 *  removal beside others "Removes Luke · Jose stays on it". The person who comes (or goes) is a dropdown whenever
 *  someone else could be picked. */
function assignBody(v: AskView, vms: AskActionVm[]): string {
  const ts = byTicket(assignsOf(v, vms));
  const pick = (one: AssignOne, strong: boolean) => (pickable(one)
    ? pickIn(v, assignPickProps(v, one), `pick:${one.vm.id}`)
    : personTag(v, one.login, strong, `p:${one.vm.id}`));
  return `<div class="ask-act-body ask-asg" data-morph-list>${ts.map((t) => {
    const vm = (t.adds[0] ?? t.removes[0]).vm;
    const item = vm.preview?.item ?? null;
    const ref = item?.ref ?? (t.num ? `ticket:${t.num}` : null);
    const before = assigneesBefore(vm);
    const gone = t.removes.map((x) => x.login), come = t.adds.map((x) => x.login);
    const stays = without(without(before, gone), come);
    const adds = t.adds.map((x) => pick(x, true)).join(""), removes = (strong: boolean) => t.removes.map((x) => pick(x, strong)).join("");
    const word = (w: string) => `<span class="ask-asg-w" data-morph-key="w">${w}</span>`;
    const change = t.adds.length && t.removes.length ? `${removes(false)}${toArrow()}${adds}`
      : t.adds.length ? (stays.length ? `${word("Adds")}${adds}` : `${NOBODY}${toArrow()}${adds}`)
      : stays.length ? `${word("Removes")}${removes(true)}` : `${removes(true)}${toArrow()}${NOBODY}`;
    const staysNote = stays.length ? peopleHint(`${listWords(stays.map((h) => personName(v.look, h)))} ${stays.length === 1 ? "stays" : "stay"} on it`) : "";
    const title = item?.title ?? (t.num ? `Ticket #${t.num}` : "The ticket");
    return `<div class="ask-asg-t" data-morph-key="t:${attr(t.num ?? String(vm.id))}">
      <div class="ask-asg-head">${itemTag(ref, t.num, title)}${item?.status ? `<span class="ask-asg-st">${refStatusMark(item.status, 12)}</span>` : ""}</div>
      ${metaRow(`${change}${staysNote}`, "ask-asg-who is-people")}
    </div>`;
  }).join("")}</div>`;
}

/** Claiming a handoff is an assignment too: the handoff, and it moving from its sender to you. */
function claimBody(v: AskView, vm: AskActionVm): string {
  const item = vm.preview?.item ?? null;
  const num = item?.num != null ? String(item.num) : keyOf(vm.ref ?? item?.ref ?? null);
  const from = str(item?.extra.from) ?? ((line(vm, "From") ?? "").replace(/^@/, "") || null);
  const me = v.app.me?.handle ?? null;
  const title = item?.title ?? line(vm, "Title") ?? (num ? `Handoff #${num}` : "The handoff");
  const ref = item?.ref ?? (num ? `handoff:${num}` : null);
  return `<div class="ask-act-body ask-asg"><div class="ask-asg-t" data-morph-key="t:${attr(num ?? String(vm.id))}">
    <div class="ask-asg-head">${itemTag(ref, num, title)}${item?.status ? `<span class="ask-asg-st">${refStatusMark(item.status, 12)}</span>` : ""}</div>
    ${metaRow(`${from ? personTag(v, from, false, "from") : ""}${toArrow()}${me ? personTag(v, me, true, "me") : `<span class="ask-asg-p is-strong" data-morph-key="me">You</span>`}${peopleHint("No one else can claim it after")}`, "ask-asg-who is-people")}
  </div></div>`;
}

/** A card's dropdowns (the people picks), for its triggers and for the root overlays. */
function cardDropdowns(v: AskView, vm: AskActionVm): DropdownProps[] {
  switch (toolOf(vm)) {
    case "assign_ticket": { const one = assignsOf(v, [vm])[0]; return one && pickable(one) ? [assignPickProps(v, one)] : []; }
    case "create_ticket": return canEdit(vm, "assignee") ? [assigneeProps(v, vm)] : [];
    case "send_handoff": return canEdit(vm, "recipient") ? [recipientProps(v, vm)] : [];
    default: return [];
  }
}

/** Every open card's dropdowns, for the root overlays: render.ts draws the open one's menu — over the Ask screen and
 *  over any page under the ⌘J panel. The props are the triggers' own. */
export function actionDropdowns(app: AppState): DropdownProps[] {
  const out: DropdownProps[] = [];
  for (const where of ["page", "panel"] as AskWhere[]) {
    const v: AskView = { app, ui: app.ask, where, look: { views: app.ask.refViews, persons: app.persons.data } };
    for (const m of app.ask[where].messages) {
      if (m.role !== "assistant") continue;
      for (const vm of Object.values(m.turn.actions)) {
        if (vm.state !== "proposed" && vm.state !== "waiting") continue;
        out.push(...cardDropdowns(v, vm));
      }
    }
  }
  return out;
}

/** "from → to" in a value: the arrow drawn, the new side in the strong face. */
const stepHtml = (value: string): string => {
  const [a, b] = value.split("→").map((s) => s.trim());
  return b === undefined ? esc(value) : `<span class="ask-mv"><span>${esc(upperFirst(a))}</span>${askIcon("arrow", 13, "var(--fg-40)", 2)}<span class="cnpy-sr">to</span><span class="ask-mv-to">${esc(upperFirst(b))}</span></span>`;
};
/** A line short enough to be a field in the row ("@priya", "Hosting, Billing"); a longer one is the card's text. */
const SHORT_LINE = 40;

/** Any other write (a comment, the plan, a link…): the server's title, its long lines as the card's text, then its
 *  short lines as label-over-value fields in columns across the card (the new ticket's row). */
function genericBody(vm: AskActionVm): string {
  const lines = (vm.preview?.lines ?? []).filter((l) => l.label !== "What it does");
  const short = lines.filter((l) => l.value.length <= SHORT_LINE && !l.value.includes("\n"));
  const long = lines.filter((l) => !short.includes(l));
  // The text: one long line is the card's text as is; several keep their names as a quiet lead-in.
  const named = long.length > 1;
  return `<div class="ask-act-body">
    <div class="ask-act-title">${esc(vm.preview?.title ?? "Change")}</div>
    ${long.map((l, i) => `<div class="ask-act-desc" data-morph-key="t${i}">${named ? `<span class="ask-fact-k">${esc(l.label)}</span>` : ""}${esc(l.value)}</div>`).join("")}
    ${short.length ? fieldsRow(short.map((l) => label(l.label, `<span class="ask-act-v ask-act-iv">${stepHtml(l.value)}</span>`))) : ""}
  </div>`;
}

/** A new sprint: its name, its summary as the card's text, then its fields across the card — Dates as the app
 *  writes them ("Nov 2 – 20"), Lead (avatar and name), Urgency. */
function sprintBody(v: AskView, vm: AskActionVm): string {
  const start = line(vm, "Start"), due = line(vm, "Due");
  const lead = (line(vm, "Lead") ?? "").replace(/^@/, "") || null;
  const urgency = line(vm, "Urgency") as TicketPriority | null;
  const summary = line(vm, "Summary");
  const dates = start ? sprintDatesLabel({ start, due }) : due ? `Due ${sprintDatesLabel({ start: due, due }) ?? due}` : null;
  const fields = [
    label("Dates", dates ? `<span class="ask-act-v ask-act-iv">${askIcon("clock", 13, "var(--fg-55)")}<span>${esc(dates)}</span></span>` : `<span class="ask-act-v ask-act-iv ask-act-faint">No dates yet</span>`),
    lead ? label("Lead", `<span class="ask-act-v ask-act-iv ask-act-strong">${refAvatar(v.look, lead, 18)}<span>${esc(personName(v.look, lead))}</span></span>`) : "",
    urgency && urgency in PRIORITY_LABEL ? label("Urgency", `<span class="ask-act-v ask-act-iv">${priorityMark(urgency, 12.5, `${PRIORITY_LABEL[urgency]} urgency`)}</span>`) : "",
  ].filter(Boolean);
  return `<div class="ask-act-body">
    <div class="ask-act-title">${esc(vm.preview?.title ?? "New sprint")}</div>
    ${summary ? `<div class="ask-act-desc">${esc(summary)}</div>` : ""}
    ${fieldsRow(fields)}
  </div>`;
}

/** A status the card names ("In progress"), as the ticket's mark when it is one. */
const statusOf = (word: string): TicketStatus | null =>
  (Object.keys(TICKET_STATUS_LABEL) as TicketStatus[]).find((s) => TICKET_STATUS_LABEL[s].toLowerCase() === word.trim().toLowerCase()) ?? null;

/** A move (a ticket's status or sprint, a sprint's state): ONE row across the card — the item (number and title, a
 *  click opens it) on the left, from → to (the status marks, or the names) at its right. Narrow, from → to takes the
 *  next line. A move without its item reads as any other write. */
function moveBody(vm: AskActionVm): string {
  const item = vm.preview?.item ?? null;
  const l = vm.preview?.lines[0] ?? null;
  const [from, to] = (l?.value ?? "").split("→").map((s) => s.trim());
  if (!item || !from || !to) return genericBody(vm);
  const num = item.num != null ? String(item.num) : keyOf(item.ref);
  const fs = statusOf(from), ts = statusOf(to);
  const arrow = `${askIcon("arrow", 14, "var(--fg-40)", 2)}<span class="cnpy-sr">to</span>`;
  const step = fs && ts
    ? `${ticketStatusMark(fs)}${arrow}<span class="ask-mv-to">${ticketStatusMark(ts)}</span>`
    : `<span>${esc(upperFirst(from))}</span>${arrow}<span class="ask-mv-to">${esc(upperFirst(to))}</span>`;
  return `<div class="ask-act-body">
    <div class="ask-act-move">${itemTag(item.ref, num, item.title)}<span class="ask-mv" data-morph-key="mv">${step}</span></div>
  </div>`;
}

/** An edit to a ticket: the ticket (its status at the row's right), its new description, then its new title (edits
 *  in place) across the card. */
function editTicketBody(v: AskView, vm: AskActionVm): string {
  const item = vm.preview?.item ?? null;
  const t = line(vm, "Title");
  if (!item || !t) return genericBody(vm);
  const num = item.num != null ? String(item.num) : keyOf(item.ref);
  const was = t.split("→")[0].trim();
  const now = String(fieldOf(v, vm, "title") ?? t.split("→")[1]?.trim() ?? "");
  const desc = line(vm, "Description");
  return `<div class="ask-act-body">
    <div class="ask-asg-head">${itemTag(item.ref, num, was)}${item.status ? `<span class="ask-asg-st">${refStatusMark(item.status, 12)}</span>` : ""}</div>
    ${desc ? `<div class="ask-act-desc">${esc(desc)}</div>` : ""}
    ${metaRow(`<span class="ask-fact-k" data-morph-key="k">New title</span>${textEdit(v, vm, "title", now, "ask-act-strong ask-act-grow", "New title")}`, "is-ruled")}
  </div>`;
}

function bodyOf(v: AskView, vm: AskActionVm): string {
  const tool = toolOf(vm);
  switch (tool) {
    case "create_ticket": return ticketBody(v, vm);
    case "send_handoff": return handoffBody(v, vm);
    case "propose_doc_update": return docBody(v, vm);
    case "publish_doc": return publishBody(vm);
    case "assign_ticket": return assignBody(v, [vm]);
    case "claim_handoff": return claimBody(v, vm);
    case "create_sprint": return sprintBody(v, vm);
    case "edit_ticket": return editTicketBody(v, vm);
  }
  // A move — or any write that is one item going from → to (a sprint started, completed).
  const ls = vm.preview?.lines ?? [];
  return vm.kind === "move" || (vm.preview?.item && ls.length === 1 && ls[0].value.includes("→")) ? moveBody(vm) : genericBody(vm);
}

/** One card: a single write, or the pending writes of one group (stacked in one frame, one Confirm).
 *
 *  THE FLOATING PAIR: the frame holds the content alone — the head (eyebrow, mark, a waiting card's reason) and the
 *  body, which fills the card's width on its own. Cancel / Confirm (a group's ONE pair; "Open in Review" in place of
 *  Confirm for a Publish that cannot publish) sit OUTSIDE the frame, right-aligned just under its bottom-right edge
 *  — no band, no background — the same for every kind, on a phone and in the ⌘J panel too. They come right after
 *  the card's content in the DOM (the keyboard reaches them next), and they belong to the card's wrapper, which is
 *  what the decision swaps for its line: the pair leaves in the card's one glide (ask-motion.ts rule 4). */
function cardView(v: AskView, vms: AskActionVm[]): string {
  const vm = vms[0];
  const ids = vms.map((x) => x.id);
  const tool = toolOf(vm) ?? "";
  const waiting = vms.some((x) => x.state === "waiting");
  const busy = vms.some((x) => v.ui.actions.busy[x.id] === true || x.state === "running");
  const assign = tool === "assign_ticket";
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
  const btns = `<div class="ask-act-btns" role="group" aria-label="${attr(`${eyebrow}: confirm or cancel`)}">
      <button type="button" class="ask-btn" data-act="askAcCancel" data-arg="${arg}"${busy ? " disabled" : ""}>Cancel</button>
      ${confirm}
    </div>`;
  const bodies = assign ? assignBody(v, vms)
    : vms.length > 1
    ? `<div class="ask-act-stack" data-morph-list>${vms.map((x) => `<div data-morph-key="g${x.id}">${bodyOf(v, x)}</div>`).join("")}</div>`
    : bodyOf(v, vm);
  return `<div class="ask-act-w" data-morph-key="act:${ids[0]}" data-ask-tween${busy ? ` aria-busy="true"` : ""}>
    <div class="ask-act">
      <div class="ask-act-head">
        <span class="ask-eyebrow">${esc(eyebrow)}</span>${mark}${note ? `<span class="ask-act-note">${esc(note)}</span>` : ""}
      </div>
      ${bodies}
    </div>
    ${btns}
  </div>`;
}

// ── lines ────────────────────────────────────────────────────────────────────
// ONE line per outcome: the mark and what happened, then the reason as muted words on the same line (cut short with
// the whole of it as the tooltip), then the time and any action (Undo, Open) at its right end. On a phone it wraps
// as one flowing line of text, never a stacked block.

type LineCat = "done" | "cancelled" | "undone" | "expired" | "failed";
const catOf = (s: AskActionVm["state"]): LineCat | null =>
  s === "confirmed" || s === "auto" ? "done" : s === "cancelled" ? "cancelled" : s === "undone" ? "undone" : s === "expired" ? "expired" : s === "failed" ? "failed" : null;
const timeWord = (at: string | null): string => (at ? upperFirst(relTime(at)) : "");
/** The muted reason after what happened. */
const why = (text: string, lead = ""): string => `<span class="ask-line-why" data-mtip="${attr(text)}">${lead ? `<span class="ask-line-wmark">${lead}</span>` : ""}${esc(text)}</span>`;
const openBtn = (ref: string, word = `Open ${refWord(ref)}`): string =>
  `<button type="button" class="ask-undo" data-act="askShOpen" data-arg="${attr(ref)}">${esc(word)}${I_OPEN}</button>`;

function lineView(v: AskView, vms: AskActionVm[], cat: LineCat): string {
  const vm = vms[0];
  const ids = vms.map((x) => x.id);
  const busy = vms.some((x) => v.ui.actions.busy[x.id] === true);
  const key = `ln:${ids[0]}:${cat}`;
  if (cat !== "done") {
    const text = cat === "cancelled" ? `Cancelled: ${lowerFirst(proposedText(vms, v.look))}`
      : cat === "undone" ? `Undone: ${lowerFirst(doneText(vms, v.look))}`
      : cat === "expired" ? `Expired: ${lowerFirst(proposedText(vms, v.look))}`
      : `Didn't work: ${lowerFirst(proposedText(vms, v.look))}`;
    const reason = cat === "failed" ? str(rec(vm.result).error) ?? str(rec(vm.result).message) : cat === "expired" ? "This card expired with its turn." : null;
    // Didn't work: the item it was about, to see why.
    const item = cat === "failed" ? vm.preview?.item?.ref ?? null : null;
    return `<div class="ask-line is-off" data-morph-key="${key}">${cat === "failed" ? SHAPE.bad() : SHAPE.off()}<span class="ask-line-main"><span class="ask-line-t">${esc(text)}</span>${reason ? why(reason) : ""}</span>${item ? openBtn(item) : ""}</div>`;
  }
  const refused = ids.map((id) => v.ui.actions.refused[id]).find(Boolean) ?? null;
  const canUndo = !refused && vms.some((x) => x.undo && (x.state === "confirmed" || x.state === "auto"));
  const undo = canUndo ? `<button type="button" class="ask-undo" data-act="askAcUndo" data-arg="${ids.join(",")}"${busy ? " disabled" : ""}>${I_UNDO}${busy ? "Undoing…" : "Undo"}</button>` : "";
  // Undo refused (the item changed since): the reason on the line, Open in place of the time and Undo.
  const tail = refused ? (refused.ref ? openBtn(refused.ref) : "") : `<span class="ask-line-at">${esc(timeWord(vm.at))}</span>`;
  const reason = refused ? why(refused.message, SHAPE.warn()) : "";
  // Saved as an artifact (Auto saves at once): the saved line, with Open.
  if (toolOf(vm) === "save_artifact") {
    const r = rec(vm.result);
    const vis = r.visibility === "org" ? "Org" : "Private";
    return `<div class="ask-line ask-line--saved" data-morph-key="${key}">${SHAPE.done()}<span class="ask-line-main"><span class="ask-line-t">Saved as artifact: ${esc(str(r.title) ?? "Untitled")}</span><span class="ask-line-vis">· ${vis}</span>${reason}</span>
      ${tail}${vm.ref && !refused ? openBtn(vm.ref, "Open") : ""}${undo}</div>`;
  }
  const text = doneText(vms, v.look);
  const link = vm.ref ?? vm.preview?.item?.ref ?? null;
  return `<div class="ask-line" data-morph-key="${key}">${SHAPE.done()}<span class="ask-line-main">${link
    ? `<button type="button" class="ask-line-link" data-act="askShOpen" data-arg="${attr(link)}">${esc(text)}</button>`
    : `<span class="ask-line-t">${esc(text)}</span>`}${reason}</span>${tail}${undo}</div>`;
}

/** A card on someone else's shared conversation (0076_ask_sharing): only its owner decides it, so a reader gets the
 *  line it would become — what Trov proposed, and that it waits for the owner — with no field to edit, no Confirm. */
function readerLine(v: AskView, vms: AskActionVm[]): string {
  const owner = convoOf(v).thread?.owner;
  const who = owner ? personName(v.look, owner) : "its owner";
  return `<div class="ask-line is-off" data-morph-key="ln:${vms[0].id}:pending">${SHAPE.waiting()}<span class="ask-line-main"><span class="ask-line-t">${esc(`Proposed: ${lowerFirst(proposedText(vms, v.look))}`)}</span>${why(`Waiting for ${who} to confirm it.`)}</span></div>`;
}

/** One card / line for consecutive actions of one group (`shownParts`' `actions` entry). The pending ones are one
 *  card; the decided ones a line per outcome. A reader of someone else's shared conversation gets lines only. */
export function actionGroupView(v: AskView, a: AskAnswer, ids: number[]): string {
  const vms = ids.map((id) => a.turn.actions[id]).filter((x): x is AskActionVm => !!x);
  if (!vms.length) return "";
  const ro = readOnly(v);
  const pending = vms.filter((x) => x.state === "proposed" || x.state === "waiting" || x.state === "running");
  const out: string[] = [];
  if (pending.length) out.push(ro ? readerLine(v, pending) : cardView(v, pending));
  for (const cat of ["done", "undone", "cancelled", "expired", "failed"] as LineCat[]) {
    // A reader's lines never offer Undo: the server sends `undo: false` for them, and this says the same.
    const these = vms.filter((x) => catOf(x.state) === cat).map((x) => (ro ? { ...x, undo: false } : x));
    if (these.length) out.push(lineView(v, these, cat));
  }
  return `<div class="ask-acts" data-ask-tween data-morph-list>${out.join("")}</div>`;
}

// ── Save as artifact ─────────────────────────────────────────────────────────

const orgName = (v: AskView): string => v.app.me?.orgs.find((o) => o.slug === v.app.orgSlug)?.name ?? "your organization";

/** THE argument of `askAcSaveForm`: the answer's key, and a block's index when one block is saved. Every Save as
 *  artifact (this part's buttons, the conversation's footer and block toolbar) builds it here. */
export const saveFormArg = (a: Pick<AskAnswer, "key">, block?: number): string => (block === undefined ? a.key : `${a.key}|${block}`);
/** Whether an answer's Wrong? row is open (and not on its way out). */
export const wrongIsOpen = (v: Pick<AskView, "ui">, a: Pick<AskAnswer, "key">): boolean => v.ui.actions.wrongOpen[a.key] === true && !v.ui.closing[`wrong:${a.key}`];

/** The footer's / a block's "Save as artifact" (no model call: the server adds a save form under the answer). */
export function saveButton(a: AskAnswer, block?: number, cls = "ask-ghostbtn"): string {
  if (a.turn.messageId === null) return "";
  return `<button type="button" class="${attr(cls)}" data-act="askAcSaveForm" data-arg="${attr(saveFormArg(a, block))}">${I_SAVE}Save as artifact</button>`;
}

/** A `save_form` block: the form, or once saved its line. */
export function saveFormView(v: AskView, a: AskAnswer, block: Extract<AskBlock, { kind: "save_form" }>, index: number): string {
  const f = block.form;
  const fk = `${a.key}|${index}`;
  if (f.saved) {
    return `<div class="ask-acts" data-ask-tween><div class="ask-line ask-line--saved" data-morph-key="saved:${attr(fk)}">${SHAPE.done()}<span class="ask-line-main"><span class="ask-line-t">Saved as artifact: ${esc(f.saved.title)}</span> <span class="ask-line-vis">· ${f.saved.visibility === "org" ? "Org" : "Private"}</span></span>
      <button type="button" class="ask-undo" data-act="askShOpen" data-arg="${attr(`artifact:${f.saved.slug}`)}">Open${I_OPEN}</button></div></div>`;
  }
  const d = v.ui.actions.forms[fk] ?? {};
  const title = d.title ?? f.title;
  const kind = d.kind ?? f.kind;
  const vis = d.visibility ?? f.visibility;
  const busy = v.ui.actions.saving[fk] === true;
  const domKey = fk.replace(/[^A-Za-z0-9_-]/g, "_");
  // The head: the eyebrow, then Kind and Who can see it at its right — two compact switches whose own options are
  // their labels (each names itself in its tooltip). Then the title with Save at its end, the hint under it.
  return `<div class="ask-acts" data-ask-tween><div class="ask-save" data-morph-key="save:${attr(fk)}">
    <div class="ask-save-head">${askIcon("artifacts", 15, "var(--fg-55)")}<span class="ask-eyebrow">Save as artifact</span>
      <div class="ask-save-opts">
        <span data-mtip="Kind">${segmented({ id: `ask-save-k-${domKey}`, ariaLabel: "Kind", value: kind, act: "askAcSaveKind", size: "sm",
          options: [{ value: "markdown", label: "Markdown", arg: `${fk}|markdown` }, { value: "html", label: "HTML page", arg: `${fk}|html` }] })}</span>
        <span data-mtip="Who can see it">${segmented({ id: `ask-save-v-${domKey}`, ariaLabel: "Who can see it", value: vis, act: "askAcSaveVis", size: "sm",
          options: [{ value: "private", label: "Private", arg: `${fk}|private` }, { value: "org", label: "Org", arg: `${fk}|org` }] })}</span>
      </div>
    </div>
    <div class="ask-save-row">
      <input class="ask-input-line ask-input-line--lg" data-act="askAcSaveTitle" data-arg="${attr(fk)}" data-field="askAcSave${domKey}" value="${attr(title)}" maxlength="200" placeholder="Name it" aria-label="Title" />
      <button type="button" class="ask-btn ask-btn--accent" data-act="askAcSave" data-arg="${attr(fk)}"${busy || !title.trim() ? " disabled" : ""}>${busy ? "Saving…" : "Save"}</button>
    </div>
    <div class="ask-save-hint">${esc(vis === "org" ? `Everyone in ${orgName(v)} can open it from Artifacts.` : "Only you can see it. You can publish it to the org later.")}</div>
  </div></div>`;
}

// ── Wrong? ───────────────────────────────────────────────────────────────────

/** The footer's "Wrong?" (it opens the reasons row under the footer). */
export function wrongButton(v: AskView, a: AskAnswer, cls = "ask-ghostbtn"): string {
  if (a.turn.messageId === null) return "";
  const open = wrongIsOpen(v, a);
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
function setFields(ctx: AskCtx, id: number, args: Record<string, unknown>): void {
  const { hunks: _h, ...plain } = args;
  for (const where of WHERES) {
    ctx.ui[where] = withTurnOfAction(ctx.ui[where], id, (t) => ({ ...t, actions: { ...t.actions, [id]: { ...t.actions[id], fields: { ...t.actions[id].fields, ...plain } } } }));
  }
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

/** The write changed a ticket the queue shows (a created ticket, a move, an edit…). */
const touchesTicket = (vm: AskActionVm | null): boolean =>
  !!vm && ((vm.ref ?? vm.preview?.item?.ref ?? "").startsWith("ticket:") || (toolOf(vm) ?? "").includes("ticket"));
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
    ctx.flash(e.message || "This card expired with its turn.");
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
      const ans = await ctx.api.confirmAction(id, { args });
      // The card's fields become what was confirmed, so its line names the edit ("Assigned ticket #87 to Luke").
      setFields(ctx, id, args);
      applyResults(ctx, ans);
    }
    const rest = pendingOf(ctx, live);
    // The rest of the card in ONE call: the server runs every still-pending card of the group.
    if (rest.length) applyResults(ctx, await ctx.api.confirmAction(rest[0]));
    const done = live.map((id) => actionVm(ctx, id)).filter((x): x is AskActionVm => !!x && (x.state === "confirmed" || x.state === "auto"));
    const failed = live.map((id) => actionVm(ctx, id)).find((x) => x?.state === "failed");
    for (const id of live) { delete ctx.ui.actions.drafts[id]; delete ctx.ui.actions.inline[id]; }
    if (failed) ctx.flash(str(rec(failed.result).error) ?? "That change didn't work. Nothing else was changed.");
    else if (done.length) ctx.flash(doneText(done, ctx.look()));
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
    for (const id of live) { delete ctx.ui.actions.drafts[id]; delete ctx.ui.actions.inline[id]; }
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
    const ans = await ctx.api.undoAction(ids[0]);
    applyResults(ctx, ans);
    ctx.flash("Undone");
    // A created ticket's Undo DECLINES it, and declined tickets leave the queue's default views: an open board
    // refetches so the card leaves with its exit (main.ts `loadTickets`, only once the queue was loaded).
    if (ans.results.some((r) => r.state === "undone" && touchesTicket(actionVm(ctx, r.id)))) ctx.refreshTickets?.();
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
/** One edited field into the card's draft (a hunk's text into `hunks`). */
function setField(ctx: AskCtx, id: number, field: string, val: unknown): void {
  if (field.startsWith("hunk:")) setDraft(ctx, id, (d) => ({ ...d, hunks: { ...rec(d.hunks), [field.slice(5)]: val } }));
  else setDraft(ctx, id, (d) => ({ ...d, [field]: val }));
}
/** Leave the text being edited in place: keep the edit (Enter, or focus leaving it) or put back what it held
 *  (`revert`: Escape). A title or a task left empty goes back too. Focus returns to the text (they share a data-field). */
function closeInline(ctx: AskCtx, id: number, revert: boolean): void {
  const open = ctx.ui.actions.inline[id];
  if (!open) return;
  const vm = actionVm(ctx, id);
  const now = vm ? fieldOf(ctx, vm, open.field) : null;
  if (revert || (typeof now === "string" && !now.trim() && !open.field.startsWith("hunk:"))) {
    const hunk = open.field.startsWith("hunk:") ? open.field.slice(5) : null;
    if (open.had) setField(ctx, id, open.field, open.was);
    else if (hunk !== null) setDraft(ctx, id, (d) => { const { [hunk]: _x, ...hs } = rec(d.hunks); return { ...d, hunks: hs }; });
    else setDraft(ctx, id, (d) => { const { [open.field]: _x, ...rest } = d; return rest; });
  }
  const { [id]: _gone, ...rest } = ctx.ui.actions.inline;
  ctx.ui.actions.inline = rest;
  ctx.paint();
}
/** The card an inline input belongs to. */
const inlineId = (el: EventTarget | null): number | null => {
  const id = el && typeof (el as Element).getAttribute === "function" ? Number((el as Element).getAttribute("data-ask-inline")) : NaN;
  return id > 0 ? id : null;
};
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
      case "askAcText": {
        // A click on editable text: it becomes an input that looks the same (focused after the paint).
        const [id, field] = a.split("|");
        const n = Number(id);
        const vm = n > 0 && field ? actionVm(ctx, n) : null;
        if (!vm || !canEdit(vm, field) || ctx.ui.actions.busy[n]) return;
        const d = ctx.ui.actions.drafts[n] ?? {};
        const had = field.startsWith("hunk:") ? field.slice(5) in rec(d.hunks) : field in d;
        ctx.ui.actions.inline = { ...ctx.ui.actions.inline, [n]: { field, was: fieldOf(ctx, vm, field), had } };
        ctx.ui.actions.focusInline = textField(n, field);
        ctx.paint();
        return;
      }
      case "askAcField": {
        // Typed text (the input holds it: no repaint), or a cycle's next value (`<id>|<field>|<value>`).
        const [id, field, picked] = a.split("|");
        const n = Number(id);
        if (!(n > 0) || !field) return;
        setField(ctx, n, field, picked !== undefined ? picked : value ?? "");
        if (picked !== undefined) ctx.paint();
        return;
      }
      case "askAcPick": {
        // A dropdown's pick (a person): the option is `value`; "Unassigned" is NONE.
        const [id, field] = a.split("|");
        const n = Number(id);
        if (!(n > 0) || !field || !value) return;
        setField(ctx, n, field, value === NONE ? null : value);
        ctx.paint();
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
  // Text edited in place: Enter keeps it (a hunk's textarea takes Enter as a new line; ⌘/Ctrl+Enter keeps it), Escape
  // puts back what it held (an Escape layer, so nothing under it closes too), leaving it keeps it.
  onKeyDown(ctx, e) {
    const id = inlineId(e.target);
    if (id === null || e.key !== "Enter" || e.isComposing) return false;
    if ((e.target as Element).tagName === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return false;
    e.preventDefault();
    closeInline(ctx, id, false);
    return true;
  },
  onChange(ctx, e) {
    if (e.type !== "focusout") return false;
    const id = inlineId(e.target);
    if (id === null) return false;
    closeInline(ctx, id, false);
    return true;
  },
  afterPaint(ctx, mount) {
    const f = ctx.ui.actions.focusInline;
    if (!f) return;
    ctx.ui.actions.focusInline = null;
    const el = mount.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-ask-inline][data-field="${f}"]`);
    if (!el) return;
    el.focus();
    el.select();
  },
  escape: [{
    layer: "menu",
    isOpen: (ctx) => Object.keys(ctx.ui.actions.inline).length > 0,
    close: (ctx) => { for (const id of Object.keys(ctx.ui.actions.inline)) closeInline(ctx, Number(id), true); },
  }, {
    layer: "menu",
    isOpen: (ctx) => Object.keys(ctx.ui.actions.wrongOpen).some((k) => !ctx.ui.closing[`wrong:${k}`]),
    close: (ctx) => { for (const k of Object.keys(ctx.ui.actions.wrongOpen)) closeWrong(ctx, k); },
  }],
};
