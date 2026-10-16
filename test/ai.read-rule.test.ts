// THE READ RULE of every computed AI surface (owner rulings 2026-10-16: Q17, Q18, Q13, Q19; src/plans/gate.ts
// `aiShown`, docs/architecture/ai.md › The read rule): a deployment with NO Anthropic key reads EXACTLY like the org's
// switch off — the brief, the repo state, the themes, the Roadmap's notes, drift and suggestions and the ticket /
// Unplaced / Review cards are all ABSENT (on the screens and on MCP), and a decision on a suggestion (Accept, Dismiss)
// is refused `off`. LOCAL_AI_PREVIEW honours both, so the off state can be screenshotted. At the month's cap every
// surface sends `capped` with its last version — Planning (the themes) and the Roadmap included.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { aiShown } from "../src/plans/gate";
import { storeBrief } from "../src/data/person-brief";
import { storedBrief } from "../src/tools/mywork";
import { appendRepoState, readRepoState } from "../src/tools/repo-state";
import { readRepoThemes } from "../src/tools/themes";
import { insertProposedThemes } from "../src/data/themes";
import { planDrift, putInsight, roadmapSuggestions, sprintNotes } from "../src/data/org-insights";
import { openSuggestions } from "../src/data/ai-cards";
import { putSuggestion } from "../src/data/ai";
import { get_plan } from "../src/tools/plan";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { create_ticket } from "../src/tools/tickets";
import { AI_ROADMAP_ITEM } from "@shared/ai";
import { run } from "./helpers/db";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { addOrgRepo } from "./helpers/org-config";
import { useAiKey, withoutAiKey } from "./helpers/ai-key";

useAiKey();

const REPO = "AndresL230/trov";
const ME = "AndresL230";
const ctx = () => systemCtx(ORG_A);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const cite = { ref: "pr:12", label: "#12", href: null };
const switchOff = () => run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
const spendTheMonth = async () => {
  await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
  await run(env.DB, `INSERT INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES (?, ?, 'ai_run:brief.person', 'ai-pass', 250, ?)`,
    ORG_A, new Date().toISOString().slice(0, 10), new Date().toISOString());
};

/** One of everything Trov writes, stored as the pass stores it. Returns the ids a test acts on. */
async function writeEverything(): Promise<{ sprint: number; ticket: number; ticketSuggestion: number; roadmapSuggestion: number; themeSuggestion: number }> {
  const c = ctx();
  await storeBrief(c, ME, {
    generatedAt: iso(60_000), model: "claude-haiku-5-5", promptVersion: "brief.3", inputHash: "h",
    briefJson: JSON.stringify({ now: { text: "Shipping the hosting screens.", cites: [cite] }, recently: null, next: { items: [] } }),
  });
  await appendRepoState(c, REPO, {
    state: { headline: "Hosting shipped.", shipped: [{ text: "Hosting screens merged.", cites: [cite] }], inFlight: [], attention: [] },
    basisUntil: iso(0), model: "claude-haiku-5-5", promptVersion: "state-1", eventCount: 1, at: iso(60_000),
  });
  const [theme] = await insertProposedThemes(c, REPO, [
    { name: "Hosting", description: "Providers and deploys.", colorKey: "ochre", position: 0, seedPrs: [] },
    { name: "Billing", description: "Checkout.", colorKey: "slate", position: 1, seedPrs: [] },
  ], { createdBy: "trov", model: "claude-haiku-5-5", promptVersion: "propose-1" }, iso(120_000));
  await run(env.DB, `UPDATE repo_themes SET status = 'active' WHERE org_id = ? AND id = ?`, ORG_A, theme);
  const themeSuggestion = (await putSuggestion(c, {
    itemType: "theme", itemRef: `${REPO}#${theme + 1}`, kind: "themes.propose", value: {}, confidence: null, reason: "Checkout work.", cites: [], model: "m", promptVersion: "p",
  }))!;
  const sp = await create_sprint(c, { label: "Hosting", urgency: "normal", start: "2026-10-01", due: "2026-10-30" }, ME);
  await set_sprint_active(c, sp.id, true);
  await putInsight(c, "sprint_note", String(sp.id), { text: "Two of five done.", cites: [{ ref: "ticket:1", label: "#1", href: null }] }, { model: "m", promptVersion: "p" });
  await putInsight(c, "plan_drift", "", { text: "Mostly billing.", cites: [{ ref: "theme:b", label: "Billing", href: null }], windowDays: 14, shares: [] }, { model: "m", promptVersion: "p" });
  const roadmapSuggestion = (await putSuggestion(c, {
    ...AI_ROADMAP_ITEM, kind: "plan_narrative", value: { narrative: "Ship hosting, then billing." }, confidence: null, reason: "The plan is stale.", cites: [], model: "m", promptVersion: "p",
  }))!;
  const ticket = await create_ticket(c, { title: "Login is slow", body: "", category: "other", priority: "normal", assignees: [] }, ME);
  const ticketSuggestion = (await putSuggestion(c, {
    itemType: "ticket", itemRef: String(ticket), kind: "ticket.category", value: "bug", confidence: 0.9, reason: "It says slow.", cites: [], model: "jev", promptVersion: "p",
  }))!;
  return { sprint: sp.id, ticket, ticketSuggestion, roadmapSuggestion, themeSuggestion };
}

