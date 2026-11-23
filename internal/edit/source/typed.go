package source

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"maps"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// LoadMode is what ApplyTyped needs from go/packages. Load the ruleset
// directory with this mode and Tests set to true, so that references in test
// files are found too.
const LoadMode = packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo

// ApplyTyped performs an operation that needs type information, which is
// rename_fact or rename_rule. pkgs is the ruleset directory loaded with
// LoadMode and Tests set, and files must match what was on disk when it was
// loaded. Files with a "Code generated" header are not rewritten. Refusals work
// as in Apply.
func ApplyTyped(pkgs []*packages.Package, files Files, config Config, op protocol.Op) (Result, error) {
	if err := op.Validate(); err != nil {
		return Result{}, err
	}
	if !NeedsTypes(op) {
		return Result{}, fmt.Errorf("operation %q needs no type information; use Apply", op.Op)
	}
	rs := load(files, config)
	typed, err := typedFiles(pkgs, rs)
	if err != nil {
		return Result{}, err
	}
	e := newEdit(rs)
	var label string
	if op.Op == protocol.OpRenameFact {
		label, err = e.renameFact(typed, op)
	} else {
		label, err = e.renameRule(typed, op)
	}
	if err != nil {
		return Result{}, err
	}
	return e.finish(label)
}

// typedFile is one file of a loaded package: its syntax and the package whose
// type information covers it.
type typedFile struct {
	pkg    *packages.Package
	syntax *ast.File
}

// typedFiles maps each path in the ruleset to its syntax in every loaded
// package that contains it. With tests loaded, a non-test file appears in the
// package and in its test variant, with distinct type objects.
func typedFiles(pkgs []*packages.Package, rs *ruleset) (map[string][]typedFile, error) {
	out := make(map[string][]typedFile)
	for _, pkg := range pkgs {
		if pkg.TypesInfo == nil || pkg.Fset == nil {
			continue
		}
		for _, syntax := range pkg.Syntax {
			tokenFile := pkg.Fset.File(syntax.Pos())
			path := filepath.Base(tokenFile.Name())
			f, ok := rs.files[path]
			if !ok {
				continue
			}
			if tokenFile.Size() != len(f.src) {
				return nil, fmt.Errorf("%s changed since the package was loaded", path)
			}
			out[path] = append(out[path], typedFile{pkg: pkg, syntax: syntax})
		}
	}
	return out, nil
}

// funcDecl returns the top-level function with the given name in a file.
func funcDecl(file *ast.File, name string) *ast.FuncDecl {
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == name {
			return fn
		}
	}
	return nil
}

// typedRule is a rule's declaration as type-checked.
type typedRule struct {
	rule *rule
	tf   typedFile
	decl *ast.FuncDecl
}

// typedRuleFor finds the type-checked declaration of a rule.
func typedRuleFor(typed map[string][]typedFile, r *rule) (typedRule, error) {
	for _, tf := range typed[r.file.path] {
		if fn := funcDecl(tf.syntax, r.model.ID); fn != nil {
			return typedRule{rule: r, tf: tf, decl: fn}, nil
		}
	}
	return typedRule{}, fmt.Errorf("the loaded packages do not contain %s in %s", r.model.ID, r.file.path)
}

// typeErrorIn refuses a rename in a function with type errors, whose
// identifiers may not all resolve.
func (tr typedRule) typeErrorIn() error {
	start, end := tr.decl.Pos(), tr.decl.End()
	for _, typeErr := range tr.tf.pkg.TypeErrors {
		if typeErr.Fset == tr.tf.pkg.Fset && typeErr.Pos >= start && typeErr.Pos < end {
			return refuse(protocol.ReasonUnsupported, "%s has a type error, %s. Fix it before renaming.", tr.rule.model.ID, typeErr.Msg)
		}
	}
	return nil
}

// conflict refuses a rename to name in fn when fn declares name anywhere, or
// uses name for something declared outside it, which the rename would capture
// or shadow. Selected fields and methods are not lexical and do not count.
func conflict(info *types.Info, fn *ast.FuncDecl, name, rule string) error {
	selected := make(map[*ast.Ident]bool)
	var err error
	ast.Inspect(fn, func(n ast.Node) bool {
		if err != nil {
			return false
		}
		switch n := n.(type) {
		case *ast.SelectorExpr:
			selected[n.Sel] = true
		case *ast.Ident:
			if n.Name != name || n == fn.Name || selected[n] {
				return true
			}
			if _, ok := info.Defs[n]; ok {
				err = refuse(protocol.ReasonShadow, "%s already declares %s, so the rename would make two things share that name.", rule, name)
				return false
			}
			obj := info.Uses[n]
			if v, ok := obj.(*types.Var); ok && v.IsField() {
				return true
			}
			if obj != nil && (!obj.Pos().IsValid() || obj.Pos() < fn.Pos() || obj.Pos() >= fn.End()) {
				err = refuse(protocol.ReasonShadow, "%s uses %s, which refers to something outside it that the rename would hide.", rule, name)
				return false
			}
		}
		return true
	})
	return err
}

