// The Artifacts screens (Knowledge › Artifacts) — ported from the Claude Design
// `Canopy Artifacts.dc.html` (docs/superpowers/specs/artifacts-prototype/): the
// library, one artifact's viewer (with its version menu, status and visibility
// controls, properties and linked work), the version diff, the new-artifact form,
// and the not-found page. Plus the two dialogs (ratify, attach to a ticket) and the
// ticket detail's Artifacts block.
//
// Real against /api/artifacts (the wire DTOs are shared/artifacts-core.ts — the
// ZOD-FREE core; this module never imports shared/artifacts, so zod stays out of
// the browser bundle). Bodies are never inlined from a string the page trusts:
//   • html  → <iframe src="/raw/a/<slug>@v<n>" sandbox="allow-scripts">, sized by
//             the raw route's injected `trov:height` postMessage (main.ts listens,
//             matching e.source to the frame). NEVER srcdoc, NEVER allow-same-origin.
//   • svg   → inline, only after DOMPurify's svg profile (sanitizeSvg).
//   • markdown → renderMarkdown (marked + DOMPurify).
//   • mermaid  → the CDN build, rendered post-paint and cached per version + theme.
//   • image → <img>; pdf → an UNsandboxed <iframe> (see the pdf case); file → a card with Download.
//
// Shape: pure views over props (render.ts calls them), plus ONE reducer,
// `artifactsAct`, that main.ts hands every `art*` act to. The reducer never
// touches the DOM or the network; what it cannot do itself (navigate, write,
// toast, download, open a tab, copy) it returns as an effect for main.ts.

import { esc, attr, relTime, surface, hitArea, HITBOX } from "./ui";
import { personLink, personNameLink } from "./people";
import { searchFilterBar, type FilterMenuProps } from "./filter-menu";
import { segmented } from "./segmented";
import { confirmModal } from "./confirm";
import { renderMarkdown, sanitizeSvg } from "./markdown";
import { collapsedLineDiff } from "./diff";
import type { PersonColor } from "@shared/rows";
import {
  ARTIFACT_KINDS, ARTIFACT_AREAS, ARTIFACT_STATUSES, ARTIFACT_TEXT_EXT, ARTIFACT_SUMMARY_MAX,
  artifactCap, isBinaryKind, isTextKind, kindForFilename, claudeOnlyHits, isBundledExport, canRatify, parseSlugVersion,
  type ArtifactKind, type ArtifactStatus, type ArtifactVisibility, type ArtifactLinkType,
  type ArtifactSummaryDTO, type ArtifactDetailDTO, type ArtifactVersionDTO, type ArtifactDiffDTO,
} from "@shared/artifacts-core";

export { ARTIFACT_AREAS, ARTIFACT_KINDS };
/** The repositories a new artifact may be filed under: the ORG's connected ones (`GET /api/o/:slug/me`
 *  `repos.all`, primary first) — plus the draft's own value when it is none of them. */
export const artifactRepoOptions = (repos: readonly string[], current: string): string[] =>
  current && !repos.includes(current) ? [...repos, current] : [...repos];

// The raw route (`/raw/a/…`) has no `/api/o/:slug` form yet: it answers only for a person in exactly
// ONE org (409 `org_required` otherwise). main.ts says which the viewer is; with several, every
// place that would load a raw page (a preview frame, an image, a download) says so instead of
// showing a broken frame.
let rawAvailable = true;
export function setRawAvailable(ok: boolean): void { rawAvailable = ok; }
/** Why a raw page is not shown, as the block that takes its place. */
export function rawUnavailable(compact = false): string {
  if (compact) return `<div data-raw-off style="position:absolute;inset:0;display:grid;place-items:center;padding:12px;text-align:center;font-size:11.5px;line-height:1.5;color:var(--fg-40)">Preview unavailable</div>`;
  return `<div data-raw-off role="status" style="display:grid;place-items:center;padding:44px 24px;background:var(--bg);text-align:center">
    <div style="max-width:460px">
      <div style="font-size:14px;font-weight:600">This preview can't open here yet</div>
      <div style="font-size:12.5px;line-height:1.6;color:var(--fg-55);margin-top:6px">A raw artifact page is served outside an organization's address, so for now it opens only for people who belong to exactly one organization, and you belong to several. Its versions, links and source below still work.</div>
    </div>
  </div>`;
}

// ── state ────────────────────────────────────────────────────────────────────

/** One loadable read. `missing` = the API's 404 (absent, or private to someone else). */
export interface ArtSlice<T> { status: "idle" | "loading" | "ok" | "error" | "missing"; data: T | null; error?: string }
const IDLE = <T>(): ArtSlice<T> => ({ status: "idle", data: null });

export type ArtFilterKey = "area" | "kind" | "author" | "status" | "sprint";
export const ART_FILTER_KEYS: readonly ArtFilterKey[] = ["area", "kind", "author", "status", "sprint"];
export type ArtFilters = Record<ArtFilterKey, string>;
const NO_FILTERS: ArtFilters = { area: "all", kind: "all", author: "all", status: "all", sprint: "all" };

/** A ticket as the attach dialog and the library search know it. */
export interface ArtTicketRef { id: number; title: string; status: string }
/** A sprint as the filter and the link field know it. */
export interface ArtSprintRef { id: number; label: string; dates: string | null; active: boolean }

export interface ArtLinkDraft { kind: "ticket" | "sprint" | "PR" | "issue"; label: string; target_type: ArtifactLinkType; target_ref: string }
export interface ArtFile { name: string; size: number; /** Text kinds: the file's text (for the preview, the claude.ai check and the JSON body). */ text: string | null; /** Binary kinds: the file itself (multipart). */ blob: Blob | null }
export interface ArtCreate {
  title: string;
  kind: ArtifactKind;
  area: string;
  repo: string;
  vis: ArtifactVisibility;
  links: ArtLinkDraft[];
  linkDraft: string;
  linkErr: boolean;
  tab: "paste" | "file" | "url";
  paste: string;
  file: ArtFile | null;
  url: string;
  urlFetched: { text: string } | null;
  fetching: boolean;
  urlErr: string | null;
  submitting: boolean;
}
/** The viewer's New version dialog: edit the shown version's text, or upload a replacement file.
 *  `base` is the version the edit started from (the one on screen); `original` its text, so an
 *  untouched edit cannot be sent. */
export interface ArtNewVersion {
  tab: "edit" | "file";
  base: number;
  original: string;
  text: string;
  file: ArtFile | null;
  fileErr: string | null;
  summary: string;
  submitting: boolean;
}
export interface ArtUi {
  /** The library's list, loaded unfiltered (the popover counts every option). */
  list: ArtSlice<ArtifactSummaryDTO[]>;
  /** One artifact at one version, keyed `detailKey(slug, v)`. */
  details: Record<string, ArtSlice<ArtifactDetailDTO>>;
  /** Two versions compared, keyed `diffKey(slug, a, b)`. */
  diffs: Record<string, ArtSlice<ArtifactDiffDTO>>;
  /** The artifacts linked to a ticket (the ticket detail's block), keyed by ticket id. */
  ticketArts: Record<number, ArtSlice<ArtifactSummaryDTO[]>>;
  /** Every ticket (seg=all) — the attach dialog's list and the library's ticket search. */
  attachTickets: ArtSlice<ArtTicketRef[]>;
  /** A write is in flight (status, visibility, ratify, attach) — a second click waits. */
  busy: boolean;
  q: string;
  f: ArtFilters;
  filterOpen: boolean;
  filterCat: ArtFilterKey;
  verMenu: boolean;
  dotMenu: boolean;
  ratifyOpen: boolean;
  attachOpen: boolean;
  attachQ: string;
  attachPick: number | null;
  /** The New version dialog, open when non-null. */
  nv: ArtNewVersion | null;
  /** The viewer's "Delete artifact" confirm is open (author / admin only). */
  deleteArm: boolean;
  /** The delete is in flight: the confirm's buttons are disabled. */
  deleteBusy: boolean;
  c: ArtCreate;
}
export function initialArtCreate(repo = ""): ArtCreate {
  return {
    title: "", kind: "html", area: "ui", repo, vis: "org", links: [], linkDraft: "", linkErr: false,
    tab: "paste", paste: "", file: null, url: "", urlFetched: null, fetching: false, urlErr: null, submitting: false,
  };
}
export function initialArtUi(): ArtUi {
  return {
    list: IDLE(), details: {}, diffs: {}, ticketArts: {}, attachTickets: IDLE(), busy: false,
    q: "", f: { ...NO_FILTERS }, filterOpen: false, filterCat: "area",
    verMenu: false, dotMenu: false, ratifyOpen: false, attachOpen: false, attachQ: "", attachPick: null, nv: null,
    deleteArm: false, deleteBusy: false,
    c: initialArtCreate(),
  };
}
export const detailKey = (slug: string, v: number | null): string => `${slug}@${v ?? "latest"}`;
export const diffKey = (slug: string, a: number, b: number): string => `${slug}:${a}..${b}`;

/** The three Artifacts screens. `artifact` is one artifact: its viewer, or its diff when `diff` is set. */
export type ArtScreen = "artifacts" | "artifactnew" | "artifact";
export interface ArtRoute { slug: string | null; v: number | null; diff: { a: number; b: number } | null }
export const ART_ROUTE_NONE: ArtRoute = { slug: null, v: null, diff: null };

export interface ArtPerson { handle: string; name: string | null; color: PersonColor; avatar_url?: string | null }
export interface ArtProps {
  screen: ArtScreen;
  route: ArtRoute;
  ui: ArtUi;
  /** The signed-in handle — the author check for private artifacts and the visibility toggle. */
  me: string;
  /** The signed-in person is an admin or owner of this org — may delete any artifact they can see. */
  admin: boolean;
  /** The org's name (the visibility help says who "everyone" is) and its connected repositories. */
  orgName?: string;
  repos?: readonly string[];
  persons: ArtPerson[];
  /** `location.host` in the browser; the address strips print it. */
  host: string;
  /** The filter menu (web/src/filter-menu.ts) that this render opens, if any — plays its entrance once. */
  fmOpening?: string | null;
  /** The resolved theme — the mermaid cache is keyed by it (the diagram is drawn in its colours). */
  theme: string;
  tickets: ArtTicketRef[];
  sprints: ArtSprintRef[];
}

// ── constants (the design's) ─────────────────────────────────────────────────

const KIND_ICON: Record<ArtifactKind, string> = {
  html: "M8 7 3 12l5 5M16 7l5 5-5 5",
  markdown: "M6 3h7l5 5v13H6zM13 3v5h5M9 13h6M9 17h6",
  svg: "M12 3 21 12 12 21 3 12z",
  mermaid: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h4.5a2.5 2.5 0 0 1 2.5 2.5V14",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  pdf: "M6 3h7l5 5v13H6zM13 3v5h5M9 18v-5h2a1.5 1.5 0 0 1 0 3H9",
  file: "M6 3h7l5 5v13H6zM13 3v5h5",
};
const BINARY_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" };

const CHIP = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none;";
const tint = (c: string): string => `${CHIP}color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;
const STATUS: Record<ArtifactStatus, [string, string]> = {
  draft: ["DRAFT", tint("var(--amber)")], published: ["PUBLISHED", tint("var(--blue)")], ratified: ["RATIFIED", tint("var(--accent)")],
};
const TSTATUS: Record<string, [string, string]> = {
  submitted: ["SUBMITTED", tint("var(--blue)")], in_progress: ["IN PROGRESS", tint("var(--accent)")],
  done: ["DONE", CHIP + "color:var(--fg-55);border:1px solid var(--border-strong)"],
  declined: ["DECLINED", CHIP + "color:var(--red);border:1px solid color-mix(in srgb,var(--red) 35%,transparent);opacity:.75"],
};
const NEUTRAL = CHIP + "color:var(--fg-55);border:1px solid var(--border-strong)";
const MONO_VAL = "font-family:var(--label);font-size:11.5px;color:var(--fg-70)";
const EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";
const SHELL = "width:100%;max-width:1440px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px";
const MENU = "background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;box-shadow:0 14px 38px rgba(0,0,0,.3)";
const OUTLINE_BTN = "padding:7px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)";
/** The toast shown when the author makes a page private (it replaced a standing banner). */
const PRIVATE_NOTE = "Only you can see this artifact. Teammates who open the link get a not-found page until you publish it to the org.";
const ACCENT_BTN = "padding:7px 15px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap";

const chipSt = (on: boolean): string => `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}`;
const primarySt = (on: boolean): string => (on
  ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent;cursor:pointer"
  : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default")
  + ";border-radius:8px;padding:7px 15px;font-size:12.5px;font-weight:600;transition:all .12s ease;display:inline-flex;align-items:center;gap:7px;white-space:nowrap";

const svg = (w: number, sw: number, paths: string, extra = ""): string =>
  `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" aria-hidden="true"${extra}>${paths}</svg>`;
