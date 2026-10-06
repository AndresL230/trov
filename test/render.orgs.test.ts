/**
 * Organizations in the SPA (multitenancy Phase 6): where a page load lands, the org switcher in
 * the sidebar's header, the org picker / first run, the create dialog, that every admin-only
 * control reads the role in the org ON SCREEN, what an org with no repository shows, and that
 * no copy names one particular organization.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import css from "../web/src/trov.css?raw";
import { orgSlugFromPath, orgBase, orgHref, resolveLanding, isOrgAdmin, findOrg } from "../web/src/org-context";
import {
  orgSwitcherButton, orgMenu, orgPickerView, acceptLanding, createOrgModal, createOrgErrors, createOrgServerError, orgCapSentence, inviteSentence,
  lostOrgSentence, blankCreateOrg, initialOrgsUi, type OrgsUi,
} from "../web/src/org-picker";
import { render, initialState, viewerIsAdmin, viewerOrg, mcpAccessSection, grantListBody, tokenListBody, type AppState } from "../web/src/render";
import { repoView, type RepoProps } from "../web/src/repo";
import { newHandoffView, blankHandoff } from "../web/src/handoffs";
import { artifactsView, artifactRepoOptions, initialArtUi, initialArtCreate, ART_ROUTE_NONE, type ArtProps } from "../web/src/artifacts";
import { membersTab, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import { confirmModal } from "../web/src/confirm";
import { platformDialogs, initialPlat } from "../web/src/platform";
import { setPrimaryRepo, repoUrl, primaryRepo } from "../web/src/github";
import { matchIssueRef } from "../web/src/issue-ref";
import type { Me } from "../web/src/api";
import type { MyInvite, MyOrg, MyOrgsResponse, OrgRole } from "@shared/orgs";

const sources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const acme = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme Robotics", role });
const sapling = (role: OrgRole = "member"): MyOrg => ({ slug: "saplinglearn", name: "SaplingLearn", role });
const invite = (o: Partial<MyInvite> = {}): MyInvite => ({
  id: 7, org: { slug: "globex", name: "Globex" }, role: "admin", invited_by: "hank", created_at: "2026-10-05T09:00:00.000Z", github_login: "ines-vidal", email: null, ...o,
});
const mine = (o: Partial<MyOrgsResponse> = {}): MyOrgsResponse => ({ orgs: [acme(), sapling()], invites: [], superadmin: false, can_create: true, created: 1, limit: 3, ...o });
const me = (orgs: MyOrg[], o: Partial<Me> = {}): Me => ({
  handle: "ines", name: "Ines Vidal", avatar_url: null, color: "fern", identities: [{ provider: "github", label: "ines-vidal", linked_at: "t" }],
  orgs, superadmin: false, pending_invites: 0, ...o,
});
const ui = (o: Partial<OrgsUi> = {}): OrgsUi => ({ ...initialOrgsUi(), ...o });
const app = (o: Partial<AppState> = {}): AppState => ({ ...initialState(), view: "app", me: me([acme("member")]), orgSlug: "acme", ...o });
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

afterEach(() => { setPrimaryRepo(null); });

// ── where a page load lands ──────────────────────────────────────────────────
describe("the org in the URL", () => {
  it("reads the slug from /o/<slug>/…, and from nothing else", () => {
    expect(orgSlugFromPath("/o/acme/")).toBe("acme");
    expect(orgSlugFromPath("/o/acme")).toBe("acme");
    expect(orgSlugFromPath("/o/Acme/anything")).toBe("acme");
    for (const p of ["/", "/terms", "/o/", "/o", "/orgs/acme/", "/o/-bad/", "/o/a/", "/api/o/acme/me"]) expect(orgSlugFromPath(p), p).toBeNull();
  });
  it("writes every in-app URL under the org, with the hash route after it", () => {
    expect(orgBase("acme")).toBe("/o/acme/");
    expect(orgBase(null)).toBe("/");
    expect(orgHref("acme")).toBe("/o/acme/");
    expect(orgHref("acme", "#tickets/12")).toBe("/o/acme/#tickets/12");
    expect(orgHref("acme", "org")).toBe("/o/acme/#org");
    expect(orgHref("acme", "#")).toBe("/o/acme/");
  });
});

describe("resolveLanding — /, /o/<slug>/, old deep links", () => {
  it("one org: `/` (and an old `/#tickets/12`) opens it, to be rewritten under its path", () => {
    expect(resolveLanding({ pathSlug: null, orgs: [sapling()] })).toEqual({ kind: "org", slug: "saplinglearn", rewrite: true });
    // A stale last-used slug changes nothing for a one-org person.
    expect(resolveLanding({ pathSlug: null, orgs: [sapling()], lastUsed: "gone" })).toEqual({ kind: "org", slug: "saplinglearn", rewrite: true });
  });
  it("several orgs: the last one opened in this browser, if they are still in it; otherwise the picker", () => {
    const orgs = [acme(), sapling()];
    expect(resolveLanding({ pathSlug: null, orgs, lastUsed: "saplinglearn" })).toEqual({ kind: "org", slug: "saplinglearn", rewrite: true });
    expect(resolveLanding({ pathSlug: null, orgs, lastUsed: "left-that-one" })).toEqual({ kind: "picker", lost: null });
    expect(resolveLanding({ pathSlug: null, orgs })).toEqual({ kind: "picker", lost: null });
  });
  it("no org: the picker", () => {
    expect(resolveLanding({ pathSlug: null, orgs: [], lastUsed: "acme" })).toEqual({ kind: "picker", lost: null });
  });
  it("/o/<slug>/: that org when it is theirs (nothing to rewrite); not theirs → the picker, naming it", () => {
    expect(resolveLanding({ pathSlug: "acme", orgs: [acme(), sapling()], lastUsed: "saplinglearn" })).toEqual({ kind: "org", slug: "acme", rewrite: false });
    expect(resolveLanding({ pathSlug: "globex", orgs: [acme()] })).toEqual({ kind: "picker", lost: "globex" });
    expect(resolveLanding({ pathSlug: "globex", orgs: [] })).toEqual({ kind: "picker", lost: "globex" });
  });
  it("after sign-in the org they signed in FROM wins over last-used — if they are in it", () => {
    const orgs = [acme(), sapling()];
    expect(resolveLanding({ pathSlug: null, orgs, lastUsed: "acme", returnOrg: "saplinglearn" })).toEqual({ kind: "org", slug: "saplinglearn", rewrite: true });
    expect(resolveLanding({ pathSlug: null, orgs, lastUsed: "acme", returnOrg: "globex" })).toEqual({ kind: "org", slug: "acme", rewrite: true });
  });
});

// ── the switcher ─────────────────────────────────────────────────────────────
describe("the org switcher — the sidebar's header", () => {
  it("names the current org on a real button that opens the menu, with an accessible name", () => {
    const html = orgSwitcherButton({ org: acme(), open: false, invites: 0, collapsed: false });
    expect(html).toMatch(/<button type="button" data-act="orgsMenu"[^>]*aria-haspopup="dialog" aria-expanded="false" aria-controls="orgs-menu" aria-label="Acme Robotics: switch organization"/);
    expect(html).toContain('<span class="cnpy-lbl cnpy-orgsw-n">Acme Robotics</span>');
    expect(html).toContain('data-tip="Acme Robotics: switch organization"');   // the collapsed rail's tooltip
    expect(orgSwitcherButton({ org: acme(), open: true, invites: 0, collapsed: false })).toContain('aria-expanded="true"');
  });
  it("counts pending invitations on the button (hidden at 0, like every rail badge)", () => {
    expect(orgSwitcherButton({ org: acme(), open: false, invites: 2, collapsed: false })).toContain('<span class="cnpy-lbl cnpy-badge" data-n="2" title="2 pending invitations">2</span>');
    expect(orgSwitcherButton({ org: acme(), open: false, invites: 0, collapsed: false })).toContain('data-n="0"');
  });
  it("is the SAME element tree collapsed or not, and with an org or without", () => {
    const skeleton = (html: string) => (html.match(/<\/?[a-z][a-z0-9]*/gi) ?? []).join(" ");
    const base = skeleton(orgSwitcherButton({ org: acme(), open: false, invites: 0, collapsed: false }));
    expect(skeleton(orgSwitcherButton({ org: acme(), open: true, invites: 3, collapsed: true }))).toBe(base);
    expect(skeleton(orgSwitcherButton({ org: null, open: false, invites: 0, collapsed: false }))).toBe(base);
  });
  it("escapes an org's name", () => {
    const html = orgSwitcherButton({ org: { slug: "x1", name: `<img src=x onerror="1">`, role: "member" }, open: false, invites: 0, collapsed: false });
    expect(html).not.toContain("<img");
  });

  it("render(): the rail carries it under the logo — expanded, collapsed and in the phone drawer — and no Org settings row", () => {
    for (const over of [{}, { collapsed: true }, { phone: true, narrow: true, drawer: true }] as Partial<AppState>[]) {
      const html = render(app(over));
      const aside = html.slice(html.indexOf('<aside class="cnpy-aside"'), html.indexOf("</aside>"));
      expect(aside.indexOf("cnpy-orgslot")).toBeGreaterThan(aside.indexOf("cnpy-logo"));
      expect(aside.indexOf("cnpy-orgslot")).toBeLessThan(aside.indexOf("cnpy-navlist"));
      expect(aside).toContain("Acme Robotics");
      expect(aside).not.toContain('data-act="orgGo"');
      expect(aside).not.toContain(">Organization<");
    }
    expect(render(app({ screen: "org" }))).toContain('class="cnpy-orgslot is-active"');
  });
  it("CSS: the collapsed rail keeps the tile, the menu clears the rail and sits above the phone drawer, short windows tighten the rail", () => {
    expect(rules).toContain('[data-collapsed="1"] .cnpy-orgsw-b {');
    expect(rules).toContain('[data-collapsed="1"] .cnpy-orgmenu { top:56px; left:70px;');
    expect(rules).toMatch(/\.cnpy-orgmenu-layer \{ position:fixed; inset:0; z-index:95; \}/);   // the drawer is z-index 90
    expect(rules).toContain("@media (max-height: 990px)");
    expect(rules).toContain("@media (max-height: 850px)");
    expect(rules).toMatch(/\.cnpy-orgmenu \.cnpy-menurow:focus-visible[^{]*\{ outline:2px solid/);
  });
});

