import { describe, it, expect, vi } from "vitest";

// DOMPurify needs a DOM the worker pool doesn't have; a profile's session titles are inline markdown.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import { peopleSection, personRoleEditor } from "../web/src/maintenance";
import { profileSection, accountSection, tokenListBody, initialState, render, isUploadedAvatar } from "../web/src/render";
import { peopleFromPersons } from "../web/src/triage-map";
import { handleTag, personChip, markAvatarFailed, AVATAR_IMG_CLASS } from "../web/src/people";
import { peopleDirectoryView, peopleMatching, personProfileView } from "../web/src/profile";
import { avatarCrop, avatarTypeProblem, avatarSizeProblem } from "../web/src/avatar";
import { ROLE_MAX, RESPONSIBILITIES_MAX, AVATAR_TYPES, AVATAR_MAX_BYTES, type PersonProfile } from "@shared/people";
import type { Me } from "../web/src/api";

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "https://a/p.png", role: null },
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

// ── person profiles (0036) ───────────────────────────────────────────────────

const ME = (over: Partial<Me> = {}): Me => ({ handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], org: "SaplingLearn", admin: false, role: null, ...over });
const SECRET = "Owns the ingest gate and every migration";
const profile = (over: Partial<PersonProfile> = {}): PersonProfile => ({
  handle: "priya", name: "Priya Natarajan", color: "plum", avatar_url: "/avatar/abc", role: "Backend engineer",
  github: "priya-n", joined: "2026-06-03T10:00:00Z", admin: false, editable: false, self: false,
  tickets: [{ id: 12, title: "Fix the gate", status: "in_progress", priority: "high", updated_at: "2026-09-26T10:00:00Z" }],
  ticketsOpen: 1,
  sessions: [{ id: 4, summary: "Shipped the **gate** fix", brief: null, created_at: "2026-09-26T10:00:00Z" }],
  docs: [{ slug: "ingest-gate", title: "The ingest gate", updated_at: "2026-09-20T10:00:00Z" }],
  ...over,
});
const view = (pr: PersonProfile) => personProfileView({ status: "ok", handle: pr.handle, profile: pr });

describe("personChip — photos", () => {
  it("lays the photo over the initials, so a slow or failed photo shows the initials", () => {
    const html = personChip({ handle: "priya", name: "Priya Natarajan", color: "plum", avatar_url: "/avatar/abc" }, 28, "priya");
    expect(html).toContain(">PN<img");
    expect(html).toContain(`class="${AVATAR_IMG_CLASS}" src="/avatar/abc"`);
    expect(html).toContain("position:absolute;inset:0");
  });

  it("a photo that failed to load is left out for the session (the chip is initials only)", () => {
    const url = "https://avatars.example/gone.png";
    markAvatarFailed(url);
    const html = personChip({ handle: "sam", name: "Samir Mehta", color: "sky", avatar_url: url }, 20, "sam");
    expect(html).toContain(">SM</div>");
    expect(html).not.toContain("<img");
  });
});

describe("People directory", () => {
  const dir = [
    { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: "Founder" },
    { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "/avatar/abc", role: "Backend engineer" },
    { handle: "meilin", name: "Mei Lin", color: "rose" as const, avatar_url: null, role: null },
  ];

  it("a card per person — avatar, name, role, handle — each opening the profile, mine marked YOU", () => {
    const html = peopleDirectoryView({ status: "ok", persons: dir, q: "", me: "andresl230" });
    for (const p of dir) expect(html).toContain(`data-act="openPerson" data-arg="${p.handle}"`);
    expect(html).toContain("Backend engineer");
    expect(html).toContain("No role yet");
    expect(html).toContain('src="/avatar/abc"');
    expect(html.match(/>YOU</g)?.length).toBe(1);
    expect(html).toContain('data-act="peopleQ" data-field="peopleQ"');
  });

  it("searches name, handle and role — every word, any case", () => {
    expect(peopleMatching(dir, "backend").map((p) => p.handle)).toEqual(["priya"]);
    expect(peopleMatching(dir, "MEI").map((p) => p.handle)).toEqual(["meilin"]);
    expect(peopleMatching(dir, "andres founder").map((p) => p.handle)).toEqual(["AndresL230"]);
    expect(peopleMatching(dir, "  ").length).toBe(3);
    expect(peopleDirectoryView({ status: "ok", persons: dir, q: "nobody", me: "" })).toContain("Nobody matches");
  });

  it("loading and failed reads say so; hostile fields are escaped", () => {
    expect(peopleDirectoryView({ status: "loading", persons: [], q: "", me: "" })).toContain("Loading people");
    expect(peopleDirectoryView({ status: "error", persons: [], q: "", me: "" })).toContain("Couldn't load the team");
    const bad = peopleDirectoryView({ status: "ok", persons: [{ ...dir[2], role: "<b>x</b>" }], q: "", me: "" });
    expect(bad).not.toContain("<b>x</b>");
  });
});

