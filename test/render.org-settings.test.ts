/**
 * Org settings (web/src/org-settings.ts + integrations.ts) — pure render tests: props in,
 * markup out. The states an org can be in (empty, fully configured, legacy fallback, an
 * error, secrets unavailable), what a non-admin member sees, the secret form — and that no
 * render of it, before or after a save, carries a secret's value.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import {
  orgSettingsView, orgOverlays, setupSteps, setupChecklist, initialOrgUi, currentOrg, orgTabsFor, effectiveOrgTab, orgConfirmCopy,
  apiUrlMoves, envForm, envFieldsOf, blankEnvFields, inviteDraftOk, repoDraftOk, lastOwnerSentence, memberRoleDropdown,
  type OrgUi, type OrgSettingsProps,
} from "../web/src/org-settings";
import {
  integrationStatus, groupIntegrations, integrationRow, secretFormModal, auditSentence, howToHtml, WEBHOOKS_LIVE,
  type SecretFormState,
} from "../web/src/integrations";
import { render, initialState, type AppState } from "../web/src/render";
import { sidebarView, navKeyOf, NAV_CLOSED } from "../web/src/sidebar";
import { parseHash, hashForRoute } from "../web/src/hash";
import type { IntegrationDTO, IntegrationKind, OrgEnvironmentDTO, OrgRepoDTO, OrgAuditDTO } from "@shared/integrations";
import type { MyOrg, MyOrgsResponse, OrgInvite, OrgMember, OrgRole } from "@shared/orgs";

const SECRET = "ghp_THIS_IS_THE_SECRET_VALUE_1a2b";
const HOOK = "hook_0123456789abcdef0123456789abcdef01234567";

const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme Robotics", role });
function integ(kind: IntegrationKind, o: Partial<IntegrationDTO> = {}): IntegrationDTO {
  const scope_type = kind === "github_webhook" ? "repo" : kind === "railway" || kind === "metrics_endpoint" ? "environment" : "org";
  const label = { github_token: "GitHub token", github_webhook: "GitHub webhook secret", cloudflare_analytics: "Cloudflare analytics", railway: "Railway project token", metrics_endpoint: "App metrics endpoint",
    vercel: "Vercel connection", render: "Render API key", netlify: "Netlify connection", fly: "Fly.io token", aws: "AWS role" }[kind];
  return {
    kind, scope: scope_type === "org" ? "" : scope_type === "repo" ? HOOK : "staging", scope_type,
    scope_label: scope_type === "org" ? null : scope_type === "repo" ? "acme/web" : "Staging",
    label, description: `What ${label} is used for.`, how_to: "Open Settings › Tokens and run `openssl rand -hex 32`.",
    configured: false, legacy_fallback: false, expected: true, hint_last4: "", created_by: null, created_at: null, rotated_at: null,
    last_used_at: null, last_error: null, config: {},
    config_fields: kind === "cloudflare_analytics" ? [{ key: "account_id", label: "Account ID", description: "The 32-character id. Not a secret.", required: true }] : [],
    webhook_url: kind === "github_webhook" ? `https://trov.dev/webhook/github/${HOOK}` : null, ...o,
  };
}
const set = (kind: IntegrationKind, last4: string, o: Partial<IntegrationDTO> = {}): IntegrationDTO =>
  integ(kind, { configured: true, hint_last4: last4, created_by: "andres", created_at: "2026-10-01T10:00:00.000Z", last_used_at: "2026-10-05T10:00:00.000Z", ...o });
const repo = (o: Partial<OrgRepoDTO> = {}): OrgRepoDTO => ({
  id: HOOK, repo_full_name: "acme/web", is_primary: true, legacy_hook: false, webhook_url: `https://trov.dev/webhook/github/${HOOK}`,
  webhook_secret_configured: false, connection: "manual", access_lost: false, created_at: "2026-10-01T10:00:00.000Z", created_by: "andres", ...o,
});
const env = (key: string, position: number, o: Partial<OrgEnvironmentDTO> = {}): OrgEnvironmentDTO => ({
  key, position, label: key[0].toUpperCase() + key.slice(1), note: null, branch: key === "staging" ? "main" : key, railway_env: "", worker: "", worker_check: "",
  frontend_url: `https://${key}.acme.dev`, api_url: `https://api.${key}.acme.dev`, health_path: "/api/health", railway_environment_id: null, railway_service_id: null,
  created_at: "2026-10-01T10:00:00.000Z", updated_at: "2026-10-01T10:00:00.000Z", updated_by: "andres", ...o,
});
const member = (handle: string, role: OrgRole, o: Partial<OrgMember> = {}): OrgMember => ({
  handle, name: handle[0].toUpperCase() + handle.slice(1), color: "moss", avatar_url: null, role, title: null, joined_at: "2026-10-01T10:00:00.000Z", ...o,
});
const invite = (o: Partial<OrgInvite> = {}): OrgInvite => ({
  id: 7, github_login: "octocat", email: null, role: "member", status: "pending", invited_by: "andres", created_at: "2026-10-05T10:00:00.000Z", responded_at: null, responded_by: null, name: null, mail_status: null, mail_at: null, mail_error: null, ...o,
});
const ok = <T,>(data: T) => ({ status: "ok" as const, data });

/** An org an admin has just been handed: one owner, nothing connected. */
function emptyUi(over: Partial<OrgUi> = {}): OrgUi {
  return {
    ...initialOrgUi(), slug: "acme",
    settings: ok({ org: { slug: "acme", name: "Acme Robotics", created_at: "2026-10-01T10:00:00.000Z", created_by: "andres" }, can_edit: true }),
    members: ok([member("andres", "owner")]), invites: ok([]), repos: ok([]), envs: ok([]),
    integrations: ok({ integrations: [integ("github_token"), integ("cloudflare_analytics")], secrets_available: true, key_version: null }),
    // The GitHub App is NOT configured on this deployment (the state every org was in before 0.19):
    // repositories are connected by name. The App's own states are test/render.github-app.test.ts.
    github: ok({ configured: false, installation: null, lost: null }),
    audit: ok([]), ...over,
  };
}
/** The same org, set up. */
function fullUi(over: Partial<OrgUi> = {}): OrgUi {
  return emptyUi({
    members: ok([member("andres", "owner"), member("mira", "admin", { title: "Platform engineer", responsibilities: "Owns deploys." }), member("jonas", "member")]),
    invites: ok([invite(), invite({ id: 8, github_login: null, email: "sam@acme.dev", role: "admin" })]),
    repos: ok([repo({ webhook_secret_configured: true }), repo({ id: "hook_b", repo_full_name: "acme/api", is_primary: false, webhook_url: "https://trov.dev/webhook/github/hook_b" })]),
    envs: ok([env("staging", 0), env("production", 1)]),
    integrations: ok({
      integrations: [
        set("github_token", "1a2b"), set("github_webhook", "9f3a"),
        set("cloudflare_analytics", "aa11", { config: { account_id: "0123456789abcdef0123456789abcdef" } }),
        set("railway", "beef"), set("metrics_endpoint", "27bc"),
        integ("railway", { scope: "production", scope_label: "Production" }), integ("metrics_endpoint", { scope: "production", scope_label: "Production" }),
      ],
      secrets_available: true, key_version: 2,
    }),
    audit: ok<OrgAuditDTO[]>([
      { id: "s3", actor: "andres", action: "key.rotate", target: "org_keys", detail: { key_version: 2, from_version: 1, secrets: 5 }, at: "2026-10-05T12:00:00.000Z" },
      { id: "s2", actor: "mira", action: "secret.rotate", target: "github_token:", detail: { hint_last4: "1a2b", key_version: 1 }, at: "2026-10-05T11:00:00.000Z" },
      { id: "s1", actor: "andres", action: "secret.set", target: "github_token:", detail: { hint_last4: "0000", key_version: 1 }, at: "2026-10-05T10:00:00.000Z" },
    ]),
    ...over,
  });
}
const props = (ui: OrgUi, role: OrgRole = "owner", me = "andres"): OrgSettingsProps => ({ org: org(role), orgsStatus: "ok", me, ui });
const view = (ui: OrgUi, role: OrgRole = "owner") => orgSettingsView(props(ui, role));
const tabView = (ui: OrgUi, tab: OrgUi["tab"], role: OrgRole = "owner") => view({ ...ui, tab }, role);
const form = (o: Partial<SecretFormState> = {}): SecretFormState => ({
  kind: "github_token", scope: "", mode: "set", config: {}, hasValue: false, generated: false, reveal: false, copied: null, saving: false, error: null, errorField: null, ...o,
});

