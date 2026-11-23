package source

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// syntaxRefusal refuses an edit to a file that does not parse.
func syntaxRefusal(f *parsedFile) error {
	p := f.problem
	return refuse(protocol.ReasonSyntaxError, "%s does not parse at line %d, column %d: %s. Fix it in the code pane or your editor first.", f.path, p.Line, p.Column, p.Message)
}

// brokenRuleFile returns the first configured rule file that does not parse.
func (rs *ruleset) brokenRuleFile() *parsedFile {
	for _, p := range rs.config.RuleFiles {
		if f := rs.files[p]; f != nil && f.problem != nil {
			return f
		}
	}
	return nil
}

// findRule returns the named rule. A rule in a file that does not parse, or a
// rule that may lie past a syntax error, is refused with that error.
func (rs *ruleset) findRule(name string) (*rule, error) {
	for _, r := range rs.rules {
		if r.model.ID == name {
			if r.file.problem != nil {
				return nil, syntaxRefusal(r.file)
			}
			return r, nil
		}
	}
	if broken := rs.brokenRuleFile(); broken != nil {
		return nil, syntaxRefusal(broken)
	}
	return nil, refuse(protocol.ReasonNotFound, "There is no rule named %s.", name)
}

// structural refuses a signature edit to a rule whose shape the model cannot
// edit.
func (r *rule) structural() error {
	if r.model.Unsupported != "" {
		return refuse(protocol.ReasonUnsupported, "%s", r.model.Unsupported)
	}
	return nil
}

// declares reports whether the signature already uses name for a parameter or
// result, including the context parameter and the error result.
func (r *rule) declares(name string) bool {
	_, _, inParams := findName(r.decl.Type.Params, name)
	_, _, inResults := findName(r.decl.Type.Results, name)
	return inParams || inResults
}

// checkFact refuses a fact name that is not a Go identifier and a type that is
// not a Go expression.
func checkFact(name, typ string) error {
	if !token.IsIdentifier(name) || name == "_" {
		return refuse(protocol.ReasonUnsupported, "%q is not a valid Go identifier.", name)
	}
	if typ != "" {
		if _, err := parser.ParseExpr(typ); err != nil {
			return refuse(protocol.ReasonUnsupported, "%q is not a Go type.", typ)
		}
	}
	return nil
}

// addRead appends a parameter for the fact to the rule.
func (e *edit) addRead(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if err := r.structural(); err != nil {
		return "", err
	}
	if err := checkFact(op.Fact, op.Type); err != nil {
		return "", err
	}
	if r.declares(op.Fact) {
		return "", refuse(protocol.ReasonExists, "%s already has a parameter or result named %s.", r.model.ID, op.Fact)
	}
	fe := e.in(r.file)
	params := r.decl.Type.Params
	if err := fe.insertField(params, len(params.List), op.Fact, op.Type, r.model.ID); err != nil {
		return "", err
	}
	fe.touch(r.index, "", r.model.ID)
	return fmt.Sprintf("Added read %s %s to %s", op.Fact, op.Type, r.model.ID), nil
}

// removeRead removes the fact's parameter and leaves the body alone. The
// label counts the uses the body still has.
func (e *edit) removeRead(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if err := r.structural(); err != nil {
		return "", err
	}
	params := r.decl.Type.Params
	fieldIndex, nameIndex, ok := findName(params, op.Fact)
	if !ok || r.isContext(params.List[fieldIndex].Type) {
		return "", refuse(protocol.ReasonNotFound, "%s does not read %s.", r.model.ID, op.Fact)
	}
	fe := e.in(r.file)
	if err := fe.removeName(params, fieldIndex, nameIndex, r.model.ID); err != nil {
		return "", err
	}
	fe.touch(r.index, "", r.model.ID)
	label := fmt.Sprintf("Removed read %s from %s", op.Fact, r.model.ID)
	switch uses := countUses(r.decl.Body, op.Fact); uses {
	case 0:
	case 1:
		label += "; 1 use remains in its body"
	default:
		label += fmt.Sprintf("; %d uses remain in its body", uses)
	}
	return label, nil
}

