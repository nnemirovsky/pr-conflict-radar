import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classOf, globToRegExp, matchGlob, mostSevere, pairKey } from "../lib/classify.mjs";
import { defaultConfig, resolveConfig } from "../lib/config.mjs";

const defaults = defaultConfig();

describe("glob matching for the language patterns", () => {
  it("matches **/*.h at the root and nested, and not .hpp", () => {
    assert.equal(matchGlob("a.h", "**/*.h"), true);
    assert.equal(matchGlob("src/x/a.h", "**/*.h"), true);
    assert.equal(matchGlob("a.hpp", "**/*.h"), false);
    assert.equal(matchGlob("src/x/a.hpp", "**/*.h"), false);
  });

  it("does not match a.cc with **/*.c", () => {
    assert.equal(matchGlob("a.cc", "**/*.c"), false);
    assert.equal(matchGlob("a.c", "**/*.c"), true);
  });

  it("matches types.d.ts with **/*.ts", () => {
    assert.equal(matchGlob("types.d.ts", "**/*.ts"), true);
    assert.equal(matchGlob("src/types.d.ts", "**/*.ts"), true);
    assert.equal(matchGlob("src/a.tsx", "**/*.ts"), false);
  });

  it("matches scripts/run.mjs with **/*.mjs", () => {
    assert.equal(matchGlob("scripts/run.mjs", "**/*.mjs"), true);
    assert.equal(matchGlob("scripts/run.js", "**/*.mjs"), false);
  });
});

describe("glob matching", () => {
  it("matches nested paths with ** across segments", () => {
    assert.equal(matchGlob("a/b/c/d.txt", "a/**"), true);
    assert.equal(matchGlob("a/b/c/d.txt", "a/**/d.txt"), true);
    assert.equal(matchGlob("a/d.txt", "a/**/d.txt"), true);
    assert.equal(matchGlob("b/a/d.txt", "a/**"), false);
    assert.equal(matchGlob("x/y", "**"), true);
    assert.equal(matchGlob("README.md", "**"), true);
  });

  it("keeps * within one segment", () => {
    assert.equal(matchGlob("src/a.js", "src/*.js"), true);
    assert.equal(matchGlob("src/lib/a.js", "src/*.js"), false);
    assert.equal(matchGlob("src/a.js", "*.js"), false);
    assert.equal(matchGlob("a.js", "*.js"), true);
  });

  it("matches extension patterns literally", () => {
    assert.equal(matchGlob("a.test.js", "**/*.test.*"), true);
    assert.equal(matchGlob("pkg/a.test.ts", "**/*.test.*"), true);
    assert.equal(matchGlob("atest.js", "**/*.test.*"), false);
    assert.equal(matchGlob("aXmd", "**/*.md"), false);
  });

  it("matches inside dot directories and dot files", () => {
    assert.equal(matchGlob(".github/workflows/ci.yml", "**/*.yml"), true);
    assert.equal(matchGlob(".github/README.md", "**/*.md"), true);
    assert.equal(matchGlob(".config/test/a.js", "**/test/**"), true);
    assert.equal(matchGlob(".eslintrc.js", "*.js"), true);
  });

  it("matches a root-level file against **/*.md", () => {
    assert.equal(matchGlob("README.md", "**/*.md"), true);
    assert.equal(matchGlob("docs/guide/intro.md", "**/*.md"), true);
  });

  it("matches **/test/** with zero or more leading directories", () => {
    assert.equal(matchGlob("test/a.js", "**/test/**"), true);
    assert.equal(matchGlob("pkg/test/a.js", "**/test/**"), true);
    assert.equal(matchGlob("pkg/testing/a.js", "**/test/**"), false);
    assert.equal(matchGlob("latest/a.js", "**/test/**"), false);
  });

  it("treats regular-expression characters as literal", () => {
    assert.equal(matchGlob("a+b(c).md", "a+b(c).md"), true);
    assert.equal(matchGlob("aab(c).md", "a+b(c).md"), false);
    assert.equal(matchGlob("x/[id].tsx", "**/[id].tsx"), true);
    assert.equal(matchGlob("x/i.tsx", "**/[id].tsx"), false);
    assert.equal(matchGlob("a?c", "a?c"), true);
    assert.equal(matchGlob("abc", "a?c"), false);
    assert.equal(matchGlob("a$b^c{1}|d\\e", "a$b^c{1}|d\\e"), true);
  });

  it("matches paths with spaces and line breaks", () => {
    assert.equal(matchGlob("docs/my file.md", "**/*.md"), true);
    assert.equal(matchGlob("docs/line\nbreak.md", "**/*.md"), true);
    assert.equal(matchGlob("src/a.md\nb.js", "**/*.md"), false);
  });

  it("anchors the whole path", () => {
    assert.equal(globToRegExp("src/*.js").test("x/src/a.js"), false);
    assert.equal(globToRegExp("src/*.js").test("src/a.jsx"), false);
  });
});

