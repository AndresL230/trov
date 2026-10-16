// A module the app loads when a screen first needs it (web-ui.md › The app's bundles). The render
// path is synchronous, so a lazy screen is drawn from `get()`: its own skeleton while that is null,
// the screen itself once the chunk is in. main.ts starts the load whenever a paint needs the chunk
// and repaints when it lands (`rerenderSoon`). A chunk that fails to load (an old page after a
// deploy, whose chunk names are gone) is not retried in a loop: `failed()` says so, and the screen
// says what to do — reload. The pattern of Help › What's new (releases-lazy.ts).
//
// `import("./x")` must be written out at each call site (Vite splits on the literal), so a chunk is
// made from a function that does the import: `lazyChunk(() => import("./platform"))`.

export interface LazyChunk<M> {
  /** The loaded module, or null while it is not in. */
  get(): M | null;
  /** The last load failed (a reload tries again). */
  failed(): boolean;
  /** Start (or join) the load. Resolves once it is in; rejects if it failed. */
  load(): Promise<M>;
  /** For tests and the build: hand in the module as if it had loaded (or forget it with null). */
  set(m: M | null): void;
}

export function lazyChunk<M>(importer: () => Promise<M>): LazyChunk<M> {
  let mod: M | null = null;
  let inflight: Promise<M> | null = null;
  let failed = false;
  return {
    get: () => mod,
    failed: () => failed,
    load() {
      if (mod) return Promise.resolve(mod);
      inflight ??= importer().then(
        (m) => { mod = m; failed = false; return m; },
        (e: unknown) => { inflight = null; failed = true; throw e; },
      );
      return inflight;
    },
    set(m) { mod = m; inflight = null; failed = false; },
  };
}

/** What a screen whose chunk did not load says, in its own frame. */
export function chunkFailedView(what: string): string {
  return `<div role="status" style="padding:48px 24px;text-align:center;color:var(--fg-60);font-size:14px">${what} did not load. Reload the page to try again.</div>`;
}
