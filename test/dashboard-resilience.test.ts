import { describe, it, expect } from "vitest";
import { getMyWork } from "../src/tools/mywork";

// A DB stub whose every query throws — simulates a missing table (e.g. a migration not
// applied to the remote D1) or a D1 outage. getMyWork must degrade, never throw; the
// /me/dashboard route leans on this so it never 500s.
const throwingDb = {
  prepare() {
    throw new Error("boom");
  },
} as unknown as Parameters<typeof getMyWork>[0];

describe("getMyWork resilience", () => {
  it("returns a safe degraded payload (never throws) when D1 reads fail", async () => {
    const work = await getMyWork(throwingDb, "AndresL230");
    expect(work).toEqual({ person: null, previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: true });
  });
});
