# Prompt card copy slug — end-to-end browser test log

Feature: a copy-slug button in each Prompt Library card's top left, and `cursor:pointer` on every `hitArea` card
(`feat/prompt-card-copy-slug`). Base: `origin/main` 17a530a4.

**Spec sources** (the "source" column):
- **O1** — owner: "In the top left of the prompt card there should be a copy slug button, basically something simple
  for us to give to the agent fast."
- **O2** — owner: the hover state over the cards "doesn't turn the mouse into the select state like it should for
  something pressable — fix that too."
- **T** — the coordinator's task: copy the slug; reuse the app's existing copy pattern, icon and confirmation;
  clicking copies only and must NOT open the prompt; `hitArea`, never a button inside a button; an accessible label
  ("Copy slug") and a `data-mtip` tooltip; keyboard-reachable; plain slug by default; prompt cards that open on
  click and the copy button show `cursor: pointer`; fix a shared cause at the shared level but only for things that
  really are clickable.
- **CL** — CLAUDE.md's binding rules (marks / `data-mtip`, corners, focus rings, reduced motion, no `window.confirm`…).
- **code** — behaviour the change must keep (the existing hitArea cards, the release-notes rules in `releases.ts`).

**Browser:** headless Chromium via Playwright 1.63 scripts (`/tmp/claude-1000/-home-andresl-Projects-trov/84b29fb1-e762-4297-bd67-750b9f852306/scratchpad/e2e/run.mjs`, not
committed), against `wrangler dev` on localhost — branch :8814 (inspector 9414), base :8834 (inspector 9434, the shared
baseline worktree of 17a530a4). Local D1 only.

**Run history:** a first run of this log died part-way (the machine ran out of memory with five e2e runs at once) and
recorded no results; every case below was re-run from scratch in the recovery run (2026-10-17). The dead run's
screenshots are not used as evidence.

**Local environment (both):** `.dev.vars` written from `.dev.vars.example` — random `COOKIE_SECRET` / `TROV_KEK`,
`DEV_LOGIN=AndresL230`, and NO GitHub, Stripe, Anthropic, Resend or host keys (so the AI features are off: an
environment fact). Nothing in this feature calls out.

**Seed:** `npm run dev` (or `node scripts/dev/ensure-seeded.mjs`) seeds the scenarios, then
`node scripts/seed/prompt-card-copy-slug.mjs` writes the `test-copy-*` fixtures (idempotent: it deletes every
`test-copy-*` row first; `--check` prints the check, `--clean` removes them; `--persist-to=<checkout>/.wrangler/state`
writes them into another checkout's local D1, which is how the base server was seeded from the branch's checkout). Fixtures: `prompt-published`,
`prompt-staged`, `prompt-draft`, `prompt-long-slug` (60 characters), `prompt-hostile` (HTML / quotes / emoji title),
`prompt-deleted` (soft-deleted); and from the dev seed `library-many` (SaplingLearn, 17 live prompts),
`library-empty` and `review-none` (Day One Labs), `review-some` (SaplingLearn: 5 staged proposals, 4 draft ADRs).
Roles in SaplingLearn: AndresL230 owner, Jose-Gael-Cruz-Lopez admin, meilin member (sign-in: `/auth/dev/as?handle=…`).

**Screenshots:** `/tmp/claude-1000/-home-andresl-Projects-trov/84b29fb1-e762-4297-bd67-750b9f852306/scratchpad/e2e/prompt-card-copy-slug/`
(not committed). File names are the case ids.

## Baseline

Taken in the recovery run, before any case, with both dev servers stopped for the suites.

| | branch `feat/prompt-card-copy-slug` (4dfba991) | base `origin/main` (17a530a4) |
| --- | --- | --- |
| `npm test` | 1 failed \| 8574 passed (390 files) — the one failure is `test/ai.brief.test.ts` › "a number the input does not have drops the line…" (the known date failure) | 1 failed \| 8572 passed — the same `ai.brief` test (pre-existing) |
| `npm run typecheck` | pass | pass |

