# Phase H e2e, Tier 1 — group `ask` (Ask Trov: AK the API, AR the dev replay, AU the screen)

Procedure: `docs/superpowers/specs/2026-10-15-server-ai-e2e.md`; cases: `docs/testing/server-ai-test-matrix.md` § 5 (AK, AR,
AU), § 6 (the AU environment rows), § 7 (MO-42…MO-52), Tier 1 per § 10. Branch `ai/e2e-ask` from `af26ce3c`.
Screenshots: [`server-ai-shots/ask/`](server-ai-shots/ask/) (named by case id; the final pass's outputs in `final/`).

## Setup

- Worktree of `ai/e2e-ask`, its own local D1 (`npx wrangler d1 migrations apply trov --local`), `node
  scripts/seed/server-ai-e2e.mjs` (121 of 121 fixtures) then `node scripts/seed/repo-setups.mjs` (AU-26 only); the seed
  was re-run before every case that writes. `wrangler dev --port 8810 --inspector-port 9810` beside `vite build --watch
  --emptyOutDir false` (the `npm run dev` pair, on this worktree's port only).
- `.dev.vars` from `trov-preview-ai`: no AI key, no Stripe key, `NOTIFICATIONS_MODE=local`, **`DEV_LOGIN` unset** (it
  overrides every cookie; the matrix signs in by cookie), `PUBLIC_ORIGIN` unset (see Pre-existing P-1).
- **`LOCAL_AI_PREVIEW`**: unset for AK-* and AR-1; **`ready` for AR-2…AR-10, every AU-*, EV-* and MO-* case** (the replay
  route needs it; the AK reads do not touch it — `src/ai/ask/routes.ts` never reads the preview).
- Never a key: no `ANTHROPIC_API_KEY`, not even the matrix's `K:dummy` (the K:dummy refusal cases are Tier 2 and were
  not run; the composer's capped / off states read `/ask/state`'s allowance and switch, which need no key).
- Browser: Playwright's Chromium (headless), desktop 1440×900, phone 360×780; dark = the app's own theme setting
  (`localStorage trov.theme`, the app does not follow the media query alone) plus `prefers-color-scheme: dark`;
  reduced motion emulated. Signed in by the `session` cookie (`test-session-<handle>`); AK cases call the routes with
  the page's own `fetch`. Every case also checked: horizontal scroll, page errors, console errors and failed
  requests.
- The design was rendered for comparison from `docs/superpowers/specs/ask-trov.dc.html` (+ its support.js) per
  scenario (`?scenario=<s>&theme=light`) at the same viewport.

## Baseline

- This branch at `af26ce3c`: typecheck **pass**. The full suite at the integrator's last gate (ai/ask merged, `b0b36a47`
  → `af26ce3c`): 8202/8202 green (STATE.md); not re-run before the cases (RULES § 1: once, at the final commit).
