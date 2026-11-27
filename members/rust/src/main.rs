// The Rust member mapper. It speaks the member-mapper contract: a request file
// `[{id, path, file, ranges}]` and `maxFileBytes` in, one JSON array of
// `{id, members, identifiers}` or `{id, error}` entries out, exit 0 whenever a
// response was written.
//
// `syn` ends the whole process on a stack overflow, which no code can catch, so
// each entry is parsed in a child process of its own: this binary run again
// with `--entry <maxFileBytes>` and the entry on its standard input. A child
// that dies or outlives `CHILD_LIMIT` becomes an error on its entry. A child is
// started only while it can end within `BATCH_LIMIT` of the mapper's start, so
// slow entries cannot carry the whole request past the scan's limit on one
// mapper run; an entry left unstarted is an error on that entry. The
// environment variables `PR_CONFLICT_RADAR_CHILD_LIMIT` and
// `PR_CONFLICT_RADAR_BATCH_LIMIT` (seconds) can lower either limit, never
// raise it.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use proc_macro2::{Delimiter, TokenStream, TokenTree};
use quote::ToTokens;
use serde_json::{Value, json};
use syn::spanned::Spanned;
use syn::{
    Fields, ForeignItem, ImplItem, Item, Path, Type, TraitItem,
};

const CHILD_LIMIT: Duration = Duration::from_secs(20);
// Below the scan's 120-second limit on one mapper run, with room for the
// mapper's own start and its response.
const BATCH_LIMIT: Duration = Duration::from_secs(90);
const CHILD_LIMIT_ENV: &str = "PR_CONFLICT_RADAR_CHILD_LIMIT";
const BATCH_LIMIT_ENV: &str = "PR_CONFLICT_RADAR_BATCH_LIMIT";
const OUT_OF_TIME: &str = "the mapper ran out of time before it parsed the file";
const USAGE: &str = "usage: member-map <request.json> <maxFileBytes>";

const KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "crate",
    "do", "dyn", "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl",
    "in", "let", "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub", "ref",
    "return", "Self", "self", "static", "struct", "super", "trait", "true", "try", "type",
    "typeof", "unsafe", "unsized", "use", "virtual", "where", "while", "yield",
];

struct Failure(String);

fn fail(message: &str) -> Failure {
    Failure(message.to_string())
}

struct Member {
    name: String,
    kind: &'static str,
    touched: bool,
    start: usize,
}

struct Mapper {
    ranges: Vec<(usize, usize)>,
    members: Vec<Member>,
}

fn lines(span: proc_macro2::Span) -> (usize, usize) {
    (span.start().line.max(1), span.end().line.max(1))
}

fn qualify(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}::{name}")
    }
}

fn plain_ident(ident: &proc_macro2::Ident) -> String {
    let text = ident.to_string();
    text.strip_prefix("r#").map(str::to_string).unwrap_or(text)
}

fn path_name(path: &Path) -> String {
    path.segments
        .iter()
        .map(|segment| plain_ident(&segment.ident))
        .collect::<Vec<_>>()
        .join("::")
}

// The name of an impl's self type: a path without its generic arguments, the
// same shape through references, slices, tuples and parentheses, and the
// spaced token text for anything else.
fn type_name(ty: &Type) -> String {
    match ty {
        Type::Path(path) if path.qself.is_none() => path_name(&path.path),
        Type::Reference(reference) => {
            let mutability = if reference.mutability.is_some() { "mut " } else { "" };
            format!("&{mutability}{}", type_name(&reference.elem))
        }
        Type::Slice(slice) => format!("[{}]", type_name(&slice.elem)),
        Type::Tuple(tuple) => format!(
            "({})",
            tuple.elems.iter().map(type_name).collect::<Vec<_>>().join(", ")
        ),
        Type::Paren(paren) => type_name(&paren.elem),
        Type::Group(group) => type_name(&group.elem),
        other => other.to_token_stream().to_string(),
    }
}

impl Mapper {
    fn hit(&self, start: usize, end: usize) -> bool {
        self.ranges.iter().any(|&(a, b)| a <= end && start <= b)
    }

    // A member with no container role: reported when any of its lines is
    // touched, with its declaration touched when a line up to `header_end` is.
    fn leaf(&mut self, name: String, kind: &'static str, span: proc_macro2::Span, header_end: usize) {
        let (start, end) = lines(span);
        if self.hit(start, end) {
            let touched = self.hit(start, header_end.max(start));
            self.push(name, kind, touched, start);
        }
    }

    // A container: reported only when its own header lines are touched.
    fn container(&mut self, name: &str, kind: &'static str, span: proc_macro2::Span, header_end: usize) {
        let (start, _) = lines(span);
        if self.hit(start, header_end.max(start)) {
            self.push(name.to_string(), kind, true, start);
        }
    }

