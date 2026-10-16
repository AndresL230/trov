// The gallery page's own behaviour (no app code): the theme (follow the viewer, or Light / Dark / Side by side),
// the frames (built lazily from each specimen's <template>, sharing the page's one copy of the app's CSS and the orb
// runtime), the desktop frames' scale, the "Thinking… Ns" clock, and making every specimen inert (nothing in it
// navigates or submits; the buttons have no handlers here).

type Mode = "auto" | "light" | "dark" | "both";
type Theme = "light" | "dark";

const root = document.documentElement;
const MODE_KEY = "ask-gallery.mode";
const read = (): Mode => {
  try { const v = localStorage.getItem(MODE_KEY); return v === "light" || v === "dark" || v === "both" ? v : "auto"; } catch { return "auto"; }
};
const save = (m: Mode): void => { try { localStorage.setItem(MODE_KEY, m); } catch { /* private window: not kept */ } };
let mode: Mode = read();

const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
/** The viewer's theme: the host's `data-theme` on the root, else the system's. */
const viewerTheme = (): Theme => (root.dataset.theme === "dark" ? "dark" : root.dataset.theme === "light" ? "light" : mq?.matches ? "dark" : "light");
const primaryTheme = (): Theme => (mode === "light" ? "light" : mode === "dark" ? "dark" : mode === "both" ? "light" : viewerTheme());

const kickOrbs = (): void => { (window as unknown as { __gxOrbKick?: () => void }).__gxOrbKick?.(); };

// ── frames ───────────────────────────────────────────────────────────────────

const appCss = (): string => document.getElementById("gx-app-css")?.textContent ?? "";
const orbSrc = (): string => document.getElementById("gx-orb-src")?.textContent ?? "";
const frameCss = `html,body{margin:0;padding:0;background:var(--bg,#fff)}::-webkit-scrollbar{width:8px;height:8px}`;

