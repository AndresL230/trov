/**
 * Settings › Trov (web/src/ask-settings.ts, ask-settings-actions.ts; Trov handoff #12 §3, the design's `settings`
 * scenario), as markup and as a controller over a recording `fetch`:
 *
 *  • Pro: the default-mode switch over the plan's modes (their words from `ask/state`), the picked mode's hint
 *  • Free: no switch — "On Free, every question uses Smart." — and Save never sends a default mode
 *  • Ask switched off for the org: the design's off line, the form still there
 *  • the counter: "N / 500", amber in the last tenth, red and Save refused past the limit
 *  • the design's copy (instructions, Try chips, What Trov can see, the gate line), loading and a failed read
 *  • a read for another organization is never shown as this one's; outside an org, nothing
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  trovSettingsTiles, trovOrbDropdown, initialTrovPrefs, counterTone, oneModeLine, TROV_ORB_NOTE,
  TROV_TRY, TROV_SEES, TROV_DOES_NOT, TROV_GATE, TROV_OFF, TROV_SAVED, TROV_WHERE, type TrovPrefsUi,
} from "../web/src/ask-settings";
import { createTrovPrefs, appendTry } from "../web/src/ask-settings-actions";
import { render, initialState } from "../web/src/render";
import { setApiOrg } from "../web/src/api";
import { esc } from "../web/src/ui";
import { askSettingsFixture, askStateFixture } from "@shared/ai-fixtures";
import { ASK_INSTRUCTIONS_MAX, ASK_MODES, type AskSettings, type AskState } from "@shared/ai-ask-core";
import { dropdownMenu, initialDropdownUi } from "../web/src/dropdown";
import { ASK_ORB_CHOICES, ASK_ORB_KEY, ASK_ORB_MATCH_TOUR, askOrbState, parseAskOrb, type AskOrbChoice } from "../web/src/ask-orb";
import { thinkingOrbTour, tourState, TOUR_SECONDS } from "../web/src/thinking-orb";
import mainSrc from "../web/src/main.ts?raw";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ui = (plan: "pro" | "free", o: Partial<TrovPrefsUi> = {}, settings: Partial<AskSettings> = {}, state: Partial<AskState> = {}): TrovPrefsUi => ({
  ...initialTrovPrefs(), slug: "acme",
  settings: { status: "ok", data: { ...askSettingsFixture(plan), ...settings } },
  state: { status: "ok", data: { ...askStateFixture(plan, NOW), ...state } },
  ...o,
});
const tiles = (u: TrovPrefsUi) => trovSettingsTiles(u, "acme");
const count = (html: string) => html.match(/data-trov-count="(\w+)"[^>]*>([^<]*)</)?.slice(1);
const saveBtn = (html: string) => html.match(/<button type="button" data-act="trovSetSave"[^>]*>.*?<\/button>/)?.[0] ?? "";

describe("Settings › Trov on Pro", () => {
  it("offers the plan's modes as ONE segmented switch, the picked one's hint under it, and the Free line at the foot", () => {
    const html = tiles(ui("pro", {}, { instructions: "Keep it short.", defaultMode: "thinking" }));
    expect(html).toContain('data-seg="trov-defmode"');
    expect(html).toContain('aria-label="Default mode"');
    for (const m of ASK_MODES) expect(html).toMatch(new RegExp(`data-arg="${m.id}"[^>]*aria-pressed="${m.id === "thinking"}"|aria-pressed="${m.id === "thinking"}"[^>]*>${m.label}<`));
    expect(html).toContain('class="cnpy-seg-btn is-on" aria-pressed="true">Thinking<');
    // The hint is the state's (ASK_MODES): Thinking says what it counts as.
    expect(html).toContain(esc(ASK_MODES.find((m) => m.id === "thinking")!.hint));
    expect(html).toContain("Counts as 5 questions.");
    expect(html).toContain("New threads start in this mode. You can switch per question in the composer.");
    expect(html).toContain("On Free, every question uses Smart.");
    expect(html).not.toContain("data-trov-onemode");
    expect(html).toContain(">Keep it short.</textarea>");
    expect(count(html)).toEqual(["quiet", "14 / 500"]);
    expect(html).not.toContain("<select");
  });

  it("a picked-but-unsaved mode shows as picked; Save reads Saving… while it goes, Saved after", () => {
    expect(tiles(ui("pro", { draftMode: "fast" }))).toContain('class="cnpy-seg-btn is-on" aria-pressed="true">Fast<');
    expect(saveBtn(tiles(ui("pro", { saving: true })))).toMatch(/disabled[^>]*>Saving&hellip;</);
    expect(saveBtn(tiles(ui("pro", { saved: true })))).toMatch(/>Saved<\/span><\/button>$/);
    expect(saveBtn(tiles(ui("pro")))).toMatch(/>Save</);
    expect(saveBtn(tiles(ui("pro")))).not.toContain("disabled");
  });

  it("draws the modes from `ask/state`: a mode the state does not list is not offered", () => {
    const st = askStateFixture("pro", NOW);
    const html = tiles(ui("pro", {}, {}, { modes: st.modes.filter((m) => m.id !== "fast") }));
    expect(html).not.toMatch(/>Fast</);
    expect(html).toMatch(/>Smart</);
  });
});

describe("Settings › Trov on Free", () => {
  it("has no switch: the one-mode line says every question uses Smart", () => {
    const html = tiles(ui("free"));
    expect(html).not.toContain("data-seg=");
    expect(html).toContain('data-trov-onemode style="margin:14px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">On Free, every question uses Smart.<');
    expect(html).not.toContain("You can switch per question");
    // The instructions are everyone's.
    expect(html).toContain('id="trov-instr"');
  });

  it("names the plan on screen when it is not Free (Personal also has one mode)", () => {
    expect(oneModeLine("personal")).toBe("On Personal, every question uses Smart.");
    expect(oneModeLine("free")).toBe("On Free, every question uses Smart.");
    expect(tiles(ui("free", {}, {}, { plan: "personal" }))).toContain("On Personal, every question uses Smart.");
  });
});

describe("Ask switched off for the org", () => {
  it("says so in the design's words and keeps the form (the instructions apply once it is on)", () => {
    const html = tiles(ui("pro", {}, {}, { enabled: false, eligibility: "off" }));
    expect(html).toContain("data-trov-off");
    // The design's words, "Org settings › AI" opening that tab.
    expect(TROV_OFF).toBe("Ask Trov is off for this org. An admin can turn it on in Org settings › AI.");
    expect(html).toContain('Ask Trov is off for this org. An admin can turn it on in <button type="button" data-act="orgGo" data-arg="ai"');
    expect(html).toMatch(/data-arg="ai"[^>]*>Org settings &rsaquo; AI<\/button>\./);
    expect(html).toContain('id="trov-instr"');
    expect(saveBtn(html)).not.toContain("disabled");
    expect(tiles(ui("pro"))).not.toContain("data-trov-off");
  });
});

describe("the 500-character counter", () => {
  it("is quiet, then amber in the last tenth, at the limit too", () => {
    expect(counterTone(0)).toBe("quiet");
    expect(counterTone(450)).toBe("quiet");
    expect(counterTone(451)).toBe("near");
    expect(counterTone(500)).toBe("near");
    const at = tiles(ui("pro", { draftInstructions: "x".repeat(ASK_INSTRUCTIONS_MAX) }));
    expect(count(at)).toEqual(["near", "500 / 500"]);
    expect(at).toMatch(/data-trov-count="near"[^>]*color:var\(--amber\)/);
    expect(at).toContain('maxlength="500"');
    expect(saveBtn(at)).not.toContain("disabled");
  });

  it("past the limit is red, marks the field invalid and refuses Save", () => {
    const over = tiles(ui("pro", { draftInstructions: "x".repeat(ASK_INSTRUCTIONS_MAX + 1) }));
    expect(count(over)).toEqual(["over", "501 / 500"]);
    expect(over).toMatch(/data-trov-count="over"[^>]*color:var\(--red\)/);
    expect(over).toContain('aria-invalid="true"');
    expect(saveBtn(over)).toContain("disabled");
  });

  it("is always emitted, so typing patches the page in place (and it is announced politely)", () => {
    expect(tiles(ui("pro"))).toMatch(/id="trov-instr-count" class="cnpy-trov-count" data-trov-count="quiet" aria-live="polite"[^>]*>0 \/ 500</);
    expect(tiles(ui("pro"))).toContain('aria-describedby="trov-instr-count"');
  });
});

describe("the design's copy and the states around it", () => {
  it("instructions, Try chips, What Trov can see and the gate line, exactly", () => {
    const html = tiles(ui("pro"));
    expect(html).toContain('<label for="trov-instr">How Trov should answer you</label>');
    expect(html).toContain("Trov follows this in every new thread. It shapes tone and length, not what Trov can see.");
    expect(html).toContain('placeholder="For example: lead with what is blocked, and keep it short."');
    TROV_TRY.forEach((t, i) => { expect(html).toContain(`data-act="trovSetTry" data-arg="${i}"`); expect(html).toContain(esc(t)); });
    expect(html).toContain(">What Trov can see<");
    expect(html).toContain(">It reads<");
    expect(html).toContain(">It does not<");
    for (const t of [...TROV_SEES, ...TROV_DOES_NOT]) expect(html).toContain(esc(t));
    expect(html).toContain(esc(TROV_GATE));
    // Where what it reads is connected: each Org settings tab a link (#186's split).
    expect(TROV_WHERE.map((w) => w.tab)).toEqual(["integrations", "repos", "hosting", "environments"]);
    for (const w of TROV_WHERE) expect(html).toMatch(new RegExp(`data-act="orgGo" data-arg="${w.tab}"[^>]*>${w.label}</button>`));
    expect(html).toContain("GitHub, hosts and environments are connected in Org settings &rsaquo; ");
    // The lists' marks are shapes (marks.ts), never a pill or a ● character.
    expect(html).not.toContain("●");
  });

  it("loading: skeletons and no Save; a failed read: the sentence and Try again", () => {
    const loading = tiles({ ...initialTrovPrefs(), slug: "acme", settings: { status: "loading", data: null } });
    expect(loading).not.toContain('id="trov-instr"');
    expect(loading).toContain("cnpy-sk");
    // The house skeletons (skeleton.ts): a clock per region, and the content settles in when the read lands.
    expect(loading).toContain('data-skel="trov-instr"');
    expect(loading).toContain('data-skel="trov-mode"');
    expect(saveBtn(loading)).toContain("disabled");
    const failed = tiles({ ...initialTrovPrefs(), slug: "acme", settings: { status: "error", data: null }, state: { status: "error", data: null } });
    expect(failed).toContain("Couldn&#39;t load your Trov settings.");
    expect(failed).toContain('data-act="trovSetRetry"');
    expect(saveBtn(failed)).toContain("disabled");
  });

  it("without `ask/state` the modes come from the settings' own list, read against ASK_MODES", () => {
    const html = tiles({ ...ui("pro"), state: { status: "error", data: null } });
    expect(html).toContain('data-seg="trov-defmode"');
    expect(html).toContain(esc(ASK_MODES.find((m) => m.id === "smart")!.hint));
  });

  it("a read for another organization is not shown as this one's; outside an org, nothing", () => {
    const other = trovSettingsTiles({ ...ui("pro", {}, { instructions: "Birch's words" }), slug: "birch" }, "acme");
    expect(other).not.toContain("Birch&#39;s words");
    expect(other).not.toContain('id="trov-instr"');
    expect(trovSettingsTiles(ui("pro"), null)).toBe("");
  });

  it("sits in personal Settings after MCP access, placed by name in the bento", () => {
    const me = { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "owner" as const }], superadmin: false, pending_invites: 0 };
    const html = render({ ...initialState(), view: "app", screen: "settings", me, orgSlug: "acme", trovPrefs: ui("pro") });
    const at = (cls: string) => html.indexOf(`cnpy-surface ${cls}"`);
    expect(at("cnpy-set-mcp")).toBeGreaterThan(0);
    expect(at("cnpy-set-trov-instr")).toBeGreaterThan(at("cnpy-set-mcp"));
    expect(at("cnpy-set-trov-mode")).toBeGreaterThan(at("cnpy-set-trov-instr"));
    expect(at("cnpy-set-trov-see")).toBeGreaterThan(at("cnpy-set-trov-mode"));
    for (const cls of ["cnpy-set-trov-instr", "cnpy-set-trov-mode", "cnpy-set-trov-see"]) expect(css).toMatch(new RegExp(`\\.${cls} \\{ grid-column:`));
    expect(css).toContain("/* ── Ask: Settings › Trov ── */".slice(0, 26));
  });
});

