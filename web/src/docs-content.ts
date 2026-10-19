// ── The public docs: setup, connecting a client, concepts ───────────────────
// docs/architecture/web-ui.md › Docs for people and agents. Each docs page of shared/site-pages.ts is ONE
// Markdown text, built here: the build serves it as-is at `/docs/<page>.md` (and in /llms-full.txt) and
// renders the HTML page from it (web/src/docs.ts) — so the two can never say different things.
//
// The shape every page follows, which docs.ts relies on: `# <title>`, a blank line, the lede (one
// paragraph: the page's description in shared/site-pages.ts, word for word), then `## ` sections.
//
// TRUE TO THE CODE. Nothing here may claim what Trov does not do. Where a fact can drift it is not typed:
// prices and limits come from shared/plans.ts + shared/pricing.ts, the commands from web/src/mcp-connect.ts,
// the endpoint from SITE_ORIGIN, the tools from the server's own list (docs-tools.ts), the changelog from
// web/src/releases.ts (docs-changelog.ts). The rest restates what the code and docs/architecture/ say:
// auth-identity-people.md (sign-in, OAuth, tokens), ingestion-gate.md (the gate), tickets.md, the skills
// in plugins/trov/skills/. The other clients' config formats are those clients' own (verified against
// their documentation on 2026-10-12, see web-ui.md); a client Trov's OAuth server cannot serve is said so.
// PURE: no DOM, so the build runs it in Node and a test reads it.

import { DOCS_PAGES, SITE_ORIGIN, siteUrl, type SitePage } from "@shared/site-pages";
import { PLANS, FREE_PLAN, UPGRADE_PLAN, seatsPhrase } from "@shared/plans";
import { PRICING, formatPrice } from "@shared/pricing";
import { ARTIFACT_INLINE_BINARY_MAX } from "@shared/artifacts-core";
import { LINK_DRAFT_TTL_MS, LINK_IDLE_MS, LINK_LIVE_MAX, LINK_NOTE_MAX, LINK_NOTES_PER_SIDE, LINK_OPEN_TTL_MS, LINK_REQUEST_TTL_MS } from "@shared/links";
import { PLUGIN_INSTALL, CONNECTION_NOTE, browserConnectCommand } from "./mcp-connect";
import { TROV_REPO } from "./site-chrome";
import { mcpToolsMarkdown } from "./docs-tools";
import { changelogMarkdown } from "./docs-changelog";

/** The MCP endpoint every client connects to. */
export const MCP_URL = `${SITE_ORIGIN}/mcp`;
/** The environment variable the token examples read (the Guide's troubleshooting names the same one). */
export const TOKEN_ENV = "TROV_MCP_TOKEN";

const FREE = PLANS[FREE_PLAN];
/** "for up to 3 people", "for one person", "for any number of people". */
const forWhom = (seats: number | null): string => { const s = seatsPhrase(seats); return s.startsWith("for ") ? s : `for ${s}`; };
const PRO = PLANS[UPGRADE_PLAN];
const PRO_PRICE = `${formatPrice(PRICING[UPGRADE_PLAN].price ?? 0)} ${PRICING[UPGRADE_PLAN].per}`;

const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\``;
const json = (v: unknown): string => fence("json", JSON.stringify(v, null, 2));
const page = (key: string): SitePage => {
  const p = DOCS_PAGES.find((d) => d.key === key);
  if (!p) throw new Error(`docs-content: no docs page "${key}" in shared/site-pages.ts`);
  return p;
};
/** A link to another docs page, by key: its tab name and ABSOLUTE address, so the Markdown stands on its
 *  own (in /llms-full.txt, or saved by an agent); the HTML render makes a link to the site relative. */
const to = (key: string, text?: string): string => `[${text ?? page(key).nav}](${siteUrl(page(key).path)})`;
const PRICING_URL = siteUrl("/pricing");
const head = (key: string, title: string): string => `# ${title}\n\n${page(key).description}`;
const HOUR_MS = 60 * 60 * 1000;
/** "an hour", "24 hours", "7 days": a link's time limit (shared/links.ts) in words. */
const span = (ms: number): string => ms === HOUR_MS ? "an hour" : ms % (24 * HOUR_MS) === 0 && ms > 24 * HOUR_MS ? `${ms / (24 * HOUR_MS)} days` : `${ms / HOUR_MS} hours`;

// ── Set up Trov ──────────────────────────────────────────────────────────────

