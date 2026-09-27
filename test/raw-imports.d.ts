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
