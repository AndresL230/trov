// Errors an agent can act on (docs/architecture/web-ui.md › Errors an agent can act on). The Worker's JSON
// errors keep their `error` code and status — the SPA and the tests read those — and gain ONE field,
// `hint`: what went wrong and what to do next, chosen by code and status alone (shared/error-hints.ts),
// so two answers that were byte-identical (an unknown id, another organization's) stay identical.
//
// Applied in src/index.ts to what the API, the token routes, /mcp's 401 and the 404 answer — never to a
// webhook's bare 401, which says nothing on purpose. Anything that is not a JSON object with a string
// `error`, already has a `hint`, is a success or answers a HEAD is passed through untouched.
import { apiErrorHint } from "@shared/error-hints";

/** At most this much JSON is read back to add a hint; a larger body (none is) is passed through. */
const MAX_ERROR_BYTES = 64 * 1024;

export async function withErrorHint(request: Request, res: Response): Promise<Response> {
  if (res.status < 400 || request.method === "HEAD" || !res.body || res.webSocket) return res;
  if (!/^application\/json\b/i.test(res.headers.get("content-type") ?? "")) return res;
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_ERROR_BYTES) return res;
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return rebuilt(res, text); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return rebuilt(res, text);
  const b = body as Record<string, unknown>;
  const hint = typeof b.error === "string" && b.hint === undefined ? apiErrorHint(res.status, b.error) : null;
  return rebuilt(res, hint ? JSON.stringify({ ...b, hint }) : text);
}

/** The same response with a new body: status, status text and every header kept, but the length, which
 *  the runtime sets again from the body. */
function rebuilt(res: Response, body: string): Response {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
