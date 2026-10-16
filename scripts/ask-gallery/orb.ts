// The gallery's orb runtime: the app's own thinking-orb loop (web/src/thinking-orb.ts), started for the canvases
// already in the page. Rendering an orb starts the loop in the app; the gallery's orbs were rendered at build time,
// so this asks for one (its markup is discarded) to start the same loop, and again whenever canvases are added
// (side by side, a frame). The loop paints every canvas[data-orb] in its document and reads each one's theme from
// the nearest [data-cnpy-theme]. Bundled into the gallery page and into each of its frames.
import { thinkingOrb } from "../../web/src/thinking-orb";

const kick = (): void => { thinkingOrb("working"); };
(window as unknown as { __gxOrbKick: () => void }).__gxOrbKick = kick;
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", kick, { once: true });
else kick();
