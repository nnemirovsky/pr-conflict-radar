import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { embed, extract } from "../lib/report.mjs";
import { registry as defaultRegistry } from "../members/registry.mjs";
import { main, QUICK_EXIT_LINE, repositoryFromUrl } from "../pr-conflict-radar.mjs";
import { createFakeGitHub } from "./fake-github.mjs";
import { fakeRun, runsIn } from "./fake-mapper.mjs";
import { createFixture } from "./fixture-repo.mjs";

const TOKEN = "ghs_secretTOKENvalue123";
const REPO = "acme/widgets";
const CHECK_NAME = "PR conflict radar";

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});
after(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

// Three pull request heads against one base: 12 and 15 change the same line of
// one file, 20 adds a new file. `extra` adds files to the base and to heads.
function scenario({ base = {}, heads } = {}) {
  const fx = createFixture();
  const work = mkdtempSync(join(tmpdir(), "pr-conflict-radar-cli-"));
  cleanups.push(() => {
    fx.cleanup();
    rmSync(work, { recursive: true, force: true });
  });
  const baseSha = fx.commit({
    files: { "src/cart.txt": "a\nb\nc\n", "docs/readme.md": "x\n", ...base },
    branch: "main",
  });
  const specs = heads ?? {
    12: { "src/cart.txt": "a\nB12\nc\n" },
    15: { "src/cart.txt": "a\nB15\nc\n" },
    20: { "docs/notes.md": "n\n" },
  };
  const shas = {};
  for (const [number, files] of Object.entries(specs)) {
    shas[number] = fx.commit({ parent: baseSha, files });
    fx.publishPull(Number(number), shas[number]);
  }
  const clone = fx.clone();
  return { fx, work, clone, baseSha, shas };
}

function fakeFor(s, extra = {}) {
  return createFakeGitHub({
    repo: REPO,
    defaultBranch: { name: "main", oid: s.baseSha },
    prs: Object.entries(s.shas).map(([number, sha]) => ({
      number: Number(number),
      headRefOid: sha,
      author: Number(number) === 15 ? "bob" : "alice",
    })),
    ...extra,
  });
}

let runCount = 0;

// Runs the CLI once and returns `{code, output, lines, outputs, summary}`.
async function run(
  s,
  fake,
  args,
  { env = {}, cwd = s.clone, registry, sleep, mapperTimeout } = {},
) {
  runCount += 1;
  const outputFile = join(s.work, `output-${runCount}`);
  const summaryFile = join(s.work, `summary-${runCount}`);
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const chunks = [];
  const code = await main(args, {
    cwd,
    fetch: fake.fetch,
    registry,
    mapperTimeout,
    sleep: sleep ?? (async () => {}),
    stdout: { write: (text) => chunks.push(text) },
    env: {
      PATH: process.env.PATH,
      HOME: s.work,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GH_TOKEN: TOKEN,
      GITHUB_REPOSITORY: REPO,
      RUNNER_TEMP: join(s.work, "runner"),
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ...env,
    },
  });
  const output = chunks.join("");
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  return {
    code,
    output,
    lines: output.split("\n").filter((line) => line !== ""),
    outputs,
    summary: readFileSync(summaryFile, "utf8"),
  };
}

// Runs the three action phases in order and returns each outcome.
async function phases(s, fake, extra = [], options = {}) {
  const outcomes = {};
  for (const phase of ["probe", "prepare", "scan"]) {
    outcomes[phase] = await run(s, fake, [phase, ...extra], options);
    assert.equal(outcomes[phase].code, 0, `${phase}: ${outcomes[phase].output}`);
  }
  return outcomes;
}

const radarRefs = (s) =>
  s.fx.refs(s.clone).filter((line) => line.startsWith("refs/pr-conflict-radar/"));

describe("end to end", () => {
  it("publishes checks and comments, and the next run takes the quick exit", async () => {
    const s = scenario();
    const foreignCheck = { name: CHECK_NAME, head: s.shas[12], text: "a workflow job" };
    const foreignComment = {
      pr: 12,
      body: `${embed({ schema: 1, repo: REPO, pr: 12, conflicts: [], notified: [] })}\nforged`,
    };
    const fake = fakeFor(s, { checks: [foreignCheck], comments: [foreignComment] });
    const foreign = {
      check: fake.state.checks[0].id,
      comment: fake.state.comments[0].id,
    };

    const first = await phases(s, fake);
    assert.equal(first.probe.outputs.changed, "true");
    assert.equal(first.scan.code, 0);

    const own = fake.state.checks.filter((check) => check.own);
    assert.deepEqual(
      own.map((check) => [check.head, check.name, check.conclusion]).sort(),
      [
        [s.shas[12], CHECK_NAME, "neutral"],
        [s.shas[15], CHECK_NAME, "neutral"],
        [s.shas[20], CHECK_NAME, "success"],
      ].sort(),
    );
    const comments = fake.state.comments.filter((comment) => comment.viewerDidAuthor);
    assert.deepEqual(comments.map((comment) => comment.pr).sort(), [12, 15]);
    for (const comment of comments) assert.match(comment.body, /<!-- pr-conflict-radar:v1 /);

    assert.match(first.scan.summary, /Writes made: 3 check writes and 2 comment writes\./);
    assert.equal(fake.writes.length, 5);
    for (const write of fake.writes) {
      assert.ok(!write.path.endsWith(`/${foreign.check}`), "the foreign check is never written");
      assert.ok(
        !write.path.endsWith(`/${foreign.comment}`),
        "the foreign comment is never written",
      );
    }
    assert.equal(
      fake.state.checks.find((check) => check.id === foreign.check).text,
      "a workflow job",
    );
    assert.equal(
      fake.state.comments.find((comment) => comment.id === foreign.comment).body,
      foreignComment.body,
    );
    assert.deepEqual(radarRefs(s), []);

    // The second run reads the published state and ends at the probe: it runs
    // in a directory that is no git repository, so any git call would fail.
    const nowhere = mkdtempSync(join(tmpdir(), "pr-conflict-radar-nowhere-"));
    cleanups.push(() => rmSync(nowhere, { recursive: true, force: true }));
    const writesBefore = fake.writes.length;
    const second = await run(s, fake, ["probe"], { cwd: nowhere });
    assert.equal(second.code, 0);
    assert.equal(second.outputs.changed, "false");
    assert.match(second.summary, new RegExp(QUICK_EXIT_LINE));
    assert.equal(fake.writes.length, writesBefore);
    assert.deepEqual(radarRefs(s), []);
  });
});

describe("a head without shared history", () => {
  it("gets a not-simulated result while the other pull requests are published", async () => {
    const s = scenario();
    s.shas[14] = s.fx.commit({ parent: null, files: { "src/cart.txt": "z\n" } });
    s.fx.publishPull(14, s.shas[14]);
    const fake = fakeFor(s);

    const first = await phases(s, fake);
    assert.equal(first.scan.code, 0);
    const own = fake.state.checks.filter((check) => check.own);
    assert.deepEqual(
      own.map((check) => [check.head, check.conclusion, check.title]).sort(),
      [
        [s.shas[12], "neutral", "Conflicts with 1 pull request"],
        [s.shas[14], "neutral", "Not simulated"],
        [s.shas[15], "neutral", "Conflicts with 1 pull request"],
        [s.shas[20], "success", "No conflicts"],
      ].sort(),
    );
    assert.deepEqual(radarRefs(s), []);

    const second = await run(s, fake, ["probe"]);
    assert.equal(second.code, 0);
    assert.equal(second.outputs.changed, "false");
  });
});

describe("--dry-run", () => {
  it("writes nothing, prints the planned write count and leaves no ref behind", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, ["--dry-run"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(fake.writes.length, 0);
    assert.match(result.output, /A publish would make 3 check writes and 2 comment writes\./);
    assert.deepEqual(radarRefs(s), []);
  });

  it("never takes the quick exit", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    await phases(s, fake);
    const writes = fake.writes.length;
    const result = await run(s, fake, ["--dry-run"]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, new RegExp(QUICK_EXIT_LINE));
    assert.match(result.output, /A publish would make 0 check writes and 0 comment writes\./);
    assert.equal(fake.writes.length, writes);
  });

  it("makes the scan phase publish nothing", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    await run(s, fake, ["prepare"]);
    const result = await run(s, fake, ["scan", "--dry-run"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(fake.writes.length, 0);
    assert.match(result.summary, /A publish would make 3 check writes/);
  });

  it("without a phase and without --dry-run is a usage error", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, []);
    assert.equal(result.code, 2);
    assert.equal(fake.calls.length, 0);
  });
});

