// Email-notification surfaces (canopy-email.md §8), componentized from
// Canopy.dc.html: Settings › Email notifications, Maintenance › NOTIFICATIONS
// (policy / schedule / outbox), and the unsubscribe confirmation view. Pure
// presentational functions over props — no fetch, no state.
import { trovMark } from "@shared/mark";
import type { Cadence, PrefsView, PolicyKindView } from "@shared/notifications";
import type { NotificationOutboxRow, NotificationSettingsRow } from "@shared/rows";
import { esc, attr, surface } from "./ui";
import { maintSectionHeader, maintEmpty } from "./maintenance";
import { segmented } from "./segmented";

const LABEL = "font-family:var(--label)";
const cadCap = (c: Cadence): string => (c === "off" ? "Off" : c.charAt(0).toUpperCase() + c.slice(1));
const trackStyle = (on: boolean): string =>
  `width:36px;height:21px;border-radius:999px;border:1px solid ${on ? "var(--accent)" : "var(--border-strong)"};background:${on ? "var(--accent)" : "transparent"};position:relative;flex:none;padding:0;transition:all .15s ease;display:inline-block`;
const knobStyle = (on: boolean): string =>
  `position:absolute;top:2px;left:${on ? "17px" : "2px"};width:15px;height:15px;border-radius:50%;background:${on ? "var(--accent-fg)" : "var(--fg-40)"};transition:left .15s ease,background .15s ease;display:block`;
const switchBtn = (act: string, arg: string | null, on: boolean): string =>
  `<button data-act="${act}"${arg ? ` data-arg="${attr(arg)}"` : ""} role="switch" aria-checked="${on ? "true" : "false"}" style="${trackStyle(on)}"><span style="${knobStyle(on)}"></span></button>`;

const CHEVRON_BG = `var(--bg) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23888' stroke-width='2'><path d='M2 4l4 4 4-4'/></svg>\") no-repeat right 9px center`;
const SELECT = `appearance:none;-webkit-appearance:none;padding:5px 28px 5px 11px;border-radius:7px;font-size:12.5px;font-weight:500;border:1px solid var(--border);color:var(--fg-70);background:${CHEVRON_BG};cursor:pointer`;
const FORM_SELECT = `appearance:none;-webkit-appearance:none;width:100%;height:36px;padding:0 30px 0 12px;border-radius:8px;font-size:12.5px;font-weight:500;${LABEL};border:1px solid var(--border-strong);color:var(--fg);background:${CHEVRON_BG};cursor:pointer`;
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
        <input data-act="setEmailDraft" data-field="emailDraft" value="${attr(p.emailDraft)}" placeholder="you@sapling.dev" class="cnpy-input" style="flex:1;min-width:0;${INPUT}" />
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
    ? `<span style="font-size:10px;font-weight:600;${LABEL};letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">ORG DEFAULT</span>`
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
          <div style="font-size:13.5px;font-weight:600">Unsubscribe from all email</div>
          <div style="font-size:12px;color:var(--fg-55);margin-top:3px;line-height:1.5">Overrides every digest below &mdash; nothing of any kind sends while this is on.</div>
        </div>
        ${switchBtn("toggleAllOff", null, v.unsubscribed)}
      </div>
    </div>
    <div class="cnpy-set-pairs" style="${listStyle}">${rows || `<div style="${TILE_ROW};font-size:12.5px;color:var(--fg-40)">No digests are enabled org-wide right now.</div>`}</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding-top:12px;border-top:1px solid var(--border)">
      <div style="font-size:11.5px;color:var(--fg-40);line-height:1.5">Digests send once per window, at the org's send hour. Cadence options vary per digest. Kinds turned off org-wide don't appear here at all.</div>
      <button data-act="previewUnsub" style="flex:none;font-size:11.5px;color:var(--fg-40);text-decoration:underline;text-underline-offset:3px">Preview the unsubscribe page</button>
    </div>
  </section>`;
}

// ── Unsubscribe confirmation (full-screen, no chrome) ────────────────────────

export function unsubscribeView(p: { email: string | null; pending: boolean; error: string | null }): string {
  const title = p.pending ? "Turning email off&hellip;" : p.error ? "Couldn't turn email off." : "Email is off.";
  const sub = p.pending
    ? "One moment."
    : p.error
    ? esc(p.error)
    : `No more digests will be sent${p.email ? ` to <span style="font-weight:500">${esc(p.email)}</span>` : ""}. Nothing else about your account changed.`;
  return `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;background:var(--bg);color:var(--fg)">
    <div style="width:400px;max-width:100%">
      <div style="display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:36px">
        ${trovMark(26)}
        <span style="font-size:22px;font-weight:600;letter-spacing:-0.02em">Trov</span>
      </div>
      <div${surface("padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center")}>
        <div class="cnpy-seal" style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--accent)">
          ${p.pending ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="animation:cnpy-spin .8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>` : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"></path></svg>`}
        </div>
        <div>
          <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">${title}</div>
          <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">${sub}</div>
        </div>
        <button data-act="unsubGoSettings" class="cnpy-accentbtn" style="width:100%;padding:12px 16px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600">Go to Settings</button>
      </div>
      <div style="text-align:center;margin-top:22px;font-size:12.5px;color:var(--fg-40);line-height:1.5">Turn email back on any time in Settings.</div>
    </div>
  </div>`;
}