// countUses counts identifiers named name in a body, other than field and
// method names after a dot and keys in composite literals.
func countUses(body *ast.BlockStmt, name string) int {
	if body == nil {
		return 0
	}
	skip := make(map[*ast.Ident]bool)
	count := 0
	ast.Inspect(body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.SelectorExpr:
			skip[n.Sel] = true
		case *ast.KeyValueExpr:
			if key, ok := n.Key.(*ast.Ident); ok {
				skip[key] = true
			}
		case *ast.Ident:
			if n.Name == name && !skip[n] {
				count++
			}
		}
		return true
	})
	return count
}

// addProduce adds a named result before any error result.
func (e *edit) addProduce(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if err := checkFact(op.Fact, op.Type); err != nil {
		return "", err
	}
	if r.unnamedResults && len(r.problems) == 0 {
		return e.nameResult(r, op)
	}
	if err := r.structural(); err != nil {
		return "", err
	}
	if r.declares(op.Fact) {
		return "", refuse(protocol.ReasonExists, "%s already has a parameter or result named %s.", r.model.ID, op.Fact)
	}
	fe := e.in(r.file)
	results := r.decl.Type.Results
	if results == nil {
		at := r.file.offset(r.decl.Type.Params.End())
		fe.replace(at, at, " ("+op.Fact+" "+op.Type+")")
	} else {
		index := len(results.List)
		if index > 0 && isError(results.List[index-1].Type) {
			index--
		}
		if err := fe.insertField(results, index, op.Fact, op.Type, r.model.ID); err != nil {
			return "", err
		}
	}
	fe.touch(r.index, "", r.model.ID)
	return fmt.Sprintf("Added result %s %s to %s", op.Fact, op.Type, r.model.ID), nil
}

// nameResult handles add_produce on a rule whose one non-error result is
// unnamed and has the requested type: it names that result, and names an
// unnamed error result err, since Go needs all results named or none.
func (e *edit) nameResult(r *rule, op protocol.Op) (string, error) {
	results := r.decl.Type.Results
	var value *ast.Field
	hasError := false
	for _, field := range results.List {
		if isError(field.Type) {
			hasError = true
			continue
		}
		if value != nil {
			value = nil
			break
		}
		value = field
	}
	if value == nil || len(value.Names) != 0 || r.file.text(value.Type) != op.Type {
		return "", refuse(protocol.ReasonUnsupported, "%s Name its results in the code pane first.", r.model.Unsupported)
	}
	if r.declares(op.Fact) {
		return "", refuse(protocol.ReasonExists, "%s already has a parameter named %s.", r.model.ID, op.Fact)
	}
	start, end := r.file.offset(results.Pos()), r.file.offset(results.End())
	if r.file.commentIn(start, end) {
		return "", commentRefusal(r.model.ID)
	}
	text := "(" + op.Fact + " " + op.Type
	if hasError {
		text += ", " + freshName("err", r.decl.Type) + " error"
	}
	fe := e.in(r.file)
	fe.replace(start, end, text+")")
	fe.touch(r.index, "", r.model.ID)
	return fmt.Sprintf("Named the result of %s %s", r.model.ID, op.Fact), nil
}

// freshName returns base, or base with a number, that no parameter or result
// of the signature uses.
func freshName(base string, signature *ast.FuncType) string {
	taken := func(name string) bool {
		_, _, a := findName(signature.Params, name)
		_, _, b := findName(signature.Results, name)
		return a || b
	}
	name := base
	for i := 2; taken(name); i++ {
		name = base + strconv.Itoa(i)
	}
	return name
}

