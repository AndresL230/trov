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

/** `ctx` is the org the mail is sent for: local mode writes its bodies to that org's dev table. */
export function deliveryFor(ctx: TenantContext, env: Env, opts: { from: string; fetchImpl?: typeof fetch }): Delivery & { mode: "local" | "resend" } {
  const mode = env.NOTIFICATIONS_MODE ?? "local";
  if (mode !== "resend") return { ...localDelivery(ctx), mode: "local" };
  if (!env.RESEND_API_KEY) throw new Error("NOTIFICATIONS_MODE=resend requires the RESEND_API_KEY secret");
  return { ...resendDelivery({ apiKey: env.RESEND_API_KEY, from: opts.from, fetchImpl: opts.fetchImpl }), mode: "resend" };
}
