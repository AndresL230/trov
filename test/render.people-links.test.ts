/**
 * Every name or photo in the app opens that person's card (people.ts's link helpers), and
 * anything that is no one — an unknown handle, a bot, the GitHub mirror — stays plain.
 * The per-surface assertions live beside each surface's own tests; this file pins the
 * helpers themselves and the surfaces that have no test file of their own.
 */
import { describe, it, expect } from "vitest";
import { handleTag, handleLink, personLink, personNameLink } from "../web/src/people";
import { sessionSection, initialState } from "../web/src/render";

const P = { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null };

describe("people.ts — the link helpers", () => {
  it("personNameLink and handleLink are openPerson buttons for a person, plain text for null", () => {
    expect(personNameLink(P, "Priya")).toMatch(/^<button data-act="openPerson" data-arg="priya" class="cnpy-personlink" title="Priya Natarajan"/);
    expect(personNameLink(null, "ghost")).toBe("<span>ghost</span>");
    expect(handleLink(P, "priya")).toContain(`>${handleTag(P, "priya")}</button>`);
    expect(handleLink(null, "ghost")).toBe(handleTag(null, "ghost"));
  });

  it("personLink takes a caller-built label and the gap of the pair it replaces; plain when null", () => {
    const html = personLink(P, "priya", 20, { html: "<b>Priya</b>" }, "", 6);
    expect(html).toContain("gap:6px");
    expect(html).toContain("<b>Priya</b>");
    // The hover padding bleeds out through -10px of margin, so the cap is 100% + 10px.
    expect(html).toContain("max-width:calc(100% + 10px)");
    expect(personLink(null, "ghost", 20, "ghost", "")).not.toContain("<button");
  });
});

describe("Settings › Session", () => {
  it("'Signed in as' is your own handle, opening your own card", () => {
    const s = initialState();
    s.me = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss", identities: [{ provider: "github", label: "AndresL230", linked_at: "t" }], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 };
    expect(sessionSection(s)).toMatch(/Signed in as <button data-act="openPerson" data-arg="AndresL230" class="cnpy-personlink"/);
  });
});
