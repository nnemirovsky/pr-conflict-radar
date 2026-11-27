import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../lib/config.mjs";
import { inputsOf, predictOrder, selectPrs, stateOf } from "../lib/order.mjs";

const SHA = (n) => n.toString(16).padStart(40, "0");

function pr(number, extra = {}) {
  return {
    number,
    baseRefName: "main",
    headRefOid: SHA(number),
    author: "dev-a",
    labels: [],
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    ...extra,
  };
}

function config({ labelPriority = [], maxPrs = 40 } = {}) {
  const value = defaultConfig();
  value.order.labelPriority = labelPriority;
  value.maxPrs = maxPrs;
  return value;
}

const numbers = (prs) => prs.map((p) => p.number);

describe("predictOrder", () => {
  it("puts ready before draft", () => {
    const prs = [pr(1, { isDraft: true }), pr(2)];
    assert.deepEqual(numbers(predictOrder(prs, config())), [2, 1]);
  });

  it("orders by the highest-priority label, unlabelled last", () => {
    const cfg = config({ labelPriority: ["urgent", "soon"] });
    const prs = [pr(1), pr(2, { labels: ["soon"] }), pr(3, { labels: ["urgent"] })];
    assert.deepEqual(numbers(predictOrder(prs, cfg)), [3, 2, 1]);
  });

  it("takes the best of several priority labels and ignores other labels", () => {
    const cfg = config({ labelPriority: ["urgent", "soon"] });
    const prs = [
      pr(1, { labels: ["soon"] }),
      pr(2, { labels: ["bug", "soon", "urgent"] }),
      pr(3, { labels: ["bug"] }),
    ];
    assert.deepEqual(numbers(predictOrder(prs, cfg)), [2, 1, 3]);
  });

  it("puts APPROVED before any other review decision", () => {
    const prs = [
      pr(1, { reviewDecision: "CHANGES_REQUESTED" }),
      pr(2, { reviewDecision: null }),
      pr(3, { reviewDecision: "APPROVED" }),
    ];
    assert.deepEqual(numbers(predictOrder(prs, config())), [3, 1, 2]);
  });

  it("falls back to the lower number", () => {
    assert.deepEqual(numbers(predictOrder([pr(15), pr(3), pr(12)], config())), [3, 12, 15]);
  });

  it("applies the rules in precedence: draft, label, approval, number", () => {
    const cfg = config({ labelPriority: ["urgent"] });
    const prs = [
      pr(1, { isDraft: true, labels: ["urgent"], reviewDecision: "APPROVED" }),
      pr(2, { reviewDecision: "APPROVED" }),
      pr(3, { labels: ["urgent"] }),
      pr(4),
      pr(5, { reviewDecision: "APPROVED" }),
    ];
    assert.deepEqual(numbers(predictOrder(prs, cfg)), [3, 2, 5, 4, 1]);
  });

  it("ignores every label with an empty labelPriority", () => {
    const prs = [pr(2, { labels: ["urgent"] }), pr(1)];
    assert.deepEqual(numbers(predictOrder(prs, config())), [1, 2]);
  });

  it("returns a new list and leaves the input as it was", () => {
    const prs = [pr(2), pr(1)];
    predictOrder(prs, config());
    assert.deepEqual(numbers(prs), [2, 1]);
  });
});

describe("inputsOf", () => {
  const cfg = config({ labelPriority: ["urgent", "soon"] });

  it("is the draft flag, the review decision and the order labels", () => {
    assert.equal(inputsOf(pr(1), config()), "ready;REVIEW_REQUIRED;");
    assert.equal(inputsOf(pr(1, { isDraft: true, reviewDecision: null }), cfg), "draft;;");
    assert.equal(
      inputsOf(pr(1, { labels: ["soon", "x", "urgent"] }), cfg),
      "ready;REVIEW_REQUIRED;urgent,soon",
    );
  });

  it("changes with the draft flag, the review decision and an order label", () => {
    const before = inputsOf(pr(1), cfg);
    assert.notEqual(inputsOf(pr(1, { isDraft: true }), cfg), before);
    assert.notEqual(inputsOf(pr(1, { reviewDecision: "APPROVED" }), cfg), before);
    assert.notEqual(inputsOf(pr(1, { labels: ["soon"] }), cfg), before);
  });

  it("does not change with another label, the label order, the head or the author", () => {
    const before = inputsOf(pr(1, { labels: ["urgent", "soon"] }), cfg);
    for (const changed of [
      pr(1, { labels: ["urgent", "soon", "bug"] }),
      pr(1, { labels: ["soon", "urgent"] }),
      pr(1, { labels: ["urgent", "soon"], headRefOid: SHA(99), author: "dev-b" }),
    ]) {
      assert.equal(inputsOf(changed, cfg), before);
    }
  });

  it("encodes label names so the fingerprint stays unambiguous", () => {
    const tricky = config({ labelPriority: ["a,b", "a", "b", "x;y"] });
    const one = inputsOf(pr(1, { labels: ["a,b"] }), tricky);
    const two = inputsOf(pr(1, { labels: ["a", "b"] }), tricky);
    assert.notEqual(one, two);
    assert.equal(inputsOf(pr(1, { labels: ["x;y"] }), tricky), "ready;REVIEW_REQUIRED;x%3By");
  });
});

