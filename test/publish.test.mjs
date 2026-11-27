import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classOf, mostSevere, pairKey } from "../lib/classify.mjs";
import { defaultConfig } from "../lib/config.mjs";
import { selectPrs, stateOf } from "../lib/order.mjs";
import {
  boundNotified,
  isCheckWrite,
  NOTIFIED_EXTRA,
  planPublish,
  publish,
  WRITE,
} from "../lib/publish.mjs";
import { buildResults, extract, RESOLVED_LINE, renderComment } from "../lib/report.mjs";
import { notSimulated, pairId } from "../lib/simulate.mjs";

const REPO = "acme/widgets";
const BASE = "b".repeat(40);
const EMPTY = Object.freeze({ base: { ref: "main", sha: BASE }, pulls: [] });

const sha = (n, version = 0) =>
  `${n.toString(16).padStart(8, "0")}${version.toString(16).padStart(32, "0")}`;

function config(overrides = {}) {
  return { ...defaultConfig(), ...overrides };
}

const key = (a, b, cfg = config()) => pairKey(cfg, REPO, a, b);

function pull(number, extra = {}) {
  return {
    number,
    baseRefName: "main",
    headRefOid: sha(number),
    author: `dev-${number}`,
    labels: [],
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    ...extra,
  };
}

// The results of a run over `prs` (pull requests as the read state holds
// them). `conflicts` lists the conflicting pairs as `[a, b, paths?]`; the one
// earlier in `order` merges first. `baseConflicts` lists the pull requests that
// conflict with the base. `order` defaults to the predicted order.
function run({ prs, cfg, conflicts = [], baseConflicts = [], order, base = BASE }) {
  const simOrder = order ?? selectPrs(prs, cfg, "main").selected.map((pr) => pr.number);
  const paths = new Map(conflicts.map(([a, b, files = ["src/cart.ts"]]) => [pairId(a, b), files]));
  const mergeable = simOrder.filter((n) => !baseConflicts.includes(n));
  const pairs = [];
  for (const [i, first] of mergeable.entries()) {
    for (const second of mergeable.slice(i + 1)) {
      const files = (paths.get(pairId(first, second)) ?? []).map((path) => ({
        path,
        class: classOf(path, cfg),
      }));
      pairs.push({
        first,
        second,
        clean: files.length === 0,
        files,
        class:
          files.length === 0
            ? null
            : mostSevere(
                files.map((file) => file.class),
                cfg,
              ),
      });
    }
  }
  const skipped = notSimulated(prs, cfg, "main");
  const pulls = {};
  for (const pr of prs) {
    if (simOrder.includes(pr.number) || skipped.some((entry) => entry.pr === pr.number)) {
      pulls[pr.number] = pr;
    }
  }
  const simulation = {
    base: { ref: "main", sha: base },
    state: stateOf(base, prs, cfg, "main"),
    order: simOrder,
    pulls,
    baseConflicts: baseConflicts.map((pr) => ({
      pr,
      files: [{ path: "src/base.ts", class: "code" }],
      class: "code",
    })),
    pairs,
    train: { merged: mergeable, breaks: [] },
    notSimulated: skipped,
    notes: [],
  };
  return buildResults(simulation, cfg, REPO);
}

// The state read back after `prev` was published, with `prs` open now: a pull
// request keeps its comments, and its check while its head stays.
function reread(prev, prs, baseSha = BASE) {
  const old = new Map(prev.pulls.map((pr) => [pr.number, pr]));
  return {
    base: { ref: "main", sha: baseSha },
    pulls: prs.map((pr) => {
      const was = old.get(pr.number);
      const sameHead = was !== undefined && was.headRefOid === pr.headRefOid;
      return {
        ...pr,
        fork: false,
        recorded: sameHead ? structuredClone(was.recorded) : null,
        checkRunId: sameHead ? was.checkRunId : null,
        comments: was ? structuredClone(was.comments) : [],
      };
    }),
  };
}

let nextId = 1000;

