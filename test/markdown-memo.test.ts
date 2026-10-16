/**
 * Markdown is rendered once per body (web-ui.md › Markdown is rendered once per body): the LRU
 * (web/src/lru.ts) and the key markdown.ts's renderers cache under. The Docs tree's outlines are
 * built on the server (shared/doc-outline.ts, sent by GET /docs), so the browser computes none.
 * marked + DOMPurify need a DOM this workerd harness does not have, so the renderers' key is
 * checked in their source; everything else runs.
 */
import { describe, expect, it } from "vitest";
import { createLru } from "../web/src/lru";
import { extractOutline } from "@shared/doc-outline";
import markdownSrc from "../web/src/markdown.ts?raw";

describe("the LRU", () => {
  it("keeps the newest `max` entries, and a hit makes an entry newest", () => {
    const c = createLru<string>(3);
    c.set("a", "A"); c.set("b", "B"); c.set("c", "C");
    expect(c.get("a")).toBe("A");          // a is now the newest
    c.set("d", "D");                        // evicts b, the oldest
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("A");
    expect(c.get("c")).toBe("C");
    expect(c.get("d")).toBe("D");
    expect(c.size).toBe(3);
    c.set("c", "C2");                       // a re-set replaces, never duplicates
    expect(c.size).toBe(3);
    expect(c.get("c")).toBe("C2");
  });
});

describe("extractOutline (shared/doc-outline.ts) — what GET /docs sends for each doc", () => {
  const body = "# Title\n\n## Setup\n\ntext\n\n### Keys\n\n```\n## not a heading\n```\n\n## Setup\n";

  it("H2/H3 only, fenced code skipped, ids de-duped across every level", () => {
    expect(extractOutline(body)).toEqual([
      { level: 2, text: "Setup", id: "setup" },
      { level: 3, text: "Keys", id: "keys" },
      { level: 2, text: "Setup", id: "setup-1" },
    ]);
  });

  it("an empty or missing body is an empty outline", () => {
    expect(extractOutline("")).toEqual([]);
    expect(extractOutline(undefined as unknown as string)).toEqual([]);
  });
});

describe("markdown.ts caches its renderers under everything their output depends on", () => {
  it("the key is the main repository, the org on screen and the text", () => {
    expect(markdownSrc).toMatch(/const cacheKey = \(text: string\): string => `\$\{repoUrl\(\) \?\? ""\}\\u0000\$\{apiOrgSlug\(\) \?\? ""\}\\u0000\$\{text \?\? ""\}`;/);
  });

  it("both renderers look up before rendering and store the string they return", () => {
    for (const [fn, cache] of [["renderMarkdown", "blockCache"], ["renderMarkdownInline", "inlineCache"]] as const) {
      const at = markdownSrc.indexOf(`export function ${fn}(`);
      const body = markdownSrc.slice(at, markdownSrc.indexOf("\n}\n", at));
      expect(body, fn).toContain(`const hit = ${cache}.get(key);`);
      expect(body, fn).toContain(`${cache}.set(key, out);`);
      expect(body.indexOf(`${cache}.get(key)`), fn).toBeLessThan(body.indexOf("DOMPurify.sanitize"));
    }
    // `sanitizeSvg` (an artifact's own bytes, viewed once) is not cached.
    const svg = markdownSrc.slice(markdownSrc.indexOf("export function sanitizeSvg("));
    expect(svg.slice(0, svg.indexOf("\n}\n"))).not.toContain("Cache");
  });
});
