package generate

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T, source string) Config {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	write(t, filepath.Join(dir, "go.mod"), fmt.Sprintf("module example.com/rules\n\ngo 1.26.4\n\nrequire %s v0.0.0\nreplace %s => %q\n", runtimePath, runtimePath, root))
	write(t, filepath.Join(dir, "rules.go"), source)
	return Config{Dir: dir, RuleFiles: []string{"rules.go"}, Inputs: "Inputs", Outputs: "Outputs", OutputFile: "zz_infergo_gen.go"}
}

func write(t *testing.T, path, source string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGeneratedEvaluator(t *testing.T) {
	config := fixture(t, `package rules
import (
    "context"
    "errors"
    "time"
)
type Inputs struct { Seed int `+"`fact:\"seed\"`"+` }
type Outputs struct {
    Final int `+"`fact:\"final\"`"+`
    Absent bool `+"`fact:\"absenceObserved\"`"+`
    Stamp time.Duration `+"`fact:\"stamp\"`"+`
    Seed int `+"`fact:\"seed\"`"+`
    Packet input `+"`fact:\"packet\"`"+`
}
type input struct { Value int }
type facts = Outputs
var _infergo_context = 1
var _infergo_pkg0 = 2
type offsetKey struct{}
var negativeSeed = errors.New("negative seed")
// Split shares the seed with two downstream facts. BR-01.
func Split(seed int) (left int, right int, err error) {
    if seed < 0 { return 100, 200, negativeSeed }
    return seed, seed + 1, nil
}
func Join(ctx context.Context, left int, right int) (final int) {
    offset, _ := ctx.Value(offsetKey{}).(int)
    return left + right + offset
}
func Optional(final int) (maybe *int) { return nil }
func Observe(maybe *int) (absenceObserved bool) { return maybe == nil }
func Stamp(final int) (stamp time.Duration) { return time.Duration(final) }
func Packet(final int) (packet input) { return input{Value: final} }
func Unused(seed int) (unused int) { panic("unrequested branch executed") }
func helper(seed int) int { return seed }
func (Inputs) Method() int { return 0 }
`)
	config.Outputs = "facts"
	result, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	source := result.Source
	if bytes.Contains(source, []byte("Unused(")) {
		t.Fatal("unrequested rule was emitted")
	}
	path := filepath.Join(config.Dir, config.OutputFile)
	write(t, path, string(source))
	// Existing generated declarations must not interfere with regeneration.
	again, err := Generate(config)
	if err != nil || !bytes.Equal(source, again.Source) {
		t.Fatalf("generation is not reproducible: %v", err)
	}
	write(t, path, "package rules\nfunc Evaluate() { var _ = staleIdentifier }\n")
	again, err = Generate(config)
	if err != nil || !bytes.Equal(source, again.Source) {
		t.Fatalf("cannot regenerate stale code: %v", err)
	}
	write(t, path, string(again.Source))
	write(t, filepath.Join(config.Dir, "generated_test.go"), `package rules
import (
    "fmt"
    "context"
    "errors"
    "testing"
    "github.com/vichr-vita/infergo"
)
func TestEvaluation(t *testing.T) {
    for _, limit := range []int{0, 1, 4} {
        ctx := context.WithValue(t.Context(), offsetKey{}, 5)
        got, err := Evaluate(ctx, Inputs{Seed: 2}, infergo.Options{MaxParallel: limit})
        if err != nil || got.Final != 10 || !got.Absent || got.Stamp != 10 || got.Seed != 2 || got.Packet.Value != 10 {
            t.Fatalf("limit %d: got %+v, error %v", limit, got, err)
        }
        traced, snapshot, traceErr := EvaluateTrace(ctx, Inputs{Seed: 2}, infergo.Options{MaxParallel: limit})
        if traceErr != nil || traced != got || snapshot.Inputs["seed"] != "2" || snapshot.Error != "" || len(snapshot.Trace) != 6 {
            t.Fatalf("trace result %+v, snapshot %+v, error %v", traced, snapshot, traceErr)
        }
        for _, rule := range snapshot.Trace {
            if rule.Kind != "succeeded" { t.Fatalf("unexpected trace: %+v", rule) }
            if rule.Rule == "Optional" && rule.Facts["maybe"] != "nil" { t.Fatal("nil fact lost") }
            if rule.Rule == "Join" && rule.Facts["final"] != "10" { t.Fatal("intermediate fact lost") }
        }
        metadata := Ruleset()
        if metadata.Rules[0].ID != "Split" || metadata.Rules[0].Requirement != "Split shares the seed with two downstream facts. BR-01." || metadata.Rules[0].Source == "" || metadata.Rules[0].Inputs[0].Type != "int" {
            t.Fatalf("incorrect metadata: %+v", metadata)
        }
        metadata.Rules[0].ID = "mutated"
        if Ruleset().Rules[0].ID != "Split" { t.Fatal("metadata is shared") }
        got, err = Evaluate(ctx, Inputs{Seed: -1}, infergo.Options{MaxParallel: limit})
        var ruleError *infergo.RuleError
        if !errors.Is(err, negativeSeed) || !errors.As(err, &ruleError) || ruleError.Rule != "Split" || got != (Outputs{}) {
            t.Fatalf("limit %d: failed result %+v, error %v", limit, got, err)
        }
        traced, snapshot, traceErr = EvaluateTrace(ctx, Inputs{Seed: -1}, infergo.Options{MaxParallel: limit})
        if !errors.Is(traceErr, negativeSeed) || traced != (Outputs{}) || snapshot.Error == "" || snapshot.Trace[0].Kind != "failed" || len(snapshot.Trace[0].Facts) != 0 {
            t.Fatalf("failed trace result %+v, snapshot %+v, error %v", traced, snapshot, traceErr)
        }
        for _, trace := range snapshot.Trace[1:] {
            if trace.Kind != "not_run" || len(trace.Facts) != 0 { t.Fatalf("dependent ran: %+v", trace) }
        }
    }
}
func TestConcurrentTraces(t *testing.T) {
    for i := range 16 {
        t.Run(fmt.Sprint(i), func(t *testing.T) {
            t.Parallel()
            _, snapshot, err := EvaluateTrace(t.Context(), Inputs{Seed:i}, infergo.Options{MaxParallel:4})
            if err != nil || snapshot.Trace[0].Facts["left"] != fmt.Sprint(i) { t.Fatalf("shared trace: %+v, %v", snapshot, err) }
        })
    }
}
`)
	command := exec.CommandContext(t.Context(), "go", "test", "-race", "./...")
	command.Dir = config.Dir
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generated evaluator failed: %v\n%s", err, output)
	}
}

