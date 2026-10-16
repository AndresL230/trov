// The plain-language filter's controller (#162; the view is ai-filter.ts — a row at the top of each screen's
// Filter menu). Every `aiFilter…` act lands here:
//   • aiFilterReveal — "Describe a filter" opens (or shuts) its field ON THE LIVE POPOVER, without a repaint, so
//     the field grows open on the app's clock and the menu's entrance never replays; focus goes to the field;
//   • aiFilterDraft  — typing keeps the draft WITHOUT a repaint (Tickets and the Feed are rebuilt on a paint, so a
//     repaint per letter would rebuild the page); a refusal shown under the field goes on the first keystroke;
//   • aiFilterRun    — Enter or Apply: `POST /ai/filter`, then the answer is applied to the screen's OWN filter
//     state through the host (main.ts), exactly as the Filter menu would set it — the server filtered nothing —
//     and the menu closes on its own exit, leaving the "Filtered: …" line above the screen;
//   • aiFilterUndo   — puts back the filter state the screen had before; the line leaves by the AI kit's one exit.
// Whether the row shows at all is the org's AI switch, read ONCE per org from `GET /ai/settings` (`ensure`) —
// a cheap existing read; nothing on the way to a screen calls a model. An Apply refused because the switch went
// off since (403 `off`, or 503 `no_key`, which reads exactly like off) turns the row off at once — no stale box
// until a reload. A hand change to the screen's filters after an apply drops the "Filtered: …" line and its Undo
// (`sync`, before every paint): the line would no longer say what is set.

import type { AppState } from "./render";
import { aiFilterLabels, aiFilterLeaveKey, aiFilterScreenOf, type AiFilterNames, type AiFilterSnapshot } from "./ai-filter";
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
  /** Close the screen's Filter menu on its own exit (main.ts `closeFilterMenu`). */
  closeMenu(screen: AiFilterScreen): void;
  /** Start the AI kit's one exit for `key` (ai-actions.ts `leave`); null under reduced motion. */
  leave(key: string): number | null;
  /** A toast (main.ts `flash`). */
  flash?(message: string): void;
}
export interface AiFilterController {
  act(act: string, arg: string | null, value: string | null): void;
  /** Read the org's AI switch once per org (on entering a screen with a typed filter). */
  ensure(): void;
  /** Before a paint: an applied line whose screen's filters were since changed by hand goes, with its Undo. */
  sync(): void;
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
      .catch(() => { /* no row: the menu is exactly what it was */ });
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

  /** The live menu section for `screen`, if its popover is open. */
  const liveTop = (screen: AiFilterScreen): HTMLElement | null =>
    typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-fm-pop] .fm-ai[data-ai-filter="${screen}"]`);

  /** Open or shut the field in place: flip the live section's state (trov.css grows it open), then focus. */
  function reveal(screen: AiFilterScreen): void {
    const u = ui();
    const open = u.reveal !== screen;
    u.reveal = open ? screen : null;
    const top = liveTop(screen);
    if (!top) { host.rerender(); return; }
    top.dataset.open = open ? "1" : "0";
    top.querySelector(".fm-ai-opt")?.setAttribute("aria-expanded", String(open));
    const box = top.querySelector<HTMLElement>(".fm-ai-box");
    if (box) box.inert = !open;
    if (open) top.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    else top.querySelector<HTMLElement>(".fm-ai-opt")?.focus({ preventScroll: true });
  }

  /** A refusal goes once the person types again — taken off the live field, no repaint. */
  function clearError(screen: AiFilterScreen): void {
    const u = ui();
    if (!u.error[screen]) return;
    u.error = { ...u.error, [screen]: undefined };
    if (typeof document === "undefined") return;
    document.getElementById(`ai-filter-${screen}-e`)?.remove();
    const input = document.getElementById(`ai-filter-${screen}`);
    input?.removeAttribute("aria-invalid");
    input?.removeAttribute("aria-describedby");
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
        u.applied = { ...u.applied, [screen]: { labels: aiFilterLabels(screen, a.filter, host.names()), unmatched: a.unmatched, undo, after: host.snapshot(screen), at: Date.now() } };
        u.undone = { ...u.undone, [screen]: undefined };
        host.rerender();
        // Done: the menu shuts on its own exit, and the line above the screen says what was set.
        host.closeMenu(screen);
      })
      .catch((e) => {
        if (mine !== seq) return;
        u.busy = null;
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        // The switch went off (or the key went) since the row was drawn: the row goes now, as off draws it — no
        // row at all — and the menu shuts on its exit with the reason said once.
        if (e instanceof OrgApiError && (e.message === "off" || e.message === "no_key")) {
          u.on = false;
          u.reveal = null;
          u.error = { ...u.error, [screen]: undefined };
          host.rerender();
          host.closeMenu(screen);
          host.flash?.(e.detail ?? AI_FILTER_MESSAGES.off);
          return;
        }
        u.error = { ...u.error, [screen]: refusalText(e) };
        host.rerender();
      });
  }

  /** An applied line whose screen no longer holds the filters it applied (changed by hand) leaves, Undo with it. */
  function sync(): void {
    const u = ui();
    for (const screen of Object.keys(u.applied) as AiFilterScreen[]) {
      const a = u.applied[screen];
      if (!a?.after || JSON.stringify(host.snapshot(screen)) === JSON.stringify(a.after)) continue;
      u.applied = { ...u.applied, [screen]: undefined };
      u.undone = { ...u.undone, [screen]: host.leave(aiFilterLeaveKey(screen)) === null ? undefined : a };
    }
  }

  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    const screen = aiFilterScreenOf(arg ?? "") ?? aiFilterScreenOf(state.screen);
    if (!screen) return;
    switch (name) {
      case "aiFilterReveal": reveal(screen); return;
      // No repaint: the field already shows what was typed.
      case "aiFilterDraft":
        u.drafts = { ...u.drafts, [screen]: (value ?? "").slice(0, AI_FILTER_TEXT_MAX) };
        clearError(screen);
        return;
      case "aiFilterRun": run(screen); return;
      case "aiFilterUndo": {
        const a = u.applied[screen];
        if (!a) return;
        u.applied = { ...u.applied, [screen]: undefined };
        // The line leaves by the kit's one exit (drawn from `undone` while it runs); none under reduced motion.
        u.undone = { ...u.undone, [screen]: host.leave(aiFilterLeaveKey(screen)) === null ? undefined : a };
        host.restore(screen, a.undo);
        host.rerender();
        return;
      }
    }
  }

  return { act, ensure, sync };
}
