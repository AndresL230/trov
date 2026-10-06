import { describe, it, expect, vi } from "vitest";

// DOMPurify needs a DOM the worker pool doesn't have; a profile's session titles are inline markdown.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import { peopleSection, personRoleEditor, personEditChanged, type PersonEditView } from "../web/src/maintenance";
import { profileSection, accountSection, initialState, render, isUploadedAvatar } from "../web/src/render";
import { peopleFromPersons } from "../web/src/triage-map";
import { handleTag, personChip, markAvatarFailed, AVATAR_IMG_CLASS } from "../web/src/people";
import { personCardModal, joinedLabel } from "../web/src/profile";
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
    s.me = ME({ role: "Founder" });
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

describe("Maintenance › People — role and the admin's Edit role", () => {
  const dir = [
    { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: "Founder" },
    { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null, role: null },
  ];
  it("each row opens the person card and shows the role; only an admin gets Edit role", () => {
    const admin = peopleSection({ persons: dir, invites: [], inviteDraft: "", loading: false, error: null, me: "AndresL230" });
    expect(admin).toContain('data-act="openPerson" data-arg="priya"');
    expect(admin).toContain("· Founder");
    expect(admin).toContain('data-act="personEditOpen" data-arg="priya"');
    const member = peopleSection({ persons: dir, invites: [], inviteDraft: "", loading: false, error: null, canInvite: false });
    expect(member).toContain('data-act="openPerson" data-arg="priya"');
    expect(member).not.toContain('data-act="personEditOpen"');
  });

  const loaded = { role: "Backend", responsibilities: SECRET };
  const view = (over: Partial<PersonEditView> = {}): PersonEditView => ({ handle: "priya", draft: loaded, base: loaded, saving: false, ...over });
  const section = { persons: dir, invites: [], inviteDraft: "", loading: false, error: null, me: "AndresL230" };

  it("an admin's open editor sits under that row — the one place role and responsibilities are edited", () => {
    const open = peopleSection({ ...section, edit: view({ handle: "PRIYA" }) });
    expect(open).toContain(SECRET);
    expect(open).toContain('data-act="personRoleDraft"');
    expect(open).toContain(`maxlength="${ROLE_MAX}"`);
    expect(open).toContain(`maxlength="${RESPONSIBILITIES_MAX}"`);
    expect(open).toContain("Never shown in the app");
    expect(open).toContain("agents read it when deciding whom to assign work");
    expect(open).toContain('data-act="personEditCancel" data-arg="priya"');   // the row's button now closes it
    expect(open).toContain('aria-expanded="true"');
    expect(open.indexOf(SECRET)).toBeGreaterThan(open.indexOf('data-arg="priya"'));
    // The row and its editor are one block: the row is marked, and the editor follows it.
    expect(open).toMatch(/class="cnpy-prow" data-roleedit="in"[\s\S]*data-arg="priya"[\s\S]*class="cnpy-roleedit" data-roleedit="in"/);
    // Only Priya's row is open; Andres's keeps a plain row and a closed button.
    expect(open.match(/data-roleedit="in"/g)).toHaveLength(2);
    expect(open).toContain('data-act="personEditOpen" data-arg="AndresL230"');
    // Labelled fields, the helper tied to the textarea, and the counter.
    expect(open).toContain('<label for="person-role"');
    expect(open).toContain('<label for="person-resp"');
    expect(open).toContain('aria-describedby="person-resp-help"');
    expect(open).toContain(`${SECRET.length} / ${RESPONSIBILITIES_MAX}`);
    // The Edit role button keeps focus across rerenders (data-field) — close returns focus to it.
    expect(open).toContain('data-field="personEditBtn:priya"');
    // A non-admin never sees it, whatever state says.
    expect(peopleSection({ ...section, canInvite: false, edit: view() })).not.toContain(SECRET);
    expect(peopleSection({ ...section, canInvite: false, editOut: view() })).not.toContain(SECRET);
  });

  it("Save waits for a change (compared trimmed) and reads Saving… while the write runs", () => {
    const save = (html: string) => html.match(/<button data-act="personEditSave"[^>]*>[^<]*<\/button>/)?.[0] ?? "";
    expect(personEditChanged(loaded, loaded)).toBe(false);
    expect(personEditChanged({ ...loaded, role: "  Backend " }, loaded)).toBe(false);
    expect(personEditChanged({ ...loaded, role: "Frontend" }, loaded)).toBe(true);
    expect(personEditChanged(null, loaded)).toBe(false);
    expect(save(personRoleEditor("Priya", view()))).toContain(" disabled");
    const changed = save(personRoleEditor("Priya", view({ draft: { ...loaded, responsibilities: "Owns billing" } })));
    expect(changed).not.toContain("disabled");
    expect(changed).toContain("cnpy-accentbtn");
    const saving = save(personRoleEditor("Priya", view({ draft: { ...loaded, role: "x" }, saving: true })));
    expect(saving).toContain("disabled");
    expect(saving).toContain("Saving…");
  });

  it("loading is the same form, disabled and shimmering — nothing moves when the draft lands", () => {
    const loading = personRoleEditor("Priya", view({ draft: null, base: null }));
    const ready = personRoleEditor("Priya", view());
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading…");
    expect(loading).toContain("cnpy-roleedit-skel");
    expect(loading).not.toContain(SECRET);
    expect(loading.match(/<input[^>]*disabled/)).not.toBeNull();
    expect(loading.match(/<textarea[^>]*disabled/)).not.toBeNull();
    // Same controls with the same fixed heights in both states.
    const heights = (h: string) => Array.from(h.matchAll(/<(input|textarea)[^>]*height:(\d+)px/g)).map((m) => `${m[1]}:${m[2]}`);
    expect(heights(loading)).toEqual(heights(ready));
    expect(heights(ready)).toEqual(["input:36", "textarea:128"]);
    expect(ready).not.toContain("cnpy-roleedit-skel");
    expect(ready).not.toContain("aria-busy");
  });

  it("a closing editor is an inert picture under its row: no ids, acts or fields for the new one to collide with", () => {
    const both = peopleSection({ ...section, edit: view({ handle: "AndresL230", draft: null, base: null }), editOut: view() });
    const at = both.indexOf('class="cnpy-roleedit" data-roleedit="out" inert');
    expect(at).toBeGreaterThan(-1);
    const out = both.slice(at);
    expect(both).toMatch(/class="cnpy-prow" data-roleedit="out"/);
    // Exactly ONE live Role box, and it is the opening editor's.
    expect(both.match(/data-field="personRole"/g)).toHaveLength(1);
    expect(both.match(/id="person-role"/g)).toHaveLength(1);
    const ghost = out.slice(0, out.indexOf("</textarea>"));
    expect(ghost).not.toContain("data-field=");
    expect(ghost).not.toContain("data-act=");
    // Priya's row button is closed again while her editor collapses.
    expect(both).toContain('data-act="personEditOpen" data-arg="priya"');
  });
});