Pre-existing surfaces on base, same seed (`results-base.json` / `base-*.png` in the screenshot folder):
- **Prompt Library** (`base-B01.png`): 17 cards, no copy button; the cursor over a card's body is `auto` (the arrow) — the
  owner's O2 bug, reproduced (C33 base).
- **Feed › Waiting on review** (`base-C40-box.png`): 5 rows; cursor over a row `auto` for owner, member and dark (C40, C43,
  C46 base) — the same shared cause.
- **Other hitArea cards** (handoff rows, artifact cards, ticket board `grab`, ticket table, sprint boxes, Review items,
  Ask items, landing mockups): already `pointer` / `grab` on base, because each sets its own cursor (C50–C58 base).
- **Prompt page's copy icon**: unchanged, "Prompt copied" (C70 base). Pressed under reduced motion it still scales to
  0.96 (B26) — pre-existing.
- **Console before touching anything:** none on the library, feed, tickets, roadmap, review, ask, releases. On
  `#artifacts` two "Blocked script execution … the document's frame is sandboxed" lines from the artifact previews'
  sandboxed iframes, on base and branch alike (pre-existing, unrelated). No failed requests on any page.

## Result

**60 cases: 57 pass, 0 fail, 1 pre-existing (C26), 2 question (C27, C28).** No fix was needed, so the branch has no fix
commits. The final pass reran the whole matrix from a clean seed on :8814 (`branch-final.txt`); every result below is
from that run (C36 and the dark cases were first rerun after correcting the runner, see their rows).
Raw results: `/tmp/claude-1000/-home-andresl-Projects-trov/84b29fb1-e762-4297-bd67-750b9f852306/scratchpad/e2e/results-branch.json`, `results-base.json`.

**Final suite (servers stopped):** `npm test` 1 failed | 8574 passed — only the pre-existing `ai.brief` date test, the
same as the baseline; `npm run typecheck` passes. Nothing that passed in the baseline fails now.

**Questions for the owner:**
- **C27** — does copying a slug count as a use of the prompt? Built: no (no `/used` call, `use_count` unchanged), on the
  reasoning that the agent's `get_prompt` is the use. I'd keep that.
- **C28** — the wording. Built: aria-label "Copy slug <slug>", tooltip "Copy the slug to give an agent", toast
  "Slug copied · <slug>". The brief named the label "Copy slug"; the slug is appended so screen-reader users can tell
  the 17 buttons apart. I'd keep it.

**Pre-existing, not fixed:**
- **C26** — `.cnpy-iconbtn:active` scales to 0.96 with a 0.15s transition even under `prefers-reduced-motion`
  (trov.css chrome block, no reduced-motion override). The new copy button inherits it; the prompt box's copy icon on
  base does the same (B26).
- `#artifacts` logs two "Blocked script execution" console lines from sandboxed preview iframes (C51, base and branch).

## Matrix

Surfaces × the dimensions that apply. Count: **60 cases** (≤ 150). (The dead run wrote 63; the rows below add up to 60: 28 + 6 + 3 + 7 + 9 + 6 + 1.)

| Surface | Dimensions crossed | Cases |
| --- | --- | --- |
| S1 Prompt card — copy button | status (published / staged / draft), long slug, hostile title, deleted; owner / admin / member; desktop / 360px; light / dark; clipboard ok / denied → fallback / fully denied / no Clipboard API; keyboard (Tab, Enter, Space, focus ring, tooltip on focus); hover tooltip; double click; filtered list; reduced motion; no `/used` write | 28 |
| S2 Prompt card — card body and author | click / tap opens; author chip opens person card; cursor body / chip; keyboard Enter on the card | 6 |
| S3 Prompt Library — loading, empty, no match | slow `/api/prompts`; `library-empty`; a search that matches nothing | 3 |
| S4 Feed › Waiting on review rows (cursor fix) | `review-some` / `review-none`; owner / member; desktop light / dark / 360px; click row, click person | 7 |
| S5 Other hitArea cards (regression of the shared fix) | handoff rows, artifact cards, ticket board (grab), ticket table, sprint ticket boxes, Review list, Ask item cards, landing feature mockups | 9 |
| S6 Help › What's new (the Unreleased entry) | index, notes, patches, phone width, 0.11 still reachable, the support form's attached version | 6 |
| S7 Prompt page — the prompt box's copy icon (shared `ICON_BTN`) | copy prompt | 1 |
| X Every case | no console error, no unexpected failed request, no horizontal scroll | (checked on each) |