function frameDoc(html: string, theme: Theme): string {
  const body = html.replace(/data-cnpy-theme="(light|dark)"/, `data-cnpy-theme="${theme}"`);
  const inert = `document.addEventListener("click",function(e){e.preventDefault()},true);document.addEventListener("submit",function(e){e.preventDefault()},true);`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${appCss()}</style><style>${frameCss}</style></head><body>${body}<script>${orbSrc().replace(/<\/script/gi, "<\\/script")}<\/script><script>${inert}<\/script></body></html>`;
}

/** Build the iframe for a frame box once it comes near the screen. */
function buildFrame(box: HTMLElement): void {
  if (box.querySelector("iframe")) return;
  const spec = box.closest<HTMLElement>(".gx-spec");
  const tpl = spec?.querySelector<HTMLTemplateElement>("template.gx-src");
  if (!tpl) return;
  const f = document.createElement("iframe");
  f.title = `${spec?.querySelector("h3")?.textContent ?? "Specimen"} (${box.dataset.theme ?? "light"})`;
  f.loading = "eager";
  f.width = box.dataset.w ?? "1440";
  f.height = box.dataset.h ?? "900";
  f.setAttribute("tabindex", "-1");
  f.srcdoc = frameDoc(tpl.innerHTML, (box.dataset.theme as Theme) ?? "light");
  box.appendChild(f);
}

const near = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { buildFrame(e.target as HTMLElement); near?.unobserve(e.target); } }, { rootMargin: "800px 0px" })
  : null;
function watchFrame(box: HTMLElement): void { if (near) near.observe(box); else buildFrame(box); }

/** A desktop frame scales to the width it has (1:1 with "Actual size"); a phone frame is always 1:1. */
const sizer = typeof ResizeObserver === "function"
  ? new ResizeObserver((es) => { for (const e of es) for (const box of Array.from((e.target as HTMLElement).querySelectorAll<HTMLElement>(":scope > .gx-frame"))) scale(box); })
  : null;
function scale(box: HTMLElement): void {
  const w = Number(box.dataset.w ?? 1440);
  const actual = box.dataset.fixed === "1" || (box.closest(".gx-spec")?.classList.contains("is-actual") ?? false);
  const room = box.parentElement ? box.parentElement.clientWidth : w;
  const k = actual ? 1 : Math.min(1, room / w);
  box.style.setProperty("--k", String(k));
}
const sizeFrame = (box: HTMLElement): void => { if (box.parentElement) sizer?.observe(box.parentElement); scale(box); };

function setFrameTheme(box: HTMLElement, theme: Theme): void {
  box.dataset.theme = theme;
  const f = box.querySelector("iframe");
  const el = f?.contentDocument?.querySelector("[data-cnpy-theme]");
  if (el) el.setAttribute("data-cnpy-theme", theme);
}

// ── theme + side by side ─────────────────────────────────────────────────────

function themeView(view: HTMLElement, theme: Theme): void {
  view.dataset.theme = theme;
  const label = view.querySelector<HTMLElement>(".gx-view-l");
  if (label) label.textContent = theme === "dark" ? "Dark" : "Light";
  for (const st of Array.from(view.querySelectorAll<HTMLElement>(".gx-stage"))) st.setAttribute("data-cnpy-theme", theme);
  for (const box of Array.from(view.querySelectorAll<HTMLElement>(".gx-frame"))) setFrameTheme(box, theme);
}

function apply(): void {
  const both = mode === "both";
  document.body.classList.toggle("gx-both", both);
  for (const views of Array.from(document.querySelectorAll<HTMLElement>(".gx-views"))) {
    const first = views.querySelector<HTMLElement>(".gx-view")!;
    let second = views.querySelector<HTMLElement>(".gx-view.is-clone");
    if (both && !second) {
      second = first.cloneNode(true) as HTMLElement;
      second.classList.add("is-clone");
      for (const f of Array.from(second.querySelectorAll("iframe"))) f.remove();
      views.appendChild(second);
      for (const box of Array.from(second.querySelectorAll<HTMLElement>(".gx-frame"))) { watchFrame(box); sizeFrame(box); }
    } else if (!both && second) second.remove();
    themeView(first, primaryTheme());
    if (both && second) themeView(second, "dark");
  }
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-gx-mode]"))) b.setAttribute("aria-pressed", String(b.dataset.gxMode === mode));
  kickOrbs();
  stampClocks();
}

// ── the "Thinking… Ns" clock (the app ticks it between paints) ───────────────

const T0 = Date.now() - 7000;
function stampClocks(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-ask-think]"))) el.dataset.askThink = String(T0);
}
setInterval(() => {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-ask-think]"))) {
    el.textContent = `Thinking… ${Math.max(0, Math.floor((Date.now() - Number(el.dataset.askThink)) / 1000))}s`;
  }
}, 500);

// ── wiring ───────────────────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  const t = e.target as Element | null;
  const modeBtn = t?.closest<HTMLButtonElement>("[data-gx-mode]");
  if (modeBtn) { mode = modeBtn.dataset.gxMode as Mode; save(mode); apply(); return; }
  const actual = t?.closest<HTMLButtonElement>("[data-gx-actual]");
  if (actual) {
    const spec = actual.closest<HTMLElement>(".gx-spec");
    const on = !spec?.classList.contains("is-actual");
    spec?.classList.toggle("is-actual", on);
    actual.setAttribute("aria-pressed", String(on));
    for (const box of Array.from(spec?.querySelectorAll<HTMLElement>(".gx-frame") ?? [])) scale(box);
    return;
  }
  // Inside a specimen nothing navigates or submits.
  if (t?.closest(".gx-stage")) e.preventDefault();
}, true);
document.addEventListener("submit", (e) => { if ((e.target as Element | null)?.closest?.(".gx-stage")) e.preventDefault(); }, true);

mq?.addEventListener?.("change", () => { if (mode === "auto") apply(); });
new MutationObserver(() => { if (mode === "auto") apply(); }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

for (const box of Array.from(document.querySelectorAll<HTMLElement>(".gx-frame"))) { watchFrame(box); sizeFrame(box); }
apply();
