// trov-sandbox (workers/sandbox): Trov's private Daytona runner, a second Worker in this repo — docs/architecture/sandboxes.md.
// It has no public URL (workers_dev = false, no routes); the only way in is Trov's Service Binding. Trov signs people in,
// picks the org and checks its plan and ownership; this Worker holds the Daytona key and keeps every op inside the org
// it was told.
//
//   POST /op  { org, actor, op, args }  ->  200 { ok: true, result }  |  4xx/5xx { ok: false, code, error }
import { Daytona, DaytonaError, DEFAULT_API_URL } from "./daytona";
import { OpError, runOp, type OpRequest } from "./ops";

export interface Env {
  DAYTONA_API_KEY: string;
  DAYTONA_API_URL?: string;
}

const STATUS: Record<OpError["code"], number> = { not_found: 404, bad_request: 400, conflict: 409, upstream: 502, unauthorized: 502 };

const reply = (status: number, body: unknown) => Response.json(body, { status });

export async function handle(request: Request, env: Env, fetcher?: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/op") return reply(404, { ok: false, code: "not_found", error: "not found" });
  if (!env.DAYTONA_API_KEY) return reply(503, { ok: false, code: "unavailable", error: "The sandbox runner has no DAYTONA_API_KEY." });

  let body: OpRequest;
  try {
    body = (await request.json()) as OpRequest;
  } catch {
    return reply(400, { ok: false, code: "bad_request", error: "body must be JSON" });
  }
  if (!body || typeof body.org !== "string" || typeof body.actor !== "string" || typeof body.op !== "string") {
    return reply(400, { ok: false, code: "bad_request", error: "org, actor and op are required" });
  }

  const daytona = new Daytona(env.DAYTONA_API_KEY, env.DAYTONA_API_URL || DEFAULT_API_URL, fetcher);
  try {
    const result = await runOp(daytona, { org: body.org, actor: body.actor, op: body.op, args: body.args ?? {} });
    return reply(200, { ok: true, result });
  } catch (e) {
    if (e instanceof OpError) return reply(STATUS[e.code], { ok: false, code: e.code, error: e.message });
    if (e instanceof DaytonaError) {
      // Daytona's own words, never our key (it is only ever in a header).
      if (e.status === 401 || e.status === 403) return reply(502, { ok: false, code: "upstream", error: "Daytona refused the runner's API key." });
      if (e.status === 409) return reply(409, { ok: false, code: "conflict", error: e.message });
      if (e.status >= 400 && e.status < 500) return reply(400, { ok: false, code: "bad_request", error: e.message });
      return reply(502, { ok: false, code: "upstream", error: e.message });
    }
    return reply(500, { ok: false, code: "internal", error: e instanceof Error ? e.message : String(e) });
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;
