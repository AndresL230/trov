// Maintenance — ported from the Claude Design `Canopy.dc.html` (project 2c8cfa50),
// which split the old single column into three sub-pages under the sidebar entry:
//   UNPLACED  — read a loose thing an agent couldn't place, then file it or discard it
//               (a list on the left, the selected item on the right).
//   IDENTITY  — match an unmapped activity login to a person, or discard one that
//               isn't on the team (an outside contributor; Undo / Restore brings it back).
//   PEOPLE    — everyone with a handle, plus pending invites (admins can invite).
// Empty is the normal state for the first two.
//
// Purely presentational: data arrives through props and renders to HTML strings;
// interactions dispatch via data-act / data-arg handled in main.ts (the same
// assign / discard / map / invite writes the single-column version had).

import { esc, attr, primaryBtn, relTime, surface } from "./ui";
import { personChip, personLink, handleTag } from "./people";
import type { PersonColor, InviteRow } from "@shared/rows";
import type { PersonSummary } from "./api";
import { ROLE_MAX, RESPONSIBILITIES_MAX } from "@shared/people";

// ── prop shapes ──────────────────────────────────────────────────────────────
export interface UnplacedItem {
  id: string;
  title: string;
  snippet: string;
  reason: string; // "AGENT FLAGGED" / "LOW CONFIDENCE"
  meta: string; // e.g. "AndresL230 · 2h ago"
  reasonNote: string;
  /** The handle that produced it (null when the gate recorded none). */
  author?: string | null;
  /** Relative time it landed, e.g. "2h ago". */
  when?: string;
}

export type AssignKind = "doc" | "adr" | "feed";
export type MaintTab = "unplaced" | "identity" | "people";
export const MAINT_TABS: readonly MaintTab[] = ["unplaced", "identity", "people"];

/** The assign flow's REAL vocabulary: the three gate types, and the targets each
 *  accepts (doc → section + optional space; feed → optional multi-select tags;
 *  adr → no target). Values come from @shared/vocabulary via the
 *  mapping layer — components never hardcode them. */
export interface AssignOptions {
  kinds: { key: AssignKind; label: string }[];
  sections: string[];
  spaces: string[];
  tags: string[];
}

export interface ActivitySample { kind: string; text: string; when: string }

export interface IdentityGroup {
  id: string;          // the login — there is no numeric id; also the map route's path param
  login: string;
  meta: string;        // e.g. "first seen 3w ago"
  countLabel: string;
  sample: ActivitySample[];
}

/** A login discarded as not-a-person (an outside contributor); Restore puts it back. */
export interface DiscardedLogin {
  login: string;
  meta: string;        // e.g. "discarded 2h ago by andres"
}

export interface Person { id: string; name: string; initials: string; color?: PersonColor; avatar_url?: string | null }

export interface MaintenanceProps {
  tab: MaintTab;
  unplaced: UnplacedItem[];
  assign: AssignOptions;
  /** The Unplaced item on screen (null = the first). */
  assignOpen: string | null;
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  /** The Discard button was clicked once — the second click discards. */
  discardArm: boolean;
  identity: IdentityGroup[];
  /** Discarded logins, and whether their restore list is open. */
  discarded: DiscardedLogin[];
  showDiscarded: boolean;
  people: Person[];
  mapPicks: Record<string, string>;
  /** Login currently in the map confirm step (two-step guard) — null when none. */
  mapConfirm: string | null;
}

// ── shared atoms ─────────────────────────────────────────────────────────────
const EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

/** The design's pick chip (`V.pickSt`): accent when on, label-face for vocabulary values. */
function pickChip(label: string, on: boolean, act: string, arg: string, mono = false): string {
  const st = `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : "var(--fg-55)"};background:${on ? "var(--accent-soft)" : "transparent"};font-family:${mono ? "var(--label)" : "inherit"}`;
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="${st}">${esc(label)}</button>`;
}

/** A label-face section header with a hint and a count (the admin email-notification
 *  sections under People still use it). */
export function maintSectionHeader(label: string, hint: string, countLabel: string, first: boolean): string {
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:${first ? "38px" : "44px"};padding-bottom:9px;border-bottom:1px solid var(--border-strong)">
    <div style="display:flex;align-items:baseline;gap:10px">
      <div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55)">${esc(label)}</div>
      <div style="font-size:11.5px;color:var(--fg-40)">${esc(hint)}</div>
    </div>
    <div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">${esc(countLabel)}</div>
  </div>`;
}

