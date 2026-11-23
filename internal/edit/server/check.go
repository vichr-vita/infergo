package server

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/edit/workspace"
	"github.com/vichr-vita/infergo/internal/generate"
)

// requestCheck asks for a check of the newest revision. One check runs at a
// time. Requests that arrive while it runs collapse into one more check,
// which reads whatever revision is newest when it starts.
func (s *Server) requestCheck() {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	if s.checkStopped {
		return
	}
	s.checkWanted = true
	if s.checkRunning {
		return
	}
	s.checkRunning = true
	s.checkDone.Add(1)
	go s.checkLoop()
}

// stopChecks lets a running check finish and starts no more.
func (s *Server) stopChecks() {
	s.checkMu.Lock()
	s.checkStopped = true
	s.checkMu.Unlock()
	s.checkDone.Wait()
}

func (s *Server) checkLoop() {
	defer s.checkDone.Done()
	for {
		s.checkMu.Lock()
		if !s.checkWanted || s.checkStopped {
			s.checkRunning = false
			s.checkMu.Unlock()
			return
		}
		s.checkWanted = false
		s.checkMu.Unlock()
		if check, ok := s.runCheck(); ok {
			s.hub.publish(protocol.EventCheck, check)
		}
	}
}

// runCheck compiles the current revision and, when it is valid, writes the
// evaluator if it changed. ok is false when the files moved on during the
// check, whose result is then dropped in favour of the next one.
func (s *Server) runCheck() (check protocol.Check, ok bool) {
	model := s.ws.Model()
	config := s.ws.Config()
	report, err := s.check(generate.Config{
		Dir: s.ws.Dir(), RuleFiles: config.RuleFiles, Inputs: config.Inputs,
		Outputs: config.Outputs, OutputFile: s.ws.Evaluator(),
	})
	check = protocol.Check{Revision: model.Revision, Evaluator: protocol.EvaluatorKept}
	if err != nil {
		// The package cannot be loaded at all. The graph still draws from
		// the parse, and the summary shows why the compiler cannot run.
		check.Diagnostics = []protocol.Diagnostic{{
			Severity: protocol.SeverityError, Kind: protocol.KindGo,
			Message: "cannot check the ruleset: " + err.Error(),
		}}
	} else {
		check.Diagnostics = diagnostics(report.Diagnostics, model)
		check.Pruned = report.Pruned
	}
	if err == nil && report.Result != nil {
		check.OK = true
		updated, err := s.ws.WriteEvaluator(model.Revision, report.Result.Source)
		switch {
		case errors.Is(err, workspace.ErrStale), errors.Is(err, workspace.ErrClosed):
			return protocol.Check{}, false
		case err != nil:
			fmt.Fprintf(s.log, "infergen: %s: write %s: %v\n", report.Result.Package, s.ws.Evaluator(), err)
			check.OK = false
			check.Diagnostics = append(check.Diagnostics, protocol.Diagnostic{
				Severity: protocol.SeverityError, Kind: protocol.KindGo,
				Message: fmt.Sprintf("write %s: %v", s.ws.Evaluator(), err),
			})
		case updated:
			check.Evaluator = protocol.EvaluatorUpdated
			fmt.Fprintf(s.log, "infergen: %s: updated %s (%s)\n", report.Result.Package, s.ws.Evaluator(), ruleCount(report.Result.Rules))
		default:
			check.Evaluator = protocol.EvaluatorCurrent
		}
	}
	if s.ws.Revision() != model.Revision {
		return protocol.Check{}, false
	}
	return check, true
}

func ruleCount(rules int) string {
	if rules == 1 {
		return "1 rule"
	}
	return fmt.Sprintf("%d rules", rules)
}

// diagnostics converts the compiler's findings for the page. A finding without
// a rule gets the rule whose declaration contains its position, and each kind
// with a mechanical repair gets its fixes as ordinary operations.
func diagnostics(found []generate.Diagnostic, model protocol.Model) []protocol.Diagnostic {
	converted := make([]protocol.Diagnostic, 0, len(found))
	for _, d := range found {
		out := protocol.Diagnostic{
			Severity: d.Severity, Kind: d.Kind, Message: d.Message,
			Rule: d.Rule, Fact: d.Fact, Related: d.Related,
		}
		if d.Position.IsValid() {
			out.File, out.Line, out.Column = d.Position.Filename, d.Position.Line, d.Position.Column
			if out.Rule == "" {
				out.Rule = ruleAt(model, out.File, out.Line)
			}
		}
		out.Fixes = fixes(d, out.Rule, model)
		converted = append(converted, out)
	}
	return converted
}

// ruleAt returns the rule whose doc comment or declaration holds the line, or
// "" if none does.
func ruleAt(model protocol.Model, file string, line int) string {
	for _, rule := range model.Rules {
		if rule.File != file {
			continue
		}
		lines := strings.Split(rule.Source, "\n")
		funcLine := slices.IndexFunc(lines, func(l string) bool { return strings.HasPrefix(l, "func ") })
		if funcLine < 0 {
			continue
		}
		first := rule.Line - funcLine
		if line >= first && line < first+len(lines) {
			return rule.ID
		}
	}
	return ""
}