**Dropped combinations:**
- Cursor × phone width: a touch screen has no pointer cursor; the cursor cases run at desktop width only.
- Cursor × dark theme: `cursor` does not depend on the theme; one dark screenshot per surface covers readability.
- Role × S2/S3/S5 beyond one role: the card markup and the CSS do not branch on role (`promptCard` takes no role).
- Signed out × S1–S5: the Prompt Library, Feed and the cards need a session (the session gate answers 401); only the
  landing mockups (S5-08) are seen signed out.
- Plan / AI switch: nothing in this feature reads the plan or the AI switch.
- Tooltip on a phone: `data-mtip` shows on hover or keyboard focus; a tap gives neither (same as every mark).
- Unicode / injection in the SLUG itself: a slug is `slugify`d (`[a-z0-9-]`, ≤ 60) on every save path, so only the
  title carries hostile text (prompt-hostile); the long slug covers the length limit.

## Cases

| id | surface | state (fixture, role, viewport, theme) | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| C01 | S1 | prompt-published, owner, 1440, light | Copy icon top left of the card; click → clipboard holds exactly `test-copy-published`; toast "Slug copied · test-copy-published" (the existing `flash` toast); hash stays `#prompts`; no console error | O1, T | clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts hscroll=false pos={"dx":12,"dy":13,"w":26,"h":26,"cardW":365.703125} usedRequests=[]; no console errors, no failed requests | pass | branch-C01.png, branch-C01-card.png | — |
| C02 | S1 | prompt-published, owner, 1440, dark | As C01; icon and toast readable in dark | O1, T, CL | clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts hscroll=false theme/icon/bg=["dark","rgba(237, 233, 226, 0.55)","rgb(28, 26, 22)"]; no console errors, no failed requests (dark set via the app's stored `trov.theme`; the first attempt only set the browser's colour scheme, which the app does not follow by default, so it ran light — runner fixed and rerun) | pass | branch-C02.png, branch-C02-card.png | — |
| C03 | S1 | prompt-published, owner, 360, light | Tap copy → same clipboard + toast, prompt not opened; no horizontal scroll; button ≥ the icon-button size used elsewhere (26px) | O1, T | clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts hscroll=false button=26x26; no console errors, no failed requests | pass | branch-C03.png, branch-C03-card.png | — |
| C04 | S1 | prompt-published, owner, 360, dark | As C03 in dark | O1, T | clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts hscroll=false theme=dark; no console errors, no failed requests (dark set via the app's stored `trov.theme`; the first attempt only set the browser's colour scheme, which the app does not follow by default, so it ran light — runner fixed and rerun) | pass | branch-C04.png, branch-C04-card.png | — |
| C05 | S1 | prompt-staged, owner, 1440, light | Card shows the copy icon AND the "Staged" mark; copy → `test-copy-staged` | O1 ("each prompt card") | clipboard="test-copy-staged" toasts=["Slug copied · test-copy-staged"] hash=#prompts hscroll=false card="Test copy: staged by an agent test-copy-staged Staged Staged body. api JO@Jose-G"; no console errors, no failed requests | pass | branch-C05.png, branch-C05-card.png | — |
| C06 | S1 | prompt-draft, owner, 1440, light | Card shows the copy icon and the "Draft" mark; copy → `test-copy-draft` | O1 | clipboard="test-copy-draft" toasts=["Slug copied · test-copy-draft"] hash=#prompts hscroll=false card="Test copy: draft test-copy-draft Draft Draft body. AN@AndresL230 · v1 12h ago"; no console errors, no failed requests | pass | branch-C06.png, branch-C06-card.png | — |
| C07 | S1 | prompt-long-slug, owner, 1440, light | Slug wraps inside the card (no overflow); copy → the full 60-character slug | O1, T | clipboard="test-copy-long-slug-for-the-narrow-card-wrap-check-012345678" toasts=["Slug copied · test-copy-long-slug-for-the-narrow-card-wrap-check-012345678"] hash=#prompts hscroll=false overflowingInCard=0; no console errors, no failed requests | pass | branch-C07.png, branch-C07-card.png | — |
| C08 | S1 | prompt-long-slug, owner, 360, light | As C07 at phone width; no horizontal scroll | O1 | clipboard="test-copy-long-slug-for-the-narrow-card-wrap-check-012345678" toasts=["Slug copied · test-copy-long-slug-for-the-narrow-card-wrap-check-012345678"] hash=#prompts hscroll=false overflowingInCard=0; no console errors, no failed requests | pass | branch-C08.png, branch-C08-card.png | — |
| C09 | S1 | prompt-hostile, owner, 1440, light | Title shown as literal text (no `<b>`, no `<img>` element, no dialog); copy → `test-copy-hostile`; label "Copy slug test-copy-hostile" | T, CL (esc) | clipboard="test-copy-hostile" toasts=["Slug copied · test-copy-hostile"] hash=#prompts hscroll=false {"imgs":0,"b":0,"title":true,"label":"Copy slug test-copy-hostile","dialogs":0}; no console errors, no failed requests | pass | branch-C09.png, branch-C09-card.png | — |
| C10 | S1 | prompt-deleted, owner, 1440, light | No card and no copy button for `test-copy-deleted` | code (soft delete hides everywhere) | elements for test-copy-deleted=0; copy buttons on the page=17 (17 live prompts); no console errors, no failed requests | pass | branch-C10.png | — |
| C11 | S1 | prompt-published, member meilin, 1440, light | Copy works the same (copy is not role-gated) | O1 ("for us") | clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts hscroll=false; no console errors, no failed requests | pass | branch-C11.png, branch-C11-card.png | — |
| C12 | S1 | prompt-published, admin Jose, 1440, light | Copy works the same | O1 | clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts hscroll=false; no console errors, no failed requests | pass | branch-C12.png, branch-C12-card.png | — |
| C13 | S1 | clipboard API rejects (permission denied), execCommand works | The existing pattern's fallback copies: clipboard holds the slug; toast "Slug copied · …"; prompt not opened | T (reuse the pattern: `copyToClipboard` falls back) | execCommand=[{"cmd":"copy","v":"test-copy-published","ok":true}] clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts; no console errors, no failed requests | pass | branch-C13.png | — |
| C14 | S1 | clipboard fully denied (API rejects AND execCommand fails) | Toast "Couldn't reach the clipboard" (the existing wording); prompt NOT opened; no console error | T (reuse the pattern's failure feedback) | toasts=["Couldn't reach the clipboard"] hash=#prompts toastMarkup="\n    <svg width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--accent)\" stroke-width=\"2.4\" style=\"flex:none;margin-top:2px\"><path d=\"M20 6 9 17l"; no console errors, no failed requests | pass | branch-C14.png | — |
| C15 | S1 | no Clipboard API (insecure-context shape) | Fallback path copies the slug; toast "Slug copied · …" | T | navigator.clipboard=undefined; execCommand=[{"cmd":"copy","v":"test-copy-published","ok":true}] toasts=["Slug copied · test-copy-published"] hash=#prompts; no console errors, no failed requests | pass | (text) | — |
| C16 | S1 | keyboard only, 1440 | Tab order inside the first card: copy button → author chip → the card; copy is reachable without a mouse | T ("keyboard-reachable") | tabs to first copy: ["fmToggle:prompt","promptCopySlug:Copy slug gemini-prompt-hardening"]; then: ["openPerson:Jose-Gael-Cruz-Lopez","openPrompt:Harden a Gemini agent prompt","promptCopySlug:Copy slug test-copy-staged"] (first card gemini-prompt-hardening); no console errors, no failed requests | pass | (text) | — |
| C17 | S1 | keyboard Enter on copy | Copies; does not open | T | Enter: clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts; no console errors, no failed requests | pass | (text) | — |
| C18 | S1 | keyboard Space on copy | Copies; does not open | T | Space: clipboard="test-copy-published" toasts=["Slug copied · test-copy-published"] hash=#prompts; no console errors, no failed requests | pass | (text) | — |
| C19 | S1 | keyboard focus ring | A visible 2px ring on the focused copy button | CL (Focus) | focused copy outline: 2px solid rgb(82, 92, 195) offset 1px; no console errors, no failed requests | pass | branch-C19.png | — |
| C20 | S1 | hover 1440 light | After ~300 ms the mark bubble shows the `data-mtip` text | T, CL | hover tip: Copy the slug to give an agent (data-on=1, opacity=1); no console errors, no failed requests | pass | branch-C20.png | — |
| C21 | S1 | keyboard focus tooltip | The bubble shows on keyboard focus too (tip.ts: "on hover … or keyboard focus") | code (tip.ts) | focus tip: Copy the slug to give an agent (data-on=1, opacity=1); no console errors, no failed requests | pass | branch-C21.png | — |
| C22 | S1 | double click copy | Two copies, two toasts at most one visible, never opens the prompt, no error | T | clipboard="test-copy-published" toasts seen=["Slug copied · test-copy-published"] toasts on screen=1 hash=#prompts; no console errors, no failed requests | pass | (text) | — |
| C23 | S1 | copy, then click the card body | First copies, second opens `#prompts/<slug>` | T | after copy hash=#prompts; after body click hash=#prompts/test-copy-published; no console errors, no failed requests | pass | (text) | — |
| C24 | S1 | search "test-copy" filtered list | Copy on a filtered card copies that card's slug | O1 | cards shown=1; clipboard="test-copy-draft" toasts=["Slug copied · test-copy-draft"]; no console errors, no failed requests | pass | branch-C24.png | — |
| C25 | S1 | cursor over copy button, 1440 | `pointer` | T ("and the copy button too") | cursor over copy: pointer (over svg.); no console errors, no failed requests | pass | (text) | — |
| C26 | S1 | reduced motion, press copy | No motion (CLAUDE.md: motion is off under reduced motion) | CL | pressed under reduced motion: transform=matrix(0.96, 0, 0, 0.96, 0, 0) transition=background, color, border-color, transform/0.15s, 0.15s, 0.15s, 0.15s; no console errors, no failed requests. **Base:** the prompt box's existing copy icon (same `.cnpy-iconbtn` class) does the same: prompt box copy icon pressed under reduced motion: class=cnpy-iconbtn transform=matrix(0.96, 0, 0, 0.96, 0, 0) transition=background, color, border-color, transform/0.15s, 0.15s, 0.15s, 0.15s; no console errors, no failed requests. Cause: `.cnpy-iconbtn:active { transform:scale(.96) }` (trov.css, chrome block) has no reduced-motion override; the new button only inherits it. | pre-existing | (text) | — |
| C27 | S1 | copy does not count as a use | No `POST /api/prompts/<slug>/used`; `use_count` unchanged in D1 | question — not in the spec (implemented: not a use) | requests to /used after copy: [] (use_count read from D1 separately); no console errors, no failed requests; D1 after all copy cases: `use_count`=0, `last_used_at`=NULL for every `test-copy-*` prompt (was 0 / NULL). | question | (text) | — |
| C28 | S1 | toast wording / label wording | "Slug copied · <slug>"; aria-label "Copy slug <slug>"; tip "Copy the slug to give an agent" | question — wording not in the spec | {"label":"Copy slug test-copy-published","tip":"Copy the slug to give an agent","type":"button","nested":false,"inHit":false}; no console errors, no failed requests; toast text seen in C01: "Slug copied · test-copy-published". The brief says the label is "Copy slug"; the build appends the slug ("Copy slug <slug>") so each of 17 buttons is told apart. | question | (text) | — |
| C30 | S2 | owner, 1440 | Click the card body → `#prompts/test-copy-published` opens | code | hash after click on body=#prompts/test-copy-published; no console errors, no failed requests. **Base:** hash after click on body=#prompts/test-copy-published; no console errors, no failed requests | pass | branch-C30.png | — |
| C31 | S2 | owner, 360 | Tap the card body → opens | code | hash after tap on body=#prompts/test-copy-published; no console errors, no failed requests. **Base:** hash after tap on body=#prompts/test-copy-published; no console errors, no failed requests | pass | branch-C31.png | — |
| C32 | S2 | owner, 1440 | Click the author chip → the person card opens, the prompt does not | code | hash=#prompts; dialog="MZ Meilin Zhao @meilin ROLEProduct manager JOINEDJan 2026 GI"; no console errors, no failed requests. **Base:** hash=#prompts; dialog="MZ Meilin Zhao @meilin ROLEProduct manager JOINEDJan 2026 GI"; no console errors, no failed requests | pass | branch-C32.png | — |
| C33 | S2 | owner, 1440 | Cursor over the card body = `pointer` (base: the arrow) | O2, T | cursor over card body: pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** cursor over card body: auto (over button.cnpy-hit); no console errors, no failed requests → the owner's bug (O2) reproduced on base and fixed on the branch | pass | (text) | — |
| C34 | S2 | owner, 1440 | Cursor over the author chip = `pointer` | code | cursor over author chip: pointer (over span.); no console errors, no failed requests. **Base:** cursor over author chip: pointer (over span.); no console errors, no failed requests | pass | (text) | — |
| C35 | S2 | keyboard | Tab to the card's hit area, Enter → opens the prompt | code | hash after Enter on the card=#prompts/test-copy-published; no console errors, no failed requests. **Base:** hash after Enter on the card=#prompts/test-copy-published; no console errors, no failed requests | pass | (text) | — |
| C36 | S3 | `/api/prompts` delayed 3 s | Skeleton cards keep the card's shape (an icon-sized box beside title + slug); no layout jump to the loaded cards' header | code (skeleton = the card's shape) | skeleton shown=true header={"headerH":41,"iconW":13,"titleX":44} loaded header={"headerH":41,"titleX":44}; no console errors, no failed requests. **Base:** skeleton shown=true header={"headerH":21,"iconW":262,"titleX":289} loaded header={"headerH":22,"titleX":291}; no console errors, no failed requests | pass | branch-C36-loading.png, branch-C36-loaded.png | — |
| C37 | S3 | library-empty (Day One, robin-vale) | The empty layout and "New prompt"; no copy button; no error | code | copy buttons=0; text="Prompt Library New prompt Filter 0 shown · 0 staged No prompts yet. The team's reusable prompts live here, each with a slug, tags, and {{variables}} for the par"; no console errors, no failed requests. **Base:** copy buttons=0; text="Prompt Library New prompt Filter 0 shown · 0 staged No prompts yet. The team's reusable prompts live here, each with a slug, tags, and {{variables}} for the par"; no console errors, no failed requests | pass | branch-C37.png | — |
| C38 | S3 | search "zzzz-no-match" | "No prompts match"; no copy button | code | copy buttons=0; "No prompts match" shown=1; no console errors, no failed requests | pass | (text) | — |
| C40 | S4 | review-some, owner, 1440, light | Cursor over a "Waiting on review" row = `pointer` (base: the arrow) | O2, T (shared cause) | rows=5; cursor over a row's title: pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** rows=5; cursor over a row's title: auto (over button.cnpy-hit); no console errors, no failed requests → the owner's bug (O2) reproduced on base and fixed on the branch | pass | branch-C40-box.png | — |
| C41 | S4 | review-some, owner, 1440 | Click a row → Review opens on that item | code | clicked "Infrastructure — Data, Observability, Security & Deploy" → hash=#review; selected="Infrastructure — Data, Observability, Security & Deploy Low confidence Trov: the"; no console errors, no failed requests. **Base:** clicked "Infrastructure — Data, Observability, Security & Deploy" → hash=#review; selected="Infrastructure — Data, Observability, Security & Deploy Low confidence Trov: the"; no console errors, no failed requests | pass | branch-C41.png | — |
| C42 | S4 | review-some, owner, 1440 | Click the proposer's handle in a row → person card, cursor `pointer` | code | person links=4; cursor=pointer (over span.); after click hash=#feed dialog="LU Luke @lpcooper-arch ROLEFrontend engineer JOINE"; no console errors, no failed requests. **Base:** person links=4; cursor=pointer (over span.); after click hash=#feed dialog="LU Luke @lpcooper-arch ROLEFrontend engineer JOINE"; no console errors, no failed requests | pass | (text) | — |
| C43 | S4 | review-some, owner, 1440, dark | Readable; pointer | O2 | theme=dark; cursor=pointer (over button.cnpy-hit); title colour / page bg=["rgb(237, 233, 226)","rgba(0, 0, 0, 0)"]; no console errors, no failed requests. **Base:** theme=dark; cursor=auto (over button.cnpy-hit); title colour / page bg=["rgb(237, 233, 226)","rgba(0, 0, 0, 0)"]; no console errors, no failed requests → the owner's bug (O2) reproduced on base and fixed on the branch (dark set via the app's stored `trov.theme`; the first attempt only set the browser's colour scheme, which the app does not follow by default, so it ran light — runner fixed and rerun) | pass | branch-C43-box.png | — |
| C44 | S4 | review-some, owner, 360 | Box shown below the feed, no horizontal scroll | code | rows=5 hscroll=false; no console errors, no failed requests. **Base:** rows=5 hscroll=false; no console errors, no failed requests | pass | branch-C44.png, branch-C44-box.png | — |
| C45 | S4 | review-none (Day One), 1440 | "Nothing waiting on review."; nothing in the box shows a pointer | T ("only for things that really are clickable") | text="Waiting on review Review Nothing waiting on review."; pointer elements=["button[goReview]"]; no console errors, no failed requests. **Base:** text="Waiting on review Review Nothing waiting on review."; pointer elements=["button[goReview]"]; no console errors, no failed requests | pass | branch-C45-box.png | — |
| C46 | S4 | review-some, member meilin, 1440 | Same box and pointer as for the owner (the box is not role-gated) | code | member rows=5; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** member rows=5; cursor=auto (over button.cnpy-hit); no console errors, no failed requests → the owner's bug (O2) reproduced on base and fixed on the branch | pass | branch-C46-box.png | — |
| C50 | S5 | handoff rows (#handoffs), 1440 | `pointer`, same as base | code | 10 × .cnpy-hrow.cnpy-hitbox; cursor=pointer (over div.cnpy-av); no console errors, no failed requests. **Base:** 10 × .cnpy-hrow.cnpy-hitbox; cursor=pointer (over div.cnpy-av); no console errors, no failed requests | pass | branch-C50.png | — |
| C51 | S5 | artifact cards (#artifacts) | `pointer`, same as base | code | 10 × .cnpy-hitbox:has(> [data-act=artOpen]); cursor=pointer (over button.cnpy-hit); console: 2 × "Blocked script execution in …/raw/a/… because the document's frame is sandboxed" (the artifact previews' sandboxed iframes). **Base:** 10 × .cnpy-hitbox:has(> [data-act=artOpen]); cursor=pointer (over button.cnpy-hit); console: 2 × "Blocked script execution in …/raw/a/… because the document's frame is sandboxed" (the artifact previews' sandboxed iframes) (the same two console lines on base: pre-existing, unrelated to this feature) | pass | branch-C51.png | — |
| C52 | S5 | ticket board cards (#tickets board) owner | `grab` where the card can be dragged, same as base | code | 87 × .cnpy-tcard[data-tdrag]; cursor=grab (over button.cnpy-hit); no console errors, no failed requests. **Base:** 87 × .cnpy-tcard[data-tdrag]; cursor=grab (over button.cnpy-hit); no console errors, no failed requests | pass | branch-C52.png | — |
| C53 | S5 | ticket table rows | `pointer`, same as base | code | 87 × .cnpy-trow.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** 87 × .cnpy-trow.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests | pass | branch-C53.png | — |
| C54 | S5 | sprint ticket boxes (Roadmap › sprint) | `pointer`, same as base | code | 8 × .cnpy-tcard.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** 8 × .cnpy-tcard.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests | pass | branch-C54.png | — |
| C55 | S5 | Review list items | `pointer`, same as base | code | 9 × .cnpy-titem.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** 9 × .cnpy-titem.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests | pass | branch-C55.png | — |
| C56 | S5 | Ask item cards | `pointer`, same as base | code | 3 × .ask-ci.cnpy-hitbox, .ask-one.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** 3 × .ask-ci.cnpy-hitbox, .ask-one.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests | pass | branch-C56.png | — |
| C57 | S5 | non-hitArea text on My Work / Docs | unchanged (`auto`) — the fix does not reach non-clickable content | T | 2 × main h1, main h2, [data-screen-label] h2; cursor=auto (over h1.); no console errors, no failed requests. **Base:** 2 × main h1, main h2, [data-screen-label] h2; cursor=auto (over h1.); no console errors, no failed requests | pass | branch-C57.png | — |
| C58 | S5 | landing feature mockups (signed out, /) | `pointer`, same as base | code | 7 × .site-fxcard.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests. **Base:** 7 × .site-fxcard.cnpy-hitbox; cursor=pointer (over button.cnpy-hit); no console errors, no failed requests | pass | branch-C58.png | — |
| C60 | S6 | #releases, owner, 1440 | First card "Unreleased", tagged, "3 highlights · 1 patch line" | code (releases.ts header) | first card="Unreleased · Not deployed yet Smaller fixes Quicker ways to hand work to an agent, and cards that look as pressable as they are. 3 highlights · 1 patch line"; no console errors, no failed requests | pass | branch-C60.png | — |
| C61 | S6 | #releases/unreleased | Title, headline, three highlights; "Not deployed yet" | code | has title=true notDeployed=true highlight=true; no console errors, no failed requests | pass | branch-C61.png | — |
| C62 | S6 | #releases/unreleased/patches | The one Added line ending "(#999)" | T (placeholder number) | line present=true #999 link=https://github.com/AndresL230/trov/pull/999; no console errors, no failed requests | pass | branch-C62.png | — |
| C63 | S6 | #releases at 360 | No horizontal scroll | code | hscroll=false; no console errors, no failed requests | pass | branch-C63.png | — |
| C64 | S6 | #releases/0.11 | Still the 0.11 notes | code | 0.11 title present=true; no console errors, no failed requests. **Base:** 0.11 title present=true; no console errors, no failed requests | pass | branch-C64.png | — |
| C65 | S6 | support form version | The support form attaches version "Unreleased" (`LATEST_VERSION`) | code (release-latest.ts) | support dialog text="Report a bug Something broke or looks wrong. Tell us what you did and what happened. Bug Question Feedback SUBJECT (optional) MESSAGE SENT WITH YOUR MESSAGE Screen #mywork Organization saplinglearn Version Unreleased Browser Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36 Nothing else is attached: no page content, and nothing from … | pass | branch-C65.png | — |
| C70 | S7 | prompt page, 1440 | The prompt box's copy icon unchanged; "Prompt copied" | code | icon 26x26 width:26px;height:26px;display:grid;place-items:center;border-radius:6px;color:var(--fg-55);flex:none; clipboard="Second body for {{target}}." toasts=["Prompt copied"]; no console errors, no failed requests. **Base:** icon 26x26 width:26px;height:26px;display:grid;place-items:center;border-radius:6px;color:var(--fg-55);flex:none; clipboard="Second body for {{target}}." toasts=["Prompt copied"]; no console errors, no failed requests | pass | branch-C70.png | — |
