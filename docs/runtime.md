# Runtime and API reference

Most applications call the generated `Evaluate` function. The public `infergo`
package also exposes a dependency scheduler for callers that supply their own
rule dispatch and storage. This page covers both interfaces and their execution
semantics. The implementation is in [plan.go](../plan.go).

## Generated Evaluate

With the default contract names, the generated function is:

```go
func Evaluate(ctx context.Context, input Inputs, options infergo.Options) (Outputs, error)
```

It allocates fact storage for this call, runs the precomputed plan, and returns
the requested fields on success. Any returned error produces a zero `Outputs`
struct, including errors from options validation or cancellation. Successful
calls can still return zero, false, or nil field values.

Pass a non-nil context, such as `context.Background()` or a request context. Each
call receives its own execution context derived from that parent. Rules with a
first `context.Context` parameter receive this derived context and can access
the parent's values and deadline.

The plan is shared and immutable. Fact storage is private to the call, but Go
values can still reference shared data. Inputs are copied by value; referenced
maps, slices, pointers, and interface contents are not deep-copied. Return values
can also share references with inputs. Follow the [immutability
contract](rulesets.md#keep-facts-immutable).

## Options

```go
type Options struct {
    MaxParallel int
}
```

| Value | Behavior |
| --- | --- |
| Negative | Return `infergo: MaxParallel must not be negative` before running rules. |
| `0` or `1` | Run sequentially in the caller's goroutine, without worker goroutines. |
| Greater than `1` | Run ready rules with at most this many workers per evaluation. |

The worker count is capped at the number of rules in the plan. If that leaves
at most one rule, execution uses the sequential path. A larger limit does not
make dependent rules run simultaneously and does not necessarily improve speed.
Measure with representative rules before choosing a limit.

The limit is per evaluation, not global. Ten overlapping evaluations with a
limit of four can run up to forty rules at once. Goroutines started inside a
rule are outside the scheduler's limit. Apply any application-wide admission
limit in the calling code.

## Readiness and ordering

A root rule has no rule producers to wait for. A dependent rule becomes ready
only after every producer succeeds. Several inputs from the same producer count
as one dependency. Successful completion makes all that rule's outputs visible
to its consumers, including zero and nil values.

Sequential execution follows a precomputed topological order. Parallel execution
dispatches ready rules as capacity becomes available. A dependent can start
while an unrelated rule is still running; there are no graph-wide execution
barriers between levels.

Do not depend on a particular ordering between independent rules. To express a
real dependency, consume a fact from the producer. The scheduler does not infer
dependencies from global variables or external side effects.

## Errors and cancellation

When a rule returns a non-nil trailing error, the generated code publishes none
of that rule's outputs. The runtime returns an `*infergo.RuleError`:

```go
type RuleError struct {
    Rule string
    Err  error
}
```

`Rule` contains the Go rule function's name. `Err` is the original error.
`Error()` formats it as `rule <name>: <error>`, and `Unwrap()` returns `Err`.
Use `errors.As` to inspect the rule and `errors.Is` to match the cause. For an
`err` returned by `Evaluate`, this snippet uses the `errors`, `fmt`, `context`,
and `infergo` packages:

```go
var ruleErr *infergo.RuleError
if errors.As(err, &ruleErr) {
    fmt.Printf("%s failed: %v\n", ruleErr.Rule, ruleErr.Err)
}
if errors.Is(err, context.Canceled) {
    fmt.Println("evaluation was canceled")
}
```

On a failure observed by the scheduler or caller cancellation:

1. The scheduler stops dispatching work.
2. It cancels the execution context to signal running rules.
3. It waits for started rule calls to return.
4. `Evaluate` returns the error and zero outputs.

Unrelated rules may already have run or been dispatched before the failure is
observed. No dependent of a failed rule is released. Concurrent failures return
the first one the coordinator observes, not an aggregate and not necessarily
the one that occurred earliest in wall-clock time.

Caller cancellation and deadlines can return `context.Canceled` or
`context.DeadlineExceeded` directly. A rule can return the same errors, wrapped
in `RuleError`. When cancellation and a rule completion race, either path may
win. Use `errors.Is` instead of relying on a specific wrapping shape.

A pre-canceled context runs no rules. Negative options are checked first, so an
invalid limit takes precedence over an already-canceled context.

Cancellation is cooperative. A rule that ignores its context can delay return
indefinitely, including in sequential mode. A context deadline is not a hard
timeout for a function that does not honor it. Infergo waits for rule calls it
started, not detached goroutines that those rules create.

The evaluator does not recover panics. A panic follows normal Go behavior and
does not become a `RuleError`. Return errors for expected failures. Side effects
and mutations outside the generated fact storage are not rolled back.

## Rule and NewPlan

Use the lower-level API when you need to supply the execution callback yourself:

```go
type Rule struct {
    Name      string
    DependsOn []int
}

func NewPlan(rules []Rule) (*Plan, error)
```

The slice index is a rule's ID. `DependsOn` contains IDs of its direct producer
rules, not fact indices or names. Descriptors need not arrive in topological
order.

`NewPlan` copies the names and graph relationships, so callers may modify the
descriptor slice and its dependency slices afterward. It rejects empty or
duplicate names, out-of-range dependency IDs, and cycles, including a rule that
depends on itself. Repeated dependency IDs count only once. An empty or nil
descriptor slice creates a valid empty plan.

Construct plans through `NewPlan`. Their internal fields are private. A
constructed plan can serve concurrent `Run` calls as long as each call supplies
independent mutable storage.

## Plan.Run

```go
func (p *Plan) Run(
    ctx context.Context,
    options Options,
    execute func(context.Context, int) error,
) error
```

`Run` invokes the callback once for every rule whose dependencies succeed, unless
failure or cancellation stops execution first. A fully successful run invokes
every descriptor exactly once. Unlike the generator, `Run` has no output contract
and performs no pruning or type checking.

The callback must write only its rule's outputs and treat inputs as immutable.
Completion synchronizes those writes with dependent callbacks. Independent
callbacks must not race on shared mutable state. The caller owns storage,
dispatch, and result assembly.

`Run` returns errors with the same options, cancellation, and `RuleError`
semantics described above. It does not erase values your callback wrote before
an error. The generated `Evaluate` wrapper is what hides partial results behind
a zero output struct.

For a nonempty plan, supply a non-nil callback. An empty plan runs no callback
and succeeds with a valid limit and uncanceled context.

## Complete low-level example

This program computes two independent values, then combines them:

```go
package main

import (
    "context"
    "fmt"

    "github.com/vichr-vita/infergo"
)

func main() {
    plan, err := infergo.NewPlan([]infergo.Rule{
        {Name: "Left"},
        {Name: "Right"},
        {Name: "Join", DependsOn: []int{0, 1}},
    })
    if err != nil {
        panic(err)
    }

    // This storage belongs to one run. Each rule writes its own element.
    var values [3]int
    err = plan.Run(context.Background(), infergo.Options{MaxParallel: 2},
        func(_ context.Context, id int) error {
            switch id {
            case 0:
                values[0] = 4
            case 1:
                values[1] = 6
            case 2:
                values[2] = values[0] + values[1]
            }
            return nil
        })
    if err != nil {
        panic(err)
    }
    fmt.Println(values[2]) // 10
}
```

For normal ruleset authoring, use the generator so it handles fact storage,
dependency descriptors, and typed dispatch for you. See
[Architecture](architecture.md) for how those pieces fit together.
