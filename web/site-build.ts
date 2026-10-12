// The public pages at build time (docs/architecture/web-ui.md › The public pages, for crawlers). Every
// page of shared/site-pages.ts, and the app shell, is a Vite input whose HTML this plugin WRITES: there is
// no .html file in web/ to keep in step, so adding a page is one entry in that list. It also writes the
// assets binding's `_redirects` and `_headers` from the same list, and the files that are not pages: each
// docs page's Markdown (`/docs/<page>.md`), `/pricing.md`, `/llms.txt` and `/llms-full.txt`. The documents
// come from web/src/site-prerender.ts — the app's real renderers, run in Node through Vite's own module
// loader (the same `@shared` alias), so a page is prerendered from exactly the code that boots it.
//
// FIRST, the MCP tool list: src/mcp-catalog.ts builds the real MCP server and lists its tools, and the
// result is written to shared/mcp-tools.generated.ts (only when it changed) BEFORE anything reads it — the
// tools reference, llms-full.txt and the landing's count all come from that file, so a build can never
// ship a stale list (test/mcp-catalog.test.ts fails while the committed copy differs).
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Plugin } from "vite";
import { APP_SHELL_PATH, SITE_PAGES, assetHeaders, assetRedirects, sitePageFile } from "../shared/site-pages";
import { generatedToolsModule, type McpToolDoc } from "../shared/mcp-tools-core";

const WEB = __dirname;
const ROOT = path.join(WEB, "..");
/** The app shell's input, served at APP_SHELL_PATH. */
const APP_SHELL = path.join(WEB, `${APP_SHELL_PATH.slice(1)}.html`);
/** Written from the MCP server's own tool list (src/mcp-catalog.ts). */
export const GENERATED_TOOLS = path.join(ROOT, "shared", "mcp-tools.generated.ts");

/** The build's inputs: one per public page (served from `<name>.html`) and the app shell. */
export function siteInputs(): Record<string, string> {
  return {
    ...Object.fromEntries(SITE_PAGES.map((p) => [p.key, path.join(WEB, sitePageFile(p))])),
    app: APP_SHELL,
  };
}

type Prerender = typeof import("./src/site-prerender");
/** src/mcp-catalog.ts's one export (typed here: this file is checked with the web's tsconfig, not the Worker's). */
type Catalog = { mcpToolCatalog(): Promise<McpToolDoc[]> };

/** `agents/mcp` reaches `cloudflare:workers`, which Node cannot load. Its one export (`createMcpHandler`,
 *  the Streamable HTTP adapter) is not part of registering a tool, so the catalog's loader stubs it. */
const stubAgents: Plugin = {
  name: "trov:stub-agents-mcp",
  enforce: "pre",
  resolveId: (id) => (id === "agents/mcp" ? "\0trov:agents-mcp" : null),
  load: (id) => (id === "\0trov:agents-mcp" ? `export const createMcpHandler = () => { throw new Error("not at build time"); };` : null),
};

const writeIfChanged = (file: string, text: string): void => {
  let old: string | null = null;
  try { old = readFileSync(file, "utf8"); } catch { /* new */ }
  if (old !== text) writeFileSync(file, text);
};

export function sitePages(): Plugin {
  let docs = new Map<string, string>();
  let files: Record<string, string> = {};
  return {
    name: "trov:site-pages",
    enforce: "pre",
    // Rendered once per build (and per rebuild under --watch): a throwaway module server lists the MCP
    // tools, then loads the prerender module; every document is made, and the server is closed.
    async buildStart() {
      const server = await createServer({
        configFile: false,
        root: WEB,
        logLevel: "error",
        appType: "custom",
        server: { middlewareMode: true, hmr: false, watch: null },
        plugins: [stubAgents],
        resolve: { alias: { "@shared": path.join(ROOT, "shared") } },
        optimizeDeps: { noDiscovery: true, include: [] },
        // `agents` is bundled by Vite here, not handed to Node, so the stub above can stand in for it.
        ssr: { noExternal: ["agents"] },
      });
      try {
        const catalog = (await server.ssrLoadModule(`/@fs${path.join(ROOT, "src", "mcp-catalog.ts")}`)) as Catalog;
        writeIfChanged(GENERATED_TOOLS, generatedToolsModule(await catalog.mcpToolCatalog()));
        const mod = (await server.ssrLoadModule("/src/site-prerender.ts")) as Prerender;
        docs = new Map(SITE_PAGES.map((p) => [path.join(WEB, sitePageFile(p)), mod.sitePageHtml(p)]));
        docs.set(APP_SHELL, mod.appShellHtml());
        files = mod.siteFiles();
        // A change to anything a page was rendered from rebuilds it under `vite build --watch` (the
        // generated tool list is written only when it changed, so it cannot loop).
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
    // the files never to index — both from the same list — and the text files beside the pages.
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_redirects", source: assetRedirects() });
      this.emitFile({ type: "asset", fileName: "_headers", source: assetHeaders() });
      for (const [fileName, source] of Object.entries(files)) this.emitFile({ type: "asset", fileName, source });
    },
  };
}
