// Prompt Library — ported from the Claude Design `Canopy.dc.html` (project
// 2c8cfa50): the library grid, one prompt (body, properties, version history
// with a per-version diff), and the editor (new / edit / new version).
// Purely presentational: props in, markup out; clicks are `data-act` dispatched
// in main.ts, which calls the /api/prompts routes (save / retag / publish).

import type { PromptSummary, PromptDetail, PromptVersion, PromptStatus, PromptSort } from "@shared/handoffs";
import { detectVars } from "@shared/handoffs";
import { TAGS } from "@shared/vocabulary";
import { searchFilterBar, type FilterMenuProps } from "./filter-menu";
import type { PersonSummary } from "./api";
import { esc, attr, relTime, statusBadge, surface, WORK_SHELL } from "./ui";
import { personChip, handleTag } from "./people";
import { collapsedLineDiff } from "./diff";
import { unifiedDiff } from "./review";
import { primaryStyle } from "./handoffs";
import { promptBox, promptModal, type PromptView } from "./prompt-box";
import { segmented } from "./segmented";
import { confirmAnchor } from "./confirm";

const personOf = (persons: PersonSummary[], h: string): PersonSummary | null =>
  persons.find((p) => p.handle.toLowerCase() === h.toLowerCase()) ?? null;
const MONO_EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const notice = (text: string): string => `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${esc(text)}</div>`;

/** STAGED (amber) / DRAFT (blue) — the triage badges — and PUBLISHED in the docs' accent. */
export function promptBadge(status: PromptStatus): string {
  if (status === "staged") return statusBadge("STAGED", "var(--amber)");
  if (status === "draft") return statusBadge("DRAFT", "var(--blue)");
  return statusBadge("PUBLISHED", "var(--accent)");
}

export { detectVars };
/** A slug from a title: lowercase, non-alphanumerics → "-", trimmed, ≤ 60. */
export const slugify = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const tagPill = (t: string) =>
  `<span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none">${esc(t)}</span>`;

// ── library ──────────────────────────────────────────────────────────────────
export type PromptFilterCat = "tag" | "sort";
export interface PromptLibraryProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  prompts: PromptSummary[];
  q: string;
  tag: string | null;
  sort: PromptSort;
  filterOpen: boolean;
  filterCat: PromptFilterCat;
  /** The filter menu this render opens (plays its entrance once). */
  fmOpening: string | null;
  persons: PersonSummary[];
}

/** The library's filter: free text over title / slug / excerpt / tags, one tag, a sort. */
export function filterPrompts(list: PromptSummary[], q: string, tag: string | null, sort: PromptSort): PromptSummary[] {
  const needle = q.trim().toLowerCase();
  const out = list.filter((p) => (!needle || `${p.title} ${p.slug} ${p.excerpt} ${p.tags.join(" ")}`.toLowerCase().includes(needle)) && (!tag || p.tags.includes(tag)));
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1) * (sort === "updated_asc" ? -1 : 1));
}

const SORTS = [["updated_desc", "Recently updated"], ["updated_asc", "Least recently updated"]] as const;

/** The shared filter menu (web/src/filter-menu.ts) with the library's two categories:
 *  Tag (one tag, or all) and Sort (the order the cards are listed in). */
function promptFilterMenu(p: PromptLibraryProps): FilterMenuProps {
  const shown = filterPrompts(p.prompts, p.q, p.tag, p.sort).length;
  return {
    id: "prompt", open: p.filterOpen, opening: p.fmOpening === "prompt", cat: p.filterCat,
    activeCount: (p.tag ? 1 : 0) + (p.sort !== "updated_desc" ? 1 : 0),
    showLabel: `Show ${shown} ${shown === 1 ? "prompt" : "prompts"}`, clearAct: "promptResetFilters",
    align: "stretch", ariaLabel: "Filter and sort prompts",
    groups: [
      {
        key: "tag", label: "Tag", value: p.tag ?? "", none: "",
        options: [null, ...TAGS].map((t) => ({
          v: t ?? "", l: t ?? "All tags", mono: !!t, act: "promptTag", arg: t ?? "",
          n: t ? p.prompts.filter((x) => x.tags.includes(t)).length : p.prompts.length,
        })),
      },
      {
        key: "sort", label: "Sort", value: p.sort, none: "updated_desc",
        options: SORTS.map(([k, l]) => ({ v: k, l, act: "promptSort", arg: k })),
      },
    ],
  };
}

