import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classOf, mostSevere } from "../lib/classify.mjs";
import { defaultConfig } from "../lib/config.mjs";
import { selectPrs, stateOf } from "../lib/order.mjs";
import { probe, REASON } from "../lib/probe.mjs";
import { isCheckWrite, planPublish, WRITE } from "../lib/publish.mjs";
import { buildResults, embed, extract, MARKER_PREFIX } from "../lib/report.mjs";
import { notSimulated, pairId } from "../lib/simulate.mjs";

const REPO = "acme/widgets";
const BASE = "b".repeat(40);
const NEW_BASE = "c".repeat(40);
const EMPTY = Object.freeze({ base: { ref: "main", sha: BASE }, pulls: [] });

const sha = (n, version = 0) =>
  `${n.toString(16).padStart(8, "0")}${version.toString(16).padStart(32, "0")}`;

const config = (overrides = {}) => ({ ...defaultConfig(), ...overrides });

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

// The results of a scan over the pull requests of `state`. `conflicts` lists
// the conflicting pairs as `[a, b, paths?]`.
function results(state, cfg, conflicts = []) {
  const prs = state.pulls;
  const { ref, sha: baseSha } = state.base;
  const order = selectPrs(prs, cfg, ref).selected.map((pr) => pr.number);
  const paths = new Map(conflicts.map(([a, b, files = ["src/cart.ts"]]) => [pairId(a, b), files]));
  const pairs = [];
  for (const [i, first] of order.entries()) {
    for (const second of order.slice(i + 1)) {
      const files = (paths.get(pairId(first, second)) ?? []).map((path) => ({
        path,
        class: classOf(path, cfg),
      }));
      const classes = files.map((file) => file.class);
      pairs.push({
        first,
        second,
        clean: files.length === 0,
        files,
        class: files.length === 0 ? null : mostSevere(classes, cfg),
      });
    }
  }
  const skipped = notSimulated(prs, cfg, ref);
  const pulls = {};
  for (const pr of prs) {
    if (order.includes(pr.number) || skipped.some((entry) => entry.pr === pr.number)) {
      pulls[pr.number] = pr;
    }
  }
  const simulation = {
    base: { ref, sha: baseSha },
    state: stateOf(baseSha, prs, cfg, ref),
    order,
    pulls,
    baseConflicts: [],
    pairs,
    train: { merged: order, breaks: [] },
    notSimulated: skipped,
    notes: [],
  };
  return buildResults(simulation, cfg, REPO);
}

// The state as `readState` returns it after `prev` was published, with `prs`
// open now on a base at `baseSha`: a pull request keeps its comments, and its
// check while its head stays.
function reread(prev, prs, baseSha = prev.base.sha) {
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
    if (write.op === WRITE.createCheckRun) {
      pr.recorded = extract(write.check.text);
      pr.checkRunId = nextId++;
    } else if (write.op === WRITE.updateCheckRun) {
      pr.recorded = extract(write.check.text);
    } else if (write.op === WRITE.createComment) {
      pr.comments.push({ id: nextId++, body: write.body });
    } else if (write.op === WRITE.updateComment) {
      pr.comments.find((comment) => comment.id === write.id).body = write.body;
    } else {
      pr.comments = pr.comments.filter((comment) => comment.id !== write.id);
    }
  }
  return next;
}

// One full scan: re-read the state with `prs` open, plan the writes and make
// all of them (or the first `upTo`). Returns the state before and after.
function scan(prev, prs, { cfg = config(), conflicts = [], base, upTo } = {}) {
  const before = reread(prev, prs, base);
  const writes = planPublish(results(before, cfg, conflicts), before, cfg);
  return { before, writes, after: apply(before, writes.slice(0, upTo ?? writes.length)) };
}

const pullOf = (state, pr) => state.pulls.find((entry) => entry.number === pr);

// A published state of three open pull requests with 12 and 15 in conflict.
function published(cfg = config()) {
  return scan(EMPTY, [pull(12), pull(15), pull(20)], { cfg, conflicts: [[12, 15]] }).after;
}

function expectMoved(outcome, reason, pr) {
  assert.equal(outcome.changed, true, outcome.message);
  assert.equal(outcome.reason, reason, outcome.message);
  if (pr !== undefined) assert.equal(outcome.pr, pr);
  assert.match(outcome.message, /^[A-Za-z0-9 ,.]+$/);
}

function expectUnchanged(outcome) {
  assert.equal(outcome.changed, false, outcome.message);
  assert.equal(outcome.reason, REASON.unchanged);
}

