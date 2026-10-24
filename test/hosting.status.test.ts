// THE status function (shared/hosting-status-core.ts): what every surface says about a provider's org-wide
// connection — the card, a part's row, the checklist, the lead, Test this part and the Repo dashboard.
import { describe, it, expect } from "vitest";
import { hostingRevokedReasonText, type ConnectionStatus } from "@shared/hosting";
import {
  endedOnProvider, hostingStatus, isLeftover, leftoverLine, orgConnection, providerStatus, storedConnectionStatus,
} from "@shared/hosting-status-core";

const facts = (status: ConnectionStatus, o: { reason?: string | null } = {}) => ({ status, revoked_reason: o.reason ?? null });

describe("hostingStatus", () => {
  it("a stored credential: connected, or error after a failed use — live and stored either way", () => {
    expect(hostingStatus(facts("connected"), "Railway")).toEqual({ state: "connected", word: "Connected", live: true, stored: true });
    expect(hostingStatus(facts("error"), "Railway")).toEqual({ state: "error", word: "Error", live: true, stored: true });
  });
  it("nothing stored: not connected, and nothing answers (no fallback credential)", () => {
    expect(hostingStatus(null, "Railway")).toEqual({ state: "not_connected", word: "Not connected", live: false, stored: false });
    expect(hostingStatus(facts("not_connected"), "Cloudflare")).toEqual({ state: "not_connected", word: "Not connected", live: false, stored: false });
  });
  it("ended on the provider's side reads Removed; an admin's own Disconnect reads Not connected", () => {
    for (const r of ["uninstalled", "refused"] as const) {
      const f = facts("revoked", { reason: hostingRevokedReasonText(r, "Vercel") });
      expect(endedOnProvider(f, "Vercel")).toBe(true);
      expect(hostingStatus(f, "Vercel")).toEqual({ state: "revoked", word: "Removed", live: false, stored: false });
    }
    for (const r of ["disconnected", "superseded"] as const) {
      const f = facts("revoked", { reason: hostingRevokedReasonText(r, "Vercel") });
      expect(endedOnProvider(f, "Vercel")).toBe(false);
      expect(hostingStatus(f, "Vercel")).toMatchObject({ state: "not_connected", word: "Not connected" });
    }
  });
  it("the stored status rule: a secret wins, then a revoked install row, else not connected", () => {
    expect(storedConnectionStatus({ last_error: null }, { status: "revoked" })).toBe("connected");
    expect(storedConnectionStatus({ last_error: "401" }, null)).toBe("error");
    expect(storedConnectionStatus(null, { status: "revoked" })).toBe("revoked");
    expect(storedConnectionStatus(null, { status: "active" })).toBe("not_connected");
    expect(storedConnectionStatus(null, null)).toBe("not_connected");
  });
});

describe("leftovers are never the connection", () => {
  const list = [
    { provider: "railway" as const, scope: "staging", ...facts("connected") },
    { provider: "railway" as const, scope: "", ...facts("not_connected") },
    { provider: "railway" as const, scope: "production", ...facts("connected") },
  ];
  it("the org-wide row is the provider's connection, whatever order the scoped ones come in", () => {
    expect(isLeftover({ scope: "staging" })).toBe(true);
    expect(isLeftover({ scope: "" })).toBe(false);
    expect(orgConnection(list, "railway")?.scope).toBe("");
    expect(providerStatus(list, "railway", "Railway")).toMatchObject({ state: "not_connected", live: false });
    expect(providerStatus(list.filter((c) => c.scope !== ""), "railway", "Railway")).toMatchObject({ state: "not_connected", live: false });
  });
  it("the card's quiet line: generated count and wording, the cut-over date, and the one thing to do while not connected", () => {
    expect(leftoverLine(2, "Railway", "workspace token", false)).toBe("2 old per-environment tokens from before Oct 15 aren't used. Connect Railway once with a workspace token.");
    expect(leftoverLine(1, "Railway", "workspace token", false)).toBe("1 old per-environment token from before Oct 15 isn't used. Connect Railway once with a workspace token.");
    expect(leftoverLine(2, "Railway", "workspace token", true)).toBe("2 old per-environment tokens from before Oct 15 aren't used.");
    expect(leftoverLine(1, "Fly.io", "API key", false)).toContain("with an API key.");
    expect(leftoverLine(0, "Railway", "workspace token", false)).toBe("");
  });
});
