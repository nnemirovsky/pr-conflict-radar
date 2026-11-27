import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { changedFiles, changedRanges, parseHunkRanges } from "../lib/git.mjs";
import { createFixture } from "./fixture-repo.mjs";

const lines = (...rows) => `${rows.join("\n")}\n`;

describe("parseHunkRanges", () => {
  it("reads counts, omitted counts and zero counts", () => {
    const out = [
      "diff --git a b",
      "@@ -3 +3 @@ function trailing(text) {",
      "-old",
      "+new",
      "@@ -10,0 +11,2 @@",
      "+a",
      "+b",
      "@@ -20,3 +23,0 @@ class A {",
      "-x",
    ].join("\n");
    assert.deepEqual(parseHunkRanges(out), {
      old: [
        { start: 3, end: 3 },
        { start: 20, end: 22 },
      ],
      new: [
        { start: 3, end: 3 },
        { start: 11, end: 12 },
      ],
    });
  });

  it("does not read a content line that looks like a header", () => {
    const out = ["@@ -1 +1 @@", "-@@ -5 +5 @@ x", "+@@ -6 +6 @@ y"].join("\n");
    assert.deepEqual(parseHunkRanges(out), {
      old: [{ start: 1, end: 1 }],
      new: [{ start: 1, end: 1 }],
    });
  });
});

describe("changedRanges", () => {
  let fixture;
  let options;
  let base;
  let head;
  const entry = (commitFiles, path) => commitFiles.find((file) => file.path === path);

  before(() => {
    fixture = createFixture();
    const config = join(fixture.dir, "gitconfig");
    writeFileSync(
      config,
      '[diff]\n\tnoprefix = true\n\texternal = /nonexistent/diff-tool\n\talgorithm = patience\n[color]\n\tui = always\n[color "diff"]\n\tnew = green\n',
    );
    mkdirSync(join(fixture.remote, "info"), { recursive: true });
    writeFileSync(join(fixture.remote, "info", "attributes"), "*.bin -diff\n*.ts -diff\n");
    options = { cwd: fixture.remote, env: { GIT_CONFIG_GLOBAL: config } };
    base = fixture.commit({
      branch: "main",
      files: {
        "mod.ts": lines("a", "b", "c", "d", "e"),
        "add.ts": lines("a", "b", "c"),
        "del.ts": lines("a", "b", "c"),
        "same.ts": lines("a", "b"),
        "rename-old.ts": lines("one", "two", "three", "four", "five", "six"),
        "tail.ts": lines("a", "b"),
        "data.bin": "x\ny\nz\n",
      },
    });
    head = fixture.commit({
      branch: "feature",
      files: {
        "mod.ts": lines("a", "B", "c", "d", "e", "f"),
        "add.ts": lines("a", "b", "c", "d", "e"),
        "del.ts": lines("a", "c"),
        "rename-old.ts": null,
        "rename-new.ts": lines("one", "two", "three", "FOUR", "five", "six"),
        "new.ts": lines("first", "second", "third"),
        "tail.ts": "a\nb\nc",
        "data.bin": "x\nY\nz\n",
      },
    });
  });

  after(() => fixture.cleanup());

  async function ranges(path) {
    const files = await changedFiles(base, head, options);
    const file = entry(files, path);
    assert.ok(file, `no changed file ${path}`);
    return changedRanges(file.oldBlob, file.newBlob, options);
  }

  it("reports a modification on both sides", async () => {
    assert.deepEqual(await ranges("mod.ts"), {
      old: [{ start: 2, end: 2 }],
      new: [
        { start: 2, end: 2 },
        { start: 6, end: 6 },
      ],
    });
  });

  it("reports a pure addition on the new side only", async () => {
    assert.deepEqual(await ranges("add.ts"), { old: [], new: [{ start: 4, end: 5 }] });
  });

  it("reports a pure deletion on the old side only", async () => {
    assert.deepEqual(await ranges("del.ts"), { old: [{ start: 2, end: 2 }], new: [] });
  });

  it("follows a rename with an edit", async () => {
    assert.deepEqual(await ranges("rename-new.ts"), {
      old: [{ start: 4, end: 4 }],
      new: [{ start: 4, end: 4 }],
    });
  });

  it("covers a new file and a deleted file whole", async () => {
    assert.deepEqual(await ranges("new.ts"), { old: [], new: [{ start: 1, end: 3 }] });
    const files = await changedFiles(
      base,
      fixture.commit({ parent: base, files: { "del.ts": null } }),
      options,
    );
    const deleted = entry(files, "del.ts");
    assert.deepEqual(await changedRanges(deleted.oldBlob, deleted.newBlob, options), {
      old: [{ start: 1, end: 3 }],
      new: [],
    });
  });

  it("counts a last line without a line break", async () => {
    assert.deepEqual(await ranges("tail.ts"), { old: [], new: [{ start: 3, end: 3 }] });
    const blob = fixture.git(["hash-object", "-w", "--stdin"], { input: "x\ny" });
    assert.deepEqual(await changedRanges(null, blob, options), {
      old: [],
      new: [{ start: 1, end: 2 }],
    });
  });

  it("returns no range for an empty added file and for two missing blobs", async () => {
    const empty = fixture.git(["hash-object", "-w", "--stdin"], { input: "" });
    assert.deepEqual(await changedRanges("0".repeat(40), empty, options), { old: [], new: [] });
    assert.deepEqual(await changedRanges(null, null, options), { old: [], new: [] });
  });

  it("is not affected by diff.noprefix, diff.external, color.ui or -diff attributes", async () => {
    assert.deepEqual(await ranges("data.bin"), {
      old: [{ start: 2, end: 2 }],
      new: [{ start: 2, end: 2 }],
    });
    assert.deepEqual(await ranges("mod.ts"), {
      old: [{ start: 2, end: 2 }],
      new: [
        { start: 2, end: 2 },
        { start: 6, end: 6 },
      ],
    });
  });

  it("reads a hunk header that carries trailing text", async () => {
    const oldBlob = fixture.git(["hash-object", "-w", "--stdin"], {
      input: lines("function f() {", "  return 1;", "}", "", "x"),
    });
    const newBlob = fixture.git(["hash-object", "-w", "--stdin"], {
      input: lines("function f() {", "  return 2;", "}", "", "x"),
    });
    assert.deepEqual(await changedRanges(oldBlob, newBlob, options), {
      old: [{ start: 2, end: 2 }],
      new: [{ start: 2, end: 2 }],
    });
  });

  it("rejects an invalid object id", async () => {
    await assert.rejects(changedRanges("--output=x", "abc", options), /invalid object id/);
  });
});

describe("changedRanges in a checkout", () => {
  it("ignores a .gitattributes file that marks the path -diff", async () => {
    const fixture = createFixture();
    const dir = mkdtempSync(join(tmpdir(), "pr-conflict-radar-ranges-"));
    try {
      const first = fixture.commit({
        branch: "main",
        files: { ".gitattributes": "*.ts -diff\n", "a.ts": lines("a", "b", "c") },
      });
      const second = fixture.commit({
        branch: "next",
        files: { "a.ts": lines("a", "x", "c") },
      });
      const clone = join(dir, "clone");
      fixture.git(["clone", "--quiet", fixture.url, clone], { cwd: dir });
      const files = await changedFiles(first, second, { cwd: clone });
      const [file] = files;
      assert.deepEqual(await changedRanges(file.oldBlob, file.newBlob, { cwd: clone }), {
        old: [{ start: 2, end: 2 }],
        new: [{ start: 2, end: 2 }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
