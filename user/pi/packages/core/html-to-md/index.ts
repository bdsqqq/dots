/**
 * cheerio-based HTML→markdown. returns null when cheerio isn't
 * resolvable (caller falls back to raw output). optimizes for
 * LLM-readable output over pixel-perfect fidelity.
 */

import { createRequire } from "node:module";

let cheerioLoad: ((html: string) => any) | null = null;

try {
  const esmRequire = createRequire(import.meta.url);
  const cheerio = esmRequire("cheerio");
  cheerioLoad = cheerio.load;
} catch {}

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "nav",
  "footer",
  "header",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  ".cookie-banner",
  ".cookie-consent",
  "#cookie-banner",
  "#cookie-consent",
].join(", ");

const MAIN_SELECTORS = [
  "main",
  "article",
  '[role="main"]',
  "#content",
  "#main",
  ".content",
  ".main",
  ".post-content",
  ".article-content",
  ".entry-content",
];

export function isHtml(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 200).toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<?xml")
  );
}

function nodeToMd($: any, node: any): string {
  if (node.type === "text") {
    return (node.data || "").replace(/[ \t]+/g, " ");
  }
  if (node.type !== "tag") return "";

  const tag = node.name?.toLowerCase();
  if (!tag) return "";

  const el = $(node);
  const children = el.contents().toArray();
  const inner = () => children.map((c: any) => nodeToMd($, c)).join("");

  if (/^h[1-6]$/.test(tag)) {
    const level = parseInt(tag[1]);
    const text = inner().trim();
    if (!text) return "";
    return `\n\n${"#".repeat(level)} ${text}\n\n`;
  }

  if (tag === "p") {
    const text = inner().trim();
    return text ? `\n\n${text}\n\n` : "";
  }
  if (tag === "br") return "\n";

  if (tag === "a") {
    const href = el.attr("href");
    const text = inner().trim();
    if (!text) return "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:"))
      return text;
    return `[${text}](${href})`;
  }

  if (tag === "strong" || tag === "b") {
    const text = inner().trim();
    return text ? `**${text}**` : "";
  }
  if (tag === "em" || tag === "i") {
    const text = inner().trim();
    return text ? `*${text}*` : "";
  }

  if (tag === "code") {
    if (el.parent().is("pre")) return el.text();
    const text = el.text().trim();
    return text ? `\`${text}\`` : "";
  }
  if (tag === "pre") {
    const code = el.find("code");
    const lang = code.attr("class")?.match(/language-(\w+)/)?.[1] || "";
    const text = code.length > 0 ? code.text() : el.text();
    return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
  }

  if (tag === "ul" || tag === "ol") {
    const items = el.children("li").toArray();
    const lines = items.map((li: any, i: number) => {
      const text = nodeToMd($, li).trim();
      const prefix = tag === "ol" ? `${i + 1}. ` : "- ";
      return `${prefix}${text}`;
    });
    return `\n\n${lines.join("\n")}\n\n`;
  }
  if (tag === "li") return inner();

  if (tag === "blockquote") {
    const text = inner().trim();
    return text
      ? `\n\n${text
          .split("\n")
          .map((l: string) => `> ${l}`)
          .join("\n")}\n\n`
      : "";
  }

  if (tag === "img") {
    const alt = el.attr("alt") || "";
    const src = el.attr("src") || "";
    if (!src) return "";
    return `![${alt}](${src})`;
  }

  if (tag === "table") {
    const rows = el.find("tr").toArray();
    if (rows.length === 0) return "";
    const result: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = $(rows[i])
        .find("th, td")
        .toArray()
        .map((c: any) => $(c).text().trim());
      if (cells.length === 0) continue;
      result.push(`| ${cells.join(" | ")} |`);
      if (i === 0) {
        result.push(`| ${cells.map(() => "---").join(" | ")} |`);
      }
    }
    return result.length > 0 ? `\n\n${result.join("\n")}\n\n` : "";
  }

  if (
    [
      "div",
      "section",
      "article",
      "main",
      "figure",
      "figcaption",
      "details",
      "summary",
      "dl",
      "dt",
      "dd",
    ].includes(tag)
  ) {
    return inner();
  }

  if (tag === "hr") return "\n\n---\n\n";

  return inner();
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function htmlToMarkdown(html: string): string | null {
  if (!cheerioLoad) return null;
  if (!isHtml(html)) return null;

  const $ = cheerioLoad(html);
  $(REMOVE_SELECTORS).remove();

  // find main content area
  let root = null;
  for (const sel of MAIN_SELECTORS) {
    const found = $(sel);
    if (found.length > 0) {
      root = found.first();
      break;
    }
  }
  if (!root) root = $("body");

  const md = root
    .contents()
    .toArray()
    .map((n: any) => nodeToMd($, n))
    .join("");
  return collapseWhitespace(md);
}

