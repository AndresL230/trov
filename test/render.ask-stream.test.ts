/**
 * Ask Trov's client contract: the SSE reader (web/src/ask-sse.ts) and the conversation reducer
 * (web/src/ask-stream.ts), run against EVERY recorded transcript in docs/superpowers/specs/ask-transcripts/
 * (the design's scenarios and the three live answers). If the server's events change shape, these fail.
 */
import { describe, it, expect } from "vitest";
import { SseParser, askEventOf, readAskStream } from "../web/src/ask-sse";
import {
  newTurn, foldAskEvent, foldThreadEvent, emptyConvo, stopTurn, failTurn, turnLive, turnPhase, shownParts, turnText, withLastTurn,
  type AskTurn, type AskConvo,
} from "../web/src/ask-stream";
import type { AskEvent } from "@shared/ai-ask-core";

const files = import.meta.glob("../docs/superpowers/specs/ask-transcripts/**/*.sse", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const transcripts = Object.entries(files).map(([path, raw]) => ({ name: path.replace(/^.*ask-transcripts\//, ""), raw }));

function eventsOf(raw: string, chunk = 0): AskEvent[] {
  const p = new SseParser();
  const msgs = chunk > 0
    ? [...Array.from({ length: Math.ceil(raw.length / chunk) }, (_, i) => p.push(raw.slice(i * chunk, (i + 1) * chunk))).flat(), ...p.flush()]
    : [...p.push(raw), ...p.flush()];
  return msgs.map((m) => {
    const e = askEventOf(m);
    expect(e, `not an Ask event: ${m.event} ${m.data.slice(0, 80)}`).not.toBeNull();
    return e!;
  });
}

function fold(events: AskEvent[]): { turn: AskTurn; threadId: number | null } {
  let c: AskConvo = { ...emptyConvo(), messages: [{ role: "assistant", key: "a1", turn: newTurn("smart") }] };
  for (const e of events) {
    if (e.event === "thread") c = foldThreadEvent(c, e.data);
    else c = withLastTurn(c, (t) => foldAskEvent(t, e, 0));
  }
  const a = c.messages[0];
  return { turn: a.role === "assistant" ? a.turn : newTurn("smart"), threadId: c.threadId };
}

describe("Ask transcripts — the client reads every recorded stream", () => {
  it("finds the design's scenarios and the three live answers", () => {
    const names = transcripts.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const n of ["answer.sse", "streaming.sse", "thinking.sse", "actions-ask.sse", "actions-auto.sse", "artifact-saved.sse", "cmdj.sse", "notfound.sse", "live/fast.sse", "live/smart.sse", "live/thinking.sse"]) {
      expect(names).toContain(n);
    }
  });

  for (const { name, raw } of transcripts) {
    describe(name, () => {
      const events = eventsOf(raw);

      it("every message is a well-formed Ask event, whole or split at any chunk size", () => {
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].event).toBe("thread");
        for (const size of [1, 7, 64, 1000]) expect(eventsOf(raw, size)).toEqual(events);
      });

      it("folds into one answer that says what the stream said", () => {
        const { turn, threadId } = fold(events);
        const thread = events.find((e) => e.event === "thread")!;
        expect(threadId).toBe((thread.data as { id: number }).id);
        // Text: every delta, in order (blocks and cards split it into parts, never lose a word).
        const text = events.filter((e) => e.event === "text").map((e) => (e.data as { delta: string }).delta).join("");
        expect(turnText(turn)).toBe(text);
        expect(turn.parts.filter((p) => p.kind === "block").length).toBe(events.filter((e) => e.event === "block").length);
        // Cards: one per id, whatever order `action` / `action_result` came in.
        const ids = new Set(events.filter((e) => e.event === "action" || e.event === "action_result").map((e) => (e.data as { id: number }).id));
        expect(Object.keys(turn.actions).map(Number).sort()).toEqual([...ids].sort());
        expect(turn.parts.filter((p) => p.kind === "action").length).toBe(ids.size);
        const fu = events.filter((e) => e.event === "followups").pop();
        expect(turn.followups).toEqual(fu ? (fu.data as { items: string[] }).items : []);
        // Steps: every one that ran is listed once, in order.
        const steps = [...new Set(events.filter((e) => e.event === "activity").map((e) => (e.data as { step: number }).step))];
        expect(turn.activity.map((s) => s.step)).toEqual(steps);
        const done = events.find((e) => e.event === "done");
        if (done) {
          expect(turn.done).toBe(true);
          expect(turnLive(turn)).toBe(false);
          expect(turn.messageId).toBe((done.data as { messageId: number }).messageId);
          expect(turn.activity.every((s) => s.state === "done")).toBe(true);
          expect(turnPhase(turn)).toBe(turn.stopped ? "stopped" : "done");
        } else {
          // `streaming` is cut mid-answer on purpose: still live, and a dropped connection ends it as an error.
          expect(turnLive(turn)).toBe(true);
          expect(failTurn(turn).error?.code).toBe("failed");
          const stopped = stopTurn(turn);
          expect(stopped.stopped).toBe(true);
          expect(stopped.activity.every((s) => s.state === "done")).toBe(true);
        }
        if (events.some((e) => e.event === "thinking")) expect(turn.thinking?.state).toBe("done");
        if (events.some((e) => e.event === "artifact_saved")) expect(turn.saved.length).toBe(1);
        // What the screen draws: every part is shown, cards of one group together.
        const shown = shownParts(turn);
        const cards = shown.filter((p) => p.kind === "actions").flatMap((p) => (p.kind === "actions" ? p.ids : []));
        expect(cards.sort()).toEqual([...ids].sort());
      });
    });
  }
});

describe("readAskStream — a real Response, chunked; Stop aborts", () => {
  const raw = files["../docs/superpowers/specs/ask-transcripts/answer.sse"];
  const respond = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(ctl) { const enc = new TextEncoder(); for (const c of chunks) ctl.enqueue(enc.encode(c)); ctl.close(); },
  }));

  it("hands every event over, whatever the chunking", async () => {
    const got: AskEvent[] = [];
    await readAskStream(respond(raw.match(/[\s\S]{1,333}/g) ?? []), (e) => got.push(e));
    expect(got).toEqual(eventsOf(raw));
  });

  it("skips a message that is not an Ask event instead of failing the answer", async () => {
    const got: AskEvent[] = [];
    await readAskStream(respond([`event: nonsense\ndata: {}\n\n`, `event: text\ndata: {not json\n\n`, `event: text\ndata: {"delta":"hi"}\n\n`]), (e) => got.push(e));
    expect(got).toEqual([{ event: "text", data: { delta: "hi" } }]);
  });

  it("rejects with an AbortError when the signal fires (Stop)", async () => {
    const ctl = new AbortController();
    const res = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(`event: text\ndata: {"delta":"a"}\n\n`)); },
    }));
    const p = readAskStream(res, () => ctl.abort(), ctl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
