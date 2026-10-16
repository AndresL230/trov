/**
 * Phase E's aim for the daily ("read in 20 seconds"), measured on one busy day (test/helpers/digest-fixture.ts):
 * the whole daily run through the real renderers and assembler, its body counted in words and its sections counted.
 *
 * BEFORE Phase E, on this same fixture (the old renderers, run 2026-10-15 at 1d249811 + the brief and feed merges):
 *   subject "Trov daily, Sep 11"; 232 words of plain text, 303 words a reader sees in the HTML, 3 full sections
 *   (My Work with What / Why / Impact cards and issue rows, Review queue, Ticket queue), 38,828 bytes of HTML.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run } from "./helpers/db";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { runDigest } from "../src/notifications/run";
import { localDelivery } from "../src/notifications/delivery";
import { storeBrief } from "../src/data/person-brief";
import { BUSY_LOGIN, BUSY_NOW, htmlWordCount, seedBusyDay, wordCount } from "./helpers/digest-fixture";
import { useAiKey } from "./helpers/ai-key";

// THE read rule (src/plans/gate.ts `aiShown`): no Anthropic key reads like the switch off, so these tests hold a fake one.
useAiKey();

async function daily() {
  await runDigest(systemCtx(), platformCtx(), "daily", BUSY_NOW, { delivery: localDelivery(systemCtx()), origin: "https://trov.dev" });
  const [body] = await all<{ subject: string; html: string; text: string }>(env.DB, `SELECT subject, html, text FROM notification_outbox_bodies WHERE idempotency_key LIKE ?`, `%:${BUSY_LOGIN}:daily:%`);
  return { ...body, words: wordCount(body.text), htmlWords: htmlWordCount(body.html), blocks: (body.html.match(/data-section="block"/g) ?? []).length, lines: (body.html.match(/data-line /g) ?? []).length };
}

describe("the daily on a busy day (Phase E)", () => {
  it("AI off: under half the words of the old daily — one brief block (the assigned tickets) and one line per queue", async () => {
    await seedBusyDay();
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = 'org_saplinglearn'`);
    const d = await daily();
    expect(d.subject).toBe("Netlify test failing, plus 2 more");
    expect({ blocks: d.blocks, lines: d.lines }).toEqual({ blocks: 1, lines: 2 });
    expect(d.words).toBeLessThanOrEqual(232 / 2);
    expect(d.htmlWords).toBeLessThanOrEqual(303 / 2);
    // Removed: the per-PR What / Why / Impact cards, issue rows and labels, the plan diff.
    for (const gone of ["What changed", "Impact", "Document the hosting job", "Pricing page"]) expect(d.html).not.toContain(gone);
  });

  it("AI on: led by the stored brief — Now, up to 3 Next items, and the subject from the top one", async () => {
    await seedBusyDay();
    await run(env.DB, `UPDATE orgs SET ai_automation = 1 WHERE id = 'org_saplinglearn'`);
    await storeBrief(systemCtx(), BUSY_LOGIN, {
      generatedAt: "2026-09-11T11:40:00.000Z", model: "claude-haiku-5-5", promptVersion: "brief.1", inputHash: "h",
      briefJson: JSON.stringify({
        now: { text: "You have the hosting providers pull request open, and its Netlify test is failing.", cites: [{ ref: "pr:171", label: "#171", href: "https://github.com/o/r/pull/171" }] },
        recently: null,
        next: { items: [
          { ref: "run:4812", kind: "failing", title: "Netlify test failing", why: "It is failing on your pull request #171.", cites: [{ ref: "run:4812", label: "CI run 4812", href: "https://github.com/o/r/actions/runs/4812" }] },
          { ref: "ticket:2", kind: "due", title: "Poll Vercel deploys", why: "Its sprint, Hosting, is due 2026-09-18.", cites: [{ ref: "ticket:2", label: "#2", href: "#tickets/2" }] },
        ] },
      }),
    });
    const d = await daily();
    expect(d.subject).toBe("Netlify test failing, plus 1 more");
    expect(d.html).toContain("its Netlify test is failing");
    expect(d.html).toContain('href="https://trov.dev/#tickets/2"'); // an in-app cite hangs off the org's address
    expect(d.words).toBeLessThanOrEqual(232 / 2);
  });
});