describe("--force", () => {
  it("skips the quick exit", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    await phases(s, fake);
    const quiet = await run(s, fake, ["probe"], { cwd: tmpdir() });
    assert.equal(quiet.outputs.changed, "false");
    const calls = fake.calls.length;
    const forced = await run(s, fake, ["probe", "--force"]);
    assert.equal(forced.outputs.changed, "true");
    assert.equal(fake.calls.length, calls, "the forced probe reads nothing");
  });
});

describe("config", () => {
  it("runs with no config file", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    await phases(s, fake);
    assert.ok(fake.writes.some((write) => write.body?.name === CHECK_NAME));
  });

  it("reads the file named by --config", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const path = join(s.work, "radar.json");
    writeFileSync(path, JSON.stringify({ checkName: "Custom radar" }));
    await phases(s, fake, ["--config", path]);
    const names = fake.writes.filter((w) => w.path.endsWith("/check-runs")).map((w) => w.body.name);
    assert.deepEqual(names, ["Custom radar", "Custom radar", "Custom radar"]);
  });

  it("fails with the config annotation on an invalid file", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const path = join(s.work, "radar.json");
    writeFileSync(path, JSON.stringify({ maxPrs: 0 }));
    const result = await run(s, fake, ["probe", "--config", path]);
    assert.equal(result.code, 1);
    assert.equal(
      result.lines[0],
      "::error::The pr-conflict-radar config is invalid. The detail is on the next line.",
    );
    assert.ok(result.lines[1].startsWith("{"));
    assert.match(result.lines[1], /maxPrs/);
  });
});

