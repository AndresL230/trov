/**
 * The SPA shell's own state machines (docs/architecture/web-ui.md › The shell's transitions): the boot, signing out,
 * leaving a route, late reads, Escape's layers, the lightbox and the site menu, the pointer drag's held paints, a
 * morph step's timing and the lazy chunks. What lives in a module of its own is driven here against a fake page;
 * what lives in main.ts is pinned at the source — main.ts boots the whole app, so it cannot be imported here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mainSrc from "../web/src/main.ts?raw";
import renderSrc from "../web/src/render.ts?raw";
import releasesLazySrc from "../web/src/releases-lazy.ts?raw";
import welcomeActionsSrc from "../web/src/welcome-actions.ts?raw";
import { escapeTop, topLayer, type EscapeLayer } from "../web/src/escape-layers";
import { lazyChunk } from "../web/src/lazy-chunk";
import { morphStep } from "../web/src/transition";
import { openLightbox, closeLightbox } from "../web/src/lightbox";
import { createMenuCtl, MENU_EXIT_MS } from "../web/src/site-menu";
import { pointerDrag, dragging } from "../web/src/pointer-drag";
import { initialState, render } from "../web/src/render";

/** The body of `function name(` in main.ts, up to its closing brace at the start of a line. */
const body = (name: string): string => {
  const at = mainSrc.indexOf(`function ${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  return mainSrc.slice(at, mainSrc.indexOf("\n}\n", at));
};
/** One `case "act":` of the dispatcher, up to the next case. */
const actCase = (act: string): string => {
  const at = mainSrc.indexOf(`case "${act}":`);
  expect(at, act).toBeGreaterThan(-1);
  return mainSrc.slice(at, mainSrc.indexOf("\n    case ", at + 6));
};

// ── the boot ─────────────────────────────────────────────────────────────────
describe("the boot never guesses that a person is signed out", () => {
  it("only a 401 from /auth/me is the landing page; anything else, or a throw while opening the app, is its own card", () => {
    // The answer's handler and the failure's are the two arms of ONE then(): a throw while painting the org is not
    // routed to the failure arm (the signed-out page), but to the catch after it.
    expect(mainSrc).toMatch(/\}, \(e: unknown\) => \{[\s\S]{0,300}if \(e instanceof Unauthorized\) showSignedOut\(\); else showBootFailed\("unreachable", e\);\s*\}\)/);
    expect(mainSrc).toMatch(/\.catch\(\(e: unknown\) => showBootFailed\("failed", e\)\);/);
    expect(mainSrc).not.toContain(".catch(() => showSignedOut())");
    const failed = body("showBootFailed");
    expect(failed).toContain("console.error(");
    expect(failed).toContain("state.authStep = step;");
    expect(actCase("bootRetry")).toContain("location.reload()");
  });

  it("draws a card that says what happened and offers Try again — never the landing page", () => {
    for (const [step, title] of [["unreachable", "Trov couldn't be reached."], ["failed", "Trov didn't open."]] as const) {
      const html = render({ ...initialState(), view: "auth", authStep: step });
      expect(html, step).toContain(`data-boot-failed="${step}"`);
      expect(html, step).toContain(title);
      expect(html, step).toMatch(/<button data-act="bootRetry" class="cnpy-accentbtn"[^>]*>Try again<\/button>/);
      expect(html, step).toContain('role="alert"');
      expect(html, step).not.toContain('data-morph="landing"');
      expect(html, step).not.toContain("Signing you in");
    }
  });
});

// ── signing out ──────────────────────────────────────────────────────────────
describe("signing out is ONE transition", () => {
  it("toSignedOut drops the person, the org and the screen's layers, and stops Sync's timers", () => {
    const fn = body("toSignedOut");
    for (const part of ["setApiOrg(null);", "state.me = null;", "state.orgSlug = null;", "state.repoPoll = null;", "leaveScreen();", "syncCtl.stop();", 'state.view = "auth"; state.authStep = "login";', "rerender();"]) {
      expect(fn, part).toContain(part);
    }
    expect(body("unauth")).toContain("if (e instanceof Unauthorized) toSignedOut();");
  });

  it("no loader or write signs out by hand: the only other `authStep = \"login\"` are the boot's and Back to sign in", () => {
    const copies = [...mainSrc.matchAll(/authStep = "login"/g)].length;
    // toSignedOut, showSignedOut (the boot with no session), the #onboard boot's fallback, backToLogin.
    expect(copies).toBe(4);
    expect(mainSrc).not.toContain('state.view = "auth"; state.authStep = "login"; rerender();');
    expect(mainSrc).not.toMatch(/const unauth = \(e: unknown\) =>/);
  });

  it("Sign out leaves whether or not the server answered, and drops `me` either way", () => {
    const so = actCase("signOut");
    expect(so).toContain("toSignedOut();");
    expect(so).toContain("logout().then(leave, leave);");
    expect(so).not.toContain("state.me = null; leave();");
  });

  it("a 401 is the session's, not the request's: it is handled before a seq check drops the answer", () => {
    // `if (seq !== …) return;` directly followed by the Unauthorized line would leave an expired session on screen.
    expect(mainSrc).not.toMatch(/if \(seq !== \w+\) return;\s*\n\s*if \(e instanceof Unauthorized\)/);
  });

  it("Loadable has no `unauth` status: nothing ever set it", () => {
    expect(renderSrc).toMatch(/export interface Loadable<T> \{\s*status: "idle" \| "loading" \| "ok" \| "error";/);
    expect(renderSrc).not.toContain('"unauth"');
  });
});