    fn push(&mut self, name: String, kind: &'static str, touched: bool, start: usize) {
        if let Some(existing) = self.members.iter_mut().find(|member| member.name == name) {
            existing.touched |= touched;
            existing.start = existing.start.min(start);
            return;
        }
        self.members.push(Member { name, kind, touched, start });
    }

    fn items(&mut self, prefix: &str, items: &[Item]) {
        for item in items {
            self.item(prefix, item);
        }
    }

    fn fields(&mut self, prefix: &str, fields: &Fields) {
        if let Fields::Named(named) = fields {
            for field in &named.named {
                if let Some(ident) = &field.ident {
                    let (_, end) = lines(field.span());
                    self.leaf(qualify(prefix, &plain_ident(ident)), "field", field.span(), end);
                }
            }
        }
    }

    fn item(&mut self, prefix: &str, item: &Item) {
        match item {
            Item::Fn(function) => {
                let header_end = lines(function.block.brace_token.span.open()).0;
                self.leaf(
                    qualify(prefix, &plain_ident(&function.sig.ident)),
                    "function",
                    item.span(),
                    header_end,
                );
            }
            Item::Const(constant) => {
                if constant.ident != "_" {
                    let (_, end) = lines(item.span());
                    self.leaf(qualify(prefix, &plain_ident(&constant.ident)), "const", item.span(), end);
                }
            }
            Item::Static(item_static) => {
                let (_, end) = lines(item.span());
                self.leaf(qualify(prefix, &plain_ident(&item_static.ident)), "static", item.span(), end);
            }
            Item::Type(alias) => {
                let (_, end) = lines(item.span());
                self.leaf(qualify(prefix, &plain_ident(&alias.ident)), "type", item.span(), end);
            }
            Item::Macro(item_macro) => {
                if let Some(ident) = &item_macro.ident
                    && item_macro.mac.path.is_ident("macro_rules")
                {
                    let header_end = lines(ident.span()).1;
                    self.leaf(qualify(prefix, &plain_ident(ident)), "macroRules", item.span(), header_end);
                }
            }
            Item::Struct(item_struct) => {
                let name = qualify(prefix, &plain_ident(&item_struct.ident));
                let header_end = match &item_struct.fields {
                    Fields::Named(named) => lines(named.brace_token.span.open()).0,
                    _ => lines(item.span()).1,
                };
                self.container(&name, "struct", item.span(), header_end);
                self.fields(&name, &item_struct.fields);
            }
            Item::Union(item_union) => {
                let name = qualify(prefix, &plain_ident(&item_union.ident));
                let header_end = lines(item_union.fields.brace_token.span.open()).0;
                self.container(&name, "union", item.span(), header_end);
                for field in &item_union.fields.named {
                    if let Some(ident) = &field.ident {
                        let (_, end) = lines(field.span());
                        self.leaf(qualify(&name, &plain_ident(ident)), "field", field.span(), end);
                    }
                }
            }
            Item::Enum(item_enum) => {
                let name = qualify(prefix, &plain_ident(&item_enum.ident));
                let header_end = lines(item_enum.brace_token.span.open()).0;
                self.container(&name, "enum", item.span(), header_end);
                for variant in &item_enum.variants {
                    let (_, end) = lines(variant.span());
                    self.leaf(qualify(&name, &plain_ident(&variant.ident)), "variant", variant.span(), end);
                }
            }
            Item::Trait(item_trait) => {
                let name = qualify(prefix, &plain_ident(&item_trait.ident));
                let header_end = lines(item_trait.brace_token.span.open()).0;
                self.container(&name, "trait", item.span(), header_end);
                for trait_item in &item_trait.items {
                    self.trait_item(&name, trait_item);
                }
            }
            Item::Impl(item_impl) => {
                let self_name = type_name(&item_impl.self_ty);
                let name = match &item_impl.trait_ {
                    Some((path, _)) => format!("<{self_name} as {}>", path_name(path)),
                    None => self_name,
                };
                let name = qualify(prefix, &name);
                for impl_item in &item_impl.items {
                    self.impl_item(&name, impl_item);
                }
            }
            Item::Mod(item_mod) => {
                let name = qualify(prefix, &plain_ident(&item_mod.ident));
                match &item_mod.content {
                    Some((brace, items)) => {
                        let header_end = lines(brace.span.open()).0;
                        self.container(&name, "module", item.span(), header_end);
                        self.items(&name, items);
                    }
                    None => {
                        let (_, end) = lines(item.span());
                        self.leaf(name, "module", item.span(), end);
                    }
                }
            }
            Item::ForeignMod(foreign) => {
                for foreign_item in &foreign.items {
                    match foreign_item {
                        ForeignItem::Fn(function) => {
                            let (_, end) = lines(foreign_item.span());
                            self.leaf(
                                qualify(prefix, &plain_ident(&function.sig.ident)),
                                "function",
                                foreign_item.span(),
                                end,
                            );
                        }
                        ForeignItem::Static(item_static) => {
                            let (_, end) = lines(foreign_item.span());
                            self.leaf(
                                qualify(prefix, &plain_ident(&item_static.ident)),
                                "static",
                                foreign_item.span(),
                                end,
                            );
                        }
                        ForeignItem::Type(item_type) => {
                            let (_, end) = lines(foreign_item.span());
                            self.leaf(
                                qualify(prefix, &plain_ident(&item_type.ident)),
                                "type",
                                foreign_item.span(),
                                end,
                            );
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn trait_item(&mut self, prefix: &str, item: &TraitItem) {
        let span = item.span();
        let (_, end) = lines(span);
        match item {
            TraitItem::Fn(function) => {
                let header_end = match &function.default {
                    Some(block) => lines(block.brace_token.span.open()).0,
                    None => end,
                };
                self.leaf(qualify(prefix, &plain_ident(&function.sig.ident)), "method", span, header_end);
            }
            TraitItem::Const(constant) => {
                self.leaf(qualify(prefix, &plain_ident(&constant.ident)), "const", span, end);
            }
            TraitItem::Type(alias) => {
                self.leaf(qualify(prefix, &plain_ident(&alias.ident)), "type", span, end);
            }
            _ => {}
        }
    }

    fn impl_item(&mut self, prefix: &str, item: &ImplItem) {
        let span = item.span();
        let (_, end) = lines(span);
        match item {
            ImplItem::Fn(function) => {
                let header_end = lines(function.block.brace_token.span.open()).0;
                self.leaf(qualify(prefix, &plain_ident(&function.sig.ident)), "method", span, header_end);
            }
            ImplItem::Const(constant) => {
                self.leaf(qualify(prefix, &plain_ident(&constant.ident)), "const", span, end);
            }
            ImplItem::Type(alias) => {
                self.leaf(qualify(prefix, &plain_ident(&alias.ident)), "type", span, end);
            }
            _ => {}
        }
    }
}

// The identifier tokens on the given lines, keywords and the names of
// lifetimes left out, sorted and unique.
fn identifiers(source: &str, ranges: &[(usize, usize)]) -> Vec<String> {
    let Ok(stream) = source.parse::<TokenStream>() else {
        return Vec::new();
    };
    let mut found = BTreeSet::new();
    let mut stack = vec![stream.into_iter()];
    let mut after_tick = false;
    while let Some(iterator) = stack.last_mut() {
        let Some(token) = iterator.next() else {
            stack.pop();
            after_tick = false;
            continue;
        };
        match token {
            TokenTree::Group(group) => {
                after_tick = false;
                if group.delimiter() != Delimiter::None || group.stream().into_iter().next().is_some() {
                    stack.push(group.stream().into_iter());
                }
            }
            TokenTree::Ident(ident) => {
                let name = plain_ident(&ident);
                let line = ident.span().start().line;
                let on_lines = ranges.iter().any(|&(a, b)| a <= line && line <= b);
                if !after_tick && on_lines && !KEYWORDS.contains(&name.as_str()) {
                    found.insert(name);
                }
                after_tick = false;
            }
            TokenTree::Punct(punct) => after_tick = punct.as_char() == '\'',
            TokenTree::Literal(_) => after_tick = false,
        }
    }
    found.into_iter().collect()
}

// Blanks a leading `#!` line that is not an inner attribute, so both the
// parser and the lexer see Rust, and drops a byte order mark.
fn clean(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.starts_with("#!") && !text.starts_with("#![") {
        let end = text.find('\n').unwrap_or(text.len());
        let mut out = " ".repeat(end);
        out.push_str(&text[end..]);
        return out;
    }
    text.to_string()
}

fn ranges_of(entry: &Value) -> Option<Vec<(usize, usize)>> {
    let mut out = Vec::new();
    for range in entry.get("ranges")?.as_array()? {
        let start = range.get("start")?.as_u64()?;
        let end = range.get("end")?.as_u64()?;
        if start < 1 || end < start {
            return None;
        }
        out.push((start as usize, end as usize));
    }
    Some(out)
}

fn map_entry(entry: &Value, max_file_bytes: f64) -> Result<Value, Failure> {
    let malformed = || fail("the request entry is malformed");
    entry.get("path").and_then(Value::as_str).ok_or_else(malformed)?;
    let file = entry.get("file").and_then(Value::as_str).ok_or_else(malformed)?;
    let ranges = ranges_of(entry).ok_or_else(malformed)?;
    let unreadable = || fail("the file could not be read");
    let metadata = std::fs::metadata(file).map_err(|_| unreadable())?;
    if metadata.len() as f64 > max_file_bytes {
        return Err(fail("the file is larger than maxFileBytes"));
    }
    let text = std::fs::read_to_string(file).map_err(|_| unreadable())?;
    let source = clean(&text);
    let tree = syn::parse_file(&source).map_err(|error| {
        let line = error.span().start().line.max(1);
        Failure(format!("syntax error at line {line}"))
    })?;
    let mut mapper = Mapper { ranges: ranges.clone(), members: Vec::new() };
    mapper.items("", &tree.items);
    mapper.members.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.name.cmp(&b.name)));
    let members: Vec<Value> = mapper
        .members
        .iter()
        .map(|m| json!({"name": m.name, "kind": m.kind, "declarationTouched": m.touched}))
        .collect();
    Ok(json!({"members": members, "identifiers": identifiers(&source, &ranges)}))
}

// The child process: one entry on standard input, one JSON object on standard
// output, either `{members, identifiers}` or `{error}`.
fn child(max_file_bytes: f64) -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 2;
    }
    let result = match serde_json::from_str::<Value>(&input) {
        Ok(entry) => map_entry(&entry, max_file_bytes),
        Err(_) => Err(fail("the request entry is malformed")),
    };
    let out = match result {
        Ok(value) => value,
        Err(Failure(message)) => json!({"error": message}),
    };
    println!("{out}");
    0
}

// The limit the variable `name` sets, in seconds, when it is below `default`;
// otherwise `default`.
fn lowered(name: &str, default: Duration) -> Duration {
    match std::env::var(name).ok().and_then(|text| text.trim().parse::<f64>().ok()) {
        Some(seconds) if seconds.is_finite() && seconds > 0.0 && seconds < default.as_secs_f64() => {
            Duration::from_secs_f64(seconds)
        }
        _ => default,
    }
}

fn run_child(entry: &Value, max_file_bytes: &str, limit: Duration) -> Result<Value, Failure> {
    let crashed = || fail("the parser failed on the file");
    let exe = std::env::current_exe().map_err(|_| crashed())?;
    let mut process = Command::new(exe)
        .args(["--entry", max_file_bytes])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| crashed())?;
    let mut stdin = process.stdin.take().ok_or_else(crashed)?;
    let mut stdout = process.stdout.take().ok_or_else(crashed)?;
    let payload = entry.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(payload.as_bytes());
    });
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let started = Instant::now();
    let status = loop {
        match process.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= limit => {
                let _ = process.kill();
                let _ = process.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => {
                let _ = process.kill();
                let _ = process.wait();
                return Err(crashed());
            }
        }
    };
    let _ = writer.join();
    let output = reader.join().map_err(|_| crashed())?;
    let Some(status) = status else {
        return Err(Failure(format!(
            "the parser took longer than {} seconds",
            limit.as_secs_f64()
        )));
    };
    if !status.success() {
        return Err(crashed());
    }
    serde_json::from_slice::<Value>(&output).map_err(|_| crashed())
}

