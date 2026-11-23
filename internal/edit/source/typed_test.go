package source

import (
	"go/format"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/generate"
)

const runtimePath = "github.com/vichr-vita/infergo"

// tempModule writes files into a new module that requires this checkout's
// runtime, and returns its directory.
func tempModule(t *testing.T, files map[string]string) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	files["go.mod"] = "module example.com/rules\n\ngo 1.26.0\n\nrequire " + runtimePath + " v0.0.0\n\nreplace " + runtimePath + " => " + root + "\n"
	sum, err := os.ReadFile(filepath.Join(root, "go.sum"))
	if err != nil {
		t.Fatal(err)
	}
	files["go.sum"] = string(sum)
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// bonusModule copies the bonus ruleset, evaluator included, into a temporary
// module.
func bonusModule(t *testing.T) string {
	t.Helper()
	files := make(map[string]string)
	for _, name := range []string{"bonus.go", "facts.go", "bonus_test.go", "zz_infergo_gen.go"} {
		src, err := os.ReadFile(filepath.Join(bonusDir, name))
		if err != nil {
			t.Fatal(err)
		}
		files[name] = string(src)
	}
	return tempModule(t, files)
}

// goEnv keeps an enclosing workspace from changing the temporary module.
func goEnv() []string {
	return append(os.Environ(), "GOWORK=off")
}

// loadDir reads the ruleset files of dir as the server does, and loads the
// package with tests as ApplyTyped expects.
func loadDir(t *testing.T, dir string) (Files, []*packages.Package) {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	files := Files{}
	for _, p := range paths {
		if filepath.Base(p) == "zz_infergo_gen.go" {
			continue
		}
		src, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		files[filepath.Base(p)] = src
	}
	pkgs, err := packages.Load(&packages.Config{Mode: LoadMode, Dir: dir, Tests: true, Env: goEnv()}, ".")
	if err != nil {
		t.Fatal(err)
	}
	return files, pkgs
}

