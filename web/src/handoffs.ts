// Handoffs — ported from the Claude Design `Canopy.dc.html` (project 2c8cfa50):
// the inbox (waiting / history), one handoff's page, and the new-handoff form.
// Purely presentational: props in, markup out; clicks are `data-act` dispatched
// in main.ts, which calls the /api/handoffs routes. Ids are numbers, rendered `#12`.

import type { HandoffView, HandoffStatus } from "@shared/handoffs";
import { firstLine } from "@shared/handoffs";
import type { PersonSummary } from "./api";
import { esc, attr, relTime, surface, WORK_SHELL } from "./ui";
import { personChip } from "./people";
import { renderMarkdown } from "./markdown";
import { promptBox, promptModal, type PromptView } from "./prompt-box";

// ── atoms ────────────────────────────────────────────────────────────────────
const CHIP_BASE = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none";

/** PENDING (blue tint) / CLAIMED (quiet outline) / EXPIRED (faded red) — the ticket pill, mapped onto handoff status. */
export function handoffPill(status: HandoffStatus): string {
  if (status === "pending") return `<span style="${CHIP_BASE};color:var(--blue);border:1px solid color-mix(in srgb,var(--blue) 45%,transparent);background:color-mix(in srgb,var(--blue) 12%,transparent)">PENDING</span>`;
  if (status === "claimed") return `<span style="${CHIP_BASE};color:var(--fg-55);border:1px solid var(--border-strong)">CLAIMED</span>`;
  return `<span style="${CHIP_BASE};color:var(--red);border:1px solid color-mix(in srgb,var(--red) 35%,transparent);opacity:.75">EXPIRED</span>`;
}

/** The dashed "–" avatar that stands for Anyone (the tickets' Unassigned avatar). */
export function anyoneAvatar(size: number): string {
  return `<div class="cnpy-av cnpy-av-anon" title="Anyone" style="width:${size}px;height:${size}px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:${size > 22 ? 9 : 8}px;font-weight:600;flex:none;color:var(--fg-40)">–</div>`;
}

const personOf = (persons: PersonSummary[], h: string): PersonSummary | null =>
  persons.find((p) => p.handle.toLowerCase() === h.toLowerCase()) ?? null;
const nameOf = (persons: PersonSummary[], h: string): string => personOf(persons, h)?.name || h;
const avatarOf = (persons: PersonSummary[], h: string, size: number): string =>
  h === "anyone" ? anyoneAvatar(size) : personChip(personOf(persons, h), size, h);

const MONO_EYEBROW = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

/** The fixed "Copy as prompt" text for a handoff — what a claiming session is given. */
export function handoffAsPrompt(h: HandoffView): string {
  const c = h.context;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const lines = [
    `HANDOFF #${h.id} · from @${h.sender} · to ${h.recipient === "anyone" ? "anyone" : "@" + h.recipient}`,
    `Repo: ${c.repo || "-"}`,
    `Branch: ${c.branch || "-"}`,
    `Task: ${c.task || "-"}`,
    "",
    "## Message",
    h.body.trim(),
    "",
    "## Done",
    list(c.done),
    "",
    "## Next",
    list(c.next),
    "",
    "## Files touched",
    list(c.files),
  ];
  if (h.prompt) lines.push("", `## Prompt: ${h.prompt.title}`, h.prompt.body.trim());
  return lines.join("\n");
}

// ── inbox ────────────────────────────────────────────────────────────────────
export interface HandoffsListProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  handoffs: HandoffView[];
  me: string;
  persons: PersonSummary[];
}