// factTarget is one parameter or result a fact rename changes.
type factTarget struct {
	tr     typedRule
	ident  *ast.Ident
	result bool
}

// renameFact renames a fact's parameters and results through their type
// objects, and its contract tags, after checking for shadowing.
func (e *edit) renameFact(typed map[string][]typedFile, op protocol.Op) (string, error) {
	if err := checkFact(op.To, ""); err != nil {
		return "", err
	}
	if op.To == op.Fact {
		return "", refuse(protocol.ReasonExists, "The fact is already named %s.", op.To)
	}
	var candidates []*rule
	if op.Rule != "" {
		r, err := e.rs.findRule(op.Rule)
		if err != nil {
			return "", err
		}
		candidates = []*rule{r}
	} else {
		if broken := e.rs.brokenRuleFile(); broken != nil {
			return "", syntaxRefusal(broken)
		}
		candidates = e.rs.rules
	}
	var targets []factTarget
	declares := false
	for _, r := range candidates {
		params, results := r.decl.Type.Params, r.decl.Type.Results
		_, _, inParams := findName(params, op.Fact)
		_, _, inResults := findName(results, op.Fact)
		if !inParams && !inResults {
			continue
		}
		tr, err := typedRuleFor(typed, r)
		if err != nil {
			return "", err
		}
		list := tr.decl.Type.Params
		if inResults {
			list = tr.decl.Type.Results
			declares = true
		}
		fieldIndex, nameIndex, _ := findName(list, op.Fact)
		targets = append(targets, factTarget{tr: tr, ident: list.List[fieldIndex].Names[nameIndex], result: inResults})
	}
	var contracts []*contract
	if op.Rule == "" {
		for _, c := range []*contract{e.rs.inputs, e.rs.outputs} {
			if c.fields == nil {
				continue
			}
			if _, _, ok := c.fieldFor(op.Fact); ok {
				if c.file.problem != nil {
					return "", syntaxRefusal(c.file)
				}
				contracts = append(contracts, c)
				declares = declares || c == e.rs.inputs
			}
		}
	}
	if len(targets) == 0 && len(contracts) == 0 {
		if op.Rule != "" {
			return "", refuse(protocol.ReasonNotFound, "%s neither reads nor produces %s.", op.Rule, op.Fact)
		}
		return "", refuse(protocol.ReasonNotFound, "No rule or contract uses fact %s.", op.Fact)
	}
	// Renaming a reader into an existing fact connects it, which is how a
	// missing producer is fixed. Renaming a producer or input into one would
	// give that fact two declarations.
	if _, existing := e.rs.factType(op.To); declares && existing {
		return "", refuse(protocol.ReasonExists, "A fact named %s already exists.", op.To)
	}
	if slices.Contains(contracts, e.rs.outputs) {
		if _, _, requested := e.rs.outputs.fieldFor(op.To); requested {
			return "", refuse(protocol.ReasonExists, "%s already requests %s.", e.rs.outputs.model.Type, op.To)
		}
	}
	renamed := make(map[string]bool)
	for _, target := range targets {
		tr := target.tr
		if err := tr.typeErrorIn(); err != nil {
			return "", err
		}
		info := tr.tf.pkg.TypesInfo
		if err := conflict(info, tr.decl, op.To, tr.rule.model.ID); err != nil {
			return "", err
		}
		obj := info.Defs[target.ident]
		if obj == nil {
			return "", fmt.Errorf("no type information for %s in %s", op.Fact, tr.rule.model.ID)
		}
		fe := e.in(tr.rule.file)
		ast.Inspect(tr.decl, func(n ast.Node) bool {
			ident, ok := n.(*ast.Ident)
			if ok && (info.Defs[ident] == obj || info.Uses[ident] == obj) {
				at := tr.tf.pkg.Fset.Position(ident.Pos()).Offset
				fe.replace(at, at+len(ident.Name), op.To)
			}
			return true
		})
		fe.touch(tr.rule.index, "", tr.rule.model.ID)
		renamed[tr.rule.model.ID] = true
	}
	for _, c := range contracts {
		if err := e.retag(c, op.Fact, op.To); err != nil {
			return "", err
		}
	}
	return renameFactLabel(op, len(renamed), contracts), nil
}

// renameFactLabel is the receipt sentence of a fact rename.
func renameFactLabel(op protocol.Op, rules int, contracts []*contract) string {
	label := fmt.Sprintf("Renamed fact %s to %s", op.Fact, op.To)
	switch {
	case op.Rule != "":
		label += " in " + op.Rule
	case rules == 1:
		label += " in 1 rule"
	default:
		label += fmt.Sprintf(" in %d rules", rules)
	}
	for _, c := range contracts {
		label += " and the " + c.model.Type + " tag"
	}
	return label
}

