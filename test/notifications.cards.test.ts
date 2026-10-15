/**
 * The shorter e-mail's pieces (Phase E), drawn by the renderers' pure halves: "Your brief" (Now, Next, Also), a
 * queue's one line, "This week". The per-PR What / Why / Impact cards, the issue rows and labels and the plan diff of
 * the old digest are gone; these pin what replaced them.
 */
import { describe, it, expect } from "vitest";
import { renderBrief, briefSubject, type BriefContent } from "../src/notifications/renderers/my-work";
import { renderWeek, numbersLine } from "../src/notifications/renderers/week-recap";
import { assembleMessage, appHref, queueLine } from "../src/notifications/assemble";
import type { Window } from "@shared/notifications";

const WINDOW: Window = { cadence: "daily", start: new Date("2026-09-10T12:00:00.000Z"), end: new Date("2026-09-11T12:00:00.000Z"), id: "2026-09-11" };
const brief = (o: Partial<BriefContent> = {}): BriefContent => ({
  source: "brief",
  now: "You have #171 open.",
  next: [
    { title: "Netlify test failing", href: "https://github.com/o/r/actions/runs/1", line: "It is failing on your pull request #171." },
    { title: "Poll <Vercel> deploys", href: appHref("#tickets/2"), line: "Its sprint is due Friday." },
  ],
  nextTotal: 2,
  also: [{ title: "Repository setups", href: "https://github.com/o/r/pull/172", importance: "breaking", at: "2026-09-11T08:00:00Z" }],
  ...o,
});
const assemble = (sections: Parameters<typeof assembleMessage>[0]["sections"], window = WINDOW) =>
  assembleMessage({ sections, window, timeZone: "America/New_York", origin: "https://trov.dev", appBase: "https://trov.dev/acme", login: "andres", unsubscribeUrl: "https://trov.dev/u/x" });

describe("Your brief", () => {
  it("Now, then Next (title linked, its why under it), then Also with its mark; titles escaped", () => {
    const s = renderBrief(brief())!;
    expect(s.heading).toBe("Your brief");
    expect(s.html).toMatch(/data-brief-now[\s\S]*NEXT[\s\S]*data-brief-next[\s\S]*ALSO[\s\S]*data-brief-also/);
    expect(s.html).toContain("Poll &lt;Vercel&gt; deploys");
    expect(s.html).toContain("It is failing on your pull request #171.");
    expect(s.html).toMatch(/Repository setups<\/a>[\s\S]*data-mark[\s\S]*Breaking/);
    expect(s.subject).toBe("Netlify test failing, plus 1 more");
  });

  it("with no brief, the assigned tickets under their own label; with only Also, the block is called Also", () => {
    expect(renderBrief(brief({ source: "assigned", now: null }))!.html).toContain("ASSIGNED TO YOU");
    const onlyAlso = renderBrief(brief({ now: null, next: [], nextTotal: 0 }))!;
    expect(onlyAlso.heading).toBe("Also");
    expect(onlyAlso.subject).toBeUndefined();
    // e2e EM-4: the heading already says Also — no second "ALSO" label under it, in either part.
    expect(onlyAlso.html).not.toContain(">ALSO<");
    expect(onlyAlso.text).not.toContain("ALSO");
    expect(onlyAlso.html).toContain("data-brief-also");
    expect(onlyAlso.text).toContain("- Repository setups (breaking) <https://github.com/o/r/pull/172>");
    expect(renderBrief(brief({ now: null, next: [], nextTotal: 0, also: [] }))).toBeNull();
  });

  it("the subject is the top Next item, plus how many more", () => {
    expect(briefSubject({ next: [{ title: "A", href: null, line: "" }], nextTotal: 1 })).toBe("A");
    expect(briefSubject({ next: [{ title: "A", href: null, line: "" }], nextTotal: 5 })).toBe("A, plus 4 more");
    expect(briefSubject({ next: [], nextTotal: 0 })).toBeNull();
  });
});

describe("the assembled message", () => {
  it("blocks first, then every queue line together, each the whole line a link; in-app links hang off the org", () => {
    const m = assemble([queueLine({ label: "Review", rest: "3 waiting, 1 changes a decision", deepLink: "/#review", linkLabel: "Review" }), renderBrief(brief())!]);
    expect(m.subject).toBe("Netlify test failing, plus 1 more");
    expect(m.html.indexOf('data-section="block"')).toBeLessThan(m.html.indexOf('data-section="lines"'));
    expect(m.html).toMatch(/<a href="https:\/\/trov\.dev\/acme\/#review"[^>]*><span[^>]*>Review:<\/span> 3 waiting, 1 changes a decision/);
    expect(m.html).toContain('href="https://trov.dev/acme/#tickets/2"');
    expect(m.html).not.toContain("{{trov-app}}");
    expect(m.text).toContain("Review: 3 waiting, 1 changes a decision -> https://trov.dev/acme/#review");
    expect(m.text).toContain("<https://trov.dev/acme/#tickets/2>");
  });

  it("the weekly keeps its dated subject even when the brief offers one", () => {
    const m = assemble([renderBrief(brief())!], { cadence: "weekly", start: new Date("2026-09-07T12:00:00Z"), end: new Date("2026-09-14T12:00:00Z"), id: "2026-W38" });
    expect(m.subject).toMatch(/^Trov weekly, Sep 7 to 11$/);
  });
});

describe("This week", () => {
  it("cited highlights, then the server's numbers line; none of either → nothing", () => {
    const s = renderWeek([{ text: "Repository setups shipped.", cites: [{ ref: "pr:172", label: "#172", href: "https://github.com/o/r/pull/172" }, { ref: "ticket:4", label: "#4", href: "#tickets/4" }] }], "3 pull requests merged")!;
    expect(s.heading).toBe("This week");
    expect(s.html).toMatch(/Repository setups shipped\.[\s\S]*#172[\s\S]*data-week-numbers[^>]*>3 pull requests merged/);
    expect(s.html).toContain(appHref("#tickets/4"));
    expect(renderWeek([], null)).toBeNull();
  });

  it("the numbers line leaves out zeros and an unknown pull-request count — never a guessed 0", () => {
    expect(numbersLine({ prsMerged: null, ticketsDone: 2, feedEntries: 1 })).toBe("2 tickets done, 1 entry in the Feed");
    expect(numbersLine({ prsMerged: 1, ticketsDone: 0, feedEntries: 0 })).toBe("1 pull request merged");
    expect(numbersLine({ prsMerged: 0, ticketsDone: 0, feedEntries: 0 })).toBeNull();
  });
});