describe("classOf with the defaults", () => {
  it("resolves docs, tests and code", () => {
    assert.equal(classOf("README.md", defaults), "docs");
    assert.equal(classOf("docs/guide.md", defaults), "docs");
    assert.equal(classOf("test/config.test.mjs", defaults), "tests");
    assert.equal(classOf("pkg/tests/fixture.json", defaults), "tests");
    assert.equal(classOf("src/cart.spec.ts", defaults), "tests");
    assert.equal(classOf("src/cart/total.ts", defaults), "code");
    assert.equal(classOf("package.json", defaults), "code");
  });

  it("takes the first matching class", () => {
    assert.equal(classOf("test/README.md", defaults), "docs");
    assert.equal(classOf("src/a.test.md", defaults), "docs");
  });

  it("gives a file that matches no class the most severe class", () => {
    const config = resolveConfig({
      classes: [
        { name: "docs", patterns: ["**/*.md"] },
        { name: "source", patterns: ["src/**"] },
        { name: "build", patterns: ["Makefile"] },
      ],
      severity: ["docs", "build", "source"],
      commentClasses: ["source"],
    });
    assert.equal(classOf("README.md", config), "docs");
    assert.equal(classOf("Makefile", config), "build");
    assert.equal(classOf("scripts/deploy.sh", config), "source");
  });
});

describe("mostSevere", () => {
  it("follows severity from the least to the most severe", () => {
    assert.equal(mostSevere(["docs", "tests"], defaults), "tests");
    assert.equal(mostSevere(["code", "docs"], defaults), "code");
    assert.equal(mostSevere(["docs"], defaults), "docs");
    assert.equal(mostSevere(["docs", "docs"], defaults), "docs");
  });

  it("reverses with a reversed severity", () => {
    const config = resolveConfig({ severity: ["code", "tests", "docs"] });
    assert.equal(mostSevere(["docs", "code"], config), "docs");
    assert.equal(mostSevere(["tests", "code"], config), "tests");
    assert.equal(classOf("lib/x.unknown", { ...config, classes: [] }), "docs");
  });

  it("returns null for no classes", () => {
    assert.equal(mostSevere([], defaults), null);
  });
});

describe("pairKey", () => {
  it("puts the lower number first", () => {
    assert.equal(pairKey(defaults, "acme/widgets", 12, 15), "conflict/widgets/12+15");
    assert.equal(pairKey(defaults, "acme/widgets", 15, 12), "conflict/widgets/12+15");
  });

  it("compares numbers, not strings", () => {
    assert.equal(pairKey(defaults, "acme/widgets", 100, 9), "conflict/widgets/9+100");
  });

  it("fills a custom template with every placeholder", () => {
    const config = resolveConfig({ pairKey: "{owner}.{repo}:{high}-{low}:{low}" });
    assert.equal(pairKey(config, "acme/widgets", 15, 12), "acme.widgets:15-12:12");
  });

  it("does not expand placeholder-like text inside a value", () => {
    const config = resolveConfig({ pairKey: "{repo}/{low}" });
    assert.equal(pairKey(config, "acme/{low}", 12, 15), "{low}/12");
  });
});
