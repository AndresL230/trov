import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { run, nowIso } from "./helpers/db";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_B } from "./helpers/tenant";
import type { SidebarBadges } from "@shared/badges";
import type { HandoffView } from "@shared/handoffs";
import type { LinkView } from "@shared/links";

// GET /badges is the sidebar's counts in one batch, standing in for the seven lists the boot used to
// fetch only to count. Every count must equal the length of the list it stands for — on rows that
// count, rows that must not, and another org's rows.

const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } }, env);
const json = async <T>(path: string, cookie: string): Promise<T> => {
  const res = await get(path, cookie);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};

async function seedEverything(): Promise<void> {
  const T = nowIso();
  // Proposals: a staged version newer than live counts; an older staged one, a promoted one and a
  // rejected one do not.
  await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('gate', 'reference', 'Gate', 'live', 2, ?, 'andres')`, T);
  for (const [v, status] of [[1, "promoted"], [2, "promoted"], [3, "staged"], [4, "rejected"]] as const)
    await run(env.DB, `INSERT INTO doc_versions (slug, version, body, status, created_at, created_by) VALUES ('gate', ?, 'b', ?, ?, 'andres')`, v, status, T);
  await run(env.DB, `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by) VALUES ('old', 'reference', 'Old', 'live', 3, ?, 'andres')`, T);
  await run(env.DB, `INSERT INTO doc_versions (slug, version, body, status, created_at, created_by) VALUES ('old', 2, 'b', 'staged', ?, 'andres')`, T);
  // Decisions: drafts count; ratified and rejected do not.
  for (const status of ["draft", "draft", "ratified", "rejected"])
    await run(env.DB, `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by) VALUES ('A', 'c', 'd', 'r', ?, 'high', ?, 'andres')`, status, T);
  // Unplaced: unresolved only.
  await run(env.DB, `INSERT INTO needs_triage (raw, reason, created_at) VALUES ('{}', 'a', ?)`, T);
  await run(env.DB, `INSERT INTO needs_triage (raw, reason, created_at, resolved) VALUES ('{}', 'b', ?, 1)`, T);
  // Logins: pending only.
  await run(env.DB, `INSERT INTO identity_tasks (login, first_seen, status) VALUES ('mystery-dev', ?, 'pending')`, T);
  await run(env.DB, `INSERT INTO identity_tasks (login, first_seen, status) VALUES ('gone-dev', ?, 'discarded')`, T);
  // Handoffs: pending and addressed to me (any case) count; `anyone`, someone else's, and a claimed one do not.
  for (const [recipient, status] of [["andres", "pending"], ["ANDRES", "pending"], ["anyone", "pending"], ["meilin", "pending"], ["andres", "claimed"]] as const)
    await run(env.DB, `INSERT INTO handoffs (sender, recipient, body, status, created_at, expires_at) VALUES ('meilin', ?, 'b', ?, ?, '2099-01-01T00:00:00Z')`, recipient, status, T);
  // Prompts: the latest version's status is the prompt's; a deleted prompt is gone.
  const prompt = async (slug: string, versions: string[], deleted = false) => {
    await run(env.DB, `INSERT INTO prompts (slug, title, author, current_version, created_at, updated_at, deleted_at) VALUES (?, 'P', 'andres', ?, ?, ?, ?)`, slug, versions.length, T, T, deleted ? T : null);
    for (const [i, status] of versions.entries())
      await run(env.DB, `INSERT INTO prompt_versions (slug, version, status, author, summary, body, created_at) VALUES (?, ?, ?, 'andres', '', 'b', ?)`, slug, i + 1, status, T);
  };
  await prompt("staged-now", ["published", "staged"]);
  await prompt("was-staged", ["staged", "published"]);
  await prompt("deleted-staged", ["staged"], true);
  // Tickets: one open, unassigned, native ticket.
  await run(env.DB, `INSERT INTO tickets (title, requester, status, created_at, updated_at) VALUES ('Open', 'andres', 'submitted', ?, ?)`, T, T);
  // Links: a request sent to me (any case) counts; a draft, an open link, a declined one, one I sent and one
  // sent to someone else do not.
  const link = (state: string, requester: string, recipient: string, orgId = "org_saplinglearn") =>
    run(env.DB, `INSERT INTO agent_links (org_id, state, topic_kind, topic_ref, reason, requester, recipient, created_at, expires_at)
                 VALUES (?, ?, 'person', ?, 'r', ?, ?, ?, '2099-01-01T00:00:00Z')`, orgId, state, recipient, requester, recipient, T);
  for (const [state, requester, recipient] of [
    ["requested", "meilin", "andres"], ["requested", "meilin", "ANDRES"], ["draft", "meilin", "andres"], ["open", "meilin", "andres"],
    ["declined", "meilin", "andres"], ["requested", "andres", "meilin"], ["requested", "AndresL230", "meilin"],
  ] as const) await link(state, requester, recipient);
  // Another org's rows never count here.
  await link("requested", "x", "andres", ORG_B);
  await run(env.DB, `INSERT INTO adrs (org_id, title, context, decision, rationale, status, confidence, created_at, created_by) VALUES (?, 'B', 'c', 'd', 'r', 'draft', 'high', ?, 'x')`, ORG_B, T);
  await run(env.DB, `INSERT INTO needs_triage (org_id, raw, reason, created_at) VALUES (?, '{}', 'b', ?)`, ORG_B, T);
  await run(env.DB, `INSERT INTO handoffs (org_id, sender, recipient, body, created_at, expires_at) VALUES (?, 'x', 'andres', 'b', ?, '2099-01-01T00:00:00Z')`, ORG_B, T);
}

describe("GET /badges", () => {
  it("counts exactly what each list it stands for holds", async () => {
    await seedPerson("meilin");
    const cookie = await cookieFor("andres");
    await seedEverything();

    const badges = await json<SidebarBadges>("/badges", cookie);
    const proposals = (await json<{ proposals: unknown[] }>("/proposals", cookie)).proposals;
    const drafts = (await json<{ adrs: unknown[] }>("/adrs?status=draft", cookie)).adrs;
    const unplaced = (await json<{ items: unknown[] }>("/needs-triage", cookie)).items;
    const logins = (await json<{ tasks: unknown[] }>("/identity-tasks", cookie)).tasks;
    const tickets = (await json<{ count: number }>("/tickets/badge", cookie)).count;
    const handoffs = (await json<{ handoffs: HandoffView[] }>("/api/handoffs?box=mine", cookie)).handoffs;
    const prompts = (await json<{ prompts: { status: string }[] }>("/api/prompts", cookie)).prompts;
    const links = (await json<{ links: LinkView[] }>("/api/links?box=waiting", cookie)).links;

    expect(badges).toEqual({
      proposals: proposals.length,
      decisions: drafts.length,
      unplaced: unplaced.length,
      logins: logins.length,
      tickets,
      // the web's handoffsForMe: pending, addressed to me in any case — `anyone` is not me
      handoffs: handoffs.filter((h) => h.status === "pending" && h.recipient.toLowerCase() === "andres").length,
      // link requests waiting for me — the web adds them to the Handoffs badge; `handoffs` stays handoffs only
      links: links.length,
      prompts: prompts.filter((p) => p.status === "staged").length,
    });
    // …and the seed above is not vacuous: each count is the one it was built to be.
    expect(badges).toEqual({ proposals: 1, decisions: 2, unplaced: 1, logins: 1, tickets: 1, handoffs: 2, links: 2, prompts: 1 });
  });

  it("a failed read degrades: the badges and the waiting list are a 503 { error }, never a 500", async () => {
    const cookie = await cookieFor("andres");
    // Sessions resolve first; only the links statements hit the broken binding.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/FROM agent_links/.test(sql)) throw new Error("D1 is down");
            return realPrepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const badges = await app.request("/badges", { headers: { cookie } }, { ...env, DB });
    expect(badges.status).toBe(503);
    expect(await badges.json()).toEqual({ error: "badges unavailable" });
    const waiting = await app.request("/api/links?box=waiting", { headers: { cookie } }, { ...env, DB });
    expect(waiting.status).toBe(503);
    expect(await waiting.json()).toEqual({ error: "links unavailable", degraded: true });
  });
});
