# Writing rulesets

A ruleset is a Go package with external input facts, ordinary rule functions,
and an output contract. This guide describes what the generator accepts and how
those declarations form a graph. Start with the [tutorial](getting-started.md)
for a complete runnable example.

## Facts and dependencies

A fact is a named value with a Go type. Its name is case-sensitive and identifies
it throughout the ruleset. A fact comes from exactly one input field or one rule
result. Multiple rules may consume the same fact.

```go
func Split(seed int) (left int, right int) {
    return seed, seed + 1
}

func Join(left int, right int) (total int) {
    return left + right
}
```

`Join` depends on `Split` once, even though it consumes two of its results. When
`Split` succeeds, both facts become available. Each included rule executes at
most once per evaluation.

The generator derives dependencies from signatures. It does not inspect a rule's
body to infer which parameters a particular invocation will use. Renaming a
parameter or result changes its fact identity and may change or break the graph.

## Select rule files

Only exported top-level functions in files selected by `--rules` become rules.
Methods and unexported functions remain helpers. Exported functions in other
files also remain ordinary functions, though the package still has to type-check.

A typical layout is:

```text
score/
  facts.go              Input/output contracts and go:generate directive
  rules.go              Selected exported rule functions
  helpers.go            Supporting functions and types
  rules_test.go         Tests and calls to the generated evaluator
  zz_infergo_gen.go     Generated evaluator
```

Rule files must be non-test `.go` files in the current ruleset directory and must
participate in the active build. The output file must be separate. Select every
file containing a producer you need. Files are not selected recursively.

Keep non-test source in the ruleset package independent of `Evaluate` and
`_infergoPlan`. Generation hides its configured output file while loading the
package. Calls to `Evaluate` can live in tests or another package. There is one
generated evaluator per package, and rules cannot live in the Infergo runtime
package itself.

## Supported signatures

| Declaration | Behavior |
| --- | --- |
| Named parameter, such as `seed int` | Consumes that fact. |
| Named ordinary result, such as `total int` | Produces that fact. |
| Several named results | Produces all of them on success. |
| No fact parameters | A root rule, ready at evaluation start. |
| First parameter of type `context.Context` | Receives the execution context. |
| Last result of the built-in `error` type | Controls success or failure. |
| Unnamed or blank ordinary parameter/result | Rejected. |
| No ordinary result, including an error-only result | Rejected. |
| Generic or variadic function | Rejected as a rule. |

Every rule must produce at least one named ordinary fact. Fact parameters and
results cannot use `_` as their name. The special context parameter and trailing
error result do not need fact names. If you name the error, that name does not
join the graph.

The built-in `error` and `context.Context` types are reserved for execution
control, including aliases of those types. An error cannot be an input fact; a
context cannot be an output fact. Put context first and error last.

## Match types exactly

The producer, every consumer, and every struct mapping for a fact must use
identical Go types. The generator uses Go type identity, not assignment
compatibility, and inserts no conversions.

For example, with `type Score int`, a fact produced as `Score` cannot be consumed
as `int`. With `type Score = int`, the alias refers to the same type as `int`.
Similarly, a fact produced as a concrete type does not automatically match a
consumer declaring an interface that the concrete type implements.

You can use pointers, slices, maps, structs, and types from other packages as
facts. A struct-valued result is one fact. Its fields do not become separate
facts. Add a rule that returns named fields if consumers need them separately.

## Map input and output structs

Both contracts must name non-generic struct types in the ruleset package.
Aliases of suitable structs are supported. Every field must be exported and
non-embedded.

```go
type Inputs struct {
    Seed int `fact:"seed"`
}

type Outputs struct {
    Original int `fact:"seed"`
    Total    int `fact:"total"`
}
```

`Original` returns an external input directly. Outputs do not have to come from
rules. Unused input fields are allowed, and inputs are always passed as a value
of the complete input struct.

Mapping rules are:

- A `fact` tag supplies the exact fact name. Without it, the field name is used
  unchanged, so `Seed` and `seed` are different facts.
- Fact names must be valid Go identifiers other than `_`. Empty tags, `fact:"-"`,
  and comma options such as `fact:"seed,omitempty"` are invalid.
- Two fields in the same contract cannot map to the same fact.
- An input fact cannot also be produced by a rule.
- A requested output must have a source with an identical type.
- Fields cannot use the reserved `error` or `context.Context` types.

Empty contracts are allowed. For example, a ruleset of constant-producing rules
can have `Inputs struct{}`. An output contract can contain only external facts,
in which case no rule needs to run. An empty output contract also produces an
empty execution plan. Selected rules must still pass validation.

## Choose requested outputs

The output contract determines which rules the evaluator includes. Infergo
starts at each requested fact and follows its producers back to external inputs.
Other rules are omitted from generated execution code.

Validation happens before this pruning. Missing facts, duplicate producers,
type mismatches, unsupported signatures, and cycles anywhere in the selected
rules fail generation, even on a branch whose outputs are not requested.

Pruning operates on entire rules. If one requested fact comes from a rule with
several outputs, that rule runs and computes all its outputs. The evaluator only
returns fields named in the output contract. There is no per-call output
selection; changing the contract requires regeneration.

## Represent absence explicitly

Use a pointer or another explicit optional value when a calculation can succeed
without a value:

```go
func Positive(total int) (positive *int) {
    if total > 0 {
        return &total
    }
    return nil
}

func HasPositive(positive *int) (hasPositive bool) {
    return positive != nil
}
```

`HasPositive` runs after `Positive` succeeds, including when `positive` is nil.
Readiness depends on successful completion, not truthiness or nonzero values.
The generator does not add nil checks to consumers.

## Return errors and honor cancellation

A context-aware rule can check cancellation before expensive work:

```go
func CheckedDouble(ctx context.Context, seed int) (doubled int, err error) {
    if err := ctx.Err(); err != nil {
        return 0, err
    }
    return seed * 2, nil
}
```

This declaration needs the `context` import and would replace another producer
of `doubled`. Pass this context to context-aware I/O and check it during long
computations. The evaluator cancels it on failure, caller cancellation, and
completion. Do not retain it for work intended to outlive the evaluation.

A non-nil trailing error prevents publication of every output from that rule.
Dependents do not run, and `Evaluate` returns a zero output struct. See the
[runtime reference](runtime.md#errors-and-cancellation) for error inspection,
concurrent failures, and waiting for started rules.

## Keep facts immutable

Treat consumed values and anything reachable through them as immutable. This
includes maps, slice backing arrays, pointers, and values hidden inside
interfaces. The caller must also avoid modifying referenced input data until
evaluation returns.

A rule may allocate and fill a new result before returning it. After returning,
other rules may consume that result concurrently. Infergo does not deep-copy
facts or prove that functions are pure. Shared globals require the same care as
in any concurrent Go program.

Prefer calculation rules without external side effects. If a rule does perform
I/O, remember that a later failure cannot undo it. Output pruning can also omit
a rule entirely. Successful evaluation is not a transaction over external work.

## Understand static branches

In a rule such as `Choose(enabled bool, expensiveResult Result)`,
`expensiveResult` must be ready before `Choose` runs, even when `enabled` is
false. An `if` statement inside `Choose` cannot skip its producers.

For conditional work, put the condition and that work inside one rule or select
between separate ruleset packages in application code. The current engine does
not dynamically change its graph, update facts, retry failed rules, or
incrementally reevaluate prior results.
