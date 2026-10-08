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
  parseStructuredJson,
  validatePrSummary,
  validateIssueSummary,
  SUMMARIZER_SYSTEM_PROMPT,
  ISSUE_SUMMARIZER_SYSTEM_PROMPT,
  geminiPrSummarizer,
  geminiIssueSummarizer,
  capSummaryBody,
  SUMMARY_BODY_MAX,
} from "../src/tools/summarize";
import type { Summarizer } from "../src/tools/summarize";
import { handleGithubWebhook } from "./helpers/org-config";
import prMerged from "./fixtures/gh-pr-merged.json";
import issueAssigned from "./fixtures/gh-issue-assigned.json";

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
  const body = JSON.stringify(payload);
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

  it("with no explicit summarizer and GEMINI_API_KEY unset in tests, the webhook resolves it to null → excerpt (never throws, never hits the network)", async () => {
    const res = await postWebhook("pull_request", prMerged);
    expect(res.status).toBe(200);
    const rows = await all<PrSummaryRow>(env.DB, `SELECT * FROM pr_summaries WHERE semantic_key = ?`, "gh:pr:42:merged");
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("excerpt");
  });
});

describe("parseStructuredJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseStructuredJson('{"a": 1}')).toEqual({ a: 1 });
  });
  it("strips a ```json fence", () => {
    expect(parseStructuredJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it("returns null for prose, malformed JSON, arrays, and null", () => {
    expect(parseStructuredJson("Just prose.")).toBeNull();
    expect(parseStructuredJson('{"a": ')).toBeNull();
    expect(parseStructuredJson("[1,2]")).toBeNull();
    expect(parseStructuredJson("null")).toBeNull();
  });
  it("tolerates leading prose before the object", () => {
    expect(parseStructuredJson('Here you go:\n{"a": 1}')).toEqual({ a: 1 });
  });
  it("tolerates trailing prose after the object", () => {
    expect(parseStructuredJson('{"a": 1}\n\nHope this helps!')).toEqual({ a: 1 });
  });
  it("tolerates a fence plus surrounding prose on both sides", () => {
    expect(parseStructuredJson('Sure!\n```json\n{"a": 1, "b": "x"}\n```\nDone.')).toEqual({ a: 1, b: "x" });
  });
});

describe("validatePrSummary", () => {
  it("accepts a full object, trimming every field", () => {
    expect(validatePrSummary({ title: " T ", what: " W ", why: " Y ", impact: " I " }))
      .toEqual({ title: "T", what: "W", why: "Y", impact: "I" });
  });
  it("coerces empty/absent nullable fields to null", () => {
    expect(validatePrSummary({ title: "T", what: "W", why: "", impact: undefined }))
      .toEqual({ title: "T", what: "W", why: null, impact: null });
  });
  it("rejects a missing or empty required field", () => {
    expect(validatePrSummary({ what: "W" })).toBeNull();
    expect(validatePrSummary({ title: "  ", what: "W" })).toBeNull();
    expect(validatePrSummary({ title: "T", what: "" })).toBeNull();
  });
  it("rejects non-string junk in any field", () => {
    expect(validatePrSummary({ title: "T", what: "W", why: 7, impact: null })).toBeNull();
    expect(validatePrSummary({ title: 3, what: "W" })).toBeNull();
  });
});

describe("validateIssueSummary", () => {
  it("accepts a full object and coerces empty next_step to null", () => {
    expect(validateIssueSummary({ title: "T", summary: "S", next_step: "" }))
      .toEqual({ title: "T", summary: "S", next_step: null });
  });
  it("rejects a missing required field or junk next_step", () => {
    expect(validateIssueSummary({ title: "T" })).toBeNull();
    expect(validateIssueSummary({ title: "T", summary: "S", next_step: 4 })).toBeNull();
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

// Gemini's generateContent nests the model text under
// candidates[0].content.parts[0].text. geminiPrSummarizer must extract+validate
// exactly that shape, and degrade to null (→ excerpt) on a non-2xx response, a
// missing candidate, prose instead of JSON, or a thrown fetch — a mismatch here
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
      const body = JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] };
      sent.push(body.contents[0].parts[0].text);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const title = "T".repeat(300);
    const body = "B".repeat(8000) + "OVERFLOW".repeat(2000);
    await geminiPrSummarizer("k", { fetchImpl, onCall: (s) => sizes.push(s.inputChars) }).summarize({ title, body });
    await geminiIssueSummarizer("k", { fetchImpl, onCall: (s) => sizes.push(s.inputChars) }).summarize({ title, body });
    for (const text of sent) {
      expect(text).toBe(`Title: ${title}\n\nBody: ${"B".repeat(8000)}`);
      expect(text).not.toContain("OVERFLOW");
    }
    expect(sizes).toEqual([SUMMARIZER_SYSTEM_PROMPT.length + sent[0].length, ISSUE_SUMMARIZER_SYSTEM_PROMPT.length + sent[1].length]);
  });
});

