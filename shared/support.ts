// The support contract with its zod request schema on top of the zod-free core (`./support-core`,
// the *-core.ts rule). `@shared/support` is the server's import path; the SPA imports the core.
import { z } from "zod";
import {
  SUPPORT_KINDS, SUPPORT_SUBJECT_MAX, SUPPORT_MESSAGE_MAX, SUPPORT_ROUTE_MAX, SUPPORT_VERSION_MAX, SUPPORT_USER_AGENT_MAX,
  SUPPORT_EMAIL_MAX, SUPPORT_EMAIL_RE,
} from "./support-core";

export * from "./support-core";

/** One line: control characters (CR / LF included) become spaces, runs of space collapse. */
const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
/** Attached context: one line, CUT to its cap (never refused), empty → null. */
const attached = (max: number) =>
  z.string().nullish().transform((v) => { const s = oneLine(v ?? "").slice(0, max); return s === "" ? null : s; });

/**
 * `POST /api/support`. What the person typed is REFUSED past its cap (they are told, and keep their
 * text); what was attached for them is cut. Unknown keys are dropped — above all `author`, `reporter`
 * or `handle`: the reporter is the session's person and nothing else.
 */
const typed = {
  kind: z.enum(SUPPORT_KINDS),
  subject: z.string().max(SUPPORT_SUBJECT_MAX * 2).optional().transform((v) => oneLine(v ?? "")).pipe(z.string().max(SUPPORT_SUBJECT_MAX)),
  message: z.string().max(SUPPORT_MESSAGE_MAX * 2).transform((v) => v.replace(/\r\n?/g, "\n").trim()).pipe(z.string().min(1).max(SUPPORT_MESSAGE_MAX)),
};
export const SupportSubmit = z.object({
  ...typed,
  route: attached(SUPPORT_ROUTE_MAX),
  org: attached(64),
  app_version: attached(SUPPORT_VERSION_MAX),
  user_agent: attached(SUPPORT_USER_AGENT_MAX),
});
export type SupportSubmitInput = z.infer<typeof SupportSubmit>;

/**
 * `POST /api/support/public` — the signed-out form. `email` is checked for SHAPE only (it is unverified
 * by definition); `page` is cut like any attached value; the honeypot and the time on the form are
 * read by the route, which answers a tripped honeypot like a success. The browser is not in the body:
 * the route reads the request's own User-Agent header and cuts it with `cutAttached`.
 */
export const SupportPublicSubmit = z.object({
  ...typed,
  email: z.string().max(SUPPORT_EMAIL_MAX * 2).transform((v) => v.trim()).pipe(z.string().max(SUPPORT_EMAIL_MAX).regex(SUPPORT_EMAIL_RE)),
  page: attached(SUPPORT_ROUTE_MAX),
  website: z.string().max(2000).optional(),
  elapsed_ms: z.number().finite().optional(),
});
export type SupportPublicInput = z.infer<typeof SupportPublicSubmit>;

/** A header-derived value (the User-Agent) as it is stored: one line, cut to `max`, empty → null. */
export const cutAttached = (v: string | null | undefined, max: number): string | null => {
  const s = oneLine(v ?? "").slice(0, max);
  return s === "" ? null : s;
};
