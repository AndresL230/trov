// The organization's tag list on screen (0054_org_tags; docs/architecture/web-ui.md › Tags):
//   • `tagsTab`      — Org settings › Tags: what agents suggested (admins), the add row, the list.
//   • `tagPageView`  — one tag's page (`#tags/<name>`): everything that carries it, by type.
//   • `itemTagsRow`  — the Tags row on an item's own page (a doc): its tags and the picker.
// Pure: props in, markup out. Every act starts with `tag` and lands in web/src/tags-actions.ts.
//
// How a tag is DRAWN is not decided here: `tagMark` (the square and the word) and `tagWords` (plain
// words in a list) in marks.ts are the one place.
import {
  TAG_COLORS, TAG_DESCRIPTION_MAX, TAG_ITEM_LABEL, TAG_ITEM_TYPES, TAG_NAME_MAX, normalizeTagName,
  type OrgTagDTO, type TagColor, type TagCounts, type TagItemType, type TagListDTO, type TagPageDTO, type TagPageItem, type TagRef, type TagSuggestionDTO,
} from "@shared/tags-core";
import type { MyOrg } from "@shared/orgs";
import { esc, attr, relTime, surface } from "./ui";
import { O_FIELD, O_HELP, O_ERR, accentBtn, quietBtn, dangerLink, orgHead, orgEmpty, tabLead, sliceNote, roleAtLeast, loadingNote, failedNote, type OrgSlice } from "./org-ui";
import { tagMark, tagSquare, tagWords } from "./marks";
import { segmented } from "./segmented";
import { tabBar, tabPanelAttrs } from "./tabs";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { confirmModal } from "./confirm";

// ── state ────────────────────────────────────────────────────────────────────

export interface TagEdit { name: string; nameDraft: string; descDraft: string; color: TagColor; saving: boolean; error: string | null }
/** The open confirmation: retire `name`, merge `name` into `into`, or dismiss the suggestion `name`. */
export interface TagConfirm { what: "retire" | "merge" | "dismiss"; name: string; into?: string; busy: boolean }
export type TagPageTab = "all" | TagItemType;
export const TAG_PAGE_TABS: readonly TagPageTab[] = ["all", ...TAG_ITEM_TYPES];
export const isTagPageTab = (v: unknown): v is TagPageTab => typeof v === "string" && (TAG_PAGE_TABS as readonly string[]).includes(v);

/** Everything the tag screens keep in AppState (`state.tagsUi`). */
export interface TagsUi {
  nameDraft: string;
  descDraft: string;
  addBusy: boolean;
  addError: string | null;
  /** The tag being edited in place (its row shows the editor). */
  edit: TagEdit | null;
  /** The tag or suggestion a write is out for (its buttons wait). */
  busy: string | null;
  confirm: TagConfirm | null;
  showRetired: boolean;
  pageTab: TagPageTab;
  /** A doc's tags are being written. */
  itemBusy: boolean;
}
export const initialTagsUi = (): TagsUi => ({
  nameDraft: "", descDraft: "", addBusy: false, addError: null, edit: null, busy: null, confirm: null, showRetired: false, pageTab: "all", itemBusy: false,
});