describe("While it works — the thinking orb Ask shows (ask-orb.ts)", () => {
  const trigger = (html: string): string => html.match(/<button type="button" id="trov-orb"[^]*?<\/button>/)?.[0] ?? "";

  it("closes the Default mode tile on any plan: its label, its note and ONE dropdown (never a <select>), default Match", () => {
    for (const plan of ["pro", "free"] as const) {
      const html = tiles(ui(plan));
      const mode = html.slice(html.indexOf("cnpy-set-trov-mode"), html.indexOf("cnpy-set-trov-see"));
      expect(mode).toContain('<div id="trov-orb-l"');
      expect(mode).toContain(">While it works</div>");
      expect(mode).toContain(esc(TROV_ORB_NOTE));
      expect(mode).toContain('data-dd="trov-orb"');
      expect(mode).not.toContain("<select");
      const t = trigger(html);
      expect(t).toContain('data-act="ddToggle" data-arg="trov-orb"');
      expect(t).toContain('aria-labelledby="trov-orb-l trov-orb"');
      expect(t).toContain(`<span class="cnpy-dd-v">${esc("Match what it's doing")}</span>`);
      // Match previews itself as a tour of the orbs Ask really uses, decorative beside its words.
      expect(t).toContain(`data-orb="tour" data-orb-tour="${ASK_ORB_MATCH_TOUR.join(" ")}"`);
      expect(t).toMatch(/<span class="cnpy-dd-icon" aria-hidden="true"><canvas class="cnpy-orb"[^>]*aria-hidden="true"/);
    }
    // It does not wait for the server: it is there while the rows load, and when their read failed.
    expect(tiles({ ...initialTrovPrefs(), slug: "acme" })).toContain('data-dd="trov-orb"');
    expect(tiles({ ...initialTrovPrefs(), slug: "acme", settings: { status: "error", data: null } })).toContain('data-dd="trov-orb"');
  });

  it("shows the pick in the trigger — its plain name and its own orb animating", () => {
    const html = trovSettingsTiles(ui("pro"), "acme", { choice: "searching", dd: initialDropdownUi() });
    const t = trigger(html);
    expect(t).toContain('<span class="cnpy-dd-v">Globe</span>');
    expect(t).toMatch(/<canvas class="cnpy-orb" data-orb="searching" data-orb-size="20"/);
    expect(trigger(trovSettingsTiles(ui("pro"), "acme", { choice: "solving", dd: { open: "trov-orb", opening: false, closing: false } }))).toContain('aria-expanded="true"');
  });

  it("its menu: Match, then the six animations by name, each row with its 20px orb; the pick check-marked", () => {
    expect(ASK_ORB_CHOICES.map((c) => c.label)).toEqual(["Match what it's doing", "Orbits", "Globe", "Cube", "Wave", "Ribbon", "Shapes"]);
    const menu = dropdownMenu([trovOrbDropdown("listening")], { open: "trov-orb", opening: true, closing: false });
    expect(menu).toContain('role="listbox" aria-labelledby="trov-orb-l"');
    expect(menu).toContain('data-dd-act="trovSetOrb"');
    const rows = menu.match(/<button type="button" role="option"[^]*?<\/button>/g) ?? [];
    expect(rows).toHaveLength(7);
    ASK_ORB_CHOICES.forEach((c, i) => {
      expect(rows[i]).toContain(`data-arg="${c.value}"`);
      expect(rows[i]).toContain(`<span class="cnpy-dd-optl">${esc(c.label)}</span>`);
      expect(rows[i]).toMatch(c.value === "match" ? /data-orb="tour"/ : new RegExp(`data-orb="${c.value}" data-orb-size="20"`));
      expect(rows[i]).toContain(`aria-selected="${c.value === "listening"}"`);
    });
    expect(rows[0]).toContain('<span class="cnpy-dd-opth">Searching, thinking and writing each look different.</span>');
  });

  it("the Settings screen draws its menu among the root overlays while it is open", () => {
    const me = { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "owner" as const }], superadmin: false, pending_invites: 0 };
    const s = { ...initialState(), view: "app" as const, screen: "settings" as const, me, orgSlug: "acme", trovPrefs: ui("pro") };
    s.ask = { ...s.ask, orb: "composing" };
    expect(render(s)).not.toContain('data-overlay="dd-trov-orb"');
    s.dd = { open: "trov-orb", opening: false, closing: false };
    const html = render(s);
    expect(html).toContain('data-overlay="dd-trov-orb"');
    expect(html).toContain('<span class="cnpy-dd-v">Ribbon</span>');
  });

  it("the choice: Match follows what each place means; one animation replaces them all; a bad stored value is Match", () => {
    expect(askOrbState("match", "searching")).toBe("searching");
    expect(askOrbState("match", "solving")).toBe("solving");
    expect(askOrbState("listening", "searching")).toBe("listening");
    expect(askOrbState("shaping", "composing")).toBe("shaping");
    expect(parseAskOrb("solving")).toBe("solving");
    for (const bad of [null, undefined, "", "tour", "spinner", 3]) expect(parseAskOrb(bad)).toBe("match");
    // main.ts reads it at start, per browser.
    expect(mainSrc).toContain("state.ask.orb = parseAskOrb(localStorage.getItem(ASK_ORB_KEY))");
  });

  it("a tour shows each state in turn on the shared clock; under reduced motion (t = 0.6s) its first", () => {
    const tour = ["working", "searching", "solving"];
    expect(tourState(tour, 0.6)).toBe("working");
    expect(tourState(tour, TOUR_SECONDS + 0.1)).toBe("searching");
    expect(tourState(tour, TOUR_SECONDS * 3 + 0.1)).toBe("working");
    expect(tourState([], 1)).toBeUndefined();
    expect(thinkingOrbTour(["solving", "working"], 20, null)).toMatch(/^<canvas class="cnpy-orb" data-orb="tour" data-orb-tour="solving working" data-orb-size="20"[^>]*aria-hidden="true"/);
  });

  it("the trigger and its rows lay the orb out before the words (trov.css)", () => {
    expect(css).toMatch(/\.cnpy-dd-lead \{ display:flex; align-items:center;/);
    expect(css).toMatch(/\.cnpy-dd-icon \{[^}]*width:20px; height:20px;/);
    expect(css).toMatch(/\.cnpy-trov-orb \{ padding-top:14px; border-top:1px solid var\(--border\); \}/);
  });
});

