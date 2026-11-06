# Visualize a ruleset

Infergo exports an offline HTML page with an explorable rule graph, saved
evaluation scenarios, fact values, and a Go source inspector. Click a rule to
inspect its requirement, inputs, outputs, and execution outcome. Follow an
input's producer link to trace it upstream.

## Open the bonus viewer

From a checkout, run:

```sh
go run ./examples/bonus-viewer /tmp/infergo-bonus.html
```

Open `/tmp/infergo-bonus.html` in a browser. The page includes the 14 bonus
scenarios and an unsupported-role failure. It needs no server, network, or Node
installation. The JavaScript and layout engine are embedded in the exported
file.

The initial view selects the producer of the first requested output, which is
`FinalBonus` in the bonus example. Pan the graph by dragging or
scrolling, use the zoom buttons, or choose **Fit map** and **Actual size**.
With the graph focused, `+` and `-` zoom, `0` fits, and `1` restores actual size.
Pinch zoom works with touch and trackpads. Arrow keys use native scrolling.
At window widths of 1100px or less, the page hides the graph and its controls
and shows the selected rule, its producers, and its consumers as a dependency
list. Widen the window to get the graph back. The same inspector appears inside
the selected step. Choose any rule with the rule selector or search to follow
another part of the graph.

Search by rule name, fact name, or requirement. Search selects a matching rule
and highlights matches. Use the rule selector to jump directly to any function.
Scenario and rule selections, plus the search term, appear in the URL fragment.
Reload, Back, Forward, and **Copy link** preserve that selection. A copied link
requires access to the same exported HTML file.

## Open your own graph

