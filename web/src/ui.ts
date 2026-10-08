// Shared presentational atoms for the componentized surfaces (Review /
// Maintenance) and the render layer. Pure functions over props — no data,
// no fetching, no state. Markup follows the app's template-string idiom:
// inline styles over the trov.css custom properties, interactions via
// data-act / data-arg dispatched in main.ts.

/** Escape text content for safe insertion into innerHTML. */
export function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escape a value for use inside an HTML attribute (delegates to esc for full safety). */
export function attr(v: string): string {
  return esc(v);
}

/** The uppercase label-face eyebrow/label style used across both surfaces. */
export const MONO_LABEL =
  "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";

/** The surface card's class (trov.css `.cnpy-surface`): background, hairline border, 10px
 *  radius and small shadow, defined ONCE there. */
export const SURFACE = "cnpy-surface";

/** The attributes of a surface card: ` class="cnpy-surface …" style="…"`, to splice into an
 *  opening tag (`<section${surface("padding:18px 20px", { cls: "cnpy-rise" })}>`). `style` is
 *  the card's own layout and padding only — never a border, background, radius or shadow,
 *  which the class owns. `hover` adds the interactive modifier (`.cnpy-card`: the hairline
 *  darkens on hover) for a card that opens something. */
export function surface(style = "", opts: { hover?: boolean; cls?: string } = {}): string {
  const cls = [SURFACE, opts.hover ? "cnpy-card" : "", opts.cls ?? ""].filter(Boolean).join(" ");
  return ` class="${cls}"${style ? ` style="${style}"` : ""}`;
}

/** A card or row that opens something AND shows people, whose names and photos open their
 *  person card. A button may not hold a button, so the card is a plain container
 *  (`HITBOX`, position:relative) and this empty button, laid over the whole of it as its
 *  LAST child, is the card's own click target and focus stop (`label` its accessible name);
 *  every person button inside (people.ts's links, a linked avatar stack) sits above it
 *  (trov.css). Last, so a card that lays out by `:nth-child` (the queue table's narrow
 *  reflow) counts the same children. */
export function hitArea(act: string, arg: string, label: string): string {
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" class="cnpy-hit" aria-label="${attr(label)}"></button>`;
}
/** The class a `hitArea` card carries. */
export const HITBOX = "cnpy-hitbox";

// ── two columns + a sticky aside (Roadmap › Narrative, Feed) ─────────────────
// trov.css `.cnpy-cols-page` / `.cnpy-cols` / `.cnpy-cols-aside`: the main column beside a
// 360px aside that sticks at the page's own top padding (--cols-pad-top), one column (aside below) under an 880px page.

/** A page in two columns: `main` on the left, `aside` (its boxes) as the sticky right column.
 *  `tabs` heads the page with a tab bar (tabs.ts `tabBar`, passed in as markup — this module
 *  cannot import it) and wraps the columns in its panel (`panel` = `tabPanelAttrs(…)`), 20px
 *  under the bar's line: Roadmap › Narrative. Without it the markup is unchanged (the Feed). */
export function asideColumns(main: string, aside: string, tabs?: { bar: string; panel: string }): string {
  const cols = `<div class="cnpy-cols">
      <div style="min-width:0">${main}</div>
      <aside class="cnpy-cols-aside cnpy-stagger">${aside}</aside>
    </div>`;
  return `<div class="cnpy-scroll cnpy-cols-page" style="max-width:1200px;margin:0 auto;padding:var(--cols-pad-top) 32px 80px">
    ${tabs ? `${tabs.bar}<div${tabs.panel} style="padding-top:20px">${cols}</div>` : cols}
  </div>`;
}

/** The quiet trailing arrow of a box's title-row link. */
export const ASIDE_ARROW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`;

/** An aside box's title row: a 14px title and, on the right, a quiet "label →" link. */
export function asideHead(title: string, link?: { act: string; label: string; arg?: string }): string {
  const go = link
    ? `<button data-act="${attr(link.act)}"${link.arg !== undefined ? ` data-arg="${attr(link.arg)}"` : ""} class="mw-more" style="display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:var(--fg-40);white-space:nowrap;padding:0">${esc(link.label)}${ASIDE_ARROW}</button>`
    : "";
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px 8px"><span style="font-size:14px;font-weight:500">${esc(title)}</span>${go}</div>`;
}

/** An aside box's body when it has no rows (loading, failed, empty) — below a hairline. `html` is trusted markup. */
export function asideNote(html: string): string {
  return `<div style="padding:12px 18px 14px;border-top:1px solid var(--border);font-size:13px;color:var(--fg-40)">${html}</div>`;
}

/** Bordered tinted status chip (STAGED / DRAFT / …); colorVar is a CSS var expression.
 *  `size` overrides the box (height, padding, font size, radius) where the chip sits in a
 *  row of buttons and must match their height. */