// The state as it reads after `writes` were made.
function apply(state, writes) {
  const next = structuredClone(state);
  const pulls = new Map(next.pulls.map((pr) => [pr.number, pr]));
  for (const write of writes) {
    const pr = pulls.get(write.pr);
    switch (write.op) {
      case WRITE.createCheckRun:
        if (write.head === pr.headRefOid) {
          pr.recorded = extract(write.check.text);
          pr.checkRunId = nextId++;
        }
        break;
      case WRITE.updateCheckRun:
        assert.equal(write.id, pr.checkRunId);
        pr.recorded = extract(write.check.text);
        break;
      case WRITE.createComment:
        pr.comments.push({ id: nextId++, body: write.body });
        break;
      case WRITE.updateComment:
        pr.comments.find((comment) => comment.id === write.id).body = write.body;
        break;
      case WRITE.deleteComment:
        pr.comments = pr.comments.filter((comment) => comment.id !== write.id);
        break;
      default:
        assert.fail(`unknown write ${write.op}`);
    }
  }
  return next;
}

// One run: re-read the state with `prs` open, build the results, plan the
// writes and apply them.
function step(prev, prs, options = {}) {
  const cfg = options.cfg ?? config();
  const before = reread(prev, prs, options.base);
  const results = run({ ...options, prs: before.pulls, cfg });
  const writes = planPublish(results, before, cfg);
  return { before, results, writes, after: apply(before, writes), cfg };
}

const label = (write) => `${write.op}:${write.pr}`;
const checkLabels = (writes) => writes.filter(isCheckWrite).map(label);
const commentLabels = (writes) => writes.filter((write) => !isCheckWrite(write)).map(label);
const written = (writes, op, pr) => writes.find((write) => write.op === op && write.pr === pr);
const pullOf = (state, pr) => state.pulls.find((entry) => entry.number === pr);
const commentData = (state, pr) => extract(pullOf(state, pr).comments.at(-1).body);
const withOf = (data) => data.conflicts.map((row) => row.with);

