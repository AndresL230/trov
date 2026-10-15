// Ask Trov — the composer (inventory §5, every `composer:*` scenario; ask-trov.dc.html L658–780, L1505–1545,
// L1774–1827). One per conversation: the Ask page's and the ⌘J panel's (`AppState.ask.composer.page | .panel`).
//
//   • the input grows as you type (46 → 220px, then it scrolls; the height glides); Enter sends, Shift+Enter is a
//     new line (never mid-IME); while Trov answers, Send is Stop and aborts the request
//   • attaching: the button, dragging (the "Drop files to attach" overlay over the conversation) and pasting —
//     each file is checked against `ask/state.attach` (count, bytes, kinds) and UPLOADED ON ATTACH
//     (`POST /ask/attachments`, which makes the thread when there is none yet); a file over the cap stays as a red
//     "Too large" chip with its note; a failed upload says "Something went wrong. Try again"
//   • chips for the files and the context refs, and the context line ("About ticket #14 · 1 file") with its clear
//   • `@` opens the picker (grouped by type; the app's quick search, rows drawn from RefViews), `/` the commands
//     (ticket, handoff, search, summarize, brief — sent as `command`); ↑↓ wrap, Enter / Tab picks, Esc closes
//   • the mode menu (only when `ask/state.modes` offers more than one: Pro), the Ask before changes / Auto switch
//     (disabled with its tip when an admin turned Auto off), the person's choice remembered per thread
//     (`PATCH /ask/threads/:id`); Auto never covers a Publish card (the server's rule; the switch says so)
//   • the usage line under 20% left, the "used up" and "off" blocks — every limit and flag from `ask/state`
//   • unsent drafts kept per thread (here, and on the thread: `PATCH … { draft }`, read back from its detail)
//   • the phone: one "+" menu (Attach, Mention, Run a command, Mode, Changes in this thread) and the meta line
//
// THE INTERFACE (the shell and the ⌘J panel call these — keep it):
//   ComposerUi / initialComposerUi()   the state, one per conversation
//   composerView(v)                    the composer for `v.where` (under the conversation)
//   composerPart                       the acts (`askCo…`), Escape layers, keydown / paste / drop hooks
//   composerFocus(mount, where)        focus the box (⌘J on the Ask screen; a new thread)
// `forced` is the dev replay's `composer:<state>` (ask-replay.ts); `composerReplaySetup` fills that state.
//
// MOTION (ask-motion.ts): the chips are a keyed list that pops new ones in (rule 2) and pops removed ones out
// through `ctx.exit` (rule 3); the picker, the mode menu and the + menu pop / rise in on insertion and out on
// `data-closing`; the drop overlay fades in and out; the input's height is a CSS transition. All off under
// reduced motion (trov.css › Ask: motion). Every conditional piece sits in a keyed list (`data-morph-list`), so
// the box — and its focus and caret — is never replaced when a note, a picker or a chip comes or goes.
//
// CSS: `/* ── Ask: composer ── */` in trov.css.

import { esc, attr } from "./ui";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { convoOf } from "./ask-state";
import { askIcon, askSpinner, trovMark, REF_ICON } from "./ask-icons";
import { segmented } from "./segmented";
import { markShape } from "./marks";
import { closingAttr } from "./ask-motion";
import { lastAnswer } from "./ask-stream";
import { AskApiError, isAbort, isUnauthorized, type AskRefHit } from "./ask-api";
import {
  refAvatar, refCtxWord, refFallbackText, refLabel, refShort, refStatusIcon, refTypeGroup, refTypeWord, viewOf, type RefLook,
} from "./ask-refs";
import {
  ASK_COMMANDS, ASK_DEFAULT_MODE, askAttachKind, parseAskRef,
  type AskAttachKind, type AskAttachment, type AskCommand, type AskMode, type AskRefType, type AskState,
} from "@shared/ai-ask-core";
import { QUICK_MIN_CHARS } from "@shared/quick-search";
import { PLANS } from "@shared/plans";

export const COMPOSER_STATES = ["quota", "off", "autoOff", "error", "tooLarge", "at", "slash", "files", "drag", "free", "low", "busy"] as const;
export type ComposerForced = (typeof COMPOSER_STATES)[number];

/** A file chip: uploading, uploaded (`att`), refused for its size, or failed (Try again re-sends it). */
export interface ComposerFile {
  /** The chip's own key (stable from attach to send). */
  key: string;
  name: string;
  size: number;
  kind: AskAttachKind | null;
  state: "uploading" | "ready" | "too_large" | "failed";
  att: AskAttachment | null;
  /** An image's local preview (an object URL) until the server's `thumbUrl`. */
  preview: string | null;
}

/** The @ picker or the / commands. `at` is where the `@` sits in the text (picking removes `@<q>`). */
export interface ComposerPicker {
  kind: "@" | "/";
  q: string;
  at: number;
  sel: number;
  hits: AskRefHit[];
  status: "loading" | "ok" | "error";
}

export interface ComposerUi {
  text: string;
  /** Context chips (`ticket:14`). */
  context: string[];
  /** Uploaded attachments, not sent yet (the `ready` files' attachments, in order). */
  attachments: AskAttachment[];
  /** The mode / switch picked here; null = the thread's, else `ask/state.defaultMode` / off. */
  mode: AskMode | null;
  auto: boolean | null;
  /** The dev replay's `composer:<state>`. */
  forced: ComposerForced | null;
  /** Every file chip, in the order attached. */
  files: ComposerFile[];
  picker: ComposerPicker | null;
  modeMenu: boolean;
  /** Files are being dragged over the conversation. */
  drag: boolean;
  /** An upload failed: "Something went wrong. Try again". */
  error: boolean;
  /** The note above the box for a file that could not be attached. */
  notice: { kind: "too_large" | "unsupported" | "too_many"; name: string } | null;
  /** The input's height (px), measured after a paint; null = not measured yet. */
  h: number | null;
  /** Where to put the caret after the next paint (a pick, a mention, a command). */
  caret: number | null;
}
export const initialComposerUi = (): ComposerUi => ({
  text: "", context: [], attachments: [], mode: null, auto: null, forced: null,
  files: [], picker: null, modeMenu: false, drag: false, error: false, notice: null, h: null, caret: null,
});

// ── what the composer reads from `ask/state` (never a constant) ──────────────

const whereOf = (arg: string | null): AskWhere => (arg === "panel" ? "panel" : "page");
/** `<where>|<rest>` (a ref has colons, so the separator is a bar). */
const splitArg = (arg: string | null): [AskWhere, string] => {
  const s = arg ?? "";
  const i = s.indexOf("|");
  return i < 0 ? [whereOf(s), ""] : [whereOf(s.slice(0, i)), s.slice(i + 1)];
};

type ComposerSee = Pick<AskView, "ui" | "where">;
const stateOf = (v: Pick<AskView, "ui">): AskState | null => v.ui.state.data;

/** The modes the person may pick (Free: one, so no switcher). */
export const composerModes = (v: Pick<AskView, "ui">): AskState["modes"] => stateOf(v)?.modes ?? [];

/** The mode this question goes in: the one picked here, else the thread's, else the person's default — always one
 *  `ask/state` offers. */
export function composerMode(v: ComposerSee): AskMode {
  const st = stateOf(v);
  const ui = v.ui.composer[v.where];
  const want = ui.mode ?? convoOf(v).thread?.mode ?? st?.defaultMode ?? ASK_DEFAULT_MODE;
  const ids = (st?.modes ?? []).map((m) => m.id);
  if (!ids.length || ids.includes(want)) return want;
  return st && ids.includes(st.defaultMode) ? st.defaultMode : ids[0];
}

/** Auto as an admin allows it: off whenever `autoAllowed` is false. */
export const autoAllowed = (v: ComposerSee): boolean => (stateOf(v)?.autoAllowed ?? false) && v.ui.composer[v.where].forced !== "autoOff";
export function composerAuto(v: ComposerSee): boolean {
  if (!autoAllowed(v)) return false;
  return v.ui.composer[v.where].auto ?? convoOf(v).thread?.auto ?? false;
}

