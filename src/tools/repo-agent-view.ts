// The agent's VIEW of the Repo dashboard (MCP `get_repo_dashboard`) — the PURE half of ./repo-agent.ts: the
// projection in, the view out, shared types only (no database, no worker types), so the SPA-side parity test
// (test/repo-facts.parity.test.ts) can run it beside web/src/repo.ts. ./repo-agent.ts re-exports all of it.
import type { AiRepoState, AiThemeRange, AiThemes } from "@shared/ai-core";
import {
  REPO_TAB_SECTIONS,
  type RepoDashboard, type RepoDrift, type RepoProduct, type RepoRange, type RepoSection, type RepoSectionName, type RepoTab,
} from "@shared/repo";
import type { RepoProviderPart } from "@shared/hosting";
import { layoutInputOf, type FactsCommitGroup, type RepoFacts } from "@shared/repo-facts-core";
import { layoutOf, type RepoLayout } from "@shared/repo-layout-core";
import { extrasForRange } from "./repo-extras";

export const DEFAULT_AGENT_RANGE: RepoRange = "7d";

export interface RepoAgentOptions {
  /** Omitted → every section. */
  tab?: RepoTab;
  /** Omitted → `7d`. */
  range?: RepoRange;
  /** Omitted → false: no `trend` arrays, and drift is cut to `DRIFT_GROUP_LIMIT`
   *  groups, each carrying a count rather than its commits. */
  includeTrends?: boolean;
  /** The App menu's narrowing (an app key, `__repo`); omitted / unknown → every app. */
  app?: string | null;
}

export interface RepoAgentView {
  repo: string;
  generatedAt: string;
  degraded: boolean;
  tab: RepoTab | "all";
  range: RepoRange;
  sections: Partial<Record<RepoSectionName, RepoSection<unknown>>>;
  /** Written by Trov (shared/ai-core.ts): with `tab` overview or none, when the dashboard has it. */
  state?: AiRepoState;
  /** Written by Trov: with `tab` planning or none, when the dashboard has it. */
  themes?: Record<AiThemeRange, AiThemes>;
  /** The Overview's facts (with `tab` overview or none) — shaped by `factsView`. */
  facts?: unknown;
  /** What the facts decide — the screen's own `layoutOf(layoutInputOf(facts), facts.groupDefault)`. */
  layout?: RepoLayout;
}

const ALL_SECTIONS: readonly RepoSectionName[] = Object.values(REPO_TAB_SECTIONS).flat();

/** The sections whose data is `Record<RepoRange, …>` on the wire. */
const RANGED: ReadonlySet<RepoSectionName> = new Set<RepoSectionName>(["usage"]);

/** A product count carries one figure per range; an agent gets the asked one. */
function productForRange(product: RepoProduct, range: RepoRange): unknown {
  return product.map((e) => ({
    ...e,
    groups: e.groups.map((g) => ({
      ...g,
      metrics: g.metrics.map(({ values, raw, ...rest }) => ({ ...rest, value: values[range], raw: raw[range] })),
    })),
  }));
}

/** Without `include_trends`, each provider part lists at most this many deploys (its newest). */
export const PROVIDER_DEPLOY_VIEW_LIMIT = 2;

/** A web part's traffic carries one block per range (a service part's is null); an agent gets the asked
 *  one, as `traffic` itself — `{ requests, errors, error_rate, latency_p95_ms, bandwidth_bytes, trend }`. A
 *  null figure inside it stays null (unknown, never zero), exactly as the screen receives it.
 *  A part's deploys are its dot strip — a SERIES like a sparkline, up to ten rows of ~400 bytes each, and
 *  an org may run a dozen parts — so without `include_trends` only the newest `PROVIDER_DEPLOY_VIEW_LIMIT`
 *  travel, with `deployCount` the full number (the drift rule: the header stays truthful, a reader can see
 *  the list was cut). With `include_trends`: every deploy the screen gets. */
function providersForRange(parts: RepoProviderPart[], range: RepoRange, includeTrends: boolean): unknown {
  return parts.map((p) => ({
    ...p,
    traffic: p.traffic ? p.traffic[range] : null,
    // The extra usage families (Phase G): every per-range record collapsed to the asked range, like `traffic`.
    ...(p.extras ? { extras: extrasForRange(p.extras, range) } : {}),
    deployCount: p.deploys.length,
    deploys: includeTrends ? p.deploys : p.deploys.slice(0, PROVIDER_DEPLOY_VIEW_LIMIT),
  }));
}

/** Without `include_trends`, a drift section lists at most this many groups. */
export const DRIFT_GROUP_LIMIT = 20;

/** Drift is the one section with no small bound, twice over: a compare returns
 *  up to 250 commits a side, and `computeDrift` makes one GROUP per PR among
 *  them — up to 250 groups in a squash-merge repo (~33 KB of headers alone, and
 *  drift is on the OVERVIEW tab). So without `include_trends` both are cut: a
 *  group carries `commitCount` instead of its `commits`, and only the first
 *  `DRIFT_GROUP_LIMIT` groups travel (the snapshot's own order — PRs newest
 *  first, then the PUSH / BEHIND buckets). `groupCount` is always the FULL
 *  number, beside GitHub's own `ahead` / `behind` totals, so the header stays
 *  truthful and a reader can see the list was cut. With `include_trends`: every
 *  group, with its commits. */