describe("quick exit", () => {
  it("takes it when every result records the current state and the comments match", () => {
    const state = published();
    assert.equal(pullOf(state, 15).comments.length, 1);
    expectUnchanged(probe(state, config()));
  });

  it("takes it with a pull request left out by maxPrs that carries its not-simulated result", () => {
    const cfg = config({ maxPrs: 2 });
    const state = published(cfg);
    assert.equal(pullOf(state, 20).recorded.simulated, false);
    expectUnchanged(probe(state, cfg));
  });

  it("takes it with a truncated result", () => {
    const paths = Array.from(
      { length: 600 },
      (_, i) => `src/${String(i).padStart(3, "0")}/${"x".repeat(91)}.ts`,
    );
    const state = scan(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15, paths]] }).after;
    assert.equal(pullOf(state, 15).recorded.truncated, true);
    expectUnchanged(probe(state, config()));
  });

  it("takes it with no open pull request", () => {
    expectUnchanged(probe(EMPTY, config()));
  });

  it("takes it with a pull request on another branch that carries no simulated result", () => {
    const state = published();
    const other = scan(
      state,
      [pull(12), pull(15), pull(20), pull(30, { baseRefName: "release" })],
      {
        conflicts: [[12, 15]],
      },
    );
    expectUnchanged(probe(other.after, config()));
  });
});

describe("no quick exit", () => {
  const prs = () => [pull(12), pull(15), pull(20)];

  it("names a push to the default branch", () => {
    const state = reread(published(), prs(), NEW_BASE);
    expectMoved(probe(state, config()), REASON.baseMoved);
  });

  it("names a push to a head", () => {
    const state = reread(published(), [pull(12), pull(15, { headRefOid: sha(15, 1) }), pull(20)]);
    expectMoved(probe(state, config()), REASON.checkMissing, 15);
  });

  it("names an order-label change", () => {
    const cfg = config({ order: { labelPriority: ["urgent"] } });
    const state = reread(published(cfg), [pull(12), pull(15, { labels: ["urgent"] }), pull(20)]);
    expectMoved(probe(state, cfg), REASON.inputsChanged, 15);
  });

  it("names a draft change and a review-decision change", () => {
    const draft = reread(published(), [pull(12), pull(15), pull(20, { isDraft: true })]);
    expectMoved(probe(draft, config()), REASON.inputsChanged, 20);
    const approved = reread(published(), [
      pull(12, { reviewDecision: "APPROVED" }),
      pull(15),
      pull(20),
    ]);
    expectMoved(probe(approved, config()), REASON.inputsChanged, 12);
  });

  it("names a new pull request", () => {
    const state = reread(published(), [...prs(), pull(31)]);
    expectMoved(probe(state, config()), REASON.checkMissing, 31);
  });

  it("names a closed pull request", () => {
    const state = reread(published(), [pull(12), pull(20)]);
    expectMoved(probe(state, config()), REASON.prClosed, 15);
  });

  it("names a retargeted pull request with a simulated result", () => {
    const state = reread(published(), [pull(12), pull(15, { baseRefName: "release" }), pull(20)]);
    expectMoved(probe(state, config()), REASON.prRetargeted, 15);

    // Alone on the default branch side nothing records it; its own result still
    // counts.
    const alone = reread(scan(EMPTY, [pull(15)]).after, [pull(15, { baseRefName: "release" })]);
    expectMoved(probe(alone, config()), REASON.otherBaseResult, 15);
  });

  it("names a pull request that joins the simulated ones without a fresh check", () => {
    // 20 targets another branch and carries its not-simulated result, then is
    // retargeted to the default branch: its check records the earlier state.
    const first = scan(published(), [pull(12), pull(15), pull(20, { baseRefName: "release" })], {
      conflicts: [[12, 15]],
    }).after;
    assert.equal(pullOf(first, 20).recorded.simulated, false);
    const back = reread(first, prs());
    expectMoved(probe(back, config()), REASON.prAdded, 20);
  });

  it("names a degraded result", () => {
    const state = published();
    pullOf(state, 15).recorded.degraded = true;
    expectMoved(probe(state, config()), REASON.degraded, 15);
  });

  it("names a check whose marker does not read as a result", () => {
    // `readState` does not take such a check as the radar's.
    const state = published();
    Object.assign(pullOf(state, 20), { recorded: null, checkRunId: null });
    expectMoved(probe(state, config()), REASON.checkMissing, 20);
  });

  it("names a comment whose marker does not parse", () => {
    const state = published();
    pullOf(state, 15).comments[0].body = `${MARKER_PREFIX}{broken -->`;
    const outcome = probe(state, config());
    expectMoved(outcome, REASON.publishPending, 15);
  });

  it("names a comment missing after an interrupted publish", () => {
    const run = scan(EMPTY, [pull(12), pull(15), pull(20)], { conflicts: [[12, 15]] });
    const checks = run.writes.filter(isCheckWrite).length;
    const partial = apply(run.before, run.writes.slice(0, checks + 1));
    assert.equal(pullOf(partial, 15).comments.length, 0);
    expectMoved(probe(partial, config()), REASON.publishPending, 15);
  });

  it("takes it again once the writes an interrupted publish missed are made", () => {
    const run = scan(EMPTY, [pull(12), pull(15)], { conflicts: [[12, 15]] });
    const checks = run.writes.filter(isCheckWrite).length;
    const partial = apply(run.before, run.writes.slice(0, checks));
    assert.equal(probe(partial, config()).changed, true);
    const rest = planPublish(
      partial.pulls.map((pr) => pr.recorded),
      partial,
      config(),
    );
    expectUnchanged(probe(apply(partial, rest), config()));
  });
});

