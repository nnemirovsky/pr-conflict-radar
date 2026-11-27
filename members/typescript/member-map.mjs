// Member mapper for TypeScript, TSX, JavaScript and JSX.
//
// Usage: node member-map.mjs <request.json> <maxFileBytes>
//
// The request is `[{id, path, file, ranges}]`: `file` is a temp file holding
// the source, `path` only selects the `ScriptKind` by its extension, and
// `ranges` is `[{start, end}]` of 1-based inclusive lines. The response is one
// JSON array on standard output, with per entry either
// `{id, members, identifiers}` or `{id, error}`. The source is parsed as text
// and never executed. The process exits 0 whenever it wrote a response.

import { readFileSync, statSync } from "node:fs";
import ts from "typescript";

const SCRIPT_KINDS = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

class EntryError extends Error {}

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

function validRanges(ranges) {
  return (
    Array.isArray(ranges) &&
    ranges.every(
      (range) =>
        range !== null &&
        typeof range === "object" &&
        Number.isSafeInteger(range.start) &&
        Number.isSafeInteger(range.end) &&
        range.start >= 1 &&
        range.end >= range.start,
    )
  );
}

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind) === true;
}

function nameText(sf, nameNode) {
  if (nameNode === undefined) return null;
  if (ts.isComputedPropertyName(nameNode)) return `[${nameNode.expression.getText(sf)}]`;
  return nameNode.text ?? nameNode.getText(sf);
}

// One parsed file: collects the members whose lines meet the ranges.
class Mapper {
  constructor(sf, ranges, component) {
    this.sf = sf;
    this.ranges = ranges;
    this.component = component;
    this.found = new Map();
  }

  line(pos) {
    return this.sf.getLineAndCharacterOfPosition(pos).line + 1;
  }

  meets(from, to) {
    return this.ranges.some((range) => range.start <= to && range.end >= from);
  }

  // `node` spans its first token to its end; `headerEnd` is where its
  // declaration part ends (the body's opening, or the end of the node).
  add(node, qualifier, name, kind, { headerEnd = node.end, container = false } = {}) {
    if (name === null) return;
    const start = this.line(node.getStart(this.sf));
    const end = this.line(node.end);
    const declarationTouched = this.meets(
      start,
      this.line(Math.max(headerEnd, node.getStart(this.sf))),
    );
    // A container is reported for its own declaration; the members inside it
    // are reported on their own, so touching one member does not touch the
    // others' container.
    if (container ? !declarationTouched : !this.meets(start, end)) return;
    const qualified = qualifier === "" ? name : `${qualifier}.${name}`;
    const key = `${kind}\0${qualified}`;
    const known = this.found.get(key);
    if (known) known.declarationTouched ||= declarationTouched;
    else this.found.set(key, { name: qualified, kind, declarationTouched });
  }

  statements(list, qualifier) {
    for (const statement of list) this.statement(statement, qualifier);
  }

  statement(node, qualifier) {
    const sf = this.sf;
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name
        ? node.name.text
        : hasModifier(node, ts.SyntaxKind.DefaultKeyword)
          ? "default"
          : null;
      const kind = this.isComponent(name) ? "component" : "function";
      this.add(node, qualifier, name, kind, {
        headerEnd: node.body ? node.body.getStart(sf) : node.end,
      });
    } else if (ts.isClassDeclaration(node)) {
      const name = node.name
        ? node.name.text
        : hasModifier(node, ts.SyntaxKind.DefaultKeyword)
          ? "default"
          : null;
      const members = node.members;
      const headerEnd = members.length > 0 ? members[0].getFullStart() : node.end;
      this.add(node, qualifier, name, "class", { headerEnd, container: true });
      if (name !== null) this.classMembers(node, qualifier === "" ? name : `${qualifier}.${name}`);
    } else if (ts.isVariableStatement(node)) {
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const init = declaration.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const kind = this.isComponent(name) ? "component" : "function";
          this.add(declaration, qualifier, name, kind, { headerEnd: init.body.getStart(sf) });
        } else if (exported) {
          this.add(declaration, qualifier, name, "const");
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      this.add(node, qualifier, node.name.text, "interface");
    } else if (ts.isTypeAliasDeclaration(node)) {
      this.add(node, qualifier, node.name.text, "type");
    } else if (ts.isEnumDeclaration(node)) {
      const members = node.members;
      const headerEnd = members.length > 0 ? members[0].getFullStart() : node.end;
      this.add(node, qualifier, node.name.text, "enum", { headerEnd, container: true });
      const inner = qualifier === "" ? node.name.text : `${qualifier}.${node.name.text}`;
      for (const member of members)
        this.add(member, inner, nameText(sf, member.name), "enumMember");
    } else if (ts.isModuleDeclaration(node)) {
      this.namespace(node, qualifier);
    }
  }

  namespace(node, qualifier) {
    const name = nameText(this.sf, node.name);
    const inner = qualifier === "" ? name : `${qualifier}.${name}`;
    const body = node.body;
    const headerEnd = body ? body.getStart(this.sf) : node.end;
    this.add(node, qualifier, name, "namespace", { headerEnd, container: true });
    if (!body) return;
    if (ts.isModuleBlock(body)) this.statements(body.statements, inner);
    else if (ts.isModuleDeclaration(body)) this.namespace(body, inner);
  }

  classMembers(node, qualifier) {
    const sf = this.sf;
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        this.add(member, qualifier, "constructor", "constructor", {
          headerEnd: member.body ? member.body.getStart(sf) : member.end,
        });
      } else if (ts.isMethodDeclaration(member)) {
        this.add(member, qualifier, nameText(sf, member.name), "method", {
          headerEnd: member.body ? member.body.getStart(sf) : member.end,
        });
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const kind = ts.isGetAccessorDeclaration(member) ? "getter" : "setter";
        this.add(member, qualifier, nameText(sf, member.name), kind, {
          headerEnd: member.body ? member.body.getStart(sf) : member.end,
        });
      } else if (ts.isPropertyDeclaration(member)) {
        const init = member.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        this.add(member, qualifier, nameText(sf, member.name), fn ? "method" : "property", {
          headerEnd: fn ? init.body.getStart(sf) : member.end,
        });
      }
    }
  }

  isComponent(name) {
    return this.component && name !== null && /^[A-Z]/.test(name);
  }
}

