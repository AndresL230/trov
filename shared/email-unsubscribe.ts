// What "Unsubscribe from Trov email" stops, and what it does not: ONE wording, shared by the Worker (the
// `/u/<token>` confirm page, src/notifications/unsubscribe-page.ts) and the SPA (Settings › Email
// notifications, web/src/notifications.ts). Zod-free and pure: the browser bundle imports it as values.
//
// The flag (`persons.email_unsubscribed`) is per PERSON, across every organization. It stops every
// NOTIFICATION: the digests, daily and weekly (src/notifications/run.ts, re-checked by retry.ts), and the
// welcome (src/orgs/mail.ts). It does not stop TRANSACTIONAL mail, a one-off that answers something a
// person did: an invitation (the owner invitation too), the notice that an organization was given to an
// address or is paid for, and the test digest an admin sends to themselves. The per-kind table is in
// docs/architecture/notifications.md › Who gets what; keep the two in step.

/** The mail that still arrives after unsubscribing, in product words. */
export const STILL_SENT: readonly string[] = [
  "an invitation to join an organization",
  "a test digest you send yourself",
  "word that an organization you were given or paid for is ready",
];

/** `a`, `a and b`, `a, b and c`. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What unsubscribing stops, as one sentence. */
export const UNSUBSCRIBE_STOPS = "Stops every email digest, daily and weekly, in all your organizations.";

/** What still arrives after unsubscribing, and why, as one sentence. */
export const STILL_SENT_SENTENCE = `Still sent, because each is a one-off about something you or an admin just did: ${listWords(STILL_SENT)}.`;
