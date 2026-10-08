# Web UI: sidebar, motion, tabs and corners

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

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

**A pick-one with no room for a switch is `dropdown()`** (`web/src/dropdown.ts`), never a native `<select>`:
the trigger where the control sits, its menu a root-level overlay (`dropdownMenu`, the same props) that opens
and closes with an animation — Org settings' role and Notifications pickers.

**Every pick-one switch is `segmented()`** (`web/src/segmented.ts`) — the Feed view, the queue's
Board/Table and All/Open/Closed, Repo ranges and environments, an artifact's status, form segments. Never
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

Screen entrances are `[data-enter]` (set by `markEnter()` in `main.ts` only when the route changed or the
screen's main read landed — never on a keystroke). `--enter-t` is a NEGATIVE animation-delay, so a rerender
mid-entrance joins the animation where the old DOM left off. Hooks: `.cnpy-rise` + `--i`, `.cnpy-stagger`
(lists), `.repo-bar` / `.repo-fill` / `.repo-spark`, `data-count` (count-up). In-place changes use the
one-shot `pendingFlash`. All of it is off under `prefers-reduced-motion`.

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