func TestRejectInvalidRulesets(t *testing.T) {
	tests := []struct {
		name, source, want string
	}{
		{
			name: "missing fact",
			source: `type Inputs struct{}; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule(missing int) (value int) { return missing }`,
			want: `no input or rule produces fact "missing"`,
		},
		{
			name: "distinct named types",
			source: `type Score int; type Inputs struct { Seed Score ` + "`fact:\"seed\"`" + ` }; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule(seed int) (value int) { return seed }`,
			want: `expected int`,
		},
		{
			name: "duplicate producers",
			source: `type Inputs struct{}; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func A() (value int) { return 1 }; func B() (value int) { return 2 }`,
			want: `fact "value" has multiple producers`,
		},
		{
			name: "input cannot be overwritten",
			source: `type Inputs struct { Value int ` + "`fact:\"value\"`" + ` }; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func A() (value int) { return 1 }`,
			want: `fact "value" has multiple producers`,
		},
		{
			name: "cycle",
			source: `type Inputs struct{}; type Outputs struct { A int ` + "`fact:\"a\"`" + ` }
func A(b int) (a int) { return b }; func B(a int) (b int) { return a }`,
			want: `rule dependency cycle: A -> B -> A`,
		},
		{
			name: "unnamed input",
			source: `type Inputs struct{}; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule(int) (value int) { return 1 }`,
			want: `requires named, non-error input facts`,
		},
		{
			name: "unnamed output",
			source: `type Inputs struct{}; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule() int { return 1 }`,
			want: `requires named output facts`,
		},
		{
			name: "error position",
			source: `type Inputs struct{}; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule() (err error, value int) { return nil, 1 }`,
			want: `must place error last`,
		},
		{
			name: "variadic rule",
			source: `type Inputs struct{}; type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule(values ...int) (value int) { return 1 }`,
			want: `must not be variadic or generic`,
		},
		{
			name:   "duplicate input mappings",
			source: `type Inputs struct { A int ` + "`fact:\"value\"`" + `; B int ` + "`fact:\"value\"`" + ` }; type Outputs struct{}`,
			want:   `maps multiple fields to fact "value"`,
		},
		{
			name:   "output type mismatch",
			source: `type Inputs struct { Value int }; type Outputs struct { Value string }`,
			want:   `fact "Value" has type int, expected string`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := fixture(t, "package rules\n"+test.source)
			_, err := Generate(config)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if !strings.Contains(err.Error(), "rules.go:") {
				t.Fatalf("diagnostic lacks a source location: %v", err)
			}
		})
	}
}