describe("comment lifecycle", () => {
  it("creates a comment on both pull requests at the first conflict, notified holding its key", () => {
    const s = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    assert.deepEqual(s.writes.map(label), [
      "createCheckRun:12",
      "createCheckRun:15",
      "createComment:12",
      "createComment:15",
    ]);
    for (const pr of [12, 15]) {
      const data = extract(written(s.writes, WRITE.createComment, pr).body);
      assert.deepEqual(data.notified, [key(12, 15)]);
      assert.equal(data.conflicts.length, 1);
      assert.equal(written(s.writes, WRITE.createComment, pr).reason, "created");
    }
  });

  it("deletes and creates the comment for a new member, appending its key", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const oldId = pullOf(s1.after, 15).comments[0].id;
    const s2 = step(s1.after, [pull(12), pull(15), pull(20)], {
      conflicts: [
        [12, 15],
        [15, 20],
      ],
    });
    assert.deepEqual(commentLabels(s2.writes), [
      "createComment:15",
      "deleteComment:15",
      "createComment:20",
    ]);
    assert.equal(written(s2.writes, WRITE.createComment, 15).reason, "newMember");
    assert.equal(written(s2.writes, WRITE.deleteComment, 15).id, oldId);
    assert.deepEqual(commentData(s2.after, 15).notified, [key(12, 15), key(15, 20)]);
    assert.deepEqual(withOf(commentData(s2.after, 15)), [12, 20]);
    assert.equal(pullOf(s2.after, 15).comments.length, 1);
  });

  it("edits the comment in place when one pair is gone while another remains", () => {
    const prs = [pull(12), pull(15), pull(20)];
    const s1 = step(EMPTY, prs, {
      conflicts: [
        [12, 15],
        [15, 20],
      ],
    });
    const s2 = step(s1.after, prs, { conflicts: [[15, 20]] });
    assert.deepEqual(commentLabels(s2.writes), ["updateComment:12", "updateComment:15"]);
    assert.equal(written(s2.writes, WRITE.updateComment, 15).reason, "changed");
    assert.deepEqual(withOf(commentData(s2.after, 15)), [20]);
    assert.deepEqual(commentData(s2.after, 15).notified, [key(12, 15), key(15, 20)]);
  });

  it("edits both comments in place on a changed file list", () => {
    const prs = [pull(12), pull(15)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15]] });
    const s2 = step(s1.after, prs, { conflicts: [[12, 15, ["src/cart.ts", "src/total.ts"]]] });
    assert.deepEqual(commentLabels(s2.writes), ["updateComment:12", "updateComment:15"]);
    assert.deepEqual(
      commentData(s2.after, 12).conflicts[0].files.map((file) => file.path),
      ["src/cart.ts", "src/total.ts"],
    );
  });

  it("edits both comments in place on a flipped direction", () => {
    const prs = [pull(12), pull(15)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15]] });
    const s2 = step(s1.after, prs, { conflicts: [[12, 15]], order: [15, 12] });
    assert.deepEqual(commentLabels(s2.writes), ["updateComment:12", "updateComment:15"]);
    assert.equal(commentData(s2.after, 12).conflicts[0].mergesFirst, 15);
    assert.equal(commentData(s2.after, 12).conflicts[0].rebases, 12);
  });

  it("edits the comment to its resolved form when the last pair is gone, notified unchanged", () => {
    const prs = [pull(12), pull(15)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15]] });
    const s2 = step(s1.after, prs);
    assert.deepEqual(commentLabels(s2.writes), ["updateComment:12", "updateComment:15"]);
    for (const pr of [12, 15]) {
      const write = written(s2.writes, WRITE.updateComment, pr);
      assert.equal(write.reason, "resolved");
      assert.ok(write.body.startsWith(RESOLVED_LINE));
      assert.deepEqual(extract(write.body).conflicts, []);
      assert.deepEqual(extract(write.body).notified, [key(12, 15)]);
    }
  });

  it("keeps the row unchanged while its pair still conflicts in a class outside commentClasses", () => {
    const prs = [pull(12), pull(15)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15, ["README.md", "src/cart.ts"]]] });
    const before = { 12: pullOf(s1.after, 12).comments[0], 15: pullOf(s1.after, 15).comments[0] };
    assert.equal(commentData(s1.after, 12).conflicts[0].class, "code");

    // Only the docs conflict remains: the checks change, the comments do not.
    const s2 = step(s1.after, prs, { conflicts: [[12, 15, ["README.md"]]] });
    assert.equal(s2.results.find((result) => result.pr === 12).conflicts[0].class, "docs");
    assert.deepEqual(checkLabels(s2.writes), ["updateCheckRun:12", "updateCheckRun:15"]);
    assert.deepEqual(commentLabels(s2.writes), []);
    for (const pr of [12, 15]) assert.deepEqual(pullOf(s2.after, pr).comments, [before[pr]]);

    // Once the pair is clean the row leaves and the comment is resolved.
    const s3 = step(s2.after, prs);
    assert.deepEqual(commentLabels(s3.writes), ["updateComment:12", "updateComment:15"]);
    for (const pr of [12, 15]) {
      assert.equal(written(s3.writes, WRITE.updateComment, pr).reason, "resolved");
    }
  });

  it("deletes and creates the resolved comment for a conflict with a new partner", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const s2 = step(s1.after, [pull(12), pull(15)]);
    const s3 = step(s2.after, [pull(12), pull(15), pull(20)], { conflicts: [[15, 20]] });
    assert.deepEqual(commentLabels(s3.writes), [
      "createComment:15",
      "deleteComment:15",
      "createComment:20",
    ]);
    assert.deepEqual(commentData(s3.after, 15).notified, [key(12, 15), key(15, 20)]);
  });

  it("makes no write for an identical result", () => {
    const prs = [pull(12), pull(15), pull(20)];
    const options = {
      conflicts: [
        [12, 15],
        [15, 20],
      ],
    };
    const s1 = step(EMPTY, prs, options);
    const s2 = step(s1.after, prs, options);
    assert.deepEqual(s2.writes, []);
  });
});

