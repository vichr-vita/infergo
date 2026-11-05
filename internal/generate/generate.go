// Package generate compiles named Go facts and rules into a typed evaluator.
package generate

import (
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

const runtimePath = "github.com/vichr-vita/infergo"

// maxErrors matches the Go compiler's default limit.
const maxErrors = 10

// Config selects rule source files and the input/output struct types in one
// package. OutputFile is ignored during loading so stale code can be regenerated.
type Config struct {
	Dir        string
	RuleFiles  []string
	Inputs     string
	Outputs    string
	OutputFile string
}

// Result is a successful generation. Generate writes nothing, so the caller
// decides what to do with Source and how to present Notes.
type Result struct {
	Source  []byte
	Package string // Import path of the ruleset package.
	Rules   int    // Rules retained in Source.
	Notes   []Note // Warnings in source order.
}

// Note is a diagnostic. Position is relative to Config.Dir and is invalid for
// a problem that has no source location.
type Note struct {
	Position token.Position
	Message  string
}

func (n Note) String() string {
	if !n.Position.IsValid() {
		return n.Message
	}
	return n.Position.String() + ": " + n.Message
}

type fact struct {
	name     string
	typ      types.Type
	pos      token.Pos
	producer int // -1 means an external input.
	field    string
	// uncertain marks a fact whose declaration was rejected. Its name counts as
	// known, but its type and edges are not trusted, which avoids follow-on errors.
	uncertain bool
}

type field struct {
	name string
	fact fact
	// local reports that the field is declared in the ruleset package, so its
	// type can be spelled there. Fields of another package's struct may not be.
	local bool
}

type rule struct {
	name         string
	pos          token.Pos
	inputs       []fact
	outputs      []fact
	dependencies []int
	withContext  bool
	withError    bool
	requirement  string
	source       string
}

type compiler struct {
	pkg     *packages.Package
	dir     string
	facts   map[string]fact
	rules   []rule
	inputs  []field
	outputs []field
	errors  []Note
	// unnamed holds the types of facts declared without a usable name. A missing
	// fact of one of these types may be that declaration, so it is not reported.
	unnamed []types.Type
	// inputsUnknown is set when the input contract is unusable, which leaves
	// every input fact undeclared.
	inputsUnknown bool
}

// Generate returns formatted Go source without writing files. It validates all
// selected rules, then emits only ancestors of the requested output facts.
// Declaration and graph errors are collected and returned together in source
// order. The returned error unwraps to one error per line of the report.
func Generate(config Config) (Result, error) {
	if config.Inputs == "" || config.Outputs == "" || len(config.RuleFiles) == 0 || config.OutputFile == "" {
		return Result{}, fmt.Errorf("inputs, outputs, rule files, and output file are required")
	}
	dir, err := filepath.Abs(config.Dir)
	if err != nil {
		return Result{}, err
	}
	absolute := func(name string) string {
		if !filepath.IsAbs(name) {
			name = filepath.Join(dir, name)
		}
		return filepath.Clean(name)
	}
	output := absolute(config.OutputFile)
	if filepath.Dir(output) != dir || filepath.Ext(output) != ".go" || strings.HasSuffix(output, "_test.go") {
		return Result{}, fmt.Errorf("output must be a non-test .go file in the ruleset directory")
	}
	selected := make(map[string]bool, len(config.RuleFiles))
	for _, name := range config.RuleFiles {
		path := absolute(name)
		if filepath.Dir(path) != dir || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") || path == output {
			return Result{}, fmt.Errorf("rule file %q must be a non-test .go file in the ruleset directory, separate from output", name)
		}
		if selected[path] {
			return Result{}, fmt.Errorf("rule file %q is selected twice", name)
		}
		selected[path] = true
	}
	packageClause, err := parser.ParseFile(token.NewFileSet(), absolute(config.RuleFiles[0]), nil, parser.PackageClauseOnly)
	if err != nil {
		return Result{}, fmt.Errorf("read ruleset package: %w", err)
	}
	c := &compiler{dir: dir, facts: make(map[string]fact)}
	if err := c.load(config, output, packageClause.Name.Name); err != nil {
		return Result{}, err
	}
	inputs, ok := c.fields(config.Inputs)
	c.inputsUnknown = !ok
	for _, input := range inputs {
		f := input.fact
		if f.name == "" {
			c.unnamed = append(c.unnamed, f.typ)
			continue
		}
		f.producer, f.field = -1, input.name
		c.facts[f.name] = f
		c.inputs = append(c.inputs, input)
	}
	c.outputs, _ = c.fields(config.Outputs)
	files := make(map[string]*ast.File)
	for _, file := range c.pkg.Syntax {
		files[filepath.Clean(c.pkg.Fset.Position(file.Pos()).Filename)] = file
	}
	paths := make([]string, 0, len(selected))
	for path := range selected {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	for _, path := range paths {
		file, ok := files[path]
		if !ok {
			return Result{}, fmt.Errorf("rule file %q is missing or excluded by build constraints", c.relative(path))
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return Result{}, fmt.Errorf("read rule source: %w", err)
		}
		for _, declaration := range file.Decls {
			fn, ok := declaration.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || !fn.Name.IsExported() {
				continue
			}
			c.addRule(c.pkg.TypesInfo.Defs[fn.Name].(*types.Func))
			start, end := c.pkg.Fset.Position(fn.Pos()).Offset, c.pkg.Fset.Position(fn.End()).Offset
			r := &c.rules[len(c.rules)-1]
			r.source = stripCarriageReturns(string(raw[start:end]))
			r.requirement = stripCarriageReturns(strings.TrimSpace(fn.Doc.Text()))
		}
	}
	c.validate()
	if err := c.failure(); err != nil {
		return Result{}, err
	}
	ids := c.retainedRules()
	source, err := c.emit(config, ids)
	if err != nil {
		return Result{}, err
	}
	return Result{Source: source, Package: c.pkg.PkgPath, Rules: len(ids), Notes: c.unusedDeclarations(ids)}, nil
}

// stripCarriageReturns keeps embedded text independent of the file's line
// endings, so a CRLF checkout generates the same bytes as an LF one.
func stripCarriageReturns(text string) string {
	return strings.ReplaceAll(text, "\r", "")
}

// load type-checks the ruleset with the configured generated file replaced, so
// absent or stale output cannot affect it. A package that compiles without the
// generated API needs nothing else. Otherwise it may refer to that API from a
// non-test file, so a second load declares stubs for it. The partial first load
// has already caught whatever would turn the stubs into confusing errors.
func (c *compiler) load(config Config, output, packageName string) error {
	pkg, err := loadPackage(c.dir, output, []byte("package "+packageName+"\n"))
	if err != nil {
		return err
	}
	c.pkg = pkg
	if !recoverable(pkg) {
		return c.loadError()
	}
	if pkg.PkgPath == runtimePath {
		return fmt.Errorf("rules must be in a separate package from the infergo runtime")
	}
	for _, reserved := range []string{"Evaluate", "EvaluateTrace", "Ruleset", "ViewerCase", "ExportHTML", "_infergoPlan"} {
		if obj := pkg.Types.Scope().Lookup(reserved); obj != nil {
			c.errorf(obj.Pos(), "%s is reserved for generated code", reserved)
		}
	}
	if len(pkg.Errors) == 0 {
		return nil
	}
	c.contract(config.Inputs)
	c.contract(config.Outputs)
	if err := c.failure(); err != nil {
		return err
	}
	c.pkg, err = loadPackage(c.dir, output, apiStubs(pkg.Types.Scope(), packageName, config))
	if err != nil {
		return err
	}
	if len(c.pkg.Errors) != 0 {
		return c.loadError()
	}
	return nil
}

func loadPackage(dir, output string, overlay []byte) (*packages.Package, error) {
	// Overlay reaches both go list and the type checker. Stripping the AST alone
	// would still let stale generated code break go list's export-data build.
	pkgs, err := packages.Load(&packages.Config{
		Dir:     dir,
		Mode:    packages.LoadSyntax,
		Overlay: map[string][]byte{output: overlay},
	}, ".")
	if err != nil {
		return nil, fmt.Errorf("load ruleset: %w", err)
	}
	if len(pkgs) != 1 {
		return nil, fmt.Errorf("expected one ruleset package, found %d", len(pkgs))
	}
	return pkgs[0], nil
}

// apiStubs declares the generated API with the signatures emit produces. The
// bodies use no identifiers, so package-level declarations cannot shadow them.
func apiStubs(scope *types.Scope, packageName string, config Config) []byte {
	fresh := nameAllocator(scope)
	contextAlias, runtimeAlias := fresh("_infergo_context"), fresh("_infergo_runtime")
	return fmt.Appendf(nil, `package %[1]s

import (
	%[2]s "context"
	%[3]s %[4]q
)

type ViewerCase = %[3]s.ViewerCase[%[5]s]

func Ruleset() %[3]s.Ruleset { for {} }
func ExportHTML(%[2]s.Context, string, []ViewerCase) (string, error) { for {} }
func EvaluateTrace(%[2]s.Context, %[5]s, %[3]s.Options) (%[6]s, %[3]s.Snapshot, error) { for {} }
func Evaluate(%[2]s.Context, %[5]s, %[3]s.Options) (%[6]s, error) { for {} }
`, packageName, contextAlias, runtimeAlias, runtimePath, config.Inputs, config.Outputs)
}

// recoverable reports whether the package parsed and go list accepted it, so
// that its scope is complete and stubs might resolve its errors. The compiler's
// own failure also arrives as a ListError, headed "# <package>", and stubs can
// help with that one. Any other ListError means the package never type-checked
// as a whole, so its scope cannot support contract diagnostics.
func recoverable(pkg *packages.Package) bool {
	return pkg.Types != nil && len(pkg.Syntax) != 0 && !slices.ContainsFunc(pkg.Errors, func(err packages.Error) bool {
		return err.Kind == packages.ParseError || err.Kind == packages.ListError && !strings.HasPrefix(err.Msg, "# ")
	})
}

func (c *compiler) loadError() error {
	messages := make([]string, len(c.pkg.Errors))
	for i, err := range c.pkg.Errors {
		messages[i] = c.relative(err.Error())
	}
	return fmt.Errorf("load ruleset:\n%s", strings.Join(messages, "\n"))
}

// relative strips the ruleset directory from every path in text. All paths the
// generator prints pass through here. Only a path that starts with the directory
// matches, so a longer path that merely contains it stays intact.
func (c *compiler) relative(text string) string {
	prefix := regexp.MustCompile("(^|[\\s\"'`(\\[:=,])" + regexp.QuoteMeta(c.dir+string(filepath.Separator)))
	return prefix.ReplaceAllString(text, "$1")
}

func (c *compiler) position(pos token.Pos) token.Position {
	position := c.pkg.Fset.Position(pos)
	position.Filename = c.relative(position.Filename)
	return position
}

func (c *compiler) errorf(pos token.Pos, message string, args ...any) {
	c.errors = append(c.errors, Note{c.position(pos), fmt.Sprintf(message, args...)})
}

// failure joins the collected errors in source order, or returns nil if there
// are none. Errors without a position come first.
func (c *compiler) failure() error {
	sortNotes(c.errors)
	var failures []error
	for _, note := range c.errors[:min(len(c.errors), maxErrors)] {
		failures = append(failures, errors.New(note.String()))
	}
	if len(c.errors) > maxErrors {
		failures = append(failures, errors.New("too many errors"))
	}
	return errors.Join(failures...)
}

func sortNotes(notes []Note) {
	slices.SortStableFunc(notes, func(a, b Note) int {
		return cmp.Or(
			cmp.Compare(a.Position.Filename, b.Position.Filename),
			cmp.Compare(a.Position.Line, b.Position.Line),
			cmp.Compare(a.Position.Column, b.Position.Column),
		)
	})
}

// contract returns the named non-generic type, or reports why it cannot be used
// and returns nil.
func (c *compiler) contract(name string) *types.TypeName {
	obj, ok := c.pkg.Types.Scope().Lookup(name).(*types.TypeName)
	if !ok {
		c.errorf(token.NoPos, "%s must name a struct type in the ruleset package", name)
		return nil
	}
	if generic, ok := obj.Type().(interface{ TypeParams() *types.TypeParamList }); ok && generic.TypeParams().Len() != 0 {
		c.errorf(obj.Pos(), "%s must not be generic", name)
		return nil
	}
	return obj
}

// fields reads a contract's facts, returning false if the contract is unusable.
// A rejected field stays in the list as an uncertain fact, with an empty name if
// it has no valid fact name, so that its uses do not produce further errors.
func (c *compiler) fields(name string) ([]field, bool) {
	obj := c.contract(name)
	if obj == nil {
		return nil, false
	}
	structure, ok := obj.Type().Underlying().(*types.Struct)
	if !ok {
		c.errorf(obj.Pos(), "%s must be a struct", name)
		return nil, false
	}
	var fields []field
	seen := make(map[string]int)
	for i := 0; i < structure.NumFields(); i++ {
		f := structure.Field(i)
		rejected := false
		if !f.Exported() || f.Embedded() {
			c.errorf(f.Pos(), "%s fields must be exported and must not be embedded", name)
			rejected = true
		}
		factName := f.Name()
		if tag, ok := reflect.StructTag(structure.Tag(i)).Lookup("fact"); ok {
			factName = tag
		}
		if !token.IsIdentifier(factName) || factName == "_" {
			c.errorf(f.Pos(), "invalid fact name %q", factName)
			factName, rejected = "", true
		} else if first, exists := seen[factName]; exists {
			c.errorf(f.Pos(), "%s maps multiple fields to fact %q", name, factName)
			fields[first].fact.uncertain = true
			continue
		}
		if isError(f.Type()) || isContext(f.Type()) {
			c.errorf(f.Pos(), "fact %q cannot use the reserved error or context.Context types", factName)
			rejected = true
		}
		if factName != "" {
			seen[factName] = len(fields)
		}
		fields = append(fields, field{
			name:  f.Name(),
			fact:  fact{name: factName, typ: f.Type(), pos: f.Pos(), uncertain: rejected},
			local: f.Pkg() == c.pkg.Types,
		})
	}
	return fields, true
}

func allLocal(fields []field) bool {
	return !slices.ContainsFunc(fields, func(f field) bool { return !f.local })
}

func isError(t types.Type) bool {
	return types.Identical(t, types.Universe.Lookup("error").Type())
}

func isContext(t types.Type) bool {
	named, ok := types.Unalias(t).(*types.Named)
	return ok && named.Obj().Pkg() != nil && named.Obj().Pkg().Path() == "context" && named.Obj().Name() == "Context"
}

// addRule records a rule even when its signature is invalid, keeping the facts
// it declares known so that their consumers do not report them as missing.
func (c *compiler) addRule(fn *types.Func) {
	signature := fn.Type().(*types.Signature)
	r := rule{name: fn.Name(), pos: fn.Pos()}
	errorsBefore := len(c.errors)
	rejected := signature.Variadic() || signature.TypeParams().Len() != 0
	if rejected {
		c.errorf(fn.Pos(), "rule %s must not be variadic or generic", fn.Name())
	}
	for i := 0; i < signature.Params().Len() && !rejected; i++ {
		param := signature.Params().At(i)
		if isContext(param.Type()) {
			if i != 0 {
				c.errorf(param.Pos(), "rule %s must place context.Context first", r.name)
			}
			r.withContext = true
			continue
		}
		if param.Name() == "" || param.Name() == "_" || isError(param.Type()) {
			c.errorf(param.Pos(), "rule %s requires named, non-error input facts", r.name)
			continue
		}
		r.inputs = append(r.inputs, fact{name: param.Name(), typ: param.Type(), pos: param.Pos()})
	}
	for i := 0; i < signature.Results().Len(); i++ {
		result := signature.Results().At(i)
		if isError(result.Type()) {
			if i != signature.Results().Len()-1 {
				c.errorf(result.Pos(), "rule %s must place error last", r.name)
			}
			r.withError = true
			continue
		}
		if result.Name() == "" || result.Name() == "_" || isContext(result.Type()) {
			c.errorf(result.Pos(), "rule %s requires named output facts and reserves context.Context for its first input", r.name)
			c.unnamed = append(c.unnamed, result.Type())
			continue
		}
		f := fact{name: result.Name(), typ: result.Type(), pos: result.Pos(), producer: len(c.rules), uncertain: rejected}
		r.outputs = append(r.outputs, f)
		if previous, exists := c.facts[f.name]; exists {
			c.errorf(f.pos, "fact %q has multiple producers; first declared at %s", f.name, c.position(previous.pos))
			previous.uncertain = true
			c.facts[f.name] = previous
			continue
		}
		c.facts[f.name] = f
	}
	if len(r.outputs) == 0 && len(c.errors) == errorsBefore {
		c.errorf(fn.Pos(), "rule %s must produce at least one named fact", r.name)
	}
	c.rules = append(c.rules, r)
}

// resolve finds the declaration of a wanted fact and reports any mismatch. The
// result is false when the fact cannot be trusted as a graph edge.
func (c *compiler) resolve(want fact) (fact, bool) {
	f, exists := c.facts[want.name]
	if !exists {
		matchesUnnamed := slices.ContainsFunc(c.unnamed, func(t types.Type) bool { return types.Identical(t, want.typ) })
		if !c.inputsUnknown && !matchesUnnamed {
			c.errorf(want.pos, "no input or rule produces fact %q%s", want.name, c.suggestion(want.name))
		}
		return fact{}, false
	}
	if f.uncertain {
		return fact{}, false
	}
	if !types.Identical(f.typ, want.typ) {
		c.errorf(want.pos, "fact %q has type %s, expected %s; declared at %s", want.name, f.typ, want.typ, c.position(f.pos))
		return fact{}, false
	}
	return f, true
}

// suggestion returns a "did you mean" clause naming the known fact closest to
// name, or nothing if no fact is close enough. Comparison ignores case, so a
// case-only difference always wins. Ties go to the alphabetically first name.
func (c *compiler) suggestion(name string) string {
	best, bestDistance := "", 0
	for _, candidate := range sortedFactNames(c.facts) {
		distance := editDistance(strings.ToLower(name), strings.ToLower(candidate))
		// One edit in a three-letter name is close only if it is an insertion
		// or deletion: sed for seed, but not tax for tab.
		if distance*3 < max(len(name), len(candidate)) && (best == "" || distance < bestDistance) {
			best, bestDistance = candidate, distance
		}
	}
	if best == "" {
		return ""
	}
	return fmt.Sprintf("; did you mean %q?", best)
}

// editDistance counts the insertions, deletions, substitutions, and adjacent
// transpositions that turn a into b.
func editDistance(a, b string) int {
	distances := make([][]int, len(a)+1)
	for i := range distances {
		distances[i] = make([]int, len(b)+1)
		distances[i][0] = i
	}
	for j := range distances[0] {
		distances[0][j] = j
	}
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			substitution := 1
			if a[i-1] == b[j-1] {
				substitution = 0
			}
			distances[i][j] = min(distances[i-1][j]+1, distances[i][j-1]+1, distances[i-1][j-1]+substitution)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				distances[i][j] = min(distances[i][j], distances[i-2][j-2]+1)
			}
		}
	}
	return distances[len(a)][len(b)]
}

