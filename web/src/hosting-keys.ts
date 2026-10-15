// The Hosting sample preview's two switchers, as plain data (no DOM): web/src/hosting.ts draws them,
// web/src/hosting-sample.ts builds a payload for each, and the Worker-side tests import them.
/** The sample preview has TWO switchers (web/src/hosting-sample.ts `hostingScenario`). The FLOW is where a new org
 *  stands, step by step — from no repository, through Trov looking for the host, to every part live — plus the
 *  problem states (Broken, Locked, and Leftover tokens: Railway's old per-environment tokens from before 0057, still
 *  stored, with Railway not connected); the STACK is which hosts it runs on. Every flow × stack is a whole
 *  `HostingSetupDTO`. */
export const HOSTING_SAMPLE_KEYS = ["start", "looking", "found", "parts", "connecting", "live", "broken", "leftovers", "locked"] as const;
export type HostingSampleKey = (typeof HOSTING_SAMPLE_KEYS)[number];
export const isHostingSampleKey = (v: unknown): v is HostingSampleKey => typeof v === "string" && (HOSTING_SAMPLE_KEYS as readonly string[]).includes(v);
export const SAMPLE_LABEL: Record<HostingSampleKey, string> = {
  start: "New org", looking: "Looking", found: "Found", parts: "Parts added", connecting: "Connecting", live: "Live", broken: "Broken",
  leftovers: "Leftover tokens", locked: "Locked",
};
export const HOSTING_STACK_KEYS = ["vercel_render", "netlify_fly", "cloudflare_railway", "render_only", "railway_only", "vercel_only", "mixed"] as const;
export type HostingStackKey = (typeof HOSTING_STACK_KEYS)[number];
export const isHostingStackKey = (v: unknown): v is HostingStackKey => typeof v === "string" && (HOSTING_STACK_KEYS as readonly string[]).includes(v);
export const STACK_LABEL: Record<HostingStackKey, string> = {
  vercel_render: "Vercel + Render", netlify_fly: "Netlify + Fly.io", cloudflare_railway: "Cloudflare + Railway",
  render_only: "All on Render", railway_only: "All on Railway", vercel_only: "Vercel only", mixed: "Five hosts",
};
