# pr-conflict-radar

A GitHub Action that finds conflicts between open pull requests before they merge.

GitHub tells you when a pull request conflicts with its base branch. It does not tell you that two open pull requests will conflict with each other once the first one merges. `pr-conflict-radar` simulates that ahead of time and reports it on both pull requests, for the people who own them and for the coding agents working on them.

> **Status:** early development. Nothing is released yet, and the interface described here can still change.

## What it does

- **Pairwise simulation.** For every pair of open pull requests, it merges the first into the base branch in memory and then merges the second onto the result, using `git merge-tree`. Nothing is checked out and no pull request code is executed.
- **Merge-train simulation.** It predicts the merge order and merges the whole train, which catches conflicts that only appear with three or more pull requests.
- **Member overlap.** For pairs that merge cleanly, it reports when both pull requests changed the same method, property or function. It parses C# with Roslyn and TypeScript/TSX with the TypeScript compiler API, syntax only, with no build.
- **A result on every affected pull request.** A check run that never fails, one comment per pull request for conflicts worth a notification, and the same result as JSON for tools and agents.
- **Deterministic.** No AI is involved in detection, and every run recomputes everything from the current state of the repository.

## What it does not do

- It never blocks a merge. The check is `neutral` when it finds something and `success` otherwise.
- It does not build or test the merged code, so it cannot prove that two pull requests work together.
- It does not resolve conflicts. It names who merges first and who rebases, and leaves the work to the owners.

## Documentation

Usage, configuration and the result schema will be documented here before the first release.

## License

[Apache-2.0](LICENSE)
