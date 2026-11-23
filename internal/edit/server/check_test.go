package server

import (
	"encoding/json"
	"go/token"
	"reflect"
	"testing"

	"github.com/vichr-vita/infergo/internal/edit/protocol"
	"github.com/vichr-vita/infergo/internal/generate"
)

// chainModel is a small ruleset: Base reads the input seed, Middle reads
// base, and Top reads middle. Top's declaration spans lines 20 to 23.
func chainModel() protocol.Model {
	fact := func(name, typ string) []protocol.Fact { return []protocol.Fact{{Name: name, Type: typ}} }
	return protocol.Model{
		Inputs:  protocol.Contract{Type: "Inputs", File: "facts.go", Editable: true, Fields: []protocol.ContractField{{Field: "Seed", Fact: "seed", Type: "int"}}},
		Outputs: protocol.Contract{Type: "Outputs", File: "facts.go", Editable: true, Fields: []protocol.ContractField{{Field: "Top", Fact: "top", Type: "int"}}},
		Rules: []protocol.Rule{
			{ID: "Base", File: "rules.go", Line: 5, Source: "// Base doubles.\nfunc Base(seed int) (base int) {\n\treturn seed * 2\n}", Reads: fact("seed", "int"), Produces: fact("base", "int")},
			{ID: "Middle", File: "rules.go", Line: 11, Source: "// Middle adds one.\nfunc Middle(base int) (middle int) {\n\treturn base + 1\n}", Reads: fact("base", "int"), Produces: fact("middle", "int")},
			{ID: "Top", File: "rules.go", Line: 21, Source: "// Top is the result.\nfunc Top(middle int) (top int) {\n\treturn middle\n}", Reads: fact("middle", "int"), Produces: fact("top", "int")},
			{ID: "Unnamed", File: "rules.go", Line: 26, Source: "// Unnamed has no result name.\nfunc Unnamed(seed int) (uint64, error) {\n\treturn 0, nil\n}", Reads: fact("seed", "int")},
		},
	}
}

func TestCycleRefusal(t *testing.T) {
	model := chainModel()
	refusal, closes := cycleRefusal(model, protocol.Op{Op: protocol.OpAddRead, Rule: "Base", Fact: "top", Type: "int"})
	if !closes || refusal.Reason != protocol.ReasonCycle || !reflect.DeepEqual(refusal.Related, []string{"Base", "Top", "Middle"}) {
		t.Fatalf("refusal = %+v, %v", refusal, closes)
	}
	for _, op := range []protocol.Op{
		{Op: protocol.OpAddRead, Rule: "Top", Fact: "base", Type: "int"},
		{Op: protocol.OpAddRead, Rule: "Base", Fact: "seed", Type: "int"},
		{Op: protocol.OpAddRead, Rule: "Base", Fact: "unknown", Type: "int"},
		{Op: protocol.OpRemoveRead, Rule: "Base", Fact: "top"},
	} {
		if refusal, closes := cycleRefusal(model, op); closes {
			t.Errorf("%+v refused: %+v", op, refusal)
		}
	}
}

