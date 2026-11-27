// Sandboxes: the vocabulary, DTOs and pure rules shared by the Worker and the SPA (docs/architecture/sandboxes.md).
// Zod-free on purpose (CLAUDE.md › Layout): the web app imports values from here.

/** A sandbox's name and a profile's key: lowercase letters, digits and dashes, at most 40. */
export const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SANDBOX_NAME_HINT = "lowercase letters, digits and dashes, starting with a letter or digit, at most 40";

export type SandboxBootState = "none" | "pending" | "booting" | "ready" | "failed";
export type SandboxEventSource = "agent" | "person" | "boot";
export type SandboxSize = "small" | "medium" | "large";

/** What each size asks Daytona for. */
export const SANDBOX_SIZES: Record<SandboxSize, { cpu: number; memory_gib: number; disk_gib: number; label: string }> = {
  small: { cpu: 1, memory_gib: 1, disk_gib: 3, label: "Small · 1 CPU, 1 GB" },
  medium: { cpu: 2, memory_gib: 4, disk_gib: 10, label: "Medium · 2 CPU, 4 GB" },
  large: { cpu: 4, memory_gib: 8, disk_gib: 20, label: "Large · 4 CPU, 8 GB" },
};

/** How long a failure's output tail is kept on its event. */
export const SANDBOX_OUTPUT_KEEP = 1500;
/** A pause longer than this starts a new group of commands. */
export const SANDBOX_STORY_GAP_MS = 15 * 60_000;

// ── routes (cookie, under /api/o/:slug) ─────────────────────────────────────

export const SANDBOXES_ROUTE = "/sandboxes";
export const SANDBOXES_REFRESH_ROUTE = "/sandboxes/refresh";
export const SANDBOX_SETTINGS_ROUTE = "/sandbox-settings";
export const SANDBOX_RULES_ROUTE = "/sandbox-settings/rules";
export const SANDBOX_PROFILES_ROUTE = "/sandbox-profiles";

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface SandboxAccessView {
  /** on: the plan includes sandboxes; not_included: the plan has none; off: Trov turned them off for this org. */
  status: "on" | "off" | "not_included";
  /** How many may exist at once; null = no limit. */
  cap: number | null;
  plan: string;
}

export interface SandboxRules {
  /** Anyone in the org may stop, start or delete a sandbox from the web app (false: admins and owners). */
  members_act: boolean;
  /** Agents may make a sandbox's previews public. */
  public_previews: boolean;
}

export interface SandboxEventView {
  id: number;
  at: string;
  actor: string;
  source: SandboxEventSource;
  tool: string;
  subject: string;
  result: string;
  exit_code: number | null;
  ms: number | null;
  failed: boolean;
  output: string | null;
}

export type SandboxStoryKind = "boot" | "commands" | "background" | "lifecycle";

/** A run of events told as one line. Built from Trov's own record only (CLAUDE.md invariant 16's spirit). */
export interface SandboxStory {
  kind: SandboxStoryKind;
  title: string;
  from: string;
  to: string;
  failed: boolean;
  events: SandboxEventView[];
}

/** What Refresh learned from the runner for one sandbox. Absent until someone presses Refresh. */
export interface SandboxLive {
  at: string;
  state: string | null;
  public: boolean;
  cpu: number | null;
  memory_gib: number | null;
  disk_gib: number | null;
  disk_used_gib: number | null;
  ports: number[];
  processes: string[];
  error: string | null;
}

export interface SandboxRowView {
  id: string;
  name: string;
  profile: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  boot_state: SandboxBootState;
  last_event_at: string | null;
  /** Event counts in the last six hours, 12 buckets of 30 minutes, oldest first. */
  activity: number[];
  stories: SandboxStory[];
  /** Total events kept for it; `stories` hold the latest. */
  event_count: number;
}

export interface SandboxProfileSummary { key: string; name: string; repo: string | null }

export interface SandboxesPage {
  access: SandboxAccessView;
  used: number;
  rules: SandboxRules;
  /** May this viewer stop, start or delete from here? */
  can_act: boolean;
  is_admin: boolean;
  sandboxes: SandboxRowView[];
  /** Gone in the last seven days. */
  history: SandboxRowView[];
  profiles: SandboxProfileSummary[];
  /** The SANDBOX binding exists (false on a local dev Worker without it). */
  runner: boolean;
}

export interface SandboxRefreshAnswer {
  at: string;
  live: Record<string, SandboxLive>;
  degraded?: boolean;
  error?: string;
}