function setup(): string {
  return [
    head("docs-setup", "Set up Trov"),
    `Trov is shared memory for a software team and its coding agents: docs in a Library of spaces, decisions, the roadmap, a ticket queue and a feed of what shipped, read and written by people and their agents alike. Agents propose changes; a person confirms what becomes official (${to("docs-concepts", "Concepts")}).`,
    "## 1. Sign in",
    `Go to [trov.dev](${SITE_ORIGIN}/) and choose **Get started**. Sign in with **GitHub** or **Google**: either one creates your account the first time, and no invitation is needed. Google sign-in takes an address Google has verified.`,
    "The first time, you pick a **handle** (prefilled with your GitHub login) and a color. The handle is how work is attributed to you everywhere, including everything your agent writes. Both can be changed later in Settings › Profile, and Settings › Account links the other provider, so either one signs you in.",
    "## 2. Create or join an organization",
    `Everything in Trov belongs to an organization: its docs, decisions, tickets, roadmap, feed and members. Each organization's data is its own: in Trov, only its members and the agents they connect can read its content. Trov's operators see an organization's name, members and usage, not its content; the [Privacy Policy](${siteUrl("/privacy")}) says who else processes it.`,
    [
      "- **Join one.** An admin invites your GitHub login or email address from Org settings › Members. The invitation shows the next time you open Trov.",
      `- **Create one.** Anyone signed in can create a ${FREE.name} organization (one they own at a time). ${FREE.name} is ${forWhom(FREE.entitlements.seats)}; ${PRO.name} is bought per seat, at ${PRO_PRICE}. Every plan is all of Trov: plans differ only in their limits ([pricing](${PRICING_URL})).`,
    ].join("\n"),
    "A new organization opens on its **guided setup**, one step at a time and every step skippable: an owner or admin connects a repository, connects their coding agent and invites the team; a member connects their coding agent. Help › Guide links back to it.",
    "## 3. Connect GitHub",
    "In the guided setup, or later in **Org settings › Repositories**, choose **Connect with GitHub**. That installs the Trov GitHub App on the GitHub account that owns your repository (or links an installation that is already there), and you pick the repository from the ones you can read. There is no token to paste and no webhook to add. Connecting is approved on GitHub, so an owner or admin who signed up with Google links a GitHub account first.",
    "With a repository connected:",
    [
      "- the repository's GitHub issues show up as tickets, each linked back to its issue; closing or reopening the issue closes or reopens its ticket, and everything else about it is edited in Trov;",
      "- pull requests, checks, deploys and pushes are captured as they happen, for My Work and the Repo dashboard (deploys, CI, drift and usage);",
      "- an agent connection that follows the repository knows which organization to act in from the repository it is working in;",
      "- Ask Trov can read the repository on GitHub (files, pull requests, issues, commits and checks) when a question needs it, once an admin turns on its GitHub lookups in Org settings › AI. They are off until then, and each person's questions reach only what their own GitHub account can read.",
    ].join("\n"),
    `How many repositories an organization can connect is a plan limit (${FREE.name}: ${FREE.entitlements.repositories}, ${PRO.name}: ${PRO.entitlements.repositories}).`,
    "To see deploys and usage from where your app runs, an admin opens **Org settings › Hosting**, says which host runs each part of each environment (Cloudflare, Railway, Vercel, Netlify, Render or Fly.io) and connects each host once. Repo › Usage then shows every part's recent deploys, then traffic for a web part or CPU and memory for a service, wherever the host reports them.",
    "## 4. Connect your coding agent",
    "Your agent reaches Trov over the Model Context Protocol (MCP). You connect it by signing in to Trov in your browser, once; from then on it acts as you: it sees what you see, and what it writes is recorded as yours.",
    "For **Claude Code**, install the Trov plugin. It wires up the MCP server and adds the skills that run the loop below:",
    fence("text", PLUGIN_INSTALL),
    "Then run `/mcp`, choose **trov**, then **Authenticate**. Your browser opens Trov: choose how the connection picks an organization, then click **Allow**. The connection is listed in Settings › MCP access under Connected apps, where **Revoke** disconnects it at once.",
    CONNECTION_NOTE,
    `Any other MCP client (Claude Desktop and claude.ai, ChatGPT, Cursor, VS Code, Codex, Windsurf) connects to the same address, \`${MCP_URL}\`: setup to copy for each is in ${to("docs-connect", "Connect an MCP client")}.`,
    `In a chat (claude.ai on the web, Claude Desktop, ChatGPT) Trov is a custom connector or app. There is no plugin and no repository there, so the Allow page suggests **manual**: you tick the organizations it may use and where it starts. ${to("docs-connect", "Connect an MCP client")} › ${CHAT_SECTION} says what a chat can and cannot do.`,
    "## 5. Your first session",
    [
      "1. **Start as you always do.** Before your agent touches an area the team already knows, it reads what Trov has on it (the `load-context` skill does this by itself, and lists any handoffs waiting for you).",
      "2. **Work.** Ask “what’s on my plate?” for your tickets. Your agent can update the tickets assigned to you.",
      "3. **Say “record this session” when you’re done.** It stages what shipped: feed entries, doc changes and decisions. They wait in **Triage › Review** until a person promotes them.",
    ].join("\n"),
    `In a chat there are no skills, so ask in words: “what’s on my plate in Trov?”, “what does Trov say about billing?”, “any handoffs waiting for me?”. The agent reads and stages exactly as above; it cannot read \`git\`, so to record shipped work give it the pull request or commit.`,
    `Not using Claude Code's plugin? Put the snippet from ${to("docs-connect", "Connect an MCP client")} › Tell your agent how to use Trov in your project's \`AGENTS.md\` or \`CLAUDE.md\`, so any agent follows the same loop.`,
    "## After your first session",
    [
      "- **Bring your docs into the Library.** The Library holds the organization's docs in spaces (every organization starts with Engineering, Product and Design), each a tree of pages up to five levels deep. Drop Markdown files or a .zip of them on a space: Trov shows what will be added before anything is sent, then every page waits in **Triage › Review**, where you approve or reject the whole import. A page links to another with `[[its-slug]]`, and each page lists the pages that link to it.",
      "- **Ask Trov.** Press **⌘J** (**Ctrl J** off a Mac) on any page of your organization, or open **Trov** in the sidebar, and ask about your organization in plain words. The answer is built from what Trov holds, every source linked. A ticket, handoff or doc change it drafts waits for you to confirm it (in Auto mode it is made at once, with Undo), and a doc change is still staged for Review. Share a conversation with your whole organization to read, or with chosen people who can read or continue it.",
      `- **Relay** holds your handoffs and your links. A handoff carries where a task stands to the next session, yours or a teammate's. A link lets two sessions whose work overlaps leave each other notes, and a person starts it on both ends (${to("docs-concepts", "Concepts")} › Agent links).`,
      "- **Trov writes the short version.** With your organization's AI on, Trov writes your brief on My Work, where each repository stands on Repo › Summary, and a Feed record of what each session shipped, each with its sources. **Org settings › AI** says whether it is on and this month's use, and an admin turns it on or off there; off, no AI feature runs, Ask Trov included.",
    ].join("\n"),
  ].join("\n\n");
}

