import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  build: {
    outDir: path.join(__dirname, "dist"),
    emptyOutDir: true,
    // Four pages: the app, and the three public static pages (served at /terms, /privacy
    // and /pricing — the assets binding maps a bare path to its .html file).
    rollupOptions: {
      input: {
        main: path.join(__dirname, "index.html"),
        terms: path.join(__dirname, "terms.html"),
        privacy: path.join(__dirname, "privacy.html"),
        pricing: path.join(__dirname, "pricing.html"),
      },
    },
  },
  resolve: {
    alias: { "@shared": path.join(__dirname, "..", "shared") },
  },
});
