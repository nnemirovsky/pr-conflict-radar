// One entry per member-overlap language, in registry order. An entry holds
// everything language-specific: its config key (also the name of its `prepare`
// output), its default patterns and any extra config option of its own. The
// config loader, `prepare`, the scan and the tests read this list, so a new
// language is a new entry here, a mapper directory and its test file.
//
// An option is `{default, validate(value, field)}`; `validate` returns `null`
// for a valid value and otherwise a message that names `field`.
//
// An entry whose mapper exists also holds `build({dir, work, env})`, the steps
// that prepare the mapper (see `lib/members.mjs`), and
// `run({dir, work, env, request, maxFileBytes, defines})`, the one command that
// maps a request file. Both return commands as argument arrays, never shell
// text. `dir` is the mapper's directory (the action's own `members/<key>` by
// default).

import { createRequire } from "node:module";
import { join } from "node:path";

// A `members.cpp.defines` entry: an object-like macro `NAME` or a function-like
// macro used as a declaration, `NAME(...)`.
export const DEFINE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\(\.\.\.\))?$/;
export const MAX_DEFINES = 200;

function validateDefines(value, field) {
  if (!Array.isArray(value)) return `${field} must be a list of macro names`;
  if (value.length > MAX_DEFINES) {
    return `${field} has ${value.length} entries, at most ${MAX_DEFINES} are allowed`;
  }
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string" || !DEFINE_PATTERN.test(entry)) {
      return `${field}[${i}] ${JSON.stringify(entry)} must be NAME or NAME(...)`;
    }
  }
  return null;
}

// The directory that holds `package.json` for a mapper directory `dir`
// (`<action>/members/<key>`).
function actionDirOf(dir) {
  return join(dir, "..", "..");
}

function typescriptResolves(actionDir) {
  try {
    createRequire(join(actionDir, "package.json")).resolve("typescript");
    return true;
  } catch {
    return false;
  }
}

function buildTypescript({ dir, env }) {
  const cwd = actionDirOf(dir);
  if (typescriptResolves(cwd)) return [];
  return [
    {
      command: "npm",
      args: ["ci", "--omit=dev", "--ignore-scripts"],
      cwd,
      env: {
        ...env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    },
  ];
}

function runTypescript({ dir, work, env, request, maxFileBytes }) {
  return {
    command: process.execPath,
    args: [join(dir, "member-map.mjs"), request, String(maxFileBytes)],
    cwd: work ?? dir,
    env,
  };
}

export const registry = Object.freeze([
  Object.freeze({
    key: "typescript",
    build: buildTypescript,
    run: runTypescript,
    patterns: Object.freeze([
      "**/*.ts",
      "**/*.tsx",
      "**/*.mts",
      "**/*.cts",
      "**/*.js",
      "**/*.jsx",
      "**/*.mjs",
      "**/*.cjs",
    ]),
  }),
  Object.freeze({
    key: "csharp",
    patterns: Object.freeze(["**/*.cs"]),
  }),
  Object.freeze({
    key: "go",
    patterns: Object.freeze(["**/*.go"]),
  }),
  Object.freeze({
    key: "rust",
    patterns: Object.freeze(["**/*.rs"]),
  }),
  Object.freeze({
    key: "cpp",
    patterns: Object.freeze([
      "**/*.c",
      "**/*.h",
      "**/*.cc",
      "**/*.cpp",
      "**/*.cxx",
      "**/*.hh",
      "**/*.hpp",
      "**/*.hxx",
    ]),
    options: Object.freeze({
      defines: Object.freeze({ default: Object.freeze([]), validate: validateDefines }),
    }),
  }),
]);