/** A dashed, centred empty-state card (the normal state for Unplaced and Identity). */
export function maintEmpty(title: string, sub: string): string {
  return `<div style="display:flex;justify-content:center;padding:56px 0"><div style="border:1px dashed var(--border-strong);border-radius:13px;padding:36px 44px;text-align:center;max-width:380px"><div style="font-size:15px;font-weight:600;color:var(--fg-70)">${esc(title)}</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:6px">${esc(sub)}</div></div></div>`;
}

const person = (people: Person[], id: string | null | undefined): Person | null =>
  id ? people.find((p) => p.id.toLowerCase() === id.toLowerCase()) ?? null : null;
/** A Person as the chip helpers take it — null (plain, initials) without a color. */
const chipPerson = (p: Person | null) => (p?.color ? { handle: p.id, name: p.name, color: p.color, avatar_url: p.avatar_url } : null);
const chipOf = (p: Person | null, size: number, fallback: string) => personChip(chipPerson(p), size, fallback);

// ── UNPLACED ─────────────────────────────────────────────────────────────────
/** The "File it as" block: pick what it is, then the real per-type target. */
export function assignPanel(itemId: string, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string {
  const kinds = assign.kinds.map((k) => pickChip(k.label, kind === k.key, "maintAssignKind", k.key)).join("");
  let target = "";
  if (kind === "doc") {
    target = `<div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:18px">
      <div><div style="${EYEBROW};margin-bottom:8px">Section</div><div style="display:flex;gap:6px;flex-wrap:wrap">${assign.sections.map((t) => pickChip(t, section === t, "maintAssignSection", t, true)).join("")}</div></div>
      <div><div style="${EYEBROW};margin-bottom:8px">Space <span style="text-transform:none;letter-spacing:0;font-weight:500">· optional</span></div><div style="display:flex;gap:6px;flex-wrap:wrap">${assign.spaces.map((t) => pickChip(t, space === t, "maintAssignSpace", t, true)).join("")}</div></div>
    </div>`;
  } else if (kind === "feed") {
    target = `<div style="${EYEBROW};margin:18px 0 8px">Tags <span style="text-transform:none;letter-spacing:0;font-weight:500">· optional</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${assign.tags.map((t) => pickChip(t, tags.includes(t), "maintAssignTag", t, true)).join("")}</div>`;
  }
  return `<div data-item="${attr(itemId)}" style="margin-top:26px;padding-top:20px;border-top:1px solid var(--border)">
    <div style="${EYEBROW};margin-bottom:10px">File it as</div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${kinds}</div>
    ${target}
  </div>`;
}

/** The hint beside "File it": what filing will do, or what is still missing. */
export function fileHint(kind: AssignKind | null, section: string | null): string {
  if (!kind) return "Pick what it is first";
  if (kind === "doc") return section ? `Stages a proposal in ${section}` : "Pick a section";
  return kind === "adr" ? "Creates a draft decision in Review" : "Posts it to the feed";
}

/** The Unplaced item on screen: the one `assignOpen` names, else the first. */
export function selectedUnplacedId(items: { id: string }[], assignOpen: string | null): string | null {
  return items.find((u) => u.id === assignOpen)?.id ?? items[0]?.id ?? null;
}

function unplacedTab(p: MaintenanceProps): string {
  if (p.unplaced.length === 0) return maintEmpty("All clear", "Everything an agent produced found its place on its own.");
  const idx = Math.max(0, p.unplaced.findIndex((u) => u.id === p.assignOpen));
  const sel = p.unplaced[idx];
  const list = p.unplaced.map((u) => {
    const au = person(p.people, u.author);
    const on = u.id === sel.id;
    return `<button data-act="maintSelect" data-arg="${attr(u.id)}" class="cnpy-trow" style="display:block;width:100%;text-align:left;padding:13px 16px;border-bottom:1px solid var(--border);background:${on ? "var(--hover)" : "transparent"};transition:background .12s ease">
      <div style="font-size:13px;line-height:1.5;color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(u.title)}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11.5px;color:var(--fg-40);min-width:0;white-space:nowrap;overflow:hidden">${chipOf(au, 16, u.author ?? "?")}${handleTag(au?.color ? { handle: au.id, color: au.color } : null, u.author ?? "unknown", 11)}<span style="flex:none">&middot; ${esc(u.when ?? "")}</span></div>
    </button>`;
  }).join("");

  // The assign picks belong to the item on screen; `assignOpen` names it, or names
  // nothing that is still listed (first load, or the item just filed / discarded).
  const kind = sel.id === selectedUnplacedId(p.unplaced, p.assignOpen) ? p.assignKind : null;
  const section = kind ? p.assignSection : null;
  const canFile = kind !== null && (kind !== "doc" || section !== null);
  const au = person(p.people, sel.author);
  const bigText = sel.title !== sel.snippet && !sel.snippet.startsWith(sel.title.replace(/…$/, ""))
    ? `<div style="font-size:18px;font-weight:500;line-height:1.5;letter-spacing:-0.01em;color:var(--fg);margin-top:16px;text-wrap:pretty">${esc(sel.title)}</div><div style="font-size:13.5px;line-height:1.6;color:var(--fg-70);margin-top:8px">${esc(sel.snippet)}</div>`
    : `<div style="font-size:18px;font-weight:500;line-height:1.5;letter-spacing:-0.01em;color:var(--fg);margin-top:16px;text-wrap:pretty">${esc(sel.snippet)}</div>`;

  return `<div${surface("display:flex;flex-wrap:wrap;overflow:hidden;min-height:440px")}>
    <div class="cnpy-scroll" style="flex:1 1 260px;min-width:0;max-width:100%;box-shadow:1px 0 0 var(--border);overflow-y:auto;overflow-x:hidden;max-height:640px">${list}</div>
    <div style="flex:2 1 380px;min-width:0;display:flex;flex-direction:column;padding:24px 28px;box-shadow:0 -1px 0 var(--border)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--fg-55)">
        <span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-55);border:1px solid var(--border-strong);border-radius:5px;padding:2px 6px;white-space:nowrap">${esc(sel.reason)}</span>
        <span style="display:inline-flex;white-space:nowrap;min-width:0">${personLink(chipPerson(au), sel.author ?? "?", 18, au?.name ?? sel.author ?? "unknown", "min-width:0;overflow:hidden;text-overflow:ellipsis", 6)}</span>
        <span style="color:var(--fg-40);white-space:nowrap">&middot; ${esc(sel.when ?? "")}</span>
        <span style="flex:1"></span>
        <span style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap">${idx + 1} of ${p.unplaced.length}</span>
      </div>
      ${bigText}
      <div style="font-size:12.5px;line-height:1.55;color:var(--fg-40);margin-top:10px"><span style="color:var(--fg-55);font-weight:500">Why it wasn't placed:</span> ${esc(sel.reasonNote)}</div>
      ${assignPanel(sel.id, p.assign, kind, section, kind ? p.assignSpace : null, kind ? p.assignTags : [])}
      <div style="flex:1;min-height:24px"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--border)">
        <button data-act="maintDiscard" data-arg="${attr(sel.id)}" class="cnpy-mutelink" style="font-size:12.5px;font-weight:500;white-space:nowrap;color:${p.discardArm ? "var(--red)" : "var(--fg-55)"}">${p.discardArm ? "Click again to discard" : "Discard"}</button>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--fg-40)">${esc(fileHint(kind, section))}</span>
          ${primaryBtn("File it", canFile, "maintFile", sel.id, "padding:8px 16px")}
        </div>
      </div>
    </div>
  </div>`;
}

// ── IDENTITY ─────────────────────────────────────────────────────────────────
/** "Who is this?": pick a person, see the concrete effect, then confirm. */
export function personPicker(groupId: string, people: Person[], pick: string | null, confirming: boolean): string {
  const chips = people.map((pp) => {
    const on = pick === pp.id;
    const st = `white-space:nowrap;display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:7px;font-size:12.5px;font-weight:500;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : "var(--fg-55)"};background:${on ? "var(--accent-soft)" : "transparent"}`;
    return `<button data-act="identityPick" data-arg="${attr(`${groupId}:${pp.id}`)}" class="cnpy-pickchip" style="${st}">${chipOf(pp, 18, pp.id)}${esc(pp.name)}</button>`;
  }).join("");
  const pickedName = pick !== null ? (people.find((x) => x.id === pick)?.name ?? pick) : null;
  const confirmNote = confirming && pickedName !== null
    ? `<div style="border:1px solid var(--amber);border-radius:8px;padding:9px 11px;margin-top:12px;font-size:12px;line-height:1.5;color:var(--fg-70)">${esc(groupId)}'s activity will show as ${esc(pickedName)}'s, past and future.</div>`
    : "";
  return `<div style="${EYEBROW};margin-bottom:8px">Who is this?</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${chips}</div>
    ${confirmNote}
    <div style="display:flex;align-items:center;gap:14px;margin-top:12px">
      ${primaryBtn(confirming && pick !== null ? "Confirm mapping" : "Map login", pick !== null, "identityMap", groupId, "padding:8px 16px")}
      ${confirming && pick !== null ? `<button data-act="identityCancel" data-arg="${attr(groupId)}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-55)">Cancel</button>` : ""}
      <span style="flex:1"></span>
      <button data-act="identityDiscard" data-arg="${attr(groupId)}" class="cnpy-mutelink" title="Not on the team — stop listing this login" style="font-size:12.5px;font-weight:500;white-space:nowrap;color:var(--fg-55)">Discard</button>
    </div>`;
}

/** The quiet "N discarded" line under the list, and (opened) each discarded login with Restore. */
export function discardedLogins(items: DiscardedLogin[], open: boolean): string {
  if (items.length === 0) return "";
  const rows = open
    ? `<div${surface("overflow:hidden;margin-top:10px")}>${items.map((d) => `<div style="display:flex;align-items:baseline;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px">
        <span style="font-family:var(--label);font-size:13px;font-weight:600;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(d.login)}</span>
        <span style="flex:1;font-size:11.5px;color:var(--fg-40);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.meta)}</span>
        <button data-act="identityRestore" data-arg="${attr(d.login)}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;white-space:nowrap;color:var(--fg-55)">Restore</button>
      </div>`).join("")}</div>`
    : "";
  return `<div style="margin-top:14px">
    <button data-act="identityToggleDiscarded" aria-expanded="${open ? "true" : "false"}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-40)">${items.length} discarded &middot; ${open ? "Hide" : "Show"}</button>
    ${rows}
  </div>`;
}

/** One unmatched login: the activity sample that identifies the person, beside the picker. */
export function identityCard(g: IdentityGroup, people: Person[], pick: string | null, confirming: boolean): string {
  const sample = g.sample.map((ev) => `<div style="display:flex;align-items:baseline;gap:9px;min-width:0"><span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px;flex:none">${esc(ev.kind)}</span><span style="font-size:12.5px;color:var(--fg-70);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ev.text)}</span><span style="font-size:11px;color:var(--fg-40);flex:none;white-space:nowrap">${esc(ev.when)}</span></div>`).join("");
  return `<div style="display:flex;flex-wrap:wrap;gap:20px 36px;padding:20px 22px;border-bottom:1px solid var(--border);margin-bottom:-1px">
    <div style="flex:1 1 280px;min-width:0">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><div style="font-family:var(--label);font-size:15px;font-weight:600;color:var(--fg);white-space:nowrap">${esc(g.login)}</div><div style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(g.meta)}</div></div>
      <div style="display:flex;flex-direction:column;gap:7px;margin-top:12px">${sample}</div>
    </div>
    <div style="flex:1 1 380px;min-width:0">${personPicker(g.id, people, pick, confirming)}</div>
  </div>`;
}

function identityTab(p: MaintenanceProps): string {
  const discarded = discardedLogins(p.discarded, p.showDiscarded);
  if (p.identity.length === 0) return maintEmpty("Everyone is accounted for", "Every login in the activity stream is matched to a person.") + discarded;
  return `<div${surface("overflow:hidden")}>${p.identity.map((g) => identityCard(g, p.people, p.mapPicks[g.id] ?? null, p.mapConfirm === g.id)).join("")}</div>
    <div style="font-size:11.5px;color:var(--fg-40);margin-top:12px">Mapping attributes all past and future activity from that login to the person, and lets that GitHub account sign in as them. Discarding stops listing a login that isn't on the team; its activity is still recorded.</div>
    ${discarded}`;
}

// ── PEOPLE ───────────────────────────────────────────────────────────────────
/** The role + responsibilities draft an admin is editing. */
export interface PersonEditDraft { role: string; responsibilities: string }

/** The role editor as the view sees it. `draft` null = the person's profile read is in
 *  flight; `base` is what that read returned (Save waits for a change from it); `phase`
 *  "out" = it is collapsing away — cancelled, saved, or replaced by another person's. */
export interface PersonEditView {
  handle: string;
  draft: PersonEditDraft | null;
  base: PersonEditDraft | null;
  saving: boolean;
  phase?: "in" | "out";
}

/** The helper line under the Responsibilities field. */
export const RESPONSIBILITIES_HELP = "Never shown in the app, not even to them — agents read it when deciding whom to assign work.";

/** The editor's eyebrow labels: the ticket rail's PROP_LABEL. */
const RE_LABEL = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)";
const RE_FIELD = "display:block;width:100%;box-sizing:border-box;margin-top:7px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--fg);font-size:13.5px;font-family:var(--sans);outline:none";
const RE_BTN = "height:32px;padding:0 14px;border-radius:8px;font-size:12.5px;font-weight:600;white-space:nowrap";

