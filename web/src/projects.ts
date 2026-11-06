// Projects — the screens (docs/superpowers/specs/2026-11-05-projects.md › The screen): the Projects list
// (`#projects`), a project's home (`#project/<slug>`), and the dialogs — New project / Edit details, Add to <project>,
// Share, Delete. Ported from the Claude Design canvas "Trov Projects" (2026-11-05-projects.dc.html), built from Trov's
// own pieces: the Library's cards and list rows (`cnpy-lib-card`, `cnpy-lib-item`), the search bar (`cnpy-sfbar`)
// with a `dropdown()` for Sort, `segmented()` for All · Mine · Shared with me and for who can see it, `tabBar()` for
// Chats · Artifacts, `confirmModal` for every dialog, `spaceTile` for the project's tile (a project's icon and colour
// are the spaces' sets), Ask's ref views for a pin's live status, people.ts for every person, and `skeleton` /
// `emptyLayout` for the two states. Pure: props in, markup out. The reads and writes are web/src/projects-actions.ts.
import {
  PROJECT_ICONS, PROJECT_COLORS, PROJECT_LIMITS, PROJECT_PIN_TYPES, PROJECT_VISIBILITY_WORDS, canEditProject,
  type ProjectDetail, type ProjectList, type ProjectSummary, type ProjectVisibility, type ProjectPin, type ProjectPinType,
  type ProjectIcon, type ProjectColor, type ProjectRole, type ProjectArtifact,
} from "@shared/projects-core";
import { ASK_ATTACH_BYTES_MAX, ASK_ATTACH_FILES_MAX, parseAskRef, type AskThreadSummary, type PeekResult, type RefView } from "@shared/ai-ask-core";
import type { PersonSummary } from "@shared/people";
import { capReached } from "@shared/plans";
import { esc, attr, surface, hitArea, HITBOX, relTime } from "./ui";
import { personChip, handleTag } from "./people";
import { avatarStack } from "./tickets";
import { markShape } from "./marks";
import { segmented } from "./segmented";
import { tabBar, tabPanelAttrs } from "./tabs";
import { dropdown, type DropdownProps, type DropdownUi } from "./dropdown";
import { confirmModal } from "./confirm";
import { skeleton, skBar, skBox, skLine, skList, skCard, skW, emptyLayout } from "./skeleton";
import { spaceTile, spaceIconSvg, ICON_WORD, COLOR_WORD } from "./library";
import { askIcon, REF_ICON } from "./ask-icons";
import { refStatusMark, repoFactsOf, repoMark, refLabel } from "./ask-refs";
import { threadTime } from "./ask-threads";
import type { AskRefHit } from "./ask-api";

// ── state ────────────────────────────────────────────────────────────────────

/** A read's status, as the app's `Loadable` (render.ts) has it. */
export interface ProjLoad<T> { status: "idle" | "loading" | "ok" | "error"; data: T }

export type ProjectFilter = "all" | "mine" | "shared";
export const PROJECT_SORTS = ["updated", "name"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];
export type ProjectTab = "chats" | "artifacts";
/** The Add to <project> dialog's type switch. */
export const PIN_TYPE_TABS = ["all", "ticket", "sprint", "doc", "pr", "artifact"] as const;
export type PinTypeTab = (typeof PIN_TYPE_TABS)[number];

/** New project / Edit details. */
export interface ProjectDraft {
  mode: "new" | "edit";
  /** The project edited (Edit only). */
  slug: string | null;
  name: string;
  description: string;
  icon: ProjectIcon;
  color: ProjectColor;
  visibility: ProjectVisibility;
  busy: boolean;
  error: string | null;
}
/** Add to <project>: the search, the type switch, what the search found (as refs, with their views), what is picked. */
export interface PinPick {
  q: string;
  type: PinTypeTab;
  status: "idle" | "loading" | "ok" | "error";
  hits: AskRefHit[];
  /** The hits' views (marks, an artifact's visibility), from `POST /ask/peek`. */
  views: Record<string, PeekResult>;
  sel: string[];
  /** The artifact whose Publish to org is out. */
  publishing: string | null;
  uploading: boolean;
  busy: boolean;
  error: string | null;
}
/** Share: who can see it and the members, each with a role. Nothing is written until Save. */
export interface ShareDraft {
  visibility: ProjectVisibility;
  members: { handle: string; role: ProjectRole }[];
  busy: boolean;
  error: string | null;
}
export type ProjectDialog =
  | { kind: "edit"; draft: ProjectDraft }
  | { kind: "pin"; pick: PinPick }
  | { kind: "share"; share: ShareDraft }
  | { kind: "delete"; slug: string; busy: boolean; error: string | null };

/** `AppState.projects`: the screens' reads and their own state. */
export interface ProjectsUi {
  /** `GET /projects`: the list (the Projects screen, Ask's Move to project, the cap). */
  list: ProjLoad<ProjectList | null>;
  /** `GET /projects/:project`: the open project's page — or the project of the thread open in Ask (its pins count,
   *  its chats). `ok` with null data = no such project (or one the person can't open: the one 404). */
  detail: ProjLoad<ProjectDetail | null>;
  /** The project whose home is on screen (`#project/<slug>`). */
  slug: string | null;
  q: string;
  filter: ProjectFilter;
  sort: ProjectSort;
  archivedOpen: boolean;
  /** The list row whose ⋯ menu is open (its slug), and the project page's ⋯ menu. */
  rowMenu: string | null;
  headMenu: boolean;
  tab: ProjectTab;
  /** The instructions being edited in place (null = not editing), and whether the save is out. */
  instr: string | null;
  instrBusy: boolean;
  dialog: ProjectDialog | null;
  /** The archived project whose Restore is out; the pin whose remove is out. */
  restoring: string | null;
  unpinning: string | null;
}
export const initialProjectsUi = (): ProjectsUi => ({
  list: { status: "idle", data: null }, detail: { status: "idle", data: null }, slug: null,
  q: "", filter: "all", sort: "updated", archivedOpen: false, rowMenu: null, headMenu: false, tab: "chats",
  instr: null, instrBusy: false, dialog: null, restoring: null, unpinning: null,
});

// ── words ────────────────────────────────────────────────────────────────────

export const PROJECTS_SUBTITLE = "One place for a piece of work: its instructions, the tickets and docs it's about, and the chats and artifacts made for it. Trov reads all of it in every chat inside the project.";
export const PROJECTS_EMPTY = "A project holds one piece of work: its instructions, the tickets and docs it's about, and the chats made for it. Create one, then pin what it's about.";
export const PROJECT_CHATS_EMPTY = "Chats you start here show up here. Each one reads the project's instructions and Knowledge.";
export const PROJECT_ARTS_EMPTY = "Artifacts saved from this project's chats, and files uploaded here, show up here.";
export const PROJECT_PINS_EMPTY = "Pin the tickets, sprints, docs and PRs this work is about, or upload files. A pinned ticket always shows its current status.";
export const PROJECT_CHATS_NOTE = "Your chats here are yours. To show one to the project, open it and share it from its ⋯ menu.";
export const PROJECT_INSTR_EMPTY = "No instructions yet. Tell Trov what this work is and how to answer.";
export const PROJECT_INSTR_NOTE = "Trov reads these in every chat in this project.";
export const PROJECT_NEW_INTRO = "A project holds the context for one piece of work. Chats and artifacts made in it stay with it.";
export const PROJECT_HIDDEN_PIN = "An item you don't have access to";
export const PROJECT_SHARE_NOTE = "Editors change instructions and Knowledge. Viewers read them and start their own chats. Chats stay with whoever started them.";
export const PROJECT_PIN_INTRO = "Pinned items stay live. Trov reads them first in every chat here.";
export const PROJECT_READ_FAILED = "Couldn't load this.";
export const PROJECT_NOT_FOUND = "There is no project here. It may have been deleted, or it isn't shared with you.";

/** The delete confirmation's sentence (the spec's copy). */
export const deleteProjectText = (chats: number, arts: number): string =>
  `Its ${chats} ${chats === 1 ? "chat is" : "chats are"} deleted, including any shared with the project.${arts ? ` Its ${arts} ${arts === 1 ? "artifact stays" : "artifacts stay"} in Artifacts.` : ""} The tickets, docs and PRs it pinned aren't touched.`;
/** The toast after a delete, with what went (the server's count of every thread in it); no clause at none. */
export const deletedProjectText = (name: string, chats: number): string =>
  chats > 0 ? `${name} deleted, with its ${chats} ${chats === 1 ? "chat" : "chats"}` : `${name} deleted`;
