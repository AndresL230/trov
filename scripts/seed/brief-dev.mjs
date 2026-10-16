// Local-only sample data for My Work's "Your brief" (0063_person_brief): ONE stored brief for AndresL230, so
// localhost shows a real brief — read through the real path (src/tools/mywork.ts `storedBrief`), no
// LOCAL_AI_PREVIEW needed (which, when set, still shows its own sample instead). Appended by scripts/seed-dev.mjs
// AFTER the shared seed; never part of the test reset. Every item is a real row of fixtures/dev/*: ticket #3 in the
// overdue sprint "Token rotation & audit log", the two handoffs Jose and Jack left for Andres, and his merged PRs
// #162 and #158 — in the brief's fixed shape (the owner's ruling: Now and Recently one sentence each, Next at most 3),
// in the order the server gives Next (overdue, then someone waiting, oldest first), with the titles the rows have (test/ai.brief.test.ts holds the two to each other). The words are written in the brief's style, as the model would; `model` and `prompt_version`
// say what the pass would record. Stamped against the clock at seed time, so it reads "12 min ago".

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const pr = (n) => ({ ref: `pr:${n}`, label: `#${n}`, href: `https://github.com/SaplingLearn/sapling/pull/${n}` });
const ticket = (n) => ({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });
const handoff = (n) => ({ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` });

export function briefDevStatements(now = new Date()) {
  const brief = {
    now: {
      text: "You have the lesson duration field in progress, and its sprint, Token rotation & audit log, is past its date.",
      cites: [ticket(3)],
    },
    recently: {
      text: "You shipped My Work cards that render from structured summaries, and widened what Trov captures from pull requests.",
      cites: [pr(162), pr(158)],
    },
    next: {
      items: [
        { ref: "ticket:3", kind: "due", title: "Add a “lesson duration” field to the curriculum planner", why: "Its sprint, Token rotation & audit log, was due 2026-06-10.", cites: [ticket(3)] },
        { ref: "handoff:16", kind: "handoff", title: "Resume tokens are wired on the backend, but the Next.js reader still drops the stream on reconnect.", why: "Jose left it for you, with the backend half already done.", cites: [handoff(16)] },
        { ref: "handoff:17", kind: "handoff", title: "Quiz agent still fails validation on ~4% of calls. Parser is fixed; prompt and eval aren't.", why: "Jack left it for you; the prompt and the eval are what remain.", cites: [handoff(17)] },
      ],
    },
  };
  const at = new Date(now.getTime() - 12 * 60_000).toISOString();
  return [
    `INSERT INTO person_brief (org_id, handle, version, generated_at, model, prompt_version, input_hash, brief_json) VALUES ('org_saplinglearn', 'AndresL230', 1, ${q(at)}, 'claude-haiku-5-5', 'brief.1', 'dev-seed', ${q(JSON.stringify(brief))})`,
    // He opened My Work just now: the pass may rewrite his brief when something marks him (with a key set).
    `UPDATE memberships SET mywork_opened_at = ${q(now.toISOString())} WHERE org_id = 'org_saplinglearn' AND user_id = 'AndresL230'`,
  ];
}
