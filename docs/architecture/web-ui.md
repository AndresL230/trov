# Web UI: sidebar, motion, tabs and corners

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## A repaint REBUILDS a page unless the page opts out — the root cause of "it reloads when I type"

`rerender()` runs on every state change, **including every keystroke in a field**, and `paint()` (`web/src/morph.ts`)
replaces the page's DOM wholesale (`innerHTML`) unless it is one of: the `<aside>`, a root-level `data-overlay`
(a dialog), or a page that names itself with **`data-morph="<key>"`** — which is patched in place while the key
stays the same. A rebuilt page restarts every entrance animation, skeleton fade, `<img>` and iframe in it, and
anything decorative behind a form visibly "reloads" per letter. Focus and caret are restored, so the field
itself looks fine and the bug is easy to miss.

**Rule: a page that holds a form, a dialog's host page, or anything with a backdrop or an entrance sets
`data-morph` on its root** (a direct child of the theme root, or `<main>`). Opted in today: the signed-out landing page (`landing`; its sign-in and tour dialogs are `data-overlay`s), Org settings,
Platform, personal Settings (its name, handle and digest-address fields), the Artifacts screens, Review (its list is keyed: see "A row leaving a list" below), the three first-run pages (onboarding `onboard`, the org picker `orgs`,
the guided setup `welcome`), and the two payment cards (`billing-done`, `billing-checkout`). Inside a morphed page, a part that must be REPLACED when it becomes a different
thing (a tab's panel, a wizard's step) names itself with `data-morph-key`. Do not fix a flicker by turning
animations off in the affected region — that hides one symptom and leaves the rebuild.

**A third party's widget lives in a `data-keep` node of a morphed page.** `morph()` returns at once on an
element with `data-keep`: neither its attributes nor its children are touched. The payment page
(`web/src/billing-checkout.ts`, `data-morph="billing-checkout"`) mounts Stripe's embedded checkout — an iframe
Stripe creates and resizes — into `<div id="billing-checkout-mount" data-keep>`; a rebuilt iframe would reload
the form and lose what the buyer typed. Three things make that hold: (1) the node is emitted in EVERY state,
byte-identical, as the FIRST child of its container, so index pairing can never land something else on it;
(2) since morph will not sync its attributes, whether it shows is decided on an ancestor
(`[data-billco-phase="loading"] .cnpy-billco-mount { display:none }`), never on the node itself; (3) the
script mounts only AFTER the rerender that makes the node visible. The card around it has no height and no
`overflow:auto` — the widget sets its own height, the card grows, and the page scrolls
(`test/render.billing-checkout.test.ts`).

**A dialog that opens over ANY screen repaints itself alone.** Most screens are not `data-morph`ed, so a dialog
whose host page can be any of them cannot rely on the page's opt-in: a `rerender()` per keystroke would rebuild
whatever is behind it. The support dialog (`web/src/support.ts`: the header's bug button, Settings › Contact support, the site's Contact) is the
pattern: opening and closing are a `rerender()`; everything inside the open dialog goes through
`support-actions.ts` `repaint()`, which renders the dialog again and `morph()`s the live `data-overlay` element
in place — the page is not touched (check: `document.querySelector("main")` is the same element before and after
typing). It needs a STABLE structure while the form is up (an error or counter that comes and goes is always
emitted and shown by attribute; a different body, like the sent state, is a `data-morph-key`), and state stays
the one source of truth, so a rerender caused by anything else paints the same dialog. Details: `support.md`.

**First-run flow** (`people.ts` `onboardView` → `org-picker.ts` `orgPickerView` → `welcome.ts` `welcomeView`):
one card (`.cnpy-orgs-card`: banner, body, foot) in front of `firstRunBackdrop()` (`render.ts`: the real app
shell rendered from `initialState()`, so every region is its own skeleton; `inert`, `aria-hidden`). A step
gives way to the next through `morphStep` (`web/src/transition.ts`, View Transitions; the card carries one
`view-transition-name`, so cards of different heights grow into each other). Off under reduced motion.
**Who says what, once** (so the flow, the app and the Guide do not repeat each other): the three cards get a
person an account, an organization and a connected agent; the setup's closing step says how a first session
goes (`firstSession()`, three lines) and links the Guide; **Help › Guide** (`guideView`, `#guide`, titled "How
Trov works") is the REFERENCE — the skills, how a change is staged and confirmed, the tour of every screen,
accounts, connecting an agent, troubleshooting. It has no numbered "Step 1 / 2 / 3": a reader is already
signed in. The welcome e-mail links the guided setup, not the Guide. A new rule about signing in or
connecting goes in ONE of these and is linked from the others.

Inside an organization (the guided setup) the backdrop is the REAL My Work of the org on screen
(`firstRunBackdrop(s)`), read while the person is in the setup (`loadHome`); leaving the setup for My Work is a
`morphStep` with the page entrance skipped once (`skipEnterOnce`), so "Open Trov" removes the card and nothing
else moves or loads. Before there is an organization it is the app with nothing read (all skeletons).
The backdrop's skeletons are a picture, not reads in flight: `syncSkeletons` skips anything inside an `inert`
region. Because it is the app's own markup, every rule that animates a screen matches inside it —
above all the page entrance (`markEnter` sets `[data-enter]` on the root whenever the route changes, and each
step of the guided setup is a route) — so `.cnpy-fr-bg` turns animation and transition off for everything in
it. That is the cause of "the screen behind refreshes on every step", not a rebuild: check `getAnimations({
subtree: true })` on the backdrop after a step change; it must be 0. From the picker, an org just created or joined is entered IN PLACE (`enterNew` in `main.ts`) when the
page has held no other org's data; opening an org from anywhere else stays a page load.

## The signed-out site — one banner, carried through the page (`web/src/landing.ts`)

The landing page has ONE idea: the first-run card's purple banner is Trov speaking, and the product is the
card in front of it. `.site-banner` is defined WITH `.cnpy-orgs-banner` in `trov.css` (one rule: the gradient,
the radial highlight, the dot grid `::after`), so the site and the first run cannot drift; `.site-banner-art`
is the mark, large, faint and tilted behind the text. It appears exactly twice, at two scales:

| Where | How |
|---|---|
| Hero (`.site-hero-band`) | the banner as an inset panel; the Review mockup (`.site-hero-mock`) stands on its lower edge, inset by the same `--hero-pad` as the headline so their left edges align |
| "Agents propose, people decide" (`.site-split`) | the card on its side: banner left, body right; stacked under 860px |

The sign-in dialog (`.site-signin-card`) has NO banner: it opens over the hero, which is the banner, and a
second slab in front of the first read as the same thing twice. It is a plain card — the mark, the title, the
two providers as a narrow centred pair with an "or" rule between them, a foot. A bannered card has no border
(a border sits outside the banner and showed as a pale frame round it); its edge is a ring in the shadow.

Everywhere else the page stays quiet. The one echo is `.site-stage`: each tour mockup stands on a field of the
banner's dots in the page's own accent (purple on light, green on dark), mirrored on a flipped row. Do not add
a fourth banner or a second texture (the tour's dialog has none: its stage is the same dot field); a new section is plain unless it replaces one of the three.

- **Both themes.** The banner is the brand's purple on light AND dark (it is not the app's chrome); on dark it
  sits one step deeper so a slab that size does not glare. Text on it is white, buttons on it are
  `.site-btn-onb` (white) and `.site-btn-onb-line`.
- **No blur.** Everything above is static paint (gradients, masks, shadows): no `filter` and no
  `backdrop-filter` beyond the nav's own, so nothing repaints while the page scrolls. The hero's glow and the
  dialog's scrim are plain radial gradients.
- **A rerender replays nothing.** The page is `data-morph="landing"` and the dialog a root-level
  `data-overlay="signin"`: opening or closing Sign in patches the page in place. Check with
  `document.querySelector(".cnpy-site").getAnimations({ subtree: true })` before and after: no new entry.
  Keep the page's structure the same in every state (signed in or out changes attributes and text only).
- **Reduced motion:** the page is covered by `.cnpy-site *`; the two dialogs sit outside it, so each has its
  own rule (`.site-signin-*`, `.site-fx *`).
- **Motion** has ONE clock, on `:root`: `--fx-ease` (`cubic-bezier(0.4, 0, 0.2, 1)`, eases at both ends),
  `--fx-fast` .18s (leaving), `--fx-base` .24s (content, a step), `--fx-slow` .3s (a reveal, the card growing
  into its dialog, the backdrop). Anything new on the site reads these; do not write a literal duration or a
  second curve. The banner, the dots and the mark do not move.
- **Reveals** (`rv()` / `data-rv`, `landing-motion.ts`) are short and small: 6 to 14px over `--fx-slow`, played
  once (the observer unobserves), 6% of the viewport before the element enters. While a nav jump is carrying
  the page (`noteJump()` until just after `scrollend`), what comes into view is settled with no motion
  (`revealClass`), so a jump never ends on a section that is still sliding. **The hero's copy is the one
  exception**: the page's first words are never hidden — it is rendered settled (`is-done`, no `data-rv`) and
  rises by `translate` alone, in CSS from the first paint (`.site-hero-in .site-st`, `site-rise`), so it waits
  on no script. With scripting off, `@media (scripting: none)` shows every other reveal settled.
- **Nav jumps** (`siteJump`) are one `scrollIntoView` per click, instant under reduced motion; where one lands
  is the target's `scroll-margin-top` (`section[id^="site-"]`, -58px: the heading about 32px under the sticky
  nav). Nothing else moves the scroll position: both dialogs take and return focus with `preventScroll`.
