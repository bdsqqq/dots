/**
 * unit tests for html-to-md — HTML to markdown conversion.
 *
 * tests isHtml detection and htmlToMarkdown conversion.
 * cheerio is a dependency, so conversion tests will run.
 *
 * run: bun test user/pi/extensions/tools/lib/html-to-md.test.ts
 */

import { describe, it, expect } from "bun:test";
import { htmlToMarkdown, isHtml } from "./html-to-md";

describe("isHtml", () => {
  it("returns true for doctype", () => {
    expect(isHtml("<!DOCTYPE html><html><body>test</body></html>")).toBe(true);
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
    const html = "<!DOCTYPE html><html><body><h1>Title</h1><h2>Subtitle</h2></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("# Title");
    expect(md).toContain("## Subtitle");
  });

  it("converts paragraphs", () => {
    const html = "<!DOCTYPE html><html><body><p>First para.</p><p>Second para.</p></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("First para.");
    expect(md).toContain("Second para.");
  });

  it("converts links", () => {
    const html = '<!DOCTYPE html><html><body><a href="https://example.com">Click here</a></body></html>';
    const md = htmlToMarkdown(html);

    expect(md).toContain("[Click here](https://example.com)");
  });

  it("converts bold and italic", () => {
    const html = "<!DOCTYPE html><html><body><strong>bold</strong> <em>italic</em></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("**bold**");
    expect(md).toContain("*italic*");
  });

  it("converts code blocks", () => {
    const html = '<!DOCTYPE html><html><body><pre><code class="language-typescript">const x = 1;</code></pre></body></html>';
    const md = htmlToMarkdown(html);

    expect(md).toContain("```typescript");
    expect(md).toContain("const x = 1;");
  });

  it("converts inline code", () => {
    const html = "<!DOCTYPE html><html><body><p>Use <code>npm install</code> to install.</p></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("`npm install`");
  });

  it("converts unordered lists", () => {
    const html = "<!DOCTYPE html><html><body><ul><li>Item 1</li><li>Item 2</li></ul></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("- Item 1");
    expect(md).toContain("- Item 2");
  });

  it("converts ordered lists", () => {
    const html = "<!DOCTYPE html><html><body><ol><li>First</li><li>Second</li></ol></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("1. First");
    expect(md).toContain("2. Second");
  });

  it("converts blockquotes", () => {
    const html = "<!DOCTYPE html><html><body><blockquote>A wise quote</blockquote></body></html>";
    const md = htmlToMarkdown(html);

    expect(md).toContain("> A wise quote");
  });

  it("converts images", () => {
    const html = '<!DOCTYPE html><html><body><img src="test.png" alt="Alt text"></body></html>';
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