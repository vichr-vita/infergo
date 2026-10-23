package infergo

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestExportHTMLSnapshotsAndSafeEmbedding(t *testing.T) {
	attack := "</script><img src=x onerror=alert(1)> & \u2028\u2029"
	ruleset := Ruleset{
		Inputs: []FactSpec{{Name: "seed", Type: "string"}},
		Rules: []RuleSpec{
			{ID: "First", Requirement: attack, Source: attack, Inputs: []FactSpec{{Name: "seed"}}, Outputs: []FactSpec{{Name: "value"}}},
			{ID: "Second", Inputs: []FactSpec{{Name: "value"}}},
		},
	}
	calls := 0
	evaluate := func(_ context.Context, input string, _ Options) (int, Snapshot, error) {
		calls++
		return 0, Snapshot{Inputs: map[string]string{"seed": FormatValue(input)}, Trace: []RuleTrace{
			{Rule: "First", Kind: "succeeded", Facts: map[string]string{"value": "false"}},
			{Rule: "Second", Kind: "failed", Error: attack, Facts: map[string]string{}},
		}}, errors.New("failed")
	}
	html, err := ExportHTML(t.Context(), attack, ruleset, []ViewerCase[string]{{ID: "case", Label: attack, Inputs: attack}}, evaluate)
	if err != nil || calls != 1 {
		t.Fatalf("export: %v, calls: %d", err, calls)
	}
	raw := strings.Split(strings.Split(html, "type=\"application/json\">")[1], "</script>")[0]
	if strings.Contains(raw, "<") || strings.Contains(raw, "\u2028") {
		t.Fatal("embedded JSON contains executable HTML delimiters")
	}
	var data struct {
		Title string
		Cases []viewerCase
		Edges []graphEdge
	}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		t.Fatal(err)
	}
	if data.Title != attack || data.Cases[0].Label != attack || data.Cases[0].Error != "failed" || data.Cases[0].Trace[1].Error != attack {
		t.Fatalf("snapshot changed: %+v", data)
	}
	if len(data.Edges) != 1 || data.Edges[0] != (graphEdge{From: 0, To: 1, Fact: "value"}) {
		t.Fatalf("edges: %+v", data.Edges)
	}
	for _, invalid := range [][]ViewerCase[string]{{{ID: " "}}, {{ID: "same"}, {ID: "same"}}} {
		if _, err := ExportHTML(t.Context(), "", ruleset, invalid, evaluate); err == nil || calls != 1 {
			t.Fatalf("invalid IDs ran callbacks: %v, %d", err, calls)
		}
	}
	if _, err := ExportHTML(t.Context(), "Topology", ruleset, nil, evaluate); err != nil || calls != 1 {
		t.Fatalf("topology export: %v, %d", err, calls)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ExportHTML(ctx, "Canceled", ruleset, []ViewerCase[string]{{ID: "one"}}, evaluate); !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("canceled export: %v, %d", err, calls)
	}
}

func TestSnapshotValueFormattingAndOutcomes(t *testing.T) {
	value := uint64(18_446_744_073_709_551_615)
	for _, tt := range []struct {
		value any
		want  string
	}{{value, "18446744073709551615"}, {&value, "18446744073709551615"}, {(*int)(nil), "nil"}, {false, "false"}, {0, "0"}} {
		if got := FormatValue(tt.value); got != tt.want {
			t.Errorf("formatted %v as %s, want %s", tt.value, got, tt.want)
		}
	}
	cycle := make(map[string]any)
	cycle["self"] = cycle
	if got := FormatValue(cycle); !strings.Contains(got, "cycle") {
		t.Fatalf("cyclic fact did not report its formatting error: %s", got)
	}
	for _, tt := range []struct {
		err  error
		kind string
	}{{nil, "succeeded"}, {errors.New("failure"), "failed"}, {context.Canceled, "canceled"}, {context.DeadlineExceeded, "canceled"}} {
		trace := RuleTrace{Kind: "not_run"}
		trace.Complete(tt.err)
		if trace.Kind != tt.kind {
			t.Errorf("outcome %v: %s", tt.err, trace.Kind)
		}
	}
}
