// What an error means and what to do next — said ONCE, for every surface (docs/architecture/web-ui.md ›
// Errors an agent can act on). Zod-free: the Worker reads it (src/error-hints.ts adds `hint` to the JSON
// errors it answers; src/mcp.ts adds it to every tool error) and the public reference prints it
// (/docs/mcp-tools, "Errors").
//
// THE RULES. A hint is chosen by the error's CODE (and, for an HTTP error with no known code, its status)
// and nothing else: never by the path, the id asked for, the caller or anything read from the database.
// So two answers that were identical stay identical — an unknown id and someone else's private one, a
// missing organization and one the caller is not in (CLAUDE.md invariants 4 and 12) — and a hint can name
// no organization, slug, secret or other tenant. A hint is ADDED beside the existing `error` (and any
// `message`); no code or status changes, and nothing that already had a `hint` is touched.

/** The MCP tool errors' `code`s (src/mcp.ts `runTool`, the connection's scope refusals, src/data/bearer.ts). */
export const MCP_ERROR_HINTS: Readonly<Record<string, string>> = {
  not_found:
    "Nothing with that id or slug that you can see here. A missing item and one you may not see answer the same, on purpose. A ticket's or handoff's id is its number in the organization (#12): list first (list_tickets, list_sprints, list_handoffs, artifact_list, search_prompts, query) and use an id from the result.",
  forbidden:
    "Outside what you may do, so nothing was written. Ticket writes need the ticket to be assigned to you already (filing with create_ticket is open; assign_ticket is for an admin, the requester or a current assignee), and update_plan is for admins. Ask the person you work for to assign it to you, or to do it in the Trov web app.",
  conflict:
    "The item's current state does not allow this (it is already in that state, someone else claimed it, or the move would break a rule such as one level of sub-tickets). Nothing was written. Read it again (get_ticket, get_sprint, get_handoff) before deciding what to do.",
  bad_request:
    "An argument is not usable; the error says which. Nothing was written. Fix that argument and call again.",
  too_large:
    "Over the size limit the error names. For a file, pass size_bytes and sha256 and PUT the exact bytes to the returned upload_url instead of sending them inline.",
  gone:
    "The upload or download link has expired (they last 5 minutes) or was already used. Ask for a fresh one: upload_asset or artifact_update for an upload, artifact_get for a download.",
  plan_limit:
    "The organization's plan does not allow more of this; retrying will not help and nothing was written. Tell the person: an owner can upgrade or make room in Trov › Org settings (plans: https://trov.dev/pricing).",
  plan_feature:
    "The organization's plan does not include this; retrying will not help and nothing was written. Tell the person: an owner can change the plan in Trov › Org settings (plans: https://trov.dev/pricing).",
  repo_required:
    "This connection follows the repository you work in: pass `repo` as owner/name (from `git remote get-url origin`) on every call. With no checkout, ask the person which repository they mean. Nothing was read or written.",
  not_connected:
    "That repository is not connected to an organization this connection can reach, or the name is wrong. Nothing was read or written. Tell the person; an admin connects it in Trov › Org settings › Repositories. Never retry with another repository just to get an answer.",
  ambiguous_org:
    "More than one of your organizations has that repository. Pass `org` with one of the slugs in `orgs`; ask the person which one they mean.",
  org_unavailable:
    "The connection's current organization is no longer available to you. Pass `org` with one of `orgs` on the call, or call switch_org.",
  org_not_allowed:
    "This connection may not act there. Use one of `orgs`; a person adds an organization to the connection in Trov › Settings › MCP access.",
  not_member:
    "The person you named (or the author of that PR or branch, or that ticket's assignee) is not a member of this organization, so nothing was written. Check handles with list_people, or ask the person you work for who to link with.",
  limit:
    "Over a limit the error names (notes per side of a link, notes per hour, or live links per person). Nothing was written. When `retry_after` is given wait that many seconds; otherwise close a link first. Retrying at once will not help.",
};

/** A tool error with no code (an unexpected failure). */
export const MCP_FALLBACK_HINT =
  "The call failed and nothing is known to have been written. Check the arguments against the tool's input schema and try once more; if it fails the same way, tell the person.";

/** The hint for an MCP tool error's code. */
export const mcpErrorHint = (code: string | undefined): string => (code && MCP_ERROR_HINTS[code]) || MCP_FALLBACK_HINT;

