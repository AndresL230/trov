// ── Landing: the signed-out screen ──────────────────────────────────────────
// Ported from the Claude Design project d8f0c2b0-da50-49f8-964f-ee647908406b
// (`Canopy Site.dc.html`). It replaces the old bare login card: a signed-out
// visitor lands on the product page, and "Sign in" opens the provider dialog
// (GitHub for engineers, Google by invitation — both stay reachable).
//
// Deltas from the canvas file, all deliberate:
//   • `style-hover` pseudo-props → the `.site-*` classes in trov.css.
//   • In-page links are `siteJump` buttons, not `#how` anchors: the URL hash is
//     the app's route AND the sign-in return-to (an email deep link must survive
//     a visit to the landing page), so the landing never writes it.
//   • The theme toggle is the app's `cycleTheme` (Light ⇄ Dark) and
//     reads the app's theme, instead of the canvas's own light/dark store.
//   • Sign in lives ONLY in the nav (top right); the hero keeps the canvas's CTAs.
//   • Motion (not in the canvas): the mockups act out the product. Elements carry
//     `data-rv` and render hidden; landing-motion.ts plays them as they scroll in
//     and the CSS in trov.css runs the choreography, each step timed by `--d`.

import { esc } from "./ui";
import { TROV_REPO, siteFooter, siteMark as mark } from "./site-chrome";


// Reveal keys already played, for THIS render (set by landingView). A played
// element renders settled (`is-done`), so a rerender — the theme toggle, the
// sign-in dialog — never replays or re-hides it.
let seen: ReadonlySet<string> = new Set();

/** Scroll-reveal hook: `data-rv` plus the class list (an element has one class attribute). */
function rv(key: string, extra = ""): string {
  return `data-rv="${key}" class="site-rv${extra ? ` ${extra}` : ""}${seen.has(key) ? " is-done" : ""}"`;
}
/** When a motion step starts, in ms after its section is revealed (an inline-style fragment). */
const at = (ms: number) => `--d:${Math.round(ms)}ms;`;
/** Text that types itself in, one clip step per character. Returns [html, end ms]. */
function typed(text: string, start: number, msPerChar = 30): [string, number] {
  const t = text.length * msPerChar;
  return [`<span class="site-type" style="${at(start)}--n:${text.length};--t:${t}ms">${esc(text)}</span>`, start + t];
}


const GH_MARK = (size: number) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`;

const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`;
/** The accent check, drawn on (stroke) when its section plays. */
const check = (size: number, start: number, extra = "") => `<svg class="site-check" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" style="flex:none;${at(start)}${extra}"><path d="M20 6 9 17l-5-5"></path></svg>`;
const AGENT_TAG = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 5px"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M12 8V4M8 13h.01M16 13h.01"></path></svg>agent</span>`;

// ── shared pieces of the canvas's repeated markup ────────────────────────────
const MONO_EYEBROW = "font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--accent)";
const H2 = "margin:0;font-size:clamp(28px, 3.4vw, 38px);font-weight:650;letter-spacing:-0.025em";
const LEDE = "margin:14px 0 0;max-width:560px;font-size:15.5px;line-height:1.6;color:var(--fg-70);text-wrap:pretty";
const section = (top = 150) => `max-width:1120px;margin:0 auto;padding:${top}px 24px 0`;
const MOCK = "flex:1.3 1 400px;min-width:0;border:1px solid var(--border);border-radius:12px;box-shadow:var(--lift-shadow);overflow:hidden";

/** A label-face status pill; `c` is a color var name (green / amber / blue / red). */
function pill(text: string, c: string, size = "8.5px", pad = "1.5px 5px"): string {
  return `<span style="font-family:var(--label);font-size:${size};font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--${c});border:1px solid color-mix(in srgb, var(--${c}) 45%, transparent);background:color-mix(in srgb, var(--${c}) 11%, transparent);border-radius:4px;padding:${pad};flex:none">${text}</span>`;
}
function initials(text: string, size = 26, font = "10px"): string {
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:${font};font-weight:600;display:grid;place-items:center;flex:none">${text}</span>`;
}
function segTab(text: string, on: boolean, divider = false): string {
  return `<span style="padding:3px 10px;${on ? "background:var(--hover);color:var(--fg)" : "color:var(--fg-55)"}${divider ? ";border-left:1px solid var(--border)" : ""}">${text}</span>`;
}
/** A section heading block (h2 + optional lede) that rises in on scroll. */
function heading(key: string, title: string, lede = ""): string {
  return `<div ${rv(key)}>
    <h2 style="${H2}">${title}</h2>
    ${lede ? `<p style="${LEDE}">${lede}</p>` : ""}
  </div>`;
}
/** One product-tour row: copy on one side, mockup on the other (`flip` swaps them).
 *  Each half slides in from its own side; the mockup's contents then play. */
function tourRow(key: string, eyebrow: string, title: string, body: string, mockStyle: string, mockInner: string, flip = false): string {
  return `<div style="display:flex;gap:56px;align-items:center;flex-wrap:wrap${flip ? ";flex-direction:row-reverse" : ""}">
    <div ${rv(`${key}-copy`, flip ? "rv-r" : "rv-l")} style="flex:1 1 320px;min-width:0">
      <div style="${MONO_EYEBROW}">${eyebrow}</div>
      <h3 style="margin:10px 0 0;font-size:23px;font-weight:650;letter-spacing:-0.015em">${title}</h3>
      <p style="margin:12px 0 0;max-width:420px;font-size:14.5px;line-height:1.65;color:var(--fg-70);text-wrap:pretty">${body}</p>
    </div>
    <div ${rv(`${key}-mock`, `${flip ? "rv-l" : "rv-r"} site-lift`)} style="${mockStyle};${at(120)}">${mockInner}</div>
  </div>`;
}

// ── nav ──────────────────────────────────────────────────────────────────────
function nav(dark: boolean, signedIn: boolean): string {
  const link = (arg: string, label: string) => `<button data-act="siteJump" data-arg="${arg}" class="site-navlink">${label}</button>`;
  return `<nav class="site-nav" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
    <div class="site-navin" style="max-width:1120px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px">
      <button data-act="siteJump" data-arg="top" style="display:flex;align-items:center;gap:9px;padding:0;color:var(--fg)">
        ${mark(20)}
        <span style="font-size:16.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
      </button>
      <div class="site-hide-sm" style="display:flex;gap:4px;margin-left:8px">
        ${link("how", "How it works")}${link("tour", "Tour")}${link("agents", "For agents")}${link("security", "Security")}
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
        <a href="${TROV_REPO}" target="_blank" rel="noopener" title="GitHub" class="site-iconbtn">${GH_MARK(17)}</a>
        <button data-act="cycleTheme" title="Toggle theme" class="site-iconbtn" style="border:1px solid var(--border)">${dark ? MOON : SUN}</button>
        <button data-act="${signedIn ? "siteBack" : "openSignIn"}" class="cnpy-accentbtn" style="padding:7px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600;white-space:nowrap">${signedIn ? "Back to the app" : "Sign in"}</button>
      </div>
    </div>
  </nav>`;
}