describe("the switcher's menu", () => {
  const menu = (orgs: MyOrgsResponse | null, u: Partial<OrgsUi> = {}, current: string | null = "acme") =>
    orgMenu({ orgs, mine: [acme(), sapling()], current, status: orgs ? "ok" : "loading", ui: ui({ menu: true, ...u }) });

  it("is not rendered until it is opened", () => {
    expect(orgMenu({ orgs: mine(), mine: [], current: "acme", status: "ok", ui: ui() })).toBe("");
    // A superadmin's menu ends with a plain link to the Platform area's own page; nobody else's does.
    const forSuper = orgMenu({ orgs: mine(), mine: [], current: "acme", status: "ok", ui: ui({ menu: true }), superadmin: true });
    expect(forSuper).toMatch(/<a href="\/platform\/" data-orgs-item data-orgs-platform class="cnpy-menurow"[^>]*>[\s\S]*?Platform<\/span><\/a>/);
    expect(orgMenu({ orgs: mine(), mine: [], current: "acme", status: "ok", ui: ui({ menu: true }) })).not.toContain("/platform/");
  });
  it("lists my orgs with MY role in each; each row is a real link to that org, the current one marked", () => {
    const html = menu(mine());
    expect(html).toContain('role="dialog" aria-label="Organizations"');
    expect(html).toMatch(/<a href="\/o\/acme\/" data-act="orgsSwitch" data-arg="acme" data-orgs-item class="cnpy-menurow is-active" aria-current="true"/);
    expect(html).toMatch(/<a href="\/o\/saplinglearn\/" data-act="orgsSwitch" data-arg="saplinglearn" data-orgs-item class="cnpy-menurow"/);
    expect(html).toContain(">Owner<");
    expect(html).toContain(">Member<");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });
  it("shows the list from sign-in until GET /api/orgs lands — never an empty menu", () => {
    const html = menu(null);
    expect(html).toContain("Acme Robotics");
    expect(html).toContain("SaplingLearn");
    expect(html).not.toContain("Create organization");
  });
  it("pending invitations say who invited me and as what, with Accept and Decline", () => {
    const html = menu(mine({ invites: [invite()] }));
    expect(html).toContain("Invitations");
    expect(html).toContain("Globex");
    expect(html).toContain("@hank invited you to join as an admin");
    expect(html).toMatch(/data-act="orgsInvite" data-arg="accept:7"[^>]*aria-label="Accept the invitation to Globex"/);
    expect(html).toMatch(/data-act="orgsInvite" data-arg="decline:7"[^>]*aria-label="Decline the invitation to Globex"/);
    expect(menu(mine())).not.toContain("Invitations");
    // While one is being answered both of its buttons wait.
    const busy = menu(mine({ invites: [invite()] }), { inviteBusy: 7 });
    expect(busy).toContain("Joining…");
    expect(busy.match(/data-act="orgsInvite"[^>]* disabled/g)).toHaveLength(2);
    expect(menu(mine({ invites: [invite()] }), { inviteError: "It was revoked." })).toContain('role="alert"');
  });
  it("holds Org settings (the rail's old entry) and Create organization", () => {
    const html = menu(mine());
    expect(html).toMatch(/<button type="button" data-act="orgsSettings" data-orgs-item class="cnpy-menurow"[^>]*>[\s\S]*?Org settings/);
    expect(html).toMatch(/<button type="button" data-act="orgsCreateOpen" data-orgs-item class="cnpy-menurow"[^>]*>[\s\S]*?Create organization/);
  });
  it("at the cap there is no Create button: the menu says how many, and whom to ask", () => {
    const html = menu(mine({ can_create: false, created: 3, limit: 3 }));
    expect(html).not.toContain("orgsCreateOpen");
    expect(html).toContain("You&#39;ve created 3 of the 3 organizations your account can create.");
  });
  it("its backdrop closes it", () => {
    expect(menu(mine())).toContain('<div data-act="orgsMenuClose" class="cnpy-orgmenu-back" aria-hidden="true"></div>');
  });
  it("render(): the menu is a root-level overlay, outside the rail that would clip it", () => {
    const html = render(app({ orgsUi: ui({ menu: true }), myOrgs: { status: "ok", data: mine() } }));
    const at = html.indexOf('data-overlay="orgs-menu"');
    expect(at).toBeGreaterThan(html.indexOf("</aside>"));
    expect(render(app())).not.toContain('data-overlay="orgs-menu"');
  });
});

