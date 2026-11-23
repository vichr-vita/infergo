package source

import (
	"bytes"
	"go/format"
	"go/parser"
	"go/token"
	"strings"
	"testing"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// rulesSource is a formatted rule file covering the list shapes the rewriter
// must handle: a single-line list, one field per line with a trailing comma,
// grouped names, a context parameter, an error result, a comment inside a
// list, empty lists, and unnamed results.
const rulesSource = `package rules

import (
	"context"
	"errors"
)

// Single reads one fact.
func Single(a int) (b int) {
	return a
}

// Lines reads facts one per line.
func Lines(
	a int,
	c string,
) (d int) {
	return a
}

// Group reads grouped facts.
func Group(a, c int) (e int) {
	return a + c
}

// WithContext uses a context and returns an error.
func WithContext(ctx context.Context, a int) (f int, err error) {
	if a < 0 {
		return 0, errors.New("negative")
	}
	return a, nil
}

// Commented has a comment in its parameter list.
func Commented(a int /* the a */) (g int) {
	return a
}

// None reads nothing.
func None() (h int) {
	return 1
}

// Results produces grouped results and an error.
func Results(a int) (p, q int, err error) {
	return a, a, nil
}

// OnlyError produces nothing yet.
func OnlyError(a int) (err error) {
	return nil
}

// NoResults produces nothing at all.
func NoResults(a int) {
}

// ResultLines writes its results one per line.
func ResultLines(a int) (
	r int,
	err error,
) {
	return a, nil
}

// Unnamed has an unnamed result.
func Unnamed(a int) int {
	return a
}

// UnnamedError has unnamed results with an error.
func UnnamedError(a int) (int, error) {
	return a, nil
}

// Directive keeps its directive.
//
//go:noinline
func Directive(a int) (k int) {
	return a
}
`

// factsSource declares the contracts for rulesSource.
const factsSource = `package rules

// In holds the inputs.
type In struct {
	A int    ` + "`fact:\"a\"`" + `
	C string ` + "`fact:\"c\"`" + `
}

// Out holds the requested facts.
type Out struct {
	D int ` + "`fact:\"d\"`" + `
}
`

var rulesConfig = Config{RuleFiles: []string{"rules.go"}, Inputs: "In", Outputs: "Out"}

func baseFiles() Files {
	return Files{"rules.go": []byte(rulesSource), "facts.go": []byte(factsSource)}
}

// substitution is one expected edit: the output equals the input with from
// replaced once by to.
type substitution struct{ from, to string }

func TestApply(t *testing.T) {
	requested, unrequested := true, false
	tests := []struct {
		name  string
		files Files // defaults to baseFiles
		op    protocol.Op
		file  string // defaults to rules.go
		want  []substitution
		label string
	}{
		// add_read
		{name: "add_read single line", op: protocol.Op{Op: "add_read", Rule: "Single", Fact: "c", Type: "string"},
			want:  []substitution{{"func Single(a int) (b int)", "func Single(a int, c string) (b int)"}},
			label: "Added read c string to Single"},
		{name: "add_read one per line", op: protocol.Op{Op: "add_read", Rule: "Lines", Fact: "e", Type: "bool"},
			want: []substitution{{"\tc string,\n) (d int)", "\tc string,\n\te bool,\n) (d int)"}}},
		{name: "add_read grouped same type", op: protocol.Op{Op: "add_read", Rule: "Group", Fact: "x", Type: "int"},
			want: []substitution{{"func Group(a, c int)", "func Group(a, c, x int)"}}},
		{name: "add_read grouped other type", op: protocol.Op{Op: "add_read", Rule: "Group", Fact: "s", Type: "string"},
			want: []substitution{{"func Group(a, c int)", "func Group(a, c int, s string)"}}},
		{name: "add_read after context", op: protocol.Op{Op: "add_read", Rule: "WithContext", Fact: "c", Type: "string"},
			want: []substitution{{"(ctx context.Context, a int)", "(ctx context.Context, a int, c string)"}}},
		{name: "add_read empty list", op: protocol.Op{Op: "add_read", Rule: "None", Fact: "a", Type: "int"},
			want: []substitution{{"func None()", "func None(a int)"}}},
		{name: "add_read pointer type", op: protocol.Op{Op: "add_read", Rule: "Single", Fact: "p", Type: "*uint64"},
			want: []substitution{{"func Single(a int)", "func Single(a int, p *uint64)"}}},

		// remove_read
		{name: "remove_read only field", op: protocol.Op{Op: "remove_read", Rule: "Single", Fact: "a"},
			want:  []substitution{{"func Single(a int)", "func Single()"}},
			label: "Removed read a from Single; 1 use remains in its body"},
		{name: "remove_read first of lines", op: protocol.Op{Op: "remove_read", Rule: "Lines", Fact: "a"},
			want: []substitution{{"Lines(\n\ta int,\n\tc string,\n)", "Lines(\n\tc string,\n)"}}},
		{name: "remove_read last of lines", op: protocol.Op{Op: "remove_read", Rule: "Lines", Fact: "c"},
			want: []substitution{{"Lines(\n\ta int,\n\tc string,\n)", "Lines(\n\ta int,\n)"}}},
		{name: "remove_read grouped second", op: protocol.Op{Op: "remove_read", Rule: "Group", Fact: "c"},
			want: []substitution{{"func Group(a, c int)", "func Group(a int)"}}},
		{name: "remove_read grouped first", op: protocol.Op{Op: "remove_read", Rule: "Group", Fact: "a"},
			want: []substitution{{"func Group(a, c int)", "func Group(c int)"}}},
		{name: "remove_read keeps context", op: protocol.Op{Op: "remove_read", Rule: "WithContext", Fact: "a"},
			want:  []substitution{{"(ctx context.Context, a int)", "(ctx context.Context)"}},
			label: "Removed read a from WithContext; 2 uses remain in its body"},

		// add_produce
		{name: "add_produce single", op: protocol.Op{Op: "add_produce", Rule: "Single", Fact: "x", Type: "int"},
			want: []substitution{{"(a int) (b int)", "(a int) (b int, x int)"}}},
		{name: "add_produce before error", op: protocol.Op{Op: "add_produce", Rule: "WithContext", Fact: "x", Type: "int"},
			want: []substitution{{"(f int, err error)", "(f int, x int, err error)"}}},
		{name: "add_produce grouped", op: protocol.Op{Op: "add_produce", Rule: "Results", Fact: "r", Type: "int"},
			want: []substitution{{"(p, q int, err error)", "(p, q, r int, err error)"}}},
		{name: "add_produce before only error", op: protocol.Op{Op: "add_produce", Rule: "OnlyError", Fact: "x", Type: "int"},
			want: []substitution{{"(a int) (err error)", "(a int) (x int, err error)"}}},
		{name: "add_produce to no results", op: protocol.Op{Op: "add_produce", Rule: "NoResults", Fact: "x", Type: "int"},
			want: []substitution{{"func NoResults(a int) {", "func NoResults(a int) (x int) {"}}},
		{name: "add_produce one per line", op: protocol.Op{Op: "add_produce", Rule: "ResultLines", Fact: "s", Type: "string"},
			want: []substitution{{"(\n\tr int,\n\terr error,\n)", "(\n\tr int,\n\ts string,\n\terr error,\n)"}}},
		{name: "add_produce names unnamed result", op: protocol.Op{Op: "add_produce", Rule: "Unnamed", Fact: "x", Type: "int"},
			want:  []substitution{{"func Unnamed(a int) int {", "func Unnamed(a int) (x int) {"}},
			label: "Named the result of Unnamed x"},
		{name: "add_produce names unnamed result and error", op: protocol.Op{Op: "add_produce", Rule: "UnnamedError", Fact: "x", Type: "int"},
			want: []substitution{{"(a int) (int, error)", "(a int) (x int, err error)"}}},

		// remove_produce
		{name: "remove_produce last result drops the list", op: protocol.Op{Op: "remove_produce", Rule: "Single", Fact: "b"},
			want: []substitution{{"func Single(a int) (b int) {", "func Single(a int) {"}}},
		{name: "remove_produce keeps error", op: protocol.Op{Op: "remove_produce", Rule: "WithContext", Fact: "f"},
			want: []substitution{{"(f int, err error)", "(err error)"}}},
		{name: "remove_produce grouped", op: protocol.Op{Op: "remove_produce", Rule: "Results", Fact: "q"},
			want: []substitution{{"(p, q int, err error)", "(p int, err error)"}}},
		{name: "remove_produce one per line", op: protocol.Op{Op: "remove_produce", Rule: "ResultLines", Fact: "r"},
			want: []substitution{{"(\n\tr int,\n\terr error,\n)", "(\n\terr error,\n)"}}},

		// set_type
		{name: "set_type parameter", op: protocol.Op{Op: "set_type", Rule: "Single", Fact: "a", Type: "int64"},
			want:  []substitution{{"func Single(a int)", "func Single(a int64)"}},
			label: "Changed the type of a in Single to int64"},
		{name: "set_type result", op: protocol.Op{Op: "set_type", Rule: "WithContext", Fact: "f", Type: "*uint64"},
			want: []substitution{{"(f int, err error)", "(f *uint64, err error)"}}},
		{name: "set_type splits a group", op: protocol.Op{Op: "set_type", Rule: "Group", Fact: "c", Type: "string"},
			want: []substitution{{"func Group(a, c int)", "func Group(a int, c string)"}}},

		// set_requirement
		{name: "set_requirement wraps at 80 columns", op: protocol.Op{Op: "set_requirement", Rule: "Single",
			Text: "Single passes the fact through unchanged, because the policy says that the value read must also be the value produced."},
			want:  []substitution{{"// Single reads one fact.\n", "// Single passes the fact through unchanged, because the policy says that the\n// value read must also be the value produced.\n"}},
			label: "Rewrote the requirement of Single"},
		{name: "set_requirement keeps directives", op: protocol.Op{Op: "set_requirement", Rule: "Directive", Text: "Directive is new."},
			want: []substitution{{"// Directive keeps its directive.\n//\n//go:noinline\n", "// Directive is new.\n//\n//go:noinline\n"}}},

		// add_rule
		{name: "add_rule after a rule", op: protocol.Op{Op: "add_rule", Name: "LoyaltyTopUp", After: "Single",
			Reads: []protocol.Fact{{Name: "b", Type: "int"}}, Produces: []protocol.Fact{{Name: "topUp", Type: "uint64"}}},
			want: []substitution{{"\treturn a\n}\n\n// Lines", "\treturn a\n}\n\n" +
				"// LoyaltyTopUp TODO: state the requirement.\nfunc LoyaltyTopUp(b int) (topUp uint64, err error) {\n" +
				"\treturn topUp, errors.New(\"LoyaltyTopUp is not implemented\")\n}\n\n// Lines"}},
			label: "Added rule LoyaltyTopUp"},
		{name: "add_rule at the end adds the import", files: Files{"rules.go": []byte("package rules\n\nimport \"fmt\"\n\n// Show prints.\nfunc Show(a int) (s string) {\n\treturn fmt.Sprint(a)\n}\n")},
			op: protocol.Op{Op: "add_rule", Name: "Next", Produces: []protocol.Fact{{Name: "n", Type: "int"}}},
			want: []substitution{{"import \"fmt\"\n", "import \"fmt\"\nimport \"errors\"\n"},
				{"\treturn fmt.Sprint(a)\n}\n", "\treturn fmt.Sprint(a)\n}\n\n// Next TODO: state the requirement.\nfunc Next() (n int, err error) {\n\treturn n, errors.New(\"Next is not implemented\")\n}\n"}}},

		// delete_rule
		{name: "delete_rule", op: protocol.Op{Op: "delete_rule", Rule: "Group"},
			want:  []substitution{{"// Group reads grouped facts.\nfunc Group(a, c int) (e int) {\n\treturn a + c\n}\n\n", ""}},
			label: "Deleted rule Group"},
		{name: "delete_rule removes imports it alone used", op: protocol.Op{Op: "delete_rule", Rule: "WithContext"},
			want: []substitution{{"import (\n\t\"context\"\n\t\"errors\"\n)\n\n", ""},
				{"// WithContext uses a context and returns an error.\nfunc WithContext(ctx context.Context, a int) (f int, err error) {\n\tif a < 0 {\n\t\treturn 0, errors.New(\"negative\")\n\t}\n\treturn a, nil\n}\n\n", ""}}},

		// add_input, remove_input, set_requested
		{name: "add_input", file: "facts.go", op: protocol.Op{Op: "add_input", Fact: "tenureMonths", Type: "uint16"},
			want: []substitution{{"\tA int    `fact:\"a\"`\n\tC string `fact:\"c\"`\n}",
				"\tA            int    `fact:\"a\"`\n\tC            string `fact:\"c\"`\n\tTenureMonths uint16 `fact:\"tenureMonths\"`\n}"}},
			label: "Added input tenureMonths uint16"},
		{name: "remove_input", file: "facts.go", op: protocol.Op{Op: "remove_input", Fact: "c"},
			want: []substitution{{"\tA int    `fact:\"a\"`\n\tC string `fact:\"c\"`\n", "\tA int `fact:\"a\"`\n"}}},
		{name: "set_requested adds with the producer's type", file: "facts.go", op: protocol.Op{Op: "set_requested", Fact: "topUp", Requested: &requested},
			files: Files{"rules.go": []byte("package rules\n\n// TopUp adds.\nfunc TopUp(a int) (topUp *uint64) {\n\treturn nil\n}\n"), "facts.go": []byte(factsSource)},
			want:  []substitution{{"\tD int `fact:\"d\"`\n", "\tD     int     `fact:\"d\"`\n\tTopUp *uint64 `fact:\"topUp\"`\n"}},
			label: "Requested output topUp *uint64"},
		{name: "set_requested copies an input's type", file: "facts.go", op: protocol.Op{Op: "set_requested", Fact: "c", Requested: &requested},
			want: []substitution{{"\tD int `fact:\"d\"`\n", "\tD int    `fact:\"d\"`\n\tC string `fact:\"c\"`\n"}}},
		{name: "set_requested removes", file: "facts.go", op: protocol.Op{Op: "set_requested", Fact: "d", Requested: &unrequested},
			want:  []substitution{{"type Out struct {\n\tD int `fact:\"d\"`\n}", "type Out struct {\n}"}},
			label: "Stopped requesting output d"},

		// replace_source
		{name: "replace_source writes as typed", op: protocol.Op{Op: "replace_source", Rule: "Single",
			Text: "// Single reads one fact.\nfunc Single(a int) (b int) {\n\treturn  a+1\n}"},
			want:  []substitution{{"\treturn a\n}\n\n// Lines", "\treturn  a+1\n}\n\n// Lines"}},
			label: "Edited the code of Single"},
		{name: "replace_source may rename", op: protocol.Op{Op: "replace_source", Rule: "Single",
			Text: "// Renamed reads one fact.\nfunc Renamed(a int) (b int) {\n\treturn a\n}"},
			want: []substitution{{"// Single reads one fact.\nfunc Single(", "// Renamed reads one fact.\nfunc Renamed("}}},
		{name: "replace_source formats and fixes imports", op: protocol.Op{Op: "replace_source", Rule: "WithContext", Format: true,
			Text: "// WithContext uses a context.\nfunc WithContext(ctx context.Context, a int) (f int, err error) {\n  return len(strings.Repeat(\"x\", a)), nil\n}"},
			want: []substitution{{"import (\n\t\"context\"\n\t\"errors\"\n)", "import (\n\t\"context\"\n\t\"strings\"\n)"},
				{"// WithContext uses a context and returns an error.\nfunc WithContext(ctx context.Context, a int) (f int, err error) {\n\tif a < 0 {\n\t\treturn 0, errors.New(\"negative\")\n\t}\n\treturn a, nil\n}",
					"// WithContext uses a context.\nfunc WithContext(ctx context.Context, a int) (f int, err error) {\n\treturn len(strings.Repeat(\"x\", a)), nil\n}"}},
			label: "Edited and formatted the code of WithContext"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			files := test.files
			if files == nil {
				files = baseFiles()
			}
			op := test.op
			if op.Op == protocol.OpReplaceSource {
				op.Base = ruleHash(t, files, op.Rule)
			}
			result, err := Apply(files, rulesConfig, op)
			if err != nil {
				t.Fatal(err)
			}
			path := test.file
			if path == "" {
				path = "rules.go"
			}
			want := string(files[path])
			for _, s := range test.want {
				if !strings.Contains(want, s.from) {
					t.Fatalf("test input lacks %q", s.from)
				}
				want = strings.Replace(want, s.from, s.to, 1)
			}
			if got := string(result.Files[path]); got != want {
				t.Fatalf("output differs\n--- got\n%s\n--- want\n%s", got, want)
			}
			if len(result.Files) != 1 {
				t.Errorf("changed %d files, want 1", len(result.Files))
			}
			if test.label != "" && result.Label != test.label {
				t.Errorf("label %q, want %q", result.Label, test.label)
			}
			if op.Op != protocol.OpReplaceSource || op.Format {
				checkRewrite(t, files, result)
			}
		})
	}
}