/** A visibility's hint, with the org's own name for "the org". */
export const visibilityHint = (v: ProjectVisibility, org: string): string => PROJECT_VISIBILITY_WORDS[v].hint.replace(/the org/g, org);
/** A visibility's label (the switch's options): the org's own name for Org. */
export const visibilityLabel = (v: ProjectVisibility, org: string): string => (v === "org" ? org : PROJECT_VISIBILITY_WORDS[v].label);

/** Free (or any capped plan) at its `projects` limit. */
export const atProjectCap = (l: ProjectList["limit"] | null | undefined): boolean => !!l && l.cap !== null && l.used >= l.cap;
/** The cap's sentence, said differently to an owner (who can upgrade) and to everyone else. */
export function capText(l: ProjectList["limit"], owner: boolean, plan: string): string {
  const used = `${owner ? "You've" : "This organization has"} used the ${l.cap} projects ${plan} includes.`;
  return owner ? `${used} Archive one, or upgrade to Pro for unlimited projects.` : `${used} An owner can upgrade, or archive one.`;
}

/** Add to Knowledge past the project's `project_pins` room (`cap` null = unlimited: never): the sentence the dialog
 *  says instead of sending, worded as the projects cap is (`capText`); null when the pick fits. */
export function pinRoomText(l: ProjectDetail["pinLimit"], adding: number, owner: boolean, plan: string): string | null {
  if (l.cap === null || !capReached(l.used, l.cap, adding)) return null;
  const left = Math.max(0, l.cap - l.used);
  const used = left ? `This project has used ${l.used} of the ${l.cap} pinned items ${plan} includes.` : `This project has used all ${l.cap} pinned items ${plan} includes.`;
  const next = left ? `Pick ${left} or fewer` : "Unpin one first";
  return `${used} ${next}${owner ? ", or upgrade for more." : ", or ask an owner to upgrade."}`;
}

/** Files for Knowledge past Ask's attachment rules (`ASK_ATTACH_FILES_MAX` a time, `ASK_ATTACH_BYTES_MAX` each), said in
 *  the project's words before anything is sent; null when they may go. The server checks the same (and the type). */
export function uploadRefusalText(files: readonly { name: string; size: number }[]): string | null {
  if (files.length > ASK_ATTACH_FILES_MAX) return `Add at most ${ASK_ATTACH_FILES_MAX} files at a time.`;
  const big = files.find((f) => f.size > ASK_ATTACH_BYTES_MAX);
  return big ? `${big.name} is too large. Files can be up to ${ASK_ATTACH_BYTES_MAX / (1024 * 1024)} MB.` : null;
}