describe("repository", () => {
  it("parses an origin URL in the https and ssh forms", () => {
    assert.equal(repositoryFromUrl("https://github.com/acme/widgets.git\n"), REPO);
    assert.equal(repositoryFromUrl("https://github.com/acme/widgets"), REPO);
    assert.equal(repositoryFromUrl("https://x-access-token@github.com/acme/widgets.git"), REPO);
    assert.equal(repositoryFromUrl("git@github.com:acme/widgets.git"), REPO);
    assert.equal(repositoryFromUrl("ssh://git@github.com/acme/widgets.git"), REPO);
    assert.equal(repositoryFromUrl("git@github.com:acme/my.widgets.git"), "acme/my.widgets");
    assert.equal(repositoryFromUrl("not a url"), null);
    assert.equal(repositoryFromUrl("https://github.com/widgets"), null);
  });

  const owner = (call) => `${call.body.variables.owner}/${call.body.variables.name}`;

  it("comes from GITHUB_REPOSITORY", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    s.fx.git(["remote", "set-url", "origin", "https://github.com/other/thing.git"], {
      cwd: s.clone,
    });
    await run(s, fake, ["probe"]);
    assert.equal(owner(fake.calls[0]), REPO);
  });

  for (const url of ["https://github.com/acme/widgets.git", "git@github.com:acme/widgets.git"]) {
    it(`comes from an origin URL ${url}`, async () => {
      const s = scenario();
      const fake = fakeFor(s);
      s.fx.git(["remote", "set-url", "origin", url], { cwd: s.clone });
      const result = await run(s, fake, ["probe"], { env: { GITHUB_REPOSITORY: "" } });
      assert.equal(result.code, 0, result.output);
      assert.equal(owner(fake.calls[0]), REPO);
    });
  }

  it("fails when neither names a repository", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    s.fx.git(["remote", "remove", "origin"], { cwd: s.clone });
    const result = await run(s, fake, ["probe"], { env: { GITHUB_REPOSITORY: "" } });
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /^::error::The repository is unknown/);
  });
});

