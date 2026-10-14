// Controlled vocabulary. These values MUST match migrations/0002_seed_vocab.sql.
//   SECTIONS — the gate's source of truth for a doc's section (fixed, the same for every org).
//   TAGS     — the six STARTER tags every organization begins with (0056_org_tags; shared/tags-core.ts
//              STARTER_TAGS adds each one's description and colour). NOT the gate's tag vocabulary: a
//              feed entry's tags are checked against the ORG's own list (src/tools/tags.ts), which an
//              admin may have renamed or added to.
export const SECTIONS = ["reference", "context", "decisions", "needs-triage"] as const;
export const TAGS = ["auth", "architecture", "infra", "api", "ui", "data"] as const;

export type Section = (typeof SECTIONS)[number];

export const isSection = (s: string): s is Section =>
  (SECTIONS as readonly string[]).includes(s);
