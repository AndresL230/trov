/**
 * Repo dashboard › Usage › Hosting (web/src/repo-hosting.ts) — pure render tests against the sample's
 * `providers` section (web/src/repo-sample.ts): every part, whoever hosts it, with deploys, traffic per range,
 * resources, tone — and a figure the payload does not carry shown as "—" with its reason, never 0.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { repoView, type RepoProps } from "../web/src/repo";
import { repoSample } from "../web/src/repo-sample";
import { absentHint, compactNumber, duration, errorRateTone, formatBytes, formatMemory, gapPath } from "../web/src/repo-hosting";
import type { RepoDashboard, RepoRange } from "@shared/repo";
import type { ProviderDeployDTO, RepoProviderPart } from "@shared/hosting";

const sample = (): RepoDashboard => ({ ...repoSample(), sample: undefined }) as RepoDashboard;
const partsOf = (d: RepoDashboard): RepoProviderPart[] => (d.providers as { status: "ok"; data: RepoProviderPart[] }).data;
function props(over: Partial<RepoProps> = {}): RepoProps {
  return { tab: "usage", range: "7d", driftOpen: false, repo: { status: "ok", data: sample() }, fetchedAt: Date.now(), sample: false, admin: false, poll: null, productEnv: null, ...over };
}
const withParts = (parts: RepoProviderPart[], over: Partial<RepoProps> = {}): string =>
  repoView(props({ repo: { status: "ok", data: { ...sample(), providers: { status: "ok", data: parts } } }, ...over }));
/** The markup of one part's card. */
const card = (html: string, ref: string): string => {
  const a = html.indexOf(`data-hpart="${ref}"`);
  expect(a, ref).toBeGreaterThan(-1);
  const b = html.indexOf("</article>", a);
  return html.slice(html.lastIndexOf("<article", a), b);
};
const fig = (cardHtml: string, key: string): string => {
  const a = cardHtml.indexOf(`data-hfig="${key}"`);
  expect(a, key).toBeGreaterThan(-1);
  const b = cardHtml.indexOf("data-hfig=", a + 10);
  return cardHtml.slice(a, b > -1 ? b : cardHtml.length);
};
const find = (ref: string): RepoProviderPart => { const [env, part] = ref.split("/"); return structuredClone(partsOf(sample()).find((p) => p.env === env && p.part === part)!); };