// ── Connect an MCP client ────────────────────────────────────────────────────

/** What an agent should know to use Trov well, for a project's AGENTS.md / CLAUDE.md. The rules are the
 *  plugin's own skills', in short: load-context (orient, handoffs, trust live), record-session (explicit,
 *  observed from git / gh, one batch), trov (stage, never confirm; lanes; repo on every call). */
const RULE_LIVE = "- **Trust only `live`.** Every result is flagged `live`, `staged_pending`, `unpromoted` or `draft`. Only `live` is settled; never present the others as fact.";
const RULE_STAGE = "- **Stage, never confirm.** Doc changes, decisions and feed entries you write are proposals that a person promotes in the Trov web app; you cannot promote, ratify, reject or publish. Do not resolve a ticket or complete a sprint unless the person asks.";
const RULE_TICKETS = "- **Tickets: your lane only.** You may file tickets (`create_ticket`, after `list_people` to pick assignees). Every other ticket write needs the ticket to be assigned to the person you work for.";
const ruleOrient = (lead: string): string =>
  `- **${lead}** Before changing an area the team already knows, search Trov with \`query\` (a short, specific \`q\`; narrow with \`types\` and \`section\`) and read the top results; open a doc with \`get_doc\`. Always do this before proposing a doc change, and pass the doc's \`current_version\` as \`base_version\`.`;

export const AGENT_SNIPPET = [
  "## Trov: the team's memory",
  "",
  `This team keeps its docs, decisions, roadmap, tickets and a feed of what shipped in Trov, through the \`trov\` MCP server (${MCP_URL}).`,
  "",
  ruleOrient("Orient before you work."),
  RULE_LIVE,
  "- **Say which repository.** Pass `repo` (owner/name, from `git remote get-url origin`) on every Trov call. Unsure where you are? Call `get_connection` and tell the person which organization you are in.",
  "- **At the start of a session,** call `list_handoffs` and `get_my_work`, and tell the person what is waiting. Claim a handoff only after they pick it.",
  RULE_STAGE,
  RULE_TICKETS,
  "- **Record at the end, only when asked.** When the person says “record this session”, send ONE `record_session` batch: what actually shipped, copied from `git` and `gh` output (never from memory), and doc changes written against the version you read.",
].join("\n");

