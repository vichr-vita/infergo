package source

import (
	"bytes"
	"errors"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"path"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// parsedFile is one Go file parsed with comments. A file with a syntax error
// keeps the partial tree the parser returned. Only nodes that end before
// errorOffset are trusted, because the parser may drop or misread everything
// after the first error.
type parsedFile struct {
	path        string
	src         []byte
	fset        *token.FileSet
	syntax      *ast.File // nil when not even the package clause parsed
	problem     *protocol.FileProblem
	errorOffset int
	generated   bool
}

// parseFile parses src as the file at path.
func parseFile(path string, src []byte) *parsedFile {
	fset := token.NewFileSet()
	syntax, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	f := &parsedFile{path: path, src: src, fset: fset, syntax: syntax, errorOffset: len(src) + 1}
	if err != nil {
		f.problem, f.errorOffset = firstProblem(path, err)
	}
	if syntax != nil && syntax.Name == nil {
		f.syntax = nil
	}
	if f.syntax != nil {
		f.generated = ast.IsGenerated(f.syntax)
	}
	return f
}

// firstProblem returns the earliest error of a parse and its byte offset.
func firstProblem(path string, err error) (*protocol.FileProblem, int) {
	var list scanner.ErrorList
	if errors.As(err, &list) && len(list) > 0 {
		list.Sort()
		first := list[0]
		return &protocol.FileProblem{
			Position: protocol.Position{File: path, Line: first.Pos.Line, Column: first.Pos.Column},
			Message:  first.Msg,
		}, first.Pos.Offset
	}
	return &protocol.FileProblem{Position: protocol.Position{File: path, Line: 1, Column: 1}, Message: err.Error()}, 0
}

// offset returns the byte offset of pos in the file.
func (f *parsedFile) offset(pos token.Pos) int {
	return f.fset.Position(pos).Offset
}

// line returns the 1-based line of a byte offset.
func (f *parsedFile) line(offset int) int {
	return bytes.Count(f.src[:offset], []byte("\n")) + 1
}

// text returns the source of a node.
func (f *parsedFile) text(node ast.Node) string {
	return string(f.src[f.offset(node.Pos()):f.offset(node.End())])
}

// complete reports whether node ends before the file's first syntax error.
func (f *parsedFile) complete(node ast.Node) bool {
	return f.offset(node.End()) <= f.errorOffset
}

// isTest reports whether the file is a _test.go file.
func (f *parsedFile) isTest() bool {
	return strings.HasSuffix(f.path, "_test.go")
}

// declExtent returns the byte range of a top-level declaration with its doc
// comment. For a parenthesized type declaration, spec selects one type spec
// and the range is that spec with its own doc comment.
func (f *parsedFile) declExtent(decl ast.Decl, spec string) (int, int) {
	switch d := decl.(type) {
	case *ast.FuncDecl:
		start := d.Pos()
		if d.Doc != nil {
			start = d.Doc.Pos()
		}
		return f.offset(start), f.offset(d.End())
	case *ast.GenDecl:
		if spec != "" && d.Lparen.IsValid() {
			for _, s := range d.Specs {
				if ts, ok := s.(*ast.TypeSpec); ok && ts.Name.Name == spec {
					start := ts.Pos()
					if ts.Doc != nil {
						start = ts.Doc.Pos()
					}
					return f.offset(start), f.offset(ts.End())
				}
			}
		}
		start := d.Pos()
		if d.Doc != nil {
			start = d.Doc.Pos()
		}
		return f.offset(start), f.offset(d.End())
	}
	return f.offset(decl.Pos()), f.offset(decl.End())
}

// declSource returns the source of a declaration as declExtent bounds it.
func (f *parsedFile) declSource(index int, spec string) string {
	start, end := f.declExtent(f.syntax.Decls[index], spec)
	return string(f.src[start:end])
}

// importName returns the name under which the file imports the package at
// importPath, or "" if it does not import it.
func (f *parsedFile) importName(importPath string) string {
	for _, spec := range f.syntax.Imports {
		p, err := strconv.Unquote(spec.Path.Value)
		if err != nil || p != importPath {
			continue
		}
		if spec.Name != nil {
			return spec.Name.Name
		}
		return assumedName(p)
	}
	return ""
}

// assumedName is the package name an unaliased import of p binds: the
// standard library's own name, or else the last path element without a major
// version suffix.
func assumedName(p string) string {
	if name, ok := standardPackages[p]; ok {
		return name
	}
	base := path.Base(p)
	if len(base) > 1 && base[0] == 'v' && strings.Trim(base[1:], "0123456789") == "" {
		base = path.Base(path.Dir(p))
	}
	return base
}

// rule is one rule function in a rule file, with what the rewriter needs to
// edit it.
type rule struct {
	model    protocol.Rule
	file     *parsedFile
	decl     *ast.FuncDecl
	index    int // in file.syntax.Decls
	start    int // byte range of the doc comment and declaration
	end      int
	context  string // local name of the context package in this file
	problems []string
	// unnamedResults is set when the result list has unnamed results other than
	// error, which add_produce can name in one case.
	unnamedResults bool
}

// contract is the input or output struct as declared in the ruleset's files.
type contract struct {
	model  protocol.Contract
	file   *parsedFile // nil when the type is not declared in these files
	index  int
	spec   *ast.TypeSpec
	fields *ast.FieldList // nil when the type is not a struct
}

// ruleset is every file parsed, with the rules and contracts found in them.
type ruleset struct {
	config  Config
	files   map[string]*parsedFile // every non-generated file
	paths   []string               // keys of files, sorted
	pkgName string
	rules   []*rule
	inputs  *contract
	outputs *contract
}

// load parses every file and finds the rules and contracts.
func load(files Files, config Config) *ruleset {
	rs := &ruleset{config: config, files: make(map[string]*parsedFile)}
	for p, src := range files {
		f := parseFile(p, src)
		if f.generated {
			continue
		}
		rs.files[p] = f
		rs.paths = append(rs.paths, p)
	}
	slices.Sort(rs.paths)
	for _, p := range config.RuleFiles {
		f := rs.files[p]
		if f == nil || f.syntax == nil {
			continue
		}
		if rs.pkgName == "" {
			rs.pkgName = f.syntax.Name.Name
		}
		for i, decl := range f.syntax.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || !fn.Name.IsExported() || !f.complete(fn) {
				continue
			}
			rs.rules = append(rs.rules, newRule(f, i, fn))
		}
	}
	rs.inputs = rs.findContract(config.Inputs)
	rs.outputs = rs.findContract(config.Outputs)
	return rs
}

