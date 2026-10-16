// Email-notification surfaces (canopy-email.md §8), componentized from
// Canopy.dc.html: Settings › Email notifications (a person's own), Org settings ›
// Notifications (the org's policy / schedule / outbox — an admin's; it sat under
// Maintenance › People until 2026-10-06). Pure presentational functions over props — no fetch, no state.
import { STILL_SENT_SENTENCE, UNSUBSCRIBE_STOPS } from "@shared/email-unsubscribe";
import type { Cadence, PrefsView, PolicyKindView } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationSettingsRow } from "@shared/rows";
import { esc, attr, surface } from "./ui";
import { tenantHref } from "./api";
import { O_LABEL, O_HELP, orgHead, orgEmpty, tabLead, quietBtn } from "./org-ui";
import { kindMark } from "./marks";
import { segmented } from "./segmented";
import { skeleton, skBox, skLine, skList, skW, skRows } from "./skeleton";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { PLATFORM_FROM_ADDRESS, PLATFORM_SENDER_NAME, SENDER_NAME_MAX, senderNamePart } from "@shared/sender";

const LABEL = "font-family:var(--label)";
const cadCap = (c: Cadence): string => (c === "off" ? "Off" : c.charAt(0).toUpperCase() + c.slice(1));
const trackStyle = (on: boolean): string =>
  `width:36px;height:21px;border-radius:999px;border:1px solid ${on ? "var(--accent)" : "var(--border-strong)"};background:${on ? "var(--accent)" : "transparent"};position:relative;flex:none;padding:0;transition:all .15s ease;display:inline-block`;
const knobStyle = (on: boolean): string =>
  `position:absolute;top:2px;left:${on ? "17px" : "2px"};width:15px;height:15px;border-radius:50%;background:${on ? "var(--accent-fg)" : "var(--fg-40)"};transition:left .15s ease,background .15s ease;display:block`;
/** THE on/off switch (a `role="switch"` button): Settings' notification toggles, a connection's organizations
 *  and Org settings › AI. `label` names it when no visible label is bound to it; `busy` holds it while a
 *  write is out — `aria-disabled`, never `disabled`: a disabled button drops the keyboard's focus to <body> the
 *  moment Space or Enter toggles it (the caller's own guard refuses a second press). Without either the markup
 *  is unchanged. */
export const switchBtn = (act: string, arg: string | null, on: boolean, label?: string, busy = false): string =>
  `<button data-act="${act}"${arg ? ` data-arg="${attr(arg)}"` : ""} role="switch" aria-checked="${on ? "true" : "false"}"${label ? ` aria-label="${attr(label)}"` : ""}${busy ? ' aria-disabled="true" aria-busy="true"' : ""} style="${trackStyle(on)}"><span style="${knobStyle(on)}"></span></button>`;

const INPUT = `height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;${LABEL};outline:none`;
const ACCENT_BTN = `padding:0 18px;height:40px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600`;
const GHOST_BTN = `height:40px;border-radius:9px;border:1px solid var(--border-strong);font-size:13px;font-weight:500`;
const SECTION_LABEL = `font-size:11px;font-weight:600;${LABEL};text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px`;

// ── Settings › Email notifications ───────────────────────────────────────────

export interface NotifSettingsProps {
  prefs: PrefsView | null;
  loading: boolean;
  error: string | null;
  emailEditing: boolean;
  emailDraft: string;
}

// One tile, hairline-separated rows (address / unsubscribe / one per kind) — no
// cards inside the card.
const TILE_ROW = "padding:14px 0;border-top:1px solid var(--border)";

