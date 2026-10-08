/**
 * The guided first-run setup (web/src/welcome.ts, `#welcome`) — pure render tests: props in,
 * markup out. Both versions (an owner's / admin's four steps, a member's two), every step's
 * states, that a step's done-state is DERIVED and never guessed (a read that is out or failed is
 * "not known yet"), where creating an organization and accepting an invitation land, and the
 * note that brings a return from GitHub back to the wizard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import css from "../web/src/trov.css?raw";
import {
  welcomeView, welcomeStepper, welcomeStepsFor, effectiveWelcomeStep, welcomeStates, githubStepState, agentStepState, teamStepState, agentStatus,
  welcomeOverlays, initialWelcomeUi, isWelcomeStep, type WelcomeProps, type WelcomeStep,
  firstRunStepLabel, FIRST_RUN_STEPS,
} from "../web/src/welcome";
import { welcomeReturnHash, parseWelcomeReturn, WELCOME_RETURN_TTL_MS, type WelcomeReturn } from "../web/src/welcome-actions";
import { initialOrgUi, membersTab, setupChecklist, type OrgUi } from "../web/src/org-settings";
import { acceptLanding, createLanding } from "../web/src/org-picker";
import { parseHash, hashForRoute, sameRoute, pageKey } from "../web/src/hash";
import { render, initialState, mcpAccessSection, type AppState } from "../web/src/render";
import { PLUGIN_INSTALL, browserConnectCommand, connectSteps } from "../web/src/mcp-connect";
import { setApiOrg } from "../web/src/api";
import type { Me } from "../web/src/api";
import { PLANS, type OrgPlanView, type PlanId } from "@shared/plans";
import type { OrgBillingView } from "@shared/billing";
import type { MyOrg, OrgInvite, OrgMember, OrgRole } from "@shared/orgs";
import type { OrgRepoDTO } from "@shared/integrations";
import type { GithubAppStatusDTO, GithubInstallationDTO, GithubReposDTO } from "@shared/github-app";
import type { McpTokenSummary, OAuthGrantSummary } from "@shared/rows";

const sources = import.meta.glob(["../web/src/welcome.ts", "../web/src/welcome-actions.ts", "../web/src/org-picker-actions.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const src = (name: string): string => sources[`../web/src/${name}`];

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const loading = <T,>(data: T) => ({ status: "loading" as const, data });
const failed = <T,>(data: T) => ({ status: "error" as const, data, error: "boom" });

const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme Robotics", role });
const member = (handle: string, role: OrgRole = "member"): OrgMember => ({ handle, name: handle, color: "sky", avatar_url: null, role, title: null, joined_at: "2026-10-01T00:00:00.000Z" });
const invite = (o: Partial<OrgInvite> = {}): OrgInvite => ({
  id: 7, github_login: null, email: "sam@example.com", role: "member", status: "pending", invited_by: "ines", created_at: "2026-10-05T10:00:00.000Z",
  responded_at: null, responded_by: null, name: null, mail_status: "sent", mail_at: "2026-10-05T10:00:00.000Z", mail_error: null, ...o,
});
const repo = (name: string, o: Partial<OrgRepoDTO> = {}): OrgRepoDTO => ({
  id: `hook_${name}`, repo_full_name: name, is_primary: true, legacy_hook: false, webhook_url: null, webhook_secret_configured: false, connection: "app", access_lost: false,
  created_at: "2026-10-01T10:00:00.000Z", created_by: "ines", ...o,
});
const inst = (o: Partial<GithubInstallationDTO> = {}): GithubInstallationDTO => ({
  installation_id: 5551234, account_login: "acme-gh", account_type: "Organization", repository_selection: "selected", connected_by: "ines",
  connected_at: "2026-10-05T10:00:00.000Z", suspended_at: null, last_used_at: null, last_error: null, manage_url: "https://github.com/organizations/acme-gh/settings/installations/5551234", ...o,
});
const gh = (o: Partial<GithubAppStatusDTO> = {}): GithubAppStatusDTO => ({ configured: true, installation: null, lost: null, mismatch: null, ...o });
const available = (names: string[]): GithubReposDTO => ({ repositories: names.map((n) => ({ full_name: n, private: false, tracked: false, is_primary: false })), total: names.length, truncated: false });
const bill = (o: Partial<OrgBillingView> = {}): OrgBillingView => ({ available: true, subscribed: false, ended: false, customer: false, interval: null, seats: null, cancel_at_period_end: false, pinned: false, upgrade_to: ["team"], ...o });
const plan = (id: PlanId = "team", o: Partial<OrgPlanView> = {}): OrgPlanView => ({
  plan: id, name: PLANS[id].name, description: PLANS[id].description, status: "active", source: "granted", period_end: null, gift_until: null, entitlements: PLANS[id].entitlements, overridden: [],
  seats: { members: 1, pending: 0 }, usage: { seats: 1, repositories: 0, environments: 0, artifact_bytes: 0, agent_connections: 0, ai_summaries: 0 }, over: [], ...o,
});
const grant = (slug = "acme", o: Partial<OAuthGrantSummary> = {}): OAuthGrantSummary => ({ id: 3, client_name: "Claude Code", created_at: "2026-10-07T10:00:00.000Z", last_used_at: null, org: { slug, name: slug === "acme" ? "Acme Robotics" : "Other" }, ...o });
const token = (): McpTokenSummary => ({ id: 9, hint: "ab12", created_at: "2026-09-01T10:00:00.000Z", last_used_at: null });

/** An org its owner has just created: every read in, nothing connected, nobody else. */
const ui = (o: Partial<OrgUi> = {}): OrgUi => ({
  ...initialOrgUi(), slug: "acme", members: ok([member("ines", "owner")]), invites: ok([]), repos: ok([]), envs: ok([]), plan: ok(plan()), github: ok(gh()), ...o,
});
const meOf = (...providers: ("github" | "google")[]): WelcomeProps["me"] => ({ handle: "ines", name: "Ines Vidal", identities: providers.map((p) => ({ provider: p, label: p === "github" ? "ines-vidal" : "ines@example.com" })) });
const props = (step: WelcomeStep, o: Partial<WelcomeProps> = {}): WelcomeProps => ({
  org: org(), step, me: meOf("github"), ui: ui(), grants: ok([]), tokens: ok([]), wel: { ...initialWelcomeUi(), step }, ...o,
});
const view = (step: WelcomeStep, o: Partial<WelcomeProps> = {}) => welcomeView(props(step, o));
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&middot;/g, "·").replace(/&rarr;/g, "→").replace(/&mdash;/g, "—").replace(/&#39;/g, "'").replace(/&rsaquo;/g, "›").replace(/\s+/g, " ");
const accents = (html: string) => (html.match(/class="cnpy-accentbtn"/g) ?? []).length;
const stepState = (html: string, s: WelcomeStep) => new RegExp(`data-step="${s}" data-state="(\\w+)"`).exec(html)?.[1];
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

beforeEach(() => setApiOrg("acme"));
afterEach(() => setApiOrg(null));

// ── the route ────────────────────────────────────────────────────────────────
describe("#welcome — a route, so a reload stays on the step", () => {
  it("#welcome is the first step; each other step has its own address; junk falls back", () => {
    expect(parseHash("#welcome")).toEqual({ screen: "welcome", ticketId: null, sprintId: null, welcomeStep: "github" });
    for (const h of ["#welcome", "#welcome/agent", "#welcome/team", "#welcome/done"]) expect(hashForRoute(parseHash(h))).toBe(h);
    expect(hashForRoute(parseHash("#welcome/github"))).toBe("#welcome");
    expect(parseHash("#welcome/nope").screen).toBe("mywork");
    expect(parseHash("#welcome/agent/x").screen).toBe("mywork");
    expect(isWelcomeStep("team")).toBe(true);
    expect(isWelcomeStep("org")).toBe(false);
  });
  it("two steps are two routes and two pages (a step plays its own entrance)", () => {
    expect(sameRoute(parseHash("#welcome"), parseHash("#welcome/agent"))).toBe(false);
    expect(sameRoute(parseHash("#welcome/agent"), parseHash("#welcome/agent"))).toBe(true);
    expect(pageKey(parseHash("#welcome/agent"))).not.toBe(pageKey(parseHash("#welcome/team")));
  });
});

// ── where a new person lands ─────────────────────────────────────────────────
describe("the landing target — the wizard, not Org settings or an empty feed", () => {
  it("creating an organization (Free, granted or paid) lands on the guided setup", () => {
    expect(createLanding("acme")).toBe("/acme/#welcome");
    // …in place when the page has held no other org's data (a first run), by a page load otherwise.
    expect(src("org-picker-actions.ts")).toContain(".then((org) => land(org, createLanding(org.slug)))");
    expect(src("org-picker-actions.ts")).toContain("if (!h.enterNew?.(org, hash)) h.go(url);");
    expect(src("org-picker-actions.ts")).not.toContain('"#org"');
  });
  it("accepting an invitation lands an owner or admin on its first step, a member on theirs", () => {
    const inv = (role: OrgRole) => ({ org: { slug: "acme", name: "Acme" }, role });
    expect(acceptLanding(inv("owner"))).toBe("/acme/#welcome");
    expect(acceptLanding(inv("admin"))).toBe("/acme/#welcome");
    expect(acceptLanding(inv("member"))).toBe("/acme/#welcome/agent");
    expect(parseHash("#welcome/agent")).toMatchObject({ screen: "welcome", welcomeStep: "agent" });
  });
  it("Org settings' checklist links back to it, and Get Started does too", () => {
    const html = setupChecklist(org(), { ...ui(), integrations: ok({ integrations: [], github_app: gh(), secrets_available: true, key_version: null }) });
    expect(html).toMatch(/<button type="button" data-act="welcomeOpen"[^>]*data-org-setup-guided[^>]*>Open the guided setup<\/button>/);
    const app: AppState = { ...initialState(), view: "app", screen: "guide", orgSlug: "acme", me: { handle: "ines", name: "Ines", avatar_url: null, color: "fern", identities: [], orgs: [org()], superadmin: false, pending_invites: 0 } as Me };
    expect(render(app)).toMatch(/data-guide-setup>[\s\S]*data-act="welcomeOpen"[\s\S]*Open the guided setup/);
  });
});

// ── which steps, and which is on screen ──────────────────────────────────────
describe("the steps a role walks", () => {
  it("an owner and an admin get four; a member two; a one-person plan has no team step", () => {
    expect(welcomeStepsFor("owner", ui())).toEqual(["github", "agent", "team", "done"]);
    expect(welcomeStepsFor("admin", ui())).toEqual(["github", "agent", "team", "done"]);
    expect(welcomeStepsFor("member", ui())).toEqual(["agent", "done"]);
    expect(welcomeStepsFor(null, ui())).toEqual(["agent", "done"]);
    expect(welcomeStepsFor("owner", ui({ plan: ok(plan("personal")) }))).toEqual(["github", "agent", "done"]);
    // Not known yet is not "solo": the step is there until the plan says otherwise.
    expect(welcomeStepsFor("owner", ui({ plan: loading(null) }))).toContain("team");
  });
  it("a step this person's flow does not have shows their first", () => {
    expect(effectiveWelcomeStep("github", ["agent", "done"])).toBe("agent");
    expect(effectiveWelcomeStep("team", ["agent", "done"])).toBe("agent");
    expect(effectiveWelcomeStep("done", ["agent", "done"])).toBe("done");
    expect(view("github", { org: org("member") })).toContain('data-welcome-step="agent"');
  });
});

// ── derived, never guessed ───────────────────────────────────────────────────
describe("a step's state is read off live data — unknown is never done and never to-do", () => {
  it("repository: tracked = done; an answered empty list = to do; a read still out or failed = not known", () => {
    expect(githubStepState(ui({ repos: ok([repo("acme-gh/web")]) }))).toBe("done");
    expect(githubStepState(ui())).toBe("todo");
    expect(githubStepState(ui({ repos: loading([]) }))).toBe("unknown");
    expect(githubStepState(ui({ repos: { status: "idle", data: [] } }))).toBe("unknown");
    expect(githubStepState(ui({ repos: failed([]) }))).toBe("unknown");
  });
  it("agent: a connection of MINE into THIS org = done; none needs BOTH reads to have answered", () => {
    const p = (grants: WelcomeProps["grants"], tokens: WelcomeProps["tokens"]) => agentStepState({ grants, tokens }, "acme");
    expect(p(ok([grant()]), ok([]))).toBe("done");
    expect(p(ok([]), ok([token()]))).toBe("done");
    expect(p(ok([grant("other")]), ok([]))).toBe("todo"); // connected to another org is not connected here
    expect(p(ok([]), ok([]))).toBe("todo");
    expect(p(loading([]), ok([]))).toBe("unknown");
    expect(p(ok([]), failed([]))).toBe("unknown");
    expect(p(failed([]), ok([]))).toBe("unknown");
    expect(p(failed([]), ok([token()]))).toBe("done"); // one found is enough
  });
  it("team: someone joined or is invited = done; an empty answer = to do; unread = not known", () => {
    expect(teamStepState(ui({ members: ok([member("ines", "owner"), member("sam")]) }))).toBe("done");
    expect(teamStepState(ui({ invites: ok([invite()]) }))).toBe("done");
    expect(teamStepState(ui({ invites: ok([invite({ status: "revoked" })]) }))).toBe("todo");
    expect(teamStepState(ui())).toBe("todo");
    expect(teamStepState(ui({ invites: loading([]) }))).toBe("unknown");
    expect(teamStepState(ui({ members: failed([]) }))).toBe("unknown");
  });
  it("the indicator ticks only what is done; a step whose read is out keeps its number and says so", () => {
    const fresh = view("github");
    for (const s of ["github", "agent", "team"] as const) expect(stepState(fresh, s)).toBe("todo");
    const out = view("github", { ui: ui({ repos: loading([]), invites: loading([]) }), grants: loading([]) });
    for (const s of ["github", "agent", "team"] as const) expect(stepState(out, s)).toBe("unknown");
    expect(out).toContain('aria-label="Step 1 of 4: Repository, not known yet"');
    expect(out).not.toMatch(/data-state="done"/);
    const all = view("done", { ui: ui({ repos: ok([repo("acme-gh/web")]), invites: ok([invite()]) }), grants: ok([grant()]) });
    for (const s of ["github", "agent", "team"] as const) expect(stepState(all, s)).toBe("done");
    expect(stepState(all, "done")).toBe("todo"); // the end of the flow is never ticked
    expect(all).toContain('aria-label="Step 2 of 4: Coding agent, done"');
  });
  it("welcomeStates: the whole is done only when every step before it is, and unknown while one is", () => {
    expect(welcomeStates(props("done")).done).toBe("todo");
    expect(welcomeStates(props("done", { grants: loading([]) })).done).toBe("unknown");
    expect(welcomeStates(props("done", { ui: ui({ repos: ok([repo("a/b")]), invites: ok([invite()]) }), grants: ok([grant()]) })).done).toBe("done");
    // A member's whole is their agent alone — the org's repository is not theirs to connect.
    expect(welcomeStates(props("done", { org: org("member"), grants: ok([grant()]) })).done).toBe("done");
  });
  it("renders nothing from a render path that could call out: no fetch, no GitHub host, in the view module", () => {
    expect(src("welcome.ts")).not.toMatch(/\bfetch\(|api\.github\.com|XMLHttpRequest/);
    expect(src("welcome.ts")).not.toMatch(/from "\.\/api"/);
  });
});

// ── the page ─────────────────────────────────────────────────────────────────
describe("the page — one step at a time, Back, skippable", () => {
  it("is a full page: no sidebar, the picker's frame, the org's name, the step indicator with the current step marked", () => {
    const app: AppState = { ...initialState(), view: "app", screen: "welcome", orgSlug: "acme", me: { handle: "ines", name: "Ines Vidal", avatar_url: null, color: "fern", identities: [{ provider: "github", label: "ines-vidal", linked_at: "t" }], orgs: [org()], superadmin: false, pending_invites: 0 } as Me };
    const html = render(app);
    // The only app shell on the page is the inert backdrop behind the card: no live sidebar.
    expect((html.match(/class="cnpy-shell"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<div class="cnpy-fr-bg" aria-hidden="true" inert><div class="cnpy-shell"/);
    expect(html).toContain('class="cnpy-orgs cnpy-org cnpy-wel" data-morph="welcome"');
    expect(html).toContain('data-welcome="admin" data-welcome-step="github"');
    expect(html).toContain("Acme Robotics");
    expect(html).toMatch(/data-arg="github" data-field="welcomeGo:github" aria-current="step"/);
    expect((html.match(/aria-current="step"/g) ?? []).length).toBe(1);
    expect((html.match(/class="cnpy-wel-step[ "]/g) ?? []).length).toBe(4);
  });
  it("the first step has no Back; every step but the last can be skipped, and the whole thing left", () => {
    const first = view("github");
    expect(first).not.toContain('data-field="welcomeBack"');
    expect(first).toMatch(/<button type="button" data-act="welcomeGo" data-arg="agent" data-field="welcomeNext"[^>]*>Skip for now<\/button>/);
    expect(first).toMatch(/data-act="goMyWork" data-field="welcomeExit"[^>]*>Skip setup/);
    const second = view("agent");
    expect(second).toMatch(/data-act="welcomeGo" data-arg="github" data-field="welcomeBack"[^>]*>Back</);
    expect(second).toMatch(/data-arg="team" data-field="welcomeNext"[^>]*>Skip for now</);
    const last = view("done");
    expect(last).toMatch(/data-act="welcomeGo" data-arg="team" data-field="welcomeBack"/);
    expect(last).toMatch(/<button type="button" data-act="goMyWork" data-field="welcomeFinish"[^>]*class="cnpy-accentbtn"[^>]*>Open Trov<\/button>/);
    expect(last).not.toContain('data-field="welcomeNext"');
    expect(last).not.toContain('data-field="welcomeExit"');
  });
  it("a finished step's way forward is Continue, and it is the step's one accent", () => {
    const done = view("github", { ui: ui({ repos: ok([repo("acme-gh/web")]) }) });
    expect(done).toMatch(/data-field="welcomeNext"[^>]*class="cnpy-accentbtn"[^>]*>Continue</);
    expect(accents(done)).toBe(1);
    for (const s of ["github", "agent", "team", "done"] as const) expect(accents(view(s)), s).toBeLessThanOrEqual(1);
    // The team step's accent stays the Invite button, so a finished one continues quietly.
    const team = view("team", { ui: ui({ invites: ok([invite()]) }) });
    expect(team).toMatch(/data-field="welcomeNext"[^>]*class="cnpy-ghostbtn"[^>]*>Continue</);
  });
  it("without an org to read (it is not known to be this person's yet) it derives nothing", () => {
    const html = view("github", { org: null });
    expect(html).toContain('data-welcome="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("cnpy-wel-step");
  });
  it("escapes what a person typed: the organization's name", () => {
    const html = view("agent", { org: { slug: "acme", name: "<img src=x>", role: "owner" } });
    expect(html).not.toContain("<img src=x>");
  });
});

// ── step 1 ───────────────────────────────────────────────────────────────────
describe("step 1 — connect a repository", () => {
  it("offered, nothing connected, a GitHub account linked: Connect with GitHub is the one accent, a real link to the start route", () => {
    const html = view("github");
    expect(html).toContain('data-welcome-github="connect"');
    expect(html).toMatch(/<a href="\/api\/o\/acme\/github\/install" data-field="welcomeGithubConnect" data-org-github-connect class="cnpy-accentbtn"[^>]*>Connect with GitHub<\/a>/);
    expect(accents(html)).toBe(1);
    expect(html).toContain('href="/api/o/acme/github/install?existing=1"');
    expect(html).toMatch(/data-act="orgGo" data-arg="repos"[^>]*>Add a repository by name instead/); // the by-hand path, quiet
  });
  it("a Google-only person is told to link GitHub first — never sent to GitHub to be refused", () => {
    const html = view("github", { me: meOf("google") });
    expect(html).toContain('data-welcome-github="link"');
    expect(text(html)).toContain("Link your GitHub account first");
    expect(text(html)).toContain("You signed in with Google (ines@example.com)");
    expect(html).toMatch(/<button type="button" data-act="welcomeLinkGithub" data-field="welcomeLinkGithub" class="cnpy-accentbtn"[^>]*>Link your GitHub account<\/button>/);
    expect(html).not.toContain("/github/install");
    expect(html).not.toContain("data-org-github-connect");
    expect(accents(html)).toBe(1);
    // Still skippable, and the by-hand path is still there.
    expect(html).toMatch(/data-field="welcomeNext"[^>]*>Skip for now</);
    expect(html).toContain("Add a repository by name instead");
    // Both linked: the ordinary Connect.
    expect(view("github", { me: meOf("google", "github") })).toContain('data-welcome-github="connect"');
  });
  it("the link act notes the departure and goes to GitHub's link mode", () => {
    expect(src("welcome-actions.ts")).toContain('case "welcomeLinkGithub": leaveNote("link"); h.go("/auth/login?link=1"); return;');
  });
  it("connected, nothing tracked: the installation's repositories to pick from (Org settings' own picker and acts)", () => {
    const html = view("github", { ui: ui({ github: ok(gh({ installation: inst() })), githubRepos: ok(available(["acme-gh/web", "acme-gh/api"])) }) });
    expect(html).toContain('data-welcome-github="pick"');
    expect(html).toContain('data-org-github-repo="acme-gh/web"');
    expect(html).toMatch(/data-act="orgGithubTrack" data-arg="acme-gh\/api"/);
    expect(text(html)).toContain("the first one you track becomes the primary");
    expect(stepState(html, "github")).toBe("todo");
    // The list itself still out: a skeleton, not "no repositories".
    const out = view("github", { ui: ui({ github: ok(gh({ installation: inst() })), githubRepos: loading(null) }) });
    expect(out).toContain('aria-busy="true"');
  });
  it("a repository tracked: says which, marks the primary, and Continue", () => {
    const html = view("github", { ui: ui({ github: ok(gh({ installation: inst() })), repos: ok([repo("acme-gh/web"), repo("acme-gh/api", { is_primary: false })]) }) });
    expect(html).toContain('data-welcome-github="tracked"');
    expect(html).toContain('data-welcome-repo="acme-gh/web"');
    expect(text(html)).toContain("2 repositories are connected");
    expect((html.match(/>Primary</g) ?? []).length).toBe(1);
    expect(html).not.toContain("/github/install");
  });
  it("the App is not configured on this Trov: the by-name path, said plainly", () => {
    const html = view("github", { ui: ui({ github: ok(gh({ configured: false })) }) });
    expect(html).toContain('data-welcome-github="manual"');
    expect(text(html)).toContain("The GitHub App is not configured on this Trov");
    expect(html).toMatch(/data-act="orgGo" data-arg="repos"[^>]*>Open Repositories</);
    expect(html).not.toContain("/github/install");
  });
  it("reads still out: a skeleton; a failed read: an error with Try again — never a guess at either", () => {
    const out = view("github", { ui: ui({ repos: loading([]), github: loading(null) }) });
    expect(out).toContain('data-welcome-github="loading"');
    expect(out).not.toContain("/github/install");
    const appOut = view("github", { ui: ui({ github: loading(null) }) });
    expect(appOut).toContain('data-welcome-github="loading"');
    const bad = view("github", { ui: ui({ repos: failed([]) }) });
    expect(text(bad)).toContain("Couldn't load the repositories.");
    expect(bad).toContain('data-act="orgReload"');
    const badApp = view("github", { ui: ui({ github: failed(null) }) });
    expect(text(badApp)).toContain("Couldn't load the GitHub connection.");
    expect(badApp).not.toContain("/github/install");
  });
  it("what the return from GitHub said is shown on the step", () => {
    const html = view("github", { ui: ui({ githubNotice: { outcome: "wrong_account", accounts: [] } }) });
    expect(html).toContain('data-org-github-notice="wrong_account"');
    expect(text(html)).toContain("The GitHub account that approved this is not the one linked to your Trov account.");
  });
});

// ── step 2 ───────────────────────────────────────────────────────────────────
describe("step 2 — connect your coding agent (both versions)", () => {
  it("shows the SAME commands and steps as Settings › MCP access, with Copy buttons", () => {
    const html = view("agent");
    for (const line of PLUGIN_INSTALL.split("\n")) expect(html).toContain(line);
    expect(html).toContain('data-act="copyPluginInstall"');
    expect(html).toContain('aria-label="Connect Claude Code"');
    // One source: the Settings tile renders the same list.
    const settings = mcpAccessSection({ grants: ok([]), grantRevokeArm: null, grantsAll: false }, "Acme Robotics");
    expect(settings).toContain(connectSteps("Acme Robotics"));
    expect(text(html)).toContain("you're in Acme Robotics now");
  });
  it("the status line: waiting, connected (naming what is), still checking, could not be checked", () => {
    const waiting = view("agent");
    expect(waiting).toContain('data-welcome-agent="waiting"');
    expect(text(waiting)).toContain("Not connected yet");
    expect(waiting).toMatch(/data-field="welcomeNext"[^>]*>Skip for now</);

    const on = view("agent", { grants: ok([grant("other"), grant("acme", { last_used_at: null })]) });
    expect(on).toContain('data-welcome-agent="connected"');
    expect(text(on)).toContain("Your agent is connected");
    expect(text(on)).toContain("Claude Code is connected to Acme Robotics");
    expect(on).toMatch(/data-field="welcomeNext"[^>]*class="cnpy-accentbtn"[^>]*>Continue</);
    expect(text(view("agent", { tokens: ok([token()]) }))).toContain("An access token of yours reaches Acme Robotics");

    const checking = view("agent", { grants: loading([]) });
    expect(checking).toContain('data-welcome-agent="checking"');
    expect(checking).not.toContain("Not connected yet");
    expect(checking).not.toContain("Your agent is connected");

    const unknown = view("agent", { grants: failed([]) });
    expect(unknown).toContain('data-welcome-agent="unknown"');
    expect(text(unknown)).toContain("Couldn't check your connections");
    expect(unknown).toContain('data-act="welcomeRecheck"');
    expect(unknown).not.toContain("Not connected yet");
  });
  it("the status is a live region", () => {
    expect(agentStatus({ grants: ok([]), tokens: ok([]) }, org())).toMatch(/role="status" aria-live="polite" data-welcome-agent="waiting"/);
  });
  it("the by-hand command is behind a real toggle, closed until asked for", () => {
    const shut = view("agent");
    expect(shut).toMatch(/data-act="welcomeByHand" data-field="welcomeByHand" aria-expanded="false" aria-controls="wel-byhand"/);
    expect(shut).toMatch(/<div id="wel-byhand" hidden/);
    const open = view("agent", { wel: { step: "agent", byHand: true, firstRun: false } });
    expect(open).toMatch(/aria-expanded="true" aria-controls="wel-byhand"/);
    expect(open).not.toMatch(/<div id="wel-byhand" hidden/);
    expect(open).toContain(browserConnectCommand().replace(/&/g, "&amp;"));
    expect(open).toContain('data-act="copyBrowserConnect"');
  });
  it("a member's wizard is this step and the closing one", () => {
    const html = view("agent", { org: org("member") });
    expect(html).toContain('data-welcome="member" data-welcome-step="agent"');
    expect((html.match(/class="cnpy-wel-step[ "]/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Step 1 of 2: Coding agent, to do"');
    expect(html).not.toContain('data-field="welcomeBack"');
    expect(html).toMatch(/data-arg="done" data-field="welcomeNext"/);
    expect(html).not.toContain("/github/install");
    expect(html).not.toContain("orgInviteSend");
  });
});

// ── step 3 ───────────────────────────────────────────────────────────────────
describe("step 3 — invite your team", () => {
  it("is Members' own invite form: the same acts, so the same call and the same refusals", () => {
    const html = view("team");
    for (const act of ["orgInviteBy", "orgInviteDraft", "orgInviteSend"]) expect(html).toContain(`data-act="${act}"`);
    expect(html).toContain('id="org-invite-role"');
    const tab = membersTab(org(), ui(), "ines");
    const form = (h: string) => h.slice(h.indexOf('<section aria-labelledby="org-invite-t"'), h.indexOf("</section>", h.indexOf('<section aria-labelledby="org-invite-t"')));
    expect(form(html)).toBe(form(tab));
    expect(text(html)).toContain("Nobody has joined you yet · no invitation pending.");
  });
  it("email + role inline, and a refusal shown under the field", () => {
    const html = view("team", { ui: ui({ inviteBy: "email", inviteDraft: "sam@example.com", inviteError: "You've sent 50 invitations today. Try again tomorrow." }) });
    expect(html).toContain('type="email"');
    expect(html).toContain('id="org-invite-name"');
    expect(html).toMatch(/id="org-invite-e" role="alert"[^>]*>You&#39;ve sent 50 invitations today/);
  });
  it("a Free org at its seat cap shows the EXISTING sentence and Upgrade button — no form, no new affordance", () => {
    const full = plan("free", { usage: { ...plan().usage, seats: 3 }, seats: { members: 2, pending: 1 }, billing: bill() });
    const u = ui({ plan: ok(full), members: ok([member("ines", "owner"), member("sam")]), invites: ok([invite()]) });
    const html = view("team", { ui: u });
    expect(html).toContain('data-invite-gate="full"');
    expect(html).not.toContain('data-act="orgInviteSend"');
    expect(html).toMatch(/data-seat-fix="upgrade">[\s\S]*data-act="orgBillingUpgrade"[\s\S]*Upgrade to Pro/);
    const tab = membersTab(org(), u, "ines");
    const gate = (h: string) => h.slice(h.indexOf('data-invite-gate="full"'), h.indexOf("</section>", h.indexOf('data-invite-gate="full"')));
    expect(gate(html)).toBe(gate(tab));
    // An admin who is not the owner reads the sentence without the button.
    expect(view("team", { org: org("admin"), ui: u })).not.toContain("orgBillingUpgrade");
  });
  it("lists who is already waiting, and the step is done", () => {
    const html = view("team", { ui: ui({ invites: ok([invite(), invite({ id: 8, email: null, github_login: "octocat", mail_status: null })]) }) });
    expect(html).toContain('data-welcome-invite="7"');
    expect(html).toContain("sam@example.com");
    expect(html).toContain("@octocat");
    expect(text(html)).toContain("2 invitations pending");
    expect(stepState(html, "team")).toBe("done");
  });
  it("until the people and the plan are read: a skeleton, not a form the server might refuse", () => {
    const html = view("team", { ui: ui({ plan: loading(null) }) });
    expect(html).toContain('data-welcome-team="loading"');
    expect(html).not.toContain("orgInviteSend");
    expect(view("team", { ui: ui({ members: loading([]) }) })).toContain('data-welcome-team="loading"');
  });
  it("the role menu is a root-level overlay (dropdown.ts), only while open", () => {
    expect(welcomeOverlays(props("team"))).toBe("");
    const open = welcomeOverlays(props("team", { dd: { open: "org-invite-role", opening: false, closing: false } }));
    expect(open).toContain('data-dd-pop="org-invite-role"');
    expect(open).toContain('data-dd-act="orgInviteRole"');
    expect(welcomeOverlays(props("team", { org: org("member"), dd: { open: "org-invite-role", opening: false, closing: false } }))).toBe("");
  });
});

// ── the last step ────────────────────────────────────────────────────────────
describe("the closing step — you're set, and where things live", () => {
  it("says how a first session goes (what the setup cannot do for you), points at the Guide, and has the button into the app", () => {
    const html = view("done");
    expect(html).toContain("Your first session");
    expect((html.match(/class="cnpy-wel-row" style="align-items:flex-start/g) ?? []).length).toBe(3);
    expect(html).toContain("record this session");
    expect(html).toMatch(/data-act="goGuide" data-field="welcomeGuide"[^>]*>Read the Guide</);
    // It does not repeat the sidebar the person sees a moment later.
    expect(html).not.toContain("Where things live");
    expect(html).not.toContain('aria-label="Open Roadmap"');
    expect(html).toMatch(/data-act="goMyWork" data-field="welcomeFinish"/);
  });
  it("recaps each step from live data: done, skipped (with the way back), or not known yet", () => {
    const html = view("done", { ui: ui({ repos: ok([repo("acme-gh/web")]), invites: loading([]) }) });
    expect(html).toContain('data-welcome-recap="github" data-state="done"');
    expect(html).toContain('data-welcome-recap="agent" data-state="todo"');
    expect(html).toContain('data-welcome-recap="team" data-state="unknown"');
    expect(text(html)).toContain("Your team: not known yet");
    expect(html).toMatch(/data-act="welcomeGo" data-arg="agent" data-field="welcomeRecap:agent"[^>]*>Do it now</);
    expect(html).not.toContain('data-field="welcomeRecap:github"');
    expect(html).not.toContain('data-field="welcomeRecap:team"'); // not known: no claim that it is still to do
    expect(text(html)).toContain("You're in");
    expect(text(html)).not.toContain("You're set");
  });
  it("says “You're set” only when everything really is", () => {
    const html = view("done", { ui: ui({ repos: ok([repo("acme-gh/web")]), invites: ok([invite()]) }), grants: ok([grant()]) });
    expect(text(html)).toContain("You're set");
    expect(html).not.toContain(">Do it now<");
  });
  it("a member's closing step: their agent only, the same first-session primer", () => {
    const html = view("done", { org: org("member") });
    expect(html).toContain('data-welcome-recap="agent"');
    expect(html).not.toContain('data-welcome-recap="github"');
    expect(html).not.toContain('data-welcome-recap="team"');
    expect(html).toContain("data-welcome-first");
    expect(html).toMatch(/data-arg="agent" data-field="welcomeBack"/);
  });
});

// ── coming back from GitHub ──────────────────────────────────────────────────
describe("a return the wizard sent away comes back to it", () => {
  const now = 1_800_000_000_000;
  const note = (o: Partial<WelcomeReturn> = {}): WelcomeReturn => ({ slug: "acme", why: "link", at: now - 60_000, ...o });
  it("after linking a GitHub account (the server returns to Settings): the wizard's repository step", () => {
    expect(welcomeReturnHash(note(), { slug: "acme", hash: "#settings", github: false, now })).toBe("#welcome");
    expect(welcomeReturnHash(note(), { slug: "acme", hash: "#feed", github: false, now })).toBeNull();
  });
  it("after connecting the GitHub App (the server returns to Org settings with ?github=): the same", () => {
    const g = note({ why: "github" });
    expect(welcomeReturnHash(g, { slug: "acme", hash: "#org/repos", github: true, now })).toBe("#welcome");
    expect(welcomeReturnHash(g, { slug: "acme", hash: "#org/repos", github: false, now })).toBeNull();
    expect(welcomeReturnHash(g, { slug: "acme", hash: "#settings", github: true, now })).toBeNull();
  });
  it("only for the same org, only while fresh, and never without a note", () => {
    expect(welcomeReturnHash(null, { slug: "acme", hash: "#settings", github: false, now })).toBeNull();
    expect(welcomeReturnHash(note(), { slug: "other", hash: "#settings", github: false, now })).toBeNull();
    expect(welcomeReturnHash(note({ at: now - WELCOME_RETURN_TTL_MS - 1 }), { slug: "acme", hash: "#settings", github: false, now })).toBeNull();
    expect(welcomeReturnHash(note({ at: now + 5000 }), { slug: "acme", hash: "#settings", github: false, now })).toBeNull();
  });
  it("reads its note defensively", () => {
    expect(parseWelcomeReturn(JSON.stringify(note()))).toEqual(note());
    for (const bad of [null, "", "{", "null", "[]", JSON.stringify({ slug: "acme", why: "other", at: 1 }), JSON.stringify({ slug: 3, why: "link", at: 1 })]) expect(parseWelcomeReturn(bad)).toBeNull();
  });
});

// ── CSS ──────────────────────────────────────────────────────────────────────
describe("trov.css — the wizard's rules", () => {
  it("declares no radius of its own (every one is inline, so the corners block scales it)", () => {
    for (const m of rules.matchAll(/(\.cnpy-wel[^{]*)\{([^}]*)\}/g)) expect(m[2], m[1]).not.toMatch(/border-radius/);
    for (const m of src("welcome.ts").matchAll(/border-radius:(\d+px|\d+%)/g)) expect(rules).toContain(`[style*="border-radius:${m[1]}"]`);
  });
  it("is still under reduced motion, and reflows at phone width", () => {
    expect(rules).toContain("@media (prefers-reduced-motion: reduce) { .cnpy-wel-pulse { animation:none; } .cnpy-wel-stepb { transition:none; } }");
    expect(rules).toMatch(/@media \(max-width: 640px\) \{[^@]*\.cnpy-wel-step:not\(\.is-cur\) \.cnpy-wel-stepl \{ display:none; \}/);
  });
  it("hand-rolls no switch and no native select", () => {
    expect(src("welcome.ts")).not.toMatch(/<select|window\.confirm|●/);
  });
});

describe("the sign-up flow's own count — top right of each card", () => {
  it("names three steps, and the guided setup is the third only when it ends a sign-up", () => {
    expect(firstRunStepLabel(1)).toBe("Step 1 of 3");
    expect(firstRunStepLabel(3)).toBe(`Step 3 of ${FIRST_RUN_STEPS}`);
    const app = (firstRun: boolean): AppState => ({ ...initialState(), view: "app", screen: "welcome", orgSlug: "acme", me: { handle: "ines", name: "Ines Vidal", avatar_url: null, color: "fern", identities: [{ provider: "github", label: "ines" }], orgs: [{ slug: "acme", name: "Acme Robotics", role: "owner", logo_url: null }] } as AppState["me"], welcome: { step: "github", byHand: false, firstRun } });
    const first = render(app(true));
    expect(first).toMatch(/<span class="cnpy-onb-step" data-flow-step="3"[^>]*>Step 3 of 3<\/span>/);
    // The organization is named in the eyebrow, and there is no second "step n of m" beside the stepper.
    expect(first).toContain("setting up Acme Robotics");
    expect(/data-welcome-eyebrow[^>]*>([^<]*)</.exec(first)?.[1]).toBe("Welcome, Ines · setting up Acme Robotics");
    // Reopened later from Org settings or Help: it is not a step of signing up.
    expect(render(app(false))).not.toContain('data-flow-step="3"');
  });
});
