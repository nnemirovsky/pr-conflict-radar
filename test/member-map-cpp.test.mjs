import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_DIR, runBuild } from "../lib/members.mjs";
import { registry } from "../members/registry.mjs";

const entry = registry.find((candidate) => candidate.key === "cpp");
const FIXTURES = fileURLToPath(new URL("./fixtures/cpp/", import.meta.url));
const MAPPER_DIR = join(ACTION_DIR, "members", "cpp");
const MAX = 10_000_000;
const PYTHON = process.platform === "win32" ? "python" : "python3";

const hasPython =
  spawnSync(PYTHON, ["-I", "-c", "import venv, ensurepip"], { stdio: "ignore" }).status === 0;
const ci = Boolean(process.env.CI);

if (!hasPython && ci) {
  describe("the c and c++ member mapper", () => {
    it("needs python3 with the venv module on the PATH", () => {
      assert.fail("python3 with the venv module is not on the PATH, and CI is set");
    });
  });
}

const skip = hasPython || ci ? false : "skipped: python3 with the venv module is not on the PATH";

let work;
let counter = 0;
const fixture = (name) => join(FIXTURES, `${name}.txt`);
const range = (start, end = start) => ({ start, end });
const TRACE = { ...process.env, PR_CONFLICT_RADAR_TRACE: "1" };
const venvPython = (base) =>
  process.platform === "win32"
    ? join(base, "cpp-venv", "Scripts", "python.exe")
    : join(base, "cpp-venv", "bin", "python");

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

function writeDefines(defines) {
  counter += 1;
  const path = join(work, `defines-${counter}.json`);
  writeFileSync(path, JSON.stringify(defines));
  return path;
}

