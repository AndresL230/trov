/**
 * Org settings › Repositories › a repo › Apps (web/src/repo-apps.ts) — pure render tests, one per screen of the
 * design's OrgSetup (suggestions, an app, the deploy-signal picker, unassigned names, Add an app, the Remove
 * confirmation), the routes, and THE picker guard: it never offers a deploy name that was not seen in 30 days.
 */
import { describe, it, expect } from "vitest";
import mainSrc from "../web/src/main.ts?raw";
import appsSrc from "../web/src/repo-apps.ts?raw";
import actionsSrc from "../web/src/repo-apps-actions.ts?raw";
import { orgSettingsView, orgOverlays, orgConfirmCopy, orgDropdowns, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import {
  repoAppsPage, signalDropdown, releaseOptions, targetsLine, keyForSignal, appHost, initialRepoAppsUi, draftOf, appRemoveCopy, settingsForPick,
  type RepoAppsUi, type SetupApp,
} from "../web/src/repo-apps";
import { dropdownMenu, initialDropdownUi } from "../web/src/dropdown";
import { parseHash, hashForRoute, type OrgRepoRoute } from "../web/src/hash";
import { pickableSignals, signalKey, unassignedSignals } from "@shared/repo-apps-setup-core";
import type { AppSuggestionDTO, RepoAppsSetupDTO, SeenSignal } from "@shared/repo-scan-core";
import type { EnvironmentPartDTO, HostingProviderId } from "@shared/hosting";
import type { MyOrg, OrgRole } from "@shared/orgs";

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme", role });
const REPO = "acme/storefront";

const sig = (kind: SeenSignal["kind"], name: string, provider: HostingProviderId | null, count: number, min: number, source: string | null = null): SeenSignal =>
  ({ kind, name, provider, count, lastAt: ago(min), source });
const SIGNALS: SeenSignal[] = [
  sig("deployment", "Production – storefront-api", "render", 14, 25),
  sig("deployment", "Preview – storefront-api", "render", 37, 60),
  sig("check", "Render – api", "render", 51, 25, "render"),
  sig("deployment", "Production – storefront-admin", "vercel", 8, 2 * 24 * 60),
  sig("status", "Vercel", "vercel", 9, 90),
  sig("workflow", "eas-build.yml", null, 52, 300, ".github/workflows/eas-build.yml"),
];
const part = (env: string, key: string, provider: HostingProviderId, settings: Record<string, string>, connection: EnvironmentPartDTO["connection"] = "connected"): EnvironmentPartDTO =>
  ({ env, key, label: key, role: "service", provider, settings, position: 0, connection, console_url: null, last_poll: null, updated_at: null, updated_by: null });
const app = (key: string, kind: SetupApp["kind"], folder: string, parts: EnvironmentPartDTO[] = [], source: SetupApp["source"] = "suggested"): SetupApp =>
  ({ key, repo: REPO, label: key, folder, kind, watch: [`${folder}/**`], releaseSignal: null, source, position: 0, parts });
const suggestion = (key: string, kind: AppSuggestionDTO["kind"], folder: string, provider: HostingProviderId | null, evidence: string[], usedBy: string[] = []): AppSuggestionDTO =>
  ({ id: `s-${key}`, key, folder, kind, provider, evidence: evidence.map((text) => ({ kind: "file", text })), parts: [], signals: [], usedBy, state: "pending" });

function setup(over: Partial<RepoAppsSetupDTO> = {}): RepoAppsSetupDTO {
  return {
    repo: REPO,
    apps: [
      app("web", "Site", "apps/web", [part("production", "web", "vercel", { project: "storefront-web" })]),
      app("api", "Service", "apps/api", [part("production", "api", "github", { environment: "Production – storefront-api" })]),
      app("ui", "Package", "packages/ui"),
    ],
    suggestions: [
      suggestion("docs", "Site", "apps/docs", "cloudflare", ["from apps/docs/wrangler.toml", "GitHub deployment “docs (Production)” seen 22 times"]),
      suggestion("jobs", "Job", "apps/jobs", "fly", ["from apps/jobs/fly.toml"]),
      suggestion("kit", "Package", "packages/kit", null, ["from packages/kit/package.json · used by apps/web and apps/docs"], ["web", "docs"]),
    ],
    unassigned: [SIGNALS[3]],
    signals: SIGNALS,
    scan: { treeSha: "abc", scannedAt: ago(3), looked: ["vercel.json", "fly.toml"], error: null },
    tags: { count: 0, latest: null },
    environments: [{ key: "staging", label: "Staging", branch: "develop" }, { key: "production", label: "Production", branch: "main" }],
    providers: [
      { id: "cloudflare", label: "Cloudflare Workers", via_github: false }, { id: "vercel", label: "Vercel", via_github: false },
      { id: "render", label: "Render", via_github: false }, { id: "fly", label: "Fly.io", via_github: false }, { id: "github", label: "GitHub deployments", via_github: true },
    ],
    ...over,
  };
}

const appsUi = (d: RepoAppsSetupDTO | null, over: Partial<RepoAppsUi> = {}): RepoAppsUi =>
  ({ ...initialRepoAppsUi(), repo: REPO, setup: d ? { status: "ok", data: d } : { status: "loading", data: null }, ...over });
const route = (view: OrgRepoRoute["view"], key?: string): OrgRepoRoute => ({ repo: REPO, view, ...(key ? { app: key } : {}) });
const uiOf = (r: OrgRepoRoute, apps: RepoAppsUi): OrgUi => ({ ...initialOrgUi(), tab: "repos", slug: "acme", repoPage: r, apps });
const page = (r: OrgRepoRoute, apps: RepoAppsUi, role: OrgRole = "owner"): string => orgSettingsView({ org: org(role), orgsStatus: "ok", me: "andres", ui: uiOf(r, apps) });
/** The page's words, tags and entities out. */
const text = (html: string): string => html.replace(/<[^>]*>/g, "").replace(/&middot;/g, "·").replace(/\s+/g, " ");
const noButtonInButton = (html: string) => expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);

