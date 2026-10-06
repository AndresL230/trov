/**
 * Phase 6 — the `ticketq` digest kind: the renderer (a pure read over real D1
 * ticket rows), its registry/policy wiring, and what a run does with it.
 * Every assertion is on rows (outbox + the dev-only bodies table) or on the
 * rendered Section, never on a mock.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, first, run } from "./helpers/db";
import { create_ticket, transition_ticket } from "../src/tools/tickets";
import { create_sprint } from "../src/tools/sprints";
import { getKind, REGISTRY } from "../src/notifications/registry";
import { seedNotificationPolicy } from "../src/notifications/policy";
import { runDigest } from "../src/notifications/run";
import { localDelivery } from "../src/notifications/delivery";
import { seedPerson, cookieFor } from "./helpers/persons";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import type { Window } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationPolicyRow } from "@shared/rows";

import { systemCtx, platformCtx } from "./helpers/tenant";
// The same window the other renderer tests use: the 24h ending 2026-09-11T12:00Z.
const WINDOW: Window = {
  cadence: "daily",
  start: new Date("2026-09-10T12:00:00.000Z"),
  end: new Date("2026-09-11T12:00:00.000Z"),
  id: "2026-09-11",
};
const FRI = new Date("2026-09-11T12:00:00.000Z"); // Friday 08:00 ET
const MON = new Date("2026-09-14T12:00:00.000Z"); // Monday 08:00 ET
const LOGIN = "AndresL230";
const OTHER = "lpcooper-arch";
const FILER = "meilin"; // a Google-only non-engineer — the queue's requester

const kind = () => getKind("ticketq")!;

/** File a ticket as `requester`; `at` back-dates created_at/updated_at so order and age are deterministic. */
async function file(
  title: string,
  o: { requester?: string; assignees?: string[]; category?: string; priority?: string; sprint_id?: number; at?: string } = {}
): Promise<number> {
  const requester = o.requester ?? FILER;
  await seedPerson(requester, { github: false });
  for (const a of o.assignees ?? []) await seedPerson(a);
  const id = await create_ticket(
    systemCtx(),
    TicketCreate.parse({
      title,
      assignees: o.assignees ?? [],
      category: o.category,
      priority: o.priority,
      sprint_id: o.sprint_id ?? null,
    }),
    requester
  );
  if (o.at) await run(env.DB, `UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?`, o.at, o.at, id);
  return id;
}

/** Row counts across every table the renderer reads — a renderer must not write. */
async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["tickets", "ticket_assignees", "ticket_events", "ticket_comments", "ticket_links", "sprints", "persons"]) {
    out[t] = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${t}`))!.n;
  }
  return out;
}

async function user(handle: string, email: string | null, unsubscribed = 0): Promise<void> {
  await seedPerson(handle, { name: handle, email });
  await run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = ? WHERE handle = ?`, email, unsubscribed, handle);
}

const outbox = () => all<NotificationOutboxRow>(env.DB, `SELECT * FROM notification_outbox ORDER BY user_id, cadence`);
const bodies = () => all<{ idempotency_key: string; to_address: string; subject: string; html: string; text: string }>(env.DB, `SELECT * FROM notification_outbox_bodies ORDER BY idempotency_key`);
const kindsOf = (row: NotificationOutboxRow) => JSON.parse(row.kinds) as string[];

describe("registry entry", () => {
  it("is the fourth kind, with the brief's label, description and defaults", () => {
    expect(REGISTRY.map((k) => k.id)).toEqual(["my_work", "review_queue", "roadmap_plan", "ticketq"]);
    expect(kind()).toMatchObject({
      id: "ticketq",
      label: "Ticket queue",
      description: "New and unassigned tickets across the org.",
      defaultCadence: "daily",
      allowedCadences: ["daily", "weekly", "off"],
    });
  });

  it("seeds a notification_policy row from the registry", async () => {
    await run(env.DB, `DELETE FROM notification_policy`);
    const r = await seedNotificationPolicy(systemCtx());
    expect(r.inserted).toContain("ticketq");
    expect(await first<NotificationPolicyRow>(env.DB, `SELECT * FROM notification_policy WHERE kind = 'ticketq'`)).toMatchObject({
      default_cadence: "daily",
      enabled: 1,
      updated_by: "registry",
    });
  });
});

