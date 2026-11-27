#!/usr/bin/env node
// The CLI entry. Phases, one per action step:
//   probe        the quick exit; sets the `changed` output
//   prepare      fetches the listed commits, decides which mappers are needed,
//                sets one output per registry entry and writes the state file
//   build <key>  builds the member mapper of that registry entry
//   scan         simulates, maps the changed lines of the needed member
//                mappers to members, publishes and prints the job summary
// With no phase, `--dry-run` runs all of them in one process, the builds of the
// needed mappers one after another.
// Flags: `--config <path>`, `--force`, `--dry-run`.

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig } from "./lib/config.mjs";
import { annotation, logLine } from "./lib/escape.mjs";
import {
  assertGitVersion,
  changedFiles,
  deleteRefs,
  fetchCommits,
  findMergeBase,
  GitError,
  runGit,
} from "./lib/git.mjs";
import { createGitHub, DEFAULT_API_URL, GitHubError } from "./lib/github.mjs";
import { BuildError, mapMembers, mappersNeeded, runBuild } from "./lib/members.mjs";
import { selectPrs } from "./lib/order.mjs";
import { probe } from "./lib/probe.mjs";
import { isCheckWrite, planPublish, publish } from "./lib/publish.mjs";
import { buildResults, renderJobSummary } from "./lib/report.mjs";
import { simulate } from "./lib/simulate.mjs";
import { registry as defaultRegistry } from "./members/registry.mjs";

export const PHASES = Object.freeze(["probe", "prepare", "build", "scan"]);
export const QUICK_EXIT_LINE =
  "The published results already record the current state; nothing was scanned.";

const MIN_NODE_MAJOR = 20;
const STATE_FILE = "state.json";
const STATE_VERSION = 1;
const USAGE = [
  "Usage: pr-conflict-radar.mjs [probe | prepare | build <key> | scan] [--config <path>] [--force] [--dry-run]",
  "With no phase, --dry-run runs every phase in one process and publishes nothing.",
];

// A failure with a fixed annotation: `message` is a key of `ANNOTATION_MESSAGES`,
// `numbers` fill its placeholders and `detail` goes on the next line.
class CliError extends Error {
  constructor(message, { numbers = [], detail } = {}) {
    super(message);
    this.name = "CliError";
    this.annotation = message;
    this.numbers = numbers;
    this.detail = detail;
  }
}

// The repository named by an `origin` URL in the https, ssh or scp-like form.
export function repositoryFromUrl(url) {
  const match =
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?[^/:\s]+[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

async function resolveRepository(env, cwd) {
  if (env.GITHUB_REPOSITORY) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) {
      throw new CliError("repositoryUnknown", { detail: "GITHUB_REPOSITORY is not owner/name" });
    }
    return env.GITHUB_REPOSITORY;
  }
  const result = await runGit(["remote", "get-url", "--", "origin"], { cwd, env });
  const repo = result.code === 0 ? repositoryFromUrl(result.stdout.toString("utf8")) : null;
  if (repo === null) {
    throw new CliError("repositoryUnknown", { detail: "no origin remote names a repository" });
  }
  return repo;
}

function resolveToken(env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new CliError("tokenMissing");
  return token;
}

function assertNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) throw new CliError("nodeUnsupported");
}

// The flags are present or absent; the phase and the mapper key are positional.
function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  return {
    phase: positionals[0] ?? null,
    key: positionals[1] ?? null,
    extra: positionals.slice(positionals[0] === "build" ? 2 : 1),
    config: values.config ?? DEFAULT_CONFIG_PATH,
    force: values.force,
    dryRun: values["dry-run"],
  };
}

// Runs the build of `entry` and logs the captured output of each step through
// the log serializer. A failed build throws, or with `tolerate` resolves to its
// message; it resolves to `null` when the build succeeds.
async function buildPhase(entry, work, { env, out, tolerate = false }) {
  try {
    const reports = await runBuild(entry, { work, env });
    for (const report of reports) out(logLine({ build: entry.key, ...report }));
    return null;
  } catch (error) {
    if (error instanceof BuildError) {
      for (const report of error.output) out(logLine({ build: entry.key, ...report }));
      if (tolerate) return error.message;
      throw new CliError("buildFailed", { detail: error.message });
    }
    throw error;
  }
}

