/**
 * Repo › Overview from facts (web/src/repo-overview.ts and its frame: repo-header.ts, repo-attention.ts,
 * repo-week.ts, repo-connect.ts, repo-verdict.ts) — pure render tests over the design's scenarios A–N
 * (web/src/repo-sample.ts `repoScenario`), held to the design's own `buildScreen`
 * (docs/superpowers/specs/repo-setups-design/repo-data.js): for every scenario × variant × App narrowing × Group by
 * the blocks drawn are the ones the design draws (asserted by the wrappers the frame emits, `data-repo-block` —
 * the blocks themselves are other modules), the header has the App menu only for a monorepo, Group by only when
 * the layout can draw either, a pill per environment; attention reads as the design's sentences; and NOTHING says
 * "not connected" about a thing the repository does not have.
 */
import { describe, it, expect } from "vitest";
import { layoutInputOf, narrowFacts, REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf, type GroupBy } from "@shared/repo-layout-core";
import type { RepoDashboard } from "@shared/repo";
import { repoControls, repoCrumb, repoDropdowns, repoView, type RepoProps } from "../web/src/repo";
import { repoSample, repoScenario } from "../web/src/repo-sample";
import { SCENARIO_KEYS, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample-keys";
import { overviewBlocks, overviewLinks, usageSummary } from "../web/src/repo-overview";
import { attentionLine } from "../web/src/repo-attention";
import { weekTile } from "../web/src/repo-week";
import { connectCopy } from "../web/src/repo-connect";
import { ciLine, envVerdict } from "../web/src/repo-verdict";
import { esc } from "../web/src/ui";
// @ts-expect-error — the design's module is plain JS with no declarations; it is read here as the reference.
import * as design from "../docs/superpowers/specs/repo-setups-design/repo-data.js";

interface DesignScreen {
  s: { apps: { name: string }[] };
  opener: string;
  attention: unknown[]; connect: unknown; envCards: unknown; drift: unknown; table: unknown; production: unknown;
  previews: unknown; notShipped: unknown; release: unknown; found: unknown; unseen: unknown; links: unknown[];
}
const buildScreen = design.buildScreen as (o: Record<string, unknown>) => DesignScreen;

const NOW = Date.parse("2026-10-15T12:00:00Z");
const GROUPS: (GroupBy | undefined)[] = [undefined, "env", "app"];

/** The design has no G `signals` and cannot draw G/after (see test/repo-sample.scenarios.test.ts): both are G's calm
 *  apps and targets, with the hosts reporting — attention (notifier waiting) where the design's after has it, and
 *  the connect card only while Railway is not connected. */
const designOf = (k: ScenarioKey, v: string): [string, string] => (k === "G" && v !== "" ? ["G", ""] : [k, v]);

function props(f: RepoFacts, over: Partial<RepoProps> = {}): RepoProps {
  const data: RepoDashboard = { ...repoSample(NOW), facts: f };
  return {
    tab: "overview", range: "7d", driftOpen: false, repo: { status: "ok", data }, fetchedAt: NOW, sample: true, admin: true,
    poll: null, productEnv: null, now: NOW, scenario: { key: "A", variant: "" }, ...over,
  };
}
/** The blocks drawn, in order (the frame's wrappers). */
const blocksIn = (html: string): string[] => [...html.matchAll(/data-repo-block="([a-zA-Z]+)"/g)].map((m) => m[1]);
/** The Overview panel's markup only (not the header, the banner or the sample switch). */
const panel = (html: string): string => html.slice(html.indexOf('class="repo-panel'));

const cases = SCENARIO_KEYS.flatMap((k) => SCENARIO_VARIANTS[k].flatMap((v) => {
  const [dk, dv] = designOf(k, v);
  const apps = buildScreen({ scenario: dk, variant: dv }).s.apps.map((a) => a.name);
  return [undefined, ...apps].flatMap((app) => GROUPS.map((group) => ({ k, v, app, group, label: `${k}/${v || "calm"} app=${app ?? "all"} group=${group ?? "-"}` })));
}));

describe("the Overview draws the design's blocks for every scenario", () => {
  it.each(cases)("$label", ({ k, v, app, group }) => {
    const [dk, dv] = designOf(k, v);
    const d = buildScreen({ scenario: dk, variant: dv, app, group });
    const full = repoScenario(k, v, { now: NOW });
    const html = repoView(props(full, { app: app ?? null, group: group ?? null }));
    const drawn = blocksIn(html);
    const f = narrowFacts(full, app ?? null);
    const layout = layoutOf(layoutInputOf(f), group);

    // the opener is the layout's, and the frame drew exactly what the composition says, in its order
    expect(layout.opener).toBe(d.opener);
    expect(drawn).toEqual(overviewBlocks(f, { layout }).filter((b) => b !== "state"));
    expect(html).toContain("data-repo-state-slot");

    // …and that is what the design draws
    const want: Record<string, boolean> = {
      envCards: !!d.envCards, drift: !!d.drift, appsTable: !!d.table, production: !!d.production, previews: !!d.previews,
      notShipped: !!d.notShipped, release: !!d.release, found: !!d.found, unseen: !!d.unseen,
      // Narrowed, the design keeps an item whose SENTENCE starts with "<app>:"; Trov keeps an item whose `app` is it
      // (shared/repo-facts-core.ts narrowFacts) — so under the App menu the facts are the reference.
      attention: (k === "G" && v !== "") || app ? f.attention.length > 0 : d.attention.length > 0,
      connect: k === "G" ? v !== "after" : !!d.connect,
      links: d.links.length > 0, week: true,
    };
    for (const [block, on] of Object.entries(want)) expect(drawn.includes(block), `${block}`).toBe(on);
    // the order of the design's RepoScreen: attention, connect, the opener, not shipped, previews, week, links
    const order = ["attention", "connect", "found", "unseen", "release", "production", "envCards", "drift", "appsTable", "notShipped", "previews", "week", "links"];
    expect(drawn).toEqual([...drawn].sort((a, b) => order.indexOf(a) - order.indexOf(b)));

    // the header: the App menu only for a monorepo, Group by only when the layout can draw either, a pill per environment
    const crumb = repoCrumb(props(full, { app: app ?? null, group: group ?? null }));
    expect(crumb.includes("data-app-menu"), "App menu").toBe(full.allApps.length >= 2);
    expect(crumb.includes("data-repo-menu"), "repository menu").toBe(full.repos.length >= 2);
    expect(html.includes("data-repo-groupby"), "Group by").toBe(layout.canGroup);
    const controls = repoControls(props(full, { app: app ?? null, group: group ?? null }));
    const pills = [...controls.matchAll(/data-env-pill="([^"]+)"/g)].map((m) => m[1]);
    expect(pills).toEqual(f.parts.length ? f.envs.map((e) => e.key) : []);
  });
});

describe("Needs attention reads as the design's sentences, from refs alone", () => {
  const lines = (k: ScenarioKey, v = "", app: string | null = null) => {
    const f = repoScenario(k, v, { now: NOW, app });
    return f.attention.map((a) => attentionLine(a, f, NOW));
  };
  const say = (k: ScenarioKey, v = "") => lines(k, v).map((l) => [l.text, l.action.label, l.kind]);

  it("A / out of step and A / trouble", () => {
    expect(say("A", "outOfStep")).toEqual([
      ["Production: api runs 71f0e3a, 3 commits behind web (b4c21de). Railway has not deployed api since the last promotion.", "Open api on Railway", "warn"],
    ]);
    expect(say("A", "trouble")).toEqual([
      ["Production: web is down. tutor.acme.com has not answered its health check for 6 minutes.", "Open tutor.acme.com", "stopped"],
      ["Staging: api’s health reading is 34 minutes old. Railway is building 3e9a1f2.", "Open api on Railway", "waiting"],
    ]);
  });

  it("B / failed and B / trouble — one app, so no app name first", () => {
    expect(say("B", "failed")).toEqual([
      ["Production deploy e07b3a2 failed 12m ago on Cloudflare Workers. c41e7d9 is still serving.", "View build log", "bad"],
    ]);
    expect(say("B", "trouble")).toEqual([
      ["Production was rolled back to c41e7d9 by andres 8m ago. e07b3a2 is no longer live; f19ad20 is building.", "Compare", "warn"],
      ["Preview for #316 has failed for 3 days, on the last 4 builds.", "View build log", "bad"],
    ]);
  });

  it("E and F — many apps, so the app is named first; the host is the part's label", () => {
    expect(say("E")).toEqual([
      ["api: production deploy 7f3a9d0 failed 25m ago on Render. 2b8e6c4 is still serving.", "View build log", "bad"],
      ["web: 4 commits merged 2 days ago are not in production.", "See what is waiting", "warn"],
    ]);
    expect(say("F")).toEqual([
      ["checkout: production deploy 41b7e09 failed 18m ago on Render. c07a1e2 is still serving.", "View build log", "bad"],
      ["search: production deploy d2a6f31 failed 52m ago on Fly.io. 88e4b10 is still serving.", "View build log", "bad"],
    ]);
  });

  it("G / after, and J's failing check", () => {
    expect(say("G", "after")).toEqual([["notifier: Production runs f13c9a7 from 6 days ago; 5 commits are waiting.", "See what is waiting", "warn"]]);
    expect(say("J")).toEqual([["Dev: 1 of 11 checks fails on develop (integration: outbox relay).", "View the run", "warn"]]);
  });

  it("narrowed by the App menu: only that app's items, worded the same", () => {
    expect(lines("E", "", "api").map((l) => l.text)).toEqual(["api: production deploy 7f3a9d0 failed 25m ago on Render. 2b8e6c4 is still serving."]);
    expect(lines("E", "", "docs")).toEqual([]);
    // J's check is the branch's, not an app's: "Repo-wide only" keeps it, an app drops it
    // (narrowed to no app there are no environments in view, so the branch is not named)
    expect(lines("J", "", REPO_WIDE).map((l) => l.text)).toEqual(["Dev: 1 of 11 checks fails on the branch head (integration: outbox relay)."]);
    expect(lines("J", "", "core")).toEqual([]);
  });

  it("is drawn first under the state slot, escaped, with its count; in the sample nothing links out", () => {
    const f = repoScenario("A", "trouble", { now: NOW });
    const html = panel(repoView(props(f)));
    const a = html.indexOf('data-repo-block="attention"');
    expect(a).toBeGreaterThan(html.indexOf("data-repo-state-slot"));
    expect(a).toBeLessThan(html.indexOf('data-repo-block="envCards"'));
    expect(html).toContain(esc("Staging: api’s health reading is 34 minutes old. Railway is building 3e9a1f2."));
    expect(html).toContain(">2</span>");
    expect(html).not.toMatch(/<a [^>]*href="https:\/\/tutor\.acme\.com/);
    // live, an address the facts carry is a link that opens a new tab
    const live = panel(repoView(props(f, { sample: false })));
    expect(live).toMatch(/<a href="https:\/\/tutor\.acme\.com" target="_blank" rel="noopener"[^>]*>Open tutor\.acme\.com <span aria-hidden="true">↗<\/span><\/a>/);
    // none when nothing is wrong
    expect(blocksIn(repoView(props(repoScenario("A", "", { now: NOW }))))).not.toContain("attention");
  });
});

describe("no “not connected” for a thing the repository does not have", () => {
  const variants = SCENARIO_KEYS.flatMap((k) => SCENARIO_VARIANTS[k].flatMap((v) => {
    const full = repoScenario(k, v, { now: NOW });
    return [null, ...full.allApps.map((a) => a.key), REPO_WIDE].map((app) => ({ k, v, app, label: `${k}/${v || "calm"} app=${app ?? "all"}` }));
  }));

  it.each(variants)("$label", ({ k, v, app }) => {
    const full = repoScenario(k, v, { now: NOW });
    const f = narrowFacts(full, app);
    for (const admin of [true, false]) {
      const html = panel(repoView(props(full, { app, admin })));
      // "not connected" only where a part in view really has a host that is not connected
      const hasUnconnected = f.parts.some((p) => p.connection !== "connected") || f.connect !== null;
      if (!hasUnconnected) expect(html, `${k}/${v} admin=${admin}`).not.toMatch(/not connected/i);
    }
  });

  it("C's site is on a host with no usage figures: “not available from Netlify”, never “not connected”", () => {
    const f = repoScenario("C", "", { now: NOW });
    const html = panel(repoView(props(f)));
    expect(html).toContain("not available from Netlify");
    expect(html).not.toMatch(/not connected/i);
    expect(usageSummary(repoScenario("D", "", { now: NOW }).parts)).toBe("not available from Vercel");
  });

  it("B has no Railway, and never mentions it", () => {
    for (const v of SCENARIO_VARIANTS.B) {
      const html = repoView(props(repoScenario("B", v, { now: NOW })));
      // B's sample has a preview for a PR titled "Usage: Railway poller" (the design's data) — a title, not a host.
      expect(html.replace(/Usage: Railway poller/g, "")).not.toContain("Railway");
      expect(panel(html)).not.toMatch(/not connected/i);
    }
  });

  it("the Usage link reads the parts' capability and connection, never a provider id", () => {
    const usage = (k: ScenarioKey, v = "") => overviewLinks(repoScenario(k, v, { now: NOW }), { layout: layoutOf(layoutInputOf(repoScenario(k, v, { now: NOW }))) }).find((l) => l.tab === "usage")?.text;
    expect(usage("A")).toBe("from Cloudflare Workers and Railway");
    expect(usage("B")).toBe("from Cloudflare Workers");
    expect(usage("C")).toBe("not available from Netlify");
    expect(usage("E")).toBe("from Render and Cloudflare Workers"); // Fly.io (jobs) is not connected; Vercel reports none
    expect(usage("F")).toBe("from Render, Fly.io and Cloudflare Workers");
    expect(usage("G")).toBe("not connected"); // Railway is there, and not connected
    expect(usage("G", "after")).toBe("from Railway");
    expect(usage("H")).toBe("not connected"); // collector's Fly.io is not connected
    expect(usage("J")).toBe("from Render");
    expect(usage("I")).toBeUndefined(); // a package has no Usage tab
  });
});

describe("week tiles and the links row: unknown is unknown", () => {
  it("G before Railway: deploy figures are “—”, unknown until Railway is connected — never 0", () => {
    const f = repoScenario("G", "", { now: NOW });
    const tiles = f.week.map((w) => weekTile(w, f));
    expect(tiles.find((t) => t.key === "deploys")).toMatchObject({ value: "—", delta: "", vs: "unknown until Railway is connected" });
    expect(tiles.find((t) => t.key === "failedDeploys")).toMatchObject({ value: "—", vs: "unknown until Railway is connected" });
    const html = panel(repoView(props(f)));
    const deploys = html.slice(html.indexOf('data-week="deploys"'), html.indexOf('data-week="failedDeploys"'));
    expect(deploys).toContain("—");
    expect(deploys).not.toContain("data-count");
    expect(deploys).not.toMatch(/>0</);
    // and the CI link says what it waits on
    expect(overviewLinks(f, { layout: layoutOf(layoutInputOf(f)) }).find((l) => l.tab === "ci")?.text).toBe("CI only until Railway is connected");
  });

  it("▲ / ▼ deltas, failed deploys read the other way, “since connecting” with no week to compare", () => {
    const a = repoScenario("A", "", { now: NOW });
    const tiles = Object.fromEntries(a.week.map((w) => [w.key, weekTile(w, a)]));
    expect(tiles.mergedPrs).toMatchObject({ value: "12", delta: "▲ 3", tone: "var(--green)", vs: "vs last week" });
    expect(tiles.failedDeploys).toMatchObject({ value: "1", delta: "▼ 1", tone: "var(--green)" }); // fewer failures is good
    expect(tiles.openPrs).toMatchObject({ delta: "—", tone: "var(--fg-40)" });
    const e = repoScenario("E", "", { now: NOW });
    expect(weekTile(e.week.find((w) => w.key === "failedDeploys")!, e)).toMatchObject({ delta: "▲ 1", tone: "var(--red)" });
    const l = repoScenario("L", "", { now: NOW });
    expect(weekTile(l.week[0], l)).toMatchObject({ value: "6", delta: "", vs: "since connecting" });
  });

  it("the links row: the layout's tabs with their summaries; none under the found / unseen openers", () => {
    const a = repoScenario("A", "", { now: NOW });
    expect(overviewLinks(a, { layout: layoutOf(layoutInputOf(a)) }).map((l) => [l.label, l.text])).toEqual([
      ["Code", "7 open pull requests"], ["CI & deploys", "18 deploys this week"], ["Usage", "from Cloudflare Workers and Railway"], ["Planning", "Roadmap and issues"],
    ]);
    const i = repoScenario("I", "", { now: NOW });
    expect(overviewLinks(i, { layout: layoutOf(layoutInputOf(i)) }).map((l) => l.label)).toEqual(["Code", "CI", "Planning"]);
    for (const k of ["L", "M"] as const) expect(blocksIn(repoView(props(repoScenario(k, "", { now: NOW }))))).not.toContain("links");
  });
});

describe("the connect card", () => {
  it("G, no signals: the design's card; an admin gets Connect Railway (Org settings › Hosting), a member the note", () => {
    const f = repoScenario("G", "", { now: NOW });
    const c = connectCopy(f);
    expect(c?.title).toBe("Deploys not connected");
    expect(c?.text).toBe("Railway does not report deploys to GitHub, so Trov cannot see what is running in Production or Staging yet. Connect Railway once and every service here fills in, with CPU and memory too.");
    const admin = panel(repoView(props(f)));
    expect(admin).toMatch(/data-act="orgGo" data-arg="hosting"[^>]*>Connect Railway</);
    const member = panel(repoView(props(f, { admin: false })));
    expect(member).not.toContain('data-arg="hosting"');
    expect(member).toContain("data-connect-note");
  });

  it("G with GitHub signals: deploys arrive via GitHub, the card asks for CPU and memory only", () => {
    const f = repoScenario("G", "signals", { now: NOW });
    expect(f.parts.every((p) => p.viaGithub)).toBe(true);
    expect(connectCopy(f)).toMatchObject({
      title: "CPU and memory not connected",
      text: "Deploys for gateway, ledger, notifier and settle arrive via GitHub. Connect Railway for CPU and memory; deploys keep coming from GitHub either way.",
      action: "Connect Railway",
    });
    expect(repoView(props(f))).toContain('data-connect-need="metrics"');
    // the deploy figures are known here
    expect(weekTile(f.week.find((w) => w.key === "deploys")!, f).value).toBe("14");
  });

  it("is gone once Railway is connected, and when the App menu narrows to an app it does not name", () => {
    expect(connectCopy(repoScenario("G", "after", { now: NOW }))).toBeNull();
    expect(blocksIn(repoView(props(repoScenario("E", "", { now: NOW }))))).not.toContain("connect");
  });
});

describe("the environment verdict (shared with the environment cards)", () => {
  const v = (k: ScenarioKey, variant: string, env: string) => envVerdict(repoScenario(k, variant, { now: NOW }), env).key;
  it("follows the design's verdictFor", () => {
    expect(v("A", "", "production")).toBe("healthy");
    expect(v("A", "outOfStep", "production")).toBe("outOfStep");
    expect(v("A", "trouble", "production")).toBe("down");
    expect(v("A", "trouble", "staging")).toBe("healthy"); // a stale reading is neither up nor down; building is not failing
    expect(v("B", "failed", "production")).toBe("failing");
    expect(v("J", "", "dev")).toBe("degraded");
    expect(v("G", "", "production")).toBe("unknown");
    expect(v("G", "signals", "staging")).toBe("live"); // no checks captured: live, never Healthy on unknown checks
    expect(v("B", "trouble", "production")).toBe("live"); // checks still running on the new head
  });
  it("ciLine: one wording for a branch head's checks", () => {
    const ci = (k: ScenarioKey, variant: string, env: string) => ciLine(repoScenario(k, variant, { now: NOW }).ci.find((c) => c.env === env))?.text ?? null;
    expect(ci("A", "", "staging")).toBe("All 14 checks passing on 3e9a1f2");
    expect(ci("B", "failed", "production")).toBe("2 of 9 checks failing on e07b3a2");
    expect(ci("B", "trouble", "production")).toBe("Checks running on f19ad20");
    expect(ci("H", "", "staging")).toBe("deploy-normalizer.yml running on 4e1a9c7");
    expect(ci("G", "", "production")).toBeNull();
  });
  it("the header pills carry it as a tone and a tooltip", () => {
    const html = repoControls(props(repoScenario("A", "trouble", { now: NOW })));
    expect(html).toMatch(/data-env-pill="production" data-verdict="down" data-mtip="Production: Down\. Its health check gets no answer\."/);
    expect(html).toMatch(/data-env-pill="staging" data-verdict="healthy"/);
  });
});

describe("the header and the sample switch", () => {
  it("the App menu lists every app with its folder and open pull requests, All apps and Repo-wide only", () => {
    const f = repoScenario("E", "", { now: NOW });
    const app = repoDropdowns(props(f)).find((d) => d.id === "repo-scope-app");
    expect(app?.options.map((o) => [o.value, o.label, o.hint])).toEqual([
      ["__all", "All apps", "11 open pull requests"],
      ["web", "web", "apps/web · 4 open pull requests"], ["api", "api", "apps/api · 3 open pull requests"],
      ["docs", "docs", "apps/docs · 1 open pull request"], ["jobs", "jobs", "apps/jobs · 1 open pull request"],
      ["ui", "ui", "packages/ui · 2 open pull requests"],
      [REPO_WIDE, "Repo-wide only", "Files outside every app"],
    ]);
    // the picked app is the trigger's text
    expect(repoCrumb(props(f, { app: "api" }))).toMatch(/data-app-menu>[\s\S]*api/);
    // a one-app repository has no App menu
    expect(repoDropdowns(props(repoScenario("B", "", { now: NOW }))).map((d) => d.id)).toEqual(["repo-scope-repo", "repo-sample-scenario", "repo-sample-variant"]);
  });

  it("“Repo-wide only” draws no app rows: its own note, the repository's attention, figures and links", () => {
    const html = repoView(props(repoScenario("J", "", { now: NOW }), { app: REPO_WIDE }));
    expect(blocksIn(html)).toEqual(["attention", "repoWide", "week", "links"]);
    expect(repoControls(props(repoScenario("J", "", { now: NOW }), { app: REPO_WIDE }))).not.toContain("data-env-pill");
  });

  it("Group by: the session's choice over the admin's default; an admin who flipped it is offered to save it (never in the sample)", () => {
    const g = repoScenario("G", "after", { now: NOW });
    const def = { ...g, groupDefault: "env" as const };
    expect(blocksIn(repoView(props(def)))).toContain("envCards");
    expect(blocksIn(repoView(props(def, { group: "app" })))).toContain("appsTable");
    const offer = (o: Partial<RepoProps>) => repoView(props(def, { group: "app", groupFlipped: true, ...o })).includes('data-act="repoGroupDefault"');
    expect(offer({ sample: false, admin: true })).toBe(true);
    expect(offer({ sample: false, admin: false })).toBe(false);
    expect(offer({ sample: true, admin: true })).toBe(false);
    expect(offer({ sample: false, admin: true, group: "env" })).toBe(false); // already the default
    // Group by is a segmented switch, never a hand-rolled one
    expect(repoView(props(def))).toMatch(/data-seg="repo-group"/);
  });

  it("the sample switch: a dropdown per axis, the variant only when the scenario has one", () => {
    const f = repoScenario("A", "trouble", { now: NOW });
    const html = repoView(props(f, { scenario: { key: "A", variant: "trouble" } }));
    expect(html).toContain('data-repo-sample="A/trouble"');
    const dds = repoDropdowns(props(f, { scenario: { key: "A", variant: "trouble" } }));
    expect(dds.find((d) => d.id === "repo-sample-scenario")?.options.map((o) => o.value)).toEqual([...SCENARIO_KEYS]);
    expect(dds.find((d) => d.id === "repo-sample-variant")?.options.map((o) => [o.value, o.label])).toEqual([["", "Calm"], ["outOfStep", "Out of step"], ["trouble", "Trouble"]]);
    expect(repoDropdowns(props(repoScenario("C", "", { now: NOW }), { scenario: { key: "C", variant: "" } })).map((d) => d.id)).not.toContain("repo-sample-variant");
    expect(html).not.toContain("<select");
  });

  it("without facts (the live dashboard today) the Overview and header are today's", () => {
    const p = props(repoScenario("A", "", { now: NOW }));
    const data = { ...p.repo.data! };
    delete data.facts;
    const today = repoView({ ...p, repo: { status: "ok", data } });
    expect(blocksIn(today)).toEqual([]);
    expect(today).not.toContain("data-repo-state-slot");
    expect(repoControls({ ...p, repo: { status: "ok", data } })).not.toContain("data-env-pill");
  });
});