// applyTypedOK applies a typed operation to dir that must succeed and writes
// the result back into dir.
func applyTypedOK(t *testing.T, dir string, config Config, op protocol.Op) (Files, Result) {
	t.Helper()
	files, pkgs := loadDir(t, dir)
	result, err := ApplyTyped(pkgs, files, config, op)
	if err != nil {
		t.Fatalf("%s: %v", op.Op, err)
	}
	checkRewrite(t, files, result)
	for name, src := range result.Files {
		if err := os.WriteFile(filepath.Join(dir, name), src, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return files, result
}

// regenerateAndTest proves the rewritten rule files compile and still behave:
// it regenerates the evaluator from them with the generator, which
// type-checks the package, then runs the copied bonus tests, which build the
// rules, the evaluator, and the tests together.
func regenerateAndTest(t *testing.T, dir string) {
	t.Helper()
	generated, err := generate.Generate(generate.Config{Dir: dir, RuleFiles: bonusConfig.RuleFiles, Inputs: "Inputs", Outputs: "Outputs", OutputFile: "zz_infergo_gen.go"})
	if err != nil {
		t.Fatalf("generate after the rename: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "zz_infergo_gen.go"), generated.Source, 0o644); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), "go", "test", "./...")
	command.Dir = dir
	command.Env = goEnv()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("go test after the rename: %v\n%s", err, output)
	}
}

func TestRenameFactBonusEligible(t *testing.T) {
	dir := bonusModule(t)
	files, result := applyTypedOK(t, dir, bonusConfig, protocol.Op{Op: "rename_fact", Fact: "bonusEligible", To: "eligibleForBonus"})
	if _, ok := result.Files["facts.go"]; ok {
		t.Error("bonusEligible is in no contract, so facts.go must not change")
	}
	var rules []string
	for _, c := range result.Changes {
		rules = append(rules, c.Rule)
	}
	if !slices.Equal(rules, []string{"IsBonusEligible", "EligibleBonus"}) {
		t.Fatalf("changed rules %v, want the producer and its one reader", rules)
	}
	want := strings.NewReplacer(
		"(bonusEligible bool)", "(eligibleForBonus bool)",
		"func EligibleBonus(bonusEligible bool,", "func EligibleBonus(eligibleForBonus bool,",
		"\tif bonusEligible {", "\tif eligibleForBonus {",
	).Replace(string(files["bonus.go"]))
	if got := string(result.Files["bonus.go"]); got != want {
		t.Fatalf("unexpected rewrite:\n%s", got)
	}
	if result.Label != "Renamed fact bonusEligible to eligibleForBonus in 2 rules" {
		t.Errorf("label %q", result.Label)
	}
	regenerateAndTest(t, dir)
}

func TestRenameFactUpdatesOutputTag(t *testing.T) {
	dir := bonusModule(t)
	files, result := applyTypedOK(t, dir, bonusConfig, protocol.Op{Op: "rename_fact", Fact: "finalBonusCents", To: "payoutCents"})
	wantFacts := strings.Replace(string(files["facts.go"]), "`fact:\"finalBonusCents\"`", "`fact:\"payoutCents\"`", 1)
	if got := string(result.Files["facts.go"]); got != wantFacts {
		t.Fatalf("facts.go:\n%s", got)
	}
	if strings.Contains(string(result.Files["bonus.go"]), "finalBonusCents") {
		t.Fatal("bonus.go still names finalBonusCents")
	}
	if !strings.Contains(result.Label, "and the Outputs tag") {
		t.Errorf("label %q", result.Label)
	}
	regenerateAndTest(t, dir)
}

func TestRenameFactRefusals(t *testing.T) {
	dir := bonusModule(t)
	files, pkgs := loadDir(t, dir)
	tests := []struct {
		name   string
		op     protocol.Op
		reason string
		names  []string // words the message must contain
	}{
		{"use of the new name outside the function", protocol.Op{Op: "rename_fact", Fact: "companyBonusCents", To: "sum"}, protocol.ReasonShadow, []string{"ProposedBonus", "sum"}},
		{"declaration of the new name inside the function", protocol.Op{Op: "rename_fact", Fact: "paymentReadyCents", To: "reference"}, protocol.ReasonShadow, []string{"PaymentReference", "reference"}},
		{"package name used in the body", protocol.Op{Op: "rename_fact", Fact: "roleRateBps", To: "fmt"}, protocol.ReasonShadow, []string{"RoleRate", "fmt"}},
		{"existing fact", protocol.Op{Op: "rename_fact", Fact: "bonusEligible", To: "goodPerformance"}, protocol.ReasonExists, nil},
		{"existing input", protocol.Op{Op: "rename_fact", Fact: "bonusEligible", To: "active"}, protocol.ReasonExists, nil},
		{"missing fact", protocol.Op{Op: "rename_fact", Fact: "nothing", To: "something"}, protocol.ReasonNotFound, nil},
		{"rule name taken", protocol.Op{Op: "rename_rule", Rule: "RoleRate", To: "BaseBonus"}, protocol.ReasonExists, nil},
		{"rule name taken by a type", protocol.Op{Op: "rename_rule", Rule: "RoleRate", To: "Inputs"}, protocol.ReasonExists, nil},
		{"rule name taken by a test", protocol.Op{Op: "rename_rule", Rule: "RoleRate", To: "TestBonusScenarios"}, protocol.ReasonExists, nil},
		{"missing rule", protocol.Op{Op: "rename_rule", Rule: "Missing", To: "Found"}, protocol.ReasonNotFound, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := ApplyTyped(pkgs, files, bonusConfig, test.op)
			refusal, ok := protocol.AsRefusal(err)
			if !ok || refusal.Reason != test.reason {
				t.Fatalf("got %v, want a %s refusal", err, test.reason)
			}
			for _, name := range test.names {
				if !strings.Contains(refusal.Message, name) {
					t.Errorf("message %q does not name %s", refusal.Message, name)
				}
			}
			if len(result.Files) != 0 {
				t.Fatal("a refusal returned files")
			}
		})
	}
}

func TestRenameFactIntoExistingFactFixesMissingProducer(t *testing.T) {
	dir := bonusModule(t)
	path := filepath.Join(dir, "bonus.go")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	broken := strings.Replace(string(src), "func FinanceRequired(cappedBonusCents uint64) (financeRequired bool) {\n\treturn cappedBonusCents > 200_000",
		"func FinanceRequired(cappedBonusCent uint64) (financeRequired bool) {\n\treturn cappedBonusCent > 200_000", 1)
	if err := os.WriteFile(path, []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	_, result := applyTypedOK(t, dir, bonusConfig, protocol.Op{Op: "rename_fact", Fact: "cappedBonusCent", To: "cappedBonusCents"})
	if got := string(result.Files["bonus.go"]); got != string(src) {
		t.Fatalf("the fix did not restore the reader:\n%s", got)
	}
}

func TestRenameFactScopedToOneRule(t *testing.T) {
	dir := bonusModule(t)
	_, result := applyTypedOK(t, dir, bonusConfig, protocol.Op{Op: "rename_fact", Rule: "CappedBonus", Fact: "cappedBonusCents", To: "limitedBonusCents"})
	if len(result.Changes) != 1 || result.Changes[0].Rule != "CappedBonus" {
		t.Fatalf("changes %+v, want CappedBonus only", result.Changes)
	}
	if !strings.Contains(result.Changes[0].After, "(limitedBonusCents uint64)") || result.Label != "Renamed fact cappedBonusCents to limitedBonusCents in CappedBonus" {
		t.Fatalf("change %+v, label %q", result.Changes[0], result.Label)
	}
}

func TestRenameRuleUpdatesTests(t *testing.T) {
	dir := bonusModule(t)
	files, result := applyTypedOK(t, dir, bonusConfig, protocol.Op{Op: "rename_rule", Rule: "RoleRate", To: "RoleRateBasisPoints"})
	wantRules := strings.Replace(strings.Replace(string(files["bonus.go"]),
		"// RoleRate returns", "// RoleRateBasisPoints returns", 1),
		"func RoleRate(", "func RoleRateBasisPoints(", 1)
	if got := string(result.Files["bonus.go"]); got != wantRules {
		t.Fatalf("bonus.go:\n%s", got)
	}
	if n := strings.Count(string(files["bonus_test.go"]), " RoleRate("); n != 2 {
		t.Fatalf("bonus_test.go calls RoleRate %d times, the test expects 2", n)
	}
	wantTests := strings.ReplaceAll(string(files["bonus_test.go"]), " RoleRate(", " RoleRateBasisPoints(")
	if got := string(result.Files["bonus_test.go"]); got != wantTests {
		t.Fatalf("bonus_test.go was not updated:\n%s", got)
	}
	if !strings.Contains(result.Label, "Callers in other packages are not updated") {
		t.Errorf("label %q", result.Label)
	}
	regenerateAndTest(t, dir)
}

// agreementFixtures are rulesets that compile, covering the shapes where the
// parse and the compiler could disagree.
var agreementFixtures = map[string]string{
	"context, errors, pointers": `package rules

import (
	"context"
	"errors"
)

type Inputs struct {
	Seed int ` + "`fact:\"seed\"`" + `
	Name *string
}

type Outputs struct {
	Final *int ` + "`fact:\"final\"`" + `
	Label string ` + "`fact:\"label\"`" + `
}

// Double doubles the seed and may fail.
func Double(ctx context.Context, seed int) (doubled int, doubleError error) {
	if seed < 0 {
		return 0, errors.New("negative")
	}
	return seed * 2, nil
}

// Final points at the doubled value.
func Final(doubled int) (final *int) {
	return &doubled
}

// Label names the result.
func Label(ctx context.Context, Name *string, final *int) (label string, err error) {
	return "", nil
}

// helper is not a rule.
func helper() {}
`,
	"imported types and multiple results": `package rules

import (
	stdcontext "context"
	"time"
)

type Inputs struct {
	Start time.Time     ` + "`fact:\"start\"`" + `
	Span  time.Duration ` + "`fact:\"span\"`" + `
}

type Outputs struct {
	End   time.Time ` + "`fact:\"end\"`" + `
	Hours float64   ` + "`fact:\"hours\"`" + `
	Late  bool      ` + "`fact:\"late\"`" + `
}

// Window computes the end and the hours.
func Window(ctx stdcontext.Context, start time.Time, span time.Duration) (end time.Time, hours float64) {
	return start.Add(span), span.Hours()
}

// Late compares grouped facts.
func Late(end, start time.Time) (late bool) {
	return end.Before(start)
}
`,
}

func TestParseAgreesWithCompiler(t *testing.T) {
	type ruleFacts struct{ reads, produces []string }
	check := func(t *testing.T, dir string, config Config, files Files) {
		t.Helper()
		report, err := generate.Check(generate.Config{Dir: dir, RuleFiles: config.RuleFiles, Inputs: config.Inputs, Outputs: config.Outputs, OutputFile: "zz_infergo_gen.go"})
		if err != nil {
			t.Fatal(err)
		}
		if report.Result == nil {
			t.Fatalf("fixture does not compile: %+v", report.Diagnostics)
		}
		compiled := make(map[string]ruleFacts)
		for _, r := range report.Result.Ruleset.Rules {
			var facts ruleFacts
			for _, f := range r.Inputs {
				facts.reads = append(facts.reads, f.Name)
			}
			for _, f := range r.Outputs {
				facts.produces = append(facts.produces, f.Name)
			}
			compiled[r.ID] = facts
		}
		model := Parse(files, config)
		var parsed []string
		for _, r := range model.Rules {
			parsed = append(parsed, r.ID)
		}
		compiledNames := append(slices.Collect(maps.Keys(compiled)), report.Pruned...)
		slices.Sort(parsed)
		slices.Sort(compiledNames)
		if !slices.Equal(parsed, compiledNames) {
			t.Fatalf("rules: parse %v, compiler %v", parsed, compiledNames)
		}
		for _, r := range model.Rules {
			want, retained := compiled[r.ID]
			if !retained {
				continue // the compiler reports pruned rules by name only
			}
			var reads, produces []string
			for _, f := range r.Reads {
				reads = append(reads, f.Name)
			}
			for _, f := range r.Produces {
				produces = append(produces, f.Name)
			}
			if !slices.Equal(reads, want.reads) || !slices.Equal(produces, want.produces) {
				t.Errorf("%s: parse reads %v produces %v; compiler reads %v produces %v", r.ID, reads, produces, want.reads, want.produces)
			}
		}
	}
	t.Run("bonus", func(t *testing.T) {
		dir := bonusModule(t)
		files, _ := loadDir(t, dir)
		check(t, dir, bonusConfig, files)
	})
	for name, src := range agreementFixtures {
		t.Run(name, func(t *testing.T) {
			dir := tempModule(t, map[string]string{"rules.go": src})
			config := Config{RuleFiles: []string{"rules.go"}, Inputs: "Inputs", Outputs: "Outputs"}
			check(t, dir, config, Files{"rules.go": []byte(src)})
		})
	}
}

func TestSetTagValue(t *testing.T) {
	tests := []struct{ tag, want string }{
		{`fact:"a"`, `fact:"b"`},
		{`json:"x,omitempty" fact:"a" db:"y"`, `json:"x,omitempty" fact:"b" db:"y"`},
		{`fact:"a\"q"`, `fact:"b"`},
	}
	for _, test := range tests {
		got, ok := setTagValue(test.tag, "fact", "b")
		if !ok || got != test.want {
			t.Errorf("setTagValue(%q) = %q, %v; want %q", test.tag, got, ok, test.want)
		}
	}
	if _, ok := setTagValue(`json:"x"`, "fact", "b"); ok {
		t.Error("a tag without the key reported a replacement")
	}
}

func TestRenameUntaggedInputAddsTag(t *testing.T) {
	src, err := format.Source([]byte(agreementFixtures["context, errors, pointers"]))
	if err != nil {
		t.Fatal(err)
	}
	dir := tempModule(t, map[string]string{"rules.go": string(src)})
	config := Config{RuleFiles: []string{"rules.go"}, Inputs: "Inputs", Outputs: "Outputs"}
	_, result := applyTypedOK(t, dir, config, protocol.Op{Op: "rename_fact", Fact: "Name", To: "displayName"})
	got := string(result.Files["rules.go"])
	if !strings.Contains(got, "Name *string `fact:\"displayName\"`") || !strings.Contains(got, "displayName *string, final *int") {
		t.Fatalf("rename of an untagged input:\n%s", got)
	}
}
