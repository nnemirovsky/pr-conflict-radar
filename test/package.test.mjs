import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const readText = (path) => readFileSync(new URL(path, root), "utf8");

// Semantic Versioning 2.0.0, the regular expression the specification suggests.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));
}

describe("package.json", () => {
  const pkg = JSON.parse(readText("package.json"));

  it("carries a semver version", () => {
    assert.match(pkg.version, SEMVER);
  });

  it("is an ES module package", () => {
    assert.equal(pkg.type, "module");
  });

  it("defines the test and lint scripts", () => {
    assert.equal(pkg.scripts.test, "node --test test/*.test.mjs");
    assert.equal(pkg.scripts.lint, "biome check .");
  });

  it("requires Node 20 or newer", () => {
    assert.equal(pkg.engines.node, ">=20");
  });

  it("keeps Biome and yaml as dev dependencies only", () => {
    assert.ok(pkg.devDependencies["@biomejs/biome"]);
    assert.ok(pkg.devDependencies.yaml);
    assert.equal(pkg.dependencies?.["@biomejs/biome"], undefined);
    assert.equal(pkg.dependencies?.yaml, undefined);
  });
});

describe("ci.yml", () => {
  const ci = parse(readText(".github/workflows/ci.yml"));

  it("has jobs named test and lint", () => {
    assert.equal(ci.jobs.test?.name, "test");
    assert.equal(ci.jobs.lint?.name, "lint");
  });

  it("grants contents: read at the top level", () => {
    assert.deepEqual(ci.permissions, { contents: "read" });
  });

  it("has no paths filter", () => {
    assert.equal(hasKey(ci, "paths"), false);
    assert.equal(hasKey(ci, "paths-ignore"), false);
  });

  it("sets up .NET in the test job before the suite runs", () => {
    const uses = ci.jobs.test.steps.map((step) => step.uses ?? "");
    const dotnet = uses.findIndex((value) => value.startsWith("actions/setup-dotnet@v6"));
    assert.ok(dotnet >= 0);
    const suite = ci.jobs.test.steps.findIndex((step) => step.run?.includes("npm test"));
    assert.ok(dotnet < suite);
  });

  it("runs on pull requests, pushes to main and manual dispatch", () => {
    assert.ok("pull_request" in ci.on);
    assert.deepEqual(ci.on.push.branches, ["main"]);
    assert.ok("workflow_dispatch" in ci.on);
  });
});
