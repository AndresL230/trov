// The public pages at build time (docs/architecture/web-ui.md › The public pages, for crawlers). Every
// page of shared/site-pages.ts, and the app shell, is a Vite input whose HTML this plugin WRITES: there is
// no .html file in web/ to keep in step, so adding a page is one entry in that list. It also writes the
// assets binding's `_redirects` and `_headers` from the same list, and the self-hosted fonts' stable copies
// under /fonts/ (shared/fonts.ts) for the pages the Worker renders itself. The documents come
// from web/src/site-prerender.ts — the app's real renderers, run in Node through Vite's own module loader
// (the same `@shared` alias), so a page is prerendered from exactly the code that boots it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import { APP_SHELL_PATH, SITE_PAGES, assetHeaders, assetRedirects, sitePageFile } from "../shared/site-pages";
import { FONTS_PATH, FONT_FILES, FONT_LICENSES } from "../shared/fonts";

const WEB = __dirname;
/** The app shell's input, served at APP_SHELL_PATH. */
const APP_SHELL = path.join(WEB, `${APP_SHELL_PATH.slice(1)}.html`);

/** The build's inputs: one per public page (served from `<name>.html`) and the app shell. */
export function siteInputs(): Record<string, string> {
  return {
    ...Object.fromEntries(SITE_PAGES.map((p) => [p.key, path.join(WEB, sitePageFile(p))])),
    app: APP_SHELL,
  };
}

type Prerender = typeof import("./src/site-prerender");

export function sitePages(): Plugin {
  let docs = new Map<string, string>();
  return {
    name: "trov:site-pages",
    enforce: "pre",
    // Rendered once per build (and per rebuild under --watch): a throwaway module server loads the
    // prerender module, every document is made, and the server is closed.
    async buildStart() {
      const server = await createServer({
        configFile: false,
        root: WEB,
        logLevel: "error",
        appType: "custom",
        server: { middlewareMode: true, hmr: false, watch: null },
        resolve: { alias: { "@shared": path.join(WEB, "..", "shared") } },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        const mod = (await server.ssrLoadModule("/src/site-prerender.ts")) as Prerender;
        docs = new Map(SITE_PAGES.map((p) => [path.join(WEB, sitePageFile(p)), mod.sitePageHtml(p)]));
        docs.set(APP_SHELL, mod.appShellHtml());
        // A change to anything a page was rendered from rebuilds it under `vite build --watch`.
        for (const id of server.moduleGraph.idToModuleMap.keys()) if (path.isAbsolute(id) && !id.includes("node_modules")) this.addWatchFile(id);
      } finally {
        await server.close();
      }
    },
    resolveId(id) {
      if (docs.has(id)) return id;
      const inWeb = path.join(WEB, id); // "/index.html" as the root-relative id
      return docs.has(inWeb) ? inWeb : null;
    },
    load(id) {
      return docs.get(id) ?? null;
    },
    // What the assets binding is told about these pages: their other spellings (301 to the one URL) and
    // the files never to index — both from the same list.
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_redirects", source: assetRedirects() });
      this.emitFile({ type: "asset", fileName: "_headers", source: assetHeaders() });
      // The self-hosted fonts at a stable path, with their licenses (shared/fonts.ts): the pages the Worker
      // renders itself (OAuth, billing notices) cannot know the hashed /assets/ names trov.css resolves to.
      for (const f of [...FONT_FILES.map((x) => x.file), ...FONT_LICENSES]) {
        this.emitFile({ type: "asset", fileName: `${FONTS_PATH.slice(1)}/${f}`, source: readFileSync(path.join(WEB, "src", "fonts", f)) });
      }
    },
  };
}
