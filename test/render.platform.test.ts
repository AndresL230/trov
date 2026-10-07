/**
 * Render tests — the Platform (superadmin) screens: web/src/platform.ts and
 * web/src/platform-usage.ts. Pure functions, mock-fed state, HTML-string assertions
 * (pattern: render.notifications.test.ts). Covers the gate, every tab, the org detail, the
 * add-organization dialog (empty / client errors / server errors / owner / invited), the
 * confirmations, all-zero usage and the routes.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import {
  initialPlat, blankAddOrg, platformView, platformOrgView, platformDialogs, platformHeaderControls, platformCrumb,
  platformPage, isPlatformPath, PLATFORM_PATH,
  orgsTab, adminsTab, auditTab, addOrgModal, slugFromName, slugError, nameError, adminError, adminTarget, addOrgErrors,
  addOrgServerError, ownerServerError, assignmentSentence, suspendCopy, lastSuperadminSentence, NOT_A_MEMBER,
  type PlatState,
} from "../web/src/platform";
import {
  usageView, orgUsageBlock, sparkPath, sparkline, formatBytes, formatNumber, sortByActivity, noActivity, usageBreakdown,
} from "../web/src/platform-usage";
import { sidebarView, navKeyOf, NAV_CLOSED } from "../web/src/sidebar";
import { render, initialState, type AppState } from "../web/src/render";
import { parseHash, hashForRoute, sameRoute } from "../web/src/hash";
import type { OrgUsage, PlatformOrgRow, PlatformOrgDetail, PlatformUsageResponse, UsageActivity, UsageSizes, PlatformAuditRow } from "@shared/orgs";

const org = (over: Partial<PlatformOrgRow> = {}): PlatformOrgRow => ({
  slug: "acme", name: "Acme", status: "active", created_at: "2026-09-01T10:00:00.000Z", created_by: "andres",
  suspended_at: null, suspended_by: null, owners: [{ handle: "maya", name: "Maya Ortiz" }], member_count: 4, pending_invites: 1,
  last_activity_at: "2026-10-05T10:00:00.000Z", ...over,
});
const sizes = (over: Partial<UsageSizes> = {}): UsageSizes => ({
  members: 0, docs: 0, feed_entries: 0, tickets_open: 0, tickets_total: 0, sprints: 0, prompts: 0, handoffs: 0,
  artifacts: 0, artifact_bytes: 0, repo_events: 0, mcp_tokens: 0, oauth_grants: 0, ...over,
});
const activity = (over: Partial<UsageActivity> = {}): UsageActivity => ({
  api_requests: 0, api_reads: 0, api_writes: 0, mcp_requests: 0, mcp_tool_calls: 0, active_people: 0,
  created: { feed_entries: 0, tickets: 0, doc_versions: 0, sprints: 0, prompts: 0, handoffs: 0, artifacts: 0 },
  emails_sent: 0, top_tools: [], ...over,
});
const days = (values: [number, number][]) => values.map(([requests, mcp_calls], i) => ({ day: `2026-10-0${i + 1}`, requests, mcp_calls }));
const zeroSeries = days([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
const usageOf = (over: Partial<OrgUsage> = {}): OrgUsage => ({
  slug: "acme", name: "Acme", status: "active", created_at: "2026-09-01T10:00:00.000Z", last_activity_at: "2026-10-05T10:00:00.000Z",
  sizes: sizes({ members: 4, docs: 12, tickets_open: 3, tickets_total: 9, artifacts: 2, artifact_bytes: 3 * 1024 * 1024 }),
  activity: activity({
    api_requests: 420, api_reads: 380, api_writes: 40, mcp_requests: 90, mcp_tool_calls: 64, active_people: 3,
    created: { feed_entries: 5, tickets: 2, doc_versions: 1, sprints: 0, prompts: 0, handoffs: 1, artifacts: 2 },
    top_tools: [{ tool: "get_feed", count: 40 }, { tool: "query", count: 24 }],
  }),
  series: days([[10, 2], [80, 9], [40, 0], [120, 20], [60, 11], [70, 14], [40, 8]]),
  ...over,
});
const quiet = (slug: string, name: string, over: Partial<OrgUsage> = {}): OrgUsage =>
  usageOf({ slug, name, last_activity_at: null, sizes: sizes(), activity: activity(), series: zeroSeries, ...over });
const report = (orgs: OrgUsage[], over: Partial<PlatformUsageResponse["totals"]> = {}): PlatformUsageResponse => ({
  days: 7, since: "2026-09-30", until: "2026-10-06", generated_at: "2026-10-06T12:00:00.000Z",
  totals: {
    orgs: orgs.length, suspended_orgs: orgs.filter((o) => o.status === "suspended").length, persons: 9, last_activity_at: null,
    sizes: sizes({ artifacts: 2, artifact_bytes: 3 * 1024 * 1024 }),
    activity: orgs.length ? orgs[0].activity : activity(), series: orgs.length ? orgs[0].series : zeroSeries, ...over,
  },
  orgs,
});
const detailOf = (over: Partial<PlatformOrgDetail> = {}): PlatformOrgDetail => ({
  org: org(),
  members: [
    { handle: "maya", name: "Maya Ortiz", role: "owner", title: "Founder", joined_at: "2026-09-01T10:00:00.000Z" },
    { handle: "sam", name: null, role: "member", title: null, joined_at: "2026-09-02T10:00:00.000Z" },
  ],
  invites: [
    { id: 7, github_login: "octocat", email: null, role: "owner", status: "pending", invited_by: "andres", created_at: "2026-10-01T10:00:00.000Z", responded_at: null, responded_by: null, name: null, mail_status: null, mail_at: null, mail_error: null },
    { id: 8, github_login: null, email: "old@acme.example", role: "member", status: "revoked", invited_by: "maya", created_at: "2026-09-01T10:00:00.000Z", responded_at: null, responded_by: null, name: null, mail_status: null, mail_at: null, mail_error: null },
  ],
  usage: usageOf(),
  ...over,
});
const audit = (over: Partial<PlatformAuditRow> = {}): PlatformAuditRow =>
  ({ id: "a1", org: "acme", actor: "andres", action: "org.create", target: "acme", detail: { name: "Acme" }, at: "2026-10-01T10:00:00.000Z", ...over });
const plat = (over: Partial<PlatState> = {}): PlatState => ({ ...initialPlat(), superadmin: true, ...over });
const app = (over: Partial<AppState> = {}): AppState => ({ ...initialState(), view: "app", ...over });

describe("the superadmin gate", () => {
  it("Platform has one way in — the org menu's link to /platform/ — and no sidebar row", () => {
    const html = render(app());
    expect(html).not.toContain('class="cnpy-plat"');
    expect(html).not.toContain('data-act="platGo" class="cnpy-nav-i"');
    expect(css).not.toContain(".cnpy-plat ");
  });
  it("the screens render nothing of the area until the answer is yes", () => {
    const loading = platformView({ ...plat(), superadmin: null, orgs: { status: "ok", data: [org()] } });
    expect(loading).toContain("Loading…");
    expect(loading).not.toContain("Acme");
    const no = platformView({ ...plat(), superadmin: false, orgs: { status: "ok", data: [org()] } });
    expect(no).toContain("This page isn't available to your account.");
    expect(no).not.toContain("Acme");
    expect(platformOrgView({ ...plat(), superadmin: false, orgSlug: "acme", detail: { status: "ok", data: detailOf() } })).not.toContain("Acme");
    expect(platformHeaderControls({ superadmin: false, tab: "orgs" }, "platform")).toBe("");
    expect(platformDialogs({ ...plat(), superadmin: false, add: blankAddOrg() }, "platform")).toBe("");
  });
});

describe("Organizations", () => {
  it("lists name, slug, status, owners, members, invites, created and last activity; a row opens the org", () => {
    const html = orgsTab({ orgs: { status: "ok", data: [org(), org({ slug: "beta", name: "Beta <Co>", owners: [], pending_invites: 1, member_count: 0, last_activity_at: null })] } });
    for (const head of ["Organization", "Status", "Owners", "Members", "Invites", "Created", "Last activity"]) expect(html).toContain(`<span>${head}</span>`);
    expect(html).toContain('data-act="platOpenOrg" data-arg="acme"');
    expect(html).toContain("Maya Ortiz");
    expect(html).toContain("@maya");
    expect(html).toContain("Sep 1, 2026");
    expect(html).toContain("ACTIVE");
    // An org whose invited owner has not accepted yet says so; no activity reads "Never".
    expect(html).toContain("No owner yet — invite pending");
    expect(html).toContain("Never");
    expect(html).toContain("Beta &lt;Co&gt;");
    expect(html).toMatch(/<strong>2<\/strong> organizations &middot; <span class="cnpy-lead-flag"[^>]*>[\s\S]*?1 with no owner yet<\/span>\. Select one to manage it\./);
  });
  it("marks a suspended org clearly: a red badge, a muted name, and it is said in the row's name and the count", () => {
    const html = orgsTab({ orgs: { status: "ok", data: [org({ status: "suspended", suspended_at: "2026-10-02T10:00:00.000Z", suspended_by: "andres" })] } });
    expect(html).toContain("SUSPENDED");
    expect(html).toContain("var(--red)");
    expect(html).toContain('class="plat-row plat-orgs-grid is-suspended" aria-label="Acme, suspended — open"');
    expect(html).toContain("<strong>1</strong> organization");
    expect(html).toMatch(/class="cnpy-lead-flag"[^>]*>[\s\S]*?1 suspended<\/span>/);
  });
  it("empty, loading and failed states", () => {
    const empty = orgsTab({ orgs: { status: "ok", data: [] } });
    expect(empty).toContain("No organizations yet");
    expect(empty).toContain('data-act="platAddOpen"');
    expect(orgsTab({ orgs: { status: "loading", data: [] } })).toContain("Loading organizations…");
    const failed = orgsTab({ orgs: { status: "error", data: [] } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Couldn't load organizations.");
    expect(failed).toContain('data-act="platReload"');
  });
  it("Add organization is the Organizations tab's lead action — the page's one accent button — and nowhere else", () => {
    expect(platformHeaderControls({ superadmin: true, tab: "orgs" }, "platform")).toBe("");
    const lead = (html: string) => { const at = html.indexOf('class="cnpy-lead"'); return at < 0 ? "" : html.slice(at, html.indexOf("</div></div>", at)); };
    expect(lead(orgsTab({ orgs: { status: "ok", data: [org()] } }))).toContain('data-act="platAddOpen" data-plat-add-trigger class="cnpy-accentbtn"');
    expect(lead(orgsTab({ orgs: { status: "ok", data: [] } }))).toContain('data-act="platAddOpen"');
    expect(usageView({ status: "ok", usage: report([usageOf()]), days: 30, open: null })).not.toContain("platAddOpen");
    const s = app({ screen: "platform" }); s.plat.superadmin = true; s.plat.orgs = { status: "ok", data: [org()] };
    const html = render(s);
    expect(html).toContain(">Platform</h1>");
    expect(html.slice(html.indexOf("<header"), html.indexOf("</header>"))).not.toContain("platAddOpen");
    expect(html).toContain("Add organization");
    expect(html).toContain('role="tablist" aria-label="Platform sections"');
  });
});

describe("Add organization", () => {
  it("derives the slug from the name", () => {
    expect(slugFromName("Acme Robotics, Inc.")).toBe("acme-robotics-inc");
    expect(slugFromName("  Fern & Co. ")).toBe("fern-co");
    expect(slugFromName("Ünïcode Café")).toBe("unicode-cafe");
    expect(slugFromName("x".repeat(60))).toHaveLength(39);
    expect(slugFromName("!!!")).toBe("");
  });
  it("validates the slug against the server's rule, the name and each kind of admin", () => {
    expect(slugError("acme")).toBeNull();
    expect(slugError("")).toContain("Enter a slug");
    expect(slugError("a")).toContain("2 to 39");
    expect(slugError("-acme")).toContain("starting with a letter or digit");
    expect(slugError("Acme")).toContain("lowercase");
    expect(slugError("platform")).toContain("is reserved");
    expect(nameError("  ")).toContain("Enter the organization");
    expect(nameError("x".repeat(81))).toContain("80 characters");
    expect(nameError("Acme")).toBeNull();
    expect(adminError("handle", " ")).toContain("Trov handle");
    expect(adminError("handle", "@maya")).toBeNull();
    expect(adminError("github", "not a login")).toContain("GitHub login");
    expect(adminError("github", "octocat")).toBeNull();
    expect(adminError("email", "maya@")).toContain("email address");
    expect(adminError("email", "maya@acme.example")).toBeNull();
    expect(addOrgErrors({ name: "", slug: "", adminKind: "handle", adminValue: "" })).toEqual({
      name: expect.any(String), slug: expect.any(String), admin: expect.any(String),
    });
    expect(addOrgErrors({ name: "Acme", slug: "acme", adminKind: "email", adminValue: "a@b.co" })).toEqual({});
  });
  it("sends exactly one admin key", () => {
    expect(adminTarget("handle", " @maya ")).toEqual({ handle: "maya" });
    expect(adminTarget("github", "@octocat")).toEqual({ github_login: "octocat" });
    expect(adminTarget("email", " maya@acme.example ")).toEqual({ email: "maya@acme.example" });
  });
  it("puts each server error next to the field it concerns", () => {
    const d = { slug: "acme", adminKind: "handle" as const, adminValue: "@ghost" };
    expect(addOrgServerError("slug_taken", d)).toEqual({ slug: "“acme” is already in use. Pick another slug." });
    expect(addOrgServerError("reserved_slug", d).slug).toContain("reserved");
    expect(addOrgServerError("invalid_slug", d).slug).toContain("2 to 39");
    expect(addOrgServerError("invalid_name", d).name).toContain("1 to 80");
    expect(addOrgServerError("no_such_person", d).admin).toBe("No one has the handle @ghost. Check the spelling, or invite them by GitHub login or email instead.");
    expect(addOrgServerError("invalid_admin", d).admin).toBeTruthy();
    expect(addOrgServerError("500", d)).toEqual({ form: "The organization wasn't created. Check your connection and try again." });
    expect(ownerServerError("no_such_person", { kind: "handle", value: "ghost" })).toContain("@ghost");
    expect(ownerServerError("boom", { kind: "handle", value: "ghost" })).toContain("try again");
  });
  it("the empty dialog: three labelled fields, the admin choice as the segmented control, a Create button", () => {
    const html = addOrgModal(blankAddOrg());
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="plat-add-t"');
    expect(html).toContain('data-overlay="plat-add"');
    expect(html).toContain('<label for="plat-add-name"');
    expect(html).toContain('<label for="plat-add-slug"');
    expect(html).toContain('<label for="plat-add-admin"');
    expect(html).toContain('data-seg="plat-add-kind" data-morph-key="seg:plat-add-kind" role="group" aria-label="How to name the org admin"');
    for (const label of ["Existing person", "GitHub login", "Email"]) expect(html).toContain(label);
    expect(html).toContain('data-act="platAddSubmit"');
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain('role="alert"');
    // Enter in any field submits.
    expect((html.match(/data-enter="platAddSubmit"/g) ?? []).length).toBe(3);
  });
  it("shows errors inline, marks the field invalid and points it at its message", () => {
    const html = addOrgModal({ ...blankAddOrg(), name: "Acme", slug: "acme", adminKind: "github", adminValue: "bad login", errors: { slug: "“acme” is already in use. Pick another slug.", admin: "Enter a GitHub login." } });
    expect(html).toContain('id="plat-add-slug" data-act="platAddSlug" data-field="platAddSlug" data-enter="platAddSubmit" value="acme" autocomplete="off" spellcheck="false" aria-invalid="true" aria-describedby="plat-add-slug-err"');
    expect(html).toContain('<div id="plat-add-slug-err" role="alert"');
    expect(html).toContain("“acme” is already in use. Pick another slug.");
    expect(html).toContain('<div id="plat-add-admin-err" role="alert"');
    expect(html).not.toContain('id="plat-add-name-err"');
    expect(html).toContain("border-color:var(--red)");
  });
  it("is inert while the write runs", () => {
    const html = addOrgModal({ ...blankAddOrg(), name: "Acme", slug: "acme", adminValue: "maya", busy: true });
    expect(html).toContain("Creating…");
    expect(html).toMatch(/data-act="platAddSubmit" disabled/);
    expect(html).toMatch(/id="plat-add-name"[^>]* disabled/);
  });
  it("says plainly what happened: an existing person is the owner; anyone else was invited", () => {
    expect(assignmentSentence({ status: "owner", handle: "maya" })).toBe("@maya is now the owner.");
    expect(assignmentSentence({ status: "invited", invite_id: 3, github_login: "octocat", email: null })).toBe("Invited octocat — they become the owner when they sign in and accept. No email is sent for a GitHub login: tell them it is waiting.");
    expect(assignmentSentence({ status: "invited", invite_id: 3, github_login: null, email: "a@b.co" }, true)).toBe("Invited a@b.co — they become an owner when they sign in and accept. Trov emailed them the invitation.");
    const owner = addOrgModal({ ...blankAddOrg(), done: { name: "Acme", slug: "acme", admin: { status: "owner", handle: "maya" } } });
    expect(owner).toContain("Acme was created");
    expect(owner).toContain("@maya is now the owner.");
    expect(owner).toContain('data-act="platOpenOrg" data-arg="acme"');
    expect(owner).not.toContain('data-act="platAddSubmit"');
    const invited = addOrgModal({ ...blankAddOrg(), done: { name: "Acme", slug: "acme", admin: { status: "invited", invite_id: 1, github_login: null, email: "dana@acme.example" } } });
    expect(invited).toContain("Invited dana@acme.example — they become the owner when they sign in and accept.");
  });
  it("renders at the app root only on the Platform screen, for a superadmin", () => {
    expect(platformDialogs(plat({ add: blankAddOrg() }), "platform")).toContain('id="plat-add"');
    expect(platformDialogs(plat({ add: blankAddOrg() }), "mywork")).toBe("");
    expect(platformDialogs(plat(), "platform")).toBe("");
  });
});

describe("one organization", () => {
  const open = (over: Partial<PlatState> = {}) => plat({ orgSlug: "acme", detail: { status: "ok", data: detailOf() }, orgAudit: { status: "ok", data: [audit()] }, ...over });

  it("shows the header, members and pending invites in one People list, usage and audit; adding an owner is behind a button", () => {
    const html = platformOrgView(open());
    expect(html).toContain(">Acme</h2>");
    expect(html).toContain("ACTIVE");
    expect(html).toContain("created Sep 1, 2026 by @andres");
    expect(html).toContain("Maya Ortiz");
    expect(html).toContain("OWNER");
    expect(html).toContain("MEMBER");
    expect(html).toContain("octocat");
    expect(html).toContain("PENDING");
    expect(html).not.toContain("old@acme.example");
    expect(html).toMatch(/<h2[^>]*>People<\/h2><span class="cnpy-badge" data-n="\d+">/);
    expect(html).toContain('data-act="platOwnerToggle" data-field="platOwnerToggle" aria-expanded="false"');
    expect(html).not.toContain('data-act="platOwnerSubmit"');
    const adding = platformOrgView(open({ ownerOpen: true }));
    expect(adding).toContain('aria-expanded="true"');
    expect(adding).toContain('data-act="platOwnerSubmit"');
    expect(html).toContain("Top MCP tools");
    expect(html).toContain("get_feed");
    expect(html).toContain("org.create");
    expect(platformCrumb(open())).toBe("Acme");
  });
  it("states that a superadmin is not a member and cannot see the org's content", () => {
    expect(NOT_A_MEMBER).toContain("not a member");
    expect(NOT_A_MEMBER).toContain("cannot open or read its content");
    expect(platformOrgView(open())).toContain(NOT_A_MEMBER);
  });
  it("an active org offers Suspend; a suspended one says so and offers Unsuspend", () => {
    const active = platformOrgView(open());
    // Suspend is text until pointed at (`cnpy-org-danger`), never a button at the weight of the page's actions.
    expect(active).toMatch(/<button data-confirm-trigger aria-expanded="false" aria-controls="plat-suspend-confirm" type="button" data-act="platSuspendArm" data-arg="suspend"[^>]*class="cnpy-org-danger" aria-haspopup="dialog"[^>]*>Suspend<\/button>/);
    const sus = platformOrgView(open({ detail: { status: "ok", data: detailOf({ org: org({ status: "suspended", suspended_at: "2026-10-02T10:00:00.000Z", suspended_by: "andres" }) }) } }));
    expect(sus).toContain("SUSPENDED");
    expect(sus).toContain("by @andres");
    expect(sus).toContain("No data was deleted.");
    expect(sus).toContain('data-act="platSuspendArm" data-arg="unsuspend"');
    expect(sus).not.toContain('data-arg="suspend"');
  });
  it("the confirmation says exactly what suspension does", () => {
    const copy = suspendCopy(org(), true);
    expect(copy.title).toBe("Suspend Acme?");
    expect(copy.body).toBe("Its 4 members lose access right away, and its MCP tokens and connected apps stop working. No data is deleted, and you can unsuspend it at any time.");
    expect(suspendCopy(org({ member_count: 1 }), true).body).toContain("Its 1 member loses access");
    expect(suspendCopy(org(), false).title).toBe("Unsuspend Acme?");
    const modal = platformDialogs(open({ suspendArm: "suspend" }), "platformorg");
    expect(modal).toContain('role="alertdialog"');
    expect(modal).toContain('data-confirm-act="platSuspendGo" data-confirm-cancel="platSuspendCancel"');
    expect(modal).toContain("No data is deleted");
    expect(modal).toContain(">Suspend</button>");
    expect(platformDialogs(open({ suspendArm: "suspend", suspendBusy: true }), "platformorg")).toContain("Suspending…");
    expect(platformDialogs(open({ suspendArm: "unsuspend" }), "platformorg")).toContain(">Unsuspend</button>");
    expect(platformDialogs(open(), "platformorg")).toBe("");
  });
  it("add another owner: the error sits under the field; success is said in a sentence", () => {
    const err = platformOrgView(open({ owner: { kind: "handle", value: "ghost", busy: false, error: "No one has the handle @ghost.", done: null } }));
    expect(err).toContain('id="plat-owner-input-err" role="alert"');
    expect(err).toContain('aria-invalid="true"');
    const done = platformOrgView(open({ owner: { kind: "github", value: "", busy: false, error: null, done: { status: "invited", invite_id: 2, github_login: "octocat", email: null } } }));
    expect(done).toContain("Invited octocat — they become an owner when they sign in and accept.");
  });
  it("empty, loading and failed states", () => {
    const bare = platformOrgView(open({ detail: { status: "ok", data: detailOf({ members: [], invites: [] }) }, orgAudit: { status: "ok", data: [] } }));
    expect(bare).toContain("No members yet");
    expect(bare).not.toContain("PENDING");
    // With no owner the form to add one is simply there.
    expect(bare).toContain('data-act="platOwnerSubmit"');
    expect(bare).toContain("No audit entries for this organization.");
    expect(platformOrgView(plat({ orgSlug: "acme", detail: { status: "loading", data: null } }))).toContain("Loading the organization…");
    expect(platformOrgView(plat({ orgSlug: "acme", detail: { status: "error", data: null } }))).toContain("Couldn't load this organization.");
    // Another org's stale detail never shows under this slug.
    expect(platformOrgView(plat({ orgSlug: "beta", detail: { status: "ok", data: detailOf() } }))).not.toContain(">Acme</h2>");
  });
});

describe("Usage", () => {
  it("the window is the app's segmented control: 7 / 30 / 90 days", () => {
    const html = usageView({ status: "ok", usage: report([usageOf()]), days: 30, open: null });
    expect(html).toContain('class="cnpy-seg cnpy-seg--sm" data-seg="plat-usage-days" data-morph-key="seg:plat-usage-days" role="group" aria-label="Usage window"');
    for (const d of ["7", "90"]) expect(html).toContain(`data-act="platUsageDays" data-arg="${d}"`);
    expect(html).toContain('class="cnpy-seg-btn is-on" aria-pressed="true">30 days</button>');
  });
  it("shows the six totals as stat tiles", () => {
    const html = usageView({ status: "ok", usage: report([usageOf()]), days: 7, open: null });
    for (const label of ["Organizations", "People", "API requests", "MCP tool calls", "Active people", "Storage"]) expect(html).toContain(`>${label}</div>`);
    expect(html).toContain("380 reads · 40 writes");
    expect(html).toContain("3.0 MB");
    expect(html).toContain("none suspended");
  });
  it("one row per org, most active first, with a sparkline per metric, sizes and last activity", () => {
    const rows = [quiet("zeta", "Zeta"), usageOf(), quiet("beta", "Beta", { status: "suspended" })];
    expect(sortByActivity(rows).map((o) => o.slug)).toEqual(["acme", "beta", "zeta"]);
    const html = usageView({ status: "ok", usage: report(rows), days: 7, open: null });
    expect(html.indexOf('data-arg="acme"')).toBeLessThan(html.indexOf('data-arg="beta"'));
    expect(html).toContain('aria-label="Acme: API requests per day: 420 in total, 120 on the busiest day"');
    expect(html).toContain('aria-label="Acme: MCP tool calls per day: 64 in total, 20 on the busiest day"');
    expect(html).toContain("SUSPENDED");
    expect(html).toContain("3.0 MB");
    expect(html).toContain("Never");
    expect(html).toContain('aria-expanded="false" aria-controls="plat-usage-acme"');
  });
  it("an opened row shows what was created, by kind, and the top MCP tools", () => {
    const html = usageView({ status: "ok", usage: report([usageOf()]), days: 7, open: "acme" });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="plat-usage-acme"');
    expect(html).toContain("Created in the last 7 days");
    for (const kind of ["Feed entries", "Tickets", "Doc versions", "Sprints", "Prompts", "Handoffs", "Artifacts"]) expect(html).toContain(kind);
    expect(html).toContain("get_feed");
    expect(html).toContain('data-act="platOpenOrg" data-arg="acme"');
    expect(usageBreakdown(activity(), 30)).toContain("No MCP tool was called in the last 30 days.");
  });
  it("sparklines: a real path with data; a flat line — never a broken path — with zeros, one point or nothing", () => {
    expect(sparkPath([0, 5, 10])).toBe("0.0,21.0 50.0,12.0 100.0,3.0");
    expect(sparkPath([0, 0, 0])).toBe("0,21.0 100,21.0");
    expect(sparkPath([])).toBe("0,21.0 100,21.0");
    expect(sparkPath([7])).toBe("0,21.0 100,21.0");
    expect(sparkPath([NaN, -3, 0])).toBe("0,21.0 100,21.0");
    for (const values of [[0, 0, 0], [], [4], [1, 2, 3]]) {
      const svg = sparkline(values, "var(--accent)", "Requests per day");
      expect(svg).toMatch(/<polyline points="[\d., ]+" fill="none"/);
      expect(svg).not.toContain("NaN");
      expect(svg).toContain('role="img"');
    }
    // Zeros are a muted line and say so; data wears the token it was given. No colour is hard-coded.
    expect(sparkline([0, 0], "var(--accent)", "Requests per day")).toContain('stroke="var(--border-strong)"');
    expect(sparkline([0, 0], "var(--accent)", "Requests per day")).toContain("Requests per day: none in this window");
    expect(sparkline([1, 2], "var(--accent)", "Requests per day")).toContain('stroke="var(--accent)"');
    expect(usageView({ status: "ok", usage: report([usageOf()]), days: 7, open: "acme" })).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
  it("all-zero usage: an empty state, zero tiles, flat sparklines, sizes still listed", () => {
    const html = usageView({ status: "ok", usage: report([quiet("acme", "Acme")], { sizes: sizes() }), days: 30, open: null });
    expect(noActivity(activity())).toBe(true);
    expect(html).toContain("No activity in the last 7 days");
    expect(html).toContain("Sizes below are current.");
    expect(html).toContain("0 B");
    expect(html).not.toContain("NaN");
    expect((html.match(/points="0,21\.0 100,21\.0"/g) ?? []).length).toBe(4);
    expect(html).toContain('data-arg="acme"');
    const none = usageView({ status: "ok", usage: report([], { sizes: sizes() }), days: 30, open: null });
    expect(none).toContain("Add an organization first.");
    expect(none).not.toContain("plat-usage-grid");
  });
  it("loading and failed states keep the window switch", () => {
    const loading = usageView({ status: "loading", usage: null, days: 90, open: null });
    expect(loading).toContain("Loading usage…");
    expect(loading).toContain('data-seg="plat-usage-days"');
    const failed = usageView({ status: "error", usage: null, days: 90, open: null });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('data-act="platReload"');
  });
  it("formats counts and bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB");
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(12345)).toBe("12.3K");
    expect(formatNumber(4_560_000)).toBe("4.56M");
  });
  it("the org detail's usage block carries the same figures", () => {
    const html = orgUsageBlock(usageOf(), 30);
    expect(html).toContain("420");
    expect(html).toContain("of 4 members");
    expect(html).toContain("3 open of 9");
    expect(orgUsageBlock(quiet("acme", "Acme"), 30)).toContain("No activity in the last 30 days.");
  });
});

describe("Admins & limits", () => {
  const admins = (over: Partial<PlatState> = {}) => plat({
    tab: "admins",
    admins: { status: "ok", data: [{ handle: "andres", name: "Andres", granted_at: "2026-10-01T10:00:00.000Z", granted_by: "migration" }, { handle: "maya", name: null, granted_at: "2026-10-02T10:00:00.000Z", granted_by: "andres" }] },
    ...over,
  });
  it("lists the superadmins, marks you, and offers Remove with a name a screen reader can tell apart", () => {
    const html = adminsTab(admins(), "Andres");
    expect(html).toContain("@andres");
    expect(html).toContain("by @migration");
    expect((html.match(/>YOU</g) ?? []).length).toBe(1);
    expect(html).toContain('data-act="platRevokeArm" data-arg="maya"');
    expect(html).toContain('aria-label="Remove @maya as superadmin"');
  });
  it("grant: a labelled field, a button that wakes up with a handle, and the error under it", () => {
    expect(adminsTab(admins(), null)).toMatch(/data-act="platGrantSubmit" disabled/);
    expect(adminsTab(admins({ grantDraft: "sam" }), null)).toContain('data-act="platGrantSubmit" class="cnpy-accentbtn"');
    const err = adminsTab(admins({ grantDraft: "ghost", grantError: "No one has the handle @ghost." }), null);
    expect(err).toContain('<label for="plat-grant"');
    expect(err).toContain('aria-invalid="true" aria-describedby="plat-grant-err"');
    expect(err).toContain('<div id="plat-grant-err" role="alert"');
  });
  it("removal goes through the confirmation; the last-superadmin refusal is a sentence", () => {
    const modal = platformDialogs(admins({ revokeArm: "maya" }), "platform");
    expect(modal).toContain("Remove @maya as superadmin?");
    expect(modal).toContain('data-confirm-act="platRevokeGo" data-confirm-cancel="platRevokeCancel" data-arg="maya"');
    expect(lastSuperadminSentence("andres")).toBe("@andres is the only superadmin, so they can't be removed. Grant someone else first, then remove them.");
    const html = adminsTab(admins({ revokeError: lastSuperadminSentence("andres") }), "andres");
    expect(html).toContain('role="alert"');
    expect(html).toContain("is the only superadmin");
  });
  it("has no org-creation limit control any more: a grant (the Access tab) is how a person gets to create one", () => {
    const html = adminsTab(admins(), null);
    expect(html).not.toMatch(/plat-limit|platLimit|Organization limit/);
    expect(html).toContain("grant them");
  });
  it("loading and failed states", () => {
    expect(adminsTab(plat({ admins: { status: "loading", data: [] } }), null)).toContain("Loading superadmins…");
    expect(adminsTab(plat({ admins: { status: "error", data: [] } }), null)).toContain("Couldn't load the superadmins.");
  });
});

describe("Audit", () => {
  const rows = [audit(), audit({ id: "a2", org: null, action: "platform.org_limit", target: "maya", detail: { limit: 5, nested: { x: 1 } } }), audit({ id: "s1", action: "secret.set", target: "<b>x</b>", detail: {} })];
  it("lists entries with the org, actor, action, target and detail; a platform-level entry says so", () => {
    const html = auditTab({ audit: { status: "ok", data: rows }, auditOrg: "", orgs: { status: "ok", data: [org()] } });
    expect(html).toContain("org.create");
    expect(html).toContain("name: Acme");
    expect(html).toContain("platform.org_limit");
    expect(html).toContain("limit: 5");
    expect(html).not.toContain("[object Object]");
    expect(html).toContain(">platform</span>");
    expect(html).toContain("@andres");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("filters by org with a labelled select; filtered, the org column goes", () => {
    const all = auditTab({ audit: { status: "ok", data: rows }, auditOrg: "", orgs: { status: "ok", data: [org()] } });
    expect(all).toContain('<select data-act="platAuditOrg"');
    expect(all).toContain('<option value="" selected>All organizations</option>');
    expect(all).toContain('<option value="acme">Acme (acme)</option>');
    const one = auditTab({ audit: { status: "ok", data: [audit()] }, auditOrg: "acme", orgs: { status: "ok", data: [org()] } });
    expect(one).toContain('<option value="acme" selected>');
    expect(one).not.toContain("plat-au-org");
  });
  it("empty, loading and failed states", () => {
    const base = { orgs: { status: "ok" as const, data: [org()] } };
    expect(auditTab({ ...base, audit: { status: "ok", data: [] }, auditOrg: "" })).toContain("No audit entries");
    expect(auditTab({ ...base, audit: { status: "ok", data: [] }, auditOrg: "acme" })).toContain("Nothing has been recorded for this organization yet.");
    expect(auditTab({ ...base, audit: { status: "loading", data: [] }, auditOrg: "" })).toContain("Loading the audit log…");
    expect(auditTab({ ...base, audit: { status: "error", data: [] }, auditOrg: "" })).toContain("Couldn't load the audit log.");
  });
});

describe("routes", () => {
  const base = { ticketId: null, sprintId: null };
  it("parses and round-trips every Platform route", () => {
    const cases: [string, ReturnType<typeof parseHash>][] = [
      ["#platform", { screen: "platform", ...base, platTab: "orgs" }],
      ["#platform/usage", { screen: "platform", ...base, platTab: "usage" }],
      ["#platform/admins", { screen: "platform", ...base, platTab: "admins" }],
      ["#platform/audit", { screen: "platform", ...base, platTab: "audit" }],
      ["#platform/orgs/acme-robotics", { screen: "platformorg", ...base, platOrg: "acme-robotics" }],
    ];
    for (const [hash, route] of cases) {
      expect(parseHash(hash), hash).toEqual(route);
      expect(hashForRoute(route), hash).toBe(hash);
    }
    expect(parseHash("#platform/orgs")).toEqual({ screen: "platform", ...base, platTab: "orgs" });
    expect(sameRoute(parseHash("#platform/usage"), parseHash("#platform/audit"))).toBe(false);
    expect(sameRoute(parseHash("#platform/orgs/a1"), parseHash("#platform/orgs/b2"))).toBe(false);
  });
  it("a malformed Platform hash falls back to My Work", () => {
    for (const bad of ["#platform/nope", "#platform/orgs/Bad_Slug", "#platform/orgs/acme/extra", "#platform/orgs/-x"]) {
      expect(parseHash(bad), bad).toEqual({ screen: "mywork", ...base });
    }
  });
});

// ── /platform/: the same screens outside any organization ────────────────────
describe("the standalone Platform page (/platform/)", () => {
  const plat = (over: Partial<PlatState> = {}): PlatState => ({ ...initialPlat(), superadmin: true, orgs: { status: "ok", data: [org()] }, ...over });
  const page = (over: Partial<AppState> = {}): AppState => ({
    ...initialState(), view: "platform", screen: "platform", orgSlug: null, plat: plat(),
    me: { handle: "andres", name: "Andres", email: null, color: "moss", avatar_url: null, avatar_source: null, admin: false, identities: [], orgs: [], superadmin: true, pending_invites: 0 } as AppState["me"],
    ...over,
  });

  it("recognises its own path and nothing else", () => {
    expect(PLATFORM_PATH).toBe("/platform/");
    for (const p of ["/platform", "/platform/", "/platform/x"]) expect(isPlatformPath(p), p).toBe(true);
    for (const p of ["/", "/o/platform/", "/platformx", "/o/acme/"]) expect(isPlatformPath(p), p).toBe(false);
  });

  it("renders the Platform area for a superadmin with NO organization: tabs, the list, Add organization — and no org navigation", () => {
    const html = render(page());
    expect(html).toContain('data-screen-label="Platform (outside an organization)"');
    expect(html).toContain("<h1 class=\"cnpy-platpage-t\">Platform</h1>");
    expect(html).toContain('data-act="platTab"');            // the tab bar
    expect(html).toContain('data-act="platAddOpen"');        // the primary action
    expect(html).toContain("Acme");                          // the organizations list
    expect(html).toContain('data-act="signOut"');
    expect(html).toMatch(/<a href="\/"[^>]*>Your organizations<\/a>/);
    // No app shell: no sidebar, no org switcher, no quick search, no org menu.
    expect(html).not.toContain("cnpy-aside");
    expect(html).not.toContain('data-act="orgsMenu"');
    expect(html).not.toContain('data-act="goMyWork"');
    expect(html).not.toContain("Choose an organization");
  });

  it("one organization: the title goes back to the list and a crumb names the org; its dialogs render at the root", () => {
    const detail = { status: "ok" as const, data: { org: org(), members: [], invites: [], usage: usageOf() } };
    const html = render(page({ screen: "platformorg", plat: plat({ orgSlug: "acme", detail }) }));
    expect(html).toMatch(/<button type="button" data-act="platGo"[^>]*>Platform<\/button>/);
    expect(html).toContain(NOT_A_MEMBER);
    const armed = render(page({ screen: "platformorg", plat: plat({ orgSlug: "acme", detail, suspendArm: "suspend" }) }));
    expect(armed).toContain("data-confirm-dialog");
    const adding = render(page({ plat: plat({ add: blankAddOrg() }) }));
    expect(adding).toContain("data-plat-dialog");
  });

  it("someone who is not a superadmin gets the gate's sentence, never the screens", () => {
    const html = platformPage(plat({ superadmin: false }), "platform", "sam");
    expect(html).toContain("This page isn't available to your account.");
    expect(html).not.toContain('data-act="platTab"');
    expect(html).not.toContain('data-act="platAddOpen"');
  });

  it("its controls are keyboard-reachable with a visible focus, and the header wraps at phone width", () => {
    expect(css).toMatch(/\.cnpy-platpage a:focus-visible, \.cnpy-platpage-hdr button:focus-visible \{ outline:2px solid/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.cnpy-platpage-hdr[^}]*\}\s*\.cnpy-platpage-r \{ width:100%; \}/);
    expect(css).toMatch(/\.cnpy-platpage-hdr \{[^}]*flex-wrap:wrap/);
  });
});

describe("design system and phone layout", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  it("the tables reflow by their own width — no sideways scroll on a phone", () => {
    expect(rules).toContain(".plat-table, .plat-cq { container-type:inline-size; }");
    expect(rules).toMatch(/@container \(max-width: 860px\) \{ \.plat-thead \{ display:none !important; \}/);
    expect(rules).toContain(".plat-cl { display:block; }");
    expect(rules).toMatch(/@media \(max-width:640px\) \{ \.plat-inline \{ flex-direction:column;/);
  });
  it("every control in the area has a visible focus state", () => {
    expect(rules).toMatch(/\.plat button:focus-visible, \.plat select:focus-visible, \[data-plat-dialog\] button:focus-visible \{ outline:2px solid/);
  });
  it("uses tokens for every colour: no hex in any Platform markup", () => {
    const s = plat({ orgs: { status: "ok", data: [org(), org({ slug: "b2", status: "suspended" })] }, orgSlug: "acme", detail: { status: "ok", data: detailOf() }, orgAudit: { status: "ok", data: [audit()] } });
    const all = [
      platformView(s), platformView({ ...s, tab: "admins" }), platformView({ ...s, tab: "audit" }), platformOrgView(s),
      addOrgModal({ ...blankAddOrg(), errors: { name: "x", slug: "y", admin: "z", form: "w" } }),
    ].join("");
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(all).not.toMatch(/font-family:(?!var\(--(sans|label|code)\))/);
  });
});
