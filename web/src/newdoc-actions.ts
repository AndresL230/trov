// Library › New page — the controller: every `nd…` act main.ts dispatches lands here (the view is web/src/newdoc.ts,
// pure). A page is staged through POST /api/docs/propose — the gate, exactly as an agent's proposal — with the
// template's body and section and the parent picked in "Goes in"; it then waits in Review.
import type { AppState } from "./render";
import { ApiError, OrgApiError, PreviewBlocked, Unauthorized, proposeDoc } from "./api";
import { blankDoc } from "./newdoc";
import { docTemplate, isDocTemplateId, templateBody, untitledTitle } from "@shared/docs-templates-core";

export interface NewDocHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** Read that space's pages into state.spaceHome unless it already holds them (the pane and the picker show them). */
  ensureSpace(slug: string): void;
  /** After a page was staged: the parent refreshes the space's pages and goes to Review. */
  staged(space: string, slug: string): void;
  /** Cancel: the parent goes back where New page was opened from. */
  cancel(): void;
}

export interface NewDocController {
  /** Handle an nd… act; false when it is not one of yours. */
  act(act: string, arg: string | null, value: string | null): boolean;
  /** Open New page in `space` under `parent` (null = top level). */
  start(space: string, parent: string | null): void;
  /** A handoff's "Promote to doc": the draft prefilled (template blank, the body kept). */
  prefill(p: { title: string; body: string; summary: string; from: number; space: string }): void;
}

/** A refused stage as a sentence. */
export function newDocErrorText(e: unknown): string {
  if (e instanceof PreviewBlocked) return "This is a preview: nothing is changed.";
  if (!(e instanceof ApiError)) return "Couldn't create the page. Check your connection and try again.";
  const msg = (e instanceof OrgApiError ? e.detail : null) ?? e.message;
  if (e.status === 409 && /already exists/.test(msg)) return "A page with that title already exists. Pick another title.";
  return msg ? `Couldn't create the page: ${msg}.`.replace(/\.\.$/, ".") : "Couldn't create the page. Try again.";
}

export function createNewDocController(host: NewDocHost): NewDocController {
  const { state } = host;
  const nd = () => state.nd;

  function start(space: string, parent: string | null): void {
    state.nd = blankDoc(space, parent);
    if (space) host.ensureSpace(space);
    host.rerender();
  }

  function prefill(p: { title: string; body: string; summary: string; from: number; space: string }): void {
    const d = blankDoc(p.space, null);
    const blank = docTemplate("blank");
    state.nd = { ...d, template: "blank", section: blank?.section ?? d.section, title: p.title, body: p.body, bodyTouched: true, summary: p.summary, from: p.from };
    if (p.space) host.ensureSpace(p.space);
    host.rerender();
  }

  function submit(): void {
    const d = nd();
    if (d.busy || !d.space) return;
    const t = docTemplate(d.template);
    const title = d.title.trim() || untitledTitle(d.template);
    // The gate takes no empty body: a page with nothing written yet is its title.
    const body = d.body.trim() ? d.body : `${title}\n`;
    d.busy = true; d.error = null; d.where = false;
    host.rerender();
    const space = d.space;
    const name = state.library.data?.spaces.find((s) => s.slug === space)?.name ?? space;
    proposeDoc({ title, section: d.section || t?.section || "reference", space, body, summary: d.summary.trim() || undefined, ...(d.parent ? { parent_slug: d.parent } : {}) })
      .then((r) => {
        d.busy = false;
        host.flash(r.parent_ignored ? "Staged for review — at the top level: that parent page could not take it" : `Staged for review in ${name}`, r.parent_ignored ? 6000 : undefined);
        host.staged(space, r.slug);
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        d.busy = false; d.error = newDocErrorText(e);
        host.rerender();
      });
  }

  function act(act: string, arg: string | null, value: string | null): boolean {
    const d = nd();
    switch (act) {
      case "ndTemplate": {
        if (!arg || !isDocTemplateId(arg) || d.busy || arg === d.template) return true;
        const t = docTemplate(arg);
        if (!t) return true;
        d.template = arg;
        d.section = t.section;
        if (!d.bodyTouched) d.body = templateBody(t);
        host.rerender();
        return true;
      }
      case "ndField": {
        if (arg !== "title" && arg !== "body" && arg !== "summary") return true;
        d[arg] = value ?? "";
        if (arg === "body") d.bodyTouched = true;
        if (d.error) d.error = null;
        if (arg !== "summary") host.rerender();
        return true;
      }
      case "ndSection": if (arg && !d.busy) { d.section = arg; host.rerender(); } return true;
      case "ndWhere": if (!d.busy) { d.where = !d.where; host.rerender(); } return true;
      case "ndWhereSpace": {
        // A switch's option (arg) or, past four spaces, the dropdown's pick (value).
        const v = arg ?? value;
        if (!v || v === d.space || d.busy) return true;
        d.space = v; d.parent = null; d.whereOpen = {};
        host.ensureSpace(v);
        host.rerender();
        return true;
      }
      case "ndWhereParent": if (arg !== null) { d.parent = arg === "" ? null : arg; host.rerender(); } return true;
      case "ndWhereToggle": if (arg) { d.whereOpen = { ...d.whereOpen, [arg]: !d.whereOpen[arg] }; host.rerender(); } return true;
      case "ndWhereDone": d.where = false; host.rerender(); return true;
      case "ndCancel": if (!d.busy) host.cancel(); return true;
      case "ndSubmit": submit(); return true;
    }
    return false;
  }

  return { act, start, prefill };
}