// The identifier names on the lines of `ranges`, found with an explicit stack
// so a deeply nested file cannot overflow the call stack here.
function identifiersOn(sf, ranges) {
  const names = new Set();
  const stack = [sf];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const meets = (from, to) => ranges.some((range) => range.start <= to && range.end >= from);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node !== sf && !meets(lineOf(node.getStart(sf)), lineOf(node.end))) continue;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (meets(lineOf(node.getStart(sf)), lineOf(node.getStart(sf)))) names.add(node.text);
      continue;
    }
    node.forEachChild((child) => {
      stack.push(child);
    });
  }
  return [...names].sort();
}

function mapEntry(entry, maxFileBytes) {
  if (
    entry === null ||
    typeof entry !== "object" ||
    typeof entry.path !== "string" ||
    typeof entry.file !== "string" ||
    !validRanges(entry.ranges)
  ) {
    throw new EntryError("the request entry is malformed");
  }
  const ext = extensionOf(entry.path);
  const scriptKind = SCRIPT_KINDS.get(ext) ?? ts.ScriptKind.TS;
  let size;
  try {
    size = statSync(entry.file).size;
  } catch {
    throw new EntryError("the file could not be read");
  }
  if (size > maxFileBytes) throw new EntryError("the file is larger than maxFileBytes");
  let text;
  try {
    text = readFileSync(entry.file, "utf8");
  } catch {
    throw new EntryError("the file could not be read");
  }
  let sf;
  try {
    sf = ts.createSourceFile(`file${ext || ".ts"}`, text, ts.ScriptTarget.Latest, true, scriptKind);
  } catch (error) {
    if (error instanceof RangeError) throw new EntryError("the file is nested too deeply to parse");
    throw new EntryError("the parser failed on the file");
  }
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const line = sf.getLineAndCharacterOfPosition(first.start ?? 0).line + 1;
    throw new EntryError(`syntax error at line ${line}`);
  }
  try {
    const mapper = new Mapper(
      sf,
      entry.ranges,
      scriptKind === ts.ScriptKind.TSX || scriptKind === ts.ScriptKind.JSX,
    );
    mapper.statements(sf.statements, "");
    return { members: [...mapper.found.values()], identifiers: identifiersOn(sf, entry.ranges) };
  } catch (error) {
    if (error instanceof RangeError) throw new EntryError("the file is nested too deeply to map");
    throw new EntryError("the parser failed on the file");
  }
}

function main(argv) {
  const [requestPath, limit] = argv;
  const maxFileBytes = Number(limit);
  if (requestPath === undefined || !Number.isFinite(maxFileBytes)) {
    process.stderr.write("usage: member-map.mjs <request.json> <maxFileBytes>\n");
    return 2;
  }
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf8"));
  } catch {
    process.stderr.write("the request file could not be read\n");
    return 2;
  }
  if (!Array.isArray(request)) {
    process.stderr.write("the request must be a list\n");
    return 2;
  }
  const response = request.map((entry) => {
    const id = entry?.id ?? null;
    try {
      return { id, ...mapEntry(entry, maxFileBytes) };
    } catch (error) {
      return {
        id,
        error: error instanceof EntryError ? error.message : "the parser failed on the file",
      };
    }
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