describe("notification", () => {
  it("re-creates a comment for a flapping pair only the first time", () => {
    const prs = [pull(12), pull(15)];
    let state = EMPTY;
    const all = [];
    for (let round = 0; round < 3; round++) {
      const conflicting = step(state, prs, { conflicts: [[12, 15]] });
      const clean = step(conflicting.after, prs);
      all.push(...conflicting.writes, ...clean.writes);
      if (round > 0) {
        assert.deepEqual(commentLabels(conflicting.writes), [
          "updateComment:12",
          "updateComment:15",
        ]);
      }
      // The list survives the resolved form.
      assert.deepEqual(commentData(clean.after, 12).notified, [key(12, 15)]);
      state = clean.after;
    }
    assert.equal(all.filter((write) => write.op === WRITE.createComment).length, 2);
    assert.equal(all.filter((write) => write.op === WRITE.deleteComment).length, 0);
  });

  it("re-creates the comment for a new partner while an earlier key sits in the list", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const s2 = step(s1.after, [pull(12), pull(15)]);
    const s3 = step(s2.after, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    assert.deepEqual(commentLabels(s3.writes), ["updateComment:12", "updateComment:15"]);
    const s4 = step(s3.after, [pull(12), pull(15), pull(20)], {
      conflicts: [
        [12, 15],
        [15, 20],
      ],
    });
    assert.deepEqual(commentLabels(s4.writes), [
      "createComment:15",
      "deleteComment:15",
      "createComment:20",
    ]);
  });

  it("drops the oldest key on no current row beyond 100 and never a current row's key", () => {
    const cfg = config();
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const state = structuredClone(s1.after);
    const comment = pullOf(state, 15).comments[0];
    const old = Array.from({ length: 101 }, (_, i) => `conflict/widgets/${100 + i}+${300 + i}`);
    comment.body = renderComment(
      { ...extract(comment.body), notified: [key(12, 15), ...old] },
      cfg,
    );
    const s2 = step(state, [pull(12), pull(15), pull(20)], {
      conflicts: [
        [12, 15],
        [15, 20],
      ],
    });
    const created = extract(written(s2.writes, WRITE.createComment, 15).body);
    assert.deepEqual(created.notified, [key(12, 15), ...old.slice(1), key(15, 20)]);
  });

  it("bounds a notified list to the current keys and the newest 100 others", () => {
    const old = Array.from({ length: 150 }, (_, i) => `k${i}`);
    const current = ["k0", "k1", "k149"];
    const bounded = boundNotified(old, current);
    assert.equal(bounded.length, current.length + NOTIFIED_EXTRA);
    for (const kept of current) assert.ok(bounded.includes(kept));
    assert.deepEqual(bounded.slice(0, 2), ["k0", "k1"]);
    assert.equal(bounded[2], "k49");
    assert.deepEqual(boundNotified(["a", "b"], []), ["a", "b"]);
  });

  it("makes each listed pair a new member once after the pairKey template changes", () => {
    const prs = [pull(12), pull(15)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15]] });
    const cfg = config({ pairKey: "pair/{owner}/{low}-{high}" });
    const s2 = step(s1.after, prs, { conflicts: [[12, 15]], cfg });
    assert.deepEqual(commentLabels(s2.writes), [
      "createComment:12",
      "deleteComment:12",
      "createComment:15",
      "deleteComment:15",
    ]);
    assert.deepEqual(commentData(s2.after, 12).notified, [key(12, 15), "pair/acme/12-15"]);
    const s3 = step(s2.after, prs, { conflicts: [[12, 15]], cfg });
    assert.deepEqual(s3.writes, []);
  });
});

describe("suggestPeerbus", () => {
  it("edits every comment in place when toggled and never deletes or re-creates one", () => {
    const prs = [pull(12), pull(15), pull(20)];
    const conflicts = [
      [12, 15],
      [15, 20],
      [12, 20],
    ];
    const s1 = step(EMPTY, prs, { conflicts });
    const off = step(s1.after, prs, { conflicts, cfg: config({ suggestPeerbus: false }) });
    assert.deepEqual(off.writes.map(label), [
      "updateComment:12",
      "updateComment:15",
      "updateComment:20",
    ]);
    for (const write of off.writes) assert.doesNotMatch(write.body, /peerbus/i);
    const on = step(off.after, prs, { conflicts });
    assert.deepEqual(on.writes.map(label), [
      "updateComment:12",
      "updateComment:15",
      "updateComment:20",
    ]);
  });
});