// removeProduce removes a result, and the parentheses when no result is left.
func (e *edit) removeProduce(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if err := r.structural(); err != nil {
		return "", err
	}
	results := r.decl.Type.Results
	fieldIndex, nameIndex, ok := findName(results, op.Fact)
	if !ok || isError(results.List[fieldIndex].Type) {
		return "", refuse(protocol.ReasonNotFound, "%s does not produce %s.", r.model.ID, op.Fact)
	}
	fe := e.in(r.file)
	if len(results.List) == 1 && len(results.List[0].Names) == 1 {
		start, end := r.file.offset(r.decl.Type.Params.End()), r.file.offset(results.End())
		if r.file.commentIn(start, end) {
			return "", commentRefusal(r.model.ID)
		}
		fe.replace(start, end, "")
	} else if err := fe.removeName(results, fieldIndex, nameIndex, r.model.ID); err != nil {
		return "", err
	}
	fe.touch(r.index, "", r.model.ID)
	return fmt.Sprintf("Removed result %s from %s", op.Fact, r.model.ID), nil
}

// setType replaces the type of one parameter or result.
func (e *edit) setType(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if err := r.structural(); err != nil {
		return "", err
	}
	if err := checkFact(op.Fact, op.Type); err != nil {
		return "", err
	}
	list := r.decl.Type.Params
	fieldIndex, nameIndex, ok := findName(list, op.Fact)
	if !ok {
		list = r.decl.Type.Results
		fieldIndex, nameIndex, ok = findName(list, op.Fact)
	}
	if !ok || isError(list.List[fieldIndex].Type) || r.isContext(list.List[fieldIndex].Type) {
		return "", refuse(protocol.ReasonNotFound, "%s neither reads nor produces %s.", r.model.ID, op.Fact)
	}
	fe := e.in(r.file)
	if err := fe.setFieldType(list.List[fieldIndex], nameIndex, op.Type, r.model.ID); err != nil {
		return "", err
	}
	fe.touch(r.index, "", r.model.ID)
	return fmt.Sprintf("Changed the type of %s in %s to %s", op.Fact, r.model.ID, op.Type), nil
}

// setRequirement rewrites the rule's doc comment, keeping directives.
func (e *edit) setRequirement(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	var directives []string
	fe := e.in(r.file)
	if doc := r.decl.Doc; doc != nil {
		for _, c := range doc.List {
			if isDirective(c.Text) {
				directives = append(directives, c.Text)
			}
		}
		fe.replace(r.file.offset(doc.Pos()), r.file.offset(doc.End()), docComment(op.Text, directives))
	} else {
		at := r.file.offset(r.decl.Pos())
		fe.replace(at, at, docComment(op.Text, nil)+"\n")
	}
	fe.touch(r.index, "", r.model.ID)
	return "Rewrote the requirement of " + r.model.ID, nil
}