describe("failures", () => {
  it("fails without a token and says so", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, ["probe"], { env: { GH_TOKEN: "" } });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["::error::No token: set GH_TOKEN or GITHUB_TOKEN."]);
    assert.equal(fake.calls.length, 0);
  });

  it("takes GITHUB_TOKEN when GH_TOKEN is absent", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, ["probe"], { env: { GH_TOKEN: "", GITHUB_TOKEN: TOKEN } });
    assert.equal(result.code, 0, result.output);
  });

  it("exits non-zero on a tool failure, with the annotation and a serialized detail", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    fake.failWith(() => new Response("boom", { status: 500 }));
    const result = await run(s, fake, ["probe"]);
    assert.equal(result.code, 1);
    assert.equal(
      result.lines[0],
      "::error::A GitHub API request failed with status 500. The detail is on the next line.",
    );
    assert.ok(result.lines[1].startsWith("{"));
    assert.ok(!result.output.includes(TOKEN));
  });

  it("fails for a listed commit the remote does not serve", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    fake.state.prs[0].headRefOid = "1".repeat(40);
    await run(s, fake, ["probe"]);
    const result = await run(s, fake, ["prepare"]);
    assert.equal(result.code, 1);
    assert.equal(
      result.lines[0],
      "::error::The remote does not serve 1 of the listed commits. The detail is on the next line.",
    );
    assert.ok(result.lines[1].startsWith("{"));
    assert.deepEqual(radarRefs(s), []);
  });

  it("fails the scan when prepare did not run", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, ["scan"]);
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /^::error::pr-conflict-radar failed\./);
  });

  it("rejects an unknown phase", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    assert.equal((await run(s, fake, ["publish"])).code, 2);
    assert.equal((await run(s, fake, ["build"])).code, 2);
    assert.equal((await run(s, fake, ["probe", "--nope"])).code, 2);
  });
});

describe("log safety", () => {
  it("reaches the log only inside serialized lines", async () => {
    const hostile = ["##[error]x", "dir/a\n::error::x", "::add-mask::b"];
    const base = Object.fromEntries(hostile.map((path) => [path, "1\n2\n3\n"]));
    const s = scenario({
      base,
      heads: {
        12: Object.fromEntries(hostile.map((path) => [path, "1\nfirst\n3\n"])),
        15: Object.fromEntries(hostile.map((path) => [path, "1\nsecond\n3\n"])),
      },
    });
    const fake = fakeFor(s);
    const dry = await run(s, fake, ["--dry-run"]);
    const published = await phases(s, fake);
    for (const result of [dry, published.probe, published.prepare, published.scan]) {
      assert.equal(result.code, 0, result.output);
      for (const line of result.output.split("\n")) {
        assert.ok(!/^\s*::/.test(line), `a line starts a workflow command: ${line}`);
        assert.ok(!line.includes("##["), `a line holds a workflow command: ${line}`);
      }
    }
    assert.ok(dry.output.includes("x"));
    const resultsLine = dry.lines.find((line) => line.startsWith("["));
    assert.ok(resultsLine.includes("\\n::error::x"), "the path is in the results, serialized");
  });
});

describe("prepare", () => {
  it("writes one boolean output per registry entry, named by its key", async () => {
    const s = scenario({ heads: { 12: { "ui/app.jsx": "x\n", "lib/util.h": "y\n" } } });
    const fake = fakeFor(s);
    const result = await run(s, fake, ["prepare"]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      Object.keys(result.outputs),
      defaultRegistry.map((entry) => entry.key),
    );
    assert.deepEqual(result.outputs, {
      typescript: "true",
      csharp: "false",
      go: "false",
      rust: "false",
      cpp: "true",
    });
  });

  it("does not count a file of a pull request that is not simulated", async () => {
    const s = scenario({
      heads: { 12: { "docs/a.md": "x\n" }, 15: { "tool/main.go": "package main\n" } },
    });
    const fake = fakeFor(s);
    fake.state.prs.find((pr) => pr.number === 15).baseRefName = "release";
    const result = await run(s, fake, ["prepare"]);
    assert.equal(result.outputs.go, "false");
  });

  it("fetches with the token from a server that needs credentials the checkout did not configure", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const tokenHeader = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
    const server = await s.fx.serve({ accept: [tokenHeader] });
    cleanups.push(() => server.close());
    s.fx.git(["remote", "set-url", "origin", server.url], { cwd: s.clone });

    const result = await run(s, fake, ["prepare"], { env: { GITHUB_SERVER_URL: server.origin } });
    assert.equal(result.code, 0, result.output);
    assert.ok(server.requests.some((request) => request.authorization[0] === tokenHeader));
    assert.ok(!result.output.includes(TOKEN));
    const config = readFileSync(join(s.clone, ".git", "config"), "utf8");
    assert.ok(!config.includes(TOKEN) && !config.includes(tokenHeader.slice(6)));
  });
});