const I = {
  plus: (w = 14, sw = 2.2) => svg(w, sw, `<path d="M12 5v14M5 12h14"></path>`),
  search: () => svg(14, 1.8, `<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path>`, ` style="flex:none"`),
  x: () => svg(10, 2.4, `<path d="M5 5l14 14M19 5 5 19"></path>`),
  caret: () => svg(10, 2.6, `<path d="m6 9 6 6 6-6"></path>`, ` style="opacity:.7"`),
  check: (color = "var(--accent)", st = "") => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.6" aria-hidden="true" style="${st}"><path d="M20 6 9 17l-5-5"></path></svg>`,
  lock: () => svg(13, 2, `<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>`),
  people: (w = 13) => svg(w, 2, `<circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"></path><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.6c1.3.7 2.1 2.2 2.5 4.4"></path>`),
  history: () => svg(14, 1.8, `<path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path>`),
  compare: () => svg(13, 2, `<path d="M8 3v12M16 21V9"></path><path d="m5 6 3-3 3 3M13 18l3 3 3-3"></path>`),
  shield: () => svg(11, 2.2, `<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"></path><path d="m9 12 2.2 2.2L15.5 10"></path>`),
  ext: () => svg(14, 1.8, `<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>`),
  link: () => svg(14, 1.8, `<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>`),
  trash: () => svg(14, 1.8, `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path>`),
  download: () => svg(14, 1.8, `<path d="M12 4v11"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path>`),
  arrow: (w = 13) => svg(w, 2, `<path d="M5 12h14M13 6l6 6-6 6"></path>`),
  ticket: () => svg(13, 1.9, `<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path>`),
  flag: (w = 13) => svg(w, 1.9, `<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`),
  file: () => svg(14, 1.8, `<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path>`),
  upload: () => svg(22, 1.7, `<path d="M12 16V4"></path><path d="m7 9 5-5 5 5"></path><path d="M5 20h14"></path>`, ` style="color:var(--fg-40);margin-bottom:6px"`),
  alert: () => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5M12 16.5v.01"></path></svg>`,
  kind: (k: ArtifactKind, w = 13) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${KIND_ICON[k] ?? KIND_ICON.file}"></path></svg>`,
  dots: () => `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>`,
  gh: (w = 13) => `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`,
};

// ── helpers ──────────────────────────────────────────────────────────────────

export const fmtKB = (b: number): string => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);
export const capLabel = (k: ArtifactKind): string => (isBinaryKind(k) ? "10 MB" : "750 KB");
export const slugifyTitle = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const sameHandle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether the signed-in person may delete this page: its author, or an admin (the server re-checks). */
export function canDeleteArtifact(d: Pick<ArtifactDetailDTO, "author_id">, me: string, admin: boolean): boolean {
  return admin || (me !== "" && sameHandle(d.author_id, me));
}
const deleteKeeps = (n: number): string => (n === 1 ? "Its one version is kept" : `All ${n} versions are kept`);