// Runs the CLI with `argv` (the arguments after the script name) and resolves
// to the exit code. Options: `env`, `cwd`, `fetch` (the GitHub client's),
// `registry`, `stdout` (anything with `write`), `sleep` and `mapperTimeout`,
// the time limit of one mapper run in milliseconds.
export async function main(argv, options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    fetch = globalThis.fetch,
    registry = defaultRegistry,
    stdout = process.stdout,
    sleep,
    mapperTimeout,
  } = options;
  const out = (line) => stdout.write(`${line}\n`);
  // Prose the tool composed: a line that could pass for a workflow command goes
  // through the log serializer instead.
  const text = (block) => {
    for (const line of block.split("\n")) {
      out(/^\s*::|##\[/.test(line) ? logLine(line) : line);
    }
  };
  let token = "";
  const scrub = (value) => (token ? value.split(token).join("***") : value);

  let args;
  try {
    args = parse(argv);
  } catch (error) {
    out(logLine(String(error.message)));
    for (const line of USAGE) out(line);
    return 2;
  }
  if (
    (args.phase !== null && !PHASES.includes(args.phase)) ||
    args.extra.length > 0 ||
    (args.phase === "build" && args.key === null) ||
    (args.phase !== "build" && args.key !== null)
  ) {
    for (const line of USAGE) out(line);
    return 2;
  }
  if (args.phase === null && !args.dryRun) {
    for (const line of USAGE) out(line);
    return 2;
  }

  const gitOptions = { cwd, env };
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  const summary = (block) => {
    if (summaryFile) appendFileSync(summaryFile, `${block}\n`);
  };
  const setOutputs = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
      else out(`${key}=${value}`);
    }
  };
  const runnerWork = env.RUNNER_TEMP ? resolve(env.RUNNER_TEMP, "pr-conflict-radar") : null;
  // The environment of the builds and the mapper runs: the token stays out.
  const toolEnv = { ...env };
  delete toolEnv.GH_TOKEN;
  delete toolEnv.GITHUB_TOKEN;

  let ownedWork = null;
  try {
    assertNode();
    const dryRun = args.dryRun;

    if (args.phase === "build") {
      const entry = registry.find((candidate) => candidate.key === args.key);
      if (!entry) throw new CliError("toolFailed", { detail: "unknown member mapper key" });
      if (runnerWork === null) {
        throw new CliError("toolFailed", { detail: "RUNNER_TEMP is not set" });
      }
      mkdirSync(runnerWork, { recursive: true });
      await buildPhase(entry, runnerWork, { env: toolEnv, out });
      return 0;
    }

    const config = (() => {
      try {
        return loadConfig(resolve(cwd, args.config), { registry });
      } catch (error) {
        if (error instanceof ConfigError) {
          throw new CliError("configInvalid", { detail: error.message });
        }
        throw error;
      }
    })();
    token = resolveToken(env);
    const repo = await resolveRepository(env, cwd);
    const client = createGitHub({
      token,
      repo,
      fetch,
      apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
      ...(sleep ? { sleep } : {}),
    });

    // The quick exit. `--force` and `--dry-run` skip it.
    async function probePhase() {
      if (args.force || dryRun) {
        out("The quick exit is skipped.");
        setOutputs({ changed: true });
        return { changed: true };
      }
      const state = await client.readState(config);
      const verdict = probe(state, config);
      out(verdict.message);
      if (!verdict.changed) summary(`## PR conflict radar\n\n${QUICK_EXIT_LINE}`);
      setOutputs({ changed: verdict.changed });
      return verdict;
    }

    async function preparePhase(work) {
      await assertGitVersion(gitOptions);
      const state = await client.readState(config);
      const { selected } = selectPrs(state.pulls, config, state.base.ref);
      const heads = selected.map((pull) => ({ pr: pull.number, sha: pull.headRefOid }));
      const refs = await fetchCommits("origin", state.base.sha, heads, gitOptions);
      const paths = [];
      for (const pull of selected) {
        // A head that shares no history with the base is not simulated.
        const ancestor = await findMergeBase(refs.base, refs.heads[pull.number], gitOptions);
        if (ancestor === null) continue;
        for (const file of await changedFiles(ancestor, pull.headRefOid, gitOptions)) {
          paths.push(file.path);
          if (file.previousPath !== null) paths.push(file.previousPath);
        }
      }
      const needed = mappersNeeded(config, paths, { registry });
      mkdirSync(work, { recursive: true });
      writeFileSync(
        join(work, STATE_FILE),
        JSON.stringify({ version: STATE_VERSION, repo, state, needed }),
        { mode: 0o600 },
      );
      setOutputs(needed);
      return { state, needed };
    }

    // Simulates the commits of the saved state, maps members with the needed
    // mappers, publishes (or with `--dry-run` plans) and resolves to the mapper
    // failures. `unavailable` maps a key to the message of its failed build.
    async function scanPhase(work, unavailable = {}) {
      let saved;
      try {
        saved = JSON.parse(readFileSync(join(work, STATE_FILE), "utf8"));
      } catch {
        throw new CliError("toolFailed", {
          detail: "the state file of the prepare phase is missing",
        });
      }
      if (saved.version !== STATE_VERSION || saved.repo !== repo) {
        throw new CliError("toolFailed", { detail: "the state file does not match this run" });
      }
      const { state } = saved;
      await assertGitVersion(gitOptions);
      try {
        const simulation = await simulate(state.base, state.pulls, config, gitOptions);
        const conflicting = new Set(simulation.baseConflicts.map((entry) => entry.pr));
        const members = await mapMembers({
          base: state.base,
          pulls: simulation.order
            .filter((number) => !conflicting.has(number))
            .map((number) => simulation.pulls[number]),
          config,
          needed: saved.needed ?? {},
          registry,
          unavailable,
          work,
          env: toolEnv,
          git: gitOptions,
          ...(mapperTimeout ? { timeoutMs: mapperTimeout } : {}),
        });
        const results = buildResults(simulation, config, repo, members);
        let counts;
        if (dryRun) {
          const writes = planPublish(results, state, config);
          const checks = writes.filter(isCheckWrite).length;
          counts = { checks, comments: writes.length - checks };
        } else {
          const made = await publish(results, state, client, config);
          counts = { checks: made.checks, comments: made.comments };
        }
        const report = renderJobSummary(results, config, { writes: counts, dryRun });
        summary(report);
        if (dryRun) text(report);
        out(logLine(results));
        return members.failures;
      } finally {
        await deleteRefs(gitOptions);
      }
    }

    if (args.phase === "probe") {
      await probePhase();
    } else if (args.phase === "prepare") {
      if (runnerWork === null)
        throw new CliError("toolFailed", { detail: "RUNNER_TEMP is not set" });
      await preparePhase(runnerWork);
    } else if (args.phase === "scan") {
      if (runnerWork === null)
        throw new CliError("toolFailed", { detail: "RUNNER_TEMP is not set" });
      return mapperFailures(await scanPhase(runnerWork), { out, scrub });
    } else {
      const verdict = await probePhase();
      if (!verdict.changed) return 0;
      ownedWork = mkdtempSync(join(tmpdir(), "pr-conflict-radar-"));
      const { needed } = await preparePhase(ownedWork);
      // A build that fails here is a mapper failure: the scan still publishes
      // the textual result, marked degraded, and the run exits non-zero.
      const unavailable = {};
      for (const entry of registry) {
        if (!needed[entry.key] || typeof entry.build !== "function") continue;
        const failed = await buildPhase(entry, ownedWork, { env: toolEnv, out, tolerate: true });
        if (failed !== null) unavailable[entry.key] = failed;
      }
      return mapperFailures(await scanPhase(ownedWork, unavailable), { out, scrub });
    }
    return 0;
  } catch (error) {
    reportFailure(error, { out, scrub });
    return 1;
  } finally {
    if (ownedWork !== null) rmSync(ownedWork, { recursive: true, force: true });
  }
}