// Runs the registry's command for one request and resolves to
// `{code, stdout, stderr, response}`.
function runMapper(
  request,
  { maxFileBytes = MAX, dir = MAPPER_DIR, defines, env = process.env, cwd } = {},
) {
  counter += 1;
  const requestPath = join(work, `request-${counter}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  const step = entry.run({
    dir,
    work,
    env,
    request: requestPath,
    maxFileBytes,
    defines: defines === undefined ? undefined : writeDefines(defines),
  });
  return spawnStep(cwd === undefined ? step : { ...step, cwd });
}

async function map(path, ranges, { file = fixture(path), defines, env } = {}) {
  const { code, response, stderr } = await runMapper([{ id: 1, path, file, ranges }], {
    defines,
    env,
  });
  assert.equal(code, 0, stderr);
  assert.equal(response.length, 1);
  assert.equal(response[0].id, 1);
  return response[0];
}

function scratch(text) {
  counter += 1;
  const file = join(work, `scratch-${counter}.txt`);
  writeFileSync(file, text);
  return file;
}

const names = (result) => result.members.map((member) => member.name).sort();
const member = (result, name) => result.members.find((candidate) => candidate.name === name);

describe("the cpp registry entry", () => {
  it("builds a venv and installs the hashed requirements with a clean pip environment", () => {
    const env = {
      KEEP: "1",
      PATH: "/bin",
      PIP_TARGET: "/elsewhere",
      PIP_USER: "1",
      PIP_INDEX_URL: "https://mirror.invalid/simple",
      PYTHONPATH: "/planted",
      PYTHONHOME: "/planted",
    };
    const build = entry.build({ dir: MAPPER_DIR, work: "/w", env });
    assert.equal(build.length, 2);
    assert.equal(build[0].command, PYTHON);
    assert.deepEqual(build[0].args, ["-I", "-m", "venv", join("/w", "cpp-venv")]);
    assert.equal(build[1].command, venvPython("/w"));
    assert.deepEqual(build[1].args, [
      "-I",
      "-m",
      "pip",
      "install",
      "--require-hashes",
      "--only-binary",
      ":all:",
      "--no-deps",
      "-r",
      join(MAPPER_DIR, "requirements.txt"),
    ]);
    for (const step of build) {
      assert.equal(step.cwd, "/w");
      assert.deepEqual(step.env, {
        KEEP: "1",
        PATH: "/bin",
        PIP_CONFIG_FILE: devNull,
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PIP_NO_INPUT: "1",
      });
    }
  });

  it("runs the venv's interpreter isolated, with the defines file as a third argument", () => {
    const plain = entry.run({
      dir: MAPPER_DIR,
      work: "/w",
      env: {},
      request: "/r.json",
      maxFileBytes: 5,
    });
    assert.equal(plain.command, venvPython("/w"));
    assert.deepEqual(plain.args, ["-I", join(MAPPER_DIR, "member_map.py"), "/r.json", "5"]);
    assert.equal(plain.cwd, "/w");
    const withDefines = entry.run({
      dir: MAPPER_DIR,
      work: "/w",
      env: {},
      request: "/r.json",
      maxFileBytes: 5,
      defines: "/d.json",
    });
    assert.deepEqual(withDefines.args.slice(2), ["/r.json", "5", "/d.json"]);
  });

  it("pins libclang to one release with a hash for every wheel", () => {
    const text = readFileSync(join(MAPPER_DIR, "requirements.txt"), "utf8");
    assert.match(text, /^libclang==\d+\.\d+\.\d+ \\$/m);
    const hashes = text.match(/--hash=sha256:[0-9a-f]{64}/g);
    assert.ok(hashes.length >= 2);
    assert.equal(new Set(hashes).size, hashes.length);
  });
});

describe("the c and c++ member mapper", { skip }, () => {
  before(async () => {
    work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-cpp-"));
    await runBuild(entry, { work });
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  it("resolves a changed body line to its out-of-line method", async () => {
    const result = await map("widget.cpp", [range(42)]);
    assert.deepEqual(result.members, [
      { name: "acme::ui::Panel::draw", kind: "method", declarationTouched: false },
    ]);
  });

  it("flags a touched signature, up to the line of the body's brace", async () => {
    const signature = await map("widget.cpp", [range(39)]);
    assert.deepEqual(signature.members, [
      { name: "acme::ui::Panel::draw", kind: "method", declarationTouched: true },
    ]);
    const initializer = await map("widget.cpp", [range(30)]);
    assert.deepEqual(initializer.members, [
      { name: "acme::ui::Panel::Panel", kind: "constructor", declarationTouched: true },
    ]);
    const body = await map("widget.cpp", [range(31)]);
    assert.deepEqual(body.members, [
      { name: "acme::ui::Panel::Panel", kind: "constructor", declarationTouched: false },
    ]);
    const destructor = await map("widget.cpp", [range(36)]);
    assert.deepEqual(destructor.members, [
      { name: "acme::ui::Panel::~Panel", kind: "destructor", declarationTouched: false },
    ]);
  });

  it("merges an in-class declaration with its out-of-line definition", async () => {
    const result = await map("widget.cpp", [range(21), range(42)]);
    assert.deepEqual(result.members, [
      { name: "acme::ui::Panel::draw", kind: "method", declarationTouched: true },
    ]);
  });

  it("reports fields, and a static data member with its definition", async () => {
    const fields = await map("widget.cpp", [range(22, 23)]);
    assert.deepEqual(names(fields), ["acme::ui::Panel::height", "acme::ui::Panel::width"]);
    assert.equal(member(fields, "acme::ui::Panel::width").kind, "field");
    const definition = await map("widget.cpp", [range(27)]);
    assert.deepEqual(definition.members, [
      { name: "acme::ui::Panel::count", kind: "field", declarationTouched: true },
    ]);
  });

  it("reports a class, a namespace and an enum only for their own header lines", async () => {
    const header = await map("widget.cpp", [range(17)]);
    assert.deepEqual(header.members, [
      { name: "acme::ui::Panel", kind: "class", declarationTouched: true },
    ]);
    const namespaces = await map("widget.cpp", [range(10, 11)]);
    assert.deepEqual(names(namespaces), ["acme", "acme::ui"]);
    assert.equal(member(namespaces, "acme").kind, "namespace");
  });

  it("reports a function template and a type alias", async () => {
    const body = await map("widget.cpp", [range(48)]);
    assert.deepEqual(body.members, [
      { name: "acme::ui::clampValue", kind: "function", declarationTouched: false },
    ]);
    const header = await map("widget.cpp", [range(45)]);
    assert.equal(member(header, "acme::ui::clampValue").declarationTouched, true);
    const alias = await map("widget.cpp", [range(15)]);
    assert.deepEqual(alias.members, [
      { name: "acme::ui::Size", kind: "type", declarationTouched: true },
    ]);
  });

  it("reports enum constants qualified by their enum", async () => {
    const result = await map("widget.cpp", [range(13)]);
    assert.deepEqual(names(result), [
      "acme::ui::Mode",
      "acme::ui::Mode::Busy",
      "acme::ui::Mode::Done",
      "acme::ui::Mode::Idle",
    ]);
    assert.equal(member(result, "acme::ui::Mode::Idle").kind, "enumMember");
    assert.equal(member(result, "acme::ui::Mode").kind, "enum");
  });

  it("parses both branches of an #ifdef", async () => {
    const result = await map("widget.cpp", [range(4, 8)]);
    assert.deepEqual(names(result), ["fastScale", "slowScale"]);
  });

  it("returns the identifiers on the given lines, a macro name among them", async () => {
    const macro = await map("widget.cpp", [range(41)]);
    assert.deepEqual(macro.identifiers, ["ACME_TRACE", "depth"]);
    const call = await map("widget.cpp", [range(42)]);
    assert.deepEqual(call.identifiers, ["height", "render", "width"]);
    const condition = await map("widget.cpp", [range(4)]);
    assert.deepEqual(condition.identifiers, ["ACME_FAST"]);
  });

  it("takes no identifier from an include line", async () => {
    const result = await map("widget.cpp", [range(1, 2)]);
    assert.deepEqual(result, { id: 1, members: [], identifiers: [] });
  });

  it("parses a .c file as C", async () => {
    const result = await map("cart.c", [range(3), range(9), range(16)]);
    assert.deepEqual(result.members, [
      { name: "counter", kind: "var", declarationTouched: true },
      { name: "cart_total", kind: "function", declarationTouched: false },
      { name: "cart_reset", kind: "function", declarationTouched: false },
    ]);
    const file = scratch("int class = 1;\nint new = 2;\n");
    const keywords = await map("legacy.c", [range(1, 2)], { file });
    assert.deepEqual(names(keywords), ["class", "new"]);
  });

  it("parses a .h header as C++", async () => {
    const result = await map("cart.h", [range(7), range(11), range(13)]);
    assert.deepEqual(names(result), [
      "cart_item::name",
      "cart_state",
      "cart_state::CART_OPEN",
      "cart_state::CART_PAID",
      "cart_total",
    ]);
    assert.equal(member(result, "cart_total").declarationTouched, true);
    const alias = await map("cart.h", [range(9)]);
    assert.deepEqual(alias.members, [
      { name: "cart_item", kind: "type", declarationTouched: true },
    ]);
    const file = scratch("template <class T> struct Holder { T value; };\n");
    const cpp = await map("holder.h", [range(1)], { file });
    assert.deepEqual(names(cpp), ["Holder", "Holder::value"]);
    assert.equal(member(cpp, "Holder").kind, "struct");
  });

  it("reports a removed member from the base-side text", async () => {
    const base = scratch("int keep() { return 1; }\n\nint gone()\n{\n    return 2;\n}\n");
    const result = await map("src/a.cpp", [range(3, 6)], { file: base });
    assert.deepEqual(result.members, [
      { name: "gone", kind: "function", declarationTouched: true },
    ]);
  });

  it("keeps every member after an error inside a function body", async () => {
    const broken = await map("widget.cpp", [range(53)]);
    assert.deepEqual(broken.members, [
      { name: "acme::ui::broken", kind: "function", declarationTouched: false },
    ]);
    const later = await map("widget.cpp", [range(59)]);
    assert.deepEqual(later.members, [
      { name: "acme::ui::afterBroken", kind: "function", declarationTouched: false },
    ]);
  });

  it("reports out-of-line members of classes declared only in an unread header", async () => {
    const result = await map("prelude.cpp", [range(6), range(8), range(12), range(17), range(23)], {
      env: TRACE,
    });
    assert.equal(result.trace.parses, 2);
    assert.deepEqual(result.members, [
      { name: "acme::ui::Widget::Widget", kind: "constructor", declarationTouched: true },
      { name: "acme::ui::Widget::~Widget", kind: "destructor", declarationTouched: true },
      { name: "acme::ui::Widget::resize", kind: "method", declarationTouched: false },
      { name: "acme::ui::Widget::Layout::columns", kind: "method", declarationTouched: false },
      { name: "acme::ui::Box::put", kind: "method", declarationTouched: false },
    ]);
    const signatures = await map("prelude.cpp", [range(10), range(15), range(21), range(29)]);
    assert.deepEqual(
      signatures.members.map((m) => [m.name, m.declarationTouched]),
      [
        ["net::Socket::open", true],
        ["acme::ui::Widget::resize", true],
        ["acme::ui::Widget::Layout::columns", true],
        ["acme::ui::Box::put", true],
      ],
    );
    const qualified = await map("prelude.cpp", [range(31)]);
    assert.deepEqual(qualified.members, [
      { name: "net::Socket::open", kind: "method", declarationTouched: false },
    ]);
  });

  it("keeps a member typed with nested qualified templates and the member after it", async () => {
    const result = await map("prelude.cpp", [range(35, 36)]);
    assert.deepEqual(result.members, [
      { name: "Ledger::entries", kind: "field", declarationTouched: true },
      { name: "Ledger::total", kind: "field", declarationTouched: true },
    ]);
  });

  it("never synthesizes a name the file declares, and reports nothing on the synthesized line", async () => {
    const result = await map("prelude.cpp", [range(1, 46)], { env: TRACE });
    assert.doesNotMatch(result.trace.prelude, /\bCart\b/);
    assert.match(result.trace.prelude, /\bWidget\b/);
    assert.doesNotMatch(result.trace.prelude, /\n/);
    assert.deepEqual(names(result), [
      "Cart",
      "Cart::add",
      "Ledger",
      "Ledger::entries",
      "Ledger::total",
      "acme",
      "acme::ui",
      "acme::ui::Box::put",
      "acme::ui::Widget::Layout::columns",
      "acme::ui::Widget::Widget",
      "acme::ui::Widget::resize",
      "acme::ui::Widget::~Widget",
      "net::Socket::open",
    ]);
    assert.equal(member(result, "Cart").kind, "class");
    const first = await map("prelude.cpp", [range(1)]);
    assert.deepEqual(first, { id: 1, members: [], identifiers: [] });
  });

  it("parses a file with no undeclared identifier once", async () => {
    const header = await map("cart.h", [range(13)], { env: TRACE });
    assert.deepEqual(header.trace, { parses: 1, prelude: "" });
    const widget = await map("widget.cpp", [range(42)], { env: TRACE });
    assert.deepEqual(widget.trace, { parses: 1, prelude: "" });
  });

  it("loses a function behind a calling-convention macro unless defines names it", async () => {
    const file = scratch("int APIENTRY Start(void)\n{\n    return 0;\n}\n");
    const without = await map("start.cpp", [range(1, 4)], { file });
    assert.equal(member(without, "Start"), undefined);
    const withDefines = await map("start.cpp", [range(1, 4)], { file, defines: ["APIENTRY"] });
    assert.deepEqual(withDefines.members, [
      { name: "Start", kind: "function", declarationTouched: true },
    ]);
  });

  it("reports the methods after a message map with its macros in defines", async () => {
    const file = scratch(
      [
        "BEGIN_MESSAGE_MAP(CartView, BaseView)",
        "END_MESSAGE_MAP()",
        "",
        "void CartView::OnOpen()",
        "{",
        "    refresh();",
        "}",
        "",
      ].join("\n"),
    );
    const without = await map("view.cpp", [range(6)], { file });
    assert.deepEqual(without.members, []);
    const defined = await map("view.cpp", [range(6)], {
      file,
      defines: ["BEGIN_MESSAGE_MAP(...)", "END_MESSAGE_MAP(...)"],
    });
    assert.deepEqual(defined.members, [
      { name: "CartView::OnOpen", kind: "method", declarationTouched: false },
    ]);
    const entries = await map("macros.cpp", [range(9), range(14)], {
      defines: ["BEGIN_MESSAGE_MAP(...)", "ON_COMMAND(...)", "END_MESSAGE_MAP(...)"],
    });
    assert.deepEqual(names(entries), ["CartView::OnOpen", "CartView::Total"]);
  });

  it("reports a test-registration block with kind macro", async () => {
    const defines = ["BEGIN_MESSAGE_MAP(...)", "ON_COMMAND(...)", "END_MESSAGE_MAP(...)"];
    const body = await map("macros.cpp", [range(19), range(24)], { defines });
    assert.deepEqual(body.members, [{ name: "TEST_F", kind: "macro", declarationTouched: false }]);
    const header = await map("macros.cpp", [range(17)], { defines });
    assert.deepEqual(header.members, [{ name: "TEST_F", kind: "macro", declarationTouched: true }]);
    const file = scratch("int RUN_ALL()\n{\n    return 0;\n}\n");
    const typed = await map("main.cpp", [range(3)], { file });
    assert.deepEqual(typed.members, [
      { name: "RUN_ALL", kind: "function", declarationTouched: false },
    ]);
  });

  it("refuses a defines entry that fails the pattern", async () => {
    const request = [{ id: 1, path: "a.cpp", file: fixture("widget.cpp"), ranges: [range(1)] }];
    for (const defines of [["A B"], ["X=1"], ["-Dfoo"], ["F(x)"], [7], "APIENTRY"]) {
      const { code, stdout, stderr } = await runMapper(request, { defines });
      assert.equal(code, 2, JSON.stringify(defines));
      assert.equal(stdout, "");
      assert.match(stderr, /defines/);
    }
    const tooMany = Array.from({ length: 201 }, (_, i) => `M${i}`);
    assert.equal((await runMapper(request, { defines: tooMany })).code, 2);
  });

  it("reads no included file: an include of /dev/zero ends at once", async () => {
    const file = scratch('#include "/dev/zero"\nint after() { return 0; }\n');
    const started = Date.now();
    const result = await map("zero.cpp", [range(2)], { file });
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(names(result), ["after"]);
  });

  it("stops a constexpr loop of 10^12 steps early", async () => {
    const file = scratch(
      [
        "constexpr long sum() {",
        "    long s = 0;",
        "    for (long i = 0; i < 1000000000000; ++i) s += i;",
        "    return s;",
        "}",
        "constexpr long total = sum();",
        "int after() { return 0; }",
        "",
      ].join("\n"),
    );
    const started = Date.now();
    const result = await map("loop.cpp", [range(1, 7)], { file });
    // clang's default limits take about 2.4 seconds on this loop.
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.deepEqual(names(result), ["after", "sum", "total"]);
  });

  it("reports 100,000 chained ! on their entry while the other entries keep their members", async () => {
    const file = scratch(`int x = ${"!".repeat(100_000)}1;\n`);
    const { code, response } = await runMapper([
      { id: 1, path: "deep.cpp", file, ranges: [range(1)] },
      { id: 2, path: "widget.cpp", file: fixture("widget.cpp"), ranges: [range(42)] },
    ]);
    assert.equal(code, 0);
    assert.deepEqual(response[0], { id: 1, error: "the parser failed on the file" });
    assert.deepEqual(names(response[1]), ["acme::ui::Panel::draw"]);
  });

  it("kills a parse that hangs after 20 seconds, while the other entries keep their members", async () => {
    // libclang 18 does not return on 100,000 array dimensions.
    const file = scratch(`int grid${"[1]".repeat(100_000)};\n`);
    const started = Date.now();
    const { code, response } = await runMapper([
      { id: 1, path: "hang.cpp", file, ranges: [range(1)] },
      { id: 2, path: "widget.cpp", file: fixture("widget.cpp"), ranges: [range(42)] },
    ]);
    assert.equal(code, 0);
    assert.deepEqual(response[0], { id: 1, error: "the parser took longer than 20 seconds" });
    assert.deepEqual(names(response[1]), ["acme::ui::Panel::draw"]);
    assert.ok(Date.now() - started < 40_000);
  });

  it("starts no parse that could end past the batch limit and reports the entries it left", async () => {
    // A named pipe without a writer blocks the child that opens it.
    counter += 1;
    const pipe = join(work, `pipe-${counter}`);
    assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
    const env = {
      ...process.env,
      PR_CONFLICT_RADAR_CHILD_LIMIT: "1.5",
      PR_CONFLICT_RADAR_BATCH_LIMIT: "3.5",
    };
    const request = [
      ...Array.from({ length: 9 }, (_, i) => ({
        id: i + 1,
        path: "hang.cpp",
        file: pipe,
        ranges: [range(1)],
      })),
      { id: 10, path: "widget.cpp", file: fixture("widget.cpp"), ranges: [range(42)] },
    ];
    const started = Date.now();
    const { code, response } = await runMapper(request, { env });
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    const timedOut = "the parser took longer than 1.5 seconds";
    const outOfTime = "the mapper ran out of time before it parsed the file";
    assert.deepEqual(
      response.map((answer) => answer.id),
      request.map((item) => item.id),
    );
    assert.ok(response.every((answer) => [timedOut, outOfTime].includes(answer.error)));
    assert.equal(response[0].error, timedOut);
    // At most four children run at once, so two rounds start at most eight.
    assert.deepEqual(response[9], { id: 10, error: outOfTime });
    assert.ok(elapsed < 6000, `took ${elapsed} ms`);
  });

  it("reports a file over maxFileBytes on its entry without parsing it", async () => {
    const { code, response } = await runMapper(
      [{ id: 1, path: "widget.cpp", file: fixture("widget.cpp"), ranges: [range(42)] }],
      { maxFileBytes: 100 },
    );
    assert.equal(code, 0);
    assert.deepEqual(response, [{ id: 1, error: "the file is larger than maxFileBytes" }]);
  });

  it("reports an unreadable file and a malformed entry on their entries", async () => {
    const { code, response } = await runMapper([
      { id: 1, path: "a.cpp", file: join(work, "missing.cpp"), ranges: [range(1)] },
      { id: 2, path: "a.cpp", file: fixture("widget.cpp"), ranges: "all" },
      { id: 3, path: "a.cpp", file: fixture("widget.cpp"), ranges: [range(5, 2)] },
      { path: "a.cpp", file: fixture("widget.cpp"), ranges: [range(42)] },
    ]);
    assert.equal(code, 0);
    assert.equal(response[0].error, "the file could not be read");
    assert.equal(response[1].error, "the request entry is malformed");
    assert.equal(response[2].error, "the request entry is malformed");
    assert.equal(response[3].id, null);
    assert.deepEqual(names(response[3]), ["acme::ui::Panel::draw"]);
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
    const bare = await spawnStep({ ...run, args: run.args.slice(0, 2) });
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /usage/);
  });

  it("answers several runs started at once after the single build", async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runMapper([
          { id: 1, path: "widget.cpp", file: fixture("widget.cpp"), ranges: [range(42)] },
          { id: 2, path: "prelude.cpp", file: fixture("prelude.cpp"), ranges: [range(12)] },
        ]),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0);
      assert.deepEqual(names(run.response[0]), ["acme::ui::Panel::draw"]);
      assert.deepEqual(names(run.response[1]), ["acme::ui::Widget::resize"]);
    }
  });

  it("loads the venv's clang.cindex although a clang package is planted around it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-conflict-radar-cpp-plant-"));
    try {
      const markers = [];
      const plant = (name) => {
        const dir = join(root, name);
        mkdirSync(join(dir, "clang"), { recursive: true });
        const marker = join(root, `${name}-imported`);
        markers.push(marker);
        const code = `open(${JSON.stringify(marker)}, "w").close()\n`;
        writeFileSync(join(dir, "clang", "__init__.py"), code);
        writeFileSync(join(dir, "clang", "cindex.py"), code);
        return dir;
      };
      const cwd = plant("cwd");
      const beside = plant("beside");
      const onPath = plant("path");
      copyFileSync(join(MAPPER_DIR, "member_map.py"), join(beside, "member_map.py"));
      const { code, response } = await runMapper(
        [{ id: 1, path: "widget.cpp", file: fixture("widget.cpp"), ranges: [range(42)] }],
        { dir: beside, cwd, env: { ...process.env, PYTHONPATH: onPath } },
      );
      assert.equal(code, 0);
      assert.deepEqual(names(response[0]), ["acme::ui::Panel::draw"]);
      for (const marker of markers) assert.equal(existsSync(marker), false, marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