// ── leaving a route ──────────────────────────────────────────────────────────
describe("leaving a route closes what belonged to it — one list, every way out", () => {
  it("leaveScreen holds the union: the person card, MCP setup, the expanded prompts, the filter menus, the viewer's menus", () => {
    const fn = body("leaveScreen");
    for (const part of [
      "state.drawer = false;", "state.personCard = null;", "state.mcpSetup = false;", "state.grantScope = null;",
      "state.promptExpanded = false;", "state.handoffPromptOpen = false;", "state.repoAttentionOpen = false;", "state.rmTrovOpen = false;",
      "state.qFilterOpen = false;", "state.feedFilterOpen = false;", "state.promptFilterOpen = false;", "state.art.filterOpen = false;",
      "dropFilterMenuClose();", "state.art.verMenu = false;",
    ]) expect(fn, part).toContain(part);
    // A delete in flight keeps its confirm, busy, for the artifact and the ticket alike; nothing drops the busy flag.
    expect(fn).toContain("if (!state.art.deleteBusy) state.art.deleteArm = false;");
    expect(fn).toContain("if (!state.tdDeleteBusy) state.tdDeleteArm = false;");
    expect(fn).not.toMatch(/tdDeleteBusy = false|deleteBusy = false/);
  });

  it("runs from Back / Forward (applyRoute) and from every paint of another route (every go… act)", () => {
    expect(body("applyRoute")).toContain("if (!sameRoute(r, currentRoute())) leaveScreen();");
    expect(body("applyRoute")).not.toContain("state.tdDeleteBusy = false");
    expect(body("paintApp")).toMatch(/if \(routeKey !== paintedRoute\) \{ paintedRoute = routeKey; leaveScreen\(\); \}/);
  });

  it("a ticket's delete goes back to the queue only from that ticket's own page", () => {
    const del = actCase("ticketDelete");
    expect(del).toContain('if (state.screen === "ticketdetail" && state.ticketId === d.id) { state.screen = "tickets"; state.ticketId = null; }');
    expect(del).not.toMatch(/\n\s*state\.screen = "tickets"; state\.ticketId = null;/);
  });
});

// ── late reads ───────────────────────────────────────────────────────────────
describe("a read that lands late never overwrites a newer one", () => {
  it("the Feed: only the newest read commits its rows and its author menu", () => {
    const fn = body("loadFeed");
    expect(fn).toContain("const seq = ++feedSeq;");
    expect(fn.match(/if \(seq !== feedSeq\) return;/g)).toHaveLength(2);
    expect(fn.indexOf("if (seq !== feedSeq) return;")).toBeLessThan(fn.indexOf("state.feedAuthors ="));
  });

  it("the Repo dashboard: the newest read, for the repository and app it was asked for", () => {
    const fn = body("loadRepo");
    expect(fn).toContain("const seq = ++repoSeq;");
    expect(fn).toContain("seq !== repoSeq || sample !== state.repoSample || (!sample && (slug !== state.repoSlug || app !== state.repoApp))");
    expect(fn.match(/if \(stale\(\)\) return;/g)).toHaveLength(2);
  });
});