// ── Maintenance › NOTIFICATIONS ──────────────────────────────────────────────

export interface NotifMaintenanceProps {
  policy: PolicyKindView[];
  settings: NotificationSettingsRow | null;
  outbox: NotificationOutboxRow[];
  outboxExpanded: string | null;
  /** Live text of the from-address input while being edited; null = show the stored value. */
  fromDraft: string | null;
}

const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "UTC", "Europe/London", "Europe/Berlin", "Asia/Tokyo"];

function policyRow(k: PolicyKindView): string {
  const nonOff = k.allowedCadences.filter((c) => c !== "off");
  const opts = nonOff.map((c) => `<option value="${c}"${c === k.default_cadence ? " selected" : ""}>${cadCap(c)}</option>`).join("");
  return `<div style="display:flex;align-items:center;gap:20px;padding:15px 0;border-bottom:1px solid var(--border)">
    ${switchBtn("policyToggle", k.id, k.enabled)}
    <div style="flex:1;min-width:0">
      <div style="font-size:13.5px;font-weight:500;color:${k.enabled ? "var(--fg)" : "var(--fg-55)"}">${esc(k.label)}</div>
      <div style="font-size:12px;color:var(--fg-55);margin-top:2px">${esc(k.description)}</div>
    </div>
    <select data-act="policyCadence" data-arg="${attr(k.id)}"${k.enabled ? "" : " disabled"} style="${SELECT}${k.enabled ? "" : ";opacity:.4;pointer-events:none"}">${opts}</select>
  </div>`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function outboxRow(o: NotificationOutboxRow, expanded: boolean): string {
  const failed = o.status === "failed";
  const statusStyle = `font-size:12.5px;font-weight:${failed ? 600 : 500};color:${o.status === "sent" ? "var(--accent)" : failed ? "var(--fg)" : "var(--fg-55)"};display:inline-flex;align-items:center;gap:6px`;
  const cells = `<div style="${LABEL};font-size:12.5px;color:var(--fg-70)">${esc(o.user_id)}</div>
    <div style="font-size:12.5px;color:var(--fg-55)">${esc(o.cadence)}</div>
    <div style="${LABEL};font-size:12px;color:var(--fg-55)">${esc(o.window_id)}</div>
    <div style="${statusStyle}">${esc(o.status)}${failed ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="transform:${expanded ? "rotate(180deg)" : "none"};transition:transform .15s ease;flex:none;color:var(--fg-40)"><path d="m6 9 6 6 6-6"></path></svg>` : ""}</div>
    <div style="font-size:12px;color:var(--fg-55);text-align:right">${esc(o.status === "pending" ? "queued" : fmtWhen(o.sent_at ?? o.created_at))}</div>`;
  const grid = "display:grid;grid-template-columns:1.1fr .6fr 1fr .9fr .9fr;gap:12px;align-items:center;padding:11px 0";
  const row = failed
    ? `<button data-act="outboxToggle" data-arg="${attr(o.idempotency_key)}" class="cnpy-hoverrow" style="${grid};width:100%;text-align:left">${cells}</button>`
    : `<div style="${grid}">${cells}</div>`;
  const detail = failed && expanded
    ? `<div style="margin:2px 0 14px;border:1px solid var(--border-strong);border-radius:9px;padding:12px 14px">
        <div style="${LABEL};font-size:12px;line-height:1.7;color:var(--fg)">${esc(o.error ?? "failed")}</div>
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:6px">Retried hourly for 48 hours, then left as is. The next window sends normally once the cause is fixed.</div>
      </div>`
    : "";
  return `<div style="border-bottom:1px solid var(--border)">${row}${detail}</div>`;
}

export function notificationsMaintenanceSections(p: NotifMaintenanceProps): string {
  const enabled = p.policy.filter((k) => k.enabled).length;
  const policy = p.policy.length
    ? p.policy.map(policyRow).join("") +
      `<div style="font-size:11.5px;color:var(--fg-40);margin-top:10px">Turning a kind off removes it from every member's Settings &mdash; rows there are absent, never greyed.</div>`
    : maintEmpty("Loading policy…", "");

  const s = p.settings;
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${s && s.send_hour === h ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");
  const tzList = s && !TIMEZONES.includes(s.timezone) ? [s.timezone, ...TIMEZONES] : TIMEZONES;
  const tzs = tzList.map((tz) => `<option value="${attr(tz)}"${s && s.timezone === tz ? " selected" : ""}>${esc(tz)}</option>`).join("");
  const schedule = `<div class="cnpy-sched" style="display:grid;grid-template-columns:140px 230px minmax(0,1fr);gap:16px;padding:18px 0;border-bottom:1px solid var(--border)">
    <div>
      <div style="${LABEL};font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);margin-bottom:8px">SEND HOUR</div>
      <select data-act="schedHour" style="${FORM_SELECT}"${s ? "" : " disabled"}>${hours}</select>
    </div>
    <div>
      <div style="${LABEL};font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);margin-bottom:8px">TIMEZONE</div>
      <select data-act="schedTz" style="${FORM_SELECT}"${s ? "" : " disabled"}>${tzs}</select>
    </div>
    <div>
      <div style="${LABEL};font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);margin-bottom:8px">FROM ADDRESS</div>
      <input data-act="schedFrom" data-field="schedFrom" data-commit="1" value="${attr(p.fromDraft ?? s?.from_address ?? "")}"${s ? "" : " disabled"} style="width:100%;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:12.5px;${LABEL};outline:none" />
    </div>
  </div>
  <div style="font-size:11.5px;color:var(--fg-40);margin-top:10px">Digests assemble on the hour. A window with nothing to say is skipped, not sent empty. The from address saves when you leave the field.</div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:16px">
    <span style="${LABEL};font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--fg-40)">PREVIEW</span>
    <a href="/api/notifications/preview?cadence=daily" target="_blank" rel="noopener" class="cnpy-ghostbtn" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg);text-decoration:none">Daily</a>
    <a href="/api/notifications/preview?cadence=weekly" target="_blank" rel="noopener" class="cnpy-ghostbtn" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12px;font-weight:500;color:var(--fg);text-decoration:none">Weekly</a>
    <a href="/api/notifications/preview?cadence=daily&amp;sample=1" target="_blank" rel="noopener" class="cnpy-ghostbtn" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);font-size:12px;font-weight:500;color:var(--fg-55);text-decoration:none">Sample data</a>
    <span style="width:1px;height:18px;background:var(--border)"></span>
    <span style="${LABEL};font-size:10.5px;font-weight:600;letter-spacing:.08em;color:var(--fg-40)">SEND TEST TO ME</span>
    <button data-act="testSend" data-arg="daily" class="cnpy-accentbtn" style="padding:6px 12px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:600">Daily</button>
    <button data-act="testSend" data-arg="weekly" class="cnpy-accentbtn" style="padding:6px 12px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:600">Weekly</button>
  </div>
  <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Preview renders your own digest with live data (prefs ignored). A test send goes to your address through the real delivery path and shows up in the outbox below; when nothing has changed it falls back to sample data.</div>`;

  // `.cnpy-hscroll`: at phone width the five columns keep their room and scroll sideways.
  const outbox = p.outbox.length
    ? `<div class="cnpy-hscroll"><div><div style="display:grid;grid-template-columns:1.1fr .6fr 1fr .9fr .9fr;gap:12px;padding:10px 0 8px;border-bottom:1px solid var(--border);${LABEL};font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40)">
        <div>USER</div><div>CADENCE</div><div>WINDOW</div><div>STATUS</div><div style="text-align:right">AT</div>
      </div>` + p.outbox.map((o) => outboxRow(o, p.outboxExpanded === o.idempotency_key)).join("") + `</div></div>`
    : maintEmpty("No sends yet", "Runs appear here after the first scheduled window.");

  return `${maintSectionHeader("NOTIFICATIONS · POLICY", "which digests exist org-wide, and their default cadence", `${enabled} of ${p.policy.length} enabled`, false)}
    ${policy}
    ${maintSectionHeader("NOTIFICATIONS · SCHEDULE", "one send per user per window", "", false)}
    ${schedule}
    ${maintSectionHeader("NOTIFICATIONS · OUTBOX", "recent runs, newest first", p.outbox.length ? `${p.outbox.length} run${p.outbox.length === 1 ? "" : "s"}` : "", false)}
    ${outbox}`;
}