describe("motion (web-ui.md › Sidebar & motion)", () => {
  it("eases what changes in place, \"Saved\" rises once as its own node, and all of it is off under reduced motion", () => {
    expect(tiles(ui("pro"))).toContain('class="cnpy-trov-count"');
    expect(saveBtn(tiles(ui("pro")))).toContain("cnpy-trov-save");
    expect(saveBtn(tiles(ui("pro", { saved: true })))).toContain('<span class="cnpy-trov-saved">Saved</span>');
    expect(tiles(ui("pro", { error: "No." }))).toContain('class="cnpy-trov-err"');
    const block = css.slice(css.indexOf("/* ── Ask: Settings › Trov ──"));
    expect(block).toMatch(/\.cnpy-trov-count \{ transition:color var\(--fx-base\)/);
    expect(block).toMatch(/\.cnpy-trov-saved \{[^}]*animation:cnpy-fade/);
    const reduced = block.slice(block.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.cnpy-trov-count, \.cnpy-trov-save[^{]*\{ transition:none; \}/);
    expect(reduced).toMatch(/\.cnpy-trov-saved, \.cnpy-trov-err:not\(\[hidden\]\) \{ animation:none; \}/);
  });
});

// ── the controller, over a recording fetch ───────────────────────────────────
describe("the controller (ask-settings-actions.ts)", () => {
  let asked: { method: string; url: string; body: unknown }[] = [];
  let answers: Record<string, () => Response> = {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    asked = [];
    setApiOrg("acme");
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${url.replace(/^.*\/api\/o\/acme/, "")}`;
      return (answers[key] ?? (() => json({ error: "nope" }, 500)))();
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); setApiOrg(null); });

  const host = (plan: "pro" | "free") => {
    answers = {
      "GET /ask/settings": () => json(askSettingsFixture(plan)),
      "GET /ask/state": () => json(askStateFixture(plan, NOW)),
      "PUT /ask/settings": () => json({ ...askSettingsFixture(plan), instructions: "saved" }),
    };
    const flashes: string[] = [];
    const h = { state: { trovPrefs: initialTrovPrefs(), orgSlug: "acme" as string | null, ask: { orb: "match" as AskOrbChoice } }, rerender: () => {}, unauth: () => {}, flash: (m: string) => { flashes.push(m); } };
    return { h, ctl: createTrovPrefs(h), flashes };
  };

  it("reads both for the org on screen; Try appends with a space; Save sends instructions and (Pro) the mode", async () => {
    const { h, ctl, flashes } = host("pro");
    await ctl.load();
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(["GET /api/o/acme/ask/settings", "GET /api/o/acme/ask/state"]);
    expect(h.state.trovPrefs.settings.status).toBe("ok");
    ctl.act("trovSetInstr", null, "Be brief.");
    ctl.act("trovSetTry", "1", null);
    expect(h.state.trovPrefs.draftInstructions).toBe(`Be brief. ${TROV_TRY[1]}`);
    ctl.act("trovSetMode", "thinking", null);
    ctl.act("trovSetMode", "turbo", null); // not a mode the plan offers: ignored
    expect(h.state.trovPrefs.draftMode).toBe("thinking");
    ctl.act("trovSetSave", null, null);
    await vi.waitFor(() => expect(h.state.trovPrefs.saved).toBe(true));
    const put = asked.find((a) => a.method === "PUT")!;
    expect(put.url).toBe("/api/o/acme/ask/settings");
    expect(put.body).toEqual({ instructions: `Be brief. ${TROV_TRY[1]}`, defaultMode: "thinking" });
    expect(h.state.trovPrefs.draftInstructions).toBeNull();
    expect(h.state.trovPrefs.settings.data?.instructions).toBe("saved");
    expect(flashes).toEqual([TROV_SAVED]);
  });

  it("on Free, Save never sends a default mode", async () => {
    const { h, ctl } = host("free");
    await ctl.load();
    ctl.act("trovSetMode", "thinking", null); // Free offers only Smart
    expect(h.state.trovPrefs.draftMode).toBeNull();
    ctl.act("trovSetInstr", null, "Short.");
    ctl.act("trovSetSave", null, null);
    await vi.waitFor(() => expect(asked.some((a) => a.method === "PUT")).toBe(true));
    expect(asked.find((a) => a.method === "PUT")!.body).toEqual({ instructions: "Short." });
  });

  it("a refused save says the server's sentence; typing cuts at the limit", async () => {
    const { h, ctl } = host("pro");
    await ctl.load();
    answers["PUT /ask/settings"] = () => json({ error: "mode_unavailable", message: "On Free, every question uses Smart." }, 403);
    ctl.act("trovSetSave", null, null);
    await vi.waitFor(() => expect(h.state.trovPrefs.error).toBe("On Free, every question uses Smart."));
    expect(h.state.trovPrefs.saving).toBe(false);
    ctl.act("trovSetInstr", null, "y".repeat(600));
    expect(h.state.trovPrefs.draftInstructions).toHaveLength(ASK_INSTRUCTIONS_MAX);
    expect(appendTry("x".repeat(499), "Long line")).toHaveLength(ASK_INSTRUCTIONS_MAX);
    expect(appendTry("", "Line")).toBe("Line");
    expect(appendTry("Text  \n", "Line")).toBe("Text Line");
  });

  it("a thinking-orb pick applies at once and is kept in this browser — not part of Save", async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    const { h, ctl } = host("pro");
    await ctl.load();
    let paints = 0;
    h.rerender = () => { paints++; };
    ctl.act("trovSetOrb", null, "listening");
    expect(h.state.ask.orb).toBe("listening");
    expect(store[ASK_ORB_KEY]).toBe("listening");
    expect(paints).toBe(1);
    ctl.act("trovSetOrb", null, "spinner"); // not a choice: ignored, nothing stored
    expect(h.state.ask.orb).toBe("listening");
    expect(store[ASK_ORB_KEY]).toBe("listening");
    ctl.act("trovSetOrb", null, "match");
    expect(h.state.ask.orb).toBe("match");
    expect(asked.some((a) => a.method === "PUT")).toBe(false);
    // Storage that throws (a private window) still applies the pick for this session.
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    ctl.act("trovSetOrb", null, "shaping");
    expect(h.state.ask.orb).toBe("shaping");
  });
});
