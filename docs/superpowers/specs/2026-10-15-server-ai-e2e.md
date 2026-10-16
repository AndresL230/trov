# Phase H: test the server-side AI system end to end in the browser

> The owner's instruction (2026-10-15): run this **at the very end of the handoff #10 build**, after Phases A–G
> are merged into `ai/screens` (PR #178). It replaces Phase G's "screenshots of every AI screen and email" — this
> run produces them. `{{feature}}` = **server-side AI** (the log is `docs/testing/server-ai-test-log.md`, the seed
> `scripts/seed/server-ai.mjs`). `{{spec}}` = `docs/superpowers/specs/2026-10-15-server-ai-build.md`, Trov handoff
> #12 section 2 for Ask's backend, and PR #178's description. Ask Trov has no frontend in this PR (handoff #12
> builds it on `ai/ask`): its surfaces are tested through its routes and SSE in the browser's own `fetch`, not
> screens. The base branch is `main`.

You built server-side AI. Now prove it works by using it the way a person would: in a real browser, against a
local database seeded with every state it has to handle. Unit tests passing is not the goal. The goal is a written
record of what should happen in each case, what did happen, and a fix for every difference.

The expected behaviour comes from the spec above (the spec, PR description, ticket or design). Where that source
says nothing, you do not invent an answer. You ask.

## Rules

- **Local only.** Run the app locally against a local database. Never point at a remote or production database,
  never use live payment, email or third-party keys, and never send anything to a real person or service.
- **Expected before actual.** Write what should happen before you run a case. Never edit an expectation to match
  what you saw, unless the person tells you the expectation was wrong.
- **Evidence or it didn't pass.** Every result cites evidence: a screenshot, the visible text, the console, the
  network request, or the database rows after.
- **Use a real browser.** Use the browser automation this session has (Playwright MCP, Claude in Chrome, the in-app
  browser, or Playwright scripts). If none works, stop and say so. Don't fall back to reading the code and calling
  it tested.
- **Stay in scope.** Fix bugs in server-side AI and anything it broke. A bug that already exists on the base branch
  is recorded, not fixed, unless the person says otherwise.

## 1. Map the feature

1. Run `load-context` if you have Trov. Read the diff against the base branch (`git diff --stat <base>...HEAD`,
   then the files), and read the spec in full.
2. List every **surface**: each screen, panel, modal, route, API endpoint, background job and email the feature
   adds or changes.
3. List every **dimension** the feature branches on. Look in the code for each `if`, guard, permission check, plan
   check, empty check and error path. Typical dimensions:
   - who is looking: signed out, member, admin, owner, another org's member
   - plan or flag: free, paid, feature off, switch off, missing key
   - data state: empty, one item, many items, at a limit or cap, past it, stale, malformed, deleted
   - async state: loading, success, slow, failed, retried, partial
   - input: valid, empty, too long, unicode and emoji, HTML or markdown injection, duplicate submit
   - environment: desktop and phone width (360px), light and dark, reduced motion, keyboard only
4. Build the **test matrix**: every surface crossed with every combination of the dimensions that apply to it. Drop
   a combination only when it cannot occur (say why in one line). Write the count. If it is over 150 cases, show the
   person the matrix and the count before running it.

## 2. Seed the data

1. Write a seed script for this feature, next to the repo's existing seed scripts (or `scripts/seed/<feature>.*` if
   there are none). It must:
   - create one named fixture per data state in the matrix (for example `empty-org`, `org-at-cap`,
     `ticket-with-50-comments`, `member-not-admin`)
   - be idempotent, and reset to a clean state on each run
   - use obviously fake data (`test-` prefixes, example.com emails)
2. Run it, then query the database to confirm each fixture exists with the rows you meant.
3. Reset between cases whenever a case writes data, so one case never leaks into the next.
4. Commit the seed script. The next person to touch this feature will need it.

## 3. Take the baseline

Before running any case, record where things stand, so a new bug can be told apart from an old one.

- The test suite and typecheck on this branch: pass or fail, with the failing names.
- The same suite on the base branch (in a worktree).
- For each surface that existed before this feature: a screenshot and the console output on the base branch, with
  the same seed.
- Any console error or failed network request that shows up on a page before you have touched anything.

Write this in the log (below) under **Baseline**.

## 4. Run each case

Keep a log at `docs/testing/server-ai-test-log.md`. One row per case:

| id | surface | state (fixture, role, viewport, theme) | expected | source | actual | result | evidence | fix |
|---|---|---|---|---|---|---|---|---|

For each case, in order:

1. **Expected.** Write what should happen: what renders, what text, what is enabled or hidden, what request is made,
   what rows change, what the error says. Cite the line in the spec or the code it comes from. If the spec doesn't
   say, mark it `question` and move on; don't guess.
2. **Set up.** Load the fixture, sign in as the role, set the viewport and theme.
3. **Act.** Drive the browser: click, type, submit, go back, refresh mid-action, double-click submit, resize.
4. **Observe.** Record what actually happened: a screenshot, the visible text, console errors, network calls and
   their status, and the database rows after.
5. **Compare.** Mark the result:
   - `pass`: actual matches expected, with evidence
   - `fail`: they differ
   - `pre-existing`: it fails the same way on the base branch
   - `question`: the expected behaviour isn't specified

Also check, on every case: no console errors, no failed requests you didn't expect, no layout overflow or
horizontal scroll, every control reachable by keyboard, and text readable in both themes.

## 5. Fix and retest

When a case fails:

1. Find the cause. Write it in one line in the log.
2. Write a test that reproduces it (unit, integration or browser, whichever is closest to the bug), and watch it
   fail.
3. Make the smallest fix that makes that test pass.
4. **Retest that case in the browser,** then every other case that runs through the same code path (same component,
   same handler, same query). Note which ones you reran.
5. Commit the fix and its test together, with the case id in the message. Put the commit in the log's `fix` column.

Don't batch fixes. One bug, one fix, one retest, then carry on.

## 6. Final pass

1. Rerun the whole matrix once from a clean seed, now that all fixes are in. A fix can break a case that passed
   earlier.
2. Rerun the full test suite and typecheck. Compare with the baseline: nothing that passed there may fail now.
3. Put the screenshots in one folder and link them from the log.

## Report

- The matrix size, and counts of pass, fail fixed, pre-existing and question.
- Each bug: case id, what was wrong, the cause, the fix commit and its test.
- Every `question`, with what you'd expect and why, for the person to decide.
- Pre-existing bugs you found but didn't fix.
- Combinations you dropped, and why.
- The seed script's path and how to run it.

If you have Trov, call `record_session` once at the end, citing the fix commits.
