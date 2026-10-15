// THE BRIEF's eval set (`brief.person`, src/ai/brief.ts): input bundles in the exact shape the server builds
// (`BriefInput`), and the rules every answer is graded by (./grade.ts). Recorded live answers: ./recorded.json
// (written by scripts/ai-evals/brief-live.ts, run by hand with a real key — never in the suite); the CI test
// replays them (test/ai-evals.brief.test.ts).
//
// SOURCE. Every title, summary, card, note, ticket and handoff below is a REAL row of Andres's **Personal Dev** org
// (`trov-dev`, repository AndresL230/trov), read 2026-10-15 through Trov's MCP read tools — `get_my_work`,
// `list_tickets`, `list_handoffs`, `get_feed`, `get_repo_dashboard` (tab code) — read only. Personal Dev has ONE
// member and NO sprints, so a few things are ARRANGED around those real rows, and each case says which:
//   • a sprint and its date (cases `overdue-sprint`, `cut-to-five`): Personal Dev has none;
//   • a teammate's view (case `someone-waiting`): handoffs #11 and #3 really were left for anyone by andres;
//   • a CI run's id (case `failing-pr`): #179's checks really failed (get_repo_dashboard), its run id is a stand-in;
//   • `today`, set to when the rows were current.
// The ORDER of Next is always the server's (`orderNext`), never written by hand.
import type { AiCite } from "@shared/ai";
import { AI_LIST_MAX } from "@shared/ai";
import { orderNext, type BriefCard, type BriefInput, type BriefNote, type BriefPr, type NextOffer, type NextRule } from "../../../src/ai/brief-core";

const GH = "https://github.com/AndresL230/trov";

