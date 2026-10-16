// The Markdown chunk's loader (markdown-lib.ts: marked + DOMPurify). Kept apart from markdown.ts so
// md-blocks.ts can reach the lexer without importing the renderers, which every render test mocks.
//
// A renderer asked for a body before the chunk is in draws a placeholder and starts the load; the
// load's arrival calls the app's `onMarkdownLib` hook (main.ts: `rerenderSoon`) — only when a
// placeholder was actually drawn, so a chunk that lands before any body is needed paints nothing.
import type * as MarkdownLib from "./markdown-lib";
import { lazyChunk } from "./lazy-chunk";

export type MarkdownLibModule = typeof MarkdownLib;

const chunk = lazyChunk<MarkdownLibModule>(() => import("./markdown-lib"));
let missed = false;
let ready: (() => void) | null = null;

/** The loaded libraries, or null while they are not in. */
export const markdownLib = (): MarkdownLibModule | null => chunk.get();

/** Start (or join) the load — the app calls this as soon as it is signed in, beside its first reads. */
export function loadMarkdownLib(): Promise<MarkdownLibModule> {
  return chunk.load().then((m) => {
    if (missed) { missed = false; ready?.(); }
    return m;
  });
}

let prefetched = false;
/** Signed in: start the load once, beside the screen's first reads, so the libraries are usually in
 *  before any body is drawn (and no placeholder is ever seen). */
export function prefetchMarkdownLib(): void {
  if (prefetched || chunk.get()) return;
  prefetched = true;
  void loadMarkdownLib().catch(() => undefined);
}

/** A renderer drew a placeholder: load, and repaint once the libraries are in. */
export function markdownMissed(): void {
  missed = true;
  if (!chunk.failed()) void loadMarkdownLib().catch(() => undefined);
}

/** What to call when the libraries land after a placeholder was drawn (main.ts: a `rerenderSoon`). */
export function onMarkdownLib(fn: (() => void) | null): void { ready = fn; }

/** For tests: hand in the libraries as if they had loaded (or forget them with null). */
export function setMarkdownLib(m: MarkdownLibModule | null): void { chunk.set(m); missed = false; }
