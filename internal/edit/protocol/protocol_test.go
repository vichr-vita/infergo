package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// decodeStrict decodes JSON into v and fails on unknown fields.
func decodeStrict(t *testing.T, data []byte, v any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

// findNulls lists the paths of null values in decoded JSON, except for the
// Trace.Facts of a rule that did not run, which is null by design.
func findNulls(path string, v any) []string {
	switch v := v.(type) {
	case nil:
		if strings.HasSuffix(path, ".facts") {
			return nil
		}
		return []string{path}
	case map[string]any:
		var found []string
		for key, child := range v {
			found = append(found, findNulls(path+"."+key, child)...)
		}
		return found
	case []any:
		var found []string
		for i, child := range v {
			found = append(found, findNulls(fmt.Sprintf("%s[%d]", path, i), child)...)
		}
		return found
	}
	return nil
}

// readFixture loads one fixture file from the web package.
func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "web", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFixturesRoundTrip(t *testing.T) {
	for _, fixture := range []struct {
		file string
		into any
	}{
		{"model.json", &Model{}},
		{"check.json", &Check{}},
		{"values.json", &Values{}},
		{"history.json", &History{}},
	} {
		t.Run(fixture.file, func(t *testing.T) {
			data := readFixture(t, fixture.file)
			decodeStrict(t, data, fixture.into)
			encoded, err := json.Marshal(fixture.into)
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			if err := json.Unmarshal(data, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Errorf("re-encoded %s differs from the file\nfile: %v\ngot:  %v", fixture.file, want, got)
			}
			if nulls := findNulls("$", want); len(nulls) > 0 {
				t.Errorf("%s has null where a value is required: %v", fixture.file, nulls)
			}
			if nulls := findNulls("$", got); len(nulls) > 0 {
				t.Errorf("re-encoded %s has null: %v", fixture.file, nulls)
			}
		})
	}
}

func TestModelFixture(t *testing.T) {
	var model Model
	decodeStrict(t, readFixture(t, "model.json"), &model)
	if len(model.Rules) != 26 || len(model.Inputs.Fields) != 14 || len(model.Outputs.Fields) != 5 {
		t.Fatalf("got %d rules, %d inputs, %d outputs", len(model.Rules), len(model.Inputs.Fields), len(model.Outputs.Fields))
	}
	for _, rule := range model.Rules {
		if rule.SourceHash != Hash([]byte(rule.Source)) {
			t.Errorf("rule %s: sourceHash does not match its source", rule.ID)
		}
		if strings.Contains(rule.Requirement, "\n") || !strings.HasPrefix(rule.Requirement, rule.ID+" ") {
			t.Errorf("rule %s: requirement %q is not one paragraph starting with the name", rule.ID, rule.Requirement)
		}
		if !strings.Contains(rule.Source, "\nfunc "+rule.ID+"(") || strings.HasSuffix(rule.Source, "\n") {
			t.Errorf("rule %s: source is not a doc comment and declaration without a trailing newline", rule.ID)
		}
	}
}

func TestCheckFixtureCoversEveryKind(t *testing.T) {
	var check Check
	decodeStrict(t, readFixture(t, "check.json"), &check)
	kinds := []string{
		KindMissingProducer, KindTypeMismatch, KindDuplicateProducer, KindCycle, KindSignature,
		KindContract, KindReserved, KindGo, KindUnusedRule, KindUnusedInput,
	}
	seen := map[string]int{}
	for _, diagnostic := range check.Diagnostics {
		seen[diagnostic.Kind]++
		for _, fix := range diagnostic.Fixes {
			if err := fix.Op.Validate(); err != nil {
				t.Errorf("%s fix %q: %v", diagnostic.Kind, fix.Label, err)
			}
		}
	}
	for _, kind := range kinds {
		if seen[kind] != 1 {
			t.Errorf("kind %s appears %d times, want 1", kind, seen[kind])
		}
	}
	if len(seen) != len(kinds) || check.OK || len(check.Pruned) == 0 {
		t.Errorf("want a failing check with pruned rules and only the ten kinds, got %v ok=%v pruned=%v", seen, check.OK, check.Pruned)
	}
}

func TestZeroValuesEncodeArrays(t *testing.T) {
	for name, value := range map[string]any{
		"model":    Model{},
		"check":    Check{},
		"history":  History{},
		"values":   Values{},
		"snapshot": Snapshot{},
		"preview":  PreviewReply{},
		"receipt":  Receipt{},
		"rule":     Rule{},
		"diag":     Diagnostic{},
		"contract": Contract{},
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(name, err)
		}
		var decoded any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(name, err)
		}
		if nulls := findNulls("$", decoded); len(nulls) > 0 {
			t.Errorf("%s encodes null at %v: %s", name, nulls, encoded)
		}
	}
}

