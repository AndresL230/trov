/**
 * The @mention picker's pure core (`web/src/mentions.ts`).
 *
 * Same idiom as test/hash.test.ts: no DOM, no D1, no `state` — main.ts owns the
 * textarea and the caret, and everything decidable from (text, caret, persons)
 * — including where the picker hangs — is decided by these pure functions, so
 * the RULES are unit-tested here.
 */
import { describe, it, expect } from "vitest";
import {
  mentionTokenAt, mentionCandidates, applyMention,
  caretLine, mentionPickerTop, COMMENT_BOX, COMMENT_LINE_HEIGHT,
} from "../web/src/mentions";
import type { PersonSummary } from "../web/src/api";

// Every fixture name is capitalized the same way on purpose: the ordering
// assertions below must not depend on how `localeCompare` ranks case.
const PERSONS: PersonSummary[] = [
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null, role: null },
  { handle: "sanaok", name: "Sana Okafor", color: "ochre", avatar_url: null, role: null },
  { handle: "jose-a", name: "Jose Alvarez", color: "moss", avatar_url: null, role: null },
  { handle: "sam", name: "Samir Mehta", color: "sky", avatar_url: null, role: null },
];

describe("mentionTokenAt", () => {
  it("opens on an @ at the start of the text", () => {
    expect(mentionTokenAt("@mei", 4)).toEqual({ start: 0, query: "mei" });
  });

  it("opens on an @ right after a space", () => {
    expect(mentionTokenAt("ping @mei", 9)).toEqual({ start: 5, query: "mei" });
  });

  it("opens on an @ right after a newline", () => {
    expect(mentionTokenAt("ping\n@mei", 9)).toEqual({ start: 5, query: "mei" });
  });

  it("opens with an EMPTY query the moment the @ is typed", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTokenAt("hey @", 5)).toEqual({ start: 4, query: "" });
  });

  it("reads only up to the caret, not the whole token", () => {
    // Caret parked mid-token: the query is what is BEFORE it.
    expect(mentionTokenAt("@meilin", 3)).toEqual({ start: 0, query: "me" });
  });

  it("is null mid-word — `a@b` is not a mention", () => {
    expect(mentionTokenAt("a@b", 3)).toBeNull();
    expect(mentionTokenAt("someone@example.com", 12)).toBeNull();
  });

  it("is null when the caret sits BEFORE the @", () => {
    expect(mentionTokenAt("hi @mei", 3)).toBeNull();   // just before the @
    expect(mentionTokenAt("hi @mei", 0)).toBeNull();
  });

  it("is null once the token is closed by a space", () => {
    expect(mentionTokenAt("@mei ", 5)).toBeNull();
    expect(mentionTokenAt("@mei and", 8)).toBeNull();
  });

  it("is null with no @ anywhere, and for out-of-range carets", () => {
    expect(mentionTokenAt("plain text", 5)).toBeNull();
    expect(mentionTokenAt("", 0)).toBeNull();
    expect(mentionTokenAt("@mei", 99)).toBeNull();
    expect(mentionTokenAt("@mei", -1)).toBeNull();
  });

  it("accepts the handle character class (letters, digits, _ and -)", () => {
    expect(mentionTokenAt("@jose-a", 7)).toEqual({ start: 0, query: "jose-a" });
    expect(mentionTokenAt("@a_1", 4)).toEqual({ start: 0, query: "a_1" });
  });
});

describe("mentionCandidates", () => {
  const handles = (q: string, limit?: number) =>
    mentionCandidates(PERSONS, q, limit).map((p) => p.handle);

  it("matches on a handle prefix", () => {
    expect(handles("mei")).toEqual(["meilin"]);
  });

  it("matches on a FIRST-name prefix", () => {
    expect(handles("sana")).toEqual(["sanaok"]);
  });

  it("matches on a LAST-name prefix (any whitespace-separated word)", () => {
    expect(handles("zhao")).toEqual(["meilin"]);
    expect(handles("alvarez")).toEqual(["jose-a"]);
  });

  it("is case-insensitive in both directions", () => {
    expect(handles("MEI")).toEqual(["meilin"]);
    expect(handles("Okafor")).toEqual(["sanaok"]);
  });

  it("orders by name ascending when nothing is an exact handle", () => {
    expect(handles("sa")).toEqual(["sam", "sanaok"]);       // Samir Mehta < Sana Okafor
    expect(handles("")).toEqual(["jose-a", "meilin", "sam", "sanaok"]);
  });

  it("puts an EXACT handle match first, ahead of the name order", () => {
    const pair: PersonSummary[] = [
      { handle: "zed", name: "Zed Zulu", color: "rose", avatar_url: null, role: null },
      { handle: "zedd", name: "Aaron Zedd", color: "moss", avatar_url: null, role: null },
    ];
    const h = (q: string) => mentionCandidates(pair, q).map((p) => p.handle);
    // Both match "zed"; the exact handle wins even though "Aaron Zedd" sorts first.
    expect(h("zed")).toEqual(["zed", "zedd"]);
    // No exact match → plain name order, which is the OTHER way round.
    expect(h("ze")).toEqual(["zedd", "zed"]);
  });

  it("falls back to the handle for ordering when a person has no name", () => {
    const fb: PersonSummary[] = [
      { handle: "aaa", name: "zebra one", color: "rose", avatar_url: null, role: null },   // key: "zebra one"
      { handle: "mmm", name: null, color: "moss", avatar_url: null, role: null },          // key: "mmm"
    ];
    // Ordering by handle would give ["aaa","mmm"]; by `name ?? handle` it is:
    expect(mentionCandidates(fb, "").map((p) => p.handle)).toEqual(["mmm", "aaa"]);
  });

  it("lists everyone on an empty query", () => {
    expect(mentionCandidates(PERSONS, "")).toHaveLength(PERSONS.length);
  });

  it("caps at 6 by default", () => {
    const many: PersonSummary[] = Array.from({ length: 12 }, (_, i) => ({
      handle: `p${i}`, name: `Person ${String.fromCharCode(97 + i)}`, color: "moss", avatar_url: null, role: null,
    }));
    expect(mentionCandidates(many, "")).toHaveLength(6);
    expect(mentionCandidates(many, "p")).toHaveLength(6);
    expect(mentionCandidates(many, "", 3)).toHaveLength(3);
  });

  it("returns nothing when nothing matches", () => {
    expect(mentionCandidates(PERSONS, "qqq")).toEqual([]);
  });

  it("never mutates the caller's array", () => {
    const order = PERSONS.map((p) => p.handle);
    mentionCandidates(PERSONS, "");
    expect(PERSONS.map((p) => p.handle)).toEqual(order);
  });
});

