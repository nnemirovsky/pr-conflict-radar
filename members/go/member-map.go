// Member mapper for Go.
//
// Usage: member-map <request.json> <maxFileBytes>
//
// The request is `[{id, path, file, ranges}]`: `file` is a temp file holding
// the source and `ranges` is `[{start, end}]` of 1-based inclusive lines. The
// response is one JSON array on standard output, with per entry either
// `{id, members, identifiers}` or `{id, error}`. The source is parsed as text
// and never compiled or run. The process exits 0 whenever it wrote a response.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"go/types"
	"os"
	"sort"
	"strconv"
)

type lineRange struct {
	Start *int `json:"start"`
	End   *int `json:"end"`
}

type requestEntry struct {
	Path   *string     `json:"path"`
	File   *string     `json:"file"`
	Ranges []lineRange `json:"ranges"`
}

type member struct {
	Name               string `json:"name"`
	Kind               string `json:"kind"`
	DeclarationTouched bool   `json:"declarationTouched"`
}

type response struct {
	ID    json.RawMessage `json:"id"`
	Error string          `json:"error"`
}

// entryResult has non-nil lists, so a mapped entry always carries both keys.
type entryResult struct {
	ID          json.RawMessage `json:"id"`
	Members     []member        `json:"members"`
	Identifiers []string        `json:"identifiers"`
}

type span struct{ start, end int }

type collector struct {
	fset   *token.FileSet
	ranges []span
	pkg    string
	order  []string
	found  map[string]*member
}

func (c *collector) line(pos token.Pos) int {
	return c.fset.PositionFor(pos, false).Line
}

func (c *collector) meets(from, to int) bool {
	for _, r := range c.ranges {
		if r.start <= to && r.end >= from {
			return true
		}
	}
	return false
}

// add records a member spanning start..end whose declaration part ends at
// headerEnd. A container is reported only for its own declaration; the members
// inside it are reported on their own.
func (c *collector) add(start, end token.Pos, headerEnd token.Pos, qualified, kind string, container bool) {
	if qualified == "" {
		return
	}
	from, to := c.line(start), c.line(end)
	touched := c.meets(from, c.line(headerEnd))
	if container {
		if !touched {
			return
		}
	} else if !c.meets(from, to) {
		return
	}
	key := kind + "\x00" + qualified
	if known, ok := c.found[key]; ok {
		known.DeclarationTouched = known.DeclarationTouched || touched
		return
	}
	c.found[key] = &member{Name: qualified, Kind: kind, DeclarationTouched: touched}
	c.order = append(c.order, key)
}

func (c *collector) qualify(parts ...string) string {
	name := c.pkg
	for _, part := range parts {
		name += "." + part
	}
	return name
}

// receiverName is the type a method is declared on, without the pointer and
// the type parameters.
func receiverName(expr ast.Expr) string {
	for {
		switch e := expr.(type) {
		case *ast.StarExpr:
			expr = e.X
		case *ast.ParenExpr:
			expr = e.X
		case *ast.IndexExpr:
			expr = e.X
		case *ast.IndexListExpr:
			expr = e.X
		case *ast.Ident:
			return e.Name
		default:
			return ""
		}
	}
}

func embeddedName(expr ast.Expr) string {
	if star, ok := expr.(*ast.StarExpr); ok {
		expr = star.X
	}
	return types.ExprString(expr)
}

func (c *collector) funcDecl(decl *ast.FuncDecl) {
	headerEnd := decl.End()
	if decl.Body != nil {
		headerEnd = decl.Body.Lbrace
	}
	if decl.Recv != nil && len(decl.Recv.List) > 0 {
		recv := receiverName(decl.Recv.List[0].Type)
		if recv == "" || decl.Name.Name == "_" {
			return
		}
		c.add(decl.Pos(), decl.End(), headerEnd, c.qualify(recv, decl.Name.Name), "method", false)
		return
	}
	c.add(decl.Pos(), decl.End(), headerEnd, c.qualify(decl.Name.Name), "function", false)
}

func (c *collector) genDecl(decl *ast.GenDecl) {
	for _, spec := range decl.Specs {
		// An ungrouped declaration spans from its keyword.
		start := spec.Pos()
		if !decl.Lparen.IsValid() {
			start = decl.Pos()
		}
		switch s := spec.(type) {
		case *ast.TypeSpec:
			c.typeSpec(s, start)
		case *ast.ValueSpec:
			kind := "var"
			if decl.Tok == token.CONST {
				kind = "const"
			}
			end := s.End()
			if !decl.Lparen.IsValid() {
				end = decl.End()
			}
			for _, name := range s.Names {
				if name.Name == "_" {
					continue
				}
				c.add(start, end, end, c.qualify(name.Name), kind, false)
			}
		}
	}
}

