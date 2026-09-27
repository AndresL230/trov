// The person card: the modal a click on anyone's name opens (the ticket rail's people,
// Feed authors, quick search's person hits, Maintenance › People's rows). There is no
// People screen and no profile page (the owner's call, 2026-09-27) — a person is their
// photo, name, handle and role, plus when they joined, their GitHub and an admin badge.
// Purely presentational: props in, markup out.
//
// It paints at once from the `GET /persons` summary (photo, name, handle, role) and fills
// the rest when `GET /api/people/:handle` lands. `responsibilities` is NEVER rendered here:
// it is what agents read when deciding whom to assign work, and it (with the role) is set
// only by an ADMIN in Maintenance › People (maintenance.ts `personRoleEditor`).
//
// The shell is the confirmation modal's (`.cnpy-cmodal` in canopy.css — a dimmed backdrop,
// a centered card, a bottom sheet at phone width), rendered at the app ROOT as a
// `data-overlay` so morph keeps it across rerenders. The backdrop, the × and Escape close it.

import type { PersonSummary, PersonProfile } from "@shared/people";
import { esc, attr, statusBadge } from "./ui";
import { personChip, handleTag } from "./people";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Joined Sep 2026" from an ISO timestamp (empty when unparseable). */
export function joinedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `Joined ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const GH_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"></path></svg>`;
const CLOSE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

export interface PersonCardProps {
  /** The person as `GET /persons` has them — the card paints from this at once. */
  person: PersonSummary;
  /** `GET /api/people/:handle` once it lands (joined, GitHub, admin, self); null while in flight or failed. */
  detail: PersonProfile | null;
  /** The viewer is this person (known before the detail read: the handle matches). */
  self: boolean;
}

/** The modal: a root-level `data-overlay` — backdrop (a click closes) + the centered card. */
export function personCardModal(p: PersonCardProps): string {
  const x = p.person;
  const d = p.detail && p.detail.handle.toLowerCase() === x.handle.toLowerCase() ? p.detail : null;
  const name = x.name || x.handle;
  const meta: string[] = [];
  if (d?.admin) meta.push(statusBadge("ADMIN", "var(--accent)"));
  const joined = d ? joinedLabel(d.joined) : "";
  if (joined) meta.push(`<span style="white-space:nowrap">${esc(joined)}</span>`);
  if (d?.github) {
    meta.push(`<a href="https://github.com/${encodeURIComponent(d.github)}" target="_blank" rel="noopener noreferrer" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:5px;color:var(--fg-55);text-decoration:none;white-space:nowrap">${GH_SVG}<span style="font-family:var(--label)">${esc(d.github)}</span></a>`);
  }
  return `<div data-overlay="person-card" class="cnpy-cmodal">
    <div data-act="personCardClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="person-card" role="dialog" aria-modal="true" aria-labelledby="person-card-t" tabindex="-1" data-person-card class="cnpy-surface cnpy-cmodal-box cnpy-personcard" style="position:relative;text-align:center;padding:26px 22px 22px">
        <button data-act="personCardClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:10px;right:10px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE_SVG}</button>
        <div style="display:flex;justify-content:center">${personChip(x, 88, x.handle)}</div>
        <div id="person-card-t" style="margin-top:14px;font-size:19px;font-weight:600;letter-spacing:-0.015em;line-height:1.3;overflow-wrap:anywhere">${esc(name)}</div>
        <div style="display:flex;justify-content:center;margin-top:6px">${handleTag(x, x.handle, 12.5)}</div>
        <div style="margin-top:10px;font-size:14px;color:${x.role ? "var(--fg-70)" : "var(--fg-40)"}">${x.role ? esc(x.role) : "No role yet"}</div>
        ${meta.length ? `<div style="display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:6px 14px;margin-top:14px;font-size:12px;color:var(--fg-40)">${meta.join("")}</div>` : ""}
        ${p.self ? `<button data-act="goSettings" class="cnpy-outlinebtn" style="margin-top:18px;padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Edit your photo and name</button>` : ""}
      </div>
    </div>
  </div>`;
}