describe("the current org — one place", () => {
  it("is the org the page's path names (`orgSlug`), with my role there — never 'the first of mine'", () => {
    const mine: MyOrgsResponse = { orgs: [org("admin"), { slug: "other", name: "Other", role: "member" }], invites: [], superadmin: false, can_create: true, created: 1, limit: 3 };
    const at = (orgSlug: string | null, data: MyOrgsResponse | null = mine, me: { orgs: MyOrgsResponse["orgs"] } | null = null) => currentOrg({ orgSlug, myOrgs: { data }, me });
    expect(at("acme")?.role).toBe("admin");
    expect(at("other")).toEqual({ slug: "other", name: "Other", role: "member" });
    expect(at(null)).toBeNull();
    expect(at("gone")).toBeNull();
    expect(at("acme", { ...mine, orgs: [] })).toBeNull();
    // Until `GET /api/orgs` lands, `/auth/me`'s copy answers — so the role is known on the first paint.
    expect(at("other", null, { orgs: mine.orgs })?.role).toBe("member");
    // …and once it has landed it wins (a role changed since sign-in).
    expect(at("acme", mine, { orgs: [{ slug: "acme", name: "Acme", role: "member" }] })?.role).toBe("admin");
  });
  it("AppState carries it as `myOrgs`, and Org settings' own state as `org`", () => {
    const s = initialState();
    expect(s.myOrgs).toEqual({ status: "idle", data: null });
    expect(s.org.tab).toBe("integrations");
    // The state can be serialised whole and never holds a secret's value: the form has no field for one.
    expect(Object.keys(form())).not.toContain("secret");
    expect(Object.keys(form())).not.toContain("value");
  });
});

describe("route, hash and sidebar", () => {
  it("#org is Integrations; the other tabs are #org/<tab>; a junk tab falls back", () => {
    expect(parseHash("#org")).toMatchObject({ screen: "org", orgTab: "integrations" });
    expect(parseHash("#org/members")).toMatchObject({ screen: "org", orgTab: "members" });
    expect(parseHash("#org/nope").screen).toBe("mywork");
    for (const h of ["#org", "#org/repos", "#org/environments", "#org/members", "#org/general"]) expect(hashForRoute(parseHash(h))).toBe(h);
    expect(hashForRoute(parseHash("#org/integrations"))).toBe("#org");
  });
  it("the rail has NO Org settings row: the org switcher in its header holds it, and reads as the current place there", () => {
    const base = { collapsed: false, navOpen: NAV_CLOSED, qView: "board" as const, roadmapTab: "narrative" as const, docSpace: "technical", docSpaces: [], counts: { review: 0, maintenance: 0, tickets: 0, handoffs: 0, prompts: 0 }, me: null, displayName: "", logo: "" };
    expect(navKeyOf("org")).toBe("org");
    const html = sidebarView({ ...base, screen: "org", orgSwitcher: "<b>switcher</b>", orgActive: true });
    expect(html).not.toContain('data-act="orgGo"');
    expect(html).not.toContain(">Organization<");
    expect(html).toContain('<div class="cnpy-orgslot is-active"><b>switcher</b></div>');
    expect(sidebarView({ ...base, screen: "feed", orgSwitcher: "<b>switcher</b>" })).toContain('<div class="cnpy-orgslot"><b>switcher</b></div>');
  });
  it("the app renders the screen under its header title, and its hash never carries more than the tab", () => {
    const s: AppState = { ...initialState(), view: "app", screen: "org", orgSlug: "acme", myOrgs: { status: "ok", data: { orgs: [org()], invites: [], superadmin: false, can_create: true, created: 1, limit: 3 } }, org: fullUi() };
    const html = render(s);
    expect(html).toContain('data-screen-label="Org settings"');
    expect(html).toContain(">Org settings<");
  });
});

describe("who sees what — admin vs member", () => {
  it("Integrations and Notifications are admin+; a member's picked tab falls to the first they may open", () => {
    expect(orgTabsFor("owner")).toEqual(["integrations", "repos", "environments", "members", "notifications", "general"]);
    expect(orgTabsFor("admin")).toEqual(orgTabsFor("owner"));
    expect(orgTabsFor("member")).toEqual(["repos", "environments", "members", "general"]);
    expect(effectiveOrgTab("integrations", "member")).toBe("repos");
    expect(effectiveOrgTab("notifications", "member")).toBe("repos");
    expect(effectiveOrgTab("integrations", "admin")).toBe("integrations");
    expect(effectiveOrgTab("notifications", "admin")).toBe("notifications");
  });

  it("a member gets no Integrations tab, no checklist, and nothing that writes", () => {
    // What the API returns to a member: no hook ids or URLs, no responsibilities, no invites, no integrations.
    const ui = fullUi({
      repos: ok([repo({ id: null, webhook_url: null, webhook_secret_configured: false })]),
      invites: { status: "idle", data: [] }, integrations: { status: "idle", data: null }, audit: { status: "idle", data: [] },
      settings: ok({ org: { slug: "acme", name: "Acme Robotics", created_at: "2026-10-01T10:00:00.000Z", created_by: "andres" }, can_edit: false }),
    });
    const all = (["integrations", "repos", "environments", "members", "notifications", "general"] as const).map((t) => tabView(ui, t, "member")).join("\n");
    expect(all).not.toContain('id="org-tab-integrations"');
    expect(all).not.toContain('id="org-tab-notifications"');
    expect(all).not.toContain("data-org-setup");
    expect(all).not.toContain("data-org-integration");
    for (const act of ["orgRepoAdd", "orgRepoPrimary", "orgEnvNew", "orgEnvEdit", "orgEnvMove", "orgInviteSend", "orgInviteRevoke", "orgMemberEdit", "orgNameSave", "orgSecretOpen", "orgConfirm"]) {
      expect(all, act).not.toContain(`data-act="${act}"`);
    }
    expect(all).not.toContain("Webhook URL");
    expect(all).not.toContain("Pending invites");
    expect(all).toContain("You can read this; an admin or an owner can change it.");
    // …but they do read the members, repositories, environments and the name.
    expect(all).toContain("Mira");
    expect(all).toContain("acme/web");
    expect(all).toContain("Staging");
    expect(all).toContain("Only an admin or an owner can rename the org.");
    // No overlay either, even if state somehow asked for one.
    expect(orgOverlays(props({ ...ui, secretForm: form() }, "member"))).toBe("");
  });

  it("an admin who is not an owner cannot rotate the key or touch an owner's role", () => {
    const html = tabView(fullUi(), "integrations", "admin");
    expect(html).toContain("Only an owner can rotate it.");
    expect(html).not.toContain('data-arg="key:"');
    const ed = tabView(fullUi({ memberEdit: { handle: "andres", role: "owner", title: "", responsibilities: "", saving: false, error: null } }), "members", "admin");
    expect(ed).toContain("Only an owner can change an owner's role.");
    expect(ed).toMatch(/<button type="button" id="org-member-role"[^>]* disabled/);
  });
});

