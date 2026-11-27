import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertGitVersion,
  changedFiles,
  commitMerge,
  deleteRefs,
  fetchCommits,
  GitError,
  MERGE_IDENTITY,
  mergeBase,
  mergeTree,
  parseGitVersion,
  parseMergeTree,
  parseRawDiff,
  verifyCommit,
} from "../lib/git.mjs";
import { createFixture } from "./fixture-repo.mjs";

const UNKNOWN_SHA = "0123456789abcdef0123456789abcdef01234567";

// Ten numbered lines, so an edit of one line keeps a renamed file similar.
function lines(edits = {}) {
  return `${Array.from({ length: 10 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;
}

const isGitError = (error) => error instanceof GitError;

describe("git version", () => {
  it("parses the version forms git prints", () => {
    assert.deepEqual(parseGitVersion("git version 2.43.0"), [2, 43, 0]);
    assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-145)"), [2, 39, 3]);
    assert.deepEqual(parseGitVersion("git version 2.45.1.windows.1"), [2, 45, 1]);
    assert.deepEqual(parseGitVersion("git version 3.0"), [3, 0, 0]);
    assert.equal(parseGitVersion("not git"), null);
  });

  it("accepts the installed git", async () => {
    assert.match(await assertGitVersion(), /^\d+\.\d+\.\d+$/);
  });

  describe("with a fake git on the PATH", () => {
    const fixture = createFixture();
    after(() => fixture.cleanup());

    function fakeGit(version) {
      const bin = join(fixture.dir, `bin-${version}`);
      mkdirSync(bin);
      const path = join(bin, "git");
      writeFileSync(path, `#!/bin/sh\necho "git version ${version}"\n`);
      chmodSync(path, 0o755);
      return { PATH: bin };
    }

    it("refuses git older than 2.38 with a message naming both versions", async () => {
      await assert.rejects(assertGitVersion({ env: fakeGit("2.37.1") }), (error) => {
        assert.ok(isGitError(error));
        assert.match(error.message, /needs git 2\.38 or newer; found git 2\.37\.1/);
        return true;
      });
    });

    it("accepts 2.38.0 and a newer major", async () => {
      assert.equal(await assertGitVersion({ env: fakeGit("2.38.0") }), "2.38.0");
      assert.equal(await assertGitVersion({ env: fakeGit("3.1.0") }), "3.1.0");
    });
  });
});

describe("verifyCommit", () => {
  const fixture = createFixture();
  const cwd = fixture.remote;
  let base;
  before(() => {
    base = fixture.commit({ branch: "main", files: { "a.txt": "a\n" } });
  });
  after(() => fixture.cleanup());

  it("resolves a branch and a SHA to the full commit SHA", async () => {
    assert.equal(await verifyCommit("main", { cwd }), base);
    assert.equal(await verifyCommit(base, { cwd }), base);
    assert.equal(await verifyCommit(base.slice(0, 12), { cwd }), base);
  });

  it("rejects a missing ref, an unknown SHA and a tree before any merge", async () => {
    const tree = fixture.git(["rev-parse", `${base}^{tree}`]);
    for (const rev of ["refs/heads/missing", UNKNOWN_SHA, tree]) {
      await assert.rejects(verifyCommit(rev, { cwd }), isGitError, rev);
    }
  });

  it("rejects a revision that would read as an option", async () => {
    await assert.rejects(verifyCommit("--all", { cwd }), /invalid revision argument/);
    await assert.rejects(verifyCommit("", { cwd }), /invalid revision argument/);
  });
});

