/**
 * The deletion screens (web/src/deletion.ts): Settings › Delete account, Org settings › General › Delete
 * organization (owners only), Platform's two — each confirmed in THE confirmation modal with the handle or
 * slug typed, saying what goes, what stays and why, and a guard rail shown as the reason, never as blame.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import { render, initialState, type AppState } from "../web/src/render";
import { accountDeleteModal, accountDeleteTile, initialDeleteUi, orgDeleteModal, orgDeleteTile, personDeleteSection, type DeleteUi } from "../web/src/deletion";
import { confirmKeyAction, confirmModal, typedMatches } from "../web/src/confirm";
import { orgSettingsView, orgOverlays, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import { initialPlat, platformDialogs, adminsTab } from "../web/src/platform";
import { deletionFailure, DELETED_SENTENCE } from "../web/src/deletion-actions";
import { OrgApiError } from "../web/src/api";
import type { AccountDeletionPreview, OrgDeletionPreview } from "@shared/deletion-core";
import type { MyOrg, OrgRole } from "@shared/orgs";

const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "owner" as const }], superadmin: false, pending_invites: 0 };
const preview = (o: Partial<AccountDeletionPreview> = {}): AccountDeletionPreview => ({
  handle: "alice", leaves: [{ slug: "acme", name: "Acme", role: "member" }], deletes: [], unused_paid: 0, blockers: [], confirm: "alice", ...o,
});
const ui = <P>(data: P | null, o: Partial<DeleteUi<P>> = {}): DeleteUi<P> => ({ ...initialDeleteUi<P>(), preview: { status: data ? "ok" : "idle", data }, ...o });
const orgPreview = (o: Partial<OrgDeletionPreview> = {}): OrgDeletionPreview => ({
  org: { slug: "acme", name: "Acme" }, members: 4, pending_invites: 2, repositories: 1, subscription: null, billing_ready: true, confirm: "acme", ...o,
});
const goBtn = (html: string) => html.match(/<button type="button" data-act="(acctDelGo|orgDelGo|platOrgDelGo|platPersonDelGo)"[^>]*>/)?.[0] ?? "";
const noNesting = (html: string) => {
  // Never a button inside a button, never a native <select>.
  expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  expect(html).not.toContain("<select");
};

describe("the confirmation modal's typed field (confirm.ts)", () => {
  it("is labelled, takes the focus, and keeps Delete disabled until it matches — case and spaces aside", () => {
    const at = (value: string) => confirmModal({ id: "x", title: "Delete?", body: "Gone.", confirmAct: "go", cancelAct: "no", typed: { label: "Type acme to confirm", expected: "acme", value, act: "typed" } });
    const empty = at("");
    expect(empty).toContain('<label for="x-typed"');
    expect(empty).toMatch(/<input id="x-typed" data-act="typed" data-field="typed" data-confirm-focus/);
    expect(empty).toMatch(/data-act="go" class="cnpy-confirm-go" disabled/); // the button gives up data-confirm-focus to the field
    expect(at("acm")).toMatch(/data-act="go" class="cnpy-confirm-go" disabled/);
    expect(at("  ACME ")).toMatch(/data-act="go" class="cnpy-confirm-go" style=/);
    expect(typedMatches({ expected: "acme", value: " Acme" })).toBe(true);
    expect(typedMatches({ expected: "acme", value: "acme!" })).toBe(false);
    // Enter in the field confirms (the reducer re-checks the match); Tab is trapped (main.ts includes the field).
    expect(confirmKeyAction("Enter", { onDialogButton: false, busy: false, repeat: false })).toBe("confirm");
    expect(confirmKeyAction("Escape", { onDialogButton: false, busy: false, repeat: false })).toBe("cancel");
  });

  it("without the new props it is byte-for-byte the old dialog", () => {
    const html = confirmModal({ id: "p", title: "Delete it?", body: "It goes.", confirmAct: "go", cancelAct: "no" });
    expect(html).toContain('data-act="go" data-confirm-focus class="cnpy-confirm-go" style=');
    expect(html).not.toContain("cnpy-cm-typed");
    expect(html).not.toContain("cnpy-cmodal-box--wide");
  });

  it("the field's focus ring shows, the wide box scrolls rather than run off a phone", () => {
    expect(css).toMatch(/\.cnpy-cm-typed \.cnpy-input:focus-visible \{[^}]*box-shadow:0 0 0 3px var\(--accent-soft\)/);
    expect(css).toMatch(/\.cnpy-cmodal-box--wide \{[^}]*max-height:calc\(100dvh - 32px\); overflow:auto;/);
  });
});

describe("Settings › Delete account", () => {
  it("a tile of its own, after Help and before Session (Sign out stays last), with the quiet destructive trigger", () => {
    const html = render({ ...initialState(), view: "app", screen: "settings", me: ME, acctDelete: ui(preview()) } as AppState);
    const del = html.indexOf("cnpy-set-delete"), help = html.indexOf("cnpy-set-help"), session = html.indexOf("cnpy-set-session");
    expect(help).toBeLessThan(del);
    expect(del).toBeLessThan(session);
    expect(html).toMatch(/data-act="acctDelArm" data-confirm-trigger class="cnpy-dangerbtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="acct-delete-confirm"/);
    expect(html).toContain("credited to “Deleted user”");
    expect(css).toMatch(/\.cnpy-set-delete \{ grid-column:1 \/ -1; \}/);
    noNesting(accountDeleteTile(ui(preview())));
  });

  it("a guard rail is the reason the button is not there yet: the sentences, each naming its organization, and a disabled button that points at them", () => {
    const blocked = preview({ blockers: [{ code: "last_owner", org: { slug: "acme", name: "Acme" }, message: "You're the only owner of Acme, and 3 other people are in it. Make one of them an owner in Org settings › Members, or delete the organization first." }] });
    const tile = accountDeleteTile(ui(blocked));
    expect(tile).toContain("Before you can delete your account:");
    expect(tile).toContain("You&#39;re the only owner of Acme");
    expect(tile).toMatch(/<button type="button" disabled aria-describedby="acct-delete-blockers"/);
    expect(tile).not.toContain('data-act="acctDelArm"');
    // …and nothing in it blames: no "you must", no "you can't".
    expect(tile.toLowerCase()).not.toMatch(/you must|you can't|not allowed/);
  });

  it("the confirmation: what is deleted, what is kept and why, the orgs that go with it, the handle typed", () => {
    const p = preview({ deletes: [{ slug: "solo", name: "Solo", paid: true }], unused_paid: 1 });
    const html = accountDeleteModal(ui(p, { open: true, typed: "ali" }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Delete your account?");
    expect(html).toContain("<strong>Deleted:</strong> Your sign-ins (GitHub and Google)");
    expect(html).toContain("<strong>Kept:</strong> What you wrote in organizations that carry on");
    expect(html).toContain("<strong>Also deleted:</strong> <strong>Solo</strong>, which nobody else is in");
    expect(html).toContain("cancelled at Stripe right away");
    expect(html).toContain("<strong>Cancelled:</strong> a Pro plan paid for but never set up");
    expect(html).toContain("Type your handle, alice, to confirm");
    expect(goBtn(html)).toContain("disabled");
    expect(goBtn(accountDeleteModal(ui(p, { open: true, typed: "alice" })))).not.toContain("disabled");
    expect(accountDeleteModal(ui(p, { open: true, typed: "alice", busy: true }))).toContain("Deleting…");
    expect(accountDeleteModal(ui(p, { open: true, error: "Trov couldn't reach Stripe." }))).toMatch(/role="alert"[^>]*>Trov couldn&#39;t reach Stripe\./);
    expect(accountDeleteModal(ui(p, { open: false }))).toBe("");
    noNesting(html);
  });

  it("is rendered at the app root, over Settings, only while open", () => {
    const at = (open: boolean) => render({ ...initialState(), view: "app", screen: "settings", me: ME, acctDelete: ui(preview(), { open }) } as AppState);
    expect(at(false)).not.toContain('data-overlay="confirm-acct-delete-confirm"');
    const open = at(true);
    expect(open.indexOf('data-overlay="confirm-acct-delete-confirm"')).toBeGreaterThan(open.lastIndexOf("</main>"));
  });
});

describe("Org settings › General › Delete organization", () => {
  const org = (role: OrgRole): MyOrg => ({ slug: "acme", name: "Acme", role });
  const orgUi = (o: Partial<OrgUi> = {}): OrgUi => ({
    ...initialOrgUi(), tab: "general", slug: "acme",
    settings: { status: "ok", data: { org: { slug: "acme", name: "Acme", created_at: "2026-10-01T00:00:00Z", created_by: "alice", logo: { url: null, source: null, by: null, from: null, at: null } }, can_edit: true } },
    ...o,
  });
  const view = (role: OrgRole, o: Partial<OrgUi> = {}) => orgSettingsView({ org: org(role), ui: orgUi(o), orgsStatus: "ok", me: "alice" });

  it("an owner sees it — a quiet text action, as every destructive act in Org settings — an admin and a member do not", () => {
    const owner = view("owner");
    expect(owner).toContain("cnpy-org-gen-delete");
    expect(owner).toMatch(/data-confirm-trigger aria-expanded="false" aria-controls="org-delete-confirm"[^>]*data-act="orgDelArm"/);
    expect(owner).not.toContain("cnpy-dangerbtn");
    for (const role of ["admin", "member"] as const) expect(view(role)).not.toContain("Delete organization");
    expect(css).toMatch(/\.cnpy-org-gen-delete \{ grid-column:1 \/ -1; \}/);
    noNesting(orgDeleteTile({ name: "Acme" }, initialDeleteUi()));
  });

  it("the confirmation: everything for everyone, the counts, the billing policy when it pays, what is kept, the slug typed", () => {
    const html = orgDeleteModal(ui(orgPreview({ subscription: { period_end: "2026-11-01T00:00:00Z", cancel_at_period_end: false } }), { open: true }));
    expect(html).toContain("Delete Acme?");
    expect(html).toContain("<strong>Deleted:</strong> Everything in it, for everyone");
    expect(html).toContain("4 members lose access; 2 pending invitations are withdrawn; 1 repository is disconnected.");
    expect(html).toContain("<strong>Billing:</strong> Its Pro subscription is cancelled at Stripe right away. The time already paid for is not refunded");
    expect(html).toContain("<strong>Kept:</strong> Members keep their Trov accounts");
    expect(html).toContain("Type its slug, acme, to confirm");
    expect(goBtn(html)).toContain("disabled");
    // Nothing paid: no billing line.
    expect(orgDeleteModal(ui(orgPreview(), { open: true }))).not.toContain("<strong>Billing:</strong>");
    // A live subscription Stripe isn't set up to cancel: said, and the button stays off whatever is typed.
    const stuck = orgDeleteModal(ui(orgPreview({ billing_ready: false, subscription: { period_end: null, cancel_at_period_end: false } }), { open: true, typed: "acme" }));
    expect(stuck).toContain("Stripe isn&#39;t set up here to cancel it");
    expect(goBtn(stuck)).toContain("disabled");
  });

  it("is an Org settings overlay for its owner only", () => {
    const props = (role: OrgRole) => ({ org: org(role), ui: orgUi({ del: ui(orgPreview(), { open: true }) }), orgsStatus: "ok" as const, me: "alice" });
    expect(orgOverlays(props("owner"))).toContain('data-overlay="confirm-org-delete-confirm"');
    expect(orgOverlays(props("admin"))).not.toContain("org-delete-confirm");
  });
});

describe("Platform", () => {
  it("Admins › Accounts: a labelled handle field, Check, and — once checked — the guard rails or the delete action", () => {
    const p = { ...initialPlat(), superadmin: true, admins: { status: "ok" as const, data: [] } };
    const empty = adminsTab(p, "root");
    expect(empty).toContain('<label for="plat-person-delete"');
    expect(empty).toMatch(/data-act="platPersonCheck" class="cnpy-outlinebtn" disabled/);
    const ok = personDeleteSection("alice", ui(preview()), "platPersonDraft");
    expect(ok).toMatch(/data-confirm-trigger aria-expanded="false" aria-controls="plat-person-delete-confirm"[^>]*data-act="platPersonDelArm"/);
    const blocked = personDeleteSection("alice", ui(preview({ blockers: [{ code: "superadmin", org: null, message: "@alice is a superadmin." }] })), "platPersonDraft");
    expect(blocked).toContain("@alice's account can't be deleted yet:");
    expect(blocked).toContain("<li>@alice is a superadmin.</li>");
    expect(blocked).not.toContain("platPersonDelArm");
    noNesting(ok);
  });

  it("the person's confirmation speaks of THEM; the org's says the superadmin is not a member", () => {
    const person = platformDialogs({ ...initialPlat(), superadmin: true, personDelete: ui(preview(), { open: true }) }, "platform");
    expect(person).toContain("Delete @alice&#39;s account?");
    expect(person).toContain("Their sign-ins");
    expect(person).toContain("Type their handle, alice, to confirm");
    expect(person).toContain('data-act="platPersonDelGo"');
    const detail = { org: { slug: "acme", name: "Acme" } } as unknown as NonNullable<ReturnType<typeof initialPlat>["detail"]["data"]>;
    const org = platformDialogs({ ...initialPlat(), superadmin: true, orgSlug: "acme", detail: { status: "ok", data: detail }, orgDelete: ui(orgPreview(), { open: true }) }, "platformorg");
    expect(org).toContain("you are not one of its members");
    expect(org).toContain('data-act="platOrgDelGo"');
  });
});

describe("after, and when it is refused", () => {
  it("the landing says it happened; a refusal keeps the server's sentence", () => {
    expect(DELETED_SENTENCE.account).toBe("Your account has been deleted, and you are signed out.");
    expect(DELETED_SENTENCE.org).toMatch(/members keep their Trov accounts/);
    expect(deletionFailure(new OrgApiError(502, "billing_failed", "Trov couldn't reach Stripe to cancel the subscription, so nothing was deleted.", null))).toMatch(/nothing was deleted/);
    expect(deletionFailure(new Error("network"))).toMatch(/nothing was deleted/);
  });
});