// lines splits a generation failure into its report lines.
func lines(t *testing.T, err error) []string {
	t.Helper()
	if err == nil {
		t.Fatal("generation succeeded, want errors")
	}
	return strings.Split(err.Error(), "\n")
}

func TestReportsEveryErrorInSourceOrder(t *testing.T) {
	config := fixture(t, `package rules
type Inputs struct {
    Seed int `+"`fact:\"seed\"`"+`
    Label string `+"`fact:\"label\"`"+`
}
type Outputs struct {
    Value int `+"`fact:\"value\"`"+`
    hidden int
}
func Step(sed int) (middle int) { return sed }
func Finish(middle int, label int) (value int) { return middle + label }
func Other(values ...int) (other int) { return 0 }
func A(b int) (a int) { return b }
func B(a int) (b int) { return a }
`)
	// Files are compared by name, and the first producer comes from the earlier file.
	write(t, filepath.Join(config.Dir, "a_more.go"), "package rules\nfunc Early() (value int) { return 1 }\n")
	config.RuleFiles = []string{"rules.go", "a_more.go"}
	_, err := Generate(config)
	got := lines(t, err)
	want := []string{
		"rules.go:8:5: Outputs fields must be exported",
		"rules.go:10:11: no input or rule produces fact \"sed\"",
		"rules.go:11:25: fact \"label\" has type string, expected int",
		"rules.go:11:37: fact \"value\" has multiple producers; first declared at a_more.go:2:15",
		"rules.go:12:6: rule Other must not be variadic",
		"rules.go:13:6: rule dependency cycle: A -> B -> A",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d errors, want %d:\n%s", len(got), len(want), err)
	}
	for i := range want {
		if !strings.HasPrefix(got[i], want[i]) {
			t.Errorf("line %d = %q, want prefix %q", i, got[i], want[i])
		}
	}
}

func TestErrorLimit(t *testing.T) {
	ruleset := func(mistakes int) string {
		var source strings.Builder
		source.WriteString("package rules\ntype Inputs struct{}; type Outputs struct{}\n")
		for i := range mistakes {
			fmt.Fprintf(&source, "func Rule%d(unknown%dzzzzzzzz int) (out%d int) { return 0 }\n", i, i, i)
		}
		return source.String()
	}
	_, err := Generate(fixture(t, ruleset(10)))
	if got := lines(t, err); len(got) != 10 || strings.Contains(err.Error(), "too many errors") {
		t.Fatalf("ten errors reported as:\n%s", err)
	}
	_, err = Generate(fixture(t, ruleset(11)))
	got := lines(t, err)
	if len(got) != 11 || got[10] != "too many errors" || !strings.HasPrefix(got[0], "rules.go:3:") {
		t.Fatalf("eleven errors reported as:\n%s", err)
	}
}