func (c *collector) typeSpec(spec *ast.TypeSpec, start token.Pos) {
	name := spec.Name.Name
	if name == "_" {
		return
	}
	switch t := spec.Type.(type) {
	case *ast.StructType:
		headerEnd := spec.End()
		if t.Fields != nil && t.Fields.Opening.IsValid() {
			headerEnd = t.Fields.Opening
		}
		c.add(start, spec.End(), headerEnd, c.qualify(name), "type", true)
		if t.Fields == nil {
			return
		}
		for _, field := range t.Fields.List {
			if len(field.Names) == 0 {
				c.add(field.Pos(), field.End(), field.End(), c.qualify(name, embeddedName(field.Type)), "field", false)
				continue
			}
			for _, fname := range field.Names {
				c.add(field.Pos(), field.End(), field.End(), c.qualify(name, fname.Name), "field", false)
			}
		}
	case *ast.InterfaceType:
		headerEnd := spec.End()
		if t.Methods != nil && t.Methods.Opening.IsValid() {
			headerEnd = t.Methods.Opening
		}
		c.add(start, spec.End(), headerEnd, c.qualify(name), "type", true)
		if t.Methods == nil {
			return
		}
		for _, method := range t.Methods.List {
			if len(method.Names) == 0 {
				c.add(method.Pos(), method.End(), method.End(), c.qualify(name, types.ExprString(method.Type)), "embedded", false)
				continue
			}
			for _, mname := range method.Names {
				c.add(method.Pos(), method.End(), method.End(), c.qualify(name, mname.Name), "method", false)
			}
		}
	default:
		c.add(start, spec.End(), spec.End(), c.qualify(name), "type", false)
	}
}

func (c *collector) members() []member {
	out := make([]member, 0, len(c.order))
	for _, key := range c.order {
		out = append(out, *c.found[key])
	}
	return out
}

// identifiersOn returns the identifier tokens on the given lines, sorted and
// unique, from the Go scanner.
func identifiersOn(fset *token.FileSet, src []byte, ranges []span) []string {
	file := fset.AddFile("scan.go", fset.Base(), len(src))
	var s scanner.Scanner
	s.Init(file, src, nil, 0)
	names := map[string]bool{}
	for {
		pos, tok, lit := s.Scan()
		if tok == token.EOF {
			break
		}
		if tok != token.IDENT || lit == "_" {
			continue
		}
		line := file.PositionFor(pos, false).Line
		for _, r := range ranges {
			if r.start <= line && r.end >= line {
				names[lit] = true
				break
			}
		}
	}
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

type entryError string

func (e entryError) Error() string { return string(e) }

func mapEntry(raw json.RawMessage, maxFileBytes float64) (result entryResult, err error) {
	defer func() {
		if recover() != nil {
			result, err = entryResult{}, entryError("the parser failed on the file")
		}
	}()
	var entry requestEntry
	if json.Unmarshal(raw, &entry) != nil || entry.Path == nil || entry.File == nil || entry.Ranges == nil {
		return result, entryError("the request entry is malformed")
	}
	ranges := make([]span, 0, len(entry.Ranges))
	for _, r := range entry.Ranges {
		if r.Start == nil || r.End == nil || *r.Start < 1 || *r.End < *r.Start {
			return result, entryError("the request entry is malformed")
		}
		ranges = append(ranges, span{*r.Start, *r.End})
	}
	info, statErr := os.Stat(*entry.File)
	if statErr != nil {
		return result, entryError("the file could not be read")
	}
	if float64(info.Size()) > maxFileBytes {
		return result, entryError("the file is larger than maxFileBytes")
	}
	src, readErr := os.ReadFile(*entry.File)
	if readErr != nil {
		return result, entryError("the file could not be read")
	}
	fset := token.NewFileSet()
	// Build tags are ignored: every file is parsed.
	tree, parseErr := parser.ParseFile(fset, "file.go", src, parser.AllErrors|parser.SkipObjectResolution)
	if parseErr != nil {
		line := 1
		var list scanner.ErrorList
		if errors.As(parseErr, &list) && len(list) > 0 {
			line = list[0].Pos.Line
		}
		return result, entryError(fmt.Sprintf("syntax error at line %d", line))
	}
	c := &collector{fset: fset, ranges: ranges, pkg: tree.Name.Name, found: map[string]*member{}}
	for _, decl := range tree.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			c.funcDecl(d)
		case *ast.GenDecl:
			c.genDecl(d)
		}
	}
	return entryResult{Members: c.members(), Identifiers: identifiersOn(fset, src, ranges)}, nil
}

func entryID(raw json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) == nil {
		if id, ok := fields["id"]; ok {
			return id
		}
	}
	return json.RawMessage("null")
}

func run(args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: member-map <request.json> <maxFileBytes>")
		return 2
	}
	maxFileBytes, err := strconv.ParseFloat(args[1], 64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "usage: member-map <request.json> <maxFileBytes>")
		return 2
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, "the request file could not be read")
		return 2
	}
	var request []json.RawMessage
	if err := json.Unmarshal(data, &request); err != nil {
		fmt.Fprintln(os.Stderr, "the request must be a list")
		return 2
	}
	out := make([]any, 0, len(request))
	for _, raw := range request {
		id := entryID(raw)
		result, err := mapEntry(raw, maxFileBytes)
		if err != nil {
			out = append(out, response{ID: id, Error: err.Error()})
			continue
		}
		result.ID = id
		out = append(out, result)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "the response could not be written")
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:]))
}
