// Ask Trov — the typed client (FOUNDATION). Every Ask read and write the screen makes, over the cookie
// routes in src/ai/ask/routes.ts (paths: `ASK_ROUTES`, shared/ai-ask-core.ts). The screen never fetches
// directly: parts call `ctx.api.*` (web/src/ask-state.ts `AskCtx`), which is THIS client — or, under the dev
// replay (`?askReplay=<scenario>`), web/src/ask-replay.ts's stand-in with the same interface.
//
// Every limit and flag the composer shows comes from `getState()` (`AskState`), never from a UI constant.
// A refusal is an `AskApiError` carrying the body's `error` code (`mode_unavailable`, `auto_off`, `changed`,
// `expired`, `plan_limit`, …), its `message` and, for Undo's `changed`, the `ref` to undo by hand.

import { apiFetch, tenantHref, Unauthorized, quickSearch } from "./api";
import { readAskStream } from "./ask-sse";
import {
  ASK_ROUTES, parseAskRef,
  type AskActionAnswer, type AskAttachmentUpload, type AskCancelBody, type AskConfirmBody, type AskEvent, type AskEventMap, type AskItem, type AskRequest, type AskSaveBody, type AskSearchHit,
  type AskSettings, type AskSettingsPut, type AskState, type AskThreadDetail, type AskThreadPatch, type AskThreadSummary, type AskWrongReason, type PeekResult,
  type AskRefType,
} from "@shared/ai-ask-core";
import type { QuickSearchResult } from "@shared/quick-search";

/** One item the composer's @ picker found (the app's quick search, as refs). Its row draws from the item's RefView
 *  once peek has it; until then from these words. */
export interface AskRefHit { ref: string; type: AskRefType; title: string; status: string | null }

/** The quick search's hits as refs, in its order (a sprint's id is `sprint:<n>`; the roadmap's `plan` is not an item). */
export function quickHitsToRefs(r: QuickSearchResult): AskRefHit[] {
  const out: AskRefHit[] = [];
  for (const g of r.groups) {
    for (const h of g.hits) {
      const key = h.type === "sprint" ? h.id.replace(/^sprint:/, "") : h.id;
      const p = parseAskRef(`${h.type}:${key}`);
      if (!p || (h.type === "sprint" && !/^\d+$/.test(key))) continue;
      out.push({ ref: `${p.type}:${p.key}`, type: p.type, title: h.title, status: h.status });
    }
  }
  return out;
}

export class AskApiError extends Error {
  status: number;
  /** The body's `error` (`invalid`, `not_found`, `mode_unavailable`, `auto_off`, `changed`, …), else the status. */
  code: string;
  /** Undo's `changed`: the item to undo by hand. */
  ref: string | null = null;
  /** The whole refusal body, for a part that needs more of it (`modes`, `results`). */
  body: Record<string, unknown> = {};
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

async function refused(res: Response): Promise<AskApiError> {
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  const code = typeof body.error === "string" ? body.error : String(res.status);
  const message = typeof body.message === "string" ? body.message : code;
  const err = new AskApiError(res.status, code, message);
  err.ref = typeof body.ref === "string" ? body.ref : null;
  err.body = body;
  return err;
}

async function send<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal };
  if (body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
  const res = await apiFetch(path, init);
  if (!res.ok) throw await refused(res);
  return res.json() as Promise<T>;
}

/** What a stream call needs: the request, where events go, and the Stop signal. */
export interface AskStreamOpts { onEvent(e: AskEvent): void; signal?: AbortSignal }

/** THE interface every part talks to (the live client below, or the replay's). */
export interface AskApi {
  getState(): Promise<AskState>;
  listThreads(): Promise<AskThreadSummary[]>;
  searchThreads(q: string, signal?: AbortSignal): Promise<AskSearchHit[]>;
  getThread(id: number): Promise<AskThreadDetail>;
  patchThread(id: number, patch: AskThreadPatch): Promise<AskThreadSummary>;
  deleteThread(id: number): Promise<void>;
  /** The markdown export's URL (a link the person follows; the route answers `text/markdown`). */
  exportUrl(id: number): string;
  stopThread(id: number): Promise<void>;
  /** `POST /ask`: resolves when the stream ends. A refusal BEFORE the stream (JSON `invalid`, `not_found`,
   *  `mode_unavailable`, `auto_off`) rejects with an AskApiError; Stop rejects with an AbortError. */
  ask(req: AskRequest, o: AskStreamOpts): Promise<void>;
  peek(refs: string[]): Promise<PeekResult[]>;
  /** The composer's @ picker: the org's quick search (`GET /search/quick`), as refs. */
  searchRefs(q: string, signal?: AbortSignal): Promise<AskRefHit[]>;
  getItem(ref: string): Promise<AskItem>;
  confirmAction(id: number, body?: AskConfirmBody): Promise<AskActionAnswer>;
  cancelAction(id: number, body?: AskCancelBody): Promise<AskActionAnswer>;
  undoAction(id: number): Promise<AskActionAnswer>;
  saveForm(messageId: number, block?: number): Promise<{ block: Extract<import("@shared/ai-ask-core").AskBlock, { kind: "save_form" }>; index: number }>;
  saveThread(threadId: number, body: AskSaveBody): Promise<AskEventMap["artifact_saved"]>;
  uploadAttachments(files: File[], threadId?: number | null): Promise<AskAttachmentUpload>;
  /** Remove an uploaded attachment never sent (its chip's ✕): deleted for good on the server. */
  deleteAttachment(id: number): Promise<void>;
  markWrong(messageId: number, reason: AskWrongReason): Promise<void>;
  getSettings(): Promise<AskSettings>;
  putSettings(body: AskSettingsPut): Promise<AskSettings>;
}

