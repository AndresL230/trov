import type { FeedEntry } from "@shared/contract";

/**
 * Shape MCP `append_feed` tool arguments into a contract FeedEntry — the thin
 * adapter that sits in front of the gate (ingestFeedEntry). Pulled out of mcp.ts
 * so it carries no MCP SDK dependency and can be unit-tested directly.
 *
 * Artifacts are observed session output (issues/prs/commits) recorded verbatim.
 * Per shared/contract.ts, prs/commits are string[] and issues are number[];
 * omitted lists default to [] so they round-trip cleanly through the gate.
 */
export function feedEntryFromMcpArgs(args: {
  summary: string;
  brief?: string;
  body?: string;
  tags?: string[];
  prs?: string[];
  commits?: string[];
  issues?: number[];
}): FeedEntry {
  return {
    summary: args.summary,
    ...(args.brief !== undefined ? { brief: args.brief } : {}),
    body: args.body ?? "",
    tags: args.tags ?? [],
    artifacts: {
      prs: args.prs ?? [],
      commits: args.commits ?? [],
      issues: args.issues ?? [],
    },
  };
}