func TestOneMistakeReportsOneError(t *testing.T) {
	tests := []struct {
		name, source, want string
	}{
		{
			name:   "unnamed result feeds an output",
			source: "type Inputs struct{}; type Outputs struct { Value int `fact:\"value\"` }\nfunc Rule() int { return 1 }",
			want:   "requires named output facts",
		},
		{
			name:   "invalid tag feeds a rule",
			source: "type Inputs struct { Seed int `fact:\"not valid\"` }; type Outputs struct { Value int `fact:\"value\"` }\nfunc Rule(seed int) (value int) { return seed }",
			want:   "invalid fact name",
		},
		{
			name:   "unexported input feeds a rule",
			source: "type Inputs struct { seed int }; type Outputs struct { Value int `fact:\"value\"` }\nfunc Rule(seed int) (value int) { return seed }",
			want:   "fields must be exported",
		},
		{
			name:   "rejected rule feeds a consumer",
			source: "type Inputs struct{}; type Outputs struct { Value int `fact:\"value\"` }\nfunc Rule[T any]() (other T) { panic(0) }\nfunc Use(other string) (value int) { return 0 }",
			want:   "must not be variadic or generic",
		},
		{
			name:   "duplicate producers disagree on type",
			source: "type Inputs struct{}; type Outputs struct { Value string `fact:\"value\"` }\nfunc A() (value int) { return 1 }\nfunc B() (value string) { return \"\" }",
			want:   "has multiple producers",
		},
		{
			name:   "missing input contract",
			source: "type Outputs struct { Value int `fact:\"value\"` }\nfunc Rule(seed int) (value int) { return seed }",
			want:   "Inputs must name a struct type",
		},
		{
			name:   "duplicate producers do not fake a cycle",
			source: "type Inputs struct{ Value int `fact:\"value\"` }; type Outputs struct{ Value int `fact:\"value\"` }\nfunc A(value int) (value2 int) { return value }\nfunc B(value2 int) (value int) { return value2 }",
			want:   "has multiple producers",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Generate(fixture(t, "package rules\n"+test.source))
			if got := lines(t, err); len(got) != 1 || !strings.Contains(got[0], test.want) {
				t.Fatalf("got:\n%s\nwant only %q", err, test.want)
			}
		})
	}
}

func TestMissingFactSuggestion(t *testing.T) {
	tests := []struct {
		name, want string
		facts      []string
		suggestion string
	}{
		{name: "one edit", want: "sed", facts: []string{"seed", "total"}, suggestion: "seed"},
		{name: "case only", want: "SEED", facts: []string{"seed", "seeds"}, suggestion: "seed"},
		{name: "transposition", want: "totla", facts: []string{"seed", "total"}, suggestion: "total"},
		{name: "closest wins", want: "salaryCent", facts: []string{"salaryCents", "salaryCentsNet"}, suggestion: "salaryCents"},
		{name: "ties are alphabetical", want: "rates", facts: []string{"ratesB", "ratesA"}, suggestion: "ratesA"},
		{name: "unrelated", want: "completely", facts: []string{"seed", "different"}},
		{name: "same length short name", want: "tax", facts: []string{"tab"}},
		{name: "single letter", want: "a", facts: []string{"b"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var fields strings.Builder
			for i, name := range test.facts {
				fmt.Fprintf(&fields, "F%d string `fact:%q`\n", i, name)
			}
			source := fmt.Sprintf("package rules\ntype Inputs struct {\n%s}\ntype Outputs struct{}\nfunc Rule(%s int) (value int) { return 0 }\n", &fields, test.want)
			_, err := Generate(fixture(t, source))
			got := lines(t, err)[0]
			suggested := strings.Contains(got, "did you mean")
			if test.suggestion == "" && suggested {
				t.Fatalf("unexpected suggestion: %s", got)
			}
			if want := fmt.Sprintf("; did you mean %q?", test.suggestion); test.suggestion != "" && !strings.HasSuffix(got, want) {
				t.Fatalf("got %s, want suffix %s", got, want)
			}
		})
	}
}

