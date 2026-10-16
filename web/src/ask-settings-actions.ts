// The controller for Settings › Trov (the view is ask-settings.ts). Every `trovSet…` act main.ts dispatches lands
// here. It reads my Ask settings and Ask's standing for the org on screen, keeps what I type as a draft (a keystroke
// is a plain rerender: personal Settings is `data-morph`ed, so the field keeps its focus), and Save writes both
// with ONE PUT — the server's answer replaces the slice. The default mode is sent only when the plan offers a
// choice; the server refuses any other on a one-mode plan anyway (403 `mode_unavailable`). The thinking orb
// (`trovSetOrb`, ask-orb.ts) is NOT part of Save: a pick sets `ask.orb` at once — every orb in Ask follows on the
// next paint — and is kept in this browser's localStorage.
import { OrgApiError, Unauthorized, getAskSettings, getAskState, putAskSettings } from "./api";
import { TROV_SAVED, TROV_TRY, initialTrovPrefs, trovInstructions, trovMode, trovModes, type TrovPrefsUi } from "./ask-settings";
import { ASK_INSTRUCTIONS_MAX, type AskMode } from "@shared/ai-ask-core";
import { ASK_ORB_KEY, parseAskOrb, type AskOrbChoice } from "./ask-orb";

export interface TrovPrefsHost {
  state: { trovPrefs: TrovPrefsUi; orgSlug: string | null; ask: { orb: AskOrbChoice } };
  rerender(): void;
  unauth(e: unknown): void;
  flash(msg: string, ms?: number): void;
}

/** A refused save, in words. */
export function trovSaveFailure(e: unknown): string {
  if (e instanceof OrgApiError && e.detail) return e.detail;
  return "That didn't save. Check your connection and try again.";
}

/** `text` + one Try line, with a space between, cut to the limit. */
export function appendTry(text: string, line: string, max = ASK_INSTRUCTIONS_MAX): string {
  return ((text ? text.replace(/\s*$/, " ") : "") + line).slice(0, max);
}

export function createTrovPrefs(h: TrovPrefsHost) {
  const ui = (): TrovPrefsUi => h.state.trovPrefs;
  const set = (patch: Partial<TrovPrefsUi>): void => { h.state.trovPrefs = { ...h.state.trovPrefs, ...patch }; };

  /** Read both for the org on screen — again when the org changed, or when `force`. */
  async function load(force = false): Promise<void> {
    const slug = h.state.orgSlug;
    if (!slug) return;
    const cur = ui();
    if (!force && cur.slug === slug && cur.settings.status !== "idle" && cur.settings.status !== "error") return;
    h.state.trovPrefs = cur.slug === slug ? { ...cur, error: null } : { ...initialTrovPrefs(), slug };
    set({ settings: { status: "loading", data: ui().settings.data }, state: { status: "loading", data: ui().state.data } });
    h.rerender();
    const [settings, state] = await Promise.allSettled([getAskSettings(slug), getAskState(slug)]);
    if (h.state.orgSlug !== slug) return; // the org changed under the read
    for (const r of [settings, state]) if (r.status === "rejected" && r.reason instanceof Unauthorized) { h.unauth(r.reason); return; }
    set({
      settings: settings.status === "fulfilled" ? { status: "ok", data: settings.value } : { status: "error", data: null },
      // Ask's standing is optional here: without it the modes come from the settings' own list.
      state: state.status === "fulfilled" ? { status: "ok", data: state.value } : { status: "error", data: null },
    });
    h.rerender();
  }

  async function save(): Promise<void> {
    const slug = h.state.orgSlug;
    const cur = ui();
    if (!slug || !cur.settings.data || cur.saving) return;
    const instructions = trovInstructions(cur);
    if (instructions.length > ASK_INSTRUCTIONS_MAX) return;
    const multi = trovModes(cur).length > 1;
    const mode = trovMode(cur);
    set({ saving: true, error: null });
    h.rerender();
    try {
      const data = await putAskSettings(slug, { instructions, ...(multi && mode ? { defaultMode: mode } : {}) });
      if (h.state.orgSlug !== slug) return;
      set({ settings: { status: "ok", data }, draftInstructions: null, draftMode: null, saving: false, saved: true });
      h.flash(TROV_SAVED);
    } catch (e) {
      if (e instanceof Unauthorized) { h.unauth(e); return; }
      set({ saving: false, error: trovSaveFailure(e) });
    }
    h.rerender();
  }

  function act(a: string, arg: string | null, value: unknown): void {
    switch (a) {
      case "trovSetInstr":
        set({ draftInstructions: String(value ?? "").slice(0, ASK_INSTRUCTIONS_MAX), saved: false, error: null });
        h.rerender();
        return;
      case "trovSetTry": {
        const line = TROV_TRY[Number(arg)];
        if (!line) return;
        set({ draftInstructions: appendTry(trovInstructions(ui()), line), saved: false, error: null });
        h.rerender();
        return;
      }
      case "trovSetMode":
        if (!trovModes(ui()).some((m) => m.id === arg)) return;
        set({ draftMode: arg as AskMode, saved: false, error: null });
        h.rerender();
        return;
      case "trovSetOrb": {
        // A pick comes as the dropdown's `value`; anything else is ignored rather than stored.
        const raw = value ?? arg;
        const choice = parseAskOrb(raw);
        if (choice !== raw) return;
        h.state.ask.orb = choice;
        try { localStorage.setItem(ASK_ORB_KEY, choice); } catch { /* this session only */ }
        h.rerender();
        return;
      }
      case "trovSetSave": void save(); return;
      case "trovSetRetry": void load(true); return;
    }
  }

  return { load, act };
}
