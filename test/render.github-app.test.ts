/**
 * The GitHub App in Org settings (web/src/github-app.ts, and the Repositories / Integrations tabs that
 * use it) — pure render tests: props in, markup out. Every state an org can be in: the App not
 * configured on this deployment, not connected, connected, suspended, a repository no longer visible,
 * a request pending on GitHub, and a binding lost from GitHub's side — plus what a member sees.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { orgSettingsView, orgOverlays, initialOrgUi, setupSteps, orgConfirmCopy, githubOf, type OrgUi, type OrgSettingsProps } from "../web/src/org-settings";
import { connectNoticeCopy, installationStatus, PICKER_FILTER_FROM } from "../web/src/github-app";
import { auditSentence } from "../web/src/integrations";
import { orgsTab } from "../web/src/platform";
import { githubInstallHref, setApiOrg, apiUrl, isGlobalPath } from "../web/src/api";
import { GITHUB_CONNECT_OUTCOMES, isGithubConnectOutcome, type GithubAppStatusDTO, type GithubInstallationDTO, type GithubReposDTO } from "@shared/github-app";
import type { IntegrationDTO, IntegrationKind, OrgRepoDTO } from "@shared/integrations";
import type { MyOrg, OrgRole, PlatformOrgRow } from "@shared/orgs";

const HOOK = "hook_0123456789abcdef0123456789abcdef01234567";
const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme Robotics", role });

const inst = (o: Partial<GithubInstallationDTO> = {}): GithubInstallationDTO => ({
  installation_id: 5551234, account_login: "acme-gh", account_type: "Organization", repository_selection: "selected", connected_by: "andres",
  connected_at: "2026-10-05T10:00:00.000Z", suspended_at: null, last_used_at: "2026-10-07T01:00:00.000Z", last_error: null,
  manage_url: "https://github.com/organizations/acme-gh/settings/installations/5551234", ...o,
});
const status = (o: Partial<GithubAppStatusDTO> = {}): GithubAppStatusDTO => ({ configured: true, installation: null, lost: null, mismatch: null, ...o });
const repo = (name: string, o: Partial<OrgRepoDTO> = {}): OrgRepoDTO => ({
  id: `hook_${name.replace(/\W/g, "_")}`, repo_full_name: name, is_primary: false, legacy_hook: false, webhook_url: `https://trov.dev/webhook/github/${HOOK}`,
  webhook_secret_configured: false, connection: "manual", access_lost: false, created_at: "2026-10-01T10:00:00.000Z", created_by: "andres", ...o,
});
function integ(kind: IntegrationKind, o: Partial<IntegrationDTO> = {}): IntegrationDTO {
  const scope_type = kind === "github_webhook" ? "repo" : kind === "railway" || kind === "metrics_endpoint" ? "environment" : "org";
  const label = { github_token: "GitHub token", github_webhook: "GitHub webhook secret", cloudflare_analytics: "Cloudflare analytics", railway: "Railway project token", metrics_endpoint: "App metrics endpoint" }[kind];
  return {
    kind, scope: scope_type === "repo" ? HOOK : "", scope_type, scope_label: scope_type === "repo" ? "acme-gh/web" : null, label, description: `What ${label} is used for.`, how_to: "How.",
    configured: false, legacy_fallback: false, expected: true, hint_last4: "", created_by: null, created_at: null, rotated_at: null, last_used_at: null, last_error: null, config: {}, config_fields: [],
    webhook_url: kind === "github_webhook" ? `https://trov.dev/webhook/github/${HOOK}` : null, ...o,
  };
}
const available = (names: string[], tracked: string[] = []): GithubReposDTO => ({
  repositories: names.map((n) => ({ full_name: n, private: n.endsWith("/infra"), tracked: tracked.includes(n), is_primary: tracked[0] === n })), total: names.length, truncated: false,
});

function ui(app: GithubAppStatusDTO, over: Partial<OrgUi> = {}): OrgUi {
  return {
    ...initialOrgUi(), slug: "acme", tab: "repos",
    settings: ok({ org: { slug: "acme", name: "Acme Robotics", created_at: "2026-10-01T10:00:00.000Z", created_by: "andres" }, can_edit: true }),
    members: ok([{ handle: "andres", name: "Andres", color: "moss", avatar_url: null, role: "owner", title: null, joined_at: "2026-10-01T10:00:00.000Z" }]),
    invites: ok([]), repos: ok([]), envs: ok([]), audit: ok([]),
    github: ok(app),
    integrations: ok({ integrations: [integ("github_token"), integ("cloudflare_analytics")], github_app: app, secrets_available: true, key_version: null }),
    ...over,
  };
}
const props = (u: OrgUi, role: OrgRole = "owner"): OrgSettingsProps => ({ org: org(role), orgsStatus: "ok", me: "andres", ui: u });
const page = (u: OrgUi, role: OrgRole = "owner") => orgSettingsView(props(u, role));
const panel = (html: string) => html.slice(html.indexOf('role="tabpanel"'));
const lead = (html: string) => { const p = panel(html); const at = p.indexOf('class="cnpy-lead"'); return p.slice(at, p.indexOf("</div></div>", at) + 12); };
const accents = (html: string) => (panel(html).match(/class="cnpy-accentbtn"/g) ?? []).length;
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&middot;/g, "·").replace(/&rarr;/g, "→").replace(/\s+/g, " ");

beforeEach(() => setApiOrg("acme"));
afterEach(() => setApiOrg(null));

describe("where Connect goes", () => {
  it("is a link to the org's own start route — a tenant route — never a request, and never the callback", () => {
    expect(githubInstallHref("acme")).toBe("/api/o/acme/github/install");
    expect(githubInstallHref("big co")).toBe("/api/o/big%20co/github/install");
    expect(githubInstallHref("acme", { existing: true })).toBe("/api/o/acme/github/install?existing=1");
    expect(githubInstallHref("acme", { existing: true, account: "acme-gh" })).toBe("/api/o/acme/github/install?existing=1&account=acme-gh");
    // The callback GitHub returns to is person-level: it is never under an org's prefix.
    expect(isGlobalPath("/auth/callback")).toBe(true);
    expect(apiUrl("/auth/callback?code=x")).toBe("/auth/callback?code=x");
    expect(apiUrl("/github")).toBe("/api/o/acme/github");
  });
});

describe("Repositories — the App is not configured on this deployment", () => {
  const html = page(ui(status({ configured: false }), { repos: ok([repo("acme-gh/web", { is_primary: true })]) }));
  it("offers only the by-name path, as its primary action, and says why", () => {
    expect(html).toContain('data-org-github-off');
    expect(text(html)).toContain("The GitHub App is not configured on this Trov, so a repository is connected by name and read with a GitHub token.");
    expect(lead(html)).toContain('id="org-repo"');
    expect(lead(html)).toContain('data-act="orgRepoAdd"');
    expect(html).not.toContain("data-org-github-connect");
    expect(html).not.toContain("/github/install");
    expect(html).not.toContain("data-org-repo-manual"); // not a quiet alternative here: it IS the way
    expect(text(html)).toContain("1 without a webhook secret");
    expect(accents(html)).toBeLessThanOrEqual(1);
  });
  it("a member is told nothing about how the deployment is set up", () => {
    const member = page(ui(status({ configured: false }), { repos: ok([repo("acme-gh/web", { is_primary: true, id: null, webhook_url: null })]) }), "member");
    expect(member).not.toContain("data-org-github-off");
    expect(member).not.toContain('id="org-repo"');
    expect(text(member)).toContain("You can read this; an admin or an owner can change it.");
  });
});

describe("Repositories — offered, not connected", () => {
  it("leads with Connect with GitHub (the ONE accent action), with by-name as the quiet alternative", () => {
    const html = page(ui(status()));
    const l = lead(html);
    expect(text(l)).toContain("No repository connected. Connect GitHub to choose from your repositories.");
    expect(l).toMatch(/<a href="\/api\/o\/acme\/github\/install" data-field="orgGithubConnect" data-org-github-connect class="cnpy-accentbtn"[^>]*>Connect with GitHub<\/a>/);
    expect(accents(html)).toBe(1);
    expect(html).toContain('href="/api/o/acme/github/install?existing=1"');
    expect(text(html)).toContain("Already installed the Trov App on GitHub? Link the existing installation");
    // By name is there, closed, behind a real toggle.
    expect(html).toMatch(/data-arg="repo-manual" data-field="row:repo-manual" aria-expanded="false" aria-controls="org-repo-manual"/);
    expect(html).toMatch(/<div id="org-repo-manual" hidden/);
    expect(html).not.toContain("data-org-github-off");
    // Open, its Add is a QUIET button: the accent stays the lead's.
    const open = page(ui(status(), { openRows: ["repo-manual"] }));
    expect(open).toMatch(/<div id="org-repo-manual" style/);
    expect(accents(open)).toBe(1);
    expect(text(open)).toContain("For a repository the GitHub App cannot see.");
  });
  it("repositories connected by hand are listed as before; the webhook is only flagged where a token says the org is on that path", () => {
    const repos = ok([repo("acme-gh/web", { is_primary: true }), repo("acme-gh/api")]);
    const fresh = page(ui(status(), { repos }));
    expect(text(lead(fresh))).not.toContain("without a webhook secret");
    expect(fresh).toContain('data-org-repo="acme-gh/web" data-connection="manual"');
    const onToken = page(ui(status(), { repos, integrations: ok({ integrations: [integ("github_token", { configured: true, hint_last4: "1a2b" })], github_app: status(), secrets_available: true, key_version: 1 }) }));
    expect(text(lead(onToken))).toContain("2 without a webhook secret");
  });
  it("a member sees no way to connect", () => {
    const html = page(ui(status()), "member");
    expect(html).not.toContain("/github/install");
    expect(html).not.toContain("data-org-repo-manual");
    expect(text(html)).toContain("An admin has not connected a repository yet.");
  });
  it("while it is not known whether the App is offered, the tab waits instead of flashing the wrong action", () => {
    const html = page(ui(status(), { github: { status: "loading", data: null }, integrations: { status: "loading", data: null } }));
    expect(panel(html)).toContain("Loading repositories");
    expect(html).not.toContain('id="org-repo"');
    // …and a failed read falls back to what the org already has, by name.
    const failed = page(ui(status(), { github: { status: "error", data: null, error: "x" }, integrations: { status: "error", data: null } }));
    expect(lead(failed)).toContain('id="org-repo"');
    expect(failed).not.toContain("data-org-github-off"); // unknown is not "not configured"
  });
});

describe("Repositories — connected", () => {
  const connected = (over: Partial<OrgUi> = {}, app = status({ installation: inst() })) => ui(app, {
    repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" }), repo("vendor/sdk")]),
    githubRepos: ok(available(["acme-gh/web", "acme-gh/api", "acme-gh/infra"], ["acme-gh/web"])), ...over,
  });
  it("the lead says how the org is connected; there is no accent action, and Manage on GitHub leaves in a new tab", () => {
    const html = page(connected());
    const l = lead(html);
    expect(text(l)).toContain("2 repositories · primary acme-gh/web · through the GitHub App on acme-gh .");
    expect(l).toMatch(/<a href="https:\/\/github\.com\/organizations\/acme-gh\/settings\/installations\/5551234" target="_blank" rel="noopener" aria-label="Manage the Trov App on acme-gh, on GitHub" class="cnpy-ghostbtn"/);
    expect(accents(html)).toBe(0);
    expect(html).not.toContain("data-org-github-connect");
  });
  it("a repository reached through the App shows no webhook; one outside its account still does", () => {
    const html = page(connected({ openRows: ["repo:acme-gh/web", "repo:vendor/sdk"] }));
    const row = (name: string) => { const at = html.indexOf(`data-org-repo="${name}"`); return html.slice(at, html.indexOf("</li>", at)); };
    expect(row("acme-gh/web")).toContain('data-connection="app"');
    expect(text(row("acme-gh/web"))).toContain("Through the GitHub App");
    expect(text(row("acme-gh/web"))).toContain("it needs no token and no webhook of its own");
    expect(row("acme-gh/web")).not.toContain("Webhook URL");
    expect(row("acme-gh/web")).not.toContain("Set its webhook secret");
    expect(row("vendor/sdk")).toContain('data-connection="manual"');
    expect(row("vendor/sdk")).toContain("Webhook URL");
    expect(text(row("vendor/sdk"))).toContain("Outside the account the GitHub App is installed on");
    expect(text(row("vendor/sdk"))).toContain("Events are captured for the primary repository only.");
  });
  it("lists what the installation can see and is not tracked yet: a name and ONE quiet action each", () => {
    const html = page(connected());
    const at = html.indexOf("data-org-github-picker");
    const picker = html.slice(at, html.indexOf("</section>", at));
    expect(text(picker)).toContain("On acme-gh");
    expect(picker).not.toContain('data-org-github-repo="acme-gh/web"'); // already tracked
    expect(picker).toContain('data-org-github-repo="acme-gh/api"');
    expect(picker).toMatch(/data-act="orgGithubTrack" data-arg="acme-gh\/infra" data-field="orgGithubTrack:acme-gh\/infra" aria-label="Track acme-gh\/infra"/);
    expect(text(picker)).toContain("Private");
    expect(picker).not.toContain("cnpy-accentbtn");
    expect(picker).not.toContain('id="org-gh-filter"'); // a short list needs no filter
    expect(picker).toContain('data-act="orgGithubReposReload"');
    // One being added: every Track is disabled, that one says so.
    const busy = page(connected({ githubBusy: "acme-gh/api" }));
    expect(busy).toMatch(/data-arg="acme-gh\/api" data-field="orgGithubTrack:acme-gh\/api" disabled aria-busy="true"/);
    expect(busy).toMatch(/data-arg="acme-gh\/infra" data-field="orgGithubTrack:acme-gh\/infra" disabled/);
  });
  it("a long list gets a filter; nothing left, loading, a failure and a cut list each say so", () => {
    const many = Array.from({ length: PICKER_FILTER_FROM + 3 }, (_, i) => `acme-gh/svc-${i}`);
    const long = page(connected({ githubRepos: ok(available(many)) }));
    expect(long).toContain('id="org-gh-filter"');
    const filtered = page(connected({ githubRepos: ok(available(many)), githubFilter: "SVC-11" }));
    expect(filtered).toContain('data-org-github-repo="acme-gh/svc-11"');
    expect(filtered).not.toContain('data-org-github-repo="acme-gh/svc-1"');
    expect(text(page(connected({ githubRepos: ok(available(many)), githubFilter: "zzz" })))).toContain("No repository matches “zzz”.");
    expect(text(page(connected({ githubRepos: ok(available(["acme-gh/web"], ["acme-gh/web"])) })))).toContain("Every repository the App can see is tracked.");
    expect(text(page(connected({ githubRepos: { status: "loading", data: null } })))).toContain("Loading the repositories the App can see");
    const failed = page(connected({ githubRepos: { status: "error", data: null, error: "x" } }));
    expect(text(failed)).toContain("Couldn't load the repositories on GitHub.");
    expect(failed).toContain('data-act="orgGithubReposReload"');
    expect(text(page(connected({ githubRepos: ok({ ...available(many), total: 900, truncated: true }) })))).toContain(`Showing the first ${many.length} of 900.`);
  });
  it("the connection is ONE row: Test connection in view; Manage on GitHub and Disconnect (as quiet text) behind it", () => {
    const html = page(connected({ openRows: ["github-app"] }));
    const at = html.indexOf('data-org-github-app="connected"');
    const row = html.slice(at, html.indexOf("</li>", at));
    const head = row.slice(0, row.indexOf('class="cnpy-xrow-b"'));
    expect(text(head)).toContain("GitHub App · acme-gh Connected 1 repository · connected by andres Test connection");
    expect(head).toMatch(/aria-expanded="true" aria-controls="xrow-github-app" aria-label="GitHub App on acme-gh, connected: hide details"/);
    expect(head).not.toContain("Disconnect");
    expect(text(row)).toContain("Events are captured for the primary repository.");
    expect(row).toMatch(/data-act="orgConfirm" data-arg="github:" data-field="orgConfirm:github:" aria-label="Disconnect the GitHub App on acme-gh" class="cnpy-org-danger" aria-haspopup="dialog"/);
    expect(row).not.toContain("cnpy-rejectbtn");
    // Nothing tracked yet reads as words, not "0 repositories".
    expect(text(page(ui(status({ installation: inst() }), { githubRepos: ok(available(["acme-gh/web"])) })))).toContain("No repository tracked yet · connected by andres");
  });
  it("a test's answer and a last error show without opening the row", () => {
    const passed = page(connected({ tests: { github_app: { status: "done", ok: true, detail: "GitHub answered through the installation on acme-gh: 3 repositories." } } }));
    expect(passed).toContain('data-org-test="ok"');
    expect(text(passed)).toContain("Connection works. GitHub answered through the installation on acme-gh: 3 repositories.");
    expect(page(connected({ tests: { github_app: { status: "running" } } }))).toMatch(/data-field="orgGithubTest" disabled aria-busy="true"/);
    const errored = page(connected({}, status({ installation: inst({ last_error: "ask GitHub for a token: github 503" }) })));
    expect(errored).toContain('data-org-github-app="error"');
    expect(text(errored)).toContain("Last error. ask GitHub for a token: github 503");
  });
  it("a member sees how the org is connected and nothing that writes — not even the installation's page", () => {
    const html = page(connected({ openRows: ["github-app"] }, status({ installation: inst({ installation_id: null, manage_url: null, last_error: null }) })), "member");
    expect(text(html)).toContain("through the GitHub App on acme-gh");
    for (const act of ["orgGithubTest", "orgGithubTrack", "orgConfirm", "orgRepoAdd", "orgGithubReposReload"]) expect(html, act).not.toContain(`data-act="${act}"`);
    expect(html).not.toContain("github.com");
    expect(html).not.toContain("data-org-github-picker");
  });
  it("Disconnect asks first, and says the App stays installed on GitHub", () => {
    const u = connected({ confirm: { what: "github", arg: "", busy: false } });
    const copy = orgConfirmCopy(u.confirm!, org(), u)!;
    expect(copy.title).toBe("Disconnect GitHub from Acme Robotics?");
    expect(copy.body).toContain("The Trov App stays installed on GitHub until you uninstall it there.");
    expect(copy.body).toContain("Your 2 repositories stay connected: they are read with the GitHub token if one is set, and otherwise stop updating.");
    expect(copy.confirmLabel).toBe("Disconnect");
    expect(orgOverlays(props(u))).toContain('role="alertdialog"');
    const one = connected({ repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" })]) });
    expect(orgConfirmCopy({ what: "github", arg: "", busy: false }, org(), one)!.body).toContain("Your repository stays connected: it is read with the GitHub token if one is set, and otherwise stops updating.");
    expect(orgConfirmCopy({ what: "github", arg: "", busy: false }, org(), ui(status()))).toBeNull();
  });
});

describe("Repositories — suspended, a repository no longer visible, and a binding lost on GitHub's side", () => {
  it("suspended: a banner, the chip and the lead say so; the list is not asked for; Test connection stays", () => {
    const app = status({ installation: inst({ suspended_at: "2026-10-06T18:00:00.000Z", last_error: "ask GitHub for a token: the installation is suspended on GitHub" }) });
    const html = page(ui(app, { repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" })]) }));
    expect(html).toContain("data-org-github-suspended");
    expect(text(html)).toContain("The GitHub App is suspended");
    expect(text(lead(html))).toContain("GitHub App on acme-gh is suspended");
    expect(html).toContain('data-org-github-app="suspended"');
    expect(html).not.toContain("data-org-github-picker");
    expect(html).not.toContain("data-org-lasterror"); // the banner and the chip already say it
    expect(html).toContain('data-act="orgGithubTest"');
    expect(installationStatus(app.installation!)).toEqual({ word: "Suspended", tone: "var(--amber)" });
  });
  it("a repository the installation can no longer see is marked on its row, in its details and in the lead", () => {
    const html = page(ui(status({ installation: inst() }), {
      repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" }), repo("acme-gh/old", { connection: "app", access_lost: true })]),
      githubRepos: ok(available(["acme-gh/web"], ["acme-gh/web"])), openRows: ["repo:acme-gh/old"],
    }));
    expect(text(lead(html))).toContain("1 no longer visible to the App");
    const at = html.indexOf('data-org-repo="acme-gh/old"');
    const row = html.slice(at, html.indexOf("</li>", at));
    expect(text(row)).toContain("No longer visible");
    expect(text(row)).toContain("Not visible to the App");
    expect(row).toContain("data-org-repo-lost");
    expect(text(row)).toContain("The Trov App on acme-gh can no longer see this repository, so nothing new is read from it.");
    expect(row).toMatch(/aria-label="acme-gh\/old, no longer visible to the App: hide details"/);
    expect(row).toContain('data-arg="repo:hook_acme_gh_old"'); // it can be removed
  });
  it("uninstalled on GitHub, or gone: a banner says what happened and Connect is offered again — never after a Disconnect", () => {
    const repos = ok([repo("acme-gh/web", { is_primary: true })]);
    const un = page(ui(status({ lost: { account_login: "acme-gh", reason: "uninstalled", at: "2026-10-06T20:00:00.000Z" } }), { repos }));
    expect(un).toContain("data-org-github-lost");
    expect(text(un)).toContain("GitHub is no longer connected");
    expect(text(un)).toContain("The Trov App was uninstalled from acme-gh on GitHub");
    expect(un).toContain("data-org-github-connect");
    expect(text(page(ui(status({ lost: { account_login: "acme-gh", reason: "not_found", at: "2026-10-06T20:00:00.000Z" } }), { repos })))).toContain("GitHub no longer has the Trov App installed on acme-gh");
    expect(page(ui(status(), { repos }))).not.toContain("data-org-github-lost");
    // A member is told, without the admin's next step.
    expect(text(page(ui(status({ lost: { account_login: "acme-gh", reason: "uninstalled", at: "2026-10-06T20:00:00.000Z" } }), { repos }), "member"))).not.toContain("Connect again");
  });
});

describe("the App on an account that does not own the primary repository", () => {
  const repos = ok([repo("acme-gh/web", { is_primary: true })]);
  const wrong = status({ installation: inst({ account_login: "olive", account_type: "User" }), mismatch: { account_login: "olive", repo_full_name: "acme-gh/web" } });
  it("says which account and which repository, and offers connecting the right one", () => {
    const html = page(ui(wrong, { repos }));
    expect(html).toContain("data-org-github-mismatch");
    expect(text(html)).toContain("The GitHub App is on a different account");
    const said = text(html).replace(/\s+([,.:])/g, "$1"); // the helper spaces out the bold names
    expect(said).toContain("The Trov App is installed on olive, which does not own acme-gh/web, so that repository is not read through it.");
    expect(said).toContain("Connect acme-gh instead: it takes the place of this connection.");
    expect(html).toContain('data-field="orgGithubReconnect"');
  });
  it("a member is told, without the admin's action; no mismatch, no banner", () => {
    const member = page(ui(wrong, { repos }), "member");
    expect(member).toContain("data-org-github-mismatch");
    expect(member).not.toContain("orgGithubReconnect");
    expect(page(ui(status({ installation: inst() }), { repos }))).not.toContain("data-org-github-mismatch");
  });
});

describe("the sentence after a return from GitHub", () => {
  it("a request pending on GitHub: nothing is connected, and it says what happens next", () => {
    const html = page(ui(status(), { githubNotice: { outcome: "requested", accounts: [] } }));
    expect(html).toContain('data-org-github-notice="requested"');
    expect(html).toMatch(/role="status" data-org-github-notice="requested"/);
    expect(text(html)).toContain("Waiting for approval on GitHub.");
    expect(text(html)).toContain("Nothing is connected to Acme Robotics yet.");
    expect(html).toContain("data-org-github-connect"); // still the action
    expect(html).toContain('data-act="orgGithubNoticeClose"');
  });
  it("every outcome has a sentence; a refusal is an alert; none says a code", () => {
    for (const outcome of GITHUB_CONNECT_OUTCOMES) {
      const c = connectNoticeCopy({ outcome, accounts: [] }, "Acme");
      expect(c.title.length, outcome).toBeGreaterThan(8);
      expect(c.body.length, outcome).toBeGreaterThan(20);
      expect(`${c.title} ${c.body}`, outcome).not.toMatch(/_|installation_id|setup_action/);
    }
    expect(page(ui(status(), { githubNotice: { outcome: "not_yours", accounts: [] } }))).toMatch(/role="alert" data-org-github-notice="not_yours"/);
    expect(connectNoticeCopy({ outcome: "connected", accounts: [] }, "Acme").tone).toBe("ok");
    expect(isGithubConnectOutcome("connected")).toBe(true);
    expect(isGithubConnectOutcome("<script>")).toBe(false);
    // A partial reader is told HOW MANY repositories they cannot read (never which); too large an installation, what to do.
    expect(connectNoticeCopy({ outcome: "partial_access", accounts: [], missing: 3 }, "Acme").body).toContain("cannot read 3 of the repositories that installation covers");
    expect(connectNoticeCopy({ outcome: "partial_access", accounts: [], missing: 1 }, "Acme").body).toContain("cannot read 1 of the repository that installation covers");
    expect(connectNoticeCopy({ outcome: "partial_access", accounts: [] }, "Acme").body).toContain("cannot read every repository that installation covers");
    expect(connectNoticeCopy({ outcome: "too_many_repos", accounts: [] }, "Acme").body).toContain("Only select repositories");
    // An org's name is escaped inside a notice.
    expect(connectNoticeCopy({ outcome: "requested", accounts: [] }, "<b>x</b>").body).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("several installations to choose from are links that run the authorization again for that account", () => {
    const html = page(ui(status(), { githubNotice: { outcome: "choose", accounts: ["acme-gh", "andres"] } }));
    expect(html).toContain('href="/api/o/acme/github/install?existing=1&amp;account=acme-gh"');
    expect(html).toContain('href="/api/o/acme/github/install?existing=1&amp;account=andres"');
    // Not started here / took too long: the way back in is offered in the notice itself.
    expect(page(ui(status(), { githubNotice: { outcome: "expired", accounts: [] } }))).toContain("Link the existing installation");
  });
});

describe("Integrations", () => {
  const tab = (u: OrgUi, role: OrgRole = "owner") => page({ ...u, tab: "integrations" }, role);
  const group = (html: string) => { const at = html.indexOf('data-org-group="github"'); return html.slice(at, html.indexOf("</section>", at)); };
  const rows = [integ("github_token", { configured: true, hint_last4: "1a2b", created_by: "andres", last_error: "github 401" }), integ("github_webhook"), integ("cloudflare_analytics")];

  it("connected: the GitHub group is ONE row for the App, and the token / webhook rows fold into a quiet Manual connection", () => {
    const app = status({ installation: inst() });
    const u = ui(app, { repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" })]), integrations: ok({ integrations: rows, github_app: app, secrets_available: true, key_version: 1 }) });
    const html = tab(u);
    const g = group(html);
    expect(g).toContain('data-github="app"');
    expect(text(g)).toContain("GitHub connected through the App");
    expect(text(g)).toContain("GitHub App · acme-gh Connected 1 repository · connected by andres Test connection");
    expect(g).toContain('data-act="orgGithubTest"');
    expect(g).toContain("data-org-github-manual");
    expect(text(g)).toContain("Manual connection Not needed while the App is connected · 1 stored");
    // The manual rows are inside that row, closed.
    const manualAt = g.indexOf("data-org-github-manual");
    expect(g.indexOf('data-org-integration="github_token:"')).toBeGreaterThan(manualAt);
    expect(g.slice(manualAt)).toMatch(/id="xrow-github-manual" class="cnpy-xrow-b" hidden/);
    // The lead counts only what the org still owes; the token's old error is not a to-do any more.
    expect(text(lead(html))).toContain("GitHub is connected through the GitHub App on acme-gh · 0 of 1 other credential set.");
    expect(text(lead(html))).not.toContain("with an error");
    expect(accents(html)).toBe(0);
    expect(html).toMatch(/data-n="0" title="0 with an error"/);
    // Open, the stored token can still be rotated or deleted.
    const open = tab({ ...u, openRows: ["github-manual", "github_token:"] });
    expect(open).toContain('data-arg="secret:github_token:"');
    expect(open).toMatch(/id="xrow-github-manual" class="cnpy-xrow-b">/);
  });
  it("offered, not connected: the lead's action is Connect with GitHub; the App's row says so; the manual rows are the alternative", () => {
    const html = tab(ui(status(), { integrations: ok({ integrations: [integ("github_token"), integ("github_webhook"), integ("cloudflare_analytics")], github_app: status(), secrets_available: true, key_version: null }) }));
    expect(lead(html)).toMatch(/<a href="\/api\/o\/acme\/github\/install" data-field="orgLeadGithub" data-org-github-connect class="cnpy-accentbtn"/);
    expect(lead(html)).not.toContain("Set the GitHub token");
    expect(accents(html)).toBe(1);
    const g = group(html);
    expect(g).toContain('data-github="manual"');
    expect(g).toContain('data-org-github-app="none"');
    expect(text(g)).toContain("GitHub App Not connected Recommended: no token to paste, no webhook to add Connect in Repositories →");
    expect(text(g)).toContain("or by hand: 0 of 2 set");
    expect(g).toContain('data-org-integration="github_token:"');
    expect(g.indexOf('data-org-github-app="none"')).toBeLessThan(g.indexOf('data-org-integration="github_token:"'));
    // With a token already set the org is connected by hand: nothing is pushed as the lead's action.
    const onToken = tab(ui(status(), { integrations: ok({ integrations: [integ("github_token", { configured: true, hint_last4: "1a2b" })], github_app: status(), secrets_available: true, key_version: 1 }) }));
    expect(accents(onToken)).toBe(0);
  });
  it("not configured on this deployment: the token leads as before, and the App's row says why it is not offered", () => {
    const off = status({ configured: false });
    const html = tab(ui(off, { integrations: ok({ integrations: [integ("github_token"), integ("cloudflare_analytics")], github_app: off, secrets_available: true, key_version: null }) }));
    expect(lead(html)).toContain('data-field="orgLeadToken"');
    expect(html).not.toContain("/github/install");
    const g = group(html);
    expect(g).toContain('data-github="off"');
    expect(text(g)).toContain("GitHub App Not available Not configured on this Trov");
    expect(tab(ui(off, { openRows: ["github-app"], integrations: ok({ integrations: [integ("github_token")], github_app: off, secrets_available: true, key_version: null }) }))).toContain("The GitHub App is not configured on this Trov");
    // An answer from before the field existed reads the same.
    const old = tab(ui(off, { github: { status: "idle", data: null }, integrations: ok({ integrations: [integ("github_token")], secrets_available: true, key_version: null }) }));
    expect(group(old)).toContain('data-github="off"');
  });
  it("suspended: the tab carries a count, the row a Suspended chip", () => {
    const app = status({ installation: inst({ suspended_at: "2026-10-06T18:00:00.000Z" }) });
    const html = tab(ui(app, { integrations: ok({ integrations: [integ("github_token")], github_app: app, secrets_available: true, key_version: null }) }));
    expect(html).toMatch(/data-n="1" title="1 with an error"/);
    expect(html).toContain('data-org-github-app="suspended"');
    expect(text(lead(html))).toContain("GitHub App on acme-gh is suspended");
  });
  it("the history reads the App's events as sentences", () => {
    const row = (action: string, detail: Record<string, unknown> = {}) => auditSentence({ id: "a1", actor: "x", action: action as never, target: "acme-gh", detail, at: "2026-10-06T00:00:00.000Z" }, []);
    expect(row("github.connect")).toBe("connected GitHub through the App on acme-gh");
    expect(row("github.disconnect")).toBe("disconnected the GitHub App on acme-gh");
    expect(row("github.uninstall", { reason: "uninstalled" })).toBe("saw the GitHub App uninstalled from acme-gh");
    expect(row("github.uninstall", { reason: "not_found" })).toBe("found the GitHub App no longer installed on acme-gh");
    expect(row("github.suspend")).toBe("saw the GitHub App on acme-gh suspended");
    expect(row("github.repos", { added: ["a/b"], removed: [] })).toBe("saw the GitHub App's repositories on acme-gh change (1 added, 0 removed)");
  });
});

describe("the setup checklist", () => {
  const withRepo = { repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" })]) };
  it("an installation with a primary repository satisfies both GitHub steps — no token needed", () => {
    const steps = setupSteps(ui(status({ installation: inst() }), withRepo))!;
    expect(steps.map((s) => [s.key, s.title, s.done])).toEqual([["repo", "Connect a repository", true], ["env", "Add an environment", false], ["token", "Connect GitHub", true], ["team", "Invite your team", false]]);
  });
  it("where the App is offered the step is Connect GitHub and points at Repositories; a token satisfies it too", () => {
    const steps = setupSteps(ui(status()))!;
    expect(steps.find((s) => s.key === "token")).toMatchObject({ title: "Connect GitHub", tab: "repos", done: false });
    const byToken = ui(status(), { integrations: ok({ integrations: [integ("github_token", { configured: true })], github_app: status(), secrets_available: true, key_version: 1 }) });
    expect(setupSteps(byToken)!.find((s) => s.key === "token")!.done).toBe(true);
  });
  it("where it is not, the step is the token's, as before", () => {
    const off = status({ configured: false });
    expect(setupSteps(ui(off))!.find((s) => s.key === "token")).toMatchObject({ title: "Set the GitHub token", tab: "integrations", done: false });
    expect(githubOf(ui(off))).toEqual(off);
  });
});

describe("Platform — read-only", () => {
  const row = (o: Partial<PlatformOrgRow> = {}): PlatformOrgRow => ({
    slug: "acme", name: "Acme", logo_url: null, status: "active", created_at: "2026-09-01T10:00:00.000Z", created_by: "andres", suspended_at: null, suspended_by: null,
    owners: [{ handle: "maya", name: "Maya" }], member_count: 2, pending_invites: 0, last_activity_at: null, ...o,
  });
  it("the org list names the GitHub account an org is connected through, and nothing for one that is not", () => {
    const html = orgsTab({ orgs: { status: "ok", data: [row({ github_account: "acme-gh" }), row({ slug: "beta", name: "Beta", github_account: null })] } });
    expect((html.match(/data-plat-github/g) ?? []).length).toBe(1);
    expect(text(html)).toContain("acme · GitHub App on acme-gh");
    expect(html).not.toMatch(/data-act="(?:orgGithub|platGithub)/);
  });
  // (The org page's line is asserted with that page's own fixtures: test/render.platform.test.ts.)
});

describe("the page's rules hold in every state", () => {
  const states: [string, OrgUi][] = [
    ["off", ui(status({ configured: false }))],
    ["none", ui(status())],
    ["connected", ui(status({ installation: inst() }), { repos: ok([repo("acme-gh/web", { is_primary: true, connection: "app" })]), githubRepos: ok(available(["acme-gh/web", "acme-gh/api"], ["acme-gh/web"])), openRows: ["github-app", "repo-manual", "github-manual"] })],
    ["suspended", ui(status({ installation: inst({ suspended_at: "2026-10-06T18:00:00.000Z" }) }))],
    ["lost", ui(status({ lost: { account_login: "acme-gh", reason: "uninstalled", at: "2026-10-06T20:00:00.000Z" } }))],
    ["notice", ui(status(), { githubNotice: { outcome: "choose", accounts: ["acme-gh"] } })],
  ];
  it("at most one accent control per tab; one heading level; every button and link has a name; no destructive button with a border", () => {
    for (const [name, u] of states) {
      for (const t of ["repos", "integrations"] as const) {
        const body = panel(page({ ...u, tab: t }));
        expect(accents(body), `${name}/${t}`).toBeLessThanOrEqual(1);
        expect(body, `${name}/${t}`).not.toMatch(/<h[13456]/);
        expect(body, `${name}/${t}`).not.toContain("cnpy-rejectbtn");
        for (const m of body.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
          const named = /aria-label="[^"]+"/.test(m[2]) || m[3].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim().length > 0;
          expect(named, `${name}/${t}: ${m[0].slice(0, 100)}`).toBe(true);
        }
        // A link out of the app opens in a new tab without handing over the opener; a link to our own start route does not.
        for (const m of body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)) {
          if (m[1].startsWith("https://github.com/")) expect(m[0], name).toContain('target="_blank" rel="noopener"');
          else expect(m[1], name).toMatch(/^\/api\/o\/acme\/github\/install/);
        }
      }
    }
  });
  it("no raw colour: every colour in the module is a token", () => {
    const sources = import.meta.glob("../web/src/github-app.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources)).toHaveLength(1);
    for (const src of Object.values(sources)) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^`]*&)/);
      expect(src).not.toMatch(/rgba?\(/);
      expect(src).not.toMatch(/font-family:(?!var\()/);
    }
  });
});