func TestOpEncoding(t *testing.T) {
	yes := true
	for _, tt := range []struct {
		name string
		op   Op
		want string
	}{
		{"add_rule always sends reads and produces", Op{Op: OpAddRule, Name: "Top", Produces: []Fact{{"topCents", "uint64"}}}, `{"op":"add_rule","name":"Top","reads":[],"produces":[{"name":"topCents","type":"uint64"}]}`},
		{"requested false is kept", Op{Op: OpSetRequested, Fact: "a", Requested: new(bool)}, `{"op":"set_requested","fact":"a","requested":false}`},
		{"requested true", Op{Op: OpSetRequested, Fact: "a", Requested: &yes}, `{"op":"set_requested","fact":"a","requested":true}`},
		{"replace_source format", Op{Op: OpReplaceSource, Rule: "R", Text: "x", Base: "h", Format: true}, `{"op":"replace_source","rule":"R","text":"x","base":"h","format":true}`},
		{"remove_read omits the rest", Op{Op: OpRemoveRead, Rule: "R", Fact: "f"}, `{"op":"remove_read","rule":"R","fact":"f"}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := json.Marshal(tt.op)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
			var back Op
			decodeStrict(t, got, &back)
			again, _ := json.Marshal(back)
			if !bytes.Equal(got, again) {
				t.Errorf("decoding and encoding again gave %s", again)
			}
		})
	}
}

func TestReceiptUndoable(t *testing.T) {
	no := false
	if !(Receipt{}).CanUndo() || (Receipt{Undoable: &no}).CanUndo() {
		t.Error("CanUndo: absent must mean true and false must mean false")
	}
	encoded, _ := json.Marshal(Receipt{Undoable: &no})
	if !strings.Contains(string(encoded), `"undoable":false`) {
		t.Errorf("false undoable must be encoded, got %s", encoded)
	}
	encoded, _ = json.Marshal(Receipt{})
	if strings.Contains(string(encoded), "undoable") {
		t.Errorf("absent undoable must be omitted, got %s", encoded)
	}
}

func TestOpValidate(t *testing.T) {
	yes := true
	valid := []Op{
		{Op: OpAddRead, Rule: "R", Fact: "f", Type: "int"},
		{Op: OpRemoveRead, Rule: "R", Fact: "f"},
		{Op: OpAddRule, Name: "R", Produces: []Fact{{"f", "int"}}},
		{Op: OpDeleteRule, Rule: "R"},
		{Op: OpRenameRule, Rule: "R", To: "S"},
		{Op: OpRenameFact, Fact: "f", To: "g"},
		{Op: OpSetRequirement, Rule: "R", Text: "R does x."},
		{Op: OpAddProduce, Rule: "R", Fact: "f", Type: "int"},
		{Op: OpRemoveProduce, Rule: "R", Fact: "f"},
		{Op: OpSetType, Rule: "R", Fact: "f", Type: "int"},
		{Op: OpAddInput, Fact: "f", Type: "int"},
		{Op: OpRemoveInput, Fact: "f"},
		{Op: OpSetRequested, Fact: "f", Requested: &yes},
		{Op: OpReplaceSource, Rule: "R", Text: "func R() {}", Base: "abc"},
	}
	for _, op := range valid {
		if err := op.Validate(); err != nil {
			t.Errorf("%s: %v", op.Op, err)
		}
	}
	invalid := []struct {
		name string
		op   Op
		want string
	}{
		{"empty", Op{}, "unknown operation"},
		{"unknown", Op{Op: "explode"}, "unknown operation"},
		{"add_read without type", Op{Op: OpAddRead, Rule: "R", Fact: "f"}, "type"},
		{"rename_rule without target", Op{Op: OpRenameRule, Rule: "R"}, "to"},
		{"add_rule without produces", Op{Op: OpAddRule, Name: "R"}, "produces"},
		{"add_rule with untyped read", Op{Op: OpAddRule, Name: "R", Reads: []Fact{{Name: "a"}}, Produces: []Fact{{"f", "int"}}}, "without a name or type"},
		{"set_requested without flag", Op{Op: OpSetRequested, Fact: "f"}, "requested"},
		{"replace_source without base", Op{Op: OpReplaceSource, Rule: "R", Text: "x"}, "base"},
	}
	for _, tt := range invalid {
		err := tt.op.Validate()
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: got %v, want an error mentioning %q", tt.name, err, tt.want)
		}
	}
	// Every operation name has a case above, so a new one cannot go untested.
	names := []string{OpAddRead, OpRemoveRead, OpAddRule, OpDeleteRule, OpRenameRule, OpRenameFact, OpSetRequirement,
		OpAddProduce, OpRemoveProduce, OpSetType, OpAddInput, OpRemoveInput, OpSetRequested, OpReplaceSource}
	if len(names) != 14 || len(required) != 14 {
		t.Errorf("want 14 operations, got %d names and %d requirement lists", len(names), len(required))
	}
	for _, op := range valid {
		if !slices.Contains(names, op.Op) {
			t.Errorf("unlisted operation %q", op.Op)
		}
	}
}

func TestAsRefusal(t *testing.T) {
	refusal := Refusal{Reason: ReasonCycle, Message: "would close a cycle", Related: []string{"A", "B"}}
	var err error = refusal
	if err.Error() != refusal.Message {
		t.Errorf("Error() = %q", err.Error())
	}
	got, ok := AsRefusal(fmt.Errorf("apply: %w", err))
	if !ok || !reflect.DeepEqual(got, refusal) {
		t.Errorf("wrapped refusal: got %v, %v", got, ok)
	}
	if _, ok := AsRefusal(errors.New("disk full")); ok {
		t.Error("an ordinary error is not a refusal")
	}
	if _, ok := AsRefusal(nil); ok {
		t.Error("nil is not a refusal")
	}
}

func TestHash(t *testing.T) {
	if got := Hash(nil); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("Hash(nil) = %s", got)
	}
	if got := Hash([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("Hash(abc) = %s", got)
	}
}