// ── the picker ───────────────────────────────────────────────────────────────
describe("the org picker / first run", () => {
  const picker = (orgs: MyOrgsResponse | null, o: { mine?: MyOrg[]; ui?: Partial<OrgsUi>; hash?: string; status?: "ok" | "loading" | "error"; who?: Me } = {}) =>
    orgPickerView({ me: o.who ?? me(o.mine ?? orgs?.orgs ?? []), mine: o.mine ?? orgs?.orgs ?? [], orgs, status: o.status ?? (orgs ? "ok" : "loading"), ui: ui(o.ui), hash: o.hash ?? "" });

  it("accepting lands a new owner on Org settings (the setup checklist) and anyone else on the org's My Work", () => {
    const inv = (role: "owner" | "admin" | "member") => ({ org: { slug: "acme", name: "Acme" }, role });
    expect(acceptLanding(inv("owner"))).toBe("/o/acme/#org");
    expect(acceptLanding(inv("admin"))).toBe("/o/acme/");
    expect(acceptLanding(inv("member"))).toBe("/o/acme/");
  });
  it("a superadmin — with no organization at all — is offered the Platform area; nobody else is", () => {
    const none = mine({ orgs: [], invites: [], created: 0, superadmin: true });
    const html = orgPickerView({ me: me([]), mine: [], orgs: none, status: "ok", ui: ui(), hash: "", superadmin: true });
    expect(html).toContain("data-orgs-platform");
    expect(html).toMatch(/<a href="\/platform\/"[^>]*>Open Platform<\/a>/);
    expect(html).toContain("You do not need to belong to an organization.");
    expect(picker(mine({ orgs: [], invites: [], created: 0 }))).not.toContain("/platform/");
  });
  it("NOTHING AT ALL: says what Trov is for, offers to create an org, and says how to get invited — by this person's own login", () => {
    const html = picker(mine({ orgs: [], invites: [], created: 0 }));
    expect(html).toContain("Welcome to Trov, Ines");
    expect(html).toContain("Trov is a team&#39;s working memory");
    expect(html).toContain("Everything in it belongs to an organization.");
    expect(html).toContain("Create an organization for your team");
    expect(html).toMatch(/<button type="button" data-act="orgsCreateOpen" data-field="orgsCreateOpen"[^>]*>Create an organization<\/button>/);
    expect(html).toContain("Or wait for an invitation");
    expect(html).toContain("ask one of its admins to invite your GitHub login (ines-vidal)");
    expect(html).not.toContain("Your organizations");
    expect(html).not.toContain("Invitations");
  });
  it("a Google-only person is told to be invited by their email", () => {
    const who = me([], { identities: [{ provider: "google", label: "ines@acme.dev", linked_at: "t" }] });
    expect(picker(mine({ orgs: [], created: 0 }), { who })).toContain("invite your email (ines@acme.dev)");
  });
  it("SEVERAL ORGS: each is a real link that keeps the hash of the link that brought them here", () => {
    const html = picker(mine(), { hash: "#tickets/12" });
    expect(html).toContain("Choose an organization");
    expect(html).toContain("Your organizations");
    expect(html).toMatch(/<a href="\/o\/acme\/#tickets\/12" data-act="orgsSwitch" data-arg="acme" class="cnpy-orgs-row" aria-label="Open Acme Robotics"/);
    expect(html).toContain('href="/o/saplinglearn/#tickets/12"');
    expect(html).toContain("/o/acme/");
    expect(html).toContain(">Owner<");
    expect(html).not.toContain("Or wait for an invitation");
    expect(html).not.toContain("Welcome to Trov");
  });
  it("ONE ORG (the URL named another): its row, and the sentence about the one that did not open", () => {
    const html = picker(mine({ orgs: [sapling()] }), { ui: { lost: "globex" } });
    expect(html).toContain("That organization didn&#39;t open");
    expect(html).toContain(lostOrgSentence("globex").replace(/'/g, "&#39;"));
    expect(lostOrgSentence("globex")).toBe("You don't have access to “globex”. It may have been suspended, you may have been removed from it, or the link may be wrong.");
    expect(html).toContain('href="/o/saplinglearn/"');
    expect(html.match(/class="cnpy-orgs-row"/g)).toHaveLength(1);
  });
  it("INVITATIONS: who invited me, to what and as what, with Accept and Decline — also for a person with no org yet", () => {
    const html = picker(mine({ orgs: [], invites: [invite(), invite({ id: 8, org: { slug: "initech", name: "Initech" }, role: "member", invited_by: "bill", github_login: null, email: "ines@acme.dev" })], created: 0 }));
    expect(html).toContain("You&#39;ve been invited.");
    expect(html).toContain("@hank invited you to join as an admin");
    expect(html).toContain("@bill invited you to join as a member");
    expect(html).toContain("sent to @ines-vidal");
    expect(html).toContain("sent to ines@acme.dev");
    expect(html).toContain('data-arg="accept:7"');
    expect(html).toContain('data-arg="decline:8"');
    expect(html).not.toContain("Or wait for an invitation");
    expect(inviteSentence(invite({ role: "owner" }))).toBe("@hank invited you to join as an owner");
  });
  it("CAP REACHED: no Create button — the count, the limit and whom to ask", () => {
    const html = picker(mine({ orgs: [acme()], can_create: false, created: 3, limit: 3 }));
    expect(html).not.toContain("orgsCreateOpen");
    expect(html).toContain("You&#39;ve created 3 of the 3 organizations your account can create. Ask whoever runs this Trov to raise the limit.");
    expect(orgCapSentence({ created: 0, limit: 0 })).toBe("Your account can't create organizations. Ask whoever runs this Trov if you need one.");
    expect(orgCapSentence({ created: 1, limit: 1 })).toContain("1 of the 1 organization your");
  });
  it("before GET /api/orgs lands it shows what sign-in already knew, and says it is loading; a failure offers a retry", () => {
    const loading = picker(null, { mine: [acme()] });
    expect(loading).toContain("Acme Robotics");
    expect(loading).toContain("Loading your organizations");
    expect(loading).not.toContain("orgsCreateOpen");
    const failed = picker(null, { mine: [], status: "error" });
    expect(failed).toContain("Couldn't load your invitations.");
    expect(failed).toContain('data-act="orgsReload"');
  });
  it("always says who is signed in and offers Sign out", () => {
    const html = picker(mine({ orgs: [] }));
    expect(html).toContain("@ines");
    expect(html).toContain('data-act="signOut"');
  });
  it("render(): view `orgs` is the picker alone — no app shell, no sidebar", () => {
    const html = render({ ...initialState(), view: "orgs", me: me([]), myOrgs: { status: "ok", data: mine({ orgs: [], created: 0 }) } });
    expect(html).toContain('data-screen-label="Organizations"');
    expect(html).not.toContain("cnpy-shell");
    expect(html).not.toContain("cnpy-aside");
    // The create dialog opens over it.
    expect(render({ ...initialState(), view: "orgs", me: me([]), orgsUi: ui({ create: blankCreateOrg() }) })).toContain('data-overlay="orgs-create"');
  });
  it("fits a phone: one column, the page padded 16px, an invitation's buttons on their own full-width row", () => {
    expect(rules).toMatch(/@media \(max-width: 640px\) \{ \.cnpy-orgs \{ padding:max\(28px, env\(safe-area-inset-top\)\) 16px/);
    expect(rules).toContain(".cnpy-orgs-inv > div:last-child { width:100%; }");
    expect(rules).toContain(".cnpy-orgs-col { width:100%; max-width:620px; min-width:0; }");
  });
});

describe("create an organization — the Add organization dialog's rules, minus the admin", () => {
  it("a labelled name and address, each with its help; the slug is shown as the link it becomes", () => {
    const html = createOrgModal({ ...blankCreateOrg(), name: "Acme Robotics", slug: "acme-robotics" });
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="orgs-create-t" aria-describedby="orgs-create-d"');
    expect(html).toContain('<label for="orgs-create-name"');
    expect(html).toContain('<label for="orgs-create-slug"');
    expect(html).toContain("/o/acme-robotics/");
    expect(html).toContain("You become its owner");
    expect(html).toMatch(/<button type="button" data-act="orgsCreateSubmit" class="cnpy-accentbtn"[^>]*>Create organization<\/button>/);
    expect(html).not.toContain("Org admin");
  });
  it("validates as the superadmin's dialog does", () => {
    expect(createOrgErrors({ name: "", slug: "" })).toEqual({ name: "Enter the organization's name.", slug: "Enter a slug. It becomes the organization's address." });
    expect(createOrgErrors({ name: "Acme", slug: "A B" }).slug).toContain("lowercase letters, digits or hyphens");
    expect(createOrgErrors({ name: "Acme", slug: "api" }).slug).toBe("“api” is reserved. Pick another slug.");
    expect(createOrgErrors({ name: "Acme", slug: "acme" })).toEqual({});
  });
  it("puts a server refusal beside the field it is about", () => {
    const d = { slug: "acme" };
    expect(createOrgServerError("slug_taken", d, mine())).toEqual({ name: undefined, slug: "“acme” is already in use. Pick another slug.", form: undefined });
    expect(createOrgServerError("reserved_slug", d, mine()).slug).toContain("reserved");
    expect(createOrgServerError("invalid_name", d, mine()).name).toContain("1 to 80 characters");
    expect(createOrgServerError("org_limit", d, mine({ created: 3, limit: 3 })).form).toContain("3 of the 3 organizations");
    expect(createOrgServerError("", d, mine()).form).toContain("wasn't created");
    const html = createOrgModal({ ...blankCreateOrg(), name: "Acme", slug: "acme", errors: { slug: "“acme” is already in use. Pick another slug." } });
    expect(html).toMatch(/id="orgs-create-slug"[^>]*aria-invalid="true" aria-describedby="orgs-create-slug-err"/);
    expect(html).toContain('<div id="orgs-create-slug-err" role="alert"');
  });
  it("while it is creating, every control waits", () => {
    const html = createOrgModal({ ...blankCreateOrg(), name: "Acme", slug: "acme", busy: true });
    expect(html).toContain("Creating…");
    expect(html.match(/<input[^>]* disabled/g)).toHaveLength(2);
    expect(html).toMatch(/data-act="orgsCreateSubmit" disabled aria-busy="true"/);
  });
});

// ── the role comes from the org ──────────────────────────────────────────────
describe("admin = admin or owner of the org on screen", () => {
  it("isOrgAdmin / viewerIsAdmin", () => {
    expect(isOrgAdmin(acme("owner"))).toBe(true);
    expect(isOrgAdmin(acme("admin"))).toBe(true);
    expect(isOrgAdmin(acme("member"))).toBe(false);
    expect(isOrgAdmin(null)).toBe(false);
    expect(findOrg([acme()], "acme")?.name).toBe("Acme Robotics");
    const s = (orgSlug: string | null, orgs: MyOrg[], superadmin = false) => ({ orgSlug, myOrgs: { status: "idle" as const, data: null }, me: me(orgs, { superadmin }) });
    expect(viewerIsAdmin(s("acme", [acme("admin"), sapling("member")]))).toBe(true);
    expect(viewerIsAdmin(s("saplinglearn", [acme("admin"), sapling("member")]))).toBe(false);   // admin elsewhere
    expect(viewerIsAdmin(s("saplinglearn", [sapling("member")], true))).toBe(false);            // a superadmin is not an org admin
    expect(viewerIsAdmin(s(null, [acme("owner")]))).toBe(false);
    expect(viewerOrg(s("saplinglearn", [acme(), sapling()]))?.name).toBe("SaplingLearn");
  });
  it("a role changed since sign-in is read from GET /api/orgs", () => {
    const s = { orgSlug: "acme", me: me([acme("member")]), myOrgs: { status: "ok" as const, data: mine({ orgs: [acme("admin")] }) } };
    expect(viewerIsAdmin(s)).toBe(true);
  });

  const two = (role: OrgRole, over: Partial<AppState> = {}) => app({ me: me([{ ...acme(role) }, sapling("owner")]), ...over });
  it("My Work's Sync GitHub is an admin's", () => {
    expect(render(two("admin", { screen: "mywork" }))).toContain('data-act="adminBackfill"');
    expect(render(two("owner", { screen: "mywork" }))).toContain('data-act="adminBackfill"');
    expect(render(two("member", { screen: "mywork" }))).not.toContain("adminBackfill");   // an OWNER of the other org
  });
  it("Maintenance › People: the directory and the pointer for everyone, the email digest settings for an admin; no member management for anyone", () => {
    const people = (role: OrgRole) => render(two(role, { screen: "maintenance", maintTab: "people", needsTriage: { status: "ok", data: [] }, identityTasks: { status: "ok", data: [] }, persons: { status: "ok", data: [{ handle: "ines", name: "Ines Vidal", color: "fern", avatar_url: null, role: "Designer" }] } }));
    const admin = people("admin"), member = people("member");
    for (const html of [admin, member]) {
      expect(html).toContain("data-people-pointer");
      expect(html).toContain('data-act="orgGo" data-arg="members"');
      expect(html).toContain("· Designer");
      for (const gone of ["inviteSend", "inviteResend", "inviteRevoke", "personEditOpen", "Invite by Google email"]) expect(html, gone).not.toContain(gone);
    }
    expect(admin).toContain('data-act="testSend"');
    expect(member).not.toContain('data-act="testSend"');
  });
  it("Settings › Account says the role held in the org on screen", () => {
    const html = render(two("admin", { screen: "settings" }));
    expect(html).toContain("Admin of Acme Robotics · in 2 organizations");
    expect(render(app({ screen: "settings" }))).toContain("Member of Acme Robotics");
  });
});

// ── members: the ONE place ───────────────────────────────────────────────────
describe("Org settings › Members holds what Maintenance › People used to", () => {
  const members: OrgUi = {
    ...initialOrgUi(), slug: "acme", tab: "members",
    members: { status: "ok", data: [{ handle: "ines", name: "Ines", color: "fern", avatar_url: null, role: "owner", title: null, joined_at: "2026-10-01T10:00:00.000Z" }] },
    invites: { status: "ok", data: [
      { id: 8, github_login: null, email: "sam@acme.dev", role: "member", status: "pending", invited_by: "ines", created_at: "2026-10-05T10:00:00.000Z", responded_at: null, responded_by: null, name: "Sam Okoro", mail_status: "sent", mail_at: "2026-10-05T10:00:01.000Z", mail_error: null },
      { id: 9, github_login: "octocat", email: null, role: "admin", status: "pending", invited_by: "ines", created_at: "2026-10-05T10:00:00.000Z", responded_at: null, responded_by: null, name: null, mail_status: null, mail_at: null, mail_error: null },
      { id: 10, github_login: null, email: "kai@acme.dev", role: "member", status: "pending", invited_by: "ines", created_at: "2026-10-05T10:00:00.000Z", responded_at: null, responded_by: null, name: null, mail_status: "failed", mail_at: "2026-10-05T10:00:01.000Z", mail_error: "resend 403: domain not verified" },
    ] },
  };
  it("an email invite can be mailed again from any org (the org route), whatever the admin's org count; a GitHub one never is", () => {
    const html = membersTab(acme("owner"), members, "ines");
    expect(html).toMatch(/data-act="orgInviteMail" data-arg="8"[^>]*aria-label="Email the invitation to sam@acme.dev again"[^>]*>Resend email<\/button>/);
    expect(html).toContain('data-act="orgInviteMail" data-arg="10"');
    expect(html).not.toContain('data-act="orgInviteMail" data-arg="9"');
    expect(html).toContain('data-act="orgInviteRevoke" data-arg="8"');
    expect(membersTab(acme("owner"), { ...members, mailBusy: 8 }, "ines")).toContain("Sending…");
  });
  it("each pending invite says what became of its email: sent and when, failed and why, or none for a GitHub login", () => {
    const html = membersTab(acme("owner"), members, "ines");
    expect(html).toMatch(/data-invite-mail="sent"[^>]*>Email sent /);
    expect(html).toMatch(/data-invite-mail="failed"[^>]*>Email not sent \(tried [^)]+\): resend 403: domain not verified</);
    expect(html).toMatch(/data-invite-mail="none"[^>]*>No email: they see it when they sign in</);
    expect(html).toContain("Sam Okoro"); // the name the inviter gave
  });
  it("the invite box says the truth for each kind, and takes an optional name for an email invite only", () => {
    const byEmail = membersTab(acme("owner"), { ...members, inviteBy: "email" }, "ines");
    expect(byEmail).toContain("Trov emails them the invitation.");
    expect(byEmail).toContain('data-act="orgInviteName"');
    expect(byEmail).not.toContain("does not email it from here");
    const byLogin = membersTab(acme("owner"), { ...members, inviteBy: "github" }, "ines");
    expect(byLogin).toContain("No email is sent: tell them it is waiting.");
    expect(byLogin).not.toContain('data-act="orgInviteName"');
  });
  it("a member sees neither", () => {
    const html = membersTab(acme("member"), members, "ines");
    expect(html).not.toContain("orgInviteMail");
    expect(html).not.toContain("orgInviteSend");
  });
});

// ── no hardcoded org ─────────────────────────────────────────────────────────
describe("the repository comes from the org", () => {
  it("github.ts holds the org's primary repo; unset (or malformed) it is null", () => {
    expect(repoUrl()).toBeNull();
    setPrimaryRepo("acme/web");
    expect(primaryRepo()).toBe("acme/web");
    expect(repoUrl()).toBe("https://github.com/acme/web");
    setPrimaryRepo("not a repo");
    expect(repoUrl()).toBeNull();
  });
  it("a bare #12 links to that repo — and to nothing when no repository is connected; owner/repo#12 always names its own", () => {
    expect(matchIssueRef("#12 is open", "https://github.com/acme/web")?.href).toBe("https://github.com/acme/web/issues/12");
    expect(matchIssueRef("#12 is open", null)).toBeNull();
    expect(matchIssueRef("acme/api#3", null)?.href).toBe("https://github.com/acme/api/issues/3");
  });

  const repoProps = (over: Partial<RepoProps> = {}): RepoProps => ({
    tab: "overview", range: "7d", driftOpen: null, repo: { status: "ok", data: null }, fetchedAt: null, sample: false, admin: true, poll: null, productEnv: null, persons: [], ...over,
  } as RepoProps);
  it("Repo with no repository connected: one empty state that links to Org settings › Repositories", () => {
    const admin = repoView(repoProps({ noRepo: true }));
    expect(admin).toContain("data-repo-empty");
    expect(admin).toContain("No repository connected");
    expect(admin).toContain("Connect the repository this organization ships from");
    expect(admin).toMatch(/<button type="button" data-act="orgGo" data-arg="repos"[^>]*>Open Org settings &rsaquo; Repositories<\/button>/);
    expect(admin).not.toContain("repo-panel");
    expect(repoView(repoProps({ noRepo: true, admin: false }))).toContain("An admin connects one in Org settings.");
  });
  it("a new handoff defaults to the org's primary repo; with none, the field says so and links to where one is connected", () => {
    expect(blankHandoff("acme/web").repo).toBe("acme/web");
    expect(blankHandoff().repo).toBe("");
    const form = (primaryRepo: string | null) => newHandoffView({ draft: { ...blankHandoff(primaryRepo ?? ""), ctxOpen: true }, me: "ines", persons: [], primaryRepo });
    expect(form("acme/web")).toContain('placeholder="acme/web"');
    expect(form("acme/web")).not.toContain("data-nh-norepo");
    const none = form(null);
    expect(none).toContain('placeholder="owner/repo"');
    expect(none).toContain("No repository is connected to this organization, so type it.");
    expect(none).toContain('data-act="orgGo" data-arg="repos"');
  });

  const artProps = (over: Partial<ArtProps> = {}): ArtProps => ({
    screen: "artifactnew", route: ART_ROUTE_NONE, ui: initialArtUi(), me: "ines", admin: false, persons: [], host: "trov.dev/o/acme", theme: "light", tickets: [], sprints: [], ...over,
  });
  it("a new artifact's Repo list is the org's connected repositories, primary first", () => {
    expect(artifactRepoOptions(["acme/web", "acme/api"], "")).toEqual(["acme/web", "acme/api"]);
    expect(artifactRepoOptions(["acme/web"], "old/one")).toEqual(["acme/web", "old/one"]);
    expect(initialArtCreate().repo).toBe("");
    expect(initialArtCreate("acme/web").repo).toBe("acme/web");
    const ui = initialArtUi();
    ui.c = initialArtCreate("acme/web");
    const html = artifactsView(artProps({ ui, repos: ["acme/web", "acme/api"], orgName: "Acme Robotics" }));
    expect(html).toContain('<option value="acme/web" selected>acme/web</option>');
    expect(html).toContain('<option value="acme/api">acme/api</option>');
    expect(html).toContain("Everyone in Acme Robotics can open it once it's uploaded.");
    expect(html).toContain("trov.dev/o/acme/#artifacts/");
  });
  it("with no repository connected the Repo field is an empty state that links to Org settings › Repositories", () => {
    const html = artifactsView(artProps({ repos: [] }));
    expect(html).toContain("data-art-norepo");
    expect(html).toContain("No repository is connected to this organization.");
    expect(html).toContain('data-act="orgGo" data-arg="repos"');
    expect(html).not.toContain('data-act="artCRepo"');
  });
});

describe("no copy names one organization", () => {
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("no `Sapling` in the SPA's code or copy (What's new is history, and keeps its own)", () => {
    for (const [path, src] of Object.entries(sources)) {
      const name = path.split("/").pop()!;
      if (name === "releases.ts") continue;
      const hits = code(src).split("\n").filter((l) => /sapling/i.test(l));
      // The one survivor is a FIELD NAME of the poll result (shared/repo.ts `UsagePollResult.sapling`), labelled "App metrics".
      if (name === "repo.ts") { expect(hits).toHaveLength(1); expect(hits[0]).toContain('["sapling", "App metrics"]'); }
      else expect(hits, name).toEqual([]);
    }
  });
  it("no hardcoded repository constant is left", () => {
    for (const [path, src] of Object.entries(sources)) {
      for (const gone of ["REPO_URL", "ARTIFACT_REPOS", "DEFAULT_TICKET_REPO", "canopy.saplinglearn.com", "admin_handle_not_allowlisted", "ADMIN_LOGINS"]) {
        if (path.endsWith("releases.ts")) continue;
        expect(code(src), `${path}: ${gone}`).not.toContain(gone);
      }
    }
  });
  it("the sign-in copy states the new rules: any GitHub account; Google by invitation", () => {
    const landing = render({ ...initialState(), view: "auth", authStep: "login", signInOpen: true });
    expect(landing).toContain("Any GitHub account can sign in. A Google account needs an invitation from an organization's admin first.");
    expect(landing).not.toContain("previewNonMember");
    const google = render({ ...initialState(), view: "auth", authStep: "notinvited", deniedEmail: "sam@x.io" });
    expect(google).toContain("This Google account hasn&#39;t been invited yet.".replace("&#39;", "'"));
    expect(google).toContain("Signing in with Google needs an invitation.");
    expect(google).toContain("A GitHub account can always sign in, and can create an organization.");
    expect(google).toContain('data-act="signIn"');
    const github = render({ ...initialState(), view: "auth", authStep: "nonmember" });
    expect(github).toContain("That GitHub account couldn't sign in.");
    expect(github).toContain("hello@trov.dev");
    expect(github).not.toContain("octo-stranger");
    expect(render({ ...initialState(), view: "auth", authStep: "verifying" })).toContain("Signing you in");
  });
  it("the Get Started guide names Org settings › Members and the switcher", () => {
    const html = render(app({ screen: "guide" }));
    expect(html).toContain("Any GitHub account can.");
    expect(html).toContain("Org settings › Members");
    expect(html).toContain("The switcher at the top of the sidebar");
    expect(html).toContain("You signed in and see no organization.");
  });
});

// ── Settings › MCP access ────────────────────────────────────────────────────
describe("Settings › MCP access — a connection is for one organization", () => {
  const grant = (id: number, org: { slug: string; name: string }) => ({ id, client_name: "Claude Code", created_at: "2026-10-01T10:00:00.000Z", last_used_at: null, org });
  it("says so in the steps, naming the org on screen", () => {
    const html = mcpAccessSection({ grants: { status: "ok", data: [] }, grantRevokeArm: null, grantsAll: false }, "Acme Robotics");
    expect(html).toContain("it acts as you, in one organization.");
    expect(html).toContain("Pick the organization to connect (you&#39;re in <strong".replace("&#39;", "'"));
    expect(html).toContain("Acme Robotics");
    expect(html).toContain("A connection reaches one organization: the one you pick when you allow it.");
    expect([...html.matchAll(/<li /g)]).toHaveLength(3);
  });
  it("each connected app shows the org it is connected to", () => {
    const html = grantListBody({ grants: { status: "ok", data: [grant(1, { slug: "acme", name: "Acme Robotics" }), grant(2, { slug: "saplinglearn", name: "SaplingLearn" })] }, grantRevokeArm: null, orgSlug: "acme" });
    expect(html).toContain('data-grant-org="acme" title="This connection reaches Acme Robotics only"');
    expect(html).toContain('data-grant-org="saplinglearn"');
    expect(html).toContain(">SaplingLearn</span>");
  });
  it("access tokens are the CURRENT org's and say so; revoke only — and nothing at all when there are none", () => {
    const tokens = { status: "ok" as const, data: [{ id: 4, hint: "ab12", created_at: "2026-09-01T10:00:00.000Z", last_used_at: null }] };
    const html = tokenListBody({ mcpTokens: tokens, tokenRevokeArm: null }, "Acme Robotics");
    expect(html).toContain("Access tokens for Acme Robotics");
    expect(html).toContain("ab12&hellip;");
    expect(html).toMatch(/data-act="revokeTokenArm" data-arg="4"[^>]*aria-label="Revoke the token starting ab12"/);
    expect(html).toContain("A token reaches this organization only.");
    expect(html).not.toMatch(/data-act="(mintToken|newToken|createToken)"/);
    const armed = tokenListBody({ mcpTokens: tokens, tokenRevokeArm: 4 }, "Acme Robotics");
    expect(armed).toContain('data-act="revokeToken" data-arg="4"');
    expect(armed).toContain("Whatever uses this token stops working at once.");
    expect(tokenListBody({ mcpTokens: { status: "ok", data: [] }, tokenRevokeArm: null }, "Acme")).toBe("");
  });
});

// ── the neutral confirm ──────────────────────────────────────────────────────
describe("the confirmation modal has a neutral tone", () => {
  const base = { id: "c", title: "T?", body: "B.", confirmAct: "go", cancelAct: "no" };
  it("destructive by default (red); neutral is the accent button — same dialog, same keyboard hooks", () => {
    const danger = confirmModal(base), neutral = confirmModal({ ...base, tone: "neutral" });
    expect(danger).toContain('data-confirm-tone="danger"');
    expect(danger).toMatch(/class="cnpy-confirm-go"[^>]*background:var\(--red\)/);
    expect(neutral).toContain('data-confirm-tone="neutral"');
    expect(neutral).toMatch(/class="cnpy-confirm-go cnpy-confirm-go--neutral"[^>]*background:var\(--accent\);color:var\(--accent-fg\)/);
    expect(neutral).not.toContain("var(--red)");
    for (const html of [danger, neutral]) {
      expect(html).toContain('role="alertdialog"');
      expect(html).toContain("data-confirm-focus");
      expect(html).toContain('data-confirm-act="go"');
    }
    expect(rules).toContain(".cnpy-confirm-go--neutral:focus-visible { outline-color:");
  });
  it("Unsuspend uses it; Suspend stays red", () => {
    const detail = { status: "ok" as const, data: { org: { slug: "acme", name: "Acme", status: "suspended", member_count: 2 }, members: [], invites: [], usage: {} } as never };
    const dialog = (arm: "suspend" | "unsuspend") => platformDialogs({ ...initialPlat(), superadmin: true, orgSlug: "acme", detail, suspendArm: arm }, "platformorg");
    expect(dialog("unsuspend")).toContain('data-confirm-tone="neutral"');
    expect(dialog("unsuspend")).not.toContain("background:var(--red)");
    expect(dialog("suspend")).toContain('data-confirm-tone="danger"');
  });
});
