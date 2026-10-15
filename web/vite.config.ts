import { defineConfig } from "vite";
import path from "node:path";
import { siteInputs, sitePages } from "./site-build";

export default defineConfig({
  root: __dirname,
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
    // The inputs are the public site's pages — one per entry of shared/site-pages.ts (/, /pricing, /terms,
    // /privacy and the 404 page: `<name>.html`, which the assets binding serves at `/<name>`) — and the app
    // shell (app.html). None is a file in web/: site-build.ts writes each, prerendered.
    rollupOptions: { input: siteInputs() },
  },
  plugins: [sitePages()],
  resolve: {
    alias: { "@shared": path.join(__dirname, "..", "shared") },
  },
});