const VIS_ICON: Record<ProjectVisibility, readonly string[]> = {
  private: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  members: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  org: ["M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16", "M16 9h2a2 2 0 0 1 2 2v10", "M2 21h20", "M8 7h4M8 11h4M8 15h4"],
};
const visIcon = (v: ProjectVisibility, size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none">${VIS_ICON[v].map((d) => `<path d="${d}"></path>`).join("")}</svg>`;
/** "Who can see it" in the list and on a card: Private, "N members", or the org's name. */
export const visWord = (p: Pick<ProjectSummary, "visibility" | "memberCount">, org: string): string =>
  p.visibility === "members" ? `${p.memberCount} ${p.memberCount === 1 ? "member" : "members"}` : visibilityLabel(p.visibility, org);

const findPerson = (persons: readonly PersonSummary[], h: string | null | undefined): PersonSummary | null =>
  h ? persons.find((p) => p.handle.toLowerCase() === h.toLowerCase()) ?? null : null;
const nameOf = (persons: readonly PersonSummary[], h: string): string => findPerson(persons, h)?.name || h;
const firstName = (persons: readonly PersonSummary[], h: string): string => nameOf(persons, h).split(/\s+/)[0];
const sameHandle = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const shortDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
/** "Updated": "5m ago", "4d ago", "Oct 23" — "—" when unknown. */
const updatedWord = (iso: string | null): string => relTime(iso) || "—";

/** A project's tile (the spaces' tile: its colour, its white icon). */
export const projectTile = (p: { icon: string; color: string }, size: number): string => spaceTile(p, size);

// ── shared bits ──────────────────────────────────────────────────────────────

const PLUS = (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
const DOTS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>`;
const CHEV = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" class="pj-chev"><path d="M9 6l6 6-6 6"></path></svg>`;
const X = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>`;
const SHARE_IC = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z"></path><path d="M19 8v6M22 11h-6"></path></svg>`;
const CHAT_IC = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path></svg>`;
const UPLOAD_IC = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"></path></svg>`;
const H2 = "font-size:14px;font-weight:500;letter-spacing:-0.005em;color:var(--fg);margin:0";
const GROUP_LABEL = "font-size:11.5px;font-weight:500;letter-spacing:.04em;color:var(--fg-55)";
const accentBtn = (act: string, arg: string | null, label: string, icon = PLUS()): string =>
  `<button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""} data-confirm-trigger class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap">${icon}${esc(label)}</button>`;
const outlineBtn = (act: string, arg: string | null, label: string, o: { icon?: string; busy?: boolean; small?: boolean; extra?: string } = {}): string =>
  `<button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""}${o.busy ? ` disabled aria-busy="true"` : ""}${o.extra ?? ""} class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:7px;padding:${o.small ? "5px 11px" : "7px 13px"};border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap">${o.icon ?? ""}${esc(label)}</button>`;
const menuItem = (act: string, arg: string, label: string, extra = ""): string =>
  `<button type="button" role="menuitem" data-act="${attr(act)}" data-arg="${attr(arg)}" class="cnpy-dp-mi"${extra}>${esc(label)}</button>`;

/** A read that failed, in place of what it would have drawn: the sentence and Try again. */
export function readFailed(act: string, arg: string | null = null): string {
  return `<div${surface("padding:18px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap")} role="alert" data-pj-failed>${markShape("diamond", "var(--red)", 9)}<span style="font-size:13px;color:var(--fg-70)">${esc(PROJECT_READ_FAILED)}</span><button type="button" data-act="${attr(act)}"${arg !== null ? ` data-arg="${attr(arg)}"` : ""} class="cnpy-link" style="padding:0;font-size:13px;font-weight:500;color:var(--accent)">Try again</button></div>`;
}

// ── the Projects list (`#projects`) ──────────────────────────────────────────

export interface ProjectsListProps {
  list: ProjLoad<ProjectList | null>;
  ui: Pick<ProjectsUi, "q" | "filter" | "sort" | "archivedOpen" | "rowMenu" | "restoring">;
  me: string | null;
  persons: readonly PersonSummary[];
  org: string;
  /** The reader's role in the org: an admin may archive / delete any project; an owner can upgrade. */
  role: "owner" | "admin" | "member" | null;
  /** The org's plan's name ("Free"), for the cap's sentence. */
  plan: string;
  dd: DropdownUi;
}

const LIST_FRAME = "max-width:1120px;margin:0 auto;padding:28px 40px 90px";
const CARD_GRID = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px";
const ROW_COLS = "minmax(0,1fr) 130px 120px 62px 62px 90px 34px";

/** The Sort control (a pick-one with no room for a switch: `dropdown()`). Its menu is drawn at the root. */
export const sortDropdown = (sort: ProjectSort): DropdownProps => ({
  id: "pj-sort", act: "projSort", value: sort, size: "sm", ariaLabel: "Sort projects",
  options: [{ value: "updated", label: "Recently updated", shown: "Sort: Recently updated" }, { value: "name", label: "Name", shown: "Sort: Name" }],
});

/** The list's rows after search, the switch and Sort — searched in the loaded list, on the client. */
export function shownProjects(all: readonly ProjectSummary[], ui: Pick<ProjectsUi, "q" | "filter" | "sort">, me: string | null): ProjectSummary[] {
  const q = ui.q.trim().toLowerCase();
  const rows = all.filter((p) => (ui.filter === "all" || (ui.filter === "mine" ? sameHandle(p.owner, me) : !sameHandle(p.owner, me)))
    && (!q || `${p.name} ${p.description}`.toLowerCase().includes(q)));
  return ui.sort === "name" ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function projectCard(p: ProjectSummary, persons: readonly PersonSummary[], org: string): string {
  const sep = `<span style="color:var(--border-strong)">·</span>`;
  return `<div${surface("min-height:150px;padding:16px 18px;display:flex;flex-direction:column", { hover: true, cls: `${HITBOX} cnpy-lib-card` })} data-project="${attr(p.slug)}">
    <div style="display:flex;align-items:center;gap:11px;min-width:0">${projectTile(p, 32)}<span style="font-size:15px;font-weight:500;letter-spacing:-0.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span></div>
    <p style="font-size:12.5px;line-height:1.5;margin:10px 0 0;color:${p.description ? "var(--fg-55)" : "var(--fg-40)"}">${esc(p.description || "No description yet.")}</p>
    <div style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:14px;font-size:12px;color:var(--fg-55);flex-wrap:wrap">${avatarStack(p.people.slice(0, 3), persons as PersonSummary[], 18)}<span>${esc(`${p.chats} ${p.chats === 1 ? "chat" : "chats"} · ${p.pins} pinned`)}</span>${sep}<span style="display:inline-flex;align-items:center;gap:5px">${visIcon(p.visibility)}${esc(visWord(p, org))}</span></div>
    ${hitArea("projOpen", p.slug, `Open ${p.name}`)}
  </div>`;
}
const cardShape = (i: number): string => skCard(`<div style="display:flex;align-items:center;gap:11px">${skBox(32, 32)}${skLine(skW(i, ["48%", "62%", "40%"]), 15, 1.3)}</div>
    <div style="margin-top:12px">${skLine("92%", 12.5, 1.5)}${skLine(skW(i + 1, ["66%", "54%", "72%"]), 12.5, 1.5)}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:14px">${skBox(18, 18)}${skBar(110, 9)}</div>`, "min-height:150px;padding:16px 18px;display:flex;flex-direction:column");

/** Who may do what with a project from the list (the server re-checks every write). */
export const canArchive = (p: Pick<ProjectSummary, "access">, admin: boolean): boolean => canEditProject(p.access) || admin;
export const canDelete = (p: Pick<ProjectSummary, "access">, admin: boolean): boolean => p.access === "owner" || admin;

function rowMenu(p: ProjectSummary, admin: boolean): string {
  const items = [
    menuItem("projOpen", p.slug, "Open"),
    canEditProject(p.access) ? menuItem("projEdit", p.slug, "Edit details", " data-confirm-trigger") : "",
    canArchive(p, admin) ? menuItem("projArchive", p.slug, "Archive") : "",
    canDelete(p, admin) ? menuItem("projDelete", p.slug, "Delete project", ` data-confirm-trigger style="color:var(--red)"`) : "",
  ].join("");
  return `<div class="cnpy-dp-menu pj-rowmenu" role="menu" aria-label="${attr(p.name)}">${items}</div>`;
}

function projectRow(p: ProjectSummary, o: { persons: readonly PersonSummary[]; org: string; me: string | null; admin: boolean; menu: boolean }): string {
  const owner = findPerson(o.persons, p.owner);
  const num = (n: number) => `<span style="text-align:right;font-size:12.5px;color:var(--fg-70);font-variant-numeric:tabular-nums">${n}</span>`;
  return `<div class="${HITBOX} pj-row${o.menu ? " has-menu" : ""}" data-project-row="${attr(p.slug)}" style="display:grid;grid-template-columns:${ROW_COLS};gap:12px;align-items:center;padding:11px 16px;border-top:1px solid var(--border)">
    <div style="display:flex;align-items:flex-start;gap:11px;min-width:0"><span style="display:flex;flex:none;margin-top:2px">${projectTile(p, 14)}</span><div style="min-width:0"><div style="font-size:13.5px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div><div style="font-size:12px;color:var(--fg-55);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.description || "No description yet.")}</div></div></div>
    <span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--fg-70);min-width:0"><span style="display:flex;color:var(--fg-55)">${visIcon(p.visibility, 13)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(visWord(p, o.org))}</span></span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--fg-70);min-width:0">${personChip(owner, 18, p.owner)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sameHandle(p.owner, o.me) ? "You" : nameOf(o.persons, p.owner))}</span></span>
    ${num(p.chats)}${num(p.pins)}
    <span style="text-align:right;font-size:12px;color:var(--fg-55)">${esc(updatedWord(p.updatedAt))}</span>
    <span style="position:relative;display:flex;justify-content:flex-end"><button type="button" class="cnpy-iconbtn cnpy-hitctl" data-act="projRowMenu" data-arg="${attr(p.slug)}" aria-label="${attr(`Options for ${p.name}`)}" aria-haspopup="menu" aria-expanded="${o.menu}" style="display:grid;place-items:center;width:28px;height:28px;border-radius:7px;color:var(--fg-55)">${DOTS}</button>${o.menu ? rowMenu(p, o.admin) : ""}</span>
    ${hitArea("projOpen", p.slug, `Open ${p.name}`)}
  </div>`;
}
const rowShape = (i: number): string =>
  `<div class="pj-rowsk" style="display:grid;grid-template-columns:${ROW_COLS};gap:12px;align-items:center;padding:11px 16px;border-top:1px solid var(--border)"><div style="display:flex;gap:11px">${skBox(14, 14)}<div style="flex:1">${skLine(skW(i), 13.5, 1.3)}<div style="margin-top:4px">${skLine(skW(i + 2), 12, 1.3)}</div></div></div>${skBar(80, 9)}${skBar(70, 9)}${skBar(20, 9)}${skBar(20, 9)}${skBar(50, 9)}<span></span></div>`;
const tableHead = (): string =>
  `<div class="pj-th" style="display:grid;grid-template-columns:${ROW_COLS};gap:12px;align-items:center;padding:9px 16px;font-size:11.5px;font-weight:500;letter-spacing:.04em;color:var(--fg-55)"><span>Project</span><span>Who can see it</span><span>Owner</span><span style="text-align:right">Chats</span><span style="text-align:right">Pinned</span><span style="text-align:right">Updated</span><span></span></div>`;

function archivedSection(p: ProjectsListProps, archived: readonly ProjectSummary[], admin: boolean): string {
  if (!archived.length) return "";
  const open = p.ui.archivedOpen;
  const rows = archived.map((a, i) => {
    const busy = p.ui.restoring === a.slug;
    const by = a.archivedBy ? ` by ${nameOf(p.persons, a.archivedBy)}` : "";
    const line = `Archived ${shortDate(a.archivedAt)}${by} · ${a.chats} ${a.chats === 1 ? "chat" : "chats"} · ${a.pins} pinned`;
    return `<div class="pj-arch" data-project-archived="${attr(a.slug)}" style="display:flex;align-items:center;gap:11px;padding:11px 16px${i ? ";border-top:1px solid var(--border)" : ""}"><span style="display:flex;opacity:.6">${projectTile(a, 14)}</span><div style="flex:1;min-width:0"><div style="font-size:13.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div><div style="font-size:12px;color:var(--fg-55);margin-top:2px">${esc(line)}</div></div>${canArchive(a, admin) ? outlineBtn("projRestore", a.slug, busy ? "Restoring…" : "Restore", { busy, small: true }) : ""}</div>`;
  }).join("");
  return `<button type="button" data-act="projArchivedToggle" class="cnpy-link pj-archgo" aria-expanded="${open}" style="display:inline-flex;align-items:center;gap:6px;margin-top:14px;padding:0;font-size:12.5px;font-weight:500;color:var(--fg-55)">${CHEV}Archived · ${archived.length}</button>
    ${open ? `<div${surface("padding:0;overflow:hidden;margin-top:10px")}>${rows}</div>` : ""}`;
}

function listTitle(): string {
  return `<div style="min-width:0"><h1 style="font-size:24px;font-weight:650;letter-spacing:-0.02em;margin:0;line-height:1.2">Projects</h1>
    <p style="font-size:13.5px;line-height:1.5;color:var(--fg-70);max-width:600px;margin:6px 0 0">${esc(PROJECTS_SUBTITLE)}</p></div>`;
}

/** The cap's notice (Free at its `projects` limit): Upgrade to Pro for the owner; the rest are told who can. */
function capNotice(l: ProjectList["limit"], role: ProjectsListProps["role"], plan: string): string {
  const owner = role === "owner";
  return `<div class="pj-cap" role="status" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:16px;padding:10px 14px;border-radius:8px;background:var(--hover);font-size:12.5px;line-height:1.5;color:var(--fg-70)">${markShape("triangle", "var(--amber)", 10)}<span style="flex:1;min-width:0">${esc(capText(l, owner, plan))}</span>${owner ? `<button type="button" data-act="projUpgrade" class="cnpy-outlinebtn" style="padding:4px 10px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70);white-space:nowrap">Upgrade to Pro</button>` : ""}</div>`;
}

export function projectsListView(p: ProjectsListProps): string {
  const head = listTitle();
  const admin = p.role === "owner" || p.role === "admin";
  const l = p.list;
  const toolbar = (count: string) => `<div class="pj-tools" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:22px 0 0">
    <div class="cnpy-sfbar pj-sfbar"><div class="cnpy-sfbar-q"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg><input data-act="projQ" data-field="projQ" class="cnpy-search-in" style="font-size:12.5px" placeholder="Search projects by name or description" aria-label="Search projects" value="${attr(p.ui.q)}" autocomplete="off" spellcheck="false"></div><span class="cnpy-sfbar-div" aria-hidden="true"></span>${dropdown(sortDropdown(p.ui.sort), p.dd)}</div>
    ${segmented({ id: "pj-filter", ariaLabel: "Show", act: "projFilter", value: p.ui.filter, size: "sm", className: "cnpy-seg--bar", inertOn: true, options: [{ value: "all", label: "All" }, { value: "mine", label: "Mine" }, { value: "shared", label: "Shared with me" }] })}
    <span class="pj-count" style="font-size:12px;color:var(--fg-40);white-space:nowrap;margin-left:auto;flex:none">${esc(count)}</span>
  </div>`;
  const frame = (inner: string) => `<div class="pj-list" data-screen-label="Projects" style="${LIST_FRAME}"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">${head}</div>${inner}</div>`;
  if ((l.status === "idle" || l.status === "loading") && !l.data) {
    return frame(`${toolbar("")}
      <h2 style="${H2};margin:26px 0 10px">Recent</h2>
      ${skeleton("pj-cards", "Loading projects…", `<div class="pj-grid" style="${CARD_GRID}">${skList(3, cardShape)}</div>`)}
      <h2 style="${H2};margin:34px 0 10px">All projects</h2>
      ${skeleton("pj-rows", "Loading projects…", skCard(`${tableHead()}${skList(4, rowShape)}`, "padding:0;overflow:hidden"))}`);
  }
  if (!l.data) return frame(`<div style="margin-top:26px">${readFailed("projRetry")}</div>`);
  const data = l.data;
  const cap = atProjectCap(data.limit) ? capNotice(data.limit, p.role, p.plan) : "";
  if (data.projects.length === 0) {
    return frame(`${cap}<div style="margin-top:26px">${emptyLayout("projects", { title: "No projects yet", text: PROJECTS_EMPTY, action: atProjectCap(data.limit) ? null : { label: "New project", act: "projNew" }, shapes: `<div class="pj-grid" style="${CARD_GRID}">${skList(3, cardShape)}</div>`, shapesStyle: "margin-top:12px" })}</div>
      ${archivedSection(p, data.archived, admin)}`);
  }
  const rows = shownProjects(data.projects, p.ui, p.me);
  const q = p.ui.q.trim();
  const showCards = !q && p.ui.filter === "all";
  const recent = [...data.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const cards = showCards ? `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:26px 0 10px"><h2 style="${H2}">Recent</h2></div>
    <div class="pj-grid cnpy-stagger" style="${CARD_GRID}">${recent.map((x) => projectCard(x, p.persons, p.org)).join("")}</div>` : "";
  const title = q ? "Matching projects" : p.ui.filter === "mine" ? "Projects you own" : p.ui.filter === "shared" ? "Shared with you" : "All projects";
  const none = q ? `No projects match “${q}”.` : p.ui.filter === "mine" ? "You don't own a project yet." : "Nobody has shared a project with you yet.";
  const body = rows.length
    ? rows.map((x) => projectRow(x, { persons: p.persons, org: p.org, me: p.me, admin, menu: p.ui.rowMenu === x.slug })).join("")
    : `<div class="pj-none" style="padding:22px 16px;font-size:13px;color:var(--fg-55);border-top:1px solid var(--border)">${esc(none)}</div>`;
  return frame(`${cap}${toolbar(`${rows.length} shown · ${data.projects.length} total`)}${cards}
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:34px 0 10px"><h2 style="${H2}">${esc(title)}</h2></div>
    <div${surface("padding:0", { cls: "pj-table" })}>${tableHead()}<div class="pj-rows">${body}</div></div>
    ${archivedSection(p, data.archived, admin)}`);
}

// ── a project's home (`#project/<slug>`) ─────────────────────────────────────

export interface ProjectHomeProps {
  slug: string | null;
  detail: ProjLoad<ProjectDetail | null>;
  ui: Pick<ProjectsUi, "headMenu" | "tab" | "instr" | "instrBusy" | "restoring" | "unpinning">;
  me: string | null;
  persons: readonly PersonSummary[];
  org: string;
  admin: boolean;
  /** Ask's composer for a new thread in this project (render.ts passes `composerView`), or "" while it is not ready. */
  composer: string;
}

const HOME_FRAME = "max-width:1180px;margin:0 auto;padding:28px 40px 90px";

function homeHeaderSkeleton(): string {
  return skeleton("pj-head", "Loading the project…", `<div style="display:flex;align-items:flex-start;gap:14px">${skBox(40, 40)}<div style="flex:1">${skBox(220, 24)}<div style="margin-top:10px">${skLine("52%", 13.5, 1.5)}</div><div style="display:flex;align-items:center;gap:8px;margin-top:10px">${skBox(18, 18)}${skBox(18, 18)}${skBar(160, 9)}</div></div><div style="display:flex;gap:8px">${skBox(80, 32)}${skBox(33, 33)}</div></div>`);
}

/** The visibility line under the name: "Private · only you", "3 members · owned by you", "Everyone in X · 2 editors". */
export function visLine(d: ProjectDetail, me: string | null, persons: readonly PersonSummary[], org: string): string {
  const p = d.project;
  if (p.visibility === "private") return "Private · only you";
  if (p.visibility === "members") return `${p.memberCount} ${p.memberCount === 1 ? "member" : "members"} · owned by ${sameHandle(p.owner, me) ? "you" : nameOf(persons, p.owner)}`;
  const editors = d.members.filter((m) => m.role !== "viewer").length;
  return `Everyone in ${org} · ${editors} ${editors === 1 ? "editor" : "editors"}`;
}

function headMenu(d: ProjectDetail, open: boolean, admin: boolean): string {
  const p = d.project;
  const edit = canEditProject(p.access) && !p.archivedAt;
  const items = [
    edit ? menuItem("projEdit", p.slug, "Edit details", " data-confirm-trigger") : "",
    edit ? menuItem("projShare", p.slug, "Members and visibility", " data-confirm-trigger") : "",
    canArchive(p, admin) && !p.archivedAt ? menuItem("projArchive", p.slug, "Archive") : "",
  ].filter(Boolean);
  const del = canDelete(p, admin) ? menuItem("projDelete", p.slug, "Delete project", ` data-confirm-trigger style="color:var(--red)"`) : "";
  if (!items.length && !del) return "";
  return `<span style="position:relative;display:inline-flex"><button type="button" class="cnpy-iconbtn" data-act="projHeadMenu" aria-label="Project options" aria-haspopup="menu" aria-expanded="${open}" style="width:33px;height:33px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">${DOTS}</button>${open ? `<div class="cnpy-dp-menu pj-headmenu" role="menu" aria-label="${attr(p.name)}">${items.join("")}${items.length && del ? `<div class="pj-menu-sep" role="separator"></div>` : ""}${del}</div>` : ""}</span>`;
}

function homeHeader(p: ProjectHomeProps, d: ProjectDetail): string {
  const x = d.project;
  const people = x.people.slice(0, 3);
  const acts = x.archivedAt
    ? `${canArchive(x, p.admin) ? accentBtn("projRestore", x.slug, p.ui.restoring === x.slug ? "Restoring…" : "Restore", "") : ""}${headMenu(d, p.ui.headMenu, p.admin)}`
    : `${canEditProject(x.access) ? outlineBtn("projShare", x.slug, "Share", { icon: SHARE_IC, extra: " data-confirm-trigger" }) : ""}${headMenu(d, p.ui.headMenu, p.admin)}`;
  return `<div class="pj-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">
    <div style="display:flex;align-items:flex-start;gap:14px;min-width:0;flex:1">${projectTile(x, 40)}
      <div style="min-width:0"><h1 style="font-size:24px;font-weight:650;letter-spacing:-0.02em;margin:0;line-height:1.2;overflow-wrap:anywhere">${esc(x.name)}</h1>
        ${x.description ? `<p style="font-size:13.5px;line-height:1.5;color:var(--fg-70);max-width:620px;margin:6px 0 0">${esc(x.description)}</p>` : ""}
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--fg-55);flex-wrap:wrap">${avatarStack(people, p.persons as PersonSummary[], 18)}<span style="display:inline-flex;align-items:center;gap:5px">${visIcon(x.visibility)}${esc(visLine(d, p.me, p.persons, p.org))}</span></div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex:none">${acts}</div>
  </div>`;
}

/** The archived project's line, in the composer's place: it is read-only, and Restore (who may). */
function archivedLine(d: ProjectDetail, p: ProjectHomeProps): string {
  const x = d.project;
  const by = x.archivedBy ? ` by ${nameOf(p.persons, x.archivedBy)}` : "";
  return `<div class="pj-archived" role="note" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-radius:8px;background:var(--hover);font-size:13px;line-height:1.5;color:var(--fg-70)">${markShape("square", "var(--fg-40)", 9)}<span style="flex:1;min-width:0">${esc(`Archived ${shortDate(x.archivedAt)}${by}. It's read-only, and a new chat here doesn't use its instructions or Knowledge.`)}</span>${canArchive(x, p.admin) ? outlineBtn("projRestore", x.slug, p.ui.restoring === x.slug ? "Restoring…" : "Restore", { busy: p.ui.restoring === x.slug, small: true }) : ""}</div>`;
}

/** Whose a chat in the project is, and how it reaches the reader: "You · 20:41", "Jose · Shared with SaplingLearn, can read · Sun". */
function chatMeta(t: AskThreadSummary, persons: readonly PersonSummary[], org: string): string {
  const when = threadTime(t);
  if (!t.viewer) return `You · ${when}`;
  const owner = t.owner ? firstName(persons, t.owner) : "Someone";
  const how = `${t.direct ? "Shared with you" : `Shared with ${org}`}, ${t.access === "continue" ? "can continue" : "can read"}`;
  return `${owner} · ${how} · ${when}`;
}

function chatsPanel(d: ProjectDetail, p: ProjectHomeProps): string {
  if (!d.chats.length) {
    return emptyLayout("pj-chats", { text: PROJECT_CHATS_EMPTY, shapes: skCard(skList(2, (i) => `<div style="padding:11px 16px${i ? ";border-top:1px solid var(--border)" : ""}">${skLine(skW(i, ["44%", "68%"]), 13.5, 1.4)}</div>`), "padding:0;overflow:hidden"), shapesStyle: "margin-top:12px" });
  }
  const rows = d.chats.map((t, i) => {
    const who = t.viewer ? t.owner ?? "" : p.me ?? "";
    return `<div class="cnpy-lib-item pj-chat ${HITBOX}" data-pj-chat="${t.id}" style="display:flex;align-items:flex-start;gap:11px;padding:11px 16px${i ? ";border-top:1px solid var(--border)" : ""}">
      <span style="display:flex;flex:none;margin-top:2px;color:var(--fg-55)">${CHAT_IC}</span>
      <div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:10px;min-width:0"><span style="font-size:13.5px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(t.title || "New thread")}</span>${t.pinned ? `<span style="font-size:12px;color:var(--fg-55)">Pinned</span>` : ""}</div>
        <div style="display:flex;align-items:center;gap:7px;margin-top:4px;font-size:12px;color:var(--fg-55);min-width:0">${personChip(findPerson(p.persons, who), 16, who || "?")}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(chatMeta(t, p.persons, p.org))}</span></div></div>
      ${hitArea("projChat", String(t.id), `Open ${t.title || "the thread"}`)}
    </div>`;
  }).join("");
  return `<div${surface("padding:0;overflow:hidden")}>${rows}</div><p style="font-size:12px;color:var(--fg-55);margin:10px 0 0">${esc(PROJECT_CHATS_NOTE)}</p>`;
}

function artifactCard(a: ProjectArtifact, persons: readonly PersonSummary[]): string {
  const preview = a.preview
    ? `<div class="pj-art-pv" style="height:112px;box-sizing:border-box;padding:14px 18px;font-size:12px;line-height:1.55;color:var(--fg-55);background:var(--bg);border-bottom:1px solid var(--border);overflow:hidden;white-space:pre-line">${esc(a.preview)}</div>`
    : `<div class="pj-art-pv" style="height:112px;box-sizing:border-box;display:grid;place-items:center;background:var(--bg);border-bottom:1px solid var(--border);color:var(--fg-40)">${askIcon("artifacts", 22, null, 1.6)}</div>`;
  return `<div${surface("padding:0;overflow:hidden;display:flex;flex-direction:column", { hover: true, cls: HITBOX })} data-pj-art="${attr(a.slug)}">${preview}
    <div style="padding:12px 16px 14px"><div style="font-size:14.5px;font-weight:600;letter-spacing:-0.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.title)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--fg-55);min-width:0">${personChip(findPerson(persons, a.author), 18, a.author)}<span>${esc(firstName(persons, a.author))}</span><span>${esc(a.kind)}</span><span>${a.visibility === "private" ? "Private" : "Org"}</span><span style="margin-left:auto;white-space:nowrap">${esc(updatedWord(a.updatedAt))}</span></div></div>
    ${hitArea("projArtifact", a.slug, `Open ${a.title}`)}
  </div>`;
}
function artifactsPanel(d: ProjectDetail, p: ProjectHomeProps): string {
  if (!d.artifacts.length) return emptyLayout("pj-arts", { text: PROJECT_ARTS_EMPTY, shapes: `<div class="pj-arts" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">${skList(2, () => skCard(`${skBox("100%", 112)}<div style="padding:12px 16px">${skLine("60%", 14.5, 1.3)}</div>`, "padding:0;overflow:hidden"))}</div>`, shapesStyle: "margin-top:12px" });
  return `<div class="pj-arts cnpy-stagger" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">${d.artifacts.map((a) => artifactCard(a, p.persons)).join("")}</div>`;
}

function instructionsCard(d: ProjectDetail, p: ProjectHomeProps): string {
  const x = d.project;
  const edit = canEditProject(x.access) && !x.archivedAt;
  const draft = p.ui.instr;
  const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><h2 style="${H2};flex:1">Instructions</h2>${edit && draft === null ? `<button type="button" data-act="projInstrEdit" class="cnpy-link" style="padding:0;font-size:12.5px;font-weight:500;color:var(--fg-55)">Edit</button>` : ""}</div>`;
  if (edit && draft !== null) {
    return `<section${surface("padding:16px 18px", { cls: "pj-instr" })}>${head}
      <label for="pj-instr" class="cnpy-sr">Project instructions</label>
      <textarea id="pj-instr" data-act="projInstrInput" data-field="pj-instr" data-pj-instr rows="6" maxlength="${PROJECT_LIMITS.instructionsMax}"${p.ui.instrBusy ? " disabled" : ""} class="cnpy-input cnpy-libm-in cnpy-libm-ta" style="border-radius:8px;width:100%;box-sizing:border-box">${esc(draft)}</textarea>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px"><span style="flex:1;font-size:12px;color:var(--fg-55);font-variant-numeric:tabular-nums">${draft.length}/${PROJECT_LIMITS.instructionsMax}</span>
        <button type="button" data-act="projInstrCancel" class="cnpy-outlinebtn"${p.ui.instrBusy ? " disabled" : ""} style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Cancel</button>
        <button type="button" data-act="projInstrSave" class="cnpy-confirm-go cnpy-confirm-go--neutral"${p.ui.instrBusy ? ` disabled aria-busy="true"` : ""} style="padding:6px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600">${p.ui.instrBusy ? "Saving…" : "Save"}</button></div>
    </section>`;
  }
  const text = x.instructions.trim()
    ? `<p class="pj-instr-t" style="font-size:13px;line-height:1.55;color:var(--fg-70);margin:0;white-space:pre-line;overflow-wrap:anywhere">${esc(x.instructions)}</p>`
    : `<p style="font-size:13px;line-height:1.55;color:var(--fg-55);margin:0">${esc(PROJECT_INSTR_EMPTY)}</p>`;
  return `<section${surface("padding:16px 18px", { cls: "pj-instr" })}>${head}${text}<p style="font-size:12px;color:var(--fg-55);margin:10px 0 0">${esc(PROJECT_INSTR_NOTE)}</p></section>`;
}

/** The order Knowledge (and Add to <project>) groups pins in, and each group's label — one fixed plural, however many
 *  it holds (the design's). */
const PIN_GROUPS: { type: ProjectPinType; many: string }[] = [
  { type: "sprint", many: "Sprints" }, { type: "ticket", many: "Tickets" }, { type: "pr", many: "Pull requests" },
  { type: "doc", many: "Docs" }, { type: "decision", many: "Decisions" }, { type: "repo", many: "Repositories" },
  { type: "artifact", many: "Artifacts" },
];
/** A pin's type, from its ref (a hidden pin's too: its type is known, its item is not). */
export const pinType = (ref: string): ProjectPinType | null => {
  const t = parseAskRef(ref)?.type;
  return t && (PROJECT_PIN_TYPES as readonly string[]).includes(t) ? (t as ProjectPinType) : null;
};
/** The pins grouped in Knowledge's order (a type with none has no group). */
export function groupPins(pins: readonly ProjectPin[]): { label: string; pins: ProjectPin[] }[] {
  return PIN_GROUPS.map((g) => {
    const list = pins.filter((p) => pinType(p.ref) === g.type);
    return { label: g.many, pins: list };
  }).filter((g) => g.pins.length > 0);
}
/** The pins the reader can see (a hidden pin is left out of their answers, and of "N pinned items"). */
export const visiblePins = (d: Pick<ProjectDetail, "pins">): number => d.pins.filter((p) => !("hidden" in p.view)).length;

/** The normal state of a kind has no mark (CLAUDE.md › marks): a live doc. In Knowledge an org artifact too (the
 *  dialog says Private or Org: what Publish to org is about). */
export const normalPinState = (v: RefView, inKnowledge: boolean): boolean =>
  (v.type === "doc" && v.status?.word === "Live") || (inKnowledge && v.type === "artifact" && v.extra.visibility === "org");
/** A pin's mark: the item's live status (a repository's from its Overview's verdicts), nothing when it has none or
 *  when it is the normal state (`normalPinState`). */
function pinMark(v: RefView, inKnowledge = false): string {
  if (v.type === "repo") return repoMark(repoFactsOf(v), 12);
  return v.status && !normalPinState(v, inKnowledge) ? refStatusMark(v.status, 12) : "";
}
function pinRow(pin: ProjectPin, removable: boolean, busy: boolean): string {
  const v = pin.view;
  const type = pinType(pin.ref);
  const remove = removable
    ? `<button type="button" class="cnpy-iconbtn cnpy-hitctl pj-x" data-act="projUnpin" data-arg="${attr(pin.ref)}"${busy ? ` disabled aria-busy="true"` : ""} aria-label="${attr(`Remove ${"hidden" in v ? "this item" : v.title} from Knowledge`)}" data-mtip="Remove" style="display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-55);flex:none">${X}</button>`
    : "";
  if ("hidden" in v) {
    return `<div class="pj-k is-hidden" data-pin="${attr(pin.ref)}" style="border-radius:7px">${askIcon("lock", 14, "var(--fg-40)", 1.8)}<span style="flex:1;min-width:0;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-mtip="It's left out of your answers too.">${esc(PROJECT_HIDDEN_PIN)}</span>${remove}</div>`;
  }
  const num = (v.type === "ticket" || v.type === "pr") && v.num != null ? `<span style="color:var(--fg-55)">#${v.num}</span> ` : "";
  return `<div class="pj-k ${HITBOX}" data-pin="${attr(pin.ref)}" style="border-radius:7px">${askIcon(type ? REF_ICON[type] : "file", 14, "var(--fg-40)", 1.8)}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${num}${esc(v.title)}</span><span style="display:inline-flex;flex:none">${pinMark(v, true)}</span>${remove}${v.href ? hitArea("projPinOpen", pin.ref, `Open ${refLabel(v)}`) : ""}</div>`;
}

function knowledgeCard(d: ProjectDetail, p: ProjectHomeProps): string {
  const x = d.project;
  const edit = canEditProject(x.access) && !x.archivedAt;
  const groups = groupPins(d.pins);
  const body = groups.length
    ? groups.map((g) => `<div class="pj-kg" style="${GROUP_LABEL};padding:10px 8px 3px">${esc(g.label)}</div>${g.pins.map((pin) => pinRow(pin, edit, p.ui.unpinning === pin.ref)).join("")}`).join("")
    : `<p style="font-size:13px;line-height:1.5;color:var(--fg-70);margin:4px 8px 6px">${esc(PROJECT_PINS_EMPTY)}</p>`;
  const used = d.pinLimit.used;
  const count = d.pinLimit.cap === null ? `${used} pinned` : `${used} of ${d.pinLimit.cap} pinned`;
  return `<section${surface("padding:16px 10px 12px", { cls: "pj-know" })}>
    <div style="display:flex;align-items:center;gap:8px;margin:0 8px 6px"><h2 style="${H2};flex:1">Knowledge</h2>${edit ? `<button type="button" data-act="projAdd" data-confirm-trigger class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg-70)">${PLUS(11)}Add</button>` : ""}</div>
    ${body}
    <div style="display:flex;align-items:center;gap:8px;margin:10px 8px 0;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--fg-55)"><span style="flex:1">${esc(count)}</span>${edit ? `<button type="button" data-act="projUploadPick" class="cnpy-link" style="padding:0;font-size:12px;font-weight:500;color:var(--fg-55)">Upload files</button><input type="file" multiple hidden data-proj-file="page" aria-hidden="true" tabindex="-1">` : ""}</div>
  </section>`;
}

function homeTabs(tab: ProjectTab, chats: number | null, arts: number | null): string {
  const badge = (n: number | null) => (n !== null ? `<span class="cnpy-badge" data-n="${n}">${n}</span>` : undefined);
  return tabBar({ id: "pj-tab", ariaLabel: "Project sections", value: tab, act: "projTab", tabs: [{ value: "chats", label: "Chats", trail: badge(chats) }, { value: "artifacts", label: "Artifacts", trail: badge(arts) }] });
}

export function projectHomeView(p: ProjectHomeProps): string {
  const d = p.detail.data && p.detail.data.project.slug === p.slug ? p.detail.data : null;
  const frame = (inner: string) => `<div class="pj-home" data-screen-label="Project" style="${HOME_FRAME}">${inner}</div>`;
  if (!d) {
    if (p.detail.status === "error") return frame(readFailed("projRetry", p.slug));
    if (p.detail.status === "ok") {
      return frame(`<div${surface("padding:18px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap")}><span style="font-size:13px;color:var(--fg-70);flex:1">${esc(PROJECT_NOT_FOUND)}</span><button type="button" data-act="goProjects" class="cnpy-link" style="padding:0;font-size:13px;font-weight:500;color:var(--accent)">All projects</button></div>`);
    }
    return frame(`${homeHeaderSkeleton()}
      <div class="pj-cols"><div class="pj-main">
        ${skeleton("pj-composer", "Loading the project…", skBox("100%", 92))}
        ${homeTabs(p.ui.tab, null, null)}
        <div${tabPanelAttrs("pj-tab", p.ui.tab)}>${skeleton("pj-panel", "Loading chats…", skCard(skList(4, (i) => `<div style="display:flex;gap:11px;padding:11px 16px${i ? ";border-top:1px solid var(--border)" : ""}">${skBox(15, 15)}<div style="flex:1">${skLine(skW(i), 13.5, 1.4)}<div style="margin-top:4px">${skLine("30%", 12, 1.3)}</div></div></div>`), "padding:0;overflow:hidden"))}</div>
      </div><div class="pj-side">
        ${skeleton("pj-instr", "Loading instructions…", skCard(`${skBar(90, 11)}<div style="margin-top:12px">${skLine("92%", 13, 1.55)}${skLine("78%", 13, 1.55)}${skLine("60%", 13, 1.55)}</div>`, "padding:16px 18px"))}
        ${skeleton("pj-know", "Loading Knowledge…", skCard(`${skBar(80, 11)}<div style="margin-top:12px">${skList(5, (i) => `<div style="display:flex;gap:9px;padding:6px 0">${skBox(14, 14)}${skLine(skW(i), 13, 1.4)}</div>`)}</div>`, "padding:16px 18px"))}
      </div></div>`);
  }
  const x = d.project;
  const top = x.archivedAt ? archivedLine(d, p) : p.composer || skeleton("pj-composer", "Loading the composer…", skBox("100%", 92));
  const panel = p.ui.tab === "artifacts" ? artifactsPanel(d, p) : chatsPanel(d, p);
  return frame(`${homeHeader(p, d)}
    <div class="pj-cols">
      <div class="pj-main">
        <div class="pj-ask">${top}</div>
        ${homeTabs(p.ui.tab, d.chats.length, d.artifacts.length)}
        <div${tabPanelAttrs("pj-tab", p.ui.tab)}>${panel}</div>
      </div>
      <div class="pj-side">${instructionsCard(d, p)}${knowledgeCard(d, p)}</div>
    </div>`);
}

// ── the dialogs ──────────────────────────────────────────────────────────────

export const blankProjectDraft = (): ProjectDraft =>
  ({ mode: "new", slug: null, name: "", description: "", icon: "server", color: PROJECT_COLORS[0], visibility: "members", busy: false, error: null });
export const draftFrom = (p: ProjectSummary): ProjectDraft =>
  ({ mode: "edit", slug: p.slug, name: p.name, description: p.description, icon: p.icon, color: p.color, visibility: p.visibility, busy: false, error: null });

/** New project / Edit details: name, icon, colour, who can see it, short description; the plan line. Only the owner
 *  changes who can see it (an editor sees it locked). On Free at the cap, New project says so and cannot create. */
export function projectDialog(d: ProjectDraft, o: { org: string; owner: boolean; limit: ProjectList["limit"] | null; plan: string; role: ProjectsListProps["role"] }): string {
  const create = d.mode === "new";
  const capped = create && atProjectCap(o.limit);
  const lockVis = !create && !o.owner;
  const icons = PROJECT_ICONS.map((ic) => {
    const on = ic === d.icon;
    return `<button type="button" role="radio" aria-checked="${on}" aria-label="${attr(ICON_WORD[ic])}" title="${attr(ICON_WORD[ic])}" data-act="projIcon" data-arg="${ic}" class="cnpy-libm-ic${on ? " is-on" : ""}"${d.busy ? " disabled" : ""}>${spaceIconSvg(ic, 16)}</button>`;
  }).join("");
  const colors = PROJECT_COLORS.map((c) => {
    const on = c === d.color;
    return `<button type="button" role="radio" aria-checked="${on}" aria-label="${attr(COLOR_WORD[c])}" title="${attr(COLOR_WORD[c])}" data-act="projColor" data-arg="${c}" class="cnpy-libm-sw${on ? " is-on" : ""}"${d.busy ? " disabled" : ""} style="--sw:${c};background:${c}"></button>`;
  }).join("");
  const vis = segmented({
    id: "pj-vis", ariaLabel: "Who can see it", act: "projVis", value: d.visibility, size: "sm",
    options: (["private", "members", "org"] as const).map((v) => ({ value: v, label: visibilityLabel(v, o.org), locked: lockVis || d.busy })),
  });
  const plan = create && o.limit ? (o.limit.cap === null ? `${o.plan} · unlimited projects` : `${o.plan} · ${o.limit.used} of ${o.limit.cap} projects`) : "";
  const detail = `<div class="cnpy-libm">
    <div><div class="cnpy-libm-l"><label for="pj-name">Name</label></div>
      <input id="pj-name" data-act="projField" data-arg="name" data-field="pj-name" data-confirm-focus value="${attr(d.name)}" maxlength="${PROJECT_LIMITS.nameMax}" placeholder="Like Hosting providers or Spring rollout" autocomplete="off" spellcheck="false"${d.busy ? " disabled" : ""} class="cnpy-input cnpy-libm-in" style="border-radius:8px" /></div>
    <div><div class="cnpy-libm-l"><span id="pj-icon-l">Icon</span></div><div role="radiogroup" aria-labelledby="pj-icon-l" class="cnpy-libm-icons">${icons}</div></div>
    <div><div class="cnpy-libm-l"><span id="pj-color-l">Color</span></div><div role="radiogroup" aria-labelledby="pj-color-l" class="cnpy-libm-sws">${colors}</div></div>
    <div><div class="cnpy-libm-l"><span id="pj-vis-l">Who can see it</span></div>${vis}<div style="font-size:12px;line-height:1.5;color:var(--fg-55);margin-top:7px">${esc(lockVis ? "Only the owner can change who can see it." : visibilityHint(d.visibility, o.org))}</div></div>
    <div><div class="cnpy-libm-l"><label for="pj-desc">Short description</label><span class="cnpy-libm-opt">Optional</span><span class="cnpy-libm-n">${d.description.length}/${PROJECT_LIMITS.descriptionMax}</span></div>
      <textarea id="pj-desc" data-act="projField" data-arg="description" data-field="pj-desc" rows="2" maxlength="${PROJECT_LIMITS.descriptionMax}" placeholder="What is this work?"${d.busy ? " disabled" : ""} class="cnpy-input cnpy-libm-in cnpy-libm-ta" style="border-radius:8px">${esc(d.description)}</textarea></div>
    ${capped && o.limit ? capNotice(o.limit, o.role, o.plan) : ""}
    ${plan ? `<div class="pj-plan" style="font-size:12px;color:var(--fg-55)">${esc(plan)}</div>` : ""}
  </div>`;
  return confirmModal({
    id: "pj-edit", title: create ? "New project" : "Edit details", body: create ? PROJECT_NEW_INTRO : "Its name, icon and color show in Projects and on its chats.",
    detail, confirmAct: "projSave", cancelAct: "projDialogClose", tone: "neutral", busy: d.busy,
    confirmLabel: create ? "Create project" : "Save", busyLabel: create ? "Creating…" : "Saving…",
    confirmDisabled: !d.name.trim() || capped, error: d.error,
  });
}

export const blankPinPick = (): PinPick => ({ q: "", type: "all", status: "idle", hits: [], views: {}, sel: [], publishing: null, uploading: false, busy: false, error: null });

const PIN_TAB_LABEL: Record<PinTypeTab, string> = { all: "All", ticket: "Tickets", sprint: "Sprints", doc: "Docs", pr: "Pull requests", artifact: "Artifacts" };
/** The candidates the dialog lists: the search's hits that a project may pin, narrowed by the type switch. */
export function pinCandidates(pick: Pick<PinPick, "hits" | "type">): AskRefHit[] {
  return pick.hits.filter((h) => (PROJECT_PIN_TYPES as readonly string[]).includes(h.type) && (pick.type === "all" || h.type === pick.type));
}
/** A picked artifact that is private while the project is not: "Publish to org" first. */
export function privatePicks(pick: Pick<PinPick, "sel" | "views" | "hits">, visibility: ProjectVisibility): { slug: string; title: string }[] {
  if (visibility === "private") return [];
  return pick.sel.flatMap((ref) => {
    const p = parseAskRef(ref);
    if (p?.type !== "artifact") return [];
    const v = pick.views[ref];
    const view = v && !("hidden" in v) ? v : null;
    const vis = view?.extra.visibility;
    return vis === "private" ? [{ slug: p.key, title: view?.title ?? pick.hits.find((h) => h.ref === ref)?.title ?? p.key }] : [];
  });
}

/** Add to <project>: the search (the app's quick search), the type switch, the candidates grouped with their marks
 *  (already-pinned ones ticked and disabled), the private-artifact warning with Publish to org, the upload drop zone,
 *  "N selected" and Add N. */
export function pinDialog(pick: PinPick, d: ProjectDetail): string {
  const pinned = new Set(d.pins.map((p) => p.ref));
  const cands = pinCandidates(pick);
  const groups = PIN_GROUPS.map((g) => ({ ...g, hits: cands.filter((h) => h.type === g.type) })).filter((g) => g.hits.length);
  const row = (h: AskRefHit) => {
    const on = pinned.has(h.ref);
    const v = pick.views[h.ref];
    const view = v && !("hidden" in v) ? v : null;
    const id = `pj-c-${h.ref.replace(/[^a-z0-9]+/gi, "-")}`;
    const mark = on ? `<span style="font-size:12px;color:var(--fg-55)">Pinned</span>` : view ? pinMark(view) : h.status ? `<span style="font-size:12px;color:var(--fg-70)">${esc(h.status)}</span>` : "";
    const label = view ? refLabel(view) : h.title;
    return `<label class="pj-pick" for="${attr(id)}" style="border-radius:8px"><input type="checkbox" id="${attr(id)}" data-act="projPinToggle" data-arg="${attr(h.ref)}"${on || pick.sel.includes(h.ref) ? " checked" : ""}${on || pick.busy ? " disabled" : ""}>${askIcon(REF_ICON[h.type], 14, "var(--fg-40)", 1.8)}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span><span style="display:inline-flex;flex:none">${mark}</span></label>`;
  };
  // With nothing typed, what changed most recently per type (the design's: the dialog opens on candidates); typed,
  // the quick search's matches. Both from `GET …/candidates` (projects-actions.ts `search`).
  const q = pick.q.trim();
  const hint = (text: string, role = "") => `<p class="pj-pick-hint"${role ? ` role="${role}"` : ""} style="margin:14px 10px;font-size:12.5px;color:var(--fg-55)">${esc(text)}</p>`;
  const list = groups.length ? groups.map((g) => `<div style="${GROUP_LABEL};padding:12px 10px 4px">${esc(g.many)}</div>${g.hits.map(row).join("")}`).join("")
    : pick.status === "loading" || pick.status === "idle" ? hint(q ? "Searching…" : "Loading…", "status")
    : pick.status === "error" ? hint("Couldn't search. Try again.", "alert")
    : q ? hint(`Nothing matches “${q}”.`)
    : hint(pick.type === "all" ? "Nothing to pin yet. Search for a ticket, sprint, doc, pull request or artifact." : `No ${PIN_TAB_LABEL[pick.type].toLowerCase()} to pin yet.`);
  const warn = privatePicks(pick, d.project.visibility).map((a) =>
    `<div class="pj-warn" role="note" style="display:flex;align-items:flex-start;gap:9px;margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--hover);font-size:12.5px;line-height:1.5;color:var(--fg-70)"><span style="display:flex;margin-top:3px">${markShape("triangle", "var(--amber)", 10)}</span><span style="flex:1">${esc(`${a.title} is private to you. People in this project won't see it until you publish it to the org.`)}</span>${outlineBtn("projPublish", a.slug, pick.publishing === a.slug ? "Publishing…" : "Publish to org", { busy: pick.publishing === a.slug, small: true })}</div>`).join("");
  const n = pick.sel.length;
  const detail = `<div class="pj-pickdlg">
    <div class="cnpy-sfbar" style="width:100%;max-width:none;box-sizing:border-box"><div class="cnpy-sfbar-q"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg><input data-act="projPinQ" data-field="projPinQ" data-confirm-focus class="cnpy-search-in" style="font-size:12.5px" placeholder="Search tickets, sprints, docs, PRs and artifacts" aria-label="Search items to pin" value="${attr(pick.q)}" autocomplete="off" spellcheck="false"></div></div>
    <div style="margin-top:10px">${segmented({ id: "pj-pin-type", ariaLabel: "Type", act: "projPinType", value: pick.type, size: "xs", className: "cnpy-seg--wrap", options: PIN_TYPE_TABS.map((t) => ({ value: t, label: PIN_TAB_LABEL[t] })) })}</div>
    <div class="pj-picklist cnpy-scroll" data-scroll-keep="pj-pick" style="max-height:min(300px, calc(40 * var(--vh)));overflow:auto;margin-top:10px;border-top:1px solid var(--border)">${list}</div>
    ${warn}
    <div class="pj-drop" data-proj-drop style="display:flex;align-items:center;gap:10px;margin-top:12px;padding:11px 12px;border:1px dashed var(--border-strong);border-radius:8px;font-size:12.5px;color:var(--fg-70)"><span style="display:flex;color:var(--fg-55)">${UPLOAD_IC}</span><span style="flex:1">${pick.uploading ? "Uploading…" : `Drop files here, or <button type="button" data-act="projUploadPick" class="cnpy-link" style="padding:0;font-size:12.5px;font-weight:500;color:var(--accent)">upload</button>. Up to 10 MB each.`}</span><input type="file" multiple hidden data-proj-file="dialog" aria-hidden="true" tabindex="-1"></div>
    <div class="pj-sel" style="margin-top:12px;font-size:12px;color:var(--fg-55)">${esc(n === 0 ? "Pick what this project is about" : `${n} selected`)}</div>
  </div>`;
  return confirmModal({
    id: "pj-pin", title: `Add to ${d.project.name}`, body: PROJECT_PIN_INTRO, detail, wide: true,
    confirmAct: "projPinGo", cancelAct: "projDialogClose", tone: "neutral", busy: pick.busy,
    confirmLabel: n ? `Add ${n}` : "Add", busyLabel: "Adding…", confirmDisabled: n === 0, error: pick.error,
  });
}

/** Share: who can see it (the owner's switch; an editor's is locked), people to add, the members with their roles. */
export function shareDialog(s: ShareDraft, d: ProjectDetail, o: { org: string; persons: readonly PersonSummary[]; dd: DropdownUi; owner: boolean }): string {
  const x = d.project;
  const priv = s.visibility === "private";
  const vis = segmented({
    id: "pj-share-vis", ariaLabel: "Who can see it", act: "projShareVis", value: s.visibility, size: "sm",
    options: (["private", "members", "org"] as const).map((v) => ({ value: v, label: visibilityLabel(v, o.org), locked: !o.owner || s.busy })),
  });
  const rows = [
    `<div class="pj-member" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--border)">${personChip(findPerson(o.persons, x.owner), 28, x.owner)}<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500">${esc(nameOf(o.persons, x.owner))}</div>${handleTag(findPerson(o.persons, x.owner), x.owner, 11.5)}</div><span style="font-size:12.5px;color:var(--fg-55);padding:0 9px">Owner</span></div>`,
    ...s.members.map((m) => `<div class="pj-member" data-member="${attr(m.handle)}" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--border)${priv ? ";opacity:.55" : ""}">${personChip(findPerson(o.persons, m.handle), 28, m.handle)}<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500">${esc(nameOf(o.persons, m.handle))}</div>${handleTag(findPerson(o.persons, m.handle), m.handle, 11.5)}</div>${dropdown(roleDropdown(m, s.busy || priv), o.dd)}</div>`),
  ].join("");
  const detail = `<div class="cnpy-libm">
    <div><div class="cnpy-libm-l"><span id="pj-share-vis-l">Who can see it</span></div>${vis}<div style="font-size:12px;line-height:1.5;color:var(--fg-55);margin-top:7px">${esc(o.owner ? visibilityHint(s.visibility, o.org) : "Only the owner can change who can see it.")}</div></div>
    <div><div class="cnpy-libm-l"><span id="pj-share-add-l">People</span></div>${dropdown(addPersonDropdown(s, x.owner, o.persons, s.busy || priv), o.dd)}</div>
  </div>
  <div class="pj-members cnpy-scroll" data-scroll-keep="pj-share" style="margin-top:6px;max-height:min(260px, calc(36 * var(--vh)));overflow-y:auto">${rows}</div>
  <div style="font-size:12px;line-height:1.5;color:var(--fg-55);margin-top:8px">${esc(priv ? "Only the owner can open a private project. Its members are kept, and come back if you switch it back." : PROJECT_SHARE_NOTE)}</div>`;
  return confirmModal({
    id: "pj-share", title: `Share ${x.name}`, body: "Who can open it, and who can change it.", detail,
    confirmAct: "projShareSave", cancelAct: "projDialogClose", tone: "neutral", busy: s.busy,
    confirmLabel: "Save", busyLabel: "Saving…", error: s.error,
  });
}
/** A member's role: Editor or Viewer, or Remove (the dropdown's own act; its menu is drawn at the root). */
export const roleDropdown = (m: { handle: string; role: ProjectRole }, disabled: boolean): DropdownProps => ({
  id: `pj-role-${m.handle.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`, act: "projShareRole", arg: m.handle, value: m.role, size: "sm", disabled,
  ariaLabel: `${m.handle}'s role`,
  options: [{ value: "editor", label: "Editor", hint: "Changes instructions and Knowledge" }, { value: "viewer", label: "Viewer", hint: "Reads them and starts chats" }, { value: "remove", label: "Remove" }],
});
/** Add a person: everyone in the org who is not the owner or a member yet. */
export const addPersonDropdown = (s: ShareDraft, owner: string, persons: readonly PersonSummary[], disabled: boolean): DropdownProps => ({
  id: "pj-share-add", act: "projShareAdd", value: "", size: "md", fill: true, disabled, labelledBy: "pj-share-add-l", placeholder: "Add a person",
  options: persons.filter((p) => !sameHandle(p.handle, owner) && !s.members.some((m) => sameHandle(m.handle, p.handle))).map((p) => ({ value: p.handle, label: p.name || p.handle, hint: `@${p.handle}` })),
});

