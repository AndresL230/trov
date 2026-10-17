// Drop to import (the Library design's §10, docs/architecture/docs-library.md › The import screens): Markdown files
// or a .zip dragged over a space's page — its home, a doc page, New page, the docs pane — or over a sidebar space row
// open the import wizard on that space at its Preview step. Not on the import screen itself (its Files step has its
// own drop zone).
//
// The overlay is ONE node on <body>, outside the app's mount, moved and filled here on each `dragover` — a drag never
// repaints the app (a rerender per `dragover` would rebuild a page that is not `data-morph`ed). Over the main column
// it veils it with the dashed edge and "Drop to import into ‹Space›"; over a sidebar space row it lights the row and
// floats a pill beside it, with a lighter veil. Files that can't be imported say so while they are over it, and
// a toast says so when they are dropped. The motion (the edge breathing, the icon bobbing) is off under reduced
// motion (trov.css `.cnpy-impdrop`).

/** The MIME types a drag may carry and still be imported (a file's type is all a drag shows before the drop). */
export const DROP_TYPES: ReadonlySet<string> = new Set([
  "", "text/markdown", "text/x-markdown", "text/plain", "application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream",
]);
/** What a dropped file must be called. */
const OK_NAME = /\.(md|markdown|zip)$/i;

export const DROP_BAD_TITLE = "Only Markdown files can be imported";
export const DROP_SIDE_BAD = "Only Markdown files, or a .zip of them, can be imported.";
export const dropTitle = (space: string): string => `Drop to import into ${space}`;
export const dropSub = (n: number): string => `${n === 1 ? "1 file" : `${n} Markdown files`}. You can check everything before it goes to Review.`;
export const dropBadSub = (name: string | null): string => `${name ?? "That"} isn't a Markdown file. Drop .md files, or one .zip of them.`;
export const dropBadToast = (name: string): string => `${name} isn't a Markdown file. Use .md files or a .zip of them.`;

/** What a drag holds: how many files, and whether one of them can't be imported. Null when it holds no file. */
export function dragFiles(dt: Pick<DataTransfer, "types" | "items"> | null): { n: number; bad: boolean } | null {
  if (!dt || !Array.from(dt.types ?? []).includes("Files")) return null;
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  return { n: items.length, bad: items.some((i) => !DROP_TYPES.has(i.type)) };
}

/** The files a drop brought: the ones that can be imported, and the first that can't. */
export function splitDropped(files: readonly File[]): { ok: File[]; bad: File | null } {
  const bad = files.find((f) => !OK_NAME.test(f.name)) ?? null;
  return { ok: bad ? [] : [...files], bad };
}

export interface DropHost {
  /** In the app, and not on the import screen. */
  enabled(): boolean;
  /** The space the main column is a drop target for (a space's home, a doc in it, New page in it), or null. */
  mainSpace(): { slug: string; name: string } | null;
  spaceName(slug: string): string | null;
  /** Good files dropped on `space`. */
  drop(files: File[], space: string): void;
  /** What a refused drop says. */
  bad(msg: string): void;
}

const UPLOAD = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"></path><path d="m7 9 5-5 5 5"></path><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"></path></svg>`;
const BAN = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M5.6 5.6l12.8 12.8"></path></svg>`;

