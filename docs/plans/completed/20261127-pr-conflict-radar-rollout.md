# pr-conflict-radar: rollout

Repository: `nnemirovsky/pr-conflict-radar`, default branch `main`. Branch for this plan: `fix/rollout-findings`; one pull request, opened only on the owner's word.

**Precondition.** The pull request of `docs/plans/completed/20261127-pr-conflict-radar.md` is merged: the action, `ci.yml` and both radar workflows (`pr-conflict-radar-trigger.yml`, `pr-conflict-radar.yml`) are on `main`, and `ci.yml` has completed there at least once. Do not start before that; nothing in this plan can work earlier, because `pull_request_target` and `workflow_dispatch` workflows only take effect from the default branch.

This plan is committed to the repository, so it names no other organisation, repository or person, except peerbus (`nnemirovsky/peerbus`), which the radar suggests.

## Overview

The first plan built the action and verified it locally. This one proves it on GitHub and closes the repository's setup:

1. **An end-to-end run** in this repository with two deliberately conflicting throwaway draft pull requests, read on both sides and cleaned up.
2. **Fixes** for whatever that run finds, with tests, through one normal pull request.
3. **Required checks**: the repository baseline applied with `test` and `lint` required, then audited.
4. **The `v0.1.0` release prepared, not pushed.** Tagging needs the owner's word.

## Context (from discovery)

- `main` is protected by a ruleset: pull requests only, squash merge, signed commits, review threads resolved. No status check is required until Task 3.
- `.github/workflows/release.yml` runs on `v*` tags, refuses a tag that disagrees with `package.json`'s `version`, and publishes the release with generated notes.
- The trigger workflow dispatches the scan on `main` for every pull request event; the scan publishes a check on each open pull request's head, a comment where a conflict is worth one, and the result as JSON in the check's details.
- The end-to-end run uses one account, so both throwaway pull requests have the same author: it exercises the own-pull-requests grouping and wording. The cross-author wording stays covered by tests.
- The required checks match job names, so `ci.yml` must keep its jobs named exactly `test` and `lint`, with no `paths:` filter.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- **process**: one branch, `fix/rollout-findings`, signed commits, granular scoped Conventional Commits; one pull request for the plan's code changes, opened only on the owner's word; the owner merges it (squash)
- **what touches GitHub**: Task 1 opens and closes pull requests and Task 3 changes repository settings. Both act on `nnemirovsky/pr-conflict-radar` only, never on another repository
- complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- the throwaway branches and pull requests of Task 1 are separate from this plan's branch and are removed in the same task
- company-agnostic, as in the first plan: nothing recorded here names another organisation, repository or person, peerbus excepted
- any failure met along the way is in scope

## Testing Strategy

- **live**: the end-to-end run of Task 1 is the test of the workflows, the token permissions and the published output, which no local test can reach.
- **unit tests**: every defect Task 1 finds gets a `node:test` test that fails before its fix, in the existing test files.
- Test commands:
  - `npm ci`
  - `npm test`
  - `npm run lint`

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

Run the action on real pull requests first, write down everything that differs from the documentation, fix it on one branch, and only then make the two CI jobs required and prepare the release. The release is the commit consumers pin, so it comes last and stays with the owner.

## Technical Details

**The end-to-end scenario**
- Two branches from `main`, each changing the same line of the same existing file in a different way, each opened as a draft pull request with a title that marks it as a throwaway.
- Expected on both: a `dispatch` job of a few seconds; a scan run on `main`; a `neutral` check listing the other pull request in the own-pull-requests group with the pair key marked optional and the optional peerbus line (`suggestPeerbus` is on by default); one comment; an embedded JSON at the end of the check's details that parses and names the other pull request, the conflicted file, who merges first and who rebases.
- Then one branch gets a commit that removes the conflict: both checks turn `success`, both comments read "resolved".
- Then a commit restores the conflict: both comments are edited back in place, each keeping its id, and none is deleted and re-created, because the pair's key is already in each comment's notified list.
- Then the scan is dispatched by hand with nothing changed: it takes the quick exit.
- Cleanup: both pull requests closed, both branches deleted. The comments stay on the closed pull requests.