/** The mode's hint as the menu shows it; Thinking's says what it counts as. */
export function modeHint(m: AskState["modes"][number]): string {
  if (m.countsAs <= 1 || /counts as/i.test(m.hint)) return m.hint;
  return `${m.hint} Counts as ${m.countsAs} questions.`;
}

/** "Nov 1" (the allowance resets at a month's start, UTC). */
export function resetDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "10 MB" from bytes. */
export function fmtBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

/** "Images, PDFs and text files" from `ask/state.attach.kinds`. */
export function kindsPhrase(kinds: readonly AskAttachKind[]): string {
  const words = kinds.map((k) => (k === "image" ? "images" : k === "pdf" ? "PDFs" : "text files"));
  const s = words.length <= 1 ? (words[0] ?? "files") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What stops the box: "off" (Ask is off for the org) or "quota" (this month's questions are used), else null. */
export type ComposerBlock = "off" | "quota" | null;
export function composerBlock(v: ComposerSee): ComposerBlock {
  const f = v.ui.composer[v.where].forced;
  if (f === "off" || f === "quota") return f;
  const st = stateOf(v);
  if (st && !st.enabled) return "off";
  if (st && st.allowance.cap !== null && st.allowance.used >= st.allowance.cap) return "quota";
  const code = lastAnswer(convoOf(v))?.turn.error?.code;
  return code === "off" ? "off" : code === "capped" ? "quota" : null;
}

/** "41 of 300 questions left this month · Resets Nov 1" while less than a fifth is left (`allowance.low`), else null. */
export function usageLine(st: AskState | null): string | null {
  if (!st || st.allowance.cap === null || !st.allowance.low) return null;
  const left = Math.max(0, st.allowance.cap - st.allowance.used);
  const day = resetDay(st.allowance.resetsAt);
  return `${left} of ${st.allowance.cap} questions left this month${day ? ` · Resets ${day}` : ""}`;
}

const busyOf = (v: ComposerSee): boolean => convoOf(v).busy || v.ui.composer[v.where].forced === "busy";
const uploading = (ui: ComposerUi): boolean => ui.files.some((f) => f.state === "uploading");

/** The text as it is sent: a leading `/command` becomes `command`, the rest the question. */
export function parseCommand(text: string): { command: AskCommand | undefined; text: string } {
  const m = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (m && (ASK_COMMANDS as readonly string[]).includes(m[1].toLowerCase())) return { command: m[1].toLowerCase() as AskCommand, text: (m[2] ?? "").trim() };
  return { command: undefined, text: text.trim() };
}

/** Something to send: words, a command, or an uploaded file — and nothing still uploading. */
export function canSend(v: ComposerSee): boolean {
  const ui = v.ui.composer[v.where];
  if (busyOf(v) || composerBlock(v) || uploading(ui)) return false;
  const p = parseCommand(ui.text);
  return p.text.length > 0 || p.command !== undefined || ui.attachments.length > 0;
}

// ── the picker's rows ────────────────────────────────────────────────────────

export const COMMAND_HINT: Record<AskCommand, string> = {
  ticket: "Draft a new ticket",
  handoff: "Draft a handoff for an agent session",
  search: "Search Trov for a phrase",
  summarize: "Summarize an item or this thread",
  brief: "Write a status brief for the team",
};
/** The design's group order (Tickets, Docs, Pull requests, Sprints, Handoffs, People), then the rest. */
const GROUP_ORDER: AskRefType[] = ["ticket", "doc", "pr", "sprint", "handoff", "person", "decision", "artifact", "prompt", "feed", "repo"];
const PICK_MAX = 9;

/** The @ rows in the order they show (grouped by type), at most nine. */
export function atRows(p: Pick<ComposerPicker, "hits">): AskRefHit[] {
  const seen = new Set<string>();
  const hits = p.hits.filter((h) => !seen.has(h.ref) && (seen.add(h.ref), true));
  return hits.map((h, i) => ({ h, i })).sort((a, b) => GROUP_ORDER.indexOf(a.h.type) - GROUP_ORDER.indexOf(b.h.type) || a.i - b.i)
    .slice(0, PICK_MAX).map((x) => x.h);
}
export const slashRows = (q: string): AskCommand[] => ASK_COMMANDS.filter((c) => c.startsWith(q.toLowerCase()));
const rowCount = (p: ComposerPicker): number => (p.kind === "/" ? slashRows(p.q).length : atRows(p).length);

/** Items Trov already shows (cited, in the context, the inspector's) that match a short query — the picker's
 *  first rows before the quick search has two characters to go on. */
export function knownHits(look: Pick<RefLook, "views">, q: string): AskRefHit[] {
  const n = q.toLowerCase().replace(/^#/, "");
  const out: AskRefHit[] = [];
  for (const v of Object.values(look.views)) {
    if ("hidden" in v) continue;
    const words = `${v.num ?? ""} ${v.title} ${v.type === "person" ? refShort(v) : ""}`.toLowerCase();
    if (n && !words.includes(n)) continue;
    out.push({ ref: v.ref, type: v.type, title: v.title, status: v.status?.word ?? null });
  }
  return out;
}

// ── the view ─────────────────────────────────────────────────────────────────

const fieldOf = (where: AskWhere): string => `askText-${where}`;
const X = askIcon("close", 10, null, 2.6);
const badMark = (): string => markShape("diamond", "var(--red)", 9);

function placeholderOf(v: AskView): string {
  if (v.where === "panel") {
    const ref = v.ui.cmdj.contextRef ?? v.ui.composer.panel.context[0] ?? null;
    const t = ref ? parseAskRef(ref)?.type : null;
    if (t) return `Ask about this ${t === "pr" ? "pull request" : refTypeWord({ type: t }).toLowerCase()}…`;
  }
  if (busyOf(v)) return "Trov is answering…";
  return convoOf(v).messages.length === 0 ? "Ask about tickets, docs, PRs or sprints" : "Ask a follow-up";
}

function fileChip(v: AskView, f: ComposerFile): string {
  const bad = f.state === "too_large" || f.state === "failed";
  const thumb = f.state === "ready" ? (f.att?.thumbUrl ?? f.preview) : f.state === "uploading" ? f.preview : null;
  const icon = f.state === "uploading" ? askSpinner(13)
    : askIcon(f.kind === "image" ? "image" : /\.(csv|tsv)$/i.test(f.name) ? "csv" : "file", 14, null, 1.8);
  const lead = thumb && f.kind === "image" && !bad
    ? `<img class="ask-co-thumb" src="${attr(thumb)}" alt="">`
    : `<span class="ask-co-ico" style="color:${bad ? "var(--red)" : "var(--fg-55)"}">${icon}</span>`;
  const meta = f.state === "too_large" ? "Too large" : f.state === "failed" ? "Not attached" : f.state === "uploading" ? "Uploading" : fmtBytes(f.size);
  const key = `f:${f.key}`;
  return `<span class="ask-co-chip${bad ? " is-bad" : ""}" data-morph-key="${attr(key)}"${chipClosing(v, key)}>${lead}<span class="ask-co-chip-t"><span class="ask-co-chip-n">${esc(f.name)}</span><span class="ask-co-chip-m">${esc(meta)}</span></span><button type="button" class="ask-co-x" data-act="askCoRemove" data-arg="${attr(`${v.where}|${key}`)}" aria-label="${attr(`Remove ${f.name}`)}">${X}</button></span>`;
}

function refLead(look: RefLook, ref: string, size: number, tone = "var(--fg-55)"): string {
  const view = viewOf(look, ref);
  const p = parseAskRef(ref);
  if (p?.type === "person") return refAvatar(look, view && typeof view.extra.handle === "string" ? view.extra.handle : p.key, size);
  if (view?.status) return refStatusIcon(view.status, size - 2);
  return askIcon(p ? REF_ICON[p.type] : "file", size - 2, tone, 1.8);
}

function ctxChip(v: AskView, ref: string): string {
  const view = viewOf(v.look, ref);
  const p = parseAskRef(ref);
  const name = view ? refShort(view) : refFallbackText(ref);
  const meta = view ? refTypeWord(view) : p ? refTypeWord({ type: p.type }) : "";
  const key = `c:${ref}`;
  return `<span class="ask-co-chip" data-morph-key="${attr(key)}"${chipClosing(v, key)}><span class="ask-co-ico">${refLead(v.look, ref, 16)}</span><span class="ask-co-chip-t"><span class="ask-co-chip-n">${esc(name)}</span><span class="ask-co-chip-m">${esc(meta)}</span></span><button type="button" class="ask-co-x" data-act="askCoRemove" data-arg="${attr(`${v.where}|${key}`)}" aria-label="${attr(`Remove ${name}`)}">${X}</button></span>`;
}

const chipKey = (where: AskWhere, key: string): string => `co:${where}:${key}`;
const chipClosing = (v: AskView, key: string): string =>
  closingAttr(v.ui.closing, chipKey(v.where, key)) || closingAttr(v.ui.closing, chipKey(v.where, "*"));

/** "About ticket #14 · 1 file" (the ⌘J panel names its one item: "About ticket #14: Guided repository setup"). */
export function contextLine(v: Pick<AskView, "ui" | "where" | "look">): string {
  const ui = v.ui.composer[v.where];
  const parts: string[] = [];
  if (ui.context.length) {
    const first = ui.context[0];
    const view = viewOf(v.look, first);
    let s = `About ${view ? refCtxWord(view) : refFallbackText(first)}`;
    if (v.where === "panel" && ui.context.length === 1 && view) s += `: ${view.title}`;
    if (ui.context.length > 1) s += ` and ${ui.context.length - 1} more`;
    parts.push(s);
  }
  const n = ui.files.length;
  if (n) parts.push(`${n} ${n === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

function pickerView(v: AskView, p: ComposerPicker): string {
  const key = `pick:${p.kind}`;
  const closing = closingAttr(v.ui.closing, chipKey(v.where, "pick"));
  const id = (i: number) => `ask-co-opt-${v.where}-${i}`;
  let body = "";
  if (p.kind === "/") {
    const rows = slashRows(p.q);
    body = rows.length
      ? `<div class="ask-co-pick-h">Commands</div>${rows.map((c, i) => `<button type="button" role="option" id="${id(i)}" aria-selected="${i === p.sel}" class="ask-co-row ask-co-row--cmd${i === p.sel ? " is-on" : ""}" data-act="askCoPick" data-arg="${v.where}|${i}"><span class="ask-co-cmd">/${esc(c)}</span><span class="ask-co-row-c">${esc(COMMAND_HINT[c])}</span></button>`).join("")}`
      : "";
  } else {
    const rows = atRows(p);
    let last: AskRefType | null = null;
    body = rows.map((h, i) => {
      const view = viewOf(v.look, h.ref);
      const head = h.type !== last ? `<div class="ask-co-pick-h">${esc(refTypeGroup(h.type))}</div>` : "";
      last = h.type;
      const person = h.type === "person";
      const title = view ? (person ? view.title : refLabel(view)) : (h.type === "ticket" || h.type === "handoff") && /^\d+$/.test(parseAskRef(h.ref)?.key ?? "") ? `#${parseAskRef(h.ref)!.key} ${h.title}` : h.title;
      const ctxWord = person ? (view ? refShort(view) : `@${parseAskRef(h.ref)?.key ?? ""}`) : (view?.status?.word ?? h.status ?? "");
      return `${head}<button type="button" role="option" id="${id(i)}" aria-selected="${i === p.sel}" class="ask-co-row${i === p.sel ? " is-on" : ""}" data-act="askCoPick" data-arg="${v.where}|${i}"><span class="ask-co-row-l">${refLead(v.look, h.ref, 16, "var(--fg-40)")}</span><span class="ask-co-row-t">${esc(title)}</span><span class="ask-co-row-c">${esc(ctxWord)}</span></button>`;
    }).join("");
    if (!rows.length && p.status === "loading") body = `<div class="ask-co-pick-empty">Searching…</div>`;
  }
  if (!body) body = `<div class="ask-co-pick-empty">Nothing matches “${esc(p.q)}”.</div>`;
  return `<div class="ask-co-pick" role="listbox" id="ask-co-pick-${v.where}" aria-label="${p.kind === "/" ? "Commands" : "Mention an item"}" data-morph-key="${key}" data-co-menu${closing}>
    <div class="ask-co-pick-list">${body}</div>
    <div class="ask-co-pick-foot" aria-hidden="true"><span>↑↓ to move</span><span>Enter to pick</span><span>Esc to close</span></div>
  </div>`;
}

function modeControl(v: AskView): string {
  const modes = composerModes(v);
  if (modes.length <= 1) return "";
  const ui = v.ui.composer[v.where];
  const cur = composerMode(v);
  const word = modes.find((m) => m.id === cur)?.label ?? cur;
  const menu = ui.modeMenu
    ? `<div class="ask-co-menu" role="menu" aria-label="Mode" data-morph-key="mm" data-co-menu${closingAttr(v.ui.closing, chipKey(v.where, "mode"))}>${modes.map((m) => `<button type="button" role="menuitemradio" aria-checked="${m.id === cur}" class="ask-co-mi" data-act="askCoMode" data-arg="${v.where}|${m.id}"><span class="ask-co-mi-t"><span class="ask-co-mi-l">${esc(m.label)}</span><span class="ask-co-mi-h">${esc(modeHint(m))}</span></span>${m.id === cur ? askIcon("check", 14, "var(--accent)", 2.4) : ""}</button>`).join("")}</div>`
    : "";
  return `<div class="ask-co-modewrap" data-morph-key="mode" data-morph-list><button type="button" class="ask-co-modebtn" data-morph-key="mb" data-act="askCoModeMenu" data-arg="${v.where}" data-co-modebtn aria-haspopup="menu" aria-expanded="${ui.modeMenu}" aria-label="${attr(`Mode: ${word}`)}">${esc(word)}${askIcon("chevron", 10, null, 2.6)}</button>${menu}</div>`;
}

const AUTO_OFF_TIP = "An admin turned off Auto for this org. Trov asks before every change.";
const AUTO_TIP = "Trov makes changes without asking first. Publishing a doc always waits for you.";

function autoSwitch(v: AskView, phone: boolean): string {
  const allowed = autoAllowed(v);
  const on = composerAuto(v);
  const seg = segmented({
    id: `ask-auto-${v.where}${phone ? "-p" : ""}`, ariaLabel: "Changes in this thread", value: on ? "on" : "off", act: "askCoAuto",
    size: phone ? "md" : "xs", fill: phone, inertOn: true, className: phone ? "cnpy-seg--bar" : "ask-co-auto-seg",
    options: [
      { value: "off", arg: `${v.where}|off`, label: v.where === "panel" && !phone ? "Ask first" : "Ask before changes", locked: !allowed },
      { value: "on", arg: `${v.where}|on`, label: "Auto", locked: !allowed, title: allowed ? AUTO_TIP : undefined },
    ],
  });
  return `<div class="ask-co-auto${allowed ? "" : " is-off"}" data-morph-key="auto"${allowed ? "" : ` aria-disabled="true" data-mtip="${attr(AUTO_OFF_TIP)}"`}>${seg}</div>`;
}

function sendButton(v: AskView, big: boolean): string {
  const busy = busyOf(v);
  const can = canSend(v);
  const label = busy ? "Stop answering" : "Send";
  return `<button type="button" class="ask-send${big ? " ask-send--40" : ""}${busy ? " is-busy" : can ? " is-on" : ""}" data-morph-key="send" data-act="${busy ? "askCoStop" : "askCoSend"}" data-arg="${v.where}" aria-label="${label}" data-mtip="${label}"${!busy && !can ? ` aria-disabled="true"` : ""}>${busy
    ? `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"></rect></svg>`
    : askIcon("send", big ? 18 : 16, null, 2.2)}</button>`;
}

/** The phone's meta line beside +: "Smart · Asks first" (Free: "Asks first"). */
export function phoneMeta(v: ComposerSee): string {
  const modes = composerModes(v);
  const cur = composerMode(v);
  const change = composerAuto(v) ? "Auto" : "Asks first";
  return modes.length > 1 ? `${modes.find((m) => m.id === cur)?.label ?? cur} · ${change}` : change;
}

/** The phone's + menu (ask-trov.dc.html L679–691): Attach, Mention, Run a command; Mode (Pro); Changes. The phone
 *  part owns whether it is open (`ui.phone.plus`, its Escape layer); these are the composer's own controls. */
export function composerPlusMenu(v: AskView): string {
  const modes = composerModes(v);
  const cur = composerMode(v);
  const row = (act: string, icon: "attach" | "at" | "cmd", label: string) =>
    `<button type="button" role="menuitem" class="ask-co-plus-row" data-act="${act}" data-arg="${v.where}">${askIcon(icon, 17, "var(--fg-55)", 1.8)}${esc(label)}</button>`;
  const mode = modes.length > 1
    ? `<div class="ask-co-plus-sec"><div class="ask-co-plus-l">Mode</div>${segmented({ id: `ask-pmode-${v.where}`, ariaLabel: "Mode", value: cur, act: "askCoMode", size: "md", fill: true, inertOn: true, className: "cnpy-seg--bar",
      options: modes.map((m) => ({ value: m.id, arg: `${v.where}|${m.id}`, label: m.label })) })}<div class="ask-co-plus-h">${esc(modeHint(modes.find((m) => m.id === cur) ?? modes[0]))}</div></div>`
    : "";
  return `<div class="ask-co-plus" role="menu" aria-label="More options" data-morph-key="plus" data-co-menu${closingAttr(v.ui.closing, "plus")}>
    ${row("askCoAttach", "attach", "Attach a file or photo")}${row("askCoAt", "at", "Mention a ticket, doc or person")}${row("askCoSlash", "cmd", "Run a command")}
    <div class="ask-co-plus-sep" aria-hidden="true"></div>
    ${mode}<div class="ask-co-plus-sec"><div class="ask-co-plus-l">Changes in this thread</div>${autoSwitch(v, true)}</div>
  </div>`;
}

function boxView(v: AskView): string {
  const ui = v.ui.composer[v.where];
  const phone = v.app.phone;
  const p = ui.picker;
  const chips = [...ui.files.map((f) => fileChip(v, f)), ...ui.context.map((r) => ctxChip(v, r))].join("");
  const style = ui.h !== null ? ` style="height:${ui.h}px"` : "";
  const ta = `<textarea rows="1" class="ask-input" data-morph-key="ta" data-act="askCoText" data-arg="${v.where}" data-field="${fieldOf(v.where)}" data-ask-input="${v.where}" placeholder="${attr(placeholderOf(v))}" aria-label="Message Ask Trov"${p ? ` aria-controls="ask-co-pick-${v.where}" aria-expanded="true"` : ""}${style}>${esc(ui.text)}</textarea>`;
  const bar = phone
    ? `<div class="ask-box-bar ask-box-bar--phone" data-morph-key="bar" data-morph-list>
        <button type="button" class="ask-co-plusbtn" data-morph-key="plusb" data-act="askPhPlus" aria-label="More options" aria-expanded="${v.ui.phone.plus}">${askIcon("plus", 18, null, 2)}</button>
        <span class="ask-co-meta" data-morph-key="meta">${esc(phoneMeta(v))}</span><span class="ask-co-grow" data-morph-key="sp"></span>${sendButton(v, true)}
      </div>`
    : `<div class="ask-box-bar" data-morph-key="bar" data-morph-list>
        <button type="button" class="ask-co-tool" data-morph-key="att" data-act="askCoAttach" data-arg="${v.where}" aria-label="Attach files" data-mtip="Attach files, or drop and paste them">${askIcon("attach", 16, null, 1.8)}</button>
        <button type="button" class="ask-co-tool" data-morph-key="at" data-act="askCoAt" data-arg="${v.where}" aria-label="Mention an item" data-mtip="Mention a ticket, doc, PR or person">${askIcon("at", 16, null, 1.8)}</button>
        <button type="button" class="ask-co-tool" data-morph-key="sl" data-act="askCoSlash" data-arg="${v.where}" aria-label="Commands" data-mtip="Commands">${askIcon("cmd", 15, null, 2)}</button>
        <span class="ask-co-grow" data-morph-key="sp"></span>${modeControl(v)}${autoSwitch(v, false)}${sendButton(v, false)}
      </div>`;
  return `<div class="ask-box" data-morph-key="box" data-morph-list><div class="ask-co-chips" data-morph-key="chips" data-morph-list data-ask-enter="pop">${chips}</div>${ta}${bar}</div>`;
}

function blockView(v: AskView, b: Exclude<ComposerBlock, null>): string {
  if (b === "off") {
    return `<div class="ask-blocked" data-morph-key="off" role="status"><span class="ask-blocked-m">${markShape("square", "var(--fg-40)", 9)}</span><div><div class="ask-blocked-h">Ask Trov is off for this org.</div><div class="ask-blocked-s">An admin can turn it on in Org settings › AI.</div></div></div>`;
  }
  const st = stateOf(v);
  const day = st ? resetDay(st.allowance.resetsAt) : "";
  const free = !st || st.plan === "free" || st.plan === "personal";
  const pro = PLANS.team.entitlements.ai_chat;
  const sub = `${day ? `Resets ${day}.` : ""}${free && pro ? ` Pro includes ${pro} a month, plus Thinking mode.` : ""}`.trim();
  return `<div class="ask-blocked ask-blocked--quota" data-morph-key="quota" role="status"><div class="ask-blocked-b"><div class="ask-blocked-h">You've used this month's questions.</div>${sub ? `<div class="ask-blocked-s">${esc(sub)}</div>` : ""}</div>${free ? `<button type="button" class="ask-co-upgrade" data-act="orgGo" data-arg="general">Upgrade to Pro</button>` : ""}</div>`;
}

/** The composer for `v.where`. */
export function composerView(v: AskView): string {
  const ui = v.ui.composer[v.where];
  const st = stateOf(v);
  const phone = v.app.phone;
  const block = composerBlock(v);
  const empty = convoOf(v).messages.length === 0;
  const maxMb = st ? fmtBytes(st.attach.maxBytes) : "";
  const inner: string[] = [];
  if (ui.picker && !block) inner.push(pickerView(v, ui.picker));
  if (phone && v.ui.phone.plus && !block) inner.push(composerPlusMenu(v));
  const line = block ? "" : contextLine(v);
  if (line) inner.push(`<div class="ask-co-ctx" data-morph-key="ctx">${trovMark(11)}<span class="ask-co-ctx-t">${esc(line)}</span><button type="button" class="ask-co-x ask-co-x--sm" data-act="askCoClear" data-arg="${v.where}" aria-label="Remove all context">${X}</button></div>`);
  if (!block && (ui.error || ui.forced === "error")) {
    inner.push(`<div class="ask-co-note" data-morph-key="err" role="alert">${badMark()}<span>Something went wrong. <button type="button" class="ask-co-link" data-act="askCoRetry" data-arg="${v.where}">Try again</button></span></div>`);
  }
  const big = ui.files.find((f) => f.state === "too_large");
  const note = ui.notice ?? (big ? { kind: "too_large" as const, name: big.name } : null);
  if (!block && note) {
    const what = note.kind === "too_large" ? ` is too large. Files can be up to ${esc(maxMb)}.`
      : note.kind === "unsupported" ? ` can't be attached. ${esc(st ? kindsPhrase(st.attach.kinds) : "Images, PDFs and text files")} only.`
      : ` was not attached. A message can carry up to ${st?.attach.maxFiles ?? ""} files.`;
    inner.push(`<div class="ask-co-note" data-morph-key="note:${note.kind}" role="status">${badMark()}<span><b>${esc(note.name)}</b>${what}</span></div>`);
  }
  inner.push(block ? blockView(v, block) : boxView(v));
  const usage = block ? null : usageLine(st);
  const foot = (!phone ? `<span>Enter to send · Shift+Enter for a new line</span>` : "") + (usage ? `<span class="ask-co-usage">${esc(usage)}</span>` : "");
  inner.push(`<div class="ask-co-foot" data-morph-key="foot">${foot}</div>`);
  if (empty && v.where === "page") inner.push(`<p class="ask-disclaimer" data-morph-key="disc">Answers come from what you can see in Trov, with sources. Trov asks before it changes anything.</p>`);
  const accept = st ? acceptOf(st) : "";
  const drop = ui.drag && !block
    ? `<div class="ask-co-drop" data-morph-key="drop" aria-hidden="true"${closingAttr(v.ui.closing, chipKey(v.where, "drop"))}><div class="ask-co-drop-in">${askIcon("upload", 26, "var(--accent)", 1.7)}<span class="ask-co-drop-t">Drop files to attach</span><span class="ask-co-drop-s">${esc(st ? `${kindsPhrase(st.attach.kinds)}, up to ${maxMb} each` : "")}</span></div></div>`
    : "";
  return `<div class="ask-composer" data-ask-composer="${v.where}" data-morph-list>
    <div class="ask-co-in" data-morph-key="in" data-morph-list>${inner.join("")}</div>
    <input type="file" multiple class="ask-co-file" data-morph-key="file" data-co-file="${v.where}"${accept ? ` accept="${attr(accept)}"` : ""} aria-hidden="true" tabindex="-1">${drop}
  </div>`;
}