function listRow(h: HandoffView, p: HandoffsListProps): string {
  const sent = h.sender.toLowerCase() === p.me.toLowerCase();
  const other = sent ? h.recipient : h.sender;
  const pending = h.status === "pending";
  const titleSt = `min-width:0;font-size:13.5px;font-weight:${pending ? 600 : 500};letter-spacing:-0.005em;color:${pending ? "var(--fg)" : "var(--fg-55)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
  const promptChip = h.prompt
    ? `<span class="cnpy-hrow-chip" style="font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px;white-space:nowrap;flex:none">+ prompt</span>`
    : "";
  const when = relTime(pending ? h.created_at : (h.claimed_at ?? h.created_at));
  return `<button data-act="openHandoff" data-arg="${h.id}" class="cnpy-trow cnpy-hrow${pending ? " cnpy-attn" : ""}" style="display:grid;grid-template-columns:minmax(0,2.6fr) minmax(0,1.1fr) minmax(0,1.3fr) auto 64px;gap:12px;align-items:center;width:100%;text-align:left;padding:12px 16px;border-bottom:1px solid var(--border);transition:background .12s ease">
    <div style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:11px;font-weight:600;color:var(--fg-40);flex:none">#${h.id}</span><span style="${titleSt}">${esc(firstLine(h.body))}</span>${promptChip}</div>
    <div class="cnpy-hrow-who" style="display:flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40);flex:none;width:32px">${sent ? "TO" : "FROM"}</span>${avatarOf(p.persons, other, 20)}<span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(other === "anyone" ? "Anyone" : nameOf(p.persons, other))}</span></div>
    <div class="cnpy-hrow-ref" style="min-width:0"><div style="font-family:var(--label);font-size:11.5px;font-weight:500;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.context.branch)}</div><div style="font-family:var(--label);font-size:10px;color:var(--fg-40);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.context.repo)}</div></div>
    <div>${handoffPill(h.status)}</div>
    <div style="font-size:11.5px;color:var(--fg-40);text-align:right;font-family:var(--label);white-space:nowrap">${esc(when)}</div>
  </button>`;
}

const sectionHead = (label: string, count: number, top = false): string =>
  `<div style="${top ? "" : "margin-top:36px"}"><div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 2px"><div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55);white-space:nowrap">${esc(label)}</div><div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap">${count}</div></div></div>`;

const table = (rows: string): string =>
  `<div${surface("overflow:hidden;margin-top:10px")}><div class="cnpy-stagger" style="margin-bottom:-1px">${rows}</div></div>`;

const notice = (text: string): string => `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${esc(text)}</div>`;

export function handoffsView(p: HandoffsListProps): string {
  const intro = `<div style="font-size:12.5px;color:var(--fg-55);margin:0 0 22px">Handoffs you sent or that were left for you. A pending handoff waits until a session claims it.</div>`;
  let body: string;
  if ((p.status === "idle" || p.status === "loading") && p.handoffs.length === 0) body = notice("Loading handoffs…");
  else if (p.status === "error" && p.handoffs.length === 0) body = notice("Couldn't load handoffs.");
  else {
    const pend = p.handoffs.filter((h) => h.status === "pending");
    const hist = p.handoffs.filter((h) => h.status !== "pending")
      .sort((a, b) => ((a.claimed_at ?? a.created_at) < (b.claimed_at ?? b.created_at) ? 1 : -1));
    const pendingBlock = pend.length
      ? table(pend.map((h) => listRow(h, p)).join(""))
      : `<div style="border:1px dashed var(--border-strong);border-radius:11px;padding:22px 20px;text-align:center;margin-top:12px"><div style="font-size:13.5px;font-weight:500;color:var(--fg-70)">Nothing waiting</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:4px">When a session ends mid-task, its handoff shows here until the next session picks it up.</div></div>`;
    const historyBlock = hist.length
      ? table(hist.map((h) => listRow(h, p)).join(""))
      : `<div style="text-align:center;padding:28px;color:var(--fg-40);font-size:12.5px">No claimed or expired handoffs yet.</div>`;
    body = `${sectionHead("WAITING TO BE CLAIMED", pend.length, true)}${pendingBlock}${sectionHead("HISTORY", hist.length)}${historyBlock}`;
  }
  return `<div data-screen-label="Handoffs" style="${WORK_SHELL}">${intro}${body}</div>`;
}

// ── one handoff ──────────────────────────────────────────────────────────────
export interface HandoffDetailProps {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  handoff: HandoffView | null;
  me: string;
  persons: PersonSummary[];
  expireArm: boolean;
  /** The prompt box's Raw / Rendered setting. */
  promptView: PromptView;
}

