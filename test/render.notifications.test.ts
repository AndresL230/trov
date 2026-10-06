/**
 * Render tests — the email-notification surfaces from Canopy.dc.html:
 * Settings › Email notifications, Maintenance › NOTIFICATIONS (policy /
 * schedule / outbox), and the unsubscribe confirmation view. Pure functions,
 * mock-fed props, HTML-string assertions (pattern: render.review.test.ts).
 */
import { SENDER_NAME_HELP, senderNamePart, senderNameProblem } from "@shared/sender";
import { describe, it, expect, afterEach } from "vitest";
import { setApiOrg } from "../web/src/api";
import { emailNotificationsSection, notificationsAdminSections, unsubscribeView } from "../web/src/notifications";
import type { PrefsView, PolicyKindView } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationSettingsRow } from "@shared/rows";

const prefs = (over: Partial<PrefsView> = {}): PrefsView => ({
  email: "jose@sapling.dev",
  unsubscribed: false,
  kinds: [
    { id: "my_work", label: "My Work", description: "Your merged PRs.", allowedCadences: ["daily", "weekly", "off"], cadence: "weekly", orgDefault: "daily", inherited: false },
    { id: "review_queue", label: "Review queue", description: "Waiting on you.", allowedCadences: ["daily", "off"], cadence: "daily", orgDefault: "daily", inherited: true },
  ],
  ...over,
});

describe("emailNotificationsSection", () => {
  it("shows the address in view mode with an Edit action, and the edit form when editing", () => {
    const view = emailNotificationsSection({ prefs: prefs(), loading: false, error: null, emailEditing: false, emailDraft: "" });
    expect(view).toContain("jose@sapling.dev");
    expect(view).toContain('data-act="emailStartEdit"');
    expect(view).not.toContain('data-act="emailSave"');
    const edit = emailNotificationsSection({ prefs: prefs(), loading: false, error: null, emailEditing: true, emailDraft: "new@x.dev" });
    expect(edit).toContain('data-act="emailSave"');
    expect(edit).toContain('value="new@x.dev"');
    expect(edit).toContain("Save empty to remove the address");
  });

  it("shows the no-address card when the address is null", () => {
    const view = emailNotificationsSection({ prefs: prefs({ email: null }), loading: false, error: null, emailEditing: false, emailDraft: "" });
    expect(view).toContain("No email on file");
    expect(view).toContain('data-act="emailSave"');
  });

  it("renders one row per kind with segment buttons from allowedCadences, ORG DEFAULT when inherited, Reset when overridden", () => {
    const view = emailNotificationsSection({ prefs: prefs(), loading: false, error: null, emailEditing: false, emailDraft: "" });
    expect(view).toContain('data-act="setKindCadence" data-arg="my_work:weekly"');
    expect(view).toContain('data-act="setKindCadence" data-arg="review_queue:off"');
    expect(view).not.toContain('data-arg="review_queue:weekly"');
    expect(view).toContain('data-act="resetKind" data-arg="my_work"');
    expect(view.match(/ORG DEFAULT/g)).toHaveLength(1);
    expect(view).toContain("Kinds turned off org-wide don't appear here at all");
  });

  it("marks the resolved cadence as the active segment", () => {
    const view = emailNotificationsSection({ prefs: prefs(), loading: false, error: null, emailEditing: false, emailDraft: "" });
    // The shared segmented() switch, one per kind (a unique, stable id each).
    expect(view).toContain('data-seg="cadence-my_work"');
    expect(view).toContain('class="cnpy-seg-btn is-on" data-act="setKindCadence" data-arg="my_work:weekly" aria-pressed="true"');
    expect(view).toContain('class="cnpy-seg-btn" data-act="setKindCadence" data-arg="my_work:daily" aria-pressed="false"');
  });

  it("dims the list and checks the switch when unsubscribed", () => {
    const view = emailNotificationsSection({ prefs: prefs({ unsubscribed: true }), loading: false, error: null, emailEditing: false, emailDraft: "" });
    expect(view).toContain('aria-checked="true"');
    expect(view).toContain("pointer-events:none");
  });

  it("escapes a hostile address and label", () => {
    const view = emailNotificationsSection({ prefs: prefs({ email: `<img src=x onerror=alert(1)>`, kinds: [{ ...prefs().kinds[0], label: "<b>x</b>" }] }), loading: false, error: null, emailEditing: false, emailDraft: "" });
    expect(view).not.toContain("<img src=x");
    expect(view).not.toContain("<b>x</b>");
  });

  it("renders a loading state before prefs arrive", () => {
    expect(emailNotificationsSection({ prefs: null, loading: true, error: null, emailEditing: false, emailDraft: "" })).toContain("Loading");
  });
});

