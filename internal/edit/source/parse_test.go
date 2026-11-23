package source

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
)

// bonusDir is the example ruleset. Tests only read it.
const bonusDir = "../../../ruleset/bonus"

// bonusConfig is the configuration ruleset/bonus is generated with.
var bonusConfig = Config{RuleFiles: []string{"bonus.go"}, Inputs: "Inputs", Outputs: "Outputs"}

// readBonus returns every .go file of the bonus ruleset except the evaluator,
// as the server passes them.
func readBonus(t *testing.T) Files {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(bonusDir, "*.go"))
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
	return files
}

func TestParseBonusMatchesFixture(t *testing.T) {
	var want protocol.Model
	data, err := os.ReadFile("../web/fixtures/model.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	got := Parse(readBonus(t), bonusConfig)
	got.Revision = want.Revision
	if len(got.Rules) != 26 || len(got.Inputs.Fields) != 14 || len(got.Outputs.Fields) != 5 {
		t.Fatalf("got %d rules, %d inputs, %d outputs; want 26, 14, 5", len(got.Rules), len(got.Inputs.Fields), len(got.Outputs.Fields))
	}
	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.MarshalIndent(got, "", "  ")
		wantJSON, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("model differs from fixture\n%s", firstDifference(string(gotJSON), string(wantJSON)))
	}
}

// firstDifference shows the first differing line of two texts with context.
func firstDifference(got, want string) string {
	g, w := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < len(g) || i < len(w); i++ {
		var gl, wl string
		if i < len(g) {
			gl = g[i]
		}
		if i < len(w) {
			wl = w[i]
		}
		if gl != wl {
			return "line " + strconv.Itoa(i+1) + ":\n got: " + gl + "\nwant: " + wl
		}
	}
	return "no line differs"
}

func TestParseBrokenFileKeepsRulesBeforeTheError(t *testing.T) {
	files := readBonus(t)
	src := string(files["bonus.go"])
	// Break the signature of the 20th rule, as the proposal's spike did.
	broken := strings.Replace(src, "func FinanceRequired(cappedBonusCents uint64) (financeRequired bool) {", "func FinanceRequired(cappedBonusCents uint64 (financeRequired bool) {", 1)
	if broken == src {
		t.Fatal("did not break the file")
	}
	files["bonus.go"] = []byte(broken)
	m := Parse(files, bonusConfig)
	if len(m.Rules) != 19 {
		t.Fatalf("got %d rules, want the 19 before the error", len(m.Rules))
	}
	if last := m.Rules[len(m.Rules)-1].ID; last != "CappedBonus" {
		t.Fatalf("last rule %s, want CappedBonus", last)
	}
	file := m.Files[0]
	wantLine := strings.Count(broken[:strings.Index(broken, "func FinanceRequired")], "\n") + 1
	if file.State != protocol.FileSyntaxError || file.Problem == nil || file.Problem.Line != wantLine || file.Problem.File != "bonus.go" {
		t.Fatalf("file state %+v, problem %+v; want syntax_error on line %d", file.State, file.Problem, wantLine)
	}
	if m.Files[1].State != protocol.FileOK || len(m.Inputs.Fields) != 14 {
		t.Fatalf("facts.go should still parse: %+v", m.Files[1])
	}
}

func TestParseShapes(t *testing.T) {
	src := `package rules

import (
	ctx "context"
	"errors"
)

// WithContext reads a fact after the context.
func WithContext(c ctx.Context, a int) (b int, err error) {
	return a, nil
}

// Grouped declares two reads and two results in groups.
func Grouped(a, b int) (c, d string) {
	return "", ""
}

// Unnamed has an unnamed result.
func Unnamed(a int) int {
	return a
}

// Variadic takes any number of values.
func Variadic(values ...int) (total int) {
	return 0
}

// Generic has a type parameter.
func Generic[T any](value T) (out T) {
	return value
}

// Stub TODO: state the requirement.
func Stub(a int) (b int, err error) {
	return b, errors.New("Stub is not implemented")
}

func helper() {}

func (r receiver) Method() (x int) { return 0 }

type receiver struct{}
`
	m := Parse(Files{"rules.go": []byte(src)}, Config{RuleFiles: []string{"rules.go"}, Inputs: "In", Outputs: "Out"})
	byID := make(map[string]protocol.Rule)
	var ids []string
	for _, r := range m.Rules {
		byID[r.ID] = r
		ids = append(ids, r.ID)
	}
	if strings.Join(ids, " ") != "WithContext Grouped Unnamed Variadic Generic Stub" {
		t.Fatalf("rules %v", ids)
	}
	if r := byID["WithContext"]; !r.UsesContext || !r.ReturnsError || !reflect.DeepEqual(r.Reads, []protocol.Fact{{Name: "a", Type: "int"}}) || r.Unsupported != "" {
		t.Errorf("WithContext: %+v", r)
	}
	if r := byID["Grouped"]; !reflect.DeepEqual(r.Reads, []protocol.Fact{{Name: "a", Type: "int"}, {Name: "b", Type: "int"}}) || !reflect.DeepEqual(r.Produces, []protocol.Fact{{Name: "c", Type: "string"}, {Name: "d", Type: "string"}}) {
		t.Errorf("Grouped: %+v", r)
	}
	for _, id := range []string{"Unnamed", "Variadic", "Generic"} {
		if byID[id].Unsupported == "" {
			t.Errorf("%s should be unsupported", id)
		}
	}
	if !byID["Stub"].Stub || byID["WithContext"].Stub {
		t.Errorf("stub detection: Stub %v, WithContext %v", byID["Stub"].Stub, byID["WithContext"].Stub)
	}
	if m.Inputs.Editable || m.Inputs.File != "" || m.Inputs.Type != "In" || len(m.Files) != 1 {
		t.Errorf("an undeclared contract is not editable and lists no file: %+v, files %+v", m.Inputs, m.Files)
	}
}

func TestStandardPackages(t *testing.T) {
	out, err := exec.Command("go", "list", "-f", "{{.ImportPath}} {{.Name}}", "std").Output()
	if err != nil {
		t.Skipf("go list std: %v", err)
	}
	names := make(map[string]string)
	for line := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
		path, name, _ := strings.Cut(line, " ")
		names[path] = name
	}
	for path, name := range standardPackages {
		if names[path] != name {
			t.Errorf("standardPackages has %s as %q, go list says %q", path, name, names[path])
		}
	}
}