/** What every computed surface reads right now, for the system context (no viewer). */
async function surfaces(sprint: number, ticket: number) {
  const c = ctx();
  return {
    brief: await storedBrief(c, ME),
    state: await readRepoState(c, REPO),
    themes: await readRepoThemes(c, REPO),
    notes: [...(await sprintNotes(c)).keys()],
    oneNote: (await sprintNotes(c, sprint)).size,
    drift: await planDrift(c),
    roadmap: (await roadmapSuggestions(c)).length,
    cards: (await openSuggestions(c, "ticket", [String(ticket)], ["ticket.category"])).length,
  };
}
const NOTHING = { brief: null, state: undefined, themes: undefined, notes: [], oneNote: 0, drift: null, roadmap: 0, cards: 0 };

async function post(path: string, cookie: string, body: unknown = {}): Promise<{ status: number; json: { error?: string } }> {
  const res = await app.request(`/api/o/saplinglearn${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env as unknown as Env);
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

describe("THE read rule: no key reads exactly like the switch off", () => {
  let ids: Awaited<ReturnType<typeof writeEverything>>;
  beforeEach(async () => { ids = await writeEverything(); });

  it("with a key and the switch on, every surface shows what Trov wrote", async () => {
    const s = await surfaces(ids.sprint, ids.ticket);
    expect(s.brief).toMatchObject({ state: "ready" });
    expect(s.state).toMatchObject({ state: "ready", headline: "Hosting shipped." });
    expect(s.themes?.["8w"]).toMatchObject({ state: "ready" });
    expect(s.notes).toEqual([String(ids.sprint)]);
    expect(s.drift).toMatchObject({ text: "Mostly billing." });
    expect(s.drift).not.toHaveProperty("state");
    expect(s.roadmap).toBe(1);
    expect(s.cards).toBe(1);
  });

  it("no Anthropic key: every surface is ABSENT, reading nothing — the same answer as the switch off", async () => {
    const noKey = await withoutAiKey(() => surfaces(ids.sprint, ids.ticket));
    expect(noKey).toEqual(NOTHING);
    expect(await withoutAiKey(() => aiShown(ctx()))).toEqual({ shown: false });
    await switchOff();
    expect(await surfaces(ids.sprint, ids.ticket)).toEqual(NOTHING);
    expect(await aiShown(ctx())).toEqual({ shown: false });
  });

  it("the screens' reads carry no field without a key: /me/dashboard, /repo/dashboard, /roadmap, the ticket", async () => {
    await run(env.DB, `UPDATE org_repos SET is_primary = 0 WHERE org_id = ?`, ORG_A);
    await addOrgRepo(REPO);
    const cookie = await cookieFor(ME);
    const get = async (p: string) => (await (await app.request(`/api/o/saplinglearn${p}`, { headers: { cookie } }, env as unknown as Env)).json()) as Record<string, unknown>;
    const keyed = { roadmap: await get("/roadmap"), ticket: await get(`/tickets/${ids.ticket}`), me: await get("/me/dashboard") };
    expect(keyed.roadmap).toHaveProperty("drift");
    expect(keyed.roadmap).toHaveProperty("suggestions");
    expect(keyed.ticket).toHaveProperty("ai");
    expect(keyed.me).toHaveProperty("brief");
    await withoutAiKey(async () => {
      const roadmap = await get("/roadmap");
      expect(roadmap).not.toHaveProperty("drift");
      expect(roadmap).not.toHaveProperty("suggestions");
      expect((roadmap.sprints as { note?: unknown }[]).filter((s) => s.note)).toEqual([]);
      expect(await get(`/tickets/${ids.ticket}`)).not.toHaveProperty("ai");
      expect(await get("/me/dashboard")).not.toHaveProperty("brief");
      const dash = await get("/repo/dashboard");
      expect(dash).not.toHaveProperty("state");
      expect(dash).not.toHaveProperty("themes");
    });
  });

  it("theme and Roadmap decisions (and every other) are refused `off` with no key or the switch off — nothing is decided", async () => {
    const admin = await cookieFor(ME);
    const state = async (id: number) => (await env.DB.prepare(`SELECT state FROM ai_suggestions WHERE id = ?`).bind(id).first<{ state: string }>())!.state;
    for (const id of [ids.themeSuggestion, ids.roadmapSuggestion, ids.ticketSuggestion]) {
      for (const verb of ["accept", "dismiss"]) {
        expect(await withoutAiKey(() => post(`/ai/suggestions/${id}/${verb}`, admin))).toEqual({ status: 403, json: { error: "off" } });
      }
    }
    await switchOff();
    for (const id of [ids.themeSuggestion, ids.roadmapSuggestion, ids.ticketSuggestion]) {
      for (const verb of ["accept", "dismiss"]) expect(await post(`/ai/suggestions/${id}/${verb}`, admin)).toEqual({ status: 403, json: { error: "off" } });
      expect(await state(id)).toBe("open");
    }
    // Another org's id (or none) is still `not_found` first: `off` says nothing about a suggestion that is not this org's.
    expect((await post(`/ai/suggestions/999999/accept`, admin)).status).toBe(404);
  });
});

describe("at the cap, every surface sends `capped` with its last version — Planning and the Roadmap included (Q19)", () => {
  it("the themes and the Roadmap's note and drift say capped, with the day it resumes and Upgrade on Free", async () => {
    const ids = await writeEverything();
    await spendTheMonth();
    const s = await surfaces(ids.sprint, ids.ticket);
    const resumes = /^\d{4}-\d{2}-01$/;
    expect(s.brief).toMatchObject({ state: "capped", upgrade: true });
    expect(s.state).toMatchObject({ state: "capped", upgrade: true, headline: "Hosting shipped." });
    for (const range of ["8w", "quarter"] as const) {
      expect(s.themes?.[range]).toMatchObject({ state: "capped", upgrade: true });
      expect(s.themes?.[range]?.resumesOn).toMatch(resumes);
    }
    expect(s.drift).toMatchObject({ text: "Mostly billing.", state: "capped", upgrade: true });
    expect(s.drift?.resumesOn).toMatch(resumes);
    const note = (await sprintNotes(ctx())).get(String(ids.sprint));
    expect(note).toMatchObject({ text: "Two of five done.", state: "capped", upgrade: true });
    const plan = await get_plan(ctx());
    expect(plan.sprints.find((sp) => sp.id === ids.sprint)?.note).toMatchObject({ state: "capped" });
  });
});

describe("LOCAL_AI_PREVIEW honours the switch and the key (Q13): the off state can be screenshotted", () => {
  const LOCAL = "http://localhost:8787";
  const preview = (): Env => ({ ...(env as unknown as Env), LOCAL_AI_PREVIEW: "ready" });
  async function read(path: string, e: Env): Promise<Record<string, unknown>> {
    const res = await app.request(`${LOCAL}/api/o/saplinglearn${path}`, { headers: { cookie: await cookieFor(ME) } }, e);
    return (await res.json()) as Record<string, unknown>;
  }
  const trovRows = (feed: unknown) => (feed as { ai?: unknown }[]).filter((r) => r.ai);

  it("on: the samples; switch off or no key: no brief, state, themes, roadmap sample or Trov feed sample", async () => {
    expect(await read("/me/dashboard", preview())).toHaveProperty("brief");
    expect(await read("/repo/dashboard", preview())).toHaveProperty("themes");
    expect(trovRows((await read("/feed", preview())).feed).length).toBeGreaterThan(0);
    for (const off of [() => withoutAiKey(async () => preview()), async () => { await switchOff(); return preview(); }]) {
      const e = await off();
      // `withoutAiKey` restores the pool's key after its callback; the copy it returned keeps the blank one.
      const me = await read("/me/dashboard", e);
      expect(me).not.toHaveProperty("brief");
      const dash = await read("/repo/dashboard", e);
      expect(dash).not.toHaveProperty("state");
      expect(dash).not.toHaveProperty("themes");
      expect(await read("/roadmap", e)).not.toHaveProperty("drift");
      expect(trovRows((await read("/feed", e)).feed)).toEqual([]);
      const settings = await read("/ai/settings", e);
      expect(["off", "no_key"]).toContain(settings.eligibility);
    }
  });
});
