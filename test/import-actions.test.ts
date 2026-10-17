/**
 * The import controller (web/src/import-actions.ts): the files read in the browser (a .zip unpacked here) and the
 * run it drives — POST /imports with the manifest and the fixed choices, every image a page uses BEFORE the pages,
 * the pages in the server plan's order (a folder page with no file of its own sent by its key, with no text), a
 * batch that does not get through stalling the run with Retry resending THAT batch, and Cancel import.
 *
 * The API is stubbed at the module (no network); the zips are built here (stored entries).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../web/src/api", async (orig) => ({
  ...(await orig<typeof import("../web/src/api")>()),
  startImport: vi.fn(), uploadImportImage: vi.fn(), sendImportPages: vi.fn(), finishImport: vi.fn(), listImports: vi.fn(),
}));
import * as api from "../web/src/api";
import { createImportController, type ImportHost } from "../web/src/import-actions";
import { initialState, type AppState } from "../web/src/render";
import { crc32 } from "../web/src/zip-reader";
import { planImport, applyConflictChoices, zeroImportCounts, type ImportRunView, type ImportStartBody } from "@shared/docs-import-core";
import type { LibraryDTO, SpaceDTO } from "@shared/docs-core";

const enc = new TextEncoder();
/** A classic zip of stored entries. */
function zipOf(items: { name: string; data: Uint8Array | string }[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const it of items) {
    const data = typeof it.data === "string" ? enc.encode(it.data) : it.data;
    const name = enc.encode(it.name);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc32(data), true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc32(data), true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, data); centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ZIP = zipOf([
  { name: "guide/README.md", data: "# Guide\n\n![arch](img/arch.png)\n\nSee [setup](setup.md) and [gone](gone.md).\n" },
  { name: "guide/setup.md", data: "# Setup\n\nInstall it.\n" },
  { name: "guide/more/notes.md", data: "# Notes\n\nx\n" },
  { name: "guide/img/arch.png", data: PNG },
  { name: "guide/logo.sketch", data: "x" },
]);

const T0 = "2026-10-15T10:00:00Z";
const ENG: SpaceDTO = { slug: "engineering", name: "Engineering", icon: "braces", color: "#525cc3", description: "", sort_rank: 1, created_at: T0, created_by: "system", archived: false, archived_at: null, owners: [], pages: 0, waiting: 0 };
const LIB: LibraryDTO = { spaces: [ENG], archived: [], recent: [], waiting: 0, can_admin: false };
const runView = (over: Partial<ImportRunView> = {}): ImportRunView => ({
  id: 41, status: "running", space: "engineering", space_name: "Engineering", parent_slug: null, parent_path: [], file_name: "guide.zip", file_size: ZIP.length, file_count: 5,
  by: "andres", started_at: T0, updated_at: T0, ended_at: null, cancelled: false, counts: zeroImportCounts(), failures: [], waiting: 0, ...over,
});
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function setup() {
  const state: AppState = { ...initialState(), view: "app", screen: "import", library: { status: "ok", data: LIB },
    spaceHome: { status: "ok", data: { space: ENG, pages: [], can_edit: false, can_admin: false } } };
  const flash = vi.fn();
  const landed = vi.fn();
  const host: ImportHost = {
    state, mount: { querySelector: () => null } as unknown as HTMLElement,
    rerender: () => {}, rerenderSoon: () => {}, flash, unauth: () => {}, ensureSpace: () => {}, landed, spaceName: (s) => (s === "engineering" ? "Engineering" : s),
  };
  return { state, ctl: createImportController(host), flash, landed };
}

/** What the server answers POST /imports with: the shared planner over the manifest it was sent. */
function serverPlan(body: ImportStartBody) {
  const files = body.files.map((f) => ({ ...f, kind: /\.md$/.test(f.path) ? "md" as const : /\.png$/.test(f.path) ? "image" as const : "other" as const }));
  const plan = planImport(files, { existingTitles: new Map(), existingSlugs: new Set() });
  return { writes: applyConflictChoices(plan, body.choices ?? {}, body.file_name), skipped: plan.skipped, conflicts: plan.conflicts, images: plan.images };
}

beforeEach(() => { vi.mocked(api.startImport).mockReset(); vi.mocked(api.uploadImportImage).mockReset(); vi.mocked(api.sendImportPages).mockReset(); vi.mocked(api.finishImport).mockReset(); });

describe("reading the files", () => {
  it("unpacks a zip in the browser: every file's path, size and first heading, and the links and images counted", async () => {
    const { state, ctl } = setup();
    ctl.open("engineering");
    ctl.act("impStep", "files", null);
    ctl.addFiles([new File([ZIP], "guide.zip")]);
    expect(state.imp.picks[0].state).toBe("reading");
    await settle();
    expect(state.imp.picks[0]).toMatchObject({ state: "ready", inside: 5, kind: "zip" });
    expect(state.imp.files.find((f) => f.path === "guide/README.md")).toEqual({ path: "guide/README.md", size: expect.any(Number), kind: "md", title: "Guide" });
    expect(state.imp.files.find((f) => f.path === "guide/img/arch.png")?.kind).toBe("image");
    expect(state.imp.links).toEqual({ total: 2, inImport: 1, existing: 0, unmatched: 1, imagesUsed: 1 });
  });

  it("a damaged zip says so on its row; a file that is not Markdown is refused at once", async () => {
    const { state, ctl } = setup();
    ctl.open("engineering");
    ctl.addFiles([new File([new Uint8Array([1, 2, 3])], "broken.zip")]);
    await settle();
    expect(state.imp.picks[0]).toMatchObject({ state: "bad", error: "This zip is damaged or unsupported." });
    ctl.addFiles([new File(["x"], "q3.pdf")]);
    expect(state.imp.picks.at(-1)).toMatchObject({ state: "bad", kind: "other" });
  });

  it("dropped on a space, good files go straight to Preview once they are read", async () => {
    const { state, ctl } = setup();
    ctl.dropTo([new File(["# One\n\nx"], "one.md"), new File(["# Two\n\nx"], "two.md")], "engineering");
    expect(state.screen).toBe("import");
    expect(state.imp.space).toBe("engineering");
    await settle();
    expect(state.imp.step).toBe("preview");
    expect(state.imp.files.map((f) => f.title)).toEqual(["One", "Two"]);
  });
});

describe("the run", () => {
  it("starts with the manifest, uploads the images first, sends the pages in the plan's order, and a failed batch is resent on Retry", async () => {
    const { state, ctl, landed } = setup();
    ctl.open("engineering");
    ctl.addFiles([new File([ZIP], "guide.zip")]);
    await settle();
    ctl.act("impStep", "preview", null);
    vi.mocked(api.startImport).mockImplementation(async (body) => ({ ok: true, run: runView(), plan: serverPlan(body) }));
    vi.mocked(api.uploadImportImage).mockResolvedValue({ ok: true, path: "guide/img/arch.png", sha: "a".repeat(64) });
    vi.mocked(api.sendImportPages).mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue({ ok: true, run: runView({ counts: { ...zeroImportCounts(), staged: 4 } }), results: [] });
    vi.mocked(api.finishImport).mockResolvedValue({ ok: true, run: runView({ status: "partial", counts: { ...zeroImportCounts(), pages: 4, staged: 4, staged_new: 4, skipped_files: 1 } }) });
    ctl.act("impStart", null, null);
    await settle();

    const body = vi.mocked(api.startImport).mock.calls[0][0];
    expect(body).toMatchObject({ space: "engineering", parent_slug: null, file_name: "guide.zip", file_size: ZIP.length });
    expect(body.files.find((f) => f.path === "guide/setup.md")).toEqual({ path: "guide/setup.md", size: expect.any(Number), title: "Setup" });
    expect(body.files.find((f) => f.path === "guide/img/arch.png")).toEqual({ path: "guide/img/arch.png", size: PNG.length });
    // The image a page uses goes up before any page.
    expect(vi.mocked(api.uploadImportImage).mock.calls.map((c) => c[1])).toEqual(["guide/img/arch.png"]);
    expect(vi.mocked(api.uploadImportImage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.sendImportPages).mock.invocationCallOrder[0]);
    // The first batch did not get through: the run is stalled, nothing finished.
    expect(state.imp.run?.phase).toBe("stalled");
    expect(api.finishImport).not.toHaveBeenCalled();
    expect(state.badges.imports).toBe(1);

    ctl.act("impRetry", null, null);
    await settle();
    const [first, again] = vi.mocked(api.sendImportPages).mock.calls;
    expect(again).toEqual(first);                       // the SAME batch, again
    // Parents first; the folder page with no file of its own is sent by its key, with no text.
    expect(first[1].map((p) => p.path)).toEqual(["guide/README.md", "guide/more/", "guide/more/notes.md", "guide/setup.md"]);
    expect(first[1].find((p) => p.path === "guide/more/")?.text).toBe("");
    expect(first[1][0].text).toContain("![arch](img/arch.png)");
    expect(api.finishImport).toHaveBeenCalledWith(41);
    expect(state.imp.run).toMatchObject({ phase: "done", pagesDone: 4 });
    expect(state.badges.imports).toBe(0);
    expect(landed).toHaveBeenCalledWith("engineering");
  });

  it("Cancel import stops it on the server and goes back to Preview, saying nothing was added", async () => {
    const { state, ctl, flash } = setup();
    ctl.open("engineering");
    ctl.addFiles([new File(["# One\n\nx"], "one.md")]);
    await settle();
    ctl.act("impStep", "preview", null);
    vi.mocked(api.startImport).mockImplementation(async (body) => ({ ok: true, run: runView(), plan: serverPlan(body) }));
    vi.mocked(api.sendImportPages).mockImplementation(() => new Promise(() => {}));   // never answers
    vi.mocked(api.finishImport).mockResolvedValue({ ok: true, run: runView({ status: "abandoned", cancelled: true }) });
    ctl.act("impStart", null, null);
    await settle();
    expect(state.imp.step).toBe("run");
    ctl.act("impCancel", null, null);
    await settle();
    expect(api.finishImport).toHaveBeenCalledWith(41, { cancel: true });
    expect(state.imp.step).toBe("preview");
    expect(state.imp.run).toBeNull();
    expect(flash).toHaveBeenCalledWith("Import cancelled. Nothing was added.", 4200);
  });

  it("a refused start stays on Preview and says why", async () => {
    const { state, ctl } = setup();
    ctl.open("engineering");
    ctl.addFiles([new File(["# One\n\nx"], "one.md")]);
    await settle();
    ctl.act("impStep", "preview", null);
    vi.mocked(api.startImport).mockRejectedValue(new api.OrgApiError(409, "import_running", null, null));
    ctl.act("impStart", null, null);
    await settle();
    expect(state.imp.step).toBe("preview");
    expect(state.imp.busy).toBe(false);
    expect(state.imp.error).toContain("Another import is running");
  });
});