function driftView(drift: RepoDrift, includeTrends: boolean): unknown {
  const groups = includeTrends ? drift.groups : drift.groups.slice(0, DRIFT_GROUP_LIMIT);
  return {
    ...drift,
    groupCount: drift.groups.length,
    groups: groups.map(({ commits, ...g }) => ({ ...g, commitCount: commits.length, ...(includeTrends ? { commits } : {}) })),
  };
}

/** A commit-group list as an agent gets it without `include_trends`: the first `DRIFT_GROUP_LIMIT` groups, each
 *  with `commitCount` instead of its commits (the drift rule), `groupCount` the full number beside it. */
function groupsView(groups: FactsCommitGroup[], includeTrends: boolean): { groups: unknown[]; groupCount: number } {
  if (includeTrends) return { groups, groupCount: groups.length };
  return { groups: groups.slice(0, DRIFT_GROUP_LIMIT).map(({ commits, ...g }) => ({ ...g, commitCount: commits.length })), groupCount: groups.length };
}

/** The facts as an agent gets them. With `include_trends`: as the screen gets them. Without: every commit group
 *  list cut as `groupsView` says, and each part's history (≤ 20 deploys, a series like a dot strip) to its newest
 *  `PROVIDER_DEPLOY_VIEW_LIMIT`, with `historyCount` the full number. Apps, environments and parts — all the
 *  layout reads — are never cut, so `layoutOf` over this view equals `layout`. */
export function factsView(facts: RepoFacts, includeTrends: boolean): unknown {
  if (includeTrends) return facts;
  return {
    ...facts,
    parts: facts.parts.map((p) => ({ ...p, historyCount: p.history.length, history: p.history.slice(-PROVIDER_DEPLOY_VIEW_LIMIT) })),
    notShipped: facts.notShipped.map((n) => ({ ...n, ...groupsView(n.groups, false) })),
    drift: facts.drift.map((d) => ({ ...d, ...groupsView(d.groups, false) })),
  };
}

/** A copy — fresh objects and arrays all the way down — without any key named
 *  `trend`: every sparkline series in the DTO is spelled that way (usage
 *  metrics, product counts/totals, CI failures, coverage, bundle, TODOs, a
 *  provider part's traffic and resources), so a new one is stripped without a
 *  change here. */
function withoutTrends(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTrends);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "trend") out[k] = withoutTrends(x);
    return out;
  }
  return v;
}

/** PURE: the projection in, the agent's view out. It never writes into `dash`
 *  — but it is NOT a deep copy: with `includeTrends` (and for any `ok` section
 *  it does not reshape) the view SHARES arrays and objects with `dash`. That is
 *  safe because the projection is built per call and the view is only ever
 *  serialized; a caller that wants to mutate the result must clone it first. */
export function shapeRepoDashboard(dash: RepoDashboard, opts: RepoAgentOptions = {}): RepoAgentView {
  const range = opts.range ?? DEFAULT_AGENT_RANGE;
  const includeTrends = opts.includeTrends ?? false;
  const names = opts.tab ? REPO_TAB_SECTIONS[opts.tab] : ALL_SECTIONS;

  const sections: RepoAgentView["sections"] = {};
  for (const name of names) {
    const section = dash[name] as RepoSection<unknown> | undefined;
    if (!section || section.status !== "ok") {
      // Passed through untouched — and a section this payload lacks is unknown.
      sections[name] = section ? { status: section.status } : { status: "not_connected" };
      continue;
    }
    let data: unknown = section.data;
    if (RANGED.has(name)) data = (data as Record<RepoRange, unknown>)[range];
    else if (name === "product") data = productForRange(data as RepoProduct, range);
    else if (name === "providers") data = providersForRange(data as RepoProviderPart[], range, includeTrends);
    else if (name === "drift") data = driftView(data as RepoDrift, includeTrends);
    sections[name] = { status: "ok", data: includeTrends ? data : withoutTrends(data) };
  }

  const view: RepoAgentView = { repo: dash.repo, generatedAt: dash.generatedAt, degraded: dash.degraded, tab: opts.tab ?? "all", range, sections };
  if (dash.state && (!opts.tab || opts.tab === "overview")) view.state = dash.state;
  if (dash.themes && (!opts.tab || opts.tab === "planning")) view.themes = dash.themes;
  if (dash.facts && (!opts.tab || opts.tab === "overview")) {
    // THE parity rule: the layout is the shared core's, over the facts as the screen receives them — never a
    // second decision here (test/repo-facts.mcp.test.ts holds it to the SPA's for every scenario).
    view.layout = layoutOf(layoutInputOf(dash.facts), dash.facts.groupDefault);
    view.facts = factsView(dash.facts, includeTrends);
  }
  return view;
}