describe("selectPrs", () => {
  it("keeps the pull requests that target the default branch, in predicted order", () => {
    const prs = [pr(3), pr(1, { baseRefName: "release" }), pr(2, { reviewDecision: "APPROVED" })];
    const { selected, leftOut } = selectPrs(prs, config(), "main");
    assert.deepEqual(numbers(selected), [2, 3]);
    assert.deepEqual(leftOut, []);
  });

  it("reads the default branch name it is given", () => {
    const prs = [pr(1, { baseRefName: "trunk" }), pr(2)];
    assert.deepEqual(numbers(selectPrs(prs, config(), "trunk").selected), [1]);
  });

  it("keeps the first maxPrs of the predicted order over the limit", () => {
    const cfg = config({ labelPriority: ["urgent"], maxPrs: 3 });
    const prs = [
      pr(1),
      pr(2, { isDraft: true }),
      pr(3, { labels: ["urgent"] }),
      pr(4, { reviewDecision: "APPROVED" }),
      pr(5),
    ];
    const { selected, leftOut } = selectPrs(prs, cfg, "main");
    assert.deepEqual(numbers(selected), [3, 4, 1]);
    assert.deepEqual(numbers(leftOut), [5, 2]);
  });

  it("reads nothing but the numbers, the target branch and the inputs fingerprint parts", () => {
    const allowed = new Set(["number", "baseRefName", "isDraft", "reviewDecision", "labels"]);
    const guarded = (value) =>
      new Proxy(value, {
        get(target, key) {
          if (typeof key === "string" && !allowed.has(key)) {
            throw new Error(`selectPrs read ${key}`);
          }
          return target[key];
        },
      });
    const cfg = config({ labelPriority: ["urgent"], maxPrs: 2 });
    const prs = [pr(1), pr(2, { labels: ["urgent"] }), pr(3, { reviewDecision: "APPROVED" })];
    const { selected, leftOut } = selectPrs(prs.map(guarded), cfg, "main");
    assert.deepEqual(numbers(selected), [2, 3]);
    assert.deepEqual(numbers(leftOut), [1]);

    const moved = prs.map((p) => ({ ...p, headRefOid: SHA(p.number + 100), author: "dev-z" }));
    assert.deepEqual(numbers(selectPrs(moved, cfg, "main").selected), [2, 3]);
  });
});

describe("stateOf", () => {
  const cfg = config({ labelPriority: ["urgent"] });
  const base = SHA(1000);
  const prs = [pr(12), pr(15, { labels: ["urgent"] }), pr(18, { isDraft: true })];
  const state = stateOf(base, prs, cfg, "main");

  it("is a SHA-256 in hex", () => {
    assert.match(state, /^[0-9a-f]{64}$/);
  });

  it("changes with the base SHA", () => {
    assert.notEqual(stateOf(SHA(1001), prs, cfg, "main"), state);
  });

  it("changes with any pull request's head SHA", () => {
    for (const i of prs.keys()) {
      const moved = prs.map((p, j) => (i === j ? { ...p, headRefOid: SHA(2000 + j) } : p));
      assert.notEqual(stateOf(base, moved, cfg, "main"), state, `head of #${prs[i].number}`);
    }
  });

  it("changes with any inputs", () => {
    for (const change of [
      { isDraft: true },
      { reviewDecision: "APPROVED" },
      { labels: ["urgent"] },
    ]) {
      const moved = [{ ...prs[0], ...change }, prs[1], prs[2]];
      assert.notEqual(stateOf(base, moved, cfg, "main"), state, JSON.stringify(change));
    }
  });

  it("changes with an opened and with a closed pull request", () => {
    assert.notEqual(stateOf(base, [...prs, pr(20)], cfg, "main"), state);
    assert.notEqual(stateOf(base, prs.slice(1), cfg, "main"), state);
  });

  it("changes when a pull request is retargeted to another branch", () => {
    const retargeted = [{ ...prs[0], baseRefName: "release" }, prs[1], prs[2]];
    assert.notEqual(stateOf(base, retargeted, cfg, "main"), state);
  });

  it("does not change with the listed order, another label, the author or another branch's pull request", () => {
    assert.equal(stateOf(base, [...prs].reverse(), cfg, "main"), state);
    const relabelled = [{ ...prs[0], labels: ["bug"], author: "dev-z" }, prs[1], prs[2]];
    assert.equal(stateOf(base, relabelled, cfg, "main"), state);
    assert.equal(stateOf(base, [...prs, pr(30, { baseRefName: "release" })], cfg, "main"), state);
  });

  it("needs the default branch name", () => {
    assert.throws(() => stateOf(base, prs, cfg), TypeError);
  });
});
