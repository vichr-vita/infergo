# Infergo

Infergo generates a typed Go evaluator from plain rule functions. Parameter and
result names connect facts into a directed acyclic graph. The evaluator runs
sequentially or with bounded concurrency.

The [bonus ruleset](ruleset/bonus/bonus.go) contains 26 rules. Its external facts
and requested results are declared in [facts.go](ruleset/bonus/facts.go).

## Run the example

Use Go 1.26.4 or later. From the repository root, generate and test:

```sh
go generate ./...
go test -race ./...
```

Call the generated evaluator with a separate input struct for each evaluation:

```go
result, err := bonus.Evaluate(ctx, bonus.Inputs{
    EmployeeID:          "E01",
    Active:              true,
    TenureMonths:        48,
    PerformanceScore:    94,
    SalaryCents:         8_000_000,
    Role:                bonus.Specialist,
    Department:          bonus.Engineering,
    TrainingComplete:    true,
    CompanyTargetMet:    true,
    EmployeeBudgetCents: 1_200_000,
    ManagerApproved:     true,
    FinanceApproved:     true,
    CriticalSkill:       true,
}, infergo.Options{MaxParallel: 4})
if err != nil {
    return err
}
fmt.Println(result.FinalBonusCents) // 1049000
```

Import `github.com/vichr-vita/infergo` and
`github.com/vichr-vita/infergo/ruleset/bonus` for this example. A runnable version
is in [ExampleEvaluate](ruleset/bonus/bonus_test.go).

`MaxParallel` values of zero and one execute sequentially without worker
goroutines. Larger values bound the number of running rules per evaluation.
Negative values return an error. Separate evaluations can run concurrently.

## Author a ruleset

Place exported top-level rule functions in explicitly selected Go files:

```go
func BaseBonus(salaryCents uint64, roleRateBps uint64) (
    baseBonusCents uint64,
    err error,
) {
    return scaled(salaryCents, roleRateBps)
}
```

Every input and ordinary output must have a name. The same fact name must have
an identical Go type everywhere, including its struct mappings. Defined types
retain their identity; the generator does not insert conversions. Each derived
fact has one producer, and external inputs cannot also be produced by rules.

Input and output contracts must be non-generic structs with exported,
non-embedded fields. A `fact` tag maps a field to a fact name. Without a tag,
the field name is used exactly as written:

```go
type Inputs struct {
    SalaryCents uint64 `fact:"salaryCents"`
    RoleRateBps uint64 `fact:"roleRateBps"`
}

type Outputs struct {
    BaseBonusCents uint64 `fact:"baseBonusCents"`
}
```

Add a generation directive in that package:

```go
//go:generate go run github.com/vichr-vita/infergo/cmd/infergen -rules rules.go -inputs Inputs -outputs Outputs
```

The package must depend on this module. Run `go generate` after changing rule
declarations or struct mappings. The default output is `zz_infergo_gen.go`;
set `-out` to choose another file in the same directory. Multiple rule files
can be selected with `-rules rates.go,awards.go`.

The generator loads the package using the active Go build configuration. It
validates all selected rules and emits only those needed for the output struct.
Unexported functions and methods remain ordinary helpers. Rule files, contracts,
and helpers must type-check without the generated evaluator, so generation also
works when its output is absent or stale. `Evaluate` and `_infergoPlan` are
reserved for generated declarations. One evaluator is supported per package.

## Execution rules

- A rule executes once after all its producers succeed. Multiple input facts
  from the same producer count as one dependency.
- Zero, `false`, and `nil` are successful values. Consumers of optional `nil`
  facts still execute. Completion determines readiness.
- A trailing result of the built-in `error` type controls failure and is not a
  fact. A failed rule publishes none of its outputs. Evaluation returns a zero
  output struct and an `*infergo.RuleError`; `errors.Is` and `errors.As` preserve
  access to the original error. With simultaneous failures, the first observed
  failure is returned.
- An optional first `context.Context` parameter receives the execution context.
  The built-in `error` and `context.Context` types are reserved for execution
  control and cannot be facts.
- Cancellation and failure stop dispatching work and signal running rules.
  Evaluation waits for those rules to finish before returning. Rules that ignore
  context cancellation can delay that return.
- Rules must treat facts and referenced maps, slices, and pointers as immutable.
  The caller must also avoid changing input data during evaluation. Infergo
  does not prove purity or copy referenced data.
- Dependencies follow function declarations. A conditional inside a rule does
  not let the evaluator skip any of that rule's inputs. A struct-valued result
  is one fact; its fields do not become separate facts.

Missing facts, type mismatches, duplicate producers, unsupported declarations,
and cycles fail generation with source locations. Generic and variadic rule
functions are unsupported. This version has no dynamic branches, retries,
fact updates, or incremental reevaluation.

The runtime in [plan.go](plan.go) uses only the standard library. Package loading
and type inspection are confined to the generator. Generated evaluators use
typed fact storage and direct Go calls.