- **Copy that is fact:** anyone can sign up with GitHub or Google, no invitation; the help page is the
  **Guide**; prices are never restated outside `shared/pricing.ts` (link `/pricing`).
- **Each thing is said once** (the table at the top of `landing.ts`): open sign-up under the hero's buttons;
  the propose / decide rule on the authority card, with every person-only verdict listed in Security; whose
  data it is and where the source is in the pricing Questions; the install commands and connect steps in the
  plugin card (from `mcp-connect.ts`, never retyped); a feature's detail in its dialog. A new sentence that
  repeats one of these is a link or nothing.
- Radii are inline (`border-radius:16px` on the band, `14px` on the cards) so the corners block scales them by
  value. Tests: `test/render.landing.test.ts`, `test/render.site-feature.test.ts`.

### The tour, explorable (`featureDialog` in `landing.ts`, `web/src/site-feature.ts`)

Each tour row's mockup opens its feature in a large dialog: name and promise, the screen itself drawn at the
dialog's size (`featureMock` in `web/src/landing-mocks.ts`; the row keeps its small teaser), three or four
statements from Help › Guide
(`TOUR_FACTS` — change them with the Guide; a test pins a phrase of each to `guideView`), and Previous / Next
through all seven (wrapping), with the position as text and dots.

- **State and paint.** `state.siteFeature` (`{ key, dir, mode }`) like `signInOpen`; the dialog is a root-level
  `data-overlay="feature"`, so `paint()` patches it and never rebuilds the page behind. Only `.site-fx-main`
  (`data-morph-key` = the feature) is replaced on a step. The panel has a FIXED size, so a step never moves or
  resizes the frame, the stage or the footer (measured: identical boxes across every step).
- **Opening and closing** (`fxMode`): `vt` — a View Transition; the card and the panel carry
  `view-transition-name:site-fx` on either side of one repaint (the name is on the card only for that repaint),
  the moving box clips its two faces and wears the panel's static shadow, and every rule is scoped to
  `html.site-fx-vt` so the first run's morph keeps its own timings. `css` — no View Transitions, or a hidden
  tab: a keyframe entrance (`data-in="css"`) and exit (`data-closing`, `FX_EXIT_MS`). `none` — reduced motion:
  instant. Closing shrinks into the card of the feature on screen when that card is in view, else it uses the
  keyframe exit. `data-in` never changes while the dialog is open, so no rerender replays the entrance.
- **A step** slides the titles, the mockup and the facts in from the side moved to (`data-dir`); it is CSS
  in every mode. `data-moving` (set and dropped by `site-feature.ts`) is the only place `will-change` is used.
- **Keys and focus.** Esc and the backdrop close; ← / → step; Tab cycles Close → Previous → Next; focus goes
  to Close on open and back to the row's Explore button on close. A row has ONE labelled control (Explore);
  the mockup is the same action for a pointer (`cnpy-hit`, `tabindex="-1"`, `aria-hidden`), so there is no
  button inside a button and no duplicate tab stop. The window's scroll is locked while it is open, with the
  scrollbar's width handed back as padding so the page does not shift.
- **Phone:** the app's modal sheet at full height; Previous / Next are 44px, at the bottom edge.
- **The dialog's mockups** (`landing-mocks.ts`) are drawn from the real screens, and that is their contract:
  a mock shows NOTHING the product does not have. The file's header names the renderer each one copies
  (`docsView`, `feedView`, `boardCard` / `tableView`, `timelineView`, the My Work tiles, `handoffsView` /
  `handoffDetail`, the artifact viewer); ticket and artifact statuses are imported from `shared/`, and
  `test/render.site-feature.test.ts` asserts every other label still stands in the module that renders it —
  so renaming a label in the app fails the test until the mock follows. They are inert (`aria-hidden`, no
  button, link or `data-act`), use theme tokens only (dark shows the dark app), and are never zoomed or
  scaled: real type at the app's sizes. Layout is `.fxm*` in `trov.css`: ONE box (`.site-fx-mock`, the
  stage's size, the same for all seven, so a step never changes the frame); stacked under 860px it is as
  tall as its content; under 640px the secondary panes (`.fxm-wide`) are dropped, not shrunk. Sample data
  is one fictional team across the page (Maya Chen, Leo Park, Sam Ortiz; tickets #205–#230; PR #142;
  ADR-0012; `acme/api`). When a real screen changes, change its mock and the page's teaser with it.

### For agents

Two cards whose content is naturally the same height at desktop width (`.site-agents-row`, 1.65fr / 1fr,
measured at 1440 and 1100); one column under 900px. The MCP card's count and chips are the server's own tool list
(`shared/mcp-tools.generated.ts`, in `MCP_TOOL_GROUPS` order) with a link to the reference; its two smallest groups
(Connection, Admin) share one row, which keeps it the plugin card's height (605 / 600px at both widths, 2026-10-12,
with 43 + 1 tools). The plugin card holds the skills, then `connectSteps()` and `CONNECTION_NOTE` from `mcp-connect.ts`,
whose line ends with a link to the other clients' setup (/docs/connect). (Settings › MCP access changes a connection in a dialog —
`grantScopeDialog` in `render.ts`, a root `data-overlay` in the `.cnpy-cmodal` shell, never a panel under the
row: `auth-identity-people.md`.) If a card's content shrinks, re-weight the columns or let the card be
smaller: never pad one out.

## The public pages, for crawlers (`shared/site-pages.ts`, `web/site-build.ts`, `src/site.ts`)

`/`, `/pricing`, `/terms`, `/privacy` and the docs (`/docs/setup`, `/docs/connect`, `/docs/concepts`,
`/docs/mcp-tools`, `/docs/changelog`) arrive as real HTML — their words, a unique title and description, a
canonical link, Open Graph and Twitter tags, JSON-LD on `/` and `/pricing` — before any script runs, and the
script then takes over the SAME markup. Everything else is the app, and is never indexed.

- **One list.** `SITE_PAGES` (`shared/site-pages.ts`) is every public page: path, `kind` (`landing`, `pricing`,
  `legal`, `docs`, `not-found`), title, description, Open Graph image, and its Markdown (`markdown`, below). Everything follows from an entry: the Vite input
  and its prerendered document (`web/site-build.ts` writes every input — there is no `.html` in `web/`), the
  head tags (`siteHead`), the `/sitemap.xml` line, the reserved org slug (`shared/orgs.ts` spreads
  `SITE_PAGE_SEGMENTS`), and the 301s for its other spellings (`_redirects`). **Adding a page** is one entry
  plus its content: a `kind` that renders it (a new legal document is a `legal` entry whose `key` is its key in
  `LEGAL_DOCS`; the legal pages' tab row names Terms and Privacy itself), and its 1200 × 630 image in
  `scripts/og/render.mjs`'s own list (an entry without `image` gets no `og:image` and a `summary` card).
  A reserved slug shadows any org already using it: check before adding a page at a new path.
- **Copy is the page's own.** A description is a sentence the page says (the landing's hero lede, a legal
  document's opening line); the pricing one and the JSON-LD offers are built from `PLANS` / `PRICING`, never
  typed (Free $0, Pro $10 per seat / month as a `UnitPriceSpecification`; Enterprise has no price, so no
  Offer; no rating or review, which Trov does not have). `test/site-pages.test.ts` holds each to the render.
- **Prerendered from the code that boots it** (`web/src/site-prerender.ts`, loaded in Node through Vite's own
  module server at build time). The landing is `render(initialState())` — exactly main.ts's signed-out paint —
  so its first paint MORPHS it (`data-morph="landing"`); `/pricing`, `/terms` and `/privacy` are `siteRoot(…)` of
  their boot script's own render and patch in place too (`paintRoot`, morph.ts). On the prerendered landing
  main.ts paints the landing at once and asks nothing: no "Signing you in…" card, no `/auth/me` (the Worker only
  sends that page to a request with no session cookie). Pages are built in the light theme; `THEME_BOOT`, an
  inline script that is each root's first child (and in the app shell's head), paints `<html>` and the root in
  the stored theme before the rest of the page is parsed; the boot's first paint drops it, and main.ts keeps
  `<html>`'s background in step (`syncPageBackground`).