func TestPositionsAreRelativeToRulesetDirectory(t *testing.T) {
	source := `package rules
type Inputs struct { Seed int ` + "`fact:\"seed\"`" + ` }
type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
func Rule(seed string) (value int) { return 0 }
func Other() (value int) { return 0 }
`
	config := fixture(t, source)
	_, err := Generate(config)
	for _, want := range []string{"rules.go:4:11: ", "declared at rules.go:2:22", "first declared at rules.go:4:25"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("error = %v, want %q", err, want)
		}
	}
	if strings.Contains(err.Error(), config.Dir) {
		t.Errorf("error contains the absolute directory: %v", err)
	}
	config = fixture(t, "package rules\ntype Inputs struct{}; type Outputs struct{}\nvar broken undefinedType\n")
	if _, err = Generate(config); err == nil || strings.Contains(err.Error(), config.Dir) {
		t.Errorf("load error = %v, want a relative position", err)
	}
}

func TestNotes(t *testing.T) {
	config := fixture(t, `package rules
type Inputs struct {
    Seed int `+"`fact:\"seed\"`"+`
    Direct int `+"`fact:\"direct\"`"+`
    Ignored int `+"`fact:\"ignored\"`"+`
    OnlyPruned int `+"`fact:\"onlyPruned\"`"+`
}
type Outputs struct {
    Value int `+"`fact:\"value\"`"+`
    Direct int `+"`fact:\"direct\"`"+`
}
func Keep(seed int) (value int) { return seed }
func Orphan(onlyPruned int) (extra int) { return onlyPruned }
`)
	result, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rules != 1 || result.Package != "example.com/rules" {
		t.Fatalf("result: %d rules in %q", result.Rules, result.Package)
	}
	want := []string{
		`rules.go:5:5: input fact "ignored" is not used by any output or retained rule`,
		`rules.go:6:5: input fact "onlyPruned" is not used by any output or retained rule`,
		`rules.go:13:6: rule Orphan is not needed by any output and was left out`,
	}
	if len(result.Notes) != len(want) {
		t.Fatalf("notes = %v, want %v", result.Notes, want)
	}
	for i := range want {
		if got := result.Notes[i].String(); got != want[i] {
			t.Errorf("note %d = %q, want %q", i, got, want[i])
		}
	}
}

// generatedAPICaller uses the whole generated API with the exact types emit
// declares, so it compiles against the stubs only if they match.
const generatedAPICaller = `package rules
import (
    "context"
    "github.com/vichr-vita/infergo"
)
var (
    _ func(context.Context, Inputs, infergo.Options) (Outputs, error) = Evaluate
    _ func(context.Context, Inputs, infergo.Options) (Outputs, infergo.Snapshot, error) = EvaluateTrace
    _ func() infergo.Ruleset = Ruleset
    _ func(context.Context, string, []ViewerCase) (string, error) = ExportHTML
    _ infergo.ViewerCase[Inputs] = ViewerCase{}
)
`

