// The controller for Settings › Delete account and Org settings › General › Delete organization (the views
// are deletion.ts). Every `acctDel…` and `orgDel…` act main.ts dispatches lands here. Platform's two deletions
// are platform-actions.ts's (the same views, the superadmin's routes).
//
// The confirmation is the ONE modal (confirm.ts) with a typed field: arming it reads what the deletion would
// do first (the server's preview — the guard rails, the organizations that go with an account, a paid plan),
// then opens with the field focused; every keystroke is a plain rerender (the page and the overlay are both
// patched in place, so the field keeps its focus). Go re-checks the typed value and sends; the server
// re-checks everything. A success leaves the app: an account's deletion signs the person out and lands on the
// public site, an organization's on wherever the person still belongs — each with a short confirmation
// (main.ts's boot reads `?deleted=`).
import { OrgApiError, Unauthorized, deleteMyAccount, deleteOrg, getAccountDeletion, getOrgDeletion } from "./api";
import { typedMatches } from "./confirm";
import { ACCOUNT_DELETE_ID, ORG_DELETE_ID, initialDeleteUi, type DeleteUi } from "./deletion";
import type { AccountDeletionPreview, OrgDeletionPreview } from "@shared/deletion-core";

export interface DeletionHost {
  state: { acctDelete: DeleteUi<AccountDeletionPreview>; org: { del: DeleteUi<OrgDeletionPreview> }; orgSlug: string | null };
  mount: HTMLElement;
  rerender(): void;
  unauth(e: unknown): void;
  /** The confirmation modal's exit animation, then `then` (main.ts). */
  confirmOut(then: () => void): void;
  /** Leave the app for `href` (a page load: everything held in memory is the deleted account's or org's). */
  leave(href: string): void;
}

/** Where each deletion lands, and what the landing says (main.ts reads it once and drops it). */
export const DELETED_PARAM = "deleted";
export const DELETED_SENTENCE: Record<"account" | "org", string> = {
  account: "Your account has been deleted, and you are signed out.",
  org: "The organization has been deleted. Its members keep their Trov accounts.",
};

/** A refused deletion, as the sentence the modal shows. */
export function deletionFailure(e: unknown): string {
  if (e instanceof OrgApiError && e.detail) return e.detail;
  if (e instanceof OrgApiError && e.status === 403) return "You can't delete this.";
  return "That didn't go through, and nothing was deleted. Check your connection and try again.";
}

export function createDeletion(h: DeletionHost) {
  const focus = (sel: string): void => { h.mount.querySelector<HTMLElement>(sel)?.focus(); };

  /** Settings: read what deleting the account would do (shown in the tile, and needed to open the confirmation). */
  async function loadAccount(): Promise<void> {
    const d = h.state.acctDelete;
    if (d.preview.status === "loading") return;
    h.state.acctDelete = { ...d, preview: { status: "loading", data: d.preview.data } };
    h.rerender();
    try {
      h.state.acctDelete = { ...h.state.acctDelete, preview: { status: "ok", data: await getAccountDeletion() } };
    } catch (e) {
      if (e instanceof Unauthorized) { h.unauth(e); return; }
      h.state.acctDelete = { ...h.state.acctDelete, preview: { status: "error", data: h.state.acctDelete.preview.data } };
    }
    h.rerender();
  }

  async function loadOrg(slug: string): Promise<boolean> {
    const d = h.state.org.del;
    h.state.org.del = { ...d, preview: { status: "loading", data: null }, error: null };
    try {
      h.state.org.del = { ...h.state.org.del, preview: { status: "ok", data: await getOrgDeletion(slug) } };
      return true;
    } catch (e) {
      if (e instanceof Unauthorized) { h.unauth(e); return false; }
      h.state.org.del = { ...h.state.org.del, preview: { status: "error", data: null }, error: deletionFailure(e) };
      h.rerender();
      return false;
    }
  }

  function act(a: string, _arg: string | null, value: unknown): void {
    const acct = h.state.acctDelete;
    const org = h.state.org.del;
    switch (a) {
      // ── Settings › Delete account ──
      case "acctDelLoad": void loadAccount(); return;
      case "acctDelArm":
        void (async () => {
          if (acct.preview.status !== "ok") await loadAccount();
          const p = h.state.acctDelete.preview.data;
          if (!p || p.blockers.length) return; // the tile says why
          h.state.acctDelete = { ...h.state.acctDelete, open: true, typed: "", error: null, busy: false };
          h.rerender();
          focus(`#${ACCOUNT_DELETE_ID}-typed`);
        })();
        return;
      case "acctDelCancel":
        if (!acct.open || acct.busy) return;
        h.confirmOut(() => {
          h.state.acctDelete = { ...h.state.acctDelete, open: false, typed: "", error: null };
          h.rerender();
          focus(`[aria-controls="${ACCOUNT_DELETE_ID}"]`);
        });
        return;
      case "acctDelTyped":
        h.state.acctDelete = { ...acct, typed: typeof value === "string" ? value : "" };
        h.rerender();
        return;
      case "acctDelGo": {
        const p = acct.preview.data;
        if (!acct.open || acct.busy || !p || !typedMatches({ expected: p.confirm, value: acct.typed })) return;
        h.state.acctDelete = { ...acct, busy: true, error: null };
        h.rerender();
        deleteMyAccount(acct.typed.trim())
          .then(() => h.leave(`/?${DELETED_PARAM}=account`))
          .catch((e) => {
            if (e instanceof Unauthorized) { h.unauth(e); return; }
            h.state.acctDelete = { ...h.state.acctDelete, busy: false, error: deletionFailure(e) };
            h.rerender();
            // A guard rail that appeared since the preview: read it again, so the tile says what it is.
            if (e instanceof OrgApiError && e.message === "blocked") void loadAccount();
          });
        return;
      }

      // ── Org settings › General › Delete organization ──
      case "orgDelArm": {
        const slug = h.state.orgSlug;
        if (!slug || org.open) return;
        void (async () => {
          if (!(await loadOrg(slug))) return;
          h.state.org.del = { ...h.state.org.del, open: true, typed: "", error: null, busy: false };
          h.rerender();
          focus(`#${ORG_DELETE_ID}-typed`);
        })();
        return;
      }
      case "orgDelCancel":
        if (!org.open || org.busy) return;
        h.confirmOut(() => {
          h.state.org.del = initialDeleteUi<OrgDeletionPreview>();
          h.rerender();
          focus(`[aria-controls="${ORG_DELETE_ID}"]`);
        });
        return;
      case "orgDelTyped":
        h.state.org.del = { ...org, typed: typeof value === "string" ? value : "" };
        h.rerender();
        return;
      case "orgDelGo": {
        const p = org.preview.data;
        const slug = h.state.orgSlug;
        if (!org.open || org.busy || !p || !slug || !p.billing_ready || !typedMatches({ expected: p.confirm, value: org.typed })) return;
        h.state.org.del = { ...org, busy: true, error: null };
        h.rerender();
        deleteOrg(slug, org.typed.trim())
          .then(() => h.leave(`/?${DELETED_PARAM}=org`))
          .catch((e) => {
            if (e instanceof Unauthorized) { h.unauth(e); return; }
            h.state.org.del = { ...h.state.org.del, busy: false, error: deletionFailure(e) };
            h.rerender();
          });
        return;
      }
    }
  }

  return { act, loadAccount };
}