describe("the setup checklist", () => {
  it("lists the four steps for a new org's admin, each linking to its tab", () => {
    const steps = setupSteps(emptyUi())!;
    expect(steps.map((s) => [s.key, s.tab, s.done])).toEqual([["repo", "repos", false], ["env", "environments", false], ["token", "integrations", false], ["team", "members", false]]);
    const html = view(emptyUi());
    expect(html).toContain("Finish setting up Acme Robotics");
    expect(html).toContain("0 of 4 done");
    for (const t of ["repos", "environments", "integrations", "members"]) expect(html).toContain(`data-act="orgTab" data-arg="${t}"`);
    // Status is words, not a colour: each step's name says it, and why it matters is its tooltip.
    expect(html).toContain('aria-label="Connect a repository: to do. Open Repositories"');
    expect(html).toContain('title="Trov reads its deployments, checks, pull requests and issues."');
    // ONE line above the tabs: a single heading, no paragraph per step.
    const card = html.slice(html.indexOf("data-org-setup "), html.indexOf("</section>"));
    expect(card.match(/<h2/g)?.length).toBe(1);
    expect(card).not.toContain("<p");
  });
  it("derives each step from live data", () => {
    const ui = emptyUi({ repos: ok([repo()]), invites: ok([invite()]) });
    const steps = setupSteps(ui)!;
    expect(steps.find((s) => s.key === "repo")!.done).toBe(true);
    expect(steps.find((s) => s.key === "team")!.done).toBe(true);
    expect(steps.find((s) => s.key === "env")!.done).toBe(false);
    const html = setupChecklist(org(), ui);
    expect(html).toContain("2 of 4 done");
    expect(html).toMatch(/data-step="repo" data-done="1">[\s\S]*?<span class="cnpy-sr">: done<\/span>/);
    // A finished step keeps no button.
    expect(html).not.toContain('data-arg="repos"');
  });
  it("'Invite your team' is done by a pending invite or a second member — never by the owner's own accepted invitation", () => {
    const team = (ui: OrgUi) => setupSteps(ui)!.find((s) => s.key === "team")!.done;
    // The superadmin's owner invite, accepted: the owner is in, and has invited nobody yet.
    expect(team(emptyUi({ invites: ok([invite({ status: "accepted", role: "owner", github_login: null, email: "owner@acme.dev" })]) }))).toBe(false);
    expect(team(emptyUi({ invites: ok([invite({ status: "revoked" })]) }))).toBe(false);
    expect(team(emptyUi({ invites: ok([invite({ status: "pending" })]) }))).toBe(true);
    expect(team(emptyUi({ members: ok([member("ines", "owner"), member("sam", "member")]) }))).toBe(true);
  });
  it("counts the platform's legacy credential as a set GitHub token", () => {
    const ui = emptyUi({ integrations: ok({ integrations: [integ("github_token", { legacy_fallback: true })], secrets_available: true, key_version: null }) });
    expect(setupSteps(ui)!.find((s) => s.key === "token")!.done).toBe(true);
  });
  it("disappears once complete, is never shown to a member, and waits for the data", () => {
    expect(setupChecklist(org(), fullUi())).toBe("");
    expect(view(fullUi())).not.toContain("data-org-setup");
    expect(setupChecklist(org("member"), emptyUi())).toBe("");
    expect(setupSteps(emptyUi({ repos: { status: "loading", data: [] } }))).toBeNull();
    expect(setupChecklist(org(), emptyUi({ repos: { status: "loading", data: [] } }))).toBe("");
  });
});

describe("Integrations — status in words", () => {
  it("names each state", () => {
    expect(integrationStatus(integ("github_token"))).toMatchObject({ state: "unset", word: "Not set" });
    expect(integrationStatus(set("github_token", "1a2b"))).toMatchObject({ state: "set", word: "Set" });
    expect(integrationStatus(set("github_token", ""))).toMatchObject({ state: "set", word: "Set" });
    expect(integrationStatus(integ("github_token", { legacy_fallback: true }))).toMatchObject({ state: "legacy", word: "Using legacy credential" });
    expect(integrationStatus(set("github_token", "1a2b", { last_error: "github 401" }))).toMatchObject({ state: "error", word: "Error" });
    expect(integrationStatus(set("railway", "beef", { expected: false }))).toMatchObject({ state: "orphan" });
  });
  it("groups GitHub, Cloudflare, then one group per environment, then what nothing claims", () => {
    const list = [...fullUi().integrations.data!.integrations, set("railway", "dead", { scope: "old", scope_label: null, expected: false })];
    expect(groupIntegrations(list).map((g) => [g.key, g.rows.length])).toEqual([["github", 2], ["cloudflare", 1], ["env:staging", 2], ["env:production", 2], ["orphans", 1]]);
  });
});