// isDirective reports whether a comment is a tool directive such as
// //go:noinline, which a rewritten doc comment keeps.
func isDirective(text string) bool {
	rest, ok := strings.CutPrefix(text, "//")
	if !ok {
		return false
	}
	if strings.HasPrefix(rest, "line ") || strings.HasPrefix(rest, "extern ") || strings.HasPrefix(rest, "export ") {
		return true
	}
	colon := strings.Index(rest, ":")
	if colon <= 0 || colon+1 >= len(rest) {
		return false
	}
	isWord := func(s string) bool {
		return strings.IndexFunc(s, func(c rune) bool { return !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') }) < 0
	}
	return isWord(rest[:colon]) && rest[colon+1] >= 'a' && rest[colon+1] <= 'z'
}

// docWidth is the column a rewritten doc comment wraps at.
const docWidth = 80

// docComment renders text as a line comment wrapped at docWidth columns.
// Blank lines in text separate paragraphs. Directives follow the text.
func docComment(text string, directives []string) string {
	var lines []string
	paragraphs := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n")
	for _, paragraph := range paragraphs {
		words := strings.Fields(paragraph)
		if len(words) == 0 {
			continue
		}
		if len(lines) > 0 {
			lines = append(lines, "//")
		}
		line := "//"
		for _, word := range words {
			if line != "//" && utf8.RuneCountInString(line)+1+utf8.RuneCountInString(word) > docWidth {
				lines = append(lines, line)
				line = "//"
			}
			line += " " + word
		}
		lines = append(lines, line)
	}
	lines = append(lines, directives...)
	return strings.Join(lines, "\n")
}

// deleteRule removes the rule with its doc comment, and any import only it used.
func (e *edit) deleteRule(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	fe := e.in(r.file)
	fe.deleteDecl(r.index, r.model.ID)
	if err := e.fixImports(fe, false); err != nil {
		return "", err
	}
	return "Deleted rule " + r.model.ID, nil
}

// addRule inserts a stub rule after op.After, or at the end of the first rule
// file, importing errors if needed.
func (e *edit) addRule(op protocol.Op) (string, error) {
	if !token.IsIdentifier(op.Name) || !token.IsExported(op.Name) {
		return "", refuse(protocol.ReasonUnsupported, "%q is not an exported Go identifier, which a rule name must be.", op.Name)
	}
	seen := make(map[string]bool)
	for _, fact := range append(append([]protocol.Fact(nil), op.Reads...), op.Produces...) {
		if err := checkFact(fact.Name, fact.Type); err != nil {
			return "", err
		}
		if seen[fact.Name] {
			return "", refuse(protocol.ReasonExists, "The new rule names %s twice.", fact.Name)
		}
		seen[fact.Name] = true
	}
	var file *parsedFile
	after := -1
	atEnd := op.After == ""
	if !atEnd {
		r, err := e.rs.findRule(op.After)
		if err != nil {
			return "", err
		}
		file, after = r.file, r.index
	} else {
		if len(e.rs.config.RuleFiles) == 0 || e.rs.files[e.rs.config.RuleFiles[0]] == nil {
			return "", refuse(protocol.ReasonNotFound, "There is no rule file to add %s to.", op.Name)
		}
		file = e.rs.files[e.rs.config.RuleFiles[0]]
		if file.problem != nil {
			return "", syntaxRefusal(file)
		}
		after = len(file.syntax.Decls) - 1
	}
	if e.rs.packageNames(nil)[op.Name] {
		return "", refuse(protocol.ReasonExists, "The package already declares %s.", op.Name)
	}
	fe := e.in(file)
	errorsName := file.importName("errors")
	switch errorsName {
	case "":
		errorsName = "errors"
		fe.addImport("errors")
	case "_", ".":
		return "", refuse(protocol.ReasonUnsupported, "%s imports errors as %s, so a stub cannot call errors.New.", file.path, errorsName)
	}
	stub := stubSource(op, errorsName)
	if atEnd {
		fe.replace(len(file.src), len(file.src), "\n"+stub+"\n")
	} else {
		at := file.offset(file.syntax.Decls[after].End())
		fe.replace(at, at, "\n\n"+stub)
	}
	fe.insertDecl(after, op.Name)
	return "Added rule " + op.Name, nil
}

// stubSource is the declaration add_rule writes: a doc comment asking for the
// requirement, and a body that returns the zero results with an error, so the
// rule shows as failed until someone implements it.
func stubSource(op protocol.Op, errorsName string) string {
	params := make([]string, len(op.Reads))
	taken := make(map[string]bool)
	for i, read := range op.Reads {
		params[i] = read.Name + " " + read.Type
		taken[read.Name] = true
	}
	results := make([]string, len(op.Produces))
	returns := make([]string, len(op.Produces))
	for i, produce := range op.Produces {
		results[i] = produce.Name + " " + produce.Type
		returns[i] = produce.Name
		taken[produce.Name] = true
	}
	errName := "err"
	for i := 2; taken[errName]; i++ {
		errName = "err" + strconv.Itoa(i)
	}
	results = append(results, errName+" error")
	returns = append(returns, errorsName+".New("+strconv.Quote(stubMessage(op.Name))+")")
	return fmt.Sprintf("// %s TODO: state the requirement.\nfunc %s(%s) (%s) {\n\treturn %s\n}",
		op.Name, op.Name, strings.Join(params, ", "), strings.Join(results, ", "), strings.Join(returns, ", "))
}

// editableContract returns a contract the rewriter can change, or the refusal
// that says why it cannot.
func (rs *ruleset) editableContract(c *contract) (*contract, error) {
	if c.file == nil {
		for _, p := range rs.paths {
			if f := rs.files[p]; f.problem != nil && !f.isTest() {
				return nil, syntaxRefusal(f)
			}
		}
		return nil, refuse(protocol.ReasonNotFound, "%s is not declared in the ruleset's files.", c.model.Type)
	}
	if c.file.problem != nil {
		return nil, syntaxRefusal(c.file)
	}
	if c.fields == nil {
		return nil, refuse(protocol.ReasonUnsupported, "%s is not a struct type the editor can change.", c.model.Type)
	}
	return c, nil
}

// fieldFor returns the field and name indexes of the contract field holding
// fact.
func (c *contract) fieldFor(fact string) (int, int, bool) {
	for i, field := range c.fields.List {
		tag, hasTag := factTag(field)
		for j, name := range field.Names {
			if (hasTag && tag == fact) || (!hasTag && name.Name == fact) {
				return i, j, true
			}
		}
	}
	return 0, 0, false
}

// fieldName is the Go field name a new contract field gets for fact.
func fieldName(fact string) string {
	first, size := utf8.DecodeRuneInString(fact)
	return string(unicode.ToUpper(first)) + fact[size:]
}

// addField adds a field for fact to a contract, with an explicit fact tag.
func (e *edit) addField(c *contract, fact, typ string) error {
	if _, _, ok := c.fieldFor(fact); ok {
		return refuse(protocol.ReasonExists, "%s already has fact %s.", c.model.Type, fact)
	}
	name := fieldName(fact)
	if _, _, ok := findName(c.fields, name); ok {
		return refuse(protocol.ReasonExists, "%s already has a field named %s.", c.model.Type, name)
	}
	if !token.IsExported(name) {
		return refuse(protocol.ReasonUnsupported, "%s cannot become an exported field name.", fact)
	}
	f := c.file
	line := name + " " + typ + " `fact:" + strconv.Quote(fact) + "`"
	closing := f.offset(c.fields.Closing)
	last := f.offset(c.fields.Opening)
	if n := len(c.fields.List); n > 0 {
		last = f.offset(c.fields.List[n-1].End())
	}
	fe := e.in(f)
	if f.line(closing) > f.line(last) {
		at := lineStart(f.src, closing)
		fe.replace(at, at, indentOf(f.src, closing)+"\t"+line+"\n")
	} else {
		fe.replace(closing, closing, "\n\t"+line+"\n")
	}
	fe.touch(c.index, c.spec.Name.Name, "")
	return nil
}

// removeField removes the field holding fact from a contract. A field alone
// on its lines is removed with them. A field that shares its line with
// another field is refused, unless it declares several names and only the
// name goes.
func (e *edit) removeField(c *contract, fact string) error {
	fieldIndex, nameIndex, ok := c.fieldFor(fact)
	if !ok {
		return refuse(protocol.ReasonNotFound, "%s has no fact %s.", c.model.Type, fact)
	}
	f := c.file
	fe := e.in(f)
	fe.touch(c.index, c.spec.Name.Name, "")
	field := c.fields.List[fieldIndex]
	if len(field.Names) > 1 {
		return fe.removeName(c.fields, fieldIndex, nameIndex, c.model.Type)
	}
	start, end := f.offset(field.Pos()), f.offset(field.End())
	if field.Doc != nil {
		start = f.offset(field.Doc.Pos())
	}
	if field.Comment != nil {
		end = f.offset(field.Comment.End())
	}
	ls, le := lineStart(f.src, start), lineEnd(f.src, end)
	if strings.TrimSpace(string(f.src[ls:start])) != "" || strings.TrimSpace(string(f.src[end:le])) != "" {
		return refuse(protocol.ReasonUnsupported, "The field for %s shares its line with other code. Put each field of %s on its own line to remove it here.", fact, c.model.Type)
	}
	fe.replace(ls, le, "")
	return nil
}

// addInput adds a tagged field for the fact to the input struct.
func (e *edit) addInput(op protocol.Op) (string, error) {
	c, err := e.rs.editableContract(e.rs.inputs)
	if err != nil {
		return "", err
	}
	if err := checkFact(op.Fact, op.Type); err != nil {
		return "", err
	}
	if err := e.addField(c, op.Fact, op.Type); err != nil {
		return "", err
	}
	return fmt.Sprintf("Added input %s %s", op.Fact, op.Type), nil
}

// removeInput removes the fact's field from the input struct.
func (e *edit) removeInput(op protocol.Op) (string, error) {
	c, err := e.rs.editableContract(e.rs.inputs)
	if err != nil {
		return "", err
	}
	if err := e.removeField(c, op.Fact); err != nil {
		return "", err
	}
	return "Removed input " + op.Fact, nil
}

// setRequested adds a field for the fact to the output struct, typed as its
// producer declares it, or removes the field.
func (e *edit) setRequested(op protocol.Op) (string, error) {
	c, err := e.rs.editableContract(e.rs.outputs)
	if err != nil {
		return "", err
	}
	if !*op.Requested {
		if err := e.removeField(c, op.Fact); err != nil {
			return "", err
		}
		return "Stopped requesting output " + op.Fact, nil
	}
	typ, ok := e.rs.factType(op.Fact)
	if !ok {
		return "", refuse(protocol.ReasonNotFound, "No rule or input produces %s.", op.Fact)
	}
	if err := e.addField(c, op.Fact, typ); err != nil {
		return "", err
	}
	return fmt.Sprintf("Requested output %s %s", op.Fact, typ), nil
}

// factType returns the type of a fact as its first producer spells it, or as
// the input field spells it.
func (rs *ruleset) factType(fact string) (string, bool) {
	for _, r := range rs.rules {
		for _, produce := range r.model.Produces {
			if produce.Name == fact {
				return produce.Type, true
			}
		}
	}
	for _, field := range rs.inputs.model.Fields {
		if field.Fact == fact {
			return field.Type, true
		}
	}
	return "", false
}

// replaceSource swaps the rule's declaration for op.Text when op.Base matches
// the current declaration. With op.Format it also fixes imports and formats.
func (e *edit) replaceSource(op protocol.Op) (string, error) {
	r, err := e.rs.findRule(op.Rule)
	if err != nil {
		return "", err
	}
	if op.Base != r.model.SourceHash {
		return "", refuse(protocol.ReasonStaleBase, "%s changed since the code pane loaded it.", r.model.ID)
	}
	// Parse the text alone first, so an error points at a line of the text.
	const header = "package p\n"
	text, err := parser.ParseFile(token.NewFileSet(), r.file.path, header+op.Text, parser.ParseComments)
	if err != nil {
		problem, _ := firstProblem(r.file.path, err)
		return "", refuse(protocol.ReasonSyntaxError, "Line %d, column %d of %s does not parse: %s.", problem.Line-1, problem.Column, r.model.ID, problem.Message)
	}
	if len(text.Decls) != 1 {
		return "", refuse(protocol.ReasonUnsupported, "The code for %s must be exactly one function declaration.", r.model.ID)
	}
	if _, ok := text.Decls[0].(*ast.FuncDecl); !ok {
		return "", refuse(protocol.ReasonUnsupported, "The code for %s must be exactly one function declaration.", r.model.ID)
	}
	fe := e.in(r.file)
	fe.replace(r.start, r.end, op.Text)
	fe.touch(r.index, "", r.model.ID)
	if !op.Format {
		e.raw = true
		return "Edited the code of " + r.model.ID, nil
	}
	if err := e.fixImports(fe, true); err != nil {
		return "", err
	}
	return "Edited and formatted the code of " + r.model.ID, nil
}