describe("ticketq renderer", () => {
  it("returns null when nothing is unassigned and nothing is assigned to the recipient", async () => {
    // A submitted ticket that IS assigned (to someone else) and a done ticket:
    // neither qualifies for either half, so the section is dropped entirely.
    await file("Assigned to Luke", { assignees: [OTHER] });
    const done = await file("Already finished", { assignees: [LOGIN] });
    await transition_ticket(systemCtx(), done, "in_progress", LOGIN);
    await transition_ticket(systemCtx(), done, "done", LOGIN);

    expect(await kind().render(systemCtx(), LOGIN, WINDOW)).toBeNull();
  });

  it("lists submitted tickets with no assignees, newest first — not an in_progress one, not an assigned one", async () => {
    const older = await file("Older unassigned ask", { at: "2026-09-08T12:00:00Z", category: "request", priority: "high" });
    const newest = await file("Newest unassigned ask", { at: "2026-09-10T12:00:00Z", category: "access" });
    const started = await file("Unassigned but started", { at: "2026-09-09T12:00:00Z" });
    await transition_ticket(systemCtx(), started, "in_progress", LOGIN); // still nobody on it — only the status differs
    await file("Submitted but assigned", { assignees: [OTHER], at: "2026-09-09T12:00:00Z" });

    const before = await tableCounts();
    // Rendered for a recipient with nothing assigned, so this half stands alone.
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(await tableCounts()).toEqual(before); // pure read

    expect(s).not.toBeNull();
    expect(s.heading).toBe("Ticket queue");
    expect(s.deepLink).toBe("/#tickets");
    expect(s.linkLabel).toBe("Tickets");
    expect(s.summary).toBe("2 tickets unassigned");

    expect(s.html).toContain("Newest unassigned ask");
    expect(s.html).toContain("Older unassigned ask");
    expect(s.html).not.toContain("Unassigned but started"); // in_progress is not "new"
    expect(s.html).not.toContain("Submitted but assigned"); // somebody already has it
    // newest created_at first
    expect(s.html.indexOf("Newest unassigned ask")).toBeLessThan(s.html.indexOf("Older unassigned ask"));

    // each line carries category, priority, requester and age
    expect(s.html).toContain("request");
    expect(s.html).toContain("HIGH");
    expect(s.html).toContain("Meilin Zhao"); // the requester, by name
    expect(s.html).toContain("3d"); // 2026-09-08 → window end 2026-09-11
    expect(s.text).toContain("Older unassigned ask");
    expect(s.text).toContain("Meilin Zhao");

    // NO numeric id, in either alternative: a ticket's id is an internal D1 key.
    // (The HTML carries `#rrggbb` CSS colors, so this checks the ids themselves.)
    for (const id of [older, newest]) {
      expect(s.html).not.toContain(`#${id} `);
      expect(s.html).not.toContain(`#${id}&`);
      expect(s.text).not.toContain(`#${id}`);
    }
    expect(s.html).not.toContain("&middot; opened");   // the id used to lead this footer
    expect(s.text).not.toMatch(/#\d/);                 // the text ledger has no CSS at all
  });

  it("lists at most 5 unassigned tickets and counts the rest as '+N more waiting in Tickets'", async () => {
    // TOP = 5: a digest is a nudge, not the queue. The cap and the overflow line
    // are the contract — without the line the reader would think the org has 5.
    for (let i = 1; i <= 6; i++) await file(`Unassigned ${i}`, { at: `2026-09-0${i}T12:00:00Z` });

    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.summary).toBe("6 tickets unassigned");
    // newest first, so 6 … 2 are shown and the OLDEST (1) is the one that rolls up
    for (const i of [6, 5, 4, 3, 2]) expect(s.html).toContain(`Unassigned ${i}`);
    expect(s.html).not.toContain("Unassigned 1<");
    expect(s.html).toContain("+1 more waiting in Tickets");
    expect(s.text).toContain("+1 more waiting in Tickets");
    expect(s.text.split("\n").filter((l) => l.includes("unassigned  ")).length).toBe(5);
  });

  it("lists the recipient's open assigned tickets with status and sprint, omitting closed ones and other people's", async () => {
    const sprint = (await create_sprint(systemCtx(), SprintCreate.parse({ label: "Queue hardening" }), LOGIN)).id;
    await file("Mine, in progress", { assignees: [LOGIN], sprint_id: sprint, at: "2026-09-10T12:00:00Z" }).then((id) =>
      transition_ticket(systemCtx(), id, "in_progress", LOGIN)
    );
    await file("Mine, submitted", { assignees: [LOGIN], at: "2026-09-09T12:00:00Z" });
    const declined = await file("Mine, declined", { assignees: [LOGIN] });
    await transition_ticket(systemCtx(), declined, "declined", LOGIN);
    const finished = await file("Mine, done", { assignees: [LOGIN] });
    await transition_ticket(systemCtx(), finished, "in_progress", LOGIN);
    await transition_ticket(systemCtx(), finished, "done", LOGIN);
    await file("Luke's ticket", { assignees: [OTHER] });

    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s).not.toBeNull();
    expect(s.html).toContain("Mine, in progress");
    expect(s.html).toContain("Mine, submitted");
    expect(s.html).not.toContain("Mine, declined");
    expect(s.html).not.toContain("Mine, done");
    expect(s.html).not.toContain("Luke&#39;s ticket");
    expect(s.html).not.toContain("Luke's ticket");

    expect(s.html).toContain("In progress"); // the status pill's label text
    expect(s.html).toContain("Queue hardening"); // the sprint label
    expect(s.summary).toBe("2 tickets assigned to you");
    expect(s.text).toContain("Mine, submitted");
  });

  it("summarises both halves in one line, singular included", async () => {
    await file("Nobody has this", { at: "2026-09-10T12:00:00Z" });
    await file("I have this", { assignees: [LOGIN], at: "2026-09-10T12:00:00Z" });
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.summary).toBe("1 ticket unassigned · 1 assigned to you");
  });

  it("escapes HTML in a ticket title", async () => {
    await file(`<img src=x onerror=alert(1)>`);
    const s = (await kind().render(systemCtx(), LOGIN, WINDOW))!;
    expect(s.html).not.toContain("<img src=x");
    expect(s.html).toContain("&lt;img src=x");
  });
});

