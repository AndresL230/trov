// The Docs Library's Markdown import — the controller (docs/architecture/docs-library.md › The import screens): every
// `imp…` act main.ts dispatches, the reading of the files the person picks or drops (a .zip is unpacked HERE, in the
// browser — web/src/zip-reader.ts; the Worker never unzips), the run itself and Imports history's read. The views are
// web/src/import.ts (pure).
//
// The run is NOT tied to the screen: it lives in this module (`job`), so the person can go anywhere while it runs —
// `state.imp.run` is what every screen reads (the sidebar's badge, the wizard's progress card, Imports history's
// current file). Its order is the contract's: POST /imports (the manifest and the conflict choices, fixed for the run)
// → every image a page uses (POST /imports/:id/images, before the pages that use it) → the pages in the server plan's
// order, parents first, in batches of IMPORT_PAGES_PER_BATCH (POST /imports/:id/pages) → POST /imports/:id/finish. A
// batch that does not get through (the network, a 5xx) stalls the run with Retry, which resends that SAME batch: the
// server replays it, so nothing is staged twice.
import type { AppState } from "./render";
import {
  ApiError, OrgApiError, Unauthorized, PreviewBlocked, rateLimitText,
  listImports, startImport, uploadImportImage, sendImportPages, finishImport,
} from "./api";
import type { ToastAction } from "./app-root";
import {
  importKind, imageTypeFor, normalizeImportPath, titleFromMarkdown, planImport, prepareBody, imagePathsUsed,
  MAX_MD_BYTES, IMPORT_PAGES_PER_BATCH, IMPORT_FILE_NAME_MAX,
  type ImportFile, type ImportFileKind, type ImportStartBody, type ImportWrite, type ImportRunView, type ConflictChoice,
} from "@shared/docs-import-core";
import { openZip, ZipError, ZIP_DAMAGED_MESSAGE, utf8Text } from "./zip-reader";
import {
  initialImportUi, importPlanFor, importPlanOptions, importChoices, importSourceName, driverActive, PLAN_ERROR_TEXT,
  type ImportPick, type ImportDriverView, type ImportLinks, type ImportStep, type ImportsFilter,
} from "./import";

export interface ImportHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  rerenderSoon(): void;
  flash(msg: string, ms?: number, action?: ToastAction | null): void;
  unauth(e: unknown): void;
  /** Read a space's pages into `spaceHome` unless it already holds them (the tree picker and the plan). */
  ensureSpace(slug: string): void;
  /** A run ended (or was cancelled): read again what it changed — Review, the Library, the space, the badges. */
  landed(space: string): void;
  /** The name of a space (the Library's, else the slug). */
  spaceName(slug: string): string;
}

export interface ImportController {
  act(act: string, arg: string | null, value: string | null): boolean;
  /** Open the wizard (`goImport`): at its first step with `space` picked (a fresh wizard), or — while a run is
   *  going — on its progress. */
  open(space: string | null): void;
  /** The screen was reached by its address (a reload, Back): keep what is picked, read what it needs. */
  enter(space: string | null): void;
  /** Imports history's read (and its polling while a run is in progress and the screen is open). */
  loadHistory(): void;
  /** Files picked with the file input or dropped on the Files step. */
  addFiles(files: readonly File[]): void;
  /** Files dropped on a space page or a sidebar space row: the wizard on that space, straight to Preview. */
  dropTo(files: readonly File[], space: string): void;
}

/** A file of a pick, read: what the planner needs, the Markdown text, and how to get an image's bytes. */
interface FileRec {
  path: string;
  size: number;
  kind: ImportFileKind;
  /** Markdown: the text (null = not readable as UTF-8; absent = not read: empty or too large, the planner skips it). */
  text?: string | null;
  title?: string | null;
  blob?: () => Promise<Blob>;
}

/** The run this tab drives. */
interface Job {
  id: number;
  space: string;
  batches: { path: string; text: string }[][];
  images: { path: string; blob: (() => Promise<Blob>) | null }[];
  img: number;
  batch: number;
  cancel: boolean;
  driving: boolean;
}

const ZIP_RE = /\.zip$/i;
const BAD_FILE = "Not a Markdown file. Use .md files, or a .zip of them.";
const ZIP_WORDS: Record<string, string> = {
  too_many_files: "This zip has more than 500 files. Up to 500 files or 50 MB can be imported at once.",
  too_large: "This zip is over 50 MB unpacked. Up to 500 files or 50 MB can be imported at once.",
};
const POLL_MS = 4000;

