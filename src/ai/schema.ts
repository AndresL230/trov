// A zod schema's JSON Schema (`z.toJSONSchema`), made acceptable to Claude's structured outputs
// (`output_config.format`, src/ai/client.ts).
//
// The API compiles the schema into a grammar and rejects keywords it cannot enforce: string lengths,
// numeric bounds, and array sizes other than "at least 0 / at least 1". Those are stripped here and the
// SAME zod schema checks them after the parse, so a cap still holds — it is just enforced on our side.
// Every object also has to say `additionalProperties: false`; zod emits it for `z.object`, and this sets
// it on every object node anyway (nested, inside `items`, `anyOf`, `properties`, `$defs`), so a schema
// built some other way cannot slip through open.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Dropped wherever they appear as a schema keyword. */
const STRIPPED = new Set([
  "$schema", "maxLength", "minLength", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);

/** Keys whose value is a map of name → schema (not a schema itself). */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties"]);
/** Keys whose value is data (copied as it is, never read as a schema). */
const LITERALS = new Set(["enum", "const", "default", "examples"]);

/** `jsonSchema` with every keyword the API rejects removed and every object closed. Pure: the input is
 *  never mutated, and the answer shares no node with it. */
export function toClaudeSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  return walk(jsonSchema as Json) as Record<string, unknown>;
}

function walk(node: Json): Json {
  if (Array.isArray(node)) return node.map(walk);
  if (node === null || typeof node !== "object") return node;
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED.has(key)) continue;
    // "At least one" is enforceable; any other lower bound is not.
    if (key === "minItems" && value !== 0 && value !== 1) continue;
    if (LITERALS.has(key)) {
      out[key] = structuredClone(value);
    } else if (SCHEMA_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub)]));
    } else {
      out[key] = walk(value);
    }
  }
  if (isObjectType(out.type)) out.additionalProperties = false;
  return out;
}

function isObjectType(type: Json | undefined): boolean {
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}