describe("Integrations — the states of the page", () => {
  it("empty org: every expected integration is listed as Not set, with where to go next", () => {
    const html = tabView(emptyUi(), "integrations");
    expect(html).toContain('data-org-integration="github_token:" data-state="unset"');
    expect(html).toContain('data-org-integration="cloudflare_analytics:" data-state="unset"');
    expect(html).toContain("Not set");
    expect(html).toContain("What GitHub token is used for.");
    expect(html).toContain('aria-label="Set the GitHub token"');
    expect(html).toContain("None is connected yet.");
    expect(html).toContain("Add an environment first.");
    expect(html).toContain("There is no key yet.");
    expect(html).toContain("Nothing yet. Every secret set, rotated or deleted is recorded here.");
    expect(html).not.toContain("Test connection");
  });

  it("fully configured: last four, who and when, the actions, the key and the history", () => {
    const html = tabView(fullUi(), "integrations");
    expect(html).toContain('data-org-integration="github_token:" data-state="set"');
    expect(html).toMatch(/<span>GitHub token<\/span><span[^>]*>Set<\/span>/);
    expect(html).toContain("ends in 1a2b");
    expect(html).toContain("Set by andres");
    expect(html).toContain("last used");
    expect(html).toContain('aria-label="Test the GitHub token"');
    expect(html).toContain('aria-label="Rotate the GitHub token"');
    expect(html).toContain('aria-label="Delete the GitHub token"');
    expect(html).toContain("Account ID:");
    expect(html).toContain("0123456789abcdef0123456789abcdef");
    expect(html).toContain('aria-label="Edit the settings of the Cloudflare analytics"');
    expect(html).toContain("Staging environment");
    expect(html).toContain("Production environment");
    // The lead: the tab's state in one sentence, and no accent button once the token is set.
    expect(html).toMatch(/<strong>\d+ of \d+<\/strong> credentials set/);
    expect(html).not.toContain('data-field="orgLeadToken"');
    expect(html).not.toContain("cnpy-accentbtn");
    expect(html).toContain("now version 2");
    expect(html).toContain('data-act="orgConfirm" data-arg="key:"');
    // History: who did what, never a value.
    expect(html).toContain("rotated the encryption key to version 2 (5 secrets re-encrypted)");
    expect(html).toContain("rotated the GitHub token (ends in 1a2b)");
    expect(html).toContain("set the GitHub token (ends in 0000)");
  });

  it("legacy fallback: says so, offers Set your own and a test — never 'not configured'", () => {
    const ui = fullUi({ integrations: ok({ integrations: [integ("github_token", { legacy_fallback: true })], secrets_available: true, key_version: null }) });
    const html = tabView(ui, "integrations");
    expect(html).toContain('data-state="legacy"');
    expect(html).toContain("Using legacy credential");
    expect(html).toContain("Using the platform's legacy credential &mdash; set your own to replace it.");
    expect(html).toContain(">Set your own<");
    expect(html).toContain('aria-label="Test the GitHub token"');
    expect(html).not.toContain(">Not set<");
    expect(html).not.toContain('aria-label="Delete the GitHub token"');
  });

  it("error state: the chip says Error and the last error is shown", () => {
    const ui = fullUi({ integrations: ok({ integrations: [set("github_token", "1a2b", { last_error: "github 401 for acme/web — the token is not valid" })], secrets_available: true, key_version: 1 }) });
    const html = tabView(ui, "integrations");
    expect(html).toContain('data-state="error"');
    expect(html).toMatch(/<span>GitHub token<\/span><span[^>]*>Error<\/span>/);
    expect(html).toContain("1 with an error");
    // The error is on the row WITHOUT opening it; the description is behind it.
    const row = html.slice(html.indexOf('data-org-integration="github_token:"'), html.indexOf("</li>", html.indexOf('data-org-integration="github_token:"')));
    expect(row.indexOf("data-org-lasterror")).toBeLessThan(row.indexOf('class="cnpy-xrow-b" hidden'));
    expect(row.indexOf("What GitHub token is used for.")).toBeGreaterThan(row.indexOf('class="cnpy-xrow-b" hidden'));
    expect(html).toContain("data-org-lasterror");
    expect(html).toContain("github 401 for acme/web — the token is not valid");
    // The tab's badge counts it.
    expect(html).toMatch(/id="org-tab-integrations"[^>]*>Integrations<span class="cnpy-badge" data-n="1"/);
  });

  it("secrets unavailable: a banner, and Set / Rotate / Test disabled (Delete still works)", () => {
    const d = fullUi().integrations.data!;
    const html = tabView(fullUi({ integrations: ok({ ...d, secrets_available: false }) }), "integrations");
    expect(html).toContain("data-org-unavailable");
    expect(html).toContain("Secrets can&#39;t be saved yet");
    expect(html).toContain("TROV_KEK");
    expect(html).toMatch(/data-field="orgSecretOpen:rotate:github_token:" disabled/);
    expect(html).toMatch(/data-field="orgSecretTest:github_token:" disabled/);
    expect(html).toMatch(/data-field="orgSecretOpen:set:railway:production" disabled/);
    expect(html).toMatch(/data-field="orgConfirm:key:" disabled/);
    expect(html).not.toMatch(/data-field="orgConfirm:secret:github_token:" disabled/);
    expect(tabView(fullUi(), "integrations")).not.toContain("data-org-unavailable");
  });

  it("a test's answer shows inline, as a success or as a failure, in words", () => {
    const okRow = integrationRow(set("github_token", "1a2b"), { secretsAvailable: true, test: { status: "done", ok: true, detail: "Read acme/web as trov-bot." } });
    expect(okRow).toContain('data-org-test="ok"');
    expect(okRow).toContain("Connection works.");
    expect(okRow).toContain("Read acme/web as trov-bot.");
    const bad = integrationRow(set("github_token", "1a2b"), { secretsAvailable: true, test: { status: "done", ok: false, detail: "github 401 <b>" } });
    expect(bad).toContain('data-org-test="failed"');
    expect(bad).toContain("Test failed.");
    expect(bad).toContain("github 401 &lt;b&gt;");
    const running = integrationRow(set("github_token", "1a2b"), { secretsAvailable: true, test: { status: "running" } });
    expect(running).toContain("Testing…");
    expect(running).toMatch(/data-field="orgSecretTest:github_token:" disabled aria-busy="true"/);
  });

  it("per-repo webhooks are live: the row shows the Payload URL and says what to do with it; nothing says 'soon'", () => {
    expect(WEBHOOKS_LIVE).toBe(true);
    const url = `https://trov.dev/webhook/github/${HOOK}`;
    const stored = integrationRow(set("github_webhook", "9f3a"), { secretsAvailable: true });
    expect(stored).toContain("data-org-hookurl");
    expect(stored).toContain(url);
    expect(stored).toContain("The Payload URL of this repository's webhook on GitHub.");
    // Not set yet: the order to do it in, and what happens meanwhile.
    const unset = integrationRow(integ("github_webhook"), { secretsAvailable: true });
    expect(unset).toContain(url);
    expect(unset).toContain("Set the secret first, then add a webhook on GitHub with this Payload URL and the same secret.");
    // SaplingLearn's cut-over: the platform's credential still answers; moving is spelled out.
    expect(integrationRow(integ("github_webhook", { legacy_fallback: true }), { secretsAvailable: true })).toContain("keeps working with the platform's credential");
    for (const html of [stored, unset, secretFormModal(integ("github_webhook"), form({ kind: "github_webhook", scope: HOOK })), tabView(fullUi(), "repos"), tabView(emptyUi({ repos: ok([repo()]) }), "repos")]) {
      expect(html).not.toContain("available soon");
      expect(html).not.toContain("not live yet");
    }
    const repos = tabView(fullUi(), "repos");
    expect(repos).toContain("Deliveries are checked against the secret set in Integrations.");
    expect(tabView(emptyUi({ repos: ok([repo()]) }), "repos")).toContain("Deliveries to this URL are rejected until its webhook secret is set in Integrations.");
  });

  it("a webhook secret is checked by its deliveries, not by a call: 'Check deliveries', and no delivery yet is a wait, not a failure", () => {
    const key = `github_webhook:${HOOK}`;
    const row = (test?: { status: "done"; ok: boolean; detail: string }) => integrationRow(set("github_webhook", "9f3a"), { secretsAvailable: true, test });
    expect(row()).toContain(`data-field="orgSecretTest:${key}"`);
    expect(row()).toContain("Check deliveries");
    expect(row()).not.toContain("Test connection");
    const waiting = row({ status: "done", ok: false, detail: "No verified delivery yet." });
    expect(waiting).toContain('data-org-test="waiting"');
    expect(waiting).toContain("Nothing has arrived yet.");
    expect(waiting).toContain("var(--amber)");
    expect(waiting).not.toContain("Test failed.");
    const arriving = row({ status: "done", ok: true, detail: "Last verified delivery at 2026-10-05T10:00:00.000Z." });
    expect(arriving).toContain('data-org-test="ok"');
    expect(arriving).toContain("Deliveries are arriving.");
    // Every other kind keeps the plain verdict.
    const token = integrationRow(set("github_token", "1a2b"), { secretsAvailable: true, test: { status: "done", ok: false, detail: "401" } });
    expect(token).toContain("Test connection");
    expect(token).toContain("Test failed.");
    expect(token).toContain('data-org-test="failed"');
  });

  it("a stored secret nothing expects can only be deleted", () => {
    const row = integrationRow(set("railway", "dead", { scope: "old", scope_label: null, expected: false }), { secretsAvailable: true });
    expect(row).toContain('data-state="orphan"');
    expect(row).toContain("Delete it.");
    expect(row).not.toContain("orgSecretOpen");
    expect(row).not.toContain("orgSecretTest");
    expect(row).toContain('data-act="orgConfirm" data-arg="secret:railway:old"');
  });

  it("the history names a removed integration without printing a hook id", () => {
    const a = (o: Partial<OrgAuditDTO>): OrgAuditDTO => ({ id: "s1", actor: "andres", action: "secret.delete", target: `github_webhook:${HOOK}`, detail: { hint_last4: "9f3a", reason: "repo_removed" }, at: "2026-10-05T10:00:00.000Z", ...o });
    expect(auditSentence(a({}), [])).toBe("deleted the GitHub webhook secret of a removed repository (ends in 9f3a) when its repository was removed");
    expect(auditSentence(a({ target: "metrics_endpoint:staging", detail: { hint_last4: "27bc", reason: "api_url_changed" } }), [])).toBe("deleted the App metrics endpoint for staging (ends in 27bc) when the environment's API URL moved to another host");
    expect(auditSentence(a({ action: "integration.config", target: "cloudflare_analytics:", detail: { keys: ["account_id"] } }), [])).toBe("changed the settings of the Cloudflare analytics");
  });
});

