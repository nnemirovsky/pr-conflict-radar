// Git plumbing: commit verification, in-memory merges, merge commits, fetching
// commits by SHA into a private ref namespace and listing changed files.
//
// Every git call passes its arguments as an array to `spawn`, never through a
// shell, and captures stdout and stderr. A revision argument never starts with
// `-`, so no input can be read as an option. Errors carry a fixed message; the
// captured stderr is on the error's `stderr` property for the caller to log
// through the log serializer.

import { spawn } from "node:child_process";

export const MIN_GIT_VERSION = Object.freeze([2, 38]);
export const REF_NAMESPACE = "refs/pr-conflict-radar/";

// The identity and date of every commit `commitMerge` writes, so the same
// merge always yields the same commit.
export const MERGE_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "pr-conflict-radar",
  GIT_AUTHOR_EMAIL: "noreply@pr-conflict-radar.invalid",
  GIT_AUTHOR_DATE: "@946684800 +0000",
  GIT_COMMITTER_NAME: "pr-conflict-radar",
  GIT_COMMITTER_EMAIL: "noreply@pr-conflict-radar.invalid",
  GIT_COMMITTER_DATE: "@946684800 +0000",
});

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class GitError extends Error {
  constructor(message, { args = [], code = null, stderr = "" } = {}) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

// Runs git with `args` in `cwd` and resolves to `{code, stdout, stderr}`, with
// stdout as a Buffer. It rejects only when git cannot be started.
export function runGit(args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) =>
      reject(new GitError("git could not be started", { args, stderr: error.message })),
    );
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

// Runs git and resolves to its stdout as text with the trailing line break
// removed; any exit code other than 0 rejects.
async function git(args, options) {
  const result = await runGit(args, options);
  if (result.code !== 0) {
    throw new GitError(`git ${args[0]} exited with code ${result.code}`, {
      args,
      code: result.code,
      stderr: result.stderr,
    });
  }
  return result.stdout.toString("utf8").replace(/\n$/, "");
}

function assertRevision(rev) {
  if (typeof rev !== "string" || rev === "" || rev.startsWith("-") || rev.includes("\0")) {
    throw new GitError("invalid revision argument");
  }
}

function assertOid(oid) {
  if (typeof oid !== "string" || !OID.test(oid)) throw new GitError("invalid object id");
}