describe("Usage › Hosting — the section", () => {
  it("replaces the Cloudflare and Railway blocks with ONE section: every part, grouped by environment, in the payload's order", () => {
    const html = repoView(props());
    expect(html).toContain("data-usage-hosting");
    expect(html).toContain('data-hosting="ok"');
    expect(html).not.toContain("Cloudflare — frontend Workers");
    expect(html).not.toContain("Hosting — Railway backend");
    expect([...html.matchAll(/data-henv="([^"]+)"/g)].map((m) => m[1])).toEqual(["staging", "production"]);
    const refs = [...html.matchAll(/data-hpart="([^"]+)" data-provider="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(refs).toEqual(partsOf(sample()).map((p) => `${p.env}/${p.part} ${p.provider}`));
    expect(new Set(refs.map((r) => r.split(" ")[1]))).toEqual(new Set(["cloudflare", "railway", "vercel", "render", "netlify", "fly"]));
    expect(html).toContain(`${partsOf(sample()).length} parts &middot; polled every hour`);
    expect(html).not.toMatch(/undefined|NaN|\[object/);
    expect(html.slice(html.indexOf("data-usage-hosting"))).not.toContain("<table");
  });

  it("not connected is one quiet line — with the way to Org settings › Hosting for an admin — and empty says the parts are waiting", () => {
    const nc = (admin: boolean) => repoView(props({ admin, repo: { status: "ok", data: { ...sample(), providers: { status: "not_connected" } } } }));
    expect(nc(false)).toContain('data-hosting="not_connected"');
    expect(nc(false)).toContain("No hosting provider is connected. An admin adds your environments' parts in Org settings &rsaquo; Hosting.");
    expect(nc(false)).not.toContain('data-arg="hosting"');
    expect(nc(true)).toMatch(/Add your environments' parts in <button type="button" data-act="orgGo" data-arg="hosting"/);
    expect(nc(true)).not.toContain("Source not connected");
    const empty = repoView(props({ repo: { status: "ok", data: { ...sample(), providers: { status: "empty" } } } }));
    expect(empty).toContain("Parts are set up, but no provider has reported yet.");
    // A payload from before the section existed has no key at all: the same quiet line, never a crash.
    const old = { ...sample() } as Partial<RepoDashboard>;
    delete old.providers;
    expect(repoView(props({ repo: { status: "ok", data: old as RepoDashboard } }))).toContain('data-hosting="not_connected"');
  });

  it("loading is a skeleton in the section's own place; a failed read offers Retry", () => {
    const loading = repoView(props({ repo: { status: "loading", data: null } }));
    expect(loading.slice(loading.indexOf("data-usage-hosting"))).toContain('data-skel="repo-');
    const failed = repoView(props({ repo: { status: "error", data: null } }));
    expect(failed.slice(failed.indexOf("data-usage-hosting"))).toContain("Couldn't load this section");
  });

  it("sample mode draws the same section from the sample set, with no link that writes", () => {
    const html = repoView(props({ sample: true, admin: true, repo: { status: "ok", data: repoSample() } }));
    expect(html).toContain("sample data");
    expect(html).toContain('data-hosting="ok"');
    expect(html).not.toContain('data-arg="hosting"');
  });
});

describe("a part's card", () => {
  it("heads with a tone dot (an element), the label, the provider's glyph and name, the role, and Open in <provider>", () => {
    const html = repoView(props());
    const cf = card(html, "staging/frontend");
    expect(cf).toMatch(/data-htone="warn" title="needs a look" style="[^"]*border-radius:50%;background:var\(--amber\)"/);
    expect(cf).toContain(">Frontend<");
    expect(cf).toContain("Cloudflare Workers");
    expect(cf).toContain(">WEB<");
    expect(cf).toMatch(/href="https:\/\/dash\.cloudflare\.com\/[^"]+" target="_blank" rel="noopener noreferrer"[^>]*>Open in Cloudflare Workers</);
    expect(card(html, "staging/backend")).toContain(">SERVICE<");
    expect(card(html, "staging/backend")).not.toContain("Open in Railway");     // no console link in the payload: none drawn
    expect(card(html, "production/frontend")).toMatch(/data-htone="good"[^>]*background:var\(--green\)/);
    expect(html).not.toContain("●");
  });

  it("the last deploy line: state pill, short sha, branch, first line of the message, who, when, how long, links", () => {
    const now = Date.now();
    const d: ProviderDeployDTO = {
      id: "dpl_1", state: "ready", target: "production", sha: "9b04e7f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7", branch: "main",
      message: "sse: re-send bearer on reconnect\n\nlonger body", by: "jose-a", at: new Date(now - 2 * 3600_000).toISOString(),
      ready_at: new Date(now - 2 * 3600_000 + 102_000).toISOString(), url: "https://acme.vercel.app", inspect_url: "https://vercel.com/acme/web/1",
    };
    const part = { ...find("staging/web"), deploys: [d, { ...d, id: "dpl_0", state: "error" as const, at: new Date(now - 5 * 3600_000).toISOString() }] };
    const c = card(withParts([part]), "staging/web");
    expect(c).toContain('data-hdeploy="ready"');
    expect(c).toContain(">READY<");
    expect(c).toContain(">9b04e7f<");
    expect(c).not.toContain("9b04e7f1c2");
    expect(c).toContain(">main<");
    expect(c).toContain(">sse: re-send bearer on reconnect<");
    expect(c).not.toContain("longer body");
    expect(c).toContain("by jose-a");
    expect(c).toContain("2h ago");
    expect(c).toContain("ready in 1m 42s");
    expect(c).toMatch(/href="https:\/\/acme\.vercel\.app"[^>]*>Open</);
    expect(c).toMatch(/href="https:\/\/vercel\.com\/acme\/web\/1"[^>]*>Log</);
    expect(duration("2026-10-07T10:00:00Z", "2026-10-07T10:01:42Z")).toBe("1m 42s");
    expect(duration("2026-10-07T10:00:00Z", null)).toBeNull();
    expect(duration("2026-10-07T10:00:00Z", "2026-10-07T09:00:00Z")).toBeNull();
  });

  it("a release with no commit (Fly.io) still reads as a line; a building deploy pulses; a link that is not https is not drawn", () => {
    const html = repoView(props());
    const fly = card(html, "staging/edge");
    expect(fly).toContain('data-hdeploy="ready"');
    expect(fly).not.toContain("<code");                                       // no sha to show
    expect(fly).toContain("by kenji@acme.example");
    const building = card(html, "staging/web");
    expect(building).toContain('data-hdeploy="building"');
    expect(building).toMatch(/class="repo-envdot repo-pulse"[^>]*style="--c:var\(--blue\)/);
    expect(building).toContain(">BUILDING<");
    const part = find("staging/edge");
    part.deploys[0] = { ...part.deploys[0], url: "javascript:alert(1)", inspect_url: "http://insecure.example" };
    part.console_url = "javascript:alert(1)";
    const c = card(withParts([part]), "staging/edge");
    expect(c).not.toContain("javascript:");
    expect(c).not.toContain("insecure.example");
  });

  it("the strip: the last deploys as dots, oldest left and newest right — landed green, failed red, canceled hollow, in flight pulsing", () => {
    const c = card(repoView(props()), "staging/web");
    const dots = [...c.matchAll(/data-hdot="([a-z]+)"/g)].map((m) => m[1]);
    expect(dots).toEqual(["ready", "canceled", "ready", "error", "ready", "building"]);
    expect(c).toMatch(/class="repo-dot repo-envdot repo-pulse" data-hdot="building"/);
    expect(c).toMatch(/data-hdot="canceled" style="[^"]*background:transparent;border:1\.5px solid var\(--fg-40\)/);
    expect(c).toMatch(/data-hdot="error" style="[^"]*background:var\(--red\)/);
    expect((c.match(/role="tooltip"/g) ?? []).length).toBe(6);
    expect(c).toMatch(/aria-label="[0-9a-f]{7} failed \d+h ago by kenji-m"/);
    // One deploy is a line, not a strip.
    const one = find("staging/web");
    one.deploys = one.deploys.slice(0, 1);
    expect(card(withParts([one]), "staging/web")).not.toContain("data-hdots");
  });

  it("a web part's traffic follows the range switch: requests, error rate, p95 latency, bandwidth and a sparkline with error ticks", () => {
    const view = (range: RepoRange) => card(repoView(props({ range })), "staging/edge");
    const day = view("24h");
    expect(day).toContain('class="repo-swap" data-htraffic="24h"');
    expect(fig(day, "requests")).toMatch(/data-count="8900" data-count-fmt="compact">8\.9K</);
    expect(fig(day, "error_rate")).toContain(">0.07%<");
    expect(fig(day, "latency_p95_ms")).toMatch(/>41<\/span><span[^>]*>ms</);
    expect(fig(day, "bandwidth_bytes")).toContain(">1.84 GB<");
    expect(day).toContain('data-hspark="traffic"');
    expect(day).toMatch(/<line [^>]*stroke="var\(--red\)"/);
    expect(fig(view("7d"), "requests")).toContain(">61.3K<");
    expect(fig(view("30d"), "requests")).toContain(">248.0K<");
    expect(fig(view("30d"), "bandwidth_bytes")).toContain(">51.20 GB<");
    // Amber from 1 %, red from 5 %; a healthy rate keeps the text colour.
    const cf = card(repoView(props({ range: "24h" })), "staging/frontend");
    expect(fig(cf, "error_rate")).toMatch(/color:var\(--amber\)"><span>2\.41%</);
    expect(fig(day, "error_rate")).not.toMatch(/color:var\(--(amber|red)\)/);
    expect([errorRateTone(0.99), errorRateTone(1), errorRateTone(4.99), errorRateTone(5)]).toEqual(["good", "warn", "warn", "bad"]);
  });

  it("NEVER a zero for the unknown: a null figure is — with its reason, and the three reasons are different", () => {
    // Cloudflare reads no latency or bandwidth, and says nothing about why: it has reported before → no recent reading.
    const cf = card(repoView(props({ range: "24h" })), "staging/frontend");
    for (const key of ["latency_p95_ms", "bandwidth_bytes"]) {
      const f = fig(cf, key);
      expect(f, key).toContain('data-absent="1"');
      expect(f, key).toContain("&mdash;");
      expect(f, key).toContain("no recent reading");
      expect(f, key).not.toMatch(/>0[<.]/);
    }
    // The provider cannot read it: its own reason.
    const part = find("staging/edge");
    part.traffic!["7d"] = { ...part.traffic!["7d"], latency_p95_ms: null };
    part.unavailable = [{ metric: "latency_p95_ms", reason: "Fly's edge histogram was not readable" }];
    expect(fig(card(withParts([part]), "staging/edge"), "latency_p95_ms")).toContain("not available from Fly.io: Fly&#39;s edge histogram was not readable");
    // Never reported at all: not connected.
    const never = find("staging/edge");
    never.seen = { ...never.seen, traffic: false };
    never.unavailable = [];
    never.traffic!["7d"] = { requests: null, errors: null, error_rate: null, latency_p95_ms: null, bandwidth_bytes: null, trend: [] };
    const c = card(withParts([never]), "staging/edge");
    expect((c.match(/not connected/g) ?? []).length).toBe(4);
    expect(c).not.toContain('data-hspark="traffic"');                          // no line for readings that do not exist
    expect(c).not.toMatch(/data-count=/);
    // Requests are live but the range holds none to take a rate of: a dash that says so, not "not connected".
    const quiet = find("staging/edge");
    quiet.traffic!["7d"] = { ...quiet.traffic!["7d"], requests: 0, errors: 0, error_rate: null, trend: [] };
    const q = card(withParts([quiet]), "staging/edge");
    expect(fig(q, "requests")).toMatch(/>0</);                                 // a real, covered zero IS a zero
    expect(fig(q, "error_rate")).toContain("no request in this range");
    expect(absentHint({ unavailable: [], provider_label: "X" }, "cpu", true)).toBe("no recent reading");
    expect(absentHint({ unavailable: [], provider_label: "X" }, "cpu", false)).toBe("not connected");
    expect(absentHint({ unavailable: [{ metric: "cpu", reason: "static sites have none" }], provider_label: "Render" }, "cpu", true)).toBe("not available from Render: static sites have none");
  });

  it("a provider that reads no usage at all (Vercel, Netlify): deploys, then ONE calm line with the reason — no empty grid", () => {
    const html = repoView(props());
    for (const ref of ["staging/web", "production/docs"]) {
      const c = card(html, ref);
      expect(c, ref).toContain('data-htraffic="unavailable"');
      expect(c, ref).toMatch(/Usage isn&#39;t available from (Vercel|Netlify): /);
      expect(c, ref).not.toContain("data-hfig=");
      expect(c, ref).not.toContain('data-hspark="traffic"');
      expect(c, ref).toContain("data-hdeploy=");
    }
  });

  it("a service part's resources are right now — CPU in vCPU, memory in MB or GB — with a 24-hour line that keeps its gaps", () => {
    const html = repoView(props({ range: "24h" }));
    const api = card(html, "staging/api");
    expect(api).toContain("data-hresources");
    expect(fig(api, "cpu")).toMatch(/>0\.31<\/span><span[^>]*>vCPU</);
    expect(fig(api, "mem_mb")).toContain(">742 MB<");
    expect(card(html, "production/backend")).toContain(">1.20 GB<");
    expect(api).toContain('data-hspark="cpu"');
    expect(api).toContain('data-hspark="mem_mb"');
    // The range switch does not touch resources: nothing there cross-fades.
    expect(api).not.toContain("repo-swap");
    const month = card(repoView(props({ range: "30d" })), "staging/api");
    expect(fig(month, "cpu")).toMatch(/>0\.31<\/span>/);
    expect(fig(month, "mem_mb")).toContain(">742 MB<");
    // A missing hour is a GAP in the path (a new M), never a point at zero.
    const d = /data-hspark="cpu"[\s\S]*?<path d="([^"]+)"/.exec(api)![1];
    expect((d.match(/M/g) ?? []).length).toBe(2);
    const pts = (hours: (number | null)[]) => hours.map((v, i) => ({ at: new Date(Date.UTC(2026, 9, 7, i)).toISOString(), v }));
    expect((gapPath(pts([1, 2, 3, 4])).match(/M/g) ?? []).length).toBe(1);
    expect((gapPath(pts([1, 2, null, 4, 5])).match(/M/g) ?? []).length).toBe(2);
    expect(gapPath(pts([1, null, 3])).match(/h0\.8/g)).toHaveLength(2);           // lone points are dashes
    expect(gapPath(pts([null, null]))).toBe("");
    // Stale: the latest reading is over three hours old — a dash that says so, and no line.
    const stale = find("staging/api");
    stale.resources = { cpu: null, mem_mb: null, at: null, trend: stale.resources!.trend };
    const s = card(withParts([stale]), "staging/api");
    expect(fig(s, "cpu")).toContain("no recent reading");
    expect(fig(s, "mem_mb")).toContain("&mdash;");
    expect(s).not.toContain("data-hspark=");
  });

  it("a failed last poll is a small amber note with the provider's reason; an empty part and a never-polled one say which they are", () => {
    const html = repoView(props());
    const failed = partsOf(sample()).find((p) => p.last_poll?.status === "failed")!;
    const c = card(html, `${failed.env}/${failed.part}`);
    expect(c).toMatch(/data-hpollfail role="status"[^>]*var\(--amber\)/);
    expect(c).toContain("Last poll failed");
    expect(c).toContain(failed.last_poll!.detail!.replace(/'/g, "&#39;"));
    const empty = partsOf(sample()).find((p) => p.status === "empty")!;
    expect(card(html, `${empty.env}/${empty.part}`)).toContain('data-hstate="empty"');
    const never = { ...find("staging/api"), status: "not_connected" as const, deploys: [], resources: null, last_poll: null, seen: { traffic: false, resources: false, deploys: false } };
    const n = card(withParts([never]), "staging/api");
    expect(n).toContain('data-hstate="not_connected"');
    expect(n).toContain("Not connected: nothing has been read from Render for this part yet.");
    expect(n).not.toContain("data-hfig=");
  });
});

describe("figures and motion", () => {
  it("formats without inventing: compact counts, decimal bytes, MB to GB at 1024", () => {
    expect([compactNumber(0), compactNumber(999), compactNumber(12_400), compactNumber(1_240_000), compactNumber(2_500_000_000)]).toEqual(["0", "999", "12.4K", "1.24M", "2.50B"]);
    expect([formatBytes(512), formatBytes(1_500), formatBytes(2_400_000), formatBytes(1_840_000_000), formatBytes(3e12)]).toEqual(["512 B", "1.5 KB", "2.4 MB", "1.84 GB", "3.00 TB"]);
    expect([formatMemory(410), formatMemory(1023.6), formatMemory(1229)]).toEqual(["410 MB", "1024 MB", "1.20 GB"]);
  });

  it("uses the dashboard's own motion hooks, all of them off under prefers-reduced-motion; its CSS adds no radius and no animation", () => {
    const html = repoView(props({ range: "24h" }));
    const section = html.slice(html.indexOf("data-usage-hosting"));
    expect(section).toContain('class="repo-swap"');       // what the range switch cross-fades
    expect(section).toContain("data-count=");             // figures count up
    expect(section).toContain('class="repo-spark"');      // sparklines wipe in
    expect(section).toContain('class="repo-dot');         // deploy dots pop
    expect(section).not.toMatch(/animation:|transition:|@keyframes/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.repo-pulse[^}]*animation:none !important/);
    const block = css.slice(css.indexOf("/* Usage › Hosting"), css.indexOf("/* Usage › Hosting") + 1200);
    expect(block).toContain(".repo-hfigs");
    expect(block.slice(0, block.indexOf("}\n", block.indexOf("@container")) + 1)).not.toMatch(/border-radius|animation|transition/);
  });
});
