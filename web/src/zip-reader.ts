// A small zip reader for the Docs Library import — no dependency. The browser unpacks a dropped .zip for the
// Preview (the Worker never unzips; it re-validates the files it is sent). It runs anywhere with
// `DecompressionStream("deflate-raw")`: browsers, the Worker runtime, Node 18+.
//
// What it reads: the central directory (the zip's own index, at its end) of a classic zip, entries STORED
// (method 0) or DEFLATED (method 8). Anything else — zip64, encryption, split archives, other methods, an
// index that does not add up — is refused as "damaged or unsupported", never guessed at.
//
// Zip-bomb guard: the declared sizes are checked against the caps BEFORE anything is inflated, and each
// entry is inflated as a stream that stops the moment it passes its declared size (a lying header cannot
// make it allocate more), then checked against its CRC-32.

import { MAX_FILES, MAX_TOTAL_BYTES } from "@shared/docs-import-core";

export const ZIP_DAMAGED_MESSAGE = "This zip is damaged or unsupported.";

export type ZipErrorCode = "damaged" | "unsupported" | "too_many_files" | "too_large";

export class ZipError extends Error {
  constructor(public code: ZipErrorCode, message: string = code === "damaged" || code === "unsupported" ? ZIP_DAMAGED_MESSAGE : code) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** The name as stored (UTF-8 when the zip says so, else CP437), `/`-separated. */
  name: string;
  /** Directory entries end in `/` and hold no data. */
  isDirectory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Offset of the entry's local header. */
  offset: number;
  flags: number;
}

export interface ZipCaps {
  maxFiles?: number;
  maxTotalBytes?: number;
}

type Source = ArrayBuffer | Uint8Array | Blob;

interface RangeReader {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

function rangeReader(src: Source): RangeReader {
  if (src instanceof Uint8Array) return { size: src.byteLength, read: async (s, e) => src.subarray(s, e) };
  if (src instanceof ArrayBuffer) { const u = new Uint8Array(src); return { size: u.byteLength, read: async (s, e) => u.subarray(s, e) }; }
  return { size: src.size, read: async (s, e) => new Uint8Array(await src.slice(s, e).arrayBuffer()) };
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// CP437, the DOS code page old zip tools wrote names in: 0x80–0xFF.
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder("utf-8").decode(bytes);
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

let CRC_TABLE: Uint32Array | null = null;
/** CRC-32 (the zip polynomial), continuing from `crc` for a streamed input. */
export function crc32(data: Uint8Array, crc = 0): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Find and read the central directory. Refuses zip64, multi-disk and inconsistent indexes. */
async function readDirectory(r: RangeReader): Promise<ZipEntry[]> {
  if (r.size < 22) throw new ZipError("damaged");
  const tailStart = Math.max(0, r.size - (22 + 0xffff));
  const tail = await r.read(tailStart, r.size);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD && i + 22 + u16(tail, i + 20) <= tail.length) { at = i; break; }
  }
  if (at < 0) throw new ZipError("damaged");
  if (at >= 20 && u32(tail, at - 20) === SIG_EOCD64_LOCATOR) throw new ZipError("unsupported");
  const disk = u16(tail, at + 4), cdDisk = u16(tail, at + 6);
  const onDisk = u16(tail, at + 8), total = u16(tail, at + 10);
  const cdSize = u32(tail, at + 12), cdOffset = u32(tail, at + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("unsupported");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError("unsupported");
  const eocdAbs = tailStart + at;
  if (cdOffset + cdSize > eocdAbs) throw new ZipError("damaged");
  const cd = await r.read(cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== SIG_CENTRAL) throw new ZipError("damaged");
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const crc = u32(cd, p + 16);
    const compressedSize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const startDisk = u16(cd, p + 34);
    const offset = u32(cd, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError("damaged");
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff || startDisk === 0xffff) throw new ZipError("unsupported");
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0).replace(/\\/g, "/");
    const isDirectory = name.endsWith("/");
    if (!isDirectory) {
      if (flags & 0x0001 || flags & 0x0040) throw new ZipError("unsupported");    // encrypted / strong encryption
      if (method !== 0 && method !== 8) throw new ZipError("unsupported");
      if (method === 0 && compressedSize !== size) throw new ZipError("damaged");
      if (offset + 30 + compressedSize > eocdAbs) throw new ZipError("damaged");
    }
    entries.push({ name, isDirectory, method, compressedSize, size, crc32: crc, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export interface OpenZip {
  /** Every entry, directories included, in the zip's order. */
  entries: ZipEntry[];
  /** The files only (no directories). */
  files: ZipEntry[];
  /** Sum of the files' declared uncompressed sizes. */
  totalBytes: number;
  /** One file's bytes, inflated, size- and CRC-checked. */
  read(entry: ZipEntry): Promise<Uint8Array>;
}

/**
 * Open a zip: read its index and check the caps (500 files, 50 MB uncompressed by default) BEFORE inflating
 * anything. Throws `ZipError` — `too_many_files` / `too_large` for the caps, `damaged` / `unsupported`
 * (both shown as "damaged or unsupported zip") for the rest.
 */
export async function openZip(src: Source, caps: ZipCaps = {}): Promise<OpenZip> {
  const r = rangeReader(src);
  const entries = await readDirectory(r);
  const files = entries.filter((e) => !e.isDirectory);
  const maxFiles = caps.maxFiles ?? MAX_FILES;
  const maxTotal = caps.maxTotalBytes ?? MAX_TOTAL_BYTES;
  if (files.length > maxFiles) throw new ZipError("too_many_files");
  const totalBytes = files.reduce((s, e) => s + e.size, 0);
  if (totalBytes > maxTotal) throw new ZipError("too_large");
  let inflated = 0;   // across every read: the running total can never pass the cap either
  return {
    entries, files, totalBytes,
    async read(entry: ZipEntry): Promise<Uint8Array> {
      if (entry.isDirectory) return new Uint8Array(0);
      const head = await r.read(entry.offset, entry.offset + 30);
      if (head.length < 30 || u32(head, 0) !== SIG_LOCAL) throw new ZipError("damaged");
      const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
      const raw = await r.read(start, start + entry.compressedSize);
      if (raw.length !== entry.compressedSize) throw new ZipError("damaged");
      const out = entry.method === 0 ? raw.slice() : await inflate(raw, entry.size);
      if (out.length !== entry.size || crc32(out) !== entry.crc32) throw new ZipError("damaged");
      inflated += out.length;
      if (inflated > maxTotal) throw new ZipError("too_large");
      return out;
    },
  };
}

/** Inflate raw deflate, refusing the moment the output passes `limit` bytes. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new ZipError("unsupported");
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Every promise a corrupt stream rejects is handled here; the read loop below reports the failure.
  writer.closed.catch(() => {});
  reader.closed.catch(() => {});
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); throw new ZipError("damaged"); }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError("damaged");
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** Decode a file's bytes as UTF-8 text, or null when they are not valid UTF-8 (a BOM is dropped). */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}