func TestDiagnosticsCarryFixes(t *testing.T) {
	model := chainModel()
	position := func(line int) token.Position { return token.Position{Filename: "rules.go", Line: line, Column: 2} }
	requested := true
	for _, test := range []struct {
		name  string
		found generate.Diagnostic
		rule  string
		fixes []protocol.Fix
	}{
		{
			name:  "missing producer",
			found: generate.Diagnostic{Kind: generate.KindMissingProducer, Rule: "Top", Fact: "midle", Suggestion: "middle", Position: position(21)},
			rule:  "Top",
			// Top does not read midle, so no type is known for a new input or rule.
			fixes: []protocol.Fix{{Label: "Rename to middle", Op: protocol.Op{Op: protocol.OpRenameFact, Fact: "midle", To: "middle"}}},
		},
		{
			name:  "missing producer with a known type",
			found: generate.Diagnostic{Kind: generate.KindMissingProducer, Rule: "Top", Fact: "middle", Suggestion: "midle", Position: position(21)},
			rule:  "Top",
			fixes: []protocol.Fix{
				{Label: "Rename to midle", Op: protocol.Op{Op: protocol.OpRenameFact, Fact: "middle", To: "midle"}},
				{Label: "Add input middle", Op: protocol.Op{Op: protocol.OpAddInput, Fact: "middle", Type: "int"}},
				// No rule is offered, because a rule named Middle exists.
			},
		},
		{
			name:  "missing producer of an output",
			found: generate.Diagnostic{Kind: generate.KindMissingProducer, Fact: "top", Position: token.Position{Filename: "facts.go", Line: 3, Column: 2}},
			fixes: []protocol.Fix{
				// The type comes from the output field. A rule named Top exists.
				{Label: "Add input top", Op: protocol.Op{Op: protocol.OpAddInput, Fact: "top", Type: "int"}},
			},
		},
		{
			name:  "type mismatch",
			found: generate.Diagnostic{Kind: generate.KindTypeMismatch, Rule: "Top", Fact: "middle", Related: []string{"Middle"}},
			rule:  "Top",
			fixes: []protocol.Fix{{Label: "Use int in Top", Op: protocol.Op{Op: protocol.OpSetType, Rule: "Top", Fact: "middle", Type: "int"}}},
		},
		{
			name:  "duplicate producer",
			found: generate.Diagnostic{Kind: generate.KindDuplicateProducer, Rule: "Top", Fact: "middle", Related: []string{"Middle"}},
			rule:  "Top",
			fixes: []protocol.Fix{
				{Label: "Rename the result in Top", Op: protocol.Op{Op: protocol.OpRenameFact, Rule: "Top", Fact: "middle", To: "top2"}},
				{Label: "Rename the result in Middle", Op: protocol.Op{Op: protocol.OpRenameFact, Rule: "Middle", Fact: "middle", To: "middle2"}},
			},
		},
		{
			name:  "cycle",
			found: generate.Diagnostic{Kind: generate.KindCycle, Rule: "Middle", Related: []string{"Middle", "Base"}},
			rule:  "Middle",
			fixes: []protocol.Fix{{Label: "Remove base from Middle", Op: protocol.Op{Op: protocol.OpRemoveRead, Rule: "Middle", Fact: "base"}}},
		},
		{
			name:  "unnamed result",
			found: generate.Diagnostic{Kind: generate.KindSignature, Rule: "Unnamed", Position: position(26)},
			rule:  "Unnamed",
			fixes: []protocol.Fix{{Label: "Name the result unnamed", Op: protocol.Op{Op: protocol.OpAddProduce, Rule: "Unnamed", Fact: "unnamed", Type: "uint64"}}},
		},
		{
			name:  "go error inside a rule",
			found: generate.Diagnostic{Kind: generate.KindGo, Position: position(22)},
			rule:  "Top",
			fixes: []protocol.Fix{},
		},
		{
			name:  "go error on the doc comment",
			found: generate.Diagnostic{Kind: generate.KindGo, Position: position(20)},
			rule:  "Top",
			fixes: []protocol.Fix{},
		},
		{
			name:  "go error between rules",
			found: generate.Diagnostic{Kind: generate.KindGo, Position: position(19)},
			fixes: []protocol.Fix{},
		},
		{
			name:  "unused rule",
			found: generate.Diagnostic{Kind: generate.KindUnusedRule, Rule: "Middle", Severity: generate.SeverityWarning},
			rule:  "Middle",
			fixes: []protocol.Fix{
				{Label: "Request middle as an output", Op: protocol.Op{Op: protocol.OpSetRequested, Fact: "middle", Requested: &requested}},
				{Label: "Delete Middle", Op: protocol.Op{Op: protocol.OpDeleteRule, Rule: "Middle"}},
			},
		},
		{
			name:  "unused input",
			found: generate.Diagnostic{Kind: generate.KindUnusedInput, Fact: "seed", Severity: generate.SeverityWarning},
			fixes: []protocol.Fix{{Label: "Remove input seed", Op: protocol.Op{Op: protocol.OpRemoveInput, Fact: "seed"}}},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			converted := diagnostics([]generate.Diagnostic{test.found}, model)[0]
			if converted.Rule != test.rule {
				t.Errorf("rule = %q, want %q", converted.Rule, test.rule)
			}
			got, err := json.Marshal(converted.Fixes)
			if err != nil {
				t.Fatal(err)
			}
			want, err := json.Marshal(test.fixes)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Errorf("fixes =\n%s\nwant\n%s", got, want)
			}
		})
	}
}
