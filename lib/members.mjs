// Member-mapper plumbing shared by the CLI: which mappers a run needs, how a
// mapper's build is run, how the mappers are run over the changed files of the
// simulated pull requests, and the two overlap signals read from their output.
//
// A registry entry may carry `build(context)`, which returns the steps that
// prepare its mapper as `[{command, args, cwd, env}]`. `context` is
// `{dir, work, env}`: the mapper's directory, the work directory and the
// inherited environment. A step's `env`, when present, is the complete
// environment of that command; otherwise the inherited one applies. Steps run
// one after another, as argument arrays, never through a shell.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry as defaultRegistry } from "../members/registry.mjs";
import { matchesAny } from "./classify.mjs";
import { changedFiles, changedRanges, GitError, mergeBase, runGit } from "./git.mjs";

// The directory that holds `lib/`, `members/` and `action.yml`.
export const ACTION_DIR = fileURLToPath(new URL("..", import.meta.url));

// Each captured stream is cut to this many characters in a build's report.
const OUTPUT_LIMIT = 20000;

export class BuildError extends Error {
  constructor(message, { key, output = [] } = {}) {
    super(message);
    this.name = "BuildError";
    this.key = key;
    this.output = output;
  }
}

// Which mappers a run needs, as `{<key>: boolean}` in registry order. An entry
// is needed when its `enabled` is `true`, never when it is `false`, and when
// it is `"auto"` if a path of `changedFiles` (the changed files of the
// simulated pull requests, as path strings) matches its `patterns`.
export function mappersNeeded(config, changedFiles, { registry = defaultRegistry } = {}) {
  const needed = {};
  for (const entry of registry) {
    const member = config.members[entry.key];
    if (member.enabled === true) needed[entry.key] = true;
    else if (member.enabled === false) needed[entry.key] = false;
    else needed[entry.key] = changedFiles.some((path) => matchesAny(path, member.patterns));
  }
  return needed;
}

// The mapper directory of `entry` inside the action, or inside `root`.
export function mapperDir(entry, root = ACTION_DIR) {
  return join(root, "members", entry.key);
}

function runStep(step, baseEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args ?? [], {
      cwd: step.cwd,
      env: step.env ?? baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        command: step.command,
        args: step.args ?? [],
        code,
        stdout: Buffer.concat(out).toString("utf8").slice(0, OUTPUT_LIMIT),
        stderr: Buffer.concat(err).toString("utf8").slice(0, OUTPUT_LIMIT),
      }),
    );
  });
}

// Runs the build of `entry` and resolves to the captured report of each step,
// `[{command, args, code, stdout, stderr}]`. Throws a `BuildError` when the
// entry has no build, when a command is missing (the message names it), when
// a command cannot start for another reason (the message names the error
// code, and the step's report carries the OS error as `startError`) and when a
// step exits non-zero; `output` holds the report so far.
export async function runBuild(entry, { dir = mapperDir(entry), work, env = process.env } = {}) {
  if (typeof entry.build !== "function") {
    throw new BuildError(`the ${entry.key} member mapper has no build yet`, { key: entry.key });
  }
  const output = [];
  for (const step of entry.build({ dir, work, env })) {
    let report;
    try {
      report = await runStep(step, env);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new BuildError(
          `the ${entry.key} member mapper needs ${step.command}, which was not found; install it`,
          { key: entry.key, output },
        );
      }
      const code = typeof error?.code === "string" ? error.code : "an unknown error";
      output.push({
        command: step.command,
        args: step.args ?? [],
        code: null,
        stdout: "",
        stderr: "",
        startError: { code: error?.code ?? null, message: String(error?.message ?? error) },
      });
      throw new BuildError(
        `the ${entry.key} member mapper build could not start ${step.command} (${code})`,
        { key: entry.key, output },
      );
    }
    output.push(report);
    if (report.code !== 0) {
      throw new BuildError(
        `the ${entry.key} member mapper build failed: ${step.command} exited with code ${report.code}`,
        { key: entry.key, output },
      );
    }
  }
  return output;
}

