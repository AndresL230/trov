// The guided first-run setup's controller (welcome.ts holds the view). Every `welcome…` act
// main.ts dispatches lands here, plus the two things a pure view cannot do:
//   • NOTICE A CONNECTION. The agent step's approval happens in another tab (the OAuth consent
//     page), so while that step is on screen and not yet connected this re-reads the person's own
//     connections — `GET /auth/oauth-grants`, Trov's own route, never an external call — every few
//     seconds while the tab is visible, and at once when the tab is returned to.
//   • COME BACK. Two of the repository step's actions leave the app and are returned by the SERVER
//     to another screen: linking a GitHub account (`/auth/login?link=1` → `/#settings`) and
//     connecting the GitHub App (→ `/<slug>/?github=<outcome>#org/repos`). Leaving from the wizard
//     drops a note in sessionStorage (`WELCOME_RETURN_KEY`); main.ts's `enterOrg` reads it once
//     and lands that one return on the wizard instead (`welcomeReturnHash`, pure).

import { morphStep } from "./transition";
import type { AppState } from "./render";
import type { OAuthGrantSummary } from "@shared/rows";
import { agentStepState, effectiveWelcomeStep, isWelcomeStep, welcomeStepsFor, type WelcomeStep } from "./welcome";
import { currentOrg } from "./org-settings";

/** The session key of "I left for GitHub from the wizard". A slug, a reason and a time — nothing secret. */
export const WELCOME_RETURN_KEY = "trov.welcomeReturn";
/** How long a return is still the wizard's (GitHub's install page can take a while). */
export const WELCOME_RETURN_TTL_MS = 30 * 60 * 1000;
/** How often the agent step asks again while it waits. */
export const WELCOME_POLL_MS = 5000;

export interface WelcomeReturn { slug: string; why: "link" | "github"; at: number }

export function parseWelcomeReturn(raw: string | null): WelcomeReturn | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WelcomeReturn> | null;
    if (!v || typeof v.slug !== "string" || typeof v.at !== "number" || (v.why !== "link" && v.why !== "github")) return null;
    return { slug: v.slug, why: v.why, at: v.at };
  } catch { return null; }
}

/**
 * Where a page load that is the wizard's own return should land — the wizard's repository step —
 * or null (it is not one: land where the URL says). The note must be fresh and for THIS org, and
 * the URL must be the one the server sends that return to: Settings after a link (also when the
 * link was refused: the wizard then still says "link first", under the refusal's toast), Org
 * settings with a `?github=` outcome after a connect.
 */
export function welcomeReturnHash(note: WelcomeReturn | null, o: { slug: string; hash: string; github: boolean; now: number }): string | null {
  if (!note || note.slug !== o.slug || o.now - note.at > WELCOME_RETURN_TTL_MS || o.now < note.at) return null;
  if (note.why === "link") return o.hash === "#settings" ? "#welcome" : null;
  return o.github && /^#org(?:\/|$)/.test(o.hash) ? "#welcome" : null;
}

export interface WelcomeHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  /** Org settings' reads for the org on screen (org-actions.ts `load`). */
  loadOrg(): void;
  /** My Work's reads, if they have not been made: it is what stands behind the card and what "Open Trov"
   *  reveals, so it is read while the person is still in the setup. */
  loadHome(): void;
  /** Settings › MCP access's two reads, if they have not been made (main.ts `loadGrantsIfNeeded`). */
  loadConnections(): void;
  /** Both of them again, whatever they hold (after a failure). */
  reloadConnections(): void;
  /** `GET /auth/oauth-grants`. */
  listGrants(): Promise<OAuthGrantSummary[]>;
  unauth(e: unknown): void;
  /** Leave the app for a URL. */
  go(url: string): void;
}

export interface WelcomeController {
  act(name: string, arg: string | null): void;
  /** The wizard was opened (a page load on `#welcome`, a link to it): read what its steps derive from. */
  enter(): void;
  /** The step changed by Back / Forward: nothing new to load. */
  moved(): void;
  /** After every paint: keep the agent step's re-check running only while it is needed. */
  afterPaint(): void;
}

