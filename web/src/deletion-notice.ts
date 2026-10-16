// What a page says after a deletion sends someone there (deletion-actions.ts): the parameter the address
// carries, and the sentence for each. Its own module so the signed-out landing (landing-page.ts) says it
// without the deletion's controller.
/** Where each deletion lands, and what the landing says (main.ts reads it once and drops it). */
export const DELETED_PARAM = "deleted";
export const DELETED_SENTENCE: Record<"account" | "org", string> = {
  account: "Your account has been deleted, and you are signed out.",
  org: "The organization has been deleted. Its members keep their Trov accounts.",
};