function promptCard(x: PromptSummary, persons: PersonSummary[]): string {
  const au = personOf(persons, x.author);
  return `<button data-act="openPrompt" data-arg="${attr(x.slug)}" class="cnpy-surface cnpy-card" style="display:flex;flex-direction:column;text-align:left;width:100%;min-width:0;padding:16px 18px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%">
      <div style="font-size:14px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);min-width:0">${esc(x.title)}</div>
      ${promptBadge(x.status)}
    </div>
    <div style="font-family:var(--sans);font-size:11px;color:var(--fg-40);margin-top:3px">${esc(x.slug)}</div>
    <div style="font-size:12.5px;color:var(--fg-55);margin-top:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%">${esc(x.excerpt)}</div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px">${x.tags.map(tagPill).join("")}</div>
    <div style="flex:1"></div>
    <div style="display:flex;align-items:center;gap:7px;margin-top:12px;padding-top:11px;border-top:1px solid var(--border);width:100%">
      ${personChip(au, 18, x.author)}
      ${handleTag(au, x.author, 11.5)}
      <span style="font-size:12px;color:var(--fg-40)">·</span>
      <span style="font-family:var(--label);font-size:11px;font-weight:600;color:var(--fg-55)">v${x.version}</span>
      <span style="font-size:11.5px;color:var(--fg-40);margin-left:auto;white-space:nowrap">${esc(relTime(x.updated_at))}</span>
    </div>
  </button>`;
}

export function promptLibraryView(p: PromptLibraryProps): string {
  const shown = filterPrompts(p.prompts, p.q, p.tag, p.sort);
  const menu = promptFilterMenu(p);
  const staged = shown.filter((x) => x.status === "staged").length;
  const loading = (p.status === "idle" || p.status === "loading") && p.prompts.length === 0;

  let body: string;
  if (loading) body = notice("Loading prompts…");
  else if (p.status === "error" && p.prompts.length === 0) body = notice("Couldn't load the prompt library.");
  else if (shown.length === 0) body = `<div style="display:flex;justify-content:center;padding:48px 0">
      <div style="border:1px dashed var(--border-strong);border-radius:13px;padding:36px 44px;text-align:center;max-width:380px">
        <div style="font-size:15px;font-weight:600;color:var(--fg-70)">No prompts match</div>
        <div style="font-size:12.5px;color:var(--fg-40);margin-top:6px">Nothing in the library matches this search and tag filter.</div>
        <button data-act="promptClearFilters" class="cnpy-link" style="font-size:12.5px;font-weight:500;color:var(--accent);margin-top:12px">Clear filters</button>
      </div>
    </div>`;
  else body = `<div class="cnpy-mw-grid is-3 cnpy-stagger">${shown.map((x) => promptCard(x, p.persons)).join("")}</div>`;

  return `<div data-screen-label="Prompt Library" style="${WORK_SHELL}">
  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 16px">
    ${searchFilterBar({
      search: { act: "promptQuery", field: "promptQuery", value: p.q, placeholder: "Search titles, slugs and bodies", ariaLabel: "Search prompts" },
      menu,
    })}
    <span style="flex:1"></span>
    <span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap;margin-left:6px">${loading ? "" : `${shown.length} shown · ${staged} staged`}</span>
  </div>
  ${body}
</div>`;
}

// ── one prompt ───────────────────────────────────────────────────────────────
export interface PromptDetailProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  prompt: PromptDetail | null;
  versions: PromptVersion[];
  persons: PersonSummary[];
  /** Every tag in use across the library (the add-tag menu's options). */
  knownTags: string[];
  diffVersion: number | null;
  tagMenu: boolean;
  tagDraft: string;
  /** The prompt box's Raw / Rendered setting. */
  promptView: PromptView;
  /** The viewer is the prompt's author or an admin — the only people shown "Delete prompt". */
  canDelete: boolean;
  /** The delete confirm is open. */
  deleteArm: boolean;
  /** The delete request is in flight. */
  deleteBusy?: boolean;
}

