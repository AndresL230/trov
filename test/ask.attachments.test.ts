// Ask Trov's attachments (src/ai/ask/attachments.ts; docs/architecture/ask.md › Attachments): stored as PRIVATE
// artifacts on attach, BEFORE the model sees them — what the model gets is read back from the artifacts store; the
// 10 MB cap holds server-side; a file goes whole only in its own turn; `read_attachment` reads only this person's
// thread's own.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A } from "./helpers/tenant";
import { BASE, KEYED, ask, eventsOf, fakeModel, threadOf, withAsk } from "./helpers/ask";
import { app } from "../src/routes";
import { imageSize } from "../src/ai/ask/attachments";
import { AskEventSchemas } from "@shared/ai-ask";

const ME = "ask-attacher";
const final = "\n<trov-meta>{\"title\": \"Files\", \"followups\": []}</trov-meta>";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

async function upload(cookie: string, files: { name: string; type: string; bytes: Uint8Array }[], threadId?: number) {
  const form = new FormData();
  for (const f of files) form.append("file", new File([f.bytes], f.name, { type: f.type }));
  if (threadId) form.append("threadId", String(threadId));
  const res = await app.request(`${BASE}/ask/attachments`, { method: "POST", headers: { cookie }, body: form }, KEYED);
  return { status: res.status, json: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
type Block = { type: string; text?: string; source?: { data: string; media_type: string } };
const firstUserBlocks = (req: { messages: { role: string; content: unknown }[] }): Block[] => req.messages.at(-1)!.content as Block[];

describe("attachments are artifacts first", () => {
  it("upload stores each file as a PRIVATE artifact of the person, linked to the thread, not sent yet", async () => {
    // (With no thread yet the link is PENDING, on the person's hidden holder — Q60, test/ask.rulings.test.ts.)
    const cookie = await cookieFor(ME);
    const r = await upload(cookie, [{ name: "ci-failure.png", type: "image/png", bytes: PNG }, { name: "notes.md", type: "text/markdown", bytes: new TextEncoder().encode("# Notes\n\nthe connect test") }]);
    expect(r.status).toBe(200);
    expect(r.json.attachments.map((a: { kind: string }) => a.kind)).toEqual(["image", "text"]);
    expect(r.json.attachments[0].thumbUrl).toMatch(/^\/api\/o\/saplinglearn\/raw\/a\//);
    const pages = await all<{ visibility: string; author_id: string; kind: string }>(env.DB, `SELECT visibility, author_id, kind FROM artifact_pages WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(pages).toEqual([{ visibility: "private", author_id: ME, kind: "image" }, { visibility: "private", author_id: ME, kind: "markdown" }]);
    const links = await all<{ thread_id: number; message_id: number | null }>(env.DB, `SELECT thread_id, message_id FROM chat_artifacts WHERE org_id = ?`, ORG_A);
    expect(r.json.threadId).toBeNull();
    const holder = await first<{ id: number }>(env.DB, `SELECT id FROM chat_threads WHERE org_id = ? AND handle = ? AND pending = 1`, ORG_A, ME);
    expect(links.every((l) => l.thread_id === holder!.id && l.message_id === null)).toBe(true);
  });

  it("what the model sees is read BACK from the store: with the stored bytes gone, the model gets a note, never the upload", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "ci.png", type: "image/png", bytes: PNG }, { name: "gone.png", type: "image/png", bytes: new Uint8Array([...PNG, 9]) }]);
    const [kept, gone] = up.json.attachments;
    // Remove the second file's stored bytes after the upload.
    const r2key = (await first<{ r2_key: string }>(env.DB, `SELECT v.r2_key FROM artifact_versions v JOIN artifact_pages p ON p.id = v.page_id AND p.org_id = v.org_id WHERE p.org_id = ? AND p.slug = ?`, ORG_A, gone.slug))!.r2_key;
    await env.ARTIFACTS_BUCKET.delete(r2key);
    const model = fakeModel([[{ type: "text", text: `Seen.${final}` }]]);
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "What is this?", attachments: [kept.id, gone.id] }));
    const blocks = firstUserBlocks(model.sent[0]);
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].source).toMatchObject({ media_type: "image/png", data: b64(PNG) });
    expect(blocks.some((b) => b.type === "text" && /gone\.png.*no longer available/.test(b.text ?? ""))).toBe(true);
    // Both are now sent with the question.
    expect((await all<{ message_id: number | null }>(env.DB, `SELECT message_id FROM chat_artifacts WHERE org_id = ?`, ORG_A)).every((l) => l.message_id !== null)).toBe(true);
  });

  it("the 10 MB cap holds server-side (413, nothing stored); more than 5 files, or an unsupported kind, are refused", async () => {
    const cookie = await cookieFor(ME);
    const big = await upload(cookie, [{ name: "huge.pdf", type: "application/pdf", bytes: new Uint8Array(10 * 1024 * 1024 + 1) }]);
    expect(big.status).toBe(413);
    expect(big.json.error).toBe("too_large");
    const six = await upload(cookie, Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, type: "text/plain", bytes: new TextEncoder().encode("x") })));
    expect(six.status).toBe(400);
    const exe = await upload(cookie, [{ name: "tool.exe", type: "application/x-msdownload", bytes: new Uint8Array([1, 2]) }]);
    expect(exe.status).toBe(415);
    expect(await all(env.DB, `SELECT id FROM artifact_pages WHERE org_id = ?`, ORG_A)).toEqual([]);
    expect(await all(env.DB, `SELECT id FROM chat_threads WHERE org_id = ?`, ORG_A)).toEqual([]);
  });

});

/** A PNG whose header says `w`×`h`, padded to `size` bytes. */
function pngOf(w: number, h: number, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

describe("an image over the model's limit: stored, not read, and the person is told", () => {
  it("over 10 MB base64-encoded: the model is told, and the stream's first activity line is the notice — kept with the answer", async () => {
    const cookie = await cookieFor(ME);
    // 7.6 MB raw is about 10.1 MB as base64: past the API's per-image limit, under the 10 MB attach cap.
    const up = await upload(cookie, [{ name: "big.png", type: "image/png", bytes: pngOf(1200, 900, 7_600_000) }]);
    expect(up.status).toBe(200);
    const model = fakeModel([[{ type: "tool_use", name: "list_tags", input: {} }], [{ type: "text", text: `ok${final}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "see?", attachments: [up.json.attachments[0].id] }));
    const blocks = firstUserBlocks(model.sent[0]);
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(blocks.some((b) => /could not view it: the image is larger than the 10 MB the model takes/.test(b.text ?? ""))).toBe(true);
    // The notice: step 1, before the model's own tool call (step 2), in the contract.
    for (const e of r.events) expect(AskEventSchemas[e.event].safeParse(e.data).success, e.event).toBe(true);
    const acts = eventsOf(r.events, "activity");
    expect(acts[0]).toEqual({ step: 1, tool: "read_attachment", icon: "read", label: "big.png is too large for Trov to view, so it was stored but not read.", state: "run" });
    expect(acts[1]).toEqual({ step: 1, state: "done", resultLine: "Not read" });
    expect(acts[2]).toMatchObject({ step: 2, tool: "list_tags", state: "run" });
    const names = r.events.map((e) => e.event);
    expect(names.indexOf("activity")).toBeLessThan(names.indexOf("text"));
    // Reopening the thread shows it again.
    const thread = await app.request(`${BASE}/ask/threads/${eventsOf(r.events, "thread")[0].id}`, { headers: { cookie } }, KEYED);
    const answer = ((await thread.json()) as { messages: { role: string; activity: { label: string; resultLine: string | null }[] }[] }).messages.at(-1)!;
    expect(answer.activity[0]).toMatchObject({ label: "big.png is too large for Trov to view, so it was stored but not read.", resultLine: "Not read" });
  });

  it("over 8000 pixels on a side (read from the header): the same notice; a large image within both limits is sent", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [
      { name: "wide.png", type: "image/png", bytes: pngOf(9000, 400) },
      { name: "six-mb.png", type: "image/png", bytes: pngOf(2000, 1500, 6 * 1024 * 1024) }, // was refused under the old 5 MB rule
    ]);
    const model = fakeModel([[{ type: "text", text: `ok${final}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "see?", attachments: up.json.attachments.map((a: { id: number }) => a.id) }));
    const blocks = firstUserBlocks(model.sent[0]);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(blocks.some((b) => /wide\.png.*could not view it: the image is 9000×400 pixels/.test(b.text ?? ""))).toBe(true);
    const acts = eventsOf(r.events, "activity");
    expect(acts.filter((a) => a.state === "run").map((a) => a.label)).toEqual(["wide.png is too large for Trov to view, so it was stored but not read."]);
  });

  it("an image that fits says nothing", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "small.png", type: "image/png", bytes: pngOf(800, 600) }]);
    const model = fakeModel([[{ type: "text", text: `ok${final}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "see?", attachments: [up.json.attachments[0].id] }));
    expect(eventsOf(r.events, "activity")).toEqual([]);
    expect(firstUserBlocks(model.sent[0]).some((b) => b.type === "image")).toBe(true);
  });
});

