/**
 * Ask Trov's reading pace (web/src/ask-pace.ts): Smart and Thinking hold back the words they write after a tool
 * result and send them as one burst; the pacer lets them out a few words a frame, keeps every other event in its
 * place behind them, and never changes what the answer ends up as (every recorded transcript folds the same).
 */
import { describe, it, expect } from "vitest";
import { AskPacer, ASK_PACE, cutAt, type PaceClock } from "../web/src/ask-pace";
import { SseParser, askEventOf } from "../web/src/ask-sse";
import { newTurn, foldAskEvent, turnLive, turnText, type AskTurn } from "../web/src/ask-stream";
import type { AskEvent } from "@shared/ai-ask-core";

/** A clock the test turns: `step()` advances one 16 ms frame and runs what was scheduled for it. */
function manualClock() {
  let t = 1000;
  let queued: (() => void)[] = [];
  const clock: PaceClock = { now: () => t, frame: (f) => { queued.push(f); } };
  return {
    clock,
    get queued() { return queued.length; },
    step(ms = 16) { t += ms; const q = queued; queued = []; for (const f of q) f(); },
  };
}

const text = (delta: string): AskEvent => ({ event: "text", data: { delta } });
const done: AskEvent = { event: "done", data: { messageId: 7, questionId: 6, cites: [], tokens: { in: 1, out: 1, cached: 0 } } };
const activity: AskEvent = { event: "activity", data: { step: 1, tool: "list_tickets", icon: "tickets", label: "Listed tickets", state: "run" } };
const block: AskEvent = { event: "block", data: { kind: "not_found", query: "x", tries: [] } } as unknown as AskEvent;

const BURST = "Three tickets are in progress right now. Ticket fourteen is the streaming work, which Andres owns; "
  + "twenty-one is the Repo screen redesign with Meilin; thirty-three is the pricing page polish with Sana. "
  + "All three moved in the last two days, and none of them is blocked on review yet.";