/** Is this failure worth a Retry (the network, the Worker) rather than a refusal? */
const transient = (e: unknown): boolean => !(e instanceof ApiError) ? !(e instanceof PreviewBlocked) : e.status >= 500 || e.status === 429;

/** A refusal of an import route, in words. */
export function importErrorText(e: unknown, fallback: string): string {
  if (e instanceof PreviewBlocked) return "This is a preview: nothing is changed. Close the preview to import files.";
  const limited = rateLimitText(e);
  if (limited) return limited;
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  const detail = e instanceof OrgApiError ? e.detail : null;
  switch (e.message) {
    case "import_running": return "Another import is running in this organization. Wait for it to finish (it's in Imports), then try again.";
    case "too_many_files": return PLAN_ERROR_TEXT.too_many_files;
    case "too_large": return PLAN_ERROR_TEXT.too_large;
    case "no_markdown": return PLAN_ERROR_TEXT.no_markdown;
    case "not_found": return "That space or page is not there any more. Pick where the pages go again.";
    case "archived": return "That space is archived. Pick another space.";
    case "not_running": return "This import isn't running any more: it was cancelled, or it stopped.";
    case "forbidden": return "You can't do that with this import.";
    default: return detail ? `${detail[0].toUpperCase()}${detail.slice(1)}${/[.!?]$/.test(detail) ? "" : "."}` : `${fallback} Try again.`;
  }
}