function emailRow(p: NotifSettingsProps, email: string | null): string {
  if (email === null) {
    return `<div style="${TILE_ROW}">
      <div style="font-size:13.5px;font-weight:600">No email on file</div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px;line-height:1.55">The digests below stay configured, but nothing sends until an address is on file.</div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <input data-act="setEmailDraft" data-field="emailDraft" value="${attr(p.emailDraft)}" placeholder="you@example.com" class="cnpy-input" style="flex:1;min-width:0;${INPUT}" />
        <button data-act="emailSave" class="cnpy-accentbtn" style="${ACCENT_BTN}">Save address</button>
      </div>
    </div>`;
  }
  const inner = p.emailEditing
    ? `<div>
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Digest address</label>
        <div style="display:flex;gap:10px">
          <input data-act="setEmailDraft" data-field="emailDraft" value="${attr(p.emailDraft)}" class="cnpy-input" style="flex:1;min-width:0;${INPUT}" />
          <button data-act="emailSave" class="cnpy-accentbtn" style="${ACCENT_BTN}">Save</button>
          <button data-act="emailCancel" class="cnpy-ghostbtn" style="padding:0 14px;${GHOST_BTN}">Cancel</button>
        </div>
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Save empty to remove the address and pause digests.</div>
      </div>`
    : `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
        <div style="min-width:0">
          <div style="font-size:13.5px;font-weight:500">Digest address</div>
          <div style="font-size:13px;color:var(--fg-70);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(email)}</div>
        </div>
        <button data-act="emailStartEdit" class="cnpy-ghostbtn" style="flex:none;padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500">Edit</button>
      </div>`;
  return `<div style="${TILE_ROW}">${inner}</div>`;
}

function kindRow(k: PrefsView["kinds"][number]): string {
  const segs = segmented({
    id: `cadence-${k.id}`, ariaLabel: `${k.label} cadence`, act: "setKindCadence", value: k.cadence, size: "sm",
    options: k.allowedCadences.map((c) => ({ value: c, label: cadCap(c), arg: `${k.id}:${c}` })),
  });
  const marker = k.inherited
    ? `<span data-mtip="Your organization's setting. Pick another cadence to set your own." style="font-size:12px;color:var(--fg-40);white-space:nowrap">Org default</span>`
    : `<button data-act="resetKind" data-arg="${attr(k.id)}" style="font-size:11.5px;font-weight:500;color:var(--accent);text-decoration:underline;text-underline-offset:3px;padding:0">Reset to default</button>`;
  return `<div style="display:flex;align-items:center;gap:18px;${TILE_ROW}">
    <div style="flex:1;min-width:0">
      <div style="font-size:13.5px;font-weight:500">${esc(k.label)}</div>
      <div style="font-size:12px;color:var(--fg-55);margin-top:3px;line-height:1.5">${esc(k.description)}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap-reverse;gap:7px 12px;flex:none;max-width:60%">
      ${marker}
      ${segs}
    </div>
  </div>`;
}