/** The file picker's filter, from `ask/state.attach.kinds`. */
function acceptOf(st: AskState): string {
  const out: string[] = [];
  if (st.attach.kinds.includes("image")) out.push("image/*");
  if (st.attach.kinds.includes("pdf")) out.push(".pdf", "application/pdf");
  if (st.attach.kinds.includes("text")) out.push("text/*", ".md", ".csv", ".json", ".ts", ".js", ".py", ".go", ".rs", ".sql", ".yaml", ".yml", ".log");
  return out.join(",");
}

/** Focus the box (and put the caret at the end). */
export function composerFocus(mount: ParentNode, where: AskWhere): void {
  const el = mount.querySelector<HTMLTextAreaElement>(`[data-ask-input="${where}"]`);
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

// ── runtime (timers, the thread a draft belongs to, the files kept for Try again) ──

interface ComposerRt {
  /** The conversation each composer's text belongs to (a thread switch swaps the draft). */
  bound: Partial<Record<AskWhere, { uid: string; threadId: number | null; loaded: boolean }>>;
  /** Unsent words, by thread (`page:12`). */
  drafts: Map<string, string>;
  draftTimer: Partial<Record<AskWhere, ReturnType<typeof setTimeout>>>;
  /** Threads holding a draft on the server (cleared there on send). */
  serverDrafts: Set<number>;
  search: Partial<Record<AskWhere, { timer: ReturnType<typeof setTimeout> | null; ac: AbortController | null }>>;
  /** After the next paint: focus the input, or the open menu's first item. */
  focus: Partial<Record<AskWhere, "input" | "menu">>;
  /** A failed upload's file, for Try again. */
  failed: Map<string, File>;
}
const RT = new WeakMap<object, ComposerRt>();
function rt(ctx: AskCtx): ComposerRt {
  let r = RT.get(ctx.ui);
  if (!r) { r = { bound: {}, drafts: new Map(), draftTimer: {}, serverDrafts: new Set(), search: {}, focus: {}, failed: new Map() }; RT.set(ctx.ui, r); }
  return r;
}
const draftKey = (where: AskWhere, id: number | null): string | null => (id === null ? null : `${where}:${id}`);
const serverDraftOf = (thread: unknown): string => {
  const d = (thread as { draft?: unknown } | null)?.draft;
  return typeof d === "string" ? d : "";
};

/** Keep the words per thread: here at once, on the thread after a pause. */
function saveDraft(ctx: AskCtx, where: AskWhere): void {
  const r = rt(ctx);
  const id = ctx.ui[where].threadId;
  const k = draftKey(where, id);
  if (!k || id === null) return;
  const text = ctx.ui.composer[where].text;
  r.drafts.set(k, text);
  const t = r.draftTimer[where];
  if (t) clearTimeout(t);
  r.draftTimer[where] = setTimeout(() => {
    delete r.draftTimer[where];
    if (!text && !r.serverDrafts.has(id)) return;
    if (text) r.serverDrafts.add(id); else r.serverDrafts.delete(id);
    ctx.api.patchThread(id, { draft: text }).catch(() => undefined);
  }, 700);
}
function clearDraft(ctx: AskCtx, where: AskWhere, id: number | null): void {
  const r = rt(ctx);
  const k = draftKey(where, id);
  if (k) r.drafts.delete(k);
  const t = r.draftTimer[where];
  if (t) { clearTimeout(t); delete r.draftTimer[where]; }
  if (id !== null && (r.serverDrafts.has(id) || serverDraftOf(ctx.ui[where].thread))) {
    r.serverDrafts.delete(id);
    ctx.api.patchThread(id, { draft: "" }).catch(() => undefined);
  }
}

/** A thread switch: the old words are already kept; the new thread's come back (here, else its stored draft), and its
 *  own mode and switch apply. A new thread being named (null → its id) keeps what is being typed. */
function syncThread(ctx: AskCtx, where: AskWhere): boolean {
  const r = rt(ctx);
  const c = ctx.ui[where];
  const ui = ctx.ui.composer[where];
  const b = r.bound[where];
  if (!b) { r.bound[where] = { uid: c.uid, threadId: c.threadId, loaded: c.status !== "loading" }; return false; }
  let changed = false;
  if (b.uid !== c.uid) {
    r.bound[where] = { uid: c.uid, threadId: c.threadId, loaded: c.status !== "loading" };
    const k = draftKey(where, c.threadId);
    const text = (k && r.drafts.get(k)) || serverDraftOf(c.thread);
    if (c.threadId !== null || ui.text) {
      ctx.ui.composer[where] = { ...ui, text, mode: null, auto: null, picker: null, modeMenu: false, caret: text.length };
      changed = true;
    }
  } else if (b.threadId !== c.threadId) {
    const from = draftKey(where, b.threadId);
    const to = draftKey(where, c.threadId);
    if (from && to && r.drafts.has(from)) { r.drafts.set(to, r.drafts.get(from)!); r.drafts.delete(from); }
    b.threadId = c.threadId;
  }
  const nb = r.bound[where]!;
  if (!nb.loaded && c.status !== "loading") {
    nb.loaded = true;
    const k = draftKey(where, c.threadId);
    const text = (k && r.drafts.get(k)) || serverDraftOf(c.thread);
    if (text && !ctx.ui.composer[where].text) { ctx.ui.composer[where] = { ...ctx.ui.composer[where], text, caret: text.length }; changed = true; }
  }
  return changed;
}

// ── acts ─────────────────────────────────────────────────────────────────────

function closePicker(ctx: AskCtx, where: AskWhere, animate = true): void {
  const r = rt(ctx).search[where];
  if (r?.timer) clearTimeout(r.timer);
  r?.ac?.abort();
  if (!ctx.ui.composer[where].picker) return;
  const apply = () => { ctx.ui.composer[where] = { ...ctx.ui.composer[where], picker: null }; };
  if (animate) ctx.exit(chipKey(where, "pick"), apply);
  else { ctx.cancelExit(chipKey(where, "pick")); apply(); ctx.paint(); }
}

function closeModeMenu(ctx: AskCtx, where: AskWhere): void {
  if (!ctx.ui.composer[where].modeMenu) return;
  ctx.exit(chipKey(where, "mode"), () => { ctx.ui.composer[where] = { ...ctx.ui.composer[where], modeMenu: false }; });
}

/** Run the @ search for the picker's query: known items at once, the quick search from two characters. */
function searchFor(ctx: AskCtx, where: AskWhere): void {
  const p = ctx.ui.composer[where].picker;
  if (!p || p.kind !== "@") return;
  const r = rt(ctx);
  const s = (r.search[where] ??= { timer: null, ac: null });
  if (s.timer) clearTimeout(s.timer);
  s.ac?.abort();
  const q = p.q;
  const known = knownHits(ctx.look(), q);
  if (q.replace(/^#/, "").length < QUICK_MIN_CHARS) {
    ctx.ui.composer[where].picker = { ...p, hits: known, status: "ok" };
    return;
  }
  ctx.ui.composer[where].picker = { ...p, hits: p.hits.length ? p.hits : known, status: "loading" };
  s.timer = setTimeout(() => {
    s.timer = null;
    const ac = new AbortController();
    s.ac = ac;
    ctx.api.searchRefs(q, ac.signal).then((hits) => {
      const cur = ctx.ui.composer[where].picker;
      if (!cur || cur.kind !== "@" || cur.q !== q) return;
      ctx.ui.composer[where].picker = { ...cur, hits, status: "ok", sel: Math.min(cur.sel, Math.max(0, Math.min(hits.length, PICK_MAX) - 1)) };
      ctx.want(hits.map((h) => h.ref).slice(0, PICK_MAX * 2));
      ctx.paint();
    }).catch((e) => {
      if (isAbort(e) || ac.signal.aborted) return;
      if (isUnauthorized(e)) { ctx.fail(e, ""); return; }
      const cur = ctx.ui.composer[where].picker;
      if (cur && cur.q === q) { ctx.ui.composer[where].picker = { ...cur, hits: knownHits(ctx.look(), q), status: "error" }; ctx.paint(); }
    });
  }, 120);
}

function openPicker(ctx: AskCtx, where: AskWhere, kind: "@" | "/", q: string, at: number): void {
  const ui = ctx.ui.composer[where];
  const prev = ui.picker;
  ctx.cancelExit(chipKey(where, "pick"));
  const same = prev && prev.kind === kind;
  ctx.ui.composer[where] = { ...ui, modeMenu: false, picker: { kind, q, at, sel: same && prev.q === q ? prev.sel : 0, hits: same ? prev.hits : [], status: "ok" } };
  if (kind === "@") searchFor(ctx, where);
}

/** Where the caret is in the live box (the input event's), else the end of the text. */
function caretOf(where: AskWhere, text: string): number {
  if (typeof document === "undefined") return text.length;
  const el = document.querySelector<HTMLTextAreaElement>(`[data-ask-input="${where}"]`);
  return el && el.value === text && typeof el.selectionStart === "number" ? el.selectionStart : text.length;
}

/** The typed text: keep it (and the draft), and open / move / close the picker by what sits before the caret. */
export function typeText(ctx: AskCtx, where: AskWhere, text: string, caret = text.length): void {
  ctx.ui.composer[where] = { ...ctx.ui.composer[where], text };
  const before = text.slice(0, caret);
  const at = before.match(/(^|\s)@([\w#.-]*)$/);
  const slash = text.match(/^\/(\w*)$/);
  if (at) openPicker(ctx, where, "@", at[2], caret - at[2].length - 1);
  else if (slash) openPicker(ctx, where, "/", slash[1], 0);
  else if (ctx.ui.composer[where].picker) closePicker(ctx, where);
  saveDraft(ctx, where);
  ctx.paint();
}

/** Pick the picker's row `i`: a command fills `/cmd `; an item becomes a context chip and its `@query` goes. */
export function pick(ctx: AskCtx, where: AskWhere, i: number): void {
  const ui = ctx.ui.composer[where];
  const p = ui.picker;
  if (!p) return;
  if (p.kind === "/") {
    const c = slashRows(p.q)[i];
    if (!c) return;
    const text = `/${c} `;
    ctx.ui.composer[where] = { ...ui, text, caret: text.length };
  } else {
    const h = atRows(p)[i];
    if (!h) return;
    const text = ui.text.slice(0, p.at) + ui.text.slice(p.at + 1 + p.q.length);
    ctx.ui.composer[where] = { ...ui, text, caret: p.at, context: ui.context.includes(h.ref) ? ui.context : [...ui.context, h.ref] };
    ctx.want([h.ref]);
  }
  closePicker(ctx, where, false);
  rt(ctx).focus[where] = "input";
  saveDraft(ctx, where);
  ctx.paint();
}

/** Send what is in the box (Enter, Send). */
export function sendFrom(ctx: AskCtx, where: AskWhere): void {
  const v: ComposerSee = { ui: ctx.ui, where };
  if (!canSend(v)) return;
  const ui = ctx.ui.composer[where];
  const { command, text } = parseCommand(ui.text);
  const files = ui.attachments;
  const threadId = ctx.ui[where].threadId;
  ctx.send({ text, where, command, context: ui.context, attachments: files.map((a) => a.id), files, mode: composerMode(v), auto: composerAuto(v) });
  for (const f of ui.files) if (f.preview && f.state !== "ready") revoke(f.preview);
  // The ⌘J panel keeps its page's item as the context; the Ask page starts the next question clean.
  ctx.ui.composer[where] = {
    ...ui, text: "", attachments: [], files: [], context: where === "panel" ? ui.context : [],
    picker: null, modeMenu: false, error: false, notice: null, caret: 0, forced: ui.forced === "error" || ui.forced === "tooLarge" ? null : ui.forced,
  };
  clearDraft(ctx, where, threadId);
  ctx.paint();
}

const revoke = (url: string): void => { try { if (url.startsWith("blob:")) URL.revokeObjectURL(url); } catch { /* not a blob */ } };
let fileSeq = 0;

/** Attach files (the button, a drop, a paste): checked against `ask/state.attach`, then uploaded at once. */
export function addFiles(ctx: AskCtx, where: AskWhere, list: readonly File[]): void {
  const st = ctx.ui.state.data;
  if (!st || !list.length || composerBlock({ ui: ctx.ui, where })) return;
  const ui = ctx.ui.composer[where];
  let room = st.attach.maxFiles - ui.files.filter((f) => f.state !== "too_large").length;
  let notice: ComposerUi["notice"] = null;
  const added: ComposerFile[] = [];
  const send: { f: ComposerFile; file: File }[] = [];
  for (const file of list) {
    const name = file.name || "pasted-image.png";
    const kind = askAttachKind(name, file.type || "");
    const key = `u${++fileSeq}`;
    if (file.size > st.attach.maxBytes) {
      added.push({ key, name, size: file.size, kind, state: "too_large", att: null, preview: null });
      notice = { kind: "too_large", name };
      continue;
    }
    if (!kind || !st.attach.kinds.includes(kind)) { notice ??= { kind: "unsupported", name }; continue; }
    if (room <= 0) { notice ??= { kind: "too_many", name }; continue; }
    room--;
    let preview: string | null = null;
    if (kind === "image") { try { preview = URL.createObjectURL(file); } catch { preview = null; } }
    const f: ComposerFile = { key, name, size: file.size, kind, state: "uploading", att: null, preview };
    added.push(f);
    send.push({ f, file });
  }
  ctx.ui.composer[where] = { ...ui, files: [...ui.files, ...added], notice, error: false, drag: false };
  rt(ctx).focus[where] = "input";
  ctx.paint();
  if (send.length) void upload(ctx, where, send);
}

async function upload(ctx: AskCtx, where: AskWhere, items: { f: ComposerFile; file: File }[]): Promise<void> {
  const convo = ctx.ui[where];
  const uid = convo.uid;
  const keys = new Set(items.map((x) => x.f.key));
  const patch = (fn: (f: ComposerFile, i: number) => ComposerFile): void => {
    const ui = ctx.ui.composer[where];
    const files = ui.files.map((f) => (keys.has(f.key) ? fn(f, items.findIndex((x) => x.f.key === f.key)) : f));
    ctx.ui.composer[where] = { ...ui, files, attachments: files.flatMap((f) => (f.state === "ready" && f.att ? [f.att] : [])) };
  };
  try {
    const r = await ctx.api.uploadAttachments(items.map((x) => x.file), convo.threadId);
    if (ctx.ui[where].uid !== uid) return;                     // another thread now: these stay on the old one
    patch((f, i) => (r.attachments[i] ? { ...f, state: "ready", att: r.attachments[i] } : { ...f, state: "failed" }));
    for (const x of items) rt(ctx).failed.delete(x.f.key);
    // The upload made the thread (a new conversation's first attach): the question goes to it.
    if (ctx.ui[where].threadId === null) ctx.ui[where] = { ...ctx.ui[where], threadId: r.threadId };
  } catch (e) {
    if (ctx.ui[where].uid !== uid) return;
    if (isUnauthorized(e)) { ctx.fail(e, ""); return; }
    const code = e instanceof AskApiError ? e.code : "failed";
    const named = (n: string) => e instanceof AskApiError && e.message.includes(n);
    if (code === "too_large") {
      patch((f) => (named(f.name) ? { ...f, state: "too_large" } : { ...f, state: "failed" }));
      ctx.ui.composer[where].notice = { kind: "too_large", name: items.find((x) => named(x.f.name))?.f.name ?? items[0].f.name };
    } else if (code === "unsupported") {
      const gone = new Set(items.map((x) => x.f.key));
      const ui = ctx.ui.composer[where];
      ctx.ui.composer[where] = { ...ui, files: ui.files.filter((f) => !gone.has(f.key)), notice: { kind: "unsupported", name: items.find((x) => named(x.f.name))?.f.name ?? items[0].f.name } };
    } else {
      patch((f) => ({ ...f, state: "failed" }));
      for (const x of items) rt(ctx).failed.set(x.f.key, x.file);
      ctx.ui.composer[where].error = true;
    }
  }
  ctx.paint();
}

function removeChip(ctx: AskCtx, where: AskWhere, key: string): void {
  const apply = () => {
    const ui = ctx.ui.composer[where];
    if (key.startsWith("c:")) { ctx.ui.composer[where] = { ...ui, context: ui.context.filter((r) => r !== key.slice(2)) }; return; }
    const id = key.slice(2);
    const gone = ui.files.find((f) => f.key === id);
    if (gone?.preview) revoke(gone.preview);
    rt(ctx).failed.delete(id);
    const files = ui.files.filter((f) => f.key !== id);
    ctx.ui.composer[where] = {
      ...ui, files, attachments: files.flatMap((f) => (f.state === "ready" && f.att ? [f.att] : [])),
      notice: ui.notice && gone && ui.notice.name === gone.name ? null : ui.notice,
      error: files.some((f) => f.state === "failed") && ui.error,
      forced: ui.forced === "tooLarge" && gone?.state === "too_large" ? null : ui.forced,
    };
  };
  ctx.exit(chipKey(where, key), apply);
}

function retry(ctx: AskCtx, where: AskWhere): void {
  const ui = ctx.ui.composer[where];
  const r = rt(ctx);
  const items = ui.files.flatMap((f) => { const file = f.state === "failed" ? r.failed.get(f.key) : undefined; return file ? [{ f, file }] : []; });
  ctx.ui.composer[where] = {
    ...ui, error: false, forced: ui.forced === "error" ? null : ui.forced,
    files: ui.files.map((f) => (items.some((x) => x.f.key === f.key) ? { ...f, state: "uploading" as const } : f)),
  };
  ctx.paint();
  if (items.length) void upload(ctx, where, items);
}

function setMode(ctx: AskCtx, where: AskWhere, id: string): void {
  const modes = ctx.ui.state.data?.modes ?? [];
  const m = modes.find((x) => x.id === id);
  if (!m) return;
  ctx.ui.composer[where] = { ...ctx.ui.composer[where], mode: m.id };
  closeModeMenu(ctx, where);
  rt(ctx).focus[where] = "input";
  const tid = ctx.ui[where].threadId;
  if (tid !== null) ctx.api.patchThread(tid, { mode: m.id }).catch(() => undefined);
  ctx.paint();
}

function setAuto(ctx: AskCtx, where: AskWhere, on: boolean): void {
  if (!autoAllowed({ ui: ctx.ui, where })) return;
  ctx.ui.composer[where] = { ...ctx.ui.composer[where], auto: on };
  const tid = ctx.ui[where].threadId;
  if (tid !== null) ctx.api.patchThread(tid, { auto: on }).catch(() => undefined);
  ctx.paint();
}

function fileInput(where: AskWhere): HTMLInputElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLInputElement>(`[data-co-file="${where}"]`);
}

function closePlus(ctx: AskCtx): void { if (ctx.ui.phone.plus) ctx.ui.phone.plus = false; }

/** The drop zone an event is over: the Ask page's conversation, or the ⌘J panel. */
function dropZone(e: Event): { el: Element; where: AskWhere } | null {
  const t = e.target as Element | null;
  const el = t?.closest?.("[data-ask-drop], .ask-panel") ?? null;
  if (!el) return null;
  return { el, where: el.getAttribute("data-ask-drop") === "page" ? "page" : "panel" };
}
const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files");

function endDrag(ctx: AskCtx, where: AskWhere): void {
  if (!ctx.ui.composer[where].drag) return;
  ctx.exit(chipKey(where, "drop"), () => { ctx.ui.composer[where] = { ...ctx.ui.composer[where], drag: false }; }, 140);
}

// ── after a paint: the thread's draft, the box's words and caret, its height, focus; listeners once ──

const wired = new WeakSet<HTMLElement>();
function wire(ctx: AskCtx, mount: HTMLElement): void {
  if (wired.has(mount) || typeof document === "undefined") return;
  wired.add(mount);
  // The file picker's choice (the click delegate does not carry a file input's change).
  mount.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | null;
    const where = el?.getAttribute?.("data-co-file");
    if (!el || !where || !el.files) return;
    const files = Array.from(el.files);
    el.value = "";
    addFiles(ctx, whereOf(where), files);
  });
  // A press outside an open picker or mode menu closes it (the box itself keeps the picker).
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    for (const where of ["page", "panel"] as const) {
      const ui = ctx.ui.composer[where];
      if (ui.modeMenu && !t?.closest?.("[data-co-menu], [data-co-modebtn]")) closeModeMenu(ctx, where);
      if (ui.picker && !t?.closest?.(`[data-co-menu], [data-ask-input="${where}"], [data-act="askCoAt"], [data-act="askCoSlash"]`)) closePicker(ctx, where);
    }
  }, true);
}

