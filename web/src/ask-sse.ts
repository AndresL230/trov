// Ask Trov — the SSE reader (FOUNDATION; nobody else should need to touch it).
//
// `POST /api/o/:slug/ask` and the dev replay (`GET …/ai/ask-replay/<scenario>`) answer `text/event-stream`:
// `event: <name>` + `data: <json>` per message, a blank line between (shared/ai-ask-core.ts › The stream).
// `SseParser` turns chunks of that text into messages (a message may arrive split across chunks), and
// `askEventOf` checks one against the contract's shapes — the browser bundle carries no zod, so these are
// light structural guards, pinned against every recorded transcript by test/render.ask-stream.test.ts.

import { ASK_EVENTS, type AskEvent, type AskEventName } from "@shared/ai-ask-core";

export interface SseMessage { event: string; data: string }

/** Incremental `text/event-stream` parser: push text as it arrives, get whole messages back. */
export class SseParser {
  private buf = "";
  push(chunk: string): SseMessage[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const out: SseMessage[] = [];
    let at: number;
    while ((at = this.buf.indexOf("\n\n")) >= 0) {
      const raw = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 2);
      const m = parseBlock(raw);
      if (m) out.push(m);
    }
    return out;
  }
  /** Whatever is left once the stream closed (a final message with no blank line after it). */
  flush(): SseMessage[] {
    const raw = this.buf.trim();
    this.buf = "";
    const m = raw ? parseBlock(raw) : null;
    return m ? [m] : [];
  }
}

function parseBlock(raw: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** The structural check per event (the zod schemas, `AskEventSchemas` in shared/ai-ask.ts, are the server's). */
const SHAPE: Record<AskEventName, (d: Record<string, unknown>) => boolean> = {
  thread: (d) => isNum(d.id) && isStr(d.title) && isStr(d.mode) && typeof d.auto === "boolean" && isStr(d.origin),
  thinking: (d) => d.state === "run" || (d.state === "done" && isNum(d.seconds) && isStr(d.summary)),
  activity: (d) => isNum(d.step) && (
    (d.state === "run" && isStr(d.tool) && isStr(d.icon) && isStr(d.label))
    || (d.state === "done" && (d.results === undefined || isStrArr(d.results)) && (d.resultLine === undefined || isStr(d.resultLine)))),
  text: (d) => isStr(d.delta),
  block: (d) => isStr(d.kind),
  action: (d) => isNum(d.id) && isStr(d.tool) && isStr(d.kind) && isObj(d.preview) && isObj(d.fields) && isStrArr(d.editable)
    && (d.state === "proposed" || d.state === "waiting"),
  action_result: (d) => isNum(d.id) && isStr(d.state) && typeof d.undo === "boolean" && isStr(d.at),
  artifact_saved: (d) => isStr(d.slug) && isStr(d.title) && isStr(d.visibility) && isStr(d.url),
  followups: (d) => isStrArr(d.items),
  done: (d) => isNum(d.messageId) && Array.isArray(d.cites) && isObj(d.tokens),
  error: (d) => isStr(d.code) && isStr(d.message),
};

/** One SSE message as a typed Ask event, or null when it is not one (unknown name, bad JSON, wrong shape). */
export function askEventOf(m: SseMessage): AskEvent | null {
  if (!(ASK_EVENTS as readonly string[]).includes(m.event)) return null;
  let data: unknown;
  try { data = JSON.parse(m.data); } catch { return null; }
  if (!isObj(data) || !SHAPE[m.event as AskEventName](data)) return null;
  return { event: m.event, data } as AskEvent;
}

/** Read a `text/event-stream` response to its end, handing each Ask event to `onEvent`. Resolves when the
 *  stream closes; rejects with the abort if `signal` fires (the caller's Stop). Malformed messages are skipped. */
export async function readAskStream(res: Response, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parser = new SseParser();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      for (const m of parser.push(dec.decode(value, { stream: true }))) {
        const e = askEventOf(m);
        if (e) onEvent(e);
      }
    }
    for (const m of parser.push(dec.decode())) { const e = askEventOf(m); if (e) onEvent(e); }
    for (const m of parser.flush()) { const e = askEventOf(m); if (e) onEvent(e); }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
