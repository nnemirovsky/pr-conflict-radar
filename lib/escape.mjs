// Escaping for everything the tool publishes or logs.
//
// `escapeText` is the only way text the tool did not choose itself (file
// paths, member and identifier names, label names, author logins, config class
// names and pair keys) enters a check, a comment or the job summary, with one
// exception: `loginLink` writes an author login in GitHub's username format,
// or `name[bot]` with `name` in it, as a profile link, and any other login
// through `escapeText`.
// `markerJson` serializes the result embedded in an HTML comment, `logLine`
// serializes every log line that can carry such text, and `annotation` builds
// the tool's own workflow-command annotations from a fixed set of messages.

// Control characters, format characters (bidirectional overrides, zero-width
// characters) and line and paragraph separators.
const REMOVED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// ASCII characters written as decimal character references: everything other
// than a letter, a digit, a space, `/` and `-`.
const REFERENCED = /[^A-Za-z0-9 /\-\u0080-\u{10FFFF}]/gu;

// An e-mail address is linked even when its `@` is a character reference; the
// empty HTML comment beside it stops that and is dropped from the rendered HTML.
const AT = "&#64;<!---->";

// Escapes `value` for Markdown and HTML and wraps it in `<code>`, where GitHub
// forms no mention and no issue or commit reference. The rendered text equals
// the input without the removed characters.
export function escapeText(value) {
  const escaped = String(value)
    .replace(REMOVED, "")
    .replace(REFERENCED, (char) => (char === "@" ? AT : `&#${char.codePointAt(0)};`));
  return `<code>${escaped}</code>`;
}

// GitHub's username format: 1 to 39 ASCII letters, digits and single hyphens,
// neither first nor last.
const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const BOT_SUFFIX = "[bot]";

// An author login as Markdown. A login in the username format becomes a link to
// `https://github.com/<login>`, and `<name>[bot]` with `name` in that format a
// link to `https://github.com/apps/<name>` whose text escapes the brackets; a
// link forms no mention, so it notifies nobody. The link text and target are
// built from the validated name only. Any other login goes through
// `escapeText`.
export function loginLink(login) {
  const value = String(login);
  if (USERNAME.test(value)) return `[${value}](https://github.com/${value})`;
  if (value.endsWith(BOT_SUFFIX)) {
    const name = value.slice(0, -BOT_SUFFIX.length);
    if (USERNAME.test(name)) return `[${name}\\[bot\\]](https://github.com/apps/${name})`;
  }
  return escapeText(value);
}

// JSON for the HTML comment that embeds a result: `<`, `>`, `&` and every `-`
// that follows a `-` are written as `\u` escapes, so no value can close the
// comment. Outside strings JSON holds none of these characters, so every
// replacement falls inside a string and the output parses back to the value.
export function markerJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/(?<=-)-/g, "\\u002d");
}

// One JSON value on one line for the job log. `#` is written as a `\u` escape, so
// the line holds no `##[name]` command, and the line begins with a JSON token,
// so it cannot begin with `::name::`. NEL, LINE SEPARATOR and PARAGRAPH
// SEPARATOR, which JSON leaves raw, are escaped as well. `undefined` and other
// values JSON cannot represent are written as `null`.
export function logLine(value) {
  const json = JSON.stringify(value) ?? "null";
  return json.replace(
    /[#\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// The messages of the tool's own annotations. A placeholder is a number in
// braces, filled with the argument at that index; no message holds `::`, `#`,
// `%` or a line break.
export const ANNOTATION_MESSAGES = Object.freeze({
  toolFailed: "pr-conflict-radar failed. The detail is on the next line.",
  configInvalid: "The pr-conflict-radar config is invalid. The detail is on the next line.",
  tokenMissing: "No token: set GH_TOKEN or GITHUB_TOKEN.",
  repositoryUnknown:
    "The repository is unknown: set GITHUB_REPOSITORY or add an origin remote. The detail is on the next line.",
  gitFailed: "A git command failed. The detail is on the next line.",
  commitsMissing:
    "The remote does not serve {0} of the listed commits. The detail is on the next line.",
  apiFailed: "A GitHub API request failed with status {0}. The detail is on the next line.",
  mapperFailed: "{0} member mapper runs failed. The detail is on the next line.",
  buildFailed: "A member mapper build failed. The detail is on the next line.",
  nodeUnsupported: "pr-conflict-radar needs Node.js 20 or newer.",
});

const ANNOTATION_LEVELS = new Set(["error", "warning", "notice"]);

// A workflow-command annotation line (`::error::<message>`) whose message comes
// from `ANNOTATION_MESSAGES` with each placeholder filled by a finite number.
// Any detail goes on the next line through `logLine`.
export function annotation(level, message, numbers = []) {
  if (!ANNOTATION_LEVELS.has(level)) throw new TypeError("unknown annotation level");
  if (!Object.hasOwn(ANNOTATION_MESSAGES, message)) {
    throw new TypeError("unknown annotation message");
  }
  if (
    !Array.isArray(numbers) ||
    !numbers.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new TypeError("annotation arguments must be finite numbers");
  }
  const template = ANNOTATION_MESSAGES[message];
  const placeholders = template.match(/\{\d+\}/g) ?? [];
  if (placeholders.length !== numbers.length) {
    throw new TypeError("annotation argument count does not match the message");
  }
  const text = template.replace(/\{(\d+)\}/g, (_, index) => String(numbers[Number(index)]));
  return `::${level}::${text}`;
}