// validate resolves every rule input and output field, then reports cycles among
// the edges it could trust. Any cycle it finds is real, whatever else is wrong.
func (c *compiler) validate() {
	for id := range c.rules {
		r := &c.rules[id]
		for _, input := range r.inputs {
			f, ok := c.resolve(input)
			if ok && f.producer >= 0 && !slices.Contains(r.dependencies, f.producer) {
				r.dependencies = append(r.dependencies, f.producer)
			}
		}
		slices.Sort(r.dependencies)
	}
	for _, output := range c.outputs {
		if !output.fact.uncertain {
			c.resolve(output.fact)
		}
	}
	state := make([]uint8, len(c.rules))
	var stack []int
	var visit func(int)
	visit = func(id int) {
		if state[id] == 2 {
			return
		}
		if state[id] == 1 {
			var names []string
			for _, member := range append(slices.Clone(stack[slices.Index(stack, id):]), id) {
				names = append(names, c.rules[member].name)
			}
			c.errorf(c.rules[id].pos, "rule dependency cycle: %s", strings.Join(names, " -> "))
			return
		}
		state[id] = 1
		stack = append(stack, id)
		for _, dependency := range c.rules[id].dependencies {
			visit(dependency)
		}
		stack = stack[:len(stack)-1]
		state[id] = 2
	}
	for id := range c.rules {
		visit(id)
	}
}

