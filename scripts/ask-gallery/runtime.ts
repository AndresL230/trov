// The gallery page's own behaviour (no app code): every specimen follows the viewer's theme (the host's `data-theme`
// on the root, else the system's), the frames are built from each specimen's <template> as they come near the
// screen (sharing the page's one copy of the app's CSS and the orb runtime) and scale to fit, the "Thinking… Ns"
// clock counts, and nothing inside a specimen navigates or submits (its buttons have no handlers here).

type Theme = "light" | "dark";

const root = document.documentElement;
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const theme = (): Theme => (root.dataset.theme === "dark" ? "dark" : root.dataset.theme === "light" ? "light" : mq?.matches ? "dark" : "light");
const kickOrbs = (): void => { (window as unknown as { __gxOrbKick?: () => void }).__gxOrbKick?.(); };

// ── frames ───────────────────────────────────────────────────────────────────

const appCss = (): string => document.getElementById("gx-app-css")?.textContent ?? "";
const orbSrc = (): string => document.getElementById("gx-orb-src")?.textContent ?? "";

function frameDoc(html: string, t: Theme): string {
  const body = html.replace(/data-cnpy-theme="(light|dark)"/, `data-cnpy-theme="${t}"`);
  const inert = `document.addEventListener("click",function(e){e.preventDefault()},true);document.addEventListener("submit",function(e){e.preventDefault()},true);`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${appCss()}</style><style>html,body{margin:0;padding:0}</style></head><body>${body}<script>${orbSrc().replace(/<\/script/gi, "<\\/script")}<\/script><script>${inert}<\/script></body></html>`;
}

function buildFrame(box: HTMLElement): void {
  if (box.querySelector("iframe")) return;
  const spec = box.closest<HTMLElement>(".gx-spec");
  const tpl = spec?.querySelector<HTMLTemplateElement>("template.gx-src");
  if (!tpl) return;
  const f = document.createElement("iframe");
  f.title = spec?.querySelector(".gx-cap")?.textContent ?? "Specimen";
  f.width = box.dataset.w ?? "1440";
  f.height = box.dataset.h ?? "900";
  f.setAttribute("tabindex", "-1");
  f.srcdoc = frameDoc(tpl.innerHTML, theme());
  box.appendChild(f);
}

const near = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { buildFrame(e.target as HTMLElement); near?.unobserve(e.target); } }, { rootMargin: "1200px 0px" })
  : null;

/** A desktop frame scales to the width it has; a phone frame stays 1:1 (its box scrolls on a narrow screen). */
function scale(box: HTMLElement): void {
  const w = Number(box.dataset.w ?? 1440);
  const room = box.parentElement ? box.parentElement.clientWidth : w;
  box.style.setProperty("--k", String(box.dataset.fixed === "1" ? 1 : Math.min(1, room / w)));
}
const sizer = typeof ResizeObserver === "function"
  ? new ResizeObserver((es) => { for (const e of es) for (const b of Array.from((e.target as HTMLElement).querySelectorAll<HTMLElement>(":scope > .gx-frame"))) scale(b); })
  : null;

// ── the theme ────────────────────────────────────────────────────────────────

function apply(): void {
  const t = theme();
  for (const st of Array.from(document.querySelectorAll<HTMLElement>(".gx-stage"))) st.setAttribute("data-cnpy-theme", t);
  for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>(".gx-frame iframe"))) {
    f.contentDocument?.querySelector("[data-cnpy-theme]")?.setAttribute("data-cnpy-theme", t);
  }
  kickOrbs();
}
mq?.addEventListener?.("change", apply);
new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

// ── the "Thinking… Ns" clock (the app ticks it between paints) ───────────────

const T0 = Date.now() - 7000;
for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-ask-think]"))) el.dataset.askThink = String(T0);
setInterval(() => {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-ask-think]"))) {
    el.textContent = `Thinking… ${Math.max(0, Math.floor((Date.now() - Number(el.dataset.askThink)) / 1000))}s`;
  }
}, 500);

// ── inert specimens, then go ─────────────────────────────────────────────────

document.addEventListener("click", (e) => { if ((e.target as Element | null)?.closest?.(".gx-stage")) e.preventDefault(); }, true);
document.addEventListener("submit", (e) => { if ((e.target as Element | null)?.closest?.(".gx-stage")) e.preventDefault(); }, true);

for (const box of Array.from(document.querySelectorAll<HTMLElement>(".gx-frame"))) {
  if (near) near.observe(box); else buildFrame(box);
  if (box.parentElement) sizer?.observe(box.parentElement);
  scale(box);
}
apply();
