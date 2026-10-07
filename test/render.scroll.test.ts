/**
 * Scroll preservation across rerender. The SPA rebuilds the whole tree with
 * `mount.innerHTML = render(state)` on every state change, which replaces the
 * main scroll pane with a fresh element at scrollTop 0 — so any button low on
 * a long screen (Settings › Email notifications, Maintenance › Notifications)
 * jumped the pane back to the top. `captureScroll` / `restoreScroll` wrap the
 * swap and put the pane back where it was, but only for the same screen: a
 * screen change still starts at the top.
 */
import { describe, it, expect } from "vitest";
import { render, initialState } from "../web/src/render";
import { captureScroll, restoreScroll, MAIN_PANE } from "../web/src/scroll";

type Pane = { scrollTop: number };
function root(pane: Pane | null) {
  return { querySelector: (sel: string) => (sel === MAIN_PANE ? pane : null) };
}

describe("main pane scroll survives a rerender on the same screen", () => {
  it("the app shell renders the main pane with the id the helper looks for", () => {
    const s: ReturnType<typeof initialState> = { ...initialState(), view: "app", screen: "settings", me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 } };
    expect(render(s)).toContain(`id="${MAIN_PANE.slice(1)}"`);
  });

  it("captures the pane's scrollTop keyed by screen", () => {
    expect(captureScroll(root({ scrollTop: 400 }), "settings")).toEqual({ key: "settings", top: 400 });
  });

  it("restores the captured scrollTop onto the freshly rendered pane", () => {
    const snap = captureScroll(root({ scrollTop: 400 }), "settings");
    const fresh = { scrollTop: 0 };
    expect(restoreScroll(root(fresh), snap, "settings")).toBe(true);
    expect(fresh.scrollTop).toBe(400);
  });

  it("does NOT restore when the screen changed — a new screen starts at the top", () => {
    const snap = captureScroll(root({ scrollTop: 400 }), "settings");
    const fresh = { scrollTop: 0 };
    expect(restoreScroll(root(fresh), snap, "feed")).toBe(false);
    expect(fresh.scrollTop).toBe(0);
  });

  it("is a no-op when there is no pane (auth screens) or nothing captured", () => {
    expect(captureScroll(root(null), "settings")).toBeNull();
    const fresh = { scrollTop: 0 };
    expect(restoreScroll(root(fresh), null, "settings")).toBe(false);
    expect(restoreScroll(root(null), { key: "settings", top: 400 }, "settings")).toBe(false);
  });
});
