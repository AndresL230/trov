// The plain-language filter's controller (#162; the view is ai-filter.ts). Every `aiFilter…` act lands here:
//   • aiFilterDraft — typing keeps the draft WITHOUT a repaint (Tickets and the Feed are rebuilt on a paint,
//     so a repaint per letter would rebuild the page);
//   • aiFilterRun   — Enter or Apply: `POST /ai/filter`, then the answer is applied to the screen's OWN filter
//     state through the host (main.ts), exactly as the Filter menu would set it — the server filtered nothing;
//   • aiFilterUndo  — puts back the filter state the screen had before.
// Whether the box shows at all is the org's AI switch, read ONCE per org from `GET /ai/settings` (`ensure`) —
// a cheap existing read; nothing on the way to a screen calls a model.

import type { AppState } from "./render";
import { aiFilterLabels, aiFilterScreenOf, type AiFilterNames, type AiFilterSnapshot } from "./ai-filter";
import { AI_FILTER_MESSAGES, AI_FILTER_TEXT_MAX, type AiFilterByScreen, type AiFilterScreen } from "@shared/ai-filter-core";
import { OrgApiError, PreviewBlocked, Unauthorized, getAiSettings, planLimitText, rateLimitText, runAiFilter } from "./api";

export interface AiFilterHost {
  state: AppState;
  rerender(): void;
  unauth(e: unknown): void;
  /** The caller's role in the current org (who a plan refusal tells to act). */
  role(): "owner" | "admin" | "member" | null;
  /** The screen's filter state now, as Undo will put it back. */
  snapshot(screen: AiFilterScreen): AiFilterSnapshot;
  /** Set the screen's filters to exactly `filter` — a field it leaves out goes back to "no filter" — and
   *  reload what the server filters (the ticket queue, the Feed). */
  apply<S extends AiFilterScreen>(screen: S, filter: AiFilterByScreen[S]): void;
  restore(screen: AiFilterScreen, snapshot: AiFilterSnapshot): void;
  names(): AiFilterNames;
}
export interface AiFilterController {
  act(act: string, arg: string | null, value: string | null): void;
  /** Read the org's AI switch once per org (on entering a screen with a box). */
  ensure(): void;
}

export function createAiFilterController(host: AiFilterHost): AiFilterController {
  const { state } = host;
  const ui = () => state.aiFilter;
  let seq = 0;

  function ensure(): void {
    const slug = state.orgSlug;
    if (!slug || ui().org === slug) return;
    ui().org = slug;
    ui().on = false;
    getAiSettings(slug)
      .then((s) => {
        if (state.orgSlug !== slug) return;
        ui().on = s.enabled && s.eligibility !== "no_key";
        host.rerender();
      })
      .catch(() => { /* no box: the screen is exactly what it was */ });
  }

  /** The sentence a refusal is shown as. */
  function refusalText(e: unknown): string {
    if (e instanceof PreviewBlocked) return "Not available in the state preview.";
    const plan = planLimitText(e, host.role());
    if (plan) return plan;
    const limited = rateLimitText(e);
    if (limited) return limited.replace("today's limit", "this hour's limit");
    if (e instanceof OrgApiError && e.detail) return e.detail;
    return "Couldn't read that. Try again.";
  }

  function run(screen: AiFilterScreen): void {
    const u = ui();
    const slug = state.orgSlug;
    const text = u.drafts[screen].trim();
    if (!slug || u.busy) return;
    if (!text) { u.error = { ...u.error, [screen]: AI_FILTER_MESSAGES.invalid }; host.rerender(); return; }
    const mine = ++seq;
    u.busy = screen;
    u.error = { ...u.error, [screen]: undefined };
    host.rerender();
    runAiFilter(slug, { screen, text })
      .then((a) => {
        if (mine !== seq || state.orgSlug !== slug) return;
        u.busy = null;
        // The screen's state before THIS filter — or, when one was applied already, before the first, so
        // Undo always goes back to what the person had set by hand.
        const undo = u.applied[screen]?.undo ?? host.snapshot(screen);
        host.apply(screen, a.filter);
        u.applied = { ...u.applied, [screen]: { labels: aiFilterLabels(screen, a.filter, host.names()), unmatched: a.unmatched, undo } };
        host.rerender();
      })
      .catch((e) => {
        if (mine !== seq) return;
        u.busy = null;
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        u.error = { ...u.error, [screen]: refusalText(e) };
        host.rerender();
      });
  }

  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    const screen = aiFilterScreenOf(arg ?? "") ?? aiFilterScreenOf(state.screen);
    if (!screen) return;
    switch (name) {
      // No repaint: the field already shows what was typed. A stale error goes once the person types.
      case "aiFilterDraft":
        u.drafts = { ...u.drafts, [screen]: (value ?? "").slice(0, AI_FILTER_TEXT_MAX) };
        return;
      case "aiFilterRun": run(screen); return;
      case "aiFilterUndo": {
        const a = u.applied[screen];
        if (!a) return;
        u.applied = { ...u.applied, [screen]: undefined };
        host.restore(screen, a.undo);
        host.rerender();
        return;
      }
    }
  }

  return { act, ensure };
}