describe("the secret form", () => {
  it("is a labelled dialog with a password input that is never pre-filled", () => {
    const html = secretFormModal(integ("github_token"), form());
    expect(html).toContain('data-overlay="org-secret"');
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="org-secret-t"');
    expect(html).toContain("Set the GitHub token");
    const input = html.match(/<input id="org-secret-value"[^>]*>/)![0];
    expect(input).toContain('type="password"');
    expect(input).toContain('autocomplete="new-password"');
    expect(input).toContain('spellcheck="false"');
    expect(input).toContain('data-enter="orgSecretSave"');
    expect(input).not.toMatch(/\svalue=/);
    expect(html).toContain('<label for="org-secret-value"');
    // The instructions sit beside it, with `code` runs marked up.
    expect(html).toContain("Where to get it");
    expect(html).toContain("Open Settings › Tokens and run <code");
    expect(howToHtml("a <b> `x`")).toBe('a &lt;b&gt; <code style="font-family:var(--code);font-size:11.5px;color:var(--fg)">x</code>');
    // Nothing to save yet.
    expect(html).toMatch(/data-field="orgSecretSave" disabled/);
    expect(html).not.toContain("orgSecretGenerate");
  });

  it("shows the kind's config fields beside the credential, and their error under the field", () => {
    const cf = integ("cloudflare_analytics");
    const html = secretFormModal(cf, form({ kind: "cloudflare_analytics", hasValue: true }));
    expect(html).toContain('<label for="org-secret-cfg-account_id"');
    expect(html).toContain("Account ID");
    expect(html).toContain("(required)");
    expect(html).toContain("The 32-character id. Not a secret.");
    // The required setting is missing: still not saveable.
    expect(html).toMatch(/data-field="orgSecretSave" disabled/);
    const filled = secretFormModal(cf, form({ kind: "cloudflare_analytics", hasValue: true, config: { account_id: "0123456789abcdef0123456789abcdef" } }));
    expect(filled).not.toMatch(/data-field="orgSecretSave" disabled/);
    expect(filled).toContain('value="0123456789abcdef0123456789abcdef"'); // a setting, not a secret
    const err = secretFormModal(cf, form({ kind: "cloudflare_analytics", hasValue: true, config: { account_id: "nope" }, error: "Account ID must be the 32-character hexadecimal Cloudflare account id.", errorField: "config.account_id" }));
    expect(err).toContain('id="org-secret-cfg-account_id-e" role="alert"');
    expect(err).toContain('aria-invalid="true"');
  });

  it("a server refusal about the value sits under the value field", () => {
    const html = secretFormModal(integ("github_webhook"), form({ kind: "github_webhook", scope: HOOK, hasValue: true, error: "A webhook secret needs at least 16 characters.", errorField: "secret" }));
    expect(html).toContain('id="org-secret-e" role="alert"');
    expect(html).toContain("A webhook secret needs at least 16 characters.");
    expect(html).toMatch(/<input id="org-secret-value"[^>]*aria-invalid="true"/);
  });

  it("offers Generate for the two kinds whose value the admin makes up, and Copy once generated", () => {
    for (const kind of ["github_webhook", "metrics_endpoint"] as const) {
      const i = integ(kind);
      expect(secretFormModal(i, form({ kind, scope: i.scope })), kind).toContain('data-act="orgSecretGenerate"');
    }
    for (const kind of ["github_token", "cloudflare_analytics", "railway"] as const) {
      const i = integ(kind);
      expect(secretFormModal(i, form({ kind, scope: i.scope })), kind).not.toContain("orgSecretGenerate");
    }
    const i = integ("metrics_endpoint");
    const gen = secretFormModal(i, form({ kind: "metrics_endpoint", scope: "staging", hasValue: true, generated: true }));
    expect(gen).toContain('data-act="orgSecretCopy"');
    expect(gen).toContain("after you save, Trov never shows it again");
    expect(gen).toMatch(/<input id="org-secret-value"[^>]*type="password"/);
    // Show is for the generated value only, and is how a refused clipboard is worked around.
    expect(secretFormModal(i, form({ kind: "metrics_endpoint", scope: "staging", hasValue: true, generated: true, reveal: true }))).toMatch(/<input id="org-secret-value"[^>]*type="text"/);
    expect(secretFormModal(i, form({ kind: "metrics_endpoint", scope: "staging", hasValue: true, generated: false, reveal: true }))).toMatch(/<input id="org-secret-value"[^>]*type="password"/);
    expect(secretFormModal(i, form({ kind: "metrics_endpoint", scope: "staging", hasValue: true, generated: true, copied: "failed" }))).toContain("Couldn't reach the clipboard. Choose Show, then select the value and copy it yourself.");
    expect(secretFormModal(i, form({ kind: "metrics_endpoint", scope: "staging", hasValue: true, generated: true, copied: "yes" }))).toContain("Copied to the clipboard.");
  });

  it("rotate asks only for the new value; settings-only has no secret field at all", () => {
    const cf = set("cloudflare_analytics", "aa11", { config: { account_id: "0123456789abcdef0123456789abcdef" } });
    const rot = secretFormModal(cf, form({ kind: "cloudflare_analytics", mode: "rotate" }));
    expect(rot).toContain("Rotate the Cloudflare analytics");
    expect(rot).toContain("It replaces the current value (ends in aa11) the moment you save.");
    expect(rot).not.toContain("org-secret-cfg-account_id");
    const cfg = secretFormModal(cf, form({ kind: "cloudflare_analytics", mode: "config", config: { ...cf.config } }));
    expect(cfg).not.toContain("org-secret-value");
    expect(cfg).toContain("Save settings");
  });
});