describe("unchecked pairs", () => {
  it("keeps the row when the other pull request conflicts with the base", () => {
    const prs = [pull(12), pull(15)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15]] });
    const s2 = step(s1.after, prs, { baseConflicts: [12] });
    assert.deepEqual(checkLabels(s2.writes), ["updateCheckRun:12", "updateCheckRun:15"]);
    assert.deepEqual(commentLabels(s2.writes), []);
    assert.deepEqual(withOf(commentData(s2.after, 15)), [12]);
  });

  it("replaces the check and leaves the comment of a pull request left out by maxPrs", () => {
    const prs = [pull(12), pull(15), pull(20)];
    const s1 = step(EMPTY, prs, { conflicts: [[15, 20]] });
    const s2 = step(s1.after, prs, { conflicts: [[15, 20]], cfg: config({ maxPrs: 2 }) });
    const check = written(s2.writes, WRITE.updateCheckRun, 20);
    assert.equal(check.check.title, "Not simulated");
    assert.deepEqual(commentLabels(s2.writes), []);

    // Checked again, the pair still conflicts: no new member, no re-creation.
    const s3 = step(s2.after, prs, { conflicts: [[15, 20]] });
    assert.deepEqual(commentLabels(s3.writes), []);
    assert.deepEqual(checkLabels(s3.writes), [
      "updateCheckRun:12",
      "updateCheckRun:15",
      "updateCheckRun:20",
    ]);
  });

  it("drops the row when the other pull request is closed", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const s2 = step(s1.after, [pull(15)]);
    assert.deepEqual(commentLabels(s2.writes), ["updateComment:15"]);
    assert.equal(written(s2.writes, WRITE.updateComment, 15).reason, "resolved");
    assert.deepEqual(commentData(s2.after, 15).conflicts, []);
  });

  it("replaces the check and resolves the comment of a pull request that targets another branch", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const s2 = step(s1.after, [pull(12), pull(15, { baseRefName: "release" })]);
    const check = written(s2.writes, WRITE.updateCheckRun, 15);
    assert.equal(check.check.title, "Not simulated");
    assert.deepEqual(commentLabels(s2.writes), ["updateComment:12", "updateComment:15"]);
    assert.ok(written(s2.writes, WRITE.updateComment, 15).body.startsWith(RESOLVED_LINE));
    assert.deepEqual(commentData(s2.after, 15).notified, [key(12, 15)]);

    // Its result is no longer simulated, so the next run writes nothing to it.
    const s3 = step(s2.after, [pull(12), pull(15, { baseRefName: "release" })]);
    assert.deepEqual(s3.writes, []);
  });
});

describe("check writes", () => {
  it("updates one check per pull request and no comment for a new state, base and order", () => {
    const prs = [pull(12), pull(15), pull(20)];
    const s1 = step(EMPTY, prs, { conflicts: [[12, 15]] });
    const s2 = step(s1.after, prs, {
      conflicts: [[12, 15]],
      base: "c".repeat(40),
      order: [12, 20, 15],
    });
    assert.notEqual(s2.results[0].state, s1.results[0].state);
    assert.deepEqual(s2.writes.map(label), [
      "updateCheckRun:12",
      "updateCheckRun:15",
      "updateCheckRun:20",
    ]);
  });

  it("creates a check on the new SHA of a head that changed", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const moved = sha(15, 1);
    const s2 = step(s1.after, [pull(12), pull(15, { headRefOid: moved })], {
      conflicts: [[12, 15]],
    });
    assert.deepEqual(s2.writes.map(label), ["updateCheckRun:12", "createCheckRun:15"]);
    assert.equal(written(s2.writes, WRITE.createCheckRun, 15).head, moved);
  });
});

