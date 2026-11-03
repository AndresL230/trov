// "One service that does everything" (#144, narrowed by #153) — a repository whose whole product is ONE deployable
// on ONE host (Trov itself: one Worker serving the API, MCP, the webhooks and the SPA). Built on the repo-setups
// model, never beside it: an app (`repo_apps`), one part of it in one environment (`org_environment_parts`), and the
// environment's URL and health path (`org_environments`) — each through its own audited writer.
//
//   recogniseOneService   PURE. From what is already captured and read (no call to GitHub or a host — invariant 7):
//                         the PRIMARY repository (its capture is the only one `repo_events` holds) has no app yet;
//                         exactly ONE host shows signs in the captured check runs, deployments and commit statuses
//                         (`detectProviders`, the same signs Org settings › Hosting's "Detected" reads); and the repo
//                         scan proposes at most ONE deployable app, on that host or on none. Anything else — two
//                         hosts, two deployables, a host Trov cannot read yet — is not offered: a wrong pre-fill is
//                         worse than none. The answer is a PRE-FILL; nothing is written until a person confirms it.
//   setUpOneService       admin, the confirmed step: the environment (the one called production, else the only one,
//                         else a new `production` — `putEnvironment`, plan-checked, audited `environment.set`) gets the
//                         URL as BOTH of its addresses (the URL Trov pings and the one app metrics are read from)
//                         and the health path; then the app (`putRepoApp`, audited `app.set`) and its one part on the
//                         host (`putPart`, audited `part.set`); the suggestion it confirms is marked accepted. A refused
//                         step undoes what this call wrote before it (the environment restored or removed) and the
//                         refusal stands. The credential is NOT here: the host's own connect / token dialog follows on
//                         the screen (Hosting's, through the resolver — invariant 12).
import { HOSTING_PROVIDERS, PART_KEY_RE, type HostingDetectionDTO, type HostingProviderId } from "@shared/hosting";
import { APP_KIND_ROLE, isAppKind, kindForRole, type AppKind } from "@shared/repo-apps-core";
import type { AppSuggestionDTO, OneServiceOfferDTO, OneServiceResult } from "@shared/repo-scan-core";
import type { OrgEnvironmentDTO } from "@shared/integrations";
import { requireRole } from "../data/context";
import { first, run, type TenantContext } from "../data/sql";
import { checkFields } from "../hosting/registry";
import { deletePart, putPart, type ProviderMap } from "../hosting/part-writes";
import { listAllParts } from "../hosting/parts";
import { SettingsError, deleteEnvironment, listEnvironments, putEnvironment } from "../integrations/settings";
import { deleteRepoApp, putRepoApp } from "./apps";
import { envForHint } from "./detect/match";

/** The key a new `production` environment gets when the org has none to put the service in. */
export const ONE_SERVICE_ENV = { key: "production", label: "Production", branch: "main" } as const;

type EnvRow = Pick<OrgEnvironmentDTO, "key" | "label" | "branch" | "frontend_url" | "api_url" | "health_path">;

/** The environment the service goes in: the one called production (by key, label or alias), else the only one —
 *  else none (a new `production` is made on confirm). */
export function oneServiceEnv(envs: readonly EnvRow[]): EnvRow | null {
  const named = envForHint("production", envs);
  if (named) return envs.find((e) => e.key === named) ?? null;
  return envs.length === 1 ? envs[0] : null;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "");

export interface OneServiceInput {
  repo: string;
  /** The repository is the org's primary one (the only one whose GitHub signals are captured). */
  primary: boolean;
  /** The repository's apps (rows and implicit ones). */
  apps: readonly { key: string }[];
  suggestions: readonly AppSuggestionDTO[];
  /** The hosts the captured signals name (`detectProviders`). */
  detected: readonly HostingDetectionDTO[];
  environments: readonly EnvRow[];
  /** Every app and part key the org already uses (a new key must be free). */
  taken: ReadonlySet<string>;
  providers: ProviderMap;
}

