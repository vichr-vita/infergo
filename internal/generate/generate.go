// Package generate compiles named Go facts and rules into a typed evaluator.
package generate

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"go/types"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

const runtimePath = "github.com/vichr-vita/infergo"

// Config selects rule source files and the input/output struct types in one
// package. OutputFile is ignored during loading so stale code can be regenerated.
type Config struct {
	Dir        string
	RuleFiles  []string
	Inputs     string
	Outputs    string
	OutputFile string
}

type fact struct {
	name     string
	typ      types.Type
	pos      token.Pos
	producer int // -1 means an external input.
	field    string
}

type field struct {
	name string
	fact fact
}

type rule struct {
	name         string
	pos          token.Pos
	inputs       []fact
	outputs      []fact
	dependencies []int
	withContext  bool
	withError    bool
}

type compiler struct {
	pkg     *packages.Package
	facts   map[string]fact
	rules   []rule
	outputs []field
}

// Generate returns formatted Go source without writing files. It validates all
// selected rules, then emits only ancestors of the requested output facts.
func Generate(config Config) ([]byte, error) {
	if config.Inputs == "" || config.Outputs == "" || len(config.RuleFiles) == 0 || config.OutputFile == "" {
		return nil, fmt.Errorf("inputs, outputs, rule files, and output file are required")
	}
	dir, err := filepath.Abs(config.Dir)
	if err != nil {
		return nil, err
	}
	absolute := func(name string) string {
		if !filepath.IsAbs(name) {
			name = filepath.Join(dir, name)
		}
		return filepath.Clean(name)
	}
	output := absolute(config.OutputFile)
	if filepath.Dir(output) != dir || filepath.Ext(output) != ".go" || strings.HasSuffix(output, "_test.go") {
		return nil, fmt.Errorf("output must be a non-test .go file in the ruleset directory")
	}
	selected := make(map[string]bool, len(config.RuleFiles))
	for _, name := range config.RuleFiles {
		path := absolute(name)
		if filepath.Dir(path) != dir || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") || path == output {
			return nil, fmt.Errorf("rule file %q must be a non-test .go file in the ruleset directory, separate from output", name)
		}
		if selected[path] {
			return nil, fmt.Errorf("rule file %q is selected twice", name)
		}
		selected[path] = true
	}
	packageClause, err := parser.ParseFile(token.NewFileSet(), absolute(config.RuleFiles[0]), nil, parser.PackageClauseOnly)
	if err != nil {
		return nil, fmt.Errorf("read ruleset package: %w", err)
	}
	// Overlay reaches both go list and the type checker. Stripping the AST alone
	// would still let stale generated code break go list's export-data build.
	pkgs, err := packages.Load(&packages.Config{
		Dir:     dir,
		Mode:    packages.LoadSyntax,
		Overlay: map[string][]byte{output: []byte("package " + packageClause.Name.Name + "\n")},
	}, ".")
	if err != nil {
		return nil, fmt.Errorf("load ruleset: %w", err)
	}
	if len(pkgs) != 1 {
		return nil, fmt.Errorf("expected one ruleset package, found %d", len(pkgs))
	}
	pkg := pkgs[0]
	if len(pkg.Errors) != 0 {
		messages := make([]string, len(pkg.Errors))
		for i, err := range pkg.Errors {
			messages[i] = err.Error()
		}
		return nil, fmt.Errorf("load ruleset:\n%s", strings.Join(messages, "\n"))
	}
	if pkg.PkgPath == runtimePath {
		return nil, fmt.Errorf("rules must be in a separate package from the infergo runtime")
	}
	for _, reserved := range []string{"Evaluate", "_infergoPlan"} {
		if obj := pkg.Types.Scope().Lookup(reserved); obj != nil {
			return nil, fmt.Errorf("%s: %s is reserved for generated code", pkg.Fset.Position(obj.Pos()), reserved)
		}
	}
	c := &compiler{pkg: pkg, facts: make(map[string]fact)}
	inputs, err := c.fields(config.Inputs)
	if err != nil {
		return nil, err
	}
	for _, input := range inputs {
		f := input.fact
		f.producer, f.field = -1, input.name
		c.facts[f.name] = f
	}
	c.outputs, err = c.fields(config.Outputs)
	if err != nil {
		return nil, err
	}
	files := make(map[string]*ast.File)
	for _, file := range pkg.Syntax {
		files[filepath.Clean(pkg.Fset.Position(file.Pos()).Filename)] = file
	}
	paths := make([]string, 0, len(selected))
	for path := range selected {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	for _, path := range paths {
		file, ok := files[path]
		if !ok {
			return nil, fmt.Errorf("rule file %q is missing or excluded by build constraints", path)
		}
		for _, declaration := range file.Decls {
			fn, ok := declaration.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || !fn.Name.IsExported() {
				continue
			}
			if err := c.addRule(pkg.TypesInfo.Defs[fn.Name].(*types.Func)); err != nil {
				return nil, err
			}
		}
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return c.emit(config)
}

func (c *compiler) errorf(pos token.Pos, message string, args ...any) error {
	return fmt.Errorf("%s: %s", c.pkg.Fset.Position(pos), fmt.Sprintf(message, args...))
}

func (c *compiler) fields(name string) ([]field, error) {
	obj, ok := c.pkg.Types.Scope().Lookup(name).(*types.TypeName)
	if !ok {
		return nil, fmt.Errorf("%s must name a struct type in the ruleset package", name)
	}
	if generic, ok := obj.Type().(interface{ TypeParams() *types.TypeParamList }); ok && generic.TypeParams().Len() != 0 {
		return nil, c.errorf(obj.Pos(), "%s must not be generic", name)
	}
	structure, ok := obj.Type().Underlying().(*types.Struct)
	if !ok {
		return nil, c.errorf(obj.Pos(), "%s must be a struct", name)
	}
	var fields []field
	seen := make(map[string]bool)
	for i := 0; i < structure.NumFields(); i++ {
		f := structure.Field(i)
		if !f.Exported() || f.Embedded() {
			return nil, c.errorf(f.Pos(), "%s fields must be exported and must not be embedded", name)
		}
		factName := f.Name()
		if tag, ok := reflect.StructTag(structure.Tag(i)).Lookup("fact"); ok {
			factName = tag
		}
		if !token.IsIdentifier(factName) || factName == "_" {
			return nil, c.errorf(f.Pos(), "invalid fact name %q", factName)
		}
		if seen[factName] {
			return nil, c.errorf(f.Pos(), "%s maps multiple fields to fact %q", name, factName)
		}
		if isError(f.Type()) || isContext(f.Type()) {
			return nil, c.errorf(f.Pos(), "fact %q cannot use the reserved error or context.Context types", factName)
		}
		seen[factName] = true
		fields = append(fields, field{name: f.Name(), fact: fact{name: factName, typ: f.Type(), pos: f.Pos()}})
	}
	return fields, nil
}

func isError(t types.Type) bool {
	return types.Identical(t, types.Universe.Lookup("error").Type())
}

func isContext(t types.Type) bool {
	named, ok := types.Unalias(t).(*types.Named)
	return ok && named.Obj().Pkg() != nil && named.Obj().Pkg().Path() == "context" && named.Obj().Name() == "Context"
}

func (c *compiler) addRule(fn *types.Func) error {
	signature := fn.Type().(*types.Signature)
	if signature.Variadic() || signature.TypeParams().Len() != 0 {
		return c.errorf(fn.Pos(), "rule %s must not be variadic or generic", fn.Name())
	}
	r := rule{name: fn.Name(), pos: fn.Pos()}
	for i := 0; i < signature.Params().Len(); i++ {
		param := signature.Params().At(i)
		if isContext(param.Type()) {
			if i != 0 {
				return c.errorf(param.Pos(), "rule %s must place context.Context first", r.name)
			}
			r.withContext = true
			continue
		}
		if param.Name() == "" || param.Name() == "_" || isError(param.Type()) {
			return c.errorf(param.Pos(), "rule %s requires named, non-error input facts", r.name)
		}
		r.inputs = append(r.inputs, fact{name: param.Name(), typ: param.Type(), pos: param.Pos()})
	}
	for i := 0; i < signature.Results().Len(); i++ {
		result := signature.Results().At(i)
		if isError(result.Type()) {
			if i != signature.Results().Len()-1 {
				return c.errorf(result.Pos(), "rule %s must place error last", r.name)
			}
			r.withError = true
			continue
		}
		if result.Name() == "" || result.Name() == "_" || isContext(result.Type()) {
			return c.errorf(result.Pos(), "rule %s requires named output facts and reserves context.Context for its first input", r.name)
		}
		f := fact{name: result.Name(), typ: result.Type(), pos: result.Pos(), producer: len(c.rules)}
		if previous, exists := c.facts[f.name]; exists {
			return c.errorf(f.pos, "fact %q has multiple producers; first declared at %s", f.name, c.pkg.Fset.Position(previous.pos))
		}
		c.facts[f.name] = f
		r.outputs = append(r.outputs, f)
	}
	if len(r.outputs) == 0 {
		return c.errorf(fn.Pos(), "rule %s must produce at least one named fact", r.name)
	}
	c.rules = append(c.rules, r)
	return nil
}

func (c *compiler) resolve(want fact) (fact, error) {
	f, exists := c.facts[want.name]
	if !exists {
		return fact{}, c.errorf(want.pos, "no input or rule produces fact %q", want.name)
	}
	if !types.Identical(f.typ, want.typ) {
		return fact{}, c.errorf(want.pos, "fact %q has type %s, expected %s; declared at %s", want.name, f.typ, want.typ, c.pkg.Fset.Position(f.pos))
	}
	return f, nil
}

func (c *compiler) validate() error {
	for id := range c.rules {
		r := &c.rules[id]
		for _, input := range r.inputs {
			f, err := c.resolve(input)
			if err != nil {
				return err
			}
			if f.producer >= 0 && !slices.Contains(r.dependencies, f.producer) {
				r.dependencies = append(r.dependencies, f.producer)
			}
		}
		slices.Sort(r.dependencies)
	}
	for _, output := range c.outputs {
		if _, err := c.resolve(output.fact); err != nil {
			return err
		}
	}
	state := make([]uint8, len(c.rules))
	var stack []int
	var visit func(int) error
	visit = func(id int) error {
		if state[id] == 2 {
			return nil
		}
		if state[id] == 1 {
			var names []string
			for _, member := range append(slices.Clone(stack[slices.Index(stack, id):]), id) {
				names = append(names, c.rules[member].name)
			}
			return c.errorf(c.rules[id].pos, "rule dependency cycle: %s", strings.Join(names, " -> "))
		}
		state[id] = 1
		stack = append(stack, id)
		for _, dependency := range c.rules[id].dependencies {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		state[id] = 2
		return nil
	}
	for id := range c.rules {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

func (c *compiler) emit(config Config) ([]byte, error) {
	needed := make(map[int]bool)
	var include func(int)
	include = func(id int) {
		if needed[id] {
			return
		}
		needed[id] = true
		for _, dependency := range c.rules[id].dependencies {
			include(dependency)
		}
	}
	for _, output := range c.outputs {
		if f := c.facts[output.fact.name]; f.producer >= 0 {
			include(f.producer)
		}
	}
	var ids []int
	indices := make(map[int]int, len(needed))
	for id := range c.rules {
		if needed[id] {
			indices[id] = len(ids)
			ids = append(ids, id)
		}
	}
	used := make(map[string]bool)
	for _, name := range c.pkg.Types.Scope().Names() {
		used[name] = true
	}
	fresh := func(base string) string {
		name := base
		for used[name] {
			name += "_"
		}
		used[name] = true
		return name
	}
	contextAlias, runtimeAlias := fresh("_infergo_context"), fresh("_infergo_runtime")
	ctx, input, options := fresh("ctx"), fresh("input"), fresh("options")
	facts, errorName, ruleID := fresh("facts"), fresh("err"), fresh("ruleID")
	expression := func(name string) string {
		f := c.facts[name]
		if f.producer < 0 {
			return input + "." + f.field
		}
		return facts + "." + name
	}
	imports := map[string]string{"context": contextAlias, runtimePath: runtimeAlias}
	qualifier := func(pkg *types.Package) string {
		if pkg == c.pkg.Types {
			return ""
		}
		if alias, exists := imports[pkg.Path()]; exists {
			return alias
		}
		alias := fresh("_infergo_pkg" + strconv.Itoa(len(imports)-2))
		imports[pkg.Path()] = alias
		return alias
	}
	var body bytes.Buffer
	fmt.Fprintf(&body, "var _infergoPlan = func() *%s.Plan {\n", runtimeAlias)
	fmt.Fprintf(&body, "plan, err := %s.NewPlan([]%s.Rule{\n", runtimeAlias, runtimeAlias)
	for _, id := range ids {
		r := c.rules[id]
		fmt.Fprintf(&body, "{Name: %q, DependsOn: []int{", r.name)
		for _, dependency := range r.dependencies {
			fmt.Fprintf(&body, "%d,", indices[dependency])
		}
		fmt.Fprintln(&body, "}},")
	}
	fmt.Fprintln(&body, "})\nif err != nil { panic(err) }\nreturn plan\n}()")
	fmt.Fprintln(&body, "\n// Evaluate computes the requested output facts. Inputs and their referenced")
	fmt.Fprintln(&body, "// data must remain immutable until evaluation returns. Errors discard all outputs.")
	fmt.Fprintf(&body, "func Evaluate(%s %s.Context, %s %s, %s %s.Options) (%s, error) {\n", ctx, contextAlias, input, config.Inputs, options, runtimeAlias, config.Outputs)
	if len(ids) != 0 {
		fmt.Fprintf(&body, "var %s struct {\n", facts)
		for _, id := range ids {
			for _, f := range c.rules[id].outputs {
				fmt.Fprintf(&body, "%s %s\n", f.name, types.TypeString(f.typ, qualifier))
			}
		}
		fmt.Fprintln(&body, "}")
	}
	fmt.Fprintf(&body, "%s := _infergoPlan.Run(%s, %s, func(%s %s.Context, %s int) error {\nswitch %s {\n", errorName, ctx, options, ctx, contextAlias, ruleID, ruleID)
	for _, id := range ids {
		r := c.rules[id]
		fmt.Fprintf(&body, "case %d:\n", indices[id])
		var results, args []string
		for i := range r.outputs {
			results = append(results, fmt.Sprintf("value%d", i))
		}
		if r.withError {
			results = append(results, errorName)
		}
		if r.withContext {
			args = append(args, ctx)
		}
		for _, input := range r.inputs {
			args = append(args, expression(input.name))
		}
		fmt.Fprintf(&body, "%s := %s(%s)\n", strings.Join(results, ", "), r.name, strings.Join(args, ", "))
		if r.withError {
			fmt.Fprintf(&body, "if %s != nil { return %s }\n", errorName, errorName)
		}
		for i, f := range r.outputs {
			fmt.Fprintf(&body, "%s.%s = value%d\n", facts, f.name, i)
		}
		fmt.Fprintln(&body, "return nil")
	}
	fmt.Fprintln(&body, "default: panic(\"infergo: invalid rule ID\")\n}\n})")
	fmt.Fprintf(&body, "if %s != nil { return %s{}, %s }\nreturn %s{\n", errorName, config.Outputs, errorName, config.Outputs)
	for _, output := range c.outputs {
		fmt.Fprintf(&body, "%s: %s,\n", output.name, expression(output.fact.name))
	}
	fmt.Fprintln(&body, "}, nil\n}")
	var source bytes.Buffer
	fmt.Fprintf(&source, "// Code generated by infergen; DO NOT EDIT.\n\npackage %s\n\nimport (\n", c.pkg.Name)
	paths := make([]string, 0, len(imports))
	for path := range imports {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	for _, path := range paths {
		fmt.Fprintf(&source, "%s %q\n", imports[path], path)
	}
	fmt.Fprintln(&source, ")")
	source.Write(body.Bytes())
	formatted, err := format.Source(source.Bytes())
	if err != nil {
		return nil, fmt.Errorf("format generated code: %w", err)
	}
	return formatted, nil
}