// Phase 5b (§5's Settings bullet): Settings iterates the registry, so the
// "Ticket queue" row costs the SPA nothing — it appears the moment Phase 6
// registers the `ticketq` kind. This pins that: a prefs view carrying the kind
// renders its row with the full Daily / Weekly / Off segment.
describe("emailNotificationsSection — the Ticket queue row (registry-driven)", () => {
  const ticketq = {
    id: "ticketq",
    label: "Ticket queue",
    description: "New and unassigned tickets across the org.",
    allowedCadences: ["daily", "weekly", "off"] as const,
    cadence: "daily" as const,
    orgDefault: "daily" as const,
    inherited: true,
  };

  it("renders a Ticket queue row with Daily/Weekly/Off segments and the ORG DEFAULT marker", () => {
    const view = emailNotificationsSection({
      prefs: prefs({ kinds: [{ ...ticketq, allowedCadences: [...ticketq.allowedCadences] }] }),
      loading: false, error: null, emailEditing: false, emailDraft: "",
    });
    expect(view).toContain("Ticket queue");
    expect(view).toContain("New and unassigned tickets across the org.");
    expect(view).toContain('data-act="setKindCadence" data-arg="ticketq:daily"');
    expect(view).toContain('data-act="setKindCadence" data-arg="ticketq:weekly"');
    expect(view).toContain('data-act="setKindCadence" data-arg="ticketq:off"');
    expect(view).toContain("ORG DEFAULT");
    expect(view).not.toContain('data-act="resetKind" data-arg="ticketq"'); // inherited → nothing to reset
  });

  it("is absent from Settings when the org disabled it (the prefs view omits disabled kinds)", () => {
    const view = emailNotificationsSection({ prefs: prefs({ kinds: [] }), loading: false, error: null, emailEditing: false, emailDraft: "" });
    expect(view).not.toContain("Ticket queue");
  });
});

describe("unsubscribeView", () => {
  it("confirms with the address and offers Settings", () => {
    const v = unsubscribeView({ email: "jose@sapling.dev", pending: false, error: null });
    expect(v).toContain("Email is off.");
    expect(v).toContain("jose@sapling.dev");
    expect(v).toContain('data-act="unsubGoSettings"');
  });
  it("shows a pending state while the flip is in flight", () => {
    expect(unsubscribeView({ email: null, pending: true, error: null })).toContain("Turning email off");
  });
  it("the confirmation card is the shared surface, not an inline bordered box", () => {
    const v = unsubscribeView({ email: "jose@sapling.dev", pending: false, error: null });
    expect(v).toContain('class="cnpy-surface"');
    expect(v).not.toContain("border-radius:14px");
    expect(v).not.toContain("color-mix(in srgb,var(--fg) 2.5%");
  });
});

