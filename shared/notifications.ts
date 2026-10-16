// Email notification contract (canopy-email.md §2). Lives in shared/ so the
// Worker (registry, resolver, run assembler) and the web build (Settings and
// Maintenance iterate the registry metadata) agree on the shape.
//
// Cadences are daily, weekly, off — there is deliberately NO immediate tier.
import { z } from "zod";

export const Cadence = z.enum(["daily", "weekly", "off"]);
export type Cadence = z.infer<typeof Cadence>;

// A run is always daily or weekly; 'off' is a preference, never a run.
export const RunCadence = z.enum(["daily", "weekly"]);
export type RunCadence = z.infer<typeof RunCadence>;

// The window a run covers: [start, end). `id` is the idempotency component
// (`YYYY-MM-DD` daily, `YYYY-Www` weekly — §4).
export const Window = z.object({
  cadence: RunCadence,
  start: z.date(),
  end: z.date(),
  id: z.string().min(1),
});
export type Window = z.infer<typeof Window>;

// One rendered section of a digest. `deepLink` is a site-relative path into the
// SPA (`/#mywork`); the assembler prefixes the origin. `summary` is the one-line
// subline under the heading (also the preheader); `linkLabel` names the surface
// the deep link opens ("Open My Work →").
//
// Phase E (the shorter e-mail): `layout: "line"` is a queue's ONE line ("Review: 3 waiting") — `heading` is its
// label, `text` the whole line, `html` the part after the label; the assembler gathers every line into one block
// after the others. `subject` is a subject line a section offers (the brief's top Next item): the first section
// offering one names the mail. `footnote` is ONE plain-text line the section asks for in the mail's footer (the
// brief's "paused" line, for an admin: owner ruling Q42).
export const Section = z.object({
  heading: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  deepLink: z.string().min(1),
  summary: z.string().optional(),
  linkLabel: z.string().optional(),
  layout: z.enum(["block", "line"]).optional(),
  subject: z.string().min(1).optional(),
  footnote: z.string().min(1).optional(),
});
export type Section = z.infer<typeof Section>;

// The data half of a registry entry: everything Settings/Maintenance need and
// everything the resolver validates a user pref against. `id` is the D1 key.
export const NotificationKindMeta = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    description: z.string().min(1),
    defaultCadence: Cadence,
    allowedCadences: z.array(Cadence).min(1),
  })
  .refine((k) => k.allowedCadences.includes("off"), { message: "allowedCadences must include 'off'", path: ["allowedCadences"] })
  .refine((k) => k.allowedCadences.includes(k.defaultCadence), {
    message: "defaultCadence must be one of allowedCadences",
    path: ["defaultCadence"],
  });
export type NotificationKindMeta = z.infer<typeof NotificationKindMeta>;

// A full registry entry: metadata plus the renderer. The renderer is a PURE
// READ over `ctx` (the Worker binds it to D1): no writes, no events, no GitHub.
// Returns null when there is nothing to say for this user in this window.
export interface NotificationKind<Ctx = unknown> extends NotificationKindMeta {
  render(ctx: Ctx, userId: string, window: Window): Promise<Section | null>;
}

// ── HTTP view DTOs (src/notifications/routes.ts ↔ web/src) ───────────────────

/** One Settings row: a kind the org has enabled, resolved for this user. */
export interface PrefsKindView {
  id: string;
  label: string;
  description: string;
  allowedCadences: Cadence[];
  cadence: Cadence;     // resolved (pref → policy → registry)
  orgDefault: Cadence;  // what "reset to default" resolves to
  inherited: boolean;   // no pref row
}
export interface PrefsView {
  email: string | null;
  unsubscribed: boolean;
  kinds: PrefsKindView[]; // ENABLED kinds only — a policy-disabled kind is absent, never greyed
  /** "Only when something needs me" (0067): a digest goes only when the brief has a Next item or a notable or
   *  breaking item touched the person's work. Per organization; false when never set. */
  onlyWhenNeeded: boolean;
}

/** One Maintenance policy row: registry metadata + the stored policy. */
export interface PolicyKindView {
  id: string;
  label: string;
  description: string;
  allowedCadences: Cadence[];
  registryDefault: Cadence;
  enabled: boolean;
  default_cadence: Cadence;
  updated_at: string | null;
  updated_by: string | null;
}
