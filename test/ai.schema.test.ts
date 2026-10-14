// toClaudeSchema (src/ai/schema.ts): a zod schema's JSON Schema, made acceptable to structured outputs —
// no keyword the API rejects anywhere, every object closed, the input untouched.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toClaudeSchema } from "../src/ai/schema";
import { IssueSummarySchema, PrSummarySchema } from "../src/tools/summarize";

const REJECTED = ["$schema", "maxLength", "minLength", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];

/** Every node of a JSON value that is an object, with the key path that reached it. */
function nodes(v: unknown, path = "$"): { path: string; node: Record<string, unknown> }[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => nodes(x, `${path}[${i}]`));
  if (v === null || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  return [{ path, node: o }, ...Object.entries(o).flatMap(([k, x]) => nodes(x, `${path}.${k}`))];
}

/** A schema node (not a `properties` / `$defs` map): one with a `type` or a combinator. */
const isSchema = (n: Record<string, unknown>) => "type" in n || "anyOf" in n || "allOf" in n || "$ref" in n;

// Everything the API rejects, nested every way zod nests it.
const Kitchen = z.object({
  name: z.string().min(2).max(80),
  count: z.number().int().min(0).max(10),
  ratio: z.number().gt(0).lt(1),
  tags: z.array(z.string().max(20)).min(1).max(5),
  pairs: z.array(z.object({ k: z.string().min(1), v: z.number().max(3) })).min(2),
  maybe: z.object({ inner: z.string().max(4) }).nullable(),
  choice: z.union([z.object({ a: z.string().max(2) }), z.object({ b: z.array(z.string()).min(0) })]),
  kind: z.enum(["one", "two"]),
});

describe("toClaudeSchema", () => {
  const input = z.toJSONSchema(Kitchen, { io: "input" }) as Record<string, unknown>;

  it("zod's own output carries the rejected keywords (so the strip below is doing work)", () => {
    const text = JSON.stringify(input);
    for (const k of ["$schema", "maxLength", "minLength", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) expect(text, k).toContain(`"${k}"`);
  });

  it("leaves no rejected keyword anywhere, and closes every object — nested, in items, in anyOf", () => {
    const out = toClaudeSchema(input);
    for (const { path, node } of nodes(out)) {
      if (!isSchema(node)) continue;
      for (const k of REJECTED) expect(Object.keys(node), `${path} has ${k}`).not.toContain(k);
      if (node.type === "object") expect(node.additionalProperties, path).toBe(false);
    }
    const objects = nodes(out).filter(({ node }) => node.type === "object");
    expect(objects.length).toBe(5); // the root, a pair (in items), maybe (in anyOf), the union's two members
  });

  it("keeps minItems 0 and 1, strips 2 and up", () => {
    const out = toClaudeSchema(input) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.tags.minItems).toBe(1);
    expect(out.properties.pairs.minItems).toBeUndefined();
    const b = (out.properties.choice.anyOf as { properties: Record<string, Record<string, unknown>> }[])[1].properties.b;
    expect(b.minItems).toBe(0);
  });

  it("closes an object zod left open, and keeps enums, required and property NAMES that look like keywords", () => {
    const raw = {
      type: "object",
      properties: { maxLength: { type: "string", maxLength: 3 }, inner: { type: "object", properties: {} } },
      required: ["maxLength"],
      $defs: { thing: { type: "object", additionalProperties: true, properties: { x: { type: "integer", minimum: 1 } } } },
      additionalProperties: true,
    };
    const out = toClaudeSchema(raw) as typeof raw;
    expect(out).toEqual({
      type: "object",
      properties: { maxLength: { type: "string" }, inner: { type: "object", properties: {}, additionalProperties: false } },
      required: ["maxLength"],
      $defs: { thing: { type: "object", additionalProperties: false, properties: { x: { type: "integer" } } } },
      additionalProperties: false,
    });
    const kind = (toClaudeSchema(input) as { properties: Record<string, Record<string, unknown>> }).properties.kind;
    expect(kind.enum).toEqual(["one", "two"]);
  });

  it("is pure: the input is not mutated and shares no node with the answer", () => {
    const before = structuredClone(input);
    const out = toClaudeSchema(input);
    expect(input).toEqual(before);
    const inNodes = new Set(nodes(input).map((n) => n.node));
    expect(nodes(out).some(({ node }) => inNodes.has(node))).toBe(false);
  });

  it("the summary schemas come out closed, all four (three) fields required, nullable as anyOf with null", () => {
    const pr = toClaudeSchema(z.toJSONSchema(PrSummarySchema, { io: "input" }) as Record<string, unknown>);
    expect(pr).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        what: { type: "string" },
        why: { anyOf: [{ type: "string" }, { type: "null" }] },
        impact: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["title", "what", "why", "impact"],
      additionalProperties: false,
    });
    const issue = toClaudeSchema(z.toJSONSchema(IssueSummarySchema, { io: "input" }) as Record<string, unknown>);
    expect(issue).toMatchObject({ type: "object", required: ["title", "summary", "next_step"], additionalProperties: false });
  });
});
