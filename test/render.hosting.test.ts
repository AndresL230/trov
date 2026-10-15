/**
 * Org settings › Hosting (web/src/hosting.ts) — pure render tests against the sample payloads
 * (web/src/hosting-sample.ts): every state the tab can be in, the three dialogs, the return notice for every
 * outcome, the confirmations — and that no render of the token form carries a credential's value.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
import hostingSrc from "../web/src/hosting.ts?raw";
import { orgSettingsView, orgOverlays, orgTabBar, initialOrgUi, orgTabsFor, effectiveOrgTab, orgConfirmCopy, orgDropdowns, type OrgUi } from "../web/src/org-settings";
import {
  hostingNoticeCopy, hostingTab, partEditorModal, connectModal, tokenModal, manageModal, partDraftProblems, fieldOptions, unavailableLines, connectionStatus, lostOnProvider,
  shownDetections, tokenWord, sentOnlyTo, connectionsFor, hostingTodo, tokenFormOk, initialHostingUi, HOSTING_SAMPLE_KEYS, HOSTING_STACK_KEYS, STACK_LABEL,
  HOSTING_ENVS_EMPTY, HOSTING_PARTS_EMPTY, partsListShape, partRowsShape, providerStatusOf, leftoversConfirmCopy,
  type HostingUi, type PartDraft, type TokenForm,
} from "../web/src/hosting";
import { neverReadLine } from "../web/src/repo-hosting";
import { hostingStatus, notConnectedSentence, orgConnection } from "@shared/hosting-status-core";
import { hostingErrorText } from "../web/src/hosting-actions";
import { OrgApiError } from "../web/src/api";
import { HOSTING_SAMPLES, HOSTING_SAMPLE_MIXED, HOSTING_SAMPLE_PROVIDERS, hostingScenario } from "../web/src/hosting-sample";
import { parseHash, hashForRoute } from "../web/src/hash";
import { render, initialState, type AppState } from "../web/src/render";
import { previewState } from "../web/src/preview";
import { HOSTING_CONNECT_OUTCOMES, type HostingProviderDTO, type HostingProviderId, type HostingSetupDTO } from "@shared/hosting";
import type { MyOrg, OrgRole } from "@shared/orgs";

const SECRET = "rnd_THIS_IS_THE_SECRET_VALUE_9z8y";
const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme Robotics", role });
const clone = <T>(v: T): T => structuredClone(v);

function uiFor(data: HostingSetupDTO | null, over: Partial<HostingUi> = {}, openRows: string[] = []): OrgUi {
  const ui = initialOrgUi();
  return { ...ui, tab: "hosting", slug: "acme", openRows, hosting: { ...initialHostingUi(), setup: data ? { status: "ok", data } : { status: "loading", data: null }, ...over } };
}
const tab = (data: HostingSetupDTO | null, over: Partial<HostingUi> = {}, openRows: string[] = [], role: OrgRole = "owner"): string =>
  hostingTab(org(role), uiFor(data, over, openRows));
const page = (ui: OrgUi, role: OrgRole = "owner"): string => orgSettingsView({ org: org(role), orgsStatus: "ok", me: "andres", ui });
const provider = (id: HostingProviderId): HostingProviderDTO => HOSTING_SAMPLE_PROVIDERS.find((p) => p.id === id)!;
/** The markup of one row (an <li>) that carries `marker`. */
const rowOf = (html: string, marker: string): string => {
  const at = html.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<li", at);
  const next = html.indexOf('<li class="cnpy-', at);
  return html.slice(start, next > -1 ? next : html.length);
};
/** The Manage dialog of one connection (`<provider>:<scope>`). */
const manage = (data: HostingSetupDTO, ck: string, over: Partial<HostingUi> = {}): string =>
  manageModal(data, { ...initialHostingUi(), setup: { status: "ok", data }, manage: ck, ...over });
const draft = (over: Partial<PartDraft> = {}): PartDraft => ({ env: "staging", key: null, keyDraft: "site", label: "", provider: "vercel", role: "web", settings: { project: "acme-site" }, saving: false, error: null, errorField: null, ...over });

describe("Hosting is an admin's tab of Org settings", () => {
  it("sits after Environments, at #org/hosting, for admins and owners only", () => {
    expect(orgTabsFor("owner")).toEqual(["integrations", "repos", "environments", "hosting", "members", "tags", "notifications", "general"]);
    expect(orgTabsFor("member")).not.toContain("hosting");
    expect(effectiveOrgTab("hosting", "member")).toBe("repos");
    expect(parseHash("#org/hosting")).toMatchObject({ screen: "org", orgTab: "hosting" });
    expect(hashForRoute({ ...parseHash("#org/hosting") })).toBe("#org/hosting");
    const html = page(uiFor(HOSTING_SAMPLE_MIXED));
    expect(html).toMatch(/id="org-tab-hosting"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="org-tab-hosting"/);
    expect(html).toContain('data-org-group="hosting-parts"');
    // A member who typed the address gets the first tab they may open, and none of Hosting.
    const member = page(uiFor(HOSTING_SAMPLE_MIXED), "member");
    expect(member).not.toContain("data-org-group=\"hosting-parts\"");
    expect(member).not.toContain('id="org-tab-hosting"');
  });

  it("the tab's badge counts connections that need an admin: an error, or one ended on the provider's side", () => {
    const bar = (d: HostingSetupDTO) => orgTabBar("hosting", "owner", uiFor(d));
    const badge = (html: string) => /id="org-tab-hosting"[\s\S]*?data-n="(\d+)"/.exec(html)?.[1];
    expect(hostingTodo(uiFor(HOSTING_SAMPLE_MIXED).hosting)).toBe(1);          // Render's 401
    expect(hostingTodo(uiFor(HOSTING_SAMPLES.revoked).hosting)).toBe(2);       // + Vercel removed on Vercel
    expect(hostingTodo(uiFor(HOSTING_SAMPLES.fresh).hosting)).toBe(0);
    expect(badge(bar(HOSTING_SAMPLES.revoked))).toBe("2");
    expect(badge(bar(HOSTING_SAMPLES.no_parts))).toBe("0");
  });

  it("loading is a skeleton, a failed read offers Try again — and both keep the return notice", () => {
    const loading = tab(null, { notice: { outcome: "connected", provider: "vercel" } });
    expect(loading).toContain("data-skel=");
    expect(loading).toContain('data-org-hosting-notice="connected"');
    const failed = hostingTab(org(), { ...uiFor(null), hosting: { ...initialHostingUi(), setup: { status: "error", data: null, error: "x" } } });
    expect(failed).toContain("Couldn't load hosting.");
    expect(failed).toContain('data-act="orgHxReload"');
    expect(failed).toContain("Preview with sample data");
  });

  it("the page is patched in place: Org settings is data-morph, and every dialog is a root-level data-overlay", () => {
    for (const marker of ['data-overlay="org-hx-part"', 'data-overlay="org-hx-connect"', 'data-overlay="org-hx-token"']) expect(hostingSrc).toContain(marker);
    expect(hostingSrc).not.toMatch(/<select|window\.confirm|●/);
  });
});

