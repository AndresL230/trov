// Unmatched logins — matching a GitHub login that appears in captured activity to a person,
// or discarding one that is not on the team (an outside contributor; Undo / Restore brings it
// back). The map is per org and an admin's to write, so it lives where the org's people are
// managed: Org settings › Members (org-settings.ts `membersTab`), above the member list while
// any login waits, and nowhere for a member who is not an admin. It was Maintenance › Identity
// until 2026-10-06.
//
// Purely presentational: props in, markup out. The `identity…` acts are run in main.ts.

import { esc, attr, primaryBtn, surface } from "./ui";
import { EYEBROW, chipOf, type Person } from "./maintenance";

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

/** Everything the section needs (render.ts `orgProps` builds it for an admin; null otherwise). */
export interface IdentityProps {
  status: "idle" | "loading" | "ok" | "error";
  groups: IdentityGroup[];
  /** Discarded logins, and whether their restore list is open. */
  discarded: DiscardedLogin[];
  showDiscarded: boolean;
  people: Person[];
  mapPicks: Record<string, string>;
  /** Login currently in the map confirm step (two-step guard) — null when none. */
  mapConfirm: string | null;
}

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
  return `<div style="display:flex;flex-wrap:wrap;gap:14px 32px;padding:14px 16px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px">
    <div style="flex:1 1 280px;min-width:0">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><div style="font-size:13.5px;font-weight:600;color:var(--fg);white-space:nowrap">${esc(g.login)}</div><div style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(g.meta)}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">${sample}</div>
    </div>
    <div style="flex:1 1 380px;min-width:0">${personPicker(g.id, people, pick, confirming)}</div>
  </div>`;
}

/** What mapping and discarding do — the one explanation, under the cards. */
export const IDENTITY_EFFECT = "Mapping attributes all past and future activity from that login to the person, and lets that GitHub account sign in as them. Discarding stops listing a login that isn't on the team; its activity is still recorded.";

/** The cards (one per unmatched login) and the discarded list. "" when there is nothing of either. */
export function identitySection(p: IdentityProps): string {
  const discarded = discardedLogins(p.discarded, p.showDiscarded);
  if (p.groups.length === 0) return discarded;
  return `<div${surface("overflow:hidden")}>${p.groups.map((g) => identityCard(g, p.people, p.mapPicks[g.id] ?? null, p.mapConfirm === g.id)).join("")}</div>
    <div style="font-size:11.5px;color:var(--fg-40);margin-top:12px">${esc(IDENTITY_EFFECT)}</div>
    ${discarded}`;
}
