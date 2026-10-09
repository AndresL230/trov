// The DOM boot for the public pricing page (web/pricing.html). Everything it renders comes
// from the pure web/src/pricing.ts. The theme follows the app's own stored choice
// (`trov.theme`, the same key and reading as web/src/main.ts and legal-page.ts), and the
// toggle flips Light ⇄ Dark and stores it, so the app and this page always agree.
import "./trov.css";
import { pricingView } from "./pricing";
import { mountPricing } from "./pricing-dom";
import { initFaqAccordion } from "./site-faq";
import { syncFavicon } from "./favicon";
import { migrateBrowserStorage } from "./storage-migrate";

migrateBrowserStorage(); // canopy.* → trov.* before the theme is read
initFaqAccordion();      // the Questions accordion's motion (one delegated listener)

type Theme = "light" | "dark" | "system";

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("trov.theme");
    if (t === "dark" || t === "light" || t === "system") return t;
    if (t === "midnight") return "dark"; // retired theme, read like the app reads it
  } catch { /* storage unavailable */ }
  return "light"; // the app's default
}

const mount = document.getElementById("pricing");

if (mount) {
  let theme = storedTheme();
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const resolved = (): "light" | "dark" => (theme === "system" ? (media?.matches ? "dark" : "light") : theme);

  const paint = () => {
    const t = resolved();
    document.documentElement.style.background = t === "dark" ? "#1c1a16" : "#f6f6f7"; // no white flash past the wrapper
    mount.innerHTML = `<div data-cnpy-theme="${t}" style="background:var(--bg);color:var(--fg);min-height:100vh;font-family:'Geist',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">${pricingView(t === "dark")}</div>`;
    mountPricing(mount);
    syncFavicon(t);
  };

  paint();
  media?.addEventListener?.("change", () => { if (theme === "system") paint(); });
  mount.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-site-theme]")) return;
    theme = resolved() === "light" ? "dark" : "light";
    try { localStorage.setItem("trov.theme", theme); } catch { /* ignore */ }
    paint();
    mount.querySelector<HTMLElement>("[data-site-theme]")?.focus(); // the repaint replaced the button
  });
}
