// The DOM boot for the two legal pages (web/terms.html, web/privacy.html). The page
// says which document it is (`data-doc` on #legal); everything it renders comes from
// the pure web/src/legal.ts. The theme follows the app's own stored choice
// (`trov.theme`, the same key and reading as web/src/main.ts), and the toggle flips
// Light ⇄ Dark and stores it, so the app and these pages always agree.
import "./trov.css";
import { LEGAL_DOCS, legalView, type LegalKind } from "./legal";
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
  return "light"; // the app's default
}

const mount = document.getElementById("legal");
const kind = mount?.dataset.doc as LegalKind | undefined;
const doc = kind ? LEGAL_DOCS[kind] : undefined;

if (mount && doc) {
  let theme = storedTheme();
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const resolved = (): "light" | "dark" => (theme === "system" ? (media?.matches ? "dark" : "light") : theme);

  const paint = () => {
    const t = resolved();
    document.documentElement.style.background = t === "dark" ? "#1c1a16" : "#f6f6f7"; // no white flash past the wrapper
    mount.innerHTML = `<div data-cnpy-theme="${t}" style="background:var(--bg);color:var(--fg);min-height:100vh;font-family:'Geist',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">${legalView(doc, t === "dark")}</div>`;
    syncFavicon(t);
  };

  document.title = `${doc.title} · Trov`;
  paint();
  media?.addEventListener?.("change", () => { if (theme === "system") paint(); });
  mount.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-legal-theme]")) return;
    theme = resolved() === "light" ? "dark" : "light";
    try { localStorage.setItem("trov.theme", theme); } catch { /* ignore */ }
    paint();
    spy();
  });
  // The contents follow the reader: the section whose heading last crossed the top of the page is the
  // current one. Read from the DOM on every scroll, so a repaint (the theme toggle) needs no re-wiring.
  let queued = false;
  const spy = () => {
    queued = false;
    let current = "";
    for (const sec of mount.querySelectorAll<HTMLElement>(".site-legal-sec")) {
      if (sec.getBoundingClientRect().top > 120) break;
      current = sec.id;
    }
    for (const a of mount.querySelectorAll<HTMLElement>("[data-legal-toc]")) {
      if (a.dataset.legalToc === current) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
  spy();
  // A contents link glides to its section (and keeps the address shareable); with reduced motion it jumps.
  mount.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLElement>("[data-legal-toc]");
    const sec = a ? document.getElementById(a.dataset.legalToc ?? "") : null;
    if (!a || !sec) return;
    e.preventDefault();
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sec.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${sec.id}`);
  });
  // A deep link to a section (/privacy#cookies) lands on it once the page has rendered.
  if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}
