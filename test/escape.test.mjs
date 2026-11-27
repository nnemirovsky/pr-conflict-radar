import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANNOTATION_MESSAGES,
  annotation,
  escapeText,
  loginLink,
  logLine,
  markerJson,
} from "../lib/escape.mjs";

const HOSTILE = {
  "a Markdown link": "[x](https://example.com)",
  "an image": "![alt](https://example.com/a.png)",
  emphasis: "**bold** and _italic_ and *star*",
  strikethrough: "~~gone~~",
  "a bare URL": "see https://example.com/path?q=1",
  "a www. host": "www.example.com",
  "an e-mail address": "a@example.com",
  "an @ mention": "@reviewer please look",
  "an issue reference": "#12 and acme/widgets#15",
  "an HTML tag": '<img src=x onerror="alert(1)">',
  "a closing </code>": "x</code><b>y</b>",
  "a |": "a|b",
  "a backslash before a |": "a\\|b",
  backticks: "``code`` and `x`",
  "a line break": "line one\nline two\r\nline three",
  "a tab": "a\tb",
  "a bidirectional override": "abc\u202Edcba\u2066x\u2069",
  "a zero-width space": "a\u200Bb\uFEFFc\u200Dd",
  "a line and a paragraph separator": "a\u2028b\u2029c",
  "an HTML comment close": "x --> y <!-- z",
  "non-ASCII text": "Grüße/日本語-ok",
};

const REMOVED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function inner(output) {
  assert.ok(output.startsWith("<code>"), output);
  assert.ok(output.endsWith("</code>"), output);
  return output.slice("<code>".length, -"</code>".length);
}