export interface SandboxProfileInput {
  key: string;
  name: string;
  description: string;
  repo: string | null;
  branch: string;
  size: SandboxSize;
  image: string | null;
  setup: string[];
  start_cmd: string | null;
  port: number | null;
  env: Record<string, string>;
  auto_stop: number;
  delete_days: number;
}

export interface SandboxProfileView extends SandboxProfileInput {
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  /** The last few sandboxes booted from it, newest first. */
  boots: { id: string; name: string; at: string; by: string; boot_state: SandboxBootState }[];
}

export interface SandboxSettingsPage {
  access: SandboxAccessView;
  rules: SandboxRules;
  profiles: SandboxProfileView[];
  repos: string[];
}

// ── profile validation (the route's and the editor's) ────────────────────────

export const PROFILE_MAX_SETUP = 20;
export const PROFILE_MAX_ENV = 40;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

export type ProfileCheck = { ok: true; profile: SandboxProfileInput } | { ok: false; error: string };

/** Normalise and check a profile from a form or a request. Every message names what is valid. */
export function checkSandboxProfile(raw: unknown): ProfileCheck {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const key = s("key");
  if (!SANDBOX_NAME_RE.test(key)) return { ok: false, error: `key: ${SANDBOX_NAME_HINT}.` };
  const name = s("name");
  if (!name || name.length > 80) return { ok: false, error: "name: 1 to 80 characters." };
  const description = s("description");
  if (description.length > 500) return { ok: false, error: "description: at most 500 characters." };
  const repo = s("repo") || null;
  if (repo && !REPO_RE.test(repo)) return { ok: false, error: "repo: owner/name, or empty for none." };
  const branch = s("branch") || "main";
  if (!BRANCH_RE.test(branch)) return { ok: false, error: "branch: a branch name." };
  const size = (s("size") || "small") as SandboxSize;
  if (!(size in SANDBOX_SIZES)) return { ok: false, error: "size: small, medium or large." };
  const image = s("image") || null;
  if (image && image.length > 200) return { ok: false, error: "image: at most 200 characters." };
  if (o.setup !== undefined && !Array.isArray(o.setup)) return { ok: false, error: "setup: a list of commands." };
  const setupRaw: unknown[] = Array.isArray(o.setup) ? o.setup : [];
  if (setupRaw.some((x) => typeof x !== "string")) return { ok: false, error: "setup: a list of commands." };
  const setup = (setupRaw as string[]).map((x) => x.trim()).filter(Boolean);
  if (setup.length > PROFILE_MAX_SETUP) return { ok: false, error: `setup: at most ${PROFILE_MAX_SETUP} steps.` };
  if (setup.some((c) => c.length > 2000)) return { ok: false, error: "setup: each step at most 2,000 characters." };
  const start_cmd = s("start_cmd") || null;
  if (start_cmd && start_cmd.length > 2000) return { ok: false, error: "start command: at most 2,000 characters." };
  const port = o.port === null || o.port === undefined || o.port === "" ? null : Number(o.port);
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return { ok: false, error: "port: 1 to 65535, or empty." };
  if (port !== null && !start_cmd) return { ok: false, error: "port: needs a start command to wait for." };
  const envRaw = o.env && typeof o.env === "object" && !Array.isArray(o.env) ? (o.env as Record<string, unknown>) : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) {
    if (!ENV_KEY_RE.test(k)) return { ok: false, error: `env: "${k.slice(0, 40)}" is not a variable name (letters, digits, _).` };
    if (typeof v !== "string" || v.length > 4000) return { ok: false, error: `env: ${k} must be text, at most 4,000 characters.` };
    env[k] = v;
  }
  if (Object.keys(env).length > PROFILE_MAX_ENV) return { ok: false, error: `env: at most ${PROFILE_MAX_ENV} variables.` };
  const auto_stop = o.auto_stop === undefined ? 60 : Number(o.auto_stop);
  if (!(Number.isInteger(auto_stop) && auto_stop >= 0 && auto_stop <= 1440)) return { ok: false, error: "auto stop: 0 to 1440 minutes (0 never)." };
  const delete_days = o.delete_days === undefined ? 7 : Number(o.delete_days);
  if (!(Number.isInteger(delete_days) && delete_days >= 1 && delete_days <= 30)) return { ok: false, error: "delete after: 1 to 30 days." };
  return { ok: true, profile: { key, name, description, repo, branch, size, image, setup, start_cmd, port, env, auto_stop, delete_days } };
}

