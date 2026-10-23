import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { all, run, nowIso } from "./helpers/db";
import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import type { Env } from "../src/env";
import {
  type PrSummary,
  type IssueSummary,
  storePrSummary,
  storeIssueSummary,
  excerptSummary,
  PrSummarySchema,
  IssueSummarySchema,
  SUMMARIZER_SYSTEM_PROMPT,
  ISSUE_SUMMARIZER_SYSTEM_PROMPT,
  claudePrSummarizer,
  claudeIssueSummarizer,
  capSummaryBody,
  SUMMARY_BODY_MAX,
  SUMMARY_MAX_TOKENS,
  type AiUsage,
} from "../src/tools/summarize";
import type { Summarizer } from "../src/tools/summarize";
import { handleGithubWebhook } from "./helpers/org-config";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";
import { errorResponse, messageResponse, sentInput, sentMessage } from "./helpers/anthropic";

const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding

const PR_STUB: PrSummary = { title: "Humanized PR title", what: "The concrete change.", why: "Because reasons.", impact: "Users win." };
const ISSUE_STUB: IssueSummary = { title: "Humanized issue title", summary: "What the issue is.", next_step: "Do the thing." };

// pr_summaries.semantic_key REFERENCES events(semantic_key) — in real usage
// storePrSummary only ever runs after ingestEvent has written the events row
// (the webhook seam). Direct storePrSummary tests below seed a minimal events
// row first so the FK is satisfied, mirroring that real call order.
async function seedEvent(semanticKey: string, prNumber: number): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, 'pr_merged', ?, 'someone', '{}', 'webhook', NULL, ?, 'github-webhook')`,
    semanticKey,
    prNumber,
    nowIso()
  );
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function req(body: string, headers: Record<string, string>): Request {
  return new Request("https://x/webhook/github", { method: "POST", headers, body });
}

async function postWebhook(
  eventName: string,
  payload: unknown,
  opts?: { summarizer?: Summarizer<PrSummary> | null },
  e: Env = env
): Promise<Response> {
  // A repo hook takes only its own repository's deliveries: the pool's hook is SaplingLearn/sapling's.
  const body = JSON.stringify({ ...(payload as object), repository: { full_name: "SaplingLearn/sapling" } });
  const sig = await sign(SECRET, body);
  return handleGithubWebhook(
    req(body, { "x-github-event": eventName, "x-hub-signature-256": sig, "content-type": "application/json" }),
    e,
    opts
  );
}

describe("storePrSummary", () => {
  it("stores the stub summarizer's structured summary under its own model id", async () => {
    await seedEvent("gh:pr:1:merged", 1);
    const stub: Summarizer<PrSummary> = { model: "stub-model", summarize: async () => PR_STUB };
    const row = await storePrSummary(systemCtx(), stub, { semantic_key: "gh:pr:1:merged", pr_number: 1, title: "t", body: "b" });
    expect(row.model).toBe("stub-model");
    expect(row).toMatchObject({ title: "Humanized PR title", what: "The concrete change.", why: "Because reasons.", impact: "Users win." });
    const stored = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = 'gh:pr:1:merged'`);
    expect(stored[0]).toMatchObject({ title: "Humanized PR title", what: "The concrete change.", why: "Because reasons.", impact: "Users win." });
  });

  it("marks the row model:'excerpt' with null structured columns when the summarizer returns null, and never throws", async () => {
    await seedEvent("gh:pr:2:merged", 2);
    const nullStub: Summarizer<PrSummary> = { model: "stub", summarize: async () => null };
    const row = await storePrSummary(systemCtx(), nullStub, {
      semantic_key: "gh:pr:2:merged",
      pr_number: 2,
      title: "Another PR",
      body: "Body text here",
    });
    expect(row.model).toBe("excerpt");
    expect(row).toMatchObject({ title: null, what: null, why: null, impact: null });
  });

  it("marks the row model:'excerpt' (null structured columns) when the summarizer throws, and never throws", async () => {
    await seedEvent("gh:pr:3:merged", 3);
    const throwingStub: Summarizer<PrSummary> = {
      model: "stub",
      summarize: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      storePrSummary(systemCtx(), throwingStub, {
        semantic_key: "gh:pr:3:merged",
        pr_number: 3,
        title: "Third PR",
        body: "",
      })
    ).resolves.not.toThrow();
    const row = await storePrSummary(systemCtx(), throwingStub, {
      semantic_key: "gh:pr:3:merged",
      pr_number: 3,
      title: "Third PR",
      body: "",
    });
    expect(row.model).toBe("excerpt");
    expect(row).toMatchObject({ title: null, what: null, why: null, impact: null });
  });

  it("marks the row model:'excerpt' (null structured columns) when no summarizer is provided (null)", async () => {
    await seedEvent("gh:pr:4:merged", 4);
    const row = await storePrSummary(systemCtx(), null, {
      semantic_key: "gh:pr:4:merged",
      pr_number: 4,
      title: "Fourth PR",
      body: "   ",
    });
    expect(row.model).toBe("excerpt");
    expect(row).toMatchObject({ title: null, what: null, why: null, impact: null });
  });
});

