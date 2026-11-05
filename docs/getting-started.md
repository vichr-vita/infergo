# Getting started

Build a ruleset that doubles a nonnegative seed, adds an offset, and returns a
typed result. This guide assumes you can run Go commands and edit Go files. Use
Go 1.26.0 or later.

For an existing checkout, you can first run the [included bonus
example](bonus-example.md). The steps below create a separate application.

## Create a module

In a new directory, run:

```sh
mkdir infergo-demo
cd infergo-demo
go mod init example.com/infergo-demo
go get -tool github.com/vichr-vita/infergo/cmd/infergen
mkdir score
```

The `go get -tool` command adds the Infergo module to `go.mod` and records
`infergen` as a tool dependency of your module. It does not install an
executable. The generation directive below runs it with `go tool infergen` at
the version recorded in your module, and `go mod tidy` keeps the entry.

If you are working on a local Infergo checkout, use the [local replacement
workflow](../CONTRIBUTING.md#use-a-local-checkout-from-another-module) instead of
fetching the generator.

## Declare the facts

Create `score/facts.go`:

```go
package score

//go:generate go tool infergen --rules rules.go

type Inputs struct {
    Seed   int `fact:"seed"`
    Offset int `fact:"offset"`
}

type Outputs struct {
    Total int `fact:"total"`
}
```

`Inputs` lists external facts supplied by the caller. `Outputs` lists the facts
to return. The tags connect Go field names such as `Seed` to the lowercase
parameter names used in rules. Untagged fields use their exact field name.

## Write the rules

Create `score/rules.go`:

```go
package score

import "errors"

func Double(seed int) (doubled int, err error) {
    if seed < 0 {
        return 0, errors.New("seed must not be negative")
    }
    return seed * 2, nil
}

func AddOffset(doubled int, offset int) (total int) {
    return doubled + offset
}
```

`Double` produces `doubled`. `AddOffset` consumes that fact and the external
`offset`, so Infergo runs it after `Double` succeeds. The trailing `error`
controls failure and does not become a fact.

The arithmetic keeps the example small. It does not check integer overflow.
Domain validation and arithmetic checks belong in your rules.

## Generate the evaluator

From the module root, run:

```sh
go generate ./score
```

This writes `score/zz_infergo_gen.go`, which declares:

```go
func Evaluate(ctx context.Context, input Inputs, options infergo.Options) (Outputs, error)
```

Do not edit the generated file. Change the rules or contracts and run generation
again. `go build` and `go test` do not run `go generate` automatically. Until
you generate, `score` has no `Evaluate`, so code that calls it fails to compile.
`go build ./...` reports `undefined: score.Evaluate` for `main.go`, and
`go vet` or `go test` report `undefined: Evaluate` for a test file.

## Call the evaluator

Create `main.go` in the module root:

```go
package main

import (
    "context"
    "fmt"
    "log"

    "example.com/infergo-demo/score"
    "github.com/vichr-vita/infergo"
)

func main() {
    result, err := score.Evaluate(
        context.Background(),
        score.Inputs{Seed: 10, Offset: 3},
        infergo.Options{},
    )
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(result.Total)
}
```

Run it:

```sh
go mod tidy
go run .
```

The `go mod tidy` command marks `infergo` as a direct dependency now that
`main.go` imports it.

The output is:

```text
23
```

With `Seed: -1`, evaluation returns a zero `Outputs` struct and an
`*infergo.RuleError` whose message is
`rule Double: seed must not be negative`. `AddOffset` does not run.

## Check the result in a test

Create `score/rules_test.go`:

```go
package score

import (
    "errors"
    "testing"

    "github.com/vichr-vita/infergo"
)

func TestEvaluate(t *testing.T) {
    for _, parallel := range []int{0, 4} {
        got, err := Evaluate(t.Context(), Inputs{Seed: 10, Offset: 3}, infergo.Options{
            MaxParallel: parallel,
        })
        if err != nil || got.Total != 23 {
            t.Fatalf("parallel=%d: got %+v, error %v", parallel, got, err)
        }
    }
}

func TestNegativeSeed(t *testing.T) {
    got, err := Evaluate(t.Context(), Inputs{Seed: -1}, infergo.Options{})
    var ruleErr *infergo.RuleError
    if !errors.As(err, &ruleErr) || ruleErr.Rule != "Double" {
        t.Fatalf("expected Double to fail, got %v", err)
    }
    if got != (Outputs{}) {
        t.Fatalf("expected zero outputs, got %+v", got)
    }
}
```

Run:

```sh
go test -race ./...
go generate ./score
```

The second command confirms that generation still works after `go mod tidy`.

The two rules form a chain, so increasing `MaxParallel` cannot make them run
simultaneously. Parallelism helps only when the graph has independent work.

## Continue with your own rules

Read [Writing rulesets](rulesets.md) for multiple results, optional values,
context-aware rules, and exact type matching. Use the [generator
reference](generator.md) when splitting rules across files or configuring
generation, and the [runtime reference](runtime.md) when integrating evaluation
into a service.
