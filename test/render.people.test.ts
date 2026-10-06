import { describe, it, expect, vi } from "vitest";

// DOMPurify needs a DOM the worker pool doesn't have; a profile's session titles are inline markdown.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import { peopleSection } from "../web/src/maintenance";
import { orgPeopleLink } from "../web/src/org-settings";
import { profileSection, accountSection, initialState, render, isUploadedAvatar } from "../web/src/render";
import { peopleFromPersons } from "../web/src/triage-map";
import { handleTag, personChip, markAvatarFailed, AVATAR_IMG_CLASS } from "../web/src/people";
import { personCardModal, joinedLabel } from "../web/src/profile";
import { avatarCrop, avatarTypeProblem, avatarSizeProblem } from "../web/src/avatar";
import { AVATAR_TYPES, AVATAR_MAX_BYTES, type PersonProfile } from "@shared/people";
import type { Me } from "../web/src/api";

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "https://a/p.png", role: null },
];
describe("peopleSection — the directory", () => {
  it("lists everyone in the org with colored chips; the viewer's row carries YOU", () => {
    const html = peopleSection({ persons, loading: false, me: "AndresL230" });
    expect(html).toContain("YOU");
    expect(html).toContain("@AndresL230");
    expect(html).toContain("var(--p-plum)");
    expect(html).toContain('data-act="openPerson" data-arg="priya"');
  });
  it("holds NO member management: no invite box, no Resend / Revoke, no Edit role — for anyone", () => {
    const html = peopleSection({ persons, loading: false, me: "AndresL230" });
    for (const gone of ["inviteSend", "inviteDraft", "inviteResend", "inviteRevoke", "personEditOpen", "Edit role", "Invite by"]) expect(html, gone).not.toContain(gone);
  });
  it("the pointer where those controls were sends an admin, and a member, to Org settings › Members", () => {
    for (const admin of [true, false]) {
      const html = orgPeopleLink(admin);
      expect(html).toContain('data-act="orgGo" data-arg="members"');
      expect(html).toContain("Open Org settings › Members");
    }
    expect(orgPeopleLink(true)).toContain("Inviting people, their roles and titles, and removing a member are in Org settings now.");
    expect(orgPeopleLink(false)).toContain("managed by this organization's admins");
  });
  it("the directory list is one surface card with hairline rows inside", () => {
    const html = peopleSection({ persons, loading: false });
    expect(html.match(/cnpy-surface/g)?.length).toBe(1);
    expect(html).toMatch(/class="cnpy-surface" style="overflow:hidden">/);
    expect(html).not.toContain("border-radius:12px");
    expect(html).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
  });
  it("says so while the directory loads", () => {
    expect(peopleSection({ persons: [], loading: true })).toContain("Loading people…");
  });
});

describe("peopleFromPersons", () => {
  it("maps directory rows to picker entries keyed by handle", () => {
    expect(peopleFromPersons(persons)[1]).toEqual({ id: "priya", name: "Priya Natarajan", initials: "PN", color: "plum", avatar_url: "https://a/p.png" });
  });
});

// ── person profiles (0036) ───────────────────────────────────────────────────

const ME = (over: Partial<Me> = {}): Me => ({ handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0, ...over });
const SECRET = "Owns the ingest gate and every migration";
const profile = (over: Partial<PersonProfile> = {}): PersonProfile => ({
  handle: "priya", name: "Priya Natarajan", color: "plum", avatar_url: "/avatar/abc", role: "Backend engineer",
  github: "priya-n", joined: "2026-06-03T10:00:00Z", admin: false, editable: false, self: false,
  ...over,
});
const PRIYA = { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: "/avatar/abc", role: "Backend engineer" };
const card = (detail: PersonProfile | null, self = false) => personCardModal({ person: PRIYA, detail, self });

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