/** Inline `code` → a monospace span; everything else escaped. The checklist's one bit of markup. */
const inlineCode = (t: string): string => esc(t).replace(/`([^`]+)`/g, '<span style="font-family:var(--code);font-size:12px">$1</span>');


export function handoffDetailView(p: HandoffDetailProps): string {
  const shell = (inner: string) => `<div data-screen-label="Handoff detail" style="width:100%;max-width:1180px;margin:0 auto;padding:36px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box;position:relative">${inner}</div>`;
  const h = p.handoff;
  if (!h) {
    if (p.status === "idle" || p.status === "loading") return shell(notice("Loading…"));
    return shell(notice(p.status === "error" ? "Couldn't load this handoff." : "Handoff not found."));
  }
  const c = h.context;
  const pending = h.status === "pending";
  const who = (x: string | null) => (!x ? "" : x.toLowerCase() === p.me.toLowerCase() ? "You" : x === "anyone" ? "Anyone" : nameOf(p.persons, x));
  const lines = h.body.split("\n");
  const fi = lines.findIndex((l) => l.trim());
  const rest = lines.slice(fi + 1).join("\n").trim();

  const outline = "padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap";
  const actions = `<button data-act="handoffPromote" data-arg="${h.id}" class="cnpy-outlinebtn" style="${outline}">Promote to doc</button>`
    + (pending
      ? `<button data-act="handoffClaim" data-arg="${h.id}" class="cnpy-accentbtn" style="background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:8px 18px;font-size:12.5px;font-weight:600;white-space:nowrap">Claim</button>`
      : `<button data-act="handoffCopy" data-arg="${h.id}" class="cnpy-outlinebtn" style="${outline}">Copy as prompt</button>`);

  const promptSection = h.prompt
    ? promptBox({ title: h.prompt.title, body: h.prompt.body, copyAct: "handoffPromptCopy", copyArg: String(h.id), expandAct: "handoffPromptOpen", marginTop: rest ? 28 : 0, view: p.promptView })
    : "";

  const total = c.done.length + c.next.length;
  const pct = Math.round((100 * c.done.length) / Math.max(1, total));
  const box = (done: boolean) => `width:14px;height:14px;border-radius:4px;flex:none;margin-top:3px;display:grid;place-items:center;box-sizing:border-box;${done ? "background:var(--accent);border:none" : "background:transparent;border:1.5px solid var(--border-strong)"}`;
  const check = (t: string, done: boolean) => `<div style="display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:1.55">
      <span style="${box(done)}">${done ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" stroke-width="4"><path d="M20 6 9 17l-5-5"></path></svg>` : ""}</span>
      <span style="flex:1;min-width:0;color:${done ? "var(--fg-40)" : "var(--fg-70)"}">${inlineCode(t)}</span>
    </div>`;
  const files = c.files.length
    ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:3px">${c.files.map((f) => `<div style="font-family:var(--label);font-size:11px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f)}</div>`).join("")}</div>`
    : "";

  const statusLine = h.status === "claimed"
    ? `Claimed by ${who(h.claimed_by)} ${relTime(h.claimed_at)}${h.claimed_by_session ? ` · ${h.claimed_by_session}` : ""}`
    : pending ? "Waiting for a session to claim it" : "Expired unclaimed";

  return shell(`
    <div class="cnpy-dhead" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:22px;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <h2 style="margin:0;max-width:620px;font-size:24px;font-weight:600;letter-spacing:-0.02em;line-height:1.28;text-wrap:pretty">${esc(firstLine(h.body))}</h2>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12.5px;color:var(--fg-55)">
          ${handoffPill(h.status)}
          <span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--fg-40)">#${h.id}</span>
          <span style="white-space:nowrap">${esc(who(h.sender))} → ${esc(who(h.recipient))}</span>
          <span style="color:var(--fg-40);white-space:nowrap">· ${esc(relTime(h.created_at))}</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex:none;padding-top:2px">${actions}</div>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:28px 40px;margin-top:26px;align-items:stretch">
      <div style="flex:2.2 1 440px;min-width:0;display:flex;flex-direction:column">
        ${rest ? `<div class="cnpy-md cnpy-td-body" style="font-size:14px;line-height:1.72;color:var(--fg-70)">${renderMarkdown(rest)}</div>` : ""}
        ${promptSection}
      </div>

      <div${surface("flex:1 1 290px;min-width:0;padding:18px 20px")}>
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
          <div style="${MONO_EYEBROW}">Where it stands</div>
          <div style="font-family:var(--label);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap">${c.done.length} of ${total} done</div>
        </div>
        <div style="height:3px;border-radius:2px;background:var(--border);margin-top:10px;overflow:hidden"><div class="repo-fill" style="height:100%;border-radius:2px;background:var(--accent);width:${pct}%"></div></div>
        <div style="font-size:13.5px;font-weight:500;color:var(--fg);margin-top:16px;line-height:1.45">${esc(c.task || "—")}</div>
        <div style="font-family:var(--label);font-size:11px;color:var(--fg-40);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.repo || "—")} · ${esc(c.branch || "—")}</div>
        <div style="display:flex;flex-direction:column;gap:9px;margin-top:16px">${c.done.map((t) => check(t, true)).join("")}${c.next.map((t) => check(t, false)).join("")}</div>
        ${files}
      </div>
    </div>

    <div style="margin-top:36px;padding-top:14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:12px">
      <span style="color:var(--fg-40)">${esc(statusLine)}</span>
      <div style="display:flex;align-items:center;gap:16px">
        ${pending ? `<button data-act="handoffExpire" data-arg="${h.id}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;white-space:nowrap;color:${p.expireArm ? "var(--red)" : "var(--fg-55)"}">${p.expireArm ? "Click again to expire" : "Expire"}</button>` : ""}
      </div>
    </div>`);
}

