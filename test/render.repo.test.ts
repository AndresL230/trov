/**
 * The Repo dashboard screens (web/src/repo.ts) — pure render tests.
 *
 * What matters here: each section renders in the state the Worker gave it
 * (`ok` / `empty` / `not_connected`), the whole screen has loading and error
 * forms, nothing captured is trusted as markup, and the sample set is labelled.
 */
import { describe, it, expect } from "vitest";
import { repoView, repoControls, repoCrumb, repoPollFor, repoUpdatedLabel, sparkPoints, ago, errorShare, formatCount, parseCompact, type RepoProps } from "../web/src/repo";
import { repoSample } from "../web/src/repo-sample";
import { productKeyInfo } from "../src/repo/product";
import { render, initialState } from "../web/src/render";
import { REPO_TABS, type RepoDashboard, type RepoPerson, type RepoProductCount, type RepoProductEnv, type RepoRefreshResult } from "@shared/repo";

const NC = { status: "not_connected" } as const;
const EMPTY = { status: "empty" } as const;

/** What the Worker returns today for an empty store. */
function live(over: Partial<RepoDashboard> = {}): RepoDashboard {
  return {
    repo: "SaplingLearn/sapling", generatedAt: new Date().toISOString(), degraded: false,
    environments: NC, drift: NC, health: NC, branches: NC, deploys: NC, ciFailures: NC, coverage: NC, bundle: NC,
    usage: NC, cloudflare: NC, hosting: NC, product: NC, todos: NC,
    stats: EMPTY, codeStats: EMPTY, bars: EMPTY, prs: EMPTY, activity: EMPTY, sprint: EMPTY, contributors: EMPTY, labels: EMPTY,
    ...over,
  };
}

function props(over: Partial<RepoProps> = {}): RepoProps {
  return { tab: "overview", range: "7d", driftOpen: false, repo: { status: "ok", data: live() }, fetchedAt: Date.now(), sample: false, admin: false, poll: null, productEnv: null, ...over };
}

describe("repoView — section states", () => {
  it("renders every tab from the sample set without a stray undefined/NaN", () => {
    const data = repoSample();
    for (const [tab] of REPO_TABS) {
      const html = repoView(props({ tab, repo: { status: "ok", data }, sample: true }));
      expect(html, tab).not.toMatch(/undefined|NaN|\[object/);
      expect(html, tab).toContain("sample data");
    }
  });

  // P5-12: the banner says EVERY section shows placeholder values — so none may
  // sit unconnected (telling a previewer to set a secret), and two numbers the
  // real projection derives from one sum may not disagree.
  it("the sample set has no unconnected section, and its Cloudflare panel agrees with its Requests metric", () => {
    const data = repoSample();
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "status" in value) expect((value as { status: string }).status, key).toBe("ok");
    }
    const okOf = <T>(s: { status: string; data?: T }) => (s as { data: T }).data;
    expect(okOf(data.hosting).map((h) => h.env)).toEqual(["staging", "production"]);
    for (const range of ["24h", "7d", "30d"] as const) {
      for (const e of okOf(data.usage)[range]) {
        const row = okOf(data.cloudflare)[range].find((r) => r.env === e.name && r.label === "Workers requests");
        expect(row?.value, `${range} ${e.name}`).toBe(e.requests?.value);
      }
    }
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data }, sample: true }));
    expect(html).not.toContain("Source not connected");
    expect(html).not.toContain("RAILWAY_TOKEN");
  });

  it("shows 'Source not connected' for a section nothing has been captured for, with no dead button", () => {
    const html = repoView(props({ tab: "usage" }));
    expect((html.match(/Source not connected/g) ?? []).length).toBe(4); // usage, Cloudflare, hosting, product
    expect(html).not.toContain("Connect Cloudflare");
    expect(html).toContain('data-act="repoSampleOn"');
  });

  // Every section has a capture path now, so an unconnected one names what that
  // path is still WAITING on (a setting/secret by name, a webhook event, the
  // repo's CI, Sync GitHub) — never that no path exists, never a connect flow.
  it("a not-connected section says what its capture is waiting on, in the owner's terms", () => {
    const tab = (t: RepoProps["tab"]) => repoView(props({ tab: t }));
    const overview = tab("overview"), code = tab("code"), ci = tab("ci"), usage = tab("usage"), planning = tab("planning");
    expect(overview).toContain("Cards appear once REPO_ENVIRONMENTS lists an environment");
    expect(overview).toContain("The repo cron pings each environment in REPO_ENVIRONMENTS every 10 minutes");
    expect(code).toContain("No branch snapshot yet. One is taken when an admin runs Sync GitHub and by the 6-hourly GitHub reconcile — both need GITHUB_SERVICE_TOKEN.");
    expect(ci).toContain("Deploys arrive when the GitHub webhook delivers deployment_status and check_run events, or when an admin runs Sync GitHub");
    expect(ci).toContain("Runs arrive when the GitHub webhook delivers workflow_run events, or when an admin runs Sync GitHub.");
    // P5-8: no branch NAME — the screen does not know which branch the first environment deploys from.
    expect(ci).toContain("posts a canopy/coverage commit status on a push to the default environment branch; it is read from a status webhook event, the 6-hourly GitHub reconcile, or Poll now.");
    expect(ci).toContain("posts a canopy/bundle-kb commit status on a push to the default environment branch; it is read from a status webhook event, the 6-hourly GitHub reconcile, or Poll now.");
    expect(usage).toContain("hourly Cloudflare analytics poll (CF_ANALYTICS_TOKEN and CF_ANALYTICS_ACCOUNT_ID)");
    expect(usage).toContain("metrics endpoint (SAPLING_METRICS_TOKEN)");
    expect(usage).toContain("RAILWAY_TOKEN_&lt;ENVIRONMENT&gt; secret is set and REPO_ENVIRONMENTS carries its railwayEnvironmentId and railwayServiceId.");
    expect(planning).toContain("posts a canopy/todo commit status on a push to the default environment branch; it is read from a status webhook event, the 6-hourly GitHub reconcile, or Poll now.");
    expect([ci, planning].join("\n")).not.toContain("push to main");

    const all = [overview, code, ci, usage, planning].join("\n");
    for (const stale of ["no capture path", "aren&#39;t captured", "nothing pings", "nothing scans", "not refs", "is ingested yet", "for this repo yet"]) {
      expect(all, stale).not.toContain(stale);
    }
    // The page-level legend says the same thing: nothing captured YET, not "no path".
    expect(overview).toContain("have had nothing captured yet — each says what it is waiting on.");
  });

  // P5-9: the Worker emits `bars` as ok / empty only, so it carries no
  // not-connected copy of its own. The type still allows the state; if it ever
  // arrived it gets the generic line, never a sentence about a missing source.
  it("bars has no bespoke not-connected copy — the generic line covers a state the Worker never sends", () => {
    const html = repoView(props({ tab: "code", repo: { status: "ok", data: live({ bars: NC }) } }));
    expect(html).not.toContain("Commit activity isn&#39;t connected.");
    expect(html).not.toContain("Commit activity isn't connected.");
    expect(html).toContain("Nothing has been captured for this section yet.");
    expect(html).not.toMatch(/undefined/);
  });

  it("an empty activity chart claims neither commits nor merges", () => {
    expect(repoView(props({ tab: "code" }))).toContain("No commits or merges in the last 14 days.");
  });

  it("shows 'Nothing here yet' for a connected section with no rows", () => {
    const html = repoView(props({ tab: "planning" }));
    expect(html).toContain("No sprint is active");
    expect(html).toContain("No pushes, merges or reviews this week.");
  });

  it("first load is skeletons; a failed first load is an error with Retry", () => {
    const loading = repoView(props({ repo: { status: "loading", data: null } }));
    expect(loading).toContain("repo-shimmer");
    expect(loading).not.toContain("Source not connected");

    const failed = repoView(props({ repo: { status: "error", data: null } }));
    expect(failed).toContain("Couldn't load this section");
    expect(failed).toContain('data-act="repoRefresh"');
  });

  it("a refresh keeps the last payload on screen", () => {
    const html = repoView(props({ tab: "code", repo: { status: "loading", data: repoSample() }, sample: true }));
    expect(html).not.toContain("repo-shimmer");
    expect(html).toContain("Batch D1 reads in usage rollup");
  });

  it("offers the sample preview only while something on the tab is unconnected", () => {
    const allLive = { ...repoSample(), sample: undefined, hosting: { status: "ok", data: [] } } as RepoDashboard;
    expect(repoView(props({ tab: "usage", repo: { status: "ok", data: allLive } }))).not.toContain("repoSampleOn");
    expect(repoView(props({ tab: "usage", sample: true, repo: { status: "ok", data: repoSample() } }))).toContain('data-act="repoSampleOff"');
  });
});