class Bundle {
  cites: Record<string, AiCite> = {};
  prs: BriefPr[] = [];
  status: BriefNote | null = null;
  cards: BriefCard[] = [];
  notes: BriefNote[] = [];
  offers: NextOffer[] = [];
  private c(x: AiCite): string { this.cites[x.ref] = x; return x.ref; }
  pr(n: number, title: string, branch: string, draft = false, failing: { id: number; name: string }[] = [], redChecks: string[] = []): this {
    const ref = this.c({ ref: `pr:${n}`, label: `#${n}`, href: `${GH}/pull/${n}` });
    this.prs.push({ ref, title, branch, draft, failing: failing.map((f) => ({ ref: this.c({ ref: `run:${f.id}`, label: `CI run ${f.id}`, href: `${GH}/actions/runs/${f.id}` }), name: f.name })), redChecks });
    for (const f of failing) {
      this.offers.push({
        ref: `run:${f.id}`, kind: "failing", rule: "blocked", title: f.name,
        facts: `its last run failed on ${this.today}, on your pull request #${n} "${title}"`,
        fallback: `It is failing on your pull request #${n}.`,
        cites: [this.cites[`run:${f.id}`], this.cites[`pr:${n}`]], order: [0, 0, String(f.id)],
      });
    }
    return this;
  }
  note(id: number, at: string, summary: string, brief: string | null, status = false): this {
    const n: BriefNote = { ref: this.c({ ref: `feed:${id}`, label: summary.slice(0, 47) + (summary.length > 48 ? "…" : ""), href: "#feed" }), at, summary: summary.slice(0, 200), brief: brief?.slice(0, 280) ?? null };
    if (status) this.status = n; else this.notes.push(n);
    return this;
  }
  card(n: number, at: string, title: string, what: string | null, impact: string | null): this {
    const ref = this.c({ ref: `pr:${n}`, label: `#${n}`, href: `${GH}/pull/${n}` });
    this.cards.push({ ref, at, title, what: what?.slice(0, 300) ?? null, impact: impact?.slice(0, 200) ?? null });
    return this;
  }
  ticket(n: number, title: string, o: { status?: string; priority?: string; sprint?: { title: string; due: string }; rule?: NextRule; requester?: string; rank?: number } = {}): this {
    const rule = o.rule ?? "assigned";
    const ref = this.c({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });
    const status = o.status ?? "submitted";
    this.offers.push({
      ref, kind: rule === "assigned" ? "ticket" : "due", rule, title,
      facts: [o.sprint ? `in sprint "${o.sprint.title}", due ${o.sprint.due}${rule === "overdue" ? " (passed)" : ""}` : "in no sprint",
        status === "in_progress" ? "in progress" : "not started", `priority ${o.priority ?? "normal"}`,
        o.requester ? `requested by ${o.requester}` : "filed by you"].join("; "),
      fallback: rule === "overdue" ? `Its sprint, ${o.sprint!.title}, was due ${o.sprint!.due}.` : rule === "due soon" ? `Its sprint, ${o.sprint!.title}, is due ${o.sprint!.due}.` : "It is assigned to you.",
      cites: [this.cites[ref]], order: [o.rank ?? 2, o.priority === "high" ? 0 : 1, String(n).padStart(9, "0")],
    });
    return this;
  }
  handoff(n: number, title: string, from: string, at: string, forWhom: "you" | "yourself" | "anyone"): this {
    const ref = this.c({ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` });
    this.offers.push({
      ref, kind: "handoff", rule: forWhom === "yourself" ? "assigned" : "waiting", title,
      facts: `left by ${forWhom === "yourself" ? "you" : from} for ${forWhom} on ${at}; nobody has claimed it`,
      fallback: forWhom === "yourself" ? "You left it for yourself to pick up." : forWhom === "you" ? `${from} left it for you.` : `${from} left it for anyone to pick up.`,
      cites: [this.cites[ref]], order: forWhom === "yourself" ? [1, 0, at] : [forWhom === "you" ? 0 : 1, Date.parse(at), String(n)],
    });
    return this;
  }
  constructor(private handle: string, private name: string | null, private today: string) {}
  build(): BriefInput {
    return {
      handle: this.handle, name: this.name, today: this.today,
      now: { prs: this.prs, status: this.status }, recently: { cards: this.cards, notes: this.notes },
      next: orderNext(this.offers).slice(0, AI_LIST_MAX), cites: this.cites,
    };
  }
}

const andres = (today: string) => new Bundle("andres", "Andres Lopez", today);

// The real rows, once.
const PR186 = [186, "Repo setups: the Repo screen for every repo setup (handoff #11)", "feat/repo-setups", true] as const;
const PR178 = [178, "Server-side AI: the screens, the pipeline, Jev, Ask Trov and shorter emails", "ai/screens", false] as const;
const CARD185 = [185, "2026-10-15", "Add hosting providers: Vercel, Render, Netlify, and Fly.io, with an Org settings Hosting page and repo Usage hosting section",
  "Ships a unified hosting provider interface with Vercel (install or token), Render (API key), Netlify (OAuth or token), and Fly.io (read-only token), plus an Org settings > Hosting page for setup, environment parts, and provider connections.",
  "Teams can connect their hosting providers and see deploy status and resource usage for every part of a repo in one place, while Cloudflare and Railway appear as legacy parts alongside them."] as const;
const CARD184 = [184, "2026-10-15", "Show a checkmark confirmation when adding or dismissing a suggestion",
  "Adding or dismissing one of Sift's suggestions now shows a confirmation toast with a checkmark at the bottom of the screen as the row slides out. If the action is refused, the row returns along with the error.",
  "People get immediate feedback that their add or dismiss action was applied, and they see the row restored if it failed."] as const;
const CARD182 = [182, "2026-10-15", "Let only the settled row slide out on the To review tab",
  "On a tag's To review tab, adding or dismissing a suggestion now removes only that row, sliding it out and closing the gap immediately while the other rows stay usable.",
  "Reviewing suggestions on a tag feels fast and stable, since only the row being acted on changes and a refused suggestion returns with a reason."] as const;
const CARD180 = [180, "2026-10-15", "Tag page bars use their own colours, and header breadcrumbs match the title",
  "Bars on the tag page now take colour from the relevant person under Who writes about it, and from the other tag under Often seen with. Header breadcrumbs on child screens now render at 15px semibold to match the title.",
  "Tag page bars are colour-coded by person or related tag, and the breadcrumb no longer looks mismatched beside the page title."] as const;
const CARD179 = [179, "2026-10-15", "Org-wide tags with automatic tagging by Sift",
  "Each organization now gets its own tag list in Org settings, with six starter tags and add, rename, merge, retire, and restore actions. When an admin adds a tag or presses Find items, Sift checks the org's existing items and adds the tag automatically at 85% confidence or more, or suggests it at 60–85%.",
  "Teams can manage their own tagging vocabulary and have existing items tagged automatically, and agents' unrecognized tags become suggestions rather than leaving entries stuck in Unplaced."] as const;
const N119 = [119, "2026-10-15", "Repo setups Phase A: apps (repo_apps), a credential-less GitHub hosting provider, and a commit on every deploy or an honest NULL",
  "0070_repo_apps adds apps and deploy provenance; GitHub deploy signals are captured again; Cloudflare reads commits from Workers Builds; others join one GitHub signal within 10 minutes or stay NULL; rollbacks detected by one compare."] as const;
const N118 = [118, "2026-10-15", "Status: server-side AI Phase B landed on PR #178 (router, scopes, the pass, batches) plus the plain-language filter",
  "Every write now marks what it made stale, and the AI pass has its machinery (debounce, grouping, gates, caching, batches); the plain-language filter works on Tickets, the Feed and Artifacts."] as const;
const N117 = [117, "2026-10-15", "Repo setups Phase 0: Org settings › Hosting shows one card per provider; old per-environment Railway tokens are leftovers, not connections",
  "Fixed the three-Railway-cards bug: one status function for every hosting surface, leftovers shown inside the card with Remove old tokens, and Integrations / Hosting / Environments each own one thing."] as const;
const N115 = [115, "2026-10-15", "Status: server-side AI Phase A landed on PR #178 (Jev as a provider, Sift under the org switch, ai_chat allowance, Org settings › AI)",
  "Trov's AI now has one client with two providers, Sift obeys the org's AI switch, and Org settings › AI shows every AI allowance and both providers."] as const;
const N109 = [109, "2026-10-14", "Status: AI base (#177) and the AI screens frontend (#178) are open, stacked on #176, all green",
  "The AI groundwork is ready for review: a monthly AI allowance, an org AI switch, an empty AI pass in the cron, suggestions and \"Wrong?\" feedback, and the four new AI screens built but hidden until something writes their content."] as const;
const N108 = [108, "2026-10-14", "Shipped: PR #176 opens — summaries move from Gemini to Claude Haiku 5.5 behind a provider-agnostic client",
  "Pull request and issue summaries now go through one model client (Claude Haiku 5.5), the base every later AI feature will use. Same fields and storage, no migration; waits on ANTHROPIC_API_KEY and a merge."] as const;
const T33 = [33, "Local dev: the local database is empty, so nothing can be tested without hand-made data"] as const;
const T34 = [34, "E2E testing system: browser tests that drive the real app against seeded local data"] as const;
const T14 = [14, "Guided repository setup: pick the stack, then be walked through connecting each piece and where to get its keys"] as const;
const H12 = [12, "Build Ask Trov's frontend from the Claude Design prototype, and fit Phase F to it"] as const;
const H10 = [10, "Build Trov's server-side AI system in PR #178 (replaces #9; Ask Trov is now full-featured)"] as const;

export interface BriefCase { id: string; source: string; input: BriefInput }

export const BRIEF_CASES: BriefCase[] = [
  {
    id: "full-day",
    source: "real: open PRs #186 (draft) and #178, Status #118, cards #185 #184 #182 #180 #179, notes #119 #117, handoff #12 (to self), tickets #33 #34",
    input: andres("2026-10-15").pr(...PR186).pr(...PR178).note(...N118, true).card(...CARD185).card(...CARD184).card(...CARD182).card(...CARD180).card(...CARD179)
      .note(...N119).note(...N117).handoff(...H12, "andres", "2026-10-15", "yourself").ticket(...T33, { priority: "high" }).ticket(...T34).build(),
  },
  {
    id: "next-only",
    source: "real: tickets #33 #34; a quiet week later (today 2026-10-23), so no open PRs, notes or cards",
    input: andres("2026-10-23").ticket(...T33, { priority: "high" }).ticket(...T34).build(),
  },
  {
    id: "failing-pr",
    source: "real: PR #179 open on feat/org-tags with failing checks (get_repo_dashboard: checks fail), Status #109, card #176's note #108; ARRANGED: the run id, ticket #14 assigned",
    input: andres("2026-10-15").pr(179, "Tags of your own, sorted by Sift", "feat/org-tags", false, [{ id: 18412000001, name: "test (vitest)" }], ["typecheck"])
      .note(...N109, true).note(...N108).ticket(...T14).build(),
  },
  {
    id: "recently-only",
    source: "real: cards #185 #184, notes #117 #119; nothing open, nothing assigned (today 2026-10-16)",
    input: andres("2026-10-16").card(...CARD185).card(...CARD184).note(...N117).note(...N119).build(),
  },
  {
    id: "status-and-handoff",
    source: "real: Status #115, handoff #10 (to self) as of 2026-10-15 06:00",
    input: andres("2026-10-15").note(...N115, true).handoff(...H10, "andres", "2026-10-15", "yourself").build(),
  },
  {
    id: "overdue-sprint",
    source: "real: tickets #33 #34 #14; ARRANGED: sprints \"Local dev and testing\" due 2026-10-12 (overdue) and \"Repo setups\" due 2026-10-18",
    input: andres("2026-10-15")
      .ticket(...T34, { rule: "overdue", sprint: { title: "Local dev and testing", due: "2026-10-12" }, rank: -3 })
      .ticket(...T33, { rule: "overdue", priority: "high", sprint: { title: "Local dev and testing", due: "2026-10-12" }, rank: -3 })
      .ticket(...T14, { rule: "due soon", sprint: { title: "Repo setups", due: "2026-10-18" }, rank: 3, status: "in_progress" }).build(),
  },
  {
    id: "someone-waiting",
    source: "real: handoffs #11 and #3, both left for anyone by andres; ARRANGED: the viewer is a teammate (jose)",
    input: new Bundle("jose", "Jose", "2026-10-15")
      .handoff(11, "Build the Repo screen for every repo setup (feat/repo-setups)", "andres", "2026-10-15", "anyone")
      .handoff(3, "Performance plan for trov.dev is ready; nothing in it is built yet.", "andres", "2026-10-14", "anyone").build(),
  },
  {
    id: "cut-to-five",
    source: "real: tickets #1–#5 (the Repo dashboard series) and #33, handoff #12; ARRANGED: all assigned to andres, #2 in sprint \"Repo setups\" due 2026-10-18; the server offers its top 5",
    input: andres("2026-10-15")
      .ticket(1, "Repo dashboard: support repositories hosted on one stack (e.g. everything on one Cloudflare Worker)")
      .ticket(2, "Repo dashboard: an environment with one part (no backend / frontend split)", { rule: "due soon", sprint: { title: "Repo setups", due: "2026-10-18" }, rank: 3 })
      .ticket(3, "Repo dashboard: a repository with one environment (drift, previews, the environment list)")
      .ticket(4, "Repo dashboard: the Cloudflare Worker as the whole stack (Worker, D1, R2 and cron metrics)")
      .ticket(5, "Repo dashboard: recognise a single-stack repository at setup, and dogfood it on AndresL230/trov")
      .ticket(...T33, { priority: "high" })
      .handoff(...H12, "andres", "2026-10-15", "yourself").build(),
  },
  {
    id: "numbers-heavy",
    source: "real: Status #109 and note #108, both full of numbers (PR numbers, migrations, test counts), open PR #178",
    input: andres("2026-10-14").pr(...PR178).note(...N109, true).note(...N108).build(),
  },
  {
    id: "draft-in-flight",
    source: "real: draft PR #186 and note #119 (Repo setups Phase A), ticket #33",
    input: andres("2026-10-15").pr(...PR186).note(...N119).ticket(...T33, { priority: "high" }).build(),
  },
];

/** The org prefix the eval sends (src/ai/prefix.ts `renderPrefix`): Personal Dev's name and its starter tags; it has
 *  no sprints, themes or narrative (get_roadmap, 2026-10-15). */
export const EVAL_PREFIX_PARTS = {
  org: "Personal Dev",
  tags: ["architecture", "infra", "api", "ui", "data", "auth"].map((name) => ({ name, description: "" })),
  themes: [] as string[],
  sprints: [] as { title: string; target: string | null }[],
  narrative: "",
};