export function statusBadge(text: string, colorVar: string, size = "font-size:10px;border-radius:5px;padding:2px 6px"): string {
  return `<span style="font-family:var(--label);font-weight:600;letter-spacing:.04em;color:${colorVar};border:1px solid color-mix(in srgb,${colorVar} 45%,transparent);background:color-mix(in srgb,${colorVar} 12%,transparent);${size};flex:none;white-space:nowrap">${esc(text)}</span>`;
}

/** Selectable filter/view chip. `small` is the compact variant (diff view toggle). */
export function selectChip(label: string, active: boolean, act: string, arg: string, small = false): string {
  const pad = small ? "4px 10px" : "5px 11px";
  const size = small ? "12px" : "12.5px";
  const style = `padding:${pad};border-radius:7px;font-size:${size};font-weight:500;transition:all .12s ease;border:1px solid ${active ? "var(--accent)" : "var(--border)"};color:${active ? "var(--accent)" : "var(--fg-55)"};background:${active ? "var(--accent-soft)" : "transparent"}`;
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="${style}">${esc(label)}</button>`;
}

/** Selectable list row (assign kinds, assign targets, person picker). */
export function pickRow(inner: string, active: boolean, act: string, arg: string, extraStyle = ""): string {
  const style = `display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:7px;font-size:13px;font-weight:500;text-align:left;width:100%;transition:all .12s ease;border:1px solid ${active ? "var(--accent)" : "var(--border)"};color:${active ? "var(--accent)" : "var(--fg-70)"};background:${active ? "var(--accent-soft)" : "transparent"};${extraStyle}`;
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="${style}">${inner}</button>`;
}

/** Accent primary button that renders inert (muted outline) until `enabled`. */
export function primaryBtn(label: string, enabled: boolean, act: string, arg: string, extraStyle = ""): string {
  const style = enabled
    ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent;cursor:pointer"
    : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default";
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" class="${enabled ? "cnpy-accentbtn" : ""}" style="${style};border-radius:8px;padding:7px 15px;font-size:12.5px;font-weight:600;transition:all .12s ease;${extraStyle}">${esc(label)}</button>`;
}

/** Dashed-border empty-state card (Review list + detail). */
export function dashedCard(title: string, sub: string, wide = false): string {
  const pad = wide ? "36px 44px" : "28px 20px";
  return `<div style="border:1px dashed var(--border-strong);border-radius:${wide ? "13px" : "11px"};padding:${pad};text-align:center;${wide ? "max-width:380px;" : "margin-top:4px;"}">
    <div style="font-size:${wide ? "15px" : "13.5px"};font-weight:${wide ? "600" : "500"};color:var(--fg-70)">${esc(title)}</div>
    <div style="font-size:12.5px;color:var(--fg-40);margin-top:${wide ? "6px" : "4px"}">${esc(sub)}</div>
  </div>`;
}

/** Two-letter avatar initials from a github login, e.g. "jose-a" → "JO". */
export function initialsOf(login: string): string {
  const letters = login.replace(/[^a-zA-Z]/g, "");
  return (letters.slice(0, 2) || login.slice(0, 2) || "?").toUpperCase();
}
/** Relative time from an ISO timestamp, e.g. "32m ago" / "2d ago". */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The frame the four ticket/sprint screens sit in. These are WORK surfaces — a
 *  queue table, a filing form, a thread beside a rail — so they take the window
 *  instead of sitting in a narrow column the way Feed and Roadmap (reading
 *  surfaces) deliberately do: fluid to 1440px, with a gutter that grows with the
 *  viewport. Reading measures are capped per block inside (a ticket body, a
 *  sprint description), never by starving the whole frame. */
export const WORK_SHELL =
  "width:100%;max-width:1440px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px";
/** A single ticket's or sprint's page: the same shell, narrower, so one item reads
 *  as a centred document on a wide screen instead of hugging the left edge. */
export const DETAIL_SHELL =
  "width:100%;max-width:1120px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px";

/** What sits behind a first-run card (onboarding, the org picker): the outline of the app itself,
 *  blurred and washed toward the page, so the card reads as a step in front of Trov, not a page of its
 *  own. Decoration only: no text, no data, nothing focusable. */
export function appBackdrop(): string {
  const card = (h: number, tag = false) => `<div class="cnpy-fr-card" style="height:${h}px"><i></i><i></i>${tag ? "<b></b>" : ""}</div>`;
  const col = (cards: string) => `<div class="cnpy-fr-col"><i></i>${cards}</div>`;
  return `<div class="cnpy-fr-bg" aria-hidden="true"><div class="cnpy-fr-app">
    <div class="cnpy-fr-side"><b></b><i></i><i></i><i></i><i></i><u></u><i></i><i></i><i></i><u></u><i></i><i></i></div>
    <div class="cnpy-fr-main">
      <div class="cnpy-fr-top"><i></i><b></b></div>
      <div class="cnpy-fr-cols">
        ${col(card(92, true) + card(74) + card(108, true) + card(74))}
        ${col(card(74) + card(118, true) + card(86))}
        ${col(card(104, true) + card(74) + card(92) + card(74, true))}
        ${col(card(86) + card(74, true))}
      </div>
    </div>
  </div></div>`;
}
