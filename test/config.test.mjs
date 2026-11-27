import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, defaultConfig, loadConfig, resolveConfig } from "../lib/config.mjs";
import { registry } from "../members/registry.mjs";

const dir = mkdtempSync(join(tmpdir(), "pr-conflict-radar-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let fileCount = 0;
function writeConfig(value) {
  fileCount += 1;
  const path = join(dir, `config-${fileCount}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const load = (value) => loadConfig(writeConfig(value));

// Asserts that loading `value` fails with a ConfigError whose message names
// every string in `names`.
function rejects(value, ...names) {
  assert.throws(
    () => load(value),
    (error) => {
      assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${error}`);
      for (const name of names) {
        assert.ok(error.message.includes(name), `${JSON.stringify(error.message)} names ${name}`);
      }
      return true;
    },
  );
}

const LANGUAGES = ["typescript", "csharp", "go", "rust", "cpp"];

describe("loadConfig defaults", () => {
  const config = loadConfig(join(dir, "absent.json"));

  it("returns the documented defaults when the file is absent", () => {
    assert.equal(config.checkName, "PR conflict radar");
    assert.deepEqual(config.classes, [
      { name: "docs", patterns: ["**/*.md"] },
      { name: "tests", patterns: ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"] },
      { name: "code", patterns: ["**"] },
    ]);
    assert.deepEqual(config.severity, ["docs", "tests", "code"]);
    assert.deepEqual(config.commentClasses, ["tests", "code"]);
    assert.deepEqual(config.order, { labelPriority: [] });
    assert.equal(config.pairKey, "conflict/{repo}/{low}+{high}");
    assert.equal(config.maxPrs, 40);
    assert.equal(config.members.minNameLength, 4);
    assert.equal(config.members.maxFileBytes, 1000000);
    assert.ok(config.members.ignoreNames.includes("GetHashCode"));
    assert.equal(config.members.ignoreNames.length, 33);
  });

  it("suggests peerbus by default", () => {
    assert.equal(config.suggestPeerbus, true);
  });

  it("puts all five languages on auto, in registry order, with their patterns", () => {
    const languageKeys = Object.keys(config.members).filter((key) => LANGUAGES.includes(key));
    assert.deepEqual(languageKeys, LANGUAGES);
    assert.deepEqual(
      registry.map((entry) => entry.key),
      LANGUAGES,
    );
    for (const entry of registry) {
      assert.equal(config.members[entry.key].enabled, "auto");
      assert.deepEqual(config.members[entry.key].patterns, [...entry.patterns]);
    }
    assert.deepEqual(config.members.typescript.patterns, [
      "**/*.ts",
      "**/*.tsx",
      "**/*.mts",
      "**/*.cts",
      "**/*.js",
      "**/*.jsx",
      "**/*.mjs",
      "**/*.cjs",
    ]);
    assert.deepEqual(config.members.cpp.patterns, [
      "**/*.c",
      "**/*.h",
      "**/*.cc",
      "**/*.cpp",
      "**/*.cxx",
      "**/*.hh",
      "**/*.hpp",
      "**/*.hxx",
    ]);
  });

  it("defaults members.cpp.defines to an empty list", () => {
    assert.deepEqual(config.members.cpp.defines, []);
  });

  it("matches the defaults of an empty file and of defaultConfig()", () => {
    assert.deepEqual(load({}), config);
    assert.deepEqual(defaultConfig(), config);
  });

  it("returns a fresh copy each time", () => {
    const first = loadConfig(join(dir, "absent.json"));
    first.classes.push({ name: "x", patterns: [] });
    first.members.go.patterns.push("**/*.x");
    first.members.cpp.defines.push("X");
    assert.deepEqual(loadConfig(join(dir, "absent.json")), config);
  });
});

describe("loadConfig overrides", () => {
  it("overrides only the keys a partial file holds", () => {
    const config = load({ checkName: "Radar", maxPrs: 10, order: { labelPriority: ["urgent"] } });
    const defaults = defaultConfig();
    assert.deepEqual(config, {
      ...defaults,
      checkName: "Radar",
      maxPrs: 10,
      order: { labelPriority: ["urgent"] },
    });
  });

  it("keeps the other members keys when one is overridden", () => {
    const config = load({ members: { minNameLength: 6 } });
    assert.deepEqual(config.members, { ...defaultConfig().members, minNameLength: 6 });
  });

  it("keeps the default patterns when only enabled is set", () => {
    const csharp = load({ members: { csharp: { enabled: true } } });
    assert.equal(csharp.members.csharp.enabled, true);
    assert.deepEqual(csharp.members.csharp.patterns, ["**/*.cs"]);
    assert.equal(csharp.members.rust.enabled, "auto");

    const rust = load({ members: { rust: { enabled: false } } });
    assert.equal(rust.members.rust.enabled, false);
    assert.deepEqual(rust.members.rust.patterns, ["**/*.rs"]);
    assert.equal(rust.members.csharp.enabled, "auto");
  });

  it("replaces a default list whole", () => {
    const config = load({
      members: { typescript: { patterns: ["**/*.ts"] }, ignoreNames: ["Foo"] },
      commentClasses: ["code"],
    });
    assert.deepEqual(config.members.typescript.patterns, ["**/*.ts"]);
    assert.deepEqual(config.members.ignoreNames, ["Foo"]);
    assert.deepEqual(config.commentClasses, ["code"]);
  });

  it("replaces the classes with severity and commentClasses to match", () => {
    const config = load({
      classes: [
        { name: "generated", patterns: ["gen/**"] },
        { name: "source", patterns: ["**"] },
      ],
      severity: ["generated", "source"],
      commentClasses: ["source"],
    });
    assert.deepEqual(
      config.classes.map((cls) => cls.name),
      ["generated", "source"],
    );
  });

  it("turns suggestPeerbus off and keeps the pair key", () => {
    const config = load({ suggestPeerbus: false });
    assert.equal(config.suggestPeerbus, false);
    assert.equal(config.pairKey, "conflict/{repo}/{low}+{high}");
  });

  it("accepts a pair key with every placeholder", () => {
    assert.equal(
      load({ pairKey: "{owner}/{repo}#{low}-{high}" }).pairKey,
      "{owner}/{repo}#{low}-{high}",
    );
  });

  it("accepts maxPrs at both ends of its range", () => {
    assert.equal(load({ maxPrs: 1 }).maxPrs, 1);
    assert.equal(load({ maxPrs: 200 }).maxPrs, 200);
  });

  it("accepts the cpp defines of both forms", () => {
    const defines = ["APIENTRY", "BEGIN_MESSAGE_MAP(...)", "_EXPORT", "WINAPI"];
    assert.deepEqual(load({ members: { cpp: { defines } } }).members.cpp.defines, defines);
    const many = Array.from({ length: 200 }, (_, i) => `M${i}`);
    assert.equal(load({ members: { cpp: { defines: many } } }).members.cpp.defines.length, 200);
  });

  it("reads a file that starts with a byte order mark", () => {
    assert.equal(load(`﻿${JSON.stringify({ maxPrs: 3 })}`).maxPrs, 3);
  });
});

describe("loadConfig validation", () => {
  it("reports a type error for a suggestPeerbus that is not a boolean", () => {
    rejects({ suggestPeerbus: "no" }, "suggestPeerbus", "boolean");
  });

  it("reports an unknown language key", () => {
    rejects({ members: { java: { enabled: true } } }, "unknown key", "members.java");
  });

  it("reports an unknown key at every level", () => {
    rejects({ colour: "red" }, "unknown key", "colour");
    rejects({ order: { byAge: true } }, "unknown key", "order.byAge");
    rejects({ members: { maxFiles: 3 } }, "unknown key", "members.maxFiles");
    rejects({ members: { go: { defines: [] } } }, "unknown key", "members.go.defines");
    rejects({ members: { go: { tags: [] } } }, "unknown key", "members.go.tags");
    rejects(
      { classes: [{ name: "code", patterns: ["**"], weight: 1 }] },
      "unknown key",
      "classes[0].weight",
    );
  });

  it("does not treat inherited property names as keys", () => {
    rejects('{"__proto__": {"checkName": "x"}}', "unknown key", "__proto__");
    rejects({ toString: "x" }, "unknown key", "toString");
    rejects({ members: { constructor: {} } }, "unknown key", "members.constructor");
  });

  it("refuses malformed cpp defines, naming the entry", () => {
    for (const bad of ["A B", "X=1", "-Dfoo", "F(x)", "1X", "F(...) ", "", 7]) {
      rejects(
        { members: { cpp: { defines: ["OK", bad] } } },
        "members.cpp.defines[1]",
        JSON.stringify(bad),
      );
    }
  });

  it("refuses a cpp defines list of 201 entries and one that is not a list", () => {
    const many = Array.from({ length: 201 }, (_, i) => `M${i}`);
    rejects({ members: { cpp: { defines: many } } }, "members.cpp.defines", "201", "200");
    rejects({ members: { cpp: { defines: "APIENTRY" } } }, "members.cpp.defines", "list");
  });

  it("refuses an unknown class in commentClasses", () => {
    rejects({ commentClasses: ["code", "docz"] }, "commentClasses[1]", '"docz"');
  });

  it("refuses a severity that misses, repeats or invents a class", () => {
    rejects({ severity: ["docs", "code"] }, "severity", "misses", '"tests"');
    rejects({ severity: ["docs", "tests", "code", "docs"] }, "severity", "twice", '"docs"');
    rejects(
      { severity: ["docs", "tests", "code", "vendor"] },
      "severity[3]",
      "unknown",
      '"vendor"',
    );
  });

  it("refuses empty classes and malformed class entries", () => {
    rejects({ classes: [] }, "classes", "non-empty");
    rejects({ classes: "code" }, "classes", "non-empty");
    rejects({ classes: ["code"] }, "classes[0]");
    rejects({ classes: [{ patterns: ["**"] }] }, "classes[0].name");
    rejects({ classes: [{ name: "code" }] }, "classes[0].patterns");
    rejects({ classes: [{ name: "code", patterns: [""] }] }, "classes[0].patterns[0]");
    rejects(
      {
        classes: [
          { name: "code", patterns: ["a/**"] },
          { name: "code", patterns: ["**"] },
        ],
      },
      "classes[1].name",
      '"code"',
    );
  });

  it("refuses a maxPrs outside 1 to 200", () => {
    for (const value of [0, 201, -1, 1.5, "40", null]) {
      rejects({ maxPrs: value }, "maxPrs", "1", "200");
    }
  });

  it("refuses a pairKey with an unknown placeholder", () => {
    rejects({ pairKey: "conflict/{repository}/{low}+{high}" }, "pairKey", "{repository}");
    rejects({ pairKey: "conflict/{}/{low}" }, "pairKey", "{}");
    rejects({ pairKey: "" }, "pairKey", "non-empty");
    rejects({ pairKey: 12 }, "pairKey");
  });

  it("refuses an enabled other than auto, true and false", () => {
    for (const value of ["yes", "true", 1, null, "Auto"]) {
      rejects(
        { members: { go: { enabled: value } } },
        "members.go.enabled",
        '"auto", true or false',
      );
    }
  });

  it("checks each type rule", () => {
    rejects({ checkName: "" }, "checkName", "non-empty string");
    rejects({ checkName: 5 }, "checkName", "non-empty string");
    rejects({ members: { go: { patterns: "**/*.go" } } }, "members.go.patterns", "list");
    rejects({ members: { go: { patterns: ["**/*.go", ""] } } }, "members.go.patterns[1]");
    rejects({ members: { ignoreNames: ["Name", 3] } }, "members.ignoreNames[1]");
    rejects({ order: { labelPriority: "urgent" } }, "order.labelPriority", "list");
    rejects({ order: { labelPriority: [""] } }, "order.labelPriority[0]");
    rejects({ members: { minNameLength: -1 } }, "members.minNameLength", "integer");
    rejects({ members: { minNameLength: 2.5 } }, "members.minNameLength", "integer");
    rejects({ members: { maxFileBytes: 0 } }, "members.maxFileBytes", "integer");
    rejects({ members: { maxFileBytes: "1000" } }, "members.maxFileBytes", "integer");
  });

  it("accepts a minNameLength of zero", () => {
    assert.equal(load({ members: { minNameLength: 0 } }).members.minNameLength, 0);
  });

  it("refuses order, members and a language entry that are not objects", () => {
    rejects({ order: [] }, "order", "object");
    rejects({ members: null }, "members", "object");
    rejects({ members: { rust: true } }, "members.rust", "object");
  });

  it("refuses a file that is not a JSON object or not JSON", () => {
    rejects([], "JSON object");
    rejects("null", "JSON object");
    rejects("{ not json", "not valid JSON");
  });

  it("records the field on the error", () => {
    try {
      load({ suggestPeerbus: "no" });
      assert.fail("expected an error");
    } catch (error) {
      assert.equal(error.field, "suggestPeerbus");
    }
  });
});

describe("registry injection", () => {
  const extra = [
    ...registry,
    {
      key: "kotlin",
      patterns: ["**/*.kt", "**/*.kts"],
      options: {
        flavours: {
          default: ["jvm"],
          validate: (value, field) => (Array.isArray(value) ? null : `${field} must be a list`),
        },
      },
    },
  ];

  it("turns an extra registry entry into a config key with its defaults", () => {
    const config = loadConfig(join(dir, "absent.json"), { registry: extra });
    assert.deepEqual(config.members.kotlin, {
      enabled: "auto",
      patterns: ["**/*.kt", "**/*.kts"],
      flavours: ["jvm"],
    });
    assert.deepEqual(defaultConfig({ registry: extra }), config);
  });

  it("overrides and validates the extra entry like any other", () => {
    const path = writeConfig({ members: { kotlin: { enabled: false } } });
    const config = loadConfig(path, { registry: extra });
    assert.equal(config.members.kotlin.enabled, false);
    assert.deepEqual(config.members.kotlin.patterns, ["**/*.kt", "**/*.kts"]);

    const bad = writeConfig({ members: { kotlin: { flavours: "jvm" } } });
    assert.throws(
      () => loadConfig(bad, { registry: extra }),
      /members\.kotlin\.flavours must be a list/,
    );
    const unknown = writeConfig({ members: { kotlin: { patternz: [] } } });
    assert.throws(
      () => loadConfig(unknown, { registry: extra }),
      /unknown key members\.kotlin\.patternz/,
    );
  });

  it("keeps the extra key unknown without the entry", () => {
    rejects({ members: { kotlin: { enabled: false } } }, "unknown key", "members.kotlin");
  });

  it("resolves an object without a file", () => {
    assert.equal(resolveConfig({ maxPrs: 5 }).maxPrs, 5);
    assert.equal(
      resolveConfig({ members: { kotlin: {} } }, { registry: extra }).members.kotlin.enabled,
      "auto",
    );
  });
});
