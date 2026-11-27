import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_DIR, runBuild } from "../lib/members.mjs";
import { registry } from "../members/registry.mjs";

const entry = registry.find((candidate) => candidate.key === "rust");
const FIXTURES = fileURLToPath(new URL("./fixtures/rust/", import.meta.url));
const MAPPER_DIR = join(ACTION_DIR, "members", "rust");
const MAX = 10_000_000;

const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
const ci = Boolean(process.env.CI);

if (!hasRustup && ci) {
  describe("the rust member mapper", () => {
    it("needs rustup on the PATH", () => {
      assert.fail("rustup is not on the PATH, and CI is set");
    });
  });
}

const skip = hasRustup || ci ? false : "skipped: rustup is not on the PATH";

let work;
let counter = 0;
const fixture = (name) => join(FIXTURES, `${name}.txt`);
const range = (start, end = start) => ({ start, end });

function spawnStep(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: step.cwd, env: step.env, shell: false });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      let response = null;
      try {
        response = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr: Buffer.concat(err).toString("utf8"), response });
    });
  });
}

// Runs the registry's command for one request and resolves to
// `{code, stdout, stderr, response}`.
function runMapper(request, { maxFileBytes = MAX, dir = MAPPER_DIR, env = process.env } = {}) {
  counter += 1;
  const requestPath = join(work, `request-${counter}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  return spawnStep(entry.run({ dir, work, env, request: requestPath, maxFileBytes }));
}

async function map(path, ranges, file = fixture(path)) {
  const { code, response } = await runMapper([{ id: 1, path, file, ranges }]);
  assert.equal(code, 0);
  assert.equal(response.length, 1);
  assert.equal(response[0].id, 1);
  return response[0];
}

function scratch(text) {
  counter += 1;
  const file = join(work, `scratch-${counter}.rs`);
  writeFileSync(file, text);
  return file;
}

const names = (result) => result.members.map((member) => member.name).sort();
const member = (result, name) => result.members.find((candidate) => candidate.name === name);

describe("the rust registry entry", () => {
  it("builds with a clean cargo environment and runs the binary with argument arrays", () => {
    const scratchWork = mkdtempSync(join(tmpdir(), "pr-conflict-radar-rust-entry-"));
    try {
      const env = {
        KEEP: "1",
        CARGO_HOME: "/cargo",
        CARGO_BUILD_TARGET: "wasm32-unknown-unknown",
        CARGO_TARGET_DIR: "/elsewhere",
        RUSTFLAGS: "-D warnings",
        RUSTC_WRAPPER: "/hostile",
        RUSTC_WORKSPACE_WRAPPER: "/hostile",
        RUSTDOCFLAGS: "--bogus",
        RUSTUP_TOOLCHAIN: "nightly",
        RUSTUP_HOME: "/rustup",
        RUSTY: "kept",
      };
      const build = entry.build({ dir: MAPPER_DIR, work: scratchWork, env });
      assert.equal(build.length, 2);
      const channel = /channel = "([^"]+)"/.exec(
        readFileSync(join(MAPPER_DIR, "rust-toolchain.toml"), "utf8"),
      )[1];
      assert.match(channel, /^\d+\.\d+\.\d+$/);
      assert.equal(build[0].command, "rustup");
      assert.deepEqual(build[0].args, [
        "toolchain",
        "install",
        channel,
        "--profile",
        "minimal",
        "--no-self-update",
      ]);
      assert.equal(build[1].command, "cargo");
      assert.deepEqual(build[1].args, [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        join(MAPPER_DIR, "Cargo.toml"),
      ]);
      for (const step of build) {
        assert.equal(step.cwd.startsWith(scratchWork), true);
        assert.equal(existsSync(step.cwd), true);
        assert.deepEqual(step.env, {
          KEEP: "1",
          CARGO_HOME: "/cargo",
          RUSTUP_HOME: "/rustup",
          RUSTY: "kept",
          RUSTUP_TOOLCHAIN: channel,
          CARGO_TARGET_DIR: join(scratchWork, "cargo-target"),
        });
      }
      const step = entry.run({
        dir: MAPPER_DIR,
        work: scratchWork,
        env: {},
        request: "/r.json",
        maxFileBytes: 5,
      });
      assert.equal(step.command.startsWith(join(scratchWork, "cargo-target", "release")), true);
      assert.deepEqual(step.args, ["/r.json", "5"]);
      assert.equal(step.cwd, scratchWork);
    } finally {
      rmSync(scratchWork, { recursive: true, force: true });
    }
  });
});

describe("the rust member mapper", { skip }, () => {
  before(async () => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-rust-"));
    await runBuild(entry, { work });
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  it("resolves a changed body line to its inherent method", async () => {
    const result = await map("cart.rs", [range(46)]);
    assert.deepEqual(result.members, [
      { name: "Cart::add", kind: "method", declarationTouched: false },
    ]);
  });

  it("flags a touched signature, also on a multi-line header", async () => {
    const result = await map("cart.rs", [range(45)]);
    assert.deepEqual(result.members, [
      { name: "Cart::add", kind: "method", declarationTouched: true },
    ]);
    const reset = await map("cart.rs", [range(53)]);
    assert.deepEqual(reset.members, [
      { name: "Cart::reset", kind: "method", declarationTouched: true },
    ]);
    const body = await map("cart.rs", [range(55)]);
    assert.equal(member(body, "Cart::reset").declarationTouched, false);
  });

  it("qualifies a trait impl method by self type and trait", async () => {
    const body = await map("cart.rs", [range(64)]);
    assert.deepEqual(body.members, [
      { name: "<Cart as Total>::total", kind: "method", declarationTouched: false },
    ]);
    const signature = await map("cart.rs", [range(63)]);
    assert.equal(member(signature, "<Cart as Total>::total").declarationTouched, true);
    const generic = await map("cart.rs", [range(70)]);
    assert.deepEqual(names(generic), ["<Wrapper as fmt::Debug>::fmt"]);
  });

  it("reports the associated consts and types of an impl", async () => {
    const result = await map("cart.rs", [range(60, 61)]);
    assert.deepEqual(names(result), ["<Cart as Total>::BASE", "<Cart as Total>::Out"]);
    assert.equal(member(result, "<Cart as Total>::BASE").kind, "const");
    assert.equal(member(result, "<Cart as Total>::Out").kind, "type");
  });

  it("reports the items of a trait, a provided method by its body", async () => {
    const result = await map("cart.rs", [range(36, 38), range(40)]);
    assert.deepEqual(names(result), ["Total::BASE", "Total::Out", "Total::label", "Total::total"]);
    assert.equal(member(result, "Total::total").declarationTouched, true);
    assert.equal(member(result, "Total::label").declarationTouched, false);
    const header = await map("cart.rs", [range(35)]);
    assert.deepEqual(header.members, [{ name: "Total", kind: "trait", declarationTouched: true }]);
  });

  it("reports struct fields and a struct only for its own header", async () => {
    const field = await map("cart.rs", [range(19)]);
    assert.deepEqual(field.members, [
      { name: "Item::price", kind: "field", declarationTouched: true },
    ]);
    const header = await map("cart.rs", [range(17), range(22)]);
    assert.deepEqual(names(header), ["Cart", "Item"]);
    const unit = await map("cart.rs", [range(27)]);
    assert.deepEqual(unit.members, [{ name: "Marker", kind: "struct", declarationTouched: true }]);
  });

  it("reports enum variants and an enum only for its own header", async () => {
    const variant = await map("cart.rs", [range(31)]);
    assert.deepEqual(variant.members, [
      { name: "Kind::Bulk", kind: "variant", declarationTouched: true },
    ]);
    const header = await map("cart.rs", [range(29)]);
    assert.deepEqual(header.members, [{ name: "Kind", kind: "enum", declarationTouched: true }]);
  });

  it("qualifies a function in an inline module", async () => {
    const result = await map("cart.rs", [range(76)]);
    assert.deepEqual(result.members, [
      { name: "inner::helper", kind: "function", declarationTouched: false },
    ]);
    const header = await map("cart.rs", [range(74)]);
    assert.deepEqual(header.members, [{ name: "inner", kind: "module", declarationTouched: true }]);
  });

  it("reports consts, statics, type aliases and macro_rules macros", async () => {
    const result = await map("cart.rs", [range(5, 9), range(12)]);
    assert.deepEqual(names(result), ["Id", "MAX", "NAME", "twice"]);
    assert.equal(member(result, "MAX").kind, "const");
    assert.equal(member(result, "NAME").kind, "static");
    assert.equal(member(result, "Id").kind, "type");
    assert.equal(member(result, "twice").kind, "macroRules");
    assert.equal(member(result, "twice").declarationTouched, false);
  });

  it("reports a plain function and merges cfg variants of one name", async () => {
    const plain = await map("cart.rs", [range(81)]);
    assert.deepEqual(plain.members, [
      { name: "build", kind: "function", declarationTouched: false },
    ]);
    const file = scratch(
      "#[cfg(unix)]\nfn start() {}\n\n#[cfg(windows)]\nfn start() {\n    run();\n}\n",
    );
    const merged = await map("p.rs", [range(1, 7)], file);
    assert.deepEqual(merged.members, [
      { name: "start", kind: "function", declarationTouched: true },
    ]);
  });

  it("reports extern block items and unions", async () => {
    const file = scratch(
      'extern "C" {\n    fn open(path: i32) -> i32;\n    static ERRNO: i32;\n}\n\nunion Bits {\n    a: u32,\n    b: f32,\n}\n',
    );
    const result = await map("p.rs", [range(1, 9)], file);
    assert.deepEqual(names(result), ["Bits", "Bits::a", "Bits::b", "ERRNO", "open"]);
    assert.equal(member(result, "Bits").kind, "union");
  });

  it("returns the identifiers on the given lines only", async () => {
    const result = await map("cart.rs", [range(46)]);
    assert.deepEqual(result.identifiers, ["MAX", "items", "len"]);
  });

  it("returns identifiers on added lines, including inside a macro invocation", async () => {
    const result = await map("cart.rs", [range(76)]);
    assert.deepEqual(result.identifiers, ["twice"]);
    const file = scratch('fn main() {\n    println!("{}", compute(value));\n}\n');
    const inner = await map("p.rs", [range(2)], file);
    assert.deepEqual(inner.identifiers, ["compute", "println", "value"]);
  });

  it("skips keywords and the names of lifetimes in identifiers", async () => {
    const file = scratch("fn f<'a>(x: &'a str) -> &'a str { x }\n");
    const result = await map("p.rs", [range(1)], file);
    assert.deepEqual(result.identifiers, ["f", "str", "x"]);
  });

  it("parses a file with a shebang line", async () => {
    const file = scratch("#!/usr/bin/env run\nfn main() {}\n");
    const result = await map("p.rs", [range(2)], file);
    assert.deepEqual(names(result), ["main"]);
  });

  it("reports a removed member from the base-side text", async () => {
    const base = scratch("fn keep() {}\n\nfn gone() {\n}\n");
    const result = await map("src/a.rs", [range(3, 4)], base);
    assert.deepEqual(result.members, [
      { name: "gone", kind: "function", declarationTouched: true },
    ]);
  });

  it("reports a syntax error with its line on its entry, and exits 0", async () => {
    const { code, response } = await runMapper([
      { id: "a", path: "broken.rs", file: fixture("broken.rs"), ranges: [range(1, 2)] },
      { id: "b", path: "cart.rs", file: fixture("cart.rs"), ranges: [range(81)] },
    ]);
    assert.equal(code, 0);
    assert.match(response[0].error, /^syntax error at line 1$/);
    assert.equal(response[0].members, undefined);
    assert.deepEqual(names(response[1]), ["build"]);
  });

  it("reports 10,000 nested parentheses on their entry and exits 0", async () => {
    const depth = 10_000;
    const file = scratch(`const X: u32 = ${"(".repeat(depth)}1${")".repeat(depth)};\n`);
    const { code, response } = await runMapper([
      { id: 1, path: "p.rs", file, ranges: [range(1)] },
      { id: 2, path: "cart.rs", file: fixture("cart.rs"), ranges: [range(81)] },
    ]);
    assert.equal(code, 0);
    assert.equal(response[0].id, 1);
    assert.equal(typeof response[0].error, "string");
    assert.equal(response[0].members, undefined);
    assert.deepEqual(names(response[1]), ["build"]);
  });

  it("kills a parse over the child limit and starts none that could end past the batch limit", async () => {
    // A named pipe without a writer blocks the child that opens it.
    counter += 1;
    const pipe = join(work, `pipe-${counter}`);
    assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
    const env = {
      ...process.env,
      PR_CONFLICT_RADAR_CHILD_LIMIT: "0.5",
      PR_CONFLICT_RADAR_BATCH_LIMIT: "1.4",
    };
    const blocked = (id) => ({ id, path: "hang.rs", file: pipe, ranges: [range(1)] });
    const started = Date.now();
    const { code, response } = await runMapper(
      [
        blocked(1),
        blocked(2),
        blocked(3),
        { id: 4, path: "cart.rs", file: fixture("cart.rs"), ranges: [range(81)] },
      ],
      { env },
    );
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    const timedOut = "the parser took longer than 0.5 seconds";
    const outOfTime = "the mapper ran out of time before it parsed the file";
    assert.deepEqual(response, [
      { id: 1, error: timedOut },
      { id: 2, error: timedOut },
      { id: 3, error: outOfTime },
      { id: 4, error: outOfTime },
    ]);
    assert.ok(elapsed < 4000, `took ${elapsed} ms`);
  });

  it("reports a file over maxFileBytes on its entry without parsing it", async () => {
    const { code, response } = await runMapper(
      [{ id: 1, path: "cart.rs", file: fixture("cart.rs"), ranges: [range(81)] }],
      { maxFileBytes: 100 },
    );
    assert.equal(code, 0);
    assert.deepEqual(response, [{ id: 1, error: "the file is larger than maxFileBytes" }]);
  });

  it("reports an unreadable file and a malformed entry on their entries", async () => {
    const { code, response } = await runMapper([
      { id: 1, path: "a.rs", file: join(work, "missing.rs"), ranges: [range(1)] },
      { id: 2, path: "a.rs", file: fixture("cart.rs"), ranges: "all" },
      { id: 3, path: "a.rs", file: fixture("cart.rs"), ranges: [range(5, 2)] },
      { path: "a.rs", file: fixture("cart.rs"), ranges: [range(1)] },
    ]);
    assert.equal(code, 0);
    assert.equal(response[0].error, "the file could not be read");
    assert.equal(response[1].error, "the request entry is malformed");
    assert.equal(response[2].error, "the request entry is malformed");
    assert.equal(response[3].id, null);
    assert.ok(response[3].members);
  });

  it("exits 2 with a usage line on bad arguments", async () => {
    const run = entry.run({
      dir: MAPPER_DIR,
      work,
      env: process.env,
      request: "/nonexistent/request.json",
      maxFileBytes: 1,
    });
    const missing = await spawnStep(run);
    assert.equal(missing.code, 2);
    const bare = await spawnStep({ ...run, args: [] });
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /usage/);
  });

  it("answers several runs started at once after the single build", async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runMapper([{ id: 1, path: "cart.rs", file: fixture("cart.rs"), ranges: [range(46)] }]),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0);
      assert.deepEqual(names(run.response[0]), ["Cart::add"]);
    }
  });
});

describe("the rust mapper build inside a hostile parent directory", { skip }, () => {
  let root;
  before(() => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-rust-"));
    root = mkdtempSync(join(tmpdir(), "pr-conflict-radar-rust-parent-"));
  });
  after(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("builds although a parent workspace, toolchain file, cargo config and the environment say otherwise", async () => {
    writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers = ["members/rust"]\n');
    writeFileSync(
      join(root, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "1.0.0"\nprofile = "minimal"\n',
    );
    mkdirSync(join(root, ".cargo"));
    writeFileSync(
      join(root, ".cargo", "config.toml"),
      [
        "[source.crates-io]",
        'replace-with = "missing"',
        "",
        "[source.missing]",
        'directory = "/nonexistent/vendor"',
        "",
        "[build]",
        'rustflags = ["--bogus-flag"]',
        'rustc-wrapper = "/nonexistent/wrapper"',
        'target = "bogus-unknown-target"',
        "",
      ].join("\n"),
    );
    const dir = join(root, "members", "rust");
    mkdirSync(dir, { recursive: true });
    cpSync(MAPPER_DIR, dir, {
      recursive: true,
      filter: (source) => !source.endsWith(`${join("members", "rust", "target")}`),
    });
    const env = {
      ...process.env,
      RUSTFLAGS: "--bogus-flag",
      RUSTC_WRAPPER: "/nonexistent/wrapper",
    };
    for (const step of entry.build({ dir, work, env })) {
      assert.equal(step.cwd.startsWith(root), false);
      assert.equal(step.cwd.startsWith(work), true);
    }
    await runBuild(entry, { dir, work, env });
    const { code, response } = await runMapper(
      [{ id: 1, path: "cart.rs", file: fixture("cart.rs"), ranges: [range(46)] }],
      { dir },
    );
    assert.equal(code, 0);
    assert.deepEqual(names(response[0]), ["Cart::add"]);
  });
});