const PROP_ROW = "display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center;height:30px";
const PROP_KEY = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)";
const railHead = (label: string) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;height:22px;margin-bottom:6px"><div style="${MONO_EYEBROW}">${esc(label)}</div></div>`;

/** The add-tag menu's options: known tags not already on the prompt, narrowed by the draft; a new draft leads as "+ tag". */
export function tagOptions(current: string[], known: string[], draftRaw: string): { tag: string; label: string }[] {
  const draft = draftRaw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  const all = [...new Set([...TAGS, ...known])];
  const opts = all.filter((t) => !current.includes(t) && (!draft || t.includes(draft))).map((t) => ({ tag: t, label: t }));
  if (draft && !all.includes(draft) && !current.includes(draft)) opts.unshift({ tag: draft, label: `+ ${draft}` });
  return opts;
}

/** What a delete keeps, for the confirm: "Its one version is kept" / "All 3 versions are kept". */
const deleteKeeps = (n: number): string => (n === 1 ? "Its one version is kept" : `All ${n} versions are kept`);

export function promptDetailView(p: PromptDetailProps): string {
  // The page is at least the viewport tall and the body row takes what is left, so the
  // prompt box runs to the bottom of the screen instead of stopping at the rail's height.
  const shell = (inner: string) => `<div data-screen-label="Prompt detail" class="cnpy-pdetail-page" style="width:100%;max-width:1260px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 28px">${inner}</div>`;
  const x = p.prompt;
  if (!x) {
    if (p.status === "idle" || p.status === "loading") return shell(notice("Loading…"));
    return shell(notice(p.status === "error" ? "Couldn't load this prompt." : "Prompt not found."));
  }
  const au = personOf(p.persons, x.author);
  /** The newest staged version — a person may publish it from the header. */
  const staged = p.versions.find((v) => v.status === "staged") ?? null;

  // The body, or — with a version picked in the history — what that version changed.
  const idx = p.versions.findIndex((v) => v.version === p.diffVersion);
  let main: string;
  if (idx >= 0) {
    const ver = p.versions[idx];
    const prev = p.versions[idx + 1];
    const rows = collapsedLineDiff(prev ? prev.body : "", ver.body, 2).map((r) => ({ t: r.t, s: r.text }));
    main = `<div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
        <div style="${MONO_EYEBROW}">${esc(prev ? `Changes in v${ver.version} (from v${prev.version})` : `v${ver.version} · first version`)}</div>
        <button data-act="promptDiff" data-arg="" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;color:var(--fg-55);white-space:nowrap"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 6l-6 6 6 6"></path></svg>Back to prompt</button>
      </div>
      ${unifiedDiff(rows)}
    </div>`;
  } else {
    main = promptBox({ title: x.title, body: x.body, copyAct: "promptCopy", expandAct: "promptExpand", view: p.promptView });
  }

  const opts = p.tagMenu ? tagOptions(x.tags, p.knownTags, p.tagDraft) : [];
  const tagMenu = p.tagMenu
    ? `<div data-act="promptTagMenu" style="position:fixed;inset:0;z-index:29"></div>
      <div style="position:absolute;top:calc(100% + 6px);left:0;z-index:30;background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;padding:5px;box-shadow:0 14px 38px rgba(0,0,0,.38);width:200px">
        <input data-act="promptTagDraft" data-field="promptTagDraft" value="${attr(p.tagDraft)}" placeholder="New tag…" aria-label="New tag" style="width:100%;box-sizing:border-box;height:30px;padding:0 9px;margin-bottom:4px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--fg);font-size:12px;font-family:var(--label);outline:none">
        ${opts.map((o) => `<button data-act="promptTagAdd" data-arg="${attr(o.tag)}" class="cnpy-menurow" style="display:flex;align-items:center;width:100%;text-align:left;padding:6px 9px;border-radius:7px;font-size:12px;font-family:var(--label);color:var(--fg-70)">${esc(o.label)}</button>`).join("")}
        ${opts.length ? "" : `<div style="padding:6px 9px;font-size:11.5px;color:var(--fg-40)">${p.tagDraft.trim() ? "Already added" : "Type to create a tag"}</div>`}
      </div>`
    : "";
  const tags = x.tags.map((t) => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-55);border:1px solid var(--border-strong);border-radius:5px;padding:2px 3px 2px 6px;white-space:nowrap;flex:none">${esc(t)}<button data-act="promptTagRemove" data-arg="${attr(t)}" class="cnpy-xbtn" aria-label="Remove tag" title="Remove" style="width:14px;height:14px;display:grid;place-items:center;border-radius:3px;color:var(--fg-40)"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 5l14 14M19 5 5 19"></path></svg></button></span>`).join("");
  const addTagSt = `display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:500;color:${p.tagMenu ? "var(--fg)" : "var(--fg-40)"};border:1px dashed var(--border-strong);border-radius:5px;padding:2px 7px;white-space:nowrap;background:${p.tagMenu ? "var(--hover)" : "transparent"}`;

  const versions = p.versions.map((v) => {
    const on = p.diffVersion === v.version;
    return `<button data-act="promptDiff" data-arg="${on ? "" : v.version}" class="cnpy-menurow" style="display:block;width:100%;text-align:left;padding:8px;border-radius:7px;background:${on ? "var(--hover)" : "transparent"}">
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <span style="font-family:var(--label);font-size:12px;font-weight:600;color:var(--fg);flex:none">v${v.version}</span>
        <span style="font-size:11px;color:var(--fg-40);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(relTime(v.created_at))}</span>
        ${promptBadge(v.status)}
      </div>
      <div style="font-size:12px;line-height:1.45;color:var(--fg-55);margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-align:left">${esc(v.summary)}</div>
    </button>`;
  }).join("");

  return shell(`
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">
      <div style="flex:1 1 340px;min-width:0">
        <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(x.title)}</h2>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:8px;font-size:12px;color:var(--fg-55)"><span style="font-family:var(--sans);font-size:11.5px;color:var(--fg-55);white-space:nowrap">${esc(x.slug)}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex:none;padding-top:2px;flex-wrap:wrap">
        ${staged ? `<button data-act="promptPublish" data-arg="${staged.version}" class="cnpy-accentbtn" style="${primaryStyle(true)}">Publish v${staged.version}</button>` : ""}
        <button data-act="promptEdit" data-arg="${attr(x.slug)}" class="cnpy-outlinebtn" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">Edit</button>
        <button data-act="promptNewVersion" data-arg="${attr(x.slug)}" class="cnpy-outlinebtn" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">New version</button>
        ${p.canDelete ? confirmAnchor(
          { label: "Delete prompt", act: p.deleteArm ? "promptDeleteCancel" : "promptDeleteArm", armed: p.deleteArm, controls: "prompt-delete-confirm" },
          {
            id: "prompt-delete-confirm", title: `Delete “${x.title}”?`,
            body: `It leaves the library, search and agents' get_prompt. ${deleteKeeps(p.versions.length || x.version)}, the slug stays reserved, and you can undo.`,
            confirmLabel: "Delete prompt", confirmAct: "promptDelete", cancelAct: "promptDeleteCancel", busy: p.deleteBusy,
          },
        ) : ""}
      </div>
    </div>

    <div class="cnpy-pdetail">
      <div class="cnpy-pdetail-main">
        ${x.description ? `<div style="${MONO_EYEBROW};margin-bottom:8px">Description</div><div style="font-size:14px;line-height:1.65;color:var(--fg-70);margin-bottom:30px;max-width:760px;text-wrap:pretty">${esc(x.description)}</div>` : ""}
        ${main}
      </div>

      <div class="cnpy-pdetail-rail" style="min-width:0;border-left:1px solid var(--border);padding-left:26px;display:flex;flex-direction:column;gap:26px">
        <div>
          ${railHead("Properties")}
          <div style="${PROP_ROW}"><div style="${PROP_KEY}">STATUS</div><div>${promptBadge(x.status)}</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_KEY}">UPDATED</div><div style="font-size:12.5px;color:var(--fg-70)">${esc(relTime(x.updated_at))}</div></div>
        </div>
        <div>
          ${railHead("Author")}
          <div style="display:flex;align-items:center;gap:10px;height:34px">${personChip(au, 24, x.author)}<span style="flex:1;min-width:0"><span style="display:block;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(au?.name || x.author)}</span>${handleTag(au, x.author, 11)}</span></div>
        </div>
        <div>
          ${railHead("Tags")}
          <div style="position:relative">
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              ${tags}
              <button data-act="promptTagMenu" class="cnpy-outlinebtn" aria-label="Add tag" title="Add tag" style="${addTagSt}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="M12 5v14M5 12h14"></path></svg>Tag</button>
            </div>
            ${tagMenu}
          </div>
        </div>
        <div>
          ${railHead("Version history")}
          <div style="display:flex;flex-direction:column;gap:2px;margin:0 -8px">${versions}</div>
          <div style="font-size:11px;color:var(--fg-40);margin-top:6px">Click a version to see what it changed.</div>
        </div>
      </div>
    </div>`);
}

// ── editor ───────────────────────────────────────────────────────────────────
export type PromptEditMode = "new" | "edit" | "version";
export interface PromptDraft {
  mode: PromptEditMode;
  baseSlug: string | null;
  title: string;
  slug: string;
  slugTouched: boolean;
  body: string;
  tags: string[];
  tagDraft: string;
  status: PromptStatus;
  summary: string;
  nextVersion: number;
}
export const blankPromptDraft = (): PromptDraft => ({
  mode: "new", baseSlug: null, title: "", slug: "", slugTouched: false, body: "", tags: [], tagDraft: "", status: "draft", summary: "", nextVersion: 1,
});
export function draftFromPrompt(p: PromptDetail, mode: "edit" | "version"): PromptDraft {
  return { mode, baseSlug: p.slug, title: p.title, slug: p.slug, slugTouched: true, body: p.body, tags: p.tags.slice(), tagDraft: "", status: mode === "version" ? "draft" : p.status, summary: "", nextVersion: p.version + 1 };
}
/** Whether the slug is well-formed and free (another prompt's slug is taken; the one being edited is not). */
export function slugState(ed: PromptDraft, taken: string[]): { ok: boolean; taken: boolean } {
  const isTaken = taken.some((s) => s === ed.slug && s !== ed.baseSlug);
  return { ok: /^[a-z0-9][a-z0-9-]{1,59}$/.test(ed.slug), taken: isTaken };
}

export interface PromptEditorProps { draft: PromptDraft | null; takenSlugs: string[] }

const FIELD = "border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);outline:none";

export function promptEditorView(p: PromptEditorProps): string {
  const ed = p.draft;
  const shell = (inner: string) => `<div data-screen-label="Prompt editor" style="${WORK_SHELL}">${inner}</div>`;
  if (!ed) return shell(notice("Loading…"));
  const vars = detectVars(ed.body);
  const s = slugState(ed, p.takenSlugs);
  const slugStatus = !ed.slug ? "" : s.taken ? "taken" : !s.ok ? "invalid" : ed.slugTouched ? "available" : "auto";
  const slugColor = s.taken || (!s.ok && ed.slug) ? "var(--red)" : ed.slugTouched ? "var(--green)" : "var(--fg-40)";
  const suggest = TAGS.filter((t) => !ed.tags.includes(t));
  const help = ed.status === "draft" ? "Only visible to you in the library until it's staged."
    : ed.status === "staged" ? "Shows as STAGED in the library until someone publishes it."
    : "Live for every session that pulls this slug.";
  const can = !!ed.title.trim() && !!ed.body.trim() && s.ok && !s.taken;

  return shell(`
  <div${surface("padding:26px 28px;display:flex;flex-direction:column;min-height:calc(100vh - 210px)")}>
    <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 288px;gap:32px;flex:1;min-height:0">
      <div style="min-width:0;display:flex;flex-direction:column">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Title</label>
        <input data-act="edTitle" data-field="edTitle" value="${attr(ed.title)}" class="cnpy-input" placeholder="What does this prompt do?" style="width:100%;height:40px;padding:0 13px;${FIELD};font-size:14px">
        <div style="display:flex;align-items:baseline;gap:10px;margin:20px 0 8px">
          <label style="display:block;font-size:13px;font-weight:500">Slug</label>
          ${ed.slugTouched ? `<button data-act="edResetSlug" class="cnpy-mutelink" style="font-size:11.5px;font-weight:500;color:var(--fg-40)">Reset to title</button>` : `<span style="font-size:11.5px;color:var(--fg-40)">— from the title; edit to pin it</span>`}
        </div>
        <div style="display:flex;align-items:center;border:1px solid var(--border-strong);border-radius:9px;background:transparent;overflow:hidden">
          <span style="font-family:var(--sans);font-size:13px;color:var(--fg-40);padding-left:12px;white-space:nowrap">prompts/</span>
          <input data-act="edSlug" data-field="edSlug" value="${attr(ed.slug)}" class="cnpy-input" autocomplete="off" spellcheck="false" maxlength="60" style="flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--fg);font-size:13px;padding:10px 12px 10px 2px;font-family:var(--sans)">
          <span style="font-family:var(--label);font-size:11px;padding:0 12px;white-space:nowrap;color:${slugColor}">${slugStatus}</span>
        </div>
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">Body <span style="font-weight:400;color:var(--fg-40)">— write <span style="font-family:var(--label)">{{name}}</span> for anything the caller fills in</span></label>
        <textarea data-act="edBody" data-field="edBody" placeholder="Review the endpoint {{endpoint}} in {{router_file}}…" style="width:100%;flex:1;min-height:260px;padding:12px 14px;${FIELD};font-size:12.5px;line-height:1.65;resize:vertical;font-family:var(--code)">${esc(ed.body)}</textarea>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">
          <span style="${MONO_EYEBROW}">Variables</span>
          <span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">${vars.length === 1 ? "1 detected" : `${vars.length} detected`}</span>
          ${vars.map((v) => `<span style="font-family:var(--label);font-size:11.5px;color:var(--accent);font-weight:600;background:var(--accent-soft);border-radius:4px;padding:1px 5px">{{${esc(v)}}}</span>`).join("")}
          ${vars.length ? "" : `<span style="font-size:11.5px;color:var(--fg-40)">none yet</span>`}
        </div>
      </div>
      <div style="min-width:0;border-left:1px solid var(--border);padding-left:26px">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Tags</label>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:38px;padding:5px 8px;border:1px solid var(--border-strong);border-radius:9px">
          ${ed.tags.map((t) => `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 9px;border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft);border-radius:999px;font-size:11.5px;font-weight:500;font-family:var(--label)">${esc(t)}<button data-act="edTagRemove" data-arg="${attr(t)}" class="cnpy-xbtn" aria-label="Remove tag" style="width:16px;height:16px;display:grid;place-items:center;border-radius:50%;color:var(--accent)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 5l14 14M19 5 5 19"></path></svg></button></span>`).join("")}
          <input data-act="edTagDraft" data-field="edTagDraft" value="${attr(ed.tagDraft)}" placeholder="Add a tag" style="flex:1;min-width:70px;border:none;outline:none;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--label);padding:3px 2px">
        </div>
        ${suggest.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${suggest.map((t) => `<button data-act="edTagAdd" data-arg="${attr(t)}" class="cnpy-pickchip" style="padding:3px 9px;border-radius:7px;font-size:11.5px;font-weight:500;border:1px solid var(--border);color:var(--fg-55);font-family:var(--label);white-space:nowrap">+ ${esc(t)}</button>`).join("")}</div>` : ""}
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">Status</label>
        ${segmented({
          id: "ed-status", ariaLabel: "Status", act: "edStatus", value: ed.status,
          options: (["draft", "staged", "published"] as const).map((k) => ({ value: k, label: `${k[0].toUpperCase()}${k.slice(1)}` })),
        })}
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">${help}</div>
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">What changed <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
        <input data-act="edSummary" data-field="edSummary" value="${attr(ed.summary)}" class="cnpy-input" placeholder="One line for the version history" style="width:100%;height:38px;padding:0 12px;${FIELD};font-size:12.5px">
        <div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);margin-top:18px;line-height:1.6">${ed.mode === "new" ? "Saving creates v1." : `Saving creates v${ed.nextVersion}. v${ed.nextVersion - 1} stays in the history.`}</div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
      <button data-act="edCancel" class="cnpy-outlinebtn" style="padding:8px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease;white-space:nowrap">Cancel</button>
      <button data-act="edSave" class="${can ? "cnpy-accentbtn" : ""}" style="${primaryStyle(can)}">Save v${ed.nextVersion}</button>
    </div>
  </div>`);
}

/** The prompt page's expanded body — the same modal a handoff's prompt opens. */
export function promptPageModal(x: PromptDetail): string {
  return promptModal({ title: x.title, body: x.body, copyAct: "promptCopy", closeAct: "promptExpandClose" });
}