func TestNonTestCallerOfGeneratedAPI(t *testing.T) {
	// The package-level ctx and alias names must not disturb the stubs.
	config := fixture(t, `package rules
type Inputs struct { Seed int `+"`fact:\"seed\"`"+` }
type Outputs struct { Value int `+"`fact:\"value\"`"+` }
var ctx, _infergo_context, _infergo_runtime = 1, 2, 3
func Rule(seed int) (value int) { return seed + ctx }
`)
	alone, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(config.Dir, "caller.go"), generatedAPICaller)
	path := filepath.Join(config.Dir, config.OutputFile)
	for name, existing := range map[string]string{"absent": "", "stale": "package rules\nfunc Evaluate() { var _ = staleIdentifier }\n"} {
		if existing == "" {
			os.Remove(path)
		} else {
			write(t, path, existing)
		}
		result, err := Generate(config)
		if err != nil {
			t.Fatalf("%s output: %v", name, err)
		}
		if !bytes.Equal(result.Source, alone.Source) {
			t.Fatalf("%s output: a caller changed the generated source", name)
		}
	}
	write(t, path, string(alone.Source))
	if _, err := Generate(config); err != nil {
		t.Fatalf("current output: %v", err)
	}
	command := exec.CommandContext(t.Context(), "go", "build", "./...")
	command.Dir = config.Dir
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("caller failed to build: %v\n%s", err, output)
	}
}

func TestCallerKeepsDiagnostics(t *testing.T) {
	const contracts = "type Inputs struct { Seed int }; type Outputs struct { Seed int }\n"
	const caller = "package rules\nvar _ = Ruleset\n"
	tests := []struct {
		name, source, want string
	}{
		{name: "missing inputs", source: "type Outputs struct{}\n", want: "Inputs must name a struct type"},
		{name: "missing outputs", source: "type Inputs struct{}\n", want: "Outputs must name a struct type"},
		{name: "non-struct inputs", source: "type Inputs int; type Outputs struct{}\n", want: "Inputs must be a struct"},
		{name: "generic inputs", source: "type Inputs[T any] struct{}; type Outputs struct{}\n", want: "Inputs must not be generic"},
		{name: "reserved name", source: contracts + "func Evaluate() {}\nvar _ = undefinedName\n", want: "Evaluate is reserved for generated code"},
		{name: "type error elsewhere", source: contracts + "var _ = undefinedName\n", want: "undefined: undefinedName"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := fixture(t, "package rules\n"+test.source)
			write(t, filepath.Join(config.Dir, "caller.go"), caller)
			_, err := Generate(config)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if strings.Contains(err.Error(), config.OutputFile) {
				t.Fatalf("stub leaked into the diagnostic: %v", err)
			}
		})
	}
}

func TestRuntimePackageCheckPrecedesStubs(t *testing.T) {
	config := fixture(t, "package infergo\ntype Inputs struct{}; type Outputs struct{}\nvar _ = Ruleset\n")
	write(t, filepath.Join(config.Dir, "go.mod"), "module "+runtimePath+"\n\ngo 1.26\n")
	_, err := Generate(config)
	if err == nil || !strings.Contains(err.Error(), "rules must be in a separate package") {
		t.Fatalf("error = %v", err)
	}
}

func TestInputOnlyEvaluator(t *testing.T) {
	config := fixture(t, "package rules\ntype Inputs struct { Value int }; type Outputs struct { Value int }")
	result, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(config.Dir, config.OutputFile), string(result.Source))
	command := exec.CommandContext(t.Context(), "go", "test", "./...")
	command.Dir = config.Dir
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("input-only evaluator failed: %v\n%s", err, output)
	}
}

