// The result model and its renderers.
//
// `buildResults` turns a simulation into one result object per pull request.
// `renderCheck`, `renderComment` and
// `renderJobSummary` render results as Markdown. Every piece of text the tool
// did not choose itself (file paths, member names, class names, pair keys,
// notes) goes through `escapeText`, and every author login through
// `loginLink`, which links a login in GitHub's username format to its profile
// and escapes any other; the fixed wording and the peerbus
// lines are constants of this module. `embed` and `extract` write and read the
// result a check or a comment carries in an HTML comment.
//
// Every rendered field stays under `BUDGET` characters. A result or a comment's
// data whose embedded form passes `EMBED_BUDGET` is reduced first
// (`reduceResult`, `reduceComment`), and a table or list that would pass the
// budget is cut and ends with the number of rows left out.

import { pairKey } from "./classify.mjs";
import { escapeText, loginLink, markerJson } from "./escape.mjs";
import { fileMembers, memberSignals } from "./members.mjs";
import { inputsOf } from "./order.mjs";
import { NOT_SIMULATED, pairId } from "./simulate.mjs";

export const SCHEMA = 1;
export const BUDGET = 60000;
export const EMBED_BUDGET = 45000;

export const MARKER_PREFIX = "<!-- pr-conflict-radar:v1 ";
const MARKER_SUFFIX = " -->";

export const PEERBUS_LINK = "https://github.com/nnemirovsky/peerbus";
export const PEERBUS_LINE = `Agents that both use [peerbus](${PEERBUS_LINK}) can coordinate under the pair key as a topic name.`;
export const PEERBUS_OPTIONAL_LINE = `Optional: agents working on both pull requests can coordinate on [peerbus](${PEERBUS_LINK}) under the pair key as a topic name.`;
export const COMMENT_LINE =
  "These open pull requests will conflict with this one when either side merges first.";
export const OTHERS_LINE = "Agree with the other author on who rebases.";
export const OWN_LINE =
  "Both pull requests of each pair below are yours, so these conflicts can be resolved within your own environment.";
export const RESOLVED_LINE = "Resolved: none of the conflicts reported here remains.";

const CONCLUSION = Object.freeze({ neutral: "neutral", success: "success" });

// --- The result model -------------------------------------------------------

const copyFiles = (files) => files.map((file) => ({ ...file }));

function joinNumbers(numbers) {
  return numbers.map(prRef).join(", ");
}

// The notes naming the open pull requests a simulated pull request was not
// checked against, and why.
function uncheckedNotes(number, simulation, config) {
  const baseConflicting = simulation.baseConflicts.map((entry) => entry.pr).sort((a, b) => a - b);
  const leftOut = simulation.notSimulated
    .filter((entry) => entry.reason === NOT_SIMULATED.maxPrs)
    .map((entry) => entry.pr);
  const notes = [];
  if (baseConflicting.includes(number)) {
    if (simulation.order.length > 1) {
      notes.push(
        "Not checked against the other pull requests: this pull request conflicts with the default branch.",
      );
    }
  } else {
    const others = baseConflicting.filter((other) => other !== number);
    if (others.length === 1) {
      notes.push(`Not checked against ${prRef(others[0])}: it conflicts with the default branch.`);
    } else if (others.length > 1) {
      notes.push(
        `Not checked against ${joinNumbers(others)}: they conflict with the default branch.`,
      );
    }
  }
  const unrelated = simulation.notSimulated
    .filter((entry) => entry.reason === NOT_SIMULATED.unrelated)
    .map((entry) => entry.pr);
  if (unrelated.length === 1) {
    notes.push(
      `Not checked against ${prRef(unrelated[0])}: it shares no history with the default branch.`,
    );
  } else if (unrelated.length > 1) {
    notes.push(
      `Not checked against ${joinNumbers(unrelated)}: they share no history with the default branch.`,
    );
  }
  if (leftOut.length > 0) {
    notes.push(
      `Not checked against ${joinNumbers(leftOut)}: not simulated, because more than ` +
        `${config.maxPrs} open pull requests target the default branch.`,
    );
  }
  return notes;
}

