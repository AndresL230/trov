import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { ingestEvent } from "../src/consumer";
import { storePrSummary } from "../src/tools/summarize";
import { seedPerson } from "./helpers/persons";
import type { CapturedEvent } from "@shared/contract";
import type { DashboardData } from "@shared/dashboard";

async function cookieFor(login: string): Promise<string> {
  await seedPerson(login);
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

function mergedPrEvent(number: number, login: string, occurredAt: string): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:merged`,
    event_type: "pr_merged",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      pr: {
        number,
        title: `PR ${number}`,
        body: "some body",
        html_url: `https://github.com/o/r/pull/${number}`,
        merged: true,
        merged_at: occurredAt,
        closed_at: occurredAt,
        user: { login },
        milestone: null, // GitHub's own key — not Canopy vocabulary
      },
    }),
    provenance: "webhook",
    occurred_at: occurredAt,
  };
}

function openIssueEvent(number: number, login: string, updatedAt: string): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:opened:${updatedAt}`,
    event_type: "issue",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      action: "opened",
      issue: {
        number,
        title: `[P1] Fix the widget`,
        html_url: `https://github.com/o/r/issues/${number}`,
        state: "open",
        updated_at: updatedAt,
        user: { login },
        assignees: [{ login }],
        labels: ["bug"],
        milestone: null, // GitHub's own key — not Canopy vocabulary
      },
    }),
    provenance: "webhook",
    occurred_at: updatedAt,
  };
}

describe("GET /me/dashboard (session-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/me/dashboard", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the two-list My Work projection for the principal", async () => {
    const now = new Date().toISOString();
    const pr = mergedPrEvent(1, "AndresL230", now);
    await ingestEvent(env.DB, pr, "github-webhook");
    await storePrSummary(env.DB, null, {
      semantic_key: pr.semantic_key,
      pr_number: 1,
      title: "PR 1",
      body: "some body",
    });
    await ingestEvent(env.DB, openIssueEvent(7, "AndresL230", now), "github-webhook");

    const res = await app.request("/me/dashboard", { headers: { cookie: await cookieFor("AndresL230") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardData;

    expect(body.person).toBe("Andres"); // handle resolved server-side via persons
    expect(body.degraded).toBe(false);

    expect(body.previousActivity).toHaveLength(1);
    expect(body.previousActivity[0]).toMatchObject({
      number: 1,
      title: "PR 1",
      url: "https://github.com/o/r/pull/1",
      merged: true,
      what: null, // excerpt fallback (no summarizer) → no structured summary
    });

    expect(body.todo).toHaveLength(1);
    expect(body.todo[0]).toMatchObject({
      number: 7,
      title: "Fix the widget",
      priority: "P1",
      labels: ["bug"],
      url: "https://github.com/o/r/issues/7",
    });

    expect(body.tickets).toEqual([]); // no tickets assigned → the third list is present and empty
    expect(body.ticketsTotal).toBe(0);

    // Revert guard: the old ROADMAP.md/focus dashboard shape is gone for good.
    expect(body).not.toHaveProperty("focus");
    expect(body).not.toHaveProperty("workingNow");
    expect(body).not.toHaveProperty("assignedIssues");
    expect(body).not.toHaveProperty("feed");
  });

  it("carries the third list — open tickets assigned to the principal, never in todo", async () => {
    const cookie = await cookieFor("AndresL230");
    await seedPerson("meilin", { name: "Meilin Zhao", github: false });
    const created = await app.request("/tickets", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "SSO login loops", body: "It bounces me back.", priority: "high", assignees: ["AndresL230"] }),
    }, env);
    expect(created.status).toBe(200);
    // Someone else's ticket must not leak into my dashboard.
    await app.request("/tickets", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Not mine", assignees: ["meilin"] }),
    }, env);

    const res = await app.request("/me/dashboard", { headers: { cookie } }, env);
    const body = (await res.json()) as DashboardData;
    expect(body.tickets.map((t) => t.title)).toEqual(["SSO login loops"]);
    expect(body.tickets[0]).toMatchObject({ status: "submitted", priority: "high", requester: "AndresL230", sprint: null });
    expect(body.todo).toEqual([]); // tickets are a SEPARATE list, never folded into todo
    expect(body.ticketsTotal).toBe(1);
  });
});

describe("GET /docs?fields=meta — the body-less doc list (My Work's Docs you own)", () => {
  it("returns every doc's metadata and no body; plain /docs is unchanged", async () => {
    const cookie = await cookieFor("AndresL230");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by, space) VALUES (?, 'reference', 'Gate', 'SECRET BODY', 2, ?, 'AndresL230', 'technical')`
    ).bind("gate", now).run();

    const meta = (await (await app.request("/docs?fields=meta", { headers: { cookie } }, env)).json()) as { docs: Record<string, unknown>[] };
    expect(meta.docs).toHaveLength(1);
    expect(meta.docs[0]).toMatchObject({ slug: "gate", title: "Gate", current_version: 2, updated_by: "AndresL230", space: "technical" });
    expect(meta.docs[0]).not.toHaveProperty("body");
    expect(JSON.stringify(meta)).not.toContain("SECRET BODY");

    const full = (await (await app.request("/docs", { headers: { cookie } }, env)).json()) as { docs: Record<string, unknown>[] };
    expect(full.docs[0]).toHaveProperty("body", "SECRET BODY");
  });
});
