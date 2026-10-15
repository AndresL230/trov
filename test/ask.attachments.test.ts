// Ask Trov's attachments (src/ai/ask/attachments.ts; docs/architecture/ask.md › Attachments): stored as PRIVATE
// artifacts on attach, BEFORE the model sees them — what the model gets is read back from the artifacts store; the
// 10 MB cap holds server-side; a file goes whole only in its own turn; `read_attachment` reads only this person's
// thread's own.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A } from "./helpers/tenant";
import { BASE, KEYED, ask, eventsOf, fakeModel, withAsk } from "./helpers/ask";
import { app } from "../src/routes";

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
    const cookie = await cookieFor(ME);
    const r = await upload(cookie, [{ name: "ci-failure.png", type: "image/png", bytes: PNG }, { name: "notes.md", type: "text/markdown", bytes: new TextEncoder().encode("# Notes\n\nthe connect test") }]);
    expect(r.status).toBe(200);
    expect(r.json.attachments.map((a: { kind: string }) => a.kind)).toEqual(["image", "text"]);
    expect(r.json.attachments[0].thumbUrl).toMatch(/^\/api\/o\/saplinglearn\/raw\/a\//);
    const pages = await all<{ visibility: string; author_id: string; kind: string }>(env.DB, `SELECT visibility, author_id, kind FROM artifact_pages WHERE org_id = ? ORDER BY id`, ORG_A);
    expect(pages).toEqual([{ visibility: "private", author_id: ME, kind: "image" }, { visibility: "private", author_id: ME, kind: "markdown" }]);
    const links = await all<{ thread_id: number; message_id: number | null }>(env.DB, `SELECT thread_id, message_id FROM chat_artifacts WHERE org_id = ?`, ORG_A);
    expect(links.every((l) => l.thread_id === r.json.threadId && l.message_id === null)).toBe(true);
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

  it("an image over the API's 5 MB is stored, and the model is told it could not view it", async () => {
    const cookie = await cookieFor(ME);
    const up = await upload(cookie, [{ name: "big.png", type: "image/png", bytes: new Uint8Array(5 * 1024 * 1024 + 10) }]);
    expect(up.status).toBe(200);
    const model = fakeModel([[{ type: "text", text: `ok${final}` }]]);
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "see?", attachments: [up.json.attachments[0].id] }));
    const blocks = firstUserBlocks(model.sent[0]);
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(blocks.some((b) => /could not view it: the image is larger than 5 MB/.test(b.text ?? ""))).toBe(true);
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
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "look", attachments: [att.id] }));
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { threadId: up.json.threadId, text: "and the screenshot again?" }));
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
    const up = await upload(cookie, [{ name: "mine.png", type: "image/png", bytes: PNG }]);
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