// The files of a conflicting pair, each with the members either pull request
// changed in it when there are any.
function conflictFiles(pair, members) {
  return pair.files.map((file) => {
    const names = members
      ? fileMembers(members.changes[pair.first], members.changes[pair.second], file.path)
      : [];
    return names.length > 0 ? { ...file, members: names } : { ...file };
  });
}

// One result per pull request that gets one, in number order. `simulation` is
// what `simulate` resolves to, `repo` is `owner/name`, and `members`, when
// given, is what `mapMembers` resolves to: it adds the `overlaps` and `hints`
// of the clean pairs, the members of each conflicting file, its notes and the
// `degraded` flag. The results are complete: `reduceResult` makes the form a
// check embeds.
export function buildResults(simulation, config, repo, members = null) {
  const { state, order, pulls } = simulation;
  const base = `${simulation.base.ref}@${simulation.base.sha}`;
  const baseConflicts = new Set(simulation.baseConflicts.map((entry) => entry.pr));
  const breaks = new Map(simulation.train.breaks.map((entry) => [entry.pr, entry]));
  const authorOf = (number) => pulls[number]?.author ?? null;
  const degraded = new Set(members?.degraded ?? []);
  const signals = new Map();
  if (members) {
    for (const pair of simulation.pairs) {
      if (!pair.clean) continue;
      signals.set(
        pairId(pair.first, pair.second),
        memberSignals(members.changes[pair.first], members.changes[pair.second], config),
      );
    }
  }
  const results = [];

  for (const number of order) {
    const pull = pulls[number];
    const author = authorOf(number);
    const partner = (pair) => {
      const other = pair.first === number ? pair.second : pair.first;
      const withAuthor = authorOf(other);
      return {
        with: other,
        withAuthor,
        sameAuthor: author !== null && author === withAuthor,
        key: pairKey(config, repo, pair.first, pair.second),
      };
    };
    const ownPairs = simulation.pairs.filter(
      (pair) => pair.first === number || pair.second === number,
    );
    const conflicts = ownPairs
      .filter((pair) => !pair.clean)
      .map((pair) => {
        const { key, ...other } = partner(pair);
        return {
          ...other,
          tier: "textual",
          class: pair.class,
          files: conflictFiles(pair, members),
          mergesFirst: pair.first,
          rebases: pair.second,
          key,
        };
      })
      .sort((a, b) => a.with - b.with);
    const overlaps = [];
    const hints = [];
    for (const pair of ownPairs) {
      const found = signals.get(pairId(pair.first, pair.second));
      if (!found) continue;
      const other = partner(pair);
      if (found.sameMember.length > 0) {
        const { key, ...rest } = other;
        overlaps.push({
          ...rest,
          tier: "member",
          kind: "same-member",
          members: found.sameMember.map((member) => ({ ...member })),
          key,
        });
      }
      if (found.changedAndUsed.length > 0) {
        hints.push({
          with: other.with,
          kind: "changed-and-used",
          names: found.changedAndUsed.map((name) => ({ ...name })),
        });
      }
    }
    overlaps.sort((a, b) => a.with - b.with);
    hints.sort((a, b) => a.with - b.with);
    const trainBreak = breaks.get(number);
    results.push({
      schema: SCHEMA,
      repo,
      base,
      pr: number,
      head: pull.headRefOid,
      author,
      inputs: inputsOf(pull, config),
      state,
      simulated: true,
      order: [...order],
      conflictsWithBase: baseConflicts.has(number),
      conflicts,
      overlaps,
      hints,
      trainBreak: trainBreak
        ? {
            train: [...trainBreak.train],
            files: copyFiles(trainBreak.files),
            class: trainBreak.class,
            multiWay: trainBreak.multiWay,
          }
        : null,
      degraded: degraded.has(number),
      truncated: false,
      notes: [
        ...simulation.notes,
        ...uncheckedNotes(number, simulation, config),
        ...(members?.notes[number] ?? []),
      ],
    });
  }

  for (const entry of simulation.notSimulated) {
    const pull = pulls[entry.pr];
    results.push({
      schema: SCHEMA,
      repo,
      base,
      pr: entry.pr,
      head: pull.headRefOid,
      author: pull.author ?? null,
      inputs: inputsOf(pull, config),
      state,
      simulated: false,
      order: [...order],
      conflictsWithBase: false,
      conflicts: [],
      overlaps: [],
      hints: [],
      trainBreak: null,
      degraded: false,
      truncated: false,
      notes: [entry.note, ...simulation.notes],
    });
  }

  return results.sort((a, b) => a.pr - b.pr);
}