// ── 1 · hero (with the Review screen mockup) ─────────────────────────────────
// The signature moment: the headline rises in word by word, the Review mockup
// lifts into place, then acts out the product — an agent's proposed lines type
// into the diff, the Promote button draws the eye, a PERSON promotes it, and the
// queue badge and a toast confirm it went live. It plays once and rests there.
function hero(): string {
  const HEADLINE = "Shared memory for your team and its coding agents.";
  const words = HEADLINE.split(" ").map((w, i) => `<span class="site-st st-word" style="${at(80 + i * 55)}">${w}</span>`).join(" ");

  // The mockup's script, in ms after page load (the copy and the mockup reveal together).
  const MOCK_IN = 700;
  const DEL = 1650;
  const [add1, add1End] = typed("+ 3. CI applies D1 migrations.", DEL + 350, 30);
  const [add2, add2End] = typed("+ 4. CI runs the deploy. Laptop deploys are retired.", add1End + 180, 24);
  const RING = add2End + 350;       // two pulses on Promote…
  const PRESS = RING + 2100;        // …then a person clicks it
  const DONE = PRESS + 140;         // label → "Promoted", Reject dims, badge 3 → 2
  const TOAST = DONE + 300;

  const side = (svg: string, label: string) =>
    `<div style="display:flex;align-items:center;gap:9px;padding:6.5px 8px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-55)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none">${svg}</svg>${label}</div>`;
  const sideHead = (label: string, top: string) =>
    `<div style="font-family:var(--label);font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);padding:${top} 8px 5px">${label}</div>`;
  const line = (text: string) => `<div style="padding:1px 12px">${text}</div>`;
  const hl = (inner: string, kind: "add" | "del", start: number) => `<div class="site-hl hl-${kind}" style="padding:1px 12px;${at(start)}"><span>${inner}</span></div>`;
  const paneHead = (label: string) => `<div style="padding:7px 12px;border-bottom:1px solid var(--border);font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)">${label}</div>`;
  const diffTab = (label: string, on: boolean) => `<span style="padding:3px 9px;border-radius:6px;font-size:10.5px;font-weight:500;${on ? "border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)" : "border:1px solid var(--border);color:var(--fg-55)"}">${label}</span>`;
  const dot = `<span style="width:10px;height:10px;border-radius:50%;background:var(--border-strong);flex:none"></span>`;

  return `<header id="site-top" style="max-width:1120px;margin:0 auto;padding:96px 24px 0;text-align:center">
    <div ${rv("hero-copy", "rv-static")}>
      <h1 style="margin:0 auto;max-width:820px;font-size:clamp(38px, 5.4vw, 62px);line-height:1.06;font-weight:650;letter-spacing:-0.032em;text-wrap:balance">${words}</h1>
      <p class="site-st" style="margin:22px auto 0;max-width:620px;font-size:17.5px;line-height:1.6;color:var(--fg-70);text-wrap:pretty;${at(520)}">Agents load what your team already decided, record what actually shipped, and wait for a person to approve anything that becomes official.</p>
      <div class="site-st" style="margin-top:34px;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;${at(640)}">
        <button data-act="siteGuide" class="site-btn site-btn-solid">Get started</button>
        <a href="${TROV_REPO}" target="_blank" rel="noopener" class="site-btn site-btn-outline">${GH_MARK(15)}Read the code</a>
      </div>
    </div>

    <div ${rv("hero-mock", "rv-lift")} style="margin:72px auto 0;max-width:1060px;text-align:left;border:1px solid var(--border-strong);border-radius:13px;background:var(--bg);box-shadow:var(--lift-shadow);overflow:hidden;${at(MOCK_IN)}">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border)">
        ${dot}${dot}${dot}
        <span style="margin:0 auto;font-family:var(--label);font-size:11px;color:var(--fg-40);border:1px solid var(--border);border-radius:6px;padding:3px 14px">trov.dev/o/acme/#review</span>
        <span style="width:44px"></span>
      </div>
      <div style="display:flex;height:568px;overflow:hidden">
        <div class="site-hide-sm" style="width:212px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--border);padding:14px 12px 12px">
          <div style="display:flex;align-items:center;gap:8px;padding:2px 8px 14px">
            ${mark(17)}
            <span style="font-size:14.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
          </div>
          ${sideHead("Workspace", "4px")}
          <div style="display:flex;flex-direction:column;gap:1px">
            ${side(`<path d="M3 12 12 3l9 9"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path>`, "My Work")}
            ${side(`<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path><path d="M13 5v2M13 11v2M13 17v2"></path>`, "Tickets")}
            ${side(`<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`, "Roadmap")}
            ${side(`<path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4z"></path>`, "Handoffs")}
          </div>
          ${sideHead("Monitor", "16px")}
          <div style="display:flex;flex-direction:column;gap:1px">
            ${side(`<path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>`, "Repo")}
            ${side(`<path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path>`, "Feed")}
          </div>
          ${sideHead("Knowledge", "16px")}
          <div style="display:flex;flex-direction:column;gap:1px">
            ${side(`<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path>`, "Docs")}
            ${side(`<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M7 13.5h6"></path><path d="M7 16.5h9"></path>`, "Artifacts")}
            ${side(`<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"></path><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"></path>`, "Prompt Library")}
          </div>
          ${sideHead("Triage", "16px")}
          <div style="display:flex;align-items:center;gap:9px;padding:6.5px 8px;border-radius:7px;font-size:12.5px;font-weight:500;background:var(--accent-soft);color:var(--accent)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="m9 12.5 2 2 4-5"></path></svg>Review<span class="site-swap" style="margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:10px;font-weight:600;place-items:center;${at(DONE + 150)}"><span>3</span><span>2</span></span></div>
          <div style="margin-top:auto">
            <div style="font-size:10.5px;color:var(--fg-40);padding:0 8px 12px">agents produce · humans confirm</div>
            <div style="display:flex;align-items:center;gap:9px;padding:8px;border-top:1px solid var(--border)">
              ${initials("MC")}
              <span style="min-width:0"><span style="display:block;font-size:11.5px;font-weight:600">Maya Chen</span><span style="display:block;font-size:10.5px;color:var(--fg-40);font-family:var(--sans)">@maya</span></span>
            </div>
          </div>
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;position:relative">
          <div style="display:flex;align-items:center;padding:13px 22px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600">Review</div>
          <div style="padding:22px 26px;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-size:21px;font-weight:650;letter-spacing:-0.015em">Deploy process</span>
              ${pill("edit", "blue", "9px", "2px 6px")}
              ${pill("low confidence", "amber", "9px", "2px 6px")}
              <span style="margin-left:auto;display:flex;gap:8px">
                <span class="site-dim" style="border:1px solid var(--border-strong);color:var(--fg-70);font-size:12px;font-weight:600;padding:6px 14px;border-radius:8px;${at(DONE)}">Reject</span>
                <span class="site-ring site-press site-swap" style="background:var(--accent);color:var(--accent-fg);font-size:12px;font-weight:600;padding:6px 16px;border-radius:8px;--ring:${RING}ms;--press:${PRESS}ms;${at(DONE)}"><span>Promote</span><span>Promoted ✓</span></span>
              </span>
            </div>
            <div style="margin-top:7px;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--fg-55)">
              Proposal · <span style="font-family:var(--label);font-size:10.5px;letter-spacing:.03em">TECHNICAL / OPERATIONS</span> · Maya Chen ${AGENT_TAG} · 2h ago
            </div>
            <div style="margin-top:20px;display:flex;align-items:center;gap:10px">
              <span style="font-family:var(--label);font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40)">What changed</span>
              <span style="margin-left:auto;display:flex;gap:6px">${diffTab("Unified", false)}${diffTab("Side by side", true)}${diffTab("Rendered", false)}</span>
            </div>
            <div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border);border-radius:10px;overflow:hidden;font-family:var(--label);font-size:11px;line-height:1.7">
              <div style="border-right:1px solid var(--border)">
                ${paneHead("Current · v4")}
                <div style="padding:10px 0 14px;color:var(--fg-70)">
                  ${line("## Deploy process")}${line("&nbsp;")}${line("Merges to main deploy automatically.")}${line("1. Open a PR and get one review.")}${line("2. CI runs typecheck and tests.")}${hl("- 3. Deploy from your laptop.", "del", DEL)}
                </div>
              </div>
              <div>
                ${paneHead("Proposed")}
                <div style="padding:10px 0 14px;color:var(--fg-70)">
                  ${line("## Deploy process")}${line("&nbsp;")}${line("Merges to main deploy automatically.")}${line("1. Open a PR and get one review.")}${line("2. CI runs typecheck and tests.")}${hl(add1, "add", DEL + 300)}${hl(add2, "add", add1End + 130)}
                </div>
              </div>
            </div>
          </div>
          <div class="site-toast" role="presentation" style="position:absolute;right:20px;bottom:20px;display:flex;align-items:center;gap:10px;padding:10px 14px 10px 12px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);box-shadow:var(--lift-shadow);font-size:12px;${at(TOAST)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.4" style="flex:none"><path d="M20 6 9 17l-5-5"></path></svg>
            <span><span style="font-weight:600">Deploy process</span> <span style="color:var(--fg-55)">is live as v5</span></span>
            <span style="font-family:var(--sans);font-size:10.5px;color:var(--fg-40)">@maya</span>
          </div>
        </div>
      </div>
    </div>
  </header>`;
}

// ── 2 · problem ──────────────────────────────────────────────────────────────
function problem(): string {
  const card = (i: number, title: string, body: string) => `<div class="site-st site-card" style="border:1px solid var(--border);border-radius:12px;padding:26px 28px;${at(i * 110)}">
      <div style="font-size:16px;font-weight:650;letter-spacing:-0.01em">${title}</div>
      <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:var(--fg-70);text-wrap:pretty">${body}</p>
    </div>`;
  return `<section style="max-width:1120px;margin:0 auto;padding:130px 24px 0">
    <div ${rv("problem", "rv-static")} style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:16px">
      ${card(0, "Agents start every session cold.", "They re-derive conventions and guess at decisions the team already made.")}
      ${card(1, "Wikis rot.", "Writing back is a chore nobody does after the work ships.")}
      ${card(2, "Unchecked agent docs spread mistakes.", "One confident error gets read as fact by every agent after it.")}
    </div>
  </section>`;
}

// ── 3 · the loop ─────────────────────────────────────────────────────────────
// Each card runs its step once it scrolls in: the search types and its hits
// drop in, the agent session types out, the record's checks tick in order.
function loop(): string {
  const step = (i: number, eyebrow: string, body: string, visual: string) => `<div ${rv(`how-${i}`, "site-card")} style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:12px;padding:24px 24px 22px;${at(i * 120)}">
      <div style="${MONO_EYEBROW}">${eyebrow}</div>
      <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:var(--fg-70);text-wrap:pretty">${body}</p>
      <div style="margin-top:auto;padding-top:20px">${visual}</div>
    </div>`;

  // 01 · orient
  let b = 0;
  const [search, searchEnd] = typed("rate limiting", b + 550, 45);
  const hit = (title: string, badge: string, meta: string, first: boolean, start: number) => `<div class="site-st" style="padding:10px 12px;${first ? "" : "border-top:1px solid var(--border);"}display:flex;flex-direction:column;gap:3px;${at(start)}">
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span><span style="margin-left:auto">${badge}</span></div>
      <div style="font-size:11px;color:var(--fg-55)">${meta}</div>
    </div>`;
  const orient = `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);font-family:var(--label);font-size:11.5px;color:var(--fg-55)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>${search}</div>
      ${hit("Rate limiting on the public API", pill("Live", "green"), "Doc · Technical / API", true, searchEnd + 200)}
      ${hit("Retry budget for webhook callers", pill("Pending", "amber"), "Decision · ADR-0012", false, searchEnd + 360)}
    </div>`;

  // 02 · work
  b = 120;
  const [cmd, cmdEnd] = typed("> add per-org limits to /search", b + 550, 34);
  const tline = (text: string, color: string, start: number) => `<div class="site-st" style="color:${color};${at(start)}">${text}</div>`;
  const tdot = `<span style="width:8px;height:8px;border-radius:50%;background:rgba(237,233,226,0.25)"></span>`;
  const work = `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--term);color:var(--term-fg)">
      <div style="display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid rgba(237,233,226,0.11)">
        ${tdot}${tdot}${tdot}
        <span style="margin-left:6px;font-family:var(--label);font-size:10px;color:rgba(237,233,226,0.5)">claude</span>
      </div>
      <div style="padding:12px 14px 14px;font-family:var(--code);font-size:11px;line-height:1.75">
        <div style="color:rgba(237,233,226,0.6)">${cmd}</div>
        ${tline("⏺ trov · load-context", "#9aab65", cmdEnd + 250)}
        ${tline("Read: Rate limiting on the public API", "rgba(237,233,226,0.85)", cmdEnd + 650)}
        <div class="site-st" style="color:rgba(237,233,226,0.85);${at(cmdEnd + 1000)}">Building on ADR-0012, token bucket per org.<span class="site-caret" style="${at(cmdEnd + 1150)}"></span></div>
      </div>
    </div>`;

  // 03 · record
  b = 240;
  const [rec, recEnd] = typed("> record this session", b + 550, 34);
  const done = (text: string, start: number) => `<div style="display:flex;align-items:center;gap:8px">${check(12, start)}<span class="site-st st-l" style="${at(start + 80)}">${text}</span></div>`;
  const record = `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="padding:9px 12px;border-bottom:1px solid var(--border);font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${rec}</div>
      <div style="padding:11px 12px;display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--fg-70)">
        ${done("2 feed entries posted", recEnd + 250)}${done("3 docs: 1 staged, 2 unchanged", recEnd + 500)}${done("1 decision drafted", recEnd + 750)}
      </div>
    </div>`;

  return `<section id="site-how" style="${section(140)}">
    ${heading("how-head", "Orient, work, record.", "The loop that keeps the store current: agents read before they start and write back when they finish.")}
    <div style="margin-top:48px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:16px;align-items:stretch">
      ${step(0, "01 · Orient", "Before touching an existing area, the agent searches Trov and reads the relevant docs and decisions.", orient)}
      ${step(1, "02 · Work", "The agent builds on what the team decided instead of guessing.", work)}
      ${step(2, "03 · Record", "On request, the agent reads what actually shipped from git and GitHub and sends one batch of updates.", record)}
    </div>
  </section>`;
}

// ── 4 · agents propose, people decide ────────────────────────────────────────
function authority(): string {
  return `<section style="max-width:1120px;margin:0 auto;padding:140px 24px 0">
    <div style="display:flex;gap:56px;align-items:center;flex-wrap:wrap">
      <div ${rv("authority-copy", "rv-l")} style="flex:1 1 380px;min-width:0">
        <h2 style="${H2};text-wrap:balance">Agents propose, people decide.</h2>
        <p style="margin:16px 0 0;max-width:480px;font-size:15.5px;line-height:1.65;color:var(--fg-70);text-wrap:pretty">No agent tool can approve, promote, or reject anything. Those actions only exist in the signed-in web app. Rejected proposals and old versions are kept, never deleted.</p>
      </div>
      <div ${rv("authority-card", "rv-r")} style="flex:1 1 380px;min-width:0;${at(120)}">
        <div class="site-lift" style="border:1px solid var(--border);border-radius:13px;padding:34px 36px;box-shadow:var(--lift-shadow)">
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:17px;font-weight:650">Deploy process</span>
            ${pill("staged", "amber", "10px", "2px 7px")}
          </div>
          <div style="margin-top:8px;font-size:12.5px;color:var(--fg-55)">Waiting for a verdict since Tue · only a signed-in person sees these buttons</div>
          <div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap">
            <span class="site-st" style="border:1px solid var(--border-strong);color:var(--fg-70);font-size:14.5px;font-weight:600;padding:11px 26px;border-radius:10px;${at(450)}">Reject</span>
            <span class="site-st site-ring" style="background:var(--accent);color:var(--accent-fg);font-size:14.5px;font-weight:600;padding:11px 30px;border-radius:10px;${at(560)}--ring:1100ms">Promote</span>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