describe("imageSize reads the pixel size from the header", () => {
  it("PNG, GIF, JPEG and the three WebP forms; anything else is null", () => {
    expect(imageSize(pngOf(9000, 12))).toEqual({ width: 9000, height: 12 });
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x1f, 0x20, 0x00]))).toEqual({ width: 8000, height: 32 });
    // JPEG: SOI, an APP0 segment (length 16), then SOF0 with height 300 and width 8001.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x1f, 0x41, 0x03, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 8001, height: 300 });
    const riff = (chunk: string, body: number[]) => new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...new TextEncoder().encode(chunk), ...body]);
    // VP8X: canvas width-1 and height-1 as 24-bit little-endian at 24 and 27.
    expect(imageSize(riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x1f, 0x00, 0x63, 0x00, 0x00, 0, 0]))).toEqual({ width: 8000, height: 100 });
    // VP8 (lossy): width and height as 14-bit little-endian at 26 and 28.
    expect(imageSize(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x1f, 0x64, 0x00, 0, 0]))).toEqual({ width: 8000, height: 100 });
    // VP8L (lossless): the signature 0x2f, then 14-bit width-1 and height-1 packed.
    const w = 8000 - 1, h = 100 - 1;
    const bits = w | (h << 14);
    expect(imageSize(riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 8000, height: 100 });
    expect(imageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });
});

