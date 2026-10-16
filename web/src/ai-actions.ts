// The AI screens' controller: every `ai…` act main.ts dispatches lands here (ai-ui.ts, repo-ai.ts, the
// Feed's Trov entries and My Work's brief are its views). Writes go to the AI routes only
// (shared/ai-core.ts `AI_ROUTES`, cookie): "Wrong?" feedback, and Accept / Dismiss on a suggestion.
// No model is called from here, or from anywhere in the SPA.
//
// "Wrong?" is optimistic: the item is hidden for this person at once (`state.ai.hidden`) and back, with a
// toast, if the write fails. Accept / Dismiss on a suggestion answer 409 `not_available` until a handler
// for its kind exists (every kind, today): the chip then says "Not available yet" in place of its buttons.
//
// Everything that goes LEAVES by the AI kit's one exit (ai-ui.ts › Leaving) — on the Roadmap too (its sprint note,
// the drift, a sprint-draft or narrative card): "Wrong?" collapses the item; an Accept / Dismiss collapses the card
// and its screen re-reads once the exit is done. Under reduced motion it goes at once.

import type { AppState } from "./render";
import { AI_EXIT_MS, AI_FEED_SOURCES, AI_NOTE_KEY, AI_NOTE_LEAVING, aiHiddenKey, aiSuggestionKey, type AiFeedSource } from "./ai-ui";
import { AI_ITEM_TYPES, AI_THEME_RANGES, type AiFeedbackBody, type AiThemeRange } from "@shared/ai-core";
import { ApiError, OrgApiError, PreviewBlocked, Unauthorized, acceptAiSuggestion, dismissAiSuggestion, sendAiFeedback } from "./api";

export interface AiHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** Re-read the Repo dashboard (after a proposed theme is decided, so the lane shows what it became). */
  reloadRepo?(): void;
  /** A suggestion was accepted or dismissed: the screen it was on re-reads what changed (Phase C — the ticket, the
   *  Unplaced queue, Review). */
  decided?(id: number, how: "accept" | "dismiss"): void;
  /** One-shot `.cnpy-flash` on what matches, after the next paint (main.ts `pendingFlash`). */
  flashNext?(selector: string): void;
}
export interface AiController {
  act(act: string, arg: string | null, value: string | null): void;
  /** Start `key`'s exit — the kit's ONE exit (› Leaving), for an item another controller draws (the typed
   *  filter's applied line after Undo). Null under reduced motion: no exit, gone at once. */
  leave(key: string): number | null;
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

/** What a refused Accept / Dismiss says: a 400's own sentence as the server wrote it (a theme name that is taken, a
 *  Roadmap writer's refusal — Q20, Q21/Q40), else what is known, else the generic line. */
export function refusalText(e: unknown): string {
  if (e instanceof OrgApiError && e.status === 400 && e.detail) return e.detail;
  if (e instanceof ApiError && e.message === "not_open") return "Someone already answered that suggestion.";
  return "Couldn't do that. Try again.";
}

/** The server's answer to a SAMPLE suggestion's decision under `LOCAL_AI_PREVIEW` (src/ai/routes.ts; Q5). */
const isPreviewAnswer = (r: unknown): boolean => !!r && typeof r === "object" && (r as { preview?: unknown }).preview === true;

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
  const stopLeaving = (key: string) => { ui().leaving = ui().leaving.filter((l) => l.key !== key); };
  /** Draw `key` leaving for AI_EXIT_MS (ai-ui.ts › Leaving), then let it go; returns when it began. Gone at once
   *  under reduced motion (no exit). `hold`: a decided suggestion — it stays drawn collapsed until its screen's
   *  re-read drops it (`aiLeaving`'s `hold`), so its entry is not cleared on a timer (entries older than 10 s are
   *  dropped on the next exit); it is recorded under reduced motion too, where `.cnpy-ai-leave` is `display:none`,
   *  so it is gone at once. */
  function leave(key: string, hold = false, after?: () => void): number | null {
    if (reduced() && !hold) return null;
    const at = Date.now();
    // A sample decided in the preview is never re-read away, so its held exit is kept (Q5).
    const kept = (k: string) => ui().previewDecided.some((id) => aiSuggestionKey(id) === k);
    ui().leaving = [...ui().leaving.filter((l) => l.key !== key && (at - l.at < 10_000 || kept(l.key))), { key, at }];
    if (hold) return reduced() ? null : at;
    setTimeout(() => {
      if (!ui().leaving.some((l) => l.key === key && l.at === at)) return;
      stopLeaving(key);
      after?.();
      rerender();
    }, AI_EXIT_MS);
    return at;
  }
  /** The screen's re-read after decisions: ONE read, once the LAST exit in flight is over (several cards in a row
   *  re-read once), so a read never pulls a card out mid-exit. A theme's decision re-reads the Repo dashboard. */
  let reread: { timer: ReturnType<typeof setTimeout>; due: number; theme: boolean } | null = null;
  function rereadAfter(id: number, how: "accept" | "dismiss", due: number, theme: boolean): void {
    const d = Math.max(due, reread?.due ?? 0);
    const th = theme || !!reread?.theme;
    if (reread) clearTimeout(reread.timer);
    reread = {
      due: d, theme: th,
      timer: setTimeout(() => {
        reread = null;
        // A theme's answer changes the chart (proposed → active, merged or gone): read it again.
        if (th) host.reloadRepo?.();
        host.decided?.(id, how);
      }, Math.max(0, d - Date.now())),
    };
  }

