import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { defaultConfig } from "../lib/config.mjs";
import { registry } from "../members/registry.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json"));

// The lines of the README between the heading `## <title>` and the next
// heading of the same level.
function section(title) {
  const lines = readme.split("\n");
  const start = lines.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `README has no "## ${title}" section`);
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n");
}

// The first cell of every table row of `text` that holds one backticked name.
function firstCells(text) {
  const cells = [];
  for (const line of text.split("\n")) {
    const match = /^\| `([^`]+)` \|/.exec(line);
    if (match) cells.push(match[1]);
  }
  return cells;
}

// The dotted paths of the config keys a config file can set: every top-level
// key, and the keys of `order` and of `members` and its languages.
function configKeys(config) {
  const keys = [];
  for (const [key, value] of Object.entries(config)) {
    const nested = key === "order" || key === "members";
    if (!nested) {
      keys.push(key);
      continue;
    }
    for (const [sub, subValue] of Object.entries(value)) {
      const isLanguage = registry.some((entry) => entry.key === sub);
      if (isLanguage) {
        for (const option of Object.keys(subValue)) keys.push(`${key}.${sub}.${option}`);
      } else {
        keys.push(`${key}.${sub}`);
      }
    }
  }
  return keys;
}

const yamlBlocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]);

describe("README configuration reference", () => {
  const documented = firstCells(section("Configuration"));

  it("lists every config key once, and no other key", () => {
    assert.deepEqual([...documented].sort(), configKeys(defaultConfig()).sort());
  });

  it("lists the keys of every registry language", () => {
    for (const entry of registry) {
      assert.ok(documented.includes(`members.${entry.key}.enabled`), entry.key);
      assert.ok(documented.includes(`members.${entry.key}.patterns`), entry.key);
    }
  });

  it("states the default of each scalar key", () => {
    const config = defaultConfig();
    const text = section("Configuration");
    for (const key of ["checkName", "pairKey"]) {
      assert.ok(text.includes(`\`${JSON.stringify(config[key])}\``), key);
    }
    assert.ok(text.includes(`\`${config.maxPrs}\``));
    assert.ok(text.includes(`\`${config.members.minNameLength}\``));
    assert.ok(text.includes(`\`${config.members.maxFileBytes}\``));
    assert.ok(text.includes(`\`${config.suggestPeerbus}\``));
  });

  it("lists every default ignored name", () => {
    for (const name of defaultConfig().members.ignoreNames) {
      assert.ok(section("Configuration").includes(`\`${name}\``), name);
    }
  });

  it("lists every default class pattern", () => {
    for (const cls of defaultConfig().classes) {
      assert.ok(section("Configuration").includes(`\`${cls.name}\`: `), cls.name);
      for (const pattern of cls.patterns) {
        assert.ok(section("Configuration").includes(`\`${pattern}\``), pattern);
      }
    }
  });
});

describe("README action inputs", () => {
  it("lists every input of action.yml with its default, and no other", () => {
    const action = parse(read("action.yml"));
    const start = readme.indexOf("### The inputs");
    const end = readme.indexOf("\n## ", start);
    const text = readme.slice(start, end);
    const rows = text.split("\n").filter((line) => /^\| `[^`]+` \|/.test(line));
    const documented = rows.map((row) => row.split("|").map((cell) => cell.trim()));
    assert.deepEqual(
      documented.map((cells) => cells[1]),
      Object.keys(action.inputs).map((name) => `\`${name}\``),
    );
    for (const cells of documented) {
      const name = cells[1].replaceAll("`", "");
      const expected = String(action.inputs[name].default);
      assert.equal(cells[2], `\`${expected}\``, name);
    }
    for (const name of Object.keys(action.outputs)) {
      assert.ok(text.includes(`\`${name}\``), name);
    }
  });
});

describe("README member overlap section", () => {
  const text = section("Member overlap");

  it("names every registry language with its key and default patterns", () => {
    for (const entry of registry) {
      assert.ok(text.includes(`| \`${entry.key}\` |`), `the key ${entry.key}`);
      const row = text.split("\n").find((line) => line.includes(`| \`${entry.key}\` |`));
      for (const pattern of entry.patterns) {
        assert.ok(row.includes(`\`${pattern}\``), `${entry.key}: ${pattern}`);
      }
    }
  });
});

describe("README example workflows", () => {
  const withoutSha = (workflow) => {
    const copy = structuredClone(workflow);
    for (const job of Object.values(copy.jobs)) {
      for (const step of job.steps) {
        if (typeof step.uses === "string" && step.uses.startsWith("nnemirovsky/")) {
          step.uses = step.uses.replace(/@.*$/, "");
        }
      }
    }
    return copy;
  };

  for (const name of ["pr-conflict-radar-trigger", "pr-conflict-radar"]) {
    it(`${name}.yml equals its block in the README apart from the pinned SHA`, () => {
      const example = parse(read(`examples/${name}.yml`));
      const block = yamlBlocks.map((yaml) => parse(yaml)).find((doc) => doc.name === name);
      assert.ok(block, `the README has a yaml block named ${name}`);
      assert.deepEqual(withoutSha(block), withoutSha(example));
    });
  }

  it("pins the action by a placeholder with the release tag in the README", () => {
    assert.ok(
      readme.includes(`uses: nnemirovsky/pr-conflict-radar@<commit SHA> # v${pkg.version}`),
    );
  });
});

describe("README release wording", () => {
  const released = /^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version !== "0.0.0";

  it("carries no status line", () => {
    const status = readme
      .split("\n")
      .filter(
        (line) => /^[\s>*_#-]*status\b[*_]*\s*:/i.test(line) || /^#+\s*status\s*$/i.test(line),
      );
    assert.deepEqual(status, []);
  });

  it("claims nowhere that nothing is released", {
    skip: !released && "package.json carries no release version",
  }, () => {
    const claims = [
      /\b(?:not|never) (?:yet )?(?:been )?released\b/i,
      /\bunreleased\b/i,
      /\bno (?:release|version|tag)s? (?:yet|exists?|has been)\b/i,
      /\bnothing (?:is |has been )?(?:yet )?released\b/i,
      /\b(?:before|until|ahead of) the first release\b/i,
      /\bpre-?release\b/i,
      /\bwork in progress\b/i,
    ];
    for (const claim of claims) assert.doesNotMatch(readme, claim);
  });
});

describe("README peerbus mentions", () => {
  it("links the peerbus repository", () => {
    assert.ok(readme.includes("https://github.com/nnemirovsky/peerbus"));
  });
});