// retag sets the fact tag of the contract field holding fact to the new name,
// adding the tag when the fact name came from the field name.
func (e *edit) retag(c *contract, fact, to string) error {
	fieldIndex, _, _ := c.fieldFor(fact)
	field := c.fields.List[fieldIndex]
	if len(field.Names) > 1 {
		return refuse(protocol.ReasonUnsupported, "The field for %s in %s declares several names. Split it before renaming.", fact, c.model.Type)
	}
	f := c.file
	fe := e.in(f)
	fe.touch(c.index, c.spec.Name.Name, "")
	if field.Tag == nil {
		at := f.offset(field.Type.End())
		fe.replace(at, at, " `fact:"+strconv.Quote(to)+"`")
		return nil
	}
	tag, err := strconv.Unquote(field.Tag.Value)
	if err != nil {
		return fmt.Errorf("struct tag of %s: %w", fact, err)
	}
	updated, ok := setTagValue(tag, "fact", to)
	if !ok {
		updated = strings.TrimSpace(tag + " fact:" + strconv.Quote(to))
	}
	literal := "`" + updated + "`"
	if strings.HasPrefix(field.Tag.Value, `"`) || strings.Contains(updated, "`") {
		literal = strconv.Quote(updated)
	}
	fe.replace(f.offset(field.Tag.Pos()), f.offset(field.Tag.End()), literal)
	return nil
}

// setTagValue replaces the value of key in a struct tag, keeping the other
// keys and their order. It reports false when the tag has no such key.
func setTagValue(tag, key, value string) (string, bool) {
	rest := tag
	offset := 0
	for rest != "" {
		trimmed := strings.TrimLeft(rest, " ")
		offset += len(rest) - len(trimmed)
		rest = trimmed
		colon := strings.Index(rest, ":")
		if colon <= 0 || colon+1 >= len(rest) || rest[colon+1] != '"' {
			return tag, false
		}
		name := rest[:colon]
		end := colon + 2
		for end < len(rest) && rest[end] != '"' {
			if rest[end] == '\\' {
				end++
			}
			end++
		}
		if end >= len(rest) {
			return tag, false
		}
		if name == key {
			start := offset + colon + 1
			return tag[:start] + strconv.Quote(value) + tag[offset+end+1:], true
		}
		offset += end + 1
		rest = rest[end+1:]
	}
	return tag, false
}

// renameRule renames a rule function, its references in every loaded file of
// the package, and the first word of its doc comment.
func (e *edit) renameRule(typed map[string][]typedFile, op protocol.Op) (string, error) {
	if !token.IsIdentifier(op.To) || !token.IsExported(op.To) {
		return "", refuse(protocol.ReasonUnsupported, "%q is not an exported Go identifier, which a rule name must be.", op.To)
	}
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if e.rs.packageNames(nil)[op.To] {
		return "", refuse(protocol.ReasonExists, "The package already declares %s.", op.To)
	}
	tr, err := typedRuleFor(typed, r)
	if err != nil {
		return "", err
	}
	target := tr.tf.pkg.Fset.Position(tr.decl.Name.Pos())
	isTarget := func(obj types.Object, fset *token.FileSet) bool {
		fn, ok := obj.(*types.Func)
		if !ok || fn.Pkg() == nil || fn.Name() != op.Rule {
			return false
		}
		at := fset.Position(fn.Pos())
		return at.Filename == target.Filename && at.Offset == target.Offset
	}
	type spot struct {
		path   string
		offset int
	}
	seen := make(map[spot]bool)
	for _, path := range slices.Sorted(maps.Keys(typed)) {
		f := e.rs.files[path]
		for _, tf := range typed[path] {
			info := tf.pkg.TypesInfo
			for i, decl := range tf.syntax.Decls {
				var spots []int
				ast.Inspect(decl, func(n ast.Node) bool {
					ident, ok := n.(*ast.Ident)
					if !ok || ident.Name != op.Rule {
						return true
					}
					obj := info.Uses[ident]
					if obj == nil {
						obj = info.Defs[ident]
					}
					if obj != nil && isTarget(obj, tf.pkg.Fset) {
						spots = append(spots, tf.pkg.Fset.Position(ident.Pos()).Offset)
					}
					return true
				})
				if len(spots) == 0 {
					continue
				}
				if fn, ok := decl.(*ast.FuncDecl); ok {
					if err := conflict(info, fn, op.To, fn.Name.Name); err != nil {
						return "", err
					}
				}
				fe := e.in(f)
				fe.touch(i, "", e.rs.ruleAt(f, i))
				for _, offset := range spots {
					if seen[spot{path, offset}] {
						continue
					}
					seen[spot{path, offset}] = true
					fe.replace(offset, offset+len(op.Rule), op.To)
				}
			}
		}
	}
	if doc := r.decl.Doc; doc != nil {
		first := doc.List[0]
		if word, ok := strings.CutPrefix(first.Text, "// "+op.Rule); ok && (word == "" || word[0] == ' ') {
			at := r.file.offset(first.Pos()) + len("// ")
			e.in(r.file).replace(at, at+len(op.Rule), op.To)
		}
	}
	return fmt.Sprintf("Renamed rule %s to %s. Callers in other packages are not updated", op.Rule, op.To), nil
}

// ruleAt returns the ID of the rule declared at index in f, or "".
func (rs *ruleset) ruleAt(f *parsedFile, index int) string {
	for _, r := range rs.rules {
		if r.file == f && r.index == index {
			return r.model.ID
		}
	}
	return ""
}
