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

	"github.com/vichr-vita/infergo"
	"golang.org/x/tools/go/packages"
)

const runtimePath = "github.com/vichr-vita/infergo"

const runtimeUnavailable = "generated code imports " + runtimePath + ", which this module cannot load; " +
	"require it in go.mod and, if the module has a vendor directory, vendor it"

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
	Source      []byte
	Ruleset     infergo.Ruleset // The value that Source's Ruleset function returns.
	Package     string          // Import path of the ruleset package.
	PackageName string          // Name in the ruleset's package clause.
	Rules       int             // Rules retained in Source.
	Notes       []Note          // Warnings in source order.
}

// Note is a diagnostic. Position is relative to Config.Dir for a file inside it.
// A file elsewhere, such as a contract field declared in another package, keeps
// its absolute path. Position is invalid for a problem with no source location.
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

// Severity values of a Diagnostic.
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// Kind values of a Diagnostic. Each finding the compiler can report has exactly
// one, so a caller can attach a repair by kind.
const (
	// KindMissingProducer: a rule or output reads a fact that no input or rule produces.
	KindMissingProducer = "missing_producer"
	// KindTypeMismatch: a reader's type differs from the type its producer declares.
	KindTypeMismatch = "type_mismatch"
	// KindDuplicateProducer: a fact has more than one producer, input or rule.
	KindDuplicateProducer = "duplicate_producer"
	// KindCycle: rules depend on each other in a loop.
	KindCycle = "cycle"
	// KindSignature: a rule function has an unsupported shape.
	KindSignature = "signature"
	// KindContract: the Inputs or Outputs struct cannot serve as a contract.
	KindContract = "contract"
	// KindReserved: the package declares a name that generated code needs.
	KindReserved = "reserved"
	// KindGo: the Go compiler or parser rejected the package.
	KindGo = "go"
	// KindUnusedRule: warning for a rule that no requested output needs.
	KindUnusedRule = "unused_rule"
	// KindUnusedInput: warning for an input that nothing reads.
	KindUnusedInput = "unused_input"
)

// Diagnostic is one finding as data, for tools that draw it on the thing it is
// about. Position is relative to Config.Dir for a file inside it and is invalid
// when the finding has no source location. Its Offset is set only where the
// compiler knows it, which excludes kind go. Message is complete without the
// position, including any suggestion. Rule and Fact name the rule and fact the
// finding is about, when it is about one. Related carries the other rules
// involved: for a cycle, every rule on it in dependency order, each depending on
// the next and the last on the first; for a duplicate producer, the first
// producer when it is a rule; for a type mismatch, the producer when it is a
// rule. Suggestion is the closest known fact for a missing producer.
type Diagnostic struct {
	Severity   string // SeverityError or SeverityWarning.
	Kind       string // One of the Kind constants.
	Position   token.Position
	Message    string
	Rule, Fact string
	Related    []string
	Suggestion string
}

// note is the Diagnostic as Generate prints it.
func (d Diagnostic) note() Note { return Note{d.Position, d.Message} }