/** Grow the box to its words (46 → 220px): measure at `auto`, then set the new height so the CSS transition plays. */
function grow(el: HTMLTextAreaElement, ui: ComposerUi): void {
  if (!el.isConnected || !el.offsetParent) return;
  const cs = getComputedStyle(el);
  const min = parseFloat(cs.minHeight) || 46;
  const max = parseFloat(cs.maxHeight) || 220;
  const prev = el.style.height;
  const tr = el.style.transition;
  el.style.transition = "none";
  el.style.height = "auto";
  const want = Math.round(Math.min(max, Math.max(min, el.scrollHeight)));
  el.style.height = prev;
  void el.offsetHeight;
  el.style.transition = tr;
  if (ui.h !== want) { ui.h = want; el.style.height = `${want}px`; }
}

function afterPaintWhere(ctx: AskCtx, mount: HTMLElement, where: AskWhere): void {
  if (syncThread(ctx, where)) ctx.paint();
  const el = mount.querySelector<HTMLTextAreaElement>(`[data-ask-input="${where}"]`);
  if (!el) return;
  const ui = ctx.ui.composer[where];
  ctx.want(ui.context);
  // A focused box is never value-synced by morph (web/src/morph.ts): words set here (a pick, a send) land now.
  if (el.value !== ui.text) el.value = ui.text;
  const r = rt(ctx);
  const focus = r.focus[where];
  if (focus) {
    delete r.focus[where];
    if (focus === "menu") mount.querySelector<HTMLElement>(`[data-ask-composer="${where}"] .ask-co-menu [role="menuitemradio"][aria-checked="true"]`)?.focus();
    else el.focus();
  }
  if (ui.caret !== null) {
    const c = Math.min(ui.caret, el.value.length);
    ui.caret = null;
    if (document.activeElement === el) el.setSelectionRange(c, c);
  }
  grow(el, ui);
  const opt = ui.picker ? mount.querySelector<HTMLElement>(`#ask-co-opt-${where}-${ui.picker.sel}`) : null;
  opt?.scrollIntoView?.({ block: "nearest" });
}