fn run(args: &[String]) -> i32 {
    if args.len() == 2 && args[0] == "--entry" {
        return match args[1].parse::<f64>() {
            Ok(max) => child(max),
            Err(_) => 2,
        };
    }
    if args.len() != 2 || args[1].parse::<f64>().is_err() {
        eprintln!("{USAGE}");
        return 2;
    }
    let Ok(data) = std::fs::read(&args[0]) else {
        eprintln!("the request file could not be read");
        return 2;
    };
    let Ok(Value::Array(request)) = serde_json::from_slice::<Value>(&data) else {
        eprintln!("the request must be a list");
        return 2;
    };
    let child_limit = lowered(CHILD_LIMIT_ENV, CHILD_LIMIT);
    let batch_limit = lowered(BATCH_LIMIT_ENV, BATCH_LIMIT);
    let started = Instant::now();
    let mut out = Vec::with_capacity(request.len());
    for entry in &request {
        let id = entry.get("id").cloned().unwrap_or(Value::Null);
        let outcome = if started.elapsed() + child_limit > batch_limit {
            Err(fail(OUT_OF_TIME))
        } else {
            run_child(entry, &args[1], child_limit)
        };
        let mut response = match outcome {
            Ok(Value::Object(map)) => map,
            Ok(_) => serde_json::Map::from_iter([("error".to_string(), json!("the parser failed on the file"))]),
            Err(Failure(message)) => serde_json::Map::from_iter([("error".to_string(), json!(message))]),
        };
        let mut ordered = serde_json::Map::new();
        ordered.insert("id".to_string(), id);
        ordered.append(&mut response);
        out.push(Value::Object(ordered));
    }
    if writeln!(std::io::stdout(), "{}", Value::Array(out)).is_err() {
        eprintln!("the response could not be written");
        return 1;
    }
    0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&args));
}
