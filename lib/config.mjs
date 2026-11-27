// The config: documented defaults, overridden by `.github/pr-conflict-radar.json`
// when it exists.
//
// A config file overrides top-level keys, the keys of `order` and `members`,
// and the keys of each language under `members`. A list replaces the default
// list whole. An unknown key at any of these levels is an error naming it. The
// language entries come from the registry, so a registry entry is a config key
// with its defaults and no change here.

import { readFileSync } from "node:fs";
import { registry as defaultRegistry } from "../members/registry.mjs";
import { PAIR_KEY_PLACEHOLDERS } from "./classify.mjs";

export const DEFAULT_CONFIG_PATH = ".github/pr-conflict-radar.json";
export const MAX_PRS_LIMIT = 200;
export const ENABLED_VALUES = Object.freeze(["auto", true, false]);

export class ConfigError extends Error {
  constructor(field, message) {
    super(`config: ${message}`);
    this.name = "ConfigError";
    this.field = field;
  }
}

const SHARED_DEFAULTS = Object.freeze({
  checkName: "PR conflict radar",
  classes: [
    { name: "docs", patterns: ["**/*.md"] },
    { name: "tests", patterns: ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"] },
    { name: "code", patterns: ["**"] },
  ],
  severity: ["docs", "tests", "code"],
  commentClasses: ["tests", "code"],
  order: { labelPriority: [] },
  pairKey: "conflict/{repo}/{low}+{high}",
  suggestPeerbus: true,
});

const MEMBER_DEFAULTS = Object.freeze({
  ignoreNames: [
    "Name",
    "Value",
    "Count",
    "Items",
    "Type",
    "Data",
    "Result",
    "Error",
    "Message",
    "Instance",
    "Create",
    "Init",
    "Start",
    "Stop",
    "Dispose",
    "ToString",
    "Equals",
    "GetHashCode",
    "props",
    "state",
    "children",
    "className",
    "onChange",
    "onClick",
    "value",
    "label",
    "title",
    "data",
    "error",
    "loading",
    "index",
    "render",
    "default",
  ],
  minNameLength: 4,
  maxFileBytes: 1000000,
});

const DEFAULT_MAX_PRS = 40;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const show = (value) => JSON.stringify(value);

function fail(field, message) {
  throw new ConfigError(field, message);
}

function unknownKey(field) {
  fail(field, `unknown key ${field}`);
}

// The defaults, with one `members` entry per registry entry.
export function defaultConfig({ registry = defaultRegistry } = {}) {
  const members = {};
  for (const entry of registry) {
    const language = { enabled: "auto", patterns: [...entry.patterns] };
    for (const [name, option] of Object.entries(entry.options ?? {})) {
      language[name] = structuredClone(option.default);
    }
    members[entry.key] = language;
  }
  Object.assign(members, structuredClone(MEMBER_DEFAULTS));
  const shared = structuredClone(SHARED_DEFAULTS);
  return {
    checkName: shared.checkName,
    classes: shared.classes,
    severity: shared.severity,
    commentClasses: shared.commentClasses,
    order: shared.order,
    pairKey: shared.pairKey,
    suggestPeerbus: shared.suggestPeerbus,
    members,
    maxPrs: DEFAULT_MAX_PRS,
  };
}

// The defaults overridden by `overrides` (the parsed config file), validated.
export function resolveConfig(overrides, { registry = defaultRegistry } = {}) {
  if (!isObject(overrides)) fail("config", "the config file must hold a JSON object");
  const config = defaultConfig({ registry });
  const languages = new Set(registry.map((entry) => entry.key));
  for (const [key, value] of Object.entries(structuredClone(overrides))) {
    if (!Object.hasOwn(config, key)) unknownKey(key);
    if (key !== "order" && key !== "members") {
      config[key] = value;
      continue;
    }
    if (!isObject(value)) fail(key, `${key} must be an object`);
    for (const [sub, subValue] of Object.entries(value)) {
      const field = `${key}.${sub}`;
      if (!Object.hasOwn(config[key], sub)) unknownKey(field);
      if (key === "members" && languages.has(sub)) {
        if (!isObject(subValue)) fail(field, `${field} must be an object`);
        for (const [option, optionValue] of Object.entries(subValue)) {
          if (!Object.hasOwn(config.members[sub], option)) unknownKey(`${field}.${option}`);
          config.members[sub][option] = optionValue;
        }
      } else {
        config[key][sub] = subValue;
      }
    }
  }
  validate(config, registry);
  return config;
}

// Reads the config file at `path`; the defaults when it does not exist.
export function loadConfig(path = DEFAULT_CONFIG_PATH, options = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return defaultConfig(options);
    throw error;
  }
  let overrides;
  try {
    overrides = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    fail("config", `${path} is not valid JSON: ${error.message}`);
  }
  return resolveConfig(overrides, options);
}

