// The organization's tag list on screen (0056_org_tags; docs/architecture/web-ui.md › Tags):
//   • `tagsTab`      — Org settings › Tags: what agents suggested (admins), the add row, the list.
//   • `tagPageView`  — one tag's page (`#tags/<name>`): everything that carries it, by type.
//   • `itemTagsRow`  — the Tags row on an item's own page (a doc): its tags and the picker.
// Pure: props in, markup out. Every act starts with `tag` and lands in web/src/tags-actions.ts.
//
// How a tag is DRAWN is not decided here: `tagMark` (the square and the word) and `tagWords` (plain
// words in a list) in marks.ts are the one place.
import {
  TAG_COLORS, TAG_DESCRIPTION_MAX, TAG_ITEM_LABEL, TAG_ITEM_TYPES, TAG_NAME_MAX, TAG_PAGE_LIMIT, normalizeTagName,
  type OrgTagDTO, type TagColor, type TagCounts, type TagItemType, type TagListDTO, type TagPageDTO, type TagPageItem, type TagRef, type TagSuggestionDTO,
  type TagAiDTO, type TagRunDTO,
} from "@shared/tags-core";
import { switchBtn } from "./notifications";
import { fitCell, type LiveRun } from "./fit-run";
import type { MyOrg } from "@shared/orgs";
import { esc, attr, relTime, surface, ASIDE_ARROW, WORK_SHELL } from "./ui";
import { O_FIELD, O_HELP, O_ERR, accentBtn, quietBtn, dangerLink, orgHead, orgEmpty, tabLead, sliceNote, roleAtLeast, loadingNote, failedNote, type OrgSlice } from "./org-ui";
import { tagMark, tagSquare, tagWords, tagTone, kindMark, authorityMark } from "./marks";
import { segmented } from "./segmented";
import { tabBar, tabPanelAttrs } from "./tabs";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { confirmModal } from "./confirm";

// ── state ────────────────────────────────────────────────────────────────────

/** A tag being edited IN PLACE in its row: its name (from the ⋯ menu's Rename) or what it is for (a click on it). */
export interface TagEdit { name: string; field: "name" | "desc"; nameDraft: string; descDraft: string; color: TagColor; saving: boolean; error: string | null }
/** The open confirmation: retire `name`, merge `name` into `into`, or dismiss the suggestion `name`. */
/** `rerun`: after a tag's name or description changed, offer Find items again (`changed` says which). */
export interface TagConfirm { what: "retire" | "merge" | "dismiss" | "undoRun" | "rerun"; name: string; into?: string; changed?: "name" | "desc"; busy: boolean }
/** `review`: what Sift suggested (60–85% sure) and nobody settled — a tab only while there is any. */
export type TagPageTab = "all" | TagItemType | "review";
export const TAG_PAGE_TABS: readonly TagPageTab[] = ["all", ...TAG_ITEM_TYPES, "review"];
export const isTagPageTab = (v: unknown): v is TagPageTab => typeof v === "string" && (TAG_PAGE_TABS as readonly string[]).includes(v);