/** The JSON errors of the HTTP API, by their `error` value (some are older sentences, kept as they are). */
export const API_ERROR_HINTS: Readonly<Record<string, string>> = {
  unauthorized:
    "Not signed in, or the session ended. The API takes the session cookie a browser gets by signing in at https://trov.dev/; it never takes a token. An agent uses the MCP server at /mcp instead.",
  forbidden:
    "Signed in, but this needs a role you do not have in this organization (admin or owner), or it is a signed-in person's own action that a token can never take (promote, ratify, publish). Nothing was changed. Ask an admin of the organization.",
  "admin only":
    "Only an admin or owner of this organization can do this. Nothing was changed. Ask an admin.",
  not_found:
    "Nothing at this address that you can see. A missing item and one in an organization you are not in answer the same, on purpose. Check the id or slug, or list what exists first.",
  "not found":
    "Nothing at this address that you can see. A missing item and one in an organization you are not in answer the same, on purpose. Check the id or slug, or list what exists first.",
  org_required:
    "This older address works only for a person in exactly one organization. Use the organization's own path, /api/o/<your-org>/…; GET /api/orgs lists yours.",
  plan_limit:
    "The organization's plan does not allow more of this; retrying will not help and nothing was changed. `message` names the limit. An owner can upgrade or make room in Org settings (plans: https://trov.dev/pricing).",
  plan_feature:
    "The organization's plan does not include this; nothing was changed. An owner can change the plan in Org settings (plans: https://trov.dev/pricing).",
  rate_limited:
    "Too many of these from you in this window. Wait `retry_after` seconds (also the Retry-After header) before trying again; nothing was changed.",
  "invalid payload":
    "The request body is not what this route takes; `issues`, when present, names the field. Nothing was changed.",
  "invalid id":
    "The id in the address is not a number this route takes. Nothing was changed.",
  temporarily_unavailable:
    "A service Trov depends on did not answer. Nothing was changed; try again in a moment.",
  gone:
    "The link has expired (upload and download links last 5 minutes) or was already used. An agent asks for a fresh one: artifact_get for a download, upload_asset or artifact_update for an upload.",
  "temporarily unavailable":
    "A service Trov depends on did not answer. Nothing was changed; try again in a moment.",
  // ── The AI routes' own refusals (docs/architecture/ai.md; owner ruling F-1, 2026-10-16) ──
  off:
    "This organization's AI switch is off (Org settings › AI): nothing was sent to a model and nothing was changed. An admin or owner can turn it on there; retrying will not help until then.",
  no_key:
    "Trov's AI is not set up on this deployment (it has no model key), so nothing was sent and nothing was changed. Retrying will not help; whoever runs this Trov adds the key.",
  unreadable:
    "Trov could not turn those words into a filter on this screen; `message` says what this screen can filter by and which words were not a filter here. Nothing was changed. Rephrase and try again.",
  auto_off:
    "An admin turned Auto off for this organization (Org settings › AI), so Ask Trov asks before every change. Nothing was sent; ask again without Auto.",
  mode_unavailable:
    "That Ask Trov mode is not on this organization's plan; `modes`, when present, lists the ones it offers. Nothing was sent or changed; pick one of those.",
};

/** By HTTP status, for an error whose code has no line above. */
export const STATUS_HINTS: Readonly<Record<number, string>> = {
  400: "The request is not one this route takes; `message` or `issues`, when present, says what. Nothing was changed.",
  401: API_ERROR_HINTS.unauthorized,
  402: API_ERROR_HINTS.plan_limit,
  403: API_ERROR_HINTS.forbidden,
  404: API_ERROR_HINTS.not_found,
  409: "The current state does not allow this (it already happened, or another change got there first). Read the item again before deciding. Nothing was changed.",
  410: "The link has expired or was already used. Ask for a fresh one (an agent calls artifact_get or upload_asset again).",
  413: "The body is over the size limit; `message`, when present, gives it. Nothing was changed.",
  429: API_ERROR_HINTS.rate_limited,
  500: "Something failed on Trov's side. Nothing is known to have been changed; try again, and if it repeats, report it from the app's bug button.",
  502: "A service Trov depends on answered with an error. Nothing is known to have been changed; try again in a moment.",
  503: API_ERROR_HINTS.temporarily_unavailable,
};

/** The hint for an HTTP JSON error, or null when neither its code nor its status has one. */
export function apiErrorHint(status: number, code: unknown): string | null {
  if (typeof code === "string" && API_ERROR_HINTS[code]) return API_ERROR_HINTS[code];
  return STATUS_HINTS[status] ?? null;
}

/** /mcp's 401 (src/auth/oauth.ts `mcpUnauthorized`): with no token, and with one that was refused. */
export const MCP_UNAUTHORIZED_HINT =
  "Sign in to use Trov's MCP server: it uses OAuth 2.1 with PKCE. The WWW-Authenticate header points at its metadata (RFC 9728), so an MCP client that supports OAuth (Claude Code: run /mcp, choose trov, then Authenticate) opens the browser sign-in itself. Setup for each client: https://trov.dev/docs/connect";
export const MCP_INVALID_TOKEN_HINT =
  "The bearer token was not accepted: it is mistyped, revoked or expired, or its person has no organization left that it can act in. Sign in again through your MCP client (Claude Code: /mcp, choose trov, then Authenticate); a pasted trov_mcp_ token that was revoked cannot be renewed. Setup: https://trov.dev/docs/connect";
