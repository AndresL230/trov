// THE CACHED ORG PREFIX (docs/architecture/ai.md › The prefix): what every Haiku prompt of the AI pass starts with,
// before the scope's own input — the org's name, its tag vocabulary, its active themes, its active sprints and the
// plan narrative. The pass builds it ONCE per org per tick (only when a Claude call is about to happen) and sends
// it as the request's `prefix` with `cache: true` (src/ai/client.ts): a `cache_control: {type: "ephemeral"}`
// breakpoint on that block, so the system prompt and the prefix are read from the prompt cache by the org's next
// call within the cache's lifetime.
//
// ONE ORG PER PROMPT: everything here is read through the org's own context. D1 only — no model, no network.
// Each part is cut to a fixed size so the prefix stays a cacheable, bounded block.
import { all, first, type TenantContext } from "../data/sql";

/** Bounds: a prefix is a few kilobytes at most. */
export const PREFIX_TAGS_MAX = 60;
export const PREFIX_SPRINTS_MAX = 10;
export const PREFIX_NARRATIVE_MAX = 4000;

export interface OrgPrefixParts {
  org: string;
  tags: { name: string; description: string }[];
  /** Active themes — none until Phase D's `repo_themes` exists. */
  themes: string[];
  sprints: { title: string; target: string | null }[];
  narrative: string;
}

const line = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The parts, read from D1 (one statement each; a part whose read fails is empty, so a prefix is never wrong, only
 *  shorter). */
export async function orgPrefixParts(ctx: TenantContext): Promise<OrgPrefixParts> {
  const safe = <T>(p: Promise<T>, empty: T): Promise<T> => p.catch(() => empty);
  const [org, tags, sprints, plan] = await Promise.all([
    safe(first<{ name: string }>(ctx, `SELECT name FROM orgs WHERE id = ?`, ctx.orgId), null),
    safe(all<{ name: string; description: string }>(ctx,
      `SELECT name, description FROM org_tags WHERE org_id = ? AND retired_at IS NULL ORDER BY name LIMIT ?`, ctx.orgId, PREFIX_TAGS_MAX), []),
    safe(all<{ title: string; target_date: string | null }>(ctx,
      `SELECT title, target_date FROM sprints WHERE org_id = ? AND status = 'in_progress' ORDER BY target_date IS NULL, target_date, id LIMIT ?`, ctx.orgId, PREFIX_SPRINTS_MAX), []),
    safe(first<{ narrative: string }>(ctx, `SELECT narrative FROM plan WHERE org_id = ?`, ctx.orgId), null),
  ]);
  return {
    org: line(org?.name ?? ""),
    tags: tags.map((t) => ({ name: line(t.name, 40), description: line(t.description ?? "", 160) })),
    themes: [], // SEAM: Phase D — the org's active themes (`repo_themes`, 0064) go here.
    sprints: sprints.map((s) => ({ title: line(s.title, 120), target: s.target_date })),
    narrative: (plan?.narrative ?? "").trim().slice(0, PREFIX_NARRATIVE_MAX),
  };
}

/** The prefix text: stable for stable data (so the cache hits), sections in a fixed order, an empty part said as
 *  "none" — never left to the model to guess. */
export function renderPrefix(p: OrgPrefixParts): string {
  const list = (items: string[]): string => (items.length ? items.map((s) => `- ${s}`).join("\n") : "none");
  return [
    `# Organization\n${p.org || "(unnamed)"}`,
    `# Tag vocabulary\n${list(p.tags.map((t) => (t.description ? `${t.name}: ${t.description}` : t.name)))}`,
    `# Active themes\n${list(p.themes)}`,
    `# Active sprints\n${list(p.sprints.map((s) => (s.target ? `${s.title} (target ${s.target})` : s.title)))}`,
    `# Plan narrative\n${p.narrative || "none"}`,
  ].join("\n\n");
}

/** The org's prefix, ready to send. */
export async function orgPrefix(ctx: TenantContext): Promise<string> {
  return renderPrefix(await orgPrefixParts(ctx));
}