// ── 5 · product tour ─────────────────────────────────────────────────────────
function tour(): string {
  const S = 380; // mockup contents start once the mockup has slid in
  const treeHead = (label: string, top: string) => `<div style="font-family:var(--label);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);padding:${top} 6px 6px">${label}</div>`;
  const tree = (i: number, style: string, text: string) => `<div class="site-st st-l" style="${style};${at(S + i * 70)}">${text}</div>`;
  const docs = `
      <div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:600">Docs</span>
        <span style="margin-left:auto;display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden;font-size:10.5px;font-weight:500">${segTab("Technical", true)}${segTab("Product", false, true)}</span>
      </div>
      <div style="display:flex;min-height:250px">
        <div class="site-hide-sm" style="width:180px;flex:none;border-right:1px solid var(--border);padding:12px 10px">
          ${treeHead("Operations", "0")}
          ${tree(0, "padding:4px 6px;font-size:11.5px;font-weight:500;color:var(--accent)", "▾ Deploy process")}
          ${tree(1, "padding:2px 6px 2px 18px;font-size:10.5px;color:var(--fg-55)", "Rollbacks")}
          ${tree(2, "padding:2px 6px 2px 18px;font-size:10.5px;color:var(--accent)", "Migrations")}
          ${tree(3, "padding:4px 6px;font-size:11.5px;color:var(--fg-55)", "▸ Onboarding checklist")}
          ${treeHead("Decisions", "12px")}
          ${tree(4, "padding:4px 6px;font-size:11.5px;color:var(--fg-55)", "▸ ADR-0012 · Retry budget")}
        </div>
        <div style="flex:1;min-width:0;padding:16px 20px">
          <div style="font-family:var(--label);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40)">Technical / Operations</div>
          <div style="margin-top:6px;display:flex;align-items:center;gap:10px">
            <span style="font-size:17px;font-weight:650">Deploy process</span>
            <span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:6px;padding:3px 8px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path></svg>Version history</span>
          </div>
          <div style="margin-top:4px;font-size:10.5px;color:var(--fg-55)">Updated by Leo Park · v5 · 2d ago</div>
          <div class="site-st" style="margin-top:14px;font-size:12px;line-height:1.7;color:var(--fg-70);${at(S + 150)}">Merges to main deploy automatically. CI applies D1 migrations before the deploy step, so schema and code always land together.</div>
          <div class="site-st" style="margin-top:10px;font-size:12px;font-weight:600;${at(S + 300)}">Rollbacks</div>
          <div class="site-st" style="margin-top:4px;font-size:12px;line-height:1.7;color:var(--fg-70);${at(S + 380)}">Redeploy the previous tag; migrations are forward-only.</div>
        </div>
      </div>`;

  const ref = (kind: string, id: string, i: number) => `<span class="site-st st-pop" style="border:1px solid var(--border);border-radius:5px;padding:2px 7px;${at(S + 450 + i * 90)}"><span style="color:var(--fg-40)">${kind}</span> <span style="color:var(--fg-70)">${id}</span></span>`;
  const feed = `
      <div class="site-st" style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;${at(S)}">
        <div style="display:flex;gap:11px">
          ${initials("LP")}
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:600">Rate limiting shipped on the public API</div>
            <div style="margin-top:3px;font-size:11.5px;line-height:1.55;color:var(--fg-70)">Token bucket per org, 429s carry Retry-After. Follows ADR-0012.</div>
            <div style="margin-top:7px;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--fg-55);flex-wrap:wrap">Leo Park${AGENT_TAG}· 1d ago</div>
            <div style="margin-top:9px;padding-top:9px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;font-family:var(--label);font-size:10px">
              ${ref("PR", "#142", 0)}${ref("commit", "3f2a9c1", 1)}${ref("issue", "#128", 2)}
            </div>
          </div>
        </div>
      </div>
      <div class="site-st" style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;${at(S + 160)}">
        <div style="display:flex;gap:11px">
          ${initials("SO")}
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:600">Tickets move freely on the board</div>
            <div style="margin-top:3px;font-size:11.5px;line-height:1.55;color:var(--fg-70)">Drag a ticket to any column. The order you leave it in is saved for everyone.</div>
            <div style="margin-top:7px;font-size:11px;color:var(--fg-55)">Sam Ortiz · 3d ago</div>
          </div>
        </div>
      </div>`;

  const prio = (p: string, c: string) => `<span style="font-family:var(--label);font-size:8.5px;font-weight:600;text-transform:uppercase;color:var(--${c});border:1px solid ${c === "fg-55" ? "var(--border-strong)" : `color-mix(in srgb, var(--${c}) 45%, transparent)`};border-radius:4px;padding:1px 4px;flex:none">${p}</span>`;
  const nobody = `<span style="width:18px;height:18px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:8px;font-weight:600;color:var(--fg-40);flex:none">–</span>`;
  const card = (i: number, title: string, meta: string, who: string) => `<div class="site-st st-pop" style="border:1px solid var(--border);border-radius:8px;padding:8px 9px;background:var(--bg);${at(S + 250 + i * 110)}">
      <div style="font-size:11px;font-weight:600;line-height:1.35">${title}</div>
      <div style="margin-top:7px;display:flex;align-items:center;gap:5px;font-size:9.5px;color:var(--fg-40)">${meta}<span style="margin-left:auto;display:flex">${who}</span></div>
    </div>`;
  const column = (name: string, color: string, cards: string[], hideSm = false) => `<div${hideSm ? ` class="site-hide-sm"` : ""} style="min-width:0;display:flex;flex-direction:column;gap:7px">
      <div style="display:flex;align-items:center;padding-bottom:6px;border-bottom:1px solid var(--border);font-family:var(--label);font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--${color})">${name}<span style="margin-left:auto;color:var(--fg-40)">${cards.length}</span></div>
      ${cards.join("")}
    </div>`;
  const tickets = `
      <div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:600">Tickets</span>
        <span style="margin-left:auto;display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden;font-size:10.5px;font-weight:500">${segTab("Board", true)}${segTab("Table", false, true)}</span>
      </div>
      <div style="padding:14px 16px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(110px,100%),1fr));gap:10px;align-items:start">
        ${column("Triage", "blue", [card(0, "Email digest lands twice on Mondays", `#218 · ${prio("P2", "fg-55")}`, nobody), card(3, "Onboarding checklist is stale", "↗ GitHub #230", initials("SO", 18, "7.5px"))])}
        ${column("In progress", "accent", [card(1, "Rate limiting on the public API", `#212 · ${prio("P0", "red")}`, initials("LP", 18, "7.5px"))])}
        ${column("Testing", "amber", [card(2, "Retry-After on 429 responses", "#213 · 3 comments", initials("MC", 18, "7.5px"))])}
        ${column("Done", "green", [card(4, "SSO step in the checklist", "#209", initials("SO", 18, "7.5px"))], true)}
      </div>`;

  const lane = (i: number, label: string, left: number, width: number, pct: number, color: string, count: string) => `<div class="site-st st-l" style="position:relative;height:30px;${at(S + i * 150)}">
      <div style="position:absolute;left:${left}%;width:${width}%;top:3px;bottom:3px;border:1px solid color-mix(in srgb, var(--${color}) 50%, transparent);background:color-mix(in srgb, var(--${color}) 9%, transparent);border-radius:6px;overflow:hidden">
        <span class="site-bar" style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:color-mix(in srgb, var(--${color}) 26%, transparent);${at(S + 250 + i * 150)}"></span>
        <span style="position:relative;display:flex;align-items:center;height:100%;padding:0 8px;gap:6px;font-size:10.5px;font-weight:600;white-space:nowrap"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${label}</span><span style="margin-left:auto;font-family:var(--label);font-size:9.5px;font-weight:500;color:var(--fg-55)">${count}</span></span>
      </div>
    </div>`;
  const month = (label: string, left: number) => `<span style="position:absolute;left:${left}%;top:0;font-family:var(--label);font-size:9.5px;color:var(--fg-40)">${label}</span>`;
  const stat = (n: string, label: string, c = "fg") => `<div><div style="font-size:16px;font-weight:650;color:var(--${c})">${n}</div><div style="margin-top:2px;font-family:var(--label);font-size:8.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)">${label}</div></div>`;
  const roadmap = `
      <div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:600">Roadmap</span>
        <span style="margin-left:auto;display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden;font-size:10.5px;font-weight:500">${segTab("Narrative", false)}${segTab("Timeline", true, true)}</span>
      </div>
      <div style="padding:16px 18px 20px">
        <div style="display:flex;gap:22px;padding-bottom:14px;border-bottom:1px solid var(--border)">${stat("2", "In progress")}${stat("1", "Upcoming")}${stat("Oct 2", "Next due")}</div>
        <div style="position:relative;height:16px;margin-top:14px">${month("Sep", 0)}${month("Oct", 33)}${month("Nov", 66)}</div>
        <div style="position:relative;margin-top:6px;display:flex;flex-direction:column;gap:6px">
          <span style="position:absolute;left:36%;top:-4px;bottom:-4px;width:1.5px;background:var(--red);opacity:.8"></span>
          ${lane(0, "Hardening the public API", 2, 38, 66, "accent", "4/6")}
          ${lane(1, "Notifications and digests", 24, 42, 12, "blue", "1/8")}
          ${lane(2, "Self-host guide", 58, 38, 0, "fg-55", "0/3")}
        </div>
      </div>`;

  const tileHead = (title: string, sub: string) => `<div style="padding:11px 13px 9px"><div style="font-size:12px;font-weight:600">${title}</div><div style="margin-top:2px;font-size:10px;color:var(--fg-55)">${sub}</div></div>`;
  const tRow = (i: number, title: string, meta: string) => `<div class="site-st st-l" style="padding:8px 13px;border-top:1px solid var(--border);${at(S + 200 + i * 120)}"><div style="font-size:11px;font-weight:600;line-height:1.35">${title}</div><div style="margin-top:3px;font-size:9.5px;color:var(--fg-55)">${meta}</div></div>`;
  const rRow = (i: number, title: string, kind: string, btn: string) => `<div class="site-st st-l" style="display:flex;align-items:center;gap:8px;padding:8px 13px;border-top:1px solid var(--border);${at(S + 320 + i * 120)}"><div style="min-width:0;flex:1"><div style="font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div><div style="margin-top:3px">${kind}</div></div><span style="flex:none;background:var(--accent);color:var(--accent-fg);font-size:9.5px;font-weight:600;padding:3px 8px;border-radius:5px">${btn}</span></div>`;
  const tileBox = "min-width:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)";
  const mywork = `
      <div class="site-st" style="font-size:17px;font-weight:650;letter-spacing:-0.015em;${at(S)}">Good morning, Maya</div>
      <div class="site-st" style="margin-top:3px;font-size:11px;color:var(--fg-55);${at(S + 80)}">2 tickets open · 2 to review · 1 handoff waiting</div>
      <div style="margin-top:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:10px">
        <div style="${tileBox}">
          ${tileHead("Tickets for you", "2 open")}
          ${tRow(0, "Retry-After on 429 responses", "Testing · Hardening the public API · due Oct 2")}
          ${tRow(1, "Digest de-dupe on Mondays", "In progress · Notifications and digests")}
        </div>
        <div style="${tileBox}">
          ${tileHead("Needs your review", "1 to promote, 1 to ratify")}
          ${rRow(0, "Deploy process", pill("staged", "amber"), "Promote")}
          ${rRow(1, "ADR-0012 · Retry budget", pill("draft", "blue"), "Ratify")}
        </div>
      </div>`;

  const hsec = (label: string, items: string[], start: number) => `<div style="margin-top:12px">
        <div style="font-family:var(--label);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)">${label}</div>
        ${items.map((t, i) => `<div class="site-st st-l" style="margin-top:5px;display:flex;gap:8px;font-size:11.5px;line-height:1.5;color:var(--fg-70);${at(start + i * 90)}"><span style="color:var(--fg-40)">·</span>${t}</div>`).join("")}
      </div>`;
  const handoffs = `
      <div style="display:flex;align-items:center;gap:9px;padding:12px 16px;border-bottom:1px solid var(--border)">
        <span style="font-family:var(--label);font-size:11px;color:var(--fg-40)">#17</span>
        <span style="font-size:12.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Retry-After is wired, the tests aren't</span>
        <span class="site-swap" style="margin-left:auto;${at(S + 1500)}">${pill("pending", "blue")}${pill("claimed", "green")}</span>
      </div>
      <div style="padding:12px 16px 16px">
        <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:var(--fg-55);flex-wrap:wrap">${initials("LP", 20, "8px")}Leo Park → Maya Chen<span style="font-family:var(--label);font-size:10px;color:var(--fg-40);margin-left:auto">feat/retry-after</span></div>
        ${hsec("Done", ["429s carry Retry-After from the bucket's reset time"], S + 150)}
        ${hsec("Next", ["Add limiter tests for the reset edge", "Note the header in the API doc"], S + 330)}
        <div class="site-st" style="margin-top:14px;border-radius:8px;background:var(--term);color:var(--term-fg);padding:10px 12px;font-family:var(--code);font-size:10.5px;line-height:1.75;${at(S + 800)}">
          <div style="color:#9aab65">⏺ trov · load-context</div>
          <div style="color:rgba(237,233,226,0.85)">1 handoff waiting: #17 from @leo. Claim it?</div>
          <div class="site-st" style="color:rgba(237,233,226,0.6);${at(S + 1350)}">&gt; yes</div>
        </div>
      </div>`;

  const kindTag = (k: string) => `<span style="font-family:var(--label);font-size:9px;color:var(--fg-40);border:1px solid var(--border);border-radius:4px;padding:1px 5px">${k}</span>`;
  const bars = (ws: number[]) => ws.map((w) => `<span style="display:block;height:5px;width:${w}%;border-radius:3px;background:var(--border-strong);margin-top:5px"></span>`).join("");
  const artCard = (i: number, preview: string, title: string, kind: string, badge: string) => `<div class="site-st st-pop" style="border:1px solid var(--border);border-radius:9px;overflow:hidden;${at(S + 150 + i * 110)}">
      <div style="height:62px;padding:10px 12px;background:var(--hover)">${preview}</div>
      <div style="padding:9px 12px 11px">
        <div style="font-size:11.5px;font-weight:600;line-height:1.35">${title}</div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:6px">${kindTag(kind)}<span style="margin-left:auto">${badge}</span></div>
      </div>
    </div>`;
  const flow = `<div style="display:flex;align-items:center;gap:5px;height:100%">${["Cron", "Render", "Send"].map((t) => `<span style="font-size:8.5px;border:1px solid var(--border-strong);border-radius:4px;padding:3px 5px;background:var(--bg);color:var(--fg-55)">${t}</span>`).join(`<span style="color:var(--fg-40);font-size:9px">→</span>`)}</div>`;
  const artifacts = `
      <div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:600">Artifacts</span>
        <span style="margin-left:auto;font-family:var(--label);font-size:10px;color:var(--fg-40)">ticket #212 · 3 pages</span>
      </div>
      <div style="padding:14px 16px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:10px">
        ${artCard(0, bars([70, 45, 88, 30]), "Rate limit headers: design", "html", `<span class="site-swap" style="${at(S + 1300)}">${pill("published", "blue")}${pill("ratified", "green")}</span>`)}
        ${artCard(1, flow, "Digest pipeline", "svg", pill("published", "blue"))}
        ${artCard(2, bars([55, 80, 62]), "429 rates by org, last 7 days", "markdown", pill("draft", "fg-55"))}
      </div>`;

  return `<section id="site-tour" style="${section()}">
    ${heading("tour-head", "One place for what the team knows.")}
    <div style="margin-top:64px;display:flex;flex-direction:column;gap:96px">
      ${tourRow("docs", "Docs", "A library that stays reviewed", "Technical and Product spaces, full version history on every doc, and a heading outline for long pages.", MOCK, docs)}
      ${tourRow("feed", "Feed", "A timeline of what shipped", "Every entry leads with a short brief for people and links to the PRs, commits, and issues behind it. Agents get the full record.", `${MOCK};padding:18px 18px 20px;display:flex;flex-direction:column;gap:12px`, feed, true)}
      ${tourRow("tickets", "Tickets", "A board the whole team files into", "Drag cards across Triage, In progress, Testing, and Done, or read the queue as a table by sprint. Comments with @mentions, sub-tickets, and GitHub issues mirrored in as tickets.", MOCK, tickets)}
      ${tourRow("roadmap", "Roadmap", "Sprints on a calendar", "A short narrative with its sprint cards, and a timeline that runs each sprint from start to due date, filled by its done tickets.", MOCK, roadmap, true)}
      ${tourRow("mywork", "My Work", "Your day on one page", "Your tickets, what's waiting on your review, your recent sessions and handoffs, and the repo at a glance.", `${MOCK};padding:20px 22px 22px`, mywork)}
      ${tourRow("handoffs", "Handoffs", "Pick up where the last session stopped", "An agent leaves a note for the next session or a teammate: what's done, what's next, and the branch. The next session offers it and claims it only when you say so.", MOCK, handoffs, true)}
      ${tourRow("artifacts", "Artifacts", "Designs and reports, versioned", "HTML pages, markdown reports, diagrams, images, and PDFs, linked to the ticket or sprint they came from. Agents publish them. Only a person can ratify one.", MOCK, artifacts)}
    </div>
  </section>`;
}

