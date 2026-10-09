// One message per user per run, styled on the site's own tokens (the light
// theme from web/src/trov.css flattened to hex, since mail clients have no CSS
// variables): a 600px cream card with a hairline border and 13px radius, the
// Trov wordmark + cadence as the header, one block per section (heading,
// summary, body, an "Open X →" ghost button), and a footer naming the recipient
// with the unsubscribe link. A <style> block under prefers-color-scheme: dark
// swaps every token to the dark theme via [style*=] attribute selectors, so the
// renderers' inline styles flip too (Apple Mail / iOS / Outlook for Mac honor it;
// Gmail ignores it and applies its own inversion). Plain-text alternative always
// included.
import { TROV_MARK_GRID } from "@shared/mark";
import type { Section, Window } from "@shared/notifications";
import { escapeHtml } from "./html";
import { localDate } from "./window";

export interface AssembledMessage {
  subject: string;
  html: string;
  text: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 24 * 60 * 60 * 1000;

/** Flatten `fg` at `t` opacity over `bg` to a hex — mail clients get no alpha, the dark swap keys on hex. */
function mix(fg: string, bg: string, t: number): string {
  const c = (h: string) => h.replace("#", "").match(/../g)!.map((x) => parseInt(x, 16));
  const [a, b] = [c(fg), c(bg)];
  return "#" + a.map((v, i) => Math.round(v * t + b[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
}

/** Site tokens (web/src/trov.css), light → dark. Every colour in the email comes from here. */
const BASE = {
  // Trov's brand: the purple of the mark (`--mark` #616ACB) on the light theme's cool neutrals. The dark
  // column is the same purple family on near-black — mail is the brand's, not the app's olive dark theme.
  // The card is a hair off white on purpose: #ffffff is the literal ink on the band and on buttons, and
  // the dark swap rewrites every inline colour that equals a token.
  ground: { light: "#f1f1f5", dark: "#0f0f12" }, // page behind the card (one step past --bg)
  bg: { light: "#fbfbfd", dark: "#17171b" }, // the card
  fg: { light: "#16161a", dark: "#ededf0" }, // --fg
  fg70: { light: "#4f4f58", dark: "#b3b3b9" }, // --fg-70
  fg55: { light: "#6e6e78", dark: "#8b8b93" }, // --fg-55
  fg40: { light: "#8e8e98", dark: "#6c6c74" }, // --fg-40
  border: { light: "#e6e6ea", dark: "#2b2b31" }, // --border
  borderStrong: { light: "#d6d6dc", dark: "#3d3d45" }, // --border-strong
  hover: { light: "#f0f0f4", dark: "#25252b" }, // --hover (code spans)
  accent: { light: "#616acb", dark: "#5e6ad2" }, // the mark's purple (the band, button fills): white ink on it is ≥ 4.5:1 in both
  accentText: { light: "#4a54b8", dark: "#a4abf2" }, // the purple as small TEXT: ~6.3:1 on the light card, lightened for the dark one
  green: { light: "#1b6c42", dark: "#5ab86c" }, // --green (MERGED / ADDED)
  blue: { light: "#3e6f8a", dark: "#6aa8c4" }, // --blue (CHANGED)
  amber: { light: "#b4562c", dark: "#d98a52" }, // --amber (priority / LOW CONFIDENCE)
} as const;
/** Chip fills mirror the app's color-mix(<c> 12%) background and color-mix(<c> 45%) border. */
const soft = (k: "accentText" | "green" | "blue" | "amber", t: number) => ({ light: mix(BASE[k].light, BASE.bg.light, t), dark: mix(BASE[k].dark, BASE.bg.dark, t) });
export const THEME = {
  ...BASE,
  accentSoft: soft("accentText", 0.12), accentLine: soft("accentText", 0.45),
  greenSoft: soft("green", 0.12), greenLine: soft("green", 0.45),
  blueSoft: soft("blue", 0.12), blueLine: soft("blue", 0.45),
  amberSoft: soft("amber", 0.12), amberLine: soft("amber", 0.45),
} as const;
const C = Object.fromEntries(Object.entries(THEME).map(([k, v]) => [k, v.light])) as { [K in keyof typeof THEME]: string };
export const EMAIL_COLORS = C;

/**
 * Spacing scale: an 8pt grid with a 4pt sub-grid (every step a multiple of 4).
 * Rules applied throughout: line-heights are multiples of 4 (13px/20px body,
 * 15px/20px headings, 10.5px/16px labels); a heading gets ~3× more space above
 * than below (24 over / 8 under a group label); the space after a heading equals
 * the paragraph gap; internal gaps never exceed the external gap around them.
 */
export const EMAIL_SPACE = { xs: 4, s: 8, m: 16, l: 24, xl: 32 } as const;

/**
 * Card width, shared by every Trov email (digests + invite) so they are one
 * shell. Wider than the stock 600px — the digests read cramped at that width —
 * while staying inside what desktop clients render without a horizontal scroll;
 * `max-width:100%` still collapses it to the viewport on a phone.
 */
export const EMAIL_WIDTH = 680;
const SP = EMAIL_SPACE;

const SANS = "font-family:Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
const LABEL = "font-family:'Archivo Narrow',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
const CODE = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
export const FONTS_HREF = "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Archivo+Narrow:wght@500;600&display=swap";
export const EMAIL_FONT = { sans: SANS, label: LABEL } as const;

/** Shared inline-style tokens for the section renderers (mirrors the app's text tiers). */
export const EMAIL_STYLE = {
  /** Uppercase section label — the app's `.cnpy-treesec` / SECTION_LABEL. */
  label: `${LABEL}font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${C.fg40};`,
  /** Reference cell (#123). */
  ref: `${LABEL}font-size:12px;line-height:20px;color:${C.fg55};vertical-align:top;padding:${SP.xs}px 0;`,
  /** Row text. */
  body: `${SANS}font-size:13px;line-height:20px;color:${C.fg};padding:${SP.xs}px 0;`,
  /** Secondary line under a row. */
  muted: `${SANS}font-size:13px;line-height:20px;color:${C.fg55};`,
  /** Inline meta after a row ("(Mei, high confidence)"). */
  meta: `color:${C.fg55};`,
  /** Row link: ink, no underline. */
  link: `color:${C.fg};text-decoration:none;`,
  table: `role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`,
};

/** Chip palette names → (text, fill, line) tokens. `muted` is an outline-only chip. */
export type ChipTone = "green" | "blue" | "amber" | "accent" | "muted";
const CHIP_TONES: Record<ChipTone, { fg: string; bg: string; bd: string }> = {
  green: { fg: C.green, bg: C.greenSoft, bd: C.greenLine },
  blue: { fg: C.blue, bg: C.blueSoft, bd: C.blueLine },
  amber: { fg: C.amber, bg: C.amberSoft, bd: C.amberLine },
  accent: { fg: C.accentText, bg: C.accentSoft, bd: C.accentLine },
  muted: { fg: C.fg55, bg: C.bg, bd: C.border },
};

/**
 * Email versions of the app's My Work card pieces (web/src/render.ts: mwTitleRow /
 * mwRow / chips / mwFooter) in the LEDGER layout: one continuous list, not boxes.
 * Each item is a table row: title left with the #number pill (the item's only
 * link, in the app's accent pill style) far right on the same line, the
 * labelled rows and chip footer flush beneath, a hairline between items. Nested tables + inline styles only; every colour is a
 * THEME token so the dark swap applies. Callers escape their own text. The
 * `data-item*` / `data-row*` / `data-chip` / `data-pill` attributes are inert
 * hooks for the admin preview; mail clients ignore them.
 */
export const EMAIL_CARD = {
  /** Small label chip, e.g. MERGED / P1 / ADDED — callers pass the case they want (status chips uppercase, labels as-is). */
  chip(text: string, tone: ChipTone): string {
    const t = CHIP_TONES[tone];
    return `<span data-chip style="display:inline-block;${LABEL}font-size:9.5px;font-weight:600;letter-spacing:.04em;color:${t.fg};background-color:${t.bg};border:1px solid ${t.bd};border-radius:5px;padding:2px 6px;white-space:nowrap;vertical-align:middle;">${text}</span>`;
  },
  /** One labelled row: 96px label + body; `tone` colours the label (Next step is accent). */
  row(label: string, body: string, tone: "muted" | "accent" = "muted"): string {
    return `<tr data-row><td data-row-label width="96" style="${EMAIL_STYLE.label}line-height:20px;color:${tone === "accent" ? C.accentText : C.fg40};vertical-align:top;padding:${SP.xs}px 10px ${SP.xs}px 0;">${label}</td><td data-row-body style="${SANS}font-size:13px;line-height:20px;color:${C.fg70};padding:${SP.xs}px 0;">${body}</td></tr>`;
  },
  rows(rows: string[]): string {
    return rows.length ? `<table data-item-rows ${EMAIL_STYLE.table} style="margin-top:${SP.s}px;">${rows.join("")}</table>` : "";
  },
  /** Footer: chips + a muted note. */
  footer(inner: string): string {
    return `<div data-item-footer style="margin-top:${SP.m - SP.xs}px;${SANS}font-size:12px;line-height:20px;color:${C.fg40};">${inner}</div>`;
  },
  /** Escaped prose with backtick spans styled as code (escape FIRST — bodies never inject HTML). */
  prose(escaped: string): string {
    return escaped.replace(/`([^`]+)`/g, `<code style="${CODE}font-size:12px;background-color:${C.hover};border-radius:4px;padding:1px 4px;">$1</code>`);
  },
  /** One ledger item: title left, the #number pill (the item's only link) far right on the same line; rows and chips flush beneath. `first` drops the hairline above (the group label sits there instead). */
  item(o: { title: string; number: number | null; url: string | null; rows: string[]; footer?: string; first?: boolean }): string {
    const pill = o.number !== null && o.url
      ? `<td data-pill-cell align="right" width="1" style="vertical-align:top;padding-left:12px;white-space:nowrap;"><a data-pill href="${o.url}" style="display:inline-block;${LABEL}font-size:11.5px;font-weight:600;line-height:16px;color:${C.accentText};background-color:${C.accentSoft};border-radius:6px;padding:2px 7px;text-decoration:none;white-space:nowrap;">#${o.number}</a></td>`
      : "";
    return (
      `<table data-item ${EMAIL_STYLE.table} style="${o.first ? "" : `border-top:1px solid ${C.border};`}"><tr>` +
      `<td data-item-inner style="vertical-align:top;padding:${SP.m}px 0;">` +
      `<table data-item-title ${EMAIL_STYLE.table}><tr><td data-title style="${SANS}font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${C.fg};vertical-align:top;">${o.title}</td>${pill}</tr></table>` +
      EMAIL_CARD.rows(o.rows) +
      (o.footer ? EMAIL_CARD.footer(o.footer) : "") +
      `</td></tr></table>`
    );
  },
};

/** The dark swap: one rule per token, matched on the inline style substring. */
function darkCss(): string {
  const rules: string[] = [`body{background-color:${THEME.ground.dark}!important;}`];
  for (const t of Object.values(THEME)) {
    rules.push(`[style*="background-color:${t.light}"]{background-color:${t.dark}!important;}`);
    // Anchored on the declaration start: a bare `[style*="color:X"]` would also match `background-color:X`.
    rules.push(`[style^="color:${t.light}"],[style*=";color:${t.light}"]{color:${t.dark}!important;}`);
    rules.push(`[style*="solid ${t.light}"]{border-color:${t.dark}!important;}`);
  }
  return `@media (prefers-color-scheme: dark){${rules.join("")}}`;
}

function dayLabel(d: Date, timeZone: string): { month: string; day: number } {
  const l = localDate(d, timeZone);
  return { month: MONTHS[l.month - 1], day: l.day };
}

/** `Trov daily, Sep 11` / `Trov weekly, Sep 7 to 11` (start to the last weekday before the send). */
export function subjectFor(window: Window, timeZone: string): string {
  return `Trov ${window.cadence}, ${dateRange(window, timeZone)}`;
}

function dateRange(window: Window, timeZone: string): string {
  if (window.cadence === "daily") {
    const d = dayLabel(window.end, timeZone);
    return `${d.month} ${d.day}`;
  }
  const from = dayLabel(window.start, timeZone);
  let last = new Date(window.end.getTime() - DAY);
  while ([0, 6].includes(localDate(last, timeZone).weekday)) last = new Date(last.getTime() - DAY);
  const to = dayLabel(last, timeZone);
  return from.month === to.month ? `${from.month} ${from.day} to ${to.day}` : `${from.month} ${from.day} to ${to.month} ${to.day}`;
}

/**
 * The Trov banner, shared by every email: the Trov mark (shared/mark.ts) built
 * as a 3 x 3 grid of table cells because Gmail strips SVG, the wordmark beside it, and what the mail
 * says under it (`emailBanner`) — all reversed out of a full-bleed accent band, rounded into the top of
 * the card. The band colour is tokenised so the dark
 * swap flips it; the ink on top of it is not (see BAND).
 */
/**
 * On-band ink. Deliberately literal, never THEME tokens: `darkCss()` rewrites
 * any inline colour matching a token, which would flip these to dark ink and
 * sink them into the purple in a dark client. The band itself IS tokenised, so
 * it still swaps accent light -> dark.
 */
const BAND = { ink: "#ffffff", subline: "#e6e8f9", dot: "#bcc1ef" } as const;

/** The mark, `side` px square: one table, a filled cell per block of the mark. `ink` is the fill — the
 *  band's white for the brand, a faint white for the large mark behind the banner's text. */
function emailMark(side: number, ink: string = BAND.ink, cell = "on"): string {
  const px = TROV_MARK_GRID.tracks.map((t) => Math.round(t * side));
  px[2] = side - px[0]! - px[1]!;
  const rows = TROV_MARK_GRID.filled.map((row, r) =>
    `<tr>` + row.map((on, c) =>
      `<td${on ? ` data-cell="${cell}"` : ""} width="${px[c]}" height="${px[r]}" style="width:${px[c]}px;height:${px[r]}px;padding:0;font-size:0;line-height:0;${on ? `background-color:${ink};` : ""}"></td>`).join("") + `</tr>`).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${side}" style="border-collapse:collapse;">${rows}</table>`;
}

/** What the banner says under the brand. Every part is optional; all are already-escaped HTML. */
export interface EmailBannerText {
  /** A small uppercase label, top right: what kind of mail this is ("Invitation"). */
  eyebrow?: string;
  /** The mail's headline, reversed out of the band (the app's first-run cards do the same). */
  title?: string;
  /** One quiet line under it (a digest's "Daily digest · Oct 7"). */
  lede?: string;
}

/**
 * The banner, in the shape of the app's first-run cards (`.cnpy-orgs-banner`, web/src/trov.css): the
 * brand top left, a label top right, the headline and a quiet line under it — reversed out of the
 * brand's purple, with a large faint mark behind the right edge. Mail clients decide how much of that
 * survives, so each layer degrades on its own: the gradient is a `background-image` over the solid
 * `background-color` (Outlook keeps the solid), and the faint mark is table cells filled with an
 * `rgba()` (a client without it paints nothing there). A bare string is the quiet line alone.
 */
export function emailBanner(text?: string | EmailBannerText): string {
  const t: EmailBannerText = typeof text === "string" ? { lede: text } : text ?? {};
  const eyebrow = t.eyebrow ? `<td align="right" style="vertical-align:middle;${SANS}font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${BAND.subline};white-space:nowrap;">${t.eyebrow}</td>` : "";
  return (
    `<tr><td data-banner style="padding:22px 28px 24px 28px;background-color:${C.accent};background-image:linear-gradient(135deg,#6c75d8 0%,#5a64cc 48%,#454fb2 100%);border-radius:13px 13px 0 0;text-align:left;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="vertical-align:top;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td data-mark="trov" width="18" style="vertical-align:middle;padding-right:9px;">` + emailMark(18) + `</td>` +
      `<td style="vertical-align:middle;${SANS}font-size:16px;font-weight:600;letter-spacing:-0.01em;line-height:1;color:${BAND.ink};">Trov</td>` +
      eyebrow +
      `</tr></table>` +
      (t.title ? `<div data-banner-title style="${SANS}font-size:25px;line-height:31px;font-weight:600;letter-spacing:-0.02em;color:${BAND.ink};padding-top:20px;">${t.title}</div>` : "") +
      (t.lede ? `<div style="${SANS}font-size:13px;line-height:20px;color:${BAND.subline};padding-top:${t.title ? 6 : SP.s}px;">${t.lede}</div>` : "") +
    `</td>` +
    `<td data-banner-art width="92" align="right" style="vertical-align:top;padding-left:16px;">` + emailMark(76, "rgba(255,255,255,.15)", "art") + `</td>` +
    `</tr></table>` +
    `</td></tr>`
  );
}

function header(cadence: Window["cadence"], range: string): string {
  const label = cadence === "daily" ? "Daily digest" : "Weekly digest";
  return emailBanner(`${label} <span style="color:${BAND.dot};">&middot;</span> ${escapeHtml(range)}`);
}

export function assembleMessage(opts: {
  sections: Section[];
  window: Window;
  timeZone: string;
  origin: string;
  /** `<origin>/<slug>` of the digest's org (src/tools/org-links.ts) — what deep links hang off. Absent → the origin. */
  appBase?: string;
  login: string;
  unsubscribeUrl: string;
}): AssembledMessage {
  const { sections, window, timeZone, origin, login, unsubscribeUrl } = opts;
  const subject = subjectFor(window, timeZone);
  const range = dateRange(window, timeZone);
  // A section's deep link opens the org the digest is ABOUT (`<origin>/<slug>/#tickets`), not whichever org the browser last had.
  const link = (s: Section) => `${opts.appBase ?? origin}${s.deepLink}`;
  const label = (s: Section) => s.linkLabel ?? s.heading;
  const host = origin.replace(/^https?:\/\//, "") || "trov";
  const preheader = sections.map((s) => s.summary).filter(Boolean).join(", ");

  const heading = `${SANS}font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${C.fg};`;
  const summary = `${SANS}font-size:13px;line-height:20px;color:${C.fg55};padding-top:${SP.xs}px;`;
  const button = `display:inline-block;${SANS}font-size:13px;line-height:20px;font-weight:500;color:${C.accentText};text-decoration:none;padding:6px 12px;border:1px solid ${C.borderStrong};border-radius:8px;`;
  const blocks = sections.map(
    (s, i) =>
      `<tr><td style="padding:${SP.xl}px 28px ${SP.xl}px 28px;${i === 0 ? "" : `border-top:1px solid ${C.border};`}">` +
      `<div style="${heading}">${escapeHtml(s.heading)}</div>` +
      (s.summary ? `<div style="${summary}">${escapeHtml(s.summary)}</div>` : "") +
      s.html +
      `<div style="padding-top:${SP.l}px;"><a href="${escapeHtml(link(s))}" style="${button}">Open ${escapeHtml(label(s))} &rarr;</a></div>` +
      `</td></tr>`
  );

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${escapeHtml(subject)}</title>` +
    `<link href="${FONTS_HREF}" rel="stylesheet">` +
    `<style>:root{color-scheme:light dark;}${darkCss()}</style></head>` +
    `<body style="margin:0;padding:0;background-color:${C.ground};">` +
    (preheader ? `<div style="display:none;max-height:0px;overflow:hidden;">${escapeHtml(preheader)}.</div>` : "") +
    `<table ${EMAIL_STYLE.table} style="background-color:${C.ground};"><tr><td align="center" style="padding:36px 16px;">` +
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${EMAIL_WIDTH}px;max-width:100%;background-color:${C.bg};border:1px solid ${C.border};border-radius:13px;">` +
    header(window.cadence, range) +
    blocks.join("") +
    `<tr><td style="padding:${SP.l}px 28px ${SP.l}px 28px;border-top:1px solid ${C.border};${SANS}font-size:12px;line-height:20px;color:${C.fg40};">` +
    `You're getting the ${window.cadence} Trov digest for ${escapeHtml(login)}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${C.fg40};text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a><br>` +
    `Sent by Trov &middot; ${escapeHtml(host)}</td></tr>` +
    `</table></td></tr></table></body></html>`;

  const title = `TROV ${window.cadence.toUpperCase()} — ${range.toUpperCase()}`;
  const text = [
    title,
    "=".repeat(title.length),
    "",
    ...sections.flatMap((s) => [
      s.heading.toUpperCase(),
      ...(s.summary ? [s.summary] : []),
      "",
      s.text,
      "",
      `  -> ${label(s)}: ${link(s)}`,
      "",
    ]),
    "-".repeat(title.length),
    `You're getting the ${window.cadence} Trov digest for ${login}.`,
    `Unsubscribe: ${unsubscribeUrl}`,
    `Sent by Trov — ${host}`,
    "",
  ].join("\n");

  return { subject, html, text };
}
