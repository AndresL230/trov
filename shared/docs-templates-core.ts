// New page templates — ONCE (zod-free and pure: the SPA imports it as a value). A template only SEEDS a new
// page: its body skeleton (one `## ` heading per section) and its default section (the gate's vocabulary,
// shared/vocabulary.ts SECTIONS — the person may change it). The template a page started from is not stored.
// Names, descriptions, sections and icons are the design's (Docs Library spec §6.1). The default is Runbook.

export const DOC_TEMPLATE_IDS = ["guide", "howto", "reference", "runbook", "spec", "brief", "decision", "onboarding", "blank"] as const;
export type DocTemplateId = (typeof DOC_TEMPLATE_IDS)[number];

/** The sections a template may default to (a subset of SECTIONS; never `needs-triage`). */
export type DocTemplateSection = "reference" | "context" | "decisions";

export interface DocTemplate {
  id: DocTemplateId;
  name: string;
  description: string;
  /** The section a page made from it starts in. */
  section: DocTemplateSection;
  /** Its `## ` headings, in order (Blank has none). */
  sections: readonly string[];
  /** The line icon's name (the SPA maps it to its glyph). */
  icon: string;
}

export const DOC_TEMPLATES: readonly DocTemplate[] = [
  { id: "guide", name: "Guide", description: "Explain a topic from start to finish.", section: "reference", icon: "book",
    sections: ["Overview", "Before you start", "How it works", "Next steps"] },
  { id: "howto", name: "How-to", description: "The steps to get one task done.", section: "reference", icon: "checklist",
    sections: ["What you'll do", "Steps", "Check that it worked", "If something goes wrong"] },
  { id: "reference", name: "Reference", description: "Facts people look up: settings, limits, terms.", section: "reference", icon: "table",
    sections: ["Summary", "Details", "Examples", "Related pages"] },
  { id: "runbook", name: "Runbook", description: "What to do when something breaks.", section: "reference", icon: "life-ring",
    sections: ["When to use this", "Check first", "Fix it", "Roll back", "Who to tell"] },
  { id: "spec", name: "Spec", description: "How something will be built, before it is.", section: "context", icon: "ruler",
    sections: ["Problem", "Proposal", "How it works", "Risks", "Open questions"] },
  { id: "brief", name: "Product brief", description: "The why and the what of a feature.", section: "context", icon: "target",
    sections: ["Problem", "Who it's for", "What we'll build", "How we'll know it worked", "Not in scope"] },
  { id: "decision", name: "Decision record", description: "A decision, the options, and why.", section: "decisions", icon: "scales",
    sections: ["Context", "Options we considered", "Decision", "What this changes"] },
  { id: "onboarding", name: "Onboarding", description: "Help someone new find their feet.", section: "reference", icon: "sprout",
    sections: ["Welcome", "Your first day", "Your first week", "People to meet", "Where things live"] },
  { id: "blank", name: "Blank", description: "Start from an empty page.", section: "reference", icon: "page", sections: [] },
];

export const DEFAULT_DOC_TEMPLATE: DocTemplateId = "runbook";

/** The preview's line for a template with no sections. */
export const BLANK_TEMPLATE_PREVIEW = "An empty page, ready for you.";

export const isDocTemplateId = (s: string): s is DocTemplateId => (DOC_TEMPLATE_IDS as readonly string[]).includes(s);

/** A template by id; an unknown id is null (never a guess). */
export function docTemplate(id: string): DocTemplate | null {
  return DOC_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The body a new page starts with: one `## ` heading per section, a blank line under each. Blank is "". */
export function templateBody(t: DocTemplate | DocTemplateId): string {
  const tpl = typeof t === "string" ? docTemplate(t) : t;
  if (!tpl || tpl.sections.length === 0) return "";
  return tpl.sections.map((s) => `## ${s}\n\n`).join("");
}

/** The title a page gets when none is typed: "Untitled ‹template name lowercased›" ("Untitled runbook"). */
export function untitledTitle(t: DocTemplate | DocTemplateId): string {
  const tpl = typeof t === "string" ? docTemplate(t) : t;
  return `Untitled ${(tpl?.name ?? "page").toLowerCase()}`;
}
