// Person presentation: the avatar chip (initials on the person's color, provider
// image on top), the color swatch picker, and the onboarding screen. Pure
// functions over state — no fetch, no DOM — so they are unit-testable.
import { PERSON_COLORS, type PersonColor } from "@shared/rows";
import { esc, attr, initialsOf, surface } from "./ui";
import type { OnboardPrefill } from "./api";

export const COLOR_NAMES: readonly PersonColor[] = PERSON_COLORS;

export interface OnboardState {
  prefill: OnboardPrefill | null;
  handle: string; name: string; color: PersonColor;
  check: "idle" | "checking" | "available" | "invalid" | "reserved" | "taken";
  submitting: boolean; error: string | null;
}
export function initialOnboard(): OnboardState {
  return { prefill: null, handle: "", name: "", color: "moss", check: "idle", submitting: false, error: null };
}

/** Initials from a display name ("Priya Natarajan" → "PN"), falling back to the login rule. */
export function initialsOfName(name: string | null | undefined, fallback: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  return initialsOf(fallback);
}

/** `@handle` in the person's color (Geist, 500 — a name, not a label chip). Unmapped → muted, no color. */
export function handleTag(p: { handle: string; color: PersonColor } | null, fallback: string, size = 12): string {
  if (!p) return `<span style="font-family:var(--sans);font-size:${size}px;color:var(--fg-55)">@${esc(fallback)}</span>`;
  return `<span style="font-family:var(--sans);font-size:${size}px;font-weight:500;color:var(--p-${p.color})">@${esc(p.handle)}</span>`;
}

/** Avatar URLs that failed to load this session (a revoked provider picture, a deleted
 *  upload). main.ts's ONE capture-phase `error` listener records them through
 *  `markAvatarFailed`; a chip for a failed URL is initials only, so a rerender never
 *  puts the broken image back. */
const failedAvatars = new Set<string>();
export function markAvatarFailed(url: string): void { failedAvatars.add(url); }
/** The `<img>` class that listener watches. */
export const AVATAR_IMG_CLASS = "cnpy-av-img";

/** A person's avatar: initials on their color, with the photo (when there is one) laid OVER
 *  them — so a photo that is slow, or fails, shows the initials rather than a broken image. */
export function personChip(p: { handle: string; name?: string | null; color: PersonColor; avatar_url?: string | null } | null, size: number, fallback: string): string {
  const font = Math.max(9, Math.round(size * 0.36));
  if (!p) {
    return `<div class="cnpy-av cnpy-av-anon" style="width:${size}px;height:${size}px;border-radius:50%;border:1px solid var(--border-strong);background:color-mix(in srgb,var(--fg) 7%,transparent);display:grid;place-items:center;font-size:${font}px;font-weight:600;color:var(--fg);flex:none">${esc(initialsOf(fallback))}</div>`;
  }
  const url = p.avatar_url && !failedAvatars.has(p.avatar_url) ? p.avatar_url : null;
  const img = url
    ? `<img class="${AVATAR_IMG_CLASS}" src="${attr(url)}" width="${size}" height="${size}" alt="" decoding="async" style="position:absolute;inset:0;display:block;width:100%;height:100%;border-radius:50%;object-fit:cover" />`
    : "";
  return `<div class="cnpy-av" title="${attr(p.name ?? p.handle)}" style="--c:var(--p-${p.color});position:relative;width:${size}px;height:${size}px;border-radius:50%;background:var(--c);box-shadow:0 0 0 1.5px color-mix(in srgb,var(--c) 45%,transparent);display:grid;place-items:center;font-size:${font}px;font-weight:600;color:#fff;flex:none;overflow:hidden">${esc(initialsOfName(p.name, p.handle))}${img}</div>`;
}

/** A person's photo and name as ONE chip: the whole thing is the button that opens their
 *  person card (`openPerson`), and it lights up as one on hover. `person` null (an unknown
 *  handle, or the GitHub mirror's system handle) renders the same two pieces as plain,
 *  unclickable content, so the layout never shifts. `textStyle` is the name's own. */
export function personLink(person: { handle: string; name?: string | null; color: PersonColor; avatar_url?: string | null } | null, fallback: string, size: number, label: string, textStyle: string): string {
  const inner = `${personChip(person, size, fallback)}<span style="${textStyle}">${esc(label)}</span>`;
  const box = "display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%";
  return person
    ? `<button data-act="openPerson" data-arg="${attr(person.handle)}" class="cnpy-personchip" title="${attr(person.name || person.handle)}" style="${box};text-align:left;padding:2px 8px 2px 2px;margin:-2px -8px -2px -2px;border-radius:7px">${inner}</button>`
    : `<span style="${box}">${inner}</span>`;
}

/** A person's photo on its own, clickable like their name (the Feed's and a comment's
 *  avatar column). Plain when the person is unknown. */
export function personAvatarLink(person: { handle: string; name?: string | null; color: PersonColor; avatar_url?: string | null } | null, fallback: string, size: number): string {
  return person
    ? `<button data-act="openPerson" data-arg="${attr(person.handle)}" class="cnpy-personav" title="${attr(person.name || person.handle)}" aria-label="${attr(`${person.name || person.handle} — person card`)}" style="display:flex;padding:0;border-radius:50%">${personChip(person, size, fallback)}</button>`
    : personChip(person, size, fallback);
}

