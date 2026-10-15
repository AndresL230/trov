/**
 * Phase 1 — the notification kind registry (shared/notifications.ts +
 * src/notifications/registry.ts). Pure: no D1.
 */
import { describe, it, expect } from "vitest";
import { Cadence, RunCadence, Section, Window, NotificationKindMeta } from "@shared/notifications";
import { REGISTRY, getKind } from "../src/notifications/registry";

describe("shared notification schemas", () => {
  it("Cadence accepts exactly daily/weekly/off — no immediate tier", () => {
    expect(Cadence.options).toEqual(["daily", "weekly", "off"]);
    expect(Cadence.safeParse("immediate").success).toBe(false);
    expect(RunCadence.options).toEqual(["daily", "weekly"]);
    expect(RunCadence.safeParse("off").success).toBe(false);
  });

  it("Window requires a run cadence, Date bounds and an id", () => {
    const ok = Window.safeParse({ cadence: "daily", start: new Date(), end: new Date(), id: "2026-09-11" });
    expect(ok.success).toBe(true);
    expect(Window.safeParse({ cadence: "off", start: new Date(), end: new Date(), id: "x" }).success).toBe(false);
    expect(Window.safeParse({ cadence: "daily", start: "2026-09-11", end: new Date(), id: "x" }).success).toBe(false);
  });

  it("Section requires heading, html, text and deepLink; a layout is block or line", () => {
    expect(Section.safeParse({ heading: "h", html: "<p>x</p>", text: "x", deepLink: "/#mywork" }).success).toBe(true);
    expect(Section.safeParse({ heading: "h", html: "x", text: "x", deepLink: "/#review", layout: "line", subject: "s" }).success).toBe(true);
    expect(Section.safeParse({ heading: "h", html: "x", text: "x", deepLink: "/#review", layout: "card" }).success).toBe(false);
    expect(Section.safeParse({ heading: "h", html: "<p>x</p>", text: "x" }).success).toBe(false);
  });

  it("NotificationKindMeta rejects an allowedCadences list without 'off'", () => {
    const r = NotificationKindMeta.safeParse({
      id: "x", label: "X", description: "x", defaultCadence: "daily", allowedCadences: ["daily"],
    });
    expect(r.success).toBe(false);
  });

  it("NotificationKindMeta rejects a defaultCadence outside allowedCadences", () => {
    const r = NotificationKindMeta.safeParse({
      id: "x", label: "X", description: "x", defaultCadence: "weekly", allowedCadences: ["daily", "off"],
    });
    expect(r.success).toBe(false);
  });
});

describe("registry", () => {
  it("has the five kinds, in the e-mail's order (the brief, This week, then the queue lines), with their defaults", () => {
    expect(REGISTRY.map((k) => k.id)).toEqual(["my_work", "week_recap", "review_queue", "roadmap_plan", "ticketq"]);
    expect(getKind("my_work")).toMatchObject({ label: "Your brief", defaultCadence: "daily", allowedCadences: ["daily", "weekly", "off"] });
    // Phase E: the weekly's "This week" — weekly only.
    expect(getKind("week_recap")).toMatchObject({ label: "This week", defaultCadence: "weekly", allowedCadences: ["weekly", "off"] });
    expect(getKind("review_queue")).toMatchObject({ label: "Review", defaultCadence: "daily", allowedCadences: ["daily", "off"] });
    expect(getKind("roadmap_plan")).toMatchObject({ label: "Sprint", defaultCadence: "weekly", allowedCadences: ["daily", "weekly", "off"] });
    expect(REGISTRY.every((k) => !/milestone/i.test(k.description) && !/milestone/i.test(k.label))).toBe(true);
    expect(getKind("ticketq")).toMatchObject({ label: "Tickets", defaultCadence: "daily", allowedCadences: ["daily", "weekly", "off"] });
    expect(getKind("nope")).toBeUndefined();
  });

  it("every registry entry validates against NotificationKindMeta and has a renderer", () => {
    for (const k of REGISTRY) {
      expect(NotificationKindMeta.safeParse(k).success, k.id).toBe(true);
      expect(typeof k.render).toBe("function");
    }
    expect(new Set(REGISTRY.map((k) => k.id)).size).toBe(REGISTRY.length);
  });
});
