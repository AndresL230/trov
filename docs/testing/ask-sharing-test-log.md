# Ask sharing — end-to-end browser test log

Feature: sharing an Ask Trov conversation — with the org (`0076_ask_sharing`) and with people by name, each Can read or
Can continue (`0077_ask_people_sharing`) — on PR #193 (`claude/sleepy-archimedes-f28syj`). Spec: `docs/architecture/ask.md`
› Sharing a conversation (cited as **ask.md**), and the owner's rulings of 2026-10-17 (cited as **R**): "there should be
titled Organization and there should also be shared with you, and make capabilities for that too so its different"; per
person, the owner picks Can read / Can continue; a thread shared both ways shows only under Shared with you.
Browser: Claude in Chrome against `wrangler dev` — branch on localhost:8787, base `main` (17a530a4, worktree
`../trov-base`) on localhost:8788. Local D1 only.

**Local environment:** the worktree's `.dev.vars` keeps only `COOKIE_SECRET`, `DEV_LOGIN`, `GITHUB_WEBHOOK_SECRET` and a
FAKE `ANTHROPIC_API_KEY=test-fake-not-a-real-key` (so the composer renders); every other third-party key and both Stripe
keys are commented out. **No case sends a question that calls a model**: every question sent is a `/search` (no model
call, nothing counted — `routes.ts` › `answerSearch`; `parseCommand` turns `/search x` into `command: "search"`). Nothing
is sent to a real person or service.

**Seed:** `node scripts/seed/ask-sharing.mjs` (after `npm run seed`); re-run before any case that reads a fixture a
previous case wrote to. People and fixtures: the script's header. **Roles** (signed in with `/auth/dev/as?handle=<h>`):
owner `test-owner`; continue `test-collab`; read `test-reader`; org-only member `test-member`; one of 50 named
`test-p01`; another org `test-outsider` (Northwind); nothing anywhere `test-empty` (Day One).

Screenshots: [`ask-sharing-shots/`](ask-sharing-shots/).

## Result

**60 cases**: **55 pass**, **3 fail → fixed** (each passes on retest), **2 pre-existing** (the access part of each
passes), and **1 question** (raised by C55, which passes); plus 1 more pre-existing bug found on the way (PRE-2, not
fixed) and 1 pre-existing observation (OBS-1). Final pass from a
clean seed: all 60 as below; full suite and typecheck green.

| | id | what was wrong | cause | fix (commit + test) |
|---|---|---|---|---|
| bug 1 | C22 | Past 50 people, the Share dialog said only "invalid" | the 51-person PATCH failed the schema before the route's own words; the client shows `message` else `error` | `394214f1` — the PATCH's validation failure carries "Share with at most 50 people by name."; `test/ask.people-sharing.test.ts` › "the share list is checked whole" |
| bug 2 | C24 | On a phone, Share… opened the dialog UNDER the threads drawer | the ⋯ menu lives in the drawer (z-index 85) above root dialogs (80), and Share… left the drawer open | `4f119965` — Share… slides the drawer out first, as opening a thread does; `test/render.ask-sharing.test.ts` › "on a phone, Share… from the threads drawer closes the drawer" |
| bug 3 | C59 | A collaborator who deleted their account showed as `deleted-hav45t72pi` (label, "Waiting for …", the file's tooltip) | Ask's own `personName` fell back to the raw handle for anyone not in the member list | `326ce8aa` — `personName` says "Deleted user" for a tombstone; the asker label is `people.ts`'s Deleted user tag; `test/render.ask-sharing.test.ts` › "a collaborator who deleted their account reads as Deleted user" |

**Question for the owner (Q-1, C55):** after the owner turns a person from Can continue to Can read, that person's own
pending card reads "Waiting for Test Collab to confirm it." — while they ARE Test Collab and can no longer confirm it (the
server refuses: read access). The spec says nothing. I'd expect either "Waiting for you — you can read this conversation
now, not act in it." or the card shown as expired for them; left as is until you decide.
**Ruled 2026-10-17:** the first — the owner's words; the asker's own line now reads "Waiting for you — you can read this
conversation now, not act in it." (`test/render.ask-sharing.test.ts` › Q-1).

**Pre-existing, recorded, not fixed (same on `main`):**
- **PRE-1 (C51, C53, C54)** — a link to a thread you can't open (or an unknown id) lands on Ask home with no "not found"
  message. Nothing of the thread shows (the access part passes). Base: `base-unknown-link-home.jpg`.
- **PRE-2** — on a phone, Delete's confirmation opened from the threads drawer also sits under the drawer (same cause as
  bug 2: Delete doesn't close the drawer). Fixing it is the same one line in `askThDelete`; left for your word. **Fixed 2026-10-17** at the owner's word:
  Delete slides the drawer out first (`test/render.ask-sharing.test.ts` › PRE-2).
  `pre-delete-under-drawer-branch.jpg`, `base-delete-under-drawer.jpg`.
- **OBS-1** — after a new turn, the previous turn's proposed card still shows Confirm / Cancel until a reload (the server
  has already expired it; pressing Confirm would say so). Base the same: `base-OBS1-stale-card.jpg`.

