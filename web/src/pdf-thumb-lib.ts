// pdf.js, for the Artifacts library's PDF cards (artifacts-state.ts `renderPendingPdfThumbs`). Its own chunk:
// only `import()`ed the first time a PDF card is painted, never in the main bundle. The worker is pdf.js's own
// file, emitted by Vite beside the chunk on Trov's origin (`?url`); no CDN is contacted.

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Draw page 1 of a PDF `width` pixels wide and return it as an image. Throws when the file can't be drawn. */
export async function pdfFirstPage(bytes: ArrayBuffer, width: number): Promise<Blob> {
  // No XFA forms, no scripting: a thumbnail is the page's paint and nothing else.
  const task = getDocument({ data: new Uint8Array(bytes), enableXfa: false, stopAtErrors: false });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    return await new Promise<Blob>((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob"))), "image/webp", 0.86));
  } finally {
    void task.destroy();
  }
}
