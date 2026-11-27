# pr-conflict-radar

A GitHub Action that finds conflicts between open pull requests before they merge.

GitHub tells you when a pull request conflicts with its base branch. It does not tell you that two open pull requests will conflict with each other once the first one merges. `pr-conflict-radar` simulates that ahead of time and reports it on both pull requests, for the people who own them and for the coding agents working on them.

> **Status:** early development. Nothing is released yet, and the interface described here can still change.

## What it does

- **Pairwise simulation.** For every pair of open pull requests, it merges the first into the base branch in memory and then merges the second onto the result, using `git merge-tree`. Nothing is checked out and no pull request code is executed.
- **Merge-train simulation.** It predicts the merge order and merges the whole train, which catches conflicts that only appear with three or more pull requests.
- **Member overlap.** For pairs that merge cleanly, it reports when both pull requests changed the same member (a function, method, property, type or field), and hints when one changed a declaration the other newly uses. It parses Go, JavaScript and TypeScript (JSX and TSX included), C#, Rust and C/C++ with each language's own parser, syntax only, with no build. Every language is optional.
- **A result on every affected pull request.** A check run that never fails, one comment per pull request for conflicts worth a notification, and the same result as JSON for tools and agents.
- **Deterministic.** No AI is involved in detection, and every run recomputes everything from the current state of the repository.

## What it does not do

- It never blocks a merge. The check is `neutral` when it finds something and `success` otherwise.
- It does not build or test the merged code, so it cannot prove that two pull requests work together.
- It does not resolve conflicts. It names who merges first and who rebases, and leaves the work to the owners.

## Quick start

Copy two workflow files into `.github/workflows/` of your repository. Pin the action by the full commit SHA of a release.

The trigger reacts to pull request events and does one thing: it starts the scan workflow on the default branch.

```yaml
name: pr-conflict-radar-trigger
on:
  pull_request_target:
    types:
      [
        opened,
        synchronize,
        reopened,
        edited,
        labeled,
        unlabeled,
        ready_for_review,
        converted_to_draft,
        closed,
      ]
  pull_request_review:
    types: [submitted, dismissed]
permissions:
  contents: read
concurrency:
  group: pr-conflict-radar-trigger-${{ github.event.pull_request.number }}
  cancel-in-progress: false
  queue: max
jobs:
  dispatch:
    name: dispatch
    if: github.event_name == 'pull_request_target' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: write
    steps:
      - continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
        run: gh workflow run pr-conflict-radar.yml --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"
```

The scan workflow runs the action. It starts on a dispatch from the trigger, on a push to the default branch, and once an hour as a safety net. If your default branch is not `main`, change `branches: [main]`.

```yaml
name: pr-conflict-radar
on:
  workflow_dispatch:
    inputs:
      force:
        type: boolean
        default: false
      dry-run:
        type: boolean
        default: false
  push:
    branches: [main]
  schedule:
    - cron: "23 * * * *"
permissions:
  contents: read
concurrency:
  group: pr-conflict-radar-${{ github.ref }}-${{ inputs.dry-run && 'dry-run' || 'publish' }}
  cancel-in-progress: false
jobs:
  scan:
    name: scan
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      checks: write
      pull-requests: write
      statuses: read
    steps:
      - uses: actions/checkout@v7
      - uses: nnemirovsky/pr-conflict-radar@<commit SHA>
        with:
          force: ${{ inputs.force || false }}
          dry-run: ${{ inputs.dry-run || (github.event_name == 'workflow_dispatch' && github.ref_name != github.event.repository.default_branch) }}
```

Both files only take effect once they are on the default branch, because GitHub runs a `workflow_dispatch` workflow only from there. The same two files are in [`examples/`](examples), and this repository runs them on itself.

Permissions:

| Workflow | Permission | Why |
| --- | --- | --- |
| trigger | `actions: write` | to start the scan workflow |
| scan | `checks: write` | to create the check runs. The workflow token and a GitHub App installation token can; a personal access token cannot |
| scan | `pull-requests: write` | to create, edit and delete the sticky comment |
| scan | `statuses: read` | to read the check runs from the status rollup of each head commit |
| scan | `contents: read` | to read the repository |

The runner needs Node.js 20 or newer and git 2.38 or newer. GitHub-hosted runners have both. The action checks them and fails with a message if they are missing.

**Never make the radar's check a required check.** It is `neutral` on a finding on purpose. It is also a snapshot of a moving state: a result can be stale for a minute after a push. Making it required would turn a hint into a blocker.

### The inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Token for the GitHub API. It has to be able to create check runs |
| `config` | `.github/pr-conflict-radar.json` | Path of the optional config file, relative to the workspace |
| `dry-run` | `false` | Print the results and the writes a publish would make, and publish nothing |
| `force` | `false` | Scan even when the published results already record the current state |

The action has one output, `changed`: whether anything changed since the last scan, so that a scan ran.

### Dry run

`dry-run` reads the open pull requests, simulates them and prints what it would publish. It writes nothing to GitHub and leaves the branches and tags of the clone as they were. Locally:

```sh
GH_TOKEN=$(gh auth token) node pr-conflict-radar.mjs --dry-run
```

## How a scan is triggered

The scan is not attached to pull request heads. A workflow run started by a pull request event is recorded on that pull request's head commit, so a scan that failed because of a tool problem would show up as a red check on somebody's pull request. The design avoids that:

1. The trigger runs on `pull_request_target` and `pull_request_review`. Its single job lasts seconds and dispatches the scan workflow on the default branch. A failed dispatch is `continue-on-error`, so a pull request never carries a red radar job.
2. The scan runs on `workflow_dispatch`, on a push to the default branch and on the hourly schedule. It always runs the default branch's copy of the workflow and the config. A pull request that edits the workflow, the config or this action runs none of its own version in the scan.
3. Results arrive about a minute after a push. A tool failure is a red run on the default branch, never on a pull request.

`pull_request_target` runs for pull requests that conflict with their base and for pull requests from forks. `pull_request_review` runs in the context of the pull request, so the trigger skips fork pull requests there. A review on a fork pull request, or on a pull request in conflict with its base, waits for the next event or the schedule.

The scan starts with a probe. When the published results already record the current state of the repository, the run ends there, green, in seconds. The state covers the base commit, each pull request's head commit, the draft flag, the review decision and the labels named in `order.labelPriority`. A comment or a title edit changes none of them. Set `force` to skip the probe.

A dispatch from a branch other than the default branch runs as a dry run. That guards against an accident; it is not a security boundary.

## Configuration

The config file is optional. With no file, the defaults below apply. A config file overrides top-level keys, the keys of `order` and `members`, and the keys of each language under `members`. A list replaces the default list whole. An unknown key at any of these levels is an error that names it.

```json
{ "members": { "csharp": { "enabled": true } } }
```

This example turns the C# mapper on and keeps its default `patterns`. [`examples/pr-conflict-radar.json`](examples/pr-conflict-radar.json) holds every default.