describe("notificationsAdminSections", () => {
  const policy: PolicyKindView[] = [
    { id: "my_work", label: "My Work", description: "d", allowedCadences: ["daily", "weekly", "off"], registryDefault: "daily", enabled: true, default_cadence: "daily", updated_at: null, updated_by: null },
    { id: "review_queue", label: "Review queue", description: "d", allowedCadences: ["daily", "off"], registryDefault: "daily", enabled: false, default_cadence: "daily", updated_at: null, updated_by: null },
  ];
  const settings: NotificationSettingsRow = { org_id: "org_saplinglearn", send_hour: 8, timezone: "America/New_York", from_address: "Trov <c@mail.example>" };
  const outbox: NotificationOutboxRow[] = [
    { idempotency_key: "jose:daily:2026-09-11", user_id: "jose", cadence: "daily", window_id: "2026-09-11", kinds: '["my_work"]', status: "sent", resend_id: "em_1", error: null, created_at: "2026-09-11T12:00:00Z", sent_at: "2026-09-11T12:00:01Z" },
    { idempotency_key: "dev:daily:2026-09-11", user_id: "dev", cadence: "daily", window_id: "2026-09-11", kinds: '["my_work"]', status: "failed", resend_id: null, error: "send: resend 422: mailbox unavailable", created_at: "2026-09-11T12:00:00Z", sent_at: null },
  ];

  it("policy rows carry a switch, a cadence select limited to allowed non-off cadences, disabled when off", () => {
    const v = notificationsAdminSections({ policy, settings, outbox: [], outboxExpanded: null, fromDraft: null });
    expect(v).toContain("NOTIFICATIONS · POLICY");
    expect(v).toContain("1 of 2 enabled");
    expect(v).toContain('data-act="policyToggle" data-arg="my_work"');
    const selectOf = (id: string) => { const i = v.indexOf(`data-act="policyCadence" data-arg="${id}"`); return v.slice(i, v.indexOf("</select>", i)); };
    const mw = selectOf("my_work");
    expect(mw).toContain('value="weekly"');
    const rq = selectOf("review_queue");
    expect(rq).not.toContain('value="weekly"');
    expect(rq).toContain("disabled");
  });

  it("schedule shows the current hour, timezone and from address as editable controls", () => {
    const v = notificationsAdminSections({ policy, settings, outbox: [], outboxExpanded: null, fromDraft: null });
    expect(v).toContain("NOTIFICATIONS · SCHEDULE");
    expect(v).toMatch(/<option value="8" selected>08:00<\/option>/);
    expect(v).toMatch(/<option value="America\/New_York" selected>/);
    // The sender field takes a NAME only — whatever address is stored, the one shown is the platform's.
    expect(v).toContain("SENDER NAME");
    expect(v).toMatch(/<input id="sched-from" data-act="schedFrom"[^>]*maxlength="64"[^>]*value="Trov"/);
    expect(v).not.toContain("c@mail.example");
    expect(v).toContain("Trov &lt;hello@trov.dev&gt;");
    expect(v).toContain("The address is Trov's and can't be changed.");
    expect(v).not.toContain("FROM ADDRESS");
  });

  it("the sender name echoes into the fixed address while typing, and a refused name is said under the field", () => {
    const typing = notificationsAdminSections({ policy, settings, outbox: [], outboxExpanded: null, fromDraft: "Acme Robotics" });
    expect(typing).toContain('value="Acme Robotics"');
    expect(typing).toContain("Acme Robotics &lt;hello@trov.dev&gt;");
    expect(typing).not.toContain("data-sender-error");
    const bad = notificationsAdminSections({ policy, settings, outbox: [], outboxExpanded: null, fromDraft: "Trov Security", fromError: SENDER_NAME_HELP.reserved });
    expect(bad).toMatch(/<input id="sched-from"[^>]*aria-invalid="true"/);
    expect(bad).toMatch(/<div role="alert" data-sender-error[^>]*>A sender name can&#39;t contain &quot;trov&quot; unless it is exactly &quot;Trov&quot;\.<\/div>/);
  });

  it("the sender-name rule is the Worker's own (shared/sender.ts): letters, digits, space and . & ' + _ -, 64 at most, no 'trov' unless exactly Trov", () => {
    for (const ok of ["Trov", "Acme Robotics", "R&D - Team_2", "O'Neil + Co.", "a".repeat(64)]) expect(senderNameProblem(ok), ok).toBeNull();
    expect(senderNameProblem("")).toBe("empty");
    expect(senderNameProblem("a".repeat(65))).toBe("too_long");
    for (const bad of ["Acme <x@y.z>", "Acme, Inc", "Zoë", "a@b", 'Say "hi"', "line\nbreak", "semi;colon"]) expect(senderNameProblem(bad), bad).toBe("characters");
    for (const bad of ["Trov Security", "trov", "T.r.o.v", "The TROV team"]) expect(senderNameProblem(bad), bad).toBe("reserved");
    expect(senderNamePart("Acme Robotics <hello@trov.dev>")).toBe("Acme Robotics");
    expect(senderNamePart("someone@example.com")).toBe("");
    expect(senderNamePart('"Quoted Name" <x@y.z>')).toBe("Quoted Name");
    expect(Object.keys(SENDER_NAME_HELP).sort()).toEqual(["characters", "empty", "reserved", "too_long"]);
  });

  it("outbox lists rows newest first with status; a failed row expands to its error", () => {
    const collapsed = notificationsAdminSections({ policy, settings, outbox, outboxExpanded: null, fromDraft: null });
    expect(collapsed).toContain("2 runs");
    expect(collapsed).toContain('data-act="outboxToggle" data-arg="dev:daily:2026-09-11"');
    expect(collapsed).not.toContain("mailbox unavailable");
    const expanded = notificationsAdminSections({ policy, settings, outbox, outboxExpanded: "dev:daily:2026-09-11", fromDraft: null });
    expect(expanded).toContain("mailbox unavailable");
  });

  it("outbox empty state", () => {
    const v = notificationsAdminSections({ policy, settings, outbox: [], outboxExpanded: null, fromDraft: null });
    expect(v).toContain("No sends yet");
  });
});

describe("Org settings › Notifications — preview + test send controls", () => {
  afterEach(() => setApiOrg(null));
  it("offers preview links for daily, weekly and sample, and test-send buttons for both cadences", () => {
    const sections = () => notificationsAdminSections({ policy: [], settings: { org_id: "org_saplinglearn", send_hour: 8, timezone: "UTC", from_address: "a@b.co" }, outbox: [], outboxExpanded: null, fromDraft: null });
    // The preview is the ORG's digest: its links are under the org on screen, like every request.
    setApiOrg("acme");
    const v = sections();
    expect(v).toContain('href="/api/o/acme/notifications/preview?cadence=daily"');
    expect(v).toContain('href="/api/o/acme/notifications/preview?cadence=weekly"');
    expect(v).toContain('href="/api/o/acme/notifications/preview?cadence=daily&amp;sample=1"');
    expect(v).not.toContain('href="/api/notifications/');
    // With no org open the links are inert, never the unprefixed alias.
    setApiOrg(null);
    expect(sections()).not.toContain("/notifications/preview");
    expect(v).toContain('data-act="testSend" data-arg="daily"');
    expect(v).toContain('data-act="testSend" data-arg="weekly"');
  });
});