describe("a secret's value is never in the markup", () => {
  it("cannot be: no prop of the form or the page carries one", () => {
    // What state looks like WHILE a value is typed: only `hasValue`. Render everything.
    const typing = fullUi({ secretForm: form({ hasValue: true }) });
    const during = view(typing) + orgOverlays(props(typing));
    expect(during).not.toContain(SECRET);
    expect(during).toContain('id="org-secret-value"');
  });

  it("after a successful save the page shows the last four and nothing else", () => {
    // The save's answer: the server's row (hint only), the form closed.
    const d = fullUi().integrations.data!;
    const saved = fullUi({
      secretForm: null,
      integrations: ok({ ...d, integrations: d.integrations.map((i) => (i.kind === "github_token" ? set("github_token", SECRET.slice(-4)) : i)) }),
      audit: ok<OrgAuditDTO[]>([{ id: "s9", actor: "andres", action: "secret.set", target: "github_token:", detail: { hint_last4: SECRET.slice(-4), key_version: 2 }, at: "2026-10-06T10:00:00.000Z" }]),
    });
    const s: AppState = {
      ...initialState(), view: "app", screen: "org", orgSlug: "acme", toast: "Saved the GitHub token", toastAt: Date.now(), toastMs: 2200,
      myOrgs: { status: "ok", data: { orgs: [org()], invites: [], superadmin: false, can_create: true, created: 1, limit: 3 } }, org: saved,
    };
    const html = render(s);
    expect(html).toContain("ends in 1a2b");
    expect(html).toContain("set the GitHub token (ends in 1a2b)");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(SECRET.slice(0, -4));
    expect(html).not.toContain('data-overlay="org-secret"');
    expect(html).not.toContain("org-secret-value");
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(hashForRoute({ screen: "org", ticketId: null, sprintId: null, orgTab: s.org.tab })).toBe("#org");
  });
});

describe("Repositories", () => {
  it("empty: an add field for an admin, and what a repository is for", () => {
    const html = tabView(emptyUi(), "repos");
    expect(html).toContain('id="org-repo"');
    expect(html).toContain('aria-label="Repository to add, as owner/repo"');
    expect(html).toContain("No repository connected");
    expect(html).toMatch(/data-act="orgRepoAdd"[^>]* disabled/);
    expect(repoDraftOk("acme/web")).toBe(true);
    expect(repoDraftOk("acme")).toBe(false);
    expect(repoDraftOk("acme/web/extra")).toBe(false);
  });
  it("lists them with the primary marked in words; the primary cannot go while another exists", () => {
    const html = tabView(fullUi(), "repos");
    expect(html).toContain(">Primary<");
    expect(html).toContain('aria-label="Make acme/api the primary repository"');
    expect(html).toMatch(/aria-label="Remove acme\/web"[^>]*|data-field="orgConfirm:repo:hook_0123[^"]*" disabled/);
    expect(html).toContain("To remove it, make another repository the primary first.");
    expect(html).toContain("Webhook secret set");
    expect(html).toContain("Webhook secret not set");
    expect(html).toContain("1 without a webhook secret");
    // Remove is text, last, behind the row; nothing on the page is a bordered Delete.
    expect(html).toMatch(/aria-label="Remove acme\/api"[^>]*class="cnpy-org-danger"/);
    expect(html).not.toContain("cnpy-rejectbtn");
  });
  it("removing one says its webhook secret goes too", () => {
    const ui = fullUi();
    const c = orgConfirmCopy({ what: "repo", arg: HOOK, busy: false }, org(), ui)!;
    expect(c.title).toBe("Remove acme/web?");
    expect(c.body).toContain("Its webhook secret is removed too");
    const modal = orgOverlays(props({ ...ui, confirm: { what: "repo", arg: HOOK, busy: false } }));
    expect(modal).toContain('role="alertdialog"');
    expect(modal).toContain('data-confirm-act="orgConfirmGo" data-confirm-cancel="orgConfirmCancel"');
    expect(modal).toContain("Remove repository");
  });
  it("a refusal sits beside the field", () => {
    const html = tabView(emptyUi({ repoDraft: "acme/web", repoError: "That repository is already connected." }), "repos");
    expect(html).toContain('id="org-repo-e" role="alert"');
    expect(html).toContain('aria-invalid="true" aria-describedby="org-repo-e"');
  });
});

describe("Environments", () => {
  it("empty: one clear action", () => {
    const html = tabView(emptyUi(), "environments");
    expect(html).toContain("No environments yet");
    expect(html).toContain('data-act="orgEnvNew"');
  });
  it("lists them in order and says what the order means; reorder is up / down buttons", () => {
    const html = tabView(fullUi(), "environments");
    expect(html.indexOf(">Staging<")).toBeLessThan(html.indexOf(">Production<"));
    expect(html).toContain("drift is measured from <strong>Staging</strong> (the head, first) to <strong>Production</strong> (the base, last)");
    // Add environment is the tab's one accent button; Delete is in the edit form, not on every row.
    expect(html.match(/cnpy-accentbtn/g)?.length).toBe(1);
    expect(html).not.toContain("orgConfirm:env:");
    const editing = tabView(fullUi({ envEdit: { key: "staging", keyDraft: "staging", fields: envFieldsOf(env("staging", 0)), advanced: false, saving: false, error: null, errorField: null } }), "environments");
    expect(editing).toMatch(/data-field="orgConfirm:env:staging"[^>]*aria-label="Delete Staging"[^>]*class="cnpy-org-danger"/);
    expect(html).toContain("Drift head");
    expect(html).toContain("Drift base");
    // Real buttons with names; the ends are disabled rather than missing.
    expect(html).toMatch(/data-act="orgEnvMove" data-arg="staging:up"[^>]*aria-label="Move Staging up"[^>]* disabled/);
    expect(html).toMatch(/data-act="orgEnvMove" data-arg="staging:down"[^>]*aria-label="Move Staging down" title="Move down" class/);
    expect(html).toMatch(/data-act="orgEnvMove" data-arg="production:down"[^>]* disabled/);
    expect(html).not.toContain("draggable");
  });
  it("the form has every field of the DTO, the less common ones under Advanced", () => {
    const d = { key: null, keyDraft: "", fields: blankEnvFields(), advanced: false, saving: false, error: null, errorField: null };
    const html = envForm(d, null, false);
    for (const f of ["key", "label", "note", "branch", "frontend_url", "api_url", "health_path", "railway_env", "worker", "worker_check", "railway_environment_id", "railway_service_id"]) {
      expect(html, f).toContain(`id="org-env-${f}"`);
      expect(html, f).toContain(`<label for="org-env-${f}"`);
    }
    expect(html).toContain('data-act="orgEnvAdvanced" data-field="orgEnvAdvanced" aria-expanded="false" aria-controls="org-env-adv"');
    expect(html).toContain('<div id="org-env-adv" hidden>');
    expect(html.indexOf('id="org-env-worker"')).toBeGreaterThan(html.indexOf('id="org-env-adv"'));
    expect(html.indexOf('id="org-env-api_url"')).toBeLessThan(html.indexOf('id="org-env-adv"'));
    expect(envForm({ ...d, advanced: true }, null, false)).toContain('<div id="org-env-adv">');
    // An error on an advanced field opens the disclosure so the message is seen.
    const err = envForm({ ...d, error: "Railway service ID must be an id (letters, digits and hyphens).", errorField: "railway_service_id" }, null, false);
    expect(err).toContain('<div id="org-env-adv">');
    expect(err).toContain('id="org-env-railway_service_id-e" role="alert"');
  });
  it("warns BEFORE saving that an API host change deletes the metrics token", () => {
    const cur = env("staging", 0);
    expect(apiUrlMoves(cur, "https://api.staging.acme.dev/v2")).toBe(false); // same origin
    expect(apiUrlMoves(cur, "https://evil.example")).toBe(true);
    expect(apiUrlMoves(cur, "")).toBe(true);
    expect(apiUrlMoves(env("staging", 0, { api_url: "" }), "https://api.acme.dev")).toBe(false); // nothing was aimed anywhere
    expect(apiUrlMoves(null, "https://api.acme.dev")).toBe(false);
    const d = { key: "staging", keyDraft: "staging", fields: { ...envFieldsOf(cur), api_url: "https://elsewhere.example" }, advanced: false, saving: false, error: null, errorField: null };
    const html = envForm(d, cur, true);
    expect(html).toContain("Saving this deletes the app metrics token");
    expect(html).toContain("Save and delete token");
    expect(envForm({ ...d, fields: envFieldsOf(cur) }, cur, true)).not.toContain("deletes the app metrics token");
    expect(envForm(d, cur, false)).toContain("None is stored right now, so nothing is lost.");
  });
  it("deleting one names the secrets that go with it", () => {
    const ui = fullUi();
    const c = orgConfirmCopy({ what: "env", arg: "staging", busy: false }, org(), ui)!;
    expect(c.title).toBe("Delete the “Staging” environment?");
    expect(c.body).toContain("Railway project token, App metrics endpoint");
    expect(orgConfirmCopy({ what: "env", arg: "production", busy: false }, org(), ui)!.body).toContain("No secrets are stored for it.");
  });
});