/** Did the admin change anything? Compared trimmed, the way the save sends it. */
export function personEditChanged(draft: PersonEditDraft | null, base: PersonEditDraft | null): boolean {
  if (!draft || !base) return false;
  return draft.role.trim() !== base.role.trim() || draft.responsibilities.trim() !== base.responsibilities.trim();
}

/** The admin's role + responsibilities editor, opened under one person's row. It is the
 *  ONE place either is edited (a person never edits their own) and the one place
 *  responsibilities are shown. While the read is in flight it is the SAME form, disabled
 *  and shimmering, so nothing moves when the draft lands. The open / close motion is
 *  canopy.css `.cnpy-roleedit`, played only while main.ts `syncRoleEdit` marks the element
 *  `data-anim` — so the rerender every keystroke causes never replays the opening. */
export function personRoleEditor(name: string, e: PersonEditView): string {
  const out = e.phase === "out";
  const d = e.draft;
  const off = !d || out ? " disabled" : "";
  const skel = d ? "" : " cnpy-roleedit-skel";
  const n = d?.responsibilities.length ?? 0;
  const canSave = personEditChanged(d, e.base) && !e.saving && !out;
  // A collapsing editor is a picture of the one that closed: inert, and with no ids,
  // acts or fields — the NEW editor opening beside it owns those (rerender restores
  // focus by `data-field`, and must find the live Role box, not this one).
  const wire = (id: string, act: string, field: string) => (out ? "" : ` id="${id}" data-act="${act}" data-field="${field}"`);
  const act = (a: string) => (out ? "" : ` data-act="${a}"`);
  // "Save" and "Saving…" share one width, so the swap never shifts Cancel.
  const save = e.saving
    ? `<button${act("personEditSave")} class="cnpy-accentbtn" disabled style="${RE_BTN};min-width:78px;border:1px solid transparent;background:var(--accent);color:var(--accent-fg);opacity:.6;cursor:default">Saving…</button>`
    : `<button${act("personEditSave")}${canSave ? ` class="cnpy-accentbtn"` : " disabled"} style="${RE_BTN};min-width:78px;${canSave ? "border:1px solid transparent;background:var(--accent);color:var(--accent-fg);cursor:pointer" : "border:1px solid var(--border);background:transparent;color:var(--fg-40);cursor:default"}">Save</button>`;
  return `<div class="cnpy-roleedit" data-roleedit="${out ? "out" : "in"}"${out ? " inert" : ""}>
    <div class="cnpy-roleedit-clip"><div class="cnpy-roleedit-body" role="group" aria-label="Edit ${attr(name)}'s role"${d ? "" : ` aria-busy="true"`}>
      <label${out ? "" : ` for="person-role"`} style="${RE_LABEL}">ROLE</label>
      <input${wire("person-role", "personRoleDraft", "personRole")} value="${attr(d?.role ?? "")}" maxlength="${ROLE_MAX}" placeholder="${d ? "e.g. Backend engineer" : ""}" autocomplete="off"${off} class="cnpy-input${skel}" style="${RE_FIELD};height:36px;padding:0 11px" />
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:18px">
        <label${out ? "" : ` for="person-resp"`} style="${RE_LABEL}">RESPONSIBILITIES</label>
        <span class="cnpy-roleedit-count"${d && n > RESPONSIBILITIES_MAX * 0.9 ? ` style="color:var(--amber)"` : ""}>${d ? `${n} / ${RESPONSIBILITIES_MAX}` : "Loading…"}</span>
      </div>
      <textarea${wire("person-resp", "personRespDraft", "personResp")} maxlength="${RESPONSIBILITIES_MAX}" rows="5" placeholder="${d ? "What they own, and what should be assigned to them" : ""}"${out ? "" : ` aria-describedby="person-resp-help"`}${off} class="cnpy-input${skel}" style="${RE_FIELD};height:128px;padding:9px 11px;line-height:1.55;resize:none">${esc(d?.responsibilities ?? "")}</textarea>
      <div${out ? "" : ` id="person-resp-help"`} style="font-size:11.5px;line-height:1.5;color:var(--fg-40);margin-top:8px">${esc(RESPONSIBILITIES_HELP)}</div>
      <div class="cnpy-roleedit-actions">
        <span class="cnpy-roleedit-keys">⌘/Ctrl + Enter saves · Esc cancels</span>
        <button${act("personEditCancel")} data-arg="${attr(e.handle)}" class="cnpy-ghostbtn"${out ? " disabled" : ""} style="${RE_BTN};border:1px solid var(--border);background:transparent;color:var(--fg-55);font-weight:500">Cancel</button>
        ${save}
      </div>
    </div></div>
  </div>`;
}

