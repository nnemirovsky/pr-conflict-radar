// The publisher: plans every write of a run, then makes them one after another.
//
// `planPublish` compares the results with what the read state carries (the
// radar's own check and comments on every open pull request) and returns the
// writes, every check write before any comment write. `publish` executes such a
// plan through the GitHub client.
//
// A check is written when the reduced result differs from the result the
// radar's own check on the head records. A comment is written only when the
// body it would get differs from its current body. That body is rendered from
// the findings of the reduced result, the rows of the existing comment whose
// pair this run did not check, the `notified` list and the wording
// `suggestPeerbus` selects. A row whose pair key is not in `notified` is a new
// member: the fresh comment is created first and the old one deleted after it,
// so an interrupted publish leaves two comments rather than none, and the next
// run deletes the older one.

import { isDeepStrictEqual } from "node:util";
import { extract, findings, reduceResult, renderCheck, renderComment, SCHEMA } from "./report.mjs";

// How many keys beyond the current rows' keys a `notified` list keeps when a
// key is added.
export const NOTIFIED_EXTRA = 100;

export const WRITE = Object.freeze({
  createCheckRun: "createCheckRun",
  updateCheckRun: "updateCheckRun",
  createComment: "createComment",
  updateComment: "updateComment",
  deleteComment: "deleteComment",
});

const CHECK_WRITES = new Set([WRITE.createCheckRun, WRITE.updateCheckRun]);

// Whether a planned write is a check write (otherwise it is a comment write).
export const isCheckWrite = (write) => CHECK_WRITES.has(write.op);

const normal = (value) => JSON.parse(JSON.stringify(value));

// `notified` with the oldest keys that are on no current row dropped until at
// most `NOTIFIED_EXTRA` such keys remain. A key of `current` is never dropped.
export function boundNotified(notified, current) {
  const keep = new Set(current);
  let extra = notified.filter((key) => !keep.has(key)).length;
  const bounded = [];
  for (const key of notified) {
    if (extra > NOTIFIED_EXTRA && !keep.has(key)) {
      extra -= 1;
      continue;
    }
    bounded.push(key);
  }
  return bounded;
}

// The data a comment embeds when it is readable as this pull request's:
// findings of `repo` and `number` with a list of rows and a `notified` list of
// strings. Otherwise `null`.
function commentData(comment, repo, number) {
  const data = extract(comment.body);
  if (data === null) return null;
  if (repo !== null && data.repo !== repo) return null;
  if (data.pr !== number) return null;
  if (!Array.isArray(data.notified) || !data.notified.every((key) => typeof key === "string")) {
    return null;
  }
  if (!Array.isArray(data.conflicts)) return null;
  const rowsValid = data.conflicts.every(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      Number.isInteger(row.with) &&
      typeof row.key === "string",
  );
  return rowsValid ? data : null;
}

const byNumber = (a, b) => a - b;

