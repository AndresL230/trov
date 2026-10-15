// Builds test/ai-evals/{gate.session,digest.session,gate.state,repo.state}/cases.json — the Phase D digest evals'
// REAL cases (docs/architecture/ai.md › Evals): this repository's own history (`git log` of merged PRs' commits,
// branch bursts, trivial pushes to main) and the Personal Dev org's PR cards and dashboard, read on 2026-10-15 over
// the Trov MCP read tools (`get_my_work` previousActivity cards, `get_repo_dashboard` ci / overview) — read-only.
// Run by hand from the repository root (needs the history: the shas below must exist):
//   node scripts/ai-evals/digests-cases.mjs "$PWD"
// then run the live evals (scripts/ai-evals/digests-live.ts) to record the answers again.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const ROOT = process.argv[2];
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });
const REPO = "AndresL230/trov";

const commitsOf = (range, branch, max = 40) =>
  git("log", "--no-merges", "--format=%H%x09%s", range).trim().split("\n").filter(Boolean).slice(0, max)
    .map((l) => { const [h, ...s] = l.split("\t"); return { sha: h.slice(0, 7), subject: s.join("\t").slice(0, 200), branch }; });
const one = (ref, branch) => commitsOf(`${ref}^!`, branch);

// The real cards (pr_summaries what/why/impact) — Personal Dev, get_my_work previousActivity.
const CARDS = {
  185: { title: "Hosting providers: Vercel, Render, Netlify, Fly.io — backend + Org settings › Hosting + Repo › Hosting (#97–#101)", what: "Ships a unified hosting provider interface with Vercel (install or token), Render (API key), Netlify (OAuth or token), and Fly.io (read-only token), plus an Org settings > Hosting page for setup, environment parts, and provider connections. The repo dashboard's Usage tab gains a Hosting section showing each part's last deploy, recent deploy history, and traffic or CPU/memory usage. Hosting data is polled on the repo cron, and Vercel deploy webhooks trigger an immediate poll.", why: "The PR lands work for issues #97 through #101 on main and supersedes #107, adding the screens that previously existed only on a local branch.", impact: "Teams can connect their hosting providers and see deploy status and resource usage for every part of a repo in one place, while Cloudflare and Railway appear as legacy parts alongside them." },
  184: { title: "To review: a checkmark confirmation when you add or dismiss", what: "Adding or dismissing one of Sift's suggestions now shows a confirmation toast with a checkmark at the bottom of the screen, reading \"Added latency to “…”\" or \"Dismissed latency for “…”\", as the row slides out. If the action is refused, the row returns along with the error.", why: "Adding or dismissing a suggestion should be confirmed the way every other write is, based on the owner's review of #182.", impact: "People get immediate feedback that their add or dismiss action was applied, and they see the row restored if it failed." },
  182: { title: "To review: only the row you settle slides out, at once", what: "On a tag's To review tab, adding or dismissing a suggestion now removes only that row, sliding it out and closing the gap immediately while the other rows stay usable. The write runs in the background and the page refreshes without showing a loading state.", why: "Adding one suggestion turned every row's button to \"Adding…\", was slow, and made the page flash through its loading state, as reported by the owner.", impact: "Reviewing suggestions on a tag feels fast and stable, since only the row being acted on changes and a refused suggestion returns with a reason. Under reduced motion the row simply disappears." },
  180: { title: "Tag page bars in their own colours; header crumbs set like the title", what: "Bars on the tag page now take colour from the relevant person under Who writes about it, and from the other tag under Often seen with (falling back to the tag's own colour when unknown). Header breadcrumbs on child screens, including Artifacts, now render at 15px semibold to match the title before them.", why: "Follow-up to #179; the breadcrumb was 13px medium, which looked off next to the title.", impact: "Tag page bars are colour-coded by person or related tag, and the breadcrumb no longer looks mismatched beside the page title." },
  179: { title: "Tags of your own, sorted by Sift", what: "Each organization now gets its own tag list in Org settings, with six starter tags and add, rename, merge, retire, and restore actions. When an admin adds a tag or presses Find items, Sift checks the org's existing items and adds the tag automatically at 85% confidence or more, or suggests it at 60–85% for members to review on the tag page.", why: null, impact: "Teams can manage their own tagging vocabulary and have existing items tagged automatically, and agents' unrecognized tags become suggestions rather than leaving entries stuck in Unplaced." },
};
const MERGES = { 185: "6c965ac5", 184: "45bf29af", 182: "18518565", 180: "4599e266", 179: "b6a71799" };
const BRANCH = { 185: "feat/hosting-screens", 184: "fix/tag-review-toast", 182: "fix/tag-review-flow", 180: "fix/tag-page-bar-colours", 179: "feat/org-tags" };