## Matrix

Surfaces × the dimensions that apply. Count: **60 cases** (≤ 150: run without a size check-in).

| Surface | Dimensions crossed | Cases |
| --- | --- | --- |
| Thread list (own rows, Shared with you, Organization) | 7 roles; desktop / 360px; light / dark; long unicode; HTML in a title | C01–C11 |
| Thread ⋯ menu | private / shared; owner / shared reader | C12–C14 |
| Share dialog | private / both / at cap; open, add, change, remove, cancel, save, double save, stale save; keyboard; 360px; dark | C15–C27 |
| Stop sharing | owner; effect on collab, reader, member | C28 |
| Conversation + composer | owner / continue / read / org member; own turn vs other's; last vs earlier; files; cards; mode, Auto, draft; send `/search`; upload | C29–C45, C60 |
| Header mark | owner / collab | C46 |
| Delete confirm + delete | private / org / people; effect on a collaborator | C47–C50 |
| Direct links and access changes | not named, other org, removed owner, private, downgrade, removal | C51–C56 |
| Unicode and HTML | desktop / 360px; console | C57–C58 |
| Account deletion | a collaborator deletes their account | C59 |

**Dropped combinations:** a question that calls a model (would contact Anthropic: the protocol forbids live keys — the
continue path is driven with `/search`, which stores the same asker rows); light/dark and phone on every case (one case
each for the list, the dialog and the conversation — they share one stylesheet); reduced motion (this browser tool cannot
emulate `prefers-reduced-motion`; the CSS rule is pinned by `test/render.*`); signed-out (the Ask routes are behind the
tenant gate; no sharing surface exists signed out); an Ask answer with sources or item cards from someone else's turn being
re-resolved (no model call to make one; `test/ask.sharing.test.ts` covers it at the route).

## Baseline

- **Branch, before the e2e fixes** (727c7354): typecheck clean; full suite 8,606 pass / 1 fail —
  `seed-scenarios` › "has rows in EVERY org-keyed table" (the new table had no team-seed rows; fixed in the same commit by
  seeding `chat_thread_people` in `scripts/seed/ai-showcase.mjs`, rerun green).
- **Base `main` (17a530a4)**: full suite 8,571 pass / **2 fail** — `ai.brief` › "a number the input does not have drops
  the line" (date-dependent on the 17th; #193 fixes it) and `artifacts.security-raw` › "R2 streaming round trip" (a
  timeout under load; passes alone).
- **Base screens** (AndresL230, team seed): Ask conversation and its ⋯ menu (Rename, Pin, Export as markdown, Delete) —
  `base-owner-conversation.jpg`, `base-owner-menu.jpg`. Console: no errors. Network: every `/api` call 200. On base,
  Regenerate shows on EVERY stored answer (the server replaces only the last — pre-existing; this branch now offers it on
  the last answer only, `ask-conversation.ts` › `footer`).
- **Branch screens before any case**: console clean except a browser extension's `[WindowMode]` warnings (not the app);
  no failed requests.

## Cases

`expected` was written before each case ran. Result: pass / fail / pre-existing / question.

