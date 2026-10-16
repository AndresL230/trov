// The app's lazy chunks (web-ui.md › The app's bundles), handed in as if they had loaded: a test that
// draws a lazy screen through render() calls `loadWebChunks()` at its top, and the screen renders
// itself instead of its skeleton. (A test of one screen imports its module directly and needs none.)
import { platformChunk } from "../../web/src/platform-lazy";
import * as platformChunkModule from "../../web/src/platform-chunk";
import { artifactsChunk } from "../../web/src/artifacts-lazy";
import * as artifactsModule from "../../web/src/artifacts";

export function loadWebChunks(): void {
  platformChunk.set(platformChunkModule);
  artifactsChunk.set(artifactsModule);
}
