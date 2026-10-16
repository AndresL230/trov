// SECTION ISOLATION (docs/architecture/ai.md › Sections): a producer's answer is validated ONE SECTION AT A TIME,
// so a bad section is dropped and the rest of the call still writes. A "section" is one top-level field of the
// answer, or one item of a list of them (a Haiku card call answers up to 20 items: one bad item must not cost the
// other 19).
//
//   const Answer = sections({ now: NowSchema, recently: RecentSchema });      // fields
//   const Cards  = sections({ items: z.array(each(CardSchema)).max(20) });   // items
//   …provider.structured({ schema: Answer, … })
//   const { kept, dropped } = keep(value)  // `kept` has only the valid sections / items
//
// How: each section is `.catch(DROPPED)`, so the client's one `safeParse` (src/ai/client.ts) never fails because of
// one section — it puts the marker in its place, and `keep` takes the markers out. The JSON Schema the model is
// constrained by is the sections' own (zod emits a `.catch`'s inner schema), so the model is asked for exactly the
// strict shape; only Trov's check is per section.
import { z } from "zod";

/** What a section that failed its check becomes until `keep` drops it. */
export const DROPPED: unique symbol = Symbol("ai.section.dropped");
type Dropped = typeof DROPPED;

/** One section: its own check, with a failure dropped instead of failing the whole answer. */
export function each<T extends z.ZodType>(schema: T): z.ZodCatch<T> {
  return schema.catch(DROPPED as unknown as z.output<T>);
}

/** An answer of named sections, each checked on its own. */
export function sections<S extends Record<string, z.ZodType>>(shape: S): z.ZodObject<{ [K in keyof S]: z.ZodCatch<S[K]> }> {
  return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, each(v)])) as { [K in keyof S]: z.ZodCatch<S[K]> });
}

/** The answer with every dropped section (and dropped list item) taken out, and how many were. A dropped
 *  top-level section is left out of `kept` (its key is missing — never a guessed default). */
export function keep<T extends Record<string, unknown>>(value: T): { kept: Partial<T>; dropped: number } {
  let dropped = 0;
  const kept: Partial<T> = {};
  for (const [k, v] of Object.entries(value) as [keyof T, unknown][]) {
    if (v === DROPPED) { dropped++; continue; }
    if (Array.isArray(v)) {
      const items = v.filter((x) => x !== DROPPED);
      dropped += v.length - items.length;
      kept[k] = items as T[keyof T];
    } else kept[k] = v as T[keyof T];
  }
  return { kept, dropped };
}

/** Whether a value is the dropped marker (for a producer walking its own shape). */
export const isDropped = (v: unknown): v is Dropped => v === DROPPED;