// fixes returns the repairs for one finding, following the proposal's table:
// rename, add an input, or create a producer for a missing fact; align a
// reader's type with its producer; rename one of two producers; remove any
// wire of a cycle; name an unnamed result; request or delete an unused rule;
// remove an unused input. Other kinds have no mechanical repair.
func fixes(d generate.Diagnostic, rule string, model protocol.Model) []protocol.Fix {
	var fixes []protocol.Fix
	add := func(label string, op protocol.Op) {
		if op.Validate() == nil {
			fixes = append(fixes, protocol.Fix{Label: label, Op: op})
		}
	}
	switch d.Kind {
	case generate.KindMissingProducer:
		if d.Suggestion != "" {
			add("Rename to "+d.Suggestion, protocol.Op{Op: protocol.OpRenameFact, Fact: d.Fact, To: d.Suggestion})
		}
		readType := readType(model, rule, d.Fact)
		if readType == "" {
			break
		}
		if model.Inputs.Editable {
			add("Add input "+d.Fact, protocol.Op{Op: protocol.OpAddInput, Fact: d.Fact, Type: readType})
		}
		if name := exported(d.Fact); findRule(model, name) == nil {
			add("Create a rule that produces "+d.Fact, protocol.Op{
				Op: protocol.OpAddRule, Name: name, After: rule,
				Produces: []protocol.Fact{{Name: d.Fact, Type: readType}},
			})
		}
	case generate.KindTypeMismatch:
		if rule == "" {
			break
		}
		if producerType := producedType(model, d.Related, d.Fact); producerType != "" {
			add(fmt.Sprintf("Use %s in %s", producerType, rule), protocol.Op{Op: protocol.OpSetType, Rule: rule, Fact: d.Fact, Type: producerType})
		}
	case generate.KindDuplicateProducer:
		for _, producer := range append([]string{d.Rule}, d.Related...) {
			if producer == "" || findRule(model, producer) == nil {
				continue
			}
			add("Rename the result in "+producer, protocol.Op{Op: protocol.OpRenameFact, Rule: producer, Fact: d.Fact, To: freshFact(model, producer, d.Fact)})
		}
	case generate.KindCycle:
		for i, reader := range d.Related {
			producer := findRule(model, d.Related[(i+1)%len(d.Related)])
			readerRule := findRule(model, reader)
			if producer == nil || readerRule == nil {
				continue
			}
			for _, read := range readerRule.Reads {
				if slices.ContainsFunc(producer.Produces, func(f protocol.Fact) bool { return f.Name == read.Name }) {
					add(fmt.Sprintf("Remove %s from %s", read.Name, reader), protocol.Op{Op: protocol.OpRemoveRead, Rule: reader, Fact: read.Name})
				}
			}
		}
	case generate.KindSignature:
		if r := findRule(model, rule); r != nil {
			if typ := unnamedResult(*r); typ != "" {
				name := unexported(rule)
				add("Name the result "+name, protocol.Op{Op: protocol.OpAddProduce, Rule: rule, Fact: name, Type: typ})
			}
		}
	case generate.KindUnusedRule:
		if r := findRule(model, rule); r != nil {
			if model.Outputs.Editable {
				for _, produced := range r.Produces {
					requested := true
					add(fmt.Sprintf("Request %s as an output", produced.Name), protocol.Op{Op: protocol.OpSetRequested, Fact: produced.Name, Requested: &requested})
				}
			}
			add("Delete "+rule, protocol.Op{Op: protocol.OpDeleteRule, Rule: rule})
		}
	case generate.KindUnusedInput:
		if model.Inputs.Editable && d.Fact != "" {
			add("Remove input "+d.Fact, protocol.Op{Op: protocol.OpRemoveInput, Fact: d.Fact})
		}
	}
	return fixes
}

// findRule returns the rule with the id, or nil.
func findRule(model protocol.Model, id string) *protocol.Rule {
	for i := range model.Rules {
		if model.Rules[i].ID == id {
			return &model.Rules[i]
		}
	}
	return nil
}

// readType returns the type with which the rule reads the fact, or, with no
// rule, the type of the output field that requests it.
func readType(model protocol.Model, rule, fact string) string {
	if rule == "" {
		for _, field := range model.Outputs.Fields {
			if field.Fact == fact {
				return field.Type
			}
		}
		return ""
	}
	if r := findRule(model, rule); r != nil {
		for _, read := range r.Reads {
			if read.Name == fact {
				return read.Type
			}
		}
	}
	return ""
}

