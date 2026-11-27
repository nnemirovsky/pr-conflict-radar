// Fixture repositories for tests: a bare "remote" repository whose commits are
// built with plumbing (no working tree, so any path git accepts works), plus
// clones of it.
//
// Every git call of the helper runs with an isolated config (no global or
// system file, so no hooks, signing or default-branch setting of the machine
// applies), a fixed identity and increasing fixed dates.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_ENV = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "author@example.invalid",
};

// Creates a fixture. `defaultBranch` names the remote's default branch.
export function createFixture({ defaultBranch = "main" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-conflict-radar-git-"));
  const remote = join(dir, "remote.git");
  const url = pathToFileURL(remote).href;
  let clock = 1_000_000_000;
  let indexCount = 0;
  let cloneCount = 0;

  // Runs git and returns stdout with the trailing line break removed.
  function git(args, { cwd = remote, env = {}, input } = {}) {
    const stdout = execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...BASE_ENV, ...env },
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return stdout.toString("utf8").replace(/\n$/, "");
  }

  function resolve(rev) {
    try {
      return git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
    } catch {
      return null;
    }
  }

  git(["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`, remote], { cwd: dir });

  // Writes a commit and returns its SHA. `files` maps a path to its new
  // content, or to `null` to delete it. `parent` is a revision, or `null` for
  // a root commit; without it the commit goes on top of `branch` when that
  // exists, else on top of the default branch when that exists. `branch`,
  // when given, is moved to the new commit; without it no ref points at it.
  function commit({ files = {}, parent, branch, message = "fixture commit" } = {}) {
    let parentSha = null;
    if (parent === undefined) {
      parentSha =
        (branch && resolve(`refs/heads/${branch}`)) || resolve(`refs/heads/${defaultBranch}`);
    } else if (parent !== null) {
      parentSha = resolve(parent);
      if (!parentSha) throw new Error(`fixture: unknown parent ${parent}`);
    }
    indexCount += 1;
    const env = { GIT_INDEX_FILE: join(dir, `index-${indexCount}`) };
    if (parentSha) git(["read-tree", parentSha], { env });
    // `--index-info -z` takes NUL-terminated `<mode> <oid>\t<path>` records;
    // mode 0 removes the path. It needs no working tree.
    const records = Object.entries(files).map(([path, content]) => {
      if (content === null) return `0 ${"0".repeat(40)}\t${path}\0`;
      const blob = git(["hash-object", "-w", "--stdin"], { input: content });
      return `100644 ${blob}\t${path}\0`;
    });
    if (records.length > 0) {
      git(["update-index", "-z", "--index-info"], { env, input: records.join("") });
    }
    const tree = git(["write-tree"], { env });
    rmSync(env.GIT_INDEX_FILE, { force: true });
    clock += 60;
    const date = `@${clock} +0000`;
    const args = ["commit-tree", "-m", message];
    if (parentSha) args.push("-p", parentSha);
    args.push(tree);
    const sha = git(args, { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (branch) git(["update-ref", `refs/heads/${branch}`, sha]);
    return sha;
  }

  // Points `refs/pull/<n>/head` on the remote at `sha`, as GitHub does for a
  // pull request head; no branch points at it.
  function publishPull(n, sha) {
    git(["update-ref", `refs/pull/${n}/head`, sha]);
  }

  function tag(name, sha) {
    git(["tag", name, sha]);
  }

  // Clones the remote without a checkout and returns the clone's directory;
  // `shallow` makes a clone of depth 1.
  function clone({ shallow = false } = {}) {
    cloneCount += 1;
    const target = join(dir, `clone-${cloneCount}`);
    const args = ["clone", "--quiet", "--no-checkout"];
    if (shallow) args.push("--depth", "1");
    args.push(url, target);
    git(args, { cwd: dir });
    return target;
  }

  // Lists every ref of the repository at `cwd` as `refname objectname` lines.
  function refs(cwd = remote) {
    const out = git(["for-each-ref", "--format=%(refname) %(objectname)"], { cwd });
    return out === "" ? [] : out.split("\n");
  }

  function cleanup() {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    dir,
    remote,
    url,
    defaultBranch,
    git,
    resolve,
    commit,
    publishPull,
    tag,
    clone,
    refs,
    cleanup,
  };
}
