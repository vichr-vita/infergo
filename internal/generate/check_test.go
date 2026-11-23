package generate

import (
	"go/token"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const checkContracts = "type Inputs struct { Seed int `fact:\"seed\"` }\ntype Outputs struct { Value int `fact:\"value\"` }\n"

func position(line, column int) token.Position {
	return token.Position{Filename: "rules.go", Line: line, Column: column}
}

// withoutOffsets clears the byte offsets, which these tests do not assert and
// which go diagnostics leave unset.
func withoutOffsets(diagnostics []Diagnostic) []Diagnostic {
	cleared := slices.Clone(diagnostics)
	for i := range cleared {
		cleared[i].Position.Offset = 0
	}
	return cleared
}

// check runs Check on a ruleset and fails on a returned error.
func check(t *testing.T, source string) Report {
	t.Helper()
	report, err := Check(fixture(t, source))
	if err != nil {
		t.Fatal(err)
	}
	return report
}

// Each case is one mistake, so the whole diagnostic is compared.
func TestCheckKinds(t *testing.T) {
	tests := []struct {
		name, source string
		want         Diagnostic
	}{
		{
			name:   "missing producer with a suggestion",
			source: "package rules\n" + checkContracts + "func Rule(sed int) (value int) { return sed }\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindMissingProducer, Position: position(4, 11),
				Message: `no input or rule produces fact "sed"; did you mean "seed"?`,
				Rule:    "Rule", Fact: "sed", Suggestion: "seed",
			},
		},
		{
			name:   "missing producer without a suggestion",
			source: "package rules\n" + checkContracts + "func Rule(unrelated int) (value int) { return unrelated }\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindMissingProducer, Position: position(4, 11),
				Message: `no input or rule produces fact "unrelated"`,
				Rule:    "Rule", Fact: "unrelated",
			},
		},
		{
			name: "type mismatch names reader, fact, producer, and both types",
			source: "package rules\n" + checkContracts +
				"func Source() (label string) { return \"\" }\n" +
				"func Use(label int) (value int) { return label }\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindTypeMismatch, Position: position(5, 10),
				Message: `fact "label" has type string, expected int; declared at rules.go:4:16`,
				Rule:    "Use", Fact: "label", Related: []string{"Source"},
			},
		},
		{
			name:   "type mismatch against an input has no producer rule",
			source: "package rules\n" + checkContracts + "func Rule(seed string) (value int) { return 0 }\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindTypeMismatch, Position: position(4, 11),
				Message: `fact "seed" has type int, expected string; declared at rules.go:2:22`,
				Rule:    "Rule", Fact: "seed",
			},
		},
		{
			name: "duplicate producer names the first rule",
			source: "package rules\n" + checkContracts +
				"func A() (value int) { return 1 }\n" +
				"func B() (value int) { return 2 }\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindDuplicateProducer, Position: position(5, 11),
				Message: `fact "value" has multiple producers; first declared at rules.go:4:11`,
				Rule:    "B", Fact: "value", Related: []string{"A"},
			},
		},
		{
			name:   "signature",
			source: "package rules\n" + checkContracts + "func Rule(values ...int) (value int) { return 1 }\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindSignature, Position: position(4, 6),
				Message: "rule Rule must not be variadic or generic", Rule: "Rule",
			},
		},
		{
			name:   "contract",
			source: "package rules\ntype Inputs struct{}\ntype Outputs struct {\n\thidden int\n}\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindContract, Position: position(4, 2),
				Message: "Outputs fields must be exported and must not be embedded",
			},
		},
		{
			name:   "contract fact collision",
			source: "package rules\ntype Inputs struct { A int `fact:\"x\"`; B int `fact:\"x\"` }\ntype Outputs struct{}\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindContract, Position: position(2, 40),
				Message: `Inputs maps multiple fields to fact "x"`, Fact: "x",
			},
		},
		{
			name:   "reserved",
			source: "package rules\ntype Inputs struct{}\ntype Outputs struct{}\nvar Evaluate = 1\n",
			want: Diagnostic{
				Severity: SeverityError, Kind: KindReserved, Position: position(4, 5),
				Message: "Evaluate is reserved for generated code",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			report := check(t, test.source)
			if report.Result != nil || report.Pruned != nil {
				t.Fatalf("an error left a result: %+v", report)
			}
			if !reflect.DeepEqual(withoutOffsets(report.Diagnostics), []Diagnostic{test.want}) {
				t.Fatalf("diagnostics:\n%+v\nwant:\n%+v", report.Diagnostics, test.want)
			}
		})
	}
}

