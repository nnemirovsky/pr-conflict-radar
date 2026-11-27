# Contributing

Thanks for looking at `pr-conflict-radar`. This covers the dev loop, the tests and how changes land.

## Requirements

- Node.js 20 or newer and git 2.38 or newer. These are all the action itself needs.
- For the member mapper tests, each mapper needs its toolchain:
  - the .NET 10 SDK for C#;
  - Go at the version of `members/go/go.mod` or newer;
  - `rustup`, which installs the toolchain that `members/rust/rust-toolchain.toml` pins;
  - Python 3.12 or newer with `venv` for C and C++.

A mapper test file whose toolchain is missing is skipped locally with a message that names the missing tool. In CI (`CI` is set) it fails instead, so a broken setup step cannot pass silently.

## Dev loop

```sh
npm ci
GH_TOKEN=$(gh auth token) node pr-conflict-radar.mjs --dry-run
```

`--dry-run` reads the open pull requests of the repository in the current directory, simulates them and prints the result and the writes a publish would make. It never writes to GitHub and leaves the clone's branches and tags as they were, so it is safe to run against any repository you can read. It needs `GH_TOKEN` (or `GITHUB_TOKEN`) and a clone with an `origin` remote.

## Tests

```sh
npm test
npm run lint
```

Tests use `node:test`. Git behaviour is tested against real repositories created in a temp directory, and the GitHub API through a fake, so no test touches the network, with one exception: three mapper test files build their tool first and fetch what the build needs.

| Test file | Fetches from |
| --- | --- |
| `test/member-map-csharp.test.mjs` | nuget.org (Roslyn) |
| `test/member-map-rust.test.mjs` | crates.io, and rustup's servers when the pinned toolchain is absent |
| `test/member-map-cpp.test.mjs` | PyPI (`libclang`) |

The TypeScript and Go mapper tests fetch nothing. CI runs `npm test` on the runner's default Node and on Node 20, and `npm run lint`, on every pull request.

Mapper fixture files live under `test/fixtures/<language>/` with a `.txt` suffix, so the linter and code scanning never read a file with a deliberate syntax error as source.

## Adding a language

A language is one entry of `members/registry.mjs` plus the pieces it points to:

1. A registry entry: the config key (also the name of its `prepare` output), the default patterns, `build` and `run`, which return commands as argument arrays and never as shell text. The config loader, `prepare` and the scan read the registry, so nothing else in `lib/` changes.
2. A mapper directory `members/<key>/` that speaks the contract: it is run with the path of a JSON request file `[{id, path, file, ranges}]` and `maxFileBytes`, and writes one JSON array to its standard output, with `{id, members, identifiers}` or `{id, error}` per entry. It exits 0 whenever it wrote a response.
3. A test file `test/member-map-<key>.test.mjs` that builds the tool once in a `before` hook and runs it on fixtures.
4. A gated step in `action.yml`: a toolchain step if the language needs one, and a `build-<key>` step with `if: steps.prepare.outputs.<key> == 'true'` and `continue-on-error: true`.
5. The toolchain in `.github/workflows/ci.yml`, so the test file runs there.

The README's configuration reference and member overlap section list the new key and its patterns; `test/docs.test.mjs` fails until they do.

## Escaping

Text that a pull request controls (file paths, member names, labels, author logins) must enter a check, a comment or the job summary only through `escapeText` in `lib/escape.mjs`. Anything the action prints that can carry such text goes through `logLine`. Do not build output from those values by hand. The README's security model describes the guarantees, and `test/escape.test.mjs` tests them.

## Pull requests

- Open a PR against `main`. Direct pushes are blocked.
- The `test` and `lint` jobs of `.github/workflows/ci.yml` are required checks, and every review thread must be resolved before a PR can merge. The required checks match the job names, so keep the jobs named exactly `test` and `lint` and give `ci.yml` no `paths:` filter. The radar's own check and its `dispatch` and `scan` jobs are never required.
- PRs are squash-merged, and the PR title becomes the commit subject, so write it as a commit message.

## Releases

A release is a signed annotated `v*` tag on a squash commit of `main`. The tag's version must equal `package.json`'s `version`: bump it in a PR first, then tag the merged commit and push the tag:

```sh
git tag -s v<version> -m "v<version>" <commit SHA>
git push origin v<version>
```

`.github/workflows/release.yml` runs on the tag, refuses it when it disagrees with `package.json`, and publishes the release with generated notes. A pushed `v*` tag cannot be moved or deleted. Consumers pin the action by the release's full commit SHA, with the tag in a comment, as the README's quick start shows.

## Commits

Scoped conventional commits with a lowercase description:

```
feat(scope): add the thing
fix(scope): stop doing the wrong thing
```