/** Everything the tag screens keep in AppState (`state.tagsUi`). */
export interface TagsUi {
  nameDraft: string;
  descDraft: string;
  addBusy: boolean;
  addError: string | null;
  /** The New tag modal is open, with the colour and the "find items now" choice it holds. */
  addOpen: boolean;
  addColor: TagColor;
  addScan: boolean;
  /** The tag being edited in place (its row shows the editor). */
  edit: TagEdit | null;
  /** The tag or suggestion a write is out for (its buttons wait). */
  busy: string | null;
  confirm: TagConfirm | null;
  showRetired: boolean;
  pageTab: TagPageTab;
  /** A doc's tags are being written. */
  itemBusy: boolean;
  /** The AI switch is being written. */
  aiBusy: boolean;
  /** Runs drawn live, by tag (web/src/fit-run.ts): from Find items / a new tag until the list has its result. */
  live: Record<string, LiveRun>;
  /** The tag whose row's ⋯ menu (Edit, Merge into…, Retire) is open. */
  menu: string | null;
  /** The open menu shows the tags to merge into, instead of its actions. */
  menuMerge: boolean;
  /** The tag whose colour picker (its square, clicked) is open. */
  colorOpen: string | null;
  /** The "What is sent" popover by the Jev switch is open. */
  aiInfo: boolean;
}
export const initialTagsUi = (): TagsUi => ({
  nameDraft: "", descDraft: "", addBusy: false, addError: null, addOpen: false, addColor: "moss", addScan: true, edit: null, busy: null, confirm: null, showRetired: false, pageTab: "all", itemBusy: false,
  aiBusy: false, live: {}, menu: null, menuMerge: false, colorOpen: null, aiInfo: false,
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
const mapId = (name: string): string => `tag-map:${name}`;

/** A row's colour picker, opened by clicking its square: a `segmented()` whose options are the squares. A pick
 *  saves at once. */
function colorSwitch(t: OrgTagDTO): string {
  return segmented({
    id: `tag-color:${t.name}`, ariaLabel: `Colour of ${t.name}`, value: t.color, act: "tagColorPick", size: "sm",
    options: TAG_COLORS.map((c) => ({ value: c, label: "", icon: `<span role="img" aria-label="${c}" style="display:grid;place-items:center;width:14px;height:14px">${tagSquare(c, 10)}</span>`, title: c[0].toUpperCase() + c.slice(1) })),
  });
}

/** The field that takes a cell's place while it is edited in place: Enter or leaving it saves, Escape puts the
 *  words back (web/src/tags-actions.ts). Same height as the words it replaces, so the row does not move. */
function inlineField(e: TagEdit): string {
  const name = e.field === "name";
  const bad = name && e.nameDraft.trim() !== "" && normalizeTagName(e.nameDraft) === null;
  return `<input id="tag-inline" data-tag-inline="${attr(e.name)}" data-act="${name ? "tagEditName" : "tagEditDesc"}" data-field="tagInline" data-enter="tagEditSave"
      value="${attr(name ? e.nameDraft : e.descDraft)}" maxlength="${name ? TAG_NAME_MAX : TAG_DESCRIPTION_MAX}" autocomplete="off"${name ? ' autocapitalize="off" spellcheck="false"' : ""}
      placeholder="${name ? "Tag name" : "What it is for (one line)"}" aria-label="${attr(name ? `New name for ${e.name}` : `What ${e.name} is for`)}"${bad || e.error ? ` aria-invalid="true" title="${attr(e.error ?? "Lowercase letters, digits and hyphens.")}"` : ""}${e.saving ? " readonly" : ""}
      class="cnpy-input cnpy-taginline" style="border-radius:6px" />`;
}

// ── Jev tagging existing items (issues #154–#158; no review step, the owner's call) ──

const meter = (used: number, cap: number | null, label: string): string => cap === null || cap <= 0 ? ""
  : `<div class="cnpy-tagshead-meter" role="meter" aria-label="${attr(label)}" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${Math.min(used, cap)}"${used >= cap ? ' data-full="1"' : ""}><span style="transform:scaleX(${Math.min(1, used / cap).toFixed(4)})"></span></div>`;

/** The Jev cell of the tab's header: the switch, what it does in a few words, and the month's checks. What is
 *  SENT is one plain sentence in a small popover from "What is sent" (`aiInfo`; a click outside or Escape closes it). */
export function aiSection(ai: TagAiDTO, ui: TagsUi): string {
  const checks = ai.cap === null ? `${ai.used.toLocaleString("en-US")} checks used this month.`
    : `${ai.used.toLocaleString("en-US")} of ${ai.cap.toLocaleString("en-US")} checks used this month.`;
  const state = !ai.available ? "This Trov has no TypeSafe AI key set, so nothing is sent and nothing is tagged."
    : !ai.enabled ? "Off: nothing is sent."
    : ai.spent ? "This month's checks are used up: Trov stops looking for items until next month."
    : checks;
  return `<div class="cnpy-tagshead-cell cnpy-tagshead-jev" data-org-group="tag-ai" data-ai="${ai.enabled ? "on" : "off"}">
      <div class="cnpy-tagshead-k" id="org-tags-ai">Sift</div>
      <div class="cnpy-tagshead-jevrow">
        <span style="flex:none">${switchBtn("tagAiToggle", null, ai.enabled).replace("<button ", `<button aria-label="Tag existing items for a new tag"${ui.aiBusy || !ai.available ? " disabled" : ""} `)}</span>
        <span class="cnpy-tagshead-v">${ai.enabled ? "Tags existing items" : "Off"}</span>
      </div>
      <div class="cnpy-tagshead-meterwrap"${ai.enabled && ai.available ? "" : ' data-off="1"'}>${meter(ai.used, ai.cap, "Checks used this month")}</div>
      <div class="cnpy-tagshead-sub"><span data-ai-state>${esc(state)}</span>
        <span class="cnpy-tagshead-pop">
          <button type="button" data-act="tagAiInfo" data-field="tagAiInfo" aria-expanded="${ui.aiInfo}" aria-haspopup="dialog"${ui.aiInfo ? ' aria-controls="org-tags-ai-info"' : ""} class="cnpy-tagfind cnpy-tagshead-more">What is sent</button>
          ${ui.aiInfo ? `<div data-act="tagAiInfoClose" class="cnpy-tagmenu-back"></div>${aiInfo()}` : ""}
        </span></div>
    </div>`;
}

/** The popover: what is sent, to whom, and the way back. */
function aiInfo(): string {
  return `<p id="org-tags-ai-info" role="dialog" aria-label="What is sent" class="cnpy-tagshead-info" style="border-radius:11px">Sift sends the tag's name and description, and the title and first 400 characters of each item that may fit (code removed), to a model from TypeSafe AI. It adds the tag where it is sure, and suggests it where it is less sure, for a person to decide. You can undo a run or take the tag off any item.</p>`;
}

/** Can Jev look for items right now (the switch on, a key set, checks left this month)? */
const canFind = (ai: TagAiDTO | undefined): boolean => !!ai && ai.enabled && ai.available && !ai.spent;

/** A tag row's "Added by Jev" cell: the latest run's result ("7 added", with Undo; "None fit"; why it stopped),
 *  or the run drawn live. The same cell either way (web/src/fit-run.ts `fitCell`), so the row never changes shape. */
export function jevCell(t: OrgTagDTO, last: TagRunDTO | undefined, ui: TagsUi, review = 0): string {
  if (t.retired) return `<div data-col="jev"></div>`;
  const live = ui.live[t.name] ?? null;
  const n = (k: number) => `${k} ${k === 1 ? "item" : "items"}`;
  const undo = !live && last && last.status !== "running" && last.added > 0 && !last.undone_at
    ? `<button type="button" class="cnpy-tagjev-undo" data-act="tagConfirm" data-arg="${attr(`undoRun:${t.name}`)}" data-field="${attr(`tagConfirm:undoRun:${t.name}`)}" aria-haspopup="dialog" aria-label="${attr(`Undo: take ${t.name} off the ${n(last.added)} this run tagged`)}"${ui.busy ? " disabled" : ""}>${ui.busy === `undo:${t.name}` ? "Undoing…" : "Undo"}</button>`
    : "";
  // What Sift only suggested (60–85% sure) and nobody settled: a link to the tag page's To review tab.
  const toReview = !live && review > 0
    ? `<button type="button" class="cnpy-tagjev-undo cnpy-tagjev-review" data-act="tagReviewOpen" data-arg="${attr(t.name)}" aria-label="${attr(`${review} of Sift's suggestions for ${t.name} to review`)}">${review} to review</button>`
    : "";
  return fitCell(t.name, t.color, live, last, undo + toReview);
}

const DOTS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>`;
const menuRow = (inner: string, act: string, arg: string, o: { field?: string; danger?: boolean; label?: string } = {}): string =>
  `<button type="button" role="menuitem" data-act="${act}" data-arg="${attr(arg)}"${o.field ? ` data-field="${attr(o.field)}"` : ""}${o.label ? ` aria-label="${attr(o.label)}"` : ""}${o.danger ? ' aria-haspopup="dialog"' : ""} class="cnpy-menurow cnpy-tagmenu-row"${o.danger ? ' data-danger="1"' : ""} style="border-radius:7px">${inner}</button>`;

/** A row's ⋯ button and, open, its menu (`key` is what `ui.menu` holds when it is open). */
function menuShell(key: string, label: string, menuLabel: string, items: string, open: boolean, disabled: boolean): string {
  return `<div class="cnpy-tagmenu">
      <button type="button" data-act="tagMenu" data-arg="${attr(key)}" data-field="${attr(`tagMenu:${key}`)}" aria-label="${attr(label)}" title="More" aria-haspopup="menu" aria-expanded="${open}"${disabled ? " disabled" : ""} class="cnpy-iconbtn cnpy-tagmenu-btn" style="border-radius:7px">${DOTS}</button>
      ${open ? `<div data-act="tagMenuClose" class="cnpy-tagmenu-back"></div><div role="menu" aria-label="${attr(menuLabel)}" class="cnpy-tagmenu-box" style="border-radius:11px">${items}</div>` : ""}
    </div>`;
}
/** The menu's list of tags to pick from (Merge into…, Use an existing tag…): each its square and name. */
const pickList = (head: string, tags: readonly OrgTagDTO[], act: string, arg: (t: OrgTagDTO) => string, label: (t: OrgTagDTO) => string): string =>
  `<div class="cnpy-tagmenu-head">${head}</div><div class="cnpy-tagmenu-list">${tags.map((x) =>
    menuRow(`${tagSquare(x.color)}<span>${esc(x.name)}</span>`, act, arg(x), { label: label(x), danger: act === "tagMergeTo" })).join("")}</div>`;

/** A row's ⋯ menu: what an admin does to a tag now and then — Rename (in place); and, for a tag that is not a
 *  starter, Merge into… (the menu turns into the list of tags to merge into; a pick asks first) and Retire (asks
 *  first). What it is for and the colour are edited by clicking them; Find items, the frequent one, is on the row. */
function rowMenu(t: OrgTagDTO, ui: TagsUi, live: readonly OrgTagDTO[], disabled: boolean): string {
  const open = ui.menu === t.name && !disabled;
  const targets = live.filter((x) => x.name !== t.name);
  const items = ui.menuMerge && !t.starter
    ? pickList(`Merge ${esc(t.name)} into`, targets, "tagMergeTo", (x) => `${t.name}>${x.name}`, (x) => `Merge ${t.name} into ${x.name}`)
    : `${menuRow("Rename", "tagRename", t.name)}${t.starter ? "" : `${targets.length ? menuRow("Merge into…", "tagMergeOpen", t.name) : ""}<div class="cnpy-tagmenu-sep"></div>${
        menuRow("Retire", "tagConfirm", `retire:${t.name}`, { field: `tagConfirm:retire:${t.name}`, danger: true })}`}`;
  return menuShell(t.name, `More for ${t.name}`, ui.menuMerge ? `Merge ${t.name} into` : t.name, items, open, disabled);
}

/** What an agent suggested, as a row at the BOTTOM of the same list in a suggested state — the whole row tinted
 *  in the accent — with a hollow square, the name muted,
 *  "Suggested" (a `waiting` mark), who sent it on what. Approve is on the row and puts it on the list (the row
 *  then draws like any other tag); its ⋯ menu gives the items a tag that is already on the list instead (the
 *  look-alike first), or dismisses it. */
function suggestionRow(s: TagSuggestionDTO, ui: TagsUi, list: TagListDTO, jev: boolean): string {
  const key = `sug:${s.name}`;
  const busy = ui.busy === s.name;
  const open = ui.menu === key && !busy;
  const live = liveOf(list);
  const whoText = s.by.length ? `, first by @${s.by[0]}${s.by.length > 1 ? ` and ${plural(s.by.length - 1, "other", "others")}` : ""}` : "";
  const like = s.similar ? ` Looks like <strong style="font-weight:600;color:var(--fg-70)">${esc(s.similar)}</strong>.` : "";
  const items = ui.menuMerge
    ? pickList(`Give its items`, live, "tagSugUse", (x) => `${s.name}>${x.name}`, (x) => `Tag the items that carried ${s.name} ${x.name} instead`)
    : `${s.similar ? menuRow(`Use ${esc(s.similar)} instead`, "tagSugUse", `${s.name}>${s.similar}`) : ""}${live.length ? menuRow("Use an existing tag…", "tagSugMapOpen", s.name) : ""}<div class="cnpy-tagmenu-sep"></div>${
      menuRow("Dismiss", "tagConfirm", `dismiss:${s.name}`, { field: `tagConfirm:dismiss:${s.name}`, danger: true })}`;
  const on = plural(s.uses, "item", "items");
  return `<li class="cnpy-tagrow-wrap" data-tag-suggestion="${attr(s.name)}" data-suggested="1">
      <div class="cnpy-tagrow">
        <div data-col="tag" class="cnpy-tagrow-name"><span class="cnpy-tagsug-sq" aria-hidden="true"></span><span class="cnpy-tagsug-name">${esc(s.name)}</span>${kindMark("Suggested", "waiting", 12, "An agent sent this tag. It is not on the list until an admin approves it.")}</div>
        <div data-col="desc" class="cnpy-tagrow-desc cnpy-tagsug-desc" title="${attr(`Sent on ${countsPhrase(s.counts)}${whoText}. ${s.uses === 1 ? "That item is" : "Those items are"} saved without it until you approve.`)}">${s.by.length ? `From @${esc(s.by[0])}${s.by.length > 1 ? ` and ${plural(s.by.length - 1, "other", "others")}` : ""}` : "From an agent"}, on ${esc(countsPhrase(s.counts))}.${like}</div>
        <div data-col="n" class="cnpy-tagrow-n" data-zero="1" title="${attr(`Waiting on ${on}`)}">${s.uses}</div>
        <div data-col="small" class="cnpy-tagrow-small">Waiting on ${on}</div>
        ${jev ? `<div data-col="jev"></div>` : ""}
        <div data-col="acts" class="cnpy-tagrow-acts">
          <button type="button" data-act="tagSugAccept" data-arg="${attr(s.name)}" aria-label="${attr(`Approve ${s.name}: add it to the list and to the ${on} it was sent on`)}" class="cnpy-tagfind cnpy-tagapprove"${busy ? " disabled" : ""}>${busy ? "Adding…" : "Approve"}</button>
          ${menuShell(key, `More for the suggestion ${s.name}`, ui.menuMerge ? `Give the items of ${s.name} a tag` : s.name, items, open, busy)}
        </div>
      </div>
    </li>`;
}

/** The tag's square and name. For an admin the square is a button that opens its colour picker. */
function nameCell(t: OrgTagDTO, admin: boolean, ui: TagsUi, editing: TagEdit | null): string {
  const note = `${t.starter ? `<span class="cnpy-tagrow-note">Starter</span>` : ""}${t.retired ? `<span class="cnpy-tagrow-note">Retired</span>` : ""}`;
  // Editing the name: the same square button (inert) before the field, so the name stays exactly where it was.
  if (editing?.field === "name") return `<div data-col="tag" class="cnpy-tagrow-name"><span class="cnpy-tagcolor"><span class="cnpy-tagcolor-btn" aria-hidden="true" style="border-radius:5px">${tagSquare(t.color)}</span></span>${inlineField(editing)}</div>`;
  if (!admin || t.retired) return `<div data-col="tag" class="cnpy-tagrow-name">${tagMark(t, { size: 13.5, retired: t.retired })}${note}</div>`;
  const open = ui.colorOpen === t.name;
  return `<div data-col="tag" class="cnpy-tagrow-name">
      <span class="cnpy-tagcolor">
        <button type="button" data-act="tagColorOpen" data-arg="${attr(t.name)}" data-field="${attr(`tagColor:${t.name}`)}" aria-label="${attr(`Colour of ${t.name}: ${t.color}`)}" title="Change the colour" aria-haspopup="true" aria-expanded="${open}" class="cnpy-tagcolor-btn" style="border-radius:5px">${tagSquare(t.color)}</button>
        ${open ? `<div data-act="tagColorClose" class="cnpy-tagmenu-back"></div><div class="cnpy-tagcolor-box" style="border-radius:11px">${colorSwitch(t)}</div>` : ""}
      </span>${tagMark(t, { size: 13.5 }).replace(/<svg class="cnpy-tagsq"[\s\S]*?<\/svg>/, "")}${note}
    </div>`;
}

/** What it is for. For an admin a click on it edits it in place. */
function descCell(t: OrgTagDTO, admin: boolean, editing: TagEdit | null): string {
  const words = t.description ? esc(t.description) : `<span style="color:var(--fg-40)">${admin && !t.retired ? "Add what it is for" : "No description"}</span>`;
  if (editing?.field === "desc") return `<div data-col="desc" class="cnpy-tagrow-desc">${inlineField(editing)}</div>`;
  if (!admin || t.retired) return `<div data-col="desc" class="cnpy-tagrow-desc">${words}</div>`;
  return `<div data-col="desc" class="cnpy-tagrow-desc"><button type="button" data-act="tagEdit" data-arg="${attr(t.name)}" data-field="${attr(`tagEdit:${t.name}`)}" aria-label="${attr(`Edit what ${t.name} is for`)}" title="Click to edit" class="cnpy-tagdesc-btn" style="border-radius:6px">${words}</button></div>`;
}

function tagRow(t: OrgTagDTO, admin: boolean, ui: TagsUi, list: TagListDTO | null = null): string {
  const editing = ui.edit?.name === t.name ? ui.edit : null;
  const busy = ui.busy === t.name;
  const ai = admin ? list?.ai : undefined;
  const last = list?.runs?.[t.name];
  const running = !!ui.live[t.name] || last?.status === "running";
  const acts = !admin ? ""
    : t.retired ? quietBtn(busy ? "Restoring…" : "Restore", "tagRestore", { arg: t.name, disabled: busy, busy, label: `Restore ${t.name}` })
    : `${canFind(ai) ? `<button type="button" data-act="tagFind" data-arg="${attr(t.name)}" aria-label="${attr(`Find existing items that fit ${t.name} and tag them`)}" class="cnpy-tagfind"${ui.busy || running ? " disabled" : ""}>Find items</button>` : ""}${
        rowMenu(t, ui, liveOf(list), busy || !!editing)}`;
  const all = total(t.counts);
  const where = all ? countsPhrase(t.counts) : "Not used yet";
  return `<li class="cnpy-tagrow-wrap" data-org-tag="${attr(t.name)}"${t.retired ? ' data-retired="1"' : ""}${t.starter ? ' data-starter="1"' : ""}${editing ? ` data-editing="${editing.field}"` : ""}>
      <div class="cnpy-tagrow">
        ${nameCell(t, admin, ui, editing)}
        ${descCell(t, admin, editing)}
        <div data-col="n" class="cnpy-tagrow-n" title="${attr(where)}"${all ? "" : ' data-zero="1"'}>${all || "—"}</div>
        <div data-col="small" class="cnpy-tagrow-small" title="${attr(where)}">${all ? plural(all, "item", "items") : "Not used yet"}</div>
        ${ai ? jevCell(t, last, ui, list?.review?.[t.name] ?? 0) : ""}
        ${admin ? `<div data-col="acts" class="cnpy-tagrow-acts">${acts}</div>` : ""}
      </div>
    </li>`;
}

/** Org settings › Tags. Any member reads the list; an admin changes it and settles suggestions. */
export function tagsTab(org: MyOrg, p: TagsTabProps): string {
  const admin = roleAtLeast(org.role, "admin");
  const note = sliceNote(p.list, "tags", p.list.data !== null, { rows: 6, trail: 96 });
  if (note) return note;
  const list = p.list.data;
  if (!list) return loadingNote("tags", { rows: 6, trail: 96 });
  const ui = p.ui;
  const live = list.tags.filter((t) => !t.retired);
  const retired = list.tags.filter((t) => t.retired);
  const full = list.cap !== null && list.used >= list.cap;
  // The header: how full the list is, what agents suggested (admins), and Jev (admins) — one card of cells.
  const waiting = admin ? list.suggestions.length : 0;
  const head0 = `<section aria-label="Tags in ${attr(org.name)}"${surface("", { cls: "cnpy-tagshead" })}>
      <div class="cnpy-tagshead-cells">
        <div class="cnpy-tagshead-cell">
          <div class="cnpy-tagshead-k">Tags</div>
          <div class="cnpy-tagshead-v"><strong>${list.used}</strong>${list.cap === null ? ` ${list.used === 1 ? "tag" : "tags"}` : ` of ${list.cap} tags`}</div>
          ${meter(list.used, list.cap, "Tags on the list")}
          <div class="cnpy-tagshead-sub">One list for everything in ${esc(org.name)}: the same tag finds a feed entry, a doc and a decision. ${admin ? "" : "An admin or an owner decides what is on it."}</div>
        </div>
        ${admin ? `<div class="cnpy-tagshead-cell">
          <div class="cnpy-tagshead-k">Suggested by agents</div>
          <div class="cnpy-tagshead-v"><strong>${waiting}</strong> waiting</div>
          <div class="cnpy-tagshead-sub">${waiting ? "At the bottom of the list. Approve one to add it, or give its items a tag you have." : "When an agent sends a tag that is not on the list, it waits at the bottom for you."}</div>
        </div>` : ""}
        ${admin && list.ai ? aiSection(list.ai, ui) : ""}
      </div>
    </section>`;

  // ONE column template for the head and every row (fixed widths but the description), so every row lines up. It
  // does not depend on the Jev switch: turning it on or off never moves a column.
  const jev = admin && !!list.ai;
  const cols = ["minmax(0, 176px)", "minmax(0, 1fr)", "64px", ...(jev ? ["190px"] : []), ...(admin ? ["116px"] : [])].join(" ");
  // Not `overflow:hidden`: a row's ⋯ menu opens over the rows below it.
  const ul = (extra: string) => surface(`list-style:none;padding:0;--tagcols:${cols};${extra}`);
  // The head: the column names (for sighted readers — each row says the same in its own words), and for an
  // admin New tag in the actions column, at the top right of the table.
  const newTag = `<button type="button" data-act="tagNew" data-field="tagNew" aria-haspopup="dialog" class="cnpy-accentbtn cnpy-tagnew-btn"${full ? ` disabled title="The list holds ${list.cap ?? 0} tags on this plan. Retire or merge one to add another."` : ""} style="border-radius:8px"><svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.6"/></svg>New tag</button>`;
  const head = `<div class="cnpy-tagrow cnpy-taghead">
      <div data-col="tag" aria-hidden="true">Tag</div><div data-col="desc" aria-hidden="true">What it is for</div><div data-col="n" aria-hidden="true">Items</div>
      ${jev ? `<div data-col="jev" aria-hidden="true">Added by Sift</div>` : ""}${admin ? `<div data-col="acts" class="cnpy-tagrow-acts">${newTag}</div>` : ""}
    </div>`;
  const rows = (ts: OrgTagDTO[]) => ts.map((t) => tagRow(t, admin, ui, list)).join("");
  const retiredBlock = retired.length ? `<div style="margin-top:18px" data-org-tags-retired>
      <button type="button" data-act="tagShowRetired" data-field="tagShowRetired" aria-expanded="${ui.showRetired}" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:6px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" style="transform:${ui.showRetired ? "rotate(90deg)" : "none"};transition:transform .15s ease"><path d="M9 6l6 6-6 6"></path></svg>${plural(retired.length, "retired tag", "retired tags")}</button>
      <ul${ul("margin:8px 0 0")}${ui.showRetired ? "" : " hidden"}>${rows(retired)}</ul>
    </div>` : "";

  return `${head0}
    <section aria-label="The tag list" data-org-group="tags">
      <ul${ul("margin:0")}>${head}${rows(live)}${admin ? list.suggestions.map((sg) => suggestionRow(sg, ui, list, jev)).join("") : ""}</ul>
      ${retiredBlock}
      <p style="${O_HELP};max-width:680px;margin-top:14px">The six starter tags come with every organization and can be renamed, not removed. A retired tag stays on what already has it and can no longer be picked.</p>
    </section>`;
}

/** The colour a new tag starts with: the first one no live tag uses yet, else the next in turn. */
export function nextTagColor(tags: readonly Pick<OrgTagDTO, "color" | "retired">[]): TagColor {
  const used = new Set(tags.filter((t) => !t.retired).map((t) => t.color));
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[tags.length % TAG_COLORS.length];
}

/** The New tag modal (opened by the bar's New tag): name, what it is for, the colour, and — when Jev may look —
 *  a switch to find the existing items that fit it now (on by default; off adds the tag and looks for nothing).
 *  Built on `confirmModal` (its keyboard: Enter adds, Escape closes, Tab stays inside). "" when closed. */
export function tagAddModal(ui: TagsUi, list: TagListDTO | null): string {
  if (!ui.addOpen || !list) return "";
  const problem = tagDraftProblem(ui.nameDraft, list.tags);
  const err = ui.addError ?? (problem || null);
  const ai = list.ai;
  const can = canFind(ai);
  const why = !ai ? "" : !ai.available ? "This Trov has no TypeSafe AI key set." : !ai.enabled ? "Sift is off for this organization (the switch above the list)." : ai.spent ? "This month's checks are used up." : "";
  const scan = can && ui.addScan;
  const label = (forId: string, text: string) => `<label for="${forId}" class="cnpy-tagnew-l">${text}</label>`;
  const detail = `<div class="cnpy-tagnew">
      <div>${label("tag-new-name", "Name")}
        <input id="tag-new-name" data-act="tagNameDraft" data-field="tagName" data-confirm-focus value="${attr(ui.nameDraft)}" maxlength="${TAG_NAME_MAX}" placeholder="billing" autocomplete="off" autocapitalize="off" spellcheck="false"${err ? ' aria-invalid="true" aria-describedby="tag-new-e"' : ""}${ui.addBusy ? " disabled" : ""} class="cnpy-input cnpy-tagnew-in" style="border-radius:8px" />
        <div class="cnpy-tagnew-help">Lowercase letters, digits and hyphens.</div></div>
      <div>${label("tag-new-desc", "What it is for")}
        <input id="tag-new-desc" data-act="tagDescDraft" data-field="tagDesc" value="${attr(ui.descDraft)}" maxlength="${TAG_DESCRIPTION_MAX}" placeholder="One line, in the team's words" autocomplete="off"${ui.addBusy ? " disabled" : ""} class="cnpy-input cnpy-tagnew-in" style="border-radius:8px" />
        <div class="cnpy-tagnew-help">${can ? "Sift reads it to find the right items, so a plain line helps." : "Shown beside the tag in the list."}</div></div>
      <div><span id="tag-new-color-l" class="cnpy-tagnew-l">Colour</span>${segmented({
        id: "tag-new-color", ariaLabel: "Colour", value: ui.addColor, act: "tagNewColor", size: "sm",
        options: TAG_COLORS.map((c) => ({ value: c, label: "", icon: `<span role="img" aria-label="${c}" style="display:grid;place-items:center;width:14px;height:14px">${tagSquare(c, 10)}</span>`, title: c[0].toUpperCase() + c.slice(1) })),
      })}</div>
      ${ai ? `<div class="cnpy-tagnew-scan"${can ? "" : ' data-off="1"'}>
        <span style="flex:none">${switchBtn("tagNewScan", null, scan).replace("<button ", `<button aria-label="Find the items that fit it now" aria-describedby="tag-new-scan-d"${can && !ui.addBusy ? "" : " disabled"} `)}</span>
        <div style="min-width:0"><div class="cnpy-tagnew-l" style="margin:0">Find the items that fit it now</div>
          <div id="tag-new-scan-d" class="cnpy-tagnew-help" style="margin-top:2px">${can ? (scan ? "Sift checks the existing feed entries, docs and decisions and adds the tag where it fits. You can undo the run." : "Off: the tag is added to nothing. Find items on its row looks later.") : esc(why)}</div></div>
      </div>` : ""}
      <div id="tag-new-e" role="alert" class="cnpy-tagnew-err"${err ? "" : " hidden"}>${esc(err ?? "")}</div>
    </div>`;
  return confirmModal({
    id: "tag-new", title: "New tag", body: "One list for everything: the same tag finds a feed entry, a doc and a decision.",
    detail, confirmAct: "tagAdd", cancelAct: "tagNewCancel", tone: "neutral", busy: ui.addBusy,
    confirmLabel: scan ? "Add and find items" : "Add tag", busyLabel: "Adding…", confirmDisabled: problem !== null,
  });
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
    } : c.what === "undoRun" ? {
      title: `Undo the last run for ${c.name}?`,
      body: `${c.name} comes off the ${(list?.runs?.[c.name]?.added ?? 0) === 1 ? "1 item" : `${list?.runs?.[c.name]?.added ?? 0} items`} that run tagged. Nothing else changes, and Trov will not add it to them again.`,
      confirmLabel: "Undo run", busyLabel: "Undoing…",
    } : c.what === "rerun" ? {
      title: `Find items for ${c.name} again?`,
      body: `You changed ${c.changed === "name" ? "its name" : "what it is for"}. Sift can check the organization again with the new words and add ${c.name} to each item it judges a fit. Nothing that has it now loses it.`,
      confirmLabel: "Find items", busyLabel: "Starting…",
    } : {
      title: `Dismiss ${c.name}?`,
      body: `The items that carried it stay as they are, without it. If an agent sends ${c.name} again, it is suggested again.`,
      confirmLabel: "Dismiss", busyLabel: "Dismissing…",
    };
  return confirmModal({ id: "tag-confirm", ...copy, confirmAct: "tagConfirmGo", cancelAct: "tagConfirmCancel", busy: c.busy, ...(c.what === "dismiss" || c.what === "rerun" ? { tone: "neutral" as const } : {}) });
}

