/**
 * When the app paints (web/src/paint-queue.ts; web-ui.md › Paints: now, batched, or once a frame).
 * `now()` is the interactive paint and runs at once; `batch(fn)` folds what `fn` asks for into one
 * paint made before it returns; `soon()` (a read landing) shares one paint per frame — no sooner than
 * SOON_GAP_MS after the last landing or batch paint — with a timeout where a frame never comes (a
 * hidden tab, no rAF). The boot simulation at the end replays main.ts's
 * boot — the reads `enterOrg` and My Work start, each painting when it starts and when it lands —
 * and counts the paints.
 */
import { describe, expect, it } from "vitest";
import { createPaintQueue, SOON_GAP_MS, type PaintScheduler } from "../web/src/paint-queue";
import mainSrc from "../web/src/main.ts?raw";

/** A hand-driven scheduler on a fake clock: frames and timeouts run only when the test says so —
 *  `frame()` / `tick()` run every one waiting, `advance(ms)` moves the clock and runs what is due
 *  (timeouts first, then a frame, as a browser would within that time). */
function fakeScheduler(opts: { raf?: boolean; hidden?: boolean } = {}) {
  let next = 1;
  let clock = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; ms: number; due: number }>();
  const sched: PaintScheduler = {
    raf: opts.raf === false ? undefined : (cb) => { const id = next++; frames.set(id, cb); return id; },
    cancelRaf: opts.raf === false ? undefined : (id) => { frames.delete(id); },
    timeout: (cb, ms) => { const id = next++; timers.set(id, { cb, ms, due: clock + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    hidden: () => opts.hidden === true,
    now: () => clock,
  };
  const runFrames = () => { const all = [...frames.values()]; frames.clear(); all.forEach((f) => f()); };
  return {
    sched,
    frames,
    timers,
    frame: runFrames,
    tick() { const all = [...timers.values()]; timers.clear(); all.forEach((t) => t.cb()); },
    advance(ms: number) {
      clock += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.due <= clock);
        if (!due.length) break;
        for (const [id, t] of due) { timers.delete(id); t.cb(); }
      }
      runFrames();
    },
  };
}

describe("paint queue", () => {
  it("now() paints at once, every time", () => {
    let n = 0;
    const q = createPaintQueue(() => { n++; }, fakeScheduler().sched);
    q.now(); q.now();
    expect(n).toBe(2);
    expect(q.paints).toBe(2);
  });

  it("soon() paints once on the next frame, however many reads land before it", () => {
    let n = 0;
    const f = fakeScheduler();
    const q = createPaintQueue(() => { n++; }, f.sched);
    q.soon(); q.soon(); q.soon();
    expect(n).toBe(0);
    expect(q.pending).toBe(true);
    f.frame();
    expect(n).toBe(1);
    expect(q.pending).toBe(false);
    // The frame's backstop timeout was cleared with it: nothing paints twice.
    f.tick();
    expect(n).toBe(1);
  });

  it("a visible tab that goes hidden before the frame still paints, on the backstop timeout", () => {
    let n = 0;
    const f = fakeScheduler();
    const q = createPaintQueue(() => { n++; }, f.sched);
    q.soon();
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([100]);
    f.tick();
    expect(n).toBe(1);
    f.frame();
    expect(n).toBe(1);
  });

  it("a hidden tab, or no requestAnimationFrame, paints on a timeout instead of a frame", () => {
    for (const opts of [{ hidden: true }, { raf: false }]) {
      let n = 0;
      const f = fakeScheduler(opts);
      const q = createPaintQueue(() => { n++; }, f.sched);
      q.soon(); q.soon();
      expect(f.frames.size).toBe(0);
      expect([...f.timers.values()].map((t) => t.ms)).toEqual([0]);
      f.tick();
      expect(n).toBe(1);
    }
  });

  it("a paint made now takes the place of a waiting soon()", () => {
    let n = 0;
    const f = fakeScheduler();
    const q = createPaintQueue(() => { n++; }, f.sched);
    q.soon();
    q.now();
    expect(n).toBe(1);
    expect(q.pending).toBe(false);
    f.frame(); f.tick();
    expect(n).toBe(1);
  });

  it("a landing right after a paint waits out the gap, then takes the next frame", () => {
    let n = 0;
    const f = fakeScheduler();
    const q = createPaintQueue(() => { n++; }, f.sched);
    q.batch(() => q.now());                  // a batch's paint at t=0
    q.soon(); q.soon();
    f.advance(16);
    expect(n).toBe(1);                       // still inside the 100 ms gap
    f.advance(SOON_GAP_MS);
    expect(n).toBe(2);
    q.soon();                                // the gap runs from that paint
    f.advance(16);
    expect(n).toBe(2);
    f.advance(SOON_GAP_MS);
    expect(n).toBe(3);
  });

  it("an interactive paint does not hold a landing back", () => {
    let n = 0;
    const f = fakeScheduler();
    const q = createPaintQueue(() => { n++; }, f.sched);
    q.now();                                 // a keystroke's paint
    q.soon();                                // the search results land
    f.advance(16);
    expect(n).toBe(2);
  });

  it("batch() folds every paint asked for inside it into one, made before it returns", () => {
    let n = 0;
    const f = fakeScheduler();
    const q = createPaintQueue(() => { n++; }, f.sched);
    const out = q.batch(() => {
      q.now(); q.soon(); q.now();
      q.batch(() => { q.now(); });   // nested: still the outer batch's one paint
      expect(n).toBe(0);
      return 42;
    });
    expect(out).toBe(42);
    expect(n).toBe(1);
    expect(q.pending).toBe(false);
  });

  it("a batch that asks for nothing paints nothing", () => {
    let n = 0;
    const q = createPaintQueue(() => { n++; }, fakeScheduler().sched);
    q.batch(() => undefined);
    expect(n).toBe(0);
  });

  it("a batch that throws still paints what it asked for", () => {
    let n = 0;
    const q = createPaintQueue(() => { n++; }, fakeScheduler().sched);
    expect(() => q.batch(() => { q.now(); throw new Error("x"); })).toThrow("x");
    expect(n).toBe(1);
  });
});

