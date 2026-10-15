// The AI screens' controller: every `ai…` act main.ts dispatches lands here (ai-ui.ts, repo-ai.ts, the
// Feed's Trov entries and My Work's brief are its views). Writes go to the AI routes only
// (shared/ai-core.ts `AI_ROUTES`, cookie): "Wrong?" feedback, and Accept / Dismiss on a suggestion.
// No model is called from here, or from anywhere in the SPA.
//
// "Wrong?" is optimistic: the item is hidden for this person at once (`state.ai.hidden`) and back, with a
// toast, if the write fails. Accept / Dismiss on a suggestion answer 409 `not_available` until a handler
// for its kind exists (every kind, today): the chip then says "Not available yet" in place of its buttons.
//
// On the Roadmap (its Narrative tab is `data-morph`ed) a thing that goes LEAVES with Review's exit (web-ui.md › A
// row leaving a list): an Accept / Dismiss on a suggestion card is sent at once and the card collapses
// (`leaving`, then `decided` hides it until the re-read no longer holds it; the re-read waits until no card is
// collapsing); "Wrong?" on a sprint note or the drift collapses it the same way. A failed write takes the entry
// out and the card is back as it was. Under reduced motion, or anywhere else, it goes at once.

import type { AppState } from "./render";
import { AI_EXIT_MS, AI_FEED_SOURCES, AI_NOTE_KEY, aiHiddenKey, aiLeaveKey, type AiFeedSource } from "./ai-ui";
import { AI_ITEM_TYPES, AI_THEME_RANGES, type AiFeedbackBody, type AiThemeRange } from "@shared/ai-core";
import { ApiError, PreviewBlocked, Unauthorized, acceptAiSuggestion, dismissAiSuggestion, sendAiFeedback } from "./api";

export interface AiHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** After an Accept or Dismiss went through: the screen re-reads what the decision changed (the Roadmap, whose
   *  accepted draft or narrative is now real). */
  afterDecide?(id: number, how: "accept" | "dismiss"): void;
}
export interface AiController {
  act(act: string, arg: string | null, value: string | null): void;
}

/** A "Wrong?" button's arg, read back — only a well-formed body is ever sent. */
export function parseFeedbackArg(arg: string | null): AiFeedbackBody | null {
  if (!arg) return null;
  try {
    const j = JSON.parse(arg) as Partial<AiFeedbackBody>;
    if (typeof j.itemType !== "string" || !(AI_ITEM_TYPES as readonly string[]).includes(j.itemType)) return null;
    if (typeof j.itemRef !== "string" || !j.itemRef || typeof j.kind !== "string") return null;
    return { itemType: j.itemType, itemRef: j.itemRef, kind: j.kind, model: typeof j.model === "string" ? j.model : null, promptVersion: typeof j.promptVersion === "string" ? j.promptVersion : null };
  } catch { return null; }
}