export interface PeopleProps {
  persons: PersonSummary[];
  invites: InviteRow[];
  inviteDraft: string;
  loading: boolean;
  error: string | null;
  /** The signed-in handle (its row carries YOU). */
  me?: string | null;
  /** The viewer is an admin: invites, and each person's "Edit role". Without it the tab is the directory alone. */
  canInvite?: boolean;
  /** The admin's open role editor (one person at a time); null = closed. */
  edit?: PersonEditView | null;
  /** The editor that was just closed, still collapsing under its row (phase "out"). */
  editOut?: PersonEditView | null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function peopleSection(p: PeopleProps): string {
  const canInvite = p.canInvite !== false;
  const pending = canInvite ? p.invites.filter((i) => !i.accepted_by && !i.revoked_at) : [];
  const canSend = EMAIL_RE.test(p.inviteDraft.trim());
  const row = "display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px";
  // Each person opens their profile; an admin's "Edit role" opens the role + responsibilities
  // editor right under that row (`personRoleEditor` — the only place either is edited). The
  // row and its editor read as one tinted block: the row hands its divider to the editor.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const persons = p.persons.map((x) => {
    const open = canInvite && p.edit && same(p.edit.handle, x.handle) ? p.edit : null;
    const closing = canInvite && !open && p.editOut && same(p.editOut.handle, x.handle) ? { ...p.editOut, phase: "out" as const } : null;
    const ed = open ?? closing;
    return `<div class="cnpy-prow"${ed ? ` data-roleedit="${open ? "in" : "out"}"` : ""} style="${row}">
      <button data-act="openPerson" data-arg="${attr(x.handle)}" class="cnpy-maint-person" style="flex:1;min-width:0;display:flex;align-items:center;gap:12px;text-align:left;padding:0">${personChip(x, 28, x.handle)}<span style="flex:1;min-width:0;line-height:1.3"><span style="display:block;font-size:13.5px;font-weight:600">${esc(x.name ?? x.handle)}</span><span style="display:flex;align-items:center;gap:8px;min-width:0">${handleTag(x, x.handle, 11.5)}${x.role ? `<span style="font-size:12px;color:var(--fg-55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">· ${esc(x.role)}</span>` : ""}</span></span></button>
      ${p.me && same(x.handle, p.me) ? `<span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">YOU</span>` : ""}
      ${canInvite ? `<button data-act="${open ? "personEditCancel" : "personEditOpen"}" data-arg="${attr(x.handle)}" data-field="personEditBtn:${attr(x.handle)}" aria-expanded="${open ? "true" : "false"}" class="cnpy-ghostbtn cnpy-prow-edit" style="font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap">Edit role</button>` : ""}
    </div>${ed ? personRoleEditor(x.name ?? x.handle, ed) : ""}`;
  }).join("");
  const invites = pending.map((i) => {
    const status = i.email_error ? `<span style="color:var(--red)">email failed: ${esc(i.email_error)}</span>` : i.email_sent_at ? "email sent" : "email not sent";
    return `<div style="${row};flex-wrap:wrap">
      <div style="width:28px;height:28px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;color:var(--fg-40);font-size:12px;flex:none">?</div>
      <div style="flex:1;min-width:0;line-height:1.3"><div style="font-size:13.5px;font-weight:500;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.email)}</div><div style="font-size:11.5px;color:var(--fg-40)">invited ${esc(relTime(i.invited_at))} by ${esc(i.invited_by)} · ${status}</div></div>
      <span style="font-family:var(--label);font-size:10.5px;padding:2px 7px;border-radius:6px;border:1px dashed var(--border-strong);color:var(--amber);white-space:nowrap">pending</span>
      <button data-act="inviteResend" data-arg="${attr(i.email)}" class="cnpy-ghostbtn" style="font-size:12px;color:var(--fg-40);padding:4px 8px;border-radius:6px;border:1px solid var(--border);white-space:nowrap">Resend</button>
      <button data-act="inviteRevoke" data-arg="${attr(i.email)}" class="cnpy-rejectbtn" style="font-size:12px;color:var(--fg-40);padding:4px 8px;border-radius:6px;border:1px solid var(--border);white-space:nowrap">Revoke</button>
    </div>`;
  }).join("");
  const inviteBar = canInvite ? `<div style="display:flex;gap:8px;margin:0 0 14px;max-width:560px">
      <input data-act="inviteDraft" data-field="inviteDraft" value="${attr(p.inviteDraft)}" placeholder="Invite by Google email…" aria-label="Invite by Google email" class="cnpy-input" style="flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;outline:none" />
      <button data-act="inviteSend" class="${canSend ? "cnpy-accentbtn" : ""}" ${canSend ? "" : "disabled "}style="${canSend ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent;cursor:pointer" : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default"};border-radius:8px;height:38px;padding:0 16px;font-size:12.5px;font-weight:600;white-space:nowrap">Invite</button>
    </div>` : "";
  return `${inviteBar}
    ${p.error ? `<div style="font-size:12.5px;color:var(--red);margin-bottom:8px">${esc(p.error)}</div>` : ""}
    ${p.loading && p.persons.length === 0 ? `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0">Loading people…</div>` : `<div${surface("overflow:hidden")}>${persons}${invites}</div>`}`;
}

// ── composed surface ─────────────────────────────────────────────────────────
export const MAINT_INTRO: Record<MaintTab, string> = {
  unplaced: "Things an agent produced but couldn't place. Read one, then file it or throw it away.",
  identity: "Logins in the activity stream that don't belong to anyone yet.",
  people: "Everyone with a handle, and invites that haven't been accepted.",
};

/** One tab of Maintenance. `people` is the People tab's body (it needs more than
 *  these props — the directory, the invites, the admin flag), rendered by the caller. */
export function maintenanceView(p: MaintenanceProps, people = ""): string {
  const body = p.tab === "identity" ? identityTab(p) : p.tab === "people" ? people : unplacedTab(p);
  return `<div data-screen-label="Maintenance" style="width:100%;max-width:1180px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box">
    <div style="font-size:12.5px;color:var(--fg-55);margin:0 0 18px">${esc(MAINT_INTRO[p.tab])}</div>
    ${body}
  </div>`;
}
