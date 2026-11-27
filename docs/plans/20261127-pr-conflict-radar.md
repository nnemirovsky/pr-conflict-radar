# pr-conflict-radar: the action

Repository: `nnemirovsky/pr-conflict-radar`, default branch `main`, Apache-2.0. Branch: `feat/initial-action`; the whole plan is one branch and one pull request, opened only on the owner's word (see "Development Approach"). What needs that pull request merged first is in `docs/plans/20261127-pr-conflict-radar-rollout.md`. This plan is committed to the repository, so it names no other organisation, repository or person, with one exception: peerbus (`nnemirovsky/peerbus`), the open-source agent message bus the radar suggests.

## Overview

GitHub reports whether a pull request conflicts with its base branch. It does not report whether two open pull requests will conflict with each other once the first one merges. Teams that hold pull requests for a merge window, or run many agents in parallel, meet those conflicts late and one at a time.

`pr-conflict-radar` is a GitHub Action that finds them ahead of time:

1. **A deterministic, non-blocking check.** It simulates every pair of open pull requests and the whole merge train with `git merge-tree`, and publishes the result on both pull requests of every affected pair: a check run that never fails, one comment for conflicts worth a notification, and the same result as JSON for tools and agents. No AI is involved.
2. **Syntax-only member overlap** for Go, JavaScript and TypeScript (JSX and TSX included), C#, Rust and C/C++ on pairs that merge cleanly: both pull requests changed the same member, or one changed a declaration the other newly uses. Each language uses its own native parser and is one entry of a registry, so another language is added in one place.
3. **A standalone public action.** One `uses:` line, no required config file, its own dependencies, and a documented security model: it never executes pull request code.

## Context (from discovery)

**The repository today**
- One commit: `README.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.gitignore` (`node_modules/`, `bin/`, `obj/` and the working directory of a local review tool), and `.github/` with `CODEOWNERS`, issue forms, a PR template, `dependabot.yml` (the `github-actions` ecosystem only) and `workflows/release.yml`, which runs on `v*` tags, refuses a tag that disagrees with `package.json`'s `version`, and publishes the release.
- `CONTRIBUTING.md` already promises: Node.js 20+, git 2.38+, the .NET 10 SDK for the C# mapper; `npm ci`; `npm test`; `npm run lint`; `node pr-conflict-radar.mjs --dry-run` (needs `GH_TOKEN`, reads the open pull requests of the repository in the current directory, never writes); `node:test`, real temp git repositories, a faked GitHub API, no network in tests.
- `SECURITY.md` already defines the scope: executing anything taken from a pull request, injecting commands or markup through pull request content (file names, file contents, branch names, titles, labels), leaking the token, touching files outside the workspace and the runner's temp directory, and publishing to another repository are vulnerabilities.
- `README.md` describes the product and says the usage, configuration and result schema will be documented before the first release.
- `main` is protected by a ruleset: pull requests only, squash merge, signed commits, review threads resolved. No status check is required yet. CodeQL runs on default setup.

**CI rules of this repository**
- Top-level `permissions: contents: read`; a job gets more only where it needs it.
- `concurrency` per workflow and ref with `cancel-in-progress`, except where this plan states why not.
- `workflow_dispatch` beside `push` and `pull_request`.
- Stable job `name:`s, because required checks match on them; a required job never sits behind a `paths:` filter.
- Actions referenced by their current major tag. Read from each repository's latest release on 2026-11-27: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/setup-dotnet@v6`, `actions/setup-go@v7`, `actions/setup-python@v7`, `actions/cache@v6`.

**Platform facts, verified against GitHub's documentation**
- Dispatching from a workflow: "When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following exceptions: `workflow_dispatch` and `repository_dispatch` events always create workflow runs." So a job holding only `actions: write` can start the scan.
- `workflow_dispatch`: "This event will only trigger a workflow run if the workflow file exists on the default branch."
- `pull_request`: "Workflows will not run on `pull_request` activity if the pull request has a merge conflict." and "Conversely, workflows with the `pull_request_target` event will run even if the pull request has a merge conflict."
- `pull_request_target`: "This event runs in the context of the default branch of the base repository, rather than in the context of the merge commit, as the `pull_request` event does." and "This event allows your workflow to do things like label or comment on pull requests from forks." Its warning: "Avoid using this event if you need to build or run code from the pull request."
- `pull_request_review` runs on the pull request's merge ref, and "The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories."
- A workflow run started by a pull request event, `pull_request_target` included, is recorded against the pull request's head commit: its jobs appear in that pull request's check list and count in its status rollup. Checked on a public repository: the run's `head_sha` was the pull request's head, not the default branch's.
- Concurrency: "By default, any existing `pending` job or workflow in the same concurrency group will be canceled" when a new one is queued; `queue: max` keeps up to 100 pending instead and cannot be combined with `cancel-in-progress: true`. A `concurrency` expression can read the `github`, `inputs` and `vars` contexts.
- Check runs: "To create a check run, you must use a GitHub App. OAuth apps and authenticated users are not able to create a check suite." The workflow token is such an app's installation token; a personal access token cannot create one. `output` requires `title` and `summary`; `output.summary` and `output.text` have a "Maximum length: 65535 characters".
- Rate limits for the workflow token: 1,000 REST requests and 1,000 GraphQL points per hour per repository. A GraphQL query costs the number of connection requests divided by 100.
- GraphQL, read from the schema and tried on a public repository: `statusCheckRollup.contexts` is a paginated connection ("A list of status contexts and check runs for this commit.", with `first`, `after` and `pageInfo`); a `CheckRun` in it has `name`, `databaseId` and `text`; an `IssueComment` has `viewerDidAuthor` ("Did the viewer author this comment.").
- Markdown, measured through GitHub's Markdown API (`gfm` mode with a repository context, which is how a comment renders): Markdown is parsed inside an inline `<code>` element. `[x](https://example.com)`, an image, `**x**`, `_x_`, `~~x~~`, a bare `https://` URL, `www.example.com` and `a@example.com` each render there as a link, an image or emphasis; `@login`, `#1` and a commit SHA do not. A decimal character reference in place of each punctuation character stops all of these except the e-mail autolink, which forms even from `a&#64;example&#46;com`. An empty HTML comment next to the `@` stops that one and is dropped from the rendered HTML. `&#124;` does not end a table cell.
- Workflow commands, read in the runner's source (`actions/runner`, `ActionCommand.cs` and `ActionCommandManager.cs`): the runner tests every output line of a step. A line is a command when, after leading whitespace, it starts with `::name::`, and also when it contains the older form `##[name]` anywhere, which the parser finds with `IndexOf("##[")`. `name` has to be a registered command; `set-output`, `save-state`, `add-mask`, `add-matcher`, `stop-commands`, `error`, `warning`, `notice`, `debug` and `group` are among them.
- Fetching by commit, tried on a public repository with two pull requests from forks: `git fetch <remote> +<sha>:<ref>` succeeds for a pull request's head commit, which for a fork is reachable only through `refs/pull/<n>/head`, in a shallow clone and together with `--unshallow`. One SHA the remote does not have fails the whole fetch with exit 128 and writes no ref.

**Tool facts, reproduced locally**
- `git merge-tree --write-tree` (git 2.43) exits 1 with empty output for a missing ref or an unknown SHA, the same code as a conflict; unrelated histories exit 128. With `--name-only --no-messages -z` it prints the tree OID, a NUL, then each conflicted path followed by a NUL.
- `git fetch origin +refs/heads/<branch>:<another ref>` also moves `refs/remotes/origin/<branch>`, and a fetch without `--no-tags` creates every tag that points into the fetched history. A fetch by commit SHA with `--no-tags` writes the named refs and nothing else. `--unshallow` fails in a repository that is already complete.
- `git merge-base` between a shallow default branch and a pull request head fails; a plain `git diff` obeys the user's `diff.external`, `diff.noprefix` and `color.ui`.
- A patch header quotes a path in C style when it contains `"`, `\`, a tab or a line break, even with `core.quotePath=false`, and ends a path that contains a space with a tab; a `-diff` attribute in the checkout's `.gitattributes` replaces a file's hunks with "Binary files differ". `git diff --raw -z` prints every path unquoted between NULs, with the status and both blob ids. A diff of two blob ids prints no path and reads no attribute.
- .NET file-based apps: they inherit `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props` and `nuget.config` from the directories above the app file, and `global.json` from the working directory and above. Under central package management a `#:package X@version` directive fails with `NU1008`; a parent `global.json` that pins an absent SDK stops the build with exit 155; a parent `nuget.config` with `<clear/>` and a private feed fails the restore with `NU1301`. A file of each kind beside the app, with the command run from the app's directory, restores the build in all three cases. The build output goes to the user profile (`~/.local/share/dotnet/runfile/<name>-<hash>/` on Linux) and the restored packages to the NuGet package cache. Microsoft's documentation: concurrent invocations "can cause errors due to contention over the build output files. To avoid this, first build the file-based app via `dotnet build file.cs` before starting the concurrent instances via `dotnet run file.cs --no-build`." Reproduced: four cold parallel runs all failed; after one build, four `--no-build` runs succeeded. With SDK 10.0.115, `dotnet build file.cs -nologo` reads the file as a project file and fails with `MSB4025`.
- `typescript` 7 no longer ships the JavaScript compiler API at its main entry point (it exports a version module and `unstable/*` paths). The last line with `ts.createSourceFile` is 6.0.x (6.0.3 is its latest release); that package is about 24 MB unpacked. With `typescript` 6.0.3, `ts.createSourceFile` parses `.js`, `.mjs` and `.cjs` with `ScriptKind.JS`, `.jsx` with `ScriptKind.JSX`, `.mts` and `.cts` with `ScriptKind.TS`, and returns classes, methods, functions and arrow-function constants with their lines; `ScriptKind.JS` also accepts JSX without a diagnostic.
- Go (1.27.1): `parser.ParseFile` with `parser.AllErrors | parser.SkipObjectResolution` on a file with a syntax error returns a partial `*ast.File` with positions together with the error list, but the declaration that holds the error swallows the ones after it (a broken function reported over lines 11-19 absorbed the constant and the function that followed it). Its nesting limit turns 900,000 nested parentheses or 1,000,000 chained `!` into the error "exceeded max nesting depth", not a crash. A mapper with only the standard library builds with an empty build cache in 2.3 s into a 3 MB binary. In a subdirectory that has its own `go.mod`, a parent `go.mod` changes nothing; a parent `go.work` that does not list the module fails the build ("main module (parent) does not contain package …") unless `GOWORK=off`; `GOFLAGS=-modfile=/nonexistent/go.mod`, from the environment or from a `GOENV` file, fails it unless `GOFLAGS` is empty and `GOENV=off`; with `GOTOOLCHAIN=local` a `go` line newer than the installed Go fails with "go.mod requires go >= … (running go …; GOTOOLCHAIN=local)" instead of downloading a toolchain. `CGO_ENABLED=0` builds it.
- Rust (rustup 1.29.3, Rust 1.100.0): `syn` 3.0.10 with `default-features = false` and the features `full`, `parsing` and `printing` (needed for `Spanned`), `proc-macro2` 1.0.107 with `span-locations`, and `serde_json` 1.0.154 compile 9 crates (820 KB of downloaded `.crate` files); a cold `cargo build --release --locked` takes 3.7 s on 8 threads and gives a 2.3 MB binary. Spans give exact lines for functions, structs and their fields, enum variants, trait items, inherent and trait impl methods (`<Cart as Total>::total` over lines 25-27), inline modules, consts, statics and `macro_rules!` items. `syn::parse_file` does not recover: a syntax error yields only an error with a position. 10,000 nested parentheses or 100,000 chained `!` overflow its stack on an 8 MiB thread and abort the process (exit 134), which no Rust code can catch; `proc_macro2::TokenStream` lexes 500,000 nested parentheses without recursion. A nested package under a parent `Cargo.toml` with `[workspace]` fails ("current package believes it's in a workspace when it's not") unless it declares its own `[workspace]`. The nearest `rust-toolchain.toml` to the working directory wins over a parent one, and `RUSTUP_TOOLCHAIN` wins over both. A toolchain the file names but rustup lacks is installed on first use (12.5 s), or fails with "toolchain '…' is not installed" under `RUSTUP_AUTO_INSTALL=0`; `rustup toolchain install` with no argument installs the toolchain the file names, with the file's `profile`. A parent `.cargo/config.toml` applies to a build run from the package's directory: a `[source.crates-io] replace-with`, `build.rustflags`, `build.rustc-wrapper` and `build.target` each failed the build, and a nested `.cargo/config.toml` cannot undo a source replacement (cargo rejects a second source for crates.io). Cargo reads config from the working directory upwards, not from the manifest's directory: the same build run from an empty directory with `--manifest-path` succeeded with all four in the parent config, with `RUSTUP_TOOLCHAIN` naming the toolchain.
- libclang: the newest `libclang` wheel on PyPI is 18.1.1 (LLVM 18, uploaded 2024-06-30), with wheels for Linux x86_64 and aarch64, macOS and Windows; installed into a venv with `pip install --require-hashes --only-binary :all: --no-deps` it takes under a second and 62 MB, and `clang.cindex` loads its bundled `libclang.so`. On a C++ file whose `#include`s cannot be resolved and whose macros are unknown, a parse with `-fsyntax-only -nostdinc -nostdinc++` returns namespaces, classes, in-class and out-of-line constructors and methods (`acme::ui::Widget::resize` over lines 21-25 through the semantic parent), fields, function templates, structs, enums and their constants, with lines. Without single-file mode `#include "/dev/zero"` hangs the parse; with `CXTranslationUnit_SingleFileParse` (0x400) no included file is entered and both branches of an `#if` it cannot evaluate are parsed. `CXTranslationUnit_KeepGoing` (0x200) keeps parsing after a fatal error; 60 declarations with unknown types still return all 61. An unknown macro between `class` and the class name (an export macro) turns the class into a variable and loses its members; a function-like macro used as a declaration (a test macro) comes back as a function named after the macro. 100,000 chained `!` crash the process with a segmentation fault (exit 139). A `constexpr` loop and a deep template recursion take 2.43 s with clang's default limits and 0.03 s with `-fconstexpr-steps=1000 -ftemplate-depth=64`. Parsed as C++, a C header that names a variable `new` loses that declaration and keeps the rest; `-std=c++23`, `-std=c17` and `-std=c23` are accepted. Stripping `#include` lines first is not needed, since single-file mode enters no included file, and it changes nothing in the members found.
- Python 3.12: `python -I script.py` ignores `PYTHONPATH` and the script's own directory; a planted `clang` package in the working directory, beside the script and on `PYTHONPATH` was not imported.
- One GraphQL query returns the open pull requests, the check runs on each head commit and the comments. A check-suite filter by check name returns nothing; the commit's status rollup lists the check runs.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- **process**: one branch, `feat/initial-action`, for every task of this plan; signed commits; granular scoped Conventional Commits with a lowercase description (`feat(simulate): …`), one logical change each. One pull request for the whole plan, opened only on the owner's word; the owner merges it (squash), so its title is written as a commit subject.
- **nothing here needs a merge.** `pull_request_target` and `workflow_dispatch` workflows only take effect once they are on `main`, so the action cannot scan this first pull request and no task waits for it. Verification before the merge is local: the full test suite, the lint, and `--dry-run` against a real repository the executor can read.
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- **company-agnostic**: code, tests, fixtures, examples and docs name no organisation, product or person other than this repository and peerbus (`nnemirovsky/peerbus`, which the radar suggests); examples use `acme/widgets` and pull requests 12 and 15
- nothing repository-specific in the code: every value a consumer may want to change is in the config, and the default branch is read from the API, never assumed to be `main`
- comments and docs state the present behaviour; no history
- any failure met along the way is in scope

## Testing Strategy