describe("the pace — a burst becomes a stream", () => {
  it("a burst that arrives with done in one go is let out over many frames, word by word, and done goes LAST", () => {
    const c = manualClock();
    const got: AskEvent[] = [];
    const p = new AskPacer((e) => got.push(e), c.clock);
    p.push(text(BURST));
    p.push(done);
    expect(got).toEqual([]);                       // nothing painted in the same tick the burst landed
    c.step();
    expect(got).toHaveLength(1);
    expect(got[0].event).toBe("text");
    const first = (got[0] as Extract<AskEvent, { event: "text" }>).data.delta;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(BURST.length / 4);
    expect(first.length).toBeLessThan(12);          // a few characters, not a word's jump
    let frames = 1;
    while (p.pending && frames < 1000) { c.step(); frames++; }
    expect(got.at(-1)).toBe(done);
    expect(got.filter((e) => e.event === "text").map((e) => (e as Extract<AskEvent, { event: "text" }>).data.delta).join("")).toBe(BURST);
    // Spread out at the reading pace: about the burst's length at maxCps, never much longer.
    expect(frames).toBeGreaterThan(20);
    expect(frames * 16).toBeLessThan((BURST.length / ASK_PACE.maxCps) * 1000 * 1.15 + 100);
  });

  it("a delta paints before done: folded as it goes out, the answer has words while it is still live", () => {
    const c = manualClock();
    let turn: AskTurn = newTurn("smart");
    const p = new AskPacer((e) => { turn = foldAskEvent(turn, e, 0); }, c.clock);
    p.push(text(BURST));
    p.push(done);
    c.step();
    expect(turnText(turn).length).toBeGreaterThan(0);
    expect(turnLive(turn)).toBe(true);
    while (p.pending) c.step();
    expect(turnText(turn)).toBe(BURST);
    expect(turn.done).toBe(true);
  });

  it("steps and thinking go out at once when no words wait in front of them; behind words, they keep their place", () => {
    const c = manualClock();
    const got: string[] = [];
    const p = new AskPacer((e) => got.push(e.event === "text" ? `text:${e.data.delta}` : e.event), c.clock);
    p.push(activity);
    expect(got).toEqual(["activity"]);
    p.push(text("Here is the chart."));
    p.push(block);
    p.push(text(" And a closing line."));
    p.push(done);
    expect(got).toEqual(["activity"]);
    while (p.pending) c.step();
    const order = got.map((g) => (g.startsWith("text:") ? "text" : g)).filter((g, i, a) => g !== a[i - 1]);
    expect(order).toEqual(["activity", "text", "block", "text", "done"]);
  });

  it("a fast stream is written out at the ceiling — never faster than maxCps, never slower than minCps", () => {
    const c = manualClock();
    const got: string[] = [];
    const p = new AskPacer((e) => { if (e.event === "text") got.push(e.data.delta); }, c.clock);
    const word = "word ";
    let sent = 0;
    for (let f = 0; f < 120; f++) {           // ~2 s at 60 fps, 3 words a frame (~940 chars a second)
      for (let k = 0; k < 3; k++) { p.push(text(word)); sent += word.length; }
      c.step();
    }
    const shown = got.join("").length;
    const secs = 120 / 60;
    // The owner's steady reading pace: ~940 chars a second arrive, at most maxCps (+ one word's rounding) go out.
    expect(shown).toBeLessThanOrEqual(ASK_PACE.maxCps * secs + word.length);
    expect(shown).toBeGreaterThanOrEqual(ASK_PACE.minCps * secs - word.length);
    expect(sent - shown).toBeGreaterThan(0);
  });

  it("Stop: flush puts everything received on screen at once, in order, and idle resolves", async () => {
    const c = manualClock();
    const got: AskEvent[] = [];
    const p = new AskPacer((e) => got.push(e), c.clock);
    p.push(text(BURST));
    p.push(done);
    c.step();
    const idle = p.idle();
    p.flush();
    await idle;
    expect(p.pending).toBe(false);
    expect(got.at(-1)).toBe(done);
    expect(got.filter((e) => e.event === "text").map((e) => (e as Extract<AskEvent, { event: "text" }>).data.delta).join("")).toBe(BURST);
  });

  it("an unclosed [[ at the very end waits for the rest — until the stream is over (close), so it never hangs", () => {
    const c = manualClock();
    const got: string[] = [];
    const p = new AskPacer((e) => { if (e.event === "text") got.push(e.data.delta); }, c.clock);
    p.push(text("See [[ticket:1"));
    for (let i = 0; i < 30; i++) c.step();
    expect(got.join("")).toBe("See ");
    p.push(text("4]] now."));
    for (let i = 0; i < 30 && p.pending; i++) c.step();
    expect(got.join("")).toBe("See [[ticket:14]] now.");
    p.push(text(" Broken [[tick"));
    p.close();
    for (let i = 0; i < 60 && p.pending; i++) c.step();
    expect(p.pending).toBe(false);
    expect(got.join("")).toBe("See [[ticket:14]] now. Broken [[tick");
  });

  it("no clock (tests, the build, reduced motion) or a hidden tab: every event goes out as it arrives", () => {
    const got: AskEvent[] = [];
    const p = AskPacer.passthrough((e) => got.push(e));
    p.push(text(BURST));
    p.push(done);
    expect(got).toEqual([text(BURST), done]);
    const hiddenGot: AskEvent[] = [];
    const hidden = new AskPacer((e) => hiddenGot.push(e), { now: () => 0, frame: () => undefined, instant: () => true });
    hidden.push(text(BURST));
    hidden.push(done);
    expect(hiddenGot).toEqual([text(BURST), done]);
  });

  it("the defaults: a backlog drains on a 600 ms curve, between 70 and 120 characters a second; a step shows 350 ms", () => {
    expect(ASK_PACE).toEqual({ tauMs: 600, minCps: 70, maxCps: 120, stepMs: 350 });
  });

  it("steps appear as they go: each shows running for stepMs, then finishes, then the next starts — what follows waits", () => {
    const c = manualClock();
    const got: string[] = [];
    const p = new AskPacer((e) => got.push(e.event === "activity" ? `${e.data.step}:${e.data.state}` : e.event), c.clock);
    // The tools ran in a few ms: four step events and the text arrive at once.
    for (const e of [
      { event: "activity", data: { step: 1, tool: "search_tickets", icon: "search", label: "Searched tickets", state: "run" } },
      { event: "activity", data: { step: 1, state: "done", results: [] } },
      { event: "activity", data: { step: 2, tool: "get_ticket", icon: "read", label: "Read ticket #87", state: "run" } },
      { event: "activity", data: { step: 2, state: "done", results: [] } },
      { event: "text", data: { delta: "Two things. " } },
    ] as AskEvent[]) p.push(e);
    expect(got).toEqual(["1:run"]);                       // the first step at once
    const at = (ms: number) => { while (c.clock.now() < 1000 + ms) c.step(); };
    at(200); expect(got).toEqual(["1:run"]);             // still running
    at(380); expect(got).toEqual(["1:run", "1:done", "2:run"]);
    at(600); expect(got).toEqual(["1:run", "1:done", "2:run"]);
    at(760); expect(got.slice(0, 4)).toEqual(["1:run", "1:done", "2:run", "2:done"]);
    while (p.pending) c.step();
    expect(got.at(-1)).toBe("text");
    // A quiet step (a show_* tool) takes no time on screen.
    const q: string[] = [];
    const p2 = new AskPacer((e) => q.push(e.event === "activity" ? `${e.data.step}:${e.data.state}` : e.event), manualClock().clock);
    p2.push({ event: "activity", data: { step: 1, tool: "show_items", icon: "search", label: "", state: "run" } } as AskEvent);
    p2.push({ event: "activity", data: { step: 1, state: "done" } } as AskEvent);
    expect(q).toEqual(["1:run", "1:done"]);
  });
});