// ── filter menus ─────────────────────────────────────────────────────────────
describe("a filter menu's close is one timer", () => {
  it("is stored, cancelled by a reopen, and forgotten when the screen is left", () => {
    expect(mainSrc).toContain("fmCloseTimer = setTimeout(() => { fmCloseTimer = null; if (fmClosing === id) finish(); }, FM_CLOSE_MS);");
    expect(body("openFilterMenu")).toMatch(/if \(fmClosing === id\) \{[^}]*cancelFmClose\(\);/);
    expect(body("dropFilterMenuClose")).toMatch(/cancelFmClose\(\);\s*fmClosing = null;/);
    expect(mainSrc).not.toMatch(/\n\s*setTimeout\(\(\) => \{ if \(fmClosing === id\) finish\(\); \}, FM_CLOSE_MS\);/);
  });
});

// ── Escape ───────────────────────────────────────────────────────────────────
describe("Escape closes one layer per press", () => {
  const layer = (name: string, log: string[], open = true): EscapeLayer & { name: string } => ({ name, open: () => open, close: () => { log.push(name); } });
  const key = (k = "Escape", prevented = false) => { const e = { key: k, defaultPrevented: prevented, preventDefault: vi.fn(() => { e.defaultPrevented = true; }) }; return e; };

  it("the topmost open layer closes, and only it; the press is then spent", () => {
    const log: string[] = [];
    const layers = [layer("card", log, false), layer("menu", log), layer("drawer", log)];
    expect(topLayer(layers)?.close).toBe(layers[1].close);
    const e = key();
    expect(escapeTop(e, layers)).toBe(true);
    expect(log).toEqual(["menu"]);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    // A second listener reading the same (now spent) press closes nothing.
    expect(escapeTop(e, layers)).toBe(false);
    expect(log).toEqual(["menu"]);
  });

  it("a press another layer already took, another key, or nothing open: nothing closes", () => {
    const log: string[] = [];
    expect(escapeTop(key("Escape", true), [layer("menu", log)])).toBe(false);
    expect(escapeTop(key("Enter"), [layer("menu", log)])).toBe(false);
    expect(escapeTop(key(), [layer("menu", log, false)])).toBe(false);
    expect(log).toEqual([]);
  });

  it("main.ts's own layers are ONE ordered listener, the modals above the menus above the drawer", () => {
    expect(mainSrc.match(/escapeTop\(e, ESCAPE_LAYERS\)/g)).toHaveLength(1);
    const list = mainSrc.slice(mainSrc.indexOf("const ESCAPE_LAYERS"), mainSrc.indexOf("escapeTop(e, ESCAPE_LAYERS)"));
    const order = ["state.personCard !== null", "state.mcpSetup", "state.grantScope !== null", "state.promptExpanded", "FILTER_MENUS", "state.treeMenu", "state.libUi.cardMenu", "state.avatarMenu", "state.home.attnOpen", "state.drawer"].map((s) => list.indexOf(s));
    expect(order.every((at) => at > -1), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The old one-per-layer document listeners are gone.
    expect(mainSrc).not.toMatch(/document\.addEventListener\("keydown", \(e\) => \{ if \(e\.key === "Escape" && state\.treeMenu\)/);
    expect(mainSrc).not.toMatch(/if \(e\.key !== "Escape" \|\| !state\.drawer\) return;/);
  });
});

// ── the lightbox ─────────────────────────────────────────────────────────────
interface FakeStyle { props: Record<string, string>; setProperty(k: string, v: string): void; getPropertyValue(k: string): string; removeProperty(k: string): void; aspectRatio?: string; width?: string }
const fakeStyle = (init: Record<string, string> = {}): FakeStyle => ({
  props: { ...init },
  setProperty(k, v) { this.props[k] = v; },
  getPropertyValue(k) { return this.props[k] ?? ""; },
  removeProperty(k) { delete this.props[k]; },
});
function fakeEl() {
  const el = {
    className: "", innerHTML: "", removed: false, style: fakeStyle(), complete: false, naturalWidth: 0, naturalHeight: 0,
    classList: { add: () => undefined, remove: () => undefined },
    setAttribute: () => undefined, addEventListener: () => undefined, focus: () => undefined,
    querySelector: () => fakeEl(),
    remove() { el.removed = true; },
  };
  return el;
}

describe("the lightbox", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("opened while the last one is still leaving: the scroll lock is taken from the unlocked page, and released only by the new one", () => {
    const scroller = { style: fakeStyle({ "overflow-y": "auto" }) };
    const roots: ReturnType<typeof fakeEl>[] = [];
    vi.stubGlobal("document", {
      activeElement: null, body: { appendChild: () => undefined },
      createElement: () => { const r = fakeEl(); roots.push(r); return r; },
      querySelector: () => null, getElementById: () => scroller, contains: () => false,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    });
    const o = { src: "/a.png", alt: "", title: "A" };
    openLightbox(o);
    expect(scroller.style.getPropertyValue("overflow-y")).toBe("hidden");
    closeLightbox();                       // A starts its exit
    openLightbox({ ...o, title: "B" });    // …and B opens before it is over
    expect(roots[0].removed).toBe(true);   // A ended at once
    expect(scroller.style.getPropertyValue("overflow-y")).toBe("hidden");
    vi.advanceTimersByTime(1000);          // A's exit timer never unlocks the page under B
    expect(scroller.style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(roots[1].removed).toBe(false);
    closeLightbox();
    vi.advanceTimersByTime(1000);
    expect(roots[1].removed).toBe(true);
    expect(scroller.style.getPropertyValue("overflow-y")).toBe("auto"); // what the page had, not A's lock
    expect(scroller.style.getPropertyValue("overflow-x")).toBe("");
  });
});

// ── the site menu ────────────────────────────────────────────────────────────
describe("the site menu", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("a tap on its button while it is leaving keeps it open", () => {
    const root = { style: { overflow: "", paddingRight: "" }, clientWidth: 400, clientHeight: 800 };
    vi.stubGlobal("document", { documentElement: root, defaultView: null });
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
    vi.stubGlobal("innerWidth", 400);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const attrs = new Set<string>();
    const overlay = { setAttribute: (k: string) => { attrs.add(k); }, removeAttribute: (k: string) => { attrs.delete(k); }, querySelector: () => ({ focus: () => undefined }) };
    const mount = { querySelector: (sel: string) => (sel.includes("sitemenu") ? overlay : { focus: () => undefined }) } as unknown as HTMLElement;
    let open = false;
    const ctl = createMenuCtl({ mount, get: () => open, set: (v) => { open = v; }, rerender: () => undefined });
    ctl.open();
    expect(open).toBe(true);
    expect(root.style.overflow).toBe("hidden");
    ctl.close();
    expect(attrs.has("data-closing")).toBe(true);
    expect(root.style.overflow).toBe("");     // unlocked at once
    // Escape while it is leaving is not the menu's.
    const esc = { key: "Escape", defaultPrevented: false, preventDefault: vi.fn() };
    ctl.onKey(esc as unknown as KeyboardEvent);
    expect(esc.preventDefault).not.toHaveBeenCalled();
    ctl.open();                                // tapped again mid-exit
    expect(attrs.has("data-closing")).toBe(false);
    expect(root.style.overflow).toBe("hidden");
    vi.advanceTimersByTime(MENU_EXIT_MS * 3);
    expect(open).toBe(true);                   // the exit was called off
  });
});

// ── the pointer drag ─────────────────────────────────────────────────────────
describe("the pointer drag holds paints from the press", () => {
  type Fn = (e: Record<string, unknown>) => void;
  function harness() {
    const doc: Record<string, Fn[]> = {}, win: Record<string, Fn[]> = {}, mnt: Record<string, Fn[]> = {};
    const on = (m: Record<string, Fn[]>) => (t: string, f: Fn) => { (m[t] ??= []).push(f); };
    vi.stubGlobal("document", { addEventListener: on(doc), documentElement: { classList: { add: () => undefined, remove: () => undefined } }, getSelection: () => null });
    vi.stubGlobal("window", { addEventListener: on(win) });
    const mount = { addEventListener: on(mnt) } as unknown as HTMLElement;
    const calls: string[] = [];
    const idle = vi.fn();
    pointerDrag<string>(mount, {
      press: (t) => (t.closest("[data-row]") ? "row" : null),
      begin: () => { calls.push("begin"); },
      over: () => { calls.push("over"); },
      drop: (_p, commit, done) => { calls.push(`drop:${commit}`); done(); },
    }, idle);
    const fire = (m: Record<string, Fn[]>, t: string, e: Record<string, unknown> = {}) => { for (const f of m[t] ?? []) f(e); };
    const target = { closest: (s: string) => (s === "[data-row]" ? {} : null) };
    return {
      calls, idle,
      press: () => fire(mnt, "pointerdown", { button: 0, pointerType: "mouse", target, clientX: 0, clientY: 0 }),
      move: (x: number, buttons = 1) => fire(doc, "pointermove", { clientX: x, clientY: 0, buttons, preventDefault: () => undefined }),
      up: () => fire(doc, "pointerup"),
      blur: () => fire(win, "blur"),
    };
  }
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("a press holds paints before the slop is passed; a plain click releases them after its click", () => {
    const h = harness();
    h.press();
    expect(dragging()).toBe(true);   // a read landing now cannot replace the row begin() would lift
    h.move(2);                       // inside the slop: still a press
    expect(h.calls).toEqual([]);
    h.up();
    expect(dragging()).toBe(false);
    expect(h.idle).not.toHaveBeenCalled(); // the click lands on the row that was pressed first…
    vi.runAllTimers();
    expect(h.idle).toHaveBeenCalledOnce(); // …then the held paint runs
  });

  it("a drag lifts, moves and drops, then releases its paints", () => {
    const h = harness();
    h.press();
    h.move(10);
    expect(h.calls).toEqual(["begin", "over"]);
    h.up();
    expect(h.calls).toEqual(["begin", "over", "drop:true"]);
    expect(dragging()).toBe(false);
    expect(h.idle).toHaveBeenCalledOnce();
  });

  it("never holds them forever: a release the document missed, or the window losing focus, ends it", () => {
    const missed = harness();
    missed.press();
    missed.move(1, 0);               // a move with no button down: the release happened outside the window
    expect(dragging()).toBe(false);
    vi.runAllTimers();
    expect(missed.idle).toHaveBeenCalled();
    const lifted = harness();
    lifted.press();
    lifted.move(10);
    lifted.blur();
    expect(lifted.calls).toEqual(["begin", "over", "drop:false"]);
    expect(dragging()).toBe(false);
  });

  it("the board sends nothing for a drop where the card started, or for a card no longer on screen", () => {
    expect(mainSrc).toContain("|| !p.card.isConnected || !p.homeList?.isConnected;");
    expect(mainSrc).toContain('if (commit && !unmoved) dispatch("queueDrop"');
  });
});

// ── a morph step ─────────────────────────────────────────────────────────────
describe("morphStep settles once the step has changed", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("with a view transition, `change` runs later — and what follows waits for it", async () => {
    let pending: (() => void) | null = null;
    let finish!: () => void;
    const done = new Promise<void>((res) => { finish = res; });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("document", { hidden: false, startViewTransition: (cb: () => void) => { pending = cb; return { updateCallbackDone: done }; } });
    const seen: string[] = [];
    let step = "github";
    const after = morphStep(() => { step = "agent"; }).then(() => { seen.push(step); });
    expect(step).toBe("github");     // not yet: the browser has not called it
    pending!();
    finish();
    await after;
    expect(seen).toEqual(["agent"]); // what followed read the NEW step
  });

  it("without one, `change` runs at once and the promise is already settled", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("document", { hidden: false, startViewTransition: () => { throw new Error("not called under reduced motion"); } });
    let ran = false;
    const p = morphStep(() => { ran = true; });
    expect(ran).toBe(true);
    await p;
  });

  it("the guided setup focuses and re-checks the step it moved to; a first-run org is entered once", () => {
    expect(welcomeActionsSrc).toMatch(/void morphStep\(\(\) => \{ state\.welcome\.step = to;[^\n]*\}\)\.then\(\(\) => \{[\s\S]{0,300}#wel-t[\s\S]{0,120}if \(step\(\) === "agent"\) recheck\(\);\s*\}\);/);
    expect(mainSrc).toMatch(/enteredAnOrg = true; enteringNew = org\.slug;\s*\n[\s\S]{0,400}morphStep\(/);
  });
});

// ── lazy chunks ──────────────────────────────────────────────────────────────
describe("a lazy chunk", () => {
  it("is not `failed` while a retry is under way, and is again if the retry fails", async () => {
    let fail = true;
    let release!: () => void;
    const chunk = lazyChunk(() => (fail ? Promise.reject(new Error("gone")) : new Promise<{ ok: true }>((res) => { release = () => res({ ok: true }); })));
    await expect(chunk.load()).rejects.toThrow("gone");
    expect(chunk.failed()).toBe(true);
    fail = false;
    const retry = chunk.load();      // an act asked for again
    expect(chunk.failed()).toBe(false); // its screen is the skeleton, not "did not load", while it runs
    release();
    await expect(retry).resolves.toEqual({ ok: true });
    expect(chunk.get()).toEqual({ ok: true });
    expect(chunk.failed()).toBe(false);
  });

  it("What's new is one of them — no copy of the machine of its own", () => {
    expect(releasesLazySrc).toContain('export const releasesChunk = lazyChunk<Releases>(() => import("./releases"));');
    expect(releasesLazySrc).not.toMatch(/let inflight|let failed/);
    expect(mainSrc).toContain('if (state.view === "app" && state.screen === "releases") withChunk(releasesChunk);');
    expect(mainSrc).not.toContain("releasesWanted");
  });
});
