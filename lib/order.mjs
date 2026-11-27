// Throwaway probe A: the predicted merge order, the selection of the pull requests a run
// simulates, and the `state` fingerprint.
//
// A pull request here is the object the read query yields:
// `{number, baseRefName, headRefOid, author, labels, isDraft, reviewDecision}`,
// with `author` a login or `null` and `labels` a list of label names. The order
// reads the number and the parts of the `inputs` fingerprint (the draft flag,
// the review decision and the labels named in `order.labelPriority`) and
// nothing else, so a title edit, a comment or the radar's own writes never
// change it.

import { createHash } from "node:crypto";

// The labels of `pr` that `order.labelPriority` names, in priority order.
function orderLabels(pr, config) {
  const labels = new Set(pr.labels ?? []);
  return config.order.labelPriority.filter((label, i, list) => {
    return labels.has(label) && list.indexOf(label) === i;
  });
}

// The canonical fingerprint of what the order reads from one pull request:
// `ready` or `draft`, the review decision (empty when there is none) and the
// order labels in priority order, each percent-encoded and joined by `,`;
// the three parts are joined by `;`, for example `ready;REVIEW_REQUIRED;`.
export function inputsOf(pr, config) {
  const labels = orderLabels(pr, config).map(encodeURIComponent).join(",");
  return `${pr.isDraft ? "draft" : "ready"};${pr.reviewDecision ?? ""};${labels}`;
}

function sortKey(pr, config) {
  const priority = config.order.labelPriority;
  const ranks = (pr.labels ?? []).map((label) => priority.indexOf(label)).filter((i) => i >= 0);
  return {
    draft: pr.isDraft ? 1 : 0,
    label: ranks.length > 0 ? Math.min(...ranks) : priority.length,
    approved: pr.reviewDecision === "APPROVED" ? 0 : 1,
    number: pr.number,
  };
}

// `prs` in predicted merge order: ready before draft; then by the
// highest-priority label of `order.labelPriority` a pull request carries, one
// without such a label after every one with it; then `APPROVED` before any
// other review decision; then the lower number. Returns a new list.
export function predictOrder(prs, config) {
  const keyed = prs.map((pr) => ({ pr, key: sortKey(pr, config) }));
  keyed.sort(
    (a, b) =>
      a.key.draft - b.key.draft ||
      a.key.label - b.key.label ||
      a.key.approved - b.key.approved ||
      a.key.number - b.key.number,
  );
  return keyed.map(({ pr }) => pr);
}

// The pull requests that target `defaultBranch`, in predicted order, split
// into the first `maxPrs` (`selected`, the ones a run simulates) and the rest
// (`leftOut`).
export function selectPrs(prs, config, defaultBranch) {
  const targeted = prs.filter((pr) => pr.baseRefName === defaultBranch);
  const ordered = predictOrder(targeted, config);
  return { selected: ordered.slice(0, config.maxPrs), leftOut: ordered.slice(config.maxPrs) };
}

// The `state` fingerprint: the SHA-256 of a canonical JSON of the base SHA
// and, for every pull request that targets `defaultBranch`, in number order,
// its number, its head SHA and its `inputs`.
export function stateOf(baseSha, prs, config, defaultBranch) {
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    throw new TypeError("stateOf needs the default branch name");
  }
  const entries = prs
    .filter((pr) => pr.baseRefName === defaultBranch)
    .map((pr) => [pr.number, pr.headRefOid, inputsOf(pr, config)])
    .sort((a, b) => a[0] - b[0]);
  const canonical = JSON.stringify({ base: baseSha, prs: entries });
  return createHash("sha256").update(canonical).digest("hex");
}
