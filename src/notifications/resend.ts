// Resend delivery (canopy-email.md §7) behind the env gate. NOTIFICATIONS_MODE
// absent or "local" → localDelivery (nothing ever reaches Resend); "resend"
// requires RESEND_API_KEY and is a configuration error without it — never a
// silent fallback in production.
import type { Env } from "../env";
import type { TenantContext } from "../data/sql";
import { type Delivery, localDelivery } from "./delivery";

const RESEND_URL = "https://api.resend.com/emails";

/** Bare address out of `Name <addr>` or `addr`. */
export function bareAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

// ── the From header ──────────────────────────────────────────────────────────
// The sending domain is the PLATFORM's (one Resend account, one verified domain), and any org's admin
// can edit `notification_settings.from_address` — so an org contributes a display NAME and nothing else.
// `deliveryFor` applies this to EVERY message (digest, test send, invite, welcome): no caller can pass
// an address of its own. The name's rule is ONE definition, shared with the SPA: shared/sender.ts.
import { PLATFORM_SENDER_NAME, PLATFORM_FROM_ADDRESS, senderNamePart, senderNameProblem } from "@shared/sender";
export {
  PLATFORM_SENDER_NAME, PLATFORM_FROM_ADDRESS, PLATFORM_FROM, SENDER_NAME_MAX, senderNamePart, senderNameProblem, type SenderNameProblem,
} from "@shared/sender";

/**
 * The From header for an org's mail: its display name, the platform's address. Whatever address the
 * stored value carries is dropped, and a name that fails `senderNameProblem` (a row written before the
 * settings route checked it) falls back to the platform's — so the header is always one of a fixed
 * shape: `<safe name> <hello@trov.dev>`.
 */
export function platformFrom(orgFrom: string): string {
  const name = senderNamePart(orgFrom).replace(/\s+/g, " ");
  return `${senderNameProblem(name) === null ? name : PLATFORM_SENDER_NAME} <${PLATFORM_FROM_ADDRESS}>`;
}

/** A header value on one line: control characters (CR / LF included) become spaces. */
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();

export function resendDelivery(opts: { apiKey: string; from: string; fetchImpl?: typeof fetch }): Delivery {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const mailto = `mailto:${bareAddress(opts.from)}?subject=unsubscribe`;
  return {
    mode: "resend",
    async send(msg) {
      const headers = msg.unsubscribeUrl
        ? { "List-Unsubscribe": `<${mailto}>, <${msg.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : undefined;
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: opts.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(headers ? { headers } : {}),
        }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { message?: string };
          detail = j.message ?? "";
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`resend ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const data = (await res.json()) as { id?: string };
      return { id: data.id ?? null };
    },
  };
}

/**
 * The ONE way mail leaves the Worker. `ctx` is the org the mail is sent for: local mode writes its
 * bodies to that org's dev table. `opts.from` is the org's `from_address` SETTING — only its display
 * name survives (`platformFrom`) — and every subject is flattened to one line.
 */
export function deliveryFor(ctx: TenantContext, env: Env, opts: { from: string; fetchImpl?: typeof fetch }): Delivery & { mode: "local" | "resend" } {
  const mode = env.NOTIFICATIONS_MODE ?? "local";
  const safe = (inner: Delivery): Delivery => ({ ...inner, send: (msg) => inner.send({ ...msg, subject: oneLine(msg.subject) }) });
  if (mode !== "resend") return { ...safe(localDelivery(ctx)), mode: "local" };
  if (!env.RESEND_API_KEY) throw new Error("NOTIFICATIONS_MODE=resend requires the RESEND_API_KEY secret");
  return { ...safe(resendDelivery({ apiKey: env.RESEND_API_KEY, from: platformFrom(opts.from), fetchImpl: opts.fetchImpl })), mode: "resend" };
}
