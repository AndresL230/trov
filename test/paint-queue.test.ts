/**
 * When the app paints (web/src/paint-queue.ts; web-ui.md › Paints: now, batched, or once a frame).
 * `now()` is the interactive paint and runs at once; `batch(fn)` folds what `fn` asks for into one
 * paint made before it returns; `soon()` (a read landing) shares one paint per frame, with a timeout
 * where a frame never comes (a hidden tab, no rAF). The boot simulation at the end replays main.ts's
 * boot — the reads `enterOrg` and My Work start, each painting when it starts and when it lands —
 * and counts the paints.
 */
import { describe, expect, it } from "vitest";
import { createPaintQueue, type PaintScheduler } from "../web/src/paint-queue";
import mainSrc from "../web/src/main.ts?raw";

/** A hand-driven scheduler: frames and timeouts run only when the test says so. */
function fakeScheduler(opts: { raf?: boolean; hidden?: boolean } = {}) {
  let next = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; ms: number }>();
  const sched: PaintScheduler = {
    raf: opts.raf === false ? undefined : (cb) => { const id = next++; frames.set(id, cb); return id; },
    cancelRaf: opts.raf === false ? undefined : (id) => { frames.delete(id); },
    timeout: (cb, ms) => { const id = next++; timers.set(id, { cb, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id as number); },
    hidden: () => opts.hidden === true,
  };
  return {
    sched,
    frames,
    timers,
    frame() { const all = [...frames.values()]; frames.clear(); all.forEach((f) => f()); },
    tick() { const all = [...timers.values()]; timers.clear(); all.forEach((t) => t.cb()); },
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
  // starts (its "loading" state) and when it lands; a screen's IfNeeded loader paints once more.
  // Before the paint queue every one of those was a full-app paint.
  const BOOT_READS = [
    "orgMe", "myOrgs", "sync", "mywork", "proposals", "draftAdrs", "sprints", "mwSessions", "handoffs",
    "repo", "mwDocs", "artifacts", "needsTriage", "identityTasks", "ticketBadge", "prompts", "persons", "tags",
  ];
  /** Replay the boot: the start (synchronous) and the landings (in `waves` bursts, one frame each). */
  function boot(q: ReturnType<typeof createPaintQueue>, f: ReturnType<typeof fakeScheduler>, opts: { batched: boolean; waves: number }): void {
    const start = () => {
      for (let i = 0; i < BOOT_READS.length; i++) q.now(); // each loader's "loading" paint
      q.now(); // loadMyWorkIfNeeded's own paint
    };
    if (opts.batched) q.batch(start); else start();
    const perWave = Math.ceil(BOOT_READS.length / opts.waves);
    for (let w = 0; w < opts.waves; w++) {
      for (const _ of BOOT_READS.slice(w * perWave, (w + 1) * perWave)) { if (opts.batched) q.soon(); else q.now(); }
      f.frame();
    }
  }

  it("unbatched (the old behaviour) it is one paint per start and per landing", () => {
    const f = fakeScheduler();
    const q = createPaintQueue(() => undefined, f.sched);
    boot(q, f, { batched: false, waves: 4 });
    expect(q.paints).toBeGreaterThanOrEqual(25);
  });

  it("batched, it is one paint for the start and one per frame in which reads land", () => {
    const f = fakeScheduler();
    const q = createPaintQueue(() => undefined, f.sched);
    boot(q, f, { batched: true, waves: 4 });
    expect(q.paints).toBe(5);
    expect(q.paints).toBeLessThan(8);
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