// ruleHash returns the source hash of a rule as Parse reports it.
func ruleHash(t *testing.T, files Files, id string) string {
	t.Helper()
	for _, r := range Parse(files, rulesConfig).Rules {
		if r.ID == id {
			return r.SourceHash
		}
	}
	t.Fatalf("no rule %s", id)
	return ""
}

// checkRewrite asserts the properties every rewrite of a formatted file has:
// each output parses and is gofmt output, and outside the declarations the
// changes name, it matches the input byte for byte.
func checkRewrite(t *testing.T, input Files, result Result) {
	t.Helper()
	for path, out := range result.Files {
		if formatted, err := format.Source(input[path]); err != nil || !bytes.Equal(formatted, input[path]) {
			t.Fatalf("test input %s is not gofmt output", path)
		}
		if _, err := parser.ParseFile(token.NewFileSet(), path, out, parser.ParseComments); err != nil {
			t.Fatalf("%s does not parse: %v", path, err)
		}
		formatted, err := format.Source(out)
		if err != nil || !bytes.Equal(formatted, out) {
			t.Fatalf("%s is not gofmt output", path)
		}
		before, after := string(input[path]), string(out)
		for i, c := range result.Changes {
			if c.File != path {
				continue
			}
			marker := "\x00" + string(rune('A'+i)) + "\x00"
			before = cutDeclaration(t, before, c.Before, marker, c.After == "")
			after = cutDeclaration(t, after, c.After, marker, c.Before == "")
		}
		if before != after {
			t.Fatalf("%s changed outside the touched declarations\n--- input\n%s\n--- output\n%s", path, before, after)
		}
	}
}