// retainedRules returns the ancestors of the requested outputs in rule order.
func (c *compiler) retainedRules() []int {
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
	for id := range c.rules {
		if needed[id] {
			ids = append(ids, id)
		}
	}
	return ids
}

// unusedDeclarations warns about rules that pruning removed and inputs that
// neither a retained rule nor an output reads.
func (c *compiler) unusedDeclarations(ids []int) []Note {
	var notes []Note
	read := make(map[string]bool)
	for id, r := range c.rules {
		if !slices.Contains(ids, id) {
			notes = append(notes, Note{c.position(r.pos), fmt.Sprintf("rule %s is not needed by any output and was left out", r.name)})
			continue
		}
		for _, input := range r.inputs {
			read[input.name] = true
		}
	}
	for _, output := range c.outputs {
		read[output.fact.name] = true
	}
	for _, input := range c.inputs {
		if !read[input.fact.name] {
			notes = append(notes, Note{c.position(input.fact.pos), fmt.Sprintf("input fact %q is not used by any output or retained rule", input.fact.name)})
		}
	}
	sortNotes(notes)
	return notes
}

// nameAllocator returns a function that derives names unused in scope and by
// its own earlier results.
func nameAllocator(scope *types.Scope) func(string) string {
	used := make(map[string]bool)
	for _, name := range scope.Names() {
		used[name] = true
	}
	return func(base string) string {
		name := base
		for used[name] {
			name += "_"
		}
		used[name] = true
		return name
	}
}