// ── the dev replay's `composer:<state>` (inventory §5) ───────────────────────

/** Set the composer up as the design's `composer:<state>` artboard shows it. */
export function composerReplaySetup(ctx: AskCtx, where: AskWhere, forced: ComposerForced): void {
  const ui = { ...ctx.ui.composer[where], forced };
  ctx.ui.composer[where] = ui;
  const file = (key: string, name: string, size: number, kind: AskAttachKind, id: number): ComposerFile =>
    ({ key, name, size, kind, state: "ready", preview: null, att: { id, slug: `sample-${id}`, title: name, kind, contentType: "", size, sha256: "" } });
  switch (forced) {
    case "at": typeText(ctx, where, "What changed in @net"); ctx.ui.composer[where].picker!.sel = 1; break;
    case "slash": typeText(ctx, where, "/"); break;
    case "files": {
      const files = [file("f0", "ci-failure.png", 421888, "image", 901), file("f1", "deploys-october.csv", 18432, "text", 902), file("f2", "netlify-api.pdf", 1258291, "pdf", 903)];
      ctx.ui.composer[where] = { ...ui, text: "Why does this fail only on main?", files, attachments: files.map((f) => f.att!), context: ["ticket:14"] };
      ctx.want(["ticket:14"]);
      break;
    }
    case "tooLarge":
      ctx.ui.composer[where] = { ...ui, text: "Summarize this standup", files: [{ key: "f9", name: "standup-recording.mov", size: 84934656, kind: null, state: "too_large", att: null, preview: null }] };
      break;
    case "drag": ctx.ui.composer[where] = { ...ui, drag: true }; break;
    case "error": ctx.ui.composer[where] = { ...ui, error: true }; break;
    default: break;
  }
  rt(ctx).focus[where] = "input";
  ctx.paint();
}

