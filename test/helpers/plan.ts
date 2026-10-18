// A plan write's narrative as a test gives it: three parts, Now / Next / Later (shared/sprints-core › the plan
// narrative's shape — enforced at write, so a free-text `narrative` is refused). `narr("Ship it")` is the input;
// `narrText("Ship it")` is what `write_plan` stores for it.
import { composePlanNarrative, type PlanNarrativeParts } from "@shared/sprints-core";

export const narr = (now = "n", next = "Next.", later = "Later."): PlanNarrativeParts => ({ now, next, later });
export const narrText = (now = "n", next = "Next.", later = "Later."): string => composePlanNarrative(narr(now, next, later));
