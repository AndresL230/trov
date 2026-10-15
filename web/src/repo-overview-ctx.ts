// What every Repo › Overview block is drawn from: the facts (shared/repo-facts-core.ts), the layout the shared
// rules decided (shared/repo-layout-core.ts) and the viewer's context. Each block is a module `web/src/repo-*.ts`
// exporting an `OverviewBlock` — a pure function to an HTML string, like the rest of the SPA — and
// `web/src/repo-overview.ts` composes them in the order the layout's opener asks for.
import type { RepoFacts } from "@shared/repo-facts-core";
import type { RepoLayout } from "@shared/repo-layout-core";
import type { PersonSummary } from "./api";

export interface OverviewCtx {
  now: number;
  /** An org admin: sees the connect card's action and setup links. */
  admin: boolean;
  /** "Preview with sample data" is on: nothing links out to a real host, no write is offered. */
  sample: boolean;
  /** For people.ts — a clickable person resolves against the org's people. */
  persons: PersonSummary[];
  layout: RepoLayout;
  /** Disclosures the viewer opened this session (keys chosen by each block, e.g. `drift:staging>production`). */
  open: ReadonlySet<string>;
}

export type OverviewBlock = (f: RepoFacts, x: OverviewCtx) => string;
