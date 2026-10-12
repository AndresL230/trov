// The DOM boot for the public docs pages (/docs/<page>: `docs` pages of shared/site-pages.ts, whose HTML the
// build writes and PRERENDERS from their Markdown — web/src/docs.ts). Unlike the legal and pricing pages it
// never repaints: the page is complete as built, so this script carries none of the docs' text. It only
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

  const toc = root.querySelector<HTMLElement>(".site-legal-toc");
  const setToc = (open: boolean, instant = false): void => {
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
}