> [v0.1.1 has no `view` command](generator.md#v011-differences).

Run this from your ruleset directory:

```sh
go tool infergen view --rules rules.go --open
```

The command reads the same flags, `INFERGEN_` variables, and config file as
generation, so you can drop `--rules` if a config file selects your rules.
`--open` works only on the command line.

`go tool infergen view` shows topology only: rules, facts, requirements, and source. It
never runs a rule, so the page has no scenarios or fact values. You write no Go
program, and the command needs no generated file. The page reflects your current
source even when the generated evaluator is stale.

The page goes to `infergo-<package>-<hash>.html` in the system temporary
directory, and the command prints that path. The hash comes from the ruleset
directory, so same-named packages keep separate pages. Use `--html` to choose
another `.html` or `.htm` file. The command replaces only topology pages, so it
will not overwrite a scenario report from `ExportHTML`. See the
[generator reference](generator.md#view-the-rule-graph) for every option.

## Export your own scenarios

To save scenarios and their fact values, call the generated `ExportHTML`.
Regenerate your evaluator after upgrading Infergo:

```sh
go generate ./...
```

The generated ruleset package has `ViewerCase` and `ExportHTML`. This example
uses the included bonus ruleset:

```go
package main

import (
	"context"
	"log"
	"os"

	"github.com/vichr-vita/infergo/ruleset/bonus"
)

func main() {
	html, err := bonus.ExportHTML(context.Background(), "Bonus review", []bonus.ViewerCase{
		{
			ID:    "review",
			Label: "Finance approval pending",
			Inputs: bonus.Inputs{
				EmployeeID: "E01", Active: true, TenureMonths: 48,
				PerformanceScore: 94, SalaryCents: 8_000_000,
				Role: bonus.Specialist, Department: bonus.Engineering,
				TrainingComplete: true, CompanyTargetMet: true,
				EmployeeBudgetCents: 1_200_000,
				ManagerApproved:     true, FinanceApproved: false,
				CriticalSkill: true,
			},
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile("bonus.html", []byte(html), 0o644); err != nil {
		log.Fatal(err)
	}
}
```

Each case has a unique, nonblank `ID`, a display `Label`, typed `Inputs`, and
optional execution `Options`. Each export evaluates every scenario once.
Changing the scenario in the browser displays the captured snapshot. To evaluate
different inputs, regenerate the file. Passing `nil` cases exports the topology
without executing rules.

Rule errors remain visible in the exported scenario. A panic in a rule aborts the
export and returns no HTML. The inspector distinguishes
`Succeeded`, `Failed`, `Canceled`, and `Not run`. A successful `false`, zero, or
`nil` remains a fact. An unavailable value means its producer did not publish it.
The graph shows declared dependencies, not a timeline or conditional execution
branches. All retained rules run on a successful evaluation, including consumers
of nil pointers.

Invalid case IDs fail before callbacks run. Canceling the export context returns
an error instead of a partial HTML file. An individual rule that returns a
cancellation error appears as canceled when the export's own context is still
active. Started rules still finish before evaluation returns.

## Inspect a snapshot in Go

Generated `EvaluateTrace` accepts the same arguments as `Evaluate` and returns
the output contract, an `infergo.Snapshot`, and an error:

```go
result, snapshot, err := bonus.EvaluateTrace(ctx, inputs, options)
```

On error, `result` is the zero output struct. The snapshot separately retains
input values, successful intermediate values, rule outcomes, and the evaluation
error. Each rule owns its trace entry during parallel evaluation. Concurrent
evaluations use separate snapshots.

```go
type Snapshot struct {
	Inputs map[string]string
	Trace  []RuleTrace
	Error  string
}

type RuleTrace struct {
	Rule  string
	Kind  string
	Error string
	Facts map[string]string
}
```

`Snapshot.Inputs` maps each input fact to its formatted value. `Trace` has one
entry for each retained rule. `Snapshot.Error` holds the evaluation error, or is
empty on success. In each `RuleTrace`, `Rule` is the rule's name. `Facts` maps its
output facts to formatted values and is empty unless the rule succeeded.
`RuleTrace.Error` holds the rule's own error text, without the `rule <name>:`
prefix of `Snapshot.Error`.

| `Kind` | Viewer label | Meaning |
| --- | --- | --- |
| `succeeded` | Succeeded | The rule returned no error. |
| `failed` | Failed | The rule returned an error. |
| `canceled` | Canceled | The rule returned an error matching `context.Canceled` or `context.DeadlineExceeded`. |
| `not_run` | Not run | The rule never ran, because a dependency failed or evaluation stopped first. |

This loop prints each rule's outcome:

```go
for _, rule := range snapshot.Trace {
	fmt.Println(rule.Rule, rule.Kind, rule.Error)
}
```

Values are captured as strings. `FormatValue` uses `encoding/json`, which
preserves integer precision and pointer contents. It also omits unexported fields
and writes `[]byte` as base64, so a struct with only unexported fields displays
as `{}`. Unsupported or cyclic values display their type and formatting error.
Formatting can invoke `MarshalJSON`; keep those methods safe for concurrent
readers. Input data must remain immutable until evaluation returns, as with
`Evaluate`.

The viewer adds thousands separators to non-negative integers, and a ` c` suffix
when the fact name ends in `Cents` or `_cents`. A `year` of 2026 displays as
`2,026`, while its `Snapshot` string stays `2026`.

`Evaluate` does not capture or format values. Both calls use the same typed
storage, direct rule calls, and scheduler. `Ruleset()` returns fresh metadata
for the retained graph, including fact types, source comments, and source code.
Regeneration refreshes that source. Source files need not be available when
the evaluator runs or when someone opens an export.

Exports contain source and captured values. Choose scenarios suitable for the
people receiving the file. User strings are encoded as inert JSON and rendered
as text, including source snippets and error messages.

### Snapshot and viewer API

Each generated ruleset package declares these for callers:

```go
func EvaluateTrace(ctx context.Context, input Inputs, options infergo.Options) (Outputs, infergo.Snapshot, error)
func Ruleset() infergo.Ruleset
func ExportHTML(ctx context.Context, title string, cases []ViewerCase) (string, error)

type ViewerCase = infergo.ViewerCase[Inputs]
```

`title` sets the page heading and the browser tab. The `infergo` package defines
the types behind them. `Ruleset`, `RuleSpec`, `FactSpec`, and the snapshot structs
also have `json` tags, but `ViewerCase` does not:

```go
type ViewerCase[I any] struct {
	ID      string
	Label   string
	Inputs  I
	Options Options
}

type Ruleset struct {
	Inputs  []FactSpec
	Outputs []FactSpec
	Rules   []RuleSpec
}

type RuleSpec struct {
	ID          string
	Requirement string
	Source      string
	Inputs      []FactSpec
	Outputs     []FactSpec
}

type FactSpec struct {
	Name string
	Type string
}
```

`RuleSpec.ID` is the rule function's name, `Requirement` is its doc comment, and
`Source` is its Go source. `FactSpec.Type` is the fact's Go type as text.

The `infergo` package also exports these for generated code, so most applications
do not call them:

```go
func ExportHTML[I, O any](
	ctx context.Context,
	title string,
	ruleset Ruleset,
	cases []ViewerCase[I],
	evaluate func(context.Context, I, Options) (O, Snapshot, error),
) (string, error)

func FormatValue(value any) string

func (t *RuleTrace) Complete(err error)
```

`infergo.ExportHTML` builds the page for the generated `ExportHTML` and for
`infergen view`. `FormatValue` produces the strings in a snapshot, and `Complete`
records a rule's `Kind` and `Error`.

## Maintain the viewer

The TypeScript viewer and HTML template live in `viewer/`. The checked-in
`viewer.js` bundle lets Go consumers export HTML without a JavaScript build.
After changing viewer code:

```sh
npm ci
npm run build:viewer
npx playwright install chromium webkit
npm run test:ui
```

Linux hosts may need more for WebKit, as the [development
guide](../CONTRIBUTING.md#verify-a-change) explains.

CI checks that the bundle is current and runs Playwright in Chromium and WebKit,
including 320px and 390px portrait widths and a 667px landscape width. Tests cover
saved scenarios, source inspection, selection history, long content, empty
graphs, and horizontal overflow. Inferrum's viewer was adapted under Apache-2.0;
its license and the layout dependencies' licenses are retained in the bundle.