describe("the person card (a click on a name — there is no People screen)", () => {
  it("paints at once from the directory: large avatar, name, handle, role — in the confirm modal's shell", () => {
    const html = card(null);
    expect(html).toContain('data-overlay="person-card"');
    expect(html).toContain('class="cnpy-cmodal"');
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="person-card-t"');
    expect(html).toContain('src="/avatar/abc"');
    expect(html).toContain("width:64px");
    expect(html).toContain(">Priya Natarajan</div>");
    // Structured: labelled property rows, each "—" until the detail lands (so the card keeps its height).
    for (const label of ["ROLE", "JOINED", "GITHUB"]) expect(html).toContain(`>${label}</div>`);
    expect(html).toContain("@priya");
    expect(html).toContain("Backend engineer");
    // The backdrop and × close it; nothing else is on it before the detail read lands.
    expect(html.match(/data-act="personCardClose"/g)?.length).toBe(2);
    expect(html).not.toContain("Jun 2026");
    expect(html).not.toContain("github.com");
  });

  it("the detail read adds joined, GitHub and the admin badge — for the same person only", () => {
    const html = card(profile({ admin: true }));
    expect(html).toContain(joinedLabel("2026-06-03T10:00:00Z").replace("Joined ", ""));
    expect(html).toContain('href="https://github.com/priya-n"');
    expect(html).toContain("ADMIN");
    // A stale detail for someone else never decorates this card.
    expect(card(profile({ handle: "meilin", admin: true }))).not.toContain("ADMIN");
  });

  it("NEVER renders responsibilities, and has no tickets, sessions, docs or role editor", () => {
    const html = card(profile({ editable: true, responsibilities: SECRET }));
    expect(html).not.toContain(SECRET);
    for (const act of ["openTicket", "openDocFrom", "personFeed", "personEditOpen", "personRoleDraft"]) expect(html).not.toContain(`data-act="${act}"`);
  });

  it("self gets a way to Settings (photo, name); anyone else does not", () => {
    expect(card(null, true)).toContain('data-act="goSettings"');
    expect(card(null, false)).not.toContain('data-act="goSettings"');
  });

  it("no role reads 'No role yet'; hostile fields are escaped", () => {
    const html = personCardModal({ person: { ...PRIYA, name: "<b>x</b>", role: null }, detail: null, self: false });
    expect(html).toContain("No role yet");
    expect(html).not.toContain("<b>x</b>");
  });

  it("the app renders it at the root over any screen, from the directory, and the sidebar has no People item", () => {
    const s = initialState();
    s.view = "app"; s.me = ME(); s.screen = "tickets";
    s.persons = { status: "ok", data: [PRIYA] };
    expect(render(s)).not.toContain('data-overlay="person-card"');
    expect(render(s)).not.toContain("goPeople");
    s.personCard = "PRIYA";
    const html = render(s);
    expect(html).toContain('data-overlay="person-card"');
    expect(html).toContain("Backend engineer");
    // Before the directory loads, the detail alone paints it; with neither, the handle.
    s.persons = { status: "loading", data: [] };
    s.personDetail = { status: "ok", data: profile() };
    expect(render(s)).toContain("Priya Natarajan");
    s.personDetail = { status: "loading", data: null };
    expect(render(s)).toContain("@PRIYA");
  });
});

