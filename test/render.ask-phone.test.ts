/**
 * Ask Trov on a phone (web/src/ask-phone.ts; inventory §10, scenarios `phone`, `phone-plus`, `phone-insp`): the
 * header's Open threads + New thread, the thread list as a modal drawer, the composer's controls under one "+" menu
 * with the meta line, the inspector as a full-height sheet — every target ≥ 44px, every move off under reduced
 * motion, every close through `ctx.exit`. Rendered from the fixtures; the acts run through the real controller.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { askScreenView } from "../web/src/ask-screen";
import { askView } from "../web/src/ask-state";
import { phoneComposerBar, phoneHeaderControls, phoneMeta, phonePart, threadsDrawer, AUTO_OFF_NOTE } from "../web/src/ask-phone";
import { createAskController, PARTS } from "../web/src/ask-controller";
import { closeTop, type EscEntry } from "../web/src/ask-escape";
import { replayPlan } from "../web/src/ask-replay";
import type { AskCtx } from "../web/src/ask-state";
import { askThreadsFixture, askRefFixtures, askStateFixture } from "@shared/ai-fixtures";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };
function phoneState(over: (s: AppState) => void = () => undefined, plan: "pro" | "free" = "pro"): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.phone = true; s.narrow = true;
  s.ask.vw = 390;
  s.ask.state = { status: "ok", data: askStateFixture(plan, NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  over(s);
  return s;
}
/** The controller around a state, with no DOM (exits apply at once; nothing is fetched by these acts). */
function ctxOf(s: AppState): AskCtx {
  const flashes: string[] = [];
  const ctl = createAskController({ state: s, mount: { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement, rerender: () => undefined, flash: (m) => flashes.push(m), unauth: () => undefined, search: () => "" });
  return Object.assign(ctl.ctx, { flashes });
}
const act = (ctx: AskCtx, name: string, arg: string | null = null) => phonePart.act!(ctx, name, arg, null);
const ask = css.slice(css.indexOf("/* ══ Ask Trov"), css.indexOf("/* ── the site on a phone")).replace(/\/\*[\s\S]*?\*\//g, "");
const phoneCss = ask.slice(ask.indexOf(".ask-ph-hbtn {"));
const rule = (sel: string): string => {
  const i = phoneCss.indexOf(`${sel} {`);
  return i < 0 ? "" : phoneCss.slice(i, phoneCss.indexOf("}", i));
};

describe("phone — the screen (`phone`)", () => {
  it("the header: Open threads (a dialog) + New thread on the right; no threads toggle; the column list stays empty", () => {
    const s = phoneState();
    const hdr = phoneHeaderControls(s);
    expect(hdr).toMatch(/<button type="button" class="ask-ph-hbtn" data-act="askPhDrawer" aria-label="Open threads" aria-haspopup="dialog" aria-expanded="false" aria-controls="ask-ph-drawer">/);
    expect(hdr).toMatch(/data-act="askShNew" aria-label="New thread"/);
    const html = render(s);
    expect(html).toContain(`data-act="askPhDrawer"`);
    expect(html).not.toContain(`data-act="askShThreads"`);
    expect(html).toContain(`<aside class="ask-threads" aria-label="Threads" inert aria-hidden="true"></aside>`);
    // Off a phone, or on another screen, the header gets nothing from this part.
    expect(phoneHeaderControls(phoneState((x) => { x.phone = false; }))).toBe("");
    expect(phoneHeaderControls(phoneState((x) => { x.screen = "tickets"; }))).toBe("");
  });

  it("the bug and theme buttons leave the header on Ask (the design); every phone control is ≥ 44px", () => {
    expect(ask).toMatch(/\[data-phone="1"\]\[data-screen="ask"\] \.cnpy-hdr-r > \[data-act="supportOpen"\],\s*\[data-phone="1"\]\[data-screen="ask"\] \.cnpy-hdr-r > \[data-act="cycleTheme"\] \{ display:none !important; \}/);
    for (const sel of [".ask-ph-hbtn", ".ask-ph-plusbtn", ".ask-ph-send"]) expect(rule(sel), sel).toMatch(/width:44px; height:44px/);
    for (const sel of [".ask-ph-row", ".ask-ph-seg > .cnpy-seg-btn", ".ask-drawer .ask-th-b", ".ask-drawer .ask-menu > button"]) expect(rule(sel), sel).toMatch(/min-height:44px/);
    expect(rule(".ask-drawer .ask-th-more")).toMatch(/width:44px; height:44px; opacity:1/);
    expect(rule('.ask-insp-frame[data-sheet="1"] .ask-insp-head > .ask-iconbtn')).toMatch(/width:44px; height:44px/);
  });

  // e2e AU-27 (360px, real thread 801001): a write card's Cancel / Confirm (29–31px) and a done line's Undo / Open
  // were left out of the conversation's 44px touch floor. The fields edited in place (a cycle, text) join them.
  it("a write card's buttons and its in-place fields, and a line's buttons, get the 44px hit area on a phone", () => {
    expect(css).toMatch(/\[data-phone="1"\] \.ask-col \.ask-btn::after, \[data-phone="1"\] \.ask-act-cyc::after, \[data-phone="1"\] \.ask-act-txt::after/);
    // (a line's Undo / Open and its link, and an assignment's item and person picker, are in the same rule)
    expect(css).toMatch(/\[data-phone="1"\] \.ask-col \.ask-btn, \[data-phone="1"\] \.ask-act-cyc, \[data-phone="1"\] \.ask-act-txt, [^{]*\[data-phone="1"\] \.ask-undo, \[data-phone="1"\] \.ask-line-link \{ position:relative; \}/);
  });

  it("the composer: + · the meta line · Send (44×44), no Enter hint, no desktop toolbar", () => {
    const html = askScreenView(phoneState());
    expect(html).toMatch(/<div class="ask-ph-bar">\s*<button type="button" class="ask-ph-plusbtn" data-act="askPhPlus" data-arg="page" aria-label="More options" aria-expanded="false" aria-controls="ask-ph-plus-page">/);
    expect(html).toContain(`<span class="ask-ph-meta">Smart · Asks first</span>`);
    expect(html).toMatch(/class="ask-ph-send" data-act="askCoSend" data-arg="page" aria-label="Send"/);
    expect(html).not.toContain("Enter to send");
    expect(html).not.toContain(`class="ask-box-bar"`);
    expect(phoneComposerBar(askView(phoneState((x) => { x.phone = false; })))).toBe("");
  });

  it("the meta line follows the mode, the switch, the plan and the admin's Auto", () => {
    const meta = (over: (s: AppState) => void, plan: "pro" | "free" = "pro") => phoneMeta(askView(phoneState(over, plan)));
    expect(meta(() => undefined)).toBe("Smart · Asks first");
    expect(meta((s) => { s.ask.composer.page.mode = "thinking"; s.ask.composer.page.auto = true; })).toBe("Thinking · Auto");
    expect(meta(() => undefined, "free")).toBe("Asks first");
    expect(meta((s) => { s.ask.composer.page.auto = true; }, "free")).toBe("Auto");
    // An admin turned Auto off: the thread asks first, whatever was picked.
    expect(meta((s) => { s.ask.composer.page.auto = true; s.ask.state.data!.autoAllowed = false; })).toBe("Smart · Asks first");
  });

  it("busy: Send is Stop", () => {
    const html = askScreenView(phoneState((s) => { s.ask.page = { ...s.ask.page, busy: true }; }));
    expect(html).toMatch(/class="ask-ph-send is-busy" data-act="askCoStop" data-arg="page" aria-label="Stop answering"/);
  });
});

describe("phone — the thread drawer", () => {
  it("a modal dialog from the left: labelled, a Close, the scrim closes it, the shell's thread list inside", () => {
    const html = askScreenView(phoneState((s) => { s.ask.phone.drawer = true; }));
    expect(html).toMatch(/<div class="ask-drawer-slot"><div class="ask-drawer-layer">/);
    expect(html).toMatch(/<div class="ask-drawer-scrim" data-act="askPhDrawerClose" aria-hidden="true"><\/div>/);
    expect(html).toMatch(/<div class="ask-drawer" id="ask-ph-drawer" role="dialog" aria-modal="true" aria-labelledby="ask-ph-drawer-t" data-ask-trap="drawer">/);
    expect(html).toMatch(/<h2 class="ask-drawer-t" id="ask-ph-drawer-t">Threads<\/h2><button type="button" class="ask-ph-hbtn" data-act="askPhDrawerClose" aria-label="Close threads">/);
    expect(html).toContain(">Pinned<");
    expect(html).toContain(`data-act="askThOpen"`);
    expect(phoneHeaderControls(phoneState((s) => { s.ask.phone.drawer = true; }))).toContain(`aria-expanded="true"`);
    // Leaving: data-closing on the layer (slides out, scrim fades), nothing on a desktop.
    expect(threadsDrawer(askView(phoneState((s) => { s.ask.phone.drawer = true; s.ask.closing = { drawer: true }; })))).toMatch(/^<div class="ask-drawer-layer" data-closing="1">/);
    expect(threadsDrawer(askView(phoneState((s) => { s.ask.phone.drawer = true; s.phone = false; })))).toBe("");
  });

  it("opens and closes through the acts; picking a thread or New thread closes it (the shell's hook)", () => {
    const s = phoneState();
    const ctx = ctxOf(s);
    act(ctx, "askPhDrawer");
    expect(s.ask.phone.drawer).toBe(true);
    act(ctx, "askPhDrawerClose");
    expect(s.ask.phone.drawer).toBe(false);
    act(ctx, "askPhDrawer");
    ctx.newThread("page");
    expect(s.ask.phone.drawer).toBe(false);
    act(ctx, "askPhDrawer");
    PARTS.find((p) => p.code === "Th")!.act!(ctx, "askThOpen", "3", null);
    expect(s.ask.phone.drawer).toBe(false);
  });

  it("Escape: a thread's ⋯ menu in the drawer first, then the drawer; the + menu is a menu too", () => {
    const s = phoneState((x) => { x.ask.phone.drawer = true; x.ask.threadMenu = 5; });
    const ctx = ctxOf(s);
    const entries: EscEntry<AskCtx>[] = PARTS.flatMap((p) => p.escape ?? []);
    expect(closeTop(entries, ctx)).toBe(true);
    expect([s.ask.threadMenu, s.ask.phone.drawer]).toEqual([null, true]);
    expect(closeTop(entries, ctx)).toBe(true);
    expect(s.ask.phone.drawer).toBe(false);
    s.ask.phone.plus = true;
    expect(closeTop(entries, ctx)).toBe(true);
    expect(s.ask.phone.plus).toBe(false);
    expect(closeTop(entries, ctx)).toBe(false);
  });
});

describe("phone — the + menu (`phone-plus`)", () => {
  const plus = (over: (s: AppState) => void = () => undefined, plan: "pro" | "free" = "pro") =>
    askScreenView(phoneState((s) => { s.ask.phone.plus = true; over(s); }, plan));

  it("the design's rows, Mode (Pro) and Changes in this thread as segmented switches, the + turned", () => {
    const html = plus();
    expect(html).toContain(`aria-expanded="true" aria-controls="ask-ph-plus-page"`);
    expect(html).toMatch(/<div class="ask-ph-plus" id="ask-ph-plus-page" role="group" aria-label="More options" data-ask-plus="page">/);
    const rows = [...html.matchAll(/class="ask-ph-row" data-act="(askPh\w+)" data-arg="page">[\s\S]*?<\/svg>([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual([["askPhAttach", "Attach a file or photo"], ["askPhMention", "Mention a ticket, doc or person"], ["askPhCommand", "Run a command"]]);
    expect(html).toMatch(/<div class="ask-ph-label" id="ask-ph-mode-page">Mode<\/div>\s*<div class="cnpy-seg cnpy-seg--md cnpy-seg--fill ask-ph-seg" data-seg="ph-mode-page"/);
    const modes = [...html.matchAll(/data-act="askPhMode" data-arg="page:(\w+)"/g)].map((m) => m[1]);
    expect(modes).toEqual(["fast", "thinking"]);   // the picked one (Smart) carries no act
    expect(html).toContain("Reads the items it finds before answering. The default.");
    expect(html).toMatch(/<div class="ask-ph-label" id="ask-ph-auto-page">Changes in this thread<\/div>/);
    expect(html).toMatch(/aria-pressed="true">Ask before changes<\/button>/);
    expect(html).toMatch(/data-act="askPhAuto" data-arg="page:auto"[^>]*>Auto<\/button>/);
    // The Thinking hint carries #12's copy change.
    expect(plus((s) => { s.ask.composer.page.mode = "thinking"; })).toContain("Works through harder questions first. Slower. Counts as 5 questions.");
    expect(rule(".ask-ph-plusbtn[aria-expanded=\"true\"] > svg")).toContain("transform:rotate(45deg)");
  });

  it("Free: no Mode (one mode, no switcher); Auto off by an admin: the switch locked with the design's note", () => {
    expect(plus(() => undefined, "free")).not.toContain("ask-ph-mode-page");
    const off = plus((s) => { s.ask.state.data!.autoAllowed = false; });
    expect(off).toMatch(/<div class="ask-ph-group is-off" role="group"/);
    // A fully locked switch leaves the tab order: every option -1 (segmented()'s roving tabindex, #192).
    expect(off).toMatch(/<button type="button" tabindex="-1" data-field="seg:ph-auto-page:ask" class="cnpy-seg-btn is-on" disabled aria-pressed="true">Ask before changes<\/button><button type="button" tabindex="-1" data-field="seg:ph-auto-page:auto" class="cnpy-seg-btn" disabled aria-pressed="false">Auto<\/button>/);
    expect(off).toContain(AUTO_OFF_NOTE);
    expect(AUTO_OFF_NOTE).toBe("An admin turned off Auto for this org. Trov asks before every change.");
  });

  it("a menu belongs to one composer: the ⌘J panel's (full screen on a phone) opens its own", () => {
    const s = phoneState((x) => { x.ask.phone.plus = true; x.ask.phone.plusAt = "panel"; x.ask.cmdj = { ...x.ask.cmdj, open: true }; });
    expect(askScreenView(s)).not.toContain(`class="ask-ph-plus"`);
    expect(phoneComposerBar(askView(s, "panel"))).toContain(`id="ask-ph-plus-panel"`);
  });

  it("leaving: data-closing (it pops out); the acts toggle it, pick a mode, flip the switch, type @ and /", () => {
    expect(plus((s) => { s.ask.closing = { plus: true }; })).toMatch(/data-ask-plus="page" data-closing="1">/);
    const s = phoneState();
    const ctx = ctxOf(s);
    act(ctx, "askPhPlus", "page");
    expect([s.ask.phone.plus, s.ask.phone.plusAt]).toEqual([true, "page"]);
    act(ctx, "askPhPlus", "page");
    expect(s.ask.phone.plus).toBe(false);
    act(ctx, "askPhPlus", "panel");
    expect([s.ask.phone.plus, s.ask.phone.plusAt]).toEqual([true, "panel"]);
    act(ctx, "askPhMode", "page:thinking");
    expect(s.ask.composer.page.mode).toBe("thinking");
    act(ctx, "askPhAuto", "page:auto");
    expect(s.ask.composer.page.auto).toBe(true);
    act(ctx, "askPhAuto", "page:ask");
    expect(s.ask.composer.page.auto).toBe(false);
    s.ask.composer.page.text = "Who owns";
    act(ctx, "askPhMention", "page");
    expect(s.ask.composer.page.text).toBe("Who owns @");
    expect(s.ask.phone.plus).toBe(false);
    act(ctx, "askPhCommand", "page");
    expect(s.ask.composer.page.text).toBe("/");
    // No composer file input (no DOM here): a toast, never a second upload path.
    act(ctx, "askPhAttach", "page");
    expect((ctx as AskCtx & { flashes: string[] }).flashes).toEqual(["Couldn't open the file picker. Drop or paste the file instead."]);
  });

  // GUARD (mode access follows the plan): the + menu picks only a mode `ask/state` offers — Free cannot pick
  // Thinking through it (the server re-checks; this keeps the UI honest). Proof: drop the `modes.some` check in
  // ask-phone.ts `askPhMode` and this fails.
  it("guard: a mode the plan does not offer is never picked", () => {
    const s = phoneState(() => undefined, "free");
    const ctx = ctxOf(s);
    act(ctx, "askPhMode", "page:thinking");
    expect(s.ask.composer.page.mode).toBeNull();
    act(ctx, "askPhMode", "page:bogus");
    expect(s.ask.composer.page.mode).toBeNull();
  });

  // GUARD (Auto off by an admin): the switch never turns Auto on. Proof: drop the `autoAllowed` check in
  // `askPhAuto` and this fails.
  it("guard: Auto never turns on when an admin turned it off", () => {
    const s = phoneState((x) => { x.ask.state.data!.autoAllowed = false; });
    const ctx = ctxOf(s);
    act(ctx, "askPhAuto", "page:auto");
    expect(s.ask.composer.page.auto).toBeNull();
  });
});

describe("phone — the inspector sheet (`phone-insp`)", () => {
  it("full height with the grab handle, no resize edge, its header finger-sized", () => {
    const html = askScreenView(phoneState((s) => { s.ask.inspector = { ...s.ask.inspector, stack: ["ticket:14"], idx: 0 }; }));
    expect(html).toMatch(/<aside class="ask-insp-frame" aria-label="Inspector" data-sheet="1" data-where="page" data-dragging="0" style="">\s*<div class="ask-insp-grab" aria-hidden="true"><span><\/span><\/div>/);
    expect(html).not.toContain("data-ask-resize");
    expect(rule('.ask-insp-frame[data-sheet="1"]')).toMatch(/animation:ask-sheet-up \.26s cubic-bezier\(\.2,\.8,\.2,1\) both/);
    expect(rule('.ask-insp-frame[data-sheet="1"][data-closing]')).toMatch(/animation:ask-sheet-down/);
    // The ⌘J panel's inspector is a sheet over the full-screen panel, not 420px to its left.
    expect(rule('.ask-panel-layer > .ask-insp-frame[data-sheet="1"]')).toMatch(/position:fixed; inset:0; right:0/);
  });
});

describe("phone — the replay's scenarios", () => {
  it("phone plays the answer; phone-plus opens the + menu; phone-insp opens #14 once the answer is in", () => {
    for (const sc of ["phone", "phone-plus", "phone-insp"]) expect(replayPlan(sc).play).toEqual(["answer"]);
    const s = phoneState();
    const ctx = ctxOf(s);
    replayPlan("phone-plus").setup!(ctx);
    expect(s.ask.phone.plus).toBe(true);
    replayPlan("phone-insp").after!(ctx);
    expect(s.ask.inspector.stack).toEqual(["ticket:14"]);
  });
});

describe("phone — motion", () => {
  it("the drawer slides, the sheet slides, the + menu pops; all of it off under reduced motion", () => {
    expect(rule(".ask-drawer")).toMatch(/animation:ask-drawer-in/);
    expect(rule(".ask-drawer-layer[data-closing] .ask-drawer")).toMatch(/animation:ask-drawer-out/);
    expect(rule(".ask-ph-plus")).toMatch(/animation:ask-pop-in/);
    expect(rule(".ask-ph-plus[data-closing]")).toMatch(/animation:ask-pop-out/);
    const reduce = ask.slice(ask.indexOf("@media (prefers-reduced-motion: reduce)"));
    const block = reduce.slice(0, reduce.indexOf("\n}\n"));
    for (const sel of [".ask-ph-plus", ".ask-ph-plus[data-closing]", ".ask-drawer", ".ask-drawer-scrim", ".ask-insp-frame"]) expect(block).toContain(sel);
    expect(block).toMatch(/\.ask-ph-plusbtn > svg \{ transition:none !important; \}/);
    expect(rule(".ask-ph-plusbtn > svg")).toMatch(/transition:transform/);
  });
});
