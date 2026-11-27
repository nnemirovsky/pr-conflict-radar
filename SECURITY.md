# Security policy

## Reporting a vulnerability

Report privately through GitHub, not in a public issue:

**[Open a private security advisory](https://github.com/nnemirovsky/pr-conflict-radar/security/advisories/new)**

The report is visible only to the maintainer ([@nnemirovsky](https://github.com/nnemirovsky)) until an advisory is published, so nothing sensitive is exposed while a fix is prepared. Expect an acknowledgement within a week.

If the form is unavailable, open a normal issue that says only "I would like a private channel for a security report", with no details, and a private advisory will be opened for you.

Never attach real credentials, tokens, personal data or private files to a report. Describe the shape of the problem instead.

## Supported versions

Only the latest release gets security fixes.

## Scope

The action runs in a workflow with write access to check runs and pull request comments, and it reads content that pull request authors control. These count as vulnerabilities:

- Any way to make the action execute code, a script or a command taken from a pull request. It is designed to parse pull request content as data only.
- Any way for pull request content (file names, file contents, branch names, titles, labels) to inject commands, or to inject markup that changes the meaning of what the action publishes on another pull request.
- Leaking the workflow token or any other secret into logs, check runs or comments.
- Writing anything derived from pull request content outside the repository's git directory and the runner's temp directory, or reading files outside the workspace and the runner's temp directory.
- Publishing to a repository other than the one the workflow runs in.

Out of scope:

- A conflict or overlap the action failed to detect, or one it reported wrongly. That is a bug: open a normal issue.
- Anything that needs an attacker who can already push to the default branch or edit the workflow that calls the action.
