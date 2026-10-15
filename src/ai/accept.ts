// What an accept handler is (./suggestions.ts registers them by kind). Its own module so a producer's handlers
// (./themes-accept.ts) and the registry import it without importing each other.
import type { AiSuggestionError } from "@shared/ai";
import type { TenantContext } from "../data/context";
import type { AiSuggestionRow } from "../data/ai";

export interface AcceptHandler {
  /** Who may accept this kind: any member, or an admin (admin or owner) of the org. */
  role: "member" | "admin";
  /** Whether `value` (the body's, or the stored one) is a value this kind takes; false is `invalid` (400), decided
   *  BEFORE the suggestion is claimed. Omitted: any value. */
  valid?(value: unknown): boolean;
  /** Write the real field AS `ctx`'s person (the signed-in caller's own context — the author is always the
   *  authenticated principal). `value` is the suggested one, or the person's replacement (Rename). Throw to
   *  refuse: the suggestion goes back to open — an `AcceptRefused` answers with its code, anything else
   *  propagates (a `PlanLimitError` reaches the app's 402 as usual). */
  apply(ctx: TenantContext, suggestion: AiSuggestionRow, value: unknown): Promise<void>;
  /** Who may DISMISS this kind (default: any member). A theme's Remove is an admin's. */
  dismissRole?: "member" | "admin";
  /** What a dismissal also does to the real item (a removed theme), AS `ctx`'s person, after it is recorded.
   *  Never fails the dismissal: a throw is logged. */
  dismissed?(ctx: TenantContext, suggestion: AiSuggestionRow): Promise<void>;
}

/** A handler's refusal, answered with its code (the claim is undone first). */
export class AcceptRefused extends Error {
  constructor(readonly code: AiSuggestionError) {
    super(code);
    this.name = "AcceptRefused";
  }
}
