import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_DIR, runBuild } from "../lib/members.mjs";
import { registry } from "../members/registry.mjs";

const entry = registry.find((candidate) => candidate.key === "go");
const FIXTURES = fileURLToPath(new URL("./fixtures/go/", import.meta.url));
const MAPPER_DIR = join(ACTION_DIR, "members", "go");
const MAX = 10_000_000;

const hasGo = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
const ci = Boolean(process.env.CI);

if (!hasGo && ci) {
  describe("the go member mapper", () => {
    it("needs go on the PATH", () => {
      assert.fail("go is not on the PATH, and CI is set");
    });
  });
}

const skip = hasGo || ci ? false : "skipped: go is not on the PATH";

let work;
let counter = 0;
const fixture = (name) => join(FIXTURES, name);
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
function runMapper(request, { maxFileBytes = MAX, dir = MAPPER_DIR } = {}) {
  counter += 1;
  const requestPath = join(work, `request-${counter}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  return spawnStep(entry.run({ dir, work, env: process.env, request: requestPath, maxFileBytes }));
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
  const file = join(work, `scratch-${counter}.go`);
  writeFileSync(file, text);
  return file;
}

const names = (result) => result.members.map((member) => member.name).sort();
const member = (result, name) => result.members.find((candidate) => candidate.name === name);

describe("the go registry entry", () => {
  it("builds with a clean Go environment and runs the binary with argument arrays", () => {
    const env = {
      KEEP: "1",
      GOROOT: "/goroot",
      GOPATH: "/gopath",
      GOCACHE: "/gocache",
      GOMODCACHE: "/gomod",
      GOFLAGS: "-modfile=/nonexistent/go.mod",
      GOENV: "/hostile",
      GOWORK: "/hostile/go.work",
      GOTOOLCHAIN: "go1.1",
      GOPROXY: "off",
      GO111MODULE: "off",
      GOOGLE_VALUE: "kept",
      CGO_ENABLED: "1",
    };
    const build = entry.build({ dir: "/a/members/go", work: "/w", env });
    assert.equal(build.length, 1);
    assert.equal(build[0].command, "go");
    assert.equal(build[0].args[0], "build");
    assert.equal(build[0].args[1], "-o");
    assert.match(build[0].args[2], /^\/w\/member-map-go/);
    assert.equal(build[0].args[3], ".");
    assert.equal(build[0].cwd, "/a/members/go");
    assert.deepEqual(build[0].env, {
      KEEP: "1",
      GOROOT: "/goroot",
      GOPATH: "/gopath",
      GOCACHE: "/gocache",
      GOMODCACHE: "/gomod",
      GOOGLE_VALUE: "kept",
      GOWORK: "off",
      GOENV: "off",
      GOFLAGS: "",
      GOTOOLCHAIN: "local",
      CGO_ENABLED: "0",
    });
    const step = entry.run({
      dir: "/a/members/go",
      work: "/w",
      env: {},
      request: "/r.json",
      maxFileBytes: 5,
    });
    assert.match(step.command, /^\/w\/member-map-go/);
    assert.deepEqual(step.args, ["/r.json", "5"]);
    assert.equal(step.cwd, "/w");
  });
});

describe("the go member mapper", { skip }, () => {
  before(async () => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-go-"));
    await runBuild(entry, { work });
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  it("resolves a changed body line to its method", async () => {
    const result = await map("cart.go", [range(39)]);
    assert.deepEqual(result.members, [
      { name: "cart.Cart.Add", kind: "method", declarationTouched: false },
    ]);
  });

  it("flags a touched signature, also on a multi-line header", async () => {
    const result = await map("cart.go", [range(35)]);
    assert.deepEqual(result.members, [
      { name: "cart.Cart.Add", kind: "method", declarationTouched: true },
    ]);
    const reset = await map("cart.go", [range(52)]);
    assert.deepEqual(reset.members, [
      { name: "cart.Cart.Reset", kind: "method", declarationTouched: true },
    ]);
    const body = await map("cart.go", [range(54)]);
    assert.equal(member(body, "cart.Cart.Reset").declarationTouched, false);
  });

  it("qualifies methods on a pointer receiver and on a value receiver by the type", async () => {
    const result = await map("cart.go", [range(39), range(46)]);
    assert.deepEqual(names(result), ["cart.Cart.Add", "cart.Cart.Total"]);
  });

  it("qualifies a method of a generic type by the type without its parameters", async () => {
    const result = await map("generics.go", [range(10)]);
    assert.deepEqual(result.members, [
      { name: "cart.Box.Get", kind: "method", declarationTouched: false },
    ]);
  });

  it("reports a function", async () => {
    const result = await map("cart.go", [range(32)]);
    assert.deepEqual(result.members, [
      { name: "cart.New", kind: "function", declarationTouched: false },
    ]);
  });

  it("reports a struct field and an interface method, not their types", async () => {
    const field = await map("cart.go", [range(23)]);
    assert.deepEqual(field.members, [
      { name: "cart.Item.Price", kind: "field", declarationTouched: true },
    ]);
    const iface = await map("cart.go", [range(17)]);
    assert.deepEqual(iface.members, [
      { name: "cart.Store.Get", kind: "method", declarationTouched: true },
    ]);
  });

  it("reports a type only for its own header lines", async () => {
    const header = await map("cart.go", [range(26)]);
    assert.deepEqual(header.members, [
      { name: "cart.Cart", kind: "type", declarationTouched: true },
    ]);
    const both = await map("cart.go", [range(16), range(21)]);
    assert.deepEqual(names(both), ["cart.Item", "cart.Store"]);
    const inside = await map("cart.go", [range(27)]);
    assert.deepEqual(names(inside), ["cart.Cart.Items"]);
  });

  it("reports package-level var and const in a group by name", async () => {
    const consts = await map("cart.go", [range(8)]);
    assert.deepEqual(consts.members, [
      { name: "cart.Min", kind: "const", declarationTouched: true },
    ]);
    const vars = await map("cart.go", [range(12)]);
    assert.deepEqual(vars.members, [
      { name: "cart.ErrEmpty", kind: "var", declarationTouched: true },
    ]);
  });

  it("reports an ungrouped var, a type alias and an init function", async () => {
    const file = scratch(
      "package p\n\nvar Solo = 1\n\ntype ID int\n\nfunc init() {}\n\nfunc init() {}\n",
    );
    const result = await map("p.go", [range(1, 9)], file);
    assert.deepEqual(names(result), ["p.ID", "p.Solo", "p.init"]);
    assert.equal(member(result, "p.ID").kind, "type");
    assert.equal(member(result, "p.Solo").kind, "var");
  });

  it("returns the identifiers on the given lines only", async () => {
    const result = await map("cart.go", [range(39)]);
    assert.deepEqual(result.identifiers, ["Items", "append", "c", "item"]);
  });

  it("parses a file with a build tag", async () => {
    const result = await map("generics.go", [range(5)]);
    assert.deepEqual(result.members, [
      { name: "cart.Box", kind: "type", declarationTouched: true },
    ]);
  });

  it("uses the lines of the file, not those of a line directive", async () => {
    const file = scratch("package p\n\n//line other.go:100\nfunc F() {}\n");
    const result = await map("p.go", [range(4)], file);
    assert.deepEqual(names(result), ["p.F"]);
  });

  it("reports a removed member from the base-side text", async () => {
    const base = scratch("package a\n\nfunc Keep() {}\n\nfunc Gone() {\n}\n");
    const result = await map("src/a.go", [range(5, 6)], base);
    assert.deepEqual(result.members, [
      { name: "a.Gone", kind: "function", declarationTouched: true },
    ]);
  });

  it("reports a syntax error on its entry, with no members, and exits 0", async () => {
    const { code, response } = await runMapper([
      { id: "a", path: "broken.go", file: fixture("broken.go"), ranges: [range(1, 4)] },
      { id: "b", path: "cart.go", file: fixture("cart.go"), ranges: [range(32)] },
    ]);
    assert.equal(code, 0);
    assert.match(response[0].error, /^syntax error at line \d+$/);
    assert.equal(response[0].members, undefined);
    assert.deepEqual(names(response[1]), ["cart.New"]);
  });

  it("reports 900,000 nested parentheses on their entry and exits 0", async () => {
    const depth = 900_000;
    const file = scratch(`package p\n\nvar X = ${"(".repeat(depth)}1${")".repeat(depth)}\n`);
    const { code, response } = await runMapper([
      { id: 1, path: "p.go", file, ranges: [range(3)] },
      { id: 2, path: "cart.go", file: fixture("cart.go"), ranges: [range(32)] },
    ]);
    assert.equal(code, 0);
    assert.match(response[0].error, /^syntax error at line \d+$/);
    assert.deepEqual(names(response[1]), ["cart.New"]);
  });

  it("reports a file over maxFileBytes on its entry without parsing it", async () => {
    const { code, response } = await runMapper(
      [{ id: 1, path: "cart.go", file: fixture("cart.go"), ranges: [range(32)] }],
      { maxFileBytes: 100 },
    );
    assert.equal(code, 0);
    assert.deepEqual(response, [{ id: 1, error: "the file is larger than maxFileBytes" }]);
  });

  it("reports an unreadable file and a malformed entry on their entries", async () => {
    const { code, response } = await runMapper([
      { id: 1, path: "a.go", file: join(work, "missing.go"), ranges: [range(1)] },
      { id: 2, path: "a.go", file: fixture("cart.go"), ranges: "all" },
      { id: 3, path: "a.go", file: fixture("cart.go"), ranges: [range(5, 2)] },
      { path: "a.go", file: fixture("cart.go"), ranges: [range(1)] },
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
        runMapper([{ id: 1, path: "cart.go", file: fixture("cart.go"), ranges: [range(39)] }]),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0);
      assert.deepEqual(names(run.response[0]), ["cart.Cart.Add"]);
    }
  });
});

describe("the go mapper build inside a hostile parent directory", { skip }, () => {
  let root;
  before(() => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-go-"));
    root = mkdtempSync(join(tmpdir(), "pr-conflict-radar-go-parent-"));
  });
  after(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("builds although a parent go.mod and go.work, GOFLAGS and a GOENV file say otherwise", async () => {
    writeFileSync(join(root, "go.mod"), "module parent\n\ngo 1.21\n");
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "go.mod"), "module other\n\ngo 1.21\n");
    writeFileSync(join(root, "go.work"), "go 1.21\n\nuse ./other\n");
    const flags = "-modfile=/nonexistent/go.mod";
    const goenv = join(root, "goenv");
    writeFileSync(goenv, `GOFLAGS=${flags}\n`);
    const dir = join(root, "members", "go");
    mkdirSync(dir, { recursive: true });
    cpSync(MAPPER_DIR, dir, { recursive: true });
    const env = { ...process.env, GOFLAGS: flags, GOENV: goenv };
    await runBuild(entry, { dir, work, env });
    const { code, response } = await runMapper(
      [{ id: 1, path: "cart.go", file: fixture("cart.go"), ranges: [range(39)] }],
      { dir },
    );
    assert.equal(code, 0);
    assert.deepEqual(names(response[0]), ["cart.Cart.Add"]);
  });
});
