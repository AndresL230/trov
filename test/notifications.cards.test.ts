/**
 * Digest cards — the section bodies mirror the app's My Work cards and Review
 * rows (structured PR rows, issue rows, kind/priority/plan chips), on the shared
 * card/row/chip helpers in assemble.ts. Real D1 fixtures, same as
 * notifications.render.test.ts.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { run } from "../src/db";
import { ingestEvent, ingestDocProposal, ingestAdrDraft } from "../src/consumer";
import { promote_doc } from "../src/tools/writes";
import { storePrSummary, storeIssueSummary, type Summarizer, type PrSummary, type IssueSummary } from "../src/tools/summarize";
import { write_plan } from "../src/tools/plan";
import { getKind } from "../src/notifications/registry";
import { THEME } from "../src/notifications/assemble";
import type { Window } from "@shared/notifications";
import type { CapturedEvent } from "@shared/contract";

const WINDOW: Window = { cadence: "daily", start: new Date("2026-09-10T12:00:00.000Z"), end: new Date("2026-09-11T12:00:00.000Z"), id: "2026-09-11" };
const IN_WINDOW = "2026-09-11T03:00:00Z";
const BEFORE_WINDOW = "2026-09-09T03:00:00Z";
const LOGIN = "AndresL230";

function prEvent(number: number, occurredAt: string, title: string): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`, event_type: "pr_merged", ref_number: number, subject_login: LOGIN, provenance: "webhook", occurred_at: occurredAt,
    raw: JSON.stringify({ pr: { number, title, body: "b", html_url: `https://github.com/o/r/pull/${number}`, merged: true, merged_at: occurredAt, user: { login: LOGIN }, base: { ref: "main" } } }),
  };
}
// `milestone` here is GitHub's own key — not Trov vocabulary (a payload literal).
function issueEvent(number: number, title: string, extra: { labels?: string[]; milestone?: { number?: number; title: string; due_on: string | null } | null } = {}): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:open:${IN_WINDOW}`, event_type: "issue", ref_number: number, subject_login: LOGIN, provenance: "webhook", occurred_at: IN_WINDOW,
    raw: JSON.stringify({ action: "assigned", issue: { number, title, html_url: `https://github.com/o/r/issues/${number}`, state: "open", updated_at: IN_WINDOW, user: { login: LOGIN }, assignees: [{ login: LOGIN }], labels: extra.labels ?? [], milestone: extra.milestone ?? null } }),
  };
}
const prStub = (s: PrSummary): Summarizer<PrSummary> => ({ model: "stub", summarize: async () => s });
const issueStub = (s: IssueSummary): Summarizer<IssueSummary> => ({ model: "stub", summarize: async () => s });

describe("My Work items (ledger layout)", () => {
  const kind = () => getKind("my_work")!;

  it("renders a merged PR as a ledger item: title with the #number pill far right, What changed / Why / Impact rows, MERGED chip into main", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(10, IN_WINDOW, "Raw ten"), "github-webhook");
    await storePrSummary(systemCtx(), prStub({ title: "Humanized ten", what: "Did the thing", why: "Because reasons", impact: "Users win" }), { semantic_key: "gh:pr:10:merged", pr_number: 10, title: "Raw ten", body: "b" });
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    // Ledger layout: title on the left, the #number pill (the item's only link, accent-coloured) far right on the same line; rows sit flush under. No box.
    expect(s.html).toMatch(/<td data-title[^>]*>Humanized ten<\/td>\s*<td data-pill-cell[^>]*align="right"[^>]*>\s*<a data-pill [^>]*href="https:\/\/github\.com\/o\/r\/pull\/10"[^>]*>#10<\/a>/);
    expect(s.html).toMatch(new RegExp(`<a data-pill [^>]*style="[^"]*color:${THEME.accentText.light}[^"]*background-color:${THEME.accentSoft.light}`));
    expect(s.html).not.toContain("border-radius:11px");
    expect(s.html).not.toMatch(/data-item[^>]*style="[^"]*border:1px solid/); // items are separated by a hairline, never boxed
    expect(s.html).toMatch(/What changed[\s\S]*Did the thing/);
    expect(s.html).toMatch(/Why[\s\S]*Because reasons/);
    expect(s.html).toMatch(/Impact[\s\S]*Users win/);
    expect(s.html).toMatch(/>MERGED<[\s\S]*into <span[^>]*>main</); // base ref in the label face, like the app
    expect(s.html).toContain(THEME.green.light); // the MERGED chip colour comes from the token map
    expect(s.text).toMatch(/What changed:\s+Did the thing/);
  });

  it("a PR without a summary keeps the placeholder row and no Why / Impact rows", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(12, IN_WINDOW, "Only raw"), "github-webhook");
    await storePrSummary(systemCtx(), null, { semantic_key: "gh:pr:12:merged", pr_number: 12, title: "Only raw", body: "b" });
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).toContain("No summary recorded for this PR.");
    expect(s.html).not.toContain(">Why<");
    expect(s.html).not.toContain(">Impact<");
  });

  it("caps merged PRs at five with a '+N more' line", async () => {
    for (let n = 1; n <= 7; n++) await ingestEvent(systemCtx(), platformCtx(), prEvent(100 + n, IN_WINDOW, `PR ${100 + n}`), "github-webhook");
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect((s.html.match(/>MERGED<\/span>/g) ?? []).length).toBe(5); // 5 chips (the group label is a div, not a chip)
    expect(s.html).toContain("+2 more in My Work");
  });

  it("renders an assigned issue as a card: Summary / Sprint · due / Next step rows, priority chip and label chips", async () => {
    // `milestone` is GitHub's own key — not Trov vocabulary (a payload literal).
    await ingestEvent(systemCtx(), platformCtx(), issueEvent(20, "[P1] Fix the gate", { labels: ["bug", "gate", "urgent", "fourth"], milestone: { title: "Launch", due_on: "2026-09-20" } }), "github-webhook");
    await storeIssueSummary(systemCtx(), issueStub({ title: "Fix the gate", summary: "The gate drops items", next_step: "Add the missing branch" }), { issue_number: 20, title: "[P1] Fix the gate", body: "b" });
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).toMatch(/Summary[\s\S]*The gate drops items/);
    expect(s.html).toMatch(/Sprint[\s\S]*Launch[\s\S]*due Sep 20/);
    expect(s.html).not.toContain("Milestone");
    expect(s.html).toMatch(/Next step[\s\S]*Add the missing branch/);
    expect(s.html).toMatch(/>P1</);
    expect(s.html).toContain(THEME.amber.light);
    expect(s.html).toMatch(/>bug<[\s\S]*>gate<[\s\S]*>urgent</);
    expect(s.html).not.toMatch(/>fourth</); // labels capped at 3 like the app
    expect(s.text).toMatch(/Next step:\s+Add the missing branch/);
  });
});

describe("Review queue rows", () => {
  it("each item carries a PROPOSAL or DECISION kind chip, the summary line, and 'by <author> · <confidence> confidence'", async () => {
    await ingestDocProposal(systemCtx(), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "v1", change_summary: "init", confidence: "high" }, "agent");
    await promote_doc(systemCtx(), "auth-flow", 1, "human");
    await ingestDocProposal(systemCtx(), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "v2 proposed", change_summary: "clarify token rotation", confidence: "high" }, "mei");
    await ingestAdrDraft(systemCtx(), { title: "Use D1 for outbox", context: "c", decision: "d", rationale: "r", confidence: "high" }, "dev");
    const s = (await getKind("review_queue")!.render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).toMatch(/>PROPOSAL<[\s\S]*Reference \/ Auth flow[\s\S]*clarify token rotation[\s\S]*by mei · high confidence/);
    expect(s.html).toMatch(/>DECISION<[\s\S]*ADR-\d+[\s\S]*Use D1 for outbox[\s\S]*by dev/);
  });

  it("a low-confidence proposal gets an amber LOW CONFIDENCE chip", async () => {
    await ingestDocProposal(systemCtx(), { slug: "shaky", section: "reference", title: "Shaky", body: "v1", change_summary: "init", confidence: "high" }, "agent");
    await promote_doc(systemCtx(), "shaky", 1, "human");
    await ingestDocProposal(systemCtx(), { slug: "shaky", section: "reference", title: "Shaky", body: "v2", change_summary: "guess", confidence: "low" }, "agent");
    const s = (await getKind("review_queue")!.render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).toMatch(/LOW CONFIDENCE/);
    expect(s.html).toContain(THEME.amber.light);
  });
});

describe("Roadmap plan chips", () => {
  it("labels are coloured chips: ADDED green, DONE olive, CHANGED blue", async () => {
    const r = await write_plan(systemCtx(), { narrative: "n", sprints: [
      { label: "Ship it", due: "2026-10-01", status: "in_progress" },
      { label: "Old name", due: "2026-10-15", status: "upcoming" },
    ] }, "admin");
    await run(env.DB, `UPDATE plan_versions SET created_at = ? WHERE version = (SELECT MAX(version) FROM plan_versions)`, BEFORE_WINDOW);
    const ship = r.sprints.find((m) => m.title === "Ship it")!;
    const old = r.sprints.find((m) => m.title === "Old name")!;
    await write_plan(systemCtx(), { narrative: "n", sprints: [
      { id: ship.id, label: "Ship it", due: "2026-10-01", status: "done" },
      { id: old.id, label: "New name", due: "2026-10-15", status: "upcoming" },
      { label: "Brand new", due: "2026-12-01", status: "upcoming" },
    ] }, "admin");
    await run(env.DB, `UPDATE plan_versions SET created_at = ? WHERE version = (SELECT MAX(version) FROM plan_versions)`, IN_WINDOW);
    const s = (await getKind("roadmap_plan")!.render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).toMatch(new RegExp(`color:${THEME.green.light}[^>]*>ADDED<`));
    expect(s.html).toMatch(new RegExp(`color:${THEME.accentText.light}[^>]*>DONE<`));
    expect(s.html).toMatch(new RegExp(`color:${THEME.blue.light}[^>]*>CHANGED<`));
  });
});
