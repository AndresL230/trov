/**
 * Roadmap › Timeline — the calendar (web/src/timeline.ts). Pure: sprints, the
 * confirmed set, persons and the clock in → an HTML string out. Assertions are
 * string-based; the clock is injected so every "today" number is deterministic.
 */
import { describe, it, expect } from "vitest";
import { roadmapTimeline, parseStart, placeSprint, timingText, timelineSummary } from "../web/src/timeline";
import type { SprintView } from "../web/src/api";
import { sprintDueState } from "@shared/sprints-core";

function sp(overrides: Partial<SprintView> = {}): SprintView {
  return {
    id: 1, label: "Search GA", summary: null, description: "Ship semantic search.\nSecond line.", phase: null,
    dates: "sep 8 – 19", start: null, due: "2026-09-19", status: "in_progress", active: true, urgency: "normal",
    lead: null, domain: null, github_ref: null, created_at: "2026-09-01T00:00:00Z", created_by: "admin",
    updated_at: null, progress: { closed: 4, total: 6, pct: 67 }, issues: null, members: [],
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 8, 15, 12); // Tue Sep 15 2026, midday (the pool runs in UTC)
const draw = (sprints: SprintView[], extra: Partial<Parameters<typeof roadmapTimeline>[0]> = {}) =>
  roadmapTimeline({ sprints, confirmed: {}, persons: [], now: NOW, ...extra });
const when = (s: SprintView, now = NOW, confirmed: Record<string, boolean> = {}) => timingText(placeSprint(s, confirmed, now)!, now);

describe("parseStart — the start date out of the free-text range", () => {
  const due = Date.UTC(2026, 8, 19);
  it("reads '<month> <day>' in the due date's year", () => {
    expect(parseStart("SEP 8 – 19", due)).toBe(Date.UTC(2026, 8, 8));
    expect(parseStart("may 1 – jun 10", Date.UTC(2026, 5, 10))).toBe(Date.UTC(2026, 4, 1));
  });
  it("rolls back a year when the month/day would land after the due date", () => {
    expect(parseStart("Dec 20 – Jan 9", Date.UTC(2027, 0, 9))).toBe(Date.UTC(2026, 11, 20));
  });
  it("prefers an ISO date, and an explicit year", () => {
    expect(parseStart("2026-09-01 → 2026-09-19", due)).toBe(Date.UTC(2026, 8, 1));
    expect(parseStart("September 3, 2025 – …", due)).toBe(Date.UTC(2025, 8, 3));
  });
  it("returns null for nothing it can read", () => {
    expect(parseStart(null, due)).toBeNull();
    expect(parseStart("next sprint", due)).toBeNull();
  });
});

describe("timingText — whole calendar days against the injected clock", () => {
  it("overdue by N days, counted from the day after the due date", () => {
    expect(when(sp({ due: "2026-09-03", dates: "aug 24 – sep 3", progress: { closed: 1, total: 5, pct: 20 } }))).toBe("12d overdue");
    expect(when(sp({ due: "2026-09-14", dates: null }))).toBe("1d overdue");
  });
  it("due today is not overdue; in progress counts down to the due date", () => {
    expect(when(sp({ due: "2026-09-15", dates: null }))).toBe("due today");
    expect(when(sp({ due: "2026-09-24" }))).toBe("due in 9d");
  });
  it("an upcoming sprint counts down to its start — never to an estimated one", () => {
    const up = { status: "upcoming" as const, active: false };
    expect(when(sp({ ...up, dates: "sep 20 – oct 2", due: "2026-10-02" }))).toBe("starts in 5d");
    expect(when(sp({ ...up, dates: null, due: "2026-10-02" }))).toBe("due in 17d");
  });
  it("done says nothing; all-tickets-closed says so", () => {
    expect(when(sp({ status: "done", active: false }))).toBe("");
    expect(when(sp({ due: "2026-09-01", progress: { closed: 6, total: 6, pct: 100 } }))).toBe("all tickets closed");
  });
});

describe("placeSprint — the real start (0035) first, then the label, then the estimate", () => {
  const up = { status: "upcoming" as const, active: false };
  it("uses sp.start when set, over whatever the dates label says", () => {
    const p = placeSprint(sp({ ...up, start: "2026-09-25", dates: "sep 20 – oct 2", due: "2026-10-02" }), {}, NOW)!;
    expect(p.start).toBe(Date.UTC(2026, 8, 25));
    expect(p.estimated).toBe(false);
    expect(timingText(p, NOW)).toBe("starts in 10d");
  });
  it("a real start with no dates label at all is not an estimate — no dashed 'start not set'", () => {
    const s = sp({ ...up, start: "2026-09-20", dates: null, due: "2026-10-02" });
    expect(placeSprint(s, {}, NOW)!.estimated).toBe(false);
    expect(when(s)).toBe("starts in 5d");
    expect(draw([s])).not.toContain("start not set");
  });
  it("a real start more than a year before due is still the real start", () => {
    const p = placeSprint(sp({ start: "2025-01-05", dates: null, due: "2026-10-02" }), {}, NOW)!;
    expect(p.start).toBe(Date.UTC(2025, 0, 5));
    expect(p.estimated).toBe(false);
  });
  it("no start falls back to parsing dates, then to the dashed two-week estimate", () => {
    expect(placeSprint(sp({ start: null, dates: "sep 8 – 19", due: "2026-09-19" }), {}, NOW)!.start).toBe(Date.UTC(2026, 8, 8));
    const est = placeSprint(sp({ ...up, start: null, dates: null, due: "2026-10-02" }), {}, NOW)!;
    expect(est.estimated).toBe(true);
    expect(est.start).toBe(Date.UTC(2026, 8, 19));
    expect(draw([sp({ ...up, start: null, dates: null, due: "2026-10-02" })])).toContain("start not set");
  });
  it("a legacy non-ISO due is Unscheduled (not drawn), even with a start", () => {
    expect(placeSprint(sp({ start: "2026-09-01", due: "Oct 17" }), {}, NOW)).toBeNull();
  });
});

describe("timelineSummary — every number derived", () => {
  const set = [
    sp({ id: 1, status: "in_progress", active: true, due: "2026-09-10", dates: "sep 1 – 10", progress: { closed: 2, total: 8, pct: 25 } }), // overdue
    sp({ id: 2, label: "Board", status: "in_progress", active: true, due: "2026-09-25", dates: "sep 14 – 25", progress: { closed: 3, total: 4, pct: 75 } }),
    sp({ id: 3, label: "Later", status: "upcoming", active: false, due: "2026-09-19", dates: "sep 16 – 19", progress: { closed: 0, total: 3, pct: 0 } }),
    sp({ id: 4, status: "done", active: false, due: "2026-08-28", dates: "aug 17 – 28", progress: { closed: 5, total: 5, pct: 100 } }),
    sp({ id: 5, status: "upcoming", active: false, due: null, dates: null, progress: { closed: 0, total: 9, pct: 0 } }), // unscheduled
    sp({ id: 6, status: "in_progress", active: true, due: "2026-09-12", dates: null, progress: { closed: 1, total: 2, pct: 50 } }), // confirmed below
  ];
  const sum = timelineSummary(set, { "6": true }, NOW);

  it("counts by lane (a confirm moves a sprint to done) and overdue among the scheduled", () => {
    expect([sum.inProgress, sum.upcoming, sum.done, sum.overdue, sum.unscheduled]).toEqual([2, 2, 2, 1, 1]);
  });
  it("the next due date is the earliest one from today on, among sprints not done", () => {
    expect(sum.next).toEqual({ label: "Later", id: 3, due: Date.UTC(2026, 8, 19), inDays: 4 });
  });
  it("ticket progress sums the SCHEDULED sprints only", () => {
    expect(sum.tickets).toEqual({ closed: 11, total: 22, pct: 50 });
  });
  it("renders into the strip", () => {
    const html = draw(set, { confirmed: { "6": true } });
    expect(html).toContain('class="tl-sum"');
    expect(html).toContain("11/22");
    expect(html).toContain("+ 1 unscheduled");
    expect(html).toContain('data-act="openSprint" data-arg="3"');
    expect(html).toContain("in 4d");
  });
  it("nothing ahead reads as such", () => {
    const past = timelineSummary([sp({ status: "done", active: false })], {}, NOW);
    expect(past.next).toBeNull();
    expect(draw([sp({ status: "done", active: false })])).toContain("Nothing due ahead");
  });
});

describe("roadmapTimeline — the graph", () => {
  it("draws one openSprint <button> bar per scheduled sprint, with the right id", () => {
    const html = draw([sp({ id: 3 }), sp({ id: 9, label: "Later", dates: null, due: "2026-10-02", status: "upcoming", active: false })]);
    expect(html.match(/<button class="tl-bar" data-act="openSprint"/g)?.length).toBe(2);
    expect(html).toContain('class="tl-bar" data-act="openSprint" data-arg="3"');
    expect(html).toContain('class="tl-bar" data-act="openSprint" data-arg="9"');
  });

  it("puts the name and closed/total on the bar, and a beside-the-bar copy for when it does not fit", () => {
    const html = draw([sp()]);
    expect(html).toMatch(/class="tl-fill" style="--i:0;width:67%/);
    expect(html).toContain('<span class="tl-in"><span class="tl-name">Search GA</span><span class="tl-cnt">4/6</span></span>');
    expect(html).toMatch(/class="tl-out tl-out--[lr]" aria-hidden="true"><b>Search GA<\/b> <span>4\/6<\/span>/);
  });

  it("each row carries the lead's avatar, a state tag and how late or early it is", () => {
    const html = draw(
      [sp({ lead: "ana", due: "2026-09-03", dates: "aug 24 – sep 3", progress: { closed: 1, total: 5, pct: 20 } })],
      { persons: [{ handle: "ana", name: "Ana Ruiz", color: "moss", avatar_url: null }] },
    );
    const lab = html.slice(html.indexOf('class="tl-lab">'), html.indexOf('class="tl-track"'));
    expect(lab).toContain('class="cnpy-av"');
    expect(lab).toContain('title="Ana Ruiz"');
    expect(lab).toContain(">Overdue</span>");
    expect(lab).toContain("12d overdue");
    expect(lab).toContain("Aug 24 – Sep 3");
  });

  it("groups rows into In progress / Upcoming / Done lanes, each ordered by start", () => {
    const html = draw([
      sp({ id: 1, label: "Done one", status: "done", active: false, dates: "aug 1 – 14", due: "2026-08-14" }),
      sp({ id: 2, label: "Up late", status: "upcoming", active: false, dates: "oct 5 – 16", due: "2026-10-16" }),
      sp({ id: 3, label: "Up soon", status: "upcoming", active: false, dates: "sep 21 – oct 2", due: "2026-10-02" }),
      sp({ id: 4, label: "Running", dates: "sep 8 – 25", due: "2026-09-25" }),
    ]);
    const pos = (s: string) => html.indexOf(s);
    const bar = (id: number) => pos(`class="tl-bar" data-act="openSprint" data-arg="${id}"`);
    expect(pos('data-lane="in_progress"')).toBeLessThan(bar(4));
    expect(bar(4)).toBeLessThan(pos('data-lane="upcoming"'));
    expect(pos('data-lane="upcoming"')).toBeLessThan(pos('class="tl-bar" data-act="openSprint" data-arg="3"'));
    expect(pos('class="tl-bar" data-act="openSprint" data-arg="3"')).toBeLessThan(pos('class="tl-bar" data-act="openSprint" data-arg="2"'));
    expect(pos('class="tl-bar" data-act="openSprint" data-arg="2"')).toBeLessThan(pos('data-lane="done"'));
    expect(pos('data-lane="done"')).toBeLessThan(pos('class="tl-bar" data-act="openSprint" data-arg="1"'));
  });

  it("drops an empty lane", () => {
    const html = draw([sp()]);
    expect(html).toContain('data-lane="in_progress"');
    expect(html).not.toContain('data-lane="upcoming"');
    expect(html).not.toContain('data-lane="done"');
  });

  it("the popover carries the title, the range, progress, lead / people / urgency / domain and the description's first line", () => {
    const html = draw(
      [sp({ lead: "ana", urgency: "high", domain: "search", phase: "Phase 2", members: ["ana", "bo"] })],
      { persons: [{ handle: "ana", name: "Ana Ruiz", color: "moss", avatar_url: null }] },
    );
    const pop = html.slice(html.indexOf('class="tl-pop"'));
    expect(pop).toContain('id="tl-pop-1"');
    expect(pop).toContain("Search GA");
    expect(pop).toContain("Sep 8 – Sep 19, 2026 · 12 days");
    expect(pop).toContain("due in 4d");
    expect(pop).toContain("4/6 tickets done · 67%");
    expect(pop).toContain("In progress");
    expect(pop).toContain("Ana Ruiz");
    expect(pop).toContain("2 with tickets here");
    expect(pop).toContain("High");
    expect(pop).toContain("search");
    expect(pop).toContain("Phase 2");
    expect(pop).toContain("Ship semantic search.");
    expect(pop).not.toContain("Second line.");
    expect(html).toContain('aria-describedby="tl-pop-1"');
  });

  it("a sprint with no readable start is drawn as the two weeks before its due date, and says so", () => {
    const html = draw([sp({ dates: "whenever" })]);
    expect(html).toContain("Due Sep 19 · start not set");
    expect(html).toContain("Due Sep 19, 2026 · start not set");
    expect(html).toContain("border-left-style:dashed");
  });

  it("states: done green, overdue red, upcoming neutral; a confirmed sprint reads done", () => {
    const html = draw([
      sp({ id: 1, status: "done", active: false, dates: "aug 1 – 14", due: "2026-08-14", progress: { closed: 5, total: 5, pct: 100 } }),
      sp({ id: 2, dates: "aug 17 – 28", due: "2026-08-28", progress: { closed: 1, total: 5, pct: 20 } }),
      sp({ id: 3, status: "upcoming", active: false, dates: "oct 1 – 9", due: "2026-10-09", progress: { closed: 0, total: 0, pct: 0 } }),
      sp({ id: 4, dates: "aug 3 – 12", due: "2026-08-12", progress: { closed: 2, total: 5, pct: 40 } }),
    ], { confirmed: { "4": true } });
    const bar = (id: number) => html.match(new RegExp(`class="tl-bar" data-act="openSprint" data-arg="${id}"[^>]*>`))![0];
    expect(bar(1)).toContain("--tl-c:var(--green)");
    expect(bar(2)).toContain("--tl-c:var(--red)");
    expect(bar(3)).toContain("--tl-c:var(--fg-55)");
    expect(bar(4)).toContain("--tl-c:var(--green)");
    expect(html).toContain("No tickets in this sprint yet");
  });

  it("draws the red today line when today is near the plan, and not when it is far away", () => {
    expect(draw([sp()])).toContain('class="tl-today"');
    expect(draw([sp()])).toContain(">Today</span>");
    const far = draw([sp()], { now: Date.UTC(2028, 0, 1) });
    expect(far).not.toContain('class="tl-today"');
  });

  it("uses weeks under months for a short plan and months under years for a long one", () => {
    const short = draw([sp()]);
    expect(short).toContain(">September 2026</span>");
    expect(short).toMatch(/class="tl-tick[^"]*" style="left:[^"]*">14<\/span>/);
    const long = draw([
      sp({ id: 1, dates: "jan 5 – 30", due: "2026-01-30" }),
      sp({ id: 2, dates: "nov 2 – 20", due: "2026-11-20" }),
    ]);
    expect(long).toContain(">2026</span>");
    expect(long).toMatch(/class="tl-tick[^"]*" style="left:[^"]*">Jun<\/span>/);
  });

  it("lists unscheduled sprints under the graph (still clickable) and never draws them", () => {
    const html = draw([sp({ id: 1 }), sp({ id: 5, label: "Someday", due: null, dates: null, status: "upcoming", active: false })]);
    expect(html).toContain("Unscheduled");
    expect(html).toContain('class="tl-unsched" data-act="openSprint" data-arg="5"');
    expect(html).not.toContain('class="tl-bar" data-act="openSprint" data-arg="5"');
    expect(html).not.toContain('id="tl-pop-5"');
  });

  it("with only unscheduled sprints, says there is nothing to place and still lists them", () => {
    const html = draw([sp({ id: 5, due: null })]);
    expect(html).toContain("nothing to place on the calendar");
    expect(html).not.toContain("tl-bar");
    expect(html).toContain('data-arg="5"');
  });

  it("with no sprints at all, says so (and draws no summary)", () => {
    const html = draw([]);
    expect(html).toContain("No sprints yet.");
    expect(html).not.toContain('class="tl-sum"');
  });

  it("escapes every sprint string", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = draw([
      sp({ id: 1, label: evil, description: evil, phase: evil, lead: evil, dates: evil }),
      sp({ id: 2, label: evil, due: null }),
      sp({ id: 3, label: evil, due: "2026-09-30", status: "upcoming", active: false }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("the Timeline reads the ONE due-date rule (shared/sprints-core sprintDueState)", () => {
  it("overdue state and days late match sprintDueState on every day around the due date", () => {
    for (const due of ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]) {
      const s = sp({ due, dates: null });
      const rule = sprintDueState(due, NOW)!;
      const p = placeSprint(s, {}, NOW)!;
      expect(p.state === "overdue").toBe(rule.overdue);
      if (rule.overdue) expect(timingText(p, NOW)).toBe(`${rule.daysLate}d overdue`);
    }
  });
});
