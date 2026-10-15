# Ask Trov — the design inventory (for the parallel frontend build)

The design is `docs/superpowers/specs/ask-trov.dc.html` (byte-exact import of Claude Design project `70a62767`, file
`Ask Trov.dc.html`; durable link: https://claude.ai/design/p/70a62767-7765-451d-8c3a-30e00a0afb32?file=Ask+Trov.dc.html).
`ask-trov-parts.dc.html` / `ask-trov-screens.dc.html` are the two canvases that frame every scenario as an artboard
(desktop 1440×900, inspector 480×800, composer 760×N, phone 390×844). `ask-trov.support.js` is the dc runtime (do not ship).

This file is the map, so nobody re-reads 276 KB: per scenario, what it shows, the copy, the states, the CSS that
matters, which SSE events / fixtures drive it, and the design's line ranges (`L<a>–<b>` = lines of `ask-trov.dc.html`).
The contract is `shared/ai-ask-core.ts` (+ `docs/architecture/ask.md`); fixtures are `shared/ai-fixtures.ts` › Ask Trov
and the recorded SSE files in `docs/superpowers/specs/ask-transcripts/`. **Handoff #12 §3's copy changes are applied
below** (marked ⟨#12⟩). Prototype-only (ignore): the `askIcon` prop (use constellation), "… is outside this prototype"
toasts, the ticket page mock (the real Tickets page only GAINS ⌘J), local ticks on a handoff's Next list, the org
name "Sapling" (the app's org name; fixtures say "Acme").

**Not a pill, ever** — every state below is a mark (`web/src/marks.ts`): a glyph or a small shape + a sentence-case
word, its meaning in `data-mtip`. Segment groups are `segmented()`, menus/pickers are ours (never a native
`<select>`), confirmations `confirmModal`, people through `web/src/people.ts`, radii from the existing scale (see
"House rules for the build" at the end).

---

## 0. How to see a scenario locally (the replay recipe)

The design's scenarios replay from the dev-only route `GET /api/o/:slug/ai/ask-replay[/<scenario>]` (`src/ai/routes.ts`).
It answers **404 `not_found` unless all three** hold — which is why it 404'd on the master's server with
`DEV_LOGIN=AndresL230` against `acme`:

1. **`LOCAL_AI_PREVIEW` is set** in `.dev.vars` (`ready`). The master's `.dev.vars` had none.
2. **No LIVE Stripe key beside it** (`src/ai/preview.ts` → `holdsLiveKey`: `sk_live_…` OR a restricted `rk_live_…`).
   The master's `.dev.vars` holds an `rk_live_` key, which alone disables every preview. Blank
   `STRIPE_SECRET_KEY=` (and `STRIPE_WEBHOOK_SECRET=`) in YOUR worktree's `.dev.vars`.
3. **The org is one the DEV_LOGIN person belongs to.** The seed's `acme` (`org_b`) is the EMPTY neighbour — nobody is a
   member, so the org gate answers 404 before the route runs. Use **`saplinglearn`** (AndresL230 is its owner).
   Also the request must reach a loopback http origin (`http://localhost:<port>` or `http://127.0.0.1:<port>`).

Working recipe (one worktree, its own port — never 8787, never `build:web` in another worktree):

```sh
cp ../../../.dev.vars .dev.vars                       # from the main checkout
sed -i 's/^STRIPE_SECRET_KEY=.*/STRIPE_SECRET_KEY=/; s/^STRIPE_WEBHOOK_SECRET=.*/STRIPE_WEBHOOK_SECRET=/' .dev.vars
printf '\nLOCAL_AI_PREVIEW=ready\n' >> .dev.vars
npx wrangler d1 migrations apply trov --local && npm run seed
npm run build:web && npx wrangler dev --port 8791
curl -s localhost:8791/api/o/saplinglearn/ai/ask-replay | head -c 200         # 200: the scenario index + fixtures
curl -s 'localhost:8791/api/o/saplinglearn/ai/ask-replay/answer?speed=0'      # the whole transcript at once
```

In the app: **`http://localhost:8791/saplinglearn/?askReplay=<scenario>#ask`** drives the Ask screen from the replay
(web/src/ask-replay.ts): the state, threads, search hits and ref views come from the replay index's fixtures, and the
scenario's transcript streams at real pacing (`&askSpeed=4` faster, `0` instant). Nothing is written in replay mode — a
write answers with a toast. `askReplay` accepts every scenario below, plus `composer:<state>` and `insp:<type>`.
`cmdj` opens the ⌘J panel over the current route: `?askReplay=cmdj#tickets/14`.

---

## 1. Shell: sidebar, header, the three columns (scenario `live`)

**Sidebar** (L48–104): the design's rail is the app's (`web/src/sidebar.ts`). ONE new row — **"Trov"**, constellation
icon (`askGraph`, L1064: `<circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="5.5" r="1.9"/><circle cx="19" cy="6.5"
r="1.9"/><circle cx="17.5" cy="19" r="1.9"/><circle cx="5.5" cy="17.5" r="1.9"/><path d="M10 10.2 6.4 6.9M14.2 10.7l3.3-2.7M13.6
14.1l2.7 3.3M10 13.8l-3.1 2.4"/>`) — in Workspace right after My Work (L1759). Everything else in the rail stays as on
`main` (the design's grouping matches; Collapse, the person chip, the ghost line are the app's).

**Header** (L109–125), min-height 57px, padding 0 24px, border-bottom hairline:
- desktop, Ask screen: a **threads toggle** (28×28, radius 7, `data-tip` "Hide threads" / "Show threads", the
  sidebar-panel icon L112) left of the title; then `<h1>` **"Trov"** — a button: **clicking it starts a new thread**
  (L1800 `onTitle`); with a thread open the title turns `--fg-55` and a crumb follows: `›` (fg-40, 15px) + the thread
  title (15px/600, ellipsis). New thread before its first exchange: no crumb; once streaming, the first question's
  first 48 chars until the `thread` event names it.
- right: (Tickets page only) **"Ask about this ⌘J"** outline button (L117: 12.5px/500, border-strong, radius 8, the
  ask icon 14px + `<kbd>⌘J</kbd>`); Report a bug; theme toggle (the app's own).
- phone: a 40×40 **Open threads** (hamburger) before the title, a 40×40 **New thread** (+, border) on the right; no
  bug/theme buttons.

**Columns** (L128, L216–282 threads, L286–782 conversation, L784–1003 inspector):
- **Thread list**: 260px, `border-right` hairline, `animation:ask-screen .24s`. Hidden under 1180px window width, and
  while the inspector is open under 1640px (`openItem` L1488–1495 hides it and remembers; closing the inspector
  brings it back L1496). The header toggle overrides.
- **Conversation**: flex 1; its column is `max-width:720px; margin:0 auto; padding:0 28px` (phone / panel `0 16px`).
- **Inspector**: closed by default; 480px (`inspW`), resizable **380–720** by a 8px `col-resize` separator on its left
  edge (`role="separator"`, aria-label "Resize inspector"; hover paints a 2px accent line) L786, L1498–1504.

**Escape** (L1457–1467) closes, in order: the @ / slash **picker** → any **menu** (mode, regenerate, thread menu, the
phone + menu) → the **hover card** → the **⌘J panel** → the **inspector**. ⌘J (L1459): on the Ask screen focuses the
composer; elsewhere toggles the panel.

**Tooltip** (L1040): one layer, `max-width:260px; padding:6px 9px; border:1px solid var(--border-strong);
border-radius:7px; background:var(--bg); font-size:12px/500; box-shadow:0 8px 24px rgba(0,0,0,.22)`, 12ms fade.
Use the app's own tooltip (`data-tip` / `data-mtip`), not a second system.

**Toast** (L1042): the app's `flash()`.

### 1a. Thread list (`live`, `search`) — L216–282
- Top: **New thread** button (34px, full width, border-strong, surface, shadow, `+` icon, 12.5px/500, fg-70) and a
  **Search threads** box (34px, hairline, search icon 14px, input 13px, a clear ✕ 20×20 once typed).
- Groups (L1768): **Pinned, Today, This week, Earlier** (server: `AskThreadSummary.group`) — heads are the label face
  (`var(--label)`, 11.5px/500, `.05em`, UPPERCASE, fg-40, padding 10px 10px 4px).
- Row: button `padding:7px 10px; border-radius:8px`, title 13px/500 (fg-70; active fg + `--row-on` bg +
  `--row-ring`), time on the right (label face 11.5px fg-40: `9:41`, `Mon`, `Tue`). On hover the time hides and a
  **⋯ "Thread actions"** 24×24 button shows (L239).
- **Menu** (L241–247): 196px, padding 5, surface, border-strong, radius 10, `--menu-shadow`, `ask-pop .14s`, origin top
  right. Items 12.5px/500 with 14px icons: **Rename**, **Pin** / **Unpin**, **Export as markdown**, hairline,
  **Delete** (red, hover `color-mix(red 9%)`). Rename turns the row into a 32px input (accent border), Enter / blur
  saves, Escape cancels. Toasts: "Exported <title>.md", "Deleted <title>".
- **Search** (`search` scenario: query "netlify", the menu open on "CI flake on netlify-connect"): the groups give way to
  a count head ("4 threads" / "1 thread"), then hits — title + time, a 2-line snippet (12px fg-55) with the match in
  `<mark>` (accent-soft bg, fg, 600, radius 3), and "N match(es)" (label face 11px fg-40). None: "No thread mentions
  “<q>”." Server: `GET /ask/threads?q=` → `AskSearchHit { thread, snippet { text, matches:[[a,b]] }, matchCount }`.
  Fixture: `askSearchFixture` (replay index `search`).
- **Data**: `GET /ask/threads` → `{ threads }`, `PATCH /ask/threads/:id` (title, pinned), `DELETE`, `GET …/export`.
  Fixture: `askThreadsFixture` (8 threads: 2 pinned, 2 today, 4 this week).

### 1b. Empty conversation (`live`) — L299–309, L766–770
- Centered column, `justify-content:safe flex-end`: the Trov mark 28px, then **"Ask anything about your team's work"**
  (24px/600, -0.02em, balance), then the **starters** — a 2-column grid (phone 1), max 560px, gap 8: each a button
  (padding 10px 13px, radius 10, hairline, 13px/500 fg-70, an arrow icon 13px fg-40; hover surface + border-strong).
  Copy from `ask/state.starters` (fallback = the design's four: "What shipped this week?", "What's blocking the hosting
  work?", "Summarize ticket #14", "Where did our time go this month?"). Click sends.
- The composer sits under them, and under it: **"Answers come from what you can see in Trov, with sources. Trov asks
  before it changes anything."** (12.5px fg-55, centered, balance).
- Entrance: `ask-rise .42s cubic-bezier(.2,.7,.2,1)` staggered .05s / .12s.

---

## 2. Conversation (`streaming`, `thinking`, `answer`, `notfound`)

### 2a. The question — L315–347
- Right-aligned row, gap 6, margin-bottom 22px, `ask-rise .36s`.
- Bubble: `max-width:min(560px,86%)`, `background:color-mix(in srgb,var(--fg) 6%,var(--bg))`, radius 12, padding 9px
  14px, 14.5px/1.55, `white-space:pre-wrap`.
- Above the bubble, right-aligned: **image files** as 136px cards (84px thumbnail, `object-fit:cover`; no URL → a
  striped placeholder) with a footer row (image icon + name, 11.5px); **other files** as chips (icon + name + size
  fg-40); **context chips** (the ref chip, 28px tall variant). Click opens the inspector (`upload` view for a file).
- **Edit** (hover over the LAST question only, not while busy; always shown on phone): a 28px ghost button "Edit"
  (pencil 13px) left of the bubble. Editing: a 560px surface box (border-input, `0 0 0 3px var(--accent-soft)`), a
  3-row textarea 14.5px, footer: **"Sending replaces the answer below."** (11.5px fg-40), **Cancel** (outline),
  **Send** (accent). Send → `POST /ask { replaceFrom: <question id>, text }`.

### 2b. Activity steps — L351–367 (events `activity`)
- Column, gap 1, margin-bottom 10. Each step a button: min-height 28, padding 3px 8px, margin-left -8px, radius 7,
  13px; icon 14px fg-40 (running: a 13px spinner, `ask-spin .8s`), label; running color fg-70, done fg-55.
- With results (`resultLine` present: "3 results", "1 result"): `· 3 results` (12px fg-40) and a chevron that rotates
  90° when open; open shows a list with a left hairline (margin 2px 0 6px 6px, padding-left 14px), each row an item:
  type icon 14px + title (12.5px/500) + meta (11.5px fg-55: "Doc · Oct 12", CI: "netlify-connect.test.ts failing on main ·
  run #1482") — click opens the inspector.
- Events: `{ step, tool, icon, label, state:"run" }` then `{ step, state:"done", results?, resultLine? }`. `icon` ∈
  search, tickets, ci, pr, sprint, feed, docs, read, handoffs, review (design paths L1060–1090: search L1078, tickets
  L1066, ci L1083, pr L1080, sprint L1089, feed L1071, docs L1072, read L1084, handoffs L1068, review L1074). The
  transcripts also emit steps for the show tools ("Showed items", "Checked what was searched", "Prepared a save form")
  — the design shows none of those; hide `show_*` / `save_artifact` steps or keep them quiet (decision for
  conversation).

### 2c. Thinking — L369–378 (`thinking` scenario; events `thinking`)
- Same row style as a step, clock icon 14px. Running: **"Thinking… Ns"** (fg-70, `ask-pulse 1.6s` infinite) — the
  CLIENT counts the seconds from `{ state:"run" }`. Done: **"Thought for 14s"** + chevron; open shows the `summary`
  (13px/1.6 fg-55, left hairline). Only in Thinking mode.

### 2d. Answer text + the cursor — L380–384, L612, L1612
- `h` (`##` in the stream): 15.5px/640, -0.006em, margin 22px 0 8px. `p`: 14.5px/1.7, margin 0 0 12px, `text-wrap:pretty`.
  `ul`: padding-left 20, items margin 0 0 4px. Tables (`| … |`) are a rich block (2e).
- **Ref chips inline** (the ref token `[[ticket:14]]`): `inline-flex; gap:5px; vertical-align:-4px; padding:1px 7px 1px
  5px; margin:0 1px; border-radius:6px; border:1px solid var(--border); background:var(--surface); 13px/500;
  line-height:20px`; hover border-strong + hover bg. Lead: ticket / PR → its status glyph 12px; person → avatar 15px
  (label `@handle`, colored by the person); others → the type icon 13px fg-55. Label: ticket/PR `#14` (`#173 merged`
  for a merged PR), doc / sprint / repo / chart / artifact → title, handoff `Handoff #11`. aria-label "Ticket: #14
  Guided repository setup, In progress". A token NOT in `done.cites` (unlinked) renders as plain text.
- **Soft cursor** while streaming: 7×15px, radius 2, accent, opacity .75, `ask-blink 1.1s` — at the end of the last
  text block, or alone under a block (`curAlone`).
- **Stop**: `{ done.stopped:true }` → under the partial answer: a 9px square (fg-40) + **"Stopped. The answer above is
  partial."** (12.5px fg-55). The footer still shows.
- **Error** (L604–609): `error` event → a row (radius 10, border `color-mix(red 30%, border)`, bg `color-mix(red 5%,
  surface)`): diamond mark + **"Something went wrong."** (13px/500) **"Nothing was changed."** (12.5px fg-55) +
  **Try again** (outline 12px) — Try again regenerates. No footer under an error. (Codes: capped / off / no_key /
  timeout / too_large / failed — capped and off ALSO switch the composer to its blocked states, 4.)

### 2e. Rich blocks (`answer`) — L385–473
Every rich block: margin 6px 0 16px, `ask-rise .42s`; on hover (desktop) a floating toolbar top:-12px right:8px (surface,
border-strong, radius 8, menu-shadow, `ask-pop .12s`) with two 26×26 icon buttons: **Save as artifact** and **Open in
inspector** (`data-tip` each). Cards don't need Open (each card opens itself).
- **Table** (L392–403, markdown table in the text): 13.5px, th = label face 11.5px/600 UPPERCASE `.05em` fg-55,
  `border-bottom:1.5px solid var(--border-strong)`, padding 8px 12px 8px 2px; td same padding, hairline bottom, fg-70,
  nowrap; cells may hold a ref chip (12.5px variant) or a **status cell** `[[ticket:14|status]]` → the item's live
  mark + word (12.5px fg-70, `data-mtip` = tip). Horizontal scroll inside.
- **Item cards** (`block` `items`, L405–416): grid of 2–3 (`repeat(n,minmax(0,1fr))`, phone 1fr), gap 10. Card: padding
  12px 14px 11px, surface, hairline, radius 10, shadow, hover border-strong + `translateY(-1px)`. Eyebrow (label face
  11px UPPERCASE fg-40: type icon + "Ticket #14" / "Pull request #176" / "Sprint"), title (13.5px/600, 2-line clamp,
  min-height 36), the status mark + word (12px fg-70), then a hairline footer: owner avatar 16 + name (11.5px fg-55) …
  updated (label face fg-40). From `RefView` (owner = handle → persons; updated = relative).
- **Bar chart** (`block` `chart`, L418–434): figure padding 14px 16px 12px, surface card. Caption: title (13px/600) left,
  **"<total> in <N> weeks"** right (12px fg-55; design hard-codes "48 in 8 weeks" — build it from `chart.total` and
  `rows.length`). Bars: 150px tall area, gap 10, bar max-width 34, radius 3px 3px 0 0, `color-mix(accent 78%)` (hovered
  bar: accent), value above (label face 11.5px/600 fg-55), labels below (11px fg-40), min-width 400 + scroll. Grow
  `ask-grow-y .55s` staggered 45ms. Footer: Trov mark 10px + **"Data from Trov"** (12px fg-55). role="img" with an
  aria-label naming what it counts.
- **Theme strip** (`block` `themes`, L436–453): caption title + the SERVER's caption (fixture: "Share of merged PRs" —
  the design's "Share of merged PRs and agent sessions" is replaced by whatever `themes.caption` says). Grid `112px
  repeat(weeks, minmax(0,1fr))`, gap 3, min-width 520; week heads label face 10.5px fg-40; lane name 12px fg-70 with an
  8px square in `--p-<color>`; cells 22px tall, radius 3, `color-mix(var(--p-<color>) <14+v·76>%, transparent)`, 0 →
  `--hover`. Tooltip per cell: **"Hosting, week of Sep 14: 70% of capacity"** (0 → "none"). Lanes wipe in
  (`ask-wipe .7s`, 90ms stagger). Footer "Data from Trov".
- **Dependency chain** (`block` `diagram`, layout `chain`, L455–471): caption title + caption (fixture: "What waits on
  what" / "Each step waits on the one before it"). Nodes in a row (min-width 600 + scroll), each a button (flex 1,
  padding 10px 11px, hairline, radius 8, bg `--bg`): eyebrow (label face 10.5px UPPERCASE fg-40), label (12.5px/600),
  the node's `view.status` mark + word (11.5px). Between nodes a 30×16 arrow (fg-40). Node with a ref opens it.
  `layout:"list"` → draw the nodes as a list (no arrows).
- **Not found** (`block` `not_found`, `notfound` scenario, L592–602): search-minus icon 16 + **"I couldn't find that in
  Trov."** (15.5px/600); **"Nothing you can see mentions “<query>”. It may live somewhere Trov doesn't read, like
  email or a call. Try asking about something Trov keeps, or name an item:"**; the two `tries` as chips (padding 7px
  12px, radius 9, arrow icon) that send; then a card **"What I searched"** (label head) with one row per
  `searched[]` (ring mark + area 13px/500 + scope 12.5px fg-55 … **"No matches"** label face fg-40).

### 2f. Footer + sources + follow-ups — L615–650
- Shown once the answer is done (not under an error). Row of 28px ghost buttons (12px/500 fg-55, radius 7, hover bg):
  the Trov mark 13px + the **mode word** ("Smart", `data-tip` "Written by Trov"), a 1×14 divider, **"N sources"**
  (`No sources` when 0; chevron that flips) → a numbered list card (n, icon, title, meta per row; opens the inspector),
  **Copy** (→ "Copied" 1.6s), **Regenerate** + a 20px chevron → menu "Regenerate with" (290px, the modes with hint and a
  check on the current; opens UPWARD), **Save as artifact**, **Wrong?** → an inline row "What was wrong?" + three
  chips: **"A source is wrong"**, **"It is out of date"**, **"It missed something"** → toast **"Thanks. The team can see
  this in Review."** (`POST /ask/messages/:id/wrong { reason }`).
- Sources = `done.cites` (RefViews). Mode word = the answer's mode.
- **Follow-ups** under the LAST answer only, when done and not busy: rows with a top hairline, a return-arrow icon,
  13.5px fg-70; click sends. From `followups.items`.

---

## 3. Actions (`actions-ask`, `actions-auto`) — L475–564, L1651–1672

The card is a surface (radius 10) with a header row (label face eyebrow **"New ticket" / "New handoff" / "Doc edit" /
"Publish doc"**, then a status mark: ring + **"Draft, not created yet"**, or triangle amber + **"Waiting for you"**;
right: **Edit** / **Done editing** accent text button), a body per kind, and a footer (`color-mix(fg 1.5%)` bg,
top hairline): the optional note (amber triangle + note 12px fg-70) … **Cancel** (outline) **Confirm** (accent, check
icon). Events: `action` `{ id, groupId, tool, kind, preview, fields, editable, state: proposed|waiting, note }`;
decisions via `POST /ask/actions/:id/confirm { args? }` / `cancel` / `undo` → `AskActionAnswer { results[] }`.

- **ticket** (L495–517): status glyph todo 13 + title 15px/600 + body 13px fg-70; a 4-col grid (Category, Priority with
  bars, Assignee with avatar 18, Sprint). Editing: Title input (36px, radius 9), Category chips (bug, request,
  question, access, other — on = accent border/text + accent-soft bg), Priority `segmented` (High / Normal / Low with
  bars), Assignee person chips. Editable = `action.editable` (fixture: title, category, priority, assignee).
- **handoff** (L519–535): from avatar 18 + "Andres Lopez" (the person) → to (avatar or "Anyone") + "· any agent session
  can claim it"; task (15px/600) — editing: recipient chips + Task input; two columns Done (glyph done) / Next (glyph
  todo); file paths as mono chips. Editable: recipient, task.
- **doc_edit** (L537–547): doc icon + doc title + "v4 → v5" (label face) … **"Goes to Review before it is live"**; a diff
  box (radius 8): heading row (mono 12px fg-55, e.g. `## Tokens`), a `−` row (red 9% bg, struck through) and a `+` row
  (green 10% bg); editing turns the `+` into a textarea. Up to 3 hunks (`preview.hunks`), editable `hunks`.
- **publish** (L549–555): doc icon + title + "Product · v2" … amber mark **"Staged, not approved"**; **"Publishing makes
  v2 live for the org. Agents read it from then on."**; the staged lines as a list. In Auto it **waits** with the note
  ⟨#12⟩ **"Publishing waits for you, even on Auto."** `preview.canPublish:false` → show **"Open in Review"** instead of
  Confirm.
- **After a decision** each card collapses to a **done line** (L475–484): a row (min-height 40, radius 10, surface): check
  mark + the result text (linked, underlined, opens `ref` in the inspector) … time (label face fg-40, "Just now") …
  **Undo** (outline, 12px, undo icon) while undo is offered. Cancelled: off-square mark + **"Cancelled: new ticket"**
  (fg-55). Undone: off mark + **"Undone: moved ticket #14 to done"** (fg-55). Toasts: the result, "Undone".
- `actions-ask` (thread): an earlier exchange whose answer reads **"Done where you confirmed."** + a confirmed line
  **"Created ticket #29"** + a cancelled line **"Cancelled: move ticket #14 to Testing"**; then the question "Now draft
  the follow-ups: …" and the answer **"Here are the three changes. Nothing happens until you confirm each one."** with
  the ticket, handoff and doc-edit cards. (The transcript streams only the last turn.)
- `actions-auto`: earlier "Move #14 to Done." → **"Moved it. Undo is there if that was early."** + an undone line; then
  the answer **"Five changes ran on their own. The sixth waits for you."**: done lines **"Sent handoff #11 to
  anyone"**, **"Moved ticket #14 to In progress"**, a GROUPED line **"Filed tickets #30, #31 and #32"** (one Undo for
  the group: `action_result` events share `groupId`), and the waiting Publish card. Auto cap note (design copy for the
  ticket case): "Auto runs up to 5 changes per answer."
- Undo refused because the item changed → `409 { error:"changed", message:"Changed since. Undo it by hand.", ref }`:
  show the message with a link to `ref`.

## 4. Save as artifact (`artifact`, `artifact-saved`) — L566–590

- Form card (padding 14px 16px, surface, radius 10): artifacts icon + eyebrow **"Save as artifact"**; **Title** input
  (38px, radius 9, 14px); **Kind** `segmented` (**Markdown** / **HTML page**) and **Who can see it** `segmented`
  (**Private** / **Org**); footer: hint (**"Only you can see it. You can publish it to the org later."** / Org:
  **"Everyone in <org> can open it from Artifacts."**) … **Save** (accent).
- Saved line (min-height 44): check mark + **"Saved as artifact: <title>"** + "· Private"/"· Org" … **Open** (outline, ↗)
  → the artifact in the inspector. Toast **"Saved to Artifacts"**.
- Sources: the footer's / a block's Save → `POST /ask/messages/:id/save-form { block? }` (no model call) adds a
  `save_form` block; the model's `save_artifact` streams `block { kind:"save_form" }`. Save → `POST
  /ask/threads/:id/save { messageId?, block?, title, kind, visibility }` → `artifact_saved { slug, title, visibility,
  url }`. In Auto it is saved private at once (`artifact_saved` in the stream; `artifact-saved` transcript).
- `artifact` scenario = the hosting answer, then "save this as a doc" → **"Here it is as an artifact. Change the title
  or who can see it, then save."** + the form (title "Hosting status, Oct 15", HTML page, Private).

## 5. Composer (all `composer:*`) — L658–770

- Container: `max-width:720px` like the column, padding-bottom 14. Box: surface, radius 12, `border:1px solid
  var(--border-strong)` (focused: border-input + `0 0 0 3px var(--accent-soft), var(--shadow)`).
- **Chips row** (files + context): 32px chips, radius 8, bg `--bg`, max-width 240: thumb 22px (image) or a 22px icon
  box; name (12px/500) over meta (label face 10.5px: size / type word; too-large: **"Too large"** in red, chip border
  red 45%); remove ✕ 20px ("Remove <name>"). `ask-pop .16s`.
- **Textarea**: grows (min 46px, max 220px, then scrolls), 14.5px/1.55, padding 12px 14px 4px. Placeholders: empty
  thread **"Ask about tickets, docs, PRs or sprints"**; later **"Ask a follow-up"**; busy **"Trov is answering…"**;
  ⌘J panel **"Ask about this ticket…"**. aria-label "Message Ask Trov". Enter sends, Shift+Enter newline (not while
  composing IME).
- **Toolbar (desktop)**: Attach (paperclip, `data-tip` "Attach files, or drop and paste them"), Mention (@, "Mention a
  ticket, doc, PR or person"), Commands (/) — 30×30 icon buttons; … **mode menu** (Pro only: the mode word + chevron,
  28px; menu 286px opening UP-RIGHT: label + hint + check; from `ask/state.modes`, hints verbatim, ⟨#12⟩ Thinking's hint
  ends "Counts as 5 questions."); the **Ask before changes / Auto** `segmented` (22px, 11.5px; label "Ask first" in the
  ⌘J panel); **Send** 32×32 radius 8 (accent when sendable, `--hover` + fg-40 when not; busy: fg bg + a stop square,
  aria "Stop answering").
- **Auto disabled** (`composer:autoOff`, `ask/state.autoAllowed:false`): the switch at opacity .55, not-allowed, its tip
  **"An admin turned off Auto for this org. Trov asks before every change."**
- **Under the box**: desk **"Enter to send · Shift+Enter for a new line"** (11.5px fg-40); right: the usage line under 20%
  left — **"<left> of <cap> questions left this month · Resets Nov 1"** (from `allowance`: left = cap − used; reset
  date from `resetsAt`; `low` says when).
- **Context line** above the box (L693): Trov mark 11 + **"About ticket #14 · 1 file"** (`About <ctxWord>` + " and N more" ·
  "N files"; in the ⌘J panel "About ticket #14: Guided repository setup") + a clear ✕ ("Remove all context").
- **Picker** (`composer:at`, `composer:slash`, L660–677): above the box (`bottom:calc(100% - 6px)`), width min(420px,
  100%), max-height 330, radius 12, `--lift-shadow`, `ask-pop .14s`. `@`: groups by type (Tickets, Docs, Pull requests,
  Sprints, Handoffs, People — label face 10.5px/600 `.07em`), rows 12.5px (lead mark/avatar 18px box, title ellipsis
  72%, context = status word / `@handle`), selected row `--hover`; `/`: **Commands** — `/ticket` "Draft a new ticket",
  `/handoff` "Draft a handoff for an agent session", `/search` "Search Trov for a phrase", `/summarize` "Summarize an item
  or this thread", `/brief` "Write a status brief for the team" (mono 12.5px, 92px column). Empty: **"Nothing matches
  “<q>”."** Footer: "↑↓ to move · Enter to pick · Esc to close" (11px fg-40). Keyboard: ↑/↓ wrap, Enter/Tab picks,
  Esc closes; rows `preventDefault` on mousedown. Picking `@` adds a context chip and removes the `@query` text. The @
  rows search the org (the app's quick search) — RefViews via peek.
- **Files** (`composer:files`): ci-failure.png (thumb), deploys-october.csv, netlify-api.pdf + context #14; text "Why does
  this fail only on main?". Upload ON ATTACH: `POST /ask/attachments` (multipart) → `{ threadId, attachments[] }`;
  limits from `ask/state.attach` (5 files, 10 MB, kinds).
- **Drag** (`composer:drag`, L772–780): over the conversation section, an overlay inset 10px, 1.5px dashed accent,
  radius 14, bg `color-mix(surface 90%)`: upload icon 26 accent, **"Drop files to attach"** (14px/600), ⟨#12⟩ **"Images,
  PDFs and text files, up to 10 MB each"**. Paste of files attaches too.
- **Too large** (`composer:tooLarge`): note above the box: diamond + **"<b>standup-recording.mov</b> is too large.
  Files can be up to 10 MB."** ⟨#12⟩ + the red chip.
- **Error** (`composer:error`): note **"Something went wrong. Try again"** (link) above the box.
- **Quota** (`composer:quota`, L697–702, replaces the box): card (padding 14px 16px, radius 12, border-strong):
  **"You've used this month's questions."** / **"Resets Nov 1. Pro includes 300 a month, plus Thinking mode."** +
  **Upgrade to Pro** (accent). (Error `capped`; or `allowance.used >= cap`.)
- **Off** (`composer:off`, L703–708): card with an off mark: **"Ask Trov is off for this org."** / **"An admin can turn it
  on in Org settings › AI."** (`ask/state.enabled:false`, error `off`).
- **Free** (`composer:free`): no mode menu (`modes.length === 1`); usage line "9 of 50 questions left this month · Resets
  Nov 1" (fixture free: used 41 of 50, low).
- **Low** (`composer:low`): Pro with 41 left — the usage line.
- **Busy** (`composer:busy`): Send is Stop.

## 6. Inspector (`answer-pr`, every `insp:<type>`, `phone-insp`) — L784–1003, L1710–1726

Shell: surface, left hairline; header 52px (padding 0 10px): **Back** 28×28 (disabled at the stack's start, fg-40), the
**type word** (label face 12px/500 UPPERCASE fg-55: Ticket, Pull request, Doc, Sprint, Repo, Handoff, Feed entry, Person,
Artifact, Upload, Chart) + **"from #14 › #176"** (the breadcrumb of what came before, 12px fg-40, ellipsis), **Open in
page** (↗ 28×28), **Close** (✕). Body scrolls; padding 20px 22px 40px; each view enters with `ask-ia`/`ask-ib`
alternating (a 6px rise). Opening an item PUSHES onto the stack (dropping anything after the current index). Field
rows are `grid-template-columns:92px 1fr; min-height:32px` with label-face labels (11px UPPERCASE fg-40). Titles 19px/600.
`answer-pr`: stack [#14, #176, #173], idx 2, threads hidden. Data: `GET /ask/item/:ref` → `AskItem { view, detail }` (and
the per-type routes where they exist); the header from the RefView.

- **ticket** (`insp:ticket` = #14): `#14` (label face), title, body; rows Status (mark+word, tip), Priority (bars),
  Category, Assignees (avatar 20 + name, each opens its person; none: italic "Unassigned"), Sprint (name + "Due Fri, Oct
  30", opens the sprint; none "Backlog"), Requester (+ "· opened Sep 28"); **Sub-tickets** head + "1 of 3 done", rows
  (glyph 13 + `#21` + title); **Linked pull requests** rows (glyph, title, "#176 · In review", right: diamond/dot +
  "Checks failing"/"Checks passing"); **Latest comments** (avatar 20/name/time/body).
- **pr** (`insp:pr` = #176): "#176 · AndresL230/trov"; title; status mark, author (avatar), "Updated 40m ago"; head → base
  mono chips; **Checks** + "3 of 4 checks pass", each check a dot/diamond + mono name; **What / Why / Impact**
  paragraphs; footer "9 files" +286 (green) −41 (red) … "Linked to" + a ref chip.
- **doc** (`insp:doc` = Release 0.30 notes): title; mark (Live / Staged, not approved), "Product · v2", owner, "Updated
  …"; a rendered excerpt in a `--bg` box (h3 15px, p, ul); staged: **"This version waits in Review. Agents still read v1
  until someone approves it."**; **Open doc** (outline ↗).
- **sprint** (`insp:sprint` = Hosting): title; "Oct 5 – Oct 30" · **"Due Fri, Oct 30"** · lead; goal; "58%" + **"7 of 12
  tickets done"**; a 6px progress bar (accent, `ask-wipe`); amber warn + forecast **"At this pace, done Nov 2, 3 days
  late"**; tickets grouped by status (glyph + label + count), rows `#14` title avatar; done group "and N more".
- **repo** (`insp:repo`): mono title; **Environments** rows (name 84px, url mono, mark + Healthy/Degraded); **Last deploy**
  (dot + Production; `a1c9e2f · 3h ago · andres`) / **CI on main** (diamond + "Failing"; test · run #1482 · 40m ago);
  **State** box: headline 14.5px/600 + Shipped (check) / In flight (ring blue) / At risk (triangle) lists.
- **handoff** (`insp:handoff` = #11): "Handoff #11"; title; Pending mark + "Today, 9:20"; From avatar → To "Anyone";
  **Task**; **Done** (done glyphs); **Next** (todo glyphs — display only, no local ticks); **Files** (mono rows).
- **feed** (`insp:feed`): kind mark ("Shipped"), author, agent icon + "agent", time; title; brief 14px/500; body
  paragraphs; **Sources** rows.
- **person** (`insp:person` = Maya): avatar 52 (through people.ts), name 19px, `@maya` in their color, role; **Working
  on now** rows (mark + title + word); **Recent pull requests** rows.
- **artifact** (`insp:artifact` = Hosting status, Oct 15, private HTML page): title; Private/Org mark, "HTML page · v1", "by
  · Just now"; a framed **live preview** (30px chrome bar with 3 dots + `trov.dev/<org>/a/<slug>`) — use the app's
  sandboxed artifact viewer (`web/src/artifacts.ts`), never the mock; private: **"Only you can see it. Publishing puts it
  in Artifacts for everyone in <org>."** + **Publish to org** (accent) → toast "Published to <org>".
- **upload** (`insp:upload` = ci-failure.png): the preview (image, max 360px, contain; else striped placeholder "CI
  screenshot · 412 KB"), kind/size, **"Attached to this thread. Trov reads it only when you ask about it."**
- **chart** (`insp:chart`): title + a `segmented` **Chart / Table**; **"48 merged pull requests on AndresL230/trov, Aug 24 –
  Oct 18"** (build from `chart`: total, unit, the range); bars 220px; Table: **Week of / Merged PRs** (the unit) + a
  **Total** row; footer **"Data from Trov · merged PRs only, reverts excluded"** (the query's note).

## 7. Hover card (`answer`, auto-shown over the #14 chip) — L1010–1038, L1472–1479

- After **320ms** over (or focus on) any ref chip; leaves 140ms after the pointer leaves unless it enters the card. 300px,
  padding 12px 14px, surface, border-strong, radius 10, menu-shadow, `ask-pop .14s`, placed under the chip (above it when
  there is no room), clamped 12px from the edges.
- Non-person: eyebrow (type icon + "Ticket #14"), title 14px/600, mark + word. ticket: bars + priority, assignee avatars
  18, "Sprint Hosting" / "Backlog", "Updated 2h ago". PR: author avatar + name · updated; `head → base` mono 11px; check
  dots + "All checks pass" / "1 check failing". doc: "Technical · v4 · Andres Lopez" + a 3-line excerpt. Other: one
  meta line (sprint "Oct 5 – Oct 30 · 58% done"; handoff "From Andres Lopez to anyone"; repo the headline; chart "8 weeks
  · Data from Trov"; feed its brief; artifact "HTML page · v1").
- Person: avatar 36 + name 14px/600 + `@handle` in color; role; **"Working on #14 and #176"**.
- Footer: **"Click to open beside the thread"** (11.5px fg-40) … **Open** (accent).
- From `RefView.extra` (ticket: priority, assignees, sprint; pr: author, head, base, checks; doc: space, version, owner,
  excerpt; person: role, workingOn; sprint: due, progress; handoff: from, to, task; artifact: kind, visibility, version;
  repo: ci).

## 8. ⌘J panel (`cmdj`) — L284–297, L1196–1197, L1803–1804, L1811–1812

- Over ANY page (the scenario: the Tickets page on #14): a scrim (`--scrim`, closes it) and a 420px panel on the right
  (surface, left border-strong, `--lift-shadow`, `ask-panel-in .28s`); phone: full screen.
- Header 57px: Trov mark 12 + **"Ask Trov"** (14px/600) + `<kbd>⌘J</kbd>` … **"Open as thread"** (↗) + Close ✕.
- The conversation and composer in the panel's width (padding 0 16px; column 100%); the page's item is the context
  ("About ticket #14: Guided repository setup"); the switch says **"Ask first"** / Auto; placeholder "Ask about this
  ticket…". The inspector opens to the panel's LEFT (`right:420px`, its own width, lift shadow).
- Transcript `cmdj`: thread `origin:"panel"`, `contextRef:"ticket:14"`; answer "Two of three sub-tickets are open. #176
  needs the connect test fixed first." + a list; follow-up "Draft a handoff for the connect test".
- **Open as thread** → `#ask/<thread id>` (the panel thread is a normal thread). On the Ask screen ⌘J focuses the
  composer instead.
- The Tickets page gains ONLY the header button "Ask about this ⌘J" and the shortcut (don't change the page otherwise).

## 9. Settings › Trov (`settings`) — L168–214 (a sibling builds it as `web/src/ask-settings.ts`)

A 12-col bento: **How Trov should answer you** (span 7): eyebrow "Trov", label, **"Trov follows this in every new
thread. It shapes tone and length, not what Trov can see."**, a 6-row textarea (maxlength 500, placeholder "For example:
lead with what is blocked, and keep it short."), **Try:** chips "Lead with what is blocked, then what shipped." / "Keep
answers under 150 words and link every ticket." (append), counter "N / 500" (amber over 450). **Default mode** (span 5,
"Pro"): **"New threads start in this mode. You can switch per question in the composer."**, a `segmented` Fast / Smart /
Thinking + its hint; **"On Free, every question uses Smart."** **What Trov can see** (full width): **It reads** — "Tickets,
docs, pull requests, sprints, handoffs, the feed and artifacts you can open yourself." / "The Repo dashboard: CI, deploys
and environment health." / "Files and screenshots you attach to a thread." **It does not** — "Read other people's
threads or private artifacts." / "Write code. It reads PR summaries and files tickets and handoffs for the agents that
do." / "Reach anything outside Trov, like email, chat or calls."; footer **"Its changes go through the same gate as an
agent's. Doc edits wait in Review; tickets and handoffs wait for your Confirm unless a thread is on Auto."** + **Save**
→ "Saved" + toast "Saved. New threads use these settings." `GET/PUT /ask/settings`.

## 10. Phone (`phone`, `phone-plus`, `phone-insp`) — 390×844

- `phone`: no sidebar; header with Open threads + New thread; the thread list is a **drawer** (`min(300px, 100% - 48px)`,
  bg, shadow `0 0 48px rgba(0,0,0,.32)`, `ask-drawer-in .26s`) over a scrim `rgba(0,0,0,.45)`. Conversation padding 0 16px;
  starters 1 column; cards 1 column; Edit always visible on the last question; no block toolbar.
- Composer: no toolbar row; instead a 40×40 **"+" More options** (rotates 45° open) + the **meta line "Smart · Asks
  first"** ("Auto" when on; Free: "Asks first") + a 40×40 Send/Stop. No "Enter to send" hint.
- `phone-plus`: the **+ menu** (L679–691): a sheet above the composer (radius 14, lift shadow, `ask-sheet-up .22s`): 44px
  rows **"Attach a file or photo"**, **"Mention a ticket, doc or person"**, **"Run a command"**; a hairline; **Mode**
  (Pro) `segmented` 34px + its hint; **Changes in this thread** `segmented` **Ask before changes / Auto** (34px).
- `phone-insp`: the inspector as a **full-height sheet** (`ask-sheet-up .26s`, a 36×4 grab handle on top), no resize.

---

## 11. Scenario → events / fixtures (quick table)

| Scenario | Transcript (`ask-transcripts/`) | Other fixtures (replay index) | UI state the replay sets |
|---|---|---|---|
| `live` | — | state pro, threads | empty thread |
| `streaming` | `streaming.sse` (held mid-answer, no `done`) | | busy, Stop |
| `thinking` | `thinking.sse` | | mode Thinking |
| `answer` | `answer.sse` | refs | hover card on #14 after 900ms |
| `answer-pr` | `answer.sse` | refs | inspector stack ticket:14 → pr:176 → pr:173, threads hidden |
| `actions-ask` / `actions-auto` | `actions-ask.sse` / `actions-auto.sse` | | auto on for `-auto` |
| `artifact` / `artifact-saved` | `answer.sse` then `artifact(-saved).sse` | | |
| `search` | `search.sse` | threads, search ("netlify") | thread query "netlify", the menu open on thread 5 |
| `notfound` | `notfound.sse` | | |
| `cmdj` | `cmdj.sse` | | the ⌘J panel over the page, context ticket:14 |
| `ticket` / `settings` | — | | (the Tickets page; Settings › Trov) |
| `phone`, `phone-plus`, `phone-insp` | `answer.sse` | | (narrow viewport) + menu / inspector sheet |
| `composer:quota` `off` `autoOff` `free` `low` `error` `tooLarge` `busy` `at` `slash` `files` `drag` | — | state pro/free | the composer state |
| `insp:<type>` | — | refs | inspector on the type's fixture ref |

Live (real-model) transcripts, one per mode: `ask-transcripts/live/{fast,smart,thinking}.sse` — the reducer's tests run
on these too.

## 12. Motion (all off under `prefers-reduced-motion`, L43)

`ask-rise` (10px rise, .36–.42s `cubic-bezier(.2,.7,.2,1)`), `ask-screen` (6px), `ask-pop` (scale .94 + 3px, .12–.2s
`cubic-bezier(.2,.9,.3,1.2)`), `ask-fade`, `ask-spin` (.8s), `ask-blink` (cursor 1.1s), `ask-pulse` (thinking 1.6s),
`ask-grow-y` (bars .55s), `ask-wipe` (theme lanes / progress .7s), `ask-insp-in` (18px from the right .3s), `ask-ia`/`ask-ib`
(inspector view swap), `ask-panel-in`, `ask-sheet-up`, `ask-drawer-in` (L28–43). Keyframes live in trov.css's Ask block
under the `ask-` prefix.

## 13. House rules for the build (read with `docs/architecture/web-ui.md`)

- Tokens: the design's `--fg-70/55/40`, `--border(-strong/-input)`, `--hover`, `--accent(-soft/-fg)`, `--surface`, `--bg`,
  `--green/amber/blue/red`, `--p-*`, `--menu-shadow`, `--lift-shadow` exist in the app. The design's `--row-on`,
  `--row-ring` and `--scrim` do NOT: the Ask shell block defines them as `--ask-row-on`, `--ask-row-ring`,
  `--ask-scrim` (both themes). The design's `'Archivo Narrow'` labels become `var(--label)` (Geist in the app —
  Archivo Narrow is the sidebar's alone), never a literal font name; mono is `var(--code)`.
- Radii: inline `border-radius:Npx` with a value already in the corners block (3, 5, 6, 7, 8, 9, 10, 12, 14 …); a NEW
  value or a CLASS that declares a radius needs a line in the corners block at the end of trov.css (in the
  `Ask` sub-block there) — `test/render.corners.test.ts`.
- States are marks (`marks.ts`); a RefView status maps `{ mark, tone }` → `glyph()` / `markShape()` (`ask-refs.ts`
  `refStatusMark`).
- Switches: `segmented()`; menus are our own popovers (Escape stack, `role="menu"` / `menuitemradio`, keyboard);
  never a native `<select>`; never a button inside a button (`hitArea`); people through `people.ts`; confirmations
  `confirmModal`.
- The Ask page is `data-morph="ask"` (typing never rebuilds it); the ⌘J panel and the hover card are root-level
  `data-overlay`s that repaint themselves.
- Nothing on a render path fetches; reads happen in the controller.