interface Who { handle: string; name: string; first: string; color: PersonColor; ini: string }
function who(p: Pick<ArtProps, "persons">, handle: string): Who {
  const live = p.persons.find((x) => sameHandle(x.handle, handle));
  const name = live?.name || handle;
  const color: PersonColor = live?.color ?? "stone";
  const parts = name.trim().split(/\s+/);
  const ini = (parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  return { handle, name, first: parts[0], color, ini };
}
/** The directory's person behind a handle — what a name or photo links to (`personLink`); null
 *  (plain, unclickable) for a handle no one holds. */
const personIn = (p: Pick<ArtProps, "persons">, handle: string): ArtPerson | null =>
  p.persons.find((x) => sameHandle(x.handle, handle)) ?? null;
/** The design's rounded-square avatar (it scales with --corner-scale like every other radius). */
const av = (w: Who, size: number): string =>
  `<span style="width:${size}px;height:${size}px;border-radius:${size >= 24 ? 12 : size >= 18 ? 11 : 10}px;background:var(--p-${w.color});display:grid;place-items:center;font-size:${Math.max(8, Math.round(size * 0.42))}px;font-weight:600;color:#fff;flex:none">${esc(w.ini)}</span>`;

/** A version's download name: the stored filename when the API sends one, else `<slug>-v<n>.<ext>`. */
export function artFileName(slug: string, kind: ArtifactKind, v: ArtifactVersionDTO): string {
  const stored = (v as ArtifactVersionDTO & { filename?: string | null }).filename;
  if (typeof stored === "string" && stored.trim()) return stored;
  const ext = isTextKind(kind) ? ARTIFACT_TEXT_EXT[kind] : BINARY_EXT[v.content_type.split(";")[0].trim().toLowerCase()] ?? "bin";
  return `${slug}-v${v.version_no}.${ext}`;
}
/** `/raw/a/<slug>@v<n>` — the raw route for one version (the API's `raw_url` when we have it). */
export const rawUrl = (slug: string, v: number): string => `/raw/a/${encodeURIComponent(slug)}@v${v}`;
const withDownload = (u: string): string => `${u}${u.includes("?") ? "&" : "?"}download=1`;

/** The create form's current text (paste / a text file / a fetched URL); "" for a binary file. */
export function createText(c: ArtCreate): string {
  if (c.tab === "paste") return c.paste;
  if (c.tab === "file") return c.file?.text ?? "";
  return c.urlFetched?.text ?? "";
}
/** Bytes of the create form's content (the file's own size for an upload). */
export function createBytes(c: ArtCreate): number {
  if (c.tab === "file") return c.file ? c.file.size : 0;
  return new TextEncoder().encode(createText(c)).length;
}
export function canSubmitCreate(c: ArtCreate): boolean {
  const bytes = createBytes(c);
  if (!c.title.trim() || bytes === 0 || bytes > artifactCap(c.kind) || c.submitting) return false;
  if (isBinaryKind(c.kind)) return c.tab === "file" && !!c.file?.blob;
  return true;
}

/** The New version dialog's text (the edit box, or a text file); "" for a binary file. */
export function nvText(nv: ArtNewVersion): string {
  return nv.tab === "edit" ? nv.text : nv.file?.text ?? "";
}
/** Bytes the New version dialog would send (the file's own size for an upload). */
export function nvBytes(nv: ArtNewVersion): number {
  if (nv.tab === "file") return nv.file ? nv.file.size : 0;
  return new TextEncoder().encode(nv.text).length;
}
/** Sendable: something to send, under the kind's cap, and — for an edit — actually changed. A
 *  binary page only takes a file. (An edit of an OLDER version back to its own text is a restore,
 *  so "unchanged" only means "unchanged from the LATEST" there — the server still dedupes.) */
export function canSubmitNv(nv: ArtNewVersion, kind: ArtifactKind, latestNo: number): boolean {
  const bytes = nvBytes(nv);
  if (nv.submitting || bytes === 0 || bytes > artifactCap(kind)) return false;
  if (isBinaryKind(kind)) return nv.tab === "file" && !!nv.file?.blob;
  if (nv.tab === "file") return nv.file?.text != null;
  return nv.text !== nv.original || nv.base !== latestNo;
}

/**
 * The Links field: `#10` (ticket), `Sprint 14` (a sprint by its label), a GitHub
 * PR / issue URL (`owner/repo#n`), or `pr 12` / `issue 12` (resolved server-side
 * against the page's repo). Null when it names nothing.
 */
export function parseArtLink(raw: string, sprints: ArtSprintRef[] = []): ArtLinkDraft | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if (!s) return null;
  if ((m = /^#?(\d+)$/.exec(s))) return { kind: "ticket", label: "#" + m[1], target_type: "ticket", target_ref: m[1] };
  if ((m = /github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/.exec(s))) {
    const pr = m[3] === "pull";
    return { kind: pr ? "PR" : "issue", label: "#" + m[4], target_type: pr ? "pr" : "issue", target_ref: `${m[1]}/${m[2]}#${m[4]}` };
  }
  if ((m = /^pr\s*#?(\d+)$/i.exec(s))) return { kind: "PR", label: "#" + m[1], target_type: "pr", target_ref: "#" + m[1] };
  if ((m = /^issue\s*#?(\d+)$/i.exec(s))) return { kind: "issue", label: "#" + m[1], target_type: "issue", target_ref: "#" + m[1] };
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const sp = sprints.find((x) => norm(x.label) === norm(s))
    ?? ((m = /^sprint\s*(\d+)$/i.exec(s)) ? sprints.find((x) => norm(x.label) === `sprint ${m![1]}`) : undefined);
  if (sp) return { kind: "sprint", label: sp.label, target_type: "sprint", target_ref: String(sp.id) };
  return null;
}

/** The loaded detail the route names (the latest when the route shows a diff). */
export function routeDetail(p: Pick<ArtProps, "route" | "ui">): ArtSlice<ArtifactDetailDTO> | null {
  if (!p.route.slug) return null;
  return p.ui.details[detailKey(p.route.slug, p.route.diff ? null : p.route.v)] ?? null;
}

// ── header (title, crumbs, the library's New artifact button) ────────────────

export function artifactsHeader(p: ArtProps): { title: string; crumb: string; controls: string } {
  const titleTop = `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">Artifacts</h1>`;
  const titleBack = `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0;white-space:nowrap;flex:none"><button data-act="goArtifacts" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;padding:0;color:var(--fg-55);cursor:pointer">Artifacts</button></h1>`;
  const crumbSt = (last: boolean) => `font-size:13px;font-weight:500;color:${last ? "var(--fg-70)" : "var(--fg-55)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;padding:0;cursor:${last ? "default" : "pointer"}`;
  const crumb = (label: string, act: string | null, arg = "") =>
    `<span style="display:inline-flex;align-items:center;gap:10px;min-width:0"><span style="color:var(--fg-40);font-size:13px">›</span>${act
      ? `<button data-act="${act}" data-arg="${attr(arg)}" style="${crumbSt(false)}">${esc(label)}</button>`
      : `<span style="${crumbSt(true)}">${esc(label)}</span>`}</span>`;

  if (p.screen === "artifacts") {
    return {
      title: titleTop, crumb: "",
      controls: `<button data-act="artNew" class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;${ACCENT_BTN};padding:7px 14px">${I.plus()}New artifact</button>`,
    };
  }
  if (p.screen === "artifactnew") return { title: titleBack, crumb: crumb("New artifact", null), controls: "" };
  const slice = routeDetail(p);
  if (slice?.status === "missing") return { title: titleBack, crumb: crumb("Not found", null), controls: "" };
  const d = slice?.data;
  if (!d) return { title: titleBack, crumb: "", controls: "" };
  if (p.route.diff) return { title: titleBack, crumb: crumb(d.title, "artOpen", d.slug) + crumb("Compare", null), controls: "" };
  return { title: titleBack, crumb: crumb(d.title, null), controls: "" };
}

// ── screens ──────────────────────────────────────────────────────────────────

const notice = (msg: string, retry = false): string =>
  `<div style="padding:80px 24px;text-align:center;color:var(--fg-40);font-size:13px">${msg}${retry ? ` <button data-act="artRetry" class="cnpy-link" style="font-size:13px;color:var(--accent);padding:0">Try again</button>` : ""}</div>`;

export function artifactsView(p: ArtProps): string {
  if (p.screen === "artifacts") return libraryView(p);
  if (p.screen === "artifactnew") return createView(p);
  const slice = routeDetail(p);
  if (!slice || slice.status === "idle" || (slice.status === "loading" && !slice.data)) return notice("Loading the artifact&hellip;");
  if (slice.status === "missing") return notFoundView(p);
  if (!slice.data) return notice("Couldn't load this artifact.", true);
  return p.route.diff ? diffView(p, slice.data, p.route.diff) : viewerView(p, slice.data);
}

// ── 1 · library ──────────────────────────────────────────────────────────────

interface FilterGroup { key: ArtFilterKey; label: string; options: { v: string; l: string }[] }

function libraryGroups(p: ArtProps, all: ArtifactSummaryDTO[]): FilterGroup[] {
  const authors = [...new Set(all.map((a) => a.author_id))];
  const sprintIds = new Set(all.flatMap((a) => a.sprint_ids));
  // Every known sprint is offered (the design lists the sprints, not just the linked ones);
  // a linked sprint the sprint list doesn't know still gets a row.
  const sprints = [...p.sprints.map((s) => ({ v: String(s.id), l: s.label })),
    ...[...sprintIds].filter((id) => !p.sprints.some((s) => s.id === id)).map((id) => ({ v: String(id), l: `Sprint #${id}` }))];
  return [
    { key: "area", label: "Area", options: [{ v: "all", l: "All areas" }, ...ARTIFACT_AREAS.map((x) => ({ v: x, l: x }))] },
    { key: "kind", label: "Kind", options: [{ v: "all", l: "All kinds" }, ...ARTIFACT_KINDS.map((x) => ({ v: x, l: x }))] },
    { key: "author", label: "Author", options: [{ v: "all", l: "Any author" }, ...authors.map((h) => ({ v: h, l: who(p, h).name }))] },
    { key: "status", label: "Status", options: [{ v: "all", l: "Any status" }, ...ARTIFACT_STATUSES.map((x) => ({ v: x, l: x[0].toUpperCase() + x.slice(1) }))] },
    { key: "sprint", label: "Sprint", options: [{ v: "all", l: "Any sprint" }, ...sprints] },
  ];
}

const matchesFilter = (a: ArtifactSummaryDTO, k: ArtFilterKey, v: string): boolean =>
  v === "all" || (k === "sprint" ? a.sprint_ids.includes(Number(v)) : k === "area" ? a.area === v : k === "kind" ? a.kind === v : k === "author" ? a.author_id === v : a.status === v);

/** The library's cards: the list, filtered and searched client-side, newest first. */
export function libraryRows(p: ArtProps): ArtifactSummaryDTO[] {
  const items = p.ui.list.data ?? [];
  const q = p.ui.q.trim().toLowerCase();
  const tix = new Map(p.tickets.map((t) => [t.id, t.title]));
  return items
    .filter((a) => ART_FILTER_KEYS.every((k) => matchesFilter(a, k, p.ui.f[k])))
    .filter((a) => {
      if (!q) return true;
      const t = a.ticket_ids.map((id) => `#${id} ticket ${id} ${tix.get(id) ?? ""}`).join(" ");
      return `${a.title} ${a.slug} ${a.area} ${a.kind} ${t}`.toLowerCase().includes(q);
    })
    .sort((x, y) => (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0));
}

/** A card's 160px preview. Framed kinds load the raw route in a script-less sandbox. */
function thumb(a: ArtifactSummaryDTO): string {
  const raw = rawUrl(a.slug, a.current_version);
  if (!rawAvailable && (a.kind === "html" || a.kind === "svg" || a.kind === "image")) return rawUnavailable(true);
  if (a.kind === "html" || a.kind === "svg") {
    // Never same-origin. An html page may run its scripts — the same opaque-origin
    // `allow-scripts` sandbox the viewer uses, under the raw route's CSP (no network, no
    // forms) — because a page that renders WITH JavaScript (a flattened Claude Design
    // export) otherwise previews as its unrendered template. An svg renders without
    // script, so its frame stays `sandbox=""`: it can do nothing. No allow-modals, no
    // top navigation, pointer-events off; its `trov:height` posts are ignored (main.ts
    // only resizes `.art-frame` iframes).
    const sandbox = a.kind === "html" ? "allow-scripts" : "";
    return `<iframe title="${attr(a.title)} preview" src="${attr(raw)}" sandbox="${sandbox}" tabindex="-1" loading="lazy" referrerpolicy="no-referrer" style="position:absolute;top:0;left:0;width:400%;height:400%;border:0;transform:scale(.25);transform-origin:0 0;pointer-events:none;background:#fff"></iframe>`;
  }
  if (a.kind === "image") {
    return `<img src="${attr(raw)}" alt="" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block">`;
  }
  if (a.kind === "markdown" || a.kind === "mermaid") {
    const src = a.excerpt ?? "";
    const text = a.kind === "markdown"
      ? src.split("\n").map((l) => l.replace(/^#+\s*|^>\s*|[*_`|]/g, "").trim()).filter((l) => l && !/^-+$/.test(l)).slice(0, 7).join("\n")
      : src.split("\n").slice(0, 9).join("\n");
    return `<div style="padding:16px 20px;font-size:11.5px;line-height:1.6;color:var(--fg-55);white-space:pre-wrap;${a.kind === "mermaid" ? "font-family:var(--code)" : ""}">${esc(text)}</div>`;
  }
  // pdf / file: the kind's icon.
  return `<div style="position:absolute;inset:0;display:grid;place-items:center;color:var(--fg-40)"><span style="display:flex;flex-direction:column;align-items:center;gap:8px">${I.kind(a.kind, 30)}<span style="${CHIP}color:var(--fg-55);border:1px solid var(--border)">${a.kind.toUpperCase()} · ${esc(fmtKB(a.size_bytes))}</span></span></div>`;
}

function libraryView(p: ArtProps): string {
  const ui = p.ui;
  if (ui.list.status === "error" && !ui.list.data) return notice("Couldn't load artifacts.", true);
  if (!ui.list.data) return notice("Loading artifacts&hellip;");
  const all = ui.list.data;
  const rows = libraryRows(p);
  const groups = libraryGroups(p, all);
  const active = ART_FILTER_KEYS.filter((k) => ui.f[k] !== "all").length;
  const menu: FilterMenuProps = {
    id: "art", open: ui.filterOpen, opening: p.fmOpening === "art", cat: ui.filterCat, activeCount: active,
    showLabel: `Show ${rows.length} ${rows.length === 1 ? "artifact" : "artifacts"}`, clearAct: "artFilterClear",
    align: "stretch", ariaLabel: "Filter artifacts",
    groups: groups.map((g) => ({
      key: g.key, label: g.label, value: ui.f[g.key], none: "all",
      options: g.options.map((o) => {
        const person = g.key === "author" && o.v !== "all" ? who(p, o.v) : null;
        return {
          v: o.v, l: o.l, act: "artFilterPick", arg: `${g.key}:${o.v}`,
          n: o.v === "all" ? all.length : all.filter((a) => matchesFilter(a, g.key, o.v)).length,
          lead: person ? av(person, 18) : undefined,
        };
      }),
    })),
  };


  const toolbar = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px">
    ${searchFilterBar({
      search: { act: "artQ", field: "artQ", value: ui.q, placeholder: "Search by title, area, kind or ticket", clearAct: "artClearQ" },
      menu,
    })}
    <span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap;margin-left:auto;flex:none">${rows.length} shown · ${all.length} total</span>
  </div>`;

  const card = (a: ArtifactSummaryDTO, i: number): string => {
    const au = who(p, a.author_id);
    // A `hitArea` card: the author's photo and name open their person card, the rest the artifact.
    return `<div${surface(`--i:${i};padding:0;display:flex;flex-direction:column;height:100%;width:100%;text-align:left;cursor:pointer;overflow:hidden`, { hover: true, cls: `cnpy-rise ${HITBOX}` })}>
      <div style="position:relative;height:160px;border-bottom:1px solid var(--border);overflow:hidden;background:var(--bg);flex:none">
        ${thumb(a)}
        <div style="position:absolute;left:0;right:0;bottom:0;height:36px;background:linear-gradient(to bottom,transparent,var(--bg));pointer-events:none"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:14px 16px;flex:1">
        <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;color:var(--fg);text-wrap:pretty;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(a.title)}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:auto;min-width:0">
          <span style="display:flex;min-width:76px;flex:0 1 auto">${personLink(personIn(p, a.author_id), a.author_id, 20, au.name, "min-width:0;font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap", 8)}</span>
          <span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-55);border:1px solid var(--border);border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none">${esc(a.area)}</span>
          ${a.visibility === "private" ? `<span style="${tint("var(--purple)")}">PRIVATE</span>` : ""}
          <span style="font-size:11.5px;color:var(--fg-40);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto">${esc(relTime(a.updated_at))}</span>
        </div>
      </div>
      ${hitArea("artOpen", a.slug, a.title)}
    </div>`;
  };

  const empty = rows.length === 0 ? `<div style="display:flex;justify-content:center;padding:56px 0">
    <div style="border:1px dashed var(--border-strong);border-radius:13px;padding:36px 44px;text-align:center;max-width:380px">
      ${all.length === 0
        ? `<div style="font-size:15px;font-weight:600;color:var(--fg-70)">No artifacts yet.</div>
           <div style="font-size:12.5px;color:var(--fg-40);margin-top:6px">Agents upload them over MCP, or add one yourself.</div>
           <button data-act="artNew" class="cnpy-outlinebtn" style="margin-top:16px;${OUTLINE_BTN};padding:6px 14px">New artifact</button>`
        : `<div style="font-size:15px;font-weight:600;color:var(--fg-70)">No artifacts match these filters.</div>
           <div style="font-size:12.5px;color:var(--fg-40);margin-top:6px">${ui.q.trim() ? `Nothing matches “${esc(ui.q.trim())}” with the current filters.` : "Try another area or status, or clear the filters."}</div>
           <button data-act="artFilterClear" class="cnpy-outlinebtn" style="margin-top:16px;${OUTLINE_BTN};padding:6px 14px">Clear filters</button>`}
    </div>
  </div>` : "";

  return `<div data-screen-label="Library" style="${SHELL}">
    ${toolbar}
    <div class="cnpy-stagger" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:14px;margin-top:18px">${rows.map(card).join("")}</div>
    ${empty}
  </div>`;
}

// ── 2 · viewer ───────────────────────────────────────────────────────────────

/** Measured heights of framed HTML artifacts (key `slug@v`): the rerender rebuilds
 *  the iframe, so the box is sized from here before the new frame reports in. */
const frameHeights = new Map<string, number>();
const FRAME_DEFAULT = 640;
/** Record a frame's reported document height; returns the height the box should take. */
export function setArtFrameHeight(key: string, h: number): number {
  const v = Math.round(Math.max(160, Math.min(h, 40000)));
  frameHeights.set(key, v);
  return v;
}

// Mermaid: rendered post-paint (renderPendingMermaid, called by main.ts after each
// paint) into a module cache keyed `slug@v|theme`, so a rerender inlines the SVG
// at once and only a miss shows "Rendering diagram…".
const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const mermaidSvgs = new Map<string, string>();
const mermaidFailed = new Set<string>();
const mermaidPending = new Map<string, string>();
const mermaidInflight = new Set<string>();
interface MermaidApi {
  initialize(c: Record<string, unknown>): void;
  render(id: string, src: string): Promise<{ svg: string }>;
}
let mermaidLib: Promise<MermaidApi> | null = null;
let mermaidSeq = 0;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLib) {
    const url = MERMAID_URL;
    mermaidLib = (import(/* @vite-ignore */ url) as Promise<{ default: MermaidApi }>).then((m) => m.default);
    mermaidLib.catch(() => { mermaidLib = null; });
  }
  return mermaidLib;
}
/** Draw every mermaid box a paint left waiting. Browser-only; never throws. */
export function renderPendingMermaid(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-art-mermaid]"))) {
    const key = el.dataset.artMermaid ?? "";
    const src = mermaidPending.get(key);
    if (src === undefined || mermaidInflight.has(key)) continue;
    mermaidInflight.add(key);
    const themed = el.closest("[data-cnpy-theme]") ?? document.documentElement;
    const cs = getComputedStyle(themed);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    // Every box showing this key, found at completion time (a rerender may have replaced `el`).
    const boxes = () => Array.from(document.querySelectorAll<HTMLElement>(`[data-art-mermaid="${key.replace(/["\\]/g, "\\$&")}"]`));
    loadMermaid().then(async (mermaid) => {
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: "Geist, system-ui, sans-serif",
        themeVariables: { background: v("--bg"), primaryColor: v("--bg"), primaryTextColor: v("--fg"), primaryBorderColor: v("--fg-40"), lineColor: v("--fg-55"), secondaryColor: v("--bg"), tertiaryColor: v("--bg"), edgeLabelBackground: v("--bg"), fontSize: "14px" },
        flowchart: { curve: "basis", padding: 14 },
      });
      const { svg: out } = await mermaid.render(`cnpy-mm-${++mermaidSeq}`, src);
      mermaidSvgs.set(key, out);
      for (const b of boxes()) { b.removeAttribute("data-art-mermaid"); b.innerHTML = out; }
    }).catch(() => {
      mermaidFailed.add(key);
      for (const b of boxes()) { b.removeAttribute("data-art-mermaid"); b.textContent = "Couldn't render this diagram."; }
    }).finally(() => { mermaidInflight.delete(key); mermaidPending.delete(key); });
  }
}

function banner(tag: string, tagSt: string, body: string, actions: string): string {
  return `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--border);border-radius:9px;margin-bottom:22px">
    <span style="font-size:10.5px;font-weight:600;font-family:var(--label);letter-spacing:.04em;${tagSt};border-radius:5px;padding:3px 7px;flex:none">${tag}</span>
    <div style="flex:1;min-width:220px;font-size:12.5px;color:var(--fg-70);line-height:1.45">${body}</div>
    ${actions}
  </div>`;
}
const tagTint = (c: string): string => `color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;

function ratifyHint(d: ArtifactDetailDTO, isLatest: boolean, p: ArtProps): string {
  if (d.status === "draft") return "Publish before ratifying";
  if (d.status === "ratified" && d.ratified_version !== null) {
    return `Ratified v${d.ratified_version}${d.ratified_by ? ` by ${who(p, d.ratified_by).first}` : ""}${d.ratified_at ? ` · ${relTime(d.ratified_at)}` : ""}`;
  }
  if (!isLatest) return "Only the latest version can be ratified";
  return "";
}

/** The viewer's body for one version, per kind. */
function contentBlock(p: ArtProps, d: ArtifactDetailDTO): string {
  const ver = d.version;
  const raw = d.raw_url || rawUrl(d.slug, ver.version_no);
  const key = `${d.slug}@${ver.version_no}`;
  if (!rawAvailable && (d.kind === "html" || d.kind === "image" || d.kind === "pdf")) return rawUnavailable();
  switch (d.kind) {
    case "html": {
      const h = frameHeights.get(key) ?? FRAME_DEFAULT;
      // allow-scripts WITHOUT allow-same-origin: the page runs in an opaque origin
      // (no cookies, no parent DOM), and tells us its height by postMessage.
      return `<div class="art-frame" data-art-key="${attr(key)}" style="position:relative;overflow:hidden;background:#fff;height:${h}px">
        <iframe title="${attr(d.title)}" src="${attr(raw)}" sandbox="allow-scripts" referrerpolicy="no-referrer" style="display:block;width:100%;height:100%;border:0;background:#fff"></iframe>
      </div>`;
    }
    case "svg":
      return `<div class="art-svg" style="display:grid;place-items:center;padding:40px 24px;min-height:320px;background:var(--bg);color:var(--fg);overflow-x:auto">${sanitizeSvg(d.content ?? "")}</div>`;
    case "markdown":
      return `<div style="background:var(--bg);padding:36px clamp(20px,4vw,56px) 44px"><div class="cnpy-md" style="max-width:760px;margin:0 auto">${renderMarkdown(d.content ?? "")}</div></div>`;
    case "mermaid": {
      const mk = `${key}|${p.theme}`;
      const box = "display:grid;place-items:center;padding:36px 24px;min-height:300px;background:var(--bg);color:var(--fg-40);font-size:12.5px;overflow-x:auto";
      const done = mermaidSvgs.get(mk);
      if (done !== undefined) return `<div class="art-mermaid" style="${box}">${done}</div>`;
      if (mermaidFailed.has(mk)) return `<div class="art-mermaid" style="${box}">Couldn't render this diagram.</div>`;
      mermaidPending.set(mk, d.content ?? "");
      return `<div class="art-mermaid" data-art-mermaid="${attr(mk)}" style="${box}">Rendering diagram…</div>`;
    }
    case "image":
      return `<div style="display:grid;place-items:center;padding:32px 24px;background:var(--bg)"><img src="${attr(raw)}" alt="${attr(d.title)}" style="display:block;max-width:100%;height:auto"></div>`;
    case "pdf":
      // NOT sandboxed: Chrome will not draw a PDF inside any `sandbox`, so the frame
      // would stay blank. It is safe unsandboxed because of what the raw route serves
      // for a pdf, pinned in test/artifacts.security-raw.test.ts: ALWAYS
      // `application/pdf` (whatever type was declared at upload), `nosniff`, and
      // `default-src 'none'` — the browser's PDF viewer renders it, and nothing in it
      // can run as a page in Trov's origin.
      return `<div style="background:var(--bg)">
        <iframe title="${attr(d.title)}" src="${attr(raw)}" style="display:block;width:100%;height:78vh;min-height:480px;border:0;background:#fff"></iframe>
        <div style="padding:10px 14px;border-top:1px solid var(--border);font-size:12.5px;color:var(--fg-55)"><a href="${attr(raw)}" target="_blank" rel="noopener" class="cnpy-link" style="color:var(--accent);font-weight:500">Open PDF in a new tab</a></div>
      </div>`;
    default: {
      const name = artFileName(d.slug, d.kind, ver);
      return `<div style="display:grid;place-items:center;padding:48px 24px;background:var(--bg)">
        <div style="display:flex;align-items:center;gap:14px;width:min(480px,100%);padding:14px 16px;border:1px solid var(--border);border-radius:10px">
          <span style="width:36px;height:36px;border-radius:8px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);flex:none">${I.kind(d.kind, 16)}</span>
          <span style="flex:1;min-width:0"><span style="display:block;font-family:var(--label);font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span><span style="display:block;font-size:11.5px;color:var(--fg-40);margin-top:2px">${esc(fmtKB(ver.size_bytes))}${ver.content_type ? ` · ${esc(ver.content_type)}` : ""}</span></span>
          <button data-act="artDownload" class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;${ACCENT_BTN};flex:none">${I.download()}Download</button>
        </div>
      </div>`;
    }
  }
}