/** Can this draft be added? A name that normalizes, not already on the list. */
export function tagDraftProblem(draft: string, tags: readonly Pick<OrgTagDTO, "name" | "retired">[]): string | null {
  if (!draft.trim()) return "";
  const name = normalizeTagName(draft);
  if (!name) return `A tag is up to ${TAG_NAME_MAX} lowercase letters, digits and hyphens.`;
  const held = tags.find((t) => t.name === name);
  if (held) return held.retired ? `“${name}” is retired. Restore it from the retired tags below.` : `“${name}” is already on the list.`;
  return null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const total = (c: TagCounts): number => TAG_ITEM_TYPES.reduce((n, t) => n + c[t], 0);
/** "4 feed entries and 1 doc" — the types that have any. */
export function countsPhrase(c: TagCounts): string {
  const parts = TAG_ITEM_TYPES.filter((t) => c[t] > 0).map((t) => plural(c[t], TAG_ITEM_LABEL[t].one, TAG_ITEM_LABEL[t].many));
  if (parts.length === 0) return "nothing yet";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ── Org settings › Tags ──────────────────────────────────────────────────────

export interface TagsTabProps {
  list: OrgSlice<TagListDTO | null>;
  ui: TagsUi;
  dd?: DropdownUi;
}

const liveOf = (list: TagListDTO | null): OrgTagDTO[] => (list ? list.tags.filter((t) => !t.retired) : []);
const mergeId = (name: string): string => `tag-merge:${name}`;
const mapId = (name: string): string => `tag-map:${name}`;

/** Every dropdown of the tab: a row's "Merge into", a suggestion's "Use an existing tag". The SAME
 *  list renders the triggers and (through Org settings' overlays) the open one's menu. */
export function tagsDropdowns(list: TagListDTO | null, ui: TagsUi): DropdownProps[] {
  if (!list) return [];
  const live = liveOf(list);
  const targets = (but: string) => live.filter((t) => t.name !== but).map((t) => ({ value: t.name, label: t.name, hint: t.description || undefined }));
  return [
    ...list.suggestions.map((s): DropdownProps => ({
      id: mapId(s.name), act: "tagSugMapPick", arg: s.name, value: "", size: "sm", disabled: ui.busy === s.name || live.length === 0,
      ariaLabel: `Give the items that carried ${s.name} an existing tag`,
      options: [{ value: "", label: "Use an existing tag" }, ...targets("")],
    })),
    ...list.tags.filter((t) => !t.retired && !t.starter).map((t): DropdownProps => ({
      id: mergeId(t.name), act: "tagMergePick", arg: t.name, value: "", size: "sm", disabled: ui.busy === t.name || live.length < 2,
      ariaLabel: `Merge ${t.name} into another tag`,
      options: [{ value: "", label: "Merge into…" }, ...targets(t.name)],
    })),
  ];
}

function suggestionRow(s: TagSuggestionDTO, ui: TagsUi, dds: DropdownProps[], dd: DropdownUi): string {
  const busy = ui.busy === s.name;
  const who = s.by.length ? `, first by @${esc(s.by[0])}${s.by.length > 1 ? ` and ${plural(s.by.length - 1, "other", "others")}` : ""}` : "";
  const map = dds.find((d) => d.id === mapId(s.name));
  const like = s.similar ? ` Looks like <strong style="font-weight:600;color:var(--fg)">${esc(s.similar)}</strong>, which is already on the list.` : "";
  return `<li class="cnpy-tagsug" data-tag-suggestion="${attr(s.name)}">
      <div style="min-width:0">
        <div style="font-size:13.5px;font-weight:600;color:var(--fg);overflow-wrap:anywhere">${esc(s.name)}</div>
        <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:3px">Sent on ${esc(countsPhrase(s.counts))}${who}. ${s.uses === 1 ? "That item is" : "Those items are"} saved without it until you decide.${like}</div>
      </div>
      <div class="cnpy-tagsug-acts">
        ${s.similar
          ? `${accentBtn(`Use ${s.similar}`, "tagSugUse", { arg: `${s.name}>${s.similar}`, disabled: busy, busy })}${quietBtn("Add as its own tag", "tagSugAccept", { arg: s.name, disabled: busy })}`
          : accentBtn(busy ? "Adding…" : "Add to the list", "tagSugAccept", { arg: s.name, disabled: busy, busy })}
        ${map ? dropdown(map, dd) : ""}
        ${dangerLink("Dismiss", "tagConfirm", { arg: `dismiss:${s.name}`, disabled: busy, label: `Dismiss the suggestion ${s.name}`, field: `tagConfirm:dismiss:${s.name}` })}
      </div>
    </li>`;
}

/** The colour switch of the editor: `segmented()` whose options are the squares themselves. */
function colorSwitch(value: TagColor): string {
  return segmented({
    id: "tag-color", ariaLabel: "Colour", value, act: "tagEditColor", size: "sm",
    options: TAG_COLORS.map((c) => ({ value: c, label: "", icon: `<span role="img" aria-label="${c}" style="display:grid;place-items:center;width:14px;height:14px">${tagSquare(c, 10)}</span>`, title: c[0].toUpperCase() + c.slice(1) })),
  });
}

function editor(e: TagEdit): string {
  const nameBad = e.nameDraft.trim() !== "" && normalizeTagName(e.nameDraft) === null;
  return `<div class="cnpy-tagedit" data-tag-edit="${attr(e.name)}">
      <div class="cnpy-tagedit-fields">
        <label style="display:block;min-width:0"><span style="display:block;font-size:12px;font-weight:500;color:var(--fg-55);margin-bottom:5px">Name</span>
          <input id="tag-edit-name" data-act="tagEditName" data-field="tagEditName" data-enter="tagEditSave" value="${attr(e.nameDraft)}" maxlength="${TAG_NAME_MAX}" autocomplete="off" autocapitalize="off" spellcheck="false"${nameBad ? ' aria-invalid="true"' : ""} class="cnpy-input" style="${O_FIELD};height:32px;font-size:13px" /></label>
        <label style="display:block;min-width:0"><span style="display:block;font-size:12px;font-weight:500;color:var(--fg-55);margin-bottom:5px">What it is for</span>
          <input id="tag-edit-desc" data-act="tagEditDesc" data-field="tagEditDesc" data-enter="tagEditSave" value="${attr(e.descDraft)}" maxlength="${TAG_DESCRIPTION_MAX}" autocomplete="off" class="cnpy-input" style="${O_FIELD};height:32px;font-size:13px" /></label>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px">
        <span id="tag-color-l" style="font-size:12px;font-weight:500;color:var(--fg-55)">Colour</span>${colorSwitch(e.color)}
      </div>
      <div style="${O_HELP}">Renaming keeps the tag on everything that has it.</div>
      <div role="alert" style="${O_ERR}"${e.error ? "" : " hidden"}>${esc(e.error ?? "")}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        ${accentBtn(e.saving ? "Saving…" : "Save", "tagEditSave", { disabled: e.saving || nameBad || !e.nameDraft.trim(), busy: e.saving })}
        ${quietBtn("Cancel", "tagEditCancel", { disabled: e.saving })}
      </div>
    </div>`;
}

const num = (n: number): string => (n > 0 ? String(n) : "—");

function tagRow(t: OrgTagDTO, admin: boolean, ui: TagsUi, dds: DropdownProps[], dd: DropdownUi): string {
  const editing = ui.edit?.name === t.name ? ui.edit : null;
  const busy = ui.busy === t.name;
  const merge = dds.find((d) => d.id === mergeId(t.name));
  const acts = !admin ? ""
    : t.retired ? quietBtn(busy ? "Restoring…" : "Restore", "tagRestore", { arg: t.name, disabled: busy, busy, label: `Restore ${t.name}` })
    : `${quietBtn(t.starter ? "Rename" : "Edit", "tagEdit", { arg: t.name, disabled: busy || !!editing, label: `${t.starter ? "Rename" : "Edit"} ${t.name}`, field: `tagEdit:${t.name}` })}${
        t.starter ? "" : `${merge ? dropdown(merge, dd) : ""}${dangerLink("Retire", "tagConfirm", { arg: `retire:${t.name}`, disabled: busy, label: `Retire ${t.name}`, field: `tagConfirm:retire:${t.name}` })}`}`;
  const small = TAG_ITEM_TYPES.filter((k) => t.counts[k] > 0).map((k) => plural(t.counts[k], TAG_ITEM_LABEL[k].one, TAG_ITEM_LABEL[k].many)).join(" · ");
  return `<li class="cnpy-tagrow-wrap" data-org-tag="${attr(t.name)}"${t.retired ? ' data-retired="1"' : ""}${t.starter ? ' data-starter="1"' : ""}>
      <div class="cnpy-tagrow">
        <div data-col="tag" style="min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${tagMark(t, { size: 13.5, retired: t.retired })}${t.starter ? `<span style="font-size:12px;color:var(--fg-40);white-space:nowrap">Starter tag</span>` : ""}${t.retired ? `<span style="font-size:12px;color:var(--fg-40);white-space:nowrap">Retired</span>` : ""}</div>
        <div data-col="desc" style="min-width:0;font-size:13px;color:var(--fg-55);overflow-wrap:anywhere">${t.description ? esc(t.description) : `<span style="color:var(--fg-40)">No description</span>`}</div>
        ${TAG_ITEM_TYPES.map((k) => `<div data-col="n" data-n="${k}" title="${attr(plural(t.counts[k], TAG_ITEM_LABEL[k].one, TAG_ITEM_LABEL[k].many))}" style="font-size:13px;color:${t.counts[k] ? "var(--fg-70)" : "var(--fg-40)"};font-variant-numeric:tabular-nums;text-align:right">${num(t.counts[k])}</div>`).join("")}
        <div data-col="small" style="font-size:12px;color:var(--fg-40)">${small ? esc(small) : "Not used yet"}</div>
        <div data-col="acts" class="cnpy-tagrow-acts">${acts}</div>
      </div>
      ${editing ? editor(editing) : ""}
    </li>`;
}

/** Org settings › Tags. Any member reads the list; an admin changes it and settles suggestions. */
export function tagsTab(org: MyOrg, p: TagsTabProps): string {
  const admin = roleAtLeast(org.role, "admin");
  const dd = p.dd ?? initialDropdownUi();
  const note = sliceNote(p.list, "tags", p.list.data !== null, { rows: 6, trail: 96 });
  if (note) return note;
  const list = p.list.data;
  if (!list) return loadingNote("tags", { rows: 6, trail: 96 });
  const ui = p.ui;
  const dds = tagsDropdowns(list, ui);
  const live = list.tags.filter((t) => !t.retired);
  const retired = list.tags.filter((t) => t.retired);
  const full = list.cap !== null && list.used >= list.cap;
  const of = list.cap === null ? `<strong>${list.used}</strong> ${list.used === 1 ? "tag" : "tags"}` : `<strong>${list.used}</strong> of ${list.cap} tags`;
  const lead = tabLead(`${of}. One list for everything in ${esc(org.name)}: the same tag finds a feed entry, a doc and a decision. ${admin
    ? "Agents pick from it and can suggest a new one, which waits here until you decide."
    : "Agents pick from it. An admin or an owner decides what is on it."}`);

  const suggestions = admin && list.suggestions.length ? `<section aria-labelledby="org-tags-sug" data-org-group="tag-suggestions" style="margin-bottom:26px">
      ${orgHead("Suggested by agents", "", list.suggestions.length, "org-tags-sug")}
      <ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${list.suggestions.map((s) => suggestionRow(s, ui, dds, dd)).join("")}</ul>
    </section>` : "";

  const problem = tagDraftProblem(ui.nameDraft, list.tags);
  const addErr = ui.addError ?? (problem || null);
  const add = admin ? `<div class="cnpy-tagadd" data-org-tag-add>
      <input id="org-tag-name" data-act="tagNameDraft" data-field="tagName" data-enter="tagAdd" value="${attr(ui.nameDraft)}" maxlength="${TAG_NAME_MAX}" placeholder="New tag name" aria-label="New tag name" autocomplete="off" autocapitalize="off" spellcheck="false"${addErr ? ' aria-invalid="true" aria-describedby="org-tag-e"' : ""} class="cnpy-input" style="${O_FIELD};height:32px;font-size:13px" />
      <input id="org-tag-desc" data-act="tagDescDraft" data-field="tagDesc" data-enter="tagAdd" value="${attr(ui.descDraft)}" maxlength="${TAG_DESCRIPTION_MAX}" placeholder="What it is for (one line)" aria-label="What the new tag is for" autocomplete="off" class="cnpy-input" style="${O_FIELD};height:32px;font-size:13px" />
      ${accentBtn(ui.addBusy ? "Adding…" : "Add tag", "tagAdd", { disabled: ui.addBusy || full || problem !== null, busy: ui.addBusy, title: full ? "The list is full on this plan" : undefined })}
    </div>
    <div id="org-tag-e" role="alert" style="${O_ERR};margin:8px 0 0"${addErr ? "" : " hidden"}>${esc(addErr ?? "")}</div>
    <div style="${O_HELP};margin-bottom:16px"${full && !addErr ? "" : " hidden"} data-org-tag-full>The list holds ${list.cap ?? 0} tags on this plan. Retire or merge one to add another.</div>` : "";

  const head = `<div class="cnpy-tagrow cnpy-taghead" aria-hidden="true">
      <div data-col="tag">Tag</div><div data-col="desc">What it is for</div>
      ${TAG_ITEM_TYPES.map((k) => `<div data-col="n" style="text-align:right">${k === "feed" ? "Feed" : k === "doc" ? "Docs" : "Decisions"}</div>`).join("")}
      <div data-col="small"></div><div data-col="acts"></div>
    </div>`;
  const rows = (ts: OrgTagDTO[]) => ts.map((t) => tagRow(t, admin, ui, dds, dd)).join("");
  const retiredBlock = retired.length ? `<div style="margin-top:18px" data-org-tags-retired>
      <button type="button" data-act="tagShowRetired" data-field="tagShowRetired" aria-expanded="${ui.showRetired}" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:6px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="transform:${ui.showRetired ? "rotate(90deg)" : "none"};transition:transform .15s ease"><path d="M9 6l6 6-6 6"></path></svg>${plural(retired.length, "retired tag", "retired tags")}</button>
      <ul${surface("overflow:hidden;list-style:none;margin:8px 0 0;padding:0")}${ui.showRetired ? "" : " hidden"}>${rows(retired)}</ul>
    </div>` : "";

  return `${lead}${suggestions}
    <section aria-labelledby="org-tags-list" data-org-group="tags">
      ${orgHead("Tags", "", null, "org-tags-list")}
      ${add}
      <ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${head}${rows(live)}</ul>
      ${retiredBlock}
      <p style="${O_HELP};max-width:680px;margin-top:14px">The six starter tags come with every organization and can be renamed, not removed. A retired tag stays on what already has it and can no longer be picked.</p>
    </section>`;
}

/** The tab's confirmation modal, or "". */
export function tagConfirmModal(c: TagConfirm | null, list: TagListDTO | null): string {
  if (!c) return "";
  const t = list?.tags.find((x) => x.name === c.name);
  const n = t ? total(t.counts) : 0;
  const copy = c.what === "retire" ? {
      title: `Retire ${c.name}?`,
      body: `${n ? `It stays on the ${plural(n, "item", "items")} that ${n === 1 ? "has" : "have"} it` : "Nothing has it yet"}, and nobody can pick it any more: an agent that sends it gets a suggestion instead. You can restore it later.`,
      confirmLabel: "Retire tag", busyLabel: "Retiring…",
    } : c.what === "merge" ? {
      title: `Merge ${c.name} into ${c.into ?? ""}?`,
      body: `${n ? `The ${plural(n, "item", "items")} tagged ${c.name} ${n === 1 ? "is" : "are"} tagged ${c.into ?? ""} instead` : `Nothing is tagged ${c.name} yet`}, and ${c.name} leaves the list. An agent that still sends ${c.name} gets ${c.into ?? ""}. Items cannot be moved back in one step.`,
      confirmLabel: "Merge tags", busyLabel: "Merging…",
    } : {
      title: `Dismiss ${c.name}?`,
      body: `The items that carried it stay as they are, without it. If an agent sends ${c.name} again, it is suggested again.`,
      confirmLabel: "Dismiss", busyLabel: "Dismissing…",
    };
  return confirmModal({ id: "tag-confirm", ...copy, confirmAct: "tagConfirmGo", cancelAct: "tagConfirmCancel", busy: c.busy, ...(c.what === "dismiss" ? { tone: "neutral" as const } : {}) });
}

// ── one tag's page ───────────────────────────────────────────────────────────

export interface TagPageProps {
  name: string | null;
  page: OrgSlice<TagPageDTO | null>;
  tab: TagPageTab;
  orgName: string;
  /** A person's handle as the app draws it (a link to their card). */
  who: (handle: string) => string;
}

const ITEM_ACT: Record<TagItemType, string> = { feed: "goFeed", doc: "openDocFrom", adr: "tagOpenDecision" };
const KIND_WORD: Record<TagItemType, string> = { feed: "Feed", doc: "Doc", adr: "Decision" };
const GROUP_TITLE: Record<TagItemType, string> = { doc: "Docs", adr: "Decisions", feed: "Recent in the feed" };

function pageItem(it: TagPageItem, who: TagPageProps["who"]): string {
  const meta = [
    it.type === "feed" ? "" : esc(it.type === "adr" ? (it.note === "ratified" ? "Ratified" : "Draft") : it.note ?? ""),
    it.by ? who(it.by) : "",
    it.at ? `<span style="white-space:nowrap">${esc(relTime(it.at))}</span>` : "",
    tagWords(it.tags),
  ].filter(Boolean).join(`<span aria-hidden="true">·</span>`);
  return `<li class="cnpy-tagitem" data-tag-item="${it.type}:${attr(it.id)}">
      <button type="button" data-act="${ITEM_ACT[it.type]}" data-arg="${attr(it.type === "adr" ? it.title : it.id)}" class="cnpy-tagitem-t">${esc(it.title)}</button>
      ${it.type === "feed" && it.note ? `<div style="font-size:13px;line-height:1.55;color:var(--fg-55);margin-top:3px;overflow-wrap:anywhere">${esc(it.note)}</div>` : ""}
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:5px;font-size:12px;color:var(--fg-40)"><span style="color:var(--fg-55)">${KIND_WORD[it.type]}</span><span aria-hidden="true">·</span>${meta}</div>
    </li>`;
}

/** `#tags/<name>`: the tag (square, name, what it is for), a tab per type, and the items. */
export function tagPageView(p: TagPageProps): string {
  const shell = (inner: string) => `<div data-screen-label="Tag" class="cnpy-org cnpy-tagpage" style="width:100%;max-width:1040px;margin:0 auto;padding:22px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box">${inner}</div>`;
  if (p.page.status === "error") return shell(failedNote("this tag", "tagPageReload"));
  if (!p.page.data) {
    if (p.page.status === "ok") return shell(orgEmpty("No such tag", `${p.name ? `“${p.name}” is not one of ${p.orgName}'s tags.` : "That tag does not exist."} The list is in Org settings › Tags.`, quietBtn("Open the tag list", "tagsGo")));
    return shell(loadingNote("this tag", { rows: 5 }));
  }
  const { tag, items, seen_with, authors } = p.page.data;
  const sum = total(tag.counts);
  const tab = p.tab !== "all" && tag.counts[p.tab] === 0 ? "all" : p.tab;
  const head = `<header style="margin-bottom:18px">
      <h2 style="display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600;letter-spacing:-0.015em;margin:0">${tagSquare(tag.color, 12)}<span style="overflow-wrap:anywhere">${esc(tag.name)}</span>${tag.retired ? `<span style="font-size:13px;font-weight:400;color:var(--fg-40)">Retired</span>` : ""}</h2>
      <p style="font-size:13.5px;line-height:1.55;color:var(--fg-55);margin:6px 0 0">${tag.description ? `${esc(tag.description)} · ` : ""}${plural(sum, "item", "items")}${tag.retired ? " · It stays on what has it and can no longer be picked." : ""}</p>
    </header>`;
  const bar = tabBar({
    id: "tag-tab", ariaLabel: `What is tagged ${tag.name}`, act: "tagPageTab", value: tab,
    tabs: TAG_PAGE_TABS.map((t) => ({ value: t, label: t === "all" ? "All" : t === "feed" ? "Feed" : t === "doc" ? "Docs" : "Decisions", trail: `<span class="cnpy-badge" data-n="${t === "all" ? sum : tag.counts[t]}">${t === "all" ? sum : tag.counts[t]}</span>` })),
  });
  // What the team knows first (docs, decisions), then what happened (the feed).
  const order: TagItemType[] = ["doc", "adr", "feed"];
  const groups = order.filter((t) => (tab === "all" || tab === t) && items[t].length > 0).map((t) => `<section data-tag-group="${t}" style="margin-top:22px">
      ${orgHead(GROUP_TITLE[t], "", tag.counts[t])}
      <ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${items[t].map((it) => pageItem(it, p.who)).join("")}</ul>
      ${tag.counts[t] > items[t].length ? `<div style="${O_HELP}">Showing the newest ${items[t].length} of ${tag.counts[t]}.</div>` : ""}
    </section>`).join("");
  const empty = groups ? "" : `<div style="margin-top:22px">${orgEmpty("Nothing carries this tag yet", "An agent's feed entry carries it when the session picks it; a person adds it on a doc's page.", "", 3)}</div>`;
  const side = (title: string, rows: string) => rows ? `<section style="margin-top:22px">${orgHead(title)}<div style="display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13px;color:var(--fg-70)">${rows}</div></section>` : "";
  const seen = side("Often seen with", seen_with.map((s) => `<span style="display:inline-flex;align-items:baseline;gap:6px">${tagWords([s.name], { size: 13 })}<span style="color:var(--fg-40);font-variant-numeric:tabular-nums">${s.count}</span></span>`).join(""));
  const writers = side("Who writes about it", authors.map((a) => `<span style="display:inline-flex;align-items:baseline;gap:6px">${p.who(a.handle)}<span style="color:var(--fg-40);font-variant-numeric:tabular-nums">${a.count}</span></span>`).join(""));
  return shell(`${head}${bar}<div${tabPanelAttrs("tag-tab", tab)}>${groups}${empty}${tab === "all" ? `${seen}${writers}` : ""}</div>`);
}

// ── the Tags row on an item's own page ───────────────────────────────────────

export interface ItemTagsProps {
  /** The item's tags, by name. */
  tags: readonly string[];
  /** The org's list (null while it loads: the names show without their colour). */
  list: readonly TagRef[] | null;
  busy: boolean;
  dd?: DropdownUi;
}

/** The picker's dropdown: the live tags the item does not have yet. */
export function itemTagDropdown(p: Pick<ItemTagsProps, "tags" | "list" | "busy">): DropdownProps {
  const free = (p.list ?? []).filter((t) => !t.retired && !p.tags.includes(t.name));
  return {
    id: "item-tag-add", act: "tagItemAdd", value: "", size: "sm", disabled: p.busy || free.length === 0, ariaLabel: "Add a tag",
    options: [{ value: "", label: free.length === 0 && p.list ? "No more tags" : "Add a tag" }, ...free.map((t) => ({ value: t.name, label: t.name, hint: t.description || undefined }))],
  };
}

/** An item's Tags row: each tag as its square and word with a small remove button beside it (no box
 *  round the pair), then the picker — a `dropdown()` of the live tags the item does not have. */
export function itemTagsRow(p: ItemTagsProps): string {
  const byName = new Map((p.list ?? []).map((t) => [t.name, t]));
  const tags = p.tags.map((n) => {
    const t = byName.get(n);
    return `<span class="cnpy-itemtag" data-item-tag="${attr(n)}">${tagMark({ name: n, color: t?.color ?? "slate" }, { size: 12.5, retired: t?.retired })}<button type="button" data-act="tagItemRemove" data-arg="${attr(n)}" aria-label="Remove the tag ${attr(n)}" title="Remove"${p.busy ? " disabled" : ""} class="cnpy-itemtag-x"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></span>`;
  }).join("");
  return `<div class="cnpy-itemtags" data-item-tags>
      <span style="font-size:12.5px;font-weight:500;color:var(--fg-55);flex:none">Tags</span>
      ${tags}${dropdown(itemTagDropdown(p), p.dd ?? initialDropdownUi())}
    </div>`;
}