describe("empty layouts and the state preview (web-ui.md › Empty layouts)", () => {
  const picture = (shape: string) => {
    expect(shape.replace(/<[^>]*>/g, "").trim(), "text inside a shape").toBe("");
    expect(shape).not.toMatch(/<(button|a|input|svg)\b|data-act|var\(--(green|red|amber|blue|accent)\)/);
  };

  it("no environment: the Environments region is an empty layout — one sentence, one action, the tiles drawn empty", () => {
    const html = tab(HOSTING_SAMPLES.fresh);
    expect(html).toContain('data-empty="org-hosting-envs"');
    expect(html).toContain(HOSTING_ENVS_EMPTY);
    expect(html).toContain(`<div class="cnpy-empty-shapes" aria-hidden="true">${partsListShape()}</div>`);
    expect(html).toMatch(/class="cnpy-empty-acts"><button[^>]*data-act="orgTab" data-arg="environments"[^>]*>Open Environments</);
    picture(partsListShape());
  });

  it("an environment with no part: its rows drawn empty under one sentence, inside the tile (its Add part button is the action)", () => {
    const html = tab(HOSTING_SAMPLES.no_parts);
    for (const env of ["staging", "production"]) expect(html).toContain(`data-empty="org-hosting-parts-${env}"`);
    expect(html).toContain(`<p class="cnpy-empty-text">${HOSTING_PARTS_EMPTY}</p>`);
    expect(html).toContain(`<div class="cnpy-empty-shapes" aria-hidden="true">${partRowsShape(2)}</div>`);
    expect(html).toContain('class="cnpy-empty-say is-plain"');
    picture(partRowsShape(2));
    // An environment that HAS parts draws them, not a layout.
    expect(tab(HOSTING_SAMPLE_MIXED)).not.toContain("data-empty=");
  });

  it("the loading skeleton is built from the SAME shapes, so the two cannot drift — and it is a skeleton, not an empty layout", () => {
    const loading = tab(null);
    expect(loading).toMatch(/data-skel="org-hosting"/);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(partsListShape());
    expect(loading).not.toContain("data-empty=");
    expect(loading).not.toContain("cnpy-empty-shapes");
  });

  it("?preview=empty paints the tab as a new organization's, ?preview=loading as still out — whatever the organization holds, and without touching its state", () => {
    const base: AppState = {
      ...initialState(), view: "app", screen: "org", orgSlug: "acme",
      me: { handle: "andres", name: "Andres", avatar_url: null, color: "stone", identities: [], superadmin: false, pending_invites: 0, orgs: [{ slug: "acme", name: "Acme Robotics", role: "owner" }] } as never,
      orgMe: { status: "ok", data: { org: { slug: "acme", name: "Acme Robotics" }, role: "owner", title: null, responsibilities: null, repos: { primary: null, all: [] } } as never },
      myOrgs: { status: "ok", data: { orgs: [{ slug: "acme", name: "Acme Robotics", role: "owner" }], invites: [] } as never },
      org: uiFor(structuredClone(HOSTING_SAMPLE_MIXED), { part: draft(), notice: { outcome: "connected", provider: "vercel" } }),
    };
    const before = JSON.stringify(base.org.hosting);
    const real = render(base);
    expect(real).toContain('data-org-part="staging/web"');

    const empty = render({ ...base, preview: "empty" });
    expect(empty).toContain('data-empty="org-hosting-envs"');
    for (const mine of ["acme-web", "Web app", "Docs site", "data-org-part=", "data-org-hosting-notice", "org-hx-part", "srv-cn2k8h7c3k9s73a1b2c3", "Q2xk"]) expect(empty, mine).not.toContain(mine);
    // The catalogue is Trov's, not the organization's: it is still there to read.
    expect(empty).toContain('data-org-hosting-conn="vercel:" data-state="not_connected"');
    const loading = render({ ...base, preview: "loading" });
    expect(loading).toContain('data-skel="org-hosting"');
    for (const mine of ["acme-web", "data-org-part=", "data-empty=\"org-hosting"]) expect(loading, mine).not.toContain(mine);
    expect(JSON.stringify(base.org.hosting)).toBe(before);

    // Its own "Preview with sample data" keeps working under the preview, labelled as sample data.
    const sampled = previewState({ ...base, org: uiFor(null, { sample: "live", sampleData: HOSTING_SAMPLE_MIXED }) }, "empty", initialState());
    expect(sampled.org.hosting.sample).toBe("live");
    expect(render({ ...sampled })).toContain('data-org-hosting-sample="live"');
    // Nothing loaded yet and no catalogue to show: still an answered, empty read — never a crash.
    const cold = previewState({ ...base, org: uiFor(null) }, "empty", initialState());
    expect(cold.org.hosting.setup).toMatchObject({ status: "ok", data: { providers: [], environments: [], connections: [] } });
    expect(render(cold)).toContain('data-empty="org-hosting-envs"');
  });
});