// The ordered writes that bring the published state in line with `results`.
//
// `results` are the run's results (complete or already reduced), `state` is
// what `readState` resolves to and `config` the loaded config. Each write is
// one of:
// - `{op: "createCheckRun", pr, head, check, reason}`
// - `{op: "updateCheckRun", pr, id, check, reason}`
// - `{op: "createComment", pr, body, reason}`
// - `{op: "updateComment", pr, id, body, reason}`
// - `{op: "deleteComment", pr, id, reason}`
// `check` is what `renderCheck` returns. `reason` is `missing` or `changed` for
// a check, and `created`, `newMember`, `changed`, `resolved`, `malformed`,
// `replaced` or `duplicate` for a comment. The check writes come first, in
// number order, then the comment writes, grouped per pull request in number
// order.
export function planPublish(results, state, config) {
  const defaultBranch = state.base.ref;
  const pulls = new Map(state.pulls.map((pull) => [pull.number, pull]));
  const reduced = new Map(results.map((result) => [result.pr, reduceResult(result)]));
  const repo = results[0]?.repo ?? null;

  const simulated = new Set();
  const baseConflicting = new Set();
  for (const result of reduced.values()) {
    if (result.simulated) simulated.add(result.pr);
    if (result.conflictsWithBase) baseConflicting.add(result.pr);
  }
  // A pair is checked when both pull requests are simulated and neither
  // conflicts with the base.
  const checked = (a, b) =>
    simulated.has(a) && simulated.has(b) && !baseConflicting.has(a) && !baseConflicting.has(b);
  const onDefault = (number) => pulls.get(number)?.baseRefName === defaultBranch;

  const checkWrites = [];
  for (const result of [...results].sort((a, b) => a.pr - b.pr)) {
    const pull = pulls.get(result.pr);
    const recorded =
      pull?.recorded && pull.checkRunId != null && pull.headRefOid === result.head
        ? pull.recorded
        : null;
    if (recorded !== null && isDeepStrictEqual(normal(reduced.get(result.pr)), normal(recorded))) {
      continue;
    }
    const check = renderCheck(result, config);
    if (recorded === null) {
      checkWrites.push({
        op: WRITE.createCheckRun,
        pr: result.pr,
        head: result.head,
        check,
        reason: "missing",
      });
    } else {
      checkWrites.push({
        op: WRITE.updateCheckRun,
        pr: result.pr,
        id: pull.checkRunId,
        check,
        reason: "changed",
      });
    }
  }

  const numbers = [...new Set([...pulls.keys(), ...reduced.keys()])].sort(byNumber);
  const commentWrites = [];
  for (const number of numbers) {
    const comments = pulls.get(number)?.comments ?? [];
    const current = comments.at(-1) ?? null;
    const existing = current === null ? null : commentData(current, repo, number);
    const dataRepo = repo ?? existing?.repo ?? null;
    const result = reduced.get(number) ?? null;

    if (dataRepo !== null) {
      const fresh = result === null ? [] : findings(result, config).conflicts;
      const freshWith = new Set(fresh.map((row) => row.with));
      const kept = (existing?.conflicts ?? []).filter(
        (row) =>
          !freshWith.has(row.with) &&
          !checked(number, row.with) &&
          onDefault(number) &&
          onDefault(row.with),
      );
      const rows = [...fresh, ...kept].sort((a, b) => a.with - b.with);
      const keys = rows.map((row) => row.key);
      const notified = existing?.notified ?? [];
      const known = new Set(notified);
      const added = [...new Set(keys.filter((key) => !known.has(key)))];
      const data = { schema: SCHEMA, repo: dataRepo, pr: number, conflicts: rows };

      if (added.length > 0) {
        const body = renderComment(
          { ...data, notified: boundNotified([...notified, ...added], keys) },
          config,
        );
        commentWrites.push({
          op: WRITE.createComment,
          pr: number,
          body,
          reason: current === null ? "created" : "newMember",
        });
        if (current !== null) {
          commentWrites.push({
            op: WRITE.deleteComment,
            pr: number,
            id: current.id,
            reason: "replaced",
          });
        }
      } else if (current !== null) {
        const body = renderComment({ ...data, notified: [...notified] }, config);
        if (body !== current.body) {
          let reason = "changed";
          if (existing === null) reason = "malformed";
          else if (rows.length === 0) reason = "resolved";
          commentWrites.push({ op: WRITE.updateComment, pr: number, id: current.id, body, reason });
        }
      }
    }

    for (const extra of comments.slice(0, -1)) {
      commentWrites.push({
        op: WRITE.deleteComment,
        pr: number,
        id: extra.id,
        reason: "duplicate",
      });
    }
  }

  return [...checkWrites, ...commentWrites];
}

// Plans the writes for `results` against `state` and makes them through
// `client` one after another, every check write before any comment write.
// Resolves to `{checks, comments, writes}`: the number of check writes and
// comment writes made, and the plan.
export async function publish(results, state, client, config) {
  const writes = planPublish(results, state, config);
  const made = { checks: 0, comments: 0 };
  for (const write of writes) {
    switch (write.op) {
      case WRITE.createCheckRun:
        await client.createCheckRun(write.head, write.check);
        break;
      case WRITE.updateCheckRun:
        await client.updateCheckRun(write.id, write.check);
        break;
      case WRITE.createComment:
        await client.createComment(write.pr, write.body);
        break;
      case WRITE.updateComment:
        await client.updateComment(write.id, write.body);
        break;
      case WRITE.deleteComment:
        await client.deleteComment(write.id);
        break;
      default:
        throw new Error(`unknown write ${write.op}`);
    }
    if (isCheckWrite(write)) made.checks += 1;
    else made.comments += 1;
  }
  return { ...made, writes };
}