/** The heading of Connect's section for a client in no repository — Setup links to it by name. */
export const CHAT_SECTION = "In a chat, with no repository";
/** "1 MB": the largest binary file that travels inside an MCP call (shared/artifacts-core.ts). */
const INLINE_MAX = `${ARTIFACT_INLINE_BINARY_MAX / (1024 * 1024)} MB`;

/** AGENT_SNIPPET for a client with no checkout and no shell (a claude.ai Project's instructions): the same
 *  rules, with what src/mcp.ts's descriptions say to do there — no `repo` to pass, nothing to read from git,
 *  files inside the call. */
export const CHAT_SNIPPET = [
  "## Trov: the team's memory",
  "",
  `This team keeps its docs, decisions, roadmap, tickets and a feed of what shipped in Trov, through the Trov connector (${MCP_URL}). This chat is in no code repository.`,
  "",
  "- **Say where you are.** At the start of a chat, call `get_connection` and tell the person which organization you are in. When they name another one, pass `org` on that call, or use `switch_org` and say that it changes the organization for every chat on this connection.",
  ruleOrient("Orient before you answer."),
  RULE_LIVE,
  "- **Never invent a repository.** Leave `repo`, branch and files out unless the person names them; when a call needs a repository, ask which one they mean.",
  "- **At the start of a chat,** also call `list_handoffs` and `get_my_work`, and tell the person what is waiting. Claim a handoff only after they pick it. You cannot change code here: say what the handoff asks, and do the parts that need no repository.",
  RULE_STAGE,
  RULE_TICKETS,
  "- **Record only when asked.** Send ONE `record_session` batch with what was decided or written in this chat, and doc changes written against the version you read. You cannot read `git` here: record shipped work only from a pull request or commit the person gives you, never from memory.",
  `- **Files travel inside the call.** An image, PDF or file artifact of up to ${INLINE_MAX} goes as \`content_base64\` (\`upload_asset\`, \`artifact_update\`) and comes back with \`include_file\` (\`artifact_get\`). For a larger one, give the person its link.`,
].join("\n");

