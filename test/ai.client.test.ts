// The shared model client (src/ai/client.ts): one structured call, never throwing, every call through
// the injected fetch and answered with real Messages API bodies — never the network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { CLAUDE_MODEL, providerFor, type AiUsage, type StructuredRequest } from "../src/ai/client";
import { FAKE_ANTHROPIC_KEY, errorResponse, messageResponse, sentMessage } from "./helpers/anthropic";

const Answer = z.object({ label: z.string().trim().min(1).max(12), score: z.number().min(0).max(1) });
type Answer = z.infer<typeof Answer>;
const req = (over: Partial<StructuredRequest<Answer>> = {}): StructuredRequest<Answer> =>
  ({ kind: "summary_pr", system: "SYSTEM", input: "INPUT", schema: Answer, maxTokens: 300, ...over });
const GOOD = JSON.stringify({ label: "ok", score: 0.5 });

/** A fetch that records what it was sent and answers `res`. */
function recording(res: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return res(); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => vi.unstubAllGlobals());

describe("providerFor", () => {
  it("answers null with no key, and a Claude provider for every kind with one", () => {
    expect(providerFor("summary_pr", {})).toBeNull();
    expect(providerFor("summary_issue", { apiKey: "" })).toBeNull();
    for (const kind of ["summary_pr", "summary_issue"] as const) expect(providerFor(kind, { apiKey: FAKE_ANTHROPIC_KEY })?.model).toBe("claude-haiku-5-5");
    expect(CLAUDE_MODEL).toBe("claude-haiku-5-5");
  });
});

describe("structured()", () => {
  it("sends claude-haiku-5-5 a json_schema output format through the injected fetch — and only through it", async () => {
    const global = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", global);
    const f = recording(() => messageResponse(GOOD));
    const out = await providerFor("summary_pr", { apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: f.fetchImpl })!.structured(req());
    expect(out?.value).toEqual({ label: "ok", score: 0.5 });
    expect(global).not.toHaveBeenCalled();
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    const sent = sentMessage(f.calls[0].init);
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.max_tokens).toBe(300);
    expect(sent.output_config.format.type).toBe("json_schema");
    expect(sent.output_config.format.schema).toEqual({
      type: "object",
      properties: { label: { type: "string" }, score: { type: "number" } },
      required: ["label", "score"],
      additionalProperties: false,
    });
    expect(sent.system).toEqual([{ type: "text", text: "SYSTEM" }]);
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "INPUT" }] }]);
    expect(new Headers(f.calls[0].init?.headers).get("x-api-key")).toBe(FAKE_ANTHROPIC_KEY);
  });

  it("places the cache breakpoint on the prefix block, or on the system block with no prefix — and nowhere without cache", async () => {
    const f = recording(() => messageResponse(GOOD));
    const p = providerFor("summary_pr", { apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: f.fetchImpl })!;
    await p.structured(req({ prefix: "PREFIX", cache: true }));
    await p.structured(req({ cache: true }));
    await p.structured(req({ prefix: "PREFIX" }));
    const [withPrefix, noPrefix, noCache] = f.calls.map((c) => sentMessage(c.init));
    expect(withPrefix.system).toEqual([{ type: "text", text: "SYSTEM" }]);
    expect(withPrefix.messages[0].content).toEqual([
      { type: "text", text: "PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "INPUT" },
    ]);
    expect(noPrefix.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    expect(JSON.stringify(noCache)).not.toContain("cache_control");
    expect(noCache.messages[0].content.map((b) => b.text)).toEqual(["PREFIX", "INPUT"]);
  });

  it("enforces the caps the API was not given, after the parse", async () => {
    const f = recording(() => messageResponse(JSON.stringify({ label: "far too long a label", score: 0.5 })));
    expect(await providerFor("summary_pr", { apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: f.fetchImpl })!.structured(req())).toBeNull();
    const g = recording(() => messageResponse(JSON.stringify({ label: "ok", score: 3 })));
    expect(await providerFor("summary_pr", { apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: g.fetchImpl })!.structured(req())).toBeNull();
  });

  it("reports usage (cached tokens included) for every response that came back, a failed parse included", async () => {
    const seen: AiUsage[] = [];
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 };
    const ok = await providerFor("summary_pr", { apiKey: "k", fetchImpl: recording(() => messageResponse(GOOD, { usage })).fetchImpl, onCall: (u) => seen.push(u) })!.structured(req({ prefix: "PRE" }));
    expect(ok?.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 40, inputChars: "SYSTEM".length + "PRE".length + "INPUT".length, outputChars: GOOD.length });
    await providerFor("summary_pr", { apiKey: "k", fetchImpl: recording(() => messageResponse("nope", { usage })).fetchImpl, onCall: (u) => seen.push(u) })!.structured(req());
    await providerFor("summary_pr", { apiKey: "k", fetchImpl: recording(() => messageResponse(GOOD, { usage: false })).fetchImpl, onCall: (u) => seen.push(u) })!.structured(req());
    await providerFor("summary_pr", { apiKey: "k", fetchImpl: recording(() => errorResponse(500)).fetchImpl, onCall: (u) => seen.push(u) })!.structured(req());
    expect(seen.map((u) => [u.inputTokens, u.outputTokens, u.cachedTokens])).toEqual([[100, 20, 40], [100, 20, 40], [0, 0, 0]]);
  });

  it("never throws: a thrown fetch, a 4xx/5xx, a body that is not JSON, a text that is not JSON, a refusal, max_tokens → null", async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ["thrown fetch", () => { throw new TypeError("network down"); }],
      ["rejected fetch", () => new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("reset")), 0))],
      ["400", () => errorResponse(400)],
      ["401", () => errorResponse(401)],
      ["429", () => errorResponse(429)],
      ["500", () => errorResponse(500)],
      ["529", () => errorResponse(529)],
      ["non-JSON body", () => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } })],
      ["non-JSON text", () => messageResponse("Sure! Here is your answer.")],
      ["empty text", () => messageResponse("")],
      ["JSON of the wrong shape", () => messageResponse(JSON.stringify({ label: 3 }))],
      ["refusal", () => messageResponse(GOOD, { stop_reason: "refusal" })],
      ["max_tokens", () => messageResponse(GOOD, { stop_reason: "max_tokens" })],
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [name, res] of cases) {
        const p = providerFor("summary_issue", { apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: recording(res).fetchImpl })!;
        await expect(p.structured(req()), name).resolves.toBeNull();
      }
      // What reached the log: names, statuses and stop reasons — never the key or the text sent.
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).not.toContain(FAKE_ANTHROPIC_KEY);
      expect(logged).not.toContain("INPUT");
      expect(logged).toContain("status=500");
      expect(logged).toContain("stop_reason=refusal");
    } finally {
      errors.mockRestore();
    }
  });

  it("a hung request resolves to null at the deadline, aborting the in-flight fetch", async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    const out = await providerFor("summary_pr", { apiKey: "k", fetchImpl: hanging, timeoutMs: 50 })!.structured(req());
    expect(out).toBeNull();
    expect(signal?.aborted).toBe(true);
  }, 2000);
});
