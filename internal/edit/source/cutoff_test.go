package source

import (
	"os"
	"testing"
)

// A file whose last function is cut off must not crash the parse, and the
// rules before it stay known.
func TestParseCutOffLastFunction(t *testing.T) {
	src, err := os.ReadFile("../../../ruleset/bonus/bonus.go")
	if err != nil {
		t.Fatal(err)
	}
	files := Files{"bonus.go": append(src, []byte("\nfunc Broken( {\n")...)}
	model := Parse(files, Config{RuleFiles: []string{"bonus.go"}, Inputs: "Inputs", Outputs: "Outputs"})
	if len(model.Rules) != 26 {
		t.Fatalf("got %d rules, want the 26 before the error", len(model.Rules))
	}
	if model.Files[0].State != "syntax_error" {
		t.Fatalf("file state = %q, want syntax_error", model.Files[0].State)
	}
}