// Report is what Check found. Diagnostics holds every error, or, when there is
// none, the warnings. Result is nil when any diagnostic is an error. Pruned names
// the rules that no requested output needs, in source order, and is set only when
// Result is, because pruning is meaningful only for a valid graph.
type Report struct {
	Diagnostics []Diagnostic
	Result      *Result
	Pruned      []string
	// failure is the error Generate returns for the errors in Diagnostics.
	failure error
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
	errors  []Diagnostic
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
// order, each naming the package. A rejected declaration can hide a related
// error until it is fixed, so a report is not always complete, but generation
// fails either way. The returned error unwraps to one error per report entry.
// It prints the diagnostics Check returns, so the two cannot disagree.
func Generate(config Config) (Result, error) {
	report, err := Check(config)
	if err != nil {
		return Result{}, err
	}
	if report.failure != nil {
		return Result{}, report.failure
	}
	return *report.Result, nil
}

// Check compiles the ruleset like Generate, but returns every finding as data
// instead of one joined error. Errors come back as diagnostics of severity
// "error" and Result is nil. A clean ruleset returns a Result, with the unused
// rules and inputs as warnings and the names of the pruned rules in Pruned.
//
// The returned error is for a ruleset about which nothing can be said: an
// invalid config, a directory that is not a loadable Go package (no buildable
// files, mixed package clauses, an unusable module), rules that sit in the
// infergo runtime package, a rule file the package does not contain, or a
// failure to emit source. Everything the compiler can attribute to the code,
// including syntax and type errors with a position, is a diagnostic. Like
// Generate, Check can stop early, so a rejected contract can hide errors that
// would follow it.
func Check(config Config) (Report, error) {
	if config.Inputs == "" || config.Outputs == "" || len(config.RuleFiles) == 0 || config.OutputFile == "" {
		return Report{}, fmt.Errorf("inputs, outputs, rule files, and output file are required")
	}
	dir, err := filepath.Abs(config.Dir)
	if err != nil {
		return Report{}, err
	}
	absolute := func(name string) string {
		if !filepath.IsAbs(name) {
			name = filepath.Join(dir, name)
		}
		return filepath.Clean(name)
	}
	output := absolute(config.OutputFile)
	if filepath.Dir(output) != dir || filepath.Ext(output) != ".go" || strings.HasSuffix(output, "_test.go") {
		return Report{}, fmt.Errorf("output must be a non-test .go file in the ruleset directory")
	}
	selected := make(map[string]bool, len(config.RuleFiles))
	for _, name := range config.RuleFiles {
		path := absolute(name)
		if filepath.Dir(path) != dir || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") || path == output {
			return Report{}, fmt.Errorf("rule file %q must be a non-test .go file in the ruleset directory, separate from output", name)
		}
		if selected[path] {
			return Report{}, fmt.Errorf("rule file %q is selected twice", name)
		}
		selected[path] = true
	}
	packageClause, err := parser.ParseFile(token.NewFileSet(), absolute(config.RuleFiles[0]), nil, parser.PackageClauseOnly)
	if err != nil {
		return Report{}, fmt.Errorf("read ruleset package: %w", err)
	}
	c := &compiler{dir: dir, facts: make(map[string]fact)}
	return c.check(config, output, selected, packageClause.Name.Name)
}

// stop is a finding that ends analysis early: the diagnostics for the caller
// and the error Generate returns for them, which is the joined text of the
// errors as they are printed.
type stop struct {
	diagnostics []Diagnostic
	failure     error
}