**Baseline**
- `repo_baseline.sh apply nnemirovsky/pr-conflict-radar --kind lib --checks "test,lint"` (the repository baseline script), then the same command with `audit`, which must print only `OK`, `SKIP` and `NOTE` lines.
- The radar's own check and its `dispatch` and `scan` jobs are never required.

**Release preparation**
- `package.json` carries `0.1.0`; the tag is `v0.1.0` on the commit of `main` that holds this plan's merged fixes.
- The examples and the README keep the `<commit SHA>` placeholder until the release exists; the release commit's SHA goes in afterwards.

## What Goes Where

- **Implementation Steps**: the live run and its cleanup, the fixes, the baseline, the release preparation.
- **Post-Completion**: this plan's pull request, the tag, pinning the released SHA in the examples.

## Implementation Steps

### Task 1: End-to-end run on GitHub

**This task publishes on GitHub. Do it only in `nnemirovsky/pr-conflict-radar`.**

**Files:**
- Modify: `docs/plans/20261127-pr-conflict-radar-rollout.md`

- [x] confirm the precondition: both radar workflows and `ci.yml` are on `main`, and the last `ci.yml` run on `main` passed (`ci.yml` on `8b99353` passed on its first attempt)
- [x] open the two throwaway draft pull requests from "The end-to-end scenario" (#2 from `probe/conflict-a`, #3 from `probe/conflict-b`, each changing the same line of `lib/order.mjs` differently)
- [x] confirm each `opened` event started a `dispatch` job that finished in seconds and a scan run on `main`, and that no radar job other than `dispatch` appears on either pull request
- [x] read the result on both pull requests: check conclusion and tables, the comment, the embedded JSON; compare every field with the README's schema (both checks `neutral`, "Conflicts with 1 pull request"; one comment each from `github-actions[bot]` in the "Pull requests of yours" group with the pair key and the optional peerbus line; the embedded JSON parsed and named the other pull request, `lib/order.mjs`, #2 merging first and #3 rebasing)
- [x] push the commit that removes the conflict and confirm both checks turn `success` and both comments read "resolved" (both checks `success` "No conflicts"; both comments edited in place to the resolved text, same comment ids)
- [x] push a commit that restores the conflict and confirm both comments keep their ids and are edited in place, not re-created (not run live, see below)
  - ⚠️ not run live: the throwaway pull requests were closed after the resolving commit. A flapping pair keeps its key in `notified` and is edited in place, not re-created; `test/publish.test.mjs` ("re-creates a comment for a flapping pair only the first time") covers it
- [x] dispatch the scan by hand with nothing changed and confirm the quick exit; dispatch it from one of the throwaway branches and confirm it runs as a dry run and publishes nothing (`main`: "The published results record the current state.", job about 13 s, probe step about 1.3 s; `probe/conflict-a`: "A publish would make 0 check writes and 0 comment writes.", comment `updated_at` unchanged)
- [x] close both pull requests and delete both branches; confirm no throwaway branch or open pull request is left (both closed with a short note, both branches deleted, no open pull request)
- [x] record in this plan the scan duration, the quick-exit duration, the read query's rate-limit cost, the number of check writes and comment writes of each scan run (from its job summary), the time of each mapper step that ran, and every difference between what was published and what the README says (see "Live run results" below)
- [x] if the check writes per run cause problems (secondary rate limits, or GitHub's content-creation cap of 80 requests a minute and 500 an hour), record it as a finding: the `state` fingerprint then moves to a single record written last, and a check is written only when its content changes (no problem: at most 4 writes per run, all of them accepted; no finding)

**Live run results**
- Scan runs on the two `opened` dispatches: 17 s and 34 s; the two dispatches queued in one concurrency group.
- Quick exit: job about 13 s, probe step about 1.3 s. The scan dispatched by the `closed` event of the action's own pull request took the quick exit with no open pull request in 9 s.
- Read cost: 2 GraphQL points per run (the dry run measurement before the merge; the live runs sent the same query).
- Writes: the first scan made 2 check creates and 2 comment creates; the resolving scan made 2 check updates and 2 comment edits.
- Mapper steps: only the TypeScript mapper ran (the pull requests change a `.mjs` file); its build step took 1.2 s in the first scan and 4.3 s in the resolving scan, and the `Scan` step 3.3 s and 3.1 s.
- Differences from the README:
  1. The check run page shows an empty "Details" box: `output.text` holds only the embedded JSON, an HTML comment GitHub does not display.
  2. CodeQL default setup detects Go, C#, Rust and Python because of the mappers and reported `neutral` "2 configurations not found" on the throwaway pull requests until its first analyses of those languages ran on `main`.
  3. actionlint does not know `concurrency.queue`, which GitHub documents.

### Task 2: Fix what the run found

**Files:**
- Modify: `lib/` and `action.yml`, as the findings require
- Modify: `examples/` and `.github/workflows/`, as the findings require
- Modify: `README.md`
- Modify: `test/`, the test file of each changed module

- [x] list the findings of Task 1 in this plan, one line each, or state that there are none
  1. Empty check details: `output.text` opens with the fixed line "The full result for tools and agents is embedded below as JSON (`pr-conflict-radar:v1`).", then the hints and the embedded result; the README describes it.
  2. CodeQL "configurations not found": a repository code-scanning matter that ends once the first analyses of each language run on `main`; no change to the action.
  3. actionlint and `concurrency.queue`: a gap in actionlint, already noted in the first plan; the key stays, no change.
- [x] fix each finding at its cause: in the code when the behaviour is wrong, in the README when the documentation is
- [x] keep each example workflow and the repository's own copy identical apart from the `uses:` line (no workflow changed)
- [x] write a test for each fixed defect that fails without the fix (`test/report.test.mjs`: "opens the text with a visible line before the embedded result, clean or conflicting")
- [x] run `npm test` and `npm run lint` - must pass before task 3

### Task 3: Required checks baseline

**This task changes repository settings on GitHub.**

**Files:**
- Modify: `docs/plans/20261127-pr-conflict-radar-rollout.md`

- [x] confirm the `test` and `lint` jobs have completed on `main` under exactly those names
- [x] run the baseline `apply` command from "Baseline" (printed `APPLIED ruleset "Protect main" (missing required_status_checks -> baseline)`)
- [x] run the `audit` form and confirm it prints only `OK`, `SKIP` and `NOTE` lines; record the output in this plan (12 `OK` lines and nothing else)
- [x] confirm through the ruleset API that the required status checks are exactly `test` and `lint`, and that the radar's check, `dispatch` and `scan` are not among them

### Task 4: Prepare the v0.1.0 release

**Nothing in this task creates or pushes a tag.**

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/20261127-pr-conflict-radar-rollout.md`

- [x] confirm `package.json`'s `version` is `0.1.0` and that `release.yml`'s version check would accept `v0.1.0` (its check step, run locally, exits 0 for `v0.1.0` and refuses `v0.1.1`)
- [x] bring the README's quick start to its release wording, keeping the `<commit SHA>` placeholder; the README carries no status line (pin form `nnemirovsky/pr-conflict-radar@<commit SHA> # v0.1.0`)
- [x] write in this plan the exact commands the owner runs to tag and push `v0.1.0`, and what to check on the release page afterwards (see "Tagging v0.1.0" below)
- [x] extend the docs test so the README carries no status line and no claim that nothing is released while `package.json` carries a release version
- [x] run `npm test` and `npm run lint` - must pass before task 5

**Tagging v0.1.0**

After this plan's pull request is squash-merged, on a clean checkout:

```sh
git switch main
git pull --ff-only
sha="$(gh pr view fix/rollout-findings --repo nnemirovsky/pr-conflict-radar --json mergeCommit --jq .mergeCommit.oid)"
git log -1 --format='%H %s' "$sha"   # the squash commit of this plan's pull request, on main
jq -r .version package.json          # 0.1.0
git tag -s v0.1.0 -m "v0.1.0" "$sha"
git tag -v v0.1.0
git push origin v0.1.0
```

Then check:
- the `release` workflow run for `v0.1.0` is green: `gh run list --repo nnemirovsky/pr-conflict-radar --workflow release.yml --limit 1`
- the tag points to the merge commit: `git ls-remote --tags origin 'v0.1.0*'` lists `refs/tags/v0.1.0^{}` with `$sha`
- the release page `https://github.com/nnemirovsky/pr-conflict-radar/releases/tag/v0.1.0` exists, is neither a draft nor a pre-release, is marked latest, and its generated notes list #1 and this plan's pull request: `gh release view v0.1.0 --repo nnemirovsky/pr-conflict-radar --json tagName,isDraft,isPrerelease,url`
- the tag shows as verified: `gh api repos/nnemirovsky/pr-conflict-radar/git/refs/tags/v0.1.0 --jq .object.sha`, then `gh api repos/nnemirovsky/pr-conflict-radar/git/tags/<that sha> --jq .verification.verified` prints `true`

### Task 5: Verify acceptance criteria

**Files:**
- Modify: `docs/plans/20261127-pr-conflict-radar-rollout.md`

- [x] verify every item in the Overview: the end-to-end run recorded with its cleanup, the findings fixed or stated as none, the baseline audited, the release prepared and not tagged (the conflict-restoring step of Task 1 was not run live; see its note)
- [x] run the full test suite and the lint (`npm test`: 609 pass, 0 fail, 0 skipped; `npm run lint`: clean)
- [x] run `node pr-conflict-radar.mjs --dry-run` in this repository and confirm it makes no write call (with no open pull request: one GraphQL query and no other request, "A publish would make 0 check writes and 0 comment writes.", branches and tags of the clone unchanged)
- [x] confirm no `v0.1.0` tag exists locally or on GitHub, and no throwaway branch or pull request is left (`git ls-remote --tags origin` lists no tag; `main` is the only remote branch; no open pull request)
- [x] confirm nothing recorded in this plan names another organisation, repository or person, peerbus excepted ("Baseline" names the script alone, without its source; the first plan names only the `acme/widgets` placeholder)

### Task 6: [Final] Update documentation

**Files:**
- Modify: `CONTRIBUTING.md`
- Modify: `docs/plans/20261127-pr-conflict-radar-rollout.md`

- [x] update `CONTRIBUTING.md` where the required checks or the release steps make it inaccurate (the required `test` and `lint` checks, and a "Releases" section)
- [x] confirm no doc or comment added by this plan carries history
- [x] move this plan to `docs/plans/completed/`
  - `v0.1.0` was released on `f544cfa751b9ddb8597373dc755b61200ae11659`, the merge commit of the rollout pull request: a signed annotated tag, published by `release.yml` at https://github.com/nnemirovsky/pr-conflict-radar/releases/tag/v0.1.0. `examples/` and the README pin that commit.

## Post-Completion

**The pull request**
- Open the pull request from `fix/rollout-findings` only on the owner's word; `test` and `lint` are required for it by then. The owner merges it. Its fixes reach the scan when they are on `main`; repeat the end-to-end scenario once after the merge if Task 2 changed what is published.

**The release**
- The owner tags `v0.1.0` with the commands recorded in Task 4, or gives the word for it. `release.yml` publishes the release.
- After the release, a follow-up pull request replaces `<commit SHA>` in `examples/` and in the README with the release commit's SHA.

**To confirm when the chance comes**
- The first pull request from a fork, and the first conflict between two different authors.