// ── one tag's page ───────────────────────────────────────────────────────────

export interface TagPageProps {
  name: string | null;
  page: OrgSlice<TagPageDTO | null>;
  tab: TagPageTab;
  orgName: string;
  /** A person's handle as the app draws it (a link to their card). */
  who: (handle: string) => string;
  /** "Now" for the activity chart (a test pins it); the clock when absent. */
  now?: number;
  /** The write out (a review item's buttons wait: `review:<type>:<id>`). */
  busy?: string | null;
  /** A person's colour (the one their name is drawn in), for their bar under Who writes about it; null = the tag's. */
  colorOf?: (handle: string) => string | null;
  /** Another tag's colour, for its bar under Often seen with; null = the tag's. */
  tagColorOf?: (name: string) => string | null;
}

// The page (web-ui.md › Tags › One tag's page): a hero (square, name, what it is for, the counts by type and their
// split), the type tabs, then a bento of FIXED-size tiles (`TagTileSize`) — under All, Docs over Decisions beside
// the feed, then Activity, Who tagged it, Who writes about it and Often seen with in one row; under a type's tab
// that type's whole list beside a rail of its own activity (with Jev's share) and its people. A tile never grows
// or shrinks with what it holds: its body scrolls. The tag's own colour (`--tag-c`) draws every chart on the page.

