import { describe, it, expect } from "vitest";
import { peopleSection } from "../web/src/maintenance";
import { profileSection, accountSection, tokenListBody, initialState } from "../web/src/render";
import { peopleFromPersons } from "../web/src/triage-map";
import { handleTag } from "../web/src/people";

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "https://a/p.png" },
];
const invites = [
  { email: "m.okafor@gmail.com", name: null, invited_by: "AndresL230", invited_at: "2026-09-12T10:00:00Z", accepted_by: null, revoked_at: null, email_sent_at: "2026-09-12T10:00:01Z", email_id: null, email_error: null },
  { email: "done@x.io", name: "Done", invited_by: "AndresL230", invited_at: "2026-09-01T10:00:00Z", accepted_by: "done", revoked_at: null, email_sent_at: "t", email_id: null, email_error: null },
  { email: "bad@x.io", name: null, invited_by: "AndresL230", invited_at: "2026-09-11T10:00:00Z", accepted_by: null, revoked_at: null, email_sent_at: "t", email_id: null, email_error: "resend 500" },
];

describe("peopleSection", () => {
  it("lists persons with colored chips and pending invites with Resend/Revoke; accepted invites are not pending", () => {
    const html = peopleSection({ persons, invites, inviteDraft: "", loading: false, error: null, me: "AndresL230" });
    expect(html).toContain("YOU");
    expect(html).toContain("@AndresL230");
    expect(html).toContain("var(--p-plum)");
    expect(html).toContain("m.okafor@gmail.com");
    expect(html).toContain('data-act="inviteResend" data-arg="m.okafor@gmail.com"');
    expect(html).toContain('data-act="inviteRevoke" data-arg="m.okafor@gmail.com"');
    expect(html).not.toContain('data-arg="done@x.io"');
    expect(html).toContain("resend 500");
    expect(html).toContain('data-act="inviteDraft"');
    expect(html).toContain('data-act="inviteSend"');
  });
  it("without invite rights it is the directory alone", () => {
    const html = peopleSection({ persons, invites, inviteDraft: "", loading: false, error: null, canInvite: false });
    expect(html).toContain("@AndresL230");
    expect(html).not.toContain('data-act="inviteSend"');
    expect(html).not.toContain("m.okafor@gmail.com");
  });
  it("disables Invite until the draft looks like an email", () => {
    expect(peopleSection({ persons, invites: [], inviteDraft: "nope", loading: false, error: null })).toMatch(/data-act="inviteSend"[^>]*disabled/);
    expect(peopleSection({ persons, invites: [], inviteDraft: "a@b.co", loading: false, error: null })).not.toMatch(/data-act="inviteSend"[^>]*disabled/);
  });
  it("the directory list is one surface card with hairline rows inside", () => {
    const html = peopleSection({ persons, invites, inviteDraft: "", loading: false, error: null });
    expect(html.match(/cnpy-surface/g)?.length).toBe(1);
    expect(html).toMatch(/class="cnpy-surface" style="overflow:hidden">/);
    expect(html).not.toContain("border-radius:12px");
    expect(html).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
  });
});

describe("profileSection", () => {
  it("shows handle read-only and ten swatches with mine selected; sign-in methods live in Account, not here", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false };
    s.displayName = "Andres";
    const html = profileSection(s);
    expect(html).toContain("@AndresL230");
    expect(html).toContain('data-arg="moss" class="cnpy-sw is-on compact"');
    expect(html).not.toContain("linkProvider");
  });

  it("handle editor: shows the draft input + warning with an enabled Save when available, disabled when taken", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false };
    s.handleEdit = true;
    s.handleDraft = "andres";
    s.handleCheck = "available";
    const available = profileSection(s);
    expect(available).toContain('data-act="handleDraft"');
    expect(available).toContain('value="andres"');
    expect(available).toContain("Every entry you've written is re-attributed to the new handle. Links to the old one stop working.");
    expect(available).not.toMatch(/data-act="handleSave"[^>]*disabled/);

    s.handleCheck = "taken";
    const taken = profileSection(s);
    expect(taken).toMatch(/data-act="handleSave"[^>]*disabled/);
  });
});