  function wrong(body: AiFeedbackBody): void {
    const key = aiHiddenKey(body.itemType, body.itemRef);
    if (ui().hidden.includes(key)) return;
    ui().hidden = [...ui().hidden, key];
    // My Work's brief: once its tile has left, the bento takes its other layout — that one fades in, never a jump.
    leave(key, false, body.itemType === "brief" ? () => host.flashNext?.(".mw-bento") : undefined);
    rerender();
    sendAiFeedback(body)
      .then(() => host.flash("Hidden for you. Thanks: Trov is told it was wrong."))
      .catch((e) => {
        ui().hidden = ui().hidden.filter((k) => k !== key);
        stopLeaving(key);
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (!(e instanceof PreviewBlocked)) host.flash("Couldn't send that. It is back on screen; try again.", 5000);
        rerender();
      });
  }

  /** "Wrong?" on an importance rating (Q34): tells Trov, for the evals; hides NOTHING — the rating is a computed fact
   *  and stays as rated. The button shows pressed at once, and unpressed again if the write fails. */
  function ratingWrong(body: AiFeedbackBody): void {
    const key = aiHiddenKey(body.itemType, body.itemRef);
    if (ui().ratedWrong.includes(key)) return;
    ui().ratedWrong = [...ui().ratedWrong, key];
    rerender();
    sendAiFeedback(body)
      .then(() => host.flash("Thanks: Trov is told this rating looks wrong. It stays as rated."))
      .catch((e) => {
        ui().ratedWrong = ui().ratedWrong.filter((k) => k !== key);
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (!(e instanceof PreviewBlocked)) host.flash("Couldn't send that. Try again.", 5000);
        rerender();
      });
  }

  /** Accept (with a renamed value) or dismiss one suggestion. Optimistic: the write goes out on the click and the
   *  suggestion leaves at once by the kit's one exit (every chip, the risk line, a row's mark, a Roadmap card, a
   *  proposed theme alike); a failed write stops the exit and it is back exactly as it was. */
  function decide(id: number, how: "accept" | "dismiss", value?: unknown): void {
    const u = ui();
    if (u.busy.includes(id)) return;
    u.busy = [...u.busy, id];
    const key = aiSuggestionKey(id);
    const at = leave(key, true);
    const theme = Object.values(host.state.repo.data?.themes ?? {}).some((t) => t.lanes.some((l) => l.suggestionId === id));
    rerender();
    const call = how === "accept" ? acceptAiSuggestion(id, value) : dismissAiSuggestion(id);
    call
      .then((r) => {
        if (isPreviewAnswer(r)) { previewDecided(id, how, value, theme); return; }
        u.busy = without(u.busy, id);
        if (u.rename?.id === id) u.rename = null;
        host.flash(how === "accept" ? "Accepted" : "Removed");
        rerender();
        rereadAfter(id, how, at === null ? 0 : at + AI_EXIT_MS, theme);
      })
      .catch((e) => {
        u.busy = without(u.busy, id);
        stopLeaving(key);
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        if (e instanceof ApiError && e.message === "not_available") {
          if (!u.unavailable.includes(id)) u.unavailable = [...u.unavailable, id];
          if (u.rename?.id === id) u.rename = null;
        } else if (!(e instanceof PreviewBlocked)) host.flash(refusalText(e), 5000);
        rerender();
      });
  }

  /** Q5 — `LOCAL_AI_PREVIEW`: the server took a SAMPLE's decision without saving it. The screen takes it locally:
   *  the item stays gone (its held exit is kept, `previewDecided`), a proposed theme becomes active under its (new)
   *  name or is removed from the chart, and no re-read follows (it would draw the sample again). */
  function previewDecided(id: number, how: "accept" | "dismiss", value: unknown, theme: boolean): void {
    const u = ui();
    u.busy = without(u.busy, id);
    if (!u.previewDecided.includes(id)) u.previewDecided = [...u.previewDecided, id];
    if (u.rename?.id === id) u.rename = null;
    const data = host.state.repo.data;
    if (theme && data?.themes) {
      const name = value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : null;
      const themes: typeof data.themes = {};
      for (const [range, t] of Object.entries(data.themes) as [keyof typeof data.themes, NonNullable<(typeof data.themes)[keyof typeof data.themes]>][]) {
        const lanes = how === "dismiss"
          ? t.lanes.filter((l) => l.suggestionId !== id)
          : t.lanes.map((l) => (l.suggestionId === id ? { ...l, status: "active" as const, suggestionId: null, name: name ?? l.name } : l));
        themes[range] = { ...t, lanes };
      }
      host.state.repo = { ...host.state.repo, data: { ...data, themes } };
    }
    host.flash("Not saved in preview");
    rerender();
  }

  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    switch (name) {
      case "aiWrong": { const b = parseFeedbackArg(arg); if (b) wrong(b); return; }
      case "aiRatingWrong": { const b = parseFeedbackArg(arg); if (b && b.itemType === "importance") ratingWrong(b); return; }
      case "aiFeedSource":
        if (!(AI_FEED_SOURCES as readonly string[]).includes(arg ?? "") || arg === u.feedSource) return;
        u.feedSource = arg as AiFeedSource;
        // The list under the switch is another set of entries: it rises in, as a Repo range switch does.
        host.flashNext?.("#cnpy-main .cnpy-stagger");
        break;
      case "aiNoteGotIt": {
        const me = state.me?.handle;
        if (!me) return;
        if (!u.noteSeen.some((h) => h.toLowerCase() === me.toLowerCase())) { u.noteSeen = [...u.noteSeen, me]; leave(AI_NOTE_LEAVING); }
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
          target.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
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
  return { act, leave: (key) => leave(key) };
}