- **unit tests**: `node:test`, no test framework dependency. Git behaviour is tested against real fixture repositories created in a temp directory by a helper; the GitHub API is tested through an injected `fetch` fake. Workflow and action files are parsed with `yaml`, a dev dependency.
- **network**: no test touches the network, with one exception: a mapper test file that builds its tool fetches what the build needs: the C# one restores Roslyn from nuget.org, the Rust one fetches its crates from crates.io (and the pinned toolchain through rustup when it is absent), the C/C++ one installs `libclang` from PyPI. The Go mapper fetches nothing.
- **member mappers**: each mapper has one test file that runs the real tool on fixture files and asserts its JSON output. Every other test injects a fake mapper. Each mapper test file builds its tool once in a `before` hook, through the registry entry's build, and then runs it without rebuilding. A mapper test file is skipped with a message naming the missing tool when its toolchain is absent (`dotnet`, `go`, `rustup`, `python3`), except under `CI`, where a missing toolchain fails it. Mapper fixture files live under `test/fixtures/<language>/` with a `.txt` suffix (`cart.go.txt`, `widget.cpp.txt`), and the request's `path` names the language, so Biome, CodeQL and the radar's own patterns never read a fixture with a deliberate syntax error as source.
- **security tests**: markup injection through text a pull request controls (a file path, a member name, a label, an author login) is tested in the escaping function and in the renderers; command injection is tested in the log output with both command forms.
- **CI**: `.github/workflows/ci.yml` with jobs named exactly `test` and `lint`, on every pull request and every push to `main`, never behind a `paths:` filter.
- **e2e**: in this plan, a fixture-repository test of the whole pipeline with a faked API, and a local `--dry-run` against a real repository (Task 19). The live run, with two deliberately conflicting throwaway pull requests in this repository, belongs to the rollout plan, because it needs the workflows on `main`.
- Test commands:
  - `npm ci`
  - `npm test` (`node --test test/*.test.mjs`)
  - `npm run lint`
  - `node pr-conflict-radar.mjs --dry-run`

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

**One script, no stored state.** Every full run recomputes everything from the current open pull requests. What a run needs to know about the previous one it reads back from the results published on the pull requests.

1. Read the state in one paginated GraphQL query: the default branch and its head SHA, every open pull request (number, base, head SHA, author, labels, draft flag, review decision), the check runs on its head commit and the radar's own marker comments. A second query fetches the `text` of the check runs that carry the radar's name.
2. **Quick exit**: when the published results already record this exact state, stop. The run costs seconds.
3. Fetch the base commit and each pull request's head commit, by the SHAs the query returned and with full history, into a private ref namespace. Nothing is checked out and no pull request code is executed.
4. Verify every input commit, then merge each pull request into the base in memory with `git merge-tree --write-tree`. One that conflicts with the base is reported as such and left out of the pair and train simulation.
5. Compute the predicted merge order.
6. For every pair, merge the later pull request onto the earlier one's merged result. Then run the whole train in order.
7. Classify each conflicting file by path class.
8. Where a mapper is enabled, map each pull request's changed lines to members and compute the two overlap signals for pairs that merge cleanly.
9. Build the per-pull-request result and publish it: a pair's result goes to both of its pull requests in the same run.

**Key decisions**
- **Never blocks.** The check is `neutral` on a conflict, a train break or a `same-member` overlap and `success` when clean. The script exits non-zero only when the tool itself fails.
- **Event-driven, without attaching the scan to pull request heads.** A tiny trigger workflow reacts to pull request events and does one thing: it dispatches the scan workflow on the default branch. The scan itself runs on `workflow_dispatch`, on a push to the default branch and on an optional low-frequency schedule. So a result arrives within about a minute of a push, a tool failure is red on a default-branch run and never on somebody's pull request, and the only radar job a pull request ever shows is a dispatch that lasts seconds.
- **Always the default branch's code.** The scan and its config come from the default branch. A pull request that changes the consumer's workflow or config, or this action's code in this repository, runs none of its own version in the scan.
- **Never executes pull request code.** Pull request content is fetched as git objects and parsed as data. Everything a pull request author controls is escaped before it is published or logged.
- **Works with no config.** Every setting has a documented default; `.github/pr-conflict-radar.json` overrides them.
- **A composite action that installs its own dependencies.** The alternative, a bundled `dist/`, would commit several megabytes of the TypeScript compiler that every pull request has to rebuild and reviewers cannot read, and a JavaScript action cannot call `actions/setup-dotnet`, `actions/setup-go` or `actions/setup-python`. A composite action prepares a mapper's toolchain and builds the mapper only when that mapper is needed: `npm ci --omit=dev` from a lockfile for TypeScript, .NET for C#, Go for Go, the pinned Rust toolchain for Rust, a venv with `libclang` for C/C++.
- **The languages' own parsers, all optional, one registry.** The TypeScript compiler API (TypeScript, TSX, JavaScript, JSX), Roslyn (C#), `go/parser` (Go), `syn` (Rust) and libclang (C/C++), syntax only, never a build of the analysed code. Each is one entry of `members/registry.mjs`, which holds everything language-specific: the config key, the default patterns, how the mapper is built, how it is run, and the `prepare` output that gates its step in `action.yml`. Config, `prepare`, the scan and the tests read the registry; a new language is a new entry, a mapper directory and its test file. Each mapper is on, off, or `auto` (on when a simulated pull request changes a matching file).
- **No messaging.** The result carries a pair key (default `conflict/<repo>/<lowPR>+<highPR>`): the shared topic name under which the agents of the two pull requests can coordinate on peerbus (`nnemirovsky/peerbus`, an open-source agent message bus) or on any channel a team chooses. With `suggestPeerbus` on, the default, the check and the comment show the key and one fixed line that points to peerbus; with it off, people see neither, and the key stays only in the embedded JSON. The action has no access to peerbus or any other messaging system and creates nothing there: it only suggests.

## Technical Details

### Layout

```
action.yml                     composite action
pr-conflict-radar.mjs          CLI entry (phases: probe, prepare, build <mapper>, scan;
                               --dry-run alone runs probe, prepare, the needed builds and scan)
lib/config.mjs  classify.mjs  git.mjs  order.mjs  simulate.mjs  escape.mjs
    report.mjs  github.mjs  publish.mjs  probe.mjs  members.mjs
members/registry.mjs           one entry per language: config key, default patterns, build, run, gate
members/typescript/member-map.mjs
members/csharp/MemberMap.cs    single-file .NET 10 app
members/csharp/Directory.Build.props, Directory.Build.targets, Directory.Packages.props,
    global.json, nuget.config  stop files
members/go/member-map.go, go.mod                        standard library only
members/rust/Cargo.toml, Cargo.lock, rust-toolchain.toml, src/main.rs
members/cpp/member_map.py, requirements.txt             libclang, hashes for every wheel
test/                          node:test files, fixtures and the fixture-repo helper
examples/pr-conflict-radar-trigger.yml, pr-conflict-radar.yml, pr-conflict-radar.json
package.json, package-lock.json, biome.json
.github/workflows/ci.yml       jobs `test` and `lint`
.github/workflows/pr-conflict-radar-trigger.yml, pr-conflict-radar.yml   the action on itself
```

### Config (`.github/pr-conflict-radar.json`, optional)

The defaults, which are what runs when the file is absent:

```json
{
  "checkName": "PR conflict radar",
  "classes": [
    {"name": "docs", "patterns": ["**/*.md"]},
    {"name": "tests", "patterns": ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"]},
    {"name": "code", "patterns": ["**"]}
  ],
  "severity": ["docs", "tests", "code"],
  "commentClasses": ["tests", "code"],
  "order": {"labelPriority": []},
  "pairKey": "conflict/{repo}/{low}+{high}",
  "suggestPeerbus": true,
  "members": {
    "typescript": {"enabled": "auto", "patterns": ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]},
    "csharp": {"enabled": "auto", "patterns": ["**/*.cs"]},
    "go": {"enabled": "auto", "patterns": ["**/*.go"]},
    "rust": {"enabled": "auto", "patterns": ["**/*.rs"]},
    "cpp": {"enabled": "auto", "patterns": ["**/*.c", "**/*.h", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.hh", "**/*.hpp", "**/*.hxx"], "defines": []},
    "ignoreNames": ["Name", "Value", "Count", "Items", "Type", "Data", "Result", "Error", "Message", "Instance", "Create", "Init", "Start", "Stop", "Dispose", "ToString", "Equals", "GetHashCode", "props", "state", "children", "className", "onChange", "onClick", "value", "label", "title", "data", "error", "loading", "index", "render", "default"],
    "minNameLength": 4,
    "maxFileBytes": 1000000
  },
  "maxPrs": 40
}
```

