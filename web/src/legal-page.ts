// The DOM boot for the two legal pages (web/terms.html, web/privacy.html). The page
// says which document it is (`data-doc` on #legal); everything it renders comes from
// the pure web/src/legal.ts. The theme follows the app's own stored choice
// (`canopy.theme`, the same key and reading as web/src/main.ts), and the toggle flips
// Light ⇄ Dark and stores it, so the app and these pages always agree.
import "./canopy.css";
import { LEGAL_DOCS, legalView, type LegalKind } from "./legal";
import { syncFavicon } from "./favicon";

type Theme = "light" | "dark" | "system";

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("canopy.theme");
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

  document.title = `${doc.title} · Canopy`;
  paint();
  media?.addEventListener?.("change", () => { if (theme === "system") paint(); });
  mount.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-legal-theme]")) return;
    theme = resolved() === "light" ? "dark" : "light";
    try { localStorage.setItem("canopy.theme", theme); } catch { /* ignore */ }
    paint();
  });
  // A deep link to a section (/privacy#cookies) lands on it once the page has rendered.
  if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}
