import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_DIR, runBuild } from "../lib/members.mjs";
import { registry } from "../members/registry.mjs";

const entry = registry.find((candidate) => candidate.key === "csharp");
const FIXTURES = fileURLToPath(new URL("./fixtures/csharp/", import.meta.url));
const MAPPER_DIR = join(ACTION_DIR, "members", "csharp");
const MAX = 1_000_000;

const hasDotnet = spawnSync("dotnet", ["--version"], { stdio: "ignore" }).status === 0;
const ci = Boolean(process.env.CI);

if (!hasDotnet && ci) {
  describe("the csharp member mapper", () => {
    it("needs a .NET SDK on the PATH", () => {
      assert.fail("no .NET SDK is on the PATH, and CI is set");
    });
  });
}

const skip = hasDotnet || ci ? false : "skipped: no .NET SDK is on the PATH";

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

const names = (result) => result.members.map((member) => member.name).sort();
const member = (result, name) => result.members.find((candidate) => candidate.name === name);

describe("the csharp registry entry", () => {
  it("builds and runs through dotnet with argument arrays and the mapper's directory", () => {
    const build = entry.build({ dir: "/a/members/csharp", work: "/w", env: { KEEP: "1" } });
    assert.equal(build.length, 1);
    assert.equal(build[0].command, "dotnet");
    assert.deepEqual(build[0].args, ["build", "MemberMap.cs"]);
    assert.equal(build[0].cwd, "/a/members/csharp");
    assert.equal(build[0].env.KEEP, "1");
    const step = entry.run({
      dir: "/a/members/csharp",
      work: "/w",
      env: {},
      request: "/r.json",
      maxFileBytes: 5,
    });
    assert.equal(step.command, "dotnet");
    assert.deepEqual(step.args, ["run", "--no-build", "MemberMap.cs", "--", "/r.json", "5"]);
    assert.equal(step.cwd, "/a/members/csharp");
  });
});