describe("repoView — live content", () => {
  it("escapes captured titles and refuses a non-http URL", () => {
    const data = live({
      prs: { status: "ok", data: [{ number: 7, title: `<img src=x onerror=1>`, url: "javascript:alert(1)", author: { login: "x", handle: null, name: null, color: null }, branch: "→ main", state: "merged", checks: null, at: new Date().toISOString() }] },
    });
    const html = repoView(props({ tab: "code", repo: { status: "ok", data } }));
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("MERGED");
  });

  // Task 12: the Branches block was built ahead of the capture landing — this
  // pins that it renders the snapshot's row shape (name/at/ahead/behind/stale)
  // and escapes a captured branch name the same way the PR list does.
  it("renders the branches snapshot, escaping a captured name and flagging STALE", () => {
    const data = live({
      branches: {
        status: "ok",
        data: {
          active: 1, stale: 1, head: "develop",
          rows: [
            { name: `feature/<script>alert(1)</script>`, at: new Date().toISOString(), ahead: 4, behind: 0, stale: false },
            { name: "spike/edge-cache", at: "2026-09-04T00:00:00Z", ahead: 7, behind: 31, stale: true },
          ],
        },
      },
    });
    const html = repoView(props({ tab: "code", repo: { status: "ok", data } }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    // P5-8: the comparison branch is the snapshot's own `head`, never an assumed `main`.
    expect(html).toContain("+4 / −0 vs develop");
    expect(html).toContain("+7 / −31 vs develop");
    expect(html).not.toContain("vs main");
    expect(html).toContain("STALE");
    expect(html).toContain("1 active · 1 stale");
  });

  it("a branches snapshot written before `head` was recorded shows the counts with NO 'vs …' — never a guessed branch; a captured head is escaped", () => {
    const row = { name: "feature/x", at: new Date().toISOString(), ahead: 4, behind: 2, stale: false };
    const old = repoView(props({ tab: "code", repo: { status: "ok", data: live({ branches: { status: "ok", data: { active: 1, stale: 0, rows: [row] } } }) } }));
    expect(old).toContain("+4 / −2<");
    expect(old).not.toMatch(/vs (main|undefined)/);
    const odd = repoView(props({ tab: "code", repo: { status: "ok", data: live({ branches: { status: "ok", data: { active: 1, stale: 0, head: "<b>x</b>", rows: [row] } } }) } }));
    expect(odd).toContain("vs &lt;b&gt;x&lt;/b&gt;");
  });

  it("names the PR-list header from what's actually shown, not the sample flag", () => {
    const prRow = (state: "review" | "merged") => ({
      number: 1, title: "PR", url: "https://github.com/o/r/pull/1",
      author: { login: "x", handle: null, name: null, color: null }, branch: "feat/x", state, checks: null, at: new Date().toISOString(),
    });
    const open = live({ prs: { status: "ok", data: [prRow("review")] } });
    expect(repoView(props({ tab: "code", repo: { status: "ok", data: open } }))).toContain("Pull requests — open &amp; recent");

    const closed = live({ prs: { status: "ok", data: [prRow("merged")] } });
    expect(repoView(props({ tab: "code", repo: { status: "ok", data: closed } }))).toContain("Pull requests — recently closed");
  });

  it("draws one bar per day and scales them to the busiest", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(7 + i).padStart(2, "0")}`, count: i === 13 ? 4 : i === 0 ? 2 : 0 }));
    const data = live({ bars: { status: "ok", data: { title: "Merge activity — last 14 days", note: "6 merged PRs · all branches", days } } });
    const html = repoView(props({ tab: "code", repo: { status: "ok", data } }));
    expect((html.match(/class="repo-bar"/g) ?? []).length).toBe(14);
    expect(html).toContain('height="25.00"');   // the max
    expect(html).toContain('height="12.50"');   // half of it
    expect(html).toContain("Merge activity — last 14 days");
  });

  it("the drift strip is an attribute-driven disclosure", () => {
    const data = repoSample();
    expect(repoView(props({ repo: { status: "ok", data } }))).toContain('class="repo-drift" data-open="0"');
    const open = repoView(props({ repo: { status: "ok", data }, driftOpen: true }));
    expect(open).toContain('class="repo-drift" data-open="1"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("12</span> commits ahead");
  });

  it("the usage range picks its own series", () => {
    const data = repoSample();
    expect(repoView(props({ tab: "usage", range: "24h", repo: { status: "ok", data } }))).toContain("12.4K");
    expect(repoView(props({ tab: "usage", range: "30d", repo: { status: "ok", data } }))).toContain("5.1M");
  });

  it("a usage metric with no source says so in place, without blanking its neighbours", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: { value: "12.4K", trend: [1, 2, 3], tone: "neutral" as const }, errorRate: { value: "2.41%", trend: [1, 2], tone: "warn" as const }, users: null, seen: { requests: true, users: false } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } } });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect(html).toContain("12.4K");
    expect(html).toContain("Active users");
    expect(html).toContain("not connected");
  });

  it("a usage env with every metric unconnected still renders its name, host, and three not-connected rows", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null, seen: { requests: false, users: false } };
    const data = live({
      usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } },
      cloudflare: EMPTY, hosting: EMPTY, product: EMPTY,
    });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect(html).toContain("staging");
    expect(html).toContain("staging.saplinglearn.com");
    expect((html.match(/not connected/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/undefined|NaN/);
  });

  // Task 16b: `errorRate: null` beside LIVE requests is not "not connected" —
  // the source is connected, there were simply no requests to take a rate of.
  it("an error rate with nothing to take a rate of reads a quiet dash, not 'not connected'", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: { value: "0", trend: [0, 0, 0], tone: "neutral" as const }, errorRate: null, users: { value: "4", trend: [3, 4], tone: "neutral" as const }, seen: { requests: true, users: true } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    const errRow = html.slice(html.indexOf("Error rate"), html.indexOf("Active users"));
    expect(errRow).toContain(">—<");
    expect(errRow).not.toContain("not connected");
    expect(errRow).not.toContain("<svg"); // no sparkline for a rate that does not exist
    expect(html).not.toContain("not connected"); // nothing on this card is unconnected
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("an error rate whose requests are ALSO unconnected still says 'not connected'", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: { value: "4", trend: [3, 4], tone: "neutral" as const }, seen: { requests: false, users: true } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    const errRow = html.slice(html.indexOf("Error rate"), html.indexOf("Active users"));
    expect(errRow).toContain("not connected");
    expect(errRow).not.toContain(">—<");
    expect((html.match(/not connected/g) ?? []).length).toBe(2);
  });

  // P5-2: a null metric whose source HAS reported (inside the 30-day read) is
  // connected and quiet — saying "not connected" there was false.
  it("a null metric whose source has been seen reads 'no recent reading', never 'not connected'", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null, seen: { requests: true, users: true } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    expect((html.match(/no recent reading/g) ?? []).length).toBe(3); // requests, error rate (follows requests), users
    expect(html).not.toContain("not connected");
    expect(html).not.toMatch(/undefined|NaN|<svg viewBox="0 0 100 26"/);
  });

  it("the two labels sit side by side: requests seen and quiet, users never connected", () => {
    const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: null, errorRate: null, users: null, seen: { requests: true, users: false } };
    const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } }, cloudflare: EMPTY, hosting: EMPTY, product: EMPTY });
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
    const row = (from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));
    expect(row("Requests", "Error rate")).toContain("no recent reading");
    expect(row("Error rate", "Active users")).toContain("no recent reading");
    const usersRow = html.slice(html.indexOf("Active users"));
    expect(usersRow).toContain("not connected");
    expect(usersRow).not.toContain("no recent reading");
  });

  it("usage empty says the polls have gone quiet — never that nothing was recorded in 30 days", () => {
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ usage: EMPTY }) } }));
    expect(html).toContain("No current usage reading — the hourly polls have gone quiet.");
    expect(html).not.toContain("No usage recorded in the last 30 days.");
  });

  // Task 17: the hosting block's three states.
  it("hosting renders its rows when live, and says the reading is stale — not absent — when empty", () => {
    const rows = [{ env: "staging", cpu: "0.12 vCPU", memory: "410 MB" }, { env: "production", cpu: "—", memory: "2048 MB" }];
    const okHtml = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ hosting: { status: "ok", data: rows } }) } }));
    expect(okHtml).toContain("Hosting — Railway backend");
    // Figure over label per environment; the unit is the same string, split at the space.
    const prod = okHtml.slice(okHtml.indexOf('data-hostenv="production"'));
    expect(okHtml.slice(okHtml.indexOf('data-hostenv="staging"'), okHtml.indexOf('data-hostenv="production"'))).toMatch(/>0\.12<span[^>]*>vCPU<\/span>[\s\S]*>CPU<[\s\S]*>410<span[^>]*>MB<\/span>[\s\S]*>Memory</);
    expect(prod).toMatch(/>2048<span[^>]*>MB<\/span>/);
    // A stale cell stays an em dash — muted, never a guessed figure.
    expect(prod).toMatch(/color:var\(--fg-40\)">—</);
    expect(okHtml).not.toContain("<table");
    const stale = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ hosting: EMPTY }) } }));
    expect(stale).toContain("No fresh hosting reading — the last Railway sample is over 3 hours old.");
    const never = repoView(props({ tab: "usage", repo: { status: "ok", data: live() } }));
    expect(never).not.toContain("No fresh hosting reading");
  });

  // Task 16: the Cloudflare panel is `ok` once the WIDEST range has rows, so a
  // narrower range can legitimately be empty — say so, never a blank panel.
  it("a Cloudflare range with no rows says so instead of rendering a blank panel", () => {
    const rows = [{ env: "staging", label: "Workers requests", value: "2.50M" }];
    const data = live({ cloudflare: { status: "ok", data: { "24h": [], "7d": rows, "30d": rows } } });
    const quiet = repoView(props({ tab: "usage", range: "24h", repo: { status: "ok", data } }));
    // Not "No requests": that claims zero traffic for a range a poll may never have covered.
    expect(quiet).toContain("Nothing recorded in this range.");
    expect(quiet).not.toContain("No requests in this range.");
    const week = repoView(props({ tab: "usage", range: "7d", repo: { status: "ok", data } }));
    expect(week).toContain("2.50M");
    expect(week).not.toContain("Nothing recorded in this range.");
  });

  it("M11: renders a null reviews count as an em dash, excluded from the bar width", () => {
    const person = (login: string): RepoPerson => ({ login, handle: login, name: null, color: null });
    const data = live({
      contributors: {
        status: "ok",
        data: [
          { person: person("a"), pushes: 4, merged: 2, reviews: null },
          { person: person("b"), pushes: 1, merged: 0, reviews: null },
        ],
      },
    });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain("4 · 2 · —");
    expect(html).toContain("1 · 0 · —");
    // max = 4 + 2 + 0 (reviews excluded, not counted as 0-contribution-but-present) → row "a" fills 100%.
    expect(html).toContain("width:100%");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("an environment card shows a line per deployable and says when one has no capture", () => {
    const data = live({ environments: { status: "ok", data: [{ key: "staging", name: "staging", note: "main", tone: "good", pill: "HEALTHY", ci: "All 8 checks passing", ciTone: "good", url: "https://staging.saplinglearn.com",
      parts: [{ part: "backend", host: "Railway", sha: "abc1234", deployedAt: new Date().toISOString(), deployedBy: "AndresL230", result: "ok" }, { part: "frontend", host: "Cloudflare", sha: null, deployedAt: null, deployedBy: null, result: null }] }] } });
    const html = repoView(props({ repo: { status: "ok", data } }));
    expect(html).toContain("Backend");
    expect(html).toContain("by AndresL230 · Railway");
    expect(html).toContain("No Cloudflare deploy captured yet");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  // F3: `rate: null` = run capture has not covered a whole week yet. The header
  // percentage and the sparkline both describe seven days, so neither may be
  // drawn — but the failures themselves are facts and stay listed.
  it("a CI block with no 7-day rate yet shows no percentage, no sparkline, and says why", () => {
    const data = live({ ciFailures: { status: "ok", data: { rate: null, trend: [], rows: [
      { workflow: "e2e (browser lane)", branch: "main", job: "e2e · run suite", at: new Date().toISOString(), url: "https://github.com/o/r/actions/runs/3" },
    ] } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain("A 7-day rate appears after a week of captured runs.");
    expect(html).not.toMatch(/>\d+\.\d%</); // no headline percentage rendered as text
    expect(html).not.toContain("repo-spark");
    expect(html).toContain("e2e · run suite");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("shows the rate and the sparkline once a week of runs is captured", () => {
    const data = live({ ciFailures: { status: "ok", data: { rate: 6.7, trend: [4, 9, 6, 3, 11, 8, 5], rows: [] } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain("6.7%");
    expect(html).toContain("repo-spark");
    expect(html).not.toContain("A 7-day rate appears");
  });

  it("labels each deploy strip with its environment AND its half", () => {
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data: repoSample() }, sample: true }));
    for (const label of ["staging · api", "staging · web", "production · api", "production · web"]) expect(html).toContain(label);
  });

  // Task 14, controller ruling M2: a delta ("" for RepoTrend, null for
  // RepoTodos) means the window can't support a trend claim — the screen
  // shows the value/count and sparkline but renders no delta text and, for
  // TODOs, no "since" text either. No stray leading space where the delta
  // used to sit.
  it("a coverage trend with no delta claim (delta: \"\") shows the value and note with no delta text or stray space", () => {
    const data = live({ coverage: { status: "ok", data: { value: "80.1%", trend: [80.1], delta: "", tone: "neutral", note: "over 30 days" } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain("80.1%");
    expect(html).toContain("over 30 days");
    expect(html).not.toContain("</span> over 30 days"); // no empty delta span left behind
    expect(html).not.toMatch(/>\s+over 30 days/); // no leading space where the delta span used to sit
    // M11: a single-point trend can't draw a line — no sparkline element at all.
    expect(html).not.toContain("repo-spark");
  });

  it("still shows the delta text once the window supports a claim", () => {
    const data = live({ coverage: { status: "ok", data: { value: "78.4%", trend: [77.2, 78.4], delta: "+1.2", tone: "good", note: "over 30 days" } } });
    const html = repoView(props({ tab: "ci", repo: { status: "ok", data } }));
    expect(html).toContain('color:var(--green)">+1.2</span> over 30 days');
    // Two points DO draw a line.
    expect(html).toContain("repo-spark");
  });

  it("a TODO count with no delta claim (delta: null) shows the count with no delta and no since text", () => {
    const data = live({ todos: { status: "ok", data: { count: 50, delta: null, since: "", trend: [50] } } });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain("50");
    expect(html).not.toContain("since");
    expect(html).not.toMatch(/undefined|NaN/);
    // M11: a single-point trend can't draw a line — no sparkline element at all.
    expect(html).not.toContain("repo-spark");
  });

  it("still shows delta and since text once the window supports a claim", () => {
    const data = live({ todos: { status: "ok", data: { count: 43, delta: -18, since: "Aug 1", trend: [61, 43] } } });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain("−18");
    expect(html).toContain("since Aug 1");
    expect(html).toContain("repo-spark");
    // P5-8: the footnote names no branch either.
    expect(html).toContain("counted by CI on each push to the default environment branch");
    expect(html).not.toContain("push to main");
  });

  it("links the current sprint to its screen", () => {
    const data = live({ sprint: { status: "ok", data: { id: 3, label: "Notifications GA", due: "2026-10-02", closed: 21, total: 34, pct: 62 } } });
    const html = repoView(props({ tab: "planning", repo: { status: "ok", data } }));
    expect(html).toContain('data-act="openSprint" data-arg="3"');
    expect(html).toContain("DUE OCT 2");
    expect(html).toContain("21 closed · 13 open");
    expect(html).toContain("width:62%");
  });
});

describe("repo header chrome", () => {
  it("names the tab and the repo in the breadcrumb", () => {
    const html = repoCrumb(props({ tab: "ci" }));
    expect(html).toContain("CI &amp; Deploys");
    expect(html).toContain("SaplingLearn/sapling");
  });

  it("shows environment pills only when environments are connected", () => {
    expect(repoControls(props())).not.toContain("staging");
    const withEnvs = repoControls(props({ repo: { status: "ok", data: repoSample() } }));
    expect(withEnvs).toContain("staging — degraded");
    expect(withEnvs).toContain("production — healthy");
  });

  it("labels freshness, and says so while a request is out", () => {
    const now = Date.now();
    expect(repoUpdatedLabel({ repo: { status: "ok", data: live() }, fetchedAt: now }, now)).toBe("updated just now");
    expect(repoUpdatedLabel({ repo: { status: "ok", data: live() }, fetchedAt: now - 4 * 60_000 }, now)).toBe("updated 4m ago");
    expect(repoUpdatedLabel({ repo: { status: "loading", data: live() }, fetchedAt: now }, now)).toBe("refreshing…");
    expect(repoUpdatedLabel({ repo: { status: "loading", data: null }, fetchedAt: null }, now)).toBe("loading…");
  });

  it("render() puts the Repo screen in the shell with its title and active nav row", () => {
    const s = { ...initialState(), view: "app" as const, screen: "repo" as const, repoTab: "code" as const, repo: { status: "ok" as const, data: live() } };
    const html = render(s);
    expect(html).toContain(">Repo</h1>");
    expect(html).toContain('class="cnpy-navrow n-repo is-active"');
    expect(html).toContain('data-screen-label="Code"');
  });
});

// ── "Poll now" (admin-only, Usage tab) ───────────────────────────────────────
// ── product metrics (Sapling contract v2) ────────────────────────────────────
describe("repoView — product metrics", () => {
  const all3 = <T>(v: T) => ({ "24h": v, "7d": v, "30d": v });
  /** A count reading the same in every range (`null` = no recent reading). */
  const count = (key: string, label: string, n: number | null, over: Partial<RepoProductCount> = {}): RepoProductCount =>
    ({ key, label, values: all3(n === null ? null : String(n)), raw: all3(n), trend: [], ...over });
  const staging: RepoProductEnv = {
    name: "staging",
    groups: [
      { id: "growth", title: "Growth", metrics: [
        { key: "signups", label: "Signups", values: { "24h": "3", "7d": "21", "30d": "96" }, raw: { "24h": 3, "7d": 21, "30d": 96 }, trend: [2, 4, 3, 5] },
        count("approvals", "Approvals", null, { trend: [1, 2, 3] }),
      ] },
      { id: "ai", title: "AI spend", metrics: [
        { key: "llm_tokens", label: "LLM tokens", values: { "24h": "41.0K", "7d": "1.23M", "30d": "4.80M" }, raw: { "24h": 41_000, "7d": 1_234_567, "30d": 4_800_000 }, trend: [1, 2, 3] },
        { key: "llm_cost_cents", label: "LLM cost", values: { "24h": "$4.12", "7d": "$29.61", "30d": "$118.30" }, raw: { "24h": 412, "7d": 2961, "30d": 11830 }, trend: [300, 412], note: "lower bound — unpriced models are not counted" },
      ] },
    ],
    totals: [
      { key: "users", label: "Users", value: "1.2K", raw: 1204, trend: [1190, 1198, 1204] },
      { key: "rooms", label: "Rooms", value: null, raw: null, trend: [5, 5, 6] },
    ],
  };
  const production: RepoProductEnv = { name: "production", groups: [], totals: [] };
  const view = (over: Partial<RepoProps> = {}, data: RepoProductEnv[] = [staging, production]) =>
    repoView(props({ tab: "usage", repo: { status: "ok", data: live({ product: { status: "ok", data } }) }, ...over }));
  const one = (groups: RepoProductEnv["groups"], totals: RepoProductEnv["totals"] = [], over: Partial<RepoProps> = {}) =>
    view(over, [{ name: "staging", groups, totals }]);
  /** From a marker attribute to the next marker of any of the given kinds (or the end). */
  const cut = (html: string, marker: string, stops: string[]): string => {
    const i = html.indexOf(marker);
    expect(i, marker).toBeGreaterThan(-1);
    const ends = stops.map((s) => html.indexOf(s, i + marker.length)).filter((n) => n > -1);
    return html.slice(i, ends.length ? Math.min(...ends) : undefined);
  };
  const blockOf = (html: string, id: string) => cut(html, `data-pblock="${id}"`, ['data-pblock="', 'data-pkpi="', "Cloudflare — frontend"]);
  const rowOf = (html: string, key: string, block?: string) =>
    cut(block ? blockOf(html, block) : html.slice(html.indexOf("repo-pgrid")), `data-prow="${key}"`, ['data-prow="', 'data-pblock="', "data-pzero", "data-pstale", "repo-pnotes", 'class="cnpy-rise']);
  const tileOf = (html: string, key: string) => cut(html, `data-pkpi="${key}"`, ['data-pkpi="', "repo-pgrid"]);
  const tileKeys = (html: string) => [...html.matchAll(/data-pkpi="([^"]*)"/g)].map((m) => m[1]);

  // ── one section, an environment switch ─────────────────────────────────────
  it("is ONE Product section: it shows one environment, and a segmented control names them all", () => {
    const html = view();
    expect(html.split(">Product<").length - 1).toBe(1);
    expect(html).not.toContain("Product — ");
    expect((html.match(/data-penv="/g) ?? []).length).toBe(1);
    // Default: the LAST configured environment that has reported anything — production reported nothing.
    expect(html).toContain('data-penv="staging"');
    // The shared segmented switch; the one showing takes no action (no data-act, no data-arg).
    expect(html).toContain('data-seg="repo-product-env"');
    expect(html).toMatch(/<button type="button" class="cnpy-seg-btn is-on" aria-pressed="true">staging<\/button>/);
    expect(html).toContain('<button type="button" class="cnpy-seg-btn" data-act="repoProductEnv" data-arg="production" aria-pressed="false">production</button>');
    expect(html).toContain("reported by the app · counts over 7d");
    for (const title of ["Growth", "AI spend", "Right now"]) expect(html).toContain(`>${title}<`);
    // Groups the environment did not report are not drawn as empty boxes.
    expect(html).not.toContain(">Community<");
    expect(html).not.toMatch(/undefined|NaN|\[object/);
    expect(html.slice(html.indexOf(">Product<"))).not.toContain("<table");
  });

  it("the picked environment is the only one rendered; a name nobody configured falls back to the default", () => {
    const prod = view({ productEnv: "production" });
    expect(prod).toContain('data-penv="production"');
    expect(prod).toContain("This environment has reported no product metrics.");
    expect(prod).not.toContain(">Signups<");
    expect(prod).not.toContain("data-pblock=");
    expect(view()).not.toContain("has reported no product metrics");
    expect(view({ productEnv: "nope" })).toContain('data-penv="staging"');
    // Both have data → the last configured one is the default.
    expect(view({}, [staging, { ...staging, name: "production" }])).toContain('data-penv="production"');
    // Nothing anywhere → the first.
    expect(view({}, [production, { ...production, name: "later" }])).toContain('data-penv="production"');
  });

  it("a single environment gets its name, not a one-button switch", () => {
    const html = one(staging.groups);
    expect(html).not.toContain("repoProductEnv");
    expect(html).toMatch(/>staging<\/span>/);
  });

  // ── never-guess rules ──────────────────────────────────────────────────────
  it("the range selector drives counts — and never totals", () => {
    const at = (range: "24h" | "7d" | "30d") => view({ range });
    expect(rowOf(at("24h"), "signups")).toContain(">3<");
    expect(rowOf(at("7d"), "signups")).toContain(">21<");
    expect(rowOf(at("30d"), "signups")).toContain(">96<");
    expect(rowOf(at("30d"), "llm_cost_cents")).toContain("$118.30");
    expect(tileOf(at("24h"), "signups")).toContain("last 24h");
    expect(tileOf(at("30d"), "llm_cost_cents")).toContain(">$118.30<");
    for (const range of ["24h", "7d", "30d"] as const) expect(blockOf(at(range), "now")).toMatch(/>1\.2K<\/span><span[^>]*>Users</);
  });

  it("the exact integer behind a compacted figure is its title — never behind a dollar amount", () => {
    expect(rowOf(view({ range: "7d" }), "llm_tokens")).toContain('title="1,234,567"');
    expect(blockOf(view(), "now")).toContain('title="1,204"');
    expect(rowOf(view(), "llm_cost_cents")).not.toContain("title=");
  });

  it("a null figure reads a quiet 'no recent reading' in place — its neighbours stay, and no stale trend is drawn", () => {
    const html = view();
    expect(rowOf(html, "approvals")).toContain("no recent reading");
    expect(rowOf(html, "signups")).not.toContain("no recent reading");
    const now = blockOf(html, "now");
    expect(now).toMatch(/>Rooms<\/span><span[^>]*>no recent reading</);
    expect(now).toContain(">1.2K<");
    // An absent key is absent — nothing is zero-filled.
    expect(html).not.toContain(">Logins<");
    expect(html).not.toContain(">0<");
  });

  // ── level 1: the stat strip and the headline tiles ─────────────────────────
  it("'Right now' is an inline stat strip — figures and labels, no sparklines, no rows", () => {
    const now = blockOf(view(), "now");
    expect(now).toContain(">Right now<");
    expect(now).toContain("flex-wrap:wrap");
    expect(now).not.toContain("<polyline");
    expect(now.indexOf(">1.2K<")).toBeLessThan(now.indexOf(">Users<")); // the figure leads, its label follows
    // …and with no totals there is no strip at all.
    expect(one(staging.groups)).not.toContain(">Right now<");
  });

  it("a total's note is a footnote under the strip", () => {
    const html = one([], [{ key: "users", label: "Users", value: "5", raw: 5, trend: [], note: "excludes test accounts" }]);
    expect(blockOf(html, "now")).toContain("Users: excludes test accounts");
  });

  it("headline tiles: signups, tutor sessions, LLM cost, 5xx — in that order, whatever the group order", () => {
    const html = one([
      { id: "reliability", title: "Reliability", metrics: [count("errors_5xx", "5xx errors", 0)] },
      { id: "ai", title: "AI spend", metrics: [count("llm_cost_cents", "LLM cost", 412, { values: all3("$4.12") })] },
      { id: "learning", title: "Learning activity", metrics: [count("chat_messages", "Chat messages", 9), count("tutor_sessions", "Tutor sessions", 4)] },
      { id: "growth", title: "Growth", metrics: [count("logins", "Logins", 7), count("signups", "Signups", 2, { trend: [1, 2] })] },
    ]);
    expect(tileKeys(html)).toEqual(["signups", "tutor_sessions", "llm_cost_cents", "errors_5xx"]);
    const tile = tileOf(html, "signups");
    expect(tile).toContain(">Signups<");
    expect(tile).toContain("last 7d");
    expect(tile).toContain("<polyline");
    expect(tile).toMatch(/data-count="2"[^>]*font-size:27px/);
    expect(tileOf(html, "errors_5xx")).not.toContain("<polyline"); // no trend points → no line
  });

  it("missing headline keys are filled from chat messages, logins, quizzes completed — up to four", () => {
    const fill = one([
      { id: "learning", title: "Learning activity", metrics: [count("quizzes_completed", "Quizzes completed", 1), count("chat_messages", "Chat messages", 9), count("notes_created", "Notes created", 3)] },
      { id: "growth", title: "Growth", metrics: [count("logins", "Logins", 7), count("signups", "Signups", 2)] },
    ]);
    expect(tileKeys(fill)).toEqual(["signups", "chat_messages", "logins", "quizzes_completed"]);
    // Five candidates → still four, in order.
    const five = one([{ id: "x", title: "X", metrics: ["quizzes_completed", "logins", "errors_5xx", "tutor_sessions", "signups"].map((k) => count(k, k, 1)) }]);
    expect(tileKeys(five)).toEqual(["signups", "tutor_sessions", "errors_5xx", "logins"]);
  });

  it("fewer than two headline keys → no strip; an unknown key never becomes a headline", () => {
    const html = one([{ id: "growth", title: "Growth", metrics: [count("signups", "Signups", 2), count("approvals", "Approvals", 1)] },
      { id: "other", title: "Other", metrics: [count("mystery", "Mystery", 5)] }]);
    expect(tileKeys(html)).toEqual([]);
    expect(html).not.toContain("repo-kpis");
    expect(tileKeys(view())).toEqual(["signups", "llm_cost_cents"]); // two is enough
  });

  it("a headline tile with no recent reading keeps its label and says so — no figure, no line, no count-up", () => {
    const html = one([{ id: "growth", title: "Growth", metrics: [count("signups", "Signups", null, { trend: [1, 2, 3] }), count("logins", "Logins", 4)] }]);
    const tile = tileOf(html, "signups");
    expect(tile).toContain(">Signups<");
    expect(tile).toContain("no recent reading");
    expect(tile).not.toContain("<polyline");
    expect(tile).not.toContain("data-count");
    expect(tile).not.toContain("last 7d");
  });

  it("5xx errors above zero take the bad tone on their tile; a measured zero does not", () => {
    const at = (n: number) => tileOf(one([{ id: "reliability", title: "Reliability", metrics: [count("errors_5xx", "5xx errors", n, { trend: [1, 2] })] },
      { id: "growth", title: "Growth", metrics: [count("signups", "Signups", 1)] }]), "errors_5xx");
    expect(at(3)).toContain("color:var(--red)");
    expect(at(3)).toContain('stroke="var(--red)"');
    expect(at(0)).not.toContain("var(--red)");
    expect(at(0)).toContain(">0<");
  });

  it("count-up lands on the Worker's own string: a compacted or dollar figure carries its format", () => {
    const html = view();
    expect(tileOf(html, "signups")).toMatch(/data-count="21" class=/); // a plain integer needs no format
    expect(tileOf(html, "llm_cost_cents")).toMatch(/data-count="2961" data-count-fmt="usd"[^>]*>\$29\.61</);
    const big = one([{ id: "learning", title: "Learning activity", metrics: [count("tutor_sessions", "Tutor sessions", 1380, { values: all3("1.4K") }), count("chat_messages", "Chat messages", 2)] }]);
    expect(tileOf(big, "tutor_sessions")).toMatch(/data-count="1380" data-count-fmt="compact" title="1,380"[^>]*>1\.4K</);
    // The in-between frames mirror the Worker's formatting.
    expect(formatCount(1380, "compact")).toBe("1.4K");
    expect(formatCount(999_950, "compact")).toBe("1.00M");
    expect(formatCount(2961, "usd")).toBe("$29.61");
    expect(formatCount(123_456_789, "usd")).toBe("$1.23M");
    expect(formatCount(20.6, undefined)).toBe("21");
  });

  // ── level 2: a shape per group ─────────────────────────────────────────────
  it("Learning activity is a ranked bar list: sorted by the range's figure, widths proportional, null last", () => {
    const m = (key: string, a: number | null, b: number | null): RepoProductCount => ({ key, label: key, trend: [1, 2, 3],
      values: { "24h": a === null ? null : String(a), "7d": b === null ? null : String(b), "30d": null }, raw: { "24h": a, "7d": b, "30d": null } });
    const groups = [{ id: "learning", title: "Learning activity", metrics: [m("small", 50, 1), m("stale", null, null), m("big", 200, 3), m("zero", 0, 12), m("mid", 100, 6)] }];
    const order = (html: string) => [...blockOf(html, "learning").matchAll(/data-prow="([^"]*)"/g)].map((x) => x[1]);
    const day = one(groups, [], { range: "24h" });
    expect(order(day)).toEqual(["big", "mid", "small", "zero", "stale"]);
    expect(order(one(groups, [], { range: "7d" }))).toEqual(["zero", "mid", "big", "small", "stale"]); // re-ranked per range
    const width = (key: string) => /width:([\d.]+)%/.exec(rowOf(day, key))?.[1];
    expect([width("big"), width("mid"), width("small")]).toEqual(["100", "50", "25"]);
    expect(rowOf(day, "big")).toContain('class="repo-fill"');
    // A measured zero keeps its track and draws no fill; a null draws no bar at all and says why.
    expect(rowOf(day, "zero")).not.toContain("repo-fill");
    expect(rowOf(day, "zero")).toContain(">0<");
    expect(rowOf(day, "stale")).toContain("no recent reading");
    expect(rowOf(day, "stale")).not.toMatch(/[^-]width:/);
    expect(blockOf(day, "learning")).not.toContain("<polyline"); // the bar is the picture
  });

  it("AI spend is one feature block: the cost leads, the rest is one quiet line, and nothing is derived", () => {
    const html = one([{ id: "ai", title: "AI spend", metrics: [
      count("llm_calls", "LLM calls", 21_400, { values: all3("21.4K") }),
      count("llm_tokens", "LLM tokens", 33_100_000, { values: all3("33.10M") }),
      count("llm_cost_cents", "LLM cost", 2961, { values: all3("$29.61"), trend: [1, 2, 3], note: "lower bound — unpriced models are not counted" }),
    ] }]);
    const ai = blockOf(html, "ai");
    expect(ai).toMatch(/font-size:22px[^>]*>\$29\.61</);
    expect(ai.indexOf("$29.61")).toBeLessThan(ai.indexOf("21.4K"));
    expect(ai).toMatch(/>21\.4K<\/span> LLM calls/);
    expect(ai).toMatch(/>33\.10M<\/span> LLM tokens/);
    expect((ai.match(/<polyline/g) ?? []).length).toBe(1); // the cost's line only
    expect(ai.indexOf("lower bound")).toBeGreaterThan(ai.indexOf("<polyline"));
    // Only reported numbers: no cost per call, no per-token figure.
    expect(ai).not.toMatch(/per |\/ ?call|÷/i);
    expect((ai.match(/\$/g) ?? []).length).toBe(1);
  });

  it("AI spend without a cost key leads with its first metric; a null lead says so and draws no line", () => {
    const html = one([{ id: "ai", title: "AI spend", metrics: [count("llm_calls", "LLM calls", null, { trend: [1, 2, 3] }), count("llm_tokens", "LLM tokens", null)] }]);
    const ai = blockOf(html, "ai");
    expect(ai).toContain("LLM calls · last 7d");
    expect(ai.split("no recent reading").length - 1).toBe(2);
    expect(ai).not.toContain("<polyline");
    expect(ai).not.toContain("data-count");
  });

  it("Reliability is a status list: non-zero first with a tone dot, zeros folded into ONE line, nulls named apart", () => {
    const html = one([{ id: "reliability", title: "Reliability", metrics: [
      count("rag_retrieval_failed", "RAG retrieval failed", 0),
      count("errors_4xx", "4xx errors", 980, { note: "includes bot traffic and refused polls" }),
      count("quiz_context_write_failed", "Quiz context write failed", 0),
      count("quiz_generation_failed", "Quiz generation failed", 9),
      count("rag_chunks_dropped", "RAG runs that dropped chunks", null),
      count("errors_5xx", "5xx errors", 17),
    ] }]);
    const rel = blockOf(html, "reliability");
    const rows = [...rel.matchAll(/data-prow="([^"]*)"/g)].map((x) => x[1]);
    // Failures lead (largest first); 4xx — mostly bots — follows, whatever its size. Zeros and nulls are not rows.
    expect(rows).toEqual(["errors_5xx", "quiz_generation_failed", "errors_4xx"]);
    expect(rowOf(html, "errors_5xx")).toContain("background:var(--red)");
    expect(rowOf(html, "quiz_generation_failed")).toContain("background:var(--red)");
    expect(rowOf(html, "errors_4xx")).toContain("background:var(--fg-55)");
    expect(rowOf(html, "errors_4xx")).not.toContain("var(--red)");
    expect(rowOf(html, "errors_5xx")).toContain(">17<");
    const zero = cut(rel, "data-pzero", ["data-pstale", "repo-pnotes"]);
    expect(zero).toContain("2 at zero");
    expect(zero).toContain("RAG retrieval failed, Quiz context write failed");
    expect((rel.match(/data-pzero/g) ?? []).length).toBe(1);
    // A figure with no recent reading is NOT a zero: named on its own line, never in the fold.
    expect(zero).not.toContain("RAG runs that dropped chunks");
    const stale = cut(rel, "data-pstale", ["repo-pnotes"]);
    expect(stale).toContain("no recent reading — RAG runs that dropped chunks");
    expect(rel.indexOf("data-pzero")).toBeGreaterThan(rel.lastIndexOf('data-prow="'));
    expect(rel.indexOf("4xx errors: includes bot traffic")).toBeGreaterThan(rel.indexOf("data-pstale"));
    expect(rel).not.toContain("<polyline");
  });

  it("an all-zero Reliability group is just the one line; an all-live one has no zero line", () => {
    const zeros = blockOf(one([{ id: "reliability", title: "Reliability", metrics: [count("errors_5xx", "5xx errors", 0), count("errors_4xx", "4xx errors", 0)] }]), "reliability");
    expect(zeros).toContain("2 at zero");
    expect(zeros).not.toContain('data-prow="');
    expect(zeros).not.toContain("data-pstale");
    const hot = blockOf(one([{ id: "reliability", title: "Reliability", metrics: [count("errors_5xx", "5xx errors", 2)] }]), "reliability");
    expect(hot).not.toContain("data-pzero");
    expect(hot).not.toContain("at zero");
  });

  it("Growth and Community are stat pairs — number over label, no per-row sparkline", () => {
    const html = one([
      { id: "growth", title: "Growth", metrics: [count("signups", "Signups", 21, { trend: [1, 2, 3] }), count("logins", "Logins", 182, { trend: [1, 2, 3] })] },
      { id: "community", title: "Community", metrics: [count("feedback", "Feedback", 0, { trend: [1, 2, 3] })] },
    ]);
    for (const id of ["growth", "community"]) {
      expect(blockOf(html, id)).toContain("grid-template-columns:repeat(3,");
      expect(blockOf(html, id)).not.toContain("<polyline");
    }
    const row = rowOf(html, "signups", "growth");
    expect(row.indexOf(">21<")).toBeLessThan(row.indexOf(">Signups<"));
    expect(row).toMatch(/font-size:21px[^>]*>21</);
    expect(rowOf(html, "feedback", "community")).toContain(">0<"); // a measured zero is a reading
  });

  it("an unknown key still renders — as a quiet row under Other, after every known block; so does an unknown group", () => {
    const html = one([
      { id: "other", title: "Other", metrics: [count("brand_new_thing", "Brand new thing", 1500, { values: all3("1.5K"), note: "new this week" }), count("constructor", "Constructor", null)] },
      { id: "growth", title: "Growth", metrics: [count("signups", "Signups", 2)] },
      { id: "somewhere_new", title: "Somewhere new", metrics: [count("k", "A key", 4)] },
    ]);
    const other = blockOf(html, "other");
    expect(other).toContain(">Other<");
    expect(other).toMatch(/>Brand new thing<[\s\S]*title="1,500"[^>]*>1\.5K</);
    expect(rowOf(html, "constructor", "other")).toContain("no recent reading");
    expect(other).toContain("Brand new thing: new this week");
    expect(html.indexOf('data-pblock="other"')).toBeGreaterThan(html.indexOf('data-pblock="growth"'));
    expect(blockOf(html, "somewhere_new")).toMatch(/>Somewhere new<[\s\S]*>A key<[\s\S]*>4</);
  });

  it("the blocks sit on a 12-column grid: a wide list beside a narrow block, and a lone block takes the row", () => {
    const g = (id: string, key: string) => ({ id, title: id, metrics: [count(key, key, 1)] });
    const full = one([g("growth", "signups"), g("learning", "notes_created"), g("community", "rooms_x"), g("ai", "llm_calls"), g("reliability", "errors_5xx")]);
    expect(full).toContain("grid-template-columns:repeat(12,");
    const spans = (html: string) => [...html.matchAll(/grid-column:span (\d+);[^"]*"><div data-pblock="([^"]*)"/g)].map((m) => `${m[2]}:${m[1]}`);
    // Growth and Community share ONE narrow cell (growth opens it).
    expect(spans(full)).toEqual(["learning:7", "ai:5", "reliability:7", "growth:5"]);
    expect(full.indexOf('data-pblock="community"')).toBeGreaterThan(full.indexOf('data-pblock="growth"'));
    expect(spans(one([g("learning", "notes_created")]))).toEqual(["learning:12"]);
    expect(spans(one([g("growth", "signups"), g("reliability", "errors_5xx")]))).toEqual(["reliability:7", "growth:5"]);
  });

  it("a metric's note is a footnote under its group, once; two notes are two lines of ONE block, in row order", () => {
    const html = view();
    expect(html.split("lower bound — unpriced models are not counted").length - 1).toBe(1);
    expect(blockOf(html, "ai").indexOf("lower bound")).toBeGreaterThan(blockOf(html, "ai").indexOf("LLM cost"));
    const two = one([{ id: "reliability", title: "Reliability", metrics: [
      count("errors_5xx", "5xx errors", 3),
      count("errors_4xx", "4xx errors", 9, { note: "includes bot traffic and refused polls" }),
      count("x", "Other thing", 1, { note: "lower bound — a second note" }),
    ] }]);
    const a = two.indexOf("4xx errors: includes bot traffic and refused polls");
    const b = two.indexOf("Other thing: lower bound — a second note");
    expect(a).toBeGreaterThan(two.indexOf(">Other thing<")); // under the rows
    expect(b).toBeGreaterThan(a);
    expect(two.split("includes bot traffic and refused polls").length - 1).toBe(1);
    expect((two.match(/class="repo-pnotes"/g) ?? []).length).toBe(1);
    expect(two).not.toMatch(/undefined|NaN/);
  });

  // ── another service's text ─────────────────────────────────────────────────
  it("labels, keys, notes, titles, values and environment names are another service's text — escaped at EVERY site", () => {
    const hostile = `<img src=x onerror=1>`;
    const quote = `"><script>alert(1)</script>`;
    const evil = (key: string, n: number | null = 5): RepoProductCount => count(key, hostile, n, { values: all3(n === null ? null : hostile), trend: [1, 2], note: quote });
    // Every shape, every headline slot, a zero fold, a null line, the strip, the switch.
    const groups = [
      { id: "growth", title: hostile, metrics: [evil("signups"), evil("logins", null)] },
      { id: "learning", title: hostile, metrics: [evil("tutor_sessions"), evil("chat_messages", null)] },
      { id: "community", title: hostile, metrics: [evil(hostile)] },
      { id: "ai", title: hostile, metrics: [evil("llm_cost_cents"), evil("llm_calls"), evil("llm_tokens", null)] },
      { id: "reliability", title: hostile, metrics: [evil("errors_5xx"), evil("errors_4xx", 0), evil(quote, null)] },
      { id: "other", title: hostile, metrics: [evil(hostile)] },
      { id: quote, title: quote, metrics: [evil(quote)] },
    ];
    const totals = [{ key: hostile, label: hostile, value: hostile, raw: 1, trend: [], note: quote }, { key: quote, label: quote, value: null, raw: null, trend: [] }];
    for (const productEnv of [null, quote]) {
      const html = view({ productEnv }, [{ name: quote, groups: [], totals: [] }, { name: hostile, groups, totals }]);
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<script>");
      expect(html).not.toMatch(/"><(script|img)/); // an attribute value never closes its tag
      expect(html).not.toContain("&amp;lt;"); // …and escaped exactly ONCE
      expect(html).not.toContain("&amp;quot;");
    }
    const html = view({}, [{ name: hostile, groups, totals }]);
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    for (const id of ["now", "growth", "learning", "community", "ai", "reliability", "other"]) expect(blockOf(html, id), id).toContain("&lt;img src=x");
    expect(tileOf(html, "signups")).toContain("&lt;img src=x");
  });

  it("the infrastructure blocks escape their environment names, labels and values too", () => {
    const hostile = `"><img src=x onerror=1>`;
    const rows = [{ env: hostile, label: "Workers requests", value: hostile }, { env: hostile, label: hostile, value: hostile }];
    const html = repoView(props({ tab: "usage", repo: { status: "ok", data: live({
      cloudflare: { status: "ok", data: { "24h": rows, "7d": rows, "30d": rows } },
      hosting: { status: "ok", data: [{ env: hostile, cpu: hostile, memory: `1 ${hostile}` }] },
    }) } }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/"><(script|img)/);
    expect(html).toContain("&lt;img src=x");
  });

  // ── section states ─────────────────────────────────────────────────────────
  it("an ok section carrying NO environment renders the section's empty state, never nothing", () => {
    const html = view({}, []);
    expect(html).toContain(">Product<");
    expect(html).toContain("No current product reading — the hourly poll of the app&#39;s metrics endpoint has gone quiet.");
    expect(html).not.toContain("data-penv");
  });

  it("not_connected and empty each say what they are waiting on; loading and error have their forms", () => {
    const nc = repoView(props({ tab: "usage", repo: { status: "ok", data: live() } }));
    expect(nc).toContain("No product metrics reported yet. They appear once the app&#39;s metrics endpoint serves `counts` / `totals` and `SAPLING_METRICS_TOKEN` is set.");
    const quiet = repoView(props({ tab: "usage", repo: { status: "ok", data: live({ product: EMPTY }) } }));
    expect(quiet).toContain("No current product reading — the hourly poll of the app&#39;s metrics endpoint has gone quiet.");
    expect(quiet).not.toContain("No product metrics reported yet");
    for (const html of [nc, quiet]) { expect(html).toContain(">Product<"); expect(html).not.toContain("repoProductEnv"); }
    expect(repoView(props({ tab: "usage", repo: { status: "loading", data: null } }))).toContain("repo-shimmer");
    expect(repoView(props({ tab: "usage", repo: { status: "error", data: null } }))).toContain("Couldn't load this section");
  });

  it("the not-connected footer counts the product section too", () => {
    const others = { ...repoSample(), sample: undefined } as RepoDashboard;
    expect(repoView(props({ tab: "usage", repo: { status: "ok", data: others } }))).not.toContain("repoSampleOn");
    expect(repoView(props({ tab: "usage", repo: { status: "ok", data: { ...others, product: NC } } }))).toContain("repoSampleOn");
    // …and only on the Usage tab.
    expect(repoView(props({ tab: "code", repo: { status: "ok", data: { ...others, product: NC } } }))).not.toContain("repoSampleOn");
  });

  // ── sample mode ────────────────────────────────────────────────────────────
  it("the sample set carries placeholder product metrics for both environments, and shows every shape", () => {
    const data = repoSample();
    expect(data.product.status).toBe("ok");
    const envs = (data.product as { data: RepoProductEnv[] }).data;
    expect(envs.map((e) => e.name)).toEqual(["staging", "production"]);
    for (const e of envs) {
      expect(e.groups.map((g) => g.title)).toEqual(["Growth", "Learning activity", "Community", "AI spend", "Reliability"]);
      expect(e.totals.length).toBeGreaterThan(3);
      for (const m of e.groups.flatMap((g) => g.metrics)) {
        expect(m.raw["24h"]! <= m.raw["7d"]! && m.raw["7d"]! <= m.raw["30d"]!, `${e.name} ${m.key}`).toBe(true); // the windows nest, as the contract guarantees
      }
    }
    const sample = (over: Partial<RepoProps> = {}) => repoView(props({ tab: "usage", repo: { status: "ok", data }, sample: true, ...over }));
    const html = sample();
    expect(html).toContain('data-penv="production"');
    expect(html).toContain("lower bound — unpriced models are not counted");
    expect(tileKeys(html)).toEqual(["signups", "tutor_sessions", "llm_cost_cents", "errors_5xx"]);
    // Reliability shows BOTH shapes at the default range: real failures, and a fold of measured zeros.
    for (const h of [html, sample({ productEnv: "staging" })]) {
      const rel = blockOf(h, "reliability");
      expect(rel).toContain("background:var(--red)");
      expect(rel).toMatch(/\d at zero/);
    }
    expect(sample({ productEnv: "staging" })).toContain('data-penv="staging"');
    expect(html.slice(html.indexOf(">Product<"))).not.toContain("<table");
    // The placeholder set is labelled by hand (the sample chunk cannot import the
    // Worker's registry), so it is held to it here: same label, group and note.
    const keys = envs[0].groups.flatMap((g) => g.metrics.map((m) => m.key));
    expect(keys).toEqual(expect.arrayContaining(["logins", "quiz_context_write_failed", "rag_visibility_resync_failed", "rag_chunks_dropped"]));
    expect(keys).not.toContain("study_guides");
    for (const e of envs) {
      for (const g of e.groups) for (const m of g.metrics) {
        const info = productKeyInfo(m.key);
        expect([m.key, g.id, m.label, m.note]).toEqual([m.key, info.group, info.label, info.note]);
      }
      for (const t of e.totals) expect([t.key, t.label, t.note]).toEqual([t.key, productKeyInfo(t.key).label, productKeyInfo(t.key).note]);
    }
    expect(html).toContain("Flashcards created: lower bound — deleted cards are not counted");
    expect(html).toContain("4xx errors: includes bot traffic and refused polls");
    expect(sample({ range: "30d" })).toContain(">RAG runs that dropped chunks<");
  });

  // ── motion ─────────────────────────────────────────────────────────────────
  it("entrances use the existing hooks only, and the body is what a range or environment switch cross-fades", () => {
    const html = view();
    const product = html.slice(html.indexOf(">Product<"), html.indexOf("Cloudflare — frontend"));
    expect(product).toMatch(/class="repo-swap repo-pswap" data-penv="staging"/);
    expect([...product.matchAll(/class="cnpy-rise" style="--i:(\d+);/g)].map((m) => m[1])).toEqual(["2", "3", "4"]); // strip, tiles, blocks
    expect(html).toMatch(/class="cnpy-rise" style="--i:2;"><div[^>]*><span[^>]*>Product</); // the header enters with the strip
    expect(product).toContain("data-count=");
    expect(product).toContain('class="repo-spark"');
    expect(product).not.toMatch(/animation|transition|@keyframes/);
  });
});

// ── Usage › infrastructure (Cloudflare + Railway) ────────────────────────────
describe("repoView — usage infrastructure", () => {
  const cfView = (rows: { env: string; label: string; value: string }[], over: Partial<RepoDashboard> = {}) =>
    repoView(props({ tab: "usage", repo: { status: "ok", data: live({ cloudflare: { status: "ok", data: { "24h": rows, "7d": rows, "30d": rows } }, ...over }) } }));
  const envOf = (html: string, env: string) => { const i = html.indexOf(`data-cfenv="${env}"`); const j = html.indexOf("data-cfenv=", i + 1); return html.slice(i, j > -1 ? j : html.indexOf("Hosting — Railway")); };
  const pair = (env: string, req: string, err: string) => [{ env, label: "Workers requests", value: req }, { env, label: "Workers errors", value: err }];

  it("Cloudflare is a block per environment — requests as the figure, errors beside it, an error-share bar under them", () => {
    const html = cfView([...pair("staging", "12.4K", "310"), ...pair("production", "1.24M", "2.6K")]);
    expect(html).toContain("Cloudflare — frontend Workers");
    const staging = envOf(html, "staging");
    expect(staging).toMatch(/font-size:21px[^>]*>12\.4K</);
    expect(staging).toMatch(/font-size:17px[^>]*>310</);
    expect(staging).toContain(">Workers requests<");
    expect(staging).toMatch(/class="repo-fill"[^>]*width:2\.5%/); // 310 ÷ 12,400
    expect(envOf(html, "production")).toMatch(/class="repo-fill"[^>]*width:0\.2%/);
    expect(html.slice(html.indexOf("Cloudflare — frontend"))).not.toContain("<table");
  });

  it("the share bar is drawn only from the two figures shown: hidden when requests is 0, or either is missing or unreadable", () => {
    expect(envOf(cfView(pair("staging", "0", "0")), "staging")).not.toContain("repo-fill");
    expect(envOf(cfView([{ env: "staging", label: "Workers requests", value: "2.50M" }]), "staging")).not.toContain("repo-fill");
    expect(envOf(cfView([{ env: "staging", label: "Workers errors", value: "12" }]), "staging")).not.toContain("repo-fill");
    expect(envOf(cfView(pair("staging", "lots", "12")), "staging")).not.toContain("repo-fill");
    expect(envOf(cfView(pair("staging", "12", "—")), "staging")).not.toContain("repo-fill");
    // …and the figures themselves are still there.
    expect(envOf(cfView(pair("staging", "0", "0")), "staging")).toContain(">Workers errors<");
    // Zero errors of real traffic IS a bar — an empty one.
    expect(envOf(cfView(pair("staging", "500", "0")), "staging")).toMatch(/class="repo-fill"[^>]*min-width:0px[^>]*width:0%/);
  });

  it("the bar takes the error rate's own tone from the usage block, and stays neutral without one", () => {
    const usageEnv = (tone: "good" | "warn") => ({ name: "staging", host: "h", requests: { value: "12.4K", trend: [], tone: "neutral" as const }, errorRate: { value: "2.50%", trend: [], tone }, users: null, seen: { requests: true, users: false } });
    const usage = (tone: "good" | "warn") => ({ usage: { status: "ok" as const, data: { "24h": [usageEnv(tone)], "7d": [usageEnv(tone)], "30d": [usageEnv(tone)] } } });
    expect(envOf(cfView(pair("staging", "12.4K", "310"), usage("warn")), "staging")).toMatch(/class="repo-fill"[^>]*background:var\(--amber\)/);
    expect(envOf(cfView(pair("staging", "12.4K", "310"), usage("good")), "staging")).toMatch(/class="repo-fill"[^>]*background:var\(--fg-40\)/);
    expect(envOf(cfView(pair("staging", "12.4K", "310")), "staging")).toMatch(/class="repo-fill"[^>]*background:var\(--fg-40\)/);
  });

  it("parseCompact reads the Worker's compact figures and nothing else", () => {
    expect([parseCompact("302"), parseCompact("12.4K"), parseCompact("1.24M"), parseCompact("2.50B"), parseCompact("1.00T")]).toEqual([302, 12_400, 1_240_000, 2_500_000_000, 1e12]);
    for (const bad of ["", "—", "1e3", "-5", "12 K", "1.2.3K", "K", undefined]) expect(parseCompact(bad), String(bad)).toBeNull();
    expect(errorShare("1000", "25")).toBe(2.5);
    expect(errorShare("10", "50")).toBe(100); // never wider than its track
    expect(errorShare("0", "0")).toBeNull();
    expect(errorShare(undefined, "3")).toBeNull();
  });
});

describe("Poll now — the Repo top bar, every tab", () => {
  const done = (result: RepoRefreshResult) => ({ status: "done" as const, result });
  const NOT: RepoRefreshResult = { health: "not_configured", cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured", github: "not_configured" };
  const TABS = REPO_TABS.map(([t]) => t);
  const stripText = (html: string) => html.slice(html.indexOf("repo-poll-strip")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const view = (over: Partial<RepoProps> = {}) => repoView(props({ admin: true, ...over }));

  it("the button is in the top bar on all five tabs for an admin — and absent for a non-admin and in sample mode", () => {
    for (const tab of TABS) {
      const bar = repoControls(props({ tab, admin: true }));
      expect(bar, tab).toContain('data-act="repoPollNow"');
      expect(bar, tab).toContain('<span class="repo-pollbtn-label">Poll now</span>');
      expect(repoControls(props({ tab, admin: false })), tab).not.toContain("repoPollNow");
      expect(repoControls(props({ tab, admin: true, sample: true, repo: { status: "ok", data: repoSample() } })), tab).not.toContain("repoPollNow");
      // It left the tab's own content: the bar is the one place it lives.
      expect(repoView(props({ tab, admin: true })), tab).not.toContain("repoPollNow");
    }
  });

  // The pin: a non-admin's bar (and an admin's in sample mode) is byte-for-byte
  // what it was before the button existed — no wrapper, no new title, no class.
  it("a non-admin's top bar is exactly what it was", () => {
    const REFRESH = `<button data-act="repoRefresh" title="Refresh" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
    </button>`;
    const PINNED = `
    <span data-repo-updated style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">updated just now</span>
    ${REFRESH}`;
    expect(repoControls(props({ admin: false }))).toBe(PINNED);
    expect(repoControls(props({ admin: true, sample: true }))).toBe(PINNED);
    // With environments connected the bar only gains the pills it always had.
    const withEnvs = repoControls(props({ admin: false, repo: { status: "ok", data: repoSample() } }));
    expect(withEnvs.endsWith(PINNED)).toBe(true);
    expect(withEnvs).not.toContain("repo-pollbtn");
  });

  it("is there whatever state the dashboard is in — every section not connected, degraded, still loading, or failed", () => {
    const states: RepoProps["repo"][] = [
      { status: "ok", data: live() }, // every capturable section not_connected / empty
      { status: "ok", data: live({ degraded: true }) },
      { status: "loading", data: null },
      { status: "loading", data: live() },
      { status: "error", data: null, error: "boom" },
    ];
    for (const repo of states) expect(repoControls(props({ admin: true, repo })), repo.status).toContain('data-act="repoPollNow"');
  });

  it("the two controls say different things, and the button has a name when its label is hidden", () => {
    const bar = repoControls(props({ admin: true }));
    const TITLE = "Poll deploys, CI, usage and health now (admin) — issues refresh with Sync GitHub";
    expect(bar).toContain(`data-act="repoPollNow" title="${TITLE}" aria-label="${TITLE}"`);
    expect(bar).not.toContain("every source"); // it does not: issues refresh with Sync GitHub
    // While it runs, the title says so too — not only the label a narrow bar hides.
    expect(repoControls(props({ admin: true, poll: { status: "polling" } }))).toContain('data-act="repoPollNow" title="Polling…" aria-label="Polling…"');
    expect(bar).toMatch(/data-act="repoRefresh" title="Reload from Canopy's database"/);
    // Narrow widths hide the label by CLASS (canopy.css) — the markup is the same at every width.
    expect(bar).toContain('class="cnpy-outlinebtn repo-pollbtn"');
  });

  it("while polling the button is disabled and says so; no strip yet", () => {
    const bar = repoControls(props({ admin: true, poll: { status: "polling" } }));
    expect(bar).toMatch(/<button data-act="repoPollNow"[^>]* disabled aria-busy="true"[^>]*pointer-events:none[^>]*>/);
    expect(bar).toContain('<span class="repo-pollbtn-label">Polling…</span>');
    expect(bar).toContain("animation:cnpy-spin"); // the refresh icon's own spinner — no new animation
    expect(view({ poll: { status: "polling" } })).not.toContain("repo-poll-strip");
  });

  it("the strip is at the top of WHICHEVER tab is open — it survives a tab switch", () => {
    const poll = done({ ...NOT, github: { written: 12, unchanged: 240, failed: [] } });
    for (const tab of TABS) {
      const html = view({ tab, poll });
      expect(html, tab).toMatch(/class="repo-panel"[^>]*><div class="repo-poll-strip"/);
      expect(stripText(html), tab).toContain("GitHub — 12 new · 240 unchanged");
      expect(html, tab).toContain('data-act="repoPollDismiss"');
    }
  });

  it("is kept anywhere on the Repo screen and cleared on leaving it", () => {
    const poll = done(NOT);
    expect(repoPollFor(poll, true)).toBe(poll);
    expect(repoPollFor({ status: "polling" }, true)).toEqual({ status: "polling" });
    expect(repoPollFor(poll, false)).toBeNull();
    expect(repoPollFor({ status: "polling" }, false)).toBeNull(); // an in-flight answer is then dropped on arrival
    expect(repoPollFor(null, true)).toBeNull();
  });

  it("the strip is for an admin on the live dashboard only", () => {
    const poll = done(NOT);
    expect(view({ admin: false, poll })).not.toContain("repo-poll-strip");
    expect(view({ poll, sample: true, repo: { status: "ok", data: repoSample() } })).not.toContain("repo-poll-strip");
  });

  it("Health is summarised: how many are up, and each one that is not, by name", () => {
    const up = (env: string, part: "frontend" | "backend") => ({ env, part, status: "ok" as const, written: 2 });
    const allUp = view({ poll: done({ ...NOT, health: [up("staging", "frontend"), up("staging", "backend"), up("production", "frontend"), up("production", "backend")] }) });
    expect(stripText(allUp)).toContain("Health — 4 up Cloudflare");
    expect(allUp).toMatch(/color:var\(--green\)[^>]*>4 up</);

    const oneDown = view({ poll: done({ ...NOT, health: [up("staging", "frontend"), { env: "staging", part: "backend", status: "failed", written: 2, detail: "timeout" }, up("production", "frontend"), up("production", "backend")] }) });
    expect(stripText(oneDown)).toContain("Health — 3 up · staging api ✗ timeout");
    expect(oneDown).toMatch(/color:var\(--red\)[^>]*>✗ timeout</);

    const allDown = view({ poll: done({ ...NOT, health: [{ env: "staging", part: "frontend", status: "failed", written: 0, detail: "HTTP 503" }, { env: "staging", part: "backend", status: "failed", written: 0, detail: "unreachable" }] }) });
    expect(stripText(allDown)).toContain("Health — staging web ✗ HTTP 503 · staging api ✗ unreachable");
    expect(stripText(allDown)).not.toContain("0 up");

    expect(stripText(view({ poll: done(NOT) }))).toContain("Health — not configured");
    expect(stripText(view({ poll: done({ ...NOT, health: [{ env: "*", status: "failed", written: 0, detail: "unexpected error" }] }) }))).toContain("Health — all ✗ unexpected error");
  });

  it("GitHub is one line: the counts, the failed arms by name, a budget skip, or not configured", () => {
    expect(stripText(view({ poll: done({ ...NOT, github: { written: 12, unchanged: 240, failed: [] } }) }))).toContain("GitHub — 12 new · 240 unchanged");
    const failed = view({ poll: done({ ...NOT, github: { written: 3, unchanged: 40, failed: ["deployments", "runs"] } }) });
    expect(stripText(failed)).toContain("GitHub — ✗ failed: deployments, runs — 3 new · 40 unchanged");
    expect(failed).toMatch(/color:var\(--red\)[^>]*>✗ failed: deployments, runs</);
    expect(stripText(view({ poll: done({ ...NOT, github: { written: 0, unchanged: 0, failed: ["unexpected error"] } }) }))).toContain("GitHub — ✗ failed: unexpected error");
    // The budget skip rides `failed`, but nothing failed — it reads as a skip, muted.
    const skipped = view({ poll: done({ ...NOT, github: { written: 0, unchanged: 0, failed: ["skipped: would exceed the subrequest budget"] } }) });
    expect(stripText(skipped)).toContain("GitHub — – skipped: would exceed the subrequest budget");
    expect(skipped).not.toContain("✗ failed");
    expect(stripText(view({ poll: done(NOT) }))).toContain("GitHub — not configured");
  });

  it("the usage sources read as they always did: new rows, up to date, a failure's detail, a skip, not configured", () => {
    const html = view({ tab: "usage", poll: done({
      ...NOT,
      cloudflare: [{ env: "staging", status: "ok", written: 3 }, { env: "production", status: "failed", written: 0, detail: "cloudflare analytics 403" }],
      sapling: [{ env: "staging", status: "ok", written: 0 }, { env: "production", status: "skipped", written: 0, detail: "apiUrl is not https" }],
    }) });
    const text = stripText(html);
    expect(text).toContain("Cloudflare — staging ✓ 3 new · production ✗ cloudflare analytics 403");
    expect(text).toContain("Railway — not configured");
    expect(text).toContain("App metrics — staging ✓ up to date · production – skipped: apiUrl is not https");
    // The five lines, in the order the sources ran.
    expect(text.indexOf("Health")).toBeLessThan(text.indexOf("Cloudflare"));
    expect(text.indexOf("App metrics")).toBeLessThan(text.indexOf("GitHub"));
    // Tone comes from the existing variables: good / bad / muted.
    expect(html).toMatch(/color:var\(--green\)[^>]*>✓ 3 new/);
    expect(html).toMatch(/color:var\(--red\)[^>]*>✗ cloudflare analytics 403/);
    expect(html).toMatch(/color:var\(--fg-40\)[^>]*>not configured/);
  });

  it("an ok outcome's detail (dropped product keys) and a failed one's partial write are both said — escaped", () => {
    const html = view({ poll: done({
      ...NOT,
      sapling: [
        { env: "staging", status: "ok", written: 7, detail: "2 keys dropped: counts.foo, totals.<b>" },
        { env: "production", status: "failed", written: 4, detail: "the windows do not nest (24h ≤ 7d ≤ 30d)" },
      ],
    }) });
    const text = stripText(html);
    expect(text).toContain("App metrics — staging ✓ 7 new — 2 keys dropped: counts.foo, totals.&lt;b&gt;");
    expect(text).toContain("production ✗ the windows do not nest (24h ≤ 7d ≤ 30d) — 4 new");
    expect(html).not.toContain("totals.<b>");
    // The failure is red; the rows that DID land are not a failure, so "— 4 new" is muted, not red.
    expect(html).toMatch(/color:var\(--red\)[^>]*>✗ the windows do not nest \(24h ≤ 7d ≤ 30d\)<\/span>/);
    expect(html).toMatch(/color:var\(--fg-40\)[^>]*> — 4 new<\/span>/);
  });

  it("a source with no environment says so, and the unexpected-error arm reads as all environments", () => {
    const text = stripText(view({ poll: done({ ...NOT, cloudflare: [], sapling: [{ env: "*", status: "failed", written: 0, detail: "unexpected error" }] }) }));
    expect(text).toContain("Cloudflare — no environment configured");
    expect(text).toContain("App metrics — all ✗ unexpected error");
  });

  it("never trusts a detail, an environment name, a part or a failed-arm name as markup", () => {
    const html = view({ poll: done({
      ...NOT,
      health: [{ env: `<i>prod</i>`, part: `<u>p</u>` as never, status: "failed", written: 0, detail: `<svg onload=1>` }],
      cloudflare: [{ env: `<b>stg</b>`, status: "failed", written: 0, detail: `<img src=x onerror=1>` }],
      github: { written: 0, unchanged: 0, failed: [`<script>alert(1)</script>`, `"><img src=y>`] },
    }) });
    for (const raw of ["<img src=x", "<b>stg</b>", "<i>prod</i>", "<u>p</u>", "<svg onload", "<script>alert", "<img src=y"]) expect(html, raw).not.toContain(raw);
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("&lt;b&gt;stg&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;prod&lt;/i&gt; &lt;u&gt;p&lt;/u&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;, &quot;&gt;&lt;img src=y&gt;");
  });

  it("a malformed result (an older Worker's three-key body) renders without throwing", () => {
    const old = { cloudflare: "not_configured", railway: "not_configured", sapling: "not_configured" } as unknown as RepoRefreshResult;
    const text = stripText(view({ poll: done(old) }));
    expect(text).toContain("Health — not configured");
    expect(text).toContain("GitHub — not configured");
  });

  it("a 409 is one line — another refresh holds the lock — still dismissible", () => {
    const html = view({ poll: { status: "busy" } });
    expect(html).toContain("A refresh is already running — try again in a minute.");
    expect(html).not.toContain("Poll failed");
    expect(html).toContain('data-act="repoPollDismiss"');
  });

  it("a failed request is one line, still dismissible, and the button is live again", () => {
    const html = view({ poll: { status: "error" } });
    expect(html).toContain("Poll failed — try again.");
    expect(html).toContain('data-act="repoPollDismiss"');
    expect(repoControls(props({ admin: true, poll: { status: "error" } }))).toMatch(/<button data-act="repoPollNow"(?![^>]* disabled)[^>]*>/);
  });

  it("render() hands the viewer's admin flag and the session-only poll state through — on any tab", () => {
    const base = { ...initialState(), view: "app" as const, screen: "repo" as const, repoTab: "code" as const, repo: { status: "ok" as const, data: live() } };
    const me = { handle: "andres", name: null, avatar_url: null, color: "green", identities: [], org: "SaplingLearn" };
    expect(render({ ...base, me: { ...me, admin: true } as typeof base.me })).toContain('data-act="repoPollNow"');
    expect(render({ ...base, me: { ...me, admin: false } as typeof base.me })).not.toContain("repoPollNow");
    expect(render({ ...base, me: { ...me, admin: true } as typeof base.me, repoPoll: { status: "error" } })).toContain("Poll failed — try again.");
    // A dashboard that failed its first load still offers the button.
    expect(render({ ...base, repo: { status: "error" as const, data: null, error: "x" }, me: { ...me, admin: true } as typeof base.me })).toContain('data-act="repoPollNow"');
  });
});

describe("helpers", () => {
  it("sparkPoints spans the box and survives a flat series", () => {
    expect(sparkPoints([1, 2, 3])).toBe("0.0,23.0 50.0,13.0 100.0,3.0");
    expect(sparkPoints([5, 5, 5])).not.toContain("NaN");
    expect(sparkPoints([1])).toBe("");
  });

  it("ago is the dense short form", () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    expect(ago("2026-09-20T11:59:50Z", now)).toBe("1m");
    expect(ago("2026-09-20T11:34:00Z", now)).toBe("26m");
    expect(ago("2026-09-20T09:00:00Z", now)).toBe("3h");
    expect(ago("2026-09-18T12:00:00Z", now)).toBe("2d");
    expect(ago("nope", now)).toBe("");
  });
});

describe("repo — the range selector is the shared segmented switch", () => {
  it("every range keeps its act (the picked one included); the picked one is pressed", () => {
    const html = repoView(props({ tab: "usage", range: "30d" }));
    expect(html).toContain('data-seg="repo-range"');
    expect(html).toContain('<button type="button" class="cnpy-seg-btn is-on" data-act="repoRange" data-arg="30d" aria-pressed="true">30d</button>');
    for (const r of ["24h", "7d"]) expect(html).toContain(`<button type="button" class="cnpy-seg-btn" data-act="repoRange" data-arg="${r}" aria-pressed="false">${r}</button>`);
    expect(html).not.toContain("repo-seg\"");
  });
});
