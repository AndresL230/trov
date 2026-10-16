// SIFT ON NEW ITEMS — the AI pass's `tag.fit` job (docs/architecture/ai.md › Jobs; feed-and-search.md › Tags;
// docs/superpowers/specs/2026-10-15-server-ai-build.md › Phase C). When a doc is promoted (and when an artifact is
// created or versioned) the router marks `card:tagfit:<type>:<id>`; on the next tick this job asks Jev, in ONE
// request, Sift's own question (src/tools/tag-fit.ts `fitQuestion`) once per active tag the item does not carry —
// one `noul` question per tag — and stores each answer by Sift's own bands (`storeNewItemFit` → `storeFit`, the ONE
// writer a run uses too): a "fits" at 0.85 or more ADDS the tag, with its provenance and an Undo (a one-item run of
// that tag, `undoTagFit`); from 0.6 up to it the tag is SUGGESTED for a person; below, nothing.
//
// The rules it keeps, all Sift's:
//   • BOTH SWITCHES. The pass serves an org only while `orgs.ai_automation` is on; this job's input reads Sift's own
//     switch too (`siftSwitches`, one statement) and sends nothing while either is off.
//   • THE ALLOWANCE AND METERING are the pass's: one request is one `jev_checks`, counted `ai_suggest` BEFORE it —
//     the metric a run counts.
//   • PERSON OVER AI. A tag the item carries, or one a person dismissed, removed or undid on it (or that already
//     waits as a suggestion), is never asked about (`itemFitInput`), so it is never added again.
//   • EVIDENCE AS THE REASON. A suggestion's reason is the item's own words around the tag's (the org's full-text
//     index), else Sift's score said as such — never model text: Jev writes none.
//   • An artifact cannot carry tags yet (`TAG_ITEM_TYPES`): its card is written as it is, with no request.
//
// It imports no model client (the pass asks Jev for it) and nothing reachable from src/mcp.ts imports it.
import { TAG_ITEM_TYPES } from "@shared/tags-core";
import type { DirtyScope } from "../data/ai-dirty";
import type { TenantContext } from "../data/sql";
import { TAG_FIT_KIND, fitBand, fitQuestion, itemFitInput, siftSwitches, storeNewItemFit, type ItemFitInput } from "../tools/tag-fit";
import type { JevAnswers, JevJob, JevRequest, JobItem } from "./jobs";

type JevQuestion = JevRequest["questions"][string];

/** Recorded on what it writes. The question is a run's (`jev-fit-1`); this names the one-request, every-tag form. */
export const TAG_FIT_ITEMS_PROMPT_VERSION = "jev-fit-items-1";
/** The card keys it takes: `tagfit:<type>:<id>`. */
export const TAG_FIT_KEY_PREFIX = "tagfit:";

/** `tagfit:doc:<slug>` → `{ type: "doc", id: "<slug>" }`; null when it is not one. */
export function tagFitKey(key: string): { type: string; id: string } | null {
  if (!key.startsWith(TAG_FIT_KEY_PREFIX)) return null;
  const rest = key.slice(TAG_FIT_KEY_PREFIX.length);
  const at = rest.indexOf(":");
  return at > 0 && at < rest.length - 1 ? { type: rest.slice(0, at), id: rest.slice(at + 1) } : null;
}

/** The question id of the `k`th tag (Jev's ids are Trov's own, never a tag's text). */
const qid = (k: number): string => `t${k}`;

export const TAG_FIT_ITEM_JOB: JevJob<ItemFitInput> = {
  name: "tag.fit:new-item",
  provider: "jev",
  kind: TAG_FIT_KIND,
  scope: "card",
  keyPrefix: TAG_FIT_KEY_PREFIX,
  promptVersion: TAG_FIT_ITEMS_PROMPT_VERSION,

  async input(ctx: TenantContext, scope: DirtyScope): Promise<ItemFitInput | null> {
    const k = tagFitKey(scope.key);
    if (!k || !(TAG_ITEM_TYPES as readonly string[]).includes(k.type)) return null; // an artifact: nothing to tag yet
    // Sift's own switch (and the org's, again): off = nothing is sent, the card is written as it is.
    if (!(await siftSwitches(ctx)).on) return null;
    return itemFitInput(ctx, k.type, k.id);
  },

  ask({ input }: JobItem<ItemFitInput>): JevRequest {
    const questions: Record<string, JevQuestion> = {};
    input.tags.forEach((t, k) => { questions[qid(k)] = { type: "noul", ...fitQuestion(t.name, t.description) }; });
    // What a run sends for a candidate: the title, then the excerpt.
    return { state: `${input.title}${input.text ? `\n\n${input.text}` : ""}`, questions };
  },

  async write(ctx: TenantContext, { input }: JobItem<ItemFitInput>, res: JevAnswers): Promise<boolean> {
    const judged = input.tags.flatMap((t, k) => {
      const a = res.answers[qid(k)];
      if (!a || a.type !== "noul") return [];
      // Sift's reading of a yes/no probability (src/tools/classify.ts `classify`): "fits" at 0.5 or more, and the
      // confidence is the probability of the answer given.
      const fits = a.p >= 0.5;
      return [{ tag: t, fits, confidence: fits ? a.p : 1 - a.p }];
    });
    // Every answer malformed: no judgement at all — a failed attempt, never a guess.
    if (!judged.length) return false;
    // Surest first; never more ADDED than the item may still carry (`ITEM_TAGS_MAX`) — past that, nothing.
    judged.sort((a, b) => Number(b.fits) - Number(a.fits) || b.confidence - a.confidence);
    let room = input.room;
    for (const j of judged) {
      const band = fitBand(j.fits, j.confidence);
      if (!band) continue;
      if (band === "add" && room <= 0) continue;
      const did = await storeNewItemFit(ctx, {
        type: input.type, id: input.id, tag: j.tag.name, fits: j.fits, confidence: j.confidence,
        reason: j.tag.evidence, model: res.model, promptVersion: TAG_FIT_ITEMS_PROMPT_VERSION,
      });
      if (did === "added") room--;
    }
    return true;
  },
};
