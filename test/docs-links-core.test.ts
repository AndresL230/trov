import { describe, it, expect } from "vitest";
import { DOC_SLUG_RE, findDocLinks, extractDocLinks, replaceDocLinks, docLinkText, isDocSlug } from "@shared/docs-links-core";
import { DocProposal } from "@shared/contract";

// `[[slug]]` / `[[slug|label]]` links — pure. The Worker rebuilds doc_links from extractDocLinks on promote;
// the reader renders through replaceDocLinks. Code is never scanned.

describe("DOC_SLUG_RE", () => {
  it("is the same rule as DocProposal.slug", () => {
    const samples = ["auth", "auth-flow", "a/b_c-1", "9lives", "Auth", "-x", "_x", "a b", "a.b", "", "über", "a//b"];
    for (const s of samples) {
      expect(isDocSlug(s), s).toBe(DocProposal.shape.slug.safeParse(s).success);
    }
    expect(DOC_SLUG_RE.source).toBe("^[a-z0-9][a-z0-9_/-]*$");
  });
});

describe("findDocLinks / extractDocLinks", () => {
  it("parses both forms, trimming slug and label", () => {
    expect(findDocLinks("See [[auth]] and [[ api/errors | the error list ]].")).toEqual([
      { slug: "auth", label: null, raw: "[[auth]]" },
      { slug: "api/errors", label: "the error list", raw: "[[ api/errors | the error list ]]" },
    ]);
    expect(findDocLinks("[[auth|]]")[0]).toEqual({ slug: "auth", label: null, raw: "[[auth|]]" });
  });

  it("ignores invalid slugs and broken brackets", () => {
    expect(extractDocLinks("[[Auth]] [[a b]] [[]] [[x]  [y]] [[ok]] [[not\nok]]")).toEqual(["ok"]);
  });

  it("splits on the first pipe: the rest is the label", () => {
    expect(findDocLinks("[[a|b|c]]")[0]).toEqual({ slug: "a", label: "b|c", raw: "[[a|b|c]]" });
  });

  it("returns distinct slugs in first-seen order", () => {
    expect(extractDocLinks("[[b]] [[a]] [[b|again]] [[c]] [[a]]")).toEqual(["b", "a", "c"]);
  });

  it("skips inline code spans and fenced blocks", () => {
    const body = [
      "Use `[[slug]]` to link, or ``a `[[double]]` b``.",
      "```md",
      "[[in-fence]]",
      "```",
      "~~~~",
      "[[tilde]]",
      "~~~",
      "still fenced [[tilde2]]",
      "~~~~",
      "Real: [[real]]. Unclosed ` tick [[after-tick]]",
    ].join("\n");
    expect(extractDocLinks(body)).toEqual(["real", "after-tick"]);
  });

  it("an unclosed fence runs to the end", () => {
    expect(extractDocLinks("[[a]]\n```\n[[b]]\n")).toEqual(["a"]);
  });

  it("a backtick line with a closing backtick is inline code, not a fence", () => {
    expect(extractDocLinks("```x``` [[y]]")).toEqual(["y"]);
  });

  it("an inline span does not cross a blank line", () => {
    expect(extractDocLinks("a ` b\n\n[[c]] `")).toEqual(["c"]);
  });

  it("tolerates empty input", () => {
    expect(extractDocLinks("")).toEqual([]);
    expect(extractDocLinks(undefined as unknown as string)).toEqual([]);
  });
});

describe("replaceDocLinks", () => {
  it("substitutes links outside code and leaves everything else byte for byte", () => {
    const body = "Top [[auth|Sign-in]].\n\n`[[auth]]`\n\n```\n[[auth]]\n```\nEnd [[gone]] [[Bad]]\n";
    const out = replaceDocLinks(body, (l) => `<${l.slug}:${l.label ?? ""}>`);
    expect(out).toBe("Top <auth:Sign-in>.\n\n`[[auth]]`\n\n```\n[[auth]]\n```\nEnd <gone:> [[Bad]]\n");
  });

  it("is the identity when fn returns the raw text", () => {
    const body = "a [[x]] `[[y]]` [[ z | w ]]\r\n~~~\n[[q]]\n~~~";
    expect(replaceDocLinks(body, (l) => l.raw)).toBe(body);
  });

  it("docLinkText writes either form", () => {
    expect(docLinkText("auth")).toBe("[[auth]]");
    expect(docLinkText("auth", "Sign-in")).toBe("[[auth|Sign-in]]");
    expect(extractDocLinks(docLinkText("a/b", "x"))).toEqual(["a/b"]);
  });
});