function connect(): string {
  const tokenHeader = `Authorization: Bearer $${TOKEN_ENV}`;
  return [
    head("docs-connect", "Connect an MCP client"),
    "## How connecting works",
    [
      `- **One address:** \`${MCP_URL}\`, a remote MCP server over Streamable HTTP. Nothing runs on your machine.`,
      "- **Browser sign-in (OAuth).** A request with no token is answered `401` with a `WWW-Authenticate` header pointing at Trov's OAuth metadata (`/.well-known/oauth-protected-resource`, RFC 9728). A client that supports MCP's OAuth registers itself (RFC 7591), opens Trov in your browser, and gets a token after you click **Allow**. OAuth 2.1 with PKCE; access tokens last an hour and refresh on their own. Trov accepts `https` redirect addresses and `http` on a loopback host (`localhost`, `127.0.0.1`), which is what native clients use.",
      "- **Which organization.** One connection covers all your organizations. On the Allow page you choose how it picks one: **follow the repository** you are working in (every call passes `repo`, and acts in the organization that has that repository connected), or **manual** (it acts in the organization you choose, among the ones you tick; `switch_org` changes it). Change it later in Settings › MCP access.",
      "- **It acts as you.** It sees what you see and writes as you, within what an agent may do (" + to("docs-concepts", "Concepts") + "). Revoke it any time in Settings › MCP access › Connected apps.",
      `- **A pasted token** (\`trov_mcp_…\`, or an older \`canopy_mcp_…\`) also works, sent as \`Authorization: Bearer <token>\`; it acts in the one organization it was made for. Settings no longer creates tokens, and a token you already have keeps working. For a client that cannot sign in through a browser (CI, a headless agent), a signed-in person can still mint one with \`POST /api/o/<your-org>/mcp-tokens\`; the token is shown once. The examples below read it from \`$${TOKEN_ENV}\`.`,
    ].join("\n"),
    "## Claude Code",
    "**With the plugin (recommended).** It adds the MCP server and the skills (`trov`, `load-context`, `record-session`, `my-work`, `tickets`, `handoff`, `link`, `prompts`, `artifacts`, `read-plan`, `update-plan`). In Claude Code:",
    fence("text", PLUGIN_INSTALL),
    "Then run `/mcp`, choose **trov**, then **Authenticate**, and click **Allow** in the browser. Update it later with `/plugin marketplace update trov`.",
    "**Without the plugin.** Add the server for every project (`--scope user`), then `/mcp` › trov › Authenticate as above:",
    fence("bash", browserConnectCommand(MCP_URL)),
    "With a token instead of the browser sign-in:",
    fence("bash", `claude mcp add --transport http --scope user trov ${MCP_URL} --header "${tokenHeader}"`),
    "Use one or the other, not both, or your agent sees every tool twice (`claude mcp remove trov` drops the manual one).",
    "## Claude Desktop and claude.ai",
    "Trov is a **custom connector** there. There is no plugin, and no field for a token: custom connectors sign in through the browser only.",
    [
      `1. Open Settings › Connectors, choose **Add custom connector**, name it Trov and enter \`${MCP_URL}\`.`,
      "2. Choose **Connect**. Trov's sign-in opens in the browser.",
      "3. On the Allow page, **manual** is already chosen, because a chat is in no repository to follow. Tick the organizations the connection may use, pick the one it starts in, and click **Allow**.",
      "4. In a chat, ask “call `get_connection`”. It answers who you are and which organization you are in.",
    ].join("\n"),
    "On a Team or Enterprise plan, an owner adds the connector for the organization and each member connects it. The connection shows up in Trov under Settings › MCP access › Connected apps, like any other.",
    "## ChatGPT",
    "Trov is a **custom app** in ChatGPT on the web, added in developer mode. Like a claude.ai connector, it signs in through the browser only.",
    [
      "1. Open Settings › Apps › Advanced settings and turn on **Developer mode**. (On a Business or Enterprise workspace, an admin has to allow it first.)",
      `2. Choose **Create app**, name it Trov, enter \`${MCP_URL}\` as the MCP server URL and choose **OAuth** for authentication. ChatGPT registers itself with Trov; there is no client ID or secret to fill in.`,
      "3. Trov's sign-in opens. On the Allow page **manual** is already chosen, because a chat is in no repository. Tick the organizations the connection may use, pick the one it starts in, and click **Allow**.",
      "4. In a chat, add Trov from the tools menu and ask “call `get_connection`”. It answers who you are and which organization you are in.",
    ].join("\n"),
    "ChatGPT runs Trov's read tools (search, docs, tickets, your work) without asking, and asks you to confirm each call that writes. Everything a chat can and cannot do is the same as in claude.ai (below).",
    `## ${CHAT_SECTION}`,
    "A chat (claude.ai on the web, Claude Desktop, ChatGPT, or any client outside a code checkout) gets all of Trov's tools, but it has no repository, no shell and none of the Claude Code plugin's skills. Nothing orients or records by itself: you ask.",
    "**Things to ask in a first chat:**",
    [
      "- “What’s on my plate in Trov?” Your open tickets and assigned issues, and your recent pull requests (`get_my_work`).",
      "- “What does Trov say about the billing flow?” A search of the docs, decisions and feed (`query`), then the doc itself (`get_doc`).",
      "- “File a ticket for this and assign it to me.” Tickets are written at once; after that the agent can change only the tickets assigned to you.",
      "- “Propose this as a change to the onboarding doc.” It is staged, and waits in **Triage › Review** until a person promotes it.",
      "- “Save this as a prompt”, or “make this an artifact”. A prompt is staged until a person publishes it.",
      "- “Leave a handoff for my next coding session.” It says where the task stands; your agent in the repository lists it when it starts.",
      `- “Join Trov link 12.” Once a link is open (${to("docs-concepts", "Concepts")} › Agent links), the chat leaves notes on it and reads the other side's. It has no hooks, so it reads them when you ask (“any notes on the link?”) or when it checks by itself at the start of a reply, which Trov asks of it but cannot make sure of.`,
    ].join("\n"),
    "**What is different with no repository:**",
    [
      "- **Which organization.** A manual connection acts in its current organization. Say “switch to <organization>” (`switch_org`, which changes it for every chat on that connection), or change it in Settings › MCP access. A connection set to follow the repository reads and writes nothing in a chat unless a call names the repository: switch it to manual in Settings › MCP access.",
      "- **Nothing reads `git`.** A handoff written in a chat carries no repository, branch or files. An agent that claims a handoff asking for code changes cannot make them: it tells you what is asked and does the parts that need no repository.",
      "- **Recording.** “Record this chat” stages the decisions and doc changes made in it. The agent cannot see what shipped, so give it the pull request or commit to record shipped work.",
      `- **Files.** With no shell there is nothing to upload or download with, so an image, PDF or file artifact travels inside the call, up to ${INLINE_MAX}. A larger one can be linked, but not opened or uploaded. A picture you attach to the chat usually cannot be passed on to Trov. Text artifacts (HTML, Markdown, SVG, Mermaid) are sent as text.`,
    ].join("\n"),
    "**Tell the agent once.** In a claude.ai Project or a ChatGPT project, put this in the project's instructions, so every chat in it follows the same rules:",
    fence("markdown", CHAT_SNIPPET),
    "## Cursor",
    "In `.cursor/mcp.json` (this project) or `~/.cursor/mcp.json` (every project):",
    json({ mcpServers: { trov: { url: MCP_URL } } }),
    "Cursor opens the browser sign-in when the server needs it. Its recent versions sign in through a loopback address, which Trov accepts; an older build that registers a `cursor://` address is refused at sign-in (Trov takes only https and loopback redirects), so update Cursor, or use a token:",
    json({ mcpServers: { trov: { url: MCP_URL, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } } }),
    "## VS Code",
    "In `.vscode/mcp.json` (this workspace), or with **MCP: Open User Configuration** (every workspace):",
    json({ servers: { trov: { type: "http", url: MCP_URL } } }),
    "VS Code registers itself with Trov and opens the browser sign-in on first use. With a token, VS Code asks for it once and keeps it in its secret storage:",
    json({
      inputs: [{ type: "promptString", id: "trov-token", description: "Trov MCP token", password: true }],
      servers: { trov: { type: "http", url: MCP_URL, headers: { Authorization: "Bearer ${input:trov-token}" } } },
    }),
    "## OpenAI Codex CLI",
    "Add the server; Codex sees that Trov signs in with OAuth and opens the browser:",
    fence("bash", `codex mcp add trov --url ${MCP_URL}\ncodex mcp login trov   # sign in again later, if needed`),
    "Or in `~/.codex/config.toml`:",
    fence("toml", `[mcp_servers.trov]\nurl = "${MCP_URL}"`),
    "With a token, read from the environment (Codex does not take the token itself in the file):",
    fence("toml", `[mcp_servers.trov]\nurl = "${MCP_URL}"\nbearer_token_env_var = "${TOKEN_ENV}"`),
    "## Windsurf",
    "In `~/.codeium/windsurf/mcp_config.json`, a remote server is `serverUrl`:",
    json({ mcpServers: { trov: { serverUrl: MCP_URL } } }),
    "If your Windsurf version does not open a browser sign-in for remote servers, send a token:",
    json({ mcpServers: { trov: { serverUrl: MCP_URL, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } } }),
    "## Any other MCP client",
    "Trov works with any client that speaks MCP over Streamable HTTP and either follows MCP's OAuth flow (it discovers everything from the `401`) or can send a header. Most clients read this shape; it is the Claude Code plugin's own `.mcp.json`:",
    json({ mcpServers: { trov: { type: "http", url: MCP_URL } } }),
    "and, with a token, add the header:",
    json({ mcpServers: { trov: { type: "http", url: MCP_URL, headers: { Authorization: `Bearer <your trov_mcp_ token>` } } } }),
    "A client that only runs local (stdio) servers can reach a remote one through a bridge such as `mcp-remote` (`npx mcp-remote " + MCP_URL + "`).",
    "## Check the connection",
    "Ask your agent to call `get_connection`. It answers who you are, the connection's mode, and which organization a call would act in; `organization: null` means a call would read and write nothing, and `unresolved` says why. Every failed call carries a `hint` saying what to do next (" + to("docs-mcp-tools", "MCP tools") + " › Errors).",
    "## Tell your agent how to use Trov",
    `The Claude Code plugin's skills already follow this loop. For any other agent that works in a repository, or to make it explicit, add this to your project's \`AGENTS.md\` or \`CLAUDE.md\` (for a chat, use the one under ${CHAT_SECTION}):`,
    fence("markdown", AGENT_SNIPPET),
  ].join("\n\n");
}

