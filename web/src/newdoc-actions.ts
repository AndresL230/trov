// Library › New page — the controller: every `nd…` act main.ts dispatches lands here (the view is web/src/newdoc.ts,
// pure). Two steps: picking a template (`ndTemplate`) seeds the body and the section and moves on to the details;
// "Change template" (`ndStep`) goes back. A page is staged through POST /api/docs/propose — the gate, exactly as an
// agent's proposal — with the parent picked in "Goes in"; it then waits in Review, and the person lands on it.
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
  /** After a page was staged: the parent refreshes the space's pages and opens the new page. */
  staged(space: string, slug: string): void;
  /** Cancel: the parent goes back where New page was opened from. */
  cancel(): void;
}

export interface NewDocController {
  /** Handle an nd… act; false when it is not one of yours. */
  act(act: string, arg: string | null, value: string | null): boolean;
  /** Open New page in `space` under `parent` (null = top level). */
  start(space: string, parent: string | null): void;
  /** A handoff's "Promote to doc": the draft prefilled on step 2 (template blank, the body kept). */
  prefill(p: { title: string; body: string; summary: string; from: number; space: string }): void;
}

/** A refused stage as a sentence. */
export function newDocErrorText(e: unknown): string {
  if (e instanceof PreviewBlocked) return "This is a preview: nothing is changed.";
  if (!(e instanceof ApiError)) return "Couldn't create the page. Check your connection and try again.";
  const msg = (e instanceof OrgApiError ? e.detail : null) ?? e.message;
  if (e.status === 409 && /already exists/.test(msg)) return "A page with that title already exists. Pick another title.";
  if (e.status === 409 && /^an archived page is named /.test(msg)) return "An archived page has that name. Pick another title, or restore that page from its space's Archived pages.";
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
    state.nd = { ...d, step: "details", template: "blank", section: blank?.section ?? d.section, title: p.title, body: p.body, bodyTouched: true, summary: p.summary, from: p.from };
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
        // The design's toast (owner ruling NP9: the page is staged, and the person lands on it, "Not yet approved").
        host.flash(r.parent_ignored ? `Page created in ${name}, at the top level: that parent page could not take it` : `Page created in ${name}`, r.parent_ignored ? 6000 : undefined);
        host.staged(space, r.slug);
      })
      .catch((e) => {
        if (e instanceof Unauthorized) { host.unauth(e); return; }
        d.busy = false; d.error = newDocErrorText(e);
        host.rerender();
      });
  }

  /** Move the keyboard focus to `sel` once the step has painted (the mount is a stub in tests). */
  const focus = (sel: string): void => { host.mount.querySelector?.<HTMLElement>(sel)?.focus({ preventScroll: true }); };

  function act(act: string, arg: string | null, value: string | null): boolean {
    const d = nd();
    switch (act) {
      case "ndTemplate": {
        // Step 1's pick: it seeds the page and moves on to the details. A body the person wrote is kept; one that is
        // still the old template's seed (untouched, or typed back to it) takes the new template's.
        if (!arg || !isDocTemplateId(arg) || d.busy) return true;
        const t = docTemplate(arg);
        if (!t) return true;
        if (arg !== d.template) {
          const old = docTemplate(d.template);
          if (!d.bodyTouched || (old && d.body === templateBody(old))) { d.body = templateBody(t); d.bodyTouched = false; }
          d.template = arg;
          d.section = t.section;
        }
        d.step = "details";
        host.rerender();
        focus("#nd-title");
        return true;
      }
      case "ndStep": {
        // "Change template" goes back to step 1 (what was typed is kept), its picked card focused.
        if (d.busy || (arg !== "template" && arg !== "details")) return true;
        d.step = arg; d.where = false;
        host.rerender();
        focus(arg === "template" ? `[data-tpl="${d.template}"]` : "#nd-title");
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