describe("Members and invites", () => {
  it("lists members with their role in words, and the invite form for an admin", () => {
    const html = tabView(fullUi(), "members");
    for (const w of [">Owner<", ">Admin<", ">Member<", "YOU", "Platform engineer"]) expect(html).toContain(w);
    expect(html).toContain('data-seg="org-invite-by"');
    expect(html).toContain('aria-label="GitHub login to invite"');
    expect(html).toContain('aria-label="Role the invite grants: As member"');
    expect(html).toContain("@octocat");
    expect(html).toContain("sam@acme.dev");
    expect(html).toContain('aria-label="Revoke the invite for sam@acme.dev"');
    expect(html).toMatch(/<h2[^>]*>Pending invites<\/h2><span class="cnpy-badge" data-n="2">2<\/span>/);
    expect(html).toContain("<strong>3</strong> members &middot; <strong>2</strong> invites pending");
    // Inviting is the tab's one accent action; Revoke is text.
    expect(html).toMatch(/data-act="orgInviteRevoke"[^>]*class="cnpy-org-danger"/);
    // A click on a person opens the same person card as everywhere else.
    expect(html).toContain('data-act="openPerson" data-arg="mira"');
  });
  it("validates the address before sending", () => {
    expect(inviteDraftOk("github", "octocat")).toBe(true);
    expect(inviteDraftOk("github", "@octocat")).toBe(true);
    expect(inviteDraftOk("github", "octo cat")).toBe(false);
    expect(inviteDraftOk("email", "sam@acme.dev")).toBe(true);
    expect(inviteDraftOk("email", "sam")).toBe(false);
    expect(tabView(fullUi({ inviteBy: "email", inviteDraft: "sam" }), "members")).toMatch(/data-act="orgInviteSend"[^>]* disabled/);
  });
  it("the editor changes role and title; only an owner may grant Owner", () => {
    const edit = { handle: "mira", role: "admin" as const, title: "Platform engineer", responsibilities: "Owns deploys.", saving: false, error: null };
    const asOwner = tabView(fullUi({ memberEdit: edit }), "members", "owner");
    // The role is the app's dropdown (dropdown.ts): the trigger says the role, its menu the choices.
    expect(asOwner).toMatch(/id="org-member-role"[^>]*><span class="cnpy-dd-v">Admin<\/span>/);
    expect(memberRoleDropdown({ role: "admin" }, edit, "owner").options.map((o) => o.value)).toEqual(["owner", "admin", "member"]);
    expect(asOwner).toContain('value="Platform engineer"');
    expect(asOwner).toContain("Owns deploys.");
    expect(asOwner).toContain('data-act="orgConfirm" data-arg="member:mira"');
    const asAdmin = tabView(fullUi({ memberEdit: edit }), "members", "admin");
    expect(memberRoleDropdown({ role: "admin" }, edit, "admin").options.map((o) => o.value)).toEqual(["admin", "member"]);
  });
  it("surfaces the last-owner rule as a sentence, before and after the server says it", () => {
    const edit = { handle: "andres", role: "owner" as const, title: "", responsibilities: "", saving: false, error: null };
    const html = tabView(fullUi({ memberEdit: edit }), "members");
    expect(html).toContain("Andres is the only owner. Make someone else an owner before changing this.");
    expect(html).toMatch(/data-field="orgConfirm:member:andres"[^>]* disabled/);
    const refused = tabView(fullUi({ memberEdit: { ...edit, role: "admin", error: lastOwnerSentence("Andres") } }), "members");
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("Andres is the only owner. Make someone else an owner first, then try again.");
  });
  it("is the one place people are managed: nothing points to Maintenance any more", () => {
    for (const role of ["owner", "member"] as const) {
      const html = tabView(fullUi(), "members", role);
      expect(html, role).not.toContain("goMaintenance");
      expect(html, role).not.toContain("Maintenance");
    }
  });
});

describe("General", () => {
  it("an admin edits the name; the slug is read-only", () => {
    const html = tabView(fullUi(), "general");
    expect(html).toContain('<label for="org-name"');
    expect(html).toContain('value="Acme Robotics"');
    expect(html).toMatch(/data-act="orgNameSave"[^>]* disabled/); // nothing changed yet
    expect(html).toContain("<code");
    expect(html).toContain(">acme</code>");
    expect(html).toContain("It cannot be changed.");
    expect(html).not.toMatch(/<input[^>]*value="acme"/);
    expect(tabView(fullUi({ nameDraft: "Acme Inc" }), "general")).not.toMatch(/data-act="orgNameSave"[^>]* disabled/);
  });
});

describe("before the data lands", () => {
  it("says what it is waiting for, what failed, and when there is no org", () => {
    expect(orgSettingsView({ org: null, orgsStatus: "loading", me: "", ui: initialOrgUi() })).toContain("Loading your org");
    expect(orgSettingsView({ org: null, orgsStatus: "error", me: "", ui: initialOrgUi() })).toContain("Couldn't load your orgs.");
    expect(orgSettingsView({ org: null, orgsStatus: "ok", me: "", ui: initialOrgUi() })).toContain("This organization isn&#39;t open");
    expect(view({ ...initialOrgUi(), slug: "acme" })).toContain("Loading integrations");
    const failed = view({ ...initialOrgUi(), slug: "acme", integrations: { status: "error", data: null, error: "503" } });
    expect(failed).toContain("Couldn't load integrations.");
    expect(failed).toContain('data-act="orgReload"');
  });
});