describe("Profile screen", () => {
  it("heads with the large avatar, name, handle, role, joined date and a GitHub link, then tickets, sessions and docs", () => {
    const html = view(profile({ admin: true }));
    expect(html).toContain('width="88" height="88"');
    expect(html).toContain("Priya Natarajan");
    expect(html).toContain("@priya");
    expect(html).toContain("Backend engineer");
    expect(html).toContain("ADMIN");
    expect(html).toContain("Joined Jun 2026");
    expect(html).toContain('href="https://github.com/priya-n"');
    expect(html).toContain('data-act="openTicket" data-arg="12"');
    expect(html).toContain("IN PROGRESS");
    expect(html).toContain('data-act="personFeed" data-arg="priya"');
    expect(html).toContain('data-act="openDocFrom" data-arg="ingest-gate"');
    expect(html).toContain("cnpy-profile-grid");
  });

  it("no Admin badge or GitHub link when there is none; empty lists say so", () => {
    const html = view(profile({ github: null, tickets: [], ticketsOpen: 0, sessions: [], docs: [] }));
    expect(html).not.toContain("ADMIN");
    expect(html).not.toContain("github.com");
    expect(html).toContain("Nothing assigned to Priya right now.");
    expect(html).toContain("No sessions recorded yet.");
    expect(html).toContain("No docs yet.");
  });

  it("NEVER renders responsibilities on a plain view — not even for an admin or for self", () => {
    for (const over of [{}, { editable: true }, { editable: true, self: true }] as Partial<PersonProfile>[]) {
      const html = view(profile({ ...over, responsibilities: SECRET }));
      expect(html, JSON.stringify(over)).not.toContain(SECRET);
    }
  });

  it("self gets Edit profile (→ Settings); nobody gets a role editor on a profile — admins set it in Maintenance", () => {
    expect(view(profile({ self: true }))).toContain('data-act="goSettings"');
    for (const over of [{}, { editable: true }, { editable: true, self: true }] as Partial<PersonProfile>[]) {
      const html = view(profile(over));
      expect(html, JSON.stringify(over)).not.toContain('data-act="personEditOpen"');
      expect(html, JSON.stringify(over)).not.toContain('data-act="personRoleDraft"');
    }
    expect(view(profile({ editable: true }))).not.toContain('data-act="goSettings"');
  });

  it("loading, unknown handle and failed read", () => {
    expect(personProfileView({ status: "loading", handle: "priya", profile: null })).toContain("Loading profile");
    const missing = personProfileView({ status: "ok", handle: "ghost", profile: null });
    expect(missing).toContain("nobody called @ghost");
    expect(missing).toContain('data-act="goPeople"');
    expect(personProfileView({ status: "error", handle: "priya", profile: null })).toContain("Couldn't load this profile");
  });

  it("the app shell: People lit in the sidebar, the crumb names the person, the title goes back to the directory", () => {
    const s = initialState();
    s.view = "app"; s.me = ME(); s.screen = "person"; s.personHandle = "priya";
    s.personProfile = { status: "ok", data: profile() };
    const html = render(s);
    expect(html).toContain('class="cnpy-navrow n-people is-active"');
    expect(html).toContain('data-act="goPeople"');
    expect(html).toContain(">Priya Natarajan</span>");
    // A different person's profile still in state never shows under a new handle.
    s.personHandle = "meilin";
    expect(render(s)).not.toContain("Backend engineer");
  });
});