/** Delete: the server's count of EVERYTHING it takes (`deleteCounts`, every thread anyone started in it) — the reader's
 *  own counts only when the server sent none. */
export function deleteDialog(x: Pick<ProjectSummary, "name" | "chats" | "artifacts" | "deleteCounts">, busy: boolean, error: string | null): string {
  const n = x.deleteCounts ?? { chats: x.chats, artifacts: x.artifacts };
  return confirmModal({
    id: "pj-delete", title: `Delete ${x.name}?`, body: deleteProjectText(n.chats, n.artifacts),
    confirmAct: "projDeleteGo", cancelAct: "projDialogClose", busy, confirmLabel: "Delete project", busyLabel: "Deleting…", error,
  });
}

/** The dropdowns a projects screen draws (their menus are root overlays: render.ts `dropdownMenu`). */
export function projectDropdowns(ui: ProjectsUi, persons: readonly PersonSummary[], screen: string): DropdownProps[] {
  const out: DropdownProps[] = [];
  if (screen === "projects") out.push(sortDropdown(ui.sort));
  const dlg = ui.dialog;
  const d = ui.detail.data;
  if (dlg?.kind === "share" && d) {
    const priv = dlg.share.visibility === "private";
    out.push(addPersonDropdown(dlg.share, d.project.owner, persons, dlg.share.busy || priv));
    for (const m of dlg.share.members) out.push(roleDropdown(m, dlg.share.busy || priv));
  }
  return out;
}
