// Your own Library (0076_10_17_staging › 0084_library_prefs; docs/architecture/docs-library.md › Your own Library):
// the shared rules (the sidebar's five, pinned and hidden cards, a save's checks, A to Z placement), the cookie route
// `PUT /spaces/prefs/me` (a person's own row only, a bearer refused, every list checked), what `GET /spaces` reads
// back (archived spaces dropped), and the Library's A to Z order.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  STARTER_SPACES, SIDEBAR_SPACES_MAX, checkLibraryPrefs, libraryCards, liveLibraryPrefs, sidebarSpaces,
  type LibraryDTO, type LibraryPrefsDTO, type SpaceDTO,
} from "@shared/docs-core";
import { all } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, mintTokenFor } from "./helpers/tenant";

const OWNER = "AndresL230";     // owner of SaplingLearn (an admin)
const MEMBER = "lpcooper-arch"; // a plain member
const sp = (slug: string, name = slug) => ({ slug, name, sort_rank: null, created_at: "t" });
const library = async (cookie: string) => (await call<LibraryDTO>("GET", "/api/spaces", cookie)).json;
const save = (cookie: string, body: unknown) => call<{ ok: boolean; prefs: LibraryPrefsDTO; error?: string; field?: string; message?: string }>("PUT", "/api/spaces/prefs/me", cookie, body);
const create = (cookie: string, name: string) => call<{ space: SpaceDTO }>("POST", "/api/spaces", cookie, { name });