- Ask is new in this build: no surface of it exists on `main` (baseline :8800). The Tickets page (it gains "Ask about
  this ⌘J") and Settings (it gains three tiles) existed; neither showed a console error or a failed request before any
  case touched them.
- Before any case: no console error on `#ask`, `#ask/<id>`, `#tickets/<n>`, `#settings`.

## Results

**159 cases run** (157 Tier 1 + the owner's AU-OWNER-1 and AU-OWNER-2): 39 AK · 10 AR · 45 AU (AU-24 counted per scenario, AU-27 per phone scenario) · 23 added AU
(marked *added*) · 30 EV · 11 MO.

| result | count |
| --- | --- |
| pass | 128 |
| fail → fixed (17 bugs) | 21 |
| question | 9 |
| pre-existing | 1 |

### AK — the API (in the page's own `fetch`; preview unset, no key)

| id | state | expected | source | actual | result | evidence | fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AK-1 | ent · member | `/ask/state`: enabled, `no_key`, enterprise, 3 modes, default fast, allowance 64/null not low, autoAllowed, attach 5/10485760/[image,pdf,text], ≤4 starters, "What shipped this week?" first, "Summarize ticket #…" | R:119-140 | exactly that; starters "What shipped this week?", "Summarize ticket #4", "What's blocking the test-Sprint Hosting work?", "What's waiting on me?" | pass | ak-reads.out | — |
| AK-2 | free · member | modes [smart], default smart despite stored thinking, cap 50 used 20 | `defaultModeOf` | exactly | pass | ak-reads.out | — |
| AK-8 | member | peek order: #1 "In progress", 999 hidden, doc Live, private artifact hidden, person lowercased, foo hidden | refs.ts | exactly | pass | ak-reads.out | — |
| AK-11 | member | `/ask/item/<ref>` `{view, detail}` per type | R:155-235 | ticket {ticket, artifacts, prs}; pr {what, why, impact, linkedTo, files null, …}; doc {body, staged, versions}; sprint {sprint}; handoff {handoff}; feed {entry}; person {recentPrs}; repo `{}` (the inspector reads `/repo/dashboard`) | pass | ak-reads.out | — |
| AK-12 | member | 999 / another's private artifact → 404 `{ref, hidden}` | R:162 | 404 `{ref, hidden:true}` both | pass | ak-reads.out | — |
| AK-13 | member | `/ask/item/%25` 404/400, never 500 | inv. 7, ask.md | 404 `{ref:"%", hidden:true}` (Q49 fixed in the build) | pass | ak-reads.out | — |
| AK-18 | no key | `POST /ask {text:"hi"}` → SSE `error no_key` "Ask Trov is not set up on this deployment." | R:360 | exactly, one event, nothing stored | pass | ak-reads.out | — |
| AK-19 | no key | `/search netlify`: thread → activity run "Searched Trov for 'netlify'" → done "N results" → text → items block (≤9) → thread "Search: netlify" → done tokens 0; not metered | R:500-528 | sent as the client sends it (`command:"search"`, text `"netlify"` — the composer strips the word, `parseCommand`): exactly, 4 results, `ai_chat` stays 64. (The matrix's body with the literal "/search netlify" in `text` searches for that phrase: "No results".) | pass | ak-19.out, ak-reads.out | — |
| AK-20 | no key | `x` → "Nothing in Trov matches “x”." | R:513 | exactly | pass | ak-reads.out | — |
| AK-23 | member | unknown key, no mode, 16001 chars, 13 context, 6 attachments, threadId 0 → 400 each | ai-ask.ts | 400 ×6 | pass | ak-reads.out | — |
| AK-24 | member | another person's (801006) / org's (814001) thread → 404 | R | 404 both (+ GET 801006 404) | pass | ak-reads.out | — |
| AK-28 | search, panel, context [ticket:1, private artifact] | stored context keeps ticket:1 only; context_ref ticket:1 | R:316-334 | thread origin panel, contextRef ticket:1, question context [ticket:1] | pass | ak-w1.out | — |
| AK-29 | replaceFrom last question of 801001 | old Q+A `replaced_at`, out of FTS; undecided cards expire | `replaceMessagesFrom` | 801101/801102 replaced; 9 undecided cards expired, decided ones untouched; FTS "blocking" now a title-only hit | pass | ak-w2.out | — |
| AK-30 | member | pinned first, then by updated_at; groups; untitled listed `""`; not 801006 | R:611 | exactly | pass | ak-reads.out | — |
| AK-31 | `?q=webhook` | hits with `snippet{text,matches}` | R | 801003, "Where are webhook retries?" [10,17] | pass | ak-reads.out | — |
| AK-32 | `?q="unbalanced` | `[]` | data/ask.ts | `{hits:[]}` 200 | pass | ak-reads.out | — |
| AK-33 | GET 801001 | cards on 801102, `editable` only for proposed/waiting, `note:null` on the waiting card (Q55) | R | exactly — Q55 still open | pass (Q55 open) | ak-19.out | — |
| AK-37 | PATCH 801003 pinned | moves to Pinned, updated_at unchanged | R | exactly | pass | ak-w1.out | — |
| AK-38 | DELETE 801003 twice | ok, then 404; messages/cards gone | R | ok / 404; rows 0/0/0 | pass | ak-w1.out + rows | — |
| AK-39 | export 801004 (injection) | text/markdown, filename stripped, `# title`, **You** / **Trov (smart)**, HTML stays text | R | `test-img-srcx-onerroralert1-Rsum.md`; body as expected, HTML verbatim as text | pass (Q56 open) | ak-w1.out | — |
| AK-40 | save-form 801102 twice | save_form block "test-What is blocking #1?, Oct 15", markdown, private; twice → two | R:702 | index 0 then 1 | pass | ak-w1.out | — |
| AK-42 | save 801102 | slug + url; artifact area data, linked to tickets 1 and 2; chat_artifacts role saved | R:717 | test-saved, area data, private, links ticket 1+2, role saved | pass | rows | — |
| AK-44 | confirm 801201 | confirmed, ref ticket:15, undo; requester test-member | R:766 | exactly | pass | ak-w1.out + rows | — |
| AK-45 | confirm 801202 | confirmed; #1 testing | tickets-agent | exactly (after AK-55's undo) | pass | rows | — |
| AK-46 | confirm 801214 | 200, state failed, code forbidden | lane | exactly | pass | ak-w1.out | — |
| AK-47 | confirm 801203 (group) | both 801203 + 801204 confirmed in id order | R | #16, #17 | pass | ak-w1.out | — |
| AK-48 | confirm 801203 with args | edited title used; `{nope:1}` → 400 "not editable: nope", state restored | R | 400 then proposed/proposed; then confirmed "test-Edited" (that card alone, as the client sends edits) | pass | ak-w2.out | — |
| AK-49 | confirm 801207 / 801208 | 409 expired; 801208 becomes expired | R | exactly | pass | ak-w1.out + rows | — |
| AK-51 | confirm 801206 (publish) | staged v2 promoted as test-member | #12 § 2.12 | v2 promoted | pass | rows | — |
| AK-54 | cancel 801205; cancel 801207 | cancelled; 409 expired | R | exactly ("This card is expired.") | pass | ak-w1.out | — |
| AK-55 | undo 801211 | #1 back to triage; card undone | R | #1 submitted; undone | pass | ak-w1.out | — |
| AK-56 | undo 801212 | 409 changed "Changed since. Undo it by hand." + ref | R | exactly, ref ticket:4 | pass | ak-w1.out | — |
| AK-58 | 10485760-byte text | 200, private artifact, new thread | attachments.ts | 200, thread 814005, kind text | pass | ak-w1.out + rows | — |
| AK-59 | 10485761 bytes | 413 too_large "<name> is too large. Files can be up to 10 MB." | same | exactly | pass | ak-w1.out | — |
| AK-63 | wrong source_wrong twice | ok both; one ai_feedback + one ask_flags per cite; second adds nothing | R:915 | 1 feedback; flags ticket:1, ticket:2 once | pass | rows | — |
| AK-66 | GET settings | instructions + fast + modes | R | exactly | pass | ak-reads.out | — |
| AK-67 | PUT 501 / 250×🚀 | 400 / 200 | schema | 400 / 200 | pass | ak-w1.out | — |
| AK-69 | PUT "" | cleared | R | `instructions:""` | pass | ak-w1.out | — |
| AK-70 | stop 801001 | ok; stop_requested=1 | R | exactly | pass | rows | — |

### AR — the dev replay

| id | state | expected | actual | result | evidence |
| --- | --- | --- | --- | --- | --- |
| AR-1 | preview unset | 404 index and scenario | 404 `not_found` both | pass | ar unset |
| AR-2 | P:ready | `{scenarios (17), questions, state{pro,free}, settings, threads, search, refs}` | exactly, 17 | pass | ar.out |
| AR-3 | 127.0.0.1 / [::1] / LAN | 200 / 404 / 404 | 200 / 404; a LAN address cannot be reached (wrangler dev binds loopback only) | pass | ar.out |
| AR-4 | answer speed 0 | event-stream, all at once, ends `done` | 187 events in 186 ms, last `done` | pass | ar.out |
| AR-5 | streaming | stops at text token 58, no done | 58 text events, last `text`, no done | pass | ar.out |
| AR-6 | thinking speed 1 | ~14 s pause then thinking done seconds 14 | run → done 14 s (24 s for the whole turn) | pass | ar.out |
| AR-7 | live / ticket / settings | 200, empty body | 200, 0 bytes each | pass | ar.out |
| AR-8 | /nope | 404 | 404 | pass | ar.out |
| AR-9 | speed -3 / abc / 999 | 0 / 0 / 50 | 11 ms / 10 ms / 381 ms (≈ 24 s ÷ 50) | pass | ar.out |
| AR-10 | ai-off org | still replays | 187 events, done | pass | ar.out |

### AU — the Ask screen (P:ready; real routes unless the state says replay)

| id | state | expected | source | actual | result | evidence | fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AU-1 | member | one "Trov" row after My Work, constellation icon; nothing else moves | #12 § 3 | so | pass | AU-2-live-real.png | — |
| AU-2 | member, `#ask` | threads 260, column ≤ 720, inspector closed; header "Trov"; the empty state as the design: mark, heading, starters, composer **in the middle of the column** (design L770 spacer) | § 3, inventory 1b | 260 / 720 / closed — but the block sat at the **foot** of the page (no spacer under the composer) | fail → fixed | AU-2-live-real.png → AU-2-retest-real.png | 086338ea |
| AU-3 | member | groups Pinned / Today / This week / Earlier; injection title as text | § 2.15 | so; the title escaped, no `<img>` | pass | AU-2-live-real.png | — |
| AU-4 | member | Rename / Pin / Export / Delete through the routes; Delete asks via `confirmModal` | § 2.15, CLAUDE.md | Rename (Enter saves), Pin (→ Pinned), Export (download `test-Renamed-in-e2e.md`, toast) work; **Delete deletes at once — no confirmation** (the design shows none either) | question QA-2 | AU-4-menu.png, au-real2.out | — |
| AU-5 | "webhook" | hits with highlighted matches | § 2.15 | "1 thread", snippet with `<mark>webhook</mark>`, "1 match" | pass | AU-5-search-webhook.png | — |
| AU-6 | 801001 | question right-aligned; chips #1 #2 with live status marks; hover 320 ms → card (priority, assignees, sprint) | § 3 | the #2 chip drew **"undefined"** as its mark (the seed stored mark `open`, not one of ASK_MARKS); fixed in the seed. Chips and the hover card draw the STORED cite (sprint "Backlog", tip "In progress.") not the live view (sprint "test-Sprint Hosting") | fail → fixed (seed) + question QA-1 | AU-6-hover-card.png | e65e5544 |
| AU-7 | footer | Trov mark, "Smart", "2 sources" (numbered list), Copy, Regenerate + "Regenerate with", Save as artifact, Wrong? + three reasons | § 3 | exactly | pass | AU-7-regen-menu.png, AU-7-wrong-row.png | — |
| AU-8 | Wrong? → A source is wrong | toast "Thanks. The team can see this in Review."; AK-63's rows | § 2.14 | exactly; 1 feedback, flags ticket:1,2 | pass | AU-8-wrong-toast.png | — |
| AU-9 | cards on 801001 | draft cards with Confirm / Cancel / Edit; done / "Cancelled: …" / "Undone: …" lines; group "Filed tickets …"; waiting publish card | § 3 | Confirm → "Created ticket #15", group → "Filed tickets #16 and #17", Cancel → "Cancelled: new handoff". After a **reload** every done line lost its item: "Created the ticket" / "Moved ticket **#null** to Testing" — the thread read gave decided cards `ref: null`. The grouped draft card has no Edit (QA-3) | fail → fixed (2 bugs) + question QA-3 | AU-9-cards-before/after.png, AU-9-lines-retest.png | 1935ce41, d7a6270e |
| AU-10 | Undo 801212 | "Changed since. Undo it by hand." with a link | § 2.12 | exactly + "Open ticket #4" | pass | AU-10-undo-changed.png | — |
| AU-11 | Save as artifact | form (title, Kind, Who can see it) → "Saved as artifact: <title> · Private" + Open | § 3 | exactly; toast "Saved to Artifacts"; row role saved | pass | AU-11-save-form.png, AU-11-saved.png | — |
| AU-12 | ⌘J on `#tickets/1` | 420 px panel, the ticket as context, "Ask first", "Open as thread"; on Ask ⌘J focuses the composer | § 2.18 | header "Ask about this Ctrl J"; panel 420 px, aria-modal, context "About ticket #1: …", "Ask first"; Tab kept in; a /search there stored origin panel, context_ref ticket:1; Open as thread → `#ask/<id>`; on Ask Ctrl+J focuses the composer | pass | AU-12-*.png, cmdj.out | — |
| AU-13 | Escape order | picker → menus → hover card → ⌘J → inspector | § 3 | picker closes first (panel stays); hover before inspector; menu before inspector | pass | cmdj.out, hc.out | — |
| AU-14 | composer | Enter sends, Shift+Enter newline; `@` grouped, keyboard pick; `/` commands | § 3 | all work; the @ group read **"FEED ENTRYS"**; a focused composer drew **two** rings (the field rule on the textarea inside the box) | fail → fixed (2 bugs) | AU-14-at-picker-retest.png, AU-14-composer-focus.png | 0ce04711, 1b4c12a0 |
| AU-15 | attach | chips; 11 MB → "…up to 10 MB" | § 3 | "test-notes.txt 1 KB" uploaded; "test-big.txt Too large" + note | pass | AU-15-attach.png | — |
| AU-16 | free | no mode switcher; Settings "On Free, every question uses Smart." | § 2.1 | exactly | pass | AU-16-test-free.png, AU-28-settings-test-free.png | — |
| AU-17 | pro | Fast / Smart / Thinking; "…Counts as 5 questions." | copy | exactly | pass | AU-17-test-pro.png | — |
| AU-18 | auto-off | Auto disabled with its tooltip | § 3 | aria-disabled; tooltip "An admin turned off Auto for this org. Trov asks before every change."; a click keeps "Ask before changes" | pass | AU-18-test-auto-off.png | — |
| AU-19 | chat-low | usage line under 20 % | § 3 | "3 of 300 questions left this month · Resets Nov 1" (no key needed: it reads the allowance) | pass | AU-19-test-chat-low.png | — |
| AU-20 | at-cap | "used up" block, no Send | § 3 | "You've used this month's questions." + Upgrade; no textarea / Send | pass | AU-20-test-at-cap.png | — |
| AU-21 | ai-off | "off" block | § 3 | "Ask Trov is off for this org. / An admin can turn it on in Org settings › AI." | pass | AU-21-test-ai-off.png | — |
| AU-22 | no key, "hi" | the no_key message in the answer area (Q58) | — | the generic error block "Something went wrong. Nothing was changed. Try again"; the server's no_key words never reach the screen; nothing stored | question Q58 | AU-22-no-key.png | — |
| AU-23 | no key, "/search netlify" | activity "Searched Trov for 'netlify'" → items; thread "Search: netlify" | AK-19 | exactly (4 item cards, crumb "Search: netlify") | pass | AU-23-search-netlify.png | — |
| AU-24a | replay `streaming` | held mid-answer: busy, the soft cursor, Stop | § 3 Blocks | **"Something went wrong."** under the partial answer: the route ends the HTTP stream after token 58 and the client took that as a dropped connection | fail → fixed | AU-24-streaming.png → AU-24-streaming-held.png | 78429ba0 |
| AU-24b | `thinking` | "Thinking… Ns" → "Thought for 14s", opens to the summary | § 3 | so | pass | AU-24-thinking-done.png, mo.out | — |
| AU-24c | `answer` | the design's blocks (table with status cells, item cards, chart "48 in 8 weeks" + Data from Trov, theme strip, chain) | § 3 | all drawn; the chain's CI node (a repo ref) drew **"Unknown"** (the transcript's view has no RepoFacts); the question's **file card was missing** | fail → fixed (2 bugs) | AU-24-answer.png → AU-24-answer-diagram-retest.png | e0f3d30d, a18639aa |
| AU-24d | `answer-pr` | inspector stack #14 › #176 › #173, threads hidden | § 3 | so (480 px; "from #14 › #176") | pass | AU-24-answer-pr.png | — |
| AU-24e | `actions-ask` | ticket / handoff / doc-edit cards, Confirm / Cancel / Edit | § 3 | so | pass | AU-24-actions-ask.png | — |
| AU-24f | `actions-auto` | done lines with Undo, the group line, the waiting Publish card with "Publishing waits for you, even on Auto." | #12 copy | so (the answer's sentence sits after the cards: stream order, as the transcript streams it) | pass | AU-24-actions-auto.png | — |
| AU-24g | `artifact` | the save form, HTML page / Private | § 4 | so | pass | AU-24-artifact.png | — |
| AU-24h | `artifact-saved` | "Saved as artifact: Hosting status, Oct 15 · Private" + Open | § 4 | so | pass | AU-24-artifact-saved.png | — |
| AU-24i | `search` | "4 threads", hits with marks, the menu open on thread 5 | § 1a | so — but the open row's ⋯ was drawn **over its time** ("Tue" through the button) | fail → fixed | AU-24-search.png → menu-row | 4a4dffab |
| AU-24j | `notfound` | "I couldn't find that in Trov.", two rephrase chips, "What I searched" with "No matches" | § 2e | so | pass | AU-24-notfound.png | — |
| AU-24k | `cmdj` | the panel over the ticket, context, "Ask first" | § 8 | so | pass | AU-24-cmdj.png | — |
| AU-25 | inspector (real 801001) | 480, resizable 380–720, Back + breadcrumb, Open in page, Close; threads hidden under 1640 while open | § 3 | 480; separator `aria-valuemin 380 / max 720`, arrows resize within them; push → "PERSON from #1", Back; Escape closes; threads hidden at 1440/1500 with it open, back at 1500 closed, hidden at 1100 | pass | AU-25-*.png, insp.out | — |
| AU-26 | repo inspector, SaplingLearn/sapling (meilin) | environments with the Overview's verdicts; hosts by part label; Org settings links | main-186 § 4–6 | Staging Healthy / Production Failing (= the Overview); "Railway · not connected" → Org settings › Hosting; but each part read **"Frontend · Frontend"** | fail → fixed | AU-26-repo-inspector.png, AU-26-repo-overview.png | fad7e1ac |
| AU-27a | 360, `phone` + real | thread list in a drawer; "+" with "Smart · Asks first"; every control ≥ 44 px | § 3 Phone, ask.md | drawer 300 px, modal, focus kept; header targets 44 px — but a write card's **Cancel / Confirm (29–31 px) and Edit (21 px)** had no 44 px hit area | fail → fixed | AU-27-phone-real.png, hit.out | 91cfcb31 |
| AU-27b | `phone-plus` | + menu: Attach / Mention / Run a command, Mode, Changes | § 10 | so | pass | AU-27-phone-plus*.png | — |
| AU-27c | `phone-insp` | inspector as a full-height sheet, no resize | § 10 | `data-sheet=1`, 360×780 at 0,0, no separator | pass | AU-27-phone-insp*.png | — |
| AU-28 | Settings › Trov | instructions + counter + Try chips; Default mode (Pro); What Trov can see with the Org settings links; Save | § 2.19 | so; links Integrations / Repositories / Hosting / Environments; Save toast "Saved. New threads use these settings." | pass | AU-28-*.png, kb.out | — |
| AU-29 | Stop while streaming (replay) | "Stopped. The answer above is partial." | § 2.17 | the line shows; the **footer does not** (design: "The footer still shows") — Stop aborts the request, so no message id arrives until a reload | pass + question QA-4 | AU-29-stopped.png | — |
| AU-30 | edit the last question | "Sending replaces the answer below"; replaced answer's cards expire (AK-29) | § 2.16 | the note shows; but editing a **/search** question showed only "netlify" and resent it **without the command** → a model question ("Something went wrong." with no key) | fail → fixed | AU-30-edit.png → AU-30-edit-retest.png | b0427bce |
| AU-31 | the error block | "Something went wrong. Nothing was changed. Try again" | § 3 | so (AU-22) | pass | AU-22-no-key.png | — |
| AU-OWNER-1 | the owner, on the af26ce3c preview: `#ask`, new thread; 1440 and 360; motion on / reduced | the empty screen STARTS centred (heading, starters, composer with its hint lines, design `live`); after the first question the composer docks at the foot with a smooth glide (app motion), instant under reduced motion; a re-opened empty thread centres again; phone per the design's `phone` | owner (coordinator message) | before: composer pinned at the foot (`AU-OWNER-1-before-1440.png`). After 086338ea + 074b68a3: 1440 — box 720 px, block centred (heading 350, composer 527–690 in a 57–900 column); the send flips `data-ask-dock` center → dock and the composer glides `translateY(-243px) → none` (300 ms, --fx-ease), lands 770–900; reduced motion: no transform; New thread → centred again (same geometry). 360 — 1-column starters, the phone + bar "Fast · Asks first", centred; glide −144 px; docks 666–780 | fail → fixed | AU-OWNER-1-before-1440.png, AU-OWNER-1-after-centred-1440/360.png, AU-OWNER-1-after-docked-1440/360.png, owner1.out | 086338ea, 074b68a3 |
| AU-OWNER-2 | the owner (after the merge, branch `ai/ask-owner-fixes`): Shift+Enter in the composer; 1440, 360, reduced motion, the ⌘J panel | no scrollbar while the box grows — clipped until the words pass the 220px cap, only then scrolling; growth stays smooth; the same for a wrapping line, a pasted block, shrinking; instant under reduced motion | owner (coordinator message) | before: the input was `overflow-y:auto` while its height transition ran, so for 14 frames of three Shift+Enters the words were taller than the box with a scrollbar allowed (sampled per frame with the old rule: 14 / 14 "flash" frames; a wrapping line 2 / 2). After: `overflow-y:hidden` until `data-full` (words > 220px), then `auto`. Every frame sampled (`scrollHeight > clientHeight` + computed `overflow-y` + `data-full`) across Shift+Enter ×3, a wrapping line, pasting 6 and 20 lines, shrinking and Shift+Enter again: **0 flash frames** at 1440, 360, under reduced motion (heights jump, no transition) and in the ⌘J panel; the heights still glide (46 → 47 → 49 → … → 95). **Amended by the owner: no scrollbar ever, not even at the cap** — `scrollbar-width:none` + `::-webkit-scrollbar{display:none}` on `.ask-input` only. At the cap (30 pasted lines) on the page 1440, a phone 360 and the ⌘J panel: `scrollbar-width: none`, bar 0 px, `overflow-y:auto` + `data-full`, the wheel scrolls it (120 px), Ctrl+Home brings the caret up; a paste at the cap had left the caret out of view (scrollTop 0) — the composer now keeps it in view (scrollTop at the bottom after the paste and after typing at the end) | fail → fixed | AU-OWNER-2-*.png, final/owner2.out, final/owner2b.out | the AU-OWNER-2 commit |
| AU-32 | injection thread 801004 | HTML / script / javascript: link inert | — | 0 script, 0 img, 0 `<b>`, 0 javascript: links; all as text | pass | AU-32-injection.png | — |

### Added cases (no Tier 1 case in the matrix for these built parts: one per design scenario, replay, against the design render)

| id | scenario | expected (design) | actual | result | evidence |
| --- | --- | --- | --- | --- | --- |
| AU-C-quota *added* | composer:quota | "You've used this month's questions." / "Resets Nov 1. Pro includes 300 a month, plus Thinking mode." + Upgrade to Pro | so | pass | AU-24-composer_quota.png |
| AU-C-off *added* | composer:off | "Ask Trov is off for this org." / "An admin can turn it on in Org settings › AI." | so | pass | AU-24-composer_off.png |
| AU-C-autoOff *added* | composer:autoOff | Auto disabled + tip | so | pass | AU-24-composer_autoOff.png |
| AU-C-free *added* | composer:free | no mode menu; "9 of 50 questions left this month · Resets Nov 1" | so | pass | AU-24-composer_free.png |
| AU-C-low *added* | composer:low | the usage line | "41 of 1500 …" (the fixture is Pro with 5 seats) | pass | AU-24-composer_low.png |
| AU-C-error *added* | composer:error | "Something went wrong. Try again" | so | pass | AU-24-composer_error.png |
| AU-C-tooLarge *added* | composer:tooLarge | "standup-recording.mov is too large. Files can be up to 10 MB." + red chip | so | pass | AU-24-composer_tooLarge.png |
| AU-C-busy *added* | composer:busy | Send is Stop; "Trov is answering…" | so — and two focus rings (fixed with AU-14) | fail → fixed | AU-24-composer_busy.png, 1b4c12a0 |
| AU-C-at *added* | composer:at | grouped @ picker, "↑↓ to move · Enter to pick · Esc to close" | so | pass | AU-24-composer_at.png |
| AU-C-slash *added* | composer:slash | the five commands with their hints | so | pass | AU-24-composer_slash.png |
| AU-C-files *added* | composer:files | three file chips + #14, "About ticket #14 · 3 files" | so | pass | AU-24-composer_files.png |
| AU-C-drag *added* | composer:drag | "Drop files to attach" / "Images, PDFs and text files, up to 10 MB each" | so | pass | AU-24-composer_drag.png |
| AU-I-ticket *added* | insp:ticket | #14, rows, sub-tickets "1 of 3 done", linked PRs | so | pass | AU-24-insp_ticket.png |
| AU-I-pr *added* | insp:pr | head → base, "3 of 4 checks pass", What / Why / Impact, Linked to | so (no +/− lines: stored nowhere, by decision) | pass | AU-24-insp_pr.png |
| AU-I-doc *added* | insp:doc | Staged, not approved; "This version waits in Review…"; Open doc | so | pass | AU-24-insp_doc.png |
| AU-I-sprint *added* | insp:sprint | dates, due, 58 %, "7 of 12 tickets done", forecast, groups | so | pass | AU-24-insp_sprint.png |
| AU-I-repo *added* | insp:repo | RepoFacts (scenario N/trov) over the design | so | pass | AU-24-insp_repo.png |
| AU-I-handoff *added* | insp:handoff | from → to, Task, Done, Next, Files | so | pass | AU-24-insp_handoff.png |
| AU-I-feed *added* | insp:feed | author, agent, time, brief, body, Sources | so | pass | AU-24-insp_feed.png |
| AU-I-person *added* | insp:person | role, Working on now, Recent pull requests | so | pass | AU-24-insp_person.png |
| AU-I-artifact *added* | insp:artifact | preview, Private, "HTML page · v1" | so; "No preview yet" (the replay's artifact does not exist in this org) and no Publish (the viewer is not its author) | pass | AU-24-insp_artifact.png |
| AU-I-upload *added* | insp:upload | preview, size, "Attached to this thread. Trov reads it only when you ask about it." | so | pass | AU-24-insp_upload.png |
| AU-I-chart *added* | insp:chart | title + Chart/Table, "48 merged pull requests on …", bars, "Data from Trov · <the query's note>" | the bars came in the conversation's whole card: the title **twice** and plain "Data from Trov" (the note only in Table) | fail → fixed | AU-I-chart-retest-insp_chart.png | 843d533e |

### EV — environment (§ 6, the AU rows)

D = desktop dark, P = 360 light, PD = 360 dark, K = keyboard only. Every run: no horizontal scroll, no console error, no
failed request (except the harness note under Observations).

| id | result | evidence / note |
| --- | --- | --- |
| EV-AU-live-D | pass | F-EV-D-live-dark.png |
| EV-AU-live-K | fail → fixed (19b0f919) | Enter on ⋯ opened the menu with focus left on ⋯; ↑↓ did nothing. Now Rename takes focus, ↑↓ move and wrap, Escape returns to ⋯ (kb2.out). Tab order: sidebar → header → New thread → search → rows/⋯, every stop with a ring |
| EV-AU-answer-D | pass | EV-D-answer-dark.png |
| EV-AU-answer-K | pass | chip by Tab (ring) opens the hover card on focus; Escape closes it; Wrong? by Enter, reasons by Tab |
| EV-AU-actions-ask-D | pass | EV-D-actions-ask-dark.png |
| EV-AU-actions-ask-K | pass | Edit by Space (aria-expanded, focus to the Title field), Confirm reachable |
| EV-AU-actions-auto-D | pass | EV-D-actions-auto-dark.png |
| EV-AU-actions-auto-K | pass | Undo by Enter → "Undone: …" |
| EV-AU-artifact-D | pass | EV-D-artifact-dark.png |
| EV-AU-artifact-K | pass | title, segmented, Save by Enter → saved line |
| EV-AU-search-D | pass | EV-D-search-dark.png |
| EV-AU-notfound-D | pass | EV-D-notfound-dark.png |
| EV-AU-notfound-K | pass | rephrase chip by Enter sends it |
| EV-AU-cmdj-D | pass | EV-D-cmdj-dark.png |
| EV-AU-cmdj-K | pass | Ctrl+J opens, focus in the composer, Tab kept in the panel, Escape (picker first) |
| EV-AU-settings-D | pass | AU-28-settings-test-ent-dark.png |
| EV-AU-settings-P | pass | AU-28-settings-test-ent-360.png |
| EV-AU-settings-PD | pass | AU-28-settings-test-ent-dark-360.png |
| EV-AU-settings-K | pass | textarea → counter "65 / 500" → Try chip by Enter → segmented by arrows → Save by Enter → toast |
| EV-AU-composer-capped-D | pass | EV-AU-composer-capped-D.png |
| EV-AU-composer-capped-P | pass | EV-AU-composer-capped-P.png |
| EV-AU-composer-capped-PD | pass | EV-AU-composer-capped-PD.png |
| EV-AU-inspector-D | pass | EV-D-answer-pr-dark.png |
| EV-AU-inspector-K | pass | a chip by Enter opens it; separator focusable (aria 380/480/720), arrows resize; Escape closes |
| EV-AU-phone-PD | pass | AU-27-phone-real-dark.png, AU-27-phone-drawer-dark.png |
| EV-AU-phone-K | pass | Open threads by Enter → focus in the drawer (Close threads), Escape back; + by Enter → focus "Attach a file or photo", Escape back to + |
| EV-AU-phone-plus-P | pass | AU-27-phone-plus.png |
| EV-AU-phone-plus-PD | pass | AU-27-phone-plus-dark.png |
| EV-AU-phone-insp-P | pass | AU-27-phone-insp.png |
| EV-AU-phone-insp-PD | pass | AU-27-phone-insp-dark.png |

### MO — motion (§ 7; `document.getAnimations()` sampled in the page)

| id | expected | actual | result |
| --- | --- | --- | --- |
| MO-42 | the entrance plays once when the route changes into Ask | `#mywork → #ask`: cnpy-screen (screen + h1), cnpy-rise (heading, starters), ask-fade-in, skeleton → content; opening another thread replays none of it (ask-col fade only) | pass |
| MO-43 | a streamed answer appends without re-entering earlier messages or jumping the scroll | 12 samples during `answer` at speed 2: 0 animations on the question; the scroller held at the bottom (875/875) | pass |
| MO-44 | a card collapses to its line | Cancel: `ask-line-in` 360 ms + the part's height tween 240 ms | pass |
| MO-45 | reduced motion: nothing moves on Ask | entrance: no animation (only two 150 ms colour transitions of the segmented control) | pass |
| MO-46 | inspector / ⌘J open smoothly | `ask-insp-in` + `ask-view-in`; ⌘J `ask-panel-in` + scrim fade | pass |
| MO-47 | Back keeps the shell | only `ask-view-in` on the body; the frame does not re-enter | pass |
| MO-48 | close: inspector, ⌘J, hover card, picker | `data-closing` + `ask-insp-out`, `ask-panel-out` + scrim fade-out, `ask-pop-out`; gone after | pass |
| MO-49 | reduced motion for those | inspector / ⌘J / picker open and close with no animation; elements removed at once | pass |
| MO-50 | activity steps rise in order | new steps animate as they arrive (s:4, s:5 seen mid-stream) | pass |
| MO-51 | thinking "Ns" ticks without re-entering | "Thinking… 5s": only the pulse runs; no entrance animation while it counts | pass |
| MO-52 | reduced motion: text without the cursor animation | cursor animation samples 10 → 0; steps 2 → 0; thinking pulse 6 → 0 | pass |

## Bugs fixed (case → cause → fix commit → its test)

1. **AU-2** — the empty conversation sat at the page's foot: no spacer under the composer (design L770). `EMPTY_TAIL`
   on the page and in the ⌘J panel. 086338ea — `render.ask-shell.test.ts` › the empty conversation.
2. **AU-6** — a chip drew "undefined": the e2e seed stored cite mark `open` (not in ASK_MARKS). 
   e65e5544 — `seed-server-ai-e2e.test.ts` › stores Ask cites that are valid RefViews.
3. **AU-24a** — the held `streaming` scenario showed "Something went wrong.": the replay ended the stream; the
   client read it as a drop. The replay holds a transcript with no done/error until Stop. 78429ba0 —
   `render.ask-shell.test.ts` › holds a transcript that ends mid-answer.
4. **AU-24c** — the chain's repo node "Unknown": transcript repo views carry no RepoFacts. `withRepoFacts`. e0f3d30d —
   `render.ask-shell.test.ts` › gives a transcript's repo views the index's facts.
5. **AU-24c** — the question's file card missing: the replay dropped the scenario's attachments.
   `replayQuestionFiles`. a18639aa — `render.ask-shell.test.ts` › sends a scenario question's files.
6. **AU-24i** — a search hit's ⋯ drawn over its time: the hide rule excluded hits. 4a4dffab —
   `render.ask-shell.test.ts` › the thread list.
7. **AU-14 / composer:busy** — two focus rings on the composer (and the thread search): the app-wide field rule hit
   the borderless field inside the box. 1b4c12a0 — `render.ask-shell.test.ts` › Ask's borderless fields.
8. **AU-I-chart** — the inspector chart repeated its title and lost the query note. `chartFigure({ bare })`. 843d533e —
   `render.ask-inspector.test.ts` › chart.
9. **AU-9** — after a reload every done line lost its item (`ref: null` from the thread read). `refOfAction` rebuilds it
   from the stored args/result. 1935ce41 — `ask.actions.test.ts` › a write becomes a PROPOSED card (the thread read).
10. **AU-9** — "Moved ticket #null to Testing": `doneText` printed an unknown number. d7a6270e —
    `render.ask-actions.test.ts` › never writes #null.
11. **AU-14** — "FEED ENTRYS". `refTypeGroup`. 0ce04711 — `render.ask-composer.test.ts` › the @ picker's group heads.
12. **AU-30** — editing a /search question dropped its command. The edit box shows "/search …" and Send parses it.
    b0427bce — `render.ask-conversation.test.ts` › a command question keeps its command.
13. **AU-26** — "Frontend · Frontend" in the repo inspector. fad7e1ac — `render.ask-inspector.test.ts` › a part named like
    its app.
14. **AU-27a** — card buttons and Edit under 44 px on a phone. 91cfcb31 — `render.ask-phone.test.ts` › 44px hit area.
15. **EV-AU-live-K** — the thread menu had no keyboard pattern. 19b0f919 — `render.ask-shell.test.ts` › the thread menu
    by keyboard.
16. **AU-OWNER-1** (the owner) — the empty screen started with the composer pinned at the foot; now centred (086338ea)
    and the composer glides to its dock on the first question (`data-ask-dock`, `askGlideDock`). 074b68a3 —
    `render.ask-shell.test.ts` › AU-OWNER-1 (centred / docked / re-centred; the glide's rules).

Each was retested in the browser right after its fix, with the cases on the same code path (AU-2 with AU-27/⌘J
empty states; AU-24 streaming with AU-29; the answer diagram with answer-pr / artifact; AU-9 lines with AU-10; AU-14
with the thread search; AU-26 with AU-I-repo; AU-30 with AU-23), then once more in the final pass.

## Questions (spec silent — not guessed)

| Q | case | question | what I'd expect, and why |
| --- | --- | --- | --- |
| QA-1 | AU-6 | A reopened thread draws its chips, hover cards and sources from the cite **snapshot** stored with the answer (`cites_json`), never re-peeked: status, sprint, title — and an item since deleted or made private — show as they were. #12 § 2.6 / the matrix say "live status marks". Should a reopened thread peek its cites? | Peek on open (the controller already batches peeks), keeping the stored view only as the first paint; at least drop what peek now hides. |
| QA-2 | AU-4 | Thread Delete is immediate — a hard delete of the thread and its attachments, no confirmation, no undo. The design shows none; the matrix expected `confirmModal`. | A `confirmModal` ("Delete <title>? Its attachments go too."), since it cannot be undone (invariant 11's other hard deletes all confirm). |
| QA-3 | AU-9 | A grouped draft card ("2 new tickets") has no Edit, though ask.md describes per-card edits inside a group and the confirm route takes them. Intended? | Either Edit per card in the group, or ask.md says groups are confirm-as-is. |
| QA-4 | AU-29 | After Stop the partial answer has no footer (Copy / Save / Wrong?) until a reload: Stop aborts the request, so `done { messageId, stopped }` never arrives. The design: "The footer still shows." | Read the thread back after Stop (as after an error) to get the stored id, then draw the footer. |
| QA-5 | AU-24c | A repository node in a diagram shows the repo's head-environment verdict ("Live"); the design's "CI on main" node shows the CI state ("Failing"). Which? | The CI state when the node's eyebrow is CI — or a `ci` ref type. |
| QA-6 | AU-20/21 | With the questions used up or Ask off, the starters stay clickable (each send is refused). Hide or disable them? | Disable them with the block's reason. |
| Q55 | AK-33 | A waiting card's `note` is lost on reload (`note: null`). | Still open from the matrix. |
| Q56 | AK-39 | The export filename strips every non-ASCII character. | Still open. |
| Q58 | AU-22 | Without a key, sending shows the generic "Something went wrong." block; the server's "Ask Trov is not set up on this deployment." is never shown, and the composer looks usable. | Treat `eligibility: no_key` like `off`: a block in place of the box, with the server's sentence. |

## Pre-existing (recorded, not fixed)

- **P-1** — `PUBLIC_ORIGIN=http://localhost:<the dev port>` in `.dev.vars` makes every GET 301 to `https://…`
  (`canonicalRedirect`, `src/site.ts`: plain http on the public host). Dev-only; the matrix's default
  `PUBLIC_ORIGIN=http://localhost:8787` would do it on 8787. Not Ask's; worked around by leaving it unset.

## Observations (not counted)

- Chromium reports every Ask SSE request (`POST /ask`, the replay GET) as `net::ERR_ABORTED` a few ms after its last
  event, under wrangler dev; the content is complete, no console error, the UI is right. Not reproduced with a plain
  `fetch().text()`. Worth one look in a deployed preview.
- wrangler dev's proxy now and then never answered one navigation (nothing reached the Worker's log); the harness
  retries (no app effect).
- The shared `segmented()` puts Tab on its first option, not the selected one (seen in the save form); not Ask's
  code and not checked against main.

## Not run (Tier 2 per § 10)

AK-3 · 4 · 5 · 6 · 7 · 9 · 10 · 14 · 15 · 16 · 17 · 21 · 22 · 25 · 26 · 27 · 34 · 35 · 36 · 41 · 43 · 50 · 52 · 53 · 57 · 60 · 61 · 62 ·
64 · 65 · 68 (refusal orders, status codes, plan variants; several need the `K:dummy` key, which this run never set).

## Final pass

After the last fix (074b68a3) every case's script ran once more, in order, from a clean seed before each script that
writes (`server-ai-shots/ask/final/final.log`; outputs `final/<script>.out`; evidence names like `ak-w1.out` above
are these files). 42 scripts, all ran; the per-case assertions (31 key strings: the no_key / search / undo / 413 /
replay / held stream / Stop / Thought for 14s / reloaded done lines / "Feed entries" / menu focus / hover-on-focus /
AU-OWNER-1 dock + glide / Wrong? toast / save / too-large / edit-keeps-command / repo verdicts / panel origin /
resize bounds / phone sheet / settings Save) all held, and no run showed a horizontal scroll, a page error or a
failed script. The final-pass screenshots matched the ones linked above and were not kept twice.

Typecheck: pass at every commit. Full suite: the gate script once, at the final commit — see the report.

## Final pass 2026-10-16

The last browser pass of Ask before #178 ships: the Tier 1 Ask screen cases again, plus everything that changed on
2026-10-16 (the fixed orbs, the wait row, steps that appear one at a time, the pacer, `settleTail`, the scroll rules
and jump arrow, the floating Cancel / Confirm, inline edits, the assignment and claim cards, the single-item card,
the diagram, the composer chips) and the regressions the #187 merge could have caused (lazy chunks).

**Setup.** Branch `ai/e2e-final-ask` off `ai/screens` 40d88ea6, worktree `~/Projects/trov-e2e-ask`, its own
`wrangler dev --port 8851 --test-scheduled` with a `vite build --watch` beside it. The local D1 is a copy of the :8790
preview: every scenario plus the Ask showcase. **`LOCAL_AI_PREVIEW` is off, and the ANTHROPIC / TYPESAFE keys are
live**, so these are REAL Ask answers (17 questions were sent in all). `DEV_LOGIN=AndresL230`; Pinecone (free, at its
cap) and Northwind (Team) were opened through `/auth/dev/as`. The browser was headless Playwright Chromium, because
the Chrome automation tab runs no `requestAnimationFrame`. Viewports were 1440×900, 390×844 and 360×780, plus the ⌘J
panel; light and dark (`trov.theme`); `reducedMotion` emulated on and off. A per-frame sampler recorded each live
answer frame by frame: the wait row, the orb's state, the orb's canvas ink (mean RGB of its drawn dots), the
shimmer's `getAnimations()`, the steps, the length of the streamed text, any raw markdown in the rendered text, the
scroller's position and the jump arrow. Screenshots:
[`server-ai-shots/final-ask/`](server-ai-shots/final-ask/).

**Pace, measured** (the length of the rendered text per frame; ref chips render longer than their `[[ref]]` token, so
the lower bound below removes chips and tables):

| answer | chars / time | avg cps | 1 s windows (median · p90 · max) | lower bound avg (max) | chars a frame (median · p95) |
| --- | --- | --- | --- | --- | --- |
| 1440 light, new thread, file + sprint chip | 3173 / 28.7 s | 111 | 112 · 153* · 155* | 94 (118) | 2 · 4 |
| 1440 dark, after both fixes | 4125 / 38.4 s | 107 | 110 · 117 · 119 | 97 (119) | 2 · 3 |
| ⌘J panel dark (until Stop) | 257 / 2.3 s | 110 | 118 | 104 (118) | 2 · 3 |
| 390 light, table-heavy | 920 / 10.5 s | 87 | 96 · 117 · 117 | — | 2 · 34† |

\* Windows that hold ref chips (a chip's name is longer than its token). † A table row lands whole once its closing
bar arrives (`settleTail`), 53–86 characters in one frame; between rows the words come 1–4 characters a frame.
Character by character, within 70–120 cps: **pass**.

| id | surface | state | expected | source | actual | result | evidence | fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-OR1 | answer orbs | live, 1440 light + dark | the cube ("solving") while Trov thinks: from Send until a step or the first words | ask.md › Working, shown; web-ui.md › The thinking orb | `solving` from 0 ms in every live answer | pass | q1/q2 timelines | — |
| F-OR2 | | live, search steps | the globe ("searching") while a search runs | same, `stepOrb` | "Searched Trov for …", "Looked up … in Trov's docs", "Searched tickets" → `searching` | pass | q1 light/dark | — |
| F-OR3 | | live, other steps | the orbits ("working") for other work | same | "Looked at the sprint", "Checked CI and deploys" → `working` | pass | q1 | — |
| F-OR4 | | live, a block out before the words | the ribbon ("composing") with "Writing…" | same | ⌘J dark: the ticket card, then `composing` "Writing…" until the words; light 1440 the same | pass | writing-ribbon-dark.png, writing-ribbon-light.png | — |
| F-OR5 | | live, light + dark (**dark was UNVERIFIED**) | the orb's ink is the theme's `--purple` (#804db7 light, #a98bd6 dark) | web-ui.md (setInk) | light: mean dot RGB 127,76,182; dark: 168,138,214, for all four orbs | pass | sampler `ink` | — |
| F-OR6 | | reduced motion | one static frame, no loop | web-ui.md | two canvas snapshots 300–400 ms apart are identical (both themes); motion on: they differ | pass | wait-check | — |
| F-WR1 | the wait row | live | "Thinking…" with the orb, UNDER the steps for the whole wait, gone once words stream | ask.md | there from 0 ms; stays while the steps appear; gone at the first word (cursor) | pass | timelines, wait-row-*.png | — |
| F-WR2 | | live, a block out | "Writing…" | same | yes, with the ribbon | pass | writing-ribbon-*.png | — |
| F-ST1 | steps | live | appear one at a time, ~350 ms apart (`stepMs`) | ask.md, ask-pace.ts | each runs about 350 ms, then the next appears: 1833 / 2200 / 2550 / 2869 / 3234 ms; 1766 → 2136 ms | pass | q2 timeline | — |
| F-ST2 | | live | the latest step stays running until the answer starts | ask.md | the last step held `is-run` from 2.1 s to the first word at 7.5 s (light), 2.9 s → 11.4 s (dark) | pass | q1 timelines | — |
| F-SH1 | shimmer | motion on | a purple sweep on the running step's label and the wait label | trov.css › ask-shimmer | `ask-shimmer: running` on both; gradient through `--purple` (128,77,183 / 169,139,214) | pass | sampler `bgimg` | — |
| F-SH2 | | reduced motion, 390 light + 1440 both themes | the sweep is off and the words are plain `--fg-55` | trov.css comment, ask.md | **no animation, but the words drew `color: transparent` on a static gradient** (`background-clip: text`, with a faint purple at the right end): the reduced-motion rule (trov.css L3038) came BEFORE the sweep rule (L3165) with the same selector, so the sweep's `background` / `color` won | fail → fixed | phone-reduced-wait-light.png; after: wait-row-*-reduced.png (`rgb(110,110,120)` light, `rgba(237,233,226,.55)` dark, `background: none`) | 554a4e12 (AU-F-RM1) |
| F-PC1 | pacer | live, 1440 | 70–120 cps, one character at a time | ask-pace.ts `ASK_PACE` | see the pace table | pass | q1-*.out | — |
| F-PC2 | | live, 390 | same; a table scrolls in its block | ask.md | as the table; table 346 px wide, scrollWidth 530, `overflow-x: auto`; no page scroll | pass | phone-answer-light.png | — |
| F-MD1 | settleTail | live, 1440 light (headings, bold, inline code, a table, refs, lists) | no raw markdown on any frame | ask.md › Half-written markdown | 0 of 2092 frames | pass | q1 light | — |
| F-MD2 | markdown | live, ⌘J dark | the same | same | **`**` shown raw around inline code**: `1. **\`quiz.spec.ts\`:** it passes…` drew `**quiz.spec.ts:** it passes` on 124 frames AND in the finished answer. `emphasis` split the line on code spans before pairing `**`, so a bold mark around code could never pair (and could pair wrongly across a code span) | fail → fixed | md-bold-code-fixed.png (after) | 53b62388 (AU-F-MD1) |
| F-MD3 | | live dark after the fix; every stored thread | no raw marks | — | an answer with bold code, a link, 9 table lines and 9 headings: 0 of 3086 frames; 18 stored threads: 0 raw, `<strong><code>` drawn | pass | answer-dark.png | — |
| F-SP1 | Stop | ⌘J dark, mid-pace (the server had already finished) | Stop shows everything received at once | ask-pace.ts `flush` | 257 → 2091 characters in one frame; the footer comes (the turn was done, so no "Stopped" line) | pass | cmdj-stopped-dark.png | — |
| F-SP2 | | 390 dark, while a step ran (the server was still working) | "Stopped. The answer above is partial." | AU-29 | so; the step is shown done; no footer until a reload (QA-4 still open) | pass | AU-29-stop-phone-dark.png | — |
| F-SC1 | scroll | live | an eased follow while streaming | ask.md › The bottom | ≤ 20 px a frame, ≤ 106 px behind (a whole table landing), 0 at the end; on the phone ≤ 32 / ≤ 54 | pass | sampler | — |
| F-SC2 | | stored 9501 | opening the sources, a step's results or Wrong? never moves the view | same | the scroller's top and the clicked control's y are unchanged on every frame for each of the three | pass | ux | — |
| F-SC3 | | live, scrolled up 500 px mid-answer | scrolling up lets go | same | the top stayed put for 1.5 s while 70 / 157 more characters arrived | pass | jump-busy-*.png | — |
| F-SC4 | jump arrow | stored | shows past 160 px, never before | ask.md (`AWAY_PX`) | 100 / 160 px: hidden (`tabindex=-1`); 220 px: shown | pass | jump | — |
| F-SC5 | | live, light + dark | purple while an answer is still coming; grey otherwise | same | busy: 128,77,183 / 169,139,214; idle: 79,79,88 | pass | jump-busy-*.png | — |
| F-SC6 | | live + stored | a click glides back and holds on | same | gap 569 → 0 over ~30 frames, eased; following again afterwards (≤ 17 px a frame, ≤ 41 behind) | pass | sampler | — |
| F-WC1 | write cards | ticket (1440 light), assignment (dark), claim (390 light), group | the frame holds content only; Cancel / Confirm float outside, under its bottom-right edge, with no background | ask.md › The floating pair | 0 buttons in the frame; pair 8 px under the card, right edges aligned, transparent | pass | card-*.png | — |
| F-WC2 | | new ticket | the title edits in place | ask.md | a click → an input with the same class and value, focused; Enter keeps "(edited)" | pass | w1 | — |
| F-WC3 | | | category / priority: a word that a click cycles, with a tooltip of the values | same | "High · Normal · Low — click for Normal" → Normal | pass | w1 | — |
| F-WC4 | | | a person is `dropdown()`, its menu a root overlay | same | menu outside the card: Unassigned, You, 7 members; picked Omar | pass | w1 | — |
| F-WC5 | | | Confirm sends only the changed fields | same | `{"args":{"title":"… (edited)","priority":"normal","assignee":"omar-h"}}`; ticket #92 created that way | pass | w1 | — |
| F-WC6 | | | a decided card is ONE line, with Undo / Open | same | "Created ticket #92 · Just now · Undo"; after Undo "Undone: created ticket #92" (#92 declined) | pass | card-ticket-line-light.png | — |
| F-WC7 | | at the bottom (**the confirm glide after the floating pair was UNVERIFIED**) | one glide, nothing jumps, the bottom holds | ask.md › The swap | the wrapper glides 216 → 52 with no reversal; the gap stays 0 on every frame | pass | w1 | — |
| F-WC8 | | scrolled up | the clicked card stays put, the rows under it rise | same | the card's top stayed at 214 / 170 px on every frame; one glide each | pass | w2, w3 | — |
| F-WC9 | | | everything on a card is 30 px | ask.md › One control height | the cycled words, the dropdown, Cancel / Confirm, Undo, the Save form's field / Save / switches: all 30 | pass | geom | — |
| F-WC10 | assignment | add (the model proposed an add) | "Adds Jose · Andres stays on it", people through people.ts | ask.md | so; "Assigned ticket #87 to Jose" | pass | card-assign-dark.png | — |
| F-WC11 | | replacement | "Jose → Luke", "Andres stays on it" | same | so; "Reassigned ticket #87 from Jose to Luke"; DB [AndresL230, lpcooper-arch] | pass | card-replace-dark.png | — |
| F-WC12 | | Undo of the replacement | undoes both halves | ask.md, actions.ts | "Undone: reassigned …"; DB [AndresL230, Jose-Gael-Cruz-Lopez] | pass | undo | — |
| F-WC13 | claim | 390 light | sender → you, "No one else can claim it after"; one line | ask.md | so; "Claimed handoff #16" (DB claimed by AndresL230); 44 px hit areas | pass | card-claim-*.png | — |
| F-WC14 | group | 1440 light | one frame, ONE pair; one line | ask.md | "2 new tickets", one pair; "Filed tickets #93 and #94"; Undo → both declined | pass | card-group-light.png | — |
| F-SV1 | Save form | 1440 dark | Kind / Who can see it as switches at the head's right; the title with Save at its end; no Cancel | ask.md | the switches at the top right; the field and Save share top and height (30); no Cancel; Save → one glide → "Saved as artifact: … · Private · Open" | pass | save-form-dark.png | — |
| F-WG1 | Wrong? | 1440 light + dark | no box; a reason gives the toast | ask.md, AU-8 | the row has no border and no background; "Thanks. The team can see this in Review." | pass | wrong-open-light.png | — |
| F-ONE1…11 | single-item card | 11 types (ticket, PR, doc, decision, feed, sprint, handoff, artifact, person, prompt, repo); 1440 light, 390 dark | identity on the left, facts on the right; stacked when narrow; the whole card one hit area | ask.md › One item | all 11: facts on the right at 664 px; under the identity at 346 px; per-type rows as specified (PR has no Branch row: not stored); one hit area | pass ×11 | one-1440-light-0.png, one-1440-light-10.png | — |
| F-DG1 | diagram | 4-node chain (stored 9501) | left → right when it fits, top → bottom when narrow | ask.md › The diagram | 1440 / 1100 / 800: left → right; 390 / 360: top → bottom | pass | diagram-1440-light.png, diagram-390-dark.png | — |
| F-DG2 | | fan-out (live: A → B → C/D/E → F) | parallel lanes, the parent centred, connectors, the root as the blocker | same | 3 lanes, B centred, curved connectors to one point per card, A emphasised | pass | diagram-fan-1440-light.png | — |
| F-DG3 | | fan-out, phone | the list (timeline) once a lane would be under 120 px | same | `--ls: 1`, a rail with a dot per node, the root's dot filled | pass | diagram-fan-390-dark.png | — |
| F-CH1 | composer chips | new thread, light + dark | chips above the box; Clear with two or more; no "About …" line | ask.md › Composer | file + sprint chips above the box, Clear, no "About" line | pass | chips-centre-*.png | — |
| F-CH2 | sent question | | the same chips under the bubble, a small Edit under them | same | 2 chips (`ask-q-chip`), Edit 20 px | pass | answer-light.png | — |
| F-CH3 | dock glide | with chips, light + dark (**UNVERIFIED before**) | the composer glides from the centre to the foot, carrying the chips | ask.md › The composer's place | its top 488 → 770 over ~320 ms, eased, in one piece | pass | q1 `composer` | — |
| F-DR1 | drag over | 1440 dark (**UNVERIFIED before**) | "Drop files to attach" over the conversation; leaving clears it; a drop makes a chip | ask.md | overlay 920×823 with "Images, PDFs and text files, up to 10 MB each" (fades in); gone on dragleave; drop → POST 200, chip "dropped-test.txt"; × → DELETE 200 | pass | drag-overlay-dark.png | — |
| F-RG1 | #187: inspector artifact | the Artifacts chunk never loaded | the inspector previews the artifact | artifacts-state.ts `artifactFrame` | html (sandbox `allow-scripts`, its page inside), svg (`sandbox=""`), image: all drawn; **no artifacts-*.js request**; markdown says "No preview for this kind" (by design) | pass | inspector-artifact-*.png | — |
| F-RG2 | #187: ⌘J over Repo | the chunk held 3 s, then released | the panel opens over the skeleton and survives the chunk landing | ask.md › ⌘J | open + focused before; the draft kept after; screen drawn; Escape closes; ⌘J reopens with the draft | pass | cmdj-over-repo.png | — |
| F-RG3 | #187: ⌘J over Org settings | same | same | same | same (a 404 from `/github/repositories` is the screen's own, not Ask's) | pass | lazy | — |
| F-RG4 | #187: ⌘J over Artifacts | same | same | same | same | pass | cmdj-over-artifacts.png | — |
| F-RG5 | #187: ⌘J over Platform | before / after the chunk | — | ask.md says "over any page" | nothing opens: Platform is outside any org (`view: "platform"`), and Ask is per org | question Q-F3 | lazy | — |
| F-RG6 | #187: refs that open lazy screens | inspector › Open in page | the screen loads its chunk and renders | — | artifact → `#artifacts/teacher-dashboard-notes`, repo → `#repo`, sprint → `#sprints/3`; no "Loading", no error | pass | insp | — |
| F-AA1 | "Ask again" | an expired / failed line | — | brief | NOT BUILT: an expired line says "This card expired with its turn. Ask again." with no control | gap | — | — |
| F-EM1 | empty answer | live, 390 reduced, a request for 11 cards | — | — | the model spent the 8 tool calls on lookups, and the final call (`tool_choice: none`) wrote nothing: an answer with 8 steps, no words and no blocks, but the full footer (Copy, Regenerate, Save as artifact, Wrong?, "No sources"). Stored text "" | question Q-F2 | Q-F2-empty-answer.png | — |

Tier 1 Ask screen cases rerun on this build (real routes, no replay):

| id | result | actual (short) |
| --- | --- | --- |
| AU-1 | pass | Workspace: My Work, **Trov**, Tickets … |
| AU-2 | pass | threads 260 px; header "Ask Trov"; the empty state centred with its 4 starters; composer `data-ask-dock=center` (AU-2-empty-centred.png) |
| AU-3 | pass | Pinned / Today / This week / Earlier |
| AU-4 | pass (QA-2 still open) | rename via the route; an HTML title is drawn as text in the list and the crumb; export `text/markdown`, `test-e2e-renamed-bxb.md` |
| AU-5 | pass | "hosting": 7 rows, 6 `<mark>`s, "1 match" |
| AU-6 | pass | chips with live marks; the hover card at ~445 ms (≥ 320) with the repo's verdicts |
| AU-7 | pass | "Smart · 3 sources · Copy · Regenerate · Save as artifact · Wrong?" |
| AU-8 | pass | F-WG1 |
| AU-9 | pass | F-WC* |
| AU-11 | pass | F-SV1 |
| AU-12 | pass | "Ask about this Ctrl J"; 420 px aria-modal panel; context "#87 Ticket"; "Open as thread" |
| AU-13 | pass | Escape closes the @ picker first (panel stays), then the panel |
| AU-14 | pass | the five `/` commands; Shift+Enter makes a new line; the @ picker groups (a space ends the query: "@Token rotation" + Enter SENT the words — by design) |
| AU-15 | pass | attach → chip, upload on attach (F-CH1, F-DR1) |
| AU-16 | pass | Pinecone (Free): Settings "On Free, every question uses Smart."; `modes: [smart]` |
| AU-17 | pass | Northwind: Fast / Smart / Thinking, "…Counts as 5 questions." |
| AU-20 | pass (Q-F4) | Pinecone at cap: "You've used this month's questions." + Upgrade to Pro, no box / Send |
| AU-25 | pass | 480 px; the separator's arrows stop at 720 and 380; Escape closes |
| AU-27 | pass | 360 dark: drawer 300 px modal; the + menu (Attach / Mention / Run a command / Mode / Changes); "Smart · Auto" on an Auto thread; no page scroll. The app's own "Open navigation" button is 40 px (the same on Tickets: not Ask's) |
| AU-28 | pass | Settings › Trov; What Trov can see → Integrations / Repositories / Hosting / Environments |
| AU-29 | pass | F-SP2 |
| AU-30 | pass | Edit → "Sending replaces the answer below."; Escape cancels |
| AK (smoke) | pass | `/ask/state` (enterprise, 3 modes, 4 starters, attach 5 × 10 MB); `/ask/threads` (4 groups); `/ask/peek` in order (`ticket:99999` and `foo:1` hidden, the person lowercased); `/ask/item` 200 / 404; PATCH rename 200; another thread or a bad id 404 |

Not rerun this time (Tier 1 rows that need the replay or the matrix's test orgs, unchanged since the earlier pass):
AU-10, AU-18, AU-19, AU-21, AU-22, AU-23, AU-24 (replay), AU-26, AU-31, AU-32 (the injection thread is not in this
seed; the HTML-title check above stands in).

### Final pass: bugs fixed

- **AU-F-MD1** (F-MD2): bold around inline code showed its `**` raw, both while streaming and in the finished answer.
  `emphasis` (ask-conversation.ts) split each line on code spans before pairing `**`, so a mark on either side of a
  span could not pair, and could pair wrongly across one. Fix: the code spans become placeholders first, emphasis and
  links run on the whole line, and then the spans are put back. Test: `render.ask-conversation.test.ts` › "bold
  around inline code". Commit **53b62388**. Retested: live dark (0 of 3086 frames), all 18 stored threads, and the
  conversation, actions, inspector, cmdj, phone, composer, diagram, stream and integration render files.
- **AU-F-RM1** (F-SH2): under reduced motion the running step's label, "Thinking… Ns" and the wait row's word were
  transparent text on a static gradient, not plain `--fg-55`. The reduced-motion rule has the same selector as the
  sweep but comes earlier in trov.css, so the sweep's `background` / `color` won. Fix: `!important` on the
  reduced-motion rule's `background` and `color`. Test: `render.ask-conversation.test.ts` › "under reduced motion the
  words are plain". Commit **554a4e12**. Retested: the wait row in light and dark with motion on and off (computed
  color / background / animations / a still orb).

### Final pass: questions (spec silent; not guessed)

- **Q-F1** A block is out and a step is running (the ⌘J answer: the ticket card, then "Read your handoffs"). The wait
  row says "Writing…" with the ribbon (`parts.length` wins in `waitOrb`), not the running step's globe or orbits. ask.md
  lists the step's kind first and "composing once a block is out" last. Expected: the running step's orb while a step
  runs, the ribbon only once no step runs. The owner should rule.
- **Q-F2** An answer with no words and no blocks (the model used its 8 calls on lookups, then wrote nothing) shows its
  steps and a full footer: Copy, Regenerate, Save as artifact, Wrong?. Expected: a line that says Trov didn't write an
  answer, with Try again, and no Copy / Save of nothing. The client could also nudge the last call. Not guessed.
- **Q-F3** ⌘J on Platform does nothing. Platform sits outside any org and Ask is per org, so that seems right; ask.md
  says "over any page". Expected: nothing (as now), or a one-line hint. The owner should confirm.
- **Q-F4** At the cap the composer is replaced by the "used up" block, but "Enter to send · Shift+Enter for a new
  line" still shows under it with no box to type in (with QA-6, the starters stay clickable). Expected: no Enter hint
  while blocked.
- Still open from the earlier pass: QA-2 (Delete has no confirmModal) and QA-4 (no footer after Stop until a reload),
  both seen again.

### Final pass: gap

- **"Ask again" on expired / failed lines is not built** (F-AA1). The expired line's reason says "Ask again." as words
  only.

### Final pass: observations (not counted)

- Org settings asks `/github/repositories` and gets a 404 locally (no GitHub App): the screen's own, not Ask's.
- The app's phone "Open navigation" button is 40 px on every screen, not only Ask.
- `POST /ask` still reports `net::ERR_ABORTED` after its last event under wrangler dev (as before; content complete).
- Writes made by these cases on this worktree's D1 only: tickets #92–#94 created then undone (declined); #87's
  assignees changed and restored; handoff #16 claimed; two artifacts saved; test threads 10002–10015.

### Final pass: counts

**90 cases**: 67 new cases (F-*, with F-ONE counted ×11) and 23 Tier 1 reruns (22 AU rows and the AK smoke).
**85 pass**, **2 fail → fixed** (F-MD2, F-SH2), **2 questions** (F-RG5 / Q-F3, F-EM1 / Q-F2), **1 gap** (F-AA1).
Two more questions came up on cases that passed: Q-F1 (on F-OR4) and Q-F4 (on AU-20). Typecheck passed at both fix
commits; the full suite was not run (the master runs the gate).
