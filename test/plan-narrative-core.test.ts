// The plan narrative's shape — Now / Next / Later, enforced at write (shared/sprints-core › the plan narrative's
// shape; docs/architecture/roadmap-my-work.md). Pure: compose ⇄ parse round-trip, the legacy forms that still read
// as the box, the free text that does not, and the ONE rule every writer goes through (`planNarrativeParts`).
import { describe, it, expect } from "vitest";
import {
  PLAN_NARRATIVE_MAX, composePlanNarrative, parsePlanNarrative, planNarrativeParts, planNarrativePartsProblem,
} from "@shared/sprints-core";
import { aiNarrativeParts } from "@shared/ai-core";

const P = { now: "Hosting, *mostly*.", next: "Billing: seats and receipts.", later: "Docs." };

describe("compose ⇄ parse", () => {
  it("composes the ONE stored form and reads it back to the same three parts", () => {
    const text = composePlanNarrative(P);
    expect(text).toBe("**Now:** Hosting, *mostly*.\n\n**Next:** Billing: seats and receipts.\n\n**Later:** Docs.");
    expect(parsePlanNarrative(text)).toEqual(P);
    expect(parsePlanNarrative(`\n  ${text}  \n`)).toEqual(P);
  });

  it("each part is one paragraph: whitespace runs (newlines too) fold to one space", () => {
    const text = composePlanNarrative({ now: "  a\n\nb  ", next: "c\td", later: "e" });
    expect(text).toBe("**Now:** a b\n\n**Next:** c d\n\n**Later:** e");
    expect(parsePlanNarrative(text)).toEqual({ now: "a b", next: "c d", later: "e" });
  });

  it("reads the forms written before the box: run together, `**Now**:`, plain capitalised `Now:`", () => {
    const want = { now: "hosting.", next: "billing.", later: "docs." };
    expect(parsePlanNarrative("**Now:** hosting. **Next:** billing. **Later:** docs.")).toEqual(want);
    expect(parsePlanNarrative("**Now**: hosting.\n**Next**: billing.\n**Later**: docs.")).toEqual(want);
    expect(parsePlanNarrative("Now: hosting. Next: billing. Later: docs.")).toEqual(want);
  });

  it("anything else is not the box (null): free text, a heading first, a part missing, out of order, a label twice, empty", () => {
    for (const legacy of [
      "", "   ", "Ship hosting, then billing.",
      "## Q3\n\n**Now:** a **Next:** b **Later:** c",
      "**Now:** a **Next:** b",
      "**Next:** b **Now:** a **Later:** c",
      "**Now:** a **Next:** b **Next:** b2 **Later:** c",
      "**Now:** **Next:** b **Later:** c",
      "**Now** the dashboard. **Next** offline. **Later** sync.", // no colon: words, not labels
    ]) expect(parsePlanNarrative(legacy), legacy).toBeNull();
  });
});

describe("the ONE write rule (`planNarrativeParts`)", () => {
  it("three parts are taken, trimmed and folded", () => {
    expect(planNarrativeParts({ now: " a ", next: "b\nc", later: "d" })).toEqual({ parts: { now: "a", next: "b c", later: "d" } });
  });
  it("a legacy `narrative` is taken only when it parses; free text says to pass now / next / later", () => {
    expect(planNarrativeParts({ narrative: "**Now:** a **Next:** b **Later:** c" })).toEqual({ parts: { now: "a", next: "b", later: "c" } });
    expect(planNarrativeParts({ narrative: "We ship." })).toEqual({ problem: expect.stringContaining("pass `now`, `next` and `later`") });
    expect(planNarrativeParts({})).toEqual({ problem: expect.stringContaining("pass `now`, `next` and `later`") });
  });
  it("refuses an empty or missing part (naming it), a part with a label of its own, both forms together, and over the cap", () => {
    expect(planNarrativePartsProblem({ now: "a", next: " ", later: "" })).toContain("next, later are empty");
    expect(planNarrativePartsProblem({ now: "a **Later:** z", next: "b", later: "c" })).toContain("label of its own");
    expect(planNarrativeParts({ ...P, narrative: composePlanNarrative(P) })).toEqual({ problem: expect.stringContaining("not together") });
    const over = planNarrativePartsProblem({ ...P, now: "x".repeat(PLAN_NARRATIVE_MAX) });
    expect(over).toContain(`the cap is ${PLAN_NARRATIVE_MAX}`);
    expect(planNarrativePartsProblem(P)).toBeNull();
  });
});

describe("a narrative proposal's value (`aiNarrativeParts`)", () => {
  it("the three parts, or a legacy `{ narrative }` that parses — else null", () => {
    expect(aiNarrativeParts(P)).toEqual(P);
    expect(aiNarrativeParts({ narrative: "**Now:** a **Next:** b **Later:** c" })).toEqual({ now: "a", next: "b", later: "c" });
    expect(aiNarrativeParts({ narrative: "Ship it." })).toBeNull();
    expect(aiNarrativeParts({ now: "a", next: "b" })).toBeNull();
    expect(aiNarrativeParts(null)).toBeNull();
  });
});