function checkString(value, field) {
  if (typeof value !== "string" || value === "") fail(field, `${field} must be a non-empty string`);
}

function checkStringList(value, field) {
  if (!Array.isArray(value)) fail(field, `${field} must be a list of non-empty strings`);
  for (const [i, item] of value.entries()) {
    if (typeof item !== "string" || item === "") {
      fail(`${field}[${i}]`, `${field}[${i}] must be a non-empty string`);
    }
  }
}

function checkInteger(value, field, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `from ${min} to ${max}`;
    fail(field, `${field} must be an integer ${range}`);
  }
}

function validateClasses(config) {
  if (!Array.isArray(config.classes) || config.classes.length === 0) {
    fail("classes", "classes must be a non-empty list of {name, patterns} objects");
  }
  const names = [];
  for (const [i, cls] of config.classes.entries()) {
    const field = `classes[${i}]`;
    if (!isObject(cls)) fail(field, `${field} must be a {name, patterns} object`);
    for (const key of Object.keys(cls)) {
      if (key !== "name" && key !== "patterns") unknownKey(`${field}.${key}`);
    }
    checkString(cls.name, `${field}.name`);
    checkStringList(cls.patterns, `${field}.patterns`);
    if (names.includes(cls.name))
      fail(`${field}.name`, `${field}.name repeats the class ${show(cls.name)}`);
    names.push(cls.name);
  }

  checkStringList(config.severity, "severity");
  const ranked = new Set();
  for (const [i, name] of config.severity.entries()) {
    if (!names.includes(name))
      fail("severity", `severity[${i}] names the unknown class ${show(name)}`);
    if (ranked.has(name)) fail("severity", `severity names the class ${show(name)} twice`);
    ranked.add(name);
  }
  for (const name of names) {
    if (!ranked.has(name)) fail("severity", `severity misses the class ${show(name)}`);
  }

  checkStringList(config.commentClasses, "commentClasses");
  for (const [i, name] of config.commentClasses.entries()) {
    if (!names.includes(name)) {
      fail("commentClasses", `commentClasses[${i}] names the unknown class ${show(name)}`);
    }
  }
}

function validatePairKey(template) {
  checkString(template, "pairKey");
  for (const [, name] of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!PAIR_KEY_PLACEHOLDERS.includes(name)) {
      const known = PAIR_KEY_PLACEHOLDERS.map((p) => `{${p}}`).join(", ");
      fail("pairKey", `pairKey has the unknown placeholder {${name}}, known are ${known}`);
    }
  }
}

function validateMembers(members, registry) {
  for (const entry of registry) {
    const field = `members.${entry.key}`;
    const language = members[entry.key];
    if (!ENABLED_VALUES.includes(language.enabled)) {
      fail(`${field}.enabled`, `${field}.enabled must be "auto", true or false`);
    }
    checkStringList(language.patterns, `${field}.patterns`);
    for (const [name, option] of Object.entries(entry.options ?? {})) {
      const message = option.validate(language[name], `${field}.${name}`);
      if (message !== null) fail(`${field}.${name}`, message);
    }
  }
  checkStringList(members.ignoreNames, "members.ignoreNames");
  checkInteger(members.minNameLength, "members.minNameLength", 0);
  checkInteger(members.maxFileBytes, "members.maxFileBytes", 1);
}

function validate(config, registry) {
  checkString(config.checkName, "checkName");
  validateClasses(config);
  checkStringList(config.order.labelPriority, "order.labelPriority");
  validatePairKey(config.pairKey);
  if (typeof config.suggestPeerbus !== "boolean") {
    fail("suggestPeerbus", "suggestPeerbus must be a boolean");
  }
  validateMembers(config.members, registry);
  checkInteger(config.maxPrs, "maxPrs", 1, MAX_PRS_LIMIT);
}