function decode(text) {
  return text
    .replaceAll("&#64;<!---->", "@")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

describe("escapeText", () => {
  for (const [name, sample] of Object.entries(HOSTILE)) {
    it(`leaves only inert characters for ${name}`, () => {
      const body = inner(escapeText(sample));
      const rest = body.replaceAll("&#64;<!---->", "").replace(/&#\d+;/g, "");
      assert.match(rest, /^[A-Za-z0-9 /\-\u0080-\u{10FFFF}]*$/u);
      assert.doesNotMatch(rest, REMOVED);
      assert.equal(decode(body), sample.replace(REMOVED, ""));
    });
  }

  it("writes punctuation as decimal character references", () => {
    assert.equal(escapeText("[a]"), "<code>&#91;a&#93;</code>");
    assert.equal(escapeText("a|b"), "<code>a&#124;b</code>");
    assert.equal(escapeText("<b>"), "<code>&#60;b&#62;</code>");
  });

  it("keeps letters, digits, spaces, slashes and hyphens as they are", () => {
    assert.equal(escapeText("src/cart-total 2"), "<code>src/cart-total 2</code>");
  });

  it("writes @ with an empty HTML comment beside it", () => {
    assert.equal(escapeText("a@b"), "<code>a&#64;<!---->b</code>");
  });

  it("leaves no autolink start, table-cell break or tag", () => {
    const body = inner(escapeText("https://www.example.com|<i>"));
    assert.ok(!body.includes("://"));
    assert.ok(!body.includes("www."));
    assert.ok(!body.includes("|"));
    assert.ok(!body.includes("<i>"));
  });

  it("removes control, format and separator characters", () => {
    assert.equal(escapeText("a\u0000\u0007\u0085\u200E\u2028b"), "<code>ab</code>");
  });

  it("keeps non-ASCII characters", () => {
    assert.equal(escapeText("日本"), "<code>日本</code>");
    assert.equal(escapeText("😀"), "<code>😀</code>");
  });

  it("converts non-string values to text", () => {
    assert.equal(escapeText(15), "<code>15</code>");
    assert.equal(escapeText(""), "<code></code>");
  });
});

// Logins that are neither in GitHub's username format nor `<name>[bot]` with
// `name` in it.
const HOSTILE_LOGINS = {
  "a closing parenthesis": "a)b",
  "a link of its own": "x](https://evil.example)",
  "a team mention": "@team",
  "40 characters": "a".repeat(40),
  "an underscore": "dev_a",
  "a Cyrillic lookalike letter": "d\u0435v-a",
  "fullwidth letters": "\uFF44\uFF45\uFF56",
  "a Unicode hyphen": "dev\u2010a",
  "a zero-width space": "dev-a\u200B",
  "a trailing line break": "dev-a\n",
  "a leading hyphen": "-dev",
  "a trailing hyphen": "dev-",
  "two hyphens in a row": "dev--a",
  "a space": "dev a",
  "an empty string": "",
  "a hostile bot name": "x](https://evil.example)[bot]",
  "a bot suffix alone": "[bot]",
  "a doubled bot suffix": "dependabot[bot][bot]",
  "an upper-case bot suffix": "dependabot[BOT]",
  "a bot name of 40 characters": `${"a".repeat(40)}[bot]`,
};

describe("loginLink", () => {
  it("links a login in the username format to its profile", () => {
    assert.equal(loginLink("dev-a"), "[dev-a](https://github.com/dev-a)");
    assert.equal(loginLink("A1"), "[A1](https://github.com/A1)");
    const longest = `a-${"b".repeat(37)}`;
    assert.equal(longest.length, 39);
    assert.equal(loginLink(longest), `[${longest}](https://github.com/${longest})`);
  });

  it("links a bot login to its app with the brackets of the text escaped", () => {
    assert.equal(
      loginLink("dependabot[bot]"),
      "[dependabot\\[bot\\]](https://github.com/apps/dependabot)",
    );
    assert.equal(loginLink("my-app[bot]"), "[my-app\\[bot\\]](https://github.com/apps/my-app)");
  });

  for (const [name, login] of Object.entries(HOSTILE_LOGINS)) {
    it(`writes a login with ${name} as escaped code with no link`, () => {
      const output = loginLink(login);
      assert.equal(output, escapeText(login));
      assert.ok(!output.includes("]("), output);
      assert.ok(!output.includes("github.com"), output);
      assert.ok(!output.includes("@"), output);
    });
  }
});

describe("markerJson", () => {
  const values = [
    { path: "a --> b", note: "<!-- x -->" },
    { path: "--->", members: ["a&b", "<script>", "----"] },
    { n: -1, list: [-2, 3.5e-7], text: "-", s: "x-y" },
    "-->",
  ];

  for (const value of values) {
    it(`holds no <, >, & or -- and parses back for ${JSON.stringify(value)}`, () => {
      const json = markerJson(value);
      assert.ok(!/[<>&]/.test(json), json);
      assert.ok(!json.includes("--"), json);
      assert.deepEqual(JSON.parse(json), value);
    });
  }

  it("is one line", () => {
    const json = markerJson({ text: "a\nb\r\nc\u2028d" });
    assert.ok(!/[\n\r]/.test(json));
  });
});

describe("logLine", () => {
  const values = [
    "##[error]x",
    { path: "##[set-output name=changed]false" },
    "::error::x",
    { detail: "ok\n::add-mask::x" },
    ["a\r::warning::b", "c\u2028::error::d", "e\u0085::notice::f"],
    { nested: { list: ["#1", "##[group]g"] } },
  ];

  for (const value of values) {
    it(`is one safe line that parses back for ${JSON.stringify(value)}`, () => {
      const line = logLine(value);
      assert.ok(!/[\n\r\u0085\u2028\u2029]/.test(line), line);
      assert.ok(!line.includes("#"), line);
      assert.match(line, /^["{[0-9tfn-]/);
      assert.ok(!line.trimStart().startsWith("::"));
      assert.deepEqual(JSON.parse(line), value);
    });
  }

  it("writes values JSON cannot represent as null", () => {
    assert.equal(logLine(undefined), "null");
    assert.equal(
      logLine(() => 1),
      "null",
    );
  });

  it("writes numbers, booleans and null as JSON tokens", () => {
    assert.equal(logLine(3), "3");
    assert.equal(logLine(false), "false");
    assert.equal(logLine(null), "null");
  });
});

describe("annotation", () => {
  it("builds an annotation from a fixed message", () => {
    assert.equal(annotation("error", "toolFailed"), `::error::${ANNOTATION_MESSAGES.toolFailed}`);
  });

  it("fills placeholders with numbers", () => {
    assert.equal(
      annotation("error", "apiFailed", [502]),
      "::error::A GitHub API request failed with status 502. The detail is on the next line.",
    );
    assert.equal(
      annotation("warning", "mapperFailed", [2]),
      "::warning::2 member mapper runs failed. The detail is on the next line.",
    );
  });

  it("rejects a message outside the fixed set", () => {
    assert.throws(() => annotation("error", "::add-mask::x"), TypeError);
    assert.throws(() => annotation("error", "toString"), TypeError);
  });

  it("rejects an unknown level", () => {
    assert.throws(() => annotation("add-mask", "toolFailed"), TypeError);
  });

  it("rejects arguments that are not finite numbers", () => {
    assert.throws(() => annotation("error", "apiFailed", ["502"]), TypeError);
    assert.throws(() => annotation("error", "apiFailed", ["\n::add-mask::x"]), TypeError);
    assert.throws(() => annotation("error", "apiFailed", [Number.NaN]), TypeError);
    assert.throws(() => annotation("error", "apiFailed", [Number.POSITIVE_INFINITY]), TypeError);
  });

  it("rejects a wrong number of arguments", () => {
    assert.throws(() => annotation("error", "apiFailed"), TypeError);
    assert.throws(() => annotation("error", "toolFailed", [1]), TypeError);
  });

  it("uses messages that hold no command syntax", () => {
    for (const message of Object.values(ANNOTATION_MESSAGES)) {
      assert.ok(!message.includes("::"), message);
      assert.ok(!/[#%\r\n]/.test(message), message);
    }
  });
});