// newRule reads a rule's facts and shape from its declaration. The facts match
// what the generator derives from types: a context.Context parameter and error
// results are set aside, and unnamed or blank names are not facts.
func newRule(f *parsedFile, index int, fn *ast.FuncDecl) *rule {
	r := &rule{file: f, decl: fn, index: index, context: f.importName("context")}
	r.start, r.end = f.declExtent(fn, "")
	source := f.src[r.start:r.end]
	r.model = protocol.Rule{
		ID:          fn.Name.Name,
		File:        f.path,
		Line:        f.fset.Position(fn.Pos()).Line,
		Requirement: requirementText(fn.Doc),
		Source:      string(source),
		SourceHash:  protocol.Hash(source),
	}
	if fn.Type.TypeParams != nil && len(fn.Type.TypeParams.List) > 0 {
		r.problems = append(r.problems, "it has type parameters")
	}
	for i, field := range fn.Type.Params.List {
		switch {
		case r.isContext(field.Type):
			r.model.UsesContext = true
			if i != 0 || len(field.Names) > 1 {
				r.problems = append(r.problems, "context.Context is not its only first parameter")
			}
			continue
		case isError(field.Type):
			r.problems = append(r.problems, "a parameter has type error")
			continue
		case len(field.Names) == 0:
			r.problems = append(r.problems, "its parameters are unnamed")
			continue
		}
		if _, ok := field.Type.(*ast.Ellipsis); ok {
			r.problems = append(r.problems, "it is variadic")
		}
		for _, name := range field.Names {
			if name.Name == "_" {
				r.problems = append(r.problems, "a parameter is named _")
				continue
			}
			r.model.Reads = append(r.model.Reads, protocol.Fact{Name: name.Name, Type: f.text(field.Type)})
		}
	}
	if fn.Type.Results != nil {
		results := fn.Type.Results.List
		for i, field := range results {
			switch {
			case isError(field.Type):
				r.model.ReturnsError = true
				if i != len(results)-1 || len(field.Names) > 1 {
					r.problems = append(r.problems, "error is not its last result")
				}
				continue
			case r.isContext(field.Type):
				r.problems = append(r.problems, "a result has type context.Context")
				continue
			case len(field.Names) == 0:
				r.unnamedResults = true
				continue
			}
			for _, name := range field.Names {
				if name.Name == "_" {
					r.problems = append(r.problems, "a result is named _")
					continue
				}
				r.model.Produces = append(r.model.Produces, protocol.Fact{Name: name.Name, Type: f.text(field.Type)})
			}
		}
	}
	reasons := r.problems
	if r.unnamedResults {
		reasons = append(slices.Clone(reasons), "its results are unnamed")
	}
	if len(reasons) > 0 {
		r.model.Unsupported = "Structural edits are off for " + fn.Name.Name + " because " + strings.Join(reasons, ", and ") + "."
	}
	r.model.Stub = r.isStub()
	return r
}

