/**
 * Email shell follows the site theme (light tokens from web/src/trov.css,
 * flattened to hex, with a prefers-color-scheme dark swap). The Helvetica /
 * #00A859 / #f2f2f2 look from the original email mockup is gone.
 */
import { describe, it, expect } from "vitest";
import { assembleMessage, EMAIL_STYLE, EMAIL_SPACE, EMAIL_WIDTH, THEME, emailBanner } from "../src/notifications/assemble";
import { renderInviteEmail } from "../src/notifications/invite";
import { sampleSections } from "../src/notifications/sample";

const window = { cadence: "daily" as const, id: "2026-09-13", start: new Date("2026-09-12T12:00:00Z"), end: new Date("2026-09-13T12:00:00Z") };
const msg = () =>
  assembleMessage({ sections: sampleSections(), window, timeZone: "America/New_York", origin: "https://trov.example", login: "andres", unsubscribeUrl: "https://trov.example/u/x.y" });

describe("email shell — site theming", () => {
  it("paints the light palette: cream ground, cream card, olive accent, warm ink", () => {
    const { html } = msg();
    expect(html).toContain("#f3f0e9"); // page ground
    expect(html).toContain("#faf8f3"); // card = site --bg (light)
    expect(html).toContain("#8a9a5b"); // site --accent (light)
    expect(html).toContain("#1a1814"); // site --fg (light)
  });

  it("drops the mockup's Helvetica / bright-green / grey look entirely", () => {
    const { html } = msg();
    expect(html).not.toContain("#00A859");
    expect(html).not.toContain("#f2f2f2");
    expect(html).not.toContain("font-family:Helvetica"); // the old bare stack; Geist stack may still fall back to it
    expect(html).not.toContain("Courier New");
  });

  it("uses the site type stack: Geist with a system fallback, Archivo Narrow for labels", () => {
    const { html } = msg();
    expect(html).toContain("fonts.googleapis.com/css2?family=Geist");
    expect(EMAIL_STYLE.body).toMatch(/font-family:Geist,/);
    expect(EMAIL_STYLE.label).toMatch(/font-family:'Archivo Narrow',/);
    expect(EMAIL_STYLE.label).toContain("text-transform:uppercase");
  });

  it("declares both color schemes and carries a dark swap the mail client can apply", () => {
    const { html } = msg();
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*#1c1a16[\s\S]*#ede9e2[\s\S]*#9aab65/);
  });

  it("keeps every section, its deep link and the unsubscribe link", () => {
    const { html, text, subject } = msg();
    expect(subject).toBe("Trov daily, Sep 13");
    for (const s of sampleSections()) {
      expect(html).toContain(s.heading);
      expect(html).toContain(`https://trov.example${s.deepLink}`);
    }
    expect(html).toContain("https://trov.example/u/x.y");
    expect(text).toContain("Unsubscribe: https://trov.example/u/x.y");
  });

  it("section renderers no longer carry hardcoded mockup greys", () => {
    const { html } = msg();
    expect(html).not.toContain("#8a8a8a");
    expect(html).not.toContain("#0a0a0a");
  });
});

