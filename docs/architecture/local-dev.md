# Local development: a seeded app, named scenarios, signing in as anyone

How to get a working local Trov with realistic data, switch between the states a feature has to handle, and act as
any person — without OAuth, a network, or hand-made rows. Code: `scripts/seed-dev.mjs` (`npm run seed`),
`scripts/seed/scenarios.mjs` (the scenarios), `scripts/seed/team-rich.mjs` + `team-content.mjs` (the team's rich
layer), `scripts/dev/ensure-seeded.mjs` (run by `npm run dev`), `scripts/dev/as.mjs` and `src/auth/dev-signin.ts`
(signing in as someone). Test: `test/seed-scenarios.test.ts`.

**The test seed is a different thing.** `scripts/seed/reset.mjs` is the canonical TEST seed: the harness runs it before
every test and the suites assert on its rows. Nothing here changes what it produces; the scenarios write their own rows
on top of the same tables.

## One command

```sh
npm run dev          # build the web app, then: .dev.vars if missing, local migrations, seed an EMPTY local D1, wrangler dev
npm run dev:seeded   # the same, but always reseeds every scenario first
```

`npm run dev` runs `scripts/dev/ensure-seeded.mjs` before `wrangler dev`:

1. **`.dev.vars`** — when it is missing: copied from the main checkout's (in a git worktree), else written from
   `.dev.vars.example` with a random `COOKIE_SECRET` and `TROV_KEK` and `DEV_LOGIN=AndresL230`. Never overwritten.
2. **The local migrations** — `wrangler d1 migrations apply DB --local`.
3. **The seed** — every scenario, when the local D1 has no organization members yet.

