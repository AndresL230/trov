import type { NotificationKind, Section } from "@shared/notifications";
import type { TenantContext } from "../../data/sql";
import { legacyDb } from "../../data/legacy";
import { list_proposals, list_adrs } from "../../tools/reads";
import { legacyCtx } from "../../data/legacy-bridge";
import { escapeHtml } from "../html";
import { EMAIL_STYLE as S, EMAIL_CARD as K, EMAIL_SPACE as SP, THEME } from "../assemble";

const DEEP_LINK = "/#review";
const TOP = 5;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * review_queue — what is waiting for a human: open Proposals (staged doc
 * versions newer than the live doc) and Decisions (draft ADRs). Org-wide, so
 * the userId is not consulted. Null when both queues are empty.
 */
async function render(ctx: TenantContext): Promise<Section | null> {
  const proposals = await list_proposals(ctx);
  const decisions = await list_adrs(ctx, "draft");
  if (proposals.length === 0 && decisions.length === 0) return null;

  const items = [
    ...proposals.slice(0, TOP).map((p) => ({
      kind: "proposal" as const,
      title: `${cap(p.section)} / ${p.title}`,
      summary: p.summary ?? `${p.change_kind ?? "edit"} v${p.version}`,
      meta: `by ${p.author}${p.confidence ? ` · ${p.confidence} confidence` : ""}`,
      low: Boolean(p.low_confidence) || p.confidence === "low",
    })),
    ...decisions.slice(0, TOP).map((d) => ({
      kind: "decision" as const,
      title: `ADR-${String(d.id).padStart(3, "0")} — ${d.title}`,
      summary: "ready to ratify",
      meta: `by ${d.created_by}`,
      low: false,
    })),
  ];

  const html =
    `<table ${S.table} style="margin-top:${SP.m}px;">` +
    items
      .map(
        (it, i) =>
          `<tr><td style="padding:${i === 0 ? 0 : SP.m - SP.xs}px 0 ${SP.m - SP.xs}px 0;${i === 0 ? "" : `border-top:1px solid ${THEME.border.light};`}">` +
          `<div>${K.chip(it.kind.toUpperCase(), it.kind === "proposal" ? "accent" : "blue")}${it.low ? ` ${K.chip("LOW CONFIDENCE", "amber")}` : ""}` +
          `<span style="${S.body}font-weight:500;padding-left:8px;">${escapeHtml(it.title)}</span></div>` +
          `<div style="${S.muted}padding-top:${SP.xs}px;">${escapeHtml(it.summary)}</div>` +
          `<div style="${S.muted}font-size:12px;line-height:16px;padding-top:${SP.xs}px;">${escapeHtml(it.meta)}</div>` +
          `</td></tr>`
      )
      .join("") +
    `</table>`;
  const text = items.map((it) => `  ${it.kind.padEnd(9)} ${it.title} — ${it.summary} (${it.meta}${it.low ? ", LOW CONFIDENCE" : ""})`).join("\n");
  const parts = [proposals.length ? plural(proposals.length, "proposal", "proposals") : null, decisions.length ? plural(decisions.length, "decision", "decisions") : null].filter(Boolean);
  const summary = `${parts.join(", ")} waiting on review`;

  return { heading: "Review queue", summary, html, text, deepLink: DEEP_LINK, linkLabel: "Review" };
}

export const reviewQueueKind: NotificationKind<TenantContext> = {
  id: "review_queue",
  label: "Review queue",
  description: "What is waiting on your review in Triage.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "off"],
  render,
};
