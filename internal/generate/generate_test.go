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
	source, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(source, []byte("Unused(")) {
		t.Fatal("unrequested rule was emitted")
	}
	path := filepath.Join(config.Dir, config.OutputFile)
	write(t, path, string(source))
	// Existing generated declarations must not interfere with regeneration.
	again, err := Generate(config)
	if err != nil || !bytes.Equal(source, again) {
		t.Fatalf("generation is not reproducible: %v", err)
	}
	write(t, path, "package rules\nfunc Evaluate() { var _ = staleIdentifier }\n")
	again, err = Generate(config)
	if err != nil || !bytes.Equal(source, again) {
		t.Fatalf("cannot regenerate stale code: %v", err)
	}
	write(t, path, string(again))
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

func TestInputOnlyEvaluator(t *testing.T) {
	config := fixture(t, "package rules\ntype Inputs struct { Value int }; type Outputs struct { Value int }")
	source, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(config.Dir, config.OutputFile), string(source))
	command := exec.CommandContext(t.Context(), "go", "test", "./...")
	command.Dir = config.Dir
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("input-only evaluator failed: %v\n%s", err, output)
	}
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
	source, err := Generate(config)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(config.Dir, config.OutputFile), string(source))
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