describe("the tab, state by state (the sample payloads)", () => {
  it("a new org with no environment: the lead's one accent action goes to Environments, and nothing else is offered", () => {
    const html = tab(HOSTING_SAMPLES.fresh);
    expect(html).toContain("No environment yet.");
    expect(html).toContain(">No environments yet<");
    expect(html).toMatch(/class="cnpy-accentbtn"[^>]*>Add an environment</);
    expect((html.match(/class="cnpy-accentbtn"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-act="orgTab" data-arg="environments"/);
    expect(html).not.toContain("data-org-hosting-env=");
    // The catalogue is still there to read.
    expect(html).toContain('data-org-hosting-conn="vercel:"');
  });

  it("environments but no parts: an empty tile each, Add part, and the checklist's next step as the accent action", () => {
    const html = tab(HOSTING_SAMPLES.no_parts);
    expect((html.match(/data-org-hosting-env="/g) ?? []).length).toBe(2);
    expect((html.match(/data-hx-noparts/g) ?? []).length).toBe(2);
    expect(html).toContain("No parts yet. Add the web app, API or worker this environment runs.");
    expect(html).toContain('data-field="orgHxPartNew:staging"');
    expect(html).toMatch(/class="cnpy-accentbtn"[^>]*>Add a part</);
    expect((html.match(/class="cnpy-accentbtn"/g) ?? []).length).toBe(1);
    expect(html).toContain("1 of 3 done");
    expect(html).toContain("No parts yet in <strong>2</strong> environments");
  });

  it("a mixed org mid-setup: every part with its host, role, identity and connection — Cloudflare and Railway like the rest", () => {
    const html = tab(HOSTING_SAMPLE_MIXED);
    const parts = [...html.matchAll(/data-org-part="([^"]+)" data-provider="([^"]+)" data-connection="([^"]+)"/g)].map((m) => m.slice(1).join(" "));
    expect(parts).toEqual([
      "staging/frontend cloudflare connected", "staging/backend railway connected", "staging/web vercel connected", "staging/api render error",
      "production/web vercel connected", "production/api render error", "production/worker fly connected", "production/docs netlify not_connected",
    ]);
    const web = rowOf(html, 'data-org-part="staging/web"');
    expect(web).toContain(">Web app<");
    expect(web).not.toContain('data-hx-glyph="vercel"');                  // a part is the org's own: its tile, not the host's logo
    expect(web).toContain("Vercel &middot; acme-web");
    expect(web).toContain("Vercel &middot; acme-web");                     // the provider's FIRST setting
    expect(web).toContain('data-hx-status="connected"');
    expect(web).toMatch(/>Web<\/span>/);
    expect(web).toContain('data-act="orgHxPartEdit" data-arg="staging/web"');
    // A status is a mark (marks.ts: a shape in its kind's tone and the word), never a character or a chip.
    expect(web).toMatch(/data-hx-status="connected"[^>]*>.*var\(--green\).*Connected</);
    expect(rowOf(html, 'data-org-part="production/docs"')).toContain('data-hx-status="not_connected"');
    // Cloudflare's part is a part like any other: no fixed key, no pointer elsewhere.
    const frontend = rowOf(html, 'data-org-part="staging/frontend"');
    expect(frontend).toContain("Cloudflare Workers &middot; acme-web-staging");
    expect(frontend).not.toContain("data-hx-legacy");
    expect(frontend).not.toContain("hourly usage poll");
    expect(html).toContain("<strong>8</strong> parts in <strong>2</strong> environments");
    expect(html).toContain("1 with an error");
    expect(html).not.toMatch(/undefined|NaN|\[object/);
  });

  it("a part whose last poll failed says so under its row, always visible; one with unavailable metrics says why, calmly", () => {
    const html = tab(HOSTING_SAMPLE_MIXED);
    const api = rowOf(html, 'data-org-part="staging/api"');
    expect(api).toContain("data-hx-pollfail");
    expect(api).toContain("Last poll failed");
    expect(api).toContain("render deployments 401: Unauthorized — the credential is not valid");
    const web = rowOf(html, 'data-org-part="staging/web"');
    expect(web).not.toContain("data-hx-pollfail");
    expect(web).toContain("data-hx-unavailable");
    expect(web).toContain("Usage isn&#39;t available from Vercel: Vercel exposes no public usage API");
    // One metric of several: named, with the provider's reason — never a zero.
    expect(unavailableLines([{ metric: "latency_p50_ms", reason: "Trov reads Render's p95 latency only" }], "web", "Render")).toEqual(["Latency p50 isn't available from Render: Trov reads Render's p95 latency only."]);
    expect(unavailableLines([], "web", "Render")).toEqual([]);
  });

  it("opening a part shows its key, settings, last poll, Open in <provider> and Test this part — Remove is the part editor's", () => {
    const html = tab(HOSTING_SAMPLE_MIXED, {}, ["part:production/worker"]);
    const row = rowOf(html, 'data-org-part="production/worker"');
    expect(row).toContain('aria-expanded="true"');
    expect(row).toContain("App name: <code");
    expect(row).toContain(">acme-worker<");
    expect(row).toMatch(/href="https:\/\/fly\.io\/apps\/acme-worker" target="_blank" rel="noopener noreferrer"/);
    expect(row).toContain("Open in Fly.io");
    expect(row).toContain('data-act="orgHxTestPart" data-arg="production/worker"');
    // The list is read-only: Edit opens the part editor, which holds Remove part.
    expect(row).not.toContain("orgConfirm");
    expect(row).toMatch(/data-act="orgHxPartEdit" data-arg="production\/worker"/);
  });

  it("an environment at six parts cannot take a seventh", () => {
    const d = clone(HOSTING_SAMPLE_MIXED);
    const prod = d.environments[1];
    while (prod.parts.length < 6) prod.parts.push({ ...prod.parts[0], key: `extra${prod.parts.length}`, label: "Extra" });
    const html = tab(d);
    expect(html).toMatch(/data-field="orgHxPartNew:production" disabled[^>]*title="An environment has at most 6 parts"/);
    expect(html).not.toMatch(/data-field="orgHxPartNew:staging" disabled/);
  });
});

describe("providers and their connections", () => {
  it("lists the catalogue as ONE grid of cards (Cloudflare and Railway beside the rest, never a Legacy group); AWS as later", () => {
    const html = tab(HOSTING_SAMPLE_MIXED);
    const group = (key: string) => { const a = html.indexOf(`data-org-group="${key}"`); const b = html.indexOf("data-org-group=", a + 1); return html.slice(a, b > -1 ? b : html.length); };
    const conns = (part: string) => [...part.matchAll(/data-org-hosting-conn="([^"]+)" data-state="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(conns(group("hosting-providers"))).toEqual(["cloudflare: connected", "railway: connected", "vercel: connected", "render: error", "netlify: not_connected", "fly: connected"]);
    expect(group("hosting-providers")).toContain('<ul class="cnpy-hx-cards">');
    expect(html).not.toContain('data-org-group="hosting-legacy"');
    expect(html).not.toContain(">Legacy<");
    // Cards, not dropdowns: nothing on a provider opens in place.
    expect(group("hosting-providers")).not.toContain("orgRowToggle");
    expect(conns(group("hosting-later"))).toEqual(["aws: later"]);
    expect(group("hosting-later")).toContain("Coming later");
    const aws = rowOf(html, 'data-org-hosting-conn="aws:"');
    expect(aws.slice(0, aws.indexOf("</li>"))).not.toContain("<button");
    expect(html).toContain("5 of 6 connected");
    // On a new org every provider has a card to connect from — Railway's exactly like the others.
    const fresh = tab(HOSTING_SAMPLES.no_parts);
    for (const id of ["cloudflare", "railway", "vercel", "render", "netlify", "fly"]) expect(fresh).toContain(`data-org-hosting-conn="${id}:" data-state="not_connected"`);
    expect(rowOf(fresh, 'data-org-hosting-conn="railway:"')).toMatch(/data-act="orgHxConnect" data-arg="railway:"[^>]*>Connect</);
    expect(connectionsFor(HOSTING_SAMPLES.no_parts, provider("railway"))).toHaveLength(1);
  });

  it("a card shows what the host is and what Trov reads from it, without opening anything", () => {
    const html = tab(HOSTING_SAMPLES.no_parts);
    const netlify = rowOf(html, 'data-org-hosting-conn="netlify:"');
    expect(netlify).toContain('data-hx-glyph="netlify"');                     // the logo
    expect(netlify).toContain(provider("netlify").summary.slice(0, 40));
    expect(netlify).not.toContain("Netlify publishes no usage or analytics API"); // the plan note is the dialog's
    expect(manage(HOSTING_SAMPLES.no_parts, "netlify:")).toContain("Netlify publishes no usage or analytics API");
    expect(netlify).toContain("data-hx-caps");
    expect(netlify).not.toContain("cnpy-xrow");                             // no row to open
  });

  it("a connected card: how it is connected and who uses it, and ONE Manage button; the rest is in the Manage dialog", () => {
    const html = tab(HOSTING_SAMPLE_MIXED);
    const vercel = rowOf(html, 'data-org-hosting-conn="vercel:"');
    expect(vercel).toContain("Vercel <span");
    expect(vercel).toContain("&middot; Acme</span>");
    expect(vercel).toContain(">Connected<");
    // How it is connected, then what uses it — as plain metadata, by part and environment.
    expect(vercel).toMatch(/class="cnpy-hx-card-m">Installed &middot; [^<]+ in (Staging|Production)/);
    expect(vercel).toMatch(/data-act="orgHxManage" data-arg="vercel:"[^>]*>Manage</);
    expect(vercel).not.toContain("orgHxTest");
    expect(vercel).not.toContain("orgConfirm");
    const dlg = manage(HOSTING_SAMPLE_MIXED, "vercel:");
    expect(dlg).toContain('data-overlay="org-hx-manage"');
    expect(dlg).toContain('role="dialog"');
    expect(dlg).toContain('data-act="orgHxTest" data-arg="vercel:"');
    expect(dlg).toContain("Connected by andres");
    expect(dlg).toContain("Used by Staging › Web app and Production › Web app.");
    expect(dlg).toMatch(/href="https:\/\/vercel\.com\/acme\/~\/integrations"[^>]*>Manage on Vercel/);
    expect(dlg).toContain("Connect a different account");
    expect(dlg).toContain("Sent only to api.vercel.com.");
    expect(dlg).toContain("Projects: Read — on the projects you pick");
    expect(dlg).toMatch(/data-act="orgConfirm" data-arg="hosting:vercel:"[^>]*class="cnpy-org-danger"/);
    expect(dlg).not.toContain(">Rotate<");                                // an install has no token to rotate
    const fly = manage(HOSTING_SAMPLE_MIXED, "fly:");
    expect(fly).toContain("Read-only token &bull;&bull;&bull;&bull;Q2xk");     // only ever the last four
    expect(fly).toContain(">Rotate<");
    expect(fly).toContain("Organization slug: <code");
    expect(fly).toContain("Read-only access to one Fly.io organization");
    expect(fly).toContain("Sent only to api.machines.dev and api.fly.io.");
    expect(manage(HOSTING_SAMPLE_MIXED, "nope:")).toBe("");
  });

  it("a connection in error shows its last error on the card; a test's answer shows on the card and in the dialog", () => {
    const tests = { "render:": { status: "done", ok: false, detail: "render service 401: Unauthorized" }, "fly:": { status: "done", ok: true, detail: "Fly.io answered for app acme-worker (deployed)." }, "vercel:": { status: "running" } } as HostingUi["tests"];
    const html = tab(HOSTING_SAMPLE_MIXED, { tests });
    const render = rowOf(html, 'data-org-hosting-conn="render:"');
    expect(render).toContain(">Error<");
    expect(render).toContain("data-org-lasterror");
    expect(render).toContain("<strong style=\"font-weight:600;color:var(--fg)\">Last error.</strong> render deployments 401");
    expect(render).toMatch(/role="status"[^>]*data-org-test="failed"/);
    expect(render).toContain("Test failed.");
    expect(rowOf(html, 'data-org-hosting-conn="fly:"')).toMatch(/data-org-test="ok"[\s\S]*Connection works\.<\/strong> Fly\.io answered/);
    expect(manage(HOSTING_SAMPLE_MIXED, "vercel:", { tests })).toMatch(/data-act="orgHxTest"[^>]*disabled[^>]*aria-busy="true"[^>]*>Testing…</);
    expect(manage(HOSTING_SAMPLE_MIXED, "render:", { tests })).toContain("Test failed.");
  });

  it("not connected: Connect is the card's action — and the tab's ONE accent button is the checklist's next step", () => {
    const html = tab(HOSTING_SAMPLE_MIXED);
    const netlify = rowOf(html, 'data-org-hosting-conn="netlify:"');
    expect(netlify).toContain(">Not connected<");
    // No "Recommended" / "Paste a…" hint: how a host connects is the dialog's business.
    expect(netlify).not.toContain("Recommended");
    expect(netlify).not.toContain("Paste a");
    expect(netlify).toMatch(/data-act="orgHxConnect" data-arg="netlify:"[^>]*>Connect</);
    // Mixed: the next step is Connect Netlify — the lead's accent button; every other button is quiet.
    expect(html).toMatch(/class="cnpy-accentbtn"[^>]*>Connect Netlify</);
    expect((html.match(/class="cnpy-accentbtn"/g) ?? []).length).toBe(1);
  });

  it("a method this Trov cannot offer is said quietly in the token form Connect falls back to", () => {
    const d = clone(HOSTING_SAMPLES.no_parts);
    const v = d.providers.find((p) => p.id === "vercel")!;
    v.connection_methods[0] = { ...v.connection_methods[0], available: false, unavailable_reason: "this Trov deployment has no Vercel integration configured" };
    const row = rowOf(tab(d), 'data-org-hosting-conn="vercel:"');
    expect(row).toMatch(/data-act="orgHxConnect" data-arg="vercel:"[^>]*>Connect</);
    expect(row).not.toContain("data-hx-method-off");
    const form = tokenModal(d, { mode: "set", provider: "vercel", scope: "", hasValue: false, config: {}, saving: false, error: null, errorField: null } as TokenForm);
    expect(form).toContain("Connect with Vercel is not offered here: this Trov deployment has no Vercel integration configured.");
  });

  it("an installed connection folds its paste-a-token form into its Manage dialog as a quiet Manual connection", () => {
    const dlg = manage(HOSTING_SAMPLE_MIXED, "vercel:");
    expect(dlg).toContain('data-org-hosting-manual="vercel"');
    expect(dlg).toContain("Not needed while Vercel is connected");
    expect(dlg).toContain("Pasting one REPLACES the current connection.");
    expect(dlg).toContain('data-arg="rotate:vercel:"');
    // A token connection has no such fold.
    expect(manage(HOSTING_SAMPLE_MIXED, "render:")).not.toContain("data-org-hosting-manual");
    expect(manage(HOSTING_SAMPLE_MIXED, "fly:")).not.toContain("data-org-hosting-manual");
  });

  it("a connection the PROVIDER ended: an amber banner, a Removed mark, Connect again — never after an admin's own Disconnect", () => {
    const html = tab(HOSTING_SAMPLES.revoked);
    expect(html).toContain('data-org-hosting-lost="vercel"');
    expect(html).toContain("Vercel is no longer connected");
    expect(html).toContain("Deploys for Staging › Web app and Production › Web app have stopped updating. Connect again to resume.");
    const row = rowOf(html, 'data-org-hosting-conn="vercel:"');
    expect(row).toContain('data-state="revoked"');
    expect(row).toContain(">Removed<");
    expect(row).toContain("Removed on Vercel");
    expect(row).toContain(">Reconnect<");
    expect(html).toContain("1 removed on the provider");
    expect(html).toMatch(/class="cnpy-accentbtn"[^>]*>Connect Vercel</);      // the checklist's "Reconnect Vercel"
    // An admin's own Disconnect: not connected, no banner.
    const d = clone(HOSTING_SAMPLES.revoked);
    const c = d.connections.find((x) => x.provider === "vercel")!;
    c.revoked_reason = "Disconnected in Trov";
    expect(lostOnProvider(c, "Vercel")).toBe(false);
    expect(connectionStatus(c, "Vercel")).toMatchObject({ word: "Not connected", state: "not_connected" });
    const mine = tab(d);
    expect(mine).not.toContain("data-org-hosting-lost");
    expect(rowOf(mine, 'data-org-hosting-conn="vercel:"')).toContain("Disconnected in Trov");
  });

  it("credentials can't be saved: a banner, and every connect / rotate / paste is disabled with the reason — parts can still be edited", () => {
    const html = tab(HOSTING_SAMPLES.secrets_locked);
    expect(html).toContain("data-org-unavailable");
    expect(html).toContain("Credentials can&#39;t be saved right now");
    const netlify = rowOf(html, 'data-org-hosting-conn="netlify:"');
    expect(netlify).toMatch(/data-act="orgHxConnect"[^>]*disabled[^>]*title="Credentials can&#39;t be saved right now: the platform key is missing"/);
    const fly = manage(HOSTING_SAMPLES.secrets_locked, "fly:");
    expect(fly).toMatch(/data-arg="rotate:fly:"[^>]*disabled/);
    expect(fly).not.toMatch(/data-act="orgHxTest" data-arg="fly:"[^>]*disabled/);
    expect(html).toMatch(/class="cnpy-org-off"[^>]*>Connect Netlify</);       // the lead's action too
    expect(html).not.toMatch(/data-act="orgHxPartEdit"[^>]*disabled/);
    expect(html).not.toMatch(/data-act="orgHxManage"[^>]*disabled/);          // Manage (and Test) still open
  });

  it("a legacy fallback says the platform's old secret answers, and offers saving your own", () => {
    const d = clone(HOSTING_SAMPLE_MIXED);
    const cf = d.connections.find((c) => c.provider === "cloudflare")!;
    Object.assign(cf, { status: "not_connected", method: null, hint_last4: "", connected_by: null, connected_at: null, legacy_fallback: true });
    const row = rowOf(tab(d), 'data-org-hosting-conn="cloudflare:"');
    expect(row).toContain("data-org-legacy");
    expect(row).toContain("Using the platform's old secret. Save your own to take over.");
    expect(row).toContain(">Connected<");
    expect(row).toMatch(/data-act="orgHxManage" data-arg="cloudflare:"/);
    expect(manage(d, "cloudflare:")).toContain('data-arg="set:cloudflare:"');
  });

  it("the Manage dialog is drawn by the page's overlay, above the tab", () => {
    const ui = uiFor(HOSTING_SAMPLE_MIXED, { manage: "fly:" });
    expect(orgOverlays({ org: org(), orgsStatus: "ok", me: "andres", ui })).toContain('data-overlay="org-hx-manage"');
  });
});

describe("the setup checklist and the Detected suggestion", () => {
  it("lists what is left with a button each, folds what is done, and disappears once everything is", () => {
    const html = tab(HOSTING_SAMPLE_MIXED);
    expect(html).toContain("data-org-hosting-setup");
    expect(html).toContain("5 of 7 done");
    const steps = [...html.matchAll(/data-hx-step="([^"]+)" data-done="(\d)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(steps).toEqual(["connect:netlify 0", "test:render 0"]);
    expect(html).toContain("Show the 5 done");
    expect(html).toContain("Production › Docs site reads nothing until Netlify is connected.");
    expect(html).toMatch(/data-act="orgHxTest" data-arg="render:"[^>]*data-field="orgHxStep:list:test:render"/);
    expect((tab(HOSTING_SAMPLE_MIXED, { doneOpen: true }).match(/data-hx-step="/g) ?? []).length).toBe(7);
    const done = clone(HOSTING_SAMPLE_MIXED);
    for (const i of done.checklist) { i.done = true; i.action = { kind: "none" }; }
    const all = tab(done);
    expect(all).not.toContain("data-org-hosting-setup");
    expect(all).not.toContain('class="cnpy-accentbtn"');                       // nothing left to do: no accent action
  });

  it("Detected: <provider> — from captured GitHub activity, preselecting the provider; never for one in use, later, or dismissed", () => {
    const d = HOSTING_SAMPLES.no_parts;
    const html = tab(d);
    expect(html).toContain('data-org-hosting-detected="vercel"');
    expect(html).toContain("Detected: Vercel");
    expect(html).toContain("Trov saw GitHub check runs posted by the Vercel app on your repository");
    expect(html).toContain("Nothing is connected yet.");
    expect(html).toMatch(/data-act="orgHxPartNew" data-arg="staging\|vercel"[^>]*>Add a Vercel part</);
    expect(html).toContain('data-act="orgHxDetectDismiss" data-arg="vercel"');
    expect(tab(d, { dismissed: ["vercel"] })).not.toContain("data-org-hosting-detected");
    const used = clone(d);
    used.detected[0].in_use = true;
    expect(shownDetections(used, { dismissed: [] })).toEqual([]);
    const later = clone(d);
    later.detected = [{ provider: "aws", evidence: "x", last_seen: "2026-10-07T00:00:00Z", in_use: false }];
    expect(tab(later)).not.toContain("data-org-hosting-detected");
    // What GitHub called a check run is text from outside: escaped.
    const hostile = clone(d);
    hostile.detected[0].evidence = `a GitHub check run named "><img src=x onerror=1>`;
    const out = tab(hostile);
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x");
    // A payload from before the field existed draws nothing.
    const old = clone(d) as Partial<HostingSetupDTO>;
    delete old.detected;
    expect(tab(old as HostingSetupDTO)).not.toContain("data-org-hosting-detected");
  });
});

describe("where detection stands, for a new org", () => {
  it("says what Trov is doing until it finds a host — and the next step for each", () => {
    const say = (flow: (typeof HOSTING_SAMPLE_KEYS)[number], stack: (typeof HOSTING_STACK_KEYS)[number]) => tab(hostingScenario(flow, stack));
    const start = say("start", "vercel_render");
    expect(start).toContain('data-org-hosting-detection="no_repo"');
    expect(start).toContain("Trov can find your host for you");
    expect(start).toMatch(/data-act="orgTab" data-arg="repos"[^>]*>Connect a repository/);
    const looking = say("looking", "vercel_render");
    expect(looking).toContain('data-org-hosting-detection="looking"');
    expect(looking).toContain("Looking for your host on <code");
    expect(looking).toContain('data-act="syncToggle"');
    // A stack whose hosts post check runs is found; one whose hosts do not finds nothing, and says why.
    expect(say("found", "vercel_render")).toContain('data-org-hosting-detected="vercel"');
    expect(say("found", "vercel_render")).not.toContain("data-org-hosting-detection=");
    const none = say("found", "render_only");
    expect(none).toContain('data-org-hosting-detection="none"');
    expect(none).toContain("Render, Railway and Fly.io do not");
    // Once its parts use the host, the suggestion is gone and nothing else takes its place.
    expect(say("parts", "vercel_render")).not.toMatch(/data-org-hosting-detect(ed|ion)=/);
    // A repository with no environment: what to add first.
    const noEnv = hostingScenario("looking", "vercel_render");
    noEnv.detection = { state: "no_environment", repo: "acme/web", checked_at: null };
    expect(tab(noEnv)).toMatch(/data-act="orgTab" data-arg="environments"[^>]*>Add an environment/);
    // A payload from before the field existed shows no status line.
    const old = hostingScenario("looking", "vercel_render");
    delete old.detection;
    expect(tab(old)).not.toContain("data-org-hosting-detection");
  });
});

describe("the return from a provider (?hosting=<outcome>)", () => {
  it("every outcome has a title, a body that says what to do, and the right tone — and nothing from the provider", () => {
    const tones: Record<string, string> = {
      connected: "ok", expired: "amber", wrong_person: "red", not_admin: "red", denied: "amber", not_configured: "amber", exchange_failed: "red",
      secrets_unavailable: "red", taken: "red", unknown_provider: "red", failed: "red",
    };
    expect(Object.keys(tones).sort()).toEqual([...HOSTING_CONNECT_OUTCOMES].sort());
    for (const outcome of HOSTING_CONNECT_OUTCOMES) {
      const c = hostingNoticeCopy({ outcome, provider: "vercel" }, provider("vercel"), "Acme Robotics");
      expect(c.tone, outcome).toBe(tones[outcome]);
      expect(c.title.length, outcome).toBeGreaterThan(8);
      expect(c.body.length, outcome).toBeGreaterThan(20);
      const html = tab(HOSTING_SAMPLE_MIXED, { notice: { outcome, provider: "vercel" } });
      expect(html, outcome).toContain(`data-org-hosting-notice="${outcome}"`);
      expect(html, outcome).toMatch(new RegExp(`role="${c.tone === "red" ? "alert" : "status"}" data-org-hosting-notice="${outcome}"`));
      expect(html, outcome).toContain('data-act="orgHxNoticeClose"');
    }
    expect(hostingNoticeCopy({ outcome: "connected", provider: "vercel" }, provider("vercel"), "Acme").title).toBe("Vercel is connected.");
    expect(hostingNoticeCopy({ outcome: "connected", provider: "vercel" }, provider("vercel"), "Acme").body).toContain("reads the deploys of every part");
    expect(hostingNoticeCopy({ outcome: "denied", provider: "netlify" }, provider("netlify"), "Acme").title).toBe("You cancelled on Netlify.");
    expect(hostingNoticeCopy({ outcome: "not_configured", provider: "vercel" }, provider("vercel"), "Acme").body).toContain("Or connect with an access token instead.");
    // No provider named (the intent could not be read): still a sentence.
    expect(hostingNoticeCopy({ outcome: "expired", provider: null }, null, "Acme").body).toContain("the return from the host");
    expect(tab(HOSTING_SAMPLE_MIXED)).not.toContain("data-org-hosting-notice");
  });

  it("main.ts reads ?hosting= once on entering the org, opens the Hosting tab, and tells a non-admin in a toast", () => {
    expect(mainSrc).toContain('query.get("hosting")');
    expect(mainSrc).toContain("isHostingConnectOutcome(hostingOutcome)");
    expect(mainSrc).toContain('hash = "#org/hosting"');
    expect(mainSrc).toContain("only an admin or an owner of this organization can connect a host");
  });

  it("an org name is escaped in the notice", () => {
    const html = hostingTab({ slug: "acme", name: `<img src=x>`, role: "owner" }, uiFor(HOSTING_SAMPLE_MIXED, { notice: { outcome: "not_admin", provider: "vercel" } }));
    expect(html).not.toContain("<img src=x>");
  });
});

describe("the part editor", () => {
  const modal = (dr: PartDraft, d: HostingSetupDTO = HOSTING_SAMPLE_MIXED) => partEditorModal(d, dr, initialHostingUi());

  it("is a dialog with a labelled field for everything the provider needs, generated from its part settings", () => {
    const html = modal(draft());
    expect(html).toContain('data-overlay="org-hx-part"');
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="org-hx-part-t"/);
    expect(html).toContain("Add a part to Staging");
    expect(html).toContain('data-dd="org-hx-provider"');                      // the dropdown, never a native select
    expect(html).not.toContain("<select");
    expect(html).toContain('for="org-hx-key"');
    expect(html).toContain('for="org-hx-set-project"');
    expect(html).toContain('value="acme-site"');
    expect(html).toContain("The Vercel project&#39;s name, or its id");
    // What it can show, and the provider's own caveat.
    expect(html).toContain("data-hx-caps");
    expect(html).toContain(">Deploys<");
    expect(html).toContain("Vercel exposes no public usage API");
    // Vercel serves one role: stated, not a switch.
    expect(html).toContain("data-hx-role-fixed");
    expect(html).not.toContain('data-seg="org-hx-role"');
    expect(html).toMatch(/data-act="orgHxPartSave"[^>]*data-field="orgHxPartSave"[^>]*class="cnpy-accentbtn"|class="cnpy-accentbtn"[^>]*>Add part</);
  });

  it("a setting whose pattern is a short list of words is a segmented switch; a provider with two roles gets the Web / Service switch", () => {
    expect(fieldOptions(provider("vercel").part_settings.find((f) => f.key === "target")!)).toEqual(["production", "preview"]);
    expect(fieldOptions(provider("netlify").part_settings.find((f) => f.key === "context")!)).toEqual(["production", "branch"]);
    expect(fieldOptions(provider("vercel").part_settings.find((f) => f.key === "project")!)).toBeNull();
    const vercel = modal(draft({ settings: { project: "acme-site", target: "preview" } }));
    expect(vercel).toContain('data-seg="org-hx-set-target"');
    expect(vercel).toMatch(/class="cnpy-seg-btn is-on"[^>]*>Preview</);
    expect(vercel).toContain('data-act="orgHxPartPick" data-arg="target=production"');
    expect(modal(draft())).toMatch(/class="cnpy-seg-btn is-on"[^>]*>Production</);   // the default, shown as picked
    const render = modal(draft({ provider: "render", role: "service", settings: { service_id: "srv-cn2k8h7c3k9s73a1b2c3" }, keyDraft: "jobs" }));
    expect(render).toContain('data-seg="org-hx-role"');
    expect(render).toMatch(/class="cnpy-seg-btn is-on"[^>]*>Service</);
    expect(render).toContain('data-act="orgHxPartRole" data-arg="web"');
  });

  it("validates as the server will: the key, a free key, required settings, each setting's own pattern", () => {
    const d = HOSTING_SAMPLE_MIXED;
    expect(partDraftProblems(draft(), d)).toEqual({});
    expect(partDraftProblems(draft({ provider: null }), d)).toHaveProperty("provider");
    expect(partDraftProblems(draft({ keyDraft: "Web App" }), d).part).toBe("1 to 32 characters: a to z, 0 to 9, - or _.");
    expect(partDraftProblems(draft({ keyDraft: "web" }), d).part).toBe("Staging already has a part with this key.");
    expect(partDraftProblems(draft({ settings: {} }), d)).toHaveProperty(["settings.project"]);
    expect(partDraftProblems(draft({ settings: { project: "Not A Project!" } }), d)["settings.project"]).toContain("does not look like a Project");
    expect(partDraftProblems(draft({ provider: "render", settings: { service_id: "nope" } }), d)["settings.service_id"]).toContain("for example srv-");
    expect(partDraftProblems(draft({ label: "x".repeat(61) }), d).label).toBe("At most 60 characters.");
    expect(partDraftProblems(draft({ provider: "aws" }), d).provider).toBe("AWS is not supported yet.");
    // Cloudflare takes any free key, like every other host — a second Worker in the same environment is fine.
    expect(partDraftProblems(draft({ provider: "cloudflare", keyDraft: "edge", settings: { worker: "w" } }), d)).toEqual({});
    expect(partDraftProblems(draft({ provider: "cloudflare", keyDraft: "frontend", settings: { worker: "w" } }), d).part).toBe("Staging already has a part with this key.");
    const bad = modal(draft({ keyDraft: "web" }));
    expect(bad).toMatch(/id="org-hx-key-e" role="alert"[^>]*>Staging already has a part with this key\./);
    expect(bad).toMatch(/data-field="orgHxPartSave" disabled/);
  });

  it("editing: the key is permanent, Remove is there as text — for a Cloudflare part too, whose host and label can change", () => {
    const html = modal(draft({ key: "web", keyDraft: "web", label: "Web app", settings: { project: "acme-web", target: "preview", branch: "main" } }));
    expect(html).toContain("Edit Staging › Web app");
    expect(html).toMatch(/id="org-hx-key"[^>]*value="web"[^>]*disabled/);
    expect(html).toContain("A part's key is permanent.");
    expect(html).toContain("Save changes");
    expect(html).toMatch(/data-arg="part:staging\/web"[^>]*class="cnpy-org-danger"/);
    const legacy = modal(draft({ key: "frontend", keyDraft: "frontend", provider: "cloudflare", settings: { worker: "acme-web-staging" } }));
    expect(legacy).not.toMatch(/data-dd="org-hx-provider" disabled|id="org-hx-provider"[^>]*disabled/);
    expect(legacy).toMatch(/id="org-hx-key"[^>]*value="frontend"[^>]*disabled/);
    expect(legacy).not.toMatch(/id="org-hx-label"[^>]*disabled/);
  });

  it("a server refusal sits beside its field; one about the whole form is said once, above the buttons", () => {
    const beside = modal(draft({ error: "Project must be a project id or name.", errorField: "settings.project" }));
    expect(beside).toMatch(/id="org-hx-set-project-e" role="alert"[^>]*>Project must be a project id or name\./);
    const whole = modal(draft({ error: "This environment already has 6 parts, the most one can have. Remove one first.", errorField: null }));
    expect((whole.match(/This environment already has 6 parts/g) ?? []).length).toBe(1);
    expect(hostingErrorText(new OrgApiError(409, "too_many_parts", "an environment can have at most 6 parts", null), "x")).toContain("already has 6 parts");
    expect(hostingErrorText(new OrgApiError(409, "not_configured", "this Trov deployment has no Vercel integration configured — paste a token instead", null), "x")).toBe("This Trov deployment has no Vercel integration configured — paste a token instead.");
    expect(hostingErrorText(new Error("offline"), "Couldn't save the part.")).toBe("Couldn't save the part. Check your connection and try again.");
  });

  it("a provider that is not connected yet says so in the editor: save now, connect after — or both at once", () => {
    const html = modal(draft({ provider: "netlify", keyDraft: "docs2", settings: { site_id: "3f9a2c1e-7b4d-4e8a-9c2f-1d0e5a6b7c8d" } }));
    expect(html).toContain("data-hx-connect-hint");
    expect(html).toContain("Netlify is not connected yet.");
    expect(html).toContain('data-act="orgHxPartSave" data-arg="connect"');
    expect(modal(draft())).not.toContain("data-hx-connect-hint");            // Vercel is connected
    // Railway is connected once for the org, like every other host: the hint names no environment.
    const d2 = clone(HOSTING_SAMPLE_MIXED);
    d2.connections = d2.connections.filter((c) => c.provider !== "railway");
    const rw = partEditorModal(d2, draft({ env: "production", provider: "railway", keyDraft: "svc", settings: { environment_id: "e1", service_id: "s1" } }), initialHostingUi());
    expect(rw).toContain("Railway is not connected yet.");
    expect(rw).not.toContain("for Production");
  });

  it("a Detected provider says where the suggestion came from, and its menu is the screen's open dropdown", () => {
    const d = HOSTING_SAMPLES.no_parts;
    expect(modal(draft({ keyDraft: "web" }), d)).toContain("data-hx-detected-hint");
    const ui = uiFor(d, { part: draft({ keyDraft: "web" }) });
    const props = { org: org(), orgsStatus: "ok" as const, me: "andres", ui, dd: { open: "org-hx-provider", opening: false, closing: false } };
    expect(orgDropdowns(props).map((x) => x.id)).toEqual(["org-hx-provider"]);
    const overlays = orgOverlays(props);
    expect(overlays).toContain('data-dd-pop="org-hx-provider"');
    expect(overlays).toContain('data-overlay="org-hx-part"');
    for (const label of ["Cloudflare Workers", "Railway", "Vercel", "Render", "Netlify", "Fly.io"]) expect(overlays).toContain(`>${label}<`);
    expect(overlays).not.toMatch(/data-dd-opt[^>]*>[\s\S]{0,80}>AWS</);        // later: not choosable
  });
});

describe("connecting", () => {
  it("install / OAuth: before leaving Trov, what the provider will ask and where the credential goes", () => {
    const d = HOSTING_SAMPLE_MIXED;
    const netlify = connectModal(d, { provider: "netlify", busy: false, error: null });
    expect(netlify).toContain('data-overlay="org-hx-connect"');
    expect(netlify).toContain('data-method="oauth"');
    expect(netlify).toContain(">Connect with Netlify<");
    expect(netlify).toContain("Netlify will ask for");
    expect(netlify).toContain("Everything the approving Netlify account can do, across every team it belongs to — Netlify OAuth has no scopes");
    expect(netlify).toContain("Sent only to api.netlify.com.");
    expect(netlify).toContain("Continue to Netlify");
    expect(netlify).toContain("Paste a personal access token instead");
    expect(netlify).not.toContain("data-hx-replaces");
    // Already connected: it REPLACES the current account, and says which.
    const vercel = connectModal(d, { provider: "vercel", busy: false, error: null });
    expect(vercel).toContain("data-hx-replaces");
    expect(vercel).toContain("This replaces the connection to Acme.");
    expect(vercel).toContain("removed on Vercel");
    expect(vercel).not.toContain("instead</button>");
    const busy = connectModal(d, { provider: "netlify", busy: true, error: "Couldn't start the connection. Try again." });
    expect(busy).toMatch(/data-field="orgHxConnectGo" disabled[^>]*aria-busy="true"/);
    expect(busy).toContain('role="alert"');
    // A provider with no install has no such dialog.
    expect(connectModal(d, { provider: "aws", busy: false, error: null })).toBe("");
  });

  it("paste a token: where to get it, what it can do — said plainly — where it is sent, and never the value", () => {
    const form: TokenForm = { provider: "render", scope: "", mode: "set", config: {}, hasValue: true, saving: false, error: null, errorField: null };
    const html = tokenModal(HOSTING_SAMPLES.no_parts, form);
    expect(html).toContain('data-overlay="org-hx-token"');
    expect(html).toContain("Render: paste an API key");
    expect(html).toContain('for="org-hx-secret"');
    expect(html).toContain("Where to get it");
    expect(html).toContain("What this API key can do");
    expect(html).toContain("Render API keys have no scopes and no read-only mode");
    expect(html).toContain("Sent only to api.render.com.");
    expect(html).toContain("Trov never shows it again");
    expect(html).toContain("Save API key");
    // The password field carries no value, in any state.
    const input = /<input id="org-hx-secret"[^>]*>/.exec(html)![0];
    expect(input).toContain('type="password"');
    expect(input).toContain("data-hx-secret-input");
    expect(input).not.toMatch(/\svalue=/);
    expect(html).not.toContain(SECRET);
    expect(tokenWord(provider("fly"))).toBe("read-only token");
    expect(sentOnlyTo(provider("fly"))).toBe("Sent only to api.machines.dev and api.fly.io.");
  });

  it("required settings beside the token (Fly's organization, Cloudflare's account) gate the save; rotate asks for the value alone", () => {
    const fly = provider("fly");
    const set: TokenForm = { provider: "fly", scope: "", mode: "set", config: {}, hasValue: true, saving: false, error: null, errorField: null };
    expect(tokenFormOk(fly, set)).toBe(false);
    expect(tokenFormOk(fly, { ...set, config: { org_slug: "acme" } })).toBe(true);
    expect(tokenFormOk(fly, { ...set, config: { org_slug: "Not A Slug" } })).toBe(false);
    expect(tokenFormOk(fly, { ...set, config: { org_slug: "acme" }, hasValue: false })).toBe(false);
    expect(tokenFormOk(fly, { ...set, mode: "rotate" })).toBe(true);
    expect(tokenFormOk(fly, { ...set, mode: "config", hasValue: false, config: { org_slug: "acme" } })).toBe(true);
    const html = tokenModal(HOSTING_SAMPLE_MIXED, set);
    expect(html).toContain('for="org-hx-cfg-org_slug"');
    expect(html).toMatch(/data-field="orgHxTokenSave" disabled/);
    const rotate = tokenModal(HOSTING_SAMPLE_MIXED, { ...set, mode: "rotate" });
    expect(rotate).toContain("Rotate the Fly.io read-only token");
    expect(rotate).toContain("It replaces the current value (ends in Q2xk) the moment you save.");
    expect(rotate).not.toContain("org-hx-cfg-org_slug");
    const config = tokenModal(HOSTING_SAMPLE_MIXED, { ...set, mode: "config", hasValue: false, config: { org_slug: "acme" } });
    expect(config).toContain("Fly.io settings");
    expect(config).not.toContain("org-hx-secret\"");
    // Over an installed connection: it says the install is replaced.
    const over = tokenModal(HOSTING_SAMPLE_MIXED, { ...set, provider: "vercel", mode: "rotate" });
    expect(over).toContain("It replaces the installed integration the moment you save.");
    expect(over).toContain("Replace connection");
    expect(tokenModal(HOSTING_SAMPLE_MIXED, { ...set, provider: "railway", scope: "", mode: "rotate" })).toMatch(/Rotate the Railway [a-z ]+token/);
    const refused = tokenModal(HOSTING_SAMPLE_MIXED, { ...set, config: { org_slug: "acme" }, error: "The value is not a Fly.io token.", errorField: "secret" });
    expect(refused).toMatch(/id="org-hx-secret-e" role="alert"[^>]*>The value is not a Fly\.io token\./);
  });

  it("the open dialog is one of Org settings' overlays — only on the Hosting tab, only for an admin", () => {
    const form: TokenForm = { provider: "render", scope: "", mode: "rotate", config: {}, hasValue: false, saving: false, error: null, errorField: null };
    const ui = uiFor(HOSTING_SAMPLE_MIXED, { token: form });
    expect(orgOverlays({ org: org(), orgsStatus: "ok", me: "andres", ui })).toContain('data-overlay="org-hx-token"');
    expect(orgOverlays({ org: org("member"), orgsStatus: "ok", me: "andres", ui })).not.toContain("org-hx-token");
    expect(orgOverlays({ org: org(), orgsStatus: "ok", me: "andres", ui: { ...ui, tab: "members" } })).not.toContain("org-hx-token");
  });
});

describe("confirmations go through the shared modal", () => {
  it("Disconnect names what stops and what happens on the provider's side", () => {
    const ui = uiFor(HOSTING_SAMPLE_MIXED);
    const vercel = orgConfirmCopy({ what: "hosting", arg: "vercel:", busy: false }, org(), ui)!;
    expect(vercel.title).toBe("Disconnect Vercel from Acme Robotics?");
    expect(vercel.body).toContain("Deploys of Staging › Web app and Production › Web app stop updating.");
    expect(vercel.body).toContain("Trov also asks Vercel to remove its integration.");
    expect(vercel.confirmLabel).toBe("Disconnect");
    const render = orgConfirmCopy({ what: "hosting", arg: "render:", busy: false }, org(), ui)!;
    expect(render.body).toContain("Deploys and usage of Staging › API and Production › API stop updating.");
    expect(render.body).toContain("The stored API key is erased here; delete it on Render too if you no longer need it.");
    expect(orgConfirmCopy({ what: "hosting", arg: "railway:", busy: false }, org(), ui)!.title).toBe("Disconnect Railway from Acme Robotics?");
    expect(orgConfirmCopy({ what: "hosting", arg: "nope:", busy: false }, org(), ui)).toBeNull();
    const html = orgOverlays({ org: org(), orgsStatus: "ok", me: "andres", ui: { ...ui, confirm: { what: "hosting", arg: "vercel:", busy: false } } });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('data-confirm-act="orgConfirmGo"');
  });

  it("Remove a part says what goes with it — the same words for every host", () => {
    const ui = uiFor(HOSTING_SAMPLE_MIXED);
    const web = orgConfirmCopy({ what: "part", arg: "staging/web", busy: false }, org(), ui)!;
    expect(web.title).toBe("Remove Staging › Web app?");
    expect(web.body).toBe("Its deploy history and poll state go with it; past figures stay until they age out.");
    expect(web.confirmLabel).toBe("Remove part");
    expect(orgConfirmCopy({ what: "part", arg: "staging/frontend", busy: false }, org(), ui)!.body).toBe("Its deploy history and poll state go with it; past figures stay until they age out.");
    expect(orgConfirmCopy({ what: "part", arg: "staging/nope", busy: false }, org(), ui)).toBeNull();
    // The modal takes the place of the editor it was opened from (one dialog at a time).
    const both = orgOverlays({ org: org(), orgsStatus: "ok", me: "andres", ui: { ...uiFor(HOSTING_SAMPLE_MIXED, { part: draft({ key: "web", keyDraft: "web" }) }), confirm: { what: "part", arg: "staging/web", busy: false } } });
    expect(both).toContain('role="alertdialog"');
    expect(both).not.toContain('data-overlay="org-hx-part"');
  });
});

describe("Preview with sample data", () => {
  it("every flow × stack renders, labelled as sample data, with both switchers and the way back", () => {
    for (const flow of HOSTING_SAMPLE_KEYS) {
      for (const stack of HOSTING_STACK_KEYS) {
        const at = `${flow} × ${stack}`;
        const html = tab(null, { sample: flow, sampleStack: stack, sampleData: hostingScenario(flow, stack) });
        expect(html, at).toContain(`data-org-hosting-sample="${flow}"`);
        expect(html, at).toContain("Sample data");
        expect(html, at).toContain('data-seg="org-hx-sample"');
        expect(html, at).toMatch(new RegExp(`id="org-hx-sample-stack"[\\s\\S]*?${STACK_LABEL[stack].replace(/[.+]/g, "\\$&")}`));
        expect(html, at).toContain('data-act="orgHxSample" data-arg="off"');
        expect(html, at).toContain('data-org-group="hosting-providers"');
        expect(html, at).not.toMatch(/undefined|NaN|\[object/);
        expect(html, at).not.toContain("Preview with sample data");
      }
    }
    expect(tab(null, { sample: "live", sampleData: null })).toContain("data-skel=");   // the chunk is still loading
    expect(tab(HOSTING_SAMPLE_MIXED)).toContain('data-act="orgHxSample" data-arg="start"');
    // The sample is a dynamic import: it must never be in the main bundle.
    expect(hostingSrc).not.toMatch(/from "\.\/hosting-sample"/);
    expect(mainSrc).not.toContain("hosting-sample");
  });
});

describe("house rules", () => {
  it("everything a provider or an admin wrote is escaped", () => {
    const hostile = `"><img src=x onerror=1>`;
    const d = clone(HOSTING_SAMPLE_MIXED);
    d.environments[0].label = hostile;
    d.environments[0].branch = hostile;
    const p = d.environments[0].parts[2];
    Object.assign(p, { label: hostile, settings: { project: hostile }, updated_by: hostile, last_poll: { ...p.last_poll!, status: "failed", detail: hostile, unavailable: [{ metric: "requests", reason: hostile }] } });
    const c = d.connections.find((x) => x.provider === "render")!;
    Object.assign(c, { last_error: hostile, connected_by: hostile, account: { id: hostile, label: hostile }, hint_last4: hostile, config: { owner_id: hostile } });
    for (const i of d.checklist) { i.title = hostile; i.detail = hostile; }
    const html = tab(d, { doneOpen: true, tests: { "render:": { status: "done", ok: false, detail: hostile } } }, ["part:staging/web", "hx:render:"]);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/"><(script|img)/);
    expect(html).toContain("&lt;img src=x");
  });

  it("a link out is https only — a console or manage URL that is not is simply not offered", () => {
    const d = clone(HOSTING_SAMPLE_MIXED);
    d.environments[1].parts[2].console_url = "javascript:alert(1)";
    d.connections.find((c) => c.provider === "render")!.manage_url = "javascript:alert(1)";
    const html = tab(d, {}, ["part:production/worker", "hx:render:"]);
    expect(html).not.toContain("javascript:");
    expect(rowOf(html, 'data-org-part="production/worker"')).not.toContain("Open in Fly.io");
  });

  it("no button sits inside a button, and the new CSS declares no radius of its own", () => {
    const html = tab(HOSTING_SAMPLE_MIXED, { doneOpen: true }, ["part:staging/web", "hx:vercel:", "hx-manual:vercel:"]);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    const block = css.slice(css.indexOf("/* Org settings › Hosting"), css.indexOf(".cnpy-org-how {"));
    expect(block).toContain(".cnpy-hx-envhead");
    expect(block).not.toContain("border-radius");
    expect(block).not.toMatch(/animation|transition/);                        // nothing here moves
  });
});

describe("ONE status, everywhere (repo-setups Phase 0)", () => {
  const available = HOSTING_SAMPLE_PROVIDERS.filter((p) => p.status === "available");
  const cardState = (html: string, id: HostingProviderId): string | null => new RegExp(`data-org-hosting-conn="${id}:" data-state="([a-z_]+)"`).exec(html)?.[1] ?? null;

  // GUARD 2: for every Flow × Stack the sample preview can show, the provider's card, every part row on it, the
  // payload's own part status, the checklist and Test this part say the SAME thing — THE status function's.
  it.each(HOSTING_SAMPLE_KEYS.flatMap((f) => HOSTING_STACK_KEYS.map((st) => [f, st] as const)))("%s × %s: the card, the part rows, the checklist and Test this part agree", (flow, stack) => {
    const d = hostingScenario(flow, stack);
    const html = tab(d);
    for (const p of available) {
      const st = hostingStatus(orgConnection(d.connections, p.id), p.label);
      expect(providerStatusOf(d, p.id), p.id).toEqual(st);
      // ONE card per provider, whatever else is stored.
      expect((html.match(new RegExp(`data-org-hosting-conn="${p.id}:`, "g")) ?? []).length, `${p.id} cards`).toBe(1);
      expect(cardState(html, p.id), `${p.id} card`).toBe(st.state);
      const users = d.environments.flatMap((e) => e.parts.filter((x) => x.provider === p.id));
      for (const part of users) {
        expect(part.connection, `${part.env}/${part.key} payload`).toBe(st.state);
        expect(html, `${part.env}/${part.key} row`).toContain(`data-org-part="${part.env}/${part.key}" data-provider="${p.id}" data-connection="${st.state}"`);
        // Test this part: not live → the card's own words and its Connect; live → never that answer.
        const tested = tab(d, { tests: { [`part:${part.env}/${part.key}`]: { status: "done", ok: false, detail: notConnectedSentence(p.label) } } });
        const row = rowOf(tested, `data-org-part="${part.env}/${part.key}"`);
        if (st.live) expect(row, `${part.env}/${part.key} test`).not.toContain('data-org-test="not_connected"');
        else {
          expect(row, `${part.env}/${part.key} test`).toContain('data-org-test="not_connected"');
          expect(row).toContain(`${p.label} isn&#39;t connected.`);
          expect(row).toMatch(new RegExp(`data-act="orgHxConnect" data-arg="${p.id}:"`));
          expect(row).not.toContain("No secret");
        }
      }
      // The checklist: a provider a part uses has its connect step, done exactly when the card says it is live.
      if (users.length) {
        const step = d.checklist.find((i) => i.id === `connect:${p.id}` || i.id === `connect:${p.id}:`);
        expect(step, `${p.id} checklist`).toBeDefined();
        expect(step!.done, `${p.id} checklist`).toBe(st.live);
      }
    }
  });

  it("Leftover tokens: Railway's card says Not connected with ONE quiet line, its Manage holds Remove old tokens, and the lead counts no leftover", () => {
    const d = hostingScenario("leftovers", "cloudflare_railway");
    const html = tab(d);
    const card = rowOf(html, 'data-org-hosting-conn="railway:"');
    expect(card).toContain('data-state="not_connected"');
    expect(card).toContain(">Not connected<");
    expect(card).not.toContain(">Connected<");
    expect(card).toContain("2 old per-environment tokens from before Oct 15 aren&#39;t used. Connect Railway once with a workspace token.");
    expect(card).toContain("Backend in Staging and Production");
    expect(card).toMatch(/data-act="orgHxManage" data-arg="railway:"[^>]*>Review old tokens</);
    expect(html).not.toContain('data-org-hosting-conn="railway:staging"');
    // The lead: Cloudflare works, Railway does not — the two old tokens are not connections.
    expect(html).toContain("<strong>1 of 2</strong> connections working");
    const dlg = manage(d, "railway:");
    expect(dlg).toContain("Project token (no longer used) &middot; Staging &middot; &bull;&bull;&bull;&bull;5024");
    expect(dlg).toContain("Project token (no longer used) &middot; Production &middot; &bull;&bull;&bull;&bull;51b1");
    expect(dlg).toMatch(/data-act="orgConfirm" data-arg="leftovers:railway"[^>]*class="cnpy-org-danger"[^>]*>Remove old tokens</);
    expect(dlg).toMatch(/data-act="orgHxConnect" data-arg="railway:"[^>]*>Connect Railway</);
    expect(leftoversConfirmCopy(d, "railway")).toMatchObject({ title: "Remove 2 old Railway tokens?", confirmLabel: "Remove old tokens" });
    // …through the page's confirmation modal.
    expect(orgConfirmCopy({ what: "leftovers", arg: "railway", busy: false }, org(), uiFor(d))).toMatchObject({ title: "Remove 2 old Railway tokens?" });
    // Connected once for the org: Connected, and the line keeps only the count.
    const live = clone(d);
    const rw = live.connections.find((c) => c.provider === "railway")!;
    Object.assign(rw, { status: "connected", method: "token", hint_last4: "c71e", connected_by: "andres", connected_at: "2026-10-15T09:00:00.000Z" });
    const liveCard = rowOf(tab(live), 'data-org-hosting-conn="railway:"');
    expect(liveCard).toContain('data-state="connected"');
    expect(liveCard).toContain("2 old per-environment tokens from before Oct 15 aren&#39;t used.");
    expect(liveCard).not.toContain("Connect Railway once");
    expect(liveCard).toContain("Workspace token &bull;&bull;&bull;&bull;c71e");
  });

  // GUARD 1 (the screen's half; the server's is test/hosting.leftovers.test.ts): a payload from before this fix —
  // scoped Railway rows among the connections — still draws ONE Railway card, from the org-wide row, never Connected.
  it("an old payload with scoped connection rows still draws one card per provider, and never counts them", () => {
    const d = clone(hostingScenario("parts", "cloudflare_railway"));
    const rw = d.connections.find((c) => c.provider === "railway")!;
    for (const scope of ["staging", "production"]) d.connections.push({ ...rw, scope, scope_label: scope, status: "connected", method: "token", hint_last4: scope === "staging" ? "5024" : "51b1" });
    const html = tab(d);
    expect((html.match(/data-org-hosting-conn="railway:/g) ?? []).length).toBe(1);
    expect(cardState(html, "railway")).toBe("not_connected");
    expect(html).not.toContain("5024");
    expect(html).toContain("<strong>0 of 2</strong> connections working");
    for (const e of d.environments) expect(html).toContain(`data-org-part="${e.key}/backend" data-provider="railway" data-connection="not_connected"`);
  });

  it("the Repo dashboard's never-read copy follows the same status", () => {
    expect(neverReadLine({ provider_label: "Railway", connection: "not_connected" })).toContain("Railway isn&#39;t connected.");
    expect(neverReadLine({ provider_label: "Railway", connection: "connected" })).toContain("Connected, not read yet");
    expect(neverReadLine({ provider_label: "Railway", connection: "connected" })).not.toContain("isn&#39;t connected");
    expect(neverReadLine({ provider_label: "Railway" })).toContain("Not connected: nothing has been read from Railway");
  });
});

describe("the app metrics token lives in the part editor (it left Integrations)", () => {
  const live = () => clone(hostingScenario("live", "cloudflare_railway"));
  const editor = (d: HostingSetupDTO, env: string, key: string, over: Partial<PartDraft> = {}, h: Partial<HostingUi> = {}) => {
    const part = d.environments.find((e) => e.key === env)!.parts.find((p) => p.key === key)!;
    return partEditorModal(d, draft({ env, key, keyDraft: key, label: part.label, provider: part.provider, role: part.role, settings: { ...part.settings }, ...over }), { ...initialHostingUi(), setup: { status: "ok", data: d }, ...h });
  };

  it("set: its last four, when it was last used, Test token and Delete token — and the input never carries a value", () => {
    const html = editor(live(), "production", "backend", { metricsHasValue: true });
    expect(html).toContain('data-hx-metrics="production" data-state="set"');
    expect(html).toContain("ends in 7f3c");
    expect(html).toContain("https://api.acme.dev/api/internal/metrics");
    expect(html).toContain("every part of Production shares it");
    expect(html).toMatch(/data-act="orgHxMetricsTest" data-arg="production"/);
    expect(html).toMatch(/data-act="orgHxMetricsDelete" data-arg="production"[^>]*class="cnpy-org-danger"/);
    const input = /<input id="org-hx-metrics"[^>]*>/.exec(html)![0];
    expect(input).toContain('type="password"');
    expect(input).not.toMatch(/\svalue=/);
    expect(input).toContain('placeholder="Paste a new token to replace it"');
  });

  it("not set: an optional field saved with the part; a failed save is shown at the field; locked while secrets can't be saved", () => {
    const d = live();
    const html = editor(d, "staging", "backend");
    expect(html).toContain('data-hx-metrics="staging" data-state="unset"');
    expect(html).toContain(">Not set<");
    expect(html).not.toContain("orgHxMetricsDelete");
    expect(editor(d, "staging", "backend", { error: "The token must be at least 16 characters.", errorField: "metrics" })).toContain('id="org-hx-metrics-e"');
    const locked = { ...d, secrets_available: false };
    expect(/<input id="org-hx-metrics"[^>]*>/.exec(editor(locked, "staging", "backend"))![0]).toContain(" disabled");
    // An environment with no API URL says where to set one.
    d.environments[0].app_metrics = { ...d.environments[0].app_metrics!, api_url: null };
    expect(editor(d, "staging", "backend")).toContain("does not have yet: set it in Environments");
  });

  it("a payload from before the field existed shows no block (never a guess)", () => {
    const d = live();
    delete d.environments[1].app_metrics;
    expect(editor(d, "production", "backend")).not.toContain("data-hx-metrics");
  });

  it("an app metrics token that failed its last use counts on Hosting's badge", () => {
    const d = live();
    d.environments[1].app_metrics = { ...d.environments[1].app_metrics!, last_error: "metrics endpoint: HTTP 401" };
    expect(hostingTodo(uiFor(d).hosting)).toBe(1);
    expect(editor(d, "production", "backend")).toContain("metrics endpoint: HTTP 401");
  });
});