describe("Settings › Profile — the photo; no role or responsibilities", () => {
  const settings = (over: Partial<ReturnType<typeof initialState>> = {}) => {
    const s = initialState();
    s.me = ME();
    s.displayName = "Andres";
    Object.assign(s, over);
    return s;
  };

  it("has no photo row: the avatar is the control — a button with a hover veil that opens the photo menu", () => {
    const html = profileSection(settings());
    // The old row (two buttons + the types line) is gone.
    expect(html).not.toContain("Cropped to a square");
    expect(html).not.toContain("cnpy-outlinebtn");
    // The avatar is a menu button, closed, with the camera veil the hover/focus rule shows.
    expect(html).toMatch(/<button data-act="avatarMenu" class="cnpy-avbtn"[^>]*aria-haspopup="menu" aria-expanded="false"/);
    expect(html).toContain('aria-label="Profile photo options"');
    expect(html).toMatch(/<button data-act="avatarMenu"[\s\S]*?class="cnpy-av"[\s\S]*?class="cnpy-avbtn-veil"[\s\S]*?<\/button>/);
    expect(html).toContain("cnpy-avbtn-badge"); // the touch-screen hint
    // The hidden input the menu's Upload row clicks: the four types.
    expect(html).toContain(`accept="${AVATAR_TYPES.join(",")}"`);
    expect(html).toContain("data-avatar-file");
    // Closed: no menu, no rows.
    expect(html).not.toContain("data-avatar-menu");
    expect(html).not.toContain('data-act="avatarPick"');
  });

  it("the open menu: Upload photo, Remove only over an UPLOADED avatar (then Change photo), and the types footnote", () => {
    const s = settings({ avatarMenu: true });
    let html = profileSection(s); // no photo: the initials
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-act="avatarMenuClose"'); // the click-outside backdrop
    expect(html).toMatch(/role="menu"[^>]*data-avatar-menu/);
    expect(html).toMatch(/role="menuitem" data-act="avatarPick"[^>]*>[\s\S]*?Upload photo<\/button>/);
    expect(html).not.toContain('data-act="avatarRemove"');
    expect(html).toContain("Square crop · PNG, JPEG, WebP, GIF");
    s.me = ME({ avatar_url: "https://avatars.githubusercontent.com/u/1" });
    html = profileSection(s); // the provider's picture is not Trov's to remove
    expect(html).toContain("Upload photo");
    expect(html).not.toContain('data-act="avatarRemove"');
    s.me = ME({ avatar_url: "/avatar/abc" });
    html = profileSection(s);
    expect(html).toContain("Change photo");
    expect(html).not.toContain("Upload photo");
    expect(html).toMatch(/role="menuitem" data-act="avatarRemove"[^>]*>[\s\S]*?Remove photo<\/button>/);
  });

  it("busy: the avatar spins, says what it is doing, and the menu can't open", () => {
    const s = settings({ avatarMenu: true, avatarBusy: "upload" });
    let html = profileSection(s);
    expect(html).toContain("cnpy-avbtn is-busy");
    expect(html).toMatch(/data-act="avatarMenu"[^>]*aria-disabled="true" aria-busy="true"/);
    expect(html).toContain('aria-label="Uploading photo…"');
    expect(html).toMatch(/class="cnpy-avbtn-veil"[^>]*><svg[^>]*animation:cnpy-spin/);
    expect(html).not.toContain("data-avatar-menu"); // even with the menu flag still set
    expect(html).toContain('aria-expanded="false"');
    s.avatarBusy = "remove";
    html = profileSection(s);
    expect(html).toContain('aria-label="Removing photo…"');
    expect(html).not.toContain("data-avatar-menu");
  });

  it("has no Role or Responsibilities field — both are admin-set in Maintenance › People", () => {
    const html = profileSection(settings());
    expect(html).not.toContain('data-field="roleDraft"');
    expect(html).not.toContain('data-field="respDraft"');
    expect(html).not.toContain("Responsibilities");
    expect(html).not.toContain('data-act="saveAbout"');
  });

  it("isUploadedAvatar: only a Trov-stored photo", () => {
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

describe("Maintenance › People — the directory shows each person's title", () => {
  const dir = [
    { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: "Founder" },
    { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null, role: null },
  ];
  it("each row opens the person card and shows the title; titles are edited in Org settings › Members, never here", () => {
    const html = peopleSection({ persons: dir, loading: false, me: "AndresL230" });
    expect(html).toContain('data-act="openPerson" data-arg="priya"');
    expect(html).toContain("· Founder");
    expect(html).not.toContain("personEdit");
    expect(html).not.toContain("cnpy-roleedit");
  });
});
