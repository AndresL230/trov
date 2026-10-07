// In-place DOM patching for the regions that must outlive a rerender: the
// sidebar, any overlay marked `data-overlay` (the connection modal), and a page that opts in
// with `data-morph` (the Artifacts screens, Org settings, Platform). rerender() swaps the rest
// of the app wholesale, which is fine for a screen but fatal for a transition — a width, a
// rotated chevron, an opening sub-page list or a tab bar's sliding underline can only animate
// on an element that SURVIVES the state change. So the <aside> is patched, never replaced.
//
// Deliberately small: nodes pair by index (the sidebar renders a STABLE
// structure — everything is always present and hidden with CSS, never
// conditionally emitted), same-name nodes are patched, anything else is replaced.
// `data-morph-key` names what an element IS: two paired nodes whose keys differ are different
// things (one tab's panel and another's), so the new one replaces the old instead of being
// patched into it — a tab switch swaps the panel whole and leaves the tab bar above it alone.

/** Make `live`'s attributes equal `next`'s. */
export function syncAttrs(live: Element, next: Element): void {
  for (const a of Array.from(live.attributes)) if (!next.hasAttribute(a.name)) live.removeAttribute(a.name);
  for (const a of Array.from(next.attributes)) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
}

/** A form control's LIVE value is a property, not the attribute morph syncs — so bring
 *  it along (a cleared search box must clear). The focused control is left alone: the
 *  person is typing in it, and state already holds what they typed. */
function syncValue(live: Element, next: Element): void {
  if (live === document.activeElement) return;
  if (live instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (live.type === "checkbox" || live.type === "radio") live.checked = next.hasAttribute("checked");
    else if (live.type !== "file" && live.value !== (next.getAttribute("value") ?? "")) live.value = next.getAttribute("value") ?? "";
  } else if (live instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement) {
    if (live.value !== next.value) live.value = next.value;
  } else if (live instanceof HTMLSelectElement && next instanceof HTMLSelectElement) {
    const want = next.querySelector("option[selected]")?.getAttribute("value");
    if (want != null && live.value !== want) live.value = want;
  }
}

/** Patch `live` (and its subtree) to match `next`. Both must be the same element type.
 *  A `data-keep` element is owned by script (the collapsed-rail tooltip) and left alone. */
export function morph(live: Element, next: Element): void {
  if (live.hasAttribute("data-keep")) return;
  syncAttrs(live, next);
  syncValue(live, next);
  const a = Array.from(live.childNodes);
  const b = Array.from(next.childNodes);
  for (let i = 0; i < b.length; i++) {
    const from = a[i];
    const to = b[i];
    if (!from) { live.appendChild(to); continue; }
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { live.replaceChild(to, from); continue; }
    if (from instanceof Element && from.getAttribute("data-morph-key") !== (to as Element).getAttribute("data-morph-key")) { live.replaceChild(to, from); continue; }
    if (from instanceof Element) morph(from, to as Element);
    else if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
  }
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

/** Overlays (toast, sync modal) sit beside the page and are swapped — EXCEPT a
 *  `data-overlay` one present on both sides, which is morphed in place like the
 *  aside, so an open dialog does not replay its entrance on every state change. */
function syncOverlays(liveRoot: Element, nextRoot: Element, livePage: Element, nextPage: Element): void {
  const keyOf = (n: Node): string | null => (n instanceof Element ? n.getAttribute("data-overlay") : null);
  const nextKeys = new Set(Array.from(nextRoot.childNodes).map(keyOf).filter((k): k is string => k !== null));
  const kept = new Map<string, Element>();
  for (const n of Array.from(liveRoot.childNodes)) {
    if (n === livePage) continue;
    const k = keyOf(n);
    if (k !== null && nextKeys.has(k) && !kept.has(k)) kept.set(k, n as Element);
    else n.remove();
  }
  for (const n of Array.from(nextRoot.childNodes)) {
    if (n === nextPage) continue;
    const k = keyOf(n);
    const live = k !== null ? kept.get(k) : undefined;
    if (live) morph(live, n as Element);
    else liveRoot.appendChild(n);
  }
}

/**
 * Paint `html` (a full render() string) into `mount`. When both the live DOM and
 * the new markup are the app shell, the <aside> is morphed and everything else
 * is swapped; a page outside the shell that names itself with `data-morph` (the
 * standalone Platform page) is morphed whole while it stays the same page;
 * otherwise (auth, landing, first paint) it is a plain innerHTML.
 */
export function paint(mount: HTMLElement, html: string): void {
  const liveRoot = mount.firstElementChild;
  const liveShell = liveRoot?.querySelector(":scope > .cnpy-shell");
  const livePage = liveShell ? null : liveRoot?.querySelector(":scope > [data-morph]");
  if (liveRoot && (liveShell || livePage)) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const nextRoot = tpl.content.firstElementChild;
    const nextPage = livePage ? nextRoot?.querySelector(":scope > [data-morph]") : null;
    if (nextRoot && livePage && nextPage && livePage.getAttribute("data-morph") === nextPage.getAttribute("data-morph")) {
      syncAttrs(liveRoot, nextRoot);
      morph(livePage, nextPage);
      syncOverlays(liveRoot, nextRoot, livePage, nextPage);
      return;
    }
    const nextShell = liveShell ? nextRoot?.querySelector(":scope > .cnpy-shell") : null;
    const liveAside = liveShell?.querySelector(":scope > .cnpy-aside");
    const nextAside = nextShell?.querySelector(":scope > .cnpy-aside");
    const liveMain = liveShell?.querySelector(":scope > main");
    const nextMain = nextShell?.querySelector(":scope > main");
    if (nextRoot && liveShell && nextShell && liveAside && nextAside && liveMain && nextMain) {
      syncAttrs(liveRoot, nextRoot);
      morph(liveAside, nextAside);
      // <main> is swapped wholesale — EXCEPT on a screen that opts in with `data-morph`
      // (the Artifacts screens; Org settings and Platform), which is patched in place while
      // it stays the same screen. The Artifacts previews are iframes, and a replaced iframe
      // RELOADS: every state change (opening the filter, hovering it, a menu) flickered every
      // thumbnail and the viewer. Patched, an iframe whose `src` did not change is the same
      // element and stays loaded. On Org settings and Platform it is the tab bar that must
      // survive: a tab switch replaces only the panel under it (`data-morph-key`).
      const liveKey = liveMain.getAttribute("data-morph");
      if (liveKey && liveKey === nextMain.getAttribute("data-morph")) morph(liveMain, nextMain);
      else liveMain.replaceWith(nextMain);
      syncOverlays(liveRoot, nextRoot, liveShell, nextShell);
      return;
    }
  }
  mount.innerHTML = html;
}