describe("stale results", () => {
  it("scans again when one check records the current state and another the previous one", () => {
    const first = published();
    const prs = [pull(12, { headRefOid: sha(12, 1) }), pull(15), pull(20)];
    const interrupted = scan(first, prs, { conflicts: [[12, 15]], upTo: 1 });
    assert.equal(interrupted.writes[0].op, WRITE.createCheckRun);
    assert.equal(interrupted.writes[0].pr, 12);
    const state = interrupted.after;
    assert.notEqual(pullOf(state, 12).recorded.state, pullOf(state, 15).recorded.state);
    expectMoved(probe(state, config()), REASON.stale, 15);
  });

  it("scans again when a head moves back to a commit that still carries an older check", () => {
    const first = published();
    const old15 = pullOf(first, 15);
    const second = scan(first, [pull(12), pull(15, { headRefOid: sha(15, 1) }), pull(20)], {
      conflicts: [[12, 15]],
    }).after;
    expectUnchanged(probe(second, config()));
    const back = reread(second, [pull(12), pull(15), pull(20)]);
    Object.assign(pullOf(back, 15), {
      recorded: structuredClone(old15.recorded),
      checkRunId: old15.checkRunId,
    });
    const outcome = probe(back, config());
    assert.equal(outcome.changed, true);
    expectMoved(outcome, REASON.stale, 12);
  });
});

describe("what moves nothing", () => {
  it("ignores a label outside order.labelPriority, a title edit and a new comment", () => {
    const cfg = config({ order: { labelPriority: ["urgent"] } });
    const state = published(cfg);
    // The read state carries neither titles nor other people's comments; a
    // pull request object that holds them anyway changes nothing.
    const edited = reread(state, [
      pull(12, { labels: ["needs-review"], title: "Edited title" }),
      pull(15, { otherComments: 3 }),
      pull(20),
    ]);
    expectUnchanged(probe(edited, cfg));
  });
});

describe("notified keys", () => {
  it("takes the quick exit over a resolved comment that carries notified keys", () => {
    const first = published();
    const resolved = scan(first, [pull(12), pull(15), pull(20)]).after;
    const data = extract(pullOf(resolved, 15).comments[0].body);
    assert.deepEqual(data.conflicts, []);
    assert.equal(data.notified.length, 1);
    expectUnchanged(probe(resolved, config()));
  });

  it("takes the quick exit over a comment whose rows' keys are all notified", () => {
    const state = published();
    const data = extract(pullOf(state, 15).comments[0].body);
    assert.deepEqual(
      data.notified,
      data.conflicts.map((row) => row.key),
    );
    expectUnchanged(probe(state, config()));
  });

  it("scans again when a comment's notified list misses a current row's key", () => {
    const state = published();
    const comment = pullOf(state, 15).comments[0];
    const data = extract(comment.body);
    assert.equal(data.conflicts.length, 1);
    const text = comment.body.slice(0, comment.body.lastIndexOf(MARKER_PREFIX));
    comment.body = `${text}${embed({ ...data, notified: [] })}`;
    assert.deepEqual(extract(comment.body).notified, []);
    expectMoved(probe(state, config()), REASON.publishPending, 15);
  });
});