describe("applyMention", () => {
  it("replaces the token with @handle plus a trailing space", () => {
    const tok = mentionTokenAt("@mei", 4)!;
    expect(applyMention("@mei", tok.start, 4, "meilin")).toEqual({ text: "@meilin ", caret: 8 });
  });

  it("puts the caret right after the trailing space", () => {
    const out = applyMention("hey @sa", 4, 7, "sanaok");
    expect(out.text).toBe("hey @sanaok ");
    expect(out.caret).toBe(12);
    expect(out.text.slice(0, out.caret)).toBe("hey @sanaok ");
  });

  it("only touches the token when it sits mid-sentence", () => {
    const text = "hey @sa can you look at this?";
    const tok = mentionTokenAt(text, 7)!;
    const out = applyMention(text, tok.start, 7, "sanaok");
    expect(out.text).toBe("hey @sanaok  can you look at this?");   // token's own space + the original
    expect(out.caret).toBe(12);
    expect(out.text.slice(out.caret)).toBe(" can you look at this?");
  });

  it("expands an empty token (just the @)", () => {
    expect(applyMention("hey @", 4, 5, "jose-a")).toEqual({ text: "hey @jose-a ", caret: 12 });
  });

  it("round-trips: the result's caret is no longer inside a mention token", () => {
    const out = applyMention("hey @sa", 4, 7, "sanaok");
    expect(mentionTokenAt(out.text, out.caret)).toBeNull();
  });
});

describe("caretLine", () => {
  it("is line 0 before the first newline", () => {
    expect(caretLine("hey @sa", 7)).toBe(0);
    expect(caretLine("", 0)).toBe(0);
  });

  it("counts the hard newlines BEFORE the caret, not the whole text", () => {
    const text = "one\ntwo\nthree\nfour";
    expect(caretLine(text, 0)).toBe(0);
    expect(caretLine(text, 3)).toBe(0);      // end of "one", before its \n
    expect(caretLine(text, 4)).toBe(1);      // just after that \n
    expect(caretLine(text, text.indexOf("three"))).toBe(2);
    expect(caretLine(text, text.length)).toBe(3);
  });

  it("ignores soft wrap — a long unbroken line is still one line", () => {
    expect(caretLine("x".repeat(400), 400)).toBe(0);
  });

  it("clamps a caret outside the text instead of throwing", () => {
    expect(caretLine("a\nb", -5)).toBe(0);
    expect(caretLine("a\nb", 999)).toBe(1);
  });
});

describe("mentionPickerTop", () => {
  // The geometry the comment textarea is built from: 13.5px × 1.6 = 21.6px a
  // line, off a 2px top padding, with 4px of gap under the line being typed.
  it("hangs one line-height under the caret's line", () => {
    expect(COMMENT_LINE_HEIGHT).toBeCloseTo(21.6, 5);
    expect(mentionPickerTop(0)).toBe(27.6);
    expect(mentionPickerTop(1)).toBe(49.2);
    expect(mentionPickerTop(2)).toBe(70.8);
    expect(mentionPickerTop(3)).toBe(92.4);
  });

  it("steps by exactly one line height", () => {
    for (const line of [0, 1, 2]) {
      expect(mentionPickerTop(line + 1) - mentionPickerTop(line)).toBeCloseTo(COMMENT_LINE_HEIGHT, 5);
    }
  });

  it("never hangs below the box's bottom + the gap", () => {
    const cap = COMMENT_BOX.height + COMMENT_BOX.gap;
    expect(mentionPickerTop(4)).toBe(cap);
    expect(mentionPickerTop(40)).toBe(cap);
    expect(mentionPickerTop(4000)).toBe(cap);
  });

  it("takes the cap from the box's ACTUAL height (the grip can have grown it)", () => {
    expect(mentionPickerTop(9, { height: 300 })).toBe(222);        // still under the line
    expect(mentionPickerTop(40, { height: 300 })).toBe(304);       // capped at 300 + gap
    expect(mentionPickerTop(2, { height: 60 })).toBe(64);          // a shrunk box caps sooner
  });

  it("treats a negative / fractional / non-finite line as the first line", () => {
    expect(mentionPickerTop(-3)).toBe(mentionPickerTop(0));
    expect(mentionPickerTop(1.7)).toBe(mentionPickerTop(1));
    expect(mentionPickerTop(Number.NaN)).toBe(mentionPickerTop(0));
  });

  it("honours overridden metrics (the style and the maths read the same numbers)", () => {
    expect(mentionPickerTop(0, { padTop: 0, lineHeight: 20, gap: 0, height: 500 })).toBe(20);
    expect(mentionPickerTop(2, { padTop: 10, lineHeight: 10, gap: 2, height: 500 })).toBe(42);
  });
});
