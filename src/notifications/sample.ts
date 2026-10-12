// Canned sections for the admin preview / test send when the store has nothing
// to say (a fresh org, a quiet window). Built on the same card/row/chip helpers
// as the live renderers so the full layout is visible. Clearly marked as sample.
import type { Section } from "@shared/notifications";
import { EMAIL_STYLE as S, EMAIL_CARD as K, EMAIL_SPACE as SP, EMAIL_FONT, THEME } from "./assemble";

const pr = (n: number, title: string, what: string, why: string | null, impact: string | null, first = false) =>
  K.item({
    title, number: n, url: `https://github.com/SaplingLearn/sapling/pull/${n}`,
    rows: [K.row("What changed", K.prose(what)), ...(why ? [K.row("Why", K.prose(why))] : []), ...(impact ? [K.row("Impact", K.prose(impact))] : [])],
    footer: `${K.mark("Merged", "green")}<span style="padding-left:8px;">into <span style="${EMAIL_FONT.label}">main</span></span>`,
    first,
  });
const issue = (n: number, title: string, summary: string, sprint: string | null, next: string | null, prio: string | null, labels: string[], first = false) =>
  K.item({
    title, number: n, url: `https://github.com/SaplingLearn/sapling/issues/${n}`,
    rows: [K.row("Summary", K.prose(summary)), ...(sprint ? [K.row("Sprint", sprint)] : []), ...(next ? [K.row("Next step", K.prose(next), "accent")] : [])],
    footer: [prio ? K.mark(prio, "amber") : "", labels.map((l) => `<span>${l}</span>`).join(" &middot; ")].filter(Boolean).join(`<span style="padding-left:10px;"></span>`) || undefined,
    first,
  });
const review = (kind: "proposal" | "decision", title: string, summary: string, meta: string, low = false, first = false) =>
  `<tr><td style="padding:${first ? 0 : SP.m - SP.xs}px 0 ${SP.m - SP.xs}px 0;${first ? "" : `border-top:1px solid ${THEME.border.light};`}">` +
  `<div><span style="${S.muted}">${kind === "proposal" ? "Proposal" : "Decision"}</span><span style="${S.body}font-weight:500;padding-left:8px;">${title}</span>${low ? `<span style="padding-left:10px;">${K.mark("Low confidence", "amber")}</span>` : ""}</div>` +
  `<div style="${S.muted}padding-top:${SP.xs}px;">${summary}</div><div style="${S.muted}font-size:12px;line-height:16px;padding-top:${SP.xs}px;">${meta}</div></td></tr>`;
/** A ticketq card, mirroring renderers/ticket-queue.ts's two halves exactly. */
const unassigned = (title: string, category: string, prio: string, requester: string, old: string, first = false) =>
  K.item({
    title, number: null, url: null,
    rows: [K.row("Category", category), K.row("Requester", requester)],
    footer: `${prio}<span style="padding-left:10px;">opened ${old} ago</span>`,
    first,
  });
const assigned = (title: string, status: string, tone: "accent" | "amber" | "muted", prio: string, sprint: string, updated: string, first = false) =>
  K.item({
    title, number: null, url: null,
    rows: [K.row("Sprint", sprint)],
    footer: `${K.mark(status, tone)}<span style="padding-left:10px;">${prio}</span><span style="padding-left:10px;">updated ${updated} ago</span>`,
    first,
  });
const plan = (label: "added" | "changed" | "reordered" | "done", t: string) =>
  `<tr><td width="96" style="vertical-align:top;padding:${SP.xs}px 8px ${SP.xs}px 0;">${K.mark(label.charAt(0).toUpperCase() + label.slice(1), { added: "green", changed: "blue", reordered: "muted", done: "accent" }[label] as "green" | "blue" | "muted" | "accent")}</td><td style="${S.body}">${t}</td></tr>`;