// ── the story: grouping events into lines ────────────────────────────────────

const LIFECYCLE = new Set(["sandbox_create", "sandbox_start", "sandbox_stop", "sandbox_delete", "sandbox_configure", "sandbox_preview_url", "start", "stop", "delete", "preview"]);
const FILE_TOOLS = new Set(["sandbox_read_file", "sandbox_write_file", "sandbox_list_files"]);

const LIFECYCLE_TITLE: Record<string, string> = {
  sandbox_create: "Created", sandbox_start: "Started", sandbox_stop: "Stopped", sandbox_delete: "Deleted",
  sandbox_configure: "Changed settings", sandbox_preview_url: "Opened a preview link",
  start: "Started", stop: "Stopped", delete: "Deleted", preview: "Opened a preview link",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function commandsTitle(events: SandboxEventView[]): string {
  const cmds = events.filter((e) => e.tool === "sandbox_exec").length;
  const files = new Set(events.filter((e) => FILE_TOOLS.has(e.tool)).map((e) => e.subject)).size;
  const parts = [cmds ? `Ran ${plural(cmds, "command")}` : "", files ? `${cmds ? "touched" : "Touched"} ${plural(files, "file")}` : ""].filter(Boolean);
  const failed = events.filter((e) => e.failed).length;
  return `${parts.join(", ") || "Read output"}${failed ? `; ${plural(failed, "failure")}` : ""}`;
}

/**
 * Group a sandbox's events (any order) into stories, oldest first. The rule is mechanical, so a line never says
 * more than the record does: boot steps are one story; each lifecycle call (create, start, stop, delete, settings,
 * a preview link) is its own; a background command and the log reads of it are one; everything else (commands,
 * file reads and writes) runs together until a lifecycle or background line, or a pause over 15 minutes.
 */
export function sandboxStories(input: readonly SandboxEventView[], profile: string | null = null): SandboxStory[] {
  const events = [...input].sort((a, b) => a.id - b.id);
  const out: SandboxStory[] = [];
  const background = new Map<string, SandboxStory>();
  let boot: SandboxStory | null = null;
  let chunk: SandboxStory | null = null;
  const push = (st: SandboxStory) => { out.push(st); return st; };
  const add = (st: SandboxStory, e: SandboxEventView) => { st.events.push(e); st.to = e.at; if (e.failed) st.failed = true; };

  for (const e of events) {
    if (e.source === "boot") {
      if (!boot) boot = push({ kind: "boot", title: "", from: e.at, to: e.at, failed: false, events: [] });
      add(boot, e);
      continue;
    }
    if (LIFECYCLE.has(e.tool)) {
      chunk = null;
      push({ kind: "lifecycle", title: LIFECYCLE_TITLE[e.tool] ?? e.tool, from: e.at, to: e.at, failed: e.failed, events: [e] });
      continue;
    }
    if (e.tool === "sandbox_run_background") {
      chunk = null;
      const st = push({ kind: "background", title: `Started in the background: ${e.subject}`, from: e.at, to: e.at, failed: e.failed, events: [e] });
      if (e.result) background.set(e.result, st);
      continue;
    }
    if (e.tool === "sandbox_logs" && background.has(e.subject)) {
      add(background.get(e.subject)!, e);
      continue;
    }
    if (chunk && Date.parse(e.at) - Date.parse(chunk.to) <= SANDBOX_STORY_GAP_MS) add(chunk, e);
    else chunk = push({ kind: "commands", title: "", from: e.at, to: e.at, failed: e.failed, events: [e] });
  }
  for (const st of out) {
    if (st.kind === "commands") st.title = commandsTitle(st.events);
    if (st.kind === "boot") {
      const steps = st.events.length;
      const failedAt = st.events.find((x) => x.failed);
      st.title = failedAt
        ? `Boot${profile ? ` from ${profile}` : ""} failed at ${failedAt.subject}`
        : `Booted${profile ? ` from ${profile}` : ""}: ${plural(steps, "step")}`;
    }
  }
  return out;
}

/** Event counts over the last `buckets` × `minutes`, oldest first. */
export function activityBuckets(ats: readonly string[], now: number, buckets = 12, minutes = 30): number[] {
  const out = new Array<number>(buckets).fill(0);
  const span = minutes * 60_000;
  for (const at of ats) {
    const age = now - Date.parse(at);
    if (!(age >= 0)) continue;
    const i = buckets - 1 - Math.floor(age / span);
    if (i >= 0) out[i]++;
  }
  return out;
}