export function createWelcomeController(h: WelcomeHost): WelcomeController {
  const { state, mount } = h;
  const onScreen = (): boolean => state.view === "app" && state.screen === "welcome";
  const org = () => currentOrg(state);
  const step = (): WelcomeStep => effectiveWelcomeStep(state.welcome.step, welcomeStepsFor(org()?.role, state.org));
  const visible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

  // ── noticing a connection ──────────────────────────────────────────────────
  let asking = false;
  /** MY grants again, quietly: the list on screen stays until a different one arrives, and a failed
   *  re-read changes nothing (what was known stays known). */
  function recheck(): void {
    if (asking || !onScreen()) return;
    // Its first answer is main.ts's to fetch (and to report a failure of): only refresh a read that landed.
    if (state.grants.status !== "ok") { h.loadConnections(); return; }
    asking = true;
    h.listGrants()
      .then((data) => {
        asking = false;
        if (JSON.stringify(data) === JSON.stringify(state.grants.data)) return;
        state.grants = { status: "ok", data };
        if (onScreen()) h.rerender();
      })
      .catch((e) => { asking = false; h.unauth(e); });
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  const waiting = (): boolean => {
    const o = org();
    return onScreen() && !!o && step() === "agent" && agentStepState({ grants: state.grants, tokens: state.mcpTokens }, o.slug) === "todo";
  };
  function afterPaint(): void {
    const want = waiting();
    if (want && timer === null) timer = setInterval(() => { if (!waiting()) { afterPaint(); return; } if (visible()) recheck(); }, WELCOME_POLL_MS);
    else if (!want && timer !== null) { clearInterval(timer); timer = null; }
  }
  // Back from the consent tab (or from anywhere): ask at once rather than wait out the interval.
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => { if (onScreen() && step() !== "github") recheck(); });
    document.addEventListener("visibilitychange", () => { if (visible() && onScreen() && step() !== "github") recheck(); });
  }

  // ── coming back ────────────────────────────────────────────────────────────
  function leaveNote(why: WelcomeReturn["why"]): void {
    const o = org();
    if (!o) return;
    try { sessionStorage.setItem(WELCOME_RETURN_KEY, JSON.stringify({ slug: o.slug, why, at: Date.now() } satisfies WelcomeReturn)); } catch { /* no storage: the return lands where the server sends it */ }
  }
  // "Connect with GitHub" and "Link the existing installation" are real links (a navigation the
  // click handler leaves alone): note the departure as the click passes, before the browser leaves.
  mount.addEventListener("click", (e) => {
    if (!onScreen()) return;
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("[data-welcome] a[href]");
    if (a && /\/github\/install(?:\?|$)/.test(a.getAttribute("href") ?? "")) leaveNote("github");
  }, true);

  function show(to: WelcomeStep): void {
    // One step into the next as a morph (transition.ts), not a snap.
    morphStep(() => { state.welcome.step = to; state.welcome.byHand = false; h.rerender(); });
    window.scrollTo(0, 0);
    // The step's heading takes focus: a keyboard or screen-reader user is at the top of the new step.
    mount.querySelector<HTMLElement>("#wel-t")?.focus({ preventScroll: true });
    if (step() === "agent") recheck();
  }

  function enter(): void {
    h.loadOrg();
    h.loadConnections();
    h.loadHome();
  }

  function act(name: string, arg: string | null): void {
    switch (name) {
      case "welcomeOpen":
        state.screen = "welcome"; state.personCard = null;
        state.welcome = { step: isWelcomeStep(arg) ? arg : "github", byHand: false, firstRun: state.welcome.firstRun };
        enter();
        window.scrollTo(0, 0);
        return;
      case "welcomeGo": if (isWelcomeStep(arg)) show(arg); return;
      case "welcomeByHand": state.welcome.byHand = !state.welcome.byHand; h.rerender(); return;
      case "welcomeRecheck": h.reloadConnections(); h.rerender(); return;
      case "welcomeLinkGithub": leaveNote("link"); h.go("/auth/login?link=1"); return;
      default: return;
    }
  }

  return { act, enter, moved: () => { h.rerender(); window.scrollTo(0, 0); if (step() === "agent") recheck(); }, afterPaint };
}