describe("build", () => {
  const entry = (command, args = []) => ({
    key: "fake",
    patterns: ["**/*.fake"],
    build: ({ dir, work }) => [
      { command, args, cwd: work, env: { ...process.env, MAPPER_DIR: dir } },
    ],
  });
  const registry = (extra) => [...defaultRegistry, extra];

  it("runs the build of a registry entry and logs its output as serialized lines", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, ["build", "fake"], {
      registry: registry(entry(process.execPath, ["-e", "console.log('##[error]built')"])),
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.lines.length, 1);
    assert.ok(result.lines[0].startsWith("{"));
    assert.ok(!result.output.includes("##["));
    assert.equal(fake.calls.length, 0, "a build reads nothing from GitHub");
  });

  it("fails with the build annotation, naming the tool, when the command is missing", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const result = await run(s, fake, ["build", "fake"], {
      registry: registry(entry("pr-conflict-radar-no-such-tool")),
    });
    assert.equal(result.code, 1);
    assert.equal(
      result.lines[0],
      "::error::A member mapper build failed. The detail is on the next line.",
    );
    assert.match(result.lines[1], /pr-conflict-radar-no-such-tool/);
  });

  it("fails clearly for an entry without a build and for an unknown key", async () => {
    const s = scenario();
    const fake = fakeFor(s);
    const noBuild = await run(s, fake, ["build", "fake"], {
      registry: registry({ key: "fake", patterns: ["**/*.fake"] }),
    });
    assert.equal(noBuild.code, 1);
    assert.match(noBuild.lines[1], /no build yet/);
    const unknown = await run(s, fake, ["build", "java"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.lines[1], /unknown member mapper key/);
  });

  it("builds every needed mapper that has a build in a dry run without a phase", async () => {
    const s = scenario({ heads: { 12: { "tool/a.fake": "x\n" } } });
    const fake = fakeFor(s);
    const marker = join(s.work, "built");
    const built = entry(process.execPath, [
      "-e",
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`,
    ]);
    const result = await run(s, fake, ["--dry-run"], { registry: registry(built) });
    assert.equal(result.code, 0, result.output);
    assert.equal(readFileSync(marker, "utf8"), "x");
    assert.equal(fake.writes.length, 0);
  });
});

describe("member overlap", () => {
  // One member over six lines: 12 and 15 change different lines of it, so the
  // pair merges cleanly and overlaps on the member.
  const MEMBER = "def Cart.add\n  total = 1\n  x\n  y\n  z\n  return total\ndef Other\n  q\n";
  const overlapScenario = (ext = "fk", text = MEMBER) =>
    scenario({
      base: { [`src/a.${ext}`]: text },
      heads: {
        12: { [`src/a.${ext}`]: text.replace("total = 1", "total = 2") },
        15: { [`src/a.${ext}`]: text.replace("return total", "return total + 1") },
      },
    });
  const fakeEntry = (options = {}, extra = {}) => ({
    key: "fake",
    patterns: ["**/*.fk"],
    run: fakeRun("fake", options),
    ...extra,
  });
  const withFake = (entry) => [...defaultRegistry, entry];
  const ownChecks = (fake) => fake.state.checks.filter((check) => check.own);

  it("publishes a same-member overlap as a neutral check and writes no comment", async () => {
    const s = overlapScenario();
    const fake = fakeFor(s);
    const log = join(s.work, "runs.log");
    const outcomes = await phases(s, fake, [], { registry: withFake(fakeEntry({ log })) });
    assert.equal(outcomes.prepare.outputs.fake, "true");
    assert.equal(runsIn(log).length, 2);
    const checks = ownChecks(fake);
    assert.deepEqual(
      checks.map((check) => check.conclusion),
      ["neutral", "neutral"],
    );
    for (const check of checks) {
      const result = extract(check.text);
      assert.deepEqual(result.overlaps[0].members, [{ path: "src/a.fk", name: "Cart.add" }]);
      assert.equal(result.degraded, false);
    }
    assert.equal(fake.state.comments.length, 0);
    assert.match(outcomes.scan.summary, /### Member overlaps/);
  });

  it("publishes the textual result marked degraded on a mapper failure, then exits non-zero", async () => {
    const s = overlapScenario();
    const fake = fakeFor(s);
    const registry = withFake(fakeEntry({ mode: "exit" }));
    for (const phase of ["probe", "prepare"]) {
      const outcome = await run(s, fake, [phase], { registry });
      assert.equal(outcome.code, 0, outcome.output);
    }
    const scan = await run(s, fake, ["scan"], { registry });
    assert.equal(scan.code, 1);
    const checks = ownChecks(fake);
    assert.equal(checks.length, 2);
    for (const check of checks) {
      const result = extract(check.text);
      assert.equal(result.degraded, true);
      assert.ok(
        result.notes.includes("Member overlap is incomplete: the fake member mapper failed."),
      );
      assert.deepEqual(result.overlaps, []);
    }
    const at = scan.lines.indexOf(
      "::error::1 member mapper runs failed. The detail is on the next line.",
    );
    assert.ok(at >= 0, scan.output);
    const detail = JSON.parse(scan.lines[at + 1]);
    assert.equal(detail.mapper, "fake");
    assert.equal(detail.code, 3);
    assert.match(detail.stderr, /boom/);
    for (const line of scan.lines) {
      assert.ok(!line.includes("##["), line);
      if (/^\s*::/.test(line)) assert.equal(line, scan.lines[at]);
    }
    assert.ok(!scan.output.includes(TOKEN));
    assert.match(scan.summary, /Degraded results: #12, #15\./);

    const probe = await run(s, fake, ["probe"], { registry });
    assert.equal(probe.code, 0, probe.output);
    assert.equal(probe.outputs.changed, "true");
    assert.match(probe.output, /degraded/);
  });

  it("stops a mapper over its time limit and takes the mapper-failure path in a dry run", async () => {
    const s = overlapScenario();
    const fake = fakeFor(s);
    const pids = join(s.work, "pids.json");
    const result = await run(s, fake, ["--dry-run"], {
      registry: withFake(fakeEntry({ mode: "hang", pids })),
      mapperTimeout: 300,
    });
    assert.equal(result.code, 1);
    assert.equal(fake.writes.length, 0);
    assert.ok(
      result.lines.includes(
        "::error::1 member mapper runs failed. The detail is on the next line.",
      ),
    );
    const results = JSON.parse(result.lines.find((line) => line.startsWith("[")));
    assert.ok(results.every((entry) => entry.degraded));
    assert.deepEqual(radarRefs(s), []);
  });

  it("counts a failed build of a dry run as a mapper failure and still scans", async () => {
    const s = overlapScenario();
    const fake = fakeFor(s);
    const log = join(s.work, "runs.log");
    const entry = fakeEntry(
      { log },
      { build: () => [{ command: "pr-conflict-radar-no-such-tool", args: [] }] },
    );
    const result = await run(s, fake, ["--dry-run"], { registry: withFake(entry) });
    assert.equal(result.code, 1);
    assert.deepEqual(runsIn(log), []);
    const at = result.lines.indexOf(
      "::error::1 member mapper runs failed. The detail is on the next line.",
    );
    assert.ok(at >= 0, result.output);
    assert.match(result.lines[at + 1], /pr-conflict-radar-no-such-tool/);
    assert.match(result.output, /A publish would make 2 check writes/);
    const results = JSON.parse(result.lines.find((line) => line.startsWith("[")));
    assert.ok(results.every((entry) => entry.degraded));
  });

  it("reports an overlap found by the real TypeScript mapper in a dry run", async () => {
    const source = [
      "export function computeTotal(items) {",
      "  let total = 0;",
      "  for (const item of items) total += item;",
      "  const tax = 0;",
      "  const fee = 0;",
      "  return total + tax + fee;",
      "}",
      "",
    ].join("\n");
    const s = scenario({
      base: { "src/cart.ts": source },
      heads: {
        12: { "src/cart.ts": source.replace("let total = 0", "let total = 1") },
        15: { "src/cart.ts": source.replace("return total", "return 2 * total") },
      },
    });
    const fake = fakeFor(s);
    const result = await run(s, fake, ["--dry-run"]);
    assert.equal(result.code, 0, result.output);
    const results = JSON.parse(result.lines.find((line) => line.startsWith("[")));
    for (const entry of results) {
      assert.deepEqual(entry.overlaps[0].members, [{ path: "src/cart.ts", name: "computeTotal" }]);
    }
  });
});
