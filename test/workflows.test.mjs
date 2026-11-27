import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { defaultConfig, loadConfig } from "../lib/config.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const load = (path) => parse(read(path));

// A GitHub expression, built so that the source holds no template placeholder.
const expr = (body) => ["$", "{{ ", body, " }}"].join("");

const ACTION = /^nnemirovsky\/pr-conflict-radar@[0-9a-f]{40}$/;

// The workflow with the action's `uses:` reference replaced by `ref`.
function withAction(workflow, ref) {
  const copy = structuredClone(workflow);
  for (const step of copy.jobs.scan?.steps ?? []) {
    if (typeof step.uses === "string" && ACTION.test(step.uses)) step.uses = ref;
  }
  return copy;
}

describe("repository workflows", () => {
  it("the trigger equals its example", () => {
    assert.deepEqual(
      load(".github/workflows/pr-conflict-radar-trigger.yml"),
      load("examples/pr-conflict-radar-trigger.yml"),
    );
  });

  it("the scan equals its example except for the uses line of the action", () => {
    const example = load("examples/pr-conflict-radar.yml");
    const own = load(".github/workflows/pr-conflict-radar.yml");
    const exampleUses = example.jobs.scan.steps.filter((step) => ACTION.test(step.uses ?? ""));
    assert.equal(exampleUses.length, 1, "the example references the action once, by commit SHA");
    assert.deepEqual(own, withAction(example, "./"));
    assert.ok(own.jobs.scan.steps.some((step) => step.uses === "./"));
  });
});

describe("the trigger workflow", () => {
  const workflow = load("examples/pr-conflict-radar-trigger.yml");
  const job = workflow.jobs.dispatch;

  it("has no checkout and no step besides the dispatch", () => {
    assert.equal(job.steps.length, 1);
    assert.equal(job.steps[0].uses, undefined);
    assert.match(job.steps[0].run, /^gh workflow run pr-conflict-radar\.yml /);
  });

  it("keeps a failed dispatch off the pull request", () => {
    assert.equal(job.steps[0]["continue-on-error"], true);
  });

  it("has actions: write as its only job permission", () => {
    assert.deepEqual(job.permissions, { actions: "write" });
    assert.deepEqual(workflow.permissions, { contents: "read" });
  });

  it("interpolates nothing a pull request author controls into run", () => {
    assert.doesNotMatch(job.steps[0].run, /\$\{\{/);
    const env = JSON.stringify(job.steps[0].env);
    assert.doesNotMatch(env, /github\.event\.pull_request/);
    assert.doesNotMatch(env, /github\.head_ref/);
  });

  it("queues per pull request without cancelling", () => {
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.equal(workflow.concurrency.queue, "max");
    assert.match(workflow.concurrency.group, /github\.event\.pull_request\.number/);
  });
});

describe("the scan workflow", () => {
  const workflow = load("examples/pr-conflict-radar.yml");

  it("shares one publishing group per ref and never cancels", () => {
    assert.equal(
      workflow.concurrency.group,
      `pr-conflict-radar-${expr("github.ref")}-${expr("inputs.dry-run && 'dry-run' || 'publish'")}`,
    );
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
  });

  it("makes a dispatch from another branch a dry run", () => {
    const step = workflow.jobs.scan.steps.find((s) => ACTION.test(s.uses ?? ""));
    assert.equal(
      step.with["dry-run"],
      expr(
        "inputs.dry-run || (github.event_name == 'workflow_dispatch' && github.ref_name != github.event.repository.default_branch)",
      ),
    );
    assert.equal(step.with.force, expr("inputs.force || false"));
  });

  it("grants the scan its permissions", () => {
    assert.deepEqual(workflow.jobs.scan.permissions, {
      contents: "read",
      checks: "write",
      "pull-requests": "write",
      statuses: "read",
    });
  });
});

describe("examples/pr-conflict-radar.json", () => {
  it("loads and equals the built-in defaults", () => {
    const config = loadConfig(
      new URL("../examples/pr-conflict-radar.json", import.meta.url).pathname,
    );
    assert.deepEqual(config, defaultConfig());
    assert.deepEqual(Object.keys(config.members).slice(0, 5).sort(), [
      "cpp",
      "csharp",
      "go",
      "rust",
      "typescript",
    ]);
    assert.equal(config.suggestPeerbus, true);
  });
});