// inline tests
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("isHtml", () => {
    it("returns true for doctype", () => {
      expect(isHtml("<!DOCTYPE html><html><body>test</body></html>")).toBe(
        true,
      );
      expect(isHtml("  <!DOCTYPE html>\n<html>")).toBe(true);
    });

    it("returns true for html tag", () => {
      expect(isHtml("<html><body>test</body></html>")).toBe(true);
      expect(isHtml("  <html lang='en'>")).toBe(true);
    });

    it("returns true for xml declaration", () => {
      expect(isHtml("<?xml version='1.0'?><root>")).toBe(true);
      expect(isHtml("  <?xml?>")).toBe(true);
    });

    it("returns false for plain text", () => {
      expect(isHtml("just plain text")).toBe(false);
      expect(isHtml("some <b>bold</b> in text")).toBe(false);
    });

    it("returns false for markdown", () => {
      expect(isHtml("# Heading\n\nParagraph")).toBe(false);
      expect(isHtml("- list item\n- another")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isHtml("")).toBe(false);
    });

    it("only checks first 200 chars", () => {
      const padding = "x".repeat(250);
      expect(isHtml(padding + "<!DOCTYPE html>")).toBe(false);
      expect(isHtml("<!DOCTYPE html>" + padding)).toBe(true);
    });
  });

  describe("htmlToMarkdown", () => {
    it("returns null for non-HTML content", () => {
      expect(htmlToMarkdown("plain text")).toBeNull();
      expect(htmlToMarkdown("# Markdown")).toBeNull();
    });

    it("converts headings", () => {
      const html =
        "<!DOCTYPE html><html><body><h1>Title</h1><h2>Subtitle</h2></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("# Title");
      expect(md).toContain("## Subtitle");
    });

    it("converts paragraphs", () => {
      const html =
        "<!DOCTYPE html><html><body><p>First para.</p><p>Second para.</p></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("First para.");
      expect(md).toContain("Second para.");
    });

    it("converts links", () => {
      const html =
        '<!DOCTYPE html><html><body><a href="https://example.com">Click here</a></body></html>';
      const md = htmlToMarkdown(html);

      expect(md).toContain("[Click here](https://example.com)");
    });

    it("converts bold and italic", () => {
      const html =
        "<!DOCTYPE html><html><body><strong>bold</strong> <em>italic</em></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("**bold**");
      expect(md).toContain("*italic*");
    });

    it("converts code blocks", () => {
      const html =
        '<!DOCTYPE html><html><body><pre><code class="language-typescript">const x = 1;</code></pre></body></html>';
      const md = htmlToMarkdown(html);

      expect(md).toContain("```typescript");
      expect(md).toContain("const x = 1;");
    });

    it("converts inline code", () => {
      const html =
        "<!DOCTYPE html><html><body><p>Use <code>npm install</code> to install.</p></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("`npm install`");
    });

    it("converts unordered lists", () => {
      const html =
        "<!DOCTYPE html><html><body><ul><li>Item 1</li><li>Item 2</li></ul></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("- Item 1");
      expect(md).toContain("- Item 2");
    });

    it("converts ordered lists", () => {
      const html =
        "<!DOCTYPE html><html><body><ol><li>First</li><li>Second</li></ol></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("1. First");
      expect(md).toContain("2. Second");
    });

    it("converts blockquotes", () => {
      const html =
        "<!DOCTYPE html><html><body><blockquote>A wise quote</blockquote></body></html>";
      const md = htmlToMarkdown(html);

      expect(md).toContain("> A wise quote");
    });

    it("converts images", () => {
      const html =
        '<!DOCTYPE html><html><body><img src="test.png" alt="Alt text"></body></html>';
      const md = htmlToMarkdown(html);

      expect(md).toContain("![Alt text](test.png)");
    });

    it("converts tables", () => {
      const html = `<!DOCTYPE html><html><body>
        <table>
          <tr><th>A</th><th>B</th></tr>
          <tr><td>1</td><td>2</td></tr>
        </table>
      </body></html>`;
      const md = htmlToMarkdown(html);

      expect(md).toContain("| A | B |");
      expect(md).toContain("| --- | --- |");
      expect(md).toContain("| 1 | 2 |");
    });

    it("removes script and style tags", () => {
      const html = `<!DOCTYPE html><html><body>
        <script>console.log('hidden')</script>
        <p>Visible content</p>
        <style>.hidden { display: none; }</style>
      </body></html>`;
      const md = htmlToMarkdown(html);

      expect(md).toContain("Visible content");
      expect(md).not.toContain("console.log");
      expect(md).not.toContain(".hidden");
    });

    it("removes navigation elements", () => {
      const html = `<!DOCTYPE html><html><body>
        <nav><a href="/">Home</a></nav>
        <main><p>Main content</p></main>
        <footer>Copyright</footer>
      </body></html>`;
      const md = htmlToMarkdown(html);

      expect(md).toContain("Main content");
      // nav and footer should be removed
      expect(md).not.toContain("Home");
      expect(md).not.toContain("Copyright");
    });

    it("finds main content area", () => {
      const html = `<!DOCTYPE html><html><body>
        <nav>Navigation</nav>
        <article>
          <h1>Article Title</h1>
          <p>Article content.</p>
        </article>
      </body></html>`;
      const md = htmlToMarkdown(html);

      // should use article as root
      expect(md).toContain("Article Title");
      expect(md).toContain("Article content");
    });

    it("collapses excessive whitespace", () => {
      const html = `<!DOCTYPE html><html><body><p>Test</p></body></html>`;
      const md = htmlToMarkdown(html);

      // no triple newlines
      expect(md).not.toMatch(/\n{3,}/);
    });

    it("handles nested elements", () => {
      const html = `<!DOCTYPE html><html><body>
        <ul>
          <li><strong>Bold item</strong></li>
          <li><em>Italic item</em></li>
        </ul>
      </body></html>`;
      const md = htmlToMarkdown(html);

      expect(md).toContain("- **Bold item**");
      expect(md).toContain("- *Italic item*");
    });
  });
}