| Key | Default | Meaning |
| --- | --- | --- |
| `checkName` | `"PR conflict radar"` | Name of the check run. Agents find the result by this name |
| `classes` | `docs`: `**/*.md`; `tests`: `**/test/**`, `**/tests/**`, `**/*.test.*`, `**/*.spec.*`; `code`: `**` | Path classes, a list of `{name, patterns}`. The first matching class wins for a file. Globs support `**` and `*` only, and `**/` also matches zero directories |
| `severity` | `["docs", "tests", "code"]` | Every class name once, from least to most severe. A pair's class is the most severe class among its conflicting files |
| `commentClasses` | `["tests", "code"]` | Classes that create or change a comment. Other conflicts appear in the check only |
| `order.labelPriority` | `[]` | Labels that move a pull request earlier in the predicted merge order, first label first |
| `pairKey` | `"conflict/{repo}/{low}+{high}"` | Template of the pair key. Placeholders: `{owner}`, `{repo}`, `{low}`, `{high}` |
| `suggestPeerbus` | `true` | Show the pair key and a line that points to peerbus. See [Peerbus suggestions](#peerbus-suggestions) |
| `members.typescript.enabled` | `"auto"` | `"auto"`, `true` or `false`. `auto` turns the mapper on when a simulated pull request changes a matching file |
| `members.typescript.patterns` | `**/*.ts`, `**/*.tsx`, `**/*.mts`, `**/*.cts`, `**/*.js`, `**/*.jsx`, `**/*.mjs`, `**/*.cjs` | Files this mapper reads. It covers JavaScript too |
| `members.csharp.enabled` | `"auto"` | As above |
| `members.csharp.patterns` | `**/*.cs` | |
| `members.go.enabled` | `"auto"` | As above |
| `members.go.patterns` | `**/*.go` | |
| `members.rust.enabled` | `"auto"` | As above |
| `members.rust.patterns` | `**/*.rs` | |
| `members.cpp.enabled` | `"auto"` | As above |
| `members.cpp.patterns` | `**/*.c`, `**/*.h`, `**/*.cc`, `**/*.cpp`, `**/*.cxx`, `**/*.hh`, `**/*.hpp`, `**/*.hxx` | Files the C/C++ mapper reads |
| `members.cpp.defines` | `[]` | Macros the C/C++ mapper treats as expanding to nothing. See [C and C++](#c-and-c) |
| `members.ignoreNames` | `Name`, `Value`, `Count`, `Items`, `Type`, `Data`, `Result`, `Error`, `Message`, `Instance`, `Create`, `Init`, `Start`, `Stop`, `Dispose`, `ToString`, `Equals`, `GetHashCode`, `props`, `state`, `children`, `className`, `onChange`, `onClick`, `value`, `label`, `title`, `data`, `error`, `loading`, `index`, `render`, `default` | Names the changed-and-used hint skips because they are too common |
| `members.minNameLength` | `4` | The hint skips names shorter than this |
| `members.maxFileBytes` | `1000000` | A file larger than this is not parsed, and a note says so |
| `maxPrs` | `40` | Most pull requests simulated in one run, from 1 to 200. See below |

Types are checked. `checkName` is a non-empty string. `suggestPeerbus` is a boolean. `patterns`, `ignoreNames` and `labelPriority` are lists of non-empty strings. `minNameLength` is a non-negative integer and `maxFileBytes` a positive one.

**Merge order.** The predicted order is: ready before draft, then labels by `order.labelPriority`, then `APPROVED` before anything else, then the lower number first. In a pair, the first pull request merges first and the second one rebases.

**`maxPrs`.** With more open pull requests than `maxPrs`, the first `maxPrs` in the predicted order are simulated. Every output says so. A pull request left out, and an open one that targets another branch, gets a short "not simulated" result with the reason.

## The result

Every pull request that gets a result has a check run named `checkName`. Its title is a phrase with counts only, such as "Conflicts with 2 pull requests", "No conflicts" or "Not simulated". The conclusion is `neutral` when the pull request conflicts with the base or with another pull request, breaks the merge train, has a same-member overlap or was not simulated. Otherwise it is `success`.

The check's summary holds the conflicts table, the overlaps table, a line for a base conflict, a line for a train break and the notes. Its text holds the hints and ends with the result as JSON.

**Authors.** In the conflicts table, rows with other authors come first, and the author's own pull requests form a separate group. For another author's pull request the text names the author as a plain login with no `@`, so nobody is notified twice. For the author's own it says both are theirs and can be resolved in one session.

### The JSON

```json
{
  "schema": 1,
  "repo": "acme/widgets",
  "base": "main@<sha>",
  "pr": 15,
  "head": "<sha>",
  "author": "<login>",
  "inputs": "ready;REVIEW_REQUIRED;",
  "state": "<sha256>",
  "simulated": true,
  "order": [12, 15],
  "conflictsWithBase": false,
  "conflicts": [
    {
      "with": 12,
      "withAuthor": "<other login>",
      "sameAuthor": false,
      "tier": "textual",
      "class": "code",
      "files": [{ "path": "src/cart/total.ts", "class": "code", "members": ["computeTotal"] }],
      "mergesFirst": 12,
      "rebases": 15,
      "key": "conflict/widgets/12+15"
    }
  ],
  "overlaps": [
    {
      "with": 12,
      "withAuthor": "<other login>",
      "sameAuthor": false,
      "tier": "member",
      "kind": "same-member",
      "members": [{ "path": "src/cart/total.ts", "name": "computeTotal" }],
      "key": "conflict/widgets/12+15"
    }
  ],
  "hints": [
    {
      "with": 12,
      "kind": "changed-and-used",
      "names": [{ "path": "src/cart/total.ts", "name": "computeTotal" }]
    }
  ],
  "trainBreak": null,
  "degraded": false,
  "truncated": false,
  "notes": []
}
```

- `order` lists the simulated pull requests in predicted order. It is the same list in every result of one run.
- `state` is the SHA-256 of the base commit and, for every open pull request that targets the default branch, its number, head commit and `inputs`. The quick exit reads it back. `inputs` is the draft flag, the review decision and the order labels, as one string.
- `conflicts[].tier` is `textual` for a file conflict. `overlaps[].tier` is `member`. A `same-member` overlap makes the check `neutral`.
- `hints` are `changed-and-used` matches: one pull request changed or removed the declaration of a name that appears on the other's added lines. The match is by name across the whole repository, so it can be wrong. A hint never changes the conclusion and never causes a comment.
- `trainBreak` is `null` or `{"train": [12], "files": [{"path": "…", "class": "code"}], "class": "code", "multiWay": true}`: the pull requests already in the train when this one broke it, the conflicting files, and whether none of its pairwise conflicts is with a member of that train.
- `degraded` is `true` when a member mapper failed for this pull request. A degraded result never satisfies the quick exit, so the next run retries. The action publishes the textual result with a note, then exits non-zero.
- `truncated` is `true` when the result had to be cut to fit the size budget. Every rendered field stays under 60,000 characters. A table that would pass it is cut and ends with the number of rows left out.
- A result with `simulated: false` has empty `conflicts`, `overlaps` and `hints`, and the reason in `notes`.
- `notes` carry the `maxPrs` note, the pull requests a result was not checked against, and the files whose members were not mapped.
- `key` is the pair key. It stays in the JSON whatever `suggestPeerbus` says, because the comment's `notified` list is keyed on it and tools use it as the pair's stable identifier.

The JSON is embedded as `<!-- pr-conflict-radar:v1 {…} -->`. The characters `<`, `>`, `&` and a `-` that follows a `-` are written as `\u` escapes, so no value can end the comment early.

### How an agent reads the result

List the check runs of a pull request's head commit, pick the one named by `checkName`, and read the marker at the end of `output.text`:

```sh
gh api repos/acme/widgets/commits/<head sha>/check-runs \
  --jq '.check_runs[] | select(.name == "PR conflict radar") | .output.text' \
  | jq -R -s 'capture("<!-- pr-conflict-radar:v1 (?<json>.*) -->"; "s") | .json | fromjson'
```

Use the head SHA the pull request has now. A result on an older head is stale. A check run with the same name that has no readable marker is not the radar's; skip it.

### The comment

One sticky comment per pull request carries the conflicts whose class is in `commentClasses`. It has the same grouping and wording as the check, and ends with its data: the findings (`schema`, `repo`, `pr` and the conflicts) and `notified`.

- With no comment and at least one conflict, a comment is created.
- When a pair appears that this comment has never notified for, the old comment is deleted and a new one is created, so the author is notified again.
- Otherwise a comment whose body would change is edited in place, which notifies nobody.
- When no conflict is left, the comment is edited to one line, "Resolved: none of the conflicts reported here remains.", and kept.
- A conflict with the base, a train break, an overlap and a hint appear in the check only.

The data holds `"notified": ["conflict/widgets/12+15"]`: the pair keys this comment has already notified for, oldest first. It holds the key of every current row and at most 100 more.

### Notifications

Each pull request's author is notified once per pair. A pair that flips between conflicting and clean notifies once, because its key stays in `notified`. So an author who pushes repeatedly cannot make the radar notify somebody again and again, and another notification needs a pair that never conflicted before, that is, another open pull request.

Changing `pairKey` changes every key, so each listed pair notifies once more after the change.

### Peerbus suggestions

This part is optional, for teams that use [peerbus](https://github.com/nnemirovsky/peerbus), an open-source message bus for agents.

The pair key is the shared topic name for the agents working on the two pull requests of a pair. They can coordinate under it on peerbus, or on any channel a team chooses.

`suggestPeerbus` controls whether people see the key:

- On (the default): the check and the comment have a "Pair key" column and one line that points to peerbus. The job summary lists each conflicting pair with its key.
- Off: neither the key nor any mention of peerbus appears in the check, the comment or the job summary. The tables have one column fewer, and nothing else changes. The key stays only in the embedded JSON.

In both states the action has no access to peerbus and creates nothing there. It only suggests. Toggling `suggestPeerbus` edits the comments in place and never notifies anyone.

## Member overlap

For a pair that merges cleanly, the radar maps each pull request's changed lines to members with the language's own parser. It reports two signals:

- **same-member:** both pull requests changed the same member (same path and same qualified name). This is in `overlaps` and makes the check `neutral`.
- **changed-and-used:** one pull request changed a declaration whose name appears on the other's added lines. This is in `hints` only.

A member mapper is built only when a simulated pull request changes a file it reads (`auto`), or when `enabled` is `true`. If a mapper fails to build or run, the scan publishes the textual result marked `degraded`, with a note, and then exits non-zero.

| Language | Key | Parser | Default patterns | Toolchain the action sets up |
| --- | --- | --- | --- | --- |
| JavaScript, TypeScript, JSX, TSX | `typescript` | the TypeScript compiler API | `**/*.ts`, `**/*.tsx`, `**/*.mts`, `**/*.cts`, `**/*.js`, `**/*.jsx`, `**/*.mjs`, `**/*.cjs` | `npm ci --omit=dev --ignore-scripts` in the action's directory |
| C# | `csharp` | Roslyn | `**/*.cs` | `actions/setup-dotnet` with the .NET 10 SDK, and a cache of the NuGet packages |
| Go | `go` | `go/parser` | `**/*.go` | `actions/setup-go` at the version of `members/go/go.mod` |
| Rust | `rust` | `syn` | `**/*.rs` | the toolchain pinned in `members/rust/rust-toolchain.toml`, installed by the runner's `rustup` |
| C and C++ | `cpp` | libclang | `**/*.c`, `**/*.h`, `**/*.cc`, `**/*.cpp`, `**/*.cxx`, `**/*.hh`, `**/*.hpp`, `**/*.hxx` | `actions/setup-python` with Python 3.12 and a virtual environment with the `libclang` wheel, installed with pinned hashes |

The toolchain steps change the job. `actions/setup-dotnet`, `actions/setup-go` and `actions/setup-python` put their tools on the `PATH` for the rest of the job, and `rustup` may install the pinned Rust toolchain. Later steps in the same job see them. Run the radar in a job of its own, as the example does.

All parsers run on the file's text only. None expands a macro, runs a build script or resolves a dependency. The mapper builds write to the runner's temp directory, apart from the toolchains' own caches.

### Limits that apply to every language

- A file with a syntax error contributes no members, and a note names it. C and C++ are the exception: without the headers every real file has errors, so that mapper keeps what clang recovered.
- A file larger than `members.maxFileBytes` is not parsed.
- Only regular files are mapped. A symlink or a submodule is not.
- The overlap is syntax only. Two pull requests can change different members that still depend on each other, and the radar does not see that.
- The hint matches by name, so it can match an unrelated declaration with the same name.

### Go

Build tags are ignored and every file is parsed. A function is a member qualified by its package (`cart.Add`), a method by its receiver type with or without the pointer (`cart.Cart.Add`).

### Rust

Items that a macro generates are not seen. `macro_rules!` definitions are. An `impl` method is qualified by its self type (`Cart::add`), or by self type and trait (`<Cart as Total>::total`).

### C and C++

The mapper parses each file alone, without its headers, with these limits:

- **Conditional compilation.** Both branches of an `#if` that clang cannot evaluate are parsed. The radar uses no Microsoft-specific flags, so a Windows-only `#ifdef` arm is parsed alongside the other one.
- **Macros in unread headers.** A calling-convention, export or declaration macro that is defined in a header the mapper does not read hides the declaration it sits in. List such macros in `members.cpp.defines`. An entry is `NAME` for an object-like macro, or `NAME(...)` for a function-like macro used as a declaration:

  ```json
  { "members": { "cpp": { "defines": ["APIENTRY", "WINAPI", "BEGIN_MESSAGE_MAP(...)", "DECLARE_DYNCREATE(...)"] } } }
  ```

  An entry must match `^[A-Za-z_][A-Za-z0-9_]*(\(\.\.\.\))?$`, and there can be at most 200. The mapper turns each entry into a `-D` flag for libclang. The default is empty, because which macros a project needs depends on its headers.
- **Macros used as declarations.** A function-like macro used as a declaration, such as a test registration, reads as a member of kind `macro`. A `macro` member never counts as an overlap.
- **Function bodies.** Members local to a function body are not reported. They belong to the enclosing function.
- **Headers.** `.c` is parsed as C. Every other pattern, `.h` included, is parsed as C++, because C++ accepts almost every C declaration. A C header that uses a C++ keyword such as `new` as a name loses only that declaration.

## Security model

- The scan never checks out, installs, builds, imports or runs anything from a pull request. Pull request content is fetched as git objects and parsed as data.
- Everything the scan reads comes from the default branch's copy of the workflow and config.
- The token reaches only the GitHub client and git, through the environment, and is never printed. The action publishes only to the repository the workflow runs in.
- **Escaping.** Text that a pull request controls (file paths, member names, labels, author logins) enters a check, a comment or the job summary through one function. It removes control, format and line-separator characters, writes every ASCII character except letters, digits, space, `/` and `-` as a character reference, defuses `@`, and wraps the result in `<code>`. No link, image, emphasis, mention or issue reference forms from it, and a table keeps its shape. The only link the action writes is the peerbus link, a constant. The read query takes neither the title nor the branch name of a pull request, so neither reaches any output.
- **Logs.** Everything the action prints that can carry pull request text goes through one serializer: one JSON value on one line, with `#` written as `#`. Neither workflow-command form of the runner can occur in it. Child processes never write to the job log themselves.
- **Files.** Nothing derived from pull request content is written outside the repository's git directory and the runner's temp directory. The toolchain installs write where their tools put them, from this action's own files and from packages its lockfiles and hashes pin.
- **Fork pull requests** are simulated like any other. Their head commits are served by the base repository, and their results are published in the base repository.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- **Overlap is syntax only.** The action does not build or test merged code.
- **Hints match by name.** They can be wrong, and they never change the conclusion.
- **A pair is not checked while one side conflicts with the base.** That pull request is reported as conflicting with the base and is left out of the pair and train simulation.
- **Review events on fork and conflicted pull requests wait.** They are picked up by the next event or the schedule.
- **Fork publishing is not yet confirmed live.** The design publishes fork results in the base repository, but this has not been run against a real fork pull request yet.
- **More than `maxPrs` open pull requests** are partly simulated, and every output says so.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