// Prints the annotation of the mapper failures of a scan that published its
// results and then one line per failure, with the mapper's captured output,
// through the log serializer. Returns the exit code.
function mapperFailures(failures, { out, scrub }) {
  if (failures.length === 0) return 0;
  out(annotation("error", "mapperFailed", [failures.length]));
  for (const failure of failures) out(scrub(logLine(failure)));
  return 1;
}

// Prints the annotation of a failure and, on the next line, its detail through
// the log serializer.
function reportFailure(error, { out, scrub }) {
  let message = "toolFailed";
  let numbers = [];
  let detail = { message: String(error?.message ?? error) };
  if (error instanceof CliError) {
    message = error.annotation;
    numbers = error.numbers;
    detail = error.detail === undefined ? undefined : { message: error.detail };
  } else if (error instanceof GitError) {
    const missing = error.missing?.length ?? 0;
    message = missing > 0 ? "commitsMissing" : "gitFailed";
    numbers = missing > 0 ? [missing] : [];
    detail = { message: error.message, stderr: error.stderr };
  } else if (error instanceof GitHubError) {
    message = "apiFailed";
    numbers = [error.status];
    detail = { message: error.message };
  }
  out(annotation("error", message, numbers));
  if (detail !== undefined) out(scrub(logLine(detail)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