func TestCheckCycleListsRulesInDependencyOrder(t *testing.T) {
	report := check(t, `package rules
type Inputs struct{}
type Outputs struct { A int `+"`fact:\"a\"`"+` }
func A(c int) (a int) { return c }
func B(a int) (b int) { return a }
func C(b int) (c int) { return b }
`)
	want := Diagnostic{
		Severity: SeverityError, Kind: KindCycle, Position: position(4, 6),
		Message: "rule dependency cycle: A -> C -> B -> A",
		Rule:    "A", Related: []string{"A", "C", "B"},
	}
	if !reflect.DeepEqual(withoutOffsets(report.Diagnostics), []Diagnostic{want}) {
		t.Fatalf("diagnostics:\n%+v\nwant:\n%+v", report.Diagnostics, want)
	}
}

func TestCheckReportsGoErrorsWithPositions(t *testing.T) {
	report := check(t, `package rules
type Inputs struct{}; type Outputs struct{}
var broken undefinedType
var other int = "text"
`)
	if report.Result != nil || len(report.Diagnostics) != 2 {
		t.Fatalf("want two go diagnostics and no result, got %+v", report)
	}
	for i, want := range []struct {
		position token.Position
		message  string
	}{
		{position(3, 12), "undefined: undefinedType"},
		{position(4, 17), `cannot use "text" (untyped string constant) as int value in variable declaration`},
	} {
		got := report.Diagnostics[i]
		if got.Severity != SeverityError || got.Kind != KindGo || got.Position != want.position || got.Message != want.message {
			t.Errorf("diagnostic %d = %+v, want %v %q", i, got, want.position, want.message)
		}
	}
}

func TestCheckReportsSyntaxErrorsAsGoDiagnostics(t *testing.T) {
	report := check(t, "package rules\ntype Inputs struct{}; type Outputs struct{}\nvar x =\n")
	if report.Result != nil || len(report.Diagnostics) == 0 {
		t.Fatalf("want go diagnostics and no result, got %+v", report)
	}
	for _, d := range report.Diagnostics {
		if d.Kind != KindGo || d.Position.Filename != "rules.go" || d.Position.Line != 3 {
			t.Errorf("diagnostic = %#v, want kind go at rules.go line 3", d)
		}
	}
}

func TestCheckReturnsAnErrorWhenNothingCanBeSaid(t *testing.T) {
	source := "//go:build ignore\n\npackage rules\n" + checkContracts
	config := fixture(t, source)
	config.OutputFile = "zz_windows.go"
	report, err := Check(config)
	if err == nil || !strings.Contains(err.Error(), "build constraints exclude all Go files") {
		t.Fatalf("error = %v", err)
	}
	if report.Diagnostics != nil || report.Result != nil {
		t.Fatalf("report = %+v, want empty", report)
	}
	if _, err := Check(Config{}); err == nil {
		t.Fatal("an empty config was accepted")
	}
}