// ── 6 · smaller features ─────────────────────────────────────────────────────
function extras(): string {
  const card = (i: number, title: string, body: string) => `<div class="site-st site-card" style="border:1px solid var(--border);border-radius:12px;padding:22px 24px;${at(i * 90)}">
      ${title}
      <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:var(--fg-70)">${body}</p>
    </div>`;
  const t = (text: string) => `<div style="font-size:14.5px;font-weight:650">${text}</div>`;
  const swatch = (bg: string, i: number) => `<span class="site-st st-pop" style="width:14px;height:14px;border-radius:50%;background:${bg};border:1px solid var(--border-strong);${at(420 + i * 80)}"></span>`;
  return `<section style="max-width:1120px;margin:0 auto;padding:130px 24px 0">
    <div ${rv("extras", "rv-static")} style="display:grid;grid-template-columns:repeat(auto-fit, minmax(min(300px, 100%), 1fr));gap:16px">
      ${card(0, t("Decisions"), "ADRs drafted by agents, ratified by people.")}
      ${card(1, t("Search everything"), "One box jumps to any ticket, doc, sprint, artifact, prompt, or person. Agents also see pending proposals, labeled.")}
      ${card(2, t("Prompt Library"), "Reusable prompts with variables. Agents stage new ones, people publish them.")}
      ${card(3, t("Repo dashboard"), "Deploys, CI, drift, and usage from captured data. Unknown reads as unknown, never zero.")}
      ${card(4, t("Email digests"), "Daily or weekly, per section, so nobody has to poll the feed.")}
      ${card(5,`<div style="display:flex;align-items:center;gap:8px"><span style="font-size:14.5px;font-weight:650">Light and dark</span><span style="display:flex;gap:4px;margin-left:auto">${swatch("#f6f6f7", 0)}${swatch("#1c1a16", 1)}</span></div>`, "Two themes, or follow your system.")}
    </div>
  </section>`;
}