// What a comment is made of: `schema`, `repo`, `pr` and the `conflicts` entries
// whose class is in `commentClasses`.
export function findings(result, config) {
  const classes = new Set(config.commentClasses);
  return {
    schema: result.schema,
    repo: result.repo,
    pr: result.pr,
    conflicts: result.conflicts
      .filter((conflict) => classes.has(conflict.class))
      .map((conflict) => structuredClone(conflict)),
  };
}

// --- The embedded marker ----------------------------------------------------

// The HTML comment that carries `value`.
export function embed(value) {
  return `${MARKER_PREFIX}${markerJson(value)}${MARKER_SUFFIX}`;
}

// The value of the last marker in `text`, or `null` when there is none, it does
// not parse, or it is not an object of the known schema.
export function extract(text) {
  if (typeof text !== "string") return null;
  const start = text.lastIndexOf(MARKER_PREFIX);
  if (start < 0) return null;
  const from = start + MARKER_PREFIX.length;
  const end = text.indexOf(MARKER_SUFFIX, from);
  if (end < 0) return null;
  let value;
  try {
    value = JSON.parse(text.slice(from, end));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema !== SCHEMA) return null;
  return value;
}

// --- Reduction --------------------------------------------------------------

const fits = (value) => embed(value).length <= EMBED_BUDGET;

// The lists a reduction shortens, each with the field that records how many
// entries it left out: the files of every conflict and of the train break, the
// members of every file and overlap, the names of every hint and the notes.
// A list keeps its first entries, so the notes a run adds first (the `maxPrs`
// note, the unchecked pull requests, the reason a result was not simulated)
// stay.
function* lists(value) {
  if (Array.isArray(value.notes)) yield [value, "notes", "notesOmitted"];
  for (const conflict of value.conflicts ?? []) {
    yield [conflict, "files", "filesOmitted"];
    for (const file of conflict.files) yield [file, "members", "membersOmitted"];
  }
  for (const overlap of value.overlaps ?? []) yield [overlap, "members", "membersOmitted"];
  for (const hint of value.hints ?? []) yield [hint, "names", "namesOmitted"];
  if (value.trainBreak) yield [value.trainBreak, "files", "filesOmitted"];
}

function capLists(value, limit) {
  const copy = structuredClone(value);
  for (const [holder, field, omitted] of [...lists(copy)]) {
    const list = holder[field];
    if (!Array.isArray(list) || list.length <= limit) continue;
    holder[omitted] = (holder[omitted] ?? 0) + list.length - limit;
    holder[field] = list.slice(0, limit);
  }
  return copy;
}

// The largest length at which capping every list of `value` makes its
// embedded form fit, or zero when none does.
function capLimit(value) {
  let longest = 0;
  for (const [holder, field] of lists(value)) {
    if (Array.isArray(holder[field])) longest = Math.max(longest, holder[field].length);
  }
  let best = 0;
  let low = 1;
  let high = longest;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(capLists(value, mid))) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

