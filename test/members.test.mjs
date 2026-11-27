import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { defaultConfig, resolveConfig } from "../lib/config.mjs";
import {
  BuildError,
  fileMembers,
  mapMembers,
  mapperDir,
  mappersNeeded,
  memberSignals,
  runBuild,
  simpleName,
} from "../lib/members.mjs";
import { registry as defaultRegistry } from "../members/registry.mjs";
import { fakeRun, runsIn } from "./fake-mapper.mjs";
import { createFixture } from "./fixture-repo.mjs";

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

  it("names the OS error of a command that cannot start and keeps it in the report", async () => {
    const work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-build-"));
    try {
      const notExecutable = join(work, "tool");
      writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o644 });
      await assert.rejects(runBuild(entryFor(notExecutable, []), { work }), (error) => {
        assert.ok(error instanceof BuildError);
        assert.match(error.message, /could not start .* \(EACCES\)$/);
        assert.equal(error.output.length, 1);
        assert.equal(error.output[0].command, notExecutable);
        assert.equal(error.output[0].startError.code, "EACCES");
        assert.match(error.output[0].startError.message, /EACCES/);
        return true;
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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

// --- Mapping ------------------------------------------------------------------

const EXTENSIONS = { typescript: "ts", csharp: "cs", go: "go", rust: "rs", cpp: "cpp" };
const GIT_ENV = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});
after(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

// A base commit and one head per pull request, each `{path: content}`.
function scenario({ base, heads }) {
  const fx = createFixture();
  const work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-members-"));
  const log = join(work, "runs.log");
  cleanups.push(() => {
    fx.cleanup();
    rmSync(work, { recursive: true, force: true });
  });
  const baseSha = fx.commit({ files: base, branch: "main" });
  const pulls = Object.entries(heads).map(([number, files]) => ({
    number: Number(number),
    headRefOid: fx.commit({ parent: baseSha, files }),
  }));
  return { fx, work, log, baseSha, pulls };
}

const allNeeded = (registry = defaultRegistry) =>
  Object.fromEntries(registry.map((entry) => [entry.key, true]));

const fakes = (log, registry = defaultRegistry, options = {}) =>
  Object.fromEntries(registry.map((entry) => [entry.key, fakeRun(entry.key, { log, ...options })]));

function map(s, options = {}) {
  const registry = options.registry ?? defaultRegistry;
  return mapMembers({
    base: { ref: "main", sha: s.baseSha },
    pulls: s.pulls,
    config: defaultConfig({ registry }),
    needed: allNeeded(registry),
    mappers: fakes(s.log, registry),
    work: s.work,
    git: { cwd: s.fx.remote, env: GIT_ENV },
    ...options,
  });
}

const runsOf = (s, key) => runsIn(s.log).filter((run) => run.key === key);

// The base file of one language and the two heads of the signal scenario: both
// change the body of `Cart.add`; 12 changes the declarations of
// `computeTotal`, `Item.Name`, `abc` and `formatPrice` and touches the
// `TEST_F` macro block; 15 uses all of those names on added lines, touches the
// macro block too, and declares its own `formatPrice`.
const CART = [
  "def Cart.add",
  "  total = total + 1",
  "  return total",
  "def Cart.remove",
  "  total = total - 1",
  "def computeTotal",
  "  return 0",
  "def Item.Name",
  "  return label",
  "def TEST_F macro",
  "  check 1",
  "  check 2",
  "def abc",
  "  return 1",
  "def formatPrice",
  "  return 2",
  "",
].join("\n");

function signalHeads(ext) {
  const path = `src/cart.${ext}`;
  const lines = CART.split("\n");
  const twelve = [...lines];
  twelve[1] = "  total = total + 2";
  twelve[5] = "def computeTotal function";
  twelve[7] = "def Item.Name property";
  twelve[10] = "  check 10";
  twelve[12] = "def abc function";
  twelve[14] = "def formatPrice function";
  const fifteen = [...lines];
  fifteen[2] = "  return total + 0";
  fifteen[4] = "  total = computeTotal - Name - abc - TEST_F - formatPrice";
  fifteen[11] = "  check 20";
  return {
    path,
    base: { [path]: CART },
    heads: {
      12: { [path]: twelve.join("\n") },
      15: {
        [path]: fifteen.join("\n"),
        [`src/price.${ext}`]: "def formatPrice\n  return formatPrice\n",
      },
    },
  };
}

describe("mapMembers and the signals", () => {
  for (const [key, ext] of Object.entries(EXTENSIONS)) {
    it(`finds both signals in ${key} files and applies every exclusion`, async () => {
      const { path, base, heads } = signalHeads(ext);
      const s = scenario({ base, heads });
      const data = await map(s);
      assert.deepEqual(data.failures, []);
      assert.deepEqual(data.degraded, []);
      const signals = memberSignals(data.changes[12], data.changes[15], defaultConfig());
      // `TEST_F` is a macro in both: no overlap on it.
      assert.deepEqual(signals.sameMember, [{ path, name: "Cart.add" }]);
      // `Item.Name` is ignored, `abc` is short, `TEST_F` is a macro and 15
      // declares its own `formatPrice`.
      assert.deepEqual(signals.changedAndUsed, [{ path, name: "computeTotal" }]);
      assert.deepEqual(memberSignals(data.changes[15], data.changes[12], defaultConfig()), signals);
      assert.deepEqual(
        runsIn(s.log).map((run) => run.key),
        [key, key],
      );
    });
  }

  it("reads removed declarations from the base side at the merge base", async () => {
    const s = scenario({
      base: { "src/cart.go": CART },
      heads: {
        12: { "src/cart.go": CART.replace("def computeTotal\n  return 0\n", "") },
        15: { "src/use.go": "def run\n  computeTotal\n" },
      },
    });
    const data = await map(s);
    const removed = data.changes[12].find((change) => change.side === "base");
    assert.deepEqual(removed.members, [
      { name: "computeTotal", kind: "function", declarationTouched: true },
    ]);
    assert.equal(data.changes[12].filter((change) => change.side === "head").length, 0);
    const signals = memberSignals(data.changes[12], data.changes[15], defaultConfig());
    assert.deepEqual(signals.changedAndUsed, [{ path: "src/cart.go", name: "computeTotal" }]);
  });

  it("finds nothing for a pair with no shared language files", async () => {
    const s = scenario({
      base: { "src/cart.go": CART, "docs/a.md": "x\n" },
      heads: { 12: { "src/cart.go": CART.replace("+ 1", "+ 2") }, 15: { "docs/a.md": "y\n" } },
    });
    const data = await map(s);
    assert.deepEqual(data.changes[15], []);
    const signals = memberSignals(data.changes[12], data.changes[15], defaultConfig());
    assert.deepEqual(signals, { sameMember: [], changedAndUsed: [] });
    assert.deepEqual(
      runsIn(s.log).map((run) => run.key),
      ["go", "go"],
    );
  });

  it("forms no same-member overlap across languages, while a by-name hint can", async () => {
    const s = scenario({
      base: { "src/cart.ts": CART, "src/cart.go": CART },
      heads: {
        12: {
          "src/cart.ts": CART.replace("+ 1", "+ 2").replace(
            "def computeTotal",
            "def computeTotal x",
          ),
        },
        15: { "src/cart.go": CART.replace("+ 1", "+ 3").replace("- 1", "- computeTotal") },
      },
    });
    const data = await map(s);
    const signals = memberSignals(data.changes[12], data.changes[15], defaultConfig());
    assert.deepEqual(signals.sameMember, []);
    assert.deepEqual(signals.changedAndUsed, [{ path: "src/cart.ts", name: "computeTotal" }]);
  });

  it("orders a request's entries with the pull requests taking turns, in the given order", async () => {
    const s = scenario({
      base: { "keep.go": "def keep\n" },
      heads: {
        12: { "a/1.go": "def a1\n", "a/2.go": "def a2\n", "a/3.go": "def a3\n" },
        15: { "b/1.go": "def b1\n", "b/2.go": "def b2\n" },
        20: { "c/1.go": "def c1\n" },
      },
    });
    const byNumber = new Map(s.pulls.map((pull) => [pull.number, pull]));
    await map(s, { pulls: [15, 12, 20].map((number) => byNumber.get(number)) });
    const runs = runsOf(s, "go");
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0].entries.map((entry) => entry.path),
      ["b/1.go", "a/1.go", "c/1.go", "b/2.go", "a/2.go", "a/3.go"],
    );
  });

  it("starts each mapper at most twice per scan, one request per side over every pull request", async () => {
    const base = {};
    const heads = { 12: {}, 15: {}, 20: {} };
    for (const ext of Object.values(EXTENSIONS)) {
      base[`src/cart.${ext}`] = CART;
      base[`src/old.${ext}`] = "def old\n";
      heads[12][`src/cart.${ext}`] = CART.replace("+ 1", "+ 2");
      heads[15][`src/cart.${ext}`] = CART.replace("- 1", "- 2");
      heads[15][`src/new.${ext}`] = "def fresh\n";
      heads[20][`src/old.${ext}`] = null;
    }
    const s = scenario({ base, heads });
    const data = await map(s);
    for (const key of Object.keys(EXTENSIONS)) {
      const runs = runsOf(s, key);
      assert.equal(runs.length, 2, key);
      const paths = runs.flatMap((run) => run.entries.map((entry) => entry.path)).sort();
      const ext = EXTENSIONS[key];
      // Heads of 12 and 15, the added file of 15; bases of 12 and 15 and the
      // deleted file of 20.
      assert.deepEqual(
        paths,
        [
          `src/cart.${ext}`,
          `src/cart.${ext}`,
          `src/cart.${ext}`,
          `src/cart.${ext}`,
          `src/new.${ext}`,
          `src/old.${ext}`,
        ].sort(),
      );
    }
    assert.equal(data.changes[20].length, 5);
    assert.ok(data.changes[20].every((change) => change.side === "base"));
  });

  it("never starts a mapper that is not needed", async () => {
    const s = scenario({
      base: { "src/cart.go": CART, "src/cart.ts": CART },
      heads: {
        12: {
          "src/cart.go": CART.replace("+ 1", "+ 2"),
          "src/cart.ts": CART.replace("+ 1", "+ 2"),
        },
      },
    });
    const data = await map(s, { needed: { ...allNeeded(), go: false } });
    assert.deepEqual(runsOf(s, "go"), []);
    assert.equal(runsOf(s, "typescript").length, 2);
    assert.ok(data.changes[12].every((change) => change.path === "src/cart.ts"));
  });

  it("sends a file to the first entry, in registry order, whose patterns it matches", async () => {
    const s = scenario({
      base: { "src/cart.ts": CART },
      heads: { 12: { "src/cart.ts": CART.replace("+ 1", "+ 2") } },
    });
    const config = resolveConfig({ members: { csharp: { patterns: ["**/*.ts"] } } });
    await map(s, { config });
    assert.equal(runsOf(s, "typescript").length, 2);
    assert.deepEqual(runsOf(s, "csharp"), []);
  });

  it("requests, gates and reports an extra registry entry like the five", async () => {
    const registry = [...defaultRegistry, { key: "fake", patterns: ["**/*.fk"] }];
    const { path, base, heads } = signalHeads("fk");
    const s = scenario({ base, heads });
    const config = resolveConfig({}, { registry });
    const paths = [path, "src/price.fk"];
    const needed = mappersNeeded(config, paths, { registry });
    assert.equal(needed.fake, true);
    const data = await map(s, { registry, config, needed });
    assert.equal(runsOf(s, "fake").length, 2);
    const signals = memberSignals(data.changes[12], data.changes[15], config);
    assert.deepEqual(signals.sameMember, [{ path, name: "Cart.add" }]);
    assert.deepEqual(signals.changedAndUsed, [{ path, name: "computeTotal" }]);

    const off = resolveConfig({ members: { fake: { enabled: false } } }, { registry });
    const gated = mappersNeeded(off, paths, { registry });
    assert.equal(gated.fake, false);
    const quiet = scenario({ base, heads });
    const none = await map(quiet, { registry, config: off, needed: gated });
    assert.deepEqual(runsIn(quiet.log), []);
    assert.deepEqual(none.changes, { 12: [], 15: [] });
  });

  it("passes the cpp defines list and maxFileBytes to the mapper", async () => {
    const s = scenario({
      base: { "src/a.cpp": CART },
      heads: { 12: { "src/a.cpp": CART.replace("+ 1", "+ 2") } },
    });
    const config = resolveConfig({ members: { cpp: { defines: ["APIENTRY"] } } });
    await map(s, { config });
    const runs = runsOf(s, "cpp");
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.deepEqual(run.defines, ["APIENTRY"]);
      assert.equal(run.maxFileBytes, "1000000");
    }
  });

  it("removes its request files and blobs", async () => {
    const s = scenario({
      base: { "src/cart.go": CART },
      heads: { 12: { "src/cart.go": CART.replace("+ 1", "+ 2") } },
    });
    await map(s);
    assert.deepEqual(
      readdirSync(s.work).filter((name) => name.startsWith("members-")),
      [],
    );
  });
});