export function swatches(act: string, selected: PersonColor, compact = false): string {
  return `<div role="radiogroup" style="display:grid;grid-template-columns:repeat(${compact ? 10 : 5},1fr);gap:${compact ? 4 : 10}px">${COLOR_NAMES.map((c) =>
    `<button type="button" role="radio" aria-checked="${c === selected}" data-act="${attr(act)}" data-arg="${c}" class="cnpy-sw${c === selected ? " is-on" : ""}${compact ? " compact" : ""}" style="--c:var(--p-${c})"><i></i><span>${c}</span></button>`).join("")}</div>`;
}

export function feedPreviewRow(p: { name: string; handle: string; color: PersonColor }): string {
  return `<div style="display:flex;align-items:flex-start;gap:11px">
    ${personChip({ handle: p.handle, name: p.name, color: p.color }, 30, p.handle || "?")}
    <div><div style="font-size:12.5px;color:var(--fg-55)"><b style="color:var(--fg);font-weight:600">${esc(p.name || "Your name")}</b> · ${handleTag({ handle: p.handle || "…", color: p.color }, p.handle || "…")} · 2 min ago</div>
    <div style="font-size:13.5px;margin-top:3px;color:var(--fg-70)">Drafted the fall enrollment email sequence; needs a review before Monday.</div></div>
  </div>`;
}

const STATUS: Record<OnboardState["check"], { text: string; color: string }> = {
  idle: { text: "", color: "var(--fg-40)" }, checking: { text: "checking…", color: "var(--fg-40)" },
  available: { text: "available", color: "var(--green)" }, invalid: { text: "invalid", color: "var(--red)" },
  reserved: { text: "reserved", color: "var(--red)" }, taken: { text: "taken", color: "var(--red)" },
};

export function onboardView(o: OnboardState): string {
  const st = STATUS[o.check];
  const canSubmit = o.check === "available" && !o.submitting;
  const signedAs = o.prefill ? `Signed in with ${o.prefill.provider === "google" ? "Google" : "GitHub"} as <span style="font-family:var(--label);color:var(--fg-55)">${esc(o.prefill.label)}</span>` : "";
  const field = (label: string, inner: string, help = "") => `<div><label style="display:block;font-size:12.5px;font-weight:500;color:var(--fg-70);margin-bottom:7px">${label}</label>${inner}${help ? `<div style="font-size:12px;color:var(--fg-40);margin-top:7px;line-height:1.5">${help}</div>` : ""}</div>`;
  const row = "display:flex;align-items:center;border:1px solid var(--border-strong);border-radius:9px;background:var(--bg);overflow:hidden";
  const input = "flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--fg);font-size:14px;padding:11px 12px";
  return `<div class="cnpy-authwrap" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px"><div style="width:100%;max-width:520px">
    <div style="margin-bottom:26px">
      <div style="font-family:var(--label);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg-40);margin-bottom:10px">Welcome to Canopy · one step</div>
      <h1 style="font-size:22px;font-weight:600;letter-spacing:-0.02em;margin:0 0 6px">Choose how you'll appear.</h1>
      <p style="font-size:14px;color:var(--fg-70);margin:0;line-height:1.55">Your handle is how work gets attributed to you, in the feed, in decisions, in My Work. You can change it later in Settings. Your color can too.</p>
    </div>
    <div style="display:grid;gap:22px">
      ${field("Handle", `<div style="${row}"><span style="font-family:var(--sans);font-size:14px;color:var(--fg-40);padding-left:12px">@</span><input data-act="onbHandle" data-field="onbHandle" value="${attr(o.handle)}" autocomplete="off" spellcheck="false" maxlength="24" class="cnpy-input" style="${input};padding-left:4px;font-family:var(--label)" /><span style="font-family:var(--label);font-size:11px;padding:0 12px;white-space:nowrap;color:${st.color}">${esc(st.text)}</span></div>`,
        "2 to 24 characters. Lowercase letters, numbers and hyphens. Starts with a letter.")}
      ${field("Display name", `<div style="${row}"><input data-act="onbName" data-field="onbName" value="${attr(o.name)}" maxlength="120" class="cnpy-input" style="${input}" /></div>`)}
      ${field("Your color", swatches("onbColor", o.color))}
      <div${surface("padding:12px 14px")}>
        <div style="font-family:var(--label);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-40);margin-bottom:10px">How you'll appear in the feed</div>
        ${feedPreviewRow({ name: o.name, handle: o.handle, color: o.color })}
      </div>
      ${o.error ? `<div style="font-size:12.5px;color:var(--red)">${esc(o.error)}</div>` : ""}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--fg-40)">${signedAs}</div>
        <button data-act="onbSubmit" class="cnpy-accentbtn" ${canSubmit ? "" : "disabled "}style="padding:11px 20px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600;${canSubmit ? "" : "opacity:.45;cursor:default"}">${o.submitting ? "Entering…" : "Enter Canopy"}</button>
      </div>
    </div>
  </div></div>`;
}
