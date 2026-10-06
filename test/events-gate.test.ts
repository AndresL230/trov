import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { all } from "../src/db";
import { ingestEvent, consume } from "../src/consumer";
import type { EventRow } from "@shared/rows";
import { IngestPayload, type CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:42:merged",
  event_type: "pr_merged",
  ref_number: 42,
  subject_login: "AndresL230",
  raw: JSON.stringify({ pr: { number: 42, title: "t", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("ingestEvent gate arm", () => {
  it("writes once; an identical semantic_key is unchanged (INSERT OR IGNORE)", async () => {
    expect((await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook")).outcome).toBe("written");
    expect((await ingestEvent(systemCtx(), platformCtx(), ev(), "github-webhook")).outcome).toBe("unchanged");
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows.length).toBe(1);
    expect(rows[0].subject_login).toBe("AndresL230");   // subject preserved
    expect(rows[0].recorded_by).toBe("github-webhook"); // writer = principal
  });

  // Revert guard (spec decision 7): the events[] arm on IngestPayload is GONE —
  // subject_login is trustworthy only post-HMAC (the webhook), so no bearer/cookie
  // payload may carry events into the gate. zod strips the unknown key silently;
  // consume() must not write to `events` or report an events count for it.
  it("consume() no longer carries an events[] arm: the key is stripped, zero rows written, no events field in the result", async () => {
    const payloadWithEvents = {
      session: { id: "evt-S1", author: "spoof", ended_at: "2026-07-01T10:00:00Z", skill_version: "2.0" },
      events: [ev(), ev({ semantic_key: "gh:pr:43:closed", event_type: "pr_closed", ref_number: 43 })],
    };

    const parsed = IngestPayload.parse(structuredClone(payloadWithEvents));
    expect(parsed).not.toHaveProperty("events");

    const result = await consume(systemCtx(), parsed, { handle: "AndresL230" });
    expect(result).not.toHaveProperty("events");
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(0);
  });
});