/** See the header. null = not one service, as far as Trov can tell — the page shows its suggestions as before. */
export function recogniseOneService(i: OneServiceInput): OneServiceOfferDTO | null {
  if (!i.primary || i.apps.length > 0) return null;
  if (i.detected.length !== 1) return null; // none, or a second host: not one service
  const host = i.detected[0];
  const provider = i.providers[host.provider];
  if (!provider || provider.status !== "available" || provider.credential === "github_app") return null;
  const deployable = i.suggestions.filter((s) => s.state === "pending" && s.kind !== "Package");
  if (deployable.length > 1) return null;
  const s = deployable[0] ?? null;
  if (s && s.provider !== null && s.provider !== provider.id) return null;
  const kind: AppKind = s && isAppKind(s.kind) ? s.kind : kindForRole(provider.roles[0]);
  const role = APP_KIND_ROLE[kind];
  if (role === null || !provider.roles.includes(role)) return null; // the host cannot serve what the files say it is
  // The key: the suggestion's, else the repository's name — free in the org, or the next free one.
  let key = s?.key ?? "";
  if (!key) {
    const base = slug(i.repo.split("/").pop() ?? "") || "app";
    key = [base, ...Array.from({ length: 20 }, (_, n) => slug(`${base.slice(0, 28)}-${n + 2}`))].find((k) => PART_KEY_RE.test(k) && !i.taken.has(k)) ?? "";
    if (!key) return null;
  }
  // The host's settings the scan read (its own keys only), from the suggestion's proposed part on that host.
  const proposed = s?.parts.find((p) => p.provider === provider.id)?.settings ?? {};
  const settings = Object.fromEntries(Object.entries(proposed).filter(([k, v]) => typeof v === "string" && provider.partSettings.some((f) => f.key === k)));
  const env = oneServiceEnv(i.environments);
  return {
    provider: provider.id, evidence: host.evidence, suggestion: s?.id ?? null, key, folder: s?.folder ?? "/", kind, settings,
    env: env
      ? { key: env.key, label: env.label, branch: env.branch, exists: true, url: env.api_url || env.frontend_url, health_path: env.health_path === "/" ? "" : env.health_path }
      : { ...ONE_SERVICE_ENV, exists: false, url: "", health_path: "" },
  };
}

// ── the confirmed step ───────────────────────────────────────────────────────

const invalid = (field: string, message: string) => new SettingsError("invalid", 400, message, field);
const BODY_KEYS = ["provider", "key", "url", "health_path", "branch", "settings", "suggestion"];