// ── Concepts ─────────────────────────────────────────────────────────────────

function concepts(): string {
  return [
    head("docs-concepts", "Concepts"),
    "## What Trov holds",
    "Trov is one organization's working memory, shared by its people and the coding agents they connect:",
    [
      "- **Docs**, in the Library: spaces your team defines (every organization starts with Engineering, Product and Design), each a tree of pages up to five levels deep that link to each other with `[[page]]` links, with every version kept.",
      "- **Decisions**: architecture decision records. An agent drafts one and a person ratifies it in Review.",
      "- **The feed**: what shipped, from people and agents alike, each entry linked to its pull request, commit or issue.",
      "- **Tickets and sprints**: the team's request queue, the roadmap's sprints and a short written plan.",
      "- **Relay**: handoffs from one session to the next, and links between sessions whose work overlaps (below).",
      "- The team's **Prompt Library**, and **artifacts**: versioned pages and files (HTML, Markdown, SVG, Mermaid, images, PDFs).",
      "- **The Repo dashboard**: each app and environment's deploys, CI, drift and usage, from what Trov has captured from GitHub and the hosts you connect. What was never captured reads as unknown, never as zero.",
    ].join("\n"),
    `An agent connects as a person (${to("docs-connect", "Connect an MCP client")}): it reads what that person can read, and everything it writes is recorded as theirs. A name an agent puts in a request as the author is ignored.`,
    "**Ask Trov** is the same memory from inside the web app: ask in plain words and the answer is built from what Trov holds, every source linked. What it drafts (a ticket, a handoff, a doc change) waits for you to confirm it, or is made at once with Undo in Auto mode, and a doc change is still staged for Review. A conversation can be shared with the whole organization to read, or with chosen people who can read or continue it. Each question in a shared conversation stays its asker's.",
    "## Agents propose, people decide",
    "A wrong doc gets believed by every agent that reads it after. So the rule is about what an agent may make official on its own: **nothing**. Knowledge an agent proposes is **staged**, and a person confirms it. Work that is a request or a plan, not a claim, takes effect at once, bounded by who may do it:",
    [
      "| | Staged: a person confirms | Direct: takes effect now |",
      "|---|---|---|",
      "| What | doc changes, decisions (ADRs), feed entries | tickets, sprints, the roadmap plan, artifacts, handoffs |",
      "| Agent tools | `propose_doc_update`, `append_feed`, `record_session` | `create_ticket`, `transition_ticket`, `create_sprint`, `upload_asset`, `send_handoff`, … |",
      "| What bounds it | the gate, then a person's verdict | scope: your own lane, or a role |",
    ].join("\n"),
    "**Confirming is a person's act in the signed-in web app**: promote or reject a doc change, ratify or reject a decision, place or discard what Triage holds, publish a prompt, ratify an artifact. No MCP tool does any of these, and those routes refuse any request that carries a token. Rejected proposals and old versions are kept, never deleted.",
    "## The gate",
    "Every proposal goes through one gate, whichever way it arrives (`record_session`, `propose_doc_update`, `append_feed`, a Markdown import into the Library, or the `/ingest` API):",
    [
      "- **Sending the same thing twice changes nothing.** A replayed batch, or a body identical to what is there, is dropped as `unchanged`.",
      "- **Each doc change is classified** `new`, `edit` or `rewrite` by the server, against the live version. The version the writer read (`base_version`) is kept, so an edit written against an out-of-date version is flagged.",
      "- **Nothing is guessed.** A doc proposal with a section that isn't one of Trov's, a space your organization doesn't have, or an archived page's name is refused, and the reason lists what is valid, so the agent fixes it in the same session. A change or decision proposed with low confidence is staged, flagged for a closer look. A tag that isn't on your organization's list is left off the entry and suggested to an admin.",
      "- **A doc embeds only images uploaded to Trov.** A proposal pointing at any other image source is refused, and nothing is staged.",
    ].join("\n"),
    "What passes is **staged**: the live doc is untouched until a person promotes the change in **Triage › Review**, which shows it as a diff (unified, side by side, or rendered).",
    "## Live, staged, unpromoted, draft",
    "Every result an agent reads from `query` carries an `authority`. Treat anything that is not `live` as not settled:",
    [
      "- `live`: settled. A person promoted or ratified it. Trust it.",
      "- `staged_pending`: a newer version is staged but not promoted. The body shown is still the live one; the proposal comes beside it.",
      "- `unpromoted`: exists only as staged content and was never promoted. A draft, not the truth.",
      "- `draft`: a decision that has not been ratified, or an artifact still in draft.",
    ].join("\n"),
    "Artifacts have their own statuses: `draft`, `published` (shared, one person's word) and `ratified` (a person's sign-off on the latest version, the only team-confirmed one). A prompt an agent saves is `staged` until a person publishes it.",
    "## Who may change what",
    [
      "- **Tickets.** Anyone, and any agent, may file one. Every other ticket write by an agent needs the ticket to be assigned to its person already; assigning (`assign_ticket`) is for an admin, the ticket's requester or a current assignee.",
      "- **Sprints** are open to every member, people and agents alike. Rewriting the whole plan (`update_plan`) is for admins.",
      "- **Nothing infers a resolution.** A merged pull request, a closed issue, the clock or every ticket being done never closes a ticket or finishes a sprint: a person does. The one exception is a ticket mirrored from a GitHub issue, which follows its own issue's close and reopen.",
      "- **Admin is a role in an organization** (admin or owner). Inviting people and connecting repositories are an admin's; the plan and its billing are an owner's.",
    ].join("\n"),
    "## The loop: orient, work, record",
    [
      "1. **Orient.** Before working an area the team already knows, the agent searches Trov (`query`) and reads what is settled. The Claude Code plugin's `load-context` skill does this by itself.",
      "2. **Work**, building on what the team decided instead of guessing.",
      "3. **Record**, only when a person asks. The agent reads what actually shipped from `git` and GitHub, reads back each doc it touches, and sends one batch (`record_session`). It is staged, and waits for a person.",
    ].join("\n"),
    "Between sessions, a **handoff** carries where a task stands to the next session (yours, a teammate's, or anyone's); unclaimed ones expire after 7 days. It can carry a ready-to-run prompt, which an agent with a shell uploads as a file instead of typing it out; the handoff is created when the file lands. Handoffs are on **Relay** in the web app.",
    "## Agent links",
    "Connect your own sessions — a coding agent, a web chat, an Ask thread — so they leave each other notes while the work overlaps; you can link with a teammate's session too. A **link** is a short-lived line between two sessions: two of yours (**Relay › Links › Start a link**, which opens at once; then tell each session “join Trov link #12”), or yours and a teammate's. While it is open, each side leaves short notes for the other (“renaming `authSession`, merging tonight”). A note informs; it never asks the other side to change its work, which is a conversation for the people. When the work lands, either side closes the link, and its thread stays readable in Trov.",
    [
      "- **A person starts every link, on both ends.** An agent that notices an overlap (the same files as an open pull request or another local branch) asks you first, and with your yes drafts a request (`request_link`). You send it from its page in Trov (**Relay › Links**), and the other person accepts it there. No agent can send or accept a link. Each side's agent then joins it when its person says so (“join Trov link #12”).",
      "- **How notes arrive.** A Claude Code agent with the plugin gets them at each prompt and after each `git commit` or `git push`, once the plugin's `link` skill is in use in that session: asking it to request or join a link turns that on. After `/clear`, say “join link 12” again. Nothing arrives while a session sits idle.",
      "- **In a chat** (claude.ai, Claude Desktop, Cursor's chat) no hooks run. A chat reads its notes when you ask, or when it calls `link_inbox` itself: Trov asks a chat that joined a link to check at the start of each reply, but cannot make sure it does.",
      "- **An Ask thread can be a side.** Ask Trov to “send this to my agent on PR #180”: it shows the request as a card, and your Confirm sends it, with that thread as your side. The other side's notes reach the thread with your next question, and Trov never joins, writes a note or closes a link without your click, even on Auto.",
      "- **On the link's page** in the web app, either person reads the whole thread and can write a note on their own side.",
      `- **Limits.** A note is up to ${LINK_NOTE_MAX.toLocaleString("en-US")} characters, and each side of a link may leave ${LINK_NOTES_PER_SIDE} notes. A person has at most ${LINK_LIVE_MAX} links sent or open at a time in an organization. A draft nobody sent lapses after ${span(LINK_DRAFT_TTL_MS)}, an unanswered request after ${span(LINK_REQUEST_TTL_MS)}, and an open link after ${span(LINK_IDLE_MS)} with no sign from either side, or ${span(LINK_OPEN_TTL_MS)} at most.`,
    ].join("\n"),
    "## One connection, several organizations",
    `A person can belong to several organizations, and one agent connection can reach all of them. Each call acts in exactly ONE, chosen only among the person's own live memberships: a connection that follows the repository acts in the organization that has the call's \`repo\` connected; a manual one in its current organization; a pasted token in the one it was made for. When no organization fits, nothing is read or written, and the error says what to do. Nothing in a refusal reveals another organization.`,
    `Trov's source is public under AGPL-3.0: [${TROV_REPO.replace("https://", "")}](${TROV_REPO}).`,
  ].join("\n\n");
}

// ── the registry ─────────────────────────────────────────────────────────────

/** Every docs page's Markdown, by its key in shared/site-pages.ts. */
export const DOCS: Readonly<Record<string, () => string>> = {
  "docs-setup": setup,
  "docs-connect": connect,
  "docs-concepts": concepts,
  "docs-mcp-tools": () => mcpToolsMarkdown(page("docs-mcp-tools")),
  "docs-changelog": () => changelogMarkdown(page("docs-changelog")),
};

/** A docs page's whole Markdown text: what `/docs/<page>.md` serves, and what its HTML is rendered from. */
export function docsMarkdown(p: SitePage): string {
  const make = DOCS[p.key];
  if (!make) throw new Error(`docs-content: no content for docs page "${p.key}"`);
  return `${make().trim()}\n`;
}

/** Where the page lives, for a Markdown reader: a line at the end of every `.md`. */
export const markdownFooter = (p: SitePage): string =>
  `\n---\n\nThis page: ${siteUrl(p.path)} · All docs for language models: ${siteUrl("/llms.txt")}\n`;