- A config file overrides top-level keys, the keys of `order` and `members`, and the keys of each language under `members` (`typescript`, `csharp`, `go`, `rust`, `cpp`: the registry's config keys), so `{"members": {"csharp": {"enabled": true}}}` keeps the default `patterns`. A list replaces the default list whole. An unknown key at any of these levels is an error naming it. The language entries of the defaults are built from the registry, so a new registry entry is a new config key with no other change to the loader.
- `members.typescript` covers JavaScript too: one parser, one npm package and one install step serve both, so a separate `javascript` key would gate the same step twice. A repository that wants only one of them overrides `patterns`.
- The `cpp` patterns include C. `.c` is parsed as C (`-std=c17`); every other pattern, `.h` included, as C++ (`-std=c++23`). `.h` is ambiguous: C++ parses almost every C declaration, while C cannot parse a class, a namespace or a template, so C++ loses least. The measured exception, a C header that uses a C++ keyword such as `new` as a name, loses only that declaration. Globs have no braces, so each extension is a pattern of its own.
- The first matching class wins for a file; a file that matches no class takes the most severe one. `severity` names every class exactly once, from the least to the most severe, and a pair's class is the most severe class among its conflicting files. `commentClasses` names existing classes. Globs support `**` and `*` only, with no dependency; `**/` also matches zero directories.
- `pairKey` placeholders: `{owner}`, `{repo}`, `{low}`, `{high}`.
- `members.<language>.enabled` is `"auto"`, `true` or `false`.
- `members.cpp.defines` lists macros the C/C++ mapper treats as expanding to nothing, because the headers that define them are never read: an entry is `NAME` (an object-like macro such as a calling-convention or export macro, `APIENTRY`, `WINAPI`) or `NAME(...)` (a function-like macro used as a declaration, `BEGIN_MESSAGE_MAP(...)`, `DECLARE_DYNCREATE(...)`). Each entry must match `^[A-Za-z_][A-Za-z0-9_]*(\(\.\.\.\))?$`; anything else is a config error naming the entry. An entry reaches libclang only as `-DNAME=` or `-DNAME(...)=`, built by the mapper from the validated name, never as text taken from the file. The default is empty, because which macros a project needs depends on its headers.
- `suggestPeerbus` is the single gate for every mention of peerbus and for the pair key in everything people read; see "Publishing". `pairKey` works in both states, because the JSON `key` uses it.
- Types are checked: `checkName` is a non-empty string; `suggestPeerbus` is a boolean; `patterns`, `ignoreNames` and `labelPriority` are lists of non-empty strings; `minNameLength` is a non-negative integer; `maxFileBytes` is a positive integer; `members.cpp.defines` is a list of at most 200 entries of the form above; `maxPrs` is an integer from 1 to 200.

### Simulation

- **Commits**: `git fetch --no-tags --no-write-fetch-head origin +<base sha>:refs/pr-conflict-radar/base +<head sha>:refs/pr-conflict-radar/<n> …`, with the SHAs the read query returned, and with `--unshallow` when `git rev-parse --is-shallow-repository` prints `true`. The run simulates exactly the commits it read: the base it records is the base it merged onto, and a push that arrives during the run changes nothing in it and has already dispatched the next run. No local branch, remote-tracking ref or tag is touched, which matters for `--dry-run` on a developer's clone. A listed commit the remote does not serve fails the run with a message naming the pull request; the next run reads a fresh state. The scan deletes the refs under `refs/pr-conflict-radar/` when it ends.
- **Inputs are verified first**: `git rev-parse --verify --quiet <sha>^{commit}` for every commit before any merge.
- `git merge-tree --write-tree --name-only --no-messages -z <ours> <theirs>`: exit 0 is clean. Exit 1 is a conflict only when the first field is a tree OID; exit 1 without one, and every other exit code, is a tool failure. Requires git 2.38+; the script checks the version and fails with a clear message.
- An intermediate result becomes a commit through `git commit-tree <tree> -p <ours> -p <theirs>` with a fixed identity set in the environment.
- Every git call passes its arguments as an array, never through a shell, and separates revisions from paths. No git output reaches the job log directly: it is captured.
- **Order**: ready before draft; then labels by `order.labelPriority`; then `APPROVED` before anything else; then lower number. What the order reads from a pull request is its `inputs` fingerprint: the draft flag, the review decision and its labels named in `order.labelPriority`, as one canonical string.
- **State fingerprint**: `state` is the SHA-256 of a canonical JSON of the base SHA and, for every open pull request that targets the default branch, in number order, its number, its head SHA and its `inputs`. It names everything a result depends on, and every result of a run records it.
- **Pair** (first, second in that order): merge `second` onto the commit of `base + first`. A conflict names `first` as merging first and `second` as the one that rebases.
- **Train**: accumulate in order. A pull request that conflicts with the accumulated tree is recorded as a train break and skipped, so later ones are still evaluated. A train break with no conflicting pair behind it is reported as a multi-way conflict with the pull requests already in the train.
- **Not simulated**: with more than `maxPrs` open pull requests the first `maxPrs` in the predicted order are simulated and every output says so. The selection reads the `inputs` fingerprints and the numbers and nothing else, so a comment, a title edit or the radar's own writes never change it. One left out by that limit, and an open one that targets another branch but still carries a simulated result, each get a short "not simulated" result with the reason.
- **Checked pairs**: a pair is checked in a run when both of its pull requests are simulated and neither conflicts with the base. The `notes` of a simulated result name the open pull requests it was not checked against and why.

### Member overlap

- Changed files come from `git diff --raw -z -M --no-abbrev <merge-base> <head>`, where `<merge-base>` is the pull request's own merge base with the base commit: NUL-terminated records that git never quotes, each with the status, the path (both paths for a rename) and both blob ids.
- Changed ranges of a file come from the hunk headers of `git diff --no-color --no-ext-diff --no-textconv -U0 <old blob> <new blob>`, and nothing else of that output is read. So no path is ever parsed out of patch text, and no `.gitattributes` or diff setting of the checkout applies. An added file is one range over the whole head-side file, a deleted file one range over the whole base-side file. Ranges are computed only for files a mapper reads.
- **The contract every mapper speaks.** A mapper is run with two arguments, the path of a JSON request file `[{id, path, file, ranges}]` and `maxFileBytes`. `file` is the blob written to a temp file whose name the tool generates, never one derived from the path; `path` only selects the language variant (for example `ScriptKind`, or C against C++). It writes one JSON response to its standard output: per entry either `{id, members, identifiers}` or `{id, error}`. A member is `{name, kind, declarationTouched}` for each member whose span intersects a range, `name` qualified by the containing namespaces, modules, packages and types; `identifiers` are the identifier tokens on the given lines. A file over `maxFileBytes` is an entry error without being parsed (the scan also never sends one). The mapper exits 0 whenever it wrote a response, also when entries have errors. The C/C++ mapper takes a third argument, the path of a JSON file holding the validated `members.cpp.defines` list (absent means empty), and checks each entry against the same pattern before turning it into a `-D` argument.
- **Entry errors.** A syntax error is an error on its entry, and that entry contributes no members, because spans after a syntax error are unreliable (see the `go/parser` fact). So are nesting too deep, a parser that crashed on the file and, where a mapper parses entries in child processes, an entry that took longer than 20 seconds. C/C++ is the exception for syntax errors: without the headers every real file has errors (unknown types and macros), so its mapper returns what clang recovered and reports an entry error only for a crash or a timeout. An entry error is named in the result's `notes` and never makes the result `degraded`.
- **Crash isolation.** `syn` and libclang end the whole process on a stack overflow, which no code in that process can catch. So the Rust and C/C++ mappers parse each entry in a child process of their own (the mapper re-run on that one entry; the C/C++ one through the same interpreter with `-I`), and a child that dies or outlives 20 seconds turns into an error on its entry. The TypeScript mapper catches the `RangeError` of a deep stack, Roslyn guards its own depth, and `go/parser` has a nesting limit, so those three parse in one process.
- A mapper starts at most twice per scan: one request for the base side (declarations changed or removed, read from the blob at each pull request's merge base) and one for the head side (changed members and identifiers on added lines), each covering every simulated pull request.
- **Limits on what a mapper is given**: a blob larger than `members.maxFileBytes` is not sent, and the result's `notes` say so. A mapper run that takes longer than 120 seconds is stopped and counts as a mapper failure.
- **The registry** (`members/registry.mjs`): one entry per language, in the order `typescript`, `csharp`, `go`, `rust`, `cpp`, each with its config key (also the name of its `prepare` output), its default patterns, `build` (the commands, working directory and environment that prepare it, run once per job by `pr-conflict-radar.mjs build <key>`), `run` (the command for one request) and the toolchain it needs. Builds and runs pass arguments as arrays, never through a shell, and capture every output. Everything a build produces outside the toolchains' own caches goes to the work directory: `$RUNNER_TEMP/pr-conflict-radar` in the action, a temp directory of the process in a local `--dry-run`. Each mapper's build runs once, in its own action step, before any run of it, so two builds of one mapper never run at once. A build and a run take the mapper's directory as a parameter (the action's own `members/<key>` by default), which the leak tests point at a copy.
- **TypeScript mapper** (`typescript`, TypeScript, TSX, JavaScript, JSX): `ts.createSourceFile` from a `typescript` version pinned exactly to the 6.0 line, `ScriptKind.TS` for `.ts`, `.mts`, `.cts`, `TSX` for `.tsx`, `JS` for `.js`, `.mjs`, `.cjs` and `JSX` for `.jsx`. Members: functions, arrow-function constants, components, classes and their members, exported constants, interfaces and type aliases, qualified by containing classes and namespaces. Build: `npm ci --omit=dev --ignore-scripts` in the action's directory, skipped when `typescript` already resolves there, so a local `--dry-run` after a full `npm ci` keeps the dev dependencies. Run: `node members/typescript/member-map.mjs`. The dependency update config ignores `typescript` major updates until the mapper is ported.
- **C# mapper** (`csharp`): built once per job with `dotnet build MemberMap.cs`, then `dotnet run --no-build MemberMap.cs -- <request> <maxFileBytes>`, both with `members/csharp` as the working directory. The build takes no extra MSBuild switch unless the task has verified it. The five stop files beside it keep the build files of a parent directory, and the `global.json` of the consumer's workspace, out: the three `Directory.*` files, a `global.json` that asks for the .NET 10 SDK with `rollForward: latestFeature`, and a `nuget.config` that clears the inherited package sources and source mapping and names nuget.org. Members: methods, constructors, properties, indexers, operators, fields, events, local functions and enum members, qualified by containing types and namespace.
- **Go mapper** (`go`): `members/go/member-map.go`, standard library only, with its own `go.mod` (module `membermap`, no requirements; its `go` line is the one Go version pin). `parser.ParseFile` with `parser.AllErrors | parser.SkipObjectResolution`; build tags are ignored and every file is parsed. Members: functions, methods qualified by their receiver's type with or without the pointer (`cart.Cart.Add`), types, struct fields (`cart.Cart.Items`), interface methods (`cart.Store.Get`), package-level variables and constants, all qualified by the file's package name. Identifiers come from `go/scanner`. Build: `go build -o <work>/member-map-go .` in `members/go`, with every inherited `GO*` variable other than `GOROOT`, `GOPATH`, `GOCACHE` and `GOMODCACHE` removed and `GOWORK=off`, `GOENV=off`, `GOFLAGS=` (empty), `GOTOOLCHAIN=local` and `CGO_ENABLED=0` set, so neither a parent `go.work`, a `GOENV` file nor the job's `GOFLAGS` applies and no toolchain is downloaded. The `go.mod` beside it is the stop file for a parent `go.mod`. Run: `<work>/member-map-go`.
- **Rust mapper** (`rust`): `members/rust`, a binary crate on `syn` 3 (`default-features = false`, features `full`, `parsing`, `printing`), `proc-macro2` with `span-locations` and `serde_json`, with a committed `Cargo.lock`, `[workspace]` in its `Cargo.toml` and a `rust-toolchain.toml` (`channel` an exact version, `profile = "minimal"`) as the one toolchain pin. Members: functions; methods, associated constants and types of an `impl`, qualified by its self type (`Cart::add`) or by self type and trait (`<Cart as Total>::total`); structs and unions with their named fields, enums with their variants, traits with their items; type aliases, constants, statics and `macro_rules!` macros; inline modules as qualifiers (`inner::helper`). Items a macro generates are not seen. Identifiers come from the `proc_macro2` tokens on the given lines. Build: the registry reads `channel` from `rust-toolchain.toml`, runs `rustup toolchain install <channel> --profile minimal --no-self-update`, then `cargo build --release --locked --manifest-path <action>/members/rust/Cargo.toml` from an empty directory in the work directory, with `RUSTUP_TOOLCHAIN=<channel>`, `CARGO_TARGET_DIR=<work>/cargo-target`, and every inherited `CARGO_*`, `RUSTC*`, `RUSTDOC*`, `RUSTFLAGS` and `RUSTUP_TOOLCHAIN` variable removed except `CARGO_HOME`. Run from that empty directory, no `.cargo/config.toml` of a directory above the action applies, and `RUSTUP_TOOLCHAIN` overrides a parent `rust-toolchain.toml`; the `[workspace]` line is the stop file for a parent workspace. The user-level `$CARGO_HOME/config.toml` still applies, as it does to every cargo run on that machine. Run: `<work>/cargo-target/release/member-map`.
- **C/C++ mapper** (`cpp`): `members/cpp/member_map.py` over `clang.cindex` from the `libclang` wheel pinned in `requirements.txt` with the hash of every published wheel. Each entry is parsed with `-fsyntax-only -nostdinc -nostdinc++ -fconstexpr-steps=1000 -ftemplate-depth=64`, `-x c -std=c17` for `.c` and `-x c++ -std=c++23` otherwise, plus `-ferror-limit=0` and one `-D` per `members.cpp.defines` entry, and the options `CXTranslationUnit_SingleFileParse | CXTranslationUnit_KeepGoing | CXTranslationUnit_SkipFunctionBodies` (0x400 | 0x200 | 0x40), so no included file is read, both branches of an `#if` clang cannot evaluate are parsed, clang's constant evaluation and template instantiation stop early, and an error inside one function body cannot derail the members after it (libclang ends a skipped function's extent at its declarator, so the mapper finds the body's braces in the tokens after it; only entities local to a body are not reported, and they belong to the enclosing function anyway).
- **C/C++ synthesized prelude.** A file parsed alone does not see the declarations in its own headers, so an out-of-line definition `void Widget::resize()` whose class lives in an unread header fails with "use of undeclared identifier" and disappears, and a member whose type is a qualified template with nested arguments (`std::map<K, std::vector<V>>`) is lost together with the declaration after it. Forward declarations do not help (an incomplete type in a nested name specifier is an error too) and `-include` is ignored in single-file mode. So a file whose first parse reports undeclared identifiers is parsed a second time with one synthesized line prepended: for every name the first parse reported as undeclared and the file uses as a qualifier (`X::`) or in a type position, an empty definition in the namespace where it is used, nested for a nested qualifier (`namespace acme { struct Widget { struct Inner {}; }; }`) and a `template<class...>` struct where the name is followed by `<`. A name the first parse declared is never synthesized, which would redefine it. Every line number of the second parse is shifted back by one, and a cursor located on the synthesized line is never reported. Clang then reports the methods with "does not match any declaration" but returns their cursors with correct spans. The prelude is built only from identifiers clang reported, written as declarations the mapper composes; no text of the file is copied into it.
- **C/C++ macro-shaped functions.** An unknown function-like macro invoked at class or file scope (a test-registration or message-map macro) comes back as a function named after the macro. A function or method cursor whose name is made only of upper-case letters, digits and underscores, contains an underscore or is at least three characters long, and has no declared return type in the source tokens is reported with `kind: "macro"`; `lib/members.mjs` leaves such members out of `same-member` and `changed-and-used`, so two pull requests that both touch different `TEST_F` blocks do not overlap by name. `members.cpp.defines` removes the macro instead where a project prefers that. Members: functions and function templates, methods in the class and out of line (`acme::ui::Widget::resize`, qualified through the semantic parent), constructors, destructors, conversion functions, fields, namespace-scope variables, enum constants, type aliases, and classes, structs, unions, enums and namespaces both as qualifiers and as members. Only cursors located in the parsed file count. Identifiers are the clang tokens of kind identifier on the given lines. Build: `python3 -m venv <work>/cpp-venv`, then the venv's interpreter runs `-I -m pip install --require-hashes --only-binary :all: --no-deps -r members/cpp/requirements.txt`. Run: the venv's interpreter with `-I members/cpp/member_map.py`; `-I` keeps `PYTHONPATH`, the working directory and the script's directory off the import path.
- **same-member**: the two pull requests' changed member keys (`path` + qualified name) intersect. It goes into `overlaps` and makes the check `neutral`.
- **changed-and-used**: one pull request touched or removed the declaration of a name that appears among the identifiers on the other's added lines, excluding names the other declares there, names in `ignoreNames` and names shorter than `minNameLength`. The match is by name across the whole repository, so it can be wrong. It goes into `hints`, which never change the conclusion and never cause a comment.
- A mapper failure does not suppress the textual result: the script publishes it marked `degraded` with a note, then exits non-zero. A degraded result never satisfies the quick exit, so the next run retries.

### Result schema (one object per pull request)

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
      "files": [{"path": "src/cart/total.ts", "class": "code", "members": ["computeTotal"]}],
      "mergesFirst": 12,
      "rebases": 15,
      "key": "conflict/widgets/12+15"
    }
  ],
  "overlaps": [
    {"with": 12, "withAuthor": "<other login>", "sameAuthor": false, "tier": "member", "kind": "same-member", "members": [{"path": "…", "name": "…"}], "key": "conflict/widgets/12+15"}
  ],
  "hints": [
    {"with": 12, "kind": "changed-and-used", "names": [{"path": "…", "name": "…"}]}
  ],
  "trainBreak": null,
  "degraded": false,
  "truncated": false,
  "notes": []
}
```

- `order` lists the simulated pull requests in predicted order, the same list in every result of one run. `state` is what the quick exit reads back; `base`, `inputs` and `order` let it say what moved.
- A "not simulated" result has `simulated: false`, the run's `base`, `state` and `order`, its own `head` and `inputs`, empty `conflicts`, `overlaps` and `hints`, and the reason in `notes`.
- A `trainBreak` that is not `null` is `{"train": [12], "files": [{"path": "…", "class": "code"}], "class": "code", "multiWay": true}`: the pull requests already in the train when this one broke it, the conflicting files, and `multiWay`, which is `true` when none of this pull request's `conflicts` is with a member of that train.
- **Findings** are what a comment is made of: `schema`, `repo`, `pr` and the `conflicts` entries whose class is in `commentClasses`. They hold no `head`, `base`, `state`, `order`, `inputs`, `overlaps` or `hints`.
- **The comment's embedded data** is its findings plus `notified`: the pair keys this comment has already notified for, oldest first, for example `"notified": ["conflict/widgets/12+15"]`. It holds the key of every current row and at most 100 more, the most recently notified ones; when a key is added beyond that, the oldest key that is on no current row is dropped. With `maxPrs` at most 200 a comment has at most 199 rows, so the list has at most 299 keys.
- `key` stays in the embedded JSON whatever `suggestPeerbus` says, because the notified list is keyed on it and tools and agents use it as the pair's stable identifier. No field of the result or of the embedded data names peerbus.
- **Bounded size.** Every rendered field stays under a 60,000-character budget: a table that would pass it is cut and ends with the number of rows left out, and in the check's text the hints are cut first. A result whose embedded form would still pass the budget, in the check's text or in the comment, is reduced before anything is rendered: in the comment, the `notified` keys that are on no current row go first, oldest first; then it lists fewer files, members and hint names per pair, records the left-out counts and sets `truncated: true`. The reduction is deterministic and leaves an already reduced result unchanged. The reduced result is what the check embeds, what the comment's findings are taken from and what every comparison reads. The complete results go to the job summary and, as one JSON document, to the job log.

### Publishing

- **Reads**: the state query takes, for each context in a head commit's status rollup, only its type, name and id, and for each comment its body and `viewerDidAuthor`. A rollup or a comment list longer than 100 entries is continued with a query of its own. A second query fetches `text` for the check runs named `checkName`, by id, so the output of no other check is downloaded. Writes go through REST, one after another.
- **Check run** named by `checkName` on the head of every pull request that gets a result: `neutral` when the pull request conflicts with the base or with another one, breaks the train, has a `same-member` overlap or was not simulated; `success` otherwise. `output.title` is a phrase the tool chooses, with counts only ("Conflicts with 2 pull requests", "No conflicts", "Not simulated"). `output.summary` holds the conflicts table, the overlaps table (columns: other pull request, author, members, and "Pair key" when `suggestPeerbus` is on), a line for a base conflict, a line for a multi-way train break naming the train and the files, and the notes. `output.text` holds the hints with the by-name caveat and then the embedded result.
- **The radar's own check** on a head is the check run named `checkName` whose `text` carries a readable embedded result: the marker parses, the schema is known, and `repo` and `pr` are this pull request's. Among several, the newest counts. A check run with that name and no such result, such as a workflow job that shares the name, is not the radar's: it is never read as a result and never updated. Creating a check run takes a GitHub App with `checks: write` on the repository, so nobody without write access can plant one, and what is read back from a check is only ever compared, never rendered.
- **Authors.** The conflicts table has an Author column (columns: other pull request, author, merges first, files, class, who rebases, and "Pair key" when `suggestPeerbus` is on). Rows with other authors come first; the author's own pull requests form a separate group under its own heading. For another author's pull request the text names that author as a plain login with no `@`, so nobody is notified twice. For the author's own it says both are theirs and can be resolved in one session. The key is in the embedded JSON in both cases.
- **The pair key and peerbus.** `suggestPeerbus` is the single gate for every peerbus mention the action writes and for the pair key in everything people read. On (the default): the tables have the "Pair key" column; the different-author wording lists the key and is followed by the fixed line "Agents that both use [peerbus](https://github.com/nnemirovsky/peerbus) can coordinate under the pair key as a topic name."; the same-author wording lists the key as optional and is followed by the fixed line "Optional: agents working on both pull requests can coordinate on [peerbus](https://github.com/nnemirovsky/peerbus) under the pair key as a topic name.", because one author running several agents in parallel is a case peerbus serves; the overlaps table is followed by the different-author line; the job summary lists each conflicting pair with its key. Off: no "Pair key" column, no key in either wording, in the comment or in the job summary, and the word peerbus appears nowhere the action writes (check summary, check text, comment, job summary, log, JSON); the tables have one column fewer and nothing else changes. Both lines and the link are constants in `lib/report.mjs`, never built from pull request content or config text, so they do not go through the escaping function; the key itself is always escaped.
- **Sticky comment**, one per pull request, with the same grouping and wording. Only conflicting pairs whose class is in `commentClasses` create or change one; a base conflict, a train break, an overlap and a hint appear in the check only. The radar's own comment carries the hidden marker and was written by the token's identity (`viewerDidAuthor`); any other comment with the marker is ignored, never edited and never deleted.
  - Its rows are the findings of the result. A row of the existing comment whose pair this run did not check, while both pull requests are still open against the default branch, is kept as it is. So a pull request left out by `maxPrs`, and a pair whose other side conflicts with the base, change nothing in a comment.
  - With no comment and at least one row, a comment is created; its `notified` list holds the keys of its rows.
  - A **new member** is a row whose pair key is not in the existing comment's `notified` list. With one, the old comment is deleted and a fresh one is created, so the author is notified again, and the new keys are appended to the list the fresh comment carries over. Changing the `pairKey` template changes every key, so each listed pair notifies once more after such a change.
  - Without one, a comment whose body would change (a pair gone, a file list or a direction changed, a pair already in `notified` that conflicts again) is edited in place, which notifies nobody.
  - With no row left, the comment is edited to its resolved form and kept: one line, "Resolved: none of the conflicts reported here remains.", with empty findings and the `notified` list unchanged. A row leaves a comment only when its pair was checked and came out clean, or when one of its pull requests is closed or targets another branch. Keys stay in `notified` after their row leaves, so a pair that flaps between conflicting and clean notifies once, and a resolved comment that gets a pair it already notified for back is edited in place.
  - What this protects against: on `pull_request_target` any author, a fork's included, can push as often as they like. Each push can flip a pair between conflicting and clean, and without the list every flip back would delete and re-create the other pull request's comment and notify its author. With it, a pull request's author is notified once per pair; another notification needs a pair that never conflicted before, that is, another open pull request.
- **Embedded result**: `<!-- pr-conflict-radar:v1 {…} -->`. The check's text ends with the full result; the comment ends with its embedded data (findings and `notified`).
- **Both sides in one run.** The publisher first plans every write, then writes the checks of all pull requests, then the comments. A publish that stops midway is completed by the next run: the checks it did not reach still record the previous `state`, and an outstanding comment write shows when the probe plans a publish of the recorded results.
- **Two comparisons, kept apart.** *Did anything move?* (quick exit) compares the `state` each recorded result carries with the fingerprint of the state just read. *What has to be written?* (publish): a check is written when its result differs from the recorded one, and because `state` is part of the result, any change of the state rewrites every check, one REST write per open pull request; a comment is written only when the body it would get differs from its current body. That body is rendered from the findings (with the kept rows of unchecked pairs), the `notified` list and the fixed wording `suggestPeerbus` selects, so a new base, a push that leaves the listed conflicts as they are and a reshuffled order that keeps each listed pair's direction never touch a comment, and a flipped direction edits it in place. Toggling `suggestPeerbus` changes the body, so it edits every comment in place; it never re-creates one, because the rows' keys are already in `notified`. A config change reaches the scan through a push to the default branch, which changes `state` and so rewrites every check as well.
- **Job summary**: the pair matrix, the conflicting pairs (with their keys when `suggestPeerbus` is on), the number of conflicting pairs between different authors and between pull requests of one author, the overlaps, the hints, the train in order, and the number of check writes and comment writes the run made; one line on a quick exit.
- **Fork pull requests** are simulated like any other: the base repository serves their head commits, and their results are published in the base repository.
- `--dry-run` (CLI flag and action input) prints the results, the job summary and the number of writes a publish would make, and publishes nothing. It never takes the quick exit.

### Security model

- The scan never checks out, installs, builds, imports or runs anything from a pull request. Files reach the parsers as text. None of the five parsers expands a procedural macro, runs a build script or resolves a dependency; libclang reads no included file (single-file mode), and the constant evaluation and template instantiation its semantic analysis performs inside the parser are capped (`-fconstexpr-steps=1000 -ftemplate-depth=64`).
- **Escaping.** One function in `lib/escape.mjs` is the only way text the tool did not choose itself (file paths, member and identifier names, label names, author logins, and the config's class names and pair keys) enters a check, a comment or the job summary. A `<code>` wrapper alone does not make such text inert, because GitHub parses Markdown inside it, so the function does four things:
  - it removes control characters, format characters and line and paragraph separators (Unicode categories Cc, Cf, Zl and Zp), which covers line breaks, tabs, bidirectional overrides and zero-width characters;
  - it writes every remaining ASCII character other than a letter, a digit, a space, `/` and `-` as a decimal character reference (`[` becomes `&#91;`), which leaves no Markdown or HTML syntax, no `|` that ends a table cell and no `://` or `www.` for an autolink to start from;
  - it writes `@` as `&#64;<!---->`, because an e-mail address is linked even when its `@` is a character reference, and the empty comment is what stops that;
  - it wraps the result in `<code>`, where no mention and no issue or commit reference is formed.

  Measured through GitHub's Markdown API on hostile samples in a table cell, in running text, in a list item and at the start of a line: no link, image, emphasis, mention or reference forms, every table keeps its shape, and the rendered text equals the input without the removed characters. Such text never goes into a link target or outside that wrapper. The read query takes neither the title nor the branch name of a pull request, so neither reaches any output. The only link the action writes is the peerbus link, a constant.
- **The embedded JSON** is serialized with `<`, `>`, `&` and every `-` that follows a `-` as `\u` escapes, so no value can close the HTML comment that carries it.
- **Logs.** Everything the action prints that can carry text from a pull request (results, the detail of an error, an API response body, the captured output of git or of a mapper) goes through one log serializer in `lib/escape.mjs`: one JSON value on one line, with `#` written as `\u0023`. Such a line begins with a JSON token, so it cannot begin with `::name::`, and it holds no `#`, so it cannot hold `##[name]`: neither command form of the runner can occur in it. Child processes never write to the job log themselves. The tool's own annotations (`::error::`, `::warning::`) carry a message from a fixed set with numbers only; the detail follows on the next line through the serializer. Action outputs are booleans.
- The token is passed to `fetch` and to git through the environment and is never printed. The repository is `GITHUB_REPOSITORY`; the action publishes nowhere else.
- **Files.** Everything derived from pull request content (the fetched objects, the blobs handed to a mapper, the request and state files) stays in the repository's git directory and in the runner's temp directory, under names the tool generates. The installs and builds write where their tools put them: `node_modules` in the action's directory; the .NET SDK, the NuGet package cache and the C# build output in the user profile; Go and its build cache (`~/.cache/go-build`); the Rust toolchain and the cargo registry (`~/.rustup`, `~/.cargo`); Python and the pip cache; and the Go binary, the cargo target directory and the venv in the work directory under the runner's temp directory. Everything they write is derived from this action's own files and from the packages its lockfiles and hashes pin; none of those paths or contents comes from a pull request.
- **Toolchain steps change the job.** `actions/setup-dotnet`, `actions/setup-go` and `actions/setup-python` put their tools on the `PATH` for the rest of the job, and rustup may install the pinned Rust toolchain; the README says so for consumers who run later steps in the same job.

### Quick exit

The probe is the action's first step and uses only the two read queries. The run ends there, green, when all of these hold:

- every open pull request that targets the default branch has the radar's own check on its current head, with an embedded result that is not `degraded`;
- every such result records the `state` fingerprint of the state just read;
- no open pull request that targets another branch still carries a simulated result;
- planning a publish of the recorded results against the read state yields no write.

Otherwise the probe names the first condition that failed and, for a `state` that differs, what moved, which it reads from the recorded `base`, `order` and `inputs`. A push to the default branch changes the base; a push to any pull request changes a head; a change of draft state, review decision or an order label changes `inputs`; a new pull request and a closed one change the list. Each of them changes `state`, and one stale result is enough to scan again, also when it sits on a pull request that did not move itself. A title edit, a comment or a label outside `order.labelPriority` is part of none of them and moves nothing. The `force` input skips the probe.

### The CLI (`pr-conflict-radar.mjs`)

- Phases `probe`, `prepare`, `build <key>` and `scan`, one per action step. `build <key>` runs the build of the registry entry with that config key, with its output captured and logged through the log serializer. `--dry-run` with a phase makes that phase publish nothing; `--dry-run` alone runs `probe`, `prepare`, the build of every needed mapper, one after another, and `scan` in one process.
- Flags: `--config <path>` (default `.github/pr-conflict-radar.json`), `--force`, `--dry-run`.
- The repository is `GITHUB_REPOSITORY`; without it, in a local run, it is read from the URL of the `origin` remote. The token is `GH_TOKEN`, then `GITHUB_TOKEN`; with neither the CLI stops with a message that says so. Commits are fetched from `origin`.
- `prepare` sets one boolean output per registry entry, named by its config key (`typescript`, `csharp`, `go`, `rust`, `cpp`): whether that mapper is needed.
- In the action, the steps between `prepare` and `scan` set up the toolchain of each needed mapper and run its `build`. Run with `--dry-run` alone, the CLI runs those builds itself, with whatever toolchains the machine has. A missing toolchain is a mapper failure whose message names the tool to install.

### The action (`action.yml`)

Inputs: `token` (default `${{ github.token }}`; it has to be able to create check runs, which the workflow token and a GitHub App installation token can and a personal access token cannot), `config` (default `.github/pr-conflict-radar.json`), `dry-run`, `force`. Output: `changed`. The consumer checks out the default branch first (a shallow checkout is enough). Steps:

1. `probe` — Node only, no install; sets `changed`.
2. `prepare`, when `changed` — fetch the listed commits, list each simulated pull request's changed files, decide which mappers are needed (`enabled` true, or `auto` with a matching changed file), set one step output per registry entry, write the state for the scan to a file in the runner's temp directory.
3. One group of steps per registry entry, in registry order, each step gated on `steps.prepare.outputs.<key> == 'true'`; each `build` step has `continue-on-error: true`, so a failed build leaves the scan to take the mapper-failure path:
   - `typescript`: `build typescript` (`npm ci --omit=dev --ignore-scripts` in the action's directory).
   - `csharp`: `actions/setup-dotnet@v6` (`10.x`), `actions/cache@v6` for the NuGet package cache, `build csharp`.
   - `go`: `actions/setup-go@v7` with `go-version-file: ${{ github.action_path }}/members/go/go.mod` and `cache: false`, `build go`.
   - `rust`: `build rust`, with the rustup that GitHub-hosted runners carry; it installs the toolchain `rust-toolchain.toml` pins.
   - `cpp`: `actions/setup-python@v7` (`python-version: '3.12'`), `build cpp`.
4. `scan`, when `changed`.

Only the NuGet restore gets a cache. The other builds are short, measured cold on 8 threads: Go 2.3 s, Rust 3.7 s plus about 6 s to install the toolchain, the `libclang` install under a second plus a 24.5 MB download; a cache restore would cost about as much. The rollout's live run records each step's time (Post-Completion, "Tuning").

The action requires Node.js 20+ and git 2.38+ on the runner, checks both and fails with a clear message; GitHub-hosted runners have them. A needed mapper's toolchain step installs what it needs; on a self-hosted runner without rustup, the Rust build fails and the scan takes the mapper-failure path.

### Workflows (shipped in `examples/`, used by this repository on itself)

**Trigger** (`pr-conflict-radar-trigger.yml`):

```yaml
name: pr-conflict-radar-trigger
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled, ready_for_review, converted_to_draft, closed]
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

- No checkout and no step other than the dispatch; the only permission is `actions: write`; nothing a pull request author controls is interpolated.
- `pull_request_target` runs for pull requests with merge conflicts and from forks, always with the default branch's copy of this file.
- **Review events are included only where that is safe.** `pull_request_review` runs the pull request's own copy of the file and gets a read-only token on forks, so the `if:` skips fork pull requests there instead of failing on them, which leaves a skipped `dispatch` job on a fork pull request after each review. Because it runs on the merge ref, it presumably does not run for a pull request in conflict with its base; the documentation states that only for `pull_request`, so the rollout run confirms it. A review the trigger misses is picked up by the next event or the schedule.
- **Concurrency** is per pull request with `queue: max` and no cancellation: a cancelled run would sit on the pull request's head as a cancelled check, and the job lasts seconds.
- **A dispatch that fails stays off the pull request.** The step has `continue-on-error: true`: when the scan cannot be dispatched, the step shows the error in its log and the job still ends green, so the pull request carries no red radar job. The next push to the default branch and the schedule still scan.

**Scan** (`pr-conflict-radar.yml`):

```yaml
name: pr-conflict-radar
on:
  workflow_dispatch:
    inputs:
      force: {type: boolean, default: false}
      dry-run: {type: boolean, default: false}
  push:
    branches: [main]          # the default branch
  schedule:
    - cron: '23 * * * *'      # optional safety net
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

- **Concurrency.** Every run that publishes shares one group: the pushes, the schedule and the dispatched scans all run on the default branch's ref. With `cancel-in-progress: false` a running scan always finishes publishing, at most one newer run waits, and an older waiting run is dropped in its favour, which loses nothing because every run starts from the current state. A dry run, and a run dispatched from another branch, has a group of its own, so a run that publishes nothing never displaces a waiting one that would. Running without cancellation is the stated exception to the CI rule.
- A dispatch from a branch other than the default one runs as a dry run. That guards against an accident, it is not a boundary: such a run uses that branch's copy of the workflow, and starting it takes write access.
- `statuses: read` is there because the read query takes the check runs from the commit's status rollup.
- This repository's own copy differs in one line: `uses: ./`.

### CI for this repository

`.github/workflows/ci.yml`: `pull_request`, `push` to `main`, `workflow_dispatch`; top-level `permissions: contents: read`; `concurrency` per workflow and ref with `cancel-in-progress: true`; no `paths:` filter.

- job `test` (`name: test`): checkout, the toolchains of the mapper tests (`actions/setup-dotnet@v6` from Task 12, `actions/setup-go@v7` with `go-version-file: members/go/go.mod` from Task 13, the runner's rustup from Task 14, `actions/setup-python@v7` with `3.12` from Task 15), `npm ci`, `npm test` on the runner's default Node; then Node 20 (`actions/setup-node@v7`, the `engines` minimum) and `npm test` again, in the same job so the check name stays `test`. The default Node runs first because `actions/setup-node` puts its Node on the `PATH` for the rest of the job. Under `CI` a mapper test file whose toolchain is missing fails instead of skipping, so a broken setup step cannot pass silently.
- job `lint` (`name: lint`): `npm ci`, `npm run lint`.
- **Lint tool: Biome.** One dev dependency with no JavaScript dependencies of its own, covering lint and formatting in one command (`biome check .`). `biome.json` turns on its VCS integration with `useIgnoreFile`, so nothing under an ignored directory is linted.
- **YAML in tests: `yaml`.** A dev dependency with no dependencies of its own; the tests parse the workflow and action files with it. Both are dev dependencies, so `npm ci --omit=dev` never installs them for a consumer.
- `dependabot.yml` gains the `npm` ecosystem, with major updates of `typescript` ignored; `cargo` and `rust-toolchain` for `/members/rust` (`Cargo.lock` and the `channel` of `rust-toolchain.toml`); and `pip` for `/members/cpp` (`requirements.txt` with hashes). No `gomod` entry: `members/go/go.mod` has no requirements to update. No configured ecosystem reads these pins, so they are updated by hand: the `go` line of `members/go/go.mod`, the Python version in `action.yml` and `ci.yml`, the `#:package` pin in `MemberMap.cs`, and `10.x` and `global.json` for .NET. `libclang` 18.1.1 is the newest wheel published, so the pip entry raises nothing until a newer one appears.

## What Goes Where

- **Implementation Steps**: everything that can be finished on the branch before any merge: the action, its tests, the examples, the workflows the repository runs on itself, CI, the docs, local verification.
- **The rollout plan** (`docs/plans/20261127-pr-conflict-radar-rollout.md`): what needs the pull request merged: the end-to-end run on GitHub, its fixes, the required-checks baseline, preparing the first release.
- **Post-Completion**: the pull request itself, the first fork pull request, tuning the defaults.

## Implementation Steps

### Task 1: Package scaffold and CI

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `biome.json`
- Create: `.github/workflows/ci.yml`
- Modify: `.github/dependabot.yml`
- Create: `test/package.test.mjs`

- [x] write `package.json`: name, `version` `0.1.0`, `type: module`, `engines.node >=20`, scripts `test` (`node --test test/*.test.mjs`) and `lint` (`biome check .`), Biome and `yaml` as the dev dependencies; generate the lockfile
- [x] write `biome.json`, with the VCS integration and `useIgnoreFile` on, and `.github/workflows/ci.yml` per "CI for this repository", with jobs named exactly `test` and `lint`
- [x] add the `npm` ecosystem to `dependabot.yml`
- [x] write a test that `package.json` carries a semver `version`, both scripts and the `engines` range `>=20`, and that `ci.yml`, parsed with `yaml`, has jobs named `test` and `lint`, a top-level `permissions: contents: read` and no `paths:` key
- [x] run `npm test` and `npm run lint` - must pass before task 2

### Task 2: Config loader with defaults and the path classifier

**Files:**
- Create: `members/registry.mjs`
- Create: `lib/config.mjs`
- Create: `lib/classify.mjs`
- Create: `test/config.test.mjs`
- Create: `test/classify.test.mjs`

- [x] create `members/registry.mjs` with the five entries in registry order, each holding its config key and default patterns from "Config"; the build, run and toolchain fields are added by each mapper's task
- [x] implement `loadConfig(path)`: the defaults from "Config" when the file is absent, with the `members` language entries built from the registry; the documented override rule down to the keys of each `members.<language>`; and validation (unknown key at each level, a language key the registry does not hold, unknown class in `commentClasses`, a `severity` that misses a class or names one twice or names an unknown one, empty `classes`, a `maxPrs` outside 1 to 200, a `pairKey` with an unknown placeholder, an `enabled` other than `"auto"`, `true`, `false`, a `suggestPeerbus` that is not a boolean, and each type rule), each error naming the field
- [x] implement glob matching (`**`, `*`, `**/` matching zero directories), `classOf(path, config)` (first match wins, no match takes the most severe class), `mostSevere(classes, config)` and `pairKey(config, repo, a, b)`
- [x] write tests: no config file gives the defaults, `suggestPeerbus: true` and all five languages on `auto` among them; a partial file overrides only its keys; `{"members": {"csharp": {"enabled": true}}}` and `{"members": {"rust": {"enabled": false}}}` keep the default `patterns`; a list replaces the default list; `{"suggestPeerbus": "no"}` is a type error naming the field; a `members.java` key is an unknown key; `members.cpp.defines` defaults to an empty list, accepts `APIENTRY` and `BEGIN_MESSAGE_MAP(...)`, and refuses `A B`, `X=1`, `-Dfoo`, `F(x)` and a 201-entry list, each error naming the entry; each other validation error; an extra registry entry injected in a test becomes a config key with its defaults
- [x] write glob tests for the language patterns: `**/*.h` matches `a.h` and `src/x/a.h` and not `a.hpp`; `**/*.c` does not match `a.cc`; `**/*.ts` matches `types.d.ts`; `**/*.mjs` matches `scripts/run.mjs`
- [x] write tests for glob matching (nested paths, extension patterns, dot directories, a root-level file against `**/*.md`), class resolution with the defaults, a file that matches no class of a config without a catch-all, the direction of `severity`, and the pair key with the lower number first and with a custom template
- [x] run tests - must pass before task 3

### Task 3: Git plumbing and the fixture-repository helper

**Files:**
- Create: `lib/git.mjs`
- Create: `test/fixture-repo.mjs`
- Create: `test/git.test.mjs`

- [x] implement the fixture helper: create a temp repo with a configurable default branch name, commit files, create branches with edits, publish a pull request head on the remote under `refs/pull/<n>/head` only (no branch points at it), add a tag, make a shallow clone, return SHAs, clean up
- [x] implement `assertGitVersion()` (2.38+), `verifyCommit(sha)` and `mergeTree(ours, theirs)` returning `{clean, tree, conflictedPaths}` per the contract in "Simulation", with every git call made through an argument array and its output captured
- [x] implement `commitMerge(tree, ours, theirs)` with the fixed identity, `mergeBase(a, b)`, `fetchCommits(remote, base, heads)` by SHA into `refs/pr-conflict-radar/*` with `--no-tags --no-write-fetch-head`, unshallowing only a shallow clone, and `deleteRefs()`
- [x] implement `changedFiles(base, head)` from `git diff --raw -z -M --no-abbrev`, returning status, path, previous path and both blob ids per file
- [x] write tests: clean merge, textual conflict with the conflicted paths, rename plus edit, a path containing spaces, a default branch that is not `main`
- [x] write failure tests: a missing ref and an unknown SHA are rejected by `verifyCommit` before any merge, the output parser rejects an exit 1 that carries no tree OID, unrelated histories throw, `fetchCommits` throws for a SHA the remote does not have
- [x] write tests that `commitMerge` output can be merged again; that `fetchCommits` fetches a head that only `refs/pull/<n>/head` reaches, in a shallow and in a complete clone, creates only `refs/pr-conflict-radar/*` refs and moves no remote-tracking ref and creates no tag although the remote has a newer default branch and a tag; that `mergeBase` works after `fetchCommits` in a shallow clone; that `deleteRefs` leaves the ref list as it was before the fetch
- [x] write tests for `changedFiles`: addition, deletion, modification, rename with edit, and paths that contain a space, a non-ASCII character, `"`, `\`, a tab and a line break, each returned byte for byte; and that a branch name or path made of shell metacharacters is handled as plain data
- [x] run tests - must pass before task 4

As built: every function of `lib/git.mjs` takes a trailing `{cwd, env}` options object (the repository directory and extra environment, the token's way in). `fetchCommits(remote, base, heads)` takes `heads` as `[{pr, sha}]`, resolves to `{base: ref, heads: {<pr>: ref}}`, and on a commit the remote does not serve throws a `GitError` naming the pull request, with its numbers in `missing`. `mergeBase` throws when there is no common ancestor. `changedFiles` entries are `{status, score, path, previousPath, oldMode, newMode, oldBlob, newBlob}`. A `GitError` carries a fixed message and the captured `stderr` as a property, for the caller to log through the log serializer. The fixture helper builds commits with plumbing directly in a bare remote, so no working tree is involved.

### Task 4: Merge order, pair simulation and the merge train

**Files:**
- Create: `lib/order.mjs`
- Create: `lib/simulate.mjs`
- Create: `test/order.test.mjs`
- Create: `test/simulate.test.mjs`

- [x] implement `predictOrder(prs, config)`, `inputsOf(pr, config)` (the canonical fingerprint of what the order reads from one pull request), `selectPrs(prs, config)` (default-branch target, the first `maxPrs` in predicted order) and `stateOf(baseSha, prs, config)` (the `state` fingerprint)
- [x] implement `simulate(base, prs, config)`: per-pull-request merge into base, pairs in predicted order, train with skip-on-break and the `trainBreak` shape, the checked-pair set, the `maxPrs` note, the run's `state`
- [x] implement the "not simulated" set with its reasons
- [x] write order tests: each rule in isolation and their precedence, an empty `labelPriority`; `inputsOf` changes with the draft flag, the review decision and an order label, and not with another label; `selectPrs` over the limit keeps the first `maxPrs` of the predicted order and reads nothing but the `inputs` fingerprints and the numbers
- [x] write `stateOf` tests: it changes with the base SHA, with any pull request's head SHA, with any `inputs`, with an opened and a closed pull request, and not with the order the pull requests are listed in
- [x] write simulation tests: clean pair, conflicting pair (who merges first, who rebases), a pull request conflicting with base excluded from pairs and from the checked-pair set, a three-way train break where every pair is clean (`multiWay` true, `train` listed), a train break explained by a pair (`multiWay` false), the `maxPrs` note
- [x] write tests for each "not simulated" reason, and that a retargeted pull request with no published result is ignored
- [x] run tests - must pass before task 5

As built: a pull request is the read query's object `{number, baseRefName, headRefOid, author, labels, isDraft, reviewDecision}` (`author` a login or `null`, `labels` a list of names), plus `recorded`, the result the radar's own check on its head embeds or `null`, which Task 7 supplies. `inputsOf` joins `ready`/`draft`, the review decision (empty when there is none) and the order labels in `labelPriority` order, each `encodeURIComponent`-encoded and joined by `,`, with `;` (`ready;REVIEW_REQUIRED;urgent`). `selectPrs(prs, config, defaultBranch)` returns `{selected, leftOut}` and `stateOf(baseSha, prs, config, defaultBranch)` filters on `baseRefName`; both take the default branch name as a last argument. `notSimulated(prs, config, defaultBranch)` in `lib/simulate.mjs` returns `[{pr, reason, note}]` in number order, with `reason` `maxPrs` or `otherBase` and a fixed `note`. `simulate({ref, sha}, prs, config, {cwd, env, concurrency})` resolves to `{base, state, order, pulls, baseConflicts, pairs, checked, train, notSimulated, notes}`: `pulls` maps the number of every pull request that gets a result to its object; `baseConflicts` is `[{pr, files, class}]`; `pairs` lists every checked pair in predicted order as `{first, second, clean, files, class}` (`first` merges first, `second` rebases); `checked` holds their `pairId`s (`<low>+<high>`); `train` is `{merged, breaks}` with each break `{pr, train, files, class, multiWay}`; `notes` holds the `maxPrs` note every result carries. The simulation already classifies: every `files` list is `{path, class}` in path order and `class` is the most severe, so `buildResults` copies them.

### Task 5: Escaping and log safety

**Files:**
- Create: `lib/escape.mjs`
- Create: `test/escape.test.mjs`

- [x] implement the text function per "Security model": the removed character categories, the decimal character references, `&#64;<!---->` for `@`, the `<code>` wrapper
- [x] implement the JSON serializer for the embedded marker and the log serializer (one line, `#` as `\u0023`), and the annotation helper that takes a message from a fixed set and numbers only
- [x] write text tests over hostile samples (a Markdown link, an image, emphasis, strikethrough, a bare URL, a `www.` host, an e-mail address, an `@` mention, an issue reference, an HTML tag, a closing `</code>`, a `|`, a backslash before a `|`, backticks, a line break, a tab, a bidirectional override, a zero-width space): between the wrapper tags the output holds only letters, digits, spaces, `/`, `-`, non-ASCII characters, decimal references and `&#64;<!---->`, and decoding the references gives the input without the removed characters
- [x] write serializer tests: the marker form holds no `<`, `>`, `&` or `--` for a value that carries `-->`, and parses back to the value; the log form of values carrying `##[error]x`, `##[set-output name=changed]false`, `::error::x` and a line break followed by `::add-mask::x` is one line, holds no `#`, begins with a JSON token and parses back to the value
- [x] run tests - must pass before task 6

As built: `lib/escape.mjs` exports `escapeText(value)` (the text function; it returns the `<code>`-wrapped form and converts a non-string with `String`), `markerJson(value)` (the JSON that goes between `<!-- pr-conflict-radar:v1 ` and ` -->`; `embed` and `extract` in Task 6 build the marker around it), `logLine(value)` (also escapes NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR, which JSON leaves raw, and writes `undefined` as `null`), and `annotation(level, message, numbers)`, which returns the `::<level>::<text>` line for a level of `error`, `warning` or `notice` and a key of `ANNOTATION_MESSAGES` (`toolFailed`, `configInvalid`, `tokenMissing`, `repositoryUnknown`, `gitFailed`, `commitsMissing`, `apiFailed`, `mapperFailed`, `buildFailed`), filling its numbered placeholders with finite numbers and throwing a `TypeError` on anything else. A later task that needs another message adds a key to `ANNOTATION_MESSAGES`.

### Task 6: Result model and renderers

**Files:**
- Create: `lib/report.mjs`
- Create: `test/report.test.mjs`

- [x] implement `buildResults(simulation, config, repo)` per "Result schema": `author`, `inputs`, `state`, file classes, pair class, `withAuthor` and `sameAuthor` on every `conflicts` entry, pair keys, `trainBreak`, `notes`, empty `overlaps` and `hints` lists, the "not simulated" form with its `base`, `state`, `order` and `inputs`
- [x] implement `renderCheck(result, config)` (title, summary, text), `renderComment(data, config)` with its resolved form (`data` is the findings and `notified`), and `renderJobSummary(results, config)`, with the Author column, the two groups, the two wordings, the two pair counts, and the pair key and the two fixed peerbus lines gated on `suggestPeerbus` per "Publishing"; `embed(value)`, `extract(text)` and `findings(result, config)`; and the size budget with the reduction of a result and of a comment's `notified` list
- [x] write schema tests: a clean pull request, a code conflict, a docs-only conflict, a base conflict, a train break of each kind, a "not simulated" one, the note that names a pull request this one was not checked against; `author`, `withAuthor` and `sameAuthor` for a same-author pair, a different-author pair and a pull request with no author login
- [x] write renderer tests: conclusion per case, a title made of fixed words and counts, the Author column, other authors' rows before the separate own group, the different-author wording (plain login with no `@`, pair key listed), the same-author wording (both theirs, one session, key optional), the key present in the JSON in both cases, the configured check name and pair-key template, the line for a multi-way train break, the two pair counts in the job summary
- [x] write `suggestPeerbus` tests: by default a cross-author conflict's check summary and comment hold the "Pair key" column, the key and the different-author peerbus line with its link, a same-author conflict holds the key marked optional and the optional line, and the overlaps table and the job summary hold the key; with `suggestPeerbus: false`, the check summary, the check text outside the embedded marker, the comment outside the marker and the job summary contain no case-insensitive "peerbus", no "Pair key" column and no pair key (also with a custom `pairKey` template), each table has one column fewer, and the embedded JSON of the check and of the comment still carries every `key`; the result JSON contains no "peerbus" in either state
- [x] write injection tests: a file path, a member name, a label and an author login that carry a table-cell break, an HTML tag, a Markdown link, an `@` mention, backticks, a line break and a `-->` sequence leave the table's column count and the embedded marker intact, appear only in escaped form, and `extract` returns the original strings
- [x] write tests for marker round-trip and malformed input; that `findings` is equal across a changed `base`, `head`, `state`, `inputs`, `hints` and an `order` that keeps the listed pairs' direction, and differs on a changed file list, a flipped direction and a new pair; that only `commentClasses` pairs are in it
- [x] write size tests: a pull request conflicting with 39 others over 20 paths of 100 characters stays under the budget in every field, sets `truncated` and still round-trips; reducing the reduced result changes nothing; the findings of the reduced result equal the findings its comment embeds; a comment whose `notified` list holds 100 keys beyond its rows, each 200 characters long, stays under the budget by dropping old keys that are on no current row and never a current row's key
- [x] run tests - must pass before task 7

As built: `lib/report.mjs` exports `buildResults(simulation, config, repo)` (complete results in number order; the not-checked notes name the pull requests that conflict with the base and the ones left out by `maxPrs`), `findings(result, config)`, `embed(value)`, `extract(text)` (the last marker of the text; `null` unless it parses to an object with `schema` 1), `reduceResult(result)` and `reduceComment(data)` (both return their argument unchanged when its embedded form fits `EMBED_BUDGET`, 45,000 characters, so the rendered fields stay under `BUDGET`, 60,000), `renderCheck(result, config)` returning `{name, conclusion, title, summary, text}` (it reduces first), `renderComment(data, config)` (it reduces first) and `renderJobSummary(results, config, {writes: {checks, comments}, dryRun})`, plus the constants `SCHEMA`, `PEERBUS_LINK`, `PEERBUS_LINE`, `PEERBUS_OPTIONAL_LINE` and `RESOLVED_LINE`. A reduction records the left-out counts as `filesOmitted`, `membersOmitted` and `namesOmitted` on the entry whose list it shortened; a comment's data gets `truncated: true` only when its lists had to be capped after the old `notified` keys were dropped. The overlaps table in the check summary and the hints in the check text and the job summary are rendered from the `overlaps` and `hints` lists already, so Task 16 fills those lists and needs no new rendering. Bounding `notified` to the current rows plus 100 when a key is added stays with `planPublish` (Task 8).

### Task 7: GitHub client

**Files:**
- Create: `lib/github.mjs`
- Create: `test/github.test.mjs`

- [x] implement `readState()` over an injected `fetch`: the state query with pagination, returning the default branch's name and head SHA and, per open pull request, its fields, the check runs named `checkName` on its head (id only) and the marker comments the token's identity wrote; the continuation of a rollup and of a comment list past 100 entries; the second query for the `text` of those check runs, and the choice of the radar's own check per "Publishing"
- [x] implement the REST writes: `createCheckRun`, `updateCheckRun` (both with `output.title`), `createComment`, `updateComment`, `deleteComment`, all against `GITHUB_REPOSITORY` only
- [x] surface API errors with status, endpoint and response body (GraphQL `errors` included) through the log serializer and never with the token; retry once on 5xx and on a secondary rate limit
- [x] write tests with a `fetch` fake: pagination, the default-branch split with a default branch that is not `main`, a fork pull request, check found versus absent, the radar's check on the second page of a rollup with more than 100 contexts, the comment continuation, and that the state query asks for no `text`
- [x] write identity tests: a comment with the marker from another author is not returned; a check run with the radar's name and no embedded result, and one whose result names another pull request, are not the radar's; of two that qualify the newer one is taken
- [x] write tests for error surfacing (REST status, GraphQL `errors` with HTTP 200, no token in the message, a response body carrying `##[error]` logged without a `#`), the single retry, and the `output.title` in both check writes
- [x] run tests - must pass before task 8

As built: `lib/github.mjs` exports `createGitHub({token, repo, fetch, apiUrl, sleep})` and `GitHubError` (`status`, `endpoint`, `body`). The client's `readState(config)` resolves to `{base: {ref, sha}, pulls}`: `base` is the default branch's name and head SHA, in the `{ref, sha}` form `simulate` takes, and each pull request is `{number, baseRefName, headRefOid, author, labels, isDraft, reviewDecision, fork, recorded, checkRunId, comments}` in number order, with `recorded` the result of the radar's own check on its head (or `null`) and `checkRunId` that check's id, and `comments` the radar's own marker comments `[{id, body}]` in creation order (a comment with the marker by the token's identity counts even when the marker is malformed, so the probe can judge it; Task 8 and 9 pick the newest and treat extra ones). The writes are `createCheckRun(headSha, check)` and `updateCheckRun(id, check)`, where `check` is what `renderCheck` returns, `createComment(number, body)`, `updateComment(id, body)` and `deleteComment(id)`; the creates resolve to `{id}`. `MARKER_PREFIX` is exported from `lib/report.mjs`.

### Task 8: Publisher with change detection and the comment lifecycle

**Files:**
- Create: `lib/publish.mjs`
- Create: `test/publish.test.mjs`

- [x] implement `planPublish(results, state, config)`: the ordered list of writes, every check write before any comment write; a check is written when the result differs from the recorded one, a comment only when the body it would get (its findings with the kept rows of unchecked pairs, its `notified` list and the wording `suggestPeerbus` selects) differs from its current body; a new member is a row whose key is not in the comment's `notified` list, and the list is carried over and bounded per "Result schema"
- [x] implement `publish(results, state, client, config)` executing the plan one write after another, and the comment lifecycle from "Publishing"
- [x] write tests for each lifecycle transition: first conflict (create, `notified` holds its key), a new member (delete and create, the new key appended), a pair gone while another remains (edit), a changed file list and a flipped direction (edit), the last pair gone (resolved form, `notified` unchanged), a conflict with a new partner after the resolved form (delete and create), an identical result (no write)
- [x] write notification tests: a pair that conflicts, resolves and conflicts again three times re-creates the comment only the first time and is edited in place after that; a genuinely new partner re-creates it even while an earlier key sits in the list; the list survives the resolved form; with 101 notified keys that are on no current row the oldest is dropped and no current row's key ever is; changing `pairKey` makes each listed pair a new member once
- [x] write a test that toggling `suggestPeerbus` (an otherwise identical result) edits every comment in place and never deletes or re-creates one
- [x] write tests for unchecked pairs: the other pull request conflicts with the base (row kept, no comment write), this pull request is left out by `maxPrs` (check replaced, comment untouched), the pair is checked again and still conflicts (no new member, no re-creation), the other pull request is closed (row dropped), this pull request targets another branch (check replaced, comment in its resolved form)
- [x] write a test that a result differing only in `state`, `base` and `order` gives one check update per pull request and no comment write
- [x] write a both-sides test: a conflicting pair produces check and comment writes on both pull requests within one `publish` call, with all check writes before the first comment write
- [x] write tests for a head that changed (new check on the new SHA), a partial previous publish (the plan holds exactly the missing writes), and a truncated result (planning its own published output again yields no write)
- [x] run tests - must pass before task 9

As built: `lib/publish.mjs` exports `planPublish(results, state, config)`, `publish(results, state, client, config)`, `boundNotified(notified, currentKeys)`, `isCheckWrite(write)`, `WRITE` and `NOTIFIED_EXTRA` (100). `state` is what `readState` resolves to; `results` may be complete or already reduced, and the probe passes the recorded results. A write is `{op, pr, reason, ...}` with `op` one of `createCheckRun` (`head`, `check`), `updateCheckRun` (`id`, `check`), `createComment` (`body`), `updateComment` (`id`, `body`) and `deleteComment` (`id`); `reason` is `missing` or `changed` for a check and `created`, `newMember`, `changed`, `resolved`, `malformed`, `replaced` or `duplicate` for a comment. Checks come first in number order, then the comment writes grouped per pull request in number order. A check is compared as `reduceResult(result)` against `recorded` (only when the recorded check sits on the result's `head`), and the comment's findings are taken from the reduced result. The checked-pair set is derived from the results (both simulated, neither `conflictsWithBase`). The newest of a pull request's own comments is its comment; every older one is deleted (`duplicate`). For a new member the fresh comment is created before the old one is deleted, so an interrupted publish leaves two comments and loses no `notified` key. A comment whose marker does not read as this pull request's data counts as having no rows and an empty `notified` list. `notified` is bounded only when a key is added, so the resolved form keeps the list unchanged. `publish` resolves to `{checks, comments, writes}`, the counts of the writes made, and stops at the first failed write.

### Task 9: Quick-exit probe

**Files:**
- Create: `lib/probe.mjs`
- Create: `test/probe.test.mjs`

- [x] implement `probe(state, config)` returning `{changed, reason}` per "Quick exit"
- [x] write the quick-exit tests: a state whose results all record the current `state`, with matching comments, gives `changed: false`; so does one with a pull request left out by `maxPrs` that carries its "not simulated" result, and one with a truncated result
- [x] write the no-quick-exit tests, each asserting the reason: a push to the default branch, a push to a head, an order-label change, a draft or review-decision change, a new pull request, a closed one, a retargeted one with a simulated result, a degraded result, a malformed marker, a comment missing after an interrupted publish
- [x] write the stale-result tests: one pull request's check records the current `state` and another's the previous one after an interrupted publish; a head moved back to a commit that still carries an older check; each gives `changed: true`
- [x] write a test that a label outside `order.labelPriority`, a title edit and a new comment leave `changed: false`
- [x] write a test that a resolved comment carrying `notified` keys, and a comment whose rows' keys are all in its `notified` list, leave `changed: false` when nothing moved, and that a comment whose `notified` list misses a current row's key gives `changed: true`
- [x] run tests - must pass before task 10

As built: `lib/probe.mjs` exports `probe(state, config)` and `REASON`. `probe` returns `{changed, reason, pr, message}`: `reason` is a key of `REASON` (`unchanged`, `checkMissing`, `degraded`, `baseMoved`, `prClosed`, `prRetargeted`, `prAdded`, `inputsChanged`, `stale`, `otherBaseResult`, `publishPending`), `pr` the pull request it names when it names one, and `message` one line of fixed words and numbers for the log. The conditions are checked in the order of "Quick exit"; for a stale `state` it names, in this order, a moved base, a recorded `order` entry that is closed or retargeted, a selected pull request missing from a recorded `order`, and changed `inputs` of a stale result's own pull request, and falls back to `stale`. The fourth condition plans a publish of the results the radar's own checks on the current heads record, other-branch pull requests included.

### Task 10: CLI entry and the composite action

**Files:**
- Create: `pr-conflict-radar.mjs`
- Create: `action.yml`
- Create: `lib/members.mjs`
- Create: `test/cli.test.mjs`
- Create: `test/action.test.mjs`
- Create: `test/members.test.mjs`

- [x] implement `mappersNeeded(config, changedFiles)` in `lib/members.mjs`: per registry entry, `true` always, `false` never, `auto` when a changed file of a simulated pull request matches its `patterns`
- [x] implement the CLI per "The CLI": the phases `probe`, `prepare`, `build <key>` and `scan` with the state file handed from `prepare` to `scan` in the runner's temp directory, one `prepare` output per registry entry, `build <key>` running that entry's build in the work directory (an entry without a build yet is a clear error), `--config`, the repository and token resolution, and `--dry-run`; `--force` and `--dry-run` skip the quick exit; the scan deletes its refs when it ends; exit non-zero only on tool failure, with an error annotation from the fixed set and the detail on the next line through the log serializer
- [x] write `action.yml` per "The action" with the steps `probe`, `prepare` and `scan`: inputs, the `changed` output, the gates on `changed`, the Node and git version checks; each mapper task adds its own gated steps between `prepare` and `scan`
- [x] write an end-to-end test: a fixture repo with three pull request heads plus a `fetch` fake, asserting the published checks on every pull request, the comments on both pull requests of the conflicting pair and the job summary, which counts the check writes and comment writes made; a second run over the resulting state takes the quick exit and makes no git fetch and no write; a comment with the marker from another author and a check run that only shares the radar's name sit in the fake from the start, no write ever targets either, and the radar creates its own
- [x] write tests for `--dry-run` (no write calls, no quick exit, the planned write count printed, no ref left behind), for `--force`, for a run with no config file and one with `--config`, for the repository read from `GITHUB_REPOSITORY` and from an `origin` URL in both the https and the ssh form, for a missing token, for the exit code on a tool failure, and for a listed commit the remote does not serve
- [x] write a log test: a file path carrying `##[error]x` and one carrying a line break followed by `::error::x` reach the log only inside serialized lines, and no line of the whole run's output starts with `::` or contains `##[` except the tool's own fixed annotations
- [x] write tests for `mappersNeeded` (`false`, `true`, `auto` with and without a matching changed file, a file of a pull request that is not simulated, a `.h` file turning on `cpp` and a `.jsx` file turning on `typescript`) and that `prepare` writes one boolean output per registry entry, named by its key; write a test that `build <key>` runs an injected registry entry's build (a harmless `node -e` command) once with its working directory and environment, captures its output, and fails with a message naming the tool when the command is missing
- [x] write a test that `action.yml`, parsed with `yaml`, declares the documented inputs and output and runs `prepare` and `scan` only when `changed`
- [x] run tests - must pass before task 11

As built: `lib/members.mjs` exports `mappersNeeded(config, changedFiles, {registry})` (`changedFiles` are path strings, `{<key>: boolean}` back), `runBuild(entry, {dir, work, env})`, `mapperDir(entry, root)`, `ACTION_DIR` and `BuildError`. A registry entry's `build({dir, work, env})` returns `[{command, args, cwd, env}]`, where a step's `env` is that command's complete environment (the inherited one when absent); a mapper task adds it to its entry. `pr-conflict-radar.mjs` exports `main(argv, {env, cwd, fetch, registry, stdout, sleep})`, resolving to the exit code, and `repositoryFromUrl`. `prepare` fetches `origin` by the SHAs of the selected pull requests, lists each one's changed files from its merge base (a rename counts both paths) and writes `<RUNNER_TEMP>/pr-conflict-radar/state.json` (the read state and the repository); the phases need `RUNNER_TEMP`, while `--dry-run` alone uses a temp directory of its own. `scan` simulates the commits of that state, publishes (or with `--dry-run` only plans), writes the job summary to `GITHUB_STEP_SUMMARY`, prints the complete results as one log-serialized line and deletes its refs in every case. `--dry-run` alone builds only the needed entries that have a `build`, as the action has a step only for those. With no phase and no `--dry-run` the CLI prints its usage and exits 2. Git reaches the remote with the credentials the checkout already configured; the token is passed to the GitHub client only. The new annotation `nodeUnsupported` covers the Node check. The step `Check Node.js and git` of `action.yml` runs before `probe`; flags reach the CLI through step environment variables, never through the script text. `test/fake-github.mjs` is a stateful fake of the API for tests that publish.

### Task 11: Changed ranges and the TypeScript and JavaScript member mapper

**Files:**
- Modify: `lib/git.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/dependabot.yml`
- Modify: `members/registry.mjs`
- Create: `members/typescript/member-map.mjs`
- Create: `test/ranges.test.mjs`
- Create: `test/member-map-typescript.test.mjs`
- Create: `test/fixtures/typescript/` (fixture files)
- Modify: `action.yml`
- Modify: `test/action.test.mjs`

- [x] implement `changedRanges(oldBlob, newBlob)` in `git.mjs` from the hunk headers of the blob diff in "Member overlap", with the whole-file range for an added and for a deleted file
- [x] add `typescript` as the one runtime dependency, pinned exactly to the latest 6.0 release after confirming it exposes `createSourceFile`; ignore its major updates in `dependabot.yml`
- [x] fill the `typescript` registry entry: its build (`npm ci --omit=dev --ignore-scripts` in the action's directory, skipped when `typescript` already resolves there) and its run; test that the build leaves an existing full install, dev dependencies included, untouched
- [x] add the `build typescript` step to `action.yml` between `prepare` and `scan`, gated on the `typescript` output of `prepare`, and extend `test/action.test.mjs` to assert the step, its gate and its place
- [x] implement the mapper per "Member overlap" with `ts.createSourceFile` and the `ScriptKind` of each extension (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`); the contract with `maxFileBytes`; parse diagnostics and a `RangeError` become an error on that entry
- [x] write range tests: pure addition, pure deletion, modification, rename with edit, new file, deleted file, a hunk whose header carries trailing text, a repo whose config sets `diff.noprefix`, `diff.external` and `color.ui=always`, and a checkout whose `.gitattributes` marks the file `-diff`
- [x] write mapper tests on fixtures whose request `path` ends in `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs`: member resolution for a changed body line, `declarationTouched` for a changed signature, a removed member (base-side run), nested and qualified names (a method in a class in a namespace), identifiers on added lines, JSX in a `.js` file, a TypeScript generic arrow function in a `.ts` file, a file with a syntax error, a file nested thousands of levels deep and a file over `maxFileBytes` (each reported on its entry, the mapper exits 0), several runs started at once after the single `npm ci`, and that a fixture containing top-level side effects is parsed without being executed
- [x] run tests - must pass before task 12

As built: `lib/git.mjs` exports `changedRanges(oldBlob, newBlob, {cwd, env})`, resolving to `{old, new}`, each a list of `{start, end}` (1-based, inclusive lines) taken from the hunk headers of the blob diff (run with `--text` as well, so a `-diff` attribute cannot turn it binary); an absent blob (`null` or the all-zero id of an added or deleted file) makes the other side one whole-file range, and `parseHunkRanges(stdout)` is the pure parser. A mapper request entry is `{id, path, file, ranges}` with `ranges` as `[{start, end}]`; the response is one JSON array of `{id, members, identifiers}` or `{id, error}` entries, with `members` as `{name, kind, declarationTouched}` and `identifiers` the sorted unique names. A registry entry's `run({dir, work, env, request, maxFileBytes})` returns one `{command, args, cwd, env}` (no `defines`; Task 15 adds it for `cpp`), and the typescript one starts `process.execPath` on `members/typescript/member-map.mjs` with `work` as its working directory. TypeScript kinds: `function`, `component` (a capitalised function or arrow-function constant in a `.tsx` or `.jsx` file), `class`, `method`, `constructor`, `getter`, `setter`, `property`, `const` (exported only), `interface`, `type`, `enum`, `enumMember`, `namespace`. A container (`class`, `enum`, `namespace`) is reported only when its own header lines are touched, so two pull requests that change different methods of one class do not overlap on the class; overloads of one name merge into one member. `biome.json` leaves `test/fixtures` out of the checks, because fixtures hold files with syntax errors.

### Task 12: C# member mapper on Roslyn

**Files:**
- Create: `members/csharp/MemberMap.cs`
- Create: `members/csharp/Directory.Build.props`
- Create: `members/csharp/Directory.Build.targets`
- Create: `members/csharp/Directory.Packages.props`
- Create: `members/csharp/global.json`
- Create: `members/csharp/nuget.config`
- Create: `test/member-map-csharp.test.mjs`
- Create: `test/fixtures/csharp/` (fixture files)
- Modify: `members/registry.mjs`
- Modify: `action.yml`
- Modify: `test/action.test.mjs`
- Modify: `.github/workflows/ci.yml`

- [x] add the five stop files: `<Project/>` for the two `Directory.Build.*` files; `<Project><PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup></Project>` for `Directory.Packages.props`; a `global.json` with `{"sdk": {"version": "10.0.100", "rollForward": "latestFeature"}}`; a `nuget.config` whose `packageSources` holds `<clear/>` and nuget.org and whose `packageSourceMapping` holds `<clear/>`
- [x] implement `MemberMap.cs` as a single-file .NET 10 app with a pinned `#:package Microsoft.CodeAnalysis.CSharp@<version>`: `CSharpSyntaxTree.ParseText`, map ranges to methods, constructors, properties, indexers, operators, fields, events, local functions and enum members, qualified by containing types and namespace; one request covering many files, the contract of "Member overlap" with `maxFileBytes`; a syntax error or an exception while parsing one file becomes an error on that entry
- [x] fill the `csharp` registry entry: its build (`dotnet build MemberMap.cs` with `members/csharp` as the working directory) and its run (`dotnet run --no-build MemberMap.cs -- <request> <maxFileBytes>`, same working directory)
- [x] add the `actions/setup-dotnet@v6`, `actions/cache@v6` NuGet cache and `build csharp` steps to `action.yml` between `prepare` and `scan`, gated on the `csharp` output of `prepare`; extend `test/action.test.mjs` to assert the steps, their gate and their place; add `actions/setup-dotnet@v6` to the `test` job of `ci.yml`
- [x] write black-box tests with one build through the registry in a `before` hook and the registry's run in every test, both from `members/csharp`: changed body line, changed signature, removed member (base-side run), partial class, nested type, identifiers on added lines, file with a syntax error, a deeply nested file, a file over `maxFileBytes` (an entry comes back, the tool exits 0); the file is skipped with a message when no .NET SDK is on the `PATH`, and fails instead when `CI` is set
- [x] write a test that several runs started at once after the single build all succeed, and a test that a copy of `members/csharp` still builds inside a parent directory that holds a `Directory.Packages.props` with central package management on, a `global.json` pinning an absent SDK and a `nuget.config` with `<clear/>` and an unreachable feed
- [x] run tests - must pass before task 13

As built: the `csharp` registry entry builds with `dotnet build MemberMap.cs` and runs `dotnet run --no-build MemberMap.cs -- <request> <maxFileBytes>`, both in the mapper directory with `DOTNET_NOLOGO`, `DOTNET_CLI_TELEMETRY_OPTOUT` and `DOTNET_SKIP_FIRST_TIME_EXPERIENCE` set; `MemberMap.cs` pins `Microsoft.CodeAnalysis.CSharp@5.12.0`. The request and response shapes are those of the TypeScript mapper. C# kinds: `namespace`, `class`, `struct`, `interface`, `record` (also record structs), `enum`, `enumMember`, `delegate`, `method`, `constructor` (named `constructor`, or `static constructor`), `destructor`, `property`, `indexer` (`this[]`), `operator` (`operator +`, `operator implicit int`), `field`, `event` and `localFunction` (qualified by its member and any enclosing local function); an explicit interface implementation is named `IFoo.Bar`. A container (namespace, type, enum) is reported only when its own header lines are touched, and overloads, partial parts and the variables of one name merge into one member. Only `\n` ends a line, as in git. A file whose brackets nest deeper than 1000 is an entry error before parsing (Roslyn parses deep expressions in more than linear time), as are types nested deeper than 200. `action.yml` sets up .NET with `dotnet-version: 10.0.x` and caches `~/.nuget/packages` under `nuget-<os>-<action ref>` before the build step.

### Task 13: Go member mapper on go/parser

**Files:**
- Create: `members/go/member-map.go`
- Create: `members/go/go.mod`
- Create: `test/member-map-go.test.mjs`
- Create: `test/fixtures/go/` (fixture files)
- Modify: `members/registry.mjs`
- Modify: `action.yml`
- Modify: `test/action.test.mjs`
- Modify: `.github/workflows/ci.yml`

- [x] write `members/go/go.mod` (module `membermap`, the `go` line of the then-current Go release, no requirements) and `member-map.go` per "Member overlap": standard library only, `parser.ParseFile` with `parser.AllErrors | parser.SkipObjectResolution`, the Go member kinds qualified by package and receiver type, identifiers from `go/scanner`, the contract with `maxFileBytes`; a syntax error, including the nesting limit, becomes an error on its entry
- [x] fill the `go` registry entry: its build (`go build -o <work>/member-map-go .` in `members/go` with the Go environment of "Member overlap") and its run
- [x] add the `actions/setup-go@v7` (`go-version-file` pointing at the action's `members/go/go.mod`, `cache: false`) and `build go` steps to `action.yml` between `prepare` and `scan`, gated on the `go` output of `prepare`; extend `test/action.test.mjs` to assert the steps, their gate, their place and the `go-version-file`; add `actions/setup-go@v7` with `go-version-file: members/go/go.mod` to the `test` job of `ci.yml`
- [x] write black-box tests with one build through the registry in a `before` hook and the binary run in every test: changed body line, changed signature (`declarationTouched`), removed member (base-side run), a method on a pointer receiver and one on a value receiver both qualified by the type, a struct field and an interface method, package-level `var` and `const` in a group, identifiers on added lines, a file with a build tag (parsed), a file with a syntax error (an error on its entry, no members), 900,000 nested parentheses (an error on its entry), a file over `maxFileBytes`, the tool exiting 0 in each case; several runs started at once after the single build all succeed; the file is skipped with a message when `go` is not on the `PATH`, and fails instead when `CI` is set
- [x] write a leak test: a copy of `members/go` inside a parent directory that holds a `go.mod` and a `go.work` that does not list it builds through the registry, also with `GOFLAGS=-modfile=/nonexistent/go.mod` in the environment and a `GOENV` file that sets the same
- [x] run tests - must pass before task 14

As built: `members/go/go.mod` has the line `go 1.27.1`; the `go` registry entry builds `go build -o <work>/member-map-go .` in the mapper directory (`.exe` suffix on Windows) with every `GO` plus capitals/digits variable other than `GOROOT`, `GOPATH`, `GOCACHE` and `GOMODCACHE` removed and the fixed values of "Member overlap", and runs the binary from `work`. Go kinds: `function`, `method` (qualified `pkg.Type.Name`, also for interface methods), `type` (a struct or interface type is a container, reported only when its header lines up to the opening brace are touched; other types are reported whole), `field` (embedded fields by their type name), `embedded` (an embedded interface element), `var` and `const` (one member per name, `_` skipped). Lines are those of the file, so a `//line` directive does not move them; only `\n` ends a line. `action.yml` sets up Go from `${{ github.action_path }}/members/go/go.mod` with `cache: false`.

### Task 14: Rust member mapper on syn

**Files:**
- Create: `members/rust/Cargo.toml`
- Create: `members/rust/Cargo.lock`
- Create: `members/rust/rust-toolchain.toml`
- Create: `members/rust/src/main.rs`
- Create: `test/member-map-rust.test.mjs`
- Create: `test/fixtures/rust/` (fixture files)
- Modify: `members/registry.mjs`
- Modify: `action.yml`
- Modify: `test/action.test.mjs`
- Modify: `.github/dependabot.yml`
- Modify: `.gitignore`

- [x] write `Cargo.toml` (`publish = false`, `[workspace]`, the dependencies and features of "Member overlap", each pinned to its then-latest version), `rust-toolchain.toml` (`channel` the then-current stable as an exact version, `profile = "minimal"`), and generate and commit `Cargo.lock`; add `members/rust/target/` to `.gitignore`
- [x] implement `src/main.rs` per "Member overlap": the Rust member kinds with their qualifiers, lines from `proc-macro2` spans, identifiers from the tokens on the given lines, the contract with `maxFileBytes`; each entry parsed in a child process (the binary re-run on that entry), a `syn` error, a dead child and a child over 20 seconds each becoming an error on that entry
- [x] fill the `rust` registry entry: its build (read `channel`, `rustup toolchain install <channel> --profile minimal --no-self-update`, `cargo build --release --locked --manifest-path …` from an empty directory in the work directory, with the environment of "Member overlap") and its run
- [x] add the `build rust` step to `action.yml` between `prepare` and `scan`, gated on the `rust` output of `prepare`; extend `test/action.test.mjs` to assert the step, its gate and its place; `ci.yml` needs no new step, because GitHub-hosted runners carry rustup and the registry build installs the pinned toolchain, and a missing rustup fails the test file under `CI`
- [x] add the `cargo` and `rust-toolchain` ecosystems for `/members/rust` to `dependabot.yml`
- [x] write black-box tests with one build through the registry in a `before` hook and the binary run in every test: changed body line, changed signature (`declarationTouched`), removed member (base-side run), an inherent method (`Cart::add`) and a trait method (`<Cart as Total>::total`), struct fields, enum variants and trait items, a function in an inline module (`inner::helper`), consts and statics, identifiers on added lines, including inside a macro invocation, a file with a syntax error (an error with its line), 10,000 nested parentheses (an error on that entry while the other entries of the request keep their members), a file over `maxFileBytes`, the tool exiting 0 in each case; several runs started at once after the single build all succeed; the file is skipped with a message when `rustup` is not on the `PATH`, and fails instead when `CI` is set
- [x] write a leak test: a copy of `members/rust` inside a parent directory that holds a `Cargo.toml` with `[workspace]`, a `rust-toolchain.toml` naming an absent toolchain and a `.cargo/config.toml` with a crates.io source replacement to a missing directory, a bogus `build.rustflags`, `build.rustc-wrapper` and `build.target` builds through the registry, also with `RUSTFLAGS` and `RUSTC_WRAPPER` set to bogus values in the environment; the build never runs with a working directory inside the copied tree
- [x] run tests - must pass before task 15

As built: `members/rust` is a binary crate `member-map` (edition 2024) pinned to `syn =3.0.10`, `proc-macro2 =1.0.107` (`span-locations`), `quote =1.0.47` (for the spaced token text of an unusual impl self type) and `serde_json =1.0.154`, with `rust-toolchain.toml` at `channel = "1.100.0"`. The `rust` registry entry reads `channel`, creates `<work>/rust-build` (the empty directory both steps run from), runs `rustup toolchain install <channel> --profile minimal --no-self-update` and `cargo build --release --locked --manifest-path <dir>/Cargo.toml`, with `RUSTUP_TOOLCHAIN` and `CARGO_TARGET_DIR=<work>/cargo-target` set and every other `CARGO_*` (except `CARGO_HOME`), `RUSTC*`, `RUSTDOC*`, `RUSTFLAGS` and `RUSTUP_TOOLCHAIN` variable removed; it runs `<work>/cargo-target/release/member-map` from `work`. Each entry is parsed by the binary re-run as `member-map --entry <maxFileBytes>` with the entry on its standard input; a child that dies or outlives 20 seconds becomes the entry error `the parser failed on the file` or `the parser took longer than 20 seconds`, a `syn` error becomes `syntax error at line N`. Rust kinds: `function`, `method` (impl and trait functions), `const`, `static`, `type` (aliases, impl and trait associated types), `struct`, `union`, `enum`, `variant`, `field` (named fields only), `trait`, `module` and `macroRules`. A struct, union, enum, trait or inline module is a container, reported only when its header lines up to the opening brace are touched; an `impl` is a qualifier only and is never a member itself. Overloads of one name (for example `cfg` variants) merge into one member. Identifiers skip keywords and lifetime names. `action.yml` has a `build-rust` step after `build-go`; `ci.yml` needs none.

### Task 15: C and C++ member mapper on libclang

**Files:**
- Create: `members/cpp/member_map.py`
- Create: `members/cpp/requirements.txt`
- Create: `test/member-map-cpp.test.mjs`
- Create: `test/fixtures/cpp/` (fixture files)
- Modify: `members/registry.mjs`
- Modify: `action.yml`
- Modify: `test/action.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/dependabot.yml`
- Modify: `test/cli.test.mjs` (its no-build case injects an entry without a build, since every default entry has one)

- [x] write `requirements.txt` with `libclang` pinned exactly to its latest release and the hash of every wheel of that release (no hash for the sdist)
- [x] implement `member_map.py` per "Member overlap": the parse arguments and options (single-file, keep-going, skip-function-bodies, `-ferror-limit=0`, one `-D` per validated `members.cpp.defines` entry read from the third argument), the two-pass synthesized prelude with its line shift, the `macro` kind, the language per extension, the C/C++ member kinds qualified through the semantic parent, only cursors located in the parsed file, identifiers from clang tokens, the contract with `maxFileBytes`; each entry parsed in a child process through the same interpreter with `-I`, a dead child and a child over 20 seconds each becoming an error on that entry
- [x] fill the `cpp` registry entry: its build (a venv in the work directory, then `pip install --require-hashes --only-binary :all: --no-deps -r members/cpp/requirements.txt` through the venv's interpreter with `-I`) and its run
- [x] add the `actions/setup-python@v7` (`python-version: '3.12'`) and `build cpp` steps to `action.yml` between `prepare` and `scan`, gated on the `cpp` output of `prepare`; extend `test/action.test.mjs` to assert the steps, their gate and their place; add `actions/setup-python@v7` with `3.12` to the `test` job of `ci.yml`
- [x] add the `pip` ecosystem for `/members/cpp` to `dependabot.yml`
- [x] write black-box tests with one build through the registry in a `before` hook and the venv's interpreter run in every test, on fixture files whose `#include`s resolve to nothing and whose macros are undefined: changed body line, changed signature (`declarationTouched`), removed member (base-side run), an out-of-line method in nested namespaces (`acme::ui::Widget::resize`) and an out-of-line constructor, fields, a function template, enum constants, a `.c` file and a `.h` header, both branches of an `#ifdef`, identifiers on added lines including a macro name, `#include "/dev/zero"` (the parse ends at once), a `constexpr` loop of 10^12 steps (the parse ends within a second), 100,000 chained `!` (an error on that entry while the other entries keep their members), a file over `maxFileBytes`, the tool exiting 0 in each case; the prelude: a `.cpp` file whose class, nested class, namespace-qualified class and class template are all declared only in an unresolved header still reports every out-of-line method, constructor and destructor with its original line numbers, a member typed `std::map<K, std::vector<V>>` and the member after it are both reported, a name the file declares itself is not synthesized (no redefinition), nothing is reported on the synthesized line, and a file with no undeclared identifier is parsed once; an error inside one function body leaves every later member reported; a calling-convention macro (`int APIENTRY Start(void)`) loses that function without `defines` and reports it with `defines: ["APIENTRY"]`; a message-map block (`BEGIN_MESSAGE_MAP(...)` … `END_MESSAGE_MAP()`) followed by method definitions reports them with the two function-like entries in `defines`; a `TEST_F(Suite, Name) { … }` block comes back with `kind: "macro"`; a `defines` entry that fails the pattern is refused by the mapper as well as by the config loader; several runs started at once after the single build all succeed; the file is skipped with a message when `python3` with the `venv` module is not on the `PATH`, and fails instead when `CI` is set
- [x] write a leak test: with a `clang` package planted in the working directory, beside a copy of the mapper script and on `PYTHONPATH`, the mapper still loads the venv's `clang.cindex`
- [x] run tests - must pass before task 16

As built: `members/cpp/requirements.txt` pins `libclang==18.1.1` with the hashes of its nine wheels. The `cpp` registry entry builds with `python3 -I -m venv <work>/cpp-venv` (`python` on Windows), then the venv's interpreter runs `-I -m pip install --require-hashes --only-binary :all: --no-deps -r <dir>/requirements.txt`, both from `work` with every `PIP_*` and `PYTHON*` variable removed and `PIP_CONFIG_FILE` set to the null device (no pip config file applies), `PIP_DISABLE_PIP_VERSION_CHECK=1` and `PIP_NO_INPUT=1`. Its `run({dir, work, env, request, maxFileBytes, defines})` starts the venv's interpreter with `-I <dir>/member_map.py <request> <maxFileBytes>`, plus `defines` (the path of a JSON file holding the validated list) when given, from `work`; the mapper exits 2 on a defines file that is not a list of at most 200 entries matching the config pattern. Each entry is parsed by the same script run as `--entry` with `{entry, maxFileBytes, defines}` on its standard input, up to four children at once; a child that dies becomes `the parser failed on the file` and one that outlives 20 seconds is killed and becomes `the parser took longer than 20 seconds` (`int grid[1][1]...` with 100,000 dimensions makes libclang 18 hang; the test uses it). libclang ends the extent of a function whose body it skipped at the declarator, so the mapper finds the body from the tokens after it (`{`, a constructor's `:` initializer list, `try`) and matches its braces; `declarationTouched` covers the lines up to the body's `{`. Prelude: the undeclared names are those of the diagnostics `use of undeclared identifier`, `unknown type name` and `no template named`, minus every name a cursor of the first parse declares; only C++ files get one. A chain whose head is such a name is read from the tokens unless it follows `::`, `.`, `->`, `=`, `(`, `,`, `[`, `return`, `case` or an operator; followed by `(` it is a qualifier of an out-of-line function (the last name is the function and never becomes a struct, and a class template used there gets exactly as many `class` parameters as the definition passes, which clang needs to accept `Box<T>::put`); followed by a name, `*`, `&`, `&&`, `...`, `const` or `volatile` it is a type and synthesized whole; template arguments are read recursively. A bare name is synthesized only for `unknown type name` in a type position. Template arguments nested too deeply for the reader keep the first parse. With `PR_CONFLICT_RADAR_TRACE=1` each entry also carries `trace: {parses, prelude}`, which the tests read. C/C++ kinds: `namespace`, `class`, `struct`, `union`, `enum` (containers, reported only when their header lines up to the `{` are touched; anonymous ones are neither reported nor used as qualifiers), `function` (also function templates), `method`, `constructor` (`Widget::Widget`), `destructor` (`Widget::~Widget`), `conversion` (`operator int`), `field` (also static data members and their out-of-line definitions), `var`, `enumMember` (qualified by its enum), `type` (typedefs and aliases; one that embeds a record, `typedef struct {...} name;`, counts only its own lines around the braces) and `macro`. A declaration and the definition of one name merge into one member. Identifiers skip the name of a preprocessing directive, `defined` and every token of an `#include` line. A lone carriage return is read as a space so only a line feed ends a line. The fixtures are `test/fixtures/cpp/*.txt` (`widget.cpp.txt`, `prelude.cpp.txt`, `macros.cpp.txt`, `cart.c.txt`, `cart.h.txt`), as "Testing Strategy" asks, because CodeQL would otherwise pick up C/C++ files. A message map whose body holds `ON_COMMAND(...)` entries needs that macro in `defines` too; the test covers an empty map with the two entries and a map with entries with three. `action.yml` sets up Python 3.12 and runs `build-cpp` after `build-rust`; `ci.yml` sets up Python 3.12 after Go.

### Task 16: Overlap signals, hints and optional mappers

**Files:**
- Modify: `lib/members.mjs`
- Modify: `lib/report.mjs`
- Modify: `pr-conflict-radar.mjs`
- Modify: `test/members.test.mjs`
- Modify: `test/report.test.mjs`
- Modify: `test/cli.test.mjs`
- Create: `test/fake-mapper.mjs`
- Modify: `action.yml`
- Modify: `test/action.test.mjs`

- [x] extend `members.mjs` with mappers injected per registry key, the real ones taken from the registry's `run`: each file goes to the mapper whose `patterns` it matches first in registry order, one request per side per mapper for the mappers `mappersNeeded` names, base-side blobs taken at each pull request's merge base, the `maxFileBytes` limit with its note (also passed to the mapper), the 120-second limit, entry errors named in `notes`, and `same-member` and `changed-and-used` per pair with `ignoreNames` and `minNameLength`
- [x] add `overlaps` (with `withAuthor` and `sameAuthor`), `hints` and per-file `members` to the result; add the overlaps table to the check summary, with its "Pair key" column and peerbus line gated on `suggestPeerbus`; render the hints with the by-name caveat in the check's text above the embedded result and in the job summary
- [x] wire the mappers into the `scan` phase, with the builds of the needed mappers done by the CLI itself, one after another, when it runs with `--dry-run` alone, and implement the mapper-failure path: publish the textual result marked `degraded` with a note, then exit non-zero
- [x] write tests with fake mappers for all five registry keys: both signals within each language, for the exclusions (own declarations, ignored names, short names, members of kind `macro`, which never form a `same-member` overlap or a hint), for a pair with no shared language files, for a pair whose files are in different languages (no `same-member`, a by-name hint possible), that each mapper is called at most twice per scan, that a mapper `mappersNeeded` does not name is never started, and that an extra registry entry injected in the test is requested, gated and reported like the five
- [x] write tests for the limits: a blob over `maxFileBytes` is left out of the request and named in `notes`; an entry error from any mapper leaves the other entries' members in the result and the result not `degraded`; a mapper that outlives its time limit is stopped and takes the mapper-failure path; a mapper that exits non-zero or writes no valid JSON takes the mapper-failure path
- [x] write tests that a `same-member` overlap makes the check `neutral`; that a hint appears in `hints`, in the check text and in the job summary while the conclusion, the tables, the comment and `findings` stay the same; that a member name carrying markup is escaped; and for the mapper-failure path (result published with `degraded`, non-zero exit, a mapper's captured output logged through the serializer, the probe then reports `changed: true`)
- [x] run tests - must pass before task 17

As built: `lib/members.mjs` exports `mapMembers({base, pulls, config, needed, registry, mappers, unavailable, work, env, git, timeoutMs})`, `memberSignals(changesA, changesB, config)`, `fileMembers(changesA, changesB, path)`, `simpleName(name)` and `MAPPER_TIMEOUT_MS` (120,000). `mapMembers` maps the simulated pull requests that do not conflict with the base; `mappers` maps a key to a `run` that replaces the registry's (the tests' fake mappers), and an entry with neither is skipped; `unavailable` maps a key to the message of a failed build, which counts as that mapper's failure without starting it. Only regular files are sent (a symlink or submodule side is not), each side's mapper chosen by that side's path, and an empty range list sends nothing. It resolves to `{changes, notes, degraded, failures}`: `changes[pr]` is `[{path, side, members, identifiers}]` with `side` `head` or `base`; a run that times out (the whole process group is killed), exits non-zero, cannot start or writes no valid response is a failure `{mapper, side, message, command, args, code, signal, stdout, stderr}`, nothing that mapper returned on either side is kept, and only the pull requests it had files of are `degraded`, with the note `Member overlap is incomplete: the <key> member mapper failed.`; a file over `maxFileBytes` gets `The members of <path> were not mapped: the file is larger than <n> bytes.` and an entry error `The members of <path> were not mapped: <error>` (cut to 200 characters). Members of kind `macro` count in neither signal; `ignoreNames` and `minNameLength` apply to `changed-and-used` only, because a `same-member` key carries the path and the qualified name. A hint matches the last plain identifier of a qualified name (`simpleName`; `operator +`, `this[]` and `~Widget` match nothing) against the other side's identifiers, minus the names whose declarations the other side touched; both signals are computed for clean checked pairs only, both directions of `changed-and-used` go into one hint, and the overlap and the hint are the same in both results of a pair (the job summary lists each pair's hint once). `buildResults(simulation, config, repo, members)` takes what `mapMembers` resolves to as an optional fourth argument; a conflicting file's `members` are the names either pull request changed in it, present only when there are any. `prepare` writes `needed` into the state file and `scan` reads it; the builds and the mapper runs get the CLI's environment without `GH_TOKEN` and `GITHUB_TOKEN`; `main` takes `mapperTimeout` for tests. With `--dry-run` alone a failed build is a mapper failure: its output is logged and the scan still runs. After publishing, the scan prints the `mapperFailed` annotation with the number of failures and one log-serialized line per failure, and exits 1. Each `build-<key>` step of `action.yml` has `continue-on-error: true`, so a failed build leaves the scan to take the mapper-failure path (the run fails to start or exits non-zero). `test/fake-mapper.mjs` is a fake mapper over a small line language, with `hang`, `exit` and `garbage` modes and a run log.

### Task 17: Example workflows and the action on itself

**Files:**
- Create: `examples/pr-conflict-radar-trigger.yml`
- Create: `examples/pr-conflict-radar.yml`
- Create: `examples/pr-conflict-radar.json`
- Create: `.github/workflows/pr-conflict-radar-trigger.yml`
- Create: `.github/workflows/pr-conflict-radar.yml`
- Create: `test/workflows.test.mjs`

- [x] write the two example workflows per "Workflows" and `examples/pr-conflict-radar.json` holding the defaults
- [x] install the same two workflows in `.github/workflows/`, with `uses: ./` in place of the pinned reference; they start working when this branch is merged, and from then on every pull request in this repository is scanned
- [x] write tests, parsing with `yaml`, that each repository workflow equals its example except for the `uses:` line of the action; that the trigger has no checkout, no step besides the dispatch, `continue-on-error` on that step, `actions: write` as its only job permission and no interpolation of a pull request field into `run:`; that the scan has the concurrency group of "Workflows" without cancellation and the dry-run expression
- [x] write a test that `examples/pr-conflict-radar.json` loads and equals the built-in defaults, all five `members` languages and `suggestPeerbus` included
- [x] validate the four workflow files with `actionlint` if available (run through `go run`; it flags only `queue: max`, which it does not know yet), and run tests - must pass before task 18

### Task 18: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `SECURITY.md`
- Create: `test/docs.test.mjs`

- [x] write the README: what it does and does not do; quick start with the two workflows pinned by commit SHA and the permissions each needs; that the radar's check must never be made a required check; the trigger model and why the scan is not attached to pull request heads; the configuration reference with every default; the result schema with authors, `state`, hints, `degraded`, truncation and the comment's `notified` list; how an agent reads the result (`gh api repos/<owner>/<repo>/commits/<head sha>/check-runs` filtered by the check name, then the marker in `output.text`); the pair key, the shared topic name for agents coordinating on peerbus or on any channel a team chooses, always in the JSON as the pair's stable identifier; a "Peerbus suggestions" subsection on `suggestPeerbus`, optional for teams that use peerbus: on (the default) the check and the comment show the pair key and one line pointing to peerbus, off neither the key nor any mention of peerbus appears in what people read, and in both states the action has no access to peerbus and only suggests; notifications (each pull request's author is notified once per pair, a pair that flaps notifies once, so an author who pushes repeatedly cannot make the radar notify somebody again and again; changing `pairKey` notifies each listed pair once more)
- [x] write the README's member overlap section: per language the parser, the default patterns, the toolchain the action sets up for it (and that it stays on the job's `PATH`), and the known limits: C and C++ macros and conditional compilation (both branches of an `#if` clang cannot evaluate are parsed; a calling-convention, export or declaration macro defined in an unread header hides the declaration it sits in until it is listed in `members.cpp.defines`, with examples; a function-like macro used as a declaration reads as a `macro` member and never counts as an overlap; members local to a function body are not reported; `.h` is parsed as C++; MS-specific flags are not used, so a Windows-only `#ifdef` arm is parsed alongside the other one); Rust items generated by macros are not seen; Go build tags are ignored and every file is parsed; a file with a syntax error contributes no members except in C and C++
- [x] write the security model and limitations: the security model; limitations (syntax-only overlap, by-name hints, no build of the merged code, a pair is not checked while one side conflicts with the base, review events on fork and conflicted pull requests wait for the next event or the schedule, fork publishing not yet confirmed live)
- [x] bring `CONTRIBUTING.md` and `SECURITY.md` in line with the implementation where they have become inaccurate: the requirements (Node.js 20+, git 2.38+, and for the mapper tests the .NET 10 SDK, Go at the version of `members/go/go.mod` or newer, rustup, which installs the toolchain `members/rust/rust-toolchain.toml` pins, and Python 3.12+ with `venv`; a mapper test file whose toolchain is missing is skipped locally and fails in CI), the commands, the mapper test files that reach the network (nuget.org, crates.io and rustup's servers, PyPI), how to add a language (a registry entry, a mapper directory speaking the contract, a test file, a gated `action.yml` step, the toolchain in `ci.yml`), the escaping guarantees, and the file-system line of the scope, which becomes the rule of "Security model" (nothing derived from pull request content is written outside the git directory and the runner's temp directory)
- [x] write a test that every config key (including each registry language key and `suggestPeerbus`) and every action input in the README matches `lib/config.mjs`, `members/registry.mjs` and `action.yml`, that the README names every registry language with its default patterns, and that the README's example workflows equal the files in `examples/` apart from the pinned SHA
- [x] run `npm test` and `npm run lint` - must pass before task 19

### Task 19: Verify acceptance criteria

Verification before the merge is local. The trigger and scan workflows take effect only once they are on `main`, so nothing here publishes on GitHub and the action does not scan this plan's own pull request. The live end-to-end run is the rollout plan's.

**Files:**
- Modify: `docs/plans/20261127-pr-conflict-radar.md`

- [x] verify every item in the Overview is implemented: pair and train simulation, classes, optional member overlap for Go, TypeScript and JavaScript, C#, Rust and C/C++ through the registry, check run, sticky comment with the notified list, the `suggestPeerbus` switch, embedded JSON, job summary, quick exit, the two example workflows and this repository's copies, the documented security model (verified against the code, the tests and the examples)
- [x] run the full test suite (`npm ci`, `npm test`) on Node 20 and on the current one, with the .NET 10 SDK, Go, rustup and Python 3.12 present, so no mapper test file is skipped (Node 20.20.2 and Node 26.13.1: 545 tests each, 0 skipped, with .NET 10, Go, Rust 1.100.0 and Python 3.12)
- [x] run `npm run lint` (biome: no findings)
- [x] run `node pr-conflict-radar.mjs --dry-run` in this repository (no config file, few or no open pull requests) and confirm it ends cleanly (no open pull requests: "No pull request was simulated", exit 0, 0.6 s)
- [x] run `--dry-run` in a clone of a real repository the executor can read that has several open pull requests, once with no config and once with `--config` pointing at a file that enables all five mappers; confirm the conflicts it reports by merging one reported pair by hand in a scratch clone (a public open-source repository with 5 open pull requests; the no-config run reported 2 conflicting pairs, the all-mappers run the same 2; one pair merged by hand with `git merge-tree` conflicts in the same file, a non-conflicting pair of the same repository merges cleanly)
- [x] confirm both dry runs made no write call and left the clone's refs and tags exactly as `git for-each-ref` listed them before the run; record in this plan the run time, the time of each mapper's build, the read queries' rate-limit cost, and the writes a publish of that state would make: check writes and comment writes, each counted per run (no write call in either run; `git for-each-ref` and the tag list identical before and after each run. Run time: 7.3 s with no config, 9.3 s with all five mappers enabled. Mapper builds, one phase each: typescript 0.07 s, csharp 0.9 s, go 0.2 s, rust 4.6 s, cpp 3.0 s. Read cost: 2 GraphQL points and 0 REST requests per run. A publish of that state would make 5 check writes and 3 comment writes per run)
- [x] confirm no file names an organisation, product or person other than this repository and peerbus, and that the dry-run output recorded here names no other repository (the tree names only this repository and peerbus; nothing from the dry-run output is recorded)

### Task 20: [Final] Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/20261127-pr-conflict-radar.md`
- Modify: `docs/plans/20261127-pr-conflict-radar-rollout.md`

- [ ] replace the README's "early development" status with the state the branch is in: implemented, not yet released, the workflows active once merged
- [ ] confirm `CONTRIBUTING.md`, `SECURITY.md` and the README describe what was built, and that no doc or comment carries history
- [ ] move this plan to `docs/plans/completed/` and point the rollout plan's references to it at the new path

## Post-Completion

**The pull request**
- Open the one pull request from `feat/initial-action` only on the owner's word. Its title is a scoped Conventional Commit, because the squash makes it the commit subject. The owner merges it.
- `ci.yml` runs on that pull request, since `pull_request` workflows come from the pull request itself. The trigger and scan workflows do not: `pull_request_target` uses the default branch's copy of a workflow file and `workflow_dispatch` needs the file on the default branch, and `main` has neither until the merge.

**After the merge**
- `docs/plans/20261127-pr-conflict-radar-rollout.md` takes over: the end-to-end run on GitHub, the fixes it calls for, the required-checks baseline and the preparation of `v0.1.0`.

**To confirm when the chance comes**
- The first pull request from a fork: that its check and comment land in the base repository, and that the trigger's `pull_request_target` run dispatched the scan. Until then the README lists it as unconfirmed.
- A conflict between two different authors on GitHub: the cross-author wording is covered by tests only until two accounts have conflicting pull requests.
- The first live run: that the scan finds its own comment again under the workflow token (`viewerDidAuthor`), and that a check's details and the job summary render escaped text the way a comment does, which is the one renderer the escaping rule was measured on.

**Tuning**
- The default path classes and `ignoreNames`, once other repositories use the action.
- How many `changed-and-used` hints are false positives; that decides whether the signal may ever affect the conclusion.
- How many cleanly merging pairs show a member overlap; that decides whether a build of the merged tree is worth a plan of its own.
- The REST writes per run. Every change of `state` rewrites one check per open pull request. The number of check writes per run is measured (Task 19 and the rollout's live run). If it causes problems, such as secondary rate limits or GitHub's content-creation cap of 80 requests a minute and 500 an hour, the `state` fingerprint moves to a single record written last, and a check is written only when its content changes.
- Each mapper step's time on GitHub-hosted runners, from the rollout's live run; a cache step is added for a toolchain whose step takes much longer than the cold builds measured here.

**Not in this plan**
- Building or testing the merged tree.
- Pairs across repositories.
- Languages for member overlap beyond Go, TypeScript and JavaScript, C#, Rust and C/C++; the registry is where one is added.