// ── 7 · for agents ───────────────────────────────────────────────────────────
function agents(): string {
  // The tool chips cascade in, group after group, as one continuous stagger.
  let n = 0;
  const chips = (names: string[], admin = false) => {
    const st = admin
      ? "font-family:var(--label);font-size:11px;border:1px dashed var(--border-strong);border-radius:6px;padding:3px 8px;color:var(--fg-55)"
      : "font-family:var(--label);font-size:11px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--fg-70)";
    return `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${names.map((name) => `<span class="site-st st-pop" style="${st};${at(300 + n++ * 28)}">${name}</span>`).join("")}</div>`;
  };
  const group = (label: string, names: string[], admin = false) => `<div>
      <div style="font-family:var(--label);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)">${label}</div>
      ${chips(names, admin)}
    </div>`;
  const tools = `
          ${group("Read", ["query", "get_doc", "list_docs", "get_feed", "get_roadmap", "get_my_work", "get_events", "get_repo_dashboard"])}
          ${group("Contribute", ["append_feed", "propose_doc_update", "record_session"])}
          ${group("Tickets", ["list_tickets", "get_ticket", "create_ticket", "edit_ticket", "transition_ticket", "add_ticket_comment", "add_ticket_link", "set_ticket_sprint", "set_ticket_parent"])}
          ${group("Sprints", ["list_sprints", "get_sprint", "create_sprint", "set_sprint_active", "complete_sprint", "add_sprint_resource", "delete_sprint"])}
          ${group("Handoffs and prompts", ["send_handoff", "list_handoffs", "get_handoff", "claim_handoff", "expire_handoff", "search_prompts", "get_prompt", "save_prompt"])}
          ${group("Artifacts and doc images", ["upload_asset", "artifact_update", "artifact_get", "artifact_list"])}
          ${group("Admin", ["update_plan"], true)}`;
  n = 0;
  const skills = chips(["trov", "load-context", "record-session", "my-work", "tickets", "handoff", "prompts", "artifacts", "read-plan", "update-plan"]);
  const [cmd1, cmd1End] = typed("/plugin marketplace add AndresL230/trov", 700, 28);
  const [cmd2, cmd2End] = typed("/plugin install trov@trov", cmd1End + 300, 28);
  const prompt = `<span style="color:rgba(237,233,226,0.45)">$</span> `;

  return `<section id="site-agents" style="${section()}">
    ${heading("agents-head", "For agents", "An MCP server agents connect to directly, and a Claude Code plugin that wires it up with the skills that drive the loop.")}
    <div style="margin-top:48px;display:grid;grid-template-columns:repeat(auto-fit, minmax(min(320px, 100%), 1fr));gap:16px;align-items:stretch">
      <div ${rv("agents-mcp")} style="border:1px solid var(--border);border-radius:13px;padding:26px 28px">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span style="font-size:17px;font-weight:650">MCP server</span>
          <span style="font-family:var(--label);font-size:11px;color:var(--fg-55)">39 tools, plus 1 admin-only</span>
        </div>
        <div style="margin-top:20px;display:flex;flex-direction:column;gap:16px">${tools}
        </div>
      </div>
      <div ${rv("agents-plugin")} style="border:1px solid var(--border);border-radius:13px;padding:26px 28px;display:flex;flex-direction:column;${at(120)}">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span style="font-size:17px;font-weight:650">Claude Code plugin</span>
          <span style="font-family:var(--label);font-size:11px;color:var(--fg-55)">10 skills, installed in two commands</span>
        </div>
        <div style="margin-top:12px">${skills}</div>
        <div style="margin-top:auto;padding-top:22px">
          <div style="border-radius:10px;background:var(--term);color:var(--term-fg);border:1px solid var(--border);padding:16px 18px;font-family:var(--code);font-size:12px;line-height:2;overflow-x:auto">
            <div style="white-space:nowrap">${prompt}${cmd1}</div>
            <div style="white-space:nowrap">${prompt}${cmd2}<span class="site-caret" style="${at(cmd2End + 150)}"></span></div>
          </div>
          <p style="margin:12px 0 0;font-size:12.5px;line-height:1.6;color:var(--fg-55)">Wires the MCP server and loads all ten skills. Then connect by browser sign-in: run <span style="font-family:var(--label);font-size:11.5px">/mcp</span>, pick trov, and choose Authenticate.</p>
          <button data-act="siteGuide" class="site-btn site-btn-outline" style="margin-top:16px">Setup steps in Get Started</button>
        </div>
      </div>
    </div>
  </section>`;
}