const base = (id, source, o) => ({ id, source, input: { repo: REPO, login: "AndresL230", subject: "andres", startedAt: "2026-10-15T00:00:00Z", endedAt: "2026-10-15T01:00:00Z", ...o } });
const card = (n) => ({ number: n, title: CARDS[n].title, state: "merged", card: { what: CARDS[n].what, why: CARDS[n].why, impact: CARDS[n].impact } });

// ── Shipped bursts: each merged PR with its card and its own commits ──
const shipped = Object.keys(MERGES).map(Number).map((n) => base(`pr-${n}`, `git log ${MERGES[n]}^1..${MERGES[n]}^2 + the PR's card (Personal Dev, get_my_work)`,
  { commits: commitsOf(`${MERGES[n]}^1..${MERGES[n]}^2`, BRANCH[n], 25), prs: [card(n)], shipped: true }));
// ── Status bursts: work in flight on a branch, no merge ──
const status = [
  base("ai-phase-b", "git log 6183c5d8~6..6183c5d8 on ai/phase-b (open PR #178)", { commits: commitsOf("6183c5d8~6..6183c5d8", "ai/phase-b"), prs: [{ number: 178, title: "Server-side AI: the screens, the pipeline, Jev, Ask Trov and shorter emails", state: "open", card: null }], shipped: false }),
  base("ai-screens-tail", "git log 45575d6b..15b639ef on ai/screens (PR #178)", { commits: commitsOf("45575d6b..15b639ef", "ai/screens"), prs: [{ number: 178, title: "Server-side AI: the screens, the pipeline, Jev, Ask Trov and shorter emails", state: "open", card: null }], shipped: false }),
  base("hosting-plumbing", "git log be0357d0^1..be0357d0^2 (branch hosting-plumbing, before #185 merged)", { commits: commitsOf("be0357d0^1..be0357d0^2", "hosting-plumbing", 20), prs: [], shipped: false }),
  base("hosting-dashboard", "git log 88461e42^1..88461e42^2 (branch hosting-dashboard, before #185 merged)", { commits: commitsOf("88461e42^1..88461e42^2", "hosting-dashboard", 20), prs: [], shipped: false }),
  base("account-deletion", "git log 835284fd^1..835284fd^2 (branch compliance/account-deletion, before #172 merged)", { commits: commitsOf("835284fd^1..835284fd^2", "compliance/account-deletion", 20), prs: [], shipped: false }),
];
const digest = [...shipped, ...status];

// ── Trivial bursts (real commits on main): release-note links and fixes, merges ──
const trivial = [
  base("rn-link-185", "commit b6fb168f on main", { commits: one("b6fb168f", "main"), prs: [], shipped: true }),
  base("rn-link-184-182", "commits 3c173bcf, 1590ca61 on main", { commits: [...one("3c173bcf", "main"), ...one("1590ca61", "main")], prs: [], shipped: true }),
  base("rn-quote", "commit df6af868 on main", { commits: one("df6af868", "main"), prs: [], shipped: true }),
  base("rn-cite-133-132", "commits 9222f07f, d218a96a on main", { commits: [...one("9222f07f", "main"), ...one("d218a96a", "main")], prs: [], shipped: true }),
  base("rn-link-177-176", "commits fa687227, 6841e2ea, 8a466249 on main", { commits: [...one("fa687227", "main"), ...one("6841e2ea", "main"), ...one("8a466249", "main")], prs: [], shipped: true }),
  base("merge-main", "merge commit 5ad0b7ba subject (feat/hosting-screens)", { commits: [{ sha: "5ad0b7b", subject: "Merge remote-tracking branch 'origin/main' into feat/hosting-screens", branch: "feat/hosting-screens" }], prs: [], shipped: false }),
  base("rn-cite-120-117", "commits de770e8f, dd189dba on main", { commits: [...one("de770e8f", "main"), ...one("dd189dba", "main")], prs: [], shipped: true }),
];
const gateSession = [
  ...digest.map((c) => ({ ...c, expected: true })),
  ...trivial.map((c) => ({ ...c, expected: false })),
];