const ITEM_ACT: Record<TagItemType, string> = { feed: "goFeed", doc: "openDocFrom", adr: "tagOpenDecision" };
const TAB_LABEL: Record<TagPageTab, string> = { all: "All", feed: "Feed", doc: "Docs", adr: "Decisions", review: "To review" };
const GROUP_TITLE: Record<TagItemType, string> = { doc: "Docs", adr: "Decisions", feed: "Recent in the feed" };
/** What the team knows first (docs, decisions), then what happened (the feed). */
const PAGE_ORDER: readonly TagItemType[] = ["doc", "adr", "feed"];
/** Rows a type's tile holds under All — it scrolls inside its fixed height; its tab lists them all. */
const TILE_ROWS = 10;
const WEEKS = 12;
const WEEK_MS = 7 * 86_400_000;
const capFirst = (s: string): string => s[0].toUpperCase() + s.slice(1);
/** "Sep 14" (UTC, so a date reads the same everywhere). */
const dayDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A decision's state as a mark: ratified is settled by a person (check), a draft is not yet (open ring). */
const decisionMark = (status: string | null): string => status === "ratified"
  ? kindMark("Ratified", "done", 12, "A person ratified this decision.")
  : authorityMark("draft", 12);

/** "Added by Jev" on an item a run tagged: a FACT about how the tag got there, so plain words; its tooltip is
 *  Jev's reason and how sure it was. No such words = a person or their agent put it there. */