export function createImportController(host: ImportHost): ImportController {
  const { state } = host;
  const ui = () => state.imp;
  const rerender = () => host.rerender();
  const fail = (e: unknown): boolean => { if (e instanceof Unauthorized) { host.unauth(e); return true; } return false; };

  // Each pick's files, read. Never in `state` (a file's text is not state the app paints).
  const store = new Map<number, FileRec[]>();
  let nextPick = 1;
  /** Go straight to Preview once every pick is read (a drop-to-import). */
  let autoPreview = false;
  let job: Job | null = null;
  let histSeq = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Closing the tab mid-run stops it (the server calls it abandoned after a while): ask first.
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", (e) => {
      if (job && !job.cancel && driverActive(ui().run)) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  const liveSpace = (slug: string | null): string | null =>
    slug && (state.library.data?.spaces ?? []).some((s) => s.slug === slug) ? slug : null;
  const pagesOf = (slug: string | null) =>
    slug && state.spaceHome.data?.space.slug === slug ? state.spaceHome.data.pages : null;

  /** After the paint: run `fn` (a test or a Worker-side render has no frames). */
  const soon = (fn: () => void): void => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn); };
  function scrollTop(): void {
    soon(() => host.mount.querySelector("#cnpy-main")?.scrollTo(0, 0));
  }

  function goStep(step: ImportStep): void {
    const u = ui();
    if (step !== "where" && !liveSpace(u.space)) return;
    if (step === "preview" && (!u.picks.some((p) => p.state === "ready") || u.picks.some((p) => p.state === "reading"))) return;
    if (step === "run" && !u.run) return;
    u.step = step;
    u.error = null;
    if (u.space) host.ensureSpace(u.space);
    rerender();
    scrollTop();
  }

  // ── reading the files ──────────────────────────────────────────────────────

  /** The manifest the planner reads, and the links and images the files hold, from every pick that is read. */
  function rebuild(): void {
    const u = ui();
    const recs = u.picks.filter((p) => p.state === "ready").flatMap((p) => store.get(p.id) ?? []);
    const files: ImportFile[] = [];
    const unreadable: string[] = [];
    for (const r of recs) {
      if (r.kind === "md" && r.text === null) { unreadable.push(r.path); continue; }
      files.push(r.kind === "md" ? { path: r.path, size: r.size, kind: "md", title: r.title ?? null } : { path: r.path, size: r.size, kind: r.kind });
    }
    u.files = files;
    u.unreadable = unreadable;
    u.links = countLinks(files, recs);
    if (autoPreview && u.picks.length && !u.picks.some((p) => p.state === "reading")) {
      autoPreview = false;
      if (u.picks.every((p) => p.state === "ready") && u.step === "files") { goStep("preview"); return; }
    }
    rerender();
  }

  /** The links and images, counted over the files' text with the plan's own path → slug map. */
  function countLinks(files: ImportFile[], recs: FileRec[]): ImportLinks {
    const plan = planImport(files, { existingTitles: new Map(), existingSlugs: new Set() });
    const text = textMap(recs);
    const ours = new Set(plan.pathToSlug.values());
    const imagePaths = plan.images.map((i) => i.path);
    const fake = new Map(imagePaths.map((p) => [p, "0".repeat(64)] as [string, string]));
    const used = new Set<string>();
    const l: ImportLinks = { total: 0, inImport: 0, existing: 0, unmatched: 0, imagesUsed: 0 };
    for (const pg of plan.pages) {
      if (!pg.path) continue;
      const t = text.get(pg.path);
      if (!t) continue;
      const body = prepareBody(t, { path: pg.path, pathToSlug: plan.pathToSlug, imagePathToSha: fake });
      for (const slug of body.links) { if (ours.has(slug)) l.inImport++; else l.existing++; }
      l.unmatched += body.unmatchedLinks.length;
      for (const p of imagePathsUsed(t, pg.path, imagePaths)) used.add(p);
    }
    l.total = l.inImport + l.existing + l.unmatched;
    l.imagesUsed = used.size;
    return l;
  }

  /** Normalized path → Markdown text, over every file read. */
  function textMap(recs: readonly FileRec[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of recs) {
      if (r.kind !== "md" || typeof r.text !== "string") continue;
      const n = normalizeImportPath(r.path);
      if (n.ok && !m.has(n.path)) m.set(n.path, r.text);
    }
    return m;
  }

  async function readMarkdown(bytes: () => Promise<Uint8Array>, size: number, path: string): Promise<FileRec> {
    if (size === 0 || size > MAX_MD_BYTES) return { path, size, kind: "md", title: null };   // the planner skips it
    const text = utf8Text(await bytes());
    return { path, size, kind: "md", text, title: text === null ? null : titleFromMarkdown(text) };
  }

  async function readPick(pick: ImportPick, file: File): Promise<void> {
    try {
      let recs: FileRec[];
      if (pick.kind === "zip") {
        const z = await openZip(file);
        recs = [];
        for (const entry of z.files) {
          const path = entry.name;
          const kind = importKind(path);
          if (kind === "md") recs.push(await readMarkdown(() => z.read(entry), entry.size, path));
          else if (kind === "image") recs.push({ path, size: entry.size, kind, blob: async () => new Blob([(await z.read(entry)) as Uint8Array<ArrayBuffer>], { type: imageTypeFor(path) ?? "application/octet-stream" }) });
          else recs.push({ path, size: entry.size, kind });
        }
        pick.inside = z.files.length;
      } else {
        recs = [await readMarkdown(async () => new Uint8Array(await file.arrayBuffer()), file.size, file.name)];
      }
      if (!ui().picks.includes(pick)) return;   // removed while it was read
      store.set(pick.id, recs);
      pick.state = "ready";
    } catch (e) {
      if (!ui().picks.includes(pick)) return;
      pick.state = "bad";
      pick.error = e instanceof ZipError ? ZIP_WORDS[e.code] ?? ZIP_DAMAGED_MESSAGE : pick.kind === "zip" ? ZIP_DAMAGED_MESSAGE : "This file couldn't be read.";
    }
    rebuild();
  }

  function addFiles(files: readonly File[]): void {
    const u = ui();
    if (!files.length || driverActive(u.run)) return;
    if (u.run) { u.run = null; }
    const zip = files.find((f) => ZIP_RE.test(f.name));
    let take: File[];
    if (zip) {
      // A zip is imported on its own: it replaces what was picked, and the rest of this drop is left out.
      for (const p of u.picks) store.delete(p.id);
      u.picks = [];
      take = [zip];
      if (files.length > 1) host.flash(`A .zip is imported on its own: only ${zip.name} was added.`, 4200);
    } else {
      // Markdown files join what is there, a picked zip aside; one with the same name replaces the old one.
      const names = new Set(files.map((f) => f.name));
      for (const p of u.picks) if (p.kind === "zip" || names.has(p.name)) store.delete(p.id);
      u.picks = u.picks.filter((p) => p.kind !== "zip" && !names.has(p.name));
      take = [...files];
    }
    for (const f of take) {
      const kind: ImportPick["kind"] = ZIP_RE.test(f.name) ? "zip" : importKind(f.name) === "md" ? "md" : "other";
      const pick: ImportPick = { id: nextPick++, name: f.name, size: f.size, kind, state: kind === "other" ? "bad" : "reading", error: kind === "other" ? BAD_FILE : null, inside: null };
      u.picks.push(pick);
      if (kind !== "other") void readPick(pick, f);
    }
    u.error = null;
    rebuild();
  }

  function removePick(id: number): void {
    const u = ui();
    u.picks = u.picks.filter((p) => p.id !== id);
    store.delete(id);
    rebuild();
  }

  /** A fresh wizard, keeping Imports history's own state and a run that is still going. */
  function reset(space: string | null): void {
    const u = ui();
    store.clear();
    autoPreview = false;
    state.imp = { ...initialImportUi(), filter: u.filter, open: u.open, cancelling: u.cancelling, run: driverActive(u.run) ? u.run : null, space };
  }

  // ── the run ────────────────────────────────────────────────────────────────

  const setRun = (patch: Partial<ImportDriverView>): void => {
    const r = ui().run;
    if (r) ui().run = { ...r, ...patch };
    rerender();
  };

  function start(): void {
    const u = ui();
    const space = liveSpace(u.space);
    const pages = pagesOf(space);
    if (!space || !pages || u.busy || driverActive(u.run)) return;
    const plan = importPlanFor(u, pages);
    if (plan.error) return;
    const source = importSourceName(u.picks).slice(0, IMPORT_FILE_NAME_MAX);
    const ready = u.picks.filter((p) => p.state === "ready");
    const recs = ready.flatMap((p) => store.get(p.id) ?? []);
    const body: ImportStartBody = {
      space,
      parent_slug: importPlanOptions(u, pages).parentSlug ?? null,
      file_name: source,
      file_size: ready.length === 1 ? ready[0].size : null,
      files: u.files.map((f) => (f.kind === "md" ? { path: f.path, size: f.size, title: f.title ?? null } : { path: f.path, size: f.size })),
      choices: importChoices(u, plan, source),
    };
    u.busy = true;
    u.error = null;
    rerender();
    startImport(body)
      .then((ans) => {
        u.busy = false;
        const text = textMap(recs);
        const blobs = new Map<string, () => Promise<Blob>>();
        for (const r of recs) { const n = normalizeImportPath(r.path); if (n.ok && r.blob) blobs.set(n.path, r.blob); }
        const send = ans.plan.writes.filter((w: ImportWrite) => w.mode !== "skip")
          .map((w) => (w.path ? { path: w.path, text: text.get(w.path) ?? "" } : { path: w.key, text: "" }));
        const imagePaths = ans.plan.images.map((i) => i.path);
        const used: string[] = [];
        for (const pg of send) if (pg.text) for (const p of imagePathsUsed(pg.text, pg.path, imagePaths)) if (!used.includes(p)) used.push(p);
        const batches: Job["batches"] = [];
        for (let i = 0; i < send.length; i += IMPORT_PAGES_PER_BATCH) batches.push(send.slice(i, i + IMPORT_PAGES_PER_BATCH));
        job = { id: ans.run.id, space, batches, images: used.map((path) => ({ path, blob: blobs.get(path) ?? null })), img: 0, batch: 0, cancel: false, driving: false };
        u.run = {
          id: ans.run.id, phase: used.length ? "images" : "pages", source, space, spaceName: host.spaceName(space),
          pages: send.length, pagesDone: 0, images: used.length, imagesDone: 0, current: null, error: null, run: ans.run,
        };
        u.step = "run";
        state.badges = { ...state.badges, imports: Math.max(1, state.badges.imports ?? 0) };
        rerender();
        scrollTop();
        void drive();
      })
      .catch((e) => {
        if (fail(e)) return;
        u.busy = false;
        u.error = importErrorText(e, "Couldn't start the import.");
        rerender();
      });
  }

  async function drive(): Promise<void> {
    const j = job;
    if (!j || j.driving) return;
    j.driving = true;
    try {
      while (j.img < j.images.length) {
        if (j.cancel || job !== j) return;
        const im = j.images[j.img];
        setRun({ phase: "images", current: im.path, error: null });
        if (im.blob) {
          try {
            await uploadImportImage(j.id, im.path, await im.blob());
          } catch (e) {
            if (transient(e) || e instanceof Unauthorized) throw e;
            // A refused image (not an image after all, too large): the page shows its alt text instead.
          }
        }
        j.img++;
        setRun({ imagesDone: j.img });
      }
      while (j.batch < j.batches.length) {
        if (j.cancel || job !== j) return;
        const b = j.batches[j.batch];
        setRun({ phase: "pages", current: b.length > 1 ? `${b[0].path} and ${b.length - 1} more` : b[0]?.path ?? null, error: null });
        const ans = await sendImportPages(j.id, b);
        j.batch++;
        setRun({ pagesDone: Math.min(ui().run?.pages ?? 0, j.batches.slice(0, j.batch).reduce((n, x) => n + x.length, 0)), run: ans.run });
      }
      if (j.cancel || job !== j) return;
      setRun({ phase: "finishing", current: null });
      const fin = await finishImport(j.id);
      if (job !== j) return;
      ended(j, fin.run, null);
    } catch (e) {
      if (fail(e) || j.cancel || job !== j) return;
      if (transient(e)) {
        setRun({ phase: "stalled", error: rateLimitText(e) ?? "The connection dropped while the files were being sent. Retry sends them again; nothing is added twice." });
        return;
      }
      ended(j, ui().run?.run ?? null, importErrorText(e, "The import stopped."));
    } finally {
      j.driving = false;
    }
  }

  /** The run is over: done, or stopped by a refusal (`error`). */
  function ended(j: Job, run: ImportRunView | null, error: string | null): void {
    job = null;
    const r = ui().run;
    if (r && r.id === j.id) {
      ui().run = { ...r, phase: error ? "stopped" : "done", run, error, current: null, pagesDone: run?.counts.staged ?? r.pagesDone, imagesDone: run?.counts.images_uploaded ?? r.imagesDone };
    }
    state.badges = { ...state.badges, imports: 0 };
    host.landed(j.space);
    if (state.importRuns.status !== "idle") loadHistory();
    if (state.screen !== "import" && !error && run) {
      const n = run.counts.staged;
      host.flash(`${n} ${n === 1 ? "page" : "pages"} from ${r?.source ?? run.file_name} ${n === 1 ? "is" : "are"} in Review`, 6000, { label: "Open Review", act: "goReview", arg: "" });
    } else rerender();
  }

  function retry(): void {
    const r = ui().run;
    if (!job || !r || r.phase !== "stalled") return;
    setRun({ phase: job.img < job.images.length ? "images" : "pages", error: null });
    void drive();
  }

  /** Cancel import: the run is stopped on the server (pages already sent stay in Review). From the wizard it goes
   *  back to Preview; from Imports history (`id`) it stays there. */
  function cancel(id: number | null, fromHistory: boolean): void {
    const j = job;
    const runId = id ?? j?.id ?? null;
    if (runId === null) return;
    const mine = j !== null && j.id === runId;
    if (mine) j.cancel = true;
    if (fromHistory) { ui().cancelling = runId; rerender(); }
    finishImport(runId, { cancel: true })
      .then((ans) => {
        const staged = ans.run.counts.staged;
        if (mine) {
          job = null;
          ui().run = null;
          if (!fromHistory) ui().step = "preview";
        }
        ui().cancelling = null;
        state.badges = { ...state.badges, imports: 0 };
        host.flash(fromHistory ? "Import cancelled. Pages already added stay in Review." : staged ? `Import cancelled. ${staged} ${staged === 1 ? "page" : "pages"} already added stay in Review.` : "Import cancelled. Nothing was added.", 4200);
        host.landed(ans.run.space);
        if (state.importRuns.status !== "idle") loadHistory();
        rerender();
      })
      .catch((e) => {
        if (fail(e)) return;
        ui().cancelling = null;
        if (mine && j) { j.cancel = false; if (ui().run?.phase !== "stalled") void drive(); }
        host.flash(importErrorText(e, "Couldn't cancel the import."), 5000);
        rerender();
      });
  }

  // ── Imports history ────────────────────────────────────────────────────────

  function loadHistory(): void {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    const seq = ++histSeq;
    state.importRuns = { status: "loading", data: state.importRuns.data };
    rerender();
    listImports()
      .then((d) => {
        if (seq !== histSeq) return;
        state.importRuns = { status: "ok", data: d.imports };
        state.badges = { ...state.badges, imports: d.running };
        if (d.running > 0 && state.screen === "imports") pollTimer = setTimeout(() => { pollTimer = null; if (state.screen === "imports") loadHistory(); }, POLL_MS);
        host.rerenderSoon();
      })
      .catch((e) => {
        if (fail(e) || seq !== histSeq) return;
        state.importRuns = { status: "error", data: state.importRuns.data, error: String(e) };
        host.rerenderSoon();
      });
  }

  // ── entry points ───────────────────────────────────────────────────────────

  function open(space: string | null): void {
    state.screen = "import";
    if (driverActive(ui().run)) { ui().step = "run"; rerender(); return; }
    reset(liveSpace(space));
    if (ui().space) host.ensureSpace(ui().space as string);
    rerender();
  }

  function enter(space: string | null): void {
    const u = ui();
    const sp = liveSpace(space) ?? (state.library.status === "ok" ? null : space);
    if (sp && sp !== u.space && !driverActive(u.run)) { u.space = sp; u.parent = null; u.whereOpen = {}; }
    // After a page load the picked files are gone (they were never stored): back to Files.
    if ((u.step === "files" || u.step === "preview") && !u.picks.length) u.step = u.space ? "files" : "where";
    if (u.step === "run" && !u.run) u.step = "where";
    if (u.space) host.ensureSpace(u.space);
    rerender();
  }

  function dropTo(files: readonly File[], space: string): void {
    if (driverActive(ui().run)) { open(space); host.flash("An import is already running from this page. It has to finish first.", 4200); return; }
    open(space);
    if (!ui().space) return;
    ui().step = "files";
    autoPreview = true;
    addFiles(files);
  }

  function act(act: string, arg: string | null, value: string | null): boolean {
    const u = ui();
    switch (act) {
      // ── Where ──
      case "impSpace": {
        const sp = liveSpace(arg);
        if (!sp || driverActive(u.run)) return true;
        if (sp !== u.space) { u.space = sp; u.parent = null; u.whereOpen = {}; u.choices = {}; u.renames = {}; }
        host.ensureSpace(sp);
        rerender();
        return true;
      }
      case "impParent": u.parent = arg || null; u.choices = {}; u.renames = {}; rerender(); return true;
      case "impWhereToggle": if (arg) { u.whereOpen = { ...u.whereOpen, [arg]: !u.whereOpen[arg] }; rerender(); } return true;
      case "impStep": if (arg === "where" || arg === "files" || arg === "preview") goStep(arg); return true;

      // ── Files ──
      case "impChoose": host.mount.querySelector<HTMLInputElement>("[data-imp-file]")?.click(); return true;
      case "impRemove": if (arg) removePick(Number(arg)); return true;

      // ── Preview ──
      case "impAll": {
        if (arg !== "skip" && arg !== "version") return true;
        const pages = pagesOf(u.space);
        if (!pages) return true;
        for (const c of importPlanFor(u, pages).conflicts) u.choices[c.key] = arg;
        rerender();
        return true;
      }
      case "impChoice": {
        const at = (arg ?? "").indexOf(":");
        const choice = (arg ?? "").slice(0, at) as ConflictChoice;
        const key = (arg ?? "").slice(at + 1);
        if (at < 0 || !key || !["skip", "version", "rename"].includes(choice)) return true;
        u.choices = { ...u.choices, [key]: choice };
        rerender();
        if (choice === "rename") soon(() => host.mount.querySelector<HTMLInputElement>(`[data-field="imp-rn:${key.replace(/["\\]/g, "\\$&")}"]`)?.focus());
        return true;
      }
      case "impRename": if (arg) { u.renames = { ...u.renames, [arg]: value ?? "" }; rerender(); } return true;
      case "impStart": start(); return true;

      // ── Import ──
      case "impRetry": retry(); return true;
      case "impCancel": cancel(null, false); return true;
      case "impMore": {
        if (driverActive(u.run)) return true;
        const sp = u.space;
        reset(sp);
        ui().step = sp ? "files" : "where";
        rerender();
        scrollTop();
        return true;
      }

      // ── Imports history ──
      case "impFilter": if (arg === "all" || arg === "running" || arg === "done" || arg === "failed") { u.filter = arg as ImportsFilter; rerender(); } return true;
      case "impOpen": { const id = Number(arg); if (Number.isInteger(id)) { u.open = u.open === id ? null : id; rerender(); } return true; }
      case "impHistCancel": { const id = Number(arg); if (Number.isInteger(id) && u.cancelling === null) cancel(id, true); return true; }
      case "impTryAgain": open(arg); if (ui().space) { ui().step = "files"; rerender(); } return true;
    }
    return false;
  }

  return { act, open, enter, loadHistory, addFiles, dropTo };
}
