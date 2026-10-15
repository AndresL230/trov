// Ask Trov's contract, VALUE half (docs/architecture/ask.md). Zod-free, so the SPA imports the constants and
// the types without pulling zod into the browser bundle; `shared/ai-ask.ts` holds the zod schemas for the same
// shapes and re-exports everything here (and `shared/ai.ts` re-exports `ASK_MODES`, the one table to retune).
//
// The decided design: docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase F, AMENDED by Trov handoff
// #12 section 2 (the delta the finished design needs) — where they disagree, #12 wins. The frontend is built
// from Andres's Claude Design file against this contract; `shared/ai-fixtures.ts` › Ask Trov holds a recorded
// SSE transcript per design scenario, and the dev-only replay route streams them.

import type { AiEligibility } from "./ai-core";
import type { RepoFacts } from "./repo-facts-core";

// ── Modes (#12 §2.1) — THE table ─────────────────────────────────────────────

export const ASK_MODE_IDS = ["fast", "smart", "thinking"] as const;
export type AskMode = (typeof ASK_MODE_IDS)[number];
export const isAskMode = (v: unknown): v is AskMode => typeof v === "string" && (ASK_MODE_IDS as readonly string[]).includes(v);

export interface AskModeDef {
  id: AskMode;
  label: string;
  /** The mode menu's hint, verbatim from the design (Thinking's says what it counts as). */
  hint: string;
  /** The model that answers (src/ai/client.ts reads this for the `ask.*` kinds). */
  model: string;
  /** `index`: the search and list tools plus stored cards only; `full`: the whole catalog. */
  tools: "index" | "full";
  /** Tool calls one answer may make. */
  maxCalls: number;
  /** What one answer counts as in the org's monthly `ai_chat` allowance (questions). */
  countsAs: number;
  /** The answer's wall-clock budget; past it the turn stops with `error { code: "timeout" }`. */
  timeoutMs: number;
  /** Extended thinking (adaptive), its summary shown as "Thought for Ns". */
  thinking: boolean;
}

/** Retune Ask here: one row per mode. */
export const ASK_MODES: readonly AskModeDef[] = [
  { id: "fast", label: "Fast", hint: "Quick answers from what Trov has already indexed.", model: "claude-haiku-5-5", tools: "index", maxCalls: 3, countsAs: 1, timeoutMs: 30_000, thinking: false },
  { id: "smart", label: "Smart", hint: "Reads the items it finds before answering. The default.", model: "claude-sonnet-5-5", tools: "full", maxCalls: 8, countsAs: 1, timeoutMs: 30_000, thinking: false },
  { id: "thinking", label: "Thinking", hint: "Works through harder questions first. Slower. Counts as 5 questions.", model: "claude-opus-5-5", tools: "full", maxCalls: 8, countsAs: 5, timeoutMs: 90_000, thinking: true },
];
export const askMode = (id: AskMode): AskModeDef => ASK_MODES.find((m) => m.id === id)!;
/** The default for a new thread (Settings › Trov can change it on Pro), and what Free uses for every question. */
export const ASK_DEFAULT_MODE: AskMode = "smart";

