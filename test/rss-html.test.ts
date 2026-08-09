import { describe, expect, it } from "vitest";

import { htmlToPlainText, truncatePlainText } from "../src/rss/html";

describe("RSS description HTML to plain text", () => {
  it("converts structural breaks, strips tags, and decodes supported entities", () => {
    const html = `
      <p>Alpha &amp; Beta<br>1 &lt; 2 &gt; 0 &quot;quoted&quot; &#39;single&#39;&nbsp;space</p>
      <ul><li>First</li><li><strong>Second</strong></li></ul>
      <p>Final</p>
    `;
    expect(htmlToPlainText(html)).toBe(
      `Alpha & Beta\n1 < 2 > 0 "quoted" 'single' space\n\nFirst\nSecond\n\nFinal`,
    );
  });

  it("compresses blank lines and removes comments plus script/style content", () => {
    expect(
      htmlToPlainText(
        "<p>One</p><p> </p><p> </p><!-- hidden --><script>bad()</script><style>x{}</style><p>Two</p>",
      ),
    ).toBe("One\n\nTwo");
  });

  it("truncates by Unicode character after HTML cleanup", () => {
    const plain = htmlToPlainText(`<p>${"<b></b>".repeat(100)}${"播".repeat(21)}</p>`);
    expect(truncatePlainText(plain, 20)).toEqual({
      value: "播".repeat(20),
      truncated: true,
    });
  });
});
