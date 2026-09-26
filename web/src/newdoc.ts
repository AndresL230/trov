// Docs › New doc — ported from the Claude Design `Canopy.dc.html` (project
// 2c8cfa50). A person stages a doc the same way an agent does, and it lands in
// Review through POST /api/docs/propose (the same gate). A handoff's "Promote to
// doc" opens this form prefilled, with a FROM HANDOFF banner. Purely presentational.

import { esc, attr, WORK_SHELL } from "./ui";
import { primaryStyle } from "./handoffs";
import { segmented } from "./segmented";

export interface NewDocDraft {
  title: string; body: string; space: string; section: string; summary: string;
  /** The handoff this draft was promoted from (null = a blank New doc). */
  from: number | null;
}
export const blankDoc = (space: string, section: string): NewDocDraft => ({ title: "", body: "", space, section, summary: "", from: null });

/** The section a new doc starts in: `reference` when offered, else the first. */
export const defaultSection = (sections: string[]): string =>
  sections.includes("reference") ? "reference" : sections[0] ?? "";

export interface NewDocProps {
  draft: NewDocDraft;
  spaces: { key: string; label: string }[];
  /** The sections the gate accepts (@shared/vocabulary SECTIONS, minus needs-triage). */
  sections: string[];
}

const FIELD = "border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);outline:none";
const pickStyle = (on: boolean) => `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : "var(--fg-55)"};background:${on ? "var(--accent-soft)" : "transparent"}`;

export function newDocView(p: NewDocProps): string {
  // No section picked yet → `reference`. The sections offered are the GATE's
  // vocabulary (@shared/vocabulary), not the ones existing docs happen to use —
  // POST /api/docs/propose runs the gate and refuses anything else.
  const d = { ...p.draft, section: p.draft.section || defaultSection(p.sections) };
  const sections = p.sections.includes(d.section) || !d.section ? p.sections : [...p.sections, d.section];
  const can = !!d.title.trim() && !!d.body.trim();
  const fromBanner = d.from !== null
    ? `<div style="border:1px solid var(--border);border-left:2px solid var(--accent);border-radius:9px;padding:11px 15px;margin-bottom:16px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
      <div style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--accent);flex:none">FROM HANDOFF</div>
      <div style="font-size:12.5px;color:var(--fg-70);flex:1">Prefilled from handoff #${d.from}. Edit anything before staging.</div>
      <button data-act="openHandoff" data-arg="${d.from}" class="cnpy-link" style="font-size:12.5px;font-weight:500;color:var(--accent)">Open handoff</button>
    </div>`
    : "";
  return `<div data-screen-label="New doc" style="${WORK_SHELL}">
  ${fromBanner}
  <div style="border:1px solid var(--border);border-radius:13px;padding:26px 28px;display:flex;flex-direction:column;min-height:calc(100vh - 210px)">
    <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 288px;gap:32px;flex:1;min-height:0">
      <div style="min-width:0;display:flex;flex-direction:column">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Title</label>
        <input data-act="ndField" data-arg="title" data-field="nd-title" value="${attr(d.title)}" class="cnpy-input" placeholder="What is this doc about?" style="width:100%;height:40px;padding:0 13px;${FIELD};font-size:14px">
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">Body <span style="font-weight:400;color:var(--fg-40)">— markdown</span></label>
        <textarea data-act="ndField" data-arg="body" data-field="nd-body" style="width:100%;flex:1;min-height:300px;padding:12px 14px;${FIELD};font-size:12.5px;line-height:1.65;resize:vertical;font-family:var(--code)">${esc(d.body)}</textarea>
      </div>
      <div style="min-width:0;border-left:1px solid var(--border);padding-left:26px">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Space</label>
        ${segmented({ id: "nd-space", ariaLabel: "Space", act: "ndSpace", value: d.space, options: p.spaces.map((s) => ({ value: s.key, label: s.label })) })}
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">Section</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${sections.map((s) => `<button data-act="ndSection" data-arg="${attr(s)}" class="cnpy-pickchip${d.section === s ? " is-on" : ""}" style="${pickStyle(d.section === s)}">${esc(s)}</button>`).join("")}</div>
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">Summary <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
        <input data-act="ndField" data-arg="summary" data-field="nd-summary" value="${attr(d.summary)}" class="cnpy-input" placeholder="One line for the Review queue" style="width:100%;height:38px;padding:0 12px;${FIELD};font-size:12.5px">
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:14px;line-height:1.5">Lands in Review as a staged proposal, the same as an agent's. Nothing goes live until it's promoted.</div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
      <button data-act="goDocs" class="cnpy-outlinebtn" style="padding:8px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease;white-space:nowrap">Cancel</button>
      <button data-act="ndSubmit" class="${can ? "cnpy-accentbtn" : ""}" style="${primaryStyle(can)}">Stage for review</button>
    </div>
  </div>
</div>`;
}
