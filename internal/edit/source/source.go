// Package source parses rule files into the editor's model and rewrites them
// for each operation. It performs no I/O: callers pass file contents in and
// get new contents back.
//
// Parse decides what a rule is from syntax alone, the way the generator does
// from types: an exported top-level function in a configured rule file. Apply
// performs every operation that needs only that parse. ApplyTyped performs the
// two renames, which need the package's type information.
//
// Every rewrite works on bytes. It parses, computes byte-range replacements,
// splices them into the original bytes, and passes the file through gofmt. It
// never prints a modified syntax tree, so in a file that was already formatted
// every byte outside the touched declarations stays the same.
package source

import (
	"fmt"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// Files maps a path relative to the ruleset directory to the file's bytes. The
// caller passes every .go file in the directory, including _test.go files,
// except the generated evaluator. Files with a "Code generated" header are
// ignored if they are passed anyway.
type Files map[string][]byte

// Config names the files the editor works on: the files that hold rules, in the
// order the model lists them, and the type names of the input and output
// contracts.
type Config struct {
	RuleFiles       []string
	Inputs, Outputs string
}

// Result is what an applied operation produces. The caller writes Files,
// shows Changes as the preview or the applied diff, and records Label in the
// history receipt.
type Result struct {
	Files   Files             // new content of each file whose bytes changed
	Changes []protocol.Change // one per declaration whose source changed
	Label   string            // the receipt sentence
}

// NeedsTypes reports whether op must go through ApplyTyped, because it needs
// the package loaded with type information. The others go through Apply.
func NeedsTypes(op protocol.Op) bool {
	return op.Op == protocol.OpRenameFact || op.Op == protocol.OpRenameRule
}

// Parse builds the model from file contents alone, without type information.
// The revision is left for the caller to set. A rule file that does not parse
// contributes the rules that end before its first syntax error and is marked
// with that error.
func Parse(files Files, config Config) protocol.Model {
	return load(files, config).model()
}

// Apply performs an operation that needs only the parsed files, which is every
// operation except those NeedsTypes reports. A refusal is returned as a
// protocol.Refusal error. Any error means no file changes.
func Apply(files Files, config Config, op protocol.Op) (Result, error) {
	if err := op.Validate(); err != nil {
		return Result{}, err
	}
	if NeedsTypes(op) {
		return Result{}, fmt.Errorf("operation %q needs type information; use ApplyTyped", op.Op)
	}
	rs := load(files, config)
	e := newEdit(rs)
	label, err := e.apply(op)
	if err != nil {
		return Result{}, err
	}
	return e.finish(label)
}

// apply dispatches an untyped operation, recording its replacements in e and
// returning the receipt sentence.
func (e *edit) apply(op protocol.Op) (string, error) {
	switch op.Op {
	case protocol.OpAddRead:
		return e.addRead(op)
	case protocol.OpRemoveRead:
		return e.removeRead(op)
	case protocol.OpAddRule:
		return e.addRule(op)
	case protocol.OpDeleteRule:
		return e.deleteRule(op)
	case protocol.OpSetRequirement:
		return e.setRequirement(op)
	case protocol.OpAddProduce:
		return e.addProduce(op)
	case protocol.OpRemoveProduce:
		return e.removeProduce(op)
	case protocol.OpSetType:
		return e.setType(op)
	case protocol.OpAddInput:
		return e.addInput(op)
	case protocol.OpRemoveInput:
		return e.removeInput(op)
	case protocol.OpSetRequested:
		return e.setRequested(op)
	case protocol.OpReplaceSource:
		return e.replaceSource(op)
	}
	return "", fmt.Errorf("operation %q is not handled by Apply", op.Op)
}

// refuse builds a refusal with a formatted message.
func refuse(reason, format string, args ...any) error {
	return protocol.Refusal{Reason: reason, Message: fmt.Sprintf(format, args...)}
}
