// LOCAL DEVELOPMENT ONLY: the AI screens with sample content, so the web build can be seen and screenshotted
// against `wrangler dev` before any producer exists (docs/architecture/env.md › Local development only).
//
// `LOCAL_AI_PREVIEW` (a `.dev.vars` value, never a deployed var) names a mode of `AI_PREVIEW_MODES`
// (`ready`, `empty`, `capped`, `proposed`); anything else is ignored. It is guarded like the other local
// stand-ins (src/platform/loopback.ts): honoured only for a request to a LOOPBACK http origin — the
// address `wrangler dev` serves on, which no deployed Worker is ever reached at — and never while the
// Worker holds a live Stripe key (`holdsLiveKey`). And it keeps THE read rule (`aiPreviewShown`, src/plans/gate.ts
// `aiShown`): with the org's switch off or no Anthropic key, the reads carry no fixture — the off state, exactly as
// production draws it (owner ruling Q13). With it honoured, four cookie reads carry the fixtures
// (shared/ai-fixtures.ts): `/me/dashboard` → `brief`, `/repo/dashboard` → `state` + `themes`, and `/feed`
// → the two entries written by Trov, merged by `created_at`, and `/ai/settings` → all four allowances' numbers
// and the eligibility (the switches stay the org's real ones; what is sent names both providers in every
// mode). And `POST /ai/filter` answers from the screen's filter fixture (src/ai/filter.ts `previewAiFilter`). MCP
// never: the preview is for the screens.
//
// Production omits every AI field: nothing produces one yet.
import type { Env } from "../env";
import type { FeedRow } from "@shared/rows";
import { aiPreviewFixtures, isAiPreviewMode, type AiPreviewMode } from "@shared/ai-fixtures";
import { holdsLiveKey, type LiveKeyEnv } from "../billing/config";
import { loopbackOrigin } from "../platform/loopback";
import type { TenantContext } from "../data/context";
import { aiShown } from "../plans/gate";

/** The mode to preview, or null: unset or not a mode, a request that did not come to a loopback http origin
 *  (anything but `wrangler dev`), or a live Stripe key beside it. */
export function aiPreviewMode(env: Pick<Env, "LOCAL_AI_PREVIEW"> & LiveKeyEnv, requestUrl: string): AiPreviewMode | null {
  const mode = typeof env.LOCAL_AI_PREVIEW === "string" ? env.LOCAL_AI_PREVIEW.trim() : "";
  if (!isAiPreviewMode(mode)) return null;
  if (!loopbackOrigin(requestUrl) || holdsLiveKey(env)) return null;
  return mode;
}

export type AiPreview = ReturnType<typeof aiPreviewFixtures>;

/** Every sample row the preview merges into `/feed`: the entries Trov wrote, and the agent entries Sift rated. */
export const previewFeedRows = (p: AiPreview): FeedRow[] => [...p.feed, ...p.feedImportance];

/** The fixtures for this request, or null (see `aiPreviewMode`). */
export function aiPreview(env: Pick<Env, "LOCAL_AI_PREVIEW"> & LiveKeyEnv, requestUrl: string, now: Date = new Date()): AiPreview | null {
  const mode = aiPreviewMode(env, requestUrl);
  return mode ? aiPreviewFixtures(mode, now) : null;
}

/** The fixtures for a screen's read, or null — `aiPreview`, AND only under THE read rule (src/plans/gate.ts
 *  `aiShown`): with the org's switch off, or no Anthropic key in `.dev.vars`, the preview shows exactly what
 *  production shows (no field), so the off state can be seen and screenshotted (owner ruling Q13). Its one
 *  statement is read only when a preview mode is set. */
export async function aiPreviewShown(ctx: TenantContext, env: Pick<Env, "LOCAL_AI_PREVIEW"> & LiveKeyEnv, requestUrl: string, now: Date = new Date()): Promise<AiPreview | null> {
  const mode = aiPreviewMode(env, requestUrl);
  if (!mode || !(await aiShown(ctx, now)).shown) return null;
  return aiPreviewFixtures(mode, now);
}

/** `/roadmap` with the preview's roadmap samples (shared/ai-fixtures.ts `roadmapFixture`): a note on each ACTIVE
 *  sprint, in roadmap order, while the samples last; the drift line; and — for an ADMIN only — the two suggestion
 *  cards. `empty` (no fixture) leaves the read exactly as it was. */
export function withPreviewRoadmap<P extends { sprints: { active: boolean; note?: unknown }[]; drift?: unknown; suggestions?: unknown }>(
  plan: P, fx: AiPreview["roadmap"], o: { admin: boolean },
): P {
  if (!fx) return plan;
  let i = 0;
  const sprints = plan.sprints.map((s) => (s.active && i < fx.notes.length ? { ...s, note: fx.notes[i++] } : s));
  return { ...plan, sprints, drift: fx.drift, ...(o.admin ? { suggestions: fx.suggestions } : {}) };
}

/** `/feed`'s page with the preview's entries merged in, newest first, as the page was asked for: none when
 *  it filters by another author or by tags (the fixtures have none), none older than `since`, cut to `limit`. */
export function withPreviewFeed(rows: FeedRow[], extra: FeedRow[], filter: { author?: string; aboutAuthor?: boolean; tags?: string[]; since?: string; limit?: number }): FeedRow[] {
  if (filter.tags?.length) return rows;
  const byAuthor = (r: FeedRow) => !filter.author || filter.author === r.author || (!!filter.aboutAuthor && r.ai?.origin === "ai" && r.ai.subject === filter.author);
  const mine = extra.filter((r) => byAuthor(r) && (!filter.since || r.created_at >= filter.since));
  if (!mine.length) return rows;
  const limit = Math.trunc(Math.min(Math.max(Number.isFinite(filter.limit) ? (filter.limit as number) : 50, 1), 500));
  return [...rows, ...mine].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id).slice(0, limit);
}