describe("excerptSummary", () => {
  it("returns the title when the body is empty", () => {
    expect(excerptSummary("A Title", "")).toBe("A Title");
  });

  it("collapses whitespace and returns short bodies verbatim (no truncation suffix)", () => {
    expect(excerptSummary("Title", "line one\n\nline   two")).toBe("line one line two");
  });

  it("truncates at exactly 280 chars with no suffix at the boundary", () => {
    const body = "a".repeat(280);
    const result = excerptSummary("Title", body);
    expect(result).toBe(body);
    expect(result.length).toBe(280);
    expect(result.endsWith("…")).toBe(false);
  });

  it("truncates past 280 chars and suffixes …", () => {
    const body = "a".repeat(281);
    const result = excerptSummary("Title", body);
    expect(result).toBe("a".repeat(280) + "…");
  });
});

describe("webhook → summarize wiring", () => {
  it("pr-merged fixture + stub summarizer → one pr_summaries row keyed gh:pr:42:merged; replay writes no second row", async () => {
    const stub: Summarizer<PrSummary> = { model: "stub", summarize: async () => PR_STUB };
    const res = await postWebhook("pull_request", prMerged, { summarizer: stub });
    expect(res.status).toBe(200);
    // pull_request is also a REPO_EVENT_NAMES entry: the same verified delivery
    // independently reaches repo_events (a closed+merged PR → one "pr"/"merged" row).
    expect(await res.json()).toEqual({ ok: true, captured: 1, unchanged: 0, repo: { captured: 1, unchanged: 0 } });

    let rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].pr_number).toBe(42);
    expect(rows[0].model).toBe("stub");

    // Replay: the event is unchanged (INSERT OR IGNORE drops it) → the seam never
    // re-runs, so still exactly one pr_summaries row.
    const res2 = await postWebhook("pull_request", prMerged, { summarizer: stub });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, captured: 0, unchanged: 1, repo: { captured: 0, unchanged: 1 } });
    rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
  });

  it("issue events never reach storePrSummary — zero pr_summaries rows", async () => {
    const stub: Summarizer<PrSummary> = { model: "stub", summarize: async () => ({ ...PR_STUB, what: "should never be called" }) };
    const res = await postWebhook("issues", issueAssigned, { summarizer: stub });
    expect(res.status).toBe(200);
    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries`);
    expect(rows.length).toBe(0);
  });

  it("with no explicit summarizer and ANTHROPIC_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never hits the network)", async () => {
    const res = await postWebhook("pull_request", prMerged);
    expect(res.status).toBe(200);
    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("excerpt");
  });
});

// The answer's zod schema checks what the model wrote, after the parse (src/ai/client.ts): structured
// outputs constrain the shape, these keep the old coercion rules — required = non-empty after trim,
// nullable = trimmed with '' → null, anything else rejects the whole answer.
describe("PrSummarySchema", () => {
  const parse = (o: unknown) => { const r = PrSummarySchema.safeParse(o); return r.success ? r.data : null; };
  it("accepts a full object, trimming every field", () => {
    expect(parse({ title: " T ", what: " W ", why: " Y ", impact: " I " }))
      .toEqual({ title: "T", what: "W", why: "Y", impact: "I" });
  });
  it("coerces empty nullable fields to null", () => {
    expect(parse({ title: "T", what: "W", why: "", impact: "  " }))
      .toEqual({ title: "T", what: "W", why: null, impact: null });
    expect(parse({ title: "T", what: "W", why: null, impact: null }))
      .toEqual({ title: "T", what: "W", why: null, impact: null });
  });
  it("rejects a missing or empty required field", () => {
    expect(parse({ what: "W", why: null, impact: null })).toBeNull();
    expect(parse({ title: "  ", what: "W", why: null, impact: null })).toBeNull();
    expect(parse({ title: "T", what: "", why: null, impact: null })).toBeNull();
  });
  it("rejects non-string junk in any field", () => {
    expect(parse({ title: "T", what: "W", why: 7, impact: null })).toBeNull();
    expect(parse({ title: 3, what: "W", why: null, impact: null })).toBeNull();
  });
});

describe("IssueSummarySchema", () => {
  const parse = (o: unknown) => { const r = IssueSummarySchema.safeParse(o); return r.success ? r.data : null; };
  it("accepts a full object and coerces empty next_step to null", () => {
    expect(parse({ title: "T", summary: "S", next_step: "" }))
      .toEqual({ title: "T", summary: "S", next_step: null });
  });
  it("rejects a missing required field or junk next_step", () => {
    expect(parse({ title: "T", next_step: null })).toBeNull();
    expect(parse({ title: "T", summary: "S", next_step: 4 })).toBeNull();
  });
});

describe("SUMMARIZER_SYSTEM_PROMPT", () => {
  it("demands a single JSON object with title/what/why/impact and forbids file lists and extrapolation", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toMatch(/single json object/i);
    for (const field of ['"title"', '"what"', '"why"', '"impact"']) {
      expect(SUMMARIZER_SYSTEM_PROMPT).toContain(field);
    }
    expect(SUMMARIZER_SYSTEM_PROMPT).toMatch(/never a list of files/i);
    expect(SUMMARIZER_SYSTEM_PROMPT).toMatch(/never extrapolate/i);
  });
});

describe("ISSUE_SUMMARIZER_SYSTEM_PROMPT", () => {
  it("demands a single JSON object with title/summary/next_step and forbids invented next steps", () => {
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toMatch(/single json object/i);
    for (const field of ['"title"', '"summary"', '"next_step"']) {
      expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toContain(field);
    }
    expect(ISSUE_SUMMARIZER_SYSTEM_PROMPT).toMatch(/never invent/i);
  });
});

// The summarizers call Claude through the shared client (src/ai/client.ts) with
// structured outputs; the answer is the first text block of a Messages API
// response. They must extract+validate exactly that shape, and degrade to null
// (→ excerpt) on a non-2xx response, a refusal, an answer cut off at max_tokens,
// text that is not the schema's JSON, or a thrown fetch — a mismatch here
// silently produces model:'excerpt' forever, exactly the bug this suite exists to
// catch. Every case injects a stubbed fetchImpl; the network is never touched.
describe("the description sent is capped at 8,000 characters (one platform key pays for every org)", () => {
  it("a short description goes whole; a long one is cut to its first 8,000 characters, never mid surrogate pair", () => {
    expect(SUMMARY_BODY_MAX).toBe(8000);
    expect(capSummaryBody("short")).toBe("short");
    const exact = "x".repeat(8000);
    expect(capSummaryBody(exact)).toBe(exact);
    expect(capSummaryBody("y".repeat(20000))).toBe("y".repeat(8000));
    // An emoji (two UTF-16 units) straddling the cut is dropped whole, not split.
    const straddle = "a".repeat(7999) + "😀" + "tail";
    expect(capSummaryBody(straddle)).toBe("a".repeat(7999));
  });

  it("both summarizers send at most 8,000 characters of the body, the title whole, and record what they sent", async () => {
    const sent: string[] = [];
    const sizes: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent.push(sentInput(init));
      return messageResponse("not json");
    }) as unknown as typeof fetch;
    const title = "T".repeat(300);
    const body = "B".repeat(8000) + "OVERFLOW".repeat(2000);
    await claudePrSummarizer("k", { fetchImpl, onCall: (s) => sizes.push(s.inputChars) }).summarize({ title, body });
    await claudeIssueSummarizer("k", { fetchImpl, onCall: (s) => sizes.push(s.inputChars) }).summarize({ title, body });
    for (const text of sent) {
      expect(text).toBe(`Title: ${title}\n\nBody: ${"B".repeat(8000)}`);
      expect(text).not.toContain("OVERFLOW");
    }
    expect(sizes).toEqual([SUMMARIZER_SYSTEM_PROMPT.length + sent[0].length, ISSUE_SUMMARIZER_SYSTEM_PROMPT.length + sent[1].length]);
  });
});

describe("claudePrSummarizer — Messages API response handling", () => {
  const PR_JSON = '{"title": "T", "what": "W", "why": null, "impact": null}';
  const stubFetch = (res: () => Response): typeof fetch => (async () => res()) as unknown as typeof fetch;
  const summarize = (fetchImpl: typeof fetch) => claudePrSummarizer("k", { fetchImpl }).summarize({ title: "Fix", body: "Fixes a bug" });

  it("extracts and validates the JSON of the first text block, after any thinking block", async () => {
    expect(await summarize(stubFetch(() => messageResponse(PR_JSON)))).toEqual({ title: "T", what: "W", why: null, impact: null });
    const thought = { type: "thinking", thinking: "", signature: "sig" };
    expect(await summarize(stubFetch(() => messageResponse(PR_JSON, { before: [thought] })))).toEqual({ title: "T", what: "W", why: null, impact: null });
  });

  it("sends claude-haiku-5-5 a json_schema output format through the injected fetch, with the key and the PR prompt", async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const capturing = (async (u: string | URL | Request, i?: RequestInit) => {
      url = String(u);
      init = i;
      return messageResponse(PR_JSON);
    }) as unknown as typeof fetch;
    const s = claudePrSummarizer("secret-key", { fetchImpl: capturing });
    expect(s.model).toBe("claude-haiku-5-5");
    await s.summarize({ title: "t", body: "b" });
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("secret-key");
    const sent = sentMessage(init);
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.max_tokens).toBe(SUMMARY_MAX_TOKENS);
    expect(sent.system[0].text).toBe(SUMMARIZER_SYSTEM_PROMPT);
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Title: t\n\nBody: b" }] }]);
    expect(sent.output_config.format.type).toBe("json_schema");
    // The schema is the zod schema's, made acceptable to the API: closed, every field required, no length keywords.
    expect(sent.output_config.format.schema).toMatchObject({ type: "object", additionalProperties: false, required: ["title", "what", "why", "impact"] });
    expect(JSON.stringify(sent.output_config.format.schema)).not.toMatch(/minLength|\$schema/);
  });

  it("returns null on a non-2xx response (never reads the error body as a summary)", async () => {
    expect(await summarize(stubFetch(() => errorResponse(429, "quota exceeded")))).toBeNull();
    expect(await summarize(stubFetch(() => errorResponse(500)))).toBeNull();
  });

  it("returns null on a refusal, even when the text parses", async () => {
    expect(await summarize(stubFetch(() => messageResponse(PR_JSON, { stop_reason: "refusal" })))).toBeNull();
  });

  it("returns null on an answer cut off at max_tokens, even when the text parses", async () => {
    expect(await summarize(stubFetch(() => messageResponse(PR_JSON, { stop_reason: "max_tokens" })))).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await summarize(throwingFetch)).toBeNull();
  });

  it("returns null for an empty text, prose, a body that is not JSON, or JSON the schema rejects", async () => {
    expect(await summarize(stubFetch(() => messageResponse("   ")))).toBeNull();
    expect(await summarize(stubFetch(() => messageResponse("This PR fixes a bug in the login flow.")))).toBeNull();
    expect(await summarize(stubFetch(() => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } })))).toBeNull();
    expect(await summarize(stubFetch(() => messageResponse('{"title": "", "what": "W", "why": null, "impact": null}')))).toBeNull();
  });

  it("reports the tokens of every answer that came back — a refusal included — and zero tokens when none did", async () => {
    const seen: AiUsage[] = [];
    const run = (fetchImpl: typeof fetch) => claudePrSummarizer("k", { fetchImpl, onCall: (u) => seen.push(u) }).summarize({ title: "t", body: "b" });
    await run(stubFetch(() => messageResponse(PR_JSON, { usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 } })));
    await run(stubFetch(() => messageResponse(PR_JSON, { stop_reason: "refusal", usage: { input_tokens: 11, output_tokens: 1 } })));
    await run(stubFetch(() => errorResponse(500)));
    expect(seen.map((u) => [u.inputTokens, u.outputTokens, u.cachedTokens])).toEqual([[10, 4, 2], [11, 1, 0], [0, 0, 0]]);
    expect(seen.every((u) => u.inputChars === SUMMARIZER_SYSTEM_PROMPT.length + "Title: t\n\nBody: b".length)).toBe(true);
    expect(seen.map((u) => u.outputChars)).toEqual([PR_JSON.length, PR_JSON.length, 0]);
  });
});

describe("storePrSummary / storeIssueSummary over the Claude summarizer", () => {
  const ISSUE_JSON = '{"title": "Issue T", "summary": "Issue S", "next_step": null}';
  const fetchOf = (res: () => Response): typeof fetch => (async () => res()) as unknown as typeof fetch;

  it("stores the answer under model claude-haiku-5-5", async () => {
    await seedEvent("gh:pr:70:merged", 70);
    const row = await storePrSummary(systemCtx(), claudePrSummarizer("k", { fetchImpl: fetchOf(() => messageResponse('{"title":"T","what":"W","why":"Y","impact":null}')) }), {
      semantic_key: "gh:pr:70:merged", pr_number: 70, title: "A PR", body: "Body",
    });
    expect(row).toMatchObject({ model: "claude-haiku-5-5", title: "T", what: "W", why: "Y", impact: null });
    const issue = await storeIssueSummary(systemCtx(), claudeIssueSummarizer("k", { fetchImpl: fetchOf(() => messageResponse(ISSUE_JSON)) }), { issue_number: 70, title: "An issue", body: "Body" });
    expect(issue).toMatchObject({ model: "claude-haiku-5-5", summary: "Issue S", title: "Issue T", next_step: null });
    expect(await all<{ model: string }>(env.DB, `SELECT model FROM pr_summaries WHERE pr_number = 70`)).toEqual([{ model: "claude-haiku-5-5" }]);
  });

  for (const stop_reason of ["refusal", "max_tokens"] as const) {
    it(`a ${stop_reason} answer falls back to the excerpt`, async () => {
      await seedEvent(`gh:pr:71:${stop_reason}`, 71);
      const pr = await storePrSummary(systemCtx(), claudePrSummarizer("k", { fetchImpl: fetchOf(() => messageResponse('{"title":"T","what":"W","why":null,"impact":null}', { stop_reason })) }), {
        semantic_key: `gh:pr:71:${stop_reason}`, pr_number: 71, title: "A PR", body: "Body text here",
      });
      expect(pr).toMatchObject({ model: "excerpt", title: null, what: null, why: null, impact: null });
      const issue = await storeIssueSummary(systemCtx(), claudeIssueSummarizer("k", { fetchImpl: fetchOf(() => messageResponse(ISSUE_JSON, { stop_reason })) }), { issue_number: 71, title: "An issue", body: "Body text here" });
      expect(issue).toMatchObject({ model: "excerpt", summary: excerptSummary("An issue", "Body text here"), title: null, next_step: null });
      const rows = await all<IssueSummaryRow>(env.DB, `SELECT model, summary FROM issue_summaries WHERE issue_number = 71`);
      expect(rows).toEqual([{ model: "excerpt", summary: "Body text here" }]);
    });
  }
});

// The summarizer runs INLINE on the webhook/backfill request the browser waits
// on, so a hung call must never wedge capture. The client gives the SDK the
// injectable timeout; the SDK aborts the in-flight request when it passes (real
// fetch rejects when its AbortSignal fires — the hanging stubs below model that),
// and the call resolves to null so the deterministic excerpt fallback fires and
// the request always completes.
describe("claudeSummarizer — timeout guard", () => {
  // A fetch that never resolves on its own — only the AbortSignal firing ends it,
  // exactly as a real fetch rejects with an AbortError when its signal aborts.
  const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  it("resolves the PR summarizer to null when fetch never resolves, within the injected timeout", async () => {
    const result = await claudePrSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  }, 1500);

  it("resolves the issue summarizer to null when fetch never resolves, within the injected timeout", async () => {
    const result = await claudeIssueSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  }, 1500);

  it("storePrSummary falls back to excerpt (never hangs) when the call hangs past the timeout", async () => {
    await seedEvent("gh:pr:99:merged", 99);
    const row = await storePrSummary(systemCtx(), claudePrSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }), {
      semantic_key: "gh:pr:99:merged",
      pr_number: 99,
      title: "A PR",
      body: "Body text here",
    });
    expect(row.model).toBe("excerpt");
    expect(row).toMatchObject({ title: null, what: null, why: null, impact: null });
  }, 1500);

  it("storeIssueSummary falls back to excerpt (never hangs) when the call hangs past the timeout", async () => {
    const row = await storeIssueSummary(systemCtx(), claudeIssueSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }), {
      issue_number: 99,
      title: "An issue",
      body: "Body text here",
    });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe(excerptSummary("An issue", "Body text here"));
    expect(row).toMatchObject({ title: null, next_step: null });
  }, 1500);

  // Only WAITING for the fetch is bounded by the timer; a timed-out call would keep
  // its subrequest alive, so the in-flight request's AbortSignal is aborted on
  // timeout to actually cancel it.
  it("aborts the in-flight fetch via its AbortSignal when the timeout fires", async () => {
    let captured: AbortSignal | undefined;
    const capturingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const result = await claudePrSummarizer("k", { timeoutMs: 50, fetchImpl: capturingFetch }).summarize({ title: "t", body: "b" });
    expect(result).toBeNull();
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(true);
  }, 1500);

  it("passes an AbortSignal but does NOT abort it on a healthy (fast) call", async () => {
    let captured: AbortSignal | undefined;
    const fastFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return Promise.resolve(messageResponse('{"title":"T","what":"W","why":null,"impact":null}'));
    }) as unknown as typeof fetch;
    const result = await claudePrSummarizer("k", { timeoutMs: 500, fetchImpl: fastFetch }).summarize({ title: "t", body: "b" });
    expect(result).toEqual({ title: "T", what: "W", why: null, impact: null });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
  });
});

describe("storeIssueSummary", () => {
  it("stores the stub summarizer's structured summary under its own model id", async () => {
    const stub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => ISSUE_STUB };
    const row = await storeIssueSummary(systemCtx(), stub, { issue_number: 1, title: "Some issue", body: "Some body" });
    expect(row.summary).toBe("What the issue is.");
    expect(row.model).toBe("stub");
    expect(row.issue_number).toBe(1);
    expect(row).toMatchObject({ title: "Humanized issue title", next_step: "Do the thing." });

    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 1);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ summary: "What the issue is.", title: "Humanized issue title", next_step: "Do the thing." });
  });

  it("falls back to excerptSummary (model:'excerpt') when the summarizer returns null, and never throws", async () => {
    const nullStub: Summarizer<IssueSummary> = { model: "stub", summarize: async () => null };
    const row = await storeIssueSummary(systemCtx(), nullStub, { issue_number: 2, title: "Another issue", body: "Body text here" });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe(excerptSummary("Another issue", "Body text here"));
    expect(row).toMatchObject({ title: null, next_step: null });
  });

  it("falls back to excerptSummary when the summarizer throws, and never throws", async () => {
    const throwingStub: Summarizer<IssueSummary> = {
      model: "stub",
      summarize: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      storeIssueSummary(systemCtx(), throwingStub, { issue_number: 3, title: "Third issue", body: "" })
    ).resolves.not.toThrow();
    const row = await storeIssueSummary(systemCtx(), throwingStub, { issue_number: 3, title: "Third issue", body: "" });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Third issue"); // empty body → title
    expect(row).toMatchObject({ title: null, next_step: null });
  });

  it("falls back to excerptSummary when no summarizer is provided (null)", async () => {
    const row = await storeIssueSummary(systemCtx(), null, { issue_number: 4, title: "Fourth issue", body: "   " });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe("Fourth issue"); // whitespace-only body collapses to empty → title
    expect(row).toMatchObject({ title: null, next_step: null });
  });

  it("INSERT OR REPLACE overwrites the prior summary for the same issue_number", async () => {
    const s1: Summarizer<IssueSummary> = { model: "m1", summarize: async () => ({ ...ISSUE_STUB, summary: "First summary" }) };
    await storeIssueSummary(systemCtx(), s1, { issue_number: 5, title: "Issue", body: "body" });
    const s2: Summarizer<IssueSummary> = { model: "m2", summarize: async () => ({ ...ISSUE_STUB, summary: "Second summary" }) };
    await storeIssueSummary(systemCtx(), s2, { issue_number: 5, title: "Issue", body: "body" });
    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ?`, 5);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Second summary");
    expect(rows[0].model).toBe("m2");
  });
});
