// The DOM half of the Monthly / Yearly switch (web/src/pricing.ts). The switch itself is
// two native radios and CSS; a render makes fresh radios, so this remembers the visitor's
// choice and checks it again. Run after every paint of a root that may hold the switch.

let interval: "month" | "year" = "month";
const bound = new WeakSet<ParentNode>();

export function mountPricing(root: ParentNode): void {
  if (interval === "year") {
    const yearly = root.querySelector<HTMLInputElement>('input[name="site-interval"][value="year"]');
    if (yearly) yearly.checked = true;
  }
  if (bound.has(root)) return;
  bound.add(root);
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.name === "site-interval" && t.checked) interval = t.value === "year" ? "year" : "month";
  });
}
