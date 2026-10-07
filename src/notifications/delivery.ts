// The delivery seam. The run assembler only knows `Delivery`; local mode writes
// the rendered message to the dev-only bodies table and never touches Resend.
import { type TenantContext, run, nowIso } from "../data/sql";

export interface OutboundMessage {
  idempotencyKey: string;
  userId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string; // the https List-Unsubscribe target (also in the footer); absent for transactional mail (no unsubscribe headers)
}

export interface Delivery {
  mode?: "local" | "resend";
  /** Resolves with the provider's message id (null when there is none, e.g. local). Throws on failure. */
  send(msg: OutboundMessage): Promise<{ id: string | null }>;
}

export function localDelivery(ctx: TenantContext): Delivery {
  return {
    mode: "local",
    async send(msg) {
      await run(
        ctx,
        `INSERT INTO notification_outbox_bodies (org_id, idempotency_key, to_address, subject, html, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId,
        msg.idempotencyKey,
        msg.to,
        msg.subject,
        msg.html,
        msg.text,
        nowIso()
      );
      return { id: null };
    },
  };
}