// check is the single compile path behind Generate and Check, after the config
// has been validated. It returns the report, whose failure field holds what
// Generate returns when the report has errors. The error is for a ruleset that
// cannot be analyzed at all.
func (c *compiler) check(config Config, output string, selected map[string]bool, packageName string) (Report, error) {
	stopped, err := c.load(config, output, packageName)
	if err != nil {
		return Report{}, err
	}
	if stopped != nil {
		return Report{Diagnostics: stopped.diagnostics, failure: stopped.failure}, nil
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
			return Report{}, c.packageError(fmt.Sprintf("rule file %q is missing or excluded by build constraints", c.relative(path)))
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return Report{}, fmt.Errorf("read rule source: %w", err)
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
	if stopped := c.errorStop(); stopped != nil {
		return Report{Diagnostics: stopped.diagnostics, failure: stopped.failure}, nil
	}
	ids := c.retainedRules()
	ruleset := c.ruleset(ids)
	source, err := c.emit(config, ids, ruleset)
	if err != nil {
		return Report{}, err
	}
	warnings, pruned := c.unusedDeclarations(ids)
	var notes []Note
	for _, warning := range warnings {
		notes = append(notes, warning.note())
	}
	result := &Result{
		Source: source, Ruleset: ruleset, Package: c.pkg.PkgPath, PackageName: c.pkg.Name,
		Rules: len(ids), Notes: notes,
	}
	return Report{Diagnostics: warnings, Result: result, Pruned: pruned}, nil
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
// has already caught the contract and naming problems that would otherwise show
// up as confusing errors in the stubs.
func (c *compiler) load(config Config, output, packageName string) (*stop, error) {
	pkg, err := loadPackage(c.dir, output, []byte("package "+packageName+"\n"))
	if err != nil {
		return nil, err
	}
	c.pkg = pkg
	if !recoverable(pkg) {
		return c.loadStop()
	}
	if pkg.PkgPath == runtimePath {
		return nil, fmt.Errorf("rules must be in a separate package from the infergo runtime")
	}
	for _, reserved := range []string{"Evaluate", "EvaluateTrace", "Ruleset", "ViewerCase", "ExportHTML", "_infergoPlan"} {
		if obj := pkg.Types.Scope().Lookup(reserved); obj != nil {
			c.errorf(Diagnostic{Kind: KindReserved}, obj.Pos(), "%s is reserved for generated code", reserved)
		}
	}
	if len(pkg.Errors) == 0 {
		return nil, nil
	}
	c.contract(config.Inputs)
	c.contract(config.Outputs)
	if stopped := c.errorStop(); stopped != nil {
		return stopped, nil
	}
	stubbed, err := loadPackage(c.dir, output, apiStubs(pkg.Types.Scope(), packageName, config))
	if err != nil {
		return nil, err
	}
	// An error inside the stubs would point at a file the reader cannot open. They
	// import only the runtime and the standard library, and the contracts passed
	// above, so such an error means the module can't load the runtime. The first
	// load's errors, still in c.pkg, show what that leaves unresolved.
	if slices.ContainsFunc(stubbed.Errors, func(err packages.Error) bool { return strings.HasPrefix(err.Pos, output+":") }) {
		return nil, errors.Join(slices.Insert(c.loadFailures(), 0, c.packageError("load ruleset: "+runtimeUnavailable))...)
	}
	c.pkg = stubbed
	if len(c.pkg.Errors) != 0 {
		return c.loadStop()
	}
	return nil, nil
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

// loadFailures returns one error per package load error. A compiler block keeps
// its own "# <package>" heading in place of the package prefix.
func (c *compiler) loadFailures() []error {
	failures := make([]error, len(c.pkg.Errors))
	for i, err := range c.pkg.Errors {
		message := err.Msg
		if err.Pos != "" {
			message = err.Error()
		}
		message = c.relative(message)
		if strings.HasPrefix(message, "# "+c.pkg.PkgPath+"\n") {
			failures[i] = errors.New("load ruleset:\n" + message)
		} else {
			failures[i] = c.packageError("load ruleset: " + message)
		}
	}
	return failures
}

// loadStop turns the package's load errors into the end of analysis. Errors
// with a source position, which are syntax and type errors, become diagnostics of
// kind go. An error without one means the directory is not a package that can be
// analyzed, such as mixed package clauses or no buildable files, so it comes back
// as an error. Either way Generate prints the same text.
func (c *compiler) loadStop() (*stop, error) {
	if len(c.pkg.Errors) == 0 {
		return nil, c.packageError("load ruleset: package has no type information")
	}
	failure := errors.Join(c.loadFailures()...)
	var diagnostics []Diagnostic
	positioned := false
	for _, err := range c.pkg.Errors {
		position := c.positionOf(err)
		switch {
		case position.IsValid():
			positioned = true
			diagnostics = append(diagnostics, Diagnostic{Severity: SeverityError, Kind: KindGo, Position: position, Message: c.relative(err.Msg)})
		case c.isCompilerHeading(err):
			// The heading repeats the compiler's output, which the type errors
			// already carry, so it is a diagnostic only when nothing else is.
			diagnostics = append(diagnostics, Diagnostic{Severity: SeverityError, Kind: KindGo, Message: c.relative(err.Msg)})
		default:
			return nil, failure
		}
	}
	if positioned {
		diagnostics = slices.DeleteFunc(diagnostics, func(d Diagnostic) bool { return !d.Position.IsValid() })
	}
	sortDiagnostics(diagnostics)
	return &stop{diagnostics, failure}, nil
}

// isCompilerHeading reports whether err is the "# <package>" block holding the
// compiler's own output.
func (c *compiler) isCompilerHeading(err packages.Error) bool {
	return err.Pos == "" && strings.HasPrefix(err.Msg, "# "+c.pkg.PkgPath+"\n")
}

var positionPattern = regexp.MustCompile(`^(.+?):(\d+)(?::(\d+))?$`)

// positionOf reads the "file:line:column" position of a load error, relative
// to the ruleset directory. It is invalid when the error has none.
func (c *compiler) positionOf(err packages.Error) token.Position {
	match := positionPattern.FindStringSubmatch(err.Pos)
	if match == nil {
		return token.Position{}
	}
	line, _ := strconv.Atoi(match[2])
	column, _ := strconv.Atoi(match[3])
	return token.Position{Filename: c.relative(match[1]), Line: line, Column: column}
}

// packageError names the ruleset package in a diagnostic. Positions are relative
// to the package directory, and go generate ./... runs many packages in one
// stream, so a position alone does not identify the file.
func (c *compiler) packageError(message string) error {
	return errors.New(c.pkg.PkgPath + ": " + message)
}

// relative strips the ruleset directory from paths in text that lie inside it.
// Positions and load errors pass through here. A path outside the directory
// stays absolute, as does the directory itself. Only a path that starts with the
// directory matches, so a longer path that merely contains it stays intact.
func (c *compiler) relative(text string) string {
	prefix := regexp.MustCompile("(^|[\\s\"'`(\\[:=,])" + regexp.QuoteMeta(c.dir+string(filepath.Separator)))
	return prefix.ReplaceAllString(text, "$1")
}

func (c *compiler) position(pos token.Pos) token.Position {
	position := c.pkg.Fset.Position(pos)
	position.Filename = c.relative(position.Filename)
	return position
}

// errorf records an error. The caller sets the kind and whichever of Rule, Fact,
// Related, and Suggestion apply in d. A zero pos leaves the position invalid.
func (c *compiler) errorf(d Diagnostic, pos token.Pos, format string, args ...any) {
	d.Severity, d.Position, d.Message = SeverityError, c.position(pos), fmt.Sprintf(format, args...)
	c.errors = append(c.errors, d)
}

// errorStop ends analysis if errors were recorded. It returns every one of them in
// source order, with errors without a position first, and the error Generate
// returns, which is limited like the Go compiler's output.
func (c *compiler) errorStop() *stop {
	if len(c.errors) == 0 {
		return nil
	}
	sortDiagnostics(c.errors)
	var failures []error
	for _, d := range c.errors[:min(len(c.errors), maxErrors)] {
		failures = append(failures, c.packageError(d.note().String()))
	}
	if len(c.errors) > maxErrors {
		failures = append(failures, c.packageError("too many errors"))
	}
	return &stop{c.errors, errors.Join(failures...)}
}

func sortDiagnostics(diagnostics []Diagnostic) {
	slices.SortStableFunc(diagnostics, func(a, b Diagnostic) int {
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
		c.errorf(Diagnostic{Kind: KindContract}, token.NoPos, "%s must name a struct type in the ruleset package", name)
		return nil
	}
	if generic, ok := obj.Type().(interface{ TypeParams() *types.TypeParamList }); ok && generic.TypeParams().Len() != 0 {
		c.errorf(Diagnostic{Kind: KindContract}, obj.Pos(), "%s must not be generic", name)
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
		c.errorf(Diagnostic{Kind: KindContract}, obj.Pos(), "%s must be a struct", name)
		return nil, false
	}
	var fields []field
	seen := make(map[string]int)
	for i := 0; i < structure.NumFields(); i++ {
		f := structure.Field(i)
		rejected := false
		if !f.Exported() || f.Embedded() {
			c.errorf(Diagnostic{Kind: KindContract}, f.Pos(), "%s fields must be exported and must not be embedded", name)
			rejected = true
		}
		factName := f.Name()
		if tag, ok := reflect.StructTag(structure.Tag(i)).Lookup("fact"); ok {
			factName = tag
		}
		if !token.IsIdentifier(factName) || factName == "_" {
			c.errorf(Diagnostic{Kind: KindContract, Fact: factName}, f.Pos(), "invalid fact name %q", factName)
			factName, rejected = "", true
		} else if first, exists := seen[factName]; exists {
			c.errorf(Diagnostic{Kind: KindContract, Fact: factName}, f.Pos(), "%s maps multiple fields to fact %q", name, factName)
			fields[first].fact.uncertain = true
			continue
		}
		if factName != "" && (isError(f.Type()) || isContext(f.Type())) {
			c.errorf(Diagnostic{Kind: KindContract, Fact: factName}, f.Pos(), "fact %q cannot use the reserved error or context.Context types", factName)
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
		c.errorf(Diagnostic{Kind: KindSignature, Rule: r.name}, fn.Pos(), "rule %s must not be variadic or generic", fn.Name())
	}
	for i := 0; i < signature.Params().Len() && !rejected; i++ {
		param := signature.Params().At(i)
		if isContext(param.Type()) {
			if i != 0 {
				c.errorf(Diagnostic{Kind: KindSignature, Rule: r.name}, param.Pos(), "rule %s must place context.Context first", r.name)
			}
			r.withContext = true
			continue
		}
		if param.Name() == "" || param.Name() == "_" || isError(param.Type()) {
			c.errorf(Diagnostic{Kind: KindSignature, Rule: r.name}, param.Pos(), "rule %s requires named, non-error input facts", r.name)
			continue
		}
		r.inputs = append(r.inputs, fact{name: param.Name(), typ: param.Type(), pos: param.Pos()})
	}
	for i := 0; i < signature.Results().Len(); i++ {
		result := signature.Results().At(i)
		if isError(result.Type()) {
			if i != signature.Results().Len()-1 {
				c.errorf(Diagnostic{Kind: KindSignature, Rule: r.name}, result.Pos(), "rule %s must place error last", r.name)
			}
			r.withError = true
			continue
		}
		if result.Name() == "" || result.Name() == "_" || isContext(result.Type()) {
			c.errorf(Diagnostic{Kind: KindSignature, Rule: r.name}, result.Pos(), "rule %s requires named output facts and reserves context.Context for its first input", r.name)
			c.unnamed = append(c.unnamed, result.Type())
			continue
		}
		f := fact{name: result.Name(), typ: result.Type(), pos: result.Pos(), producer: len(c.rules), uncertain: rejected}
		r.outputs = append(r.outputs, f)
		if previous, exists := c.facts[f.name]; exists {
			duplicate := Diagnostic{Kind: KindDuplicateProducer, Rule: r.name, Fact: f.name}
			if previous.producer >= 0 {
				duplicate.Related = []string{c.rules[previous.producer].name}
			}
			c.errorf(duplicate, f.pos, "fact %q has multiple producers; first declared at %s", f.name, c.position(previous.pos))
			previous.uncertain = true
			c.facts[f.name] = previous
			continue
		}
		c.facts[f.name] = f
	}
	if len(r.outputs) == 0 && len(c.errors) == errorsBefore {
		c.errorf(Diagnostic{Kind: KindSignature, Rule: r.name}, fn.Pos(), "rule %s must produce at least one named fact", r.name)
	}
	c.rules = append(c.rules, r)
}

// resolve finds the declaration of a wanted fact and reports any mismatch. The
// result is false when the fact cannot be trusted as a graph edge. The reader is
// the rule that wants this fact, empty for an output field, and the signature
// holds that rule's facts.
func (c *compiler) resolve(want fact, reader string, signature []fact) (fact, bool) {
	f, exists := c.facts[want.name]
	if !exists {
		matchesUnnamed := slices.ContainsFunc(c.unnamed, func(t types.Type) bool { return types.Identical(t, want.typ) })
		if !c.inputsUnknown && !matchesUnnamed {
			suggestion := c.suggestion(want.name, signature)
			message := fmt.Sprintf("no input or rule produces fact %q", want.name)
			if suggestion != "" {
				message += fmt.Sprintf("; did you mean %q?", suggestion)
			}
			c.errorf(Diagnostic{Kind: KindMissingProducer, Rule: reader, Fact: want.name, Suggestion: suggestion}, want.pos, "%s", message)
		}
		return fact{}, false
	}
	if f.uncertain {
		return fact{}, false
	}
	if !types.Identical(f.typ, want.typ) {
		mismatch := Diagnostic{Kind: KindTypeMismatch, Rule: reader, Fact: want.name}
		if f.producer >= 0 {
			mismatch.Related = []string{c.rules[f.producer].name}
		}
		c.errorf(mismatch, want.pos, "fact %q has type %s, expected %s; declared at %s", want.name, f.typ, want.typ, c.position(f.pos))
		return fact{}, false
	}
	return f, true
}

// suggestion returns the known fact closest to name, or "" if no fact is close
// enough. Comparison ignores case, so a
// case-only difference always wins. Ties go to the alphabetically first name.
// Names already in the signature are skipped, because Go rejects a redeclaration.
func (c *compiler) suggestion(name string, signature []fact) string {
	best, bestDistance := "", 0
	for _, candidate := range sortedFactNames(c.facts) {
		if slices.ContainsFunc(signature, func(f fact) bool { return f.name == candidate }) {
			continue
		}
		distance := editDistance(strings.ToLower(name), strings.ToLower(candidate))
		// One edit in a three-letter name is close only if it is an insertion
		// or deletion: sed for seed, but not tax for tab.
		if distance*3 < max(len(name), len(candidate)) && (best == "" || distance < bestDistance) {
			best, bestDistance = candidate, distance
		}
	}
	return best
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
			f, ok := c.resolve(input, r.name, slices.Concat(r.inputs, r.outputs))
			if ok && f.producer >= 0 && !slices.Contains(r.dependencies, f.producer) {
				r.dependencies = append(r.dependencies, f.producer)
			}
		}
		slices.Sort(r.dependencies)
	}
	for _, output := range c.outputs {
		if !output.fact.uncertain {
			c.resolve(output.fact, "", nil)
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
			for _, member := range stack[slices.Index(stack, id):] {
				names = append(names, c.rules[member].name)
			}
			c.errorf(Diagnostic{Kind: KindCycle, Rule: c.rules[id].name, Related: names}, c.rules[id].pos,
				"rule dependency cycle: %s -> %s", strings.Join(names, " -> "), names[0])
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
// neither a retained rule nor an output reads. It also returns the pruned rules'
// names in source order.
func (c *compiler) unusedDeclarations(ids []int) (warnings []Diagnostic, pruned []string) {
	read := make(map[string]bool)
	for id, r := range c.rules {
		if !slices.Contains(ids, id) {
			pruned = append(pruned, r.name)
			warnings = append(warnings, Diagnostic{
				Severity: SeverityWarning, Kind: KindUnusedRule, Position: c.position(r.pos), Rule: r.name,
				Message: fmt.Sprintf("rule %s is not needed by any output and was left out", r.name),
			})
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
			warnings = append(warnings, Diagnostic{
				Severity: SeverityWarning, Kind: KindUnusedInput, Position: c.position(input.fact.pos), Fact: input.fact.name,
				Message: fmt.Sprintf("input fact %q is not used by any output or retained rule", input.fact.name),
			})
		}
	}
	sortDiagnostics(warnings)
	return warnings, pruned
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

// externalFacts returns the input facts in name order.
func (c *compiler) externalFacts() []fact {
	var external []fact
	for _, name := range sortedFactNames(c.facts) {
		if f := c.facts[name]; f.producer < 0 {
			external = append(external, f)
		}
	}
	return external
}

// factSpecs never returns nil, because generated composite literals are empty
// rather than nil and the viewer's JSON distinguishes the two.
func factSpecs(facts []fact) []infergo.FactSpec {
	specs := make([]infergo.FactSpec, len(facts))
	for i, f := range facts {
		specs[i] = infergo.FactSpec{
			Name: f.name,
			Type: types.TypeString(f.typ, func(pkg *types.Package) string { return pkg.Name() }),
		}
	}
	return specs
}

// ruleset builds the metadata for the retained rules. emit prints this value, so
// the generated Ruleset function and in-process callers cannot disagree.
func (c *compiler) ruleset(ids []int) infergo.Ruleset {
	requested := make([]fact, len(c.outputs))
	for i, output := range c.outputs {
		requested[i] = output.fact
	}
	rules := make([]infergo.RuleSpec, len(ids))
	for i, id := range ids {
		r := c.rules[id]
		rules[i] = infergo.RuleSpec{
			ID: r.name, Requirement: r.requirement, Source: r.source,
			Inputs: factSpecs(r.inputs), Outputs: factSpecs(r.outputs),
		}
	}
	return infergo.Ruleset{Inputs: factSpecs(c.externalFacts()), Outputs: factSpecs(requested), Rules: rules}
}

func (c *compiler) emit(config Config, ids []int, ruleset infergo.Ruleset) ([]byte, error) {
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
	emitFacts := func(specs []infergo.FactSpec) {
		fmt.Fprintf(&body, "[]%s.FactSpec{", runtimeAlias)
		for _, spec := range specs {
			fmt.Fprintf(&body, "{Name: %q, Type: %q},", spec.Name, spec.Type)
		}
		fmt.Fprint(&body, "}")
	}
	fmt.Fprintln(&body, "\n// Ruleset returns fresh metadata for the generated evaluator.")
	fmt.Fprintf(&body, "func Ruleset() %s.Ruleset { return %s.Ruleset{Inputs:", runtimeAlias, runtimeAlias)
	emitFacts(ruleset.Inputs)
	fmt.Fprint(&body, ", Outputs:")
	emitFacts(ruleset.Outputs)
	fmt.Fprintf(&body, ", Rules: []%s.RuleSpec{", runtimeAlias)
	for _, r := range ruleset.Rules {
		fmt.Fprintf(&body, "{ID: %q, Requirement: %q, Source: %q, Inputs:", r.ID, r.Requirement, r.Source)
		emitFacts(r.Inputs)
		fmt.Fprint(&body, ", Outputs:")
		emitFacts(r.Outputs)
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
	for _, f := range c.externalFacts() {
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