describe("runDigest with ticketq", () => {
  const delivery = () => localDelivery(systemCtx());

  it("writes ONE outbox row carrying ticketq, keyed org:user:cadence:window_id, with the ticket in the body — a re-run adds nothing", async () => {
    await user(LOGIN, "andres@example.com");
    await file("Projector in room 3 is dead", { at: "2026-09-10T12:00:00Z" });

    await runDigest(systemCtx(), platformCtx(), "daily", FRI, { delivery: delivery() });
    await runDigest(systemCtx(), platformCtx(), "daily", FRI, { delivery: delivery() });

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idempotency_key: `org_saplinglearn:${LOGIN}:daily:2026-09-11`, status: "sent", user_id: LOGIN, cadence: "daily", window_id: "2026-09-11" });
    expect(kindsOf(rows[0])).toContain("ticketq");

    const b = await bodies();
    expect(b).toHaveLength(1);
    expect(b[0].html).toContain("Ticket queue");
    expect(b[0].html).toContain("Projector in room 3 is dead");
    expect(b[0].text).toContain("Projector in room 3 is dead");
  });

  it("a run where every kind renders null writes a skipped row and no body", async () => {
    await user(LOGIN, "andres@example.com");
    await runDigest(systemCtx(), platformCtx(), "daily", FRI, { delivery: delivery() });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", kinds: "[]", sent_at: null });
    expect(await bodies()).toHaveLength(0);
  });

  it("a user pref of weekly excludes ticketq from the daily run and includes it in the weekly run", async () => {
    await user(LOGIN, "andres@example.com");
    await file("Badge reader at the side door", { at: "2026-09-10T12:00:00Z" });
    await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES (?, 'ticketq', 'weekly', 'now')`, LOGIN);

    await runDigest(systemCtx(), platformCtx(), "daily", MON, { delivery: delivery() });
    await runDigest(systemCtx(), platformCtx(), "weekly", MON, { delivery: delivery() });

    const rows = await outbox();
    const daily = rows.find((r) => r.cadence === "daily")!;
    const weekly = rows.find((r) => r.cadence === "weekly")!;
    expect(kindsOf(daily)).not.toContain("ticketq");
    expect(daily.status).toBe("skipped"); // nothing else has anything to say
    expect(kindsOf(weekly)).toContain("ticketq");
    expect(weekly.status).toBe("sent");
    const b = (await bodies()).find((x) => x.idempotency_key === weekly.idempotency_key)!;
    expect(b.text).toContain("Badge reader at the side door");
  });
});

describe("policy + prefs surfaces", () => {
  it("GET /api/notifications/policy lists ticketq with its registry defaults", async () => {
    const cookie = await cookieFor("admin-user");
    const res = await app.request("/api/notifications/policy", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { kinds: { id: string; label: string; description: string; registryDefault: string; enabled: boolean; default_cadence: string; allowedCadences: string[] }[] };
    expect(view.kinds.map((k) => k.id)).toContain("ticketq");
    expect(view.kinds.find((k) => k.id === "ticketq")).toMatchObject({
      label: "Ticket queue",
      description: "New and unassigned tickets across the org.",
      registryDefault: "daily",
      default_cadence: "daily",
      enabled: true,
      allowedCadences: ["daily", "weekly", "off"],
    });
  });

  it("disabling ticketq org-wide removes it from a user's Settings prefs and from the next run's kinds", async () => {
    const admin = await cookieFor("admin-user");
    const mine = await cookieFor(LOGIN, { email: "andres@example.com" });
    await user(LOGIN, "andres@example.com");
    await file("Laptop swap for the new hire", { at: "2026-09-10T12:00:00Z" });

    // Enabled: the row is in Settings.
    let prefs = (await (await app.request("/api/notifications/prefs", { headers: { cookie: mine } }, env)).json()) as { kinds: { id: string }[] };
    expect(prefs.kinds.map((k) => k.id)).toContain("ticketq");

    const res = await app.request(
      "/api/notifications/policy",
      { method: "PUT", headers: { cookie: admin, "content-type": "application/json" }, body: JSON.stringify({ kind: "ticketq", enabled: false }) },
      env
    );
    expect(res.status).toBe(200);
    expect(await first<NotificationPolicyRow>(env.DB, `SELECT * FROM notification_policy WHERE kind = 'ticketq'`)).toMatchObject({ enabled: 0 });

    prefs = (await (await app.request("/api/notifications/prefs", { headers: { cookie: mine } }, env)).json()) as { kinds: { id: string }[] };
    expect(prefs.kinds.map((k) => k.id)).not.toContain("ticketq");

    await runDigest(systemCtx(), platformCtx(), "daily", FRI, { delivery: localDelivery(systemCtx()) });
    const [row] = await outbox();
    expect(kindsOf(row)).not.toContain("ticketq");
    expect(row.status).toBe("skipped"); // ticketq was the only kind with anything to say
    expect(await bodies()).toHaveLength(0);
  });
});
