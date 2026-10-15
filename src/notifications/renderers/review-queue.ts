import type { NotificationKind, Section } from "@shared/notifications";
import { type TenantContext, all, ph } from "../../data/sql";
import { list_proposals, list_adrs } from "../../tools/reads";
import { planAndAiRuns } from "../../plans/gate";
import { queueLine } from "../assemble";

const DEEP_LINK = "/#review";

/** The Review card's item refs (`ai_suggestions.item_ref` of `review.risk`, Phase C: item type `proposal`). */
const proposalRef = (slug: string, version: number) => `doc:${slug}@${version}`;
const decisionRef = (id: number) => `adr:${id}`;

/**
 * How many of the waiting items Sift rated "changes a decision" (Phase C's `review.risk`, the open suggestion the
 * Review card shows). Only while the org's AI switch is on; unknown is left out of the line, never 0.
 */
async function changesADecision(ctx: TenantContext, refs: string[]): Promise<number | null> {
  if (!refs.length || !(await planAndAiRuns(ctx)).enabled) return null;
  const rows = await all<{ item_ref: string }>(ctx,
    `SELECT DISTINCT item_ref FROM ai_suggestions
      WHERE org_id = ? AND item_type = 'proposal' AND kind = 'review.risk' AND state = 'open'
        AND json_extract(value_json, '$.risk') = 'decision' AND item_ref IN (${ph(refs.length)})`,
    ctx.orgId, ...refs);
  return rows.length;
}

/**
 * review_queue — ONE line (Phase E): "Review: 3 waiting, 1 changes a decision". What waits for a person: open
 * proposals (staged doc versions newer than the live doc) and draft decisions. Org-wide, so the person is not
 * consulted. Null when both queues are empty.
 */
async function render(ctx: TenantContext): Promise<Section | null> {
  const proposals = await list_proposals(ctx);
  const decisions = await list_adrs(ctx, "draft");
  const waiting = proposals.length + decisions.length;
  if (waiting === 0) return null;
  const risky = await changesADecision(ctx, [...proposals.map((p) => proposalRef(p.slug, p.version)), ...decisions.map((d) => decisionRef(d.id))]);
  const rest = `${waiting} waiting${risky ? `, ${risky} ${risky === 1 ? "changes" : "change"} a decision` : ""}`;
  return queueLine({ label: "Review", rest, deepLink: DEEP_LINK, linkLabel: "Review" });
}

export const reviewQueueKind: NotificationKind<TenantContext> = {
  id: "review_queue",
  label: "Review",
  description: "One line: how many doc changes and decisions wait for review.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "off"],
  render,
};
