#:package Microsoft.CodeAnalysis.CSharp@5.12.0

// Member mapper for C#.
//
// Usage: dotnet run --no-build MemberMap.cs -- <request.json> <maxFileBytes>
//
// The request is `[{id, path, file, ranges}]`: `file` is a temp file holding the
// source, `path` is only echoed in messages, and `ranges` is `[{start, end}]` of
// 1-based inclusive lines. The response is one JSON array on standard output,
// with per entry either `{id, members, identifiers}` or `{id, error}`. The
// source is parsed as text and never compiled or executed. The process exits 0
// whenever it wrote a response.

using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length != 2 || !double.TryParse(args[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var maxFileBytes))
{
    Console.Error.WriteLine("usage: MemberMap.cs <request.json> <maxFileBytes>");
    return 2;
}

JsonDocument request;
try
{
    request = JsonDocument.Parse(File.ReadAllBytes(args[0]), new JsonDocumentOptions { MaxDepth = 64 });
}
catch (Exception)
{
    Console.Error.WriteLine("the request file could not be read");
    return 2;
}
if (request.RootElement.ValueKind != JsonValueKind.Array)
{
    Console.Error.WriteLine("the request must be a list");
    return 2;
}

var output = new MemoryStream();
using (var writer = new Utf8JsonWriter(output))
{
    writer.WriteStartArray();
    foreach (var entry in request.RootElement.EnumerateArray())
    {
        WriteEntry(writer, entry, maxFileBytes);
    }
    writer.WriteEndArray();
}
using (var stdout = Console.OpenStandardOutput())
{
    output.Position = 0;
    output.CopyTo(stdout);
    stdout.Write("\n"u8);
}
return 0;

static void WriteId(Utf8JsonWriter writer, JsonElement entry)
{
    writer.WritePropertyName("id");
    if (entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("id", out var id))
    {
        id.WriteTo(writer);
    }
    else
    {
        writer.WriteNullValue();
    }
}

