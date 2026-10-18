import { describe, it, expect } from "vitest";
import {
  DOC_TEMPLATES, DOC_TEMPLATE_IDS, DEFAULT_DOC_TEMPLATE, BLANK_TEMPLATE_PREVIEW,
  docTemplate, isDocTemplateId, templateBody, untitledTitle,
} from "@shared/docs-templates-core";
import { SECTIONS } from "@shared/vocabulary";
import { extractOutline } from "@shared/doc-outline";

// The New page templates — pure. Written out literally: this table is the design (§6.1).
const EXPECTED: Array<[string, string, string, string[]]> = [
  ["guide", "Guide", "reference", ["Overview", "Before you start", "How it works", "Next steps"]],
  ["howto", "How-to", "reference", ["What you'll do", "Steps", "Check that it worked", "If something goes wrong"]],
  ["reference", "Reference", "reference", ["Summary", "Details", "Examples", "Related pages"]],
  ["runbook", "Runbook", "reference", ["When to use this", "Check first", "Fix it", "Roll back", "Who to tell"]],
  ["spec", "Spec", "context", ["Problem", "Proposal", "How it works", "Risks", "Open questions"]],
  ["brief", "Product brief", "context", ["Problem", "Who it's for", "What we'll build", "How we'll know it worked", "Not in scope"]],
  ["decision", "Decision record", "decisions", ["Context", "Options we considered", "Decision", "What this changes"]],
  ["onboarding", "Onboarding", "reference", ["Welcome", "Your first day", "Your first week", "People to meet", "Where things live"]],
  ["blank", "Blank", "reference", []],
];

describe("doc templates", () => {
  it("are the design's nine, in order, with their default sections", () => {
    expect(DOC_TEMPLATES.map((t) => [t.id, t.name, t.section, [...t.sections]])).toEqual(EXPECTED);
    expect([...DOC_TEMPLATE_IDS]).toEqual(EXPECTED.map((e) => e[0]));
    for (const t of DOC_TEMPLATES) {
      expect((SECTIONS as readonly string[]).includes(t.section)).toBe(true);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  it("Runbook is the default", () => {
    expect(DEFAULT_DOC_TEMPLATE).toBe("runbook");
    expect(docTemplate(DEFAULT_DOC_TEMPLATE)?.name).toBe("Runbook");
  });

  it("an unknown id is null, never a guess", () => {
    expect(docTemplate("nope")).toBeNull();
    expect(isDocTemplateId("spec")).toBe(true);
    expect(isDocTemplateId("Spec")).toBe(false);
  });

  it("seeds a body of one H2 per section, which the outline reads back", () => {
    expect(templateBody("decision")).toBe("## Context\n\n## Options we considered\n\n## Decision\n\n## What this changes\n\n");
    expect(extractOutline(templateBody("runbook")).map((o) => o.text)).toEqual(docTemplate("runbook")!.sections);
    expect(templateBody("blank")).toBe("");
    expect(templateBody(docTemplate("blank")!)).toBe("");
    expect(BLANK_TEMPLATE_PREVIEW).toBe("An empty page, ready for you.");
  });

  it("the untitled placeholder lowercases the template name", () => {
    expect(untitledTitle("runbook")).toBe("Untitled runbook");
    expect(untitledTitle("brief")).toBe("Untitled product brief");
    expect(untitledTitle(docTemplate("howto")!)).toBe("Untitled how-to");
  });
});