// cutDeclaration replaces a declaration's text with a marker, or removes it
// with the line break or blank line before it when the other side has no such
// declaration.
func cutDeclaration(t *testing.T, file, declaration, marker string, remove bool) string {
	t.Helper()
	if declaration == "" {
		return file
	}
	if !strings.Contains(file, declaration) {
		t.Fatalf("change text not found in file:\n%s", declaration)
	}
	if remove {
		for _, before := range []string{"\n\n", "\n", ""} {
			if strings.Contains(file, before+declaration) {
				return strings.Replace(file, before+declaration, "", 1)
			}
		}
	}
	return strings.Replace(file, declaration, marker, 1)
}

func TestApplyChanges(t *testing.T) {
	result, err := Apply(baseFiles(), rulesConfig, protocol.Op{Op: "add_read", Rule: "Single", Fact: "c", Type: "string"})
	if err != nil {
		t.Fatal(err)
	}
	want := protocol.Change{
		File:   "rules.go",
		Rule:   "Single",
		Before: "// Single reads one fact.\nfunc Single(a int) (b int) {\n\treturn a\n}",
		After:  "// Single reads one fact.\nfunc Single(a int, c string) (b int) {\n\treturn a\n}",
	}
	if len(result.Changes) != 1 || result.Changes[0] != want {
		t.Fatalf("changes %+v", result.Changes)
	}
	result, err = Apply(baseFiles(), rulesConfig, protocol.Op{Op: "add_rule", Name: "New", After: "Single", Produces: []protocol.Fact{{Name: "n", Type: "int"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Changes) != 1 || result.Changes[0].Before != "" || result.Changes[0].Rule != "New" || !strings.HasPrefix(result.Changes[0].After, "// New TODO") {
		t.Fatalf("add_rule changes %+v", result.Changes)
	}
	result, err = Apply(baseFiles(), rulesConfig, protocol.Op{Op: "delete_rule", Rule: "WithContext"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Changes) != 2 || result.Changes[0].Rule != "" || result.Changes[0].After != "" || result.Changes[1].Rule != "WithContext" || result.Changes[1].After != "" {
		t.Fatalf("delete_rule changes %+v", result.Changes)
	}
	result, err = Apply(baseFiles(), rulesConfig, protocol.Op{Op: "add_input", Fact: "b", Type: "bool"})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Changes) != 1 || result.Changes[0].File != "facts.go" || !strings.HasPrefix(result.Changes[0].Before, "// In holds the inputs.\ntype In struct {") {
		t.Fatalf("add_input changes %+v", result.Changes)
	}
}

func TestRoundTrips(t *testing.T) {
	stub := []protocol.Fact{{Name: "n", Type: "int"}}
	rules := map[string]string{
		"paren imports with errors":    rulesSource,
		"paren imports without errors": "package rules\n\nimport (\n\t\"fmt\"\n\t\"strings\"\n)\n\n// Show prints.\nfunc Show(a int) (s string) {\n\treturn fmt.Sprint(strings.ToUpper(\"x\"), a)\n}\n",
		"third-party imports only":     "package rules\n\nimport (\n\t\"example.com/lib\"\n)\n\n// Show prints.\nfunc Show(a int) (s string) {\n\treturn lib.Show(a)\n}\n",
		"single import":                "package rules\n\nimport \"fmt\"\n\n// Show prints.\nfunc Show(a int) (s string) {\n\treturn fmt.Sprint(a)\n}\n",
		"no imports":                   "package rules\n\n// Show prints.\nfunc Show(a int) (s int) {\n\treturn a\n}\n",
		"no declarations":              "package rules\n",
	}
	for name, src := range rules {
		files := Files{"rules.go": []byte(src), "facts.go": []byte(factsSource)}
		for _, after := range []string{"", "first"} {
			t.Run(name+" after "+after, func(t *testing.T) {
				op := protocol.Op{Op: "add_rule", Name: "Stubbed", Produces: stub, Reads: []protocol.Fact{{Name: "a", Type: "int"}}}
				if after == "first" {
					model := Parse(files, rulesConfig)
					if len(model.Rules) == 0 {
						t.Skip("no rule to insert after")
					}
					op.After = model.Rules[0].ID
				}
				added := applyOK(t, files, op)
				checkRewrite(t, files, added)
				if model := Parse(withFiles(files, added), rulesConfig); !hasStub(model, "Stubbed") {
					t.Fatalf("new rule is not marked as a stub:\n%s", added.Files["rules.go"])
				}
				deleted := applyOK(t, withFiles(files, added), protocol.Op{Op: "delete_rule", Rule: "Stubbed"})
				if got := string(deleted.Files["rules.go"]); got != src {
					t.Fatalf("add_rule then delete_rule changed the file\n--- got\n%s\n--- want\n%s", got, src)
				}
			})
		}
	}
	for _, rule := range []string{"Single", "Lines", "Group", "WithContext", "None", "Results"} {
		for _, typ := range []string{"int", "string"} {
			t.Run("add_read then remove_read on "+rule+" "+typ, func(t *testing.T) {
				files := baseFiles()
				added := applyOK(t, files, protocol.Op{Op: "add_read", Rule: rule, Fact: "zz", Type: typ})
				checkRewrite(t, files, added)
				removed := applyOK(t, withFiles(files, added), protocol.Op{Op: "remove_read", Rule: rule, Fact: "zz"})
				if got := string(removed.Files["rules.go"]); got != rulesSource {
					t.Fatalf("round trip changed the file:\n%s", got)
				}
			})
		}
	}
	for _, rule := range []string{"Single", "WithContext", "Results", "OnlyError", "NoResults", "ResultLines"} {
		t.Run("add_produce then remove_produce on "+rule, func(t *testing.T) {
			files := baseFiles()
			added := applyOK(t, files, protocol.Op{Op: "add_produce", Rule: rule, Fact: "zz", Type: "int"})
			removed := applyOK(t, withFiles(files, added), protocol.Op{Op: "remove_produce", Rule: rule, Fact: "zz"})
			if got := string(removed.Files["rules.go"]); got != rulesSource {
				t.Fatalf("round trip changed the file:\n%s", got)
			}
		})
	}
	t.Run("add_input then remove_input", func(t *testing.T) {
		files := baseFiles()
		added := applyOK(t, files, protocol.Op{Op: "add_input", Fact: "aVeryLongFactName", Type: "map[string]int"})
		removed := applyOK(t, withFiles(files, added), protocol.Op{Op: "remove_input", Fact: "aVeryLongFactName"})
		if got := string(removed.Files["facts.go"]); got != factsSource {
			t.Fatalf("round trip changed the file:\n%s", got)
		}
	})
}

// applyOK applies an operation that must succeed.
func applyOK(t *testing.T, files Files, op protocol.Op) Result {
	t.Helper()
	result, err := Apply(files, rulesConfig, op)
	if err != nil {
		t.Fatalf("%s: %v", op.Op, err)
	}
	return result
}

// withFiles returns files updated with a result's files.
func withFiles(files Files, result Result) Files {
	out := Files{}
	for p, src := range files {
		out[p] = src
	}
	for p, src := range result.Files {
		out[p] = src
	}
	return out
}

func hasStub(model protocol.Model, id string) bool {
	for _, r := range model.Rules {
		if r.ID == id {
			return r.Stub
		}
	}
	return false
}

func TestRefusals(t *testing.T) {
	requested := true
	broken := baseFiles()
	broken["rules.go"] = []byte(strings.Replace(rulesSource, "func None() (h int) {", "func None() (h int {", 1))
	tests := []struct {
		name   string
		files  Files
		op     protocol.Op
		reason string
	}{
		{"missing rule", nil, protocol.Op{Op: "add_read", Rule: "Missing", Fact: "a", Type: "int"}, protocol.ReasonNotFound},
		{"duplicate read", nil, protocol.Op{Op: "add_read", Rule: "Single", Fact: "a", Type: "int"}, protocol.ReasonExists},
		{"read named like a result", nil, protocol.Op{Op: "add_read", Rule: "Single", Fact: "b", Type: "int"}, protocol.ReasonExists},
		{"comment where the read lands", nil, protocol.Op{Op: "add_read", Rule: "Commented", Fact: "c", Type: "int"}, protocol.ReasonUnsupported},
		{"comment where the removal lands", nil, protocol.Op{Op: "remove_read", Rule: "Commented", Fact: "a"}, protocol.ReasonUnsupported},
		{"read not present", nil, protocol.Op{Op: "remove_read", Rule: "Single", Fact: "zz"}, protocol.ReasonNotFound},
		{"context is not a read", nil, protocol.Op{Op: "remove_read", Rule: "WithContext", Fact: "ctx"}, protocol.ReasonNotFound},
		{"duplicate produce", nil, protocol.Op{Op: "add_produce", Rule: "Single", Fact: "b", Type: "int"}, protocol.ReasonExists},
		{"unnamed result of another type", nil, protocol.Op{Op: "add_produce", Rule: "Unnamed", Fact: "x", Type: "string"}, protocol.ReasonUnsupported},
		{"structural edit of an unsupported rule", nil, protocol.Op{Op: "add_read", Rule: "Unnamed", Fact: "x", Type: "int"}, protocol.ReasonUnsupported},
		{"produce not present", nil, protocol.Op{Op: "remove_produce", Rule: "Single", Fact: "zz"}, protocol.ReasonNotFound},
		{"set_type of a missing fact", nil, protocol.Op{Op: "set_type", Rule: "Single", Fact: "zz", Type: "int"}, protocol.ReasonNotFound},
		{"invalid fact name", nil, protocol.Op{Op: "add_read", Rule: "Single", Fact: "not valid", Type: "int"}, protocol.ReasonUnsupported},
		{"invalid type", nil, protocol.Op{Op: "add_read", Rule: "Single", Fact: "x", Type: "map[int"}, protocol.ReasonUnsupported},
		{"duplicate rule name", nil, protocol.Op{Op: "add_rule", Name: "Single", Produces: []protocol.Fact{{Name: "n", Type: "int"}}}, protocol.ReasonExists},
		{"rule name of another declaration", nil, protocol.Op{Op: "add_rule", Name: "In", Produces: []protocol.Fact{{Name: "n", Type: "int"}}}, protocol.ReasonExists},
		{"unexported rule name", nil, protocol.Op{Op: "add_rule", Name: "lower", Produces: []protocol.Fact{{Name: "n", Type: "int"}}}, protocol.ReasonUnsupported},
		{"add_rule after a missing rule", nil, protocol.Op{Op: "add_rule", Name: "New", After: "Missing", Produces: []protocol.Fact{{Name: "n", Type: "int"}}}, protocol.ReasonNotFound},
		{"delete a missing rule", nil, protocol.Op{Op: "delete_rule", Rule: "Missing"}, protocol.ReasonNotFound},
		{"duplicate input", nil, protocol.Op{Op: "add_input", Fact: "a", Type: "int"}, protocol.ReasonExists},
		{"input not present", nil, protocol.Op{Op: "remove_input", Fact: "zz"}, protocol.ReasonNotFound},
		{"output already requested", nil, protocol.Op{Op: "set_requested", Fact: "d", Requested: &requested}, protocol.ReasonExists},
		{"output nobody produces", nil, protocol.Op{Op: "set_requested", Fact: "zz", Requested: &requested}, protocol.ReasonNotFound},
		{"contract not declared", Files{"rules.go": []byte(rulesSource)}, protocol.Op{Op: "add_input", Fact: "x", Type: "int"}, protocol.ReasonNotFound},
		{"stale base", nil, protocol.Op{Op: "replace_source", Rule: "Single", Text: "func Single() {}", Base: "0000"}, protocol.ReasonStaleBase},
		{"edit in a file with a syntax error", broken, protocol.Op{Op: "add_read", Rule: "Single", Fact: "c", Type: "int"}, protocol.ReasonSyntaxError},
		{"rule past a syntax error", broken, protocol.Op{Op: "add_read", Rule: "Directive", Fact: "c", Type: "int"}, protocol.ReasonSyntaxError},
		{"add_rule to a file with a syntax error", broken, protocol.Op{Op: "add_rule", Name: "New", Produces: []protocol.Fact{{Name: "n", Type: "int"}}}, protocol.ReasonSyntaxError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			files := test.files
			if files == nil {
				files = baseFiles()
			}
			result, err := Apply(files, rulesConfig, test.op)
			refusal, ok := protocol.AsRefusal(err)
			if !ok || refusal.Reason != test.reason {
				t.Fatalf("got %v (%#v), want a %s refusal", err, err, test.reason)
			}
			if refusal.Message == "" || len(result.Files) != 0 || len(result.Changes) != 0 {
				t.Fatalf("refusal must carry a message and no files: %+v", result)
			}
		})
	}
}

func TestReplaceSourceSyntaxErrorNamesTheLine(t *testing.T) {
	files := baseFiles()
	op := protocol.Op{Op: "replace_source", Rule: "Single", Base: ruleHash(t, files, "Single"),
		Text: "// Single reads one fact.\nfunc Single(a int) (b int) {\n\treturn a +\n}"}
	_, err := Apply(files, rulesConfig, op)
	refusal, ok := protocol.AsRefusal(err)
	if !ok || refusal.Reason != protocol.ReasonSyntaxError || !strings.HasPrefix(refusal.Message, "Line 4,") {
		t.Fatalf("got %v, want a syntax_error on line 4 of the text", err)
	}
	op.Text = "func Single() {}\n\nfunc Extra() {}"
	if refusal, ok := protocol.AsRefusal(func() error { _, err := Apply(files, rulesConfig, op); return err }()); !ok || refusal.Reason != protocol.ReasonUnsupported {
		t.Fatalf("two declarations: got %v, want unsupported", refusal)
	}
}

func TestApplyFormatsUnformattedInput(t *testing.T) {
	files := Files{"rules.go": []byte("package rules\n\nfunc Single(a int) (b int) {\n  return a\n}\n")}
	result := applyOK(t, files, protocol.Op{Op: "add_read", Rule: "Single", Fact: "c", Type: "int"})
	want := "package rules\n\nfunc Single(a int, c int) (b int) {\n\treturn a\n}\n"
	if got := string(result.Files["rules.go"]); got != want {
		t.Fatalf("got\n%s", got)
	}
}

func TestApplyBonus(t *testing.T) {
	files := readBonus(t)
	result, err := Apply(files, bonusConfig, protocol.Op{Op: "add_read", Rule: "ReviewRequired", Fact: "financeRequired", Type: "bool"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Label != "Added read financeRequired bool to ReviewRequired" {
		t.Errorf("label %q", result.Label)
	}
	checkRewrite(t, files, result)
	before, after := strings.Split(string(files["bonus.go"]), "\n"), strings.Split(string(result.Files["bonus.go"]), "\n")
	changed := 0
	for i := range before {
		if before[i] != after[i] {
			changed++
		}
	}
	if len(before) != len(after) || changed != 1 {
		t.Fatalf("changed %d lines, want 1", changed)
	}
}
