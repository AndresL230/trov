// marked + DOMPurify, configured — the Markdown chunk (web-ui.md › The app's bundles). Nothing imports
// this module statically: markdown.ts loads it (`import("./markdown-lib")`) the first time a body is
// rendered, so the libraries (~24 kB gz) are not in the app's first download. markdown.ts and
// md-blocks.ts reach it only through `markdownLib()` (markdown-load.ts).
import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { repoUrl } from "./github";
import { issueRefStart, matchIssueRef } from "./issue-ref";

marked.setOptions({ gfm: true, breaks: false });

// Auto-link GitHub issue/PR refs in prose — bare `#123` (this org's main repo) and
// `owner/repo#123` (that repo; see issue-ref.ts). Runs as an inline extension, so
// it skips code spans/blocks (tokenized separately) and its output is still DOMPurify-sanitized.
marked.use({
  extensions: [
    {
      name: "issueRef",
      level: "inline",
      start(src: string) {
        return issueRefStart(src);
      },
      tokenizer(src: string) {
        // No repository connected: `owner/repo#12` still links (it names its repo); a bare `#12` stays text.
        const ref = matchIssueRef(src, repoUrl());
        if (ref) return { type: "issueRef", raw: ref.raw, href: ref.href, text: ref.text } as Tokens.Generic;
        return undefined;
      },
      renderer(token) {
        // `href` is built from a strict owner/repo#N match and `text` is that same
        // match — no quotes or angle brackets can occur — and the result still
        // passes through DOMPurify with everything else.
        const { href, text } = token as unknown as { href: string; text: string };
        return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      },
    },
  ],
});

export { marked, DOMPurify };
