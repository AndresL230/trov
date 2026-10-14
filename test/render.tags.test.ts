/**
 * The organization's tag list on screen (web/src/tags.ts, marks.ts `tagMark` / `tagWords`) — pure render
 * tests: Org settings › Tags (the list, the add row, "Suggested by agents"), one tag's page, a doc's
 * Tags row, the Feed's tags — and the styling rule: plain words in a list, a coloured SQUARE and the
 * word on an item's own page, in a picker and in Org settings. Never a pill.
 */
import { describe, it, expect, vi } from "vitest";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import css from "../web/src/trov.css?raw";
import { render, initialState, feedTagNames, type AppState } from "../web/src/render";
import { tagMark, tagSquare, tagWords } from "../web/src/marks";
import { tagsTab, tagPageView, itemTagsRow, tagConfirmModal, tagsDropdowns, initialTagsUi, tagDraftProblem, countsPhrase, aiSection, fitLine, type TagsUi } from "../web/src/tags";
import { orgTabsFor, ORG_TABS } from "../web/src/org-settings";
import { parseHash, hashForRoute } from "../web/src/hash";
import { STARTER_TAGS, TAG_COLORS, tagLineParts, similarTag, normalizeTagName, type OrgTagDTO, type TagListDTO, type TagPageDTO, type TagSuggestionDTO, type TagAiDTO, type TagRunDTO } from "@shared/tags-core";
import type { MyOrg, OrgRole } from "@shared/orgs";
import type { FeedRow } from "@shared/rows";

const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme Robotics", role });
const tag = (name: string, o: Partial<OrgTagDTO> = {}): OrgTagDTO => ({ name, description: `About ${name}`, color: "sky", starter: false, retired: false, counts: { feed: 0, doc: 0, adr: 0 }, ...o });
const starters = (): OrgTagDTO[] => STARTER_TAGS.map((t) => tag(t.name, { description: t.description, color: t.color, starter: true, counts: { feed: 4, doc: 1, adr: 0 } }));
const sug = (name: string, o: Partial<TagSuggestionDTO> = {}): TagSuggestionDTO => ({
  name, counts: { feed: 4, doc: 0, adr: 0 }, uses: 4, by: ["mara", "devon"], first_at: "2026-10-10T10:00:00Z", last_at: "2026-10-12T10:00:00Z", similar: null, ...o,
});
const list = (o: Partial<TagListDTO> = {}): TagListDTO => ({
  tags: [...starters(), tag("onboarding", { description: "A new customer's first week", color: "ochre", counts: { feed: 8, doc: 1, adr: 2 } }), tag("legacy", { retired: true })],
  used: 7, cap: 30, suggestions: [sug("billing"), sug("authn", { uses: 1, counts: { feed: 1, doc: 0, adr: 0 }, by: ["mara"], similar: "auth" })], ...o,
});
const tab = (role: OrgRole, l: TagListDTO | null = list(), ui: Partial<TagsUi> = {}) =>
  tagsTab(org(role), { list: { status: l ? "ok" : "loading", data: l }, ui: { ...initialTagsUi(), ...ui } });
/** The markup of one element, by an attribute it carries. */
const piece = (html: string, marker: string): string => {
  const at = html.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
};
/** No tag is a pill. (Org settings' own section headings are small caps: they are not tags, and are set aside.) */
const noPill = (page: string): void => {
  // (The on/off switch is the app's one switch control, round by design — not a tag.)
  const html = page.replace(/<div class="cnpy-sechead">[\s\S]*?<\/div>/g, "").replace(/<button[^>]*role="switch"[^>]*>/g, "");
  expect(html).not.toMatch(/text-transform:\s*uppercase/);
  expect(html).not.toMatch(/border-radius:\s*999/);
  expect(html).not.toContain("●");
};

