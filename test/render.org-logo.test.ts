/**
 * The organization's image in the SPA (web/src/org-logo.ts) — pure render tests: props in, markup out.
 *   • the tile: the initial alone, the image over it, the initial again once the image failed to load;
 *   • everywhere an org's name is: the switcher, its menu, the picker, an invitation, Platform's list;
 *   • Org settings › General: the control an admin gets (and its menu per state), what a member
 *     sees instead, where the image came from, and the refusals as sentences.
 */
import { describe, it, expect } from "vitest";
import { orgTile, orgLogoSection, orgLogoSource, initialOrgLogoUi, ORG_LOGO_ACCEPTS, ORG_LOGO_RULE, type OrgLogoUi } from "../web/src/org-logo";
import { orgLogoErrorText } from "../web/src/org-logo-actions";
import { orgSwitcherButton, orgMenu, orgPickerView, initialOrgsUi, orgTile as pickerTile } from "../web/src/org-picker";
import { generalTab, initialOrgUi, type OrgUi } from "../web/src/org-settings";
import { orgsTab } from "../web/src/platform";
import { markAvatarFailed, AVATAR_IMG_CLASS } from "../web/src/people";
import { ApiError, OrgApiError } from "../web/src/api";
import type { MyInvite, MyOrg, MyOrgsResponse, OrgLogo, OrgRole, PlatformOrgRow } from "@shared/orgs";

const SHA = "a".repeat(64);
const URL_A = `/org-logo/${SHA}`;
const imgs = (html: string): string[] => html.match(/<img\b[^>]*>/g) ?? [];
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const acme = (role: OrgRole = "owner", logo_url: string | null = URL_A): MyOrg => ({ slug: "acme", name: "Acme Robotics", role, logo_url });
const plain = (): MyOrg => ({ slug: "birch", name: "Birch Labs", role: "member", logo_url: null });
const invite = (logo_url: string | null): MyInvite => ({
  id: 7, org: { slug: "globex", name: "Globex", logo_url }, role: "admin", invited_by: "hank", created_at: "2026-10-05T09:00:00.000Z", github_login: "ines-vidal", email: null,
});
const mine = (o: Partial<MyOrgsResponse> = {}): MyOrgsResponse => ({ orgs: [acme(), plain()], invites: [], superadmin: false, can_create: false, created: 0, limit: 0, ...o });

