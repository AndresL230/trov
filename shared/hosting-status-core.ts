// ONE answer to "is this host connected?" (repo-setups Phase 0). Every surface that says it reads it from here:
// the provider's card on Org settings › Hosting, a part's row, the setup checklist, the tab's lead, Test this part,
// and the Repo dashboard's not-connected copy — so no two of them can disagree.
//
// The question is always about the provider's ORG-WIDE connection (scope ""): every hosting provider is connected
// once for the whole organization. A credential stored under a non-empty scope for a hosting provider (Railway's
// per-environment PROJECT tokens from before 0057) is a LEFTOVER — never a connection: it is not counted, it is not a
// card, and it is never called Connected (`isLeftover`).
//
// Zod-free (like shared/hosting.ts, its only import): the SPA imports it as a value (the `*-core.ts` rule), and so do
// src/hosting/ and src/tools/repo.ts (which is reachable from src/mcp.ts — nothing here touches a credential).
import { hostingRevokedReasonText, type ConnectionStatus, type HostingConnectionDTO, type HostingProviderId } from "./hosting";

/** What a person reads: the state, its word, and whether the parts can read the host. */
export interface HostingStatus {
  /**
   *   connected      a credential is stored (or SaplingLearn's legacy Worker secret answers) and its last use was fine
   *   error          a credential is stored, and its last use failed
   *   not_connected  nothing answers — never connected, disconnected here, or a stored row we cannot use
   *   revoked        the connection was ended on the PROVIDER's side (uninstalled there, or the grant refused) and
   *                  nothing replaced it — said until it is connected again. An admin's own Disconnect is
   *                  `not_connected`, never this.
   */
  state: ConnectionStatus;
  /** "Connected", "Error", "Not connected", "Removed". */
  word: string;
  /** A credential answers, so the parts read: connected, error, or the legacy fallback. */
  live: boolean;
  /** A credential is STORED here (Manage, Rotate, Disconnect apply). The legacy fallback is live, not stored. */
  stored: boolean;
}

export const HOSTING_STATUS_WORD: Record<ConnectionStatus, string> = { connected: "Connected", error: "Error", not_connected: "Not connected", revoked: "Removed" };

/** The facts a connection's status is derived from — a subset of `HostingConnectionDTO`, so the Repo dashboard
 *  (which never builds that DTO) can pass its own reads. `revoked_reason` is the DTO's display text. */
export type ConnectionFacts = Pick<HostingConnectionDTO, "status" | "legacy_fallback" | "revoked_reason">;

/** The stored status of a connection, from its secret and its install / OAuth row — the rule
 *  `HostingConnectionDTO.status` documents (src/hosting/connections.ts, and the dashboard's own reads). */
export function storedConnectionStatus(secret: { last_error: string | null } | null, row: { status: string } | null): ConnectionStatus {
  if (secret) return secret.last_error ? "error" : "connected";
  return row?.status === "revoked" ? "revoked" : "not_connected";
}

/** The sentences a PROVIDER-side end ("uninstalled", "refused") reads as in `HostingConnectionDTO.revoked_reason`. */
const lostTexts = (label: string): string[] => [hostingRevokedReasonText("uninstalled", label), hostingRevokedReasonText("refused", label)];

/** Was this connection ended on the PROVIDER's side (uninstalled there, or the grant refused) — not by an admin here? */
export function endedOnProvider(c: ConnectionFacts | null, label: string): boolean {
  return !!c && c.status === "revoked" && c.revoked_reason !== null && lostTexts(label).includes(c.revoked_reason);
}

/** What a provider with NO credential of its own (`via_github` — GitHub deployments, repo setups Phase A) reads as:
 *  live, nothing stored, never "Not connected" — it reads through the org's GitHub connection. */
export const VIA_GITHUB_WORD = "Through GitHub";

/** THE status function: what every surface says about a provider's org-wide connection (null = nothing known of it).
 *  `viaGithub`: the provider has no credential of its own (`HostingProviderDTO.via_github`) — always live. */
export function hostingStatus(c: ConnectionFacts | null, label: string, viaGithub = false): HostingStatus {
  if (viaGithub) return { state: "connected", word: VIA_GITHUB_WORD, live: true, stored: false };
  const stored = !!c && (c.status === "connected" || c.status === "error");
  const legacy = !!c && !stored && c.status !== "revoked" && c.legacy_fallback;
  const state: ConnectionStatus = stored ? c!.status
    : legacy ? "connected"
    : endedOnProvider(c, label) ? "revoked"
    : "not_connected";
  return { state, word: HOSTING_STATUS_WORD[state], live: stored || legacy, stored };
}

/** A credential stored under a non-empty scope for a hosting provider: a leftover, never a connection. */
export const isLeftover = (c: { scope: string }): boolean => c.scope !== "";

/** A provider's ORG-WIDE connection among a list (scope ""), or null. Scoped rows are never it. */
export function orgConnection<C extends { provider: HostingProviderId; scope: string }>(list: readonly C[], provider: HostingProviderId): C | null {
  return list.find((c) => c.provider === provider && !isLeftover(c)) ?? null;
}

/** `hostingStatus` of a provider's org-wide connection among a list. */
export function providerStatus(list: readonly (ConnectionFacts & { provider: HostingProviderId; scope: string })[], provider: HostingProviderId, label: string): HostingStatus {
  return hostingStatus(orgConnection(list, provider), label);
}

/** "Railway isn't connected." — what Test this part says, and the dashboard, when the status is not live. */
export const notConnectedSentence = (label: string): string => `${label} isn't connected.`;

// ── leftovers ────────────────────────────────────────────────────────────────

/** When 0057 moved every provider to one org-wide connection: a scoped credential is from before it. */
export const HOSTING_ORG_WIDE_SINCE = "Oct 15";

/** How a leftover was stored, as words. A token's label comes from how it was stored — never from the provider's
 *  current connection method: the only scoped hosting credentials ever stored were per-environment PROJECT tokens. */
export const LEFTOVER_TOKEN_LABEL = "Project token";

/** The quiet line a provider's card carries while old scoped tokens remain: how many, from when, that nothing reads
 *  them — and, while the provider is not connected, the one thing to do. `tokenWord` is the provider's own name for
 *  what it takes now ("workspace token"). */
export function leftoverLine(count: number, label: string, tokenWord: string, live: boolean): string {
  if (count <= 0) return "";
  const what = count === 1 ? `1 old per-environment token from before ${HOSTING_ORG_WIDE_SINCE} isn't used.` : `${count} old per-environment tokens from before ${HOSTING_ORG_WIDE_SINCE} aren't used.`;
  return live ? what : `${what} Connect ${label} once with ${/^[aeiou]/i.test(tokenWord) ? "an" : "a"} ${tokenWord}.`;
}