describe("the csharp member mapper", { skip }, () => {
  before(async () => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-cs-"));
    await runBuild(entry, { work });
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  it("resolves a changed body line to its method, merging overloads", async () => {
    const result = await map("Cart.cs", [range(53)]);
    assert.deepEqual(result.members, [
      { name: "Acme.Shop.Cart.operator +", kind: "operator", declarationTouched: false },
    ]);
    const total = await map("Cart.cs", [range(49)]);
    assert.deepEqual(total.members, [
      { name: "Acme.Shop.Cart.Total", kind: "method", declarationTouched: true },
    ]);
  });

  it("flags a touched signature", async () => {
    const result = await map("Cart.cs", [range(43)]);
    assert.deepEqual(result.members, [
      { name: "Acme.Shop.Cart.Total", kind: "method", declarationTouched: true },
    ]);
  });

  it("reports a local function with the method that holds it", async () => {
    const result = await map("Cart.cs", [range(45)]);
    assert.deepEqual(names(result), ["Acme.Shop.Cart.Total", "Acme.Shop.Cart.Total.Twice"]);
    assert.equal(member(result, "Acme.Shop.Cart.Total").declarationTouched, false);
    assert.equal(member(result, "Acme.Shop.Cart.Total.Twice").kind, "localFunction");
  });

  it("reports constructors, destructors, properties, indexers, fields, events and operators", async () => {
    const result = await map("Cart.cs", [
      range(20),
      range(21),
      range(25),
      range(29),
      range(32),
      range(34),
      range(38),
      range(41),
      range(58),
    ]);
    assert.deepEqual(names(result), [
      "Acme.Shop.Cart.Created",
      "Acme.Shop.Cart.Destroyed",
      "Acme.Shop.Cart.OnChange",
      "Acme.Shop.Cart.Owner",
      "Acme.Shop.Cart.Price",
      "Acme.Shop.Cart.constructor",
      "Acme.Shop.Cart.destructor",
      "Acme.Shop.Cart.items",
      "Acme.Shop.Cart.operator implicit int",
      "Acme.Shop.Cart.this[]",
    ]);
    assert.equal(member(result, "Acme.Shop.Cart.this[]").kind, "indexer");
    assert.equal(member(result, "Acme.Shop.Cart.this[]").declarationTouched, false);
    assert.equal(member(result, "Acme.Shop.Cart.Owner").kind, "property");
    assert.equal(member(result, "Acme.Shop.Cart.OnChange").kind, "event");
    assert.equal(member(result, "Acme.Shop.Cart.items").kind, "field");
    assert.equal(member(result, "Acme.Shop.Cart.constructor").declarationTouched, false);
  });

  it("reports enum members and a delegate, but the enum only for its own header", async () => {
    const result = await map("Cart.cs", [range(12), range(16)]);
    assert.deepEqual(names(result), ["Acme.Shop.Changed", "Acme.Shop.Mode.Fast"]);
    assert.equal(member(result, "Acme.Shop.Mode.Fast").kind, "enumMember");
    const header = await map("Cart.cs", [range(10)]);
    assert.deepEqual(header.members, [
      { name: "Acme.Shop.Mode", kind: "enum", declarationTouched: true },
    ]);
  });

  it("reports the members of a class, not its container, for a change inside a member", async () => {
    const result = await map("Cart.cs", [range(65)]);
    assert.deepEqual(result.members, [
      { name: "Acme.Shop.Cart.Line.Print", kind: "method", declarationTouched: false },
    ]);
  });

  it("reports a nested type and its containing type when the nested header changes", async () => {
    const result = await map("Cart.cs", [range(61)]);
    assert.deepEqual(result.members, [
      { name: "Acme.Shop.Cart.Line", kind: "class", declarationTouched: true },
    ]);
  });

  it("reports the class, the interface and the file-scoped namespace for their own headers", async () => {
    const result = await map("Cart.cs", [range(3), range(5), range(18)]);
    assert.deepEqual(names(result), ["Acme.Shop", "Acme.Shop.Cart", "Acme.Shop.IPriced"]);
    assert.equal(member(result, "Acme.Shop").kind, "namespace");
    assert.equal(member(result, "Acme.Shop.IPriced").kind, "interface");
  });

  it("merges the parts of a partial class into one member", async () => {
    const result = await map("Cart.cs", [range(18), range(70)]);
    assert.deepEqual(result.members, [
      { name: "Acme.Shop.Cart", kind: "class", declarationTouched: true },
    ]);
    const clear = await map("Cart.cs", [range(74)]);
    assert.deepEqual(clear.members, [
      { name: "Acme.Shop.Cart.Clear", kind: "method", declarationTouched: false },
    ]);
  });

  it("qualifies members of structs and records in block-scoped nested namespaces", async () => {
    const result = await map("Block.cs", [range(7), range(9), range(12)]);
    assert.deepEqual(names(result), [
      "Acme.Inner.Pair",
      "Acme.Inner.Point.Sum",
      "Acme.Inner.Point.X",
    ]);
    assert.equal(member(result, "Acme.Inner.Pair").kind, "record");
    const header = await map("Block.cs", [range(1), range(3), range(5)]);
    assert.deepEqual(names(header), ["Acme", "Acme.Inner", "Acme.Inner.Point"]);
  });

  it("returns the identifiers on the given lines only", async () => {
    const result = await map("Cart.cs", [range(74)]);
    assert.deepEqual(result.identifiers, ["Array", "Clear", "items"]);
  });

  it("reports a removed member from the base-side text", async () => {
    counter += 1;
    const base = join(work, `base-${counter}.cs`);
    writeFileSync(
      base,
      "class A\n{\n    public void Keep() { }\n\n    public void Gone()\n    {\n    }\n}\n",
    );
    const result = await map("src/A.cs", [range(5, 7)], base);
    assert.deepEqual(result.members, [
      { name: "A.Gone", kind: "method", declarationTouched: true },
    ]);
  });

  it("counts only a line feed as a line break", async () => {
    counter += 1;
    const file = join(work, `separators-${counter}.cs`);
    writeFileSync(
      file,
      "class A\r\n{\r\n    void M() { }\r    void N() { } \n    void O() { }\n}\n",
    );
    const result = await map("A.cs", [range(3)], file);
    assert.deepEqual(names(result), ["A.M", "A.N"]);
    const last = await map("A.cs", [range(4)], file);
    assert.deepEqual(names(last), ["A.O"]);
  });

  it("reports a syntax error on its entry and exits 0", async () => {
    const { code, response } = await runMapper([
      { id: "a", path: "Broken.cs", file: fixture("Broken.cs"), ranges: [range(1, 3)] },
      { id: "b", path: "Block.cs", file: fixture("Block.cs"), ranges: [range(9)] },
    ]);
    assert.equal(code, 0);
    assert.match(response[0].error, /^syntax error at line \d+$/);
    assert.equal(response[0].members, undefined);
    assert.deepEqual(names(response[1]), ["Acme.Inner.Point.Sum"]);
  });

  it("reports a deeply nested file on its entry and exits 0", async () => {
    const parens = join(work, "parens.cs");
    const depth = 50000;
    writeFileSync(parens, `class A { int X = ${"(".repeat(depth)}1${")".repeat(depth)}; }\n`);
    const types = join(work, "types.cs");
    writeFileSync(types, `${"class C { ".repeat(5000)}int X;${" }".repeat(5000)}\n`);
    const { code, response } = await runMapper([
      { id: 1, path: "a.cs", file: parens, ranges: [range(1)] },
      { id: 2, path: "b.cs", file: types, ranges: [range(1)] },
      { id: 3, path: "Block.cs", file: fixture("Block.cs"), ranges: [range(9)] },
    ]);
    assert.equal(code, 0);
    assert.ok(response[0].error, JSON.stringify(response[0]).slice(0, 200));
    assert.ok(response[1].error, JSON.stringify(response[1]).slice(0, 200));
    assert.deepEqual(names(response[2]), ["Acme.Inner.Point.Sum"]);
  });

  it("reports a file over maxFileBytes on its entry without parsing it", async () => {
    const { code, response } = await runMapper(
      [{ id: 1, path: "Cart.cs", file: fixture("Cart.cs"), ranges: [range(53)] }],
      { maxFileBytes: 100 },
    );
    assert.equal(code, 0);
    assert.deepEqual(response, [{ id: 1, error: "the file is larger than maxFileBytes" }]);
  });

  it("reports an unreadable file and a malformed entry on their entries", async () => {
    const { code, response } = await runMapper([
      { id: 1, path: "a.cs", file: join(work, "missing.cs"), ranges: [range(1)] },
      { id: 2, path: "a.cs", file: fixture("Block.cs"), ranges: "all" },
    ]);
    assert.equal(code, 0);
    assert.equal(response[0].error, "the file could not be read");
    assert.equal(response[1].error, "the request entry is malformed");
  });

  it("exits 2 with a usage line on bad arguments", async () => {
    const child = spawn("dotnet", ["run", "--no-build", "MemberMap.cs"], {
      cwd: MAPPER_DIR,
      env: process.env,
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 2);
  });

  it("answers several runs started at once after the single build", async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runMapper([{ id: 1, path: "Cart.cs", file: fixture("Cart.cs"), ranges: [range(74)] }]),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0);
      assert.deepEqual(names(run.response[0]), ["Acme.Shop.Cart.Clear"]);
    }
  });
});

describe("the csharp mapper build inside a hostile parent directory", { skip }, () => {
  let root;
  before(() => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-cs-"));
    root = mkdtempSync(join(tmpdir(), "pr-conflict-radar-cs-parent-"));
  });
  after(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("builds and runs although the parent pins central packages, an absent SDK and a dead feed", async () => {
    writeFileSync(
      join(root, "Directory.Packages.props"),
      "<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>",
    );
    writeFileSync(
      join(root, "global.json"),
      '{"sdk": {"version": "1.0.0", "rollForward": "disable"}}',
    );
    writeFileSync(
      join(root, "nuget.config"),
      '<configuration><packageSources><clear /><add key="dead" value="http://127.0.0.1:9/index.json" /></packageSources></configuration>',
    );
    const dir = join(root, "members", "csharp");
    mkdirSync(dir, { recursive: true });
    cpSync(MAPPER_DIR, dir, { recursive: true });
    await runBuild(entry, { dir, work });
    const { code, response } = await runMapper(
      [{ id: 1, path: "Cart.cs", file: fixture("Cart.cs"), ranges: [range(74)] }],
      { dir },
    );
    assert.equal(code, 0);
    assert.deepEqual(names(response[0]), ["Acme.Shop.Cart.Clear"]);
  });
});