describe("email header — Trov branding", () => {
  it("renders the three-bar mark as HTML blocks (no SVG) with the wordmark beside it", () => {
    const { html } = msg();
    expect(html).not.toContain("<svg");
    expect(html).toContain('data-mark="trov"');
    expect((html.match(/data-bar="/g) ?? []).length).toBe(3);
    expect(html).toMatch(/data-mark="trov"[\s\S]*?Trov<\/(span|strong|td)>/);
  });

  it("centres the header block: the mark table is align=center inside a text-align:center cell", () => {
    const { html } = msg();
    expect(html).toMatch(/<td[^>]*text-align:center[^>]*>[\s\S]*?<table[^>]*align="center"[^>]*>[\s\S]*?data-mark="trov"/);
  });

  it("names the cadence under the wordmark: 'Daily digest · Sep 13'", () => {
    const { html } = msg();
    expect(html).toContain("Daily digest");
    expect(html).toContain("Sep 13");
  });
});

// WCAG 2.x relative luminance / contrast ratio, so the tokens are checked by number, not by eye.
function lum(hex: string): number {
  const c = hex.replace("#", "").match(/../g)!.map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("email contrast — action link", () => {
  it("the 'Open X →' text reaches 4.5:1 on the card in both palettes (small text, WCAG AA)", () => {
    expect(contrast(THEME.accentText.light, THEME.bg.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(THEME.accentText.dark, THEME.bg.dark)).toBeGreaterThanOrEqual(4.5);
  });

  it("the button uses the accentText token, not the raw accent", () => {
    const { html } = msg();
    expect(html).toMatch(new RegExp(`color:${THEME.accentText.light};text-decoration:none;padding:`)); // the "Open X →" button
  });
});

describe("dark swap selectors", () => {
  it("text-colour rules are anchored so they cannot match background-color / border-color declarations", () => {
    const { html } = msg();
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    expect(css).not.toMatch(/\[style\*="color:#/); // a bare substring match would also hit "background-color:#…"
    expect(css).toMatch(/\[style\*=";color:#1a1814"\]/);
    expect(css).toMatch(/\[style\^="color:#1a1814"\]/);
  });
});

describe("email spacing — 8pt grid with a 4pt sub-grid", () => {
  it("exposes a spacing scale whose every step is a multiple of 4, ascending", () => {
    const steps = Object.values(EMAIL_SPACE);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const v of steps) expect(v % 4).toBe(0);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("sections breathe at the largest step and section headings sit on a 20px line", () => {
    const { html } = msg();
    expect(html).toContain(`padding:${EMAIL_SPACE.xl}px 28px ${EMAIL_SPACE.xl}px 28px;`); // section cell
    expect(html).toMatch(/font-size:15px;line-height:20px;font-weight:600;[^"]*">My Work</);
  });

  it("body rows use a 20px line and a 4pt row gap; group labels get 3× more space above than below", () => {
    expect(EMAIL_STYLE.body).toContain("line-height:20px");
    const { html } = msg();
    expect(html).toContain(`padding-top:${EMAIL_SPACE.l}px;padding-bottom:${EMAIL_SPACE.s}px;">MERGED</div>`);
  });
});

describe("email shell — width", () => {
  const invite = () => renderInviteEmail({ inviteeName: "Priya", inviterName: "Andres", email: "p@example.com", signInUrl: "https://trov.example/x", host: "trov.example" }).html;

  it("gives the card more room than the stock 600px, on both the attribute and the style", () => {
    expect(EMAIL_WIDTH).toBeGreaterThan(600);
    const { html } = msg();
    expect(html).toContain(`width="${EMAIL_WIDTH}"`);
    expect(html).toContain(`width:${EMAIL_WIDTH}px;max-width:100%`);
    expect(html).not.toContain('width="600"');
  });

  it("uses that one width for the invite too, so every Trov email is the same shell", () => {
    expect(invite()).toContain(`width="${EMAIL_WIDTH}"`);
    expect(invite()).toContain(`width:${EMAIL_WIDTH}px;max-width:100%`);
  });

  it("still collapses to the viewport on a phone", () => {
    expect(msg().html).toContain("max-width:100%");
    expect(invite()).toContain("max-width:100%");
  });
});

describe("email banner — the brand band", () => {
  it("paints the banner cell with the accent token, so the dark swap carries it", () => {
    expect(emailBanner()).toMatch(/<td[^>]*background-color:#8a9a5b[^>]*>/);
    expect(msg().html).toMatch(/<td[^>]*background-color:#8a9a5b[^>]*>/);
  });

  it("rounds the band into the top of the card rather than squaring off the shell", () => {
    expect(emailBanner()).toMatch(/border-radius:12px 12px 0 0|border-radius:13px 13px 0 0/);
  });

  it("inverts the wordmark to white — on an accent field the ink tokens would sink into it", () => {
    expect(emailBanner()).toMatch(/color:#ffffff[^"]*">Trov<\/td>/);
  });

  it("drops the accent-coloured bar: it would vanish against an accent band", () => {
    expect(emailBanner()).not.toMatch(/data-bar="[0-9]"[^>]*background-color:#8a9a5b/);
    expect((emailBanner().match(/data-bar="/g) ?? []).length).toBe(3);
  });

  it("uses literal whites on the band, never theme tokens the dark swap would flip into the olive", () => {
    const banner = emailBanner("Daily digest");
    const textColors = [...banner.matchAll(/(?:^|;|")color:(#[0-9a-f]{6})/g)].map((m) => m[1]);
    const tokens = Object.values(THEME).map((t) => t.light);
    expect(textColors.length).toBeGreaterThan(0);
    expect(textColors.filter((c) => tokens.includes(c))).toEqual([]);
  });

  it("still sets the cadence subline, now on the band", () => {
    expect(emailBanner("Daily digest")).toContain("Daily digest");
    expect(msg().html).toContain("Daily digest");
  });
});
