import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import type { PersonRow } from "@shared/rows";

const put = (path: string, cookie: string, body: unknown) => app.request(path, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const post = (path: string, cookie: string) => app.request(path, { method: "POST", headers: { cookie } }, env);

describe("PUT /auth/me", () => {
  it("updates name and color for the caller only; 400 on a bad color", async () => {
    const c = await cookieFor("AndresL230");
    const res = await put("/auth/me", c, { name: "Andrés", color: "rose" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Andrés", color: "rose" });
    const row = (await first<PersonRow>(env.DB, `SELECT * FROM persons WHERE handle = 'AndresL230'`))!;
    expect(row.name).toBe("Andrés"); expect(row.color).toBe("rose");
    expect((await put("/auth/me", c, { color: "neon" })).status).toBe(400);
    expect((await put("/auth/me", "", { color: "moss" })).status).toBe(401);
  });
  it("GET /auth/me reflects color and identities", async () => {
    const c = await cookieFor("AndresL230");
    await run(env.DB, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-1', 'a@b.c', 'AndresL230', 't', 'AndresL230')`);
    const me = await (await app.request("/auth/me", { headers: { cookie: c } }, env)).json() as { handle: string; color: string; identities: { provider: string; label: string }[] };
    expect(me.handle).toBe("AndresL230");
    expect(me.color).toBe("moss");
    expect(me.identities.map((i) => i.provider).sort()).toEqual(["github", "google"]);
  });
});

describe("POST /auth/identities/:provider/unlink", () => {
  it("409 on the last identity, 200 when another remains, 404 when not linked, 400 on an unknown provider", async () => {
    const c = await cookieFor("AndresL230");
    expect((await post("/auth/identities/github/unlink", c)).status).toBe(409);
    await run(env.DB, `INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'g-1', 'a@b.c', 'AndresL230', 't', 'AndresL230')`);
    expect((await post("/auth/identities/google/unlink", c)).status).toBe(200);
    expect(await first(env.DB, `SELECT 1 AS x FROM identities WHERE subject = 'g-1'`)).toBeNull();
    expect((await post("/auth/identities/google/unlink", c)).status).toBe(404);
    expect((await post("/auth/identities/twitter/unlink", c)).status).toBe(400);
  });
});
