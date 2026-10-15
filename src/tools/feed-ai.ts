// The feed's ENTRIES WRITTEN BY TROV, as every read shows them (docs/architecture/feed-and-search.md › Entries
// written by Trov): a row with `origin = 'ai'` (0061_ai_digests) gets `FeedRow.ai` — the person it was for, its
// sources (built by the server from the entry's own `artifacts`, linked to the digest's repository), when and by
// which model it was written. An agent's row gets nothing, exactly as before. Reachable from MCP's `get_feed`, so it
// imports nothing from src/ai/.
import { AI_FEED_SOURCES_SHOWN, type AiFeedMeta } from "@shared/ai-core";
import type { FeedRow } from "@shared/rows";
import { fanOut, type TenantContext } from "../data/sql";
import { hiddenFor } from "../data/ai";
import { citesOfArtifacts } from "./ai-cites";

/** A feed row as `SELECT f.*` reads it since 0061: the three provenance columns ride along. */
export type FeedDbRow = FeedRow & { origin?: string | null; model?: string | null; subject?: string | null };

/** The `ai` field of one row (null for an agent's), given the digest's repository (null = unknown: no links). */
export function aiFeedMeta(r: FeedDbRow, repo: string | null): AiFeedMeta | null {
  if (r.origin !== "ai") return null;
  const cites = citesOfArtifacts(r.artifacts, repo);
  return {
    origin: "ai",
    subject: r.subject ?? null,
    sources: cites.slice(0, AI_FEED_SOURCES_SHOWN),
    moreCount: Math.max(0, cites.length - AI_FEED_SOURCES_SHOWN),
    generatedAt: r.created_at,
    model: r.model ?? null,
  };
}

/** The rows less the entries Trov wrote that `viewer` flagged "Wrong?" (`ai_feedback`, item type `feed`, ref = the
 *  entry's id — what the Feed's button sends, `aiItemRef.feed`): hidden for that person only, the record stays. The
 *  Feed's route and MCP `get_feed` make the same cut. A failed read hides nothing. */
export async function hideWrongFor<R extends Pick<FeedRow, "id" | "ai">>(ctx: TenantContext, viewer: string | null, rows: R[]): Promise<R[]> {
  if (!viewer || !rows.some((r) => r.ai)) return rows;
  const hidden = await hiddenFor(ctx, viewer, "feed").catch(() => new Set<string>());
  return hidden.size ? rows.filter((r) => !r.ai || !hidden.has(String(r.id))) : rows;
}

/** The rows as every read returns them: the provenance columns folded into `ai` (on Trov's entries only) and
 *  dropped from the row itself. ONE more statement, and only when the page holds an entry Trov wrote (the
 *  digests' repositories, `ai_sessions`). */
export async function withAiMeta(ctx: TenantContext, rows: FeedDbRow[]): Promise<FeedRow[]> {
  const ids = rows.filter((r) => r.origin === "ai").map((r) => r.id);
  const repoOf = new Map<number, string>();
  if (ids.length) {
    // A failed read leaves the sources unlinked — never a guessed repository.
    const found = await fanOut<{ feed_id: number; repo: string }>(ctx, ids,
      (p) => `SELECT feed_id, repo FROM ai_sessions WHERE org_id = ? AND feed_id IN (${p})`, [ctx.orgId])
      .catch(() => [] as { feed_id: number; repo: string }[]);
    for (const f of found) repoOf.set(f.feed_id, f.repo);
  }
  return rows.map(({ origin, model, subject, ...row }) => {
    const ai = aiFeedMeta({ ...row, origin, model, subject }, repoOf.get(row.id) ?? null);
    return ai ? { ...row, ai } : row;
  });
}