describe("a file goes whole only in its own turn; read_attachment reads this thread's own", () => {
  it("a later turn carries a one-line reference; read_attachment returns the file; another thread's attachment is not_found", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "ci.png", type: "image/png", bytes: PNG }]);
    const att = up.json.attachments[0];
    const otherUp = await upload(cookie, [{ name: "other.md", type: "text/markdown", bytes: new TextEncoder().encode("# other thread") }]);
    const otherAtt = otherUp.json.attachments[0];
    const model = fakeModel([
      [{ type: "text", text: `First.${final}` }],
      [{ type: "tool_use", name: "read_attachment", input: { id: att.id } }, { type: "tool_use", name: "read_attachment", input: { id: otherAtt.id } }],
      [{ type: "text", text: `Second.${final}` }],
    ]);
    const r1 = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "look", attachments: [att.id] }));
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: eventsOf(r1.events, "thread")[0].id, text: "and the screenshot again?" }));
    // Turn 2's request: the earlier question carries one line, and no image block anywhere in the history.
    const second = model.sent[1];
    const history = JSON.stringify(second.messages);
    expect(history).toContain(`attachment id ${att.id}`);
    expect(second.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).some((b: Block) => b.type === "image")).toBe(false);
    // Turn 2's tool results: this thread's file comes back as an image; the other thread's is not_found.
    const results = model.sent[2].messages.at(-1)!.content as { content: unknown; is_error?: boolean }[];
    expect(Array.isArray(results[0].content) && (results[0].content as Block[]).some((b) => b.type === "image")).toBe(true);
    expect(results[1].is_error).toBe(true);
    expect(JSON.parse(results[1].content as string).code).toBe("not_found");
  });

  it("another person can neither send nor read your attachment", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "mine.png", type: "image/png", bytes: PNG }], await threadOf(cookie));
    const other = await cookieFor("ask-snoop");
    // Their own new thread: the id names nothing pending there.
    const model = fakeModel([[{ type: "text", text: `ok${final}` }]]);
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(other, { text: "show me", attachments: [up.json.attachments[0].id] }));
    expect(firstUserBlocks(model.sent[0]).some((b) => b.type === "image")).toBe(false);
    // And they cannot attach into your thread.
    expect((await upload(other, [{ name: "x.png", type: "image/png", bytes: PNG }], up.json.threadId)).status).toBe(404);
    expect(eventsOf).toBeTypeOf("function");
  });
});
