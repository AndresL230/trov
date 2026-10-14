// The DOM boot for the public docs pages (/docs/<page>: `docs` pages of shared/site-pages.ts, whose HTML the
// build writes and PRERENDERS from their Markdown — web/src/docs.ts). Unlike the legal and pricing pages it
// never repaints: the page is complete as built, so this script carries none of the docs' text. It only
//   • switches between docs pages IN PLACE: a tab fetches the other page's prerendered HTML and swaps its
//     band and body in (title, description, canonical and Markdown links too), with history entries, so the
//     site nav, the theme and the scroll never reload. Anything that fails falls back to a plain navigation;
//   • switches the theme (the app's own stored choice, `trov.theme`, read as main.ts reads it: the
//     prerendered root is light and THEME_BOOT made it dark before it was parsed if that is the choice);
//   • copies a code block (the `Copy` button over each);
//   • folds the contents on a narrow screen, and marks the section being read.
import "./trov.css";
import { syncFavicon } from "./favicon";
import { migrateBrowserStorage } from "./storage-migrate";

migrateBrowserStorage(); // canopy.* → trov.* before the theme is read

type Theme = "light" | "dark" | "system";
function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("trov.theme");
    if (t === "dark" || t === "light" || t === "system") return t;
    if (t === "midnight") return "dark"; // retired theme, read like the app reads it
  } catch { /* storage unavailable */ }
  return "light";
}

const root = document.querySelector<HTMLElement>("[data-cnpy-theme]");
if (root) {
  let theme = storedTheme();
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const resolved = (): "light" | "dark" => (theme === "system" ? (media?.matches ? "dark" : "light") : theme);
  const apply = () => {
    const t = resolved();
    root.setAttribute("data-cnpy-theme", t);
    document.documentElement.style.background = t === "dark" ? "#1c1a16" : "#f6f6f7";
    syncFavicon(t);
  };
  apply();
  media?.addEventListener?.("change", () => { if (theme === "system") apply(); });

  // Re-read on every use: a page switch replaces the contents.
  const tocEl = (): HTMLElement | null => root.querySelector<HTMLElement>(".site-legal-toc");
  const setToc = (open: boolean, instant = false): void => {
    const toc = tocEl();
    if (!toc) return;
    toc.toggleAttribute("data-instant", instant);
    toc.dataset.open = open ? "1" : "0";
    toc.querySelector("[data-docs-tocb]")?.setAttribute("aria-expanded", String(open));
    if (instant) { void toc.offsetHeight; toc.removeAttribute("data-instant"); }
  };

  root.addEventListener("click", (e) => {
    const target = e.target as Element;
    if (target.closest("[data-docs-theme]")) {
      theme = resolved() === "light" ? "dark" : "light";
      try { localStorage.setItem("trov.theme", theme); } catch { /* ignore */ }
      apply();
      return;
    }
    const copy = target.closest<HTMLButtonElement>("[data-docs-copy]");
    if (copy) {
      const code = copy.closest(".site-docs-code")?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1600);
      }, () => { /* no clipboard: the text is there to select */ });
      return;
    }
    const tab = target.closest<HTMLAnchorElement>(".site-docs-tabs a[href]");
    if (tab) {
      const me = e as MouseEvent;
      if (me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return; // new tab / window
      e.preventDefault();
      void go(tab.getAttribute("href") ?? "", true, me.detail === 0); // detail 0: Enter, not a pointer
      return;
    }
    const toc = tocEl();
    if (target.closest("[data-docs-tocb]")) { setToc(toc?.dataset.open !== "1"); return; }
    const a = target.closest<HTMLElement>("[data-docs-toc]");
    const sec = a ? document.getElementById(a.dataset.docsToc ?? "") : null;
    if (!a || !sec) return;
    e.preventDefault();
    if (toc?.dataset.open === "1") setToc(false, true);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sec.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${sec.id}`);
  });

  // The section whose heading last crossed the top of the window is the one being read.
  let queued = false;
  const spy = () => {
    queued = false;
    let current = "";
    for (const sec of root.querySelectorAll<HTMLElement>(".site-legal-sec")) {
      if (sec.getBoundingClientRect().top > 120) break;
      current = sec.id;
    }
    for (const a of root.querySelectorAll<HTMLElement>("[data-docs-toc]")) {
      if (a.dataset.docsToc === current) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
  spy();

  // ── switching docs pages in place ──
  // A page's HTML is fetched once (hovering a tab starts it), so a switch is usually instant.
  const pages = new Map<string, Promise<Document>>();
  const fetchPage = (path: string): Promise<Document> => {
    let p = pages.get(path);
    if (!p) {
      p = fetch(path, { headers: { Accept: "text/html" } })
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then((html) => new DOMParser().parseFromString(html, "text/html"));
      p.catch(() => pages.delete(path));
      pages.set(path, p);
    }
    return p;
  };
  root.addEventListener("pointerover", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>(".site-docs-tabs a[href]");
    if (a) void fetchPage(a.getAttribute("href") ?? "").catch(() => { /* the click retries */ });
  });
  const swapHead = (next: Document, sel: string, prop: "content" | "href"): void => {
    const to = next.head.querySelector(sel), from = document.head.querySelector(sel);
    if (to && from) from.setAttribute(prop, to.getAttribute(prop) ?? "");
  };
  let seq = 0;
  // The page ON SCREEN — not location's, which Back has already changed when popstate arrives.
  let shown = location.pathname;
  const go = async (path: string, push: boolean, keyboard = false): Promise<void> => {
    const mine = ++seq; // first, so going back to the page on screen also cancels a switch still loading
    if (!path || path === shown) return;
    let next: Document;
    try { next = await fetchPage(path); } catch { location.assign(path); return; }
    if (mine !== seq) return; // a later switch won
    const hero = next.querySelector(".site-docs .site-hero"), main = next.querySelector(".site-docs #site-main");
    const curHero = root.querySelector(".site-docs .site-hero"), curMain = root.querySelector(".site-docs #site-main");
    if (!hero || !main || !curHero || !curMain) { location.assign(path); return; }
    curHero.replaceWith(document.importNode(hero, true));
    curMain.replaceWith(document.importNode(main, true));
    document.title = next.title;
    swapHead(next, 'meta[name="description"]', "content");
    swapHead(next, 'link[rel="canonical"]', "href");
    swapHead(next, 'link[rel="alternate"][type="text/markdown"]', "href");
    shown = path;
    if (push) history.pushState({ docs: path }, "", path);
    window.scrollTo(0, 0);
    spy();
    // The tab that was pressed is gone with the old band: from the keyboard, focus moves to the new page's
    // title so the reader carries on from what just loaded (a mouse click leaves no ring behind).
    if (keyboard) {
      const h = root.querySelector<HTMLElement>(".site-legal-h");
      h?.setAttribute("tabindex", "-1");
      h?.focus({ preventScroll: true });
    }
  };
  // Back and forward between docs pages swap too; a hash change on the same page is the browser's own.
  window.addEventListener("popstate", () => { void go(location.pathname, false); });
}
