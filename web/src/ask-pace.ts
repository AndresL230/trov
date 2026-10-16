// Ask Trov — the answer's reading pace (docs/architecture/ask.md › The stream). Pure: no DOM; the clock is injected.
//
// Why: the server forwards the model's text deltas as they come, but Smart (Sonnet) and Thinking (Opus) hold back the
// text they write AFTER a tool result until they know it is the answer and not a progress note before another tool
// call — so an answer that follows a search can arrive as ONE burst (hundreds of characters in a few milliseconds),
// and painting it as it lands puts the whole answer on screen at once. The pacer sits between the stream and the
// fold: text goes out a few words per frame, quickly when a lot is waiting (the wait is never more than about
// `tauMs` behind plus the floor's tail) and at least `minCps` characters a second; whatever came after the text (a
// block, a card, `followups`, `done`) waits its turn, so the answer keeps the order it streamed in and the footer
// comes once the words are out.
//
//   • Events with no text waiting in front of them go out at once (steps, thinking, the thread) — no delay.
//   • A cut never splits a word, nor a `[[ref]]` token (it would flash as raw brackets).
//   • `flush()` sends everything now: Stop, an error, a new thread — what was received is what the stored answer has.
//   • No scheduler (tests, the build) or reduced motion: `AskPacer.passthrough` — every event goes out as it arrives.

import type { AskEvent } from "@shared/ai-ask-core";

export interface PaceClock {
  now(): number;
  /** Run `f` at the next frame. */
  frame(f: () => void): void;
  /** Nobody is watching (a hidden tab, where frames stop): deliver at once instead of pacing. */
  instant?(): boolean;
}

export interface PaceOpts {
  /** How fast a backlog drains: each frame releases `1 - e^(-dt/tau)` of what waits. */
  tauMs: number;
  /** The floor, in characters a second (the tail of a backlog, a slow stream). */
  minCps: number;
}
export const ASK_PACE: PaceOpts = { tauMs: 600, minCps: 240 };

type Item = { text: string } | { e: AskEvent };

export class AskPacer {
  private q: Item[] = [];
  /** The stream ended: nothing more comes, so the last words need not wait for their end. */
  private closed = false;
  private last = 0;
  private scheduled = false;
  private credit = 0;
  private waiters: (() => void)[] = [];

  /** `clock` null: no pacing, every event is delivered as it arrives. */
  constructor(private deliver: (e: AskEvent) => void, private clock: PaceClock | null, private opts: PaceOpts = ASK_PACE) {}

  static passthrough(deliver: (e: AskEvent) => void): AskPacer { return new AskPacer(deliver, null); }

  /** Something is still waiting to go out. */
  get pending(): boolean { return this.q.length > 0; }

  push(e: AskEvent): void {
    if (!this.clock) { this.deliver(e); return; }
    if (this.clock.instant?.()) { this.flush(); this.deliver(e); return; }
    if (e.event === "text") {
      if (!e.data.delta) return;
      const tail = this.q[this.q.length - 1];
      if (tail && "text" in tail) tail.text += e.data.delta; else this.q.push({ text: e.data.delta });
      this.schedule();
      return;
    }
    if (!this.q.length) { this.deliver(e); return; }
    this.q.push({ e });
    this.schedule();
  }

  /** Deliver everything now (Stop, an error, the conversation going away). */
  flush(): void {
    const q = this.q;
    this.q = [];
    this.credit = 0;
    for (const it of q) this.deliver("text" in it ? { event: "text", data: { delta: it.text } } : it.e);
    this.settle();
  }

  /** The stream is over: what waits drains at its pace (an unfinished `[[` at the very end no longer holds it). */
  close(): void {
    this.closed = true;
    this.schedule();
  }

  /** Resolves once nothing waits (at once when nothing does). */
  idle(): Promise<void> {
    return this.q.length ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  /** One frame: release what the time since the last frame allows. Public for tests (the clock's frame calls it). */
  tick(): void {
    this.scheduled = false;
    if (!this.clock || !this.q.length) { this.settle(); return; }
    if (this.clock.instant?.()) { this.flush(); return; }
    const now = this.clock.now();
    const dt = Math.min(Math.max(now - this.last, 0), 100);
    this.last = now;
    const waiting = this.q.reduce((n, it) => n + ("text" in it ? it.text.length : 0), 0);
    this.credit += Math.max(waiting * (1 - Math.exp(-dt / this.opts.tauMs)), (this.opts.minCps * dt) / 1000);
    while (this.q.length) {
      const head = this.q[0];
      if (!("text" in head)) { this.q.shift(); this.deliver(head.e); continue; }
      if (this.credit < 1) break;
      // Text with something after it (or a closed stream) is whole: an unclosed `[[` in it is just text.
      const whole = this.closed || this.q.length > 1;
      const cut = cutAt(head.text, Math.floor(this.credit));
      const n = cut === 0 && whole ? head.text.length : cut;
      if (n === 0) break;
      const out = head.text.slice(0, n);
      head.text = head.text.slice(n);
      this.credit = Math.max(0, this.credit - n);
      if (!head.text) this.q.shift();
      this.deliver({ event: "text", data: { delta: out } });
      if (head.text) break;
    }
    if (this.q.length) this.schedule(); else this.settle();
  }

  private schedule(): void {
    if (this.scheduled || !this.clock) return;
    if (!this.q.length) return;
    this.scheduled = true;
    // The first frame after a quiet spell starts the clock (no credit for the time nothing waited).
    if (!this.last || this.clock.now() - this.last > 100) this.last = this.clock.now();
    this.clock.frame(() => this.tick());
  }

  private settle(): void {
    if (this.q.length) return;
    this.credit = 0;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

/** How many of `text`'s characters to release for a budget of `n`: at least `n`, then on to the end of the word, and
 *  never into the middle of a `[[ref]]` token — through its `]]` when that is here, else up to its `[[` (0 when the
 *  token opens the text: it waits for the rest). */
export function cutAt(text: string, n: number): number {
  let i = Math.min(Math.max(1, n), text.length);
  // On to the end of the word (or the start of the next whitespace run).
  while (i < text.length && !/\s/.test(text[i])) i++;
  // Inside an open `[[…`: through its `]]` when it is here, else stop before it.
  const open = text.lastIndexOf("[[", i - 1);
  if (open >= 0 && text.indexOf("]]", open) < 0) return open;
  if (open >= 0) {
    const close = text.indexOf("]]", open);
    if (close + 2 > i && close >= 0) i = close + 2;
  }
  return Math.min(i, text.length);
}
