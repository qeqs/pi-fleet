import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const { renderMarkdown } = createRequire(import.meta.url)("../src/markdown.cjs") as { renderMarkdown: (s: string) => string };

describe("renderMarkdown", () => {
  it("renders headings, emphasis and inline code", () => {
    expect(renderMarkdown("# Title")).toBe("<h2>Title</h2>");
    expect(renderMarkdown("a **b** *c* `d`")).toBe("<p>a <strong>b</strong> <em>c</em> <code>d</code></p>");
  });

  it("renders tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toBe("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
  });

  it("does not mistake a line with a pipe for a table", () => {
    expect(renderMarkdown("a | b")).toBe("<p>a | b</p>");
  });

  it("renders ordered and unordered lists as separate lists", () => {
    expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(renderMarkdown("- a\n- b\n1. c")).toBe("<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>");
  });

  it("leaves code blocks alone", () => {
    expect(renderMarkdown("```js\n- not a list\n**not bold**\n```")).toBe("<pre><code>- not a list\n**not bold**</code></pre>");
  });

  it("keeps line breaks in a paragraph", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
  });

  it("renders quotes", () => {
    expect(renderMarkdown("> said\n> twice")).toBe("<blockquote>said<br>twice</blockquote>");
  });

  it("ends a paragraph where a block begins", () => {
    expect(renderMarkdown("text\n- item")).toBe("<p>text</p><ul><li>item</li></ul>");
  });

  it("copes with an unclosed code block", () => {
    expect(renderMarkdown("```\ncode")).toBe("<pre><code>code</code></pre>");
  });
});

describe("renderMarkdown on hostile input", () => {
  it("escapes HTML everywhere", () => {
    for (const hostile of ["<script>x</script>", "# <img src=x onerror=y>", "- <b>x</b>", "| <i> | b |\n|---|---|\n| c | d |", "> <svg>", "```\n<script>\n```", "`<b>`"]) {
      expect(renderMarkdown(hostile)).not.toMatch(/<(script|img|svg|b>|i>)/);
    }
  });

  it("makes links only to http and https", () => {
    expect(renderMarkdown("[a](https://x.example/p?q=1)")).toContain('<a href="https://x.example/p?q=1"');
    for (const bad of ["[a](javascript:alert(1))", "[a](data:text/html,x)", "[a](vbscript:x)"]) expect(renderMarkdown(bad)).not.toContain("<a ");
  });

  it("cannot break out of a link's attribute", () => {
    const html = renderMarkdown(`[a](https://x.example/"onmouseover="alert(1))`);
    expect(html).toContain("&quot;onmouseover=&quot;");
    expect(html.match(/"/g)).toHaveLength(6); // only the quotes the renderer wrote itself
  });
});
