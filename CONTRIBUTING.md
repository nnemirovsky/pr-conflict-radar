# Contributing

Thanks for looking at `pr-conflict-radar`. This covers the dev loop, the tests and how changes land.

## Dev loop

You need Node.js 20 or newer, git 2.38 or newer, and the .NET 10 SDK for the C# member mapper.

```sh
npm ci
node pr-conflict-radar.mjs --dry-run   # needs GH_TOKEN; prints the result and publishes nothing
```

`--dry-run` reads the open pull requests of the repository in the current directory and never writes to GitHub, so it is safe to run against any repository you can read.

## Tests

```sh
npm test
npm run lint
```

Tests use `node:test`. Git behaviour is tested against real repositories created in a temp directory, and the GitHub API through a fake, so no test touches the network. CI runs both commands on every PR.

## Pull requests

- Open a PR against `main`. Direct pushes are blocked.
- CI must be green and every review thread resolved before a PR can merge.
- PRs are squash-merged, and the PR title becomes the commit subject, so write it as a commit message.

## Commits

Scoped conventional commits with a lowercase description:

```
feat(scope): add the thing
fix(scope): stop doing the wrong thing
```