describe("the boot paints a handful of times, not once per read", () => {
  // main.ts's boot as it stands: `enterOrg` on My Work starts these reads. Each read paints when it
  // starts (its "loading" state) and when it lands; My Work's IfNeeded loader paints once more.
  // Before the paint queue every one of those was a full-app paint (27, counted in a browser).
  const BOOT_READS = [
    "orgMe", "myOrgs", "sync", "mywork", "proposals", "draftAdrs", "sprints", "mwSessions", "handoffs",
    "repo", "mwDocs", "artifacts", "needsTriage", "identityTasks", "ticketBadge", "prompts", "persons", "tags",
  ];
  /** Replay the boot: the starts (synchronous), then one landing every `spacing` ms, on 16 ms frames. */
  function boot(opts: { batched: boolean; spacing: number }): number {
    const f = fakeScheduler();
    const q = createPaintQueue(() => undefined, f.sched);
    const start = () => {
      for (let i = 0; i < BOOT_READS.length; i++) q.now(); // each loader's "loading" paint
      q.now(); // loadMyWorkIfNeeded's own paint
    };
    if (opts.batched) q.batch(start); else start();
    let t = 0;
    for (let i = 0; i < BOOT_READS.length; i++) {
      const at = (i + 1) * opts.spacing;
      while (t + 16 <= at) { f.advance(16); t += 16; }
      if (opts.batched) q.soon(); else q.now();
    }
    for (let i = 0; i < 20; i++) f.advance(16);
    expect(q.pending).toBe(false);
    return q.paints;
  }

  it("unbatched (the old behaviour) it is one paint per start and per landing", () => {
    expect(boot({ batched: false, spacing: 45 })).toBeGreaterThanOrEqual(25);
  });

  it("batched: one paint for the starts, and landings share a paint per frame, at most one per gap", () => {
    // Landings spread out (a Worker answering one every 45 ms): one paint per gap at most, over the
    // whole span — in a browser against `wrangler dev` this boot measured 4–5 paints (27 before).
    const spacing = 45;
    const spread = boot({ batched: true, spacing });
    expect(spread).toBeLessThanOrEqual(1 + Math.ceil((BOOT_READS.length * spacing) / SOON_GAP_MS));
    expect(spread).toBeLessThan(boot({ batched: false, spacing }) / 2);
    // Landings in a burst (all within a frame or two): two paints.
    expect(boot({ batched: true, spacing: 0 })).toBe(2);
  });
});

describe("main.ts uses the queue where it should", () => {
  const src = mainSrc;
  const body = (name: string): string => {
    const at = src.indexOf(`function ${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", at);
    return src.slice(at, end);
  };

  it("the boot and a screen's loads are batched", () => {
    expect(body("enterOrg")).toContain("batchRender(() => enterOrgNow(slug, hash))");
    expect(body("loadForScreen")).toContain("batchRender(() => startScreenLoads(screen))");
  });

  it("a read's landing paints soon; its start and the interactive paints stay immediate", () => {
    for (const name of ["loadMyWork", "loadHandoffs", "loadPrompts", "loadProposals", "loadPersons", "loadRepo", "loadOrgMe"]) {
      const b = body(name);
      const chain = b.slice(b.search(/\.then\(/));
      expect(chain, name).toContain("rerenderSoon()");
      // An expired session still leaves at once.
      for (const line of chain.split("\n").filter((l) => l.includes("Unauthorized") && l.includes("rerender"))) {
        expect(line, name).not.toContain("rerenderSoon");
      }
    }
    // The paint itself is reached only through the queue.
    expect(src).toContain("const paints = createPaintQueue(() => paintApp());");
    expect(src).toMatch(/function rerender\(\): void \{ paints\.now\(\); \}/);
  });
});
