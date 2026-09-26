// DTOs for the personal "My Work" dashboard: three explicitly separate lists —
// two off the captured-event stream (PRs, assigned issues) and one off the D1
// ticket queue. Lives in shared/ (the only cross-layer location) so the Worker
// (src/) and the web build (web/) agree on the shape.

import type { TicketCategory, TicketPriority, TicketStatus } from "./tickets-core";

export interface MyWorkPr {
  number: number;
  title: string;
  displayTitle: string | null; // humanized title from the summarizer; render falls back to the raw GitHub title
  url: string;
  merged: boolean;
  occurredAt: string;
  what: string | null; // structured "What changed" (null → card shows a "No summary recorded" placeholder)
  why: string | null; // motivation, only when the PR body stated one
  impact: string | null; // plain-language outcome sentence (never a file list)
  baseRef: string | null; // PR base branch (footer "into main" suffix; hidden when null)
}

export interface MyWorkTodo {
  number: number;
  title: string;
  displayTitle: string | null; // humanized title from the summarizer; render falls back to the raw GitHub title
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
  summary: string | null;
  // The SPRINT this issue belongs to. Resolved in listOpenAssignedIssues from the
  // issue's GitHub group number to the sprint whose `github_ref` is that number;
  // when no sprint claims it, the GitHub group's own title is the fallback.
  sprint: { title: string; dueOn: string | null } | null;
  nextStep: string | null; // suggested next step from the summarizer
}

/**
 * One open ticket assigned to the person (Phase 5 — "Tickets assigned to me").
 * These are D1 tickets, NEVER GitHub issues, so they are their own list and are
 * never folded into `todo`: `todo` is the GitHub issue surface (it carries a
 * `number` and a `url`), a ticket has neither.
 * `status` is always an OPEN status (`submitted` / `in_progress`) — closed
 * tickets never reach My Work.
 */
export interface MyWorkTicket {
  id: number;
  title: string;
  body: string; // the ticket's description, rendered as escaped prose (never markdown)
  category: TicketCategory;
  priority: TicketPriority;
  status: Extract<TicketStatus, "submitted" | "in_progress" | "testing">;
  requester: string; // person handle who filed it
  sprint: { id: number; label: string } | null; // null = Backlog
  updatedAt: string;
  createdAt: string;
}

export interface DashboardData {
  person: string | null; // identity-mapped name; null if unmapped
  previousActivity: MyWorkPr[]; // summarized merged/closed PRs, 5 most recent
  todo: MyWorkTodo[]; // open issues assigned to the person
  tickets: MyWorkTicket[]; // open queue tickets assigned to the person (NEVER in `todo`)
  degraded: boolean; // D1 projection unavailable
}