// ── Repo state: real history as a chain of deltas ──
const prCite = (n) => ({ ref: `pr:${n}`, label: `#${n}`, href: `https://github.com/${REPO}/pull/${n}` });
const runCite = (id) => ({ ref: `run:${id}`, label: `CI run ${id}`, href: `https://github.com/${REPO}/actions/runs/${id}` });
const merged = (n) => ({ ref: `pr:${n}`, title: CARDS[n].title, what: CARDS[n].what, why: CARDS[n].why, impact: CARDS[n].impact });
const OPEN = [{ ref: "pr:178", title: "Server-side AI: the screens, the pipeline, Jev, Ask Trov and shorter emails", state: "in review" }, { ref: "pr:186", title: "Repo setups: the Repo screen for every repo setup (handoff #11)", state: "draft" }];
const prevLine = (text, ...cites) => ({ text, cites });
const stateCase = (id, source, o) => {
  const cites = {};
  for (const m of o.merged ?? []) cites[m.ref] = prCite(Number(m.ref.slice(3)));
  for (const p of o.openPrs ?? []) cites[p.ref] = prCite(Number(p.ref.slice(3)));
  for (const d of o.digests ?? []) cites[d.ref] = { ref: d.ref, label: d.summary.slice(0, 80), href: "#feed" };
  for (const r of o.failedRuns ?? []) cites[r.ref] = runCite(Number(r.ref.slice(4)));
  for (const d of [...(o.deploys ?? []), ...(o.parts ?? [])]) cites[d.ref] = { ref: d.ref, label: d.label, href: null };
  const prev = o.previous?.state;
  for (const l of prev ? [...prev.shipped, ...prev.inFlight, ...prev.attention] : []) for (const c of l.cites) cites[c.ref] = c;
  return { id, source, input: { repo: REPO, readAt: "2026-10-15T09:00:00Z", since: "2026-10-14T00:00:00Z", previous: null, merged: [], digests: [], openPrs: [], failedRuns: [], parts: [], deploys: [], eventCount: 0, redMain: false, ...o, cites } };
};
const P179 = { headline: "Organizations now keep their own tag lists, sorted by Sift.", shipped: [prevLine("Each organization has its own tag list, and Sift tags existing items.", prCite(179))], inFlight: [prevLine("Server-side AI screens and pipeline are in review.", prCite(178))], attention: [] };
const P182 = { headline: "Tag review is faster; hosting providers are on their branch.", shipped: [prevLine("Only the row you settle slides out on a tag's To review tab.", prCite(182)), ...P179.shipped], inFlight: P179.inFlight, attention: [prevLine("CI failed on the hosting branch's test suite.", runCite(38674390889))] };
const stateCases = [
  stateCase("first-179", "#179 merged 2026-10-15T02:03 (Personal Dev card); open PRs from gh pr list", { merged: [merged(179)], openPrs: [OPEN[0]], eventCount: 1 }),
  stateCase("add-180", "#180 merged after #179", { previous: { generatedAt: "2026-10-15T02:10:00Z", state: P179 }, merged: [merged(180)], openPrs: [OPEN[0]], eventCount: 1 }),
  stateCase("add-182-red-branch", "#182 merged; CI run 38674390889 failed on feat/hosting-screens (Personal Dev ci tab)", { previous: { generatedAt: "2026-10-15T02:20:00Z", state: P179 }, merged: [merged(182)], openPrs: [OPEN[0]], eventCount: 1 }),
  stateCase("add-184", "#184 merged; the toast follow-up to #182", { previous: { generatedAt: "2026-10-15T02:45:00Z", state: P182 }, merged: [merged(184)], openPrs: [OPEN[0]], eventCount: 1 }),
  stateCase("add-185", "#185 merged 06:43 (hosting providers); #186 opened as a draft", { previous: { generatedAt: "2026-10-15T03:50:00Z", state: P182 }, merged: [merged(185)], openPrs: OPEN, eventCount: 1 }),
  stateCase("digests-only", "Trov digests for the ai/screens pushes (Activity, 07:07–09:06)", { previous: { generatedAt: "2026-10-15T06:50:00Z", state: P182 }, digests: [{ ref: "feed:501", summary: "Status: server-side AI phase B — the router, scopes and the pass", brief: "Trov now notes which parts of a team's work went stale so it can update its summaries in one pass." }, { ref: "feed:502", summary: "Status: repo setups — the Repo screen for every repo setup", brief: "Teams with any repository layout will get a Repo screen that fits it." }], openPrs: OPEN, eventCount: 2 }),
  stateCase("red-main", "CI test-suite failure as on run 38674390889, on main (the gate's red-main shape)", { previous: { generatedAt: "2026-10-15T06:50:00Z", state: P182 }, failedRuns: [{ ref: "run:38674390889", name: "CI", branch: "main" }], openPrs: OPEN, eventCount: 1, redMain: true }),
  stateCase("deploy-and-merge", "#185 merged with a production deploy of trov.dev; production health down (Personal Dev overview)", { previous: { generatedAt: "2026-10-15T03:50:00Z", state: P182 }, merged: [merged(185)], deploys: [{ ref: "deploy:production/web", label: "Production web", state: "error", branch: "main", message: "Merge pull request #185" }], parts: [{ ref: "deploy:production/web", label: "Production web", provider: "cloudflare", latest: "error", poll: "failed" }], openPrs: OPEN, eventCount: 2 }),
];
// The gate.state cases: each state delta above is a change, plus the trivial sessions' digests (no change).
const gateState = [
  ...stateCases.map((c) => ({ id: c.id, source: c.source, input: c.input, expected: true })),
  ...Object.entries(MERGES).map(([n]) => stateCase(`merged-${n}`, `#${n} merged (card)`, { merged: [merged(Number(n))], eventCount: 1 })).map((c) => ({ ...c, expected: true })),
  // A push straight to main (the trivial bursts above, all real commits on main) deploys production (Workers Builds),
  // and gate.session skipped its digest: the delta is that one successful deploy of a trivial commit.
  ...trivial.filter((t) => t.id !== "merge-main").map((t) => stateCase(`quiet-${t.id}`, `the production deploy of the trivial push ${t.source} (its digest skipped by gate.session)`, { previous: { generatedAt: "2026-10-15T06:50:00Z", state: P182 }, deploys: [{ ref: "deploy:production/web", label: "Production web", state: "ready", branch: t.input.commits[0].branch, message: t.input.commits[0].subject }], parts: [{ ref: "deploy:production/web", label: "Production web", provider: "cloudflare", latest: "ready", poll: "ok" }], openPrs: OPEN, eventCount: 1 }))
    .map((c) => ({ ...c, expected: false })),
];

const out = `${ROOT}/test/ai-evals`;
for (const [kind, cases] of [["gate.session", gateSession], ["digest.session", digest], ["gate.state", gateState], ["repo.state", stateCases]]) {
  mkdirSync(`${out}/${kind}`, { recursive: true });
  writeFileSync(`${out}/${kind}/cases.json`, JSON.stringify({ kind, source: "AndresL230/trov git history + Personal Dev (trov-dev) via the Trov MCP read tools (get_my_work cards, get_repo_dashboard ci/overview), read-only, 2026-10-15", cases }, null, 1) + "\n");
  console.log(kind, cases.length);
}