func TestCheckReturnsWarningsWithAResult(t *testing.T) {
	report := check(t, `package rules
type Inputs struct {
    Seed int `+"`fact:\"seed\"`"+`
    Ignored int `+"`fact:\"ignored\"`"+`
}
type Outputs struct { Value int `+"`fact:\"value\"`"+` }
func Keep(seed int) (value int) { return seed }
func Orphan(seed int) (extra int) { return seed }
`)
	if report.Result == nil || report.Result.Rules != 1 {
		t.Fatalf("result = %+v", report.Result)
	}
	want := []Diagnostic{
		{
			Severity: SeverityWarning, Kind: KindUnusedInput, Position: position(4, 5),
			Message: `input fact "ignored" is not used by any output or retained rule`, Fact: "ignored",
		},
		{
			Severity: SeverityWarning, Kind: KindUnusedRule, Position: position(8, 6),
			Message: "rule Orphan is not needed by any output and was left out", Rule: "Orphan",
		},
	}
	if !reflect.DeepEqual(withoutOffsets(report.Diagnostics), want) {
		t.Fatalf("diagnostics:\n%+v\nwant:\n%+v", report.Diagnostics, want)
	}
	if !reflect.DeepEqual(report.Pruned, []string{"Orphan"}) {
		t.Fatalf("pruned = %v", report.Pruned)
	}
	for i, d := range want {
		if got := report.Result.Notes[i]; got.Position.String() != d.Position.String() || got.Message != d.Message {
			t.Errorf("note %d = %v, does not match its diagnostic", i, got)
		}
	}
}

// Generate prints the diagnostics Check returns. These strings were captured
// before Check existed, so they pin the text callers and tools already see.
func TestGenerateErrorTextIsStable(t *testing.T) {
	tests := []struct {
		name, source string
		want         []string
	}{
		{
			name: "every kind of finding in one package",
			source: `package rules
type Inputs struct {
    Seed int ` + "`fact:\"seed\"`" + `
    Label string ` + "`fact:\"label\"`" + `
}
type Outputs struct {
    Value int ` + "`fact:\"value\"`" + `
    hidden int
}
var Evaluate = 1
func Step(sed int) (middle int) { return sed }
func Finish(middle int, label int) (value int) { return middle + label }
func Other(values ...int) (other int) { return 0 }
func A(b int) (a int) { return b }
func B(a int) (b int) { return a }
func Dup() (middle int) { return 1 }
`,
			want: []string{
				"example.com/rules: rules.go:8:5: Outputs fields must be exported and must not be embedded",
				"example.com/rules: rules.go:10:5: Evaluate is reserved for generated code",
				`example.com/rules: rules.go:11:11: no input or rule produces fact "sed"; did you mean "seed"?`,
				`example.com/rules: rules.go:12:25: fact "label" has type string, expected int; declared at rules.go:4:5`,
				"example.com/rules: rules.go:13:6: rule Other must not be variadic or generic",
				"example.com/rules: rules.go:14:6: rule dependency cycle: A -> B -> A",
				`example.com/rules: rules.go:16:13: fact "middle" has multiple producers; first declared at rules.go:11:21`,
			},
		},
		{
			name: "type errors keep the compiler block",
			source: `package rules
type Inputs struct{}; type Outputs struct{}
var broken undefinedType
var other int = "text"
`,
			want: []string{
				"load ruleset:",
				"# example.com/rules",
				"./rules.go:3:12: undefined: undefinedType",
				`./rules.go:4:17: cannot use "text" (untyped string constant) as int value in variable declaration`,
				"example.com/rules: load ruleset: rules.go:3:12: undefined: undefinedType",
				`example.com/rules: load ruleset: rules.go:4:17: cannot use "text" (untyped string constant) as int value in variable declaration`,
			},
		},
		{
			name:   "syntax error",
			source: "package rules\ntype Inputs struct{}; type Outputs struct{}\nvar x =\n",
			want: []string{
				"load ruleset:",
				"# example.com/rules",
				"./rules.go:4:1: syntax error: unexpected EOF, expected expression",
				"example.com/rules: load ruleset: rules.go:3:9: expected ';', found 'EOF'",
				"example.com/rules: load ruleset: rules.go:3:9: expected operand, found 'EOF'",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Generate(fixture(t, test.source))
			if err == nil {
				t.Fatal("generation succeeded")
			}
			if got, want := err.Error(), strings.Join(test.want, "\n"); got != want {
				t.Fatalf("error:\n%s\nwant:\n%s", got, want)
			}
		})
	}
}
