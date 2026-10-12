// Vite `?raw` imports (tests read wrangler.toml to pin the cron strings).
// Must live in a script (import-free) file so the wildcard is an ambient
// module declaration rather than an augmentation.
declare module "*.toml?raw" {
  const content: string;
  export default content;
}
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
// Vite's eager raw glob, as test/data-layer.static.test.ts uses it to read the source text of src/.
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  // …and the lazy glob, read for its KEYS only (test/site.test.ts lists web/public without loading a file).
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