describe("Settings › Profile — the photo; no role or responsibilities", () => {
  const settings = (over: Partial<ReturnType<typeof initialState>> = {}) => {
    const s = initialState();
    s.me = ME({ role: "Founder" });
    s.displayName = "Andres";
    Object.assign(s, over);
    return s;
  };

  it("offers Upload photo (the four types) and Remove photo only over an uploaded one", () => {
    const html = profileSection(settings());
    expect(html).toContain('data-act="avatarPick"');
    expect(html).toContain(`accept="${AVATAR_TYPES.join(",")}"`);
    expect(html).toContain("data-avatar-file");
    expect(html).not.toContain('data-act="avatarRemove"'); // no photo
    const s = settings();
    s.me = ME({ avatar_url: "https://avatars.githubusercontent.com/u/1" });
    expect(profileSection(s)).not.toContain('data-act="avatarRemove"'); // the provider's picture
    s.me = ME({ avatar_url: "/avatar/abc" });
    expect(profileSection(s)).toContain('data-act="avatarRemove"');
    s.avatarBusy = "upload";
    expect(profileSection(s)).toContain("Uploading…");
    expect(profileSection(s)).toMatch(/data-act="avatarPick"[^>]*disabled/);
  });

  it("has no Role or Responsibilities field — both are admin-set in Maintenance › People", () => {
    const html = profileSection(settings());
    expect(html).not.toContain('data-field="roleDraft"');
    expect(html).not.toContain('data-field="respDraft"');
    expect(html).not.toContain("Responsibilities");
    expect(html).not.toContain('data-act="saveAbout"');
  });

  it("isUploadedAvatar: only a Canopy-stored photo", () => {
    expect(isUploadedAvatar("/avatar/abc")).toBe(true);
    expect(isUploadedAvatar("https://x/y.png")).toBe(false);
    expect(isUploadedAvatar(null)).toBe(false);
  });
});

describe("avatar prep (web/src/avatar.ts)", () => {
  it("centre-crops to a square no wider than 512px", () => {
    expect(avatarCrop(1200, 800)).toEqual({ sx: 200, sy: 0, side: 800, out: 512 });
    expect(avatarCrop(300, 500)).toEqual({ sx: 0, sy: 100, side: 300, out: 300 });
    expect(avatarCrop(512, 512)).toEqual({ sx: 0, sy: 0, side: 512, out: 512 });
  });
  it("refuses a type the Worker refuses, and a photo still over the cap", () => {
    for (const t of AVATAR_TYPES) expect(avatarTypeProblem(t)).toBeNull();
    expect(avatarTypeProblem("image/svg+xml")).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(avatarSizeProblem(AVATAR_MAX_BYTES)).toBeNull();
    expect(avatarSizeProblem(AVATAR_MAX_BYTES + 1)).toMatch(/over 2 MB/);
  });
});

describe("Maintenance › People — role and the admin's Edit role", () => {
  const dir = [
    { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: "Founder" },
    { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null, role: null },
  ];
  it("each row opens the profile and shows the role; only an admin gets Edit role", () => {
    const admin = peopleSection({ persons: dir, invites: [], inviteDraft: "", loading: false, error: null, me: "AndresL230" });
    expect(admin).toContain('data-act="openPerson" data-arg="priya"');
    expect(admin).toContain("· Founder");
    expect(admin).toContain('data-act="personEditOpen" data-arg="priya"');
    const member = peopleSection({ persons: dir, invites: [], inviteDraft: "", loading: false, error: null, canInvite: false });
    expect(member).toContain('data-act="openPerson" data-arg="priya"');
    expect(member).not.toContain('data-act="personEditOpen"');
  });

  it("an admin's open editor sits under that row — the one place role and responsibilities are edited", () => {
    const base = { persons: dir, invites: [], inviteDraft: "", loading: false, error: null, me: "AndresL230" };
    const open = peopleSection({ ...base, edit: { handle: "PRIYA", draft: { role: "Backend", responsibilities: SECRET }, saving: false } });
    expect(open).toContain(SECRET);
    expect(open).toContain('data-act="personRoleDraft"');
    expect(open).toContain(`maxlength="${ROLE_MAX}"`);
    expect(open).toContain(`maxlength="${RESPONSIBILITIES_MAX}"`);
    expect(open).toContain("agents read it when deciding whom to assign work");
    expect(open).toContain('data-act="personEditCancel" data-arg="priya"');   // the row's button now closes it
    expect(open.indexOf(SECRET)).toBeGreaterThan(open.indexOf('data-arg="priya"'));
    // Loading, saving, and a non-admin never sees it whatever state says.
    expect(personRoleEditor("Priya", null, false)).toContain("Loading Priya");
    expect(personRoleEditor("Priya", { role: "", responsibilities: "" }, true)).toContain("Saving…");
    expect(peopleSection({ ...base, canInvite: false, edit: { handle: "priya", draft: { role: "", responsibilities: SECRET }, saving: false } })).not.toContain(SECRET);
  });
});
