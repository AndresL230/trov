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
import { tagsTab, tagPageView, tagWeeks, isTagPageTab, type TagPageTab, itemTagsRow, tagConfirmModal, initialTagsUi, tagDraftProblem, countsPhrase, aiSection, jevCell, tagAddModal, nextTagColor, type TagsUi } from "../web/src/tags";
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

  it("an admin sees the count against the plan, New tag over the list, the list with counts, and each tag's actions in a ⋯ menu", () => {
    const html = tab("admin");
    expect(html).toContain("<strong>7</strong> of 30 tags");
    expect(html).toContain("One list for everything in Acme Robotics");
    // Adding a tag is a button over the list (at the right) that opens a modal — no form on the page.
    expect(html).toMatch(/<div class="cnpy-tagsbar"><button type="button" data-act="tagNew" data-field="tagNew" aria-haspopup="dialog"/);
    expect(html.indexOf(`data-act="tagNew"`)).toBeLessThan(html.indexOf("cnpy-taghead"));
    expect(html).not.toContain(`data-act="tagNameDraft"`);
    const modal = tagAddModal({ ...initialTagsUi(), addOpen: true, nameDraft: "billing", addColor: "rust" }, list());
    expect(modal).toContain(`role="alertdialog"`);
    expect(modal).toContain(">New tag<");
    expect(modal).toMatch(/id="tag-new-name" data-act="tagNameDraft"[^>]*data-confirm-focus/);
    expect(modal).toContain(`id="tag-new-desc" data-act="tagDescDraft"`);
    expect((modal.match(/data-act="tagNewColor"/g) ?? []).length).toBe(TAG_COLORS.length);
    expect(modal).toMatch(/class="cnpy-seg-btn is-on"[^>]*data-arg="rust"/);
    expect(modal).toContain(`data-act="tagAdd"`);
    expect(modal).toContain(`data-act="tagNewCancel"`);
    expect(tagAddModal(initialTagsUi(), list())).toBe("");                      // closed
    expect(nextTagColor([{ color: "moss", retired: false }, { color: "fern", retired: false }])).toBe("sky");

    const row = piece(html, `data-org-tag="onboarding"`);
    expect(row).toContain(tagSquare("ochre"));
    expect(row).toContain("A new customer&#39;s first week");
    expect(row).toMatch(/data-col="n" class="cnpy-tagrow-n" title="8 feed entries, 1 doc and 2 decisions">11</);
    // The row itself is one line: the less frequent actions wait in its ⋯ menu, closed.
    expect(row).toContain(`data-act="tagMenu" data-arg="onboarding"`);
    expect(row).toContain(`aria-haspopup="menu" aria-expanded="false"`);
    expect(row).not.toContain(`role="menu"`);
    const open = piece(tab("admin", list(), { menu: "onboarding" }), `data-org-tag="onboarding"`);
    expect(open).toContain(`aria-expanded="true"`);
    expect(open).toContain(`role="menu"`);
    expect(open).toContain(`data-act="tagRename" data-arg="onboarding"`);
    expect(open).toContain(`data-act="tagMergeOpen" data-arg="onboarding"`);
    expect(open).toContain(`data-act="tagConfirm" data-arg="retire:onboarding"`);
    expect(open).toContain(`data-act="tagMenuClose"`);
    // Merge into… turns the menu into the LIVE tags to merge into (not itself, not a retired one); a pick asks first.
    const merging = piece(tab("admin", list(), { menu: "onboarding", menuMerge: true }), `data-org-tag="onboarding"`);
    expect(merging).toContain("Merge onboarding into");
    for (const st of STARTER_TAGS) expect(merging).toContain(`data-act="tagMergeTo" data-arg="onboarding&gt;${st.name}"`);
    expect(merging).not.toContain(`data-arg="onboarding&gt;onboarding"`);
    expect(merging).not.toContain(`data-arg="onboarding&gt;legacy"`);
    expect(merging).not.toContain("tagRename");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("data-dd=");

    // Every row and the head share ONE column template, so they line up.
    expect(html).toMatch(/--tagcols:minmax\(0, 176px\) minmax\(0, 1fr\) 44px 116px;/);
    expect(html).not.toContain("cnpy-tagfitline");

    // A starter is renamed, never retired or merged away.
    const starter = piece(html, `data-org-tag="auth"`);
    expect(starter).toContain(">Starter<");
    const starterMenu = piece(tab("admin", list(), { menu: "auth" }), `data-org-tag="auth"`);
    expect(starterMenu).toContain(`data-act="tagRename" data-arg="auth"`);
    expect(starterMenu).not.toContain("tagConfirm");
    expect(starterMenu).not.toContain("tagMergeOpen");

    // Retired tags are folded away, each with Restore.
    expect(html).toContain("1 retired tag");
    expect(piece(html, `data-org-tag="legacy"`)).toContain(`data-act="tagRestore" data-arg="legacy"`);
    expect(html).toContain("can be renamed, not removed");
    noPill(html);
  });

  it("an agent's suggestion is a row of the same list, in a suggested state: Approve on the row, the rest in its ⋯ menu", () => {
    const html = tab("owner");
    expect(html).toContain("<strong>2</strong> waiting");                     // the header counts them; they sit in the list
    const listStart = html.indexOf(`data-org-group="tags"`);
    expect(html.indexOf(`data-tag-suggestion="billing"`)).toBeGreaterThan(listStart);
    expect(html.indexOf(`data-tag-suggestion="billing"`)).toBeGreaterThan(html.indexOf(`data-org-tag="onboarding"`)); // at the bottom, after every tag
    expect(html.indexOf(`data-tag-suggestion="billing"`)).toBeLessThan(html.indexOf("data-org-tags-retired"));

    const billing = piece(html, `data-tag-suggestion="billing"`);
    expect(billing).toContain(`class="cnpy-tagsug-sq"`);                     // a hollow square: not on the list yet
    expect(billing).not.toContain("cnpy-tagsq");
    expect(billing).toContain(">Suggested<");
    expect(billing).toContain("An agent sent this tag. It is not on the list until an admin approves it.");
    expect(billing).toContain(">From @mara and 1 other, on 4 feed entries.<");  // one line; the whole sentence is its tooltip
    expect(billing).toContain(`title="Sent on 4 feed entries, first by @mara and 1 other. Those items are saved without it until you approve."`);
    expect(billing).toContain(`data-act="tagSugAccept" data-arg="billing"`);
    expect(billing).toContain(">Approve<");
    expect(billing).toContain(`data-act="tagMenu" data-arg="sug:billing"`);

    const menu = piece(tab("owner", list(), { menu: "sug:billing" }), `data-tag-suggestion="billing"`);
    expect(menu).toContain(`data-act="tagSugMapOpen" data-arg="billing"`);
    expect(menu).toContain(`data-act="tagConfirm" data-arg="dismiss:billing"`);
    // "Use an existing tag…" lists the LIVE tags only.
    const map = piece(tab("owner", list(), { menu: "sug:billing", menuMerge: true }), `data-tag-suggestion="billing"`);
    for (const t of [...STARTER_TAGS.map((x) => x.name), "onboarding"]) expect(map).toContain(`data-act="tagSugUse" data-arg="billing&gt;${t}"`);
    expect(map).not.toContain("billing&gt;legacy");

    // A look-alike on the list is the menu's first offer, and the row names it.
    const authn = piece(html, `data-tag-suggestion="authn"`);
    expect(authn).toContain("Looks like <strong");
    expect(authn).toContain("That item is saved without it until you approve.");
    const authnMenu = piece(tab("owner", list(), { menu: "sug:authn" }), `data-tag-suggestion="authn"`);
    expect(authnMenu).toMatch(/role="menu"[^>]*>\s*<button[^>]*data-act="tagSugUse" data-arg="authn&gt;auth"[^>]*>Use auth instead</);
    noPill(html);
  });

  it("a member reads the list and changes nothing: no add row, no actions, no suggestions", () => {
    const html = tab("member", list({ suggestions: [] }));
    expect(html).toContain("An admin or an owner decides what is on it.");
    expect(html).toContain(`data-org-tag="onboarding"`);
    for (const act of ["tagAdd", "tagNameDraft", "tagEdit", "tagConfirm", "tagRestore", "tagSugAccept", "tag-merge:", "tagMenu", "tagFind"]) expect(html, act).not.toContain(act);
    expect(html).toMatch(/--tagcols:minmax\(0, 176px\) minmax\(0, 1fr\) 44px;/);
    expect(html).not.toContain("data-tag-suggestion");
  });

  it("edits in place: a click on what it is for (or the menu's Rename) puts a field where the words were; the square opens the colour", () => {
    const row = piece(tab("admin"), `data-org-tag="onboarding"`);
    expect(row).toContain(`data-act="tagEdit" data-arg="onboarding"`);       // what it is for is the button
    expect(row).toContain(`data-act="tagColorOpen" data-arg="onboarding"`);  // the square is the button
    expect(row).not.toContain("tagEditColor");
    const desc = piece(tab("admin", list(), { edit: { name: "onboarding", field: "desc", nameDraft: "onboarding", descDraft: "First week", color: "ochre", saving: false, error: null } }), `data-org-tag="onboarding"`);
    expect(desc).toMatch(/<input id="tag-inline" data-tag-inline="onboarding" data-act="tagEditDesc"[^>]*data-enter="tagEditSave"[^>]*value="First week"/);
    expect(desc).not.toContain(`data-act="tagEditName"`);
    expect(desc).not.toContain("cnpy-tagedit");                              // no panel under the row
    const name = piece(tab("admin", list(), { edit: { name: "onboarding", field: "name", nameDraft: "bad!!", descDraft: "", color: "ochre", saving: false, error: null } }), `data-org-tag="onboarding"`);
    expect(name).toMatch(/data-act="tagEditName"[^>]*aria-invalid="true"/);
    const colour = piece(tab("admin", list(), { colorOpen: "onboarding" }), `data-org-tag="onboarding"`);
    expect(colour).toContain("cnpy-seg");
    expect((colour.match(/data-act="tagColorPick"/g) ?? []).length).toBe(TAG_COLORS.length);
    expect(colour).toMatch(/class="cnpy-seg-btn is-on"[^>]*data-arg="ochre"/);
    // A member edits nothing in place.
    const member = piece(tab("member"), `data-org-tag="onboarding"`);
    expect(member).not.toContain("tagColorOpen");
    expect(member).not.toContain(`data-act="tagEdit"`);
  });

  it("after a name or a description changes, it offers Find items again (a neutral confirmModal)", () => {
    const m = tagConfirmModal({ what: "rerun", name: "onboarding", changed: "desc", busy: false }, list());
    expect(m).toContain("Find items for onboarding again?");
    expect(m).toContain("You changed what it is for.");
    expect(m).toContain("Nothing that has it now loses it.");
    expect(m).toContain(`data-act="tagConfirmGo"`);
    expect(tagConfirmModal({ what: "rerun", name: "onboarding", changed: "name", busy: false }, list())).toContain("You changed its name.");
  });

  it("at the plan's cap the add button is off and the page says why; a bad draft says what a tag is", () => {
    const full = tab("admin", list({ used: 30, cap: 30 }));
    expect(full).toMatch(/data-act="tagNew"[^>]* disabled title="The list holds 30 tags on this plan\. Retire or merge one to add another\."/);
    const bad = tagAddModal({ ...initialTagsUi(), addOpen: true, nameDraft: "Bad Name!" }, list());
    expect(bad).toMatch(/id="tag-new-e" role="alert" class="cnpy-tagnew-err">A tag is up to/);
    expect(bad).toMatch(/class="cnpy-confirm-go cnpy-confirm-go--neutral" disabled/);
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
    expect(html).toContain(`data-tag-suggestion="billing"`);
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
      doc: [{ type: "doc", id: "how-sign-in-works", title: "How sign-in works", note: "reference", by: "mara", at: "2026-10-09T10:00:00Z", tags: ["api", "data", "ui", "infra"],
        jev: { confidence: 0.86, reason: "It explains how people sign in.", at: "2026-10-13T10:00:00Z" } }],
      adr: [{ type: "adr", id: "7", title: "Sessions live in a cookie", note: "ratified", by: "devon", at: "2026-09-14T10:00:00Z", tags: [] }],
    },
    seen_with: [{ name: "api", count: 17 }, { name: "ui", count: 9 }],
    authors: [{ handle: "mara", count: 23 }],
    jev_added: 1,
    ...o,
  });
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const TAG_PAGE_TABS_FOR_TEST: TagPageTab[] = ["all", "feed", "doc", "adr"];
  const view = (p: TagPageDTO | null, tabv: TagPageTab = "all", status: "ok" | "loading" | "error" = "ok") =>
    tagPageView({ name: "auth", page: { status, data: p }, tab: tabv, orgName: "Acme Robotics", who: (h) => `<b>@${h}</b>`, now: NOW });
  /** The tab the bar marks picked, and the tab its panel says it is. */
  const shownTab = (html: string): { picked: string | undefined; panel: string | undefined } => ({
    picked: html.match(/id="tag-tab-([a-z]+)"[^>]*aria-selected="true"/)?.[1],
    panel: html.match(/role="tabpanel" id="tag-tab-panel" aria-labelledby="tag-tab-([a-z]+)"/)?.[1],
  });

  it("has a route that round-trips, with a normalized name", () => {
    expect(parseHash("#tags/auth")).toMatchObject({ screen: "tag", tagName: "auth" });
    expect(hashForRoute(parseHash("#tags/customer-success"))).toBe("#tags/customer-success");
    expect(parseHash("#tags/Auth")).toMatchObject({ screen: "tag", tagName: "auth" });
    expect(parseHash("#tags/a/b").screen).toBe("mywork");
    expect(parseHash("#tags/%20").screen).toBe("mywork");
  });

  it("shows the tag as its square and name, what it is for, and everything that carries it, grouped", () => {
    const html = view(page());
    // The hero: the square (bigger here: it is the tag's own page) and the name, what it is for, the counts by type.
    expect(html).toContain(tagSquare("plum", 16));
    expect(html).toContain(`<h2 class="cnpy-tagpage-name">`);
    expect(html).toContain("Sign-in, sessions, tokens, permissions");
    expect(html).toContain("Starter tag");
    const figs = (html.match(/<dl class="cnpy-tagpage-figs">([\s\S]*?)<\/dl>/)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(figs).toBe("Items 4 Doc 1 Decision 1 Feed entries 2");
    expect(html).toContain(`--tag-c:var(--p-plum)`);   // the tag's colour draws the page's charts
    // A tab per type (tabBar), with counts.
    expect(html).toContain(`role="tablist"`);
    for (const t of ["all", "feed", "doc", "adr"]) expect(html).toContain(`id="tag-tab-${t}"`);
    // A bento, not one column: Docs over Decisions in one column beside the feed, then Activity, Who tagged it,
    // Who writes about it and Often seen with in one row — each tile saying its width and its fixed size.
    expect(html).toContain(`class="cnpy-tagpage-grid`);
    const at = (m: string) => html.indexOf(m);
    const order = [`data-tag-group="doc"`, `data-tag-group="adr"`, `data-tag-group="feed"`, `data-tag-tile="activity"`, `data-tag-tile="jev"`, `data-tag-tile="people"`, `data-tag-tile="seen"`].map(at);
    expect(order[0]).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(`<div class="cnpy-tagpage-col" style="--span:5;--md:6">`);
    expect(html).toMatch(/style="--span:7;--md:6" data-size="tall" data-tag-group="feed"/);
    for (const t of ["activity", "jev", "people", "seen"]) expect(html).toMatch(new RegExp(`style="--span:3;--md:6" data-size="row" data-tag-tile="${t}"`));
    // As wide as the widest app screens (ui.ts WORK_SHELL, the queue's and the Artifacts' frame).
    expect(html).toContain("max-width:1440px");
    expect(html).toContain("Recent in the feed");

    const doc = piece(html, `data-tag-item="doc:how-sign-in-works"`);
    expect(doc).toContain(`data-act="openDocFrom" data-arg="how-sign-in-works"`);
    expect(doc).toContain("Reference");
    expect(doc.replace(/<[^>]+>/g, " ")).toMatch(/api\s+·\s+data\s+·\s+ui\s+and 1 more/);   // its other tags: plain words, cut after three
    expect(doc).not.toContain("<svg");
    // Jev added this one: plain words (a fact, not a state), its reason and how sure in the tooltip.
    expect(doc).toContain(`data-by-jev="1"`);
    expect(doc).toContain("Added by Jev");
    expect(doc).toContain("It explains how people sign in. Jev, TypeSafe AI&#39;s model, was 86% sure (Oct 13).");
    expect(piece(html, `data-tag-item="feed:41"`)).not.toContain("Added by Jev");
    expect(piece(html, `data-tag-item="feed:41"`)).toContain("Picking the second account used to send them back.");
    // A decision's state is a mark from marks.ts.
    expect(piece(html, `data-tag-item="adr:7"`)).toContain("Ratified");
    expect(piece(html, `data-tag-item="adr:7"`)).toContain("A person ratified this decision.");
    expect(piece(html, `data-tag-item="adr:7"`)).toContain(`data-act="tagOpenDecision" data-arg="Sessions live in a cookie"`);
    // Who tagged it: Jev against people and their agents.
    const who = html.slice(at(`data-tag-tile="jev"`), at(`data-tag-tile="people"`)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(who).toContain("1 by Jev 3 by people and their agents");
    expect(who).toContain("How sign-in works 86% sure");
    // Activity: twelve weekly bars, the newest and the oldest.
    expect((html.match(/class="cnpy-tagpage-wk"/g) ?? []).length).toBe(12);
    expect(html).toContain(`aria-label="4 items in the last 12 weeks, by week"`);
    expect(html).toContain("Sep 14");
    expect(html).toContain("Often seen with");
    expect(html).toContain("Who writes about it");
    expect(html).toContain("<b>@mara</b>");
    noPill(html);
  });

  it("counts items per week, oldest week first, and leaves out what is older than twelve weeks", () => {
    const weeks = tagWeeks([{ at: "2026-10-14T00:00:00Z" }, { at: "2026-10-13T00:00:00Z" }, { at: "2026-10-01T00:00:00Z" }, { at: "2026-01-01T00:00:00Z" }, { at: null }], NOW);
    expect(weeks).toHaveLength(12);
    expect(weeks[11]).toBe(2);
    expect(weeks[10]).toBe(1);   // 13½ days before: the week before this one
    expect(weeks.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("every tile keeps ONE size whatever it holds — none, one or twenty items, or its empty sentence — and its body scrolls", () => {
    const many = (n: number): TagPageDTO["items"] => {
      const mk = (type: "feed" | "doc" | "adr", k: number) => ({ type, id: `${type}${k}`, title: `${type} ${k}`, note: type === "adr" ? "draft" : "a note", by: "mara", at: "2026-10-10T10:00:00Z", tags: [] });
      return { feed: Array.from({ length: n }, (_, k) => mk("feed", k)), doc: Array.from({ length: n }, (_, k) => mk("doc", k)), adr: Array.from({ length: n }, (_, k) => mk("adr", k)) };
    };
    const withN = (n: number) => page({ tag: tag("auth", { color: "plum", counts: { feed: n, doc: n, adr: n } }), items: many(n), seen_with: n ? [{ name: "api", count: n }] : [], authors: n ? [{ handle: "mara", count: n }] : [], jev_added: 0 });
    /** Each tile, in order: what it is, its fixed size and its width. */
    const tiles = (html: string) => [...html.matchAll(/<section class="cnpy-surface cnpy-tagpage-tile" style="([^"]*)" data-size="([a-z]+)" data-(?:tag-group|tag-tile)="([a-z]+)"/g)].map((m) => `${m[3]}:${m[2]}:${m[1]}`);
    for (const t of TAG_PAGE_TABS_FOR_TEST) {
      const [none, one, twenty] = [0, 1, 20].map((n) => tiles(view(withN(n), t)));
      expect(none.length).toBeGreaterThan(1);
      expect(one).toEqual(none);
      expect(twenty).toEqual(none);
      // Every tile has a size and a body that scrolls.
      const html = view(withN(20), t);
      expect((html.match(/class="cnpy-surface cnpy-tagpage-tile"/g) ?? []).length).toBe(none.length);
      expect((html.match(/class="cnpy-tagpage-body cnpy-scroll"/g) ?? []).length).toBe(none.length);
    }
    // The empty tag keeps the whole bento, each tile saying it is empty in its own box.
    expect(tiles(view(withN(0)))).toEqual(["doc:half:--span:12;--md:12", "adr:half:--span:12;--md:12", "feed:tall:--span:7;--md:6", "activity:row:--span:3;--md:6", "jev:row:--span:3;--md:6", "people:row:--span:3;--md:6", "seen:row:--span:3;--md:6"]);
  });

  it("the tile sizes are fixed heights in trov.css: half + gap + half = tall, row + gap + rest = tall; only the body scrolls", () => {
    const rules = (sel: string): string => {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return [...css.matchAll(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`, "g"))].map((m) => m[1]).join(";");
    };
    const vars = rules(".cnpy-tagpage");
    expect(vars).toContain("--tp-tall:calc(var(--tp-half) * 2 + var(--tp-gap))");
    expect(vars).toContain("--tp-rest:calc(var(--tp-tall) - var(--tp-row) - var(--tp-gap))");
    expect(vars).toMatch(/--tp-half:\d+px/);
    expect(vars).toMatch(/--tp-row:\d+px/);
    for (const [size, v] of [["half", "--tp-half"], ["tall", "--tp-tall"], ["row", "--tp-row"], ["rest", "--tp-rest"]]) {
      expect(rules(`.cnpy-tagpage-tile[data-size="${size}"]`), size).toBe(` height:var(${v}); `);
    }
    expect(rules(".cnpy-tagpage-tile")).toContain("overflow:hidden");
    expect(rules(".cnpy-tagpage-body")).toMatch(/flex:1 1 0;.*min-height:0;.*overflow-y:auto/);
    expect(rules(".cnpy-tagpage-grid")).toContain("gap:var(--tp-gap)");
    expect(rules(".cnpy-tagpage-grid")).toContain("align-items:start");   // a tile is never stretched to its row
    // Nothing on the page lets a tile take its content's height.
    const block = css.slice(css.indexOf("/* One tag's page (web/src/tags.ts tagPageView)"), css.indexOf("@container tagpage (max-width:1000px)"));
    expect(block).not.toMatch(/\.cnpy-tagpage-tile[^{]*\{[^}]*(min-height|max-height|height:auto)/);
  });

  it("the tab picked is the tab shown — every tab the bar offers, an empty type too (Decisions used to snap back to All)", () => {
    const p = page({ tag: tag("auth", { color: "plum", counts: { feed: 2, doc: 1, adr: 0 } }), items: { ...page().items, adr: [] } });
    const offered = [...view(p).matchAll(/data-act="tagPageTab" data-arg="([a-z]+)"/g)].map((m) => m[1]);
    expect(offered).toEqual(expect.arrayContaining(["feed", "doc", "adr"]));
    for (const t of offered) {
      expect(isTagPageTab(t)).toBe(true);
      expect(shownTab(view(p, t as TagPageTab))).toEqual({ picked: t, panel: t });
    }
    const decisions = view(p, "adr");
    expect(decisions).toContain(`data-tag-group="adr"`);
    expect(decisions).toContain("No decisions are tagged auth yet");
    expect(decisions).toMatch(/data-size="tall" data-tag-group="adr"/);   // the empty list keeps the list's box
    expect(decisions).not.toContain(`data-tag-group="feed"`);
  });

  it("a type's tab shows that type alone, beside a rail of its own activity and people; an empty tag, a missing tag, a loading and a failed read each say so", () => {
    const feedOnly = view(page(), "feed");
    expect(feedOnly).toContain(`data-tag-group="feed"`);
    expect(feedOnly).not.toContain(`data-tag-group="doc"`);
    expect(feedOnly).not.toContain("Often seen with");
    expect(feedOnly).toMatch(/style="--span:8;--md:12" data-size="tall" data-tag-group="feed"/);
    expect(feedOnly).toMatch(/data-size="row" data-tag-tile="activity"/);
    expect(feedOnly).toMatch(/data-size="rest" data-tag-tile="people"/);
    expect(feedOnly).toContain(`data-tag-tile="activity"`);
    expect(feedOnly).toContain("<b>@devon</b>");   // this type's people, from its own items
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
    expect(off).toContain("Off: nothing is sent.");
    // What is sent: one sentence in a small popover from "What is sent" — closed until clicked.
    expect(off).toContain(`data-act="tagAiInfo" data-field="tagAiInfo" aria-expanded="false" aria-haspopup="dialog"`);
    expect(off).not.toContain("org-tags-ai-info");
    const openTab = tab("admin", list({ ai: ai({ enabled: false }) }), { aiInfo: true });
    const sentence = openTab.slice(openTab.indexOf(`id="org-tags-ai-info"`), openTab.indexOf("</p>", openTab.indexOf(`id="org-tags-ai-info"`)));
    expect(sentence).toContain(`role="dialog" aria-label="What is sent"`);
    expect(openTab).toContain(`data-act="tagAiInfoClose"`);
    expect(sentence).toContain("Jev, TypeSafe AI&#39;s model, gets the tag&#39;s name and description, and the title and first 400 characters of each item that may fit, with code removed.".replace(/&#39;/g, "'"));
    expect(sentence).toContain("It adds the tag where it fits. You can undo a run or take the tag off any item.");
    expect(sentence).not.toContain("until you accept");
    expect(aiSection(ai(), initialTagsUi())).toContain(`role="meter" aria-label="Checks used this month" aria-valuemin="0" aria-valuemax="300" aria-valuenow="12"`);
    expect(aiSection(ai(), initialTagsUi())).toContain("12 of 300 checks used this month.");
    expect(aiSection(ai({ spent: true, used: 300 }), initialTagsUi())).toContain("This month&#39;s checks are used up");
    const nokey = aiSection(ai({ available: false, enabled: false }), initialTagsUi());
    expect(nokey).toContain("no TypeSafe AI key set, so nothing is sent and nothing is tagged");
    expect(nokey).toMatch(/role="switch"[^>]*disabled|disabled[^>]*role="switch"/);
  });

  it("after a run the row's Jev cell says what it did: \"7 added\" with Undo (confirmModal); none fit; nothing to check; undone; stopped", () => {
    const u = initialTagsUi();
    const added = jevCell(t("onboarding"), run(), u);
    expect(added).toContain(">7 added<");
    expect(added).toContain(`title="Added to 7 items."`);
    expect(added).toContain(`data-act="tagConfirm" data-arg="undoRun:onboarding"`);
    expect(added).not.toMatch(/Accept|Dismiss|may fit/);
    expect(jevCell(t("x"), run({ added: 0 }), u)).toContain(`title="Checked 20 — none fit.">None fit<`);
    expect(jevCell(t("x"), run({ added: 0, candidates: 0, checked: 0 }), u)).toContain(">Nothing to check<");
    const undone = jevCell(t("x"), run({ undone_at: "t" }), u);
    expect(undone).toContain(`title="Undone: the 7 items this run tagged no longer have it.">Undone<`);
    expect(undone).not.toContain("undoRun");
    expect(jevCell(t("x"), run({ status: "capped", checked: 9, added: 2 }), u)).toContain(`title="Stopped at 9 of 20: this month&#39;s checks are used up. Added to 2 items.">Stopped · 2 added<`);
    expect(jevCell(t("x"), run({ status: "running" }), u)).toContain(">Starting…<");
    expect(jevCell(t("x"), run({ status: "running" }), u)).not.toContain("undoRun");
    expect(jevCell(t("x"), undefined, u)).toContain(`data-state="idle"`);
    expect(jevCell(tag("old", { retired: true }), run(), u)).toBe(`<div data-col="jev"></div>`);
  });

  it("Find items sits on the row while the switch is on; it waits while a run goes; off or used up, it is not there", () => {
    expect(piece(tab("admin", list({ ai: ai() })), `data-org-tag="onboarding"`)).toMatch(/data-act="tagFind" data-arg="onboarding"(?![^>]*disabled)/);
    expect(piece(tab("admin", list({ ai: ai(), runs: { onboarding: run({ status: "running" }) } })), `data-org-tag="onboarding"`)).toMatch(/data-act="tagFind" data-arg="onboarding"[^>]* disabled/);
    expect(tab("admin", list({ ai: ai({ enabled: false }) }))).not.toContain(`data-act="tagFind"`);
    expect(tab("admin", list({ ai: ai({ spent: true }) }))).not.toContain(`data-act="tagFind"`);
    expect(tab("admin", list({ ai: ai() }))).toMatch(/--tagcols:minmax\(0, 176px\) minmax\(0, 1fr\) 44px 150px 116px;/);
    // The switch never moves a column: the same template on or off, and the checks meter keeps its place.
    expect(tab("admin", list({ ai: ai({ enabled: false }) }))).toMatch(/--tagcols:minmax\(0, 176px\) minmax\(0, 1fr\) 44px 150px 116px;/);
    expect(aiSection(ai({ enabled: false }), initialTagsUi())).toContain(`class="cnpy-tagshead-meterwrap" data-off="1"`);
  });

  it("Undo asks first, and says exactly what it takes back", () => {
    const m = tagConfirmModal({ what: "undoRun", name: "onboarding", busy: false }, list({ runs: { onboarding: run() } }));
    expect(m).toContain("Undo the last run for onboarding?");
    expect(m).toContain("onboarding comes off the 7 items that run tagged. Nothing else changes, and Trov will not add it to them again.");
    expect(m).toContain(`data-act="tagConfirmGo"`);
  });

  it("in the tab: each row's Jev cell under an \"Added by Jev\" head; a member sees none of it", () => {
    const html = tab("admin", list({ ai: ai(), runs: { onboarding: run(), auth: run({ status: "running" }) } }));
    expect(html).toContain(`data-org-group="tag-ai"`);
    expect(html).toContain(`<div data-col="jev">Added by Jev</div>`);
    expect(piece(html, `data-org-tag="onboarding"`)).toContain(">7 added<");
    expect(piece(html, `data-org-tag="auth"`)).toContain(">Starting…<");
    const member = tab("member", list({ ai: ai(), runs: { onboarding: run() } }));
    expect(member).not.toContain("tag-ai");
    expect(member).not.toContain("data-fitrun");
    expect(member).not.toContain("Added by Jev");
    noPill(html);
  });
});