function jevNote(j: NonNullable<TagPageItem["jev"]>): string {
  const tip = `${j.reason ? `${j.reason} ` : ""}Sift was ${Math.round(j.confidence * 100)}% sure${j.at ? ` (${dayDate(j.at)})` : ""}.`;
  return `<span data-jev data-mtip="${attr(tip)}" style="white-space:nowrap;color:var(--fg-55)">Added by Sift</span>`;
}

function pageItem(it: TagPageItem, who: TagPageProps["who"]): string {
  const meta = [
    it.type === "adr" ? decisionMark(it.note) : it.type === "doc" && it.note ? `<span style="color:var(--fg-55)">${esc(capFirst(it.note))}</span>` : "",
    it.by ? who(it.by) : "",
    it.at ? `<time datetime="${attr(it.at)}" style="white-space:nowrap">${esc(relTime(it.at))}</time>` : "",
    it.jev ? jevNote(it.jev) : "",
    tagWords(it.tags),
  ].filter(Boolean).join(`<span aria-hidden="true">·</span>`);
  return `<li class="cnpy-tagitem" data-tag-item="${it.type}:${attr(it.id)}"${it.jev ? ' data-by-jev="1"' : ""}>
      <button type="button" data-act="${ITEM_ACT[it.type]}" data-arg="${attr(it.type === "adr" ? it.title : it.id)}" class="cnpy-tagitem-t">${esc(it.title)}</button>
      ${it.type === "feed" && it.note ? `<div class="cnpy-tagitem-note">${esc(it.note)}</div>` : ""}
      ${meta ? `<div class="cnpy-tagitem-meta">${meta}</div>` : ""}
    </li>`;
}