export function emailNotificationsSection(p: NotifSettingsProps): string {
  const head = `<div style="${SECTION_LABEL}">Email notifications</div>`;
  if (!p.prefs && p.loading) {
    // The tile's own rows: the address, the all-off switch, then the digests.
    const row = (i: number) => `<div style="${TILE_ROW};display:flex;align-items:flex-start;justify-content:space-between;gap:16px"><span class="cnpy-skcol">${skLine(skW(i, ["34%", "46%", "28%", "40%"]), 13.5, 1.4)}<span style="display:block;margin-top:3px">${skLine(skW(i + 1, ["72%", "58%", "66%"]), 12, 1.5)}</span></span>${skBox(i < 2 ? 38 : 150, i < 2 ? 22 : 28)}</div>`;
    return `<section class="cnpy-tile cnpy-surface cnpy-set-email">${head}${skeleton("email-prefs", "Loading email settings&hellip;", `<div class="cnpy-set-pairs">${skList(4, row)}</div>`)}</section>`;
  }
  if (!p.prefs) {
    const body = p.loading
      ? `Loading email settings&hellip;`
      : `Couldn't load email settings${p.error ? ` &mdash; ${esc(p.error)}` : ""}.`;
    return `<section class="cnpy-tile cnpy-surface cnpy-set-email">${head}<div style="${TILE_ROW};font-size:12.5px;color:var(--fg-40)">${body}</div></section>`;
  }
  const v = p.prefs;
  const rows = v.kinds.map(kindRow).join("");
  const listStyle = `opacity:${v.unsubscribed ? ".45" : "1"};pointer-events:${v.unsubscribed ? "none" : "auto"};transition:opacity .15s ease`;
  // Two columns inside once the tile is wide enough: address beside the all-off switch, then
  // the kinds two-up — half the height of one long list. trov.css folds it to one column
  // by the TILE's own width, since it sits in Settings' wide column, not across the page.
  return `<section class="cnpy-tile cnpy-surface cnpy-set-email">
    ${head}
    <div class="cnpy-set-pairs">
      ${emailRow(p, v.email)}
      <div style="${TILE_ROW};display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div style="min-width:0">
          <div style="font-size:13.5px;font-weight:600">Unsubscribe from Trov email</div>
          <div data-unsub-scope style="font-size:12px;color:var(--fg-55);margin-top:3px;line-height:1.5">${esc(UNSUBSCRIBE_STOPS)} ${esc(STILL_SENT_SENTENCE)}</div>
        </div>
        ${switchBtn("toggleAllOff", null, v.unsubscribed)}
      </div>
    </div>
    <div data-only-needed-row="${v.unsubscribed ? "unsubscribed" : "on"}" style="${TILE_ROW};display:flex;align-items:flex-start;justify-content:space-between;gap:16px;${listStyle}">
      <div style="min-width:0">
        <div style="font-size:13.5px;font-weight:500">Only when something needs me</div>
        <div data-only-needed style="font-size:12px;color:var(--fg-55);margin-top:3px;line-height:1.5">Send the daily digest only when your brief has something next for you, or something notable or breaking touched your work. The weekly always comes.</div>
        ${v.unsubscribed ? `<div id="only-needed-why" data-only-needed-why style="font-size:12px;color:var(--fg-70);margin-top:3px;line-height:1.5">Not in use while you're unsubscribed from Trov email.</div>` : ""}
      </div>
      ${v.unsubscribed
        // Dimmed with its reason, never hidden (owner ruling Q46): it keeps its place and its state; `aria-disabled`
        // (focus stays), and main.ts refuses the toggle.
        ? switchBtn("toggleOnlyWhenNeeded", null, v.onlyWhenNeeded, "Only when something needs me").replace("<button ", '<button aria-disabled="true" aria-describedby="only-needed-why" ')
        : switchBtn("toggleOnlyWhenNeeded", null, v.onlyWhenNeeded, "Only when something needs me")}
    </div>
    <div class="cnpy-set-pairs" style="${listStyle}">${rows ||`<div style="${TILE_ROW};font-size:12.5px;color:var(--fg-40)">No digests are enabled org-wide right now.</div>`}</div>
    <div style="padding-top:12px;border-top:1px solid var(--border)">
      <div style="font-size:11.5px;color:var(--fg-40);line-height:1.5">Digests send once per window, at the org's send hour. Cadence options vary per digest. Kinds turned off org-wide don't appear here at all. The Unsubscribe link at the bottom of every digest works without signing in.</div>
    </div>
  </section>`;
}

// (The email's Unsubscribe link opens a page the Worker serves, `/u/<token>` — src/notifications/
// unsubscribe-page.ts — not a screen of this app: it needs no sign-in, and a GET of it changes nothing.)

// ── Org settings › Notifications (admin) ─────────────────────────────────────

export interface NotifAdminProps {
  policy: PolicyKindView[];
  settings: NotificationSettingsRow | null;
  outbox: NotificationOutboxRow[];
  /** The outbox's first read is still out: its rows are a skeleton, never "No sends yet" (and no count). */
  outboxLoading?: boolean;
  outboxExpanded: string | null;
  /** Live text of the sender-NAME input while being edited; null = show the stored name. */
  fromDraft: string | null;
  /** Why the typed sender name was not saved (shared/sender.ts), under the field. */
  fromError?: string | null;
  /** Which dropdown is open (dropdown.ts). Omitted = none. */
  dd?: DropdownUi;
}

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "UTC", "Europe/London", "Europe/Berlin", "Asia/Tokyo"];

/** A digest's default cadence: the cadences it allows, never "off" (its switch says that). */
const cadenceDropdown = (k: PolicyKindView): DropdownProps => ({
  id: `policy-cad-${k.id}`, act: "policyCadence", arg: k.id, value: k.default_cadence, ariaLabel: `${k.label}: default cadence`, size: "sm", disabled: !k.enabled,
  options: k.allowedCadences.filter((c) => c !== "off").map((c) => ({ value: c, label: cadCap(c) })),
});
/** The schedule's two pickers: the hour digests go out at, and the timezone that hour is in. */
function scheduleDropdowns(s: NotificationSettingsRow | null): { hour: DropdownProps; tz: DropdownProps } {
  const tzList = s && !TIMEZONES.includes(s.timezone) ? [s.timezone, ...TIMEZONES] : TIMEZONES;
  return {
    hour: { id: "sched-hour", act: "schedHour", value: s ? String(s.send_hour) : "", labelledBy: "sched-hour-l", fill: true, disabled: !s, options: Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` })) },
    tz: { id: "sched-tz", act: "schedTz", value: s?.timezone ?? "", labelledBy: "sched-tz-l", fill: true, disabled: !s, options: tzList.map((tz) => ({ value: tz, label: tz })) },
  };
}
/** Every dropdown the admin sections render (Org settings renders the open one's menu from these). */
export function notifDropdowns(p: Pick<NotifAdminProps, "policy" | "settings">): DropdownProps[] {
  const sched = scheduleDropdowns(p.settings);
  return [...p.policy.map(cadenceDropdown), sched.hour, sched.tz];
}