function viewerView(p: ArtProps, d: ArtifactDetailDTO): string {
  const ui = p.ui;
  const ver = d.version;
  const versions = [...d.versions].sort((x, y) => x.version_no - y.version_no);
  const latestNo = d.current_version;
  const latest = versions.find((x) => x.version_no === latestNo) ?? versions[versions.length - 1] ?? ver;
  const isLatest = ver.version_no === latestNo;
  const isPriv = d.visibility === "private";
  const mine = sameHandle(d.author_id, p.me);
  const author = who(p, d.author_id);
  const canRat = canRatify(d.status, ver.version_no, latestNo);
  const hint = ratifyHint(d, isLatest, p);
  const many = versions.length > 1;
  const cmpBase = isLatest ? versions[versions.length - 2] : ver;
  const vArg = (n: number) => (n === latestNo ? d.slug : `${d.slug}@v${n}`);

  const oldBanner = !isLatest ? banner(`V${ver.version_no}`, tagTint("var(--blue)"),
    `You're viewing an <strong style="font-weight:600;color:var(--fg)">older version</strong> from ${esc(relTime(ver.created_at))}. The latest is v${latestNo}.`,
    `<button data-act="artDiff" data-arg="${attr(`${d.slug}:${ver.version_no}..${latestNo}`)}" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--fg-55);white-space:nowrap;flex:none">Compare with v${latestNo}</button>
     <button data-act="artOpen" data-arg="${attr(d.slug)}" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap;flex:none">View latest${I.arrow()}</button>`) : "";

  // The visibility switch: only the author may make an org artifact private. Both states
  // are colored — org green, private purple — so "Org" never reads as switched off.
  // Both labels share one grid cell (the idle one hidden), so the chip is always as wide as the
  // longer label and flipping it never changes its size.
  const gated = !isPriv && !mine;
  const tone = isPriv ? "var(--purple)" : "var(--green)";
  const visSwitch = `<button data-act="artVis" role="switch" aria-checked="${isPriv}" title="${gated ? "Only the author can make this private" : isPriv ? "Publish to the org" : "Make private"}" class="${gated ? "" : "cnpy-ghostbtn"}" style="display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 6px 0 11px;border-radius:999px;font-size:12.5px;font-weight:500;white-space:nowrap;border:1px solid color-mix(in srgb,${tone} 45%,transparent);color:${tone};background:color-mix(in srgb,${tone} 10%,transparent);${gated ? "opacity:.6;cursor:not-allowed" : ""}">
    ${isPriv ? I.lock() : I.people()}
    <span style="display:grid;text-align:center">${(["Private", "Org"] as const).map((l) => `<span style="grid-area:1/1${(l === "Private") === isPriv ? "" : ";visibility:hidden"}"${(l === "Private") === isPriv ? "" : ' aria-hidden="true"'}>${l}</span>`).join("")}</span>
    <span style="position:relative;width:30px;height:18px;border-radius:999px;flex:none;transition:background .18s ease;background:${tone}"><span style="position:absolute;top:2px;left:${isPriv ? 14 : 2}px;width:14px;height:14px;border-radius:999px;background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .18s cubic-bezier(.4,0,.2,1)"></span></span>
  </button>`;

  const verMenu = ui.verMenu ? `<div data-act="artCloseMenus" style="position:fixed;inset:0;z-index:29"></div>
    <div role="menu" style="position:absolute;top:calc(100% + 6px);left:0;z-index:30;width:320px;max-width:calc(100vw - 40px);${MENU};padding:5px;animation:cnpy-pop .14s ease both">
      <div style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);padding:6px 10px 4px">VERSIONS</div>
      <div class="cnpy-scroll" style="max-height:320px;overflow-y:auto">
      ${[...versions].reverse().map((x) => `<button data-act="artOpen" data-arg="${attr(vArg(x.version_no))}" role="menuitem" class="cnpy-menurow" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:7px 10px;border-radius:7px">
        <span style="font-family:var(--label);font-size:12px;font-weight:600;color:var(--fg);min-width:22px;flex:none">v${x.version_no}</span>
        <span style="flex:1;min-width:0"><span style="display:block;font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.summary || "No summary")}</span><span style="display:block;font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px"><span style="font-family:var(--sans);letter-spacing:0">@${esc(x.created_by)}</span> · ${esc(relTime(x.created_at))}</span></span>
        ${I.check("currentColor", "flex:none;" + (x.version_no === ver.version_no ? "color:var(--accent)" : "visibility:hidden"))}
      </button>`).join("")}
      </div>
      <div style="height:1px;background:var(--border);margin:5px 4px"></div>
      <button ${many && cmpBase ? `data-act="artDiff" data-arg="${attr(`${d.slug}:${cmpBase.version_no}..${latestNo}`)}"` : "disabled"} role="menuitem" class="cnpy-menurow" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:${many ? "var(--fg-70)" : "var(--fg-40)"};cursor:${many ? "pointer" : "default"}">${I.compare()}${many && cmpBase ? `Compare v${cmpBase.version_no} → v${latestNo}` : "Only one version"}</button>
    </div>` : "";

  // The status switch — the shared segmented control. The picked option keeps its act (the
  // reducer ignores a same-status click). Not dimmed while a write is in flight (that flashed
  // the row on every switch) — the reducer already ignores a click while busy.
  const statusSeg = segmented({
    id: "art-status", ariaLabel: "Status", act: "artStatus", value: d.status, size: "xs",
    options: ARTIFACT_STATUSES.map((k) => {
      const on = d.status === k;
      const title = k === "ratified" && !on && !canRat ? hint || "Publish before ratifying" : k === "ratified" && !on ? `Ratify v${ver.version_no}` : k === "ratified" && on ? hint : "";
      return {
        value: k, label: k[0].toUpperCase() + k.slice(1), title: title || undefined,
        ...(k === "ratified" ? { icon: I.shield(), tone: "accent" as const, locked: !on && !canRat } : {}),
      };
    }),
  });

  // "Delete artifact" (author / admin only) closes the menu and opens the shared
  // confirmation modal (web/src/confirm.ts, rendered by artifactsDialogs) — never window.confirm.
  const canDelete = canDeleteArtifact(d, p.me, p.admin);
  const dotMenu = ui.dotMenu ? `<div data-act="artCloseMenus" style="position:fixed;inset:0;z-index:29"></div>
    <div role="menu" style="position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:210px;${MENU};padding:5px;animation:cnpy-pop .14s ease both">
      ${[["artCopyLink", I.link(), "Copy link"], ["artDownload", I.download(), "Download raw"], ["artOpenTab", I.ext(), "Open in new tab"]].map(([act, icon, label]) =>
        `<button data-act="${act}" role="menuitem" class="cnpy-menurow" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-70)">${icon}${label}</button>`).join("")}
      ${canDelete ? `<div style="height:1px;background:var(--border);margin:5px 4px"></div>
      <button data-act="artDeleteArm" role="menuitem" aria-haspopup="dialog" class="cnpy-menurow" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--red)">${I.trash()}Delete artifact</button>` : ""}
    </div>` : "";

  const toolbar = `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:6px;border-bottom:1px solid var(--border)">
    <div style="position:relative;flex:none">
      <button data-act="artVerMenu" aria-haspopup="menu" aria-expanded="${ui.verMenu}" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:3px 8px 3px 9px;white-space:nowrap">
        ${I.history()}
        <span style="font-family:var(--label);font-weight:600;color:var(--fg)">v${ver.version_no}</span>
        ${isLatest ? `<span style="font-family:var(--label);font-size:9.5px;font-weight:600;color:var(--fg-40)">LATEST</span>` : ""}
        ${I.caret()}
      </button>
      ${verMenu}
    </div>
    <span style="flex:1 1 120px;min-width:0;padding-left:4px;font-family:var(--sans);font-size:11px;color:var(--fg-55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.host)}/#artifacts/${esc(d.slug)}/v${ver.version_no}</span>
    ${statusSeg}
    <span style="width:1px;height:18px;background:var(--border);flex:none"></span>
    <button data-act="artNvOpen" title="${isBinaryKind(d.kind) ? "Upload a replacement file" : `Edit v${ver.version_no} or upload a replacement`}" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--border);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap;flex:none">${I.plus(12)}New version</button>
    <button data-act="artOpenTab" title="Open in new tab" aria-label="Open in new tab" class="cnpy-iconbtn" style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-55);flex:none">${I.ext()}</button>
    <div style="position:relative;flex:none">
      <button data-act="artDotMenu" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded="${ui.dotMenu}"${canDelete ? " data-confirm-trigger" : ""} class="cnpy-iconbtn" style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-55)">${I.dots()}</button>
      ${dotMenu}
    </div>
  </div>`;

  const propRow = (k: string, v: string) => `<div style="display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;align-items:center;min-height:36px;border-top:1px solid var(--border)">
    <div style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)">${k}</div>
    <div style="min-width:0;display:flex;align-items:center;gap:8px">${v}</div>
  </div>`;
  const props = [
    propRow("KIND", `<span style="${NEUTRAL}">${d.kind.toUpperCase()}</span>`),
    propRow("AREA", `<span style="${CHIP}color:var(--fg-40);border:1px solid var(--border)">${esc(d.area)}</span>`),
    propRow("REPO", d.repo ? `<a href="https://github.com/${attr(d.repo)}" target="_blank" rel="noopener" style="${MONO_VAL};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.repo)}</a>` : `<span style="${MONO_VAL};color:var(--fg-40)">—</span>`),
    propRow("AUTHOR", personLink(personIn(p, d.author_id), d.author_id, 20, { html: `${esc(author.name)} <span style="font-family:var(--sans);font-size:11px;color:var(--p-${author.color})">@${esc(author.handle)}</span>` }, "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--fg-70)", 8)),
    propRow("UPDATED", `<span style="font-size:12.5px;color:var(--fg-70)">v${latest.version_no} · ${esc(relTime(latest.created_at))} by ${personNameLink(personIn(p, latest.created_by), `@${latest.created_by}`)}</span>`),
    ...(d.ratified_version !== null ? [propRow("RATIFIED", `<span style="font-size:12.5px;color:var(--fg-70)">v${d.ratified_version}${d.ratified_at ? ` · ${esc(relTime(d.ratified_at))}` : ""}${d.ratified_by ? ` by ${personNameLink(personIn(p, d.ratified_by), `@${d.ratified_by}`)}` : ""}</span>`)] : []),
  ].join("");

  const linkCard = (icon: string, title: string, meta: string, mono = false) =>
    ` class="cnpy-card" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--bg);min-width:0;text-decoration:none">
      <span style="width:26px;height:26px;border-radius:6px;background:var(--hover);display:grid;place-items:center;color:var(--fg-55);flex:none">${icon}</span>
      <span style="min-width:0;flex:1"><span style="display:block;font-size:13px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${mono ? "font-family:var(--label)" : ""}">${esc(title)}</span><span style="display:block;font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">${esc(meta)}</span></span>`;
  const byType = (t: ArtifactLinkType) => d.links.filter((l) => l.target_type === t);
  const tix = byType("ticket").map((l) => {
    const t = p.tickets.find((x) => String(x.id) === l.target_ref);
    const status = t ? TSTATUS[t.status]?.[0] ?? t.status.toUpperCase() : l.meta?.toUpperCase() ?? "";
    return `<button data-act="openTicket" data-arg="${attr(l.target_ref)}"${linkCard(I.ticket(), l.label ?? t?.title ?? `Ticket #${l.target_ref}`, `TICKET #${l.target_ref}${status ? ` · ${status}` : ""}`)}</button>`;
  });
  const spr = byType("sprint").map((l) => {
    const sp = p.sprints.find((x) => String(x.id) === l.target_ref);
    const meta = sp ? `${(sp.dates ?? "").toUpperCase()}${sp.active ? `${sp.dates ? " · " : ""}ACTIVE` : ""}` : (l.meta ?? "").toUpperCase();
    return `<div${linkCard(I.flag(), l.label ?? sp?.label ?? `Sprint #${l.target_ref}`, meta)}</div>`;
  });
  const gh = [...byType("pr"), ...byType("issue")].map((l) => {
    const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(l.target_ref);
    const pr = l.target_type === "pr";
    const href = m ? `https://github.com/${m[1]}/${m[2]}/${pr ? "pull" : "issues"}/${m[3]}` : null;
    const label = m ? `#${m[3]}` : l.target_ref;
    const meta = `${pr ? "PULL REQUEST" : "ISSUE"}${m ? ` · ${m[2].toUpperCase()}` : ""}`;
    return href
      ? `<a href="${attr(href)}" target="_blank" rel="noopener"${linkCard(I.gh(), label, meta, true)}</a>`
      : `<div${linkCard(I.gh(), label, meta, true)}</div>`;
  });
  const links = [...tix, ...spr, ...gh];

  return `<div data-screen-label="Artifact viewer" style="${SHELL}">
    ${oldBanner}
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px 24px;flex-wrap:wrap">
      <div style="min-width:0;flex:1 1 380px"><h1 style="font-size:29px;font-weight:650;letter-spacing:-0.022em;line-height:1.16;margin:0;text-wrap:pretty">${esc(d.title)}</h1></div>
      <div style="padding-top:3px">${visSwitch}</div>
    </div>

    <div${surface("margin-top:22px;border-color:var(--border-strong)")}>
      ${toolbar}
      <div style="border-radius:0 0 10px 10px;overflow:hidden">${contentBlock(p, d)}</div>
    </div>

    <div data-screen-label="Artifact details" class="art-bento" style="display:grid;gap:14px;margin-top:18px">
      <div${surface("padding:16px 18px;min-width:0", { cls: "art-b-props" })}>
        <div style="display:flex;align-items:center;height:24px;margin-bottom:8px"><div style="${EYEBROW}">Properties</div></div>
        ${props}
      </div>
      <div${surface("padding:16px 18px;min-width:0", { cls: "art-b-links" })}>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;height:24px;margin-bottom:8px">
          <div style="${EYEBROW}">Linked work</div>
          <button data-act="artAttachOpen" title="Attach to ticket" class="cnpy-iconbtn" style="display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:500;color:var(--fg-55)">${I.plus(12)}Attach ticket</button>
        </div>
        ${links.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr));gap:8px">${links.join("")}</div>` : `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0 4px">Nothing linked yet.</div>`}
      </div>
    </div>
  </div>`;
}

// ── 3 · diff ─────────────────────────────────────────────────────────────────

function diffView(p: ArtProps, d: ArtifactDetailDTO, pair: { a: number; b: number }): string {
  const versions = [...d.versions].sort((x, y) => x.version_no - y.version_no);
  const same = pair.a === pair.b;
  const slice = same ? null : p.ui.diffs[diffKey(d.slug, pair.a, pair.b)];
  const dd = slice?.data ?? null;
  const vOf = (n: number): ArtifactVersionDTO | undefined => versions.find((x) => x.version_no === n);
  const va = dd?.a ?? vOf(pair.a);
  const vb = dd?.b ?? vOf(pair.b);
  const text = isTextKind(d.kind);
  const rows = dd && text ? collapsedLineDiff(dd.a.content ?? "", dd.b.content ?? "") : [];
  const adds = rows.filter((x) => x.t === "add").length;
  const dels = rows.filter((x) => x.t === "del").length;
  const opts = (sel: number) => versions.map((x) => `<option value="${x.version_no}"${x.version_no === sel ? " selected" : ""}>v${x.version_no} · ${esc(relTime(x.created_at))}</option>`).join("");
  const side = (x: ArtifactVersionDTO | undefined, n: number, tag: string, color: string) => {
    const w = x ? who(p, x.created_by) : null;
    return `<div${surface("padding:12px 14px")}>
      <div style="display:flex;align-items:center;gap:8px"><span style="${CHIP}color:${color};border:1px solid color-mix(in srgb,${color} 38%,transparent)">${tag}</span><span style="font-family:var(--label);font-size:12px;font-weight:600">v${n}</span></div>
      ${x && w ? `<div style="font-size:13px;color:var(--fg-70);margin-top:7px">${esc(x.summary || "No summary")}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11.5px;color:var(--fg-40)">${personLink(personIn(p, x.created_by), x.created_by, 16, `@${w.handle}`, `font-family:var(--sans);font-size:11px;font-weight:500;color:var(--p-${w.color})`, 6)} · ${esc(relTime(x.created_at))}</div>` : `<div style="font-size:13px;color:var(--fg-40);margin-top:7px">No such version.</div>`}
    </div>`;
  };
  const base = "font-family:var(--code);font-size:12.5px;line-height:1.75;padding:2px 16px 2px 12px;white-space:pre-wrap;word-break:break-word;color:var(--fg-55)";
  const lineSt = (t: string) => t === "del" ? base + ";background:color-mix(in srgb,var(--red) 7%,transparent)"
    : t === "add" ? base + ";background:color-mix(in srgb,var(--green) 7%,transparent);color:var(--fg-70)"
      : t === "ellipsis" ? base + ";color:var(--fg-40);background:var(--hover);font-size:11.5px" : base;

  let body: string;
  if (same) body = `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">Pick two different versions to compare.</div>`;
  else if (!slice || slice.status === "idle" || (slice.status === "loading" && !dd)) body = `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">Loading the comparison&hellip;</div>`;
  else if (!dd) body = `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">Couldn't load this comparison. <button data-act="artRetry" class="cnpy-link" style="font-size:13px;color:var(--accent);padding:0">Try again</button></div>`;
  else if (text) {
    body = rows.length === 0 || rows.every((x) => x.t === "ctx")
      ? `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">These versions are identical.</div>`
      : `<div${surface("overflow:hidden;padding:8px 0;margin-top:18px")}>${rows.map((x) => {
        const pre = x.t === "del" ? "−" : x.t === "add" ? "+" : "";
        const preColor = x.t === "del" ? "var(--red)" : x.t === "add" ? "var(--green)" : "var(--fg-40)";
        return `<div style="display:flex;${lineSt(x.t)}"><span style="display:inline-block;width:18px;flex:none;color:${preColor}">${pre}</span><span style="min-width:0">${esc(x.t === "ellipsis" ? "⋯ " + x.text : x.text || " ")}</span></div>`;
      }).join("")}</div>`;
  } else if (d.kind === "image") {
    const pane = (x: typeof dd.a, tag: string) => `<figure${surface("margin:0;overflow:hidden")}>
      <div style="position:relative;display:grid;place-items:center;padding:18px;min-height:220px">${rawAvailable ? `<img src="${attr(x.raw_url || rawUrl(d.slug, x.version_no))}" alt="${attr(`${d.title} v${x.version_no}`)}" style="display:block;max-width:100%;height:auto">` : rawUnavailable(true)}</div>
      <figcaption style="padding:8px 12px;border-top:1px solid var(--border);font-family:var(--label);font-size:11px;color:var(--fg-55)">${tag} · v${x.version_no} · ${esc(fmtKB(x.size_bytes))}</figcaption>
    </figure>`;
    body = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:10px;margin-top:18px">${pane(dd.a, "BASE")}${pane(dd.b, "COMPARED")}</div>`;
  } else {
    const meta = (x: typeof dd.a) => `<div style="display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 10px;font-size:12.5px">
      <span style="${EYEBROW};font-size:10px">SIZE</span><span style="color:var(--fg-70)">${esc(fmtKB(x.size_bytes))}</span>
      <span style="${EYEBROW};font-size:10px">TYPE</span><span style="${MONO_VAL}">${esc(x.content_type || "—")}</span>
      <span style="${EYEBROW};font-size:10px">SHA-256</span><span style="${MONO_VAL};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${attr(x.sha256)}">${esc(x.sha256.slice(0, 16))}…</span>
    </div>`;
    body = `<div${surface("padding:16px 18px;margin-top:18px")}>
      <div style="font-size:12.5px;color:var(--fg-55);margin-bottom:14px">${dd.a.sha256 === dd.b.sha256 ? "Both versions are the same file." : `A ${d.kind === "pdf" ? "PDF" : "file"} can't be compared line by line — here is what changed.`}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:18px">${meta(dd.a)}${meta(dd.b)}</div>
    </div>`;
  }

  const openArg = pair.b === d.current_version ? d.slug : `${d.slug}@v${pair.b}`;
  return `<div data-screen-label="Version diff" style="width:100%;max-width:1120px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px">
    <div style="font-family:var(--label);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--fg-40);margin-bottom:11px">Compare versions <span style="color:var(--border-strong);margin:0 2px">/</span> ${d.kind.toUpperCase()}</div>
    <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(d.title)}</h2>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px">
      <select data-act="artDiffA" data-arg="${attr(d.slug)}" class="cnpy-select" aria-label="Base version">${opts(pair.a)}</select>
      <span style="color:var(--fg-40);display:inline-flex">${I.arrow(14)}</span>
      <select data-act="artDiffB" data-arg="${attr(d.slug)}" class="cnpy-select" aria-label="Compared version">${opts(pair.b)}</select>
      ${text && dd ? `<span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--green);margin-left:6px">+${adds}</span>
      <span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--red)">−${dels}</span>` : ""}
      <span style="flex:1"></span>
      <button data-act="artOpen" data-arg="${attr(openArg)}" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:5px 11px;white-space:nowrap">Open v${pair.b}</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:10px;margin-top:18px">${side(va, pair.a, "BASE", "var(--red)")}${side(vb, pair.b, "COMPARED", "var(--green)")}</div>
    ${body}
  </div>`;
}

/** Under the content, on the create form AND the New version dialog: the size bar against the kind's
 *  cap, the over-the-cap notice, and the two warn-never-block notices (claude.ai-only calls, a bundled
 *  Claude Design export that must be flattened). */
function contentChecks(text: string, bytes: number, kind: ArtifactKind): string {
  const cap = artifactCap(kind);
  const binary = isBinaryKind(kind);
  const over = bytes > cap;
  const hits = binary ? [] : claudeOnlyHits(text);
  const bundled = !binary && isBundledExport(text);
  return `<div style="display:flex;align-items:center;gap:12px;margin-top:12px">
    <div style="flex:1;height:4px;border-radius:4px;background:var(--hover);overflow:hidden"><div style="height:100%;width:${Math.min(100, (bytes / cap) * 100).toFixed(1)}%;background:${over ? "var(--red)" : "var(--accent)"};transition:width .3s ease"></div></div>
    <span style="font-family:var(--label);font-size:11px;font-weight:600;white-space:nowrap;color:${over ? "var(--red)" : "var(--fg-40)"}">${fmtKB(bytes)} / ${capLabel(kind)}</span>
  </div>
  ${over ? `<div style="display:flex;align-items:flex-start;gap:10px;margin-top:12px;padding:11px 14px;border:1px solid color-mix(in srgb,var(--red) 40%,transparent);background:color-mix(in srgb,var(--red) 8%,transparent);border-radius:9px;font-size:12.5px;color:var(--fg-70);line-height:1.5">
    ${I.alert()}<div><strong style="font-weight:600;color:var(--red)">Over the ${capLabel(kind)} cap.</strong> This content is ${fmtKB(bytes)}. ${binary ? "Compress or split the file, then try again." : "Split it into smaller pages or strip inlined assets, then try again."}</div>
  </div>` : ""}
  ${hits.length ? `<div style="display:flex;align-items:flex-start;gap:14px;margin-top:12px;padding:12px 14px;border:1px solid var(--border);border-radius:9px">
    <span style="font-size:10.5px;font-weight:600;font-family:var(--label);letter-spacing:.04em;${tagTint("var(--amber)")};border-radius:5px;padding:3px 7px;flex:none">CLAUDE.AI ONLY</span>
    <div style="flex:1;font-size:12.5px;color:var(--fg-70);line-height:1.55">
      This page calls features that only exist inside claude.ai. Trov renders artifacts in a sandbox with no network, so these calls will fail and parts of the page may render empty. You can still upload it.
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${hits.map((h) => `<code style="font-family:var(--code);font-size:11px;color:var(--fg);background:color-mix(in srgb,var(--fg) 6%,transparent);border:1px solid var(--border);border-radius:5px;padding:1.5px 6px">${esc(h)}</code>`).join("")}</div>
    </div>
  </div>` : ""}
  ${bundled ? `<div style="display:flex;align-items:flex-start;gap:14px;margin-top:12px;padding:12px 14px;border:1px solid var(--border);border-radius:9px">
    <span style="font-size:10.5px;font-weight:600;font-family:var(--label);letter-spacing:.04em;${tagTint("var(--amber)")};border-radius:5px;padding:3px 7px;flex:none">FLATTEN FIRST</span>
    <div style="flex:1;font-size:12.5px;color:var(--fg-70);line-height:1.55">
      This is a bundled Claude Design export (a hi-fi clickable prototype). It loads its scripts from blob: URLs and compiles code at runtime, which Trov's sandbox blocks, so it will render blank. Flatten it first, with every script inline and no eval, then upload that. You can still upload it as is.
    </div>
  </div>` : ""}`;
}

// ── 4 · create ───────────────────────────────────────────────────────────────

function createView(p: ArtProps): string {
  const c = p.ui.c;
  const bytes = createBytes(c);
  const text = createText(c);
  const cap = artifactCap(c.kind);
  const binary = isBinaryKind(c.kind);
  const canSubmit = canSubmitCreate(c);
  const label = (t: string) => `<label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">${t}</label>`;
  const inputSt = "width:100%;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none";
  const preview = text.length > 6000 ? text.slice(0, 6000) + "\n…" : text;
  const prePreview = (mt: number) => `<pre class="cnpy-scroll" style="margin:${mt}px 0 0;flex:1;min-height:280px;max-height:420px;overflow:auto;padding:12px 13px;border:1px solid var(--border);border-radius:9px;font-family:var(--code);font-size:12px;line-height:1.6;color:var(--fg-55);white-space:pre">${esc(preview)}</pre>`;

  let source = "";
  if (c.tab === "paste") {
    source = `<textarea data-act="artCPaste" data-field="artCPaste" class="cnpy-input cnpy-scroll" spellcheck="false" placeholder="Paste the page's full source: HTML, markdown, SVG or a mermaid diagram." style="width:100%;min-height:360px;flex:1;resize:vertical;padding:12px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-family:var(--code);font-size:12px;line-height:1.6;outline:none;white-space:pre">${esc(c.paste)}</textarea>`;
  } else if (c.tab === "file") {
    source = !c.file
      ? `<div data-art-drop style="border:1px dashed var(--border-strong);border-radius:11px;padding:56px 24px;text-align:center;min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
          ${I.upload()}
          <div style="font-size:14px;font-weight:600;color:var(--fg-70)">Drop one file here</div>
          <div style="font-size:12.5px;color:var(--fg-40)">.html, .md, .svg or .mmd up to 750 KB · images, PDFs and other files up to 10 MB</div>
          <label class="cnpy-outlinebtn" style="margin-top:12px;${OUTLINE_BTN};padding:6px 14px;cursor:pointer">Choose file<input type="file" data-art-file style="display:none"></label>
        </div>`
      : `<div${surface("display:flex;align-items:center;gap:12px;padding:12px 14px")}>
          <span style="width:30px;height:30px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);flex:none">${binary ? I.kind(c.kind, 14) : I.file()}</span>
          <span style="flex:1;min-width:0"><span style="display:block;font-family:var(--label);font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.file.name)}</span><span style="display:block;font-size:11.5px;color:var(--fg-40);margin-top:1px">${fmtKB(c.file.size)} · ${c.kind}${c.file.size > cap ? " · over the cap" : ""}</span></span>
          <button data-act="artCRemoveFile" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-40)">Remove</button>
        </div>${binary ? "" : prePreview(10)}`;
  } else {
    source = `<div style="display:flex;gap:8px">
        <input data-act="artCUrl" data-field="artCUrl" data-enter="artCFetch" class="cnpy-input" value="${attr(c.url)}" placeholder="https://…/page.html" style="flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--label);outline:none">
        <button data-act="artCFetch" class="cnpy-outlinebtn" style="padding:0 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">${c.fetching ? "Fetching…" : "Fetch"}</button>
      </div>
      <div style="font-size:12px;color:var(--fg-40);margin-top:7px">Trov fetches the page once and stores a copy. Later changes at the URL don't update the artifact.</div>
      ${c.urlErr ? `<div style="font-size:12px;color:var(--red);margin-top:7px">${esc(c.urlErr)}</div>` : ""}
      ${c.urlFetched ? prePreview(12) : ""}`;
  }

  // Paste and From URL are text-only: with a binary kind they are shown but locked.
  const tabs = segmented({
    id: "art-create-source", ariaLabel: "Content source", act: "artCTab", value: c.tab, size: "sm",
    options: ([["paste", "Paste"], ["file", "Upload file"], ["url", "From URL"]] as const).map(([k, l]) => {
      const off = binary && k !== "file";
      return { value: k, label: l, ...(off ? { locked: true, title: "Text kinds only" } : {}) };
    }),
  });

  return `<div data-screen-label="New artifact" style="${SHELL}">
    <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">New artifact</h2>
    <div style="font-size:13px;color:var(--fg-55);margin-top:6px">One self-contained page, stored and versioned in Trov. Agents upload over MCP; this form is for people.</div>
    <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,0.9fr) minmax(0,1.2fr);gap:34px;margin-top:24px">
      <div style="display:flex;flex-direction:column;gap:22px;min-width:0">
        <div>
          ${label("Title")}
          <input data-act="artCTitle" data-field="artCTitle" class="cnpy-input" value="${attr(c.title)}" placeholder="e.g. Google sign-in design page" style="${inputSt}">
          <div style="font-family:var(--sans);font-size:11px;color:var(--fg-40);margin-top:7px">${esc(p.host)}/#artifacts/${esc(slugifyTitle(c.title) || "…")}</div>
        </div>
        <div>${label("Kind")}${segmented({
          id: "art-create-kind", ariaLabel: "Kind", act: "artCKind", value: c.kind, size: "sm", className: "cnpy-seg--wrap",
          options: ARTIFACT_KINDS.map((k) => ({ value: k, label: k })),
        })}</div>
        <div>${label("Area")}<div style="display:flex;gap:6px;flex-wrap:wrap">${ARTIFACT_AREAS.map((k) => `<button data-act="artCArea" data-arg="${k}" class="cnpy-pickchip${c.area === k ? " is-on" : ""}" style="${chipSt(c.area === k)}">${k}</button>`).join("")}</div></div>
        <div>
          ${label("Repo")}
          ${(() => {
            const options = artifactRepoOptions(p.repos ?? [], c.repo);
            // No repository connected: the artifact is filed under none, and the field says where to connect one.
            if (!options.length) return `<div data-art-norepo style="min-height:40px;box-sizing:border-box;border:1px dashed var(--border-strong);border-radius:8px;padding:9px 12px;font-size:12.5px;line-height:1.5;color:var(--fg-55)">No repository is connected to this organization. <button type="button" data-act="orgGo" data-arg="repos" class="cnpy-mutelink" style="padding:0;font-size:12.5px;font-weight:500;color:var(--fg-70);text-decoration:underline;text-underline-offset:2px">Org settings &rsaquo; Repositories</button></div>`;
            return `<select data-act="artCRepo" aria-label="Repository" class="cnpy-select" style="width:100%;height:40px;font-size:13.5px;border-color:var(--border-strong);color:var(--fg)">${options.map((r) => `<option value="${attr(r)}"${c.repo === r ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>`;
          })()}
        </div>
        <div>
          ${label("Visibility")}${segmented({
            id: "art-create-vis", ariaLabel: "Visibility", act: "artCVis", value: c.vis, size: "sm",
            options: [{ value: "org", label: "Org" }, { value: "private", label: "Private" }],
          })}
          <div style="font-size:12px;color:var(--fg-40);margin-top:7px;line-height:1.5">${c.vis === "org" ? `Everyone in ${esc(p.orgName || "this organization")} can open it once it's uploaded.` : "Only you can open it. Teammates who follow the link see a not-found page until you publish."}</div>
        </div>
        <div>
          ${label("Links")}
          <div style="display:flex;gap:8px">
            <input data-act="artCLinkDraft" data-field="artCLinkDraft" data-enter="artCLinkAdd" class="cnpy-input" value="${attr(c.linkDraft)}" placeholder="#10, Sprint 14, or a GitHub PR / issue URL" style="flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--label);outline:none">
            <button data-act="artCLinkAdd" class="cnpy-outlinebtn" style="padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Link</button>
          </div>
          ${c.links.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${c.links.map((l, i) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 4px 3px 8px;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(l.kind)}</span><span style="font-family:var(--label);font-weight:500">${esc(l.label)}</span><button data-act="artCLinkRemove" data-arg="${i}" aria-label="Remove link" class="cnpy-xbtn" style="width:16px;height:16px;display:grid;place-items:center;color:var(--fg-40)">${I.x()}</button></span>`).join("")}</div>` : ""}
          ${c.linkErr ? `<div style="font-size:12px;color:var(--red);margin-top:7px">Not a ticket, sprint, PR or issue reference.</div>` : ""}
        </div>
      </div>

      <div style="border-left:1px solid var(--border);padding-left:34px;min-width:0;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
          <label style="font-size:13px;font-weight:500">Content</label>
          ${tabs}
        </div>
        ${source}
        ${contentChecks(text, bytes, c.kind)}
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:22px;flex-wrap:wrap">
          <span style="flex:1;min-width:180px;font-size:12px;color:var(--fg-40)">Uploads as v1, ${c.vis === "private" ? "private draft." : "draft, visible to the org."}</span>
          <button data-act="goArtifacts" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
          <button data-act="artCSubmit" class="${canSubmit ? "cnpy-accentbtn" : ""}" style="${primarySt(canSubmit)}"${canSubmit ? "" : ' aria-disabled="true"'}>${c.submitting ? "Uploading…" : "Upload artifact"}</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ── 6 · not found ────────────────────────────────────────────────────────────

function notFoundView(p: ArtProps): string {
  return `<div data-screen-label="Artifact not found" style="display:flex;justify-content:center;padding:80px 24px">
    <div${surface("width:420px;max-width:100%;padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center")}>
      <div style="width:52px;height:52px;border-radius:14px;background:var(--hover);display:grid;place-items:center;color:var(--fg-55)">${svg(22, 1.7, `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="m9.5 12.5 5 5M14.5 12.5l-5 5"></path>`)}</div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">This artifact isn't available.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55;text-wrap:pretty">It doesn't exist, or it's private to its author. If someone sent you this link, ask them to publish it to the org.</div>
      </div>
      <div style="font-family:var(--sans);font-size:12px;color:var(--fg-55);padding:7px 12px;border:1px solid var(--border);border-radius:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.host)}/#artifacts/${esc(p.route.slug ?? "")}</div>
      <button data-act="goArtifacts" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Back to Artifacts</button>
    </div>
  </div>`;
}

// ── dialogs (ratify, attach) ─────────────────────────────────────────────────

export function artifactsDialogs(p: ArtProps): string {
  if (p.screen !== "artifact" || p.route.diff || !(p.ui.ratifyOpen || p.ui.attachOpen || p.ui.nv || p.ui.deleteArm)) return "";
  const d = routeDetail(p)?.data;
  if (!d) return "";
  // The delete confirmation (author / admin only — the server re-checks).
  if (p.ui.deleteArm) {
    return canDeleteArtifact(d, p.me, p.admin) ? confirmModal({
      id: "art-delete-confirm", title: `Delete “${d.title}”?`,
      body: `It leaves the library, search, tickets and agents. ${deleteKeeps(d.current_version)} and you can undo.`,
      confirmAct: "artDelete", cancelAct: "artDeleteCancel", busy: p.ui.deleteBusy,
    }) : "";
  }
  const vno = d.version.version_no;
  const shell = (w: number, inner: string, label: string) => `<div data-act="artCloseDialogs" style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);animation:cnpy-fade .14s ease"></div>
    <div style="position:fixed;inset:0;z-index:61;display:grid;place-items:center;padding:16px;pointer-events:none">
      <div role="dialog" aria-modal="true" aria-label="${label}"${surface(`pointer-events:auto;width:min(${w}px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;border:1px solid var(--border-strong);box-shadow:0 20px 60px rgba(0,0,0,.45);animation:cnpy-pop .2s ease both`)}>${inner}</div>
    </div>`;

  if (p.ui.nv) return shell(820, newVersionDialog(p, d, p.ui.nv), "New version");

  if (p.ui.ratifyOpen) {
    const me = who(p, p.me);
    return shell(460, `<div style="padding:24px 26px">
      <div style="${EYEBROW};margin-bottom:10px">Ratify · v${vno}</div>
      <div style="font-size:17px;font-weight:600;letter-spacing:-0.01em">Ratify “${esc(d.title)}”?</div>
      <div style="font-size:13.5px;color:var(--fg-70);margin-top:8px;line-height:1.55">Ratifying marks v${vno} as the version the team agreed on. Agents reading this artifact are told it's ratified. A newer upload starts as published again and needs its own ratification.</div>
      <div style="display:flex;align-items:center;gap:9px;margin-top:16px;padding:10px 12px;border:1px solid var(--border);border-radius:9px;font-size:12.5px;color:var(--fg-55)">
        ${av(me, 20)}<span>Recorded as <span style="font-family:var(--sans);font-size:12px;font-weight:500;color:var(--p-${me.color})">@${esc(me.handle)}</span>, just now</span>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
        <button data-act="artCloseDialogs" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
        <button data-act="artRatifyConfirm" class="${p.ui.busy ? "" : "cnpy-accentbtn"}" style="${ACCENT_BTN}${p.ui.busy ? ";opacity:.6;cursor:default" : ""}">${p.ui.busy ? "Ratifying…" : `Ratify v${vno}`}</button>
      </div>
    </div>`, "Ratify");
  }

  const q = p.ui.attachQ.trim().toLowerCase().replace(/^#/, "");
  const linked = new Set(d.links.filter((l) => l.target_type === "ticket").map((l) => l.target_ref));
  const all = p.ui.attachTickets.data ?? p.tickets;
  const rows = all.filter((t) => !q || String(t.id) === q || t.title.toLowerCase().includes(q));
  const pick = p.ui.attachPick;
  const loading = !p.ui.attachTickets.data && p.ui.attachTickets.status !== "error" && p.tickets.length === 0;
  return shell(540, `<div style="padding:22px 24px 14px">
      <div style="font-size:17px;font-weight:600;letter-spacing:-0.01em">Attach to a ticket</div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px">${esc(d.title)} · v${vno}</div>
      <div class="cnpy-search" style="margin-top:14px;padding:8px 11px;border-color:var(--border-strong)">
        ${I.search()}
        <input data-act="artAttachQ" data-field="artAttachQ" class="cnpy-search-in" value="${attr(p.ui.attachQ)}" placeholder="Search tickets by title or #number" autocomplete="off">
      </div>
    </div>
    <div class="cnpy-scroll" style="flex:1;min-height:0;overflow-y:auto;padding:0 24px;display:flex;flex-direction:column;gap:6px;max-height:320px">
      ${rows.map((t) => {
        const attached = linked.has(String(t.id));
        const on = pick === t.id;
        const [pl, ps] = TSTATUS[t.status] ?? [t.status.toUpperCase(), NEUTRAL];
        return `<button data-act="artAttachPick" data-arg="${t.id}" style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:7px;font-size:13px;font-weight:500;text-align:left;width:100%;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : attached ? "var(--fg-40)" : "var(--fg-70)"};background:${on ? "var(--accent-soft)" : "transparent"};cursor:${attached ? "default" : "pointer"};flex:none">
          <span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--fg-55);min-width:28px;flex:none">#${t.id}</span>
          <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</span>
          ${attached ? `<span style="font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);flex:none">ATTACHED</span>` : ""}
          <span style="${ps}">${esc(pl)}</span>
        </button>`;
      }).join("")}
      ${rows.length ? "" : loading
        ? `<div style="text-align:center;padding:30px;color:var(--fg-40);font-size:13px">Loading tickets&hellip;</div>`
        : `<div style="text-align:center;padding:30px;color:var(--fg-40);font-size:13px">${q ? `No tickets match “${esc(p.ui.attachQ)}”.` : "No tickets yet."}</div>`}
    </div>
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px 20px;border-top:1px solid var(--border);margin-top:14px">
      <button data-act="artCloseDialogs" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
      <button data-act="artAttachConfirm" class="${pick && !p.ui.busy ? "cnpy-accentbtn" : ""}" style="${primarySt(pick !== null && !p.ui.busy)}">${pick ? `Attach to #${pick}` : "Attach"}</button>
    </div>`, "Attach to a ticket");
}

/** The New version dialog's body: Edit (the shown version's text, text kinds only) or Upload file,
 *  a summary, the same size / claude.ai / flatten checks as the create form, and what saving does. */
function newVersionDialog(p: ArtProps, d: ArtifactDetailDTO, nv: ArtNewVersion): string {
  const binary = isBinaryKind(d.kind);
  const latestNo = d.current_version;
  const next = latestNo + 1;
  const text = nvText(nv);
  const bytes = nvBytes(nv);
  const ok = canSubmitNv(nv, d.kind, latestNo);
  const ext = isTextKind(d.kind) ? `.${ARTIFACT_TEXT_EXT[d.kind]}` : d.kind === "pdf" ? ".pdf" : d.kind === "image" ? "png, jpeg, gif or webp" : "any file";
  // Edit is text-only: on a binary page it is shown but locked.
  const tabs = segmented({
    id: "art-nv-source", ariaLabel: "New version source", act: "artNvTab", value: nv.tab, size: "sm",
    options: ([["edit", `Edit v${nv.base}`], ["file", "Upload file"]] as const).map(([k, l]) => {
      const off = binary && k === "edit";
      return { value: k, label: l, ...(off ? { locked: true, title: `A ${d.kind} artifact is replaced by uploading a file` } : {}) };
    }),
  });

  const source = nv.tab === "edit"
    ? `<textarea data-act="artNvText" data-field="artNvText" class="cnpy-input cnpy-scroll" spellcheck="false" aria-label="Content" style="width:100%;height:min(46vh,440px);resize:vertical;padding:12px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-family:var(--code);font-size:12px;line-height:1.6;outline:none;white-space:pre">${esc(nv.text)}</textarea>
      ${nv.base !== latestNo ? `<div style="font-size:12px;color:var(--fg-55);margin-top:7px">Starting from v${nv.base}, an older version. Saving it makes this text the latest again.</div>` : ""}`
    : !nv.file
      ? `<div data-art-drop="nv" style="border:1px dashed var(--border-strong);border-radius:11px;padding:48px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
          ${I.upload()}
          <div style="font-size:14px;font-weight:600;color:var(--fg-70)">Drop the replacement here</div>
          <div style="font-size:12.5px;color:var(--fg-40)">A ${d.kind} artifact · ${esc(ext)} up to ${capLabel(d.kind)}</div>
          <label class="cnpy-outlinebtn" style="margin-top:12px;${OUTLINE_BTN};padding:6px 14px;cursor:pointer">Choose file<input type="file" data-art-file="nv" style="display:none"></label>
        </div>
        ${nv.fileErr ? `<div style="font-size:12px;color:var(--red);margin-top:7px">${esc(nv.fileErr)}</div>` : ""}`
      : `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:10px">
          <span style="width:30px;height:30px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);flex:none">${binary ? I.kind(d.kind, 14) : I.file()}</span>
          <span style="flex:1;min-width:0"><span style="display:block;font-family:var(--label);font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nv.file.name)}</span><span style="display:block;font-size:11.5px;color:var(--fg-40);margin-top:1px">${fmtKB(nv.file.size)} · replaces v${latestNo}</span></span>
          <button data-act="artNvRemoveFile" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-40)">Remove</button>
        </div>`;

  const after = d.status === "ratified" ? `The page becomes published, and v${next} needs ratifying again.` : d.status === "draft" ? "The page becomes published." : "The page stays published.";
  return `<div style="padding:22px 24px 0">
      <div style="${EYEBROW};margin-bottom:8px">New version · v${next}</div>
      <div style="font-size:17px;font-weight:600;letter-spacing:-0.01em">${esc(d.title)}</div>
    </div>
    <div class="cnpy-scroll" data-scroll-keep="artNv" style="flex:1;min-height:0;overflow-y:auto;padding:16px 24px 4px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
        <label style="font-size:13px;font-weight:500">Content</label>
        ${tabs}
      </div>
      ${source}
      ${contentChecks(text, bytes, d.kind)}
      <label style="display:block;font-size:13px;font-weight:500;margin:18px 0 8px">What changed <span style="font-weight:400;color:var(--fg-40)">(optional)</span></label>
      <input data-act="artNvSummary" data-field="artNvSummary" class="cnpy-input" value="${attr(nv.summary)}" maxlength="${ARTIFACT_SUMMARY_MAX}" placeholder="Flattened the export so it renders in Trov" style="width:100%;height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;outline:none">
    </div>
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px 20px;border-top:1px solid var(--border);margin-top:16px;flex-wrap:wrap">
      <span style="flex:1;min-width:200px;font-size:12px;color:var(--fg-40)">Saves as v${next}. ${after}</span>
      <button data-act="artCloseDialogs" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
      <button data-act="artNvSubmit" class="${ok ? "cnpy-accentbtn" : ""}" style="${primarySt(ok)}">${nv.submitting ? "Saving…" : `Save v${next}`}</button>
    </div>`;
}

// ── the ticket detail's Artifacts block ──────────────────────────────────────

/** The ticket detail's Artifacts section (the prototype's ticket screen): every
 *  artifact the viewer can see that links this ticket. */
export function ticketArtifactsBlock(slice: ArtSlice<ArtifactSummaryDTO[]> | undefined): string {
  const arts = slice?.data ?? [];
  const head = `<div data-screen-label="Attached artifacts" style="display:flex;align-items:baseline;gap:10px;margin-top:26px">
      <div style="${EYEBROW};flex:none">Artifacts</div>
      <span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">${slice?.data ? arts.length : "–"}</span>
    </div>`;
  if (!slice?.data) {
    const msg = slice?.status === "error" ? "Couldn't load the artifacts attached here." : "Loading artifacts&hellip;";
    return `${head}<div style="font-size:12px;color:var(--fg-40);margin-top:10px">${msg}</div>`;
  }
  if (!arts.length) {
    return `${head}<div style="font-size:12px;color:var(--fg-40);margin-top:10px">No artifacts attached. Attach one from its page in <button data-act="goArtifacts" class="cnpy-link" style="font-size:12px;color:var(--accent);padding:0">Artifacts</button>.</div>`;
  }
  return `${head}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${arts.map((a) => {
    const [sl, ss] = STATUS[a.status];
    return `<button data-act="artOpen" data-arg="${attr(a.slug)}" class="cnpy-card" style="display:inline-flex;align-items:center;gap:9px;padding:7px 13px 7px 10px;border:1px solid var(--border);border-radius:9px;text-align:left;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
      <span style="flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-70);background:color-mix(in srgb,var(--fg) 6%,transparent)">${I.kind(a.kind)}</span>
      <span style="min-width:0"><span style="display:block;font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px">${esc(a.title)}</span><span style="display:block;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px;white-space:nowrap">${a.kind.toUpperCase()} · V${a.current_version} · @${esc(a.author_id.toUpperCase())}</span></span>
      <span style="${ss}">${sl}</span>
    </button>`;
  }).join("")}</div>`;
}

// ── the reducer ──────────────────────────────────────────────────────────────

/** A write main.ts performs against /api/artifacts, then refreshes what it touched. */
export type ArtWrite =
  | { op: "patch"; slug: string; body: { status?: "draft" | "published"; visibility?: ArtifactVisibility }; flash: string; flashMs?: number }
  | { op: "ratify"; slug: string; version: number; flash: string }
  | { op: "link"; slug: string; target_type: ArtifactLinkType; target_ref: string; flash: string }
  | { op: "create"; fields: { title: string; kind: ArtifactKind; area: string; repo: string; visibility: ArtifactVisibility; summary: string }; content: string | null; file: Blob | null; filename: string | null; links: { target_type: ArtifactLinkType; target_ref: string }[] }
  | { op: "version"; slug: string; body: { content: string; summary: string } | { file: Blob; filename: string; summary: string } }
  | { op: "fetchUrl"; url: string }
  | { op: "delete"; slug: string }
  | { op: "restore"; slug: string };

export type ArtEffect =
  | { nav: { screen: ArtScreen; route: ArtRoute } }
  | { flash: string }
  | { write: ArtWrite }
  | { openUrl: string }
  | { download: { url: string; name: string } }
  | { copy: { text: string; flash: string } }
  | { retry: true }
  /** Rerender, then move focus to this selector (the delete confirm's Cancel / its trigger). */
  | { focus: string }
  | null;

/**
 * Apply one `art*` act to the UI state. Returns what main.ts must do beyond a
 * rerender (navigate, write, toast, download…). Mutates `ui` in place, like every
 * other dispatch case.
 */
const RAW_OFF_FLASH = "Raw artifact pages only open for people in exactly one organization for now.";
export function artifactsAct(
  ui: ArtUi,
  ctx: { screen: ArtScreen | null; route: ArtRoute; me: string; admin?: boolean; host: string; sprints?: ArtSprintRef[] },
  act: string, arg: string | null, value: string | null,
): ArtEffect {
  const d = ctx.screen === "artifact" ? routeDetail({ route: ctx.route, ui })?.data ?? null : null;
  const closeMenus = () => { ui.verMenu = false; ui.dotMenu = false; };

  switch (act) {
    // navigation
    case "artNew": return { nav: { screen: "artifactnew", route: ART_ROUTE_NONE } };
    case "artOpen": {
      const sv = parseSlugVersion(arg ?? "");
      if (!sv) return null;
      closeMenus();
      return { nav: { screen: "artifact", route: { slug: sv.slug, v: sv.version, diff: null } } };
    }
    case "artDiff": {
      const m = /^(.+):(\d+)\.\.(\d+)$/.exec(arg ?? "");
      if (!m) return null;
      closeMenus();
      return { nav: { screen: "artifact", route: { slug: m[1], v: null, diff: { a: Number(m[2]), b: Number(m[3]) } } } };
    }
    case "artDiffA":
    case "artDiffB": {
      const pair = ctx.route.diff;
      const n = Number(value);
      if (!arg || !pair || !Number.isInteger(n) || n < 1) return null;
      return { nav: { screen: "artifact", route: { slug: arg, v: null, diff: act === "artDiffA" ? { a: n, b: pair.b } : { a: pair.a, b: n } } } };
    }
    case "artRetry": return { retry: true };

    // library
    case "artQ": ui.q = value ?? ""; return null;
    case "artClearQ": ui.q = ""; return null;
    // Opening / closing the filter menu and switching its category are main.ts's
    // filter-menu registry (they animate in place, without a rerender).
    case "artFilterPick": {
      const i = (arg ?? "").indexOf(":");
      const k = (arg ?? "").slice(0, i) as ArtFilterKey;
      if (i < 0 || !ART_FILTER_KEYS.includes(k)) return null;
      ui.f = { ...ui.f, [k]: (arg ?? "").slice(i + 1) };
      return null;
    }
    case "artFilterClear": ui.q = ""; ui.f = { ...NO_FILTERS }; return null;

    // viewer
    case "artVerMenu": ui.verMenu = !ui.verMenu; ui.dotMenu = false; return null;
    case "artDotMenu": ui.dotMenu = !ui.dotMenu; ui.verMenu = false; return null;
    case "artCloseMenus": closeMenus(); return null;
    // Delete (author / admin only — the server re-checks): the in-app confirm, then the write.
    case "artDeleteArm":
      if (!d || !canDeleteArtifact(d, ctx.me, ctx.admin === true)) return null;
      closeMenus();
      ui.deleteArm = true;
      return { focus: "[data-confirm-focus]" };
    case "artDeleteCancel": {
      if (ui.deleteBusy) return null;
      const was = ui.deleteArm;
      ui.deleteArm = false;
      return was ? { focus: "[data-confirm-trigger]" } : null;
    }
    case "artDelete":
      if (!d || !ui.deleteArm || ui.deleteBusy || !canDeleteArtifact(d, ctx.me, ctx.admin === true)) return null;
      ui.deleteBusy = true;
      return { write: { op: "delete", slug: d.slug } };
    // The toast's Undo — works from any screen (the toast outlives the viewer).
    case "artRestore":
      if (!arg) return null;
      return { write: { op: "restore", slug: arg } };
    case "artCloseDialogs":
      ui.ratifyOpen = false; ui.attachOpen = false;
      if (!ui.nv?.submitting) ui.nv = null;
      return null;
    case "artVis": {
      if (!d || ui.busy) return null;
      if (d.visibility === "private") return { write: { op: "patch", slug: d.slug, body: { visibility: "org" }, flash: "Published to the org" } };
      if (!sameHandle(d.author_id, ctx.me)) return null;
      return { write: { op: "patch", slug: d.slug, body: { visibility: "private" }, flash: PRIVATE_NOTE, flashMs: 3000 } };
    }
    case "artStatus": {
      if (!d || ui.busy) return null;
      const k = arg as ArtifactStatus;
      if (k === d.status || !(ARTIFACT_STATUSES as readonly string[]).includes(k)) return null;
      if (k === "ratified") {
        if (canRatify(d.status, d.version.version_no, d.current_version)) ui.ratifyOpen = true;
        return null;
      }
      return { write: { op: "patch", slug: d.slug, body: { status: k }, flash: k === "draft" ? "Moved back to draft" : "Published" } };
    }
    case "artRatifyConfirm":
      if (!d || ui.busy || !canRatify(d.status, d.version.version_no, d.current_version)) return null;
      return { write: { op: "ratify", slug: d.slug, version: d.version.version_no, flash: `Ratified v${d.version.version_no}` } };
    case "artAttachOpen": ui.attachOpen = true; ui.attachQ = ""; ui.attachPick = null; return null;
    case "artAttachQ": ui.attachQ = value ?? ""; return null;
    case "artAttachPick": {
      const id = Number(arg);
      if (!d || !Number.isInteger(id) || d.links.some((l) => l.target_type === "ticket" && l.target_ref === String(id))) return null;
      ui.attachPick = id;
      return null;
    }
    case "artAttachConfirm": {
      if (!d || ui.attachPick === null || ui.busy) return null;
      const id = ui.attachPick;
      return { write: { op: "link", slug: d.slug, target_type: "ticket", target_ref: String(id), flash: `Attached to ticket #${id}` } };
    }
    case "artCopyLink":
      if (!d) return null;
      closeMenus();
      return { copy: { text: `${ctx.host.includes("://") ? ctx.host : `https://${ctx.host}`}/#artifacts/${d.slug}`, flash: d.visibility === "private" ? "Link copied. Teammates can't open it until you publish." : "Link copied" } };
    case "artDownload":
      if (!d) return null;
      closeMenus();
      if (!rawAvailable) return { flash: RAW_OFF_FLASH };
      return { download: { url: withDownload(d.raw_url || rawUrl(d.slug, d.version.version_no)), name: artFileName(d.slug, d.kind, d.version) } };
    case "artOpenTab":
      if (!d) return null;
      closeMenus();
      if (!rawAvailable) return { flash: RAW_OFF_FLASH };
      return { openUrl: d.raw_url || rawUrl(d.slug, d.version.version_no) };

    // new version (the viewer's dialog)
    case "artNvOpen": {
      if (!d) return null;
      closeMenus();
      const text = isTextKind(d.kind) ? d.content ?? "" : "";
      ui.nv = {
        tab: isBinaryKind(d.kind) ? "file" : "edit", base: d.version.version_no, original: text, text,
        file: null, fileErr: null, summary: "", submitting: false,
      };
      return null;
    }
    case "artNvTab":
      if (!ui.nv || !d || (arg !== "edit" && arg !== "file") || (arg === "edit" && isBinaryKind(d.kind))) return null;
      ui.nv.tab = arg;
      return null;
    case "artNvText": if (ui.nv) ui.nv.text = value ?? ""; return null;
    case "artNvSummary": if (ui.nv) ui.nv.summary = value ?? ""; return null;
    case "artNvRemoveFile": if (ui.nv) { ui.nv.file = null; ui.nv.fileErr = null; } return null;
    case "artNvSubmit": {
      const nv = ui.nv;
      if (!d || !nv || !canSubmitNv(nv, d.kind, d.current_version)) return null;
      const summary = nv.summary.trim().slice(0, ARTIFACT_SUMMARY_MAX);
      const body = isBinaryKind(d.kind)
        ? { file: nv.file!.blob!, filename: nv.file!.name, summary }
        : { content: nvText(nv), summary };
      nv.submitting = true;
      return { write: { op: "version", slug: d.slug, body } };
    }

    // create
    case "artCTitle": ui.c.title = value ?? ""; return null;
    case "artCKind": {
      if (!(ARTIFACT_KINDS as readonly string[]).includes(arg ?? "")) return null;
      const k = arg as ArtifactKind;
      // A file keeps its bytes only while the kind stays on the same side (text / binary).
      if (ui.c.file && isBinaryKind(k) !== isBinaryKind(ui.c.kind)) ui.c.file = null;
      ui.c.kind = k;
      if (isBinaryKind(k)) ui.c.tab = "file";
      return null;
    }
    case "artCArea": if ((ARTIFACT_AREAS as readonly string[]).includes(arg ?? "")) ui.c.area = arg as string; return null;
    case "artCRepo": if (value) ui.c.repo = value; return null;
    case "artCVis": if (arg === "org" || arg === "private") ui.c.vis = arg; return null;
    case "artCTab":
      if (arg !== "paste" && arg !== "file" && arg !== "url") return null;
      if (arg !== "file" && isBinaryKind(ui.c.kind)) return null; // paste and URL are text-only
      ui.c.tab = arg;
      return null;
    case "artCPaste": ui.c.paste = value ?? ""; return null;
    case "artCUrl": ui.c.url = value ?? ""; ui.c.urlFetched = null; ui.c.urlErr = null; return null;
    case "artCFetch": {
      const url = ui.c.url.trim();
      if (!url || ui.c.fetching) return null;
      ui.c.fetching = true;
      ui.c.urlErr = null;
      return { write: { op: "fetchUrl", url } };
    }
    case "artCRemoveFile": ui.c.file = null; return null;
    case "artCLinkDraft": ui.c.linkDraft = value ?? ""; ui.c.linkErr = false; return null;
    case "artCLinkAdd": {
      const l = parseArtLink(ui.c.linkDraft, ctx.sprints ?? []);
      if (!l) { if (ui.c.linkDraft.trim()) ui.c.linkErr = true; return null; }
      if (!ui.c.links.some((x) => x.target_type === l.target_type && x.target_ref === l.target_ref)) ui.c.links = [...ui.c.links, l];
      ui.c.linkDraft = "";
      return null;
    }
    case "artCLinkRemove": {
      const i = Number(arg);
      ui.c.links = ui.c.links.filter((_, j) => j !== i);
      return null;
    }
    case "artCSubmit": {
      const c = ui.c;
      if (!canSubmitCreate(c)) return null;
      const binary = isBinaryKind(c.kind);
      c.submitting = true;
      return {
        write: {
          op: "create",
          fields: { title: c.title.trim(), kind: c.kind, area: c.area, repo: c.repo, visibility: c.vis, summary: "Uploaded from Trov" },
          content: binary ? null : createText(c),
          file: binary ? c.file?.blob ?? null : null,
          filename: binary ? c.file?.name ?? null : null,
          links: c.links.map((l) => ({ target_type: l.target_type, target_ref: l.target_ref })),
        },
      };
    }
    default:
      return null;
  }
}

/** A picked/dropped file → the create form: the kind follows the file's extension
 *  (kindForFilename), the title its name when the title is still empty. */
export function artAcceptFile(ui: ArtUi, file: ArtFile): void {
  ui.c.file = file;
  ui.c.tab = "file";
  ui.c.kind = kindForFilename(file.name);
  if (!ui.c.title) ui.c.title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

/** A picked/dropped file → the New version dialog. The page's kind is fixed, so the file must sit on
 *  the same side of it: text (read as text) for a text page, the bytes for a binary one. */
export function artAcceptNvFile(ui: ArtUi, kind: ArtifactKind, file: ArtFile): void {
  if (!ui.nv) return;
  const fits = isBinaryKind(kind) ? !!file.blob : file.text !== null;
  ui.nv.tab = "file";
  ui.nv.file = fits ? file : null;
  ui.nv.fileErr = fits ? null
    : isTextKind(kind) ? `A ${kind} artifact is replaced by a .${ARTIFACT_TEXT_EXT[kind]} file, not ${file.name}.`
      : `A ${kind} artifact is replaced by a ${kind} file, not ${file.name}.`;
}
