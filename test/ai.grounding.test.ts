// src/ai/grounding.ts — what the live eval taught (test/ai-evals/run-live-roadmap.mjs, round one): Haiku writes refs
// INTO its sentences ("ticket:19 is unassigned", "Billing at 25%, unlike sprint:41"). A ref names a source, never
// a count; it is shown as the label the server built; and a ref that was not offered drops the line.
import { describe, it, expect } from "vitest";
import { allowedNumbers, groundedLine, numbersGiven, numbersIn, tidyRefs, fencedText, FENCE } from "../src/ai/grounding";
import type { AiCite } from "@shared/ai";

const offered = new Map<string, AiCite>([
  ["ticket:19", { ref: "ticket:19", label: "#19", href: "#tickets/19" }],
  ["pr:178", { ref: "pr:178", label: "#178", href: null }],
  ["theme:billing", { ref: "theme:billing", label: "Billing and plans", href: "#repo/planning" }],
  ["feed:121", { ref: "feed:121", label: "Repo setups Phase D", href: "#feed" }],
]);

describe("refs in model text", () => {
  it("a ref states no number", () => {
    expect([...numbersIn("per feed:121 the cap rose")]).toEqual([]);
    expect(numbersGiven("Billing took 25%, see theme:billing and feed:121", allowedNumbers(25))).toBe(true);
    expect(numbersGiven("Billing took 26%", allowedNumbers(25))).toBe(false); // still caught
  });

  it("refs read as the server's labels; an unoffered ref drops the line", () => {
    expect(tidyRefs("ticket:19 waits on pr:178; theme:billing is off plan", offered)).toBe("#19 waits on #178; Billing and plans is off plan");
    expect(tidyRefs("ticket:20 waits", offered)).toBeNull();
    expect(groundedLine("Three of 9 open; ticket:19 waits on pr:178.", { offered, allowed: allowedNumbers(9, 19, 178) })).toBeNull(); // "Three" was not given
    expect(groundedLine("Nine open; ticket:19 waits on pr:178.", { offered, allowed: allowedNumbers(9) })).toBe("Nine open; #19 waits on #178.");
  });

  it("a document goes as its own text, fenced", () => {
    const t = fencedText("document", 'Say "hi"\n\nnext');
    expect(t).toContain('Say "hi"\n\nnext');
    expect(fencedText("d", `a${FENCE}b`)).toContain("ab");
  });
});
