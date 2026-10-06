// Person profiles (0036; the contract is shared/people.ts): GET|PUT /api/people/:handle,
// the avatar upload / remove, GET /avatar/<sha>, and the avatar rule (`avatarSrc`) on
// every surface that sends a person's picture to the SPA. Real D1 + local R2, through
// the real Hono app. ADMIN_LOGINS binds only "admin-user" (vitest.config.ts).

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import type { Env } from "../src/env";
import { first, run } from "./helpers/db";
import { recordSignIn } from "../src/auth/persons";
import { create_ticket } from "../src/tools/tickets";
import { sha256Hex } from "../src/tools/artifacts";
import { sniffAvatarType } from "../src/tools/people";
import { AVATAR_MAX_BYTES, RESPONSIBILITIES_MAX, ROLE_MAX, type PersonProfile, type PersonSummary } from "@shared/people";
import type { PersonRow } from "@shared/rows";
import { cookieFor, seedPerson } from "./helpers/persons";

import { platformCtx, ORG_A, systemCtx } from "./helpers/tenant";
const PROVIDER = "https://avatars.githubusercontent.com/u/1?v=4";

const get = async (path: string, cookie: string, e: unknown = env) => app.request(path, { headers: { cookie } }, e as Env);
const put = async (path: string, cookie: string, body: unknown) =>
  app.request(path, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const profileOf = async (handle: string, cookie: string): Promise<PersonProfile> => {
  const res = await get(`/api/people/${handle}`, cookie);
  expect(res.status).toBe(200);
  return res.json() as Promise<PersonProfile>;
};
const personRow = async (handle: string) => (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = ?`, handle))!;
/** What the org holds about a member (Q9): `memberships.title` — it travels as `role` — and `responsibilities`. */
const memberRow = async (handle: string) =>
  (await first<{ role: string | null; responsibilities: string | null }>(env.DB, `SELECT title AS role, responsibilities FROM memberships WHERE org_id = ? AND user_id = ?`, ORG_A, handle))!;

// Minimal images: only the magic bytes are sniffed, the rest is padding.
const PNG = (seed = "a") => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`png-${seed}`)]);
const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("jpeg-body")]);
const WEBP = () => new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 body");
const GIF = () => new TextEncoder().encode("GIF89a-body");

async function upload(cookie: string, bytes: Uint8Array, type: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], "me.img", { type }));
  return app.request("/api/people/me/avatar", { method: "POST", headers: { cookie, ...headers }, body: form }, env);
}

async function seedTicket(title: string, assignee: string, o: { status?: string; source?: "github"; updated_at?: string } = {}): Promise<number> {
  const id = await create_ticket(systemCtx(), { title, body: "", category: "other", priority: "normal", assignees: [assignee] }, "meilin");
  if (o.status) await run(env.DB, `UPDATE tickets SET status = ? WHERE id = ?`, o.status, id);
  if (o.source) await run(env.DB, `UPDATE tickets SET source = 'github', source_ref = ? WHERE id = ?`, `SaplingLearn/sapling#${id}`, id);
  if (o.updated_at) await run(env.DB, `UPDATE tickets SET updated_at = ? WHERE id = ?`, o.updated_at, id);
  return id;
}

describe("GET /api/people/:handle", () => {
  it("returns the profile: role, GitHub login, joined, admin flag; responsibilities WITHHELD from another member", async () => {
    const cookie = await cookieFor("viewer");
    const p = await profileOf("Jose-Gael-Cruz-Lopez", cookie);
    expect(p).toMatchObject({
      handle: "Jose-Gael-Cruz-Lopez", name: "Jose", color: "sky", avatar_url: null, role: "Backend engineer",
      github: "Jose-Gael-Cruz-Lopez", joined: "2026-01-01T00:00:00Z", admin: false, editable: false, self: false,
    });
    // The card carries nothing else — no tickets, sessions or docs (there is no profile page).
    expect(Object.keys(p).sort()).toEqual(["admin", "avatar_url", "color", "editable", "github", "handle", "joined", "name", "role", "self"]);
    expect("responsibilities" in p).toBe(false);
  });

  it("shows responsibilities ONLY to an admin (Maintenance › People's editor fills from it) — not to the person", async () => {
    const self = await profileOf("jose-gael-cruz-lopez", await cookieFor("Jose-Gael-Cruz-Lopez")); // any case
    expect(self.self).toBe(true);
    expect(self.editable).toBe(false);
    expect("responsibilities" in self).toBe(false);
    const admin = await profileOf("Jose-Gael-Cruz-Lopez", await cookieFor("admin-user"));
    expect(admin.self).toBe(false);
    expect(admin.editable).toBe(true);
    expect(admin.responsibilities).toMatch(/Sapling API/);
    expect((await profileOf("admin-user", await cookieFor("viewer"))).admin).toBe(true);
  });

  it("`me` names the viewer; an unknown or reserved handle is 404", async () => {
    const cookie = await cookieFor("meilin", { github: false });
    const me = await profileOf("me", cookie);
    expect(me.handle).toBe("meilin");
    expect(me.self).toBe(true);
    expect(me.github).toBeNull(); // Google-only
    for (const h of ["nobody-here", "github-webhook", "GitHub-Webhook"]) {
      expect((await get(`/api/people/${h}`, cookie)).status).toBe(404);
    }
  });

  it("a D1 failure is a 503, never a 500", async () => {
    const cookie = await cookieFor("viewer");
    const broken = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") return () => Promise.reject(new Error("D1 is down"));
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const res = await get("/api/people/AndresL230", cookie, { ...env, DB: broken });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily unavailable" });
  });

  it("401 without a session", async () => {
    expect((await app.request("/api/people/AndresL230", {}, env)).status).toBe(401);
  });
});

describe("PUT /api/people/:handle", () => {
  it("an admin sets role and responsibilities (trimmed) and gets the fresh profile", async () => {
    const cookie = await cookieFor("admin-user");
    const res = await put("/api/people/sanaok", cookie, { role: "  Support lead ", responsibilities: " Tickets from users. " });
    expect(res.status).toBe(200);
    const p = await res.json() as PersonProfile;
    expect(p.role).toBe("Support lead");
    expect(p.responsibilities).toBe("Tickets from users.");
    expect((await memberRow("sanaok")).role).toBe("Support lead");
  });

  it("an absent field is untouched; \"\" and null clear", async () => {
    const cookie = await cookieFor("admin-user");
    await put("/api/people/sanaok", cookie, { role: "" });
    let row = await memberRow("sanaok");
    expect(row.role).toBeNull();
    expect(row.responsibilities).toMatch(/Student and teacher support/);
    await put("/api/people/sanaok", cookie, { responsibilities: null });
    row = await memberRow("sanaok");
    expect(row.responsibilities).toBeNull();
    // Whitespace alone is empty.
    await put("/api/people/sanaok", cookie, { role: "Lead" });
    await put("/api/people/sanaok", cookie, { role: "   " });
    expect((await memberRow("sanaok")).role).toBeNull();
  });

  it("an admin edits anyone's profile", async () => {
    const res = await put("/api/people/meilin", await cookieFor("admin-user"), { role: "Head of product" });
    expect(res.status).toBe(200);
    expect((await memberRow("meilin")).role).toBe("Head of product");
  });

  it("anyone else is 403 and nothing is written — the person themselves included", async () => {
    for (const [target, viewer] of [["meilin", "sanaok"], ["sanaok", "sanaok"], ["sanaok", "me"]] as const) {
      const before = await memberRow(target);
      const res = await put(`/api/people/${viewer === "me" ? "me" : target}`, await cookieFor("sanaok", { github: false }), { role: "Intruder", responsibilities: "x" });
      expect(res.status, `${viewer} → ${target}`).toBe(403);
      const after = await memberRow(target);
      expect(after.role).toBe(before.role);
      expect(after.responsibilities).toBe(before.responsibilities);
    }
  });

  it("over a cap is 400 and writes NOTHING — not even the other, valid field", async () => {
    const cookie = await cookieFor("admin-user");
    const before = await memberRow("sanaok");
    let res = await put("/api/people/sanaok", cookie, { role: "r".repeat(ROLE_MAX + 1), responsibilities: "fine" });
    expect(res.status).toBe(400);
    res = await put("/api/people/sanaok", cookie, { role: "Fine", responsibilities: "x".repeat(RESPONSIBILITIES_MAX + 1) });
    expect(res.status).toBe(400);
    const after = await memberRow("sanaok");
    expect([after.role, after.responsibilities]).toEqual([before.role, before.responsibilities]);
    // Exactly at the caps is fine.
    res = await put("/api/people/sanaok", cookie, { role: "r".repeat(ROLE_MAX), responsibilities: "x".repeat(RESPONSIBILITIES_MAX) });
    expect(res.status).toBe(200);
  });

  it("a wrong-typed field or a non-object body is 400; an unknown or reserved handle is 404", async () => {
    const cookie = await cookieFor("admin-user");
    expect((await put("/api/people/meilin", cookie, { role: 42 })).status).toBe(400);
    expect((await put("/api/people/meilin", cookie, ["role"])).status).toBe(400);
    expect((await put("/api/people/nobody-here", cookie, { role: "x" })).status).toBe(404);
    expect((await put("/api/people/github-webhook", cookie, { role: "x" })).status).toBe(404);
  });
});

describe("avatar upload / remove", () => {
  it("sniffs the magic bytes of every accepted type", () => {
    expect(sniffAvatarType(PNG())).toBe("image/png");
    expect(sniffAvatarType(JPEG())).toBe("image/jpeg");
    expect(sniffAvatarType(WEBP())).toBe("image/webp");
    expect(sniffAvatarType(GIF())).toBe("image/gif");
    expect(sniffAvatarType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffAvatarType(new Uint8Array())).toBeNull();
  });

  it("a PNG is stored at avatars/<sha256> with its type, and becomes the person's avatar", async () => {
    const cookie = await cookieFor("uploader", { avatar_url: PROVIDER });
    const bytes = PNG();
    const sha = await sha256Hex(bytes);
    const res = await upload(cookie, bytes, "image/png");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, avatar_url: `/avatar/${sha}` });
    expect((await personRow("uploader")).avatar_sha).toBe(sha);
    const obj = await env.ARTIFACTS_BUCKET.get(`avatars/${sha}`);
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
  });

  it("a declared type the bytes do not match is 400 and nothing changes", async () => {
    const cookie = await cookieFor("uploader");
    for (const [bytes, type] of [[JPEG(), "image/png"], [new TextEncoder().encode("<html>not an image</html>"), "image/png"], [PNG(), "image/webp"]] as const) {
      const res = await upload(cookie, bytes, type);
      expect(res.status).toBe(400);
    }
    expect((await personRow("uploader")).avatar_sha).toBeNull();
    expect(await env.ARTIFACTS_BUCKET.head(`avatars/${await sha256Hex(JPEG())}`)).toBeNull();
  });

  it("a type outside AVATAR_TYPES is 400; an empty or missing file is 400; not multipart is 400", async () => {
    const cookie = await cookieFor("uploader");
    expect((await upload(cookie, new TextEncoder().encode("<svg/>"), "image/svg+xml")).status).toBe(400);
    expect((await upload(cookie, new Uint8Array(), "image/png")).status).toBe(400);
    const noFile = new FormData();
    noFile.append("other", "x");
    expect((await app.request("/api/people/me/avatar", { method: "POST", headers: { cookie }, body: noFile }, env)).status).toBe(400);
    expect((await app.request("/api/people/me/avatar", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }, env)).status).toBe(400);
  });

  it("over AVATAR_MAX_BYTES is 413", async () => {
    const cookie = await cookieFor("uploader");
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG());
    const res = await upload(cookie, big, "image/png");
    expect(res.status).toBe(413);
    expect((await personRow("uploader")).avatar_sha).toBeNull();
  });

  it("the same bytes are ONE object — a second upload (by anyone) reuses it", async () => {
    const bytes = WEBP();
    const sha = await sha256Hex(bytes);
    expect((await upload(await cookieFor("uploader"), bytes, "image/webp")).status).toBe(200);
    expect((await upload(await cookieFor("second"), bytes, "image/webp")).status).toBe(200);
    const keys = (await env.ARTIFACTS_BUCKET.list({ prefix: `avatars/${sha}` })).objects.map((o) => o.key);
    expect(keys).toEqual([`avatars/${sha}`]);
    expect((await personRow("second")).avatar_sha).toBe(sha);
  });

  it("remove clears avatar_sha — the provider picture shows again — and the bytes stay in R2", async () => {
    const cookie = await cookieFor("uploader", { avatar_url: PROVIDER });
    const bytes = GIF();
    const sha = await sha256Hex(bytes);
    await upload(cookie, bytes, "image/gif");
    const res = await app.request("/api/people/me/avatar/remove", { method: "POST", headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, avatar_url: PROVIDER });
    expect((await personRow("uploader")).avatar_sha).toBeNull();
    expect(await env.ARTIFACTS_BUCKET.head(`avatars/${sha}`)).not.toBeNull();
    expect((await get(`/avatar/${sha}`, cookie)).status).toBe(200);
  });
});

