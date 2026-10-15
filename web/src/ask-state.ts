// Ask Trov — the screen's state and the seams every part plugs into (FOUNDATION).
//
// `AppState.ask` is an `AskUi`. The shell owns its top half (the reads, the two conversations — the Ask page's
// and the ⌘J panel's —, the ref views, the inspector stack, the hover card, the layout); each PART owns one
// sub-object, defined in the part's own file, so two parts never edit the same lines:
//
//   part          file                     state            act prefix   renders
//   conversation  ask-conversation.ts      ui.conversation  askCv…       questions, steps, thinking, answer blocks, footer, follow-ups
//   composer      ask-composer.ts          ui.composer      askCo…       the box, chips, picker, mode menu, Auto switch, blocked states
//   inspector     ask-inspector.ts         ui.inspectorUi   askIn…       the per-type views (the frame + header are the shell's)
//   actions       ask-actions.ts           ui.actions       askAc…       write cards, done lines, Save as artifact, Wrong?
//   cmdj          ask-cmdj.ts              ui.cmdj          askCj…       the ⌘J panel over any page, the Tickets page's button
//   phone         ask-phone.ts             ui.phone         askPh…       the thread drawer, the + menu, the inspector sheet
//   threads       ask-threads.ts (shell)   ui.threadQ …     askTh…       the thread list, search, its ⋯ menu
//   shell         ask-screen.ts            the rest         askSh…       header, columns, inspector frame, hover card
//   settings      ask-settings.ts          (its own)        —            Settings › Trov (a sibling's; not wired here)
//
// Acts: every Ask `data-act` is `ask` + a two-letter part code + a name (`askCoSend`, `askInBack`); main.ts
// hands every `ask…` act to ask-controller.ts, which routes it by the code to that part's `act`. A part reads
// and writes through `AskCtx` (below) — never fetch, never main.ts.

import type { AppState } from "./render";
import type { AskCommand, AskMode, AskSearchHit, AskState, AskThreadSummary, PeekResult } from "@shared/ai-ask-core";
import type { AskApi } from "./ask-api";
import type { AskConvo } from "./ask-stream";
import { emptyConvo } from "./ask-stream";
import type { EscEntry } from "./ask-escape";
import type { HoverAt, RefLook } from "./ask-refs";
import { ASK_INSPECTOR } from "./ask-layout";
import { initialConversationUi, type ConversationUi } from "./ask-conversation";
import { initialComposerUi, type ComposerUi } from "./ask-composer";
import { initialInspectorUi, type InspectorUi } from "./ask-inspector";
import { initialActionsUi, type ActionsUi } from "./ask-actions";
import { initialCmdjUi, type CmdjUi } from "./ask-cmdj";
import { initialPhoneUi, type PhoneUi } from "./ask-phone";

/** Which conversation: the Ask page's, or the ⌘J panel's (over any page). */
export type AskWhere = "page" | "panel";

export interface AskLoad<T> { status: "idle" | "loading" | "ok" | "error"; data: T }

export interface AskUi {
  /** `GET /ask/state` — every limit and flag the composer shows (never a UI constant). */
  state: AskLoad<AskState | null>;
  /** `GET /ask/threads`. */
  threads: AskLoad<AskThreadSummary[]>;
  /** The thread search box, and its hits (null while the box is empty). */
  threadQ: string;
  hits: AskLoad<AskSearchHit[]> | null;
  /** The thread whose ⋯ menu is open, and the one being renamed (with its draft). */
  threadMenu: number | null;
  renaming: { id: number; text: string } | null;
  /** The two conversations. */
  page: AskConvo;
  panel: AskConvo;
  /** THE ref views, by ref (`ticket:14`): RefView, or `{ ref, hidden: true }`. Filled by the controller only. */
  refViews: Record<string, PeekResult>;
  /** The header's threads toggle: null = the layout rules (ask-layout.ts), else the person's choice. */
  threadsForced: boolean | null;
  /** The window's width, kept by the controller (only bucket crossings repaint). */
  vw: number;
  /** The inspector: a stack of refs with a cursor (Back steps down it), its width, and which conversation opened it. */
  inspector: { stack: string[]; idx: number; width: number; where: AskWhere };
  /** The hover card on screen, if any. */
  hover: { ref: string; at: HoverAt } | null;
  /** The dev replay driving the screen (`?askReplay=<scenario>`), or null. */
  replay: { scenario: string; speed: number } | null;
  // ── the parts' own state ──
  conversation: ConversationUi;
  composer: Record<AskWhere, ComposerUi>;
  inspectorUi: InspectorUi;
  actions: ActionsUi;
  cmdj: CmdjUi;
  phone: PhoneUi;
}