func TestStaleContractStopsCompilingUntilRegenerated(t *testing.T) {
	// Deadline reaches no rule, so only the guard imports time.
	contract := `package rules
import "time"
type Inputs struct {
    Seed int ` + "`fact:\"seed\"`" + `
    Deadline *time.Time ` + "`fact:\"deadline\"`" + `
}
func Total(seed int) (total int) { return seed + 1 }
`
	config := fixture(t, contract+"type Outputs struct { Total int `fact:\"total\"` }\n")
	rules := filepath.Join(config.Dir, config.RuleFiles[0])
	output := filepath.Join(config.Dir, config.OutputFile)
	build := func() ([]byte, error) {
		command := exec.CommandContext(t.Context(), "go", "build", "./...")
		command.Dir = config.Dir
		command.Env = append(os.Environ(), "GOWORK=off")
		return command.CombinedOutput()
	}
	regenerate := func() {
		t.Helper()
		result, err := Generate(config)
		if err != nil {
			t.Fatal(err)
		}
		write(t, output, string(result.Source))
		if output, err := build(); err != nil {
			t.Fatalf("regenerated evaluator failed: %v\n%s", err, output)
		}
	}
	regenerate()

	write(t, rules, contract+`type Outputs struct {
    Total int `+"`fact:\"total\"`"+`
    Bonus int `+"`fact:\"bonus\"`"+`
}
func Bonus(total int) (bonus int) { return total * 2 }
`)
	result, err := build()
	if err == nil {
		t.Fatal("stale evaluator compiled")
	}
	if want := "cannot convert Outputs{}"; !bytes.Contains(result, []byte(want)) || !bytes.Contains(result, []byte(config.OutputFile)) {
		t.Fatalf("build output does not report %q in %s:\n%s", want, config.OutputFile, result)
	}
	regenerate()
}

func TestGeneratedTraceIncludesFinishedAndCanceledWork(t *testing.T) {
	config := fixture(t, `package rules
import ("context"; "errors")
type Inputs struct{}
type Outputs struct { Joined int `+"`fact:\"joined\"`"+`; Saved int `+"`fact:\"saved\"`"+` }
var started = make(chan struct{})
var saved = make(chan struct{})
var failure = errors.New("failure")
func Fail() (left int, err error) { <-started; <-saved; return 0, failure }
func Wait(ctx context.Context) (right int, err error) { close(started); <-ctx.Done(); return 0, ctx.Err() }
func Save() (saved int) { signalSaved(); return 42 }
func signalSaved() { close(saved) }
func Join(left int, right int) (joined int) { panic("failed dependency ran") }
`)
	result, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(config.Dir, config.OutputFile), string(result.Source))
	write(t, filepath.Join(config.Dir, "trace_test.go"), `package rules
import (
    "errors"
    "testing"
    "github.com/vichr-vita/infergo"
)
func TestTrace(t *testing.T) {
    result, snapshot, err := EvaluateTrace(t.Context(), Inputs{}, infergo.Options{MaxParallel:3})
    if !errors.Is(err, failure) || result != (Outputs{}) { t.Fatalf("result %+v, error %v", result, err) }
    expected := map[string]string{"Fail":"failed", "Wait":"canceled", "Save":"succeeded", "Join":"not_run"}
    for _, trace := range snapshot.Trace {
        if trace.Kind != expected[trace.Rule] { t.Fatalf("trace: %+v", trace) }
        if trace.Rule == "Save" && trace.Facts["saved"] != "42" { t.Fatal("successful diagnostic value lost") }
        if trace.Rule != "Save" && len(trace.Facts) != 0 { t.Fatalf("unpublished facts: %+v", trace) }
    }
}
`)
	command := exec.CommandContext(t.Context(), "go", "test", "-race", "./...")
	command.Dir = config.Dir
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("traced cancellation failed: %v\n%s", err, output)
	}
}

// buildPackage compiles the fixture with source as its generated file.
func buildPackage(t *testing.T, config Config, source []byte) {
	t.Helper()
	write(t, filepath.Join(config.Dir, config.OutputFile), string(source))
	command := exec.Command("go", "build", "./...")
	command.Dir = config.Dir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generated code does not build: %v\n%s\n%s", err, output, source)
	}
}