describe("geminiPrSummarizer — Gemini response handling", () => {
  const PR_JSON = '{"title": "T", "what": "W", "why": null, "impact": null}';
  const geminiResponse = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
  const stubFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("extracts and validates JSON from candidates[0].content.parts[0].text", async () => {
    const result = await geminiPrSummarizer("k", { fetchImpl: stubFetch(geminiResponse(PR_JSON)) })
      .summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toEqual({ title: "T", what: "W", why: null, impact: null });
  });

  it("returns null on a non-2xx response (never reads the error body as a summary)", async () => {
    const result = await geminiPrSummarizer("k", { fetchImpl: stubFetch({ error: "quota exceeded" }, 429) })
      .summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("returns null when the candidate shape is absent (e.g. a safety block)", async () => {
    const result = await geminiPrSummarizer("k", { fetchImpl: stubFetch({ promptFeedback: { blockReason: "SAFETY" } }) })
      .summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await geminiPrSummarizer("k", { fetchImpl: throwingFetch })
      .summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("returns null for an empty/whitespace-only candidate text", async () => {
    const result = await geminiPrSummarizer("k", { fetchImpl: stubFetch(geminiResponse("   ")) })
      .summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("returns null when the candidate text is prose instead of JSON", async () => {
    const result = await geminiPrSummarizer("k", { fetchImpl: stubFetch(geminiResponse("This PR fixes a bug in the login flow.")) })
      .summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  });

  it("sends the key as x-goog-api-key and targets the configured model's generateContent endpoint", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const capturingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(geminiResponse(PR_JSON)), { status: 200 });
    }) as unknown as typeof fetch;
    await geminiPrSummarizer("secret-key", { model: "gemini-2.5-flash-lite", fetchImpl: capturingFetch })
      .summarize({ title: "t", body: "b" });
    expect(capturedUrl).toContain("gemini-2.5-flash-lite:generateContent");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("secret-key");
  });
});

// The summarizer runs INLINE on the webhook/backfill request the browser waits
// on, so a hung Gemini call must never wedge capture. The summarizer races the
// fetch against an injectable timeout and aborts the in-flight request on
// timeout (real fetch rejects when its AbortSignal fires — the hanging stubs
// below model that), resolving to null so the deterministic excerpt fallback
// fires and the request always completes.
describe("geminiSummarizer — timeout guard", () => {
  // A fetch that never resolves on its own — only the AbortSignal firing ends it,
  // exactly as a real fetch rejects with an AbortError when its signal aborts.
  const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  it("resolves the PR summarizer to null when fetch never resolves, within the injected timeout", async () => {
    const result = await geminiPrSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  }, 1500);

  it("resolves the issue summarizer to null when fetch never resolves, within the injected timeout", async () => {
    const result = await geminiIssueSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }).summarize({ title: "Fix", body: "Fixes a bug" });
    expect(result).toBeNull();
  }, 1500);

  it("storePrSummary falls back to excerpt (never hangs) when the Gemini call hangs past the timeout", async () => {
    await seedEvent("gh:pr:99:merged", 99);
    const row = await storePrSummary(systemCtx(), geminiPrSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }), {
      semantic_key: "gh:pr:99:merged",
      pr_number: 99,
      title: "A PR",
      body: "Body text here",
    });
    expect(row.model).toBe("excerpt");
    expect(row).toMatchObject({ title: null, what: null, why: null, impact: null });
  }, 1500);

  it("storeIssueSummary falls back to excerpt (never hangs) when the Gemini call hangs past the timeout", async () => {
    const row = await storeIssueSummary(systemCtx(), geminiIssueSummarizer("k", { timeoutMs: 50, fetchImpl: hangingFetch }), {
      issue_number: 99,
      title: "An issue",
      body: "Body text here",
    });
    expect(row.model).toBe("excerpt");
    expect(row.summary).toBe(excerptSummary("An issue", "Body text here"));
    expect(row).toMatchObject({ title: null, next_step: null });
  }, 1500);

  // Only WAITING for the fetch is bounded by the timer; a timed-out call would keep
  // its subrequest alive, so the summarizer aborts the AbortSignal on timeout to
  // actually cancel the in-flight request.
  it("aborts the in-flight fetch via its AbortSignal when the timeout fires", async () => {
    let captured: AbortSignal | undefined;
    const capturingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const result = await geminiPrSummarizer("k", { timeoutMs: 50, fetchImpl: capturingFetch }).summarize({ title: "t", body: "b" });
    expect(result).toBeNull();
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(true);
  }, 1500);

  it("passes an AbortSignal but does NOT abort it on a healthy (fast) call", async () => {
    let captured: AbortSignal | undefined;
    const fastFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"T","what":"W","why":null,"impact":null}' }] } }] }), { status: 200 })
      );
    }) as unknown as typeof fetch;
    const result = await geminiPrSummarizer("k", { timeoutMs: 50, fetchImpl: fastFetch }).summarize({ title: "t", body: "b" });
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
