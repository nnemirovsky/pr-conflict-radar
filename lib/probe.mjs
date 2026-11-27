// The quick-exit probe: whether the published results already record the
// state just read, so the run can end before it fetches anything.
//
// It reads only what `readState` returns. The run ends there when all of these
// hold:
// - every open pull request that targets the default branch has the radar's
//   own check on its current head, with a result that is not `degraded`;
// - every such result records the `state` fingerprint of the state just read;
// - no open pull request that targets another branch carries a simulated
//   result;
// - planning a publish of the recorded results against the read state yields
//   no write.
// Otherwise the probe names the first condition that failed and, for a stale
// `state`, what moved, read from the recorded `base`, `order` and `inputs`.

import { inputsOf, selectPrs, stateOf } from "./order.mjs";
import { planPublish } from "./publish.mjs";

export const REASON = Object.freeze({
  unchanged: "unchanged",
  checkMissing: "checkMissing",
  degraded: "degraded",
  baseMoved: "baseMoved",
  prClosed: "prClosed",
  prRetargeted: "prRetargeted",
  prAdded: "prAdded",
  inputsChanged: "inputsChanged",
  stale: "stale",
  otherBaseResult: "otherBaseResult",
  publishPending: "publishPending",
});

// One line per reason, made of fixed words and numbers only.
const MESSAGES = Object.freeze({
  unchanged: () => "The published results record the current state.",
  checkMissing: (pr) => `Pull request ${pr} has no result of the radar on its head.`,
  degraded: (pr) => `The result on pull request ${pr} is degraded.`,
  baseMoved: () => "The default branch moved.",
  prClosed: (pr) => `Pull request ${pr} is no longer open.`,
  prRetargeted: (pr) => `Pull request ${pr} no longer targets the default branch.`,
  prAdded: (pr) => `Pull request ${pr} joined the simulated pull requests.`,
  inputsChanged: (pr) =>
    `The draft state, review decision or order labels of pull request ${pr} changed.`,
  stale: (pr) => `The result on pull request ${pr} records an earlier state.`,
  otherBaseResult: (pr) =>
    `Pull request ${pr} targets another branch and still carries a simulated result.`,
  publishPending: (pr, count) =>
    `A publish of the recorded results makes ${count} writes, the first on pull request ${pr}.`,
});

function outcome(reason, pr, count) {
  const value = { changed: reason !== REASON.unchanged, reason };
  if (pr !== undefined) value.pr = pr;
  value.message = MESSAGES[reason](pr, count);
  return value;
}

// The result the radar's own check on the pull request's current head records,
// or `null`.
function ownResult(pull) {
  const recorded = pull.recorded;
  if (recorded === null || recorded === undefined || pull.checkRunId == null) return null;
  return recorded.head === pull.headRefOid ? recorded : null;
}

// What moved, for the pull requests on the default branch whose results record
// another `state`: the base, then the list of simulated pull requests, then
// the `inputs` of one of them; `stale` when the recorded fields do not say.
function whatMoved(stale, state, config) {
  const { ref, sha } = state.base;
  const base = `${ref}@${sha}`;
  const movedBase = stale.find((pull) => pull.recorded.base !== base);
  if (movedBase) return outcome(REASON.baseMoved);

  const open = new Map(state.pulls.map((pull) => [pull.number, pull]));
  for (const pull of stale) {
    const order = Array.isArray(pull.recorded.order) ? pull.recorded.order : [];
    for (const number of order) {
      const other = open.get(number);
      if (other === undefined) return outcome(REASON.prClosed, number);
      if (other.baseRefName !== ref) return outcome(REASON.prRetargeted, number);
    }
  }

  const selected = selectPrs(state.pulls, config, ref).selected.map((pull) => pull.number);
  for (const pull of stale) {
    const order = new Set(Array.isArray(pull.recorded.order) ? pull.recorded.order : []);
    const added = selected.find((number) => !order.has(number));
    if (added !== undefined) return outcome(REASON.prAdded, added);
  }

  for (const pull of stale) {
    if (pull.recorded.inputs !== inputsOf(pull, config)) {
      return outcome(REASON.inputsChanged, pull.number);
    }
  }
  return outcome(REASON.stale, stale[0].number);
}

// Whether a scan has anything to do. `state` is what `readState` resolves to
// and `config` the loaded config. Resolves to `{changed, reason, pr, message}`:
// `reason` is a key of `REASON` (`unchanged` when `changed` is `false`), `pr`
// the pull request the reason names, when it names one, and `message` a line
// of fixed words and numbers that says what failed.
export function probe(state, config) {
  const { ref, sha } = state.base;
  const pulls = [...state.pulls].sort((a, b) => a.number - b.number);
  const targeted = pulls.filter((pull) => pull.baseRefName === ref);

  for (const pull of targeted) {
    const recorded = ownResult(pull);
    if (recorded === null) return outcome(REASON.checkMissing, pull.number);
    if (recorded.degraded !== false) return outcome(REASON.degraded, pull.number);
  }

  const current = stateOf(sha, pulls, config, ref);
  const stale = targeted.filter((pull) => pull.recorded.state !== current);
  if (stale.length > 0) return whatMoved(stale, state, config);

  for (const pull of pulls) {
    if (pull.baseRefName !== ref && pull.recorded?.simulated === true) {
      return outcome(REASON.otherBaseResult, pull.number);
    }
  }

  const recorded = pulls.map(ownResult).filter((result) => result !== null);
  const writes = planPublish(recorded, state, config);
  if (writes.length > 0) return outcome(REASON.publishPending, writes[0].pr, writes.length);
  return outcome(REASON.unchanged);
}
