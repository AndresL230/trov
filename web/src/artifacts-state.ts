// Artifacts' eager part (web-ui.md › The app's bundles): the screens' STATE and routes, a framed page's
// measured height, the Mermaid post-paint pass (main.ts calls it after every paint) and the ticket
// page's Artifacts block. Everything else — the library, the viewer, the diff, the form, the dialogs
// and the reducer — is artifacts.ts, the lazy Artifacts chunk (artifacts-lazy.ts), which re-exports
// all of this unchanged.

import { esc, attr } from "./ui";
import { skeleton, skLine } from "./skeleton";
import { artifactStatusMark } from "./marks";
import type { PersonColor } from "@shared/rows";
import type {
  ArtifactKind, ArtifactVisibility, ArtifactLinkType,
  ArtifactSummaryDTO, ArtifactDetailDTO, ArtifactDiffDTO,
} from "@shared/artifacts-core";

// ── state ────────────────────────────────────────────────────────────────────

/** One loadable read. `missing` = the API's 404 (absent, or private to someone else). */
export interface ArtSlice<T> { status: "idle" | "loading" | "ok" | "error" | "missing"; data: T | null; error?: string }
export const IDLE = <T>(): ArtSlice<T> => ({ status: "idle", data: null });

export type ArtFilterKey = "area" | "kind" | "author" | "status" | "sprint";
export const ART_FILTER_KEYS: readonly ArtFilterKey[] = ["area", "kind", "author", "status", "sprint"];
export type ArtFilters = Record<ArtFilterKey, string>;
export const NO_FILTERS: ArtFilters = { area: "all", kind: "all", author: "all", status: "all", sprint: "all" };

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


// ── the kind icons and the eyebrow (the design's) ────────────────────────────

export const KIND_ICON: Record<ArtifactKind, string> = {
  html: "M8 7 3 12l5 5M16 7l5 5-5 5",
  markdown: "M6 3h7l5 5v13H6zM13 3v5h5M9 13h6M9 17h6",
  svg: "M12 3 21 12 12 21 3 12z",
  mermaid: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h4.5a2.5 2.5 0 0 1 2.5 2.5V14",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  pdf: "M6 3h7l5 5v13H6zM13 3v5h5M9 18v-5h2a1.5 1.5 0 0 1 0 3H9",
  file: "M6 3h7l5 5v13H6zM13 3v5h5",
};
const kindIcon = (k: ArtifactKind, w = 13): string => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${KIND_ICON[k] ?? KIND_ICON.file}"></path></svg>`;
export const EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";

// ── a framed page's height, and Mermaid (the viewer reads both) ──────────────

/** Measured heights of framed HTML artifacts (key `slug@v`): the rerender rebuilds
 *  the iframe, so the box is sized from here before the new frame reports in. */
const frameHeights = new Map<string, number>();
const FRAME_DEFAULT = 640;
/** The height a framed page's box takes before its frame reports in: the last one measured, or the default. */
export const frameHeight = (key: string): number => frameHeights.get(key) ?? FRAME_DEFAULT;
/** Record a frame's reported document height; returns the height the box should take. */
export function setArtFrameHeight(key: string, h: number): number {
  const v = Math.round(Math.max(160, Math.min(h, 40000)));
  frameHeights.set(key, v);
  return v;
}

// Mermaid: rendered post-paint (renderPendingMermaid, called by main.ts after each
// paint) into a module cache keyed `slug@v|theme`, so a rerender inlines the SVG
// at once and only a miss shows "Rendering diagram…". The library is the `mermaid`
// dependency (an EXACT version in package.json), loaded by a dynamic import(): Vite
// makes it its own chunks, served from Trov's origin, fetched the first time a
// diagram is opened and never part of the main bundle. No CDN is contacted.
export const mermaidSvgs = new Map<string, string>();
export const mermaidFailed = new Set<string>();
export const mermaidPending = new Map<string, string>();
const mermaidInflight = new Set<string>();
interface MermaidApi {
  initialize(c: Record<string, unknown>): void;
  render(id: string, src: string): Promise<{ svg: string }>;
}
let mermaidLib: Promise<MermaidApi> | null = null;
let mermaidSeq = 0;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLib) {
    mermaidLib = import("mermaid").then((m) => m.default as unknown as MermaidApi);
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

// ── the ticket detail's Artifacts block ──────────────────────────────────────

/** The ticket detail's Artifacts section (the prototype's ticket screen): every
 *  artifact the viewer can see that links this ticket. */
export function ticketArtifactsBlock(slice: ArtSlice<ArtifactSummaryDTO[]> | undefined): string {
  const arts = slice?.data ?? [];
  const head = `<div data-screen-label="Attached artifacts" style="display:flex;align-items:baseline;gap:10px;margin-top:26px">
      <div style="${EYEBROW};flex:none">Artifacts</div>
      <span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">${slice?.data ? arts.length : "–"}</span>
    </div>`;
  if (!slice?.data && slice?.status !== "error") {
    return `${head}${skeleton("ticket-artifacts", "Loading artifacts&hellip;", skLine(220, 12, 1.5), "margin-top:10px")}`;
  }
  if (!slice?.data) {
    return `${head}<div style="font-size:12px;color:var(--fg-40);margin-top:10px">Couldn't load the artifacts attached here.</div>`;
  }
  if (!arts.length) {
    return `${head}<div style="font-size:12px;color:var(--fg-40);margin-top:10px">No artifacts attached. Attach one from its page in <button data-act="goArtifacts" class="cnpy-link" style="font-size:12px;color:var(--accent);padding:0">Artifacts</button>.</div>`;
  }
  return `${head}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${arts.map((a) => {
    return `<button data-act="artOpen" data-arg="${attr(a.slug)}" class="cnpy-card" style="display:inline-flex;align-items:center;gap:9px;padding:7px 13px 7px 10px;border:1px solid var(--border);border-radius:9px;text-align:left;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
      <span style="flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-70);background:color-mix(in srgb,var(--fg) 6%,transparent)">${kindIcon(a.kind)}</span>
      <span style="min-width:0"><span style="display:block;font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px">${esc(a.title)}</span><span style="display:block;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px;white-space:nowrap">${a.kind.toUpperCase()} · V${a.current_version} · @${esc(a.author_id.toUpperCase())}</span></span>
      ${artifactStatusMark(a.status)}
    </button>`;
  }).join("")}</div>`;
}