// ── 8 · security ─────────────────────────────────────────────────────────────
function security(): string {
  const row = (i: number, text: string) => `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)">${check(15, 200 + i * 130, "margin-top:3px;")}<span class="site-st st-l" style="font-size:14.5px;line-height:1.55;color:var(--fg-70);${at(260 + i * 130)}">${text}</span></div>`;
  return `<section id="site-security" style="${section()}">
    ${heading("security-head", "Security, in plain terms")}
    <div ${rv("security", "rv-static")} style="margin-top:44px;display:grid;grid-template-columns:repeat(auto-fit, minmax(min(300px, 100%), 1fr));gap:14px 40px;max-width:900px">
      ${row(0, "Sign-in with GitHub or Google, restricted to your org.")}
      ${row(1, "Agents connect by browser sign-in; only hashes of their tokens are stored.")}
      ${row(2, "Agents write as their person and can't claim another author.")}
      ${row(3, "Agents can only change tickets assigned to their person.")}
      ${row(4, "Tickets and sprints are never closed automatically.")}
      ${row(5, "Only a person can ratify an artifact or publish a prompt.")}
      ${row(6, "Artifact pages run in a sandbox, cut off from your session.")}
      ${row(7, "GitHub webhooks are signature-verified.")}
    </div>
  </section>`;
}

