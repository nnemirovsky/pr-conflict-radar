// Member-mapper plumbing shared by the CLI: which mappers a run needs and how a
// mapper's build is run.
//
// A registry entry may carry `build(context)`, which returns the steps that
// prepare its mapper as `[{command, args, cwd, env}]`. `context` is
// `{dir, work, env}`: the mapper's directory, the work directory and the
// inherited environment. A step's `env`, when present, is the complete
// environment of that command; otherwise the inherited one applies. Steps run
// one after another, as argument arrays, never through a shell.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry as defaultRegistry } from "../members/registry.mjs";
import { matchesAny } from "./classify.mjs";

// The directory that holds `lib/`, `members/` and `action.yml`.
export const ACTION_DIR = fileURLToPath(new URL("..", import.meta.url));

// Each captured stream is cut to this many characters in a build's report.
const OUTPUT_LIMIT = 20000;

export class BuildError extends Error {
  constructor(message, { key, output = [] } = {}) {
    super(message);
    this.name = "BuildError";
    this.key = key;
    this.output = output;
  }
}

// Which mappers a run needs, as `{<key>: boolean}` in registry order. An entry
// is needed when its `enabled` is `true`, never when it is `false`, and when
// it is `"auto"` if a path of `changedFiles` (the changed files of the
// simulated pull requests, as path strings) matches its `patterns`.
export function mappersNeeded(config, changedFiles, { registry = defaultRegistry } = {}) {
  const needed = {};
  for (const entry of registry) {
    const member = config.members[entry.key];
    if (member.enabled === true) needed[entry.key] = true;
    else if (member.enabled === false) needed[entry.key] = false;
    else needed[entry.key] = changedFiles.some((path) => matchesAny(path, member.patterns));
  }
  return needed;
}

// The mapper directory of `entry` inside the action, or inside `root`.
export function mapperDir(entry, root = ACTION_DIR) {
  return join(root, "members", entry.key);
}

function runStep(step, baseEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args ?? [], {
      cwd: step.cwd,
      env: step.env ?? baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        command: step.command,
        args: step.args ?? [],
        code,
        stdout: Buffer.concat(out).toString("utf8").slice(0, OUTPUT_LIMIT),
        stderr: Buffer.concat(err).toString("utf8").slice(0, OUTPUT_LIMIT),
      }),
    );
  });
}

// Runs the build of `entry` and resolves to the captured report of each step,
// `[{command, args, code, stdout, stderr}]`. Throws a `BuildError` when the
// entry has no build, when a command is missing (the message names it) and
// when a step exits non-zero; `output` holds the report so far.
export async function runBuild(entry, { dir = mapperDir(entry), work, env = process.env } = {}) {
  if (typeof entry.build !== "function") {
    throw new BuildError(`the ${entry.key} member mapper has no build yet`, { key: entry.key });
  }
  const output = [];
  for (const step of entry.build({ dir, work, env })) {
    let report;
    try {
      report = await runStep(step, env);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new BuildError(
          `the ${entry.key} member mapper needs ${step.command}, which was not found; install it`,
          { key: entry.key, output },
        );
      }
      throw new BuildError(`the ${entry.key} member mapper build could not start ${step.command}`, {
        key: entry.key,
        output,
      });
    }
    output.push(report);
    if (report.code !== 0) {
      throw new BuildError(
        `the ${entry.key} member mapper build failed: ${step.command} exited with code ${report.code}`,
        { key: entry.key, output },
      );
    }
  }
  return output;
}