static void WriteEntry(Utf8JsonWriter writer, JsonElement entry, double maxFileBytes)
{
    MappedFile? mapped = null;
    string? error = null;
    // The mapping runs on a thread with a large stack, so the syntax tree of
    // an unusual file can be walked without exhausting the default one.
    var worker = new Thread(
        () =>
        {
            try
            {
                mapped = Mapper.MapEntry(entry, maxFileBytes);
            }
            catch (EntryError e)
            {
                error = e.Message;
            }
            catch (Exception)
            {
                error = "the parser failed on the file";
            }
        },
        256 * 1024 * 1024);
    worker.Start();
    worker.Join();

    writer.WriteStartObject();
    WriteId(writer, entry);
    if (mapped is null)
    {
        writer.WriteString("error", error ?? "the parser failed on the file");
    }
    else
    {
        writer.WriteStartArray("members");
        foreach (var member in mapped.Members)
        {
            writer.WriteStartObject();
            writer.WriteString("name", member.Name);
            writer.WriteString("kind", member.Kind);
            writer.WriteBoolean("declarationTouched", member.DeclarationTouched);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        writer.WriteStartArray("identifiers");
        foreach (var identifier in mapped.Identifiers)
        {
            writer.WriteStringValue(identifier);
        }
        writer.WriteEndArray();
    }
    writer.WriteEndObject();
}

sealed class EntryError(string message) : Exception(message);

sealed class Member
{
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public bool DeclarationTouched { get; set; }
}

sealed record MappedFile(List<Member> Members, List<string> Identifiers);

readonly record struct LineRange(long Start, long End);

static class Mapper
{
    // Types and namespaces nested deeper than this are an entry error; real
    // code never gets near it.
    const int MaxNesting = 200;

    // Roslyn parses deeply nested expressions in more than linear time, so a
    // file whose brackets nest deeper than this is refused before parsing.
    // The count ignores strings and comments, which only ever overstates it.
    const int MaxBracketDepth = 1000;

    static int BracketDepth(string text)
    {
        int depth = 0, deepest = 0;
        foreach (var c in text)
        {
            if (c is '(' or '[' or '{')
            {
                deepest = Math.Max(deepest, ++depth);
            }
            else if (c is ')' or ']' or '}' && depth > 0)
            {
                depth--;
            }
        }
        return deepest;
    }

    public static MappedFile MapEntry(JsonElement entry, double maxFileBytes)
    {
        if (entry.ValueKind != JsonValueKind.Object
            || !entry.TryGetProperty("path", out var path) || path.ValueKind != JsonValueKind.String
            || !entry.TryGetProperty("file", out var file) || file.ValueKind != JsonValueKind.String
            || !entry.TryGetProperty("ranges", out var rangesElement)
            || !TryReadRanges(rangesElement, out var ranges))
        {
            throw new EntryError("the request entry is malformed");
        }

        long size;
        try
        {
            size = new FileInfo(file.GetString()!).Length;
        }
        catch (Exception)
        {
            throw new EntryError("the file could not be read");
        }
        if (size > maxFileBytes)
        {
            throw new EntryError("the file is larger than maxFileBytes");
        }
        string text;
        try
        {
            text = File.ReadAllText(file.GetString()!, Encoding.UTF8);
        }
        catch (Exception)
        {
            throw new EntryError("the file could not be read");
        }

        if (BracketDepth(text) > MaxBracketDepth)
        {
            throw new EntryError("the file is nested too deeply to parse");
        }

        SyntaxTree tree;
        try
        {
            tree = CSharpSyntaxTree.ParseText(text, new CSharpParseOptions(LanguageVersion.Latest));
        }
        catch (InsufficientExecutionStackException)
        {
            throw new EntryError("the file is nested too deeply to parse");
        }
        var lines = LineStarts(text);
        foreach (var diagnostic in tree.GetDiagnostics())
        {
            if (diagnostic.Severity == DiagnosticSeverity.Error)
            {
                throw new EntryError($"syntax error at line {LineOf(lines, diagnostic.Location.SourceSpan.Start)}");
            }
        }

        var root = tree.GetRoot();
        var collector = new Collector(lines, ranges);
        try
        {
            collector.Members(root, "", 0);
        }
        catch (InsufficientExecutionStackException)
        {
            throw new EntryError("the file is nested too deeply to map");
        }
        return new MappedFile(collector.Result(), Identifiers(root, lines, ranges));
    }

    static bool TryReadRanges(JsonElement element, out List<LineRange> ranges)
    {
        ranges = [];
        if (element.ValueKind != JsonValueKind.Array)
        {
            return false;
        }
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object
                || !item.TryGetProperty("start", out var start) || !start.TryGetInt64(out var from)
                || !item.TryGetProperty("end", out var end) || !end.TryGetInt64(out var to)
                || from < 1 || to < from)
            {
                return false;
            }
            ranges.Add(new LineRange(from, to));
        }
        return true;
    }

    // Start offsets of each line. Only `\n` ends a line, as in git's hunk
    // headers; Roslyn also counts a lone `\r` and the Unicode separators.
    static int[] LineStarts(string text)
    {
        var starts = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                starts.Add(i + 1);
            }
        }
        return [.. starts];
    }

    public static int LineOf(int[] lines, int position)
    {
        var index = Array.BinarySearch(lines, position);
        return (index >= 0 ? index : ~index - 1) + 1;
    }

    static List<string> Identifiers(SyntaxNode root, int[] lines, List<LineRange> ranges)
    {
        var names = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var token in root.DescendantTokens())
        {
            if (!token.IsKind(SyntaxKind.IdentifierToken))
            {
                continue;
            }
            var line = LineOf(lines, token.SpanStart);
            if (ranges.Any(range => range.Start <= line && range.End >= line))
            {
                names.Add(token.ValueText);
            }
        }
        return [.. names];
    }

    sealed class Collector(int[] lines, List<LineRange> ranges)
    {
        readonly Dictionary<(string, string), Member> found = [];
        readonly List<(string, string)> order = [];

        public List<Member> Result() => [.. order.Select(key => found[key])];

        bool Meets(int from, int to) => ranges.Any(range => range.Start <= to && range.End >= from);

        // `node` spans its first token (attributes included) to its end;
        // `headerEnd` is the position where its declaration part ends.
        void Add(SyntaxNode node, string qualifier, string name, string kind, int headerEnd, bool container = false)
        {
            var start = LineOf(lines, node.SpanStart);
            var end = LineOf(lines, Math.Max(node.Span.End - 1, node.SpanStart));
            var touched = Meets(start, LineOf(lines, Math.Max(headerEnd, node.SpanStart)));
            // A container is reported for its own header only; the members
            // inside it are reported on their own, so touching one member
            // does not touch the others' container.
            if (container ? !touched : !Meets(start, end))
            {
                return;
            }
            var qualified = qualifier.Length == 0 ? name : $"{qualifier}.{name}";
            var key = (kind, qualified);
            if (found.TryGetValue(key, out var known))
            {
                known.DeclarationTouched |= touched;
            }
            else
            {
                found[key] = new Member { Name = qualified, Kind = kind, DeclarationTouched = touched };
                order.Add(key);
            }
        }

        static string Join(string qualifier, string name) => qualifier.Length == 0 ? name : $"{qualifier}.{name}";

        static int BodyStart(BlockSyntax? body, ArrowExpressionClauseSyntax? arrow, SyntaxNode node)
        {
            if (body is not null)
            {
                return body.SpanStart;
            }
            return arrow is not null ? arrow.SpanStart : node.Span.End;
        }

        public void Members(SyntaxNode parent, string qualifier, int depth)
        {
            if (depth > MaxNesting)
            {
                throw new EntryError("the file is nested too deeply to map");
            }
            IEnumerable<SyntaxNode> children = parent switch
            {
                CompilationUnitSyntax unit => unit.Members,
                BaseNamespaceDeclarationSyntax ns => ns.Members,
                TypeDeclarationSyntax type => type.Members,
                EnumDeclarationSyntax e => e.Members,
                _ => [],
            };
            foreach (var node in children)
            {
                Declare(node, qualifier, depth);
            }
        }

        void Declare(SyntaxNode node, string qualifier, int depth)
        {
            switch (node)
            {
                case BaseNamespaceDeclarationSyntax ns:
                    {
                        var name = ns.Name.ToString().Replace(" ", "");
                        var headerEnd = ns switch
                        {
                            NamespaceDeclarationSyntax block => block.OpenBraceToken.SpanStart,
                            FileScopedNamespaceDeclarationSyntax scoped => scoped.SemicolonToken.SpanStart,
                            _ => ns.Span.End,
                        };
                        Add(ns, qualifier, name, "namespace", headerEnd, container: true);
                        Members(ns, Join(qualifier, name), depth + 1);
                        break;
                    }
                case TypeDeclarationSyntax type:
                    {
                        var name = type.Identifier.ValueText;
                        var kind = type switch
                        {
                            ClassDeclarationSyntax => "class",
                            StructDeclarationSyntax => "struct",
                            InterfaceDeclarationSyntax => "interface",
                            _ => "record",
                        };
                        var headerEnd = type.OpenBraceToken.IsKind(SyntaxKind.None) ? type.Span.End : type.OpenBraceToken.SpanStart;
                        Add(type, qualifier, name, kind, headerEnd, container: true);
                        Members(type, Join(qualifier, name), depth + 1);
                        break;
                    }
                case EnumDeclarationSyntax e:
                    {
                        var name = e.Identifier.ValueText;
                        var headerEnd = e.OpenBraceToken.IsKind(SyntaxKind.None) ? e.Span.End : e.OpenBraceToken.SpanStart;
                        Add(e, qualifier, name, "enum", headerEnd, container: true);
                        Members(e, Join(qualifier, name), depth + 1);
                        break;
                    }
                case EnumMemberDeclarationSyntax enumMember:
                    Add(enumMember, qualifier, enumMember.Identifier.ValueText, "enumMember", enumMember.Span.End);
                    break;
                case DelegateDeclarationSyntax del:
                    Add(del, qualifier, del.Identifier.ValueText, "delegate", del.Span.End);
                    break;
                case MethodDeclarationSyntax method:
                    {
                        var name = method.ExplicitInterfaceSpecifier is null
                            ? method.Identifier.ValueText
                            : $"{method.ExplicitInterfaceSpecifier.Name.ToString().Replace(" ", "")}.{method.Identifier.ValueText}";
                        Add(method, qualifier, name, "method", BodyStart(method.Body, method.ExpressionBody, method));
                        LocalFunctions(method, Join(qualifier, name));
                        break;
                    }
                case ConstructorDeclarationSyntax ctor:
                    {
                        var name = ctor.Modifiers.Any(SyntaxKind.StaticKeyword) ? "static constructor" : "constructor";
                        Add(ctor, qualifier, name, "constructor", BodyStart(ctor.Body, ctor.ExpressionBody, ctor));
                        LocalFunctions(ctor, Join(qualifier, name));
                        break;
                    }
                case DestructorDeclarationSyntax dtor:
                    Add(dtor, qualifier, "destructor", "destructor", BodyStart(dtor.Body, dtor.ExpressionBody, dtor));
                    LocalFunctions(dtor, Join(qualifier, "destructor"));
                    break;
                case OperatorDeclarationSyntax op:
                    {
                        var name = $"operator {op.OperatorToken.ValueText}";
                        Add(op, qualifier, name, "operator", BodyStart(op.Body, op.ExpressionBody, op));
                        LocalFunctions(op, Join(qualifier, name));
                        break;
                    }
                case ConversionOperatorDeclarationSyntax conversion:
                    {
                        var name = $"operator {conversion.ImplicitOrExplicitKeyword.ValueText} {conversion.Type.ToString().Replace(" ", "")}";
                        Add(conversion, qualifier, name, "operator", BodyStart(conversion.Body, conversion.ExpressionBody, conversion));
                        LocalFunctions(conversion, Join(qualifier, name));
                        break;
                    }
                case PropertyDeclarationSyntax property:
                    {
                        var name = property.ExplicitInterfaceSpecifier is null
                            ? property.Identifier.ValueText
                            : $"{property.ExplicitInterfaceSpecifier.Name.ToString().Replace(" ", "")}.{property.Identifier.ValueText}";
                        Add(property, qualifier, name, "property", AccessorsStart(property.AccessorList, property.ExpressionBody, property));
                        LocalFunctions(property, Join(qualifier, name));
                        break;
                    }
                case IndexerDeclarationSyntax indexer:
                    Add(indexer, qualifier, "this[]", "indexer", AccessorsStart(indexer.AccessorList, indexer.ExpressionBody, indexer));
                    LocalFunctions(indexer, Join(qualifier, "this[]"));
                    break;
                case EventDeclarationSyntax ev:
                    {
                        Add(ev, qualifier, ev.Identifier.ValueText, "event", AccessorsStart(ev.AccessorList, null, ev));
                        LocalFunctions(ev, Join(qualifier, ev.Identifier.ValueText));
                        break;
                    }
                case BaseFieldDeclarationSyntax field:
                    {
                        var kind = field is EventFieldDeclarationSyntax ? "event" : "field";
                        foreach (var variable in field.Declaration.Variables)
                        {
                            AddVariable(field, variable, qualifier, kind);
                        }
                        break;
                    }
            }
        }

        static int AccessorsStart(AccessorListSyntax? accessors, ArrowExpressionClauseSyntax? arrow, SyntaxNode node)
        {
            if (accessors is not null)
            {
                return accessors.OpenBraceToken.SpanStart;
            }
            return arrow is not null ? arrow.SpanStart : node.Span.End;
        }

        // A field declaration may declare several variables; each is a member
        // spanning its own declarator, with the type and modifiers shared.
        void AddVariable(BaseFieldDeclarationSyntax field, VariableDeclaratorSyntax variable, string qualifier, string kind)
        {
            var name = variable.Identifier.ValueText;
            var first = field.Declaration.Variables[0] == variable;
            var start = LineOf(lines, first ? field.SpanStart : variable.SpanStart);
            var end = LineOf(lines, Math.Max(variable.Span.End - 1, variable.SpanStart));
            if (!Meets(start, end))
            {
                return;
            }
            var qualified = Join(qualifier, name);
            var key = (kind, qualified);
            if (found.TryGetValue(key, out var known))
            {
                known.DeclarationTouched = true;
            }
            else
            {
                found[key] = new Member { Name = qualified, Kind = kind, DeclarationTouched = true };
                order.Add(key);
            }
            if (variable.Initializer is not null)
            {
                LocalFunctions(variable.Initializer, qualified);
            }
        }

        // Local functions in the body of a member, qualified by the member
        // and by any local function that contains them.
        void LocalFunctions(SyntaxNode member, string qualifier)
        {
            foreach (var node in member.DescendantNodes())
            {
                if (node is not LocalFunctionStatementSyntax local)
                {
                    continue;
                }
                var chain = new List<string> { local.Identifier.ValueText };
                for (var up = local.Parent; up is not null && up != member; up = up.Parent)
                {
                    if (up is LocalFunctionStatementSyntax outer)
                    {
                        chain.Insert(0, outer.Identifier.ValueText);
                    }
                }
                var owner = qualifier;
                for (var i = 0; i < chain.Count - 1; i++)
                {
                    owner = Join(owner, chain[i]);
                }
                Add(local, owner, chain[^1], "localFunction", BodyStart(local.Body, local.ExpressionBody, local));
            }
        }
    }
}
