// Pair and merge-train simulation over the fetched commits.
//
// A pull request whose head shares no history with the base is not simulated.
// Every other one is first merged into the base in memory. One that conflicts
// with the base is reported as such and left out of the pairs and the train.
// For each pair (first, second) in predicted order, `second` is merged onto
// the commit of `base + first`. The train merges the pull requests
// in order onto an accumulating commit; one that conflicts with it is a train
// break and is skipped, so the later ones are still evaluated.

import { availableParallelism } from "node:os";
import { classOf, mostSevere } from "./classify.mjs";
import { commitMerge, findMergeBase, mergeTree, verifyCommit } from "./git.mjs";
import { selectPrs, stateOf } from "./order.mjs";

export const NOT_SIMULATED = Object.freeze({
  maxPrs: "maxPrs",
  otherBase: "otherBase",
  unrelated: "unrelated",
});

const UNRELATED_NOTE =
  "Not simulated: this pull request shares no history with the default branch.";

// The identifier of a pair in the checked-pair set: `<low>+<high>`.
export function pairId(a, b) {
  return `${Math.min(a, b)}+${Math.max(a, b)}`;
}

// The conflicting files with their classes, in path order, and the most severe
// class among them.
function classified(paths, config) {
  const files = [...paths]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, class: classOf(path, config) }));
  return {
    files,
    class: mostSevere(
      files.map((file) => file.class),
      config,
    ),
  };
}

// Runs `fn` over `items` with at most `limit` calls in flight and resolves to
// the results in the order of `items`.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// The open pull requests that get a "not simulated" result, in number order,
// each as `{pr, reason, note}`: one that targets `defaultBranch` and is left
// out by `maxPrs`, and one that targets another branch while the result its
// head carries (`recorded`) is a simulated one. A pull request that targets
// another branch and carries no simulated result is not listed.
export function notSimulated(prs, config, defaultBranch) {
  const { leftOut } = selectPrs(prs, config, defaultBranch);
  const entries = leftOut.map((pr) => ({
    pr: pr.number,
    reason: NOT_SIMULATED.maxPrs,
    note:
      `Not simulated: more than ${config.maxPrs} open pull requests target the default branch, ` +
      `and this one is not among the first ${config.maxPrs} in the predicted merge order.`,
  }));
  for (const pr of prs) {
    if (pr.baseRefName !== defaultBranch && pr.recorded?.simulated === true) {
      entries.push({
        pr: pr.number,
        reason: NOT_SIMULATED.otherBase,
        note: "Not simulated: this pull request does not target the default branch.",
      });
    }
  }
  return entries.sort((a, b) => a.pr - b.pr);
}

