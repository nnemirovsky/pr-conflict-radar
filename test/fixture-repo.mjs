// Fixture repositories for tests: a bare "remote" repository whose commits are
// built with plumbing (no working tree, so any path git accepts works), plus
// clones of it.
//
// Every git call of the helper runs with an isolated config (no global or
// system file, so no hooks, signing or default-branch setting of the machine
// applies), a fixed identity and increasing fixed dates.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
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

  // Serves the remote over smart HTTP on a loopback port through `git
  // http-backend`. A request is served only when it carries exactly one
  // Authorization header and that header is in `accept`; one without the
  // header gets 401 with a Basic challenge, as GitHub answers for a private
  // repository, and one with two headers gets 400. Resolves to `{url, origin,
  // requests, close}`: `url` is the remote's address, and `requests` records
  // each request as `{method, path, authorization}` with every Authorization
  // header it carried.
  function serve({ accept = [] } = {}) {
    const requests = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const authorization = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === "authorization") {
            authorization.push(req.rawHeaders[i + 1]);
          }
        }
        const target = new URL(req.url, "http://127.0.0.1");
        requests.push({ method: req.method, path: target.pathname, authorization });
        if (authorization.length > 1) {
          res.writeHead(400);
          res.end();
          return;
        }
        if (authorization.length === 0 || !accept.includes(authorization[0])) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
          res.end();
          return;
        }
        const body = Buffer.concat(chunks);
        const child = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            ...BASE_ENV,
            GIT_PROJECT_ROOT: dir,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: target.pathname,
            QUERY_STRING: target.search.slice(1),
            REQUEST_METHOD: req.method,
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(body.length),
            HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
            HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
            REMOTE_ADDR: "127.0.0.1",
          },
          stdio: ["pipe", "pipe", "ignore"],
        });
        const out = [];
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.on("close", () => {
          const response = Buffer.concat(out);
          const end = response.indexOf("\r\n\r\n");
          let status = 200;
          const headers = {};
          for (const line of response.subarray(0, end).toString("latin1").split("\r\n")) {
            const colon = line.indexOf(":");
            const name = line.slice(0, colon);
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
            else headers[name] = value;
          }
          res.writeHead(status, headers);
          res.end(response.subarray(end + 4));
        });
        child.stdin.end(body);
      });
    });
    return new Promise((resolveServer) => {
      server.listen(0, "127.0.0.1", () => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        resolveServer({
          url: `${origin}/remote.git`,
          origin,
          requests,
          close: () =>
            new Promise((done) => {
              server.close(done);
              server.closeAllConnections();
            }),
        });
      });
    });
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
    serve,
    cleanup,
  };
}