describe("mapMembers limits", () => {
  it("leaves a blob over maxFileBytes out of the request and names it in the notes", async () => {
    const big = `${CART}${"  filler line\n".repeat(20)}`;
    const s = scenario({
      base: { "src/big.go": big, "src/cart.go": CART },
      heads: {
        12: { "src/big.go": big.replace("+ 1", "+ 2"), "src/cart.go": CART.replace("+ 1", "+ 2") },
      },
    });
    const config = resolveConfig({ members: { maxFileBytes: CART.length } });
    const data = await map(s, { config });
    const runs = runsOf(s, "go");
    assert.ok(runs.length > 0);
    for (const run of runs) {
      assert.deepEqual(
        run.entries.map((entry) => entry.path),
        ["src/cart.go"],
      );
      assert.equal(run.maxFileBytes, String(CART.length));
    }
    assert.deepEqual(data.notes[12], [
      `The members of src/big.go were not mapped: the file is larger than ${CART.length} bytes.`,
    ]);
    assert.deepEqual(data.degraded, []);
  });

  it("names an entry error of any mapper in the notes and keeps the other entries' members", async () => {
    const base = {};
    const head = {};
    for (const ext of Object.values(EXTENSIONS)) {
      base[`src/cart.${ext}`] = CART;
      base[`src/broken.${ext}`] = "def x\n";
      head[`src/cart.${ext}`] = CART.replace("+ 1", "+ 2");
      head[`src/broken.${ext}`] = "def x\nERROR\n";
    }
    const s = scenario({ base, heads: { 12: head } });
    const data = await map(s);
    assert.deepEqual(data.failures, []);
    assert.deepEqual(data.degraded, []);
    for (const ext of Object.values(EXTENSIONS)) {
      assert.ok(
        data.notes[12].includes(
          `The members of src/broken.${ext} were not mapped: syntax error at line 2`,
        ),
        ext,
      );
      const cart = data.changes[12].find(
        (change) => change.path === `src/cart.${ext}` && change.side === "head",
      );
      assert.deepEqual(cart.members, [
        { name: "Cart.add", kind: "function", declarationTouched: false },
      ]);
    }
  });

  it("stops a mapper that outlives its time limit, with the processes it started", async () => {
    const s = scenario({
      base: { "src/cart.go": CART, "src/cart.ts": CART },
      heads: {
        12: { "src/cart.go": CART.replace("+ 1", "+ 2") },
        15: { "src/cart.ts": CART.replace("+ 1", "+ 2") },
      },
    });
    const pids = join(s.work, "pids.json");
    const mappers = { ...fakes(s.log), go: fakeRun("go", { mode: "hang", pids }) };
    const started = Date.now();
    const data = await map(s, { mappers, timeoutMs: 500 });
    assert.ok(Date.now() - started < 10000);
    assert.equal(data.failures.length, 1);
    assert.equal(data.failures[0].mapper, "go");
    assert.equal(data.failures[0].side, "head");
    assert.match(data.failures[0].message, /time limit/);
    assert.deepEqual(data.degraded, [12]);
    assert.deepEqual(data.changes[12], []);
    assert.ok(
      data.notes[12].includes("Member overlap is incomplete: the go member mapper failed."),
    );
    // The other mapper's results stay.
    assert.ok(data.changes[15].length > 0);
    assert.ok(existsSync(pids));
    await delay(100);
    for (const pid of JSON.parse(readFileSync(pids, "utf8"))) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} still runs`);
    }
  });

  for (const [mode, message] of [
    ["exit", /exited with code 3/],
    ["garbage", /no valid response/],
  ]) {
    it(`takes the mapper-failure path for a mapper that ${mode === "exit" ? "exits non-zero" : "writes no valid JSON"}`, async () => {
      const s = scenario({
        base: { "src/cart.rs": CART },
        heads: { 12: { "src/cart.rs": CART.replace("+ 1", "+ 2") } },
      });
      const mappers = { ...fakes(s.log), rust: fakeRun("rust", { mode }) };
      const data = await map(s, { mappers });
      assert.equal(data.failures.length, 1);
      assert.match(data.failures[0].message, message);
      assert.deepEqual(data.degraded, [12]);
      assert.deepEqual(data.changes[12], []);
      if (mode === "exit") {
        assert.equal(data.failures[0].code, 3);
        assert.match(data.failures[0].stderr, /##\[error\]boom/);
        assert.equal(data.failures[0].stdout, "partial\n");
      }
    });
  }

  it("counts a mapper whose build failed as failed without starting it", async () => {
    const s = scenario({
      base: { "src/cart.go": CART },
      heads: { 12: { "src/cart.go": CART.replace("+ 1", "+ 2") } },
    });
    const data = await map(s, { unavailable: { go: "the go member mapper needs go" } });
    assert.deepEqual(runsOf(s, "go"), []);
    assert.deepEqual(data.failures, [
      { mapper: "go", side: null, message: "the go member mapper needs go" },
    ]);
    assert.deepEqual(data.degraded, [12]);
  });

  it("counts a missing mapper command as a failure", async () => {
    const s = scenario({
      base: { "src/cart.go": CART },
      heads: { 12: { "src/cart.go": CART.replace("+ 1", "+ 2") } },
    });
    const missing = () => ({ command: "pr-conflict-radar-no-such-mapper", args: [], cwd: s.work });
    const data = await map(s, { mappers: { ...fakes(s.log), go: missing } });
    assert.match(data.failures[0].message, /could not be started/);
    assert.deepEqual(data.degraded, [12]);
  });

  it("names the OS error of a mapper command that cannot start", async () => {
    const s = scenario({
      base: { "src/cart.go": CART },
      heads: { 12: { "src/cart.go": CART.replace("+ 1", "+ 2") } },
    });
    const tool = join(s.work, "mapper");
    writeFileSync(tool, "#!/bin/sh\n", { mode: 0o644 });
    const blocked = () => ({ command: tool, args: [], cwd: s.work });
    const data = await map(s, { mappers: { ...fakes(s.log), go: blocked } });
    assert.equal(data.failures[0].message, "the go member mapper could not be started (EACCES)");
    assert.equal(data.failures[0].startError.code, "EACCES");
    assert.deepEqual(data.degraded, [12]);
  });
});

describe("signal helpers", () => {
  it("takes the last plain identifier of a qualified name", () => {
    assert.equal(simpleName("cart.Cart.Add"), "Add");
    assert.equal(simpleName("acme::ui::Widget::resize"), "resize");
    assert.equal(simpleName("<Cart as Total>::total"), "total");
    assert.equal(simpleName("IFoo.Bar"), "Bar");
    assert.equal(simpleName("computeTotal"), "computeTotal");
    assert.equal(simpleName("Widget::~Widget"), null);
    assert.equal(simpleName("Cart.operator +"), null);
    assert.equal(simpleName("Cart.this[]"), null);
  });

  it("lists the members either side changed in a file", () => {
    const a = [
      { path: "a.go", side: "head", members: [{ name: "b", kind: "function" }], identifiers: [] },
    ];
    const b = [
      {
        path: "a.go",
        side: "base",
        members: [
          { name: "a", kind: "function" },
          { name: "b", kind: "function" },
        ],
        identifiers: [],
      },
      { path: "c.go", side: "head", members: [{ name: "c", kind: "var" }], identifiers: [] },
    ];
    assert.deepEqual(fileMembers(a, b, "a.go"), ["a", "b"]);
    assert.deepEqual(fileMembers(a, undefined, "c.go"), []);
  });
});