describe("cutAt — where a frame's text ends", () => {
  it("character by character (a steady flow, not word jumps), never inside a surrogate pair", () => {
    expect(cutAt("Hello there world", 2)).toBe(2);
    expect(cutAt("Hello there world", 6)).toBe(6);
    expect(cutAt("short", 99)).toBe(5);
    expect(cutAt("ok 👍 yes", 4)).toBe(5);             // the emoji is two code units: never half of it
  });
  it("never splits a [[ref]] token: through its ]] when here, else up to its [[", () => {
    expect(cutAt("See [[ticket:14]] now", 7)).toBe("See [[ticket:14]]".length);
    expect(cutAt("See [[ticket:1", 7)).toBe(4);
    expect(cutAt("[[ticket:1", 3)).toBe(0);
    expect(cutAt("[[a]] and [[b]] end", 12)).toBe("[[a]] and [[b]]".length);
  });
});

describe("every recorded transcript folds to the same answer through the pacer", () => {
  const files = import.meta.glob("../docs/superpowers/specs/ask-transcripts/**/*.sse", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const all = Object.entries(files);
  it("finds the transcripts", () => { expect(all.length).toBeGreaterThan(3); });
  for (const [path, raw] of all) {
    it(path.replace(/^.*ask-transcripts\//, ""), () => {
      const p0 = new SseParser();
      const events = [...p0.push(raw), ...p0.flush()].map(askEventOf).filter((e): e is AskEvent => e !== null);
      let direct = newTurn("smart");
      for (const e of events) direct = foldAskEvent(direct, e, 0);
      const c = manualClock();
      let paced = newTurn("smart");
      const p = new AskPacer((e) => { paced = foldAskEvent(paced, e, 0); }, c.clock);
      for (const e of events) p.push(e);    // the whole transcript as one burst
      p.close();
      for (let i = 0; i < 5000 && p.pending; i++) c.step();
      expect(p.pending).toBe(false);
      expect(paced).toEqual(direct);
    });
  }
});
