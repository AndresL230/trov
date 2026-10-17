// The big-screen zoom, installed (zoom.ts). Every page's boot script imports this FIRST, so the zoom is applied
// and measured before any other module runs and its `resize` listener precedes every other one.
import { installUiZoom } from "./zoom";

if (typeof window !== "undefined") installUiZoom(window);