describe("the shared rules (shared/docs-core.ts)", () => {
  const S = ["a", "b", "c", "d", "e", "f", "g"].map((k) => sp(k));

  it("the sidebar shows the first five in the Library's order until the person picks their own, in their order", () => {
    expect(SIDEBAR_SPACES_MAX).toBe(5);
    expect(sidebarSpaces(S, null).map((s) => s.slug)).toEqual(["a", "b", "c", "d", "e"]);
    expect(sidebarSpaces(S, { sidebar: null, pinned: [], hidden: [] }).map((s) => s.slug)).toEqual(["a", "b", "c", "d", "e"]);
    expect(sidebarSpaces(S, { sidebar: ["g", "a"], pinned: [], hidden: [] }).map((s) => s.slug)).toEqual(["g", "a"]);
    expect(sidebarSpaces(S, { sidebar: [], pinned: [], hidden: [] })).toEqual([]);
    // A slug no live space has is skipped; never more than five.
    expect(sidebarSpaces(S, { sidebar: ["zz", "b", "c", "d", "e", "f", "g"], pinned: [], hidden: [] }).map((s) => s.slug)).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("Library home: pinned cards first in pinning order, then the rest in the Library's order, hidden ones apart", () => {
    const c = libraryCards(S, { sidebar: null, pinned: ["f", "b"], hidden: ["c"] });
    expect(c.pinned.map((s) => s.slug)).toEqual(["f", "b"]);
    expect(c.rest.map((s) => s.slug)).toEqual(["a", "d", "e", "g"]);
    expect(c.hidden.map((s) => s.slug)).toEqual(["c"]);
    expect(libraryCards(S, null).rest).toHaveLength(7);
  });

  it("stored prefs read back against the live spaces: unknown dropped, duplicates dropped, a hidden space never pinned, a bad value is the default", () => {
    const live = new Set(["a", "b", "c"]);
    expect(liveLibraryPrefs({ sidebar: '["a","zz","a","b"]', pinned: '["c","b"]', hidden: '["b"]' }, live)).toEqual({ sidebar: ["a", "b"], pinned: ["c"], hidden: ["b"] });
    expect(liveLibraryPrefs({ sidebar: null, pinned: "[]", hidden: "[]" }, live)).toEqual({ sidebar: null, pinned: [], hidden: [] });
    expect(liveLibraryPrefs({ sidebar: "not json", pinned: "{}", hidden: 3 }, live)).toEqual({ sidebar: [], pinned: [], hidden: [] });
  });

  it("a save is checked whole: lists of distinct live slugs, the sidebar at most five (or null), never pinned and hidden at once", () => {
    const live = new Set(["a", "b", "c", "d", "e", "f"]);
    const cur = { sidebar: null, pinned: ["a"], hidden: [] };
    expect(checkLibraryPrefs({ sidebar: ["b", "a"] }, cur, live)).toEqual({ ok: true, prefs: { sidebar: ["b", "a"], pinned: ["a"], hidden: [] } });
    expect(checkLibraryPrefs({ sidebar: null }, { ...cur, sidebar: ["a"] }, live)).toMatchObject({ ok: true, prefs: { sidebar: null } });
    expect(checkLibraryPrefs({ sidebar: ["a", "b", "c", "d", "e", "f"] }, cur, live)).toMatchObject({ ok: false, refusal: { field: "sidebar" } });
    expect(checkLibraryPrefs({ pinned: ["a", "a"] }, cur, live)).toMatchObject({ ok: false, refusal: { field: "pinned" } });
    expect(checkLibraryPrefs({ hidden: ["nope"] }, cur, live)).toMatchObject({ ok: false, refusal: { field: "hidden" } });
    expect(checkLibraryPrefs({ hidden: "a" }, cur, live)).toMatchObject({ ok: false, refusal: { field: "hidden" } });
    expect(checkLibraryPrefs({ hidden: ["a"] }, cur, live)).toMatchObject({ ok: false, refusal: { field: "pinned" } });
  });

  it("A to Z: the starter spaces are in name order", () => {
    expect(STARTER_SPACES.map((s) => s.name)).toEqual([...STARTER_SPACES.map((s) => s.name)].sort());
  });
});

describe("PUT /spaces/prefs/me and what GET /spaces reads back", () => {
  it("a member saves their OWN view; everyone else's stays the default", async () => {
    const member = await cookieFor(MEMBER);
    const owner = await cookieFor(OWNER);
    expect((await library(member)).prefs).toEqual({ sidebar: null, pinned: [], hidden: [] });
    const r = await save(member, { sidebar: ["product", "design"], pinned: ["product"], hidden: ["engineering"] });
    expect(r.status).toBe(200);
    expect(r.json.prefs).toEqual({ sidebar: ["product", "design"], pinned: ["product"], hidden: ["engineering"] });
    expect((await library(member)).prefs).toEqual({ sidebar: ["product", "design"], pinned: ["product"], hidden: ["engineering"] });
    expect((await library(owner)).prefs).toEqual({ sidebar: null, pinned: [], hidden: [] });
    // One row, keyed by the signed-in person — never by anything the body says.
    const rows = await all<{ handle: string }>(env.DB, `SELECT handle FROM library_prefs WHERE org_id = ?`, ORG_A);
    expect(rows.map((x) => x.handle)).toEqual([MEMBER]);
    // A list left out keeps what was saved; null puts the sidebar back to the default.
    expect((await save(member, { sidebar: null })).json.prefs).toEqual({ sidebar: null, pinned: ["product"], hidden: ["engineering"] });
  });

  it("refuses what the rules refuse, in words, and writes nothing", async () => {
    const member = await cookieFor(MEMBER);
    for (const [body, field] of [
      [{ sidebar: ["design", "design"] }, "sidebar"], [{ sidebar: ["nowhere"] }, "sidebar"], [{ pinned: "design" }, "pinned"],
      [{ pinned: ["design"], hidden: ["design"] }, "pinned"],
    ] as const) {
      const r = await save(member, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toMatchObject({ error: "invalid", field });
      expect(r.json.message).toBeTruthy();
    }
    expect(await all(env.DB, `SELECT handle FROM library_prefs WHERE org_id = ?`, ORG_A)).toEqual([]);
  });

  it("more than five sidebar spaces is refused; an archived space drops out of what reads back", async () => {
    const owner = await cookieFor(OWNER);
    for (const n of ["Security", "Onboarding", "Research"]) expect((await create(owner, n)).status).toBe(201);
    const six = ["design", "engineering", "onboarding", "product", "research", "security"];
    expect((await save(owner, { sidebar: six })).json).toMatchObject({ error: "invalid", field: "sidebar" });
    expect((await save(owner, { sidebar: six.slice(0, 5), pinned: ["security"] })).status).toBe(200);
    expect((await call("POST", "/api/spaces/research/archive", owner, {})).status).toBe(200);
    expect((await call("POST", "/api/spaces/security/archive", owner, {})).status).toBe(200);
    expect((await library(owner)).prefs).toEqual({ sidebar: ["design", "engineering", "onboarding", "product"], pinned: [], hidden: [] });
  });

  it("is a person's, never a token's: a request with a bearer is refused", async () => {
    const member = await cookieFor(MEMBER);
    const { raw } = await mintTokenFor(MEMBER);
    const r = await call("PUT", "/api/spaces/prefs/me", member, { sidebar: ["design"] }, { headers: { authorization: `Bearer ${raw}` } });
    expect(r.status).toBe(403);
    expect(await all(env.DB, `SELECT handle FROM library_prefs`)).toEqual([]);
  });

  it("a new space lands in A to Z order among the starter spaces", async () => {
    const owner = await cookieFor(OWNER);
    expect((await library(owner)).spaces.map((s) => s.slug)).toEqual(["design", "engineering", "product"]);
    for (const n of ["Security", "Analytics", "Finance"]) expect((await create(owner, n)).status).toBe(201);
    expect((await library(owner)).spaces.map((s) => s.slug)).toEqual(["analytics", "design", "engineering", "finance", "product", "security"]);
  });
});