describe("the routes", () => {
  it("#org/repos/<owner>/<name>[/apps/<key>|/new] round-trip, on the Repositories tab", () => {
    for (const [hash, want] of [
      ["#org/repos/acme/storefront", route("apps")],
      ["#org/repos/acme/storefront/apps/api", route("app", "api")],
      ["#org/repos/acme/storefront/new", route("new")],
    ] as const) {
      const r = parseHash(hash);
      expect(r).toMatchObject({ screen: "org", orgTab: "repos", orgRepo: want });
      expect(hashForRoute(r)).toBe(hash);
    }
    // Junk stays junk: a bad owner, a bad key, an unknown sub-page.
    expect(parseHash("#org/repos/acme/storefront/apps/Not%20A%20Key").screen).toBe("mywork");
    expect(parseHash("#org/repos/a%2Fb/c").screen).toBe("mywork");
    expect(parseHash("#org/repos/acme/storefront/settings").screen).toBe("mywork");
    expect(hashForRoute(parseHash("#org/repos"))).toBe("#org/repos");
  });

  it("a member never gets the page: Repositories shows the list", () => {
    const html = page(route("apps"), appsUi(setup()), "member");
    expect(html).not.toContain("data-apps-crumb");
  });
});

describe("Setup 1 · suggestions", () => {
  it("each suggestion: a blue ring 'Suggested', folder, kind, host or 'no host', its evidence; Ignore / Accept by id; Accept all; Scan again", () => {
    const html = page(route("apps"), appsUi(setup()));
    expect(text(html)).toContain("3 apps · Trov found 3 more in this repo. Nothing changes until you accept them.");
    const docs = html.slice(html.indexOf('data-apps-suggestion="s-docs"'), html.indexOf('data-apps-suggestion="s-jobs"'));
    expect(docs).toMatch(/color:var\(--blue\)[\s\S]*Suggested/);
    expect(docs).toContain('data-mtip="Suggested by the scan, not accepted.');
    expect(docs).toContain(">apps/docs<");
    expect(docs).toContain("Site · Cloudflare Workers");
    expect(docs).toContain("from apps/docs/wrangler.toml");
    expect(docs).toContain("GitHub deployment “docs (Production)” seen 22 times");
    expect(docs).toContain('data-act="orgAppsAccept" data-arg="s-docs"');
    expect(docs).toContain('data-act="orgAppsIgnore" data-arg="s-docs"');
    expect(html).toContain("Package · no host");
    expect(html).toMatch(/data-act="orgAppsAcceptAll"[^>]*>Accept all 3</);
    expect(html).toMatch(/data-act="orgAppsScan"[^>]*>Scan again</);
    expect(html).toContain("scanned 3m ago · from config files and deploys seen in 30 days");
    // Never a pill: no uppercase transform on a mark, no bordered tinted chip.
    expect(docs).not.toMatch(/text-transform:uppercase[^"]*">Suggested/);
    noButtonInButton(html);
  });

  it("Scanning… while the scan runs; Accept all off with nothing pending; a suggestion in flight cannot be pressed twice", () => {
    expect(page(route("apps"), appsUi(setup(), { scanning: true }))).toMatch(/data-act="orgAppsScan"[^>]*disabled[^>]*>Scanning…</);
    const none = page(route("apps"), appsUi(setup({ suggestions: [] })));
    expect(none).toMatch(/data-act="orgAppsAcceptAll"[^>]*disabled/);
    expect(none).toContain("Trov found nothing more in this repo.");
    expect(none).toContain("Nothing to suggest. Trov looked for vercel.json and fly.toml");
    const busy = page(route("apps"), appsUi(setup(), { busy: ["s-docs"] }));
    expect(busy).toMatch(/data-act="orgAppsAccept" data-arg="s-docs"[^>]*disabled[^>]*>Working…</);
  });

  it("the accepted apps: name, folder, kind, host and a targets line; a row opens the app", () => {
    const d = setup();
    const html = page(route("apps"), appsUi(d));
    expect(html).toContain('data-act="orgAppsGo" data-arg="app:web"');
    expect(targetsLine(d, d.apps[0])).toBe("Production from main");
    expect(targetsLine(d, d.apps[2])).toBe("No targets · ships inside the apps that use it");
    expect(targetsLine({ ...d, suggestions: [{ ...d.suggestions[2], key: "ui" }] }, d.apps[2])).toBe("No targets · ships inside web and docs");
    expect(appHost(d, d.apps[0])).toBe("Vercel");
    expect(appHost(d, d.apps[2])).toBe("no host");
    expect(html).toContain("Service · GitHub deployments");
  });

  it("loading is a skeleton, a failed read offers Try again — never a crash; a degraded read says so", () => {
    expect(page(route("apps"), appsUi(null))).toContain("data-skel=");
    expect(page(route("apps"), { ...appsUi(null), setup: { status: "error", data: null } })).toContain('data-act="orgAppsReload"');
    expect(page(route("apps"), appsUi(setup({ degraded: true })))).toContain("data-apps-degraded");
    // Null-safe: a payload with no catalogue words, no environments, no tags still draws.
    const bare = setup({ environments: undefined, providers: undefined, tags: undefined as never });
    expect(page(route("app", "api"), appsUi(bare))).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe("Setup 4 · unassigned deploy names", () => {
  it("lists a name no app reads, where it came from and how often — with Make an app, prefilled", () => {
    const html = page(route("apps"), appsUi(setup()));
    const row = html.slice(html.indexOf("data-apps-unassigned="));
    expect(row).toContain(">Production – storefront-admin<");
    expect(row).toContain("Vercel deployment");
    expect(row).toContain("seen 8 times · last 2d ago");
    expect(row).toContain(`data-act="orgAppsGo" data-arg="new:${signalKey(SIGNALS[3])}"`);
    expect(html).toContain("1 deploy name belongs to no app");
    expect(keyForSignal(SIGNALS[3])).toBe("storefront-admin");
    expect(keyForSignal(sig("deployment", "api / production", "railway", 1, 1))).toBe("api");
    expect(keyForSignal(sig("deployment", "main - express-hello", "render", 1, 1))).toBe("express-hello");
    expect(keyForSignal(sig("deployment", "docs (Production)", null, 1, 1))).toBe("docs");
  });

  it("the shared rule: deploy names only, minus what a github part or a pending suggestion already names", () => {
    const un = unassignedSignals(SIGNALS, [{ environment: "Production – storefront-api" }], [{ state: "pending", signals: [SIGNALS[1]] }]);
    // A host's own check run is a deploy name too; a pending suggestion's signal and a part's are not.
    expect(un.map((s) => s.name)).toEqual(["Render – api", "Production – storefront-admin", "Vercel"]);
  });
});

describe("Setup 2 · an app's page", () => {
  it("name, kind as a segmented switch, folder, watch paths as a list, Save and Remove app", () => {
    const html = page(route("app", "api"), appsUi(setup()));
    expect(text(html)).toContain("api ships from apps/api to 1 target. Changes apply on save; the Repo screen redraws from them.");
    expect(html).toContain('data-seg="org-apps-kind"');
    expect(html).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true"[^>]*>Service</);
    expect(html).toContain('id="org-apps-folder"');
    expect(html).toContain('data-apps-watch="apps/api/**"');
    expect(html).toContain('data-act="orgAppsWatchAdd"');
    expect(html).toMatch(/data-act="orgAppsSave"[^>]*>Save</);
    expect(html).toContain('data-act="orgConfirm" data-arg="app:api"');
    expect(html).toContain("Repositories</button>");
    expect(html).toMatch(/aria-current="page"[^>]*>api</);
    expect(html).not.toMatch(/<select|window\.confirm|●/);
    noButtonInButton(html);
  });

  it("a target on a host is Hosting's own part row (handed in), a github target picks its signal, an empty one offers Add part with the app key", () => {
    const d = setup();
    const r = route("app", "web");
    const html = repoAppsPage(r, appsUi(d), initialDropdownUi(), (env, key) => `<li class="cnpy-xrow" data-org-part="${env}/${key}">HOSTING ROW</li>`);
    expect(html).toContain('data-org-part="production/web">HOSTING ROW');
    // Staging has no part of web: the picker ("Not tracked" first) and Add part, prefilled with the app key.
    expect(html).toContain('data-arg="staging||web"');
    expect(html).toContain('data-act="orgHxPartNew"');
    const api = repoAppsPage(route("app", "api"), appsUi(d), initialDropdownUi(), () => "");
    expect(api).toContain('data-apps-signal="production"');
    expect(api).toContain('data-act="orgHxPartEdit" data-arg="production/api"');
    // A Package has no targets: it says why, and offers how a release shows up instead.
    const ui = repoAppsPage(route("app", "ui"), appsUi(d));
    expect(ui).toContain("data-apps-notargets");
    expect(ui).toContain("data-apps-release");
  });

  it("the Remove confirmation: the page's confirmModal; its parts kept by default, or removed too — an app read from its parts goes with them", () => {
    const d = setup();
    const ui = uiOf(route("app", "web"), appsUi(d));
    const copy = orgConfirmCopy({ what: "app", arg: "web", busy: false }, org(), ui)!;
    expect(copy.title).toBe("Remove web?");
    expect(copy.body).toContain("Trov stops showing web’s deploys, previews and usage on the Repo screen. Its pull requests and commits stay in Code.");
    expect(copy.detail).toContain('data-seg="org-apps-rm-parts"');
    expect(copy.detail).toMatch(/is-on"[^>]*>Keep them</);
    const removing = appRemoveCopy({ ...appsUi(d), removeParts: true }, "web")!;
    expect(removing.detail).toMatch(/is-on"[^>]*>Remove them too</);
    expect(removing.detail).toContain("deploy name goes back to unassigned");
    const html = orgOverlays({ org: org(), orgsStatus: "ok", me: "andres", ui: { ...ui, confirm: { what: "app", arg: "web", busy: false } } });
    expect(html).toContain("data-confirm-dialog");
    expect(html).toContain("Remove web?");
    expect(html).toContain('data-act="orgAppsRemoveParts"');
    // A part key read as an app: no keep option.
    const synth = setup({ apps: [app("frontend", "Worker", "/", [part("production", "frontend", "cloudflare", { worker: "x" })], "synthesised")] });
    const s = appRemoveCopy(appsUi(synth), "frontend")!;
    expect(s.detail).not.toContain("org-apps-rm-parts");
    expect(s.detail).toContain("is read from its part: it goes with it");
  });
});

describe("Setup 3 · the deploy-signal picker (GUARD: only signals seen in 30 days)", () => {
  it("offers exactly the seen signals a github part can name, each 'Render · 14 times · last 25m ago' — never a status, never an unseen name", () => {
    const d = setup();
    const api = d.apps[1];
    const dd = signalDropdown(d, api, "production", null);
    const offered = dd.options.filter((o) => o.value !== "");
    expect(offered.map((o) => o.label)).toEqual([
      "Workflow eas-build.yml", "Check run “Render – api”", "Deployment “Preview – storefront-api”", "Deployment “Production – storefront-api”", "Deployment “Production – storefront-admin”",
    ]);
    expect(offered.find((o) => o.label === "Deployment “Production – storefront-api”")?.hint).toBe("Render · 14 times · last 25m ago");
    expect(offered.some((o) => o.label.includes("Vercel"))).toBe(false); // a commit status can name no part
    // The part's current setting is the picked one.
    expect(dd.value).toBe(signalKey(SIGNALS[0]));
    // Every offered value is a seen signal, and maps back to the setting it would write.
    for (const o of offered) expect(SIGNALS.some((s) => signalKey(s) === o.value)).toBe(true);
    expect(settingsForPick(d, signalKey(SIGNALS[2]))).toEqual({ check_app: "render", check_name: "Render – api" });
    expect(settingsForPick(d, signalKey(SIGNALS[5]))).toEqual({ workflow: ".github/workflows/eas-build.yml" });
    expect(settingsForPick(d, signalKey(SIGNALS[4]))).toBeNull();
  });

  it("a part set to a name not seen in 30 days: the name is NOT offered (not even in the open menu) — it is said under the picker", () => {
    const stale = "Production – old-api";
    const d = setup({ apps: [app("api", "Service", "apps/api", [part("production", "api", "github", { environment: stale })])] });
    const dd = signalDropdown(d, d.apps[0], "production", null);
    expect(dd.value).toBe("");
    expect(dd.options.some((o) => o.label.includes(stale) || o.value.includes(stale))).toBe(false);
    const menu = dropdownMenu([dd], { open: dd.id, opening: false, closing: false });
    expect(menu).toContain("Deployment “Production – storefront-api”");
    expect(menu).not.toContain(stale);
    const html = repoAppsPage(route("app", "api"), appsUi(d), { open: dd.id, opening: false, closing: false });
    expect(html).toContain(`Now: Deployment “${stale}”, not seen in the last 30 days.`);
    // The page's dropdown list (what Org settings opens the menu from) is the same picker.
    const list = orgDropdowns({ org: org(), orgsStatus: "ok", me: "andres", ui: uiOf(route("app", "api"), appsUi(d)) });
    expect(list.find((x) => x.id === dd.id)?.options.map((o) => o.value)).toEqual(dd.options.map((o) => o.value));
    // Nothing seen at all: nothing offered.
    const empty = signalDropdown(setup({ signals: [] }), d.apps[0], "production", null);
    expect(empty.options.filter((o) => o.value !== "")).toEqual([]);
    expect(pickableSignals([])).toEqual([]);
  });

  it("a pick is staged in the draft until Save", () => {
    const d = setup();
    const dr = { ...draftOf(d.apps[1]), picks: { production: signalKey(SIGNALS[2]) } };
    expect(signalDropdown(d, d.apps[1], "production", dr).value).toBe(signalKey(SIGNALS[2]));
  });
});

describe("Setup 5 · Add an app by hand", () => {
  it("name, folder, kind (segmented), and how a release shows up — from tags and workflows actually seen", () => {
    const d = setup({ suggestions: [], signals: [], unassigned: [] });
    const html = page(route("new"), appsUi(d, { add: { key: "mobile", folder: "/", kind: "Package", release: "", saving: false, error: null, errorField: null } }));
    expect(html).toContain(`Trov found no deploy config in <strong style="font-weight:600;color:var(--fg)">${REPO}</strong> and no host reports to GitHub.`);
    expect(html).toContain('id="org-apps-add-key"');
    expect(html).toContain('data-seg="org-apps-add-kind"');
    expect(html).toMatch(/data-act="orgAppsAddSave"[^>]*>Add app</);
    expect(releaseOptions(d).map((o) => o.label)).toEqual(["Not tracked"]);
    const seen = setup({ tags: { count: 14, latest: { tag: "v1.8.0", at: ago(6 * 24 * 60) } } });
    expect(releaseOptions(seen).map((o) => [o.value, o.label])).toEqual([
      ["tag:v*", "A tag matching v*"], ["workflow:eas-build.yml", "A workflow run of eas-build.yml"], ["", "Not tracked"],
    ]);
    expect(releaseOptions(seen)[0].hint).toBe("Seen 14 times · latest v1.8.0, 6d ago");
    // The key is checked as the server will: taken, or not a key.
    const taken = page(route("new"), appsUi(setup(), { add: { key: "web", folder: "/", kind: "Site", release: "", saving: false, error: null, errorField: null } }));
    expect(taken).toContain("An app called web exists already.");
    expect(taken).toMatch(/data-act="orgAppsAddSave"[^>]*disabled/);
  });
});

describe("wiring", () => {
  it("every act is an orgApps… act or the part editor's; the Repo screen's found card's acts are dispatched with toast + Undo", () => {
    for (const m of appsSrc.matchAll(/data-act="([A-Za-z]+)"/g)) expect(m[1]).toMatch(/^(orgApps|orgHx|orgConfirm|orgTab)/);
    expect(mainSrc).toMatch(/case "repoFoundAccept": case "repoFoundIgnore":/);
    expect(mainSrc).toContain("acceptRepoSuggestion(slug, repo, arg)");
    expect(mainSrc).toContain("ignoreRepoSuggestion(slug, repo, arg)");
    expect(mainSrc).toMatch(/\{ label: "Undo", act: "repoFoundUndo", arg: undo \}/);
    expect(mainSrc).toMatch(/case "repoFoundUndo":/);
    // The toast's Undo carries an id, never a token, on the Apps page.
    expect(actionsSrc).toMatch(/\{ label: "Undo", act: "orgAppsUndo", arg: id \}/);
    expect(actionsSrc).toContain("APPS_UNDO_MS = 5000");
  });
});
