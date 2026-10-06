// The three pages the OAuth flow renders from the Worker (not the SPA, so the flow
// never depends on the web bundle loading). Pure string templates; every dynamic
// value is escaped. They wear the landing's sign-in dialog (web/src/landing.ts
// `signInDialog`): the Trov mark and wordmark, Geist, the same card, tokens and
// buttons — copied here because the Worker cannot import from web/. Radii are the
// app's authored values at its `--corner-scale` (.4), since trov.css isn't loaded.

import { trovMark } from "@shared/mark";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`
  + `<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;650&family=Archivo+Narrow:wght@400;500;600&display=swap" rel="stylesheet">`;

const CSS = `
:root{--bg:#faf8f3;--card:#fffdf8;--fg:#1a1814;--fg-70:rgba(26,24,20,.72);--fg-55:rgba(26,24,20,.55);--fg-40:rgba(26,24,20,.40);--border:rgba(42,39,31,.10);--border-strong:rgba(42,39,31,.18);--hover:rgba(42,39,31,.05);--accent:#8a9a5b;--mark:#616ACB;--accent-fg:#fff;--accent-soft:rgba(138,154,91,.12);--red:#a83a3a;--red-soft:rgba(168,58,58,.08);--shadow:0 32px 64px -24px rgba(42,39,31,.18),0 4px 12px -4px rgba(42,39,31,.08);--label:'Archivo Narrow',system-ui,sans-serif;--code:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#1c1a16;--card:#211f1a;--fg:#ede9e2;--fg-70:rgba(237,233,226,.72);--fg-55:rgba(237,233,226,.55);--fg-40:rgba(237,233,226,.40);--border:rgba(237,233,226,.11);--border-strong:rgba(237,233,226,.20);--hover:rgba(237,233,226,.06);--accent:#9aab65;--mark:#8991D7;--accent-fg:#131a07;--accent-soft:rgba(154,171,101,.14);--red:#cc6262;--red-soft:rgba(204,98,98,.10);--shadow:0 32px 64px -24px rgba(0,0,0,.55),0 4px 12px -4px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font-family:'Geist',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.card{width:min(400px,100%);border:1px solid var(--border-strong);border-radius:5.6px;padding:32px 30px 26px;background:var(--card);box-shadow:var(--shadow)}
.head{display:flex;align-items:center;justify-content:center;gap:10px}
.title{font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.25}
.lede{margin:12px 0 0;font-size:14px;color:var(--fg-70);text-align:center;line-height:1.55}
.lede strong{color:var(--fg);font-weight:600}
.lede.sm{margin-top:8px;font-size:12.5px;color:var(--fg-55)}
.lede.sm strong{font-weight:500;color:var(--fg-70)}
.stack{margin-top:24px;display:flex;flex-direction:column;gap:18px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:3.6px;font:inherit;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid var(--border-strong);background:transparent;color:var(--fg);transition:background .12s,filter .12s}
.btn:hover{background:var(--hover)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover{filter:brightness(1.06)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.or{display:flex;align-items:center;gap:12px;font-family:var(--label);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--fg-40)}
.or span{flex:1;height:1px;background:var(--border)}
.foot{text-align:center;margin-top:20px;font-size:12.5px;color:var(--fg-40);line-height:1.5}
.app{margin-top:22px;display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:4px;background:var(--hover)}
.app-ic{flex:none;width:36px;height:36px;border-radius:3.6px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.app-name{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.app-sub{margin-top:2px;font-size:12px;color:var(--fg-55)}
.host{font-family:var(--label);font-size:12px;color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:2.4px;padding:1px 6px;overflow-wrap:anywhere}
.label{margin:20px 0 10px;font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)}
.perms{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
.perms li{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:var(--fg-70);line-height:1.5}
.perms svg{flex:none;margin-top:3px;color:var(--accent)}
.row{display:flex;gap:10px;margin-top:24px}
.row .btn{flex:1}
.err{margin-top:20px;padding:12px 14px;border-radius:4px;background:var(--red-soft);border:1px solid var(--border);color:var(--red);font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}`;

/** The Trov mark (shared/mark.ts), in the page's own `--mark`. */
const MARK = trovMark(26);
const GITHUB = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`;
const GOOGLE = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.2v3.1C3.2 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.3c-.5-1.5-.5-3.1 0-4.6V6.6H1.2c-1.6 3.3-1.6 7.3 0 10.6l4.1-2.9z"/><path fill="#EA4335" d="M12 4.7c1.7 0 3.3.6 4.5 1.7l3.4-3.4C17.9 1.1 15.1 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4.1 3.1c.9-2.9 3.6-5 6.7-5z"/></svg>`;
const APP = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3M13 15h4"></path></svg>`;
const CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)} · Trov</title>${FONTS}<style>${CSS}</style></head><body><main class="card">${body}</main></body></html>`;
}

const head = (title: string) => `<div class="head">${MARK}<span class="title">${esc(title)}</span></div>`;

export function errorPage(message: string): string {
  return shell("Can't connect", head("Can't connect this app")
    + `<div class="err" role="alert">${esc(message)}</div>`
    + `<div class="foot">You can close this tab.</div>`);
}

export function signInPage(clientName: string): string {
  return shell("Sign in", head("Sign in to Trov")
    + `<p class="lede">to connect <strong>${esc(clientName)}</strong></p>`
    + `<div class="stack">`
    + `<a class="btn primary" href="/auth/login">${GITHUB}Sign in with GitHub</a>`
    + `<div class="or"><span></span>or<span></span></div>`
    + `<a class="btn" href="/auth/google/login">${GOOGLE}Continue with Google</a>`
    + `</div>`
    + `<div class="foot">After you sign in, Trov asks you to confirm before anything is connected.</div>`);
}

export function consentPage(p: { clientName: string; redirectHost: string; handle: string; hidden: Record<string, string>; csrf: string }): string {
  const inputs = Object.entries({ ...p.hidden, csrf: p.csrf })
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return shell("Connect an app", head("Connect an app")
    + `<p class="lede sm">It will act as <strong>@${esc(p.handle)}</strong></p>`
    + `<div class="app"><div class="app-ic">${APP}</div><div style="min-width:0">`
    + `<div class="app-name">${esc(p.clientName)}</div>`
    + `<div class="app-sub">Returns you to <span class="host">${esc(p.redirectHost)}</span></div>`
    + `</div></div>`
    + `<div class="label">It can</div>`
    + `<ul class="perms">`
    + `<li>${CHECK}<span>Read what you can read in Trov: docs, decisions, the roadmap, tickets and your work</span></li>`
    + `<li>${CHECK}<span>Write as you through MCP: file and update tickets, stage docs and decisions</span></li>`
    + `<li>${CHECK}<span>If you're an admin, edit the plan and sprints</span></li>`
    + `</ul>`
    + `<form method="post" action="/oauth/authorize">${inputs}<div class="row">`
    + `<button class="btn" type="submit" name="decision" value="deny">Deny</button>`
    + `<button class="btn primary" type="submit" name="decision" value="allow">Allow</button></div></form>`
    + `<div class="foot">The app's name is supplied by the app. You can disconnect it any time in Settings › MCP access.</div>`);
}
