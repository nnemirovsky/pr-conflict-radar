// A fake member mapper for tests. It speaks the mapper contract over a tiny
// language: a line `def <name> [<kind>]` starts a member that runs up to the
// line before the next `def` (the kind defaults to `function`), and a line
// `ERROR` makes the file an entry error. Identifiers are the words on the given
// lines, `def` excepted.
//
// `fakeRun(key, options)` returns a registry `run` that starts this script.
// Options: `log`, a file that gets one JSON line per run (the key, the request
// entries without their temp file, `maxFileBytes` and the defines list);
// `mode`, one of `hang` (writes its own and a child's pid to `pids`, then never
// ends), `exit` (writes some output and exits 3) and `garbage` (writes no
// JSON).

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);

export function fakeRun(key, { log, mode, pids } = {}) {
  return ({ work, env, request, maxFileBytes, defines }) => {
    const extra = { FAKE_MAPPER_KEY: key };
    if (log) extra.FAKE_MAPPER_LOG = log;
    if (mode) extra.FAKE_MAPPER_MODE = mode;
    if (pids) extra.FAKE_MAPPER_PIDS = pids;
    const args = [SCRIPT, request, String(maxFileBytes)];
    if (defines !== undefined) args.push(defines);
    return { command: process.execPath, args, cwd: work, env: { ...env, ...extra } };
  };
}

// The runs a log file recorded, as parsed lines.
export function runsIn(log) {
  let text;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mapEntry(entry) {
  const lines = readFileSync(entry.file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const broken = lines.indexOf("ERROR");
  if (broken >= 0) return { id: entry.id, error: `syntax error at line ${broken + 1}` };
  const touched = (line) => entry.ranges.some((range) => line >= range.start && line <= range.end);
  const starts = [];
  for (const [i, line] of lines.entries()) {
    const match = /^def (\S+)(?: (\S+))?$/.exec(line);
    if (match) starts.push({ line: i + 1, name: match[1], kind: match[2] ?? "function" });
  }
  const members = [];
  for (const [i, start] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1].line - 1 : lines.length;
    let hit = false;
    for (let line = start.line; line <= end; line += 1) if (touched(line)) hit = true;
    if (hit) {
      members.push({ name: start.name, kind: start.kind, declarationTouched: touched(start.line) });
    }
  }
  const identifiers = new Set();
  for (const [i, line] of lines.entries()) {
    if (!touched(i + 1)) continue;
    for (const word of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (word !== "def") identifiers.add(word);
    }
  }
  return { id: entry.id, members, identifiers: [...identifiers].sort() };
}

function main([requestPath, maxFileBytes, definesPath]) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const env = process.env;
  if (env.FAKE_MAPPER_LOG) {
    const defines = definesPath ? JSON.parse(readFileSync(definesPath, "utf8")) : null;
    const entries = request.map(({ path, ranges }) => ({ path, ranges }));
    const line = { key: env.FAKE_MAPPER_KEY, entries, maxFileBytes, defines };
    appendFileSync(env.FAKE_MAPPER_LOG, `${JSON.stringify(line)}\n`);
  }
  const mode = env.FAKE_MAPPER_MODE;
  if (mode === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    writeFileSync(env.FAKE_MAPPER_PIDS, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "exit") {
    process.stdout.write("partial\n");
    process.stderr.write("##[error]boom\n::error::boom\n");
    process.exitCode = 3;
    return;
  }
  if (mode === "garbage") {
    process.stdout.write("not json\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(request.map(mapEntry))}\n`);
}

if (process.argv[1] === SCRIPT) main(process.argv.slice(2));