describe("phone width and accessibility hooks", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  it("rows wrap and the actions drop under the text; the form's two columns stack", () => {
    expect(rules).toMatch(/\.cnpy-org-row \{[^}]*flex-wrap:wrap;/);
    expect(rules).toMatch(/@media \(max-width:640px\) \{ \.cnpy-org-actions \{ width:100%; \}/);
    expect(rules).toMatch(/@media \(max-width:760px\) \{ \.cnpy-org-secretgrid \{ grid-template-columns:minmax\(0,1fr\);/);
    expect(rules).toMatch(/\.cnpy-org-grid \{[^}]*minmax\(min\(240px,100%\),1fr\)/);
    // The form is a modal dialog, so the app's sheet rule applies to it at phone width.
    expect(secretFormModal(integ("github_token"), form())).toContain('role="dialog" aria-modal="true"');
    expect(rules).toMatch(/\.cnpy-org-secret \{[^}]*overflow-y:auto;/);
  });
  it("every control is a real button / input / select with a visible focus rule", () => {
    expect(rules).toContain(".cnpy-org button:focus-visible, .cnpy-org select:focus-visible, .cnpy-org-secret button:focus-visible { outline:2px solid");
    const html = (["integrations", "repos", "environments", "members", "general"] as const).map((t) => tabView(fullUi(), t)).join("");
    // Nothing clickable that the keyboard cannot reach.
    expect(html).not.toMatch(/<(div|span|li)[^>]*data-act=/);
    // Every button has a name: text, or an aria-label.
    for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
      const named = /aria-label="[^"]+"/.test(m[1]) || m[2].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim().length > 0;
      expect(named, m[0].slice(0, 120)).toBe(true);
    }
  });
  it("no raw colour: every colour in the three modules is a token", async () => {
    const sources = import.meta.glob(["../web/src/org-settings.ts", "../web/src/org-ui.ts", "../web/src/integrations.ts", "../web/src/org-actions.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources)).toHaveLength(4);
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^`]*&)/);
      expect(src, file).not.toMatch(/rgba?\(/);
    }
    const block = css.slice(css.indexOf("/* ── Org settings"), css.indexOf("/* The queue group header"));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/rgba?\(/);
    expect(block).not.toContain("border-radius");
  });
});

describe("the hierarchy every tab keeps (org-ui.ts)", () => {
  const TABS = ["integrations", "repos", "environments", "members", "notifications", "general"] as const;
  const notif = { policy: [], settings: null, outbox: [], outboxExpanded: null, fromDraft: null };
  const page = (tab: OrgUi["tab"], role: OrgRole = "owner") => orgSettingsView({ ...props({ ...fullUi(), tab }, role), notif: role === "member" ? null : notif });
  const panel = (html: string) => html.slice(html.indexOf('role="tabpanel"'));

  it("a tab opens with its lead line — one sentence — never an intro paragraph or a heading", () => {
    for (const tab of TABS) {
      const body = panel(page(tab));
      expect(body, tab).toMatch(/^role="tabpanel"[^>]*><div class="cnpy-lead"><p class="cnpy-lead-t">/);
      expect(body.match(/class="cnpy-lead"/g)?.length, tab).toBe(1);
    }
  });
  it("has ONE heading level inside a tab: the eyebrow", () => {
    for (const tab of TABS) {
      const body = panel(page(tab));
      const heads = body.match(/<h2[^>]*>/g) ?? [];
      for (const h of heads) expect(h, tab).toContain("text-transform:uppercase");
      expect(body, tab).not.toMatch(/<h[13456]/);
    }
  });
  it("has at most one accent button per tab, and no bordered destructive button anywhere", () => {
    for (const tab of TABS) {
      const body = panel(page(tab));
      expect((body.match(/class="cnpy-accentbtn"/g) ?? []).length, tab).toBeLessThanOrEqual(1);
      expect(body, tab).not.toContain("cnpy-rejectbtn");
      expect(body, tab).not.toContain("cnpy-dangerbtn");
    }
  });
  it("Integrations: a row is a name, a status and ONE action; the rest is behind a real toggle", () => {
    const html = page("integrations");
    const at = html.indexOf('data-org-integration="cloudflare_analytics:"');
    const row = html.slice(at, html.indexOf("</li>", at));
    const head = row.slice(0, row.indexOf('class="cnpy-xrow-b"'));
    expect(head).toContain('data-act="orgRowToggle" data-arg="cloudflare_analytics:"');
    expect(head).toContain('aria-expanded="false" aria-controls="xrow-cloudflare_analytics-"');
    expect(head).toMatch(/aria-label="Cloudflare analytics, set: show details"/);
    expect((head.match(/<button/g) ?? []).length).toBe(2);                 // the toggle, and Test connection
    expect(head).toContain(">Test connection<");
    for (const behind of ["Edit settings", ">Rotate<", ">Delete<", "Account ID:", "What Cloudflare analytics is used for."]) {
      expect(head, behind).not.toContain(behind);
      expect(row, behind).toContain(behind);
    }
    expect(row).toContain('id="xrow-cloudflare_analytics-" class="cnpy-xrow-b" hidden');
    // Opened: the same row, its body shown, the toggle saying so.
    const open = orgSettingsView(props({ ...fullUi(), tab: "integrations", openRows: ["cloudflare_analytics:"] }));
    expect(open).toContain('aria-expanded="true" aria-controls="xrow-cloudflare_analytics-" aria-label="Cloudflare analytics, set: hide details"');
    expect(open).toMatch(/id="xrow-cloudflare_analytics-" class="cnpy-xrow-b">/);
  });
  it("Integrations: the key and the history are two rows at the foot, not sections; the GitHub token leads while it is missing", () => {
    const html = page("integrations");
    expect(html).toMatch(/<h2[^>]*>Key and history<\/h2>/);
    expect(html).toContain("data-org-key");
    expect(html).toContain("data-org-history");
    expect(html).not.toMatch(/<h2[^>]*>Encryption key<\/h2>/);
    const fresh = orgSettingsView(props({ ...emptyUi(), tab: "integrations" }));
    expect(fresh).toMatch(/class="cnpy-lead-a"><button[^>]*data-field="orgLeadToken"[^>]*class="cnpy-accentbtn"[^>]*>Set the GitHub token</);
    expect((fresh.match(/class="cnpy-accentbtn"/g) ?? []).length).toBe(1);
  });
  it("a member's tabs say once that they are read-only, in the lead", () => {
    for (const tab of ["repos", "environments", "members"] as const) {
      const body = panel(page(tab, "member"));
      expect(body.match(/You can read this; an admin or an owner can change it\./g)?.length, tab).toBe(1);
      expect(body, tab).not.toContain("cnpy-accentbtn");
    }
  });
  it("the styles: a lead, an eyebrow row and an opening row, with the phone layout", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    for (const cls of [".cnpy-lead {", ".cnpy-lead-t {", ".cnpy-sechead {", ".cnpy-xrow {", ".cnpy-xrow-t {", ".cnpy-xrow-b[hidden] { display:none; }", ".cnpy-org-danger:hover, .cnpy-org-danger:focus-visible { color:var(--red) !important; }"]) expect(rules).toContain(cls);
    expect(rules).toMatch(/@media \(max-width:640px\) \{[^@]*\.cnpy-xrow-t \{ flex:1 1 100%; display:grid;/);
  });
});