- **`/` is two documents** (`run_worker_first = ["/"]`, `sitePublic` in `src/site.ts`): the prerendered landing
  to a request with no `session` / `onboard` cookie, the app shell (`web/app.html`, served at `/app`) to one
  with, after a refused sign-in (`?denied=`), or with the local `DEV_LOGIN`; both `Vary: Cookie`. The cookie's
  PRESENCE picks a public page; it authorizes nothing (no fourth auth class). The shell is never the home
  page's HTML: no landing words, no canonical, `noindex` in a meta tag and the header — at `/`, `/<org>/`,
  `/platform`, `/billing/done`, `/billing/checkout` and `/app` alike. (Before, all of those served `index.html`,
  byte-identical to `/`, with no canonical anywhere: the likely cause of Search Console's "Duplicate without
  user-selected canonical" on `/`.)
- **One address per page.** Every canonical is absolute and fixed in the file, so a query (`?ref=`, `utm_*`,
  `?contact=1`, `?start=team`) cannot change it. `_redirects` (generated, `assetRedirects`) sends `/index`,
  `/index.html`, `/<page>.html` and `/<page>/` to the page for good (301) — the binding's own html handling would
  answer 307. The Worker 301s `www.` and plain http on the public host to `https://` + the public host for what it
  serves (`canonicalRedirect`); the binding takes relative rules only, so the static files on www / http are the
  zone's to redirect (a Redirect Rule and "Always Use HTTPS" — `HANDOFF.md`).
- **`noindex`** (`X-Robots-Tag`): every GET / HEAD the Worker answers except `/robots.txt`, `/sitemap.xml` and
  the landing — the API, sign-in, OAuth, MCP, the signed links, every app shell, every redirect; a POST is left
  alone (a webhook's bare 401 stays bare). On a host that is not PUBLIC_ORIGIN's (a Preview) the Worker tags
  everything, and `_headers` (`assetHeaders`) tags every static file on a `*.workers.dev` address, plus `/app`
  and `/404` anywhere. Loopback counts as the public host, so `wrangler dev` answers as production does.
- **robots.txt** disallows only the API, sign-in and token endpoints and the session-gated bytes
  (`ROBOTS_DISALLOW`). The app's pages are deliberately NOT disallowed: a crawler that may not fetch a URL
  never sees its `noindex` (nor that it is no longer the home page's HTML), and a disallowed URL can still be
  indexed from a link. `/sitemap.xml` is `SITE_PAGES`' indexed pages by canonical URL.
  **Crawlers by name** (`src/site.ts`): a crawler that matches a group by name obeys ONLY that group and
  ignores `User-agent: *` (RFC 9309), so every named group repeats the `*` group's Disallow lines, then
  `Allow: /` — Disallow first, because Python's `urllib.robotparser` takes the first matching line, not the
  longest. `SEARCH_CRAWLERS` (allowed): OAI-SearchBot + ChatGPT-User, Claude-SearchBot + Claude-User,
  PerplexityBot + Perplexity-User, Googlebot, Bingbot, Applebot, DuckAssistBot — one group per operator, each
  agent named once. `TRAINING_CRAWLERS` (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot) follow
  ONE switch, `AI_TRAINING_CRAWLERS`: `"allow"` (the default — what they had through `*` before) gives them the
  same rules as everyone, `"disallow"` gives them `Disallow: /` and leaves search untouched. Flipping it is a
  one-line change and a deploy. The file's comments point at the docs and `/llms.txt`.
  What can still block a crawler outside the repo (Cloudflare's AI Crawl Control, its managed robots.txt, Bot
  Fight Mode, WAF rules) is `HANDOFF.md` › 10.
- **404.** An address no route answers is the built not-found page (`web/src/not-found.ts`, no script), status
  404, `noindex` — JSON `{ error: "not_found" }` under `/api` or for any other method — decided in
  `src/index.ts` BEFORE the session gate by `isAppRoute` (`src/routes.ts`: every handler of the Hono app by
  method and path; its `use()` middleware wildcards make nothing known). A real cookie route still answers 401
  signed out. One exception, on purpose: a single path segment that is a valid, unreserved slug (`/blog`) is
  an org's page and gets the app shell (with `noindex`) whether or not that org exists — answering 404 there
  would tell a stranger which organizations do.
- **The shared head** (`documentHtml`) links nothing off-site: the icons, and `FONT_PRELOAD` (Geist latin,
  self-hosted — "Fonts" below). The build also writes `/fonts/` (the fonts' stable copies) beside `_redirects`
  and `_headers`.
- Tests: `test/site.test.ts` (the Worker: robots and its named groups, sitemap, `/`, `/docs`, redirects,
  `noindex`, 404 vs 401, reserved slugs), `test/site-pages.test.ts` (the list, the head tags, the JSON-LD, the
  documents, the docs and their Markdown, llms.txt, the FAQPage, `_redirects` / `_headers`), `test/spa-shell.test.ts`, `test/render.fonts.test.ts` (no third party in any document).

## Docs for people and agents (`/docs/<page>`, their Markdown, `/llms.txt`)

The public docs are five `docs` pages of `SITE_PAGES`: Setup, Connect a client (copy-paste MCP config per
client and an AGENTS.md / CLAUDE.md snippet), Concepts (the authority model), MCP tools and Changelog.

- **Where.** Under `/docs/<page>`. `/docs` ITSELF is the app's cookie route — the cut-over alias of an
  organization's docs list, which old clients and the SPA's fetch still call — so there is no page at
  `/docs` and no `docs.html` or `docs/index.html` (either would make the assets binding answer `/docs` before
  the Worker). `src/site.ts` `docsEntry` sends `/docs/` (no route) and a BROWSER's signed-out `/docs` (it
  accepts `text/html`, no session cookie) to the first page with a 302; a fetch, anyone signed in and every
  other method still reach the route exactly as before. `docs` was already a reserved org slug.
- **One text per page.** Each page is ONE Markdown string (`web/src/docs-content.ts` `docsMarkdown`):
  `# title`, the lede (= its `description`, word for word), an optional intro, `## ` sections. The build serves
  it at `markdown` (`/docs/<page>.md`, `text/markdown; charset=utf-8`, with an HTTP `Link: <page>; rel=
  "canonical"` so search engines index the page, not its source) and RENDERS the HTML page from it
  (`web/src/docs.ts`: marked, with raw HTML escaped, `## ` → a `.site-legal-sec`, the contents list from the
  `## ` headings, a tool's heading anchored by its own name). The page's `<head>` links it as
  `<link rel="alternate" type="text/markdown">`. Links to the site are absolute in the Markdown and relative on
  the page. The docs borrow the legal pages' layout (`.site-legal-*`) and add `.site-docs-*` for code blocks
  (with Copy), tables and subsections; their script (`docs-page.ts`, ~2 KB) only flips the theme, copies, and
  follows the contents — it never repaints, so the client bundle carries none of the docs' text.
- **Nothing typed that can drift.** The endpoint is `SITE_ORIGIN`'s, the plugin commands are
  `mcp-connect.ts`'s, prices and limits are `PLANS` / `PRICING`, the changelog is `releases.ts`'s `highlights` and
  `headsUp` only (never `ops` or `patches`, never an `unreleased` entry), and the MCP reference is GENERATED:
  `web/site-build.ts` first loads `src/mcp-catalog.ts` in Node (Vite's SSR loader, `agents/mcp` stubbed — the
  transport adapter is not part of registration), which builds the real server for an admin and a member
  (`catalogTenant`: no org, no database) and lists `tools/list` through the SDK's client; the result is written
  to `shared/mcp-tools.generated.ts` (only when it changed) BEFORE anything reads it. The landing's MCP card (its
  count — "43 tools, plus 1 admin-only" — and its chips) reads the same file, grouped by `MCP_TOOL_GROUPS`
  (`shared/mcp-tools-core.ts`). **A new or changed tool**: `npm run build:web` rewrites the file, and a new tool
  needs a line in `MCP_TOOL_GROUPS`; `test/mcp-catalog.test.ts` fails on either until done.
- **Client configs** (Connect): Claude Code (plugin, and `claude mcp add --transport http --scope user`), Claude
  Desktop / claude.ai (custom connector), Cursor (`mcpServers.url`), VS Code (`servers` + `"type": "http"`,
  `inputs` for a token), Codex (`[mcp_servers.trov]`, `codex mcp add --url` / `codex mcp login`,
  `bearer_token_env_var`), Windsurf (`serverUrl`), and a generic block. Checked on 2026-10-12: Codex against its
  source (`openai/codex`), VS Code against `microsoft/vscode-docs`, Claude's connectors against Anthropic's help
  centre (search results); Cursor and Windsurf from third-party guides (their docs sites were unreachable).
  Trov's OAuth server takes only https and loopback-http redirects, so the page says an older Cursor (`cursor://`)
  cannot sign in. Recheck these when a client changes its format.
- **llms.txt** (`web/src/llms.ts`, llmstxt.org): `# Trov`, a one-line `>` summary, a paragraph of context, then
  `## Docs`, `## Pricing`, `## Changelog`, `## Optional` — links to the Markdown versions, each with its page's
  description. **llms-full.txt** is that head plus every Markdown page in full (with its source URL). Both are
  static files written by the build (`text/plain; charset=utf-8` by `_headers`), so the assets binding serves
  them before the Worker, with no session check. `/pricing.md` is `pricingMarkdown` (`pricing.ts`): the same
  tables and questions as the page.
- **The landing's FAQ** is the Questions accordion (`pricingSection`'s `lead`): the product questions
  (`web/src/site-questions.ts`: what Trov is, README / wiki, MCP clients) before the pricing ones (`pricingQuestions`,
  which now also answers what Pro adds — from the two plans' tables — and whether you can run Trov yourself: AGPL,
  Cloudflare Workers + D1 + R2, no self-hosting guide or support). The landing's head carries that SAME list as
  schema.org `FAQPage` (`faqPageLd`, passed to `siteHead` by the prerender); `/pricing` shows part of it unmarked,
  since a question is marked up on one page only.
- **The home page's first words** (after the nav) stay the hero: "Shared memory for your team and its coding
  agents." and its one-sentence lede — what Trov is, who it is for, and how it behaves (a test holds this).
- Tests: `test/site-pages.test.ts` (each page's Markdown shape; every heading, code block and paragraph of the
  Markdown on the page; raw HTML escaped; the reference against the generated list; the changelog without ops or
  patches; llms.txt's format; the FAQPage against the visible accordion), `test/mcp-catalog.test.ts` (the
  generated list against the live registration), `test/site.test.ts` (`/docs` and robots).

## Errors an agent can act on (`shared/error-hints.ts`, `src/error-hints.ts`)

Every JSON error the Worker answers, and every MCP tool error, carries a `hint`: what went wrong and what to do
next. Nothing else changes — the `error` code, any `message`, the status and the headers stay exactly as they
were (the SPA and the tests read them).

- **One table** (`shared/error-hints.ts`): `API_ERROR_HINTS` by the HTTP `error` code (the older sentence codes —
  `"admin only"`, `"not found"`, `"invalid payload"` — included), `STATUS_HINTS` by status for any other code,
  `MCP_ERROR_HINTS` by an MCP tool error's `code` (`not_found`, `forbidden`, `conflict`, `bad_request`,
  `too_large`, `gone`, `plan_limit`, `plan_feature`, and the connection's `repo_required`, `not_connected`,
  `ambiguous_org`, `org_unavailable`, `org_not_allowed`), and the two /mcp 401 hints. The MCP reference prints the
  MCP table, so the docs and the server say the same words.
- **Chosen by code and status ALONE** — never by the path, the id, the caller or anything read — so two answers
  that were byte-identical stay identical (an unknown id and another organization's; a missing org and one you
  are not in: invariants 4 and 12), and a hint names no organization, slug or secret (`test/error-hints.test.ts`).
- **HTTP**: `withErrorHint` (`src/error-hints.ts`) is applied in `src/index.ts` to what the Hono app, the artifact
  upload / download token routes and the 404 answer: a JSON object with a string `error`, status ≥ 400, no
  `hint` yet, not a HEAD — the body is re-written with `hint` added, every header kept (but the length). A
  webhook's bare 401 and the unsubscribe POST are NOT passed through it. `/mcp`'s 401 (`mcpUnauthorized`) carries
  its own hint: how to sign in, or (a refused token) what a refusal can mean — the same words for every token.
- **MCP**: every tool error goes through `toolError` in `src/mcp.ts` (`runTool`, the connection's scope refusals,
  the plan's agent-connection refusal, `update_plan` for a non-admin, a lost `claim_handoff`). `get_ticket` and
  `get_sprint` now throw a coded `not_found` (their sentence unchanged). The SDK's own input-validation error
  (`MCP error -32602: Input validation error: …`, before a tool runs) is left as the SDK writes it: it already
  names the argument, and its text is private to the SDK. The MCP server has no rate limit.
- A new error code gets a line in the table if it needs more than its status's hint.

## Sidebar & motion — the `<aside>` outlives rerenders

`rerender()` swaps the app wholesale, which is fatal for a transition: a width, a rotating chevron or an
opening sub-page list can only animate on an element that SURVIVES the state change. So `web/src/morph.ts`
`paint()` patches the `<aside>` in place and swaps only `<main>` (the seam is `.cnpy-shell`). That only works
because **the sidebar's structure is stable** (`web/src/sidebar.ts`): every label, badge, dot, chevron and
sub-page list is ALWAYS emitted, and collapsed / open / active are attributes and classes that `trov.css`
animates (`data-collapsed`, `.cnpy-sub[data-open]`, `.is-active`, `data-n="0"` hides a badge). Emitting a
node conditionally there swaps it out from under its own animation — `test/render.sidebar.test.ts` pins the
element tree across every state. `data-keep` marks a script-owned node (the collapsed-rail tooltip) the
patcher leaves alone. A sub-page list the app opened on entry folds again on leaving; one opened by hand
sticks and is what persists (`trov.navOpen`). Only **Docs** owns a sub-page list (`NAV_GROUPS`);
Roadmap, Tickets, Unplaced and Repo are plain rows (Tickets' switch sits in its screen header; Roadmap's
and Repo's tabs head their page body), and a stored
`trov.navOpen` key for a retired group is ignored on load. Below 900px the rail renders collapsed (`state.narrow`)
without touching the saved preference. Search is the box at the top of the rail (⌘K / Ctrl+K), not a nav row.

**Report a bug is the app header's icon button**, beside the theme toggle and its twin (`bugBtn` in
`render.ts` `appHeader`: the same `cnpy-iconbtn`, 32px, 40px at phone width with the rest of the cluster),
on every screen the header shows on. **Contact support is a tile of personal Settings** (`helpSection`,
`.cnpy-set-help`: a slim tile on a row of its own after Email notifications, before Session in DOM order so
Sign out stays last when it folds). Neither is in the sidebar, whose Help section is Guide and What's new;
the rail's rows and its short-window steps are unchanged. Both carry `data-support-trigger`, so focus
returns to them when the dialog closes (`support.md`).

**Widths.** The rail is **228px** expanded and 64px collapsed (`.cnpy-aside` in `trov.css`; the phone drawer has
its own, `min(292px, 100vw - 48px)`). 228 was measured, not chosen by eye (2026-10-08, was 244): the row that
runs out first is `Prompt Library` with its count, which truncates under 223px with a one-digit count and under
227px with a two-digit one, so 228 keeps every label, badge, the search box's shortcut hint and the account chip
whole. Nothing else stores the number: `<main>` is the flex remainder, the collapsed tooltip and the org menu are
placed from the rail's left edge, and the quick-search dropdown is anchored to the search box. Before narrowing
it again, shorten that row or re-measure.

**The org switcher fills the rail's row** whatever the organization is called (`.cnpy-orgsw-b` `width:100%`;
the owner ruled out sizing it to the name) and its name truncates. **The menu it opens is narrow**: `.cnpy-orgmenu`
is 248px, anchored to the rail's left edge; at phone width it spans the screen.

**A pick-one with no room for a switch is `dropdown()`** (`web/src/dropdown.ts`), never a native `<select>`:
the trigger where the control sits, its menu a root-level overlay (`dropdownMenu`, the same props) that opens
and closes with an animation — Org settings' role and Notifications pickers.

**Every pick-one switch is `segmented()`** (`web/src/segmented.ts`) — the Feed view, the queue's
Board/Table and All/Open/Closed, Repo ranges and environments, an artifact's status, Review's filter (with counts) and its diff mode, form segments. Never
hand-roll a segment group. It picks a VALUE or a view; moving between a page's own SECTIONS is the **underline
tab bar** instead (`tabBar()`, `web/src/tabs.ts` — Org settings' and Platform's tabs, patched in place so a switch replaces
only the panel (`web/src/morph.ts` `data-morph` / `data-morph-key`); the Roadmap's Narrative / Timeline, `roadmapTabBar` in `render.ts`, the Timeline
tab carrying the red overdue dot, in the same page frame on both tabs — `asideColumns`' optional `tabs` heads
the Narrative's two columns with it — and New sprint staying in the header; the Repo dashboard's Overview / Code /
CI & Deploys / Usage / Team & Planning, `repoTabBar`, in every state of the dashboard, its switch `setRepoTab`
flashing the new tab's content in place of the entrance): text tabs at the top of the page BODY on a full-width hairline that is the line
between the tabs and the content, the picked tab marked by a 2px accent underline on that line, 40px tabs (a
badge never makes one taller), a row that does not fit scrolling inside the bar, `role="tablist"` / `"tab"` +
`aria-selected` with a roving tabindex and `tabPanelAttrs` on the panel, ←/→ and Home/End (`onTabBarKey`, which
activates the tab it lands on). Its underline slides by the same FLIP, `syncTabBars` beside `syncSegments`
(keyed by the bar's `id`, no slide for a bar new to the screen, none under reduced motion), and a screen whose
tabs are in its route leaves them out of `markEnter`'s key so a switch never replays the entrance. Its picked fill is ONE indicator that slides between options: `rerender()` swaps
`<main>`, so `syncSegments` (run after every paint, and without a slide on resize / font load) remembers each
switch's indicator box by its stable `id` and plays the slide old → new (FLIP); a switch new to the screen
does not slide in. Sizes `md` (header) / `sm` / `xs`, plus `cnpy-seg--bar` (a 34px toolbar row) and
`cnpy-seg--wrap`. Two-state colored toggles (an artifact's visibility) and chip pickers are other idioms.

Screen entrances are `[data-enter]` (set by `markEnter()` in `main.ts` only when the ROUTE changed — never
on a keystroke, and never because a read landed: see Loading skeletons below). `--enter-t` is a NEGATIVE animation-delay, so a rerender
mid-entrance joins the animation where the old DOM left off. Hooks: `.cnpy-rise` + `--i`, `.cnpy-stagger`
(lists), `.repo-bar` / `.repo-fill` / `.repo-spark`, `data-count` (count-up). In-place changes use the
one-shot `pendingFlash`. All of it is off under `prefers-reduced-motion`.

## A row leaving a list — the one exit pattern (Review's queue)

When a person acts on a row and the row should go (a verdict in Review today; the next screen that
removes a row reuses this, it does not invent another), the row **confirms, collapses, and the rows
under it move up as the same elements**. Four parts, each in one place:

1. **A keyed list** (`web/src/morph.ts`). The screen is `data-morph`ed, the list's container carries
   **`data-morph-list`** and every child a **`data-morph-key`**. `morph()` then pairs that container's
   children by key, not by index: a child still in the list is patched (never moved unless the order
   really changed, since a moved element drops its running transition), a new one is inserted where
   it belongs, a gone one is removed. Without it a row removed from the middle turns every row after
   it into its neighbour and nothing can animate. Children are joined with no whitespace between
   them; a row's own structure is the same in every state (the selection bar and the verdict label
   are always emitted, shown by `aria-current` / `data-verdict`).
2. **State, not DOM, says a row is leaving.** `state.reviewLeaving[id] = { verdict, gone }`. While
   `gone` is false the view still renders the row, with `data-verdict` and `inert`; the selection
   and every count already leave it out (`reviewView`'s `waiting`, `triageCounts`). After
   `REVIEW_EXIT_MS` the entry flips to `gone` and the row is no longer rendered. The entry only
   HIDES rows of the reads, so it is never a second source of truth: the refetch replaces the reads
   and the entry is dropped (`settleReview`, `pruneReviewLeaving` in `main.ts`).
3. **CSS does the motion** (`trov.css` `.cnpy-rv-row`). The row is a one-track grid around its card:
   `grid-template-rows:1fr` to `0fr` collapses it with no measuring, the inner box clips
   (`min-height:0`, `overflow:hidden` only while leaving, so a card's hover shadow is never cut).
   The verdict shows for .13s (the card tinted with the verdict's tone, its content dimmed, the word
   over it), then height and opacity go over `--fx-fast` on `--fx-ease`: .31s in all, under the
   350ms budget. The transition sits on the base rule with no delay, so a row that comes back opens
   at once. `--fx-ease` / `--fx-fast` / `--fx-base` / `--fx-slow` are on `:root`, so they are the
   app's clock as well as the site's; use them, never a literal curve.
4. **The write is optimistic and exactly restorable.** The request goes out on the click and the
   next action is never blocked: the selection has already moved to the next row, so several
   verdicts in a row just work (a verdict button that had focus hands it to the next item's,
   `syncReviewDetail`). On failure the entry is deleted, so the row, the counts and the selection
   it had are back, with the usual error toast. The refetch is held until no row is still
   collapsing, so a read landing mid-exit never pulls a row out from under its own animation.

Also part of the pattern: the **last** row leaving already has the screen's empty layout under it
(`emptyLayout`, a keyed child of the same list), which rises as the row collapses, so there is no
jump; and **reduced motion** means no movement at all: `main.ts` marks the row `gone` at once and
the CSS has `transition:none`. Away from the screen that shows the list (My Work's review tile
uses the same acts) the row is `gone` at once too. Check it with `getAnimations()` on the row (two
transitions, 180ms each, 130ms delay), by sampling the row's height per frame, and by clicking
several verdicts 90ms apart. Tests: `test/render.review.test.ts` (the keyed list, the verdict
markup, the CSS and its reduced-motion rule, `REVIEW_EXIT_MS` against `--fx-fast`).

**Review's page** is named once, by the app header (as every screen is: `org-ui.ts` rule 1); the
list pane starts with one line (`REVIEW_INTRO`) and the filter. All / Proposals / Decisions is a
`segmented()` switch (one list, three views of it; not a tab bar, since nothing below changes
section) whose options carry how many are waiting (`.cnpy-seg-n` in an option's `trail`; left out
while the queue is still being read). Unified / Side by side / Rendered is a second one; the diff
body under it is keyed by mode (`diff:<mode>`) and the detail body by item (`rvd:<id>`), so a
switch replaces only that part. **Rendered** (`web/src/review-rendered.ts`) is the Docs reader's
rendering, never a second renderer: the proposal's two bodies go through `renderMarkdown` in
`.cnpy-md`; an edit is cut into marked's top-level blocks (`md-blocks.ts`), compared, and each
changed block sits in an `<ins>` / `<del>`; a table is compared row by row and a list item by item;
a new doc is rendered whole, unmarked, under one note. Body text reaches the page only through
`renderMarkdown` (`test/render.review-rendered.test.ts`). Unified and Side by side show source.
Where a block was EDITED rather than replaced, the two renderings are merged word by word
(`web/src/html-words.ts` `mergeInline`): one block (`data-chg="mix"`, an amber rule) or one table row
(`tr.cnpy-rv-row-chg`), with the added words in `<ins class="cnpy-rv-w">` and the dropped ones in
`<del class="cnpy-rv-w">`. Its safety rule is the one to keep if this is ever touched: **a tag is ONE token,
quoted attribute values included** (a wrapper written inside an attribute would close the value with its own
quotes and let the rest be parsed as elements), only text tokens are wrapped, no tag of the old rendering is
kept, and markup the tokenizer cannot account for refuses the merge (the two blocks are then shown whole).
More than 60% of the words changed is two texts, not one edited: also shown whole. A strike is set ONCE, on
the removed box — never again on an inline child, which draws a second line.

## Personal Settings — a bento whose tiles are as tall as what they hold

`#settings` (`settingsView` in `render.ts`, the Plan / Limits / Organizations tiles in `settings-plan.ts`) is
ONE grid of twelve columns (`.cnpy-set`, a container: its folds follow the page's own width, not the
viewport's). The grid still stretches — every edge lines up — so what keeps a tile from looking stretched is
**which tiles share a row: ones whose content is naturally the same height**. A tall tile never spans rows
beside short ones (the old MCP tile did, and Profile and Account were padded out to it).

| Row | Tiles (columns) |
|---|---|
| 1–2 | Profile (4) · Account: sign-in methods (4) · Session (4) over Appearance (4) |
| 3 | Plan (5) · Limits (7) — both grow with what the plan has to say |
| 4 | Organizations (12): a card per org, as many across as fit |
| 5 | MCP access (12): the steps beside Connected apps |
| 6 | Email notifications (12) |
| 7, 8 | Help (12), then Delete account (12): slim tiles of their own |

- Each tile is placed by NAME (`.cnpy-set-profile`, `-account`, `-session`, `-appear`, `-plan`, `-limits`,
  `-orgs-tile`, `-mcp`, `-email`, `-help`, `-delete`); DOM order is the folded order — Profile, Account, Plan, Limits,
  Organizations, MCP access, Appearance, Email, Help, Delete account, Session. Below 1000px of page: Profile | Account, every other
  tile full width; below 760px one column, **Sign out last**.
- **Delete account** (`web/src/deletion.ts` `accountDeleteTile`): one sentence, the quiet destructive trigger
  (`dangerTrigger`) — or, when a guard rail stands in the way (`organizations.md` §8), its sentences as a list and
  a disabled button `aria-describedby` them. Never blame: it says what to do first.
- **Sign out** is the Session tile's: a labelled button with its icon, at the top right of the page. It is the
  only `signOut` on the screen, and never a quiet link.
- Adding a tile: give it a row partner of the same natural height, or its own row. Measure (`align-self:start`
  on a tile gives its natural height) at ~1440 and ~1100 before choosing; a field in a wide tile takes a
  `max-width` (`.cnpy-set-name`).
- A limit's meter (`.cnpy-meter`) is a 4px bar with no radius, no animation and no transition, described once
  by its `role="meter"`; the page is `data-morph="settings"`, so typing in a field patches it in place.
- Tests: `test/render.connect.test.ts` (the grid, Session, sign-in methods), `test/render.settings-plan.test.ts`.

## A typed confirmation — irreversible deletions (`web/src/confirm.ts`, `web/src/deletion.ts`)

Deleting an account or an organization confirms in THE confirmation modal (`confirmModal`, the same root-level
`data-overlay`, keyboard contract and exit), with four optional props that a plain delete never uses (without
them the markup is byte-for-byte the old dialog): `detail` (what is deleted, what is kept and why, as a list —
the sentences of `shared/deletion-core.ts`), `typed` (a LABELLED field the handle or slug is typed into; it, not
the red button, takes the focus on open, and the button stays `disabled` until it matches, case and outer
spaces aside — Enter in the field confirms only a match, the reducer re-checks, the server re-checks), `error`
(`role="alert"`, the server's sentence) and `wide` (`.cnpy-cmodal-box--wide`, 540px, scrolling inside the window
on a short screen). The field has a visible focus ring (`.cnpy-cm-typed .cnpy-input:focus-visible`), and the
modal's Tab trap includes it (`main.ts`). Where it opens: Settings (the person), Org settings › General (an
owner — a quiet `dangerLink`, Org settings' rule for a destructive act), Platform's organization page and
Admins › Accounts (a superadmin). Each repaints with a plain `rerender()`: all three host pages are
`data-morph`ed, and the overlay is patched in place, so typing keeps the focus. Tests:
`test/render.deletion.test.ts`.

## Full pages without the sidebar

Three views render outside `.cnpy-shell`, on the picker's frame (`.cnpy-orgs` / `.cnpy-orgs-col`: one calm
column, the window scrolls): the org picker, the Platform page, and the **guided setup** (`#welcome`,
`web/src/welcome.ts` — an in-org SCREEN, so its hash route, overlays and `[data-enter]` entrance work as on
any other). The setup's step indicator is its own small pattern (`welcomeStepper`): an `<ol>` of buttons,
the step on screen `aria-current="step"`, a check only on a step whose done-state was READ (a step whose
read is out keeps its number and says "not known yet"), and at phone width only the current step keeps its
label. It is not a tab bar and not a segmented switch: a step is a page of the flow, and each has its own
route. Its rules declare no radius (every one is inline), and its one moving part — the waiting dot — is
still under `prefers-reduced-motion`. Tests: `test/render.welcome.test.ts`.

## Loading skeletons — the shape of what is coming (`web/src/skeleton.ts`)

A screen that waits on a read never paints a bare "Loading…" line and never paints its empty state early: it
paints a **skeleton** — the content's own containers, paddings and line boxes with muted bars where the text
will be — so nothing moves when the read lands. The rules:

- **ONE helper.** Every skeleton is composed from `web/src/skeleton.ts`: `skBar` / `skBox` (a bar, a block),
  `skLine(width, fontSize, lineHeight)` (reserves the REAL line box, so pass the real text's size), `skLines`,
  `skRow`, `skList`, `skCard`, and the composites `skRows` (a settings list), `skForm`, `skTable`, `skProse`,
  `skDetail` (one item's page). Never hand-roll skeleton markup in a screen module, and never give a bar an
  inline radius or colour — `.cnpy-sk` owns both (its radius has its line in the corners block).
- **`skeleton(key, label, inner, style?)` is the wrapper**: `aria-busy="true"` on the region, the bars inside an
  `aria-hidden` box, and `label` — the loading sentence the screen used to show ("Loading feed…") — kept as an
  `.cnpy-sr` `role="status"` line. `key` names the region and must be UNIQUE on the screen (the Repo dashboard
  numbers its sections per paint).
- **In the real frame.** A skeleton sits inside the screen's actual wrappers and beside its real chrome (the
  queue's toolbar and board columns, Review's header and filter, the Roadmap's and Repo's tab bars, a My Work
  tile's header, an aside box's title row). A view that owns its chrome takes a `loading` prop (`queueView`,
  `reviewView`) rather than being replaced by a stand-in page.
- **One region per read.** Where a screen has several reads (My Work's tiles, the Feed's and Roadmap's aside
  boxes, Repo's sections, Org settings' lists), each region has its own skeleton and fills on its own.
- **Only for "not loaded yet".** Loaded-and-empty is an EMPTY LAYOUT (below), a failed read keeps its error, and a
  refetch keeps the content already on screen (Search keeps its results while a new query is out). A view that
  takes only a slice's `data` cannot tell the two apart — pass it the status (`outboxLoading`, `loading`).
- **Motion** (trov.css `.cnpy-skel`): the bars stay invisible for the first 150 ms (`SKEL_DELAY_MS` — a fast read
  never shows a skeleton), then fade in and pulse. `syncSkeletons(mount, scope)` runs after every paint: it keeps
  each region's clock by `key` and hands it to the fresh DOM as a negative delay (`--skel-t`, as `--enter-t` does
  for the entrance), and when a region's skeleton is gone it gives what stands in its place ONE short opacity fade
  (`.cnpy-settle`, 240 ms) — only if the skeleton had actually been visible. A change of page forgets every clock.
  All of it is off under `prefers-reduced-motion`.
- **The entrance belongs to the route.** `markEnter` plays the staggered entrance once, when a page opens — over
  the skeleton if the data is still out. A read landing inside it joins it (`--enter-t`); one landing later gets
  the settle fade, never a second entrance.
- Left as text on purpose: the Sync panel's "Checking the last sync…" (a popover's status line), the quick-search
  dropdown's "Searching…" (it has its own pause rule), and the artifact attach dialog's "Loading tickets…".
- Tests: `test/render.skeleton.test.ts`.

## Empty layouts — the screen's own shape, drawn empty (`emptyLayout` in `web/src/skeleton.ts`)

A screen that has LOADED and holds nothing never collapses to one centred line: it keeps its real chrome
(header controls, toolbar, columns, tile grid, tab bar, section headings) and draws its content's shape
empty, so a brand-new organization can see what the screen is for. The rules:

- **Skeleton vs empty layout — which one.** A read that is OUT is a skeleton (`skeleton()`: `aria-busy`,
  `data-skel`). A read that ANSWERED with nothing is an empty layout (`emptyLayout()`: `data-empty`, no
  `aria-busy`). A filter or search that hides everything is neither: it says "nothing matches" (the queue's
  `queueNarrowed`; the Feed's author / tag; the Prompt Library's and Artifacts' "No … match"). A failed read
  keeps its error. Never paint an empty layout before the read lands (see "Only for not loaded yet" above).
- **ONE helper.** `emptyLayout(key, { text, action, shapes })`, with `emptySay` / `emptyShapes` for a screen
  whose sentence and shapes sit in different containers (the board's columns, Review's two panes). Never
  hand-roll a dashed "nothing here" card in a screen module. Org settings' `orgEmpty` and Platform's
  `emptyCard` are thin wrappers over it.
- **One sentence, one action, per region.** `text` says what appears here and how it gets there, in the
  Guide's words where the Guide says it (`guideView` in `render.ts`); the sentences are exported constants
  beside their screen (`QUEUE_EMPTY`, `FEED_EMPTY`, `ROADMAP_EMPTY`, `MW_EMPTY`, `HANDOFFS_EMPTY`,
  `PROMPTS_EMPTY`, `ARTIFACTS_EMPTY`, `REVIEW_EMPTY`, `UNPLACED_EMPTY`, `REPO_EMPTY`, `TIMELINE_EMPTY`).
  It claims only what the read proved: "Tickets show here…", never "your team has no tickets" under an
  Open / Closed switch. `action` is the one act that makes the first item, offered exactly as the screen's
  own button is (New sprint, Submit a ticket, New doc, New artifact, New handoff, New prompt); a screen an
  agent writes (the Feed) offers `CONNECT_AGENT` (the guided setup's agent step); Review and Unplaced offer
  nothing — empty is their normal state. A region is one read: My Work has four, the Feed three. The one
  exception to "one action" is the Repo dashboard, which keeps Preview with sample data for everyone and
  adds Open Org settings › Repositories for an admin (`actionHtml`).
- **Shapes are the skeleton's builders.** Each screen has ONE shape builder (`tableShapes`,
  `boardCardShapes`, `feedCardShape`, `sprintCardShape`, `timelineShapes`, `handoffRowsShape`,
  `promptCardShape`, `libraryCardShape`, `reviewCardShape`, `unplacedShapes`, `skRowsShape`, …) used by its
  loading skeleton AND its empty layout, so the two have the same columns and row heights and cannot drift.
- **Never data (CLAUDE.md invariant 7).** A shape is a box: no name, title, number, date, avatar, control or
  status colour. Inside `.cnpy-empty-shapes` (`aria-hidden`, `pointer-events:none`) trov.css draws `.cnpy-sk`
  hollow (a 1px `--border-strong` outline, no fill) and `.cnpy-surface` as a dashed outline with no fill or
  shadow; nothing animates. A skeleton is a FILLED bar that pulses. That difference — hollow and still vs
  filled and moving, plus a sentence — is how a person tells empty from loading at a glance, in either theme
  and under reduced motion. `test/render.empty.test.ts` walks every screen's shapes and fails on any text,
  control or colour token in them.
- **Radii**: `.cnpy-empty-say` and `.cnpy-empty-act` have their lines in the corners block.
- Left as they were: the My Work library strip's three cells (two real lines each), the Roadmap's "No sprint
  in progress.", Search's "No results for that query." (a query's answer), the Timeline's "No sprint has a
  due date yet" card, and a board column with nothing in it while other columns hold tickets ("Nothing here",
  the drop target).

### The state preview — `?preview=empty` / `?preview=loading` (`web/src/preview.ts`)

An owner of a busy organization never meets either state, so any app address takes a query flag:
`/<org>/?preview=empty#tickets`, `/<org>/?preview=loading#feed`, and the same on `/platform/`. Every screen
then paints its empty layout or its loading skeleton, whatever the organization holds.

- **A projection at render time.** `shownState(s)` (`render.ts`) maps the real state through `previewState`
  — every `{ status, data }` slice becomes "still out" or "answered with nothing", found by its shape in
  `initialState()` — and `render()` paints that. The real state is never written, the reads keep running
  underneath, and closing the banner paints the real screen at once. Anything main.ts renders directly must
  go through `shownState` too (`docReaderHtml` does). A NEW slice is covered automatically if it is a
  `{ status, data }` on `AppState`, `OrgUi`, `PlatState` or `ArtUi.list`; one whose empty value is not its
  initial value (a DTO that is `null` until read, like `mywork` or `feedStats`) needs a line in `previewState`.
- **Who is looking stays real**: the person, their organizations and role, the org's name, plan and
  settings — a new organization has those too, and they decide which actions show. In `empty` the org has
  one member (the viewer) and no repository; a page that opens ONE existing thing (a ticket, a sprint, a
  handoff, a prompt, an artifact) keeps the real item, because nothing can be opened in an empty
  organization. In `loading` those pages show their skeleton too.
- **It never sends a write.** `applyPreview` (`main.ts`, the only place the flag is set) calls api.ts
  `setWriteBlock`: while it is on, `call` — the one sender — throws `PreviewBlocked` for every request that
  is not a GET or HEAD before `fetch` runs, and a toast says "This is a preview: nothing is changed."
- **It cannot be mistaken for data.** `.cnpy-preview` (the amber banner at the app's lower right, a
  root-level sibling of the toast, never in the header) stays up on every screen: which state, "nothing is
  changed, and what you see is not your data", a switch to the other state, and Close (which removes the
  flag from the address bar). The flag is kept in the address bar across navigation (`withPreview` in
  `enterOrg` / `enterPlatform`) and is dropped by a page load to another organization.
- The Repo dashboard's own "Preview with sample data" still works under it.
- Tests: `test/render.empty.test.ts` (no string of the organization's data on any screen in either mode,
  the state object untouched, writes refused before `fetch`).

## The site on a phone

The signed-out site (`landing.ts`, `pricing.ts`, `legal.ts`, the sign-in and Contact dialogs) has ONE block
in `trov.css`, "the site on a phone", just before the corners block (so it is after every rule it overrides).
**Nothing in it applies at 961px and up**: every rule is behind `max-width:900px` (the nav's menu, the legal
contents), `max-width:640px` (the phone layout), `max-width:480px` or `(hover:none)`. The only rules outside a
query hide what a wide screen never shows, or style the menu, which `min-width:901px` hides. A new phone rule
goes in that block; a template gets a class hook, never a second copy of its markup.
`test/render.site-mobile.test.ts` fails on an unguarded rule.

- **The menu.** Under 900px the bar is one row: mark, name, the accent button, Menu. GitHub, the theme toggle
  and Sign in carry `site-nav-x` and leave it; the menu button is ALWAYS emitted (a stable nav) and shown by
  CSS. The menu is `menuSheet` in `landing.ts`: a root-level `data-overlay="sitemenu"` drawn from
  `state.siteMenu`, so opening it, toggling the theme in it and closing it patch the page (`data-morph`) and
  no reveal replays. `web/src/site-menu.ts` owns the scroll lock, focus (first link on open, the button on
  close), Esc, the Tab trap and the exit (`data-closing`, `MENU_EXIT_MS` = `--fx-fast`). A section link closes
  it first, unlocking the scroll at once, then scrolls ONCE; sections carry 84px of top padding on a phone and
  `scroll-margin-top:-8px`, so the heading lands 16px under the 60px bar. A tablet gets a card under the
  button, a phone the sheet below.
- **The sheet pattern.** The app's rule already turns every modal into a sheet under 640px (a full-screen
  wrapper whose child is `[role="dialog"][aria-modal="true"]`: bottom edge, full width, the safe area as a
  transparent bottom border, `100dvh`). The site adds: controls of 44px and up, a slide up on the site's clock
  (`site-sheet-up`, `--fx-slow`), and `--site-kb`, the height the on-screen keyboard covers
  (`web/src/site-viewport.ts`, from `visualViewport`), which lifts the sign-in and Contact sheets and comes off
  their `max-height`. Contact keeps Cancel / Send in a sticky row, with `scroll-padding-bottom` so a focused
  field stops above it. The tour's dialog is the full height; its panel AND its scroller are
  `touch-action:pan-y`, and a sideways swipe steps it (`swipeStep` in `site-feature-core.ts`), touch and pen
  only. A touch's action is settled between the element and its nearest scroll container, so `pan-y` on the
  panel alone does nothing.
- **The mockup rule.** A mockup on a phone is never a shrunken desktop window. It shows the screen's most
  telling pane in one column (`site-hide-sm` under 900px, `site-hide-ph` and `.fxm-wide` under 640px drop the
  rest), and **no text in it renders under 11px**: one rule in the block keys on the inline sizes
  (`[style*="font-size:9px"]`, the corners block's idiom) inside every mockup scope. A new mockup size under
  11px needs its key there, and the test names the size that is missing. The hero's Review mockup becomes one
  unified diff by CSS alone: `site-hero-twin` marks the left pane's lines that the right pane repeats.
- **Touch.** Hover lifts are off under `(hover:none)` and a press answers instead. A hover-only `title` is
  never the only label: in the menu the theme and GitHub rows are labelled.
- **Checking it.** Phone widths are measured in a real phone-sized viewport (Playwright with `isMobile`, or an
  iframe), at 360, 390 and 430, light and dark, with screenshots that are looked at. The wide layout is proved
  by rects and computed styles at 1440, 1100 and 961, not by eye.

## Fonts, contrast and focus — nothing from a third party, AA in both themes

### Fonts — self-hosted (`web/src/fonts/`, `shared/fonts.ts`)

- **No page asks a third party for anything.** Geist (latin + latin-ext) and Archivo Narrow (latin, the sidebar's
  face) are vendored in `web/src/fonts/` — the variable woff2 subsets Google Fonts serves (Geist v5, Archivo
  Narrow v35), SIL Open Font License 1.1, each family's `*-OFL.txt` beside the files. `trov.css` declares them at
  its top (`@font-face`, `font-weight` = the variable axis, so 640 is 640; `font-display:swap`; Google's
  `unicode-range`, held equal to `shared/fonts.ts` by `test/render.fonts.test.ts`); Vite hashes them into
  `/assets/`. latin-ext and Archivo Narrow are fetched only when a page draws a character in their range.
- **One preload.** Every built document — the four public pages, the 404 and the app shell — carries
  `FONT_PRELOAD` (`web/src/site-prerender.ts`): Geist latin, `as="font" crossorigin`. Vite rewrites its href to
  the same hashed file the stylesheet's `url()` resolves to, so it is one download. Nothing else is preloaded.
- **`'Geist Fallback'`** follows `'Geist'` in every stack: the system Arial (Helvetica, Liberation Sans) with
  `size-adjust` and ascent / descent overrides measured against Geist over the prerendered pages' own text, in
  three weight bands (400, 500, bold), so text set before Geist arrives wraps where Geist will put it. A new
  font stack names it too (the test fails otherwise).
- **The Worker's own pages** (OAuth sign-in and consent, the billing notices: `src/auth/oauth-pages.ts`) cannot
  know a hashed name, so the build also writes each font and license at a stable path, `/fonts/<file>`
  (`web/site-build.ts`; `fonts` is a reserved org slug). Their CSP is `font-src 'self'`.
- **Mermaid** is the `mermaid` npm dependency at an EXACT version, loaded by `import("mermaid")` in
  `web/src/artifacts.ts`: Vite makes it lazy chunks on Trov's origin (fetched when a diagram first opens, never
  in the main bundle). No CDN. The OG image generator (`scripts/og/render.mjs`) inlines the vendored Geist, so
  it needs no network either.
- **Not covered here:** the e-mails still link Google Fonts (`src/notifications/assemble.ts` `FONTS_HREF`), and
  the artifact sandbox's CSP still lets an HTML artifact's OWN scripts load from cdnjs / jsdelivr
  (`src/artifacts/raw.ts`; an opaque origin, no cookies — `artifacts.md`).

### Contrast — WCAG AA, computed from the tokens (`test/render.contrast.test.ts`)

The test parses both theme blocks of `trov.css` and fails on any pair under AA, so a retuned token cannot
regress silently:

| Pair | Minimum |
| --- | --- |
| every text token (`--fg`, `--fg-70`, `--fg-55`, `--fg-40`, `--accent`, the five tones, the ten `--p-*` handle colors) on `--bg` and `--surface` | 4.5:1 |
| each tone (and `--accent`) on its own chip — the `tint` idiom, the tone at 12% over the ground — and `--accent` on `--accent-soft` | 4.5:1 |
| the ink of a filled control on its fill: `--accent-fg` / `--accent`, `--red-fg` / `--red`, `--p-ink` / every `--p-*` (avatar initials) | 4.5:1 |
| `--border-input` (a text field's edge) and `--focus` (the ring) on `--bg` and `--surface` | 3:1 |
| white text on the brand banner, at its two light points (the first gradient stop; the highlight's peak over the middle stop) | 4.5:1 |

- **Fixed at the token, hue kept, the least that passes** (2026-10): light `--fg-40` #8e8e98 → #70707a, `--accent`
  #5e6ad2 → #525cc3 (and `--accent-soft`), `--green` #2f9e6b → #007545, `--amber` #c98a1a → #945800, `--blue`
  #4c8ed9 → #2467af, `--red` #e5484d → #c22231, `--purple` #8e5cc7 → #804db7, `--p-moss` / `--p-ochre`; dark
  `--fg-40` .40 → .52, `--red` #cc6262 → #df7372. The banner's gradient went one step deeper in both themes and
  its text is at least 92% white. `--fg-55` is unchanged, so light `--fg-55` and `--fg-40` now sit close
  (4.67 / 4.53 on `--bg`).
- **New tokens, split where a value served two jobs:** `--border-input` (fields) beside `--border-strong`
  (cards, dividers, the empty layouts' hollow shapes — still quiet); `--red-fg` (text on a filled red button:
  white on light, the dark ink on dark, as `--accent-fg`); `--p-ink` (avatar initials); `--focus` (= `--accent`).
- **A text field's edge is `--border-input` whatever its template wrote.** Field borders are inline
  `var(--border-strong)`, so one `!important` rule in `trov.css` recolours every `input` (not checkbox / radio /
  file / …) and `textarea`; an `aria-invalid` field keeps its red edge. A borderless field inside a bordered box
  (`@` + handle, `prompts/` + slug, tags, Search) colours the box (`:has()`). The sidebar's and the board's
  search boxes keep their quiet `--border` (an icon and a placeholder name them).

### Focus — every focusable element draws a ring (`test/render.focus.test.ts`)

- A ring is `outline:2px solid var(--focus)` (or `--accent`; `--red` on a destructive confirm; white on the
  banner) with an offset — never `outline:none` in a `:focus` rule, never a hover tint alone. Menu and option
  rows (the avatar menu, `dropdown()` options, the filter bar's button) draw it inset (`outline-offset:-2px`).
- **Text fields**: focused, the edge turns `--focus` and doubles (`box-shadow:0 0 0 1px`), `!important` because
  their `outline:none` is inline. The palette search's bar shows a 2px `--focus` line on its lower edge.
- Rules use `:focus-visible`, so a mouse click on a button draws nothing new; a text field shows its ring on
  click too, as browsers do for fields.

## Corners — tighter than the design file

Every radius renders at `--corner-scale` (`.4`) of its authored value: ONE block at the end of
`web/src/trov.css` zeroes everything with `!important` (the radii are INLINE styles in the TS templates, and
only `!important` outranks those), then restores each radius the app uses at `calc(<its value> *
var(--corner-scale))` — trov.css classes by name, inline styles by `[style*="border-radius:Npx"]` — and
circles/pills at `min(calc(12px * scale), 25%)`, so dots and avatars are small rounded squares. The authored
values stay as written (`1` restores them, `0` squares everything). So a NEW radius value or a new class with a
radius needs a line in that block, else it renders square; `test/render.corners.test.ts` fails until it has one.
A shape that only reads right as a CIRCLE (a halo ring, an overlapping avatar stack, a check in a bordered circle)
needs a hook class and a rule in that block (`.cnpy-av`, `.cnpy-avstack`, `.cnpy-seal`, `.repo-envdot`, …), and
a status dot must be an element, never a `●` character (`GDOT` in `repo.ts`).