// Simulates the open pull requests `prs` against `base` (`{ref, sha}`: the
// default branch's name and head SHA). Every commit must already be in the
// repository at `options.cwd`; each is verified before any merge.
//
// Resolves to:
// - `base`: the `{ref, sha}` merged onto, `state`: the run's fingerprint;
// - `order`: the numbers of the simulated pull requests in predicted order;
// - `pulls`: every pull request that gets a result, simulated or not, by number;
// - `baseConflicts`: `[{pr, files, class}]` for each one that conflicts with the base;
// - `pairs`: every checked pair in predicted order, `{first, second, clean, files,
//   class}`, where `first` merges first and `second` rebases; a clean pair has no
//   files and a `null` class;
// - `checked`: the checked-pair set as `pairId`s;
// - `train`: `{merged, breaks}`: the numbers merged in train order, and per train
//   break `{pr, train, files, class, multiWay}`;
// - `notSimulated`: see `notSimulated`, plus each selected pull request whose
//   head shares no history with the base, with reason `unrelated`;
// - `notes`: the notes every result of the run carries (the `maxPrs` note).
//
// Files are `{path, class}` in path order. `options` holds the git `cwd` and
// `env`, and `concurrency`, the number of merges in flight.
export async function simulate(base, prs, config, options = {}) {
  const { concurrency = availableParallelism(), ...gitOptions } = options;
  const { selected: candidates, leftOut } = selectPrs(prs, config, base.ref);
  const state = stateOf(base.sha, prs, config, base.ref);

  await verifyCommit(base.sha, gitOptions);
  for (const pr of candidates) await verifyCommit(pr.headRefOid, gitOptions);

  // A head without a merge base with the base cannot be merged; it gets a
  // "not simulated" result and the others are still simulated.
  const ancestors = await mapPool(candidates, concurrency, (pr) =>
    findMergeBase(base.sha, pr.headRefOid, gitOptions),
  );
  const selected = candidates.filter((_, i) => ancestors[i] !== null);
  const skipped = [
    ...notSimulated(prs, config, base.ref),
    ...candidates
      .filter((_, i) => ancestors[i] === null)
      .map((pr) => ({ pr: pr.number, reason: NOT_SIMULATED.unrelated, note: UNRELATED_NOTE })),
  ].sort((a, b) => a.pr - b.pr);

  // Each pull request merged into the base: the merge commit, or the conflict.
  const merged = await mapPool(selected, concurrency, async (pr) => {
    const result = await mergeTree(base.sha, pr.headRefOid, gitOptions);
    if (!result.clean) return { conflict: result.conflictedPaths };
    return { commit: await commitMerge(result.tree, base.sha, pr.headRefOid, gitOptions) };
  });
  const baseConflicts = [];
  const mergeable = [];
  for (const [i, pr] of selected.entries()) {
    if (merged[i].conflict) {
      baseConflicts.push({ pr: pr.number, ...classified(merged[i].conflict, config) });
    } else {
      mergeable.push({ pr, commit: merged[i].commit });
    }
  }

  const pending = [];
  for (const [i, first] of mergeable.entries()) {
    for (const second of mergeable.slice(i + 1)) pending.push({ first, second });
  }
  const pairs = await mapPool(pending, concurrency, async ({ first, second }) => {
    const result = await mergeTree(first.commit, second.pr.headRefOid, gitOptions);
    const pair = { first: first.pr.number, second: second.pr.number, clean: result.clean };
    if (result.clean) return { ...pair, files: [], class: null };
    return { ...pair, ...classified(result.conflictedPaths, config) };
  });
  const conflicting = new Set(
    pairs.filter((pair) => !pair.clean).map((p) => pairId(p.first, p.second)),
  );

  const train = { merged: [], breaks: [] };
  let accumulated = base.sha;
  for (const { pr } of mergeable) {
    const result = await mergeTree(accumulated, pr.headRefOid, gitOptions);
    if (result.clean) {
      accumulated = await commitMerge(result.tree, accumulated, pr.headRefOid, gitOptions);
      train.merged.push(pr.number);
      continue;
    }
    const members = [...train.merged];
    train.breaks.push({
      pr: pr.number,
      train: members,
      ...classified(result.conflictedPaths, config),
      multiWay: !members.some((other) => conflicting.has(pairId(other, pr.number))),
    });
  }

  const pulls = {};
  for (const pr of selected) pulls[pr.number] = pr;
  for (const { pr: number } of skipped) pulls[number] = prs.find((pr) => pr.number === number);

  const notes = [];
  if (leftOut.length > 0) {
    const open = candidates.length + leftOut.length;
    notes.push(
      `Simulated the first ${config.maxPrs} of ${open} open pull requests that target the ` +
        "default branch, in the predicted merge order; the rest were not simulated.",
    );
  }

  return {
    base: { ref: base.ref, sha: base.sha },
    state,
    order: selected.map((pr) => pr.number),
    pulls,
    baseConflicts,
    pairs,
    checked: pairs.map((pair) => pairId(pair.first, pair.second)),
    train,
    notSimulated: skipped,
    notes,
  };
}