describe("accountSection", () => {
  it("membership + Sign out, and link/unlink per provider with the last identity locked", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false };
    const html = accountSection(s);
    expect(html).toContain("Member of <b>SaplingLearn</b>");
    expect(html).toContain('data-act="signOut"');
    expect(html).toContain('data-act="linkProvider" data-arg="google"');
    expect(html).toMatch(/data-act="unlinkProvider" data-arg="github"[^>]*disabled/); // last identity
    s.me.identities.push({ provider: "google", label: "a@b.c", linked_at: "t" });
    const both = accountSection(s);
    expect(both).not.toMatch(/data-act="unlinkProvider" data-arg="github"[^>]*disabled/);
    expect(both).toContain('data-act="unlinkProvider" data-arg="google"');
  });

  it("a Google-only person reads 'Signed in with Google'", () => {
    const s = initialState();
    s.me = { handle: "meilin", name: "Mei Lin", avatar_url: null, color: "plum", identities: [{ provider: "google", label: "m@x.io", linked_at: "t" }], org: "SaplingLearn", admin: false };
    expect(accountSection(s)).toContain("Signed in with Google");
  });
});

describe("tokenListBody", () => {
  const tk = (id: number, hint: string | null, last: string | null = null) => ({ id, hint, created_at: "2026-09-01T00:00:00.000Z", last_used_at: last });

  it("lists each token by its hint with a Revoke that must be armed first", () => {
    const html = tokenListBody({ tokens: { status: "ok", data: [tk(7, "ab12", "2026-09-02T00:00:00.000Z"), tk(8, null)] }, tokenRevokeArm: null });
    expect(html).toContain("canopy_mcp_ab12");
    expect(html).toContain("last used");
    expect(html).toContain("never used");
    expect(html).toContain('data-act="revokeTokenArm" data-arg="7"');
    expect(html).not.toContain('data-act="revokeToken"');
  });

  it("an armed row swaps in the real Revoke + Keep and says what revoking does; other rows stay unarmed", () => {
    const html = tokenListBody({ tokens: { status: "ok", data: [tk(7, "ab12"), tk(8, "cd34")] }, tokenRevokeArm: 7 });
    expect(html).toContain('data-act="revokeToken" data-arg="7"');
    expect(html).toContain('data-act="revokeTokenCancel"');
    expect(html).toContain("Any agent using it stops working.");
    expect(html).toContain('data-act="revokeTokenArm" data-arg="8"');
  });

  it("loading, empty and error states; a hostile hint is escaped", () => {
    expect(tokenListBody({ tokens: { status: "loading", data: [] }, tokenRevokeArm: null })).toContain("Loading tokens");
    expect(tokenListBody({ tokens: { status: "ok", data: [] }, tokenRevokeArm: null })).toContain("No tokens yet");
    expect(tokenListBody({ tokens: { status: "error", data: [], error: "boom" }, tokenRevokeArm: null })).toContain("boom");
    expect(tokenListBody({ tokens: { status: "ok", data: [tk(1, "<b>x")] }, tokenRevokeArm: null })).not.toContain("<b>x");
  });

  it("every state renders inside the one fixed-height scroller, so the tile never changes height", () => {
    const states = [
      tokenListBody({ tokens: { status: "loading", data: [] }, tokenRevokeArm: null }),
      tokenListBody({ tokens: { status: "ok", data: [] }, tokenRevokeArm: null }),
      tokenListBody({ tokens: { status: "error", data: [], error: "boom" }, tokenRevokeArm: null }),
      tokenListBody({ tokens: { status: "ok", data: [tk(1, "ab12"), tk(2, "cd34"), tk(3, "ef56")] }, tokenRevokeArm: null }),
    ];
    for (const html of states) expect(html).toMatch(/^<div class="cnpy-scroll cnpy-set-tokens">[\s\S]*<\/div>$/);
  });
});

describe("handleTag", () => {
  it("renders the handle in the person's color when mapped", () => {
    const html = handleTag({ handle: "priya", color: "plum" }, "priya");
    expect(html).toContain("var(--p-plum)");
    expect(html).toContain("@priya");
  });

  it("falls back to a muted, uncolored tag when unmapped", () => {
    const html = handleTag(null, "mystery-dev");
    expect(html).toContain("@mystery-dev");
    expect(html).not.toContain("var(--p-");
  });
});

describe("peopleFromPersons", () => {
  it("maps directory rows to picker entries keyed by handle", () => {
    expect(peopleFromPersons(persons)[1]).toEqual({ id: "priya", name: "Priya Natarajan", initials: "PN", color: "plum", avatar_url: "https://a/p.png" });
  });
});