export function initialAskUi(): AskUi {
  return {
    state: { status: "idle", data: null },
    threads: { status: "idle", data: [] },
    threadQ: "", hits: null, threadMenu: null, renaming: null,
    page: emptyConvo(), panel: emptyConvo(),
    refViews: {},
    threadsForced: null,
    vw: typeof window !== "undefined" ? window.innerWidth : 1440,
    inspector: { stack: [], idx: -1, width: ASK_INSPECTOR.width, where: "page" },
    hover: null,
    replay: null,
    conversation: initialConversationUi(),
    composer: { page: initialComposerUi(), panel: initialComposerUi() },
    inspectorUi: initialInspectorUi(),
    actions: initialActionsUi(),
    cmdj: initialCmdjUi(),
    phone: initialPhoneUi(),
  };
}

/** The ref the inspector shows, or null when it is closed. */
export const inspectorRef = (ui: Pick<AskUi, "inspector">): string | null => ui.inspector.stack[ui.inspector.idx] ?? null;

/** What every renderer gets: pure inputs only. */
export interface AskView {
  app: AppState;
  ui: AskUi;
  look: RefLook;
  /** The conversation this render is for. */
  where: AskWhere;
}
export const askView = (app: AppState, where: AskWhere = "page"): AskView =>
  ({ app, ui: app.ask, where, look: { views: app.ask.refViews, persons: app.persons.data } });
export const convoOf = (v: Pick<AskView, "ui" | "where">): AskConvo => v.ui[v.where];

/** One question to send (the composer, a starter, a follow-up, a rephrase chip, edit-and-resend, regenerate). */
export interface AskSendInput {
  text: string;
  where?: AskWhere;
  command?: AskCommand;
  /** Context chips (`ticket:14`); default: none. */
  context?: string[];
  /** Attachment ids from `uploadAttachments` (this thread's). */
  attachments?: number[];
  /** Default: the thread's mode, else `ask/state.defaultMode`. */
  mode?: AskMode;
  /** Default: the thread's switch. */
  auto?: boolean;
  /** Edit-and-resend (the last question's id) or regenerate (the last answer's id). */
  replaceFrom?: number;
}

/** What a part reads and writes through. Every method repaints as needed; `paint()` coalesces to a frame. */
export interface AskCtx {
  readonly app: AppState;
  readonly ui: AskUi;
  /** The live client, or the replay's stand-in (the same interface). */
  readonly api: AskApi;
  /** Under the dev replay nothing is written: a write answers with the replay's sample result. */
  readonly replay: boolean;
  look(): RefLook;
  /** Repaint on the next frame (many calls, one paint). */
  paint(): void;
  flash(msg: string, ms?: number): void;
  /** A refused call: signed out → the sign-in; else `fallback` (or the refusal's own message) as a toast. */
  fail(e: unknown, fallback: string): void;
  /** Make sure these refs have views (one batched peek for the unknown ones). */
  want(refs: readonly string[]): void;
  send(input: AskSendInput): void;
  stop(where?: AskWhere): void;
  /** Push a ref on the inspector's stack (dropping anything after the cursor) and open it. */
  openRef(ref: string, where?: AskWhere): void;
  closeInspector(): void;
  /** Start a new thread (the header's "Trov", New thread). */
  newThread(where?: AskWhere): void;
  /** Open a stored thread (`#ask/<id>`). */
  openThread(id: number): void;
  /** Reload the thread list (after a rename, a pin, a delete, a new thread's title). */
  reloadThreads(): void;
}

/** One part, as the controller knows it (ask-controller.ts `PARTS`). Everything is optional. */
export interface AskPart {
  /** The two-letter act code (`Co` for `askCo…`). */
  code: string;
  act?(ctx: AskCtx, name: string, arg: string | null, value: string | null): void;
  /** The Escape layers this part owns. */
  escape?: EscEntry<AskCtx>[];
  /** After every paint while Ask is on screen (focus, autogrow, scroll). */
  afterPaint?(ctx: AskCtx, mount: HTMLElement): void;
  /** DOM events the click/input delegate does not carry; return true when handled. */
  onKeyDown?(ctx: AskCtx, e: KeyboardEvent): boolean;
  onPaste?(ctx: AskCtx, e: ClipboardEvent): boolean;
  onDragOver?(ctx: AskCtx, e: DragEvent): boolean;
  onDragLeave?(ctx: AskCtx, e: DragEvent): boolean;
  onDrop?(ctx: AskCtx, e: DragEvent): boolean;
  onChange?(ctx: AskCtx, e: Event): boolean;
  /** Sees every stream event after the shell folded it (a part that reacts: the composer clears its chips). */
  onEvent?(ctx: AskCtx, where: AskWhere, e: import("@shared/ai-ask-core").AskEvent): void;
}
