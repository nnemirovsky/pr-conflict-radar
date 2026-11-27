import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../lib/config.mjs";
import { GitError } from "../lib/git.mjs";
import { stateOf } from "../lib/order.mjs";
import { NOT_SIMULATED, notSimulated, pairId, simulate } from "../lib/simulate.mjs";
import { createFixture } from "./fixture-repo.mjs";

const UNKNOWN_SHA = "0123456789abcdef0123456789abcdef01234567";

// Twelve numbered lines; `edits` maps a line number to its new text.
function lines(edits = {}) {
  return `${Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;
}

function pr(number, head, extra = {}) {
  return {
    number,
    baseRefName: "main",
    headRefOid: head,
    author: "dev-a",
    labels: [],
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    ...extra,
  };
}

// The pairs a run checked, as pair ids in predicted order.
const checkedIds = (result) => result.pairs.map((pair) => pairId(pair.first, pair.second));

function config({ maxPrs = 40 } = {}) {
  const value = defaultConfig();
  value.maxPrs = maxPrs;
  return value;
}

describe("simulate", () => {
  const fixture = createFixture();
  const cwd = fixture.remote;
  after(() => fixture.cleanup());
  const base = fixture.commit({
    branch: "main",
    files: { "src/cart.ts": lines(), "README.md": lines(), "notes.txt": lines() },
  });
  const edit = (files) => fixture.commit({ parent: base, files });
  const run = (prs, cfg = config(), at = base) =>
    simulate({ ref: "main", sha: at }, prs, cfg, { cwd });

  it("reports a clean pair as checked and merges both into the train", async () => {
    const one = edit({ "src/cart.ts": lines({ 2: "one" }) });
    const two = edit({ "src/cart.ts": lines({ 8: "two" }) });
    const prs = [pr(12, one), pr(15, two)];
    const result = await run(prs);
    assert.deepEqual(result.base, { ref: "main", sha: base });
    assert.equal(result.state, stateOf(base, prs, config(), "main"));
    assert.deepEqual(result.order, [12, 15]);
    assert.deepEqual(Object.keys(result.pulls), ["12", "15"]);
    assert.deepEqual(result.baseConflicts, []);
    assert.deepEqual(result.pairs, [
      { first: 12, second: 15, clean: true, files: [], class: null },
    ]);
    assert.deepEqual(checkedIds(result), ["12+15"]);
    assert.deepEqual(result.train, { merged: [12, 15], breaks: [] });
    assert.deepEqual(result.notSimulated, []);
    assert.deepEqual(result.notes, []);
    assert.equal(Object.hasOwn(result, "checked"), false);
  });

  it("does not simulate a head that shares no history with the base and simulates the rest", async () => {
    const one = edit({ "src/cart.ts": lines({ 5: "one" }) });
    const two = edit({ "src/cart.ts": lines({ 5: "two" }) });
    const orphan = fixture.commit({ parent: null, files: { "src/cart.ts": lines({ 5: "x" }) } });
    const prs = [pr(12, one), pr(14, orphan), pr(15, two)];
    const result = await run(prs);
    assert.equal(result.state, stateOf(base, prs, config(), "main"));
    assert.deepEqual(result.order, [12, 15]);
    assert.deepEqual(Object.keys(result.pulls), ["12", "14", "15"]);
    assert.deepEqual(result.baseConflicts, []);
    assert.deepEqual(checkedIds(result), ["12+15"]);
    assert.equal(result.pairs[0].clean, false);
    assert.deepEqual(result.train.merged, [12]);
    assert.deepEqual(result.notSimulated, [
      {
        pr: 14,
        reason: NOT_SIMULATED.unrelated,
        note: "Not simulated: this pull request shares no history with the default branch.",
      },
    ]);
  });

  it("names who merges first and who rebases in a conflicting pair", async () => {
    const one = edit({ "src/cart.ts": lines({ 5: "one" }), "README.md": lines({ 5: "one" }) });
    const two = edit({ "src/cart.ts": lines({ 5: "two" }), "README.md": lines({ 5: "two" }) });
    // #15 is approved, so it is predicted to merge first and #12 rebases.
    const result = await run([pr(12, one), pr(15, two, { reviewDecision: "APPROVED" })]);
    assert.deepEqual(result.order, [15, 12]);
    assert.deepEqual(result.pairs, [
      {
        first: 15,
        second: 12,
        clean: false,
        files: [
          { path: "README.md", class: "docs" },
          { path: "src/cart.ts", class: "code" },
        ],
        class: "code",
      },
    ]);
    assert.deepEqual(checkedIds(result), ["12+15"]);
  });

  it("classifies a docs-only conflict as docs", async () => {
    const one = edit({ "README.md": lines({ 3: "one" }) });
    const two = edit({ "README.md": lines({ 3: "two" }) });
    const [pair] = (await run([pr(12, one), pr(15, two)])).pairs;
    assert.equal(pair.class, "docs");
  });

  it("leaves a pull request that conflicts with the base out of the pairs and the checked set", async () => {
    const forked = edit({ "notes.txt": lines({ 6: "forked" }) });
    const moved = fixture.commit({ parent: base, files: { "notes.txt": lines({ 6: "moved" }) } });
    const one = fixture.commit({ parent: moved, files: { "src/cart.ts": lines({ 1: "one" }) } });
    const two = fixture.commit({ parent: moved, files: { "src/cart.ts": lines({ 10: "two" }) } });
    const result = await run([pr(12, forked), pr(15, one), pr(18, two)], config(), moved);
    assert.deepEqual(result.order, [12, 15, 18]);
    assert.deepEqual(result.baseConflicts, [
      { pr: 12, files: [{ path: "notes.txt", class: "code" }], class: "code" },
    ]);
    assert.deepEqual(
      result.pairs.map((p) => [p.first, p.second]),
      [[15, 18]],
    );
    assert.deepEqual(checkedIds(result), ["15+18"]);
    assert.deepEqual(result.train, { merged: [15, 18], breaks: [] });
  });

  it("reports a three-way train break where every pair is clean as multi-way", async () => {
    // #12 renames f.txt with edits that keep it similar enough to be a rename;
    // with #15's edits on top the two together no longer read as a rename, so
    // #18's edit of f.txt meets a deleted file only in the train.
    const gen = (changed, by) =>
      `${Array.from({ length: 12 }, (_, i) => (changed.includes(i + 1) ? `changed line ${i + 1} by ${by}` : `line ${i + 1}`)).join("\n")}\n`;
    const start = fixture.commit({ parent: base, files: { "f.txt": gen([], "") } });
    const renamed = fixture.commit({
      parent: start,
      files: { "f.txt": null, "g.txt": gen([1, 3, 5], "a") },
    });
    const edited = fixture.commit({ parent: start, files: { "f.txt": gen([7, 9], "b") } });
    const third = fixture.commit({ parent: start, files: { "f.txt": gen([11], "c") } });
    const result = await run([pr(12, renamed), pr(15, edited), pr(18, third)], config(), start);
    assert.deepEqual(result.baseConflicts, []);
    assert.ok(result.pairs.every((p) => p.clean));
    assert.deepEqual(checkedIds(result), ["12+15", "12+18", "15+18"]);
    assert.deepEqual(result.train, {
      merged: [12, 15],
      breaks: [
        {
          pr: 18,
          train: [12, 15],
          files: [{ path: "f.txt", class: "code" }],
          class: "code",
          multiWay: true,
        },
      ],
    });
  });

  it("reports a train break explained by a pair as not multi-way and keeps evaluating", async () => {
    const one = edit({ "src/cart.ts": lines({ 4: "one" }) });
    const two = edit({ "src/cart.ts": lines({ 4: "two" }) });
    const three = edit({ "src/cart.ts": lines({ 11: "three" }) });
    const result = await run([pr(12, one), pr(15, two), pr(18, three)]);
    assert.deepEqual(
      result.pairs.filter((p) => !p.clean).map((p) => pairId(p.first, p.second)),
      ["12+15"],
    );
    assert.deepEqual(result.train, {
      merged: [12, 18],
      breaks: [
        {
          pr: 15,
          train: [12],
          files: [{ path: "src/cart.ts", class: "code" }],
          class: "code",
          multiWay: false,
        },
      ],
    });
  });

  it("simulates the first maxPrs in predicted order and says so", async () => {
    const heads = [1, 2, 3].map((i) => edit({ [`file-${i}.txt`]: `${i}\n` }));
    const prs = [pr(12, heads[0]), pr(15, heads[1], { isDraft: true }), pr(18, heads[2])];
    const result = await run(prs, config({ maxPrs: 2 }));
    assert.deepEqual(result.order, [12, 18]);
    assert.deepEqual(checkedIds(result), ["12+18"]);
    assert.deepEqual(result.train.merged, [12, 18]);
    assert.deepEqual(result.notes, [
      "Simulated the first 2 of 3 open pull requests that target the default branch, in the " +
        "predicted merge order; the rest were not simulated.",
    ]);
    assert.deepEqual(
      result.notSimulated.map(({ pr, reason }) => ({ pr, reason })),
      [{ pr: 15, reason: NOT_SIMULATED.maxPrs }],
    );
    assert.equal(result.pulls[15], prs[1]);
    // The state covers every open pull request, the one left out included.
    assert.equal(result.state, stateOf(base, prs, config(), "main"));
  });

  it("verifies every input commit before any merge", async () => {
    const one = edit({ "src/cart.ts": lines({ 2: "one" }) });
    await assert.rejects(run([pr(12, one), pr(15, UNKNOWN_SHA)]), (error) => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, /not a commit/);
      return true;
    });
    await assert.rejects(
      simulate({ ref: "main", sha: UNKNOWN_SHA }, [pr(12, one)], config(), { cwd }),
      GitError,
    );
  });

  it("does not merge a pull request that targets another branch", async () => {
    const one = edit({ "src/cart.ts": lines({ 2: "one" }) });
    const elsewhere = pr(20, UNKNOWN_SHA, {
      baseRefName: "release",
      recorded: { simulated: true },
    });
    const result = await run([pr(12, one), elsewhere]);
    assert.deepEqual(result.order, [12]);
    assert.deepEqual(
      result.notSimulated.map((entry) => entry.reason),
      [NOT_SIMULATED.otherBase],
    );
    assert.equal(result.pulls[20], elsewhere);
  });

  it("works on a default branch that is not main and with a single merge in flight", async () => {
    const trunk = createFixture({ defaultBranch: "trunk" });
    try {
      const root = trunk.commit({ branch: "trunk", files: { "a.txt": lines() } });
      const one = trunk.commit({ parent: root, files: { "a.txt": lines({ 1: "one" }) } });
      const two = trunk.commit({ parent: root, files: { "a.txt": lines({ 1: "two" }) } });
      const prs = [pr(12, one, { baseRefName: "trunk" }), pr(15, two, { baseRefName: "trunk" })];
      const result = await simulate({ ref: "trunk", sha: root }, prs, config(), {
        cwd: trunk.remote,
        concurrency: 1,
      });
      assert.deepEqual(result.order, [12, 15]);
      assert.equal(result.pairs[0].clean, false);
      assert.equal(result.train.breaks[0].pr, 15);
    } finally {
      trunk.cleanup();
    }
  });
});

describe("notSimulated", () => {
  const head = (n) => n.toString(16).padStart(40, "0");

  it("lists a pull request left out by maxPrs with its reason", () => {
    const prs = [pr(12, head(1)), pr(15, head(2)), pr(18, head(3), { isDraft: true })];
    const entries = notSimulated(prs, config({ maxPrs: 2 }), "main");
    assert.deepEqual(entries, [
      {
        pr: 18,
        reason: NOT_SIMULATED.maxPrs,
        note:
          "Not simulated: more than 2 open pull requests target the default branch, " +
          "and this one is not among the first 2 in the predicted merge order.",
      },
    ]);
  });

  it("lists a retargeted pull request that still carries a simulated result", () => {
    const prs = [
      pr(12, head(1)),
      pr(15, head(2), { baseRefName: "release", recorded: { simulated: true } }),
    ];
    assert.deepEqual(notSimulated(prs, config(), "main"), [
      {
        pr: 15,
        reason: NOT_SIMULATED.otherBase,
        note: "Not simulated: this pull request does not target the default branch.",
      },
    ]);
  });

  it("ignores a retargeted pull request with no published result or a not-simulated one", () => {
    const prs = [
      pr(12, head(1)),
      pr(15, head(2), { baseRefName: "release" }),
      pr(18, head(3), { baseRefName: "release", recorded: null }),
      pr(20, head(4), { baseRefName: "release", recorded: { simulated: false } }),
    ];
    assert.deepEqual(notSimulated(prs, config(), "main"), []);
  });

  it("lists both reasons together in number order", () => {
    const prs = [
      pr(30, head(1), { baseRefName: "release", recorded: { simulated: true } }),
      pr(12, head(2)),
      pr(15, head(3)),
    ];
    const entries = notSimulated(prs, config({ maxPrs: 1 }), "main");
    assert.deepEqual(
      entries.map(({ pr, reason }) => [pr, reason]),
      [
        [15, NOT_SIMULATED.maxPrs],
        [30, NOT_SIMULATED.otherBase],
      ],
    );
  });
});