/** The handles that pressed "Got it" on this browser. */
export function readNoteSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(AI_NOTE_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function createAiController(host: AiHost): AiController {
  const { state } = host;
  const ui = () => state.ai;
  const rerender = () => host.rerender();
  const without = (xs: number[], id: number) => xs.filter((x) => x !== id);
  const reduced = (): boolean => { try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { return false; } };
  const onRoadmap = (): boolean => state.screen === "roadmap" && state.roadmapTab === "narrative";
  /** Start a row's exit (unless motion is off): `leaving` holds `key` for AI_EXIT_MS. Returns its timer. */
  function leave(key: string, then: () => void): ReturnType<typeof setTimeout> | null {
    if (reduced()) { then(); return null; }
    ui().leaving = [...ui().leaving, key];
    return setTimeout(() => { ui().leaving = ui().leaving.filter((k) => k !== key); rerender(); then(); }, AI_EXIT_MS);
  }
  const stopLeaving = (key: string, timer: ReturnType<typeof setTimeout> | null): void => {
    if (timer !== null) clearTimeout(timer);
    ui().leaving = ui().leaving.filter((k) => k !== key);
  };
  /** A decision went through: the Roadmap is read again once no card is still collapsing (one read for several). */
  let refetch: { id: number; how: "accept" | "dismiss" } | null = null;
  function settle(): void {
    if (!refetch || ui().leaving.some((k) => k.startsWith("suggestion:"))) return;
    const r = refetch;
    refetch = null;
    host.afterDecide?.(r.id, r.how);
  }

  function wrong(body: AiFeedbackBody): void {
    const key = aiHiddenKey(body.itemType, body.itemRef);
    if (ui().hidden.includes(key)) return;
    ui().hidden = [...ui().hidden, key];
    // The Roadmap's note and drift collapse out (roadmap-ai.ts); everywhere else the item goes at once.
    const timer = onRoadmap() && (body.itemType === "sprint_note" || body.itemType === "plan_drift") ? leave(key, () => {}) : null;
    rerender();
    sendAiFeedback(body)
      .then(() => host.flash("Hidden for you. Thanks: Trov is told it was wrong."))
      .catch((e) => {
        stopLeaving(key, timer);
        ui().hidden = ui().hidden.filter((k) => k !== key);
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (!(e instanceof PreviewBlocked)) host.flash("Couldn't send that. It is back on screen; try again.", 5000);
        rerender();
      });
  }

  /** A Roadmap card: the write goes out on the click and the card leaves at once (optimistic, exactly restorable). */
  function decideLeaving(id: number, how: "accept" | "dismiss"): void {
    const u = ui();
    if (u.decided.includes(id)) return;   // already taken (a second click)
    const key = aiLeaveKey.suggestion(id);
    u.decided = [...u.decided, id];
    const timer = leave(key, settle);
    rerender();
    (how === "accept" ? acceptAiSuggestion(id) : dismissAiSuggestion(id))
      .then(() => {
        host.flash(how === "accept" ? "Accepted" : "Removed");
        refetch = { id, how };
        settle();
      })
      .catch((e) => {
        // The write did not happen: the card is back where it was.
        stopLeaving(key, timer);
        u.decided = without(u.decided, id);
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (e instanceof ApiError && e.message === "not_available") {
          if (!u.unavailable.includes(id)) u.unavailable = [...u.unavailable, id];
        } else if (!(e instanceof PreviewBlocked)) {
          host.flash(e instanceof ApiError && e.message === "not_open" ? "Someone already answered that suggestion." : "Couldn't do that. Try again.", 5000);
        }
        rerender();
        settle();
      });
  }

  /** Accept (with a renamed value) or dismiss one suggestion. */
  function decide(id: number, how: "accept" | "dismiss", value?: unknown): void {
    const u = ui();
    if (value === undefined && onRoadmap() && state.roadmap.data.suggestions?.some((x) => x.id === id)) { decideLeaving(id, how); return; }
    if (u.busy.includes(id)) return;
    u.busy = [...u.busy, id];
    rerender();
    const call = how === "accept" ? acceptAiSuggestion(id, value) : dismissAiSuggestion(id);
    call
      .then(() => {
        u.busy = without(u.busy, id);
        if (u.rename?.id === id) u.rename = null;
        host.flash(how === "accept" ? "Accepted" : "Removed");
        host.afterDecide?.(id, how);
        rerender();
      })
      .catch((e) => {
        u.busy = without(u.busy, id);
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (e instanceof ApiError && e.message === "not_available") {
          if (!u.unavailable.includes(id)) u.unavailable = [...u.unavailable, id];
          if (u.rename?.id === id) u.rename = null;
        } else if (!(e instanceof PreviewBlocked)) {
          host.flash(e instanceof ApiError && e.message === "not_open" ? "Someone already answered that suggestion." : "Couldn't do that. Try again.", 5000);
        }
        rerender();
      });
  }

  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    switch (name) {
      case "aiWrong": { const b = parseFeedbackArg(arg); if (b) wrong(b); return; }
      case "aiFeedSource":
        if ((AI_FEED_SOURCES as readonly string[]).includes(arg ?? "")) u.feedSource = arg as AiFeedSource;
        break;
      case "aiNoteGotIt": {
        const me = state.me?.handle;
        if (!me) return;
        if (!u.noteSeen.some((h) => h.toLowerCase() === me.toLowerCase())) u.noteSeen = [...u.noteSeen, me];
        try { localStorage.setItem(AI_NOTE_KEY, JSON.stringify(u.noteSeen)); } catch { /* ignore */ }
        break;
      }
      case "aiThemesRange":
        if ((AI_THEME_RANGES as readonly string[]).includes(arg ?? "")) u.themesRange = arg as AiThemeRange;
        break;
      case "aiThemesLane": u.themesLane = arg; break;
      case "aiThemesEdit": {
        // The proposed themes are the only editing there is yet: go to them; otherwise say so.
        const target = host.mount.querySelector<HTMLElement>("#repo-themes-proposed");
        if (target) {
          const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
          target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
          target.focus({ preventScroll: true });
        } else host.flash("Editing themes is not available yet.");
        return;
      }
      case "aiReason": u.reasonOpen = u.reasonOpen === arg ? null : arg; break;
      case "aiAccept": { const id = Number(arg); if (Number.isInteger(id)) decide(id, "accept"); return; }
      case "aiDismiss": { const id = Number(arg); if (Number.isInteger(id)) decide(id, "dismiss"); return; }
      case "aiRenameOpen": {
        const id = Number(arg);
        if (!Number.isInteger(id)) return;
        const lane = Object.values(state.repo.data?.themes ?? {}).flatMap((t) => t.lanes).find((l) => l.suggestionId === id);
        u.rename = { id, draft: lane?.name ?? "" };
        rerender();
        host.mount.querySelector<HTMLInputElement>(`#ai-rename-${id}`)?.focus();
        return;
      }
      // Typing keeps the draft without a repaint (the Repo screen is rebuilt on a paint, not patched).
      case "aiRenameDraft": if (u.rename) u.rename.draft = value ?? ""; return;
      case "aiRenameCancel": {
        const id = u.rename?.id;
        u.rename = null;
        rerender();
        if (id !== undefined) host.mount.querySelector<HTMLElement>(`[data-field="aiRenameOpen:${id}"]`)?.focus();
        return;
      }
      case "aiRenameSave": {
        const r = u.rename;
        const name = (r?.draft ?? "").trim();
        if (!r || !name) return;
        decide(r.id, "accept", { name });
        return;
      }
      default: return;
    }
    rerender();
  }
  return { act };
}
