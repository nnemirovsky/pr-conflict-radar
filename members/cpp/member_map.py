"""Member mapper for C and C++, on libclang.

Usage: python -I member_map.py <request.json> <maxFileBytes> [<defines.json>]

The request is `[{id, path, file, ranges}]`: `file` is a temp file holding the
source, `path` only selects the language (`.c` is C, everything else C++), and
`ranges` is `[{start, end}]` of 1-based inclusive lines. The optional defines
file holds the validated `members.cpp.defines` list; each entry becomes one
`-D` argument that defines the macro as nothing. The response is one JSON array
on standard output, with per entry either `{id, members, identifiers}` or
`{id, error}`. The process exits 0 whenever it wrote a response.

libclang ends the whole process on a stack overflow, so each entry is parsed
in a child process of its own: this script run again through the same
interpreter with `-I` and `--entry`, the entry on its standard input. A child
that dies or outlives `CHILD_LIMIT` seconds is killed and becomes an error on
its entry. A child is started only while it can end within `BATCH_LIMIT`
seconds of the mapper's start, so slow entries cannot carry the whole request
past the scan's limit on one mapper run; an entry left unstarted is an error on
that entry. The environment variables `PR_CONFLICT_RADAR_CHILD_LIMIT` and
`PR_CONFLICT_RADAR_BATCH_LIMIT` (seconds) can lower either limit, never raise
it.

The parse reads no included file (single-file mode), keeps going after errors
and skips function bodies. Without its headers a file is full of errors, so
the mapper returns what clang recovered; only a crash or a timeout is an entry
error. A file whose first parse reports undeclared names is parsed a second
time with one synthesized line prepended that declares those names as empty
structs, so out-of-line definitions of classes from unread headers come back.
"""

import json
import math
import os
import re
import subprocess
import sys
import time
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor

CHILD_LIMIT = 20
# Below the scan's 120-second limit on one mapper run, with room for the
# mapper's own start and its response.
BATCH_LIMIT = 90
CHILD_LIMIT_ENV = "PR_CONFLICT_RADAR_CHILD_LIMIT"
BATCH_LIMIT_ENV = "PR_CONFLICT_RADAR_BATCH_LIMIT"
OUT_OF_TIME = "the mapper ran out of time before it parsed the file"
MAX_DEFINES = 200
DEFINE_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\(\.\.\.\))?")
NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
MACRO_NAME = re.compile(r"[A-Z0-9_]+")
UNDECLARED = re.compile(
    r"(use of undeclared identifier|unknown type name|no template named) "
    r"'([A-Za-z_][A-Za-z0-9_]*)'"
)
USAGE = "usage: member_map.py <request.json> <maxFileBytes> [<defines.json>]"
# With this variable set to 1, each entry also carries `trace`: the number of
# parses and the synthesized prelude.
TRACE = "PR_CONFLICT_RADAR_TRACE"

# CXTranslationUnit_SingleFileParse | CXTranslationUnit_KeepGoing |
# CXTranslationUnit_SkipFunctionBodies
PARSE_OPTIONS = 0x400 | 0x200 | 0x40
COMMON_ARGS = [
    "-fsyntax-only",
    "-nostdinc",
    "-nostdinc++",
    "-fconstexpr-steps=1000",
    "-ftemplate-depth=64",
    "-ferror-limit=0",
]

# Tokens after which a qualifier chain is an expression, not a declaration.
EXPRESSION_BEFORE = frozenset(
    [
        "::", ".", "->", ".*", "->*", "=", "(", ",", "[", "return", "case", "?", "!",
        "~", "+", "-", "/", "%", "|", "^", "==", "!=", "+=", "-=", "*=", "/=",
    ]
)
# Tokens after which a qualifier chain names a type in full.
TYPE_AFTER = frozenset(["*", "&", "&&", "...", "const", "volatile"])


class EntryError(Exception):
    pass


