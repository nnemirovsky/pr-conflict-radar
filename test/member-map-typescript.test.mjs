import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTION_DIR, runBuild } from "../lib/members.mjs";
import { registry } from "../members/registry.mjs";

const entry = registry.find((candidate) => candidate.key === "typescript");
const FIXTURES = fileURLToPath(new URL("./fixtures/typescript/", import.meta.url));
const MAX = 1_000_000;

let work;
before(() => {
  work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-ts-"));
});
after(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
const fixture = (name) => join(FIXTURES, `${name}.txt`);
const range = (start, end = start) => ({ start, end });

// Runs the registry's command for one request and resolves to
// `{code, stdout, stderr, response}`.
function runMapper(request, { maxFileBytes = MAX } = {}) {
  counter += 1;
  const requestPath = join(work, `request-${counter}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  const step = entry.run({
    dir: join(ACTION_DIR, "members", "typescript"),
    work,
    env: process.env,
    request: requestPath,
    maxFileBytes,
  });
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

async function map(path, ranges, file = fixture(path)) {
  const { code, response } = await runMapper([{ id: 1, path, file, ranges }]);
  assert.equal(code, 0);
  assert.equal(response.length, 1);
  assert.equal(response[0].id, 1);
  return response[0];
}

const names = (result) => result.members.map((member) => member.name).sort();
const member = (result, name) => result.members.find((candidate) => candidate.name === name);

describe("the typescript registry entry", () => {
  it("has a run command with an argument array and no shell text", () => {
    const step = entry.run({
      dir: "/a/members/typescript",
      work: "/w",
      env: {},
      request: "/r.json",
      maxFileBytes: 5,
    });
    assert.equal(step.command, process.execPath);
    assert.deepEqual(step.args, ["/a/members/typescript/member-map.mjs", "/r.json", "5"]);
  });

  it("builds nothing when typescript already resolves, and leaves a full install untouched", async () => {
    assert.deepEqual(
      entry.build({ dir: join(ACTION_DIR, "members", "typescript"), work, env: {} }),
      [],
    );
    const before = existsSync(join(ACTION_DIR, "node_modules", "@biomejs"));
    assert.deepEqual(await runBuild(entry, { work }), []);
    assert.equal(existsSync(join(ACTION_DIR, "node_modules", "@biomejs")), before);
    assert.ok(existsSync(join(ACTION_DIR, "node_modules", "yaml")));
    assert.ok(existsSync(join(ACTION_DIR, "node_modules", "typescript")));
  });

  it("runs npm ci for production dependencies only, without scripts, in the action's directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-conflict-radar-ts-root-"));
    try {
      mkdirSync(join(root, "members", "typescript"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      const steps = entry.build({
        dir: join(root, "members", "typescript"),
        work,
        env: { KEEP: "1" },
      });
      assert.equal(steps.length, 1);
      assert.equal(steps[0].command, "npm");
      assert.deepEqual(steps[0].args, ["ci", "--omit=dev", "--ignore-scripts"]);
      assert.equal(steps[0].cwd, root);
      assert.equal(steps[0].env.KEEP, "1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the typescript member mapper", () => {
  it("resolves a changed body line to its function", async () => {
    const result = await map("cart.ts", [range(13)]);
    assert.deepEqual(result.members, [
      { name: "computeTotal", kind: "function", declarationTouched: false },
    ]);
  });

  it("flags a touched signature", async () => {
    const result = await map("cart.ts", [range(12)]);
    assert.deepEqual(result.members, [
      { name: "computeTotal", kind: "function", declarationTouched: true },
    ]);
  });

  it("qualifies a method of a class in a namespace", async () => {
    const result = await map("cart.ts", [range(24)]);
    assert.deepEqual(result.members, [
      { name: "shop.Cart.add", kind: "method", declarationTouched: false },
    ]);
  });

  it("reports the members of a class, not its container, for a change inside a member", async () => {
    const result = await map("cart.ts", [range(28), range(32)]);
    assert.deepEqual(names(result), ["shop.Cart.empty", "shop.Cart.size"].sort());
    assert.equal(member(result, "shop.Cart.size").kind, "getter");
  });

  it("reports the class and the namespace when their own header changes", async () => {
    const result = await map("cart.ts", [range(17, 18)]);
    assert.ok(member(result, "shop"));
    assert.ok(member(result, "shop.Cart"));
    assert.equal(member(result, "shop.Cart").declarationTouched, true);
  });

  it("reports constructors, properties, interfaces, type aliases, enums and exported constants", async () => {
    const result = await map("cart.ts", [
      range(3),
      range(6),
      range(10),
      range(19),
      range(21),
      range(38, 39),
    ]);
    assert.deepEqual(names(result), [
      "Line",
      "Mode.Fast",
      "Mode.Slow",
      "TAX_RATE",
      "Total",
      "shop.Cart.constructor",
      "shop.Cart.items",
    ]);
    assert.equal(member(result, "TAX_RATE").kind, "const");
    assert.equal(member(result, "Mode.Fast").kind, "enumMember");
  });

  it("reports an arrow-function constant and a generic arrow function in a .ts file", async () => {
    const result = await map("generic.ts", [range(4)]);
    assert.deepEqual(result.members, [
      { name: "pair", kind: "function", declarationTouched: false },
    ]);
    const first = await map("generic.ts", [range(1)]);
    assert.deepEqual(first.members, [
      { name: "identity", kind: "function", declarationTouched: true },
    ]);
    const helper = await map("cart.ts", [range(42)]);
    assert.deepEqual(helper.members, [
      { name: "helper", kind: "function", declarationTouched: true },
    ]);
  });

  it("reports components in .tsx and .jsx files", async () => {
    const tsx = await map("view.tsx", [range(4), range(8)]);
    assert.deepEqual(tsx.members, [
      { name: "Badge", kind: "component", declarationTouched: false },
      { name: "Panel", kind: "component", declarationTouched: false },
    ]);
    const jsx = await map("widget.jsx", [range(2)]);
    assert.deepEqual(jsx.members, [
      { name: "Widget", kind: "component", declarationTouched: false },
    ]);
  });

  it("parses JSX in a .js file", async () => {
    const result = await map("jsx-in-js.js", [range(2)]);
    assert.deepEqual(result.members, [
      { name: "render", kind: "function", declarationTouched: false },
    ]);
    assert.ok(result.identifiers.includes("items"));
  });

  it("maps .mjs and .cjs files", async () => {
    const mjs = await map("plain.mjs", [range(2)]);
    assert.deepEqual(names(mjs), ["plain"]);
    const cjs = await map("plain.cjs", [range(2)]);
    assert.deepEqual(names(cjs), ["legacy"]);
  });

  it("keys the language on the path extension, not the file name", async () => {
    const result = await map("deep/dir/Thing.tsx", [range(4)], fixture("view.tsx"));
    assert.deepEqual(names(result), ["Badge"]);
  });

  it("returns the identifiers on the given lines only", async () => {
    const result = await map("cart.ts", [range(14)]);
    assert.deepEqual(result.identifiers, ["TAX_RATE", "gross", "net", "round"]);
  });

  it("reports a removed member from the base-side text", async () => {
    counter += 1;
    const base = join(work, `base-${counter}.ts`);
    writeFileSync(
      base,
      "export function keep() {\n  return 1;\n}\n\nexport function gone() {\n  return 2;\n}\n",
    );
    const result = await map("src/a.ts", [range(5, 7)], base);
    assert.deepEqual(result.members, [
      { name: "gone", kind: "function", declarationTouched: true },
    ]);
  });

  it("reports a syntax error on its entry and exits 0", async () => {
    const { code, response } = await runMapper([
      { id: "a", path: "broken.ts", file: fixture("broken.ts"), ranges: [range(1, 3)] },
      { id: "b", path: "plain.mjs", file: fixture("plain.mjs"), ranges: [range(2)] },
    ]);
    assert.equal(code, 0);
    assert.match(response[0].error, /^syntax error at line \d+$/);
    assert.equal(response[0].members, undefined);
    assert.deepEqual(names(response[1]), ["plain"]);
  });

  it("reports a file nested thousands of levels deep on its entry and exits 0", async () => {
    const file = join(work, "deep.ts");
    const depth = 20000;
    writeFileSync(file, `export const x = ${"(".repeat(depth)}1${")".repeat(depth)};\n`);
    const { code, response } = await runMapper([
      { id: 1, path: "deep.ts", file, ranges: [range(1)] },
      { id: 2, path: "plain.mjs", file: fixture("plain.mjs"), ranges: [range(2)] },
    ]);
    assert.equal(code, 0);
    assert.ok(response[0].error, JSON.stringify(response[0]).slice(0, 200));
    assert.equal(response[0].members, undefined);
    assert.deepEqual(names(response[1]), ["plain"]);
  });

  it("reports a file over maxFileBytes on its entry without parsing it", async () => {
    const { code, response } = await runMapper(
      [{ id: 1, path: "cart.ts", file: fixture("cart.ts"), ranges: [range(13)] }],
      { maxFileBytes: 100 },
    );
    assert.equal(code, 0);
    assert.deepEqual(response, [{ id: 1, error: "the file is larger than maxFileBytes" }]);
  });

  it("reports an unreadable file and a malformed entry on their entries", async () => {
    const { code, response } = await runMapper([
      { id: 1, path: "a.ts", file: join(work, "missing.ts"), ranges: [range(1)] },
      { id: 2, path: "a.ts", file: fixture("plain.mjs"), ranges: "all" },
    ]);
    assert.equal(code, 0);
    assert.equal(response[0].error, "the file could not be read");
    assert.equal(response[1].error, "the request entry is malformed");
  });

  it("parses a file with top-level side effects without executing it", async () => {
    const marker = join(work, "effect-marker");
    counter += 1;
    const requestPath = join(work, `request-${counter}.json`);
    writeFileSync(
      requestPath,
      JSON.stringify([
        { id: 1, path: "effects.ts", file: fixture("effects.ts"), ranges: [range(1, 8)] },
      ]),
    );
    const step = entry.run({
      dir: join(ACTION_DIR, "members", "typescript"),
      work,
      env: { ...process.env, EFFECT_MARKER: marker },
      request: requestPath,
      maxFileBytes: MAX,
    });
    const response = await new Promise((resolve, reject) => {
      const child = spawn(step.command, step.args, { cwd: step.cwd, env: step.env });
      const out = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.on("error", reject);
      child.on("close", () => resolve(JSON.parse(Buffer.concat(out).toString("utf8"))));
    });
    assert.deepEqual(names(response[0]), ["never"]);
    assert.equal(existsSync(marker), false);
  });

  it("answers several runs started at once", async () => {
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        runMapper([{ id: 1, path: "cart.ts", file: fixture("cart.ts"), ranges: [range(13)] }]),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0);
      assert.deepEqual(names(run.response[0]), ["computeTotal"]);
    }
  });

  it("exits 2 with a usage line on bad arguments", async () => {
    const child = spawn(process.execPath, [
      join(ACTION_DIR, "members", "typescript", "member-map.mjs"),
    ]);
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 2);
  });
});