// --- Mapping ----------------------------------------------------------------

// A mapper run that takes longer than this is stopped and counts as a mapper
// failure.
export const MAPPER_TIMEOUT_MS = 120_000;

// A response longer than this is not read, and the run counts as a mapper
// failure.
const RESPONSE_LIMIT = 256 * 1024 * 1024;

// An entry error is cut to this many characters in a note.
const ENTRY_ERROR_LIMIT = 200;

// The head side reads the blob at the pull request's head (changed members and
// identifiers on added lines); the base side reads the blob at its merge base
// (declarations changed or removed).
const SIDES = Object.freeze(["head", "base"]);

const REGULAR_FILE = /^100(?:644|755)$/;
const ZERO_OID = /^0+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function cut(text, limit) {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}...` : text;
}

function addNote(data, pr, note) {
  if (!data.notes[pr].includes(note)) data.notes[pr].push(note);
}

// Starts `command` (`{command, args, cwd, env}`) and resolves to
// `{code, signal, timedOut, tooLong, stdout, stderr}`, or to `{startError}`
// when it cannot be started. A run over `timeoutMs` is killed together with
// the processes it started.
function runMapper(command, timeoutMs) {
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    const group = process.platform !== "win32";
    let child;
    try {
      child = spawn(command.command, command.args ?? [], {
        cwd: command.cwd,
        env: command.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: group,
      });
    } catch (error) {
      finish({ startError: error });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let tooLong = false;
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        if (group) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > RESPONSE_LIMIT) {
        if (!tooLong) stop();
        tooLong = true;
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes >= OUTPUT_LIMIT) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ startError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({
        code,
        signal,
        timedOut,
        tooLong,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

// The entries of a mapper's response by id, or `null` when the response is not
// a JSON array of `{id, members, identifiers}` and `{id, error}` entries for
// the ids of the request.
function readResponse(stdout, ids) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const byId = new Map();
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.id !== "string" || !ids.has(entry.id)) return null;
    if (byId.has(entry.id)) return null;
    if (typeof entry.error === "string") {
      byId.set(entry.id, { error: entry.error });
      continue;
    }
    if (!Array.isArray(entry.members) || !Array.isArray(entry.identifiers)) return null;
    const members = [];
    for (const member of entry.members) {
      if (
        !isObject(member) ||
        typeof member.name !== "string" ||
        typeof member.kind !== "string" ||
        typeof member.declarationTouched !== "boolean"
      ) {
        return null;
      }
      members.push({
        name: member.name,
        kind: member.kind,
        declarationTouched: member.declarationTouched,
      });
    }
    if (!entry.identifiers.every((name) => typeof name === "string")) return null;
    byId.set(entry.id, { members, identifiers: [...entry.identifiers] });
  }
  return byId;
}

// Why a finished run counts as a mapper failure, or `null` when it does not.
function failureOf(key, outcome, byId) {
  if (outcome.startError) {
    const code = outcome.startError.code;
    if (code === "ENOENT") {
      return `the ${key} member mapper could not be started: its command was not found`;
    }
    return `the ${key} member mapper could not be started (${typeof code === "string" ? code : "an unknown error"})`;
  }
  if (outcome.timedOut) {
    return `the ${key} member mapper took longer than the time limit and was stopped`;
  }
  if (outcome.tooLong) return `the ${key} member mapper wrote a response over the size limit`;
  if (outcome.code !== 0) {
    return outcome.code === null
      ? `the ${key} member mapper was ended by signal ${outcome.signal}`
      : `the ${key} member mapper exited with code ${outcome.code}`;
  }
  if (byId === null) return `the ${key} member mapper wrote no valid response`;
  return null;
}

async function blobSizes(oids, git) {
  const sizes = new Map();
  if (oids.length === 0) return sizes;
  const result = await runGit(["cat-file", "--batch-check"], {
    ...git,
    input: `${oids.join("\n")}\n`,
  });
  if (result.code !== 0) {
    throw new GitError(`git cat-file exited with code ${result.code}`, {
      args: ["cat-file"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (match) sizes.set(match[1], Number(match[2]));
  }
  for (const oid of oids) {
    if (!sizes.has(oid)) throw new GitError("git cat-file found no blob for a changed file");
  }
  return sizes;
}

async function writeBlob(oid, file, git) {
  const result = await runGit(["cat-file", "blob", oid], git);
  if (result.code !== 0) {
    throw new GitError(`git cat-file exited with code ${result.code}`, {
      args: ["cat-file"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  writeFileSync(file, result.stdout, { mode: 0o600 });
}

// The registry entry whose patterns `path` matches first, in registry order.
function entryFor(path, registry, config) {
  return registry.find((entry) => matchesAny(path, config.members[entry.key].patterns)) ?? null;
}

// Maps the changed lines of each pull request of `pulls` to members.
//
// Each changed file goes to the mapper whose patterns it matches first in
// registry order, when `needed` names that mapper. A mapper starts at most
// twice: one request for the head side of every pull request and one for the
// base side, the blobs at each pull request's merge base with `base`. A blob
// over `members.maxFileBytes` is not sent. The mapper of a key is `mappers[key]`
// when given, otherwise the registry entry's `run`; an entry with neither is
// skipped. `unavailable` maps a key to the message of a build that failed:
// that mapper is not started and counts as failed.
//
// Resolves to `{changes, notes, degraded, failures}`:
// - `changes[pr]`: `[{path, side, members, identifiers}]`, one per mapped file
//   and side, `members` as `{name, kind, declarationTouched}`;
// - `notes[pr]`: the files left out (too large, or an entry error);
// - `degraded`: the pull requests a failed mapper had files of, in number
//   order; nothing a failed mapper returned is kept;
// - `failures`: per failed mapper `{mapper, side, message, command, args, code,
//   signal, stdout, stderr}`, its captured output cut to a limit, plus
//   `startError` (`{code, message}`, the OS error) when it could not start.
//
// Request files and blobs go to a directory of `work` that is removed at the
// end. `git` holds the git `cwd` and `env`; `env` is the mappers' environment.
export async function mapMembers({
  base,
  pulls,
  config,
  needed,
  registry = defaultRegistry,
  mappers = {},
  unavailable = {},
  work,
  env = process.env,
  git = {},
  timeoutMs = MAPPER_TIMEOUT_MS,
}) {
  const data = { changes: {}, notes: {}, degraded: [], failures: [] };
  const runOf = (entry) => mappers[entry.key] ?? entry.run;
  const active = new Set(
    registry
      .filter(
        (entry) =>
          needed[entry.key] === true &&
          (typeof runOf(entry) === "function" || Object.hasOwn(unavailable, entry.key)),
      )
      .map((entry) => entry.key),
  );
  const maxFileBytes = config.members.maxFileBytes;
  if (active.size === 0) {
    for (const pull of pulls) {
      data.changes[pull.number] = [];
      data.notes[pull.number] = [];
    }
    return data;
  }

  // What each mapper is asked: `{pr, side, key, path, blob, ranges}`.
  const items = [];
  for (const pull of pulls) {
    data.changes[pull.number] = [];
    data.notes[pull.number] = [];
    const ancestor = await mergeBase(base.sha, pull.headRefOid, git);
    for (const file of await changedFiles(ancestor, pull.headRefOid, git)) {
      const sides = {
        head: { path: file.path, blob: file.newBlob, mode: file.newMode },
        base: { path: file.previousPath ?? file.path, blob: file.oldBlob, mode: file.oldMode },
      };
      const wanted = [];
      for (const side of SIDES) {
        const { path, blob, mode } = sides[side];
        if (ZERO_OID.test(blob) || !REGULAR_FILE.test(mode)) continue;
        const entry = entryFor(path, registry, config);
        if (entry === null || !active.has(entry.key)) continue;
        wanted.push({ pr: pull.number, side, key: entry.key, path, blob });
      }
      if (wanted.length === 0) continue;
      const regular = (side) => (REGULAR_FILE.test(sides[side].mode) ? sides[side].blob : null);
      const ranges = await changedRanges(regular("base"), regular("head"), git);
      for (const item of wanted) {
        const lines = item.side === "head" ? ranges.new : ranges.old;
        if (lines.length > 0) items.push({ ...item, ranges: lines });
      }
    }
  }

  const sizes = await blobSizes([...new Set(items.map((item) => item.blob))], git);
  const sendable = [];
  for (const item of items) {
    if (sizes.get(item.blob) > maxFileBytes) {
      addNote(
        data,
        item.pr,
        `The members of ${item.path} were not mapped: the file is larger than ${maxFileBytes} bytes.`,
      );
    } else {
      sendable.push(item);
    }
  }

  const workDir = resolve(work);
  const temp = mkdtempSync(join(workDir, "members-"));
  try {
    const files = new Map();
    for (const blob of new Set(sendable.map((item) => item.blob))) {
      const file = join(temp, `blob-${files.size + 1}`);
      await writeBlob(blob, file, git);
      files.set(blob, file);
    }

    for (const entry of registry) {
      if (!active.has(entry.key)) continue;
      const key = entry.key;
      const own = sendable.filter((item) => item.key === key);
      const failed = (failure) => {
        data.failures.push({ mapper: key, ...failure });
        for (const item of own) {
          if (!data.degraded.includes(item.pr)) data.degraded.push(item.pr);
          addNote(data, item.pr, `Member overlap is incomplete: the ${key} member mapper failed.`);
        }
      };
      if (Object.hasOwn(unavailable, key)) {
        failed({ side: null, message: String(unavailable[key]) });
        continue;
      }
      let defines;
      if (Array.isArray(config.members[key].defines)) {
        defines = join(temp, `defines-${key}.json`);
        writeFileSync(defines, JSON.stringify(config.members[key].defines), { mode: 0o600 });
      }
      const kept = [];
      let failure = null;
      for (const side of SIDES) {
        const request = own.filter((item) => item.side === side);
        if (request.length === 0) continue;
        const ids = new Map(request.map((item, i) => [String(i + 1), item]));
        const requestFile = join(temp, `request-${key}-${side}.json`);
        writeFileSync(
          requestFile,
          JSON.stringify(
            [...ids].map(([id, item]) => ({
              id,
              path: item.path,
              file: files.get(item.blob),
              ranges: item.ranges,
            })),
          ),
          { mode: 0o600 },
        );
        const command = runOf(entry)({
          dir: mapperDir(entry),
          work: workDir,
          env,
          request: requestFile,
          maxFileBytes,
          ...(defines === undefined ? {} : { defines }),
        });
        const outcome = await runMapper(command, timeoutMs);
        const byId = outcome.startError ? null : readResponse(outcome.stdout, new Set(ids.keys()));
        const message = failureOf(key, outcome, byId);
        if (message !== null) {
          failure = {
            side,
            message,
            command: command.command,
            args: command.args ?? [],
            code: outcome.code ?? null,
            signal: outcome.signal ?? null,
            stdout: (outcome.stdout ?? "").slice(0, OUTPUT_LIMIT),
            stderr: (outcome.stderr ?? "").slice(0, OUTPUT_LIMIT),
            ...(outcome.startError
              ? {
                  startError: {
                    code: outcome.startError.code ?? null,
                    message: String(outcome.startError.message ?? outcome.startError),
                  },
                }
              : {}),
          };
          break;
        }
        for (const [id, item] of ids) {
          const answer = byId.get(id);
          if (answer === undefined || answer.error !== undefined) {
            const reason =
              answer === undefined ? "the mapper returned nothing for it" : answer.error;
            addNote(
              data,
              item.pr,
              `The members of ${item.path} were not mapped: ${cut(reason, ENTRY_ERROR_LIMIT)}`,
            );
            continue;
          }
          kept.push({ pr: item.pr, path: item.path, side, ...answer });
        }
      }
      if (failure !== null) {
        failed(failure);
        continue;
      }
      for (const { pr, ...change } of kept) data.changes[pr].push(change);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  data.degraded.sort((a, b) => a - b);
  return data;
}

// --- Signals ----------------------------------------------------------------

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

// The last part of a qualified member name (`cart.Cart.Add` gives `Add`,
// `<Cart as Total>::total` gives `total`), or `null` when that part is not a
// plain identifier (`operator +`, `this[]`, `~Widget`).
export function simpleName(name) {
  const last = name.split(/::|\./).at(-1);
  return IDENTIFIER.test(last) ? last : null;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// `[{path, name}]` without duplicates, in path and name order.
function uniqueNames(list) {
  const seen = new Map();
  for (const item of list) seen.set(`${item.path}\0${item.name}`, item);
  return [...seen.values()]
    .map(({ path, name }) => ({ path, name }))
    .sort((a, b) => compare(a.path, b.path) || compare(a.name, b.name));
}

function* membersOf(changes) {
  for (const change of changes) {
    for (const member of change.members) yield { path: change.path, side: change.side, ...member };
  }
}

// Members of kind `macro` (a macro-shaped declaration the C and C++ mapper
// reports) count in neither signal.
const signalling = (member) => member.kind !== "macro";

// Names whose declaration `from` touched or removed and that appear among the
// identifiers on the added lines of `to`, except names `to` declares there,
// ignored names and names shorter than `minNameLength`.
function changedAndUsed(from, to, config) {
  const ignored = new Set(config.members.ignoreNames);
  const used = new Set();
  const declared = new Set();
  for (const change of to) {
    if (change.side !== "head") continue;
    for (const name of change.identifiers) used.add(name);
    for (const member of change.members) {
      const name = member.declarationTouched ? simpleName(member.name) : null;
      if (name !== null) declared.add(name);
    }
  }
  const names = [];
  for (const member of membersOf(from)) {
    if (!member.declarationTouched || !signalling(member)) continue;
    const name = simpleName(member.name);
    if (name === null || ignored.has(name) || [...name].length < config.members.minNameLength) {
      continue;
    }
    if (used.has(name) && !declared.has(name)) names.push(member);
  }
  return names;
}

// The two overlap signals of a pair from the `changes` of its pull requests:
// `sameMember`, the members (`path` and qualified name) both changed, and
// `changedAndUsed`, the declarations one touched or removed whose name the
// other uses on its added lines, in both directions. Both are `[{path, name}]`
// in path and name order.
export function memberSignals(changesA = [], changesB = [], config) {
  const keys = (changes) => {
    const map = new Map();
    for (const member of membersOf(changes)) {
      if (signalling(member)) map.set(`${member.path}\0${member.name}`, member);
    }
    return map;
  };
  const a = keys(changesA);
  const b = keys(changesB);
  const sameMember = uniqueNames([...a].filter(([key]) => b.has(key)).map(([, member]) => member));
  const hints = uniqueNames([
    ...changedAndUsed(changesA, changesB, config),
    ...changedAndUsed(changesB, changesA, config),
  ]);
  return { sameMember, changedAndUsed: hints };
}

// The names of the members either pull request changed in `path`, in order and
// without duplicates.
export function fileMembers(changesA = [], changesB = [], path) {
  const names = new Set();
  for (const member of [...membersOf(changesA), ...membersOf(changesB)]) {
    if (member.path === path) names.add(member.name);
  }
  return [...names].sort(compare);
}
