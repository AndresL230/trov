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
  trovSettingsTiles, initialTrovPrefs, counterTone, oneModeLine,
  TROV_TRY, TROV_SEES, TROV_DOES_NOT, TROV_GATE, TROV_OFF, TROV_SAVED, type TrovPrefsUi,
} from "../web/src/ask-settings";
import { createTrovPrefs, appendTry } from "../web/src/ask-settings-actions";
import { render, initialState } from "../web/src/render";
import { setApiOrg } from "../web/src/api";
import { esc } from "../web/src/ui";
import { askSettingsFixture, askStateFixture } from "@shared/ai-fixtures";
import { ASK_INSTRUCTIONS_MAX, ASK_MODES, type AskSettings, type AskState } from "@shared/ai-ask-core";
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
const saveBtn = (html: string) => html.match(/<button type="button" data-act="trovSetSave"[^>]*>[^<]*<\/button>/)?.[0] ?? "";

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
    expect(saveBtn(tiles(ui("pro", { saved: true })))).toMatch(/>Saved</);
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
    expect(html).toContain(esc(TROV_OFF));
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
    expect(tiles(ui("pro"))).toMatch(/id="trov-instr-count" data-trov-count="quiet" aria-live="polite"[^>]*>0 \/ 500</);
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
    // The lists' marks are shapes (marks.ts), never a pill or a ● character.
    expect(html).not.toContain("●");
  });

  it("loading: skeletons and no Save; a failed read: the sentence and Try again", () => {
    const loading = tiles({ ...initialTrovPrefs(), slug: "acme", settings: { status: "loading", data: null } });
    expect(loading).not.toContain('id="trov-instr"');
    expect(loading).toContain("cnpy-sk");
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
    const h = { state: { trovPrefs: initialTrovPrefs(), orgSlug: "acme" as string | null }, rerender: () => {}, unauth: () => {}, flash: (m: string) => { flashes.push(m); } };
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
});
