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
Platform, personal Settings (its name, handle and digest-address fields), the Artifacts screens, Review (its list is keyed: see "A row leaving a list" below), and the three first-run pages (onboarding `onboard`, the org picker `orgs`,
the guided setup `welcome`). Inside a morphed page, a part that must be REPLACED when it becomes a different
thing (a tab's panel, a wizard's step) names itself with `data-morph-key`. Do not fix a flicker by turning
animations off in the affected region — that hides one symptom and leaves the rebuild.

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
  (`revealClass`), so a jump never ends on a section that is still sliding.
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
measured at 1440 and 1100); one column under 900px. The plugin card holds the skills, then `connectSteps()` and
`CONNECTION_NOTE` from `mcp-connect.ts`. (Settings › MCP access changes a connection in a dialog —
`grantScopeDialog` in `render.ts`, a root `data-overlay` in the `.cnpy-cmodal` shell, never a panel under the
row: `auth-identity-people.md`.) If a card's content shrinks, re-weight the columns or let the card be
smaller: never pad one out.

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

- Each tile is placed by NAME (`.cnpy-set-profile`, `-account`, `-session`, `-appear`, `-plan`, `-limits`,
  `-orgs-tile`, `-mcp`, `-email`); DOM order is the folded order — Profile, Account, Plan, Limits,
  Organizations, MCP access, Appearance, Email, Session. Below 1000px of page: Profile | Account, every other
  tile full width; below 760px one column, **Sign out last**.
- **Sign out** is the Session tile's: a labelled button with its icon, at the top right of the page. It is the
  only `signOut` on the screen, and never a quiet link.
- Adding a tile: give it a row partner of the same natural height, or its own row. Measure (`align-self:start`
  on a tile gives its natural height) at ~1440 and ~1100 before choosing; a field in a wide tile takes a
  `max-width` (`.cnpy-set-name`).
- A limit's meter (`.cnpy-meter`) is a 4px bar with no radius, no animation and no transition, described once
  by its `role="meter"`; the page is `data-morph="settings"`, so typing in a field patches it in place.
- Tests: `test/render.connect.test.ts` (the grid, Session, sign-in methods), `test/render.settings-plan.test.ts`.

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
