// The pages the GitHub App's install callback (`GET /github/app/setup`, src/github-app/install.ts) renders
// when it refuses. Server-rendered, not the SPA — GitHub sends the browser here, and a refusal must read
// the same whether or not the web bundle loads. They wear the OAuth pages' frame (src/auth/oauth-pages.ts):
// one card, a title, the reason, and a way back. Every dynamic value is escaped; none is ever a credential,
// a repository name the person cannot read, or another org's name.
import { esc, head, shell } from "../auth/oauth-pages";

/** Where a refusal links back to: the org's Repositories screen when the flow named an org the person
 *  belongs to, else the app's root (an unknown org, or one that is not theirs, is never linked). */
export const backTo = (slug: string | null): string => (slug ? `/o/${encodeURIComponent(slug)}/#org/repos` : "/");

/** A refusal: a titled card, a short explanation, and one button back. */
export function installRefusalPage(p: { title: string; message: string; slug: string | null }): string {
  return shell(p.title, head(p.title)
    + `<div class="err" role="alert">${esc(p.message)}</div>`
    + `<div class="stack"><a class="btn primary" href="${esc(backTo(p.slug))}">${p.slug ? "Back to Org settings" : "Open Trov"}</a></div>`
    + `<div class="foot">Nothing was connected. You can start again from Org settings › Repositories.</div>`);
}
