// The Jev provider (src/tools/classify.ts) behind the client (src/ai/client.ts): `providerFor` names it by
// kind, and `ask` puts several questions of Jev's three types (noul / choice / score) about ONE item in ONE
// request, each answer parsed against what was asked and null on any malformed answer. Every request is
// stubbed at the Response level — no test reaches the network.
import { describe, it, expect } from "vitest";
import { KIND_PROVIDER, providerFor, type JevQuestion } from "../src/ai/client";
import { answerOf, JEV_URL } from "../src/tools/classify";

/** A Jev stub answering `body` (or a status); records what it was sent. */
function stub(reply: { status?: number; body?: unknown; raw?: string }) {
  const sent: { url: string; body: { model: string; state: string; questions: Record<string, unknown> } }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const QUESTIONS: Record<string, JevQuestion> = {
  category: { type: "choice", instructions: "What kind of ticket is this?", criteria: { bug: "Something is broken.", feature: "Something new.", chore: null } },
  severity: { type: "score", instructions: "How soon does it need doing?", criteria: ["Later", "Soon", "Now"] },
  urgent: { type: "noul", instructions: "Is it urgent?", criteria: { true: "Users are blocked.", false: "Nobody is blocked." } },
};
// The live call of 2026-10-15 (docs/superpowers/specs/2026-10-14-ai-base.md), in shape.
const LIVE = {
  model: "jev-1.13.0",
  answers: {
    category: { type: "choice", choice: "bug", probabilities: { bug: 1, feature: 0, chore: 0 }, confidence: 0.97 },
    severity: { type: "score", score: 1.29, legend: { "0": "Later", "1": "Soon", "2": "Now" }, probabilities: { "0": 0.05, "1": 0.67, "2": 0.28 }, confidence: 0.6 },
    urgent: { type: "noul", noul: 0.85 },
  },
  usage: { input_tokens: 120, output_tokens: 3 },
};

describe("providerFor: one table from a kind to its provider", () => {
  it("tag.fit and pr.theme are Jev's; the summaries, the filter, Ask Trov and the themes are Claude's; no key → null", () => {
    expect(KIND_PROVIDER).toEqual({
      summary_pr: "claude", summary_issue: "claude", "tag.fit": "jev", filter: "claude",
      // Ask Trov (Phase F): one kind per mode, and the compaction of a long thread.
      "ask.fast": "claude", "ask.smart": "claude", "ask.thinking": "claude", "ask.compact": "claude",
      // Repo themes (Phase D).
      "themes.propose": "claude", "themes.caption": "claude", "themes.backfill": "claude", "pr.theme": "jev",
    });
    expect(providerFor("tag.fit", { apiKey: "k" })?.name).toBe("jev");
    expect(providerFor("tag.fit", { apiKey: "k" })?.model).toBe("jev-latest");
    expect(providerFor("summary_pr", { apiKey: "k" })?.name).toBe("claude");
    expect(providerFor("tag.fit", {})).toBeNull();
    expect(providerFor("tag.fit", { apiKey: "" })).toBeNull();
  });
});

describe("ask: several questions about one item, one request", () => {
  it("sends ONE request with every question in TypeSafe's shape, and parses each answer by its type", async () => {
    const s = stub({ body: LIVE });
    const r = await providerFor("tag.fit", { apiKey: "k", fetchImpl: s.fetchImpl })!.ask("The login page crashes on submit.", QUESTIONS);
    expect(s.sent.length).toBe(1);
    expect(s.sent[0].url).toBe(JEV_URL);
    expect(s.sent[0].body).toEqual({
      model: "jev-latest", state: "The login page crashes on submit.",
      questions: {
        category: { type: "choice", instructions: "What kind of ticket is this?", criteria: { bug: "Something is broken.", feature: "Something new.", chore: null } },
        severity: { type: "score", instructions: "How soon does it need doing?", criteria: ["Later", "Soon", "Now"] },
        urgent: { type: "noul", instructions: "Is it urgent?", criteria: { true: "Users are blocked.", false: "Nobody is blocked." } },
      },
    });
    expect(r).toEqual({
      ok: true, model: "jev-1.13.0", usage: { inputTokens: 120, outputTokens: 3 },
      answers: {
        category: { type: "choice", choice: "bug", probabilities: { bug: 1, feature: 0, chore: 0 }, confidence: 0.97 },
        severity: { type: "score", score: 1.29, level: "Soon", probabilities: [0.05, 0.67, 0.28], confidence: 0.6 },
        urgent: { type: "noul", p: 0.85 },
      },
    });
  });

  it("a malformed answer is null for THAT question, never a guess; the others stand", async () => {
    const bad = { ...LIVE, answers: { ...LIVE.answers, category: { type: "choice", choice: "question", probabilities: { bug: 1 }, confidence: 1 } } };
    const r = await providerFor("tag.fit", { apiKey: "k", fetchImpl: stub({ body: bad }).fetchImpl })!.ask("x", QUESTIONS);
    expect(r.ok && r.answers).toEqual({ category: null, severity: expect.objectContaining({ level: "Soon" }), urgent: { type: "noul", p: 0.85 } });
  });

  it("parsing, question by question: wrong type, a choice not offered, probabilities that do not match, a score out of range — all null", () => {
    const choice = QUESTIONS.category, score = QUESTIONS.severity, noul = QUESTIONS.urgent;
    const okChoice = LIVE.answers.category, okScore = LIVE.answers.severity;
    expect(answerOf(choice, okChoice)).not.toBeNull();
    for (const bad of [
      { ...okChoice, type: "noul" }, { ...okChoice, choice: "question" }, { ...okChoice, choice: 1 },
      { ...okChoice, probabilities: { bug: 1, feature: 0 } }, { ...okChoice, probabilities: { bug: 1, feature: 0, chore: 0, other: 0 } },
      { ...okChoice, probabilities: { bug: 1.2, feature: 0, chore: 0 } }, { ...okChoice, probabilities: [1, 0, 0] },
      { ...okChoice, confidence: 2 }, { ...okChoice, confidence: undefined }, null, "bug", [],
    ]) expect(answerOf(choice, bad), JSON.stringify(bad)).toBeNull();
    expect(answerOf(score, okScore)).not.toBeNull();
    for (const bad of [
      { ...okScore, score: 2.5 }, { ...okScore, score: -0.1 }, { ...okScore, score: "1" }, { ...okScore, score: Number.NaN },
      { ...okScore, probabilities: { "0": 0.5, "1": 0.5 } }, { ...okScore, probabilities: { a: 0.1, b: 0.2, c: 0.7 } }, { ...okScore, confidence: -1 },
    ]) expect(answerOf(score, bad), JSON.stringify(bad)).toBeNull();
    expect(answerOf(noul, { type: "noul", noul: 0 })).toEqual({ type: "noul", p: 0 });
    for (const bad of [{ type: "noul", noul: 1.01 }, { type: "noul" }, { type: "score", noul: 0.5 }]) expect(answerOf(noul, bad)).toBeNull();
  });

  it("questions Trov must not send are refused before any request: none, a blank instruction, a choice of one, a score of eleven levels", async () => {
    const s = stub({ body: LIVE });
    const p = providerFor("tag.fit", { apiKey: "k", fetchImpl: s.fetchImpl })!;
    for (const qs of [
      {},
      { a: { type: "noul", instructions: "  " } },
      { a: { type: "choice", instructions: "Pick", criteria: { only: null } } },
      { a: { type: "choice", instructions: "Pick", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } },
      { a: { type: "score", instructions: "Rate", criteria: ["one"] } },
      { a: { type: "score", instructions: "Rate", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } },
    ] as Record<string, JevQuestion>[]) expect(await p.ask("x", qs)).toEqual({ ok: false, status: -1 });
    expect(s.sent).toEqual([]);
  });

  it("a refusal, an overload, a body that is not JSON: no answers, the status — never a throw, and no retry inside `ask`", async () => {
    for (const [reply, status] of [[{ status: 401 }, 401], [{ status: 429 }, 429], [{ status: 529 }, 529], [{ raw: "yes" }, 0]] as const) {
      const s = stub(reply);
      expect(await providerFor("tag.fit", { apiKey: "k", fetchImpl: s.fetchImpl })!.ask("x", { u: QUESTIONS.urgent })).toEqual({ ok: false, status });
      expect(s.sent.length).toBe(1);
    }
    const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await providerFor("tag.fit", { apiKey: "k", fetchImpl: down })!.ask("x", { u: QUESTIONS.urgent })).toEqual({ ok: false, status: 0 });
  });
});
