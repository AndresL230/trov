/**
 * ONE ranking of an environment's verdict (shared/env-verdict-core.ts): the Overview's `envVerdict` and the
 * dashboard's served `RepoEnv.pill` (My Work's Deploys tile, MCP) both rank with it, so the two cannot disagree.
 */
import { describe, it, expect } from "vitest";
import { ENV_PILL, ENV_PILL_TONE, envVerdictKey, type EnvVerdictSignals } from "@shared/env-verdict-core";

const none: EnvVerdictSignals = { down: false, allUnknown: false, failing: false, outOfStep: false, ci: null };

describe("envVerdictKey", () => {
  it("ranks down > unknown > failing > out of step > degraded > healthy > live", () => {
    const all: EnvVerdictSignals = { down: true, allUnknown: true, failing: true, outOfStep: true, ci: "fail" };
    expect(envVerdictKey(all)).toBe("down");
    expect(envVerdictKey({ ...all, down: false })).toBe("unknown");
    expect(envVerdictKey({ ...all, down: false, allUnknown: false })).toBe("failing");
    expect(envVerdictKey({ ...all, down: false, allUnknown: false, failing: false })).toBe("outOfStep");
    expect(envVerdictKey({ ...none, ci: "fail" })).toBe("degraded");
    expect(envVerdictKey({ ...none, ci: "pass" })).toBe("healthy");
    // No checks captured (or still running) is never Healthy.
    expect(envVerdictKey(none)).toBe("live");
  });

  it("names every verdict on the wire and gives it a tone", () => {
    expect(ENV_PILL).toEqual({ healthy: "HEALTHY", live: "LIVE", degraded: "DEGRADED", failing: "FAILING", down: "DOWN", unknown: "UNKNOWN", outOfStep: "OUT OF STEP" });
    expect(ENV_PILL_TONE.live).toBe("good");
    expect(ENV_PILL_TONE.unknown).toBe("neutral");
    expect(ENV_PILL_TONE.down).toBe("bad");
  });
});
