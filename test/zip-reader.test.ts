import { describe, it, expect } from "vitest";
import { openZip, crc32, utf8Text, ZipError, ZIP_DAMAGED_MESSAGE } from "../web/src/zip-reader";

// The browser's zip reader — pure, no network. Zips are built here by a tiny writer (stored entries, or
// deflated with CompressionStream("deflate-raw")), so every header field a test breaks is one it wrote.

interface In { name: string; data?: Uint8Array | string; method?: 0 | 8; utf8?: boolean; rawName?: Uint8Array; flags?: number; lieSize?: number }

const enc = new TextEncoder();
const bytes = (d: Uint8Array | string | undefined) => (typeof d === "string" ? enc.encode(d) : d ?? new Uint8Array(0));

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  w.write(data as Uint8Array<ArrayBuffer>);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Build a classic zip. `mutate` may edit the finished bytes (offsets: see the returned map). */
async function makeZip(items: In[], opts: { zip64Locator?: boolean } = {}): Promise<{ zip: Uint8Array; central: number; eocd: number }> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const it of items) {
    const data = bytes(it.data);
    const method = it.method ?? 0;
    const comp = method === 8 ? await deflateRaw(data) : data;
    const name = it.rawName ?? enc.encode(it.name);
    const flags = (it.flags ?? 0) | (it.utf8 ? 0x0800 : 0);
    const crc = crc32(data);
    const size = it.lieSize ?? data.length;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true); cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, comp);
    centrals.push(ch);
    offset += lh.length + comp.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const locator = opts.zip64Locator ? new Uint8Array(20) : new Uint8Array(0);
  if (opts.zip64Locator) new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, locator, eocd];
  const zip = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { zip.set(p, o); o += p.length; }
  return { zip, central: offset, eocd: zip.length - 22 };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; return "resolved"; } catch (e) { return e instanceof ZipError ? e.code : `other: ${String(e)}`; }
}