/** Wire the drag listeners on the document (once, at boot). Returns a function that removes them. */
export function installImportDrop(host: DropHost, doc: Document = document): () => void {
  let node: HTMLDivElement | null = null;
  let lit: Element | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where the drag is now (what the drop does). */
  let target: { space: string; side: boolean } | null = null;

  const el = (): HTMLDivElement => {
    if (node) return node;
    node = doc.createElement("div");
    node.className = "cnpy-impdrop";
    node.hidden = true;
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = `<div class="cnpy-impdrop-veil"></div><div class="cnpy-impdrop-edge" style="border-radius:10px"></div><div class="cnpy-impdrop-box"><span class="cnpy-impdrop-tile" style="border-radius:10px"></span><div class="cnpy-impdrop-t"></div><div class="cnpy-impdrop-s"></div></div><div class="cnpy-impdrop-pill" style="border-radius:8px"><span class="cnpy-impdrop-pi"></span><span class="cnpy-impdrop-pt"></span><span class="cnpy-impdrop-pn"></span></div>`;
    doc.body.appendChild(node);
    return node;
  };
  const unlight = () => { lit?.classList.remove("is-drop"); lit = null; };
  const hide = () => {
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
    target = null;
    unlight();
    if (node) node.hidden = true;
  };
  const text = (sel: string, t: string) => { const x = node?.querySelector(sel); if (x) x.textContent = t; };

  function show(mode: "main" | "side", info: { n: number; bad: boolean }, space: string, row: Element | null): void {
    const n = el();
    // The overlay lives on <body>: it takes the app's theme (its tokens) from the app's root.
    const theme = doc.querySelector("[data-cnpy-theme]")?.getAttribute("data-cnpy-theme");
    if (theme) n.setAttribute("data-cnpy-theme", theme);
    n.dataset.mode = mode;
    n.dataset.bad = info.bad ? "1" : "0";
    const main = doc.getElementById("cnpy-main")?.getBoundingClientRect();
    if (main) Object.assign(n.style, { left: `${main.left}px`, top: `${main.top}px`, width: `${main.width}px`, height: `${main.height}px` });
    const tile = n.querySelector(".cnpy-impdrop-tile");
    if (tile) tile.innerHTML = info.bad ? BAN : UPLOAD;
    const name = host.spaceName(space) ?? space;
    text(".cnpy-impdrop-t", info.bad ? DROP_BAD_TITLE : dropTitle(name));
    text(".cnpy-impdrop-s", info.bad ? dropBadSub(null) : dropSub(info.n));
    const pill = n.querySelector<HTMLElement>(".cnpy-impdrop-pill");
    if (pill) {
      const pi = pill.querySelector(".cnpy-impdrop-pi");
      if (pi) pi.innerHTML = info.bad ? BAN : UPLOAD;
      text(".cnpy-impdrop-pt", info.bad ? DROP_BAD_TITLE : dropTitle(name));
      text(".cnpy-impdrop-pn", info.bad ? "" : `${info.n} ${info.n === 1 ? "file" : "files"}`);
      if (row && main) {
        const r = row.getBoundingClientRect();
        Object.assign(pill.style, { left: `${Math.max(8, r.right + 10 - main.left)}px`, top: `${r.top + r.height / 2 - main.top}px` });
      }
    }
    if (row !== lit) { unlight(); if (row) { row.classList.add("is-drop"); lit = row; } }
    n.hidden = false;
  }

  const over = (e: DragEvent): void => {
    const info = dragFiles(e.dataTransfer);
    if (!info || !host.enabled()) { if (target) hide(); return; }
    const t = e.target as Element | null;
    const row = t?.closest?.(".cnpy-aside [data-drop-space]") ?? null;
    const inMain = t?.closest?.("#cnpy-main") ?? null;
    const main = inMain ? host.mainSpace() : null;
    const space = row?.getAttribute("data-drop-space") ?? main?.slug ?? null;
    if (!space) { if (target) hide(); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    target = { space, side: row !== null };
    show(row ? "side" : "main", info, space, row);
    // No `dragleave` is reliable across child elements: the overlay goes when the dragovers stop.
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 180);
  };
  const drop = (e: DragEvent): void => {
    const at = target;
    if (!at || e.defaultPrevented) { hide(); return; }
    e.preventDefault();
    hide();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const { ok, bad } = splitDropped(files);
    if (bad) { host.bad(at.side ? DROP_SIDE_BAD : dropBadToast(bad.name)); return; }
    host.drop(ok, at.space);
  };
  const end = () => hide();
  doc.addEventListener("dragover", over);
  doc.addEventListener("drop", drop);
  doc.addEventListener("dragend", end);
  return () => {
    doc.removeEventListener("dragover", over);
    doc.removeEventListener("drop", drop);
    doc.removeEventListener("dragend", end);
    hide();
    node?.remove();
    node = null;
  };
}