// producedType returns the fact's type as its producer declares it: the first
// related rule that produces it, or else the input field.
func producedType(model protocol.Model, related []string, fact string) string {
	for _, id := range related {
		if r := findRule(model, id); r != nil {
			for _, produced := range r.Produces {
				if produced.Name == fact {
					return produced.Type
				}
			}
		}
	}
	for _, field := range model.Inputs.Fields {
		if field.Fact == fact {
			return field.Type
		}
	}
	return ""
}

// freshFact proposes a new name for the fact a rule produces: the rule's name
// with a lower-case first letter and the fact's last word, such as
// retentionAwardCents for RetentionAward producing tenureAwardCents. A number
// is added while the name is taken.
func freshFact(model protocol.Model, rule, fact string) string {
	base := unexported(rule)
	if suffix := lastWord(fact); suffix != "" && !strings.HasSuffix(base, suffix) {
		base += suffix
	}
	taken := factNames(model)
	name := base
	for n := 2; taken[name]; n++ {
		name = fmt.Sprintf("%s%d", base, n)
	}
	return name
}

// factNames returns every fact the model declares or reads.
func factNames(model protocol.Model) map[string]bool {
	names := map[string]bool{}
	for _, field := range slices.Concat(model.Inputs.Fields, model.Outputs.Fields) {
		names[field.Fact] = true
	}
	for _, rule := range model.Rules {
		for _, f := range slices.Concat(rule.Reads, rule.Produces) {
			names[f.Name] = true
		}
	}
	return names
}

// lastWord returns the last camel-case word of name, such as "Cents" for
// "tenureAwardCents", or "" when name is one word.
func lastWord(name string) string {
	for i := len(name) - 1; i > 0; i-- {
		if unicode.IsUpper(rune(name[i])) {
			return name[i:]
		}
	}
	return ""
}

// unnamedResult returns the type of the rule's only unnamed ordinary result,
// spelled as in the source, when naming it is the whole repair: every result
// is unnamed, and exactly one is not error or context.Context. Otherwise "".
func unnamedResult(rule protocol.Rule) string {
	source := "package p\n" + rule.Source
	file, err := parser.ParseFile(token.NewFileSet(), "", source, parser.SkipObjectResolution)
	if err != nil || len(file.Decls) == 0 {
		return ""
	}
	fn, ok := file.Decls[0].(*ast.FuncDecl)
	if !ok || fn.Type.Results == nil {
		return ""
	}
	found := ""
	for _, field := range fn.Type.Results.List {
		if len(field.Names) > 0 {
			return ""
		}
		typ := source[field.Type.Pos()-1 : field.Type.End()-1]
		if typ == "error" || typ == "context.Context" {
			continue
		}
		if found != "" {
			return ""
		}
		found = typ
	}
	return found
}

// exported returns name with an upper-case first letter.
func exported(name string) string {
	r, size := utf8.DecodeRuneInString(name)
	return string(unicode.ToUpper(r)) + name[size:]
}

// unexported returns name with a lower-case first letter.
func unexported(name string) string {
	r, size := utf8.DecodeRuneInString(name)
	return string(unicode.ToLower(r)) + name[size:]
}

// cycleRefusal reports whether op is an add_read that would close a cycle,
// with the refusal to send. That is the case when the fact's producer already
// depends, directly or through other rules, on the rule that would read it.
// Related lists the cycle's rules in dependency order, each reading from the
// next and the last from the first, starting with the reader.
func cycleRefusal(model protocol.Model, op protocol.Op) (protocol.Refusal, bool) {
	if op.Op != protocol.OpAddRead {
		return protocol.Refusal{}, false
	}
	producers := map[string]string{}
	for _, rule := range model.Rules {
		for _, produced := range rule.Produces {
			producers[produced.Name] = rule.ID
		}
	}
	start, ok := producers[op.Fact]
	if !ok || start == op.Rule || findRule(model, op.Rule) == nil {
		return protocol.Refusal{}, false
	}
	// Breadth-first search over "depends on" from the producer, remembering
	// how each rule was reached, until the reader turns up.
	reachedFrom := map[string]string{start: ""}
	queue := []string{start}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if id == op.Rule {
			path := []string{}
			for at := id; at != ""; at = reachedFrom[at] {
				path = append(path, at)
			}
			// path runs reader, ..., producer; the cycle reads reader first,
			// then the producer and on to the reader's dependency.
			slices.Reverse(path)
			cycle := append([]string{op.Rule}, path[:len(path)-1]...)
			return protocol.Refusal{
				Reason:  protocol.ReasonCycle,
				Message: fmt.Sprintf("%s cannot read %s, because %s already depends on %s: %s.", op.Rule, op.Fact, start, op.Rule, strings.Join(append(slices.Clone(cycle), op.Rule), " → ")),
				Related: cycle,
			}, true
		}
		rule := findRule(model, id)
		if rule == nil {
			continue
		}
		for _, read := range rule.Reads {
			next, ok := producers[read.Name]
			if _, seen := reachedFrom[next]; ok && !seen {
				reachedFrom[next] = id
				queue = append(queue, next)
			}
		}
	}
	return protocol.Refusal{}, false
}