// Parses the output of `git --version` into `[major, minor, patch]`, or `null`.
export function parseGitVersion(text) {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

// Fails unless the installed git is 2.38 or newer, which `git merge-tree
// --write-tree` needs. Resolves to the version as `major.minor.patch`.
export async function assertGitVersion(options = {}) {
  const text = await git(["--version"], options);
  const version = parseGitVersion(text);
  const [major, minor] = MIN_GIT_VERSION;
  const required = `${major}.${minor}`;
  if (!version) throw new GitError(`pr-conflict-radar needs git ${required} or newer`);
  const found = version.join(".");
  if (version[0] < major || (version[0] === major && version[1] < minor)) {
    throw new GitError(`pr-conflict-radar needs git ${required} or newer; found git ${found}`);
  }
  return found;
}

// Resolves `rev` to the full SHA of a commit, or throws when it names no
// commit (a missing ref, an unknown SHA, a tree or a blob).
export async function verifyCommit(rev, options = {}) {
  assertRevision(rev);
  const result = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
    options,
  );
  const sha = result.stdout.toString("utf8").trim();
  if (result.code !== 0 || !OID.test(sha)) {
    throw new GitError("not a commit in this repository", {
      args: ["rev-parse"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  return sha;
}

// Reads the result of `git merge-tree --write-tree --name-only --no-messages
// -z`: exit 0 is clean; exit 1 is a conflict only when the first field is a
// tree OID, followed by each conflicted path; anything else is a tool failure.
export function parseMergeTree(code, stdout, stderr = "") {
  const fields = stdout.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const tree = fields[0];
  if ((code === 0 || code === 1) && tree !== undefined && OID.test(tree)) {
    if (code === 0) return { clean: true, tree, conflictedPaths: [] };
    return { clean: false, tree, conflictedPaths: [...new Set(fields.slice(1))] };
  }
  throw new GitError(`git merge-tree failed with code ${code}`, {
    args: ["merge-tree"],
    code,
    stderr,
  });
}

// Merges `theirs` into `ours` in memory and resolves to
// `{clean, tree, conflictedPaths}`. Writes objects, touches no ref.
export async function mergeTree(ours, theirs, options = {}) {
  assertRevision(ours);
  assertRevision(theirs);
  const result = await runGit(
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs],
    options,
  );
  return parseMergeTree(result.code, result.stdout, result.stderr);
}

// Turns a merged tree into a commit with parents `ours` and `theirs`, written
// with the fixed identity and never signed.
export async function commitMerge(tree, ours, theirs, options = {}) {
  assertOid(tree);
  assertRevision(ours);
  assertRevision(theirs);
  const args = [
    "commit-tree",
    "--no-gpg-sign",
    "-p",
    ours,
    "-p",
    theirs,
    "-m",
    "pr-conflict-radar merge",
    tree,
  ];
  return git(args, { ...options, env: { ...options.env, ...MERGE_IDENTITY } });
}

// Resolves to the best common ancestor of `a` and `b`, or to `null` when they
// have none (unrelated histories). Any other failure throws.
export async function findMergeBase(a, b, options = {}) {
  assertRevision(a);
  assertRevision(b);
  const args = ["merge-base", "--end-of-options", a, b];
  const result = await runGit(args, options);
  const sha = result.stdout.toString("utf8").trim();
  if (result.code === 1 && sha === "") return null;
  if (result.code !== 0) {
    throw new GitError(`git merge-base exited with code ${result.code}`, {
      args,
      code: result.code,
      stderr: result.stderr,
    });
  }
  if (!OID.test(sha)) throw new GitError("git merge-base returned no commit");
  return sha;
}

// Resolves to the best common ancestor of `a` and `b`; throws when they have
// none.
export async function mergeBase(a, b, options = {}) {
  const sha = await findMergeBase(a, b, options);
  if (sha === null) {
    throw new GitError("git merge-base found no common ancestor", {
      args: ["merge-base"],
      code: 1,
    });
  }
  return sha;
}

// Fetches `base` and each `heads[i].sha` by SHA from `remote` into
// `refs/pr-conflict-radar/base` and `refs/pr-conflict-radar/<pr>`, with full
// history: a shallow repository is unshallowed in the same fetch. No branch,
// remote-tracking ref, tag or FETCH_HEAD is written. Resolves to the refs.
export async function fetchCommits(remote, base, heads, options = {}) {
  assertRevision(remote);
  assertOid(base);
  const refs = { base: `${REF_NAMESPACE}base`, heads: {} };
  const specs = [`+${base}:${refs.base}`];
  for (const { pr, sha } of heads) {
    if (!Number.isSafeInteger(pr) || pr < 1) throw new GitError("invalid pull request number");
    assertOid(sha);
    refs.heads[pr] = `${REF_NAMESPACE}${pr}`;
    specs.push(`+${sha}:${refs.heads[pr]}`);
  }
  const shallow = await git(["rev-parse", "--is-shallow-repository"], options);
  const args = [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
  ];
  if (shallow === "true") args.push("--unshallow");
  args.push("--end-of-options", remote, ...specs);
  const result = await runGit(args, options);
  if (result.code !== 0) {
    const named = new Set(result.stderr.match(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g) ?? []);
    const missing = heads.filter(({ sha }) => named.has(sha)).map(({ pr }) => pr);
    let message = "git fetch failed to fetch the listed commits";
    if (named.has(base)) message = "the remote does not serve the base commit";
    else if (missing.length > 0) {
      const list = missing.map((pr) => `#${pr}`).join(", ");
      message = `the remote does not serve the head commit of pull request ${list}`;
    }
    const error = new GitError(message, { args, code: result.code, stderr: result.stderr });
    error.missing = missing;
    throw error;
  }
  return refs;
}

// Deletes every ref under `refs/pr-conflict-radar/` and resolves to their
// number.
export async function deleteRefs(options = {}) {
  const listed = await git(["for-each-ref", "--format=%(refname)", REF_NAMESPACE], options);
  const refs = listed === "" ? [] : listed.split("\n");
  if (refs.length === 0) return 0;
  const input = refs.map((ref) => `delete ${ref}\n`).join("");
  const result = await runGit(["update-ref", "--stdin"], { ...options, input });
  if (result.code !== 0) {
    throw new GitError(`git update-ref exited with code ${result.code}`, {
      args: ["update-ref"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  return refs.length;
}

// Parses `git diff --raw -z` output into one entry per file:
// `{status, score, path, previousPath, oldMode, newMode, oldBlob, newBlob}`.
// `previousPath` is the source path of a rename or copy and `null` otherwise.
export function parseRawDiff(stdout) {
  const fields = stdout.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files = [];
  let i = 0;
  while (i < fields.length) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(fields[i]);
    if (!match) throw new GitError("unexpected git diff --raw output");
    const [, oldMode, newMode, oldBlob, newBlob, status, score] = match;
    const twoPaths = status === "R" || status === "C";
    const count = twoPaths ? 2 : 1;
    if (i + count >= fields.length) throw new GitError("unexpected git diff --raw output");
    files.push({
      status,
      score: score === "" ? null : Number(score),
      path: fields[i + count],
      previousPath: twoPaths ? fields[i + 1] : null,
      oldMode,
      newMode,
      oldBlob,
      newBlob,
    });
    i += count + 1;
  }
  return files;
}

// Lists the files changed between `base` and `head` with rename detection.
// Paths come from NUL-separated records that git never quotes, so each is
// returned exactly as stored; no diff setting of the checkout applies.
export async function changedFiles(base, head, options = {}) {
  assertRevision(base);
  assertRevision(head);
  const args = [
    "diff",
    "--raw",
    "-z",
    "-M",
    "--no-abbrev",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--end-of-options",
    base,
    head,
    "--",
  ];
  const result = await runGit(args, options);
  if (result.code !== 0) {
    throw new GitError(`git diff exited with code ${result.code}`, {
      args: ["diff"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  return parseRawDiff(result.stdout);
}

const ZERO_OID = /^0+$/;

// Parses the hunk headers of a `-U0` diff into `{old, new}`, each a list of
// `{start, end}` line ranges (1-based, inclusive). A hunk that removes no line
// adds no old range and one that adds no line adds no new range. Only lines
// that start with `@@ ` are read; with no context lines, content lines start
// with `+`, `-` or `\`, so none can be mistaken for a header, and the text
// after the closing `@@` is ignored.
export function parseHunkRanges(stdout) {
  const ranges = { old: [], new: [] };
  for (const line of stdout.toString("utf8").split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (oldCount > 0) {
      const start = Number(match[1]);
      ranges.old.push({ start, end: start + oldCount - 1 });
    }
    if (newCount > 0) {
      const start = Number(match[3]);
      ranges.new.push({ start, end: start + newCount - 1 });
    }
  }
  return ranges;
}

function isAbsentBlob(blob) {
  return blob === null || blob === undefined || ZERO_OID.test(blob);
}

async function wholeFileRange(blob, options) {
  assertOid(blob);
  const result = await runGit(["cat-file", "blob", blob], options);
  if (result.code !== 0) {
    throw new GitError(`git cat-file exited with code ${result.code}`, {
      args: ["cat-file"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  const text = result.stdout;
  let lines = 0;
  for (const byte of text) if (byte === 0x0a) lines += 1;
  if (text.length > 0 && text.at(-1) !== 0x0a) lines += 1;
  return lines === 0 ? [] : [{ start: 1, end: lines }];
}

// Resolves to the changed line ranges between two blobs as `{old, new}`: the
// ranges of the old blob that were removed or rewritten and the ranges of the
// new blob that were added or rewritten. A missing old blob (`null` or the
// all-zero id of an added file) makes the new range the whole new blob; a
// missing new blob makes the old range the whole old blob. Only the hunk
// headers of the blob diff are read, so no path is parsed out of patch text and
// no `.gitattributes`, diff or color setting of the checkout applies.
export async function changedRanges(oldBlob, newBlob, options = {}) {
  const oldAbsent = isAbsentBlob(oldBlob);
  const newAbsent = isAbsentBlob(newBlob);
  if (oldAbsent && newAbsent) return { old: [], new: [] };
  if (oldAbsent) return { old: [], new: await wholeFileRange(newBlob, options) };
  if (newAbsent) return { old: await wholeFileRange(oldBlob, options), new: [] };
  assertOid(oldBlob);
  assertOid(newBlob);
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "-U0",
    "--end-of-options",
    oldBlob,
    newBlob,
  ];
  const result = await runGit(args, options);
  if (result.code !== 0 && result.code !== 1) {
    throw new GitError(`git diff exited with code ${result.code}`, {
      args: ["diff"],
      code: result.code,
      stderr: result.stderr,
    });
  }
  return parseHunkRanges(result.stdout);
}