describe("GET /avatar/<sha>", () => {
  it("serves the bytes locked down: nosniff, a sandboxed default-src 'none', private + immutable", async () => {
    const cookie = await cookieFor("uploader");
    const bytes = JPEG();
    const sha = await sha256Hex(bytes);
    await upload(cookie, bytes, "image/jpeg");
    const res = await get(`/avatar/${sha}`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("404 for an unknown or malformed sha (still locked down); 401 without a session", async () => {
    const cookie = await cookieFor("uploader");
    for (const sha of ["a".repeat(64), "A".repeat(64), "abc", `${"a".repeat(63)}g`]) {
      const res = await get(`/avatar/${sha}`, cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await app.request(`/avatar/${"a".repeat(64)}`, {}, env)).status).toBe(401);
  });
});

describe("the avatar rule on every person surface", () => {
  it("/persons, /auth/me and the profile resolve an uploaded avatar over the provider picture", async () => {
    const cookie = await cookieFor("uploader", { avatar_url: PROVIDER });
    const persons = async () => ((await (await get("/persons", cookie)).json()) as { persons: PersonSummary[] }).persons.find((p) => p.handle === "uploader")!;
    const me = async () => (await (await get("/auth/me", cookie)).json()) as { avatar_url: string | null; role: string | null };
    expect((await persons()).avatar_url).toBe(PROVIDER);
    expect((await me()).avatar_url).toBe(PROVIDER);

    const sha = await sha256Hex(PNG("rule"));
    await upload(cookie, PNG("rule"), "image/png");
    expect((await persons()).avatar_url).toBe(`/avatar/${sha}`);
    expect((await me()).avatar_url).toBe(`/avatar/${sha}`);
    expect((await profileOf("uploader", cookie)).avatar_url).toBe(`/avatar/${sha}`);
  });

  it("/persons carries role (never responsibilities) and still lists no reserved handle", async () => {
    const list = ((await (await get("/persons", await cookieFor("viewer"))).json()) as { persons: PersonSummary[] }).persons;
    expect(list.find((p) => p.handle === "meilin")?.role).toBe("Product manager");
    expect(list.some((p) => p.handle === "github-webhook")).toBe(false);
    expect(list.every((p) => !("responsibilities" in p))).toBe(true);
  });

  it("/auth/me carries the person's role", async () => {
    const body = (await (await get("/auth/me", await cookieFor("AndresL230"))).json()) as { role: string | null };
    expect(body.role).toBe("Founding engineer");
  });

  it("recordSignIn refreshes the provider avatar_url and never touches avatar_sha", async () => {
    const cookie = await cookieFor("uploader", { avatar_url: PROVIDER });
    await upload(cookie, PNG("keep"), "image/png");
    const sha = await sha256Hex(PNG("keep"));
    await recordSignIn(platformCtx(), "uploader", { provider: "github", avatar_url: "https://new/picture.png", email: null });
    const row = await personRow("uploader");
    expect(row.avatar_url).toBe("https://new/picture.png");
    expect(row.avatar_sha).toBe(sha);
    expect((await (await get("/auth/me", cookie)).json() as { avatar_url: string }).avatar_url).toBe(`/avatar/${sha}`);
  });

  it("the 0036 CHECK refuses an avatar_sha that is not 64 lowercase hex", async () => {
    await seedPerson("checked");
    await expect(run(env.DB, `UPDATE persons SET avatar_sha = ? WHERE handle = 'checked'`, "A".repeat(64))).rejects.toThrow(/CHECK/);
    await expect(run(env.DB, `UPDATE persons SET avatar_sha = ? WHERE handle = 'checked'`, "abc")).rejects.toThrow(/CHECK/);
  });
});
