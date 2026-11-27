import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const action = parse(readFileSync(new URL("../action.yml", import.meta.url), "utf8"));
const steps = action.runs.steps;
const step = (id) => steps.find((candidate) => candidate.id === id);
// A GitHub expression, built so the string holds no template placeholder.
const expr = (body) => `$\{{ ${body} }}`;
const GATE = "steps.probe.outputs.changed == 'true'";

describe("action.yml", () => {
  it("is a composite action", () => {
    assert.equal(action.runs.using, "composite");
  });

  it("declares the documented inputs and the changed output", () => {
    assert.deepEqual(Object.keys(action.inputs).sort(), ["config", "dry-run", "force", "token"]);
    assert.equal(action.inputs.token.default, expr("github.token"));
    assert.equal(action.inputs.config.default, ".github/pr-conflict-radar.json");
    assert.equal(action.inputs["dry-run"].default, "false");
    assert.equal(action.inputs.force.default, "false");
    assert.deepEqual(Object.keys(action.outputs), ["changed"]);
    assert.equal(action.outputs.changed.value, expr("steps.probe.outputs.changed"));
  });

  it("runs probe, prepare and scan in that order, after the version checks", () => {
    const ids = steps.map((candidate) => candidate.id);
    assert.deepEqual(ids, [undefined, "probe", "prepare", "scan"]);
    assert.match(steps[0].run, /Node\.js 20/);
    assert.match(steps[0].run, /git 2\.38/);
  });

  it("runs prepare and scan only when changed, and probe always", () => {
    assert.equal(step("probe").if, undefined);
    assert.equal(step("prepare").if, GATE);
    assert.equal(step("scan").if, GATE);
  });

  it("runs each phase through the CLI in the action's directory", () => {
    for (const phase of ["probe", "prepare", "scan"]) {
      assert.match(step(phase).run, new RegExp(`pr-conflict-radar\\.mjs" ${phase} `));
      assert.equal(step(phase).env.ACTION_PATH, expr("github.action_path"));
      assert.equal(step(phase).env.GH_TOKEN, expr("inputs.token"));
    }
  });

  it("passes inputs through the environment, never into the script text", () => {
    for (const candidate of steps) {
      assert.doesNotMatch(candidate.run, /\$\{\{/);
    }
  });
});