describe("mergeTree", () => {
  const fixture = createFixture();
  const cwd = fixture.remote;
  let base;
  before(() => {
    base = fixture.commit({
      branch: "main",
      files: { "src/cart.txt": lines(), "docs/my file.md": "intro\n", "notes.txt": lines() },
    });
  });
  after(() => fixture.cleanup());

  it("merges two pull requests that touch different lines cleanly", async () => {
    const one = fixture.commit({ parent: base, files: { "src/cart.txt": lines({ 2: "one" }) } });
    const two = fixture.commit({ parent: base, files: { "src/cart.txt": lines({ 8: "two" }) } });
    const result = await mergeTree(one, two, { cwd });
    assert.equal(result.clean, true);
    assert.deepEqual(result.conflictedPaths, []);
    const merged = fixture.git(["cat-file", "blob", `${result.tree}:src/cart.txt`]);
    assert.equal(`${merged}\n`, lines({ 2: "one", 8: "two" }));
  });

  it("reports a textual conflict with the conflicted paths, a path with spaces among them", async () => {
    const one = fixture.commit({
      parent: base,
      files: { "src/cart.txt": lines({ 5: "one" }), "docs/my file.md": "one\n" },
    });
    const two = fixture.commit({
      parent: base,
      files: { "src/cart.txt": lines({ 5: "two" }), "docs/my file.md": "two\n" },
    });
    const result = await mergeTree(one, two, { cwd });
    assert.equal(result.clean, false);
    assert.match(result.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual([...result.conflictedPaths].sort(), ["docs/my file.md", "src/cart.txt"]);
  });

  it("follows a rename plus edit on one side and an edit on the other", async () => {
    const renamed = fixture.commit({
      parent: base,
      files: { "notes.txt": null, "docs/notes.txt": lines({ 1: "renamed" }) },
    });
    const edited = fixture.commit({ parent: base, files: { "notes.txt": lines({ 9: "edited" }) } });
    const result = await mergeTree(renamed, edited, { cwd });
    assert.equal(result.clean, true);
    const merged = fixture.git(["cat-file", "blob", `${result.tree}:docs/notes.txt`]);
    assert.equal(`${merged}\n`, lines({ 1: "renamed", 9: "edited" }));
    await assert.rejects(verifyCommit(`${result.tree}:notes.txt`, { cwd }));
  });

  it("throws for a missing ref and an unknown SHA instead of reporting a conflict", async () => {
    await assert.rejects(mergeTree(base, "refs/heads/missing", { cwd }), isGitError);
    await assert.rejects(mergeTree(UNKNOWN_SHA, base, { cwd }), isGitError);
  });

  it("throws for unrelated histories", async () => {
    const orphan = fixture.commit({ parent: null, files: { "other.txt": "x\n" } });
    await assert.rejects(mergeTree(base, orphan, { cwd }), (error) => {
      assert.ok(isGitError(error));
      assert.equal(error.code, 128);
      return true;
    });
  });

  it("throws for a revision that would read as an option", async () => {
    await assert.rejects(mergeTree("--stdin", base, { cwd }), /invalid revision argument/);
  });
});

describe("parseMergeTree", () => {
  const tree = "4a26681ff715c0ff1f461075a169cd37c08a1b2c";

  it("reads a clean merge and a conflict", () => {
    assert.deepEqual(parseMergeTree(0, Buffer.from(`${tree}\0`)), {
      clean: true,
      tree,
      conflictedPaths: [],
    });
    assert.deepEqual(parseMergeTree(1, Buffer.from(`${tree}\0a b.txt\0c\nd\0`)), {
      clean: false,
      tree,
      conflictedPaths: ["a b.txt", "c\nd"],
    });
  });

  it("rejects an exit 1 that carries no tree OID", () => {
    assert.throws(() => parseMergeTree(1, Buffer.alloc(0)), isGitError);
    assert.throws(() => parseMergeTree(1, Buffer.from("fatal\0a.txt\0")), isGitError);
  });

  it("rejects every exit code other than 0 and 1", () => {
    assert.throws(() => parseMergeTree(128, Buffer.from(`${tree}\0`)), isGitError);
    assert.throws(() => parseMergeTree(null, Buffer.from(`${tree}\0`)), isGitError);
  });
});

describe("commitMerge", () => {
  const fixture = createFixture({ defaultBranch: "trunk" });
  const cwd = fixture.remote;
  let base;
  let one;
  let two;
  let three;
  before(() => {
    base = fixture.commit({ branch: "trunk", files: { "a.txt": lines(), "b.txt": lines() } });
    one = fixture.commit({ parent: base, files: { "a.txt": lines({ 3: "one" }) } });
    two = fixture.commit({ parent: base, files: { "a.txt": lines({ 3: "two" }) } });
    three = fixture.commit({ parent: base, files: { "b.txt": lines({ 3: "three" }) } });
  });
  after(() => fixture.cleanup());

  it("writes a merge commit that can be merged again", async () => {
    const merged = await mergeTree(base, one, { cwd });
    assert.equal(merged.clean, true);
    const commit = await commitMerge(merged.tree, base, one, { cwd });
    assert.equal(await verifyCommit(commit, { cwd }), commit);
    assert.equal(fixture.git(["rev-parse", `${commit}^{tree}`]), merged.tree);
    assert.equal(
      fixture.git(["rev-list", "--parents", "-n", "1", commit]),
      `${commit} ${base} ${one}`,
    );

    const conflict = await mergeTree(commit, two, { cwd });
    assert.equal(conflict.clean, false);
    assert.deepEqual(conflict.conflictedPaths, ["a.txt"]);
    const clean = await mergeTree(commit, three, { cwd });
    assert.equal(clean.clean, true);
    assert.equal(await mergeBase(commit, three, { cwd }), base);
  });

  it("uses the fixed identity, writes no signature and is deterministic", async () => {
    const merged = await mergeTree(base, three, { cwd });
    const first = await commitMerge(merged.tree, base, three, { cwd });
    const second = await commitMerge(merged.tree, base, three, { cwd });
    assert.equal(first, second);
    const raw = fixture.git(["cat-file", "commit", first]);
    assert.ok(raw.includes(`author ${MERGE_IDENTITY.GIT_AUTHOR_NAME} <`), raw);
    assert.ok(raw.includes(`committer ${MERGE_IDENTITY.GIT_COMMITTER_NAME} <`), raw);
    assert.ok(!raw.includes("gpgsig"), raw);
  });

  it("works on a default branch that is not main", async () => {
    assert.equal(await verifyCommit("trunk", { cwd }), base);
    await assert.rejects(verifyCommit("main", { cwd }), isGitError);
  });

  it("rejects a tree argument that is not an object id", async () => {
    await assert.rejects(commitMerge("trunk", base, one, { cwd }), /invalid object id/);
  });
});

describe("mergeBase", () => {
  const fixture = createFixture();
  const cwd = fixture.remote;
  after(() => fixture.cleanup());

  it("returns the fork point and throws for unrelated histories", async () => {
    const root = fixture.commit({ branch: "main", files: { "a.txt": "a\n" } });
    const left = fixture.commit({ parent: root, files: { "b.txt": "b\n" } });
    const right = fixture.commit({ parent: root, files: { "c.txt": "c\n" } });
    assert.equal(await mergeBase(left, right, { cwd }), root);
    const orphan = fixture.commit({ parent: null, files: { "d.txt": "d\n" } });
    await assert.rejects(mergeBase(left, orphan, { cwd }), isGitError);
  });
});

describe("fetchCommits and deleteRefs", () => {
  const fixture = createFixture({ defaultBranch: "trunk" });
  let root;
  let pull12;
  let pull15;
  let newBase;
  before(() => {
    root = fixture.commit({ branch: "trunk", files: { "a.txt": lines() } });
    // Pull request 12 forks from the root, two commits below the tip a
    // shallow clone sees.
    pull12 = fixture.commit({ parent: root, files: { "a.txt": lines({ 1: "twelve" }) } });
    fixture.commit({ branch: "trunk", files: { "b.txt": "b\n" } });
    fixture.commit({ branch: "trunk", files: { "c.txt": "c\n" } });
    pull15 = fixture.commit({ parent: "trunk", files: { "a.txt": lines({ 9: "fifteen" }) } });
    fixture.publishPull(12, pull12);
    fixture.publishPull(15, pull15);
  });
  after(() => fixture.cleanup());

  // Clones a remote without tags, then moves its default branch and adds a
  // tag on the new tip and on a pull request head, so a fetch that followed
  // the remote's refs would show up in the clone's refs.
  function cloneThenAdvance(shallow) {
    for (const line of fixture.refs()) {
      const [ref] = line.split(" ");
      if (ref.startsWith("refs/tags/")) fixture.git(["update-ref", "-d", ref]);
    }
    const cwd = fixture.clone({ shallow });
    newBase = fixture.commit({ branch: "trunk", files: { "d.txt": "d\n" } });
    fixture.tag("v1.0.0", newBase);
    fixture.tag("pull-tag", pull12);
    return cwd;
  }

  for (const shallow of [true, false]) {
    const kind = shallow ? "shallow" : "complete";

    it(`fetches heads only refs/pull/<n>/head reaches into the private namespace in a ${kind} clone`, async () => {
      const cwd = cloneThenAdvance(shallow);
      const isShallow = () => fixture.git(["rev-parse", "--is-shallow-repository"], { cwd });
      assert.equal(isShallow(), String(shallow));
      await assert.rejects(verifyCommit(pull12, { cwd }), isGitError);
      const before = fixture.refs(cwd);

      const refs = await fetchCommits(
        "origin",
        newBase,
        [
          { pr: 12, sha: pull12 },
          { pr: 15, sha: pull15 },
        ],
        { cwd },
      );
      assert.deepEqual(refs, {
        base: "refs/pr-conflict-radar/base",
        heads: { 12: "refs/pr-conflict-radar/12", 15: "refs/pr-conflict-radar/15" },
      });

      const added = fixture.refs(cwd).filter((line) => !before.includes(line));
      assert.deepEqual(added.sort(), [
        `refs/pr-conflict-radar/12 ${pull12}`,
        `refs/pr-conflict-radar/15 ${pull15}`,
        `refs/pr-conflict-radar/base ${newBase}`,
      ]);
      const after = fixture.refs(cwd);
      for (const line of before) assert.ok(after.includes(line), `${line} is unchanged`);
      assert.ok(!after.some((line) => line.startsWith("refs/tags/")), "no tag is created");
      assert.ok(!existsSync(join(cwd, ".git", "FETCH_HEAD")), "no FETCH_HEAD is written");
      assert.equal(isShallow(), "false");

      assert.equal(await verifyCommit(pull12, { cwd }), pull12);
      assert.equal(await mergeBase(newBase, pull12, { cwd }), root);

      assert.equal(await deleteRefs({ cwd }), 3);
      assert.deepEqual(fixture.refs(cwd), before);
      assert.equal(await deleteRefs({ cwd }), 0);
    });
  }

  it("throws naming the pull request whose head the remote does not have, and writes no ref", async () => {
    const cwd = fixture.clone({ shallow: true });
    const before = fixture.refs(cwd);
    const base = fixture.resolve("trunk");
    await assert.rejects(
      fetchCommits(
        "origin",
        base,
        [
          { pr: 12, sha: pull12 },
          { pr: 15, sha: UNKNOWN_SHA },
        ],
        { cwd },
      ),
      (error) => {
        assert.ok(isGitError(error));
        assert.match(error.message, /pull request #15$/);
        assert.deepEqual(error.missing, [15]);
        return true;
      },
    );
    assert.deepEqual(fixture.refs(cwd), before);
  });

  it("throws naming the base when the remote does not have it", async () => {
    const cwd = fixture.clone();
    await assert.rejects(
      fetchCommits("origin", UNKNOWN_SHA, [{ pr: 12, sha: pull12 }], { cwd }),
      /does not serve the base commit/,
    );
  });

  it("rejects a SHA, a number or a remote that is not plain data", async () => {
    const cwd = fixture.clone();
    const base = fixture.resolve("trunk");
    await assert.rejects(fetchCommits("origin", "trunk", [], { cwd }), /invalid object id/);
    await assert.rejects(
      fetchCommits("origin", base, [{ pr: 12, sha: `${pull12}:refs/heads/x` }], { cwd }),
      /invalid object id/,
    );
    await assert.rejects(
      fetchCommits("origin", base, [{ pr: "12", sha: pull12 }], { cwd }),
      /invalid pull request number/,
    );
    await assert.rejects(
      fetchCommits("--upload-pack=touch pwned", base, [], { cwd }),
      /invalid revision argument/,
    );
    assert.ok(!readdirSync(cwd).includes("pwned"));
  });
});

describe("changedFiles", () => {
  const fixture = createFixture({ defaultBranch: "develop" });
  const cwd = fixture.remote;
  const odd = [
    "with space.txt",
    "ünïcødé/файл 名前.txt",
    'quote".txt',
    "back\\slash.txt",
    "tab\there.txt",
    "line\nbreak.txt",
  ];
  const shellPath = "$(touch pwned);`touch pwned`|&>pwned 'x'.txt";
  const shellBranch = "feat/$(touch$IFS'pwned');`touch$IFS'pwned'`&&<x>|\"z\"!";
  let base;
  before(() => {
    base = fixture.commit({
      branch: "develop",
      files: {
        "keep.txt": "keep\n",
        "edit.txt": "before\n",
        "gone.txt": "gone\n",
        "old/name.txt": lines(),
        ...Object.fromEntries(odd.map((path) => [path, `${path} before\n`])),
      },
    });
  });
  after(() => fixture.cleanup());

  const blobOf = (rev, path) => fixture.git(["rev-parse", `${rev}:${path}`]);

  it("lists an addition, a deletion, a modification and a rename with edit", async () => {
    const head = fixture.commit({
      parent: base,
      files: {
        "new.txt": "new\n",
        "gone.txt": null,
        "edit.txt": "after\n",
        "old/name.txt": null,
        "new/name.txt": lines({ 4: "edited" }),
      },
    });
    const files = await changedFiles(base, head, { cwd });
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
    assert.deepEqual(Object.keys(byPath).sort(), [
      "edit.txt",
      "gone.txt",
      "new.txt",
      "new/name.txt",
    ]);

    const zero = "0".repeat(40);
    assert.deepEqual(byPath["new.txt"], {
      status: "A",
      score: null,
      path: "new.txt",
      previousPath: null,
      oldMode: "000000",
      newMode: "100644",
      oldBlob: zero,
      newBlob: blobOf(head, "new.txt"),
    });
    assert.equal(byPath["gone.txt"].status, "D");
    assert.equal(byPath["gone.txt"].oldBlob, blobOf(base, "gone.txt"));
    assert.equal(byPath["gone.txt"].newBlob, zero);
    assert.equal(byPath["edit.txt"].status, "M");
    assert.equal(byPath["edit.txt"].oldBlob, blobOf(base, "edit.txt"));
    assert.equal(byPath["edit.txt"].newBlob, blobOf(head, "edit.txt"));
    const renamed = byPath["new/name.txt"];
    assert.equal(renamed.status, "R");
    assert.ok(renamed.score >= 50 && renamed.score < 100, String(renamed.score));
    assert.equal(renamed.previousPath, "old/name.txt");
    assert.equal(renamed.oldBlob, blobOf(base, "old/name.txt"));
    assert.equal(renamed.newBlob, blobOf(head, "new/name.txt"));
  });

  it("returns paths with a space, non-ASCII, a quote, a backslash, a tab and a line break byte for byte", async () => {
    const added = odd.map((path) => `added/${path}`);
    const head = fixture.commit({
      parent: base,
      files: {
        ...Object.fromEntries(odd.map((path) => [path, `${path} after\n`])),
        ...Object.fromEntries(added.map((path) => [path, `${path}\n`])),
      },
    });
    const files = await changedFiles(base, head, { cwd });
    assert.deepEqual(files.map((file) => file.path).sort(), [...odd, ...added].sort());
    for (const file of files) {
      assert.equal(file.newBlob, blobOf(head, file.path));
      assert.equal(file.status, file.path.startsWith("added/") ? "A" : "M");
    }
  });

  it("handles a branch name and a path made of shell metacharacters as plain data", async () => {
    const head = fixture.commit({
      branch: shellBranch,
      parent: base,
      files: { [shellPath]: "x\n" },
    });
    const ref = `refs/heads/${shellBranch}`;
    assert.equal(await verifyCommit(ref, { cwd }), head);
    const files = await changedFiles("develop", ref, { cwd });
    assert.deepEqual(
      files.map((file) => [file.status, file.path]),
      [["A", shellPath]],
    );
    const merged = await mergeTree("develop", ref, { cwd });
    assert.equal(merged.clean, true);
    assert.equal(await mergeBase("develop", ref, { cwd }), base);
    for (const dir of [fixture.dir, cwd, process.cwd()]) {
      assert.ok(!readdirSync(dir).includes("pwned"), `nothing was created in ${dir}`);
    }
  });

  it("rejects malformed raw output", () => {
    assert.throws(() => parseRawDiff(Buffer.from("garbage\0path\0")), isGitError);
    assert.throws(
      () =>
        parseRawDiff(Buffer.from(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R090\0old\0`)),
      isGitError,
    );
  });
});
