# Infergo

Infergo generates a typed Go evaluator from plain rule functions. Parameter and
result names connect facts into a directed acyclic graph. You declare the inputs
you supply and the outputs you need; the generated evaluator runs the required
rules sequentially or with bounded concurrency.

Use it when a calculation has several dependent steps that you want to write and
test as ordinary Go functions. Graph validation happens during generation.
Evaluations use typed storage and direct function calls, with no runtime
reflection or string-based fact lookups.

## Documentation

| Task | Guide |
| --- | --- |
| Build and run your first evaluator | [Getting started](docs/getting-started.md) |
| Define facts, rules, and output contracts | [Writing rulesets](docs/rulesets.md) |
| Look up flags, configuration, and generation behavior | [Generator reference](docs/generator.md) |
| Handle concurrency, errors, and cancellation | [Runtime and API reference](docs/runtime.md) |
| Understand the compiler and scheduler | [Architecture](docs/architecture.md) |
| Follow the included 26-rule calculation | [Bonus example](docs/bonus-example.md) |
| Diagnose generation and evaluation problems | [Troubleshooting](docs/troubleshooting.md) |
| Change Infergo and verify your work | [Development guide](CONTRIBUTING.md) |

## Run the example

Use Go 1.26.4 or later, as declared in [go.mod](go.mod). From a checkout:

```sh
go generate ./...
go test -race ./...
go test ./ruleset/bonus -run '^ExampleEvaluate$' -v
```

The executable example computes a bonus of `1049000` cents and a payment
reference of `BONUS-E01-1049000`. Its inputs and assertions are in
[ExampleEvaluate](ruleset/bonus/bonus_test.go).

The generated evaluator accepts a context, an input struct, and execution
options:

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

This snippet belongs inside a function returning `error`. It uses `fmt`,
`github.com/vichr-vita/infergo`, and
`github.com/vichr-vita/infergo/ruleset/bonus`. The [getting started
guide](docs/getting-started.md) provides a complete program for a smaller ruleset.

## Author a ruleset

An exported function in a selected rule file becomes a rule. Names identify
facts, and every occurrence of a fact must have an identical Go type:

```go
func BaseBonus(salaryCents uint64, roleRateBps uint64) (
    baseBonusCents uint64,
    err error,
) {
    return scaled(salaryCents, roleRateBps)
}
```

This rule comes from the [bonus package](ruleset/bonus/bonus.go), where `scaled`
is a helper. The generator connects `salaryCents` and `roleRateBps` to their
sources and makes `baseBonusCents` available to other rules.

Input and output structs map exported fields to facts with `fact` tags. Add a
`go:generate` directive in the ruleset package, then regenerate whenever the
graph or contracts change. Follow [Writing rulesets](docs/rulesets.md) for the
supported signatures, mappings, and package layout.

## Configure the generator

Run `infergen` in the ruleset directory. Supply rule files with `--rules`, an
`infergen.yaml`, `infergen.toml`, or `infergen.json` file, or `INFERGEN_RULES`.
Explicit flags override environment variables, which override configuration
files and defaults. Flags use two dashes, such as `--rules`.

See the [generator reference](docs/generator.md) for installation, all options,
path constraints, and reproducible generation.

## Execution rules

`MaxParallel` values of zero and one run sequentially without worker goroutines.
Larger values bound running rules per evaluation. Each call has separate fact
storage, so independent evaluations can run concurrently.

Rules execute after all their producers succeed. Zero, `false`, and `nil` are
valid facts. Errors discard the result struct, cancel running work, and prevent
dependent rules from running. Evaluation waits for started rules to return.
Inputs and referenced data must remain immutable throughout evaluation.

Read the [runtime reference](docs/runtime.md) before using parallel execution or
rules that perform I/O. The current implementation has no dynamic branches,
retries, fact updates, incremental reevaluation, or panic recovery.

The runtime in [plan.go](plan.go) imports only the standard library. Package
loading and type inspection belong to the generator.