describe("how a tag is drawn (marks.ts — the one place)", () => {
  it("the mark is an 8px SQUARE with square corners in the tag's colour, and the word — a link to the tag's page", () => {
    const m = tagMark({ name: "auth", color: "plum" });
    expect(m).toContain(`<svg class="cnpy-tagsq" width="8" height="8"`);
    expect(m).toContain(`<rect width="8" height="8" fill="currentColor"/>`);
    expect(m).not.toMatch(/\brx=|<circle|<path/);          // never a ring, a dot or a triangle: those mean a state
    expect(m).toContain("color:var(--p-plum)");
    expect(m).toContain(`data-act="tagOpen" data-arg="auth"`);
    expect(m).not.toMatch(/border|background|padding:[1-9]/); // no box round it
    noPill(m);
    expect(tagMark({ name: "auth", color: "plum" }, { link: false })).not.toContain("data-act");
    expect(tagSquare("not a colour")).toContain("var(--p-slate)");
  });

  it("in a list: plain muted words joined by a middle dot, three at most, then how many more — no colour, no shape", () => {
    const w = tagWords(["auth", "architecture", "api", "onboarding", "mobile"]);
    expect(w.replace(/<[^>]+>/g, "")).toBe("auth · architecture · api and 2 more");
    expect(w).not.toContain("<svg");
    expect(w).not.toContain("--p-");
    expect(w).toContain("color:var(--fg-40)");
    expect((w.match(/data-act="tagOpen"/g) ?? []).length).toBe(3);
    expect(tagWords(["ui", "data"]).replace(/<[^>]+>/g, "")).toBe("ui · data");
    expect(tagWords([])).toBe("");
    expect(tagLineParts(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b", "c"], more: 1 });
    noPill(w);
  });

  it("the CSS for tags declares no radius and no pill", () => {
    const at = css.indexOf("/* ── tags (web/src/tags.ts");
    const block = css.slice(at);
    expect(at).toBeGreaterThan(-1);
    expect(block).not.toMatch(/border-radius/);
    expect(block).not.toMatch(/uppercase/);
  });

  it("the palette is small and fixed, and every key is a colour the stylesheet defines in both themes", () => {
    expect(TAG_COLORS.length).toBe(8);
    for (const c of TAG_COLORS) expect((css.match(new RegExp(`--p-${c}:`, "g")) ?? []).length, c).toBeGreaterThanOrEqual(2);
  });
});

describe("Org settings › Tags", () => {
  it("is a tab every member can open, at #org/tags", () => {
    expect(ORG_TABS).toContain("tags");
    expect(orgTabsFor("member")).toContain("tags");
    expect(parseHash("#org/tags")).toMatchObject({ screen: "org", orgTab: "tags" });
    expect(parseHash("#tags")).toMatchObject({ screen: "org", orgTab: "tags" });
  });

  it("an admin sees the count against the plan, the add row, the list with counts, and each tag's actions", () => {
    const html = tab("admin");
    expect(html).toContain("<strong>7</strong> of 30 tags");
    expect(html).toContain("One list for everything in Acme Robotics");
    expect(html).toContain(`data-act="tagNameDraft"`);
    expect(html).toContain(`data-enter="tagAdd"`);
    expect(html).toContain("Add tag");

    const row = piece(html, `data-org-tag="onboarding"`);
    expect(row).toContain(tagSquare("ochre"));
    expect(row).toContain("A new customer&#39;s first week");
    expect(row).toContain(`data-n="feed" title="8 feed entries"`);
    expect(row).toContain(`data-n="doc" title="1 doc"`);
    expect(row).toContain(`data-n="adr" title="2 decisions"`);
    expect(row).toContain(`data-act="tagEdit" data-arg="onboarding"`);
    expect(row).toContain(`data-dd="tag-merge:onboarding"`);          // dropdown(), never a native select
    expect(row).toContain(`data-act="tagConfirm" data-arg="retire:onboarding"`);
    expect(html).not.toContain("<select");

    // A starter is renamed, never retired or merged away.
    const starter = piece(html, `data-org-tag="auth"`);
    expect(starter).toContain("Starter tag");
    expect(starter).toContain(">Rename</button>");
    expect(starter).not.toContain("tagConfirm");
    expect(starter).not.toContain("tag-merge:");

    // Retired tags are folded away, each with Restore.
    expect(html).toContain("1 retired tag");
    expect(piece(html, `data-org-tag="legacy"`)).toContain(`data-act="tagRestore" data-arg="legacy"`);
    expect(html).toContain("can be renamed, not removed");
    noPill(html);
  });

  it("Suggested by agents sits ABOVE the list, with who sent each, on what, and the three resolutions", () => {
    const html = tab("owner");
    expect(html.indexOf("Suggested by agents")).toBeGreaterThan(-1);
    expect(html.indexOf("Suggested by agents")).toBeLessThan(html.indexOf(`data-org-group="tags"`));

    const billing = piece(html, `data-tag-suggestion="billing"`);
    expect(billing).toContain("Sent on 4 feed entries, first by @mara and 1 other.");
    expect(billing).toContain("Those items are saved without it until you decide.");
    expect(billing).toContain(`data-act="tagSugAccept" data-arg="billing"`);
    expect(billing).toContain("Add to the list");
    expect(billing).toContain(`data-dd="tag-map:billing"`);
    expect(billing).toContain("Use an existing tag");
    expect(billing).toContain(`data-act="tagConfirm" data-arg="dismiss:billing"`);

    // A look-alike on the list is the first offer.
    const authn = piece(html, `data-tag-suggestion="authn"`);
    expect(authn).toContain("Looks like <strong");
    expect(authn).toContain(`data-act="tagSugUse" data-arg="authn&gt;auth"`);
    expect(authn).toContain("Add as its own tag");
    expect(authn).toContain("That item is saved without it");

    // The map dropdown offers the LIVE tags only.
    const map = tagsDropdowns(list(), initialTagsUi()).find((d) => d.id === "tag-map:billing");
    expect(map?.options.map((o) => o.value)).toEqual(["", ...STARTER_TAGS.map((t) => t.name), "onboarding"]);
    const merge = tagsDropdowns(list(), initialTagsUi()).find((d) => d.id === "tag-merge:onboarding");
    expect(merge?.options.map((o) => o.value)).not.toContain("onboarding");
    expect(merge?.options.map((o) => o.value)).not.toContain("legacy");
  });

  it("a member reads the list and changes nothing: no add row, no actions, no suggestions", () => {
    const html = tab("member", list({ suggestions: [] }));
    expect(html).toContain("An admin or an owner decides what is on it.");
    expect(html).toContain(`data-org-tag="onboarding"`);
    for (const act of ["tagAdd", "tagNameDraft", "tagEdit", "tagConfirm", "tagRestore", "tagSugAccept", "tag-merge:"]) expect(html, act).not.toContain(act);
    expect(html).not.toContain("Suggested by agents");
  });

  it("the editor: name, description and a colour switch (segmented) whose options are the squares", () => {
    const html = tab("admin", list(), { edit: { name: "onboarding", nameDraft: "onboarding", descDraft: "First week", color: "ochre", saving: false, error: null } });
    const row = piece(html, `data-tag-edit="onboarding"`);
    expect(row).toContain(`data-act="tagEditName"`);
    expect(row).toContain(`data-act="tagEditDesc"`);
    expect(row).toContain("cnpy-seg");
    expect((row.match(/data-act="tagEditColor"/g) ?? []).length).toBe(TAG_COLORS.length);
    expect(row).toMatch(/class="cnpy-seg-btn is-on"[^>]*data-arg="ochre"/);
    expect(row).toContain("Renaming keeps the tag on everything that has it.");
  });

  it("at the plan's cap the add button is off and the page says why; a bad draft says what a tag is", () => {
    const full = tab("admin", list({ used: 30, cap: 30 }), { nameDraft: "new-one" });
    expect(full).toMatch(/data-act="tagAdd"[^>]* disabled/);
    expect(full).toMatch(/data-org-tag-full>The list holds 30 tags on this plan/);
    expect(tagDraftProblem("Bad Name!", list().tags)).toMatch(/lowercase letters, digits and hyphens/);
    expect(tagDraftProblem("Auth", list().tags)).toBe("“auth” is already on the list.");
    expect(tagDraftProblem("legacy", list().tags)).toMatch(/retired/);
    expect(tagDraftProblem("fresh", list().tags)).toBeNull();
    expect(tagDraftProblem("  ", list().tags)).toBe("");
  });

  it("retire, merge and dismiss each ask first, in the app's confirmModal", () => {
    const retire = tagConfirmModal({ what: "retire", name: "onboarding", busy: false }, list());
    expect(retire).toContain("Retire onboarding?");
    expect(retire).toContain("It stays on the 11 items that have it");
    expect(retire).toContain(`data-act="tagConfirmGo"`);
    const merge = tagConfirmModal({ what: "merge", name: "onboarding", into: "auth", busy: false }, list());
    expect(merge).toContain("Merge onboarding into auth?");
    expect(merge).toContain("The 11 items tagged onboarding are tagged auth instead");
    expect(tagConfirmModal({ what: "dismiss", name: "billing", busy: false }, list())).toContain("If an agent sends billing again, it is suggested again.");
    expect(tagConfirmModal(null, list())).toBe("");
  });

  it("loads and fails like every other tab", () => {
    expect(tab("admin", null)).toContain("Loading");
    expect(tagsTab(org(), { list: { status: "error", data: null }, ui: initialTagsUi() })).toMatch(/Couldn|couldn/);
  });

  it("the whole app renders the tab, morphed in place (typing in its fields never rebuilds the page)", () => {
    const s: AppState = initialState();
    s.view = "app"; s.screen = "org"; s.orgSlug = "acme"; s.org.tab = "tags";
    s.me = { handle: "andres", name: "Andres", color: "moss", avatar_url: null, orgs: [org("owner")], pending_invites: 0 } as unknown as AppState["me"];
    s.tags = { status: "ok", data: list() };
    const html = render(s);
    expect(html).toContain(`data-morph="org"`);
    expect(html).toContain(`data-org-group="tag-suggestions"`);
    expect(html).toContain(`id="org-tab-tags"`);
    s.tagsUi.confirm = { what: "retire", name: "onboarding", busy: false };
    expect(render(s)).toContain("Retire onboarding?");
  });
});

describe("one tag's page", () => {
  const page = (o: Partial<TagPageDTO> = {}): TagPageDTO => ({
    tag: tag("auth", { description: "Sign-in, sessions, tokens, permissions", color: "plum", starter: true, counts: { feed: 2, doc: 1, adr: 1 } }),
    items: {
      feed: [
        { type: "feed", id: "41", title: "Google sign-in no longer loops", note: "Picking the second account used to send them back.", by: "mara", at: "2026-10-12T10:00:00Z", tags: ["ui"] },
        { type: "feed", id: "40", title: "Connections can be limited", note: null, by: "devon", at: "2026-10-11T10:00:00Z", tags: [] },
      ],
      doc: [{ type: "doc", id: "how-sign-in-works", title: "How sign-in works", note: "reference", by: "mara", at: "2026-10-09T10:00:00Z", tags: ["api", "data", "ui", "infra"] }],
      adr: [{ type: "adr", id: "7", title: "Sessions live in a cookie", note: "ratified", by: "devon", at: "2026-09-14T10:00:00Z", tags: [] }],
    },
    seen_with: [{ name: "api", count: 17 }, { name: "ui", count: 9 }],
    authors: [{ handle: "mara", count: 23 }],
    ...o,
  });
  const view = (p: TagPageDTO | null, tabv: "all" | "feed" | "doc" | "adr" = "all", status: "ok" | "loading" | "error" = "ok") =>
    tagPageView({ name: "auth", page: { status, data: p }, tab: tabv, orgName: "Acme Robotics", who: (h) => `<b>@${h}</b>` });

  it("has a route that round-trips, with a normalized name", () => {
    expect(parseHash("#tags/auth")).toMatchObject({ screen: "tag", tagName: "auth" });
    expect(hashForRoute(parseHash("#tags/customer-success"))).toBe("#tags/customer-success");
    expect(parseHash("#tags/Auth")).toMatchObject({ screen: "tag", tagName: "auth" });
    expect(parseHash("#tags/a/b").screen).toBe("mywork");
    expect(parseHash("#tags/%20").screen).toBe("mywork");
  });

  it("shows the tag as its square and name, what it is for, and everything that carries it, grouped", () => {
    const html = view(page());
    expect(html).toContain(tagSquare("plum", 12));
    expect(html).toContain("Sign-in, sessions, tokens, permissions · 4 items");
    // A tab per type (tabBar), with counts.
    expect(html).toContain(`role="tablist"`);
    for (const t of ["all", "feed", "doc", "adr"]) expect(html).toContain(`id="tag-tab-${t}"`);
    // What the team knows first, then the feed.
    const [docs, decisions, feed] = [html.indexOf(`data-tag-group="doc"`), html.indexOf(`data-tag-group="adr"`), html.indexOf(`data-tag-group="feed"`)];
    expect(docs).toBeGreaterThan(-1);
    expect(docs).toBeLessThan(decisions);
    expect(decisions).toBeLessThan(feed);
    expect(html).toContain("Recent in the feed");

    const doc = piece(html, `data-tag-item="doc:how-sign-in-works"`);
    expect(doc).toContain(`data-act="openDocFrom" data-arg="how-sign-in-works"`);
    expect(doc.replace(/<[^>]+>/g, " ")).toMatch(/api\s+·\s+data\s+·\s+ui\s+and 1 more/);   // its other tags: plain words, cut after three
    expect(doc).not.toContain("<svg");
    expect(piece(html, `data-tag-item="feed:41"`)).toContain("Picking the second account used to send them back.");
    expect(piece(html, `data-tag-item="adr:7"`)).toContain("Ratified");
    expect(piece(html, `data-tag-item="adr:7"`)).toContain(`data-act="tagOpenDecision" data-arg="Sessions live in a cookie"`);
    expect(html).toContain("Often seen with");
    expect(html).toContain("Who writes about it");
    expect(html).toContain("<b>@mara</b>");
    noPill(html);
  });

  it("a type's tab shows that type alone; an empty tag, a missing tag, a loading and a failed read each say so", () => {
    const feedOnly = view(page(), "feed");
    expect(feedOnly).toContain(`data-tag-group="feed"`);
    expect(feedOnly).not.toContain(`data-tag-group="doc"`);
    expect(feedOnly).not.toContain("Often seen with");
    const none = view(page({ tag: tag("auth", { counts: { feed: 0, doc: 0, adr: 0 } }), items: { feed: [], doc: [], adr: [] }, seen_with: [], authors: [] }));
    expect(none).toContain("Nothing carries this tag yet");
    expect(view(null)).toContain("No such tag");
    expect(view(null)).toContain("“auth” is not one of Acme Robotics&#39;s tags.");
    expect(view(null, "all", "loading")).toContain("Loading");
    expect(view(null, "all", "error")).toContain(`data-act="tagPageReload"`);
    expect(view(page({ tag: tag("auth", { retired: true, counts: { feed: 2, doc: 1, adr: 1 } }) }))).toContain("can no longer be picked");
  });

  it("the app renders it as a child screen of Tags, crumbed with the tag's name", () => {
    const s: AppState = initialState();
    s.view = "app"; s.screen = "tag"; s.tagName = "auth"; s.orgSlug = "acme";
    s.tagPage = { status: "ok", data: page() };
    const html = render(s);
    expect(html).toContain(`data-screen-label="Tag"`);
    expect(html).toContain(`data-act="tagsGo"`);   // the title is the way back to the list
    expect(html).toContain(`data-tag-group="feed"`);
  });
});

describe("tags where items already show", () => {
  const refs = list().tags;

  it("a doc's page has a Tags row: each tag as its square and word with a remove button, and a picker of the live tags it lacks", () => {
    const row = itemTagsRow({ tags: ["auth", "onboarding"], list: refs, busy: false });
    expect(row).toContain(tagSquare("plum"));
    expect(row).toContain(tagSquare("ochre"));
    expect(row).toContain(`data-act="tagItemRemove" data-arg="auth"`);
    expect(row).toContain(`aria-label="Remove the tag auth"`);
    expect(row).toContain(`data-dd="item-tag-add"`);
    expect(row).not.toContain("<select");
    noPill(row);

    const s: AppState = initialState();
    s.view = "app"; s.screen = "docs"; s.docSlug = "d1";
    s.tags = { status: "ok", data: list() };
    s.docDetail = { status: "ok", data: { doc: { slug: "d1", section: "reference", title: "D1", body: "b", current_version: 1, updated_at: "2026-10-01T00:00:00Z", updated_by: "mara", space: "technical", owner: null } as never, versions: [], tags: ["auth"] } };
    const html = render(s);
    expect(html).toContain("data-item-tags");
    expect(html).toContain(`data-item-tag="auth"`);
  });

  it("the Feed shows an entry's tags as plain linked words, and filters by the ORG's list", () => {
    const s: AppState = initialState();
    s.view = "app"; s.screen = "feed";
    s.tags = { status: "ok", data: list() };
    const row = (id: number, tags: string[]): FeedRow => ({ id, author: "mara", summary: `entry ${id}`, brief: null, body: "b", artifacts: null, created_at: "2026-10-12T10:00:00Z", tags });
    s.feed = { status: "ok", data: [row(1, ["onboarding", "ui", "auth", "data"]), row(2, [])] };
    const html = render(s);
    expect(html.replace(/<[^>]+>/g, " ")).toMatch(/onboarding\s+·\s+ui\s+·\s+auth\s+and 1 more/);
    expect(html).toContain(`data-act="tagOpen" data-arg="onboarding"`);
    expect((html.match(/class="cnpy-tagwords"/g) ?? []).length).toBe(1);   // an entry with no tags shows none

    // The filter's choices are the org's own tags (a retired one still filters), not six fixed words.
    expect(feedTagNames(s)).toEqual([...STARTER_TAGS.map((t) => t.name), "onboarding", "legacy"]);
    s.feedTag = "renamed-away";
    expect(feedTagNames(s)).toContain("renamed-away");
    s.tags = { status: "idle", data: null };
    s.feedTag = "all";
    expect(feedTagNames(s)).toEqual([]);
  });
});

describe("shared helpers", () => {
  it("normalizes a name, finds a look-alike, and phrases counts", () => {
    expect(normalizeTagName("  Customer  Success ")).toBe("customer-success");
    expect(normalizeTagName("snake_case")).toBe("snake-case");
    expect(normalizeTagName("-edge-")).toBe("edge");
    for (const bad of ["", "   ", "a/b", "émoji", "x".repeat(33), 7, null]) expect(normalizeTagName(bad)).toBeNull();
    expect(similarTag("authn", ["auth", "ui"])).toBe("auth");
    expect(similarTag("infa", ["infra"])).toBe("infra");
    expect(similarTag("billing", ["auth", "ui", "api"])).toBeNull();
    expect(countsPhrase({ feed: 4, doc: 1, adr: 0 })).toBe("4 feed entries and 1 doc");
    expect(countsPhrase({ feed: 1, doc: 2, adr: 3 })).toBe("1 feed entry, 2 docs and 3 decisions");
    expect(countsPhrase({ feed: 0, doc: 0, adr: 0 })).toBe("nothing yet");
  });
});

describe("tags added by Jev, on the Tags tab (the owner's call: no review step)", () => {
  const ai = (o: Partial<TagAiDTO> = {}): TagAiDTO => ({ enabled: true, available: true, used: 12, cap: 300, spent: false, ...o });
  const run = (o: Partial<TagRunDTO> = {}): TagRunDTO => ({ id: 4, status: "done", started_at: "t", ended_at: "t", candidates: 20, checked: 20, added: 7, undone_at: null, ...o });
  const t = (name: string): OrgTagDTO => tag(name, { color: "ochre" });

  it("the switch: OFF by default, one plain sentence on what is sent, to whom, and that the tag is ADDED — with the way back", () => {
    const off = aiSection(ai({ enabled: false }), initialTagsUi());
    expect(off).toContain(`role="switch" aria-checked="false"`);
    expect(off).toContain(`aria-label="Tag existing items for a new tag"`);
    expect(off).toContain("to Jev, TypeSafe AI's decision model, and adds the tag to each item Jev judges a fit.");
    expect(off).toContain("You can undo a run, or take the tag off any item.");
    expect(off).not.toContain("until you accept");
    expect(off).toContain("first 400 characters");
    expect(off).toContain("Off: nothing is sent.");
    expect(aiSection(ai(), initialTagsUi())).toContain("12 of 300 checks used this month.");
    expect(aiSection(ai({ spent: true, used: 300 }), initialTagsUi())).toContain("This month&#39;s checks are used up");
    const nokey = aiSection(ai({ available: false, enabled: false }), initialTagsUi());
    expect(nokey).toContain("no TypeSafe AI key set, so nothing is sent and nothing is tagged");
    expect(nokey).toMatch(/role="switch"[^>]*disabled|disabled[^>]*role="switch"/);
  });

  it("after a run the row says what it did: \"Added to 7 items\" with Undo (confirmModal); none fit; nothing to check; undone; stopped", () => {
    const added = fitLine(t("onboarding"), run(), ai(), initialTagsUi());
    expect(added).toContain("Added to 7 items.");
    expect(added).toContain(`data-act="tagConfirm" data-arg="undoRun:onboarding"`);
    expect(added).toContain(`data-act="tagFind" data-arg="onboarding"`);
    expect(added).not.toMatch(/Accept|Dismiss|may fit/);
    expect(fitLine(t("x"), run({ added: 1 }), ai(), initialTagsUi())).toContain("Added to 1 item.");
    expect(fitLine(t("x"), run({ added: 0 }), ai(), initialTagsUi())).toContain("Checked 20 — none fit.");
    expect(fitLine(t("x"), run({ added: 0, candidates: 0, checked: 0 }), ai(), initialTagsUi())).toContain("Nothing in this organization to check yet.");
    const undone = fitLine(t("x"), run({ undone_at: "t" }), ai(), initialTagsUi());
    expect(undone).toContain("Undone: the 7 items this run tagged no longer have it.");
    expect(undone).not.toContain("undoRun");
    expect(fitLine(t("x"), run({ status: "capped", checked: 9, added: 2 }), ai(), initialTagsUi())).toContain("Stopped at 9 of 20: this month&#39;s checks are used up. Added to 2 items.");
    expect(fitLine(t("x"), run({ status: "running" }), ai(), initialTagsUi())).toContain("Looking for items that fit…");
    expect(fitLine(t("x"), run({ status: "running" }), ai(), initialTagsUi())).not.toContain("tagFind");
    // The switch off: no Find items; a member never sees any of it (the tab passes no `ai`).
    expect(fitLine(t("x"), undefined, ai({ enabled: false }), initialTagsUi())).toBe("");
    expect(fitLine(t("x"), run(), undefined, initialTagsUi())).toBe("");
  });

  it("Undo asks first, and says exactly what it takes back", () => {
    const m = tagConfirmModal({ what: "undoRun", name: "onboarding", busy: false }, list({ runs: { onboarding: run() } }));
    expect(m).toContain("Undo the last run for onboarding?");
    expect(m).toContain("onboarding comes off the 7 items that run tagged. Nothing else changes, and Trov will not add it to them again.");
    expect(m).toContain(`data-act="tagConfirmGo"`);
  });

  it("in the tab: the result under each row; a member sees none of it", () => {
    const html = tab("admin", list({ ai: ai(), runs: { onboarding: run(), auth: run({ status: "running" }) } }));
    expect(html).toContain(`data-org-group="tag-ai"`);
    expect(html.slice(html.indexOf(`data-org-tag="onboarding"`))).toContain("Added to 7 items.");
    expect(html.slice(html.indexOf(`data-org-tag="auth"`))).toContain("Looking for items that fit…");
    const member = tab("member", list({ ai: ai(), runs: { onboarding: run() } }));
    expect(member).not.toContain("tag-ai");
    expect(member).not.toContain("Added to");
    noPill(html);
  });
});
