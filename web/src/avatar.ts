// Settings › Profile's photo upload, before the bytes leave the browser: the picked image is
// centre-cropped to a square, drawn at most AVATAR_SIDE px wide on a canvas, and encoded as
// WebP (PNG where the browser cannot encode WebP). The Worker still checks the type and
// `AVATAR_MAX_BYTES` (shared/people.ts); the client checks them first so a refusal is
// immediate and in plain words. `avatarCrop` is pure (unit-tested); `prepareAvatar` needs a DOM.

import { AVATAR_MAX_BYTES, AVATAR_TYPES } from "@shared/people";

/** The longest side an uploaded avatar is stored at — the largest chip draws 88px, so 512
 *  covers every retina size with room to spare. */
export const AVATAR_SIDE = 512;

/** The square to cut from a `w`×`h` image (centred) and the side it is drawn at. */
export function avatarCrop(w: number, h: number, max = AVATAR_SIDE): { sx: number; sy: number; side: number; out: number } {
  const side = Math.max(1, Math.min(w, h));
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side, out: Math.max(1, Math.min(max, side)) };
}

/** Why a picked file can't be a photo (a type the Worker refuses), or null. */
export function avatarTypeProblem(type: string): string | null {
  return (AVATAR_TYPES as readonly string[]).includes(type) ? null : "Pick a PNG, JPEG, WebP or GIF image.";
}

/** Why an encoded photo is still too big, or null. */
export function avatarSizeProblem(bytes: number): string | null {
  return bytes <= AVATAR_MAX_BYTES ? null : `That photo is over ${Math.round(AVATAR_MAX_BYTES / (1024 * 1024))} MB even after resizing — try a smaller one.`;
}

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    return { img: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error("decode")); img.src = url; });
  return { img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

const toBlob = (c: HTMLCanvasElement, type: string): Promise<Blob | null> =>
  new Promise((ok) => c.toBlob((b) => ok(b), type, 0.9));

/** The picked file as the square photo to upload, with a filename to send it under. Throws
 *  an Error whose message is shown as-is (a refused type, an unreadable image, too big). */
export async function prepareAvatar(file: File): Promise<{ blob: Blob; filename: string }> {
  const typeProblem = avatarTypeProblem(file.type);
  if (typeProblem) throw new Error(typeProblem);
  let src: Awaited<ReturnType<typeof decode>>;
  try { src = await decode(file); } catch { throw new Error("Couldn't read that image."); }
  try {
    const { sx, sy, side, out } = avatarCrop(src.w, src.h);
    const canvas = document.createElement("canvas");
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't read that image.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src.img, sx, sy, side, side, 0, 0, out, out);
    // A browser that can't encode WebP hands back a PNG for the request — so check the type.
    let blob = await toBlob(canvas, "image/webp");
    if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/png");
    if (!blob) throw new Error("Couldn't read that image.");
    const sizeProblem = avatarSizeProblem(blob.size);
    if (sizeProblem) throw new Error(sizeProblem);
    return { blob, filename: blob.type === "image/webp" ? "avatar.webp" : "avatar.png" };
  } finally {
    src.done();
  }
}