// requirementText joins a doc comment into one paragraph.
func requirementText(doc *ast.CommentGroup) string {
	if doc == nil {
		return ""
	}
	return strings.Join(strings.Fields(doc.Text()), " ")
}

// isContext reports whether a type expression spells context.Context.
func (r *rule) isContext(expr ast.Expr) bool {
	selector, ok := expr.(*ast.SelectorExpr)
	if !ok || r.context == "" {
		return false
	}
	x, ok := selector.X.(*ast.Ident)
	return ok && x.Name == r.context && selector.Sel.Name == "Context"
}

// isError reports whether a type expression spells error.
func isError(expr ast.Expr) bool {
	ident, ok := expr.(*ast.Ident)
	return ok && ident.Name == "error"
}

// isStub reports whether the body is exactly the placeholder add_rule writes:
// a return of the named results and errors.New("<Name> is not implemented").
func (r *rule) isStub() bool {
	body := r.decl.Body
	if body == nil || len(body.List) != 1 || !r.model.ReturnsError || len(r.problems) > 0 || r.unnamedResults {
		return false
	}
	ret, ok := body.List[0].(*ast.ReturnStmt)
	if !ok || len(ret.Results) != len(r.model.Produces)+1 {
		return false
	}
	for i, produce := range r.model.Produces {
		ident, ok := ret.Results[i].(*ast.Ident)
		if !ok || ident.Name != produce.Name {
			return false
		}
	}
	call, ok := ret.Results[len(ret.Results)-1].(*ast.CallExpr)
	if !ok || len(call.Args) != 1 {
		return false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != "New" {
		return false
	}
	if x, ok := selector.X.(*ast.Ident); !ok || x.Name != r.file.importName("errors") {
		return false
	}
	lit, ok := call.Args[0].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return false
	}
	message, err := strconv.Unquote(lit.Value)
	return err == nil && message == stubMessage(r.model.ID)
}

// stubMessage is the error text of a stub rule's body.
func stubMessage(name string) string {
	return name + " is not implemented"
}

// findContract looks for the named struct type in the package's non-test
// files. A contract that is not declared there is returned not editable.
func (rs *ruleset) findContract(name string) *contract {
	c := &contract{model: protocol.Contract{Type: name}}
	for _, p := range rs.paths {
		f := rs.files[p]
		if f.syntax == nil || f.isTest() || (rs.pkgName != "" && f.syntax.Name.Name != rs.pkgName) {
			continue
		}
		for i, decl := range f.syntax.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.TYPE || !f.complete(gen) {
				continue
			}
			for _, s := range gen.Specs {
				spec := s.(*ast.TypeSpec)
				if spec.Name.Name != name {
					continue
				}
				c.file, c.index, c.spec = f, i, spec
				c.model.File = f.path
				if st, ok := spec.Type.(*ast.StructType); ok && spec.TypeParams == nil {
					c.fields = st.Fields
					c.model.Editable = true
					c.model.Fields = contractFields(f, st.Fields)
				}
				return c
			}
		}
	}
	return c
}

// contractFields lists the named fields of a struct with their fact names. An
// embedded field is not a fact and is left out.
func contractFields(f *parsedFile, fields *ast.FieldList) []protocol.ContractField {
	var out []protocol.ContractField
	for _, field := range fields.List {
		tag, hasTag := factTag(field)
		for _, name := range field.Names {
			fact := name.Name
			if hasTag {
				fact = tag
			}
			out = append(out, protocol.ContractField{
				Field: name.Name,
				Fact:  fact,
				Type:  f.text(field.Type),
				Line:  f.fset.Position(name.Pos()).Line,
			})
		}
	}
	return out
}

// factTag returns the fact tag of a struct field, if it has one.
func factTag(field *ast.Field) (string, bool) {
	if field.Tag == nil {
		return "", false
	}
	tag, err := strconv.Unquote(field.Tag.Value)
	if err != nil {
		return "", false
	}
	return reflect.StructTag(tag).Lookup("fact")
}

// model builds the protocol model: the rule files in configured order, then
// the files declaring the contracts.
func (rs *ruleset) model() protocol.Model {
	m := protocol.Model{Package: rs.pkgName, Inputs: rs.inputs.model, Outputs: rs.outputs.model}
	listed := make(map[string]bool)
	add := func(p string) {
		f := rs.files[p]
		if f == nil || listed[p] {
			return
		}
		listed[p] = true
		state := protocol.FileOK
		if f.problem != nil {
			state = protocol.FileSyntaxError
		}
		m.Files = append(m.Files, protocol.SourceFile{Path: p, Hash: protocol.Hash(f.src), State: state, Problem: f.problem})
	}
	for _, p := range rs.config.RuleFiles {
		add(p)
	}
	add(rs.inputs.model.File)
	add(rs.outputs.model.File)
	for _, r := range rs.rules {
		m.Rules = append(m.Rules, r.model)
	}
	return m
}
