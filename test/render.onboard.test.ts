import { describe, it, expect } from "vitest";
import { initialOnboard, onboardView, swatches, personChip, feedPreviewRow } from "../web/src/people";

describe("onboardView", () => {
  it("renders handle input, ten swatches with the selected one marked, the preview, and a disabled submit until available", () => {
    const s = { ...initialOnboard(), prefill: { provider: "google" as const, label: "priya.n@gmail.com", email: "priya.n@gmail.com", name: "Priya Natarajan", avatar_url: null, suggested_handle: "priya-n" }, handle: "priya-n", name: "Priya Natarajan", color: "plum" as const, check: "idle" as const };
    const html = onboardView(s);
    expect(html).toContain('data-act="onbHandle"');
    expect(html).toContain('value="priya-n"');
    expect((html.match(/class="cnpy-sw/g) ?? []).length).toBe(10);
    expect(html).toContain('data-arg="plum" class="cnpy-sw is-on compact"');
    expect(html).toContain("@priya-n");
    expect(html).toContain('data-act="onbSubmit"');
    expect(html).toMatch(/data-act="onbSubmit"[^>]*disabled/);
    const ok = onboardView({ ...s, check: "available" });
    expect(ok).not.toMatch(/data-act="onbSubmit"[^>]*disabled/);
    expect(ok).toContain("available");
    expect(onboardView({ ...s, check: "taken" })).toContain("taken");
    expect(onboardView({ ...s, handle: "Bad", check: "invalid" })).toContain("invalid");
  });
  it("the feed preview sits on a surface card, not the old 2.5% tint", () => {
    const html = onboardView({ ...initialOnboard(), handle: "priya-n", name: "Priya", color: "plum" as const });
    expect(html).toContain('<div class="cnpy-surface" style="padding:12px 14px">');
    expect(html).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
  });

  it("escapes user-controlled text", () => {
    const s = { ...initialOnboard(), name: "<img src=x>", handle: "x", color: "moss" as const };
    expect(onboardView(s)).not.toContain("<img src=x>");
  });
});

describe("swatches / personChip / feedPreviewRow", () => {
  it("swatches emit one button per color with the act and selected state", () => {
    const html = swatches("setColor", "sky");
    expect((html.match(/data-act="setColor"/g) ?? []).length).toBe(10);
    expect(html).toContain('data-arg="sky" class="cnpy-sw is-on"');
  });
  it("personChip renders initials on the color, or the avatar image when present, or a neutral fallback", () => {
    expect(personChip({ handle: "priya", name: "Priya Natarajan", color: "plum" }, 30, "?")).toContain("var(--p-plum)");
    expect(personChip({ handle: "priya", name: "Priya Natarajan", color: "plum" }, 30, "?")).toContain(">PN<");
    expect(personChip({ handle: "priya", color: "plum", avatar_url: "https://a/p.png" }, 30, "?")).toContain('src="https://a/p.png"');
    expect(personChip(null, 30, "mystery-dev")).toContain(">MY<");
    expect(personChip(null, 30, "mystery-dev")).not.toContain("var(--p-");
  });
  it("feedPreviewRow shows the handle in the chosen color", () => {
    expect(feedPreviewRow({ name: "Priya", handle: "priya", color: "rose" })).toContain("@priya");
    expect(feedPreviewRow({ name: "Priya", handle: "priya", color: "rose" })).toContain("var(--p-rose)");
  });
});

describe("onboardView — the first of the first-run cards", () => {
  const s = { ...initialOnboard(), handle: "priya-n", name: "Priya", check: "available" as const, prefill: { provider: "google" as const, label: "p@x.io", email: "p@x.io", name: "Priya", avatar_url: null, suggested_handle: "priya-n" } };
  it("is the bannered card, with a way back to sign-in and the backdrop it is handed behind it", () => {
    const html = onboardView(s, '<div class="cnpy-fr-bg"></div>');
    expect(html).toContain("cnpy-orgs-card");
    expect(html.indexOf("cnpy-fr-bg")).toBeLessThan(html.indexOf("cnpy-orgs-card"));
    expect(html.indexOf("Choose how you'll appear.")).toBeGreaterThan(html.indexOf("cnpy-orgs-banner"));
    expect(html).toMatch(/<button type="button" data-act="backToLogin" data-field="onbBack"[^>]*>Back<\/button>/);
    expect(html).toMatch(/data-act="onbSubmit"[^>]*>Continue<\/button>/);
    expect(html).not.toContain("Enter Trov");
    expect(onboardView(s)).not.toContain("cnpy-fr-bg");
  });
  it("came back from the welcome card: it edits the account — no way back, and Continue", () => {
    const html = onboardView({ ...s, edit: { current: "priya-n" } });
    expect(html).toContain("Step 1 of 3");
    expect(html).not.toContain('data-act="backToLogin"');
    expect(html).toMatch(/data-act="onbSubmit"[^>]*>Continue<\/button>/);
    expect(onboardView({ ...s, edit: { current: "priya-n" }, submitting: true })).toContain("Saving…");
  });
});
