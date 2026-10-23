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
The phone layout shows the selected rule, its producers, and its consumers as
a dependency list. The same inspector appears inside the selected step. Choose
any rule with the rule selector or search to follow another part of the graph.

Search by rule name, fact name, or requirement. Search selects a matching rule
and highlights matches. Use the rule selector to jump directly to any function.
Scenario and rule selections, plus the search term, appear in the URL fragment.
Reload, Back, Forward, and **Copy link** preserve that selection. A copied link
requires access to the same exported HTML file.

## Export your own scenarios

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
            ID: "review",
            Label: "Finance approval pending",
            Inputs: bonus.Inputs{
                EmployeeID: "E01", Active: true, TenureMonths: 48,
                PerformanceScore: 94, SalaryCents: 8_000_000,
                Role: bonus.Specialist, Department: bonus.Engineering,
                TrainingComplete: true, CompanyTargetMet: true,
                EmployeeBudgetCents: 1_200_000,
                ManagerApproved: true, FinanceApproved: false,
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

Rule errors remain visible in the exported scenario. The inspector distinguishes
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

Values are captured as strings. JSON formatting preserves integer precision and
pointer contents. Unsupported or cyclic values display their type and formatting
error. Formatting can invoke `MarshalJSON`; keep those methods safe for
concurrent readers. Input data must remain immutable
until evaluation returns, as with `Evaluate`.

`Evaluate` does not capture or format values. Both calls use the same typed
storage, direct rule calls, and scheduler. `Ruleset()` returns fresh metadata
for the retained graph, including fact types, source comments, and source code.
Regeneration refreshes that source. Source files need not be available when
the evaluator runs or when someone opens an export.

Exports contain source and captured values. Choose scenarios suitable for the
people receiving the file. User strings are encoded as inert JSON and rendered
as text, including source snippets and error messages.

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

CI checks that the bundle is current and runs Playwright in Chromium and WebKit,
including 320px and 390px portrait widths and a 667px landscape width. Tests cover
saved scenarios, source inspection, selection history, long content, empty
graphs, and horizontal overflow. Inferrum's viewer was adapted under Apache-2.0;
its license and the layout dependencies' licenses are retained in the bundle.