describe("publish", () => {
  it("writes both sides of a conflicting pair, every check before the first comment", async () => {
    const calls = [];
    let id = 1;
    const client = {
      async createCheckRun(head, check) {
        calls.push(["createCheckRun", head, check.name]);
        return { id: id++ };
      },
      async updateCheckRun(checkId) {
        calls.push(["updateCheckRun", checkId]);
      },
      async createComment(number, body) {
        calls.push(["createComment", number, extract(body).pr]);
        return { id: id++ };
      },
      async updateComment(commentId) {
        calls.push(["updateComment", commentId]);
      },
      async deleteComment(commentId) {
        calls.push(["deleteComment", commentId]);
      },
    };
    const state = reread(EMPTY, [pull(12), pull(15), pull(20)]);
    const cfg = config();
    const results = run({ prs: state.pulls, cfg, conflicts: [[12, 15]] });
    const made = await publish(results, state, client, cfg);
    assert.deepEqual(calls, [
      ["createCheckRun", sha(12), cfg.checkName],
      ["createCheckRun", sha(15), cfg.checkName],
      ["createCheckRun", sha(20), cfg.checkName],
      ["createComment", 12, 12],
      ["createComment", 15, 15],
    ]);
    assert.equal(made.checks, 3);
    assert.equal(made.comments, 2);
    assert.equal(made.writes.length, 5);
  });

  it("stops at the first failed write", async () => {
    const client = {
      async createCheckRun() {
        throw new Error("boom");
      },
    };
    const state = reread(EMPTY, [pull(12)]);
    const cfg = config();
    await assert.rejects(publish(run({ prs: state.pulls, cfg }), state, client, cfg), /boom/);
  });
});

describe("interrupted and reduced publishes", () => {
  it("plans exactly the writes a partial previous publish missed", () => {
    const prs = [pull(12), pull(15), pull(20)];
    const conflicts = [
      [12, 15],
      [15, 20],
    ];
    const s1 = step(EMPTY, prs, { conflicts });
    const checks = s1.writes.filter(isCheckWrite).length;
    assert.equal(checks, 3);
    const partial = apply(s1.before, s1.writes.slice(0, checks + 1));
    const rest = planPublish(s1.results, partial, s1.cfg);
    const shape = (write) => [write.op, write.pr, write.body];
    assert.deepEqual(rest.map(shape), s1.writes.slice(checks + 1).map(shape));

    // A publish that only checks reached: the comments are all that is left.
    const checksOnly = apply(s1.before, s1.writes.slice(0, checks));
    assert.deepEqual(
      planPublish(s1.results, checksOnly, s1.cfg).map(shape),
      s1.writes.slice(checks).map(shape),
    );
  });

  it("deletes the old comment a re-creation left behind", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const oldId = pullOf(s1.after, 15).comments[0].id;
    const s2 = step(s1.after, [pull(12), pull(15), pull(20)], {
      conflicts: [
        [12, 15],
        [15, 20],
      ],
    });
    const upTo = s2.writes.findIndex((write) => write.op === WRITE.deleteComment);
    const partial = apply(s2.before, s2.writes.slice(0, upTo));
    assert.equal(pullOf(partial, 15).comments.length, 2);
    const rest = planPublish(s2.results, partial, s2.cfg);
    assert.deepEqual(
      rest.map((write) => [write.op, write.pr, write.id, write.reason]),
      [
        [WRITE.deleteComment, 15, oldId, "duplicate"],
        [WRITE.createComment, 20, undefined, "created"],
      ],
    );
  });

  it("replaces a comment whose marker does not parse", () => {
    const s1 = step(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const broken = structuredClone(s1.after);
    pullOf(broken, 15).comments[0].body = "<!-- pr-conflict-radar:v1 {broken -->";
    const s2 = step(broken, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    assert.deepEqual(commentLabels(s2.writes), ["createComment:15", "deleteComment:15"]);
    const s3 = step(broken, [pull(12), pull(15)]);
    assert.deepEqual(
      s3.writes.filter((write) => write.pr === 15 && !isCheckWrite(write)).map((w) => w.reason),
      ["malformed"],
    );
  });

  it("plans no write over its own published output for a truncated result", () => {
    const others = Array.from({ length: 40 }, (_, i) => i + 1).filter((n) => n !== 15);
    const paths = Array.from(
      { length: 20 },
      (_, i) => `src/${String(i).padStart(2, "0")}/${"x".repeat(92)}.ts`,
    );
    const prs = [...others, 15].sort((a, b) => a - b).map((n) => pull(n));
    const s1 = step(EMPTY, prs, { conflicts: others.map((n) => [n, 15, paths]) });
    assert.equal(pullOf(s1.after, 15).recorded.truncated, true);
    assert.deepEqual(planPublish(s1.results, s1.after, s1.cfg), []);
    const recorded = s1.after.pulls.map((pr) => pr.recorded);
    assert.deepEqual(planPublish(recorded, s1.after, s1.cfg), []);
  });
});
