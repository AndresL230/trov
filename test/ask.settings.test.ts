// Settings › Trov, server side (src/ai/ask/routes.ts › Settings › Trov; Trov handoff #12 §2.19): the default mode
// is Pro's. On Free nothing but Smart can be stored — the PUT is refused BEFORE anything is written (a refused
// default mode does not take the instructions sent with it), and the GET never answers a mode the plan lacks.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A } from "./helpers/tenant";
import { BASE, call } from "./helpers/ask";

const ME = "trov-settings";
const stored = () => first<{ instructions: string; default_mode: string | null }>(env.DB,
  `SELECT instructions, default_mode FROM person_ask_settings WHERE org_id = ? AND handle = ?`, ORG_A, ME);

describe("Settings › Trov: the default mode follows the plan", () => {
  it("Free cannot PUT a default mode other than Smart, and the refused PUT writes nothing", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    for (const mode of ["fast", "thinking"]) {
      const r = await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "Sneak this in.", defaultMode: mode });
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ error: "mode_unavailable", message: "On Free, every question uses Smart." });
    }
    expect(await stored()).toBeNull();
    // The instructions alone are everyone's.
    const ok = await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "Keep it short." });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ instructions: "Keep it short.", defaultMode: "smart", modes: ["smart"] });
    expect(await stored()).toMatchObject({ instructions: "Keep it short.", default_mode: null });
  });

  it("Pro can; the same person on Free afterwards reads Smart, and their Pro choice is kept for a return to Pro", async () => {
    const cookie = await cookieFor(ME);
    await run(env.DB, `UPDATE orgs SET plan = 'team' WHERE id = ?`, ORG_A);
    const ok = await call("PUT", `${BASE}/ask/settings`, cookie, { defaultMode: "thinking" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ defaultMode: "thinking", modes: ["fast", "smart", "thinking"] });
    await run(env.DB, `UPDATE orgs SET plan = 'free' WHERE id = ?`, ORG_A);
    expect((await call("GET", `${BASE}/ask/settings`, cookie)).json).toMatchObject({ defaultMode: "smart", modes: ["smart"] });
    expect((await stored())?.default_mode).toBe("thinking");
  });

  it("instructions are at most 500 characters", async () => {
    const cookie = await cookieFor(ME);
    expect((await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "x".repeat(501) })).status).toBe(400);
    expect((await call("PUT", `${BASE}/ask/settings`, cookie, { instructions: "x".repeat(500) })).status).toBe(200);
  });
});