**Worktrees.** Each git worktree has its OWN `.wrangler/state` (so its own empty D1). That is why the seed runs on the
first `npm run dev` of a worktree: a fresh worktree opens to a populated My Work, Feed, Tickets, Roadmap, Docs, Review
and Repo with nothing else to do. To reuse another checkout's data instead, copy its `.wrangler/state` over before
starting (the AI build's preview server does this: `cp -r <other>/.wrangler/state .wrangler/`).

Open `http://localhost:8787/saplinglearn/` (the `team` scenario). `DEV_LOGIN` signs every request in as that person.

## The scenarios

Each scenario is a complete organization of its own, rewritten whole on every load (all of the org's rows go first —
every table with an `org_id` column, children first, read from the live schema — then it is written again, stamped
against the clock, so every screen reads current). Other orgs, your sessions and anything you created elsewhere are
kept.

| Scenario | Org (`/slug/`) | What it is | Sign in as |
| --- | --- | --- | --- |
| `team` | SaplingLearn `/saplinglearn/` | A busy small team building Sapling (an ed-tech study app): the canonical dev fixtures (`fixtures/dev/*.json`), the RICH LAYER (`team-rich.mjs`: 73 more tickets in every status with comments, links and sub-tickets; four sprints — done, late, current, planned — and the fixture sprints dated against today (`CANONICAL_SPRINT_DATES` / `datedRoadmap`: sprint 3 done, so 7002 "Gradebook export rework" is the ONE late sprint; every dev seed that loads `fixtures/dev/roadmap.json` dates it the same way, the e2e seed's base included, while the fixture file keeps the absolute dates the test seed pins); ten handoffs pending / claimed / expired; 41 feed entries over six weeks in every kind; seven docs with history and staged proposals; decisions, Unplaced items, prompts, artifacts; twelve weeks of repository activity — pushes, PRs, reviews, CI runs, deploys on staging and production, fresh health, hourly usage, product metrics, coverage, releases), then the AI SHOWCASE (`ai-showcase.mjs`: the brief, repo state, Trov's digests, Sift, the AI cards, Ask threads). **Every org-keyed table has rows here.** | `AndresL230` (owner), `Jose-Gael-Cruz-Lopez` (admin), `meilin`, `sanaok`, `priya-n`, `omar-h` (members) |
| `empty` | Day One Labs `/dayone/` | Created two hours ago; nothing in it — every empty state and the setup checklist. | `robin-vale` (owner) |
| `free-at-cap` | Pinecone Tutoring `/pinecone/` | On Free with EVERY limit reached: seats (2 members + a pending invite), 1 repository, 2 environments, 30 tags, 250 MB of artifacts (the bytes are not stored locally — the library counts them; opening one fails), 5 agent connections, this month's summaries / AI runs / Sift checks / Ask questions. | `kai-moreno` (owner), `lena-fox` (member) |
| `pro` | Northwind Academy `/northwind/` | On Pro, well inside its limits; a little work of its own. Sana is an admin here AND a member of SaplingLearn — a person in two orgs. | `amara-osei` (owner), `sanaok` (admin), `theo-lind`, `jun-park` (members) |
| `hosting` | Fernhill Labs `/fernhill/` | Three environments whose parts are in every connection state: Vercel installed (connected), Fly.io token (connected), Render (error: the token was refused), Railway (not connected, two leftover project tokens), Netlify (revoked on Netlify's side), Cloudflare (connected, last good reading three days ago). | `ines-garcia` (owner), `AndresL230` (admin) |

```sh
npm run seed                              # every scenario
npm run seed -- --scenario hosting        # just one (or several: team,pro)
npm run seed -- --reset                   # wipe every data table first (the canonical reset), then every scenario
npm run seed -- --list                    # the scenarios and who to sign in as
npm run seed -- --server http://localhost:8787   # see Ask chips below
```

**With or without `--reset`, on any local D1.** A scenario writes everything it depends on (its org, its people, the
global rows it names), so the plain `npm run seed` loads on a freshly migrated D1 too — one that holds SaplingLearn's
org row alone (`test/seed-scenarios.test.ts` › "a freshly migrated D1"). Acme (`org_b`, the test seed's empty
neighbour) and its Platform demo rows (an owner, a little usage, the admin trail; `platform-dev.mjs`) are the reset's:
only `--reset` writes them. `npm run dev` passes `--reset` when the local D1 has no members yet.

**Ask chips.** The showcase stores each item an Ask answer cites as the RUNNING server's RefView (`POST
/ask/peek`). `npm run seed` asks the dev server at `:8787` (or `--server`) and uses it when it answers; when nothing
answers (the seed `npm run dev` runs before `wrangler dev` starts), the answers keep their words without chips — run
`npm run seed -- --scenario team` once the server is up to get them.

**Health readings go stale.** Repo › Overview treats a health reading older than 30 minutes as stale, by design. The
seed writes fresh ones; after half an hour, `npm run seed -- --scenario team` makes them fresh again.

**Credentials are placeholders.** Every stored hosting credential is a ciphertext that decrypts to nothing, every
MCP / OAuth token row a hash no token produces. Poll now and Test connection fail locally; that is expected.

## Layers on a server you already have

The rich layer and the AI showcase also run ALONE, on top of whatever SaplingLearn holds — the shared preview server
of the AI build, for instance. Both are idempotent and own fixed id blocks (the header of each lists them):

```sh
cd ~/Projects/trov-preview-ai                          # the folder the running wrangler dev serves
node <this repo>/scripts/seed/team-rich.mjs            # the rich layer (or scripts/seed/team-rich.mjs once that checkout has it)
node <this repo>/scripts/seed/ai-showcase.mjs --server http://localhost:8790   # then the AI rows, so they talk about it
```

What Trov wrote (the brief, the repo state, the themes, the Roadmap's notes, drift and suggestions, the AI cards)
shows only with an `ANTHROPIC_API_KEY` in `.dev.vars` — the AI read rule (`ai.md` › The read rule: no key reads
exactly like the org's switch off). Any value shows the seeded rows; the AI pass will try it, and a fake one only
fails its calls quietly. Trov's feed entries and Sift's ratings show either way.

`team-rich.mjs` replaces SaplingLearn's environments, parts and deploys — the rows `scripts/seed/repo-setups.mjs` (the
repo-setups e2e fixtures) writes for it; whichever runs last wins. Both print a per-surface check list.

## Signing in as someone else

```sh
npm run dev:as -- meilin                  # prints http://localhost:8787/auth/dev/as?handle=meilin — open it
npm run dev:as -- sanaok --org northwind  # straight into one of their orgs
npm run dev:as                            # everyone in the local D1, by org and role
```

Or open `http://localhost:8787/auth/dev/as` and pick. The route makes an ORDINARY session (`createSession`, the
session cookie) for that person — not an auth class of its own (CLAUDE.md invariant 8) — and a session cookie now wins
over `DEV_LOGIN` (`sessionGate`, `resolvePrincipalOrDev`), so the browser stays that person until `/auth/dev/out`,
which drops the session and goes back to `DEV_LOGIN`'s. In production (no `DEV_LOGIN`) nothing changes.

It is honoured only when ALL of these hold (`devSignInAllowed`), and is a bare 404 otherwise:

- `DEV_LOGIN` is set (the local-only `.dev.vars` value — no `DEV_LOGIN`, and the session gate answers first: 401);
- the request came to a LOOPBACK http origin — `http://localhost:*` or `http://127.0.0.1:*`, what `wrangler dev`
  serves on (`src/platform/loopback.ts`, the rule of `LOCAL_UPSTREAM` and `LOCAL_AI_PREVIEW`); `http://[::1]` is not
  one;
- the Worker holds no live Stripe key (`holdsLiveKey`).

## Never remote

Every seed CLI refuses `--remote` before it calls wrangler, and every wrangler call it makes is `--local`;
`test/seed-scenarios.test.ts` reads their source and fails otherwise (and fails when the dev sign-in's guard is
weakened). Every person a scenario adds is made up, with an `example.com` address; the team's six are the canonical
seed's.

## Adding to it

- **A new table with an `org_id` column** must get rows in the `team` scenario — `test/seed-scenarios.test.ts` fails
  until it does (the same list as `ORG_TABLES`, `src/deletion/tables.ts`). Plumbing-like rows go in
  `plumbingStatements` (`team-rich.mjs`), content in `team-content.mjs`.
- **A feature that adds a STATE** adds its fixture: a new scenario in `scripts/seed/scenarios.mjs` (its own org: an
  `org_dev_*` id, a slug, made-up people with example.com addresses, a line in the table above and a test in
  `seed-scenarios.test.ts` that it holds its promise), or rows in the scenario that fits.
- **Dates are relative**: write "days ago" (`makeClock(now).days(n)`, negative = the future), never a fixed date.
- **Ids**: the team's rich layer owns 7000–7999 (tickets 7008–7080 carry the numbers 8–80); the AI showcase owns
  9500–9599 and 9800–9899; the other scenarios use 6100–6299. A rerun deletes and rewrites only what it owns.

## Not done yet

- The sample previews (`repo-sample.ts`, the Hosting sample preview, `shared/ai-fixtures.ts`) still carry their own
  data; feeding them from the scenarios' rows is left for later.
- Ask chips need the dev server running when the seed runs (above).
