import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createInvite, findLiveInvite, acceptInvite, revokeInvite, listInvites, recordInviteEmail } from "../src/auth/invites";
import { seedPerson } from "./helpers/persons";

import { platformCtx } from "./helpers/tenant";
describe("invites", () => {
  it("creates lowercased, finds live, accepts, and stops being live", async () => {
    const row = await createInvite(platformCtx(), { email: "Priya.N@Gmail.com", name: "Priya", invitedBy: "AndresL230" });
    expect(row.email).toBe("priya.n@gmail.com");
    expect((await findLiveInvite(platformCtx(), "PRIYA.n@gmail.com"))?.email).toBe("priya.n@gmail.com");
    await acceptInvite(platformCtx(), "priya.n@gmail.com", "priya");
    expect(await findLiveInvite(platformCtx(), "priya.n@gmail.com")).toBeNull();
    expect((await listInvites(platformCtx()))[0].accepted_by).toBe("priya");
  });
  it("revoke is soft and idempotent; a revoked invite is not live", async () => {
    await createInvite(platformCtx(), { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    expect(await revokeInvite(platformCtx(), "m@x.io")).toBe(true);
    expect(await revokeInvite(platformCtx(), "m@x.io")).toBe(true);
    expect(await revokeInvite(platformCtx(), "none@x.io")).toBe(false);
    expect(await findLiveInvite(platformCtx(), "m@x.io")).toBeNull();
    expect((await listInvites(platformCtx()))[0].revoked_at).toBeTruthy();
  });
  it("refuses a duplicate live invite and an address that is already a person's", async () => {
    await createInvite(platformCtx(), { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    await expect(createInvite(platformCtx(), { email: "m@x.io", name: null, invitedBy: "AndresL230" })).rejects.toThrow("invite_exists");
    await seedPerson("priya", { email: "priya@x.io" });
    await expect(createInvite(platformCtx(), { email: "Priya@x.io", name: null, invitedBy: "AndresL230" })).rejects.toThrow("already_a_person");
  });
  it("a revoked invite can be re-invited (row is replaced, revoked_at cleared)", async () => {
    await createInvite(platformCtx(), { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    await revokeInvite(platformCtx(), "m@x.io");
    const again = await createInvite(platformCtx(), { email: "m@x.io", name: "M", invitedBy: "AndresL230" });
    expect(again.revoked_at).toBeNull();
    expect(again.name).toBe("M");
  });
  it("recordInviteEmail stores the outcome", async () => {
    await createInvite(platformCtx(), { email: "m@x.io", name: null, invitedBy: "AndresL230" });
    await recordInviteEmail(env.DB, "m@x.io", { id: "em_1", error: null });
    const r = (await listInvites(platformCtx()))[0];
    expect(r.email_id).toBe("em_1"); expect(r.email_sent_at).toBeTruthy(); expect(r.email_error).toBeNull();
  });
});