| id | surface | state (fixture, role, viewport, theme) | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|
| C01 | list | all fixtures, test-owner, desktop, light | Own groups list test-private (no mark), test-org-only, test-people-only, test-both, test-unicode…, test-<img…>, test-at-cap (each with the shared mark). No "Shared with you" / "Organization" row is one of the owner's own threads. | ask.md | As expected; Organization holds only AndresL230's threads | pass | `C01-owner-list.jpg`, DOM | |
| C02 | list mark tooltips | as C01 | org-only "Shared with SaplingLearn."; people-only names a person and how many others; both: SaplingLearn and 2 people; private: no mark | ask.md › On the screen | "Shared with SaplingLearn." / "Shared with Test Collab and Test Reader." / "Shared with SaplingLearn and 2 people." / none; at-cap "Shared with Test Person 1 and 49 others." | pass | DOM | |
| C03 | list | test-collab, desktop, light | Shared with you: test-people-only, test-both, test-unicode… each "· Can continue". Organization: test-org-only, test-<img…> (not test-both). test-removed-owner nowhere. Own list empty. | R; ask.md | As expected | pass | `C03-collab-list-light.jpg` | |
| C04 | list | test-reader | Shared with you: test-people-only, test-both (no "Can continue"). Organization: test-org-only, test-<img…>. | R; ask.md | As expected | pass | DOM, `C37-C39-reader.jpg` | |
| C05 | list | test-member | No Shared with you. Organization: test-org-only, test-both, test-<img…>; not people-only, unicode, at-cap, private. | ask.md | As expected | pass | DOM | |
| C06 | list | test-p01 | Shared with you: test-at-cap. Organization: test-org-only, test-both, test-<img…>. | ask.md | As expected | pass | DOM | |
| C07 | list | test-outsider (Northwind) | Own list: test-other-org. No SaplingLearn thread anywhere. | ask.md | As expected | pass | DOM | |
| C08 | list | test-empty (Day One) | No threads, no shared sections; the empty state. | ask.md | "No threads yet", no sections | pass | `C08-empty.jpg` | |
| C09 | list | test-collab, 360px | Drawer opens; both sections; long title truncates; no horizontal scroll. | protocol | As expected; scrollWidth 360 = width | pass | `C09-phone-drawer.jpg` | |
| C10 | list | test-collab, dark | Readable in dark. | protocol | Readable (text rgb 237,233,226 on dark) | pass | `C10-collab-dark.jpg`, `final-C10-reader-dark.jpg` | |
| C11 | list | test-member, HTML title | Literal text; no console "XSS-FIRED". | protocol | Literal in list and header; console clean | pass | `C11-C58-html-member.jpg` | |
| C12 | ⋯ menu | test-private, owner | Rename, Pin, Share…, Export as markdown, Delete — no Stop sharing. | ask.md | As expected | pass | DOM | |
| C13 | ⋯ menu | test-people-only, owner | As C12 plus Stop sharing. | ask.md | As expected | pass | DOM | |
| C14 | shared row | test-collab | One button, no ⋯ menu. | ask.md | 7 rows, 0 "Thread actions", 1 button each | pass | DOM | |
| C15 | Share dialog | test-private, owner | Title, Organization on No access, no people, Add a person, note, Cancel / Save. | ask.md | As expected; focus on No access | pass | screenshot | |
| C16 | Share dialog | test-both, owner | Organization Can read; Test Reader Can read; Test Collab Can continue. | ask.md | As expected | pass | `C16-C17-both-dialog.jpg` | |
| C17 | Share dialog | test-both, owner | Add a person: members except the owner and those named. | ask.md | 59 options; no Test Owner/Reader/Collab; Test Member present | pass | option dump | |
| C18 | Share dialog | test-private, owner | Cancel: no PATCH; DB unchanged. | ask.md | No write request; DB unchanged | pass | fetch log + DB | |
| C19 | Share dialog | test-private, owner | ONE PATCH `{shared:true, people:[{test-member, continue}]}` → 200; mark; DB rows. | ask.md | Exactly that body, 200; tip "Shared with SaplingLearn and 1 person."; DB matches (the flash was gone before a screenshot) | pass | fetch log + DB + `C19-after-save.jpg` | |
| C20 | Share dialog | test-both, owner | Reader → Can continue; DB updated. | ask.md | PATCH 200; DB continue | pass | fetch log + DB | |
| C21 | Share dialog | test-both, owner | Remove Test Collab; DB keeps only reader. | ask.md | Gone from the dialog; PATCH without them; DB matches | pass | fetch log + DB | |
| C22 | Share dialog | test-at-cap, owner | 51st person: the server's 400 → an error line, dialog stays, DB 50. | ask.md | Before the fix the line read "invalid". After: PATCH 400, "Share with at most 50 people by name.", DB 50 | fail → fixed | `C22-retest-cap-message.jpg` | `394214f1` |
| C23 | Share dialog | owner, keyboard | Focus in the dialog; Tab cycles inside; Escape closes the dropdown first, then the dialog. | ask.md | Focus No access; Tab: Add a person → Cancel → Save → No access; Esc #1 dropdown only, #2 dialog | pass | `C23-*.jpg`, `final-C23-*.jpg` | |
| C24 | Share dialog | owner, 360px | Fits; every control reachable; no horizontal scroll. | protocol | Before the fix the dialog opened under the threads drawer. After: drawer closes, dialog is a bottom sheet 0–360, on top, Cancel/Save reachable | fail → fixed | `C24-before-dialog-under-drawer.jpg`, `C24-C25-retest-phone-dark.jpg` | `4f119965` |
| C25 | Share dialog | owner, dark | Readable. | protocol | Readable | pass | `C24-C25-retest-phone-dark.jpg`, `final-C25-dialog-dark.jpg` | |
| C26 | Share dialog | owner, double Save | At most one PATCH; no duplicate rows. | protocol | One PATCH 200; one row | pass | fetch log + DB | |
| C27 | Share dialog | owner, stale | Membership removed before Save: 400 + line; nothing changed. | ask.md | 400; "Share only with members of this organization, other than you, each once."; DB unchanged | pass | fetch log + DB | |
| C28 | Stop sharing | test-both, owner | `PATCH {shared:false, people:[]}`; mark goes; collab, reader, member lose it. | ask.md | Exactly that, 200; mark gone; all three 404 + unlisted (flash not captured) | pass | fetch log + curl + `C28-after-stop-sharing.jpg` | |
| C29 | conversation | test-people-only, collab | "Test Owner" on the owner's question; "You" on theirs. | ask.md | As expected | pass | `C10-collab-dark.jpg` | |
| C30 | conversation | test-people-only, collab | The owner's turn: Copy only; their card no Confirm. | ask.md | As expected | pass | `C10-collab-dark.jpg` | |
| C31 | conversation | test-people-only, collab | Their last turn: Regenerate, Save, Wrong?, Confirm/Cancel; their file a control. | ask.md | As expected; chip is a button (`askCvOpen`) | pass | `C10-collab-dark.jpg` + DOM | |
| C32 | composer | test-people-only, collab | Composer + note "Test Owner shared this with you. You can continue it: your questions are asked as you." | ask.md | As expected | pass | `C10-collab-dark.jpg` | |
| C33 | send | test-people-only, collab | `/search test`: `POST /ask` 200; rows asked_by test-collab; stays under Shared with you; mode/draft unchanged. | ask.md | As expected | pass | fetch log + DB + `C33-after-search-send.jpg` | |
| C34 | composer | test-people-only, collab | Mode and Auto: no PATCH. | ask.md | Composer "Mode: Fast", no write request, DB smart / Auto 0 | pass | fetch log + DB | |
| C35 | composer | test-people-only, collab | Draft: no PATCH; DB draft unchanged. | ask.md | As expected | pass | fetch log + DB | |
| C36 | card | test-people-only, collab | Cancel own card: 200; DB cancelled. | ask.md | As expected | pass | fetch log + DB + `C36-cancel-own-card.jpg` | |
| C37 | conversation | test-people-only, reader | No composer; "…shared this conversation with you. You can read it, not continue it." | ask.md | As expected | pass | `C37-C39-reader.jpg` | |
| C38 | conversation | test-people-only, reader | No Edit/Regenerate/Save/Wrong?/Confirm; collab's file "· Private". | ask.md | As expected | pass | DOM | |
| C39 | conversation | test-people-only, reader | No follow-ups, no Try again. | ask.md | As expected | pass | DOM | |
| C40 | conversation | test-org-only, member | "…with SaplingLearn…"; owner's file Private (whose); "Waiting for Test Owner to confirm it." | ask.md | As expected | pass | `C40-member-org-only.jpg` | |
| C41 | conversation | test-people-only, owner | Collab's turn labelled; no Regenerate/Save/Wrong?; waiting card; their file Private. | ask.md | As expected | pass | `C41-owner-people-only.jpg` | |
| C42 | conversation | test-people-only, owner | Owner's earlier turn: Save, Wrong?; no Regenerate. | ask.md | As expected | pass | `C41-owner-people-only.jpg` | |
| C43 | conversation | test-both, owner | Owner's last answer: Regenerate; card Confirm/Cancel. | ask.md | As expected | pass | `C43-owner-both.jpg` | |
| C44 | composer | test-both, owner | Owner's mode change PATCHes the thread. | ask.md | PATCH 200; DB fast | pass | network + DB | |
| C45 | conversation | collab, 360px | Fits; no horizontal scroll. | protocol | As expected | pass | `C57-C45-phone-collab-unicode.jpg` | |
| C46 | header | owner, then collab | Owner: with whom. Collab: who shared it and that they can continue. | ask.md | "Shared with Test Collab and Test Reader." / "Test Owner shared this with you. You can read it and continue it." | pass | DOM | |
| C47 | delete confirm | test-private, owner | No shared sentence. | ask.md | As expected | pass | `C47-delete-private.jpg` | |
| C48 | delete confirm | test-org-only, owner | "It is shared with SaplingLearn, so it goes for everyone there too." | ask.md | As expected | pass | modal text | |
| C49 | delete confirm | test-people-only, owner | "It is shared with … so it goes for them too." | ask.md | "It is shared with Test Collab and Test Reader, so it goes for them too." | pass | modal text | |
| C50 | delete | test-people-only, owner | DELETE 200; collab loses it; collab's file stays theirs. | ask.md | As expected | pass | network + curl + DB | |
| C51 | link | #ask/97003, test-member | The not-found state; nothing shows. | ask.md | Nothing shows; but no message — Ask home (base the same) | pre-existing | `C51-member-link-home.jpg`, `base-unknown-link-home.jpg` | |
| C52 | link | /saplinglearn/#ask/97002, test-outsider | Refused; nothing shows. | ask.md | Org picker "That organization didn't open" | pass | `C52-outsider-refused.jpg` | |
| C53 | link | #ask/97005, test-collab | Not found. | ask.md | Unlisted, nothing shows, API 404 (no message: PRE-1) | pass | DOM + curl | |
| C54 | link | #ask/97001, test-member | Not found. | ask.md | Nothing shows; no message (PRE-1) | pre-existing | DOM | |
| C55 | access change | owner downgrades collab | No composer, read line, "Can continue" gone. | ask.md | As expected — and their own pending card reads "Waiting for Test Collab…" (Q-1) | pass + question | `C55-collab-downgraded.jpg` | |
| C56 | access change | owner removes collab | Row gone; link not found. | ask.md | As expected | pass | network + curl + DOM | |
| C57 | unicode | test-unicode…, collab, desktop + 360px | CJK, Arabic, emoji intact; long word wraps; no overflow. | protocol | As expected | pass | `C57-C45-phone-collab-unicode.jpg` | |
| C58 | HTML | test-<img…>, member | Tags as text; no XSS log; no img request. | protocol | As expected | pass | DOM + console + network | |
| C59 | account deletion | collab deletes their account | Owner's thread keeps every turn; collab's labelled as deleted; file gone; no share row. | ask.md › Deleting | DB as expected. Before the fix the screen showed `deleted-hav45t72pi`. After: "Deleted user" label, waiting line and tooltip | fail → fixed | `C59-before-raw-tombstone.jpg`, `C59-retest-deleted-user.jpg` | `326ce8aa` |
| C60 | upload | test-people-only, collab | Their file a control for them; "· Private" for the owner. | ask.md | As expected; DB author test-collab, private | pass | `C60-owner-sees-collab-file.jpg` + DB | |

## Final pass

From a clean seed after all three fixes, every case was run again — the read-only ones by an in-browser harness (the app in
a same-origin iframe, people switched through `/auth/dev/as`, widths set on the frame, real DOM events; the same checks as
the expected column), C23 and C25 with real key presses and screenshots, the writes with a reseed between groups. All 60
gave the results above. Two harness misreads were re-checked by hand and are not app bugs: C03 (the row text was cut at 60
characters before "Can continue") and C09 / C34 (read before the drawer / the mode menu had painted).

Full suite on the branch after the fixes: **393 files, 8,609 tests, all pass**; `npm run typecheck` clean. Nothing that
passed on the base fails here.