export function sampleSections(): Section[] {
  return [
    {
      heading: "My Work",
      summary: "2 PRs merged · 2 assigned issues open (sample data)",
      linkLabel: "My Work",
      deepLink: "/#mywork",
      html:
        `<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">MERGED</div>` +
        pr(142, "Constant-time MCP token comparison", "Bearer tokens are now compared with `timingSafeEqual` instead of `===`, and the hash lookup no longer short-circuits on length.", "A timing side-channel could leak how many leading bytes of a token matched.", "Token checks take the same time whether or not a token is valid. No change for callers.", true) +
        pr(139, "GitHub org-membership check on sign-in", "The OAuth callback now calls `GET /user/memberships/orgs/SaplingLearn` and rejects anyone who is not an active member.", null, "Non-members land on the “not a member” screen instead of an empty app.") +
        `<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">OPEN &amp; ASSIGNED</div>` +
        issue(175, "Audit retention + compaction policy", "Decide how long raw webhook payloads are kept and when they compact into summaries.", "Sprint 12 <span style=\"font-size:11.5px;\">&middot; due Sep 20</span>", "Draft the retention table for the ADR and get it in front of the team.", "P1", ["policy", "storage"], true) +
        issue(227, "Progress bar from closed/total", "Sprint cards should show progress from the stored closed/total counts, never a live GitHub call.", null, "Wire `sprint_progress` into the roadmap card.", null, ["roadmap"]),
      text: "  merged  #142  Constant-time MCP token comparison\n                What changed: Bearer tokens are now compared with timingSafeEqual instead of ===.\n  merged  #139  GitHub org-membership check on sign-in\n  open    #175  [P1] Audit retention + compaction policy\n                Next step: Draft the retention table for the ADR and get it in front of the team.\n  open    #227  Progress bar from closed/total\n                Next step: Wire sprint_progress into the roadmap card.",
    },
    {
      heading: "Review queue",
      summary: "2 proposals, 1 decision waiting on review (sample data)",
      linkLabel: "Review",
      deepLink: "/#review",
      html:
        `<table ${S.table} style="margin-top:${SP.m}px;">` +
        review("proposal", "Reference / MCP Server", "Clarify token rotation and what happens to sessions on revoke.", "by mei · high confidence", false, true) +
        review("proposal", "Context / Glossary", "Promoted vs staged definitions.", "by sana · low confidence", true) +
        review("decision", "ADR-003 — Agent write contract", "ready to ratify", "by dev") +
        `</table>`,
      text: "  proposal  Reference / MCP Server — Clarify token rotation (by mei · high confidence)\n  proposal  Context / Glossary — Promoted vs staged definitions (by sana · low confidence, LOW CONFIDENCE)\n  decision  ADR-003 — Agent write contract — ready to ratify (by dev)",
    },
    {
      heading: "Roadmap plan changes",
      summary: "4 plan changes this week (sample data)",
      linkLabel: "Roadmap",
      deepLink: "/#roadmap",
      html:
        `<table ${S.table} style="margin-top:${SP.m}px;">` +
        plan("added", "Self-host &amp; deploy guide — targeting Sep 20") +
        plan("changed", "Semantic search ranking — target moved Jul 4 → Jul 18") +
        plan("reordered", "Multi-agent session attribution now ahead of Self-host &amp; deploy guide") +
        plan("done", "Docs handbook + diagram rendering — confirmed complete") +
        `</table>`,
      text: "  added      Self-host & deploy guide — targeting Sep 20\n  changed    Semantic search ranking — target moved Jul 4 -> Jul 18\n  reordered  Multi-agent session attribution now ahead of Self-host & deploy guide\n  done       Docs handbook + diagram rendering — confirmed complete",
    },
    {
      heading: "Ticket queue",
      summary: "2 tickets unassigned · 1 assigned to you (sample data)",
      linkLabel: "Tickets",
      deepLink: "/#tickets",
      html:
        `<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">UNASSIGNED</div>` +
        unassigned("Gradebook export comes back empty", "bug", "High priority", "Meilin Zhao", "3h", true) +
        unassigned("Access to the staging analytics dashboard", "access", "Normal priority", "Sana Okafor", "2d") +
        `<div style="${S.label}padding-top:${SP.l}px;padding-bottom:${SP.s}px;">ASSIGNED TO YOU</div>` +
        assigned("Roster import drops middle names", "In progress", "accent", "Normal priority", "Ticket queue", "6h", true),
      text:
        "  unassigned  #214  Gradebook export comes back empty\n" +
        "                    bug · high · filed by Meilin Zhao · 3h old\n" +
        "  unassigned  #211  Access to the staging analytics dashboard\n" +
        "                    access · normal · filed by Sana Okafor · 2d old\n" +
        "  assigned    #207  Roster import drops middle names\n" +
        "                    In progress · Ticket queue",
    },
  ];
}