describe("zip reader", () => {
  it("lists entries and reads stored and deflated files", async () => {
    const md = "# Hello\n\n" + "Some text. ".repeat(200);
    const { zip } = await makeZip([
      { name: "handbook/" },
      { name: "handbook/README.md", data: md, method: 8 },
      { name: "handbook/raw.md", data: "stored body", method: 0 },
      { name: "handbook/empty.md", data: "" },
    ]);
    const z = await openZip(zip);
    expect(z.entries.map((e) => [e.name, e.isDirectory, e.method])).toEqual([
      ["handbook/", true, 0], ["handbook/README.md", false, 8], ["handbook/raw.md", false, 0], ["handbook/empty.md", false, 0],
    ]);
    expect(z.files.map((e) => e.name)).toEqual(["handbook/README.md", "handbook/raw.md", "handbook/empty.md"]);
    expect(z.totalBytes).toBe(md.length + "stored body".length);
    expect(z.files[0].compressedSize).toBeLessThan(md.length);
    expect(utf8Text(await z.read(z.files[0]))).toBe(md);
    expect(utf8Text(await z.read(z.files[1]))).toBe("stored body");
    expect((await z.read(z.files[2])).length).toBe(0);
  });

  it("reads from a Blob and an ArrayBuffer too", async () => {
    const { zip } = await makeZip([{ name: "a.md", data: "aaa", method: 8 }]);
    for (const src of [new Blob([zip as Uint8Array<ArrayBuffer>]), zip.buffer.slice(0) as ArrayBuffer]) {
      const z = await openZip(src);
      expect(utf8Text(await z.read(z.files[0]))).toBe("aaa");
    }
  });

  it("decodes names as UTF-8 when flagged, else CP437", async () => {
    const { zip } = await makeZip([
      { name: "café.md", utf8: true, data: "x" },
      { name: "", rawName: new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2e, 0x6d, 0x64]), data: "y" },   // "caf" + CP437 é + ".md"
      { name: "", rawName: new Uint8Array([0x81, 0xe1, 0xff]), data: "z" },
    ]);
    const z = await openZip(zip);
    expect(z.files.map((e) => e.name)).toEqual(["café.md", "café.md", "üß "]);
  });

  it("refuses zip64, encryption, other methods and broken indexes as damaged or unsupported", async () => {
    const enc1 = await makeZip([{ name: "a.md", data: "x", flags: 0x0001 }]);
    expect(await refusal(openZip(enc1.zip))).toBe("unsupported");
    const bz = await makeZip([{ name: "a.md", data: "x" }]);
    new DataView(bz.zip.buffer).setUint16(bz.central + 10, 12, true);          // method 12 (bzip2)
    expect(await refusal(openZip(bz.zip))).toBe("unsupported");
    const z64 = await makeZip([{ name: "a.md", data: "x" }], { zip64Locator: true });
    expect(await refusal(openZip(z64.zip))).toBe("unsupported");
    const ff = await makeZip([{ name: "a.md", data: "x" }]);
    new DataView(ff.zip.buffer).setUint32(ff.central + 24, 0xffffffff, true);   // zip64 size marker
    expect(await refusal(openZip(ff.zip))).toBe("unsupported");
    expect(await refusal(openZip(new Uint8Array(10)))).toBe("damaged");
    expect(await refusal(openZip(enc.encode("not a zip at all, just some text that is long enough")))).toBe("damaged");
    const cut = await makeZip([{ name: "a.md", data: "x" }]);
    new DataView(cut.zip.buffer).setUint32(cut.eocd + 16, cut.central + 5, true);  // index offset points nowhere
    expect(await refusal(openZip(cut.zip))).toBe("damaged");
    expect(new ZipError("unsupported").message).toBe(ZIP_DAMAGED_MESSAGE);
  });

  it("checks the declared caps BEFORE inflating anything", async () => {
    const { zip } = await makeZip([{ name: "a.md", data: "12345" }, { name: "b.md", data: "67890" }]);
    expect(await refusal(openZip(zip, { maxFiles: 1 }))).toBe("too_many_files");
    expect(await refusal(openZip(zip, { maxTotalBytes: 9 }))).toBe("too_large");
    expect(await refusal(openZip(zip, { maxFiles: 2, maxTotalBytes: 10 }))).toBe("resolved");
    const bomb = await makeZip([{ name: "bomb.md", data: "0".repeat(1024 * 1024), method: 8, lieSize: 100 }]);
    const z = await openZip(bomb.zip, { maxTotalBytes: 1000 });                  // the header lies: 100 bytes
    expect(await refusal(z.read(z.files[0]))).toBe("damaged");                  // stopped at 101, never 1 MB
  });

  // A body whose bytes don't match its CRC is damaged. (A deflate stream that is itself corrupt is not fed
  // to DecompressionStream here: workerd, which runs this suite, reports that failure as an unhandled
  // rejection from inside the runtime even though the reader's rejection is handled — browsers and Node
  // don't. The reader maps any inflate failure to "damaged".)
  it("a corrupted body fails its CRC", async () => {
    const stored = await makeZip([{ name: "a.md", data: "hello world" }]);
    stored.zip[30 + "a.md".length] ^= 0xff;
    const z1 = await openZip(stored.zip);
    expect(await refusal(z1.read(z1.files[0]))).toBe("damaged");
    const deflated = await makeZip([{ name: "b.md", data: "hello hello hello hello", method: 8 }]);
    const dv = new DataView(deflated.zip.buffer);
    dv.setUint32(deflated.central + 16, dv.getUint32(deflated.central + 16, true) ^ 1, true);   // the index's CRC
    const z2 = await openZip(deflated.zip);
    expect(await refusal(z2.read(z2.files[0]))).toBe("damaged");
  });

  it("utf8Text refuses invalid UTF-8 and drops a BOM; crc32 is the zip CRC", () => {
    expect(utf8Text(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
    expect(utf8Text(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
});
