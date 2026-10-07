// The mail sender's display NAME — the one rule, shared by the Worker (which builds the From header
// and validates `PUT …/notifications/settings`, src/notifications/resend.ts) and the SPA (which takes
// a name and shows the fixed address, web/src/notifications.ts). Zod-free and pure: the browser bundle
// imports it as values.
//
// The sending ADDRESS is the platform's — one provider account, one verified domain — and any org's
// admin can edit the setting, so an org contributes a display name and nothing else
// (docs/architecture/abuse-limits.md).

/** The platform's sender: the name an org with none of its own sends as, and the only address. */
export const PLATFORM_SENDER_NAME = "Trov";
export const PLATFORM_FROM_ADDRESS = "hello@trov.dev";
export const PLATFORM_FROM = `${PLATFORM_SENDER_NAME} <${PLATFORM_FROM_ADDRESS}>`;
export const SENDER_NAME_MAX = 64;

/** What a display name may contain: ASCII letters and digits, spaces and `. & ' + _ -`. No quote, angle
 *  bracket, comma, colon, semicolon, `@` or control character (nothing that ends the name or starts a
 *  header), and no non-ASCII letter (a look-alike of another name). */
const SENDER_NAME_CHARS = /^[A-Za-z0-9 .&'+_-]+$/;

export type SenderNameProblem = "empty" | "too_long" | "characters" | "reserved";

/** The display-name part of a stored / submitted `from_address`: what precedes `<`, or — with no `<` —
 *  the whole value unless it is an address. Surrounding quotes and spaces are dropped. */
export function senderNamePart(from: string): string {
  const lt = from.indexOf("<");
  const raw = lt >= 0 ? from.slice(0, lt) : from.includes("@") ? "" : from;
  return raw.trim().replace(/^"(.*)"$/s, "$1").trim();
}

/** Why `name` cannot be a sender name, or null. `reserved`: it reads as Trov's own voice ("Trov Security",
 *  "T.r.o.v") without being exactly the platform's name. */
export function senderNameProblem(name: string): SenderNameProblem | null {
  if (name === "") return "empty";
  if (name.length > SENDER_NAME_MAX) return "too_long";
  if (!SENDER_NAME_CHARS.test(name)) return "characters";
  if (name !== PLATFORM_SENDER_NAME && name.toLowerCase().replace(/[^a-z0-9]/g, "").includes("trov")) return "reserved";
  return null;
}

/** The problem as a sentence a person can act on. */
export const SENDER_NAME_HELP: Record<SenderNameProblem, string> = {
  empty: "Enter a sender name.",
  too_long: `A sender name is at most ${SENDER_NAME_MAX} characters.`,
  characters: "Use letters, digits, spaces and . & ' + _ - only.",
  reserved: `A sender name can't contain "trov" unless it is exactly "${PLATFORM_SENDER_NAME}".`,
};