# ---------------------------------------------------------------------------
# The parent: one child process per entry.


def valid_defines(defines):
    return (
        isinstance(defines, list)
        and len(defines) <= MAX_DEFINES
        and all(isinstance(d, str) and DEFINE_PATTERN.fullmatch(d) for d in defines)
    )


def lowered(name, default):
    """The limit in seconds the variable `name` sets when it is below
    `default`, otherwise `default`."""
    try:
        value = float(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if math.isfinite(value) and 0 < value < default else default


def entry_id_of(entry):
    return entry.get("id") if isinstance(entry, dict) else None


def run_child(entry, max_file_bytes, defines, limit):
    entry_id = entry_id_of(entry)
    payload = json.dumps({"entry": entry, "maxFileBytes": max_file_bytes, "defines": defines})
    try:
        done = subprocess.run(
            [sys.executable, "-I", os.path.abspath(__file__), "--entry"],
            input=payload.encode("utf-8"),
            capture_output=True,
            timeout=limit,
        )
    except subprocess.TimeoutExpired:
        return {"id": entry_id, "error": f"the parser took longer than {limit:g} seconds"}
    except OSError:
        return {"id": entry_id, "error": "the parser failed on the file"}
    if done.returncode != 0:
        return {"id": entry_id, "error": "the parser failed on the file"}
    try:
        result = json.loads(done.stdout)
    except ValueError:
        result = None
    if not isinstance(result, dict):
        return {"id": entry_id, "error": "the parser failed on the file"}
    return {"id": entry_id, **result}


def main(argv):
    if len(argv) not in (2, 3):
        sys.stderr.write(USAGE + "\n")
        return 2
    try:
        max_file_bytes = float(argv[1])
    except ValueError:
        max_file_bytes = math.nan
    if not math.isfinite(max_file_bytes):
        sys.stderr.write(USAGE + "\n")
        return 2
    try:
        with open(argv[0], encoding="utf-8") as handle:
            request = json.load(handle)
    except (OSError, ValueError):
        sys.stderr.write("the request file could not be read\n")
        return 2
    if not isinstance(request, list):
        sys.stderr.write("the request must be a list\n")
        return 2
    defines = []
    if len(argv) == 3:
        try:
            with open(argv[2], encoding="utf-8") as handle:
                defines = json.load(handle)
        except (OSError, ValueError):
            defines = None
        if not valid_defines(defines):
            sys.stderr.write("the defines file must be a list of NAME or NAME(...) entries\n")
            return 2
    child_limit = lowered(CHILD_LIMIT_ENV, CHILD_LIMIT)
    batch_limit = lowered(BATCH_LIMIT_ENV, BATCH_LIMIT)
    started = time.monotonic()

    def one(entry):
        if time.monotonic() - started + child_limit > batch_limit:
            return {"id": entry_id_of(entry), "error": OUT_OF_TIME}
        return run_child(entry, max_file_bytes, defines, child_limit)

    workers = max(1, min(4, os.cpu_count() or 1))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        response = list(pool.map(one, request))
    sys.stdout.write(json.dumps(response) + "\n")
    return 0


# ---------------------------------------------------------------------------
# The child: one entry.


class Token:
    __slots__ = ("text", "ident", "line", "offset")

    def __init__(self, text, ident, line, offset):
        self.text = text
        self.ident = ident
        self.line = line
        self.offset = offset


def valid_ranges(ranges):
    return isinstance(ranges, list) and all(
        isinstance(r, dict)
        and type(r.get("start")) is int
        and type(r.get("end")) is int
        and 1 <= r["start"] <= r["end"]
        for r in ranges
    )


def define_args(defines):
    args = []
    for entry in defines:
        if not DEFINE_PATTERN.fullmatch(entry):
            raise EntryError("the defines list is malformed")
        args.append(f"-D{entry}=")
    return args


def file_tokens(cindex, tu, name, size):
    """The tokens of the file, with `>>` split in two so template argument
    lists close one level per token."""
    extent = cindex.SourceRange.from_locations(
        tu.get_location(name, 0), tu.get_location(name, size)
    )
    tokens = []
    identifier = cindex.TokenKind.IDENTIFIER
    for token in tu.get_tokens(extent=extent):
        location = token.location
        text = token.spelling
        if text == ">>":
            tokens.append(Token(">", False, location.line, location.offset))
            tokens.append(Token(">", False, location.line, location.offset + 1))
            continue
        tokens.append(Token(text, token.kind == identifier, location.line, location.offset))
    return tokens


def bracket_matches(tokens):
    """For each bracket token, the index of its partner, or None."""
    pairs = {"{": "}", "(": ")", "[": "]"}
    closers = {v: k for k, v in pairs.items()}
    match = [None] * len(tokens)
    stacks = {k: [] for k in pairs}
    for i, token in enumerate(tokens):
        if token.text in pairs:
            stacks[token.text].append(i)
        elif token.text in closers:
            stack = stacks[closers[token.text]]
            if stack:
                j = stack.pop()
                match[i] = j
                match[j] = i
    return match


def in_file(cursor, name):
    location = cursor.location
    return location.file is not None and location.file.name == name


def children_in_file(cursor, name):
    return [child for child in cursor.get_children() if in_file(child, name)]


def is_anonymous(cursor):
    spelling = cursor.spelling
    return spelling == "" or spelling.startswith("(")


def declared_names(tu, name):
    """Every name a cursor of the file declares."""
    names = set()
    stack = [tu.cursor]
    while stack:
        cursor = stack.pop()
        for child in children_in_file(cursor, name):
            if child.kind.is_declaration() and not is_anonymous(child):
                names.add(child.spelling)
            stack.append(child)
    return names


def undeclared_names(tu, name):
    names = set()
    unknown_types = set()
    for diagnostic in tu.diagnostics:
        location = diagnostic.location
        if location.file is None or location.file.name != name:
            continue
        match = UNDECLARED.search(diagnostic.spelling)
        if match:
            names.add(match.group(2))
            if match.group(1) == "unknown type name":
                unknown_types.add(match.group(2))
    return names, unknown_types


# ---------------------------------------------------------------------------
# The synthesized prelude.


class Node:
    __slots__ = ("kids", "template", "arity")

    def __init__(self):
        self.kids = {}
        self.template = False
        self.arity = None


class Prelude:
    def __init__(self, tokens, match, undeclared, unknown_types):
        self.tokens = tokens
        self.match = match
        self.undeclared = undeclared
        self.unknown_types = unknown_types
        self.roots = {}
        # Paths of out-of-line function names, never synthesized as structs.
        self.functions = set()

    def text(self, i):
        return self.tokens[i].text if 0 <= i < len(self.tokens) else ""

    def is_name(self, i):
        return (
            0 <= i < len(self.tokens)
            and self.tokens[i].ident
            and NAME_PATTERN.fullmatch(self.tokens[i].text) is not None
        )

    def read_chain(self, i):
        """Reads `A<...>::B::C` from token `i`: `[(name, arity, nested)]`
        and the index after it. `arity` is None without template arguments;
        `nested` holds the chains read from the template arguments."""
        comps = []
        while self.is_name(i):
            name = self.tokens[i].text
            i += 1
            arity = None
            nested = []
            if self.text(i) == "<":
                arity, nested, after = self.read_arguments(i)
                if arity is None:
                    break
                i = after
            comps.append((name, arity, nested))
            if self.text(i) == "::" and self.is_name(i + 1):
                i += 1
                continue
            break
        return comps, i

    def read_arguments(self, i):
        count = 0
        content = False
        start = True
        nested = []
        depth = 0
        k = i + 1
        n = len(self.tokens)
        while k < n:
            text = self.tokens[k].text
            if text == ">":
                if depth == 0:
                    return count + (1 if content else 0), nested, k + 1
                depth -= 1
            elif text == "<":
                depth += 1
            elif text in ("(", "["):
                if self.match[k] is None:
                    return None, [], k
                k = self.match[k]
            elif text in (";", "{", "}", ")", "]"):
                return None, [], k
            elif text == "," and depth == 0:
                count += 1
                start = True
                k += 1
                continue
            elif start and depth == 0 and self.is_name(k):
                chain, after = self.read_chain(k)
                if chain:
                    nested.append(chain)
                    content = True
                    start = False
                    k = max(after, k + 1)
                    continue
            elif text in ("const", "volatile", "typename", "struct", "class", "enum"):
                content = True
                k += 1
                continue
            content = True
            start = False
            k += 1
        return None, [], k

    def register(self, scope, comps, exact):
        node = self.roots.setdefault(scope, Node())
        parent = None
        for name, arity, _ in comps:
            if name == parent:
                break
            node = node.kids.setdefault(name, Node())
            if arity is not None:
                node.template = True
                if exact and node.arity is None:
                    node.arity = arity
            parent = name
        for _, _, nested in comps:
            for chain in nested:
                if chain[0][0] in self.undeclared:
                    self.register(scope, chain, False)

    def use(self, scope, comps, after):
        """Registers what chain `comps`, followed by token `after`, needs."""
        follow = self.text(after)
        if follow == "(":
            if len(comps) >= 2:
                self.register(scope, comps[:-1], True)
                self.functions.add((scope, tuple(name for name, _, _ in comps)))
            return
        if follow == "::":
            # `A::~A`, `A::operator=` and `A::*` keep the whole chain.
            self.register(scope, comps, self.text(after + 1) in ("~", "operator"))
            return
        typed = self.is_name(after) or follow in TYPE_AFTER
        if len(comps) == 1 and comps[0][1] is None:
            if comps[0][0] in self.unknown_types and typed:
                self.register(scope, comps, False)
            return
        if typed:
            self.register(scope, comps, False)
        elif len(comps) >= 2:
            self.register(scope, comps[:-1], False)

    def scan(self):
        tokens = self.tokens
        n = len(tokens)
        stack = []
        i = 0
        while i < n:
            text = tokens[i].text
            if text == "namespace" and not tokens[i].ident:
                names = []
                inline = self.text(i - 1) == "inline"
                j = i + 1
                while j < n and (self.is_name(j) or tokens[j].text in ("::", "inline")):
                    if tokens[j].text == "inline":
                        inline = True
                    elif tokens[j].text != "::":
                        names.append((tokens[j].text, inline))
                        inline = False
                    j += 1
                if self.text(j) == "{":
                    stack.append(tuple(names) if names else (("", inline),))
                    i = j + 1
                    continue
                i = max(j, i + 1)
                continue
            if text == "{":
                stack.append(())
            elif text == "}":
                if stack:
                    stack.pop()
            elif (
                tokens[i].ident
                and text in self.undeclared
                and self.text(i - 1) not in EXPRESSION_BEFORE
            ):
                comps, after = self.read_chain(i)
                if comps:
                    scope = tuple(part for entry in stack for part in entry)
                    self.use(scope, comps, after)
                    i = max(after, i + 1)
                    continue
            i += 1

    def emit_node(self, path, name, node):
        inner = " ".join(
            self.emit_node(path + (k,), k, v)
            for k, v in node.kids.items()
            if (path[0], path[1:] + (k,)) not in self.functions
        )
        head = ""
        if node.template:
            params = "class..." if not node.arity else ", ".join(["class"] * node.arity)
            head = f"template<{params}> "
        body = f" {inner} " if inner else ""
        return f"{head}struct {name} {{{body}}};"

    def render(self):
        self.scan()
        parts = []
        for scope, root in self.roots.items():
            if not root.kids:
                continue
            body = " ".join(
                self.emit_node((scope, k), k, v)
                for k, v in root.kids.items()
                if (scope, (k,)) not in self.functions
            )
            opening = "".join(
                f"{'inline ' if inline else ''}namespace {name + ' ' if name else ''}{{ "
                for name, inline in scope
            )
            parts.append(opening + body + " }" * len(scope))
        return " ".join(parts)


# ---------------------------------------------------------------------------
# Members.


class Collector:
    def __init__(self, cindex, tokens, name, ranges, shift):
        self.cindex = cindex
        self.kinds = cindex.CursorKind
        self.tokens = tokens
        self.offsets = [token.offset for token in tokens]
        self.match = bracket_matches(tokens)
        self.name = name
        self.ranges = ranges
        self.shift = shift
        self.found = {}
        k = self.kinds
        self.containers = {
            k.NAMESPACE: "namespace",
            k.CLASS_DECL: "class",
            k.STRUCT_DECL: "struct",
            k.UNION_DECL: "union",
            k.ENUM_DECL: "enum",
            k.CLASS_TEMPLATE: None,
            k.CLASS_TEMPLATE_PARTIAL_SPECIALIZATION: None,
        }
        self.transparent = {k.LINKAGE_SPEC, k.UNEXPOSED_DECL}
        self.functions = {
            k.FUNCTION_DECL: "function",
            k.CXX_METHOD: "method",
            k.CONSTRUCTOR: "constructor",
            k.DESTRUCTOR: "destructor",
            k.CONVERSION_FUNCTION: "conversion",
        }
        self.types = {k.TYPEDEF_DECL, k.TYPE_ALIAS_DECL, k.TYPE_ALIAS_TEMPLATE_DECL}
        self.records = {
            k.CLASS_DECL,
            k.STRUCT_DECL,
            k.UNION_DECL,
            k.CLASS_TEMPLATE,
            k.CLASS_TEMPLATE_PARTIAL_SPECIALIZATION,
        }

    def meets(self, start, end):
        return any(r["start"] <= end and r["end"] >= start for r in self.ranges)

    def template_kind(self, cursor):
        kind_id = self.cindex.conf.lib.clang_getTemplateCursorKind(cursor)
        return self.kinds.from_id(kind_id)

    def qualified(self, cursor):
        parts = [cursor.spelling]
        parent = cursor.semantic_parent
        depth = 0
        while parent is not None and parent.kind != self.kinds.TRANSLATION_UNIT and depth < 1000:
            if parent.kind in self.containers and not is_anonymous(parent):
                parts.append(parent.spelling)
            parent = parent.semantic_parent
            depth += 1
        return "::".join(reversed(parts))

    def body_open(self, i):
        """The index of the `{` that opens a function body starting at token
        `i`, the first token after the declarator, or None."""
        tokens = self.tokens
        n = len(tokens)
        if i >= n:
            return None
        text = tokens[i].text
        if text == "{":
            return i
        if text == "try":
            return i + 1 if i + 1 < n and tokens[i + 1].text == "{" else None
        if text != ":":
            return None
        k = i + 1
        while k < n:
            text = tokens[k].text
            if text in ("(", "["):
                if self.match[k] is None:
                    return None
                k = self.match[k]
            elif text == "{":
                before = tokens[k - 1]
                if not (before.ident or before.text == ">"):
                    return k
                if self.match[k] is None:
                    return None
                k = self.match[k]
            elif text in (";", "}"):
                return None
            k += 1
        return None

    def lines(self, cursor, function):
        """`(start, headerEnd, end)` of a cursor in file lines."""
        extent = cursor.extent
        start = extent.start.line
        header = end = extent.end.line
        after = bisect_left(self.offsets, extent.end.offset)
        last = after - 1
        if (
            last >= 0
            and self.tokens[last].text == "}"
            and self.match[last] is not None
            and self.tokens[self.match[last]].offset >= extent.start.offset
        ):
            header = self.tokens[self.match[last]].line
            end = self.tokens[last].line
        elif function:
            opening = self.body_open(after)
            if opening is not None and self.match[opening] is not None:
                header = self.tokens[opening].line
                end = self.tokens[self.match[opening]].line
        return start - self.shift, header - self.shift, end - self.shift

    def is_macro_shaped(self, cursor):
        name = cursor.spelling
        if not MACRO_NAME.fullmatch(name) or not ("_" in name or len(name) >= 3):
            return False
        return cursor.extent.start.offset == cursor.location.offset

    def embedded_braces(self, cursor):
        """The lines of the first brace pair inside a cursor's extent (the
        record a `typedef struct {...} name;` defines), or None."""
        extent = cursor.extent
        i = bisect_left(self.offsets, extent.start.offset)
        n = len(self.tokens)
        while i < n and self.tokens[i].offset < extent.end.offset:
            if self.tokens[i].text == "{":
                close = self.match[i]
                if close is None or self.tokens[close].offset >= extent.end.offset:
                    return None
                return self.tokens[i].line - self.shift, self.tokens[close].line - self.shift
            i += 1
        return None

    def add(self, cursor, kind, container=False, function=False, alias=False):
        if cursor.location.line <= self.shift:
            return
        start, header, end = self.lines(cursor, function)
        touched = self.meets(start, header)
        braces = self.embedded_braces(cursor) if alias else None
        if braces is not None:
            # The record inside is reported on its own; the alias is touched
            # only on its own lines around it.
            touched = self.meets(start, braces[0]) or self.meets(braces[1], end)
            if not touched:
                return
        if container and not touched:
            return
        if not container and not self.meets(start, end):
            return
        name = self.qualified(cursor)
        key = (kind, name)
        known = self.found.get(key)
        if known is not None:
            known["declarationTouched"] = known["declarationTouched"] or touched
        else:
            self.found[key] = {"name": name, "kind": kind, "declarationTouched": touched}

    def visit(self, root):
        k = self.kinds
        stack = [root]
        while stack:
            cursor = stack.pop()
            for child in children_in_file(cursor, self.name):
                kind = child.kind
                if kind in self.containers:
                    label = self.containers[kind]
                    if label is None:
                        label = self.containers.get(self.template_kind(child), "class")
                    if not is_anonymous(child):
                        self.add(child, label, container=True)
                    stack.append(child)
                elif kind in self.transparent:
                    stack.append(child)
                elif kind in self.functions or kind == k.FUNCTION_TEMPLATE:
                    real = self.template_kind(child) if kind == k.FUNCTION_TEMPLATE else kind
                    label = self.functions.get(real, "function")
                    if kind != k.FUNCTION_TEMPLATE and real in (k.FUNCTION_DECL, k.CXX_METHOD):
                        if self.is_macro_shaped(child):
                            label = "macro"
                    self.add(child, label, function=True)
                elif kind == k.FIELD_DECL:
                    self.add(child, "field")
                elif kind == k.VAR_DECL:
                    parent = child.semantic_parent
                    in_record = parent is not None and parent.kind in self.records
                    self.add(child, "field" if in_record else "var")
                elif kind == k.ENUM_CONSTANT_DECL:
                    self.add(child, "enumMember")
                elif kind in self.types:
                    self.add(child, "type", alias=True)
        return list(self.found.values())


INCLUDE_DIRECTIVES = frozenset(["include", "include_next", "import"])


def code_identifiers(tokens):
    """The identifier tokens that belong to the code: not the name of a
    preprocessing directive (`include` in `#include`) and nothing on an
    include line, whose header name lexes as identifiers."""
    skipped_lines = set()
    out = []
    for i, token in enumerate(tokens):
        if not token.ident or token.line in skipped_lines or token.text == "defined":
            continue
        hash_before = i >= 1 and tokens[i - 1].text == "#" and tokens[i - 1].line == token.line
        if hash_before and (i < 2 or tokens[i - 2].line != token.line):
            if token.text in INCLUDE_DIRECTIVES:
                skipped_lines.add(token.line)
            continue
        out.append(token)
    return out


def parse(cindex, index, name, data, args):
    try:
        return index.parse(name, args=args, unsaved_files=[(name, data)], options=PARSE_OPTIONS)
    except cindex.TranslationUnitLoadError:
        raise EntryError("the parser failed on the file") from None


def map_entry(entry, max_file_bytes, defines):
    if (
        not isinstance(entry, dict)
        or not isinstance(entry.get("path"), str)
        or not isinstance(entry.get("file"), str)
        or not valid_ranges(entry.get("ranges"))
    ):
        raise EntryError("the request entry is malformed")
    path = entry["path"]
    name = os.path.abspath(entry["file"])
    try:
        size = os.stat(name).st_size
    except OSError:
        raise EntryError("the file could not be read") from None
    if size > max_file_bytes:
        raise EntryError("the file is larger than maxFileBytes")
    try:
        with open(name, "rb") as handle:
            data = handle.read()
    except OSError:
        raise EntryError("the file could not be read") from None
    # Only a line feed ends a line, as in git; clang also ends one at a lone
    # carriage return, which would move every line after it.
    data = re.sub(rb"\r(?!\n)", b" ", data)

    is_c = os.path.splitext(path)[1] == ".c"
    language = ["-x", "c", "-std=c17"] if is_c else ["-x", "c++", "-std=c++23"]
    args = language + COMMON_ARGS + define_args(defines)

    from clang import cindex

    index = cindex.Index.create()
    tu = parse(cindex, index, name, data, args)
    parses = 1
    prelude = ""
    shift = 0
    if not is_c:
        undeclared, unknown_types = undeclared_names(tu, name)
        undeclared -= declared_names(tu, name)
        unknown_types &= undeclared
        if undeclared:
            tokens = file_tokens(cindex, tu, name, len(data))
            try:
                prelude = Prelude(
                    tokens, bracket_matches(tokens), undeclared, unknown_types
                ).render()
            except RecursionError:
                # Template arguments nested too deeply to read: keep the
                # first parse.
                prelude = ""
            if prelude:
                prefixed = prelude.encode("utf-8") + b"\n" + data
                tu = parse(cindex, index, name, prefixed, args)
                parses = 2
                shift = 1
    size = len(data) + (len(prelude.encode("utf-8")) + 1 if shift else 0)
    tokens = file_tokens(cindex, tu, name, size)
    ranges = entry["ranges"]
    members = Collector(cindex, tokens, name, ranges, shift).visit(tu.cursor)
    identifiers = set()
    for token in code_identifiers(tokens):
        line = token.line - shift
        if line >= 1 and any(r["start"] <= line <= r["end"] for r in ranges):
            identifiers.add(token.text)
    result = {"members": members, "identifiers": sorted(identifiers)}
    if os.environ.get(TRACE) == "1":
        result["trace"] = {"parses": parses, "prelude": prelude}
    return result


def child():
    try:
        payload = json.loads(sys.stdin.buffer.read())
        entry = payload["entry"]
        max_file_bytes = float(payload["maxFileBytes"])
        defines = payload["defines"]
    except (ValueError, KeyError, TypeError):
        sys.stdout.write(json.dumps({"error": "the request entry is malformed"}))
        return 0
    try:
        if not valid_defines(defines):
            raise EntryError("the defines list is malformed")
        result = map_entry(entry, max_file_bytes, defines)
    except EntryError as error:
        result = {"error": str(error)}
    except Exception:
        result = {"error": "the parser failed on the file"}
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if arguments == ["--entry"]:
        sys.exit(child())
    sys.exit(main(arguments))