describe("orgTile", () => {
  it("with no image is the square initial, as before — decorative, no <img>", () => {
    const html = orgTile("acme robotics", 24);
    expect(html).toContain('class="cnpy-orgtile"');
    expect(html).toContain('aria-hidden="true"');
    expect(text(html)).toBe("A");
    expect(imgs(html)).toEqual([]);
    expect(html).toContain("width:24px;height:24px");
    expect(html).toContain("border-radius:7px");
    expect(text(orgTile("  ", 24))).toBe("?");
    expect(pickerTile).toBe(orgTile); // org-picker.ts still exports it
  });

  it("with an image lays it over the initial: same square, same radius, empty alt, from the app's own route", () => {
    const html = orgTile("Acme", 32, URL_A);
    const [img] = imgs(html);
    expect(img).toContain(`src="${URL_A}"`);
    expect(img).toContain('alt=""');
    expect(img).toContain(`class="${AVATAR_IMG_CLASS}"`); // main.ts's one `error` listener watches this class
    expect(img).toContain('width="32" height="32"');
    expect(img).toContain("object-fit:cover");
    expect(text(html)).toBe("A"); // the initial is still under it
    expect(html).toContain("width:32px;height:32px");
    expect(html).toContain("border-radius:7px");
    expect(html).toContain("overflow:hidden");
    expect(html).not.toMatch(/githubusercontent|https?:\/\//);
  });

  it("once the image failed to load, it is the initial again — on every later render", () => {
    const broken = `/org-logo/${"b".repeat(64)}`;
    expect(imgs(orgTile("Acme", 24, broken))).toHaveLength(1);
    markAvatarFailed(broken);
    expect(imgs(orgTile("Acme", 24, broken))).toEqual([]);
    expect(text(orgTile("Acme", 24, broken))).toBe("A");
    expect(imgs(orgTile("Acme", 24, URL_A))).toHaveLength(1); // another org's image is unaffected
  });

  it("escapes the name and the URL", () => {
    const html = orgTile('<b>"x', 24, '/org-logo/x" onerror="alert(1)');
    expect(html).not.toContain("<b>");
    expect(html).not.toContain('" onerror="');
  });
});

describe("the image is wherever the org's name is", () => {
  it("the sidebar's switcher button", () => {
    const html = orgSwitcherButton({ org: acme(), open: false, invites: 0, collapsed: false });
    expect(imgs(html).map((i) => /src="([^"]+)"/.exec(i)?.[1])).toEqual([URL_A]);
    expect(imgs(orgSwitcherButton({ org: plain(), open: false, invites: 0, collapsed: false }))).toEqual([]);
    // Collapsed, the rail keeps the tile — and so the image.
    expect(imgs(orgSwitcherButton({ org: acme(), open: false, invites: 0, collapsed: true }))).toHaveLength(1);
  });

  it("the switcher's menu: each org's own, and an invitation's", () => {
    const html = orgMenu({ orgs: mine({ invites: [invite(`/org-logo/${"c".repeat(64)}`)] }), mine: [], current: "acme", status: "ok", ui: { ...initialOrgsUi(), menu: true } });
    expect(imgs(html).map((i) => /src="([^"]+)"/.exec(i)?.[1])).toEqual([URL_A, `/org-logo/${"c".repeat(64)}`]);
    expect(html).toContain("Birch Labs"); // listed, with its initial
  });

  it("the org picker: my orgs and my invitations — an invitee sees the inviting org's image", () => {
    const html = orgPickerView({ me: { handle: "ines", name: "Ines", identities: [] }, mine: [], orgs: mine({ orgs: [], invites: [invite(URL_A)] }), status: "ok", ui: initialOrgsUi(), hash: "" });
    expect(html).toContain("Globex");
    expect(imgs(html).map((i) => /src="([^"]+)"/.exec(i)?.[1])).toEqual([URL_A]);
    const both = orgPickerView({ me: null, mine: [], orgs: mine(), status: "ok", ui: initialOrgsUi(), hash: "" });
    expect(imgs(both)).toHaveLength(1); // Acme's; Birch Labs has none
  });

  it("Platform's organization list", () => {
    const row = (o: Partial<PlatformOrgRow>): PlatformOrgRow => ({
      slug: "acme", name: "Acme", status: "active", created_at: "2026-09-01T10:00:00.000Z", created_by: "andres", suspended_at: null, suspended_by: null,
      owners: [], member_count: 1, pending_invites: 0, last_activity_at: null, ...o,
    });
    const html = orgsTab({ orgs: { status: "ok", data: [row({ logo_url: URL_A }), row({ slug: "birch", name: "Birch" })] } });
    expect(imgs(html).map((i) => /src="([^"]+)"/.exec(i)?.[1])).toEqual([URL_A]);
    expect((html.match(/class="cnpy-orgtile"/g) ?? [])).toHaveLength(2);
  });
});

// ── Org settings › General ───────────────────────────────────────────────────

const NONE: OrgLogo = { url: null, source: null, by: null, from: null, at: null };
const UPLOADED: OrgLogo = { url: URL_A, source: "upload", by: "olive", from: null, at: "2026-10-05T10:00:00.000Z" };
const IMPORTED: OrgLogo = { url: URL_A, source: "github", by: null, from: "acme-co", at: "2026-10-05T10:00:00.000Z" };
const section = (logo: OrgLogo | undefined, canEdit: boolean, ui: Partial<OrgLogoUi> = {}, repo: string | null = "acme-co/widgets") =>
  orgLogoSection({ name: "Acme Robotics", logo, canEdit, ui: { ...initialOrgLogoUi(), ...ui }, repo });

describe("General › the image control (admin)", () => {
  it("the tile is the control: a labelled button that opens a menu, over a hidden file input for the accepted types", () => {
    const html = section(UPLOADED, true);
    const button = /<button[^>]*data-act="orgLogoMenu"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('aria-label="Organization image options"');
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('class="cnpy-avbtn"'); // the photo control's own class: veil, focus ring, touch badge
    expect(html).toContain("cnpy-avbtn-veil");
    expect(html).toContain("cnpy-avbtn-badge");
    const input = /<input[^>]*data-orglogo-file[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(input).toContain("hidden");
    expect(input).not.toContain("svg");
    expect(imgs(html)).toHaveLength(1);
    expect(html).not.toContain('role="menu"'); // closed until asked
  });

  it("the menu over an UPLOADED image: Change image, Remove image, the accepted types and size", () => {
    const html = section(UPLOADED, true, { menu: true });
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Organization image"');
    expect(html).toContain('aria-expanded="true"');
    const items = (html.match(/<button[^>]*role="menuitem"[^>]*>[\s\S]*?<\/button>/g) ?? []).map(text);
    expect(items).toEqual(["Change image", "Remove image"]);
    expect(text(html)).toContain(ORG_LOGO_ACCEPTS);
    expect(ORG_LOGO_ACCEPTS).toBe("Square crop · PNG, JPEG, WebP, GIF · up to 2 MB");
    expect(html).toContain("data-avatar-menu"); // main.ts's ↑ / ↓ handler serves it
  });

  it("over an imported image, or none, the menu only uploads — there is no upload to remove", () => {
    for (const logo of [IMPORTED, NONE]) {
      const items = (section(logo, true, { menu: true }).match(/<button[^>]*role="menuitem"[^>]*>[\s\S]*?<\/button>/g) ?? []).map(text);
      expect(items).toEqual(["Upload image"]);
    }
  });

  it("while a write is in flight the tile says so, shows a spinner and will not open the menu", () => {
    const up = section(UPLOADED, true, { busy: "upload", menu: true });
    expect(up).toContain('aria-label="Uploading image…"');
    expect(up).toContain('aria-disabled="true" aria-busy="true"');
    expect(up).toContain("cnpy-avbtn is-busy");
    expect(up).toContain("cnpy-spin");
    expect(up).not.toContain('role="menu"');
    expect(section(UPLOADED, true, { busy: "remove" })).toContain('aria-label="Removing image…"');
  });

  it("a refusal is an alert beside the control", () => {
    const html = section(NONE, true, { error: "That image is too large." });
    expect(/<div role="alert"[^>]*>([^<]+)</.exec(html)?.[1]).toBe("That image is too large.");
    expect(section(NONE, true)).not.toContain('role="alert"');
  });
});

describe("General › where the image came from", () => {
  it("an upload names who uploaded it, and says GitHub's never replaces it", () => {
    const t = text(section(UPLOADED, true));
    expect(t).toMatch(/Uploaded by @olive .*\. An uploaded image is never replaced by GitHub's\./);
  });

  it("an import names the GitHub owner and the repository it owns, and how to replace it", () => {
    const t = text(section(IMPORTED, true));
    expect(t).toMatch(/Imported from GitHub .*: the avatar of acme-co , the owner of acme-co\/widgets \. Upload an image to replace it\. An uploaded image is never replaced by GitHub's\./);
    // The repository is named only when the page knows it and it is that owner's.
    expect(orgLogoSource(IMPORTED, null)).not.toContain("the owner of");
    expect(orgLogoSource(IMPORTED, "someone-else/site")).not.toContain("the owner of");
    expect(orgLogoSource(IMPORTED, "ACME-CO/widgets")).toContain("the owner of");
  });

  it("no image: the initial stands in, and an admin is told both ways to get one", () => {
    const t = text(section(NONE, true));
    expect(t).toContain("No image yet. The first letter of the name stands in for it. Upload one, or connect a repository and Trov imports its owner's GitHub avatar.");
    expect(t).toContain(ORG_LOGO_RULE);
    expect(text(section(undefined, true))).toContain("No image yet."); // a settings answer from before 0042_organizations
  });

  it("escapes a handle and a login", () => {
    expect(orgLogoSource({ ...UPLOADED, by: "<i>x" }, null)).not.toContain("<i>");
    expect(orgLogoSource({ ...IMPORTED, from: "<i>x" }, null)).not.toContain("<i>");
  });
});

describe("General › a member who is not an admin", () => {
  it("sees the image and its source — no button, no file input, no menu, no upload hint, whatever the UI state", () => {
    const html = section(UPLOADED, false, { menu: true, busy: "upload", error: "x" });
    expect(imgs(html)).toHaveLength(1);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("orgLogo");
    expect(html).toContain('aria-label="Image of Acme Robotics"');
    expect(text(html)).toMatch(/^A Image Uploaded by @olive [^.]*\.$/); // the initial under the image, the label, the source — nothing else
    expect(text(section(NONE, false))).toBe("A Image No image yet. The first letter of the name stands in for it.");
    expect(section(NONE, false)).toContain('aria-label="Acme Robotics has no image"');
  });

  it("the General tab carries the control for an admin and the plain image for a member", () => {
    const ui = (can_edit: boolean, logo: OrgLogo): OrgUi => ({
      ...initialOrgUi(), slug: "acme", tab: "general",
      settings: { status: "ok", data: { org: { slug: "acme", name: "Acme Robotics", created_at: "2026-10-01T10:00:00.000Z", created_by: "andres", logo }, can_edit } },
      repos: { status: "ok", data: [] },
    });
    const admin = generalTab(acme("admin"), ui(true, IMPORTED));
    expect(admin).toContain('data-act="orgLogoMenu"');
    expect(admin.indexOf("data-org-logo")).toBeLessThan(admin.indexOf('id="org-name"')); // the image comes first, then the name
    expect(text(admin)).toContain("Imported from GitHub");
    const member = generalTab(acme("member"), ui(false, IMPORTED));
    expect(member).not.toContain("orgLogoMenu");
    expect(member).toContain("data-org-logo");
    expect(imgs(member)).toHaveLength(1);
  });
});

describe("a refused upload or removal, in words", () => {
  const limited = () => { const e = new OrgApiError(429, "rate_limited", null, null); e.retryAfter = 3600; return e; };
  it("the daily limit reads like every other limited action", () => {
    expect(orgLogoErrorText(limited())).toMatch(/^You've hit today's limit for this; try again after /);
  });
  it("too large, not an image, not allowed — and a picked file's own refusal as it is", () => {
    expect(orgLogoErrorText(new OrgApiError(413, "too_large", "an org image is at most 2097152 bytes", null))).toBe("That image is too large.");
    expect(orgLogoErrorText(new OrgApiError(400, "invalid_image", "the file is not a valid image/png", null))).toBe("That file isn't a PNG, JPEG, WebP or GIF image.");
    expect(orgLogoErrorText(new OrgApiError(403, "forbidden", null, null))).toBe("Only an admin or an owner can change the image.");
    expect(orgLogoErrorText(new Error("Pick a PNG, JPEG, WebP or GIF image."))).toBe("Pick a PNG, JPEG, WebP or GIF image.");
    expect(orgLogoErrorText(new TypeError("Failed to fetch"))).toBe("Couldn't upload the image. Check your connection and try again.");
    expect(orgLogoErrorText(new ApiError(500, "500"), true)).toBe("Couldn't remove the image. Try again.");
  });
});