/** The expanded prompt, over everything (rendered at the root, like the connect modal). */
export function handoffPromptModal(h: HandoffView): string {
  if (!h.prompt) return "";
  return promptModal({ title: h.prompt.title, body: h.prompt.body, copyAct: "handoffPromptCopy", copyArg: String(h.id), closeAct: "handoffPromptClose" });
}

// ── new handoff ──────────────────────────────────────────────────────────────
/** Promote to doc: a handoff reshaped as a New doc draft (the design's promoteToDoc). */
export function docDraftFromHandoff(h: HandoffView): { title: string; body: string; summary: string } {
  const c = h.context;
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const body = [
    h.body.trim(),
    c.done.length ? `## What's done\n\n${list(c.done)}` : "",
    c.next.length ? `## What's next\n\n${list(c.next)}` : "",
    c.files.length ? `## Files\n\n${c.files.map((f) => "- `" + f + "`").join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { title: c.task || firstLine(h.body), body, summary: `Promoted from handoff #${h.id}` };
}

export interface NewHandoffDraft {
  recipient: string;
  body: string;
  promptTitle: string;
  promptBody: string;
  ctxOpen: boolean;
  repo: string;
  branch: string;
  task: string;
  done: string;
  next: string;
  files: string;
}
export const blankHandoff = (): NewHandoffDraft => ({
  recipient: "anyone", body: "", promptTitle: "", promptBody: "", ctxOpen: false,
  repo: "SaplingLearn/sapling", branch: "", task: "", done: "", next: "", files: "",
});

export interface NewHandoffProps { draft: NewHandoffDraft; me: string; persons: PersonSummary[] }

const FIELD = "border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);outline:none";
const MONO_FIELD_LABEL = (color = "var(--fg-40)") => `display:block;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.06em;color:${color};margin-bottom:6px`;

/** The design's `primaryBtn` style (accent when armed, muted outline otherwise). */
export function primaryStyle(enabled: boolean): string {
  return `${enabled ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent;cursor:pointer" : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default"};border-radius:8px;padding:8px 16px;font-size:12.5px;font-weight:600;transition:all .12s ease;white-space:nowrap`;
}

/** A person pick chip (avatar + label), the tickets form's assignee chip. */
export function personPickStyle(on: boolean): string {
  return `white-space:nowrap;display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:7px;font-size:12.5px;font-weight:500;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : "var(--fg-55)"};background:${on ? "var(--accent-soft)" : "transparent"}`;
}

export function newHandoffView(p: NewHandoffProps): string {
  const n = p.draft;
  const input = (field: keyof NewHandoffDraft, placeholder: string, style: string) =>
    `<input data-act="nhField" data-arg="${field}" data-field="nh-${field}" value="${attr(String(n[field]))}" class="cnpy-input" placeholder="${attr(placeholder)}" style="${style}">`;
  const area = (field: keyof NewHandoffDraft, placeholder: string, style: string) =>
    `<textarea data-act="nhField" data-arg="${field}" data-field="nh-${field}" placeholder="${attr(placeholder)}" style="${style}">${esc(String(n[field]))}</textarea>`;

  const first = n.body.trim() ? firstLine(n.body) : "";
  const others = p.persons.filter((x) => x.handle.toLowerCase() !== p.me.toLowerCase());
  const recipients = [{ key: "anyone", label: "Anyone", av: anyoneAvatar(20) }]
    .concat(others.map((x) => ({ key: x.handle, label: x.name || x.handle, av: personChip(x, 20, x.handle) })))
    .map((r) => `<button data-act="nhRecipient" data-arg="${attr(r.key)}" class="cnpy-pickchip${n.recipient === r.key ? " is-on" : ""}" style="${personPickStyle(n.recipient === r.key)}">${r.av}${esc(r.label)}</button>`)
    .join("");
  const help = n.recipient === "anyone" ? "The first session to claim it gets it." : `Only shows in ${nameOf(p.persons, n.recipient)}'s inbox.`;

  const ctx = n.ctxOpen ? `
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px">
      <div><label style="${MONO_FIELD_LABEL()}">REPO</label>${input("repo", "SaplingLearn/sapling", `width:100%;height:38px;padding:0 12px;${FIELD};font-size:12.5px;font-family:var(--label)`)}</div>
      <div><label style="${MONO_FIELD_LABEL()}">BRANCH</label>${input("branch", "feat/…", `width:100%;height:38px;padding:0 12px;${FIELD};font-size:12.5px;font-family:var(--label)`)}</div>
    </div>
    <label style="${MONO_FIELD_LABEL()};margin:14px 0 6px">TASK</label>
    ${input("task", "One line: what is this session in the middle of?", `width:100%;height:38px;padding:0 12px;${FIELD};font-size:13.5px`)}
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px">
      <div><label style="${MONO_FIELD_LABEL("var(--green)")}">DONE <span style="color:var(--fg-40);font-weight:500;letter-spacing:0">· one per line</span></label>${area("done", "", `width:100%;min-height:96px;padding:9px 12px;${FIELD};font-size:13px;line-height:1.55;resize:vertical;font-family:inherit`)}</div>
      <div><label style="${MONO_FIELD_LABEL("var(--accent)")}">NEXT <span style="color:var(--fg-40);font-weight:500;letter-spacing:0">· one per line</span></label>${area("next", "", `width:100%;min-height:96px;padding:9px 12px;${FIELD};font-size:13px;line-height:1.55;resize:vertical;font-family:inherit`)}</div>
    </div>
    <label style="${MONO_FIELD_LABEL()};margin:14px 0 6px">FILES TOUCHED <span style="font-weight:500;letter-spacing:0">· one per line</span></label>
    ${area("files", "backend/routes/documents.py", `width:100%;min-height:76px;padding:9px 12px;${FIELD};font-size:12.5px;line-height:1.6;resize:vertical;font-family:var(--label)`)}` : "";

  const canSend = !!n.body.trim();
  return `<div data-screen-label="New handoff" style="${WORK_SHELL}">
  <div${surface("padding:26px 28px;display:flex;flex-direction:column;min-height:calc(100vh - 210px)")}>
    <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 288px;gap:32px;flex:1;min-height:0">
      <div style="min-width:0;display:flex;flex-direction:column">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Message <span style="font-weight:400;color:var(--fg-40)">— markdown · the first line is the title</span></label>
        ${area("body", "What should the next session know? Start with one line that says where things stand.", `width:100%;flex:1;min-height:220px;padding:10px 13px;${FIELD};font-size:13.5px;line-height:1.6;resize:vertical;font-family:inherit`)}
        ${first ? `<div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Shows in the list as <span style="color:var(--fg-70);font-weight:500">${esc(first)}</span></div>` : ""}
        <div style="display:flex;align-items:baseline;gap:10px;margin-top:22px">
          <label style="display:block;font-size:13px;font-weight:500;white-space:nowrap">Context <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
          <button data-act="nhCtxToggle" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:500;color:var(--fg-40);white-space:nowrap">${n.ctxOpen ? "Hide" : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Add repo, branch, task…`}</button>
        </div>
        ${ctx}
      </div>
      <div style="min-width:0;border-left:1px solid var(--border);padding-left:26px">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Recipient</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${recipients}</div>
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">${esc(help)}</div>
        <label style="display:block;font-size:13px;font-weight:500;margin:20px 0 8px">Prompt <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
        ${input("promptTitle", "Title", `width:100%;height:38px;padding:0 12px;${FIELD};font-size:12.5px`)}
        ${area("promptBody", "Instructions for the session that claims this", `width:100%;min-height:140px;margin-top:8px;padding:9px 12px;${FIELD};font-size:12.5px;line-height:1.6;resize:vertical;font-family:var(--label)`)}
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Belongs to this handoff only. It isn't added to the Prompt Library.</div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
      <button data-act="goHandoffs" class="cnpy-outlinebtn" style="padding:8px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease;white-space:nowrap">Cancel</button>
      <button data-act="nhSend" class="${canSend ? "cnpy-accentbtn" : ""}" style="${primaryStyle(canSend)}">Send handoff</button>
    </div>
  </div>
</div>`;
}