/** One of Sift's suggestions on the To review tab: the item, how sure Sift was and why, and Add / Dismiss. */
function reviewItem(it: TagPageItem, tag: string, who: TagPageProps["who"], busy: string | null): string {
  const key = `${it.type}:${it.id}`;
  const waiting = busy === `review:${key}`;
  const sure = it.jev ? `Sift is ${Math.round(it.jev.confidence * 100)}% sure` : "";
  const meta = [
    `<span style="white-space:nowrap">${esc(capFirst(TAG_ITEM_LABEL[it.type].one))}</span>`,
    it.by ? who(it.by) : "",
    it.at ? `<time datetime="${attr(it.at)}" style="white-space:nowrap">${esc(relTime(it.at))}</time>` : "",
    sure ? `<span${it.jev?.reason ? ` data-mtip="${attr(it.jev.reason)}"` : ""} style="white-space:nowrap;color:var(--fg-55)">${esc(sure)}</span>` : "",
  ].filter(Boolean).join(`<span aria-hidden="true">·</span>`);
  return `<li class="cnpy-tagitem cnpy-tagreview" data-tag-review="${attr(key)}">
      <div style="min-width:0">
        <button type="button" data-act="${ITEM_ACT[it.type]}" data-arg="${attr(it.type === "adr" ? it.title : it.id)}" class="cnpy-tagitem-t">${esc(it.title)}</button>
        ${it.type === "feed" && it.note ? `<div class="cnpy-tagitem-note">${esc(it.note)}</div>` : ""}
        <div class="cnpy-tagitem-meta">${meta}</div>
      </div>
      <div class="cnpy-tagreview-acts">
        ${accentBtn(waiting ? "Adding…" : "Add tag", "tagReviewAdd", { arg: key, disabled: !!busy, busy: waiting, label: `Add ${tag} to “${it.title}”`, extra: "height:30px;padding:0 11px;font-size:12.5px" })}
        ${quietBtn("Dismiss", "tagReviewDismiss", { arg: key, disabled: !!busy, label: `Dismiss Sift's suggestion of ${tag} for “${it.title}”`, extra: "height:30px;padding:0 11px;font-size:12.5px" })}
      </div>
    </li>`;
}

/** A tile's FIXED height (trov.css `.cnpy-tagpage-tile[data-size]`), whatever it holds — 0 items, 1 or 50, or its
 *  empty sentence: what does not fit scrolls inside its body. `half` + gap + `half` = `tall` (Docs and Decisions
 *  beside the feed; a type's list), `row` (the second row; the rail's Activity), `rest` = `tall` − `row` − gap. */
export type TagTileSize = "half" | "tall" | "row" | "rest" | "full";
/** A tile: a surface on the page's 12-column grid — `span` / `md` are its columns wide and under a mid-width page —
 *  with its title row, and its body (which scrolls) under it. */
const tile = (head: string, body: string, span: number, md: number, size: TagTileSize, attrs = ""): string =>
  `<section${surface(`--span:${span};--md:${md}`, { cls: "cnpy-tagpage-tile" })} data-size="${size}"${attrs}>${head}<div class="cnpy-tagpage-body cnpy-scroll">${body}</div></section>`;
/** A tile's title row: the title, a count, and on the right a quiet link. */
function tileHead(title: string, id: string, count: number | null = null, more = ""): string {
  return `<div class="cnpy-tagpage-th"><h3 id="${attr(id)}">${esc(title)}</h3>${count === null ? "" : `<span class="cnpy-badge" data-n="${count}">${count}</span>`}${more ? `<span class="cnpy-tagpage-more">${more}</span>` : ""}</div>`;
}
const tileNote = (text: string): string => `<p class="cnpy-tagpage-none">${text}</p>`;
/** Name and number per row, with a bar scaled to the largest — in the row's OWN colour (`tone`: the person's, the
 *  other tag's), else the tag's. `label` is markup. */
function meters(rows: readonly { label: string; n: number; tone?: string | null }[]): string {
  const peak = Math.max(1, ...rows.map((r) => r.n));
  return `<ul class="cnpy-tagpage-meters">${rows.map((r) => `<li><span class="cnpy-tagpage-ml">${r.label}</span><span class="cnpy-tagpage-meter" aria-hidden="true"><span style="width:${Math.max(4, Math.round((r.n / peak) * 100))}%${r.tone ? `;background:${tagTone(r.tone)}` : ""}"></span></span><span class="cnpy-tagpage-mn">${r.n}</span></li>`).join("")}</ul>`;
}

/** Items per week, oldest first, for the last `WEEKS` weeks before `now`. */
export function tagWeeks(items: readonly Pick<TagPageItem, "at">[], now: number): number[] {
  const out = new Array<number>(WEEKS).fill(0);
  for (const it of items) {
    const t = it.at ? Date.parse(it.at) : NaN;
    if (Number.isNaN(t)) continue;
    const ago = Math.floor((now - t) / WEEK_MS);
    if (ago >= 0 && ago < WEEKS) out[WEEKS - 1 - ago]++;
  }
  return out;
}

/** The hero: the square and the name, what it is for, the counts by type and how they split. */
function pageHero(d: TagPageDTO): string {
  const { tag } = d;
  const sum = total(tag.counts);
  const facts = [
    tag.starter ? `<span>Starter tag</span>` : "",
    tag.retired ? `${kindMark("Retired", "off", 12.5, "Nobody can pick it any more.")}<span>It stays on what has it and can no longer be picked.</span>` : "",
  ].filter(Boolean).join("");
  const fig = (label: string, n: number, type = "") => `<div class="cnpy-tagpage-fig"${type ? ` data-type="${type}"` : ""}><dt>${type ? `<span class="cnpy-tagpage-sw" aria-hidden="true"></span>` : ""}${esc(label)}</dt><dd>${n}</dd></div>`;
  const split = sum ? `<div class="cnpy-tagpage-split">${PAGE_ORDER.filter((t) => tag.counts[t] > 0).map((t) => `<span data-type="${t}" style="flex-grow:${tag.counts[t]}" title="${attr(plural(tag.counts[t], TAG_ITEM_LABEL[t].one, TAG_ITEM_LABEL[t].many))}"></span>`).join("")}</div>` : "";
  return `<header class="cnpy-tagpage-hero">
      <div class="cnpy-tagpage-id">
        <h2 class="cnpy-tagpage-name">${tagSquare(tag.color, 16)}<span>${esc(tag.name)}</span></h2>
        <p class="cnpy-tagpage-desc"${tag.description ? "" : " data-none"}>${tag.description ? esc(tag.description) : "No description yet."}</p>
        ${facts ? `<div class="cnpy-tagpage-facts">${facts}</div>` : ""}
      </div>
      <div class="cnpy-tagpage-count">
        <dl class="cnpy-tagpage-figs">${fig(sum === 1 ? "Item" : "Items", sum)}${PAGE_ORDER.map((t) => fig(capFirst(tag.counts[t] === 1 ? TAG_ITEM_LABEL[t].one : TAG_ITEM_LABEL[t].many), tag.counts[t], t)).join("")}</dl>
        ${split}
      </div>
    </header>`;
}

/** A type's tile under All: its newest rows, and a link to its tab when it has more. */
function typeTile(t: TagItemType, d: TagPageDTO, who: TagPageProps["who"], span: number, md: number, size: TagTileSize, empty: string): string {
  const n = d.tag.counts[t];
  const rows = d.items[t].slice(0, TILE_ROWS);
  const more = n > rows.length ? `<button type="button" data-act="tagPageTab" data-arg="${t}" class="mw-more" aria-label="All ${attr(plural(n, TAG_ITEM_LABEL[t].one, TAG_ITEM_LABEL[t].many))}">All ${n}${ASIDE_ARROW}</button>` : "";
  const body = rows.length ? `<ul class="cnpy-tagpage-list">${rows.map((it) => pageItem(it, who)).join("")}</ul>` : tileNote(empty);
  return tile(tileHead(GROUP_TITLE[t], `tag-g-${t}`, n, more), body, span, md, size, ` data-tag-group="${t}" aria-labelledby="tag-g-${t}"`);
}

/** Activity: when the items were written — the last twelve weeks as bars, the newest and the oldest. */
function activityTile(list: readonly TagPageItem[], d: TagPageDTO, now: number, span: number, md: number, jev: number | null = null): string {
  const weeks = tagWeeks(list, now);
  const peak = Math.max(1, ...weeks);
  const recent = weeks.reduce((a, b) => a + b, 0);
  const dated = list.map((i) => i.at).filter((x): x is string => !!x && !Number.isNaN(Date.parse(x))).sort();
  const newest = dated[dated.length - 1] ?? null;
  const oldest = dated[0] ?? null;
  const bars = weeks.map((n, i) => {
    const start = new Date(now - (WEEKS - i) * WEEK_MS + 1).toISOString();
    return `<span class="cnpy-tagpage-wk"${n ? "" : " data-zero"} style="--h:${Math.round((n / peak) * 100)}%" title="${attr(`${i === WEEKS - 1 ? "This week" : `Week of ${dayDate(start)}`}: ${plural(n, "item", "items")}`)}"></span>`;
  }).join("");
  const cut = PAGE_ORDER.some((t) => d.tag.counts[t] > d.items[t].length);
  const fact = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  return tile(tileHead("Activity", "tag-g-activity"), `
      <dl class="cnpy-tagpage-facts2">
        ${fact("Newest", newest ? `<time datetime="${attr(newest)}">${esc(relTime(newest))}</time>` : "—")}
        ${fact("Oldest listed", oldest ? `<time datetime="${attr(oldest)}">${esc(dayDate(oldest))}</time>` : "—")}
        ${fact("Last 12 weeks", String(recent))}
        ${jev === null ? "" : fact("Added by Sift", String(jev))}
      </dl>
      <div class="cnpy-tagpage-weeks" role="img" aria-label="${attr(`${plural(recent, "item", "items")} in the last 12 weeks, by week`)}">${bars}</div>
      <div class="cnpy-tagpage-axis" aria-hidden="true"><span>12 weeks ago</span><span>This week</span></div>
      ${cut ? `<p class="cnpy-tagpage-foot">From the newest ${TAG_PAGE_LIMIT} of each type.</p>` : ""}`, span, md, "row", ` data-tag-tile="activity" aria-labelledby="tag-g-activity"`);
}

/** Who put the tag there: how many Jev added and how many people and their agents did, and Jev's latest. */
function jevTile(d: TagPageDTO, span: number, md: number): string {
  const sum = total(d.tag.counts);
  const jev = Math.min(d.jev_added, sum);
  const people = sum - jev;
  const latest = PAGE_ORDER.flatMap((t) => d.items[t]).filter((i) => i.jev).sort((a, b) => (b.jev?.at ?? "").localeCompare(a.jev?.at ?? "")).slice(0, 3);
  const body = sum === 0 ? tileNote("Nothing carries it yet, so nobody has tagged anything with it.")
    : jev === 0
    ? tileNote(`Sift has not added ${esc(d.tag.name)} to anything: ${sum === 1 ? "the item here was" : "everything here was"} tagged by a person or their agent.`)
    : `<div class="cnpy-tagpage-who">
          <div><b>${jev}</b><span>by Sift</span></div><div><b>${people}</b><span>by people and their agents</span></div>
        </div>
        <div class="cnpy-tagpage-split cnpy-tagpage-split--jev" aria-hidden="true"><span data-by="jev" style="flex-grow:${jev}"></span>${people ? `<span data-by="people" style="flex-grow:${people}"></span>` : ""}</div>
        ${latest.length ? `<ul class="cnpy-tagpage-jevs">${latest.map((it) => `<li><button type="button" data-act="${ITEM_ACT[it.type]}" data-arg="${attr(it.type === "adr" ? it.title : it.id)}" class="cnpy-tagitem-t">${esc(it.title)}</button><span>${Math.round((it.jev?.confidence ?? 0) * 100)}% sure</span></li>`).join("")}</ul>` : ""}`;
  return tile(tileHead("Who tagged it", "tag-g-jev"), body, span, md, "row", ` data-tag-tile="jev" aria-labelledby="tag-g-jev"`);
}

function peopleTile(rows: readonly { handle: string; count: number }[], who: TagPageProps["who"], span: number, md: number, size: TagTileSize, colorOf?: TagPageProps["colorOf"]): string {
  const body = rows.length ? meters(rows.map((a) => ({ label: who(a.handle), n: a.count, tone: colorOf?.(a.handle) }))) : tileNote("Nobody yet.");
  return tile(tileHead("Who writes about it", "tag-g-people"), body, span, md, size, ` data-tag-tile="people" aria-labelledby="tag-g-people"`);
}

function seenTile(d: TagPageDTO, span: number, md: number, tagColorOf?: TagPageProps["tagColorOf"]): string {
  const body = d.seen_with.length ? meters(d.seen_with.map((s) => ({ label: tagWords([s.name], { size: 13 }), n: s.count, tone: tagColorOf?.(s.name) }))) : tileNote("It is not on anything with another tag.");
  return tile(tileHead("Often seen with", "tag-g-seen"), body, span, md, "row", ` data-tag-tile="seen" aria-labelledby="tag-g-seen"`);
}

/** `#tags/<name>`: the hero, a tab per type (All first), and the bento under it. */
export function tagPageView(p: TagPageProps): string {
  // The work screens' frame (ui.ts WORK_SHELL: fluid to 1440px — the queue's, the Artifacts'), the widest in the app.
  const shell = (inner: string, tone = "") => `<div data-screen-label="Tag" class="cnpy-org cnpy-tagpage" style="${WORK_SHELL};box-sizing:border-box${tone ? `;--tag-c:${tone}` : ""}">${inner}</div>`;
  if (p.page.status === "error") return shell(failedNote("this tag", "tagPageReload"));
  if (!p.page.data) {
    if (p.page.status === "ok") return shell(orgEmpty("No such tag", `${p.name ? `“${p.name}” is not one of ${p.orgName}'s tags.` : "That tag does not exist."} The list is in Org settings › Tags.`, quietBtn("Open the tag list", "tagsGo")));
    return shell(loadingNote("this tag", { rows: 5 }));
  }
  const d = p.page.data;
  const { tag, items } = d;
  const now = p.now ?? Date.now();
  const sum = total(tag.counts);
  // The tab picked is the tab shown — every tab the bar offers, an empty type included (it says it is empty).
  const tab = p.tab;
  const bar = tabBar({
    id: "tag-tab", ariaLabel: `What is tagged ${tag.name}`, act: "tagPageTab", value: tab,
    tabs: TAG_PAGE_TABS.filter((t) => t !== "review" || d.review.length > 0 || tab === "review").map((t) => {
      const n = t === "all" ? sum : t === "review" ? d.review.length : tag.counts[t];
      return { value: t, label: TAB_LABEL[t], trail: `<span class="cnpy-badge" data-n="${n}">${n}</span>` };
    }),
  });
  let body: string;
  if (tab === "review") {
    const list = d.review.length
      ? `<ul class="cnpy-tagpage-list">${d.review.map((it) => reviewItem(it, tag.name, p.who, p.busy ?? null)).join("")}</ul>`
      : `<p class="cnpy-tagpage-none">Nothing to review: every item Sift suggested for ${esc(tag.name)} has been added or dismissed.</p>`;
    body = `<div class="cnpy-tagpage-grid">${tile(tileHead("Suggested by Sift", "tag-g-review", d.review.length || undefined, `<span class="cnpy-tagpage-sub">Sift was 60–85% sure: add the tag where it fits, or dismiss it.</span>`), list, 12, 12, "full", ` data-tag-group="review" aria-labelledby="tag-g-review"`)}</div>`;
  } else if (tab === "all") {
    // Every tile is there whatever the tag holds — an empty one says so in its own, same-sized box.
    const none = sum === 0 && PAGE_ORDER.every((t) => items[t].length === 0);
    const emptyOf = (t: TagItemType) => none && t === "feed"
      ? "Nothing carries this tag yet. An agent's feed entry carries it when the session picks it; a person adds it on a doc's page."
      : `No ${TAG_ITEM_LABEL[t].many} carry it yet.`;
    // Row 1: what the team knows (docs, decisions — two half-height tiles) in one column, the feed (one tall
    // tile) beside it. Row 2: Activity, Who tagged it, Who writes about it, Often seen with — one height.
    body = `<div class="cnpy-tagpage-grid cnpy-stagger">
          <div class="cnpy-tagpage-col" style="--span:5;--md:6">${typeTile("doc", d, p.who, 12, 12, "half", emptyOf("doc"))}${typeTile("adr", d, p.who, 12, 12, "half", emptyOf("adr"))}</div>
          ${typeTile("feed", d, p.who, 7, 6, "tall", emptyOf("feed"))}
          ${activityTile(PAGE_ORDER.flatMap((t) => items[t]), d, now, 3, 6)}${jevTile(d, 3, 6)}${peopleTile(d.authors, p.who, 3, 6, "row", p.colorOf)}${seenTile(d, 3, 6, p.tagColorOf)}
        </div>`;
  } else {
    const list = items[tab];
    const n = tag.counts[tab];
    const words = TAG_ITEM_LABEL[tab];
    const listBody = list.length
      ? `<ul class="cnpy-tagpage-list">${list.map((it) => pageItem(it, p.who)).join("")}</ul>
         ${n > list.length ? `<p class="cnpy-tagpage-foot" style="margin-bottom:12px">Showing the newest ${list.length} of ${n}.</p>` : ""}`
      : tileNote(`No ${words.many} are tagged ${esc(tag.name)} yet. When ${tab === "adr" ? "a decision" : tab === "doc" ? "a doc" : "a feed entry"} gets the tag, it shows here.`);
    // This type's people, from its listed items.
    const by = new Map<string, number>();
    for (const it of list) if (it.by) by.set(it.by, (by.get(it.by) ?? 0) + 1);
    const people = [...by].map(([handle, count]) => ({ handle, count })).sort((a, b) => b.count - a.count || a.handle.localeCompare(b.handle)).slice(0, 8);
    // The list is one tall tile; the rail beside it (Activity, then its people) ends on the same line.
    body = `<div class="cnpy-tagpage-grid">
        ${tile(tileHead(capFirst(words.many), `tag-g-${tab}`, n), listBody, 8, 12, "full", ` data-tag-group="${tab}" aria-labelledby="tag-g-${tab}"`)}
        <div class="cnpy-tagpage-rail cnpy-stagger" style="--span:4;--md:12">
          ${activityTile(list, d, now, 12, 12, list.filter((i) => i.jev).length)}
          ${peopleTile(people, p.who, 12, 12, "rest", p.colorOf)}
        </div>
      </div>`;
  }
  return shell(`${pageHero(d)}${bar}<div${tabPanelAttrs("tag-tab", tab)} class="cnpy-tagpage-panel">${body}</div>`, tagTone(tag.color));
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