// `value` with the last entries of its top-level lists dropped, one list of
// `drops` after the other (`[field, omittedField]` pairs), until its embedded
// form fits with every nested list capped at zero. Each list keeps as many
// first entries as fit and records how many it left out.
function dropToFit(value, drops) {
  const ok = (candidate) => fits(capLists(candidate, 0));
  let current = value;
  for (const [field, omitted] of drops) {
    if (ok(current)) return current;
    const list = current[field];
    if (!Array.isArray(list) || list.length === 0) continue;
    const base = current;
    const take = (count) => ({
      ...base,
      [field]: list.slice(0, count),
      [omitted]: (base[omitted] ?? 0) + list.length - count,
    });
    current = take(0);
    let low = 1;
    let high = list.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = take(mid);
      if (ok(candidate)) {
        current = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  }
  return current;
}

// What a check or a comment shows and what it embeds, for a value that does
// not fit `EMBED_BUDGET`: `truncated: true` and every list capped at the largest
// length at which the embedded form fits. When even lists capped at zero do
// not fit, the last entries of the top-level lists named in `drops` leave the
// embedded value (their counts recorded), the lists are capped at the largest
// length that fits for the entries kept, and the shown value keeps every entry
// with its lists capped at that length, so the text counts and cuts them as
// usual.
function reduceParts(value, drops) {
  const truncated = { ...value, truncated: true };
  if (fits(capLists(truncated, 0))) {
    const capped = capLists(truncated, capLimit(truncated));
    return { shown: capped, embedded: capped };
  }
  const kept = dropToFit(truncated, drops);
  const limit = capLimit(kept);
  return { shown: capLists(truncated, limit), embedded: capLists(kept, limit) };
}

// The top-level lists a result drops entries from when capping is not enough:
// the hints first, which never change the conclusion, then the overlaps, then
// the conflicts.
const RESULT_DROPS = [
  ["hints", "hintsOmitted"],
  ["overlaps", "overlapsOmitted"],
  ["conflicts", "conflictsOmitted"],
];

// The top-level lists a comment's data drops entries from when capping is not
// enough: the rows first, then the `notified` keys, so that the key of a row
// left out stays notified.
const COMMENT_DROPS = [
  ["conflicts", "conflictsOmitted"],
  ["notified", "notifiedOmitted"],
];

function resultParts(result) {
  if (fits(result)) return { shown: result, embedded: result };
  return reduceParts(result, RESULT_DROPS);
}

function commentParts(data) {
  if (fits(data)) return { shown: data, embedded: data };
  const current = new Set(data.conflicts.map((conflict) => conflict.key));
  const notified = [...data.notified];
  let value = { ...data, notified };
  for (let i = 0; i < notified.length && !fits(value); ) {
    if (current.has(notified[i])) {
      i += 1;
      continue;
    }
    notified.splice(i, 1);
    value = { ...data, notified: [...notified] };
  }
  if (fits(value)) return { shown: value, embedded: value };
  return reduceParts(value, COMMENT_DROPS);
}

// The result as a check embeds it: unchanged when its embedded form fits
// `EMBED_BUDGET`; otherwise with fewer files, members and hint names per entry,
// the left-out counts recorded and `truncated: true`, and, when that is not
// enough, without the last hints, overlaps and conflicts. A reduced result is
// returned unchanged.
export function reduceResult(result) {
  return resultParts(result).embedded;
}

// A comment's data (findings plus `notified`) as the comment embeds it:
// unchanged when it fits; otherwise the oldest `notified` keys that are on no
// current row go first, then the lists are capped as in `reduceResult`, and,
// when that is not enough, the last rows and then the last `notified` keys
// leave it.
export function reduceComment(data) {
  return commentParts(data).embedded;
}

// --- Rendering helpers ------------------------------------------------------

function prRef(number) {
  return `#${Math.trunc(Number(number))}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function authorCell(login) {
  return login === null || login === undefined ? "unknown" : loginLink(login);
}

function row(cells) {
  return `| ${cells.join(" | ")} |`;
}

function tableHead(columns) {
  return [row(columns), row(columns.map(() => "---"))];
}

function more(count, word) {
  return count > 0 ? `and ${count} more ${word}${count === 1 ? "" : "s"}` : null;
}

function membersText(members, omitted) {
  const parts = members.map((member) =>
    typeof member === "string"
      ? escapeText(member)
      : `${escapeText(member.name)} in ${escapeText(member.path)}`,
  );
  const tail = more(omitted ?? 0, "member");
  if (tail) parts.push(tail);
  return parts.join(", ");
}

function filesCell(holder) {
  const parts = holder.files.map((file) => {
    let text = `${escapeText(file.path)} (${escapeText(file.class)})`;
    if (Array.isArray(file.members) && (file.members.length > 0 || file.membersOmitted)) {
      text += `: ${membersText(file.members, file.membersOmitted)}`;
    }
    return text;
  });
  const tail = more(holder.filesOmitted ?? 0, "file");
  if (tail) parts.push(tail);
  return parts.join("<br>");
}

// The room a cut list leaves for the fixed blocks after it (headings, the
// wording, the peerbus lines, the order and write counts), which are never cut.
const FIXED_RESERVE = 4000;

// A Markdown field of at most `limit` characters, built from blocks separated
// by a blank line. `text` adds a fixed block; `rows` adds a block whose rows are
// cut to the room left, keeping `FIXED_RESERVE` free.
class Field {
  constructor(limit) {
    this.limit = limit;
    this.blocks = [];
  }

  room() {
    const used = this.blocks.reduce((total, block) => total + block.length + 2, 0);
    return this.limit - FIXED_RESERVE - used;
  }

  text(block) {
    this.blocks.push(block);
  }

  // `head` lines kept whole, then as many `rows` as fit, then, when rows were
  // left out, a line after a blank line that counts them.
  rows(head, rows, word) {
    const whole = [...head, ...rows].join("\n");
    const room = this.room();
    if (whole.length <= room) {
      this.blocks.push(whole);
      return;
    }
    const join = (block, line) => (block === "" ? line : `${block}\n${line}`);
    const leftOut = (count) => `${plural(count, `more ${word}`)} left out.`;
    const tail = (block, count) =>
      block === "" ? leftOut(count) : `${block}\n\n${leftOut(count)}`;
    let block = head.join("\n");
    let kept = 0;
    for (const line of rows) {
      const next = join(block, line);
      if (tail(next, rows.length - kept - 1).length > room) break;
      block = next;
      kept += 1;
    }
    this.blocks.push(tail(block, rows.length - kept));
  }

  toString() {
    return this.blocks.join("\n\n");
  }
}

// A field that ends with `marker`, the whole under `BUDGET` characters.
function withMarker(build, marker) {
  const field = new Field(BUDGET - 1 - marker.length - 2);
  build(field);
  const body = field.toString();
  return body === "" ? marker : `${body}\n\n${marker}`;
}

function conflictTable(field, conflicts, config) {
  const columns = ["Pull request", "Author", "Files", "Who rebases"];
  if (config.suggestPeerbus) columns.push("Pair key");
  const rows = conflicts.map((conflict) => {
    const cells = [
      prRef(conflict.with),
      authorCell(conflict.withAuthor),
      filesCell(conflict),
      prRef(conflict.rebases),
    ];
    if (config.suggestPeerbus) cells.push(escapeText(conflict.key));
    return row(cells);
  });
  field.rows(tableHead(columns), rows, "row");
}

// The conflicts in two groups, other authors' pull requests first, each with
// its table and its wording.
function conflictSections(field, conflicts, config) {
  const others = conflicts.filter((conflict) => !conflict.sameAuthor);
  const own = conflicts.filter((conflict) => conflict.sameAuthor);
  if (others.length > 0) {
    field.text("### Pull requests of other authors");
    conflictTable(field, others, config);
    field.text(OTHERS_LINE);
    if (config.suggestPeerbus) field.text(PEERBUS_LINE);
  }
  if (own.length > 0) {
    field.text("### Pull requests of yours");
    field.text(OWN_LINE);
    conflictTable(field, own, config);
    if (config.suggestPeerbus) field.text(PEERBUS_OPTIONAL_LINE);
  }
}

function overlapSection(field, overlaps, config) {
  if (overlaps.length === 0) return;
  field.text("### Member overlaps");
  const columns = ["Pull request", "Author", "Members"];
  if (config.suggestPeerbus) columns.push("Pair key");
  const rows = overlaps.map((overlap) => {
    const cells = [
      prRef(overlap.with),
      authorCell(overlap.withAuthor),
      membersText(overlap.members, overlap.membersOmitted),
    ];
    if (config.suggestPeerbus) cells.push(escapeText(overlap.key));
    return row(cells);
  });
  field.rows(tableHead(columns), rows, "row");
  if (config.suggestPeerbus) field.text(PEERBUS_LINE);
}

const HINT_CAVEAT =
  "A hint matches a name across the whole repository, so it can be wrong. Hints never change the conclusion.";

function hintRows(hints, withSource) {
  return hints.map((hint) => {
    const names = hint.names.map((name) => `${escapeText(name.name)} in ${escapeText(name.path)}`);
    const tail = more(hint.namesOmitted ?? 0, "name");
    if (tail) names.push(tail);
    const cells = [prRef(hint.with), names.join("<br>")];
    if (withSource) cells.unshift(prRef(hint.pr));
    return row(cells);
  });
}

function notesSection(field, notes, omitted = 0) {
  if (notes.length === 0 && omitted === 0) return;
  const items = notes.map((note) => `- ${escapeText(note)}`);
  const tail = more(omitted, "note");
  if (tail) items.push(`- ${tail}`);
  field.rows(["**Notes**"], items, "note");
}

// --- The check --------------------------------------------------------------

function sameMemberCount(result) {
  return new Set(
    result.overlaps.filter((overlap) => overlap.kind === "same-member").map((o) => o.with),
  ).size;
}

function conclusionOf(result) {
  const neutral =
    !result.simulated ||
    result.conflictsWithBase ||
    result.conflicts.length > 0 ||
    result.trainBreak !== null ||
    sameMemberCount(result) > 0;
  return neutral ? CONCLUSION.neutral : CONCLUSION.success;
}

function titleOf(result) {
  if (!result.simulated) return "Not simulated";
  if (result.conflictsWithBase) return "Conflicts with the base branch";
  const conflicts = new Set(result.conflicts.map((conflict) => conflict.with)).size;
  if (conflicts > 0) return `Conflicts with ${plural(conflicts, "pull request")}`;
  if (result.trainBreak) return "Breaks the merge train";
  const overlaps = sameMemberCount(result);
  if (overlaps > 0) return `Member overlap with ${plural(overlaps, "pull request")}`;
  return "No conflicts";
}

function checkSummary(result, config) {
  const field = new Field(BUDGET - 1);
  if (!result.simulated) {
    field.text("This pull request was not simulated.");
  } else {
    field.text(`Predicted merge order: ${joinNumbers(result.order)}.`);
    if (result.conflictsWithBase) {
      field.text(
        "This pull request conflicts with the default branch, so it was not checked against the other pull requests.",
      );
    }
    conflictSections(field, result.conflicts, config);
    overlapSection(field, result.overlaps, config);
    const trainBreak = result.trainBreak;
    if (trainBreak?.multiWay) {
      const items = trainBreak.files.map(
        (file) => `- ${escapeText(file.path)} (${escapeText(file.class)})`,
      );
      const omitted = more(trainBreak.filesOmitted ?? 0, "file");
      if (omitted) items.push(`- ${omitted}`);
      field.rows(
        [
          `Merged after ${joinNumbers(trainBreak.train)} in the predicted order, this pull request ` +
            "conflicts with their combined result although it conflicts with none of them alone " +
            "(a multi-way conflict), in:",
        ],
        items,
        "file",
      );
    }
    if (
      !result.conflictsWithBase &&
      result.conflicts.length === 0 &&
      !trainBreak &&
      result.overlaps.length === 0
    ) {
      field.text("No conflicts with the default branch or with the other simulated pull requests.");
    }
  }
  notesSection(field, result.notes, result.notesOmitted ?? 0);
  return field.toString();
}

function checkText(result, embedded) {
  return withMarker((field) => {
    if (result.hints.length === 0) return;
    field.text("### Hints");
    field.text(HINT_CAVEAT);
    field.rows(tableHead(["Pull request", "Names"]), hintRows(result.hints, false), "row");
  }, embed(embedded));
}

// The check run for `result`: its `name`, `conclusion` and `title`, `summary`
// and `text` for its output. The result is reduced first; `text` ends with the
// embedded result. When the reduction left entries out of the embedded result,
// the rest of the check still counts and shows them, within its budget.
export function renderCheck(result, config) {
  const { shown, embedded } = resultParts(result);
  return {
    name: config.checkName,
    conclusion: conclusionOf(shown),
    title: titleOf(shown),
    summary: checkSummary(shown, config),
    text: checkText(shown, embedded),
  };
}

// --- The comment ------------------------------------------------------------

// The body of the sticky comment for `data`: findings plus `notified`. With no
// conflict left it is the resolved form. The data is reduced first; the body
// ends with the embedded data. When the reduction left rows out of the
// embedded data, the text still counts and shows them, within its budget.
export function renderComment(data, config) {
  const { shown, embedded } = commentParts(data);
  const marker = embed(embedded);
  if (shown.conflicts.length === 0) return `${RESOLVED_LINE}\n\n${marker}`;
  return withMarker((field) => {
    field.text(COMMENT_LINE);
    conflictSections(field, shown.conflicts, config);
  }, marker);
}

// --- The job summary --------------------------------------------------------

function uniquePairs(results, field) {
  const pairs = new Map();
  for (const result of results) {
    for (const entry of result[field]) {
      const id = `${pairId(result.pr, entry.with)}:${entry.kind ?? ""}`;
      if (!pairs.has(id)) pairs.set(id, { pr: result.pr, author: result.author, entry });
    }
  }
  return [...pairs.values()];
}

function matrixSection(field, simulated) {
  if (simulated.length < 2) return;
  const byNumber = new Map(simulated.map((result) => [result.pr, result]));
  const order = simulated[0].order.filter((number) => byNumber.has(number));
  field.text("### Pair matrix");
  const rows = order.map((number) => {
    const result = byNumber.get(number);
    const conflicting = new Set(result.conflicts.map((conflict) => conflict.with));
    const cells = order.map((other) => {
      if (other === number) return "";
      if (result.conflictsWithBase || byNumber.get(other).conflictsWithBase) return "-";
      return conflicting.has(other) ? "conflict" : "clean";
    });
    return row([prRef(number), ...cells]);
  });
  field.rows(tableHead(["", ...order.map(prRef)]), rows, "row");
}

function trainSection(field, simulated) {
  if (simulated.length === 0) return;
  const byNumber = new Map(simulated.map((result) => [result.pr, result]));
  const items = simulated[0].order
    .filter((number) => byNumber.has(number))
    .map((number) => {
      const result = byNumber.get(number);
      if (result.conflictsWithBase) {
        return `- ${prRef(number)}: conflicts with the default branch, not in the train`;
      }
      if (result.trainBreak) {
        const kind = result.trainBreak.multiWay ? ", a multi-way conflict" : "";
        return `- ${prRef(number)}: breaks the train after ${joinNumbers(result.trainBreak.train) || "the base"}${kind}`;
      }
      return `- ${prRef(number)}: merges`;
    });
  field.text("### Merge train");
  field.rows(["In the predicted order:"], items, "pull request");
}

// The job summary of a run over the complete `results`. `options.writes`
// (`{checks, comments}`) adds the number of writes the run made, or would make
// with `options.dryRun`.
export function renderJobSummary(results, config, options = {}) {
  const field = new Field(BUDGET - 1);
  const simulated = results.filter((result) => result.simulated);
  field.text("## PR conflict radar");
  if (simulated.length === 0) {
    field.text("No pull request was simulated.");
  } else {
    field.text(`Predicted merge order: ${joinNumbers(simulated[0].order)}.`);
  }

  const conflicts = uniquePairs(results, "conflicts");
  const sameAuthor = conflicts.filter(({ entry }) => entry.sameAuthor).length;
  field.text(
    `Conflicting pairs: ${conflicts.length - sameAuthor} between different authors, ` +
      `${sameAuthor} between pull requests of one author.`,
  );
  matrixSection(field, simulated);

  if (conflicts.length > 0) {
    field.text("### Conflicting pairs");
    const columns = ["Merges first", "Rebases", "Authors", "Class", "Files"];
    if (config.suggestPeerbus) columns.push("Pair key");
    const rows = conflicts.map(({ author, entry }) => {
      const authors = entry.sameAuthor
        ? `${authorCell(author)} (both)`
        : `${authorCell(author)}, ${authorCell(entry.withAuthor)}`;
      const cells = [
        prRef(entry.mergesFirst),
        prRef(entry.rebases),
        authors,
        escapeText(entry.class),
        filesCell(entry),
      ];
      if (config.suggestPeerbus) cells.push(escapeText(entry.key));
      return row(cells);
    });
    field.rows(tableHead(columns), rows, "row");
  }

  const baseConflicts = simulated.filter((result) => result.conflictsWithBase);
  if (baseConflicts.length > 0) {
    field.text("### Conflicts with the default branch");
    field.rows(
      [],
      baseConflicts.map((result) => `- ${prRef(result.pr)}`),
      "pull request",
    );
  }

  const overlaps = uniquePairs(results, "overlaps");
  if (overlaps.length > 0) {
    field.text("### Member overlaps");
    const columns = ["Pull requests", "Members"];
    if (config.suggestPeerbus) columns.push("Pair key");
    const rows = overlaps.map(({ pr, entry }) => {
      const cells = [
        `${prRef(pr)}, ${prRef(entry.with)}`,
        membersText(entry.members, entry.membersOmitted),
      ];
      if (config.suggestPeerbus) cells.push(escapeText(entry.key));
      return row(cells);
    });
    field.rows(tableHead(columns), rows, "row");
  }

  const hints = uniquePairs(results, "hints").map(({ pr, entry }) => ({ ...entry, pr }));
  if (hints.length > 0) {
    field.text("### Hints");
    field.text(HINT_CAVEAT);
    field.rows(tableHead(["Pull request", "Other", "Names"]), hintRows(hints, true), "row");
  }

  trainSection(field, simulated);

  const skipped = results.filter((result) => !result.simulated);
  if (skipped.length > 0) {
    field.text("### Not simulated");
    field.rows(
      [],
      skipped.map((result) => `- ${prRef(result.pr)}: ${escapeText(result.notes[0] ?? "")}`),
      "pull request",
    );
  }

  const degraded = results.filter((result) => result.degraded);
  if (degraded.length > 0) {
    field.text(`Degraded results: ${joinNumbers(degraded.map((result) => result.pr))}.`);
  }

  if (options.writes) {
    const { checks, comments } = options.writes;
    const verb = options.dryRun ? "A publish would make" : "Writes made:";
    field.text(
      `${verb} ${plural(Number(checks) || 0, "check write")} and ` +
        `${plural(Number(comments) || 0, "comment write")}.`,
    );
  }
  return field.toString();
}