/** The live client. */
export const askApi: AskApi = {
  getState: () => send<AskState>("GET", ASK_ROUTES.state),
  listThreads: () => send<{ threads: AskThreadSummary[] }>("GET", ASK_ROUTES.threads).then((r) => r.threads),
  searchThreads: (q, signal) => send<{ hits: AskSearchHit[] }>("GET", `${ASK_ROUTES.threads}?q=${encodeURIComponent(q)}`, undefined, signal).then((r) => r.hits),
  getThread: (id) => send<AskThreadDetail>("GET", ASK_ROUTES.thread(id)),
  patchThread: (id, patch) => send<{ thread: AskThreadSummary }>("PATCH", ASK_ROUTES.thread(id), patch).then((r) => r.thread),
  deleteThread: (id) => send<unknown>("DELETE", ASK_ROUTES.thread(id)).then(() => undefined),
  exportUrl: (id) => tenantHref(ASK_ROUTES.exportThread(id)),
  stopThread: (id) => send<unknown>("POST", ASK_ROUTES.stop(id), {}).then(() => undefined),
  async ask(req, o) {
    const res = await apiFetch(ASK_ROUTES.ask, {
      method: "POST", signal: o.signal,
      headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(req),
    });
    if (!res.ok) throw await refused(res);
    await readAskStream(res, o.onEvent, o.signal);
  },
  peek: (refs) => send<{ items: PeekResult[] }>("POST", ASK_ROUTES.peek, { refs }).then((r) => r.items),
  searchRefs: (q, signal) => quickSearch(q, signal).then(quickHitsToRefs),
  getItem: (ref) => send<AskItem>("GET", ASK_ROUTES.item(ref)),
  confirmAction: (id, body = {}) => send<AskActionAnswer>("POST", ASK_ROUTES.confirm(id), body),
  cancelAction: (id, body = {}) => send<AskActionAnswer>("POST", ASK_ROUTES.cancel(id), body),
  undoAction: (id) => send<AskActionAnswer>("POST", ASK_ROUTES.undo(id), {}),
  saveForm: (messageId, block) => send("POST", ASK_ROUTES.saveForm(messageId), block === undefined ? {} : { block }),
  saveThread: (threadId, body) => send<AskEventMap["artifact_saved"]>("POST", ASK_ROUTES.save(threadId), body),
  async uploadAttachments(files, threadId) {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    if (threadId != null) form.append("threadId", String(threadId));
    const res = await apiFetch(ASK_ROUTES.attachments, { method: "POST", body: form });
    if (!res.ok) throw await refused(res);
    return res.json() as Promise<AskAttachmentUpload>;
  },
  deleteAttachment: (id) => send<unknown>("DELETE", ASK_ROUTES.attachment(id)).then(() => undefined),
  markWrong: (messageId, reason) => send<unknown>("POST", ASK_ROUTES.wrong(messageId), { reason }).then(() => undefined),
  getSettings: () => send<AskSettings>("GET", ASK_ROUTES.settings),
  putSettings: (body) => send<AskSettings>("PUT", ASK_ROUTES.settings, body),
};

/** A Stop, not a failure. */
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";
export const isUnauthorized = (e: unknown): boolean => e instanceof Unauthorized;

// ── the dev replay (LOCAL_AI_PREVIEW; src/ai/routes.ts) ──────────────────────

/** `GET /ai/ask-replay`: the scenarios and the fixtures the screen reads beside the stream. */
export interface AskReplayIndex {
  scenarios: string[];
  questions: Record<string, { text: string; context: string[]; attachments: { title: string; kind: "image" | "pdf" | "text"; size: number }[] } | null>;
  state: { pro: AskState; free: AskState };
  settings: { pro: AskSettings; free: AskSettings };
  threads: AskThreadSummary[];
  search: { q: string; hits: AskSearchHit[] };
  refs: Record<string, import("@shared/ai-ask-core").RefView>;
}
export const getReplayIndex = (): Promise<AskReplayIndex> => send<AskReplayIndex>("GET", "/ai/ask-replay");
/** Stream one recorded scenario at `speed` (1 = real pacing, 0 = all at once). */
export async function streamReplay(scenario: string, speed: number, o: AskStreamOpts): Promise<void> {
  const res = await apiFetch(`/ai/ask-replay/${encodeURIComponent(scenario)}?speed=${speed}`, { signal: o.signal, headers: { accept: "text/event-stream" } });
  if (!res.ok) throw await refused(res);
  await readAskStream(res, o.onEvent, o.signal);
}