/** One digest as a tile of the Digests grid: the name on the left, its default cadence and its
 *  org-wide switch together on the right, and what it carries underneath. */
function policyRow(k: PolicyKindView, dd: DropdownUi): string {
  return `<div${surface("padding:16px;display:flex;flex-direction:column;gap:6px;min-width:0", { cls: "cnpy-digest" })} data-digest="${attr(k.id)}">
    <div style="display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap">
      <div style="flex:1 1 120px;min-width:0;font-size:13.5px;font-weight:600;overflow-wrap:anywhere;color:${k.enabled ? "var(--fg)" : "var(--fg-55)"}">${esc(k.label)}</div>
      <div style="display:flex;align-items:center;gap:12px;flex:none">
        ${dropdown(cadenceDropdown(k), dd)}
        ${switchBtn("policyToggle", k.id, k.enabled).replace("<button ", `<button aria-label="${attr(`${k.label}: send org-wide`)}" `)}
      </div>
    </div>
    <div style="font-size:12px;line-height:1.5;color:var(--fg-40)">${esc(k.description)}</div>
  </div>`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

const OUTBOX_GRID = "display:grid;grid-template-columns:1.1fr .6fr 1fr .9fr .9fr;gap:12px;align-items:center;padding:10px 16px";
function outboxRow(o: NotificationOutboxRow, expanded: boolean): string {
  const failed = o.status === "failed";
  const status = o.status === "sent" ? kindMark("Sent", "good") : failed ? kindMark("Failed", "bad", 12, "It was not sent. Open the row to see why.") : kindMark(o.status === "pending" ? "Queued" : o.status, "waiting");
  const cells = `<div style="font-size:12.5px;font-weight:500;color:var(--fg-70);min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(o.user_id)}</div>
    <div style="font-size:12.5px;color:var(--fg-55)">${esc(o.cadence)}</div>
    <div style="font-size:12px;color:var(--fg-55)">${esc(o.window_id)}</div>
    <div style="display:inline-flex;align-items:center;gap:6px" data-status="${attr(o.status)}">${status}${failed ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true" style="transform:${expanded ? "rotate(180deg)" : "none"};transition:transform .15s ease;flex:none;color:var(--fg-40)"><path d="m6 9 6 6 6-6"></path></svg>` : ""}</div>
    <div style="font-size:12px;color:var(--fg-40);text-align:right">${esc(o.status === "pending" ? "queued" : fmtWhen(o.sent_at ?? o.created_at))}</div>`;
  const row = failed
    ? `<button type="button" data-act="outboxToggle" data-arg="${attr(o.idempotency_key)}" aria-expanded="${expanded}" class="cnpy-hoverrow" style="${OUTBOX_GRID};width:100%;box-sizing:border-box;text-align:left">${cells}</button>`
    : `<div style="${OUTBOX_GRID}">${cells}</div>`;
  const detail = failed && expanded
    ? `<div style="margin:0 16px 12px;border:1px solid color-mix(in srgb,var(--red) 40%,transparent);background:color-mix(in srgb,var(--red) 7%,transparent);border-radius:8px;padding:9px 11px">
        <div style="font-size:12.5px;line-height:1.55;color:var(--fg);overflow-wrap:anywhere">${esc(o.error ?? "failed")}</div>
        <div style="font-size:11.5px;color:var(--fg-55);margin-top:4px">Retried hourly for 48 hours, then left as is. The next window sends normally once the cause is fixed.</div>
      </div>`
    : "";
  return `<div style="border-bottom:1px solid var(--border);margin-bottom:-1px">${row}${detail}</div>`;
}

const FIELD_LABEL = `display:block;${O_LABEL};margin-bottom:7px`;
const linkBtn = (text: string, href: string): string =>
  `<a href="${attr(href)}" target="_blank" rel="noopener" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;height:32px;padding:0 13px;border-radius:8px;border:1px solid var(--border);font-size:12.5px;font-weight:500;color:var(--fg-70);text-decoration:none;white-space:nowrap;box-sizing:border-box">${esc(text)}</a>`;

/** Org settings › Notifications: the lead (how many digests are on, when and as whom they
 *  send, what failed), then four sections in the page's one idiom — Digests, Schedule and
 *  sender, Preview and test, Outbox. */
export function notificationsAdminSections(p: NotifAdminProps): string {
  const dd = p.dd ?? initialDropdownUi();
  const enabled = p.policy.filter((k) => k.enabled).length;
  const s = p.settings;
  const failed = p.outbox.filter((o) => o.status === "failed").length;
  const sender = p.fromDraft ?? (s ? senderNamePart(s.from_address) : PLATFORM_SENDER_NAME);
  const lead = tabLead(`${p.policy.length ? `<strong>${enabled} of ${p.policy.length}</strong> digests on` : "Loading the digests…"}${s ? ` &middot; sent at <strong>${String(s.send_hour).padStart(2, "0")}:00</strong> ${esc(s.timezone)} as <strong>${esc(senderNamePart(s.from_address))}</strong>` : ""}${failed ? ` &middot; <span data-outbox-failed style="color:var(--red);font-weight:500">${failed} recent ${failed === 1 ? "send" : "sends"} failed</span>` : ""}. Each person picks their own cadence in Settings.`);

  const policy = p.policy.length
    ? `<div class="cnpy-digests">${p.policy.map((k) => policyRow(k, dd)).join("")}</div>`
    : skRows("notif-policy", "Loading policy…", 4, { trail: 150 });

  const sched = scheduleDropdowns(s);
  const schedule = `<div${surface("padding:16px")}>
    <div class="cnpy-sched" style="display:grid;grid-template-columns:140px 230px minmax(0,1fr);gap:16px">
      <div>
        <div id="sched-hour-l" style="${FIELD_LABEL}">Send hour</div>
        ${dropdown(sched.hour, dd)}
      </div>
      <div>
        <div id="sched-tz-l" style="${FIELD_LABEL}">Timezone</div>
        ${dropdown(sched.tz, dd)}
      </div>
      <div>
        <label for="sched-from" style="${FIELD_LABEL}">Sender name</label>
        <input id="sched-from" data-act="schedFrom" data-field="schedFrom" data-commit="1" maxlength="${SENDER_NAME_MAX}" autocomplete="off" spellcheck="false" value="${attr(p.fromDraft ?? (s ? senderNamePart(s.from_address) : ""))}"${s ? "" : " disabled"}${p.fromError ? ' aria-invalid="true"' : ""} aria-describedby="sched-from-h" title="Letters, digits, spaces and . &amp; ' + _ - , up to ${SENDER_NAME_MAX} characters. Saves when you leave the field." class="cnpy-input" style="width:100%;box-sizing:border-box;height:36px;padding:0 12px;border:1px solid ${p.fromError ? "var(--red)" : "var(--border-strong)"};border-radius:8px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--sans);outline:none" />
        <div id="sched-from-h" data-sender-address style="${O_HELP};overflow-wrap:anywhere">Sent from <span style="color:var(--fg-70)">${esc(sender)} &lt;${PLATFORM_FROM_ADDRESS}&gt;</span>. The address is Trov's and can't be changed.</div>
        ${p.fromError ? `<div role="alert" data-sender-error style="font-size:11.5px;line-height:1.5;color:var(--red);margin-top:4px">${esc(p.fromError)}</div>` : ""}
      </div>
    </div>
  </div>`;

  const tryIt = `<div${surface("overflow:hidden")}>
    <div class="cnpy-org-row" style="align-items:center">
      <div style="flex:1 1 240px;min-width:0"><div style="font-size:13.5px;font-weight:600">Preview</div><div style="font-size:12px;color:var(--fg-40);margin-top:1px">Your own digest in a new tab, with live data. Your preferences are ignored.</div></div>
      <div class="cnpy-org-actions" style="align-items:center">${linkBtn("Daily", tenantHref("/api/notifications/preview?cadence=daily"))}${linkBtn("Weekly", tenantHref("/api/notifications/preview?cadence=weekly"))}${linkBtn("Sample data", tenantHref("/api/notifications/preview?sample=index"))}</div>
    </div>
    <div class="cnpy-org-row" style="align-items:center">
      <div style="flex:1 1 240px;min-width:0"><div style="font-size:13.5px;font-weight:600">Send a test to me</div><div style="font-size:12px;color:var(--fg-40);margin-top:1px">Through the real delivery path, to your address; it appears in the outbox. With nothing new it sends sample data.</div></div>
      <div class="cnpy-org-actions" style="align-items:center">${quietBtn("Daily", "testSend", { arg: "daily", label: "Send me a test of the daily digest" })}${quietBtn("Weekly", "testSend", { arg: "weekly", label: "Send me a test of the weekly digest" })}</div>
    </div>
  </div>`;

  // `.cnpy-hscroll`: at phone width the five columns keep their room and scroll sideways.
  const outbox = p.outbox.length
    ? `<div${surface("overflow:hidden")}><div class="cnpy-hscroll"><div><div style="${OUTBOX_GRID};padding-top:11px;padding-bottom:8px;border-bottom:1px solid var(--border);${O_LABEL};font-size:10px">
        <div>User</div><div>Cadence</div><div>Window</div><div>Status</div><div style="text-align:right">At</div>
      </div>` + p.outbox.map((o) => outboxRow(o, p.outboxExpanded === o.idempotency_key)).join("") + `</div></div></div>`
    : p.outboxLoading ? skRows("notif-outbox", "Loading the outbox…", 3, { trail: 90 })
    : orgEmpty("No sends yet", "Runs appear here after the first scheduled window.", "", 2);

  return `${lead}
    ${orgHead("Digests", "Turning one off removes it from everyone's Settings", null)}
    ${policy}
    ${orgHead("Schedule and sender", "One send per person per window, on the hour; an empty window is skipped")}
    ${schedule}
    ${orgHead("Preview and test")}
    ${tryIt}
    ${orgHead("Outbox", "Newest first", p.outboxLoading && !p.outbox.length ? null : p.outbox.length)}
    ${outbox}`;
}
