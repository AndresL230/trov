// Unplaced — the Triage queue of loose things an agent produced but couldn't place: a list
// on the left, the selected item on the right; read one, then file it or discard it. Empty is
// its normal state. Ported from the Claude Design `Canopy.dc.html` (project 2c8cfa50).
//
// This screen was "Maintenance" until 2026-10-06, with two more tabs — Identity and People.
// Those are org administration, and an org is administered in ONE place, Org settings:
// matching an unknown login to a person is on its Members tab (web/src/identity.ts), the
// member directory IS that tab, and the e-mail digest policy / schedule / outbox are its
// Notifications tab (web/src/notifications.ts). The screen's id stays `maintenance` (state,
// the nav key, the `maint…` acts); its address is `#unplaced`, and the old `#maintenance…`
// links still resolve (hash.ts).
//
// Purely presentational: data arrives through props and renders to HTML strings;
// interactions dispatch via data-act / data-arg handled in main.ts.

import { esc, attr, primaryBtn, surface } from "./ui";
import { personChip, personLink, handleTag } from "./people";
import type { PersonColor } from "@shared/rows";

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

export interface Person { id: string; name: string; initials: string; color?: PersonColor; avatar_url?: string | null }

export interface MaintenanceProps {
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
  /** The persons directory: an item's author gets their own chip and colour. */
  people: Person[];
}

// ── shared atoms ─────────────────────────────────────────────────────────────
export const EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

/** The design's pick chip (`V.pickSt`): accent when on, label-face for vocabulary values. */
function pickChip(label: string, on: boolean, act: string, arg: string, mono = false): string {
  const st = `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : "var(--fg-55)"};background:${on ? "var(--accent-soft)" : "transparent"};font-family:${mono ? "var(--label)" : "inherit"}`;
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="${st}">${esc(label)}</button>`;
}

/** A label-face section header with a hint and a count (Org settings › Notifications uses it). */
export function maintSectionHeader(label: string, hint: string, countLabel: string, first: boolean): string {
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:${first ? "38px" : "44px"};padding-bottom:9px;border-bottom:1px solid var(--border-strong)">
    <div style="display:flex;align-items:baseline;gap:10px">
      <div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55)">${esc(label)}</div>
      <div style="font-size:11.5px;color:var(--fg-40)">${esc(hint)}</div>
    </div>
    <div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40)">${esc(countLabel)}</div>
  </div>`;
}

/** A dashed, centred empty-state card (the normal state of this queue). */
export function maintEmpty(title: string, sub: string): string {
  return `<div style="display:flex;justify-content:center;padding:56px 0"><div style="border:1px dashed var(--border-strong);border-radius:13px;padding:36px 44px;text-align:center;max-width:380px"><div style="font-size:15px;font-weight:600;color:var(--fg-70)">${esc(title)}</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:6px">${esc(sub)}</div></div></div>`;
}

const person = (people: Person[], id: string | null | undefined): Person | null =>
  id ? people.find((p) => p.id.toLowerCase() === id.toLowerCase()) ?? null : null;
/** A Person as the chip helpers take it — null (plain, initials) without a color. */
export const chipPerson = (p: Person | null) => (p?.color ? { handle: p.id, name: p.name, color: p.color, avatar_url: p.avatar_url } : null);
export const chipOf = (p: Person | null, size: number, fallback: string) => personChip(chipPerson(p), size, fallback);

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

// ── composed surface ─────────────────────────────────────────────────────────
export const UNPLACED_INTRO = "Things an agent produced but couldn't place. Read one, then file it or throw it away.";

/** The page: the intro, a degraded `hint`, and the queue. No tab bar — it is one queue. */
export function maintenanceView(p: MaintenanceProps, hint = ""): string {
  return `<div data-screen-label="Unplaced" style="width:100%;max-width:1180px;margin:0 auto;padding:18px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box">
    ${hint}<div style="font-size:12.5px;color:var(--fg-55);margin:0 0 18px">${esc(UNPLACED_INTRO)}</div>
    ${unplacedTab(p)}
  </div>`;
}