/** One step, confirmed by an admin (see the header). `handle` is the authenticated admin. */
export async function setUpOneService(ctx: TenantContext, handle: string, repo: string, body: unknown, providers: ProviderMap): Promise<OneServiceResult> {
  requireRole(ctx, "admin");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !BODY_KEYS.includes(k))) throw invalid("body", "the body has a field this step does not take");

  // Everything that can be checked without writing, first.
  if (typeof b.provider !== "string" || !(HOSTING_PROVIDERS as readonly string[]).includes(b.provider)) throw invalid("provider", "provider is not one Trov knows");
  const provider = providers[b.provider as HostingProviderId];
  if (!provider || provider.status !== "available" || provider.credential === "github_app") throw invalid("provider", "pick a host Trov can read");
  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!PART_KEY_RE.test(key)) throw invalid("key", "the name must be 1–32 characters: a–z, 0–9, _ or -");
  const url = typeof b.url === "string" ? b.url.trim().replace(/\/+$/, "") : "";
  if (!url) throw invalid("url", "the production URL is required");
  const healthRaw = b.health_path === undefined || b.health_path === null ? "" : b.health_path;
  if (typeof healthRaw !== "string") throw invalid("health_path", "health_path must be a string");
  const health = healthRaw.trim() || "/";
  if (!health.startsWith("/")) throw invalid("health_path", "the health path must start with /");
  const branch = b.branch === undefined ? "" : b.branch;
  if (typeof branch !== "string") throw invalid("branch", "branch must be a string");
  const checked = checkFields(provider.partSettings, b.settings ?? {}, "settings");
  if ("field" in checked) throw invalid(checked.field, checked.message);
  const settingsProblem = provider.checkSettings?.(checked.values);
  if (settingsProblem) throw invalid(settingsProblem.field, settingsProblem.message);
  const suggestion = typeof b.suggestion === "string" && b.suggestion ? b.suggestion : null;
  if (b.suggestion !== undefined && b.suggestion !== null && typeof b.suggestion !== "string") throw invalid("suggestion", "suggestion must be an id");

  const taken = await first<{ key: string }>(ctx,
    `SELECT key FROM repo_apps WHERE org_id = ? AND key = ? UNION SELECT part_key FROM org_environment_parts WHERE org_id = ? AND part_key = ?`,
    ctx.orgId, key, ctx.orgId, key);
  if (taken) throw new SettingsError("key_taken", 409, "an app or a part already has this name", "key");
  let sugg: { kind: string; folder: string } | null = null;
  if (suggestion) {
    sugg = await first<{ kind: string; folder: string }>(ctx,
      `SELECT kind, folder FROM repo_app_suggestions WHERE org_id = ? AND id = ? AND lower(repo) = lower(?) AND state = 'pending'`, ctx.orgId, suggestion, repo);
    if (!sugg) throw new SettingsError("not_found", 404, "no such suggestion");
  }
  const kind: AppKind = sugg && isAppKind(sugg.kind) && sugg.kind !== "Package" ? sugg.kind : kindForRole(provider.roles[0]);
  const role = APP_KIND_ROLE[kind];
  if (role === null || !provider.roles.includes(role)) throw invalid("provider", `${provider.label} does not serve a ${kind.toLowerCase()}`);

  // 1. the environment: its URL (both addresses) and health path.
  const envs = await listEnvironments(ctx);
  const target = oneServiceEnv(envs);
  const before = target ? { frontend_url: target.frontend_url, api_url: target.api_url, health_path: target.health_path } : null;
  const urls = { frontend_url: url, api_url: url, health_path: health };
  const envKey = target?.key ?? ONE_SERVICE_ENV.key;
  const wrote = await putEnvironment(ctx, envKey, target ? urls : { label: ONE_SERVICE_ENV.label, branch: branch.trim() || ONE_SERVICE_ENV.branch, ...urls })
    .catch((e: unknown) => {
      // The environment's own check names its two address fields; on this step there is one URL.
      if (e instanceof SettingsError && (e.field === "frontend_url" || e.field === "api_url")) {
        throw invalid("url", e.message.replace(/^(?:frontend_url|api_url):?\s*/, "the URL: "));
      }
      throw e;
    });

  // 2. the app and its one part — undone, with the environment, if either is refused.
  let appWritten = false;
  try {
    const { app } = await putRepoApp(ctx, key, { repo, folder: sugg?.folder ?? "/", kind, source: sugg ? "suggested" : "manual" });
    appWritten = true;
    await putPart(ctx, envKey, key, { provider: provider.id, role, settings: checked.values }, providers);
    if (suggestion) {
      await run(ctx, `UPDATE repo_app_suggestions SET state = 'accepted', decided_at = ?, decided_by = ? WHERE org_id = ? AND id = ?`,
        new Date().toISOString(), handle, ctx.orgId, suggestion);
    }
    return { env: { key: envKey, created: wrote.created }, app, part: { env: envKey, key, provider: provider.id } };
  } catch (e) {
    if ((await listAllParts(ctx)).some((p) => p.env === envKey && p.key === key)) await deletePart(ctx, envKey, key).catch(() => undefined);
    if (appWritten) await deleteRepoApp(ctx, key).catch(() => undefined);
    if (wrote.created) await deleteEnvironment(ctx, envKey).catch(() => undefined);
    else if (before) await putEnvironment(ctx, envKey, before).catch(() => undefined);
    throw e;
  }
}