/** The modes a plan offers. Free and Personal: Smart only, and no switcher. Pro and Enterprise: all three. */
export function askModesFor(plan: string): readonly AskMode[] {
  return plan === "team" || plan === "enterprise" ? ASK_MODE_IDS : [ASK_DEFAULT_MODE];
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Writes one answer may run at once in Auto mode; the next waits (`state: "waiting"`). */
export const ASK_AUTO_WRITES_MAX = 5;
/** Attachments (#12 §2.13): files per message, and bytes per file (the artifacts store's binary cap). */
export const ASK_ATTACH_FILES_MAX = 5;
export const ASK_ATTACH_BYTES_MAX = 10 * 1024 * 1024;
/** A text attachment goes to the model inline up to this many characters; past it, the first part and "truncated". */
export const ASK_ATTACH_TEXT_INLINE_MAX = 60_000;
/** The Messages API's own per-image limits on the Claude API, which Trov calls directly (platform.claude.com ›
 *  Vision › Request limits; the pinned SDK documents only `transformations.oversized_image`, which DOWNSIZES an image
 *  over the model's viewing size by default — these two are hard limits): 10 MB per image, base64-encoded (taken as
 *  decimal megabytes, the safe reading), and 8000 px on either side. An image past either is stored, the model is
 *  told it could not view it, and the person sees a notice (docs/architecture/ask.md › Attachments). */
export const ASK_MODEL_IMAGE_B64_MAX = 10_000_000;
export const ASK_MODEL_IMAGE_PX_MAX = 8000;
/** What one request may carry to the model in files, base64 included (the API's request cap is 32 MB). */
export const ASK_MODEL_FILES_MAX = 20 * 1024 * 1024;
export const ASK_INSTRUCTIONS_MAX = 500;
export const ASK_TEXT_MAX = 16_000;
export const ASK_DRAFT_MAX = 16_000;
export const ASK_TITLE_MAX = 80;
/** Context refs on one message, and refs one peek / show_items may name. */
export const ASK_REFS_MAX = 12;
export const ASK_PEEK_MAX = 50;
export const ASK_FOLLOWUPS_MAX = 3;
export const ASK_DIAGRAM_NODES_MAX = 8;
/** The composer says what is left once less than this share of the month remains. */
export const ASK_LOW_SHARE = 0.2;

/** What may be attached: images, PDFs, and text — markdown, plain text, CSV and code — by extension. */
export const ASK_ATTACH_KINDS = ["image", "pdf", "text"] as const;
export type AskAttachKind = (typeof ASK_ATTACH_KINDS)[number];
export const ASK_ATTACH_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ASK_ATTACH_TEXT_EXTS = [
  "md", "markdown", "txt", "text", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html", "htm", "svg", "mmd", "mermaid",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash",
  "zsh", "fish", "sql", "css", "scss", "vue", "svelte", "graphql", "proto", "tf", "diff", "patch",
] as const;
export function askAttachKind(filename: string, contentType: string): AskAttachKind | null {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const name = filename.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  if ((ASK_ATTACH_IMAGE_TYPES as readonly string[]).includes(ct)) return "image";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (ct.startsWith("text/") || (ASK_ATTACH_TEXT_EXTS as readonly string[]).includes(ext) || ct === "application/json") return "text";
  return null;
}

// ── Refs and ref views (#12 §2.5, §2.6) ──────────────────────────────────────
// An answer is markdown with ref tokens: `[[ticket:14]]`, `[[pr:173]]`, `[[doc:auth-flow]]`, `[[decision:7]]`,
// `[[feed:107]]`, `[[sprint:3]]`, `[[handoff:3]]`, `[[artifact:threat-model]]`, `[[person:meilin]]`,
// `[[prompt:release-notes]]`, `[[repo:owner/name]]`. `[[ticket:14|status]]` draws that item's live status mark
// and word instead (a table's Status column). A token is LINKED only when a tool returned that item in this
// thread or the person attached it; the server resolves those into RefViews (`done.cites`) — the rest render as
// plain text.

export const ASK_REF_TYPES = ["ticket", "pr", "doc", "decision", "feed", "sprint", "handoff", "artifact", "person", "prompt", "repo"] as const;
export type AskRefType = (typeof ASK_REF_TYPES)[number];

/** One ref token, anywhere in a text. Group 1 the type, group 2 the key, group 3 `status` for a status cell. */
export const ASK_REF_TOKEN_RE = /\[\[(ticket|pr|doc|decision|feed|sprint|handoff|artifact|person|prompt|repo):([A-Za-z0-9][A-Za-z0-9_.@/-]{0,99})(?:\|(status))?\]\]/g;

/** The refs (`type:key`) a text's tokens name, in order of first appearance, each once. */
export function askRefTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ASK_REF_TOKEN_RE)) {
    const ref = `${m[1]}:${m[2]}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** `type:key` → its parts, or null for anything that is not a ref. */
export function parseAskRef(ref: string): { type: AskRefType; key: string } | null {
  const m = /^([a-z]+):([A-Za-z0-9][A-Za-z0-9_.@/-]{0,99})$/.exec(ref);
  if (!m || !(ASK_REF_TYPES as readonly string[]).includes(m[1])) return null;
  return { type: m[1] as AskRefType, key: m[2] };
}

/** A mark (web/src/marks.ts): a progress glyph or a shape. */
export const ASK_MARKS = ["todo", "half", "most", "done", "declined", "warn", "dot", "ring", "triangle", "diamond", "square", "check"] as const;
export type AskMarkName = (typeof ASK_MARKS)[number];
/** A mark's tone, by meaning; the screen maps it to its token (accent, amber, green, red, blue, fg-55, fg-40). */
export const ASK_TONES = ["accent", "amber", "green", "red", "blue", "muted", "faded"] as const;
export type AskTone = (typeof ASK_TONES)[number];

export interface RefStatus { mark: AskMarkName; tone: AskTone; word: string; tip: string }

/** THE view model of an item: every chip, card, hover card, inspector header, picker row and source row draws
 *  from it. Built by the SERVER from Trov's rows (never model text), permission-checked for the viewer. */
export interface RefView {
  ref: string;
  type: AskRefType;
  /** A ticket's, PR's or handoff's number. */
  num?: number;
  title: string;
  /** null when the item has no status (a person, a feed entry). */
  status: RefStatus | null;
  /** Who owns it (a handle): an assignee, an author, a lead. */
  owner?: string | null;
  updated?: string | null;
  /** In-app hash route or absolute URL (a PR); null when the item has no page of its own. */
  href: string | null;
  /** What the hover card shows. ticket: { priority, assignees, sprint }; pr: { author, head, base, checks };
   *  doc: { space, version, owner, excerpt }; person: { role?, workingOn? }; sprint: { due, progress };
   *  handoff: { from, to, task }; artifact: { kind, visibility, version }; repo: { facts: AskRepoFacts | null }. */
  extra: Record<string, unknown>;
}

/** A repo ref's `extra.facts` (#186): the Repo Overview's ONE projection (`RepoFacts`, src/tools/repo-facts.ts, as
 *  `getRepoDashboard` reads it), cut to what a chip, the hover card and the inspector draw — the apps, environments
 *  and parts (each part's history down to its newest deploy), out-of-step, CI per environment, the release, what
 *  needs attention and the week's figures. Its status is never a word of Ask's own: the client derives it with the
 *  Overview's `envVerdict` (web/src/repo-verdict.ts) and draws it with `stateMark` — so `RefView.status` is null for
 *  a repo. null facts = not read (Unknown, never "Healthy" and never zero). */
export type AskRepoFacts = Pick<RepoFacts, "repo" | "app" | "apps" | "envs" | "parts" | "outOfStep" | "ci" | "release" | "attention" | "week">;
export function askRepoFacts(f: RepoFacts): AskRepoFacts {
  return {
    repo: f.repo, app: f.app, apps: f.apps, envs: f.envs, outOfStep: f.outOfStep, ci: f.ci, release: f.release, attention: f.attention, week: f.week,
    parts: f.parts.map((p) => ({ ...p, history: p.history.slice(-1) })),
  };
}
/** What peek answers for an item the person cannot see (or that is not there): the same for both. */
export interface HiddenRef { ref: string; hidden: true }
export type PeekResult = RefView | HiddenRef;

// ── Blocks (#12 §2.4, §2.7–2.11) ─────────────────────────────────────────────

export const ASK_CHART_QUERIES = ["merged_prs_by_week", "tickets_by_status", "ci_failures_by_week", "theme_shares", "sprint_burndown"] as const;
export type AskChartQuery = (typeof ASK_CHART_QUERIES)[number];

/** A chart: the server runs the fixed query; every value is the server's. */
export interface AskChart {
  title: string;
  total: number;
  rows: { label: string; value: number }[];
  /** What a value counts ("merged pull requests"). */
  unit: string;
  query: AskChartQuery;
  params: Record<string, unknown>;
}

/** The theme strip: each value a share of the week from 0 to 1. The caption says what the data really is. */
export interface AskThemesBlock {
  title: string;
  caption: string;
  weeks: string[];
  lanes: { theme: string; color: string; values: number[] }[];
}

/** A dependency chain (v1 draws chains; a branching graph falls back to a list: `layout: "list"`). */
export interface AskDiagram {
  title: string;
  caption: string | null;
  nodes: { id: string; label: string; eyebrow: string | null; ref: string | null; view: RefView | null }[];
  edges: [string, string][];
  layout: "chain" | "list";
}

/** "I couldn't find that in Trov": what was searched this turn, with counts the server computed. */
export interface AskNotFound {
  query: string;
  tries: string[];
  searched: { area: string; scope: string }[];
}

/** The Save as artifact card: no model call; the person picks the title, the kind and who can see it. */
export interface AskSaveForm {
  /** The answer it saves, or null for the whole thread. */
  messageId: number | null;
  /** One block of that answer, or null for the whole answer. */
  block: number | null;
  title: string;
  kind: "markdown" | "html";
  visibility: "private" | "org";
  /** Set once it is saved: the saved line. */
  saved: { slug: string; title: string; visibility: "private" | "org"; url: string } | null;
}

export const ASK_BLOCK_KINDS = ["items", "chart", "themes", "diagram", "not_found", "save_form"] as const;
export type AskBlockKind = (typeof ASK_BLOCK_KINDS)[number];
export type AskBlock =
  | { kind: "items"; items: RefView[] }
  | { kind: "chart"; chart: AskChart }
  | { kind: "themes"; themes: AskThemesBlock }
  | { kind: "diagram"; diagram: AskDiagram }
  | { kind: "not_found"; notFound: AskNotFound }
  | { kind: "save_form"; form: AskSaveForm };

// ── Activity (#12 §2.4) ──────────────────────────────────────────────────────

export const ASK_ACTIVITY_ICONS = ["search", "tickets", "ci", "pr", "sprint", "feed", "docs", "read", "handoffs", "review"] as const;
export type AskActivityIcon = (typeof ASK_ACTIVITY_ICONS)[number];

// ── Write cards (#12 §2.12) ──────────────────────────────────────────────────

export const ASK_ACTION_KINDS = ["ticket", "handoff", "doc_edit", "move", "publish", "sprint", "other"] as const;
export type AskActionKind = (typeof ASK_ACTION_KINDS)[number];
export const ASK_ACTION_STATES = ["proposed", "waiting", "running", "confirmed", "auto", "undone", "cancelled", "failed", "expired"] as const;
export type AskActionState = (typeof ASK_ACTION_STATES)[number];

/** One changed stretch of a doc edit (up to 3 per card), with the heading above it for context. Editing `after`
 *  (confirm `{ args: { hunks: [{ index, after }] } }`) changes the proposed body. */
export interface AskDocHunk { index: number; heading: string | null; before: string; after: string }

/** What a card shows — built by the SERVER from Trov's rows: the item it becomes (or changes), field by field. */
export interface AskActionPreview {
  title: string;
  lines: { label: string; value: string }[];
  item: RefView | null;
  /** Doc edits only. */
  hunks?: AskDocHunk[];
  /** Publish only: false when the person may not promote — the card shows "Open in Review" instead. */
  canPublish?: boolean;
}

export interface AskAction {
  id: number;
  groupId: string | null;
  tool: string;
  kind: AskActionKind;
  state: AskActionState;
  preview: AskActionPreview;
  /** The card's field values, by name (what `editable` names can change before Confirm). */
  fields: Record<string, unknown>;
  editable: string[];
  note: string | null;
  result: unknown;
  /** The item the done line links to. */
  ref: string | null;
  /** Undo is offered. */
  undo: boolean;
  createdAt: string;
  decidedAt: string | null;
}

// ── The stream: SSE events (#12 §2.4) ────────────────────────────────────────
// `thread` first (and again once the first exchange names it); then `thinking`, `activity`, `text`, `block`,
// `action`, `action_result` and `artifact_saved` interleaved as the turn goes; then `followups` and `done`.
// `error` ends a stream early. Each SSE message is `event: <name>` + `data: <json>`.

export const ASK_EVENTS = ["thread", "thinking", "activity", "text", "block", "action", "action_result", "artifact_saved", "followups", "done", "error"] as const;
export type AskEventName = (typeof ASK_EVENTS)[number];

export const ASK_ERROR_CODES = ["capped", "off", "no_key", "timeout", "too_large", "failed"] as const;
export type AskErrorCode = (typeof ASK_ERROR_CODES)[number];

export interface AskTokens { in: number; out: number; cached: number }

export type AskActivityEvent =
  | { step: number; tool: string; icon: AskActivityIcon; label: string; state: "run" }
  | { step: number; state: "done"; results?: string[]; resultLine?: string };

export interface AskEventMap {
  thread: { id: number; title: string; mode: AskMode; auto: boolean; origin: AskOrigin; contextRef: string | null };
  /** `run` while it thinks (the client counts the seconds), then `done` with the SUMMARY — never raw thinking. */
  thinking: { state: "run" } | { state: "done"; seconds: number; summary: string };
  activity: AskActivityEvent;
  text: { delta: string };
  block: AskBlock;
  action: Pick<AskAction, "id" | "groupId" | "tool" | "kind" | "preview" | "fields" | "editable" | "note"> & { state: "proposed" | "waiting" };
  /** A card's decision. It names the write itself (`tool`, `kind`, the card's `preview`), so an Auto write — a result
   *  with no card before it — says what it did ("Created ticket #30", not "Changed ticket #30") with no re-read. */
  action_result: { id: number; groupId: string | null; tool: string; kind: AskActionKind; preview: AskActionPreview; state: "confirmed" | "auto" | "undone" | "cancelled" | "failed"; result: unknown; ref: string | null; undo: boolean; at: string };
  artifact_saved: { slug: string; title: string; visibility: "private" | "org"; url: string };
  followups: { items: string[] };
  /** `questionId`: the stored id of the question this answers (edit-and-resend needs no read first); absent on a
   *  stream recorded before it was added. */
  done: { messageId: number; questionId?: number; cites: RefView[]; tokens: AskTokens; stopped?: boolean };
  error: { code: AskErrorCode; message: string };
}
export type AskEvent = { [K in AskEventName]: { event: K; data: AskEventMap[K] } }[AskEventName];

// ── Routes (cookie only, under /api/o/:slug) ─────────────────────────────────

export const ASK_ROUTES = {
  ask: "/ask",                                                        // POST AskRequest → text/event-stream
  state: "/ask/state",                                                // GET → AskState
  peek: "/ask/peek",                                                  // POST { refs } → { items: PeekResult[] }
  item: (ref: string) => `/ask/item/${encodeURIComponent(ref)}`,      // GET → AskItem (the inspector, where no per-type route exists)
  threads: "/ask/threads",                                            // GET ?q= → AskThreadList | AskSearch
  thread: (id: number) => `/ask/threads/${id}`,                       // GET → AskThreadDetail; PATCH AskThreadPatch; DELETE
  exportThread: (id: number) => `/ask/threads/${id}/export`,          // GET → text/markdown
  stop: (id: number) => `/ask/threads/${id}/stop`,                    // POST → { ok }
  saveForm: (messageId: number) => `/ask/messages/${messageId}/save-form`, // POST { block? } → { block: save_form }
  save: (id: number) => `/ask/threads/${id}/save`,                    // POST AskSaveBody → artifact_saved
  confirm: (id: number) => `/ask/actions/${id}/confirm`,              // POST { args?, only? } → AskActionAnswer
  cancel: (id: number) => `/ask/actions/${id}/cancel`,                // POST { only? } → AskActionAnswer
  undo: (id: number) => `/ask/actions/${id}/undo`,                    // POST → AskActionAnswer
  attachments: "/ask/attachments",                                    // POST multipart (file × ≤5, threadId?) → AskAttachmentUpload
  attachment: (id: number) => `/ask/attachments/${id}`,               // DELETE (never sent: hard-deleted) → { ok }; 409 sent / published / referenced
  wrong: (messageId: number) => `/ask/messages/${messageId}/wrong`,   // POST { reason } → { ok }
  settings: "/ask/settings",                                          // GET → AskSettings; PUT AskSettingsPut
} as const;

export const ASK_COMMANDS = ["ticket", "handoff", "search", "summarize", "brief"] as const;
export type AskCommand = (typeof ASK_COMMANDS)[number];
export const ASK_ORIGINS = ["page", "panel"] as const;
export type AskOrigin = (typeof ASK_ORIGINS)[number];

/** `POST /ask`. `replaceFrom` (edit-and-resend, regenerate) replaces that message and everything after it:
 *  the last question (with `text`, the edited one) or the last answer (its question is asked again). */
export interface AskRequest {
  threadId?: number | null;
  text: string;
  command?: AskCommand;
  mode: AskMode;
  /** The thread's Ask before changes / Auto switch, as the composer shows it. */
  auto: boolean;
  /** Context chips (`ticket:14`, `person:meilin`): shown to the model and linkable. */
  context: string[];
  /** Attachment ids from `POST /ask/attachments` (this thread's, not sent yet). */
  attachments: number[];
  replaceFrom?: number;
  /** A new thread from the ⌘J panel (`panel`) — its first context ref is the thread's `contextRef`. */
  origin?: AskOrigin;
}

/** Why `POST /ask` refused before streaming (JSON, not SSE). */
export const ASK_REFUSALS = ["invalid", "not_found", "mode_unavailable", "auto_off"] as const;
export type AskRefusal = (typeof ASK_REFUSALS)[number];

/** `GET /ask/state` — everything the composer needs; the UI takes every limit and flag from here. */
export interface AskState {
  enabled: boolean;
  eligibility: AiEligibility;
  plan: string;
  modes: (Pick<AskModeDef, "id" | "label" | "hint" | "countsAs">)[];
  defaultMode: AskMode;
  allowance: { used: number; cap: number | null; resetsAt: string; low: boolean };
  autoAllowed: boolean;
  attach: { maxFiles: number; maxBytes: number; kinds: AskAttachKind[] };
  starters: string[];
  /** Pro's questions a month PER SEAT (`PLANS.team`, `perSeat`): the upsell's number, read from the server, never a
   *  client copy of the plans; null when Pro has no cap. */
  proPerSeat: number | null;
}

export const ASK_THREAD_GROUPS = ["pinned", "today", "week", "earlier"] as const;
export type AskThreadGroup = (typeof ASK_THREAD_GROUPS)[number];

export interface AskThreadSummary {
  id: number;
  title: string;
  pinned: boolean;
  mode: AskMode;
  auto: boolean;
  origin: AskOrigin;
  contextRef: string | null;
  hasDraft: boolean;
  /** Pinned, Today, This week, Earlier. */
  group: AskThreadGroup;
  createdAt: string;
  updatedAt: string;
}

/** One search hit: the thread, a snippet with the match's offsets, and how many of its messages matched. */
export interface AskSearchHit {
  thread: AskThreadSummary;
  snippet: { text: string; matches: [number, number][] } | null;
  matchCount: number;
}

export interface AskAttachment {
  /** The `chat_artifacts` row — what `AskRequest.attachments` and `read_attachment` name. */
  id: number;
  slug: string;
  title: string;
  kind: AskAttachKind;
  contentType: string;
  size: number;
  sha256: string;
  /** An image's preview (the artifact's raw route), else absent. */
  thumbUrl?: string;
}

export interface AskMessage {
  id: number;
  role: "user" | "assistant";
  mode: AskMode;
  text: string;
  command: AskCommand | null;
  context: string[];
  blocks: AskBlock[];
  activity: { step: number; tool: string; icon: AskActivityIcon; label: string; results: string[]; resultLine: string | null }[];
  followups: string[];
  thinking: { seconds: number; summary: string } | null;
  cites: RefView[];
  attachments: AskAttachment[];
  actions: AskAction[];
  /** An answer's parts in the order they STREAMED (text runs, blocks by their index in `blocks`, write cards by id),
   *  so a reload draws what the live answer drew. Absent on rows stored before it: text, then blocks, then cards. */
  parts?: AskMessagePart[];
  stopped: boolean;
  model: string | null;
  units: number;
  createdAt: string;
}

export type AskMessagePart = { kind: "text"; md: string } | { kind: "block"; index: number } | { kind: "action"; id: number };

export interface AskThreadDetail {
  thread: AskThreadSummary & { draft: string };
  messages: AskMessage[];
}

export interface AskThreadPatch { title?: string; pinned?: boolean; auto?: boolean; mode?: AskMode; draft?: string }

/** `POST /ask/threads/:id/save` — the whole thread (no `messageId`), one answer, or one block of it. */
export interface AskSaveBody {
  messageId?: number;
  block?: number;
  title?: string;
  kind?: "markdown" | "html";
  visibility?: "private" | "org";
}

/** Confirm / Cancel / Undo answer: every card it touched (a group moves together). Refusals: `not_found` 404;
 *  `not_proposed` / `expired` / `no_undo` / `already` / `changed` (Undo: "Changed since. Undo it by hand.") 409;
 *  `invalid` 400 (edited args the schema refuses). A write's own refusal is `state: "failed"`. */
/** `POST /ask/actions/:id/confirm`'s body: edited fields (the card's `editable` only), and `only` = this card, not
 *  its whole group. `cancel` takes `{ only }`. (The zod schemas in shared/ai-ask.ts are pinned to these.) */
export interface AskConfirmBody { args?: Record<string, unknown>; only?: boolean }
export interface AskCancelBody { only?: boolean }
export interface AskActionAnswer {
  results: AskEventMap["action_result"][];
  artifact?: AskEventMap["artifact_saved"];
}
export const ASK_ACTION_REFUSALS = ["not_found", "not_proposed", "expired", "no_undo", "already", "changed", "invalid"] as const;

export interface AskAttachmentUpload { threadId: number; attachments: AskAttachment[] }

/** "Wrong?" (#12 §2.14). The first two reach Review as "Flagged in Ask" on the cited items — the reason only. */
export const ASK_WRONG_REASONS = ["source_wrong", "out_of_date", "missed"] as const;
export type AskWrongReason = (typeof ASK_WRONG_REASONS)[number];
export const ASK_WRONG_LABELS: Record<AskWrongReason, string> = {
  source_wrong: "A source is wrong",
  out_of_date: "It is out of date",
  missed: "It missed something",
};
export const ASK_FLAG_REASONS: readonly AskWrongReason[] = ["source_wrong", "out_of_date"];
/** Review's "Flagged in Ask" line for one item: the reasons and how often — never the question, the answer or who. */
export interface AskFlag { ref: string; reason: AskWrongReason; count: number; lastAt: string }

/** Settings › Trov (#12 §2.19). `defaultMode` is Pro's; Free always uses Smart. */
export interface AskSettings { instructions: string; defaultMode: AskMode; modes: AskMode[] }
export interface AskSettingsPut { instructions?: string; defaultMode?: AskMode }

/** The inspector's read for a type with no route of its own (`GET /ask/item/:ref`). */
export interface AskItem { view: RefView; detail: Record<string, unknown> }

/** The MCP tools Ask does NOT offer, and why (test/ask.parity.test.ts: every MCP tool is wired or listed here). */
export const ASK_EXCLUDED_TOOLS: Record<string, string> = {
  switch_org: "a thread belongs to one organization",
  get_connection: "there is no MCP connection in Ask",
  record_session: "Ask is not a coding session",
  upload_asset: "files come through Ask's own attachment upload, stored as artifacts",
  delete_sprint: "a delete is a person's step on the web, never a tool",
};

/** Ask's own tools, on top of the MCP catalog. */
export const ASK_ONLY_TOOLS = [
  "trov_docs", "read_attachment", "save_artifact", "publish_doc", "show_items", "show_chart", "show_themes", "show_diagram", "show_not_found",
] as const;
export type AskOnlyTool = (typeof ASK_ONLY_TOOLS)[number];

/** The fallback starters (the design's four), when the person's own work suggests none. */
export const ASK_STARTERS_FALLBACK: readonly string[] = [
  "What shipped this week?",
  "What's blocking the hosting work?",
  "Summarize ticket #14",
  "Where did our time go this month?",
];
