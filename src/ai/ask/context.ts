// What every Ask tool runs with (docs/architecture/ask.md): the COOKIE person's tenant context — never another
// org's, never a bearer's — and the few things a tool needs beside it.
import type { Env } from "../../env";
import type { TenantContext } from "../../data/context";
import { artifactOrigin, type ArtifactAgentCtx } from "../../tools/artifacts-agent";
import type { DocsSource } from "./docs";

/** The areas this turn's search calls looked in — what `show_not_found` reports, with counts the server computes. */
export type SearchArea = "docs" | "tickets" | "feed" | "artifacts" | "decisions" | "sprints" | "prompts" | "handoffs" | "trov_docs";

export interface AskToolCtx {
  env: Env;
  ctx: TenantContext;
  /** The cookie person — the author of every write and the viewer of every read. */
  handle: string;
  orgSlug: string;
  /** The request's origin (`PUBLIC_ORIGIN` wins) — for absolute links in artifact results. */
  origin: string;
  threadId: number;
  docs: DocsSource;
  now: () => Date;
  /** This turn's searches: area → the earliest `since` asked (feed), or null. */
  searched: Map<SearchArea, string | null>;
}

/** The artifacts adapter's context, as the person: author and viewer of every call. */
export const artifactCtxOf = (c: AskToolCtx): ArtifactAgentCtx => ({
  tenant: c.ctx, handle: c.handle, origin: artifactOrigin(c.env.PUBLIC_ORIGIN, c.origin), orgSlug: c.orgSlug,
  downloadSecret: c.env.COOKIE_SECRET, bucket: c.env.ARTIFACTS_BUCKET,
});
