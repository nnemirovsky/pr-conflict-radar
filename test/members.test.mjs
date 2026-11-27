import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultConfig, resolveConfig } from "../lib/config.mjs";
import { BuildError, mapperDir, mappersNeeded, runBuild } from "../lib/members.mjs";

const keys = ["typescript", "csharp", "go", "rust", "cpp"];

const configWith = (members) => resolveConfig({ members });

describe("mappersNeeded", () => {
  it("is all false on auto with no changed file", () => {
    assert.deepEqual(
      mappersNeeded(defaultConfig(), []),
      Object.fromEntries(keys.map((key) => [key, false])),
    );
  });

  it("turns auto on for a changed file that matches the patterns", () => {
    const needed = mappersNeeded(defaultConfig(), ["src/cart.go", "docs/readme.md"]);
    assert.deepEqual(needed, {
      typescript: false,
      csharp: false,
      go: true,
      rust: false,
      cpp: false,
    });
  });

  it("is true for an enabled mapper with no changed file and false for a disabled one with one", () => {
    const config = configWith({ csharp: { enabled: true }, go: { enabled: false } });
    const needed = mappersNeeded(config, ["main.go"]);
    assert.equal(needed.csharp, true);
    assert.equal(needed.go, false);
  });

  it("turns cpp on for a .h file and typescript on for a .jsx file", () => {
    assert.equal(mappersNeeded(defaultConfig(), ["include/widget.h"]).cpp, true);
    assert.equal(mappersNeeded(defaultConfig(), ["ui/App.jsx"]).typescript, true);
    assert.equal(mappersNeeded(defaultConfig(), ["ui/App.jsx"]).cpp, false);
  });

  it("reads only the files it is given", () => {
    // The caller passes the changed files of the simulated pull requests only.
    const needed = mappersNeeded(defaultConfig(), ["a.md"]);
    assert.ok(Object.values(needed).every((value) => value === false));
  });

  it("answers for each entry of an injected registry, in its order", () => {
    const registry = [
      { key: "alpha", patterns: ["**/*.al"] },
      { key: "beta", patterns: ["**/*.be"] },
    ];
    const config = resolveConfig({}, { registry });
    const needed = mappersNeeded(config, ["x/y.be"], { registry });
    assert.deepEqual(Object.entries(needed), [
      ["alpha", false],
      ["beta", true],
    ]);
  });
});

describe("runBuild", () => {
  const entryFor = (command, args, extra = {}) => ({
    key: "fake",
    patterns: [],
    build: ({ dir, work, env }) => [
      { command, args, cwd: work, env: { ...env, MAPPER_DIR: dir, ...extra } },
    ],
  });

  it("runs the build once, with its working directory and environment, and captures output", async () => {
    const work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-build-"));
    const counter = join(work, "count");
    try {
      const script =
        "require('node:fs').appendFileSync(process.argv[1], 'x');" +
        "console.log(JSON.stringify([process.cwd(), process.env.MAPPER_DIR]));" +
        "console.error('warned')";
      const reports = await runBuild(entryFor(process.execPath, ["-e", script, counter]), {
        dir: "/mapper/dir",
        work,
      });
      assert.equal(readFileSync(counter, "utf8"), "x");
      assert.equal(reports.length, 1);
      assert.equal(reports[0].code, 0);
      assert.equal(reports[0].stderr.trim(), "warned");
      const [cwd, dir] = JSON.parse(reports[0].stdout);
      assert.equal(cwd, realpathSync(work));
      assert.equal(dir, "/mapper/dir");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("fails with a message naming the tool when the command is missing", async () => {
    await assert.rejects(
      runBuild(entryFor("pr-conflict-radar-no-such-tool", []), { work: tmpdir() }),
      (error) => {
        assert.ok(error instanceof BuildError);
        assert.match(error.message, /pr-conflict-radar-no-such-tool/);
        assert.match(error.message, /install it/);
        return true;
      },
    );
  });

  it("fails on a non-zero exit and keeps the report", async () => {
    await assert.rejects(
      runBuild(entryFor(process.execPath, ["-e", "console.log('partial'); process.exit(3)"]), {
        work: tmpdir(),
      }),
      (error) => {
        assert.match(error.message, /exited with code 3/);
        assert.equal(error.output.length, 1);
        assert.equal(error.output[0].stdout.trim(), "partial");
        return true;
      },
    );
  });

  it("stops at the first failing step", async () => {
    const entry = {
      key: "fake",
      build: () => [
        { command: process.execPath, args: ["-e", "process.exit(1)"] },
        { command: process.execPath, args: ["-e", "console.log('never')"] },
      ],
    };
    await assert.rejects(runBuild(entry, { work: tmpdir() }), (error) => {
      assert.equal(error.output.length, 1);
      return true;
    });
  });

  it("rejects an entry without a build", async () => {
    await assert.rejects(runBuild({ key: "go" }, { work: tmpdir() }), /no build yet/);
  });

  it("takes the mapper directory from the action's members directory", () => {
    assert.ok(mapperDir({ key: "go" }).endsWith(join("members", "go")));
    assert.equal(mapperDir({ key: "go" }, "/copy"), join("/copy", "members", "go"));
  });
});
