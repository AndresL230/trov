import { describe, it, expect } from "vitest";
import { issueRefStart, matchIssueRef } from "../web/src/issue-ref";

const REPO = "https://github.com/SaplingLearn/sapling";

describe("issue references in prose", () => {
  it("a bare #N links to the main repo", () => {
    expect(matchIssueRef("#123 is next", REPO)).toEqual({ raw: "#123", href: `${REPO}/issues/123`, text: "#123" });
  });

  it("owner/repo#N links to THAT repo, never the main one", () => {
    expect(matchIssueRef("AndresL230/trov#51). Store", REPO)).toEqual({
      raw: "AndresL230/trov#51", href: "https://github.com/AndresL230/trov/issues/51", text: "AndresL230/trov#51",
    });
  });

  it("the start index is the owner, not the #, so the whole reference is one token", () => {
    expect(issueRefStart("see AndresL230/trov#51 and #7")).toBe(4);
    expect(issueRefStart("and #7")).toBe(4);
    expect(issueRefStart("nothing here")).toBeUndefined();
  });

  it("does not match a heading marker, a colour, or a # with no number", () => {
    for (const s of ["# Title", "#fff", "#", "#12abc"]) expect(matchIssueRef(s, REPO)).toBeNull();
  });

  it("an owner/repo match cannot carry markup into the href or the text", () => {
    expect(matchIssueRef(`a"b/c#1`, REPO)).toBeNull(); // not at the start
    expect(matchIssueRef(`<x>/y#1`, REPO)).toBeNull();
    const r = matchIssueRef("ok-org/re.po_1#9", REPO)!;
    expect(r.href).toBe("https://github.com/ok-org/re.po_1/issues/9");
    expect(`${r.href}${r.text}`).not.toMatch(/["<>]/);
  });
});
