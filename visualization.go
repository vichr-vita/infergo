package infergo

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// FactSpec describes a named, typed fact without its runtime value.
type FactSpec struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// RuleSpec is the generated source and fact contract of one retained rule.
type RuleSpec struct {
	ID          string     `json:"id"`
	Requirement string     `json:"requirement"`
	Source      string     `json:"source"`
	Inputs      []FactSpec `json:"inputs"`
	Outputs     []FactSpec `json:"outputs"`
}

// Ruleset describes the graph retained for the requested output contract.
type Ruleset struct {
	Inputs  []FactSpec `json:"inputs"`
	Outputs []FactSpec `json:"outputs"`
	Rules   []RuleSpec `json:"rules"`
}

// RuleTrace records one completed invocation. Not-run rules have no facts.
// Each generated callback owns a distinct trace entry, including in parallel runs.
type RuleTrace struct {
	Rule  string            `json:"rule"`
	Kind  string            `json:"kind"`
	Error string            `json:"error,omitempty"`
	Facts map[string]string `json:"facts"`
}

// Complete records the callback outcome. A successful nil or zero is still a fact.
func (t *RuleTrace) Complete(err error) {
	t.Kind = "succeeded"
	if err != nil {
		t.Kind = "failed"
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			t.Kind = "canceled"
		}
		t.Error = err.Error()
	}
}

// Snapshot contains diagnostic values, including successful intermediates when
// evaluation failed. These values are separate from the evaluator's result.
type Snapshot struct {
	Inputs map[string]string `json:"inputs"`
	Trace  []RuleTrace       `json:"trace"`
	Error  string            `json:"error,omitempty"`
}

// FormatValue copies a fact's printable value for a snapshot. JSON preserves
// integers and pointer contents. Unsupported or cyclic values display their
// type and formatting error. Formatting may call user-defined MarshalJSON methods.
func FormatValue(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("<%T: %v>", value, err)
	}
	if string(data) == "null" {
		return "nil"
	}
	return string(data)
}

// ViewerCase supplies inputs to evaluate once while exporting an offline viewer.
type ViewerCase[I any] struct {
	ID      string
	Label   string
	Inputs  I
	Options Options
}

type viewerCase struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Snapshot
}

type graphEdge struct {
	From int    `json:"from"`
	To   int    `json:"to"`
	Fact string `json:"fact"`
}

//go:embed viewer/viewer.html
var viewerTemplate string

//go:embed viewer/viewer.js
var viewerScript string

// ExportHTML evaluates each case once and returns a self-contained HTML viewer.
// Rule failures are saved in the viewer. Invalid IDs and export cancellation
// return an error. No cases exports the topology without executing rules.
// The file includes source and captured values; choose inputs safe to share.
func ExportHTML[I, O any](ctx context.Context, title string, ruleset Ruleset, cases []ViewerCase[I], evaluate func(context.Context, I, Options) (O, Snapshot, error)) (string, error) {
	seen := make(map[string]bool, len(cases))
	for _, c := range cases {
		if strings.TrimSpace(c.ID) == "" || seen[c.ID] {
			return "", fmt.Errorf("infergo: viewer case IDs must be unique and nonempty: %q", c.ID)
		}
		seen[c.ID] = true
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	snapshots := make([]viewerCase, 0, len(cases))
	for _, c := range cases {
		_, snapshot, err := evaluate(ctx, c.Inputs, c.Options)
		if err != nil {
			snapshot.Error = err.Error()
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		snapshots = append(snapshots, viewerCase{ID: c.ID, Label: c.Label, Snapshot: snapshot})
	}
	producers := make(map[string]int)
	rules := make([]RuleSpec, len(ruleset.Rules))
	copy(rules, ruleset.Rules)
	for id := range rules {
		// Encode empty contracts as arrays, including hand-built metadata.
		if rules[id].Inputs == nil {
			rules[id].Inputs = []FactSpec{}
		}
		if rules[id].Outputs == nil {
			rules[id].Outputs = []FactSpec{}
		}
		rule := rules[id]
		for _, fact := range rule.Outputs {
			producers[fact.Name] = id
		}
	}
	edges := make([]graphEdge, 0)
	for id, rule := range ruleset.Rules {
		for _, fact := range rule.Inputs {
			if from, ok := producers[fact.Name]; ok {
				edges = append(edges, graphEdge{From: from, To: id, Fact: fact.Name})
			}
		}
	}
	data, err := json.Marshal(struct {
		Title       string       `json:"title"`
		InputCount  int          `json:"inputCount"`
		OutputCount int          `json:"outputCount"`
		Outputs     []FactSpec   `json:"outputs"`
		Rules       []RuleSpec   `json:"rules"`
		Edges       []graphEdge  `json:"edges"`
		Cases       []viewerCase `json:"cases"`
	}{title, len(ruleset.Inputs), len(ruleset.Outputs), ruleset.Outputs, rules, edges, snapshots})
	if err != nil {
		return "", fmt.Errorf("infergo: encode viewer: %w", err)
	}
	// encoding/json escapes HTML delimiters and U+2028/U+2029. Keep case data
	// inert and replace the template marker once, never inside user content.
	content := "<script id=\"infergo-data\" type=\"application/json\">" + string(data) + "</script>\n<script>" + viewerScript + "</script>"
	return strings.Replace(viewerTemplate, "<!-- INFERGO_DATA -->", content, 1), nil
}
