# Infergo

Infergo generates a typed Go evaluator from plain rule functions. Parameter and
result names connect facts into a directed acyclic graph. You declare the inputs
you supply and the outputs you need; the generated evaluator runs the required
rules sequentially or with bounded concurrency.

Use it when a calculation has several dependent steps that you want to write and
test as ordinary Go functions. Graph validation happens during generation.
`Evaluate` uses typed storage and direct function calls, with no runtime
reflection or string-based fact lookups. The diagnostic `EvaluateTrace` also
formats each value as a string.

Infergo is pre-1.0, so its API and generated code can change between releases.
Regenerate your evaluators after every upgrade.

> These docs track `main`, and [v0.1.1 differs](docs/generator.md#v011-differences).

## Documentation

| Task | Guide |
| --- | --- |
| Build and run your first evaluator | [Getting started](docs/getting-started.md) |
| Define facts, rules, and output contracts | [Writing rulesets](docs/rulesets.md) |
| Look up flags, configuration, and generation behavior | [Generator reference](docs/generator.md) |
| Handle concurrency, errors, and cancellation | [Runtime and API reference](docs/runtime.md) |
| Explore rule graphs, values, source, and saved scenarios | [Visualization guide](docs/visualization.md) |
| Understand the compiler and scheduler | [Architecture](docs/architecture.md) |
| Follow the included 26-rule calculation | [Bonus example](docs/bonus-example.md) |
| Diagnose generation and evaluation problems | [Troubleshooting](docs/troubleshooting.md) |
| Change Infergo and verify your work | [Development guide](CONTRIBUTING.md) |

## Run the example

Use Go 1.26.0 or later, as declared in [go.mod](go.mod). Clone the repository
and run the example:

```sh
git clone https://github.com/vichr-vita/infergo.git
cd infergo
go generate ./...
go test -race ./...
go test ./ruleset/bonus -run '^ExampleEvaluate$' -v
```

The `-race` flag needs cgo and a C toolchain, so leave it out if you do not have
them. The executable example computes a bonus of `1049000` cents and a payment
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

In your own module, record `infergen` as a tool dependency and run
`go tool infergen` in the ruleset directory. This repository has no tool
dependency, so use `go run ../../cmd/infergen` in `ruleset/bonus` instead. Supply
rule files with `--rules`, an `infergen.yaml`, `infergen.toml`, or `infergen.json`
file, or `INFERGEN_RULES`.
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
retries, fact updates, or incremental reevaluation, and a rule panic stays a
panic on the goroutine that called `Evaluate`.

The runtime in [plan.go](plan.go) imports only the standard library. Package
loading and type inspection belong to the generator.

## Explore an evaluation

Export the bonus rules and saved scenarios to a self-contained HTML page:

```sh
go run ./examples/bonus-viewer /tmp/infergo-bonus.html
```

Open the file in a browser to explore dependencies, inspect fact values and Go
source, and switch scenarios. Generated rulesets expose `EvaluateTrace` for
diagnostic snapshots and `ExportHTML` for offline viewers. See the
[visualization guide](docs/visualization.md) for custom exports and API behavior.

## License

Copyright 2026 Vít Chrubasík.

Infergo is licensed under the [Apache License 2.0](LICENSE). The viewer includes
code adapted from Inferrum and third-party layout dependencies. Their license
notices are retained in the viewer sources and generated bundle.