// ── the part ─────────────────────────────────────────────────────────────────

const anyOpen = (ctx: AskCtx, f: (ui: ComposerUi) => boolean): AskWhere[] => (["page", "panel"] as const).filter((w) => f(ctx.ui.composer[w]));

export const composerPart: AskPart = {
  code: "Co",
  act(ctx, name, arg, value) {
    switch (name) {
      case "askCoText": { const where = whereOf(arg); const text = value ?? ""; typeText(ctx, where, text, caretOf(where, text)); return; }
      case "askCoSend": sendFrom(ctx, whereOf(arg)); return;
      case "askCoStop": ctx.stop(whereOf(arg)); return;
      case "askCoAttach": { closePlus(ctx); ctx.paint(); fileInput(whereOf(arg))?.click(); return; }
      case "askCoAt": {
        const where = whereOf(arg);
        const t = ctx.ui.composer[where].text;
        const text = t + (t && !/\s$/.test(t) ? " @" : "@");
        closePlus(ctx);
        ctx.ui.composer[where] = { ...ctx.ui.composer[where], text, caret: text.length };
        openPicker(ctx, where, "@", "", text.length - 1);
        rt(ctx).focus[where] = "input";
        ctx.paint();
        return;
      }
      case "askCoSlash": {
        const where = whereOf(arg);
        closePlus(ctx);
        ctx.ui.composer[where] = { ...ctx.ui.composer[where], text: "/", caret: 1 };
        openPicker(ctx, where, "/", "", 0);
        rt(ctx).focus[where] = "input";
        ctx.paint();
        return;
      }
      case "askCoPick": { const [where, i] = splitArg(arg); pick(ctx, where, Number(i) || 0); return; }
      case "askCoModeMenu": {
        const where = whereOf(arg);
        const ui = ctx.ui.composer[where];
        if (ui.modeMenu) { closeModeMenu(ctx, where); return; }
        ctx.cancelExit(chipKey(where, "mode"));
        closePicker(ctx, where, false);
        ctx.ui.composer[where] = { ...ctx.ui.composer[where], modeMenu: true };
        rt(ctx).focus[where] = "menu";
        ctx.paint();
        return;
      }
      case "askCoMode": { const [where, id] = splitArg(arg); setMode(ctx, where, id); return; }
      case "askCoAuto": { const [where, v] = splitArg(arg); setAuto(ctx, where, v === "on"); return; }
      case "askCoRemove": { const [where, key] = splitArg(arg); removeChip(ctx, where, key); return; }
      case "askCoClear": {
        const where = whereOf(arg);
        ctx.exit(chipKey(where, "*"), () => {
          const ui = ctx.ui.composer[where];
          for (const f of ui.files) if (f.preview) revoke(f.preview);
          ctx.ui.composer[where] = { ...ui, context: [], files: [], attachments: [], notice: null, error: false, forced: ui.forced === "tooLarge" || ui.forced === "files" ? null : ui.forced };
        });
        return;
      }
      case "askCoRetry": retry(ctx, whereOf(arg)); return;
    }
  },
  escape: [
    { layer: "picker", isOpen: (ctx) => anyOpen(ctx, (u) => u.picker !== null).length > 0, close: (ctx) => { for (const w of anyOpen(ctx, (u) => u.picker !== null)) { closePicker(ctx, w); rt(ctx).focus[w] = "input"; } } },
    { layer: "menu", isOpen: (ctx) => anyOpen(ctx, (u) => u.modeMenu).length > 0, close: (ctx) => { for (const w of anyOpen(ctx, (u) => u.modeMenu)) { closeModeMenu(ctx, w); rt(ctx).focus[w] = "input"; } } },
  ],
  afterPaint(ctx, mount) {
    wire(ctx, mount);
    afterPaintWhere(ctx, mount, "page");
    afterPaintWhere(ctx, mount, "panel");
  },
  onKeyDown(ctx, e) {
    const t = e.target as Element | null;
    // The mode menu: ↑↓ move between its items.
    const mi = t?.closest?.<HTMLElement>(".ask-co-menu [role='menuitemradio']");
    if (mi && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const items = Array.from(mi.parentElement?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? []);
      const i = items.indexOf(mi);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
      return true;
    }
    const el = t?.closest?.<HTMLTextAreaElement>("[data-ask-input]");
    if (!el) return false;
    const where = whereOf(el.dataset.askInput ?? null);
    const ui = ctx.ui.composer[where];
    const p = ui.picker;
    if (p && !ctx.ui.closing[chipKey(where, "pick")]) {
      const n = rowCount(p);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        ctx.ui.composer[where] = { ...ui, picker: { ...p, sel: n ? (p.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n : 0 } };
        ctx.paint();
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && n && !e.isComposing) {
        e.preventDefault();
        if (el.value !== ui.text) ctx.ui.composer[where] = { ...ctx.ui.composer[where], text: el.value };
        pick(ctx, where, Math.min(p.sel, n - 1));
        return true;
      }
    }
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return false;
    e.preventDefault();
    if (el.value !== ui.text) ctx.ui.composer[where] = { ...ui, text: el.value };
    sendFrom(ctx, where);
    return true;
  },
  onPaste(ctx, e) {
    const el = (e.target as Element | null)?.closest?.<HTMLTextAreaElement>("[data-ask-input]");
    const files = e.clipboardData?.files;
    if (!el || !files || !files.length) return false;
    e.preventDefault();
    addFiles(ctx, whereOf(el.dataset.askInput ?? null), Array.from(files));
    return true;
  },
  onDragOver(ctx, e) {
    const z = dropZone(e);
    if (!z || !hasFiles(e) || !ctx.ui.state.data || composerBlock({ ui: ctx.ui, where: z.where })) return false;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    ctx.cancelExit(chipKey(z.where, "drop"));
    if (!ctx.ui.composer[z.where].drag) { ctx.ui.composer[z.where] = { ...ctx.ui.composer[z.where], drag: true }; ctx.paint(); }
    return true;
  },
  onDragLeave(ctx, e) {
    const z = dropZone(e);
    if (!z || !ctx.ui.composer[z.where].drag) return false;
    const to = e.relatedTarget as Node | null;
    if (to && z.el.contains(to)) return false;
    endDrag(ctx, z.where);
    return true;
  },
  onDrop(ctx, e) {
    const z = dropZone(e);
    if (!z || !hasFiles(e)) return false;
    e.preventDefault();
    ctx.cancelExit(chipKey(z.where, "drop"));
    ctx.ui.composer[z.where] = { ...ctx.ui.composer[z.where], drag: false };
    addFiles(ctx, z.where, Array.from(e.dataTransfer?.files ?? []));
    return true;
  },
};