// Fields of another package's struct can use types the ruleset cannot name.
func TestContractFromAnotherPackageBuildsWithoutGuard(t *testing.T) {
	dependency := map[string]struct{ imports, field string }{
		"unexported type":              {field: "hidden"},
		"struct with unexported field": {field: "struct{ hidden int }"},
		"internal package type":        {imports: `import "example.com/rules/dep/internal/secret"`, field: "secret.Value"},
	}
	for name, contract := range dependency {
		for _, declaration := range []string{"type Inputs = dep.In", "type Inputs dep.In"} {
			t.Run(name+"/"+declaration, func(t *testing.T) {
				config := fixture(t, `package rules
import "example.com/rules/dep"
`+declaration+`
type Outputs struct { Value int `+"`fact:\"value\"`"+` }
func Rule() (value int) { return 1 }
`)
				secret := filepath.Join(config.Dir, "dep", "internal", "secret")
				if err := os.MkdirAll(secret, 0o755); err != nil {
					t.Fatal(err)
				}
				write(t, filepath.Join(secret, "secret.go"), "package secret\ntype Value int\n")
				write(t, filepath.Join(config.Dir, "dep", "dep.go"), fmt.Sprintf(
					"package dep\n%s\ntype hidden int\ntype In struct { Field %s }\n", contract.imports, contract.field))

				result, err := Generate(config)
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Contains(result.Source, []byte("}(Inputs{})")) {
					t.Fatalf("foreign contract has a guard:\n%s", result.Source)
				}
				if !bytes.Contains(result.Source, []byte("}(Outputs{})")) {
					t.Fatalf("local contract lost its guard:\n%s", result.Source)
				}
				buildPackage(t, config, result.Source)
			})
		}
	}
}

func TestLineEndingsDoNotChangeOutput(t *testing.T) {
	rules := `package rules
type Inputs struct { Seed int ` + "`fact:\"seed\"`" + ` }
type Outputs struct { Value int ` + "`fact:\"value\"`" + ` }
// Rule adds one.
// BR-01.
func Rule(seed int) (value int) {
	return seed + 1
}
`
	lf, err := Generate(fixture(t, rules))
	if err != nil {
		t.Fatal(err)
	}
	crlf, err := Generate(fixture(t, strings.ReplaceAll(rules, "\n", "\r\n")))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(lf.Source, crlf.Source) {
		t.Fatalf("output differs by line ending:\n%s\n%s", lf.Source, crlf.Source)
	}
}

// These packages never type-check as a whole, so a contract error would be false.
func TestLoadFailuresKeepTheirOwnError(t *testing.T) {
	contracts := "type Inputs struct { Seed int }\ntype Outputs struct { Seed int }\n"
	tests := []struct {
		name   string
		source string
		files  map[string]string
		output string
		want   string
	}{
		{
			name:   "mismatched package clauses",
			source: "package rules\n" + contracts,
			files:  map[string]string{"other.go": "package other\n"},
			want:   "found packages",
		},
		{
			name:   "no buildable files",
			source: "//go:build ignore\n\npackage rules\n" + contracts,
			output: "zz_windows.go",
			want:   "build constraints exclude all Go files",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := fixture(t, test.source)
			if test.output != "" {
				config.OutputFile = test.output
			}
			for name, source := range test.files {
				path := filepath.Join(config.Dir, name)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				write(t, path, source)
			}
			_, err := Generate(config)
			if err == nil || !strings.HasPrefix(err.Error(), "load ruleset:") || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want load ruleset error with %q", err, test.want)
			}
		})
	}
}

func TestRelativeStripsOnlyPathsInsideTheRuleset(t *testing.T) {
	dir := filepath.Join(string(filepath.Separator), "work", "rules")
	inside := filepath.Join(dir, "rules.go")
	outside := filepath.Join(string(filepath.Separator), "other") + dir + string(filepath.Separator) + "inner.go"
	tests := map[string]string{
		inside + ":1:2: failed":         "rules.go:1:2: failed",
		"see " + inside + "\n" + inside: "see rules.go\nrules.go",
		`file "` + inside + `"`:         `file "rules.go"`,
		"(" + inside + ")":              "(rules.go)",
		outside + ":1:2: failed":        outside + ":1:2: failed",
	}
	c := &compiler{dir: dir}
	for text, want := range tests {
		if got := c.relative(text); got != want {
			t.Errorf("relative(%q) = %q, want %q", text, got, want)
		}
	}
}