func (c *compiler) emit(config Config, ids []int) ([]byte, error) {
	indices := make(map[int]int, len(ids))
	for index, id := range ids {
		indices[id] = index
	}
	fresh := nameAllocator(c.pkg.Types.Scope())
	contextAlias, runtimeAlias := fresh("_infergo_context"), fresh("_infergo_runtime")
	ctx, input, options := fresh("ctx"), fresh("input"), fresh("options")
	facts, errorName, ruleID := fresh("facts"), fresh("err"), fresh("ruleID")
	snapshot, callbackErr := fresh("snapshot"), fresh("ruleErr")
	evaluator := fresh("_infergoEvaluate")
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
	// Go types omit parameter names, so these guards detect only contract drift.
	// Struct conversion ignores tags, which leaves tag changes to check mode.
	// A contract with fields from another package gets no guard, because those
	// fields may use types this package cannot name. Check mode still covers it.
	emitGuard := func(contract string, fields []field) {
		if !allLocal(fields) {
			return
		}
		fmt.Fprintln(&body, "var _ = struct {")
		for _, f := range fields {
			fmt.Fprintf(&body, "%s %s\n", f.name, types.TypeString(f.fact.typ, qualifier))
		}
		// The compiler reports the closing line, so the advice belongs there.
		fmt.Fprintf(&body, "}(%s{}) // If this fails to compile, %s changed. Run go generate to update this file.\n\n", contract, contract)
	}
	emitGuard(config.Inputs, c.inputs)
	emitGuard(config.Outputs, c.outputs)
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
	// Metadata is emitted from the same retained rules and fact contracts as execution.
	emitFacts := func(specs []fact) {
		fmt.Fprintf(&body, "[]%s.FactSpec{", runtimeAlias)
		for _, f := range specs {
			fmt.Fprintf(&body, "{Name: %q, Type: %q},", f.name, types.TypeString(f.typ, func(pkg *types.Package) string { return pkg.Name() }))
		}
		fmt.Fprint(&body, "}")
	}
	fmt.Fprintln(&body, "\n// Ruleset returns fresh metadata for the generated evaluator.")
	fmt.Fprintf(&body, "func Ruleset() %s.Ruleset { return %s.Ruleset{Inputs:", runtimeAlias, runtimeAlias)
	var external []fact
	for _, name := range sortedFactNames(c.facts) {
		if f := c.facts[name]; f.producer < 0 {
			external = append(external, f)
		}
	}
	emitFacts(external)
	fmt.Fprint(&body, ", Outputs:")
	var requested []fact
	for _, output := range c.outputs {
		requested = append(requested, output.fact)
	}
	emitFacts(requested)
	fmt.Fprintf(&body, ", Rules: []%s.RuleSpec{", runtimeAlias)
	for _, id := range ids {
		r := c.rules[id]
		fmt.Fprintf(&body, "{ID: %q, Requirement: %q, Source: %q, Inputs:", r.name, r.requirement, r.source)
		emitFacts(r.inputs)
		fmt.Fprint(&body, ", Outputs:")
		emitFacts(r.outputs)
		fmt.Fprint(&body, "},")
	}
	fmt.Fprintln(&body, "}} }")
	fmt.Fprintln(&body, "\n// ViewerCase provides typed inputs for a saved HTML scenario.")
	fmt.Fprintf(&body, "type ViewerCase = %s.ViewerCase[%s]\n", runtimeAlias, config.Inputs)
	fmt.Fprintln(&body, "\n// ExportHTML evaluates scenarios once and exports an offline graph and inspector.")
	fmt.Fprintln(&body, "// Failed evaluations remain inspectable. An empty case list exports only topology.")
	fmt.Fprintf(&body, "func ExportHTML(ctx %s.Context, title string, cases []ViewerCase) (string, error) { return %s.ExportHTML(ctx, title, Ruleset(), cases, EvaluateTrace) }\n", contextAlias, runtimeAlias)
	fmt.Fprintln(&body, "\n// EvaluateTrace captures diagnostic values without changing result or error semantics.")
	fmt.Fprintf(&body, "func EvaluateTrace(%s %s.Context, %s %s, %s %s.Options) (%s, %s.Snapshot, error) {\n", ctx, contextAlias, input, config.Inputs, options, runtimeAlias, config.Outputs, runtimeAlias)
	fmt.Fprintf(&body, "%s := %s.Snapshot{Inputs: map[string]string{", snapshot, runtimeAlias)
	for _, f := range external {
		fmt.Fprintf(&body, "%q: %s.FormatValue(%s.%s),", f.name, runtimeAlias, input, f.field)
	}
	fmt.Fprintf(&body, "}, Trace: []%s.RuleTrace{", runtimeAlias)
	for _, id := range ids {
		fmt.Fprintf(&body, "{Rule:%q, Kind: \"not_run\", Facts: map[string]string{}},", c.rules[id].name)
	}
	fmt.Fprintln(&body, "}}")
	fmt.Fprintf(&body, "result, %s := %s(%s, %s, %s, &%s)\n", errorName, evaluator, ctx, input, options, snapshot)
	fmt.Fprintf(&body, "if %s != nil { %s.Error = %s.Error() }\nreturn result, %s, %s\n}\n", errorName, snapshot, errorName, snapshot, errorName)
	fmt.Fprintln(&body, "\n// Evaluate computes the requested output facts. Inputs and their referenced")
	fmt.Fprintln(&body, "// data must remain immutable until evaluation returns. Errors discard all outputs.")
	fmt.Fprintf(&body, "func Evaluate(%s %s.Context, %s %s, %s %s.Options) (%s, error) {\n", ctx, contextAlias, input, config.Inputs, options, runtimeAlias, config.Outputs)
	fmt.Fprintf(&body, "return %s(%s, %s, %s, nil)\n}\n", evaluator, ctx, input, options)
	fmt.Fprintf(&body, "func %s(%s %s.Context, %s %s, %s %s.Options, %s *%s.Snapshot) (%s, error) {\n", evaluator, ctx, contextAlias, input, config.Inputs, options, runtimeAlias, snapshot, runtimeAlias, config.Outputs)
	if len(ids) != 0 {
		fmt.Fprintf(&body, "var %s struct {\n", facts)
		for _, id := range ids {
			for _, f := range c.rules[id].outputs {
				fmt.Fprintf(&body, "%s %s\n", f.name, types.TypeString(f.typ, qualifier))
			}
		}
		fmt.Fprintln(&body, "}")
	}
	fmt.Fprintf(&body, "%s := _infergoPlan.Run(%s, %s, func(%s %s.Context, %s int) (%s error) {\n", errorName, ctx, options, ctx, contextAlias, ruleID, callbackErr)
	fmt.Fprintf(&body, "if %s != nil { defer func() { %s.Trace[%s].Complete(%s) }() }\nswitch %s {\n", snapshot, snapshot, ruleID, callbackErr, ruleID)
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
		fmt.Fprintf(&body, "if %s != nil { %s.Trace[%d].Facts = map[string]string{", snapshot, snapshot, indices[id])
		for i, f := range r.outputs {
			fmt.Fprintf(&body, "%q: %s.FormatValue(value%d),", f.name, runtimeAlias, i)
		}
		fmt.Fprintln(&body, "} }")
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

// Stable ordering keeps generated metadata reproducible.
func sortedFactNames(facts map[string]fact) []string {
	names := make([]string, 0, len(facts))
	for name := range facts {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}
