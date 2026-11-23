// Package source parses rule files into the editor's model and rewrites them
// for each operation. It performs no I/O: callers pass file contents in and
// get new contents back.
//
// This is a skeleton with the final signatures. Parse returns an empty model
// and the operations refuse as unsupported until the rewriter replaces it.
package source

import (
	"golang.org/x/tools/go/packages"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// Files maps a path relative to the ruleset directory to the file's bytes.
type Files map[string][]byte

// Config names the files the editor works on: the files that hold rules, and
// the types of the input and output contracts.
type Config struct {
	RuleFiles       []string
	Inputs, Outputs string
}

// Result is what an applied operation produces. Files holds the new content of
// each touched file, Changes one entry per touched declaration, and Label the
// sentence for the history receipt.
type Result struct {
	Files   Files             // new content of each touched file
	Changes []protocol.Change // one per touched declaration
	Label   string            // the receipt sentence
}

// Parse builds the model from file contents alone, without type information.
// The revision is left for the caller to set.
func Parse(files Files, config Config) protocol.Model {
	return protocol.Model{}
}

// Apply performs an operation that needs only the parsed files. A refusal is
// returned as a protocol.Refusal error and no files change.
func Apply(files Files, config Config, op protocol.Op) (Result, error) {
	return Result{}, notImplemented()
}

// ApplyTyped performs an operation that needs type information, such as
// rename_fact, using the loaded package. Refusals work as in Apply.
func ApplyTyped(pkg *packages.Package, files Files, config Config, op protocol.Op) (Result, error) {
	return Result{}, notImplemented()
}

// notImplemented is the refusal every operation returns until the rewriter lands.
func notImplemented() error {
	return protocol.Refusal{Reason: protocol.ReasonUnsupported, Message: "not implemented"}
}