// ── sign-in dialog (the old login card, now opened from the landing) ────────
function signInDialog(): string {
  return `<div data-act="closeSignIn" style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);animation:cnpy-fade .14s ease"></div>
  <div style="position:fixed;inset:0;z-index:61;display:grid;place-items:center;padding:16px;pointer-events:none">
    <div role="dialog" aria-modal="true" aria-labelledby="signin-title" style="pointer-events:auto;position:relative;width:min(400px, 100%);border:1px solid var(--border-strong);border-radius:14px;padding:32px 30px 26px;background:var(--bg);box-shadow:var(--lift-shadow);animation:cnpy-pop .16s ease">
      <button data-act="closeSignIn" title="Close" aria-label="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--fg-40)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"></path></svg>
      </button>
      <div style="display:flex;align-items:center;justify-content:center;gap:10px">
        ${mark(26)}
        <span id="signin-title" style="font-size:22px;font-weight:600;letter-spacing:-0.02em">Sign in to Trov</span>
      </div>
      <div style="margin-top:12px;font-size:14px;color:var(--fg-70);text-align:center;line-height:1.55">Sign in to open your organization, or to accept an invitation to one.</div>
      <div style="margin-top:24px;display:flex;flex-direction:column;gap:18px">
        <button data-act="signIn" class="cnpy-accentbtn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.61-4.04-1.61-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.83 2.81 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.32-5.47-5.87 0-1.3.47-2.36 1.23-3.19-.12-.3-.53-1.51.12-3.15 0 0 1.01-.32 3.3 1.22a11.5 11.5 0 0 1 6 0c2.29-1.54 3.3-1.22 3.3-1.22.65 1.64.24 2.85.12 3.15.77.83 1.23 1.89 1.23 3.19 0 4.56-2.81 5.57-5.49 5.86.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z"></path></svg>
          Sign in with GitHub
        </button>
        <div style="display:flex;align-items:center;gap:12px;font-family:var(--label);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg-40)"><span style="flex:1;height:1px;background:var(--border)"></span>or<span style="flex:1;height:1px;background:var(--border)"></span></div>
        <button data-act="signInGoogle" class="cnpy-outlinebtn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:14px;font-weight:600;color:var(--fg)">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.2v3.1C3.2 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.3c-.5-1.5-.5-3.1 0-4.6V6.6H1.2c-1.6 3.3-1.6 7.3 0 10.6l4.1-2.9z"/><path fill="#EA4335" d="M12 4.7c1.7 0 3.3.6 4.5 1.7l3.4-3.4C17.9 1.1 15.1 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4.1 3.1c.9-2.9 3.6-5 6.7-5z"/></svg>
          Continue with Google
        </button>
      </div>
      <div style="text-align:center;margin-top:20px;font-size:12.5px;color:var(--fg-40);line-height:1.5">Any GitHub account can sign in. A Google account needs an invitation from an organization's admin first.</div>
    </div>
  </div>`;
}

export interface LandingProps {
  /** The resolved app theme is not Light (drives the toggle icon, like the app header's). */
  dark: boolean;
  signInOpen: boolean;
  /** Opened from inside the app (the sidebar logo): the nav offers the way back, not Sign in. */
  signedIn?: boolean;
  /** Reveal keys that already played (landing-motion.ts records them). */
  seen: ReadonlySet<string>;
}

export function landingView(p: LandingProps): string {
  seen = p.seen;
  return `<div class="cnpy-site">
    ${nav(p.dark, p.signedIn ?? false)}
    ${hero()}
    ${problem()}
    ${loop()}
    ${authority()}
    ${tour()}
    ${extras()}
    ${agents()}
    ${security()}
    ${siteFooter()}
  </div>
  ${p.signInOpen ? signInDialog() : ""}`;
}
